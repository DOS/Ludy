# Ludy UI/UX Comprehensive Review and 2026 Best-Practice Audit

- **Date:** 2026-11-23
- **Issue:** https://github.com/DOS/Ludy/issues/4500 (`M3 Paid pilot`, `priority:P1`, `line:frontend`, `web`, `docs`)
- **Audited baseline:** `origin/main` (`1d3791312`), alongside active sister issue [#4499](https://github.com/DOS/Ludy/issues/4499) (moving Settings sub-pages into the left sidebar)
- **Scope:** [DESIGN.md](../../DESIGN.md), `packages/ui/src/`, `apps/app/src/`, `apps/web/src/`
- **Product lens:** Vietnam one-person companies (OPC) and SMEs first, AI-first with human approval ([AGENTS.md](../../AGENTS.md), [scope.md](../product/scope.md), [ai-first-reference-study.md](../research/ai-first-reference-study.md))

---

## Executive Summary

Ludy already has an unusually disciplined foundation for an early Business OS: OKLCH light/dark parity, Vietnamese-first typography (`Be Vietnam Pro` + `JetBrains Mono` tabular figures), automated design-token and accessibility gates (`field-border` 3:1 contrast, reduced-motion spinner rules, single-stroke icons, `<Button loading>` enforcement), and a principled human-in-the-loop approval model for AI coworkers (`proposal` token, deterministic check badges, learned-rule explanations).

However, **shell governance, pattern consistency across modules, and progressive disclosure lag behind 2025-2026 B2B SaaS leaders** (Linear, Attio, Twenty CRM, Stripe Dashboard, Shopify Admin) and top SEA/Vietnam SME ergonomics (MISA AMIS, KiotViet, Base.vn, Lark):

1. **Shell chrome and workspace switcher drift:** `OrgMenu` sits at the top of the sidebar (`apps/app/src/components/app-nav.tsx`) taking prime top-left real estate even for single-org SMEs, while `AccountMenu` uses a raw HTML `<details>` disclosure holding two clunky `<NativeSelect>` dropdowns (`ThemeSwitcher`, `LocaleSwitcher`). Owner testing on `app.ludy.vn/o/dos/settings` (2026-11-23) also surfaced a state/display bug where the theme dropdown showed `Sáng` while the page rendered dark.
2. **Ghost secondary sidebar on org routes and wide-screen squeeze:** `OrgLayout` (`apps/app/src/routes/org-layout.tsx`) reserves a rigid `w-72` (288px) sidebar across all desktop breakpoints. On org-level routes (`Overview`, `Notifications`, `Audit`, `Personal Data`, and pre-`#4499` `Settings`), the 224px secondary column renders mostly empty space. Meanwhile, on 1366px laptops, `InboxDetailPage` adds a third 240px column (`SPLIT_UP`, 84rem), squeezing the core invoice review workspace.
3. **Cognitive clutter above primary queues:** `InboxPage` (`apps/app/src/routes/inbox.tsx`) stacks up to 15 operational intake, staged-marketplace, staged-bank-statement, failed-job, open-bank-line, and social-attention blocks *above* the `Chờ duyệt` / `Tất cả chứng từ` tabs. `OverviewPage` (`apps/app/src/routes/overview.tsx`) stacks up to 8 vertical sections on Home.
4. **Fragmented primitive adoption (tables, mobile cards, overlays, typography):** Only **3 of 98** `<DataTable>` usages pass `stacked` for 360px phones; desktop table cells widely override `TableCell` with `py-3` (44-56px rows instead of `DESIGN.md` 4.3's 36px accountant density); `Input` and `NativeSelect` lack built-in `max-md:min-h-11` touch targets; multi-field forms still mix `FormPanel` (16 uses), `FormDialog` (8 uses), and raw `<DialogContent>` modals (~30+ non-confirm dialogs); and ~30 `uppercase` usages violate `DESIGN.md` 3.2 on multi-word Vietnamese phrases.
5. **`DESIGN.md` governance blind spot + Marketing mismatch:** `DESIGN.md` (772 lines) specifies tokens, buttons, forms, tables, and `apps/web` in detail, yet omits **App Shell, Sidebar, User/Account Menu, Workspace Switcher, Chrome Toggles, and AI Coworker Attribution beyond Invoices**. On `apps/web`, `AppCards` and `Story` also render colored rounded icon tiles above headings (explicitly banned in `DESIGN.md` 3.7 and 10), while `app-shell.tsx` advertises a split list-detail inbox that `apps/app` does not yet provide on `/inbox`.

---

## 1. Executive Scorecard

Scoring rubric: `5` = industry-leading & consistent, `4` = solid with minor gaps, `3` = functional but visibly uneven or high friction, `2` = structural UX debt hurting daily flow, `1` = broken/missing.

| UX Pillar | Score | Strengths Observed in Code | Key Gaps & Exact Code Citations |
| :--- | :---: | :--- | :--- |
| **1. Design Tokens & Visual System** | **4.5 / 5** | Consistent OKLCH light/dark tokens (`packages/ui/src/styles/globals.css`, `apps/web/src/app/globals.css`), `Be Vietnam Pro` + `JetBrains Mono` (`packages/ui/src/fonts/fonts.css`), automated CI guards (`tools/test/design-tokens.test.ts`, `packages/ui/test/no-border-with-shadow.test.ts`, `field-border-contrast.test.ts`, `icon-stroke.test.ts`). | Missing `SegmentedControl` / `ToggleGroup` primitive in `packages/ui`; ~30 `uppercase` classes on multi-word Vietnamese headings (`apps/app/src/routes/inbox-detail.tsx:179-274`, `apps/app/src/routes/vouchers.tsx:340`, `apps/app/src/components/project-board.tsx:988`, `apps/app/src/routes/hr-declarations.tsx:401`); `apps/app/src/routes/meetings.tsx:59-64` uses `default` (primary violet) on `completed`/`ready` status badges instead of `success`. |
| **2. App Shell & Navigation** | **2.5 / 5** | Clean 4-tier hierarchy (`Suite -> App -> Feature Group -> Module` in `packages/kernel-contract/src/apps.ts`), deterministic single-active matching (`currentMenuItem` in `apps/app/src/lib/apps.ts`), accessible landmarks & `NavDrawer` (`apps/app/src/components/app-nav.tsx`). | Fixed `w-72` sidebar (`org-layout.tsx:350`) leaves an empty 224px column on `app === null` routes (`Overview`, `Notifications`, `Audit`, `Personal Data`); `OrgMenu` crowds sidebar top; `AccountMenu` (`app-nav.tsx:259-291`) uses raw `<details>` + `<NativeSelect>` (`theme-switcher.tsx`, `i18n/provider.tsx:59`); no desktop collapse toggle (`[` rail mode). |
| **3. Overview / Home & Operational Triage** | **3.5 / 5** | "Hôm nay cần bạn" (`today-list.tsx`) puts flags first and counts items once; Vy daily brief (`today-brief.tsx`) checks numbers deterministically; Tax Calendar (`overview.tsx:333-364`) surfaces 30-day deadlines directly on Home. | `OverviewPage` stacks up to 8 sections (`TodayList`, `Waiting`, `TaxCalendar`, `TodayWeekly`, `SinceYesterday`, `SalesNumberGaps`, `AppCards`, `OrgNotesPanel`); `InboxPage` (`inbox.tsx:504-673`) pushes `Chờ duyệt` tabs far below 10+ intake/staged/alert cards and lacks a split peek preview from the list route. |
| **4. Tables, Overlays & Forms** | **3.0 / 5** | `DataTable` (`apps/app/src/components/ui.tsx:376-413`) provides sticky headers, `useScrollRoom`, tabular numeric right-alignment, and `TOTAL_RULE`; `FormPanel` (`form-panel.tsx`) enforces `Cmd+Enter` save, dirty-close guard, and focus return. | **95 of 98** `<DataTable>` usages lack `stacked` mobile mode; `TableCell` callers use `py-3` (44-56px desktop rows instead of 36px compact density); no master-detail row click-to-peek drawer; ~30 `<DialogContent>` forms bypass `FormPanel`/`FormDialog` (`project-task-dialog.tsx`, `sign-envelopes.tsx:526`, `meetings.tsx`); buttons omit `loading` (`onboarding.tsx:124,172`, `meetings.tsx:150`, `social.tsx:188`). |
| **5. Keyboard & Command-First Flows** | **4.0 / 5** | `CommandPalette` (`command-palette.tsx`, `lib/palette.ts`) supports diacritic-folded Vietnamese search across screens + Finance + Notes; `J/K/A/E/R` review shortcuts (`review-shortcuts.ts`); `Alt+Q` Quick Capture (`quick-add.ts`); `F8` toast action focus (`toaster.tsx`). | Empty palette shows static dump instead of Recent/Frecency items; lacks contextual sub-menus (`Switch theme`, `Switch org` inline); no `J/K` + `Enter` peek-panel cycling on `Documents`, `Vouchers`, `Clients`, or `Envelopes` tables. |
| **6. AI Coworker UX & Trust** | **3.5 / 5** | `ProposalGroups` (`proposal-groups.tsx`) batches clean invoices by vendor + learned rule with correction count; `AiWrittenBadge` (`ai-written-badge.tsx`) marks tainted MCP writes cleanly; `AiMeter` (`ai-meter.tsx`) shows soft/hard budget states; core works with AI off. | 5+ incompatible Vy UI patterns (`TodayBrief`, `MyWorkVyPlannerPanel`, `NotesVyOrganizerPanel`, `NoteVyPanel`, `VyClausePanel`, `DraftPanel`); `VoucherCard`, `ReversalCard`, `JournalVoucherCard` (`inbox-detail.tsx`), and `DraftPanel` (`conversation-drafts.tsx`) lack consistent `border-proposal` dashed framing; inline Vy drawers shift page scroll rather than opening in a consistent sidecar/sheet. |
| **7. Accessibility & Phone Ergonomics** | **4.0 / 5** | Skip link, route announcer (`org-layout.tsx:336-349`), `useScrollRoom` for sticky headers/bars, `PhoneActionBar` (`inbox-detail.tsx:1278`), `max-md:min-h-11` on `Button` (`packages/ui/src/components/button.tsx`) and `TabsTrigger` (`tabs.tsx`). | `packages/ui/src/components/input.tsx` and `native-select.tsx` stay `h-8` (32px) on mobile, forcing one-off hacks (`hr-employees.tsx:66-67`, `lib/conversation-touch.ts`); 95 non-stacked tables force horizontal panning at 360px; `sign-envelopes.tsx:290-315` hardcodes `min-h-11` on desktop buttons. |
| **8. Marketing-to-App Alignment & Vietnam SME Fit** | **3.5 / 5** | Authentic VND formatting (`32.832.000 ₫`), MST registry lookup in `onboarding.tsx`, Zalo link copy in `sign-envelopes.tsx`, honest "Sắp ra mắt" labels on `apps/web`. | `apps/web/src/components/landing/app-cards.tsx:22` and `story.tsx:46` violate `DESIGN.md` 3.7/10 with colored icon tiles above headings; `apps/web/src/content/vi.ts` leaks statutory/protocol codes (`B01/B02`, `911/4212`, `D02-LT`, `PAdES-LTV`, `MCP`) in summary cards; `apps/web/src/components/landing/app-shell.tsx` shows a 1-column sidebar + inline inbox split not yet mirrored in `apps/app`. |

---

## 2. Gap Analysis vs 2025-2026 Best Practices (OPC & SME Lens)

Per [scope.md](../product/scope.md), Ludy must **reject enterprise bloat** (no custom-object studios, drag-configurable dashboards, multi-tier approval chains, or floating chat sidebars detached from workflows). Every benchmark below is filtered for a 1-to-50 person Vietnamese business owner or bookkeeper.

### 2.1 Modern Business OS Workspaces (Linear, Attio, Twenty CRM, Stripe, Shopify Admin)

| 2025-2026 Industry Pattern | Current Ludy State | Concrete Gap & Recommended Adaptation |
| :--- | :--- | :--- |
| **Collapsible, context-aware rail (`[`)** (Linear, Twenty CRM, Shopify Admin) | Fixed `w-72` (64px rail + 224px menu) at all times above `md` (`org-layout.tsx:350`). On `app === null` routes (`Overview`, `Notifications`, `Audit`), the 224px panel shows only `OrgMenu` + Search + dead whitespace. | Collapse automatically to the `64px` icon rail on `app === null` routes (once `OrgMenu` moves into the bottom User Popover and `⌘K` sits as a rail button), and add a `[` collapse toggle on App screens so `InboxDetail`, `DealBoard`, and `Ledger` tables reclaim 224px on 1280px-1366px laptops. |
| **Unified bottom User/Account Popover with Workspace Switcher** (Linear, Attio, Notion) | `OrgMenu` (`app-nav.tsx:217`) occupies the top of the secondary sidebar; `AccountMenu` (`app-nav.tsx:259`) is a raw `<details>` block with two `<NativeSelect>` boxes at the foot. | Move `OrgMenu` into a bottom `AccountPopover` (`Popover` / `DropdownMenu`), keeping top-of-sidebar pure (Brand + `⌘K` + App Menu). Single-org SME owners never look at an org dropdown every day; accountants with multiple clients still switch in 2 clicks or `⌘K`. |
| **Master-detail Peek Drawers over full-page navigation** (Attio, Linear, Stripe) | `Contacts`, `Deals`, and `Tasks` use `Sheet` / `FormPanel`, while `Inbox`, `Documents`, `Vouchers`, `Envelopes`, and `HR Employees` force full-page route transitions or deep inline row expansion (`documents.tsx:68`, `hr-employees.tsx`). | Standardize a right-hand **Peek `Sheet`** (`480px-640px` desktop, full-screen phone) with `Up/Down` (`J/K`) row stepping and `Esc` focus return on `Documents`, `Vouchers`, and `SignEnvelopes`, plus an integrated split preview on `/o/$slug/inbox` matching `apps/web`'s `AppShell`. |
| **Jobs-to-be-done Home above progressive disclosure** (Stripe Dashboard, Shopify Admin) | `OverviewPage` renders 8 stacked sections sequentially (`overview.tsx:293-401`). | Keep **1) "Hôm nay cần bạn" + 2) Tax Deadlines** clean above the fold; group `SinceYesterday`, `Waiting`, `AppCards`, and `TodayWeekly` into compact, scannable strips or collapsible summaries so owners act in under 15 seconds. |
| **`Cmd+K` Frecency & zero-dead-end commands** (Linear, Raycast) | `CommandPalette` (`palette.ts`) searches screens, pending proposals, Finance entities, and Notes, but opens empty-query with an unprioritized static dump of `NAV`. | Prepend a **`Recent` (Frecency, max 5 items)** group stored in `localStorage` per org when `query === ''`, and include quick-action verbs (`Tạo việc mới`, `Nhập chứng từ`, `Đổi giao diện`, `Đổi ngôn ngữ`) with inline badge hints. |

