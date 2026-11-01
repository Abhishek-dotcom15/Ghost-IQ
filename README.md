# 👻 GhostIQ

[![CI](https://github.com/Abhishek-dotcom15/Ghost-IQ/actions/workflows/ci.yml/badge.svg)](https://github.com/Abhishek-dotcom15/Ghost-IQ/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node 24](https://img.shields.io/badge/node-24_LTS-brightgreen.svg)
![Playwright 1.64](https://img.shields.io/badge/playwright-1.64-2EAD33.svg)

**Virtual users that find the bugs your test suite does not.** GhostIQ sends AI agents with
different user personas through your web app (localhost, staging or production), watches
network traffic, console errors and accessibility, and reports what broke with evidence.

> **Status: v0.2 — foundations.** The prototype has been restructured into a tested monorepo
> (Phase 0 of [the build plan](docs/PLAN.md)). The agent itself is still the prototype loop;
> Phases 1–5 replace it with the provider-agnostic LLM layer, the aria-snapshot agent core,
> personas as data, a findings engine and Playwright export. Nothing below claims more than
> the code does today.

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
every step, so the pipeline can be tried without credentials. To use Gemini, copy
`apps/server/.env.example` to `apps/server/.env` and set `GHOSTIQ_LLM_API_KEY`. The model is
configurable (`GHOSTIQ_LLM_MODEL`, default `gemini-3.5-flash-lite`); Claude, OpenAI-compatible
and Ollama providers arrive in Phase 1.

## What works today

| Area          | Today                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner agent  | Connects out to the server, drives Chromium, streams steps with screenshots                                                                       |
| Telemetry     | Per-request latency and status for fetch/XHR, aggregated per endpoint                                                                             |
| Accessibility | Three built-in checks per step (axe-core/WCAG arrives in Phase 4)                                                                                 |
| Healing       | LLM selector repair on timeout (approval-gated healing arrives in Phase 5)                                                                        |
| Dashboard     | Live step trace, baseline screenshot comparison, endpoint charts, AI failure report                                                               |
| Engineering   | pnpm monorepo, strict TypeScript, shared zod contract, ESLint/Prettier, Vitest unit + integration tests, end-to-end smoke test, CI, Docker images |

## Repository layout

```
apps/
  server/      control plane: Express 5, Socket.IO, Prisma 7 (SQLite)
  runner/      runner agent CLI: Playwright 1.64
  dashboard/   React 19 + Vite
packages/
  shared/      zod schemas for the runner <-> server protocol
examples/
  mock-target-app/   demo app with seeded bugs
scripts/smoke.mjs    end-to-end smoke test
docs/                PLAN.md, ARCHITECTURE.md
```

## Development commands

| Command       | What it does                                                       |
| ------------- | ------------------------------------------------------------------ |
| `pnpm dev`    | Run server, dashboard and demo app with reload                     |
| `pnpm verify` | Format check, lint, typecheck, tests, build (what CI runs)         |
| `pnpm test`   | Unit and integration tests                                         |
| `pnpm smoke`  | Full stack end-to-end run (after `pnpm build` and `pnpm db:setup`) |

## Roadmap

See [docs/PLAN.md](docs/PLAN.md) for the audit, research notes and the nine phases, and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the pieces fit together.

## License

[MIT](LICENSE)
