/**
 * Incremental mean: avoids storing every sample.
 * (Flakiness moved to replay/script.ts: it is only meaningful on deterministic replays.)
 */
export function updateRunningAverage(avg: number, count: number, sample: number): number {
  return (avg * count + sample) / (count + 1);
}
