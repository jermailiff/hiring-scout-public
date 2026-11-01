import test from 'node:test';
import assert from 'node:assert/strict';
import { runLeadFlow } from './lead-flow.js';
import { parseHiringDecision, parseCompanyRoute } from './lead-contracts.js';
import type { ContactSource } from './lead-contracts.js';
import { graphForPost } from './hiring-pipeline.js';
import type { Post } from './x-posts.js';

const post = (id: string, text = 'We are hiring.'): Post => ({ id, text, author: 'person', authorLabel: '',
  url: `https://x.com/person/status/${id}`, postedAt: null, truncated: false, links: [] });
const decision = (id: string, keep = true) => JSON.stringify({ decision: keep ? 'keep' : 'skip', reason: keep ? 'Hiring invitation.' : 'No hiring.',
  lead_type: keep ? 'own_recruitment' : null, shared_source_id: null });
const sources: ContactSource[] = [{ id: 'careers', url: 'https://employer.example/jobs', text: 'Employer careers.',
  application_routes: [{ kind: 'careers_page', value: 'https://employer.example/jobs' }] }];
const contact = (id: string) => JSON.stringify({ source_post_id: id, company_name: 'Employer', company_source_ids: ['careers'],
  application_routes: [{ kind: 'careers_page', value: 'https://employer.example/jobs', source_id: 'careers' }], needs_lookup: false, reason: 'Official careers source.' });
const save = async () => {};

test('only kept opportunities are enriched and their original source text is preserved', async () => {
  const calls: string[] = [];
  const kept = post('2');
  const result = await runLeadFlow({ posts: [post('1', 'Networking'), kept], maxModelCalls: 3,
    classify: async p => { calls.push(`classify:${p.id}`); return decision(p.id, p.id === '2'); },
    loadSources: async p => { calls.push(`lookup:${p.id}`); return sources; },
    enrich: async p => { calls.push(`enrich:${p.id}`); return contact(p.id); }, save });
  assert.deepEqual(calls, ['classify:1', 'classify:2', 'lookup:2', 'enrich:2']);
  assert.equal(result.rows[1]!.status, 'ready');
  assert.equal(result.rows[1]!.source?.text, kept.text);
});

test('an invented application route does not discard a valid hiring decision', async () => {
  const raw = JSON.parse(contact('1')); raw.application_routes[0].value = 'https://invented.example/jobs';
  const { rows } = await runLeadFlow({ posts: [post('1')], classify: async () => decision('1'), loadSources: async () => sources,
    enrich: async () => JSON.stringify(raw), save });
  assert.equal(rows[0]!.decision, 'keep');
  assert.equal(rows[0]!.status, 'lookup_needed');
  assert.equal(rows[0]!.enrichment, undefined);
});

test('explicit DM remains actionable with no known company', () => {
  const raw = JSON.stringify({ source_post_id: '1', company_name: null, company_source_ids: [],
    application_routes: [{ kind: 'dm', value: '@fictional_hirer', source_id: 'post' }], needs_lookup: false, reason: 'Explicit hiring invitation.' });
  const result = parseCompanyRoute(raw, '1', [{ id: 'post', url: 'https://social.example/post', text: 'DM @fictional_hirer to apply.',
    application_routes: [{ kind: 'dm', value: '@fictional_hirer' }] }]);
  assert.equal(result.company_name, null);
  assert.equal(result.application_routes[0]!.kind, 'dm');
});

test('a mere link in source text is not sufficient hiring-contact eligibility', () => {
  const raw = contact('1');
  assert.throws(() => parseCompanyRoute(raw, '1', [{ ...sources[0]!, application_routes: [], text: 'Sales contact: https://employer.example/jobs' }]), /not offered/);
  const wrong = JSON.parse(raw);wrong.source_post_id = 'other';
  assert.throws(() => parseCompanyRoute(JSON.stringify(wrong), '1', sources), /another opportunity/);
});

test('shared discoveries are enriched once under the original opportunity identity', async () => {
  const parent = post('1');
  const shares = ['2', '3'].map(id => ({ ...post(id, 'Come build with us.'), replyTo: { postId: '1', verified: true } }));
  let enrichments = 0;
  const { rows } = await runLeadFlow({ posts: [...shares, parent], classify: async p => p.id === '1' ? decision('1')
    : JSON.stringify({ decision: 'keep', reason: 'Share.', lead_type: 'shared_opportunity', shared_source_id: '1' }),
    loadSources: async () => sources, enrich: async () => { enrichments++; return contact('1'); }, save });
  assert.equal(enrichments, 1);
  assert.equal(rows[0]!.source?.id, '1');
  assert.equal(rows.filter(r => r.duplicateOfSourceId === '1').length, 2);
});

