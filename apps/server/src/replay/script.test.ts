import { PersonaSpec } from '@ghostiq/shared';
import { describe, expect, it } from 'vitest';
import { regenerateValues } from '../export/spec.js';
import {
  NotReplayableError,
  buildReplayScript,
  replayFlakiness,
  type ReplayableStep,
} from './script.js';

const persona = PersonaSpec.parse({ id: 'tester', name: 'Tester', description: 'd' });
const session = {
  id: 'rec-1',
  name: 'Tester: Log in',
  targetUrl: 'http://shop.test/',
  persona: 'Tester',
  personaJson: JSON.stringify(persona),
  seed: 7,
  goal: 'Log in',
  startedAt: new Date('2026-11-02T10:00:00Z'),
  mode: 'explore',
  endReason: 'goal_met',
  finalStateJson: JSON.stringify({
    url: 'http://shop.test/dashboard',
    headings: ['User Workspace'],
  }),
};
const loc = (role: string, name: string, ref: string) =>
  JSON.stringify({ ref, role, name, code: null });
const step = (n: number, p: Partial<ReplayableStep>): ReplayableStep => ({
  stepNumber: n,
  action: 'CLICK',
  description: `step ${n}`,
  status: 'PASSED',
  value: null,
  url: 'http://shop.test/',
  actionJson: null,
  locatorJson: null,
  inputJson: null,
  behavior: null,
  screenshotPath: `/screenshots/rec-1_${n}.png`,
  ...p,
});

const steps: ReplayableStep[] = [
  step(1, { action: 'GOTO' }),
  step(2, {
    action: 'FILL',
    value: 'qa@corp.test',
    actionJson: JSON.stringify({ type: 'fill', ref: 'e9', text: 'qa@corp.test', reason: 'x' }),
    locatorJson: loc('textbox', 'Email', 'e9'),
  }),
  step(3, {
    action: 'FILL',
    value: '••••••',
    actionJson: JSON.stringify({ type: 'fill', ref: 'e11', text: '••••••', reason: 'x' }),
    locatorJson: loc('textbox', 'Password', 'e11'),
    inputJson: JSON.stringify({ strategy: 'valid', kind: 'password', field: 'Password' }),
  }),
  step(4, {
    action: 'CLICK',
    status: 'FAILED',
    actionJson: JSON.stringify({ type: 'click', ref: 'e2', reason: 'x' }),
    locatorJson: loc('button', 'Gone', 'e2'),
  }),
  step(5, {
    action: 'CLICK',
    actionJson: JSON.stringify({ type: 'click', ref: 'e12', reason: 'x' }),
    locatorJson: loc('button', 'Sign In', 'e12'),
    url: 'http://shop.test/dashboard',
  }),
  step(6, {
    action: 'CLICK',
    behavior: 'double_click',
    actionJson: JSON.stringify({ type: 'click', ref: 'e12', reason: 'x' }),
    locatorJson: loc('button', 'Sign In', 'e12'),
    url: 'http://shop.test/dashboard',
  }),
];

describe('buildReplayScript', () => {
  it('keeps successful planner actions with real values and where each one started', () => {
    const script = buildReplayScript(session, steps);
    expect(script.sourceSessionId).toBe('rec-1');
    expect(script.steps.map((s) => s.sourceStep)).toEqual([2, 3, 5]); // no GOTO, failed or behavior steps
    const password = regenerateValues(persona, 7, steps).get(3)!;
    expect(script.steps[1]!.action).toMatchObject({ type: 'fill', text: password });
    expect(script.steps[1]!.input).toEqual({
      strategy: 'valid',
      kind: 'password',
      field: 'Password',
    });
    expect(script.steps[2]).toMatchObject({
      locator: { role: 'button', name: 'Sign In' },
      startUrl: 'http://shop.test/',
      screenshot: '/screenshots/rec-1_5.png',
    });
    expect(script.finalState.headings).toEqual(['User Workspace']);
  });

  it('applies approved heals to locators', () => {
    const script = buildReplayScript(
      session,
      steps,
      new Map([[5, { ref: 'e40', role: 'button', name: 'Log in', code: null }]]),
    );
    expect(script.steps[2]!.locator).toMatchObject({ name: 'Log in' });
  });

  it('refuses what it cannot replay faithfully', () => {
    expect(() => buildReplayScript({ ...session, endReason: 'stuck' }, steps)).toThrow(
      NotReplayableError,
    );
    expect(() => buildReplayScript({ ...session, mode: 'replay' }, steps)).toThrow(/not replays/);
    const typedSecret = steps.map((s) => (s.stepNumber === 3 ? { ...s, inputJson: null } : s));
    expect(() => buildReplayScript(session, typedSecret)).toThrow(/secret/);
  });
});

describe('replayFlakiness', () => {
  it('is 0 when replays agree and peaks at a 50/50 split', () => {
    expect(replayFlakiness([])).toBe(0);
    expect(replayFlakiness(['PASSED'])).toBe(0);
    expect(replayFlakiness(['PASSED', 'PASSED', 'PASSED'])).toBe(0);
    expect(replayFlakiness(['FAILED', 'FAILED'])).toBe(0);
    expect(replayFlakiness(['PASSED', 'FAILED'])).toBe(100);
    expect(replayFlakiness(['PASSED', 'PASSED', 'PASSED', 'PASSED', 'FAILED'])).toBe(40);
    expect(replayFlakiness(['PASSED', 'CANCELLED', 'PASSED'])).toBe(0);
  });
});
