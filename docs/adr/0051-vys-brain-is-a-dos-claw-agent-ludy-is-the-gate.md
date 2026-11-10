# 0051. Vy's brain is a DOS Claw agent; Ludy is the gate

- Status: Accepted (2026-11-10) as a direction. The owner decided it on 2026-11-10 in the Platform PO chat (the popup answer "Đồng ý", on the proposal in the Context below). The mechanism of decisions 2 to 4 is accepted by the Platform PO with the pull request that builds each part.
- Date: 2026-11-10
- Deciders: owner (JOY) for the direction; the Platform PO for the mechanism
- Builds on: [ADR-0029](0029-agents-positions-and-org-chart.md) (agents, positions, the write allowlist, decision 8: runtimes are adapters, the `agent_grant`); [ADR-0049](0049-member-scoped-vy.md) (Vy working under one member's rights); [ADR-0018](0018-untrusted-content.md) (untrusted content); the approval and risk tiers (R0 to R3), the AI budget meter (#2382) and the kill switches (#886)
- Supersedes: the "outside agent platforms" and "a quick DOS option" parts of [docs/plan/vy.md](../plan/vy.md) sections 4b and 4c, and the plan's phase 2 "Ask Vy in Ludy" and phase 3 "general manager agent template in Ludy"
- Amends by reference: ADR-0029 decision 8 (it gets its concrete door, the MCP endpoint of decision 2) and its general manager template (it lives on the DOS side, decision 5). ADR-0049 is not changed: its ports and the existing member-mode features stay.
- Plan: [docs/plan/vy.md](../plan/vy.md); the Vietnamese summary for the owner is [0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.vi.md](0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.vi.md)

## Context and problem statement

The Vy plan (2026-11-10, section 4b and 4c) kept Vy's reasoning inside Ludy on a model port and left a door open for outside agent platforms (Claude Code, OpenAI Agents, Google agents, OpenClaw) through an MCP endpoint, with two open questions for the owner (Q7: what DOS Claw is and how it pairs; Q8: whether the DOS preset lives in the open core). Phases 2 and 3 of the plan would have built Ask Vy, a question router and a general manager agent inside Ludy, with an agent loop of our own.

DOS already runs the agent side. As the Platform PO described it from the DOS and DOS.AI repositories (this ADR does not verify them; the DOS side owns their truth):

- **DOS Claw** is one OpenClaw or Hermes container per agent. Its model calls go through the DOS.AI gateway (api.dos.ai). It has long-term memory (Honcho) and Telegram and Zalo channels, and the gateway manages its MCP tools with a capability token per agent. The agent is denied the `cron` tool.
- **work.dos.ai** is a pinned Paperclip release (MIT). It provides the org chart, issues and delegation, heartbeats, and routines triggered by cron or by an HMAC-signed webhook. Its phase 3, DOS Claw agents on the chart, is designed and not live.
- Ly, Dy and Uy are meant to be DOS Claw agents under Vy on that chart. Delegation goes through work.dos.ai, and any business effect goes through Ludy.

The owner decided on 2026-11-10: **Vy's agent brain is a DOS Claw agent on work.dos.ai, not something built in Ludy.** Ludy keeps what only Ludy can keep: the data, the permission boundary and the approvals.

## Decision

1. **Ludy builds no agent loop.** No proactive model loop, no conversational memory and no agent scheduler in Ludy. Vy's reasoning, memory, channels, delegation to Ly, Dy and Uy, and schedules are the DOS Claw agent's and work.dos.ai's. Ludy is the **gatekeeper and the source of truth**, and provides exactly three things (decisions 2 to 4).

2. **An MCP endpoint in `apps/kernel`.** One endpoint per org that maps MCP tools to the commands and queries the app already uses, run through `Runtime.execute` (never a second API, never SQL):
   - access is an `agent_grant` bound to `(org, client, agent)` (ADR-0029 decision 8). The grant is created by a pairing step an owner or admin does in Settings (a code the client enters), and revoking it, pausing the agent or a kill switch closes access at once;
   - the tool list is filtered by the grant: a tool exists only for a command or query the grant's role may run, and every tool call is audited with the grant, the client and the agent;
   - risk tiers and approvals apply unchanged. A command above R1 becomes a proposal that a person approves in Ludy. **An approval inside Paperclip or DOS Claw never counts as a Ludy approval**: the gate is Ludy's own, and the agent's wording ("the manager approved it") is data, not an approval;
   - **member mode** (ADR-0049) over MCP: a grant may be bound to one member, and then every call runs in that member's sealed context, so the agent sees only what that member can read and writes only what the member's commands allow. A private note, a result or a memory of one member is never reachable through another member's grant.

3. **The deterministic signal rules stay in Ludy, with no model.** The cross-app rules of the plan's phase 1 (`kernel.signals.*`: V4 a won deal with no sales invoice after 7 days, V5 an overdue receivable with an open deal and a changed supplier bank account with a payment waiting) are Ludy's. They run in the member's own request, show on Home, and are also what the agent is woken for (decision 4). The agent never replaces them and a self-hosted Ludy keeps them.

4. **An outbound signed webhook that wakes the agent.** When a signal fires, or a schedule an org set is due, Ludy sends one webhook to the routine trigger URL the pairing recorded on work.dos.ai:
   - the body carries ids, event type, dates and amounts only: no note text, no party name, no message body (the same rule as `zTodayItem` and the signals contract). The agent reads the detail back through the MCP endpoint, under its grant;
   - it is signed with HMAC-SHA256 over the timestamp and the body, with a per-grant secret that rotates, and carries an event id; the receiver refuses a timestamp outside a replay window (five minutes) and an event id it has seen;
   - delivery is at least once from the outbox with pg-boss retries and a bounded backoff; **Ludy's pg-boss only emits the event.** What the agent does with it is the agent's decision, and a failed delivery never blocks the signal on Home;
   - a signal for a member is sent only for a member-bound grant, and only for items that member can open (the signal ran in their context).

5. **The general manager and the coworkers live on the DOS side.** The "general manager agent template in Ludy" of the plan (C6, V10, V11) is dropped: Vy, Ly, Dy and Uy as DOS Claw agents, their org chart and delegation are work.dos.ai's. Each business effect they cause still goes through decision 2. ADR-0029's org-chart agents in Ludy (positions, tasks, the write allowlist) stay as they are for deterministic template programs.

6. **What stays in Ludy from before.** The member-mode features already built (meeting transcription and summary, ADR-0049 stages A and B) and their model port and meter stay. Ask Vy and a proactive Vy built with an AI SDK inside Ludy are dropped from the plan. AI off remains a supported mode, and every screen works without it.

7. **Principle 1 is kept honestly.** Ludy runs on its own with `docker compose up` and is not locked to one third party. The consequence, stated plainly: **a self-hosted Ludy without DOS has the rule-based alerts on Home and the meeting summary, and no reasoning Vy.** Any MCP client can still pair the same way (OpenAI, Anthropic, Google, OpenClaw): the endpoint and the webhook are generic, and nothing in them names DOS. The **DOS preset** (the endpoint, the DOS ID sign-in and the work.dos.ai webhook URL pre-filled) is an optional adapter, **off by default**, so AGENTS.md's rule that anything DOS-specific stays out of the open core is read as: the open core carries the generic door, and a preset is only a default value for it.

8. **What Ludy does not trust.** The agent's output is tainted data (ADR-0018): it reaches a record only through a command the grant allows, with the same checks as a person's click. A webhook response is not read as an instruction. The agent's own model calls are DOS.AI's and are not metered by Ludy's meter (the meter still covers Ludy's own calls); what Ludy bounds for a grant is its tool rate, its role, and the approvals it cannot skip.

