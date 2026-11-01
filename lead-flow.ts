import type { z } from 'zod';
import { validateOpportunityAliases } from './opportunity-aliases.js';
import type { VerifiedOpportunityAlias } from './opportunity-aliases.js';
import { loadApplicationFollowUps } from './application-follow-ups.js';
import type { ApplicationFollowUpLookup } from './application-follow-ups.js';
import { buildOpportunityShortlist } from './opportunities.js';
import type { HiringOpportunity } from './opportunities.js';
import type { Post, PostEvidence } from './x-posts.js';
import { graphForPost, planOpportunityAssessments } from './hiring-pipeline.js';
import { verifiedContextView, reachableSources } from './hiring-evidence.js';
import { parseHiringDecision, parseCompanyRoute, HIRING_DECISION_CONTRACT_VERSION } from './lead-contracts.js';
import type { companyRouteSchema, ContactSource } from './lead-contracts.js';

export interface LeadFlowRow {
  postId: string; decision: 'keep' | 'skip' | 'review'; reason: string;
  status: 'pending_decision' | 'decided' | 'pending_enrichment' | 'ready' | 'lookup_needed' | 'error' | 'not_processed';
  source?: PostEvidence;
  verifiedCompany?: { name: string; sourceIds: string[] };
  hiring?: ReturnType<typeof parseHiringDecision>;
  enrichment?: z.infer<typeof companyRouteSchema>;
  duplicateOfSourceId?: string;
  rawDecision?: string; rawEnrichment?: string;
  applicationFollowUpLookup?: ApplicationFollowUpLookup;
}

export interface SourceLookupContext {
  evidencePosts: PostEvidence[];
  // Every discovery/verification model request shares the flow's existing cap.
  requestModel: (request: () => Promise<string>) => Promise<string>;
}

