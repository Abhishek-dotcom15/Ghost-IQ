import { z } from 'zod';

/** Element reference from Playwright's AI-mode aria snapshot: `e12`, or `f1e3` inside an iframe. */
export const ElementRef = z
  .string()
  .regex(/^(f\d+)?e\d+$/, 'must be a ref from the snapshot, like e12');

const reason = z.string().min(1).max(300);

/**
 * The closed set of things the agent may do. Anything else is rejected, so even a
 * prompt-injected model can only pick permitted browser actions.
 */
export const AgentAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), ref: ElementRef, reason }),
  z.object({ type: z.literal('fill'), ref: ElementRef, text: z.string().max(500), reason }),
  z.object({
    type: z.literal('select'),
    ref: ElementRef,
    option: z.string().min(1).max(200),
    reason,
  }),
  z.object({ type: z.literal('press'), key: z.string().regex(/^[A-Za-z0-9+]{1,30}$/), reason }),
  z.object({ type: z.literal('hover'), ref: ElementRef, reason }),
  z.object({ type: z.literal('scroll'), direction: z.enum(['up', 'down']), reason }),
  z.object({ type: z.literal('goBack'), reason }),
  z.object({ type: z.literal('goForward'), reason }),
  z.object({ type: z.literal('reload'), reason }),
  // Same-origin only: a path, never a full URL.
  z.object({ type: z.literal('navigate'), path: z.string().startsWith('/').max(500), reason }),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(100).max(5000), reason }),
  z.object({
    type: z.literal('finish'),
    goalMet: z.boolean(),
    summary: z.string().min(1).max(500),
  }),
]);
export type AgentAction = z.infer<typeof AgentAction>;
export type AgentActionType = AgentAction['type'];

export const ACTION_TYPES = [
  'click',
  'fill',
  'select',
  'press',
  'hover',
  'scroll',
  'goBack',
  'goForward',
  'reload',
  'navigate',
  'wait',
  'finish',
] as const satisfies readonly AgentActionType[];

/**
 * What the model is asked to return: one flat object (portable across providers and
 * friendly to small models) that is then checked against the closed AgentAction union.
 */
export const PlannerOutput = z
  .object({
    type: z.enum(ACTION_TYPES),
    ref: z.string().optional().describe('Element ref from the snapshot, e.g. e12'),
    text: z
      .string()
      .optional()
      .describe('Text to type (fill), or <generate> for a persona-generated value'),
    option: z.string().optional().describe('Option label (select)'),
    key: z.string().optional().describe('Key name (press), e.g. Enter, Tab, Escape'),
    direction: z.enum(['up', 'down']).optional().describe('scroll direction'),
    path: z.string().optional().describe('Same-origin path starting with / (navigate)'),
    ms: z.number().optional().describe('Milliseconds to wait (wait)'),
    goalMet: z.boolean().optional().describe('finish: whether the goal was achieved'),
    summary: z.string().optional().describe('finish: what happened'),
    reason: z.string().describe('One short sentence: why this action'),
  })
  .superRefine((value, ctx) => {
    const parsed = AgentAction.safeParse(plannerOutputToCandidate(value));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: 'custom',
          path: issue.path,
          message: `${value.type}: ${issue.message}`,
        });
      }
    }
  });
export type PlannerOutput = z.infer<typeof PlannerOutput>;

function plannerOutputToCandidate(v: Record<string, unknown>): Record<string, unknown> {
  if (v.type === 'finish')
    return { type: 'finish', goalMet: v.goalMet, summary: v.summary ?? v.reason };
  return v;
}

/** Converts validated planner output to the strict action (drops irrelevant fields). */
export function toAgentAction(output: PlannerOutput): AgentAction {
  return AgentAction.parse(stripUnknown(plannerOutputToCandidate(output)));
}

