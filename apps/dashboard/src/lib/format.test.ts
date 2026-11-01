import { describe, expect, it } from 'vitest';
import { formatUsd, parseIssues } from './format';

describe('formatUsd', () => {
  it('keeps precision for sub-cent LLM costs', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.000123)).toBe('$0.00012');
    expect(formatUsd(1.234)).toBe('$1.23');
  });
});

describe('parseIssues', () => {
  it('parses stored issues and ignores junk', () => {
    expect(parseIssues('[{"kind":"http_error","message":"500"},{"oops":1}]')).toEqual([
      { kind: 'http_error', message: '500' },
    ]);
    expect(parseIssues('not json')).toEqual([]);
    expect(parseIssues(null)).toEqual([]);
  });
});
