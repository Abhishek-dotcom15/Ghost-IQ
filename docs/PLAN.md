# GhostIQ — Build Plan (v2)

Status: Phase 0 complete (v0.2.0). Next: Phase 1. Last updated: 2026-11-01.
Source idea: `GhostIQ_Project_Blueprint.pdf`. This document records where the code
really stands, what changed in the research, and the phase plan we will execute.

---

## 1. Audit of the current code (what the blueprint could not see)

The blueprint was written from the README only. Reading the code (~2.7k lines) shows:

| #   | Finding                                                                                                                  | Where                                         | Impact                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Any `console.error` marks the step FAILED and **aborts the run**                                                         | `cli-agent/src/runner.ts:311-317, 407-412`    | Exploratory run stops at the first bug it finds — the opposite of exploration. Bugs must become Findings, run continues. |
| 2   | Heal accepted at **confidence > 0.4**                                                                                    | `runner.ts:280`                               | Silently "passes" steps on weak guesses — exactly the false-confidence risk the blueprint warns about.                   |
| 3   | Mock planner/healer are hard-coded scripts (`stepsCount === 3 → FAIL` for Chaotic persona; heal only knows `submit-btn`) | `backend/src/services/ai.ts:180-249, 260-274` | Demo results are scripted, not discovered. Must be labelled Demo Mode and replaced by a real deterministic explorer.     |
| 4   | LLM picks raw CSS selectors from serialized HTML; page text goes straight into the prompt                                | `runner.ts:125-164`, `ai.ts:43-84`            | Hallucinated selectors; prompt-injection surface; no output validation (`JSON.parse` only).                              |
| 5   | Model ID `gemini-2.5-flash` hard-coded in 3 places; any API error silently falls back to mock                            | `ai.ts:88,165,303`                            | Real failures look like success.                                                                                         |
| 6   | No auth anywhere: CORS `*`, project ID = agent key, `/api/ai/*` open, `io.emit` broadcasts every session to every client | `backend/src/server.ts`                       | Anyone reachable can drive a runner or spend LLM credits.                                                                |
| 7   | Network timing keyed by URL in a Map                                                                                     | `runner.ts:28-53`                             | Parallel requests to the same URL overwrite each other. Use `request.timing()`.                                          |
| 8   | One shared `this.browser`, `maxSteps = 10` hard-coded                                                                    | `runner.ts:5,69`                              | Concurrent sessions clobber each other; budgets not configurable.                                                        |
| 9   | "Flakiness score" = pass/fail transitions across _different_ AI runs                                                     | `server.ts:199-227`                           | Measures LLM variance, not app flakiness. Only meaningful on deterministic replays.                                      |
| 10  | PR export just returns a markdown string                                                                                 | `server.ts:500-546`                           | Not a CI integration.                                                                                                    |
| 11  | No tests, no CI, no Docker, Prisma 5 + SQLite with `db push`, Playwright `^1.43`                                         | manifests                                     | Reviewers check these first.                                                                                             |

Keep: the runner ↔ control-plane split, Socket.IO streaming, dashboard views (re-skinned), endpoint-health idea, mock target app (to be extended).

---

## 2. Research updates to the blueprint

### 2.1 LLM models (checked 2026-11-01)

- Google's deprecations page **currently lists no shutdown date for `gemini-2.5-flash` on the Developer API**, while Vertex AI retires 2.5 on 2026-10-20 and third-party reports conflict. Conclusion is unchanged: **never hard-code a model**. Google's changelog says new projects should use **`gemini-3.8-flash`** or **`gemini-3.5-flash-lite`**.
- Defaults we will ship (all overridable by env): Gemini `gemini-3.5-flash-lite` (cheap planner), `gemini-3.8-flash` (heal/judge); Claude `claude-haiku-5-5`; OpenAI-compatible (covers Ollama/local); Mock.
- Verify model IDs and prices again at the start of Phase 1.

### 2.2 Playwright moved a lot (1.43 → 1.64.1)

This removes a lot of custom work from the blueprint's Phase 2 and adds new capabilities:

