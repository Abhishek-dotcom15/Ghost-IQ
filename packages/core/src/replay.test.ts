import {
  PersonaSpec,
  RunConfig,
  parseAriaSnapshot,
  type AgentAction,
  type ReplayScript,
  type StepCompletedEvent,
} from '@ghostiq/shared';
import { describe, expect, it } from 'vitest';
import { runAgent } from './agent.js';
import {
  ReplayPlanner,
  compatibleRoles,
  nameSimilarity,
  sameRoute,
  type Healer,
} from './replay.js';
import type { BrowserDriver, Observation, StepSignals } from './types.js';

const loginPage = (button = 'Sign In', role = 'button') => `- heading "Login" [level=1] [ref=e10]
- textbox "Email" [ref=e11]
- textbox "Password" [ref=e12]
- ${role} "${button}" [ref=e13]`;
const DASHBOARD = '- heading "User Workspace" [level=1] [ref=e20]';

/** A two-page app: the submit control navigates to /dashboard. Refs differ from the recording. */
class AppDriver implements BrowserDriver {
  current = '';
  executed: AgentAction[] = [];
  constructor(
    private login: string,
    private dashboardUrl = 'http://app.test/dashboard',
  ) {}
  snapshot = '';
  async open(url: string) {
    this.current = url;
    this.snapshot = this.login;
  }
  url() {
    return this.current;
  }
  async observe(): Promise<Observation> {
    return {
      url: this.current,
      title: 'App',
      snapshot: this.snapshot,
      elements: parseAriaSnapshot(this.snapshot),
    };
  }
  async execute(action: Exclude<AgentAction, { type: 'finish' }>) {
    this.executed.push(action);
    if (action.type === 'click' && action.ref === 'e13') {
      this.current = this.dashboardUrl;
      this.snapshot = DASHBOARD;
    }
  }
  async setOffline() {}
  async collect(): Promise<StepSignals> {
    return { network: [], issues: [], screenshotBase64: 'png' };
  }
}

const loc = (ref: string, role: string, name: string) => ({ ref, role, name, code: null });

const script: ReplayScript = {
  sourceSessionId: 'rec-1',
  steps: [
    {
      sourceStep: 2,
      action: { type: 'fill', ref: 'e1', text: 'qa@corp.test', reason: 'email' },
      locator: loc('e1', 'textbox', 'Email'),
      startUrl: 'http://app.test/',
    },
    {
      sourceStep: 3,
      action: { type: 'fill', ref: 'e2', text: 'Gh0st!pass', reason: 'password' },
      locator: loc('e2', 'textbox', 'Password'),
      input: { strategy: 'valid', kind: 'password', field: 'Password' },
      startUrl: 'http://app.test/',
    },
    {
      sourceStep: 4,
      action: { type: 'click', ref: 'e3', reason: 'submit' },
      locator: loc('e3', 'button', 'Sign In'),
      startUrl: 'http://app.test/',
    },
  ],
  finalState: { url: 'http://app.test/dashboard', headings: ['User Workspace'] },
};

function replay(driver: AppDriver, healer?: Healer, persona: Record<string, unknown> = {}) {
  const completed: StepCompletedEvent[] = [];
  const run = runAgent({
    command: {
      sessionId: 'replay-1',
      targetUrl: 'http://app.test/',
      persona: PersonaSpec.parse({
        id: 'tester',
        name: 'Tester',
        description: 'd',
        pacing: { min_ms: 0, max_ms: 0 },
        ...persona,
      }),
      seed: 1,
      goal: 'Log in',
      config: RunConfig.parse({ budgets: {}, allowedOrigins: ['http://app.test'] }),
      replay: script,
    },
    driver,
    planner: new ReplayPlanner(script, healer),
    events: { stepStarted: () => {}, stepCompleted: (e) => completed.push(e) },
    signal: new AbortController().signal,
    sleep: async () => {},
  });
  return { run, completed };
}

const healerReturning =
  (ref: string | null, confidence: number, calls: string[] = []): Healer =>
  async (request) => {
    calls.push(`${request.target.role}:${request.target.name}`);
    return { ref, confidence, reason: 'same job', tokens: 50 };
  };

