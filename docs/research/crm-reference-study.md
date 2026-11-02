# CRM reference study: modern, AI-native and Vietnamese CRMs

Status: research only, 2026-10-31; section 4 deepened on 2026-11-02 for Clarify, Lightfield and Day AI (issue [#2343](https://github.com/DOS/Ludy/issues/2343), section 4.7). Issue [#2122](https://github.com/DOS/Ludy/issues/2122). It adds no code and no roadmap commitment: every "take" below is a recommendation for the owner (AGENTS.md: a new customer-visible feature goes to the owner first). Vietnamese summary for the owner: [crm-reference-study.vi.md](crm-reference-study.vi.md).

Why now: the kernel plan's CRM scope (Phase 3, [crove-os-kernel.md](../plan/crove-os-kernel.md), "Phase 3: CRM + Calendar") names Twenty, Cal.com and Calendly as references. It waits for wedge-customer demand (Decisions 2 and 20). The owner added Clarify on 2026-10-31 as the main reference for Ludy's AI CRM, because they want agents that work in the background. This study prepares that work.

Lens: the owner's focus is core features for one-person companies and SMEs first. Enterprise features (custom objects at scale, SSO, territories, forecasting) are weighed as "later" or "skip" unless a one-person company needs them.

How to read the sources: every fact carries a source id (listed in section 10) and was checked on 2026-10-31 unless noted; the facts added in section 4.7 were checked on 2026-11-02. "UNVERIFIED" means no vendor page confirmed it. "Search summary" means the fact came from a search-engine summary and not from a page that was opened. Nothing is copied from the vendors: the text is paraphrased and no screenshot is used.

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
10. **The deep dive on Clarify, Lightfield and Day AI (section 4.7, 2026-11-02) shows three things.** First, community evidence is thin and mostly written by competitors or investors, so ratings (Clarify 4.9 on G2 and Product Hunt, by its own blog and an opened page) say little. Second, for background agents, Clarify and Lightfield both start near $1,000 a month (about 25.8 million VND) for a 3-person team, while Day AI starts under $100 (about 1.9 to 2.3 million VND) with a flat fee per agent; the most repeated complaint about Clarify is unpredictable credit bills. Third, none documents Vietnamese or Zalo. This reinforces recommendations already made (visible budget meter, Zalo first) and adds one: a person's correction must outrank later AI guesses (section 7).

## 2. What Ludy has today (checked in the repository on 2026-10-31)

**Update 2026-11-02.** The owner opened CRM slice 1 on 2026-11-01 ([#2223](https://github.com/DOS/Ludy/issues/2223), plan `docs/plan/crm.md`, kernel Decision 21) and it is merged on `main`: deals (K1), one pipeline board (K2), kernel saved views and the Filter AST (K3), the contacts screen with search without diacritics, a phone key and views (K4), contact import from CSV with staging, duplicate check and preview (K5) and from Excel read in the browser (K6), and the close-out (K7). The shared conversation core and Zalo OA messages are being built ([#2213](https://github.com/DOS/Ludy/issues/2213)). The table below is the state on 2026-10-31; rows that slice 1 overtook say "now built".

| Piece | State | Where |
|---|---|---|
| `party` | Built. `organization` or `person`, name, tax code (unique per org), address, email, phone, `source_trust`, `verified_at/by`. Duplicate hints and "mark duplicate" exist; there is no destructive merge. CSV import: now built (K5, K6). | `crove_kernel.party`, `packages/kernel/src/parties.ts` |
| `activity` | Built. A record's timeline rows (`record_type`, `record_id`, summary), stamped with the agent that wrote them (`agent_id`). Summaries never carry classified values. | `crove_kernel.activity` |
| One write path | Built. Every state change is a command through `Runtime.execute()`; each command declares risk, side effect and the columns it writes. | [AGENTS.md](../../AGENTS.md) "Rules" |
| Proposals and approvals | Built. Pending proposal, edit as a new revision, four-eyes for R3, an Inbox. Agents may approve only clean, assessed R1 and R2 proposals within `max_risk`, and no command declares agent approvers yet. | [plan §8.3](../plan/crove-os-kernel.md), [ADR-0029](../adr/0029-agents-positions-and-org-chart.md), [agent-autonomy.md](../generated/agent-autonomy.md) |
| Agents in the org chart | Built (Phase 1). Positions, tasks, delegation, escalation, leases, kill switches. The only CRM template is `crm.scheduler`, a deterministic program with no language model. | `modules/crm/src/agent.ts` |
| Calendar C1-C8 | C1 to C5 and C8 done; C6 external calendars done (Google read, then write-back from booking events, merged 2026-10-31); C7 meeting links not checked here. Booking page, event types, team event types, bookings on a party's timeline. | [calendar.md](../plan/calendar.md), [ADR-0024](../adr/0024-calendar-service.md) |
| Notes and to-dos | Built (module `notes`). Notes link to a party, a booking or a document; a shared note on a party writes a fixed-text activity row. | [notes.md](../plan/notes.md) |
| Channels | The `channel` layer exists (Facebook Page, Instagram, Zalo OA, TikTok connections) and is used by Social to publish. The Service inbox that would read messages is Phase 4 and is not built. | [social.md](../plan/social.md), [plan Phase 4](../plan/crove-os-kernel.md) |
| Email | Plan exists (transactional mail and consent-based campaigns). The inbound mail route exists for forwarded e-invoices. No capture of customer mail onto a timeline. | [email.md](../plan/email.md) |
| Saved views | Only inside Social (`crove_social.saved_view`: a member's named filters, shared or private, at most 20 per member). The kernel `saved_view` plus Filter AST in the plan: now built (K3, K4). | `supabase/migrations/20261030210000_crove_social_saved_view.sql` |
| Search | The plan specifies trigram search on unaccented text (so "nguyen" finds "Nguyễn"). I found no `unaccent` in the migrations on 2026-10-31, so I treated it as not built. Now built for contacts (K4: search without diacritics). | [plan, Search v0](../plan/crove-os-kernel.md) |
| Not built (deals and pipelines are now built, K1 and K2) | Custom fields, `record_link`, `record_share`, `api_key`, `/v1`, `/mcp`, outbound webhooks. | plan "Kernel additions", Phase 3 |

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
- **Price.** Free: 1,000 credits a month, 20,000 records, 1 campaign, 3 objects, no workflows or workspace agents. Starter $50 a month ($40 if paid yearly, per a price tracker). Growth from $1,000 a month, annual only. Unlimited seats on every plan. Credits are per activity (30 for a meeting summary, 1 per campaign email); at zero credits AI pauses and recording continues (S-CL2). Full plan limits and a worked bill are in section 4.7.1.
- **Other.** Custom objects launched in April 2026. The dates first written here for agents (early access, May 2026) and MCP (beta, January 2026) did not check out on 2026-11-02 and are now UNVERIFIED (section 4.7.1). Chrome, macOS and Windows apps; no mobile app mentioned. SOC 2 Type 2, US hosting only, EU planned (S-CL3, S-CL5).

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
- **Price.** Priced per agent (a user's assistant), no per-seat fee and no credits. Free $0 with ingestion and search but no agent drafts and no automated skills. Paid from $24 to $800 a month per agent; the page says yearly billing, and a vendor guide gives higher monthly list prices (S-DY4). Tiers, skill slots and a worked bill are in section 4.7.3.

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
| Mobile | No | No (browser) | No native app (vendor's own list, S-DY14) | Yes |
| Self-host | No | UNVERIFIED | UNVERIFIED | No |
| Funding (section 4.7) | Announced 2025-06-25: Series A $15M and $22.5M in total per the press release body, though headlines say "raises $22.5M" (UNVERIFIED which is the round); USVP-led (second lead disputed); Seam AI bought 2026-07 | Series A $47M, 2026-09-09, a16z-led; about $128M with Tome (my sum) | Seed $4M 2024-06 and Series A $20M 2026-02, both Sequoia-led; about $24M | Not in this deep dive |
| People (estimate) | 25 to 35, UNVERIFIED | about 40 (a16z job board) | 10 to 42, UNVERIFIED | Not in this deep dive |
| Community rating | G2 4.9 (21, the vendor's blog; page not opened); Product Hunt 4.9 (10, opened) | G2 UNVERIFIED (4.9 from 10, or 5.0 from 2); Product Hunt 895 upvotes, no stars | No usable rating; reviews found are by competitors | Not in this deep dive |
| Main complaint (attributed) | Unpredictable credit bills (MakerStack, competitors) | Price and credit opacity (competitors, a reviewer) | Weak pipeline and forecasting (competitors) | Not in this deep dive |
| 3-person bill, no background jobs | $50 a month, about 1.29 million VND | $267, about 6.89 million VND | $108 to $135, about 2.79 to 3.48 million VND | Not in this deep dive |
| 3-person bill, with background jobs | $1,000 (Growth), about 25.8 million VND | $999 (Pro), about 25.77 million VND | $72 to $90 (3 Turbo), about 1.86 to 2.32 million VND | Not in this deep dive |
| Vietnamese or Zalo | None found; English screens | None found; English screens | None found | UNVERIFIED |
| Release cadence | 11 changelog entries in 90 days | 11 in 90 days | 10 between 2026-08-04 and 2026-10-06 (aggregator; later weeks UNVERIFIED) | Not in this deep dive |

Rate for VND figures: 25,800 per USD (S-FX1), 2026-11-02. The first block of rows was checked on 2026-10-31, the last block on 2026-11-02; details and sources are in section 4.7.

### 4.6 Patterns worth copying, and the traps

- **Copy:** selective capture with an off switch; an autonomy setting per field or per agent (Off, Suggest, Auto); a review queue that links each item to the run that made it; a run log with the permissions the run had; confidence and sources shown on research output; one place to see every agent action (activity-feed filters).
- **Trap 1, silent capture of junk.** Every vendor had to add skip rules for auto-responders, subscription mail and personal domains. Ludy's `party` has a unique tax code and duplicate hints, but no such rules.
- **Copy, added 2026-11-02:** a person's correction outranks a later AI guess (Day AI's vendor guide and We The Flywheel describe it; section 4.7.3).
- **Trap 2, credits that stop the product.** Clarify and Attio bill AI by credits; at zero, AI pauses. For a one-person company a bill that grows with agent work is a risk, so budgets need a clear stop and a visible meter (Ludy already has per-run budgets and a P01 budget rule). The deep dive adds evidence: unpredictable credit bills are the top complaint about Clarify (MakerStack and competitors), Clarify removed its rate card from the pricing page in September 2026, and Lightfield changed its prices five times in about three months (Ahoy, a competitor) (S-CL12, S-CL17, S-LF22). Day AI avoids credits with a flat fee per agent, and its CEO hints that usage pricing may follow.
- **Trap 3, "approve" that cannot be undone.** Lightfield says approving an automation email sends at once and cannot be undone. Ludy treats sending as R2, and the plan's founder exception only allows a delayed, cancellable send to a verified contact from an untainted source (P06).

### 4.7 Deep dive on Clarify, Lightfield and Day AI (added 2026-11-02, issue #2343)

The owner asked for a closer look at the three AI CRMs that work in the background. This part adds money, community reviews, expert views, real pricing and potential. It is research only: no code and no roadmap commitment.

How to read it:
- Every fact here was checked on **2026-11-02** and carries a source id from section 10 ("deep dive" lists). "Search summary" means the fact came from a search-engine snippet and the page was not opened or returned HTTP 403. "UNVERIFIED" means no page confirmed it.
- Community and expert statements are attributed to their source and are not stated as fact. Quotes are short phrases; the rest is paraphrased. No screenshot is used.
- **Bias warning.** Review sites for all three are thin. Most "reviews" and "comparisons" found were written by a competitor (Clarify, Lightfield, Ahoy, Coffee, folk, Fluid, Dreamhub) or by an investor (Madrona, Ascend, a16z, BVP, Sequoia). Each is flagged. No Forbes article and no TechCrunch article after 2024 was found for any of the three.
- **Exchange rate.** 1 USD = 25,796 VND, from open.er-api.com (a mid-market rate, last updated 2026-11-01 00:02 UTC, read on 2026-11-02) (S-FX1). VND figures below use 25,800 and are rounded. A bank's selling rate and a foreign-card fee would add a few percent; sales tax or VAT on a foreign software bill is not included and not checked (UNVERIFIED).

#### 4.7.1 Clarify

**1. Company and money**
- Seattle company founded January 2024. Founders named in the funding press release: Patrick Thompson (CEO) and Austin Hay (COO). Ascend and GeekWire also name Ondrej Hrebicek as CTO and co-founder; Ascend says Thompson and Hrebicek founded Iteratively, which Amplitude bought in 2021 (S-CL6, S-CL7, S-CL8 search summary).
- **Funding, announced 2025-06-25. Sources disagree on what the $22.5M is.** The body of the press release says a Series A of $15M and $22.5M raised in total, which implies about $7.5M earlier (my arithmetic; PitchBook shows a seed dated 2024-01-04 with no amount) (S-CL6, S-CL24 search summary). The headline of the same release and Clarify's own blog post say "raises $22.5M", which reads as if $22.5M were the round. The Notes & CRM PO reports that the Mergerlinks transaction page and Clarify's Product Hunt launch post also give a $22.5M round (S-CL24; I did not open those two pages). GeekWire says $22M (search summary). My reading: $22.5M is the cumulative total and the Series A alone is $15M; whether the round itself was $15M or $22.5M is UNVERIFIED until a primary filing is seen. Investors: USVP and Gradient (Ventures) are named as leads, with Madrona, Recall, Ascend, Essence, New Normal Fund and Fika taking part (press release and the PO's pages); Ascend's own post says USVP and Madrona co-led, so the second lead is disputed.
- First acquisition: Seam AI, about 2026-07-21 (a search summary gives the date; CDP Institute dated its note 2026-07-25). Terms undisclosed. Clarify said it also took extra, undisclosed funding with the deal. It feeds a planned "Signals" product that the pricing page still marks "Coming" (S-CL9, S-CL2).
- Headcount is not stated by the vendor and sources disagree: about 20 (Ascend), 24 (GeekWire, search summary), 29 (Built In), 31 (PitchBook, search summary). My estimate is 25 to 35 people plus 5 from Seam. LinkedIn was not reachable (UNVERIFIED) (S-CL7, S-CL20).
- Customers the vendor names itself: Paramark, Sift and Volca (2025 press release). Ascend claims over 100 customers. The home page names none (S-CL6, S-CL7, S-CL1).

**2. Community reviews**
- G2: 4.9 out of 5 from 21 reviews, but the figure comes from Clarify's own blog of 2025-12-17; the G2 page returned 403 and a newer count is UNVERIFIED (S-CL10). Product Hunt: 4.9 from 10 reviews, page opened (S-CL11). Capterra: a listing exists in search results but its rating is UNVERIFIED, and Clarify's own October 2026 blog says Capterra is "not yet available", so the two disagree (S-CL22).
- Reddit, Hacker News, X and LinkedIn: no real thread was found. Vendor blogs that say "Reddit users" give no link, so treat them as UNVERIFIED (S-CL15).
- Recurring praise (Product Hunt and the vendor's own review digest): the CRM fills itself in, easy setup, a free tier and unlimited seats, fast shipping (S-CL10, S-CL11).
- Recurring complaints: credit bills are hard to predict (the most frequent theme, in MakerStack and in competitor posts), shallow integrations and API, thin reporting and customization, little control over which calls are recorded (S-CL11, S-CL12, S-CL15, S-CL14).

**3. Expert and analyst views**
- Investors credit it: Madrona frames CRM as a very large market ripe for change and quotes the CEO that Clarify charges when the agent works; the founders admit limited build capacity (S-CL13). Ascend calls it a "SaaS 3.0" bet and notes that incumbents are held back by seat pricing (S-CL7). The Signal, a sponsored newsletter, doubts almost nothing (S-CL21).
- MakerStack scores it 7.9 out of 10, praises the low admin work and asks for clearer credit pricing; the site discloses affiliate income (S-CL12).
- Ahoy, a competitor, doubts the light, opinionated data model and says credit metering needs estimating at high use (S-CL14). CDP Institute files the Seam deal under vertical AI pulling workflows out of CRM (S-CL9).

**4. Pricing in depth** (USD; docs and pricing page opened 2026-11-02; S-CL2, S-CL16, S-CL17)
- **Free:** $0, 1,000 credits a month, 20,000 records, 3 objects, 1 campaign, standard enrichment. Free credits read 2,500 in Clarify's own October blog, so the count is contradictory.
- **Starter:** $50 a month, or $40 a month billed yearly (a price tracker; the docs say yearly saves 20 percent). 5,000 credits (the table shows a 5k to 40k selector, probably a ladder of $50 steps up to $400 per a competitor; the steps are UNVERIFIED because Clarify removed the rate card from the page around 2026-09-07), 250,000 records, 5 objects, 5 campaigns, advanced enrichment capped at 1,000 per period.
- **Growth:** from $1,000 a month, yearly only (at least $12,000 a year), 100,000+ credits, 20 campaigns, enrichment cap 5,000. **Workflows, workspace agents, delegated sending and non-English bot recording start here.** Enterprise is custom; SSO and SCIM are Enterprise only.
- **Seats:** unlimited and free on every plan. Credits do not roll over on Starter.
- **What a credit buys:** meeting summary 30, meeting prep 30, a task from a meeting 10 each, deal summary 20, field update suggestion 10, deal detection 20 (charged even when the suggestion is rejected), AI field autofill 3 to 30, campaign email 1, net-new lead from Lead Finder 1, workflow block 1. Agents are metered by AI use. Recording, enrichment and chat with the Rep agent cost nothing (S-CL16).
- **Hidden costs:** meeting prep, summary and tasks fire on every meeting unless switched off; on-demand credits (off by default, optional cap) are billed at a rate that is not published; heavy on-demand use can trigger an extra mid-month invoice; the enrichment cap is not lifted by buying credits; the jump from $50 to $1,000 is the price of any background workflow or agent (S-CL16).
- **Worked bill, 3-person SME** (my assumptions: 300 contacts, 30 recorded meetings a month, 200 outreach emails, 15 live deals, default automations on): about 4,100 credits a month (900 for summaries, 900 for prep, 600 for tasks, 400 for deal summaries, 100 for deal detection, 400 for field updates, 500 for autofill, 200 emails, 100 Lead Finder). That fits Starter 5,000: **$50 a month, about 1,290,000 VND** ($40 or about 1,032,000 VND if paid yearly). A lean setup is still about $50 because it passes the 1,000 free credits. A heavy setup (double use) is about $100 (inferred, UNVERIFIED), about 2,580,000 VND. **If the team wants workflows or agents that run in the background, the bill is Growth: $1,000 a month, about 25,800,000 VND, or about 309,600,000 VND a year.**

**5. Potential and risks**
- Momentum: the changelog has 11 entries between 2026-08-04 and 2026-11-02 (about one a week), after a gap with no entry between September 2025 and January 2026. October 23 shipped the Rep agent on Claude 5.5, workspace agents and Stripe sync (S-CL3). Built In lists 4 open roles, among them Head of Product, which may signal a product-leadership change (my inference) (S-CL20).
- Claims in section 4.1 that this check could not confirm: "agents in early access in May 2026" (the April entry only says "coming soon") and "MCP beta in January 2026" (the April entry says custom MCP connections were in closed beta). Both are now UNVERIFIED. The April 2026 custom objects, SOC 2 Type 2 and US-only hosting claims were confirmed (S-CL3, S-CL5).
- Moat (my reading): charging only when the agent works, unlimited seats, API, MCP, a prospect database and Seam's signals. Weak spots: a light data model and narrow integrations, which the vendor's own blog admits (S-CL14, S-CL22).
- Risks: incumbents and direct rivals (Attio, Lightfield) using the same "autonomous CRM" words; unpredictable credit bills, made worse by removing the rate card; model cost passes through to credits (the agents run on a third-party model); a team of about 30; hosting on AWS in the US only (EU "planned"). The subprocessor and training policy sit on a trust page that was not opened (UNVERIFIED) (S-CL5, S-CL3).
- Vietnam: no Zalo anywhere; the interface is English only. The bot recorder claims "38+ languages" on Growth and above with no list and Vietnamese not named; the local recorder lists six languages and none is Vietnamese; the docs disagree with each other. A Vietnamese team gets reliable Vietnamese transcription, if at all, only on the $1,000 tier (S-CL19).
- **Outlook, my opinion (2-3 years):** a small team with a real product and good velocity. The likeliest paths are staying a founder-led niche or being bought. Its credit pricing is the main thing that can turn users away, and Growth at $1,000 is a steep step for a small company that wants the agents.

#### 4.7.2 Lightfield

**1. Company and money**
- Founders: Keith Peiris (CEO) and Henri Liriani (President), both ex-Meta. They founded Tome in December 2020, an AI presentation app that reached about 25 million users (a16z, Contrary; VentureBeat says about 20 million). Tome raised about $81M (Contrary; Upstarts says about $80M) and cut staff from 70 to 7 in 2023. Lightfield is the same company after the pivot, launched publicly the week of 2025-11-20 (S-LF9, S-LF10, S-LF11, S-LF12).
- **The $47M is a Series A**, announced 2026-09-09 and led by a16z, with Maverick, Coatue, Greylock, Lightspeed, Audacious and Alumni Ventures. The valuation was not disclosed. Adding Tome's rounds gives about $128M in total (my arithmetic, not a sourced figure) (S-LF9, S-LF10, S-LF14).
- Headcount: about 40 in September 2026, about 20 a year earlier (a16z job board, Upstarts) (S-LF15, S-LF10).
- Traction claimed by the vendor and not checked by anyone else: 5,000+ companies signed up, 400 percent net dollar retention, no revenue figure. A search snippet of an X post says revenue grew 80 percent a month to 1,000 paying customers in July; the post returned HTTP 402, so that is UNVERIFIED. The press notes that "signed up" is not "using" (S-LF14, S-LF10, S-LF13).
- Customers the vendor names itself: Macroscope, Weaver, Verdigris, Power, SF Compute, Thrad, Agree and Intent HQ, plus a logo list of about 50 more. Mostly early-stage startups, many in Y Combinator (S-LF25, S-LF11).

**2. Community reviews**
- G2: the page returned 403. Search snippets disagree (4.9 from 10 reviews, or 5.0 from 2): UNVERIFIED. Capterra: Clarify says it is not listed (search summary). Product Hunt: 895 upvotes and #2 of the day on 2026-03-18, no star rating shown, one visible review (S-LF16).
- Reddit: no verifiable thread (a competitor claims complaints without links). Hacker News: Algolia searches found no Lightfield CRM thread, which does not prove there is none. X and LinkedIn: only official posts were seen (S-LF19).
- Praise: automatic capture from mail and calendar, setup in about 7 minutes to a filled pipeline (Nubia Magazine), a polished interface, meeting pre-briefs, API and MCP (S-LF16, S-LF17, S-LF18).
- Complaints: price and credit opacity, no free plan, no native mobile app as of April 2026, recording meetings by design, and some auto-created records pointing to companies that do not exist (Nubia Magazine) (S-LF17, S-LF19).

**3. Expert and analyst views**
- a16z (2026-09-09, an investor) credits a "business world model" and a context moat that compounds, and names no risks (S-LF9).
- VentureBeat (2025-11) credits the pivot and doubts hallucinations (the CEO concedes they cannot be removed, so a person approves outbound mail), the privacy of recorded calls, a customer base skewed to early-stage startups, and the pull of Salesforce and HubSpot (S-LF11).
- Upstarts notes that neither customer it named used the prediction features, lists crowded rivals (Attio, Clay, Apollo, Salesforce) and says the model leans on costly hands-on implementation (S-LF10). Contrary Research calls the moat claims "not proven" and noted missing forecasting and territory tools in 2025 (S-LF12). ultrathink.ai doubts the 400 percent figure and notes figures differ across outlets (S-LF13). SaaStr's piece is promotional (S-LF20).

**4. Pricing in depth** (USD; pricing page, support article and estimator opened 2026-11-02; S-LF7, S-LF21)
- **Starter:** $89 per user per month, billed monthly, at most 3 users, 50,000 records, 14-day trial. No workflows, automations, sequences or dashboards. The support article says Starter has no credits while the estimator offers Starter pay-as-you-go credits at $0.040: contradictory.
- **Pro:** $999 per workspace per month, yearly billing, 5 capture seats plus unlimited viewers, 250,000 records, 450,000 credits a year, automations, sequences, dashboards. **Growth:** $1,999 a month, yearly, 10 capture seats, 750,000 records, 900,000 credits, advanced enrichment. **Enterprise:** custom (RBAC, SSO).
- An extra capture seat is $200 a month, billed yearly. Credits are pooled for the workspace, yearly, and expire at year end. They pay for automations, workflows and sequences per run and for advanced enrichment per record; per-action amounts are not published. Overage is billed at a "pre-agreed" rate that is not published, and the default is that nothing stops (a hard cap is optional). The estimator shows $0.040, $0.030 and $0.028 per credit for Starter, Pro and Growth; Ahoy says it is older than the live page.
- **Hidden costs:** Starter at 3 users is $267, Pro is $999 flat, a 3.7 times jump the moment the team needs automation, dashboards or a fourth user; yearly commitment from Pro; credits expire; unpublished overage rate; Pro and up reportedly need a demo (a competitor says so). **Prices moved often:** Ahoy counts 5 changes since late July 2026; older prices were $36 and $99 per user (February), $59 and $149 (March) and $899 plus per-seat fees (July). Blog posts that quote these are stale (S-LF22).
- **Worked bill, 3-person SME** (my assumptions: all three customer-facing, mail, calendar and meetings synced, daily chat use):
  - Starter, 3 x $89 = **$267 a month, about 6,889,000 VND** ($3,204 a year), with no automation.
  - Pro, within the credit allowance: **$999 a month, about 25,774,000 VND** ($11,988 a year, about $333 per user per month).
  - Pro with heavy credit use: about $15,000 to $21,000 a year, so about $1,250 to $1,750 a month, **about 32,250,000 to 45,150,000 VND**. This extrapolates the vendor's estimator at the old $0.030 rate and is UNVERIFIED.
  - Growth: $1,999 a month, about 51,574,000 VND, if the three do real outbound.

**5. Potential and risks**
- Momentum: 11 releases between 2026-08-07 and 2026-10-23, about one a week (S-LF5). Hiring: about 25 open roles on the a16z board, mostly San Francisco, including a founding sales manager and applied scientists (S-LF15). Funding: a top-tier Series A in September 2026.
- Security: the pricing page claims SOC 2 Type II, HIPAA and GDPR, with ISO 27001 "soon"; in November 2025 it was only Type I (VentureBeat). The vendor says it does not train on customer data. Hosting region, subprocessors and model providers: UNVERIFIED (the trust page did not render) (S-LF7, S-LF23, S-LF11).
- Moat (vendor and investor claim): accumulated customer context and a context graph; counter: any rival with mail and meeting capture can copy auto-capture, so the value rests on agent quality.
- Risks: crowded rivals and incumbents; credit economics and repeated repricing; a business model that leans on forward-deployed engineers, which may not scale to a low-priced SME; hallucinated records; recording by design; customers skewed to early-stage startups (S-LF10, S-LF11, S-LF13).
- Vietnam: nothing found. English-only interface per a reviewer and a listing site (search summary). No Zalo or messaging channel is documented; inbound webhooks and an API exist, so a Zalo link would be custom work. A weak fit for a Vietnamese SME today (S-LF24, S-LF17).
- **Outlook, my opinion (2-3 years):** the best funded of the three and heading up-market, so its price will likely stay high and change often. It is unlikely to localize for Vietnam. If its claims hold, it becomes the reference product that HubSpot and Salesforce copy; if they do not, the repricing history is the first sign.

#### 4.7.3 Day AI

**1. Company and money**
- Founders: Christopher O'Donnell (CEO) and Michael Pici, both ex-HubSpot. O'Donnell was HubSpot's chief product officer and left in 2021 for Thrive Global. TechCrunch and Bessemer say he co-founded ProfitWell (sold to Paddle); both pages were read through a summarizer, and one weak source lists other companies, so treat that as "per TechCrunch and Bessemer". The "Dex" link in the brief was not found anywhere: UNVERIFIED and probably wrong (S-DY7, S-DY8, S-DY9).
- Seed: $4M led by Sequoia, 2024-06-20. **Series A: $20M led by Sequoia, 2026-02-02**, with Sound Ventures, Permanent Capital, Conviction and Greenoaks; Sequoia's Pat Grady joined the board. Total about $24M (S-DY6, S-DY5). Dealroom estimates valuations of $16M at seed and $80M at the Series A (an estimate, not company-stated) (S-DY10). One tracker says $28M raised and a $104M valuation with no source; I treat it as wrong (S-DY11).
- Headcount: the vendor says only "small" and wants to stay small. Estimates run from 10 to 42 (Airframe 10, Dealroom 42, a search summary about 30): UNVERIFIED. Based in Boston per Dealroom, Bessemer and the careers page (S-DY17, S-DY10, S-DY11).
- Customers: the vendor names none. Upstarts reports about 120 customers in February 2026 after 15 to 18 months of private testing, and quotes Sandstone, Finch and Stable Kernel as early users. Nothing newer was found (S-DY8).

**2. Community reviews**
- G2: a page exists but returned 403; Airframe says it shows 0 reviews, so there is no usable rating. Capterra: no listing found. Product Hunt: no launch found. Hacker News: no thread. Reddit: the search tool blocks the domain, so UNVERIFIED. Slashdot lists no ratings (search summary) (S-DY11, S-DY12).
- **Every review that could be read was written by a competitor or a consultancy** (Lightfield, Dreamhub, folk, We The Flywheel) (S-DY13, S-DY12). Praise they give: no manual entry, meeting and mail capture, relationship memory, answers that cite the source message, about 10 minutes to set up, and human edits that outrank later AI guesses. Complaints they give: weak structured pipeline and forecasting, mostly retrieves and summarizes, Google-only mail, and four tiers with skill slots that are hard to compare.
- Coffee.ai quotes unnamed Reddit comments ("great for notes but pipeline blind") with no link: UNVERIFIED (S-DY13).

**3. Expert and analyst views**
- TechCrunch (2024-06-20) credits the founders' pedigree and raises no doubt, relying on the founders' claims (S-DY7).
- Upstarts (2026-02) credits fast onboarding and doubts that incumbents will let go (one customer kept HubSpot as a "safety blanket"), that flat pricing will survive heavy usage (the CEO hints at usage pricing later) and overlap with other Sequoia-backed tools (S-DY8).
- Bessemer Atlas (2025-06, an investor) credits starting small and keeping a person's hand on the wheel, and admits the evidence is CEO anecdote with no metrics (S-DY9). We The Flywheel (2026-06) calls it unproven beyond early adopters and silent on security (S-DY12).

**4. Pricing in depth** (USD; pricing page and vendor guide opened 2026-11-02; S-DY4, S-DY14, S-DY15)
- **Unit:** one flat monthly fee per "agent", a virtual worker given to a colleague. No per-seat fee and no usage fee. Colleagues without an agent are free once the workspace has a Professional agent or higher (they can capture, search and read). Creating a workspace needs a Professional agent.
- **Tiers** (headline prices): **Free $0** (Gmail and calendar ingestion, meeting recording, notes, search; 0 skill slots), **Turbo $24** (tasks, email drafts, web search, MCP; 2 skill slots), **Professional $60** (pipeline and opportunity management, analytics, custom views, campaign sequences; 5 skill slots), **Executive $200** (campaigns from lists, 10 skill slots, skills as often as every 4 hours), **Super $800** (a forward-deployed account executive and prospecting; 10 slots). Skills are the scheduled or triggered background jobs.
- **Price basis is contradictory:** the page says the prices reflect yearly billing paid upfront, while the vendor guide and Ahoy give monthly list prices of $30, $75 and $250 for the first three tiers. Confirm in a live account. Volume discounts start at 21 agents and reach 50 percent at 301 or more.
- **Hidden costs:** none listed on the page (no overage, setup fee or minimum). The meeting recorder is in every tier. Web search and enrichment use third-party providers with no separate line. The CEO told Upstarts that usage pricing may come later, so a flat fee today is not a promise. You keep paying for Google Workspace and for any CRM you keep. Coffee.ai's claim that Day AI moved to seats plus credits is not supported by Day AI's own pages.
- **Worked bill, 3-person SME** (my assumptions: everyone on Google Workspace; the owner needs pipeline; no campaigns), yearly rate first and monthly list second:
  - Minimum: 1 Professional + 2 Free teammates, **$60 or $75 a month, about 1,548,000 or 1,935,000 VND**. The Free teammates only capture and search.
  - Typical: 1 Professional + 2 Turbo, **$108 or $135 a month, about 2,786,000 or 3,483,000 VND**.
  - 3 Turbo only (scheduled skills, no pipeline): $72 or $90, about 1,858,000 or 2,322,000 VND.
  - 3 Professional: $180 or $225, about 4,644,000 or 5,805,000 VND.
  - Owner on Executive + 2 Turbo: $248 or $310, about 6,398,000 or 7,998,000 VND.

**5. Potential and risks**
- Momentum: a release-note aggregator shows 10 releases from 2026-08-04 to 2026-10-06, about one a week; it was last updated 2026-10-06, so October 7 to November 2 is UNVERIFIED (the vendor's own changelog page returned empty). Themes: agents handing work to agents, custom MCP connectors, dashboards, Microsoft 365 support on 2026-10-06 (S-DY3). Hiring: one open role (account executive), and the page says it wants to stay small (S-DY17).
- Product gaps the vendor admits: mail enters the graph only from Google Workspace, no standalone reports or forecast view, no native mobile app, prospecting is in limited beta, first sync takes 1 to 6 hours (S-DY14).
- Security: the trust page says a SOC 2 Type II report is available under an NDA, with encryption at rest and in transit; the data policy says customer data is not used to train models. The subprocessor list has 36 entities, all in the US, including Anthropic, OpenAI, AWS and Supabase. Hosting region is not named (S-DY16).
- Moat (vendor claim): a context graph where each statement links to its source and human corrections outrank AI inference. Risks: usage cost sits inside flat fees; Salesforce, HubSpot and Attio add agents; dependence on Gmail and Slack; a very small team (S-DY14, S-DY8).
- Vietnam: nothing found. The vendor guide lists no languages and there is no Zalo. Mail is Google-only, which leaves out Vietnamese SMEs on other mail hosts. Transcription uses a third-party service whose Vietnamese coverage was not checked: UNVERIFIED, probably absent (S-DY14, S-DY16).
- **Outlook, my opinion (2-3 years):** the cheapest way to get background skills (a Turbo agent costs less than $30 a month) and the product with the most distinct idea, the context graph with sources. The company is tiny, so the likely futures are a sale, or a move to usage pricing when model costs bite. Do not expect Vietnamese support.

#### 4.7.4 Side by side for a 3-person Vietnamese SME

Rate: 25,800 VND per USD (S-FX1). Prices in USD are as shown by the vendors on 2026-11-02 unless marked.

| Need | Clarify | Lightfield | Day AI |
|---|---|---|---|
| Records, capture, summaries, no background jobs | Starter $50 a month, about 1,290,000 VND | Starter $267 a month, about 6,889,000 VND | 1 Professional + 2 Turbo $108 to $135 a month, about 2,786,000 to 3,483,000 VND |
| Scheduled or triggered background work for the team | **Growth $1,000 a month**, yearly only, about 25,800,000 VND | **Pro $999 a month**, yearly only, about 25,774,000 VND | 3 Turbo with 2 skills each $72 to $90 a month, about 1,858,000 to 2,322,000 VND |
| Heavy AI use | Starter about $100, or Growth plus unpublished on-demand credits | Pro plus unpublished overage, about $1,250 to $1,750 a month | No usage fee listed; may change |
| Price stability | Rate card removed in September 2026; Starter listed at $20, $40 and $50 by different sources | Changed 5 times since late July 2026 (Ahoy) | Turbo moved from $25 to $24 on 2026-09-03 (Ahoy) |

The pattern: for the owner's interest, agents that work in the background, Clarify and Lightfield both put the first usable price near $1,000 a month (about 25.8 million VND), and Day AI puts it under $100. All three bill in US dollars, have English-only screens as far as found, and document no Zalo link.

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
8. **Per-agent budget and a visible meter.** The P01 budget re-check is listed as left in ADR-0029's follow-ups (#435); AI CRMs bill by credits, so users expect a meter and a hard stop. After the 2026-11-02 deep dive I would ship the meter and the stop together with the first agent that calls a language model, not after it: unpredictable credit bills are the top complaint about Clarify, and Lightfield and Clarify both hide their overage rate (section 4.7).
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
| AI: a person's edit outranks later AI inference | **Take** (added 2026-11-02) | `party.verified_at/by`, `source_trust`; proposal revisions | Day AI's vendor guide and We The Flywheel describe it as what makes users trust the record; it costs little in Ludy because a proposal's edit is already a new revision. A field a person verified is not overwritten by a later proposal without a visible flag |
| Mobile app | **Later** | Web SPA, push for approvals in the plan | HubSpot, Pipedrive, Attio and MISA ship apps, Clarify and Lightfield do not. Phone-first teams need a phone-friendly web page and `tel:` links before a native app |
| Integrations: Zalo OA inbox | **Later**, but first among channels | `channel` layer with the Zalo OA connection (OAuth, refresh) | Every Vietnamese CRM sells it; Ludy has the connection for publishing. Needs the Service inbox and the customer's OA package. The 2026-11-02 deep dive found no Zalo, no Vietnamese interface and no Vietnamese transcription claim in Clarify, Lightfield or Day AI, so the AI CRMs leave this lead open (section 4.7) |
| Integrations: Zalo personal | **Skip**, until checked | none | One vendor says it connects personal Zalo and another says Official accounts only; I did not verify Zalo's terms for personal accounts. Do not build before the owner or a lawyer checks |
| Integrations: Facebook Messenger | **Later** | `channel` layer with Facebook Page | Same Service-inbox dependency; Pipedrive and HubSpot reach it through partners or a paid inbox |
| Integrations: phone system (PBX) | **Later** | `party.phone`, `activity` | Vietnamese CRMs link third-party cloud PBXs; recordings stay with the vendor. A first slice is a `tel:` link and a call note, with a PBX webhook only on demand |
| Integrations: Google and Microsoft mail and calendar | **Take** (calendar done, mail later) | Calendar C6 (Google busy read and write-back) | Twenty and Attio use them as the timeline's source; the calendar half is merged, the mail half belongs to the capture rules |
| Integrations: MISA and e-invoice | **Later** | Ludy accounting; the e-invoice receive path | The sales-to-invoice request flow is what SMEs know from MISA; the Accounting line decides whether to link or just offer its own flow |
| Pricing and free-plan limits | **Skip here** | Cloud pricing is sold per app and lives in the private layer (Decision 10) | Report only: Ludy self-hosted has no seat or record cap, which beats every free plan above. Pricing is not decided in the public repository. Input for Decision 10 only: AI CRMs bill in US dollars, background agents cost about $1,000 a month at Clarify and Lightfield but under $100 at Day AI for 3 people (section 4.7.4), and credit-metered AI is the most complained-about model (Clarify), so if the Cloud layer ever meters AI it should publish its rate and a hard stop |
| Self-hosting and licence | **Take** (state it) | AGPL whole repository, `docker compose up` | Twenty is the only global CRM that self-hosts, and it mixes licences; Getfly and Bitrix24 sell on-premise. A clean AGPL and a Compose start is a differentiator for Vietnamese SMEs who keep data in-house |
| Vietnamese-language search | **Take** | Plan "Search v0" (trigram on unaccented text) | No vendor confirmed it; it is cheap, visible, and every Vietnamese user needs it |

## 8. Gaps against the plan's CRM scope

Each gap is a recommendation for the owner, not an issue. The plan's CRM scope (Phase 3) is: contacts and companies as `party`; deals and pipelines; saved views, custom fields, record sharing; CSV import; a shared customer timeline (email, appointments, conversations, tickets, contracts, invoices); AI summaries, next steps and email drafts, every write a proposal.

| Gap | State on 2026-10-31 | Recommendation |
|---|---|---|
| Deals and pipelines | Built on 2026-11-02 (slice 1, K1 and K2) | Done; decision 1 was answered on 2026-11-01 |
| Kernel `saved_view` and Filter AST | Built (K3); whether Social moves onto it was not checked | Check that Social does not keep a second model |
| Custom fields | Not built | Later; each field needs a data class before agents may touch it |
| `record_link` | Not built; notes has `crove_notes.link` | Decide with the deals slice whether notes' link moves onto it |
| `record_share` | Not built | Later; a one-person company has no sharing need |
| CSV or Excel import for parties | Built (K5, K6) with staging, duplicate check and preview | Done |
| Shared timeline: email and chat | Only bookings, notes and calendar rows; mail and chat need Service Phase 4 and the capture rules | Later, as section 6.3 items 1 and 2 |
| Shared timeline: invoices, contracts | Finance documents name a party; contracts belong to Sign (not built) | Take invoices as a link; contracts wait for Sign |
| AI summaries and next steps for CRM | Not built for CRM; Social has a summary and scheduling has a message reader | Take as a read-only view |
| AI email drafts for CRM | Email plan covers drafts; no CRM entry point | Take as drafts only |
| Search without diacritics | Built for contacts (K4); other record types not checked | Extend where needed |
| Agent pieces (section 6.3) | Capture rules, bulk approval, agent approvers, language-model runner and schedules, undo, agent timeline view, per-field provenance, budget meter | Take in the order of 6.3 |
| `/mcp`, `/v1`, outbound webhooks | Not built; ADR-0032 pending | All four AI CRMs expose MCP; keep it on the plan and decide the order after deals |

## 9. Decisions for the owner

One at a time, recommendation first. If there is no answer, nothing here starts.

1. **Which CRM slice goes first when a wedge customer asks?** Recommendation: deals with one pipeline and a kanban board, kernel saved views with simple filters, and CSV or Excel import with duplicate checks. Skip custom objects and several pipelines until someone asks. Answered: the owner opened slice 1 on 2026-11-01 (#2223) and it is merged (section 2).
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

**Deep-dive sources (section 4.7; all checked on 2026-11-02; "search summary" means a snippet or a page that returned HTTP 403)**

Exchange rate and Clarify
- S-FX1 https://open.er-api.com/v6/latest/USD (USD to VND 25,795.63, updated 2026-11-01 00:02 UTC)
- S-CL6 https://www.webwire.com/ViewPressRel.asp?aId=340242 (funding press release, 2025-06-25)
- S-CL7 https://www.ascend.vc/blog/investing-in-clarify
- S-CL8 https://www.geekwire.com/2025/seattle-startup-clarify-lands-15m-to-take-on-salesforce-with-ai-native-autonomous-crm/ (search summary)
- S-CL9 https://www.cdpinstitute.org/news/clarify-acquires-seam-ai-to-strengthen-challenge-against-established-crm-vendors-885swx/ and https://seattleflow.org/article/seattle-s-clarify-acquires-s-f-startup-seam-ai-joining-forces-to
- S-CL10 https://www.clarify.ai/blog/what-users-are-saying-about-clarify-a-collection-of-reviews-from-2025 (the vendor's own digest; the G2 page returned 403)
- S-CL11 https://www.producthunt.com/products/clarify-6/reviews
- S-CL12 https://makerstack.co/reviews/clarify-review/ (affiliate income disclosed)
- S-CL13 https://www.madrona.com/autonomous-crm-how-clarify-is-reinventing-a-100b-category/ (investor)
- S-CL14 https://ahoy.ai/comparisons/best-ai-native-crms/ (competitor)
- S-CL15 https://www.coffee.ai/articles/clarify-crm-pricing-small-teams and https://www.breakcold.com/blog/clarify-ai-crm-review (competitors; the second is a search summary)
- S-CL16 https://docs.clarify.ai/en/articles/12503518, https://docs.clarify.ai/en/articles/12405071-ai-in-clarify and https://docs.clarify.ai/en/articles/12407495-enrichment (billing, credit costs, enrichment)
- S-CL17 https://pricingsaas.com/companies/clarify/diffs/2026W37 (price tracker)
- S-CL19 https://docs.clarify.ai/en/articles/12739298-multi-language-meeting-support
- S-CL20 https://builtin.com/company/clarify-ai/jobs
- S-CL21 https://www.thesignal.club/p/clarify (sponsored newsletter)
- S-CL22 https://www.clarify.ai/blog/best-ai-crms (the vendor's own comparison)
- S-CL24 https://www.clarify.ai/blog/series-a (search summary), https://pitchbook.com/profiles/company/571599-64 (search summary), https://dealroom.co/news/140153-clarify-buys-seam-ai-to-add-sales-signals-to-its-salesforce-challenger/ (search summary), plus the Mergerlinks transaction page and the Product Hunt launch post, reported by the Notes & CRM PO and not opened here
- Changelog entries read through S-CL3: https://www.clarify.ai/changelog/new-in-clarify-april-2026 and https://www.clarify.ai/changelog/weekly-ship-notes-10-23

Lightfield
- S-LF9 https://a16z.com/announcement/investing-in-lightfield/ (investor)
- S-LF10 https://www.upstartsmedia.com/p/ai-sales-startup-lightfield-raises-47m
- S-LF11 https://venturebeat.com/technology/tomes-founders-ditch-viral-presentation-app-with-20m-users-to-build-ai
- S-LF12 https://research.contrary.com/company/lightfield
- S-LF13 https://ultrathink.ai/news/lightfield-wrote-own-crm-process-takeaways
- S-LF14 https://finance.yahoo.com/technology/articles/lightfield-raises-47-million-series-160000294.html (paid press release)
- S-LF15 https://jobs.a16z.com/company/lightfield
- S-LF16 https://www.producthunt.com/products/lightfield
- S-LF17 https://nubiapage.com/lightfield-review-2026/
- S-LF18 https://makerstack.co/reviews/lightfield-review/
- S-LF19 Competitor reviews: https://fluidcrm.io/blog/lightfield-crm/, https://www.clarify.ai/blog/clarify-vs-lightfield, https://www.folk.app/articles/lightfield-crm-review, https://blog.coffee.ai/lightfield-crm-alternatives-reddit/ (search summary); Hacker News checked through hn.algolia.com
- S-LF20 https://www.saastr.com/saastr-ai-app-of-the-week-lightfield-the-ai-native-crm-that-killed-tomes-25-million-users-to-build-something-better/
- S-LF21 https://support.lightfield.app/articles/9815515424-how-lightfield-s-pricing-works and https://lightfield.com/estimate
- S-LF22 https://ahoy.ai/ai-native-crm/pricing-index/lightfield/ (competitor)
- S-LF23 https://docs.lightfield.app/security/
- S-LF24 https://support.lightfield.app/articles/7823628864-lightfield-api-and-integration-options
- S-LF25 https://lightfield.com/customers

Day AI
- S-DY5 https://www.day.ai/resources/series-a-and-the-beginning-of-the-shift-in-crm
- S-DY6 https://www.day.ai/resources/day-ai-raises-4m-from-sequoia-capital-to-reimagine-crm-for-the-ai-age
- S-DY7 https://techcrunch.com/2024/06/20/ex-hubspot-exec-builds-ai-powered-crm-learns-for-you-with-4m-seed-led-sequoia
- S-DY8 https://www.upstartsmedia.com/p/day-ai-sequoia-ai-crm
- S-DY9 https://www.bvp.com/atlas/lessons-from-day-ais-journey-to-becoming-the-waymo-of-crm (investor)
- S-DY10 https://dealroom.co/companies/day-ai/ (estimates)
- S-DY11 https://www.airframe.ai/product/day-ai/analysis (unsourced figures; used only where noted)
- S-DY12 https://wetheflywheel.com/en/comparisons/attio-vs-day-ai/ (consultancy)
- S-DY13 Competitor reviews: https://lightfield.com/blog/day-ai-review, https://www.dreamhub.ai/blogs/best-ai-native-crms-2026-honest-comparison-attio-clarify-day-ai-reevo-dreamhub, https://www.folk.app/articles/day-ai-review, https://www.coffee.ai/articles/day-ai-crm-reviews-comparisons/ (search summary)
- S-DY14 https://day.ai/guides/best-ai-crm (the vendor's own guide, updated 2026-10-21)
- S-DY15 https://ahoy.ai/ai-native-crm/pricing-index/day-ai/ (competitor price tracker) and https://revops.tools/day-ai/
- S-DY16 https://day.ai/trust, https://day.ai/data and https://day.ai/trust/subprocessors
- S-DY17 https://day.ai/careers

**Not verified in this study**
- Per-action approval and any undo in Clarify; undo in Lightfield, Day AI and Attio.
- Saved views, import and AI features of Getfly; e-invoice links of Getfly, Bitrix24 and Base CRM; Base CRM prices in VND; Bitrix24 per-user prices in VND.
- Zalo's terms for personal accounts; current Zalo OA package prices; the 2026-07-01 e-invoice milestone and the two 2026 decrees.
- Invoice timelines, self-hosting and mobile status where a cell says UNVERIFIED.
- Pipedrive's official prices and record caps.
- Deep dive (2026-11-02): real G2 and Capterra ratings (their pages returned HTTP 403), Reddit, Hacker News, X and LinkedIn sentiment, headcounts, Clarify's rate for on-demand credits and Lightfield's overage rate, Day AI's monthly versus yearly price basis, Day AI's releases after 2026-10-06, hosting regions of Lightfield and Day AI, Vietnamese transcription quality, and VAT or tax on a foreign software bill.
