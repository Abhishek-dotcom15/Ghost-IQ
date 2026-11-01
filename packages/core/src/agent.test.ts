import {
  PersonaSpec,
  RunConfig,
  parseAriaSnapshot,
  type PersonaSpecInput,
  type AgentAction,
  type NextActionRequest,
  type StepCompletedEvent,
  type StepIssue,
} from '@ghostiq/shared';
import { describe, expect, it } from 'vitest';
import { runAgent, truncateSnapshot } from './agent.js';
import type { AgentOptions, BrowserDriver, Observation, Planner, StepSignals } from './types.js';

const LOGIN = `- heading "Login" [level=1] [ref=e0]
- textbox "Email" [ref=e1]
- textbox "Password" [ref=e2]
- button "Sign In" [ref=e3]
- button "Delete account" [ref=e4]`;

class FakeDriver implements BrowserDriver {
  current = '';
  snapshot = LOGIN;
  executed: AgentAction[] = [];
  pendingIssues: StepIssue[] = [];
  openError?: string;
  failWith?: (action: AgentAction) => string | undefined;
  /** By default each action changes the page, so loop detection stays quiet. */
  mutates = true;

  async open(url: string) {
    if (this.openError) throw new Error(this.openError);
    this.current = url;
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
    const failure = this.failWith?.(action);
    if (failure) throw new Error(failure);
    if (action.type === 'navigate') this.current = new URL(action.path, this.current).toString();
    if (this.mutates) this.snapshot += `\n- generic: changed ${this.executed.length}`;
  }
  offline: boolean[] = [];
  async setOffline(offline: boolean) {
    this.offline.push(offline);
  }
  async collect(): Promise<StepSignals> {
    const issues = this.pendingIssues;
    this.pendingIssues = [];
    return { network: [], issues, screenshotBase64: 'png' };
  }
}

/** A test persona: valid inputs, no pauses, no behaviors unless overridden. */
function makePersona(overrides: Partial<PersonaSpecInput> = {}): PersonaSpec {
  return PersonaSpec.parse({
    id: 'tester',
    name: 'Tester',
    description: 'Test persona',
    pacing: { min_ms: 0, max_ms: 0 },
    ...overrides,
  });
}

/** Plays back a fixed list of actions; repeats the last one when the list runs out. */
function scriptedPlanner(actions: AgentAction[], tokensPerCall = 100) {
  const requests: NextActionRequest[] = [];
  const planner: Planner = {
    async next(request) {
      requests.push(request);
      const action = actions.length > 1 ? actions.shift()! : actions[0]!;
      return { action, tokens: tokensPerCall };
    },
  };
  return { planner, requests };
}

function setup(
  actions: AgentAction[],
  overrides: {
    config?: Partial<RunConfig>;
    budgets?: Partial<RunConfig['budgets']>;
    options?: Partial<AgentOptions>;
    persona?: Partial<PersonaSpecInput>;
    seed?: number;
  } = {},
) {
  const driver = new FakeDriver();
  const { planner, requests } = scriptedPlanner(actions);
  const started: string[] = [];
  const completed: StepCompletedEvent[] = [];
  const controller = new AbortController();
  const config = RunConfig.parse({
    budgets: { ...overrides.budgets },
    allowedOrigins: ['http://app.test'],
    ...overrides.config,
  });
  const options: AgentOptions = {
    command: {
      sessionId: 's1',
      targetUrl: 'http://app.test/',
      persona: makePersona(overrides.persona),
      seed: overrides.seed ?? 42,
      goal: 'Log in',
      config,
    },
    driver,
    planner,
    events: {
      stepStarted: (e) => started.push(e.action),
      stepCompleted: (e) => completed.push(e),
    },
    signal: controller.signal,
    sleep: async () => {},
    ...overrides.options,
  };
  return { driver, requests, started, completed, controller, run: () => runAgent(options) };
}

const login: AgentAction[] = [
  { type: 'fill', ref: 'e1', text: 'qa@ghostiq.io', reason: 'enter email' },
  { type: 'fill', ref: 'e2', text: 'hunter2', reason: 'enter password' },
  { type: 'click', ref: 'e3', reason: 'submit' },
  { type: 'finish', goalMet: true, summary: 'Logged in' },
];

