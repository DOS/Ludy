# Projects Opt-In GitHub Issue and Pull Request Integration: Plan

> **Status: Accepted** (owner JOY approved decisions `D-1` to `D-4` as recommended on `2026-11-27 04:07+07:00`, logged in [#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7203423474) and [#5126 comment](https://github.com/DOS/Ludy/issues/5126#issuecomment-7203423822)). Date: 2026-11-26 (accepted 2026-11-27). Target milestone: `M3 Paid pilot` (scheduled behind active Projects v2 / Omnichannel backlog per `D-4`), line `line:projects`, `priority:P1`, plan & ADR issue [#5126](https://github.com/DOS/Ludy/issues/5126) (`Step 0`, `Slice 1`, and `Slice 2` implementation issues TBD, to be opened under `#5126`).
>
> Builds on [projects.md](projects.md), [projects-v2.md](projects-v2.md), [projects-public-roadmap.md](projects-public-roadmap.md), [projects-signals-triage.md](projects-signals-triage.md), [ADR-0018](../adr/0018-untrusted-content.md), [ADR-0025](../adr/0025-channel-layer.md), [ADR-0027](../adr/0027-oss-core-and-crove-cloud.md), [ADR-0029](../adr/0029-agents-positions-and-org-chart.md), [ADR-0031](../adr/0031-module-enablement.md), [ADR-0048](../adr/0048-projects-on-kernel-tasks.md), [ADR-0053](../adr/0053-per-org-app-enablement.md), [ADR-0054](../adr/0054-rebrand-internal-crove-identifiers-to-ludy.md), [ADR-0056](../adr/0056-projects-v2-cycles-columns-dependencies-privacy.md), and [scope.md](../product/scope.md). Governing decision record: [ADR-0060](../adr/0060-projects-github-issue-pr-sync.md) (`Accepted`). Vietnamese owner summary: [projects-github-integration.vi.md](projects-github-integration.vi.md).

## 1. Goal, OPC/SME Scope Gate, and Zero-Setup Default

### 1.1 Product goal

Vietnamese software agencies, SaaS startups, technical SMEs, and solo developers run customer delivery and sprints in Ludy Projects (`modules/projects`), while engineering commits, pull requests (PRs), and bug/feature issues live on GitHub. Today developers manually copy PR links into task comments and update Ludy task cards by hand after merging code, causing stale boards and extra weekly coordination work.

This plan introduces a **strictly opt-in**, Linear-inspired GitHub Issue and PR integration for Ludy Projects:

1. **Zero-setup default:** One-person companies and non-software SMEs (retail, accounting, services) never see GitHub UI, task-key prefixes, or token prompts unless an owner or admin explicitly enables GitHub for the org and binds a repository to a project.
2. **Slice 1 (Inbound Link and Merge/Close Sync):** Link GitHub Issues and PRs to Ludy tasks manually or automatically via task-key mentions (`#/<task-key>`, `<KEY>-<number>`, or Ludy task URL) in bound repositories; PR open/merge and linked issue close events deterministically advance the Ludy task status/column via `Runtime.execute()`.
3. **Slice 2 (Opt-In Two-Way Done <-> Close and Vy AI Coworker):** Optional per-project outbound sync (`close_github_issue_on_done`, default `false`) that closes or reopens linked GitHub Issues when a Ludy task moves to/from `done` (with a 3-layer loop-breaker against webhook echoes), plus Vy coworker summaries of linked PRs/issues and issue link suggestions via `metered(...)`.

### 1.2 OPC and SME scope gate ([scope.md](../product/scope.md))

| Gate | Requirement | How this plan passes |
| --- | --- | --- |
| **1. Fit** | Weekly or monthly workflow for OPC/SME owners and small product teams | Software agencies, SaaS SMEs, and solo founders sync task progress with GitHub PR merges weekly/daily. **Explicitly out of scope (Icebox/Skip):** GitHub Enterprise Server custom base URLs (keep `https://api.github.com` only in MVP), multi-org GitHub proxy/broker consoles, PR code-review/diff mirroring inside Ludy, CI/CD workflow triggers, auto-creating GitHub issues on every new task, and custom visual automation rule builders. |
| **2. Smallest useful slice** | Works for one person with defaults and zero setup | Every project defaults to `github_enabled = false` with zero repo bindings, zero task-number badges, and zero extra columns rendered when unused. Connecting takes 1 org connection + 1 repository binding on a project. |
| **3. AI part named** | Named coworker action per screen, metered under `AI_FEATURES`, 100% AI-off parity | Vy (`gm`, Ludy's cross-app coworker and assistant per [DESIGN.md](../../DESIGN.md) section 1.1; `projects` has no separate coworker) assists in Slice 2 via `projects.github_pr_summary` (transient plain-Vietnamese summary of linked PRs/issues on a task) and `projects.github_issue_match` (suggesting matching GitHub issues/tasks to link). Every call uses `metered(...)` under `AI_FEATURES` `'projects'` with `tools: []`. With AI off or budget spent, 100% of webhook linking, status sync, manual linking, and outbound close/reopen work deterministically. |
| **4. Human approval** | Humans confirm setup, external writes, and AI proposals | Org owners/admins explicitly connect GitHub credentials and bind repositories (`R2`, `sideEffect: 'external'`); enabling outbound `Done -> Close GitHub Issue` requires an explicit opt-in confirmation toggle; Vy never mutates GitHub or creates links without a human click. |
| **5. Proportionate security** | Sealed credentials, strict egress, constant-time webhooks, `#2604` privacy, taint marks | Zero plaintext secrets in `ludy_projects` (sealed via `ludy_kernel.credential` + `CredentialVault`), API process `ludy_app` never opens credentials (`channel-credentials.db.test.ts`), strict `api.github.com` egress allowlist + private-IP SSRF guard, HMAC-SHA256 `X-Hub-Signature-256` constant-time verification, `X-GitHub-Delivery` replay deduplication, `tainted = true` untrusted display fields, and `RESTRICTIVE project_visibility` RLS on every `project_id` table. |

> **SQL Identifier Note ([ADR-0054](../adr/0054-rebrand-internal-crove-identifiers-to-ludy.md)):** Both `#3970` (core `ludy_kernel`) and `#3971` (module schemas `ludy_projects`) have landed on `origin/main`. All new migrations and tables in this plan use `ludy_kernel`, `ludy_projects`, `ludy_jobs`, `ludy_tenant`, `ludy_app`, and `ludy_worker`. Older invariant test suites (`rls-matrix.db.test.ts`, `channel-credentials.db.test.ts`, `app-gate-routes.test.ts`) internally map `crove_*` strings through `db-identifiers.ts`; Step 0 entries must follow each file's active naming convention.

---

## 2. Authentication and Credential Storage Architecture

### 2.1 GitHub App Installation vs. Fine-Grained PAT

| Dimension | Option A: GitHub App Installation (Primary) | Option B: Fine-Grained PAT + Per-Connection Webhook (Self-Host Fallback) |
| --- | --- | --- |
| **Permission scope** | Scoped to org-selected repositories: `Metadata: Read`, `Issues: Read & write` (Read in Slice 1), `Pull requests: Read` | Scoped to selected repositories by creator: `Metadata: Read`, `Issues: Read & write` (Read in Slice 1), `Pull requests: Read` |
| **Token lifecycle** | Short-lived (1 hour) installation access token minted via deployment `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` | User-generated token (max 1 year expiry on GitHub); manual rotation before expiry |
| **Team member offboarding** | Survives individual developer departure from GitHub org (bound to org installation) | Breaks if issuing developer loses repo access or leaves GitHub org |
| **Webhook model** | Single deployment endpoint `POST /api/projects/github/webhook` verified at API edge with `GITHUB_APP_WEBHOOK_SECRET` | Per-connection unguessable endpoint `POST /api/projects/github/webhook/:hookKey` (`hook_key_sha256` lookup) with org-owned webhook secret verified by worker |
| **Self-host `docker compose up` ([ADR-0027](../adr/0027-oss-core-and-crove-cloud.md))** | Requires operator to register a GitHub App and configure `GITHUB_APP_*` env vars | Zero deployment-level GitHub App setup; works out of the box once `CREDENTIAL_KEY` exists |

**Accepted design (`D-1`, 2026-11-27):** Support **GitHub App Installation as the primary path** for Ludy Cloud and multi-member SMEs (short-lived tokens, installation survives developer turnover), paired with **Fine-grained PAT + per-connection webhook as a lightweight fallback** when `GITHUB_APP_ID` is unset on self-hosted `docker compose up` deployments (mirroring how `packages/channel` supports both platform OAuth apps and self-host tokens).

### 2.2 Reusing `ludy_kernel.channel_connection` + `ludy_kernel.credential` (`D-2`)

Per [ADR-0025](../adr/0025-channel-layer.md) and `supabase/migrations/20261018090000_crove_kernel_channel_layer.sql`:

- **Why reuse kernel storage instead of building a new `ludy_projects.github_credential` table:**
  1. `ludy_kernel.credential` is already a hardened `MACHINERY` table (RLS enabled, zero grants to `ludy_tenant`, `ludy_app`, `ludy_worker`) governed by `ludy_kernel.credential_put`, `credential_get`, and `credential_drop`.
  2. `CredentialVault` (`packages/kernel-runtime/src/vault.ts`, `CREDENTIAL_KEY`) seals secrets using AES-256-GCM envelope encryption authenticated with `{ orgId, provider, externalAccountId }`, preventing cross-org or cross-account envelope replay.
  3. `apps/kernel/src/credential-reseal.ts` already rotates envelopes in `ludy_kernel.credential` automatically during `CREDENTIAL_KEY` rotation.
  4. `ludy_kernel.credential_get` is executable **only by `ludy_worker` in `system` context**, and automatically refuses (`CHANNEL_OWNER_LEFT`) if the connecting `connected_by` user is no longer an active `owner` or `admin` of the org.
  5. **Zero** plaintext or sealed secret columns ever exist inside `ludy_projects`.
- **Provider identifiers:** Add `'github_app'` (sealing `{ installationId, accountLogin }` or cached installation metadata while minting 1-hour tokens with `GITHUB_APP_PRIVATE_KEY` in the worker) and `'github_pat'` (sealing `{ accessToken, webhookSecret }` JSON up to `MAX_SECRET_BYTES = 32 KiB`).
- **Social/Channel UI separation:** Just as `isAdProviderId` (`packages/kernel/src/channels.ts`) excludes `_ads` providers from Social and Conversations channel lists, `isGithubProviderId` excludes `'github_app'` and `'github_pat'` from Social/Inbox channel screens while keeping `kernel.channel.connect` / `disconnect` (`owner`/`admin`, `R2`) and `credential-reseal.ts` unified.

---

## 3. Minimal Data Model (`ludy_projects`) and Private-Project Parity

All new tenant tables in `ludy_projects` enforce:
- `org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE`, `id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7()`, `PRIMARY KEY (org_id, id)`.
- Composite tenant foreign keys led by `org_id` with matching btree indexes (`packages/db/test/invariant/conformance.db.test.ts`).
- `SELECT ludy_kernel.apply_tenant_rls('ludy_projects.<table>');` (installing `tenant_isolation` and the `#285` `agent_write_guard` trigger so org-chart agents and `member_vy` cannot write any GitHub integration table).
- `RESTRICTIVE project_visibility` RLS policy (`#2604`, `apps/kernel/test/invariant/projects-private.db.test.ts`) on every `ludy_projects.*` table carrying `project_id`.

### 3.1 Opt-in human task keys without altering `ludy_kernel.task`

Today `ludy_kernel.task` uses UUID primary keys and carries no short human key (`WEB-42`). Preserving [ADR-0048](../adr/0048-projects-on-kernel-tasks.md) (no extra columns on `ludy_kernel.task`):

- **`ludy_projects.project_task` extension (Slice 1):**
  - `task_number integer CHECK (task_number IS NULL OR task_number >= 1)`
  - `CREATE UNIQUE INDEX IF NOT EXISTS project_task_number_uq ON ludy_projects.project_task (org_id, project_id, task_number) WHERE task_number IS NOT NULL;`
  - Stays `NULL` for all projects without a `task_key_prefix` (zero clutter for solo/non-dev SMEs). When an org admin sets `task_key_prefix` (e.g., `WEB`) on `github_project_binding`, existing tasks in that project are backfilled monotonically in `(created_at, id)` order under project `FOR UPDATE` lock, and subsequent `project_task` inserts atomically increment `github_project_binding.next_task_number`.

### 3.2 Tenant tables (`ludy_projects`)

#### 1. `ludy_projects.github_project_binding` (Slice 1)
One configuration row per GitHub-enabled project:
- `org_id`, `id`
- `project_id uuid NOT NULL` -> FK `(org_id, project_id)` to `ludy_projects.project (org_id, id) ON DELETE CASCADE`, `CONSTRAINT github_binding_project_uq UNIQUE (org_id, project_id)`
- `channel_connection_id uuid NOT NULL` -> composite FK `(org_id, channel_connection_id)` to `ludy_kernel.channel_connection (org_id, id) ON DELETE RESTRICT` (allowed cross-module FK to `ludy_kernel` per `conformance.db.test.ts`; prevents deleting a live connection row while projects depend on it without revoking cleanly)
- `enabled boolean NOT NULL DEFAULT false`
- `task_key_prefix text CHECK (task_key_prefix IS NULL OR task_key_prefix ~ '^[A-Z][A-Z0-9]{1,9}$')`
- `next_task_number integer NOT NULL DEFAULT 1 CHECK (next_task_number >= 1)`
- `auto_link_mentions boolean NOT NULL DEFAULT true`
- `inbound_in_progress_on_pr boolean NOT NULL DEFAULT true`
- `inbound_done_on_merge boolean NOT NULL DEFAULT true`
- `outbound_close_issue_on_done boolean NOT NULL DEFAULT false` *(Slice 2 opt-in toggle)*
- `in_progress_column_id uuid` -> composite FK `(org_id, project_id, in_progress_column_id)` to `ludy_projects.project_column (org_id, project_id, id) ON DELETE SET NULL`
- `done_column_id uuid` -> composite FK `(org_id, project_id, done_column_id)` to `ludy_projects.project_column (org_id, project_id, id) ON DELETE SET NULL`
- `created_by uuid`, `created_at timestamptz`, `updated_at timestamptz`
- Unique prefix per org: `CREATE UNIQUE INDEX IF NOT EXISTS github_binding_prefix_uq ON ludy_projects.github_project_binding (org_id, task_key_prefix) WHERE task_key_prefix IS NOT NULL;`
- Supporting FK indexes on `(org_id, channel_connection_id)`, `(org_id, project_id, in_progress_column_id)`, `(org_id, project_id, done_column_id)`.
- RLS: `apply_tenant_rls` + `RESTRICTIVE project_visibility`.

#### 2. `ludy_projects.github_project_repo` (Slice 1)
Bounded set of GitHub repositories bound to a project (capped at `<= 5` repos per project in command logic):
- `org_id`, `id`
- `project_id uuid NOT NULL`
- `binding_id uuid NOT NULL` -> composite FK `(org_id, project_id, binding_id)` to `ludy_projects.github_project_binding (org_id, project_id, id) ON DELETE CASCADE` (via `UNIQUE (org_id, project_id, id)` on `github_project_binding`)
- `github_repo_id bigint NOT NULL CHECK (github_repo_id > 0)`
- `repo_full_name text NOT NULL CHECK (repo_full_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$')` (`pii`)
- `default_branch text NOT NULL DEFAULT 'main' CHECK (pg_catalog.length(default_branch) BETWEEN 1 AND 255)`
- `created_by uuid`, `created_at timestamptz`
- `CONSTRAINT github_project_repo_uq UNIQUE (org_id, project_id, repo_full_name)`
- Index on `(org_id, repo_full_name)` for fast webhook routing + `(org_id, project_id, binding_id)`.
- RLS: `apply_tenant_rls` + `RESTRICTIVE project_visibility`.

#### 3. `ludy_projects.github_task_link` (Slice 1)
Links a Ludy project task to one or more GitHub Issues or Pull Requests:
- `org_id`, `id`
- `project_id uuid NOT NULL`
- `task_id uuid NOT NULL` -> composite FK `(org_id, project_id, task_id)` to `ludy_projects.project_task (org_id, project_id, task_id) ON DELETE CASCADE`
- `repo_full_name text NOT NULL CHECK (repo_full_name ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$')` (`pii`)
- `kind text NOT NULL CHECK (kind IN ('issue', 'pull_request'))`
- `external_number integer NOT NULL CHECK (external_number >= 1)`
- `external_node_id text CHECK (external_node_id IS NULL OR pg_catalog.length(external_node_id) BETWEEN 1 AND 120)`
- `external_url text NOT NULL CHECK (external_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(issues|pull)/[0-9]+$')`
- `external_title text NOT NULL CHECK (pg_catalog.length(external_title) BETWEEN 1 AND 300)` (`pii`, untrusted external metadata)
- `external_state text NOT NULL CHECK (external_state IN ('open', 'closed', 'merged', 'draft'))`
- `author_login text CHECK (author_login IS NULL OR pg_catalog.length(author_login) BETWEEN 1 AND 100)` (`pii`)
- `branch_name text CHECK (branch_name IS NULL OR pg_catalog.length(branch_name) BETWEEN 1 AND 255)`
- `link_source text NOT NULL CHECK (link_source IN ('manual', 'mention', 'branch'))`
- `hydrating boolean NOT NULL DEFAULT false` *(true while worker fetches canonical title/state after manual link)*
- `tainted boolean NOT NULL DEFAULT true CHECK (tainted = true)` *(external GitHub text is always tainted)*
- `last_remote_event_at timestamptz`
- `last_outbound_state text CHECK (last_outbound_state IS NULL OR last_outbound_state IN ('open', 'closed'))`
- `last_outbound_at timestamptz`
- `created_by uuid`, `created_at timestamptz`, `updated_at timestamptz`
- `CONSTRAINT github_task_link_uq UNIQUE (org_id, task_id, repo_full_name, kind, external_number)`
- Indexes: `(org_id, project_id, task_id)` and `(org_id, repo_full_name, kind, external_number)`.
- RLS: `apply_tenant_rls` + `RESTRICTIVE project_visibility`.

### 3.3 Definer-only `MACHINERY` tables (`rls-matrix.db.test.ts`)

All `MACHINERY` tables enable RLS, install `ludy_kernel.agent_write_guard_install(...)`, and hold **zero grants** to `PUBLIC`, `ludy_tenant`, `ludy_app`, `ludy_worker`, or `ludy_definer_tenant`. Only `SECURITY DEFINER` routines owned by the migration runner (`SET search_path = pg_catalog, pg_temp`) read or write them.

#### 4. `ludy_projects.github_webhook_hook` (Slice 1, for PAT / per-connection webhook mode)
Mirrors `ludy_finance.bank_feed_hook`:
- `org_id`, `id`, `channel_connection_id` (FK to `ludy_kernel.channel_connection (org_id, id) ON DELETE CASCADE`)
- `hook_key_sha256 text NOT NULL CHECK (hook_key_sha256 ~ '^[0-9a-f]{64}$')` (`UNIQUE`)
- `standing text NOT NULL DEFAULT 'ok' CHECK (standing IN ('ok', 'stopped'))`
- `refusal_count integer NOT NULL DEFAULT 0`, `refusal_window_started_at timestamptz`
- `created_at timestamptz`, `updated_at timestamptz`

#### 5. `ludy_projects.github_webhook_pending` (Slice 1, transient raw webhook buffer)
- For **GitHub App** mode: orgless intake buffer (`seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY`, `delivery_id text NOT NULL`, `event_type text NOT NULL`, `body bytea NOT NULL CHECK (pg_catalog.octet_length(body) BETWEEN 1 AND 262144)`, `received_at timestamptz`, `claimed_until timestamptz`, `attempts integer`), mirroring `ludy_kernel.conversation_inbound_pending` (capped at `10,000` rows, `53400` -> `503`).
- For **PAT `:hookKey`** mode: `ludy_projects.github_webhook_notice` (`org_id`, `id`, `hook_id` FK to `github_webhook_hook`, `delivery_id`, `event_type`, `signature_256`, `body bytea`, `received_at`, `UNIQUE (org_id, hook_id, delivery_id)`), mirroring `ludy_finance.bank_feed_webhook_notice`.
- In both cases, raw bodies are **deleted immediately upon worker claim** and any unclaimed rows older than 10 minutes are deleted by a `keeping` sweep (`runsWhenOff: true`).

#### 6. `ludy_projects.github_sync_delivery` (Slice 1 + Slice 2 idempotent sync ledger)
Records safe metadata (no raw payloads, no secrets, no task titles) for deduplication, loop prevention, and troubleshooting:
- `org_id`, `id`
- `project_id uuid NOT NULL` -> FK `(org_id, project_id)` to `ludy_projects.project (org_id, id) ON DELETE CASCADE` (with `RESTRICTIVE project_visibility` RLS alongside `MACHINERY` `REVOKE ALL` so `projects-private.db.test.ts` catalog invariants pass unconditionally)
- `task_id uuid` -> nullable composite FK `(org_id, project_id, task_id)` to `ludy_projects.project_task (org_id, project_id, task_id) ON DELETE SET NULL`
- `direction text NOT NULL CHECK (direction IN ('inbound', 'outbound'))`
- `delivery_id text` *(GitHub `X-GitHub-Delivery` UUID for inbound; `UNIQUE (org_id, project_id, delivery_id) WHERE delivery_id IS NOT NULL`)*
- `idempotency_key text` *(for outbound `(task_id, revision, target_remote_state)`; `UNIQUE (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL`)*
- `event_type text NOT NULL`
- `target_remote_state text CHECK (target_remote_state IS NULL OR target_remote_state IN ('open', 'closed'))`
- `status text NOT NULL CHECK (status IN ('queued', 'applied', 'skipped', 'deferred', 'failed'))`
- `attempt_count integer NOT NULL DEFAULT 0`
- `error_code text CHECK (error_code IS NULL OR pg_catalog.length(error_code) <= 64)`
- `created_at timestamptz`, `settled_at timestamptz`
- Exposed to project admins/writers strictly via a read query (`projects.github.sync_log`, limited to last 50 entries) that checks project visibility and returns safe status codes only.

---

## 4. Security, Egress Allowlist, Webhook Verification, and Taint Boundaries

### 4.1 Webhook intake and `ludy_app` vs. `ludy_worker` separation (`apps/kernel/src/http.ts`)

Because `ludy_app` (the API process) is prohibited from calling `ludy_kernel.credential_get` or `enter_system_context` (`apps/kernel/test/invariant/channel-credentials.db.test.ts`), webhook verification follows two proven Ludy patterns:

1. **GitHub App global route (`POST /api/projects/github/webhook`, mirrors `whatsapp-webhook.ts`):**
   - Registered only when `GITHUB_APP_WEBHOOK_SECRET` is configured.
   - HTTP edge enforces per-IP `RateLimiter` and `bodyLimit({ maxSize: 256 * 1024 })` (`256 KB` cap; GitHub issue/PR webhooks average `10-80 KB`).
   - Reads raw bytes and checks `X-Hub-Signature-256` (`sha256=<64 hex>`) in constant time (`crypto.timingSafeEqual`) against `GITHUB_APP_WEBHOOK_SECRET` (and optional `GITHUB_APP_WEBHOOK_SECRET_PREVIOUS` for zero-downtime secret rotation) **before** parsing JSON. Missing, malformed, or wrong signatures return `401 WEBHOOK_SIGNATURE` with zero body logging and zero DB writes.
   - Checks `X-GitHub-Delivery` UUID format and `X-GitHub-Event` allowlist (`issues`, `pull_request`, `installation`, `installation_repositories`, `ping`). Events outside the allowlist return `200` immediately without queuing.
   - Calls `ludy_projects.github_app_webhook_enqueue(...)` (`ludy_app` definer, 10,000 backlog cap -> `503`), then the worker resolves `org_id` from `ludy_kernel.channel_connection` by `installation.id`, verifies `ludy_kernel.org_app_on(org_id, 'projects')` + billing entitlement (`ADR-0053`, acknowledging and dropping if off), and deletes raw bytes immediately.
2. **Fine-grained PAT per-connection route (`POST /api/projects/github/webhook/:hookKey`, mirrors `bank-feed-hook.ts`):**
   - `:hookKey` is 128+ random bits (`[A-Za-z0-9_-]{32}`), stored only as `hook_key_sha256` in `github_webhook_hook`.
   - API checks `:hookKey` shape (`404` on invalid), looks up `(hook_id, standing)` via definer checking `org_app_on(org_id, 'projects')` + entitlement (`404` opaque if unknown/off/unentitled per `ADR-0053`), checks per-hook rate limit + `256 KB` body cap + required headers (`X-Hub-Signature-256`, `X-GitHub-Delivery`, `X-GitHub-Event`), and stores transient notice in `github_webhook_notice`.
   - Worker (`ludy_worker`) claims pending notices, opens the connection's sealed `webhookSecret` via `ludy_kernel.credential_get` + `CredentialBroker.open(...)`, checks `X-Hub-Signature-256` with `timingSafeEqual`, deletes raw bytes immediately, and auto-stops the hook after 10 refused signatures in an hour (`standing = 'stopped'`).

Both routes are registered in `apps/kernel/test/invariant/route-coverage.test.ts` and `app-gate-routes.test.ts` (`app: 'projects'`).

### 4.2 Strict `api.github.com` egress allowlist and `job-egress` rules

- **Fixed-host egress only:** All GitHub REST API calls go through a new `@ludy/github` workspace package using `packages/kernel-runtime/src/egress.ts` (`guardedRequest` / `egressFetch`) configured with:
  - `httpsOnly: true`
  - `maxRedirects: 0` (preventing bearer token leakage on HTTP redirects)
  - `hostAllowed: (host) => host === 'api.github.com'` (zero tenant-supplied hosts in MVP -> zero SSRF against private/metadata IPs)
  - Private-IP DNS pinning (`isPublicAddress`) and strict response byte cap (`maxBytes: 512 * 1024`, `overLimit: 'fail'`, `timeoutMs: 10_000`).
- **Important `egress.ts` extension for Slice 2:** `GuardedRequest['method']` and `egressFetch` in `packages/kernel-runtime/src/egress.ts` currently permit only `'GET' | 'POST' | 'PUT' | 'DELETE'`. Slice 2 requires adding `'PATCH'` to `GuardedRequest` and `egressFetch` (a `shared-core` change reviewed by the Platform PO) so `PATCH /repos/{owner}/{repo}/issues/{issue_number}` passes through the egress guard cleanly.
- **No network I/O in commands (`job-egress.test.ts`):**
  - Commands (`Runtime.execute`) never make HTTP calls.
  - Setup/linking commands (`projects.github.binding.save`, `projects.github.link.add`, `projects.github.repo.bind`) declare `risk: 'R2'`, `sideEffect: 'external'`, and `owner`/`admin` (or `WRITERS` for `link.add` where project already has an admin-approved `github_project_binding`).
  - Worker queues in `apps/kernel/src/jobs-schema.ts`:
    - `QUEUES.projectsGithubWebhook` (`'none'`): processes claimed webhook bodies against DB bindings only.
    - `QUEUES.projectsGithubHydrate` (`['provider:github']`, `'stately'`): fetches canonical issue/PR metadata (`GET /repos/{owner}/{repo}/issues/{n}` or `/pulls/{n}`) after `projects.github.link.add`, or lists accessible repos for `projects.github.repos.refresh` (`R2`, `sideEffect: 'external'`).
    - `QUEUES.projectsGithubSweep` (`'none'`) + `QUEUES.projectsGithubOutbound` (`['provider:github']`, `'stately'`, Slice 2): sweeps queued outbound `Done <-> Close/Reopen` jobs (only created when `outbound_close_issue_on_done = true`) and executes `PATCH /repos/{owner}/{repo}/issues/{n}`, mirroring `sign-hook-sweep` -> `sign-hook-deliver` (`job-egress.test.ts` `OTHER_SENDS` referencing `projects.github.binding.save`) so normal board card drags stay `R1`, `sideEffect: 'internal'`!

### 4.3 Untrusted payload tainting (`ADR-0018`)

GitHub Issue and PR titles, descriptions, branch names, and author logins on public or collaborator repositories are attacker-controlled external strings (`tainted = true`):
- Webhook parsers (`packages/github`) accept ONLY allowlisted scalar fields via `z.strictObject(...)`, stripping HTML tags, control characters, and zero-width format characters (`/\p{Cf}/u`).
- `github_task_link` enforces `tainted = true` in the DB (`CHECK (tainted = true)`), validates `external_url` strictly as `https://github.com/<owner>/<repo>/(issues|pull)/<n>`, and renders all titles/branches strictly via escaped React text (`textContent` / JSX, zero `dangerouslySetInnerHTML`).
- Inbound webhooks **never** edit `ludy_kernel.task.title` or `description`, never untaint a task, and never auto-create new `ludy_kernel.task` rows from external GitHub issues in MVP.
- Any Vy AI prompt reading linked GitHub issues/PRs wraps external fields in `<<< >>>` delimiters (`fenced(...)`), runs with `tools: []`, and validates outputs through deterministic guards (`checkGithubSummary` / `checkGithubIssueMatch`).

### 4.4 RBAC and private projects (`#2604`)

- **Org GitHub connection (`kernel.channel.connect` / `disconnect`):** `owner` and `admin` only (`R2`). `member` and `viewer` never create, rotate, or view credentials.
- **Project repo binding & sync toggles (`projects.github.binding.*`):** org `owner`/`admin`, or `project.owner_user_id` only if also org `owner`/`admin` (preventing non-admin project owners from attaching org GitHub installations to unauthorized repos; members/viewers read safe status metadata only).
- **Task Issue/PR linking (`projects.github.link.add` / `remove`):** project `WRITERS` (`owner`, `admin`, `member`) on visible projects (enforced by `project_visibility` RLS on private projects).
- **Org-chart agents & `member_vy`:** Blocked from writing any `github_*` table by `#285` `agent_write_guard`.

---

## 5. Deterministic Sync State Machine, Loop Prevention, and Vy AI Boundary

### 5.1 Slice 1: Inbound link and merge/close sync

1. **Mention & branch extraction (on `pull_request` events from bound repos):**
   - When `binding.auto_link_mentions = true` and `binding.task_key_prefix` is set (e.g., `WEB`), scan `pull_request.title`, `pull_request.body` (first 8 KB), and `pull_request.head.ref` (branch name) for:
     - Closing patterns: `/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#?(?:#\/)?([A-Z][A-Z0-9]{1,9}-\d+)/gi`
     - Reference patterns: `/(?:^|[\s/(\[#])(?:#\/)?([A-Z][A-Z0-9]{1,9}-\d+)(?=$|[\s\])/.,:;])/g`
     - Or explicit Ludy task URLs matching `/o/<slug>/projects/<projectId>...task=<taskId>` for the same org/project.
   - Note: Bare GitHub issue references like `Fixes #42` (without project prefix) are **not** matched against Ludy task numbers to prevent collisions with GitHub issue numbers; instead, when GitHub closes issue `#42`, GitHub emits `issues.closed` for `#42` and Ludy updates every `github_task_link` pointing to `(repo_full_name, 'issue', 42)`.
   - All matching `project_task` rows in the bound project get an idempotent `github_task_link` row (`link_source = 'mention' | 'branch'`).
2. **Status transition via `Runtime.execute()` (`system` actor):**
   - Note: `kernel.task.set_status` in `packages/kernel/src/agents.ts` currently calls `requireUser(ctx)` for non-agent actors. Slice 1 adds an internal `system`-only command `kernel.task.sync_external_status` (`access: 'system'`, `risk: 'R1'`, `sideEffect: 'internal'`) that validates `checkout_run_id IS NULL OR lock_expires_at <= ctx.now` (never interrupting an active AI agent run lease per [ADR-0029](../adr/0029-agents-positions-and-org-chart.md)) and updates `ludy_kernel.task.status` (`ludy_kernel.task_before_update` already supports `system` actor, updates `done_at`, increments `revision`, and sets `completed_by = NULL`).
   - **Transition rules (executed inside `projects.github.apply_inbound_event` calling `ctx.run('kernel.task.sync_external_status', ...)` and syncing `project_task.column_id`):**
     - `pull_request` (`opened`, `reopened`, `ready_for_review`, non-draft) when `inbound_in_progress_on_pr = true`: if linked task is `'todo'`, transition to `in_progress_column_id ?? 'in_progress'`.
     - `pull_request` (`closed` with `merged === true`) when `inbound_done_on_merge = true`: if linked by a closing keyword or linked manually (not marked `link_only`), and task is not `'done'` or `'cancelled'`, transition to `done_column_id ?? 'done'`.
     - `pull_request` (`closed` with `merged === false`): update `github_task_link.external_state = 'closed'` only; do not close the Ludy task.
     - `issues` (`closed`) when `inbound_done_on_merge = true`: update `external_state = 'closed'` and move linked non-cancelled/non-done tasks to `done_column_id ?? 'done'`.
     - `issues` (`reopened`): update `external_state = 'open'`; move `done` task back to `'todo'` only if `reopen_task_on_issue_reopen` is active (default: update badge only or configurable in Slice 2).
   - **Lease deferral:** If `task.checkout_run_id` holds an active agent lease (`lock_expires_at > ctx.now`), mark `github_sync_delivery.status = 'deferred'` and update only `github_task_link.external_state` without stealing the agent lease.

### 5.2 Slice 2: Opt-in outbound `Done <-> Close` and 3-layer loop-breaker invariant

When `github_project_binding.outbound_close_issue_on_done = true` (explicitly enabled and confirmed by an org owner/admin):

1. **Which links sync outbound:** Only `kind = 'issue'` links (never `pull_request`, since moving a task to `done` must never close an unmerged PR or fail on an already-merged PR).
2. **When outbound runs:** When a human or org-chart agent transitions a linked task to `'done'` (enqueue `target_remote_state = 'closed'`) or from `'done'` back to `'todo'` / `'in_progress'` (enqueue `target_remote_state = 'open'`), `modules/projects` inserts a `github_sync_delivery` (`direction = 'outbound'`, `status = 'queued'`, `idempotency_key = '<taskId>:<revision>:<target_remote_state>'`) in the same transaction.
3. **3-layer Loop-Breaker Invariant:**
   - **Layer 1 (Origin flag):** `projects.github.apply_inbound_event` sets `syncOrigin = 'github_webhook'`; outbound enqueue **never** runs when `syncOrigin === 'github_webhook'`.
   - **Layer 2 (Target-state guard):** Outbound sweep/enqueue skips any link whose `github_task_link.external_state` already equals `target_remote_state`.
   - **Layer 3 (Webhook echo suppression):** When `projects-github-outbound` finishes `PATCH /repos/{owner}/{repo}/issues/{n}`, it stores `github_task_link.last_outbound_state = target_remote_state`, `last_outbound_at = now`, and `last_remote_event_at = response.issue.updated_at`. When GitHub echoes `issues.closed` / `issues.reopened` back:
     - If `payload.issue.updated_at <= link.last_remote_event_at` OR (`external_state === last_outbound_state` and task is already in the target Ludy state), the inbound handler records `delivery.status = 'skipped'` (echo suppressed) and performs **zero** task/outbound writes.

### 5.3 Slice 2: Vy AI coworker (`AI_FEATURES` `'projects'`)

- **`projects.github_pr_summary` (`AI_FEATURES` `'projects'`):**
  - On a task page with linked GitHub PRs/issues, member clicks **"Summarize GitHub activity"** (Vietnamese: *"Tóm tắt tiến độ GitHub"*).
  - Runs through `withAiScope` + `metered(...)`, `tools: []`, outside any DB transaction.
  - Input: bounded task title + code-computed counts (linked PR/issue count, states) + `fenced(...)` (`<<< >>>`) untrusted PR/issue titles and short status metadata (no raw arbitrary PR diffs or untrusted HTML comments in MVP).
  - Output: 2 to 4 concise Vietnamese sentences checked by `summaryNumbersOutside`, `draftLinksOutside`, `hasInvisibleFormat`, `hasPromptMarkupLeak`, and `hasAutonomousActionDirective`. Shown transiently with an `"AI"` badge; never stored or sent.
- **`projects.github_issue_match` (`AI_FEATURES` `'projects'`):**
  - When a member opens "Link GitHub Issue" on a task, Vy optionally ranks top 1-3 matching open issues from the project's cached/fetched repo list (`<<< >>>` fenced, ID-membership validated against input list, `UNKNOWN_ID` fail closed).
  - Member clicks **Confirm Link** (`projects.github.link.add`); Vy never creates links or edits GitHub autonomously.

---

## 6. Two-Slice MVP Delivery and Step 0 Invariants

Owner JOY approved `ADR-0060` and decisions `D-1` to `D-4` on `2026-11-27 04:07+07:00` ([#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7203423474), [#5126 comment](https://github.com/DOS/Ludy/issues/5126#issuecomment-7203423822)). Implementation issues (`Step 0`, `Slice 1`, and `Slice 2`) are to be opened under `#5126` (issue numbers TBD) and follow Ludy's two-step invariant discipline against the active integration base (`dev`, promoted to `main`):

| Step | Scope (Issue TBD under `#5126`) | Key Files / Checks | Protected Paths / `shared-core` |
| --- | --- | --- | --- |
| **Step 0** (`TBD`) | Register new `ludy_projects.github_*` tables in `rls-matrix.db.test.ts` (`PENDING_TABLES` + `MACHINERY` + `ROW_FACTORIES`), `projects-private.db.test.ts`, PENDING routes in `route-coverage.test.ts` + `app-gate-routes.test.ts`, and `PENDING_DEPS` (`channels.github`) in `job-egress.ts` | `apps/kernel/test/invariant/{rls-matrix.db.test.ts,projects-private.db.test.ts,route-coverage.test.ts,app-gate-routes.test.ts,job-egress.ts}` | Yes (`shared-core` Platform PO review + Line PO security review) |
| **Slice 1** (`TBD`, `priority:P1`) | Org connection via `ludy_kernel.channel_connection` + `ludy_kernel.credential` (`github_app` + `github_pat` per `D-1`/`D-2`), `github_*` tables + `project_task.task_number`, `org_purge` + `offboarding` + `personal-data` + `manifest`, `kernel.task.sync_external_status`, `@ludy/github` (`api.github.com` egress), webhook routes in `http.ts`, worker inbound & metadata hydrate jobs, Project Settings GitHub tab + Task detail links/badges (`>= 44 px`, i18n EN/VI) | `supabase/migrations/*`, `packages/github/**`, `packages/kernel/src/{channels,agents,offboarding,personal-data}.ts`, `apps/kernel/src/{http,worker,jobs-schema,github-*}.ts`, `modules/projects/**`, `apps/app/**` | Yes (`shared-core`: `http.ts`, `org_purge`, `channels.ts` + Line PO security review) |
| **Slice 2** (`TBD`, `priority:P1`) | Extend `GuardedRequest` with `'PATCH'` (`egress.ts`), `outbound_close_issue_on_done` opt-in confirmation UI, `projects-github-sweep` + `projects-github-outbound` with 3-layer loop-breaker + echo tests, Vy `projects.github_pr_summary` + `projects.github_issue_match` (`metered`), red-team prompt injection & private-project tests | `packages/kernel-runtime/src/egress.ts`, `packages/agent/**`, `apps/kernel/src/{worker,github-*}.ts`, `modules/projects/**`, `apps/app/**` | Yes (`shared-core`: `egress.ts` + Line PO security review) |

---

## 7. Owner Decisions (`2026-11-27`, Accepted)

Owner JOY approved all four recommended options on `2026-11-27 04:07+07:00` ([#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7203423474), [#5126 comment](https://github.com/DOS/Ludy/issues/5126#issuecomment-7203423822)):

| # | Question | Decided (JOY, 2026-11-27) | Rationale and Locked Impact |
| --- | --- | --- | --- |
| **D-1** | **GitHub authentication model:** Which connection method(s) should Slice 1 support? | **GitHub App Installation primary + Fine-grained PAT fallback** (for self-hosted `docker compose up`) | Works seamlessly on Ludy Cloud (short-lived 1-hour installation tokens, survives developer offboarding) and self-host (`ADR-0027`, zero GitHub App registration needed). Implements both `POST /api/projects/github/webhook` and `POST /api/projects/github/webhook/:hookKey`. |
| **D-2** | **Credential storage:** Reuse `ludy_kernel.channel_connection` + `ludy_kernel.credential` or create a separate `ludy_projects.github_credential` table? | **Reuse `ludy_kernel.channel_connection` + `ludy_kernel.credential`** (filtered separate from Social channels) | Reuses AES-256-GCM envelope encryption, `credential-reseal.ts` key rotation, `owner`/`admin` RBAC, and `CHANNEL_OWNER_LEFT` auto-revocation with zero secret columns in `ludy_projects`. `channels.ts` (`shared-core`, Platform PO review) excludes `github_*` from Social channel pickers. |
| **D-3** | **Task key format for PR/branch auto-linking:** Add opt-in per-project keys (`KEY-123`) or match UUIDs/URLs only? | **Opt-in per-project `task_key_prefix` (e.g. `WEB-42`) + `project_task.task_number`** (allocated only when GitHub integration is enabled) alongside `#/<task-key>` and Ludy task links | Matches Linear/Jira developer workflows (`feat/WEB-42-auth`, `Fixes WEB-42`), keeps projects with GitHub off completely uncluttered, and leaves `ludy_kernel.task` untouched (`ADR-0048`). |
| **D-4** | **Delivery scope and timing:** Two-slice delivery (`Slice 1` inbound + `Slice 2` opt-in two-way sync & Vy AI) vs. Inbound-only MVP? | **Two `priority:P1` slices (`Slice 1` inbound link + GitHub->Ludy sync first; `Slice 2` opt-in two-way `Done <-> Close` with loop-breaker, `PATCH` egress + Vy AI summary/match second)** | Ships immediate inbound tracking cleanly in Slice 1 with zero GitHub write permissions, then adds opt-in two-way issue close/reopen (`PATCH`, 3-layer loop-breaker) and metered Vy helpers in Slice 2 (`Step 0`, `Slice 1`, `Slice 2` issues to be opened under `#5126`). |