test('a skipped discussion can discover and independently assess a verified hiring parent', async () => {
  const reply = { ...post('2', 'A question about the research.'), replyTo: { postId: '1', verified: true } };
  const { rows } = await runLeadFlow({ posts: [reply], contextPosts: [post('1')], classify: async p => decision(p.id, p.id === '1'),
    loadSources: async () => sources, enrich: async () => contact('1'), save });
  assert.equal(rows[0]!.decision, 'skip');assert.equal(rows[1]!.status, 'ready');
});

test('request reservation precedes transport and a hiring transport failure stops the run', async () => {
  let reserved = 0, calls = 0;
  const result = await runLeadFlow({ posts: [post('1'), post('2')], classify: async () => {
    calls++; assert.equal(reserved, 1);throw Error('Unavailable');
  }, loadSources: async () => sources, enrich: async () => contact('1'), save: async r => { reserved = r.modelCalls; } });
  assert.equal(calls, 1);assert.equal(result.stopped, true);assert.equal(result.rows[1]!.status, 'not_processed');
});

test('enrichment failure retains the lead and stops further model requests', async () => {
  const result = await runLeadFlow({ posts: [post('1'), post('2')], classify: async p => decision(p.id), loadSources: async () => sources,
    enrich: async () => { throw Error('Unavailable'); }, save });
  assert.equal(result.rows[0]!.decision, 'keep');assert.equal(result.rows[0]!.status, 'lookup_needed');
  assert.equal(result.rows[1]!.status, 'not_processed');assert.equal(result.modelCalls, 2);
});

test('one budget counts both stages and avoids lookup when no enrichment budget remains', async () => {
  const result = await runLeadFlow({ posts: [post('1')], maxModelCalls: 1, classify: async () => decision('1'),
    loadSources: async () => { throw Error('Should not look up'); }, enrich: async () => { throw Error('Should not call'); }, save });
  assert.equal(result.modelCalls, 1);assert.equal(result.rows[0]!.decision, 'keep');
  assert.match(result.rows[0]!.reason, /no budget/);
});

test('core source checks reject unreachable opportunities and wrong recruitment identity', () => {
  const target = post('1'); const { graph } = graphForPost(target, []);
  assert.throws(() => parseHiringDecision(JSON.stringify({ decision: 'keep', reason: 'Share', lead_type: 'shared_opportunity', shared_source_id: 'missing' }), graph), /verified available/);
  assert.throws(() => parseHiringDecision(JSON.stringify({ decision: 'keep', reason: 'Share', lead_type: 'shared_opportunity', shared_source_id: '1' }), graph), /another verified/);
});

