# AI-first reference study: how the leaders put AI into the daily work of small businesses

Status: research only, 2026-11-02. No code and no roadmap commitment: every "take" below is a recommendation for the owner (AGENTS.md: a new customer-visible feature goes to the owner first). It follows the owner's direction of 2026-11-02, "AI-first for OPC & SME" ([DESIGN.md](../../DESIGN.md) section 1), and builds on the [CRM reference study](crm-reference-study.md), which covers Clarify, Lightfield, Day AI and Attio in depth.

Lens: one-person companies (OPC) and SMEs first, core features first. An AI job counts only if it shortens a task the owner or the bookkeeper already does weekly. Ludy's rule is fixed and not reopened here: AI calls only in `packages/agent`; AI output is tainted; deterministic checks decide; a person approves anything that posts money, sends a message or spends ([AGENTS.md](../../AGENTS.md), "Rules").

How to read the sources: every fact carries a source id (section 7), checked on 2026-11-02. "UNVERIFIED" means no vendor page confirmed it; "search summary" means the fact came from a search-engine summary, not an opened page; "third party" means a review or reseller blog, often a competitor's. Prices are in US dollars as published; VND uses about 26,000 VND per dollar, rounded. The text is paraphrased and no screenshot is used.

## 1. Findings in brief

1. **The leaders put AI in a feed of things that need you, not in a chat window.** QuickBooks routes agent work into a business feed for review and approval; Digits puts exceptions in an Inbox; Shopify shows Sidekick Pulse suggestions on Home; Linear shows suggestions inside Triage (S-QB1, S-DG1, S-SP1, S-LI1). Chat is the second door, added later (Intuit Intelligence came after the agents, S-QB2).
2. **Autonomy is a setting per class of item, off or "suggest" by default.** Linear lets each team show, hide or auto-apply each suggested property, even for chosen values only; Xero's auto reconciliation is off until turned on per bank account; Ramp's controllers choose which in-policy expenses the agent may approve; Puzzle's autonomous mode is an opt-in setting (S-LI1, S-XE1, S-RA1, S-PZ1).
3. **Trust is earned with reasons, not percentages.** Ramp shows the policy text each decision relied on and lets admins see how often reviewers disagree with the agent; Linear shows why a suggestion was made; Zeni shows the math behind an answer (S-RA1, S-LI1, S-ZN1). DESIGN.md 5.1 already says the same: a reason in plain words, never a bare percentage.
4. **After-the-fact review is how auto work stays safe.** Xero's auto-reconciled lines land on a "Reconciled" page where a person can review, adjust or take over any of them (S-XE1). This "auto within limits, then review and undo" loop is the pattern Ludy lacks most.
5. **Corrections become memory.** Xero learns from the org's own reconciliation history; Linear's suggestions improve as people accept and dismiss them; Sidekick saves instructions as skills (S-XE1, S-LI1, S-SP1). Ludy already stores learned rules as rows with provenance, applied before any model (`crove_finance.categorization_rule`, #1399), which is stronger than opaque learning.
6. **Drafts are the default for anything a customer reads.** Superhuman drafts replies and reminders but the person sends; Fin is the exception and answers customers alone, with human approval steps only for refunds and other high-risk steps (S-SH1, S-IC2).
7. **Money moves stay with people even at the most agentic vendors.** Xero's Cash Flow Actions propose a plan the user reviews and executes; QuickBooks' accounting agent never posts without the user knowing (S-XE2, S-QB1). Ramp is the exception: about three in four in-policy expenses are approved with no human (search summary, S-RA2).
8. **The cheapest valuable AI is the anomaly flag.** Xero's Bill Protection flags unusual amounts, changed bank details and unfamiliar suppliers before payment; MISA meInvoice flags suppliers with tax risk or an inactive status (S-XE2, S-MI3). Most of these flags are deterministic and cost nothing to run.
9. **Core AI is bundled; heavy agent work is metered.** Intuit Assist, MISA AVA, Gemini in Workspace and Ramp's Policy Agent come with the plan (S-QB1, S-MI2, S-GW1, S-RA1). Agents that act are sold per outcome (Fin $0.99, about 26,000 VND, per resolution; Zendesk per verified resolution) or by credits (HubSpot, Notion, Attio, Copilot Studio) (S-IC1, S-ZD1, S-HS1, S-NO1, S-AT1, S-MS2).
10. **Capture is the on-ramp.** Xero's Smart Document Capture, Brex's receipts over SMS, Sidekick's voice mode and MISA meInvoice's automatic collection all remove typing first (S-XE2, S-BX1, S-SP1, S-MI3). In Vietnam the signed e-invoice XML is the best capture there is, and Ludy reads it first.
11. **Batch approval of a plan is the new norm.** Shopify's Fall '26 Sidekick applies many store changes after one approval of a plan (search summary, S-SP3); Ludy already has bulk approval of clean proposals (#315).
12. **Vietnam's leaders bundle AI and over-promise autonomy.** MISA AVA has been free inside AMIS Kế toán since 2023 and lists auto-posting of invoices and auto reconciliation of bank and supplier balances; an AMIS page claims approval steps without human intervention (S-MI1, S-MI2, S-MI4). Sapo sells an AI chatbot across Zalo, Facebook and Shopee (S-SA2).
13. **Vietnamese SMEs say skills and cost block AI, and tax is confusing.** In Sapo's survey of about 15,000 sellers, 55.9% name a lack of knowledge or staff and 53.3% the cost; 42.7% do not fully understand their tax obligations; the top hoped-for uses are marketing (59.9%), reporting (52.0%) and customer care (47.1%) (S-SA1).
14. **Language and law are Ludy's opening.** QuickBooks' agents answered in English only at launch, and no global product studied documents Vietnamese or Zalo (S-QB1, CRM study). Vietnam's Personal Data Protection Law (in force 2026-01-01) requires an impact assessment for cross-border transfers, and the AI Law took effect on 2026-03-01 (S-VN1, S-VN2). Self-hosting with a chosen AI endpoint answers both.

## 2. The patterns that work

Each pattern lists how it shows in the UI, how much autonomy it takes, how trust is earned, and what OPC and SME users pay.

**2.1 A proactive inbox of things that need you.** UI: one list on the home screen of items waiting for a decision, each with its evidence. Autonomy: none; it gathers. Trust: each item links to its source and the agent that made it. Price: in the base plan everywhere seen (S-QB1, S-DG1, S-SP1, S-LI1).

**2.2 Auto-categorization that learns from corrections.** UI: a suggested category or match on each line, accepted in place or in bulk. Autonomy: suggest by default; auto-apply above a vendor-set confidence (Xero) or per property the team chooses (Linear). Trust: per-account opt-in, a review page for what was auto-applied, the reasoning on hover. Price: Xero's on mid plans and up, Linear's on Business; no-touch rates of 85 to 98% are vendor claims (S-XE1, S-LI1, S-PZ1, S-DG1).

**2.3 Drafting replies.** UI: a draft waiting in the composer, in the person's tone for that recipient (Superhuman), or a follow-up for a stalled thread (folk). Autonomy: draft only; the person sends. Trust: the draft is visibly a draft. Price: Superhuman's drafts on Business, about $33 to $40 (860,000 to 1,040,000 VND) a member a month (search summary); folk's in Standard, about $24 to $30 a seat (third party) (S-SH1, S-SH2, S-FK1).

**2.4 Agents that run in the background.** UI: a named agent with a trigger and a run log; results arrive in the feed. Autonomy: from "recommend" to "act within policy" (Ramp) or act and escalate (Fin). Trust: policy citations, a disagreement rate, approval on chosen steps with a timeout that escalates, simulations before going live (S-RA1, S-IC2, S-IC3). Price: metered; HubSpot's Customer Agent costs 50 credits (about $0.50) per resolved conversation since 2026-04-14, Professional plan and up (third party); Notion's agents use credits (S-HS1, S-NO1).

**2.5 A chat or command bar over your own data.** UI: ask in plain words from any screen (Intuit Intelligence, Sidekick, Zeni, MISA AVA by voice or text). Autonomy: reads; Sidekick presents changes for review before applying them. Trust: the chart and the math (Zeni), citations (Day AI). Price: usually bundled (S-QB2, S-SP1, S-ZN1, S-MI4).

**2.6 Daily briefs.** UI: what changed and what is due, on Home or by mail (QuickBooks' Finance agent, Digits' Reporting agent). Autonomy: none. Trust: numbers that tie to the books. Price: QuickBooks' on its top tier (third party) (S-QB1, S-QB3, S-DG1).

**2.7 Anomaly flags.** UI: a flag with its reason before the item is paid or posted. Autonomy: flag only; a person clears it. Trust: specific, checkable reasons; Ramp reports seven times more out-of-policy spend caught (vendor figure). Price: bundled or beta (S-XE2, S-MI3, S-RA1).

**2.8 Capture from photo, email or voice.** UI: snap, forward or speak; the item appears extracted in the inbox. Autonomy: extraction automatic, posting not. Trust: the source document beside the fields. Price: bundled (S-XE2, S-BX1, S-SP1, S-MI3).

**2.9 One-click approve.** UI: approve one item, all clean items on a screen, or a whole plan (Shopify Fall '26; HubSpot's Deal Progression beta reportedly has "approve all", search summary). Autonomy: the person decides. Trust: only items whose checks passed can be batched (DESIGN.md 5.1). Price: bundled (S-SP3).

## 3. The traps

**3.1 AI credits that stop the product.** Credits run out mid-month and the AI stops or the bill jumps. HubSpot credits reportedly do not roll over, and beta agents will start using credits after 30 days' notice; Attio's assistant may by default draw the whole workspace pool once a seat's credits are gone; Notion's agents switch to workspace credits if an admin allows it; a Lindy reviewer used 80% of a month's credits in two weeks; Clarify pauses AI at zero credits (S-HS1, S-AT1, S-NO1, S-LD1, CRM study). The fix: core AI included, a visible meter, a hard stop the owner sets, and a product that still works with AI off. Fin's configurable alerts and limits are the model (S-IC1).

**3.2 Hallucinated numbers in finance.** Intuit tells users to review all agent outputs, and users of QuickBooks report weekly clean-up of miscategorized lines (third party, anecdotal) (S-QB1, S-QB3). A model must never be the source of a figure. Ludy already enforces this in two places: a Social summary that writes any number not in its input is refused (`summaryNumbersOutside`, #1237), and a proofread that changes a number or price is refused (#1167). Every brief, answer and explanation should go through the same kind of check.

**3.3 Chat-only UX bolted onto old screens.** A chat box over unchanged screens leaves the routine work where it was. The products that work put the suggestion on the line, the flag on the bill and the draft in the composer; chat is for questions.

**3.4 Agents acting without approval.** Ramp auto-approves most in-policy expenses, Fin answers customers alone, and an AMIS page claims approval steps run without human intervention (S-RA2, S-IC1, S-MI4). Each works only with an explicit policy, a limit and an audit trail. For Ludy, anything tainted by outside text stays a proposal (CRM study, section 6.1); speed comes from cheaper approval, not fewer approvals.

**3.5 Privacy and data residency.** Vietnam's PDP Law (Law 91/2025/QH15, in force 2026-01-01) covers cross-border transfers and requires a transfer impact assessment within 60 days, with fines up to 5% of revenue; the AI Law (134/2025/QH15) took effect on 2026-03-01 and Decree 142/2026 on 2026-05-01 (S-VN1, S-VN2; law-firm summaries, check the official texts). Clarify hosts in the US only (CRM study); Notion's zero data retention with AI providers is an Enterprise feature (third party, S-NO2); Linear says it does not train on customer data (S-LI1). Ludy's answer is self-hosting, a chosen OpenAI-compatible endpoint, and no customer data in prompts it does not need.

## 4. Product by product

**Accounting and finance**
- **Intuit QuickBooks.** Accounting agent (categorize, match, anomalies, client follow-up), Finance agent (P&L and cash summaries), Projects, Sales Tax (beta). Work lands in a business feed for approval; output English only at launch. Intuit Assist at no extra cost for now; most agents on higher tiers (third party: Plus, $115 a month, and up). Intuit Intelligence, a natural-language layer, from 2025-10-28 (search summary) (S-QB1, S-QB2, S-QB3).
- **Xero (JAX).** Auto bank reconciliation, opt-in per account, target over 80% of lines, a Reconciled page to review or undo (beta from 2025-11-20). Xerocon London (2026-07-08): Smart Document Capture live; Bill Protection and Cash Flow Actions in beta; Payment Follow Ups coming; XeroForce no-code agents in early access (S-XE1, S-XE2). Anthropic partnership, March 2026 (search summary, S-XE3).
- **Ramp.** Policy Agent (GA 2026-01-13): approve, reject or review per transaction, citing the policy rule and flagging unclear rules; reviewer disagreement visible to admins; included in Ramp Plus (S-RA1). Over a million expenses a month and about 85% fewer manual reviews, by Ramp's account (search summary, S-RA2).
- **Brex.** A per-employee assistant fills receipts, memos and attendees by chat or SMS; Expense, Review and Audit agents (search summary, S-BX1). Capital One's purchase reportedly closed in April 2026 (UNVERIFIED).
- **Digits.** Bookkeeping, Finance and Reporting agents; exceptions to an Inbox; 97.8% accuracy against 79.1% for outsourced bookkeepers in its own test; no public price list (S-DG1).
- **Puzzle.** 85 to 90% auto-categorization claimed; asks the owner in plain words about unclear lines; opt-in autonomous close (S-PZ1).
- **Zeni.** AI bookkeeping checked by a human team; an AI CFO that shows its math; about $500 a month and up (search summary, S-ZN1). Pilot was not studied.

**CRM and sales** (detail in the [CRM reference study](crm-reference-study.md))
- **HubSpot Breeze.** Assistant and email writer even in Free; Customer and Prospecting agents on Professional and up, paid in credits ($10 per 1,000 monthly, third party) (S-HS1).
- **Attio, Clarify, Day AI.** Ask Attio never applies a change without a click; Clarify's agents act on triggers and bill credits; Day AI answers with citations. Credits are the top complaint (CRM study, S-AT1).
- **folk.** Follow-up assistant scans Gmail and WhatsApp for stalled threads and drafts replies; AI "magic fields" capped per month (third party, S-FK1).

**Support and conversations**
- **Intercom Fin.** $0.99 per outcome, one per conversation; human-in-the-loop approval steps in Procedures with a wait time and an escalation on timeout; Fin Operator drafts procedure changes as proposals; alerts and limits on usage (S-IC1, S-IC2, S-IC3).
- **Zendesk.** Pays per verified automated resolution, now checked by a separate AI evaluation (Relate 2026); seat pricing remains (search summary, S-ZD1).

**Work and docs**
- **Notion AI.** Business plan includes AI (about $20 to $24 a member); Custom Agents run on schedules and triggers and use credits (S-NO1, S-NO2).
- **Linear.** Triage Intelligence suggests team, project, assignee, labels and duplicates; accept, decline or see why; auto-apply per property; Business and Enterprise (S-LI1).
- **Superhuman.** Auto labels and auto archive for all; drafts and reminders that write the follow-up, sent by the person; custom labels and drafts on Business. A claim that 60% of drafts are sent unedited is UNVERIFIED (S-SH1, S-SH2).

**Commerce**
- **Shopify Sidekick.** Edits orders, writes product text and images, builds Flow automations from a sentence, writes and runs analysis code; presents changes for review before applying; Pulse suggestions on Home; mobile and voice. Price not stated (UNVERIFIED) (S-SP1, S-SP2, S-SP3).

**General agents**
- **Microsoft 365 Copilot Business.** $21 (about 546,000 VND) a user a month on top of a Business plan, GA 2025-12-02; agents built in Copilot Studio; agent runs metered beyond the plan (search summary) (S-MS1, S-MS2).
- **Google Workspace Gemini.** Included in Business and Enterprise plans since 2025 with a price rise (search summary, S-GW1).
- **Lindy.** Personal agent builder; approval steps must be set up deliberately; pricing moved around in 2026 (third party, S-LD1).

**Vietnam**
- **MISA (AMIS, AVA, meInvoice).** AVA free in AMIS Kế toán since 2023-12-15 (search summary); ten AI features including auto-posting of purchase and sales invoices, bank and supplier reconciliation, payment-reminder drafts and report search (S-MI1, S-MI2). meInvoice collects purchase invoices, flags risky suppliers, classifies costs, generates vouchers, flags budget overruns, with accountants keeping approval (S-MI3). AMIS markets voice and text questions and an agent platform (S-MI4). MISA says AMIS follows Circular 58/2026/TT-BTC for micro enterprises from 2026-07-01 (search summary, UNVERIFIED).
- **Base.vn.** Base 2.0, presented at an Enterprise AI Summit in 2026, lets companies build their own agents (search summary, S-BA1). Features UNVERIFIED.
- **Sapo.** AI chatbot across Facebook, Instagram, Zalo, Zalo OA and Shopee; over 230,000 businesses; the survey in finding 13 (S-SA1, S-SA2).
- **KiotViet.** Over 300,000 stores (search summary, S-KV1); no AI feature found (UNVERIFIED).
- **Bizzi.** Purchase invoice processing with AI and robots for larger firms; posting details UNVERIFIED (S-BZ1).

## 5. From the lessons to Ludy's apps

Ludy state checked in the repository on 2026-11-02. Verdicts: **take now**, **later**, **skip**, weighted for OPC and SME and core features first.

### 5.1 Ludy Kế toán

| AI job in the core workflow | Ludy has | Missing | Verdict |
|---|---|---|---|
| Read purchase invoices and propose TT133 entries | AI Inbox, XML first, deterministic checks (totals, rates, MST, CQT code, duplicate, signature), tax portal sync (#1100), bulk approval of clean items (#315) | Grouping by vendor and rule ("9 invoices, all under learned rules") | **Take now** (polish) |
| Learn accounts from corrections | `vendor_account_rule`, `categorization_rule` with provenance (#1399), Settings list | The rule shown as the reason on each line; a per-rule count of edits after approval (Ramp's disagreement rate) | **Take now** |
| Match bank lines | Bank lines to vouchers with a suggested party; bank feed with a sandbox provider (#2044) | Suggested matches to open invoices and vouchers, approved in batches; a "matched" review page like Xero's | **Take now** |
| Anomaly flags before posting or paying | Duplicate and signature checks | Vendor bank account changed, amount unusual for this vendor, supplier tax status, price jump per item; all deterministic | **Take now** |
| Capture from phone and Zalo | Mail route, upload, ZIP, portal sync, lookup plan (#2258) | Phone camera capture of receipts; forwarding from Zalo | **Take now** (phone), **later** (Zalo) |
| Explain a report, ask the books | Search in the command palette (#673) | Answers from R0 reads with a numbers check | **Later** |
| Chase missing invoices and receivables | Missing-invoice mail and monthly reminder (#669) | Customer payment reminders drafted from history | **Later** |
| Auto-post within owner limits | P05 founder exception in the plan (learned rule, verified counterparty, under a limit, untainted) | Not built; owner decision | **Later** |

### 5.2 Ludy CRM

| AI job | Ludy has | Missing | Verdict |
|---|---|---|---|
| Stale-deal and next-step nudges | Deals, board, saved views (#2223); agent task commands; `crm.scheduler` (no model) | A deterministic "stale deal" rule writing tasks | **Take now** |
| Create contacts and deals from conversations | Conversation core with link to contact (#2213) | Bulk-approved proposals from a thread (tainted, P03 and P04) | **Later** (after Conversations) |
| Draft follow-ups | None | Drafts on the deal, sent by a person | **Later** |
| Web enrichment | None | Egress job, banned URL fetches | **Skip** |

### 5.3 Ludy Notes

| AI job | Ludy has | Missing | Verdict |
|---|---|---|---|
| Summarize a note, suggest to-dos | Planned as N8, author only, suggestions not proposals | ADR-0037 addendum, then build | **Later** |
| Voice notes to text | Audio as a file in the kernel plan | Transcription (egress, R2) | **Later** |
| Agents reading notes | Banned (decision N-6) | | **Skip** |

### 5.4 Social and Ads

| AI job | Ludy has | Missing | Verdict |
|---|---|---|---|
| Draft and proofread posts | Proofread with a protected-token check (#1167) | | Done |
| Period summary and weekly digest | AI summary with a numbers check (#1237), digest mail (#1104) | | Done |
| Spend pace and anomaly flags | Spend caps, default no cap means no launch, `ads.pause_all` (ads-write plan) | Pace against cap, cost per result jump; deterministic | **Take now** (with the Ads write slices) |
| Draft campaigns | Agents may write drafts only (ADR-0043) | | **Later** |
| Auto-boost | Out of scope | | **Skip** |

### 5.5 Conversations (Facebook Page, Zalo OA)

| AI job | Ludy has | Missing | Verdict |
|---|---|---|---|
| Draft replies in Vietnamese | Planned: agent writes `conversation_draft`, a person sends (R2) | Build; saved replies offered next to the draft | **Take now** |
| Sort the inbox by intent (order, complaint, invoice request) | None | Shown as a suggestion computed on read, applied by a person | **Take now** |
| Auto-reply | Excluded in v1 | | **Skip** |
| Turn a thread into an order, a contact or an invoice request | Link contact | Proposals in bulk | **Later** |

### 5.6 Vy and the agents

| AI job | Ludy has | Missing | Verdict |
|---|---|---|---|
| Budget meter and hard stop | Per-run budgets, P01, kill switches | A visible meter per org and per agent; P01 re-check (#435) | **Take now** |
| "What Vy did" log and undo | `activity.agent_id`; 24-hour undo for agent R1 writes in the plan | A filtered activity view; the undo command | **Take now** |
| Background agents with a model and a schedule | Deterministic templates only | A language-model runner and schedules (ADR-0029 "Not in Phase 1") | **Later** |
| Agents approving narrow clean proposals | ADR-0029 machinery; no command declares `agentApprovers` | One harmless R1 command | **Later** |
| MCP for outside assistants | Waits for ADR-0032 | | **Later** |

### 5.7 Home

| AI job | Ludy has | Missing | Verdict |
|---|---|---|---|
| One inbox of what needs you | AI Inbox, Tasks, "Việc của tôi", notifications | One list across apps: proposals, flags, unanswered conversations, due tax dates | **Take now** |
| Daily brief ("Hôm nay") | Weekly Social digest pattern | A brief from R0 reads, numbers checked, on Home and by mail | **Take now** |
| Ask Vy from the command bar | Palette with search (#439, #673) | Questions answered from reads, with sources and a numbers check | **Later** |

### 5.8 Keeping it smooth under Ludy's rule

The rule (tainted output, deterministic checks, a person approves money, messages and spend) is not the obstacle; slow approval is. What makes it feel smooth:

- **Work is ready before the person arrives.** Proposals, matches, drafts and flags are prepared in the background, so opening the Inbox is reviewing, not waiting.
- **Batch approval of clean groups.** Only items whose checks all passed, grouped by vendor, rule or thread, approved with one action and the step-up once per batch (bulk approval exists, #315).
- **Learned rules as the reason.** "Theo quy tắc đã học" on each line, with the edit rate per rule shown to the owner, so a rule that keeps being corrected is visible and can be removed.
- **Limits the owner sets.** The plan's founder exceptions are the only path to auto-approval: P05 for R3 (an allowlisted class, under a limit, a counterparty a person verified, a matching learned rule, untainted) and P06 for sends (delayed and cancellable). Building either stays an owner decision.
- **Undo windows and after-the-fact review** for R1 work, like Xero's Reconciled page.
- **Flags first, not last.** A failed check is shown at the top and blocks; everything else gets out of the way.
- **Phone-first approval** with the keyboard shortcuts' pointer equivalents, for owners who approve between meetings.

## 6. Recommendations for the owner

Recommendations only, no roadmap commitment, in order of value for SMEs.

1. **"Hôm nay cần bạn" on Home.** One list across Kế toán, CRM and Conversations (proposals, flags, unanswered messages, tax deadlines), with a short daily brief built from reads and passed through a numbers check like #1237's. It is the pattern every leader converged on and needs no new autonomy.
2. **Make the AI Inbox the fastest review in Vietnam.** Group clean invoices by vendor and learned rule, show the rule as the reason, approve a group at once, and show the owner each rule's correction rate. It builds on what exists (#315, #1399).
3. **Bank matching with batch approval.** Suggest matches of bank lines (feed or statement) to invoices and vouchers, approve in batches, review matched lines afterwards. Vouchers stay R3, four-eyes where required. This is the job Xero and MISA lead with.
4. **Deterministic anomaly flags.** Changed vendor bank account, unusual amount for a vendor, supplier tax status, duplicate, price jump, ad spend pace. No model cost, high trust, and the best answer to hallucinated numbers.
5. **A visible AI budget with a hard stop, and core AI that works without credits.** Ship the meter with the first agent that calls a model; never let a credit stop block posting, reading or approving.
6. **Vy drafts replies for Zalo OA and Facebook.** Vietnamese drafts next to saved replies, intent shown as a suggestion, a person sends. Customer care is a top hoped-for use in Vietnam (S-SA1), and no global leader serves Zalo.
7. **Phone capture.** Snap a receipt or bill into the Inbox; Zalo forwarding later.
8. **Then, with pilot data, the owner's call on narrow auto-approval** under the planned founder exceptions, for one recurring class (for example a monthly utility invoice from a verified vendor under a set amount), delayed and cancellable. This touches approval policy, so it waits for the owner and the pilot.

## 7. Sources

All checked on 2026-11-02 unless marked.

Ludy
- Repository: [AGENTS.md](../../AGENTS.md), [DESIGN.md](../../DESIGN.md) sections 1, 2 and 5.1, [CRM reference study](crm-reference-study.md), [crove-os-kernel.md](../plan/crove-os-kernel.md), [crm.md](../plan/crm.md), [conversations.md](../plan/conversations.md), [ads.md](../plan/ads.md), [ads-write.md](../plan/ads-write.md), [einvoice-lookup.md](../plan/einvoice-lookup.md), [notes.md](../plan/notes.md); code read: `packages/agent/src/summary.ts`, `proofread.ts`, `apps/app/src/lib/review.ts`, `modules/finance/src/bank-match.ts`, `supabase/migrations/20261102000000_crove_finance_categorization_rule.sql`.

Accounting and finance
1. S-QB1 https://quickbooks.intuit.com/ca/resources/accountants/using-ai-agents-to-save-time
2. S-QB2 https://quickbooks.intuit.com/sg/r/product-update/intuit-ai-agents-quickbooks/ and https://accountants.intuit.com/taxprocenter/practice-management/workflow-tools/you-ask-and-quickbooks-with-intuit-intelligence-answers (search summary)
3. S-QB3 https://www.usecarly.com/blog/quickbooks-ai and https://beancount.io/blog/2026/07/26/quickbooks-online-price-increase-2026-cost-breakdown-guide (third party, search summary)
4. S-XE1 https://blog.xero.com/product-updates/automatic-bank-reconciliation-jax-beta/
5. S-XE2 https://blog.xero.com/product-updates/xerocon-london-2026-agentic-era-small-business-finance/
6. S-XE3 https://www.businesswire.com/news/home/20260326956055/en (search summary)
7. S-RA1 https://ramp.com/blog/ramp-policy-agent-ga-launch
8. S-RA2 https://support.ramp.com/policy-agent-overview and https://ramp.com/blog/its-time-to-rewrite-your-expense-policy-for-ai-insights-from-10000-expense-policies (search summary)
9. S-BX1 https://www.brex.com/platform/brex-ai (search summary)
10. S-DG1 https://digits.com/blog/introducing-digits-accounting-agents/
11. S-PZ1 https://puzzle.io/blog/can-ai-categorize-my-transactions-for-me-and-more
12. S-ZN1 https://www.zeni.ai/for/small-business-owners and https://www.zeni.ai/pricing/bookkeeping-packages (search summary)

CRM and sales
13. S-HS1 https://www.eesel.ai/blog/hubspot-ai-agent-pricing-2026 and https://resolve247.ai/blog/hubspot-breeze-pricing-change (third party, search summary); CRM study S-HS1, S-HS2
14. S-AT1 https://coworker.ai/blog/attio-pricing (third party, search summary); CRM study S-AT3, S-AT8
15. S-FK1 https://www.folk.app/articles/crm-with-ai-follow-up-assistant and https://dupple.com/reviews/folk (search summary)
16. Clarify, Lightfield, Day AI: CRM study sources S-CL1, S-CL2, S-LF1, S-LF2, S-DY1

Support and conversations
17. S-IC1 https://fin.ai/pricing
18. S-IC2 https://fin.ai/help/en/articles/16049727-human-in-the-loop-approvals-for-fin-procedures
19. S-IC3 https://www.intercom.com/help/en/articles/14707479-use-fin-operator-for-procedures (search summary)
20. S-ZD1 https://www.zendesk.com/newsroom/articles/zendesk-outcome-based-pricing and https://diginomica.com/zendesk-relate-2026-zendesk-prepares-outcome-based-future-built-verified-resolutions (search summary)

Work and docs
21. S-NO1 https://www.notion.com/help/custom-agent-pricing
22. S-NO2 https://www.sentra.app/articles/notion-ai-pricing and https://coworker.ai/blog/notion-ai-pricing (third party, search summary)
23. S-LI1 https://linear.app/docs/triage-intelligence
24. S-SH1 https://blog.superhuman.com/the-next-superhuman-ai/
25. S-SH2 https://superhuman.com/plans and https://latent.space/wiki/superhuman-ddf4b158/ (search summary)

Commerce
26. S-SP1 https://help.shopify.com/en/manual/shopify-admin/productivity-tools/sidekick
27. S-SP2 https://www.shopify.com/news/winter-26-edition-merchant
28. S-SP3 https://www.flatlineagency.com/blog/shopify-editions-fall-26 (third party, search summary)

General agents
29. S-MS1 https://www.microsoft.com/en-us/microsoft-365/blog/2025/12/02/microsoft-365-copilot-business-the-future-of-work-for-small-businesses/
30. S-MS2 https://dailyaifixs.com/blog/microsoft-copilot-pricing-2026-the-agent-credit-catch (third party, search summary)
31. S-GW1 https://www.techrepublic.com/article/google-workspace-gemini-pricing-plans/ (search summary)
32. S-LD1 https://www.cloudtalk.io/blog/lindy-ai-review/ and https://www.usecarly.com/blog/lindy-ai-pricing/ (third party, search summary)

Vietnam
33. S-MI1 https://helpact.misa.vn/?p=68849
34. S-MI2 https://amis.misa.vn/118960/cuoc-tro-chuyen-voi-tro-ly-tri-tue-nhan-tao-ai-cua-misa-tro-ly-ai-ke-toan-da-nhiem/ (search summary)
35. S-MI3 https://meinvoice.vn/xu-ly-hoa-don-dau-vao/
36. S-MI4 https://amis.misa.vn/?p=185121
37. S-BA1 https://ecosistemastartup.com/?p=110936 (search summary)
38. S-SA1 https://www.sapo.vn/bao-chi-noi-ve-sapo/Sapo-Khao-sat-15-000-nha-ban-hang-Thue-hoa-don-dien-tu-da-kenh-va-AI-dinh-hinh-t-a2788.html
39. S-SA2 https://www.sapo.vn/blog/cach-tao-chatbot (search summary)
40. S-KV1 https://itviec.com/blog/kiotviet-16-nam-khang-dinh-vi-the-bang-su-tan-tam-va-dong-long/ (search summary)
41. S-BZ1 https://bizzi.vn/en/startup-bizzi-successfully-raised-3-million-dollars/ (search summary)

Law
42. S-VN1 https://www.tilleke.com/insights/vietnam-issues-personal-data-protection-law/13/ and https://fpf.org/wp-content/uploads/2026/01/January-2026-FPF-Issue-Brief-Making-Sense-of-Vietnams-Latest-Data-Protection-and-Governance-Regime-1.pdf (search summary)
43. S-VN2 AI Law 134/2025/QH15 and Decree 142/2026/ND-CP, from law-firm commentary in the same search (search summary; official texts not read)

**Not verified in this study:** Intuit's own US pricing for agents; Brex's figures and the Capital One closing date; Digits' and Zeni's prices; Pilot; Sidekick's price and languages; Superhuman's 60% unedited-draft figure; HubSpot's official credit rate card (its page returned 404); KiotViet's AI features; Base 2.0 and Bizzi features; Circular 58/2026/TT-BTC; the official texts of the PDP Law, the AI Law and their decrees.
