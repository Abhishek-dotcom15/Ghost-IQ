# Evaluation

Every number in the README comes from this page. Re-run anything here yourself; the commands
are listed with each result.

## Running benchmarks

Every benchmark script (`scripts/bench-*.mjs`) shares these options (`scripts/lib/eval.mjs`):

| Option                   | Meaning                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| _(none)_                 | Demo mode: the scripted planner, no AI, no cost. Checks the pipeline and the oracles.        |
| `--live`                 | Use the model configured in `apps/server/.env`.                                              |
| `--model provider:model` | Use this model, e.g. `gemini:gemini-3.5-flash-lite` or `ollama:llama3.2` (implies `--live`). |
| `--max-cost-usd N`       | **Required for paid live runs.** Stops the benchmark once the measured LLM spend passes N.   |
| `--runs N`               | Repeat each persona or task N times.                                                         |
| `--seed N`               | Base seed for persona inputs (run _i_ uses N + _i_), to reproduce a run exactly.             |
| `--json`                 | Print the result JSON on stdout; progress goes to stderr.                                    |
| `--verbose`              | Show the logs of the demo app, server and runner.                                            |

Safety rules built into the cost guard: a live run with a paid provider refuses to start
without `--max-cost-usd`; fallbacks are switched off in live mode, so a failing model is never
silently replaced by the scripted planner; a live run stops if the server fell back to demo mode
(e.g. missing key) or if a model has no known price (set `GHOSTIQ_LLM_PRICE_INPUT` and
`GHOSTIQ_LLM_PRICE_OUTPUT`). Spend is read from the server's own LLM metering.

Each run writes `evals/results/<bench>-<date>-<provider>-<model>.json` (git-ignored) in one
format: `{ format, bench, provider, model, mode, gitSha, startedAt, finishedAt, params, runs,
summary, costUsd, tokens, llmCalls }` plus benchmark-specific detail. `pnpm eval:report` renders
the newest result per configuration into the marked tables on this page, so published numbers
are never typed by hand. To run next to a local instance on ports 3000/3001, set
`GHOSTIQ_STACK_SERVER_PORT` and `GHOSTIQ_STACK_TARGET_PORT` (e.g. 4001 and 4000).

## B1: seeded bugs (oracle recall and precision)

**Setup.** The demo shop in [`examples/mock-target-app`](../examples/mock-target-app) contains
33 labelled bugs across 11 categories, listed in
[`bugs.json`](../examples/mock-target-app/bugs.json) with the finding that counts as detecting
each one. 30 were planted on purpose; 3 were real defects GhostIQ found in the shop during the
first benchmark run and were added (marked `discovered`) rather than counted as false positives.
2 auth-boundary bugs (admin page without login, IDOR on account pages) are marked as not
detectable by any current oracle and are kept to keep recall honest.

```bash
pnpm build
node scripts/bench-bugs.mjs --steps 80              # all 8 personas + visual regression run
node scripts/bench-bugs.mjs --personas happy-path   # one persona
node scripts/bench-bugs.mjs --live --max-cost-usd 0.50   # your configured LLM, with a spend limit
pnpm eval:report                                    # refresh the generated tables below
```

The benchmark uses a throwaway database, runs each persona with the goal "explore the whole
app", marks the first Happy Path run as the visual baseline, restarts the shop with a planted
visual change, runs Happy Path again, then scores the findings against the manifest.

### Latest results (generated)

The tables in this section are written by `scripts/eval-report.mjs` from the result files in
`evals/results/` (the newest result per configuration); do not edit them by hand.

<!-- eval:B1:start -->

| Planner                 | Personas       | Steps | Runs | Recall, all bugs | Recall, detectable | Precision      | LLM cost | Time   | Date       | Commit    |
| ----------------------- | -------------- | ----- | ---- | ---------------- | ------------------ | -------------- | -------- | ------ | ---------- | --------- |
| demo (scripted planner) | all 8 + visual | 80    | 1    | 29 / 33 (88%)    | 29 / 31 (94%)      | 37 / 37 (100%) | none     | 13 min | 2026-11-03 | `16c451a` |
| demo (scripted planner) | happy-path     | 80    | 1    | 20 / 33 (61%)    | 20 / 31 (65%)      | 28 / 28 (100%) | none     | 86 s   | 2026-11-03 | `16c451a` |

<!-- eval:B1:end -->

Found per category:

<!-- eval:B1-categories:start -->

