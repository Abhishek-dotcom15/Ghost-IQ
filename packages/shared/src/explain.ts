/**
 * Plain-language explanations for how a run ended and why a step failed: what happened,
 * why it usually happens, and what to do. Deterministic (no AI), so it works in demo mode
 * and offline, and the dashboard, CLI and reports all say the same thing.
 */

export type ExplanationTone = 'success' | 'info' | 'warning' | 'error';

export interface Explanation {
  /** One short line, e.g. "Ran out of actions". */
  title: string;
  /** What happened and why, in one or two sentences. */
  detail: string;
  /** What to do about it (absent when nothing needs doing). */
  fix?: string;
  tone: ExplanationTone;
}

const END_REASONS: Record<
  string,
  (ctx: { summary?: string | null; maxSteps?: number }) => Explanation
> = {
  goal_met: () => ({
    title: 'Goal reached',
    detail:
      'The persona completed what it was asked to do. Any findings below were observed along the way.',
    tone: 'success',
  }),
  goal_not_met: ({ summary }) => ({
    title: 'The agent gave up on the goal',
    detail: `The agent decided the goal cannot be reached from this page${summary ? `: "${summary}"` : '.'}`,
    fix: 'Check that the app works for this goal by hand, and that the goal names things the way the page does (button and page names).',
    tone: 'error',
  }),
  budget_steps: ({ maxSteps }) => ({
    title: 'Ran out of actions',
    detail: `The agent used all ${maxSteps ?? 'its'} allowed actions without finishing. For exploration goals ("explore", "stress the forms") this is the normal end: it kept testing until the budget ran out, and its findings are still valid.`,
    fix: 'For a task with a clear end, raise "Max actions" or make the goal more specific. For exploration, nothing needs fixing.',
    tone: 'warning',
  }),
  budget_time: () => ({
    title: 'Ran out of time',
    detail:
      'The run hit its time limit before finishing. Slow pages or long waits use the budget up quickly.',
    fix: 'Raise the time budget, or check the API Health page for slow endpoints.',
    tone: 'warning',
  }),
  budget_tokens: () => ({
    title: 'Ran out of AI tokens',
    detail:
      'The run used its token budget for the AI planner. Large pages make each step more expensive.',
    fix: 'Raise the token budget, or narrow the goal so fewer steps are needed.',
    tone: 'warning',
  }),
  loop_detected: () => ({
    title: 'Stuck in a loop',
    detail:
      'The same page came up three times in a row: the agent kept doing something that did not change anything. Often a button that silently does nothing, or a form that rejects input without saying why.',
    fix: 'Look at the last few steps: the control they used probably does not respond. That is worth checking as a bug in the app.',
    tone: 'error',
  }),
  stuck: () => ({
    title: 'Actions kept failing',
    detail:
      'Three actions in a row could not be performed (elements hidden, covered, disabled or gone).',
    fix: 'Open the failed steps below: each one explains why its action failed.',
    tone: 'error',
  }),
  planner_error: ({ summary }) => ({
    title: 'The AI model could not be reached',
    detail: `The planner call failed${summary ? ` (${summary.replace(/^The planner failed: /, '')})` : ''}. Usually a wrong or expired API key, a quota limit, or no internet connection.`,
    fix: 'Open Settings to see the model status and its last error; check the API key and the provider quota.',
    tone: 'error',
  }),
  start_failed: () => ({
    title: 'Could not open the app',
    detail:
      'The browser could not load the target URL: the app is not running, the address is wrong, or the runner cannot reach it.',
    fix: 'Open the target URL in a browser on the runner machine. Check the port, and that the app is started.',
    tone: 'error',
  }),
  cancelled: () => ({
    title: 'Cancelled',
    detail: 'Someone stopped this run before it finished.',
    tone: 'info',
  }),
  runner_error: ({ summary }) => ({
    title: 'The runner crashed',
    detail: `The browser runner hit an internal error${summary ? `: ${summary.replace(/^Runner error: /, '')}` : '.'}`,
    fix: 'Check the runner terminal for the full error. Reinstalling the browser often helps: pnpm --filter @ghostiq/runner browsers:install',
    tone: 'error',
  }),
  runner_disconnected: ({ summary }) => ({
    title: 'Lost contact with the runner',
    detail: summary?.includes('restarted')
      ? 'The GhostIQ server restarted while this run was in progress, so it could not be finished.'
      : 'The runner went offline in the middle of the run (closed terminal, sleep, network drop).',
    fix: 'Make sure the runner is connected (sidebar: "Local CLI Agent: Connected"), then run it again.',
    tone: 'error',
  }),
  replay_diverged: ({ summary }) => ({
    title: 'The app no longer behaves like the recording',
    detail: `Replaying the recorded steps led somewhere else${summary ? `: ${summary}` : '.'} Either something broke (a regression) or the app changed on purpose.`,
    fix: 'Open the failed "Check" step to see what differs. If the change is intended, record a new run and replay that one.',
    tone: 'error',
  }),
};

