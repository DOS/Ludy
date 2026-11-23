# 0058. Projects Omnichannel Roadmap Signals and Pre-Task Triage Inbox

- Status: **Accepted** (owner decision `2026-11-23T10:20+07:00` in `Projects & Notes Product Owner` session, popup `A1`, logged in [#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7090763080)).
- Date: 2026-11-23
- Deciders: owner (JOY) for the `M3 Paid pilot` scope and `A1` product direction (Omnichannel Roadmap Signals + Projects Triage Inbox); technical design in this record authored for [#4490](https://github.com/DOS/Ludy/issues/4490).
- Builds on: [ADR-0048](0048-projects-on-kernel-tasks.md) (Projects on kernel tasks), [ADR-0049](0049-member-scoped-vy.md) (member-scoped Vy), [ADR-0056](0056-projects-v2-cycles-columns-dependencies-privacy.md) (Projects v2 & private projects `#2604`), [ADR-0057](0057-projects-public-roadmap-ideas-voting-changelog.md) (Public Roadmap isolation & Vy/MCP), [ADR-0018](0018-untrusted-content.md) (untrusted content & taint boundary), [ADR-0029](0029-agents-positions-and-org-chart.md) (taint, agent write guard `#285`, lease rules), [ADR-0031](0031-module-enablement.md) (module enablement & caller-scoped `ctx.query`), [ADR-0051](0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md) (MCP read scope), [ADR-0053](0053-per-org-app-enablement.md) (`org_app_on`), [ADR-0054](0054-rebrand-internal-crove-identifiers-to-ludy.md) (`ludy_kernel` / `ludy_tenant` landed via `#3970` & module cutover `#3971`), and [scope.md](../product/scope.md).
- Plan: [projects-signals-triage.md](../plan/projects-signals-triage.md) (Vietnamese owner summary: [projects-signals-triage.vi.md](../plan/projects-signals-triage.vi.md)); cross-referenced in [projects-public-roadmap.md](../plan/projects-public-roadmap.md) and [projects-v2.md](../plan/projects-v2.md).
- Issues: [#4490](https://github.com/DOS/Ludy/issues/4490) (Plan & ADR-0058), [#4491](https://github.com/DOS/Ludy/issues/4491) (Step 0 Invariants), [#4492](https://github.com/DOS/Ludy/issues/4492) (Slice 1 Omnichannel Roadmap Signals), [#4493](https://github.com/DOS/Ludy/issues/4493) (Slice 2 Projects Triage Inbox, Vy AI & MCP).

## Context and problem statement

With Projects v2 ([ADR-0056](0056-projects-v2-cycles-columns-dependencies-privacy.md)) and Public Roadmap ([ADR-0057](0057-projects-public-roadmap-ideas-voting-changelog.md)) landed on `main`, SME product and service teams using Ludy need two tightly connected capabilities across Ludy's unified OS without turning simple boards into enterprise noise:

1. **Omnichannel Roadmap Signals (`#4492`, Productlane / Cycle workflow):** Product demand does not arrive only through public upvotes on `/-/roadmap/:orgSlug/:boardSlug`. Sales reps hear feature blockers on CRM Deals, support teams read requests inside Inbox Conversations, and founders capture requests during Meetings. Teams need to link those customer signals to internal `roadmap_item` entries with optional account attribution, customer quote excerpts, and per-currency deal value rollups, assisted by Vy matching suggestions.
2. **Pre-Task Projects Triage Inbox (`#4493`, Linear Triage workflow):** Raw incoming requests from Public Roadmap ideas, Inbox Conversations, Meetings, or quick team intake should not clutter `ludy_kernel.task`, My Tasks (`/o/:slug/my-work`), Kanban WIP counts, Cycles, or Gantt timelines before a human decides whether the work is real, duplicate, snoozed, or declined.

Building these two workflows across CRM, Inbox, Meetings, Projects, Public Roadmap, Vy AI, and `/mcp` raises six architectural and security boundaries that must be settled before writing migrations or RPC code:

1. **Cross-module isolation (`conformance.db.test.ts`, `depcruise`, `ctx-query-access.db.test.ts`):** `modules/projects` must never import `@ludy/mod-crm`, `@ludy/mod-meetings`, or `@ludy/mod-notes`, join across module SQL schemas, add cross-module foreign keys, or bypass caller RLS on private conversations, private meetings, or CRM deals.
2. **Public Roadmap vs. internal commercial data:** Linking a high-value CRM deal or customer quote to a `roadmap_item` must NEVER expose customer names, quote excerpts, or deal values on unauthenticated `/-/roadmap/:orgSlug/:boardSlug` routes or `public_roadmap_view`.
3. **Multi-currency money precision:** Deal values from CRM (`NUMERIC(18, 2)`) may be recorded across currencies (`VND`, `USD`, etc.). Aggregating rollups with JS floating-point numbers or summing across different currencies corrupts totals.
4. **Pre-task isolation, lock safety, and private projects (`#2604`):** Triaging raw items must keep `ludy_kernel.task` clean until accepted, enforce canonical `position -> project` lock ordering on acceptance, and isolate triage rows of `visibility = 'private'` projects strictly from non-members.
5. **Untrusted omnichannel & triage text in AI/MCP:** Conversation messages, meeting transcripts, and public ideas are `tainted`. Vy prompts and `/mcp` summaries must block prompt injection, hallucinated UUIDs/URLs, private-project leaks, and unapproved writes.
6. **PDPL, offboarding, and two-step invariant governance:** Every new `pii` text column and table must pass PDPL find/erase, tenant offboarding export, cumulative `ludy_kernel.org_purge`, and Step 0 `PENDING_TABLES` registration on `main` ahead of feature migrations.

## Decision drivers

- **OPC/SME zero-setup default ([scope.md](../product/scope.md)):** Solo founders and simple projects see zero extra settings or triage noise until they capture a signal or send an item to Triage.
- **Strict module decoupling & caller authority ([ADR-0031](0031-module-enablement.md)):** Reuse `ctxQueryFn` in `modules/projects/src/tasks-from-source.ts` so every cross-module read respects `ctx.installed(...)`, `org_app_on`, and caller RLS.
- **SQL schema transition alignment ([ADR-0054](0054-rebrand-internal-crove-identifiers-to-ludy.md)):** `ludy_kernel` and `ludy_tenant` are active on `origin/main` (`#3970`), while module schemas currently remain `crove_projects`, `crove_crm`, `crove_meetings` pending `#3971`. Every Step 0 and feature PR must match the active Projects schema on `origin/main` when it lands (`crove_projects` today, `ludy_projects` once `#3971` merges).
- **100% AI-off deterministic parity:** Signal capture, per-currency rollups, triage workflow transitions (`create`, `accept`, `merge`, `snooze`, `decline`, `reopen`), and MCP reads operate completely with AI off or budget spent.

## Decision

### D1. Caller-scoped cross-module reads via `ctxQueryFn` (`#4492`, `#4493`)

- Extend `ctxQueryFn` in `modules/projects/src/tasks-from-source.ts` to add `if (name.startsWith('crm.') && !ctx.installed('crm')) return { status: 'not_installed' };` alongside existing `notes.` and `meetings.` guards.
- Read external module sources strictly through `ctx.query<T>(...)` inside the caller's own `Runtime` user context and PostgreSQL RLS (`apps/kernel/test/invariant/ctx-query-access.db.test.ts`, `#199`):
  - **CRM Deals:** `crm.deal.get` (and `crm.deal.list` when browsing/searching deals in the capture picker).
  - **Inbox Conversations:** `kernel.conversation.get` (and `kernel.conversation.list` / kernel conversation queries; direct, private, or restricted threads that caller RLS hides fail closed as not found).
  - **Meetings:** `meetings.meeting.get`, `meetings.result.get`, `meetings.notes.get` (only when `meeting.isRecorder` is true, matching `tasks-from-source.ts`), and `meetings.transcript.get` fallback.
- **Hard module boundary rules:**
  - Zero `@ludy/mod-crm`, `@ludy/mod-meetings`, or `@ludy/mod-notes` imports inside `modules/projects` (`package.json` or `src/**`), enforced by `pnpm depcruise`.
  - Zero cross-module SQL joins (`JOIN crove_crm.*` or `JOIN crove_meetings.*`) inside `modules/projects`, and zero cross-module PostgreSQL foreign keys (`packages/db/test/invariant/conformance.db.test.ts` `cross-module` rule).
  - Source pointers `(source_type, source_id)` are stored as validated UUID + enum metadata with no cross-module FK; `ctx.audit(...)` records only IDs and masked `auditValue(...)` markers, never clear-text private conversation or meeting bodies.

### D2. Internal-only `crove_projects.roadmap_signal` & per-currency `decimal.js` rollups (`#4492`)

- Add internal tenant table `crove_projects.roadmap_signal` (using `ludy_projects.roadmap_signal` if `#3971` lands before `#4492`):
  - `org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE`, `id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7()`, `PRIMARY KEY (org_id, id)`.
  - `board_id uuid NOT NULL`, `roadmap_item_id uuid NOT NULL` with composite FK `(org_id, board_id, roadmap_item_id)` referencing `roadmap_item (org_id, board_id, id) ON DELETE CASCADE` (enabled by adding `CONSTRAINT roadmap_item_board_uq UNIQUE (org_id, board_id, id)` on `roadmap_item`) plus FK `(org_id, board_id)` to `roadmap_board (org_id, id) ON DELETE CASCADE`, each backed by a matching btree index.
  - `source_type text NOT NULL CHECK (source_type IN ('crm.deal', 'kernel.conversation', 'meetings.meeting'))` and `source_id uuid NOT NULL`, deduplicated per item via `CONSTRAINT roadmap_signal_item_source_uq UNIQUE (org_id, roadmap_item_id, source_type, source_id)` so re-linking the same Deal/Conversation/Meeting to one item never inflates demand counts or revenue rollups.
  - Internal commercial attribution fields:
    - `account_label text` (`pii`, max 160 chars)
    - `quote_excerpt text` (`pii`, max 1000 chars)
    - `deal_value NUMERIC(18, 2) CHECK (deal_value IS NULL OR deal_value >= 0)`
    - `deal_currency text CHECK (deal_currency IS NULL OR deal_currency ~ '^[A-Z]{3}$')`
    - `CHECK ((deal_value IS NULL) = (deal_currency IS NULL))`
    - `tainted boolean NOT NULL DEFAULT true`
  - **Strict `ludy_tenant` RLS:** `SELECT ludy_kernel.apply_tenant_rls('crove_projects.roadmap_signal');` (installing `tenant_isolation` for `ludy_tenant` plus the `#285` `agent_write_guard` blocking org-chart agents and `member_vy`).
- **Zero public exposure:** `crove_projects.public_roadmap_view` and every `public_roadmap_*` `SECURITY DEFINER` routine MUST NEVER query `roadmap_signal` or expose `account_label`, `deal_value`, `deal_currency`, or `quote_excerpt`. Public boards expose only `vote_count` and public item text as governed by [ADR-0057](0057-projects-public-roadmap-ideas-voting-changelog.md).
- **Per-currency `decimal.js` rollup math:** Rollup queries (`projects.roadmap.signal.rollup`) aggregate `deal_value` via `@ludy/l10n-vn` (`decimal.js` / `money`) strictly **grouped by `deal_currency`**, returning `valueByCurrency: Array<{ currency, totalAmount, signalCount }>` where `totalAmount` is a 2-decimal string (`toFixed(2)`). Different currencies are NEVER added together, and JS `number` floats are NEVER used for money arithmetic.
- **Idea merge safety:** `projects.roadmap.item.merge` transfers `roadmap_signal` rows from `sourceItemId` to `targetItemId` inside the same transaction while deduplicating `(org_id, targetItemId, source_type, source_id)` so merged items keep accurate rollups without double-counting.

### D3. Dedicated pre-task `crove_projects.project_triage_item` with canonical lock order & `project_visibility` RLS (`#4493`)

- Add dedicated table `crove_projects.project_triage_item` (or `ludy_projects.project_triage_item` post-`#3971`):
  - Pre-task intake rows live exclusively in `project_triage_item` and stay completely unconnected to `ludy_kernel.task`, My Tasks (`/o/:slug/my-work`), Kanban WIP counts, Cycles, and Gantt until explicitly accepted.
  - `org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE`, `id uuid NOT NULL DEFAULT ludy_kernel.uuid_v7()`, `PRIMARY KEY (org_id, id)`.
  - `project_id uuid NOT NULL` referencing `crove_projects.project (org_id, id) ON DELETE CASCADE`. Keeping `project_id` non-nullable guarantees every triage item belongs to a concrete project scope and prevents unscoped org-wide triage rows from leaking private meeting or conversation titles.
  - `source_type text NOT NULL CHECK (source_type IN ('roadmap.item', 'kernel.conversation', 'meetings.meeting', 'manual'))`, `source_id uuid`, `CHECK ((source_type = 'manual' AND source_id IS NULL) OR (source_type <> 'manual' AND source_id IS NOT NULL))`.
  - `status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'snoozed', 'accepted', 'merged', 'declined'))`.
  - `priority text NOT NULL DEFAULT 'none' CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none'))`.
  - `title text NOT NULL` (`pii`, 1..300 chars, trimmed), `description text` (`pii`, max 10000 chars), `decline_reason text` (`pii`, max 1000 chars), `tainted boolean NOT NULL DEFAULT true`.
  - `snoozed_until timestamptz`, `accepted_task_id uuid`, `merged_into_task_id uuid`, `triaged_by uuid`, `triaged_at timestamptz`, `created_by uuid`, `created_at timestamptz`, `updated_at timestamptz`.
  - Composite FKs `(org_id, project_id, accepted_task_id)` and `(org_id, project_id, merged_into_task_id)` referencing `crove_projects.project_task (org_id, project_id, task_id) ON DELETE SET NULL (<col>)`, guaranteeing a triage item can only accept or merge into a task inside the same `(org_id, project_id)`.
- **Direct `project_visibility` `RESTRICTIVE` RLS (`#2604` parity):**
  - Install `SELECT ludy_kernel.apply_tenant_rls('crove_projects.project_triage_item');` AND `CREATE POLICY project_visibility ON crove_projects.project_triage_item AS RESTRICTIVE FOR ALL TO ludy_tenant USING ((SELECT crove_projects.actor_bypasses_private_projects()) OR crove_projects.project_visible(org_id, project_id)) WITH CHECK (crove_projects.project_visible(org_id, project_id));`.
  - Verified automatically by `apps/kernel/test/invariant/projects-private.db.test.ts` (structural catalog invariant + non-member `SELECT`/`INSERT`/`UPDATE`/`DELETE` denial + cross-module isolation tests).
- **Atomic `projects.triage.accept` & canonical lock order (`position -> project`):**
  - Lock `project_triage_item` `FOR UPDATE` (`status IN ('pending', 'snoozed')`) and preview `project` without locking (`assertNotArchived`).
  - Invoke internal `kernel.task.create_from_triage` (`packages/kernel/src/agents.ts`) via `ctx.run`, which locks `ludy_kernel.position` FIRST (when `assigneePositionId` is provided) and inserts `ludy_kernel.task` (`tainted: item.tainted`, `sourceRef`).
  - Lock `crove_projects.project` `FOR SHARE` AFTER `kernel.task.create_from_triage` (strictly preserving canonical `position -> project` lock ordering established in `tasks-from-note.ts` and `roadmap.ts`), re-verify project membership for `assigneePositionId`, validate optional `columnId`/`cycleId`, insert `crove_projects.project_task`, and transition `project_triage_item` to `status = 'accepted'` with `accepted_task_id = taskId`.
  - `projects.triage.merge` validates the target `project_task` in the same `(org_id, project_id)` and transitions `project_triage_item` to `status = 'merged'`, `merged_into_task_id = targetTaskId`. `accepted` and `merged` are terminal states (cannot be reopened to duplicate tasks); `snoozed` and `declined` may transition back to `pending` via `projects.triage.reopen`.

### D4. Authenticated oRPC endpoints only & read-only MCP `projects.mcp.triage_summary` (`#4492`, `#4493`)

- **Zero unauthenticated HTTP routes:** All signal and triage mutations/queries are strictly authenticated oRPC handlers in `apps/kernel/src/rpc.ts` (`os.projects.roadmap.*` and `os.projects.triage.*`). `apps/kernel/src/http.ts` adds zero new unauthenticated endpoints (`route-coverage.test.ts` requires no new `PUBLIC` entries).
- **MCP read summary (`ADR-0051`):** Add `projects.mcp.triage_summary` in `modules/projects/src/roadmap-mcp.ts` (`mcp: { scope: 'ludy.read' }`, `access: ['owner', 'admin']`, `requireCompanyGrantor(ctx)` rejecting `member` MCP grants):
  - Returns per-status triage counts (`pending`, `snoozed`, `accepted`, `merged`, `declined`) and bounded recent `pending` / `snoozed` triage items (`id`, `projectId`, `projectName`, `status`, `priority`, `title`, `sourceType`, `tainted`, `sourceTrust`, `createdAt`).
  - Explicitly excludes all `visibility = 'private'` projects (`p.visibility <> 'private'`), omits `decline_reason` and raw conversation/meeting excerpts, scrubs every string through `plainLine(...)`, and marks tainted items clearly (`sourceTrust: 'external' | 'internal'`).

### D5. Vy AI coworkers (`projects.roadmap_signal_match`, `projects.triage_assist`) under `AI_FEATURES` `'projects'` (`#4492`, `#4493`)

- Register both keys in `packages/agent/src/meter.ts` `AI_FEATURES` under module `'projects'`:
  - `'projects.roadmap_signal_match': 'projects'` (`#4492`)
  - `'projects.triage_assist': 'projects'` (`#4493`)
- Both run via `InboxReader` inside `withAiScope` + `metered(...)` outside database write transactions (`tools: []`), fenced with `<<< >>>` delimiters (`fenced(...)`), matching `packages/agent/src/project-roadmap.ts` and `apps/kernel/src/project-roadmap-ai.ts`:
  - **Link & format guards:** Strip/reject invisible format characters (`/\p{Cf}/u`), Markdown/HTML injection in plain fields, and any URL/link via `draftLinksOutside` checked strictly against `!tainted` allowlisted texts.
  - **Deterministic ID membership guards:**
    - `projects.roadmap_signal_match`: validates every suggested `roadmapItemId` against the caller's bounded board item allowlist (refusing fabricated UUIDs or cross-board IDs); optional new-item draft suggestions (`suggestedTitle`, `suggestedSummary`) remain bounded and tainted until human confirmation.
    - `projects.triage_assist`: validates `duplicateTaskId` against visible open tasks of that `project_id`, `suggestedAssigneePositionId` against active `project_member` seats of that `project_id`, `suggestedCycleId` against active/upcoming `project_cycle` rows of that `project_id`, and `recommendedPriority` against the enum allowlist.
  - **Human confirm & 100% AI-off parity:** UI renders suggestions clearly with an `"AI"` proposal badge; nothing writes to `roadmap_signal`, `roadmap_item`, `project_triage_item`, or `ludy_kernel.task` until a human clicks **Confirm**, **Accept**, or **Merge**. With AI off, paused, or out of budget, all signal and triage workflows remain 100% usable.

### D6. PDPL find/erase, offboarding export, cumulative `ludy_kernel.org_purge`, and Step 0 governance (`#4491`, `#4492`, `#4493`)

- **PDPL (`packages/kernel/src/personal-data.ts`):**
  - Slice 1 (`#4492`): register `roadmap_signal.account_label` and `roadmap_signal.quote_excerpt` (`free_text`, `erase`).
  - Slice 2 (`#4493`): register `project_triage_item.title`, `project_triage_item.description`, and `project_triage_item.decline_reason` (`free_text`, `erase`).
- **Offboarding (`packages/kernel/src/offboarding.ts`):** Register `'projects.roadmap_signal'` (Slice 1) and `'projects.project_triage_item'` (Slice 2) in `EXPORT_TABLES`.
- **Cumulative `ludy_kernel.org_purge` (`2027..._ludy_kernel_org_purge_*.sql`, `shared-core`):**
  - Slice 1 (`#4492`) restates the latest `ludy_kernel.org_purge` on `main`, deleting `roadmap_signal` before `roadmap_item` and `roadmap_board` in `v_kernel_first`.
  - Slice 2 (`#4493`) restates the latest `ludy_kernel.org_purge` on `main`, deleting `project_triage_item` before `project_task` and `project` in `v_kernel_first`.
  - Every SQL routine maintains `SET search_path = pg_catalog, pg_temp` (`hardeningViolations`), `REVOKE ALL ... FROM PUBLIC, ludy_tenant, ludy_app, ludy_worker, ludy_definer_tenant`, and `GRANT EXECUTE ... TO ludy_worker`, plus `lock_timeout = '2s'` retry discipline per `AGENTS.md`.
- **Two-step invariant governance (`#4491` -> `#4492` -> `#4493`):**
  - Step 0 (`#4491`) lands on `main` first, registering `roadmap_signal` and `project_triage_item` in `rls-matrix.db.test.ts` `PENDING_TABLES` and `ROW_FACTORIES` (matching the active module schema prefix on `origin/main`: `crove_projects` currently, or `ludy_projects` if `#3971` merges first).
  - `#4492` adds `roadmap_signal` migration and removes `roadmap_signal` from `PENDING_TABLES` (leaving `project_triage_item` pending).
  - `#4493` adds `project_triage_item` migration and removes `project_triage_item` from `PENDING_TABLES`.

## Consequences

- **Good:** SMEs connect real revenue and customer conversations from CRM, Inbox, and Meetings directly into Public Roadmap prioritization with exact per-currency `decimal.js` totals, while keeping sprint boards protected behind a dedicated pre-task Triage Inbox.
- **Good:** Cross-module decoupling (`ctxQueryFn`, zero module imports, zero cross-module DB joins/FKs), `#2604` private-project parity, PDPL find/erase, and AI-off parity preserve every Ludy architectural invariant.
- **Bad / Cost:** Adds 2 new tables, 2 `AI_FEATURES` keys, 1 MCP read query, cumulative `ludy_kernel.org_purge` migrations, and requires Step 0 (`#4491`) plus Platform PO `shared-core` review and Line PO independent security review on `#4492` and `#4493`.
- **Neutral:** Cross-module source links store `(source_type, source_id)` without PostgreSQL FKs; if a linked CRM deal, conversation, or meeting is deleted or restricted for a viewer later, signal metadata remains readable in `roadmap_signal` until unlinked/redacted while live drill-down respects caller RLS.

## Alternatives considered

1. **Importing `@ludy/mod-crm` and `@ludy/mod-meetings` or joining `crove_crm.deal` in SQL inside `modules/projects`:** Rejected. Violates `depcruise` and `packages/db/test/invariant/conformance.db.test.ts` (`cross-module`), breaks modular deployment when CRM or Meetings is switched off (`ADR-0031`), and risks bypassing caller RLS.
2. **Converting CRM/Conversation/Meeting values into a single base currency or summing in JS numbers:** Rejected. Violates `AGENTS.md` money rules (`decimal.js` + `NUMERIC`), introduces FX rate ambiguity not needed by SMEs, and risks float precision bugs.
3. **Storing Triage items inside `ludy_kernel.task` with a `status = 'triage'` column:** Rejected. Pollutes My Tasks, team boards, agent task queries, and WIP/cycle metrics, and requires altering core `ludy_kernel.task` status enums across the entire monorepo.
4. **Allowing `project_triage_item.project_id` to be nullable:** Rejected. Unscoped triage rows created from private conversations or meetings could be read org-wide via `project_id IS NULL` bypasses in `project_visibility` RLS.
5. **Adding unauthenticated webhook/HTTP routes or auto-accepting AI triage proposals:** Rejected. Unnecessary attack surface (`apps/kernel/src/http.ts`) and violates `scope.md` human-approval and AI-off gates.

## Revisit when

- `#3971` (module SQL schema rename `crove_*` -> `ludy_*`) lands on `main`, after which `#4491`, `#4492`, and `#4493` use `ludy_projects.*` identifiers per [ADR-0054](0054-rebrand-internal-crove-identifiers-to-ludy.md).
- SME pilot partners request multi-workspace triage routing rules or automatic CRM stage triggers (evaluate against [scope.md](../product/scope.md) before leaving Icebox).