function stripUnknown(candidate: Record<string, unknown>): Record<string, unknown> {
  const type = candidate.type as AgentActionType;
  const keep: Record<AgentActionType, string[]> = {
    click: ['ref', 'reason'],
    fill: ['ref', 'text', 'reason'],
    select: ['ref', 'option', 'reason'],
    press: ['key', 'reason'],
    hover: ['ref', 'reason'],
    scroll: ['direction', 'reason'],
    goBack: ['reason'],
    goForward: ['reason'],
    reload: ['reason'],
    navigate: ['path', 'reason'],
    wait: ['ms', 'reason'],
    finish: ['goalMet', 'summary'],
  };
  const out: Record<string, unknown> = { type };
  for (const key of keep[type] ?? []) if (candidate[key] !== undefined) out[key] = candidate[key];
  return out;
}

/** Actions that target an element from the snapshot. */
export function actionRef(action: AgentAction): string | undefined {
  return 'ref' in action ? action.ref : undefined;
}

// ------------------------------------------------------------------ run config

export const RunBudgets = z.object({
  maxSteps: z.number().int().min(1).max(200).default(30),
  maxDurationMs: z.number().int().min(10_000).max(3_600_000).default(300_000),
  maxTokens: z.number().int().min(1_000).max(5_000_000).default(200_000),
});
export type RunBudgets = z.infer<typeof RunBudgets>;

export const RunConfig = z.object({
  budgets: RunBudgets,
  /** Origins the agent may visit, e.g. ["http://localhost:3000"]. */
  allowedOrigins: z.array(z.string()).min(1).max(20),
  /** Whether clicks on delete/pay/purchase-like controls are allowed. */
  allowDestructive: z.boolean().default(false),
});
export type RunConfig = z.infer<typeof RunConfig>;

// ------------------------------------------------------------------ outcomes

export const END_REASONS = [
  'goal_met',
  'goal_not_met',
  'budget_steps',
  'budget_time',
  'budget_tokens',
  'loop_detected',
  'stuck',
  'planner_error',
  'start_failed',
  'cancelled',
  'runner_error',
  'runner_disconnected',
] as const;
export const EndReason = z.enum(END_REASONS);
export type EndReason = z.infer<typeof EndReason>;

export const ISSUE_KINDS = [
  'console_error',
  'page_error',
  'http_error',
  'request_failed',
  'blocked_navigation',
  'destructive_blocked',
  'unknown_ref',
  'action_not_allowed',
  // Oracles (Phase 4): each becomes a Finding on the server.
  'a11y',
  'security_header',
  'insecure_cookie',
  'info_exposure',
  'script_injection',
  'duplicate_submission',
  'hanging_request',
  'broken_link',
  'redirect_loop',
  'layout_overflow',
  'web_vital',
] as const;
export type IssueKind = (typeof ISSUE_KINDS)[number];

/** Issues that describe what the agent did rather than a defect in the app. */
export const AGENT_NOTE_KINDS: ReadonlySet<IssueKind> = new Set([
  'blocked_navigation',
  'destructive_blocked',
  'unknown_ref',
  'action_not_allowed',
]);

/** Something noteworthy observed during a step. Recorded, never fatal to the run. */
export const StepIssue = z.object({
  kind: z.enum(ISSUE_KINDS),
  message: z.string().max(2000),
  url: z.string().max(2000).optional(),
  status: z.number().int().optional(),
  method: z.string().max(16).optional(),
  /** Oracle-specific rule: axe rule id, header name, "stack-trace", "cls", ... */
  rule: z.string().max(100).optional(),
  impact: z.enum(['minor', 'moderate', 'serious', 'critical']).optional(),
  /** Supporting detail: HTML snippet, response excerpt, measured value. */
  detail: z.string().max(2000).optional(),
});
export type StepIssue = z.infer<typeof StepIssue>;

/** Durable locator for an element, usable after the snapshot ref is gone (replay/export). */
export const ElementLocator = z.object({
  ref: z.string(),
  role: z.string(),
  name: z.string(),
  /** Playwright code, e.g. page.getByRole('button', { name: 'Sign In' }). Null when not unique-able. */
  code: z.string().nullable(),
});
export type ElementLocator = z.infer<typeof ElementLocator>;
