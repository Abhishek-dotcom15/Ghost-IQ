import { describe, expect, it } from 'vitest';
import { computeFlakinessScore, updateRunningAverage } from './flakiness.js';

describe('computeFlakinessScore', () => {
  it('is 0 for no history or a stable history', () => {
    expect(computeFlakinessScore([])).toBe(0);
    expect(computeFlakinessScore(['PASSED', 'PASSED', 'PASSED'])).toBe(0);
  });

  it('counts transitions relative to run count', () => {
    expect(computeFlakinessScore(['PASSED', 'FAILED', 'PASSED', 'PASSED'])).toBe(50);
  });
});

describe('updateRunningAverage', () => {
  it('folds a new sample into the mean', () => {
    expect(updateRunningAverage(100, 1, 300)).toBe(200);
    expect(updateRunningAverage(0, 0, 42)).toBe(42);
  });
});