// Transport/retrieval are injected: this module performs no browser work, provider
// requests, scheduling or storage lookup on its own. The cap covers BOTH stages.
export async function runLeadFlow(options: {
  posts: Post[]; contextPosts?: Post[]; storedOpportunityIds?: ReadonlySet<string>;
  maxModelCalls?: number;
  verifiedOpportunityAliases?: readonly VerifiedOpportunityAlias[];
  applicationFollowUps?: {
    posts: Post[];
    // Must verify destination identity/hiring eligibility; link text is untrusted.
    verify: (post: PostEvidence, opportunity: PostEvidence) => Promise<ContactSource[]>;
  };
  classify: (post: Post, context: ReturnType<typeof verifiedContextView>) => Promise<string>;
  loadSources: (source: PostEvidence, context: SourceLookupContext) => Promise<ContactSource[]>;
  enrich: (source: PostEvidence, sources: ContactSource[]) => Promise<string>;
  save: (report: { rows: LeadFlowRow[]; modelCalls: number; stopped: boolean; contractVersion: string; opportunities: HiringOpportunity[] }) => Promise<void>;
}) {
  const cap = options.maxModelCalls ?? 120;
  if (!Number.isInteger(cap) || cap < 0 || cap > 120) throw Error('Model call cap must be 0–120');
  const plan = planOpportunityAssessments(options.posts, options.contextPosts ?? [], options.storedOpportunityIds);
  const aliases = options.verifiedOpportunityAliases ?? [];
  validateOpportunityAliases(aliases, plan.evidencePosts);
  const seen = new Set(options.storedOpportunityIds ?? []);
  const rows: LeadFlowRow[] = [];
  let modelCalls = 0, stopped = false;
  let followUpLookups = 0; // At most six injected destination lookups per batch.
  const save = () => options.save({ rows, modelCalls, stopped, contractVersion: HIRING_DECISION_CONTRACT_VERSION, opportunities: buildOpportunityShortlist(rows, aliases) });
  for (const post of plan.assessments) {
    const row: LeadFlowRow = { postId: post.id, decision: 'review', reason: '', status: 'pending_decision' };
    rows.push(row);
    if (stopped || modelCalls >= cap) {
      row.status = 'not_processed'; row.reason = 'Request budget exhausted or prior provider failure'; await save(); continue;
    }
    if (post.truncated) { row.status = 'lookup_needed'; row.reason = 'Recover incomplete text first'; await save(); continue; }
    let prepared: ReturnType<typeof graphForPost>;
    try { prepared = graphForPost(post, plan.evidencePosts); }
    catch { row.status = 'error'; row.reason = 'Invalid source graph; no model call'; await save(); continue; }
    modelCalls++; await save(); // Reserve before a callback that might consume quota.
    try { row.rawDecision = await options.classify(post, verifiedContextView(prepared.graph)); }
    catch { stopped = true; row.status = 'error'; row.reason = 'Hiring transport failed; no retry'; await save(); continue; }
    try {
      row.hiring = parseHiringDecision(row.rawDecision, prepared.graph);
      row.decision = row.hiring.decision; row.reason = row.hiring.reason; row.status = 'decided';
    } catch { row.status = 'error'; row.reason = 'Invalid hiring decision/source identity'; await save(); continue; }
    if (row.decision !== 'keep') { await save(); continue; }
    const id = row.hiring.subject_source_id!;
    row.source = prepared.sources.get(id)!; // Preserve original text, never a model rewrite.
    if (seen.has(id)) { row.duplicateOfSourceId = id; await save(); continue; }
    seen.add(id);
    if (modelCalls >= cap) { row.status = 'lookup_needed'; row.reason = 'Hiring retained; no budget for enrichment'; await save(); continue; }
    let sources: ContactSource[];
    try {
      const sourceGraph = graphForPost(plan.evidencePosts.find(p => p.id === id) ?? row.source, plan.evidencePosts);
      const available = reachableSources(sourceGraph.graph);
      sources = await options.loadSources(row.source, {
        evidencePosts: [...sourceGraph.sources.values()].filter(p => available.has(p.id)),
        requestModel: async request => {
          if (stopped || modelCalls >= cap) throw Error('Discovery model budget exhausted');
          modelCalls++; await save();
          try { return await request(); }
          catch { stopped = true; throw Error('Discovery transport failed; no retry'); }
        },
      });
      if (options.applicationFollowUps) {
        row.applicationFollowUpLookup = await loadApplicationFollowUps({ source: row.source, ...options.applicationFollowUps, maxLookups: Math.min(3, 6 - followUpLookups) });
        followUpLookups += row.applicationFollowUpLookup.checkedPostIds.length;
        sources = [...sources, ...row.applicationFollowUpLookup.sources];
        // Identical sources can be returned by both base and reply lookup.
        const unique = new Map<string, ContactSource>();
        for (const source of sources) {
          const existing = unique.get(source.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(source)) throw Error('Conflicting contact evidence');
          unique.set(source.id, source);
        }
        sources = [...unique.values()];
      }
    }
    catch { row.status = 'lookup_needed'; row.reason = 'Hiring retained; contact source retrieval failed'; await save(); continue; }
    const identities = sources.filter(s => s.verified_company_name);
    const names = new Set(identities.map(s => s.verified_company_name!));
    if (names.size === 1) row.verifiedCompany = { name: [...names][0]!, sourceIds: identities.map(s => s.id) };
    // Retrieval already established these exact contact destinations. Do not
    // ask a model to rewrite them into another wire response.
    if (row.verifiedCompany || sources.some(s=>s.application_routes?.some(r=>['dm','email'].includes(r.kind)))) {
      const routes = sources.flatMap(source => (source.application_routes ?? [])
        .filter(route => ['careers_page', 'email', 'dm'].includes(route.kind))
        .map(route => ({ ...route, source_id: source.id })));
      const unique = [...new Map(routes.map(route => [`${route.kind}:${route.value}`, route])).values()];
      const answer = { source_post_id: id, company_name: row.verifiedCompany?.name ?? null,
        company_source_ids: row.verifiedCompany?.sourceIds ?? [], application_routes: unique.slice(0, 3),
        needs_lookup: unique.length === 0, reason: 'Contact result assembled by code from trusted retrieval evidence.' };
      row.enrichment = parseCompanyRoute(JSON.stringify(answer), id, sources);
      row.status = answer.needs_lookup ? 'lookup_needed' : 'ready';
      await save(); continue;
    }
    if (modelCalls >= cap || stopped) { row.status = 'lookup_needed'; row.reason = 'Hiring retained; enrichment budget exhausted or discovery transport failed'; await save(); continue; }
    row.status = 'pending_enrichment'; modelCalls++; await save();
    try { row.rawEnrichment = await options.enrich(row.source, sources); }
    catch { stopped = true; row.status = 'lookup_needed'; row.reason = 'Hiring retained; enrichment transport failed, no retry'; await save(); continue; }
    try {
      row.enrichment = parseCompanyRoute(row.rawEnrichment, id, sources);
      row.status = row.enrichment.needs_lookup ? 'lookup_needed' : 'ready';
    } catch { row.status = 'lookup_needed'; row.reason = 'Hiring retained; company/contact output failed validation'; }
    await save();
  }
  await save();
  return { rows, modelCalls, stopped, plan, contractVersion: HIRING_DECISION_CONTRACT_VERSION, opportunities: buildOpportunityShortlist(rows, aliases) };
}
