import { z } from 'zod';
import { AgentAction, ElementLocator, EndReason, RunConfig, StepIssue } from './agent.js';
import { BEHAVIOR_TYPES, INPUT_STRATEGIES, PersonaSpec } from './persona.js';

/**
 * Socket.IO contract between the runner agent and the control plane.
 * Both sides import these schemas; the server validates every inbound payload.
 */

/** Step kinds as shown in the UI: the initial navigation plus one per agent action type. */
export const STEP_KINDS = [
  'GOTO',
  'CLICK',
  'FILL',
  'SELECT',
  'PRESS',
  'HOVER',
  'SCROLL',
  'GO_BACK',
  'GO_FORWARD',
  'RELOAD',
  'NAVIGATE',
  'WAIT',
  'OFFLINE',
  // Replay: a check against the recording (URL, end state).
  'ASSERT',
] as const;
export const StepKind = z.enum(STEP_KINDS);
export type StepKind = z.infer<typeof StepKind>;

export const StepStatus = z.enum(['PASSED', 'FAILED', 'SKIPPED']);
export type StepStatus = z.infer<typeof StepStatus>;

export const SessionStatus = z.enum(['PENDING', 'RUNNING', 'PASSED', 'FAILED', 'CANCELLED']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const NetworkRequestRecord = z.object({
  url: z.string().max(4096),
  method: z.string().max(16),
  status: z.number().int().min(0).max(999),
  latencyMs: z.number().int().nonnegative(),
});
export type NetworkRequestRecord = z.infer<typeof NetworkRequestRecord>;

/** What the page looked like when the goal was met: exported tests and replays assert it. */
export const FinalState = z.object({
  url: z.string().max(2000),
  headings: z.array(z.string().max(200)).max(5),
});
export type FinalState = z.infer<typeof FinalState>;

const StepInput = z.object({
  strategy: z.enum(INPUT_STRATEGIES),
  kind: z.string().max(30),
  field: z.string().max(200),
});

/** One recorded planner decision, as replayed: no LLM, values and locators are fixed. */
export const ReplayStep = z.object({
  /** Step number in the recorded run. */
  sourceStep: z.number().int().positive(),
  /** The recorded action with its real value (masked secrets already regenerated). */
  action: AgentAction,
  /** Recorded (or approved-heal) target; absent for actions without an element. */
  locator: ElementLocator.optional(),
  /** Generated-value provenance, carried over so the validation oracle still applies. */
  input: StepInput.optional(),
  /** Where the recording was when it took this step (checked, never healed). */
  startUrl: z.string().max(2000).optional(),
  /** Screenshot of the recorded step, shown next to the replay's in heal review. */
  screenshot: z.string().max(500).optional(),
});
export type ReplayStep = z.infer<typeof ReplayStep>;

export const ReplayScript = z.object({
  sourceSessionId: z.string().min(1),
  steps: z.array(ReplayStep).min(1).max(500),
  finalState: FinalState,
});
export type ReplayScript = z.infer<typeof ReplayScript>;

export const HEAL_METHODS = ['fuzzy', 'llm'] as const;

/** A locator repaired during replay; the server turns it into a HealEvent for review. */
export const HealInfo = z.object({
  sourceStep: z.number().int().positive(),
  method: z.enum(HEAL_METHODS),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(1000),
  from: ElementLocator,
});
export type HealInfo = z.infer<typeof HealInfo>;

export const RunTestCommand = z.object({
  sessionId: z.string().min(1),
  targetUrl: z.url(),
  persona: PersonaSpec,
  /** Drives every random choice (inputs, pacing, behaviors): same seed, same choices. */
  seed: z.number().int().min(0),
  goal: z.string().min(1).max(2000),
  config: RunConfig,
  /** Set for replay runs: the recorded actions to repeat instead of asking a planner. */
  replay: ReplayScript.optional(),
});
export type RunTestCommand = z.infer<typeof RunTestCommand>;

export const RunCancelCommand = z.object({ sessionId: z.string().min(1) });
export type RunCancelCommand = z.infer<typeof RunCancelCommand>;

export const StepStartedEvent = z.object({
  sessionId: z.string().min(1),
  stepNumber: z.number().int().positive(),
  action: StepKind,
  description: z.string().max(2000),
});
export type StepStartedEvent = z.infer<typeof StepStartedEvent>;

/** ~10 MB of base64 is the hard ceiling the server accepts for a screenshot. */
const MAX_SCREENSHOT_BASE64 = 10 * 1024 * 1024;

export const StepCompletedEvent = StepStartedEvent.extend({
  status: StepStatus,
  error: z.string().max(20_000).optional(),
  /** Durable locator code for the target element (also shown in the UI). */
  selector: z.string().max(2000).optional(),
  /** Typed value; secrets are masked by the runner before sending. */
  value: z.string().max(5000).optional(),
  agentAction: AgentAction.optional(),
  /** Set when the step was injected by a persona behavior rather than chosen by the planner. */
  behavior: z.enum(BEHAVIOR_TYPES).optional(),
  /** For fills with a generated value: which strategy produced it (feeds the validation oracle). */
  input: StepInput.optional(),
  locator: ElementLocator.optional(),
  /** Replay: the recorded locator no longer matched and this one was found instead. */
  heal: HealInfo.optional(),
  url: z.string().max(2000).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  observationHash: z.string().max(64).optional(),
  issues: z.array(StepIssue).max(200).default([]),
  screenshotBase64: z.string().max(MAX_SCREENSHOT_BASE64).optional(),
  a11yViolations: z.string().max(200_000).optional(),
  networkRequests: z.array(NetworkRequestRecord).max(1000).default([]),
});
export type StepCompletedEvent = z.infer<typeof StepCompletedEvent>;

export const RunStats = z.object({
  steps: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  issues: z.number().int().nonnegative(),
});
export type RunStats = z.infer<typeof RunStats>;

export const SessionCompletedEvent = z.object({
  sessionId: z.string().min(1),
  status: z.enum(['PASSED', 'FAILED', 'CANCELLED']),
  endReason: EndReason,
  summary: z.string().max(2000),
  stats: RunStats,
  finalState: FinalState.optional(),
});
export type SessionCompletedEvent = z.infer<typeof SessionCompletedEvent>;

/** Event names, so neither side hard-codes strings. */
export const SocketEvents = {
  runStart: 'run:start',
  runCancel: 'run:cancel',
  stepStarted: 'step:started',
  stepCompleted: 'step:event',
  sessionCompleted: 'run:finished',
  agentStatusChange: 'agent-status-change',
  sessionUpdate: (sessionId: string) => `session-update:${sessionId}`,
} as const;
