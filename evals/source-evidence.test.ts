import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evidenceGraphSchema, parseSourceAnswer, reachableSources, sourceLeadKey, verifiedContextView, sourceAnswerJsonSchema, opportunityDisposition } from './source-evidence.js';
import { buildMessages, parseSuite, scoreAttributions, scoreDecisions } from './practice-eval.js';
import { prepareRequests, runPractice, experimentFiles } from './run-practice.js';
const suite = parseSuite(JSON.parse(await readFile(new URL('./source-evidence-cases.json', import.meta.url), 'utf8')));
const prompt = await readFile(new URL('./prompts/source-evidence.txt', import.meta.url), 'utf8');
const graph = suite.cases[1]!.input.evidence_graph!;
const boundaries = parseSuite(JSON.parse(await readFile(new URL('./attribution-boundary-cases.json', import.meta.url), 'utf8')));

test('regression experiment sends the unchanged six earlier cases using the latest prompt and schema', async () => {
  const files = experimentFiles('verified-context-regression');
  assert.equal(files.suite, experimentFiles('source-evidence').suite);
  assert.equal(files.prompt, experimentFiles('verified-context-shares').prompt);
  const candidate = await readFile(files.prompt, 'utf8');
  const requests = prepareRequests(candidate, suite, 'verified-context', true);
  assert.equal(requests.length, 6);
  assert.deepEqual(suite.cases.map(c => c.expected.decision), ['skip', 'keep', 'skip', 'skip', 'keep', 'skip']);
  for (const [i, c] of suite.cases.entries()) {
    assert.deepEqual(JSON.parse(requests[i]!.request.messages[1]!.content), verifiedContextView(c.input.evidence_graph!));
    assert.equal(requests[i]!.request.response_format.type, 'json_schema');
  }
  const dry = await runPractice({ prompt: candidate, suite, env: { EVAL_EXPERIMENT: 'verified-context-regression' },
    save: async () => {}, fetcher: async () => { throw new Error('Unexpected model call'); } });
  assert.equal(dry.requestCap, 6); assert.equal(dry.predictions.length, 0);
  let sent: unknown;
  const stopped = await runPractice({ prompt: candidate, suite, env: {
    EVAL_MODE: 'live', EVAL_EXPERIMENT: 'verified-context-regression', GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1',
    FREE_ALLOWANCES_CONFIRMED: 'true', ALLOWANCE_CHECKED_AT: new Date().toISOString(),
    CLOUDFLARE_API_TOKEN: 'dummy-test-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  }, save: async () => {}, fetcher: async (_url, init) => {
    sent = JSON.parse(String(init!.body)); return new Response('', { status: 403 });
  } });
  assert.deepEqual(sent, requests[0]!.request);
  assert.equal(stopped.predictions.length, 1);
  assert.equal(stopped.scores?.missing, 6);
});

test('qualified shares stay keep while known opportunity identities suppress duplicate delivery', () => {
  const c = boundaries.cases[0]!; const g = c.input.evidence_graph!;
  const answer = parseSourceAnswer(JSON.stringify({ decision: 'keep', reason: 'Mock qualified share',
    target_evidence: { source_id: 'sam', quote: 'Come build with us.' },
    context_evidence: [{ source_id: 'alex', quote: g.posts[1]!.text }],
    ...c.expected.attribution, role: null, location: null, needs_context: false }), g);
  assert.equal(opportunityDisposition(answer, new Set()).delivery, 'new_opportunity');
  const stored = new Set(['alex']);
  assert.deepEqual(opportunityDisposition(answer, stored), { decision: 'keep', leadKey: 'alex', delivery: 'duplicate' });
  // Same company, another explicit original recruiting post: do not merge by company.
  const otherGraph = { target_id: 'another-opening', posts: [
    { id: 'another-opening', author: 'Alex', text: 'Company A is hiring a designer.', url: null }], connections: [] };
  const other = parseSourceAnswer(JSON.stringify({ ...answer, lead_type: 'own_recruitment',
    subject_source_id: 'another-opening', target_evidence: { source_id: 'another-opening', quote: 'Company A is hiring a designer.' },
    context_evidence: [] }), otherGraph);
  assert.equal(other.company, answer.company);
  assert.equal(opportunityDisposition(other, stored).delivery, 'new_opportunity');
  assert.deepEqual([...stored], ['alex']);
  const skip = parseSourceAnswer(JSON.stringify({ ...answer, decision: 'skip', target_evidence: null,
    context_evidence: [], lead_type: null, subject_source_id: null, company: null }), g);
  assert.equal(opportunityDisposition(skip, stored).delivery, 'not_a_kept_lead');
});

