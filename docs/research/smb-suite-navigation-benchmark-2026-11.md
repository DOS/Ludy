# SMB suite benchmark: home screen, app launcher and navigation

Status: research only, 2026-11-25. No code and no roadmap commitment: every "take" is a recommendation for the owner and the line POs (AGENTS.md: a new customer-visible feature goes to the owner first). It feeds the UI/UX wave P2 of [ui-ux-review-2026-11-23.md](../plan/ui-ux-review-2026-11-23.md) (P2-1 unified AI proposal surface, P2-2 action-first Home with a day-1 quick start, P2-3 shared phone action bar) and the app taxonomy in [DESIGN.md](../../DESIGN.md) 1.1. It does not repeat what [ai-first-reference-study.md](ai-first-reference-study.md) says about AI patterns or what the UI/UX review says about Ludy's own gaps.

## Tóm tắt cho chủ sở hữu (JOY)

- Hoàn thành: đã so sánh 10 bộ phần mềm (QuickBooks, Xero, FreshBooks, Zoho, Odoo, Business Central, HubSpot, MISA, Base.vn, KiotViet) về màn hình Home, cách gom và đặt tên ứng dụng, tìm kiếm, điện thoại và chỗ AI xuất hiện.
- Điểm chung: Home luôn có ba thứ: nút tạo nhanh theo việc ("Tạo hoá đơn", "Ghi chi phí"), vài ô số tiền, và danh sách việc cần làm. Ludy đã có danh sách việc; còn thiếu hàng nút tạo nhanh và ô tiền (khoản chưa thu, chưa trả).
- Cách đặt tên: QuickBooks gom theo việc ("Bán hàng và thu tiền", "Chi phí và hoá đơn mua"), MISA gom theo phân hệ kế toán. Gợi ý: giữ 6 ứng dụng hiện có, nhưng đặt tên nút Home và nhóm tính năng theo việc.
- AI: các bộ lớn đều gom đề xuất của AI vào một nơi để duyệt (QuickBooks "Business Feed", Xero trang "Reconciled", Business Central ô Tasks) và không tự ghi sổ. Đây là mẫu cho P2-1.
- Chưa làm, theo quyết định ngày 2026-11-25: ghim ứng dụng và huy hiệu nâng cấp cho ứng dụng ngoài gói (QuickBooks, Zoho, KiotViet đều có) nằm trong Icebox. Nút chat AI nổi cũng vẫn trong Icebox.
- Cần chủ quyết: ô tiền trên Home chưa có trong kế hoạch, nên đây là đề xuất (bài học 2), chưa mở issue.
- Hạn chế: nhiều chi tiết giao diện của QuickBooks chỉ có ở ảnh chụp của chủ; trang công khai không xác nhận. Mục nào chưa kiểm chứng đều ghi UNVERIFIED.

## 1. How to read this

Public sources only, retrieved 2026-11-25 (vendor help centres, product pages, release notes; no sign-in). Source ids (`Q1`, `X2`, ...) are listed in section 5. "Screenshot" means the owner's QuickBooks Online screenshot of 2026-11-25 (home at qbo.intuit.com, company MetaDOS LLC), which is a first-hand source but not a public page. "UNVERIFIED" means no public page confirmed it. "Search summary" means the fact came from a search-engine summary, not an opened page. Text is paraphrased.

## 2. Comparison

### 2.1 Home, grouping and naming

