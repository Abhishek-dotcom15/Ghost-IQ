# Architecture

GhostIQ has three runtime pieces and one shared contract.

```mermaid
flowchart LR
  subgraph Browser["Your browser"]
    D[Dashboard<br/>React + Vite]
  end
  subgraph CP["Control plane (apps/server)"]
    API[REST API<br/>Express 5]
    WS[Socket.IO hub]
    AI[AI service<br/>packages/llm]
    DB[(SQLite via Prisma 7<br/>Postgres planned)]
    FS[(Screenshots)]
  end
  subgraph R["Runner agent (apps/runner)"]
    PW[Playwright + Chromium]
  end
  T[App under test<br/>localhost, staging, prod]

  D -- REST + websocket --> API
  D -- live updates --> WS
  R -- dials out, websocket --> WS
  R -- plan / heal requests --> API
  API --> AI
  API --> DB
  WS --> DB
  WS --> FS
  PW -- real browser traffic --> T
```

## Why a separate runner

The runner **connects out** to the control plane. That lets one dashboard drive a browser
on a developer laptop (testing `localhost`), inside a CI job (testing a preview URL) or on
a server, without opening inbound ports to the app under test.

## Packages

| Path                       | Role                                                                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`            | Agent loop: observe, plan, act, record. Budgets, loop detection, guardrails and secret masking against a `BrowserDriver`/`Planner` interface. No browser or network dependency.                                                                       |
| `packages/personas`        | Persona specs as data: YAML loader with line-numbered errors, the 8 built-in personas, seeded RNG, input generators (valid/boundary/naughty/unicode/empty/mixed), behavior injection, device and network profiles. See `docs/PERSONAS.md`.            |
| `packages/llm`             | Provider-agnostic LLM client. Thin adapters (Gemini, Claude, OpenAI-compatible/Ollama, mock) behind one core that owns schema validation + one repair retry, backoff retries, timeouts, the fallback chain, caching, cost metering and record/replay. |
| `packages/shared`          | zod schemas for every socket event plus shared helpers. Both server and runner validate against it, so a payload change is a compile error on both sides.                                                                                             |
| `apps/server`              | REST API, Socket.IO hub, persistence, AI orchestration. `createApp()` builds everything without listening, which is what the integration tests use.                                                                                                   |
| `apps/runner`              | CLI (`ghostiq-agent`) that registers with the server and executes runs in Chromium.                                                                                                                                                                   |
| `apps/dashboard`           | React UI. Uses relative URLs; Vite proxies them in dev and the server serves the built files in production, so there is one origin and no URL configuration.                                                                                          |
| `examples/mock-target-app` | Demo target with deliberately seeded bugs; becomes the benchmark app in Phase 4.                                                                                                                                                                      |

## Run lifecycle

```mermaid
sequenceDiagram
  participant D as Dashboard
  participant S as Server
  participant R as Runner (packages/core + Playwright)
  participant L as LLM (packages/llm)
  D->>S: POST /api/sessions {targetUrl, persona, goal, budgets}
  S->>R: run:start {sessionId, goal, config}
  loop until finish, budget, loop, stuck or cancel
    R->>R: observe: ariaSnapshot({mode: 'ai'}) with refs
    R->>S: POST /api/ai/next-action {snapshot, last 6 steps}
    S->>L: generate(PlannerOutput schema)
    L-->>S: one validated action
    S-->>R: {action, usage}
    R->>R: guardrails, then act via page.getByRef(ref)
    R->>S: step:event {status, locator, issues, network, screenshot}
    S-->>D: session-update
  end
  R->>S: run:finished {status, endReason, summary, stats}
  R->>S: PUT /api/sessions/:id/trace (trace.zip)