test('shared-opportunity prompt experiment preserves four-case inputs, labels and schema settings', async () => {
  const files = experimentFiles('verified-context-shares');
  assert.equal(files.suite, experimentFiles('verified-context-schema').suite);
  const oldPrompt = await readFile(new URL('./prompts/verified-context-candidate.txt', import.meta.url), 'utf8');
  const newPrompt = await readFile(new URL('./prompts/shared-opportunity-candidate.txt', import.meta.url), 'utf8');
  const oldRequests = prepareRequests(oldPrompt, boundaries, 'verified-context', true);
  const newRequests = prepareRequests(newPrompt, boundaries, 'verified-context', true);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(newRequests[i]!.request.messages[1], oldRequests[i]!.request.messages[1]);
    assert.deepEqual(newRequests[i]!.request.response_format, oldRequests[i]!.request.response_format);
    const { messages: _a, ...oldSettings } = oldRequests[i]!.request;
    const { messages: _b, ...newSettings } = newRequests[i]!.request;
    assert.deepEqual(newSettings, oldSettings);
  }
  const dry = await runPractice({ prompt: newPrompt, suite: boundaries,
    env: { EVAL_EXPERIMENT: 'verified-context-shares' }, save: async () => {},
    fetcher: async () => { throw new Error('Unexpected inference'); } });
  assert.equal(dry.requestCap, 4); assert.equal(dry.predictions.length, 0);
});

test('schema experiment changes only response_format and retains the local structural contract', async () => {
  assert.deepEqual(experimentFiles('verified-context-schema'), experimentFiles('verified-context-candidate'));
  const candidate = await readFile(new URL('./prompts/verified-context-candidate.txt', import.meta.url), 'utf8');
  const before = prepareRequests(candidate, boundaries, 'verified-context');
  const after = prepareRequests(candidate, boundaries, 'verified-context', true);
  assert.equal(after.length, 4);
  for (let i = 0; i < after.length; i++) {
    const { response_format: oldFormat, ...oldRequest } = before[i]!.request;
    const { response_format: newFormat, ...newRequest } = after[i]!.request;
    assert.deepEqual(newRequest, oldRequest);
    assert.deepEqual(oldFormat, { type: 'json_object' });
    assert.deepEqual(newFormat, { type: 'json_schema', json_schema: {
      name: 'hiring_source_answer', strict: true, schema: sourceAnswerJsonSchema,
    } });
  }
  const schema = sourceAnswerJsonSchema as any;
  assert.deepEqual(schema.properties.decision.enum, ['keep', 'skip', 'review']);
  assert.equal(schema.properties.context_evidence.type, 'array');
  assert.deepEqual(schema.properties.target_evidence.anyOf.map((s: any) => s.type), ['object', 'null']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)));

  let sent: unknown;
  const report = await runPractice({ prompt: candidate, suite: boundaries, env: {
    EVAL_MODE: 'live', EVAL_EXPERIMENT: 'verified-context-schema', GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1',
    FREE_ALLOWANCES_CONFIRMED: 'true', ALLOWANCE_CHECKED_AT: new Date().toISOString(),
    CLOUDFLARE_API_TOKEN: 'dummy-test-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  }, save: async () => {}, fetcher: async (_url, init) => {
    sent = JSON.parse(String(init!.body));
    return new Response('', { status: 400 }); // Unsupported schema fails closed, without fallback.
  } });
  assert.deepEqual(sent, after[0]!.request);
  assert.equal(report.status, 'stopped'); assert.equal(report.predictions.length, 1);
  assert.equal(report.scores?.missing, 4); assert.equal(report.attributionScores?.missing, 4);
});

