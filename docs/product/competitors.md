# Competitor comparison: Ludy against MISA AMIS, Base.vn, HubSpot and Odoo

Written on 2026-11-04 at the owner's request (JOY). The Vietnamese summary for the owner is [competitors.vi.md](competitors.vi.md); this English file is the canonical one.

This page is a market map, not a plan. It builds nothing and commits nothing. [scope.md](scope.md) section 6 names Odoo, MISA AMIS and Base.vn as the main reference products; HubSpot is added here because it is the best-known AI-first CRM suite. Per [AGENTS.md](../../AGENTS.md), no issue is opened and nothing is built for a gap below until the owner agrees (see "Gaps").

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

## Pricing model (public pages only)

- **Ludy:** open source; self-host free. No hosted price: Ludy Cloud is not live.
- **MISA AMIS:** three bundles (Standard, Professional, Enterprise) priced by company size and number of users, paid at least 12 months at a time. The page shows a monthly figure that changes with the size picked; see the source.
- **Base.vn:** per account per month, billed yearly, by solution (Base Work, Base HRM, Base CRM) and tier; combos such as Base One and Base Agentic OS are priced per account per year. Figures are public on the pricing page.
- **HubSpot:** a free tier, then Starter, Professional and Enterprise per hub. Marketing Hub Professional shows "from USD 800 per month" and Enterprise "from USD 3,600 per month", with onboarding fees. AI agents are metered in paid "HubSpot Credits".
- **Odoo:** one free app with unlimited users, then Standard and Custom plans per user per month, yearly or monthly (USD 8.95 and USD 20.40 are the lowest and highest list prices shown for the two plans, with a first-year discount mark). The open-source Community edition is free to download.

## Capability matrix

Ludy cells give the status first. Competitor cells give yes, partial or no, with the product.

