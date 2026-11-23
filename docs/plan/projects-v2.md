# Projects v2: sprints/cycles, story points, custom columns, dependencies, private projects, timeline, and lean time tracking

> Plan for Projects v2 (`modules/projects`, schema `crove_projects`, milestone `M3 Paid pilot`, line `line:projects`), 2026-11-22. Builds on [projects.md](projects.md), [ADR-0048](../adr/0048-projects-on-kernel-tasks.md), [ADR-0029](../adr/0029-agents-positions-and-org-chart.md), [ADR-0031](../adr/0031-module-enablement.md), [ADR-0037](../adr/0037-private-notes-and-todos.md), [ADR-0049](../adr/0049-member-scoped-vy.md), and the OPC/SME scope gate in [scope.md](../product/scope.md). Owner JOY approved decisions `A1`, `A2`, and `A3` on 2026-11-22 in the `Projects & Notes Product Owner` session ([#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7072041736)). The governing decision record is [ADR-0056](../adr/0056-projects-v2-cycles-columns-dependencies-privacy.md) (`Accepted`); the Vietnamese summary for the owner is [projects-v2.vi.md](projects-v2.vi.md). Plan tracking issue: [#4359](https://github.com/DOS/Ludy/issues/4359); Step 0 invariant baseline: [#4360](https://github.com/DOS/Ludy/issues/4360).

## 1. Goal, OPC/SME fit, and v1 baseline

### 1.1 Where Projects stands on `main`

Projects v1 from [projects.md](projects.md) and five originally-deferred items have already landed on `main`:

- **Core v1 (`P0` to `P7`, [#2586](https://github.com/DOS/Ludy/issues/2586) to [#2598](https://github.com/DOS/Ludy/issues/2598)):** `crove_projects.project`, `project_member`, `project_task`, `kernel.task.update`, Kanban board and list on `/o/:slug/projects/:id`, My work / Tasks integration, `crove_notes.link` (`kernel.task` and `projects.project`), deterministic Home nudges (`projects.today`), Vy weekly status (`projects.weekly_status`), and member-scoped Vy task proposals from a note (`projects.tasks_from_note`).
- **Already shipped from the initial Icebox:** checklists on kernel tasks ([#2606](https://github.com/DOS/Ludy/issues/2606)), recurring project tasks and project templates ([#2607](https://github.com/DOS/Ludy/issues/2607)), tasks proposed from meetings and customer conversations (`projects.tasks_from_source`, [#2608](https://github.com/DOS/Ludy/issues/2608)), weekly status mail/note sharing ([#2609](https://github.com/DOS/Ludy/issues/2609)), and manual card ordering (`project_task.sort_key`) plus task saved views ([#2610](https://github.com/DOS/Ludy/issues/2610)).

### 1.2 Scope gate ([scope.md](../product/scope.md))

Projects v2 upgrades Ludy's Teamwork app to match Linear, Plane, and Jira for growing Vietnamese SMEs without adding setup overhead for solo founders:

1. **Fit (gate 1):** Small teams running weekly/biweekly delivery cadences, multi-stage workflows, blocking dependencies, confidential projects (hiring, partner contracts, internal audits), project timelines, and simple client-billable time tracking do this work weekly or monthly.
2. **Smallest useful slice / zero-setup default (gate 2):** Every v2 capability is opt-in or additive. A solo founder or small team creating a default project gets zero extra setup: `visibility = 'org'`, `cycles_enabled = false`, `points_enabled = false`, `0` rows in `project_column` (rendering the 5 canonical status columns), no required dates, and no timer clutter.
3. **AI part named (gate 3):** Vy (`gm`) leads across apps (`projects` gets no separate coworker). Code deterministically computes all cycle metrics (velocity, burndown, carryover candidates), WIP counts, blocker bottleneck counts, schedule conflicts, and billable hour/money totals (`decimal.js` via `@ludy/l10n-vn`). Vy writes plain-Vietnamese narrative summaries (`projects.cycle_summary` and extended `projects.weekly_status`) strictly from code-computed facts through `metered(...)` under `AI_FEATURES`, validated by `summaryNumbersOutside` ([#1237](https://github.com/DOS/Ludy/issues/1237)). With AI off or out of budget, 100% of Wave 1 and Wave 2 features work identically.
4. **Security & tenancy (gate 5):** Tenancy, `apply_tenant_rls`, `crove_kernel.task` `le_scope` and lease rules ([ADR-0029](../adr/0029-agents-positions-and-org-chart.md)), and the `#285` agent write guard stay intact. Private projects (`#2604`) add a fail-closed `RESTRICTIVE` RLS policy (`private_project_scope`) on `crove_kernel.task` approved by owner decision `A2` via the two-step invariant gate.
5. **Explicitly out of scope (kept in Icebox):** [#2602](https://github.com/DOS/Ludy/issues/2602) (Resource planning and cross-project capacity workload, large-org management) and [#2603](https://github.com/DOS/Ludy/issues/2603) (External client portals, external auth/sharing). Also explicitly excluded from `#2600`: automatic Accounting invoice generation and HR payroll sync.

## 2. Owner decisions (2026-11-22) and wave roadmap

Owner JOY confirmed three decisions on `2026-11-22T08:06+07:00` ([#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7072041736)):

| ID | Topic | Decision (JOY, 2026-11-22) | Impact |
| --- | --- | --- | --- |
| `A1` | Scope & wave order | Reopen prioritized `line:projects` backlog (`M3 Paid pilot`) in two waves; keep `#2602` and `#2603` in Icebox | **Wave 1 (`priority:P1`):** Sprints/Cycles & Story points ([#4361](https://github.com/DOS/Ludy/issues/4361)), Custom columns ([#2605](https://github.com/DOS/Ludy/issues/2605)), Task dependencies ([#2601](https://github.com/DOS/Ludy/issues/2601)), Private projects ([#2604](https://github.com/DOS/Ludy/issues/2604)). **Wave 2 (`priority:P2`):** Gantt/Timeline ([#2599](https://github.com/DOS/Ludy/issues/2599), after `#2601`), Lean Time tracking ([#2600](https://github.com/DOS/Ludy/issues/2600), no automatic Accounting invoicing). |
| `A2` | Private projects & `crove_kernel.task` invariant | Approved amending [ADR-0048](../adr/0048-projects-on-kernel-tasks.md) D-2 and adding `RESTRICTIVE` policy `private_project_scope` on `crove_kernel.task` via two-step invariant process | Tasks inside a `visibility = 'private'` project are visible only to invited `project_member`s, `project.owner_user_id`, org `owner`/`admin`, assigned org-chart agents (on their own seat), and `system`. |
| `A3` | Pilot enablement of Projects v1 + Notes v2 | Immediately after PR `#4320` (`#3564`) merges and `main` CI passes, present concrete `docs/runbooks/pilot-enable-projects-notes.md` steps for one-time approval (`v0.3.6`) | Ships Projects v1 and full Notes v2 to pilot (`DEPLOY_CROVE_MODULES=finance,crm,social,sign,projects,notes`) in parallel with v2 development. |

> **Identifier note ([ADR-0054](../adr/0054-rebrand-internal-crove-identifiers-to-ludy.md)):** Workspace packages already use `@ludy/*` (`#3965`), while PostgreSQL schemas and roles on `main` currently use `crove_projects`, `crove_kernel`, and `crove_tenant` pending `#3969` to `#3971`. If the SQL rebrand merges before a slice below, that slice uses the corresponding `ludy_*` schema/role identifiers with identical structure.

## 3. Step 0 invariant baseline (`#4360`) and cross-cutting rules

### 3.1 Step 0 (`#4360`): `PENDING_TABLES` and row factories

Per [AGENTS.md](../../AGENTS.md) and [invariant-suite.md](../security/invariant-suite.md), `.github/workflows/protected.yml` runs `origin/main`'s `apps/kernel/test/invariant/rls-matrix.db.test.ts` on every PR that touches a protected path (including `supabase/migrations/`). Therefore [#4360](https://github.com/DOS/Ludy/issues/4360) lands on `main` before any Wave 1 or Wave 2 migration PR and registers all four new `crove_projects` tables in `PENDING_TABLES` (strictly sorted, one per line) with full `ROW_FACTORIES`:

1. `crove_projects.project_column`: `setup` inserts a `crove_projects.project`; `row` sets valid `name`, `task_status` (`'todo'`), `color` (`'neutral'`), `sort_key` (`'a0'`).
2. `crove_projects.project_cycle`: `setup` inserts a `crove_projects.project`; `row` sets `number: 1`, `name`, `status: 'upcoming'`, `starts_on`, `ends_on`.
3. `crove_projects.task_dependency`: `setup` inserts a `crove_projects.project`, two distinct `crove_kernel.task` rows, and two `crove_projects.project_task` links for those tasks in that project; `row` links `blocker_task_id` to `blocked_task_id`.
4. `crove_projects.time_entry`: `setup` inserts a `crove_projects.project`, a `crove_kernel.task`, and a `crove_projects.project_task`; `row` sets `user_id: o.owner`, `started_at`, `ended_at` (non-null so repeated factory rows never collide on the single-active-timer partial unique index), `duration_minutes: 30`, `billable: true`, `hourly_rate: '250000.00'`.

When each feature PR lands its migration, it removes its table from `PENDING_TABLES` in the same PR.

### 3.2 Mandatory cross-cutting conventions for every v2 table and migration

Every slice in Wave 1 and Wave 2 satisfies all repository DB, runtime, and lifecycle invariants:

- **Schema & conformance (`packages/db/test/invariant/conformance.db.test.ts`):**
  - `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`, `PRIMARY KEY (org_id, id)`.
  - Every tenant FK leads with `org_id` on both sides (`fk-shape`), points only within `crove_projects` or to `crove_kernel` (`cross-module`), and has a valid supporting btree index on its exact distinct columns (`fk-index`; nullable FKs may use `WHERE <col> IS NOT NULL`).
  - All timestamps are `timestamptz` (or `date`), never `timestamp without time zone`. All money columns (`hourly_rate`) are `NUMERIC(18, 2)`.
- **RLS & agent write guard:**
  - `SELECT crove_kernel.apply_tenant_rls('crove_projects.<table>');` installs `tenant_isolation` and the `#285` `agent_write_guard` trigger. Org-chart agents and `member_vy` remain blocked from writing any `crove_projects.*` table.
  - **Private project parity (`#2604`):** Any slice landing after `#2604` MUST install the `RESTRICTIVE` `project_visibility` policy on its new `crove_projects.*` tables. Conversely, `#2604` installs `project_visibility` on all `crove_projects.*` tables already on `main` and pins that invariant via a catalog test in `apps/kernel/test/invariant/projects-private.db.test.ts`.
- **One write path & auditing:** Every mutation runs through `Runtime.execute()` (`@ludy/kernel-runtime`), writes an audit row masking `pii` text with `auditValue(...)`, and emits outbox events carrying IDs only.
- **Offboarding, org purge, and PDPL:** Each slice updates `crove_kernel.org_purge` (child tables listed in `v_kernel_first` before `crove_projects.project_task` and `crove_projects.project`, which precede `crove_kernel.task`), `packages/kernel/src/offboarding.ts` (`EXPORT_TABLES`), `packages/kernel/src/personal-data.ts` (`pii` registry, scan, and redaction/erasure), `modules/projects/src/manifest.ts`, and `packages/db/src/generated/database.ts` (`pnpm db:types`).
- **UI/UX & accessibility:** Use `@ludy/ui` semantic tokens only (`tools/ui-colors.mjs`), `>= 44 px` touch targets on mobile interactive controls, keyboard equivalents for every drag/drop or visual timeline interaction, and `aria-live="off"` on any passive elapsed timer display.

## 4. Wave 1 specifications (`priority:P1`, `M3 Paid pilot`)

### 4.1 Sprints / Cycles & Story Points (`#4361`)

**Goal:** Let SME teams opt into 1 to 4 week delivery cycles (sprints) and 0 to 100 story-point sizing per project, with deterministic burndown/velocity and explicit human carryover on cycle completion.

#### Database schema (`<ts>_crove_projects_cycles.sql`)

1. **`crove_projects.project` extensions:**
   - `cycles_enabled boolean NOT NULL DEFAULT false`
   - `cycle_duration_weeks smallint NOT NULL DEFAULT 2 CHECK (cycle_duration_weeks BETWEEN 1 AND 4)`
   - `points_enabled boolean NOT NULL DEFAULT false`
2. **New table `crove_projects.project_cycle`:**
   - `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`
   - `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`
   - `project_id uuid NOT NULL`
   - `number integer NOT NULL CHECK (number >= 1)`
   - `name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 120 AND name = pg_catalog.btrim(name))` (`pii`)
   - `goal text CHECK (goal IS NULL OR pg_catalog.length(goal) <= 1000)` (`pii`)
   - `status text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'active', 'completed'))`
   - `starts_on date NOT NULL`
   - `ends_on date NOT NULL CHECK (ends_on >= starts_on)`
   - `started_at timestamptz`
   - `completed_at timestamptz`
   - `created_by uuid`
   - `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
   - `updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
   - Keys & constraints: `PRIMARY KEY (org_id, id)`, `CONSTRAINT project_cycle_project_fk FOREIGN KEY (org_id, project_id) REFERENCES crove_projects.project (org_id, id) ON DELETE CASCADE`, `CONSTRAINT project_cycle_project_id_uq UNIQUE (org_id, project_id, id)`, `CONSTRAINT project_cycle_number_uq UNIQUE (org_id, project_id, number)`.
   - Indexes & RLS: `CREATE INDEX IF NOT EXISTS project_cycle_project_idx ON crove_projects.project_cycle (org_id, project_id, starts_on DESC, number DESC);`, `CREATE UNIQUE INDEX IF NOT EXISTS project_cycle_active_uq ON crove_projects.project_cycle (org_id, project_id) WHERE status = 'active';`, `SELECT crove_kernel.apply_tenant_rls('crove_projects.project_cycle');` (plus `project_visibility` policy if `#2604` is on `main`).
3. **`crove_projects.project_task` extensions:**
   - `cycle_id uuid`
   - `story_points smallint CHECK (story_points IS NULL OR story_points BETWEEN 0 AND 100)`
   - `CONSTRAINT project_task_cycle_fk FOREIGN KEY (org_id, project_id, cycle_id) REFERENCES crove_projects.project_cycle (org_id, project_id, id) ON DELETE SET NULL (cycle_id)`
   - `CREATE INDEX IF NOT EXISTS project_task_cycle_idx ON crove_projects.project_task (org_id, project_id, cycle_id) WHERE cycle_id IS NOT NULL;`

#### Commands and queries (`modules/projects`, `packages/kernel-contract`)

All commands require `userOf(ctx.actor)` (org-chart agents cannot mutate cycles or points) and reject archived projects:

- **`projects.project.update`:** extended with optional `cyclesEnabled`, `cycleDurationWeeks`, `pointsEnabled` (project owner, org `owner`/`admin`). Disabling `cyclesEnabled` hides cycle UI without deleting historical cycle data.
- **`projects.cycle.create` / `projects.cycle.update` / `projects.cycle.delete`:** project owner or org `owner`/`admin`. `create` auto-increments `number` (`MAX(number) + 1`) under `FOR UPDATE` lock on `project` and defaults `endsOn` from `startsOn + cycle_duration_weeks * 7 - 1` days. `delete` is permitted for `upcoming` cycles only (`CYCLE_NOT_UPCOMING` otherwise; `ON DELETE SET NULL (cycle_id)` returns any tasks to backlog).
- **`projects.cycle.start`:** project owner or org `owner`/`admin`. Transitions an `upcoming` cycle to `active`, sets `started_at = ctx.now`, and fails with `409 ACTIVE_CYCLE_EXISTS` if another `active` cycle already exists in the project.
- **`projects.cycle.complete`:** project owner or org `owner`/`admin`. Marks the `active` cycle `completed`, sets `completed_at = ctx.now`, and requires an explicit human `carryover` mode (`'backlog'` to set `cycle_id = NULL` on unfinished tasks where `task.status NOT IN ('done', 'cancelled')`, or `'cycle'` with `targetCycleId` referencing an `upcoming` cycle of the same project and org to move unfinished tasks atomically in the same transaction).
- **`projects.task.set_cycle` / `projects.task.set_points`:** any project writer (`owner`, `admin`, `member`). Validates `cycleId` belongs to the same `(org_id, project_id)` and is not `'completed'` when assigning (`null` moves to backlog); validates `storyPoints` is `null` or integer `0..100`.
- **`projects.cycle.list` & `projects.cycle.metrics` (queries):** read-only (`READERS`). `list` returns cycles with deterministic task count, done task count, total points, and completed points per cycle. `metrics` computes:
  - **Velocity:** completed tasks and completed story points (when `points_enabled`) across the last 12 `completed` cycles in chronological order, plus rolling average.
  - **Active/selected cycle burndown:** daily remaining tasks and remaining story points across `[starts_on..ends_on]` computed strictly in code from `created_at`, `updated_at`, `status` (plus ideal linear guideline from total committed scope).
  - **Scope completion %:** integer/decimal percentage computed in code (`0` when scope is `0`).

#### UI/UX, mobile, and Vy AI part

- **Board & List:** When `cycles_enabled` is `false` and `points_enabled` is `false`, zero cycle/point controls render. When enabled, the project screen shows a Cycle switcher (`Active cycle`, `Backlog`, `Upcoming`, `All`), a concise Cycle progress bar + Velocity/Burndown panel (with accessible tabular fallback for screen readers and `< 768 px` viewports), and story-point chips/inline editors (`>= 44 px` controls).
- **Vy (`projects.cycle_summary`):** Registered in `AI_FEATURES` (`'projects'`) in `packages/agent/src/meter.ts`. Reads only deterministic counts/metrics from `projects.cycle.metrics` and bounded visible task titles/comments (never private notes). Produces 3 to 5 plain-Vietnamese sentences highlighting progress, velocity vs average, and stalled/carryover candidates, strictly validated with `summaryNumbersOutside` (refused if any ungrounded number appears). Shown transiently with an `"AI"` badge; human still confirms any carryover on `projects.cycle.complete`. With AI off or out of budget, all cycle boards, burndown, velocity, and carryover dialogs work 100%.

#### Lifecycle & acceptance

- `org_purge` deletes `crove_projects.project_cycle` after `project_task`; `offboarding.ts` exports `projects.project_cycle`; `personal-data.ts` registers `project_cycle.name` and `project_cycle.goal` (`free_text`, `erase`); `manifest.ts` lists `project_cycle` and new `project` / `project_task` columns; `PENDING_TABLES` entry removed.

---

### 4.2 Custom Columns per Project (`#2605`)

**Goal:** Let teams customize workflow columns per project (stages, order, WIP limits, semantic colors) mapped to canonical `crove_kernel.task.status` so org-chart agents and people share one status vocabulary.

#### Database schema (`<ts>_crove_projects_columns.sql`)

1. **New table `crove_projects.project_column`:**
   - `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`
   - `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`
   - `project_id uuid NOT NULL`
   - `name text NOT NULL CHECK (pg_catalog.length(name) BETWEEN 1 AND 80 AND name = pg_catalog.btrim(name))` (`pii`)
   - `task_status text NOT NULL CHECK (task_status IN ('todo', 'in_progress', 'waiting', 'in_review', 'done'))`
   - `color text NOT NULL DEFAULT 'neutral' CHECK (color IN ('neutral', 'primary', 'warning', 'proposal', 'success', 'destructive'))`
   - `wip_limit smallint CHECK (wip_limit IS NULL OR wip_limit BETWEEN 1 AND 200)`
   - `sort_key text COLLATE "C" NOT NULL CHECK (sort_key ~ '^[0-9A-Za-z]{1,200}$')`
   - `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
   - `updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
   - Keys & indexes: `PRIMARY KEY (org_id, id)`, `CONSTRAINT project_column_project_fk FOREIGN KEY (org_id, project_id) REFERENCES crove_projects.project (org_id, id) ON DELETE CASCADE`, `CONSTRAINT project_column_project_id_uq UNIQUE (org_id, project_id, id)`, `CREATE INDEX IF NOT EXISTS project_column_project_idx ON crove_projects.project_column (org_id, project_id, sort_key, id);`.
   - RLS: `SELECT crove_kernel.apply_tenant_rls('crove_projects.project_column');` (plus `project_visibility` policy if `#2604` is on `main`).
2. **`crove_projects.project_task` extension:**
   - `column_id uuid`
   - `CONSTRAINT project_task_column_fk FOREIGN KEY (org_id, project_id, column_id) REFERENCES crove_projects.project_column (org_id, project_id, id) ON DELETE SET NULL (column_id)`
   - `CREATE INDEX IF NOT EXISTS project_task_column_idx ON crove_projects.project_task (org_id, project_id, column_id) WHERE column_id IS NOT NULL;`

#### Zero-setup behavior & canonical mapping (amends ADR-0048 D-4)

- **Default projects (`0` rows in `project_column`):** Keep the exact 5 canonical status columns (`todo`, `in_progress`, `waiting`, `in_review`, `done`; `cancelled` stays behind filter).
- **Customized projects (`1..12` rows in `project_column`):** Clicking "Customize columns" invokes `projects.column.init_defaults`, which materializes the 5 canonical columns into `project_column` (and maps existing `project_task` rows to matching columns) inside one transaction.
- **Invariants enforced on column writes:**
  - At most `12` columns per project (`PROJECT_COLUMNS_MAX`).
  - Every customized project MUST retain at least one column mapped to `'todo'` and at least one mapped to `'done'` (`COLUMN_STATUS_REQUIRED`).
  - `cancelled` tasks remain hidden behind the cancelled filter and never map to a custom column.
- **Agent & kernel interoperability:**
  - Moving a card to custom column `C` (`projects.task.move_column`) updates `project_task.column_id = C.id` (plus optional `sort_key` placement) AND updates `crove_kernel.task.status = C.task_status` via `kernel.task.set_status` / kernel update in the same `Runtime.execute()` transaction (preserving the `TASK_CHECKED_OUT` lease guard when an agent run holds the task).
  - When an org-chart agent (or external `kernel.task.set_status` / Tasks screen call) updates `crove_kernel.task.status` directly without touching `project_task.column_id`, the board read deterministically places the card in `column_id` if that column's `task_status` still equals `task.status`, and otherwise falls back to the first column (by `sort_key, id`) mapped to `task.status`.

#### Commands, UI/UX, and Vy AI part

- **Commands (`project owner`, `owner`, `admin` for column schema; `WRITERS` for `move_column`):**
  - `projects.column.init_defaults`
  - `projects.column.create` (name, `taskStatus`, `color`, `wipLimit`, optional anchor)
  - `projects.column.update` (name, `taskStatus`, `color`, `wipLimit`)
  - `projects.column.reorder` (fractional `sort_key` placement with rebalance)
  - `projects.column.delete` (requires `fallbackColumnId` for reassigning tasks in the deleted column; refuses deleting the last `'todo'` or last `'done'` column)
  - `projects.task.move_column` (sets `column_id`, syncs `task.status`, optionally sets `sort_key`)
- **UI/UX & Mobile a11y:** Columns render semantic `@ludy/ui` color tokens (`neutral`, `primary`, `warning`, `proposal`, `success`, `destructive`) compliant with `tools/ui-colors.mjs`. When a column's visible card count exceeds `wip_limit`, a deterministic warning badge renders (soft WIP limit: warns clearly without blocking urgent moves). Mobile list and board include `>= 44 px` keyboard/tap column move pickers.
- **Vy AI part:** `projects.weekly_status` and `projects.cycle_summary` read custom column names deterministically alongside task status counts when custom columns exist. Core board and WIP warnings work 100% with AI off.

#### Lifecycle & acceptance

- `org_purge` deletes `project_column` after `project_task`; `offboarding.ts` exports `projects.project_column`; `personal-data.ts` registers `project_column.name` (`free_text`, `erase`); `manifest.ts` updated; `PENDING_TABLES` entry removed.

---

### 4.3 Task Dependencies (`#2601`)

**Goal:** Let teams model "blocks / is blocked by" relationships between tasks in a project, enforce a cycle-free DAG, and highlight bottlenecks without touching `crove_kernel.task.parent_task_id`.

#### Database schema (`<ts>_crove_projects_dependencies.sql`)

1. **`crove_projects.project_task` constraint:**
   - `ALTER TABLE crove_projects.project_task ADD CONSTRAINT project_task_project_task_uq UNIQUE (org_id, project_id, task_id);`
2. **New table `crove_projects.task_dependency`:**
   - `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`
   - `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`
   - `project_id uuid NOT NULL`
   - `blocker_task_id uuid NOT NULL`
   - `blocked_task_id uuid NOT NULL`
   - `created_by uuid`
   - `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
   - Keys & checks:
     - `PRIMARY KEY (org_id, id)`
     - `CHECK (blocker_task_id <> blocked_task_id)`
     - `CONSTRAINT task_dependency_edge_uq UNIQUE (org_id, blocker_task_id, blocked_task_id)`
     - `CONSTRAINT task_dependency_project_fk FOREIGN KEY (org_id, project_id) REFERENCES crove_projects.project (org_id, id) ON DELETE CASCADE`
     - `CONSTRAINT task_dependency_blocker_fk FOREIGN KEY (org_id, project_id, blocker_task_id) REFERENCES crove_projects.project_task (org_id, project_id, task_id) ON DELETE CASCADE`
     - `CONSTRAINT task_dependency_blocked_fk FOREIGN KEY (org_id, project_id, blocked_task_id) REFERENCES crove_projects.project_task (org_id, project_id, task_id) ON DELETE CASCADE`
   - Supporting indexes (covering all three FKs):
     - `CREATE INDEX IF NOT EXISTS task_dependency_project_idx ON crove_projects.task_dependency (org_id, project_id, created_at);`
     - `CREATE INDEX IF NOT EXISTS task_dependency_blocker_idx ON crove_projects.task_dependency (org_id, project_id, blocker_task_id);`
     - `CREATE INDEX IF NOT EXISTS task_dependency_blocked_idx ON crove_projects.task_dependency (org_id, project_id, blocked_task_id);`
   - RLS: `SELECT crove_kernel.apply_tenant_rls('crove_projects.task_dependency');` (plus `project_visibility` policy if `#2604` is on `main`).

#### Isolation from `parent_task_id` & DAG enforcement

- `crove_kernel.task.parent_task_id` and `request_depth` stay strictly reserved for agent delegation/escalation chains ([ADR-0029](../adr/0029-agents-positions-and-org-chart.md), depth `0..5`). Project dependencies live exclusively in `crove_projects.task_dependency` and are scoped to tasks within the same `(org_id, project_id)`.
- **Lock & cycle safety (`projects.dependency.add`):**
  1. Acquires `SELECT 1 FROM crove_projects.project WHERE org_id = $1 AND id = $2 FOR UPDATE` so concurrent edge insertions in the same project cannot create a race-condition cycle.
  2. Enforces bounded graph caps: `<= 500` edges per project (`PROJECT_DEPENDENCIES_MAX`) and `<= 20` edges (`blocker` + `blocked` combined) per task (`TASK_DEPENDENCIES_MAX`).
  3. Runs a bounded recursive CTE / BFS starting from `blocked_task_id` along existing edges `(blocker_task_id -> blocked_task_id)` to verify `blocker_task_id` is not reachable from `blocked_task_id`; if reachable (or equal), rejects with `422 DEPENDENCY_CYCLE`.

#### Commands, UI/UX, and Vy AI part

- **Commands & queries (`WRITERS` to add/remove, `READERS` to list):**
  - `projects.dependency.add` (`projectId`, `blockerTaskId`, `blockedTaskId`)
  - `projects.dependency.remove` (`projectId`, `dependencyId` or `(blockerTaskId, blockedTaskId)`)
  - `projects.dependency.list` (`projectId`, optional `taskId`)
- **UI/UX & Mobile a11y:** Board and list cards display an open-blocker badge ("Blocked by N") and blocking count pill; moving a task with open blockers (`blocker.status NOT IN ('done', 'cancelled')`) to `in_progress` or `done` shows a non-blocking warning banner/confirm prompt (humans can still override); task detail modal/page includes `>= 44 px` keyboard-accessible add/remove dependency controls.
- **Deterministic bottlenecks & Vy AI part:** `projects.today` (Home) and Vy `weekly_status` / `cycle_summary` deterministically compute `blocked_count` per open blocker task in code and surface top bottleneck tasks (no LLM math; `summaryNumbersOutside` enforced). Core works 100% with AI off.

#### Lifecycle & acceptance

- `org_purge` deletes `crove_projects.task_dependency` before `project_task` and `project`; `offboarding.ts` exports `projects.task_dependency`; `manifest.ts` updated (no `pii` columns); `PENDING_TABLES` entry removed.

---

### 4.4 Private Projects (`#2604`, Owner Decision A2)

**Goal:** Allow sensitive projects (hiring, disputes, partner contracts, executive plans) to be scoped to `visibility = 'private'` so only invited `project_member`s, `project.owner_user_id`, org `owner`/`admin`, assigned org-chart agents, and `system` can read the project and its tasks.

#### Database schema & RLS architecture (`<ts>_crove_projects_private.sql`)

1. **`crove_projects.project` column:**
   - `visibility text NOT NULL DEFAULT 'org' CHECK (visibility IN ('org', 'private'))`
   - `CREATE INDEX IF NOT EXISTS project_visibility_idx ON crove_projects.project (org_id, visibility, updated_at DESC);`
   - Existing projects and the create form default to `'org'` so solo/open-team zero-setup behavior stays unchanged.
2. **Recursion-free `SECURITY DEFINER` visibility helpers:**
   Following the established `crove_meetings` / `crove_sign` pattern (owned by the migration runner role to bypass RLS without mutual table recursion, `STABLE SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`, `REVOKE ALL ... FROM PUBLIC, crove_tenant, crove_app, crove_worker, crove_definer_tenant`, `GRANT EXECUTE ... TO crove_tenant`):
   - **`crove_projects.project_visible(p_org_id uuid, p_project_id uuid) RETURNS boolean`:**
     1. Fail closed if `crove_kernel.ctx_org_id() IS NULL OR p_org_id IS DISTINCT FROM crove_kernel.ctx_org_id() OR crove_kernel.ctx_actor_type() IS NULL`.
     2. Read `visibility, owner_user_id` from `crove_projects.project` for `(v_org, p_project_id)`. Return `false` if not found.
     3. Return `true` if `visibility = 'org'` or `crove_kernel.ctx_actor_type() = 'system'`.
     4. For `visibility = 'private'`, resolve `v_uid := COALESCE(crove_kernel.ctx_user_id(), crove_kernel.ctx_acting_user_id(), crove_kernel.ctx_mcp_member_id())`. Return `false` if `v_uid IS NULL` (for example, unassigned org-chart agents or non-member MCP company contexts).
     5. Return `true` if `v_uid = v_owner_user_id`, OR `EXISTS (SELECT 1 FROM crove_projects.project_member pm WHERE pm.org_id = v_org AND pm.project_id = p_project_id AND pm.user_id = v_uid)`, OR `EXISTS (SELECT 1 FROM crove_kernel.tenant_member tm WHERE tm.org_id = v_org AND tm.user_id = v_uid AND tm.role IN ('owner', 'admin'))`.
   - **`crove_projects.project_row_visible(p_org_id uuid, p_project_id uuid, p_visibility text, p_owner_user_id uuid) RETURNS boolean`** (used on `crove_projects.project` itself, especially `INSERT` `WITH CHECK`, because in PostgreSQL a statement-level `STABLE` query inside `WITH CHECK` cannot see the row being inserted into `project` in the same statement!):
     - Performs the exact same org/actor/visibility check using the row's own `p_visibility` and `p_owner_user_id` directly (avoiding querying `crove_projects.project` during `INSERT`), falling back to `project_member` and `tenant_member` lookups when `p_visibility = 'private'`.
   - **`crove_projects.task_visible(p_org_id uuid, p_task_id uuid, p_assignee_position_id uuid) RETURNS boolean`:**
     1. Fail closed if `ctx_org_id() IS NULL OR p_org_id IS DISTINCT FROM ctx_org_id() OR ctx_actor_type() IS NULL`.
     2. Return `true` if `ctx_actor_type() = 'system'`.
     3. Look up `pt.project_id, p.visibility` via `crove_projects.project_task pt JOIN crove_projects.project p` for `(v_org, p_task_id)`. If not linked to a project or `p.visibility = 'org'`, return `true`.
     4. For a task in a `private` project: if `ctx_actor_type() = 'agent' AND ctx_acting_user_id() IS NULL AND ctx_mcp_member_id() IS NULL AND ctx_position_id() IS NOT NULL AND p_assignee_position_id = crove_kernel.ctx_position_id()`, return `true` (assigned org-chart agent working its own seat's task). Otherwise delegate to `crove_projects.project_visible(v_org, v_project_id)`.
3. **`RESTRICTIVE` RLS policies:**
   - **`project_visibility` `AS RESTRICTIVE FOR ALL TO crove_tenant`** on:
     - `crove_projects.project` (`USING` and `WITH CHECK` via `crove_projects.project_row_visible(org_id, id, visibility, owner_user_id)`)
     - `crove_projects.project_member`, `crove_projects.project_task`, and **every other `crove_projects.*` table present on `main`** (including `project_cycle`, `project_column`, `task_dependency`, `time_entry` as landed) via `USING (crove_projects.project_visible(org_id, project_id)) WITH CHECK (crove_projects.project_visible(org_id, project_id))`.
     - Note that `project_visibility` `WITH CHECK` on `crove_projects.project_task` directly blocks non-members from attaching any existing `crove_kernel.task` to a `private` project in SQL or commands.
   - **`private_project_scope` `AS RESTRICTIVE FOR ALL TO crove_tenant`** on `crove_kernel.task`:
     - `USING (crove_projects.task_visible(org_id, id, assignee_position_id))`
     - `WITH CHECK (crove_projects.task_visible(org_id, id, assignee_position_id))`
     - Existing `task_scope` on `crove_kernel.task_comment` (`EXISTS (SELECT 1 FROM crove_kernel.task t ...)`) automatically inherits `private_project_scope`, hiding comments on private tasks from non-members.

#### Actor matrix, cross-module safety, and commands

| Actor / Context | `visibility = 'org'` | `visibility = 'private'` |
| --- | --- | --- |
| Org `owner` / `admin` | Read + manage | Read + manage |
| `project.owner_user_id` / `project_member` (`member`) | Read + write tasks | Read + write tasks |
| `project_member` (`viewer`) | Read only | Read only (invited to private project) |
| Non-member org `member` / `viewer` | Read (+ write tasks if `member`) | **0 rows** (project, columns, cycles, deps, time entries, tasks, comments, linked panels) |
| Assigned org-chart agent (`ctx_position_id() = assignee_position_id`) | Read/work own seat's task (per `le_scope`) | Read/work ONLY its own assigned task (`task_visible` true; 0 `crove_projects.*` access) |
| Unassigned org-chart agent | Read tasks per `le_scope` | **0 rows** for private tasks and `crove_projects.*` |
| Member-scoped `Vy` (`member_vy`) / `mcp_member` | Reads org-visible projects/tasks | Strictly matches acting member's membership via `COALESCE(...)` |
| `system` (`org_purge`, owner `org_export`) | Full access | Full access (owner org export includes all org projects; `org_purge` deletes cleanly) |

- **Commands & self-lockout guard (`projects.project.create`, `projects.project.update`, `projects.project.set_owner`, `projects.member.*`):**
  - Only `project.owner_user_id`, org `owner`, or org `admin` may create/update `visibility = 'private'` or toggle `'org' <-> 'private'`.
  - When creating a `private` project or changing an `'org'` project to `'private'`, the project creator (on create) and `owner_user_id` are automatically ensured in `project_member` so a plain member cannot lock themselves out on `INSERT` (`project_row_visible` passes for `owner_user_id`, and `project_member` persists membership).
  - Removing `owner_user_id` via `projects.member.remove` is refused unless owner changes first; when a member leaves the org (`tenant_member` cascade), `owner_user_id` becomes `NULL` and falls back to org `owner`/`admin`.
- **Cross-module & side-channel checks:**
  - `crove_notes.link` (`notes.record.panel`) and `apps/kernel` notifications / SSE invalidation streams MUST verify target project/task readability so a non-member never receives private project/task existence, titles, or note-link counts.
  - `projects.today`, `/o/:slug/tasks`, and `/o/:slug/my-work` naturally filter out private tasks via `private_project_scope` in PostgreSQL.
- **UI/UX:** Project cards and header display a lock badge + member count for `private` projects; the create/edit dialog replaces the static "Every org member sees this project" notice dynamically when `visibility = 'private'` is selected.
- **AI part:** Core private project isolation works 100% with AI off. `Vy` (`projects.weekly_status`, `projects.cycle_summary`, `projects.tasks_from_note`, `projects.tasks_from_source`) executes under the caller's sealed context and automatically inherits `project_visible` / `task_visible`.

#### Migration lint, shared-core, and two-step invariant gate

- Modifying `crove_kernel.task` RLS policies triggers `shared-core` Platform PO review ([docs/product-owner-config.md](../product-owner-config.md#shared-core-review)).
- The migration carries `-- migration-lint: cross-module <reason>` before statements touching `crove_kernel.task` (and updates `crove_kernel.org_purge` if new objects require it), strictly matching `tools/ci/migration-lint.mjs`.
- `Invariant suite (from base)` (`rls-matrix.db.test.ts` on `main`) passes cleanly on `#2604` because existing `ROW_FACTORIES` create `visibility = 'org'` projects (default).
- `#2604` adds `apps/kernel/test/invariant/projects-private.db.test.ts` testing: non-member `SELECT`/`INSERT`/`UPDATE`/`DELETE` denial across `project`, `project_member`, `project_task`, `crove_kernel.task`, `crove_kernel.task_comment`, `crove_notes.link`; non-member refusal when trying to attach an existing org task to a private project; `org` `owner`/`admin` + invited `project_member` + assigned org-chart agent access vs unassigned agent denial; `member_vy` isolation; and a **structural catalog assertion** verifying every `crove_projects.*` table carrying `project_id` has a `RESTRICTIVE` `project_visibility` policy.

## 5. Wave 2 specifications (`priority:P2`, `M3 Paid pilot`)

### 5.1 Gantt / Timeline View (`#2599`)

**Depends on:** `#4359`, `#4360`, `#2601` (Task dependencies).

**Goal:** Provide a visual week/month project timeline with start/due schedule bars, dependency arrows, cycle bands (when `#4361` is enabled), and deterministic conflict/critical-path hints.

#### Schema & commands (`<ts>_crove_projects_timeline.sql`)

- **`crove_projects.project_task` extension:**
  - `start_on date` (nullable; no new table required).
  - Note that `crove_kernel.task.due` is `timestamptz` (not `due_at`). Validation enforces that when both `start_on` and `task.due` are present, `start_on <= (task.due AT TIME ZONE 'Asia/Ho_Chi_Minh')::date` (or the org/caller date of `task.due`, verified cleanly in `projects.task.set_dates` with error `422 INVALID_DATE_RANGE`).
- **Command `projects.task.set_dates` (`WRITERS`, `Runtime.execute()`):**
  - Input: `{ projectId, taskId, startOn?: LocalDate | null, due?: IsoDateTime | null }`.
  - Updates `crove_projects.project_task.start_on` AND updates `crove_kernel.task.due` in one atomic transaction, refusing if `TASK_CHECKED_OUT` by a live agent run (`agents.ts` lease guard).
- **Query `projects.timeline` (`READERS`):**
  - Returns scheduled tasks (having `start_on` or `due`), unscheduled tasks list, dependency edges (`#2601`), and cycles (`#4361` when `cycles_enabled`), capped cleanly (`PROJECT_BOARD_LIMIT` / timeline window).

#### UI/UX, mobile, and Vy AI part

- **Timeline tab (`/o/:slug/projects/:id`):** Renders alongside `Board` and `List` tabs with Week / Month zoom toggle, Today marker, cycle band overlays when `cycles_enabled`, SVG dependency connector arrows from `#2601`, and an Unscheduled tasks drawer for 1-click scheduling.
- **Accessibility & mobile:** Interactive bars support drag-reschedule AND keyboard reschedule (arrow keys / Enter to open accessible date editor), plus a semantic schedule table fallback for screen readers and mobile (`< 768 px`) with `>= 44 px` touch targets.
- **Deterministic checks & AI part:** Code deterministically flags dependency date violations (`blocker` due date later than `blocked` start date, or later than `blocked` due date when `start_on` is null) and computes longest blocking chain / critical path length. Optional Vy schedule summary reuses `projects.weekly_status` / `projects.cycle_summary` (no invented dates or counts). Core timeline works 100% with AI off.

---

### 5.2 Lean Time Tracking & Billable Hours (`#2600`)

**Depends on:** `#4359`, `#4360`.

**Goal:** Let solo founders and SME service teams track task or project hours with a single active timer or manual logs, mark billable hours and rates, and export clean CSV / deterministic summaries. **Explicitly excludes automatic Accounting invoicing and HR payroll sync** (owner decision `A1`).

#### Database schema (`<ts>_crove_projects_time_tracking.sql`)

1. **New table `crove_projects.time_entry`:**
   - `org_id uuid NOT NULL REFERENCES crove_kernel.tenant (org_id) ON DELETE CASCADE`
   - `id uuid NOT NULL DEFAULT crove_kernel.uuid_v7()`
   - `project_id uuid NOT NULL`
   - `task_id uuid` (nullable for project-level time logs)
   - `user_id uuid` (nullable via `ON DELETE SET NULL` when a member leaves the org, preserving historical billable hours)
   - `started_at timestamptz NOT NULL`
   - `ended_at timestamptz` (`NULL` = currently running timer; `CHECK (ended_at IS NULL OR ended_at >= started_at)`)
   - `duration_minutes integer CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 14400)` (computed/validated on stop or manual log; capped at 10 days / 14,400 min per entry)
   - `billable boolean NOT NULL DEFAULT false`
   - `hourly_rate NUMERIC(18, 2) CHECK (hourly_rate IS NULL OR hourly_rate >= 0)`
   - `note text CHECK (note IS NULL OR pg_catalog.length(note) <= 500)` (`pii`)
   - `created_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
   - `updated_at timestamptz NOT NULL DEFAULT pg_catalog.now()`
   - Keys & foreign keys:
     - `PRIMARY KEY (org_id, id)`
     - `CONSTRAINT time_entry_project_fk FOREIGN KEY (org_id, project_id) REFERENCES crove_projects.project (org_id, id) ON DELETE CASCADE`
     - `CONSTRAINT time_entry_task_fk FOREIGN KEY (org_id, project_id, task_id) REFERENCES crove_projects.project_task (org_id, project_id, task_id) ON DELETE SET NULL (task_id)` (preserves historical project time entries if a task is detached from the project, while deleting the project cascades via `time_entry_project_fk`)
     - `CONSTRAINT time_entry_user_fk FOREIGN KEY (org_id, user_id) REFERENCES crove_kernel.tenant_member (org_id, user_id) ON DELETE SET NULL (user_id)`
     - `CHECK ((ended_at IS NULL) = (duration_minutes IS NULL))` (running timers have null duration; stopped/manual entries have integer minutes `1..14400`)
   - Indexes & RLS:
     - `CREATE UNIQUE INDEX IF NOT EXISTS time_entry_running_uq ON crove_projects.time_entry (org_id, user_id) WHERE ended_at IS NULL AND user_id IS NOT NULL;` (at most ONE active timer per user per org)
     - `CREATE INDEX IF NOT EXISTS time_entry_project_idx ON crove_projects.time_entry (org_id, project_id, started_at DESC);`
     - `CREATE INDEX IF NOT EXISTS time_entry_task_idx ON crove_projects.time_entry (org_id, project_id, task_id) WHERE task_id IS NOT NULL;`
     - `CREATE INDEX IF NOT EXISTS time_entry_user_idx ON crove_projects.time_entry (org_id, user_id, started_at DESC) WHERE user_id IS NOT NULL;`
     - `SELECT crove_kernel.apply_tenant_rls('crove_projects.time_entry');` (plus `project_visibility` policy if `#2604` is on `main`).

#### Commands, money arithmetic, and queries

All commands require `userOf(ctx.actor)` (org-chart agents cannot track or modify time) and reject archived projects:

- **`projects.time.start` (`WRITERS`):** Starts a live timer (`ended_at = NULL`, `duration_minutes = NULL`) on a project (and optional `taskId` in that project). If the caller already has a running timer in that org, either refuses with `409 TIMER_ALREADY_RUNNING` (returning the active entry id/project) or stops the previous timer atomically only when `stopExisting: true` is explicitly passed by the caller's click.
- **`projects.time.stop` (`WRITERS`):** Stops the caller's running timer (`ended_at = ctx.now`), computes `duration_minutes = GREATEST(1, ROUND(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60))` clamped/checked `<= 14400`, and records the completed entry.
- **`projects.time.log` (`WRITERS`):** Records a completed manual entry (`startedAt`, `durationMinutes` or `endedAt`, `billable`, optional `hourlyRate` as decimal string, optional `note`).
- **`projects.time.update` / `projects.time.delete`:** Own entry (`entry.user_id === userId`) OR project owner / org `owner` / org `admin`. Viewers are always forbidden.
- **Money & decimal arithmetic:** `hourly_rate` is stored as `NUMERIC(18, 2)` and validated/serialized as a decimal string (`zDecimalMoney`). Billable amount calculation (`(duration_minutes / 60) * hourly_rate`, rounded cleanly with `decimal.js` via `@ludy/l10n-vn`) NEVER uses JS floating-point `number` arithmetic.
- **`projects.time.summary` (query, `READERS`) & CSV export:** Deterministic totals of total logged minutes/hours, billable minutes/hours, non-billable hours, and billable amount per project, per task, and per member (using `decimal.js` / SQL `NUMERIC`). CSV export neutralizes spreadsheet formula prefixes (`=`, `+`, `-`, `@`) and uses the `ludy-` download prefix (`#3966`).

#### UI/UX, mobile, and Vy AI part

- **Task detail & Project Time tab:** Timer toggle (`Start timer` / `Stop timer`) with static start timestamp (`aria-live="off"` so screen readers do not announce every tick), `>= 44 px` Stop button, manual log dialog, and deterministic summary cards.
- **Vy AI part:** Any optional narrative recap in `projects.weekly_status` / `projects.cycle_summary` reads ONLY code-computed totals and hours/amounts checked by `summaryNumbersOutside`; never posts vouchers or invoices. Core timer, logging, summary, and CSV export work 100% with AI off.

#### Lifecycle & acceptance

- `org_purge` deletes `crove_projects.time_entry` before `project_task` and `project`; `offboarding.ts` exports `projects.time_entry`; `personal-data.ts` registers `time_entry.note` (`free_text`, `erase`); `manifest.ts` updated; `PENDING_TABLES` entry removed.

## 6. Build sequence, dependencies, and Icebox boundaries

| Slice | Issue | Wave & priority | Depends on | Key protected / shared-core scope |
| --- | --- | --- | --- | --- |
| Plan & ADR | [#4359](https://github.com/DOS/Ludy/issues/4359) | Prep, `P1` | - | Docs only (`pnpm docs:check`) |
| Step 0 Invariants | [#4360](https://github.com/DOS/Ludy/issues/4360) | Prep, `P1` | `#4359` | `rls-matrix.db.test.ts` (`PENDING_TABLES` + 4 row factories) |
| Cycles & Points | [#4361](https://github.com/DOS/Ludy/issues/4361) | Wave 1, `P1` | `#4359`, `#4360` | Migration, `org_purge` (`shared-core`), `rls-matrix`, `AI_FEATURES` |
| Custom Columns | [#2605](https://github.com/DOS/Ludy/issues/2605) | Wave 1, `P1` | `#4359`, `#4360` | Migration, `org_purge` (`shared-core`), `rls-matrix` |
| Task Dependencies | [#2601](https://github.com/DOS/Ludy/issues/2601) | Wave 1, `P1` | `#4359`, `#4360` | Migration, `org_purge` (`shared-core`), `rls-matrix` |
| Private Projects | [#2604](https://github.com/DOS/Ludy/issues/2604) | Wave 1, `P1` | `#4359`, `#4360` | Migration touching `crove_kernel.task` RLS (`shared-core` Platform PO review), `projects-private.db.test.ts` |
| Gantt / Timeline | [#2599](https://github.com/DOS/Ludy/issues/2599) | Wave 2, `P2` | `#4359`, `#4360`, `#2601` | Migration (`project_task.start_on`) |
| Lean Time Tracking | [#2600](https://github.com/DOS/Ludy/issues/2600) | Wave 2, `P2` | `#4359`, `#4360` | Migration, `org_purge` (`shared-core`), `rls-matrix`, `decimal.js` money math |

**Parallel coordination rule between `#2604` and other slices:** Whichever of `#4361`, `#2605`, `#2601`, `#2600` merges **after** `#2604` MUST include the `RESTRICTIVE` `project_visibility` RLS policy on its newly created `crove_projects.*` table (checked automatically by `projects-private.db.test.ts`); conversely, if `#2604` merges after any of those slices, `#2604` attaches `project_visibility` to every `crove_projects.*` table already on `main`.

**Public Roadmap track (`priority:P1`, scheduled right after Wave 1):** Per owner decision on `2026-11-22` ([#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7073382197)), the opt-in Public Roadmap (`Ideas`, `Roadmap`, `Changelog`, `?embed=1`, 6-digit email OTP voting, Vy dedupe/changelog drafting, and MCP read tools) is specified in [projects-public-roadmap.md](projects-public-roadmap.md) ([projects-public-roadmap.vi.md](projects-public-roadmap.vi.md)) and [ADR-0057](../adr/0057-projects-public-roadmap-ideas-voting-changelog.md), tracked across [#4397](https://github.com/DOS/Ludy/issues/4397) (Plan & ADR), [#4398](https://github.com/DOS/Ludy/issues/4398) (Step 0 Invariants), [#4399](https://github.com/DOS/Ludy/issues/4399) (Slice 1 Core), and [#4400](https://github.com/DOS/Ludy/issues/4400) (Slice 2 Changelog, Embed & AI/MCP). It keeps `#2604` private projects strictly unlinked and isolated, and builds right after Wave 1 ahead of or alongside Wave 2 (`#2599`, `#2600`).

**Omnichannel Roadmap Signals & Projects Triage Inbox (`priority:P1`, `M3 Paid pilot`):** Per owner decision on `2026-11-23` ([#1210 comment](https://github.com/DOS/Ludy/issues/1210#issuecomment-7090763080)), the next AI-native Projects wave adds internal omnichannel demand signals (`roadmap_signal`, Slice 1 [#4492](https://github.com/DOS/Ludy/issues/4492)) and a dedicated pre-task Projects Triage Inbox (`project_triage_item` with Accept / Merge / Snooze / Decline / Reopen, `#2604` `project_visibility` RLS parity, Vy `projects.triage_assist`, and read-only MCP `projects.mcp.triage_summary`, Slice 2 [#4493](https://github.com/DOS/Ludy/issues/4493)), specified in [projects-signals-triage.md](projects-signals-triage.md) ([projects-signals-triage.vi.md](projects-signals-triage.vi.md)) and [ADR-0058](../adr/0058-projects-omnichannel-signals-and-triage.md) with Step 0 invariants in [#4491](https://github.com/DOS/Ludy/issues/4491) (plan [#4490](https://github.com/DOS/Ludy/issues/4490)).

**Kept in Icebox (`priority:P3`):** [#2602](https://github.com/DOS/Ludy/issues/2602) (Resource planning / workload) and [#2603](https://github.com/DOS/Ludy/issues/2603) (Client portals, distinct from the opt-in Public Roadmap in `#4397` to `#4400`).
