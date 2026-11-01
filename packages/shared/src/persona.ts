import { z } from 'zod';
import { ACTION_TYPES } from './agent.js';

/**
 * A persona is data, not prompt text: a validated spec (YAML or JSON) that controls how
 * the agent behaves. Same persona + same seed = the same generated inputs and behaviors.
 * Keys are snake_case because the spec is written by humans in YAML.
 */

export const INPUT_STRATEGIES = [
  'valid',
  'boundary',
  'naughty_strings',
  'unicode',
  'empty',
  'mixed',
] as const;
export type InputStrategy = (typeof INPUT_STRATEGIES)[number];

export const BEHAVIOR_TYPES = [
  'double_click',
  'rapid_repeat',
  'refresh_mid_flow',
  'back_forward',
  'tab_hopping',
  'offline_blip',
] as const;
export type BehaviorType = (typeof BEHAVIOR_TYPES)[number];

export const NETWORK_PROFILES = ['none', 'fast-3g', 'slow-3g'] as const;
export type NetworkProfile = (typeof NETWORK_PROFILES)[number];

export const DEVICE_PRESETS = ['desktop', 'laptop', 'tablet', 'iphone-13', 'pixel-7'] as const;
export type DevicePreset = (typeof DEVICE_PRESETS)[number];

export const RISK_TOLERANCES = ['safe', 'normal', 'aggressive'] as const;

export const Behavior = z
  .object({
    type: z.enum(BEHAVIOR_TYPES),
    /** Chance (0-1) of injecting the behavior after an eligible step. */
    probability: z.number().min(0).max(1),
    /** Repetitions for rapid_repeat / tab_hopping. */
    repeat: z.number().int().min(2).max(10).optional(),
  })
  .strict();
export type Behavior = z.infer<typeof Behavior>;

export const CustomDevice = z
  .object({
    width: z.number().int().min(240).max(3840),
    height: z.number().int().min(240).max(2160),
    mobile: z.boolean().default(false),
    has_touch: z.boolean().optional(),
    device_scale_factor: z.number().min(1).max(4).optional(),
    user_agent: z.string().max(500).optional(),
  })
  .strict();
export type CustomDevice = z.infer<typeof CustomDevice>;

export const PersonaSpec = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'use lowercase letters, digits and dashes (2-49 chars)'),
    name: z.string().min(1).max(60),
    description: z.string().min(1).max(500),
    /** Extra behavioural guidance for the planner, in plain language. */
    traits: z.string().max(1000).default(''),
    /** Default goals, used when a run does not give one. */
    goals: z.array(z.string().min(1).max(300)).max(10).default([]),
    pacing: z
      .object({
        min_ms: z.number().int().min(0).max(10_000).default(200),
        max_ms: z.number().int().min(0).max(10_000).default(800),
      })
      .strict()
      .refine((p) => p.min_ms <= p.max_ms, { message: 'min_ms must be <= max_ms' })
      .default({ min_ms: 200, max_ms: 800 }),
    /** Per-keystroke delay; 0 fills fields instantly. */
    typing_delay_ms: z.number().int().min(0).max(500).default(0),
    input_strategy: z.enum(INPUT_STRATEGIES).default('valid'),
    behaviors: z.array(Behavior).max(10).default([]),
    /** Restricts which actions the planner may use (finish is always allowed). */
    allowed_actions: z.array(z.enum(ACTION_TYPES)).min(1).optional(),
    device: z.union([z.enum(DEVICE_PRESETS), CustomDevice]).default('laptop'),
    network: z.enum(NETWORK_PROFILES).default('none'),
    /** safe: never perform destructive actions, even if the run allows them. */
    risk_tolerance: z.enum(RISK_TOLERANCES).default('normal'),
    /** Runs need explicit consent (e.g. security probing on a target you own). */
    requires_consent: z.boolean().default(false),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 31 - 1)
      .default(42),
  })
  .strict();
export type PersonaSpec = z.infer<typeof PersonaSpec>;
/** What a persona author writes (defaults not yet applied). */
export type PersonaSpecInput = z.input<typeof PersonaSpec>;

/** The part of a persona the planner needs to see. */
export const PersonaBrief = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  traits: z.string(),
  input_strategy: z.enum(INPUT_STRATEGIES),
  allowed_actions: z.array(z.string()).optional(),
});
export type PersonaBrief = z.infer<typeof PersonaBrief>;

export function personaBrief(p: PersonaSpec): PersonaBrief {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    traits: p.traits,
    input_strategy: p.input_strategy,
    ...(p.allowed_actions ? { allowed_actions: p.allowed_actions } : {}),
  };
}

/** Placeholder the planner uses to ask for a persona-generated value. */
export const GENERATE_TOKEN = '<generate>';