| Version | Feature                                                                                                                                           | How GhostIQ uses it                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.56    | Test agents (planner/generator/healer); `page.consoleMessages()`, `page.pageErrors()`, `page.requests()`                                          | Positioning: we complement them, and export specs they can maintain.                                                                               |
| 1.59    | `page.ariaSnapshot()`, `mode`/`depth`; **`page.screencast`** with `showChapter()`/`showActions()` ("agentic video receipts"); `setStorageState()` | Observation layer; **narrated video evidence per finding**.                                                                                        |
| 1.60    | `tracing.startHar()`; aria `boxes`                                                                                                                | HAR evidence per run; element geometry for visual oracles.                                                                                         |
| 1.62    | Bundled MCP + `playwright-cli`; `AbortSignal` on operations                                                                                       | Clean run cancellation (`run:cancel`).                                                                                                             |
| 1.63    | `ariaSnapshotJSON()`; traces with aria snapshots                                                                                                  | Structured observation without parsing YAML.                                                                                                       |
| 1.64    | **`page.ariaSnapshot({ mode: 'ai' })` refs + `page.getByRef('e12')`**; `page.webmcp`                                                              | The blueprint's "numbered element refs" is now native. LLM returns a ref; we resolve with `getByRef`, then persist a role+name locator for export. |

### 2.3 Market (vendor roundups, treat as indicative)

Category split confirmed: managed QA (QA Wolf), autonomous agents (QA.tech), enterprise (Tricentis, mabl), coding-agent plug-ins (KaneAI as a Claude Code / Codex skill). Recurring buyer criteria: **who owns the test code**, transparency of healing, exploratory coverage, self-hosting. GhostIQ's position (open source, self-hosted, local-first, export to plain Playwright, transparent heals) fits these gaps.

---

## 3. Features added beyond the blueprint

Chosen for demo value plus engineering depth; each is assigned to a phase.

1. **Video receipts for findings** (Phase 4) — Playwright screencast with chapters per step; each Finding links to the clip around its step.
2. **HAR per run** (Phase 4) — network evidence and the seed data for the API-persona module.
3. **Exploration coverage graph** (Phase 4/5) — states = hash(URL + aria snapshot); edges = actions. Dashboard shows which states each persona reached and where findings cluster. This is the main data-analytics view.
4. **QA analytics dashboard** (Phase 5) — unique findings per persona, findings over time, time-to-first-finding, cost per finding, precision from triage, real flakiness from deterministic replays, endpoint p50/p95.
5. **Diff-aware CI runs** (Phase 6) — given changed files in a PR, map them to routes (config + heuristics) and point persona goals at those routes first.
6. **Issue tracker export** (Phase 6) — create GitHub Issues from findings with evidence links (Jira/Linear later).
7. **GhostIQ MCP server** (Phase 6, was a stretch) — tools `run_personas`, `get_findings`, `export_spec` so Claude Code/Cursor can verify their own changes.
8. **Voice (Whisper) — optional, Phase 9** — dictate a test goal or narrate a manual exploratory session; transcribe locally (whisper.cpp) or via a provider transcription model, and turn it into persona goals. Useful but not core; built only after launch.
9. **Vision LLM judge** (Phase 4, flagged "suspected") — screenshot check for obviously broken layouts when no deterministic oracle applies.

---

## 4. Target stack

