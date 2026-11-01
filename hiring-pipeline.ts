import { evidenceGraphSchema, verifiedContextView, parseSourceAnswer, sourceAnswerJsonSchema } from './hiring-evidence.js';
import type { EvidenceGraph } from './hiring-evidence.js';
import type { Post, PostEvidence } from './x-posts.js';
import { hiringSignals } from './x-posts.js';
import { reachableSources } from './hiring-evidence.js';
import { markDuplicateLeads } from './hiring-context.js';

export const HIRING_PIPELINE_VERSION = 'verified-context-parent-discovery-v2';
export const HIRING_MODEL = '@cf/google/gemma-4-26b-a4b-it';

// Only supplied, identified quotes and explicit reply metadata establish edges.
// Ordinary links, resolved historical references and discoveredInThread do not.
export function graphForPost(target: Post, batch: Post[]): { graph: EvidenceGraph; sources: Map<string, PostEvidence> } {
  const sources = new Map<string, PostEvidence>();
  const graph: EvidenceGraph = { target_id: target.id, posts: [], connections: [] };
  const visited = new Map<string, number>();
  const add = (post: PostEvidence) => {
    const existing = sources.get(post.id);
    if (existing && (existing.text !== post.text || existing.author !== post.author || existing.url !== post.url)) {
      throw new Error('Conflicting source identity');
    }
    sources.set(post.id, post);
  };
  const identified = (post: PostEvidence): boolean => {
    try {
      const url = new URL(post.url);
      return url.protocol === 'https:' && ['x.com', 'twitter.com', 'www.x.com', 'www.twitter.com'].includes(url.hostname)
        && url.pathname === `/${post.author}/status/${post.id}` && !url.search && !url.hash;
    } catch { return false; }
  };
  const walk = (post: Post, depth: number) => {
    add(post);
    if ((visited.get(post.id) ?? Infinity) <= depth || depth > 2) return;
    visited.set(post.id, depth);
    const connect = (id: string, relationship: 'direct_reply' | 'quoted_post', verified: boolean, source?: PostEvidence) => {
      graph.connections.push({ from_id: post.id, to_id: id, relationship, verified });
      if (verified && source && !source.truncated && identified(source)) {
        add(source);
        // Preserve further source relationships only from a matching captured post.
        const captured = batch.find(p => p.id === source.id && p.text === source.text && p.url === source.url && p.author === source.author);
        if (depth < 2 && captured) walk(captured, depth + 1);
      }
    };
    if (post.replyTo) {
      const parent = batch.find(p => p.id === post.replyTo!.postId);
      connect(post.replyTo.postId, 'direct_reply', post.replyTo.verified, parent);
    }
    const refs = (post.references ?? []).filter(r => r.relationship === 'quoted_post');
    const resolved = post.hiringContext?.status === 'resolved' && post.hiringContext.relationship === 'quoted_post'
      ? post.hiringContext : null;
    if (resolved && !refs.some(r => r.url === resolved.source.url)) {
      refs.push({ relationship: 'quoted_post', url: resolved.referenceUrl, post: resolved.source });
    }
    for (const [i, ref] of refs.entries()) {
      const source = resolved && resolved.referenceUrl === ref.url ? resolved.source : ref.post;
      const valid = source && source.id !== post.id && source.url === ref.url && identified(source);
      connect(valid ? source.id : `unavailable-quote:${post.id}:${i}`, 'quoted_post', true, valid ? source : undefined);
    }
  };
  walk(target, 0);
  graph.posts = [...sources.values()].filter(p => p.id === target.id || !p.truncated).map(p => ({
    id: p.id, author: p.author || 'unknown', text: p.text, url: p.url || null,
  }));
  return { graph: evidenceGraphSchema.parse(graph), sources };
}