| Product | Home layout | How apps and areas are grouped and named |
|---|---|---|
| QuickBooks Online | Create actions (a shortcut area you can customise), app carousel, widgets, Business Feed (Q1, Q2). Screenshot: chips Get paid online, Create invoice, Record expense, Add bank, and a "Business at a glance" row of money tiles such as Not Paid; both UNVERIFIED publicly. Up to 10 tasks pinned to the dashboard (Q2). | By job: "Sales & Get Paid" (money in), "Expenses & Bills" (money out) (Q2, search summary); Accounting, Customer Hub (light CRM), Time, Projects (Q3, Q7). Screenshot adds Team, Business Tax, Lending; Team, Business Tax and Lending as names UNVERIFIED publicly. "+New" became "Create" (Q2). |
| Xero | New Homepage: tasks widget (bank reconciliation, overdue items), cash in and out, profit and loss, paid invoices; widgets can be dragged, hidden, and the layout is saved (X1, X2). | Top menus Sales, Purchases, Tax, Reporting with simpler labels (X2, search summary; third party: Reporting moved into the main nav, X4). |
| FreshBooks | Dashboard with widgets that can be hidden or reordered and a quick-create option (F1, search summary, weakly sourced). Money tiles: third-party review only (F4). | By module: invoices, expenses, time tracking, projects (F1). |
| Zoho One and Books | Books Home tabs: Dashboard, Getting Started, Recent Updates, Announcements; widgets for receivables, payables, income and expense, bank accounts (Z3). | Zoho One by department (Sales, Marketing, Finance, HR, ...) and by function (Z1); launcher groups apps into "Spaces" (Z2). Books left menu by module (Z3). |
| Odoo | Accounting dashboard with an onboarding banner of 4 steps on first open (periods, bank account, taxes, chart of accounts); Invoicing app has its own 4-step banner (O2). | One app per domain, installed from the Apps menu (O4). |
| Business Central | Role Center home: Headlines, Activities with cue tiles, KPIs; "Business Manager" is the usual role (B2; 2020 note, may be dated). A "Get started" checklist banner on first sign-in in a new company (B6, search snippet). | By role: the Role Center decides what the user sees; Essentials shows fewer pages than Premium (B1). |
| HubSpot | "Your day at a glance" panel: meetings, tasks, deals, tickets; Customize Home to reorder (H1). | Left nav by user function, with a Breeze (AI) category; items depend on permissions and subscription (H2). |
| MISA AMIS Kế toán | "Tổng quan" is a chart dashboard (position, receivables and payables by due date, revenue and profit, stock); charts can be added, removed, widened; a card value drills into records (M1). No to-do list or setup checklist found (UNVERIFIED). | By accounting module: Tiền mặt, Tiền gửi, Mua hàng, Bán hàng, Quản lý hóa đơn, Kho, Tài sản cố định, Thuế, Giá thành, Tổng hợp (M2). Platform of about 40 apps in five pillars (finance and accounting, marketing and sales, people, management, production) (M3). |
| Base.vn | "Base Home" layout not found (UNVERIFIED). | By domain: Base Work (22 apps), Base HRM (9), Base CRM (8), AI and Agents (5) (BA1); the help centre still lists older per-app folders (BA2). |
| KiotViet | "Tổng quan": today's sales result, net revenue, top 10 products, top 10 customers, recently active customers (K1). No checklist found (UNVERIFIED). | Top menu by function: Tổng quan, Hàng hóa, Giao dịch, Đối tác, Sổ quỹ (cash book split into cash and bank), Báo cáo (K1, K5). |

### 2.2 Launcher, plan cues, search, phone, AI