### 2.2 Vietnam & SEA SME Ergonomics (MISA AMIS, KiotViet, Base.vn, Lark)

| SEA / Vietnam SME Pattern | Current Ludy State | Concrete Gap & Recommended Adaptation |
| :--- | :--- | :--- |
| **Plain-language SME copy vs statutory accounting codes** (KiotViet, Base.vn vs MISA AMIS) | In-app labels in `vi.ts` are largely clear, *but* `apps/web/src/content/vi.ts` (`appCards`, `modules`) and several `apps/app` screens mix plain SME verbs with raw statutory codes (`B01-DNN`, `911/4212`, `D02-LT`, `05/KK-TNCN`, `PAdES-LTV`, `SHA-256`). | Keep marketing cards and non-accountant Overview/Home screens strictly outcome-oriented (*"Báo cáo tài chính nháp", "Bảng kê bảo hiểm & thuế TNCN", "Chống sửa tệp PDF"*). Keep exact statutory codes inside Accountant-facing Ledger/Declarations screens and tooltip metadata (`title={due.legalBasis}`). |
| **Compact 36px accountant tables vs 44px phone cards** (MISA dense grids vs KiotViet touch) | `packages/ui/src/components/table.tsx` is nominal `p-2`, yet almost all 98 `<DataTable>` callers add `px-4 py-3` (44-56px rows on desktop!), while 95 of 98 tables do not pass `stacked` on phones. | Enforce true 36px desktop rows (`h-9`, `px-3 py-1.5`) in `DataTable` by default (fixing caller `py-3` bloat) for bookkeeper scan density, and make `stacked` (44px touch cards on `< sm`) opt-out or built into all list-like tables (`documents`, `vouchers`, `sales-invoices`, `sign-envelopes`, `overview` tax calendar). |
| **Mobile thumb-zone approval flows** (Lark Approvals, Base Request) | `InboxDetailPage` implements an excellent sticky `PhoneActionBar` (`inbox-detail.tsx:1278`). However, `TodayList`, `SignEnvelopes`, `LeaveRequests`, and `SocialReview` require scrolling or small inline buttons on mobile. | Standardize `PhoneActionBar` as a reusable `@ludy/ui` / `apps/app/src/components/ui.tsx` primitive and adopt it on every mobile approval/ceremony screen. |
| **Zero-setup defaults & MST instant start** (KiotViet, MISA meInvoice) | `onboarding.tsx` has great Tax Registry MST auto-fill, *but* drops a fresh SME straight into `OverviewPage` showing empty `TodayList` + empty `TaxCalendar` + a quiet guide link (`today-list.tsx:118-128`). | Turn the day-1 empty state of `Overview` and `AccountingOverview` into an **inline 3-step action card** (*1. Upload 1 invoice or forward email, 2. Pick VAT period, 3. Enable 2FA*) that disappears automatically once the first invoice is approved. |

