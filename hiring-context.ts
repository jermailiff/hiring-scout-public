import type { Post, PostEvidence, PostReference } from "./x-posts.js";
import { hiringSignals } from "./x-posts.js";

// Retrieval clues only. A model/human still decides whether this is recruitment.
export function hasHiringClue(post: Pick<PostEvidence, "text" | "links">): boolean {
  return hiringSignals(post).length > 0
    || /\b(?:hir(?:e[ds]?|ing)|recruit\w*)\b|\b(?:come\s+)?work\s+with\b|\bassembl\w*\s+(?:a|our|the|my)\s+team\b|\bjoin\s+as\b/i.test(post.text);
}

export function hiringContextTarget(post: Post): PostReference | null {
  const references = (post.references ?? []).filter(ref => ref.url !== post.url);
  const hiringQuote = references.find(ref => ref.relationship === "quoted_post"
    && ref.post && hasHiringClue(ref.post));
  if (hiringQuote) return hiringQuote;
  // No general expansion of links, networking invitations or product news.
  const mentionsReference = /\b(?:this|that|original|earlier|previous|above|below)\s+(?:tweet|post)\b/i.test(post.text);
  if (!hasHiringClue(post)) return null;
  if (references.length) return references[0]!;
  return mentionsReference ? { url: null, relationship: "referenced_post" } : null;
}

export type ContextLookup = (url: string) => Promise<
  { status: "resolved"; post: PostEvidence }
  | { status: "unavailable" | "budget_skipped" }
>;

function safeReferenceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.origin === "https://x.com" && !parsed.username && !parsed.password
      && !parsed.search && !parsed.hash && /^\/\w+\/status\/\d+$/.test(parsed.pathname);
  } catch { return false; }
}

export async function resolveHiringContext(post: Post, lookup: ContextLookup): Promise<Post> {
  const target = hiringContextTarget(post);
  if (!target) return post;
  if (target.url && !safeReferenceUrl(target.url)) return { ...post, hiringContext: {
    status: "unavailable", relationship: target.relationship, referenceUrl: target.url } };
  if (target.post && !target.post.truncated && target.post.url === target.url
    && target.post.id !== post.id) {
    return { ...post, hiringContext: { status: "resolved", relationship: target.relationship,
      referenceUrl: target.url, source: target.post } };
  }
  if (!target.url) return { ...post, hiringContext: { status: "unavailable",
    relationship: target.relationship, referenceUrl: null } };
  const result = await lookup(target.url); // One lookup only; never follow the source's references.
  if (result.status !== "resolved") return { ...post, hiringContext: {
    status: result.status, relationship: target.relationship, referenceUrl: target.url } };
  if (result.post.truncated || result.post.url !== target.url || result.post.id === post.id) {
    return { ...post, hiringContext: { status: "unavailable",
      relationship: target.relationship, referenceUrl: target.url } };
  }
  // Whitelist fields so a loaded Post cannot carry a second-level reference chain.
  const { id, url, author, authorLabel, text, postedAt, truncated, links } = result.post;
  return { ...post, hiringContext: { status: "resolved", relationship: target.relationship,
    referenceUrl: target.url, source: { id, url, author, authorLabel, text, postedAt, truncated, links } } };
}

export function contextNeedsReview(post: Post): boolean {
  return hiringContextTarget(post) !== null && post.hiringContext?.status !== "resolved";
}

export function evidenceSource(post: Post, sourceUrl?: string | null): PostEvidence {
  const context = post.hiringContext;
  if (!sourceUrl || sourceUrl === post.url) return post;
  if (context?.status === "resolved" && context.source.url === sourceUrl) return context.source;
  throw new Error("Evidence source is not the post or its resolved reference");
}

export interface LeadRow {
  postId: string;
  decision: string;
  evidenceSource?: { id: string };
  duplicateOfPostId?: string;
}

// Prefer the source post if it is itself a keep; otherwise retain the first discovery.
export function markDuplicateLeads(rows: LeadRow[]): void {
  const canonical = new Map<string, string>();
  for (const row of rows) {
    delete row.duplicateOfPostId;
    if (row.decision !== "keep") continue;
    const id = row.evidenceSource?.id ?? row.postId;
    if (!canonical.has(id) || row.postId === id) canonical.set(id, row.postId);
  }
  for (const row of rows) {
    if (row.decision !== "keep") continue;
    const first = canonical.get(row.evidenceSource?.id ?? row.postId)!;
    if (first !== row.postId) row.duplicateOfPostId = first;
  }
}