export function explainEndReason(
  endReason: string | null | undefined,
  ctx: { summary?: string | null; maxSteps?: number } = {},
): Explanation | null {
  if (!endReason) return null;
  const make = END_REASONS[endReason];
  return make
    ? make(ctx)
    : {
        title: endReason.replace(/_/g, ' '),
        detail: ctx.summary ?? 'The run ended.',
        tone: 'info',
      };
}

const STEP_ERRORS: Array<[RegExp, Omit<Explanation, 'tone'>]> = [
  [
    /intercepts pointer events/i,
    {
      title: 'Something was covering it',
      detail:
        'Another element (a popup, banner, overlay or loading spinner) was on top of the target, so the click could not reach it.',
      fix: 'If a real user would also be blocked, this is a UX bug. Otherwise the overlay probably needs to be dismissed first.',
    },
  ],
  [
    /not visible|outside of the viewport|element is hidden/i,
    {
      title: 'The element was not visible',
      detail:
        'The target exists on the page but is hidden or off-screen, so a user could not use it either.',
    },
  ],
  [
    /not enabled|disabled/i,
    {
      title: 'The element was disabled',
      detail:
        'The control was greyed out when the agent tried to use it, usually because a required field before it was empty or invalid.',
    },
  ],
  [
    /not attached|detached|element was removed|Execution context was destroyed/i,
    {
      title: 'The page changed during the action',
      detail:
        'The element disappeared while the agent was using it (the page navigated or re-rendered). Usually harmless; repeated, it can mean an unstable UI.',
    },
  ],
  [
    /Timeout \d+ ?ms exceeded|timed out/i,
    {
      title: 'Timed out waiting',
      detail:
        'The element never became ready to use in time: still loading, hidden, covered or disabled.',
      fix: 'Check the step screenshot: if the page was still loading, the app may be slow here (see API Health).',
    },
  ],
  [
    /is not in the current snapshot|unknown ref/i,
    {
      title: 'The target was no longer on the page',
      detail:
        'The agent chose an element that had already gone by the time it acted (the page changed in between).',
    },
  ],
  [
    /Skipped \(unsafe\)|looks destructive/i,
    {
      title: 'Blocked as destructive',
      detail:
        'GhostIQ skipped this click because it looks like delete / pay / purchase. Runs never do that unless you allow it.',
      fix: 'Tick "Allow destructive actions" when launching, only against a test environment.',
    },
  ],
  [
    /outside the allowed origins|blocked navigation/i,
    {
      title: 'Left the site under test',
      detail:
        'The step tried to go to another website, which GhostIQ blocks to keep runs on your app.',
      fix: 'If that site is part of your app (for example a login domain), add it to the allowed origins.',
    },
  ],
  [
    /does not use/i,
    {
      title: 'Not something this persona does',
      detail:
        'The persona is restricted to certain actions (for example keyboard only), so this one was skipped.',
    },
  ],
  [
    /ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ECONNREFUSED/i,
    {
      title: 'The site could not be reached',
      detail:
        'The browser could not connect: the app stopped, the address is wrong, or the network is down.',
      fix: 'Check that the app is still running and reachable from the runner machine.',
    },
  ],
  [
    /Cannot type|not an <input>|not an input|Element is not an <input>/i,
    {
      title: 'Not a text field',
      detail: 'The agent tried to type into something that does not accept text.',
    },
  ],
];

/** Explanation for a failed or skipped step's raw error text, or null when unknown. */
export function explainStepError(error: string | null | undefined): Explanation | null {
  if (!error) return null;
  for (const [pattern, explanation] of STEP_ERRORS) {
    if (pattern.test(error)) return { ...explanation, tone: 'warning' };
  }
  return null;
}