### 2.3 AI-Native Coworker UX (Vy + Ly/Dy/Uy)

| 2025-2026 AI Coworker Pattern | Current Ludy State | Concrete Gap & Recommended Adaptation |
| :--- | :--- | :--- |
| **Uniform "Proposed vs Posted" visual contract** (Linear Triage, Ramp Policy Agent, Attio) | `InboxDetail` applies `border-dashed border-proposal/60` and `Badge variant="proposal"` on the invoice journal preview (`inbox-detail.tsx:1225`). Yet `VoucherCard`, `ReversalCard`, `JournalVoucherCard`, `DraftPanel` (`conversation-drafts.tsx:69`), and `MyWorkVyPlannerPanel` use plain solid borders or `bg-muted/50`. | Apply a single `<ProposalSurface>` wrapper (`border-dashed border-proposal/60 bg-proposal/5` + `Badge variant="proposal"`) around **every** unapproved AI proposal, draft, or suggested action across Finance, Engage, Notes, My Work, and eSign. |
| **Consistent Coworker Attribution & Identity** (DESIGN.md 1.1: Vy vs Ly/Dy/Uy) | `TodayList` prints `"Từ Ly"`, `TodayBrief` prints a `proposal` badge + `"Từ Vy"`, `AiWrittenBadge` prints `"Do đồng nghiệp AI viết"`, `VyClausePanel` prints a custom header + `AiMeter`, `NotesVyOrganizerPanel` uses a custom button with `NavIcon name="appAi"`. | Create a single `<CoworkerAttribution name={...} role={...} source={...} />` micro-component that renders the teal-key/avatar mark, coworker name (`Vy`, `Ly`, `Dy`, `Uy`), and plain-language provenance reason in one consistent pattern. |
| **Inline / Sheet sidecar over layout-jumping accordions** (Notion AI, Shopify Sidekick) | `MyWorkVyPlannerPanel` and `NotesVyOrganizerPanel` mount inline above the list, pushing user tasks/notes down abruptly. | Present on-demand Vy planners/organizers inside the shared right-hand `Sheet` (or sticky sidecar above `lg`), keeping the user's primary list stationary while reviewing and applying 1-click suggestions. |
| **Graceful AI-off parity without nagging noise** | `AccountingOverview` hides `Explanation` cleanly when AI is off; `TodayBrief` falls back silently to deterministic template copy; `VyClausePanel` renders a muted notice box; `AiMeter` shows `"AI đang tắt"` text. | Standardize two tiers: (1) ambient AI slots (Overview brief, Finance explanation, Intent sort) silently omit or show deterministic text when AI is off; (2) explicit on-demand AI buttons (`Ask Vy`, `Analyze Contract`, `Draft Reply`) are either cleanly hidden or disabled with one concise tooltip explaining AI is off in `Ludy AI`. |

