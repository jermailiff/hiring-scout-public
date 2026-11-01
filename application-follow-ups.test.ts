import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApplicationFollowUps } from './application-follow-ups.js';
import { runLeadFlow } from './lead-flow.js';
import type { Post } from './x-posts.js';
import type { ContactSource } from './lead-contracts.js';

// Constructed employer-thread fixtures, not recovered private post metadata.
const post = (id: string, author = 'employer', parent?: string): Post => ({
  id, author, url: `https://x.com/${author}/status/${id}`, authorLabel: author,
  text: parent ? 'Apply or refer here.' : 'We are hiring researchers.',
  postedAt: null, truncated: false,
  links: parent ? [{ url: 'https://example.org/jobs', label: 'Role details', expandedUrl: null }] : [],
  ...(parent ? { replyTo: { postId: parent, verified: true } } : {}),
});
const route: ContactSource = { id: 'verified-job', url: 'https://example.org/jobs', text: 'Employer application page.',
  application_routes: [{ kind: 'job_page', value: 'https://example.org/jobs' }] };

test('verified employer follow-up attaches via a quoted hiring source without becoming another opportunity', async () => {
  const employer = post('1'), jay = post('2', 'sharer');
  jay.references = [{ relationship: 'quoted_post', url: employer.url, post: employer }];
  const reply = post('3', 'employer', '1');
  const result = await runLeadFlow({ posts: [jay], applicationFollowUps: { posts: [jay, employer, reply], verify: async p => {
    assert.equal(p.id, '3');return [route];
  } }, classify: async p => JSON.stringify({ decision: 'keep', reason: 'Hiring.', lead_type: p.id === '2' ? 'shared_opportunity' : 'own_recruitment', shared_source_id: p.id === '2' ? '1' : null }),
  loadSources: async () => [], enrich: async (source, sources) => {
    assert.equal(source.id, '1');assert.deepEqual(sources, [route]);
    return JSON.stringify({ source_post_id: '1', company_name: 'Employer', company_source_ids: [route.id],
      application_routes: [{ ...route.application_routes![0], source_id: route.id }], needs_lookup: false, reason: 'Verified job page.' });
  }, save: async () => {} });
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0]!.sourceId, '1');
  assert.equal(result.rows[0]!.status, 'ready');
});

test('thread order, different authors, truncated posts and unsafe identities cannot supply follow-ups', async () => {
  const root = post('1');
  const unverified = post('2', 'employer', '1');unverified.replyTo!.verified = false;
  const ordered = post('3');ordered.discoveredInThread = '1';ordered.text = 'Apply here.';ordered.links = post('2', 'employer', '1').links;
  const truncated = post('4', 'employer', '1');truncated.truncated = true;
  const unsafe = post('5', 'employer', '1');unsafe.url = 'https://evil.example/status/5';
  const result = await loadApplicationFollowUps({ source: root, posts: [root, unverified, ordered, truncated, unsafe, post('6', 'applicant', '1')],
    verify: async () => { throw Error('Must not retrieve'); } });
  assert.deepEqual(result.checkedPostIds, []);
});

test('same-author chains stop after two replies and never inherit another hirer parent routes', async () => {
  const root = post('1'), a = post('2', 'employer', '1'), b = post('3', 'employer', '2'), c = post('4', 'employer', '3');
  const result = await loadApplicationFollowUps({ source: root, posts: [root, a, b, c], verify: async () => [route] });
  assert.deepEqual(result.checkedPostIds, ['2', '3']);
  const other = post('5', 'other');root.replyTo = { postId: '5', verified: true };
  const separate = await loadApplicationFollowUps({ source: root, posts: [root, other, post('6', 'other', '5')], verify: async () => [route] });
  assert.deepEqual(separate.checkedPostIds, []);
});

test('lookup failures are recorded without retry and the per-opportunity cap reports deferred replies', async () => {
  const root = post('1');let calls = 0;
  const result = await loadApplicationFollowUps({ source: root, posts: [root, ...['2','3','4','5'].map(id => post(id, 'employer', '1'))],
    verify: async () => { calls++;throw Error('Unavailable'); } });
  assert.equal(calls, 3);assert.deepEqual(result.failedPostIds, ['2','3','4']);assert.deepEqual(result.deferredPostIds, ['5']);
  await assert.rejects(loadApplicationFollowUps({ source: root, posts: [root, { ...root, text: 'Conflicting' }], verify: async () => [] }), /Conflicting/);
});

test('a plain linked reply is not trusted as an application destination without verification metadata', async () => {
  const root = post('1');
  const result = await runLeadFlow({ posts: [root], applicationFollowUps: { posts: [root, post('2', 'employer', '1')],
    verify: async () => [{ ...route, application_routes: [] }] },
    classify: async () => JSON.stringify({ decision: 'keep', reason: 'Hiring.', lead_type: 'own_recruitment', shared_source_id: null }),
    loadSources: async () => [], enrich: async () => JSON.stringify({ source_post_id: '1', company_name: 'Employer', company_source_ids: [route.id],
      application_routes: [{ kind: 'job_page', value: route.url, source_id: route.id }], needs_lookup: false, reason: 'Unverified link.' }), save: async () => {} });
  assert.equal(result.opportunities.length, 1);assert.equal(result.opportunities[0]!.needsLookup, true);
  assert.equal(result.rows[0]!.enrichment, undefined);
});

test('the batch shares six destination lookups across opportunities', async () => {
  const roots = ['1','2','3'].map(id => post(id, `employer${id}`));
  const replies = roots.flatMap(root => ['1','2','3'].map(n => post(`${root.id}${n}`, root.author, root.id)));
  let calls = 0;
  const result = await runLeadFlow({ posts: roots, applicationFollowUps: { posts: [...roots, ...replies], verify: async () => { calls++;return []; } },
    classify: async () => JSON.stringify({ decision: 'keep', reason: 'Hiring.', lead_type: 'own_recruitment', shared_source_id: null }),
    loadSources: async () => [], enrich: async source => JSON.stringify({ source_post_id: source.id, company_name: null, company_source_ids: [],
      application_routes: [], needs_lookup: true, reason: 'No route verified.' }), save: async () => {} });
  assert.equal(calls, 6);assert.equal(result.rows[2]!.applicationFollowUpLookup!.deferredPostIds.length, 3);
});
