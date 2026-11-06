# Competitor comparison: Ludy Engage against Hootsuite, Publer, Buffer, Sprout Social, Meta Business Suite, HubSpot, Pancake and Intercom / Crisp

Written on 2026-11-06 at the owner's request (JOY, issue #2677). The Vietnamese summary for the owner is [competitors-engage.vi.md](competitors-engage.vi.md); this English file is the canonical one. It narrows the suite-level [competitors.md](competitors.md) (MISA AMIS, Base.vn, HubSpot, Odoo, Pancake) to one app, Ludy Engage, and adds the social publishing and inbox tools that page does not cover.

This page is a market map, not a plan. It builds nothing and commits nothing, and it promises no feature, price or date. Per [AGENTS.md](../../AGENTS.md), a new customer-visible feature goes to the owner as a recommendation first: no issue is opened and nothing is built for a gap below until the owner agrees (see "Gaps").

## How to read it

Status of a Ludy capability, checked against `main` on 2026-11-06 (the code under `modules/social`, `modules/ads`, `packages/channel`, `packages/ad-platform`, `apps/kernel/src`, `apps/app/src/routes`, and the plans [social.md](../plan/social.md), [ads.md](../plan/ads.md), [ads-write.md](../plan/ads-write.md), [conversations.md](../plan/conversations.md), [ADR-0041](../adr/0041-conversation-core.md) and [ADR-0043](../adr/0043-ads-write-running-ads.md)):

- **Shipped:** the code is on `main`. It does not mean the first check with a real platform account is done: for Facebook Page and Zalo OA that live check is still the owner's step ([social-live-check.md](../runbooks/social-live-check.md)), and a self-hoster needs their own app at each platform.
- **Built, not live:** the code is on `main` and tested, but a switch is off until the owner's live check. Only Meta ad launch is in this state.
- **In build:** a plan exists and its build issues are open.
- **Planned:** it appears only in a plan or an ADR, with no build issue yet.
- **Missing:** no plan, no ADR, no issue.

A competitor cell says yes, partial or no, with the product name and the plan when the page names one. "Not confirmed" means the public pages read for this page did not settle it. It does not mean "no".

## Who they are

