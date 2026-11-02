# GhostIQ in CI, on the command line and in coding agents

## GitHub Action

Start your app in the job, then point GhostIQ at it. Every pull request gets one GhostIQ
comment (updated on each push), the reports are uploaded as an artifact, and the step fails
on findings at or above `fail-on`.

```yaml
name: GhostIQ
on: pull_request
permissions:
  contents: read
  pull-requests: write # for the comment

jobs:
  ghostiq:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - run: npm start & npx wait-on http://localhost:3000
      - uses: Abhishek-dotcom15/Ghost-IQ@v0.8.0
        with:
          target: http://localhost:3000
          personas: happy-path,form-stress-tester,impatient-user
          goal: Sign up, add a product to the cart and check out.
          fail-on: high
          llm-provider: gemini
          llm-api-key: ${{ secrets.GEMINI_API_KEY }}
```

Without `llm-provider`/`llm-api-key` the run uses demo mode (a scripted planner, labelled in
the comment), which only suits the bundled demo shop. This repository dogfoods the Action in
[`.github/workflows/ghostiq.yml`](../.github/workflows/ghostiq.yml).

| Input           | Default          | Meaning                                                                 |
| --------------- | ---------------- | ----------------------------------------------------------------------- |
| `target`        | (required)       | URL of the running app                                                  |
| `personas`      | `happy-path`     | Comma-separated persona ids                                             |
| `goal`          | persona's own    | What every persona tries to do                                          |
| `max-steps`     | `30`             | Actions per persona                                                     |
| `fail-on`       | `high`           | `critical`, `high`, `medium`, `low`, `info` or `none`                   |
| `new-only`      | `false`          | Only findings first seen in this job count (with a long-lived `server`) |
| `config`        | auto             | `ghostiq.config.{ts,mjs,js,json}`; found in the repo root automatically |
| `server`        | temporary        | Use an existing GhostIQ server instead of a throwaway one               |
| `report-dir`    | `ghostiq-report` | Where reports go                                                        |
| `artifact-name` | `ghostiq-report` | Uploaded artifact (`''` to skip)                                        |
| `comment`       | `true`           | Post/update the PR comment                                              |
| `fail`          | `true`           | Fail the step when the gate fails                                       |
| `llm-*`         | demo mode        | `llm-provider`, `llm-model`, `llm-api-key`                              |

Outputs: `exit-code`, `findings`, `failing-findings`, `report-dir`.

The comment lists each persona's result, the findings by severity and the top 15 findings;
heuristic ("suspected") findings are marked and do not fail the gate unless you ask
(`includeSuspected` in the config). Reports: `report.html`, `junit.xml` (test tab),
`ghostiq.sarif` (upload with `github/codeql-action/upload-sarif` for code scanning),
`report.json`, `summary.md`.

## CLI

`apps/runner/dist/cli.js` (bin `ghostiq`). Build once with `pnpm build`.

```bash
ghostiq init                                   # writes ghostiq.config.mjs
ghostiq run -t http://localhost:3000 -p happy-path,impatient-user --fail-on high
ghostiq run --server http://ghostiq:3001 --project shop --new-only
ghostiq replay <sessionId> -n 5 --server http://ghostiq:3001     # no LLM; fails if a replay diverges
ghostiq export <sessionId> -o tests/checkout.spec.ts --server ...  # plain Playwright test
ghostiq issues --repo owner/shop --min-severity high --server ... # GITHUB_TOKEN; never files twice
ghostiq mcp                                     # MCP server on stdio
ghostiq agent -k <projectId> -u http://ghostiq:3001                # long-lived runner
```

`ghostiq run` without `--server` starts a temporary server (fresh SQLite in a temp dir, a free
port, LLM settings from the environment) and an in-process runner, and stops both at the end.
With `--server` it uses that server (an in-process runner by default, `--no-agent` to use one
that is already connected).

**Exit codes**

| Code | Meaning                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------- |
| 0    | Ran, nothing crossed the threshold                                                                 |
| 1    | Findings at or above `failOn`, a replay diverged, or (with `failOnGoal`) a persona missed the goal |
| 2    | Bad flags or configuration                                                                         |
| 3    | GhostIQ could not run: server unreachable, runner crashed, model unavailable                       |

**Config file** (`ghostiq.config.mjs`; `.ts` needs Node 22.18+, flags override it):

```js
export default {
  target: process.env.GHOSTIQ_TARGET ?? 'http://localhost:3000',
  personas: ['happy-path', 'form-stress-tester'],
  goal: 'Sign up and check out.',
  budgets: { maxSteps: 40 },
  failOn: 'high', // critical | high | medium | low | info | none
  newOnly: false,
  includeSuspected: false,
  failOnGoal: false,
  reports: { dir: 'ghostiq-report', formats: ['html', 'junit', 'sarif', 'json'] },
};
```

## MCP server (coding agents)

`ghostiq mcp` exposes GhostIQ over the Model Context Protocol (stdio), so a coding agent can
check its own change the way a user would. Tools: `ghostiq_run`, `ghostiq_list_findings`,
`ghostiq_get_run`, `ghostiq_replay`, `ghostiq_export_test`, `ghostiq_list_personas`.

```bash
# Claude Code
claude mcp add ghostiq -- node /path/to/Ghost-IQ/apps/runner/dist/cli.js mcp
```

Without `--server` it starts a temporary GhostIQ server for the session; with `--server` it
uses yours (runs then show up in the dashboard).

## Notifications

Set on the server:

| Variable                       | Meaning                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `GHOSTIQ_WEBHOOK_URL`          | POSTed when a run finishes. A `hooks.slack.com` URL gets a Slack message, anything else the JSON event below |
| `GHOSTIQ_WEBHOOK_MIN_SEVERITY` | Only notify for runs with findings at or above this severity                                                 |
| `GHOSTIQ_PUBLIC_URL`           | Dashboard URL for links (`/?session=<id>` opens the run)                                                     |

```json
{
  "event": "run.completed",
  "project": { "id": "…", "name": "Shop" },
  "run": {
    "id": "…",
    "persona": "Happy Path User",
    "mode": "explore",
    "status": "FAILED",
    "endReason": "goal_not_met",
    "url": "https://ghostiq.example.com/?session=…"
  },
  "findings": {
    "total": 3,
    "bySeverity": { "critical": 0, "high": 1, "…": 0 },
    "top": [{ "severity": "high", "title": "…", "route": "/api/login" }]
  }
}
```

Delivery failures are logged and never affect runs.

## Releases

Pushing a `v*.*.*` tag runs [`release.yml`](../.github/workflows/release.yml): the `server`,
`runner` and `mock-app` images go to `ghcr.io/<owner>/ghostiq-<target>` (version, minor and
`latest` tags) and a GitHub release with generated notes is created. The Action is used
straight from the tag.

Not done yet: an npm package (the CLI depends on workspace packages that would need
bundling), diff-aware runs (choosing personas/routes from the changed files).