| Capability | Ludy | MISA AMIS | Base.vn | HubSpot | Odoo |
|---|---|---|---|---|---|
| **Finance and accounting** | | | | | |
| Books to Vietnamese standards (TT133) | Shipped: Ludy Kế toán | Yes: AMIS Kế toán, MISA SME | No: Accounting "Coming soon" | No: no ledger | Yes: Accounting, Vietnam module |
| Purchase e-invoice intake and AI reading | Shipped: XML, PDF, photo, tax portal sync | Yes: Hóa đơn điện tử, Kế toán | No: Invoice "Coming soon" | No | Partial: vendor bills in Accounting, not confirmed for Vietnamese XML |
| Issue sales e-invoices | In build: drafts and an offline provider shipped; live providers open | Yes: Hóa đơn điện tử (meInvoice) | No: Invoice "Coming soon" | Partial: Invoices, not tax-authority e-invoices | Partial: Viettel S-Invoice connector |
| VAT return and financial statements with tax XML | Shipped: 01/GTGT, B01-DNN, B02-DNN, HTKK XML | Yes: Thuế điện tử, AMIS Kế toán | No | No | Not confirmed for Vietnam |
| Bank statements, matching, bank feed | Shipped: statement import and matching; In build: live bank feed | Yes: Ngân hàng điện tử | No: Bankfeed "Coming soon" | No | Partial: statement import and QR codes; Vietnamese bank sync not confirmed |
| Fixed assets and depreciation | Shipped | Yes: AMIS Kế toán, Tài sản | No: Asset "Coming soon" | No | Partial: Accounting |
| Household business (hộ kinh doanh) books | In build: plan and issues for books S1a to S2e | Yes: Kế toán HKD | No | No | No |
| Cooperative (HTX) books | Missing | Yes: Kế toán HTX | No | No | No |
| Expense claims and advances | Missing | Not confirmed | Yes: Expense | No | Yes: Expenses |
| Digital signature, tax filing, audit, business loans | Missing | Yes: Chữ ký số, Thuế điện tử, Kiểm toán, Vay vốn | No | No | No |
| **Sales and CRM** | | | | | |
| Contacts, deals, pipeline board, import | Shipped: Engage, Customers and Sales | Yes: CRM | Yes: Sales | Yes: Sales Hub, Smart CRM | Yes: CRM |
| Booking pages and calendar | Shipped: booking pages, Google Calendar | Partial: Lịch | Partial: Booking (rooms and resources) | Yes: Meeting Scheduler | Yes: Appointments |
| Quotes, sales orders, contracts | Missing | Partial: CRM, Hợp đồng điện tử | Yes: Commerce, Contract | Yes: Quotes, Revenue Hub | Yes: Sales |
| Recurring billing and payment links | Missing | Partial: Cổng thanh toán | Not confirmed | Yes: Subscriptions, Payment Links | Yes: Subscriptions |
| Point of sale (retail, restaurant) | Missing | Yes: Cửa hàng, Nhà hàng | Partial: Commerce | No | Yes: POS Shop, POS Restaurant |
| **Marketing** | | | | | |
| Social publishing and review | Shipped: Engage, Marketing | Partial: aiMarketing | No | Yes: Social Media Management | Yes: Social Marketing |
| Ads: read results | Shipped | Not confirmed | Yes: Ads manager | Yes: Ads Software | No |
| Ads: create and run campaigns | In build: first slice shipped, launch and pause open | Not confirmed | No: measure only | Yes: Ads Software | No |
| Email marketing and campaigns | Planned: plan accepted, epic in the Icebox | Yes: aiMarketing | Coming soon: Express | Yes: Marketing Hub | Yes: Email Marketing |
| SMS, WhatsApp, Zalo notifications | Missing | Not confirmed | Coming soon: Express | Yes: SMS Marketing, WhatsApp | Yes: SMS Marketing, WhatsApp |
| Website, landing pages, forms | Missing (a link-in-bio page ships in Engage) | No | Coming soon: Form | Yes: Content Hub | Yes: Website, eCommerce |
| Promotions and loyalty | Missing | Yes: Khuyến mại | Not confirmed | Partial: Marketing Hub | Yes: eCommerce, POS |
| **Service and inbox** | | | | | |
| One inbox for customer messages and comments | In build: Zalo OA messages shipped; Facebook comments and Messenger open | Not confirmed | Partial: Prospect | Yes: Shared Inbox | Partial: Live Chat, Discuss |
| Tickets, SLA, help desk | Missing by decision: no cases, tickets or SLA (2026-11-03) | No | Partial: Success | Yes: Service Hub | Yes: Helpdesk |
| Knowledge base and customer portal | Missing | No | Not confirmed | Yes: Service Hub | Partial: Knowledge, eLearning, Forum |
| Live chat widget and chatbot | Missing | Not confirmed | Not confirmed | Yes: Live Chat, chatbots | Yes: Live Chat |
| Phone and VoIP | Missing | Not confirmed | Coming soon: Call | Yes: Sales Hub VoIP | Yes: VoIP |
| **Work and projects** | | | | | |
| Tasks and personal to-dos | Shipped: tasks, My work, Notes | Yes: Công việc | Yes: Task | Partial: CRM tasks | Yes: Project, To-do |
| Projects with board and list | In build: ADR-0048 accepted, issues open | Yes: Công việc | Yes: Project | No | Yes: Project |
| Notes and documents | Shipped: Notes | Yes: Ghi chép | Yes: Docs | No | Yes: Documents, Knowledge |
| Approvals and request forms | Partial: approval of AI and posting proposals only | Yes: Quy trình | Yes: Request | No | Yes: Approvals |
| Workflow and automation builder | Missing | Yes: Workflow | Yes: Workflow, Automation | Yes: Workflow Automation | Yes: Studio |
| Electronic signature and contracts | Planned: `sign` module in the kernel plan | Yes: Hợp đồng điện tử | Yes: E-Sign, Contract | Partial: quote e-signatures | Yes: Sign |
| Records and incoming documents (văn thư) | Partial: files and evidence storage | Yes: Văn thư | Yes: E-Office, Drive | No | Partial: Documents |
| **People and HR** | | | | | |
| Payroll, social insurance, personal income tax | In build: plan and issues; will be the HR app, module `hr` | Yes: Tiền lương, BHXH, Thuế TNCN | Yes: Payroll | No | Partial: Payroll app; Vietnam payroll not confirmed |
| Employee records | In build: staff list inside the payroll plan | Yes: Thông tin nhân sự | Yes: HRIS | No | Yes: Employees |
| Time and attendance, leave | In build: time-keeping inputs and leave balances for payroll | Yes: Chấm công | Yes: Timesheet | No | Yes: Time Off, Timesheets |
| Recruiting | Missing | Yes: Tuyển dụng | Yes: E-Hiring | No | Yes: Recruitment |
| Goals and performance reviews | Missing | Yes: Mục tiêu, Đánh giá | Yes: Goal, Review | No | Yes: Appraisals |
| **Communication** | | | | | |
| AI meeting notes | In build: ADR-0047 accepted, issues open | Partial: Phòng họp (rooms) | Yes: Meeting | Partial: Conversation Intelligence (calls) | No |
| Internal chat | Missing | Yes: Chat | Yes: Chat | No | Yes: Discuss |
| Company news feed | Missing | Yes: Mạng xã hội | Yes: Townhall | No | Partial: Discuss |
| Mailbox | Partial: inbound address and outbound mail; no mailbox | Yes: Mail | Coming soon: Mail | Partial: email integration | Partial: Discuss |
| **Operations (stock, purchase, production)** | | | | | |
| Stock and cost of goods sold | In build: plan and issues | Yes: Kho hàng | Yes: Inventory | No | Yes: Inventory |
| Marketplace orders (Shopee, TikTok Shop, Lazada) | In build: plan and issues | Not confirmed | Not confirmed | No | Not confirmed |
| Purchase orders and suppliers | Missing (purchase invoices only) | Yes: Mua hàng | Not confirmed | No | Yes: Purchase |
| Manufacturing | Missing | Yes: Sản xuất | Partial: bill of materials in Inventory | No | Yes: Manufacturing, PLM, Quality |
| Operational assets and maintenance | Missing | Yes: Tài sản | Not confirmed | No | Yes: Maintenance, Fleet |
| **AI** | | | | | |
| AI inside the daily workflow | Shipped: invoice reading, bank and party matching, post drafts, payment reminders, Vy's daily brief | Yes: MISA AVA, OneAI | Mostly "Coming soon": Agent, Agents, AI Workspace | Yes: Breeze agents, AI Assistant | Yes: AI app |
| A named coworker per department | Shipped in part: Vy and the roster in the design; per-member Vy is Planned (ADR-0049) | Partial: AVA, Agentwork | Coming soon: Agents | Yes: Agent Hub | No |
| AI proposes, a person approves, with checks | Shipped: AI Inbox, tainted output, approval and four-eyes rules | Not confirmed | Not confirmed | Partial: agents with spend and action limits | Not confirmed |
| AI spend limits per org and module | Shipped: AI budget meter | Not confirmed | Not confirmed | Yes: HubSpot Credits | Not confirmed |
| Build your own AI app or agent | Missing | Partial: Agentwork | Coming soon: Studio | Yes: AI Studio | Yes: Studio |
| **Platform and integrations** | | | | | |
| Open source and self-hosted | Shipped: AGPL, `docker compose up` | No | No | No | Yes: Community edition |
| Several legal entities in one org | Shipped: legal entities | Not confirmed | Not confirmed | Yes: multi-account | Yes: multi-company (Custom plan) |
| Tamper-evident audit log and org export | Shipped | Not confirmed | Not confirmed | Partial: activity logs | Not confirmed |
| App marketplace and public API | Planned: OAuth server in ADR-0032, proposed | Yes: Chợ ứng dụng | Not confirmed | Yes: app marketplace | Yes: External API (Custom plan) |
| No-code customization | Missing | Partial: custom software service | Coming soon: Studio | Yes: custom objects | Yes: Studio |
| Industry packs | Missing | Yes: 20+ industry solutions | Not confirmed | Not confirmed | Yes: industry modules |

