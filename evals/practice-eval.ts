import { z } from "zod";
import { evidenceGraphSchema, verifiedContextView } from "./source-evidence.js";

const decision = z.enum(["keep", "skip", "review"]);
export type Decision = z.infer<typeof decision>;
export const suiteSchema = z.object({
  suiteId: z.string().min(1),
  qualification: z.string().min(1),
  cases: z.array(z.object({
    id: z.string().min(1),
    input: z.object({
      evidence_graph: evidenceGraphSchema.optional(),
      text: z.string(),
      links: z.array(z.object({ url: z.string(), label: z.string(), expandedUrl: z.string().nullable().optional() }).strict()),
      author_type: z.enum(["individual", "company", "unknown"]),
      input_incomplete: z.boolean(),
      thread_opening: z.object({ text: z.string(), relationship: z.literal("observed_in_conversation_not_verified_direct_reply") }).strict().optional(),
      context: z.object({ text: z.string(), relationship: z.enum([
        "observed_in_conversation_not_verified_direct_reply", "verified_direct_reply_to_parent",
      ]) }).strict().nullable(),
      hiring_reference: z.discriminatedUnion("status", [
        z.object({ status: z.literal("unavailable"),
          relationship: z.literal("quoted_post"), referenceUrl: z.string().nullable() }).strict(),
        z.object({ status: z.literal("resolved"), relationship: z.literal("quoted_post"),
          referenceUrl: z.string().url(), source: z.object({
            id: z.string(), url: z.string().url(), author: z.string(), authorLabel: z.string(),
            text: z.string(), postedAt: z.string(), truncated: z.literal(false),
            links: z.array(z.object({ url: z.string(), label: z.string() }).strict()),
          }).strict() }).strict(),
      ]).nullable(),
    }).strict(),
    expected: z.object({ decision, reason: z.string().min(1),
      attribution: z.object({
        lead_type: z.enum(['own_recruitment', 'shared_opportunity']).nullable(),
        subject_source_id: z.string().nullable(),
        company: z.string().nullable(),
      }).strict().optional(),
    }).strict(),
  }).strict()).min(1),
}).strict();
export type PracticeSuite = z.infer<typeof suiteSchema>;

export function parseSuite(value: unknown): PracticeSuite {
  const suite = suiteSchema.parse(value);
  if (new Set(suite.cases.map(c => c.id)).size !== suite.cases.length) throw new Error("Duplicate case IDs");
  return suite;
}

// Only the input reaches a future model call. Labels and rationales stay in the evaluator.
export function buildMessages(prompt: string, example: PracticeSuite["cases"][number], representation: 'graph' | 'verified-context' = 'graph') {
  return [{ role: "system" as const, content: prompt },
    { role: "user" as const, content: JSON.stringify(example.input.evidence_graph
      ? representation === 'verified-context' ? verifiedContextView(example.input.evidence_graph) : example.input.evidence_graph
      : example.input) }];
}

// Score human-labeled opportunity identity separately from the hiring decision.
// Pass only validated outputs. Missing/invalid outputs stay in the denominator.
export function scoreAttributions(suite: PracticeSuite, predictions: {
  caseId: string; attribution?: { lead_type: string | null; subject_source_id: string | null; company: string | null };
}[]) {
  const ids = new Set(suite.cases.map(c => c.id));
  const byId = new Map<string, typeof predictions[number]>();
  for (const row of predictions) {
    if (!ids.has(row.caseId) || byId.has(row.caseId)) throw new Error('Unknown or duplicate attribution case');
    byId.set(row.caseId, row);
  }
  const labeled = suite.cases.filter(c => c.expected.attribution !== undefined);
  const rows = labeled.map(c => {
    const actual = byId.get(c.id)?.attribution;
    const expected = c.expected.attribution!;
    return { caseId: c.id, present: actual !== undefined, correct: actual !== undefined &&
      actual.lead_type === expected.lead_type && actual.subject_source_id === expected.subject_source_id &&
      actual.company === expected.company };
  });
  return { total: rows.length, correct: rows.filter(r => r.correct).length,
    missing: rows.filter(r => !r.present).length, cases: rows };
}

// No provider access here. Score already obtained decisions; never call a model to grade labels.
export function scoreDecisions(suite: PracticeSuite, predictions: { caseId: string; decision: Decision }[]) {
  const ids = new Set(suite.cases.map(c => c.id));
  const byId = new Map<string, Decision>();
  for (const row of predictions) {
    if (!ids.has(row.caseId)) throw new Error(`Unknown prediction case: ${row.caseId}`);
    if (byId.has(row.caseId)) throw new Error(`Duplicate prediction: ${row.caseId}`);
    byId.set(row.caseId, decision.parse(row.decision));
  }
  const confusion = {
    keep: { keep: 0, skip: 0, review: 0, missing: 0 },
    skip: { keep: 0, skip: 0, review: 0, missing: 0 },
    review: { keep: 0, skip: 0, review: 0, missing: 0 },
  };
  for (const c of suite.cases) confusion[c.expected.decision][byId.get(c.id) ?? "missing"]++;
  const count = predictions.length;
  const total = suite.cases.length;
  const correct = confusion.keep.keep + confusion.skip.skip + confusion.review.review;
  const reviews = confusion.keep.review + confusion.skip.review + confusion.review.review;
  return {
    qualification: suite.qualification,
    total, predicted: count, missing: total - count, correct, exactAgreement: correct / total,
    missedLeads: confusion.keep.skip,
    leadsDeferredToReview: confusion.keep.review,
    falseAlarms: confusion.skip.keep,
    uncertainCasesAutoKept: confusion.review.keep,
    uncertainCasesAutoSkipped: confusion.review.skip,
    unnecessaryReviews: confusion.skip.review + confusion.keep.review,
    reviewRate: reviews / total,
    confusion, // Rows = expected; columns = actual. Missing responses stay visible.
  };
}
