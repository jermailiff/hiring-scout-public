import { z } from 'zod';

export const evidenceGraphSchema = z.object({
  target_id: z.string().min(1),
  posts: z.array(z.object({ id: z.string().min(1), author: z.string().min(1), text: z.string(),
    url: z.string().url().nullable() }).strict()).min(1),
  connections: z.array(z.object({ from_id: z.string(), to_id: z.string(),
    relationship: z.enum(['direct_reply', 'quoted_post']), verified: z.boolean() }).strict()),
}).strict().superRefine((graph, ctx) => {
  const ids = graph.posts.map(p => p.id);
  if (new Set(ids).size !== ids.length || !ids.includes(graph.target_id)) {
    ctx.addIssue({ code: 'custom', message: 'Post IDs must be unique and include the target' });
  }
});
export type EvidenceGraph = z.infer<typeof evidenceGraphSchema>;
const citation = z.object({ source_id: z.string(), quote: z.string().min(1) }).strict();
const sourceAnswerSchema = z.object({
  decision: z.enum(['keep', 'skip', 'review']), reason: z.string().min(1).max(700),
  target_evidence: citation.nullable(), context_evidence: z.array(citation).max(2),
  lead_type: z.enum(['own_recruitment', 'shared_opportunity']).nullable(),
  subject_source_id: z.string().nullable(),
  company: z.string().nullable(), role: z.string().nullable(), location: z.string().nullable(),
  needs_context: z.boolean(),
}).strict();

// Derive the provider's structural contract from the same schema used locally.
// Source reachability, exact quotations and semantic support remain separate checks.
export const sourceAnswerJsonSchema = z.toJSONSchema(sourceAnswerSchema);

// Only verified, available paths count; thread proximity never supplies an edge.
export function reachableSources(graph: EvidenceGraph): Map<string, number> {
  const available = new Set(graph.posts.map(p => p.id));
  const distance = new Map([[graph.target_id, 0]]);
  for (let depth = 0; depth < 2; depth++) {
    for (const edge of graph.connections) {
      if (edge.verified && distance.get(edge.from_id) === depth && available.has(edge.to_id)
        && !distance.has(edge.to_id)) distance.set(edge.to_id, depth + 1);
    }
  }
  return distance;
}

// Resolve structure only. Never label employment, choose an employer or infer an edge.
export function verifiedContextView(graph: EvidenceGraph) {
  evidenceGraphSchema.parse(graph);
  const posts = new Map(graph.posts.map(p => [p.id, p]));
  const paths = new Map<string, EvidenceGraph['connections']>([[graph.target_id, []]]);
  const blocked: { from_id: string; to_id: string; reason: string }[] = [];
  for (let depth = 0; depth <= 2; depth++) {
    for (const edge of graph.connections) {
      const path = paths.get(edge.from_id);
      if (!path || path.length !== depth) continue;
      const reason = !edge.verified ? 'unverified_connection' : !posts.has(edge.to_id)
        ? 'source_text_unavailable' : depth === 2 ? 'beyond_two_connections' : null;
      if (reason) { blocked.push({ from_id: edge.from_id, to_id: edge.to_id, reason }); continue; }
      if (!paths.has(edge.to_id)) paths.set(edge.to_id, [...path, edge]);
    }
  }
  return { target: posts.get(graph.target_id)!, verified_context: [...paths.entries()]
    .filter(([id]) => id !== graph.target_id).map(([id, path]) => ({
      distance: path.length, path, post: posts.get(id)!,
    })), blocked_connections: blocked };
}

export function parseSourceAnswer(raw: string, graph: EvidenceGraph) {
  evidenceGraphSchema.parse(graph);
  const result = sourceAnswerSchema.parse(JSON.parse(raw));
  const posts = new Map(graph.posts.map(p => [p.id, p]));
  const reachable = reachableSources(graph);
  const check = (item: z.infer<typeof citation>) => {
    const source = posts.get(item.source_id);
    if (!source || !reachable.has(item.source_id)) throw new Error('Citation source is unavailable, unverified or beyond two steps');
    if (!source.text.includes(item.quote)) throw new Error('Quote does not match its declared author/source');
  };
  if (result.target_evidence) {
    if (result.target_evidence.source_id !== graph.target_id) throw new Error('Target evidence must cite the target');
    check(result.target_evidence);
  }
  for (const item of result.context_evidence) {
    if (item.source_id === graph.target_id) throw new Error('Context evidence must cite another post');
    check(item);
  }
  if (result.decision === 'keep') {
    if (!result.target_evidence || !result.lead_type || !result.subject_source_id) throw new Error('Keep requires target evidence and a lead subject');
    if (result.lead_type === 'own_recruitment' && result.subject_source_id !== graph.target_id) {
      throw new Error('Own recruitment belongs to the target author');
    }
    if (result.lead_type === 'shared_opportunity') {
      if (result.subject_source_id === graph.target_id || !reachable.has(result.subject_source_id)
        || !result.context_evidence.some(item => item.source_id === result.subject_source_id)) {
        throw new Error('Shared opportunity requires a verified reachable recruiting source and evidence');
      }
    }
    const subject = posts.get(result.subject_source_id);
    if (!subject || !reachable.has(subject.id)) throw new Error('Unknown lead subject');
    // Conservative fixture contract: never inherit another author's role/company/location.
    for (const field of ['company', 'role', 'location'] as const) {
      if (result[field] !== null && !subject.text.toLowerCase().includes(result[field].toLowerCase())) {
        throw new Error('Extracted detail is not explicit in the lead subject text');
      }
    }
  } else if (result.lead_type !== null || result.subject_source_id !== null) {
    throw new Error('Non-keeps must not assert a lead subject');
  }
  return result;
}

// No company guessing: own recruitment retains its own post identity. A mere
// quote/share can point to the original opportunity and collapse that duplicate.
export function sourceLeadKey(answer: ReturnType<typeof parseSourceAnswer>) {
  return answer.decision === 'keep' ? answer.subject_source_id : null;
}

// Eval-only delivery decision. The caller supplies known opportunity source IDs;
// this neither reads a production store nor treats a company match as a duplicate.
export function opportunityDisposition(answer: ReturnType<typeof parseSourceAnswer>, storedSourceIds: ReadonlySet<string>) {
  const key = sourceLeadKey(answer);
  return { decision: answer.decision, leadKey: key,
    delivery: key === null ? 'not_a_kept_lead' : storedSourceIds.has(key) ? 'duplicate' : 'new_opportunity' };
}