- **Monorepo**: pnpm 12 workspaces (recursive runs in dependency order; Turborepo dropped because its Windows binary failed to load, revisit if build times grow). Node 24 LTS. TypeScript 6.0 strict (7.0 once typescript-eslint supports it). ESLint 10 + Prettier. Vitest 5. Husky + lint-staged. `minimumReleaseAge` of 14 days on every dependency.
- **apps/server**: Express 5 (or Fastify) + Socket.IO, zod validation, Prisma 6, SQLite (dev) / Postgres (prod), pino logs, BullMQ+Redis optional for run queue.
- **apps/runner**: CLI (`ghostiq`), Playwright 1.64, `@axe-core/playwright`, pixelmatch.
- **apps/dashboard**: React 18 + Vite, TanStack Query, React Router, Recharts, Socket.IO client.
- **packages/**: `shared` (zod schemas + types), `llm` (providers), `core` (agent loop, oracles, healer, exporter), `personas` (YAML specs + generators).
- **Infra**: Dockerfiles, `docker compose up`, GitHub Actions CI, GHCR image, npm package.

---

## 5. Phases

Each phase ends demoable, tested and committed. Sizes assume part-time work.

| Phase | Name                            | Key deliverables                                                                                                                                                                                                                                                                                                                                                  | Done when                                                                                            |
| ----- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **0** | Foundations                     | Tag `v0.1.0`; pnpm monorepo; move existing code into `apps/*`; strict TS, lint, Vitest; `.env.example`; Docker + compose; CI (lint/typecheck/test/build); `docs/ARCHITECTURE.md`                                                                                                                                                                                  | `docker compose up` works from a fresh clone, CI green                                               |
| **1** | LLM layer                       | `LlmProvider` + Gemini / Claude / OpenAI-compatible / Mock adapters; zod structured output + 1 repair retry; timeouts/backoff; fallback chain with visible flag; `LlmCall` metering; boot health check; record/replay fixtures                                                                                                                                    | Provider switch = 1 env var; unit suite runs offline                                                 |
| **2** | Agent core v2                   | Upgrade Playwright 1.64; AI-mode aria snapshot + `getByRef`; closed action schema; persisted role+name locators; budgets (steps/time/tokens); loop detection; origin allowlist; destructive-action gate; injection-safe prompt; storageState login prelude; trace.zip; **bugs no longer abort runs**; per-session browser context; AbortSignal cancel             | Agent completes goals on mock app over 5 seeded runs; baseline success rate recorded                 |
| **3** | Personas as data                | Persona zod schema + YAML loader with line-numbered errors; seeded input generators (valid/boundary/naughty/unicode/empty); behavior injectors; device + network profiles; 8 built-in personas; Persona Builder UI with dry run                                                                                                                                   | New persona added without code; same seed ⇒ same inputs                                              |
| **4** | Findings & oracles              | Oracle plugin API; runtime, network, latency, navigation, axe-core, validation, visual (pixelmatch + masks), security headers, web vitals, vision judge; Finding model with fingerprint/dedupe/evidence/repro; **video receipts + HAR**; coverage graph data; Findings inbox; HTML/JSON/JUnit/SARIF reports; mock app extended to ~25 labelled bugs + `bugs.json` | Run on mock app ⇒ deduped, severity-ranked findings, each with evidence and repro → **release v0.5** |
| **5** | Heal, replay, export, analytics | Heal ladder (stored alternates → fuzzy role/name → LLM ≥0.85 + role check); HealEvent audit + review queue; no-LLM replay; real flakiness over N replays; `.spec.ts` exporter; analytics dashboard + coverage graph view                                                                                                                                          | Exported spec passes in plain Playwright with no GhostIQ installed                                   |
| **6** | CI & distribution               | `ghostiq run/replay/export` CLI with exit codes + `ghostiq.config.ts`; GitHub composite Action with PR comment + artifacts; diff-aware runs; GitHub Issues export; MCP server; npm + GHCR release workflow; webhooks/Slack                                                                                                                                        | A PR in a demo repo gets a GhostIQ comment automatically                                             |
| **7** | Hardening & deploy              | GitHub OAuth; hashed API keys; authenticated sockets + per-room events; rate limits; audit log; Postgres migrations; S3-compatible artifacts + retention; SSRF guard for hosted mode; `docs/SECURITY.md`; deploy server + dashboard; read-only demo project                                                                                                       | Public demo URL; security checklist complete                                                         |
| **8** | Evaluation & launch             | Benchmarks B1–B5 (seeded bugs, goal completion on 3 apps, healing mutations, model ablation, reproducibility); `docs/EVALUATION.md`; demo video + GIFs; CONTRIBUTING, templates                                                                                                                                                                                   | README shows live demo, CI badge, measured numbers → **release v1.0**                                |
| **9** | Stretch                         | API-persona module (from HAR/OpenAPI); voice goals (Whisper); Firefox/WebKit matrix; WebMCP tool testing; shared persona library                                                                                                                                                                                                                                  | —                                                                                                    |

### Working rules

- Commit small and often; push daily; tag each phase.
- No number goes in the README or resume unless it came from Phase 8 benchmarks.
- The mock LLM is a test double and "Demo mode", never presented as AI.

---

## 6. Sources

- Gemini deprecations: https://ai.google.dev/gemini-api/docs/deprecations
- Gemini changelog: https://ai.google.dev/gemini-api/docs/changelog
- Vertex 2.5 retirement write-up: https://medium.com/@shtse8/gemini-2-5-on-vertex-ai-retires-october-20-what-to-switch-to-and-what-it-costs-b56dd29479bd
- Playwright release notes: https://playwright.dev/docs/release-notes
- Playwright 1.64 overview: https://testdino.com/blog/playwright-1-64-release
- Playwright 1.59 (screencast, agent interop): https://bug0.com/blog/whats-new-playwright-1-59
- Agentic QA roundups: https://qa.tech/blog/best-agentic-qa-tools-in-2026 , https://katalon.com/resources-center/blog/agentic-qa-tools , https://www.shiplight.ai/blog/best-agentic-qa-tools-2026 , https://www.testmuai.com/blog/agentic-ai-testing-tools/
- whisper.cpp overview: https://www.promptquorum.com/power-local-llm/whisper-cpp-review