// A context source is a separate assessment candidate, never evidence that the
// discovery author is recruiting. No navigation, inference or registry writes.
export function planOpportunityAssessments(discoveries: Post[], contextPosts: Post[] = [],
  storedOpportunityIds: ReadonlySet<string> = new Set()) {
  if (discoveries.length > 120 || contextPosts.length > 120
    || new Set(discoveries.map(p => p.id)).size !== discoveries.length) {
    throw new Error('Batch must contain at most 120 unique posts and 120 context posts');
  }
  const evidence = new Map<string, Post>();
  for (const p of [...discoveries, ...contextPosts]) {
    const existing = evidence.get(p.id);
    if (existing && (existing.text !== p.text || existing.url !== p.url || existing.author !== p.author)) {
      throw new Error('Conflicting captured source identity');
    }
    evidence.set(p.id, existing ?? p);
  }
  const assessments = new Map(discoveries.map(p => [p.id, p]));
  const addedSourceIds: string[] = [], deferredSourceIds: string[] = [], alreadyStoredSourceIds: string[] = [];
  // Only original discoveries seed traversal. Added candidates never extend the
  // two-connection search or trigger recursive harvesting.
  for (const discovery of discoveries) {
    let prepared: ReturnType<typeof graphForPost>;
    try { prepared = graphForPost(discovery, [...evidence.values()]); }
    catch { continue; } // The classifier records invalid discovery inputs separately.
    for (const [id, distance] of reachableSources(prepared.graph)) {
      if (!distance || assessments.has(id)) continue;
      const source = prepared.sources.get(id)!;
      if (source.truncated || !hiringSignals(source).length) continue;
      if (storedOpportunityIds.has(id)) { alreadyStoredSourceIds.push(id); continue; }
      if (assessments.size >= 120) { deferredSourceIds.push(id); continue; }
      // Preserve relationships only from the matching captured source, as the
      // graph adapter does. Inline quote evidence otherwise remains a leaf.
      assessments.set(id, evidence.get(id) ?? source);
      evidence.set(id, evidence.get(id) ?? source);
      addedSourceIds.push(id);
    }
  }
  return { assessments: [...assessments.values()], evidencePosts: [...evidence.values()],
    addedSourceIds, deferredSourceIds: [...new Set(deferredSourceIds)], alreadyStoredSourceIds: [...new Set(alreadyStoredSourceIds)] };
}

export function preparePostRequest(post: Post, batch: Post[], prompt: string) {
  const { graph, sources } = graphForPost(post, batch);
  const request = { model: HIRING_MODEL, messages: [
    { role: 'system', content: prompt },
    { role: 'user', content: JSON.stringify(verifiedContextView(graph)) },
  ], temperature: 0, max_completion_tokens: 1024, stream: false, store: false,
  response_format: { type: 'json_schema', json_schema: {
    name: 'hiring_source_answer', strict: true, schema: sourceAnswerJsonSchema,
  } }, chat_template_kwargs: { enable_thinking: false } };
  if (Buffer.byteLength(JSON.stringify(request), 'utf8') > 12_000) throw new Error('Request exceeds the fixed input budget');
  return { graph, sources, request };
}

export interface HiringResult {
  postId: string; url: string; author: string; text: string; inputIncomplete: boolean;
  status: 'reserved' | 'classified' | 'error' | 'not_processed';
  decision: 'keep' | 'skip' | 'review'; reason: string;
  attribution?: ReturnType<typeof parseSourceAnswer>;
  evidenceSource?: { id: string; url: string; author: string; postedAt: string | null;
    evidence: string | null; currentAvailabilityVerified: false };
  delivery?: 'new_opportunity' | 'duplicate' | 'not_a_kept_lead';
  duplicateOfPostId?: string; rawOutput?: string; usage?: unknown; latencyMs?: number;
}