describe('ReplayPlanner', () => {
  it('replays the recording by role and name, with the recorded values, and checks the end state', async () => {
    const driver = new AppDriver(loginPage());
    const { run, completed } = replay(driver);
    const outcome = await run;

    expect(outcome).toMatchObject({ status: 'PASSED', endReason: 'goal_met' });
    expect(outcome.stats.tokens).toBe(0);
    expect(driver.executed).toEqual([
      { type: 'fill', ref: 'e11', text: 'qa@corp.test', reason: 'email' },
      { type: 'fill', ref: 'e12', text: 'Gh0st!pass', reason: 'password' },
      { type: 'click', ref: 'e13', reason: 'submit' },
    ]);
    expect(completed.map((c) => c.action)).toEqual(['GOTO', 'FILL', 'FILL', 'CLICK', 'ASSERT']);
    expect(completed.at(-1)).toMatchObject({ status: 'PASSED' });
    expect(completed[2]!.input).toEqual({ strategy: 'valid', kind: 'password', field: 'Password' });
    expect(completed.every((c) => !c.heal)).toBe(true);
  });

  it('types recorded values verbatim even for personas that generate inputs', async () => {
    const driver = new AppDriver(loginPage());
    await replay(driver, undefined, { input_strategy: 'naughty_strings' }).run;
    expect(driver.executed[0]).toMatchObject({ text: 'qa@corp.test' });
  });

  it('heals a renamed control by fuzzy match and reports it', async () => {
    const calls: string[] = [];
    const driver = new AppDriver(loginPage('Sign in now'));
    const { run, completed } = replay(driver, healerReturning(null, 0, calls));
    expect(await run).toMatchObject({ status: 'PASSED' });
    expect(calls).toEqual([]); // the model was not needed
    const click = completed.find((c) => c.action === 'CLICK')!;
    expect(click.heal).toMatchObject({ method: 'fuzzy', sourceStep: 4, from: { name: 'Sign In' } });
    expect(click.heal!.confidence).toBeGreaterThanOrEqual(0.75);
    expect(click.issues[0]).toMatchObject({ kind: 'locator_healed', rule: 'button:Sign In' });
  });

  it('asks the model when no similar name exists, and accepts a confident, compatible answer', async () => {
    const driver = new AppDriver(loginPage('Log in'));
    const { run, completed } = replay(driver, healerReturning('e13', 0.92));
    const outcome = await run;
    expect(outcome).toMatchObject({ status: 'PASSED' });
    expect(outcome.stats.tokens).toBe(50);
    expect(completed.find((c) => c.action === 'CLICK')!.heal).toMatchObject({
      method: 'llm',
      confidence: 0.92,
    });
  });

  it('rejects a low-confidence model answer and fails as replay_diverged', async () => {
    const driver = new AppDriver(loginPage('Log in'));
    const { run, completed } = replay(driver, healerReturning('e13', 0.6));
    const outcome = await run;
    expect(outcome).toMatchObject({ status: 'FAILED', endReason: 'replay_diverged' });
    expect(outcome.summary).toContain('below 0.85');
    const check = completed.at(-1)!;
    expect(check).toMatchObject({ action: 'ASSERT', status: 'FAILED' });
    expect(check.issues[0]).toMatchObject({ kind: 'replay_diverged', rule: 'element' });
  });

  it('rejects a model answer with an incompatible role', async () => {
    const driver = new AppDriver(loginPage('Log in', 'checkbox'));
    const outcome = await replay(driver, healerReturning('e13', 0.99)).run;
    expect(outcome).toMatchObject({ endReason: 'replay_diverged' });
    expect(outcome.summary).toContain('cannot replace a button');
  });

  it('never heals a URL: a different end page is a regression', async () => {
    const driver = new AppDriver(loginPage(), 'http://app.test/login-error');
    const { run, completed } = replay(driver);
    const outcome = await run;
    expect(outcome).toMatchObject({ status: 'FAILED', endReason: 'replay_diverged' });
    expect(completed.at(-1)!.issues[0]).toMatchObject({
      kind: 'replay_diverged',
      rule: 'end_state',
    });
  });
});

describe('heal ladder helpers', () => {
  it('scores names', () => {
    expect(nameSimilarity('Sign In', 'Sign In')).toBe(1);
    expect(nameSimilarity('Sign In', 'sign in')).toBe(0.95);
    expect(nameSimilarity('Sign In', 'Sign in now')).toBeGreaterThanOrEqual(0.75);
    expect(nameSimilarity('Add to cart', 'Add to Cart')).toBe(0.95);
    expect(nameSimilarity('Sign In', 'Sign Up')).toBeLessThan(0.75);
    expect(nameSimilarity('Sign In', 'Log in')).toBeLessThan(0.75);
    expect(nameSimilarity('', 'x')).toBe(0);
  });

  it('groups interchangeable roles', () => {
    expect(compatibleRoles('button', 'link')).toBe(true);
    expect(compatibleRoles('textbox', 'searchbox')).toBe(true);
    expect(compatibleRoles('button', 'textbox')).toBe(false);
  });

  it('compares URLs by origin and route template', () => {
    expect(sameRoute('http://a.test/orders/12', 'http://a.test/orders/99')).toBe(true);
    expect(sameRoute('http://a.test/cart', 'http://a.test/checkout')).toBe(false);
    expect(sameRoute('http://a.test/', 'http://b.test/')).toBe(false);
  });
});
