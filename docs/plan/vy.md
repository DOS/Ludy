# Vy, the AI general manager: product and technical plan

> Draft plan, 2026-11-10, for the Platform line after the owner's decision of the same day: "Vy thuộc Platform nha" (Vy belongs to the Platform line). Not approved yet: the owner's questions are in section 8, and nothing in sections 5 and 6 is an issue until he answers. It builds on what ships today (section 3) and on two accepted records: [ADR-0029](../adr/0029-agents-positions-and-org-chart.md) (agents as org members) and [ADR-0049](../adr/0049-member-scoped-vy.md) (Vy working for one member). The gate it passes is [docs/product/scope.md](../product/scope.md); the products it borrows from are in the [AI-first reference study](../research/ai-first-reference-study.md). A Vietnamese summary for the owner is [vy.vi.md](vy.vi.md).

## 1. What Vy is to the user

- **One coworker, never an "assistant".** Vy is the general manager (tổng quản, key `gm`) across every app and Ludy Notes (DESIGN.md 1.1). The word "assistant" (trợ lý) appears in no copy. The app reads the name from the `{gm}` placeholder, filled from `packages/kernel-contract/src/coworkers.ts`, so an org that renames Vy changes one value.
- **Vy and the other coworkers.** DESIGN.md 1 and 1.1 say both things at once, and this plan keeps both: "A general manager (Vy) coordinates across every app; each app has its own coworker". Ly works in Ludy Kế toán (`finance`), Dy in Ludy Engage's Inbox and its customers and sales (`sales`), Uy in Ludy Engage's marketing, publishing and Ads (`marketing`); Hy (`system`) is reserved and shown nowhere. The copy rule decides who is named: "Copy names the coworker wherever it is the one acting, in its own area, and names the general manager for work that spans apps." So:
  - inside one app, the app's coworker acts and is named (Ly drafts the payment reminder, Dy drafts the reply, Uy drafts the campaign);
  - work that spans apps, and Ludy Notes, is Vy's (the Home list and brief, a question about the whole business, turning a note or a meeting into work for several apps, routing work to the right coworker).
- **One Vy, two modes** (ADR-0049). A user sees one Vy. What changes is whose rights Vy uses:
  - **company mode** (org mode): Vy works for the whole company as an org-chart agent under a position (ADR-0029). It reads nothing private (ADR-0037 decision N-6) and writes only what the agents' allowlist (#285) admits;
  - **member mode**: Vy works for one member, with exactly that member's access and never more, and what it finds in private data goes back to that member only.