| Product | Launcher and plan or upgrade cues | Global search or command | Phone | Where AI appears |
|---|---|---|---|---|
| QuickBooks Online | Left rail: Create, Bookmarks, Home, Feed, Reports, All apps, Pinned apps, Customize (Q3). Pinned defaults Accounting, Sales, Customers (Q3); Create and Bookmarks open on hover (Q4). Diamond badge on premium apps: screenshot only, UNVERIFIED publicly. | Smart Search takes natural queries and finds transactions, contacts, reports, pages, help (Q2, Q1). The "Navigate. Find" label: screenshot only. Fall 2026 notes mention a new global panel for finding things (Q6). | Business Feed with tasks and notifications (search summary); tab layout UNVERIFIED. Payroll runs only after approval on mobile (Q6). | Business Feed: agents write ranked tiles for finished work or items needing attention; the user approves, adjusts, snoozes or dismisses; nothing posts without sign-off; which agents appear depends on plan (Q5). |
| Xero | Right-hand panel holds search, notifications, help, quick actions (X4). Upgrade cues UNVERIFIED. | In the right panel (X4); command palette UNVERIFIED. | Create quotes, invoices, bills, capture receipts, reconcile (search summary); tabs UNVERIFIED. | JAX opens from the right panel anywhere (X2, X4). Auto-reconcile only at high confidence, lower ones are suggestions; each tagged Rule, Match, Memory or Prediction; opt-in per bank account; a Reconciled page to review (X3, search summary). |
| FreshBooks | Left menu with business switcher, Settings at the foot; top bar with search, notifications, help, account (F1). Upgrade cues UNVERIFIED. | Search in the top bar (F1). | Mileage, invoicing, receipt capture, client messages; reports desktop only (F2). | No in-app assistant found; announced connectors for ChatGPT and Claude (F3). |
| Zoho One and Books | "One Bar" of pinned apps (up to 16, Home first) and a launcher with "Search apps" (Z2). Books has an "All Zoho Apps" switcher (Z3). Locked-app cues UNVERIFIED. | Search bar plus advanced search (Z3); command palette UNVERIFIED. | Quick Create section chosen by the user (community post, not official, Z5). | "Ask Zia" in the right sidebar; CoCreate Agent under Sales > New drafts documents and you can "Take Control"; bank categorisation is editable before confirming; no approval gate described for Ask Zia (Z4). |
| Odoo | Home menu (Ctrl+H or Alt+H); apps added from the Apps list (O1, O4). Enterprise badges UNVERIFIED. | Command palette Ctrl+K with prefixes: "/" menus and apps, "@" users, "#" channels, "?" articles (O1). | A PWA is recommended; store apps exist (search snippet, O5). | "Ask AI" from the palette or a top-right button, in every app; the standard agent cannot change data, custom agents can; replies are edited before sending (O3). |
| Business Central | Role-based; Bookmarks pin pages to the Role Center (B1). Locked cues UNVERIFIED. | Tell Me (Alt+Q) finds actions, pages, reports, records and help (B1). | Activity tiles first, a bottom menu for the rest on phone (search snippet, B5). | Copilot suggestions are kept only after "Keep it"; bank matches reviewed line by line (B3). Agents pause with a badge and a Tasks pane; the Payables Agent's drafts need approval before posting (B4). |
| HubSpot | Left nav by function; Breeze Assistant in the top bar, enabled by a Super Admin in AI settings (H2). | Not studied. | Not studied. | Breeze in the top bar (H2). |
| MISA AMIS | Toolbar opens other AMIS apps (search summary, UNVERIFIED); no locked-module badges on marketing pages; plans by revenue, household under 1 billion VND free on mobile (M6, M7). | None listed in the interface page; AVA can "search reports by purpose" (M4). | App tabs Bảng tin, Danh bạ, Kế toán (reports); starts by choosing branch and data set (M8, M9). | AVA: a "Phân tích với AVA" toggle next to Tùy chỉnh on Tổng quan, an "AVA Kế toán" tab, "Thêm bằng AI" proposes vouchers and says to check before saving (M5, M4). meInvoice AI only checks and warns (M10). |
| Base.vn | Admins grant per-app access (BA3); plans per app (Starter to Agentic), bundles, separate AI credit packs (BA4). Web switcher UNVERIFIED. | Not found (UNVERIFIED). | App has an "Applications" section opening the other apps; check-in is a separate HRM app (BA5). | "Trợ lý AI" answers from company data within the user's permissions and prepares drafts to approve; agents, AI approvals, MCP (BA1). |
| KiotViet | Plans Hỗ trợ, Chuyên nghiệp, Cao cấp; lower plans show features as "Locked" (website, attendance and payroll, smart analytics, API); AI analytics in the top plan (K2). | Not found (UNVERIFIED). | Two apps: staff sales (offline, prints) and owner view (revenue, stock alerts) (K4). | "Trợ lý KiCi" button in the top menu opens a right panel; read-only; auto-opens at most once a day when scheduled reports are unseen; stops after 5 lookups to ask the user (K3). |
| Sapo (one line) | Not studied. | Not studied. | Bottom menu Orders, Products, More; 4 to 8 customisable quick actions (S1). | OmniAI chat as a quick action (S1). |

