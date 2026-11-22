# Vietnam eSign Legal & Compliance Research (2025-2026)

Status: engineering and product compliance research, `2026-11-22` (Issue [#4437](https://github.com/DOS/Ludy/issues/4437), Epic [#3318](https://github.com/DOS/Ludy/issues/3318), Plan [#3319](https://github.com/DOS/Ludy/issues/3319)). Informs the owner-approved Slice 5 (`#4437` - `#4443`) architecture recorded in [esign.md](../plan/esign.md) and [esign.vi.md](../plan/esign.vi.md), and frames the formal Vietnamese legal counsel review tracked in [#62](https://github.com/DOS/Ludy/issues/62).

> `[commentary]` **Non-Overclaiming & Counsel Gate (`#62`):** This document summarizes statutory structure for software architecture, honest UI copy, and product scope decisions ([scope.md](../product/scope.md)). It is not legal advice. Before paid pilot billing or marketing claims on statutory digital signatures, a licensed Vietnamese lawyer reviews the 6-point checklist in Section 7 under owner-action issue [#62](https://github.com/DOS/Ludy/issues/62).

---

## 1. Law on Electronic Transactions `20/2023/QH15`

Passed by the National Assembly on `2023-06-22` and in force since **`2024-07-01`**, **Law `20/2023/QH15`** replaces the 2005 Law on Electronic Transactions as the foundational statute governing data messages (`thông điệp dữ liệu`), electronic signatures (`chữ ký điện tử`), electronic certificates, and electronic contracts (`hợp đồng điện tử`).

### 1.1 Non-Repudiation & Validity of Electronic Contracts (`Art. 8-12`, `Art. 34-36`)

- **Data-message legal validity (`Art. 8-12`):** Information in a data message cannot be denied legal value solely because it is expressed electronically (`Art. 8`). Where a law requires a document to be in writing (`văn bản`), a data message satisfies that requirement if the information contained therein is accessible and usable for subsequent reference (`Art. 9`), and satisfies integrity/original-form rules when reliably preserved from initial generation (`Art. 10-11`).
- **Electronic contract formation and non-repudiation (`Art. 34-36`):** An electronic contract (`hợp đồng điện tử`) concluded via data messages is legally binding and enforceable; neither party may repudiate execution solely because the contract was concluded electronically (`Art. 34-35`), provided Civil Code (`91/2015/QH13`) capacity, voluntary consent, and subject-matter conditions are met.
- **Freedom to agree on technical signing methods (`Art. 4.2`, `Art. 36.2`):** Unless a specialized statute mandates a specific signature tier (such as tax e-invoices, statutory electronic labor contracts, or notarized real-estate deeds), contracting parties in civil and commercial transactions have full autonomy to agree on the technical means used to express consent and verify integrity.

### 1.2 Electronic Signatures vs Other Electronic Confirmation Methods (`Art. 22-23`)

Law `20/2023/QH15` draws a strict statutory distinction that directly shapes how Ludy eSign names and positions its signing modes:

1. **Three statutory electronic signature categories (`Art. 22.1-22.3`):**
   - **Dedicated electronic signatures (`chữ ký điện tử chuyên dùng`):** created and managed by an agency or organization for its own specialized activities, subject to reliability rules (and NEAC registration when classified as a secure dedicated e-signature `chữ ký điện tử chuyên dùng bảo đảm an toàn`).
   - **Public digital signatures (`chữ ký số công cộng`):** asymmetric cryptographic signatures backed by a digital certificate issued by a licensed public Certificate Authority (`CA`) for commercial/public use (`Art. 22.1(b)`, `Art. 23` - equivalent in legal weight to a wet-ink individual signature and corporate seal where applicable).
   - **Civil-service dedicated digital signatures (`chữ ký số chuyên dùng công vụ`):** issued for state agencies and public officials (outside commercial software scope).
2. **"Other electronic confirmation methods" (`Art. 22.4` - `các hình thức xác nhận khác bằng phương tiện điện tử`):**
   - `Art. 22.4` explicitly classifies electronic confirmation mechanisms that do not meet `Art. 22.1-22.3` cryptographic signature criteria - such as **scanned/drawn/typed signature images, one-time passwords (email/SMS OTP), clickwrap consent checkboxes, PINs, or biometric taps** - as **electronic confirmation methods**, governed by relevant laws and party agreement rather than called statutory digital signatures.

### 1.3 Product Mapping in Ludy eSign

- **Self-contained signing (`Slice 1` - `Slice 4`):** Drawn/typed PNG signatures + explicit electronic transaction consent checkbox (`consent_accepted_at`) + optional 6-digit email OTP ([ADR-0034](../adr/0034-outbound-email.md)) + tamper-evident SHA-256 PDF flattening + hash-chained `crove_sign.signing_event` + standalone `certificate.json` ([ADR-0013](../adr/0013-evidence-storage-and-integrity.md)) operate under **`Art. 22.4` electronic confirmation + `Art. 4.2` / `Art. 34-36` commercial contract autonomy**. This covers everyday OPC/SME commercial quotes, NDAs, SOWs, vendor orders, shared meeting minutes (`#3811`), and project acceptance minutes (`#3812`).
- **Licensed public CA signing (`Slice 2c` `@ludy/sign`):** Integrates licensed Vietnamese Remote Signing CAs (`VNPT SmartCA`, `Viettel MySign`, `MISA eSign`) embedding detached CMS/PKCS#7 PAdES-LTV signatures for agreements where parties require **`Art. 22.1(b)` / `Art. 23` public digital signatures (`chữ ký số công cộng`)**.
- **UI wording rule:** Ludy never labels a drawn/typed Slice 1 signature as `"Chữ ký số"` (`Digital signature`); UI copy consistently distinguishes `"Chữ ký điện tử / Xác nhận điện tử"` from `"Chữ ký số PAdES (CA)"`.

---

## 2. Decree `23/2025/ND-CP` on Electronic Signatures & Trust Services

Issued by the Government on `2025-02-21` and effective **`2025-04-10`**, **Decree `23/2025/ND-CP`** implements Law `20/2023/QH15` with technical, operational, and licensing rules for non-government electronic signatures and **Trust Services (`dịch vụ tin cậy`)**.

### 2.1 Regulated Trust Services (`Dịch vụ tin cậy`)

Decree `23/2025/ND-CP` regulates three licensed trust services overseen alongside the National Electronic Authentication Center (`NEAC` - `rootca.gov.vn`):

1. **Timestamping service (`dịch vụ cấp dấu thời gian` - TSA):** cryptographically binding a trusted national time source to a data message.
2. **Data-message authentication service (`dịch vụ chứng thực thông điệp dữ liệu`):** statutory third-party attestation of data-message integrity, origin, and transmission/receipt.
3. **Public digital signature certification service (`dịch vụ chứng thực chữ ký số công cộng`):** issuing and managing X.509 digital certificates for individuals and organizations.

It also governs registration of **secure dedicated electronic signatures (`chữ ký điện tử chuyên dùng bảo đảm an toàn`)** when an organization operates its own closed-loop statutory e-signature system rather than relying on `Art. 22.4` party-agreed confirmation or a public CA.

### 2.2 High Licensing Bar for Operating as a Trust Service Provider (TSP)

Operating any of the three trust services above requires a Ministry license (valid up to **10 years**) with capital-heavy infrastructure requirements:

- **Financial solvency:** a bank deposit at a commercial bank operating in Vietnam of **at least 10 billion VND per 300,000 subscribers, and never less than 10 billion VND** (or equivalent liability insurance / guarantee per statutory terms) to cover subscriber compensation and system handover risks.
- **Information security & infrastructure:** **Level 3 information system security (`an toàn hệ thống thông tin cấp độ 3`)** approval, compliant hardware security modules (`HSM`), redundant domestic data-center operations, and technical connection to NEAC (`rootca.gov.vn`).
- **Qualified personnel:** dedicated full-time personnel holding degrees and certifications in information security, cryptography, or telecommunications.

### 2.3 Why Standard B2B Software Integration Needs No TSP License

- **Ludy's architectural role:** Ludy is open-source (AGPL-3.0) and cloud-hosted B2B Business OS application software (`phần mềm ứng dụng quản trị doanh nghiệp`). Ludy **consumes** licensed CA/TSA APIs (`VNPT SmartCA`, `Viettel MySign`, `MISA eSign`) using the customer's own subscriber credentials in `crove_sign.ca_connection`, and embeds the CA-returned CMS signature/timestamp token into the PDF via `crove-extract`.
- **No certificate issuance or statutory attestation by Ludy:** Because Ludy neither issues digital certificates, sells TSA tokens of its own, nor issues statutory data-message authentication certificates, integrating licensed CA APIs requires **zero TSP license or sublicense**.
- **Strict product guardrail:** Ludy's built-in `certificate.json` and appended PDF summary page are presented strictly as an **application-level cryptographic audit log (`Chứng nhận kiểm toán giao dịch điện tử`)** backed by SHA-256 file hashes and UTC+7 server timestamps, never marketed as a licensed `Decree 23/2025/ND-CP` timestamping (`TSA`) or data-message authentication trust service.

---

## 3. Decree `85/2021/ND-CP` (MOIT CeCA) vs Standard eSign Software

**Decree `85/2021/ND-CP`** (amending Decree `52/2013/ND-CP` on e-commerce) regulates **Certified eContract Authorities (`Tổ chức cung cấp dịch vụ chứng thực hợp đồng điện tử` - CeCA)** registered with the **Ministry of Industry and Trade (`MOIT` / `ceca.gov.vn`)** and connected to the **Vietnam National eContract Development Axis (`Trục phát triển hợp đồng điện tử Việt Nam`)**.

- **CeCA registration vs application software:** A MOIT-accredited CeCA acts as an independent statutory third party verifying and stamping the integrity of commercial e-contracts on the national axis (often branded with a "tick xanh" CeCA mark by licensed providers such as VNPT, Viettel, FPT, or MISA).
- **Commercial B2B reality for OPCs and SMEs:** Under the Civil Code (`91/2015/QH13`), the Commercial Law (`36/2005/QH11`), and Law `20/2023/QH15`, bilateral commercial contracts (service agreements, quotes, NDAs, purchase orders, acceptance minutes) are legally valid between the contracting parties **without** routing through a MOIT CeCA, whether signed via agreed `Art. 22.4` electronic confirmation or signed directly with licensed `Art. 23` public CA digital signatures (`VNPT SmartCA`, `Viettel MySign`, `MISA eSign`).
- **Ludy boundary:** Standard eSign workflow software integrating licensed CAs does **not** require MOIT CeCA registration. Ludy never claims MOIT CeCA accreditation (`Tổ chức chứng thực hợp đồng điện tử đăng ký với Bộ Công Thương`); if enterprise customers later request optional CeCA-axis stamping, it can sit alongside `@ludy/sign` as an external licensed provider adapter.

---

## 4. Decree `337/2025/ND-CP` (`2025-12-24`) on Electronic Labor Contracts

Issued by the Government on **`2025-12-24`** and effective **`2026-01-01`**, **Decree `337/2025/ND-CP`** implements the Labor Code (`45/2019/QH14`, `Art. 14`) and Law `20/2023/QH15` specifically for **electronic labor contracts (`hợp đồng lao động điện tử`)**.

### 4.1 Five Cumulative Statutory Requirements for Electronic Labor Contracts

Under Decree `337/2025/ND-CP`, an electronic labor contract holds full statutory equivalence to a wet-ink paper labor contract (for labor inspection, BHXH/tax audits, and labor dispute adjudication) only when it satisfies **all five** statutory pillars:

1. **Lawful digital signatures (`chữ ký số`) by both parties:** Both the employer's authorized representative and the employee must sign using a lawful digital signature (`chữ ký số`) under electronic transaction law (for example, corporate CA + employee personal Remote Signing CA / VNeID-linked CA), not a plain drawn/typed image alone.
2. **Trusted timestamp (`dấu thời gian`):** Digital signatures on the electronic labor contract must carry a trusted timestamp (`TSA`) establishing exact execution time and post-signing integrity.
3. **Authentication by a qualified `eContract` provider (`Nhà cung cấp eContract`):** The contract data message must be authenticated on an eContract system meeting Decree `337/2025/ND-CP` technical, security, and trust-service connectivity conditions.
4. **Verified subject identification (`định danh chủ thể`):** Employer and employee identities must be verified against statutory credentials (`CCCD` / `Thẻ căn cước`, **`VNeID` Level 2** electronic identification account, or valid passport/work permit for foreign employees).
5. **Ministry of Home Affairs national platform ID within 24 hours (`Nền tảng hợp đồng lao động điện tử` - `Bộ Nội vụ`):** Within **24 hours** after the final party applies their digital signature, the `eContract` provider must transmit the prescribed contract record to the **National Electronic Labor Contract Platform** managed by the **Ministry of Home Affairs (`Bộ Nội vụ`)** so the contract is assigned an official **national electronic labor contract ID (`mã định danh ID`)**.

### 4.2 Honest Scope & Slice 5a (`#4439`) UX Compliance Notice in Ludy

- **What Ludy supports today:**
  - Strict HR confidentiality (`source_kind = 'hr_contract'`, `owner` / `admin` / `created_by` access only per Slice 2b `A4`).
  - Internal HR documents that are **not** statutory labor contracts under `Art. 14` of the Labor Code (offer letters, onboarding checklists, NDA/IP addenda, equipment handover sheets, internal policy acknowledgments, CTV/freelance service contracts governed by the Civil Code).
  - Preliminary electronic confirmation or bilateral public CA PAdES signing (`@ludy/sign`) when the employer still executes a wet-ink paper original or archives a paper counterpart.
- **What Ludy does NOT yet perform:** Ludy is not an accredited `Decree 337/2025/ND-CP` `eContract` provider connected to the Ministry of Home Affairs national platform to mint 24-hour national eContract IDs (`mã định danh ID`).
- **Slice 5a (`#4439`) product safeguard:** Every `source_kind = 'hr_contract'` envelope detail view (`/o/$slug/sign/envelopes/$id`) and HR send-to-sign dialog renders a calm, plain-Vietnamese/English legal guidance notice summarizing `Decree 337/2025/ND-CP` (CA + timestamp + licensed eContract authentication + Ministry of Home Affairs national ID) so SME owners and HR managers never mistakenly treat a standalone drawn/OTP envelope as a Ministry-registered statutory electronic labor contract.

---

## 5. Personal Data Protection (`Law 91/2025/QH15`) & Data Localization (`Decree 53/2022/ND-CP`)

### 5.1 Personal Data Protection Law `91/2025/QH15` (`PDPL`, Effective `2026-01-01`)

Passed on `2025-06-26` and effective **`2026-01-01`** (elevating and expanding Vietnam's prior Decree `13/2023/ND-CP` framework), **Law `91/2025/QH15`** governs every stage of personal data processing inside eSign workflows:

- **Personal data categories in `crove_sign`:**
  - **Basic personal data:** signer full name (`signer.name`), email (`signer.email`), phone (`signer.phone`), role title, organization name, User-Agent, and keyed HMAC-SHA256 IP digest (`signer_ip_hash`).
  - **Sensitive / high-care identity documents (Slices 4b & 5e):** handwritten/typed signature images (`signature_storage_key`), citizen ID scans (`CCCD` / `Thẻ căn cước`), Powers of Attorney (`Giấy ủy quyền`), business registration certificates (`Giấy ĐKKD`), and employment terms (`hr_contract`).
- **Architectural controls enforced across Slices 1-5:**
  1. **Explicit, recorded pre-sign consent:** `sign.public.submit` requires explicit opt-in consent (`consent_accepted_at`) before accepting any signature or attachment.
  2. **Zero raw IP or secret persistence:** client IPs are keyed-HMAC hashed (`crove_sign.public_keyed_ip_hash`); raw signing tokens and 6-digit OTPs are never persisted in PostgreSQL or background queues (`token_sha256`, `otp_sha256` only).
  3. **Strict confidentiality & surface exclusion:** `hr_contract` (`owner`/`admin`/`created_by`) and [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) `meeting_minutes` reader scopes are enforced in PostgreSQL RLS, `can_read_sign_file`, Vault Q&A (`#4439`), Playbook checks (`#4442`), and KYC checks (`#4443`), and **completely excluded** from org-wide outbound webhooks (`#4440`), MCP `ludy.read` tools (`#4441`), and external `/api/v1/sign/*` REST keys (`#4441`).
  4. **Deterministic erasure & legal retention (`PERSONAL_DATA_COLUMNS` + `org_purge`):** draft/voided envelopes, expired tokens/OTPs (`sign-cleanup` after 30 days), and Slice 5e `crove_sign.kyc_check` findings (`handling: 'erase'`) purge cleanly, while completed commercial contract evidence uses `keep_legal` subject to `#62` counsel confirmation.
  5. **AI containment ([ADR-0018](../adr/0018-untrusted-content.md)):** every AI call runs through `packages/agent` (`withAiScope` + `metered()`, `tools: []`), never runs on unauthenticated public routes, and remains 100% optional (`AI-off` parity).

### 5.2 Decree `53/2022/ND-CP` (Law on Cybersecurity Data Localization)

- **Commercial hosted service (`Ludy Cloud`):** Under the Law on Cybersecurity (`24/2018/QH14`) and **Decree `53/2022/ND-CP`**, domestic cloud operators providing regulated online services in Vietnam store account, relationship, and user-generated personal data on infrastructure physically located in Vietnam (implemented in the private `crove-cloud` deployment layer per [ADR-0027](../adr/0027-oss-core-and-crove-cloud.md), including database, S3-compatible [ADR-0013](../adr/0013-evidence-storage-and-integrity.md) evidence buckets, and AI gateway routing).
- **Self-hosted open-source (`docker compose up`):** Vietnamese OPCs and SMEs self-hosting Ludy on an on-premise server or domestic Vietnam VPS retain 100% local custody of PostgreSQL and blob storage with zero external DOS telemetry.

---

## 6. Vietnam SME Agreement Matrix (What to Use When)

| Agreement / Document Type | Governing Law | Minimum Valid Method in Vietnam | Ludy eSign Tier & UX Guidance |
| :--- | :--- | :--- | :--- |
| **B2B quotes, service contracts, SOWs, NDAs, agency retainers** | Civil Code `2015`, Commercial Law `2005`, Law `20/2023/QH15` (`Art. 4.2`, `22.4`, `34-36`) | Party-agreed electronic confirmation (`Art. 22.4`) or Public CA (`Art. 23`) | **Supported out of the box:** Slice 1-4 draw/type + email OTP + SHA-256 Audit Certificate, or Slice 2c Public CA (`VNPT`, `Viettel`, `MISA`) + Slice 4a `ký nháy` / `stamp`. |
| **Project acceptance & handover minutes (`Biên bản nghiệm thu`, `#3812`)** | Commercial Law `2005`, Law `20/2023/QH15` | Party-agreed electronic confirmation or Public CA (supports VAT invoice issuance in `Ludy Kế toán`) | **Supported out of the box:** Slice 3b (`#3812`) -> `Ludy Kế toán` sales invoice draft bridge ([ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md)). |
| **Freelancer / CTV service contracts (`Hợp đồng dịch vụ / CTV`)** | Civil Code `2015` (`Art. 513`), Law `20/2023/QH15` | Party-agreed electronic confirmation + `CCCD` / tax code KYC attachment | **Supported out of the box:** Slice 4b (`#3818`) `attachment` + Slice 4f (`#3822`) CTV starter template + Slice 5e (`#4443`) KYC check. |
| **Internal HR notices, offer letters, NDA/IP addenda, asset handovers** | Internal governance / Civil Code `2015` | Electronic confirmation (`Art. 22.4`) with `hr_contract` confidentiality | **Supported out of the box:** Slice 2b (`A4` strict `owner`/`admin`/`created_by` access). |
| **Statutory Labor Contracts (`Hợp đồng lao động điện tử`, `Art. 14` Labor Code)** | Labor Code `2019`, **Decree `337/2025/ND-CP`** (eff. `2026-01-01`) | Employer & employee **CA digital signatures + TSA timestamp + qualified eContract auth + Ministry of Home Affairs national ID within 24h** | **Compliance banner in Slice 5a (`#4439`):** Ludy displays explicit `Decree 337/2025/ND-CP` guidance on `hr_contract` envelopes; full paperless replacement requires a Ministry-connected eContract channel or paper counterpart. |
| **VAT e-Invoices, Tax, Customs & BHXH Statutory Filings** | Law on Tax Administration, Decree `123/2020/ND-CP` & `70/2025/ND-CP` | Licensed Public CA + GDT/BHXH dedicated transmission (`@ludy/einvoice`) | Handled in **`Ludy Kế toán` / `Ludy Nhân sự`**, never via generic PDF eSign. |
| **Notarized Real Estate, Land Use Rights, Marriage/Inheritance Deeds** | Land Law `2024`, Law on Notarization `2024`, Law `20/2023/QH15` (`Art. 19`) | Statutory notarization / authenticated public registry procedure | **Out of scope** for commercial eSign software. |

---

## 7. Lawyer `#62` Sign-Off Checklist (Owner-Action Gate Before Paid Pilot)

Before enabling paid billing on `Ludy Cloud` eSign or publishing legal compliance statements on `ludy.vn/esign`, Vietnamese legal counsel under [#62](https://github.com/DOS/Ludy/issues/62) should review and sign off on these six concrete items:

1. **Ceremony Consent & `Art. 22.4` Disclosure Wording (`/-/sign`):** Approve the exact Vietnamese and English checkbox text (`"Tôi đồng ý giao dịch và xác nhận tài liệu này bằng phương thức điện tử..."`) so parties unambiguously agree to `Art. 22.4` electronic confirmation and SHA-256 evidence records under Law `20/2023/QH15`.
2. **Audit Certificate Naming under Decree `23/2025/ND-CP`:** Confirm that titling Ludy's appended summary page `"Chứng nhận kiểm toán giao dịch điện tử"` (`Electronic Transaction Audit Certificate`) with an explicit note distinguishing application SHA-256 hashes from licensed `Decree 23/2025/ND-CP` TSA / data-message authentication trust services avoids any regulatory ambiguity.
3. **Decree `337/2025/ND-CP` HR Banner Copy (`Slice 5a`, `#4439`):** Approve the exact `hr_contract` banner copy explaining the 5-pillar statutory requirement (CA + timestamp + qualified eContract provider + VNeID/CCCD identification + 24-hour Ministry of Home Affairs national eContract ID) and clarifying when employers must retain wet-ink originals or use a Ministry-connected eContract provider.
4. **PDPL `Law 91/2025/QH15` Retention vs Erasure (`keep_legal` vs `erase`):** Confirm statutory retention periods (typically 10 years for accounting/commercial vouchers under the Law on Accounting `88/2015/QH13`) allowing `keep_legal` preservation of sealed commercial PDFs and `signing_event` logs when a counterparty requests personal data deletion, while erasing unsealed drafts and Slice 5e `kyc_check` review artifacts on schedule.
5. **PDPL Counterparty Privacy Notice & KYC Attachments (`Slices 4b & 5e`):** Approve the concise privacy notice shown when a signer uploads `CCCD`, `Giấy ủy quyền`, or `Giấy ĐKKD` on `/-/sign`, and confirm whether `Ludy Cloud` acts solely as a **Personal Data Processor (`Bên xử lý dữ liệu cá nhân`)** on behalf of the tenant **Controller (`Bên kiểm soát dữ liệu cá nhân`)** in the `Ludy Cloud` DPA (`Hợp đồng xử lý dữ liệu`).
6. **`Ludy Cloud` DPIA / Cross-Border AI Gateway Filing (`Law 91/2025/QH15` & `Decree 53/2022/ND-CP`):** Confirm domestic Vietnam hosting posture for `crove_sign` PostgreSQL + S3 evidence buckets in `crove-cloud`, and confirm whether tenant-initiated Vy contract analysis (`sign.field_propose`, `sign.clause_summary`, `sign.vault_qa`, `sign.playbook_check`, `sign.kyc_check`) requires a Cross-Border Data Transfer Impact Assessment (`TIA`) when routed to an overseas model endpoint vs a domestic/self-hosted model endpoint.

---

## 8. Primary Statutory & Regulatory References

- **Law `20/2023/QH15`:** Law on Electronic Transactions (`Luật Giao dịch điện tử`), passed `2023-06-22`, effective `2024-07-01`.
- **Decree `23/2025/ND-CP`:** Government Decree regulating electronic signatures and trust services (`Quy định về chữ ký điện tử và dịch vụ tin cậy`), issued `2025-02-21`, effective `2025-04-10`.
- **Decree `85/2021/ND-CP`:** Government Decree amending Decree `52/2013/ND-CP` on e-commerce (`Hoạt động chứng thực hợp đồng điện tử - CeCA`, MOIT).
- **Decree `337/2025/ND-CP`:** Government Decree regulating electronic labor contracts (`Quy định về hợp đồng lao động điện tử`), issued `2025-12-24`, effective `2026-01-01`.
- **Law `91/2025/QH15`:** Law on Personal Data Protection (`Luật Bảo vệ dữ liệu cá nhân`), passed `2025-06-26`, effective `2026-01-01`.
- **Decree `53/2022/ND-CP`:** Government Decree detailing a number of articles of the Law on Cybersecurity (`24/2018/QH14`), issued `2022-08-15`.
- **Commercial Law `36/2005/QH11` (`Art. 301`) & Civil Code `91/2015/QH13`:** commercial contractual penalty cap (`<= 8%` of breached obligation value) and general contract validity rules referenced in Ludy Slice 5d (`#4442`) default SME playbook rules.