## Where Ludy is different

Each point says whether it ships or is planned.

1. **AI coworkers inside each workflow, with a person approving (shipped in part).** Shipped: every AI result is a proposal that deterministic checks examine and a person approves; AI text is marked as tainted; every model call goes through a per-org budget meter; the AI Inbox batches approvals. The AI features on `main` are invoice reading, social drafts and rewrites, booking scheduling, reply drafts, intent and contact suggestions, payment-reminder wording, ad-campaign drafts and Vy's daily brief. Planned or in build: Vy per member (ADR-0049, proposed), the payroll coworker, stock matching. The named roster (Vy, Ly, Dy, Uy) is the design; Hy is reserved.
2. **Open source and self-hosted (shipped).** AGPL, runs on `docker compose up` with no DOS service. Among the four competitors only Odoo's Community edition is open source, and Odoo's Enterprise features are paid. Ludy Cloud is not live ("sắp ra mắt").
3. **Vietnamese tax, e-invoice and bank specifics.**
   - Shipped: TT133 books, gapless voucher numbers, Vietnamese e-invoice XML checks (tax-authority code, tax-code check digit), VAT return working papers and XML, financial statements with HTKK XML, MISA SME import templates, assisted tax portal sync, bank statement import and matching.
   - In build: issuing sales e-invoices through the seller's own provider, original invoice fetch from provider lookup pages, a live bank feed (Tingee is the first adapter), household business books, payroll with BHXH and personal income tax, stock and marketplace payouts.
   - Not a difference: MISA AMIS already covers most of this and more (digital signature, tax filing, audit, loans). Ludy's edge is the AI reading and the open code, not coverage.
