# Feature comparison: Ludy against MISA, Fast and Odoo

Status: research only, 2026-11-06, at the owner's request (JOY, approved 2026-11-06). No code and no roadmap commitment. The Vietnamese summary for the owner is [competitor-feature-comparison.vi.md](competitor-feature-comparison.vi.md); this English file is the canonical one. It goes deeper on accounting than the market map in [competitors.md](../product/competitors.md) (written 2026-11-04, six products) and does not repeat that page's CRM, marketing and Pancake rows. The AI side of MISA and others is in [ai-first-reference-study.md](ai-first-reference-study.md); this page reuses its findings only where they still hold and adds fresh official pages.

## 1. How to read this page

**Ludy's column comes only from the repository** at commit `b473ad3` (the head of `main` on 2026-11-06, PR #2664): code, routes, i18n messages, merged PRs, `docs/plan/*.md` and ADRs. Marketing copy is never used as evidence. Each `Yes` names the file or PR that shows it. `In progress` names the open issue.

**The competitors' columns come only from their official sites and docs**, read on 2026-11-06. Each fact carries a source id (`M` for MISA, `F` for Fast, `O` for Odoo); the sources are listed in section 6 with URL and the date read. A fact that no official page confirmed is `Unverified`. Where a source is a third-party page it is marked SECONDARY and is never the only support for a `Yes`. Text is paraphrased.

Cell values:

| Value | Meaning |
|---|---|
| **Yes** | Confirmed by the evidence rule above. A note says where it is limited. |
| **No** | The evidence rule shows it is absent (Ludy: no code and no plan issue; competitors: the official pages say so or the product is sold separately, which is then `Paid add-on`). |
| **In progress #n** | Ludy only. An open issue exists; read the note for what already runs. |
| **Paid add-on** | Sold at an extra price on top of the base product, or as a separate product of the same vendor. |
| **Unverified** | No official page read on 2026-11-06 settled it. |

Three limits to keep in mind. First, the pages were read through a fetch tool that returns a summary, so a source id is a pointer: re-open the page before quoting a figure. Second, several MISA pages disagree with each other, and the conflict is shown, not resolved. Third, Odoo's docs rarely say which edition a feature belongs to; "Enterprise (inferred)" means the feature sits in the Accounting app and its module is absent from the public Community repo, which is an inference, not a sentence on an Odoo page. Details are in section 5.

## 2. What matters most (read this first)

