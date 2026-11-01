import type { Post } from './x-posts.js';
import { graphForPost } from './hiring-pipeline.js';
import { reachableSources } from './hiring-evidence.js';

// Caller-verified same-opportunity assertions, never inferred from company/name
// or careers URL equality. A verified source relationship is also required.
export interface VerifiedOpportunityAlias {
  sourceId: string; canonicalSourceId: string; evidence: string;
}
export function validateOpportunityAliases(aliases: readonly VerifiedOpportunityAlias[], posts: Post[]): void {
  const byId = new Map(posts.map(p=>[p.id,p]));
  const mapped = new Set(aliases.map(a=>a.sourceId));
  if(mapped.size!==aliases.length)throw Error('Repeated opportunity alias');
  for(const alias of aliases){
    if(!alias.evidence.trim() || alias.sourceId===alias.canonicalSourceId || mapped.has(alias.canonicalSourceId))throw Error('Invalid opportunity alias or chain');
    const a=byId.get(alias.sourceId),b=byId.get(alias.canonicalSourceId);
    if(!a||!b||a.truncated||b.truncated)throw Error('Missing complete alias sources');
    const connected=reachableSources(graphForPost(a,posts).graph).has(b.id) || reachableSources(graphForPost(b,posts).graph).has(a.id);
    if(!connected)throw Error('Opportunity alias requires a verified source connection');
  }
}
