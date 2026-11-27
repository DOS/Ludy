# 0060. Opt-in GitHub Issue and Pull Request integration for Projects

- Status: **Accepted** (owner JOY approved decisions `D-1` to `D-4` on `2026-11-27 04:07+07:00`, logged in [#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7203423474) and [#5126 comment](https://github.com/DOS/Ludy/issues/5126#issuecomment-7203423822)).
- Date: 2026-11-26 (accepted 2026-11-27)
- Deciders: owner (JOY) for product scope, auth mode (`D-1`), storage boundary (`D-2`), task-key model (`D-3`), and 2-slice `priority:P1` delivery (`D-4`); architectural design authored for [#5126](https://github.com/DOS/Ludy/issues/5126).
- Builds on: [ADR-0018](0018-untrusted-content.md) (untrusted content & taint boundary), [ADR-0025](0025-channel-layer.md) (channel connections & `ludy_kernel.credential`), [ADR-0027](0027-oss-core-and-crove-cloud.md) (self-hosted core without DOS dependencies), [ADR-0029](0029-agents-positions-and-org-chart.md) (agent write guard `#285`, lease rules, taint), [ADR-0031](0031-module-enablement.md) (module enablement), [ADR-0039](0039-bank-feed-connectors.md) (per-connection `:hookKey` webhook pattern), [ADR-0048](0048-projects-on-kernel-tasks.md) (Projects on kernel tasks), [ADR-0053](0053-per-org-app-enablement.md) (`org_app_on` & opaque `404`), [ADR-0054](0054-rebrand-internal-crove-identifiers-to-ludy.md) (`ludy_kernel` & `ludy_projects`), [ADR-0056](0056-projects-v2-cycles-columns-dependencies-privacy.md) (private projects `#2604` & custom columns `#2605`), and [scope.md](../product/scope.md).
- Plan: [projects-github-integration.md](../plan/projects-github-integration.md) (Vietnamese owner summary: [projects-github-integration.vi.md](../plan/projects-github-integration.vi.md)); cross-referenced in [projects.md](../plan/projects.md).
- Issues: [#5126](https://github.com/DOS/Ludy/issues/5126) (Plan & ADR-0060); `Step 0` Invariants, `Slice 1` Inbound Link & Sync, and `Slice 2` Opt-in Two-Way Sync & Vy AI implementation issues TBD (to be opened under `#5126`).

## Context and problem statement

Technical SMEs, software agencies, and solo makers using Ludy Projects track sprints and deliverables on `ludy_projects` boards while engineering commits, Pull Requests (PRs), and GitHub Issues live on GitHub. Meanwhile, Ludy's primary audience of one-person companies (OPCs) and non-software Vietnamese SMEs ([scope.md](../product/scope.md)) must never face GitHub setup screens, extra task-key clutter, or webhook configuration.

Integrating GitHub Issues and PRs into `modules/projects` introduces six architectural and security boundaries that must be settled before Step 0 invariants or migrations are written:

1. **Authentication and credential isolation (`channel-credentials.db.test.ts`):** GitHub API tokens and webhook secrets are high-privilege credentials. In Ludy, `ludy_app` (the HTTP API process) is prohibited from calling `ludy_kernel.credential_get` or `enter_system_context`; only `ludy_worker` opens sealed secrets. Furthermore, self-hosted `docker compose up` deployments ([ADR-0027](0027-oss-core-and-crove-cloud.md)) need a zero-infrastructure fallback if operators have not registered a deployment-level GitHub App.
2. **Kernel task immutability and `#2604` private-project isolation:** Adding GitHub columns directly to `ludy_kernel.task` violates [ADR-0048](0048-projects-on-kernel-tasks.md). Every new `ludy_projects` table carrying `project_id` must enforce `RESTRICTIVE project_visibility` RLS ([ADR-0056](0056-projects-v2-cycles-columns-dependencies-privacy.md)) so private project tasks and repo links remain invisible to non-members.
3. **Webhook intake, signature verification, and `ADR-0053` app gating:** Unauthenticated webhook endpoints in `apps/kernel/src/http.ts` must verify `X-Hub-Signature-256` in constant time over raw bytes, cap payload size and rate, deduplicate `X-GitHub-Delivery` replays, and respect `org_app_on(org_id, 'projects')` + billing entitlement without opening credentials inside `ludy_app`.
4. **Egress allowlist, SSRF defense, and `GuardedRequest` method gap:** Outbound calls must reach `https://api.github.com` only, never follow redirects carrying bearer headers, and never run inside `Runtime.execute()` command handlers (`job-egress.test.ts`). Notably, `GuardedRequest` in `packages/kernel-runtime/src/egress.ts` currently allows only `GET | POST | PUT | DELETE`, omitting `PATCH` needed by GitHub's issue update API.
5. **Two-way sync loop prevention and ADR-0029 agent leases:** In Slice 2, moving a Ludy task to `done` can optionally close a linked GitHub Issue (`PATCH /repos/{owner}/{repo}/issues/{n}`), which triggers GitHub to echo an `issues.closed` webhook back to Ludy. Without explicit echo suppression and agent-lease guards, two-way sync risks infinite ping-pong updates or breaking checked-out AI agent leases.
6. **Untrusted GitHub text tainting and metered Vy AI boundary ([ADR-0018](0018-untrusted-content.md)):** Anyone on a public or collaborator repo can craft malicious Issue/PR titles, bodies, or branch names. Raw GitHub fields must stay `tainted = true`, render without HTML injection, never mutate Ludy task titles or auto-create tasks from unvetted issues, and enter Vy prompts strictly inside `<<< >>>` delimiters with `tools: []`.

## Decision drivers

- **Strict OPC/SME opt-in default:** Projects with `github_enabled = false` render zero GitHub UI, assign zero `task_number` sequences, and create zero webhook or egress surface.
- **Zero plaintext or module-side secrets:** Reuse `ludy_kernel.credential` (`CredentialVault`, `CREDENTIAL_KEY`) so `ludy_projects` holds zero secrets and `ludy_app` never decrypts tokens.
- **No network I/O in commands & `R2` external risk discipline:** All GitHub API requests run exclusively inside `ludy_worker` jobs classified in `apps/kernel/src/jobs-schema.ts` and `job-egress.ts`, while normal board drags stay `R1` `internal`.
- **100% AI-off deterministic parity:** Linking, webhook status sync, outbound close/reopen, and loop-breaking execute deterministically without AI calls.

## Decision

### D1. Dual-mode GitHub authentication via `ludy_kernel.channel_connection` + `ludy_kernel.credential` (`D-1`, `D-2`)

- **Primary (Cloud & multi-member SMEs): GitHub App Installation (`provider = 'github_app'`):**
  - Deployment holds `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_WEBHOOK_SECRET` (+ optional `_PREVIOUS` for rotation).
  - Orgs install the app on selected repositories; `ludy_kernel.channel_connection` stores `(org_id, provider='github_app', external_account_id=<installation_id>, display_name=<github_login>, connected_by)`.
  - `ludy_kernel.credential` seals the installation metadata; `ludy_worker` mints short-lived 1-hour installation access tokens via App JWT when making `api.github.com` calls. Installation survival does not depend on one developer's personal PAT.
- **Fallback (Self-host `docker compose up` without GitHub App): Fine-grained PAT (`provider = 'github_pat'`):**
  - When `GITHUB_APP_ID` is unset (or when an admin chooses PAT mode), an org `owner` or `admin` pastes a repo-scoped Fine-grained PAT. The API route immediately seals `{ accessToken, webhookSecret }` into `ludy_kernel.credential` bound to `(orgId, 'github_pat', externalAccountId)` (`CredentialVault`) and generates an unguessable per-connection webhook URL `/api/projects/github/webhook/:hookKey` (`hook_key_sha256` stored in `ludy_projects.github_webhook_hook`).
- **Kernel channel isolation:** `kernel.channel.list` and Social/Inbox channel screens filter out `github_app` and `github_pat` (parallel to `isAdProviderId` for `_ads`), while keeping `kernel.channel.connect` / `disconnect` (`owner`/`admin`, `R2`), `credential-reseal.ts` key rotation, and `CHANNEL_OWNER_LEFT` offboarding revocation unified with **0** secret columns in `ludy_projects`.

### D2. Minimal `ludy_projects` schema, opt-in task keys, and `#2604` privacy parity (`D-3`)

Keep `ludy_kernel.task` completely unchanged (`ADR-0048`), using `ludy_projects` and `ludy_kernel` schema identifiers (`ADR-0054`):

1. **`ludy_projects.project_task.task_number`:** Nullable `integer` (`UNIQUE (org_id, project_id, task_number) WHERE task_number IS NOT NULL`). Remains `NULL` unless the project configures an opt-in `task_key_prefix` (`^[A-Z][A-Z0-9]{1,9}$`, e.g., `WEB`, unique per org). Backfilled monotonically in `(created_at, id)` order when enabled and incremented atomically under project lock thereafter.
2. **Tenant tables (all with `apply_tenant_rls`, `#285` `agent_write_guard`, and `RESTRICTIVE project_visibility` RLS):**
   - `ludy_projects.github_project_binding`: 1 row per bound project (`project_id` FK, `channel_connection_id` composite FK to `ludy_kernel.channel_connection`, `enabled`, `task_key_prefix`, `next_task_number`, `auto_link_mentions`, `inbound_in_progress_on_pr`, `inbound_done_on_merge`, `outbound_close_issue_on_done DEFAULT false`, `in_progress_column_id`, `done_column_id`).
   - `ludy_projects.github_project_repo`: up to 5 bound repositories per project (`github_repo_id`, `repo_full_name` `pii`, `default_branch`).
   - `ludy_projects.github_task_link`: task-level Issue/PR links (`project_id`, `task_id` composite FK to `project_task (org_id, project_id, task_id) ON DELETE CASCADE`, `repo_full_name`, `kind` `'issue' | 'pull_request'`, `external_number`, `external_url` restricted to `https://github.com/...`, `external_title` `pii`, `external_state` `'open' | 'closed' | 'merged' | 'draft'`, `author_login` `pii`, `branch_name`, `link_source`, `hydrating`, `tainted boolean NOT NULL DEFAULT true CHECK (tainted = true)`, `last_remote_event_at`, `last_outbound_state`, `last_outbound_at`).
3. **Definer-only `MACHINERY` tables (`rls-matrix.db.test.ts` `MACHINERY`, zero grants to login roles):**
   - `ludy_projects.github_webhook_hook`: per-connection PAT hook hash (`hook_key_sha256`), `standing` (`'ok' | 'stopped'`), and 10/hour refusal counter.
   - `ludy_projects.github_webhook_pending` (un-orged GitHub App intake buffer capped at 10,000 rows like `conversation_inbound_pending`) and `ludy_projects.github_webhook_notice` (per-hook PAT intake buffer like `bank_feed_webhook_notice`). Raw bodies are deleted immediately upon worker claim and pruned after 10 minutes by a `keeping` sweep (`runsWhenOff: true`).
   - `ludy_projects.github_sync_delivery`: idempotent sync ledger keyed by `(org_id, project_id, delivery_id)` for inbound and `(org_id, idempotency_key)` for outbound, storing safe status metadata only (zero payloads, zero secrets), enforcing `RESTRICTIVE project_visibility` alongside `MACHINERY` isolation.

### D3. Two-tier webhook verification in `http.ts` and `ADR-0053` app gating

- **`POST /api/projects/github/webhook` (GitHub App):** `256 KB` `bodyLimit`, per-IP `RateLimiter`, constant-time `timingSafeEqual` check of `X-Hub-Signature-256` against `GITHUB_APP_WEBHOOK_SECRET` (+ `_PREVIOUS`) over raw bytes BEFORE JSON parsing (`401 WEBHOOK_SIGNATURE` on mismatch), `X-GitHub-Event` allowlist (`issues`, `pull_request`, `installation`, `installation_repositories`, `ping`), enqueued to `github_webhook_pending`. Worker resolves `org_id` from `installation.id` on `channel_connection` and gates on `org_app_on(org_id, 'projects')` + billing entitlement (`ADR-0053`, `dropped` when off).
- **`POST /api/projects/github/webhook/:hookKey` (PAT fallback):** Validates `128`-bit `hookKey` format (`404` if invalid), looks up `(hook_id, standing)` via definer gating `org_app_on(org_id, 'projects')` + entitlement (`404` opaque when off/unknown per `ADR-0053`), checks per-hook rate limit + `256 KB` cap + header shape, parks notice in `github_webhook_notice`, and defers `X-Hub-Signature-256` verification to `ludy_worker` (the only role permitted to call `credential_get`), auto-stopping the hook after 10 invalid signatures in an hour.
- Both endpoints are registered in `route-coverage.test.ts` and `app-gate-routes.test.ts`.

### D4. Strict `api.github.com` egress allowlist and `GuardedRequest` `PATCH` extension

- All GitHub REST API requests run inside a new `@ludy/github` package exclusively invoked from `ludy_worker` jobs via `guardedRequest` / `egressFetch` (`packages/kernel-runtime/src/egress.ts`) with `httpsOnly: true`, `maxRedirects: 0`, `hostAllowed: (host) => host === 'api.github.com'`, private-IP DNS pinning (`isPublicAddress`), 10-second timeout, and 512 KB response cap.
- Commands (`projects.github.binding.save`, `projects.github.repo.bind`, `projects.github.link.add`, `projects.github.repos.refresh`) declare `risk: 'R2'`, `sideEffect: 'external'`, and perform zero network I/O; manual linking inserts a `hydrating = true` link row and lets `ludy_worker` (`projects-github-hydrate`, egress `['provider:github']`) fetch canonical metadata via `credential_get`.
- **Slice 2 `shared-core` update:** Extend `GuardedRequest['method']` and `egressFetch` in `packages/kernel-runtime/src/egress.ts` from `'GET' | 'POST' | 'PUT' | 'DELETE'` to include `'PATCH'` (subject to Platform PO `shared-core` review) for `PATCH /repos/{owner}/{repo}/issues/{n}`.
- **Sweep isolation:** `projects-github-sweep` (`egress: 'none'`) hands off queued outbound deliveries to `projects-github-outbound` (`egress: ['provider:github']`, `'stately'`), declared in `job-egress.test.ts` `OTHER_SENDS` referencing `projects.github.binding.save` (`R2` `external`), keeping normal board card moves `R1` `internal`.

### D5. Deterministic sync state machine, 3-layer loop-breaker, and ADR-0029 lease safety

- **System status sync command:** Add internal `system`-only `kernel.task.sync_external_status` (`packages/kernel/src/agents.ts`, `access: 'system'`, `risk: 'R1'`, `sideEffect: 'internal'`) because `kernel.task.set_status` calls `requireUser(ctx)`. It refuses updates when an AI agent holds an unexpired lease (`checkout_run_id IS NOT NULL AND lock_expires_at > ctx.now`, causing webhook delivery status `'deferred'` rather than breaking ADR-0029), and updates `status` cleanly (`task_before_update` already handles `system` context).
- **Slice 1 inbound transitions (`projects.github.apply_inbound_event`):**
  - PR opened/reopened/ready mentioning `<PREFIX>-<n>` (or `#/<PREFIX>-<n>` or task URL) on a bound repo creates `github_task_link` and moves `'todo'` -> `in_progress_column_id ?? 'in_progress'` (if `inbound_in_progress_on_pr`).
  - PR merged (`closed` + `merged: true`) with closing keyword (`Fixes|Closes|Resolves <PREFIX>-<n>`) or manual link, or linked GitHub Issue `closed`, moves non-cancelled/non-done task to `done_column_id ?? 'done'` (if `inbound_done_on_merge`).
  - Bare GitHub `#42` mentions in PRs match only via explicit `github_task_link` when GitHub emits `issues.closed` for `#42`, preventing false matches against Ludy task numbers.
- **Slice 2 opt-in outbound + 3-layer loop-breaker:**
  - `outbound_close_issue_on_done` defaults to `false`, requires admin confirmation to enable, and applies strictly to `kind = 'issue'` links (never PRs).
  - **Layer 1:** Inbound transitions pass `syncOrigin = 'github_webhook'`, which never enqueues outbound `PATCH` jobs.
  - **Layer 2:** Outbound enqueue skips whenever `link.external_state === target_remote_state`.
  - **Layer 3:** Worker records `last_outbound_state`, `last_outbound_at`, and GitHub's returned `issue.updated_at` in `last_remote_event_at`; echoed webhooks where `event.issue.updated_at <= link.last_remote_event_at` or state already converged are logged `'skipped'` with zero writes.

### D6. Taint boundary and metered Vy AI coworker (`ADR-0018`, `AI_FEATURES` `'projects'`)

- Every `github_task_link` row enforces `tainted = true` in SQL, strips control/invisible characters (`/\p{Cf}/u`), validates `external_url` strictly as `https://github.com/...`, and renders only as escaped React text.
- Webhooks never modify `ludy_kernel.task.title` or `description` and never auto-create tasks from external issues in MVP.
- Slice 2 adds two metered helpers under `AI_FEATURES` `'projects'` (`packages/agent/src/meter.ts`, `tools: []`, `<<< >>>` fenced):
  - `projects.github_pr_summary`: transient 2-4 sentence Vietnamese status summary of linked issues/PRs checked by `summaryNumbersOutside`, `draftLinksOutside`, and injection guards; never stored.
  - `projects.github_issue_match`: ranks up to 3 candidate issues/tasks from bounded allowlists (`UNKNOWN_ID` fail closed); human clicks **Confirm Link**.

### D7. Lifecycle: `org_purge`, offboarding, PDPL, and Step 0 governance

- **PDPL (`packages/kernel/src/personal-data.ts`):** Registers `github_project_repo.repo_full_name` and `github_task_link.{repo_full_name, external_title, author_login}` (`free_text`, `erase`).
- **Offboarding (`packages/kernel/src/offboarding.ts`):** Exports tenant `github_project_binding`, `github_project_repo`, and `github_task_link`; excludes `MACHINERY` tables (`github_webhook_hook`, `github_webhook_pending`, `github_webhook_notice`, `github_sync_delivery`).
- **Cumulative `ludy_kernel.org_purge` (`shared-core`):** Deletes `github_sync_delivery`, `github_task_link`, `github_project_repo`, `github_project_binding`, `github_webhook_notice`, `github_webhook_hook` ahead of `project_task`, `project`, and `ludy_kernel.channel_connection`.
- **Two-step governance:** Step 0 registers all new tables/routes/deps on the active integration branch (`dev`, promoted to `main`; `PENDING_TABLES`, `MACHINERY`, `route-coverage` `PENDING`, `app-gate-routes` `'pending'`, `job-egress` `PENDING_DEPS`) before Slice 1 or Slice 2 migrations land (issue numbers TBD under `#5126`).

## Consequences

- **Good:** Solo founders and non-dev Vietnamese SMEs see zero setup or UI clutter (`github_enabled = false`), while technical SMEs get Linear-grade PR/Issue tracking backed by Ludy's envelope vault, strict `api.github.com` egress pinning, private-project RLS isolation, and zero-loop two-way sync.
- **Good:** Reusing `ludy_kernel.channel_connection` + `ludy_kernel.credential` eliminates duplicate vault/reseal code and enforces automatic revocation on member removal.
- **Bad / Cost:** Requires Step 0 invariant prep (`shared-core` Platform PO review) plus `shared-core` reviews on Slice 1 (`http.ts`, `org_purge`, `channels.ts`) and Slice 2 (`egress.ts` `'PATCH'` support), alongside Line PO independent security reviews on all protected-path PRs.
- **Neutral:** In PAT mode, per-connection webhook URLs require pasting one generated URL + secret into GitHub repository/org webhook settings (mitigated by clear 1-screen setup instructions and optional GitHub App mode).

## Alternatives considered

1. **Storing encrypted GitHub tokens inside a new `ludy_projects.github_credential` table:** Rejected (`D-2`) because it duplicates `ludy_kernel.credential_put/get/drop`, `credential-reseal.ts`, and `CHANNEL_OWNER_LEFT` membership enforcement already built in [ADR-0025](0025-channel-layer.md).
2. **Verifying per-org PAT webhook signatures synchronously inside `apps/kernel/src/http.ts` (`ludy_app`):** Rejected. Violates Ludy's core privilege separation (`channel-credentials.db.test.ts` forbids `ludy_app` from reading `ludy_kernel.credential`); parking verified-shape notices for `ludy_worker` mirrors [ADR-0039](0039-bank-feed-connectors.md) (`bank-feed-hook.ts`).
3. **Supporting arbitrary GitHub Enterprise Server URLs in MVP:** Rejected by [scope.md](../product/scope.md) (enterprise feature) and SSRF risk; restricting MVP strictly to `https://api.github.com` keeps egress surface minimal (`D-1`/Scope Gate 1).
4. **Polling GitHub REST APIs periodically instead of webhooks:** Deferred. Webhooks provide instant merge/close updates without burning rate limits; a manual/fallback resync button covers missed deliveries without continuous background polling.
5. **Auto-creating Ludy tasks whenever a GitHub issue is opened:** Rejected (`ADR-0018` and `scope.md`). Public/external repositories would allow strangers to inject tainted tasks onto internal SME boards without human triage.

## Revisit when

- Enterprise pilot customers explicitly request GitHub Enterprise Server custom hosts (requires `tenant_url` egress review and Icebox promotion by owner).
- Cross-project GitHub organization dashboards or multi-repo release tracking are requested beyond the 5-repo-per-project SME cap.