---

## 3. `DESIGN.md` Governance Gaps (Root-Cause Analysis)

### Why the `AccountMenu` & `ThemeSwitcher` Drift Happened

In JOY's 2026-11-23 screenshot of `app.ludy.vn/o/dos/settings`, two structural problems appeared together:
1. The sidebar foot housed a raw HTML `<details>` disclosure containing two full-width `<NativeSelect>` controls (`Ngôn ngữ`, `Giao diện`) stacked in text, looking clunky inside a modern workspace shell.
2. The `Giao diện` `<NativeSelect>` displayed **`Sáng`** while the page actually rendered **dark**.

Inspecting `origin/main` reveals **both the code root cause and the specification root cause**:
- **Code root cause (`apps/app/src/components/theme-switcher.tsx`, `apps/app/src/lib/theme-runtime.ts`, `packages/ui/src/components/native-select.tsx`):**
  1. `ThemeSwitcher` passes `className="w-full text-muted-foreground"` onto `NativeSelect` (`app-nav.tsx:282`), styling the wrapper `<div>` while `<select>` uses `appearance-none bg-transparent dark:bg-input/30` and `<option className="bg-[Canvas] text-[CanvasText]">` inside a collapsed `<details>` element.
  2. `theme-runtime.ts` reads `localStorage` **only once at module load** (`line 8`) into a module-level `current` variable, and its `storage` listener (`line 68`) exits early (`if (event.key !== THEME_STORAGE_KEY) return;`), missing `localStorage.clear()` (`event.key === null`) or external mutations to `<html>.classList` / `ludy-theme`. When DOM state (`html.dark`) and module memory (`current = 'light'`, `DEFAULT_THEME`) diverge, `NativeSelect` cheerfully renders `Sáng` on a dark screen.
- **Specification root cause (`DESIGN.md`):**
  `DESIGN.md` (772 lines) meticulously specifies tokens, typography, 6px radii, buttons, form validation, 36px tables, AI proposals, and `apps/web` anatomy, **yet contains zero specification for the App Shell's chrome, User/Account menu, Workspace/Org switcher placement, or compact utility toggles**. Coding agents therefore defaulted to raw HTML `<details>` + `<NativeSelect>` from §4.2 ("Forms").

### Proposed `DESIGN.md` Additions (for Owner Approval)

Add the following five concrete clauses to [DESIGN.md](../../DESIGN.md):

1. **Section 3.8 App Shell, Sidebar & Workspace Chrome:**
   - **Collapsible two-zone desktop shell:** Left primary rail (`64px`, `w-16`) holds `Tổng quan`, active Apps, Notifications Bell, and `Settings`. The secondary menu panel (`224px`) renders **only** when the active route owns a menu (an App or `Settings` per `#4499`) and can be collapsed with `[` on desktop (`>= md`). When `app === null` (`Overview`, `Notifications`, `Audit`, `Personal Data`), **never render an empty 224px column**; collapse cleanly to the 64px rail (with `⌘K` search icon and `AccountPopover` avatar trigger in the rail foot).
   - **Workspace / Org Switcher placement:** `OrgMenu` belongs inside the **bottom User / Account Popover** (and `/clients`), **not** pinned at the top of the sidebar above navigation. For single-org SMEs, the active org name sits as a compact header label or subtitle in the Account trigger; switching orgs or adding a client org takes 1 click inside the Account Popover or `⌘K`. `EntitySwitcher` (for multi-legal-entity accounting) renders contextually on Finance routes when `entities.length > 1`.
   - **User / Account Popover (`AccountMenu`):** Built with `@ludy/ui` `Popover` or `DropdownMenu`, **never** raw `<details>`/`<summary>`. Contains: (a) User identity + active Organization switcher, (b) inline Theme segmented icon toggle + Language segmented pill toggle, (c) Help (`Góp ý / Hỗ trợ`) and System Status links, and (d) Sign out.
