import { createHash } from 'node:crypto';
import {
  InputGenerator,
  createRng,
  deriveSeed,
  planBehaviors,
  type InjectedStep,
} from '@ghostiq/personas';
import {
  GENERATE_TOKEN,
  MASK,
  actionRef,
  isAllowedUrl,
  isDestructiveName,
  isSecretField,
  locatorCode,
  personaBrief,
  type AgentAction,
  type BehaviorType,
  type ElementLocator,
  type EndReason,
  type HistoryItem,
  type SnapshotElement,
  type StepIssue,
  type StepKind,
  type StepStatus,
} from '@ghostiq/shared';
import type { AgentOptions, Observation, RunOutcome } from './types.js';

const DEFAULTS = {
  memorySize: 6,
  // ~3,000 tokens at ~4 characters per token, per the blueprint.
  snapshotCharLimit: 12_000,
  loopThreshold: 3,
  maxConsecutiveFailures: 3,
};

const KIND: Record<Exclude<AgentAction['type'], 'finish'>, StepKind> = {
  click: 'CLICK',
  fill: 'FILL',
  select: 'SELECT',
  press: 'PRESS',
  hover: 'HOVER',
  scroll: 'SCROLL',
  goBack: 'GO_BACK',
  goForward: 'GO_FORWARD',
  reload: 'RELOAD',
  navigate: 'NAVIGATE',
  wait: 'WAIT',
};

class Cancelled extends Error {}

/**
 * The observe -> plan -> act -> record loop. It ends when the planner finishes, a budget
 * is hit, the page state repeats, actions keep failing, or the caller cancels.
 * Bugs observed along the way are recorded as step issues and never stop the run.
 */
