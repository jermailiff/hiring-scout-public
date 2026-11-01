import { z } from 'zod';
import { evidenceGraphSchema, reachableSources } from './hiring-evidence.js';
import type { EvidenceGraph } from './hiring-evidence.js';

export const HIRING_DECISION_CONTRACT_VERSION = 'code-owned-source-v2';
const reason = z.string().min(1).max(700);
// The model selects a context source only for shared opportunities. Own source
// identity is a deterministic application mapping, not a model extraction task.
export const hiringDecisionSchema = z.discriminatedUnion('lead_type', [
  z.object({ decision: z.literal('keep'), reason, lead_type: z.literal('own_recruitment'), shared_source_id: z.null() }).strict(),
  z.object({ decision: z.literal('keep'), reason, lead_type: z.literal('shared_opportunity'), shared_source_id: z.string().min(1) }).strict(),
  z.object({ decision: z.enum(['skip', 'review']), reason, lead_type: z.null(), shared_source_id: z.null() }).strict(),
]);
export const hiringDecisionJsonSchema = z.toJSONSchema(hiringDecisionSchema);
export function parseHiringDecision(raw: string, graph: EvidenceGraph) {
  evidenceGraphSchema.parse(graph);
  const answer = hiringDecisionSchema.parse(JSON.parse(raw));
  const shared = answer.lead_type === 'shared_opportunity';
  const source = answer.lead_type === 'own_recruitment' ? graph.target_id
    : shared ? answer.shared_source_id : null;
  if (shared && (source === graph.target_id || !reachableSources(graph).has(source!))) {
    throw Error('Shared opportunity needs another verified available source within two connections');
  }
  return { decision: answer.decision, reason: answer.reason, lead_type: answer.lead_type,
    subject_source_id: source,
    source_resolution: answer.lead_type === 'own_recruitment' ? 'target_from_code' as const
      : shared ? 'verified_model_selection' as const : 'none' as const };
}

const kind = z.enum(['careers_page', 'job_page', 'email', 'dm', 'contact_page']);
const route = z.object({ kind, value: z.string().min(1), source_id: z.string().min(1) }).strict();
export const companyRouteSchema = z.object({
  source_post_id: z.string(), company_name: z.string().nullable(),
  company_source_ids: z.array(z.string()), application_routes: z.array(route).max(3),
  needs_lookup: z.boolean(), reason: z.string().min(1).max(500),
}).strict();
export type ContactSource = {
  id: string; url: string; text: string;
  // Trusted retrieval identity metadata, never supplied by the model.
  verified_company_name?: string;
  retrieval_method?: 'http' | 'browser_rendered';
  // Trusted retrieval/capture metadata, not claims parsed from arbitrary post text.
  // A value is eligible only if explicitly offered for hiring or verified as an
  // application destination. A sales link must not be marked eligible here.
  application_routes?: { kind: z.infer<typeof kind>; value: string }[];
};
export function parseCompanyRoute(raw: string, postId: string, sources: ContactSource[]) {
  const answer = companyRouteSchema.parse(JSON.parse(raw));
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw Error('Ambiguous contact source IDs');
  const byId = new Map(sources.map(s => [s.id, s]));
  if (answer.source_post_id !== postId) throw Error('Enrichment belongs to another opportunity');
  if (answer.company_source_ids.some(id => !byId.has(id))) throw Error('Unknown employer citation');
  if ((answer.company_name === null) !== (answer.company_source_ids.length === 0)) throw Error('Employer name and citations disagree');
  const verifiedNames = new Set(sources.flatMap(s => s.verified_company_name ? [s.verified_company_name] : []));
  if (verifiedNames.size > 1 || (verifiedNames.size && answer.company_name !== [...verifiedNames][0])) throw Error('Company disagrees with verified identity');
  const keys = new Set<string>();
  for (const entry of answer.application_routes) {
    const source = byId.get(entry.source_id);
    if (!source?.application_routes?.some(r => r.kind === entry.kind && r.value === entry.value)) throw Error('Contact route is not offered by its cited source');
    const key = `${entry.kind}:${entry.value}`;
    if (keys.has(key)) throw Error('Repeated application route');
    keys.add(key);
    if (['careers_page', 'job_page', 'contact_page'].includes(entry.kind)) {
      const url = new URL(entry.value);
      if (url.protocol !== 'https:' || url.username || url.password) throw Error('Unsafe application URL');
    }
  }
  if (!answer.application_routes.length && !answer.needs_lookup) throw Error('Missing route requires lookup');
  // Source IDs establish provenance, not semantic truth of an employer alias or
  // contact eligibility. Retrieval quality and those claims still need evaluation.
  return answer;
}
