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
