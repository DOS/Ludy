# Competitor comparison: Ludy against MISA AMIS, Base.vn, HubSpot, Odoo and Pancake

Written on 2026-11-04 at the owner's request (JOY). The Vietnamese summary for the owner is [competitors.vi.md](competitors.vi.md); this English file is the canonical one. For a deeper, sourced accounting comparison against MISA, Fast and Odoo, see [the feature comparison](../research/competitor-feature-comparison.md).

This page is a market map, not a plan. It builds nothing and commits nothing. [scope.md](scope.md) section 6 names Odoo, MISA AMIS and Base.vn as the main reference products; HubSpot is added here because it is the best-known AI-first CRM suite, and Pancake (pancake.vn, added at the owner's request on 2026-11-04) because it is the best-known Vietnamese tool for selling through chat. Per [AGENTS.md](../../AGENTS.md), no issue is opened and nothing is built for a gap below until the owner agrees (see "Gaps").

For Ludy Engage alone (social publishing, inbox and ads) against Hootsuite, Publer, Buffer, Sprout Social, Meta Business Suite, HubSpot, Pancake and Intercom / Crisp, see [competitors-engage.md](competitors-engage.md).

## How to read it

Status of a Ludy capability, checked against the repository on 2026-11-04:

- **Shipped:** the code is on `main`.
- **In build:** a plan exists and its build issues are open (the issues exist; coding may not have started).
- **Planned:** it appears only in a plan, an ADR or the module table of the kernel plan, with no build issue yet, or its epic sits in the Icebox.
- **Missing:** no plan, no ADR, no issue.

A competitor cell says yes, partial or no, with the product name. "Not confirmed" means the vendor's public pages read for this page did not settle it. "Coming soon" is the vendor's own label on its page.

## Who they are

- **Ludy** (this repository, AGPL): an open-source, AI-first Business OS for Vietnamese one-person companies (OPC) and SMEs. One database, one sign-in, apps on a shared kernel, and AI coworkers inside each app: Vy (general manager), Ly (accounting), Dy (inbox, customers and sales), Uy (marketing). Self-hosted with `docker compose up`; the hosted Ludy Cloud is "sắp ra mắt" (coming soon).
- **MISA AMIS:** the Vietnamese market leader in accounting software, sold as a suite of 25+ modules (the vendor's own count) under one account: accounting, e-invoice, tax, banking, CRM, HR and payroll, office tools, purchasing, stock and production. Strong on Vietnamese rules and on household businesses. Closed source, cloud.
- **Base.vn:** a Vietnamese all-in-one suite of 69 apps (the vendor's own count), strongest in work, people, sales and communication. Its finance apps (Accounting, Invoice, Bankfeed and others) are all marked "Coming soon". Base 2.0 is sold as an "Agentic OS". Closed source, cloud.
- **HubSpot:** a US customer platform: Smart CRM with Marketing, Sales, Service, Content, Data and Revenue hubs, plus AI agents. No accounting or general ledger; it syncs revenue data to tools such as QuickBooks and Xero. Closed source, cloud.
- **Odoo:** a Belgian open-source business suite with about 60 apps. Closest to Ludy in how it is built: one platform and one database, apps that install on top. It has a Vietnam accounting module and a Viettel S-Invoice connector. Community edition is open source; Enterprise and the cloud are paid.
- **Pancake:** a Vietnamese chat-commerce platform that also has its own accounting app, which makes it the closest competitor to Ludy's whole story (inbox and orders plus accounting in one family). The vendor says 260,000+ businesses. It is a family of apps that share one account (Pancake ID): **Pancake** (one inbox for messages and comments from social channels, Zalo, TikTok, WhatsApp and marketplaces, with auto-assignment, tags and orders created inside the chat), **Pancake POS** (multi-channel orders, real-time stock, shipping carrier connections, payment and QR per order, calls, bulk messages; 40,000+ customers), **Pancake CRM** (leads from every channel, pipeline stages, automations, conversion events sent to ad platforms), **Botcake** (AI chatbot and bulk messages on Facebook, TikTok and WhatsApp; 150,000+ businesses), **Webcake** (Landing Page and Storefront builders with a chat plugin), **Pancake Work** (internal chat, Kanban tasks, Issues and time-keeping, desktop and phone apps), **Fintab** (a TT133 accounting app with an AI assistant: cash, bank deposits, sales, purchase, e-invoice, stock, tools and supplies, fixed assets, payroll, tax, reports and opening balances; its public page targets household businesses and online sellers with the 2026 tax rules), and a WhatsApp Business API service. The depth of Fintab's e-invoice issuing and payroll is not confirmed from the outside. No social publishing was found on its pages. Closed source, cloud.

## Pricing model (public pages only)

- **Ludy:** open source; self-host free. No hosted price: Ludy Cloud is not live.
- **MISA AMIS:** three bundles (Standard, Professional, Enterprise) priced by company size and number of users, paid at least 12 months at a time. The page shows a monthly figure that changes with the size picked; see the source.
- **Base.vn:** per account per month, billed yearly, by solution (Base Work, Base HRM, Base CRM) and tier; combos such as Base One and Base Agentic OS are priced per account per year. Figures are public on the pricing page.
- **HubSpot:** a free tier, then Starter, Professional and Enterprise per hub. Marketing Hub Professional shows "from USD 800 per month" and Enterprise "from USD 3,600 per month", with onboarding fees. AI agents are metered in paid "HubSpot Credits".
- **Odoo:** one free app with unlimited users, then Standard and Custom plans per user per month, yearly or monthly (USD 8.95 and USD 20.40 are the lowest and highest list prices shown for the two plans, with a first-year discount mark). The open-source Community edition is free to download.
- **Pancake:** a 14-day trial, then plans by number of connected pages and staff, with 3, 6 or 12 month terms (Small is one page and 3 staff, listed from 550,000 VND for 6 months; Standard 3 pages; Business 6 pages and 10 staff; extra pages and staff are sold per month). The other apps of the family are described as free to use with a Pancake plan; the WhatsApp service has its own message price list. Fintab, Botcake and Webcake prices were not read.

## Capability matrix

Ludy cells give the status first. Competitor cells give yes, partial or no, with the product.

| Capability | Ludy | MISA AMIS | Odoo | Pancake | Base.vn | HubSpot |
|---|---|---|---|---|---|---|
| **Finance and accounting** | | | | | | |
| Books to Vietnamese standards (TT133) | Shipped: Ludy Kế toán | Yes: AMIS Kế toán, MISA SME | Yes: Accounting, Vietnam module | Yes: Fintab, TT133 books (cash, bank, sales, purchase, stock, fixed assets, payroll, tax, reports, opening balances) | No: Accounting "Coming soon" | No: no ledger |
| Purchase e-invoice intake and AI reading | Shipped: XML. With limits: PDF and photo reading needs the operator's own AI model and scanned PDFs are refused; the tax portal sync is assisted, off by default, never run on the real portal (#1100 open) | Yes: Hóa đơn điện tử, Kế toán | Partial: vendor bills in Accounting, not confirmed for Vietnamese XML | Partial: Fintab has Mua hàng and Hóa đơn điện tử; AI reading and XML checks not confirmed | No: Invoice "Coming soon" | No |
| Issue sales e-invoices | In build: drafts and an offline provider shipped; live providers open | Yes: Hóa đơn điện tử (meInvoice) | Partial: Viettel S-Invoice connector | Yes: Fintab has a Hóa đơn điện tử area; providers and depth not confirmed from outside | No: Invoice "Coming soon" | Partial: Invoices, not tax-authority e-invoices |
| VAT return and financial statements with tax XML | Shipped: 01/GTGT, B01-DNN, B02-DNN, HTKK XML | Yes: Thuế điện tử, AMIS Kế toán | Not confirmed for Vietnam | Yes: Fintab has Thuế and Báo cáo; tax XML export not confirmed | No | No |
| Bank statements, matching, bank feed | Shipped: statement import and matching; In build: live bank feed | Yes: Ngân hàng điện tử | Partial: statement import and QR codes; Vietnamese bank sync not confirmed | Partial: Fintab has Tiền gửi; statement import and bank feed not confirmed | No: Bankfeed "Coming soon" | No |
| Fixed assets and depreciation | Shipped | Yes: AMIS Kế toán, Tài sản | Partial: Accounting | Yes: Fintab, Tài sản cố định and Công cụ dụng cụ (tools and supplies) | No: Asset "Coming soon" | No |
| Household business (hộ kinh doanh) books | In build: plan and issues for books S1a to S2e | Yes: Kế toán HKD | No | Yes: Fintab, 2026 household tax declarations | No | No |
| Cooperative (HTX) books | Missing | Yes: Kế toán HTX | No | Not confirmed | No | No |
| Expense claims and advances | Missing | Not confirmed | Yes: Expenses | Partial: Fintab records expenses and debts | Yes: Expense | No |
| Digital signature, tax filing, audit, business loans | Missing | Yes: Chữ ký số, Thuế điện tử, Kiểm toán, Vay vốn | No | Not confirmed | No | No |
| **Sales and CRM** | | | | | | |
| Contacts, deals, pipeline board, import | Shipped: Engage, Customers and Sales | Yes: CRM | Yes: CRM | Yes: CRM, and customer records inside Pancake | Yes: Sales | Yes: Sales Hub, Smart CRM |
| Booking pages and calendar | Shipped: booking pages, Google Calendar | Partial: Lịch | Yes: Appointments | Partial: CRM appointments for service businesses | Partial: Booking (rooms and resources) | Yes: Meeting Scheduler |
| Quotes, sales orders, contracts | Missing | Partial: CRM, Hợp đồng điện tử | Yes: Sales | Partial: orders in Pancake POS; quotes not confirmed | Yes: Commerce, Contract | Yes: Quotes, Revenue Hub |
| Recurring billing and payment links | Missing | Partial: Cổng thanh toán | Yes: Subscriptions | Partial: payment gateways and a QR code per order in POS | Not confirmed | Yes: Subscriptions, Payment Links |
| Point of sale (retail, restaurant) | Missing | Yes: Cửa hàng, Nhà hàng | Yes: POS Shop, POS Restaurant | Yes: Pancake POS (web, marketplaces, social and retail stores) | Partial: Commerce | No |
| Orders taken inside the chat (chat commerce) | Missing | Not confirmed | Not confirmed | Yes: Pancake, create a POS order in the live chat and from livestreams | Not confirmed | Not confirmed |
| **Marketing** | | | | | | |
| Social publishing and review | Shipped: Engage, Marketing | Partial: aiMarketing | Yes: Social Marketing | Not confirmed: pages describe replies, not publishing | No | Yes: Social Media Management |
| Ads: read results | Shipped | Not confirmed | No | Partial: conversion events to Meta and Google, ad results per channel in POS | Yes: Ads manager | Yes: Ads Software |
| Ads: create and run campaigns | In build: first slice shipped, launch and pause open | Not confirmed | No | Partial: optimises Facebook Ads from conversion events; no campaign creation confirmed | No: measure only | Yes: Ads Software |
| Email marketing and campaigns | Planned: plan accepted, epic in the Icebox | Yes: aiMarketing | Yes: Email Marketing | Partial: CRM automations send email and messages | Coming soon: Express | Yes: Marketing Hub |
| SMS, WhatsApp, Zalo notifications | Missing | Not confirmed | Yes: SMS Marketing, WhatsApp | Yes: bulk messages on Facebook, TikTok, WhatsApp, Zalo (Botcake, POS) | Coming soon: Express | Yes: SMS Marketing, WhatsApp |
| Website, landing pages, forms | Missing (a link-in-bio page ships in Engage) | No | Yes: Website, eCommerce | Yes: Webcake Landing and Storefront | Coming soon: Form | Yes: Content Hub |
| Promotions and loyalty | Missing | Yes: Khuyến mại | Yes: eCommerce, POS | Partial: Botcake offers promotions in chat | Not confirmed | Partial: Marketing Hub |
| **Service and inbox** | | | | | | |
| One inbox for customer messages and comments | In build: Zalo OA messages shipped; Facebook comments and Messenger open | Not confirmed | Partial: Live Chat, Discuss | Yes: Pancake (social, Zalo, TikTok, WhatsApp, marketplace chats) | Partial: Prospect | Yes: Shared Inbox |
| Tickets, SLA, help desk | Missing by decision: no cases, tickets or SLA (2026-11-03) | No | Yes: Helpdesk | Partial: tags and auto-assignment; no tickets or SLA confirmed | Partial: Success | Yes: Service Hub |
| Knowledge base and customer portal | Missing | No | Partial: Knowledge, eLearning, Forum | Not confirmed | Not confirmed | Yes: Service Hub |
| Live chat widget and chatbot | Missing | Not confirmed | Yes: Live Chat | Yes: Botcake chatbot, chat plugin in Webcake | Not confirmed | Yes: Live Chat, chatbots |
| Phone and VoIP | Missing | Not confirmed | Yes: VoIP | Yes: call recording and history in POS and Pancake | Coming soon: Call | Yes: Sales Hub VoIP |
| **Work and projects** | | | | | | |
| Tasks and personal to-dos | Shipped: tasks, My work, Notes | Yes: Công việc | Yes: Project, To-do | Yes: Pancake Work | Yes: Task | Partial: CRM tasks |
| Projects with board and list | In build: ADR-0048 accepted, issues open | Yes: Công việc | Yes: Project | Yes: Pancake Work (Kanban, Issues) | Yes: Project | No |
| Notes and documents | Shipped: Notes | Yes: Ghi chép | Yes: Documents, Knowledge | Not confirmed | Yes: Docs | No |
| Approvals and request forms | Partial: approval of AI and posting proposals only | Yes: Quy trình | Yes: Approvals | Not confirmed | Yes: Request | No |
| Workflow and automation builder | Missing | Yes: Workflow | Yes: Studio | Partial: chatbot flows and CRM automations | Yes: Workflow, Automation | Yes: Workflow Automation |
| Electronic signature and contracts | Planned: `sign` module in the kernel plan | Yes: Hợp đồng điện tử | Yes: Sign | Not confirmed | Yes: E-Sign, Contract | Partial: quote e-signatures |
| Records and incoming documents (văn thư) | Partial: files and evidence storage | Yes: Văn thư | Partial: Documents | Not confirmed | Yes: E-Office, Drive | No |
| **People and HR** | | | | | | |
| Payroll, social insurance, personal income tax | In build: plan and issues; will be the HR app, module `hr` | Yes: Tiền lương, BHXH, Thuế TNCN | Partial: Payroll app; Vietnam payroll not confirmed | Partial: Fintab has Tiền lương; social insurance and personal income tax depth not confirmed | Yes: Payroll | No |
| Employee records | In build: staff list inside the payroll plan | Yes: Thông tin nhân sự | Yes: Employees | Not confirmed | Yes: HRIS | No |
| Time and attendance, leave | In build: time-keeping inputs and leave balances for payroll | Yes: Chấm công | Yes: Time Off, Timesheets | Yes: Chấm công in Pancake Work | Yes: Timesheet | No |
| Recruiting | Missing | Yes: Tuyển dụng | Yes: Recruitment | No | Yes: E-Hiring | No |
| Goals and performance reviews | Missing | Yes: Mục tiêu, Đánh giá | Yes: Appraisals | No | Yes: Goal, Review | No |
| **Communication** | | | | | | |
| AI meeting notes | In build: ADR-0047 accepted, issues open | Partial: Phòng họp (rooms) | No | No | Yes: Meeting | Partial: Conversation Intelligence (calls) |
| Internal chat | Missing | Yes: Chat | Yes: Discuss | Yes: Pancake Work channels and direct messages | Yes: Chat | No |
| Company news feed | Missing | Yes: Mạng xã hội | Partial: Discuss | Partial: Pancake Work channels | Yes: Townhall | No |
| Mailbox | Partial: inbound address and outbound mail; no mailbox | Yes: Mail | Partial: Discuss | No | Coming soon: Mail | Partial: email integration |
| **Operations (stock, purchase, production)** | | | | | | |
| Stock and cost of goods sold | In build: plan and issues | Yes: Kho hàng | Yes: Inventory | Yes: Fintab Kho and real-time stock in POS; cost method not confirmed | Yes: Inventory | No |
| Marketplace orders (Shopee, TikTok Shop, Lazada) | In build: plan and issues | Not confirmed | Not confirmed | Yes: POS takes orders from marketplaces and syncs stock | Not confirmed | No |
| Shipping carrier connection and delivery tracking | Missing | Not confirmed | Not confirmed | Yes: POS creates carrier orders, syncs status, tracks fees | Not confirmed | No |
| Purchase orders and suppliers | Missing (purchase invoices only) | Yes: Mua hàng | Yes: Purchase | Partial: Fintab has Mua hàng; purchase orders not confirmed | Not confirmed | No |
| Manufacturing | Missing | Yes: Sản xuất | Yes: Manufacturing, PLM, Quality | No | Partial: bill of materials in Inventory | No |
| Operational assets and maintenance | Missing | Yes: Tài sản | Yes: Maintenance, Fleet | No | Not confirmed | No |
| **AI** | | | | | | |
| AI inside the daily workflow | Shipped: invoice reading, bank and party matching, post drafts, payment reminders, Vy's daily brief | Yes: MISA AVA, OneAI | Yes: AI app | Yes: Botcake AI chatbot, AI assistant in Fintab and Pancake | Mostly "Coming soon": Agent, Agents, AI Workspace | Yes: Breeze agents, AI Assistant |
| A named coworker per department | Shipped in part: Vy and the roster in the design; per-member Vy is Planned (ADR-0049) | Partial: AVA, Agentwork | No | Partial: Botcake AI agent, no named roster | Coming soon: Agents | Yes: Agent Hub |
| AI proposes, a person approves, with checks | Shipped: AI Inbox, tainted output, approval and four-eyes rules | Not confirmed | Not confirmed | Partial: bot-to-human handover in Botcake | Not confirmed | Partial: agents with spend and action limits |
| AI spend limits per org and module | Shipped: AI budget meter | Not confirmed | Not confirmed | Not confirmed | Not confirmed | Yes: HubSpot Credits |
| Build your own AI app or agent | Missing | Partial: Agentwork | Yes: Studio | Partial: Botcake pre-built scripts and AI flows | Coming soon: Studio | Yes: AI Studio |
| **Platform and integrations** | | | | | | |
| Open source and self-hosted | Shipped: AGPL, `docker compose up` | No | Yes: Community edition | No | No | No |
| Several legal entities in one org | Shipped: legal entities | Not confirmed | Yes: multi-company (Custom plan) | Not confirmed | Not confirmed | Yes: multi-account |
| Tamper-evident audit log and org export | Shipped | Not confirmed | Not confirmed | Not confirmed | Not confirmed | Partial: activity logs |
| App marketplace and public API | Planned: OAuth server in ADR-0032, proposed | Yes: Chợ ứng dụng | Yes: External API (Custom plan) | Partial: open API and reports | Not confirmed | Yes: app marketplace |
| No-code customization | Missing | Partial: custom software service | Yes: Studio | Partial: Webcake custom code | Coming soon: Studio | Yes: custom objects |
| Industry packs | Missing | Yes: 20+ industry solutions | Yes: industry modules | Partial: solutions by industry (fashion, education, beauty, retail) | Not confirmed | Not confirmed |

## Pancake and Ludy: where they overlap

Pancake is the closest competitor to Ludy's whole story: the inbox and the orders (Pancake, POS, CRM, Botcake) plus the accounting (Fintab) in one family under one account. Fintab is a TT133 accounting app with an AI assistant, bundled with Pancake POS and the inbox. It competes head on with Ludy Kế toán, not only on household books. Its menu, as seen in the signed-in app at fintab.pancake.vn, has a basic group (overview dashboard, cash, bank deposits, sales, purchase, e-invoice, stock) and an advanced group (summary, tools and supplies, fixed assets, lists, payroll, tax, reports, opening balances, settings), and it shows the accounting regime as TT133. How deep its e-invoice issuing and payroll go is not confirmed from the outside. MISA AMIS is still the deepest on Vietnamese tax. The overlaps, with Ludy's status:

- **Inbox (Ludy Engage, Dy).** Pancake's core product is one inbox for social messages and comments, Zalo, TikTok, WhatsApp and marketplace chats, with auto-assignment, tags and a mobile app. Ludy Engage has the same job and is in build (Zalo OA messages shipped; Facebook comments and Messenger open). Pancake is ahead on channels and on speed of reply tools; Ludy's difference is that a reply draft is an AI proposal a person approves.
- **Social and ads (Engage, Uy).** Pancake does not publish posts (not found on its pages), and it optimises ads only through conversion events sent to Meta and Google. Ludy publishes posts today and reads ads, and is building campaign creation. Little overlap; Ludy is ahead on publishing, Pancake on feeding conversion data to ad platforms.
- **CRM (Engage, Dy).** Pancake CRM and Ludy's Customers and Sales both keep contacts, stages and a pipeline. Pancake adds automations and conversion events; Ludy shares the same contacts with the books.
- **Orders and stock.** This is the biggest overlap and Pancake's strongest ground: orders created inside a chat, orders from marketplaces, real-time stock, shipping carriers, payment QR per order. Ludy has no order and no carrier today. Its stock plan (in build) covers stock, cost of goods and marketplace order reports, but it starts from invoices and report files, not from a chat order, and it has no carrier connection.
- **Accounting (Ludy Kế toán, Ly).** Fintab covers the same ground as Ludy Kế toán: TT133 books, cash and bank, sales and purchase, e-invoice, stock, tools and supplies, fixed assets, payroll, tax and reports, and its page targets household businesses and online sellers in the Pancake family (Ludy's household-business plan is in build). Its page says it turns every sale into accounting and tax reports, so the sale flows from the order into the books inside one family. Ludy has the books shipped, but the order does not exist yet, so the sale reaches the books only through invoices and files. Fintab's AI assistant is seen in the app header; what it does, and whether deterministic checks and a person's approval sit behind it, is not confirmed.
- **Internal work.** Pancake Work (chat, Kanban, time-keeping) overlaps with Ludy's projects and time-keeping plans, with an internal chat Ludy does not plan.

## Where Ludy is different

Each point says whether it ships or is planned.

1. **AI coworkers inside each workflow, with a person approving (shipped in part).** Shipped: every AI result is a proposal that deterministic checks examine and a person approves; AI text is marked as tainted; every model call goes through a per-org budget meter; the AI Inbox batches approvals. The AI features on `main` are invoice reading, social drafts and rewrites, booking scheduling, reply drafts, intent and contact suggestions, payment-reminder wording, ad-campaign drafts and Vy's daily brief. Planned or in build: Vy per member (ADR-0049, proposed), the payroll coworker, stock matching. The named roster (Vy, Ly, Dy, Uy) is the design; Hy is reserved. Others have AI too (MISA AVA, HubSpot agents, Botcake's chatbot, Fintab's AI assistant); what the pages do not show is a rule that AI output is a checked proposal a person approves, so that is the claim, and it is not a claim that they lack AI.
2. **Open source and self-hosted (shipped).** AGPL, runs on `docker compose up` with no DOS service. Among the five competitors only Odoo's Community edition is open source, and Odoo's Enterprise features are paid. Ludy Cloud is not live ("sắp ra mắt").
3. **Vietnamese tax, e-invoice and bank specifics.**
   - Shipped: TT133 books, gapless voucher numbers, Vietnamese e-invoice XML checks (tax-authority code, tax-code check digit), VAT return working papers and XML, financial statements with HTKK XML, MISA SME import templates, assisted tax portal sync, bank statement import and matching.
   - In build: issuing sales e-invoices through the seller's own provider, original invoice fetch from provider lookup pages, a live bank feed (Tingee is the first adapter), household business books, payroll with BHXH and personal income tax, stock and marketplace payouts.
   - Not a difference: MISA AMIS already covers most of this and more (digital signature, tax filing, audit, loans), and Pancake Fintab lists TT133 books, e-invoice, tax, payroll and stock in its menu. The depth of Fintab's e-invoice issuing and payroll is not confirmed from the outside. What the repository shows that no competitor page confirms is the checking: e-invoice XML is verified deterministically (tax-authority code, tax-code check digit, totals) before anything is proposed, PDFs and photos are read by AI and checked the same way, and MISA SME import templates are shipped. Ludy's edge is that checked, approved AI reading and the open code, not coverage.
4. **One write path with approvals (shipped).** Every state change is a command through one runtime; row-level security isolates each org; the audit log is append-only and anchored in a tamper-evident archive; four-eyes approval and fresh MFA guard risky actions. None of the five competitors publishes an equivalent on the pages read for this comparison, so the cells above say "not confirmed" rather than "no".
5. **Accounting and customer work on one set of contacts (shipped).** Contacts and companies are shared between Ludy Kế toán and Engage. This is not unique: Pancake keeps its apps under one account and says Fintab turns sales into reports, and Odoo and MISA AMIS also run as one suite (not compared in depth). Base.vn has no accounting yet and HubSpot has no ledger.

Where Ludy is behind, plainly: breadth. MISA AMIS has 25+ modules and Base.vn 69 apps, most of them live; Odoo about 60. Ludy has three apps on `main` (Kế toán, Engage, Notes) and several in build.

## Gaps

These are capabilities that at least one competitor has and that Ludy has neither shipped, nor planned, nor opened an issue for. Priorities are the author's suggestions for an OPC or SME, AI-first, using the gate in [scope.md](scope.md). They are not decisions. The owner decides; nothing is built, and no issue is opened, until then.

| Gap | Who has it | SME value | Suggested priority |
|---|---|---|---|
| Quotes (báo giá) and sales orders from a deal | HubSpot Quotes, Odoo Sales, Base Commerce and Contract, MISA CRM, Pancake POS (orders) | A seller quotes every week; today the deal ends where the e-invoice starts. The sales coworker could draft the quote from a chat line. Pancake shows that Vietnamese small sellers expect the order itself to live next to the chat (see "Where quotes and sales orders belong") | High (unchanged) |
| Orders taken inside the chat (chat commerce) | Pancake (orders from the live chat and from livestreams), Pancake POS | The way many Vietnamese small sellers actually sell: the customer says what they want in Messenger or Zalo, and someone types it into a spreadsheet. Dy could propose the order from the conversation, a person approves. Needs the order object of the row above | High (new, because of Pancake) |
| Shipping carrier connections and delivery tracking | Pancake POS | Once Ludy holds an order, a seller of goods needs the parcel booked, the status followed and the shipping fee booked. Carriers have APIs, but each is a partner contract. Goes with the order and stock work | Medium (new, because of Pancake) |
| Purchase orders and supplier list | MISA Mua hàng, Odoo Purchase | Pairs with stock and purchase invoices; a small shop orders from the same suppliers monthly | Medium |
| Expense claims and advances | Base Expense, Odoo Expenses | A team of 5 to 20 pays from pockets; the finance coworker could read the receipt and propose the entry | Medium |
| Payment links and recurring billing | HubSpot Payment Links and Subscriptions, Odoo Subscriptions, MISA Cổng thanh toán, Pancake POS (payment gateways, QR per order) | Getting paid faster is the owner's weekly worry; needs a payment partner and the owner's decision on spending. A QR per order is the small, useful slice | Medium (unchanged) |
| Bulk messages and broadcasts to contacts who agreed (Zalo, Messenger, WhatsApp, SMS) | HubSpot, Odoo, Base Express (coming soon), Pancake Botcake and POS | Re-engaging past buyers is a main sales tool of Vietnamese social sellers, and Botcake claims 150,000+ businesses. Platform windows and the consent rules (Decree 91/2020 and the personal data law) set the limits, so a person approves each send | High (was Medium, because of Pancake) |
| Chatbot that answers and takes orders without a person | Pancake Botcake, HubSpot Customer Agent | Always-on answers outside office hours sell more. But it conflicts with a current rule that a person approves every message sent. This needs an owner decision before anyone plans it: for example a fixed-answer bot (opening hours, prices, stock) with no free-text promises | Medium (new; owner decision needed) |
| Website, landing pages and forms that fill the CRM | HubSpot Content Hub, Odoo Website, Base Form (coming soon), Pancake Webcake | The landing page is where a Facebook ad lands. Ludy is building campaign creation, so a campaign with no page to send people to is incomplete. A one-page builder, not a full website, is the small slice | Medium (was Low, because of Pancake and Ludy's own ads work) |
| Live chat widget on a website | HubSpot, Odoo, Pancake Webcake (chat plugin) | Depends on the website gap; Zalo OA and Messenger already cover most small sellers | Low (unchanged) |
| Phone calls with recording, linked to the order or deal | HubSpot VoIP, Odoo VoIP, Base Call (coming soon), Pancake POS | Telesales is common in Vietnamese retail but is a telephony partner contract | Low |
| Customer portal and knowledge base | HubSpot Service Hub | A support-heavy concern; the owner decided against tickets and SLA | Low |
| Internal chat and company news feed | MISA Chat, Base Chat and Townhall, Odoo Discuss, Pancake Work | Teams already use Zalo and Messenger groups; high cost to win | Low |
| Recruiting | MISA Tuyển dụng, Base E-Hiring, Odoo Recruitment | Small teams hire rarely; an AI screening helper would be the only reason | Low |
| Goals and performance reviews (OKR, KPI) | MISA Mục tiêu and Đánh giá, Base Goal and Review, Odoo Appraisals | Mostly for larger companies | Low |
| Workflow and automation builder | MISA Workflow, Base Workflow and Automation, HubSpot Workflow Automation, Odoo Studio | The coworkers already act inside each app; a builder adds setup, against the "no setup" rule | Low |
| Point of sale for counter sales, and restaurant | MISA Cửa hàng and Nhà hàng, Odoo POS, Pancake POS (retail stores) | A different product from an online order: a till, receipts and shifts. Household shops may need it, but MISA, Odoo and Pancake own it | Low |
| Manufacturing, maintenance, fleet | MISA Sản xuất, Odoo Manufacturing, Maintenance and Fleet | Enterprise-leaning; outside the gate | Low |
| Cooperative (HTX) books | MISA Kế toán HTX | Narrow market | Low |
| Digital signature (CA), direct tax filing, audit and loan marketplace | MISA Chữ ký số, Thuế điện tử, Kiểm toán, Vay vốn | Partner services that need licences or contracts; assisted filing and e-signature (`sign`) are already planned in part | Low |
| Industry packs | MISA Giải pháp (20+ industries), Odoo, Pancake (solutions for fashion, education, beauty, retail) | Later, once the core apps are live | Low |
| App marketplace and public API | MISA Chợ ứng dụng, HubSpot marketplace, Odoo External API | Needed once partners want to integrate; OAuth server is only proposed | Low |
| Own AI app or agent builder | HubSpot AI Studio, Odoo Studio, Base Studio (coming soon) | Not for an OPC; the named coworkers are the product | Low |

Missing items that are decided against or already counted above are not repeated: tickets and SLA (decided against on 2026-11-03), sign (planned), email marketing (planned, epic in the Icebox).

### What Pancake changes in the priorities

- Raised: bulk messages to consenting contacts (Medium to High) and landing pages (Low to Medium).
- Added: orders taken inside the chat (High), shipping carriers (Medium), a chatbot that answers without a person (Medium, owner decision first), and phone calls with recording (Low).
- Unchanged: quotes and orders stay High; payment links stay Medium; the live chat widget stays Low.
- Why: Pancake shows that for a Vietnamese small seller the chat is where the sale happens, so the order, the carrier and the broadcast sit right next to the inbox. Ludy's inbox is in build, so the order that follows from it is the next thing a seller will ask for. Fintab means Pancake also competes on accounting, but it does not open a new accounting gap in the list; it raises the cost of being late on the order object, because Pancake already links the sale to its books.

### Where quotes and sales orders belong

They belong in CRM (the Customers and Sales group of Engage): a deal leads to a quote, the quote leads to an order. The order then links to two things: the stock move (the stock plan's goods and shipped lines) and the sales e-invoice draft (the e-invoice issuing plan), so one confirmed order drives both and nobody types it twice. A deal without goods can skip the stock link; a service quote goes straight to the invoice draft. A separate POS app is something different: it is for counter sales (a till, a receipt, a shift), not for orders that start from a deal or a chat. If a POS is wanted later, it should create the same order object rather than a second one.

One thing worth the owner's attention beyond the list: Base.vn has marked its whole Finance group "Coming soon", and HubSpot has no ledger. Of the five, MISA AMIS, Odoo and Pancake (through Fintab) compete with Ludy Kế toán across the board today, and MISA AMIS is the only one confirmed to have the full Vietnamese tax chain live. Pancake is the one to watch: it already owns the inbox and the order, and it has put accounting next to them. The widest open lane is therefore AI-first accounting plus customer work for the smallest businesses; the gaps most likely to block a paying customer are quotes and, for sellers of goods, stock and purchasing.

## Sources

Read on 2026-11-04. Each vendor's list is its public page at that date and changes without notice.

- Ludy: [scope.md](scope.md), [DESIGN.md](../../DESIGN.md), the plans in [docs/plan](../plan), the ADRs in [docs/adr](../adr), the modules and routes on `main`, and the open issues of DOS/Ludy (for example payroll #2530 and #2531, stock #2512 to #2515, projects #2586 to #2610, meetings #2575 to #2594, e-invoice issuing #2504 and #2505, bank feed #2045, conversations #2307 and #2308, email epic #537).
- MISA AMIS: https://amis.misa.vn/ (product menu), https://amis.misa.vn/bang-gia-bo-giai-phap-quan-tri-hop-nhat-misa-amis/ (bundles and "25+ modules").
- Base.vn: https://base.vn/app (the 69-app catalog), https://base.vn/bang-gia (pricing).
- HubSpot: https://www.hubspot.com/products, https://www.hubspot.com/pricing, https://www.hubspot.com/products/commerce (Revenue Hub, formerly Commerce Hub).
- Pancake: https://pancake.vn/ (product list), https://pancake.vn/features, https://pancake.vn/pricing, https://pos.pancake.vn/, https://crm.pancake.vn/, https://botcake.io/, https://webcake.io/, https://pancakework.vn/, https://fintab.pancake.vn/ (public page; the app's menu was also seen in the signed-in app at fintab.pancake.vn).
- Odoo: https://www.odoo.com/page/all-apps, https://www.odoo.com/pricing, https://www.odoo.com/documentation/master/applications/finance/fiscal_localizations/vietnam.html (Vietnam localization and the SInvoice connector).

Limits of this comparison: the matrix reads vendor product lists, not feature depth; a "yes" does not say how well a product does the job. The pages for Odoo were read through a text summary because the site did not open in the built-in browser. The prices of Pancake's Fintab, Botcake and Webcake were not read. Items marked "not confirmed" need a closer look before anyone relies on them.