## 3. Lessons for Ludy

Fit follows [scope.md](../product/scope.md): one person, defaults, AI part named, a person approves money, messages and spend. Slices are the P2 slices of the UI/UX review; "owner decision" lines are listed again in 4.

**L1. Home leads with verbs, then tiles, then the to-do list.** QuickBooks (Create actions, Q1), Xero (tasks widget first, X2), Business Central (Activities and Headlines, B2), HubSpot ("Your day", H1) and KiotViet ("today's result", K1) all open on what to do or what happened today. Ludy's "Hôm nay cần bạn" is already first. Fit: yes. Maps to P2-2. Take: add one row of 3 to 4 "create actions" named by the job (Tải hóa đơn, Ghi khoản chi, Tạo hóa đơn bán, Thêm khách), fixed for everyone, above the queue. The AI part stays in the queue and the brief. The existing `Alt+Q` quick capture can be its keyboard twin.

**L2. A few money tiles with a drill-in.** QuickBooks ("Business at a glance", screenshot), Zoho Books (receivables, payables, Z3), Xero (cash in and out, X2) and MISA (a card value opens the records, M1) all show 3 to 5 numbers. Fit: yes for OPC (what is owed to me, what I owe, cash). Not in the plan: P2-2 compresses Home, it does not add tiles. Take: recommend to the owner a strip of three tiles (chưa thu, chưa trả, tiền ngân hàng) from deterministic reads, each opening its list, with the Vy brief explaining them under the numbers check of the AI study. Needs the owner (new customer-visible feature); no issue until then.

**L3. A day-1 checklist that ends itself.** Zoho Books has a Getting Started tab (Z3), Odoo a 4-step banner (O2), Business Central a "Get started" checklist (B6). Odoo's banner stays until the user closes it. QuickBooks and Xero: UNVERIFIED. Fit: yes. Maps to P2-2: the 3-step card (first invoice, VAT period, 2FA) should vanish on its own when the first invoice is approved, not wait for a close click. Keep it to 3 steps; Odoo's 4 steps are all setup, none is the first real task.

**L4. Name quick actions and feature groups by job, keep the six app names.** QuickBooks names apps by job ("Sales & Get Paid", "Expenses & Bills", Q2), KiotViet menus by function (K1), MISA by accounting module (M2), Base by domain (BA1). Ludy's Apps are by area (Tài chính, Engage, Cộng tác, Nhân sự, eSign, Ludy AI) and its Feature Groups already read as jobs (Bán hàng, Mua hàng, Sổ sách & Thuế). Fit: partly. Take: use job words for Home actions, empty-state buttons and the palette; keep app names as they are (DESIGN.md 1.1, the four-tier hierarchy). Statutory module names stay inside the accountant screens (UI/UX review 2.2). Taxonomy: no rename of an App; if the owner wants QuickBooks-style job names for the Finance feature groups, that is a separate recommendation.

**L5. Six apps need a rail, not a launcher.** QuickBooks needs "All apps" plus pinning for about 10 apps (Q3), Zoho One a launcher for dozens (Z2), MISA gathers 40 apps in five pillars (M3). Ludy lists six apps in the shell switcher and shows an app only when a module runs. Fit: the current rail is right; do not build an "All apps" launcher before about 8 apps. If it grows, group by pillar like Base (Work, People, Customers, AI), not by a flat list. No P2 slice.

**L6. One search that reaches screens, records and verbs.** Business Central's Tell Me (B1), Odoo's palette with prefixes (O1) and QuickBooks' Smart Search (Q2) each find pages, records and actions in one box. Ludy's `⌘K` already does screens and finance and notes. Fit: yes, and it is wave P1-5 (recent items, quick actions), not P2. One new idea for later: prefixes as an expert shortcut ("/" screens, "@" people), cheap to add to `lib/palette.ts`. Park as P3 idea; no issue now.