describe('runAgent', () => {
  it('completes a goal and records every step with durable locators', async () => {
    const t = setup([...login]);
    const outcome = await t.run();

    expect(outcome).toMatchObject({
      status: 'PASSED',
      endReason: 'goal_met',
      summary: 'Logged in',
    });
    expect(outcome.stats).toMatchObject({ steps: 4, tokens: 400, issues: 0 });
    expect(t.started).toEqual(['GOTO', 'FILL', 'FILL', 'CLICK']);
    expect(t.completed.map((c) => c.status)).toEqual(['PASSED', 'PASSED', 'PASSED', 'PASSED']);

    const click = t.completed[3]!;
    expect(click.locator).toEqual({
      ref: 'e3',
      role: 'button',
      name: 'Sign In',
      code: 'page.getByRole("button", { name: "Sign In" })',
    });
    expect(click.description).toBe('Click button "Sign In" (submit)');
    expect(click.observationHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('masks secrets in recorded values but types the real value', async () => {
    const t = setup([...login]);
    await t.run();
    const password = t.completed[2]!;
    expect(password.value).toBe('••••••');
    expect(password.agentAction).toMatchObject({ type: 'fill', text: '••••••' });
    expect(t.driver.executed[1]).toMatchObject({ text: 'hunter2' });
    expect(t.completed[1]!.value).toBe('qa@ghostiq.io');
  });

  it('gives the planner a sliding window of history', async () => {
    const t = setup([...login], { options: { memorySize: 2 } });
    await t.run();
    expect(t.requests).toHaveLength(4);
    expect(t.requests[3]!.history.map((h) => h.kind)).toEqual(['FILL', 'CLICK']);
    expect(t.requests[3]!.stepNumber).toBe(5);
    expect(t.requests[0]!.snapshot).toContain('Sign In');
  });

  it('records bugs as issues and keeps exploring', async () => {
    const t = setup([...login]);
    t.driver.failWith = () => undefined;
    const originalExecute = t.driver.execute.bind(t.driver);
    t.driver.execute = async (action) => {
      await originalExecute(action);
      if (action.type === 'click') {
        t.driver.pendingIssues.push({
          kind: 'http_error',
          message: 'POST /api/login -> 500',
          status: 500,
        });
      }
    };

    const outcome = await t.run();

    expect(outcome.status).toBe('PASSED');
    expect(outcome.stats.issues).toBe(1);
    expect(t.completed[3]!.issues).toEqual([
      expect.objectContaining({ kind: 'http_error', status: 500 }),
    ]);
    expect(t.requests[3]!.history.at(-1)!.note).toContain('http_error');
  });

  it('skips destructive clicks unless allowed', async () => {
    const actions: AgentAction[] = [
      { type: 'click', ref: 'e4', reason: 'explore' },
      { type: 'finish', goalMet: false, summary: 'done' },
    ];
    const blocked = setup([...actions]);
    await blocked.run();
    expect(blocked.driver.executed).toHaveLength(0);
    expect(blocked.completed[1]).toMatchObject({ status: 'SKIPPED' });
    expect(blocked.completed[1]!.issues[0]!.kind).toBe('destructive_blocked');
    expect(blocked.requests[1]!.history[0]!.status).toBe('SKIPPED');

    const allowed = setup([...actions], { config: { allowDestructive: true } });
    await allowed.run();
    expect(allowed.driver.executed).toHaveLength(1);
  });

  it('blocks navigation outside the allowed origins, including protocol-relative paths', async () => {
    const t = setup([
      { type: 'navigate', path: '//evil.example/steal', reason: 'x' },
      { type: 'navigate', path: '/settings', reason: 'y' },
      { type: 'finish', goalMet: false, summary: 'done' },
    ]);
    await t.run();
    expect(t.completed[1]).toMatchObject({ status: 'SKIPPED' });
    expect(t.completed[1]!.issues[0]).toMatchObject({
      kind: 'blocked_navigation',
      url: 'http://evil.example/steal',
    });
    expect(t.completed[2]).toMatchObject({ status: 'PASSED', url: 'http://app.test/settings' });
    expect(t.driver.executed).toEqual([expect.objectContaining({ path: '/settings' })]);
  });

  it('refuses refs that are not on the page', async () => {
    const t = setup([
      { type: 'click', ref: 'e99', reason: 'x' },
      { type: 'finish', goalMet: false, summary: 'done' },
    ]);
    await t.run();
    expect(t.driver.executed).toHaveLength(0);
    expect(t.completed[1]).toMatchObject({ status: 'FAILED' });
    expect(t.completed[1]!.issues[0]!.kind).toBe('unknown_ref');
  });

  it('ends as stuck after repeated failed actions', async () => {
    const t = setup([{ type: 'click', ref: 'e3', reason: 'again' }]);
    t.driver.failWith = () => 'element is not visible';
    const outcome = await t.run();
    expect(outcome).toMatchObject({ status: 'FAILED', endReason: 'stuck' });
    expect(t.driver.executed).toHaveLength(3);
  });

  it('enforces the step budget', async () => {
    const t = setup([{ type: 'scroll', direction: 'down', reason: 'look' }], {
      budgets: { maxSteps: 2 },
    });
    const outcome = await t.run();
    expect(outcome.endReason).toBe('budget_steps');
    expect(t.driver.executed).toHaveLength(2);
  });

  it('enforces the token budget', async () => {
    const t = setup([{ type: 'scroll', direction: 'down', reason: 'look' }], {
      budgets: { maxTokens: 1000 },
    });
    const { planner } = scriptedPlanner(
      [{ type: 'scroll', direction: 'down', reason: 'look' }],
      600,
    );
    const outcome = await runAgent({ ...setupOptions(t), planner });
    expect(outcome.endReason).toBe('budget_tokens');
    expect(outcome.stats.tokens).toBe(1200);
  });

  it('enforces the time budget', async () => {
    let clock = 0;
    const t = setup([{ type: 'wait', ms: 1000, reason: 'wait' }], {
      budgets: { maxDurationMs: 10_000 },
      options: { now: () => (clock += 4_000) },
    });
    expect((await t.run()).endReason).toBe('budget_time');
  });

  it('detects a loop when the page state keeps repeating', async () => {
    const t = setup([{ type: 'press', key: 'Tab', reason: 'move' }]);
    t.driver.mutates = false;
    const outcome = await t.run();
    expect(outcome.endReason).toBe('loop_detected');
    expect(t.driver.executed).toHaveLength(2);
  });

  it('stops with planner_error when the planner fails', async () => {
    const t = setup([]);
    const outcome = await runAgent({
      ...setupOptions(t),
      planner: {
        next: async () => Promise.reject(new Error('All providers failed: gemini: auth')),
      },
    });
    expect(outcome).toMatchObject({ status: 'FAILED', endReason: 'planner_error' });
    expect(outcome.summary).toContain('gemini: auth');
  });

  it('can be cancelled mid-run', async () => {
    const t = setup([]);
    const outcome = await runAgent({
      ...setupOptions(t),
      planner: {
        next: async (_req, signal) => {
          t.controller.abort();
          throw signal.reason;
        },
      },
    });
    expect(outcome).toMatchObject({ status: 'CANCELLED', endReason: 'cancelled' });
  });

  it('fails fast when the start URL cannot be opened', async () => {
    const t = setup([...login]);
    t.driver.openError = 'net::ERR_CONNECTION_REFUSED';
    const outcome = await t.run();
    expect(outcome).toMatchObject({ status: 'FAILED', endReason: 'start_failed' });
    expect(t.completed[0]).toMatchObject({
      action: 'GOTO',
      status: 'FAILED',
      error: 'net::ERR_CONNECTION_REFUSED',
    });
    expect(t.requests).toHaveLength(0);
  });
});

describe('personas in the loop', () => {
  const fillBoth: AgentAction[] = [
    { type: 'fill', ref: 'e1', text: 'from-the-model@example.test', reason: 'email' },
    { type: 'fill', ref: 'e2', text: 'model-password', reason: 'password' },
    { type: 'finish', goalMet: false, summary: 'done' },
  ];

  it('uses seeded generated inputs for non-valid strategies, reproducibly', async () => {
    const typed = async (seed: number) => {
      const t = setup([...fillBoth], { persona: { input_strategy: 'unicode' }, seed });
      await t.run();
      return t.driver.executed.map((a) => (a.type === 'fill' ? a.text : ''));
    };
    const first = await typed(7);
    expect(first[0]).not.toBe('from-the-model@example.test');
    expect(await typed(7)).toEqual(first);
    expect(await typed(8)).not.toEqual(first);
  });

  it('keeps exact values from the planner for valid personas, but honours <generate>', async () => {
    const t = setup([
      { type: 'fill', ref: 'e1', text: 'admin@corp.test', reason: 'credentials from the goal' },
      { type: 'fill', ref: 'e2', text: '<generate>', reason: 'any password' },
      { type: 'finish', goalMet: true, summary: 'done' },
    ]);
    await t.run();
    expect(t.driver.executed[0]).toMatchObject({ text: 'admin@corp.test' });
    expect(t.driver.executed[1]).toMatchObject({ text: expect.stringMatching(/^Gh0st-/) });
    expect(t.completed[2]!.value).toBe('••••••');
  });

  it('skips actions outside the persona allowed_actions', async () => {
    const t = setup(
      [
        { type: 'click', ref: 'e3', reason: 'submit' },
        { type: 'press', key: 'Enter', reason: 'submit with keyboard' },
        { type: 'finish', goalMet: true, summary: 'done' },
      ],
      { persona: { allowed_actions: ['press', 'fill'] } },
    );
    await t.run();
    expect(t.completed[1]).toMatchObject({ status: 'SKIPPED' });
    expect(t.completed[1]!.issues[0]!.kind).toBe('action_not_allowed');
    expect(t.driver.executed).toEqual([expect.objectContaining({ type: 'press' })]);
    expect(t.requests[0]!.persona.allowed_actions).toEqual(['press', 'fill']);
  });

  it('never lets a safe persona perform destructive actions', async () => {
    const t = setup(
      [
        { type: 'click', ref: 'e4', reason: 'explore' },
        { type: 'finish', goalMet: false, summary: 'done' },
      ],
      { config: { allowDestructive: true }, persona: { risk_tolerance: 'safe' } },
    );
    await t.run();
    expect(t.driver.executed).toHaveLength(0);
    expect(t.requests[0]!.allowDestructive).toBe(false);
  });

  it('injects persona behaviors as their own recorded steps', async () => {
    const t = setup(
      [
        { type: 'click', ref: 'e3', reason: 'submit' },
        { type: 'finish', goalMet: true, summary: 'done' },
      ],
      { persona: { behaviors: [{ type: 'double_click', probability: 1 }] } },
    );
    const outcome = await t.run();
    expect(t.started).toEqual(['GOTO', 'CLICK', 'CLICK']);
    expect(t.completed[2]).toMatchObject({ behavior: 'double_click', status: 'PASSED' });
    expect(t.driver.executed.filter((a) => a.type === 'click')).toHaveLength(2);
    expect(t.requests[1]!.history.map((h) => h.summary)).toEqual([
      'Click button "Sign In" (submit)',
      'Double-click: click e3 again immediately',
    ]);
    expect(outcome.stats.steps).toBe(3);
  });

  it('cuts and restores the network for offline_blip', async () => {
    const t = setup([...fillBoth], {
      persona: { behaviors: [{ type: 'offline_blip', probability: 1 }] },
    });
    await t.run();
    expect(t.started.filter((k) => k === 'OFFLINE')).toHaveLength(2);
    expect(t.driver.offline).toEqual([true, false, true, false]);
  });

  it('paces actions within the persona range, deterministically', async () => {
    const pauses = async () => {
      const waits: number[] = [];
      const t = setup([...fillBoth], {
        persona: { pacing: { min_ms: 100, max_ms: 400 } },
        options: { sleep: async (ms) => void waits.push(ms) },
      });
      await t.run();
      return waits;
    };
    const first = await pauses();
    expect(first).toHaveLength(2);
    expect(first.every((ms) => ms >= 100 && ms <= 400)).toBe(true);
    expect(await pauses()).toEqual(first);
  });
});

describe('truncateSnapshot', () => {
  it('cuts at a line boundary and says so', () => {
    const snapshot = Array.from({ length: 100 }, (_, i) => `- button "B${i}" [ref=e${i}]`).join(
      '\n',
    );
    const cut = truncateSnapshot(snapshot, 200);
    expect(cut.length).toBeLessThan(snapshot.length);
    expect(cut).toContain('snapshot truncated');
    expect(
      cut
        .split('\n')
        .slice(0, -1)
        .every((l) => l.endsWith(']')),
    ).toBe(true);
    expect(truncateSnapshot('short', 200)).toBe('short');
  });
});

/** Rebuilds options from a setup() result so a test can swap the planner. */
function setupOptions(t: ReturnType<typeof setup>): AgentOptions {
  return {
    command: {
      sessionId: 's1',
      targetUrl: 'http://app.test/',
      persona: makePersona(),
      seed: 42,
      goal: 'Log in',
      config: RunConfig.parse({
        budgets: { maxTokens: 1000 },
        allowedOrigins: ['http://app.test'],
      }),
    },
    driver: t.driver,
    planner: {
      next: async () => ({ action: { type: 'finish', goalMet: true, summary: 'x' }, tokens: 0 }),
    },
    events: { stepStarted: () => {}, stepCompleted: (e) => t.completed.push(e) },
    signal: t.controller.signal,
    sleep: async () => {},
  };
}
