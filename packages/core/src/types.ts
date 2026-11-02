import type {
  AgentAction,
  EndReason,
  FinalState,
  HealInfo,
  HistoryItem,
  NetworkRequestRecord,
  NextActionRequest,
  RunStats,
  RunTestCommand,
  SnapshotElement,
  StepCompletedEvent,
  StepIssue,
  StepStartedEvent,
} from '@ghostiq/shared';

/** What the agent can see on the current page. */
export interface Observation {
  url: string;
  title: string;
  /** AI-mode aria snapshot (possibly truncated to the token cap). */
  snapshot: string;
  elements: Map<string, SnapshotElement>;
}

/** Everything gathered since the previous collect: evidence for one step. */
export interface StepSignals {
  network: NetworkRequestRecord[];
  issues: StepIssue[];
  a11yViolations?: string;
  screenshotBase64?: string;
}

/**
 * The browser seen by the agent. The runner implements it with Playwright; tests use a fake.
 * `execute` throws when the action could not be performed.
 */
export interface BrowserDriver {
  open(url: string): Promise<void>;
  /** Current page URL (cheap; no snapshot). */
  url(): string;
  observe(): Promise<Observation>;
  execute(action: Exclude<AgentAction, { type: 'finish' }>, signal: AbortSignal): Promise<void>;
  collect(): Promise<StepSignals>;
  /** Simulates losing the network (persona offline_blip behavior). */
  setOffline(offline: boolean): Promise<void>;
}

export interface PlanResult {
  action: AgentAction;
  /** Tokens spent deciding (counted against the token budget). */
  tokens: number;
  /** Replay: the value was fixed in advance (do not generate one); its provenance. */
  input?: StepCompletedEvent['input'];
  /** Replay: the target was found by the heal ladder, not by its recorded locator. */
  heal?: HealInfo;
  /** A check made before this decision, recorded as its own ASSERT step. */
  check?: { description: string; passed: boolean; error?: string; issue?: StepIssue };
  /** Overrides the end reason of a `finish` that did not meet the goal. */
  endReason?: EndReason;
}

/**
 * Chooses the next action. The runner implements it by calling the control plane; replay
 * implements it from a recording (and needs the parsed page, hence `observation`).
 */
export interface Planner {
  next(
    request: NextActionRequest,
    signal: AbortSignal,
    observation: Observation,
  ): Promise<PlanResult>;
}

export interface AgentEvents {
  stepStarted(event: StepStartedEvent): void;
  stepCompleted(event: StepCompletedEvent): void;
}

export interface RunOutcome {
  status: 'PASSED' | 'FAILED' | 'CANCELLED';
  endReason: EndReason;
  summary: string;
  stats: RunStats;
  /** Set when the goal was met: the page state that counted as success. */
  finalState?: FinalState;
}

export interface AgentOptions {
  command: RunTestCommand;
  driver: BrowserDriver;
  planner: Planner;
  events: AgentEvents;
  signal: AbortSignal;
  /** Steps of history sent to the planner. */
  memorySize?: number;
  /** Characters of snapshot sent to the planner (~4 chars per token). */
  snapshotCharLimit?: number;
  /** Times the same page state may be seen before the run ends as a loop. */
  loopThreshold?: number;
  /** Consecutive failed actions before the run ends as stuck. */
  maxConsecutiveFailures?: number;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export type { HistoryItem };