**L7. One review surface for everything the AI prepared.** QuickBooks' Business Feed ranks tiles by importance and lets the user approve, adjust, snooze or dismiss (Q5). Business Central pauses an agent with a badge and a Tasks pane (B4). Xero tags each suggestion by how it was made (Rule, Match, Memory, Prediction) and keeps a Reconciled page (X3). Fit: yes, this is P2-1. Take: `<CoworkerAttribution>` carries a short source tag in plain Vietnamese (theo quy tắc đã học, khớp chính xác, từ lần trước) which matches DESIGN.md 5.1 "who proposed it"; add snooze ("để sau") next to approve, edit and reject on queue items; rank by importance and not by time. Cost warning: a 2024 community thread says the Feed slowed page load (Q8), so the Home queue must stay a bounded, lazily loaded list.

**L8. AI entry point: header button and a right panel, read first.** Xero opens JAX from the right panel (X4), Odoo from a top-right button or the palette (O3), KiotViet from a top-menu button into a right panel, read-only, capped at 5 lookups per question and opened by itself at most once a day (K3), MISA by a toggle on Tổng quan (M5). Fit: partly. A persistent floating chat dock is in the Icebox (UI/UX review, AI study 3.3). KiotViet's safeguards are worth copying: read-only by default, a lookup cap, one automatic opening a day, and approval before anything is written. Take for P2-1: the existing Vy `Sheet` opens from the screen's own proposal, not from a global dock. "Ask Vy" from `⌘K` stays "later" (AI study 5.7).

**L9. Phone: two layers, bottom action bar on records and 3 to 4 actions on Home.** Business Central puts Activity tiles first and a bottom menu after (B5); Sapo has a bottom menu plus quick actions (S1); QuickBooks and Zoho expose Create on mobile (Q6, Z5); KiotViet splits a staff app and an owner app (K4). Fit: yes for P2-3. Take: `PhoneActionBar` (approve, edit, reject, 44 px) on a record or proposal screen; on Home the same fixed create actions as L1 in a thumb-reach row. Not a second app. Sapo's customisable 4 to 8 actions is parked (pinning).

**L10. Business Central's role view maps to Ludy's owner and bookkeeper split.** Business Central chooses a Role Center and shows fewer pages in Essentials (B1, B2); HubSpot hides nav items by permission (H2). Ludy already has roles (HR for owners and admins, DESIGN.md section 1). Fit: yes in a light form: the owner's Home shows the queue and tiles; an accountant's default screen is the Finance Inbox. This needs no role editor and no setup. Maps to P2-2 as a default only; any role-based Home picker is parked as enterprise (scope.md gate 1).

**L11. Customisable dashboards are not for Ludy.** Xero (drag, show, hide, X2), FreshBooks (reorder, F1), MISA (add and remove charts, M1) and HubSpot (Customize Home, H1) let users arrange Home. Fit: no. [scope.md](../product/scope.md) and the UI/UX review reject drag-configurable dashboards for OPC and SME; one fixed order that works with defaults is the smallest slice. Skip.

## 4. What conflicts or waits

| Pattern seen | Seen in | Status |
|---|---|---|
| User-pinned apps, bookmarks, "Customize" the left rail | QuickBooks (Q3), Zoho One (up to 16, Z2), Business Central (B1), HubSpot (H1), Sapo quick actions (S1) | Parked, owner decided Icebox 2026-11-25 (user-pinned apps). Also in the UI/UX review Icebox as custom navigation pinning. |
| Showing out-of-plan apps in the launcher with an upgrade badge (diamond, "Locked") | QuickBooks (screenshot only), KiotViet (K2), Base per-app tiers (BA4), HubSpot (H2, UNVERIFIED) | Parked, owner decided Icebox 2026-11-25. Ludy's current rule stays: an app shows only when its module runs. |
| Floating or global AI chat dock | Xero, Odoo, KiotViet, HubSpot header buttons (X4, O3, K3, H2) | Stays in the Icebox (UI/UX review Icebox, AI study 3.3). L8 takes only the safeguards. |
| Drag-configurable Home widgets | Xero, FreshBooks, MISA, HubSpot | Skip: against scope.md; L11. |
| Money tiles on Home | QuickBooks, Zoho, Xero, MISA | Not in the plan: owner recommendation (L2), no build until the owner agrees. |
| Rename the six Apps to job names | QuickBooks | Not recommended now; L4 keeps the names and applies job words to actions. |
| Role-based Home, role editors | Business Central, HubSpot | Parked as enterprise (scope.md gate 1); only the default split of L10. |

