# 0048. Projects on kernel tasks: a module that groups tasks, status columns, org-wide visibility, links from notes, Vy proposes

- Status: Proposed (2026-11-03). Nothing here is built. The owner discusses the plan before any build; decisions D-1 to D-5 of the plan are open.
- Date: 2026-11-03
- Deciders: owner (JOY), who asked on 2026-11-03 for a lean, core-first, AI-first plan for projects and a task board; the engineering choices below by the Claude Code session that wrote the plan
- Builds on: ADR-0029 (agents, positions, tasks), ADR-0031 (module enablement), ADR-0037 (private notes and to-dos) and the owner's decision of 2026-11-03 on #1677 (each member has their own Vy, which reads exactly what the member can), the agents' write guard (#285), Home's today list (#2383), the AI budget meter (#2382)
- Plan: [projects.md](../plan/projects.md)

## Context and problem statement

Ludy has kernel tasks (`crove_kernel.task`): a title, a description, a status, a due date, a seat in the org chart that holds it, comments, taint, and the lease agents work under. Every member and viewer of the org reads them, narrowed by the task's legal entity. People can create a task, comment and change its status, but not edit it afterwards. There is no way to group tasks, no board, and no link from a note or a to-do to a task.

Small teams need to group their work into projects, follow it on a board, and see their own tasks across projects. What has to be decided:

1. whether a project is a kernel table or a module, and how it relates to `kernel.task`;
2. the board's columns;
3. who sees a project;
4. how notes and to-dos link to tasks and projects;
5. what agents and the member's Vy may do with tasks.

## Decision drivers

- Lean: reuse `kernel.task` as it is, and add as little as possible.
- ADR-0029's rules for tasks (seats, leases, fencing, taint, depth) and the invariants that test them stay unchanged.
- A deployment that turns projects off keeps every other module working (ADR-0031).
- Private to-dos and notes stay private (ADR-0037).
- AI output is tainted and stays a proposal that a person confirms.

## Decision

### 1. A module that points at tasks; `kernel.task` gains nothing

- Projects are a module, `modules/projects`, schema `crove_projects`, module id `projects` (reserved in the kernel plan).
- Three tenant tables:
  - `project`: name, description, owner (a member), status `active`, `on_hold`, `done`, `archived`;
  - `project_member`: the members on it;
  - `project_task`: which project a task is in, unique per task, with a foreign key `(org_id, task_id)` to `crove_kernel.task`.
- The foreign key goes from the module to the kernel, never back, the only direction the module rules allow (no foreign key into a module's schema from outside it). No column, trigger or policy is added to `kernel.task`.
- A task is created in a project by the module's command, which runs `kernel.task.create` through `ctx.run` and inserts the `project_task` row in the same transaction. The task's `source_ref` is not used for this: it stays set by kernel code only.
- The only kernel change is a people's edit command, `kernel.task.update` (title, description, due, seat). It is refused while an agent's run holds the task's lease and when the new seat cannot read the task's legal entity. It also notifies the person who holds the seat a task is given or moved to.

### 2. Board columns are the task's status

- The columns are `todo`, `in_progress`, `waiting`, `in_review` and `done`; `cancelled` sits behind a filter.
- Moving a card runs `kernel.task.set_status`, so people and agents share one meaning of where a task stands.
- Order inside a column is by due date, then by creation. Per-project columns and manual ranks are left for later.

### 3. Every member of the org sees every project

- A project is read by every member and viewer of the org, as tasks are. `project_member` is for filters, the seat picker and nudges, not for access.
- A project has no legal entity. Its tasks keep theirs, and the board shows only the tasks the reader's `le_scope` allows, with a count of the hidden ones.
- Create, add and remove tasks: owners, admins and members. Rename, change status, members or owner, archive: the project owner, owners and admins.
- Private projects would need a restrictive policy on `kernel.task`, which changes what members and agents read today. They are left for later, as an owner decision.

### 4. Notes and to-dos link to tasks and projects through `crove_notes.link`

- `link.target_type` gains `kernel.task`, with a `task_id` column and a foreign key as for the other kernel targets, and `projects.project`, checked through the module's `get` query in the writer's context.
- Nothing changes in ADR-0037's policies:
  - a link reads through its note's or to-do's policy;
  - only the author or the to-do's owner writes a link.
- A private item linked to a task is therefore visible to its author alone, on the task's page.
- A private note's or to-do's text reaches a task only when its author confirms it: by hand-over, or by confirming Vy's proposal (point 5). Both show the text the team will see.

### 5. Agents keep ADR-0029; the member's Vy only proposes

- **Org-chart agents.** These agents keep working tasks of their own seats under a lease, so their cards move on the board. The `crove_projects` tables get the agents' write guard from `apply_tenant_rls` and are not on its allowlist, so agents never create projects, add tasks to a project or change membership.
- **The member's Vy.** Vy acts for one member and runs in that member's sealed context with that member's rights, as the ADR-0037 addendum required by #1677 will define. In this decision it writes nothing on its own:
  - its task proposals (from a note the member chose) are checked by code and listed for the member;
  - the member confirms them, in a batch for the clean ones;
  - each confirmation runs the member's own command, and the task is created tainted and linked to the note.
- **Org-visible AI output.** Output such as the weekly status reads tasks and their comments only, never a note, and every figure in it must come from code (the numbers check of #1237).
- **Metering.** Model calls go through `metered(...)` under `projects.weekly_status` and `projects.tasks_from_note`. The board, My work and the nudges on Home work with AI off.
- **Before the addendum.** No step reads a note with a model until the ADR-0037 addendum is accepted.

## Consequences

- Good: `kernel.task`, its triggers and ADR-0029 stay unchanged, so the agents' invariant tests (`agents.db.test.ts`) do not move. Turning the module off leaves tasks as they are.
- Good: one status serves people, agents, the board and Home's nudges.
- Bad: three new tenant tables, each going through the two-step rule (invariants first), the org purge (projects before tasks), the export and the personal-data registry. The migrations are protected paths.
- Bad: every project is visible to the whole team. The create form says so; private projects need an invariant change later.
- Bad: tasks belong to seats, so a team must give each teammate a seat once (owner only, R3) before tasks can go to them. A solo owner needs none.
- Neutral: delegated and escalated child tasks are not added to their parent's project automatically; they show on their parent's page as today.

## Alternatives considered

- **A kernel `project` table and a `project_id` column on `kernel.task`.** Rejected: it changes the task table that agents write under a lease (a new column on the allowlist, ADR-0029 and its tests), and the module could not be turned off.
- **Labels or tags on tasks instead of projects.** Rejected: a project needs an owner, members and a status, which a label does not have.
- **Subtasks on `parent_task_id` as a checklist.** Rejected: that column carries the agents' delegation and escalation chain and its depth limit. A checklist is a later field of its own.
- **Columns per project.** Deferred: it needs a column table and a map to the status that agents set. Status columns cover the weekly job.
- **Project members only see the project.** Deferred: it needs a restrictive policy on `kernel.task` (an invariant change), and the owner's decision.
- **A person instead of a seat as the task's owner.** Deferred: it needs an `assignee_user_id` on `kernel.task`. That would bypass seats, which hand-over, the reroute on member removal and agents all rely on.

## Revisit when

- The owner asks for private projects or per-project columns.
- Teams exist (`team_lead`), so a project could belong to a team.
- The ADR-0037 addendum of #1677 is accepted, which unblocks plan step P7.
- The Meeting Notes module (ADR-0047, planned in parallel) lands, so tasks can be proposed from a meeting.
