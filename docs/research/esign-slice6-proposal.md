<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Ludy eSign Slice 6 Proposal: Last-Mile SME Signing Velocity & Contract-to-Cash (2026-11-24)

Status: **Wave 1 (`6a` [#4720](https://github.com/DOS/Ludy/issues/4720)/[#4727](https://github.com/DOS/Ludy/pull/4727), `6b` [#4721](https://github.com/DOS/Ludy/issues/4721)/[#4728](https://github.com/DOS/Ludy/pull/4728)), Wave 2 (`6c` [#4722](https://github.com/DOS/Ludy/issues/4722)/[#4731](https://github.com/DOS/Ludy/pull/4731), `6d` [#4723](https://github.com/DOS/Ludy/issues/4723)/[#4732](https://github.com/DOS/Ludy/pull/4732)), Wave A1 follow-ups ([#4636](https://github.com/DOS/Ludy/issues/4636), [#4682](https://github.com/DOS/Ludy/issues/4682), [#4729](https://github.com/DOS/Ludy/issues/4729), [#4837](https://github.com/DOS/Ludy/issues/4837), [#5024](https://github.com/DOS/Ludy/issues/5024)), `ludy.vn/esign` marketing sync ([#5109](https://github.com/DOS/Ludy/issues/5109)/[#5115](https://github.com/DOS/Ludy/pull/5115)), and Slice 6a-6d Playwright E2E ([#5110](https://github.com/DOS/Ludy/issues/5110)/[#5114](https://github.com/DOS/Ludy/pull/5114)) are shipped on `dev` / `main` (not yet deployed to `pilot`); Candidate 5 (`Slice 6e`, `VNeID`/C06 + live public CAs) remains deferred pending legal counsel review ([#62](https://github.com/DOS/Ludy/issues/62)) and partner credentials.** (Original proposal: [#4607](https://github.com/DOS/Ludy/issues/4607), Epic [#3318](https://github.com/DOS/Ludy/issues/3318), Plan [#3319](https://github.com/DOS/Ludy/issues/3319)). Vietnamese summary for JOY: [esign-slice6-proposal.vi.md](esign-slice6-proposal.vi.md). Current `2026-11-27` (`v4`) benchmark: [esign-competitors-and-ai-2026.md](esign-competitors-and-ai-2026.md) ([vi](esign-competitors-and-ai-2026.vi.md)).

---

## 1. Strategic Context & Strict Scope Gate ([scope.md](../product/scope.md))

Across **Slices 1 through 5** (verified shipped on `origin/main` @ `e5e0953aa` across `22` `ludy_sign.*` tables and `9` metered `Vy` AI features), Ludy eSign already covers self-contained PDF signing, templates, direct links, public hub, in-person tablet mode, Vietnamese `ký nháy` + corporate stamps, `dropdown`/`radio`/KYC attachments, in-flight correction/delegation, obligation/renewal tracking, starter drafting, PDF diffing, Contract Vault Q&A, SME Playbook redlines, HMAC webhooks, MCP read tools, and `/api/v1/sign/*` REST drafts.

The `2026-11-24` v2 benchmark ([esign-competitors-and-ai-2026.md](esign-competitors-and-ai-2026.md)) reveals that the remaining day-to-day friction for a Vietnamese **one-person company (OPC) or SME** is no longer missing CLM features, but **last-mile operational drag**:

1. Counterparties send contracts in **`.docx` Word files** rather than clean PDFs.
2. Real deals combine **multiple files** (main contract + price annex + acceptance/NDA) into one signing event.
3. Signing on a **phone via QR** or nudging a client inside **Zalo** still requires manual URL copy-pasting or touching a shared staff tablet.
4. After signing, SMEs still chase **deposit bank transfers (`đặt cọc`)** separately from the signing ceremony (where Agree.com and DocuSeal close the cash loop).
5. Meanwhile, new **Decree `337/2025/ND-CP` + Circular `08/2026/TT-BNV` (`2026-07-01`)** rules introduce `VNeID` (`C06`) and 24-hour Ministry of Home Affairs ID requirements for statutory labor contracts, raising the question of whether technical hooks belong in Slice 6 or behind legal/partner gates.

Every candidate below is evaluated against all five [scope.md](../product/scope.md) gates:

- **Monthly OPC/SME fit:** solves a recurring monthly workflow for owners, sales, ops, or bookkeepers.
- **Zero-setup `docker compose up` defaults:** works with zero external SaaS keys, paid gateways, desktop Word plugins, or hardware USB tokens.
- **Named `Vy` AI part (`metered()`) + 100% AI-off parity:** all model calls use `packages/agent` (`withAiScope`, `tools: []` per [ADR-0018](../adr/0018-untrusted-content.md)) with full deterministic manual functionality when AI is off or out of budget.
- **Human approval & proportionate security:** humans approve every send, conversion warning, and accounting match; every state write runs through `Runtime.execute()` with strict `hr_contract` and [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) `meeting_minutes` isolation.
- **Zero enterprise bloat:** no multi-entity SSO/SCIM, no agency consoles, no Word COM add-ins, no regulated PSP/escrow custody.

---

## 2. Candidate Evaluation Scorecard & Ranking

| Rank & Wave | Candidate | Monthly OPC/SME Fit | Zero-Setup `docker compose up` | AI Part (`Vy` `metered()`) & AI-Off Parity | Effort / Risk | Verdict |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **#1 (Wave 1a)** | **QR Scan-to-Sign Handoff & Zalo OA Engage Composer** *(Candidate 4)* | **High** (desktop-to-phone finger signing + counter QR + daily Zalo follow-ups) | **Pass (100%)** (`qr-svg.ts` + `Ludy Engage` `zalo_oa` already exist; paid ZNS stays optional via `Slice 5b` webhooks) | **0 LLM calls needed** (`100%` deterministic); optional `Vy`/`Dy` polite follow-up note with human send | **Small (`S`)** / **Low** | **Recommend Wave 1a** |
| **#2 (Wave 1b)** | **Native `.docx` Word Contract Upload -> Tagged A4 PDF** *(Candidate 1)* | **High** (eliminates Word-to-PDF export friction on incoming Zalo/email `.docx` contracts) | **Pass (100%)** (pure-JS `crove-extract` WordprocessingML -> `pdf-lib` A4 PDF; zero LibreOffice image bloat) | Existing `Vy` (`sign.field_propose`, `clause_summary`, `playbook_check`) runs on converted PDF; **100% offline conversion w/ AI off** | **Medium (`M`)** / **Low-Med** | **Recommend Wave 1b** |
| **#3 (Wave 2a)** | **Multi-Document Signing Packet (`Hồ sơ nhiều tài liệu`)** *(Candidate 2)* | **High** (main contract + `phụ lục` / `báo giá` in 1 ceremony & unified SHA-256 bundle) | **Pass (100%)** (`<= 5` files, `<= 200` total pages, sealed inside `crove-extract`) | `Vy` cross-document consistency check (`playbook_check` / `clause_summary` flagging mismatched totals/dates); **100% manual parity w/ AI off** | **Med-High (`M-L`)** / **Medium** | **Recommend Wave 2a** |
| **#4 (Wave 2b)** | **VietQR Deposit / Milestone Request & `Ludy Kế toán` Match Bridge** *(Candidate 3)* | **High** (closes Agree.com contract-to-cash gap for Vietnam SME deposits via VietQR) | **Pass w/ Static/Memo Mode** (full EMVCo `qr-svg.ts` string needs verified NAPAS BINs from [#2535](https://github.com/DOS/Ludy/issues/2535); zero external PSP keys) | `Vy` (`sign.obligation_extract` + `finance.bank_match_explain`) extracts deposit terms & explains bank matches; **100% manual w/ AI off** | **Medium (`M`)** / **Medium** | **Recommend Wave 2b** |
| **#5 (Deferred)** | **`VNeID` / C06 Identity Slot, `08/2026/TT-BNV` Portal & Live CA E2E** *(Candidate 5)* | **Low-Med for OPCs** (only statutory paperless labor contracts; external `VNeID`/C06 APIs gated) | **Fails `scope.md` default gate** (requires corporate C06 vetting, paid fees, & [#62](https://github.com/DOS/Ludy/issues/62) legal sign-off) | Deterministic compliance hooks only; cannot test live external `VNeID`/CA without owner credentials | **High (`L`)** / **High (Regulatory)** | **Defer until `#62` + Partner Creds** |

---

## 3. Detailed Evaluation of Each Slice 6 Candidate

### 3.1 Rank #1 (`Wave 1a`): QR Scan-to-Sign Handoff & Zalo OA Engage Composer *(Candidate 4)*

- **Market & UX problem:**
  - Counterparties opening `/-/sign#<token>` on a desktop PC hate drawing signatures with a mouse or trackpad. DocuSeal and DocuSign solve this with QR/SMS desktop-to-mobile handoffs `[S-DC2, S-DS1]`.
  - In Ludy's Slice 4d In-Person Counter mode (`Ký trực tiếp tại quầy`), handing over a staff tablet still requires physical device handling; letting the customer scan a QR code on their own smartphone is faster and cleaner.
  - Meanwhile, Vietnamese incumbents (MISA WeSign, FPT.eContract, VNPT eContract) send reminders via **Zalo ZNS** `[S-MW1, S-FP1, S-VN1]`, which requires paid verified Zalo OA templates and ZNS top-ups that conflict with zero-setup `docker compose up`.
- **Smallest `scope.md`-aligned design:**
  1. **QR Scan-to-Sign Modal (`Ký bằng QR trên điện thoại`, zero external dependencies):** Reuse Ludy's existing dependency-free ISO/IEC 18004 QR encoder (`apps/app/src/lib/qr-svg.ts`) in two places:
     - On `/sign/envelopes/$id` (for any active `'link'`-mode signer or In-Person counter session): displays `"Đưa khách quét QR để ký trên điện thoại"`, minting or showing the single-use `/-/sign#<token>` URL without ever putting tokens in server logs or query strings, and recording `in_person_signed` + `host_user_id` when launched from the counter flow.
     - On desktop `/-/sign#<token>` (only **after** OTP verification passes, if `require_email_otp = true`, so unauthenticated passers-by never bypass OTP): a quiet `"Ký dễ hơn bằng điện thoại (QR)"` button renders the current signing fragment URL locally in browser memory as an SVG QR (`zero network calls`), with automatic polling/refresh on the desktop screen until submission completes.
  2. **1-Click `"Chèn link ký vào Hộp thư Zalo"` in `Ludy Engage`:** Mirroring Ludy's existing meeting-minutes (`#3279`) and CRM quote (`#2694`) pattern, add a browser-carried handoff from `/sign/envelopes/$id` (or directly inside a deal/conversation drawer) that mints a copyable signing link and pre-fills the reply composer of an active **`Ludy Engage` Zalo OA (`packages/channel/src/zalo.ts` / `zalo-conversation.ts`)** thread. A **human explicitly reviews and presses Send** (zero automated bot blasts, zero paid ZNS dependency).
  3. **Paid Zalo ZNS stays BYO via `Slice 5b` Webhooks:** Organizations that already operate paid Zalo ZNS templates can subscribe to existing `sign.envelope.sent` / `sign.signer.signed` HMAC webhooks (`Slice 5b`, `#4440`) without forcing ZNS setup into Ludy core.
- **Security, AI & Effort:**
  - Zero new DB tables needed (reuses `ludy_sign.signing_token` + `qr-svg.ts`); optional audit event payload tag `qr_handoff_shown` stays PII-free.
  - `0` LLM calls required for QR or link insertion (`100%` AI-off by design).
  - **Effort:** `S` (`1` focused PR) | **Risk:** `Low` (strictly verify OTP precondition before displaying desktop QR and keep `hr_contract` / `meeting_minutes` excluded from shared Engage composers unless reader-permitted).

### 3.2 Rank #2 (`Wave 1b`): Native `.docx` Word Contract Upload -> Tagged A4 PDF Conversion *(Candidate 1)*

- **Market & UX problem:**
  - Today `apps/app/src/routes/sign-envelopes.tsx` and `sign-templates.tsx` accept `application/pdf,.pdf` only. Vietnamese SMEs constantly receive contracts as `.docx` attachments over Zalo/email, forcing manual open-in-Word -> Export PDF (which also triggers malformed font/hybrid `/XRefStm` errors like `#3401`).
  - Documenso (LibreOffice server-side), DocuSeal (native `.docx`), MISA WeSign, and FPT.eContract all accept `.docx` uploads `[S-DM1, S-DC1, S-MW1, S-FP1]`.
- **Smallest `scope.md`-aligned design:**
  - **Pure-JS `docx_to_pdf` inside `crove-extract` (`QUEUE_EGRESS: 'none'`):**
    - Reuse `apps/extract/src/docx-text.ts` (`readZipParts` ZIP bounds `<= 1000` entries / `<= 32 MiB` decompressed, refusing `<!DOCTYPE` / `<!ENTITY>` XXE vectors) and extend it from plain-text extraction into structured **WordprocessingML layout parsing** (headings, paragraphs, bold/italic weights, lists, simple borders/tables, page breaks, and **explicit rejection/warning on unaccepted Track Changes `w:ins`/`w:del` or password-encrypted `.docx`** so counterparties never smuggle hidden deleted clauses into a signed PDF!).
    - Render deterministic A4 PDF 1.4 inside `crove-extract` using existing `pdf-lib` + embedded `Be Vietnam Pro` subset fonts (`apps/extract/src/fonts.ts`), preserving `{{signature, r1}}`, `{{date, r1}}`, `{{text, r1}}`, and `{{dropdown, r1, ...}}` placeholder tags for automatic `pdf_tags` detection (`Slice 2a`/`4b`).
    - **Why pure JS over LibreOffice in Docker:** Avoids shipping a 400-700 MB LibreOffice C++ binary inside the `crove-extract` container, preserves fast `docker compose up` builds, avoids container binary allowlist/CVE expansion (`apps/kernel/test/container/image-check.mjs`), and isolates untrusted OOXML completely inside `crove-extract`.
    - **Honest layout boundary:** Store the original `.docx` SHA-256 reference in `signing_event` metadata alongside the generated `source_file_id` PDF ([ADR-0013](../adr/0013-evidence-storage-and-integrity.md)), and display a calm banner if the `.docx` contains unsupported floating shapes, embedded OLE objects, or complex multi-column layouts (`"Đã chuyển đổi từ .docx; vui lòng kiểm tra lại bố cục trang PDF trước khi gửi ký"`).
- **Security, AI & Effort:**
  - Once converted to PDF inside `crove-extract`, existing `Vy` features (`sign.field_propose`, `sign.clause_summary`, `sign.playbook_check`) work immediately via `metered()`; deterministic `.docx -> PDF` conversion works `100%` offline with AI off.
  - **Effort:** `M` (`1-2` PRs: `extract-contract` + `apps/extract` `docx_to_pdf` + upload UI) | **Risk:** `Low-Medium` (table wrapping edge cases in complex Word docs; mitigated by calm preview check + keeping direct PDF upload primary).

### 3.3 Rank #3 (`Wave 2a`): Multi-Document Signing Packet (`Hồ sơ nhiều tài liệu`) *(Candidate 2)*

- **Market & UX problem:**
  - Real B2B SME signings often bundle 2 to 4 documents together: e.g., `(1) Hợp đồng dịch vụ chính` + `(2) Phụ lục báo giá / SOW` + `(3) Thỏa thuận bảo mật NDA`. Today `ludy_sign.envelope` holds a single `source_file_id`, forcing senders to send separate envelopes (multiple links/OTPs) or combine PDFs in untrusted third-party web tools. DocuSeal (*Add Document*), Documenso, DocuSign, Agree.com, and MISA WeSign all handle multi-document packets in one ceremony `[S-DC1, S-DM1, S-DS1, S-AG1, S-MW1]`.
- **Smallest `scope.md`-aligned design:**
  - **Bounded SME packet (`ludy_sign.envelope_document`):** Allow `1..5` PDFs (or `.docx`-converted PDFs from `6b`) per envelope, ordered `doc_index = 1..5`, enforcing the existing aggregate safety bounds (`<= 200` total pages across all parts, `<= 25 MiB` total input/sealed output inside `EXTRACT_LIMITS`).
  - **One Ceremony, Clear Sections:**
    - In the Prepare Placer (`/sign/envelopes/$id`), the user switches cleanly between document tabs (`1. Hợp đồng chính`, `2. Phụ lục giá`) and drops fields per document (`document_id` + `page_number` inside that document).
    - On `/-/sign#<token>`, the recipient views numbered document sections sequentially or via sticky jump tabs, completes all required fields across the packet, and clicks **one** electronic consent checkbox (`Art. 22.4` Law `20/2023/QH15`).
  - **Unified SHA-256 Sealing (`crove-extract` `pdf_seal`):**
    - `pdf_seal` concatenates the ordered documents with crisp section separator headers/bookmarks, flattens every field onto its exact document page, and appends a unified **Audit Certificate** listing **each part's original filename, page range, and individual `source_sha256`**, plus the unified `sealed_sha256`. (`/sign/verify` verifies the sealed packet SHA-256 locally as before.)
- **Security, AI & Effort:**
  - Strictly preserves `hr_contract` (`owner`/`admin`/`created_by`) and `meeting_minutes` ([ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md)) visibility across all child `envelope_document` files (`can_read_sign_file`).
  - **AI Part (`metered()`, `tools: []`):** `Vy` (`sign.clause_summary` / `sign.playbook_check`) can flag **cross-document mismatches** (e.g., Main Contract states total `120,000,000 VND` while Annex `Phụ lục 1` sums `135,000,000 VND`, or an annex lacks a signature/initial box), marked `Đề xuất` with `{ documentTitle, pageNumber, quoteExcerpt }`. Works `100%` manually with AI off.
  - **Effort:** `M-L` (`2` PRs: schema/extract/commands + prepare/ceremony multi-doc UI) | **Risk:** `Medium` (migration + `rls-matrix` + `org_purge` + careful `field` page-number mapping and `EXTRACT_LIMITS` byte caps).

### 3.4 Rank #4 (`Wave 2b`): VietQR Deposit / Milestone Request & `Ludy Kế toán` Match Bridge *(Candidate 3)*

- **Market & UX problem:**
  - **Agree.com** and **DocuSeal** convert signature completion directly into collected deposits/invoices `[S-AG1, S-DC1]`. In Vietnam SME deals (design agencies, software shops, B2B suppliers, event/construction services), contracts routinely require a **30% to 50% deposit (`đặt cọc`)** upon signing before work begins.
  - Ludy already connects `Ludy Dự án` acceptance minutes to `Ludy Kế toán` invoice drafts ([ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md), `Slice 3b`), already contains `VN_BANKS` (`packages/l10n-vn/src/banks.ts`), `apps/app/src/lib/qr-svg.ts`, and `ludy_finance` bank accounts + `@ludy/bank-feed` (`Tingee` / statement imports), and tracks VietQR pilot invoicing under [#323](https://github.com/DOS/Ludy/issues/323).
- **Smallest `scope.md`-aligned design (Zero PSP Custody, Coordinated with [#2535](https://github.com/DOS/Ludy/issues/2535)):**
  - **Why non-custodial bank QR (never escrow/card PSP):** Acting as a payment processor triggers licensing, PCI/gateway keys, and breaks `docker compose up` zero-setup defaults. Instead, Ludy generates a **standard bank-transfer VietQR instruction** directly from the seller org's own bank account.
  - **Two-part flow with zero JS floats (`NUMERIC(20,4)` via `@ludy/l10n-vn`):**
    1. **Optional Deposit Payment Step on Envelope (`ludy_sign.envelope` deposit fields / `envelope_obligation`):** Sender toggles `"Hiển thị mã VietQR đặt cọc sau khi ký"` (choosing deposit amount as decimal string + short memo token `CK-<shortCode>` + selecting either a verified org VietQR bank template image `<= 256 KB` PNG or, once accountant `#61` verifies NAPAS BINs under [#2535](https://github.com/DOS/Ludy/issues/2535), an offline EMVCo NAPAS 247 string rendered via `qr-svg.ts`!).
    2. **Post-Sign Screen (`/-/sign` completion state) & `Ludy Kế toán` Match:** Immediately after the final party signs (non-blocking, so signing validity never depends on bank app uptime), `/-/sign` displays the VietQR code, 1-tap copy (`Số tài khoản`, `Số tiền`, `Nội dung CK`), and an optional transfer-screenshot upload (or `"Tôi đã chuyển khoản"` notice). Inside Ludy, `Ludy Kế toán` scans imported bank statements or `@ludy/bank-feed` (`Tingee`) credit lines matching `CK-<shortCode>` + exact deposit amount, surfacing a **human-confirmed** `"Khớp tiền cọc hợp đồng -> Ghi nhận phiếu thu / hóa đơn tạm ứng"` suggestion (`ADR-0050` cross-module parity, zero auto-posting).
- **Security, AI & Effort:**
  - **Crucial fraud protection (following CRM `#2826` seller-snapshot rule):** Snapshot the seller's bank account / VietQR payload **at `sign.envelope.send` time** so a compromised account or draft edit can never swap the recipient's bank QR mid-flight! Exclude `hr_contract` and `meeting_minutes` completely from payment requests.
  - **AI Part (`metered()`):** `Vy` (`sign.obligation_extract` + `finance.bank_match_explain`) proposes the deposit percentage/amount from contract text and explains candidate bank-line matches; manual deposit entry, QR display, and manual Finance posting work `100%` with AI off.
  - **Effort:** `M` | **Risk:** `Medium` (dynamic EMVCo VietQR string generation depends on verified NAPAS bank BIN codes in [#2535](https://github.com/DOS/Ludy/issues/2535); Wave 2b can ship cleanly using verified bank account + uploaded org VietQR PNG fallback immediately, upgrading to generated EMVCo QR once `#2535` lands).

### 3.5 Rank #5 (`Deferred / Conditional Gate`): `VNeID` / C06 Identity Adapter, `08/2026/TT-BNV` Portal & Live CA E2E *(Candidate 5)*

- **2026 statutory reality (`2026-11-24`):**
  - Under **Decree `337/2025/ND-CP`** and **Circular `08/2026/TT-BNV`** (portal live **`2026-07-01`**), statutory electronic labor contracts require **both parties' digital signatures (`chữ ký số`) + TSA timestamp + qualified `eContract` provider authentication + `VNeID` login (`C06`) + 24-hour submission to the Ministry of Home Affairs platform for a 13-character National ID** `[S-LEG1, S-LEG2]`.
  - Incumbents (VNPT eContract, FPT.eContract, Viettel vContract) integrate directly via licensed trust-service and Ministry channels `[S-FP1, S-VN1, S-VT1]`.
- **Why DEFERRED (not recommended for Slice 6 default build):**
  1. **Zero self-serve or local `docker compose` availability:** Neither `C06 / VNeID` eID endpoints nor the `Bộ Nội vụ` 13-char ID submission gateway offer open sandbox credentials for an AGPL `docker compose up` user; enterprise legal vetting, licensed intermediary agreements, and per-call identity fees are mandatory.
  2. **Blocked on Owner Legal Gate [#62](https://github.com/DOS/Ludy/issues/62):** Live external CA adapters (`VNPT SmartCA`, `Viettel MySign`, `MISA WeSign` in `@ludy/sign`, `Slice 2c`) are already built and waiting on `#62` legal review + vendor test accounts. Writing speculative `VNeID` or `Bộ Nội vụ` API payloads without official specs/credentials violates `scope.md` and `AGENTS.md` (*never build speculative unverified external protocols*).
  3. **Current honest UX is sufficient for OPC/SMEs today:** `Slice 5a` (`#4439`) already shows an explicit `Decree 337/2025/ND-CP` legal notice on `hr_contract` envelopes so SMEs do not misuse drawn/OTP signing where statutory Ministry registration is required.
- **Recommended action:** Keep `VNeID` / `C06` and `Bộ Nội vụ` 13-character ID integration **deferred to a dedicated conditional track** opened only after `#62` clears, partner sandbox credentials are provisioned, and a paid pilot customer explicitly requests statutory electronic labor contracts. Meanwhile, any `sandbox` CA PAdES E2E verification fits cleanly inside existing E2E issue [#4606](https://github.com/DOS/Ludy/issues/4606) without a new feature slice.

---

## 4. Recommended Wave Split & Explicit Icebox Exclusions

### 4.1 Recommended Execution Sequence (Pending JOY's Approval)

1. **Wave 1 (Immediate Everyday Friction Removal, 100% Zero Setup):**
   - **Slice 6a:** QR Scan-to-Sign Handoff (`qr-svg.ts` on envelope detail, In-Person counter self-phone scan, and post-OTP desktop `/-/sign`) + 1-click `"Chèn link ký vào Hộp thư Zalo"` composer handoff in `Ludy Engage` (`S` effort, `Low` risk).
   - **Slice 6b:** Native `.docx` Word Contract Upload -> Tagged A4 PDF Conversion inside `crove-extract` (`docx_to_pdf` pure JS, Track Changes guard, `Be Vietnam Pro`, `ADR-0013` `.docx` hash preservation) (`M` effort, `Low-Medium` risk).
2. **Wave 2 (High-Value Commercial Packet & Cash Flow):**
   - **Slice 6c:** Multi-Document Signing Packet (`ludy_sign.envelope_document`, 1..5 docs `<= 200` total pages, unified `pdf_seal` + per-part `source_sha256` Audit Certificate + `Vy` cross-doc checks) (`M-L` effort, `Medium` risk).
   - **Slice 6d:** VietQR Deposit / Milestone Payment Request (send-time bank snapshot, `NUMERIC(20,4)` decimal strings, post-sign QR + copy helpers, `Ludy Kế toán` bank-feed match proposal; upgrades to generated EMVCo QR once [#2535](https://github.com/DOS/Ludy/issues/2535) verifies NAPAS BINs) (`M` effort, `Medium` risk).
3. **Conditional Track (Blocked on External Gates):**
   - **Slice 6e (Deferred):** `VNeID` / C06 & `Thông tư 08/2026/TT-BNV` 13-character Ministry of Home Affairs bridge + live Vietnam CA activation, held until [#62](https://github.com/DOS/Ludy/issues/62) legal sign-off and vendor sandbox credentials arrive.

### 4.2 Explicitly Kept in the Icebox ([scope.md](../product/scope.md))

Even inside Slice 6, the following competitor features fail the OPC/SME scope gate and remain **out of scope / Icebox**:

1. **Mandatory paid Zalo ZNS / SMS gateway lock-in:** ZNS template approvals and prepaid balances belong in optional org-configured `Slice 5b` webhooks, never core send paths.
2. **Microsoft Word desktop COM / Office.js add-ins (Spellbook pattern) & LibreOffice container bloat:** breaks portable browser-first `docker compose up` deployments.
3. **Ludy acting as a regulated payment gateway, escrow holder, or card acquirer:** VietQR displays the org's own bank account instruction and reconciles bank lines in `Ludy Kế toán`; Ludy never holds customer funds.
4. **USB hardware PKI token desktop drivers (`Token USB`), multi-entity SAML/SCIM signer SSO, bulk CSV spam blasts, white-label agency consoles, and enterprise multi-department CLM workflow builders.**
5. **Claiming MOIT `CeCA` ("tích xanh") or `Decree 23/2025` licensed `TSP`/`TSA` status** (covered under [#62](https://github.com/DOS/Ludy/issues/62) non-overclaiming rules in [esign-vietnam-legal-2026.md](esign-vietnam-legal-2026.md)).

---

## 5. Summary Decision Options Ready for Owner (`JOY`)

When the Product Owner presents this proposal via `AskUserQuestion` (Vietnamese popup), the recommended options are:

1. **Duyệt Lộ trình Đợt 1 (`6a` Quét QR ký trên điện thoại + chèn link Zalo Engage, và `6b` tải file Word `.docx` tự chuyển sang PDF) trước, rồi tiếp Đợt 2 (`6c` Gói nhiều tài liệu & `6d` Đặt cọc VietQR nối Kế toán); hoãn `6e` (`VNeID`/Bộ Nội vụ) chờ cổng pháp lý `#62` *(Khuyên dùng)*.**
2. **Chỉ mở trước Đợt 1 (`6a` QR + Zalo Engage và `6b` file Word `.docx`)** để gọn nhẹ và kiểm tra thực tế trên bản chạy thử trước khi bàn Đợt 2.
3. **Ưu tiên Gói hợp đồng nhiều tài liệu (`6c`) và Đặt cọc VietQR (`6d`) ngay**, làm phần Word `.docx` và QR sau.
4. **Tạm dừng mở Slice 6**, tập trung hoàn thiện E2E (`#4606`), đồng bộ trang giới thiệu (`#4605`), đưa eSign lên máy chạy thử (`pilot`) và chờ luật sư `#62`.
