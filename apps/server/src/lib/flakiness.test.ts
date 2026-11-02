import { describe, expect, it } from 'vitest';
import { updateRunningAverage } from './flakiness.js';

// Flakiness itself is measured on replays: see replay/script.test.ts (replayFlakiness).

describe('updateRunningAverage', () => {
  it('folds a new sample into the mean', () => {
    expect(updateRunningAverage(100, 1, 300)).toBe(200);
    expect(updateRunningAverage(0, 0, 42)).toBe(42);
  });
});
