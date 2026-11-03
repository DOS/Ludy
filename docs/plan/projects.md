# Projects and a task board on kernel tasks: plan

> Plan, 2026-11-03, from the owner's go-ahead the same day: keep it lean, core features first, and AI-first. Design only: nothing here is built, no issue is created, and the owner discusses the plan before any build starts. The decision record is [ADR-0048](../adr/0048-projects-on-kernel-tasks.md) (Proposed); a Vietnamese summary for the owner is [projects.vi.md](projects.vi.md). The gate it passes is [docs/product/scope.md](../product/scope.md); the patterns it borrows are in the [AI-first reference study](../research/ai-first-reference-study.md).

## 1. The user and the weekly job

- **Who.** The owner of a one-person company or a small team (2 to about 20 people), and the bookkeeper or salesperson who works with them. In an accounting firm's org, the staff who run a client's month.
- **The weekly job.** Group the work that belongs together (a shop opening, a customer's order, a client's year-end close), see who does what by when, move it along, and notice what is late or stuck before a customer does.
- **What they use today.** A chat group, a spreadsheet, a paper notebook, or Ludy's flat task list, which has no grouping, no board and no way to edit a task after it is given.
- **After this plan.** A member opens a project, sees its tasks as a board or a list, adds and edits tasks, drags a card to change its status, finds all of their own tasks across projects in My work, links a note or a to-do to the task it is about, and gets Vy's help: late and stuck work on Home, a weekly status in plain words, and tasks proposed from a note.

## 2. Fit, and the AI part

- **Fit (scope gate 1).** Every small business with more than one piece of ongoing work plans and follows up at least weekly. The plan serves that job and nothing a large organisation needs (section 7).
- **Smallest slice (gate 2).** One person with the defaults: create a project, add tasks, drag them across the board. No setup, no columns to configure, no templates. A team needs one thing a solo owner does not: each teammate holds a seat in the org chart (section 4).
- **AI part, named (gate 3).** Vy, the general manager coworker, works inside the project screens: it flags overdue and stuck tasks on Home, writes a weekly status of a project from its tasks, and proposes tasks from a note the member chooses. Every model call goes through `metered(...)` under new `AI_FEATURES` keys; every figure is computed by code; AI output is tainted and stays a proposal that the member confirms. With AI off or out of budget the projects, the board and My work are complete.
- **Coworker (gate 4).** Projects span the apps, so Vy (`{gm}`) is the coworker named in copy; Projects gets no coworker of its own.
- **Security (gate 5).** No tenancy, approval or agent rule is weakened; kernel tasks keep their policies and ADR-0029's rules (section 6).

## 3. What exists today

