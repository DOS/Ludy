# Vy, the AI general manager: product and technical plan

> **Updated 2026-11-10 by [ADR-0051](../adr/0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md): Vy's agent brain is a DOS Claw agent on work.dos.ai, not built in Ludy.** Ludy is the gate and the source of truth: an MCP endpoint, the deterministic signal rules and a signed webhook. Sections 4b, 4c, 5 (C2, C6), 6 (phases 2 and 3), 7 and 8 (Q7, Q8) below say what that changes; where this plan and the ADR differ, the ADR wins.
>
> Draft plan, 2026-11-10, for the Platform line after the owner's decision of the same day: "Vy thuộc Platform nha" (Vy belongs to the Platform line). Not approved yet: the owner's questions are in section 8, and nothing in sections 5 and 6 is an issue until he answers. It builds on what ships today (section 3) and on two accepted records: [ADR-0029](../adr/0029-agents-positions-and-org-chart.md) (agents as org members) and [ADR-0049](../adr/0049-member-scoped-vy.md) (Vy working for one member). The gate it passes is [docs/product/scope.md](../product/scope.md); the products it borrows from are in the [AI-first reference study](../research/ai-first-reference-study.md). A Vietnamese summary for the owner is [vy.vi.md](vy.vi.md).

## 1. What Vy is to the user

- **A coworker and an assistant.** Vy is the general manager (tổng quản, key `gm`) across every app and Ludy Notes (DESIGN.md 1.1), and both a coworker and an assistant ("trợ lý"; owner, 2026-11-10: "Vy là đồng nghiệp và trợ lý luôn"). Only Vy is called an assistant; Ly, Dy and Uy stay coworkers. The app reads the name from the `{gm}` placeholder, filled from `packages/kernel-contract/src/coworkers.ts`, so an org that renames Vy changes one value.
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
| 2026-11-10 | "Đồng ý" (Platform PO chat): **Vy's agent brain is a DOS Claw agent on work.dos.ai, not built in Ludy.** Ludy builds no agent loop (no proactive model loop, no conversational memory, no agent scheduler) and provides exactly three things: an MCP endpoint over its existing commands and queries (filtered by an `agent_grant`, member mode for private data, approvals unchanged), the deterministic signal rules (V4, V5) and an outbound signed webhook that wakes the agent. | [ADR-0051](../adr/0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md) |
| 2026-11-10 | Packaging on Ludy Cloud, in the owner's words: "Tao nghĩ bản cloud cứ có mặc định Vy đi. Rồi ai cần thì mua thêm Ly, Uy, Hy gì đó thôi. Là 1 addon, ai ko cần AI thì khỏi xài". One Vy agent (a DOS Claw agent) is included by default for every org; each other coworker (Ly, Dy, Uy, later Hy) is a paid per-org add-on, its own DOS Claw agent under Vy; an org that wants no AI does not use them and the rest of Ludy works fully without any agent. Self-hosted Ludy is unchanged. Packaging and price are a DOS.AI and Cloud decision, not Ludy code. | [ADR-0051](../adr/0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md) decision 9 |

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

Status on 2026-11-12, on `main` and on the pilot from `v0.3.1` (it ships off, `OAUTH_SERVER=off`):