## 5. Sources

All retrieved 2026-11-25. "Search summary" is marked where the page was not opened.

- Q1 QuickBooks UK help, Explore the platform: https://quickbooks.intuit.com/learn-support/en-uk/help-article/product-setup/explore-quickbooks-intuit-platform/L6TekQ3zX_GB_en_GB
- Q2 QuickBooks redesigned platform: https://quickbooks.intuit.com/global/resources/product-update/redesigned-quickbooks-platform/
- Q3 QuickBooks US help, navigation menu: https://quickbooks.intuit.com/learn-support/en-us/help-article/bookkeeping-processes/understand-navigation-menu-quickbooks-online/L310NeoHY_US_en_US
- Q4 QuickBooks US help, new QuickBooks Online (Nov 2025 notes): https://quickbooks.intuit.com/learn-support/en-us/help-article/intuit-subscriptions/new-quickbooks-online/L0cDviRVW_US_en_US
- Q5 QuickBooks Business Feed: https://quickbooks.intuit.com/global/resources/product-update/quickbooks-business-feed/
- Q6 QuickBooks Fall 2026 release notes: https://quickbooks.intuit.com/r/product-update/whats-new-quickbooks-fall-2026/
- Q7 QuickBooks Customer Hub (search summary): https://quickbooks.intuit.com/global/resources/product-update/quickbooks-customer-hub/
- Q8 QuickBooks community, turning off the Business Feed (2024): https://quickbooks.intuit.com/community/banking-4/how-do-i-turn-off-the-business-feed-22602
- X1 Xero blog, reimagined Xero: https://blog.xero.com/product-updates/get-ready-reimagined-xero/
- X2 Xero new homepage and navigation: https://www.xero.com/campaign/new-homepage-navigation/
- X3 Xero auto bank reconciliation (search summary): https://www.xero.com/my/campaign/auto-bank-reconciliation/
- X4 Third-party summary of the refreshed Xero navigation: https://fastlane-global.com/hk/blog/xero-refreshed-navigation-2026/
- F1 FreshBooks getting started: https://support.freshbooks.com/hc/en-us/articles/115011801007 and dashboard article (search summary): https://support.freshbooks.com/hc/en-us/articles/24283538938125
- F2 FreshBooks mobile: https://www.freshbooks.com/mobile
- F3 FreshBooks Claude connector, press release: https://www.freshbooks.com/press/releases/freshbooks-anthropicmcpconnector
- F4 Third-party FreshBooks review: https://www.business.com/reviews/freshbooks-accounting-software-and-invoice-generators
- Z1 Zoho One: https://www.zoho.com/one/
- Z2 Zoho One Bar help: https://help.zoho.com/portal/en/kb/one/user-guide/one-experience-ui/articles/navigating-and-managing-apps-in-one-bar
- Z3 Zoho Books, navigating: https://www.zoho.com/books/help/getting-started/navigating-zoho-books.html
- Z4 Zoho Books AI features: https://www.zoho.com/books/help/ai-features/ai-features.html
- Z5 Zoho community, Quick Create on mobile (unofficial): https://help.zoho.com/portal/en/community/topic/accounting-on-the-go-series-39-boost-efficiency-with-quick-create-options-in-zoho-books-mobile-app
- O1 Odoo 19 keyboard shortcuts: https://www.odoo.com/documentation/19.0/applications/essentials/keyboard_shortcuts.html
- O2 Odoo 18 accounting get started: https://www.odoo.com/documentation/18.0/applications/finance/accounting/get_started.html
- O3 Odoo 19 AI: https://www.odoo.com/documentation/19.0/applications/productivity/ai.html and agents: https://www.odoo.com/documentation/19.0/applications/productivity/ai/agents.html
- O4 Odoo 19 apps and modules: https://www.odoo.com/documentation/19.0/applications/general/apps_modules.html
- O5 Odoo mobile (search snippet): https://www.odoo.com/documentation/19.0/administration/mobile.html
- B1 Business Central search and Tell Me: https://learn.microsoft.com/en-us/dynamics365/business-central/ui-search
- B2 Business Central Role Center (Learn module and 2020 release plan, may be dated): https://learn.microsoft.com/en-us/training/modules/user-interface-dynamics-365-business-central/7-pages and https://learn.microsoft.com/en-gb/dynamics365-release-plan/2020wave2/smb/dynamics365-business-central/easier-choose-right-role-center
- B3 Business Central Copilot bank reconciliation: https://learn.microsoft.com/en-us/dynamics365/business-central/bank-reconciliation-with-copilot
- B4 Business Central supervise agent tasks: https://learn.microsoft.com/en-ie/dynamics365/business-central/supervise-agent-tasks
- B5 Business Central mobile FAQ (search snippet): https://learn.microsoft.com/en-ie/dynamics365/business-central/ui-mobile-faq
- B6 Business Central onboarding experiences (search snippet, exact path UNVERIFIED): https://learn.microsoft.com/en-us/dynamics365/business-central/dev-itpro/administration/onboarding-experiences
- H1 HubSpot home: https://knowledge.hubspot.com/help-and-resources/use-your-home-page
- H2 HubSpot navigation: https://knowledge.hubspot.com/help-and-resources/a-guide-to-hubspots-navigation
- M1 MISA AMIS Kế toán Tổng quan: https://helpact.misa.vn/kb/tong-quan/
- M2 MISA help home (module list): https://helpact.misa.vn/
- M3 MISA AMIS platform: https://amis.misa.vn/gioi-thieu-misa-amis/
- M4 MISA AI assistant features: https://helpact.misa.vn/kb/tro-thu-ai-tren-amis-ke-toan/
- M5 AVA features: https://helpact.misa.vn/kb/ava-ke-toan-cac-tinh-nang-va-tien-ich/
- M6 MISA eShop: https://www.misaeshop.vn
- M7 MISA AMIS accounting page: https://amis.misa.vn/giai-phap-tai-chinh-ke-toan-toan-dien/
- M8 MISA AMIS Kế toán mobile help: https://helpact.misa.vn/kb/su-dung-misa-amis-ke-toan/
- M9 MISA AMIS app listing: https://apps.apple.com/tm/app/misa-amis/id1521979495
- M10 MISA meInvoice: https://www.meinvoice.vn
- BA1 Base.vn: https://base.vn
- BA2 Base help centre: https://help.base.vn/support/solutions/63000158392
- BA3 Base Account app table: https://help.base.vn/support/solutions/articles/63000286119-base-account-general-introduction-to-the-app-feature-table
- BA4 Base pricing: https://base.vn/bang-gia
- BA5 Base mobile help: https://help.base.vn/support/solutions/articles/63000286340
- K1 KiotViet Tổng quan (permissions guide): https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-thiet-lap/phan-quyen-nguoi-dung-theo-nhom-hang/
- K2 KiotViet pricing: https://www.kiotviet.vn/phi-dich-vu/
- K3 KiotViet KiCi assistant: https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-thiet-lap/tro-ly-kici/
- K4 KiotViet mobile: https://www.kiotviet.vn/phan-mem-quan-ly-ban-hang-tren-dien-thoai-di-dong/
- K5 KiotViet cash book: https://www.kiotviet.vn/ra-mat-tinh-nang-quan-ly-so-quy-va-bao-cao-tai-chinh/
- S1 Sapo mobile dashboard update: https://www.sapo.vn/cap-nhat-tinh-nang/Cap-nhat-giao-dien-dashboard-mobile
