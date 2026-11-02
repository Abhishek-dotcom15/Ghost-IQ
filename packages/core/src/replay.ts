import {
  actionRef,
  normalizeRoute,
  type AgentAction,
  type ElementLocator,
  type HealInfo,
  type HealLocatorOutput,
  type NextActionRequest,
  type ReplayScript,
  type ReplayStep,
  type SnapshotElement,
  type StepIssue,
} from '@ghostiq/shared';
import type { Observation, PlanResult, Planner } from './types.js';

/** A same-role element whose name is at least this similar replaces a missing one. */
export const FUZZY_THRESHOLD = 0.75;
/** The model's pick is accepted only at this confidence or higher. */
export const LLM_THRESHOLD = 0.85;

/** Roles that can stand in for each other when the model heals (a button becoming a link). */
const ROLE_GROUPS: readonly (readonly string[])[] = [
  ['button', 'link', 'menuitem', 'tab', 'option'],
  ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  ['checkbox', 'switch', 'radio', 'menuitemcheckbox', 'menuitemradio'],
];

export interface HealRequest {
  target: { role: string; name: string };
  description: string;
  url: string;
  snapshot: string;
}

/** The LLM rung of the heal ladder (the runner calls the control plane). */
export type Healer = (
  request: HealRequest,
  signal: AbortSignal,
) => Promise<HealLocatorOutput & { tokens: number }>;

/**
 * Replays a recorded run without a planner model. Each recorded action is re-targeted by
 * role and accessible name (refs change between page loads). When the element is gone,
 * the heal ladder runs: exact name -> similar name, same role -> the model (>= 0.85,
 * compatible role). URLs and the end state are checked and never healed: a difference
 * there is a regression, not a renamed button.
 */
export class ReplayPlanner implements Planner {
  private index = 0;

  constructor(
    private readonly script: ReplayScript,
    private readonly healer?: Healer,
  ) {}

  async next(
    request: NextActionRequest,
    signal: AbortSignal,
    observation: Observation,
  ): Promise<PlanResult> {
    const step = this.script.steps[this.index];
    if (!step) return this.checkEndState(observation);

    if (step.startUrl && !sameRoute(step.startUrl, observation.url)) {
      return diverged(
        'url',
        `Before recorded step ${step.sourceStep} the recording was on ${step.startUrl}; the replay is on ${observation.url}.`,
        observation.url,
      );
    }
    this.index++;

    const ref = actionRef(step.action);
    if (!ref) return { action: step.action, tokens: 0, input: step.input };
    if (!step.locator) {
      return diverged(
        'element',
        `Recorded step ${step.sourceStep} has no locator to replay.`,
        observation.url,
      );
    }

    const found = await this.locate(step, step.locator, request, observation, signal);
    if (!found.element) {
      return {
        ...diverged(
          'element',
          `${step.locator.role} "${step.locator.name}" (recorded step ${step.sourceStep}) is no longer on the page${found.why ? `: ${found.why}` : ''}.`,
          observation.url,
        ),
        tokens: found.tokens,
      };
    }
    return {
      action: { ...step.action, ref: found.element.ref } as AgentAction,
      tokens: found.tokens,
      input: step.input,
      heal: found.heal,
    };
  }

