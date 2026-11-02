import { describe, expect, it } from 'vitest';
import { END_REASONS } from './agent.js';
import { explainEndReason, explainStepError } from './explain.js';

describe('explainEndReason', () => {
  it('explains every end reason in plain words', () => {
    for (const reason of END_REASONS) {
      const e = explainEndReason(reason)!;
      expect(e.title, reason).toBeTruthy();
      expect(e.detail, reason).toBeTruthy();
      expect(e.title, reason).not.toContain('_'); // no codes in the headline
      if (e.tone === 'error') expect(e.fix, `${reason} needs a "what to do"`).toBeTruthy();
    }
  });

  it('uses the run context', () => {
    expect(explainEndReason('budget_steps', { maxSteps: 30 })!.detail).toContain(
      'all 30 allowed actions',
    );
    expect(
      explainEndReason('runner_disconnected', { summary: 'The GhostIQ server restarted while…' })!
        .detail,
    ).toContain('server restarted');
    expect(explainEndReason(null)).toBeNull();
    expect(explainEndReason('something_new', { summary: 'x' })).toMatchObject({
      title: 'something new',
      detail: 'x',
    });
  });
});

describe('explainStepError', () => {
  it.each([
    ['locator.click: Timeout 30000ms exceeded.', 'Timed out waiting'],
    ['<div class="modal"> intercepts pointer events', 'Something was covering it'],
    ['Element is not attached to the DOM', 'The page changed during the action'],
    ['Ref e12 is not in the current snapshot.', 'The target was no longer on the page'],
    ['Skipped (unsafe): "Delete account" looks destructive.', 'Blocked as destructive'],
    [
      'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000',
      'The site could not be reached',
    ],
    ['Skipped: https://evil.test is outside the allowed origins.', 'Left the site under test'],
  ])('%s', (error, title) => {
    expect(explainStepError(error)?.title).toBe(title);
  });

  it('returns null for unknown errors', () => {
    expect(explainStepError('something odd')).toBeNull();
    expect(explainStepError(undefined)).toBeNull();
  });
});