test('explicit context preserves full source text and verified paths without semantic labels', () => {
  for (const c of [...suite.cases, ...boundaries.cases]) {
    const g = c.input.evidence_graph!;
    const view = verifiedContextView(g);
    assert.deepEqual(view.target, g.posts.find(p => p.id === g.target_id));
    const reachable = reachableSources(g);
    assert.deepEqual(view.verified_context.map(c => [c.post.id, c.distance]), [...reachable].filter(([id]) => id !== g.target_id));
    for (const context of view.verified_context) {
      assert.deepEqual(context.post, g.posts.find(p => p.id === context.post.id));
      assert.equal(context.path.length, context.distance);
      assert.equal(context.path[0]?.from_id, g.target_id);
      assert.equal(context.path.at(-1)?.to_id, context.post.id);
      context.path.forEach((edge, i) => {
        assert.equal(edge.verified, true);
        if (i > 0) assert.equal(context.path[i - 1]!.to_id, edge.from_id);
      });
    }
    assert.deepEqual(JSON.parse(buildMessages(prompt, c, 'verified-context')[1]!.content), view);
    assert.deepEqual(buildMessages(prompt, c, 'verified-context'), buildMessages(prompt,
      { ...c, expected: { decision: 'review', reason: 'SECRET ANSWER' } }, 'verified-context'));
  }
  const three = verifiedContextView(boundaries.cases[3]!.input.evidence_graph!);
  assert.equal(three.verified_context.some(c => c.post.id === 'alex-opening'), false);
  assert.equal(three.blocked_connections[0]?.reason, 'beyond_two_connections');
  assert.equal(verifiedContextView(suite.cases[2]!.input.evidence_graph!).blocked_connections[0]?.reason, 'unverified_connection');
  assert.equal(verifiedContextView(suite.cases[5]!.input.evidence_graph!).blocked_connections[0]?.reason, 'source_text_unavailable');
});

test('verified-context runner uses the new representation without making dry-run calls', async () => {
  const candidate = await readFile(new URL('./prompts/verified-context-candidate.txt', import.meta.url), 'utf8');
  const requests = prepareRequests(candidate, boundaries, 'verified-context');
  assert.equal(requests.length, 4);
  let saved = 0;
  const report = await runPractice({ prompt: candidate, suite: boundaries,
    env: { EVAL_EXPERIMENT: 'verified-context-candidate' }, save: async () => { saved++; },
    fetcher: async () => { throw new Error('Unexpected model call'); } });
  assert.equal(report.status, 'prepared'); assert.equal(saved, 1); assert.equal(report.predictions.length, 0);
  // Capture the actual request constructed by the runner using a mocked transport.
  let actualInput: unknown;
  await runPractice({ prompt: candidate, suite: boundaries, env: {
    EVAL_MODE: 'live', EVAL_EXPERIMENT: 'verified-context-candidate', GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1',
    FREE_ALLOWANCES_CONFIRMED: 'true', ALLOWANCE_CHECKED_AT: new Date().toISOString(),
    CLOUDFLARE_API_TOKEN: 'dummy-test-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  }, save: async () => {}, fetcher: async (_url, init) => {
    actualInput = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    return new Response('', { status: 403 });
  } });
  assert.deepEqual(actualInput, verifiedContextView(boundaries.cases[0]!.input.evidence_graph!));
});

