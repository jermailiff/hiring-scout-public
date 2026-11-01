import { z } from "zod";
import { contextNeedsReview, evidenceSource } from "./hiring-context.js";
import type { Post } from "./x-posts.js";

export const classificationSchema = z.object({
  decision: z.enum(["keep", "review", "skip"]),
  reason: z.string().min(1).max(700),
  evidence: z.string().min(1).max(1000).nullable(),
  company: z.string().min(1).max(200).nullable(),
  role: z.string().min(1).max(250).nullable(),
  location: z.string().min(1).max(250).nullable(),
  author_type: z.enum(["individual", "company", "unknown"]),
  needs_context: z.boolean(),
  evidence_source_url: z.string().url().nullable().optional(),
}).strict();

export function parseClassification(text: string, postText: string, post?: Post) {
  const result = classificationSchema.parse(JSON.parse(text));
  const source = post ? evidenceSource(post, result.evidence_source_url) : null;
  if (!post && result.evidence_source_url) throw new Error("Evidence source cannot be checked without a post");
  const sourceText = source?.text ?? postText;
  if (result.evidence !== null && !sourceText.includes(result.evidence)) {
    // Permit whitespace-only differences, then restore the actual source quote.
    // Never repair changed words, punctuation, or invented evidence.
    const escaped = result.evidence.trim().split(/\s+/)
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const sourceQuote = sourceText.match(new RegExp(escaped))?.[0];
    if (!sourceQuote) throw new Error("Evidence is not a quote from the post");
    result.evidence = sourceQuote;
  }
  if (result.decision === "keep" && result.evidence === null) {
    throw new Error("A keep decision must cite evidence");
  }
  return result;
}

export function applyClassification(post: Post, parsed: ReturnType<typeof parseClassification>) {
  const source = evidenceSource(post, parsed.evidence_source_url);
  const missingContext = contextNeedsReview(post);
  const guarded = parsed.decision === "skip" && (post.truncated || missingContext);
  return { ...parsed,
    ...(guarded ? { modelDecision: "skip", decision: "review" as const,
      needs_context: true,
      reason: (missingContext ? "Missing hiring context; cannot safely discard this post. Model assessment: "
        : "Text is incomplete; cannot safely discard this post. Model assessment: ") + parsed.reason } : {}),
    ...(parsed.decision === "keep" ? { evidenceSource: { id: source.id, url: source.url,
      author: source.author, postedAt: source.postedAt, evidence: parsed.evidence,
      relationship: source.id === post.id ? "own_post" : post.hiringContext?.relationship,
      discoveredVia: post.url, currentAvailabilityVerified: false } } : {}),
  };
}