export async function runAgent(options: AgentOptions): Promise<RunOutcome> {
  const { command, driver, planner, events, signal } = options;
  const { persona, seed } = command;
  const { budgets, allowedOrigins } = command.config;
  // A "safe" persona never performs destructive actions, whatever the run allows.
  const allowDestructive = command.config.allowDestructive && persona.risk_tolerance !== 'safe';
  // Independent seeded streams, so e.g. a different pacing draw never changes the inputs.
  const inputs = new InputGenerator(deriveSeed(seed, 'inputs'));
  const pacingRng = createRng(deriveSeed(seed, 'pacing'));
  const behaviorRng = createRng(deriveSeed(seed, 'behaviors'));
  const brief = personaBrief(persona);
  const memorySize = options.memorySize ?? DEFAULTS.memorySize;
  const snapshotLimit = options.snapshotCharLimit ?? DEFAULTS.snapshotCharLimit;
  const loopThreshold = options.loopThreshold ?? DEFAULTS.loopThreshold;
  const maxFailures = options.maxConsecutiveFailures ?? DEFAULTS.maxConsecutiveFailures;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;

  const startedAt = now();
  const history: HistoryItem[] = [];
  const stateSeen = new Map<string, number>();
  let stepNumber = 0;
  let decisions = 0;
  let tokens = 0;
  let issueCount = 0;
  let consecutiveFailures = 0;

  const finish = (
    status: RunOutcome['status'],
    endReason: EndReason,
    summary: string,
  ): RunOutcome => ({
    status,
    endReason,
    summary,
    stats: { steps: stepNumber, tokens, durationMs: now() - startedAt, issues: issueCount },
  });

  const pause = async () => {
    const ms = pacingRng.int(persona.pacing.min_ms, persona.pacing.max_ms);
    if (ms > 0) await sleep(ms, signal);
  };

  const record = async (
    kind: StepKind,
    description: string,
    run: () => Promise<{
      behavior?: BehaviorType;
      status: StepStatus;
      error?: string;
      action?: AgentAction;
      element?: SnapshotElement;
      value?: string;
      extraIssues?: StepIssue[];
      observationHash?: string;
    }>,
  ) => {
    stepNumber++;
    events.stepStarted({ sessionId: command.sessionId, stepNumber, action: kind, description });
    const started = now();
    const result = await run();
    const signals = await driver.collect();
    const issues = [...(result.extraIssues ?? []), ...signals.issues];
    issueCount += issues.length;
    const locator: ElementLocator | undefined = result.element && {
      ref: result.element.ref,
      role: result.element.role,
      name: result.element.name,
      code: locatorCode(result.element),
    };
    const url = driver.url();
    events.stepCompleted({
      sessionId: command.sessionId,
      stepNumber,
      action: kind,
      description,
      status: result.status,
      error: result.error,
      selector: locator?.code ?? undefined,
      value: result.value,
      agentAction: result.action && maskAction(result.action, result.element),
      behavior: result.behavior,
      locator,
      url,
      durationMs: now() - started,
      observationHash: result.observationHash,
      issues,
      screenshotBase64: signals.screenshotBase64,
      a11yViolations: signals.a11yViolations,
      networkRequests: signals.network,
    });
    return { status: result.status, issues };
  };

  const runInjected = async (injected: InjectedStep, element: SnapshotElement | undefined) => {
    const base = {
      behavior: injected.behavior,
      action: injected.actions[0] as AgentAction | undefined,
      element: injected.actions[0] && 'ref' in injected.actions[0] ? element : undefined,
    };
    try {
      if (injected.offlineMs !== undefined) {
        await driver.setOffline(true);
        try {
          await sleep(injected.offlineMs, signal);
        } finally {
          await driver.setOffline(false);
        }
      }
      for (const browserAction of injected.actions) await driver.execute(browserAction, signal);
      await pause();
      return { ...base, status: 'PASSED' as const };
    } catch (err) {
      if (signal.aborted) throw new Cancelled();
      // e.g. the second click of a double-click lands after navigation: expected, recorded.
      return { ...base, status: 'FAILED' as const, error: errorMessage(err) };
    }
  };

  try {
    // ---- initial navigation (scripted, no LLM)
    let opened = true;
    await record('GOTO', `Open ${command.targetUrl}`, async () => {
      try {
        await driver.open(command.targetUrl);
        return { status: 'PASSED' };
      } catch (err) {
        opened = false;
        return { status: 'FAILED', error: errorMessage(err) };
      }
    });
    if (!opened) return finish('FAILED', 'start_failed', `Could not open ${command.targetUrl}.`);

    for (;;) {
      if (signal.aborted) throw new Cancelled();
      if (decisions >= budgets.maxSteps) {
        return finish(
          'FAILED',
          'budget_steps',
          `Stopped after ${budgets.maxSteps} actions without finishing.`,
        );
      }
      if (now() - startedAt >= budgets.maxDurationMs) {
        return finish(
          'FAILED',
          'budget_time',
          `Stopped after ${Math.round(budgets.maxDurationMs / 1000)}s.`,
        );
      }
      if (tokens >= budgets.maxTokens) {
        return finish('FAILED', 'budget_tokens', `Stopped after spending ${tokens} tokens.`);
      }

      const observation = await driver.observe();
      const stateHash = hashState(observation);
      // A failed action leaves the page unchanged; repeated failures are the "stuck" check's
      // job, so only states reached after a successful (or skipped) step count towards a loop.
      const seen = (stateSeen.get(stateHash) ?? 0) + (consecutiveFailures > 0 ? 0 : 1);
      stateSeen.set(stateHash, seen);
      if (seen >= loopThreshold) {
        return finish(
          'FAILED',
          'loop_detected',
          `The same page state came up ${seen} times at ${observation.url}.`,
        );
      }

      let action: AgentAction;
      try {
        const plan = await planner.next(
          {
            sessionId: command.sessionId,
            goal: command.goal,
            persona: brief,
            url: observation.url,
            title: observation.title,
            snapshot: truncateSnapshot(observation.snapshot, snapshotLimit),
            history: history.slice(-memorySize),
            stepNumber: stepNumber + 1,
            allowDestructive,
          },
          signal,
        );
        tokens += plan.tokens;
        action = plan.action;
      } catch (err) {
        if (signal.aborted) throw new Cancelled();
        return finish('FAILED', 'planner_error', `The planner failed: ${errorMessage(err)}`);
      }

      if (action.type === 'finish') {
        return action.goalMet
          ? finish('PASSED', 'goal_met', action.summary)
          : finish('FAILED', 'goal_not_met', action.summary);
      }
      decisions++;

      const ref = actionRef(action);
      const element = ref ? observation.elements.get(ref) : undefined;
      // Form values come from the persona's seeded generator (reproducible), unless the
      // persona types valid data and the planner supplied an exact value from the goal.
      if (
        action.type === 'fill' &&
        element &&
        (persona.input_strategy !== 'valid' || action.text === GENERATE_TOKEN)
      ) {
        action = { ...action, text: inputs.value(element, persona.input_strategy).value };
      }
      const description = describe(action, element);
      const value =
        action.type === 'fill'
          ? element && isSecretField(element.name)
            ? MASK
            : action.text
          : undefined;
      const planned = action;

      const step = await record(KIND[planned.type], description, async () => {
        const base = { action: planned, element, value, observationHash: stateHash };
        if (persona.allowed_actions && !persona.allowed_actions.includes(planned.type)) {
          return {
            ...base,
            status: 'SKIPPED',
            error: `Skipped: the ${persona.name} persona does not use "${planned.type}".`,
            extraIssues: [
              {
                kind: 'action_not_allowed',
                message: `${planned.type} is not in this persona's allowed actions (${persona.allowed_actions.join(', ')}).`,
              },
            ],
          };
        }
        if (ref && !element) {
          return {
            ...base,
            status: 'FAILED',
            error: `Ref ${ref} is not in the current snapshot.`,
            extraIssues: [
              { kind: 'unknown_ref', message: `Planner chose ${ref}, which is not on the page.` },
            ],
          };
        }
        if (
          element &&
          planned.type === 'click' &&
          !allowDestructive &&
          isDestructiveName(element.name)
        ) {
          return {
            ...base,
            status: 'SKIPPED',
            error: `Skipped (unsafe): "${element.name}" looks destructive. Enable allowDestructive to permit it.`,
            extraIssues: [
              { kind: 'destructive_blocked', message: `Blocked click on "${element.name}".` },
            ],
          };
        }
        if (planned.type === 'navigate') {
          const target = new URL(planned.path, observation.url).toString();
          if (!isAllowedUrl(target, allowedOrigins)) {
            return {
              ...base,
              status: 'SKIPPED',
              error: `Skipped: ${target} is outside the allowed origins.`,
              extraIssues: [
                {
                  kind: 'blocked_navigation',
                  message: `Blocked navigation to ${target}.`,
                  url: target,
                },
              ],
            };
          }
        }
        try {
          await driver.execute(planned, signal);
          await pause();
          return { ...base, status: 'PASSED' };
        } catch (err) {
          if (signal.aborted) throw new Cancelled();
          return { ...base, status: 'FAILED', error: errorMessage(err) };
        }
      });

      history.push({
        stepNumber,
        kind: KIND[planned.type],
        summary: description.slice(0, 500),
        status: step.status,
        note: noteFor(step.issues),
      });

      // Persona behaviors (double-click, refresh mid-flow, ...) follow successful actions.
      // They are recorded as their own steps but never count as planner decisions or failures.
      if (step.status === 'PASSED') {
        for (const injected of planBehaviors(persona.behaviors, planned, behaviorRng)) {
          if (signal.aborted) throw new Cancelled();
          const result = await record(injected.kind, injected.description, () =>
            runInjected(injected, element),
          );
          history.push({
            stepNumber,
            kind: injected.kind,
            summary: injected.description,
            status: result.status,
            note: noteFor(result.issues),
          });
        }
      }

      consecutiveFailures = step.status === 'FAILED' ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= maxFailures) {
        return finish(
          'FAILED',
          'stuck',
          `${maxFailures} actions in a row failed; the agent is stuck.`,
        );
      }
    }
  } catch (err) {
    if (err instanceof Cancelled || signal.aborted) {
      return finish('CANCELLED', 'cancelled', 'The run was cancelled.');
    }
    return finish('FAILED', 'runner_error', `Runner error: ${errorMessage(err)}`);
  }
}