| Category      | #1    | #2    |
| ------------- | ----- | ----- |
| accessibility | 5 / 5 | 5 / 5 |
| server_error  | 2 / 3 | 2 / 3 |
| performance   | 4 / 4 | 4 / 4 |
| navigation    | 3 / 3 | 3 / 3 |
| runtime       | 2 / 2 | 2 / 2 |
| idempotency   | 3 / 3 | 0 / 3 |
| validation    | 3 / 3 | 0 / 3 |
| security      | 5 / 6 | 4 / 6 |
| auth          | 0 / 2 | 0 / 2 |
| layout        | 1 / 1 | 0 / 1 |
| visual        | 1 / 1 | 0 / 1 |

Columns #1-#2 follow the rows of the table above.

<!-- eval:B1-categories:end -->

### First full run (2026-11-02, demo mode, 80-step budget per persona)

| Metric                         | Value                      |
| ------------------------------ | -------------------------- |
| Recall, all 33 bugs            | **29 / 33 (88%)**          |
| Recall, the 31 detectable bugs | **29 / 31 (94%)**          |
| Precision vs the manifest      | **37 / 41 findings (90%)** |
| Wall time, 9 runs              | 12 min                     |

| Category                                  | Found                 |
| ----------------------------------------- | --------------------- |
| Accessibility (axe-core, WCAG 2.x)        | 5 / 5                 |
| Performance (slow, hanging, layout shift) | 4 / 4                 |
| Navigation (broken links, redirect loop)  | 3 / 3                 |
| Runtime errors                            | 2 / 2                 |
| Idempotency (double submits)              | 3 / 3                 |
| Validation (invalid input accepted)       | 3 / 3                 |
| Server errors                             | 2 / 3                 |
| Security hygiene                          | 5 / 6                 |
| Layout (mobile overflow)                  | 1 / 1                 |
| Visual regression                         | 1 / 1                 |
| Auth boundaries                           | 0 / 2 (no oracle yet) |

**Missed:**

- _Order quantity above 99 crashes the server._ No persona's seeded values happened to exceed 99
  in the quantity field (boundary values are drawn per field from a list).
- _Search term reflected as HTML (XSS)._ Only one of the 15 probe strings executes through
  `innerHTML`, and no persona drew it for the search box with these seeds.

**False positives:** the 4 unmatched findings were all "horizontal overflow" on pages without a
responsive viewport tag, which phones lay out at desktop width. The oracle now skips such pages;
re-running the mobile persona afterwards gave 27 / 27 findings matching the manifest (100%).
The table in this section is from the run before that fix and is reported as measured; the full
re-run on 2026-11-03 (generated table above) found the same 29 bugs with 37 / 37 findings
matching the manifest (100%).

**Per persona** (who found what, and what only they found):

- Every persona finds the site-wide issues (headers, cookies, accessibility on shared pages).
- Duplicate submissions were found only by personas with double-click / rapid-repeat behaviors
  (Chaotic Explorer, Form Stress Tester, Impatient User).
- Missing validation was found only by personas with non-valid input strategies (Form Stress
  Tester, Chaotic Explorer, Security Hygiene Prober).
- The debug endpoint leaking secrets was found only by the Security Hygiene Prober (guessed paths).
- The mobile overflow was found only by the Mobile User on Slow 3G.

### What this does and does not show

- **Demo mode is a scripted crawler, not an AI.** It fills every field with persona-generated
  values and clicks every control. This benchmark therefore measures the **oracles and
  personas**: given the agent reaches a bug, is it detected and correctly attributed? It does
  not measure how well an LLM explores. That is benchmark B2 (goal completion with a real
  model), which needs an API key: `node scripts/bench-bugs.mjs --live`.
- The manifest and the app were written by the same author as the oracles. That is a known bias
  of seeded-bug benchmarks; Phase 8 adds third-party apps (TodoMVC, RealWorld, OWASP Juice Shop).
- Demo mode is deterministic, so CI guards against oracle regressions by running one persona and
  requiring at least 60% recall of detectable bugs (Happy Path alone currently reaches 65%,
  20 / 31, with 28 / 28 precision).

## B2-B5

Goal completion with real models, healing, model ablation and reproducibility are planned for
Phases 5 and 8 (see [PLAN.md](PLAN.md)). Phase 2-3 smoke checks (`node scripts/smoke.mjs`)
already verify that the demo login flow completes 5/5 and that the same seed reproduces the same
inputs and behaviors end to end.
