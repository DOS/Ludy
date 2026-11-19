# 0051. Vy's brain is a DOS Claw agent; Ludy is the gate

- Status: Accepted (2026-11-10) as a direction. The owner decided it on 2026-11-10 in the Platform PO chat (the popup answer "Đồng ý", on the proposal in the Context below), and added the packaging rule of decision 9 the same day. The mechanism of decisions 2 to 4 is accepted by the Platform PO with the pull request that builds each part. **Amended 2026-11-19 (#3858):** decisions 10 to 14 below make an MCP grant able to call R2 and R3 commands as proposals only, add per-line write scopes, a sealed context that reads conversations and CRM, line wake events and the role rule. The owner approved the change in the Platform PO chat on 2026-11-18 (popup answer "Đúng, làm đi (Khuyên dùng)") and in the Engage PO chat on 2026-11-19 (popup answer "Cho làm, việc lớn chờ duyệt").
- Date: 2026-11-10
- Deciders: owner (JOY) for the direction; the Platform PO for the mechanism
- Builds on: [ADR-0029](0029-agents-positions-and-org-chart.md) (agents, positions, the write allowlist, decision 8: runtimes are adapters, the `agent_grant`); [ADR-0049](0049-member-scoped-vy.md) (Vy working under one member's rights); [ADR-0018](0018-untrusted-content.md) (untrusted content); the approval and risk tiers (R0 to R3), the AI budget meter (#2382) and the kill switches (#886)
- Supersedes: the "outside agent platforms" and "a quick DOS option" parts of [docs/plan/vy.md](../plan/vy.md) sections 4b and 4c, and the plan's phase 2 "Ask Vy in Ludy" and phase 3 "general manager agent template in Ludy"
- Amended by: the owner decision of 2026-11-18/19 on an MCP grant and R2+ commands (epic [#3857](https://github.com/DOS/Ludy/issues/3857), this record's decisions 10 to 14, issue [#3858](https://github.com/DOS/Ludy/issues/3858))
- Amends by reference: ADR-0029 decision 8 (it gets its concrete door, the MCP endpoint of decision 2) and its general manager template (it lives on the DOS side, decision 5). ADR-0049 is not changed: its ports and the existing member-mode features stay.
- Plan: [docs/plan/vy.md](../plan/vy.md); the Vietnamese summary for the owner is [0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.vi.md](0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.vi.md)

## Context and problem statement

The Vy plan (2026-11-10, section 4b and 4c) kept Vy's reasoning inside Ludy on a model port and left a door open for outside agent platforms (Claude Code, OpenAI Agents, Google agents, OpenClaw) through an MCP endpoint, with two open questions for the owner (Q7: what DOS Claw is and how it pairs; Q8: whether the DOS preset lives in the open core). Phases 2 and 3 of the plan would have built Ask Vy, a question router and a general manager agent inside Ludy, with an agent loop of our own.

DOS already runs the agent side. The Platform PO checked the facts below on 2026-11-10 against these documents of the DOS/DOS.AI repository; the DOS side owns their truth and changes them:

- `docs/dosclaw/DOSClaw-Architecture.md` v1.10 (a container per agent, LLM calls through api.dos.ai, `cron` denied in `tools.deny`);
- `docs/dosclaw/memory-engine-decision.md` (Honcho adopted 2026-09-21);
- `docs/dosclaw/DOSClaw-Roadmap.md` (P1.2 proactive deferred; P2.1 and P3.1 multi-agent not built);
- `docs/dosclaw/paperclip/PAPERCLIP_RESEARCH.md` (heartbeats, cron and HMAC webhook routines);
- `docs/dosclaw/paperclip/option-d/live-acceptance.md` (work.dos.ai live for DOS staff on v2026.1023.0);
- `docs/dosclaw/paperclip/option-d/phase3-design.md` (phase 3 designed, not live).

In short:

- **DOS Claw** is one OpenClaw or Hermes container per agent. Its model calls go through the DOS.AI gateway (api.dos.ai). It has long-term memory (Honcho) and Telegram and Zalo channels, and the gateway manages its MCP tools with a capability token per agent. The agent is denied the `cron` tool.
- **work.dos.ai** is a pinned Paperclip release (MIT). It provides the org chart, issues and delegation, heartbeats, and routines triggered by cron or by an HMAC-signed webhook. Its phase 3, DOS Claw agents on the chart, is designed and not live.
- Ly, Dy and Uy are meant to be DOS Claw agents under Vy on that chart. Delegation goes through work.dos.ai, and any business effect goes through Ludy.

The owner decided on 2026-11-10: **Vy's agent brain is a DOS Claw agent on work.dos.ai, not something built in Ludy.** Ludy keeps what only Ludy can keep: the data, the permission boundary and the approvals. A second decision the same day sets the Cloud packaging (decision 9).

## Decision

1. **Ludy builds no agent loop.** No proactive model loop, no conversational memory and no agent scheduler in Ludy. Vy's reasoning, memory, channels, delegation to Ly, Dy and Uy, and schedules are the DOS Claw agent's and work.dos.ai's. Ludy is the **gatekeeper and the source of truth**, and provides exactly three things (decisions 2 to 4).

2. **An MCP endpoint in `apps/kernel`.** One endpoint per org that maps MCP tools to the commands and queries the app already uses, run through `Runtime.execute` (never a second API, never SQL):
   - access is an `agent_grant` bound to `(org, client, agent)` (ADR-0029 decision 8). **How a client connects (primary path): standard remote MCP authorization**, that is Streamable HTTP transport plus OAuth 2.1 with PKCE as in the MCP authorization specification, with protected-resource metadata and dynamic client registration. A person adds Ludy's MCP URL in their client (a Claude custom connector, a ChatGPT connector or app, Gemini CLI or Google ADK, OpenClaw or DOS Claw); the client sends them to Ludy's own sign-in and consent screen; consent creates the grant, and the access token is bound to that grant. The **pairing code** (an owner or admin gets it in Settings and the client enters it) stays only as the fallback for clients without OAuth and for the DOS preset. Revoking the grant, pausing the agent or a kill switch closes access at once;
   - each tool carries MCP annotations (`readOnlyHint`, `destructiveHint`) that mirror its risk tier, so a client can show what a tool may change before it runs;
   - the tool list is filtered by the grant: a tool exists only for a command or query the grant's role may run, and every tool call is audited with the grant, the client and the agent;
   - risk tiers and approvals apply unchanged. A command above R1 becomes a proposal that a person approves in Ludy. **An approval inside Paperclip or DOS Claw never counts as a Ludy approval**: the gate is Ludy's own, and the agent's wording ("the manager approved it") is data, not an approval;
   - **member mode** (ADR-0049) over MCP: a grant may be bound to one member, and then every call runs in that member's sealed context, so the agent sees only what that member can read and writes only what the member's commands allow. A private note, a result or a memory of one member is never reachable through another member's grant.

3. **The deterministic signal rules stay in Ludy, with no model.** The cross-app rules of the plan's phase 1 (`kernel.signals.*`: V4 a won deal with no sales invoice after 7 days, V5 an overdue receivable with an open deal and a changed supplier bank account with a payment waiting) are Ludy's. They run in the member's own request, show on Home, and are also what the agent is woken for (decision 4). The agent never replaces them and a self-hosted Ludy keeps them.

4. **An outbound signed webhook that wakes the agent.** When a signal fires, or a schedule an org set is due, Ludy sends one webhook to the routine trigger URL the pairing recorded on work.dos.ai:
   - the body carries ids, event type, dates and amounts only: no note text, no party name, no message body (the same rule as `zTodayItem` and the signals contract). The agent reads the detail back through the MCP endpoint, under its grant;
   - it is signed with HMAC-SHA256 over the timestamp and the body, with a per-grant secret that rotates, and carries an event id; the receiver refuses a timestamp outside a replay window (five minutes) and an event id it has seen;
   - delivery is at least once from the outbox with pg-boss retries and a bounded backoff; **Ludy's pg-boss only emits the event.** What the agent does with it is the agent's decision, and a failed delivery never blocks the signal on Home;
   - the wake-up needs a receiver that can be woken (work.dos.ai, OpenClaw, or an agent the org runs itself). Chat apps such as ChatGPT or Claude are user-initiated, so with them Vy is reactive: the person asks and the agent acts through the tools, while proactive alerts stay on Ludy's Home and notifications;
   - a signal for a member is sent only for a member-bound grant, and only for items that member can open (the signal ran in their context).

5. **The general manager and the coworkers live on the DOS side.** The "general manager agent template in Ludy" of the plan (C6, V10, V11) is dropped: Vy, Ly, Dy and Uy as DOS Claw agents, their org chart and delegation are work.dos.ai's. Each business effect they cause still goes through decision 2. ADR-0029's org-chart agents in Ludy (positions, tasks, the write allowlist) stay as they are for deterministic template programs.

6. **What stays in Ludy from before.** The member-mode features already built (meeting transcription and summary, ADR-0049 stages A and B) and their model port and meter stay. Ask Vy and a proactive Vy built with an AI SDK inside Ludy are dropped from the plan. AI off remains a supported mode, and every screen works without it.

7. **Principle 1 is kept honestly.** Ludy runs on its own with `docker compose up` and is not locked to one third party. The consequence, stated plainly: **a self-hosted Ludy without DOS has the rule-based alerts on Home and the meeting summary, and no reasoning Vy.** Any MCP client can still connect the same way (OpenAI, Anthropic, Google, OpenClaw): the endpoint and the webhook are generic, and nothing in them names DOS. **There is no per-vendor integration code:** one standards-conforming MCP server serves every vendor, and what Ludy ships per vendor is only a tested connection guide (docs) and, later, a listing in the vendor's connector directory (a Cloud and marketing step). The **DOS preset** (the endpoint, the DOS ID sign-in and the work.dos.ai webhook URL pre-filled) is an optional adapter, **off by default**, so AGENTS.md's rule that anything DOS-specific stays out of the open core is read as: the open core carries the generic door, and a preset is only a default value for it.

8. **What Ludy does not trust.** The agent's output is tainted data (ADR-0018): it reaches a record only through a command the grant allows, with the same checks as a person's click. A webhook response is not read as an instruction. The agent's own model calls are DOS.AI's and are not metered by Ludy's meter (the meter still covers Ludy's own calls); what Ludy bounds for a grant is its tool rate, its role, and the approvals it cannot skip.

9. **Ludy Cloud packaging: one Vy by default, the other coworkers as paid add-ons (owner, 2026-11-10).** The owner decided the same day, in his words: "Tao nghĩ bản cloud cứ có mặc định Vy đi. Rồi ai cần thì mua thêm Ly, Uy, Hy gì đó thôi. Là 1 addon, ai ko cần AI thì khỏi xài". So:
   - Ludy Cloud includes **one Vy agent** (a DOS Claw agent) by default for every org;
   - each other AI coworker (Ly, Dy, Uy, and later ones such as Hy) is a **paid add-on bought per org**, and each add-on is its own DOS Claw agent under Vy on the work.dos.ai chart;
   - an org that wants no AI does not use them, and **the rest of Ludy works fully without any agent** (AI off stays a supported mode);
   - a self-hosted Ludy is unchanged: the rule-based alerts on Home, plus pairing any MCP client (decision 7).

   The cost reasoning: a DOS Claw agent is priced per agent per month plus token usage, so the default stays at one agent. Wake-ups come only from Ludy's deterministic rules and schedules an org set (decision 4), so a quiet day costs almost no tokens. Packaging and price are a DOS.AI and Ludy Cloud decision, not Ludy code: the open core carries no price and no entitlement logic beyond the grant (an add-on is one more paired agent with its own `agent_grant`).

## Amendment of 2026-11-19: what an MCP grant may call (decisions 10 to 14, #3858)

### Why this is amended

Until now the MCP endpoint (decision 2) let a grant run **one** kind of command: an R1 command with no effect beyond its own transaction that declares a write scope, today `ludy.social.draft` (`MCP_WRITE_SCOPES` and the `mcp_scope` rule in `packages/kernel-runtime/src/runtime.ts`, #3227). Every other command was closed to a grant, even though decision 2 already says that "a command above R1 becomes a proposal". That left an outside coworker unable to do real work in an Engage flow (answer a customer, send a quote, pause an ad), because every such step is R2 or R3.

The owner decided on 2026-11-19, in the owner's words: "Dy và Uy là agent đồng nghiệp, không phải agent hỗ trợ", and answered the popup "Cho làm, việc lớn chờ duyệt" (Engage PO chat, 2026-11-19; the same rule was confirmed on 2026-11-18 in the Platform PO chat, "Đúng, làm đi (Khuyên dùng)"). An MCP grant may therefore call R2 and R3 commands, but **such a call creates a proposal and never executes**; a person approves it in Ludy. The owner approved changing the written MCP-scope rule on purpose. It still goes through the security review of a protected-path pull request, and nothing below weakens tenancy, authentication, approval or ledger rules.

### 10. R2 and R3 commands called by a grant become proposals, never executions

- A command may declare `mcp` with a `mode`: `'run'` (today's behaviour, R1 only) or `'proposal'` (R2 and R3). A command with no `mcp` declaration stays closed to a grant: the call is refused `FORBIDDEN` with the rule `mcp_scope`, and the refusal is audited as the grant's. **An undeclared command is still `FORBIDDEN`.** The declaration names a scope (decision 11), so a grant that does not hold the scope is refused the same way.
- When an MCP actor calls a `'proposal'` command, the runtime does **not** run its handler. It runs the existing proposal path (`kernel.proposal.request`, the same rows, kinds and Inbox card a person's proposal has) and answers the client with the proposal's id and state `pending`. The proposal stores the input as given (checked against the command's schema like any call, then frozen with its hash) and carries the **grant, the client and the agent** as its authors, so the approver sees who asked. Audit rows hold ids only, as today. The grant cannot edit the input after the fact; a change is a new proposal that supersedes the pending one.
- **The approval is a person's, in Ludy.** Only `kernel.proposal.approve` run by a user session approves, with the same approver rules, four-eyes and step-up as for any proposal (ADR-0029 section 6: an agent in the proposal's causal chain is never an eligible approver, and an MCP grant is never an approver at all). An approval the agent asserts ("the manager approved it") is data, never an approval (decision 2, Considered D). The command then runs once, under the approver's authority and the usual checks at that moment (permission, period locks, caps, module switches), not under the grant's. A grant revoked after it asked leaves the proposal pending for a person to decide, and the audit still names the grant.
- **R3.** An R3 call is accepted only when the command's approval policy allows a proposal (the approval preset and policy of ADR-0029 section 6 and `approval.ts`). A command whose policy needs the person present and stepped-up at the moment of the act, or that the policy says no proposal may carry, is refused `FORBIDDEN` with the rule `mcp_scope`. Where a proposal is allowed, the person's approval still needs the step-up an R3 asks for.
- Checks that apply to a proposal made by an agent apply here too: the input is tainted data (ADR-0018), rate and cap limits count the grant's proposals, an org with the agent kill switch engaged or the grant revoked gets no proposal, and a proposal never lets a deterministic rule (the P03 to P07 outcomes) be skipped.
- `max_risk` of the sealed context stays below what the command needs: a grant never runs R2 or R3 itself. The sealed write context (`R1`) exists only for `'run'` commands.

**As built (slice d, #3858, PR #3998), where it differs from the text above:**
- the call runs the kernel command `kernel.mcp.propose` in a sealed proposal context, not `kernel.proposal.request`: that command takes a person's input through a preparer (the deterministic step that builds what the approver signs), which a client's raw payload would skip, so a command that has a preparer is refused for MCP until a line builds that path;
- the authors are the grant (an agent entry, never an approver) and the grantor (a user entry), so four-eyes (P10) counts the person who connected the app, as for a proposal a person asked for;
- the hash of the input is kept in the audit row only (not in the proposal), and ids only: never the payload;
- a pending proposal is not superseded by a new one: a change is a new proposal, and a person rejects the old one; the per-grant cap (20) and per-org cap (100), in the database, bound the pile;
- a catalog (`crove_kernel.mcp_proposal_command`, filled by the migration of the line that declares a command) gives the database its own list of which scope may propose which command and with which kind; the approver snapshot and the title are stamped by the database.

### 11. Per-line write scopes, shown on consent, filtering the tool list

- The write scopes are **per line**, beside `ludy.social.draft`: `ludy.engage.write` (Hộp thư and CRM: assign, note, resolve, link a contact, create a contact or deal, save a draft quote), `ludy.ads.draft` (save an ads draft), and later ones the same way. A scope is a short name for a list of commands that declare it; it widens nothing else. Each new scope is a migration (the `agent_grant` check lists the scopes) and an entry in `MCP_WRITE_SCOPES`, reviewed one at a time as before, and the endpoint's tests pin which commands carry it.
- A scope covers both modes of decision 10: the same `ludy.engage.write` that lets a grant run an R1 command directly lets it ask for a proposal of the R2 command that carries the scope. A scope that names an R2 command is a name for "may ask", never for "may do".
- **Consent shows the scopes** in plain words (what a coworker with this grant may do, and which part runs directly and which waits for a person), and the person can untick a scope; the grant holds only what was ticked. Pairing by code shows the same list to the owner or admin who issues it.
- **The tool list is filtered** by the grant's role and its scopes: a tool exists only for a query whose read scope the grant holds, or a command whose write scope the grant holds and that its role may run. A tool the grant cannot use is absent from the list, not present and refused.

### 12. The sealed grant context reads conversations and CRM, nothing else new

- A sealed MCP context may read Hộp thư (conversations, their messages and internal notes) and the CRM tables a tool needs (people and companies, deals, quotes, bookings), **within the grant's role and, for a member-bound grant, the member's own rights** (ADR-0049 member mode):
  - a **company grant** (an owner's or admin's) reads what that role reads of those tables, for the whole org and for nothing outside it;
  - a **member-bound grant** reads only what that member may read: their channel limits, the direct-message permission and the entities of their role assignments, worked out from the sealed member in the database;
  - no context reads another member's private rows (notes, to-dos, read marks, drafts a member owns) through a grant's context.
- This is enforced **in the database** (row-level policies and the context seal), not only in the query code. The tool's projection (which columns leave) is a second, separate layer that each line reviews for privacy; the database layer decides which rows can ever be reached.
- It is **read only**. The context is read-only and tainted (R0), the agent write guard refuses it every write, and no policy this decision adds is for anything but `SELECT`. A customer's message is untrusted content (ADR-0018): it reaches the agent as data and never as an instruction to Ludy.
- The sealed kinds stay the three known ones (`mcp_company`, `mcp_member` and the draft write context); the invariant that no function names a kind except its entry stays, so a policy compares the kind inline.

### 13. Line wake events in the wake body

- Decision 4's wake body knows `signal.fired`, `schedule.due` and `ping`. A line may **register an event type** with the kernel (`mcp-wake-body.ts`, `mcp_wake_body_ok` and its invariant): a name in the line's namespace, and a list of the fields it carries, each an id, an enum, a date or an amount. The registry is code the line ships and a test pins; a grant cannot register a type, and a body with an unregistered type or a field outside its list is not sent.
- The same rule as before: **ids, types, dates and amounts only**. No message text, no party name, no note, no address, no free text of any kind. The agent reads the detail back through the endpoint, under its grant and the reads of decision 12.
- A line event is sent only to a grant that holds a scope of that line, only for items that grant may read (a member-bound grant: only items that member can open), through the same signed outbox delivery. What the events are (an unanswered conversation, a quote with no answer, a booking tomorrow, an ad over its pace) is the line's rule set, not the kernel's (Engage's are epic #3857 E3).

**As built for Engage (#3862, E3 of epic #3857).** The rules are deterministic and call no model; each is a registered line type, and each also shows on Home with no agent connected.
- *The types.* `engage.conversation_new` (a direct or email thread nobody has answered, in the last day), `engage.conversation_unanswered` (a customer who waited past N hours), `engage.reply_window_closing` (the platform's reply window closes within N hours), `engage.quote_unanswered` (the CRM's follow-up of a sent quote, raised after N days: the same step Home lists), `engage.booking_tomorrow`, `social.post_comment_new` (a comment under a published post), `ads.pace_over`, `ads.daily_cap_over` and `ads.monthly_cap_over` (from `ads.mcp.flags`, the same flags as the Ads screen). Each field is an id, a day, an amount or an enum word; an amount comes with an enum field for its currency (`vnd`, `usd` and others, else `other`).
- *Once per item per window.* Each item has a key `<type>:<id>:<day of its window>` in the table of seen signal keys (the key shape now allows the trailing day). `crove_kernel.mcp_wake_line_check` says which keys are new, and `mcp_wake_enqueue` notes the one key in the same transaction as the event and stores nothing for a key already seen, so two sweeps never both send it. A condition that holds for days fires once; a new window (the customer was answered and wrote again, another day's booking) fires again. A line key is forgotten after 90 days.
- *Reads as the grant.* The sweep reads each feed as the grant (an MCP actor holding the grant's own scopes, in the worker's sealed entry), before it looks at the signals (the worker's entry closes once `signals_checked_at` moves), and only for a company grant that holds the type's line scope and the read scope (`mcp_wake_line_plan`). The two reads that are new, `kernel.wake.conversations` and `crm.wake.facts`, answer ids, a kind, instants, a day and an amount, through strict schemas.
- *N is the org's.* Hours before a conversation counts as unanswered (default 4), hours before a reply window closes (default 3) and days a sent quote waits (default 5) live on the inbox settings row, set by an owner or admin in Settings ("Khi nào nhắc việc"), never on the inbox screen. The CRM's quote follow-up is raised after the org's N, so Home and the coworker agree.
- *Home.* `kernel.wake.today` adds the unanswered, reply window and post comment lines; a booking tomorrow joins `crm.today`; a new inbound conversation, a quote follow-up and the ad flags are already lines of `kernel.conversation.today`, `crm.today` and `ads.today`.

### 14. The role of a grant: stay an owner or admin grant, narrowed by scope

- **Decision: a grant stays an owner or admin company grant (or a member-bound one), narrowed by scope. It does not bind to an ADR-0029 position.** There is still no sales or marketing role to bind to; none is built.
- Reasons. (1) The scope list of decision 11 already narrows what the grant may call, per line, and a proposal gate means nothing above R1 runs without a person. (2) A position makes the agent an org-chart member with a template ceiling, tasks, runs and its own entry (`enter_agent_context`, worker only); an outside coworker connects over a request and has no run, so a position would add machinery (templates, run leases, a `role_key`) that nothing in this flow needs. (3) The narrower-than-company reading the position would give is already there as the **member-bound grant**: a person who wants a coworker to see only their own part makes it as a member grant, and decision 12 reads by that member's rights. (4) The one concrete thing a position would add, a role with fewer rights than an admin that a company grant could hold, is not needed while the scope and proposal limits bound the writes and the sealed context is read only.
- **Revisit when** an org needs a coworker that reads less than its grantor does and no member should stand for it (for instance, a sales coworker that must not read direct messages that an admin may). Then a position (or a role narrower than admin that a company grant may be issued under) comes with its own ADR, with ADR-0029's template ceiling and `le_scope`. Until then the narrowing is the scope and the member binding.
- The grantor remains accountable: an owner or admin makes the grant, the database reads their role live on every call, and demoting them, removing them or revoking the grant closes access at once.

## Considered

- **A. Build the loop in Ludy with the AI SDK** (a proactive agent, conversational memory, a scheduler). Rejected: DOS already has the agent runtime, memory, channels and schedules, and a second loop in Ludy would duplicate them and double the surface that must keep a member's data private.
- **B. Adopt Mastra or LangGraph inside Ludy.** Rejected for the same reason: they would add an agent framework to the kernel's dependency set when the DOS agent stack already provides one, and Ludy needs only a gate.
- **C. One integration per AI vendor.** Rejected: no per-vendor integration code. One standards-conforming MCP server (Streamable HTTP, OAuth 2.1 with PKCE) and one webhook serve every vendor, with the DOS preset as a default value; per vendor Ludy ships only a tested connection guide and, later, directory listings.
- **F. Let a grant run R2 commands directly under a cap, or run R3 when a person pre-approved a class of actions** (amendment of 2026-11-19). Rejected by the owner's own answer ("việc lớn chờ duyệt"): nothing above R1 executes without a person's approval in Ludy.
- **G. Bind a grant to an ADR-0029 position now** (amendment). Rejected for now, with the reasons and the revisit trigger in decision 14.
- **D. Let Paperclip or DOS Claw approvals count as Ludy approvals.** Rejected: money, messages and spend are approved by a person in Ludy (AGENTS.md); an approval made elsewhere is only a request.
- **E. A narrower interim path (a worker in the member's context without these guards).** Rejected already in ADR-0049 decision 1; it stays rejected.

## Consequences

- Platform builds, in this order: the pairing step and `agent_grant` for MCP clients (ADR-0029 decision 8, made concrete), the MCP endpoint over existing commands and queries (read tools first, then commands with approvals unchanged), the member-bound grant, then the signed webhook. Each is its own issue and pull request; the endpoint and the grant touch protected paths and need the Platform PO's security review.
- The plan's phase 2 and 3 are rewritten around the endpoint, the webhook and the DOS side (docs/plan/vy.md sections 4b, 4c, 5, 6 and 8). Q7 and Q8 are answered by this record.
- The plan's "retrieval over text" ADR, which the plan called ADR-0051, is **ADR-0052 (proposed)**, and only if Ludy ever indexes text itself; with the brain on the DOS side the question moves to the agent's memory, and Q3 (no index over private notes and meetings in v1) stands.
- Existing features (Home brief, alerts, meeting summary) are unaffected.
- The amendment of 2026-11-19 is built in slices, each its own pull request on protected paths with a fresh-context security review and invariant tests (#3858): (a) this record; (b) the sealed context that reads conversations and CRM; (c) per-line write scopes and the filtered tool list; (d) R2 and R3 as proposals only for an MCP actor; (e) line events in the wake body. Engage builds its tools on them (E1 reads, E2 R1 writes, E3 wake rules, E4 proposals; epic #3857).

## Open items on the DOS side (not ours to build here)

- The **Ludy connector in DOS Claw**, as DOS has a Crove CRM connector: it speaks the endpoint and the pairing of decision 2 and verifies the webhook of decision 4.
- **work.dos.ai phase 3**: DOS Claw agents on the org chart, and a routine webhook trigger that accepts the signed webhook.
- **One Vy agent serving many members of one org without cross-member leaks**: a per-member grant from Ludy on every call, and a per-member identity in the agent's long-term memory (Honcho), so one member's context never answers another. Ludy enforces its half (a member-bound grant sees only that member); the agent's memory is DOS's to keep apart, and until it is shown to, a shared org agent works in company mode only (no private data).

## Revisit when

- DOS does not deliver the connector or phase 3 within the pilot: the plan's Ask Vy in Ludy is reopened as an owner decision, not built by default.
- An outside client needs a tool that is not an existing command or query: it is added as a command with its risk tier first, never as a special case of the endpoint.
- The agent needs to hold text from Ludy (retrieval over notes or meetings): ADR-0052 and Q3 first.