/** Human-readable step description: the target and the model's stated reason. */
export function describe(action: AgentAction, element?: SnapshotElement): string {
  const target = element ? `${element.role}${element.name ? ` "${element.name}"` : ''}` : '';
  const why = 'reason' in action ? ` (${action.reason})` : '';
  switch (action.type) {
    case 'click':
      return `Click ${target || action.ref}${why}`;
    case 'fill':
      return `Fill ${target || action.ref}${why}`;
    case 'select':
      return `Select "${action.option}" in ${target || action.ref}${why}`;
    case 'hover':
      return `Hover ${target || action.ref}${why}`;
    case 'press':
      return `Press ${action.key}${why}`;
    case 'scroll':
      return `Scroll ${action.direction}${why}`;
    case 'goBack':
      return `Go back${why}`;
    case 'goForward':
      return `Go forward${why}`;
    case 'reload':
      return `Reload the page${why}`;
    case 'navigate':
      return `Navigate to ${action.path}${why}`;
    case 'wait':
      return `Wait ${action.ms} ms${why}`;
    case 'finish':
      return `Finish: ${action.summary}`;
    default:
      return String(action satisfies never as unknown);
  }
}

function maskAction(action: AgentAction, element?: SnapshotElement): AgentAction {
  if (action.type === 'fill' && element && isSecretField(element.name))
    return { ...action, text: MASK };
  return action;
}

/** Tells the planner what went wrong, so it does not retry a blocked or broken action blindly. */
function noteFor(issues: StepIssue[]): string | undefined {
  if (issues.length === 0) return undefined;
  return issues
    .slice(0, 3)
    .map((i) => `${i.kind}: ${i.message}`)
    .join('; ')
    .slice(0, 500);
}

function hashState(observation: Observation): string {
  return createHash('sha256')
    .update(`${observation.url}\n${observation.snapshot}`)
    .digest('hex')
    .slice(0, 32);
}

/** Keeps the start of the snapshot (top of the page) and says that it was cut. */
export function truncateSnapshot(snapshot: string, limit: number): string {
  if (snapshot.length <= limit) return snapshot;
  const cut = snapshot.lastIndexOf('\n', limit);
  return `${snapshot.slice(0, cut > 0 ? cut : limit)}\n- note: snapshot truncated (${snapshot.length - limit} more characters); scroll to see more`;
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 1000);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Cancelled());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Cancelled());
      },
      { once: true },
    );
  });
}