```

The agent loop (`packages/core`) is browser-independent: it talks to a `BrowserDriver` and a
`Planner` interface, so every budget, guardrail and end condition is unit-tested without a browser.
The runner supplies the Playwright driver and an HTTP planner; the LLM and its keys stay on the server.

**Closed action set.** The model returns one flat JSON object (portable across providers and
small models) that is validated, then converted to a strict union: `click`, `fill`, `select`,
`press`, `hover`, `scroll`, `goBack`, `navigate` (same-origin path only), `wait`, `finish`.
Elements are addressed by snapshot ref, never by a model-invented selector. Each target is also
stored as a durable locator (`page.getByRole(role, { name })`) for replay and export.

**Guardrails.**

| Risk                        | Control                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Leaving the site under test | Origin allowlist checked before `navigate` and enforced in the browser by aborting off-site main-frame navigations; the driver returns to the last allowed page; popups are closed |
| Irreversible actions        | Clicks on elements named like delete / remove / pay / purchase / place order / cancel subscription are skipped (recorded as `destructive_blocked`) unless `allowDestructive`       |
| Prompt injection            | Snapshot is fenced as untrusted data in the prompt; output is schema-limited, so a fooled model can only choose permitted actions on allowed origins                               |
| Runaway runs                | Budgets for actions, wall time and tokens; the same page state 3 times ends the run (`loop_detected`); 3 failed actions in a row end it (`stuck`); cancel at any time              |
| Secret leakage              | Values typed into password/token/key fields are stored and streamed as `••••••`                                                                                                    |

**Bugs never stop a run.** Oracles in the runner attach raw `issues` to each step and the agent keeps going.

## Findings engine

`apps/server/src/findings`: `classify.ts` maps each raw issue to a finding type, route template and severity (pure, unit-tested); `engine.ts` fingerprints it (type + route + rule or normalized message), upserts the project's Finding (recurrence count, personas, latest evidence, repro steps of the first occurrence) and records an occurrence per run. Dismissed findings stay dismissed when they recur; fixed findings reopen as regressions. When a run finishes, run-level oracles execute: slow endpoints (skipped for throttled personas) and accepted invalid input (heuristic, marked _suspected_). Visual regression compares page-arrival screenshots with the baseline run's, keyed by exact path and screenshot size. `reports.ts` renders HTML, JSON, JUnit and SARIF.

## Replay, healing and export (Phase 5)

"Explore once, replay forever." A run that met its goal records everything a replay needs: the
persona spec and seed used, every action with its durable role+name locator, generated-value
provenance, and the end state (`finalStateJson`: URL and up to five headings).

```mermaid
flowchart LR
  REC[Recorded run<br/>goal_met] -->|buildReplayScript| SCRIPT[ReplayScript<br/>actions, locators, values,<br/>start URLs, end state]
  SCRIPT -->|run:start replay| RP[ReplayPlanner<br/>no planner model]
  RP --> LADDER{element found?}
  LADDER -->|exact role+name| ACT[act]
  LADDER -->|same role, similar name ≥0.75| HEAL[heal: fuzzy]
  LADDER -->|model ≥0.85, compatible role| HEALL[heal: llm]
  LADDER -->|no| DIV[replay_diverged<br/>flow_regression finding]
  HEAL --> ACT
  HEALL --> ACT
  HEAL & HEALL --> Q[HealEvent<br/>pending review]
  Q -->|approved| REC
  REC -->|exportPlaywrightSpec| SPEC[.spec.ts<br/>plain Playwright]
```

- **Replay** (`packages/core/src/replay.ts`) is a `Planner` that reads the script instead of
  calling a model. It types the recorded values (masked secrets are regenerated from the seed;
  secrets typed verbatim make a run non-replayable), skips behavior steps (the seeded behaviors
  re-inject them), and turns loop detection off (the script bounds the run).
- **Never healed:** the page each step starts on (compared by origin + route template) and the
  end state. A difference is recorded as an `ASSERT` step that failed with a `replay_diverged`
  issue, which becomes a high-severity `flow_regression` finding.
- **Heal ladder:** exact match → same role with a similar name (best of edit ratio, word
  overlap and containment ≥ 0.75; ties are left to the model) → the model via
  `POST /api/ai/heal-locator`, accepted only at ≥ 0.85 confidence with a compatible role
  (button↔link, textbox↔searchbox, ...). Every heal adds a `ui_change` finding (info) and a
  `HealEvent` with before/after screenshots. Only approved heals are used by export and later
  replays; rejected ones give the false-heal rate.
- **Flakiness** is measured only on replays (same actions, same values):
  `100 × (1 − |2p − 1|)` over the last 20, where p is the pass rate. Replays of one run execute
  one at a time.
- **Export** (`apps/server/src/export/spec.ts`) writes a self-contained `@playwright/test`
  file: `getByRole(role, { name, exact: true })`, URL assertions where the recording navigated,
  and the end state (URL and headings). The smoke test runs the export in plain Playwright.
- **Analytics** (`apps/server/src/analytics`) computes coverage (routes and transitions per
  persona), persona effectiveness, new findings per day, cost per finding, endpoint p50/p95
  and heal outcomes from stored runs.

**End reasons:** `goal_met`, `goal_not_met`, `budget_steps`, `budget_time`, `budget_tokens`,
`loop_detected`, `stuck`, `planner_error`, `start_failed`, `cancelled`, `runner_error`,
`runner_disconnected`, `replay_diverged`.

## Configuration

All configuration is environment variables, validated at startup by `apps/server/src/env.ts`.
See `apps/server/.env.example` and `apps/runner/.env.example`. No model ID is hard-coded.

## LLM calls

Every provider call (initial, retry, repair or cache hit) is written to the `LlmCall` table with provider, model, tokens, latency, estimated cost and outcome. `GET /api/llm/status` aggregates spend (all time and last 24 h) and `GET /api/sessions/:id` includes `llmUsage` for the run. At boot the server makes one tiny real call; a retired model or bad key prints an actionable message (and exits when `GHOSTIQ_LLM_STRICT=true`).

## Known limitations (tracked in `docs/PLAN.md`)

- With `GHOSTIQ_AUTH=off` (local default) there is no access control; shared deployments must turn sign-in on (see [SECURITY.md](SECURITY.md)).
- Login is via `--storage-state` only (no scripted login prelude yet).
- With a real model exploration is not deterministic; replays of a recorded run are.
- Replay matches an element by role and name and takes the first match; repeated identical controls (two "Add to cart" buttons) are not told apart yet.
- Pending replay batches live in server memory: a server restart leaves queued replays `PENDING`.
- SQLite only (one server instance); Postgres and S3-compatible artifacts are planned (Phase 7b).
- Without an LLM key, planning comes from the scripted demo responder (a mock provider), labelled `[demo]` everywhere. It exercises the same LLM pipeline as a real model.