| What | Where | Use here |
| --- | --- | --- |
| Tasks: title, description, status (`todo`, `in_progress`, `waiting`, `in_review`, `done`, `cancelled`), due, the seat they are given to (`assignee_position_id`), comments, taint, the agent lease and fencing token, a legal entity | `crove_kernel.task`, `task_comment`; commands in `packages/kernel/src/agents.ts` ([ADR-0029](../adr/0029-agents-positions-and-org-chart.md)) | the board's cards; status is the column |
| Who reads tasks: every member and viewer of the org (`kernel.task.list`, `kernel.task.get`, access all roles), narrowed by the task's legal entity; an agent reads only its own seat's tasks | the tenant policy and the `le_scope` policy (#1762) | projects follow the same visibility |
| People commands on a task: create (`kernel.task.create`), comment, set status. No command edits the title, description, due date or seat after creation; no delete (cancel instead) | `agents.ts` | P1 adds the edit |
| The task's owner is a seat, not a person. A one-person company needs none (a task with no seat is the owner's). Seats are created by the owner only (`kernel.position.create`, R3); a member gets none automatically | `crove_kernel.position` | section 4, decision D-3 |
| `parent_task_id` and `request_depth` belong to delegation and escalation by agents (kinds `delegation`, `escalation`, depth at most 5) | `agents.ts`, task triggers | not reused for subtasks |
| The Tasks screen: a list (all, mine, open), a form to give work to a seat, a task page with comments and status | `apps/app/src/routes/tasks.tsx` | stays; gains a project column |
| My work: my open private to-dos and the open tasks of my seats, grouped by due date | `apps/app/src/routes/my-work.tsx`, `notes.todos.myWork` ([notes.md](notes.md) N4, N5) | "My tasks across projects" |
| Notes and to-dos: private to the author or shared; links to a party, a file, a purchase document, a journal entry, a booking; a to-do handed over becomes a kernel task (`notes.todo.hand_over`) | `crove_notes.note`, `todo`, `link` ([ADR-0037](../adr/0037-private-notes-and-todos.md)) | links to tasks and projects |
| Home's today list: merges `<module>.today` reads (finance, CRM, Social, Ads, conversations); tasks have no line yet | `packages/kernel/src/today.ts`, `packages/kernel-contract/src/today.ts` (#2383) | P5 adds a projects line |
| Vy's daily brief and the numbers check for AI summaries | `packages/agent/src/today.ts`, `summary.ts` (#1237) | the weekly status reuses the check |
| A drag-and-drop board | `apps/app/src/components/deal-board.tsx` (CRM K1) | the pattern for the task board |
| Saved views of a list, scopes `crm.deal` and `crm.party` | `packages/kernel/src/saved-views.ts` (#2227) | later, a task scope |
| No notification reaches a person when a task is given to their seat; only agents are woken (`requestWakeup`) | `agents.ts`, `notifications.ts` | P1 adds one |
| The module id `projects` and the migration prefix `crove_projects_` are reserved; the kernel plan foresaw a task extension attached to `kernel.task` | [crove-os-kernel.md](crove-os-kernel.md) | the shape chosen here |

There is no project, no board and no task edit.

## 4. The lean first slice

### 4.1 A project

- A module of its own, `modules/projects`, schema `crove_projects`, off-switchable like Notes ([ADR-0031](../adr/0031-module-enablement.md)). With the module off, tasks work as today.
- `project`: name (1 to 200 characters), an optional description (up to 2,000), an owner (a member), a status (`active`, `on_hold`, `done`, `archived`), created and updated stamps.
- `project_member`: the members on the project, for filters, the board's seat picker and Vy's nudges. Membership is not access: every member of the org reads every project (decision D-2).
- `project_task`: which project a task belongs to, at most one per task. A foreign key to `crove_kernel.task` (a module may point at the kernel, never the other way), so `kernel.task` gains no column.
- Any member creates a project and adds tasks, as with tasks today; the project owner, owners and admins rename it, change its status, members and owner, and archive it. Viewers read.

### 4.2 The board and the list

- Columns are the task's status: To do, In progress, Waiting, In review, Done. Cancelled tasks sit behind a filter. Dragging a card runs `kernel.task.set_status`, so an agent working the task sees the same change (decision D-4).
- A card shows the title, the seat (the person or the AI agent holding it), the due date with an overdue mark, the taint mark, and the comment count.
- The list shows the same tasks sorted by due date, with filters by seat and status; it is the default on a phone.
- Add a task in a column or the list: title, seat (picked from the project members' seats, or any seat), due. It is a normal kernel task.
- Edit a task from its card or page: title, description, due, seat (P1). Refused while an agent's run holds the task, as status changes already are for agents.
- Order inside a column is by due date, then by creation. No manual ranking in v1.
- No checklist and no subtasks: the task model has neither (its `parent_task_id` is the agents' delegation chain). Steps a person wants to track stay in their private to-do's checklist, linked to the task (section 4.4). A checklist on tasks is a later step (section 7).

### 4.3 My tasks across projects

- My work already lists the open tasks of my seats. It gains the project's name as a chip on each task and a filter by project.
- The Tasks screen gains a project column and a project filter.
- A member with no seat in a team org sees a hint that the owner gives seats in the org chart; a solo owner needs none.

### 4.4 Links from notes and to-dos

- `crove_notes.link` gains two targets: `kernel.task` (with a `task_id` column and a foreign key, as the kernel targets `party` and `file` have) and `projects.project` (checked through the module's `get` query in the writer's context, as the finance and CRM targets are).
- The task page and the project page show a notes panel through `notes.record.panel`: the shared notes linked to it, and the viewer's own private notes and to-dos linked to it. Nobody else ever sees a private item or that it exists, because the link row reads through its parent's author-only policy (ADR-0037).
- Hand-over (`notes.todo.hand_over`) gains an optional project: the task it creates is added to that project.

## 5. Vy's part

Vy acts for one member, as the owner decided on 2026-11-03 (#1677): it reads exactly what that member can read and nothing more, and what it finds in a private note goes back to that member only. Until the ADR-0037 addendum that #1677 calls for is accepted, nothing here reads a note with a model.

1. **Late and stuck work on Home (P5, no model).** A `projects.today` read adds to Home's list, for the member: tasks of their seats that are overdue (a warning flag) or due today (a deadline); for a project owner, tasks of their project that are overdue, given to a vacant seat, or waiting with no change for 3 days. Deterministic, free to run, and it needs no addendum.
2. **Weekly status of a project (P6).** On a project's page, the member asks for "this week": code counts what was done, what is overdue, what is waiting and what is due next week, and lists the titles; Vy writes 3 to 5 plain Vietnamese sentences from that input only. A sentence with a number not in the input is refused (the rule of `summaryNumbersOutside`, #1237). It reads tasks and their comments, never a note, so it stays free of private content. Shown to the member who asked, marked as AI text; not stored, not sent. Metered as `projects.weekly_status`.
3. **Tasks proposed from a note (P7).** On a note the member can read (their own, or a shared one), Vy proposes tasks: a title, a seat among the project's members' seats, and a due date only when the note states one. Code checks each proposal (the seat exists and is active, the date is a real date, the title fits). The member sees a list, edits, unticks and confirms all clean ones at once; each becomes a kernel task in the chosen project, tainted, linked back to the note. As in hand-over, the member confirms the text the team will see, because a private note's words become an org-visible task only by that click. Metered as `projects.tasks_from_note`. It waits for the addendum (#1677) and the member-scoped Vy run it defines.
4. **Never.** Vy never creates, moves, edits, gives or closes a task without the member's click in this plan; never sends a message; never reads another member's private note; and its output is never a figure that code did not compute.

The same proposal step later runs on a meeting's notes, once the Meeting Notes module exists (planned in parallel as ADR-0047), and on a customer conversation; both are later steps (section 7).

## 6. Permissions and tenancy

- **Tables.** `project`, `project_member`, `project_task`: `org_id`, `PRIMARY KEY (org_id, id)`, row-level security through `crove_kernel.apply_tenant_rls`, foreign keys led by `org_id` with an index, by the two-step rule (an invariant-only PR first with the RLS matrix row factories, #291).
- **Who sees a project.** Every member and viewer of the org, like tasks (decision D-2). A project carries no legal entity; its tasks keep theirs, so a member limited to one entity sees the project but only the tasks the `le_scope` policy lets them read. The board says how many tasks it hides.
- **The org-visible warning.** The create form says that every member of the org sees the project and its tasks.
- **Private to-dos stay private.** Nothing private enters a project or a task unless its author hands it over or confirms Vy's proposal, both showing the text first. Links read through their parent's policy (ADR-0037).
- **Agents in the org chart.** Unchanged: they check out, comment on and set the status of tasks of their own seats under a lease (ADR-0029), so their cards move on the board. They cannot write the `crove_projects` tables (the agents' write guard of #285 covers every new table), so they never create projects, add tasks to one or change membership.
- **The member's Vy.** Runs in the member's own sealed context, with the member's rights and never more (the #1677 addendum). In this plan it only proposes; each write is the member's own command after their click.
- **Data classes.** Project name and description are `pii`, as task titles are; member and owner ids `internal`. The personal-data registry lists them, the org purge deletes `crove_projects` before the kernel's tasks, the org export includes projects, and a removed member leaves the projects they were on (the owner of a project falls back to the org's owners).
- **Audit.** Every command writes its audit row with markers for text (`auditValue`, #1626); outbox events carry ids only.

## 7. What waits, checked against the gate

| Item | Gate result | Where it goes |
| --- | --- | --- |
| Gantt chart and timeline | Fails fit: a planning view for larger teams with long schedules; small teams plan by week | Icebox, P3 |
| Time tracking and billable hours | Fails smallest slice: a different product (time sheets, rates, invoicing exactly once to Accounting); the payroll plan also keeps time-keeping out | Icebox, P3 |
| Dependencies between tasks | Fails smallest slice: a graph with its own rules, and `parent_task_id` already means the agents' chain | Icebox, P3 |
| Sprints | Fails fit: a software-team practice, not a small business's week | Skip |
| Resource planning and workload | Fails fit: serves managers of many people (scope gate 1, large organisations) | Icebox, P3 |
| Client portals | Fails fit and security for now: outside users, sign-in and sharing rules; not needed weekly by a small team | Icebox, P3 |
| Private projects (members only) | Passes fit for some teams, but needs a restrictive policy on `kernel.task`, an invariant change | Icebox, P3, owner decision D-2 |
| Columns per project | Passes fit weakly; status columns cover the weekly job | Icebox, P3, decision D-4 |
| Checklist on a task | Passes fit; the task has no such field, and the private to-do's checklist covers it for now | Icebox, P3 |
| Recurring tasks and project templates | Passes fit (a monthly close), but the tax calendar already covers the main recurring dates | Icebox, P3 |
| Manual order in a column | Small; due-date order first | Icebox, P3 |
| Tasks from a meeting or a conversation | Passes fit; depends on the Meeting Notes module and the conversation core | Icebox, P3, after P7 |
| Weekly status by mail, or shared with the whole project | Passes fit; an org-visible AI output needs the taint rule of #1677 point 4 | Icebox, P3, after P6 |
| A task saved-view scope | Passes fit; filters cover v1 | Icebox, P3 |

## 8. Risks and open questions for the owner

Each decision has a recommendation; nothing is built before the owner answers D-1.

| # | Question | Recommendation | Why |
| --- | --- | --- | --- |
| D-1 | When is it built? | M3 at P2, after M2's P0 and P1 work, like Notes (N-1) | Weekly value for every team, but no pilot interview has asked for it yet, and the monthly close comes first |
| D-2 | Who sees a project? | Every member and viewer of the org, as tasks today; private projects later | A small team shares its work; hiding tasks needs an invariant change on `kernel.task` and ADR-0029 |
| D-3 | Who owns a task: a seat or a person? | Keep the seat; the owner gives each teammate a seat once in the org chart, and the project screen points there | Agents, hand-over and the reroute on member removal all work on seats; a person column on `kernel.task` changes ADR-0029. Cost: one setup step per teammate, owner only |
| D-4 | Board columns: the task's status or columns per project? | The status | Agents and people already set it; one meaning everywhere; no mapping table |
| D-5 | Vy reading notes for tasks: wait for the ADR-0037 addendum? | Yes: P5 and P6 do not need it and come first; P7 starts after the addendum is accepted | The owner's rule of 2026-11-03 needs its addendum and security review before a model reads a note |

Other risks:

- **Everything is visible to the team.** A project on a sensitive matter (a hire, a dispute) shows its tasks to every member. The create form warns; private projects wait for D-2.
- **Seats for teams.** Until each teammate has a seat, tasks can only go to the owner or to seats that exist. The hint in My work and on the project screen says how to fix it.
- **Tainted tasks.** A task proposed from a note or made from a customer's text is tainted; an agent's untainted run does not see it (ADR-0029). This is correct, and the card shows the mark.
- **List limits.** `kernel.task.list` stops at 200 tasks; the board gets its own read per project with its own limit and says when it is cut.
- **"Stuck" is approximate.** The task has no stamp for when its status changed; P5 uses `updated_at`, which any change moves.
- **Overlap.** CRM deals have their own board; Social and the agents create tasks too. A project shows only the tasks added to it, so the Tasks screen keeps the rest.

## 9. Build steps

One issue, one worktree, one PR each, end to end. Each step's acceptance says what Vy does on that screen or that it is plumbing, and that the core works with AI off. Proposed milestone M3 Paid pilot, priority P2, unless marked (decision D-1).

| # | Step | Scope | Acceptance | Files | Milestone, priority | Protected paths |
| --- | --- | --- | --- | --- | --- | --- |
| P0 | Invariants first | RLS matrix row factories for `crove_projects.project`, `project_member`, `project_task`, listed in `PENDING_TABLES` | CI green on `main` with the tables absent; the matrix names them pending | `apps/kernel/test/invariant/rls-matrix.db.test.ts` | M3, P2 | Yes (invariant suite) |
| P1 | Edit a task, and tell the person | `kernel.task.update` for people (title, description, due, seat), refused while an agent's run holds the task (`TASK_CHECKED_OUT`) and when the new seat cannot read the task's legal entity; a notification to the person holding the seat a task is given or moved to; edit on the task page | A member changes a task's due date and seat; the new holder gets a notification, as does the holder of a seat given a new task; an agent holding the task makes the edit fail with a clear message; an archived seat is refused; plumbing, no AI part | `packages/kernel/src/agents.ts`, `notifications.ts`, `apps/kernel/src/rpc.ts`, `apps/app/src/routes/tasks.tsx`, `apps/app/src/i18n/messages/{vi,en}.ts` | M3, P2 | No (kernel source outside the list; a reviewer checks the task change) |
| P2 | Projects and the board | `modules/projects` (manifest with column classes, permissions, `projects` in `AVAILABLE_MODULES`), migration `crove_projects` with the three tables, commands (create, update, set status, archive, members, owner, add and remove a task, create a task in a project through the kernel in one transaction), the board and list read, org purge and export, member removal; screens `/o/:slug/projects` and the project page with board and list | A solo owner creates a project, adds 5 tasks and drags one to Done with no setup; a member in another org reads nothing (matrix); an agent cannot write the tables; an entity-limited member sees the project but not another entity's task, and the board says one is hidden; the org purge removes the projects; with `projects` off nothing loads and tasks work; e2e: create, add, drag; AI part: none yet (P5 to P7) | `modules/projects/**` (with `package.json`), `supabase/migrations/<ts>_crove_projects_core.sql`, `<ts>_crove_kernel_org_purge_projects.sql`, `apps/kernel/src/config.ts`, `kernel.ts`, `apps/kernel/package.json`, `pnpm-lock.yaml`, `packages/kernel/src/offboarding.ts`, `apps/app/src/routes/projects.tsx`, `apps/app/src/router.tsx`, messages, `packages/db/src/generated/database.ts`, P0's pending entries removed | M3, P2 | Yes (migrations, `package.json`, lockfile, invariant suite) |
| P3 | My tasks across projects | The project chip and filter in My work; the project column and filter on the Tasks screen; the no-seat hint | A member sees their tasks of three projects in My work with each project's name and filters to one; plumbing, no AI part | `modules/notes/**` (`myWork`), `modules/projects/**`, `apps/app/src/routes/my-work.tsx`, `tasks.tsx`, messages | M3, P2 | No |
| P4 | Notes and to-dos linked to tasks and projects | `link` targets `kernel.task` (with `task_id` and its foreign key) and `projects.project`; the notes panel on the task and project pages; hand-over with a project | A private to-do linked to a task shows on the task page to its owner only; another member, an owner and an admin see no trace of it (database test); a shared note linked to a project shows to every member who can read it; a handed-over to-do lands in the chosen project; plumbing, no AI part | `modules/notes/**`, a `crove_notes` migration widening `target_type`, `modules/projects/**`, `apps/app/src/routes/projects.tsx`, `tasks.tsx`, `my-work.tsx` | M3, P2 | Yes (migration) |
| P5 | Late and stuck work on Home | `projects.today` (overdue, due today, and for project owners stuck tasks and tasks on vacant seats), `projects` in `TODAY_APPS`, the read in `TODAY_READS` | A member with an overdue task sees it on Home linked to the board; a project owner sees a task waiting with no change for 3 days; a viewer sees only what they can open; nothing is written; AI part: Vy's nudges, deterministic, no model | `modules/projects/**`, `packages/kernel-contract/src/today.ts`, `packages/kernel/src/today.ts`, messages | M3, P2 | No |
| P6 | Vy's weekly status | Counts and titles computed by code; Vy's sentences through `metered('projects.weekly_status')`; the numbers check; shown to the asker only | The text names only numbers that were in its input, or it is refused; it never reads a note; with AI off or out of budget the button says so and the counts still show; marked as AI text | `packages/agent/**`, `modules/projects/**`, `apps/app/src/routes/projects.tsx`, messages | M3, P2 | No |
| P7 | Tasks proposed from a note | Vy reads one note the member chose, in the member's own context (the #1677 addendum); proposals checked by code; batch confirm; tasks tainted and linked to the note; `metered('projects.tasks_from_note')` | A prompt-injection note cannot create a task, choose a seat outside the project's members' seats, or skip the member's click; a private note's text reaches the team only after the member confirms it; budgets and kill switches stop it; AI off leaves the note and the board complete | `packages/agent/**`, `modules/projects/**`, `modules/notes/**`, `apps/app/src/routes/notes.tsx`, messages | M3, P2; starts after the ADR-0037 addendum is accepted | Possibly (a definer if the addendum needs one) |
| P8 | Icebox items of section 7 | One P3 issue each, only when a real user asks or a milestone needs it | none | none | Icebox, P3 | n/a |

Dependencies: P0 before P2; P1 before P2's edit on the card; P3, P4 and P5 after P2; P6 after P2; P7 after P2, P4 and the addendum.