2. **Section 4.6 Chrome & Utility Controls (`SegmentedControl`):**
   - Introduce `@ludy/ui` `SegmentedControl` (`role="radiogroup"` / Base UI `ToggleGroup`, 28px-32px desktop, `max-md:min-h-11` mobile): crisp pill/button group with `bg-muted` track and `bg-background text-foreground shadow-xs` active thumb.
   - **Rule:** Every 2-to-4 option chrome/view preference (`Theme`: Light Sun / Dark Moon / System Monitor; `Language`: VI / EN; `View`: Board / List; `Density`: Compact / Comfortable) MUST use `SegmentedControl`, **never** `<NativeSelect>`.
   - **Theme sync invariant:** `theme-runtime.ts` must keep `<html>.classList.contains('dark')`, `root.style.colorScheme`, `localStorage('ludy-theme')`, and React `useSyncExternalStore` strictly synchronized (handling `event.key === null` storage clears and re-syncing on `startThemeSync()`).
3. **Section 4.3 Tables & Section 4.5 Peek Drawers (Tightened Rules):**
   - Enforce `36px` (`h-9`, `px-3 py-1.5`) default desktop row height inside `DataTable`; reserve `44px` (`max-md:min-h-11`) for `< md` touch screens.
   - Make `stacked` mobile card rendering the expected pattern for 3-to-6 column operational tables (`Documents`, `Vouchers`, `Sales Invoices`, `Sign Envelopes`, `Employees`, `Tax Calendar`).
   - Require `FormPanel` (`Sheet`) for all multi-field create/edit/inspect overlays (`>= 4` fields or secondary detail inspection) and reserve `FormDialog` / `ConfirmDialog` (`Dialog`) strictly for 1-3 field quick adds, confirmations, and 2FA step-up.
4. **Section 5.6 AI Coworker Presence & Attribution:**
   - Unify all non-inbox AI surfaces (`TodayBrief`, `TodayWeekly`, `DraftPanel`, `NoteVyPanel`, `MyWorkVyPlannerPanel`, `NotesVyOrganizerPanel`, `VyClausePanel`, `FinanceOverview Explanation`) on one `<CoworkerAttribution>` header + `<ProposalSurface>` dashed container (`border-dashed border-proposal/60`) whenever content is unapproved or AI-drafted.
5. **Section 10 "Do not" Additions:**
   - No raw HTML `<details>`/`<summary>` menus in persistent navigation chrome.
   - No `<NativeSelect>` for 2-to-4 choice shell toggles (Theme, Language, Board/List).
   - No empty secondary sidebar panel on `app === null` routes (`Overview`, `Notifications`, `Audit`, `Personal Data`).
   - No stacking operational alert, intake, or reconciliation cards above primary list tabs (`InboxPage`).
   - No multi-word Vietnamese `uppercase` headings (`> 2` words).
   - No colored rounded icon tiles above headings on `apps/web` (`AppCards`, `Story`).

---

## 4. Concrete Layout and Component Recommendations

### 4.1 App Shell: No Ghost Column + Bottom Account/Org Popover + Segmented Theme Toggle

**Current (`origin/main`):** On `Overview`, `Notifications`, `Audit`, and (pre-`#4499`) `Settings`, `w-72` stays open with a mostly blank secondary panel, `OrgMenu` sits at the top, and `AccountMenu` expands `<details>` with two `<NativeSelect>` dropdowns.

**Proposed:**
```text
A) When app === null (Overview, Notifications, Audit, Personal Data):
+------+---------------------------------------------------------------+
| Rail | Main Workspace (reclaims +224px! max-w-6xl centered nicely)   |
| 64px |                                                               |
|      |  [Tổng quan]                                   [+ Tải hóa đơn]|
| [🏠] |  Hôm nay cần bạn ...                                          |
| [🤝] |                                                               |
| [💰] |                                                               |
| [📣] |                                                               |
| [👥] |                                                               |
| [✍]  |                                                               |
| [✨] |                                                               |
| ---- |                                                               |
| [🔍] |  <- ⌘K Search button in rail when secondary panel is collapsed  |
| [🔔] |                                                               |
| [⚙]  |                                                               |
| [AV] |  <- User Avatar button opens AccountPopover (shown below)       |
+------+---------------------------------------------------------------+

B) When inside an App or Settings (#4499):
+------+----------------------+----------------------------------------+
| Rail | Secondary Sidebar    | Main Workspace                         |
| 64px | 224px (collapse [ )  |                                        |
|      | [Ludy]          [◧]  |  PageHeader                            |
| [🏠] | [🔍 Tìm / mở   ⌘K][+] |  ScreenTabs                            |
| [💰]*|                      |  Content / Table / Split View          |
|  ... | Tài chính            |                                        |
|      |  Tổng quan           |                                        |
|      |  Chứng từ        [4] |                                        |
|      |  Phiếu thu chi       |                                        |
|      |  Sao kê ngân hàng    |                                        |
|      |  ...                 |                                        |
|      | -------------------- |                                        |
| [🔔] | [AV] Minh Anh        |  <- Clicking opens AccountPopover:     |
| [⚙]  |      Gạo Sạch Mekong |     +--------------------------------+ |
+------+----------------------+     | Minh Anh (anh@example.com)     | |
                                    | Tổ chức: [Gạo Sạch Mekong  ▾]  | |
                                    |          [Tất cả doanh nghiệp] | |
                                    |          [+ Thêm tổ chức]      | |
                                    | ------------------------------ | |
                                    | Giao diện   [ ☀ | 🌙 | 🖥 ]    | |
                                    | Ngôn ngữ    [ VI | EN ]        | |
                                    | ------------------------------ | |
                                    | Góp ý / Hỗ trợ · Trạng thái    | |
                                    | Đăng xuất                      | |
                                    +--------------------------------+
```

