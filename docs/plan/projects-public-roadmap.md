# Projects Public Roadmap: AI-native Ideas, Voting, 3-Stage Roadmap, and Changelog

> Plan for Ludy Projects Public Roadmap (`modules/projects`, schema `crove_projects`, milestone `M3 Paid pilot`, line `line:projects`, `priority:P1`), 2026-11-22. Builds on [projects.md](projects.md), [projects-v2.md](projects-v2.md), [ADR-0048](../adr/0048-projects-on-kernel-tasks.md), [ADR-0056](../adr/0056-projects-v2-cycles-columns-dependencies-privacy.md), [ADR-0018](../adr/0018-untrusted-content.md), [ADR-0029](../adr/0029-agents-positions-and-org-chart.md), [ADR-0031](../adr/0031-module-enablement.md), [ADR-0034](../adr/0034-outbound-email.md), [ADR-0051](../adr/0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md), [ADR-0053](../adr/0053-per-org-app-enablement.md), [ADR-0054](../adr/0054-rebrand-internal-crove-identifiers-to-ludy.md), and the OPC/SME scope gate in [scope.md](../product/scope.md). Owner JOY approved the product direction and decisions on 2026-11-22 in the `Projects & Notes Product Owner` session ([#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7073382197)). The governing decision record is [ADR-0057](../adr/0057-projects-public-roadmap-ideas-voting-changelog.md) (`Accepted`); the Vietnamese summary for the owner is [projects-public-roadmap.vi.md](projects-public-roadmap.vi.md).
>
> **Tracking issues:** Plan & ADR ([#4397](https://github.com/DOS/Ludy/issues/4397)), Step 0 Invariants ([#4398](https://github.com/DOS/Ludy/issues/4398)), Slice 1 Core ([#4399](https://github.com/DOS/Ludy/issues/4399)), Slice 2 Changelog, Embed, Vy AI & MCP ([#4400](https://github.com/DOS/Ludy/issues/4400)).

## 1. Goal, benchmark direction, and OPC/SME scope gate

### 1.1 Product goal and benchmark inspiration

Vietnamese SMEs, SaaS teams, B2B agencies, and solo makers using Ludy Teamwork need a lightweight, self-hosted public portal to collect customer feature requests, validate demand through upvotes, communicate what is `Planned`, `In Progress`, and `Shipped`, and close the feedback loop with release notes and customer notifications.

This plan combines two complementary product layers:

- **Clean 3-tab public UX (inspired by Frill.co and UserJot):** A focused, fast public workspace at `/-/roadmap/:orgSlug/:boardSlug` with three tabs (`Ideas`, `Roadmap`, `Changelog`) plus a compact embeddable widget mode (`?embed=1`), zero account passwords, and minimal configuration.
- **AI-native triage and closed-loop workflow (inspired by Quackback, Productlane, and Cycle):** Leveraging Ludy's unified OS across Projects, Vy (`gm`), and MCP (`ADR-0051`) so public feedback clusters cleanly, promotes into internal tasks only on human confirmation, drafts grounded changelog announcements from shipped items, and exposes sanitized demand insights to coding/product agents.

### 1.2 Scope gate ([scope.md](../product/scope.md))

1. **Fit (gate 1):** Collecting customer requests, ranking demand, updating a 3-stage public roadmap, and announcing shipped changes are weekly/monthly jobs for product-led SMEs, software agencies, and B2B service firms. Enterprise portal features (multi-brand portals, SAML/SSO voter login, white-label custom CNAME hosting, paid guest seat billing, and agency multi-tenant consoles) stay out of scope. Private authenticated client project workspaces ([#2603](https://github.com/DOS/Ludy/issues/2603)) remain in the Icebox and are explicitly distinct from this unauthenticated/OTP public product roadmap.
2. **Smallest useful slice / opt-in default (gate 2):** Boards are strictly opt-in (`enabled = false` by default). Enabling a board requires one click with SME-ready defaults (`allow_submissions = true`, `allow_voting = true`, `require_moderation = true`, stages `under_review | planned | in_progress | shipped`). Existing orgs and projects see zero public exposure unless an owner or admin explicitly turns a board on.
3. **AI part named & gated (gate 3):** Vy (`gm`, Ludy's cross-app coworker and assistant per [DESIGN.md](../../DESIGN.md) section 1.1; `projects` gets no separate coworker) powers semantic duplicate clustering (`projects.roadmap_dedupe`) and closed-loop release note drafting (`projects.roadmap_changelog_draft`). Every LLM call runs through `metered(...)` under `AI_FEATURES` (`'projects'`), uses `tools: []`, treats every `public_submission` strictly as untrusted data ([ADR-0018](../adr/0018-untrusted-content.md)), and validates changelog output with `summaryNumbersOutside` ([#1237](https://github.com/DOS/Ludy/issues/1237)). With AI disabled or out of budget, 100% of public browsing, 6-digit email OTP verification, voting, submissions, moderation, roadmap progression, changelog publishing, and shipped notifications work deterministically.
4. **Human approval (gate 4):** No AI output or public visitor input ever publishes an idea, merges duplicates, creates or updates a `crove_kernel.task`, publishes a changelog announcement, or dispatches shipped emails without an explicit authenticated human click.
5. **Proportionate security & zero leakage (gate 5):** Public endpoints never query `crove_projects.project` or `crove_kernel.task`, never expose internal assignees, seats, comments, attachments, or private notes, never leak voter/subscriber email addresses, and enforce strict DB/runtime guards against linking `visibility = 'private'` projects (`#2604`).

## 2. Owner decisions (`2026-11-22`) and delivery priority

On `2026-11-22T10:04+07:00` ([#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7073382197)), owner JOY confirmed:

| ID | Topic | Decision (JOY, 2026-11-22) | Impact |
| --- | --- | --- | --- |
| `A1` | Public voter/submitter auth and anti-abuse (`#203`) | Free public viewing without login; 1-click 6-digit email OTP verification on first Upvote or Idea submission (reusing Ludy's existing email OTP conventions, zero passwords, zero third-party CAPTCHA per `#203`), enabling opt-in email notifications when shipped | Self-contained `docker compose up` and automated E2E suites run with zero CAPTCHA keys or external accounts while blocking anonymous spam and verifying notification subscribers |
| `A2` | Priority and parallel slot schedule | Author Public Roadmap Plan, `ADR-0057`, and Step 0 invariants (`#4398`) immediately in parallel without interrupting Projects v2 Wave 1 (`#4361`, `#2605`, `#2601`, `#2604`); prioritize building Public Roadmap (`#4399`, `#4400`) right after Wave 1 (ahead of or alongside Wave 2 `#2599` Gantt and `#2600` Time tracking) | Protects Wave 1 delivery velocity while keeping Public Roadmap architecture, invariants, and `shared-core` prep ready on `main` |
| Direction | UX and AI-native scope | Frill/UserJot 3-tab public UX (`Ideas`, `Roadmap`, `Changelog`) + `?embed=1` widget + AI-native Vy workflows (`roadmap_dedupe`, `roadmap_changelog_draft`) + MCP read tools (`/mcp`) + future omnichannel signal hooks cleanly decoupled | Delivers an approachable SME feedback board today and keeps CRM/Inbox/Meetings ingestion decoupled for a future milestone |

> **Identifier note ([ADR-0054](../adr/0054-rebrand-internal-crove-identifiers-to-ludy.md)):** Workspace packages use `@ludy/*`, while PostgreSQL schemas and cluster roles on `main` currently use `crove_projects`, `crove_kernel`, and `crove_tenant` pending `#3969` to `#3971`. If the SQL rebrand merges before `#4398`, `#4399`, or `#4400`, those PRs use the corresponding `ludy_*` identifiers with identical table, constraint, and security semantics.

## 3. Data model, `MACHINERY` isolation, and zero-leakage invariants

### 3.1 Core isolation boundary

- Public endpoints and public SPA views **NEVER** query `crove_projects.project` or `crove_kernel.task`.
- All public roadmap data lives in dedicated `crove_projects.roadmap_*` tables. Internal teams explicitly curate what becomes public and may optionally link a published/planned `roadmap_item` to an internal `crove_projects.project_task` solely to track stage progression, with zero exposure of internal task titles (unless manually copied into `public_title`), descriptions, assignees/seats, `le_scope` entities, comments, attachments, or linked notes.

### 3.2 Isolated tenant tables (`apply_tenant_rls`)

Every tenant table below includes `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`, `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`, `PRIMARY KEY (org_id, id)`, composite tenant FKs led by `org_id` with supporting btree indexes (`packages/db/test/invariant/conformance.db.test.ts`), and `SELECT crove_kernel.apply_tenant_rls(...)` (installing `tenant_isolation` plus the `#285` `agent_write_guard` trigger so org-chart agents and `member_vy` cannot write any `roadmap_*` table).

#### 1. `crove_projects.roadmap_board` (Slice 1, `#4399`)

- `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`
- `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`
- `slug text NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')`
- `title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 120 AND title = pg_catalog.btrim(title))` (`pii`)
- `description text CHECK (description IS NULL OR pg_catalog.length(description) <= 1000)` (`pii`)
- `enabled boolean NOT NULL DEFAULT false`
- `project_id uuid` (nullable optional link to an org-visible `crove_projects.project` for board organization/stage sync)
- `allow_submissions boolean NOT NULL DEFAULT true`
- `allow_voting boolean NOT NULL DEFAULT true`
- `require_moderation boolean NOT NULL DEFAULT true`
- `embed_allowed_origins text[] NOT NULL DEFAULT '{}'` (each element validated as strict `https://<host>[:port]` origin with no wildcard `*`, no path, no query)
- `created_by uuid`, `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`, `updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
- Keys & indexes:
  - `PRIMARY KEY (org_id, id)`
  - `CONSTRAINT roadmap_board_slug_uq UNIQUE (org_id, slug)`
  - `CONSTRAINT roadmap_board_project_fk FOREIGN KEY (org_id, project_id) REFERENCES crove_projects.project (org_id, id) ON DELETE SET NULL (project_id)`
  - `CREATE INDEX IF NOT EXISTS roadmap_board_project_idx ON crove_projects.roadmap_board (org_id, project_id) WHERE project_id IS NOT NULL;`

#### 2. `crove_projects.roadmap_item` (Slice 1, `#4399`)

- `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`
- `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`
- `board_id uuid NOT NULL`
- `linked_task_id uuid` (nullable composite FK to `crove_projects.project_task (org_id, task_id)`; syncs ONLY stage progression, never internal assignees/comments/attachments/notes)
- `source text NOT NULL CHECK (source IN ('internal', 'public_submission'))`
- `moderation_status text NOT NULL DEFAULT 'pending' CHECK (moderation_status IN ('pending', 'published', 'merged', 'archived'))` (forced `'pending'` on `public_submission`; internal creators may create directly as `'published'` or `'pending'`)
- `merged_into_item_id uuid` (nullable self-FK to canonical `roadmap_item` when `moderation_status = 'merged'`)
- `stage text NOT NULL DEFAULT 'under_review' CHECK (stage IN ('under_review', 'planned', 'in_progress', 'shipped'))`
- `category text CHECK (category IS NULL OR pg_catalog.length(category) BETWEEN 1 AND 60)`
- `public_title text NOT NULL CHECK (pg_catalog.length(public_title) BETWEEN 1 AND 200 AND public_title = pg_catalog.btrim(public_title))` (`pii`)
- `public_summary text CHECK (public_summary IS NULL OR pg_catalog.length(public_summary) <= 4000)` (`pii`)
- `vote_count integer NOT NULL DEFAULT 0 CHECK (vote_count >= 0)` (maintained transactionally alongside `roadmap_vote`)
- `tainted boolean NOT NULL DEFAULT false` (DB check/trigger forces `tainted = true` whenever `source = 'public_submission'`)
- `submitter_display_name text CHECK (submitter_display_name IS NULL OR pg_catalog.length(submitter_display_name) BETWEEN 1 AND 80)` (`pii`)
- `created_by uuid`, `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`, `updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
- Keys & indexes:
  - `PRIMARY KEY (org_id, id)`
  - `CONSTRAINT roadmap_item_board_fk FOREIGN KEY (org_id, board_id) REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE`
  - `CONSTRAINT roadmap_item_task_fk FOREIGN KEY (org_id, linked_task_id) REFERENCES crove_projects.project_task (org_id, task_id) ON DELETE SET NULL (linked_task_id)`
  - `CONSTRAINT roadmap_item_merged_fk FOREIGN KEY (org_id, merged_into_item_id) REFERENCES crove_projects.roadmap_item (org_id, id) ON DELETE SET NULL (merged_into_item_id)`
  - `CHECK (merged_into_item_id IS NULL OR merged_into_item_id <> id)`
  - `CHECK (source <> 'public_submission' OR tainted = true)`
  - `CREATE INDEX IF NOT EXISTS roadmap_item_board_idx ON crove_projects.roadmap_item (org_id, board_id, moderation_status, stage, vote_count DESC, created_at DESC);`
  - `CREATE INDEX IF NOT EXISTS roadmap_item_linked_task_idx ON crove_projects.roadmap_item (org_id, linked_task_id) WHERE linked_task_id IS NOT NULL;`
  - `CREATE INDEX IF NOT EXISTS roadmap_item_merged_idx ON crove_projects.roadmap_item (org_id, merged_into_item_id) WHERE merged_into_item_id IS NOT NULL;`

#### 3. `crove_projects.roadmap_vote` (Slice 1, `#4399`)

- `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`
- `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`
- `board_id uuid NOT NULL`
- `item_id uuid NOT NULL`
- `voter_email_hash text NOT NULL CHECK (voter_email_hash ~ '^[0-9a-f]{64}$')` (keyed HMAC-SHA256 via deployment/org mail hash helper; **never** exposed on public API responses)
- `notify_on_ship boolean NOT NULL DEFAULT true`
- `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
- Keys & indexes:
  - `PRIMARY KEY (org_id, id)`
  - `CONSTRAINT roadmap_vote_board_fk FOREIGN KEY (org_id, board_id) REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE`
  - `CONSTRAINT roadmap_vote_item_fk FOREIGN KEY (org_id, item_id) REFERENCES crove_projects.roadmap_item (org_id, id) ON DELETE CASCADE`
  - `CONSTRAINT roadmap_vote_unique UNIQUE (org_id, item_id, voter_email_hash)`
  - `CREATE INDEX IF NOT EXISTS roadmap_vote_board_idx ON crove_projects.roadmap_vote (org_id, board_id, created_at DESC);`

#### 4. `crove_projects.roadmap_announcement` (Slice 2, `#4400`)

- `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`
- `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`
- `board_id uuid NOT NULL`
- `title text NOT NULL CHECK (pg_catalog.length(title) BETWEEN 1 AND 200 AND title = pg_catalog.btrim(title))` (`pii`)
- `body_md text NOT NULL CHECK (pg_catalog.length(body_md) BETWEEN 1 AND 20000)` (`pii`)
- `status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published'))`
- `published_at timestamptz`
- `linked_item_ids uuid[] NOT NULL DEFAULT '{}'` (validated in command transaction to reference `roadmap_item` rows in the same `(org_id, board_id)` with `stage = 'shipped'` and `moderation_status = 'published'`)
- `notifications_sent_at timestamptz` (records when an explicit human-confirmed shipped notification batch was queued, preventing accidental duplicate sends)
- `created_by uuid`, `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`, `updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
- Keys & indexes:
  - `PRIMARY KEY (org_id, id)`
  - `CONSTRAINT roadmap_announcement_board_fk FOREIGN KEY (org_id, board_id) REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE`
  - `CREATE INDEX IF NOT EXISTS roadmap_announcement_board_idx ON crove_projects.roadmap_announcement (org_id, board_id, status, published_at DESC);`

### 3.3 Definer-only `MACHINERY` tables (`rls-matrix.db.test.ts` `MACHINERY`)

Following `crove_sign.signing_otp` (`#3323`, `#3551`), both tables enable RLS (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`), install `crove_kernel.agent_write_guard_install(...)`, and hold **ZERO grants** to `PUBLIC`, `crove_tenant`, `crove_app`, `crove_worker`, or `crove_definer_tenant`. Only narrow `SECURITY DEFINER` routines owned by the migration runner (`SET search_path = pg_catalog, pg_temp`) read or write them.

#### 5. `crove_projects.roadmap_otp` (Slice 1, `#4399`)

- `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`
- `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`
- `board_id uuid NOT NULL`
- `email text NOT NULL CHECK (pg_catalog.length(email) BETWEEN 3 AND 254)` (short-lived challenge address, erased by PDPL definer and pruned after 24h)
- `email_hash text NOT NULL CHECK (email_hash ~ '^[0-9a-f]{64}$')`
- `ip_hash text NOT NULL CHECK (ip_hash ~ '^[0-9a-f]{64}$')`
- `otp_sha256 text CHECK (otp_sha256 IS NULL OR otp_sha256 ~ '^[0-9a-f]{64}$')` (6-digit CSPRNG OTP hashed on dispatch; zero plaintext OTP stored in DB or `pgboss.job`)
- `claim_sha256 text CHECK (claim_sha256 IS NULL OR claim_sha256 ~ '^[0-9a-f]{64}$')` (SHA-256 of short-lived HMAC-signed voter session claim minted after verification)
- `expires_at timestamptz NOT NULL` (10-minute TTL)
- `attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5)` (locked on 5th failed attempt)
- `verified_at timestamptz`, `invalidated_at timestamptz`, `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
- Keys & indexes:
  - `PRIMARY KEY (org_id, id)`
  - `CONSTRAINT roadmap_otp_board_fk FOREIGN KEY (org_id, board_id) REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE`
  - `CREATE INDEX IF NOT EXISTS roadmap_otp_board_idx ON crove_projects.roadmap_otp (org_id, board_id, created_at DESC);`
  - `CREATE INDEX IF NOT EXISTS roadmap_otp_email_rate_idx ON crove_projects.roadmap_otp (org_id, board_id, email_hash, created_at DESC);`
  - `CREATE INDEX IF NOT EXISTS roadmap_otp_ip_rate_idx ON crove_projects.roadmap_otp (org_id, board_id, ip_hash, created_at DESC);`

#### 6. `crove_projects.roadmap_subscriber` (Slice 1, `#4399`)

- `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`
- `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`
- `board_id uuid NOT NULL`
- `voter_email_hash text NOT NULL CHECK (voter_email_hash ~ '^[0-9a-f]{64}$')`
- `email_sealed text NOT NULL` (voter email sealed via deployment credential/subject envelope bound to `(org_id, board_id, voter_email_hash)`, never readable by `crove_tenant` or public APIs; `roadmap_vote` stores zero email text)
- `notify_on_ship boolean NOT NULL DEFAULT true`
- `unsubscribe_token_sha256 text NOT NULL CHECK (unsubscribe_token_sha256 ~ '^[0-9a-f]{64}$')`
- `unsubscribed_at timestamptz`
- `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`, `updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
- Keys & indexes:
  - `PRIMARY KEY (org_id, id)`
  - `CONSTRAINT roadmap_subscriber_board_fk FOREIGN KEY (org_id, board_id) REFERENCES crove_projects.roadmap_board (org_id, id) ON DELETE CASCADE`
  - `CONSTRAINT roadmap_subscriber_uq UNIQUE (org_id, board_id, voter_email_hash)`
  - `CREATE INDEX IF NOT EXISTS roadmap_subscriber_unsub_idx ON crove_projects.roadmap_subscriber (org_id, board_id, unsubscribe_token_sha256);`

### 3.4 Private project guard (`ADR-0056` / `#2604`)

To guarantee a confidential project can never leak onto a public roadmap:

1. **Runtime + DB insert/update guard on `crove_projects.roadmap_board`:** Whenever `project_id IS NOT NULL`, `projects.roadmap.board.*` commands AND a PostgreSQL `BEFORE INSERT OR UPDATE` trigger on `roadmap_board` verify `project.visibility <> 'private'` (failing with `422 ROADMAP_PRIVATE_PROJECT_FORBIDDEN`).
2. **Runtime + DB update guard on `crove_projects.project`:** Updating `project.visibility` from `'org'` to `'private'` (`projects.project.update` AND a PostgreSQL `BEFORE UPDATE OF visibility` trigger on `crove_projects.project`) MUST fail with `409/422` whenever that project is linked to an enabled public `roadmap_board` (or any attached `roadmap_board`, requiring explicit unlink first).
3. **Cross-PR parity with `#2604`:** Whichever of `#2604` and `#4399` merges second ensures `roadmap_board` satisfies `projects-private.db.test.ts` (if `roadmap_board` carries `project_visibility`, `project_id IS NULL OR crove_projects.project_visible(org_id, project_id)` stays cleanly aligned because `project_id` can never reference a `private` project).

### 3.5 Lifecycle: `org_purge`, offboarding, PDPL, and `ADR-0053` keeping sweeps

- **`crove_kernel.org_purge` (`shared-core`):** Adds the new tables to `v_kernel_first` strictly in child-before-parent order ahead of `crove_projects.project_task` and `crove_projects.project`:
  - `crove_projects.roadmap_announcement` (Slice 2), `crove_projects.roadmap_vote`, `crove_projects.roadmap_otp`, `crove_projects.roadmap_subscriber`, `crove_projects.roadmap_item`, `crove_projects.roadmap_board`.
- **`packages/kernel/src/offboarding.ts` (`EXPORT_TABLES`):** Exports `projects.roadmap_board`, `projects.roadmap_item`, `projects.roadmap_vote` (with `omit: ['voter_email_hash']`), and (Slice 2) `projects.roadmap_announcement`. `MACHINERY` tables (`roadmap_otp`, `roadmap_subscriber`) remain excluded from tenant exports (matching `crove_sign.signing_otp`).
- **`packages/kernel/src/personal-data.ts` (`PERSONAL_DATA_COLUMNS`):** Registers `roadmap_board.{title,description}`, `roadmap_item.{public_title,public_summary,submitter_display_name}`, `roadmap_vote.voter_email_hash` (`hashed`), `roadmap_announcement.{title,body_md}` (Slice 2), and `machinery: true` erasure definers for `roadmap_otp.email` and `roadmap_subscriber` (erasing by normalized email / `voter_email_hash` on PDPL delete request).
- **Keeping sweep (`ADR-0053`):** Nightly `projects-roadmap-otp-cleanup` (`keeping`, `runsWhenOff: true`) prunes expired/used/invalidated `roadmap_otp` rows older than 24 hours even when `projects` is switched off.
- **Role write rules:** Org `owner`, `admin`, and `member` manage boards and moderate items (`owner`/`admin` manage board activation, `slug`, `project_id` link, `embed_allowed_origins`, and human-confirmed shipped email batches); `viewer` is read-only. Org-chart agents and `member_vy` are blocked from writing any `roadmap_*` table by `#285` `agent_write_guard`.

## 4. Public authentication, HTTP edge, CSP embed, and abuse defense

### 4.1 Zero-login browse + 1-click 6-digit email OTP (`#203`)

- **Free public viewing:** Anyone can view `GET /api/projects/public-roadmap/:orgSlug/:boardSlug` and browse `/-/roadmap/:orgSlug/:boardSlug` (`Ideas`, `Roadmap`, and Slice 2 `Changelog`) with zero login, zero password, and zero cookies.
- **First Upvote or Idea submission:**
  1. Visitor clicks **Upvote** or **Submit Idea** and enters their email address (or uses an active signed-in Ludy session when already authenticated inside Ludy).
  2. Client calls `POST /api/projects/public-roadmap/:orgSlug/:boardSlug/otp/request`.
  3. Server sends a 6-digit numeric OTP via [ADR-0034](../adr/0034-outbound-email.md) (`kernel-mail-send`), recording only `otp_sha256`, 10-minute `expires_at`, and `attempts = 0` inside `crove_projects.roadmap_otp`.
  4. Visitor enters the 6-digit code (`POST .../otp/verify`); on constant-time SHA-256 match (locked after 5 failed attempts), server marks `verified_at`, records/updates the voter's sealed `roadmap_subscriber` record (when `notify_on_ship` is opted in), and returns a short-lived HMAC-signed voter claim token bound to `(orgId, boardId, voterEmailHash, exp)` (default 2 hours TTL, stored only in browser memory/sessionStorage, never in URL query strings).
  5. Subsequent votes (`POST .../votes`) and idea submissions (`POST .../ideas`) within the claim window verify the HMAC voter claim token with 1-click speed and no repeated OTP prompts.
- **No third-party CAPTCHA (`#203`):** Per `#203` and `apps/kernel/src/http.ts`, public roadmap routes NEVER require Cloudflare Turnstile or any external CAPTCHA widget, ensuring `docker compose up` and Playwright E2E run completely self-contained.

### 4.2 Narrow orgless `SECURITY DEFINER` resolvers (`ADR-0053`)

Every public roadmap route runs through `runtime.orgless` calling narrow `crove_projects.public_roadmap_*` `SECURITY DEFINER` functions (`SET search_path = pg_catalog, pg_temp`, `REVOKE ALL ... FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant`, `GRANT EXECUTE ... TO crove_app`):

1. Resolves `(org_id, board_id)` by `(tenant.slug = orgSlug, roadmap_board.slug = boardSlug)`.
2. Verifies `crove_kernel.org_app_on(org_id, 'projects')` in SQL AND `entitledTo(billing.entitlements(org_id), 'projects')` in the HTTP edge (`apps/kernel/src/http.ts`), plus `board.enabled = true`.
3. Returns **one identical opaque `404`** whenever the org slug is unknown, the board slug does not exist, `board.enabled = false`, `projects` is turned off (`org_app_on = false`), or the org is unentitled.
4. Every SQL public resolver (`public_roadmap_*`) is registered in `apps/kernel/test/invariant/org-app-public-definers.db.test.ts` (`'projects'`), and public API responses set `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`.
5. Note on `public_roadmap_view`: returns only `moderation_status = 'published'` items (`public_title`, `public_summary`, `stage`, `category`, `vote_count`, `submitter_display_name`, `created_at`) and (Slice 2) `status = 'published'` announcements. Never returns `pending`, `merged`, `archived`, `voter_email_hash`, `linked_task_id`, or internal project/task metadata.

### 4.3 Rate limits, `mail_suppression`, and body caps

- **Per-IP, per-board, and per-email DB + edge rate limits:**
  - HTTP edge (`apps/kernel/src/http.ts` `RateLimiter` + `bodyLimit`): per-IP read cap (e.g. `60/min`), per-IP + per-board OTP request cap (`5/min`), per-email-bucket OTP request cap (`3/min`), OTP verify cap (`10/min`), and strict JSON body size caps (`2 KB` for OTP/votes, `16 KB` for idea submissions).
  - Database-level hourly/rolling caps inside `crove_projects.public_roadmap_otp_request` (e.g., max 5 OTP sends per `(org_id, board_id, email_hash)` per hour and max 20 per `(org_id, board_id, ip_hash)` per hour) so multi-instance API deployments share one enforcement boundary.
- **`mail_suppression` check:** Before queueing any OTP email or shipped notification, check `crove_kernel.mail_suppression` (`scope = 'all'`, plus `scope = 'marketing'` / unsubscribe checks for shipped notifications).
- **Voter input sanitization:** Every public idea submission is schema-checked (title `<= 200` chars, summary `<= 4000` chars, optional category & display name, NUL-byte rejected), stored with `source = 'public_submission'`, `tainted = true`, and `moderation_status = 'pending'` when `board.require_moderation = true` (default).

### 4.4 Embeddable widget (`?embed=1`) and CSP `frame-ancestors`

- Standard workspace routes and normal `/-/roadmap/:orgSlug/:boardSlug` pages ALWAYS send `frame-ancestors 'none'`.
- When `GET /-/roadmap/:orgSlug/:boardSlug?embed=1` is requested in `apps/kernel/src/http.ts`:
  - Resolves `board.embed_allowed_origins` via a narrow definer checking `org_app_on(org_id, 'projects')` + billing entitlement + `board.enabled = true`.
  - Validates each configured origin strictly as `https://<hostname>[:<port>]` (rejecting `*`, `http:`, `data:`, `javascript:`, paths, or fragments).
  - If `embed_allowed_origins` is empty, or the board is missing/disabled/off/unentitled, emits **`frame-ancestors 'none'`** (zero framing allowed, zero existence oracle).
  - Only when non-empty validated origins exist does `http.ts` emit `frame-ancestors <origin1> <origin2> ...` while keeping `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `require-trusted-types-for 'script'`, `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.

## 5. UX screens, internal moderation, and shipped notifications

### 5.1 Public 3-tab SPA (`/-/roadmap/:orgSlug/:boardSlug` & `?embed=1`)

- Registered in `MODULE_SCREENS.projects.outside` (`{ path: '/-/roadmap/$orgSlug/$boardSlug', public: true }`, `packages/kernel-contract/src/screens.ts`) and `apps/app/src/router.tsx`.
- **Tab 1: `Ideas` (`Ý tưởng`):** Search bar, category & status filter pills, sort (`Top voted`, `Newest`), upvote button showing current `vote_count` + `"Notify me when shipped"` toggle, and `+ Submit Idea` modal (opening 1-click 6-digit email OTP verification on first vote/submit if not already verified).
- **Tab 2: `Roadmap` (`Lộ trình`):** Clean 3-column board (`Planned`, `In Progress`, `Shipped`) displaying curated published items with category tags and vote counts. (`under_review` stays inside `Ideas` so the Roadmap stays clutter-free.)
- **Tab 3: `Changelog` (`Nhật ký thay đổi`, Slice 2 `#4400`):** Reverse-chronological published announcements with linked shipped `roadmap_item` badges, clean Markdown rendering via safe React components (never `dangerouslySetInnerHTML` with untrusted HTML), and an inline opt-in subscribe/unsubscribe footer.
- **Embed mode (`?embed=1`):** Strips outer marketing chrome, renders compact tabbed card layout tuned for `>= 360 px` widths inside host iframes, and respects `@ludy/ui` semantic OKLCH tokens + `>= 44 px` interactive touch targets.

### 5.2 Internal Projects settings & moderation console (`/o/:slug/projects`)

Inside Projects settings / Roadmap tab (accessible to org `owner`, `admin`, `member`; `viewer` read-only):

1. **1-click Board Setup:** Toggle board `enabled` (`false` by default), auto-generate/edit `slug`, view and copy `/-/roadmap/:orgSlug/:boardSlug` and `<iframe>` embed snippet, configure `allow_submissions`, `allow_voting`, `require_moderation`, optional `project_id` (org-visible projects only), and `embed_allowed_origins`.
2. **Moderation Queue (`Pending` / `Published` / `Merged` / `Archived`):**
   - Inspect new `public_submission` items (marked with a `Tainted / External` badge).
   - Human actions via `Runtime.execute()`:
     - `projects.roadmap.item.moderate`: edit `public_title`/`public_summary`/`category`, `publish`, `archive`, or set `stage` (`under_review | planned | in_progress | shipped`).
     - `projects.roadmap.item.merge`: merge duplicate idea into a canonical `roadmap_item`, atomically transferring distinct `(org_id, voter_email_hash)` votes (deduplicated) and subscribers (`roadmap_subscriber`) without inflating counts, recalculating `vote_count`, and marking the source item `moderation_status = 'merged'`, `merged_into_item_id = targetId`.
     - `projects.roadmap.item.convert_to_task`: explicitly creates a `crove_kernel.task` (`tainted: true`, `sourceRef` pointing to the roadmap item) inside the linked org-visible project (`project_task`) and sets `roadmap_item.linked_task_id`, ONLY on explicit human click.
     - `projects.roadmap.item.sync_stage`: deterministic helper/prompt when a linked internal `project_task` reaches `in_progress` or `done` so the moderator can update the public `stage` cleanly without leaking internal task content.
3. **Changelog Composer & Human-Confirmed Shipped Alerts (Slice 2, `#4400`):**
   - Select `shipped` items, draft announcement (`title`, `body_md`, optionally assisted by Vy), preview exact recipient count of active `notify_on_ship = true` subscribers (computed deterministically by SQL definer without revealing emails), and click **Publish Changelog** and optionally **Confirm Send Notifications** (`projects.roadmap.announcement.send_notifications`, risk `R2`).
   - Worker queues transactional notification emails via [ADR-0034](../adr/0034-outbound-email.md) (`kernel-mail-send`), checking `mail_suppression` per recipient, unsealing email only at dispatch time, and embedding a one-click fragment unsubscribe link `/-/roadmap/:orgSlug/:boardSlug#unsubscribe=<token>` that posts to `POST /api/projects/public-roadmap/:orgSlug/:boardSlug/votes` (`action: 'unsubscribe'`) so email security scanners cannot accidentally unsubscribe users via GET prefetch.

## 6. AI-native Vy workflows (`packages/agent`) and MCP readiness

### 6.1 Metered Vy features (`AI_FEATURES` under `'projects'`)

All model calls live in `packages/agent`, run inside `withAiScope` + `metered(...)`, declare `tools: []`, and wrap `public_submission` text in untrusted data delimiters ([ADR-0018](../adr/0018-untrusted-content.md)):

1. **`projects.roadmap_dedupe` (Slice 2, `#4400`):**
   - Given bounded lists of `pending` and `published` items on one board (IDs, `public_title`, `public_summary`, `vote_count`), suggests candidate duplicate clusters (`targetItemId`, `duplicateItemIds[]`, `reason`) and top customer demand themes.
   - Prompt instructions explicitly treat all item text as untrusted customer data; strict Zod schema verifies every returned ID exists in the input list (`tools: []`).
   - UI displays suggestions with a `proposal` / `"De xuat"` mark; nothing merges or publishes until the moderator clicks **Confirm Merge**.
2. **`projects.roadmap_changelog_draft` (Slice 2, `#4400`):**
   - Given selected `shipped` `roadmap_item` records (`public_title`, `public_summary`, deterministic `vote_count` and item count), drafts a plain-Vietnamese Frill-style Changelog title and release-note body.
   - Output is validated with `summaryNumbersOutside` ([#1237](https://github.com/DOS/Ludy/issues/1237)) so any hallucinated number, metric, or date not present in the input facts is refused.
   - Human edits and explicitly clicks **Publish**.
3. **100% AI-off parity:** When AI is disabled, budget-exhausted, or killed by switch, moderators still search/filter/merge duplicates, convert items to tasks, write announcements manually, and send shipped notifications normally.

### 6.2 MCP read tools (`ADR-0051`)

- Add read-only company-grant MCP queries (`mcp: { scope: 'ludy.read' }`, `access: ['owner', 'admin']`) in `modules/projects` (`projects.mcp.roadmap_ideas`, `projects.mcp.roadmap_demand_summary`):
  - Returns bounded, sanitized `roadmap_item` metadata (`id`, `boardSlug`, `stage`, `moderationStatus`, `category`, `publicTitle`, `publicSummary`, `voteCount`, `tainted`) and top categories/vote aggregates.
  - Excludes all `voter_email_hash`, `roadmap_otp`, `roadmap_subscriber` data, and private projects; lines pass through `plainLine(...)` and mark tainted submissions clearly as untrusted user feedback (`ADR-0018`, `ADR-0051`).

### 6.3 Future omnichannel signal hook (explicitly deferred out of `M3`)

- In a future post-M3 slice (not scheduled in `#4398`, `#4399`, or `#4400`), Ludy can ingest candidate feature requests flagged from CRM deals, Inbox conversations, and Meeting Notes into `crove_projects.roadmap_item` (`source = 'internal'`, `moderation_status = 'pending'`) with optional internal customer account demand weighting.
- Keeping that hook cleanly separated behind `roadmap_item` avoids cross-module coupling (`conformance.db.test.ts` `cross-module`) and keeps `#4399` and `#4400` lean for SMEs today.

## 7. Phased implementation plan (`#4398`, `#4399`, `#4400`)

| Phase | Issue | Scope | Key invariants & protected/shared-core gates |
| --- | --- | --- | --- |
| Plan & ADR | [#4397](https://github.com/DOS/Ludy/issues/4397) | `projects-public-roadmap.md`, `projects-public-roadmap.vi.md`, `ADR-0057`, cross-refs in `projects.md` & `projects-v2.md` | Docs-only (`pnpm docs:check`) |
| Step 0 Invariants | [#4398](https://github.com/DOS/Ludy/issues/4398) | `apps/kernel/test/invariant/rls-matrix.db.test.ts`: register all 6 tables (`roadmap_announcement`, `roadmap_board`, `roadmap_item`, `roadmap_otp`, `roadmap_subscriber`, `roadmap_vote`) in `PENDING_TABLES` + `ROW_FACTORIES`, and `roadmap_otp` + `roadmap_subscriber` in `MACHINERY`. `apps/kernel/test/invariant/route-coverage.test.ts`: add the 5 `/api/projects/public-roadmap/:orgSlug/:boardSlug*` routes to `PENDING` (plus matching `'pending'` entries in `app-gate-routes.test.ts`). | Protected invariant suite; `route-coverage.test.ts` `PENDING` triggers `shared-core` Platform PO review ([product-owner-config.md](../product-owner-config.md#shared-core-review)); independent security review; CI green with zero table migrations yet |
| Slice 1 Core | [#4399](https://github.com/DOS/Ludy/issues/4399) | Migration for 5 Slice 1 tables (`roadmap_board`, `roadmap_item`, `roadmap_vote`, `roadmap_otp`, `roadmap_subscriber`), `crove_kernel.org_purge` (`shared-core`), private-project DB/runtime guards, narrow orgless `SECURITY DEFINER` resolvers (`org_app_on` + opaque `404`), public OTP/idea/vote HTTP handlers (`apps/kernel/src/http.ts`, moving the 5 routes `PENDING -> PUBLIC` and `app-gate-routes.test.ts` `pending -> sql`, plus `org-app-public-definers.db.test.ts`), internal `Runtime.execute()` commands, public SPA `/-/roadmap/:orgSlug/:boardSlug` (`Ideas` + `Roadmap`), internal board settings + moderation queue, remove 5 tables from `PENDING_TABLES` (keeping `roadmap_announcement` pending for Slice 2) | Depends on `#4398`; touches `migrations`, `org_purge`, `http.ts`, `route-coverage.test.ts` -> `shared-core` Platform PO review + independent security review; 100% functional with AI off |
| Slice 2 Changelog, Embed, Vy AI & MCP | [#4400](https://github.com/DOS/Ludy/issues/4400) | Migration for `roadmap_announcement`, `org_purge` update if needed, remove `roadmap_announcement` from `PENDING_TABLES`, `Changelog` tab on `/-/roadmap/:orgSlug/:boardSlug`, `?embed=1` strict CSP `frame-ancestors` allowlist in `apps/kernel/src/http.ts` (`shared-core`), human-confirmed shipped email alerts (`mail_suppression` + `#unsubscribe=` POST flow), Vy `projects.roadmap_dedupe` & `projects.roadmap_changelog_draft` (`AI_FEATURES`, `summaryNumbersOutside`), MCP read tools (`ADR-0051`) | Depends on `#4398` and `#4399`; touches `migrations`, `http.ts` -> `shared-core` Platform PO review + independent security review; 100% functional with AI off |
