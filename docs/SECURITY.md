# GhostIQ security

GhostIQ drives a real browser against URLs its users choose, spends LLM credits on their
behalf and stores screenshots of the apps it tests. This page is the threat model, the
controls, and the checklist for running it anywhere other than your own laptop.

Report a vulnerability privately via GitHub's "Report a vulnerability" (Security tab) rather
than a public issue.

## Modes

| Mode                       | When                              | Sign-in                                                                           |
| -------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| Local (`GHOSTIQ_AUTH=off`) | Your machine, `pnpm dev`, compose | None: whoever reaches the port has full access. Bind to localhost (compose does). |
| Team / hosted (`on`)       | Any shared or public deployment   | GitHub OAuth and/or the admin token; runners and CI use project API keys          |

`GHOSTIQ_AUTH` defaults to **on** when `NODE_ENV=production` (the Docker image), and the
server refuses to start with sign-in on but no way to sign in. The CLI's temporary server
(`ghostiq run` without `--server`) runs with sign-in off on `127.0.0.1` with a random port
and is deleted afterwards.

## Threats and controls

| Threat                                                     | Control                                                                                                                                                                                                                                    | Where                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| Anyone drives a runner or spends LLM credits               | Every API route and socket needs a principal (session cookie, project API key, admin token); deny by default. The planner endpoints only serve runs that are in progress, for callers who may run them                                     | `auth/access.ts`                             |
| One tenant reads another's runs, screenshots or traces     | Project roles (owner / member / viewer) checked centrally per request, including `/screenshots` and `/artifacts`; unknown and forbidden ids both answer 404; Socket.IO events go to per-project rooms joined after an access check         | `auth/access.ts`, `app.ts`                   |
| Stolen database leaks credentials                          | API keys and session tokens are 192+ bit random values stored as SHA-256 only; keys are shown once; revocation is immediate                                                                                                                | `auth/tokens.ts`                             |
| Session theft / CSRF                                       | `HttpOnly`, `SameSite=Lax`, `Secure` (https) cookies; cookie-authenticated writes from another origin are refused; OAuth `state` in a short-lived cookie, compared in constant time; post-login redirect limited to same-site paths        | `auth/routes.ts`                             |
| Open sign-up on a public server                            | GitHub sign-in requires `GHOSTIQ_GITHUB_ALLOWED_USERS` (explicit `*` to allow anyone); the first GitHub user becomes admin                                                                                                                 | `env.ts`                                     |
| Token guessing, API abuse                                  | Rate limits (on whenever sign-in is on): sign-in 20/min per IP, planner 300/min and API 1200/min per caller; `429` with `Retry-After`                                                                                                      | `security/rate-limit.ts`                     |
| SSRF: "test" `http://169.254.169.254` or internal services | Hosted mode resolves every run target and allowed origin and refuses private, loopback, link-local, CGNAT, multicast and reserved ranges (IPv4 and IPv6, incl. mapped), non-http(s) and credentialed URLs; operators can allow named hosts | `security/ssrf.ts`                           |
| The runner leaves the site under test                      | Origin allowlist enforced in the browser; off-site navigations aborted; destructive clicks blocked unless allowed                                                                                                                          | `apps/runner/src/driver.ts`, `packages/core` |
| Prompt injection from tested pages                         | Snapshots fenced as untrusted data; the model can only return actions from a closed schema targeting refs on the page                                                                                                                      | `packages/shared`, `services/ai.ts`          |
| Secrets typed during runs                                  | Values typed into password/token fields are masked before they leave the runner; exports and replays never contain them                                                                                                                    | `packages/core/src/agent.ts`                 |
| XSS / clickjacking of the dashboard                        | CSP (`script-src 'self'`, `frame-ancestors 'none'`), `X-Frame-Options`, `nosniff`, `Referrer-Policy`, HSTS on https; React escapes all text                                                                                                | `security/headers.ts`                        |
| Path traversal in evidence files                           | Static files served by `serve-static` (rejects `..`), names derived from server ids                                                                                                                                                        | `app.ts`                                     |
| Accountability                                             | Audit log of sign-ins (incl. failures), key create/revoke, member changes, visibility, runs, replays, triage, heal decisions, persona edits, refused runners, blocked targets, retention                                                   | `auth/audit*.ts`                             |
| Unbounded data growth                                      | `GHOSTIQ_RETENTION_DAYS` deletes old runs and their files, keeping baselines, runs in progress and any file a finding, heal or baseline still shows                                                                                        | `retention.ts`                               |

## Production checklist

- [x] `GHOSTIQ_AUTH=on` (the default in the image) with `GHOSTIQ_ADMIN_TOKEN` (24+ random characters, e.g. `openssl rand -base64 36`) and/or GitHub OAuth.
- [x] `GHOSTIQ_GITHUB_ALLOWED_USERS` lists the people who may sign in.
- [x] `GHOSTIQ_PUBLIC_URL=https://...` (OAuth callback, `Secure` cookies, HSTS) behind TLS; `GHOSTIQ_TRUST_PROXY=1` behind one proxy so rate limits see client IPs.
- [x] `GHOSTIQ_HOSTED=true` when users other than you choose targets; `GHOSTIQ_ALLOWED_TARGETS` only for hosts you control.
- [x] `GHOSTIQ_CORS_ORIGINS` limited to your dashboard origin (same-origin in the image needs nothing).
- [x] One API key per runner / CI pipeline, named after it; revoke on rotation.
- [x] `GHOSTIQ_RETENTION_DAYS` set to your evidence policy.
- [x] LLM keys only on the server (runners never hold them); set a spending limit at the provider.
- [x] Persistent volume for `/data` with backups (SQLite database, screenshots, traces).
- [ ] Postgres for multi-instance deployments (planned; SQLite supports one server instance).
- [ ] S3-compatible artifact storage (planned; artifacts live on the volume today).

## Known limitations

- Rate limits and the replay queue are per process: run one server instance (SQLite does
  not support more anyway).
- Custom personas are global: any signed-in user can create or edit them (built-ins are
  read-only). Projects and their data are isolated; personas are not.
- The SSRF guard checks targets when a run starts. A DNS answer that changes during the run
  (rebinding) is limited by the runner's origin allowlist but not re-resolved per request;
  run untrusted targets on runners with no access to internal networks.
- In local mode (`GHOSTIQ_AUTH=off`) there is no access control at all, by design.
