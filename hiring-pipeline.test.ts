import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifyCapturedBatch, graphForPost, preparePostRequest } from './hiring-pipeline.js';
import type { HiringResult } from './hiring-pipeline.js';
import { verifiedContextView } from './hiring-evidence.js';
import type { Post } from './x-posts.js';

const post = (id: string, text: string): Post => ({ id, text, author: `author${id}`, authorLabel: '',
  url: `https://x.com/author${id}/status/${id}`, postedAt: null, truncated: false, links: [] });
const parent = post('1', 'We are hiring engineers at Company A.');
const share = (): Post => ({ ...post('2', 'Come build with us.'), references: [{ url: parent.url, relationship: 'quoted_post', post: parent }] });
const answer = (target: Post, subject = target) => ({ decision: 'keep', reason: 'Recruitment invitation.',
  target_evidence: { source_id: target.id, quote: target.text },
  context_evidence: subject.id === target.id ? [] : [{ source_id: subject.id, quote: subject.text }],
  lead_type: subject.id === target.id ? 'own_recruitment' : 'shared_opportunity', subject_source_id: subject.id,
  company: null, role: null, location: null, needs_context: false });
const transport = (value: unknown): typeof fetch => async () => new Response(JSON.stringify({ result: { response: JSON.stringify(value) } }));
const noSave = async () => {};

test('application uses the evaluated prompt byte for byte and structured request settings', async () => {
  const prompt = await readFile('prompts/classify-hiring-v2.txt', 'utf8');
  assert.equal(prompt, await readFile('evals/prompts/shared-opportunity-candidate.txt', 'utf8'));
  const { request } = preparePostRequest(share(), [parent], prompt);
  assert.equal(request.response_format.type, 'json_schema');
  assert.equal(request.response_format.json_schema.strict, true);
  assert.equal(request.temperature, 0);
  assert.equal(request.max_completion_tokens, 1024);
  assert.equal(request.chat_template_kwargs.enable_thinking, false);
  assert.equal(request.store, false);
  assert.equal(JSON.parse(request.messages[1]!.content).target.id, '2');
});

test('a share is kept but delivery deduplicates to the original regardless of input order', async () => {
  const shared = share();
  const { results } = await classifyCapturedBatch({ posts: [shared, parent], prompt: '', save: noSave,
    fetcher: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const id = JSON.parse(body.messages[1].content).target.id;
      return transport(id === shared.id ? answer(shared, parent) : answer(parent))('', {});
    } });
  assert.equal(results[0]!.decision, 'keep');
  assert.equal(results[0]!.evidenceSource?.id, parent.id);
  assert.equal(results[0]!.duplicateOfPostId, parent.id);
  assert.equal(results[1]!.duplicateOfPostId, undefined);
  assert.equal(results[0]!.evidenceSource?.currentAvailabilityVerified, false);
});

test('independent hiring reply retains its own source and no inherited company', async () => {
  const reply = { ...post('2', 'We are too.'), replyTo: { postId: parent.id, verified: true } };
  const { results } = await classifyCapturedBatch({ posts: [parent, reply], prompt: '', save: noSave,
    fetcher: async (_url, init) => {
      const id = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).target.id;
      return transport(answer(id === parent.id ? parent : reply))('', {});
    } });
  assert.equal(results[1]!.evidenceSource?.id, reply.id);
  assert.equal(results[1]!.attribution?.company, null);
  assert.equal(results[1]!.duplicateOfPostId, undefined);
});

test('thread discovery and ordinary links never establish verified ancestry', () => {
  const reply = { ...post('2', 'We are too.'), discoveredInThread: parent.id,
    references: [{ relationship: 'linked_post' as const, url: parent.url, post: parent }] };
  assert.equal(graphForPost(reply, [reply, parent]).graph.connections.length, 0);
  reply.references[0]!.relationship = 'linked_post';
  const graph = graphForPost({ ...reply, replyTo: { postId: parent.id, verified: false } }, [parent]).graph;
  assert.equal(graph.posts.length, 1);
  assert.equal(graph.connections[0]!.verified, false);
});

test('adapter preserves two verified steps and withholds a third source text', () => {
  const middle = { ...post('3', 'Which team?'), replyTo: { postId: parent.id, verified: true } };
  const reply = { ...post('2', 'Come build with us.'), replyTo: { postId: middle.id, verified: true } };
  const distant = { ...post('4', 'A further reply.'), replyTo: { postId: reply.id, verified: true } };
  assert.match(JSON.stringify(verifiedContextView(graphForPost(reply, [parent, middle, reply]).graph)), /Company A/);
  const view = JSON.stringify(verifiedContextView(graphForPost(distant, [parent, middle, reply, distant]).graph));
  assert.doesNotMatch(view, /Company A/);
  assert.match(view, /beyond_two_connections/);
});

