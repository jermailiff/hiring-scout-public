import type { HiringOpportunity } from '../opportunities.js';

// Measures source capture/delivery, not the label on each discovery comment.
// Employer aliases, route truth and cross-post semantic duplicates need separate
// labelled checks; source-ID agreement alone does not prove those properties.
export function scoreOpportunities(expectedSourceIds: string[], actual: HiringOpportunity[]) {
  if (new Set(expectedSourceIds).size !== expectedSourceIds.length) throw Error('Expected opportunity IDs must be unique');
  const expected = new Set(expectedSourceIds), found = new Set(actual.map(o => o.sourceId));
  const captured = expectedSourceIds.filter(id => found.has(id));
  return { expected: expected.size, captured: captured.length,
    missedSourceIds: expectedSourceIds.filter(id => !found.has(id)),
    unexpectedSourceIds: [...found].filter(id => !expected.has(id)),
    duplicateEntries: actual.length - found.size,
    capturedWithApplicationRoute: captured.filter(id => actual.some(o => o.sourceId === id && !o.needsLookup && o.applicationRoutes.length > 0)).length };
}