- **What Vy never does.** It never posts money, sends a message or spends: a person approves (AGENTS.md). It never states a figure that code did not compute (the rule of `summaryNumbersOutside`, #1237). Every screen works with AI off or out of budget.

## 2. What the owner decided

| Date | Decision | Where |
|---|---|---|
| 2026-10-28 | The product is Ludy, the AI is Vy ([#1682](https://github.com/DOS/Ludy/issues/1682), [#1683](https://github.com/DOS/Ludy/issues/1683)). Notes decision N-6: AI reads a note only when its author asks; agents never read notes. | DESIGN.md decision records; ADR-0037 |
| 2026-10-31 | One-person companies and SMEs first; enterprise models wait. | scope.md |
| 2026-11-02 | AI-first for OPC and SME: "Vy proposes in place, a person approves, in batches where possible." The AI is a coworker, never an "assistant"; one coworker per area (Vy, Ly, Dy, Uy; Hy reserved), default names an org can rename ([#2409](https://github.com/DOS/Ludy/issues/2409), [#2410](https://github.com/DOS/Ludy/issues/2410)). | DESIGN.md 1, 1.1 |
| 2026-11-03 | Ludy CRM folds into Ludy Engage, so Dy covers the Inbox and customers and sales ([#2435](https://github.com/DOS/Ludy/issues/2435)). The member rule, in the owner's words on [#1677](https://github.com/DOS/Ludy/issues/1677): "Với những data riêng thì Vy chỉ trả lời cho user đó thôi chứ. Nôm na là data nào user có access thì Vy (của người đó) có." | DESIGN.md 1.1; ADR-0049 |
| 2026-11-04 | Vy's "brain" (model, member memory, org knowledge) sits behind provider ports; a hosted provider may supply it in Ludy Cloud, while Ludy keeps the permission boundary (ADR-0049 decision 9). Who may use Vy in member mode is the permission `vy.use`, set through preset roles, not a grid of single permissions: "Chứ cho 1 tỷ cái quyền rồi kêu set từng cái không được" (decision 10). The reference products are Odoo, MISA AMIS and Base.vn. | ADR-0049; scope.md 6 |
| 2026-11-10 | "Vy thuộc Platform nha": the Vy core and Vy's cross-app work belong to the Platform line (section 9). | this plan; to be logged in [docs/product-owner-config.md](../product-owner-config.md) |

## 3. What exists today

| What | Where | Mode | Use here |
|---|---|---|---|
| "Hôm nay cần bạn" on Home: one list across the apps, merged from each line's `<module>.today` read, run in the member's own transaction and role; nothing written | `packages/kernel/src/today.ts` (`TODAY_READS`), `packages/kernel-contract/src/today.ts`, `apps/app/src/components/today-list.tsx` ([#2383](https://github.com/DOS/Ludy/issues/2383)) | member's own request, no model | the base of the brief and the alerts |
| Vy's daily brief: up to 4 sentences from counts, amounts and due dates only, every sentence numbers-checked, a template when the model fails; `metered('today.brief')` on the `kernel` budget line; cached for the day in the tab's sessionStorage | `packages/agent/src/today.ts` (`TodayWriter`), `apps/kernel/src/today-brief.ts`, `apps/app/src/lib/today-brief.ts` (#2383) | member's own request, figures only | capability C1 |
| The brief by mail, opt-in per member, counts and a link only, no model | `packages/kernel/src/today-mail.ts` ([#2406](https://github.com/DOS/Ludy/issues/2406)) | system context, counts | C1, C5 |
| Lines' Home reads: `finance.today`, `crm.today`, `social.today`, `ads.today`, `kernel.conversation.today`; ads spend-pace flags | #2388, #2387, [#2378](https://github.com/DOS/Ludy/issues/2378) | deterministic | C4 |
| The numbers check for AI text | `packages/agent/src/summary.ts` (#1237), `overview.ts` (#2631) | | every capability |
| The AI budget meter: every call through `metered('<feature>')` under `withAiScope`, a key in `AI_FEATURES`; budgets per org, module and agent; four kill switches | `packages/agent/src/meter.ts` (#2382), `crove_kernel.kill_switch` (#886) | | every capability |
| Member mode, stage A: `kernel.member_vy.run.start`, `.result.store`, memory save, delete and list, meter doors, run cancellation; the `vy.use` permission | `packages/kernel/src/member-vy.ts` ([#2782](https://github.com/DOS/Ludy/issues/2782), [#2781](https://github.com/DOS/Ludy/issues/2781), #2755 closed) | member | C2, C3 |
| Member mode, stage B: the background context, its write catalog, the member-mode actor in the RLS matrix | #2797 to #2816 merged; [#2756](https://github.com/DOS/Ludy/issues/2756) open | member | C3, C5 |
| The clean-up that gates switching member mode on: audit allowlist, `member_vy_run_finish`, `MEMBER_VY_SINKS` and its ratchet ([#2945](https://github.com/DOS/Ludy/issues/2945), [#2941](https://github.com/DOS/Ludy/issues/2941)) | [#2822](https://github.com/DOS/Ludy/issues/2822), open | member | **the gate** |
| Provider ports: model, memory, knowledge, bound to one member; the built-in memory port; knowledge returns no passages (`noKnowledge`) | `packages/agent/src/member-vy/ports.ts`, `apps/kernel/src/member-vy-ports.ts` | member | C2 |
| Member-mode features declared: `notes.summary`, `notes.todo_suggest` (not built, [#1677](https://github.com/DOS/Ludy/issues/1677)), `meetings.transcribe` (#2860, off by default), `meetings.summary` (#2894, #2899, #2901) | `packages/agent/src/member-vy/features.ts`, `modules/meetings/src/summary.ts` | member | C3 |
| Tasks from other records: `kernel.task.create_from_todo`, `kernel.task.create_from_meeting` | `packages/kernel/src/agents.ts` | member's click | C3 |
| Org-chart agents: positions, tasks with leases, delegation inside the subtree, escalation to the nearest human, agent proposals (#260); templates `finance.chief_accountant` (Ly), `crm.scheduler` (Dy), `social.content_manager` (Uy), all deterministic programs; "the general manager is not a template agent" | ADR-0029, `packages/kernel/src/agents.ts`, `coworkers.ts`; model runner [#259](https://github.com/DOS/Ludy/issues/259) and schedules [#261](https://github.com/DOS/Ludy/issues/261) open | company | C6 |
| Projects (not built): Vy's late and stuck work ([#2596](https://github.com/DOS/Ludy/issues/2596)), weekly status ([#2597](https://github.com/DOS/Ludy/issues/2597)), tasks from a note ([#2598](https://github.com/DOS/Ludy/issues/2598)) | [projects.md](projects.md); the module is [#2591](https://github.com/DOS/Ludy/issues/2591) | | C3, C4, C5 |

What does not exist: any question-answering over the org's data, any retrieval index or embeddings, any cross-app rule that joins two apps' records, a general-manager position or template, and an inbound email module (finance's invoice mail route is the only inbound mail; [email.md](email.md) covers sending).

## 4. The scope gate

- **Fit.** The owner of a one-person company opens Ludy every morning to learn what needs them, and asks weekly "how is the business doing". Everything in phases 1 and 2 serves that; a team of agents managed by Vy (C6) mainly serves a larger org and comes last.
- **Smallest slice.** One person with the defaults and no setup: the brief, the alerts and the weekly status need no setting; member mode is on for the owner by default (`vy.use` on the owner role, ADR-0049 decision 10).
- **AI part, named.** Each capability below names what Vy reads, what it may write and how the review stays short.
- **Proportionate security.** No guard is weakened. Section 7 lists the three points that need a decision record before they are built.

## 4b. Two rules for every app, and how Vy runs on outside agent platforms (owner, 2026-11-10)

The owner set two rules for every module and app, with Vy as the example:

1. **Ludy is an OS: it runs on its own and is never locked to one paid third party.** Supabase is the model: open source, self-hostable, with a hosted option. Every outside service sits behind a port with a free or self-hosted default (AGENTS.md: `docker compose up` with no DOS service).
2. **Ludy is deeply integrated with the DOS ecosystem**: DOS ID, DOS.AI and DOS's own agents work out of the box when an org uses them.

For Vy this means:

- **One small runtime port, many adapters.** ADR-0029 decision 8 (runtimes are adapters) and ADR-0049 decision 9 (the provider ports) already split Vy's brain from the kernel. The plan keeps that split and makes it the only way in:
  - **Model calls**: one OpenAI-compatible chat port (`@crove/agent`, `AI_BASE_URL`), so OpenAI, Anthropic and Google (through their compatible endpoints or a thin adapter), a local model (Ollama, vLLM) and the DOS.AI gateway all work by configuration. No feature imports a vendor SDK (A8 already tests this).
  - **Outside agent platforms** (Claude Code, OpenAI Agents, Google agents, OpenClaw and the like): they drive Vy's org-chart position through MCP or the API with an `agent_grant` bound to `(org, client_id, agent_id)` (ADR-0029 §8). The kernel stays the source of truth: every write goes through `Runtime.execute`, the same risk tiers, approvals, budget and kill switches apply, and a member's private data reaches an outside runtime only in member mode and only what that member could read (ADR-0049).
  - **The smallest useful surface**: one MCP server per org exposing the same commands and queries the app uses, filtered by the grant. No second API.
- **A quick DOS option.** An org that uses DOS can pair Vy with a DOS agent (DOS Claw) in one step, for example a pairing code shown in Settings that the DOS agent enters, which creates the `agent_grant`. The pairing flow is generic (any MCP client can pair the same way); the DOS default only pre-fills the endpoint and the DOS ID sign-in. **Open question for the owner (Q7, Q8 below):** what DOS Claw is exactly, and whether its preset lives in the open core as an optional adapter or only in the private Cloud layer, as AGENTS.md says today for anything DOS-specific.
- **Tests that keep it honest**: a fake provider and a fake MCP client in CI; the stack must pass with no outside AI configured (AI off) and with only a local model.

## 5. Candidate capabilities

Mode follows ADR-0049: **member's request** means the member's own request context with no private input (no member-mode run needed); **member mode** means a `kernel.member_vy.run.*` run; **company mode** means an org-chart agent run. "Writes" never includes a posting, a send or a spend.

### C1. The morning brief across apps (partly exists)

- **Problem.** "What needs me today?" without opening four apps.
- **Exists.** The list, the brief and the mail of section 3 (#2383, #2406).
- **New.** (a) Name the acting coworker on each item, from the item's `app` through `COWORKER_BY_MODULE` ("Ly đã chuẩn bị 5 đề xuất"), Vy for the summary line; deterministic. (b) New lines join by registering their read: `projects.today` (#2596, projects line), a notes and meetings read ("Vy đã xong, chờ bạn xem", the recorder's own Home only, ADR-0047 section 3). (c) A "since yesterday" line: what the coworkers prepared overnight, counted from `activity.agent_id` (ADR-0029), figures only.
- **Reads.** The lines' Home reads in the member's context; the model sees figures only (as `briefAsk` does today), never a title or a name.
- **Writes.** Nothing. The brief is not stored server-side.
- **Budget and switches.** `today.brief`, `kernel` budget line, existing switches; template brief when off.
- **Depends on.** Nothing new for (a) and (c); the lines' reads for (b).
- **Reference.** QuickBooks' Finance agent and Digits' Reporting agent (study 2.6); Shopify's Pulse on Home (S-SP1); study recommendation 1.

### C2. "Ask Vy" over the member's own data, with citations (new)

- **Problem.** "Tháng này lãi bao nhiêu?", "Ai còn nợ mình?", "Việc nào trễ?" answered in a sentence instead of a report hunt.
- **Mode.** Member mode, read-only. The answer is the member's own and is never shown to anyone else.
- **Reads.** v1: a fixed list of **declared queries** run in the member's own context through the knowledge port (ADR-0049 decision 9): the finance overview figures (#2631), receivables and payables, overdue tasks, open deals by stage, unanswered conversations. Code picks the queries; the model never does (decision 5, "no tools, no query choice"). v2 adds text (notes, published meetings, conversations) and needs the ADR of section 7.
- **Writes.** None, apart from the member's own `member_vy_result` row if the answer is kept (30 days, decision 3). Every sentence carries citations: an in-app link (the `zTodayHref` rule) to the record or screen its figure came from. A sentence with a number not in the query results, or a citation to a record the member cannot open, is dropped.
- **Budget and switches.** New `AI_FEATURES` key `vy.ask`, `kernel` budget line, the four kill switches and the per-member rate limit of decision 6; refused with `AI_BUDGET_EXHAUSTED`, the palette search (#673) still works.
- **Depends on.** #2822 (the gate); a built-in knowledge port that runs declared queries; a question router that is code (palette entries or keyword rules), or the ADR-0049 addendum of section 7.
- **Reference.** Intuit Intelligence and MISA AVA's report search (study 2.5), Zeni showing its math, Day AI's citations; the study rated it "later" behind the brief, which this plan keeps.

### C3. A note, a meeting or a message turned into work, routed to the right app or coworker (partly exists)

- **Problem.** "Anh gửi báo giá trước thứ Sáu" said in a meeting or written in a note becomes a task, a quote draft or a payment reminder in the app where it is done, without retyping.
- **Exists.** Meetings action items to tasks (`kernel.task.create_from_meeting`, #2580 built behind the gate); notes to-do suggestions declared (`notes.todo_suggest`, #1677 open); projects tasks from a note (#2598 open).
- **New.** One Vy step across those sources: Vy reads one subject the member chose and returns suggestions, each tagged with its target: a task (for a person's seat or for a coworker's seat: Ly, Dy or Uy), or a draft in a line's app (a quote draft for Dy, a payment reminder for Ly). Code checks each suggestion (the seat exists and is active, the date parses, the party exists in the member's reach, no link or phone in a title).
- **Mode.** Member mode (the subject may be private).
- **Writes.** Suggestions in the member's own `member_vy_result` only. Accepting runs the target line's own command as the member, after the member sees the exact text, on `MEMBER_VY_SINKS` with `tainted` and a `source_ref` (decision 4). A task given to a coworker's seat then wakes that coworker in company mode, which works it and asks for anything risky through a proposal a person approves (ADR-0029 section 6). Never a `proposal` row from member mode (decision 2).
- **Budget and switches.** The source line's key (`notes.todo_suggest`, `meetings.summary`, `projects.tasks_from_note`); a new `vy.route` key only for the cross-app step.
- **Depends on.** #2822, #2941 and #2945 (sinks), #1677, #2598; each target line exposing a "create from a suggestion" command. Email waits: there is no inbound email module.
- **Reference.** Linear's Triage suggestions with "why" (study 2.2); Shopify's one approval of a plan (2.9).

### C4. Cross-app alerts: late, stuck, money at risk (partly exists)

- **Problem.** The owner learns of a problem from a customer. The cheapest valuable AI is the flag (study finding 8).
- **Exists.** Each app's own flags on Home (`finance.today`, ads spend pace #2378), and projects' late and stuck tasks to come (#2596).
- **New.** Rules that join two apps, deterministic, no model: a deal won with no sales invoice after 7 days; a customer with an overdue receivable who has an open quote or deal; a supplier whose bank account changed with a payment proposal waiting; a customer conversation unanswered past its reply window on an open deal. Each line exposes a small **signals read** per party (ids, dates, amounts; no text), and a kernel read composes them by the shared contact id, in the member's own context, so a rule fires only on records the member can open in both apps.
- **Mode.** Member's request, no model. **Writes.** Nothing; an item links to where it is acted on.
- **Budget.** None (no model). The wording is a message key, as `zTodayTitle` requires.
- **Depends on.** The shared contacts of Ludy Kế toán and Engage; each line's signals read (that line's issue).
- **Reference.** Xero's Bill Protection, MISA meInvoice's supplier risk flags (study 2.7).

### C5. The weekly status (partly exists, for one project)

- **Problem.** "Tuần này thế nào?" across money, customers and work, on Monday morning.
- **Exists.** Per project, for the asker (#2597, not built); the Social period summary (#1237) and digest mail (#1104); the finance overview sentence (#2631).
- **New.** A "Tuần này" card on Home: code computes the week's figures from the lines' reads in the member's context (cash in and out, new and overdue receivables, deals won, posts published, tasks done and late); Vy writes 3 to 5 sentences, numbers-checked; a template without AI.
- **Mode.** Member's request, figures only. A team digest by mail in company mode is left out of v1: it would have to be composed per recipient, in that recipient's rights, which needs a background run with no single subject (section 7, point 3).
- **Writes.** Nothing. **Budget.** New key `today.weekly`, `kernel` line.
- **Depends on.** Each line's week figures read; C1's composition.
- **Reference.** Digits' Reporting agent (2.6); the study's "numbers that tie to the books".

### C6. Delegation to Ly, Dy and Uy as org-chart agents (new)

- **Problem.** Work arrives that belongs to no app yet (an escalation, an unassigned task, a request from Home); someone has to route it.
- **Mode.** Company mode: Vy holds a general-manager position at the top of the chart, under the owner, with the coworkers' positions below it (ADR-0029 sections 1 and 4).
- **Reads.** Org-visible rows only (N-6): tasks of its subtree, escalations, unassigned tasks, the Home figures. No note, no member result.
- **Writes.** Tasks only: delegation to a position in its subtree, escalation to the nearest human; anything above R1 through `kernel.task.propose`, approved by a person (ADR-0029 section 6). Routing is deterministic first (the task's module, the record's app); a model is only for the wording of a hand-over comment.
- **Budget and switches.** Its own agent-scope budget and kill switch (ADR-0029 section 7), the daily run cap.
- **Depends on.** A `kernel.gm` template and position (today "the general manager is not a template agent", `coworkers.ts`); the model runner (#259) and schedules (#261); the ADR-0029 addendum of section 7.
- **Reference.** Paperclip's org chart (ADR-0029), Intercom Fin's procedures with approval steps and escalation on timeout (study 2.4).

## 6. Phases and slices

Ordered by value for an OPC owner. One issue per slice. Line: who builds it (section 9). Each issue's acceptance also says: the core works with AI off; every model call is metered; a person approves anything that posts, sends or spends.

**Phase 1: across the apps, no member mode** (can start now)

| # | Slice | Acceptance | Line |
|---|---|---|---|
| V1 | Log the 2026-11-10 decision and the boundary of section 9; label the Vy core issues `line:platform` (#2822, #2756, #2781, #2782 and #2803 already are) and give the rename [#1682](https://github.com/DOS/Ludy/issues/1682) to Frontend | `docs/product-owner-config.md` names Vy's core and cross-app work as Platform's; no line feature changes owner | Platform |
| V2 | The acting coworker named on each Home item (C1a) | An item from `finance.today` says Ly, from `crm.today` and conversations Dy, from `social.today` and `ads.today` Uy; the summary line says Vy; a renamed coworker shows the new name; no "assistant" in any string | Platform with Frontend |
| V3 | "Since yesterday": what the coworkers prepared (C1c) | Counts per coworker from `activity.agent_id` for the member's readable rows only; a viewer sees only what they can open; no model | Platform |
| V4 | The signals contract and the first cross-app rule: won deal with no invoice after 7 days (C4) | A kernel read composes `finance` and `crm` signals by contact id in the member's context; a member who cannot read finance gets no item; no text crosses; no model; the rule's days are a constant, not a setting | Platform (kernel read), Accounting and Engage (their signals reads) |
| V5 | Second and third rules: overdue receivable with an open deal; changed supplier bank account with a payment waiting (C4) | Each fires on a seeded case and not on its near miss; `block` severity for the bank-account case | same |
| V6 | "Tuần này" on Home (C5) | Figures computed by code; Vy's sentences pass the numbers check or the template shows; `metered('today.weekly')`; shown Monday to Wednesday, any day on request; nothing stored | Platform |

**Phase 2: member mode** (gate: **cannot ship until [#2822](https://github.com/DOS/Ludy/issues/2822) closes**; the line features #1677, #2598, #2580 are the lines' own)

| # | Slice | Acceptance | Line |
|---|---|---|---|
| V7 | The built-in knowledge port: declared queries in the member's context | The fake-provider test of decision 9 passes; a query outside the declared list fails a test; nothing a member cannot read reaches the port | Platform (protected: possibly) |
| V8 | Ask Vy v1: figures questions with citations (C2) | From the command palette; code routes the question to declared queries; every sentence cites an in-app link; a number not in the results drops the sentence; red-team questions ("show me B's notes", "ignore the rules") produce no other member's data and no write; `vy.use` off hides it and the server refuses; budget and four switches stop it | Platform |
| V9 | One "Vy, chuyển thành việc" step across notes, meetings and messages (C3) | Suggestions land in the member's own result; each target is a line's command on `MEMBER_VY_SINKS`; a private note's words reach a task only after the member confirms the exact text; an injected "giao cho Ly chuyển tiền" stays a flagged suggestion | Platform (the step), each line (its target command) |

**Phase 3: company mode and text retrieval** (each after its record in section 7 is accepted)

| # | Slice | Acceptance | Line |
|---|---|---|---|
| V10 | ADR-0029 addendum: Vy's general-manager position and template | Accepted by the Platform PO, with the owner's answer to Q4 | Platform |
| V11 | Vy routes unassigned and escalated work to Ly, Dy and Uy (C6) | Delegation only inside its subtree; escalation to a human; never reads a note; its kill switch stops it at once; the R0 to R3 matrix unchanged | Platform |
| V12 | ADR-0051 (proposed): retrieval over text, then Ask Vy v2 | Section 7, point 1 | Platform |

## 7. Security and privacy

**The ADR-0049 guarantees every member-mode slice keeps** (none is reopened here):

- Vy in member mode has the member's rights and never more, in the database and in the runtime (decision 1); it ends with the member, on removal, a disable, sign-out everywhere, or loss of `vy.use`.
- `vy.use` switches member mode on or off; it never widens what Vy reads (decision 10).
- Results and memory are the member's alone (`member_vy_result`, `member_vy_memory`), 30 days for results; no owner or admin reads them (decision 3).
- Private output reaches an org-visible place only through the member's own command, after a click, with the exact text on screen, tainted and with a `source_ref`; the commands that do so are on `MEMBER_VY_SINKS` (decision 4). `private_read` is computed by the kernel and never cleared.
- Every sink the write guard does not see is closed: activity, audit detail, outbox, notifications and mail carry ids and fixed words only (decision 4).
- The model has no tools and no query choice; its output is data; links show as plain text; nothing applies without a click (decision 5). Red-team cases run in CI with a fake model.
- Memory is written only by the member's click, never from model output (decision 3).
- Every call is metered; the org's, the module's and the agent's kill switches and the operator's global switch are checked at start and at each admit (decision 6).
- Retrieval is filtered by the member's rights before anything reaches a provider; a provider must be able to forget (decision 9).

For company mode (C6), ADR-0029 and N-6 hold: no private read, the write allowlist, proposals for anything above R1, humans for R3 and P03 to P07.

**What needs a new record, flagged:**

1. **Retrieval over text, indexes and embeddings (C2 v2): a new ADR (ADR-0051, proposed).** ADR-0049 allows "a richer index" only "still reading only through declared queries", and decision 3 keeps results out of every search index in v1. An embedding index is a derived copy of text, private notes included, so the ADR must answer: one index per member or a shared one filtered at query time (the first holds the line by structure, the second by a filter that can be skipped); how a row the member can no longer read (a note made private, a narrowed `le_scope`) leaves the index at once; forgetting on removal, erasure (#923), the org purge and the 30-day purge; whether vectors count as `pii`; whether a hosted provider may hold the index (decision 9 says only text the member could read, for that member); and the `private_read` flag for passages. Recommended v1: no index over private text; lexical search through declared queries.
2. **A question router (C2): an addendum to ADR-0049, or none.** If the model picks which declared queries answer a question, that is the "query choice" decision 5 forbids. Either the router is code (recommended for v1) or an addendum says a model may choose among a fixed, member-scoped list, with its own red-team cases.
3. **Background composition without one subject (C5 by mail, any scheduled member-mode brief): an addendum to ADR-0049.** Decision 1 says "a run is for one feature and one subject"; a weekly mail written in each recipient's rights is neither. Until then the weekly status is on Home only and the mail stays counts and a link.
4. **Vy as an org-chart agent with cross-module reads (C6): an addendum to ADR-0029.** A general-manager template whose role key reads several modules, its place at the root, how it is installed for an owner-only org, and how it runs with a model (#259) without tools beyond the task commands. An agentic Vy that calls commands needs its own ADR (ADR-0049 "Revisit when").

C1, C3 and C4 need no new record: C1 and C4 read in the member's own request and C1 sends figures only; C3 uses the sinks mechanism as built.

## 8. Open questions for the owner

| # | Decision | Recommended | Why | Without an answer |
|---|---|---|---|---|
| Q1 | Order: phase 1 (no member mode) before Ask Vy? | Yes | Phase 1 needs no gate and serves every owner every morning | Platform builds phase 1 only |
| Q2 | Ask Vy v1: figure questions over fixed reads, without search over notes and meetings? | Yes | It is safe now and answers the questions owners ask most (study finding 13: reporting) | V8 waits |
| Q3 | An index or embeddings over private notes and meetings, ever? | Not in v1; shared data first, private text only after ADR-0051 | Private text in an index is the largest new exposure | No index is built |
| Q4 | Vy as an AI general manager in the org chart above Ly, Dy and Uy, now or after the pilot? | After the pilot | A one-person company does not need routing between AI coworkers yet | Phase 3 stays in the Icebox |
| Q5 | The weekly status: on Home only, or also by mail with figures? | Home only; the mail keeps counts and a link | Figures in a mail leave Ludy and need per-recipient rights | Home only |
| Q6 | On Home, name the app's coworker on each item (Ly, Dy, Uy) and Vy on the summary? | Yes | It follows DESIGN.md 1.1's copy rule | Every item stays unnamed |
- **Q7.** What exactly is DOS Claw, and how should it pair with Vy (a pairing code in Settings, DOS ID sign-in, or something else)? Proposed: a pairing code, the same flow for every MCP client, with a DOS preset.
- **Q8.** Does the DOS preset (DOS Claw, DOS.AI pre-filled) live in the open core as an optional adapter that is off by default, or only in the private Cloud layer, as AGENTS.md says today for anything DOS-specific? Proposed: the open core, off by default, so self-hosters can pair with DOS too.

## 9. Line ownership

Owner decision 2026-11-10: "Vy thuộc Platform nha". The boundary, following "a line's own feature stays with that line" ([docs/product-owner-config.md](../product-owner-config.md)):

- **Platform owns the Vy core:** the member-mode mechanism (`packages/kernel/src/member-vy.ts`, `packages/agent/src/member-vy/**`, the ports and their built-in implementations, `MEMBER_VY_SINKS`, `vy.use`); the meter and kill switches as they touch Vy; the general-manager agent (C6) and its ADR-0029 addendum; the ADRs of section 7.
- **Platform owns Vy's cross-app work:** the Home composition (`kernel.today`, `TODAY_READS`), the brief (`today.brief`), the brief mail, the signals composition (C4), the weekly status across apps (C5), Ask Vy (C2) and the routing step of C3.
- **Each line keeps its features inside its app**, Vy-powered or not: its `<module>.today` and signals reads; Notes N8 ([#1677](https://github.com/DOS/Ludy/issues/1677), Notes & CRM); meetings transcription and summary ([#2578](https://github.com/DOS/Ludy/issues/2578), [#2580](https://github.com/DOS/Ludy/issues/2580), [#2941](https://github.com/DOS/Ludy/issues/2941), Meetings); projects P5 to P7 ([#2596](https://github.com/DOS/Ludy/issues/2596), [#2597](https://github.com/DOS/Ludy/issues/2597), [#2598](https://github.com/DOS/Ludy/issues/2598), the line that owns projects); the coworkers' own work (Ly in Accounting, for example [#2376](https://github.com/DOS/Ludy/issues/2376), whose copy should name Ly; Dy and Uy in Engage).
- **Frontend** owns how Vy looks on every screen (Home, the palette, the "Đề xuất" style) and the rename issue [#1682](https://github.com/DOS/Ludy/issues/1682).
- A line feature that needs a new member-mode feature key, sink or port asks Platform for the shared-core review of those files, as for any shared-core change.

## 10. Risks

- **Ask Vy over-promises.** A chat box over unchanged screens is the trap the study names (3.3). Mitigation: Ask Vy is the second door; the brief, the alerts and the in-screen work come first.
- **Hallucinated figures.** Mitigation: code computes every figure; every text passes the numbers check or is dropped (#1237, `today.ts`).
- **Leaks through composition.** A cross-app item or answer could combine what a member reads in one app with what they cannot read in another. Mitigation: every read runs in the member's own context, and an item needs both sides readable.
- **The gate slips.** Phase 2 waits on #2822. Mitigation: phase 1 does not depend on it.
- **Cost.** Mitigation: the brief is cached for the day; alerts use no model; Ask Vy is rate-limited per member.
