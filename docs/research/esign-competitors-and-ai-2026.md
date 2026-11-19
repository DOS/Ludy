# Global, Vietnam SME & AI-Native eSign Benchmark (2026-11-19)

Status: research and scope-gate benchmark, `2026-11-19` (Issue [#3810](https://github.com/DOS/Ludy/issues/3810), Epic [#3318](https://github.com/DOS/Ludy/issues/3318), Plan [#3319](https://github.com/DOS/Ludy/issues/3319)). Informs the owner-approved Slice 3 (`#3811`, `#3812`, `#3813`) and Slice 4 (`#3817` - `#3822`) decisions recorded in [esign.md](../plan/esign.md) and [esign.vi.md](../plan/esign.vi.md).

Lens: one-person companies (OPC), household businesses, and small and medium enterprises (SMEs) in Vietnam first ([scope.md](../product/scope.md)). Every capability studied below is filtered against five fixed Ludy constraints ([AGENTS.md](../../AGENTS.md), [DESIGN.md](../../DESIGN.md) section 1.1, [ai-first-reference-study.md](ai-first-reference-study.md)):

1. **Monthly OPC/SME fit:** shortens or secures an agreement task an owner, salesperson, project lead, or bookkeeper performs at least monthly.
2. **Self-contained `docker compose up`:** works out of the box with zero external SaaS accounts, mandatory CAPTCHAs (`#203`), or desktop plugins.
3. **Metered, tainted AI with 100% AI-off parity:** all model calls run in `packages/agent` through `withAiScope` + `metered()` with `tools: []` ([ADR-0018](../adr/0018-untrusted-content.md)). Every AI output is tainted (`Đề xuất`), checked deterministically against document pages/quotes/numbers, and backed by a deterministic manual flow when AI is off or out of budget.
4. **Human approval on commitments:** a person approves every envelope send, recipient change, contract obligation confirmation, and accounting invoice draft.
5. **One write path & strict confidentiality:** every state change executes through `Runtime.execute()`, preserving [ADR-0013](../adr/0013-evidence-storage-and-integrity.md) SHA-256 evidence triples, `hr_contract` confidentiality, and [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) reader-scoped meeting privacy.

How to read the sources: desk benchmark compiled on `2026-11-19` from official vendor documentation and product pages (`[S-*]` in section 6). Vendor automation rates and tier boundaries are vendor claims unless verified in open-source repositories (Documenso, DocuSeal).

---

## 1. Global eSign Leaders: Everyday Operational Essentials & AI

### 1.1 DocuSign (Core eSignature + IAM / Iris AI / Navigator)

DocuSign splits its offering between **Core eSignature** (execution mechanics refined over two decades of SMB and mid-market usage) and **Intelligent Agreement Management (IAM)** powered by **Iris AI** and **Navigator** `[S-DS1, S-DS2, S-DS3]`.

- **Core eSignature operational essentials used weekly by SMBs `[S-DS1]`:**
  - **Parallel and sequential signing order:** mixing parallel recipients and numbered sequential turns (`routing_order`), plus `Signer`, `Approver`, and `CC` (`Receives a Copy`) roles.
  - **In-flight recipient correction ("Correct"):** fixing a typo in a pending signer's email address, name, or delivery method on an already-sent envelope **without voiding signatures already completed by earlier parties**. Without this, a single mistyped counterparty email forces the sender to void the whole contract and ask the first party's Director to sign again.
  - **Delegated signing ("Assign to someone else"):** allowing a recipient (for example, a customer's purchasing coordinator) to delegate signing authority to the actual authorized signatory (for example, `giamdoc@example.com`), recording both the delegator and the final signer in the audit certificate.
  - **Structured fields & supporting attachments:** `dropdown` and `radio` choice fields, **signer attachment fields** (requiring the counterparty to upload supporting documents such as a business license or ID card during the ceremony), **stamp** fields, and **reminders & expiration** schedules (automated pre-expiry nudges before links lapse).
- **DocuSign IAM, Iris AI & Navigator `[S-DS2, S-DS3]`:**
  - **Signer-facing AI Agreement Summary & Q&A:** Iris generates plain-language agreement summaries inside the signing ceremony so counterparties understand key commitments without legalese friction, alongside an interactive Q&A box over the contract text.
  - **Post-signature Navigator & Obligation Extraction:** once signed, Navigator parses static PDFs into structured agreement records (parties, effective date, expiration date, contract value, auto-renewal notice windows, payment and delivery obligations) pinned to source passages, driving proactive renewal alerts and obligation dashboards.
- **Ludy takeaway & security adaptation:**
  - Adopt in-flight recipient correction (`#3819`), audited signer delegation (`#3819`), dropdown/radio + signer attachments (`#3818`), stamp fields (`#3817`), pre-expiry reminders (`#3813`), and post-signature obligation/renewal extraction (`#3821`).
  - **Crucial security difference on signer summaries (`#3822`):** DocuSign runs live Iris Q&A for external signers inside its cloud SaaS. On a self-hosted or metered Business OS, exposing an unauthenticated live LLM endpoint on `/-/sign#<token>` creates an open budget-drain and prompt-injection surface. Instead, Ludy lets the authenticated sender review Vy's page-cited summary first and toggle `share_summary_with_signers = true`, serving a **human-approved static cited summary** on `/-/sign` with zero public LLM calls.

### 1.2 Documenso (Open-Source AGPL Reference)

Documenso is the closest open-source architectural peer to Ludy eSign (TypeScript, PostgreSQL, AGPL-3.0) `[S-DM1, S-DM2]`.

- **Direct Templates:** reusable 1-signer templates with a standing public link so counterparties self-initiate signing without waiting for the sender to create an individual envelope (shipped in Ludy Slice 2a `A1` as `/-/sign/d#<token>`).
- **Public Signing Profiles (`/-/sign/p/...` equivalent) `[S-DM2]`:** a clean public profile page per organization (analogous to Cal.com booking pages) listing opted-in public templates such as mutual NDAs, service intake forms, or visitor waivers in one shareable hub.
- **Saved Signatures:** workspace members store their preferred drawn or typed signature once and apply it in one click across internal approvals and counter-signatures.
- **AI Field Detection & CSC Remote CA:** optional AI field detection on uploaded PDFs and Cloud Signature Consortium (CSC) / X.509 certificate sealing.
- **Ludy takeaway:** adopt saved member signatures (`#3817`) and an opt-in public template hub (`/-/sign/p/$orgSlug`, `#3820`) built directly on Ludy's existing `template_direct_link` capability model with zero mandatory CAPTCHA (`#203`) and strict [ADR-0053](../adr/0053-per-org-app-enablement.md) `org_app_on('sign')` opaque `404` behavior.

### 1.3 DocuSeal (Open-Source Form-First Reference)

DocuSeal focuses on high-speed form completion, embedded document tags, and mobile/tablet signing `[S-DC1, S-DC2]`.

- **Structured choice & file upload fields `[S-DC1]`:** native `select` (`dropdown`), `radio`, `checkbox`, `initials`, `stamp`, and `file` (`attachment`) fields rendered cleanly on mobile viewports (`375px`+) and flattened into the sealed PDF.
- **Embedded `{{tag}}` placeholders `[S-DC1]`:** deterministic curly-brace tags inside source PDFs (`{{Field;type=signature;role=Signer1}}`, `{{...;type=select;options=...}}`) so generated documents place fields with 100% precision and zero AI cost (Ludy Slice 2a `A3` already parses `{{signature, r1}}`, `{{date, r1}}`, `{{text, r1}}` in `crove-extract` and extends cleanly to `dropdown` / `stamp` tags).
- **Mobile / Tablet In-Person Signing `[S-DC2]`:** a dedicated face-to-face mode allowing a staff member at a counter, clinic, showroom, or warehouse to hand a tablet or laptop to a customer to sign immediately on screen without requiring email access, while recording the host in the audit log.
- **Ludy takeaway:** adopt `dropdown`/`radio` + `attachment` fields (`#3818`) and **isolated In-Person Host Signing (`Ký trực tiếp tại quầy`, `#3820`)**, ensuring the handed-over screen runs strictly on the isolated `/-/sign#<token>` token route so the customer can never navigate back into `/o/$orgSlug/*` tenant screens.

### 1.4 PandaDoc (Quote/Proposal-to-Signature & Deal Velocity)

PandaDoc anchors e-signatures inside commercial revenue workflows rather than treating documents as isolated files `[S-PD1]`.

- **Quote and milestone handoffs:** 1-click transition from commercial quotes, proposals, and project deliverables into binding e-signatures, with status synced back to the deal record.
- **Signer attachments & in-person signing:** collecting required customer registration docs alongside the signature so Finance and Ops have complete compliance packs before invoicing.
- **Ludy takeaway:** extend Ludy's Slice 2b Engage quote handoff ([ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md)) to **Meeting Minutes (`#3811`)** and **Project Acceptance Minutes (`Biên bản nghiệm thu bàn giao`, `#3812`)** with a direct browser-carried bridge to `Ludy Kế toán` sales invoice drafts.

### 1.5 Dropbox Sign (Minimalist SMB UX)

Dropbox Sign (formerly HelloSign) remains a benchmark for low-cognitive-load SMB signing `[S-DB1]`.

- **Zero-clutter 3-step send:** upload -> place fields -> send, avoiding complex enterprise envelope wizards when defaults suffice.
- **Native signer attachment requests:** clear inline cards prompting signers to attach requested supporting PDFs/images before clicking Finish.
- **Ludy takeaway:** preserve Ludy eSign's uncluttered 3-step prepare screen (`1366x768` sidebar budget per [DESIGN.md](../../DESIGN.md)) even as Slice 4 adds power tools (`Ký nháy tất cả các trang`, `stamp`, `dropdown`, `attachment`) as quiet, single-click controls.

---

## 2. Vietnam SME eSign Leaders: `Ký nháy`, `Đóng dấu` & Suite Handoffs

### 2.1 MISA AMIS WeSign & FPT.eContract

In Vietnam, **MISA AMIS WeSign** `[S-MW1, S-MW2]` and **FPT.eContract** `[S-FP1]` define local SME expectations under the **Law on Electronic Transactions `20/2023/QH15`** and **Decree `23/2025/ND-CP`**:

1. **`Ký nháy từng trang` (Initial-All-Pages Workflow) `[S-MW1, S-FP1]`:**
   - On Vietnamese B2B service contracts, leases, construction/software SOWs, and multi-page appendices (often 10 to 30 pages), company practice requires drafting reviewers or both parties to place **initials (`ký nháy`) in the bottom corner of every preceding page (`1..N-1`)** to prevent page-substitution disputes before the legal representative signs page `N`.
   - Manually dragging 25 `initial` boxes onto pages `1..25` in generic Western eSign tools is tedious and misaligns margins. A **1-click `Ký nháy tất cả các trang`** helper that places aligned `initial` boxes across pages `1..N-1` turns a 5-minute chore into 1 second.
2. **`Đóng dấu doanh nghiệp / Chức danh` (Corporate & Title Red Stamp) `[S-MW1, S-FP1]`:**
   - Vietnamese commercial agreements visually pair the legal representative's signature with the organization's red circular seal (`con dấu pháp nhân`) or rectangular title stamp (`dấu chức danh Giám đốc`), applied either by the Director or an authorized clerk (`văn thư` / `admin`) alongside Remote Signing CA (`chữ ký số từ xa` via MISA eSign, VNPT SmartCA, Viettel MySign).
3. **Suite Handoffs (`Kế toán`, `Nhân sự`, `Công việc`) `[S-MW1]`:**
   - MISA AMIS WeSign wins Vietnamese SMEs not by isolated CLM complexity, but because HR labor contracts, sales quotes, acceptance minutes (`biên bản nghiệm thu`), and accounting e-invoices share one login and organization directory.
4. **Counterparty Supporting KYC Files (`Hồ sơ đính kèm`) `[S-FP1]`:**
   - Vietnamese B2B onboarding and freelancer (`cộng tác viên`) contracts routinely ask the counterparty to attach a scan/photo of **`CCCD`**, **`Giấy chứng nhận đăng ký doanh nghiệp (ĐKKD)`**, or **`Giấy ủy quyền`** (Power of Attorney when a Deputy Director signs) right inside the signing packet.

---

## 3. AI-Native Agreement & CLM Innovators

### 3.1 Agree.com ("Contract-to-Cash")

Agree.com reframes e-signature from a dead PDF archive into the starting gun for revenue collection `[S-AG1, S-AG2]`:

- **Frictionless eSign + structured term capture:** combines zero-friction signing with AI extraction of contract amounts, payment milestones, and billing schedules.
- **Direct bridge into invoicing & collections:** once an agreement or milestone sign-off is executed, extracted terms pre-populate invoice schedules and payment reminders instead of requiring Finance to re-key PDFs from email attachments.
- **Ludy adaptation (`#3812`, `#3821`):** in Vietnam, revenue invoicing on B2B projects hinges on a signed **`Biên bản nghiệm thu bàn giao`** (Project Acceptance Minute). Slice 3b (`#3812`) connects `Ludy Dự án` -> metered Vy deliverable bullet draft (`sign.acceptance_draft`, with 100% deterministic task-table fallback when AI is off) -> sealed eSign PDF -> 1-click [ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md) browser-carried handoff into a `Ludy Kế toán` sales invoice draft where a human confirms amounts and issues the VAT e-invoice. Slice 4e (`#3821`) extracts post-signature payment/delivery milestones and renewal dates (`sign.obligation_extract`) onto Vy's `Hôm nay` (`Today`) feed.

### 3.2 Juro (Browser-Native AI Contract Drafting for SMBs)

Juro targets lean business teams that lack a dedicated legal department `[S-JR1]`:

- **Browser-native drafting without Word plugins:** business users pick an approved starter template (NDA, service contract, consultancy agreement) in the browser and use AI with playbook guardrails to tailor scope, payment terms, and governing clauses before sending for signature.
- **Ludy adaptation (`#3822`):** many Vietnam OPCs and solo founders start from messy copy-pasted Word files found online. Slice 4f adds **Vietnamese SME Starter Contract Drafter (`Soạn hợp đồng mẫu`)** shipping clean built-in Vietnamese/bilingual templates (`NDA 2 chiều`, `Hợp đồng dịch vụ`, `Biên bản nghiệm thu`, `Biên bản thanh lý`, `Hợp đồng cộng tác viên`) that render clean A4 PDFs with embedded `{{signature, r1}}` / `{{date, r1}}` tags **100% offline when AI is off**, plus optional metered Vy clause customization (`sign.contract_draft`) marked `Đề xuất` for human review.

### 3.3 SpotDraft & Spellbook (Clause Risk Flagging & Counterparty Version Diffing)

SpotDraft and Spellbook focus on pre-signature review speed when counterparties return edited drafts `[S-SD1, S-SB1]`:

- **Clause risk flagging with exact citations:** surfacing unilateral termination, uncapped liability, auto-renewal traps, and jurisdiction shifts with exact quotes (already anchored in Ludy Slice 1c `sign.clause_summary`).
- **Counterparty version diffing (`Draft v1` vs `Counterparty PDF v2`):** in Vietnam SME deals, a client frequently edits a Word draft, exports a new PDF, and sends it back over Zalo without Track Changes enabled. Comparing two PDFs page-by-page by eye is error-prone.
- **Ludy adaptation (`#3822`, no Word add-in):** unlike Spellbook (which requires Microsoft Word desktop add-ins), Ludy Slice 4f runs **deterministic PDF text diffing (`So sánh bản sửa đổi`)** over `crove-extract` inspected page text (`100%` working with AI off), paired with an optional metered Vy commercial risk delta summary (`sign.version_diff`, `tools: []`) pinned to `{ pageNumber, quoteExcerpt }`.

### 3.4 Concord (Accessible SMB Post-Signature Renewal & Deadline Alerts)

Concord wins pragmatic SMBs with simple post-signature lifecycle hygiene `[S-CC1]`:

- **Renewal notice window tracking:** an office lease, SaaS vendor subscription, or annual maintenance contract (`bảo trì`) often auto-renews unless notice is given 30 days before `expiry_date`. Concord turns `effective_date`, `expiry_date`, and `renewal_notice_days` into automated deadline alerts.
- **Ludy adaptation (`#3821`, `#3813`):** following Finding 1 of [ai-first-reference-study.md](ai-first-reference-study.md) (*"put AI in a feed of things that need you, not in a chat window"*), Ludy surfaces deterministic pre-signature expiring/declined envelopes (`#3813`) and human-confirmed post-signature renewal notice windows (`<= 30` days) + overdue contract obligations (`#3821`) directly on Vy's **`Hôm nay` (`Today`)** screen alongside a **`Sắp gia hạn / Nghĩa vụ`** filter tab in `/o/$orgSlug/sign/envelopes`.

---

## 4. Benchmark Matrix Across Global, Vietnam & AI-Native Products

| Capability | DocuSign (+ IAM) | Documenso (OSS) | DocuSeal (OSS) | PandaDoc / Dropbox Sign | MISA WeSign / FPT.eContract | Agree / Juro / Concord | Ludy eSign (`sign`) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Self-hosted `docker compose up` (AGPL)** | No | Yes (AGPL) | Partial (open-core) | No | No (SaaS) | No (SaaS) | **Yes (Slice 1, 100% local stack)** |
| **Zalo / chat copy link (`#fragment`, no CAPTCHA)** | Email-first | Link available | Link available | Email-first | Email / SMS / app push | Email / portal link | **Yes (Slice 1, `/-/sign#<token>`)** |
| **Direct 1-signer link & Public Hub** | PowerForms + portal | Direct Templates + Profiles | Direct form links | Link forms | Template flows | Intake links | **Direct link (`Slice 2a`); Public Hub (`Slice 4d #3820`)** |
| **Vietnam `Ký nháy` 1-click all pages + `Stamp`** | Stamp yes; manual initials | Manual initials | Stamp + initials | Manual initials | **First-class `ký nháy` + `đóng dấu`** | Basic signature | **Yes (`Slice 4a #3817` + saved signatures)** |
| **`Dropdown`/`Radio` + Signer Attachments** | Yes | Basic fields | **Yes (form-first)** | **Yes (native attachments)** | Yes (`CCCD` / `ĐKKD` upload) | Form variables | **Yes (`Slice 4b #3818`, `ADR-0013` SHA-256)** |
| **In-flight recipient correction & Delegation** | **Yes (industry gold standard)** | Partial | Partial | Partial | Re-route / delegate | Partial | **Yes (`Slice 4c #3819`, hash-chained)** |
| **In-person host signing on tablet** | Yes | No dedicated host mode | **Yes (mobile in-person)** | Yes | Mobile app signing | No | **Yes (`Slice 4d #3820`, tenant-isolated)** |
| **Vietnam Remote Signing CA (`20/2023/QH15`)** | Partner integration | CSC generic | PKCS#12 | No VN public CA | **Yes (WeSign, VNPT, Viettel, FPT)** | No | **Yes (`Slice 2c` pluggable `packages/sign`)** |
| **Suite handoffs (Quotes, HR, Meetings, Projects -> Invoice)** | External connectors | Webhooks | Webhooks | Quotes -> Sign (PandaDoc) | **AMIS Kế toán / HRM** | **Agree: Sign -> Invoice** | **Slice 2b (Quotes/HR) + Slice 3a/3b (`#3811`, `#3812`)** |
| **Post-signature obligation & renewal alerts** | **IAM Navigator / Iris** | No | No | Renewal add-ons | Basic expiry | **Agree + Concord** | **Yes (`Slice 4e #3821` + Vy `Hôm nay`)** |
| **Signer summary, PDF version diff & Starter drafter** | Iris signer summary | AI field detect | No | Content library | Template library | **Juro drafter; SpotDraft/Spellbook diff** | **Yes (`Slice 4f #3822`, 100% AI-off fallbacks)** |

---

## 5. Strict Scope-Gate Filter ([scope.md](../product/scope.md))

### 5.1 Adopted in Slice 3 & Slice 4 (High-Frequency Monthly Vietnam OPC/SME Work)

Every item below passes all five [scope.md](../product/scope.md) checks: monthly OPC/SME relevance, zero-setup defaults on `docker compose up`, metered `packages/agent` AI with `tools: []` ([ADR-0018](../adr/0018-untrusted-content.md)), 100% AI-off deterministic parity, and explicit human approval.

| Slice & Issue | Monthly Vietnam OPC/SME Task | AI Part (`packages/agent` `AI_FEATURES`) | 100% AI-Off Deterministic Fallback & Human Gate |
| :--- | :--- | :--- | :--- |
| **Slice 3a** ([#3811](https://github.com/DOS/Ludy/issues/3811)) | Sign shared **Meeting Minutes** (`Ludy Notes -> Cuộc họp`) with clients/partners (`source_kind = 'meeting_minutes'`). | Reuses already-shared meeting minutes; zero extra LLM call required. | Generates clean A4 PDF 1.4 from shared summary/decisions/actions; enforces strict [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) reader-scoped confidentiality (`404` for non-readers); human sends. |
| **Slice 3b** ([#3812](https://github.com/DOS/Ludy/issues/3812)) | Sign **Project Acceptance Minutes** (`Biên bản nghiệm thu bàn giao` in `Ludy Dự án`) and open a **Finance sales invoice draft** ([ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md)). | `sign.acceptance_draft`: Vy summarizes completed project tasks into 3-5 tainted `Đề xuất` handover bullets verified against real task IDs/titles. | Populates acceptance deliverable table directly from completed project tasks when AI is off; human reviews/sends envelope and confirms amounts on the `Ludy Kế toán` invoice draft. |
| **Slice 3c** ([#3813](https://github.com/DOS/Ludy/issues/3813)) | Catch **expiring-soon (48h) & declined envelopes** on Vy `Hôm nay` (`Today`) + send **1 polite 24h pre-expiry email reminder**. | Pure deterministic rules (zero LLM cost, per [ai-first-reference-study.md](ai-first-reference-study.md) Finding 8). | Deterministic SQL/rule feed respecting `hr_contract` & `meeting_minutes` visibility and `org_app_on('sign')`; at most 1 automatic reminder email per pending email-mode signer. |
| **Slice 4a** ([#3817](https://github.com/DOS/Ludy/issues/3817)) | Place **corporate/title red stamps** (`stamp`), reuse **saved member signatures/stamps**, and **1-click `Ký nháy tất cả các trang`** (`1..N-1`). | Pure deterministic layout & validated PNG (`<= 256 KB`, no SVG) sealing in `crove-extract` `pdf_seal`. | Works 100% offline with AI off; `owner`/`admin` RBAC on `crove_sign.org_stamp`; human places and confirms. |
| **Slice 4b** ([#3818](https://github.com/DOS/Ludy/issues/3818)) | Collect **`dropdown` / `radio`** selections and verified **signer attachments** (`CCCD`, `Giấy ĐKKD`, `Giấy ủy quyền`). | Deterministic `{{dropdown, r1, ...}}` tags in `crove-extract` + manual field placer. | Magic-byte verified `<= 10 MB` PDF/PNG/JPEG stored in `crove_kernel.file` (`source = 'sign_attachment'`), SHA-256 recorded in `signing_event` + Audit Certificate. |
| **Slice 4c** ([#3819](https://github.com/DOS/Ludy/issues/3819)) | **Correct a mistyped recipient** in flight without voiding prior signers, or let a contact **delegate signing** to the Director. | Pure deterministic state transitions (`sign.signer.correct_recipient`, `POST /api/sign/delegate`). | Atomically revokes old tokens/OTPs, preserves prior signed fields, caps delegation at `<= 2` per signer (anti-mail-relay), and records `signer_corrected` / `signer_delegated` in `signing_event`. |
| **Slice 4d** ([#3820](https://github.com/DOS/Ludy/issues/3820)) | **In-person counter signing** (`Ký trực tiếp tại quầy`) on a shared tablet + **self-service public template hub** (`/-/sign/p/$orgSlug`). | Pure deterministic ceremony & public directory over opted-in direct-link templates. | Isolates device onto `/-/sign#<token>` with zero `/o/$orgSlug/*` navigation/cookie exposure; logs `host_user_id` + `in_person_signed`; opaque `404` when `sign` is off. |
| **Slice 4e** ([#3821](https://github.com/DOS/Ludy/issues/3821)) | Track **post-signature dates, contract value, auto-renewal notice windows (`<= 30d`), and milestones** on `/sign/envelopes` & Vy `Hôm nay`. | `sign.obligation_extract`: Vy proposes tainted `Đề xuất` dates, `NUMERIC(20,4)` decimal value, and obligations pinned to `{ pageNumber, quoteExcerpt }`. | Full manual entry/edit form on `crove_sign.envelope_obligation` when AI is off; deterministic quote verification; only human-confirmed obligations trigger Vy `Hôm nay` alerts. |
| **Slice 4f** ([#3822](https://github.com/DOS/Ludy/issues/3822)) | Share **sender-approved key-term summary** on `/-/sign`, **diff edited PDFs** (`v1` vs `v2`), and **draft Vietnamese SME starter contracts**. | `sign.version_diff` (commercial delta summary) + `sign.contract_draft` (clause customization), both `metered()` with `tools: []`. | Static sender-approved summary on `/-/sign` costs **zero public LLM calls**; page/clause text diff runs deterministically offline; 5 built-in VN starter templates generate tagged A4 PDFs offline when AI is off. |

### 5.2 Explicitly Out of Scope / Icebox ([scope.md](../product/scope.md))

The following enterprise, desktop-locked, or agency features seen in competitors fail the OPC/SME gate and stay **out of scope / Icebox** unless the owner explicitly reopens them:

1. **Bulk CSV mail-merge campaigns (`Bulk Send` to hundreds or thousands of recipients):** high mail-abuse risk ([ADR-0034](../adr/0034-outbound-email.md)) and rare in day-to-day B2B SME contracting; public self-service 1-signer templates (`/-/sign/d#<token>` and `/-/sign/p/$orgSlug`) cover standard waivers and intake forms cleanly.
2. **Enterprise CRM / ERP / HCM connectors (Salesforce, Workday, Coupa, SAP Ariba, NetSuite):** Ludy integrates natively with its own Teamwork, Engage, HR, and Finance apps in one database.
3. **Microsoft Word desktop COM / Office.js add-ins (Spellbook / legacy CLM pattern):** breaks browser-only `docker compose up` portability and Linux/mobile parity; Ludy drafts and diffs natively in the web app and `crove-extract`.
4. **Multi-department legal playbook & conditional routing builders:** multi-stage legal-ops workflow engines with conditional branching exceed a 1-to-20-person company's needs (`parallel` + `sequential` + `Signer`/`Approver`/`CC` + delegation cover SME reality).
5. **SAML / OIDC / SCIM enterprise signer identity federation:** already placed in the Icebox by [scope.md](../product/scope.md) section 1; email OTP and Slice 2c Vietnam Remote Signing CA (`VNPT SmartCA`, `Viettel MySign`, `MISA WeSign`) provide strong identity assurance for Vietnamese SMEs.
6. **White-label agency / multi-tenant reseller consoles:** excluded per [scope.md](../product/scope.md) section 1.
7. **Local OS USB hardware PKI token drivers / localhost native agent bridges (`USB Token` desktop signing):** brittle across macOS/Linux/mobile browsers and Zalo in-app webviews; certified digital signatures in Ludy use cloud Remote Signing CA adapters (`packages/sign`).

---

## 6. Sources Checked (`2026-11-19`)

| ID | Vendor / Product | Capability Referenced | Source Type (checked `2026-11-19`) |
| :--- | :--- | :--- | :--- |
| `S-DS1` | **DocuSign eSignature** | Signing order, Correct in-flight recipients, Delegated signing, Attachment & Stamp fields, Reminders/Expiration | Official DocuSign Support & eSignature product docs |
| `S-DS2` | **DocuSign IAM / Navigator** | Post-signature AI data extraction, renewal/termination window tracking, obligation management | Official DocuSign IAM & Navigator product pages |
| `S-DS3` | **DocuSign Iris AI** | AI-assisted agreement summaries and Q&A for signers and repository users | Official DocuSign Iris AI announcement & product docs |
| `S-DM1` | **Documenso** | AGPL architecture, Direct Templates, Saved Signatures, CSC / X.509 signing | Official Documenso docs & GitHub repository |
| `S-DM2` | **Documenso Profiles** | Public Signing Profiles landing page for standing self-service templates | Official Documenso Profiles documentation |
| `S-DC1` | **DocuSeal** | Structured `select`/`radio`/`file`/`stamp` fields and `{{Field;type=...}}` embedded PDF text tags | Official DocuSeal field & text-tag documentation |
| `S-DC2` | **DocuSeal In-Person** | Mobile/tablet face-to-face In-Person Signing mode | Official DocuSeal guides |
| `S-PD1` | **PandaDoc** | Quote/proposal-to-signature handoffs, signer file uploads, in-person signing | Official PandaDoc product docs |
| `S-DB1` | **Dropbox Sign** | Minimalist 3-step SMB send UX and native signer attachment requests | Official Dropbox Sign product overview |
| `S-MW1` | **MISA AMIS WeSign** | `Ký nháy`, `đóng dấu doanh nghiệp`, AMIS Kế toán / HRM handoffs, MISA eSign Remote Signing | Official MISA AMIS WeSign product pages |
| `S-MW2` | **Vietnam Legal Baseline** | Law on Electronic Transactions `20/2023/QH15` & Decree `23/2025/ND-CP` (`chữ ký điện tử` vs `chữ ký số công cộng`) | Referenced per [esign.md](../plan/esign.md) lawyer gate `#62` |
| `S-FP1` | **FPT.eContract** | Multi-step `ký nháy`, corporate stamp, counterparty KYC attachments, FPT.CA Remote Signing | Official FPT.eContract product documentation |
| `S-AG1` | **Agree.com** | Free eSignature + AI contract-to-cash extraction feeding automated invoicing & collections | Official Agree.com product & invoicing pages |
| `S-AG2` | **Agree.com** | Milestone/recurring billing schedules derived from signed agreements | Agree.com product overview & press summaries |
| `S-JR1` | **Juro** | Browser-native AI contract drafting and self-serve SMB template guardrails without Word plugins | Official Juro AI & comparison pages |
| `S-SD1` | **SpotDraft** | Third-party PDF review, clause risk flagging, and obligation tracking | SpotDraft product & comparison summaries |
| `S-SB1` | **Spellbook** | Clause risk detection and draft version comparison (Microsoft Word add-in model) | Spellbook product summaries |
| `S-CC1` | **Concord** | Accessible SMB post-signature repository and automated renewal/expiration deadline alerts | Concord & CLM comparison summaries |