4. **One write path with approvals (shipped).** Every state change is a command through one runtime; row-level security isolates each org; the audit log is append-only and anchored in a tamper-evident archive; four-eyes approval and fresh MFA guard risky actions. None of the four competitors publishes an equivalent on the pages read for this comparison, so the cells above say "not confirmed" rather than "no".
5. **Accounting and customer work on one set of contacts (shipped).** Contacts and companies are shared between Ludy Kế toán and Engage. Base.vn has no accounting yet and HubSpot has no ledger; MISA and Odoo do share them.

Where Ludy is behind, plainly: breadth. MISA AMIS has 25+ modules and Base.vn 69 apps, most of them live; Odoo about 60. Ludy has three apps on `main` (Kế toán, Engage, Notes) and several in build.

## Gaps

These are capabilities that at least one competitor has and that Ludy has neither shipped, nor planned, nor opened an issue for. Priorities are the author's suggestions for an OPC or SME, AI-first, using the gate in [scope.md](scope.md). They are not decisions. The owner decides; nothing is built, and no issue is opened, until then.

| Gap | Who has it | SME value | Suggested priority |
|---|---|---|---|
| Quotes (báo giá) and sales orders from a deal | HubSpot Quotes, Odoo Sales, Base Commerce and Contract, MISA CRM | A seller quotes every week; today the deal ends where the e-invoice starts. The sales coworker could draft the quote from a chat line | High |
| Purchase orders and supplier list | MISA Mua hàng, Odoo Purchase | Pairs with stock and purchase invoices; a small shop orders from the same suppliers monthly | Medium |
| Expense claims and advances | Base Expense, Odoo Expenses | A team of 5 to 20 pays from pockets; the finance coworker could read the receipt and propose the entry | Medium |
| Payment links and recurring billing | HubSpot Payment Links and Subscriptions, Odoo Subscriptions, MISA Cổng thanh toán | Getting paid faster is the owner's weekly worry; needs a payment partner and the owner's decision on spending | Medium |
| SMS, WhatsApp and Zalo notification messages | HubSpot, Odoo, Base Express (coming soon) | Reaches customers who do not read email; Zalo is the Vietnamese channel; needs provider contracts | Medium |
| Website, landing pages and forms that fill the CRM | HubSpot Content Hub, Odoo Website, Base Form (coming soon) | Lead capture for a one-person company; many already use Facebook pages and Zalo OA instead | Low |
| Live chat widget and chatbot on a website | HubSpot, Odoo | Depends on the website gap; Zalo OA and Messenger already cover most small sellers | Low |
| Customer portal and knowledge base | HubSpot Service Hub | A support-heavy concern; the owner decided against tickets and SLA | Low |
| Internal chat and company news feed | MISA Chat, Base Chat and Townhall, Odoo Discuss | Teams already use Zalo and Messenger groups; high cost to win | Low |
| Recruiting | MISA Tuyển dụng, Base E-Hiring, Odoo Recruitment | Small teams hire rarely; an AI screening helper would be the only reason | Low |
| Goals and performance reviews (OKR, KPI) | MISA Mục tiêu and Đánh giá, Base Goal and Review, Odoo Appraisals | Mostly for larger companies | Low |
| Workflow and automation builder | MISA Workflow, Base Workflow and Automation, HubSpot Workflow Automation, Odoo Studio | The coworkers already act inside each app; a builder adds setup, against the "no setup" rule | Low |
| Point of sale and restaurant | MISA Cửa hàng and Nhà hàng, Odoo POS | A different product; household shops may need it, but MISA and others own it | Low |
| Manufacturing, maintenance, fleet | MISA Sản xuất, Odoo Manufacturing, Maintenance and Fleet | Enterprise-leaning; outside the gate | Low |
| Cooperative (HTX) books | MISA Kế toán HTX | Narrow market | Low |
| Digital signature (CA), direct tax filing, audit and loan marketplace | MISA Chữ ký số, Thuế điện tử, Kiểm toán, Vay vốn | Partner services that need licences or contracts; assisted filing and e-signature (`sign`) are already planned in part | Low |
| Industry packs | MISA Giải pháp (20+ industries), Odoo | Later, once the core apps are live | Low |
| App marketplace and public API | MISA Chợ ứng dụng, HubSpot marketplace, Odoo External API | Needed once partners want to integrate; OAuth server is only proposed | Low |
| Own AI app or agent builder | HubSpot AI Studio, Odoo Studio, Base Studio (coming soon) | Not for an OPC; the named coworkers are the product | Low |