**Why this fits Vietnam OPC/SME:**
- Single-org founders gain 224px of clean breathing room on `Overview` and `Notifications`, and 1-click theme/language/org access without hunting inside nested `<details>` or `<NativeSelect>` OS popups.
- Accounting firms with multiple clients still have `OrgMenu`, `Tất cả doanh nghiệp`, and `+ Thêm tổ chức` one click away at the bottom-left anchor (matching Linear/Attio/Notion muscle memory) plus instant `⌘K` org switching.
- Eliminates the `"Sáng"`-on-dark `<NativeSelect>` mismatch by replacing text dropdowns with explicit icon state (`Sun`, `Moon`, `Monitor`) backed by synchronized `theme-runtime.ts`.

---

### 4.2 Finance Inbox (`InboxPage`): Queue First + Split Preview Matching `ludy.vn`

**Current (`inbox.tsx:504-673`):** Above the `Chờ duyệt` tabs, the page renders `AiMeter`, `TwoFactorOffer`, Dropzone/Inbound card, `HiddenByApps`, `IntakePanel`, `StagedMarketplace*` (3 cards), `StagedStatements`, `FailedJobs`, `OriginalsNeeded`, `OpenBankLines`, `SocialAttention`, `SocialMails`, and `recentFiles` before the user sees a single pending proposal. On `/o/$slug/inbox`, clicking a proposal navigates away rather than opening a side preview (unlike `apps/web/src/components/landing/app-shell.tsx`).

**Proposed:**
```text
+-------------------------------------------------------------------------+
| Chứng từ                                    [LegalEntity] [+ Tải] [📷]  |
| AI Meter (compact inline pill when >= 80% or off)                       |
+-------------------------------------------------------------------------+
| [Chờ duyệt (12)]  [Tất cả chứng từ]                                     |
| Status sub-filter: (Chờ duyệt 12) (Đã duyệt) (Từ chối) (Hết hạn)        |
+-------------------------------------------------------------------------+
| Compact Action Strip (collapsed summary pills, expand on click):        |
| [! 2 việc cần xử lý: 1 file lỗi · 3 dòng sao kê chưa khớp]  [Xem ▾]     |
| [+ Thả XML / PDF / ảnh vào đây hoặc gửi tới inv@gaosach.example]       |
+-------------------------------------------------------------------------+
| ProposalGroups ("3 hóa đơn sạch từ EVN theo quy tắc đã học") [Duyệt 3]  |
+------------------------------------+------------------------------------+
| Queue List (select + J/K nav)      | Inline Peek / Detail Pane (>=xl)   |
| [x] Bao Bì Phú Thịnh   32.832.000₫ |  HĐ GTGT 00001284  [Đề xuất]       |
|     1C26TPT · 5/5 đạt              |  [5/5 kiểm tra đạt ✓]              |
| [ ] HTX Tân Hồng      148.500.000₫ |  Nợ 152 (30.4M), 1331 / Có 331     |
|     ! Thiếu mã CQT                 |  "Theo quy tắc đã học: Bao bì"     |
| [ ] Viettel               880.000₫ |  [PDF/Ảnh gốc]  [Sửa] [Từ chối]    |
|                                    |  [Duyệt và ghi sổ (A)]             |
+------------------------------------+------------------------------------+
```

**Why this fits Vietnam OPC/SME:**
- Opening `Chứng từ` puts the decision queue (`ProposalGroups` + `Chờ duyệt`) in the first 250px of viewport height instead of buried under secondary operational notices.
- Bringing an inline split preview onto `/o/$slug/inbox` at `xl` (`1280px`) directly fulfills what `apps/web` (`app-shell.tsx`) already demonstrates to prospects, while retaining `/o/$slug/inbox/$id` deep-links and `PhoneActionBar` at `< 640px`.

---

### 4.3 `OverviewPage`: Above-the-Fold Action Triage

**Current (`overview.tsx`):** 8 vertical sections run down a single scroll column, forcing owners to scroll past `TodayList`, `Waiting`, `TaxCalendar`, `TodayWeekly`, `SinceYesterday`, `SalesNumberGaps`, `AppCards`, and `OrgNotesPanel`.

**Proposed:**
- **Row 1 (Hero Action Queue):** `Hôm nay cần bạn` (`TodayList`) with a compact inline `TodayBrief` header banner inside the same card container (avoiding double card spacing).
- **Row 2 (Compact Operational Strip):** Merge `Waiting` counts (`failedFiles`, `notifications`, `tasks`) + `SinceYesterday` ("Ly đã chuẩn bị 4 bút toán") into one horizontal pill/link bar when non-empty.
- **Row 3 (Compliance & Pulse):** `TaxCalendar` (next 30 days) beside or above `TodayWeekly` ("Tuần này") in a responsive 2-column grid at `lg`, keeping both above the fold on 1366x768.
- **Row 4 (Quiet Footer Links):** `AppCards` becomes a clean compact status row (`Tài chính: 4 ngày nữa hạn GTGT`, `Engage: 2 bài chờ đăng`, `Cộng tác`, `Nhân sự`, `eSign`) instead of repeating the left rail switcher as large multi-line cards.

---

### 4.4 `DataTable` Density, Peek `Sheet`, and Mobile `stacked` Mode

1. **Standardize 36px desktop rows (`packages/ui/src/components/table.tsx` & `apps/app/src/components/ui.tsx`):**
   - Set default `TableHead` `h-9 px-3 text-xs` and `TableCell` `px-3 py-1.5 text-sm` (giving ~36px single-line rows on desktop), update `TableSkeleton` rows in `apps/app/src/components/ui.tsx:224` from `h-12` to `h-9` to prevent height jump, and remove ad-hoc `px-4 py-3` overrides across Finance/HR/Documents callers.
   - Add an optional `stickyFirstCol` prop on `DataTable` (`sticky left-0 z-[5] bg-card`) for wide financial/payroll tables (`hr-payroll.tsx`, `hr-declarations.tsx`, `household.tsx`, `ledger.tsx`).
2. **Roll out `stacked` to operational SME tables:**
   - Add `data-label` + `stacked` to `overview.tsx` (Tax Calendar), `documents.tsx`, `vouchers.tsx`, `sales-invoices.tsx`, `hr-employees.tsx` (summary rows), and `sign-envelopes.tsx` (using `DataTable stacked` or uniform cards) so 360px phone users never drag horizontal tables.
