import {
  FinalState,
  MASK,
  PersonaSpec,
  ReplayScript,
  type AgentAction,
  type ElementLocator,
  type ReplayStep,
} from '@ghostiq/shared';
import { regenerateValues, type RecordedSession, type RecordedStep } from '../export/spec.js';

export interface ReplaySource extends RecordedSession {
  mode: string;
  endReason: string | null;
}

export interface ReplayableStep extends RecordedStep {
  screenshotPath: string | null;
}

export class NotReplayableError extends Error {}

/**
 * Turns a recorded run into the script a replay follows: the planner's successful actions
 * with their real values, durable locators (approved heals applied) and where the recording
 * was before each one. Behavior steps are left out: the persona's seeded behaviors re-inject
 * them the same way. Throws NotReplayableError with a user-facing reason.
 */
export function buildReplayScript(
  session: ReplaySource,
  steps: ReplayableStep[],
  overrides: Map<number, ElementLocator> = new Map(),
): ReplayScript {
  if (session.mode !== 'explore') {
    throw new NotReplayableError('Only recorded (explore) runs can be replayed, not replays.');
  }
  const final = session.finalStateJson
    ? FinalState.safeParse(JSON.parse(session.finalStateJson))
    : null;
  if (session.endReason !== 'goal_met' || !final?.success) {
    throw new NotReplayableError(
      'Only runs that reached their goal can be replayed: otherwise there is no end state to check.',
    );
  }
  const persona = session.personaJson
    ? PersonaSpec.safeParse(JSON.parse(session.personaJson))
    : null;
  const regenerated = regenerateValues(persona?.success ? persona.data : null, session.seed, steps);

  const script: ReplayStep[] = [];
  let lastUrl: string = session.targetUrl;
  for (const step of [...steps].sort((a, b) => a.stepNumber - b.stepNumber)) {
    const planned =
      step.action !== 'GOTO' && !step.behavior && step.status === 'PASSED' && step.actionJson;
    if (planned) {
      let action = JSON.parse(step.actionJson!) as AgentAction;
      if (action.type === 'finish') continue;
      if (action.type === 'fill') {
        const recovered = regenerated.get(step.stepNumber);
        let text: string;
        if (recovered !== undefined) text = recovered;
        else if (step.value === MASK) {
          throw new NotReplayableError(
            `Step ${step.stepNumber} typed a secret that GhostIQ does not store, so a replay cannot type it. Export the run as a test and supply it as an environment variable instead.`,
          );
        } else text = step.value ?? action.text;
        action = { ...action, text };
      }
      const recorded = step.locatorJson
        ? (JSON.parse(step.locatorJson) as ElementLocator)
        : undefined;
      script.push({
        sourceStep: step.stepNumber,
        action,
        locator: overrides.get(step.stepNumber) ?? recorded,
        input: step.inputJson ? JSON.parse(step.inputJson) : undefined,
        startUrl: lastUrl,
        screenshot: step.screenshotPath ?? undefined,
      });
    }
    if (step.url && /^https?:/.test(step.url)) lastUrl = step.url;
  }
  if (script.length === 0)
    throw new NotReplayableError('The run has no recorded actions to replay.');

  return ReplayScript.parse({ sourceSessionId: session.id, steps: script, finalState: final.data });
}

/**
 * Flakiness of a recorded flow from its replays (same actions, same values, no LLM):
 * 0 when every replay agrees (all pass, or all fail = broken, not flaky), 100 at a 50/50
 * split. Needs at least two replays.
 */
export function replayFlakiness(statuses: readonly string[]): number {
  const decided = statuses.filter((s) => s === 'PASSED' || s === 'FAILED');
  if (decided.length < 2) return 0;
  const passRate = decided.filter((s) => s === 'PASSED').length / decided.length;
  return Math.round((1 - Math.abs(2 * passRate - 1)) * 100);
}
