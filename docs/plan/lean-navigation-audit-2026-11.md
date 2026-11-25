# Lean navigation audit for OPC and SME (2026-11-25)

Status: owner decisions recorded in section 9 (2026-11-25); the proposals below are approved. Docs only: no code, no issue, no feature removed. Every "Later" and "Merge" below changes where an entry is shown, never whether it exists, and each routes through `docs/product/scope.md` (gate 1, fit: a task a small business does at least monthly). Anything that removes a feature or changes a written decision is listed as a question in section 7, not decided here.

## Tóm tắt cho chủ sở hữu (JOY)

- Hoàn thành: đã đếm menu thật trên `main`. Chủ doanh nghiệp bật đủ 6 ứng dụng thấy 9 mục ở thanh trái, 39 mục trong menu các ứng dụng (Tài chính 12, Engage 9, Nhân sự 6, Cộng tác 5, eSign 4, Ludy AI 3) và 11 trang Cài đặt. QuickBooks của anh chia 12 ứng dụng nhỏ; Ludy ít ứng dụng hơn nhưng Tài chính dài 12 mục xếp phẳng, nên vấn đề của mình là danh sách dài, không phải tách quá nhỏ.
- Đề xuất gọn: mỗi ứng dụng tối đa khoảng 5 mục (Tài chính 6 vì có thêm Tổng quan). Gộp các mục cùng một việc thành thẻ (tab): ví dụ Phiếu thu chi vào Chứng từ, Khách hàng và Nhắc thu nợ vào "Bán hàng", Nhà cung cấp và khoản chi vào "Mua hàng". Việc ít dùng (Hàng hóa, Sổ sách, Tuyển dụng, Quảng cáo, Lịch hẹn, Báo cáo Engage) vào nhóm "Thêm" cuối menu; vẫn tìm được bằng Ctrl K, địa chỉ cũ không đổi.
- Việc đếm click của SME: tải hóa đơn mua 3 click để bắt đầu; ra hóa đơn bán 4 click để có bản nháp; khai thuế GTGT 3 click; trả nhà cung cấp tệ nhất, khoảng 9 click qua 3 màn hình (Xin chi, duyệt trong Chứng từ, quay lại tải file chuyển khoản). Trang chủ chưa có nút tạo nhanh nào.
- Không sao chép của QuickBooks: Mileage, 1099s, Contractors (thuế Mỹ), Lending, Sales channels, Integration transactions, Payouts, Bill payments (Ludy không giữ hay chuyển tiền), "All apps" và nhãn nâng cấp (đã để Icebox).
- Mười một đề xuất việc tiếp theo, chỉ đổi giao diện, không xóa tính năng và không đổi dữ liệu. Chưa tạo issue; PO sẽ mở sau khi anh đồng ý. Có 5 câu cần anh quyết (mục 7), quan trọng nhất: ADR-0053 đang bật mọi ứng dụng cho tổ chức mới, có nên bật sẵn chỉ Tài chính, Cộng tác và AI cho một người một công ty (OPC) không.
- Đã quyết (2026-11-25, mục 9): duyệt toàn bộ đề xuất gọn; tổ chức mới chọn kiểu khi tạo ("Một mình tôi" hoặc "Có nhân viên"); Sổ sách, Tuyển dụng, Hàng hóa, Lịch hẹn, Quảng cáo vào "Thêm".
- Hạn chế: số click là đếm theo mã nguồn (đường đi ngắn nhất từ Trang chủ), chưa đo trên người dùng thật; phần duyệt đề xuất ghi là ước lượng.

## 1. What a signed-in owner sees today

Source: `packages/kernel-contract/src/screens.ts` (menu declarations), `apps/app/src/lib/apps.ts` (group order, tab groups, role filter), `apps/app/src/router.tsx`, `apps/app/src/routes/settings/*`. Owner, every module on. Counted from `main` at a3f8e0466.