3. **Unify `FormPanel` (`Sheet`) for records + detail peek:**
   - Migrate multi-field `Dialog` forms in `project-task-dialog.tsx`, `sign-envelopes.tsx:526`, and `meetings.tsx` to `FormPanel` (or `FormDialog` for 1-3 fields) so every form in Ludy shares `Cmd+Enter` submit, dirty-close warning, and focus return.

---

### 4.5 Standardized AI Coworker Surface & `SegmentedControl` Primitive

```text
Standard <ProposalSurface> (every unapproved AI output across all apps):
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
: [✦ Đề xuất]  Từ Ly (Kế toán AI) · Theo quy tắc đã học: Bao bì (0 sửa)  :
:                                                                       :
:  Nợ 152 (30.400.000 ₫), Nợ 1331 (2.432.000 ₫) / Có 331 (32.832.000 ₫) :
:                                                                       :
:  [✓ 5/5 kiểm tra đạt]             [Từ chối (R)]  [Sửa (E)]  [Duyệt (A)] :
+ - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
  ^ Dashed border: border-dashed border-proposal/60 bg-proposal/5
```

And in `packages/ui/src/components/segmented-control.tsx`:
```text
Theme toggle in AccountPopover:   [ ☀ | 🌙 | 🖥 ]   (aria-label: Sáng / Tối / Theo hệ thống)
Lang toggle in AccountPopover:    [ VI | EN ]       (aria-label: Tiếng Việt / English)
View toggle in Deals / Projects:  [ Bảng | Danh sách ]
```

---

### 4.6 Marketing Site (`apps/web`) Polish

1. **Remove icon tiles above headings (`DESIGN.md` 3.7 & 10):** Replace the `size-11 rounded-xl bg-accent-soft` / `size-12 rounded-xl` icon boxes above `<h3>` in `apps/web/src/components/landing/app-cards.tsx:22` and `apps/web/src/components/landing/story.tsx:46` with crisp 20px inline `lucide` icons directly beside the heading or step number (matching `AppPage` in `apps/web/src/components/apps/app-page.tsx:69-74`).
2. **Enforce plain Vietnamese on `apps/web/src/content/vi.ts`:** Replace jargon in summary cards (`appCards` & `modules` lines 251, 258, 411, 416, 582, 598) such as `B01 và B02`, `911 và 4212`, `D02-LT, 05/KK-TNCN, 05/QTT-TNCN`, `PAdES-LTV`, `niêm phong SHA-256`, `MCP` with plain business outcomes (*"báo cáo tài chính nháp", "kết chuyển cuối năm", "bảng kê bảo hiểm và thuế TNCN", "chứng thư chống sửa đổi", "kết nối công cụ AI ngoài"*), keeping technical details on `/ke-toan`, `/nhan-su`, `/esign` FAQ/docs.
3. **Sync `app-shell.tsx` shadow rule & split realism:** Replace `shadow-2xl` on `apps/web/src/components/landing/app-shell.tsx:302` (`border-line` + `shadow-2xl` violates `DESIGN.md` 3.5) with `shadow-sm` + `border-line`, and align `apps/app`'s `/inbox` route with that split preview.

---

## 5. Prioritized Implementation Roadmap

*No build issues are opened in this PR. JOY reviews and approves these waves first before `line:frontend` opens implementation slices.*

### Wave P0: Quick Wins (High Impact, Low Effort, Zero Architecture Risk)

| Slice | Proposed Change | Impact | Effort | Key Files |
| :--- | :--- | :---: | :---: | :--- |
| **P0-1** | **Governance update to `DESIGN.md` (v4.4):** Add §3.8 (Shell, collapsible no-app rail, bottom Account Popover + OrgMenu placement), §4.6 (`SegmentedControl` + `<NativeSelect>` ban on chrome toggles + theme sync invariant), §5.6 (AI Coworker attribution), and §10 chrome anti-patterns. | High | Low | `DESIGN.md` |
| **P0-2** | **Shell Chrome Fix (`Blocked by #4499`):** Move `OrgMenu` out of sidebar top into a bottom `AccountPopover` (`Popover`); add `SegmentedControl` in `packages/ui`; replace `ThemeSwitcher` `<NativeSelect>` with 3-icon `Sun`/`Moon`/`Monitor` toggle + fix `theme-runtime.ts` storage-clear/DOM-sync bug; replace `LocaleSwitcher` `<NativeSelect>` with `VI`/`EN` toggle. | Very High | Low-Med | `packages/ui/src/components/segmented-control.tsx`, `apps/app/src/components/app-nav.tsx`, `theme-switcher.tsx`, `lib/theme-runtime.ts`, `i18n/provider.tsx` |
| **P0-3** | **Mobile Touch Parity + Typography/Button Sweep:** Add `max-md:min-h-11` directly to `packages/ui` `Input` and `NativeSelect` (removing one-off hacks in `hr-employees.tsx` & `conversation-touch.ts`); remove `min-h-11` desktop override on `sign-envelopes.tsx`; convert multi-word Vietnamese `uppercase` headings to sentence case (`inbox-detail.tsx`, `vouchers.tsx`, `components/project-board.tsx`, `hr-declarations.tsx`); fix `meetings.tsx` status chip (`default -> success`); adopt `<Button loading>` on `onboarding.tsx`, `meetings.tsx`, `social.tsx`, `accounts.tsx`. | High | Low | `packages/ui/src/components/input.tsx`, `native-select.tsx`, `apps/app/src/routes/inbox-detail.tsx`, `components/project-board.tsx`, `routes/meetings.tsx`, `onboarding.tsx`, `sign-envelopes.tsx` |
| **P0-4** | **`apps/web` Visual & Plain-Language Cleanup:** Remove colored rounded icon tiles above headings in `app-cards.tsx` and `story.tsx`; change `app-shell.tsx` `shadow-2xl` to `shadow-sm`; simplify jargon codes in `apps/web/src/content/vi.ts` (`appCards` & `modules`). | High | Low | `apps/web/src/components/landing/app-cards.tsx`, `story.tsx`, `app-shell.tsx`, `content/vi.ts` |

### Wave P1: Structural Shell & Pattern Upgrades (High Impact, Medium Effort)

