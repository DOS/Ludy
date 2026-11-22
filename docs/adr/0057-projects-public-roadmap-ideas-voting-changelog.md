# 0057. Projects Public Roadmap: isolated schema, email OTP voting without CAPTCHA, embed CSP, and AI-native Vy/MCP workflows

- Status: **Accepted** (owner decision `2026-11-22T10:04+07:00` in `Projects & Notes Product Owner` session, decisions `A1`, `A2`, and product direction, logged in [#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7073382197)).
- Date: 2026-11-22
- Deciders: owner (JOY) for zero-login browse + 1-click 6-digit email OTP without third-party CAPTCHA (`A1`), priority ordering behind Projects v2 Wave 1 (`A2`), and Frill/UserJot 3-tab UX + AI-native Vy/MCP direction; technical design in this record authored for [#4397](https://github.com/DOS/Ludy/issues/4397).
- Builds on: [ADR-0048](0048-projects-on-kernel-tasks.md) (Projects on kernel tasks), [ADR-0056](0056-projects-v2-cycles-columns-dependencies-privacy.md) (Projects v2 & private projects `#2604`), [ADR-0017](0017-crypto-shredding.md) (crypto-shredding & PDPL erasure), [ADR-0018](0018-untrusted-content.md) (untrusted content & taint boundary), [ADR-0029](0029-agents-positions-and-org-chart.md) (taint, agent write guard `#285`), [ADR-0031](0031-module-enablement.md) (module enablement), [ADR-0034](0034-outbound-email.md) (outbound email & `mail_suppression`), [ADR-0051](0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md) (MCP endpoint), [ADR-0053](0053-per-org-app-enablement.md) (`org_app_on` & opaque `404`), [ADR-0054](0054-rebrand-internal-crove-identifiers-to-ludy.md) (`@ludy/*` & planned SQL identifier cutover), and [scope.md](../product/scope.md).
- Plan: [projects-public-roadmap.md](../plan/projects-public-roadmap.md) (Vietnamese owner summary: [projects-public-roadmap.vi.md](../plan/projects-public-roadmap.vi.md)); cross-referenced in [projects.md](../plan/projects.md) and [projects-v2.md](../plan/projects-v2.md).
- Issues: [#4397](https://github.com/DOS/Ludy/issues/4397) (Plan & ADR-0057), [#4398](https://github.com/DOS/Ludy/issues/4398) (Step 0 Invariants), [#4399](https://github.com/DOS/Ludy/issues/4399) (Slice 1 Core), [#4400](https://github.com/DOS/Ludy/issues/4400) (Slice 2 Changelog, Embed, Vy AI & MCP).

## Context and problem statement

Vietnamese SMEs, software agencies, SaaS teams, and solo makers using Ludy Teamwork need a lightweight, self-hosted public product feedback portal: a 3-tab public board (`Ideas`, `Roadmap`, `Changelog`) with embeddable widget support (Frill.co / UserJot UX) combined with AI-assisted duplicate clustering, closed-loop release note drafting, and agent-accessible customer demand queries (Quackback / Productlane / Cycle workflows).

Opening any public surface in Ludy introduces five architectural and security risks that must be settled before writing migrations or routes:

1. **Zero leakage of internal Projects & Kernel tasks:** Internal `crove_projects.project` rows and `crove_kernel.task` rows hold employee seats, internal discussions, private projects (`#2604`), legal-entity scopes, and private notes (`ADR-0037`). Public visitors must never query or infer those tables.
2. **Sybil / spam resistance without breaking self-hosting (`#203`):** Public voting and idea submission cannot require heavy account registration/passwords, nor can Ludy depend on third-party CAPTCHA services (Cloudflare Turnstile / reCAPTCHA) that fail offline `docker compose up` deployments and E2E suites.
3. **Voter & subscriber email privacy:** Enabling opt-in shipped email notifications requires holding a verified email address to send notifications later, without exposing voter/subscriber email addresses to unauthenticated callers, public read APIs, or ordinary `crove_tenant` queries.
4. **Safe iframe embedding (`?embed=1`):** Embedding the widget inside a customer's marketing site or app requires relaxing `frame-ancestors 'none'` only on explicit, validated HTTPS origins without opening clickjacking across Ludy's authenticated workspace or revealing disabled boards.
5. **Untrusted public submissions in AI & MCP:** Public idea titles and summaries are attacker-controlled text (`tainted`). Sending them to Vy or exposing them over `/mcp` must prevent prompt injection, hallucinated changelog metrics, or unapproved mutations.

## Decision drivers

- **Opt-in OPC/SME default ([scope.md](../product/scope.md)):** Every board defaults to `enabled = false`. One click activates SME defaults (`allow_submissions = true`, `allow_voting = true`, `require_moderation = true`) with zero extra setup.
- **Self-contained `docker compose up` without CAPTCHA (`#203`):** Public OTP auth reuses Ludy's existing outbound mail pipeline ([ADR-0034](0034-outbound-email.md)) and kernel rate limiters with zero external challenge providers.
- **Defense in depth at PostgreSQL & HTTP edge:** Separate `crove_projects.roadmap_*` tenant tables, definer-only `MACHINERY` tables (`roadmap_otp`, `roadmap_subscriber`), narrow orgless `SECURITY DEFINER` resolvers checking `org_app_on` + entitlement (`ADR-0053`), and strict DB/runtime private-project refusal guards (`#2604`).
- **100% AI-off deterministic parity:** Browsing, OTP verification, submissions, voting, moderation, merges, task linking, 3-stage roadmap progression, manual changelog authoring, and shipped alerts operate completely without AI.

## Decision

### 1. Strict schema isolation and private-project refusal (`#4399`, `#4400`)

- **Public endpoints NEVER query `crove_projects.project` or `crove_kernel.task`.**
- Four isolated tenant tables in `crove_projects` carry `org_id`, `PRIMARY KEY (org_id, id)`, composite tenant FKs led by `org_id` with supporting indexes, and `crove_kernel.apply_tenant_rls` (which installs tenant isolation and the `#285` `agent_write_guard` blocking org-chart agents and `member_vy`):
  - `crove_projects.roadmap_board`: `org_id`, `id`, `slug`, `title` (`pii`), `description` (`pii`), `enabled boolean DEFAULT false`, nullable `project_id` FK (`crove_projects.project`), `allow_submissions`, `allow_voting`, `require_moderation DEFAULT true`, `embed_allowed_origins text[] DEFAULT '{}'`, timestamps.
  - `crove_projects.roadmap_item`: `org_id`, `id`, `board_id`, `linked_task_id` (nullable composite FK to `crove_projects.project_task (org_id, task_id)`), `source` (`'internal' | 'public_submission'`), `moderation_status` (`'pending' | 'published' | 'merged' | 'archived'`), `merged_into_item_id`, `stage` (`'under_review' | 'planned' | 'in_progress' | 'shipped'`), `category`, `public_title` (`pii`), `public_summary` (`pii`), `vote_count integer DEFAULT 0`, `tainted boolean DEFAULT false` (DB check constraint forces `tainted = true` for every `public_submission`), `submitter_display_name` (`pii`).
  - `crove_projects.roadmap_vote`: `org_id`, `id`, `board_id`, `item_id`, `voter_email_hash` (keyed HMAC-SHA256, never returned publicly), `notify_on_ship`, `UNIQUE (org_id, item_id, voter_email_hash)`.
  - `crove_projects.roadmap_announcement` *(Slice 2, `#4400`)*: `org_id`, `id`, `board_id`, `title` (`pii`), `body_md` (`pii`), `status` (`'draft' | 'published'`), `published_at`, `linked_item_ids uuid[]` (referencing shipped items on the same board/org), `notifications_sent_at`.
- **Stage-only link semantics:** Linking `roadmap_item.linked_task_id` to `project_task` syncs ONLY stage progression into `roadmap_item.stage`. Internal task descriptions, assignees, seats, legal entities, comments, attachments, and linked notes are never queried or exposed on public routes.
- **Private-project DB + runtime refusal (`ADR-0056` / `#2604`):**
  - `projects.roadmap.board.*` commands and a DB trigger on `crove_projects.roadmap_board` MUST refuse linking any project whose `visibility = 'private'`.
  - `projects.project.update` and a `BEFORE UPDATE OF visibility` DB trigger on `crove_projects.project` MUST refuse changing `visibility` to `'private'` while the project is linked to an enabled public `roadmap_board` (or any attached `roadmap_board`, requiring explicit unlink first).
  - Whichever of `#2604` and `#4399` merges second ensures `projects-private.db.test.ts` remains green with all `crove_projects.*` tables accounted for.
- **Purge, export, and PDPL lifecycle:** `crove_kernel.org_purge` (`shared-core`) deletes `roadmap_announcement`, `roadmap_vote`, `roadmap_otp`, `roadmap_subscriber`, `roadmap_item`, and `roadmap_board` in child-before-parent order ahead of `project_task` and `project`. `packages/kernel/src/offboarding.ts` exports `roadmap_board`, `roadmap_item`, `roadmap_vote` (omitting `voter_email_hash`), and `roadmap_announcement`; `packages/kernel/src/personal-data.ts` registers all `pii` fields plus `machinery: true` erasure definers.

### 2. Definer-only `MACHINERY` tables for OTP & subscriber emails (`#4399`)

Matching `crove_sign.signing_otp` (`#3323`, `#3551`), two tables are registered in `rls-matrix.db.test.ts` `MACHINERY` with RLS enabled, `agent_write_guard` installed, and **zero grants** to `PUBLIC`, `crove_tenant`, `crove_app`, `crove_worker`, or `crove_definer_tenant`:

- **`crove_projects.roadmap_otp`:** Stores 6-digit email OTP SHA-256 hash (`otp_sha256`), 10-minute TTL (`expires_at`), 5-attempt lockout (`attempts`), single-use `verified_at`/`invalidated_at`, short-lived HMAC claim hash (`claim_sha256`), and per-IP / per-board / per-email rate-limit tracking (`ip_hash`, `email_hash`). Zero plaintext OTPs are stored in PostgreSQL or `pgboss.job` payloads. A `keeping` cleanup sweep (`runsWhenOff: true`) prunes expired/used rows after 24 hours.
- **`crove_projects.roadmap_subscriber`:** Keyed by `(org_id, board_id, voter_email_hash)`, storing the sealed voter email (`email_sealed` encrypted via Ludy's vault/subject sealing boundary), `notify_on_ship`, and `unsubscribe_token_sha256`. Because `roadmap_vote` holds only `voter_email_hash`, neither login reads (`crove_tenant`) nor public APIs can extract subscriber email addresses. Emails are unsealed strictly inside the worker/definer dispatch path when a human explicitly confirms sending shipped notifications.

### 3. Zero-login browsing + 6-digit email OTP without CAPTCHA (`#203`) & `ADR-0053` opaque `404`

- **Public access model (Owner Decision `A1`):**
  - Browsing published `Ideas`, `Roadmap` (`Planned`, `In Progress`, `Shipped`), and `Changelog` at `/-/roadmap/:orgSlug/:boardSlug` via `GET /api/projects/public-roadmap/:orgSlug/:boardSlug` requires zero login.
  - First Upvote or Idea submission requires verifying email via a 1-click 6-digit OTP challenge (`POST .../otp/request`, `POST .../otp/verify`), returning a short-lived HMAC-signed voter claim token for subsequent vote/submit calls (`POST .../votes`, `POST .../ideas`) without passwords. Authenticated Ludy workspace users may also vote/submit via their active session.
- **No third-party CAPTCHA (`#203`):** Rate limits use Ludy's edge `RateLimiter` (per-IP, per-board, per-email buckets) + DB rolling hourly caps inside `roadmap_otp` + strict body limits (`2 KB` / `16 KB`), plus `crove_kernel.mail_suppression` (`scope = 'all'`) checks before dispatching OTP or shipped emails.
- **Narrow orgless `SECURITY DEFINER` resolvers (`ADR-0053`):** All `crove_projects.public_roadmap_*` definers (`SET search_path = pg_catalog, pg_temp`) enforce `crove_kernel.org_app_on(org_id, 'projects')` and `board.enabled = true`, paired with `entitledTo(billing.entitlements(org_id), 'projects')` at the HTTP edge (`apps/kernel/src/http.ts`). Unknown orgs, disabled boards, `projects` app off, and unentitled orgs return one identical opaque `404` with `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and `X-Content-Type-Options: nosniff`. All public definers are pinned in `apps/kernel/test/invariant/org-app-public-definers.db.test.ts`.
- **One-click unsubscribe without extra public routes:** Shipped notification emails link to `/-/roadmap/:orgSlug/:boardSlug#unsubscribe=<token>`, which posts `action: 'unsubscribe'` to `POST /api/projects/public-roadmap/:orgSlug/:boardSlug/votes` (`unsubscribe_token_sha256` match), preventing email link scanners from triggering state changes via `GET` prefetch while staying inside the 5 Step 0 registered route patterns.

### 4. Strict CSP `frame-ancestors` for embeddable widget (`?embed=1`, `#4400`)

- Standard Ludy routes and non-embed `/-/roadmap/:orgSlug/:boardSlug` keep `frame-ancestors 'none'`.
- `/-/roadmap/:orgSlug/:boardSlug?embed=1` inspects `board.embed_allowed_origins` through the same `org_app_on` + entitlement + `enabled = true` resolver:
  - Every stored origin MUST pass strict `https://<host>[:port]` validation (zero `*`, zero `http:`, zero paths/queries).
  - If `embed_allowed_origins` is empty, or the board is missing/disabled/off/unentitled, `apps/kernel/src/http.ts` sends `frame-ancestors 'none'` (zero framing allowed and zero existence oracle).
  - Only when validated HTTPS origins exist does `http.ts` emit `frame-ancestors <origin1> <origin2> ...` while preserving `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, and `require-trusted-types-for 'script'`.

### 5. Taint boundary, Vy `AI_FEATURES`, MCP read tools, and deferred omnichannel hook

- **Mandatory taint & moderation:** Every `public_submission` inserts with `tainted = true` and `moderation_status = 'pending'`. Moderators explicitly review, publish, merge (atomically deduplicating `(org_id, voter_email_hash)` votes and recalculating `vote_count`), archive, or convert items to `crove_kernel.task` (`tainted: true`) through `Runtime.execute()`.
- **Vy (`gm`) metered features (`packages/agent/src/meter.ts` under `'projects'`):**
  - `projects.roadmap_dedupe` (`tools: []`): reads bounded `pending`/`published` submissions strictly as untrusted data ([ADR-0018](0018-untrusted-content.md)), proposing duplicate clusters and demand themes; humans click Confirm to merge or convert.
  - `projects.roadmap_changelog_draft` (`tools: []`): drafts plain-Vietnamese release notes from selected `shipped` items, checked by `summaryNumbersOutside` (`#1237`) against input counts/dates; humans edit and click Publish and separately Confirm Send Notifications.
- **MCP read tools (`ADR-0051`):** `projects.mcp.roadmap_ideas` and `projects.mcp.roadmap_demand_summary` (`mcp: { scope: 'ludy.read' }`, company grants `owner`/`admin`) return sanitized, line-bounded demand metadata marked as untrusted customer text, with zero voter hashes or subscriber emails.
- **Deferred omnichannel hook:** Ingesting feature requests from CRM deals, Inbox conversations, and Meeting Notes into the moderation queue with customer account attribution is explicitly deferred out of `#4398`, `#4399`, and `#4400` into a future separately prioritized slice.

### 6. Two-step invariant & `shared-core` governance (`#4398` -> `#4399` -> `#4400`)

Because `.github/workflows/protected.yml` runs `origin/main`'s `test/invariant/**` suite against every protected-path PR:

1. **Step 0 (`#4398`):** Lands on `main` BEFORE Slice 1 (`#4399`) or Slice 2 (`#4400`), registering all 6 tables in `rls-matrix.db.test.ts` (`PENDING_TABLES` + `ROW_FACTORIES`, with `roadmap_otp` and `roadmap_subscriber` in `MACHINERY`), adding the 5 `/api/projects/public-roadmap/:orgSlug/:boardSlug*` route patterns to `route-coverage.test.ts` `PENDING` (`shared-core` Platform PO review), and adding matching `'pending'` entries to `app-gate-routes.test.ts` `CLASSES`.
2. **Slice 1 (`#4399`):** Creates the 5 core tables (`roadmap_board`, `roadmap_item`, `roadmap_vote`, `roadmap_otp`, `roadmap_subscriber`), updates `org_purge` (`shared-core`), removes those 5 tables from `PENDING_TABLES` (keeping `roadmap_announcement` pending for Slice 2), moves the 5 public routes from `PENDING` to `PUBLIC` in `route-coverage.test.ts` (`app-gate-routes.test.ts` `pending -> sql`, `org-app-public-definers.db.test.ts` checks), and ships OTP auth + `Ideas` & `Roadmap` tabs + moderation console.
3. **Slice 2 (`#4400`):** Creates `roadmap_announcement`, removes it from `PENDING_TABLES`, adds `Changelog`, `?embed=1` CSP `frame-ancestors` (`http.ts`, `shared-core`), human-confirmed shipped email notifications, Vy `projects.roadmap_dedupe` & `projects.roadmap_changelog_draft`, and MCP read tools.

## Consequences

- **Good:** SMEs gain a clean Frill/UserJot public portal and Quackback/Cycle AI triage + MCP demand workflow without enterprise complexity, zero setup when off, zero CAPTCHA dependencies (`#203`), and 100% AI-off functionality.
- **Good:** Internal `crove_projects.project`, `crove_kernel.task`, private projects (`#2604`), private notes (`ADR-0037`), and voter emails stay strictly isolated from public routes and `crove_tenant` reads.
- **Bad / Cost:** Adds 6 new tables (including 2 `MACHINERY` tables), `org_purge` and `http.ts` (`shared-core`) changes, Step 0 invariant prep (`#4398`), and independent security + Platform PO reviews on `#4398`, `#4399`, and `#4400`.
- **Neutral:** `roadmap_item` links to `project_task` sync stage only; richer bidirectional CRM/Inbox/Meetings feedback attribution awaits a future slice.

## Alternatives considered

1. **Exposing `crove_kernel.task` rows directly via a `public_roadmap` boolean flag:** Rejected. Any bug in query filters, RLS, or `le_scope` / `private_project_scope` (`#2604`) could leak internal task titles, assignees, comments, or private projects. Dedicated `roadmap_*` tables guarantee structural isolation.
2. **Using Cloudflare Turnstile / external CAPTCHA (`#203`) on public votes/ideas:** Rejected by owner decision (`A1`) and `#203`. Breaks self-contained `docker compose up` and automated E2E runs; 6-digit email OTP + edge/DB rate limits stop unverified spam cleanly.
3. **Requiring password-based voter guest accounts (or reopening `#2603` client portals):** Rejected. Creates high friction for casual public upvoters and conflates public product roadmaps with authenticated multi-project client workspaces (`#2603`, kept in Icebox).
4. **Storing plaintext voter emails directly on `crove_projects.roadmap_vote`:** Rejected. Any member reading `roadmap_vote` via `crove_tenant` would harvest customer emails; isolating sealed emails in `MACHINERY` `roadmap_subscriber` and storing only `voter_email_hash` in `roadmap_vote` preserves privacy.
5. **Allowing `frame-ancestors *` for `?embed=1`:** Rejected. Enables clickjacking across any hostile domain; `embed_allowed_origins` enforces explicit HTTPS origin allowlisting and denies framing by default (`'none'`).
6. **Auto-merging Vy duplicate suggestions or auto-sending shipped emails when tasks move to `done`:** Rejected by [scope.md](../product/scope.md) and [ADR-0018](0018-untrusted-content.md). Public text is tainted and humans must approve every merge, publish, and outbound email batch.

## Revisit when

- SME users ask to ingest candidate feature requests from CRM deals, Inbox conversations, and Meeting Notes into the moderation queue with customer account weighting (post-M3 omnichannel signal slice).
- Pilot partners request private authenticated client portals for project deliverables ([#2603](https://github.com/DOS/Ludy/issues/2603), Icebox, requires its own external-auth ADR).
- `ADR-0054` SQL schema rename (`crove_projects` -> `ludy_projects`, `crove_kernel` -> `ludy_kernel`) lands via `#3970` / `#3971`, after which any pending migrations use `ludy_*` identifiers.