**Every module starts on for every new org** (ADR-0053, `apps/app/src/components/org-apps.tsx`: "Every module starts on with no setup"). So a one-person company on day 1 sees everything below until it finds Settings > Ứng dụng and switches apps off.

| Place | Entries | What they are |
|---|---|---|
| Rail (always) | 9 | Tổng quan, 6 apps (Cộng tác, Tài chính, Engage, Nhân sự, eSign, Ludy AI), the bell, Settings. The shell also has the Ctrl K palette and the account popover. |
| Cộng tác | 5 | Việc của tôi, Việc nhóm, Dự án, Ghi chú, Cuộc họp (one group, no headings) |
| Tài chính | 12 | Group 1: Tổng quan tài chính, Chứng từ, Phiếu thu chi, Sao kê ngân hàng. Bán hàng: Hóa đơn bán ra, Khách hàng, Hàng hóa. Mua hàng: Nhà cung cấp. Sổ sách & Thuế: Bút toán, Sổ sách, Tài sản, Thuế |
| Engage | 9 | Hộp thư: Hội thoại. CRM: Người liên hệ, Công ty, Cơ hội, Lịch hẹn. Marketing: "Engage" (the posts), Cập nhật bài đăng, Quảng cáo. Báo cáo |
| Nhân sự | 6 | Nhân viên, Chấm công, Tuyển dụng, Bảng lương, Bảng kê khai báo, Cổng nhân viên |
| eSign | 4 | Hồ sơ ký, Mẫu tài liệu, Xác minh tệp, Chữ ký số & con dấu |
| Ludy AI | 3 | Đội ngũ AI, Ngân sách AI, Kết nối AI |
| **App menus together** | **39** | |
| Settings | 11 pages | Tổ chức, Thành viên và quyền, Ứng dụng, Lịch hẹn, Bán hàng, Báo giá, Kế toán và thuế, Kết nối, Thông báo của tôi, Bảo mật tài khoản, Dữ liệu và xóa tổ chức |

Roles: a member who is not owner or admin sees no Nhân sự except Cổng nhân viên, and no Ngân sách AI (`isShellItemHidden`). So 39 is the owner's number.

Already inside tabs (so not in the 39): Chứng từ (Chờ duyệt, Tất cả chứng từ), Khách hàng (+ Nhắc thu nợ), Hàng hóa (Tồn kho, Sàn), Thuế (Tờ khai GTGT, Đối chiếu cổng thuế), Bảng lương (+ Mẫu file lương), Quảng cáo (Số liệu, Chiến dịch). Reached only by a link inside another screen: Hộ kinh doanh, the quick guide, opening balances, matched bank lines, social channels, import, snippets, labels, ideas, feeds and bio.

How it compares with the screenshots the owner sent: QuickBooks Online shows 4 apps with 26 entries (Accounting 8, Expenses & Pay Bills 8, Sales & Get Paid 7, Customer Hub 3) plus 8 more apps (Team, Business Tax, Lending, Marketing, Payroll, Time, Inventory, Sales Tax) behind an "All apps" launcher. QuickBooks splits into many small apps with 3 to 8 entries each. Ludy has 6 apps, but Tài chính alone is a flat list of 12. The shell rule in DESIGN.md 3.8 says an app menu fits a 1366x768 laptop without scrolling; that holds today, but it says nothing about how many choices a person weighs.

## 2. Clicks for the monthly jobs of a Vietnamese SME