| Slice | Proposed Change | Impact | Effort | Key Files |
| :--- | :--- | :---: | :---: | :--- |
| **P1-1** | **Smart Collapsible Sidebar Rail (`w-16` on `app === null` + `[` focus toggle):** Hide the empty 224px secondary panel on Overview, Notifications, Audit, and Personal Data (moving `⌘K` search icon + `AccountPopover` trigger into the rail); add persisted `[` collapse toggle on App screens. | Very High | Medium | `apps/app/src/routes/org-layout.tsx`, `components/app-nav.tsx` |
| **P1-2** | **Finance Inbox Queue-First Layout + Split Preview:** Consolidate secondary intake/failed/staged/bank/social cards above `Chờ duyệt` into a compact collapsible action strip; surface `ProposalGroups` + pending list immediately; support xl (`1280px+`) split detail preview directly on `/o/$slug/inbox` matching `apps/web`'s `AppShell`. | Very High | Medium | `apps/app/src/routes/inbox.tsx`, `inbox-detail.tsx` |
| **P1-3** | **36px `DataTable` Density + `stacked` Mobile Rollout:** Tighten `DataTable` cells to 36px desktop rows (`px-3 py-1.5`), add `stickyFirstCol` option for wide ledgers/payroll, and enable `stacked` mobile cards on `overview`, `documents`, `vouchers`, `sales-invoices`, `hr-employees`, and `sign-envelopes`. | High | Medium | `packages/ui/src/components/table.tsx`, `apps/app/src/components/ui.tsx`, route tables |
| **P1-4** | **Overlay Consolidation (`Dialog` -> `FormPanel` / `FormDialog`):** Move multi-field `Dialog` forms (`project-task-dialog.tsx`, `sign-envelopes.tsx` create dialog, `meetings.tsx` modal) onto `FormPanel` (`Sheet`) or `FormDialog` for consistent `Cmd+Enter` and unsaved-input protection. | Medium-High | Medium | `apps/app/src/components/project-task-dialog.tsx`, `routes/sign-envelopes.tsx`, `routes/meetings.tsx` |
| **P1-5** | **Command Palette Frecency & Quick Actions:** Show up to 5 recent screens/records per org when `⌘K` opens with an empty query; add inline action entries (`Tạo việc mới`, `Đổi giao diện`, `Đổi tổ chức`). | Medium | Low-Med | `apps/app/src/components/command-palette.tsx`, `lib/palette.ts`, `routes/org-layout.tsx` |

### Wave P2: AI-Coworker UX & Polish (High Trust, Medium-High Effort)

| Slice | Proposed Change | Impact | Effort | Key Files |
| :--- | :--- | :---: | :---: | :--- |
| **P2-1** | **Unified `<ProposalSurface>` & `<CoworkerAttribution>`:** Apply consistent `border-dashed border-proposal/60` and coworker provenance across `VoucherCard`, `ReversalCard`, `JournalVoucherCard`, `DraftPanel`, `TodayBrief`, `VyClausePanel`, `MyWorkVyPlannerPanel`, and `NotesVyOrganizerPanel`; move inline Vy organizers into a consistent right-hand `Sheet`. | High | Medium | `apps/app/src/components/proposal-badges.tsx`, `conversation-drafts.tsx`, `my-work-vy-planner.tsx`, `notes-vy-organizer.tsx`, `sign/vy-clause-panel.tsx`, `routes/inbox-detail.tsx` |
| **P2-2** | **`OverviewPage` Action-First Compression + Day-1 Empty State:** Combine `Waiting` + `SinceYesterday` into one scannable strip, compress `AppCards` into status links, place `TaxCalendar` + `TodayWeekly` side-by-side at `lg`, and turn empty Home into a 3-step SME quick-start card. | High | Medium | `apps/app/src/routes/overview.tsx`, `components/today-list.tsx`, `since-yesterday.tsx` |
| **P2-3** | **Shared `PhoneActionBar` & Peek `Sheet` Across Queues:** Extract `PhoneActionBar` from `inbox-detail.tsx` into `components/ui.tsx` and wire it + `J/K` peek drawers onto `Documents`, `SignEnvelopes`, `TodayList` single-tap inspect, and `HR` approval rows. | Medium-High | Medium | `apps/app/src/components/ui.tsx`, `routes/inbox-detail.tsx`, `documents.tsx`, `sign-envelopes.tsx` |

### Icebox (Explicitly Deferred per `docs/product/scope.md`)

- **User-reordered sidebar trees & custom navigation pinning:** Valuable for large multi-department enterprises (Attio/Notion scale), unnecessary overhead for 1-to-50 person SMEs with 5-6 concise apps.
- **Per-column drag-resizable table widths persisted per user:** Adds state complexity while `stickyFirstCol` + compact 36px density solves the bookkeeper need cleanly.
- **Persistent global floating AI chat dock across all screens:** Explicitly excluded by [ai-first-reference-study.md](../research/ai-first-reference-study.md) §3.3; Ludy keeps AI inside workflow screens (`Inbox`, `Drafts`, `Notes`, `eSign`, `Home`).
- **Multi-entity consolidated executive cockpit & cross-org custom dashboards:** Deferred until core single-org pilot loops reach high daily satisfaction.

---

## 6. External References (2025-2026 Research)

- **Workspace & Navigation Architecture:** Linear (collapsible sidebar `[` & `Cmd+K` frecency), Attio & Twenty CRM (object rail collapse, bottom workspace/account popover, master-detail peek sheets), Stripe Dashboard & Shopify Admin (jobs-to-be-done navigation, progressive disclosure, Sidekick inline vs panel).
- **Vietnam & SEA SME Ergonomics:** MISA AMIS & meInvoice (TT133 tabular density, deterministic anomaly flags), KiotViet (touch-first 44px mobile controls, plain SME vocabulary), Base.vn & Lark (lightweight mobile thumb-zone approvals, clean operational microcopy).
- **AI-Native Coworker Trust & HITL:** Ramp Policy Agent (policy-cited decisions + disagreement tracking), Linear Triage Intelligence (reason-first inline suggestions), Xero JAX (reviewable/undoable post-fact lists), plus Ludy's prior benchmark in [ai-first-reference-study.md](../research/ai-first-reference-study.md).
