// Explicit offline replay migration only; never called by the live parser.
export function projectLegacyHiringDecision(raw: string, targetId: string) {
  const old = JSON.parse(raw);
  if (!['keep', 'skip', 'review'].includes(old.decision)) throw Error('Invalid legacy decision');
  if (old.decision === 'keep') {
    if (old.lead_type === 'own_recruitment') {
      if (old.subject_source_id !== null && old.subject_source_id !== targetId) throw Error('Conflicting legacy own source');
    } else if (old.lead_type !== 'shared_opportunity' || typeof old.subject_source_id !== 'string'
      || !old.subject_source_id || old.subject_source_id === targetId) throw Error('Invalid legacy shared source');
  } else if (old.lead_type !== null || old.subject_source_id !== null) throw Error('Legacy non-keep asserts an opportunity');
  return JSON.stringify({ decision: old.decision, reason: old.reason, lead_type: old.lead_type,
    shared_source_id: old.lead_type === 'shared_opportunity' ? old.subject_source_id : null });
}
