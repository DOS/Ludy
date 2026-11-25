# Unified UI Shell: 48px Global Top Bar, 2-Column Notifications, and Role-Aware Global Home (#4923)

- **Date:** 2026-11-25
- **Issue:** https://github.com/DOS/Ludy/issues/4923 (`M3 Paid pilot`, `priority:P1`, `line:platform`, `web`)
- **Design System:** [DESIGN.md](../../DESIGN.md) Version 4.5 (2026-11-25)
- **Vietnamese Owner Summary:** [ui-shell-top-bar-and-home.vi.md](./ui-shell-top-bar-and-home.vi.md)
- **Related Prior Docs:** [ui-ux-review-2026-11-23.md](./ui-ux-review-2026-11-23.md), [lean-navigation-audit-2026-11.md](./lean-navigation-audit-2026-11.md), [scope.md](../product/scope.md), [ai-first-reference-study.md](../research/ai-first-reference-study.md)

---

## 1. Purpose and Approved Product Direction

This specification defines the target application chrome, notifications layout, and customizable Global Home for `apps/app`, along with the database persistence contract and a 5-phase implementation plan for M3 Paid pilot.

Owner decisions approved on 2026-11-25 ([#4923](https://github.com/DOS/Ludy/issues/4923)):

1. **HubSpot-style 48px Global Top Bar:** Persistent across every authenticated org screen (`Overview`, `Notifications`, all Apps, `Settings`, `Audit`, `Personal Data`) so global controls never jump or disappear between Home and Apps.
2. **Stable 64px Left Navigation Rail + Contextual 224px Submenu:** Constant vertical padding (`md:py-3`) across all routes, eliminating the `8px` vertical icon jump and holding strictly navigation destinations (`Tổng quan` plus active org Apps).
3. **Clarify-style 2-Column Notifications Master-Detail:** Persistent notification feed beside an inline detail pane on desktop (`>= lg`) so triaging notifications never loses scroll context or triggers rail jumps.
4. **Role x Enabled-App Customizable Global Home (`/o/$slug/overview`):** Anchored `Hôm nay cần bạn` queue plus compact inline **Vy** prompt bar at top, followed by modular app blocks filtered by both enabled org modules and the member's role/permissions, with empty blocks collapsed to one quiet line and member `Tùy chỉnh` (visibility + reorder + reset) persisted in PostgreSQL via `Runtime.execute()`.

---

## 2. OPC / SME AI-First Scope Gate Verification

Checked against [AGENTS.md](../../AGENTS.md) and [scope.md](../product/scope.md):

1. **Fit:** Serves daily and monthly single-owner, household business, and Vietnamese SME workflows: consistent workspace chrome, single-view notification triage, and role-relevant daily overview. Rejects enterprise dashboard builders, arbitrary KPI widget canvases, multi-org agency cockpits, and custom-object studios.
2. **Smallest useful slice:** Works out of the box with zero configuration through deterministic `(enabledModules x memberPermissions)` defaults. Home `Tùy chỉnh` is optional, bounded to a canonical allowlist of app summary blocks, and reversible in one click ("Đặt lại mặc định theo vai trò" / "Reset to role defaults").
3. **AI part named:**
   - **Vy** (both coworker and general-manager assistant per [DESIGN.md](../../DESIGN.md) §1.1 and §5.6) is reachable from two consistent anchors: the **Vy** drawer button in the Global Top Bar and the compact inline **Vy** prompt bar + `TodayBrief` inside `Hôm nay cần bạn` on Home.
   - All model calls go through the AI budget meter (`AiMeter` / `AI_FEATURES` / `vy.use` permission).
   - Core navigation, Notifications triage, and Home block summaries continue working cleanly with AI off or out of budget (falling back to deterministic template summaries or hiding ambient AI slots silently).
   - AI outputs remain tainted (`ProposalSurface` dashed framing) and humans explicitly approve every state change involving money, outgoing messages, or spend.

---

## 3. Root-Cause Inventory of Current Shell & Home Bugs (`origin/main`)

| Bug / Friction | Exact Source Location | User-Visible Symptom & Architectural Cause |
| :--- | :--- | :--- |
| **8px vertical rail icon jump** | [app-nav.tsx:189](../../apps/app/src/components/app-nav.tsx#L189) | `railOnly ? 'w-full md:py-2' : 'w-16 border-r md:py-4'` switches desktop top padding between `8px` and `16px`. Switching between Home/`Notifications` (`railOnly = true`) and an App or `Settings` (`railOnly = false`), or pressing `[` to collapse, shifts every rail icon vertically by `8px`. |
| **Missing `<Logo />` on Home and Notifications** | [app-nav.tsx:292-296](../../apps/app/src/components/app-nav.tsx#L292-L296) | `<Logo />` renders inside `{!railOnly && ...}` in the `224px` secondary panel, so opening Home (`/o/$slug/overview`), `Notifications`, `Audit`, `Personal Data`, or collapsing the secondary menu hides the Ludy mark completely. |
| **Column-jumping utility controls** | [app-nav.tsx:231-290, 314-337, 376](../../apps/app/src/components/app-nav.tsx#L231-L290) | `CommandPalette` (`rail-search-btn`), quick capture `+` (`shell-quick-capture-btn`), and `AccountPopover` (`compact` vs full) jump between the `64px` rail foot (`railOnly = true`) and the `224px` secondary panel (`railOnly = false`). Bell and Settings also crowd the rail foot instead of a fixed global top bar. |
| **Single-column Notifications loses context** | [notifications.tsx:143-199](../../apps/app/src/routes/notifications.tsx#L143-L199) | Opening a notification navigates away from `/o/$slug/notifications`, losing feed position during multi-item triage; meanwhile `railOnly` activates on `/notifications`, moving `AccountPopover` left into the rail. |
| **Static Home ignores role & crowds top header** | [overview.tsx:351-480](../../apps/app/src/routes/overview.tsx#L351-L480) | Home renders a fixed vertical stack (`HomeActions`, `TodayList`, `Day1QuickStart`, `OperationalStrip`, `TaxCalendar` + `TodayWeekly`, `SalesNumberGaps`, `AppCards`, `OrgNotesPanel`). `TaxCalendar` renders for every role whenever the widget loads, non-Finance modules appear only as bottom status pills, `HomeActions` (`uploadInvoice` / `Tải chứng từ lên` style create flows) sit inside Home instead of universal `+`, and members cannot hide or reorder blocks per role. |

Existing unit and E2E specs affected across rollout phases: [shell-3588.test.tsx](../../apps/app/test/shell-3588.test.tsx), [sidebar-rail.test.ts](../../apps/app/test/sidebar-rail.test.ts), [overview-page.test.tsx](../../apps/app/test/overview-page.test.tsx), [notifications-screen.test.tsx](../../apps/app/test/notifications-screen.test.tsx), `e2e/tests/layout.spec.ts`, and `e2e/tests/org-menu.spec.ts`.

---

## 4. Target Architecture Specification

### 4.1 Persistent 48px Global Top Bar + Stable 64px Left Rail + Contextual 224px Submenu

```text
Desktop (>= md, 48px top bar across ALL org screens):
+---------------------------------------------------------------------------------------------------+
| [Logo Ludy -> /overview] [◧]   [🔍 Tìm kiếm / Mở nhanh (⌘K)        ]   [Vy] [+] [🔔] [⚙] [AI] [AV] |
+--------+----------------------+-------------------------------------------------------------------+
| Rail   | Secondary Submenu    | Main Workspace (<main id="main-content">)                         |
| 64px   | 224px (only when     |                                                                   |
| md:py-3| active route owns    |  Route content (Overview, Notifications 2-col, App, or Settings)  |
|        | App/Settings menu &  |                                                                   |
| [Tổng] | not `[` collapsed)   |                                                                   |
| [Cộng] |                      |                                                                   |
| [Tài ] |  EntitySwitcher      |                                                                   |
| [Enga] |  (if entities > 1)   |                                                                   |
| [Nhân] |  App / Settings      |                                                                   |
| [eSig] |  Feature Groups      |                                                                   |
| [AI  ] |  & More ("Thêm")     |                                                                   |
+--------+----------------------+-------------------------------------------------------------------+
```

#### Global Top Bar (`48px` / `h-12`, desktop `>= md`)

- **Placement & persistence:** Sticky top bar (`sticky top-0 z-30 h-12 border-b bg-sidebar print:hidden`) rendered by [org-layout.tsx](../../apps/app/src/routes/org-layout.tsx) across every authenticated org route (`Overview`, `Notifications`, all Apps, `Settings`, `Audit`, `Personal Data`).
- **Left slot:**
  - `<Logo />` wrapped in a `<Link to="/o/$slug/overview">` home link (`min-h-8` clickable target, visible focus ring). Always rendered on every screen including Home and Notifications.
  - Optional sidebar collapse/expand button (`[`, `data-testid="sidebar-toggle-btn"`): rendered only when `hasSecondaryNav` is true (Apps and `Settings`), keeping `aria-expanded` and focus restoration (`useLayoutEffect` pattern from `app-nav.tsx`).
- **Center slot:**
  - Global `CommandPalette` trigger (`⌘K` on macOS / `Ctrl K` elsewhere), replacing both `rail-search-btn` and the secondary-panel search box so there is one consistent global search bar.
- **Right utility cluster (strict fixed order across all routes):**
  1. **Vy** trigger: opens the right-hand Vy quick drawer/sheet (grounded in `member-vy` permissions `vy.use`; disabled or shows deterministic AI-off note when AI is off or out of budget).
  2. **Universal Quick-Create `+` menu:** `@ludy/ui` `Popover` or `DropdownMenu` triggered by `+` (`Alt+Q` / button). Offers module- and role-gated creation targets: Upload document (`Tải chứng từ lên`, opening `/inbox` or document picker), New task (`Việc mới`, absorbing `QuickCaptureDialog` / task panel), New note, New contact/deal (when `crm` is on), and New eSign envelope (when `sign` is on). Viewers see no disallowed write actions.
  3. **Notifications bell:** `<Link to="/o/$slug/notifications">` with unread badge dot/count (`unreadNotices`).
  4. **Settings gear:** `<Link to="/o/$slug/settings">` (keeping `#4499` Settings sub-pages in the secondary panel when active).
  5. **Compact AI budget meter:** subtle pill indicator from `AiMeter` when AI is active and a budget policy applies (links to `/o/$slug/ai-usage` for owners/admins).
  6. **`AccountPopover`:** avatar + subtle active org context trigger opening `AccountPanel` (`email`, `OrgMenu`, `/clients` when `orgs.length > 1`, `Add organization`, `SegmentedControl` Theme Light/Dark/System and Language `VI`/`EN`, `SupportLink`, `StatusLink`, Sign out).

#### Stable Left Navigation Rail (`64px`, `w-16`) & Contextual `224px` Submenu

- **Constant vertical padding:** `md:py-3` on the `64px` rail regardless of route or collapse state. Remove `railOnly ? 'w-full md:py-2' : 'w-16 border-r md:py-4'` completely.
- **Rail contents (navigation only):** `TOP_ITEMS` (`Tổng quan`) followed by active, role-visible Apps (`visibleApps(allApps, visibility)`). Remove `rail-search-btn`, `shell-quick-capture-btn`, `BELL_ITEM`, `ADMIN_ITEMS` (Settings), and `AccountPopover` from the desktop rail.
- **Contextual `224px` secondary panel (`w-56`):** Renders only when `hasSecondaryNav(screenApp, apps, pathname)` is true and `!userCollapsed`. Holds `EntitySwitcher` (when `entities.length > 1` on Finance/Settings entity routes) and the active App's Feature Groups (including collapsible `MoreGroup` `Thêm`) or `SETTINGS_ITEMS`. Never renders an empty `224px` column on `Overview`, `Notifications`, `Audit`, or `Personal Data`.

#### Mobile Shell (`< md`)

- Sticky `PhoneHeader` (`min-h-11` / `44px` hit targets per `#3588`): menu button (`NavDrawer` trigger with attention dot), compact `<Logo />` + active org name (`line-clamp-2`, full name tooltip), universal quick-create `+` (or search trigger) + `⌘K` search icon.
- `NavDrawer` (`<dialog>`): scrolls as one column holding `Tổng quan`, enabled Apps, active App/Settings submenu, Notifications link, Settings link, and `AccountPopover` with `PopoverContent` portaled inside the dialog container (`container={host}`) so the top layer never leaves controls inert.

---

### 4.2 Clarify-Style 2-Column Notifications Master-Detail (`/o/$slug/notifications`)

```text
Desktop (>= lg) inside <main>:
+-----------------------------------+---------------------------------------------------+
| Thông báo       [Cài đặt] [Đọc hết] |  Detail Pane                                      |
| [Tất cả] [Chưa đọc] [Ứng dụng ▾]  |  [Tài chính · Từ Ly]  Hóa đơn đề xuất #1C26TPT     |
|-----------------------------------|  Nhà cung cấp: Công ty Mẫu · 32.832.000 ₫         |
| ● Cần duyệt: HĐ 00001284 (2p)  >  |  5/5 kiểm tra đạt · Quy tắc đã học: Bao bì        |
|   Tài chính · 25/11/2026 09:15    |                                                   |
| ○ Việc mới: Đối chiếu công nợ     |  [Mở chứng từ gốc]   [Xem & duyệt ngay ->]        |
|   Cộng tác · 25/11/2026 08:40     |                                                   |
| ● 3 dòng sao kê ngân hàng cần xem |                                                   |
+-----------------------------------+---------------------------------------------------+
```

- **Route & URL state:** Remains `/o/$slug/notifications`, adding optional validated search params (`selected`, `filter: 'all' | 'unread'`, `app`) for bookmarkable selection without extra route transitions.
- **Desktop (`>= lg`) two-pane layout:**
  - **Left feed pane (`minmax(320px, 400px)`):** Compact header with filter controls (`All` / `Unread` `SegmentedControl` + optional app filter), `Mark all read` (`Đánh dấu tất cả đã đọc`), and link to `Settings > Thông báo của tôi` (`NOTIFICATION_SETTINGS_ID`). Preserves `groupNotifications` (NT-2) collapsing consecutive unread runs, displays unread dot + `bg-primary/5` row highlight, and supports `J`/`K` keyboard row navigation plus `Enter` to focus the detail pane.
  - **Right inline detail pane:** Renders the selected notification item or grouped summary in place: title, localized message, timestamp, module/coworker attribution, key structured fields from `detail` (amount, period, bank account, document title), and direct primary actions (e.g., open proposal approval screen `/o/$slug/inbox/$id`, open task `/o/$slug/tasks/$id`, open matched bank account, or mark individual item read/unread). Selecting a row marks it read asynchronously without resetting feed scroll position or collapsing the left pane.
- **Mobile / tablet (`< lg`):** Single-column feed; tapping an item opens the detail view inside a `@ludy/ui` `Sheet` (or navigates directly for group runs if preferred, with `Esc`/Back returning focus to the row trigger).

---

### 4.3 Role x Enabled-App Customizable Global Home (`/o/$slug/overview`)

#### Anchored Top Section (Non-Removable)

1. **Header:** Plain greeting / `"Tổng quan"` `PageHeader` with last-activity subtitle and a right-aligned **`Tùy chỉnh`** (`Customize`) toggle button. Note: `Tải chứng từ lên` and old `HomeActions` buttons move out of the Home header/row into the Global Top Bar `+` menu (with Day-1 `Bắt đầu` quick-start card still shown cleanly for brand-new orgs until first invoice approval or dismissal).
2. **`Hôm nay cần bạn` + Inline Vy Prompt Bar:**
   - Anchored hero card combining `TodayList`, `TodayBrief`, and a compact inline **Vy** prompt bar (`DESIGN.md` §1.1 & §5.6).
   - Users holding `vy.use` with AI enabled can type a short prompt or pick 2 to 3 deterministic quick-ask chips (scoped to org modules and user permissions via `member-vy`, metered through `AiMeter`).
   - When AI is off or out of budget, the prompt bar hides or shows one quiet status line; `Hôm nay cần bạn` continues running deterministically. Humans still confirm every money, message, or spend action.
3. **Compact Operational Strip:** Existing merged `Waiting` counts + `SinceYesterday` coworker strip (hidden automatically when empty).

#### Canonical Role x Enabled-App Modular Blocks

Only canonical block IDs defined in `@ludy/kernel-contract` are valid. A block is **eligible** only when its backing module is enabled for the org (`effectiveModules`, ADR-0053) AND the member's role/permissions grant visibility:

| Block ID | Backing Module(s) | Default Visibility by Role / Permission | Collapsed Empty State (0 items) |
| :--- | :--- | :--- | :--- |
| `finance_tax_deadlines` | `finance` | On by default for `owner`, `admin`, or members with `finance.proposal.approve` / `finance.period.unlock` / `finance.vat.file` or Finance role keys; off by default for pure sales/HR/teamwork members | Single quiet line: `"Không có hạn thuế trong 30 ngày tới · Mở Thuế"` |
| `finance_approvals` | `finance` | On by default for `owner`, `admin`, and Finance approvers/accountants; hidden for non-Finance roles unless permitted | Single quiet line: `"Không có chứng từ chờ duyệt · Mở Chứng từ"` |
| `teamwork_my_work` | `kernel` (`tasks`, `notes`, `projects`, `meetings`) | On by default for `owner`, `admin`, `member`; `viewer` sees read-only notes summary when `notes` is on | Single quiet line: `"Không có việc đến hạn tuần này · Mở Cộng tác"` |
| `engage_pipeline` | `crm`, `social` | On by default when `crm` or `social` is enabled for `owner`, `admin`, `member` (sales/marketing/desk) | Single quiet line: `"Chưa có lịch hẹn hay hội thoại mới · Mở Engage"` |
| `hr_pending` | `hr` | On by default for `owner`, `admin`, or `hr.manager` (pending leave/OT/onboarding); `member` sees compact `Cổng nhân viên` link; hidden for `viewer` | Single quiet line: `"Không có yêu cầu nhân sự chờ duyệt · Mở Nhân sự"` |
| `esign_pending` | `sign` | On by default when `sign` is enabled for `owner`, `admin`, `member`; hidden for `viewer` | Single quiet line: `"Không có hồ sơ chờ ký · Mở eSign"` |

- **Empty collapse rule:** A block with zero actionable items collapses to a single quiet bordered line with a link to its app, keeping Home scannable above the fold.
- **Disabled module safety:** Turning a module off (`apps_off`, ADR-0053) immediately hides its Home blocks even if a saved layout includes them, without deleting the user's stored preference.

#### `Tùy chỉnh` (`Customize`) Mode

- Clicking **`Tùy chỉnh`** enters inline edit mode directly on `/o/$slug/overview`:
  - Each eligible block shows a `@ludy/ui` `Switch` (show/hide), a drag handle for pointer reordering, and accessible **Lên** (`Move Up`) / **Xuống** (`Move Down`) icon buttons (`WCAG 2.5.7` non-drag alternative, `min-h-11` on `< md`, disabled at list bounds, announcing new position in a polite live region).
  - Footer/toolbar offers **`Đặt lại mặc định theo vai trò`** (`Reset to role defaults`), **`Hủy`**, and **`Lưu bố cục`** (`Save layout`).
  - Saving calls `Runtime.execute()` (`kernel.member.home_layout.save`), syncing across desktop and mobile immediately.

---

## 5. Exact Database Persistence & Kernel Command Design

### 5.1 Migration Specification

File path convention (Phase 1): `supabase/migrations/<14-digit UTC>_ludy_kernel_member_home_layout.sql` (following ADR-0054 `ludy_kernel` schema rebrand in `20270315090000_ludy_kernel_rebrand_core_schemas_roles_gucs.sql` and `20270317160000_ludy_kernel_push_subscription.sql`; note older repo docs refer to `crove_kernel` before ADR-0054, while `migration-lint.mjs` expects `ludy_kernel` on `_ludy_kernel_*` files).

1. **Shape validation helper (`ludy_kernel.member_home_layout_ok(p_layout jsonb)`):**
   - `LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp` with all functions `pg_catalog.`-qualified.
   - `REVOKE ALL ON FUNCTION ludy_kernel.member_home_layout_ok(jsonb) FROM PUBLIC;`
   - `GRANT EXECUTE ON FUNCTION ludy_kernel.member_home_layout_ok(jsonb) TO ludy_tenant;` (required because `CHECK` runs under the writing tenant role).
   - Enforces:
     - `pg_catalog.jsonb_typeof(p_layout) = 'object'` and `pg_catalog.octet_length(p_layout::text) <= 4096`.
     - Exactly two top-level keys: `v` (`1`) and `blocks` (`array`, length `1..12`).
     - Every element of `blocks` is a JSON object with exact keys `id` (`string` in the canonical block allowlist `ARRAY['finance_tax_deadlines', 'finance_approvals', 'teamwork_my_work', 'engage_pipeline', 'hr_pending', 'esign_pending']`) and `visible` (`boolean`).
     - Zero duplicate block IDs (`count(DISTINCT id) = array_length`).

2. **Table `ludy_kernel.member_home_layout`:**
   ```sql
   CREATE TABLE IF NOT EXISTS ludy_kernel.member_home_layout (
     org_id uuid NOT NULL REFERENCES ludy_kernel.tenant (org_id) ON DELETE CASCADE,
     user_id uuid NOT NULL,
     layout_json jsonb NOT NULL CHECK (ludy_kernel.member_home_layout_ok(layout_json)),
     updated_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
     PRIMARY KEY (org_id, user_id),
     CONSTRAINT member_home_layout_member_fk
       FOREIGN KEY (org_id, user_id) REFERENCES ludy_kernel.tenant_member (org_id, user_id) ON DELETE CASCADE
   );
   ```

3. **Tenancy, RLS, and Column Privileges:**
   - Apply tenant baseline: `SELECT ludy_kernel.apply_tenant_rls('ludy_kernel.member_home_layout');`
   - Lock ownership columns against mutation:
     ```sql
     REVOKE UPDATE ON ludy_kernel.member_home_layout FROM ludy_tenant;
     GRANT UPDATE (layout_json, updated_at) ON ludy_kernel.member_home_layout TO ludy_tenant;
     ```
   - Restrictive own-member policy (matching `notification_mute` and `push_subscription`; agents never read or write another user's or member's Home layout):
     ```sql
     DROP POLICY IF EXISTS own_member_home_layout ON ludy_kernel.member_home_layout;
     CREATE POLICY own_member_home_layout ON ludy_kernel.member_home_layout
       AS RESTRICTIVE FOR ALL TO ludy_tenant
       USING (
         user_id = (SELECT ludy_kernel.ctx_user_id())
         OR ((SELECT ludy_kernel.ctx_user_id()) IS NULL AND (SELECT ludy_kernel.ctx_agent_id()) IS NULL)
       )
       WITH CHECK (
         user_id = (SELECT ludy_kernel.ctx_user_id())
         OR ((SELECT ludy_kernel.ctx_user_id()) IS NULL AND (SELECT ludy_kernel.ctx_agent_id()) IS NULL)
       );
     ```

4. **`org_purge` & `rls-matrix` & DB Types:**
   - Restate `ludy_kernel.org_purge(p_min_days integer)` in the migration (or paired `_org_purge_` migration) adding `'ludy_kernel.member_home_layout'` to `v_kernel_first` before `'ludy_kernel.tenant_member'` so org purge explicitly deletes and counts purged layout rows.
   - Add a `ROW_FACTORIES` entry and `MEMBER_VY_READS` (`() => 'false'`) entry in `apps/kernel/test/invariant/rls-matrix.db.test.ts` (note: agent / member-Vy contexts have no `ctx_user_id` and are excluded from reading/writing Home layout rows).
   - Regenerate `packages/db/src/generated/database.ts` via `pnpm db:types`.

### 5.2 Kernel Commands & Contract (`@ludy/kernel` & `@ludy/kernel-contract`)

All reads and writes flow exclusively through `Runtime.execute()` (zero direct browser SQL writes):

1. **Contract (`packages/kernel-contract/src/home-layout.ts`):**
   - `HOME_BLOCK_IDS`: `['finance_tax_deadlines', 'finance_approvals', 'teamwork_my_work', 'engage_pipeline', 'hr_pending', 'esign_pending'] as const`.
   - `zHomeLayoutBlock`: `z.strictObject({ id: z.enum(HOME_BLOCK_IDS), visible: z.boolean() })`.
   - `zHomeLayoutSaveInput`: `z.union([z.strictObject({ reset: z.literal(true) }), z.strictObject({ blocks: z.array(zHomeLayoutBlock).min(1).max(HOME_BLOCK_IDS.length) })])` (with unique-ID refinement).
   - `zHomeLayoutView`: `{ customized: boolean, blocks: HomeLayoutBlockView[], defaults: HomeLayoutBlockView[] }` where each returned entry includes `{ id, visible, moduleEnabled, permitted }` computed server-side from org modules + `myPermissions`.
   - oRPC endpoints on `contract.ts` (e.g., `overview.homeLayout.get` and `overview.homeLayout.save`).

2. **Kernel handlers (`packages/kernel/src/home-layout.ts`):**
   - `kernel.member.home_layout.get` (`defineQuery`, access `['owner', 'admin', 'member', 'viewer']`):
     - Rejects non-user actors (`ctx.actor.type !== 'user'` -> `FORBIDDEN`).
     - Computes deterministic role x enabled-app defaults using org effective modules (`offAppsOf` + `ctx.installed`) and `myPermissions(ctx)` / `ctx.role`.
     - Reads the member's `ludy_kernel.member_home_layout` row (`org_id = ctx.orgId AND user_id = ctx.actor.userId`).
     - Merges any saved order/visibility with newly enabled/permitted default blocks appended in canonical order, filtering out blocks for disabled modules or unpermitted roles.
   - `kernel.member.home_layout.save` (`defineCommand`, `risk: 'R1'`, `sideEffect: 'internal'`, access `['owner', 'admin', 'member', 'viewer']`):
     - Rejects non-user actors (`FORBIDDEN`).
     - If `reset: true`: deletes the caller's row from `ludy_kernel.member_home_layout` (`org_id = ctx.orgId AND user_id = ctx.actor.userId`).
     - Otherwise: upserts `layout_json = { v: 1, blocks: input.blocks }` (`ON CONFLICT (org_id, user_id) DO UPDATE SET layout_json = EXCLUDED.layout_json, updated_at = ctx.now`).
     - Logs a non-PII audit summary (`ctx.audit({ reset: Boolean(reset), blockCount })`) and emits an invalidation hint (`kernel.member.home_layout_updated`) or updates client query cache cleanly so desktop and phone sessions stay synchronized.

---

## 6. Five-Phase Implementation Breakdown (for M3 Paid Pilot)

Each phase is scoped as one independent PR against `origin/main`, sized for clean review and CI verification:

| Phase | Proposed M3 Issue Scope | Key Deliverables & Verification |
| :--- | :--- | :--- |
| **Phase 1** | **Kernel DB persistence & Home layout API** | Migration `ludy_kernel.member_home_layout` + `member_home_layout_ok` + `apply_tenant_rls` + own-member restrictive RLS + `org_purge` restatement; `pnpm db:types`; `@ludy/kernel-contract` block enum & schemas; `@ludy/kernel` `kernel.member.home_layout.get` & `save` commands; oRPC wiring; `rls-matrix.db.test.ts` + unit/DB tests verifying cross-org isolation, cross-member isolation, agent denial, reset, and invalid block rejection. |
| **Phase 2** | **HubSpot-style 48px Global Top Bar & Stable 64px Left Rail** | Persistent desktop `48px` Global Top Bar in `org-layout.tsx` holding `<Logo />` home link, `[` toggle, `⌘K` search, Vy drawer trigger, universal `+` menu (absorbing `Alt+Q` & `Tải chứng từ lên`), Notifications bell, Settings gear, compact `AiMeter`, and `AccountPopover`; fixed `md:py-3` on `64px` rail in `app-nav.tsx` (zero `8px` jump); rail holds only nav destinations; mobile `PhoneHeader` + portaled `NavDrawer` parity; update `shell-3588.test.tsx`, `sidebar-rail.test.ts`, `layout.spec.ts`, `org-menu.spec.ts`. |
| **Phase 3** | **Clarify-style 2-Column Notifications Master-Detail** | Upgrade `apps/app/src/routes/notifications.tsx` to `>= lg` 2-column master-detail (left feed with All/Unread/App filter pills, Mark all read, `J`/`K` navigation, unread state; right inline detail pane with source metadata and direct action/approval link without losing scroll position), plus `< lg` `Sheet` detail flow; update `notifications-screen.test.tsx`. |
| **Phase 4** | **Role x Enabled-App Global Home & `Tùy chỉnh` Mode** | Upgrade `apps/app/src/routes/overview.tsx` with anchored greeting + `Hôm nay cần bạn` + compact inline Vy prompt bar (`member-vy` + `AiMeter` + AI-off fallback), canonical role-and-module-filtered app summary blocks, single-line quiet empty collapses, removal of old top-of-Home action clutter into Top Bar `+`, and `Tùy chỉnh` visibility/reorder (drag + Move Up/Move Down + Reset to role defaults) backed by `kernel.member.home_layout.get`/`save`; update `overview-page.test.tsx` & `overview.test.ts`. |
| **Phase 5** | **Cross-Viewport, Theme, Accessibility & Playwright E2E Verification** | Verify `360px`, `768px`, `1280px`, `1920px` layouts, light/dark `theme-runtime.ts` parity, full keyboard journeys (`⌘K`, `[`, `J`/`K`, Move Up/Down, `Esc` focus return, Skip to content), `axe` WCAG 2.2 AA compliance, zero horizontal scroll, and Playwright E2E assertions covering 0px rail icon vertical shift across routes, Top Bar utility consistency, 2-column Notifications triage, and persisted Home customization across reloads/viewports. |

---

## 7. Non-Goals and Deferred Items

- User-customizable left sidebar app ordering or pinned shortcuts (explicitly deferred per [scope.md](../product/scope.md) and [ui-ux-review-2026-11-23.md](./ui-ux-review-2026-11-23.md)).
- Custom KPI formula widgets, freeform multi-column grid canvases, or cross-org agency dashboards.
- Replacing per-app primary work queues (`Chứng từ > Chờ duyệt`, `Engage > Hội thoại`) with Home approval shortcuts that bypass deterministic check inspection.