## Considered

- **A. Build the loop in Ludy with the AI SDK** (a proactive agent, conversational memory, a scheduler). Rejected: DOS already has the agent runtime, memory, channels and schedules, and a second loop in Ludy would duplicate them and double the surface that must keep a member's data private.
- **B. Adopt Mastra or LangGraph inside Ludy.** Rejected for the same reason: they would add an agent framework to the kernel's dependency set when the DOS agent stack already provides one, and Ludy needs only a gate.
- **C. One integration per AI vendor.** Rejected: one generic MCP endpoint and one webhook serve every client, with the DOS preset as a default value.
- **D. Let Paperclip or DOS Claw approvals count as Ludy approvals.** Rejected: money, messages and spend are approved by a person in Ludy (AGENTS.md); an approval made elsewhere is only a request.
- **E. A narrower interim path (a worker in the member's context without these guards).** Rejected already in ADR-0049 decision 1; it stays rejected.

## Consequences

- Platform builds, in this order: the pairing step and `agent_grant` for MCP clients (ADR-0029 decision 8, made concrete), the MCP endpoint over existing commands and queries (read tools first, then commands with approvals unchanged), the member-bound grant, then the signed webhook. Each is its own issue and pull request; the endpoint and the grant touch protected paths and need the Platform PO's security review.
- The plan's phase 2 and 3 are rewritten around the endpoint, the webhook and the DOS side (docs/plan/vy.md sections 4b, 4c, 5, 6 and 8). Q7 and Q8 are answered by this record.
- The plan's "retrieval over text" ADR, which the plan called ADR-0051, is **ADR-0052 (proposed)**, and only if Ludy ever indexes text itself; with the brain on the DOS side the question moves to the agent's memory, and Q3 (no index over private notes and meetings in v1) stands.
- Existing features (Home brief, alerts, meeting summary) are unaffected.

## Open items on the DOS side (not ours to build here)

- The **Ludy connector in DOS Claw**, as DOS has a Crove CRM connector: it speaks the endpoint and the pairing of decision 2 and verifies the webhook of decision 4.
- **work.dos.ai phase 3**: DOS Claw agents on the org chart, and a routine webhook trigger that accepts the signed webhook.
- **One Vy agent serving many members of one org without cross-member leaks**: a per-member grant from Ludy on every call, and a per-member identity in the agent's long-term memory (Honcho), so one member's context never answers another. Ludy enforces its half (a member-bound grant sees only that member); the agent's memory is DOS's to keep apart, and until it is shown to, a shared org agent works in company mode only (no private data).

## Revisit when

- DOS does not deliver the connector or phase 3 within the pilot: the plan's Ask Vy in Ludy is reopened as an owner decision, not built by default.
- An outside client needs a tool that is not an existing command or query: it is added as a command with its risk tier first, never as a special case of the endpoint.
- The agent needs to hold text from Ludy (retrieval over notes or meetings): ADR-0052 and Q3 first.
