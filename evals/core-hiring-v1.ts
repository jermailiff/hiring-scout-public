// Frozen validator for the original failed live contract. Do not adapt old scores.
import { z } from 'zod';
import { evidenceGraphSchema, reachableSources } from '../hiring-evidence.js';
import type { EvidenceGraph } from '../hiring-evidence.js';

// Hiring identity is validated independently of optional company/contact enrichment.
export const coreHiringV1Schema = z.object({
  decision: z.enum(['keep', 'skip', 'review']), reason: z.string().min(1).max(700),
  lead_type: z.enum(['own_recruitment', 'shared_opportunity']).nullable(),
  subject_source_id: z.string().nullable(),
}).strict();
export const coreHiringV1JsonSchema = z.toJSONSchema(coreHiringV1Schema);
export function parseCoreHiringV1(raw: string, graph: EvidenceGraph) {
  evidenceGraphSchema.parse(graph);
  const answer = coreHiringV1Schema.parse(JSON.parse(raw));
  if (answer.decision !== 'keep') {
    if (answer.lead_type !== null || answer.subject_source_id !== null) throw Error('Non-keep cannot assert an opportunity');
  } else {
    if (!answer.lead_type || !answer.subject_source_id || !reachableSources(graph).has(answer.subject_source_id)) throw Error('Keep needs a verified available source within two connections');
    if ((answer.lead_type === 'own_recruitment') !== (answer.subject_source_id === graph.target_id)) throw Error('Opportunity identity disagrees with recruitment type');
  }
  return answer;
}