test('missing, truncated and misidentified quoted sources are unavailable', () => {
  for (const source of [{ ...parent, truncated: true }, { ...parent, url: 'https://other.example/author1/status/1' }]) {
    const target = { ...share(), references: [{ relationship: 'quoted_post' as const, url: source.url, post: source }] };
    assert.equal(graphForPost(target, [source]).graph.posts.length, 1);
  }
  const target = { ...post('2', 'Come build with us.'), replyTo: { postId: 'missing', verified: true } };
  assert.match(JSON.stringify(verifiedContextView(graphForPost(target, []).graph)), /source_text_unavailable/);
});

test('invalid evidence is retained as an error/review and never silently accepted', async () => {
  const target = share();
  const wrong = { ...answer(target, parent), target_evidence: { source_id: parent.id, quote: parent.text } };
  const { results } = await classifyCapturedBatch({ posts: [target], prompt: '', fetcher: transport(wrong), save: noSave });
  assert.equal(results[0]!.status, 'error');
  assert.equal(results[0]!.decision, 'review');
  assert.equal(results[0]!.attribution, undefined);
  assert.ok(results[0]!.rawOutput);
});

test('reserve checkpoint precedes transport and provider failure stops subsequent calls', async () => {
  const snapshots: HiringResult[][] = [];
  let calls = 0;
  const { results, stopped } = await classifyCapturedBatch({ posts: [parent, post('2', 'Other post')], prompt: '',
    save: async rows => { snapshots.push(structuredClone(rows)); },
    fetcher: async () => {
      calls++;
      assert.equal(snapshots.at(-1)![0]!.status, 'reserved');
      throw new Error('Network disconnected');
    } });
  assert.equal(calls, 1);
  assert.equal(stopped, true);
  assert.equal(results[0]!.status, 'error');
  assert.equal(results[1]!.status, 'not_processed');
  await assert.rejects(classifyCapturedBatch({ posts: [parent], prompt: '', previous: [results[0]!], fetcher: transport(answer(parent)), save: noSave }), /Prior partial/);
});

test('complete cached rows make no calls; incomplete targets require recovery without a call', async () => {
  const fail: typeof fetch = async () => { throw new Error('Unexpected transport call'); };
  const previous: HiringResult = { postId: parent.id, url: parent.url, author: parent.author, text: parent.text,
    inputIncomplete: false, status: 'classified', decision: 'keep', reason: 'cached' };
  const cached = await classifyCapturedBatch({ posts: [parent], prompt: '', previous: [previous], fetcher: fail, save: noSave });
  assert.equal(cached.results.length, 1);
  const incomplete = await classifyCapturedBatch({ posts: [{ ...parent, truncated: true }], prompt: '', fetcher: fail, save: noSave });
  assert.equal(incomplete.results[0]!.decision, 'review');
  assert.match(incomplete.results[0]!.reason, /recover/);
});

test('request and batch limits fail before transport', async () => {
  assert.throws(() => preparePostRequest(parent, [], 'x'.repeat(12_000)), /budget/);
  await assert.rejects(classifyCapturedBatch({ posts: [parent, parent], prompt: '', fetcher: transport({}), save: noSave }), /unique/);
});

test('CLI dry run prepares inputs without transport or replacing classified results', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'hiring-scout-offline-'));
  try {
    await mkdir(join(directory, 'prompts'));
    await mkdir(join(directory, '.local/x-posts'), { recursive: true });
    await mkdir(join(directory, '.local/classified'));
    await writeFile(join(directory, 'prompts/classify-hiring-v2.txt'), await readFile('prompts/classify-hiring-v2.txt'));
    await writeFile(join(directory, '.local/x-posts/latest.json'), JSON.stringify({ capturedAt: 'synthetic', posts: [share()] }));
    const sentinel = 'Existing private classified results';
    await writeFile(join(directory, '.local/classified/latest.json'), sentinel);
    const output = execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('classify-posts.ts'), '--dry-run'], { cwd: directory, encoding: 'utf8' });
    assert.match(output, /Prepared 2 inputs; no model calls made/);
    assert.equal(await readFile(join(directory, '.local/classified/latest.json'), 'utf8'), sentinel);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('discussion reply discovers its verified recruiting parent as an independent assessment', async () => {
  const discussion = { ...post('2', 'How does this research change government decisions?'), replyTo: { postId: parent.id, verified: true } };
  let calls = 0;
  const { results, plan } = await classifyCapturedBatch({ posts: [discussion], contextPosts: [parent], prompt: '', save: noSave,
    fetcher: async (_url, init) => {
      calls++;
      const target = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).target;
      const result = target.id === parent.id ? answer(parent) : { decision: 'skip', reason: 'Discussion, not recruitment.',
        target_evidence: null, context_evidence: [], lead_type: null, subject_source_id: null,
        company: null, role: null, location: null, needs_context: false };
      return transport(result)('', {});
    } });
  assert.equal(calls, 2);
  assert.deepEqual(plan.addedSourceIds, [parent.id]);
  assert.equal(results[0]!.decision, 'skip');
  assert.equal(results[1]!.postId, parent.id);
  assert.equal(results[1]!.decision, 'keep');
  assert.equal(results[1]!.evidenceSource?.id, parent.id);
  assert.equal(results[1]!.delivery, 'new_opportunity');
});