test('agreed attribution and distance boundaries accept source-correct synthetic answers', () => {
  assert.deepEqual(boundaries.cases.map(c => c.expected.decision), ['keep', 'keep', 'keep', 'skip']);
  for (const c of boundaries.cases) {
    const g = c.input.evidence_graph!;
    const expected = c.expected.attribution!;
    const source = g.posts.find(p => p.id === expected.subject_source_id);
    const answer = { decision: c.expected.decision, reason: 'Mock only, not a model result',
      target_evidence: source ? { source_id: g.target_id, quote: g.posts[0]!.text } : null,
      context_evidence: source ? [{ source_id: source.id, quote: source.text }] : [],
      ...expected, role: null, location: null, needs_context: false };
    assert.equal(sourceLeadKey(parseSourceAnswer(JSON.stringify(answer), g)), expected.subject_source_id);
    const messages = buildMessages(prompt, c);
    assert.deepEqual(JSON.parse(messages[1]!.content), g);
    assert.deepEqual(buildMessages(prompt, { ...c, expected: { decision: 'review', reason: 'hidden' } }), messages);
  }
  const two = boundaries.cases[2]!.input.evidence_graph!;
  const three = boundaries.cases[3]!.input.evidence_graph!;
  assert.equal(reachableSources(two).get('alex-opening'), 2);
  assert.equal(reachableSources(three).has('alex-opening'), false);
  assert.throws(() => parseSourceAnswer(JSON.stringify({ decision: 'keep', reason: 'Invalid three-step mock',
    target_evidence: { source_id: three.target_id, quote: 'Come build with us.' },
    context_evidence: [{ source_id: 'alex-opening', quote: 'We’re hiring engineers at Company A.' }],
    lead_type: 'shared_opportunity', subject_source_id: 'alex-opening', company: 'Company A',
    role: null, location: null, needs_context: false }), three));
});

test('decision agreement cannot hide incorrect or missing opportunity attribution', () => {
  const predictions = boundaries.cases.map(c => ({ caseId: c.id, decision: c.expected.decision,
    attribution: c.expected.attribution! }));
  assert.equal(scoreDecisions(boundaries, predictions).correct, 4);
  assert.equal(scoreAttributions(boundaries, predictions).correct, 4);
  const wrong = predictions.map((p, i) => i === 1 ? { ...p,
    attribution: { ...p.attribution, subject_source_id: 'alex', company: 'Company A' } } : p);
  assert.equal(scoreDecisions(boundaries, wrong).correct, 4);
  assert.equal(scoreAttributions(boundaries, wrong).correct, 3);
  const partial = scoreAttributions(boundaries, predictions.slice(0, 2));
  assert.equal(partial.total, 4); assert.equal(partial.correct, 2); assert.equal(partial.missing, 2);
  assert.throws(() => scoreAttributions(boundaries, [predictions[0]!, predictions[0]!]));
  assert.throws(() => scoreAttributions(boundaries, [{ caseId: 'unknown' }]));
});

test('four-case experiment prepares without inference and saves separate attribution scores', async () => {
  const candidate = await readFile(new URL('./prompts/attribution-candidate.txt', import.meta.url), 'utf8');
  assert.equal(prepareRequests(candidate, boundaries).length, 4);
  const dry = await runPractice({ prompt: candidate, suite: boundaries, env: {}, save: async () => {},
    fetcher: async () => { throw new Error('Unexpected inference'); } });
  assert.equal(dry.requestCap, 4); assert.equal(dry.predictions.length, 0);
  assert.equal(dry.attributionScores, undefined);
  let calls = 0;
  const report = await runPractice({ prompt: candidate, suite: boundaries, env: {
    EVAL_MODE: 'live', EVAL_EXPERIMENT: 'attribution-candidate', GITHUB_ACTIONS: 'true',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1',
    FREE_ALLOWANCES_CONFIRMED: 'true', ALLOWANCE_CHECKED_AT: new Date().toISOString(),
    CLOUDFLARE_API_TOKEN: 'dummy-test-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
  }, save: async () => {}, fetcher: async () => {
    const c = boundaries.cases[calls++]!; const g = c.input.evidence_graph!;
    const attribution = c.expected.attribution!;
    const source = g.posts.find(p => p.id === attribution.subject_source_id);
    // Deliberately misattribute one valid keep: decision agreement must not hide it.
    const wrong = c.id === 'quote-original-company';
    return Response.json({ result: { response: JSON.stringify({
      decision: c.expected.decision, reason: 'Fabricated test response, not a model result',
      target_evidence: source ? { source_id: g.target_id, quote: g.posts[0]!.text } : null,
      context_evidence: source ? [{ source_id: source.id, quote: source.text }] : [],
      ...attribution, ...(wrong ? { lead_type: 'own_recruitment', subject_source_id: g.target_id, company: null } : {}),
      role: null, location: null, needs_context: false,
    }) } });
  } });
  assert.equal(calls, 4); assert.equal(report.scores?.correct, 4);
  assert.equal(report.attributionScores?.correct, 3);
  assert.equal(report.attributionScores?.missing, 0);
});
function own(target = graph.target_id) {
  return { decision: 'keep', reason: 'Synthetic fixture: target adopts verified recruitment',
    target_evidence: { source_id: target, quote: 'We are too.' },
    context_evidence: [{ source_id: 'parent', quote: 'We’re hiring two backend engineers.' }],
    lead_type: 'own_recruitment', subject_source_id: target,
    company: null, role: null, location: null, needs_context: true };
}

