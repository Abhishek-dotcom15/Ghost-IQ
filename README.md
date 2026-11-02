# 👻 GhostIQ

[![CI](https://github.com/Abhishek-dotcom15/Ghost-IQ/actions/workflows/ci.yml/badge.svg)](https://github.com/Abhishek-dotcom15/Ghost-IQ/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node 24](https://img.shields.io/badge/node-24_LTS-brightgreen.svg)
![Playwright 1.64](https://img.shields.io/badge/playwright-1.64-2EAD33.svg)

**Virtual users that find the bugs your test suite does not.** GhostIQ sends AI agents with
different user personas through your web app (localhost, staging or production), watches
network traffic, console errors and accessibility, and reports what broke with evidence.

> **Status: v0.8 — CI and distribution.** Phases 0–6 of [the build plan](docs/PLAN.md)
> are done: an agent core with guardrails, eight personas as YAML, 15 oracles that turn what the
> agent sees into deduplicated findings, and now **explore once, replay forever**: a successful run
> replays without an LLM, heals renamed controls (with human review), exports as a plain Playwright
> test, and measures real flakiness. On the bundled seeded-bug benchmark, all eight personas
> together find **29 of 33 bugs (94% of the detectable ones) at 90% precision** — measured in demo
> mode, see [docs/EVALUATION.md](docs/EVALUATION.md) for what that does and does not mean.
> **v0.8 adds CI:** a `ghostiq` CLI with exit codes, a GitHub Action that comments on pull
> requests, GitHub issue export, Slack/webhook notifications and an MCP server for coding agents.
> Next: hardening and hosted deploy (Phase 7).

## CI

```yaml
- uses: Abhishek-dotcom15/Ghost-IQ@v0.8.0
  with:
    target: http://localhost:3000
    personas: happy-path,form-stress-tester
    fail-on: high
    llm-provider: gemini
    llm-api-key: ${{ secrets.GEMINI_API_KEY }}
```

Each pull request gets one GhostIQ comment (per-persona results, findings by severity),
HTML/JUnit/SARIF reports as an artifact, and a pass/fail gate. The same thing runs anywhere
with `ghostiq run -t <url> --fail-on high` (exit 0 pass, 1 findings, 2 config, 3 GhostIQ could
not run). Coding agents can use GhostIQ through `ghostiq mcp`. See [docs/CI.md](docs/CI.md).

## Explore once, replay forever

1. **Explore.** A persona reaches a goal with the LLM planner. GhostIQ records each action with a
   role + accessible-name locator, the values typed, and the end state.
2. **Replay** (Test Sessions → _Replay_, 1-10 runs). The recorded actions run again with **no
   planner model**: deterministic, free, fast. Each step must start on the page the recording was
   on, and the run must end in the same state; a difference fails the replay as a
   _flow regression_.
3. **Heal.** If a control was renamed, the replay looks for the same role with a similar name,
   then asks the model (accepted only at ≥ 85% confidence with a compatible role). Heals wait in
   **Heal Review** with before/after screenshots; approved ones are used from then on. URLs and
   end states are never healed.
4. **Export** a run as a self-contained `.spec.ts` (`@playwright/test` only, no GhostIQ needed).
5. **Flakiness** comes from replays only (same actions and values), so it measures the app, not
   the model. **Analytics** shows route coverage per persona, findings per day, cost per finding,
   endpoint p95 and the false-heal rate.

## Findings

Raw signals from every step become **Findings**: one per defect, merged across steps, runs and
personas, ranked by severity, each with evidence (screenshot, request, console output, detail),
the steps that led to it, and which personas hit it. Triage them as confirmed, dismissed (it stays
dismissed if seen again) or fixed (it reopens automatically if it comes back).

| Oracle           | Finds                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime          | Uncaught exceptions, console errors                                                                                                           |
| Network          | 5xx, failed requests, hanging requests, slow endpoints (average above 800 ms)                                                                 |
| Navigation       | Broken links (404), redirect loops                                                                                                            |
| Idempotency      | The same state-changing request succeeding twice (double submits)                                                                             |
| Validation       | Invalid generated input accepted with a 2xx (flagged _suspected_)                                                                             |
| Accessibility    | axe-core with WCAG 2.0-2.2 A/AA rules, run whenever the page content changes                                                                  |
| Security hygiene | Missing CSP / nosniff / frame protection / HSTS, cookie flags, X-Powered-By, stack traces and secrets in responses, injected script executing |
| Layout & vitals  | Horizontal overflow on responsive pages, layout shift (CLS), slow LCP                                                                         |
| Visual           | Pixel diff of page loads against a baseline run                                                                                               |

Reports for a run or a whole project: **HTML**, **JSON**, **JUnit XML** (CI test tabs) and
**SARIF 2.1.0** (GitHub code scanning).

## Personas

| Persona                      | Focus                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Happy Path User              | Valid flows; checks each step succeeded                                          |
| Chaotic Explorer             | Non-linear navigation, double-clicks, rapid repeats, back/forward                |
| Form Stress Tester           | Empty, boundary, probe and unicode values; double submits                        |
| Impatient User               | Double-clicks, refresh mid-flow, back/forward, on fast 3G                        |
| Keyboard-only User           | Tab/Enter/Space only; clicks are not allowed                                     |
| Mobile User on Slow 3G       | iPhone 13 viewport, slow 3G, occasional offline blips                            |
| Unicode & International User | CJK, Arabic, Hebrew, emoji, combining and zero-width characters                  |
| Security Hygiene Prober      | Opt-in, consent required, never destructive: guessable paths and unescaped input |

Each is a YAML file in [`packages/personas/builtin/`](packages/personas/builtin/). Duplicate one
in the dashboard's Personas page (live validation with line numbers, a preview of generated
values, and a dry run on the demo app), or drop your own YAML into `GHOSTIQ_PERSONAS_DIR`.
Same persona + same seed = the same inputs, pacing and behaviors. See
[docs/PERSONAS.md](docs/PERSONAS.md).

## Quick start

### Option A: Docker (one command)

```bash
docker compose up --build
```

Open http://localhost:3001, pick the demo project and start a run against
`http://mock-app:3000` (the demo app as seen from the runner container).

### Option B: local development

Requires Node 22.12+ (24 LTS recommended) and pnpm 12 (`npm i -g pnpm`).

```bash
pnpm install
pnpm db:setup                                        # SQLite schema + demo project
pnpm --filter @ghostiq/runner browsers:install       # Chromium for Playwright (once)
pnpm dev                                             # server :3001, dashboard :5173, demo app :3000
```

In a second terminal start a runner agent:

```bash
pnpm --filter @ghostiq/runner start -k local-app-test-project-id
```

Open http://localhost:5173 and launch a run against `http://localhost:3000`.

### Using a real model

Without an API key GhostIQ runs in **demo mode**: a scripted planner, labelled `[demo]` in
every step and on the Settings page, so the pipeline can be tried without credentials.

Copy `apps/server/.env.example` to `apps/server/.env` and pick a provider:

| Provider             | Settings                                                                                     | Default model           |
| -------------------- | -------------------------------------------------------------------------------------------- | ----------------------- |
| Gemini               | `GEMINI_API_KEY=...` (provider is then chosen automatically)                                 | `gemini-3.5-flash-lite` |
| Claude               | `GHOSTIQ_LLM_PROVIDER=claude`, `ANTHROPIC_API_KEY=...`                                       | `claude-haiku-5-5`      |
| OpenAI-compatible    | `GHOSTIQ_LLM_PROVIDER=openai`, `GHOSTIQ_LLM_MODEL=...`, key, optional `GHOSTIQ_LLM_BASE_URL` | none                    |
| Ollama (local, free) | `GHOSTIQ_LLM_PROVIDER=ollama`, `GHOSTIQ_LLM_MODEL=llama3.2`                                  | none                    |

Add `GHOSTIQ_LLM_FALLBACK=claude,mock` (for example) to fail over automatically. At boot the
server makes one tiny call and, if the model is retired or the key is wrong, prints exactly what
to change. Every call is metered: the Settings page shows cost and token totals, and each run
shows its own AI cost.

## What works today

| Area          | Today                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent core    | Observe (aria snapshot with element refs) → plan (LLM picks one action from a closed schema) → act → record. Durable role+name locators stored for every target. Short-term memory of the last 6 steps               |
| Guardrails    | Origin allowlist enforced in the browser; destructive-click gate (delete, pay, purchase…); same-origin `navigate` only; snapshot treated as untrusted data; secrets masked in recorded values; popups closed         |
| Budgets       | Max actions, wall time and LLM tokens per run; loop detection; stops after 3 consecutive failed actions; cancel from the dashboard                                                                                   |
| Evidence      | Console errors, uncaught exceptions, 5xx and failed requests recorded per step as issues (the run keeps going); screenshot per step; Playwright trace per run                                                        |
| Runner agent  | Connects out to the server (works on localhost), optional `--storage-state` to start logged in, `--headed` to watch                                                                                                  |
| Telemetry     | Per-request latency and status for fetch/XHR, aggregated per endpoint                                                                                                                                                |
| Accessibility | axe-core (WCAG 2.0-2.2 A/AA) whenever the page content changes                                                                                                                                                       |
| Replay        | No-LLM replay of recorded runs, heal ladder with review queue, Playwright export, replay-based flakiness, analytics                                                                                                  |
| LLM layer     | Gemini, Claude, OpenAI-compatible and Ollama behind one interface; schema-validated output with one repair retry; backoff retries; fallback chain; per-call cost metering; boot health check; record/replay fixtures |
| Dashboard     | Live step trace, baseline screenshot comparison, endpoint charts, AI failure report                                                                                                                                  |
| Engineering   | pnpm monorepo, strict TypeScript, shared zod contract, ESLint/Prettier, Vitest unit + integration tests, end-to-end smoke test, CI, Docker images                                                                    |

## Repository layout

```
apps/
  server/      control plane: Express 5, Socket.IO, Prisma 7 (SQLite)
  runner/      runner agent CLI: Playwright 1.64
  dashboard/   React 19 + Vite
packages/
  shared/      zod schemas for the runner <-> server protocol
  llm/         provider-agnostic LLM client (Gemini, Claude, OpenAI-compatible, Ollama, mock)
  core/        agent loop, guardrails and budgets (browser-independent, fully unit-tested)
  personas/    persona YAML loader, 8 built-in personas, seeded input generators, device/network profiles
examples/
  mock-target-app/   demo shop with 33 labelled bugs (bugs.json)
scripts/smoke.mjs    end-to-end smoke test
docs/                PLAN.md, ARCHITECTURE.md, PERSONAS.md, EVALUATION.md, CI.md
scripts/bench-bugs.mjs  seeded-bug benchmark (recall / precision against bugs.json)
scripts/cli-e2e.mjs     end-to-end check of the ghostiq CLI and MCP server
action.yml           GitHub Action (composite)
```

## Development commands

| Command                      | What it does                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm dev`                   | Run server, dashboard and demo app with reload                                          |
| `pnpm verify`                | Format check, lint, typecheck, tests, build (what CI runs)                              |
| `pnpm test`                  | Unit and integration tests                                                              |
| `pnpm smoke`                 | Full stack end-to-end run (after `pnpm build` and `pnpm db:setup`)                      |
| `pnpm smoke --runs 5 --live` | Goal-completion benchmark with your configured model: success rate, actions, time, cost |

## Roadmap

See [docs/PLAN.md](docs/PLAN.md) for the audit, research notes and the nine phases, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## License

[MIT](LICENSE)
