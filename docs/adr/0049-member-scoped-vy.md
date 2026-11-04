# 0049. The member-scoped Vy: an AI coworker that acts for one member and sees what that member sees

- Status: Proposed (2026-11-04). The rule it carries is the owner's, decided 2026-11-03 on [#1677](https://github.com/DOS/Ludy/issues/1677) and [#1648](https://github.com/DOS/Ludy/issues/1648); the mechanism below waits for the Platform PO's security review. Nothing is built until it is Accepted.
- Date: 2026-11-04
- Deciders: owner (JOY) for the rule; the Platform PO for the mechanism
- Builds on: ADR-0037 (private notes, its decision N-6 and its "Revisit when"); ADR-0029 (agents, positions, the write allowlist #285); ADR-0018 (untrusted content); ADR-0028 section 9 (the sealed user context); the AI budget meter (#2382) and the kill switches (#886); the data classes (#1599), audit markers (#1626) and personal-data registry (#923)
- Issue: [#1677](https://github.com/DOS/Ludy/issues/1677) (notes step N8); epic [#1648](https://github.com/DOS/Ludy/issues/1648)
- Addendum to: [ADR-0037](0037-private-notes-and-todos.md), which says here only that this ADR exists; its text changes when this one is Accepted
- Reused by: the meetings plan (PR [#2554](https://github.com/DOS/Ludy/pull/2554), ADR-0047, transcription runs as the member's Vy) and the projects plan (PR [#2556](https://github.com/DOS/Ludy/pull/2556), ADR-0048, step P7). They name this mechanism and wait for it. It is general on purpose: notes N8 is its first use, not its only one.

## Context and problem statement

ADR-0037 made a private note readable by its author only, and its decision N-6 (owner, 2026-10-28) said AI reads a note only when the author asks, one note at a time, and that agents never read notes. On 2026-11-03 the owner went further, in his words: "Với những data riêng thì Vy chỉ trả lời cho user đó thôi chứ. Nôm na là data nào user có access thì Vy (của người đó) có."

So there are two kinds of AI work in Ludy, and they must not blur:

- **Vy for the org** (the org-chart agents of ADR-0029, among them the general manager Vy): works for the org, in an agent context under a position. Writes into the org's tables, drafts the team's brief, prepares proposals other people approve. Keeps N-6: it reads no private data.
- **Vy for one member** (this ADR): works for one member, with exactly that member's rights, and whatever it finds in private data goes back to that member only. Its memory and its results belong to that member.

What has to be decided is how the second kind is built so that it is never more than the member, never leaks into org-wide outputs, and cannot be turned into a way around the guards the first kind lives under. The seven points the Platform PO set on #1677 (comment "Plan for N8, agreed with the Platform PO on 2026-11-03") are decisions 1 to 7 below, in order.

## Decision drivers

- The owner's rule, word for word: a member's Vy has what the member has, and no more; private answers go to that member alone; org-wide work reads nothing private.
- The core works with AI off; every model call goes through the AI budget meter; a person approves money, messages and spend (AGENTS.md, scope gate).
- AI output is tainted and deterministic checks decide (AGENTS.md). Note and transcript text is untrusted (ADR-0018), and in a firm a note holds facts about clients and their staff.
- Fail closed: everything a guard refuses an agent today stays refused. A new capability is a narrow, listed, tested admit, never a blanket exception.
- Smallest slice: a one-person company has one member and one Vy, with nothing to set up.
- One write path, tenancy, the sealed context and the agents' allowlist (#285) keep their meaning for the org's agents.

## Decision

### 0. One mechanism, two ways in, built in two stages

A member's Vy runs in one of two ways, and everything else in this ADR is the same for both.

- **Interactive run.** The member clicks (summarize this note). The API handles it in the member's own request context: a sealed user context, session-checked as for any request. No new kind of context is entered. The run is recorded (decision 1) and its model call is metered as the member's Vy.
- **Background run.** The member starts work that outlasts the request (transcribe this meeting). The worker enters a member-scoped agent context (decision 1) for that one run. The worker's system context is never used: by ADR-0037 it reads no private text.

Notes N8 needs only the interactive way: one model call, answered in the request, no job. So the work lands in two stages, each with its own invariant step first (decision 7):
- **Stage A, for N8:** the `member_vy` agent row and the run record (`ai_run`, with the private-read flag), taint, the member-keyed result and memory tables, the budget scope. No change to the notes policies, no change to the org-chart agents' allowlist, no new context entry.
- **Stage B, for meetings and for any later job:** the member-scoped agent kind, its context entry, its write allowlist, and the explicit admit of that kind in the policies of the tables that opt in (notes first).

The ADR-0037 plan (notes.md section 3.11) expected a definer through which the worker reads "the one note the author asked about". With this design none is needed: the author's own context reads the note through the ordinary policy.

### 1. Run context: the member's, never the system's, ending with the member

- **Interactive:** the member's user context. Every command the run causes carries the run in its audit detail, so the audit row shows the member and the Vy run beside it.
- **Background:** `crove_kernel.enter_member_vy_context(org, agent, run)`, worker login only (EXECUTE and `session_user`), the pattern of `enter_agent_context`. It refuses unless all of these hold, each re-read in the transaction that enters:
  - the org is active; the run is `running` and not expired; the agent is active and of kind `member_vy` (an org-chart agent is refused here, and a `member_vy` agent is refused by `enter_agent_context`);
  - the member the agent is bound to is a member of the org now (the same test `enter_context` applies, shared in one function, so the two cannot drift). A member removed, or disabled once the kernel has that state, ends the run: the next transaction fails with `MEMBER_NOT_ACTIVE`, so even a run in the middle of work cannot write another row; a model call already in flight finishes, but its result is discarded because storing it needs a new context entry. The `kernel.member.removed` subscriber also cancels the member's live runs;
  - no kill switch covers the org, the feature's module or the agent; no hard-stop budget is spent.
- **Rights, never broader.** The sealed context carries the member's role and the member's `le_scope`, computed by the same function as `enter_context`, so an entity-limited member's Vy sees only those entities. It carries `max_risk` R1 at most (the lower of the agent's and the feature's); never R2 or R3, never an approval, never a proposal.
- **The shape.** The context is an agent context (`actor: 'agent'`) with two added fields: `member` (the user the run acts for) and `kind` (`member_vy`). `ctx_user_id()` stays NULL, so every policy written as `... = ctx_user_id()` (private notes, to-dos, saved views, notifications) refuses it by default. A table that wants to admit the member's Vy opts in by reading a new helper, `ctx_acting_user_id()` (the context's user for a member, the `member` field for a member-scoped agent, NULL for everything else). Why not a user context with a `via` marker: every guard written for agents (the write allowlist, `refuse_agent_write`, P02, P03, P05, P06) and every one written for users would need an exception, and one forgotten fails open. Here an unlisted table or command fails closed, as for every agent today. This is the point of the design most worth the reviewer's attention (section "Open for review", item 1).
- **A run is for one feature and one subject.** `kernel.vy.run.start` (R1, the member's own command in the member's own session) records the feature key, the subject (a type and an id) and an expiry set by the feature (at most 30 minutes for a note, longer for a meeting by its own declaration). One run per member at a time (the existing one-running-run index). The job carries ids, never text.
- **The ceiling is the database's; the narrowing is code's.** The database holds the run to the member's rights. That a run reads only its subject (one note, one meeting and its attendees' names) is the feature's declared `reads`, kept by the feature's code, and a test per feature fails when a query outside it appears. The model cannot widen it, because it has no tools (decision 5).

### 2. Two agent kinds, and the allowlist is no back door

- `crove_kernel.agent` gets `kind` (`org_chart`, the default, or `member_vy`) and `member_user_id`, set exactly when the kind is `member_vy`, one per `(org_id, member_user_id)`, made on the member's first run by the same command that starts it. It has no position and no org-chart place. Its template is a fixed one (`member_vy`) with no role key: its permissions come from the member, not from a role. It is named `member_vy`, not `member_assistant`: Ludy's AI is a coworker (AGENTS.md).
- **The org-chart agents change nothing.** Their allowlist (#285), their exempt list and their write rules stay byte for byte; `enter_agent_context` refuses a `member_vy` agent.
- **The member's Vy has its own allowlist**, a catalog `crove_kernel.member_vy_table` (one row per table, added only by a migration, so each addition is a protected-path PR with a security review). The write guard (`agent_write_guard`) takes a second branch for `kind = 'member_vy'`: a write passes only if the table is in the catalog and the row passes its own restrictive policy (the row belongs to the member). The catalog starts with:
  - `crove_kernel.vy_result` and `crove_kernel.vy_memory` (decision 3), the member's own rows only;
  - the audit, idempotency and outbox rows the runtime writes for any agent, under the same narrow rules as today (this run's, this agent's, insert only);
  - `ai_run`: taint and private-read on its own run, false to true only, as for any agent.
  The meetings plan adds its result tables in its own migration (stage B), each with a policy that the member recorded the meeting.
- **Never in the catalog:** `task`, `task_comment`, `proposal`, any table another member or an org-chart agent reads, and the tables `refuse_agent_write` names. `task` and `task_comment` carry no guard (their own lease rules) but need a lease on a position, which a `member_vy` agent has none of, so they refuse it; a test pins that.
- **Commands.** A command or query is open to a member's Vy only when it declares `memberVy: { reads?, taint }` (a third access kind beside `access` and `agent`), R0 or R1, with taint `propagate`. None of the task commands, none of the approval commands and no other module's command declares it. The runtime's rule P03 applies as it does to agents: a tainted run runs only commands that propagate taint.
- **Result.** The invariant "agents write only the allowlist" is kept for the org's agents, and a second invariant says the same for the member's Vy, with its own list. Neither list can grow without a migration.

### 3. Memory and results: tables keyed by member, sealed to that member

- **`crove_kernel.vy_result`:** one row per finished run that has something to show: `org_id`, `id`, `member_user_id`, `run_id`, `feature`, `subject_type`, `subject_id`, `source_revision` (so the screen can say the note changed since), `body` (the text, class `pii`), `tainted` (always true until the member acts), `private_read` (decision 4), `created_at`, `expires_at` (30 days).
- **`crove_kernel.vy_memory`:** what Vy keeps about the member so it is useful: in v1 only entries the member made or confirmed, such as a preference ("tóm tắt ngắn", how they like a client named). Each entry shows in a screen "Vy nhớ gì về tôi" and the member edits or deletes it. Vy writes nothing into memory on its own from a note or a meeting: a model's output never becomes memory without the member's click, so a note cannot plant a memory. Memory that is later derived from private text is a later decision with its own review.
- **Keys and tenancy.** `PRIMARY KEY (org_id, id)`, `org_id`, RLS through `apply_tenant_rls`, and restrictive policies in the style of ADR-0037 (each context function wrapped in a subquery): read and write only where `member_user_id = ctx_acting_user_id()`. No owner, admin, other member, viewer, org-chart agent or system context reads or writes a row. No foreign key to `tenant_member`, so a removed member's rows follow the same 30 days as their private notes (below).
- **The worker and the definers.** As in ADR-0037 the worker reaches these rows only through named definers that return no text: `vy_results_expire(limit)` (deletes what is past `expires_at`), `vy_member_data_purge(org, user)` and `vy_private_counts()` for the owner's removal warning.
- **Member removed.** The module-independent `kernel.member.removed` subscriber schedules the purge 30 days later, with the same rule as `notes.member_items.purge` (counted from the removal's audit row, never purges a member who is back, fails closed with no date), so a member's notes, results and memory go on the same day. Live runs are cancelled at once.
- **Source deleted.** A result whose source note is deleted, purged or erased is deleted with it (by `subject_id`). A note is never kept alive by its summary.
- **Org purge and export.** The org purge deletes both tables (a migration, before the kernel's tasks as notes' tables are). The export (#38) holds no row of either, only a count per member, as ADR-0037 decision N-5 does for private items. Each member downloads their own results and memory with their notes ("Tải về").
- **Personal data (#923).** `body` and memory text are `pii` in the manifest and the registry. The finder counts per member as for private items and never shows text. An erasure (R3, owner) deletes the results whose source it erased, and the others that match the value, without showing them, after the members were told, as `private_erase` does.
- **Audit and logs.** Audit rows carry markers, never text (`auditValue`, #1626). The meter gets ids, the feature key and token counts, as it does today. No prompt, no answer and no note text in a log, an error message, an idempotency result or an outbox event.
- **The operator.** As ADR-0037 says for notes, "private" means private from the org. The text a member's Vy reads is also sent to the AI endpoint the deployment is configured with (decision D9); the button says so, and a self-hosted deployment can point it at a local model.

### 4. Org-wide outputs carry nothing private: a flag that blocks, plus a structure that cannot read

A rule in a prompt is not enough, so there are three layers, none of them a prompt.

1. **The structure.** `vy_result` and `vy_memory` are readable by the member alone (decision 3), and the member's Vy writes only the catalog (decision 2). So the org's briefs, digests, proposals other people approve and everything an org-chart agent or the system composes cannot even read what a member's Vy produced. The daily brief for a team, an agent's proposal and a notification have no path to a result, whatever their code says.
2. **The flag.** Each run carries `private_read`, set by the code the moment a private source enters its input (a private note, a to-do, a private meeting; a source's visibility is read from the row, and when it is unknown the flag is set). It is stored on `ai_run` (false to true only, never cleared) and copied to each result. The meter's scope carries it too. A result with `private_read` is the member's own and never leaves: the only way its text reaches an org-visible sink is the member's own command, after a click, with the exact text on screen (the rule of hand-over in ADR-0037 and notes plan section 3.5). That command takes the result's id, reads it in the member's own context (so another member cannot name it), refuses unless `confirmed: true`, and creates the row `tainted` with a `source_ref` while the text is unedited. A command with an org-visible sink that takes text from a result is on a list (`MEMBER_VY_SINKS`); a test enumerates the commands whose input names a result and fails for one not on it.
3. **The types and the dependency rule.** The readers that return private text return a branded type (`PrivateText`). The org-level features in `packages/agent` accept plain strings only, and a static test (the pattern of `meter-coverage.test.ts`) fails when one of them imports a reader of `memberVy`.

Blocked sinks, for a result of a run with `private_read`: an org-visible table, an outbox event payload, an activity, a notification or a mail (they carry ids and fixed words anyway), a kernel proposal (read by the approvers), a task or a task comment except through the confirm command above, and the input of an org-chart agent run.

### 5. Prompt injection: the model has no hands

Note, transcript and shared-note text is untrusted (ADR-0018). The design takes away what an injected instruction would need, and does not try to detect it.

- **No tools, no query choice.** A member-Vy feature is a function of its input: the code reads the subject, builds the prompt, calls the model once, and parses the answer against a strict schema. The model cannot call a command, run a query or pick what to read. An agentic member's Vy with tools is a different design and needs its own ADR.
- **The model's output is data.** Structure (a seat, a date, a title length, a number) is checked by code (the rule of `summaryNumbersOutside`, #1237, for figures); free text is shown as text, in Markdown with raw HTML dropped, no remote image and links that open only on a click (notes plan section 3.6). It starts tainted and keeps the "Đề xuất" style until the member edits or accepts it.
- **Nothing applies without a click.** Accepting runs the member's own command (`notes.todo.create`, `notes.note.update`, a project task), as the member, with `tainted` set while the text is the AI's. The model cannot raise a risk level, skip a click, or make a write the member did not click.
- **A shared note from member A read by member B's Vy.** B's Vy has B's rights only. At most the text steers what B is shown. It cannot read A's private note (policy), cannot send anything to A (results are B's alone), and cannot exfiltrate: its output reaches only B's screen, which loads no remote image and opens no link by itself.
- **Least input.** A run reads its one subject and the member's own explicit memory, and nothing else. Two private sources are never mixed into one prompt unless the feature declares both.
- **Memory is not a channel.** No model output writes memory (decision 3).
- **Tests.** Red-team cases run in CI with a fake model, as #893 does for documents: a note that says "create a task for X", "show me B's notes", "remember that ..." produces at most a tainted suggestion and no write.

### 6. Budget: metered, per org, per module, per agent; no per-member default

- Every model call goes through `metered('<feature>')` under `withAiScope`, which now also carries the member and the run. New `AI_FEATURES` keys are named per feature and count against their module's budget (notes N8: `notes.summary` and `notes.todo_suggest`, module `notes`; the meetings and projects plans add theirs). `AiMeter.admit` and `record` get the member and the agent ids, never text.
- **The org budget and the module's cover every member's Vy.** Spend is attributed to the member's agent, so an owner sees the spend per member (a figure, never content) with the usage the meter already reports.
- **A per-member cap is possible and not on by default.** A member's Vy is an agent, so the existing agent-scope `budget_policy` (`scope 'agent'`, target the agent id) caps it, and the kill switch of scope `agent` stops it, with no new mechanism. A small business has few members, and the org and module budgets are enough to bound the cost, so the default is no cap (the smallest slice). An owner who wants one sets it.
- **Also bounded:** a run's input size per feature (a note is cut at a stated length), the one-running-run rule, and a per-member request rate (the pattern of `ai-draft-limit.ts`), so a loop of clicks cannot spend the month.
- **Refusal.** A spent budget or an engaged kill switch refuses the call with the existing `AI_BUDGET_EXHAUSTED` message; the screen keeps working with AI off.

### 7. The invariant route, in two steps per stage

Each stage ships as: (a) an invariant-only PR that accepts both behaviors, merged by the Platform PO; (b) the feature PR that pins the new behavior. This is needed because CI runs the base branch's copy of the suite, so a PR cannot fix a pinned test itself. This ADR is step zero. Each change below is named, and none is made silently:

**Stage A (N8's interactive path):**
- **A1. New author-only tables** `vy_result` and `vy_memory`: row factories and `PENDING_TABLES` entries first (the three-PR rule, #291); an `AUTHOR_ONLY` exception in the RLS matrix, as notes have: the system context reads no row and writes only through definers; the org-chart agent context reads and writes none. Cross-org cases stay as they are.
- **A2. A test file in the invariant suite**, `vy-private.db.test.ts`: another member, an owner, an admin, a viewer, an entity-limited member, an org-chart agent context and the system context read and write none; the definers return no text and refuse every other login; a forged context is refused by the seal.
- **A3. The registry, purge and export checks** (`personal-data`, `org-purge-coverage`, offboarding): the two tables are classified, deleted by the org purge and left out of the export except as a count.
- **A4. Metering:** the meter-coverage test accepts the new feature keys and the member and run fields in the scope.
- **A5. The `member_vy` agent row.** `agent.kind` and `member_user_id` exist from stage A, so `enter_agent_context` must refuse a `member_vy` agent from the day the first one exists (a test), and the org chart, the agent lists and the budget screens leave `member_vy` agents out of the org's positions and counts. The org-chart agents' tests stay as they are.
- **No change** to `notes-private.db.test.ts`, the agents' allowlist or any notes policy in stage A.

**Stage B (background runs):**
- **B1. ADR-0037 decision N-6 is revised on purpose.** "Agent contexts read and write nothing" becomes "an org-chart agent context reads and writes nothing; a `member_vy` context reads what its own member could, for a table that opted in". This is the one weakening of an accepted invariant, and it is the owner's rule of 2026-11-03. `notes-private.db.test.ts` keeps every existing case and adds: a `member_vy` context reads only its own member's notes (own private, shared per the member's role and scope), never another member's private note, never as the system, never writes a note.
- **B2. The agents' invariant** keeps its allowlist unchanged and gains: `enter_agent_context` refuses a `member_vy` agent and the other way round; the member's Vy writes only the catalog and only its member's rows; it cannot write `task`, `task_comment`, `proposal` or any table off the catalog; its `max_risk` is R1; the run ends when the member is removed, a kill switch engages or the budget is spent.
- **B3. The sealed context** (`context.db.test.ts`, `context-token.db.test.ts`): the `member` and `kind` fields are inside the seal and a forged one is refused; `ctx_user_id()` is NULL for a member-scoped agent; `ctx_acting_user_id()` is as described.
- **B4. The opt-in list:** a test lists the policies that read `ctx_acting_user_id()` and fails for one not named in this ADR's catalog or a later ADR, so no table opts in silently.
- **B5. The RLS matrix** adds the member-scoped agent as an actor with its reasoned exceptions.

**Not changed, and if it must change it goes back to the owner:** no system-context read of private text; no read by an owner or admin of a member's results or memory; no R2 or R3 and no approval by a member's Vy; no org-chart agent reading a note; no model with tools; no result text in an org-visible sink without the member's click.

## Options considered

**For where a member's Vy runs**
- **A. The member's own context for a request, and a member-scoped agent context for a job (recommended).** Fails closed, one allowlist per kind, no definer to read a note.
- **B. A user context with a `via` marker for both.** The Platform PO's first reading of point 1. Rejected for the reason in decision 1: every user guard and every agent guard would need an exception, and a forgotten one fails open. Kept as the fallback if the reviewer judges the agent shape too far from "the member as actor".
- **C. The worker's system context with a definer per read.** Rejected by the owner's rule and ADR-0037: the system context would read every member's private text through a growing list of definers.
- **D. One org-chart Vy that checks the asker's rights in code.** Rejected: a check in code is the thing a prompt injection or a bug skips; the database must hold the line, and the org-chart Vy keeps N-6.

**For the budget**
- **A. Org and module budgets, a per-member cap optional (recommended).** **B. A per-member cap by default.** Rejected for v1: setup a one-person company does not need. **C. No attribution per member.** Rejected: the owner should see where the spend goes.

## Consequences

- Good: the owner's rule is enforced by the database and tested in the invariant suite, not by a prompt; the org-chart agents' allowlist and ADR-0029 are untouched; N8 needs no new notes definer; meetings and projects reuse one mechanism, built once.
- Good: a one-person company has one Vy per member from the first click and sets up nothing.
- Bad: two new kernel tables, a context entry function, a catalog and a guard branch: each a protected-path change with its own security review, in two stages.
- Bad: stage B weakens one accepted invariant (N-6) on purpose; the reviewer's judgment, and the owner's rule, carry it.
- Bad: the narrowing of a run to its subject is code, not database, so each feature needs its test.
- Neutral: private text is sent to the deployment's AI endpoint; the operator can read the database as before.

## Open for review (the Platform PO)

1. **Agent shape or user shape** (decision 1, options A and B). This ADR picks an agent context bound to a member because it fails closed; the Platform PO's first wording was a user context with the agent recorded beside it. Which does the review accept?
2. **Where `ctx_acting_user_id()` is read.** The ADR admits it only in tables that opt in by name, listed by a test (B4). Is a catalog table or a naming convention the better way to list them?
3. **The 30-day purge shared with notes** (decision 3) and the `private_read` default of "set when unknown": any reason to change either?
4. **Names:** `member_vy` as the kind, `vy_result` and `vy_memory` as the tables.

## Revisit when

- A feature needs a member's Vy to call commands on its own (an agentic member's Vy). It needs its own ADR: tools, per-command approval and a different taint rule.
- Memory is to be derived from private text, not only from the member's own entries.
- The owner asks for a per-member cap by default, or for break-glass access to a member's results (ADR-0037 option C).
- Teams exist, so a result may be shared with a team.
