/**
 * Percentage of pass/fail transitions across a chronologically ordered run history.
 * NOTE: on exploratory (LLM-driven) runs this measures agent variance as much as app
 * flakiness. Phase 5 restricts it to deterministic replays.
 */
export function computeFlakinessScore(statuses: readonly string[]): number {
  if (statuses.length === 0) return 0;
  let shifts = 0;
  for (let i = 1; i < statuses.length; i++) {
    if (statuses[i] !== statuses[i - 1]) shifts++;
  }
  return (shifts / statuses.length) * 100;
}

/** Incremental mean: avoids storing every sample. */
export function updateRunningAverage(avg: number, count: number, sample: number): number {
  return (avg * count + sample) / (count + 1);
}