1. **Ludy cannot yet issue a real e-invoice or read a live bank feed.** The code for both is built, but the only providers in the repository are offline sandboxes, and a public deployment refuses to enable them. MISA, Fast and Odoo (Viettel only) all issue e-invoices today. This is the largest gap for a working accountant.
2. **Ludy is the only one of the four that is open source and self-hostable with its whole accounting app.** MISA is cloud or desktop only [M22, M23]. Fast has no open-source offer, and its desktop and ERP can be installed by the customer [F3, F22]. Odoo Community is open, but the Accounting app, bank sync, assets, follow-ups, payroll and AI are not in the public Community repo (Enterprise, inferred) [O23].
3. **Ludy's approval model is stricter than what MISA describes.** Every AI output is tainted, deterministic checks decide, and a person approves anything that posts money, sends a message or spends. MISA describes automatic posting of received invoices with no review step [M26]. Fast's AI in FAO is a how-to helper only [F14].
4. **TT133 is where Odoo is weakest and Ludy is shipped but unverified.** Odoo's official package follows Circular 200, now moved to the Circular 99 chart; no official TT133 [O3, O10]. Ludy's TT133 statements exist but carry a draft banner until an accountant signs off (#154).
5. **Payroll, social insurance, PIT and HR: MISA has them, Fast sells them separately, Odoo has no Vietnam payroll, Ludy is building them** as a separate app (calculator merged, everything else open).
6. **HTKK:** every product's claim is thin. Ludy exports an unverified 01/GTGT draft (#332). MISA's own help page names only the tax portal [M17]. Odoo has the 01/GTGT XML only from 19.4 and 20 [O28, O32].
7. **Price:** Ludy self-hosted costs no licence; no Ludy Cloud price exists yet. A small business pays MISA about 2.5 to 3.7 million VND a year for AMIS Kế toán Starter before e-invoices, payroll and CRM, Fast about 1.75 million VND a year per user for FAO, and Odoo US$9 to US$20 per user per month for Enterprise.

## 3. The comparison

Legend for notes: `path` is a repository file, `#n` an issue or PR in DOS/Ludy, `[M n]`, `[F n]`, `[O n]` a source from section 6.

### 3.1 Documents and invoices

| Row | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| **1a. Invoices in: XML** | **Yes.** Deterministic parser with seller and tax-authority signature checks, no model; the result is a proposal a person approves. `apps/extract/src/einvoice-xml.ts`, `einvoice-signature.ts` (#674) | **Unverified.** A help article on uploading an XML is listed but its body was not read [M29] | **Paid add-on.** "Input invoice management" in FAO imports the original XML [F12, F10] | **Unverified.** Vietnam docs cover only sending to SInvoice; the generic email alias accepts XML attachments [O1, O4, O15] |
| **1b. Invoices in: PDF and photo** | **Yes, with limits.** Text PDFs and photos are read by the model the operator configures (any OpenAI-compatible endpoint); no OCR engine of its own; scanned PDFs are refused; numbers are re-checked by rules. `modules/finance/src/extract.ts`, `packages/agent/src/index.ts` | **Unverified.** Only manual typing of a PDF or photo is confirmed [M29]; the meInvoice home page markets "AI" without naming OCR [M7] | **Unverified.** OCR appears only in the AI list of Fast Business Online [F25] | **Paid add-on.** Enterprise (inferred). Paid in-app credits, one per document, no price per credit published [O15, O2] |
| **1c. Invoices in: mailbox** | **Yes, with setup.** Each organisation has a private address; forwarded mail with XML, PDF, image or ZIP goes the same path. Needs an inbound mail relay; no IMAP pull. `apps/kernel/src/inbound.ts` | **Paid add-on.** Pulls from the meInvoice mailbox once that service is bought [M6] | **Paid add-on.** Pulls XML and PDF attachments from a set mailbox [F12, F10] | **Yes.** Generic email alias per journal; edition not stated [O15, O16] |
| **1d. Invoices in: tax-portal sync** | **Yes, with limits.** Assisted: a person types the portal password and solves the CAPTCHA; off by default (`TAX_PORTAL_SYNC=false`); never run against the real portal by the builders; the first supervised run is open (#1100). Importing the portal's exported list works. ADR-0036, `modules/finance/src/portal-sync.ts` | **Paid add-on.** Connecting meInvoice to the tax department syncs received invoices [M6, M28] | **Paid add-on.** Retrieves invoices from the tax authority's system [F12] | **Unverified.** No official page or module describes it [O1, O4] |
| **2. Sales e-invoices out** | **In progress #2503, #2509.** Draft, approve, issue, poll, store the signed XML and post the sale are built (#2502), but the only provider is an offline sandbox that a public deployment refuses. MISA meInvoice adapter #2503, Viettel S-Invoice adapter #2509, adjust and replace #2504. `packages/einvoice/src/index.ts`, `apps/kernel/src/config.ts` | **Paid add-on.** meInvoice, sold in packs of invoices; connects free to AMIS Kế toán; issued invoices create sales vouchers [M3, M7, M27] | **Paid add-on.** Fast e-Invoice is the vendor's own product, priced by pack; integration with Fast software is free [F8, F18]. Whether VNPT or Viettel are supported: Unverified | **Yes.** Viettel S-Invoice only (official module, LGPL-3). Other providers only through paid third-party modules, which are not part of Odoo [O1, O4, O54] |

### 3.2 Bank, receivables

| Row | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| **3a. Bank statement files** | **Yes.** Excel and CSV, columns found by header detection so any bank's export works; by upload or by email. No MT940 or OFX. `packages/l10n-vn/src/bank-statement-sheet.ts`, `modules/finance/src/bank-statement-file.ts` | **Yes.** Release R97 posts from a statement file the user supplies [M10] | **Yes.** Excel template only [F15] | **Unverified.** Edition not stated. Formats listed: CAMT.053, CSV, XLSX, OFX, QIF, CODA [O19] |
| **3b. Live bank feeds** | **In progress #2045.** The port, account mapping, signed webhook route and an offline sandbox are built (#2044); the Tingee adapter is open and no real bank is connected. `packages/bank-feed/src/index.ts` | **Yes.** 11 banks give balance, history and transfer orders; about 11 more send balance alerts only; fees not stated [M20] | **Paid add-on.** OCB, BIDV, TPBank, MBBank, each sold per user per term [F15, F10] | **Yes.** Enterprise only. Aggregators such as Plaid, Yodlee and Salt Edge; Vietnamese banks are not mentioned, so coverage is Unverified [O18] |
| **3c. Reconciliation** | **Yes.** Rule-based ranking of party candidates for each line; clean lines are grouped and a person approves the vouchers of a group in one step; matches can be undone by reversal. Not AI. `modules/finance/src/domain/bank-match.ts`, `bank-groups.ts` (#2385, #2402) | **Yes.** Statement against ledger is automatic, and the AVA assistant also reconciles [M9, M24] | **Yes.** Imported lines are matched to vouchers automatically [F15] | **Yes.** Enterprise (inferred). Matching models and auto-reconcile sit in the Accounting app [O14, O19] |
| **4. Receivables and payment reminders** | **Yes.** Overdue list from the books with notice levels at day 1, 15 and 30; the mail is drafted from templates, the AI words only the opening and closing, and a person presses send. No automatic sending, no SMS or Zalo. `modules/finance/src/payment-reminders.ts`, `payment-reminder-mail.ts` (#2492, #2494) | **Yes.** Automatic reminder emails after the due date (default 7, 14, 21 days). Plan gate unclear: the same help page names two [M16] | **Unverified.** Receivable ageing is in FA and FAO. AI reminder drafts exist in Fast Business Online (a separate ERP), with no stated approval step [F26] | **Yes.** Enterprise (inferred). Follow-up levels by email, WhatsApp, SMS or letter; the last three use paid credits [O37] |

### 3.3 Tax, statements, ledger

| Row | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| **5a. VAT filing, HTKK export** | **Yes, draft.** HTKK XML for form 01/GTGT only (Circular 80/2021 layout); judgment fields are left at zero; not checked in HTKK or eTax by an accountant (#332 open); Ludy does not file. `modules/finance/src/domain/vat-01gtgt-xml.ts` | **Unverified** for HTKK. The help page exports XML for the tax portal [M17]; a MISA blog says "supports HTKK" [M19] | **Yes.** The FAO page says it connects with HTKK; this is the vendor's claim, and the FA tax page does not name HTKK [F9, F6] | **Yes** from 19.4 and 20 only: the 01/GTGT XML for HTKK or the portal. The 19.0 stable branch has only the older report by rate [O28, O31, O32] |
| **5b. PIT** | **In progress #2533.** Quarterly and annual PIT data are in the payroll builds (#2533); the household worksheet 01/CNKD is #2518. A PIT calculator exists in `packages/l10n-vn/src/payroll/rules/pit.ts`; no filing | **Yes.** Settlement form 05/QTT-TNCN built from the payroll table; output via mTax, XML or HTKK import [M18] | **Yes** in Fast Accounting (a PIT module); FAO is Unverified [F7, F4] | **Unverified.** No PIT filing found in the Vietnam localization [O1, O20] |
| **6. Financial statements** | **TT133: Yes, draft.** B01-DNN and B02-DNN on screen and in Excel with a "draft" banner; HTKK XML for the year-end set; no cash flow statement. #154, #920 open. **TT99: In progress #1403** (chart of 184 accounts seeded; no postings or reports). **TT200: No.** `modules/finance/src/statements.ts`, `domain/tt133-reports.ts` | **TT99: Yes** from 2026-01-01; **TT200: Yes** for older data; **TT133: Yes** on MISA SME, Unverified for AMIS Kế toán [M12, M13, M21, M23] | **TT99: Yes. TT133: Yes.** TT200 is replaced by TT99 per Fast's FAQ [F9, F3, F32] | **TT99-based chart: Yes** (Circular 200 base moved to 99/2025 in January 2026). **TT133: No** official package; a paid third-party add-on offers it [O3, O10, O11, O52] |
| **7. Ledger basics** | **Yes.** Opening balances from Excel (#320), period lock by month with MFA to unlock (#329), fixed assets and prepaid allocation (#919), year-end closing (#889). `modules/finance/src/opening-balance.ts`, `period-lock.ts`, `fixed-assets.ts` | **Yes.** All four. Fixed assets start at the Professional plan, tools and prepaid from Standard [M1, M4, M11, M14, M37] | **Yes.** All four; a dedicated prepaid-expense workflow is not named [F29, F30, F31, F3] | **By part.** Lock dates: Yes. Fixed assets: Yes, Enterprise (inferred). Deferred expenses: Yes, edition Unverified. Opening balances: Unverified [O38, O39, O40] |

### 3.4 Stock and marketplaces

| Row | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| **8. Stock and marketplace orders** | **Yes, by file.** Items, stock moves from invoice lines, a stock card and a provisional "Nhập xuất tồn" report (#2512, #2513 part). Shopee, TikTok Shop and Lazada order reports are imported from files, staged and confirmed (#2515). **In progress #2519** live connection, **#2513** month close and cost of goods sold. `modules/finance/src/stock.ts`, `marketplace-orders.ts` | **Yes.** Warehouse from the Standard plan. Shopee and TikTok Shop connect directly; Lazada only through AMIS CRM [M14, M15, M9] | **Yes.** A module in FAO and Fast Business Online covers Shopee, TikTok and Lazada; price Unverified. Inventory is not in the FA Services edition [F13, F3] | **Yes.** Inventory is in Community. Official connectors for Lazada, Shopee and TikTok Shop; edition Unverified [O24, O33, O34, O35] |

### 3.5 People and sales

| Row | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| **9. Payroll, social insurance, PIT** | **In progress #2531.** Only a calculator and dated rule tables are merged (#2529); all 31 rule rows are unconfirmed by an accountant (#2535). Pay run #2531, posting and bank file #2532, exports #2533. A separate app (ADR-0046 addendum). `packages/l10n-vn/src/payroll/` | **Yes.** A basic payroll module from the Professional plan; the full AMIS Tiền lương app (social insurance and PIT filing) is a **Paid add-on**, 5.1 million VND a year [M32, M33] | **Paid add-on.** None in FA or FAO beyond a PIT module; payroll and social insurance are in the separate Fast HRM Online [F20] | **No** for Vietnam. Payroll is Enterprise (inferred) and Vietnam is absent from its localization list; a third-party paid module exists [O20, O53] |
| **10. HR** | **In progress #2530.** Employee records and leave (#2540) are planned inside the separate HR app; there is no `modules/hr` yet. `docs/adr/0046-payroll-for-small-teams.md` | **Paid add-on.** AMIS Nhân sự: records, recruitment, timekeeping, payroll; quote only [M35] | **Paid add-on.** Fast HRM Online, a separate product [F20] | **Yes.** Employees, Recruitment and Time Off are in the Community repo; Appraisals is Enterprise (inferred) [O24, O27] |
| **11. CRM and sales** | **Yes.** Contacts, companies, one pipeline board, deals, booking pages with Google Calendar, an inbox for Facebook, Instagram, Zalo and email. No quotes or sales orders. `modules/crm/src/deals.ts`, `docs/plan/crm.md` | **Paid add-on.** AMIS CRM, sold per 10 users a year [M34] | **Paid add-on.** Fast CRM Online is separate; order-to-cash accounting is inside FA and FAO [F23, F1] | **Yes.** CRM and Sales are in Community [O24, O58] |

### 3.6 Platform

| Row | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| **12. AI and approval** | **Yes.** All in `packages/agent`, every call metered per feature against an organisation budget, with a kill switch. Jobs today: invoice extraction, reminder wording, overview explanation, daily brief, CRM and inbox suggestions. AI output is tainted; a person approves anything that posts money, sends a message or spends. Coworkers: Vy, Ly. `packages/agent/src/meter.ts`, DESIGN.md 1.1 | **Yes.** AVA posts bank lines and received invoices and drafts emails. Bank postings go through a review step with a confidence level and batch approval; received-invoice posting describes no review step [M24, M25, M26] | **Yes, limited.** In FAO "Fast AI" answers how-to questions and changes no data. Fast Business Online has more (OCR, voucher drafts); a formal approval step is Unverified [F14, F25, F27] | **Paid add-on.** Enterprise (inferred), paid credits. Standard "Ask AI" cannot change records; agents can; Odoo 20 can ask permission with a button. No formal approval policy [O25, O26, O32, O2] |
| **13. Multi-entity** | **Yes, no consolidation.** Several legal entities in one organisation, each with its own books, series and locks. New work on it is in the Icebox (`docs/product/scope.md`). `packages/kernel/src/legal-entities.ts` | **Yes** for branches in one company. Separate companies and consolidation: Unverified [M38] | **Yes** in FAO for Bookkeepers (separate databases, no consolidation); consolidated reports only in Fast Business Online [F17, F22] | **Yes.** Multi-company in one database; consolidation through account mapping. Multi-company needs the Custom plan on Odoo Online [O46, O47, O2] |
| **14. Self-hosting and open source** | **Yes.** AGPL-3.0. `docker compose up --build` runs the whole stack with no DOS service. `LICENSE`, `docker-compose.yml`, `docs/self-host/README.md` | **No.** AMIS Kế toán is cloud; MISA SME is installed on computers [M22, M23] | **No** open source. The desktop edition and Fast Business Online can be installed by the customer; FAO is cloud only [F3, F22] | **Yes.** Community is LGPL-3; Enterprise is licensed. Enterprise can be self-hosted or run on Odoo.sh. The Accounting app is not in the Community repo [O13, O3, O23, O48] |
| **15. Mobile** | **Yes, web only.** Responsive installable web app (PWA) with push for Social. No native app; #65 and #64 are open and low priority. `apps/app/public/assets/manifest.webmanifest` | **Yes.** Apps for MISA SME reports, sales, meInvoice, payslips and HR [M7, M22, M23, M33, M35] | **No** app for FAO or FA; apps exist for Fast e-Invoice, Fast HKD and Fast Business Online [F11, F33, F34] | **Yes.** A PWA; native store apps Unverified [O49] |
| **16. Integrations and API** | **No** public API, OAuth server, outbound webhooks or MCP (epic #68, ADR-0032 only proposed). The app's own RPC is internal. Inbound webhooks and channel connections (Facebook, Instagram, Zalo, Google) exist. `docs/adr/0032-oauth-authorization-server.md`, `packages/channel/src/index.ts` | **Yes.** An API to push vouchers in; meInvoice lists an open API and 110+ connected programs; fees for API access Unverified [M36, M7] | **Yes.** API connections and Excel or XML import; no public developer docs were found [F9, F19, F22] | **Yes.** External JSON-2 API with keys; external API access is in the Custom plan on Odoo Online [O45, O2] |

### 3.7 Price for a small business

| Row | Ludy | MISA | Fast | Odoo |
|---|---|---|---|---|
| **17. Published price** | **Self-hosted: no licence fee** (AGPL). No Ludy Cloud price exists; the repository says "not live" (`docs/product/competitors.md`). | AMIS Kế toán Starter, 3 users: 3,650,000 VND a year [M5]; another MISA page says 2,450,000 for 1 user [M3] (conflict). MISA SME Standard: 6,150,000 a year for 3 users [M4]. Minimum 12 months. E-invoices, payroll, HR, CRM are extra | FAO: from 1,100,000 VND per user for 6 months, 1,750,000 for a year [F5]. Fast Accounting desktop licence: 5,900,000 plus 2,950,000 set-up [F4]. VAT treatment not stated | Community: free. Odoo Online "One App Free": US$0. Enterprise per user a month: Standard US$8.95 or 11.20, Custom US$16.40 or 20.40; the page does not say which is monthly billing. Credits for OCR and AI are extra [O2] |

## 4. Where Ludy leads, where it trails, what to build next

Recommendations name existing plan issues only. Anything new is an **owner decision**; no issue is opened by this page.

### Where Ludy leads

- **Open source and self-hosting of the whole accounting app** (row 14). None of the three offers it. For a business that wants its books on its own server, or an accountant who wants to read the code, there is no equal.
- **A strict approval model with a budget meter** (row 12). A person approves every posting, message and spend; AI cost is metered and can be stopped; the core works with AI off. MISA's received-invoice posting describes no review [M26].
- **Reading the signed XML without a model** (row 1a). The signatures of the seller and the tax authority are checked on the machine; this study did not find it described on the rival pages.
- **Bank matching with batch approval and undo** (row 3c) and **a human-sent, AI-worded reminder** (row 4).
- **TT133 in an open product**, ahead of Odoo's official package (row 6), although Ludy's own statements still wear a draft banner.

### Where Ludy trails

- **No live e-invoice issuing and no live bank feed** (rows 2 and 3b). Both are built behind sandbox providers only. All three rivals issue e-invoices today; MISA and Fast sell live bank links.
- **Payroll, social insurance, PIT and HR are not usable yet** (rows 5b, 9, 10). MISA covers them; Fast sells them as a separate product.
- **No TT99 reports and no TT200** (row 6). MISA and Fast ship TT99, which applies from 2026-01-01 [M13, F32].
- **Statements and tax XML are unverified** by an accountant (rows 5a and 6): they carry a draft banner or an open verification issue.
- **No native mobile app, no public API** (rows 15 and 16), no quotes or sales orders in CRM (row 11), no published price or hosted product (row 17).
- **Reading photos and scanned PDFs** depends on the operator's own model (row 1b).

### What to build next (existing issues, in the order the gaps hurt most)

1. **Live e-invoice issuing:** the MISA adapter #2503 and the Viettel adapter #2509, with their owner steps #2507 and #2508 (test accounts and written questions to the vendors). Then adjust and replace #2504.
2. **Live bank feed:** the Tingee adapter #2045.
3. **Accountant sign-off on what already ships:** #154 (B01 and B02), #920 (year-end HTKK XML), #332 (01/GTGT XML), and the supervised first run of the portal sync #1100.
4. **TT99 books:** #1403.
5. **Payroll and HR as the separate app:** #2531, #2532, #2533, with the employee records in #2530; the rules need the accountant's check (#2535), and #2643 blocks payroll in Cloud.
6. **Marketplaces and stock:** the live marketplace connection #2519 and month close with cost of goods sold #2513.
7. **Owner decision (nothing exists):** whether Ludy needs TT200 support at all now that Circular 99 replaces it; quotes and sales orders in CRM; a public API beyond epic #68; a Ludy Cloud price; a native mobile app beyond #64 and #65.

The existing market map also says XML, PDF, photo and tax-portal sync are "Shipped"; this page qualifies the portal sync (assisted, off by default, never run against the real portal) and the photo reading (needs the operator's model).

## 5. Method and limits

- **Ludy evidence** was collected from a snapshot of `main` at `b473ad3` (PR #2664), by reading code, routes and Vietnamese UI strings, and checking each issue's state with `gh` on 2026-11-06. Closed build issues #2500, #2501, #2502, #2512, #2515 and #2529 were checked against the code. The repository holds only the open-source layer: a private Ludy Cloud layer could hold adapters this page cannot see. Whether an accountant has reviewed the unverified items since the snapshot cannot be told from the repository.
- **MISA.** Pages were read on 2026-11-06 through a fetch tool that returns summaries. Sources M37, M38 and M39 were seen only inside search-result digests and were not opened; facts that rest on them are marked. MISA pages disagree on the Starter price (2.45 million, 3.65 million, a 2.95 million floor) and on which plan gets the reminder emails; the meInvoice price page says it is valid from 2020 and may be stale. TT133 inside AMIS Kế toán and the "HTKK format" export are not confirmed by an official help page.
- **Fast.** Many pages carry only a "Copyright 2026" footer and no date; page dates are given when shown. The FAO short brochure (over 10 MB) could not be read, so prices come from the FAO price page. A search summary suggested that official Fast pages name VNPT and Viettel as supported issuers; the pages checked did not, so it is Unverified. Whether prices include VAT is not stated.
- **Odoo.** "Current version" is ambiguous: Odoo 20 was released in September 2026 and the repository's default branch is now 20.0, while the stable 19.0 documentation is what is cited for most rows. Vietnam items such as the HTKK XML exist only from 19.4 and 20. Enterprise-only marks are inferred (see section 1), except bank sync, which the docs say needs an Enterprise subscription [O18]. The Odoo blog post on Vietnamese e-invoicing returned HTTP 403 and is cited from a search snippet only [O50]. The Odoo pricing page does not label which price is yearly and which monthly, and its second price set has an unlabelled currency.
- **Prices** are in the currency the vendor shows and are not converted. They are list prices on the dates above, not quotes.
- Nothing here uses secrets or internal URLs. The sources are public pages.

## 6. Sources

All pages were read on 2026-11-06. `M` is MISA, `F` is Fast, `O` is Odoo. PRIMARY means an official vendor page; SECONDARY is a third-party page and is never the only support for a `Yes`. "Search digest only" means the page was seen only inside a search result summary.

### MISA

- **M1** https://amis.misa.vn/20355/bao-gia-phan-mem-ke-toan-online-misa-amis/ (Bảng báo giá phần mềm kế toán giá rẻ 2026). PRIMARY.
- **M3** https://amis.misa.vn/bang-gia-bo-giai-phap-quan-tri-hop-nhat-misa-amis/ (Bảng Giá Bộ Giải Pháp Quản trị hợp nhất MISA AMIS). PRIMARY.
- **M4** https://sme.misa.vn/bao-gia/ (Báo giá phần mềm kế toán MISA SME 2026). PRIMARY.
- **M5** https://asp.misa.vn/tt/kien-thuc/bao-gia-phan-mem-ke-toan/ (Bảng giá TOP 10+ phần mềm kế toán giá rẻ, nổi bật 2026). PRIMARY.
- **M6** https://helpact.misa.vn/?p=11472 (Help AMIS Kế toán: received-invoice processing (title shown as "1. Trang chủ")). PRIMARY.
- **M7** https://www.meinvoice.vn/ (MISA meInvoice home page). PRIMARY.
- **M9** https://amis.misa.vn/giai-phap-tai-chinh-ke-toan-toan-dien/ (Bộ giải pháp quản trị Tài chính Kế toán MISA AMIS). PRIMARY.
- **M10** https://helpact.misa.vn/ac/r97/ (AMIS Kế toán release R97). PRIMARY.
- **M11** https://helpact.misa.vn/kb/ava-ke-toan-cac-tinh-nang-va-tien-ich/ (AVA Kế toán, các tính năng và tiện ích). PRIMARY.
- **M12** https://amis.misa.vn/251865/huong-dan-che-do-ke-toan-doanh-nghiep-tu-2026-theo-thong-tu-99-2025-tt-btc/ (Hướng dẫn chế độ kế toán doanh nghiệp từ 2026 theo Thông tư 99/2025/TT-BTC). PRIMARY.
- **M13** https://amis.misa.vn/257923/tong-hop-cac-diem-thay-doi-trong-thong-tu-99-2025-tt-btc-thay-the-thong-tu-200-2014-tt-btc/ (Đáp ứng Thông tư 99/2025/TT-BTC trên phần mềm AMIS Kế toán). PRIMARY.
- **M14** https://helpact.misa.vn/kb/cac-tinh-nang-moi-theo-tung-phien-ban/ (Tính năng mới - AMIS Kế toán (release notes)). PRIMARY.
- **M15** https://amis.misa.vn/156919/tu-dong-dong-bo-thong-tin-don-hang-tu-san-thuong-mai-dien-tu-shopee-tiktok-shop-lazada/ (Tự động đồng bộ thông tin đơn hàng từ sàn TMĐT Shopee, TikTok Shop, Lazada). PRIMARY.
- **M16** https://helpact.misa.vn/kb/tu-dong-gui-email-nhac-no-khach-hang/ (Thiết lập tự động gửi email nhắc nợ tới khách hàng). PRIMARY.
- **M17** https://helpact.misa.vn/kb/nop_to_khai_thue/ (Xuất tờ khai thuế qua XML để nộp báo cáo thuế trực tuyến). PRIMARY.
- **M18** https://helpact.misa.vn/kb/lap-to-khai-quyet-toan-thue-thu-nhap-ca-nhan/ (Lập tờ khai quyết toán thuế thu nhập cá nhân). PRIMARY.
- **M19** https://amis.misa.vn/61453/phan-mem-ho-tro-ke-khai-thue-htkk/ (Tải phần mềm HTKK mới nhất của Cục Thuế bản 5.8.2 năm 2026). PRIMARY.
- **M20** https://helpact.misa.vn/?p=12062 (Ngân hàng điện tử (Help AMIS Kế toán)). PRIMARY.
- **M21** https://helpact.misa.vn/kb/cac-cau-hoi-thuong-gap-ve-thong-tu-99-2025-tt-btc/ (Các câu hỏi thường gặp về Thông tư 99/2025/TT-BTC). PRIMARY.
- **M22** https://amis.misa.vn/amis-ke-toan/ (AMIS Kế toán product landing page). PRIMARY.
- **M23** https://sme.misa.vn/ (Phần mềm kế toán MISA SME 2026 - Giải pháp kế toán toàn diện). PRIMARY.
- **M24** https://helpact.misa.vn/?p=68849 (Các tính năng AI trên phần mềm AMIS Kế toán). PRIMARY.
- **M25** https://amis.misa.vn/?p=272211 (Tự động hạch toán các giao dịch ngân hàng dựa trên lịch sử giao dịch với AVA Kế toán). PRIMARY.
- **M26** https://amis.misa.vn/143559/tu-dong-hach-toan-hoa-don-dau-vao-voi-tro-ly-so-misa-ava/ (Tự động hạch toán hóa đơn đầu vào với Trợ lý số MISA AVA). PRIMARY.
- **M27** https://www.meinvoice.vn/bao-gia/ (Báo giá hóa đơn điện tử MISA meInvoice (từ 300đ/hóa đơn)). PRIMARY.
- **M28** https://helpv4.meinvoice.vn/kb/tinh-nang-moi-inbots/ ((MISA meInvoice - Xử lý hóa đơn) Tính năng mới). PRIMARY.
- **M29** https://helpv4.meinvoice.vn/kb/inbot-nhap-tay-hoa-don-giay-vao-he-thong/ ((MISA meInvoice - Xử lý hóa đơn) Tải lên file PDF hóa đơn vào phần mềm). PRIMARY.
- **M32** https://amis.misa.vn/123621/gia-phan-mem-tinh-luong/ (Báo giá phần mềm tính lương MISA AMIS). PRIMARY.
- **M33** https://amis.misa.vn/amis-tien-luong/ (Phần Mềm AMIS Tiền Lương). PRIMARY.
- **M34** https://amis.misa.vn/293039/bao-gia-phan-mem-amis-crm/ (Báo giá phần mềm AMIS CRM chi tiết, mới 2026). PRIMARY.
- **M35** https://amis.misa.vn/amis-nhan-su/ (AMIS Nhân sự (HRM)). PRIMARY.
- **M36** https://helpact.misa.vn/kb/lap-chung-tu-hach-toan-tu-du-lieu-ket-noi-voi-cac-ung-dung-khac-qua-api/ (Kết nối với các ứng dụng khác qua API - AMIS Kế toán). PRIMARY.
- **M37** https://helpact.misa.vn/kb/khai-bao-tai-san-co-dinh-dau-ky/ and https://helpact.misa.vn/kb/lam-the-nao-de-khai-bao-ccdc-chi-phi-tra-truoc-dau-ky/ (Khai báo tài sản cố định đầu kỳ; Làm thế nào để khai báo CCDC/chi phí trả trước đầu kỳ?). PRIMARY. Search digest only, not opened.
- **M38** https://helpact.misa.vn/kb/tong-quan-chi-nhanh-hach-toan-doc-lap-va-hach-toan-phu-thuoc/ , https://helpact.misa.vn/kb/lap_bao_cao_tai_chinh_tong_hop/ , https://helpact.misa.vn/kb/ket-noi-san-thuong-mai-dien-tu-voi-amis-ke-toan/ , https://helpact.misa.vn/kb/xem-bao-cao-tong-hop-tren-nhieu-chi-nhanh-giai-doan-5/ (Branch overview; consolidated statements; marketplace connection; multi-branch reports (Help AMIS Kế toán)). PRIMARY. Search digest only, not opened.

### Fast

- **F1** https://faonline.vn/wp-content/uploads/2023/09/2026-Tai-lieu-gioi-thieu-FAO-full.pdf (FAO brochure (full)). PRIMARY.
- **F3** https://fast.com.vn/phan-mem-ke-toan-fast-accounting/ (Fast Accounting product page). PRIMARY.
- **F4** https://fast.com.vn/wp-content/uploads/2026/05/2026.04-FA-Bang-gia-san-pham.pdf (Fast Accounting price list (file labelled 2026.04)). PRIMARY.
- **F5** https://faonline.vn/bang-gia/ (FAO price list). PRIMARY.
- **F6** https://fast.com.vn/phan-mem-ke-toan-fast-accounting-phan-he-bao-cao-thue/ (FA tax reporting module). PRIMARY.
- **F7** https://fast.com.vn/phan-mem-ke-toan-fast-accounting-quan-ly-thue-tncn/ (FA personal income tax module). PRIMARY.
- **F8** https://fast.com.vn/phan-mem-ke-toan-fast-accounting-ket-noi-voi-giai-phap-hoa-don-dien-tu-fast-e-invoice/ (FA connection to Fast e-Invoice). PRIMARY.
- **F9** https://faonline.vn/fast-accounting-online/ (Fast Accounting Online page). PRIMARY.
- **F10** https://faonline.vn/bang-gia-tinh-nang-bo-sung/ (FAO add-on price list). PRIMARY.
- **F11** https://faonline.vn/ (FAO home page). PRIMARY.
- **F12** https://fast.com.vn/chuc-nang-quan-ly-hoa-don-dau-vao-tren-phan-mem-ke-toan-fast-accounting-online/ (Input invoice management in FAO). PRIMARY.
- **F13** https://fast.com.vn/phan-mem-ke-toan-fast-tich-hop-voi-cac-san-thuong-mai-dien-tu/ (FAST accounting integration with e-commerce marketplaces). PRIMARY.
- **F14** https://faonline.vn/fast-ai-nang-tam-trai-nghiem-nguoi-dung-bang-tri-tue-nhan-tao/ (Fast AI assistant). PRIMARY.
- **F15** https://help.faonline.vn/faohelp/sao-ke-tai-khoan-ngan-hang/ (FAO help: bank statement). PRIMARY.
- **F17** https://fast.com.vn/phan-mem-ke-toan-dung-cho-nhieu-cong-ty/ (Accounting software for many companies (FAO.BK)). PRIMARY.
- **F18** https://invoice.fast.com.vn/bang-gia-dich-vu/ (Fast e-Invoice price list). PRIMARY.
- **F19** https://fast.com.vn/giai-phap-hoa-don-dien-tu-toan-dien-cho-doanh-nghiep/ (Fast e-Invoice overall solution). PRIMARY.
- **F20** https://fast.com.vn/phan-mem-erp-fast-business-online-fast-hrm-quan-ly-nhan-su-cham-cong-tinh-luong/ (Fast HRM: HR, timekeeping, payroll). PRIMARY.
- **F22** https://fast.com.vn/phan-mem-erp-fast-business-online/ (Fast Business Online (ERP) page). PRIMARY.
- **F23** https://fast.com.vn/phan-mem-fast-crm-online/ (Fast CRM Online page). PRIMARY.
- **F25** https://fast.com.vn/phan-mem-erp-fast-business-online-fast-ai/ (Fast AI in FBO). PRIMARY.
- **F26** https://fast.com.vn/chuc-nang-nhac-no-thong-minh-ung-dung-tri-tue-nhan-tao-ai-tren-fast-business-online/ (Smart AI debt reminder in FBO). PRIMARY.
- **F27** https://fast.com.vn/fast-phat-trien-erp-the-he-moi-ung-dung-agentic-ai-nang-cao-kha-nang-van-hanh/ (Next-generation ERP with agentic AI). PRIMARY.
- **F29** https://help.faonline.vn/faohelp/khoa-so-lieu-2/ (FAO help: Khoá số liệu (period lock)). PRIMARY.
- **F30** https://fa11r09help.fast.com.vn/index.php/fa11help/khoa-nhap-lieu-va-dong-ky-ke-toan/ (FA 11 help: data-entry lock and period close). PRIMARY.
- **F31** https://help.faonline.vn/faohelp/mo-so-ke-toan/ (FAO help: Mở sổ kế toán (open books)). PRIMARY.
- **F32** https://help.faonline.vn/faohelp/cac-cau-hoi-thuong-gap-ve-viec-ap-dung-thong-tu-99-2025-tt-btc/ (FAO help: TT99/2025 FAQ). PRIMARY.
- **F33** https://fast.com.vn/fast-ra-mat-phien-ban-mobile-app-cho-phan-mem-hoa-don-dien-tu-fast-e-invoice/ (Fast e-Invoice mobile app launch). PRIMARY.
- **F34** https://fast.com.vn/phan-mem-ke-toan-fast-ho-kinh-doanh/ (Fast Hộ Kinh Doanh (household business)). PRIMARY.

### Odoo

- **O1** https://www.odoo.com/documentation/19.0/applications/finance/fiscal_localizations/vietnam.html (Vietnam, Odoo 19.0 documentation). PRIMARY.
- **O2** https://www.odoo.com/pricing (Odoo Pricing). PRIMARY.
- **O3** https://raw.githubusercontent.com/odoo/odoo/19.0/addons/l10n_vn/__manifest__.py (l10n_vn manifest, 19.0 (also read for 18.0 branch, same text)). PRIMARY.
- **O4** https://raw.githubusercontent.com/odoo/odoo/19.0/addons/l10n_vn_edi_viettel/__manifest__.py (l10n_vn_edi_viettel manifest, 19.0). PRIMARY.
- **O10** https://github.com/odoo/odoo/commit/8b73f36 ([IMP] l10n_vn: updated chart of account (Circular 200/2014 to 99/2025)). PRIMARY.
- **O11** https://github.com/odoo/odoo/commits/19.0/addons/l10n_vn (Commits, odoo/odoo 19.0, addons/l10n_vn). PRIMARY.
- **O13** https://www.odoo.com/page/editions (Odoo Editions (Community vs Enterprise)). PRIMARY.
- **O14** https://www.odoo.com/documentation/19.0/applications/finance/accounting.html (Accounting and Invoicing, Odoo 19.0). PRIMARY.
- **O15** https://www.odoo.com/documentation/19.0/applications/finance/accounting/vendor_bills/invoice_digitization.html (Document digitization, Odoo 19.0 (incl. pricing section at tail)). PRIMARY.
- **O16** https://www.odoo.com/documentation/19.0/applications/finance/accounting/vendor_bills.html (Vendor bills, Odoo 19.0). PRIMARY.
- **O18** https://www.odoo.com/documentation/19.0/applications/finance/accounting/bank/bank_synchronization.html (Bank synchronization, Odoo 19.0 (plus search-result list of providers)). PRIMARY.
- **O19** https://www.odoo.com/documentation/19.0/applications/finance/accounting/bank/transactions.html (Transactions, Odoo 19.0). PRIMARY.
- **O20** https://www.odoo.com/documentation/19.0/applications/hr/payroll.html (Payroll, Odoo 19.0 (localization list)). PRIMARY.
- **O23** https://raw.githubusercontent.com/odoo/odoo/19.0/addons/MODULE/__manifest__.py for hr_payroll, account_asset, ai, account_consolidation, documents, hr_appraisal, account_followup, sale_amazon, sale_lazada, sale_shopee, sale_tiktok (all HTTP 404) (Absence checks in the Community repo, 19.0 (module names for connectors were guesses, so absence there proves little)). PRIMARY.
- **O24** https://raw.githubusercontent.com/odoo/odoo/19.0/addons/{stock,crm,hr,hr_recruitment}/__manifest__.py (Manifests present, all LGPL-3). PRIMARY.
- **O25** https://www.odoo.com/documentation/19.0/applications/productivity/ai.html (AI, Odoo 19.0). PRIMARY.
- **O26** https://www.odoo.com/documentation/19.0/applications/productivity/ai/agents.html (AI agents, Odoo 19.0). PRIMARY.
- **O27** https://www.odoo.com/documentation/19.0/applications/hr/employees.html (Employees, Odoo 19.0). PRIMARY.
- **O28** https://www.odoo.com/odoo-19-4-release-notes (Odoo 19.4 Release Notes (July 2026)). PRIMARY.
- **O31** https://www.odoo.com/odoo-19-2-release-notes (Odoo 19.2 Release Notes). PRIMARY.
- **O32** https://www.odoo.com/odoo-20-release-notes (Odoo 20 Release Notes (September 2026; read about 60 percent)). PRIMARY.
- **O33** https://www.odoo.com/documentation/19.0/applications/sales/sales/lazada_connector/features.html (also /manage.html, /setup.html) (Lazada Connector, Odoo 19.0 (snippet via search summary only)). PRIMARY (snippet). Search digest only, not opened.
- **O34** https://www.odoo.com/documentation/19.0/applications/sales/sales/tiktok_connector/features.html (TikTok Shop connector features, Odoo 19.0). PRIMARY.
- **O35** https://www.odoo.com/documentation/19.0/applications/sales/sales/shopee_connector/features.html (Shopee Connector features, Odoo 19.0). PRIMARY.
- **O37** https://www.odoo.com/documentation/19.0/applications/finance/accounting/payments/follow_up.html (Follow-ups, Odoo 19.0). PRIMARY.
- **O38** https://www.odoo.com/documentation/19.0/applications/finance/accounting/vendor_bills/assets.html (Assets, Odoo 19.0). PRIMARY.
- **O39** https://www.odoo.com/documentation/19.0/applications/finance/accounting/vendor_bills/deferred_expenses.html (Deferred expenses, Odoo 19.0). PRIMARY.
- **O40** https://www.odoo.com/documentation/19.0/applications/finance/accounting/reporting/year_end.html (Year-end closing and lock dates, Odoo 19.0). PRIMARY.
- **O45** https://www.odoo.com/documentation/19.0/developer/reference/external_api.html (External JSON-2 API, Odoo 19.0 (headings only readable)). PRIMARY.
- **O46** https://www.odoo.com/documentation/19.0/applications/general/companies/multi_company.html (Multi-company, Odoo 19.0). PRIMARY.
- **O47** https://www.odoo.com/documentation/19.0/applications/finance/accounting/get_started/consolidation.html (Consolidation, Odoo 19.0 (fetched, plus search summary)). PRIMARY.
- **O48** https://www.odoo.com/documentation/19.0/administration/odoo_sh.html (Odoo.sh, Odoo 19.0). PRIMARY.
- **O49** https://www.odoo.com/documentation/19.0/administration/mobile.html (and 20.0 mobile page via search summary) (Odoo mobile apps). PRIMARY.
- **O50** https://www.odoo.com/blog/business-hacks-1/e-invoicing-and-vietnamese-accouting-standards-on-odoo-2502 (E-Invoicing and Vietnamese Accounting Standards on Odoo: Providers, In... (HTTP 403, snippet only)). PRIMARY (snippet only, weak). Search digest only, not opened.
- **O52** https://apps.odoo.com/apps/modules/18.0/l10n_vn_viin (and viindoo.com/apps/app/18.0/l10n_vn_viin) (Vietnam Chart of Accounts, Circular 99 and 133 (Viindoo, OPL-1, paid third-party, not part of Odoo; snippet only)). SECONDARY. Search digest only, not opened.
- **O53** https://apps.odoo.com/apps/modules/18.0/l10n_vn_viin_hr_payroll (l10n_vn_viin_hr_payroll (Viindoo, OPL-1, third-party, not part of Odoo; snippet only)). SECONDARY. Search digest only, not opened.
- **O54** https://apps.odoo.com/apps/modules/16.0/l10n_vn_viin_accounting_meinvoice and https://apps.odoo.com/apps/modules/18.0/vnpt_invoice_integration (meInvoice and VNPT integrators (paid third-party, not part of Odoo; snippet only)). SECONDARY. Search digest only, not opened.
- **O58** https://raw.githubusercontent.com/odoo/odoo/19.0/addons/sale/__manifest__.py (sale manifest, 19.0 (Sales, LGPL-3)). PRIMARY.
