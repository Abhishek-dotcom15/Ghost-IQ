import { z } from 'zod';

/**
 * Socket.IO contract between the runner agent and the control plane.
 * Both sides import these schemas; the server validates every inbound payload.
 * Event names follow the v1 protocol used by the original prototype and will be
 * migrated to the namespaced protocol (`run:start`, `step:event`, ...) in Phase 2.
 */

export const STEP_ACTIONS = ['GOTO', 'CLICK', 'TYPE', 'ASSERTION', 'COMPLETE', 'FAIL'] as const;
export const StepActionType = z.enum(STEP_ACTIONS);
export type StepActionType = z.infer<typeof StepActionType>;

export const StepStatus = z.enum(['PASSED', 'FAILED']);
export type StepStatus = z.infer<typeof StepStatus>;

export const SessionStatus = z.enum(['PENDING', 'RUNNING', 'PASSED', 'FAILED']);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const NetworkRequestRecord = z.object({
  url: z.string().max(4096),
  method: z.string().max(16),
  status: z.number().int().min(0).max(999),
  latencyMs: z.number().int().nonnegative(),
});
export type NetworkRequestRecord = z.infer<typeof NetworkRequestRecord>;

export const RunTestCommand = z.object({
  sessionId: z.string().min(1),
  targetUrl: z.url(),
  persona: z.string().min(1).max(100),
  goal: z.string().min(1).max(2000),
});
export type RunTestCommand = z.infer<typeof RunTestCommand>;

export const StepStartedEvent = z.object({
  sessionId: z.string().min(1),
  stepNumber: z.number().int().positive(),
  action: StepActionType,
  description: z.string().max(2000),
});
export type StepStartedEvent = z.infer<typeof StepStartedEvent>;

/** ~10 MB of base64 is the hard ceiling the server accepts for a screenshot. */
const MAX_SCREENSHOT_BASE64 = 10 * 1024 * 1024;

export const StepCompletedEvent = StepStartedEvent.extend({
  status: StepStatus,
  error: z.string().max(20_000).optional(),
  selector: z.string().max(2000).optional(),
  value: z.string().max(5000).optional(),
  screenshotBase64: z.string().max(MAX_SCREENSHOT_BASE64).optional(),
  a11yViolations: z.string().max(200_000).optional(),
  networkRequests: z.array(NetworkRequestRecord).max(1000).default([]),
});
export type StepCompletedEvent = z.infer<typeof StepCompletedEvent>;

export const SessionCompletedEvent = z.object({
  sessionId: z.string().min(1),
  status: z.enum(['PASSED', 'FAILED']),
});
export type SessionCompletedEvent = z.infer<typeof SessionCompletedEvent>;

/** Event names, so neither side hard-codes strings. */
export const SocketEvents = {
  runTest: 'run-test',
  stepStarted: 'step-started',
  stepCompleted: 'step-completed',
  sessionCompleted: 'session-completed',
  agentStatusChange: 'agent-status-change',
  sessionUpdate: (sessionId: string) => `session-update:${sessionId}`,
} as const;
