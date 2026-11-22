# 0056. Projects v2: opt-in cycles and points, custom columns mapped to task status, isolated task dependencies, private projects, timeline, and lean time tracking

- Status: **Accepted** (owner decision 2026-11-22 in `Projects & Notes Product Owner` session, decisions `A1`, `A2`, `A3`, logged in [#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7072041736)).
- Date: 2026-11-22
- Deciders: owner (JOY) for scope, wave ordering (`A1`), `crove_kernel.task` restrictive RLS invariant amendment (`A2`), and pilot enablement sequence (`A3`); technical design by the `Projects & Notes` PO sub-session for [#4359](https://github.com/DOS/Ludy/issues/4359).
- Builds on: [ADR-0048](0048-projects-on-kernel-tasks.md) (Projects on kernel tasks), [ADR-0029](0029-agents-positions-and-org-chart.md) (agents, seats, task leases, `parent_task_id` delegation chain), [ADR-0031](0031-module-enablement.md) (module enablement), [ADR-0037](0037-private-notes-and-todos.md) (private notes and to-dos), [ADR-0049](0049-member-scoped-vy.md) (member-scoped Vy), [ADR-0054](0054-rebrand-internal-crove-identifiers-to-ludy.md) (`@ludy/*` and planned SQL identifier rebrand), and [scope.md](../product/scope.md).
- Amends: [ADR-0048](0048-projects-on-kernel-tasks.md) decisions `D-2` (org-wide visibility only -> adds opt-in `private` projects via `RESTRICTIVE` `private_project_scope` on `crove_kernel.task`) and `D-4` (status columns only -> adds opt-in per-project columns mapped to canonical `crove_kernel.task.status`), and updates [projects.md](../plan/projects.md) sections 7 and 8.
- Plan: [projects-v2.md](../plan/projects-v2.md) (Vietnamese owner summary: [projects-v2.vi.md](../plan/projects-v2.vi.md)).
- Issues: [#4359](https://github.com/DOS/Ludy/issues/4359) (plan & ADR), [#4360](https://github.com/DOS/Ludy/issues/4360) (Step 0 invariants), Wave 1 ([#4361](https://github.com/DOS/Ludy/issues/4361), [#2605](https://github.com/DOS/Ludy/issues/2605), [#2601](https://github.com/DOS/Ludy/issues/2601), [#2604](https://github.com/DOS/Ludy/issues/2604)), Wave 2 ([#2599](https://github.com/DOS/Ludy/issues/2599), [#2600](https://github.com/DOS/Ludy/issues/2600)).

## Context and problem statement

Projects v1 ([ADR-0048](0048-projects-on-kernel-tasks.md), [projects.md](../plan/projects.md)) intentionally launched lean: every project is readable by the whole org (`D-2`), board columns are fixed to `crove_kernel.task.status` (`D-4`), tasks have no dependency graph (`#2601`), no sprints/cycles or story points exist, and timeline (`#2599`) plus time tracking (`#2600`) stayed in the Icebox. Since v1 and five follow-up enhancements (`#2606` to `#2610`) shipped to `main`, SME teams evaluating Ludy Teamwork against Linear, Plane, and Jira need six concrete capabilities:

1. Private projects (`#2604`) for hiring, disputes, executive plans, or client-specific work without exposing tasks or comments to the entire org.
2. Custom board columns per project (`#2605`) without breaking org-chart agents or shared kernel task status filters.
3. Opt-in Sprints / Cycles and Story points (`#4361`) without cluttering default solo-founder projects.
4. Task dependencies (`#2601`) without colliding with `crove_kernel.task.parent_task_id`.
5. A week/month Gantt / Timeline view (`#2599`) built on dependencies and schedule dates.
6. Lean time tracking and billable hours (`#2600`) without pulling Accounting invoicing or payroll complexity into Projects.

## Decision drivers

- **Zero-setup solo defaults:** Creating a default project requires zero configuration (`visibility = 'org'`, `cycles_enabled = false`, `points_enabled = false`, `0` `project_column` rows rendering the 5 canonical status columns).
- **Preserve ADR-0029 and module isolation:** `crove_kernel.task` keeps its seat model, `le_scope`, lease/fencing tokens, `parent_task_id` delegation/escalation semantics, and the `#285` agent write guard on `crove_projects.*`.
- **Fail-closed tenancy and recursion-free RLS:** Private project checks must never cause RLS recursion across `project` / `project_member` / `project_task` / `crove_kernel.task`, and must pass `Invariant suite (from base)` cleanly via the two-step invariant process.
- **Deterministic logic before AI:** Velocity, burndown, WIP counts, bottleneck counts, critical paths, and billable amounts (`decimal.js` via `@ludy/l10n-vn`) are computed strictly in code; Vy only summarizes grounded facts via `metered(...)` + `summaryNumbersOutside` ([#1237](https://github.com/DOS/Ludy/issues/1237)) and never acts without human confirmation.

## Decision

### 1. Amend ADR-0048 D-2: `private` projects via `RESTRICTIVE` RLS and recursion-free `SECURITY DEFINER` helpers (`#2604`, Owner Decision A2)

- `crove_projects.project` adds `visibility text NOT NULL DEFAULT 'org' CHECK (visibility IN ('org', 'private'))`. Existing projects and default creates stay `'org'`.
- Visibility is enforced in PostgreSQL (not just UI/RPC checks) through recursion-free `STABLE SECURITY DEFINER` helpers owned by the migration runner role with `SET search_path = pg_catalog, pg_temp`, `REVOKE ALL ... FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant`, and `GRANT EXECUTE ... TO crove_tenant`:
  - `crove_projects.project_visible(p_org_id uuid, p_project_id uuid)`: fail-closed on `p_org_id = crove_kernel.ctx_org_id()`; returns `true` for `'org'` projects and `ctx_actor_type() = 'system'`; for `'private'` projects, resolves `v_uid := COALESCE(crove_kernel.ctx_user_id(), crove_kernel.ctx_acting_user_id(), crove_kernel.ctx_mcp_member_id())` and checks `v_uid = project.owner_user_id`, membership in `crove_projects.project_member`, or org role `owner`/`admin` in `crove_kernel.tenant_member`. Unassigned org-chart agents and non-member company MCP contexts resolve `v_uid IS NULL` and receive `false`.
  - `crove_projects.project_row_visible(p_org_id uuid, p_id uuid, p_visibility text, p_owner_user_id uuid)`: evaluates `crove_projects.project` RLS directly from the row's columns so `INSERT ... WITH CHECK` on a brand-new `'private'` project succeeds within the same statement snapshot without querying `crove_projects.project` recursively.
  - `crove_projects.task_visible(p_org_id uuid, p_task_id uuid, p_assignee_position_id uuid)`: returns `true` for `ctx_actor_type() = 'system'`, unlinked tasks, or `'org'` project tasks; for tasks linked to a `'private'` project, delegates to `project_visible` OR allows an assigned org-chart agent operating strictly on its own seat (`ctx_actor_type() = 'agent' AND ctx_acting_user_id() IS NULL AND ctx_mcp_member_id() IS NULL AND ctx_position_id() IS NOT NULL AND p_assignee_position_id = crove_kernel.ctx_position_id()`).
- **Policies installed:**
  - `project_visibility AS RESTRICTIVE FOR ALL TO crove_tenant` on `crove_projects.project`, `project_member`, `project_task`, and **every other `crove_projects.*` table** (`project_cycle`, `project_column`, `task_dependency`, `time_entry`). In particular, `WITH CHECK` on `project_task` prevents non-members from attaching an existing org task into a private project.
  - `private_project_scope AS RESTRICTIVE FOR ALL TO crove_tenant` on `crove_kernel.task` (`USING` and `WITH CHECK` via `crove_projects.task_visible(org_id, id, assignee_position_id)`). Existing `task_scope` on `crove_kernel.task_comment` and RLS-checked target lookups in `crove_notes.link` (`notes.record.panel`) naturally inherit this restriction.
- **ADR-0031 module toggle compatibility:** Even when `projects` is switched off at runtime for an org (`CROVE_MODULES` / per-org enablement), `crove_projects.task_visible` remains present in the database and returns `true` whenever a task has no `private` project row, leaving all non-project kernel task flows unaffected.
- **Two-step invariant & shared-core gate:**
  - Because `apps/kernel/test/invariant/rls-matrix.db.test.ts` seeds `crove_projects.project` with default `visibility = 'org'`, `Invariant suite (from base)` passes cleanly without relaxing any baseline invariant.
  - Modifying `crove_kernel.task` RLS requires `shared-core` Platform PO review ([docs/product-owner-config.md](../product-owner-config.md#shared-core-review)), `-- migration-lint: cross-module` waiver comments in the migration per `tools/ci/migration-lint.mjs`, and dedicated invariant tests in `apps/kernel/test/invariant/projects-private.db.test.ts` (including a catalog check asserting that every `crove_projects.*` table with `project_id` enforces `RESTRICTIVE` `project_visibility`).
  - Owner `org_export` (`packages/kernel/src/offboarding.ts`) continues exporting `crove_projects.*` and `crove_kernel.task` because org `owner` already has read access to all `private` projects in their org (unlike author-private `crove_notes.note` or attendees-only `crove_meetings.meeting`).

### 2. Amend ADR-0048 D-4: opt-in custom columns mapped to `crove_kernel.task.status` (`#2605`)

- A project with `0` rows in `crove_projects.project_column` renders the 5 canonical status columns (`todo`, `in_progress`, `waiting`, `in_review`, `done`; `cancelled` behind filter) with zero setup.
- Opting in (`projects.column.init_defaults`) materializes editable columns (`1..12` max, semantic `@ludy/ui` color token compliant with `tools/ui-colors.mjs`, optional `wip_limit BETWEEN 1 AND 200`, `sort_key COLLATE "C"`), preserving at least one column mapped to `'todo'` and one mapped to `'done'`.
- `crove_projects.project_task` adds nullable `column_id uuid` with composite FK `(org_id, project_id, column_id) -> crove_projects.project_column (org_id, project_id, id) ON DELETE SET NULL (column_id)` and supporting partial btree index.
- Moving a card (`projects.task.move_column`) atomically sets `project_task.column_id` and updates `crove_kernel.task.status = column.task_status` inside one `Runtime.execute()` transaction (keeping lease checks). If an org-chart agent updates `crove_kernel.task.status` directly, board queries use `column_id` when its mapped `task_status` matches `task.status`, else fall back deterministically to the first column (by `sort_key, id`) mapped to `task.status`.

### 3. Preserve `parent_task_id` for agent chains; isolate dependencies in `crove_projects.task_dependency` (`#2601`)

- `crove_kernel.task.parent_task_id` and `request_depth` stay strictly untouched and reserved for org-chart agent delegation and escalation ([ADR-0029](0029-agents-positions-and-org-chart.md), `agents.db.test.ts`). Reusing `parent_task_id` for project dependencies would conflate hierarchical agent escalation/legal-entity inheritance triggers with multi-parent project DAG blocking relationships.
- `crove_projects.project_task` adds `UNIQUE (org_id, project_id, task_id)`, and `crove_projects.task_dependency` holds intra-project DAG edges with `CHECK (blocker_task_id <> blocked_task_id)`, `UNIQUE (org_id, blocker_task_id, blocked_task_id)`, composite `ON DELETE CASCADE` FKs to `project` and `project_task`, and supporting indexes on all FKs.
- `projects.dependency.add` locks `crove_projects.project ... FOR UPDATE`, enforces `<= 500` edges per project and `<= 20` edges per task, and rejects cycles via recursive CTE/BFS (`DEPENDENCY_CYCLE`).

### 4. Opt-in Sprints / Cycles and Story points (`#4361`)

- `crove_projects.project` adds `cycles_enabled boolean NOT NULL DEFAULT false`, `cycle_duration_weeks smallint NOT NULL DEFAULT 2 CHECK (cycle_duration_weeks BETWEEN 1 AND 4)`, and `points_enabled boolean NOT NULL DEFAULT false`.
- `crove_projects.project_cycle` enforces at most one `'active'` cycle per `(org_id, project_id)` via a partial unique index and links to `project_task.cycle_id` (`ON DELETE SET NULL (cycle_id)`) plus `story_points smallint CHECK (story_points IS NULL OR story_points BETWEEN 0 AND 100)`.
- Org-chart agents never create, start, complete, or assign cycles/points. Completing an active cycle (`projects.cycle.complete`) requires an explicit human carryover decision (backlog `NULL` or an `upcoming` target cycle) for unfinished tasks.
- Velocity, burndown, and completion % are computed deterministically in code. Vy (`projects.cycle_summary` under `AI_FEATURES`) writes grounded Vietnamese narratives only, validated by `summaryNumbersOutside` and never reading private notes.

### 5. Timeline (`#2599`) and lean time tracking without Accounting auto-invoicing (`#2600`)

- **Timeline (`#2599`):** Adds `start_on date` on `crove_projects.project_task` (paired with existing `crove_kernel.task.due timestamptz` via atomic `projects.task.set_dates`) rather than duplicating `due` on `project_task`. Deterministically flags dependency date violations (`#2601`) and provides accessible keyboard/table fallbacks alongside draggable bars.
- **Lean time tracking (`#2600`):** Adds `crove_projects.time_entry` (`user_id` nullable `ON DELETE SET NULL` to retain historical logged hours on member offboarding, partial unique index `WHERE ended_at IS NULL AND user_id IS NOT NULL` enforcing at most one running timer per user per org, `hourly_rate NUMERIC(18, 2)` computed strictly via `decimal.js` / `@ludy/l10n-vn`, and CSV export).
- **Why `#2600` excludes automatic Accounting invoicing and HR payroll sync:** Automatic invoice generation (`crove_finance`) and payroll integration (`crove_hr`) introduce VAT tax rates, e-invoice numbering, multi-line invoice grouping, approval proposals, and double-billing idempotency locks (`ADR-0021`, `ADR-0044`, `ADR-0046`) that violate [scope.md](../product/scope.md) "smallest useful slice" for SMEs. Lean time tracking + deterministic billable summaries + CSV export deliver immediate weekly value cleanly without coupling `modules/projects` to `modules/finance` or `modules/hr`.

### 6. Two-step invariant registration (`#4360`)

- Step 0 (`#4360`) registers `crove_projects.project_column`, `crove_projects.project_cycle`, `crove_projects.task_dependency`, and `crove_projects.time_entry` in `PENDING_TABLES` with working `ROW_FACTORIES` in `apps/kernel/test/invariant/rls-matrix.db.test.ts` before any Wave 1 or Wave 2 migration merges, allowing Wave 1/Wave 2 slices to develop cleanly without failing `Invariant suite (from base)`.

## Consequences

- **Good:** Solo founders keep zero-setup simplicity (`visibility = 'org'`, `cycles_enabled = false`, `points_enabled = false`, 5 default columns, no required timeline/timers) while growing teams gain Linear/Plane/Jira workflows.
- **Good:** `crove_kernel.task` schema columns, delegation triggers, and `agents.db.test.ts` invariants stay untouched; private projects enforce strict DB-level isolation across tasks, comments, notes panels, and member-scoped Vy.
- **Bad / Cost:** Four new tenant tables plus `private_project_scope` on `crove_kernel.task` require Step 0 (`#4360`), `org_purge`, `offboarding.ts`, `personal-data.ts`, `manifest.ts`, `db:types`, and `shared-core` Platform PO review on `#2604` (and `org_purge` slices).
- **Neutral:** Cross-slice merge ordering between `#2604` and other Wave 1/Wave 2 PRs requires checking all `crove_projects.*` tables on `main` for `project_visibility` policy parity, enforced automatically by `projects-private.db.test.ts`.

## Alternatives considered

1. **Application-layer filtering only for private projects (`#2604`):** Rejected. Any direct query (`kernel.task.list`, `projects.today`, `notes.record.panel`, `member_vy`, MCP reads) would bypass app checks and leak private task titles/comments. PostgreSQL `RESTRICTIVE` RLS + `SECURITY DEFINER` helpers guarantee defense in depth.
2. **Adding `project_id` or `visibility` columns onto `crove_kernel.task`:** Rejected. Keeping `project_task` as the join table preserves clean module boundaries and lets `crove_projects.task_visible` inspect project privacy without widening `crove_kernel.task` write allowlists for agents.
3. **Reusing `crove_kernel.task.parent_task_id` for `#2601` dependencies:** Rejected. `parent_task_id` supports single-parent agent delegation/escalation trees (`request_depth <= 5`) and legal-entity propagation triggers; dependencies are many-to-many intra-project DAG links.
4. **Replacing `task.status` completely with arbitrary custom columns (`#2605`):** Rejected. Org-chart agents, `My work`, `Home` nudges, and task filters all depend on the canonical 5+1 statuses in `crove_kernel.task.status`.
5. **Coupling `#2600` directly to Accounting draft invoices / HR timesheets:** Rejected for M3 (`A1`). Deferred until pilot users request automated invoice generation.

## Revisit when

- Pilot SME customers request resource capacity planning across projects ([#2602](https://github.com/DOS/Ludy/issues/2602), Icebox) or external client guest portals ([#2603](https://github.com/DOS/Ludy/issues/2603), Icebox), each requiring its own owner decision and (for `#2603`) an external-auth security ADR.
- Accounting and Projects users request 1-click conversion from `projects.time.summary` billable hours into a `finance` sales order / e-invoice draft (requires joint design with `line:accounting`).
- `ADR-0054` SQL schema rename (`crove_projects` -> `ludy_projects`, `crove_kernel` -> `ludy_kernel`) lands via `#3970` / `#3971`, at which point any pending v2 migrations use `ludy_*` identifiers.
