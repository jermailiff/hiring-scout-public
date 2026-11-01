import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpportunityShortlist } from './opportunities.js';
import { scoreOpportunities } from './evals/opportunity-eval.js';
import type { LeadFlowRow } from './lead-flow.js';

const source = (id: string) => ({ id, url: `https://x.com/hirer/status/${id}`, author: 'hirer', authorLabel: 'Hirer',
  text: 'We are hiring.', links: [], postedAt: null, truncated: false });
const row = (postId: string, sourceId: string): LeadFlowRow => ({ postId, decision: 'keep', reason: 'Found hiring source.', status: 'lookup_needed', source: source(sourceId) });

test('random discovery points to the hiring parent without appearing as the opportunity', () => {
  const opportunities = buildOpportunityShortlist([row('comment', 'hiring-parent')]);
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0]!.sourceId, 'hiring-parent');
  assert.equal(opportunities[0]!.hiringSourceUrl, 'https://x.com/hirer/status/hiring-parent');
  assert.equal(JSON.stringify(opportunities).includes('comment'), false);
  assert.equal(opportunities[0]!.needsLookup, true);
});

test('another hirer saying us too remains separate while repeated source discoveries collapse', () => {
  const rows = [row('comment', 'parent'), row('parent', 'parent'), row('us-too', 'us-too')];
  const opportunities = buildOpportunityShortlist(rows);
  assert.deepEqual(opportunities.map(o => o.sourceId), ['parent', 'us-too']);
  assert.equal(scoreOpportunities(['parent', 'us-too'], opportunities).captured, 2);
});

test('known stored duplicates and non-hiring discoveries produce no new shortlist cards', () => {
  const duplicate = { ...row('reply', 'already-stored'), duplicateOfSourceId: 'already-stored' };
  const skip: LeadFlowRow = { postId: 'noise', decision: 'skip', reason: 'No hiring source.', status: 'decided' };
  assert.deepEqual(buildOpportunityShortlist([duplicate, skip]), []);
});

test('capture is scored separately from application-route completeness and duplicates', () => {
  const a = buildOpportunityShortlist([row('discovery', 'wanted')])[0]!;
  const unexpected = { ...a, sourceId: 'unwanted' };
  assert.deepEqual(scoreOpportunities(['wanted', 'missed'], [a, a, unexpected]), {
    expected: 2, captured: 1, missedSourceIds: ['missed'], unexpectedSourceIds: ['unwanted'], duplicateEntries: 1, capturedWithApplicationRoute: 0,
  });
});

test('employer and application routes are shown for the hiring source with audit rows intact', () => {
  const audit = row('random', 'actual-hirer');
  audit.status = 'ready';
  audit.enrichment = { source_post_id: 'actual-hirer', company_name: 'Example', company_source_ids: ['careers'],
    application_routes: [{ kind: 'careers_page', value: 'https://example.com/jobs', source_id: 'careers' }], needs_lookup: false, reason: 'Verified supplied route.' };
  const cards = buildOpportunityShortlist([audit]);
  assert.equal(cards[0]!.companyName, 'Example');
  assert.equal(scoreOpportunities(['actual-hirer'], cards).capturedWithApplicationRoute, 1);
  assert.equal(audit.postId, 'random');
  cards[0]!.applicationRoutes.length = 0;
  assert.equal(audit.enrichment.application_routes.length, 1);
});

test('verified same-opportunity aliases collapse cards and retain both source IDs without altering audit rows', () => {
  const a=row('discovery','canonical'),b=row('employer','original');
  const cards=buildOpportunityShortlist([a,b],[{sourceId:'original',canonicalSourceId:'canonical',evidence:'Confirmed same hiring opportunity.'}]);
  assert.equal(cards.length,1);assert.equal(cards[0]!.sourceId,'canonical');assert.deepEqual(cards[0]!.relatedSourceIds,['original']);
  assert.equal(b.duplicateOfSourceId,undefined);assert.equal(b.source!.id,'original');
});

test('company and careers equality alone cannot merge independent hiring posts', () => {
  const a=row('a','1'),b=row('b','2');
  for(const r of [a,b]) r.verifiedCompany={name:'Same company',sourceIds:['identity']};
  assert.equal(buildOpportunityShortlist([a,b]).length,2);
  assert.equal(buildOpportunityShortlist([b],[{sourceId:'2',canonicalSourceId:'1',evidence:'Confirmed.'}]).length,1);
});

test('company identity remains visible while contact details need lookup', () => {
  const a=row('a','1');a.verifiedCompany={name:'Verified employer',sourceIds:['identity']};
  const card=buildOpportunityShortlist([a])[0]!;assert.equal(card.companyName,'Verified employer');assert.equal(card.needsLookup,true);assert.deepEqual(card.applicationRoutes,[]);
});