| What | Where |
|---|---|
| Cross-app signal rules, the kernel half: V4 (a won deal with no sales invoice after 7 days) and V5 (an overdue receivable with an open deal; a supplier's bank account changed while a payment waits, never silent) | #2968, #2970; the six line reads (`finance.signals.*`, `crm.signals.*`) are the Accounting and Engage lines' work, tracked on [#2967](https://github.com/DOS/Ludy/issues/2967) and [#2969](https://github.com/DOS/Ludy/issues/2969); until they land the rules answer nothing |
| The MCP endpoint of ADR-0051 decision 2: OAuth 2.1 (PKCE, dynamic registration, audience-bound ES256 tokens), the consent screen, `agent_grant` checked in every transaction, default-deny `mcp` on queries, no command reachable, audit "via <app> (MCP)" | #2976, #2977, #2978 |
| Read tools `ludy_about`, `ludy_parties_list`, `ludy_invoices_list` (owner decision 2026-11-11 on the data they carry), a daily row budget per grant (2000 by default) | #2980, #2995, #2996 |
| The pull tool `ludy_signals` over the cross-app rules (V4, V5): the four line reads (`crm.signals.won_deals`, `crm.signals.open_deals`, `finance.signals.sales`, `finance.signals.overdue_receivables`) and the three rules declare `mcp`, each read refuses when the caller's books are only in part in view, and the tool answers `items`, `checked` and `unchecked` so an empty list is never "all clear"; rule 3's two finance reads are not built (no data) | #3077 to #3081, #3085, #3086 and this PR |
| The connection guide for Claude and ChatGPT | [docs/runbooks/mcp-connect-claude-chatgpt.md](../runbooks/mcp-connect-claude-chatgpt.md) (#2997) |
| The signal wake-ups (V4, V5; step S5): the worker enters a company grant's sealed context through its own door (`enter_mcp_wake_company_context`, the worker login's alone, for a company grant whose wake-up is on, read only), over one private core that seals the context for both doors; a member-bound grant never gets signals; the sweep asks the three rules as the grant every five minutes and a signal fires when its key first appears. Rule 3 (a supplier's changed bank account with a payment waiting) stays quiet and shows as `unchecked` until a supplier bank account record and a supplier-payment flow exist (an owner decision) | #3089, #3092 (runbook: [mcp-wake-webhook.md](../runbooks/mcp-wake-webhook.md)) |
| The signed wake-up webhook of a grant (decision 4): a receiver and a secret per grant, a schedule and signals, HMAC-SHA256 over the timestamp and the exact body, at-least-once delivery with bounded retries through the egress guard, set up from Settings | #3024 and its PRs (runbook: [mcp-wake-webhook.md](../runbooks/mcp-wake-webhook.md)) |
| The member-bound grant (decision 2, slice 3a to 3c, tracked in #2975). 3a: a member connects their own AI app while the org's switch (off by default, the owner's) allows it, at most five live ones per member; the database holds the rules (`kind`, the member is the consenting user, the private scope is a member grant's alone); invariants first. 3b: the sealed context `mcp_member` (no user, tainted, R0, read only, re-entered on every request, a catalog `mcp_member_table` that ships empty), wired in the runtime so a member grant reaches only the queries that declare `mcp` and only what the member's role may read; every refusal reaches the client as one generic "grant not valid", the reason only in the security event. 3c: a member sets the wake-up of their own member-bound grant and of nothing else (an owner or admin sees only its host and cuts it off by revoking the grant), a member-bound grant gets no signals (a schedule and a ping carry a date or nothing), rates on rotate and test, and the screen under each connection in Settings. A demotion of an owner or admin ends every grant of theirs, member-bound ones too. 3d (the first private tool) is deferred by the owner on 2026-11-13: risk of exposing private data, so `mcp_member_table` stays empty and the scope `ludy.member.read` stays dark. 3e: a company grant (an owner's or admin's) enters its own sealed context `mcp_company` (`enter_mcp_company_context`: no user, tainted, R0, read only, the grantor's role read live on every request), so the MCP surface reads nothing bound to a user or to Vy's catalog whatever the grant kind; the audit row of a refused call is the one write that context may make (by the consenting user, naming the grant). | 3a: #3043, #3044; 3b: #3045, #3046, #3047, #3048, #3049; 3c: #3051, #3053, #3054; 3e: #3069, #3071 |

Next: the first private tool (3d) only when the owner reopens it; rule 3 of V5 (a supplier's changed bank account with a payment waiting) needs data that does not exist yet (a supplier bank account record and a supplier-payment flow, an owner decision); the DOS side on [DOS/DOS.AI#7053](https://github.com/DOS/DOS.AI/issues/7053).

What does not exist: any question-answering over the org's data, any retrieval index or embeddings, any cross-app rule that joins two apps' records, a general-manager position or template, and an inbound email module (finance's invoice mail route is the only inbound mail; [email.md](email.md) covers sending).

## 4. The scope gate

- **Fit.** The owner of a one-person company opens Ludy every morning to learn what needs them, and asks weekly "how is the business doing". Everything in phases 1 and 2 serves that; a team of agents managed by Vy (C6) mainly serves a larger org and comes last.
- **Smallest slice.** One person with the defaults and no setup: the brief, the alerts and the weekly status need no setting; member mode is on for the owner by default (`vy.use` on the owner role, ADR-0049 decision 10).
- **AI part, named.** Each capability below names what Vy reads, what it may write and how the review stays short.
- **Proportionate security.** No guard is weakened. Section 7 lists the three points that need a decision record before they are built.

## 4b. Two rules for every app, and how Vy runs on outside agent platforms (owner, 2026-11-10)

> **Superseded in part by [ADR-0051](../adr/0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md).** The two rules below stand. The bullets "Outside agent platforms" and "A quick DOS option" are replaced: Vy's brain is a DOS Claw agent on work.dos.ai, and Ludy's part is the MCP endpoint, the signal rules and a signed webhook (section 4c, component 7). The model port bullet stays for the features already built in Ludy (meeting summary, ADR-0049), not for a Vy agent loop.

The owner set two rules for every module and app, with Vy as the example:

1. **Ludy is an OS: it runs on its own and is never locked to one paid third party.** Supabase is the model: open source, self-hostable, with a hosted option. Every outside service sits behind a port with a free or self-hosted default (AGENTS.md: `docker compose up` with no DOS service).
2. **Ludy is deeply integrated with the DOS ecosystem**: DOS ID, DOS.AI and DOS's own agents work out of the box when an org uses them.

For Vy this means:

- **One small runtime port, many adapters.** ADR-0029 decision 8 (runtimes are adapters) and ADR-0049 decision 9 (the provider ports) already split Vy's brain from the kernel. The plan keeps that split and makes it the only way in:
  - **Model calls**: one OpenAI-compatible chat port (`@crove/agent`, `AI_BASE_URL`), so OpenAI, Anthropic and Google (through their compatible endpoints or a thin adapter), a local model (Ollama, vLLM) and the DOS.AI gateway all work by configuration. No feature imports a vendor SDK (A8 already tests this).
  - **Outside agent platforms** (DOS Claw first; Claude Code, OpenAI Agents, Google agents, OpenClaw and the like): one generic MCP endpoint and one signed webhook, as in ADR-0051 decisions 2 and 4. The endpoint maps tools to the same commands and queries the app uses, filtered by an `agent_grant` bound to `(org, client_id, agent_id)` (ADR-0029 §8). The kernel stays the source of truth: every write goes through `Runtime.execute`, the same risk tiers and approvals apply (an approval made in Paperclip or DOS Claw never counts as a Ludy approval), and a member's private data reaches an outside agent only through a member-bound grant and only what that member could read (ADR-0049). No second API.
- **Packaging (owner, 2026-11-10, ADR-0051 decision 9):** Ludy Cloud includes one Vy agent by default; Ly, Dy, Uy and later coworkers are paid per-org add-ons, each its own DOS Claw agent under Vy; no AI means no agent and the rest of Ludy works fully. The default stays at one agent because a DOS Claw agent is priced per agent per month plus token usage, and wake-ups come only from Ludy's rules, so a quiet day costs almost no tokens. Packaging and price are DOS.AI's and Cloud's, not Ludy code.
- **The DOS option is a preset, not a build.** An org that uses DOS connects its DOS Claw agent the way every client connects: standard remote MCP authorization (Streamable HTTP, OAuth 2.1 with PKCE, protected-resource metadata, dynamic client registration), where a person adds Ludy's MCP URL in the client and consents on Ludy's own screen, which creates the `agent_grant` (the pairing code in Settings stays only as the fallback for clients without OAuth, and for the DOS preset); the DOS preset only pre-fills the endpoint, the DOS ID sign-in and the work.dos.ai webhook URL. It is an optional adapter, **off by default** (the answer to Q8 below). **Consequence stated honestly:** a self-hosted Ludy without DOS keeps the rule-based alerts on Home and the meeting summary and has no reasoning Vy; any MCP client can pair the same way.
- **Tests that keep it honest**: a fake provider and a fake MCP client in CI; the stack must pass with no outside AI configured (AI off) and with only a local model.

## 4c. Architecture and tech stack

> **Amended by [ADR-0051](../adr/0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md).** Ludy builds no agent loop: Vy's brain, memory, channels and schedules are the DOS Claw agent's. What follows describes the kernel side. The model port, knowledge port and memory port serve the member-mode features already built (ADR-0049) and are not a base for a Vy agent in Ludy; components 3, 4 and 6 below that describe an in-Ludy Ask Vy or a scheduled member-mode brief are superseded as plans.

Vy is not a separate service. It is kernel code plus one package, on the stack Ludy already runs; nothing new to host for phase 1.

**Stack (as in the repo today):**
- TypeScript monorepo (pnpm). API and worker: `apps/kernel` (Hono, oRPC, Zod). App: `apps/app` (React, Vite, oRPC client).
- PostgreSQL 17 (the Supabase image, self-hostable) with row-level security on every tenant table; Kysely for queries; migrations in `supabase/migrations`.
- Jobs and schedules: pg-boss on the same database (no Redis, no paid queue).
- Model calls: `@crove/agent` on the Vercel AI SDK (`ai`) with `@ai-sdk/openai-compatible`, pointed at `AI_BASE_URL` (DOS.AI, OpenAI, Anthropic or Google through a compatible endpoint, Ollama or vLLM locally). AI off is a supported mode.
- Sandboxed helpers already in the stack: `apps/extract` (document parsing) and `apps/media` (audio), both with no egress.

**Components:**

```
 app (React)  ──oRPC──▶  kernel API (Hono)  ──▶  Runtime.execute / query  ──▶  Postgres (RLS, audit, outbox)
                              │                       │ ▲
 outside agent (MCP) ─grant─▶ MCP endpoint (new)      │ │  pg-boss jobs (brief, alerts, weekly, member-mode runs)
                                                      ▼ │
                                      @crove/agent: metered() ─▶ model port (OpenAI-compatible)
                                                      │
                                      knowledge port (declared queries, member's rights) · memory port (per member)
```

1. **One write path.** Every Vy action is a command through `Runtime.execute`: risk tier, approvals (proposals), audit and idempotency for free. Vy never writes SQL.
2. **Two contexts.** Company mode runs as Vy's org-chart agent (ADR-0029: agent context, write allowlist, no private reads). Member mode runs in the member's sealed context (ADR-0049: `enter_member_vy_context`, results in `member_vy_result`, memory in `member_vy_memory`, sinks on `MEMBER_VY_SINKS`).
3. **Deterministic first, model second.** Code computes every number and picks the data (fixed, declared queries); the model only writes sentences or classifies, has no tools, and its output is parsed against a schema and checked (numbers must match). Today's brief already works this way (`packages/agent/src/today.ts`).
4. **Ports, not vendors.** Model port (chat), knowledge port (retrieval over declared queries, later an index per ADR-0052), memory port (per member, must support forget). Each has a built-in default that runs on the self-hosted stack and a fake for CI. A hosted provider (DOS.AI, a vector store) is an adapter behind the same port, chosen by configuration (ADR-0030 composition root).
5. **Metering and switches.** Every call goes through `metered()`: org, module, agent and member budgets, and the four kill switches, checked at start and at each admit.
6. **Background work.** Briefs, alerts and the weekly status are pg-boss schedules per org (system context for counts, member-mode jobs for anything private). Alerts (C4) use no model at all.
7. **The agent's door (new, ADR-0051).** One MCP endpoint in `apps/kernel` that maps MCP tools to the same commands and queries, run through `Runtime.execute` and filtered by an `agent_grant` (org, client, agent); in member mode the grant is bound to one member and the agent sees only what that member can read. Pairing creates the grant; revoking it, pausing the agent or a kill switch closes access. An outbound signed webhook (HMAC-SHA256, timestamp, event id, a five-minute replay window, ids-only body) wakes the agent when a signal fires or an org's schedule is due; Ludy's pg-boss only emits the event. DOS Claw connects through the same generic flow (OAuth first, the pairing code as fallback), with an optional DOS preset (Q7 and Q8 are answered). Each tool carries MCP annotations (`readOnlyHint`, `destructiveHint`) that mirror its risk tier. There is no per-vendor integration code: Ludy ships a tested connection guide per vendor (Claude custom connector, ChatGPT connector, Gemini CLI or Google ADK, OpenClaw) and, later, listings in their connector directories. The wake-up webhook needs a receiver that can be woken (work.dos.ai, OpenClaw, an agent the org runs); chat apps such as ChatGPT and Claude are user-initiated, so with them Vy is reactive and proactive alerts stay on Home and notifications.

**Data Vy adds:** none for phase 1 (it reads existing `*.today` queries and writes proposals and tasks). Phase 2 adds the grant and webhook tables of ADR-0051 (an `agent_grant` row per pairing, a per-grant webhook secret and an outbox of events) and nothing beyond ADR-0049's otherwise. No index tables and no general-manager template in Ludy.

**What is new code, by phase:** phase 1: queries and Home cards (no model for alerts; V4 and V5 shipped); phase 2: pairing and `agent_grant`, the MCP endpoint (read tools first, then commands with approvals unchanged), the member-bound grant, the signed webhook; phase 3: nothing in Ludy beyond what the DOS side asks of the endpoint (the agent's chart, memory and delegation are work.dos.ai's).

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

> **Changed by ADR-0051:** Ludy no longer builds this. The question is asked of the DOS Claw agent (in work.dos.ai, Telegram or Zalo), which calls the MCP endpoint under the member's grant; the declared queries below are what the read tools expose, and the citation and numbers rules are the agent's contract with Ludy's links (`zTodayHref`). Nothing below is built in Ludy as a model loop.

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

> **Changed by ADR-0051:** this lives on the DOS side. Vy, Ly, Dy and Uy are DOS Claw agents on the work.dos.ai chart, and delegation goes through work.dos.ai; any business effect still goes through Ludy's MCP endpoint and approvals. The "general manager template in Ludy" below is dropped. ADR-0029's org-chart agents in Ludy stay as deterministic template programs.

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
| V4 | The signals contract and the first cross-app rule: won deal with no invoice after 7 days (C4; [#2967](https://github.com/DOS/Ludy/issues/2967)) | A kernel read composes `finance` and `crm` signals by contact id in the member's context; a member who cannot read finance gets no item; no text crosses; no model; the rule's days are a constant, not a setting | Platform (kernel read), Accounting and Engage (their signals reads) |
| V5 | Second and third rules: overdue receivable with an open deal; changed supplier bank account with a payment waiting (C4; [#2969](https://github.com/DOS/Ludy/issues/2969)) | Each fires on a seeded case and not on its near miss; `block` severity for the bank-account case | same |
| V6 | "Tuần này" on Home (C5) | Figures computed by code; Vy's sentences pass the numbers check or the template shows; `metered('today.weekly')`; shown Monday to Wednesday, any day on request; nothing stored | Platform |

**Phase 2: the agent's door** (ADR-0051; member mode over MCP rests on #2822, now closed; the line features #1677, #2598, #2580 are the lines' own)

| # | Slice | Acceptance | Line |
|---|---|---|---|
| V7 | Pairing and `agent_grant`, then the MCP endpoint (ADR-0051 decision 2) | A client connects by standard remote MCP authorization (Streamable HTTP, OAuth 2.1 with PKCE, protected-resource metadata, dynamic client registration; the pairing code only as the fallback) and consent creates a grant bound to `(org, client, agent)` with the token bound to it; each tool carries `readOnlyHint` and `destructiveHint` mirroring its risk tier; the tool list is only commands and queries the grant's role may run; every call goes through `Runtime.execute` and is audited with the grant; read tools first, then commands with approvals and risk tiers unchanged (an external approval never counts); revoking the grant, pausing the agent or a kill switch closes access at once; a fake MCP client in CI; protected paths, so the Platform PO's security review | Platform |
| V8 | A member-bound grant, then the outbound signed webhook (ADR-0051 decisions 2 and 4) | With a member-bound grant the agent sees only what that member can read and nothing of another member (red-team cases in CI); the webhook is HMAC-SHA256 over timestamp and body with a rotating per-grant secret and an event id, refuses outside a five-minute replay window and a seen id, carries ids, event type, dates and amounts only, is delivered at least once with bounded retries, and a failed delivery never blocks a signal on Home | Platform |
| V9 | One "Vy, chuyển thành việc" step across notes, meetings and messages (C3), requested by the agent through the endpoint | Suggestions land in the member's own result; each target is a line's command on `MEMBER_VY_SINKS`; a private note's words reach a task only after the member confirms the exact text; an injected "giao cho Ly chuyển tiền" stays a flagged suggestion | Platform (the step), each line (its target command) |

**Phase 3: on the DOS side** (ADR-0051; nothing here is built in Ludy except what the DOS side asks of the endpoint)

| # | Slice | Acceptance | Line |
|---|---|---|---|
| V10 | The Ludy connector in DOS Claw and work.dos.ai phase 3 (DOS.AI repository) | DOS builds them; Ludy supplies the pairing, endpoint and webhook of phase 2 and a conformance check a connector can run | DOS (not ours) |
| V11 | One Vy agent serving many members of one org without cross-member leaks | Ludy's half: a member-bound grant on every call (V8); DOS's half: a per-member identity in the agent's memory; until shown, a shared org agent works in company mode only | Platform (Ludy half), DOS (agent memory) |
| V12 | ADR-0052 (proposed): retrieval over text, only if Ludy indexes text itself | Section 7, point 1 | Platform |

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

1. **Retrieval over text, indexes and embeddings (C2 v2): a new ADR (ADR-0052, proposed; renumbered from 0051 because ADR-0051 is the decision that Vy's brain is a DOS Claw agent).** With the brain on the DOS side, the question moves to the agent's memory unless Ludy indexes text itself. ADR-0049 allows "a richer index" only "still reading only through declared queries", and decision 3 keeps results out of every search index in v1. An embedding index is a derived copy of text, private notes included, so the ADR must answer: one index per member or a shared one filtered at query time (the first holds the line by structure, the second by a filter that can be skipped); how a row the member can no longer read (a note made private, a narrowed `le_scope`) leaves the index at once; forgetting on removal, erasure (#923), the org purge and the 30-day purge; whether vectors count as `pii`; whether a hosted provider may hold the index (decision 9 says only text the member could read, for that member); and the `private_read` flag for passages. Recommended v1: no index over private text; lexical search through declared queries.
2. **A question router (C2): not needed in Ludy (ADR-0051).** The agent chooses among the MCP tools; the tools are existing commands and queries filtered by the grant, so no model chooses inside Ludy's member mode. The grant's role and the member binding bound what any tool can reach.
3. **Background composition without one subject (C5 by mail, any scheduled member-mode brief): an addendum to ADR-0049.** Decision 1 says "a run is for one feature and one subject"; a weekly mail written in each recipient's rights is neither. Until then the weekly status is on Home only and the mail stays counts and a link.
4. **Vy as an org-chart agent with cross-module reads (C6): moved to the DOS side (ADR-0051).** The general manager and the coworkers are DOS Claw agents on the work.dos.ai chart; Ludy's part is the grant, the endpoint and approvals. The earlier ADR-0029 addendum for a general-manager template in Ludy is not written.

C1, C3 and C4 need no new record: C1 and C4 read in the member's own request and C1 sends figures only; C3 uses the sinks mechanism as built.

## 8. Open questions for the owner

| # | Decision | Recommended | Why | Without an answer |
|---|---|---|---|---|
| Q1 | Order: phase 1 (no member mode) before Ask Vy? | Yes | Phase 1 needs no gate and serves every owner every morning | Platform builds phase 1 only |
| Q2 | Ask Vy v1: figure questions over fixed reads, without search over notes and meetings? | Moot in Ludy (ADR-0051): the DOS Claw agent answers, through the MCP endpoint's read tools | The agent is the asker; Ludy exposes the declared reads | Nothing is built in Ludy for it |
| Q3 | An index or embeddings over private notes and meetings, ever? | Not in v1; shared data first, private text only after ADR-0052 | Private text in an index is the largest new exposure | No index is built |
| Q4 | Vy as an AI general manager in the org chart above Ly, Dy and Uy, now or after the pilot? | Answered by ADR-0051: on the DOS side (work.dos.ai chart), not in Ludy | The chart and delegation are DOS's | Nothing is built in Ludy |
| Q5 | The weekly status: on Home only, or also by mail with figures? | Home only; the mail keeps counts and a link | Figures in a mail leave Ludy and need per-recipient rights | Home only |
| Q6 | On Home, name the app's coworker on each item (Ly, Dy, Uy) and Vy on the summary? | Yes | It follows DESIGN.md 1.1's copy rule | Every item stays unnamed |
- **Q7. Answered 2026-11-10 (ADR-0051).** DOS Claw is one OpenClaw or Hermes container per agent, with LLM calls through api.dos.ai, long-term memory (Honcho), Telegram and Zalo, and MCP tools managed with a capability token per agent; it is Vy's brain. It connects through the same standard remote MCP authorization as every client (OAuth 2.1 with PKCE), with the pairing code in Settings as the fallback and a DOS preset as a pre-filled default.
- **Q8. Answered 2026-11-10 (ADR-0051), open-core part kept:** the DOS preset is a pairing and webhook target, an optional adapter in the open core, **off by default**, so self-hosters can pair with DOS too; the open core carries only the generic door.

## 9. Line ownership

Owner decision 2026-11-10: "Vy thuộc Platform nha". The boundary, following "a line's own feature stays with that line" ([docs/product-owner-config.md](../product-owner-config.md)):

- **Platform owns the Vy core:** the member-mode mechanism (`packages/kernel/src/member-vy.ts`, `packages/agent/src/member-vy/**`, the ports and their built-in implementations, `MEMBER_VY_SINKS`, `vy.use`); the meter and kill switches as they touch Vy; the general-manager agent (C6) and its ADR-0029 addendum; the ADRs of section 7.
- **Platform owns the agent's door (ADR-0051):** pairing and `agent_grant`, the MCP endpoint, the member-bound grant and the signed webhook. The DOS Claw connector, work.dos.ai phase 3 and the agent's memory are DOS's (V10, V11).
- **Platform owns Vy's cross-app work:** the Home composition (`kernel.today`, `TODAY_READS`), the brief (`today.brief`), the brief mail, the signals composition (C4), the weekly status across apps (C5), Ask Vy (C2) and the routing step of C3.
- **Each line keeps its features inside its app**, Vy-powered or not: its `<module>.today` and signals reads; Notes N8 ([#1677](https://github.com/DOS/Ludy/issues/1677), Notes & CRM); meetings transcription and summary ([#2578](https://github.com/DOS/Ludy/issues/2578), [#2580](https://github.com/DOS/Ludy/issues/2580), [#2941](https://github.com/DOS/Ludy/issues/2941), Meetings); projects P5 to P7 ([#2596](https://github.com/DOS/Ludy/issues/2596), [#2597](https://github.com/DOS/Ludy/issues/2597), [#2598](https://github.com/DOS/Ludy/issues/2598), the line that owns projects); the coworkers' own work (Ly in Accounting, for example [#2376](https://github.com/DOS/Ludy/issues/2376), whose copy should name Ly; Dy and Uy in Engage).
- **Frontend** owns how Vy looks on every screen (Home, the palette, the "Đề xuất" style) and the rename issue [#1682](https://github.com/DOS/Ludy/issues/1682).
- A line feature that needs a new member-mode feature key, sink or port asks Platform for the shared-core review of those files, as for any shared-core change.

## 10. Risks

- **No reasoning Vy without DOS.** A self-hosted Ludy keeps the rule-based alerts and the meeting summary only (ADR-0051 decision 7); any MCP client can pair, but Ludy ships no agent. Mitigation: said plainly in the product and the docs; the generic door is open to every vendor.
- **One agent, many members.** A shared DOS Claw agent could leak one member's data to another through its own memory. Mitigation: a member-bound grant on every call (Ludy's half) and a per-member identity in the agent's memory (DOS's half, open item); until shown, a shared agent runs in company mode only.
- **The webhook becomes a side channel.** Mitigation: ids, event type, dates and amounts only, signed with a replay window; the agent reads detail back through the endpoint under its grant.

- **Ask Vy over-promises.** A chat box over unchanged screens is the trap the study names (3.3). Mitigation: Ask Vy is the second door; the brief, the alerts and the in-screen work come first.
- **Hallucinated figures.** Mitigation: code computes every figure; every text passes the numbers check or is dropped (#1237, `today.ts`).
- **Leaks through composition.** A cross-app item or answer could combine what a member reads in one app with what they cannot read in another. Mitigation: every read runs in the member's own context, and an item needs both sides readable.
- **The gate slips.** Phase 2 waits on #2822. Mitigation: phase 1 does not depend on it.
- **Cost.** Mitigation: the brief is cached for the day; alerts use no model; Ask Vy is rate-limited per member.