  private async locate(
    step: ReplayStep,
    locator: ElementLocator,
    request: NextActionRequest,
    observation: Observation,
    signal: AbortSignal,
  ): Promise<{ element?: SnapshotElement; heal?: HealInfo; tokens: number; why?: string }> {
    const elements = [...observation.elements.values()];
    const exact = elements.find((e) => e.role === locator.role && e.name === locator.name);
    if (exact) return { element: exact, tokens: 0 };

    const from = { ...locator };
    if (locator.name) {
      const scored = elements
        .filter((e) => e.role === locator.role && e.name)
        .map((e) => ({ e, score: nameSimilarity(locator.name, e.name) }))
        .filter((c) => c.score >= FUZZY_THRESHOLD)
        .sort((a, b) => b.score - a.score);
      // Two equally good candidates: guessing would be a coin flip, leave it to the model.
      const [best, second] = scored;
      if (best && (!second || second.score < best.score)) {
        return {
          element: best.e,
          tokens: 0,
          heal: {
            sourceStep: step.sourceStep,
            method: 'fuzzy',
            confidence: round(best.score),
            reason: `Same role, similar name: "${locator.name}" -> "${best.e.name}".`,
            from,
          },
        };
      }
    }

    if (!this.healer) return { tokens: 0, why: 'no similar element and no model to ask' };
    let suggestion: Awaited<ReturnType<Healer>>;
    try {
      suggestion = await this.healer(
        {
          target: { role: locator.role, name: locator.name },
          description: describeStep(step),
          url: observation.url,
          snapshot: request.snapshot,
        },
        signal,
      );
    } catch (err) {
      if (signal.aborted) throw err;
      return { tokens: 0, why: `the heal model failed (${(err as Error).message.slice(0, 200)})` };
    }
    const candidate = suggestion.ref ? observation.elements.get(suggestion.ref) : undefined;
    if (!candidate)
      return {
        tokens: suggestion.tokens,
        why: `the model found no replacement (${suggestion.reason})`,
      };
    if (suggestion.confidence < LLM_THRESHOLD) {
      return {
        tokens: suggestion.tokens,
        why: `the model suggested ${candidate.role} "${candidate.name}" with confidence ${suggestion.confidence.toFixed(2)}, below ${LLM_THRESHOLD}`,
      };
    }
    if (!compatibleRoles(locator.role, candidate.role)) {
      return {
        tokens: suggestion.tokens,
        why: `the model suggested a ${candidate.role}, which cannot replace a ${locator.role}`,
      };
    }
    return {
      element: candidate,
      tokens: suggestion.tokens,
      heal: {
        sourceStep: step.sourceStep,
        method: 'llm',
        confidence: round(suggestion.confidence),
        reason: suggestion.reason,
        from,
      },
    };
  }

  private checkEndState(observation: Observation): PlanResult {
    const final = this.script.finalState;
    const problems: string[] = [];
    if (!sameRoute(final.url, observation.url)) {
      problems.push(`the recording ended on ${final.url}, the replay on ${observation.url}`);
    }
    const headings = new Set(
      [...observation.elements.values()].filter((e) => e.role === 'heading').map((e) => e.name),
    );
    // The same two headings the exported test asserts.
    const missing = final.headings.slice(0, 2).filter((h) => !headings.has(h));
    if (missing.length)
      problems.push(`missing heading(s) ${missing.map((h) => `"${h}"`).join(', ')}`);

    if (problems.length) {
      return diverged('end_state', `End state differs: ${problems.join('; ')}.`, observation.url);
    }
    const summary = `Replayed ${this.script.steps.length} recorded step(s); the end state matches the recording.`;
    return {
      action: { type: 'finish', goalMet: true, summary },
      tokens: 0,
      check: {
        description: 'Check: end state matches the recording (URL and headings)',
        passed: true,
      },
    };
  }
}

function diverged(rule: 'url' | 'element' | 'end_state', message: string, url: string): PlanResult {
  const issue: StepIssue = { kind: 'replay_diverged', message, rule, url };
  return {
    action: { type: 'finish', goalMet: false, summary: message.slice(0, 500) },
    tokens: 0,
    endReason: 'replay_diverged',
    check: { description: `Check: ${CHECK_LABEL[rule]}`, passed: false, error: message, issue },
  };
}

const CHECK_LABEL = {
  url: 'page matches the recording',
  element: 'recorded element is on the page',
  end_state: 'end state matches the recording',
} as const;

function describeStep(step: ReplayStep): string {
  const target = step.locator ? `${step.locator.role} "${step.locator.name}"` : '';
  const why = 'reason' in step.action ? ` (${step.action.reason})` : '';
  return `${step.action.type} ${target}${why}`.trim();
}

/** Same origin and same route template (ids may differ between runs). */
export function sameRoute(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && normalizeRoute(x.pathname) === normalizeRoute(y.pathname);
  } catch {
    return a === b;
  }
}

export function compatibleRoles(a: string, b: string): boolean {
  return a === b || ROLE_GROUPS.some((g) => g.includes(a) && g.includes(b));
}

/**
 * 0..1 similarity of two accessible names: the best of edit-distance ratio, word overlap
 * and word containment ("Sign in" vs "Sign in now"). A case or punctuation change is 0.95.
 */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return 0;
  if (a === b) return 1;
  if (x === y) return 0.95;
  const longest = Math.max(x.length, y.length);
  const edit = 1 - levenshtein(x, y) / longest;
  const wx = new Set(x.split(' '));
  const wy = new Set(y.split(' '));
  const shared = [...wx].filter((w) => wy.has(w)).length;
  const jaccard = shared / new Set([...wx, ...wy]).size;
  const contained =
    shared === Math.min(wx.size, wy.size) && Math.min(x.length, y.length) >= 3 ? 0.8 : 0;
  return Math.max(edit, jaccard, contained);
}

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