Method: from the org Home with every app on, the shortest path in the code today. A click is a click or tap on a link or button; typing and the file picker are not counted. Opening an app from the rail lands on its first item (`installedApps().home`). Approval counts are estimates from the Chứng từ flow, not measured. Home has no create action yet (UI/UX P2-2, #4783), so every job starts with the rail.

| Job | Path today | Clicks |
|---|---|---|
| Record a purchase invoice | Tài chính, Chứng từ, Tải lên (file picker), open the proposal, Duyệt | 3 to start, about 5 done |
| Issue a sales invoice | Tài chính, Hóa đơn bán ra, Tạo bản nháp, fill the form, Lưu. Issuing is a separate request that an approver confirms in Chứng từ (`EInvoiceIssueCard`) | 4 for the draft, about 7 issued |
| Collect money | Tài chính, Sao kê ngân hàng, import the statement (picker); matched lines come back as proposals in Chờ duyệt. Chasing a late customer: Tài chính, Khách hàng, tab Nhắc thu nợ | 3 to import, about 5 matched; chase 3 |
| Pay a supplier | Tài chính, Nhà cung cấp, "Xin chi" on the invoice, confirm; another person approves in Chứng từ; back to Nhà cung cấp, "Khoản chi đã duyệt chờ chuyển khoản", pick, download the bank file | about 9 over 3 screens |
| File or check VAT | Tài chính, Thuế (opens on Tờ khai GTGT), export or mark filed | 3 |
| Pay staff (Nhân sự on) | Nhân sự (lands on Nhân viên), Bảng lương, then the run inside the screen | 2 to reach |
| Sign a contract (eSign on) | eSign (lands on Hồ sơ ký), Tạo hồ sơ, then the dialog | 2 to reach |

Findings:

1. The entry is always "app, then entry": the app rail is not the cost, the 12-item Tài chính list is where a person hesitates (Chứng từ, Phiếu thu chi, Sao kê and Hóa đơn bán ra are all "documents of money").
2. Paying a supplier is the longest job and crosses three screens. It is a flow problem as much as a menu problem; the menu part is a Home create action ("Trả nhà cung cấp") that opens the panel directly.
3. The first Finance menu entry is a read-only overview, so "open the app" costs a click that does no job. A Home create-action row (P2-2) removes that click for the five jobs above.
4. One item is named like its app: Engage's posts item is labelled "Engage" (`nav.social`). A person sees "Engage > Engage". The key `nav.socialPosts` ("Bài đăng") already exists.

## 3. Per app: Core, Later, Merge

Legend. **Core**: an OPC or SME does it at least monthly. **Later**: real, but not needed now: move behind a "Thêm" group at the foot of the menu (still reachable by Ctrl K and by its address) or into Settings, or leave unbuilt. **Merge**: fold into another entry as a tab, using the existing tab strip (`TAB_GROUPS` in `lib/apps.ts`). Nothing is deleted; addresses keep working.

### Tài chính (12 entries today, target 6 plus "Thêm")

| Entry today | Class | Reason and target |
|---|---|---|
| Tổng quan tài chính | Core | Keep as the landing. |
| Chứng từ (Chờ duyệt, Tất cả chứng từ) | Core | Purchase invoices and every AI proposal; the one review queue. Gains a third tab, Phiếu thu chi. |
| Phiếu thu chi | Merge | A voucher is a kind of chứng từ. Third tab of Chứng từ. |
| Sao kê ngân hàng | Core | Collecting and paying both end in a matched bank line. Rename "Ngân hàng". |
| Hóa đơn bán ra | Core | Issuing sales invoices. Becomes the first tab of "Bán hàng". |
| Khách hàng (+ Nhắc thu nợ) | Merge | Who owes me. Tabs of "Bán hàng": Hóa đơn bán ra, Khách hàng, Nhắc thu nợ. |
| Nhà cung cấp (+ Hóa đơn cần chi, khoản chi chờ chuyển khoản) | Merge | Whom I pay. Becomes "Mua hàng" (one entry today under a heading; the heading goes). |
| Thuế | Core | VAT every month or quarter. Keep as is. |
| Hàng hóa (Tồn kho, Sàn) | Later | Only goods traders and marketplace sellers; an OPC of services never opens it. "Thêm". |
| Bút toán, Sổ sách, Tài sản | Later (Merge) | The bookkeeper's tools; many SMEs keep books in MISA and use Ludy's MISA export. One entry "Sổ sách" with three tabs, in "Thêm". Owner question Q2. |

Target menu: Tổng quan, Chứng từ, Bán hàng, Mua hàng, Ngân hàng, Thuế; then Thêm: Hàng hóa, Sổ sách. Six entries, one over "about 5" because the landing overview counts; the other five are the five money jobs.

### Cộng tác (5 entries, target 4)

| Entry today | Class | Reason and target |
|---|---|---|
| Việc của tôi | Merge | The task list already has a "mine" filter (`tasks.tsx`). Two lists of tasks confuse a one-person company. Tab "Của tôi" of "Việc". |
| Việc nhóm | Core | Becomes "Việc" (tabs Của tôi, Cả nhóm). |
| Dự án | Core | SMEs with client work; board and roadmap exist. Keep. |
| Ghi chú | Core | Notes. Keep. |
| Cuộc họp | Core | The AI meeting notes line; keep. |

### Engage (9 entries, target 4 plus "Thêm")

| Entry today | Class | Reason and target |
|---|---|---|
| Hội thoại | Core | Comments and private messages in one inbox. |
| Người liên hệ, Công ty | Merge | Same parties, two kinds (screens.ts: "the same parties, the kind organization"). One "Liên hệ" with tabs Người, Công ty. |
| Cơ hội | Core | The sales pipeline. |
| "Engage" (posts) and Cập nhật bài đăng | Merge | Rename "Bài đăng"; the updates become a tab (the manifest comment already says "a tab of Bài đăng, not an item"). |
| Lịch hẹn | Later | Core only for appointment businesses; setup is already in Settings. "Thêm". Owner question Q5. |
| Quảng cáo | Later | Boosting a post is occasional; keep reachable from a post and in "Thêm". |
| Báo cáo | Later | A look-back, not a task; "Thêm". |

### Nhân sự (6 entries, target 3 plus "Thêm")

| Entry today | Class | Reason and target |
|---|---|---|
| Nhân viên | Core | The people payroll runs for. |
| Chấm công | Core | Monthly input for hourly staff. |
| Bảng lương | Core | Monthly payroll. Absorbs the next row. |
| Bảng kê khai báo | Merge | Declarations follow payroll; tab of Bảng lương (Mẫu file lương is already one). |
| Tuyển dụng | Later | Hiring is occasional, below the monthly bar of gate 1. "Thêm". Owner question Q3. |
| Cổng nhân viên | Core (staff) | The only entry for a non-manager; for an owner it stays last. No change. |

### eSign (4 entries, target 1 plus "Thêm")

| Entry today | Class | Reason and target |
|---|---|---|
| Hồ sơ ký | Core | The app. With one entry the app needs no sub-menu. |
| Mẫu tài liệu | Merge | Templates feed the same list: a tab of Hồ sơ ký. |
| Xác minh tệp | Later | Verifying a file someone else signed; rare. A button in Hồ sơ ký or "Thêm". |
| Chữ ký số & con dấu | Later | One-time setup. Move to Settings. |

### Ludy AI (3 entries, target 1)

| Entry today | Class | Reason and target |
|---|---|---|
| Đội ngũ AI | Core | What each coworker did and will do. |
| Ngân sách AI | Merge | The monthly check of AI spend is a tab of Đội ngũ AI (owner and admin only, as today). |
| Kết nối AI | Later | External AI tools (MCP): a setup task. Settings > Kết nối already holds integrations. |

### Settings (11 pages, target 8)

| Page today | Class | Reason and target |
|---|---|---|
| Tổ chức, Thành viên và quyền, Ứng dụng, Kế toán và thuế, Kết nối | Core | Keep. "Ứng dụng" is where the Later apps are switched on and off. |
| Lịch hẹn, Bán hàng, Báo giá | Merge | Three small Engage pages become one "Bán hàng". Caution: they were split on purpose to keep each page under 1200 px (`settings/tabs.ts`, `e2e/tests/settings-tabs.spec.ts`), so the merge needs collapsible sections, not one long column. |
| Thông báo của tôi, Bảo mật tài khoản | Merge | Personal settings: one "Tài khoản của tôi". |
| Dữ liệu và xóa tổ chức | Later | Rare and dangerous; keep last. |

## 4. Target menus at a glance

| App | Today | Target (visible) | Behind "Thêm" or Settings |
|---|---|---|---|
| Rail | 9 | 9 (no launcher before about 8 apps, benchmark L5) | none |
| Tài chính | 12 | 6: Tổng quan, Chứng từ, Bán hàng, Mua hàng, Ngân hàng, Thuế | Hàng hóa, Sổ sách |
| Cộng tác | 5 | 4: Việc, Dự án, Ghi chú, Cuộc họp | none |
| Engage | 9 | 4: Hội thoại, Liên hệ, Cơ hội, Bài đăng | Lịch hẹn, Quảng cáo, Báo cáo |
| Nhân sự | 6 | 4: Nhân viên, Chấm công, Bảng lương, Cổng nhân viên | Tuyển dụng |
| eSign | 4 | 1: Hồ sơ ký | Xác minh tệp (Settings: Chữ ký số & con dấu) |
| Ludy AI | 3 | 1: Đội ngũ AI | none (Kết nối AI to Settings) |
| **Total** | **39** | **20** | 7 |

Settings 11 pages to 8. An owner with every app on goes from 48 clickable places (9 + 39) to 29 (9 + 20), plus 7 behind "Thêm".

### Jobs-first create actions (for #4783)

The fixed row above the Home queue names the job, not the screen. Five for Tài chính, two more appear only when the app is on:

1. Tải hóa đơn mua (opens Chứng từ with the picker)
2. Tạo hóa đơn bán (opens Hóa đơn bán ra with a new draft)
3. Nhập sao kê ngân hàng (Ngân hàng)
4. Trả nhà cung cấp (Mua hàng, the "Hóa đơn cần chi" panel)
5. Khai thuế GTGT (Thuế)
6. Chạy lương (Nhân sự on)
7. Gửi ký hợp đồng (eSign on)

On a phone the same row shows the first four (P2-3, #4784). On desktop Home shows the first five that apply; an action of an app that is off is never shown. The AI part named per scope gate 3: each action opens a screen where the coworker has already read, sorted or drafted (Chứng từ reading, bank matching, the VAT check); a person still approves money, messages and spend.

## 5. QuickBooks items we deliberately do not copy

| QuickBooks item | Why not (for an OPC or SME in Vietnam) |
|---|---|
| Mileage | A US tax deduction flow; no Vietnamese equivalent small businesses claim monthly. |
| 1099s | US tax form for contractors. The Vietnamese counterparts (personal income tax on payments to individuals) belong to payroll and its declarations, not to a menu of their own. |
| Contractors | Same: people paid outside payroll are an employee or vendor record in Ludy. |
| Lending | Intuit sells credit; Ludy has no lending partner and no plan for one. |
| Sales channels | A connector list. Ludy's marketplace money is the "Sàn" tab of Hàng hóa, in "Thêm". |
| Integration transactions | A second feed for connected apps. Ludy has one queue, Chứng từ > Chờ duyệt; a second feed splits the review habit. |
| Payouts, Bill payments | QuickBooks moves money. Ludy does not hold or move money ("Ludy không chuyển tiền"): payment is a bank file plus a matched statement line. |
| Payment links | Needs a payment provider; not in the plan. Revisit only if the owner opens it. |
| Receipts | A separate page in QuickBooks; in Ludy a photo or file goes to the same Tải lên of Chứng từ. |
| Rules | Menu item in QuickBooks; in Ludy the rules live in Settings > Kế toán và thuế and are learned from corrections. Keep there. |
| My accountant, Intuit Experts | A marketplace and an invite flow. Ludy: invite the accountant as a member (Settings > Thành viên và quyền). |
| Customer Hub (Overview, Customers, Estimates) | Covered by Engage: Liên hệ, Cơ hội and the quotes of a deal. |
| Team, Business Tax, Marketing, Payroll, Time, Inventory, Sales Tax (with the diamond badge) | Upgrade badges and user-pinned apps are in the Icebox (owner, 2026-11-25). Ludy's rule stays: an app shows only when its module runs. |
| "All apps" launcher, pinned apps, Customize | Six apps need a rail, not a launcher (benchmark L5). |

What we do copy: job-named areas ("Sales & Get Paid", "Expenses & Bills" become the tabs of Bán hàng and Mua hàng), a Create row on Home, one review queue.

## 6. Follow-up issues to propose

All are UI-only: they move, rename or tab existing screens. None removes a feature, changes data or a command, or changes a route address (old addresses keep opening). Filed by the PO after the owner agrees; none exists yet. "Touches" names the UI/UX wave P2 issue whose files or copy it overlaps, so the two are sequenced rather than merged blind.

| # | Proposed issue | Touches |
|---|---|---|
| F1 | Shell: a "Thêm" group at the foot of an app menu (a `more` flag on a menu item in `screens.ts`/`apps.ts`; items stay in Ctrl K and keep their addresses). Prerequisite for F2, F5, F6, F7. | none (shell, adjacent to #4499) |
| F2 | Finance menu from 12 to 6 plus "Thêm": tab groups Bán hàng (Hóa đơn bán ra, Khách hàng, Nhắc thu nợ) and Mua hàng (Nhà cung cấp and its payment panels), rename Ngân hàng, "Sổ sách" tab group (Bút toán, Sổ sách, Tài sản). Update `NAV_KEYWORDS` so Ctrl K finds each moved tab. | #4783 (create-action targets), #4785 (the tiles open Bán hàng and Mua hàng) |
| F3 | Phiếu thu chi becomes the third tab of Chứng từ. | #4784 (PhoneActionBar on `documents.tsx`), #4782 |
| F4 | Cộng tác: merge Việc của tôi into "Việc" as a tab. | #4782 (`my-work` Vy planner panel) |
| F5 | Engage: one "Liên hệ" (Người, Công ty), rename the posts item "Bài đăng" with "Cập nhật bài đăng" as its tab, Lịch hẹn, Quảng cáo, Báo cáo to "Thêm". | #4782 (`engage-proposal-card`), light |
| F6 | Nhân sự: Bảng kê khai báo into Bảng lương as a tab, Tuyển dụng to "Thêm". | #4784 (HR approval rows) |
| F7 | eSign: Mẫu tài liệu as a tab of Hồ sơ ký, Xác minh tệp a button there, Chữ ký số & con dấu into Settings. | #4784 (`sign-envelopes.tsx`) |
| F8 | Ludy AI: Ngân sách AI as a tab of Đội ngũ AI, Kết nối AI into Settings > Kết nối. | none |
| F9 | Settings from 11 to 8 pages (Bán hàng merges three, Tài khoản của tôi merges two), with collapsible sections so each page stays under 1200 px; update `e2e/tests/settings-tabs.spec.ts`. | none |
| F10 | Home create-action row names and targets from section 4 (text and routes only; the row itself is #4783). Includes "Trả nhà cung cấp" opening the payable panel directly. | #4783, #4784 |
| F11 | A guard test for menu size (`apps/app/test/module-screens.test.ts`): at most 6 visible items per app, so the menu does not grow back one feature at a time. | none |

Suggested order: F1, then F2 and F3 (largest win, Tài chính), F5, then the small ones. F10 rides with #4783 so the wording is set once.

## 7. Questions for the owner

Each changes a written decision or removes something from view for a kind of business, so none is decided here.

- Q1. ADR-0053 turns every module on for every new org. Should a new one-person company start with only Tài chính, Cộng tác and Ludy AI on (the owner switches the rest on in Settings > Ứng dụng)? Recommended: yes, as a day-1 choice; the 39-entry menu is the first thing a new OPC sees. Without an answer: nothing changes.
- Q2. Sổ sách (Bút toán, Sổ sách, Tài sản) in "Thêm": acceptable, or must it stay visible for the pilot accountant (#61), who uses it daily? Recommended: "Thêm" for owners, visible when the signed-in person is a bookkeeper member (needs a role signal that does not exist yet, so start with "Thêm" for all).
- Q3. Tuyển dụng (recruiting) fails the monthly bar of gate 1. Move to "Thêm" now (recommended), or send the feature to the Icebox? This audit only moves it.
- Q4. Hàng hóa (stock and marketplace): "Thêm" for everyone (recommended), or visible only for an org that already has stock items (data-driven, less predictable)?
- Q5. Lịch hẹn and Quảng cáo for service businesses (spa, clinic, salon): which segment is the pilot? If appointments are a weekly job for it, Lịch hẹn stays visible in Engage.

## 8. What this does not cover

- No measurement with real users; counts come from the code (section 2). The pilot partners' own order of work may differ.
- Phone drawer layout (P2-3) and the Home money tiles (#4785) are other issues; this audit only keeps their links consistent.
- The benchmark this builds on is `docs/research/smb-suite-navigation-benchmark-2026-11.md` ([PR #4780](https://github.com/DOS/Ludy/pull/4780), not on `main` when this was written); QuickBooks entries come from the owner's screenshots of 2026-11-25.

## 9. Owner decisions (2026-11-25)

JOY answered the section 7 questions in the PO chat on 2026-11-25. Quoted as given:

- Proposals: "Duyệt các đề xuất gọn (Khuyên dùng)". All UI-only lean proposals (F1 to F11) are approved.
- Q1: "Có, chọn kiểu khi tạo (Khuyên dùng)". A new org picks a type at creation: "Một mình tôi" turns on only Tài chính, Cộng tác and Ludy AI; "Có nhân viên" also turns on Nhân sự, eSign and Engage. ADR-0053 is amended for this (one platform issue; today every module starts on).
- Q2: "Vào 'Thêm', hiện cho kế toán sau (Khuyên dùng)". Sổ sách goes to "Thêm" for everyone now; showing it by default to a bookkeeper role is a later P3 issue in the Icebox.
- Q3 and Q4 follow the recommendations: Tuyển dụng (Nhân sự) and Hàng hóa (Tài chính) go into "Thêm" for everyone.
- Q5: pilot segment "Thương mại, dịch vụ chung". Lịch hẹn and Quảng cáo (Engage) go into "Thêm".

Effect on the follow-ups of section 6: F2 to F9 are as written, and "Thêm" (F1) is their prerequisite. The org-type choice is one new platform issue, not a UI-only one: it changes which modules an org starts with, so it carries the ADR-0053 amendment. Its approach is settled in that issue (ADR-0053 says the tenant guard trigger lets an insert through only with the defaults, so the creation path may need a migration there). Nothing is removed and no existing org's data changes.

Issues filed (milestone M3 Paid pilot, P2 unless noted): F1 [#4790](https://github.com/DOS/Ludy/issues/4790), F2 [#4792](https://github.com/DOS/Ludy/issues/4792), F3 [#4793](https://github.com/DOS/Ludy/issues/4793), F4 [#4794](https://github.com/DOS/Ludy/issues/4794), F5 [#4795](https://github.com/DOS/Ludy/issues/4795), F6 [#4796](https://github.com/DOS/Ludy/issues/4796), F7 [#4797](https://github.com/DOS/Ludy/issues/4797), F8 [#4798](https://github.com/DOS/Ludy/issues/4798), F9 [#4799](https://github.com/DOS/Ludy/issues/4799), F10 [#4800](https://github.com/DOS/Ludy/issues/4800), F11 [#4801](https://github.com/DOS/Ludy/issues/4801); org type at creation and the ADR-0053 amendment [#4802](https://github.com/DOS/Ludy/issues/4802) (platform line); Sổ sách by default for a bookkeeper role [#4803](https://github.com/DOS/Ludy/issues/4803) (P3, Icebox).