test('offline CLI declares legacy projection and preserves the unmodified historical output', async () => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { parseSourceAnswer } = await import('./hiring-evidence.js');
  const directory = await mkdtemp(join(tmpdir(), 'lead-replay-'));
  try {
    const legacy = JSON.stringify({ decision: 'keep', reason: 'Hiring.', lead_type: 'own_recruitment', subject_source_id: '1', target_evidence: { source_id: '1', quote: 'Not the original text' },
      context_evidence: [], company: null, role: 'Unstated role', location: null, needs_context: false });
    assert.throws(() => parseSourceAnswer(legacy, graphForPost(post('1'), []).graph));
    const inputPath = join(directory, 'input.json'), outputPath = join(directory, 'report.json');
    await writeFile(inputPath, JSON.stringify({ posts: [post('1')], legacyHiringResponses: true,
      hiringResponses: { '1': legacy }, enrichmentResponses: { '1': contact('1') }, sources: { '1': sources } }));
    execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), resolve('evals/replay-lead-flow.ts'), inputPath, outputPath]);
    const report = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(report.mode, 'offline_replay');
    assert.equal(report.newProviderCalls, 0);
    assert.equal(report.legacyHiringProjection, true);
    assert.equal(report.originalHiringOutputs['1'], legacy);
    assert.equal(report.report.rows[0].status, 'ready');
    assert.match(report.qualification, /does not repair or rescore/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('own recruitment receives target identity from code with an auditable resolution', () => {
  const { graph } = graphForPost(post('1'), []);
  const result = parseHiringDecision(decision('unused'), graph);
  assert.equal(result.subject_source_id, '1');
  assert.equal(result.source_resolution, 'target_from_code');
  assert.throws(() => parseHiringDecision(JSON.stringify({ ...JSON.parse(decision('unused')), shared_source_id: 'other' }), graph));
});

test('a shared opportunity retains a verified selected source across two connections', () => {
  const original = post('1');
  const middle = { ...post('2', 'Which team?'), replyTo: { postId: '1', verified: true } };
  const target = { ...post('3', 'Come build with us.'), replyTo: { postId: '2', verified: true } };
  const { graph } = graphForPost(target, [original, middle, target]);
  const answer = parseHiringDecision(JSON.stringify({ decision: 'keep', reason: 'Share.', lead_type: 'shared_opportunity', shared_source_id: '1' }), graph);
  assert.equal(answer.subject_source_id, '1');
  assert.equal(answer.source_resolution, 'verified_model_selection');
});

test('shared sources cannot be missing, unverified or three connections away', () => {
  const root = post('1');
  const middle = { ...post('2', 'Which team?'), replyTo: { postId: '1', verified: true } };
  const next = { ...post('3', 'Ask them.'), replyTo: { postId: '2', verified: true } };
  const distant = { ...post('4', 'Come build with us.'), replyTo: { postId: '3', verified: true } };
  const unverified = { ...post('5', 'Come build with us.'), replyTo: { postId: '1', verified: false } };
  const raw = JSON.stringify({ decision: 'keep', reason: 'Share.', lead_type: 'shared_opportunity', shared_source_id: '1' });
  assert.throws(() => parseHiringDecision(raw, graphForPost(distant, [root, middle, next, distant]).graph), /verified available/);
  assert.throws(() => parseHiringDecision(raw, graphForPost(unverified, [root, unverified]).graph), /verified available/);
  assert.throws(() => parseHiringDecision(JSON.stringify({ ...JSON.parse(raw), shared_source_id: null }), graphForPost(post('6'), []).graph));
});

test('non-keeps cannot carry a source selection', () => {
  const { graph } = graphForPost(post('1'), []);
  for (const d of ['skip', 'review']) {
    const valid = { decision: d, reason: 'Not established.', lead_type: null, shared_source_id: null };
    assert.equal(parseHiringDecision(JSON.stringify(valid), graph).subject_source_id, null);
    assert.throws(() => parseHiringDecision(JSON.stringify({ ...valid, shared_source_id: '1' }), graph));
  }
});

test('the original failed live contract stays frozen and migration cannot overwrite conflicting identity', async () => {
  const { parseCoreHiringV1 } = await import('./evals/core-hiring-v1.js');
  const { projectLegacyHiringDecision } = await import('./evals/legacy-decision-adapter.js');
  const { graph } = graphForPost(post('1'), []);
  const old = JSON.stringify({ decision: 'keep', reason: 'Hiring.', lead_type: 'own_recruitment', subject_source_id: null });
  assert.throws(() => parseCoreHiringV1(old, graph), /verified available/);
  assert.throws(() => parseHiringDecision(old, graph)); // No implicit legacy acceptance.
  const migrated = projectLegacyHiringDecision(old, '1');
  assert.equal(parseHiringDecision(migrated, graph).subject_source_id, '1');
  assert.throws(() => projectLegacyHiringDecision(JSON.stringify({ ...JSON.parse(old), subject_source_id: 'other' }), '1'), /Conflicting/);
  assert.throws(() => projectLegacyHiringDecision(JSON.stringify({ ...JSON.parse(old), lead_type: 'shared_opportunity' }), '1'), /Invalid legacy shared/);
});

test('invalid route preserves trusted company identity but never salvages an unverified model name', async () => {
  const employerSource:ContactSource={id:'identity',url:'https://employer.example/',text:'Verified affiliation.',verified_company_name:'Employer'};
  const raw=JSON.stringify({source_post_id:'1',company_name:'Invented',company_source_ids:['identity'],application_routes:[{kind:'careers_page',value:'https://guessed.example/jobs',source_id:'identity'}],needs_lookup:false,reason:'Unsupported route.'});
  for(const trusted of [true,false]){
    const source=trusted?employerSource:{id:employerSource.id,url:employerSource.url,text:employerSource.text};
    const result=await runLeadFlow({posts:[post('1')],classify:async()=>decision('1'),loadSources:async()=>[source],enrich:async()=>raw,save});
    assert.equal(result.rows[0]!.status,'lookup_needed');assert.equal(result.rows[0]!.rawEnrichment,trusted?undefined:raw);
    assert.equal(result.opportunities[0]!.companyName,trusted?'Employer':null);assert.deepEqual(result.opportunities[0]!.applicationRoutes,[]);
  }
});

test('opportunity aliases require complete connected sources, explicit evidence and no chains', async () => {
  const {validateOpportunityAliases}=await import('./opportunity-aliases.js');
  const a=post('1'),b={...post('2'),references:[{relationship:'quoted_post' as const,url:a.url,post:a}]};
  const alias={sourceId:'1',canonicalSourceId:'2',evidence:'Confirmed same vacancy.'};
  validateOpportunityAliases([alias],[a,b]);
  assert.throws(()=>validateOpportunityAliases([alias],[a,post('2')]),/verified/);
  assert.throws(()=>validateOpportunityAliases([{...alias,evidence:''}],[a,b]),/Invalid/);
  assert.throws(()=>validateOpportunityAliases([alias,{sourceId:'2',canonicalSourceId:'3',evidence:'Confirmed'}],[a,b,post('3')]),/chain/);
});