Missing items that are decided against or already counted above are not repeated: tickets and SLA (decided against on 2026-11-03), sign (planned), email marketing (planned, epic in the Icebox).

One thing worth the owner's attention beyond the list: Base.vn has marked its whole Finance group "Coming soon", and HubSpot has no ledger. Of the four, only MISA AMIS and Odoo compete with Ludy Kế toán today, and MISA AMIS is the only one with the full Vietnamese tax chain live. The widest open lane is therefore AI-first accounting plus customer work for the smallest businesses; the gaps most likely to block a paying customer are quotes and, for sellers of goods, stock and purchasing.

## Sources

Read on 2026-11-04. Each vendor's list is its public page at that date and changes without notice.

- Ludy: [scope.md](scope.md), [DESIGN.md](../../DESIGN.md), the plans in [docs/plan](../plan), the ADRs in [docs/adr](../adr), the modules and routes on `main`, and the open issues of DOS/Ludy (for example payroll #2530 and #2531, stock #2512 to #2515, projects #2586 to #2610, meetings #2575 to #2594, e-invoice issuing #2504 and #2505, bank feed #2045, conversations #2307 and #2308, email epic #537).
- MISA AMIS: https://amis.misa.vn/ (product menu), https://amis.misa.vn/bang-gia-bo-giai-phap-quan-tri-hop-nhat-misa-amis/ (bundles and "25+ modules").
- Base.vn: https://base.vn/app (the 69-app catalog), https://base.vn/bang-gia (pricing).
- HubSpot: https://www.hubspot.com/products, https://www.hubspot.com/pricing, https://www.hubspot.com/products/commerce (Revenue Hub, formerly Commerce Hub).
- Odoo: https://www.odoo.com/page/all-apps, https://www.odoo.com/pricing, https://www.odoo.com/documentation/master/applications/finance/fiscal_localizations/vietnam.html (Vietnam localization and the SInvoice connector).

Limits of this comparison: the matrix reads vendor product lists, not feature depth; a "yes" does not say how well a product does the job. The pages for Odoo were read through a text summary because the site did not open in the built-in browser. Items marked "not confirmed" need a closer look before anyone relies on them.