test('invalid child attribution does not discard the independently assessed hiring parent', async () => {
  const discussion = { ...post('2', 'How does this research change government decisions?'), replyTo: { postId: parent.id, verified: true } };
  const { results } = await classifyCapturedBatch({ posts: [discussion], contextPosts: [parent], prompt: '', save: noSave,
    fetcher: async (_url, init) => {
      const id = JSON.parse(JSON.parse(String(init?.body)).messages[1].content).target.id;
      const badShare = { ...answer(discussion, parent), target_evidence: null };
      return transport(id === parent.id ? answer(parent) : badShare)('', {});
    } });
  assert.equal(results[0]!.status, 'error');
  assert.equal(results[0]!.delivery, 'not_a_kept_lead');
  assert.equal(results[1]!.decision, 'keep');
  assert.equal(results[1]!.delivery, 'new_opportunity');
});

test('multiple discoveries and an already captured parent schedule that source once', async () => {
  const a = { ...post('2', 'Question one'), replyTo: { postId: parent.id, verified: true } };
  const b = { ...post('3', 'Question two'), replyTo: { postId: parent.id, verified: true } };
  const { planOpportunityAssessments } = await import('./hiring-pipeline.js');
  assert.deepEqual(planOpportunityAssessments([a, b], [parent]).assessments.map(p => p.id), ['2', '3', '1']);
  assert.deepEqual(planOpportunityAssessments([a, parent, b], [parent]).addedSourceIds, []);
});

test('unverified, distant, incomplete and non-hiring context never creates additional assessments', async () => {
  const { planOpportunityAssessments } = await import('./hiring-pipeline.js');
  for (const [target, context] of [
    [{ ...post('2', 'Question'), replyTo: { postId: parent.id, verified: false } }, [parent]],
    [{ ...post('2', 'Question'), discoveredInThread: parent.id }, [parent]],
    [{ ...post('2', 'Question'), replyTo: { postId: parent.id, verified: true } }, [{ ...parent, truncated: true }]],
    [{ ...post('2', 'Question'), replyTo: { postId: parent.id, verified: true } }, [{ ...parent, text: 'Nice weather.' }]],
  ] as [Post, Post[]][]) assert.deepEqual(planOpportunityAssessments([target], context).addedSourceIds, []);
  const middle = { ...post('3', 'Which team?'), replyTo: { postId: parent.id, verified: true } };
  const next = { ...post('4', 'Ask them.'), replyTo: { postId: middle.id, verified: true } };
  const target = { ...post('2', 'Question'), replyTo: { postId: next.id, verified: true } };
  assert.deepEqual(planOpportunityAssessments([target], [middle, next, parent]).addedSourceIds, []);
});

test('stored parent IDs suppress re-assessment and duplicate delivery without guessing storage state', async () => {
  const discussion = { ...post('2', 'Question'), replyTo: { postId: parent.id, verified: true } };
  const { planOpportunityAssessments } = await import('./hiring-pipeline.js');
  const plan = planOpportunityAssessments([discussion], [parent], new Set([parent.id]));
  assert.deepEqual(plan.alreadyStoredSourceIds, [parent.id]);
  assert.deepEqual(plan.addedSourceIds, []);
  const { results } = await classifyCapturedBatch({ posts: [parent], storedOpportunityIds: new Set([parent.id]), prompt: '', save: noSave,
    fetcher: transport(answer(parent)) });
  assert.equal(results[0]!.decision, 'keep');
  assert.equal(results[0]!.delivery, 'duplicate');
});

test('parent discovery never exceeds 120 assessments and reports deferred source IDs', async () => {
  const { planOpportunityAssessments } = await import('./hiring-pipeline.js');
  const originals = Array.from({ length: 120 }, (_, i) => post(String(i + 2), 'A discussion'));
  originals[0]!.replyTo = { postId: parent.id, verified: true };
  const plan = planOpportunityAssessments(originals, [parent]);
  assert.equal(plan.assessments.length, 120);
  assert.deepEqual(plan.deferredSourceIds, [parent.id]);
});
