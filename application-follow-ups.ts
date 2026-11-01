import type { Post, PostEvidence } from './x-posts.js';
import type { ContactSource } from './lead-contracts.js';
import { graphForPost } from './hiring-pipeline.js';
import { reachableSources } from './hiring-evidence.js';
import { hasHiringClue } from './hiring-context.js';

export interface ApplicationFollowUpLookup {
  sources: ContactSource[];
  checkedPostIds: string[];
  failedPostIds: string[];
  deferredPostIds: string[];
}

// Read supplied captures only. A quoted employer can supply its own follow-up;
// an unrelated author in the same thread cannot. Never infer edges from ordering.
export async function loadApplicationFollowUps(options: {
  source: PostEvidence;
  posts: Post[];
  maxLookups?: number;
  verify: (post: PostEvidence, opportunity: PostEvidence) => Promise<ContactSource[]>;
}): Promise<ApplicationFollowUpLookup> {
  const cap = options.maxLookups ?? 3;
  if (!Number.isInteger(cap) || cap < 0 || cap > 3) throw Error('Follow-up cap must be 0–3');
  if (options.posts.length > 240) throw Error('At most 240 captured contact posts');
  const byId = new Map<string, Post>();
  for (const post of options.posts) {
    const prior = byId.get(post.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(post)) throw Error('Conflicting contact post identity');
    byId.set(post.id, post);
  }
  const captured = byId.get(options.source.id);
  if (captured && (captured.text !== options.source.text || captured.author !== options.source.author || captured.url !== options.source.url)) {
    throw Error('Conflicting opportunity source identity');
  }
  const root = captured ?? options.source;
  const { graph, sources } = graphForPost(root, [...byId.values()]);
  // Follow quote paths only: a parent from another company's hiring exchange is
  // not evidence that its application route belongs to this opportunity.
  const anchors = new Set([root.id]);
  for (let depth = 0; depth < 2; depth++) {
    for (const edge of graph.connections) {
      if (edge.relationship === 'quoted_post' && edge.verified && anchors.has(edge.from_id)
        && reachableSources(graph).has(edge.to_id) && sources.has(edge.to_id)
        && hasHiringClue(sources.get(edge.to_id)!)) anchors.add(edge.to_id);
    }
  }
  const candidates = new Map<string, Post>();
  for (const anchorId of anchors) {
    const anchor = sources.get(anchorId)!;
    let parents = new Set([anchorId]);
    for (let depth = 0; depth < 2; depth++) {
      const next = new Set<string>();
      for (const post of byId.values()) {
        if (post.truncated || post.author.toLowerCase() !== anchor.author.toLowerCase()
          || !post.replyTo?.verified || !parents.has(post.replyTo.postId)) continue;
        // Reuse source permalink/identity checks rather than accepting arbitrary URLs.
        const prepared = graphForPost(post, [...byId.values(), anchor]);
        if (!reachableSources(prepared.graph).has(post.replyTo.postId)
          || !validPermalink(post)) continue;
        next.add(post.id);
        if (post.id !== root.id && !anchors.has(post.id) && post.links.length
          && /\b(?:apply|application|careers?|jobs?|refer)\b/i.test(post.text)) candidates.set(post.id, post);
      }
      parents = next;
    }
  }
  const result: ApplicationFollowUpLookup = { sources: [], checkedPostIds: [], failedPostIds: [], deferredPostIds: [] };
  for (const post of candidates.values()) {
    if (result.checkedPostIds.length >= cap) { result.deferredPostIds.push(post.id); continue; }
    result.checkedPostIds.push(post.id); // Reserve before any injected retrieval.
    try { result.sources.push(...await options.verify(post, options.source)); }
    catch { result.failedPostIds.push(post.id); } // Keep the opportunity; no retry.
  }
  return result;
}

function validPermalink(post: PostEvidence): boolean {
  try {
    const url = new URL(post.url);
    return url.protocol === 'https:' && ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash
      && url.pathname === `/${post.author}/status/${post.id}`;
  } catch { return false; }
}
