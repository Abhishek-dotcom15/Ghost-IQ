# Evaluation

Every number in the README comes from this page. Re-run anything here yourself; the commands
are listed with each result.

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
node scripts/bench-bugs.mjs                         # all 8 personas + visual regression run
node scripts/bench-bugs.mjs --personas happy-path   # one persona
node scripts/bench-bugs.mjs --live                  # use your configured LLM instead of demo mode
```

The benchmark uses a throwaway database, runs each persona with the goal "explore the whole
app", marks the first Happy Path run as the visual baseline, restarts the shop with a planted
visual change, runs Happy Path again, then scores the findings against the manifest.

### Results (2026-11-02, demo mode, 80-step budget per persona)

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
The full table above is from the run before that fix and is reported as measured.

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
