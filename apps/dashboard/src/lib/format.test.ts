import { describe, expect, it } from 'vitest';
import { formatUsd } from './format';

describe('formatUsd', () => {
  it('keeps precision for sub-cent LLM costs', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.000123)).toBe('$0.00012');
    expect(formatUsd(1.234)).toBe('$1.23');
  });
});
