/** Measurement validity only; never changes execution deadlines or runtime safety. */
export function soakContinuity(elapsedSamples: readonly number[], requestedMs: number) {
  let previous = 0, continuousPrefixMs = 0;
  const gaps: Array<{ fromMs: number; toMs: number; gapMs: number }> = [];
  for (const elapsed of elapsedSamples) {
    const gapMs = elapsed - previous;
    if (!Number.isFinite(elapsed) || gapMs < 0 || gapMs > 90000) gaps.push({ fromMs: previous, toMs: elapsed, gapMs });
    if (!gaps.length) continuousPrefixMs = elapsed;
    previous = elapsed;
  }
  return { validProductionSoak: gaps.length === 0 && continuousPrefixMs >= requestedMs,
    continuousPrefixMs, gaps, reason: gaps.length ? 'HOST_OR_PROCESS_STALL_INVALIDATED_SOAK'
      : continuousPrefixMs < requestedMs ? 'INSUFFICIENT_CONTINUOUS_DURATION' : 'COMPLETE' };
}
