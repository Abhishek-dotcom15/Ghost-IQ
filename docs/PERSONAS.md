# Writing personas

A persona is a YAML (or JSON) file that tells the agent **who** is using the app. Adding one
needs no code change: create it in the dashboard's **Personas** page, or drop a `.yaml` file in
the folder named by `GHOSTIQ_PERSONAS_DIR` and restart the server.

The eight built-in personas in [`packages/personas/builtin/`](../packages/personas/builtin/)
are the best starting point; duplicate one in the dashboard and edit it.

## Example

```yaml
id: impatient-user
name: Impatient User
description: Rushes through flows, double-clicks, refreshes and goes back mid-way.
traits: >-
  Go straight for the primary action of each page. Do not wait for spinners.
goals:
  - Complete the main sign-up, sign-in or purchase flow as fast as possible.
pacing: { min_ms: 80, max_ms: 300 }
input_strategy: valid
behaviors:
  - { type: double_click, probability: 0.30 }
  - { type: refresh_mid_flow, probability: 0.10 }
device: laptop
network: fast-3g
risk_tolerance: normal
seed: 42
```

## Fields

| Field                      | Default   | Meaning                                                                                            |
| -------------------------- | --------- | -------------------------------------------------------------------------------------------------- |
| `id`                       | required  | Lowercase letters, digits and dashes. Unique; built-in ids are reserved.                           |
| `name`, `description`      | required  | Shown in the UI and given to the planner.                                                          |
| `traits`                   | `""`      | How this user behaves, in plain language. Sent to the planner every step.                          |
| `goals`                    | `[]`      | Default goals; the first is used when a run does not specify one.                                  |
| `pacing.min_ms` / `max_ms` | 200 / 800 | Pause between actions, drawn from the seed.                                                        |
| `typing_delay_ms`          | 0         | Per-keystroke delay; 0 fills fields instantly.                                                     |
| `input_strategy`           | `valid`   | `valid`, `boundary`, `naughty_strings`, `unicode`, `empty` or `mixed`. See below.                  |
| `behaviors`                | `[]`      | Quirks injected after successful actions, each with a `probability` (0-1). See below.              |
| `allowed_actions`          | all       | Restricts the planner, e.g. a keyboard-only user: `[press, fill, select, scroll, wait]`.           |
| `device`                   | `laptop`  | `desktop`, `laptop`, `tablet`, `iphone-13`, `pixel-7`, or `{ width, height, mobile, user_agent }`. |
| `network`                  | `none`    | `none`, `fast-3g` or `slow-3g` (Chromium DevTools throttling).                                     |
| `risk_tolerance`           | `normal`  | `safe` never performs destructive actions, even when a run allows them.                            |
| `requires_consent`         | `false`   | Runs must confirm the tester owns the target (used by the security persona).                       |
| `seed`                     | 42        | Default seed. A run can override it to reproduce or vary a run.                                    |

Unknown or misspelled fields are errors, reported with their line number.

## Input strategies

Form values come from a seeded generator, not from the model, so they are reproducible.
Each value depends only on the seed and the field's role and accessible name, so the same
field gets the same value even if the planner visits fields in a different order.

| Strategy          | Example values                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `valid`           | `ava.chen42@example.test`, `Gh0st-river-4821!`, `+1 555 204 7781`                         |
| `boundary`        | `a@b`, 256- and 1025-character strings, `-1`, `2147483648`, `2026-02-30`                  |
| `naughty_strings` | `' OR '1'='1`, `<script>alert("ghostiq")</script>`, `{{7*7}}`, `../../../../etc/passwd`   |
| `unicode`         | `山田 太郎`, `محمد العربي`, `👨‍👩‍👧‍👦 family`, zero-width and right-to-left override characters |
| `empty`           | `""`                                                                                      |
| `mixed`           | a per-field mix of all of the above                                                       |

With `valid`, the planner may still type an exact value the goal gives it (for example,
specific login credentials); otherwise it asks for a generated one with `<generate>`.

## Behaviors

| Type               | Fires after                | What happens                                   |
| ------------------ | -------------------------- | ---------------------------------------------- |
| `double_click`     | click                      | The same element is clicked again immediately. |
| `rapid_repeat`     | click                      | Clicked `repeat` times in total (default 3).   |
| `refresh_mid_flow` | click, fill, select, press | The page is reloaded.                          |
| `back_forward`     | click, navigate            | Browser back, then forward.                    |
| `tab_hopping`      | any action                 | Tab is pressed `repeat` times (default 3).     |
| `offline_blip`     | click, fill, select, press | The network drops for 3 seconds.               |

Injected steps appear in the run tagged with the behavior name. They never count as planner
decisions, and a failure there (for example a second click after navigation) is recorded
but does not mark the agent as stuck.

## Reproducibility

Same persona + same seed = the same generated inputs, pacing and behavior rolls, given the
same sequence of planner decisions. In demo mode the planner is scripted too, so whole runs
repeat exactly (checked in CI by `scripts/smoke.mjs`). With a real model, the planner may
choose differently between runs; Phase 5's replay mode removes the model entirely.