// Injectable transport and persistence let tests exercise the application path
// without launching Wrangler, opening a browser or calling an AI provider.
export async function classifyCapturedBatch(options: {
  posts: Post[]; contextPosts?: Post[]; storedOpportunityIds?: ReadonlySet<string>; prompt: string; previous?: HiringResult[];
  fetcher: typeof fetch; save: (rows: HiringResult[]) => Promise<void>;
}) {
  const { prompt, fetcher, save } = options;
  const storedIds = options.storedOpportunityIds ?? new Set<string>();
  const plan = planOpportunityAssessments(options.posts, options.contextPosts ?? [], storedIds);
  const posts = plan.assessments;
  const results = [...(options.previous ?? [])];
  if (results.some(r => r.status !== 'classified') || new Set(results.map(r => r.postId)).size !== results.length
    || results.some(r => !posts.some(p => p.id === r.postId))) throw new Error('Prior partial or mismatched run requires explicit review');
  const completed = new Set(results.map(r => r.postId));
  let stopped = false;
  const persist = async () => {
    markDuplicateLeads(results);
    for (const row of results) row.delivery = row.decision !== 'keep' ? 'not_a_kept_lead'
      : row.duplicateOfPostId || storedIds.has(row.evidenceSource?.id ?? row.postId) ? 'duplicate' : 'new_opportunity';
    await save(results);
  };
  for (const post of posts) {
    if (completed.has(post.id)) continue;
    const row: HiringResult = { postId: post.id, url: post.url, author: post.author, text: post.text,
      inputIncomplete: post.truncated, status: 'reserved', decision: 'review', reason: 'Awaiting classification' };
    results.push(row);
    if (stopped) {
      row.status = 'not_processed'; row.reason = 'Previous provider request failed; no automatic retry';
      await persist(); continue;
    }
    if (post.truncated) {
      row.status = 'classified'; row.reason = 'Text is incomplete; recover it before classification';
      await persist(); continue;
    }
    let prepared: ReturnType<typeof preparePostRequest>;
    try { prepared = preparePostRequest(post, plan.evidencePosts, prompt); }
    catch { row.status = 'error'; row.reason = 'Input graph or request budget validation failed; no call made'; await persist(); continue; }
    await persist(); // Reserve before a network call that may consume quota.
    const started = Date.now();
    let raw: string;
    try {
      const response = await fetcher('http://127.0.0.1:8791', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(prepared.request),
        signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error('Provider bridge failure');
      const body = await response.text();
      if (Buffer.byteLength(body, 'utf8') > 100_000) throw new Error('Oversized response');
      const envelope = JSON.parse(body);
      if (envelope.success === false || envelope.error) throw new Error('Provider returned an error');
      const payload = envelope.result ?? envelope, choice = payload.choices?.[0];
      row.usage = payload.usage ?? null;
      raw = choice?.message?.content ?? payload.response;
      if (typeof raw !== 'string') throw new Error('No text response');
      row.rawOutput = raw;
      if (choice?.finish_reason === 'length') throw new Error('Truncated model response');
    } catch {
      stopped = true; row.status = 'error'; row.reason = 'Provider/authentication/network response failure; no retry or fallback';
      row.latencyMs = Date.now() - started; await persist(); continue;
    }
    try {
      const answer = parseSourceAnswer(raw, prepared.graph);
      row.attribution = answer; row.decision = answer.decision; row.reason = answer.reason; row.status = 'classified';
      if (answer.decision === 'keep') {
        const source = prepared.sources.get(answer.subject_source_id!)!;
        const evidence = source.id === post.id ? answer.target_evidence?.quote
          : answer.context_evidence.find(c => c.source_id === source.id)?.quote;
        row.evidenceSource = { id: source.id, url: source.url, author: source.author,
          postedAt: source.postedAt, evidence: evidence ?? null, currentAvailabilityVerified: false };
      }
    } catch { row.status = 'error'; row.decision = 'review'; row.reason = 'Output failed schema or source-evidence validation; no retry'; }
    row.latencyMs = Date.now() - started;
    await persist();
  }
  await persist();
  return { results, stopped, plan };
}