- **Ludy Engage** (app id `social`, AGPL, open source): one app of the Ludy Business OS for Vietnamese one-person companies (OPC) and SMEs. Four groups: **Hộp thư** (one inbox where chat, comments and customer email are conversations, with New, Pending and Resolved; no tickets, no SLA, by the owner's decision of 2026-11-03), **Khách hàng & Bán hàng** (contacts, deals, booking), **Marketing** (posts, calendar, ads), **Báo cáo** (metrics and client reports). The AI coworkers are Dy (inbox, customers and sales) and Uy (marketing), shown through the roster placeholders; Vy leads across apps. Self-hosted with `docker compose up`; the hosted Ludy Cloud is "sắp ra mắt" (coming soon).
- **Hootsuite:** a US social media management suite for teams and agencies: publishing, an inbox (marketed as Nest), analytics, listening and AI, on plans for companies rather than single owners. Closed source, cloud.
- **Publer:** a low-cost scheduler priced per social account and per member, with a free tier. Strong on bulk scheduling, automation and approvals; no comments inbox found. Closed source, cloud.
- **Buffer:** a scheduler priced per channel, with a free tier, a link-in-bio page (Start Page) and a community inbox for comments. Closed source, cloud.
- **Sprout Social:** a US suite for brands: publishing, Smart Inbox, listening, reporting and AI, priced per seat. The most expensive per seat of the group. Closed source, cloud.
- **Meta Business Suite:** Meta's own tool for Facebook and Instagram Pages: scheduling, one inbox for Messenger, Instagram and comments, automated replies, insights and ads. Only Meta's channels. Closed, cloud.
- **HubSpot (Marketing Hub and Service Hub):** a US customer platform. Marketing Hub has social scheduling, ads tools and AI agents; Service Hub has live chat, chatbots, ticketing, a help desk and a customer AI agent. Closed source, cloud.
- **Pancake:** the closest Vietnamese tool: one inbox for messages and comments from social channels, with auto-assignment, saved replies, tags and orders inside the chat; a family of apps (POS, CRM, Botcake chatbot, Webcake, Fintab accounting). See [competitors.md](competitors.md) for the family. No social publishing was found on its pages. Closed source, cloud.
- **Intercom and Crisp:** the two customer-messaging inboxes whose conversation model Ludy's inbox follows (ADR-0041). Intercom is priced per seat with an AI agent (Fin) priced per resolved outcome; Crisp is priced per workspace, cheaper, with a free tier. Neither publishes social posts. Closed source, cloud.

## Pricing (public pages only, read on 2026-11-06)

Prices in USD, as the vendor shows them on the date read; they change without notice. Nothing here is a price for Ludy.

- **Ludy:** open source; self-host free. No hosted price: Ludy Cloud is not live.
- **Hootsuite:** Standard from 99, Professional from 199, Advanced up to 399 per month billed yearly, Enterprise custom. Standard includes 10 social accounts; Professional and above unlimited. The page does not say whether the figure is per user.
- **Publer:** Free (3 social accounts, 1 user); Professional from 5 per month and Business from 10 per month, each for 1 social account and 1 user, then more per extra account or member; 20% off yearly; Enterprise custom.
- **Buffer:** Free (3 channels); Essentials 5 per channel per month; Team 10 per channel per month; yearly saves about 20%.
- **Sprout Social:** per seat per month, billed yearly: Essentials 79 (5 profiles), Standard 199 (5 profiles), Professional 299 and Advanced 399 (unlimited profiles), Enterprise custom. Listening and Premium Analytics are paid add-ons with no price shown.
- **Meta Business Suite:** the price is not stated on the page read; Meta describes it as a tool for Page owners. Ad spend is paid to Meta.
- **HubSpot:** Marketing Hub: Free (2 users), Starter from 7 per seat (listed at 20), Professional from 800 per month with 3 seats and a 3,000 one-time onboarding fee, Enterprise from 3,600 per month with a 7,000 onboarding fee. Service Hub: Free, Starter from 7 or 20 per seat, Professional 90 to 100 per seat plus 1,500 onboarding, Enterprise 150 per seat plus 3,500 onboarding. AI agents and some features use HubSpot Credits at 0.01 each.
- **Pancake:** plans by connected pages and staff on 3, 6 or 12 month terms (Small is 1 page and 3 staff, Standard 3 pages, Business 6 pages and 10 staff). The pricing page read on 2026-11-06 showed no amounts; the [suite page](competitors.md) records "from 550,000 VND for 6 months" for Small, read on 2026-11-04.
- **Intercom:** Essential 19 (listed at 29), Advanced 85, Expert 132 per seat per month; the Fin AI agent 0.99 per outcome with a monthly minimum; WhatsApp, SMS and phone are pay as you go.
- **Crisp:** per workspace per month: Free (2 agents), Mini 45, Essentials 95, Plus 295, Enterprise custom; extra agents 10 each.

## Capability matrix

Ludy cells give the status first. Competitor cells give yes, partial, no or "Not confirmed", with the product or plan. "HS" is HubSpot, "MBS" Meta Business Suite, "IC" Intercom, "Crisp" Crisp.

### Channels

| Capability | Ludy | Hootsuite | Publer | Buffer | Sprout | MBS | HubSpot | Pancake | IC / Crisp |
|---|---|---|---|---|---|---|---|---|---|
| Facebook Page and Instagram: publish | Shipped: posts, Stories, Reels, first comment | Yes: Instagram feed, Reels, Stories, Facebook Pages | Yes (Facebook and Instagram on the supported list; the page read lists no networks) | Yes: Facebook pages and groups, Instagram | Not confirmed | Yes: posts and stories on both | Partial: social scheduling in Marketing Hub | Not confirmed: no publishing found | No |
| Zalo OA: publish and chat | Shipped: OA articles and OA chat | Not confirmed | Not confirmed | Not confirmed | Not confirmed | No | Not confirmed | Yes: Zalo among its social channels (read 2026-11-04) | Crisp: Not confirmed, not found on pages read; IC: Not confirmed |
| TikTok | Shipped: publish and metrics (an unaudited TikTok app posts private only) | Yes: TikTok | Not confirmed | Yes: TikTok business | Not confirmed | No | Not confirmed | Partial: TikTok listed as coming soon on the features page read | Not confirmed |
| YouTube, Threads, LinkedIn, Google Business Profile | Shipped: all four; plus Bluesky, Mastodon, X, Pinterest, Telegram, Discord, WordPress | Partial: Threads and Bluesky yes; LinkedIn not confirmed on the publishing page | Partial: Threads yes | Yes: YouTube Shorts, Threads, LinkedIn, Google Business Profile, plus others | Not confirmed | No | Not confirmed | Not confirmed | No |

### Publishing and planning

| Capability | Ludy | Hootsuite | Publer | Buffer | Sprout | MBS | HubSpot | Pancake | IC / Crisp |
|---|---|---|---|---|---|---|---|---|---|
| Composer with a text per channel, AI draft and rewrite | Shipped: per-channel variants, Uy drafts, proofreading, threads, signatures | Partial: AI captions, images and ideas (Wisdom) | Yes: AI Assist (unlimited prompts on Business) | Yes: AI Assistant on all plans | Partial: Enhance Post (Professional and up) | Not confirmed | Partial: AI content agents (beta) | No | No |
| Calendar and queue | Shipped: calendar, queues, recurring and evergreen posts | Yes: calendar and list views | Yes: Calendar Planner | Yes: queue and visual calendar, all plans | Not confirmed | Yes: schedule and calendar | Not confirmed | No | No |
| Best time to post | Shipped: "Giờ đẹp" slots computed from the org's own posts | Yes: from follower activity | Yes: Business plan | Not confirmed | Yes: optimal send times (Essentials and up) | Not confirmed | Not confirmed | No | No |
| Bulk scheduling and CSV import | Shipped: bulk drafts, CSV import, RSS feeds | Yes: up to 350 posts at once | Yes: Professional and up, RSS automations | Not confirmed | Not confirmed | Not confirmed | Not confirmed | No | No |
| Drafts and approval | Shipped: submit, approve, banned-word check, four-eyes on AI proposals | Yes: custom approval workflows (Advanced, per the plans page) | Yes: Business plan | Yes: Team plan only | Not confirmed | Not confirmed | Partial: social approvals listed, tier unclear | No | No |
| Client review link (outside people approve) | Shipped: review links, white-label client reports | Not confirmed | Partial: approvals "for external clients" on Publer's pages | Not confirmed | Not confirmed | No | Not confirmed | No | No |
| Media library | Shipped: library, tags, stock photos, watermark | Not confirmed | Yes: Professional and up | Not confirmed | Not confirmed | Not confirmed | Not confirmed | No | No |
| Link in bio page | Shipped: bio page in Engage | Yes: link page from the dashboard | Partial: through Linkie, a separate tool that connects | Yes: Start Page, counts as a channel | Not confirmed | No | No | Partial: Webcake builds landing pages | No |

### Inbox

| Capability | Ludy | Hootsuite | Publer | Buffer | Sprout | MBS | HubSpot | Pancake | IC / Crisp |
|---|---|---|---|---|---|---|---|---|---|
| One inbox for comments and private messages | Shipped: Hộp thư, Facebook comments and Messenger, Instagram comments and DMs, Zalo OA chat | Yes: Nest, comments and DMs on Facebook, Instagram, WhatsApp, TikTok and others | No: no comments inbox found; a unified inbox is on its roadmap | Partial: community inbox for comments, all plans | Yes: consolidated inbox (Standard and up) | Yes: Facebook, Messenger, Instagram | Not confirmed | Yes: one view for messages and comments | Crisp: yes, chat, email, Messenger, Instagram DMs, WhatsApp, Telegram and more; IC: yes, Essential (shared inbox), social channels not stated |
| Customer email in the same inbox | Shipped: email as conversations | Not confirmed | No | No | Not confirmed | Partial: Gmail in the inbox (a help page exists) | Not confirmed | Not confirmed | Yes: both |
| New, Pending, Resolved, assignment, notes | Shipped: all, plus availability and a "replying" marker | Yes: assignment, auto-routing on Advanced | No | Not confirmed | Not confirmed | Yes: assign to Page admins, editors, moderators | Not confirmed | Yes: auto-assignment to staff or teams, tags | Yes: IC round robin on Advanced; Crisp shared inbox on all plans |
| Saved replies | Shipped: keyword-matched saved replies beside the draft | Yes | No | Yes: unlimited on paid plans | Not confirmed | Yes | Not confirmed | Yes: quick replies | Not confirmed |
| Auto-replies and chatbots | Missing: a person sends every message, by design; only an auto-reply under the org's own post exists | Partial: automated replies on Professional | No | No | Not confirmed | Yes: instant, away and keyword replies | Yes: chatbots in Service Hub | Partial: Botcake is a separate product | Yes: IC Fin, Crisp chatbot (Essentials and up) |
| Tickets and SLA | Missing by decision (2026-11-03) | Not confirmed | No | No | Not confirmed | No | Yes: Service Hub | No: tags only | Yes: IC tickets on Essential, SLA on Expert; Crisp tickets on Plus |
| Live chat widget on a website | Missing | No | No | No | No | No | Yes: Service Hub | Partial: chat plugin in Webcake | Yes: both |
| Contact panel and a CRM behind it | Shipped: contacts, deals, phone and name match, one set of contacts with the books | Partial: Salesforce link on Enterprise | No | No | Not confirmed | No | Yes: Smart CRM | Yes: Pancake CRM | Partial: Crisp contact profiles; IC: Not confirmed |

### Ads

| Capability | Ludy | Hootsuite | Publer | Buffer | Sprout | MBS | HubSpot | Pancake | IC / Crisp |
|---|---|---|---|---|---|---|---|---|---|
| Read ad results | Shipped: Meta ads read; Google Ads read wired | Not confirmed | No | No | Partial: paid insights (Professional and up) | Yes: insights | Yes: ads connected accounts and audiences | Partial: conversion events to ad platforms | No |
| Create and run campaigns | Built, not live: Meta create, caps, stop, pause and activation, behind `ADS_LIVE_LAUNCH` (off) until the owner's live check | Not confirmed | No | No | Not confirmed | Partial: the page names creating and scheduling ads | Partial: ad audiences and conversion events | Partial: optimises from conversion events | No |
| Boost a published post | Planned: W3 in the ads-write plan, no issue yet | Not confirmed | No | No | Not confirmed | Not confirmed on the pages read | Not confirmed | Not confirmed | No |
| Spend caps and approval of every spend | Built, not live: caps, approval with the maximum spend, kill switch | Not confirmed | No | No | Not confirmed | Not confirmed | Not confirmed | Not confirmed | No |

### Reports, listening and team

| Capability | Ludy | Hootsuite | Publer | Buffer | Sprout | MBS | HubSpot | Pancake | IC / Crisp |
|---|---|---|---|---|---|---|---|---|---|
| Post and channel analytics, period comparison | Shipped: metrics tab, period before, engagement rate, goals | Yes: reporting on every plan | Yes: Business plan | Yes: Essentials and up, 30 days on Free | Yes: profile and post reporting | Yes: insights | Yes: Marketing Hub | Partial: real-time reports | Not confirmed |
| Branded client reports | Shipped: white-label report links, scheduled mail | Partial: custom and scheduled reports (Professional) | Partial: downloadable reports (Business) | Yes: Team plan | Not confirmed | No | Not confirmed | No | No |
| Social listening, competitor tracking | Missing | Yes: Standard and up; benchmarks 5 competitors | Partial: competitor analysis (Business) | Not confirmed | Partial: listening is a paid add-on | No | Not confirmed | No | No |
| Sentiment on messages | Missing | Not confirmed | No | No | Yes: Advanced plan | No | Not confirmed | No | Not confirmed |
| Roles and a limit per channel | Shipped: member roles, per-channel access | Yes: departmental permissions | Partial: team plans | Partial: Team plan permissions | Not confirmed | Yes: roles on Pages | Yes: seat types | Yes: detailed staff permissions | Partial: IC seats and lite seats; Crisp agents |
| Compliance word lists (banned words) | Shipped: per channel, warn or block | Not confirmed | Not confirmed | Not confirmed | Not confirmed | Not confirmed | Not confirmed | Not confirmed | Not confirmed |

### AI and fit

| Capability | Ludy | Hootsuite | Publer | Buffer | Sprout | MBS | HubSpot | Pancake | IC / Crisp |
|---|---|---|---|---|---|---|---|---|---|
| AI in the daily work | Shipped: post drafts and rewrites, reply drafts, intent label, contact match, ad drafts | Yes: Wisdom, smart replies | Yes: AI Assist | Yes: AI Assistant | Yes: AI Assist, agent credits | Yes: reply suggestions, never sent automatically | Yes: agents, credits | Yes: Botcake AI | Yes: IC Fin and Copilot; Crisp AI credits |
| A named coworker per area | Shipped in part: Dy and Uy through the roster | Not confirmed | Not confirmed | Not confirmed | Partial: Trellis agent | No | Yes: named agents | Partial | Partial: IC Fin, Crisp Hugo |
| AI sends nothing without a person | Shipped: every AI result is a tainted proposal; nothing sent without a person | Not confirmed | Not confirmed | Not confirmed | Not confirmed | Partial: suggestions are never sent automatically | Not confirmed | Not confirmed | No: IC Fin and Crisp bots answer on their own |
| AI spend limit per org | Shipped: AI budget meter | Not confirmed | Not confirmed | Not confirmed | Partial: monthly agent credits | Not confirmed | Yes: HubSpot Credits | Not confirmed | Partial: IC per-outcome price, Crisp credits |
| Open source and self-hosted | Shipped: AGPL | No | No | No | No | No | No | No | No |
| Vietnamese channels first (Zalo OA, Vietnamese tone marks) | Shipped: Zalo OA, banned-word matcher over diacritics | Not confirmed | Not confirmed | Not confirmed | Not confirmed | No | Not confirmed | Yes | Crisp: Zalo not found; IC: Not confirmed |
| Accounting and books on the same contacts | Shipped: Ludy Kế toán shares contacts | No | No | No | No | No | No: no ledger | Partial: Fintab, see [competitors.md](competitors.md) | No |

## Where Ludy Engage is different

Each point says whether it ships.

1. **One inbox for comments, chat and email, with no ticket model (shipped).** Hộp thư follows Intercom and Crisp, not Zendesk: New, Pending, Resolved, assignment, notes, saved replies, an intent label and a contact match, with Facebook comments, Messenger, Instagram and Zalo OA chat on `main`. Among the social tools only Hootsuite (Nest) and Sprout (Smart Inbox) show an inbox of this reach, and both sit on plans priced for teams. Publer shows none, and Meta's inbox covers only Meta's channels. Pancake is the closest and is ahead on channels and reply speed.
2. **Publishing and inbox in one place, on Zalo too (shipped).** No tool read for this page lists Zalo OA except Pancake, which has no publishing. Ludy publishes to Zalo OA and answers Zalo chat.
3. **A checked AI coworker, with a person approving (shipped).** Reply drafts, post drafts and ad drafts are proposals: AI text is marked as tainted, a person sends, every model call goes through the AI budget meter, and the core works with AI off. Intercom Fin and Crisp bots go the other way and answer by themselves. Others have AI; what their pages do not show is the rule that a person approves the send, so that is the claim, not "they lack AI".
4. **Ads with the owner's money behind two keys (built, not live).** Creating a campaign needs an approval that names the maximum spend, caps and a kill switch, and the switch is off until the owner's live check. No competitor page read shows an equivalent.
5. **Open source and self-hosted, with the books beside it (shipped).** Free to run with `docker compose up`, one set of contacts shared with Ludy Kế toán. The hosted Ludy Cloud is not live.

Where Ludy is behind, plainly: reach and polish. Hootsuite and Sprout have listening, sentiment and years of reporting; Meta's inbox has automated replies; Pancake has the order and the chatbot next to the chat; Buffer and Publer cost a few dollars per channel and have mobile apps and years of publishing polish. Ludy Cloud is not live, and for Facebook Page and Zalo OA the live account check is still pending.

## Gaps

Capabilities that at least one competitor has and that Ludy has neither shipped nor opened an issue for. Ranked by value for an OPC or SME in Vietnam, using the gate in [scope.md](scope.md). They are the author's suggestions, not decisions. The owner decides; nothing is built, and no issue is opened, until then.

| Rank | Gap | Who has it | Ludy status | Why it ranks here |
|---|---|---|---|---|
| 1 | Auto-answers in the inbox (away message, fixed answers, keyword replies) | Meta Business Suite, Pancake (Botcake), Crisp, Intercom Fin, HubSpot | Missing; a person sends every message, a standing rule | Always-on answers outside office hours sell more for one owner who cannot watch the inbox. It collides with the rule that a person approves each message, so it needs an owner decision first, for example fixed answers only (hours, price, stock) with no free-text promises |
| 2 | Boost a published post | Meta Business Suite (ads from a post is not confirmed on the page read) | Planned: W3 of the ads-write plan, no issue | Boosting a post is the paid step most Vietnamese SMEs actually take. Campaign creation is built but not live, so boost is the smaller slice on top, and it keeps the same approval and caps |
| 3 | Bulk messages to contacts who agreed (Zalo, Messenger) | Pancake (Botcake), Intercom (pay as you go) | Missing | Re-engaging past buyers is a main sales tool of Vietnamese social sellers. Platform windows and consent rules (Decree 91/2020, the personal data law) set limits, so a person approves each send |
| 4 | TikTok and YouTube comments in the inbox | Hootsuite (TikTok comments), Pancake (TikTok, coming soon) | Planned: section 6.6 of the conversations plan, later providers | TikTok is large in Vietnam, but the platform limits apps heavily; after Messenger, Instagram and Zalo are live in practice |
| 5 | Website live chat widget and a website chatbot | Intercom, Crisp, HubSpot Service Hub, Pancake (Webcake plugin) | Missing | Zalo OA and Messenger cover most small sellers; it matters once the owner has a site that brings visitors. Needs the landing-page gap in the suite page |
| 6 | WhatsApp as a channel | Hootsuite, Crisp, Intercom, Pancake (coming soon) | Planned: "WhatsApp later" in the conversations plan | Rare for Vietnamese customers, common for exporters and border trade; costs a business API contract |
| 7 | Social listening and competitor tracking | Hootsuite, Sprout (paid add-on), Publer Business | Missing | Useful for brands with budgets; a one-person company rarely reads a listening feed. Enterprise-leaning |
| 8 | Sentiment on messages | Sprout (Advanced) | Missing | Helps a large team sort angry customers; the intent label already sorts complaints for a small team |
| 9 | Knowledge base and a help-centre site | Intercom, Crisp, HubSpot Service Hub | Missing | A support-heavy concern; the owner decided against the ticket model |
| 10 | Tickets, SLA timers | Intercom, Crisp, HubSpot | Missing by decision (2026-11-03) | Not a gap to close: decided against, listed so the matrix is honest |

Not repeated because they are counted elsewhere: email marketing and campaigns (Planned, epic in the Icebox, see [email.md](../plan/email.md) and the suite page), landing pages and forms, payment links and phone calls ([competitors.md](competitors.md) "Gaps").

## What this does not say

- It is not a feature list to copy. Several of these tools exist for agencies and brands, which the scope gate sends to the Icebox.
- It names no price for Ludy, no date and no roadmap. "Planned" means a plan says so; it is not a commitment.
- It reads vendor pages, not feature depth: a "yes" does not say how well a product does the job, and a plan tier named here is the vendor's own label.

## Sources

Read on 2026-11-06. Each vendor's page is its public state at that date and changes without notice. Some pages did not open (redirect loops or 404) and were replaced by the help-centre or search results listed.

- Ludy: [scope.md](scope.md), [DESIGN.md](../../DESIGN.md), [social.md](../plan/social.md), [ads.md](../plan/ads.md), [ads-write.md](../plan/ads-write.md), [conversations.md](../plan/conversations.md), [ADR-0041](../adr/0041-conversation-core.md), [ADR-0043](../adr/0043-ads-write-running-ads.md), the runbooks in [docs/runbooks](../runbooks), and the code on `main` (`modules/social`, `modules/ads`, `packages/channel`, `packages/ad-platform`, `apps/kernel/src`).
- Hootsuite: https://www.hootsuite.com/plans (plans and prices), https://www.hootsuite.com/platform/publishing (networks, calendar, bulk, best time, approvals, link page), search results for the inbox: https://www.hootsuite.com/platform/social-media-inbox and https://help.hootsuite.com/s/article/get-started-inbox-agent.
- Publer: https://publer.com/help/en/article/what-are-publers-plans-and-pricing-15h4yqh.md (plans and what each includes), https://publer.com/plans, https://publer.com/roadmap (inbox on the roadmap), https://publer.com/blog/automate-link-in-bio-with-publer-linkie/. The pricing page itself (publer.com/pricing) did not load.
- Buffer: https://buffer.com/pricing.
- Sprout Social: https://sproutsocial.com/pricing/ (the page does not describe publishing, calendar, approvals or link in bio, so those cells say Not confirmed).
- Meta Business Suite: https://www.facebook.com/business/tools/meta-business-suite, https://www.facebook.com/business/help/294426838452244 (inbox and comments), https://www.facebook.com/business/help/395965998733706 (automated responses), https://www.facebook.com/business/help/991413128263758 (reply suggestions), https://en-gb.facebook.com/business/help/1200925110276123 (assign), https://www.facebook.com/business/help/205614130852988 (schedule and calendar), https://www.facebook.com/business/help/408098727639111 (Gmail in the inbox).
- HubSpot: https://www.hubspot.com/pricing/marketing, https://www.hubspot.com/pricing/service.
- Pancake: https://pancake.vn/features, https://pancake.vn/pricing, and the pages listed in [competitors.md](competitors.md) (read 2026-11-04).
- Intercom: https://www.intercom.com/pricing.
- Crisp: https://crisp.chat/en/pricing/, https://crisp.chat/en/shared-inbox/ and https://crisp.chat/en/shared-inbox/social-messaging/ (channels, from search results; Zalo was not found on any page read).