test('split citations accept the target and parent words under their own identities', () => {
  const result = parseSourceAnswer(JSON.stringify(own()), graph);
  assert.equal(result.decision, 'keep');
  assert.equal(result.role, null);
  for (const bad of [
    { ...own(), target_evidence: { source_id: graph.target_id, quote: 'We’re hiring two backend engineers.' } },
    { ...own(), target_evidence: { source_id: 'parent', quote: 'We’re hiring two backend engineers.' } },
    { ...own(), context_evidence: [{ source_id: 'invented', quote: 'We are too.' }] },
    { ...own(), role: 'backend engineers' },
    { ...own(), company: 'Parent Company' },
    { ...own(), target_evidence: null },
    { ...own(), subject_source_id: 'parent' },
  ]) assert.throws(() => parseSourceAnswer(JSON.stringify(bad), graph));
});

test('separate authors asserting hiring are not merged through their shared parent', () => {
  const second = { ...graph, target_id: 'second-reply', posts: [
    ...graph.posts, { id: 'second-reply', author: 'another-author', text: 'We are too.', url: null }],
    connections: [...graph.connections, { from_id: 'second-reply', to_id: 'parent', relationship: 'direct_reply' as const, verified: true }] };
  const a = parseSourceAnswer(JSON.stringify(own()), graph);
  const b = parseSourceAnswer(JSON.stringify(own('second-reply')), second);
  assert.notEqual(sourceLeadKey(a), sourceLeadKey(b));
  assert.equal(a.company, null); assert.equal(b.company, null);
});

test('a mere quoted share points to the original opportunity, not a guessed second employer', () => {
  const g = suite.cases[4]!.input.evidence_graph!;
  const answer = { ...own(), target_evidence: { source_id: g.target_id, quote: 'Come build with us.' },
    context_evidence: [{ source_id: 'recruitment', quote: 'We’re hiring our first product engineer.' }],
    lead_type: 'shared_opportunity', subject_source_id: 'recruitment', role: 'product engineer' };
  assert.equal(sourceLeadKey(parseSourceAnswer(JSON.stringify(answer), g)), 'recruitment');
  assert.throws(() => parseSourceAnswer(JSON.stringify({ ...answer, subject_source_id: g.target_id }), g));
});

test('citation reachability stops after two verified available connections', () => {
  const g = evidenceGraphSchema.parse({ target_id: 'target', posts: [
    { id: 'target', author: 't', text: 'Same here.', url: null },
    { id: 'one', author: 'a', text: 'We are too.', url: null },
    { id: 'two', author: 'b', text: 'We’re hiring.', url: null },
    { id: 'three', author: 'c', text: 'We’re hiring engineers.', url: null }],
    connections: [
      { from_id: 'target', to_id: 'one', relationship: 'direct_reply', verified: true },
      { from_id: 'one', to_id: 'two', relationship: 'direct_reply', verified: true },
      { from_id: 'two', to_id: 'three', relationship: 'direct_reply', verified: true }] });
  assert.deepEqual([...reachableSources(g)], [['target', 0], ['one', 1], ['two', 2]]);
  const answer = { ...own('target'), target_evidence: { source_id: 'target', quote: 'Same here.' },
    context_evidence: [{ source_id: 'two', quote: 'We’re hiring.' }] };
  parseSourceAnswer(JSON.stringify(answer), g);
  assert.throws(() => parseSourceAnswer(JSON.stringify({ ...answer,
    context_evidence: [{ source_id: 'three', quote: 'We’re hiring engineers.' }] }), g));
  assert.equal(reachableSources({ ...g, connections: g.connections.map(e => ({ ...e, verified: false })) }).size, 1);
  assert.equal(reachableSources({ ...g, posts: g.posts.filter(p => p.id !== 'one') }).size, 1);
  assert.throws(() => evidenceGraphSchema.parse({ ...g, posts: [...g.posts, g.posts[0]!] }));
});

