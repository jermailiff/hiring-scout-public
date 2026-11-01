import type { VerifiedOpportunityAlias } from './opportunity-aliases.js';
import type { LeadFlowRow } from './lead-flow.js';
import type { companyRouteSchema } from './lead-contracts.js';
import type { z } from 'zod';

export interface HiringOpportunity {
  sourceId: string;
  hiringSourceUrl: string;
  companyName: string | null;
  applicationRoutes: z.infer<typeof companyRouteSchema>['application_routes'];
  needsLookup: boolean;
  relatedSourceIds?: string[];
}

// User-facing records point to actual hiring sources. Discovery comments and raw
// model output remain in the separate audit rows. No company-name-based merging.
export function buildOpportunityShortlist(rows: LeadFlowRow[], aliases: readonly VerifiedOpportunityAlias[] = []): HiringOpportunity[] {
  const unique = new Map<string, HiringOpportunity>();
  for (const row of rows) {
    if (row.decision !== 'keep' || !row.source || row.duplicateOfSourceId || unique.has(row.source.id)) continue;
    unique.set(row.source.id, {
      sourceId: row.source.id, hiringSourceUrl: row.source.url,
      companyName: row.enrichment?.company_name ?? row.verifiedCompany?.name ?? null,
      applicationRoutes: structuredClone(row.enrichment?.application_routes ?? []),
      needsLookup: row.status !== 'ready' || row.enrichment?.needs_lookup !== false,
    });
  }
  for (const alias of aliases) {
    const source = unique.get(alias.sourceId), canonical = unique.get(alias.canonicalSourceId);
    // Never hide the only captured representation of an opportunity.
    if (!source || !canonical) continue;
    if (source.companyName && canonical.companyName && source.companyName !== canonical.companyName) continue;
    canonical.relatedSourceIds = [...(canonical.relatedSourceIds ?? []), source.sourceId];
    if (!canonical.companyName) canonical.companyName = source.companyName;
    if (!canonical.applicationRoutes.length && source.applicationRoutes.length) {
      canonical.applicationRoutes = structuredClone(source.applicationRoutes);
      canonical.needsLookup = source.needsLookup;
    }
    unique.delete(alias.sourceId);
  }
  return [...unique.values()];
}
