import { z } from 'zod';
import { AgentAction } from './agent.js';
import { PersonaBrief } from './persona.js';

/** HTTP contract between the runner's planner client and the control plane. */

export const HistoryItem = z.object({
  stepNumber: z.number().int(),
  kind: z.string(),
  summary: z.string().max(500),
  status: z.enum(['PASSED', 'FAILED', 'SKIPPED']),
  note: z.string().max(500).optional(),
});
export type HistoryItem = z.infer<typeof HistoryItem>;

export const NextActionRequest = z.object({
  sessionId: z.string().min(1),
  goal: z.string().min(1).max(2000),
  persona: PersonaBrief,
  url: z.string().max(2000),
  title: z.string().max(500),
  snapshot: z.string().max(60_000),
  /** Sliding window of recent steps (the agent's short-term memory). */
  history: z.array(HistoryItem).max(10),
  stepNumber: z.number().int().positive(),
  allowDestructive: z.boolean(),
});
export type NextActionRequest = z.infer<typeof NextActionRequest>;

export const NextActionResponse = z.object({
  action: AgentAction,
  usage: z.object({
    tokensIn: z.number().int(),
    tokensOut: z.number().int(),
    costUsd: z.number().nullable(),
  }),
  model: z.string(),
  demo: z.boolean(),
});
export type NextActionResponse = z.infer<typeof NextActionResponse>;

/**
 * Replay's last heal rung: the recorded element is gone and no same-role element has a
 * similar name, so the model is asked which element (if any) now does the same job.
 */
export const HealLocatorRequest = z.object({
  sessionId: z.string().min(1),
  /** The element the recording used. */
  target: z.object({ role: z.string().max(100), name: z.string().max(500) }),
  /** What the recorded step did, e.g. 'Click button "Sign In" (submit the login form)'. */
  description: z.string().max(2000),
  url: z.string().max(2000),
  snapshot: z.string().max(60_000),
});
export type HealLocatorRequest = z.infer<typeof HealLocatorRequest>;

export const HealLocatorOutput = z.object({
  /** Snapshot ref of the element that now does the same job, or null if none does. */
  ref: z.string().max(20).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
});
export type HealLocatorOutput = z.infer<typeof HealLocatorOutput>;

export const HealLocatorResponse = HealLocatorOutput.extend({
  usage: NextActionResponse.shape.usage,
  demo: z.boolean(),
});
export type HealLocatorResponse = z.infer<typeof HealLocatorResponse>;
