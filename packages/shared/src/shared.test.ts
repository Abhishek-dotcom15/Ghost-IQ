import { describe, expect, it } from 'vitest';
import { RunTestCommand, StepCompletedEvent, normalizeEndpointUrl } from './index.js';

describe('normalizeEndpointUrl', () => {
  it('drops query and hash from absolute URLs', () => {
    expect(normalizeEndpointUrl('http://localhost:3000/api/users?id=42#x')).toBe(
      'http://localhost:3000/api/users',
    );
  });

  it('handles relative URLs', () => {
    expect(normalizeEndpointUrl('/api/items?page=2')).toBe('/api/items');
  });
});

describe('event schemas', () => {
  it('defaults networkRequests to an empty list', () => {
    const parsed = StepCompletedEvent.parse({
      sessionId: 's1',
      stepNumber: 1,
      action: 'GOTO',
      description: 'Open home',
      status: 'PASSED',
    });
    expect(parsed.networkRequests).toEqual([]);
  });

  it('rejects unknown actions', () => {
    const result = StepCompletedEvent.safeParse({
      sessionId: 's1',
      stepNumber: 1,
      action: 'DELETE_EVERYTHING',
      description: 'x',
      status: 'PASSED',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-URL target', () => {
    const result = RunTestCommand.safeParse({
      sessionId: 's1',
      targetUrl: 'not a url',
      persona: 'Happy Path User',
      goal: 'Log in',
    });
    expect(result.success).toBe(false);
  });
});
