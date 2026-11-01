import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseHTML } from 'linkedom';
import type { Page } from 'playwright-core';
import { readPosts } from './x-posts.js';
import { graphForPost } from './hiring-pipeline.js';
import { verifiedContextView } from './hiring-evidence.js';

interface Fixture {
  id: string; description: string; html: string; threadRoot: string; rootAlreadySeen: boolean;
  expectedIds: string[]; knownDirectParents: Record<string, string>; expectedQuoteId?: string;
}
const suite = JSON.parse(await readFile(new URL('./fixtures/reply-parent-pages.json', import.meta.url), 'utf8')) as { qualification: string; cases: Fixture[] };

// Execute the actual collector DOM callback with local elements only. No browser,
// network, private evidence, fixture answer key or invented parent attribute.
async function collect(fixture: Fixture) {
  const { document } = parseHTML(fixture.html);
  const restore = new Map(['document', 'Node'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  // linkedom implements compareDocumentPosition but omits the browser's static Node constants.
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: { DOCUMENT_POSITION_FOLLOWING: 4 } });
  try {
    const page = { locator: () => ({ evaluateAll: (callback: (nodes: Element[]) => unknown) =>
      callback([...document.querySelectorAll('article[data-testid="tweet"]')] as unknown as Element[]) }) } as unknown as Page;
    const all = await readPosts(page);
    const selected = await readPosts(page, fixture.threadRoot, fixture.rootAlreadySeen);
    return { all, selected };
  } finally {
    for (const [key, descriptor] of restore) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

for (const fixture of suite.cases) {
  test(`reply collection: ${fixture.id}`, async () => {
    const { all, selected } = await collect(fixture);
    assert.deepEqual(selected.map(p => p.id), fixture.expectedIds);
    for (const post of selected) {
      assert.equal(post.discoveredInThread, fixture.threadRoot);
      assert.equal(post.replyTo, undefined, 'Recipient names and DOM order do not prove an exact parent ID');
      const { graph } = graphForPost(post, all);
      assert.equal(graph.connections.some(c => c.relationship === 'direct_reply'), false);
      const view = verifiedContextView(graph);
      if (fixture.expectedQuoteId) {
        assert.equal(post.references?.[0]?.relationship, 'quoted_post');
        assert.equal(view.verified_context[0]?.post.id, fixture.expectedQuoteId);
      } else {
        assert.deepEqual(view.verified_context, [], 'Nearby hiring text must not reach the model as verified context');
      }
    }
  });
}

test('parent extraction coverage is zero despite passing no-guessing checks', async () => {
  let labeled = 0, recovered = 0, falseEdges = 0;
  for (const fixture of suite.cases) {
    const { selected } = await collect(fixture);
    for (const post of selected) {
      const gold = fixture.knownDirectParents[post.id];
      if (gold) labeled++;
      if (post.replyTo?.verified && post.replyTo.postId === gold) recovered++;
      if (post.replyTo?.verified && post.replyTo.postId !== gold) falseEdges++;
    }
  }
  assert.equal(labeled, 9);
  assert.equal(recovered, 0); // Gap characterization, not a successful extraction score.
  assert.equal(falseEdges, 0);
});

test('root and adjacency shortcuts demonstrably choose the wrong labeled parent', async () => {
  const nested = suite.cases.find(c => c.id === 'nested-jobseeker')!;
  const ranked = suite.cases.find(c => c.id === 'ranked-sibling-replies')!;
  const { selected } = await collect(ranked);
  const targetIndex = selected.findIndex(p => p.id === '200');
  assert.notEqual(nested.threadRoot, nested.knownDirectParents['200']);
  assert.notEqual(selected[targetIndex - 1]!.id, ranked.knownDirectParents['200']);
});