test('new representation preserves six labels, withholds answers and prepares bounded requests', async () => {
  assert.deepEqual(suite.cases.map(c => c.expected.decision), ['skip', 'keep', 'skip', 'skip', 'keep', 'skip']);
  const prior = parseSuite(JSON.parse(await readFile(new URL('./boundary-cases-v2.json', import.meta.url), 'utf8')));
  for (const [i, c] of suite.cases.entries()) {
    assert.equal(c.input.text, prior.cases[i]!.input.text);
    assert.deepEqual(c.expected, prior.cases[i]!.expected);
    assert.deepEqual(JSON.parse(buildMessages(prompt, c)[1]!.content), c.input.evidence_graph);
    assert.deepEqual(buildMessages(prompt, { ...c, expected: { decision: 'review', reason: 'SECRET KEY' } }), buildMessages(prompt, c));
  }
  assert.equal(prepareRequests(prompt, suite).length, 6);
  const report = await runPractice({ prompt, suite, env: { EVAL_EXPERIMENT: 'source-evidence' },
    fetcher: async () => { throw new Error('Unexpected model call'); }, save: async () => {} });
  assert.equal(report.status, 'prepared'); assert.equal(report.predictions.length, 0);
});

test('parent recruitment and a hiring reply both qualify with separate lead identities', () => {
  const reply = parseSourceAnswer(JSON.stringify(own()), graph);
  const parentGraph = { ...graph, target_id: 'parent' };
  const parent = parseSourceAnswer(JSON.stringify({ ...own(),
    target_evidence: { source_id: 'parent', quote: 'We’re hiring two backend engineers.' },
    context_evidence: [], subject_source_id: 'parent', role: 'backend engineers', needs_context: false,
  }), parentGraph);
  assert.notEqual(sourceLeadKey(parent), sourceLeadKey(reply));
  assert.equal(parent.company, null); assert.equal(reply.company, null);
  assert.equal(parent.role, 'backend engineers'); assert.equal(reply.role, null);
});

test('runner saves validated attribution and lead identity without production overrides', async () => {
  let calls = 0;
  const report = await runPractice({ prompt, suite, env: { EVAL_MODE: 'live', EVAL_EXPERIMENT: 'source-evidence',
    GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_RUN_ATTEMPT: '1', FREE_ALLOWANCES_CONFIRMED: 'true', ALLOWANCE_CHECKED_AT: new Date().toISOString(),
    CLOUDFLARE_API_TOKEN: 'dummy-test-token', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }, save: async () => {},
    fetcher: async () => {
      const c = suite.cases[calls++]!; const g = c.input.evidence_graph!;
      let answer: unknown = { decision: 'skip', reason: 'Mock only, not a model result',
        target_evidence: null, context_evidence: [], lead_type: null, subject_source_id: null,
        company: null, role: null, location: null, needs_context: false };
      if (c.id === 'reply-to-recruitment') answer = own(g.target_id);
      if (c.id === 'build-recruitment') answer = { ...own(),
        target_evidence: { source_id: g.target_id, quote: 'Come build with us.' },
        context_evidence: [{ source_id: 'recruitment', quote: 'We’re hiring our first product engineer.' }],
        lead_type: 'shared_opportunity', subject_source_id: 'recruitment' };
      return Response.json({ result: { response: JSON.stringify(answer) } });
    } });
  assert.equal(calls, 6); assert.equal(report.scores?.correct, 6);
  assert.equal(report.predictions[1]?.leadKey, graph.target_id);
  assert.equal(report.predictions[1]?.attribution?.context_evidence[0]?.source_id, 'parent');
  assert.equal(report.predictions[4]?.leadKey, 'recruitment');
});
