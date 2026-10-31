# CRM reference study: modern, AI-native and Vietnamese CRMs

Status: research only, 2026-10-31. Issue [#2122](https://github.com/DOS/Ludy/issues/2122). It adds no code and no roadmap commitment: every "take" below is a recommendation for the owner (AGENTS.md: a new customer-visible feature goes to the owner first). Vietnamese summary for the owner: [crm-reference-study.vi.md](crm-reference-study.vi.md).

Why now: the kernel plan's CRM scope (Phase 3, [crove-os-kernel.md](../plan/crove-os-kernel.md), "Phase 3: CRM + Calendar") names Twenty, Cal.com and Calendly as references. It waits for wedge-customer demand (Decisions 2 and 20). The owner added Clarify on 2026-10-31 as the main reference for Ludy's AI CRM, because they want agents that work in the background. This study prepares that work.

Lens: the owner's focus is core features for one-person companies and SMEs first. Enterprise features (custom objects at scale, SSO, territories, forecasting) are weighed as "later" or "skip" unless a one-person company needs them.

How to read the sources: every fact carries a source id (listed in section 10) and was checked on 2026-10-31 unless noted. "UNVERIFIED" means no vendor page confirmed it. "Search summary" means the fact came from a search-engine summary and not from a page that was opened. Nothing is copied from the vendors: the text is paraphrased and no screenshot is used.

## 1. Findings in brief

1. **Every AI CRM captures first and asks later, but the ones that document it also keep a person in the loop for sends and for suggested changes.** Lightfield documents "Apply or Dismiss" for suggested record updates and a review queue for email drafts; Attio's Ask Attio never applies a change without a click; Day AI can require approval before pushing to an external CRM. Clarify's pages describe agents that update deal stages and records on triggers, and its approval controls are only confirmed in a search result, not in its own docs (S-CL1, S-LF2, S-AT3, S-DY1).
2. **The capture rule is the product.** Lightfield and Attio both default to "selective" capture: only contacts the team emailed or met become records, auto-responders and subscription mail are skipped, and an admin can turn capture off (S-LF1, S-AT1). That default is the model to copy for Ludy, because it keeps junk out of `party`.
3. **Undo is the weakest feature everywhere.** None of the four AI CRMs documents a general undo. Lightfield has a run log and a field history; Attio has a run viewer and says "Undo" is a topic without a page that explains it (S-LF3, S-AT4). Ludy already plans a 24-hour undo for agent R1 writes, which would be a real differentiator, but it is not built (section 6).
4. **Ludy's safety model is stricter than all of them.** Anything derived from an inbound email or message is tainted, and tainted writes are always reviewed by a human ([plan §4.7](../plan/crove-os-kernel.md), P03 and P07). So the "capture from email" job can never run auto-approved. It can run as proposals that a person approves in bulk. That is the main design finding.
5. **What can run unattended today** is narrow: reading, summarizing and nudging from the org's own data (R0 reads; the `kernel.task.*` commands an agent may already run). Section 6 lists it.
6. **Free plans give one-person companies plenty of records but few seats and few automations** (HubSpot Free: 2 users and 1,000 contacts; Attio Free: 3 seats and 50,000 records; Clarify Free: 20,000 records and unlimited seats). Ludy self-hosted has no seat or record cap, which is an advantage to state plainly (S-HS1, S-AT2, S-CL2).
7. **Only Twenty can be self-hosted among the global CRMs studied**, and it mixes AGPLv3 with files under a commercial licence (S-TW9). Ludy is AGPL for the whole repository. Getfly and Bitrix24 offer on-premise or self-hosted editions (S-GF1, S-BX1).
8. **In Vietnam the CRM is bought with Zalo, a phone system and an invoice link.** Every Vietnamese CRM studied sells Zalo and call-center links as paid add-ons or higher plans, and MISA's CRM is attached to its accounting and e-invoice products (section 5). Ludy already has a Zalo OA channel for publishing (Social) and an accounting core, so the gap is the inbox and the call log, not the accounts.
9. **Gaps against the plan's CRM scope** are listed in section 8: deals and pipelines, saved views, custom fields, `record_link`, CSV import for parties, a shared timeline beyond bookings, and the agent pieces.

## 2. What Ludy has today (checked in the repository on 2026-10-31)

| Piece | State | Where |
|---|---|---|
| `party` | Built. `organization` or `person`, name, tax code (unique per org), address, email, phone, `source_trust`, `verified_at/by`. Duplicate hints and "mark duplicate" exist; there is no destructive merge and no CSV import. | `crove_kernel.party`, `packages/kernel/src/parties.ts` |
| `activity` | Built. A record's timeline rows (`record_type`, `record_id`, summary), stamped with the agent that wrote them (`agent_id`). Summaries never carry classified values. | `crove_kernel.activity` |
| One write path | Built. Every state change is a command through `Runtime.execute()`; each command declares risk, side effect and the columns it writes. | [AGENTS.md](../../AGENTS.md) "Rules" |
| Proposals and approvals | Built. Pending proposal, edit as a new revision, four-eyes for R3, an Inbox. Agents may approve only clean, assessed R1 and R2 proposals within `max_risk`, and no command declares agent approvers yet. | [plan §8.3](../plan/crove-os-kernel.md), [ADR-0029](../adr/0029-agents-positions-and-org-chart.md), [agent-autonomy.md](../generated/agent-autonomy.md) |
| Agents in the org chart | Built (Phase 1). Positions, tasks, delegation, escalation, leases, kill switches. The only CRM template is `crm.scheduler`, a deterministic program with no language model. | `modules/crm/src/agent.ts` |
| Calendar C1-C8 | C1 to C5 and C8 done; C6 external calendars done (Google read, then write-back from booking events, merged 2026-10-31); C7 meeting links not checked here. Booking page, event types, team event types, bookings on a party's timeline. | [calendar.md](../plan/calendar.md), [ADR-0024](../adr/0024-calendar-service.md) |
| Notes and to-dos | Built (module `notes`). Notes link to a party, a booking or a document; a shared note on a party writes a fixed-text activity row. | [notes.md](../plan/notes.md) |
| Channels | The `channel` layer exists (Facebook Page, Instagram, Zalo OA, TikTok connections) and is used by Social to publish. The Service inbox that would read messages is Phase 4 and is not built. | [social.md](../plan/social.md), [plan Phase 4](../plan/crove-os-kernel.md) |
| Email | Plan exists (transactional mail and consent-based campaigns). The inbound mail route exists for forwarded e-invoices. No capture of customer mail onto a timeline. | [email.md](../plan/email.md) |
| Saved views | Only inside Social (`crove_social.saved_view`: a member's named filters, shared or private, at most 20 per member). The kernel `saved_view` plus Filter AST in the plan is not built. | `supabase/migrations/20261030210000_crove_social_saved_view.sql` |
| Search | The plan specifies trigram search on unaccented text (so "nguyen" finds "Nguyễn"). I found no `unaccent` in the migrations on 2026-10-31, so I treat it as not built. | [plan, Search v0](../plan/crove-os-kernel.md) |
| Not built | Deals and pipelines, custom fields, `record_link`, `record_share`, `api_key`, `/v1`, `/mcp`, outbound webhooks. | plan "Kernel additions", Phase 3 |

## 3. Global CRMs compared

Pipedrive's own pricing page refused access (HTTP 403), so its prices come from a third party and are marked.

### 3.1 Dimension table

| Dimension | HubSpot (Free, Starter) | Twenty | Attio | Pipedrive |
|---|---|---|---|---|
| Data model | Standard objects (contacts, companies, deals, tickets and more); custom objects Enterprise only (S-HS4, S-HS5) | 5 standard objects; custom objects and fields unlimited on paid tiers; relations one-to-many and many-to-many (S-TW3, S-TW1) | Standard objects plus lists; custom objects need Pro (12 objects) or Enterprise; relations in four cardinalities, both sides updated (S-AT5) | Leads, deals, people, organizations, products, projects; custom fields; a deal links to one person or organization by default (S-PD5) |
| Pipeline and deal UX | Board view with a pipeline selector; Free allows 15 pipelines across object types (S-HS6, S-HS1) | Kanban driven by a select field; table, kanban, calendar (S-TW4) | Kanban views and list kanbans, drag between stages (S-AT6) | Kanban, drag and drop, several pipelines with custom stages; Leads Inbox converts to deals (S-PD1, S-PD5) |
| Saved views and filters | Saved views as tabs on all plans; AND within a group, OR between groups; filter by associated object (S-HS7) | Unlimited views per object, shared or private, AND/OR (S-TW4, S-TW2) | Many saved views, nested AND/OR groups, auto-saved filter changes (S-AT6) | List views with bulk edit; a filter belongs to one view type (S-PD6) |
| Customer timeline | Gmail, Outlook, Exchange or IMAP logs and sends mail (S-HS8); invoices UNVERIFIED | Google and Microsoft mail and calendar on linked records; import can be limited by date or sender (S-TW5); invoices UNVERIFIED | Gmail, Outlook and calendar sync auto-creates people and companies; calendar events on the activity tab (S-AT1); invoices UNVERIFIED | Email sync from Growth up, team inbox on Premium (S-PD2); invoices UNVERIFIED |
| Import | xlsx or csv; dedupe on record id, unique property, email or domain; free tools 20 MB, 50 imports a day (S-HS9) | CSV or API with mapping and duplicate detection; detail pages not read (S-TW2) | CSV; unique attributes (email, domain) match and update; people and companies in separate files (S-AT7) | Excel, Sheets, CSV and "from another CRM"; duplicate rule per object, none for deals (S-PD3, S-PD4) |
| Automation | Free: 1 email-automation action; Starter: up to 50 sales workflows with restricted triggers (S-HS1) | Triggers: record event, manual, schedule, webhook; actions include record CRUD, email, HTTP, code, AI agent (S-TW7) | Workflows on every plan; run cost in workspace credits (S-AT8) | Not in Lite; record and stage triggers from Growth up, admin-only setup (S-PD2, S-PD7) |
| AI | Breeze Assistant, email writer, chatbot builder in Free; the customer agent needs a paid edition (S-HS2) | Chat over CRM data and agents that enrich, draft and flag at-risk deals, inside the permission model; about 100 AI tasks per member per week on Pro (S-TW8, S-TW1) | Ask Attio, custom agents, AI attributes, call intelligence on Pro (section 4) | AI report creation on all plans; email drafting and summaries from Premium (S-PD2); the assistant's plan scope is not stated (S-PD8) |
| Mobile app | iOS and Android: deals, notes, calls, timelines (S-HS3) | No official app found; a community iOS app exists (S-TW10); Android UNVERIFIED | iOS and Android on all plans, call recordings on mobile (S-AT9) | iOS and Android with caller ID, offline mode, audio notes; Android logs all calls, iOS only in-app outgoing (S-PD9, S-PD10) |
| Integrations | Over 2,000 apps; native WhatsApp from Professional hubs; Zalo only through partners (S-HS2, S-HS10, S-HS12) | Google and Microsoft found; WhatsApp, Facebook, Zalo UNVERIFIED | Gmail, Outlook; a WhatsApp app on its marketplace; Zalo UNVERIFIED (S-AT1, S-AT10) | A WhatsApp Business integration and a messaging inbox with Messenger; plan scope UNVERIFIED; no Zalo found (S-PD11) |
| Pricing and free limits | Free: 2 users, 1,000 contacts, 1,000 other records, 2,000 marketing emails a month; Starter lists at $20 per seat (S-HS1) | No free plan, 30-day trial; Pro $9 and Organization $39 per user per month, yearly (S-TW1) | Free: 3 seats, 3 objects, 50,000 records, 200 emails a month; Plus $35, Pro $79 per user per month, yearly (S-AT2) | No free plan found, 14-day trial; about $14 / $39 / $49-59 / $79 per seat per month (third party, S-PD12) |
| Self-hosting and licence | SaaS, no self-host found | Docker Compose with PostgreSQL and Redis; AGPLv3 mostly, some files under a paid enterprise licence, some MIT (S-TW9, S-TW11) | SaaS, no self-host found | SaaS, no self-host found |

### 3.2 What each teaches Ludy

- **HubSpot**: the free tier is the benchmark for a one-person company, and it shows the usual trade: generous records, thin automation, AI and custom objects behind paid tiers.
- **Twenty**: the closest data model to Ludy's plan (people, companies, opportunities, tasks, notes, custom objects, saved views, workflows that can call an AI agent). Its licence mix is a warning: Ludy's rule is one AGPL repository with DOS-specific code in the private Cloud layer ([AGENTS.md](../../AGENTS.md) opening lines). Ludy studies behavior and copies no code, as it does with Cal.diy for the booking page ([Decision 20](../plan/crove-os-kernel.md): a reference, not a dependency).
- **Attio**: the cleanest example of selective capture, relationship attributes and views, and the clearest pricing of AI as credits.
- **Pipedrive**: a pipeline-first product. Its lesson is that a small sales team wants the board, the activity reminder and the phone, and little else.

## 4. AI-native CRMs

The four are SaaS only on every page seen, and none documents Vietnamese or Zalo support (all UNVERIFIED). Per-vendor detail below; the table at the end compares them.

### 4.1 Clarify (the owner's pick)

- **Background work.** Agents fire on a trigger (a new deal, an inbound email, a finished meeting) and then update records, draft follow-ups, flag risks, research accounts, enrich leads and draft outreach. The home page also lists email and calendar sync, call recording with summaries and next steps, new-opportunity detection with automatic deal-stage updates, meeting briefings and an enrichment waterfall for data gaps. A custom field can write its own instructions and autofill itself. A "Rep" agent drafts campaigns and enrolls leads (S-CL1, S-CL3).
- **Needs a person.** Not described on the vendor's pages (UNVERIFIED). Search summaries say approval can be set per action or tool on each agent, and that agents can run fully autonomously; Clarify's own docs do not confirm it.
- **See, correct, undo.** Every action is logged, and the changelog added activity-feed filters on 2026-10-09. Each agent has its own read and write permissions and an active switch. Undo, field locking and confidence scores are not mentioned (UNVERIFIED) (S-CL3, S-CL4).
- **Price.** Free: 1,000 credits a month, 20,000 records, 1 campaign, 3 objects, no workflows or workspace agents. Starter $50 a month. Growth from $1,000 a month, annual only. Unlimited seats on every plan. Credits are per activity (30 for a meeting summary, 1 per campaign email); at zero credits AI pauses and recording continues (S-CL2).
- **Other.** Custom objects launched in April 2026, agents entered early access in May 2026, an MCP beta was announced in January 2026. Chrome, macOS and Windows apps; no mobile app mentioned. SOC 2 Type 2, US hosting only, EU planned (S-CL3, S-CL5).

### 4.2 Lightfield

- **Background work.** Capture is set per connected mailbox to Disabled, Selective (only mail you replied to) or Always. It creates accounts (one per external domain), contacts and meetings with AI summaries, and skips auto-responders and subscription mail; personal domains need their own toggle. Opportunities are not created by default despite marketing copy. Enrichment is added without approval. Automations run AI steps on a trigger or a schedule (S-LF1, S-LF4).
- **Needs a person.** Suggested record updates, such as a stage change, appear as Apply or Dismiss and "nothing is applied automatically". Automation emails go to a "For review" queue: approve, edit or dismiss, and approving sends at once and cannot be undone. Auto-send needs an extra permission that is off by default (S-LF1, S-LF2).
- **See, correct, undo.** Each automation run records its status, trigger, the member it ran as, credits used and each step. Actions outside the run's permissions are blocked and logged. Field values have a history in the activity log (July 2026 release note). A failed run can be replayed from the failed step. There is no general undo: you edit a value, add to a do-not-track list or delete a record (S-LF3, S-LF5).
- **Per-field autonomy.** Each AI field is Off, Suggest or Auto, and the vendor recommends starting on Suggest (S-LF6). This is the clearest autonomy control found in the study.
- **Price.** No free plan, a 14-day trial. Starter $89 per user per month (up to 3 users). Pro $999 and Growth $1,999 per workspace per month, annual. Automations only on Pro and above. Credits are pooled and do not roll over (S-LF7).
- **Other.** Custom objects, multiple pipelines, HubSpot or Salesforce two-way sync, API, MCP and CLI. No native mobile app (S-LF7, S-LF8).

### 4.3 Day AI

Vendor documentation was thin and several pages returned empty, so parts rest on a release-notes aggregator (S-DY3).

- **Background work.** It ingests Gmail, calendar, meetings and Slack into a context graph and maps conversations to people, organizations and opportunities without manual entry. Agents run on a schedule or an event: a deal-risk flag after a recorded meeting, a weekday Slack briefing, inbox triage with draft replies, a Friday stale-deal nudge. "Skills" run on a schedule or trigger and can act through connectors (S-DY1, S-DY2, S-DY3).
- **Needs a person.** A workspace can require approval before data is pushed to an external CRM. Campaign emails wait in a review queue. Slack tool calls can post Approve and Deny cards, and shared channels always ask. Delegated agents can pause in a "Needs Input" state. Whether "nothing went out without your approval" is a setting or a blanket rule is UNVERIFIED (S-DY1, S-DY3).
- **See, correct, undo.** An audit trail "records what ran" with no format given. Agents can read a property's change history and cite the exact message a statement came from. Undo, revert, confidence and field locks are UNVERIFIED (S-DY1, S-DY3).
- **Price.** Priced per agent (a user's assistant), no per-seat fee and no credits. Free $0 with ingestion and search but no agent drafts and no automated skills. Paid from $24 to $800 a month per agent (S-DY4).

### 4.4 Attio's AI

- **Background work.** Mail and calendar sync auto-creates people and companies. The default is Selective (only people the team emailed or met); admins can pick All or None. Workflows (launched June 2026) trigger on a record event, an attribute change, a schedule or a webhook and run with no stated human step. Custom agents run as a workflow block or an AI attribute; the user picks the model and tools, and they are read-only on Attio data by default. AI attributes summarize, classify, complete a prompt or research the web, and are recalculated by hand unless a workflow block is used. Call Intelligence (Pro) records, transcribes and drafts next steps (S-AT1, S-AT3, S-AT11, S-AT12).
- **Needs a person.** Ask Attio never applies changes itself: record, note and task changes need Create, Update or Deny, and email cannot be sent without approval. Web search asks Allow or Deny. A workflow or agent edit stays a draft until Publish (search summary). Approval before workflow or custom-agent writes is UNVERIFIED (S-AT3, S-AT4).
- **See, correct, undo.** A custom-agent run shows what it read, decided and did, and can be paused, cancelled, resumed or replayed; a workflow history and an agent log shipped on 2026-09-23. Web-research attributes can show confidence (green, yellow, red) with reasoning and sources on hover. "Undo" and "Activity and audit" are listed as topics but no fetched page explains them (UNVERIFIED) (S-AT4, S-AT13).
- **Price.** Credits: Free has 250 workspace credits a month, Pro 10,000; a web-research attribute costs 10 credits per record and other AI types 1 (S-AT2, S-AT4). Which plan includes Ask Attio and agents is UNVERIFIED.
- **Other.** MCP on all plans since 2026-02-19 with user-scoped permissions (S-AT14).

### 4.5 Comparison of the four

| | Clarify | Lightfield | Day AI | Attio AI |
|---|---|---|---|---|
| Capture from mail and calendar | Yes, sync and call recording | Yes, per mailbox: Disabled, Selective, Always | Yes, plus meetings and Slack | Yes, Selective by default |
| Auto-creates deals | Detects opportunities, updates stages (S-CL1) | Not by default; suggested | Yes in examples | Via workflows |
| Writes without a person | Documented as automatic; approval gates unconfirmed | Enrichment yes; record changes Suggest or Auto per field | Pushes to external CRM can require approval | Workflows yes; Ask Attio never |
| Sends mail without a person | UNVERIFIED | Off by default; needs a permission | Review queue | Not without approval in Ask Attio |
| Log of agent work | Action log, activity-feed filters | Run log per step, field history | Audit trail, property history | Run viewer, workflow and agent log |
| Undo | UNVERIFIED | None general | UNVERIFIED | UNVERIFIED |
| Pricing model | Credits, free tier, unlimited seats | Per user, then per workspace, no free | Per agent, no credits | Credits plus seats, free tier |
| Mobile | No | No (browser) | UNVERIFIED | Yes |
| Self-host | No | UNVERIFIED | UNVERIFIED | No |

### 4.6 Patterns worth copying, and the traps

- **Copy:** selective capture with an off switch; an autonomy setting per field or per agent (Off, Suggest, Auto); a review queue that links each item to the run that made it; a run log with the permissions the run had; confidence and sources shown on research output; one place to see every agent action (activity-feed filters).
- **Trap 1, silent capture of junk.** Every vendor had to add skip rules for auto-responders, subscription mail and personal domains. Ludy's `party` has a unique tax code and duplicate hints, but no such rules.
- **Trap 2, credits that stop the product.** Clarify and Attio bill AI by credits; at zero, AI pauses. For a one-person company a bill that grows with agent work is a risk, so budgets need a clear stop and a visible meter (Ludy already has per-run budgets and a P01 budget rule).
- **Trap 3, "approve" that cannot be undone.** Lightfield says approving an automation email sends at once and cannot be undone. Ludy treats sending as R2, and the plan's founder exception only allows a delayed, cancellable send to a verified contact from an untainted source (P06).

## 5. Vietnamese SME specifics

Source quality: the Vietnamese vendors publish prices in USD or "contact us" more often than VND, several pages disagree with themselves, and the Zalo prices below come from retail and news sites that repeat 2022 figures. Treat every price as indicative.

### 5.1 The Vietnamese CRMs

| | Getfly | Bitrix24 (Vietnam site) | Base CRM | MISA AMIS CRM |
|---|---|---|---|---|
| For | SMEs, 3 users up to unlimited (S-GF1) | All sizes; CRM inside a collaboration suite (S-BX1) | Businesses of any size, 11,000+ claimed (S-BS1) | B2B, distribution, B2C; pharma, food, cosmetics, machinery (S-MS2) |
| Price | USD only on the page, no free plan; Startup from about $19.82 a month for 3 users and 5,000 records; the Professional price contradicts itself; on-premise from about $2,027 (S-GF1) | Free for 1 to 2 users; Basic $69 a month for 5 users, Standard $144 for 50, per organization not per user; a promotion to 2026-12-10 (S-BX1) | "Contact us"; a base.vn page with VND prices is for another product (S-BS2) | 55,000 / 85,000 / 105,000 / 120,000 VND per user per month, 12-month minimum, free trial, no permanent free plan (S-MS1) |
| Pipeline and data | Lead capture, de-duplication, conversion, automated care scripts, KPI; saved views and import UNVERIFIED (S-GF2) | Sales pipeline from Basic; quotes, invoices and form builder from Standard; automation and call tracking from Professional (S-BX1) | Pipeline with owner, expected revenue and payment date, stalled-deal flags; lead assignment by round-robin, weight, KPI or territory; 360 customer profile (S-BS1, S-BS3) | Customer data, quotes, orders, invoices, KPI; workflows and approvals, lead scoring and API from Professional; Excel or CSV import (S-MS1, S-MS2) |
| Zalo and Facebook | Social CRM add-on: many Fanpages and Zalo OAs in one inbox, comment hiding, reply templates; a Zalo OA link needs the OA's Advanced or Premium package (S-GF2, S-GF3) | Only through marketplace apps: Zalo OA chat and ZNS apps from local partners (S-BX2) | ZNS, hotline, Zalo, Facebook, WhatsApp intake named; OA inbox detail UNVERIFIED (S-BS3) | Facebook, Zalo and ZNS from Professional; one article says personal Zalo can be connected, an older one says Official accounts only (conflict) (S-MS1, S-MS3) |
| Phone | Third-party PBX links (VFone, Caresoft, OmiCall, Callio and others), click-to-call, popup, call log matched on phone number, recordings stay with the PBX vendor (S-GF4) | Built-in telephony on paid plans; Vietnamese providers UNVERIFIED (S-BX1) | Virtual PBX integration listed; providers, click-to-call, recording UNVERIFIED (S-BS4) | Stringee, Omicall, VinaCIS, Viettel integrations (S-MS2) |
| Invoice and accounting | MISA not integrated directly, an API link is possible; e-invoice UNVERIFIED (S-GF5) | Invoices and quotes; no MISA, VNPT, Viettel or Fast link found (S-BX1) | Quote and contract versions, payment gateways; e-invoice provider UNVERIFIED (S-BS3) | Links to AMIS Accounting: customer sync and a sales rep's invoice request that accounting issues; automatic issue from version R65 is a search summary (S-MS2, S-MS4) |
| AI | UNVERIFIED | A CoPilot assistant; Vietnamese support UNVERIFIED (S-BX1) | None on the CRM page (S-BS1) | Free AVA assistant; paid add-on for lead analysis, call summaries, email drafting, business-card scan (S-MS1) |
| Self-host | On-premise edition (S-GF1) | A self-hosted edition exists (S-BX1) | UNVERIFIED | UNVERIFIED |

### 5.2 Market facts that shape the design

- **Zalo is paid and template-bound for outbound.** ZNS is a template message to a phone number, billed per successful delivery, about 200 to 300 VND each depending on the template type (a vendor page with no effective date, so possibly stale) (S-VN1, S-VN2). Zalo OA packages are free at the basic level, and a CRM link to an OA needs a paid package; the prices found conflict and mostly repeat 2022 figures (S-VN3, S-GF3). Ludy already holds an OA connection (OAuth with a 25-hour token, refreshed on a schedule) for publishing, so a message inbox reuses the connection but still needs the OA package the customer pays for.
- **Phone-first is the default workflow.** The match key between a call and a customer is the phone number; the CRM keeps a call log and a link to a recording stored by the phone provider (S-GF4). For Ludy this means `party.phone` needs normalization (0 or +84 forms) before any call or Zalo matching, and a call log is an `activity` row, not a recording store.
- **MISA owns the accounting side.** MISA sells its CRM inside an accounting and e-invoice ecosystem (AMIS Accounting, meInvoice), so "sales rep requests an invoice, accountant issues it" is the flow SMEs know (S-MS4). Ludy's own accounting module is the natural place for the same hand-off, with no dependency on MISA. A MISA link is an integration question for the Accounting line.
- **E-invoice rules.** Decree 123/2020 is the base rule; Decree 70/2025 (effective 2025-06-01) amends it and widens the cases where e-invoices are mandatory, including some households above 1 billion VND a year; Circular 32/2025 replaced Circular 78/2021 (search summaries, pages not opened) (S-VN4, S-VN5). A claim about an e-invoice data transfer on 2026-07-01 and two 2026 decrees is UNVERIFIED. The Accounting line must confirm these before anything customer-visible relies on them.
- **Vietnamese-language search.** No vendor page confirmed search without diacritics (all UNVERIFIED), though the need is clear: typing "nguyen" for "Nguyễn". Ludy's plan has it for search and I found no implementation yet (section 2).

## 6. Background agents in Ludy

Recommendations only. No invariant changes without the owner. The facts about Ludy's rules are from [ADR-0029](../adr/0029-agents-positions-and-org-chart.md), [plan §4.7 and §8](../plan/crove-os-kernel.md) and [agent-autonomy.md](../generated/agent-autonomy.md).

### 6.1 The rules that decide everything

1. **An agent never writes a proposal itself.** It records its wish as an outbox event under the lease of its task. A system command in the worker re-checks the event and creates the proposal (`kernel.task.propose`, then `kernel.agent.proposal.create`).
2. **Taint follows data.** Anything from an email, a message, a webhook or a public form is `external`. A run that reads it is tainted from that step, loses its write and send tools, and may only propose (P03, P07; [plan §8.5](../plan/crove-os-kernel.md)).
3. **Flags on a proposal.** P03 tainted, P04 the command writes a `contact` or `payment` column (a party's email or phone is `contact`), P05 for R3, P06 for R2, P07 when the task chain did not start from a human.
4. **An agent approves only a clean proposal.** All of these must hold: the command is R1 or R2 and declares `agentApprovers` for the agent's role; the proposal has no P03 to P07 flag and its flags were assessed (never NULL); the risk is within the agent's `max_risk`; the agent is not an author and not in the causal chain or the reporting line; the run is live and untainted; no kill switch applies (ADR-0029 "Conditions"). R3 is always a person.
5. **Today no proposal command declares agent approvers**, so agents approve nothing yet ([agent-autonomy.md](../generated/agent-autonomy.md): "None today").
6. **What an agent may run by itself** are R0 reads and the seven R1 `kernel.task.*` commands (check out, comment, delegate, escalate, propose, set status, approve a proposal), which write tasks and comments, not customer records.

### 6.2 Which agent jobs from the AI CRMs fit

"Auto" means no person is needed at the moment of the write. Everything marked "person" can still be fast if the Inbox lets a person approve many at once.

| Job seen in the AI CRMs | Source of data | How it runs in Ludy | Why |
|---|---|---|---|
| Customer summary, next-step suggestion, meeting brief | Org's own records (R0 read) | **Auto, no write.** Compute on read or show as a draft note | A read needs no proposal. Storing the text would be a write of AI output, so keep it a view, or a note marked as AI output |
| Stale-deal and overdue-task nudges | Org's own records only (untainted) | **Auto.** The agent comments on or escalates a task (`kernel.task.comment`, `escalate`), as `crm.scheduler` already does for cancelled bookings | Reads internal data and uses commands an agent may run without approval |
| Offer new slots after a cancelled booking | Org's calendar | **Auto, exists** (`crm.scheduler`); a person decides whether to invite again | Built; the agent never books or mails |
| Duplicate hints on parties | Org's own records | **Auto hint, person decides.** A hint is a read (`kernel.party.duplicate_hints`); marking a duplicate stays an owner or admin action | `mark_duplicate` changes what the team sees; owners and admins only today |
| Create people and companies from email and calendar | Inbound mail (external, tainted) and the contact fields (P04) | **Person.** A proposal flagged P03 and P04; the agent cannot approve it | Tainted and writes a contact column. A selective capture rule (see 6.3) cuts the volume; bulk approval removes the click cost |
| Log a mail, call or meeting on the timeline | Inbound content | **Person, in bulk.** An `activity` row about an external message is tainted R1 | Plan table: an agent triggered by email or events gets "review" at R1 |
| Update a deal's stage from what a customer wrote | Inbound content | **Person.** Tainted R1; and a stage that moves to "won" with an amount should read as R2 or higher if it triggers an invoice or a send | P03; a money consequence needs the stricter rule (P05, P08) |
| Enrichment from the web | Public web (external), egress job | **Skip for now, or person.** An egress job is at least R2 and the plan bans arbitrary URL fetches (§8.5) | Enrichment is the one job where the AI CRMs apply data without approval (Lightfield, Attio). Ludy cannot copy that |
| Draft a follow-up email | Customer mail (tainted) | **Draft only; sending is R2, person.** The Email plan already says AI output always lands as a draft | The P06 founder exception needs an untainted source, which a reply to a customer's mail is not |
| Send a follow-up or outreach | External effect | **Person (R2).** Cold outreach and bought lists are outside Ludy's Email plan | Decree 91/2020 anti-spam and the Email plan ("Not in Email") |
| Transcribe a call | Audio file to the AI endpoint | **Person to start, result tainted.** `kernel.file.reextract` is R2 since #1662 because the file leaves for the AI endpoint | Egress rule |
| Anything touching an invoice, payment or payee | Finance | **Person, R3.** Four-eyes and `aal2` | P05, P09 to P11; not a CRM-agent job |

Short answer: **auto-approved work is limited to reading, summarizing, nudging and scheduling from the org's own data. Everything that comes from outside, which is most of what the AI CRMs advertise, is a proposal a person approves.** The way to match their speed is not to loosen the rules but to make approval cheap (6.3).

### 6.3 What to build to make unattended agents useful (missing kernel pieces)

All are recommendations for the owner, in the order I would take them. None exists today unless stated.

1. **Selective capture rules** (an org setting like Lightfield's and Attio's: Off, Selective, Always, with skip rules for auto-responders, subscriptions and personal domains, and a do-not-track list). Needs an inbound path that puts customer mail in front of a deterministic matcher before any model reads it. The e-invoice mail route is the only inbound mail path today.
2. **A CRM Inbox with bulk approve.** Group proposals by source (for example "12 contacts from this week's mail") and let a person approve, edit or reject the group. P08 already escalates anything above 20 records, so bulk decisions need a rule for the group size.
3. **Agent-declared approvers for narrow CRM commands.** At least one R1 or R2 proposal command that declares `agentApprovers` and no contact or payment column, so the machinery of ADR-0029 is used once on a harmless job. Note the limit: a clean proposal cannot come from tainted data, so this serves only jobs built on the org's own data.
4. **A language-model runner behind position-agent templates.** Templates are deterministic today (ADR-0029 "Not in Phase 1"), and agent schedules are not built, so a "weekday briefing" or "stale-deal Friday" needs a schedule trigger.
5. **A 24-hour undo for agent R1 writes.** The plan promises it (`reversibleBy`, [§8.3](../plan/crove-os-kernel.md)); I found the field only in the plan text, no undo command or screen. None of the four AI CRMs documents a general undo, so this would lead the field.
6. **An agent view on the timeline.** `activity.agent_id` already marks agent-written rows. Missing: a filter "what did agents do" per party and per day (Clarify added this on 2026-10-09), the run that made each row, and the proposal it came from.
7. **Provenance and confidence per field.** `source_trust` exists on the party row only. AI CRMs show where a value came from (Day AI jumps to the source message; Attio shows confidence and sources). A per-field source would serve Vietnamese users who check Zalo chats against the CRM.
8. **Per-agent budget and a visible meter.** The P01 budget re-check is listed as left in ADR-0029's follow-ups (#435); AI CRMs bill by credits, so users expect a meter and a hard stop.
9. **MCP access for the user's own assistants.** All four AI CRMs expose MCP (S-AT14, S-CL3, S-LF8, S-DY3). Ludy's `/mcp` waits for ADR-0032 and a decision on grants. Everything an outside assistant writes would still be a proposal.

### 6.4 One decision that needs the owner

The AI CRMs let capture write straight into records. Ludy's rules do not. If the owner wants to go faster than bulk approval, the plan already has a pattern: the P05 and P06 "founder exceptions" (allowlisted class, delayed and cancellable, verified counterparty, untainted). A comparable exception for **append-only timeline logging from a verified sender, with no contact field written and a 24-hour undo** would change an invariant (P03). I do not recommend it before the pilot shows that bulk approval is too slow. Section 9, decision 2.

## 7. Take, skip or later, by dimension

Verdicts weigh the owner's focus (one-person companies and SMEs first). "Builds on" names what Ludy already has.

| Dimension | Verdict | Builds on | Reason |
|---|---|---|---|
| Data model: people and companies | **Take** | `party` (person or organization, tax code, verified) | Every product stores people and companies; Ludy already has them with the Vietnamese tax code as a key |
| Data model: deals | **Take** (when demand pulls) | `party`, `activity`, calendar bookings (plan: a booking links to a deal) | Pipelines are the core of every CRM studied and the plan's Phase 3 names them |
| Data model: custom fields | **Later** | Plan "Kernel additions: custom fields"; manifest column classes | One-person companies rarely need them at first; Twenty and Attio offer them, HubSpot gates custom objects to Enterprise. The column-class system (`contact`, `payment`) must cover each custom field before agents may write one |
| Data model: custom objects | **Skip** | none | Enterprise feature in HubSpot and Attio Pro; no one-person company asked; each one multiplies RLS, audit and agent-rule work |
| Pipeline: one kanban with stages | **Take** | `party`, `activity`, `crm` module | Universal across all products; small to build once deals exist |
| Pipeline: several pipelines, weighted forecast | **Later** | none | HubSpot Free allows many, but a one-person company starts with one; forecasting is an enterprise habit |
| Saved views: named filters, shared or private | **Take** | Social's `saved_view` (shape: named filters, shared flag, per-member cap) | Same need in every product. Build the kernel `saved_view` and Filter AST the plan already lists, and move Social onto it, rather than copy it in CRM |
| Saved views: nested AND/OR groups | **Later** | Filter AST | Attio, HubSpot and Twenty have them; simple AND filters serve a small team first |
| Timeline: bookings, notes, accounting documents | **Take** | `activity`, bookings on the party's timeline (C5), notes links, finance documents that name a party | Already partly there; the study found no product that wins on this axis |
| Timeline: email and chat messages | **Later** | Inbound mail route, `channel` layer, Service inbox (Phase 4, not built) | Every product has it, and so does every VN CRM; it needs the capture rules (6.3) and the Service inbox first |
| Timeline: invoices | **Take** (as a link) | Finance documents with a party | No product proved an invoice timeline; Ludy has the ledger, so it can lead for Vietnamese SMEs. Accounting line to confirm what a sales invoice record exposes |
| Import: CSV or Excel with dedupe | **Take** | `party` unique tax code, duplicate hints, `mark_duplicate`; P08 for more than 20 records | The first thing a switching customer does; HubSpot dedupes on email or domain, Attio on unique attributes. Add phone normalization and `.xlsx`, and run the import as a reviewed batch |
| Import: "from another CRM" connectors | **Skip** | none | Pipedrive's feature; an SME can export a file. Keep to file import |
| Automation: generic visual workflow builder | **Skip** | The kernel process engine named in the Email plan | Twenty, Attio and HubSpot have one; building a second engine next to the planned kernel one would split the audit story |
| Automation: event-driven agent templates | **Take** | Outbox events, `crm.scheduler`, `kernel.task.*` | Matches Day AI's and Clarify's triggers (booking, deal, meeting), and runs inside the existing approval rules |
| AI: summary, next step, brief (R0) | **Take** | Position agents, `packages/agent` (`summary.ts`, `scheduling.ts` are the closest examples) | A read with no write; the plan's CRM scope already lists it |
| AI: capture from mail and calendar | **Later** | Inbound mail route, proposals, P03 and P04 flags | The headline feature of all four AI CRMs; it needs selective rules and bulk approval first (6.3) |
| AI: auto-enrichment from the web | **Skip** | none | Egress at R2 and the no-arbitrary-fetch rule; the AI CRMs apply it unreviewed, which Ludy cannot |
| AI: prospecting and cold outreach | **Skip** | none | Outside Ludy's Email plan and the anti-spam decree (Decree 91/2020 as cited there) |
| AI: drafts of follow-ups | **Take** (draft only) | Email plan "AI: drafts and rewrites ... always landing as drafts" | Every AI CRM drafts; sending stays R2 |
| AI: per-field autonomy (Off, Suggest, Auto) | **Later** | Manifest column classes, P03 | Lightfield's design is the clearest; in Ludy "Auto" would never exist for tainted data, so offer Off and Suggest |
| Mobile app | **Later** | Web SPA, push for approvals in the plan | HubSpot, Pipedrive, Attio and MISA ship apps, Clarify and Lightfield do not. Phone-first teams need a phone-friendly web page and `tel:` links before a native app |
| Integrations: Zalo OA inbox | **Later**, but first among channels | `channel` layer with the Zalo OA connection (OAuth, refresh) | Every Vietnamese CRM sells it; Ludy has the connection for publishing. Needs the Service inbox and the customer's OA package |
| Integrations: Zalo personal | **Skip**, until checked | none | One vendor says it connects personal Zalo and another says Official accounts only; I did not verify Zalo's terms for personal accounts. Do not build before the owner or a lawyer checks |
| Integrations: Facebook Messenger | **Later** | `channel` layer with Facebook Page | Same Service-inbox dependency; Pipedrive and HubSpot reach it through partners or a paid inbox |
| Integrations: phone system (PBX) | **Later** | `party.phone`, `activity` | Vietnamese CRMs link third-party cloud PBXs; recordings stay with the vendor. A first slice is a `tel:` link and a call note, with a PBX webhook only on demand |
| Integrations: Google and Microsoft mail and calendar | **Take** (calendar done, mail later) | Calendar C6 (Google busy read and write-back) | Twenty and Attio use them as the timeline's source; the calendar half is merged, the mail half belongs to the capture rules |
| Integrations: MISA and e-invoice | **Later** | Ludy accounting; the e-invoice receive path | The sales-to-invoice request flow is what SMEs know from MISA; the Accounting line decides whether to link or just offer its own flow |
| Pricing and free-plan limits | **Skip here** | Cloud pricing is sold per app and lives in the private layer (Decision 10) | Report only: Ludy self-hosted has no seat or record cap, which beats every free plan above. Pricing is not decided in the public repository |
| Self-hosting and licence | **Take** (state it) | AGPL whole repository, `docker compose up` | Twenty is the only global CRM that self-hosts, and it mixes licences; Getfly and Bitrix24 sell on-premise. A clean AGPL and a Compose start is a differentiator for Vietnamese SMEs who keep data in-house |
| Vietnamese-language search | **Take** | Plan "Search v0" (trigram on unaccented text) | No vendor confirmed it; it is cheap, visible, and every Vietnamese user needs it |

## 8. Gaps against the plan's CRM scope

Each gap is a recommendation for the owner, not an issue. The plan's CRM scope (Phase 3) is: contacts and companies as `party`; deals and pipelines; saved views, custom fields, record sharing; CSV import; a shared customer timeline (email, appointments, conversations, tickets, contracts, invoices); AI summaries, next steps and email drafts, every write a proposal.

| Gap | State on 2026-10-31 | Recommendation |
|---|---|---|
| Deals and pipelines | Not built | First slice of CRM when demand pulls (decision 1) |
| Kernel `saved_view` and Filter AST | Not built; Social has its own | Build once in the kernel and move Social onto it, to avoid two models |
| Custom fields | Not built | Later; each field needs a data class before agents may touch it |
| `record_link` | Not built; notes has `crove_notes.link` | Decide with the deals slice whether notes' link moves onto it |
| `record_share` | Not built | Later; a one-person company has no sharing need |
| CSV or Excel import for parties | Not built; duplicate hints exist | Take, as a reviewed batch with phone and tax-code matching |
| Shared timeline: email and chat | Only bookings, notes and calendar rows; mail and chat need Service Phase 4 and the capture rules | Later, as section 6.3 items 1 and 2 |
| Shared timeline: invoices, contracts | Finance documents name a party; contracts belong to Sign (not built) | Take invoices as a link; contracts wait for Sign |
| AI summaries and next steps for CRM | Not built for CRM; Social has a summary and scheduling has a message reader | Take as a read-only view |
| AI email drafts for CRM | Email plan covers drafts; no CRM entry point | Take as drafts only |
| Search without diacritics | Planned, no implementation found | Take |
| Agent pieces (section 6.3) | Capture rules, bulk approval, agent approvers, language-model runner and schedules, undo, agent timeline view, per-field provenance, budget meter | Take in the order of 6.3 |
| `/mcp`, `/v1`, outbound webhooks | Not built; ADR-0032 pending | All four AI CRMs expose MCP; keep it on the plan and decide the order after deals |

## 9. Decisions for the owner

One at a time, recommendation first. If there is no answer, nothing here starts.

1. **Which CRM slice goes first when a wedge customer asks?** Recommendation: deals with one pipeline and a kanban board, kernel saved views with simple filters, and CSV or Excel import with duplicate checks. Skip custom objects and several pipelines until someone asks. Without an answer, CRM waits as Decision 2 already says.
2. **How fast may background agents go?** Recommendation: keep the rule that everything derived from outside content is a proposal a person approves, and build bulk approval plus selective capture to make it fast. Do not add an auto-accept exception (section 6.4) before the pilot shows bulk approval is too slow.
3. **Is "capture customers from email and calendar" the flagship AI CRM feature?** Recommendation: yes, after deals exist, with Selective as the default, skip rules for auto-responders and personal domains, and a visible off switch. It is the feature all four AI CRMs lead with. Without an answer, the AI CRM stays at read-only summaries and drafts.
4. **Which Vietnamese channel first?** Recommendation: Zalo OA messages on the customer's timeline (through the Service inbox), then a phone-number click-to-call and call note, then a sales-to-invoice request link with Accounting. Zalo personal accounts only after the owner or a lawyer checks Zalo's terms. Without an answer, Service and channels stay on the plan's order.

## 10. Sources

All checked on 2026-10-31. A page marked "(search summary)" was not opened.

**Vietnamese CRMs and market**
- S-GF1 https://getfly.vn/en/pricing.html
- S-GF2 https://getfly.vn/en/product/Social-CRM.html and https://getfly.vn/product/quan-ly-doanh-nghiep-toan-dien-voi-12-module-mo-rong-cua-getfly-crm.html
- S-GF3 https://helpdesk6.getfly.vn/faq-cau-hoi-thuong-gap/cau-hoi-ve-facebook-zalo
- S-GF4 https://wiki.getfly.vn/portal/post/1578
- S-GF5 https://helpdesk.getfly.vn/web-version/interactive-blocks/questions-about-software-integration
- S-BX1 https://www.bitrix24.vn/prices/ and https://www.bitrix24.vn/
- S-BX2 https://www.bitrix24.com/apps/app/eqvn.eqvn_zalo/ and https://www.bitrix24.com/apps/app/eqvn.eqvn_esms/
- S-BS1 https://signup.base.vn/base-crm/
- S-BS2 https://base.vn/blog/phan-mem-crm/ and https://base.vn/test/pricing (another product)
- S-BS3 https://signup.base.vn/dang-ky-demo-base-crm/
- S-BS4 https://base.vn/blog/phan-mem-crm/
- S-MS1 https://amis.misa.vn/bang-gia-phan-mem-misa-amis-crm/
- S-MS2 https://amis.misa.vn/crm/
- S-MS3 https://amis.misa.vn/294627/quan-ly-zalo-nhan-vien/ and https://amis.misa.vn/69068/zalo-crm/ (search summary)
- S-MS4 https://amis.misa.vn/143637/tu-dong-xuat-hoa-don-tu-de-nghi-xuat-hoa-don-duoc-dong-bo-tu-amis-ban-hang/ (search summary)
- S-VN1 https://zalo.solutions/zns/pricing
- S-VN2 https://www.infobip.com/blog/zalo-business
- S-VN3 https://viettelstore.vn/tin-tuc/zalo-oa-co-mat-phi-khong and https://cellphones.com.vn/sforum/zalo-thu-phi-nguoi-dung
- S-VN4 https://www.meinvoice.vn/tin-tuc/31439/nghi-dinh-70-2025-nd-cp-sua-doi-nghi-dinh-123/?lang=vi
- S-VN5 https://www.meinvoice.vn/tin-tuc/34635/thong-tu-32-2025-tt-btc-thay-the-thong-tu-78/ and https://thuvienphapluat.vn/ma-so-thue/phap-luat-thue/thong-tu-782021ttbtc-con-duoc-ap-dung-khong-thong-tu-32-thay-the-thong-tu-782021ttbtc-206487.html (search summaries)

**HubSpot**
- S-HS1 https://www.hubspot.com/pricing/crm
- S-HS2 https://www.hubspot.com/products/crm
- S-HS3 https://www.hubspot.com/products/mobile
- S-HS4 https://knowledge.hubspot.com/records/use-custom-objects
- S-HS5 https://knowledge.hubspot.com/properties/create-and-edit-properties
- S-HS6 https://knowledge.hubspot.com/records/manage-records-in-board-view
- S-HS7 https://knowledge.hubspot.com/records/view-and-filter-records
- S-HS8 https://knowledge.hubspot.com/connected-email/connect-your-inbox-to-hubspot
- S-HS9 https://knowledge.hubspot.com/import-and-export/set-up-your-import-file
- S-HS10 WhatsApp availability, from a search result, secondary
- S-HS12 https://community.hubspot.com/t/zalo-sms-integration-from-vietnam/36111

**Twenty**
- S-TW1 https://twenty.com/pricing
- S-TW2 https://docs.twenty.com/getting-started/key-features.md
- S-TW3 https://docs.twenty.com/getting-started/core-concepts/data-model.md
- S-TW4 https://docs.twenty.com/getting-started/core-concepts/layout.md
- S-TW5 https://docs.twenty.com/getting-started/core-concepts/calendar-and-email.md
- S-TW7 https://docs.twenty.com/getting-started/core-concepts/workflows.md
- S-TW8 https://docs.twenty.com/getting-started/core-concepts/ai.md
- S-TW9 https://docs.twenty.com/developers/self-host/capabilities/docker-compose.md and https://raw.githubusercontent.com/twentyhq/twenty/main/LICENSE
- S-TW10 https://apps.apple.com/us/app/-/id6760371090
- S-TW11 https://github.com/twentyhq/twenty

**Attio and Attio AI**
- S-AT1 https://attio.com/help/reference/email-calendar/email-and-calendar-syncing
- S-AT2 https://attio.com/pricing
- S-AT3 https://attio.com/help/reference/attio-ai/ask-attio/chat-with-ask-attio
- S-AT4 https://attio.com/help/reference/attio-ai/ai-attributes and https://attio.com/changelog/2026
- S-AT5 https://attio.com/help/reference/attio-101/attios-data-model/define-your-data-model-objects-lists-and-views.md
- S-AT6 https://attio.com/help/reference/managing-your-data/views
- S-AT7 https://attio.com/help/reference/imports-and-exports/import-data-into-attio
- S-AT8 https://attio.com/help/reference/automations/workflows/getting-started-with-workflows
- S-AT9 https://attio.com/changelog/2026 (mobile entries)
- S-AT10 https://attio.com/apps/whatsapp-integration
- S-AT11 https://attio.com/platform/ai
- S-AT12 https://attio.com/platform/custom-agents/llms.txt
- S-AT13 https://attio.com/changelog/2026 (workflow history and agent log, 2026-09-23)
- S-AT14 https://attio.com/help/reference/attio-ai/attio-mcp

**Pipedrive**
- S-PD1 https://www.pipedrive.com/en/features/pipeline-management
- S-PD2 https://support.pipedrive.com/en/article/what-features-do-the-pipedrive-plans-have
- S-PD3 https://www.pipedrive.com/en/features/data-import-export
- S-PD4 https://support.pipedrive.com/en/article/how-to-avoid-duplicates-during-an-import
- S-PD5 https://developers.pipedrive.com/docs/api/v1/Leads and https://developers.pipedrive.com/docs/api/v1/DealFields
- S-PD6 https://support.pipedrive.com/en/article/bulk-editing-and-filtering
- S-PD7 https://www.pipedrive.com/en/features/workflow-automation
- S-PD8 https://www.pipedrive.com/en/features/ai-sales-assistant
- S-PD9 https://support.pipedrive.com/en/article/what-features-do-the-mobile-apps-have
- S-PD10 https://support.pipedrive.com/en/article/calling-and-logging-calls-in-the-mobile-app
- S-PD11 https://pipedrive.com/en/newsroom/pipedrive-launches-messaging-inbox-and-integrations-with-whatsapp-facebook-messenger-and-docusign
- S-PD12 https://www.activepieces.com/blog/pipedrive-pricing-plans-and-total-costs-for-2026 (third party; the official page refused access)

**Clarify**
- S-CL1 https://www.clarify.ai/ and https://www.clarify.ai/agents
- S-CL2 https://www.clarify.ai/pricing
- S-CL3 https://www.clarify.ai/changelog
- S-CL4 https://www.clarify.ai/agents (activity log, per-agent permissions)
- S-CL5 https://www.clarify.ai/security and https://docs.clarify.ai

**Lightfield**
- S-LF1 https://support.lightfield.app/articles/3050423158-understanding-how-lightfield-captures-data
- S-LF2 https://docs.lightfield.app/help/for-review/ and https://docs.lightfield.app/help/automations/
- S-LF3 https://docs.lightfield.app/help/automations/runs-and-held-runs/
- S-LF4 https://lightfield.com/
- S-LF5 https://releases.sh/lightfield/releases
- S-LF6 https://support.lightfield.app/articles/5376509474
- S-LF7 https://lightfield.com/pricing
- S-LF8 https://support.lightfield.app/articles/6009860984-is-there-a-lightfield-mobile-app

**Day AI**
- S-DY1 https://day.ai
- S-DY2 https://day.ai/product
- S-DY3 https://releasebot.io/updates/day-ai (an aggregator; vendor docs and changelog pages returned empty)
- S-DY4 https://day.ai/pricing

**Not verified in this study**
- Per-action approval and any undo in Clarify; undo in Lightfield, Day AI and Attio.
- Saved views, import and AI features of Getfly; e-invoice links of Getfly, Bitrix24 and Base CRM; Base CRM prices in VND; Bitrix24 per-user prices in VND.
- Zalo's terms for personal accounts; current Zalo OA package prices; the 2026-07-01 e-invoice milestone and the two 2026 decrees.
- Invoice timelines, self-hosting and mobile status where a cell says UNVERIFIED.
- Pipedrive's official prices and record caps.
