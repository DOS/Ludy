# Ludy eSign Plan (`sign`)

- **Status:** Draft plan (2026-11-15; Slice 2 decisions updated 2026-11-17; Slice 3 & Slice 4 decisions updated 2026-11-19)
- **Epic:** https://github.com/DOS/Ludy/issues/3318
- **Plan Issue:** https://github.com/DOS/Ludy/issues/3319
- **Milestone / Priority:** `M3 Paid pilot` / `priority:P2`
- **Vietnamese summary:** [esign.vi.md](esign.vi.md)
- **References:** [scope.md](../product/scope.md), [competitors.md](../product/competitors.md), [esign-competitors-and-ai-2026.md](../research/esign-competitors-and-ai-2026.md), [crove-os-kernel.md](crove-os-kernel.md) (section 5.7, section 13 Phase 6), [meetings.md](meetings.md), [projects.md](projects.md), [vy.md](vy.md), [crm-quotes.md](crm-quotes.md), [backlog-review-2026-10-17.md](backlog-review-2026-10-17.md), [DESIGN.md](../../DESIGN.md), [AGENTS.md](../../AGENTS.md), [ADR-0013](../adr/0013-evidence-storage-and-integrity.md), [ADR-0018](../adr/0018-untrusted-content.md), [ADR-0031](../adr/0031-module-enablement.md), [ADR-0034](../adr/0034-outbound-email.md), [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md), [ADR-0049](../adr/0049-member-scoped-vy.md), [ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md), [ADR-0053](../adr/0053-per-org-app-enablement.md)

## Executive Decisions (JOY, 2026-11-15)

1. **Signature model (Slice 1 vs Slice 2):** Slice 1 ships self-contained, Documenso-style electronic signatures (draw or type signature, optional email OTP via [ADR-0034](../adr/0034-outbound-email.md), tamper-evident SHA-256 PDF sealing, and an independent audit certificate) running 100% locally on `docker compose up` with zero external provider accounts or API keys. Vietnamese public Certificate Authorities (VNPT SmartCA, Viettel MySign, MISA WeSign) sit behind a pluggable provider boundary in Slice 2.
2. **App shell and AI coworker:** Ludy eSign is its own toggleable app (`Ky ket` in Vietnamese / `eSign` in English, stored with `Ký kết` in UI copy) in the app switcher under per-org module enablement ([ADR-0031](../adr/0031-module-enablement.md), [ADR-0053](../adr/0053-per-org-app-enablement.md)). **Vy** (`gm`, Ludy's cross-app coworker and assistant per [DESIGN.md](../../DESIGN.md) section 1.1) reads uploaded PDFs, proposes signature/initial/date/text field placements, and summarizes key or risky clauses through the `packages/agent` budget meter. Core signing works identically when AI is off, and a human explicitly reviews fields and triggers every send.
3. **Slice 1 boundary:** Upload PDF, place fields (with Vy proposals), send signing links via copyable Zalo/chat URL or transactional email for 1 or N signers (parallel or sequential routing), complete signing on a public mobile-friendly page (`/-/sign#<token>`, `Referrer-Policy: no-referrer`, single-use replay rejection, optional email OTP, and **no mandatory third-party CAPTCHA** per Decision `#203`), and export the sealed PDF + audit certificate stored via [ADR-0013](../adr/0013-evidence-storage-and-integrity.md). Reusable templates and Engage quote ([ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md)) / HR labor contract handoffs are deferred to Slice 2.

### Slice 2 Decisions (JOY, 2026-11-17)

1. **A1 - Direct Signing Links (`/-/sign/d#<token>`) on 1-signer templates:** Orgs can enable a shareable public direct signing link `/-/sign/d#<token>` on a 1-signer template (`crove_sign.template_direct_link`, `MACHINERY` table storing `token_sha256` only; zero plaintext token stored). Recipients open `/-/sign/d#<token>` to load template metadata (`POST /api/sign/direct/view`) and the template PDF (`POST /api/sign/direct/pdf`), optionally verify a 6-digit email OTP (`POST /api/sign/direct/otp/request`, `POST /api/sign/direct/otp/verify`), and start a self-service signing session (`POST /api/sign/direct/start`) that materializes an envelope + signer from the template and returns a single-use submit token without storing any plaintext token. Protected by per-IP and per-token/email rate limits, `org_app_on(org_id, 'sign')` + entitlement opaque `404`, `Referrer-Policy: no-referrer`, and zero mandatory CAPTCHA (`#203`).
2. **A2 - Template Roles (`Signer` / `Approver` / `CC`), Dedicated Approval UI & Sealed Email Attachments:** Templates and envelopes support three distinct recipient role kinds (`signer_role IN ('signer', 'approver', 'cc')`): `Signer` (requires signature/input fields), `Approver` (dedicated lightweight approval ceremony UI to approve or decline without drawing a signature), and `CC` (view-only recipient notified upon completion with zero fields or signing turn). Upon completion, [ADR-0034](../adr/0034-outbound-email.md) notification emails attach the SHA-256 sealed PDF and Audit Certificate PDF when within a strict attachment size cap, falling back cleanly to portal download links when oversized.
3. **A3 - Deterministic PDF Text Tags (`crove-extract`) & Matching Audit Certificate Page Size:** Support deterministic placeholder text tags embedded inside uploaded PDFs (`{{signature, r1}}`, `{{date, r1}}`, `{{text, r1}}`, mapped to template/signer roles such as `r1`), parsed strictly inside the isolated `crove-extract` sandbox ([ADR-0018](../adr/0018-untrusted-content.md)) with 100% AI-off parity (zero LLM calls needed). Additionally, `crove-extract` `pdf_seal` sizes the appended Audit Certificate summary page to match the dimensions of the document's last page rather than hardcoding A4.
4. **A4 - Strict Visibility on `hr_contract` Envelopes (`source_kind = 'hr_contract'`):** Envelopes linked to HR labor contracts (`source_kind = 'hr_contract'`) enforce strict visibility limited to `owner`, `admin`, and the envelope's `created_by` creator across list/detail queries, commands, and file download gates, aligning with Ludy's salary/HR confidentiality boundary so other members with `sign` access cannot view or download another employee's HR contract envelope.

## Executive Decision (JOY, 2026-11-17)

- **Bilingual app name & public landing page:** Per owner decision on `2026-11-17` (superseding the `Ký kết` switcher label in Decision 2 above), the product category and app name is **Ludy eSign** across both Vietnamese and English (matching **Ludy Engage** and **Ludy AI**), with app switcher label `eSign`, menu header `{brand} eSign`, and public marketing page `ludy.vn/esign` (`enRoute: '/en/esign'`). Inner screen and page titles stay in Vietnamese (`Hồ sơ ký`, `Xác minh tệp`, `Ký kết tài liệu`).

### Slice 3 & Slice 4 Decisions (JOY, 2026-11-19)

Per owner instruction on `2026-11-19` informed by the global, Vietnam SME, and AI-native competitive benchmark in [esign-competitors-and-ai-2026.md](../research/esign-competitors-and-ai-2026.md) ([#3810](https://github.com/DOS/Ludy/issues/3810)), Ludy eSign proceeds non-stop through **Slice 3** (cross-suite handoffs & proactive Vy `Hôm nay` surfacing) and **Slice 4** (everyday operational parity, Vietnam `ký nháy` / `đóng dấu` essentials, and AI-native agreement lifecycle), split into 9 end-to-end vertical slices (`M3 Paid pilot` / `priority:P2`, detailed in section 8):

1. **Slice 3 - Suite Handoffs & Proactive Vy `Hôm nay` (`#3811`, `#3812`, `#3813`):**
   - **Slice 3a ([#3811](https://github.com/DOS/Ludy/issues/3811)) - Shared Meeting Minutes -> eSign:** one-click `Ký xác nhận qua eSign` from explicitly shared meeting minutes in `Ludy Notes -> Cuộc họp` (`source_kind = 'meeting_minutes'`, `source_id = meeting.id`, zero cross-module hard FKs), enforcing strict [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) / [ADR-0049](../adr/0049-member-scoped-vy.md) reader-scoped confidentiality (`404` zero-existence-oracle parity for non-readers, including `owner`/`admin` on attendees-only meetings where they were not shared).
   - **Slice 3b ([#3812](https://github.com/DOS/Ludy/issues/3812)) - Project Acceptance Minutes -> eSign -> Finance Invoice Draft:** one-click `Lập biên bản nghiệm thu` (`source_kind = 'project_acceptance'`, `source_id = project.id`) from `Ludy Dự án`, optional metered Vy deliverable bullet draft (`sign.acceptance_draft`, 100% deterministic completed-task table fallback when AI is off), and a one-click [ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md) browser-carried handoff from a sealed acceptance envelope into a `Ludy Kế toán` sales invoice draft.
   - **Slice 3c ([#3813](https://github.com/DOS/Ludy/issues/3813)) - Vy `Hôm nay` Alerts & Single 24h Pre-Expiry Reminder:** deterministic surfacing (zero LLM cost) of pending envelopes expiring within 48h and unacknowledged declined envelopes on Vy's `Hôm nay` (`Today`) screen respecting `hr_contract` / `meeting_minutes` visibility and `org_app_on(org_id, 'sign')`, plus at most one automatic 24h pre-expiry reminder email (`auto_remind_before_expiry`, `pre_expiry_reminded_at`) to pending/viewed `email`-mode signers.
2. **Slice 4 - Everyday Operational Parity, Vietnam SME Essentials & AI-Native Lifecycle (`#3817` - `#3822`):**
   - **Slice 4a ([#3817](https://github.com/DOS/Ludy/issues/3817)) - Company/Title Stamp, Saved Signatures & 1-Click Initial-All-Pages:** corporate/title red `stamp` field (`field_type = 'stamp'`, validated PNG `<= 256 KB` sealed by `crove-extract`), saved member signatures/initials and org stamps (`crove_sign.member_signature`, `crove_sign.org_stamp` with `owner`/`admin` RBAC), and 1-click `Ký nháy tất cả các trang` placing aligned `initial` boxes across pages `1..N-1`.
   - **Slice 4b ([#3818](https://github.com/DOS/Ludy/issues/3818)) - Structured `dropdown` / `radio` Fields & Verified Signer Attachments:** bounded option lists (`options_json`, `<= 50` options, Vietnamese diacritics + `{{dropdown, r1, ...}}` tags in `crove-extract`) and verified signer supporting attachments (`field_type = 'attachment'`, `CCCD` / `Giấy ĐKKD` / `Giấy ủy quyền`, magic-byte checked `<= 10 MB` PDF/PNG/JPEG stored in `crove_kernel.file` `source = 'sign_attachment'` with SHA-256 recorded in `signing_event` and the Audit Certificate).
   - **Slice 4c ([#3819](https://github.com/DOS/Ludy/issues/3819)) - In-Flight Recipient Correction & Audited Signer Delegation:** `sign.signer.correct_recipient` fixing an unsigned recipient's name/email/phone/delivery mode on `sent`/`partially_signed` envelopes without voiding completed signers (atomically revoking old tokens/OTPs and logging `signer_corrected`), plus opt-in `allow_delegation` (`POST /api/sign/delegate`, capped `<= 2` per signer against mail relay, logging `delegated_from_name`/`delegated_from_email` and `signer_delegated`).
   - **Slice 4d ([#3820](https://github.com/DOS/Ludy/issues/3820)) - In-Person Host Signing & Self-Service Public Template Hub:** audited face-to-face signing ceremony (`Ký trực tiếp tại quầy`, recording `host_user_id` and `in_person_signed` while isolating device navigation onto `/-/sign#<token>` so tenant screens and session cookies are never exposed) and an opt-in zero-CAPTCHA public template directory (`/-/sign/p/$orgSlug` via `listed_on_public_hub = true`, opaque `404` when `sign` is off).
   - **Slice 4e ([#3821](https://github.com/DOS/Ludy/issues/3821)) - Post-Signature AI Obligation & Renewal Tracker:** `crove_sign.envelope_obligation` storing human-confirmed or manually entered dates, `contract_value NUMERIC(20,4)` + `currency` (strict decimal strings via `@crove/l10n-vn`), `renewal_notice_days`, `auto_renew`, and milestone obligations; metered Vy extraction (`sign.obligation_extract`, `tools: []`, deterministic `{ pageNumber, quoteExcerpt }` verification, 100% manual when AI is off); `Sắp gia hạn / Nghĩa vụ` filter tab; and deterministic Vy `Hôm nay` alerts (`<= 30` days renewal notice window and overdue obligations).
   - **Slice 4f ([#3822](https://github.com/DOS/Ludy/issues/3822)) - Sender-Approved Counterparty Summary, PDF Version Diff & Vietnamese Starter Contract Drafter:** opt-in `share_summary_with_signers = true` publishing the sender-reviewed page-cited summary onto `/-/sign` (zero unauthenticated public LLM calls), deterministic PDF text diff (`So sánh bản sửa đổi`) + optional metered Vy risk delta (`sign.version_diff`), and built-in Vietnamese/bilingual SME starter templates (`NDA 2 chiều`, `Hợp đồng dịch vụ`, `Biên bản nghiệm thu`, `Biên bản thanh lý`, `Hợp đồng cộng tác viên`) rendering tagged A4 PDFs offline + optional metered Vy clause customization (`sign.contract_draft`).
3. **Explicit Icebox / Out-of-Scope Gate ([scope.md](../product/scope.md)):** bulk CSV mail-merge campaigns, Salesforce/Workday/Coupa connectors, Microsoft Word desktop COM add-ins, multi-department legal playbook orchestration builders, SAML/SCIM signer SSO, white-label agency consoles, and local OS USB PKI token drivers remain out of scope.

---

## 1. OPC/SME Fit & Competitor Benchmark

### 1.1 Monthly Vietnam OPC/SME Workflows

A one-person company (OPC) or small business (SME) in Vietnam executes recurring agreements at least monthly that get stuck in print-sign-scan or unverified Messenger/Zalo file exchanges:

- **Commercial agreements & NDAs:** service contracts, consulting retainers, agency SOWs, software implementation agreements, and confidentiality letters sent to B2B clients.
- **Delivery & acceptance minutes (`bien ban nghiem thu` / milestone sign-off):** closing deliverables so Finance can issue an e-invoice and recognize revenue cleanly.
- **Vendor, landlord & partner agreements:** office leases, supplier price lists, freelancer agreements.
- **Internal HR & onboarding docs (Slice 2 bridge):** offer letters, probation confirmations, NDA addenda, and labor contract addenda.

### 1.2 Scope Gate ([scope.md](../product/scope.md))

| Gate check | How Ludy eSign (`sign`) satisfies it |
| :--- | :--- |
| **Fit (monthly OPC/SME task)** | Targets day-to-day B2B/vendor agreements with 1 to 5 signers. Enterprise features (multi-entity PKI consoles, SAML signer gates, agency white-label portals, bulk CSV mail-merge campaigns) stay out of scope / Icebox. |
| **Smallest useful slice** | Works on `docker compose up` out of the box with zero external API keys, CA tokens, or paid quotas. One user can upload a PDF, drop a signature box, copy a Zalo link or send an email, collect signatures, and download a SHA-256 sealed PDF + audit certificate. |
| **AI part named & gated** | `Vy` (`gm`) reads extracted PDF text, proposes field boxes (`sign.field_propose`), and highlights key/risky clauses (`sign.clause_summary`) inside `packages/agent` (`metered()`, `withAiScope`). Every proposal carries a tainted `"De xuat"` mark; a person approves placement and clicks Send; manual signing works 100% with AI disabled. |
| **Proportionate security** | Fragment URL tokens (`/-/sign#<token>`) with `Referrer-Policy: no-referrer`, SHA-256 hashed tokens/OTPs, atomic single-use replay rejection, `crove-extract` untrusted PDF isolation ([ADR-0018](../adr/0018-untrusted-content.md)), and per-IP/token rate limiting without CAPTCHA gates that break self-hosting or E2E tests (`#203`). |

### 1.3 Competitor Benchmark ([competitors.md](../product/competitors.md))

| Dimension | Documenso (AGPL OSS) | Docusign | MISA WeSign (VN) | Ludy eSign (`sign`) |
| :--- | :--- | :--- | :--- | :--- |
| **Self-host `docker compose up`** | Yes (needs external SMTP/OIDC setup) | No (SaaS only) | No (SaaS + MISA ID) | **Yes, 100% self-contained** in Ludy stack with [ADR-0034](../adr/0034-outbound-email.md) mail + local disk / S3 [ADR-0013](../adr/0013-evidence-storage-and-integrity.md) |
| **Zalo / chat link friction** | Email-first, link buried per recipient | Email-first, portal login prompts on some flows | Email / SMS / MISA app notification | **First-class Zalo copy link** (`delivery_mode = 'link'`) alongside email (`'email'`), mobile-first `375px` view |
| **Routing & field placing** | Draw/type, sequential & parallel | Rich routing, complex enterprise rules | Sequential/parallel, USB token & remote CA | Draw/type + sequential/parallel in Slice 1; normalized `[0,1]` coordinate placer |
| **Tamper-evident sealing** | PDF flattening + X.509/PKCS12 cert option | Proprietary cloud audit + PAdES | Vietnam public CA (`chu ky so cong cong`) | **Slice 1:** SHA-256 original + flattened PDF + appended certificate + hash-chained event ledger; **Slice 2:** VNPT SmartCA / Viettel MySign / MISA WeSign |
| **AI contract assistance** | None built-in | Paid IAM add-on | None in basic tier | **Vy** proposes fields & flags risky clauses through `packages/agent` budget meter, zero lock-in |
| **Cross-module handoff** | External webhooks / REST | Connectors | Tight to MISA AMIS suite | Same kernel, WORM audit trail, and [ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md) quote/HR triggers in Slice 2 |

---

## 2. Data Model (`crove_sign`)

All tables live in a dedicated PostgreSQL schema `crove_sign`, enforcing Ludy kernel standards ([crove-os-kernel.md](crove-os-kernel.md) section 6, [AGENTS.md](../../AGENTS.md)):

- Every tenant table carries `org_id UUID NOT NULL`, `PRIMARY KEY (org_id, id)`, RLS via `crove_kernel.apply_tenant_rls('crove_sign', '<table>')`, and `updated_at` trigger via `crove_kernel.set_updated_at()`.
- Every SQL function sets `search_path = pg_catalog, pg_temp`.
- No cross-module foreign keys: references to `crove_kernel.file` or future Slice 2 Engage quotes / HR contracts store `(source_kind, source_id)` + `ADR-0013` evidence triples, never hard FKs across schemas.
- Money amounts (if optional contract value metadata is added in Slice 2) must use `NUMERIC(20,4)` and decimal strings (`@crove/l10n-vn`), never JS floating-point numbers.

### 2.1 Slice 1 Tables

#### `crove_sign.envelope`
Represents one signing packet (one uploaded PDF document sent to 1..N signers).

- `org_id UUID NOT NULL`, `id UUID NOT NULL DEFAULT gen_random_uuid()`, `PRIMARY KEY (org_id, id)`
- `title TEXT NOT NULL` (1..200 chars, e.g., `"Hop dong dich vu ABC - Q4/2026"`)
- `subject TEXT` (optional email subject)
- `message TEXT` (optional message shown to signers)
- `status TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'partially_signed', 'completed', 'declined', 'voided', 'expired')) DEFAULT 'draft'`
- `routing_mode TEXT NOT NULL CHECK (routing_mode IN ('parallel', 'sequential')) DEFAULT 'parallel'`
- `require_email_otp_default BOOLEAN NOT NULL DEFAULT false`
- `source_kind TEXT NOT NULL CHECK (source_kind IN ('standalone', 'crm_quote', 'hr_contract')) DEFAULT 'standalone'`
- `source_id UUID` (null for standalone; populated by Slice 2 handoffs without FK)
- **Original PDF ([ADR-0013](../adr/0013-evidence-storage-and-integrity.md) triple + file ref):**
  - `source_file_id UUID NOT NULL` (logical ref to `crove_kernel.file`)
  - `source_storage_key TEXT NOT NULL`
  - `source_generation TEXT NOT NULL`
  - `source_sha256 TEXT NOT NULL` (64 lowercase hex chars)
  - `inspect_status TEXT NOT NULL CHECK (inspect_status IN ('pending', 'ready', 'rejected')) DEFAULT 'pending'`
  - `inspect_error TEXT`
  - `page_count INT CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 200)`
  - `page_dimensions_json JSONB` (validated array `[{ page, widthPt, heightPt, rotation }]`)
- **Sealed Evidence Outputs ([ADR-0013](../adr/0013-evidence-storage-and-integrity.md) triples, nullable until sealed):**
  - `seal_status TEXT CHECK (seal_status IN ('pending', 'sealed', 'failed'))`
  - `sealed_file_id UUID`, `sealed_storage_key TEXT`, `sealed_generation TEXT`, `sealed_sha256 TEXT`
  - `certificate_file_id UUID`, `certificate_storage_key TEXT`, `certificate_generation TEXT`, `certificate_sha256 TEXT`
  - `certificate_code TEXT UNIQUE` (short human/public lookup id, e.g., `SIG-2026-XXXXXX`, generated on seal)
- `expires_at TIMESTAMPTZ`
- `sent_at TIMESTAMPTZ`, `completed_at TIMESTAMPTZ`, `voided_at TIMESTAMPTZ`, `void_reason TEXT`
- `created_by UUID NOT NULL`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- Indexes: `(org_id, status, updated_at DESC)`, `(org_id, source_kind, source_id) WHERE source_id IS NOT NULL`.

#### `crove_sign.signer`
Each recipient required to sign an envelope.

- `org_id UUID NOT NULL`, `id UUID NOT NULL DEFAULT gen_random_uuid()`, `PRIMARY KEY (org_id, id)`
- `envelope_id UUID NOT NULL`, FK `(org_id, envelope_id) REFERENCES crove_sign.envelope(org_id, id) ON DELETE CASCADE`
- `routing_order INT NOT NULL CHECK (routing_order >= 1) DEFAULT 1`
- `role_label TEXT NOT NULL DEFAULT 'Signer'` (e.g., `"Ben A"`, `"Ben B"`, `"Giam doc"`)
- `name TEXT NOT NULL`
- `email TEXT` (nullable ONLY when `delivery_mode = 'link' AND require_email_otp = false`)
- `phone TEXT` (optional memo for Zalo reference, never drives SMS in Slice 1)
- `delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('link', 'email')) DEFAULT 'link'`
- `require_email_otp BOOLEAN NOT NULL DEFAULT false`
- `status TEXT NOT NULL CHECK (status IN ('waiting', 'pending', 'viewed', 'signed', 'declined')) DEFAULT 'waiting'`
- `declined_reason TEXT`, `declined_at TIMESTAMPTZ`
- `signed_at TIMESTAMPTZ`, `consent_accepted_at TIMESTAMPTZ`
- `signature_kind TEXT CHECK (signature_kind IN ('draw', 'type'))`
- `signature_typed_text TEXT` (bounded <= 120 chars)
- `signer_user_agent TEXT`, `signer_ip_hash TEXT` (salted/HMAC-SHA256 of client IP to avoid raw IP retention while preserving audit correlation)
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- Constraint: `CHECK ((delivery_mode = 'link' AND NOT require_email_otp) OR (email IS NOT NULL AND length(trim(email)) > 3))`
- Index: `(org_id, envelope_id, routing_order)`.

#### `crove_sign.field`
Placed fields on PDF pages assigned to one signer.

- `org_id UUID NOT NULL`, `id UUID NOT NULL DEFAULT gen_random_uuid()`, `PRIMARY KEY (org_id, id)`
- `envelope_id UUID NOT NULL`
- `signer_id UUID NOT NULL`, FK `(org_id, signer_id) REFERENCES crove_sign.signer(org_id, id) ON DELETE CASCADE`
- `field_type TEXT NOT NULL CHECK (field_type IN ('signature', 'initial', 'date', 'text', 'checkbox'))`
- `label TEXT`
- `page_number INT NOT NULL CHECK (page_number >= 1)`
- Normalized top-left coordinates `[0, 1]` relative to page bounding box (DPI-independent across browser and `pdf-lib`):
  - `x_norm NUMERIC(7,6) NOT NULL CHECK (x_norm >= 0 AND x_norm < 1)`
  - `y_norm NUMERIC(7,6) NOT NULL CHECK (y_norm >= 0 AND y_norm < 1)`
  - `w_norm NUMERIC(7,6) NOT NULL CHECK (w_norm > 0 AND w_norm <= 1)`
  - `h_norm NUMERIC(7,6) NOT NULL CHECK (h_norm > 0 AND h_norm <= 1)`
  - Constraint: `CHECK (x_norm + w_norm <= 1.000001 AND y_norm + h_norm <= 1.000001)`
- `required BOOLEAN NOT NULL DEFAULT true`
- `proposed_by_ai BOOLEAN NOT NULL DEFAULT false`
- `ai_confidence NUMERIC(4,3)`
- Filled values (written once by `sign.public.submit`):
  - `value_text TEXT` (date / text / typed name)
  - `value_checked BOOLEAN`
  - `signature_image_sha256 TEXT`, `signature_storage_key TEXT`, `signature_generation TEXT` (validated bounded PNG <= 256 KB stored via [ADR-0013](../adr/0013-evidence-storage-and-integrity.md) for draw/type rasterization so `crove-extract` seals exact PNGs)
  - `filled_at TIMESTAMPTZ`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- Index: `(org_id, envelope_id, page_number)`.

#### `crove_sign.ai_analysis`
Stores Vy's tainted field proposals and clause summaries tied to a specific `source_sha256`.

- `org_id UUID NOT NULL`, `id UUID NOT NULL DEFAULT gen_random_uuid()`, `PRIMARY KEY (org_id, id)`
- `envelope_id UUID NOT NULL`, FK `(org_id, envelope_id) REFERENCES crove_sign.envelope(org_id, id) ON DELETE CASCADE`
- `source_sha256 TEXT NOT NULL`
- `status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed', 'dismissed')) DEFAULT 'pending'`
- `proposed_fields_json JSONB NOT NULL DEFAULT '[]'::jsonb`
- `clause_summary_json JSONB`
- `risk_level TEXT CHECK (risk_level IN ('low', 'medium', 'high'))`
- `prompt_version TEXT NOT NULL`, `model_id TEXT`
- `applied_at TIMESTAMPTZ`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`

#### `crove_sign.signing_token`
Hashed single-use access capabilities backing `/-/sign#<token>`.

- `org_id UUID NOT NULL`, `id UUID NOT NULL DEFAULT gen_random_uuid()`, `PRIMARY KEY (org_id, id)`
- `envelope_id UUID NOT NULL`
- `signer_id UUID NOT NULL`, FK `(org_id, signer_id) REFERENCES crove_sign.signer(org_id, id) ON DELETE CASCADE`
- `token_sha256 TEXT NOT NULL UNIQUE` (hex SHA-256 of 32 CSPRNG bytes; **plaintext token is never stored**)
- `expires_at TIMESTAMPTZ NOT NULL`
- `revoked_at TIMESTAMPTZ`
- `used_at TIMESTAMPTZ`
- `last_viewed_at TIMESTAMPTZ`
- `created_by UUID` (null when minted automatically on sequential advance or mail send)
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- **Immutability trigger (`BEFORE UPDATE`):** mirrors `crove_kernel.file_upload` (`org_id`, `envelope_id`, `signer_id`, `token_sha256`, `created_at` cannot change; `used_at` and `revoked_at` can transition from `NULL` to non-null at most once; once `used_at` or `revoked_at` is set, the token cannot be re-activated).

#### `crove_sign.signing_otp`
Short-lived hashed OTP records for signers with `require_email_otp = true`.

- `org_id UUID NOT NULL`, `id UUID NOT NULL DEFAULT gen_random_uuid()`, `PRIMARY KEY (org_id, id)`
- `signer_id UUID NOT NULL`, FK `(org_id, signer_id) REFERENCES crove_sign.signer(org_id, id) ON DELETE CASCADE`
- `signing_token_id UUID NOT NULL`, FK `(org_id, signing_token_id) REFERENCES crove_sign.signing_token(org_id, id) ON DELETE CASCADE`
- `email TEXT NOT NULL`
- `otp_sha256 TEXT` (nullable while mail is in queue; set atomically by `sign.public.otp_mail_data` right at dispatch so neither `pgboss.job` nor `mail_message` stores a plaintext OTP)
- `expires_at TIMESTAMPTZ NOT NULL`
- `attempts INT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5)`
- `verified_at TIMESTAMPTZ`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- Index: `(org_id, signing_token_id, created_at DESC)`.

#### `crove_sign.signing_event`
Append-only, hash-chained audit ledger per envelope (in addition to kernel `crove_kernel.audit_event`).

- `org_id UUID NOT NULL`, `id UUID NOT NULL DEFAULT gen_random_uuid()`, `PRIMARY KEY (org_id, id)`
- `envelope_id UUID NOT NULL`, FK `(org_id, envelope_id) REFERENCES crove_sign.envelope(org_id, id) ON DELETE CASCADE`
- `signer_id UUID`
- `seq BIGINT NOT NULL CHECK (seq >= 1)`
- `event_type TEXT NOT NULL CHECK (event_type IN ('envelope_created', 'pdf_inspected', 'ai_proposed', 'envelope_sent', 'link_minted', 'link_viewed', 'otp_sent', 'otp_verified', 'otp_failed', 'signer_signed', 'signer_declined', 'envelope_voided', 'envelope_expired', 'envelope_sealed', 'certificate_generated', 'ca_requested', 'ca_completed'))`
- `actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'signer', 'system', 'ai'))`
- `actor_label TEXT NOT NULL`
- `ip_hash TEXT`, `user_agent TEXT`
- `document_sha256 TEXT`
- `prev_event_hash TEXT`
- `event_hash TEXT NOT NULL` (SHA-256 of canonical `prev_event_hash || seq || event_type || occurred_at || document_sha256 || payload_json`)
- `payload_json JSONB NOT NULL DEFAULT '{}'::jsonb`
- `occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- Unique constraint: `UNIQUE (org_id, envelope_id, seq)`
- **Append-only trigger:** `BEFORE UPDATE OR DELETE` raises exception (identical discipline to `crove_kernel.audit_event`), overridden only by explicit org purge cascade if legally allowed.

### 2.2 Slice 2 Reserved Tables (Documented Now, Migrated in Slice 2)

- `crove_sign.template`, `crove_sign.template_role` (`signer_role IN ('signer', 'approver', 'cc')` per `A2`), `crove_sign.template_field`: reusable layouts cloning roles + normalized fields (including coordinates populated deterministically from `{{signature, r1}}` / `{{date, r1}}` / `{{text, r1}}` PDF text tags in `crove-extract` per `A3`) into `crove_sign.envelope`.
- `crove_sign.template_direct_link` (`MACHINERY`): definer-only capability token table backing 1-signer public direct signing links `/-/sign/d#<token>` (`A1`). Stores `token_sha256` (zero plaintext token stored), `template_id`, `enabled`, and `created_by` under RLS with zero runtime login role grants (reached strictly through `SECURITY DEFINER` resolvers/commands, matching `signing_token` and `signing_otp`).
- `crove_sign.ca_connection` (`MACHINERY`): org-level remote CA credentials (`provider IN ('sandbox', 'vnpt_smartca', 'viettel_mysign', 'misa_wesign')`, encrypted secrets via `crove_kernel` secret envelope; zero runtime login role grants, reached only via definers).
- `crove_sign.ca_signing_request`: asynchronous external CA transaction log (`provider IN ('sandbox', 'vnpt_smartca', 'viettel_mysign', 'misa_wesign')`, `idempotency_key`, `external_tx_id`, `status`, `retry_safety = 'reconcile_only'`, modeled after `@crove/einvoice`).

### 2.2b Slice 3 & Slice 4 Schema Additions (`2026-11-19`)

- **Envelope & signer extensions (`Slice 3` & `Slice 4`):**
  - `crove_sign.envelope.source_kind` adds `'meeting_minutes'` (`#3811`, enforcing [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) reader-scoped RLS + `can_read_sign_file`) and `'project_acceptance'` (`#3812`, zero cross-module hard FKs).
  - `crove_sign.envelope` adds `auto_remind_before_expiry BOOLEAN NOT NULL DEFAULT true` (`#3813`), `allow_delegation BOOLEAN NOT NULL DEFAULT false` (`#3819`), and `share_summary_with_signers BOOLEAN NOT NULL DEFAULT false` (`#3822`).
  - `crove_sign.signer` adds `pre_expiry_reminded_at TIMESTAMPTZ` (`#3813`), `delegated_from_name TEXT`, `delegated_from_email TEXT`, and `delegation_count INT NOT NULL DEFAULT 0 CHECK (delegation_count BETWEEN 0 AND 2)` (`#3819`).
  - `crove_sign.field` & `crove_sign.template_field` extend `field_type` with `'stamp'` (`#3817`), `'dropdown'`, `'radio'`, and `'attachment'` (`#3818`), adding `options_json JSONB` (bounded `<= 50` options) and [ADR-0013](../adr/0013-evidence-storage-and-integrity.md) attachment evidence columns (`attachment_file_id`, `attachment_storage_key`, `attachment_generation`, `attachment_sha256` under `crove_kernel.file` `source = 'sign_attachment'`, excluded from Finance `isDocumentSource`).
  - `crove_sign.template_direct_link` adds `listed_on_public_hub BOOLEAN NOT NULL DEFAULT false` (`#3820`) backing `/-/sign/p/$orgSlug`.
  - `crove_sign.signing_event.event_type` adds `'pre_expiry_reminded'` (`#3813`), `'attachment_uploaded'` (`#3818`), `'signer_corrected'`, `'signer_delegated'` (`#3819`), and `'in_person_signed'` (`#3820`, recording `host_user_id` in `payload_json`).
- **New tenant tables (`Slice 4a` & `Slice 4e`, full `org_id` + `PRIMARY KEY (org_id, id)` + `apply_tenant_rls` + `DATA_CLASSES` + `PERSONAL_DATA_COLUMNS` + `org_purge`):**
  - `crove_sign.member_signature` (`#3817`): member-scoped saved signature and initials PNG references ([ADR-0013](../adr/0013-evidence-storage-and-integrity.md) `<= 256 KB`, zero SVG).
  - `crove_sign.org_stamp` (`#3817`): org-level red corporate/title stamp images managed under `owner`/`admin` RBAC.
  - `crove_sign.envelope_obligation` (`#3821`): human-confirmed or manually entered post-signature terms per envelope (`counterparty_name`, `effective_date`, `expiry_date`, `renewal_notice_days`, `auto_renew`, `contract_value NUMERIC(20,4)`, `currency`, and milestone obligation items `{ due_date, title, status }` with optional `{ pageNumber, quoteExcerpt }` provenance).

### 2.3 Data Classification, PDPL & Purge Rules

Every table column maps cleanly to `DATA_CLASSES` (`packages/kernel-contract/src/manifest.ts`) and `PERSONAL_DATA_COLUMNS` (`packages/kernel/src/personal-data.ts`):

| Table / Columns | `DATA_CLASSES` | `PERSONAL_DATA_COLUMNS` disposition | Notes |
| :--- | :--- | :--- | :--- |
| `envelope.title`, `subject`, `message` | `internal` | `keep_record` (sealed) / `erase` (unsealed draft) | Unsealed drafts purge completely on org delete. |
| `signer.name`, `signature_typed_text` | `pii` | `keep_legal` (completed) / `erase` (unsealed) | Preserves contract party identity for signed agreements. |
| `signer.email`, `signer.phone` | `contact` | `keep_legal` (completed) / `erase` (unsealed) | Masked (`a***@domain.vn`) in public views. |
| `signer.signer_ip_hash`, `signer_user_agent` | `pii` | `hashed` / `keep_legal` | Salted/HMAC-SHA256 IP hash avoids holding raw client IPs. |
| `signing_token.token_sha256`, `signing_otp.otp_sha256` | `sensitive` | `erase` (pruned post-expiry by `sign-cleanup`) | Never returned in APIs or logs; zero recovery needed. |
| `signing_event` (`actor_label`, `ip_hash`, `payload_json`) | `pii` | `keep_legal` (completed) / `erase` (draft) | Append-only evidence chain for signed contracts. |

- **Nightly `retention.ts` integration:** `sign-cleanup` prunes expired/revoked/used `signing_token` and `signing_otp` rows older than 30 days.
- **Org deletion (`org-purge.ts`):** purges draft/voided envelopes, expired tokens/OTPs, and `ai_analysis` immediately; sealed evidence handling follows Ludy's legal retention rule.
- **`[commentary]` Legal Sign-off Required (Lawyer `#62` before pilot billing):** Confirm under Vietnam **Law on Electronic Transactions `20/2023/QH15`**, **Decree `23/2025/ND-CP`**, and **Law on Personal Data Protection `91/2025/QH15` / Decree `356/2025/ND-CP`**: (a) whether completed commercial contracts and their `signing_event` / `sealed_file` records qualify under `keep_legal` statutory preservation overrides against a signer's erasure request, and (b) exact retention periods and counterparty disclosure wording shown in the signing consent banner.

---

## 3. Command Catalog, Queries & Module Enablement ([ADR-0031](../adr/0031-module-enablement.md), [ADR-0053](../adr/0053-per-org-app-enablement.md))

### 3.1 `Runtime.execute()` Command Catalog (`packages/kernel-runtime`)

Every state change runs through `Runtime.execute()`, writing `audit_event`, enforcing tenant RLS, and respecting declared `tableWrite` contracts.

| Command | Tier | Actor | Permission / Gate | Primary Tables Written | Side Effects / Queues |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `sign.envelope.create` | `R1` | `user` | `sign:write` | `envelope`, `signing_event` | Validates `crove_kernel.file` (`source = 'sign_document'`); enqueues `sign-pdf-inspect` (`crove-extract`). |
| `sign.envelope.inspect_complete` | `R1` | `system` | `sign-pdf-inspect` worker | `envelope`, `signing_event` | Records `page_count`, `page_dimensions_json`, or `inspect_status = 'rejected'`. Optionally triggers `sign-ai-analyze` if AI enabled. |
| `sign.envelope.update` | `R1` | `user` | `sign:write` (draft only) | `envelope` | Updates title, subject, message, `routing_mode`, `expires_at`. |
| `sign.signer.upsert` | `R1` | `user` | `sign:write` (draft only) | `signer` | Enforces email presence if `delivery_mode = 'email'` or `require_email_otp = true`. |
| `sign.signer.remove` | `R1` | `user` | `sign:write` (draft only) | `signer`, `field` (cascade) | Deletes draft signer and assigned fields. |
| `sign.field.replace_all` | `R1` | `user` | `sign:write` (draft only) | `field` | Validates `1 <= page_number <= envelope.page_count`, normalized `[0,1]` bounds, and signer belongs to envelope. |
| `sign.ai.analyze` | `R1` | `user` | `sign:write` + AI metered | `ai_analysis`, `signing_event` | Enqueues `sign-ai-analyze`; returns graceful notice if AI is off/exhausted. |
| `sign.ai.apply_proposals` | `R1` | `user` | `sign:write` (draft only) | `field`, `ai_analysis` | Copies human-reviewed Vy field proposals into `field` with `proposed_by_ai = true`. Never auto-sends. |
| `sign.envelope.send` | `R2` | `user` | `sign:send` (human-only) | `envelope`, `signer`, `signing_event` | Requires `inspect_status = 'ready'`, >=1 signer, >=1 required field per signer. Locks document & fields. Sets `routing_order` initial statuses (`pending` vs `waiting`). Enqueues `kernel-mail-send` for active `'email'` signers (`{ orgId, envelopeId, signerId }` ONLY). |
| `sign.signer.create_link` | `R2` | `user` | `sign:send` (human-only) | `signing_token`, `signing_event` | Revokes prior active token for that `'pending'/'viewed'` signer, writes `token_sha256`, returns `/-/sign#<token>` **once** in response for Zalo/chat copy. |
| `sign.signer.remind` | `R2` | `user` | `sign:send` (human-only) | `signing_token`, `signing_event` | Rate-limited (1 per signer per hour); re-queues email or mints a fresh copyable link for active signers. |
| `sign.envelope.void` | `R2` | `user` | `sign:send` (human-only) | `envelope`, `signing_token`, `signing_event` | Cancels non-completed envelope; stamps `revoked_at` on all active tokens. |
| `sign.signer.mail_data` | `R1` | `system` | `kernel-mail-send` worker | `signing_token`, `signing_event` | Called at email dispatch time (`quote-mail.ts` pattern): mints fresh 32-byte token, stores `token_sha256`, renders `/-/sign#<token>` without storing token in `mail_message.payload`. |
| `sign.public.record_view` | `R1` | `system` | `sign.public` (orgless bridge) | `signer`, `signing_token`, `signing_event` | Sets `pending -> viewed`, stamps `last_viewed_at`, appends `link_viewed` (debounced per 15m window). |
| `sign.public.request_otp` | `R1` | `system` | `sign.public` (orgless bridge) | `signing_otp`, `signing_event` | Rate-limited (max 3/hr per token); inserts empty `signing_otp` row and queues `kernel-mail-send` (`kind: 'sign.otp'`). |
| `sign.public.otp_mail_data` | `R1` | `system` | `kernel-mail-send` worker | `signing_otp`, `signing_event` | Mints 6-digit CSPRNG OTP at mail dispatch time, saves `otp_sha256` + 10-min TTL, renders email body; zero plaintext OTP persisted in DB. |
| `sign.public.verify_otp` | `R1` | `system` | `sign.public` (orgless bridge) | `signing_otp`, `signing_event` | Constant-time SHA-256 compare; increments `attempts` up to 5; stamps `verified_at`. |
| `sign.public.submit` | `R2` | `system` | `sign.public` (orgless bridge) | `signing_token`, `field`, `signer`, `envelope`, `signing_event` | Atomic `used_at` guard; verifies OTP (if required), all required fields, rasterized signature PNG; marks `signed`; advances next `routing_order` or marks `completed` + queues `sign-pdf-seal`. |
| `sign.public.decline` | `R2` | `system` | `sign.public` (orgless bridge) | `signing_token`, `signer`, `envelope`, `signing_event` | Atomic `used_at` guard; revokes remaining active tokens; marks envelope `declined`. |
| `sign.envelope.seal_complete` | `R2` | `system` | `sign-pdf-seal` worker | `envelope`, `signing_event` | Writes `sealed` PDF & `certificate` triples ([ADR-0013](../adr/0013-evidence-storage-and-integrity.md)), generates `certificate_code`, sends completion notifications to sender + email signers via [ADR-0034](../adr/0034-outbound-email.md). |
| `sign.envelope.expire_sweep` | `R1` | `system` | cron (`keeping`) | `envelope`, `signing_token`, `signing_event` | Marks overdue `'sent' / 'partially_signed'` envelopes as `'expired'` and revokes all active tokens. |

### 3.2 Query Surface (`R0`)

- `sign.envelopes.list`: paginated envelopes for the current org filtered by `status`, search query, and `source_kind` (returns masked active signer summary).
- `sign.envelopes.get`: full envelope state, normalized field layout, `ai_analysis`, signer statuses (no secret hashes), and download links for original/sealed PDF and audit certificate.
- `sign.envelope.events`: chronological hash-chained `signing_event` rows for audit inspection.
- `sign.envelope.verify`: verifies an uploaded PDF SHA-256 (or provided digest) inside the org.
- Public verification endpoint (`POST /api/sign/verify`): accepts `{ certificateCode, fileSha256 }` (computed client-side in Web Crypto API so zero confidential bytes leave the browser) and checks `org_app_on(org_id, 'sign')` via `runtime.orgless`, returning `{ matched: true, envelopeStatus, completedAt, signerCount, sealedSha256 }` or generic `{ matched: false }` without exposing envelope titles or PII to unauthenticated callers.

### 3.3 `ADR-0031` & `ADR-0053` Module Enablement + Job Classification

1. **Module registry:** add `'sign'` to `AVAILABLE_MODULES` in `apps/kernel/src/config.ts` and register the module manifest `modules/sign/src/manifest.ts` in `apps/kernel/src/kernel.ts`. Instances built with `CROVE_MODULES` excluding `'sign'` return `not_installed` per [ADR-0031](../adr/0031-module-enablement.md).
2. **Per-org toggle ([ADR-0053](../adr/0053-per-org-app-enablement.md)):** `'sign'` appears in `crove_kernel.tenant.apps_off` controls. When `org_app_on(org_id, 'sign')` is `false`:
   - Every authenticated `/api/sign/*` route returns `404 MODULE_OFF`.
   - Every public `/api/sign/*` token route and `POST /api/sign/verify` returns the **exact same generic `404`** so outside callers cannot tell whether an org exists, a token expired, or the app is turned off.
   - App switcher hides `Ky ket` / `eSign`.
3. **Background queues & `work` vs `keeping` sweep classification ([ADR-0053](../adr/0053-per-org-app-enablement.md)):**

| Queue / Job | `ADR-0053` Class | `runsWhenOff` | `QUEUE_EGRESS` | `deadLetter` | Purpose |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `sign-pdf-inspect` | `work` | `false` | `'none'` | `'kernel-job.dlq'` | Runs in `crove-extract` to validate PDF & extract page dimensions + text. |
| `sign-ai-analyze` | `work` | `false` | `'none'` (uses `packages/agent` egress rules) | `'kernel-job.dlq'` | Runs Vy `sign.field_propose` & `sign.clause_summary` through `metered()`. |
| `sign-pdf-seal` | `work` | `false` | `'none'` | `'kernel-job.dlq'` | Flattens signatures/fields & appends Audit Certificate page in `crove-extract`. |
| `sign-expire-sweep` | `keeping` | `true` | `'none'` | `'kernel-job.dlq'` | Expires overdue envelopes and revokes active tokens even if org turned `sign` off. |
| `sign-cleanup` | `keeping` | `true` | `'none'` | `'kernel-job.dlq'` | Prunes expired `signing_token` & `signing_otp` rows past 30-day window. |

---

## 4. Evidence Storage, Sealing & Verification ([ADR-0013](../adr/0013-evidence-storage-and-integrity.md), [ADR-0018](../adr/0018-untrusted-content.md))

### 4.1 Dedicated File Purposes (Protecting Finance OCR)

In `packages/kernel-contract/src/index.ts` and `packages/kernel/src/files.ts`, `ingestFileRow` currently checks `isDocumentSource = source === 'upload' || source === 'email'` to trigger Finance invoice extraction (`finance-file-extract`).

- Add `'sign_document'` to `UPLOAD_PURPOSES` (`packages/kernel-contract/src/index.ts`).
- Add `'sign_document' | 'sign_sealed' | 'sign_certificate'` to `zIngestFile.source` (`packages/kernel/src/files.ts`).
- Keep `isDocumentSource` restricted to `'upload' | 'email'` so contracts and sealed eSign PDFs are stored with full [ADR-0013](../adr/0013-evidence-storage-and-integrity.md) `(storage_key, generation, sha256)` triples under `org/<org_id>/<sha256>` **without ever triggering Finance OCR**.

### 4.2 Parser & Sandbox Boundary (`crove-extract` Only)

Repository tests (`tools/test/parser-imports.test.ts` and `apps/kernel/test/container/image-check.mjs`) strictly enforce `PARSER_HOMES = ['apps/extract/']`: PDF parsers (`pdf-lib`, `pdfjs-dist`, `unpdf`, `pdf-parse`, `startxref` scanners, and `.wasm`/native binaries) are forbidden in `apps/kernel`, `modules/**`, and `packages/**`.

1. **`pdf_inspect` (`EXTRACT_KINDS` in `packages/extract-contract` + `apps/extract/`):**
   - Kernel reads verified uploaded PDF bytes via `readVerified` and dispatches them to `crove-extract` (`QUEUE_EGRESS: 'none'`, 25 MiB limit per `EXTRACT_LIMITS`, 25 s timeout).
   - Rejects encrypted/password-protected PDFs in Slice 1, checks `%PDF-1.` magic bytes, rejects/strips active JavaScript (`/JS`, `/JavaScript`, `/AA`, `/OpenAction`, `/Launch`, `/RichMedia`), enforces `pageCount <= 200`, extracts authoritative `[widthPt, heightPt, rotation]` per page, and returns bounded per-page text (`max ~64 KB` structured summary input) for Vy.
2. **`pdf_seal` (`EXTRACT_KINDS` in `packages/extract-contract` + `apps/extract/`):**
   - When the final signer completes, the kernel reads verified original PDF bytes (`readVerified` confirming `source_sha256`) + validated PNG signature assets (each strictly verified PNG magic bytes, <= 256 KB, no SVG/XML) + normalized field values + canonical signer/event audit summary, and posts them to `crove-extract`.
   - `crove-extract` uses `pdf-lib` + embedded `Be Vietnam Pro` subset fonts (supporting full Vietnamese Unicode diacritics) to flatten signatures, dates, initials, checkboxes, and text directly into page content streams, strips interactive AcroForm fields/scripts, appends a branded **Audit Certificate Summary Page** (`Chung nhan ky ket dien tu`, matching the last document page dimensions per Slice 2 `A3`) containing `certificate_code`, `source_sha256`, signer list, UTC+7 timestamps, OTP/email verification flags, and `signing_event` chain tip hash, and returns the sealed PDF bytes (strictly bounded <= `EXTRACT_LIMITS.maxFileBytes`). Deterministic text tag parsing (`{{signature, r1}}`, `{{date, r1}}`, `{{text, r1}}`, `A3`) also runs strictly inside `crove-extract` (`pdf_inspect` / template parse) with zero LLM dependencies.
   - Kernel computes `sealed_sha256`, writes the sealed PDF via create-only `ADR-0013` store (`source = 'sign_sealed'`), and also writes a canonical machine-verifiable `certificate.json` (plus standalone certificate PDF generated either by `crove-extract` or a zero-dependency pure PDF writer modeled on `modules/crm/src/pdf/writer.ts`) under `source = 'sign_certificate'`.
3. **Browser `.wasm` constraint (`image-check.mjs`):**
   - `apps/kernel/test/container/image-check.mjs` inspects the built tree including `apps/app/dist` for binary files including `.wasm`. Therefore the field placer & viewer in `apps/app` MUST render PDF pages using pure-JS `pdfjs-dist` (with `isEvalSupported: false`, `enableScripting: false`, and **zero `.wasm` asset files** copied into `apps/app/dist`, e.g., excluding `pdfjs-dist/wasm/` decoders; if an exotic CMYK/JBIG2 JPEG2000 PDF requires unsupported decoding, `pdf_inspect` flags it cleanly or Slice 1c validates pure-JS rendering in CI `image-check.mjs`).

### 4.3 Tamper-Evident Verification & Slice 2 Public CA Boundary

- **Slice 1 independent verification:** anyone holding `contract-signed.pdf` and `certificate.json` (or `certificate_code`) can verify integrity completely offline (`sha256sum contract-signed.pdf` == `sealed_sha256`) or locally in Ludy's **Verify Document** screen using browser Web Crypto (`crypto.subtle.digest('SHA-256', arrayBuffer)`), ensuring zero document bytes leave the user's device.
- **Slice 2 pluggable CA boundary (`packages/sign` modeled on `packages/einvoice`):**
  - Interface `CaSigningAdapter`: `provider: 'sandbox' | 'vnpt_smartca' | 'viettel_mysign' | 'misa_wesign'`, `initiateSign(digestSha256, certRef, idempotencyKey)`, `pollStatus(externalTxId)`, `fetchSignedCmsOrLtv(externalTxId)`, with `retrySafety: 'reconcile_only'` so network failures never double-charge or double-sign (`'sandbox'` runs 100% offline locally on `docker compose up`).
  - Because `crove-extract` remains `QUEUE_EGRESS: 'none'`, the kernel executes external HTTPS CA calls via guarded provider egress, receives back the detached CMS/PKCS#7 signature bytes, and sends `{ originalPdf, cmsSignatureBytes, ocspOrTimestampToken }` to `crove-extract` (`pdf_embed_cms`) to assemble a standards-compliant PAdES-LTV PDF without placing CA SDKs inside kernel or `crove-extract` network paths.
- **`[commentary]` Legal Weight Note (Lawyer `#62`):**
  - Under Vietnam Law on Electronic Transactions `20/2023/QH15` and Decree `23/2025/ND-CP`, Slice 1 electronic signatures (`chu ky dien tu`) coupled with audit logs, email OTP, and SHA-256 sealing suit commercial B2B contracts where parties agree on electronic authentication, whereas documents legally mandated to carry certified public digital signatures (`chu ky so cong cong`, e.g., VAT e-invoices, tax/social insurance filings, specific regulated deeds) must wait for Slice 2 CA integration.

---

## 5. Public Signing Link Security (`/-/sign#<token>`)

Built directly on Ludy's existing fragment-token pattern (`apps/app/src/lib/quote-hash.ts`, `apps/app/src/routes/quote-document.tsx`, `apps/kernel/src/review-link.ts`):

1. **Fragment-only URL & zero referrer leak:**
   - Shareable links always use `https://<host>/-/sign#<token>` (token `SIGN_TOKEN_PATTERN`: 32 CSPRNG bytes `base64url` = 43 chars). Tokens are **never** placed in URL paths or `?query` parameters.
   - `/-/sign` frontend mounts, extracts `window.location.hash.slice(1)` in memory, immediately calls `window.history.replaceState(null, '', window.location.pathname)` to strip the token from browser history, and submits the token solely inside JSON `POST` bodies with `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`.
   - Kernel HTTP headers on `/-/sign` and `/api/sign/*`: `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and strict CSP (`frame-ancestors 'none'`, `script-src 'self'`).
2. **`runtime.orgless` -> `Runtime.execute()` bridge:**
   - Public endpoints (`/api/sign/view`, `/api/sign/pdf`, `/api/sign/otp/request`, `/api/sign/otp/verify`, `/api/sign/submit`, `/api/sign/decline`) call a single narrow `SECURITY DEFINER` function via `runtime.orgless` taking ONLY `token_sha256`.
   - That SQL function checks `signing_token`, joins `envelope`, and enforces `crove_kernel.org_app_on(org_id, 'sign') AND entitled(org_id, 'sign')` ([ADR-0053](../adr/0053-per-org-app-enablement.md)). Invalid token, expired token, revoked token, already-used token, voided envelope, and `MODULE_OFF` all return the **identical generic `404`** (zero tenant or existence oracle).
   - Once `(orgId, envelopeId, signerId)` resolves, every write runs through `runtime.execute('sign.public.*', ..., { actor: { type: 'system', component: 'sign.public' }, orgId })`.
3. **Sequential vs parallel enforcement:**
   - In `sequential` mode, signers with `routing_order > activeOrder` remain in `status = 'waiting'`. Opening a link (if minted prematurely) or calling `/api/sign/pdf` returns `{ state: 'waiting_turn', order }` with **zero PDF bytes and zero other signers' emails**.
   - Only when all signers at `routing_order = k` sign does `sign.public.submit` promote `routing_order = k + 1` to `'pending'` and queue their [ADR-0034](../adr/0034-outbound-email.md) invitations (or allow the sender to copy their Zalo link).
4. **Optional Email OTP (anti-forwarding defense):**
   - If `signer.require_email_otp = true` and `signing_otp.verified_at IS NULL`, `POST /api/sign/view` reveals only `{ state: 'otp_required', maskedEmail, title }`.
   - `POST /api/sign/pdf` refuses to stream document bytes until OTP verification succeeds (`otp_sha256` constant-time match, 10-minute TTL, max 5 guesses per OTP, max 3 OTP sends/hour).
   - If a link is forwarded on Zalo to an unintended recipient, they cannot read or download the PDF without access to `signer.email`.
5. **Single-use replay rejection:**
   - `sign.public.submit` and `sign.public.decline` execute `UPDATE crove_sign.signing_token SET used_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id` inside the DB transaction.
   - Any concurrent double-submit or replay attempt returns `409/410` and fails cleanly without duplicating audit events or overwriting signature assets.
   - After signing, the public link cannot re-download the unsealed/sealed PDF; email signers receive the final sealed copy + audit certificate via transactional email upon completion, and the sender always retains access inside `/sign/envelopes/:id`.
6. **Signature capture safety (no SVG XSS):**
   - Client sends drawn strokes (bounded JSON array `<= 64 KB`) or typed text (`<= 120 chars`), rendered and normalized into a validated PNG (`<= 256 KB`, checked by PNG magic bytes `89 50 4E 47` and dimension cap). Raw SVG or HTML payloads are strictly rejected.
7. **Rate limiting & explicit No-CAPTCHA policy (Decision `#203`):**
   - Per [backlog-review-2026-10-17.md](backlog-review-2026-10-17.md) (`#203`), **no mandatory CAPTCHA or Turnstile widget** is permitted on `/-/sign` or `/api/sign/*`. Self-hosted `docker compose up` instances and headless E2E suites work out of the box without third-party challenge tokens.
   - Abuse protection uses kernel `RateLimiter` (`apps/kernel/src/http.ts`): per-IP view/submit limits, per-token-hash OTP send/verify limits, and strict Zod request body limits (`<= 512 KB` JSON).

---

## 6. AI Coworker (`Vy`) & Budget Meter (`packages/agent`)

Per [DESIGN.md](../../DESIGN.md) section 1.1 and `packages/kernel-contract/src/coworkers.ts`, Ludy eSign uses **Vy** (`gm`, cross-app coworker and assistant) rather than inventing a new coworker character.

1. **Metered AI Features (`packages/agent/src/meter.ts`):**
   - Register six keys in `AI_FEATURES` under module `'sign'` (two in Slice 1c, four across Slices 3-4):
     - `'sign.field_propose'` *(Slice 1c)*: analyzes `pdf_inspect` page dimensions and extracted text blocks alongside the envelope's signer roles (`role_label`, `name`) to suggest likely signature, initial, date, and text box coordinates (`x_norm, y_norm, w_norm, h_norm, page_number, field_type, signer_id`).
     - `'sign.clause_summary'` *(Slice 1c)*: produces a short plain-Vietnamese (or document-language) executive brief + key obligations and flagged risk clauses (auto-renewal, unilateral termination, penalty caps, jurisdiction, unlimited indemnity), each strictly pinned to `{ pageNumber, quoteExcerpt, riskLevel, note }`.
     - `'sign.acceptance_draft'` *(Slice 3b, [#3812](https://github.com/DOS/Ludy/issues/3812))*: summarizes completed project tasks into 3-5 concise tainted `Đề xuất` handover bullets verified deterministically against real project task titles/IDs (falls back to populating the deliverable table directly from completed tasks when AI is off).
     - `'sign.obligation_extract'` *(Slice 4e, [#3821](https://github.com/DOS/Ludy/issues/3821))*: extracts post-signature tainted `Đề xuất` effective/expiry dates, auto-renewal notice window, `NUMERIC(20,4)` decimal-string contract value, and milestone obligations pinned to `{ pageNumber, quoteExcerpt }` verified against extracted PDF text (100% manual entry when AI is off).
     - `'sign.version_diff'` *(Slice 4f, [#3822](https://github.com/DOS/Ludy/issues/3822))*: summarizes commercial risk deltas on top of deterministic page/clause PDF text comparison between two uploaded contract versions (`tools: []`, 100% deterministic text diff when AI is off).
     - `'sign.contract_draft'` *(Slice 4f, [#3822](https://github.com/DOS/Ludy/issues/3822))*: customizes clauses inside Ludy's built-in Vietnamese/bilingual SME starter contract templates under `Đề xuất` for human review before generating a tagged A4 PDF (offline deterministic template PDF generation works 100% when AI is off).
   - Every invocation runs inside `withAiScope` + `metered()` with `tools: []` ([ADR-0018](../adr/0018-untrusted-content.md)), honoring org budget limits, per-feature kill switches, and zero model cost tracking leaks. Public unauthenticated routes (`/-/sign`, `/-/sign/d`, `/-/sign/p`) **never** invoke LLM endpoints; Slice 4f's counterparty summary (`share_summary_with_signers`) serves only static text already reviewed and approved by the sender.
2. **Untrusted Data & Deterministic Checks ([ADR-0018](../adr/0018-untrusted-content.md)):**
   - Counterparty or user-uploaded PDFs are untrusted content: prompt injection strings inside contracts (`"Ignore previous instructions..."`) are wrapped as untrusted quoted data blocks with **`tools: []`** (zero tool access).
   - Output parses through `z.strictObject` schemas and deterministic server checks before saving to `crove_sign.ai_analysis`:
     - Drop any proposed field with `page_number < 1` or `> envelope.page_count`.
     - Drop/clamp boxes outside `[0, 1]` or smaller than minimum legible dimensions.
     - Require `signer_id` to belong to the draft envelope.
     - Verify `quoteExcerpt` in `clause_summary` matches normalized extracted page text (dropping hallucinated citations).
3. **Human Approval & Tainted UI:**
   - Proposed fields do **not** touch `crove_sign.field` automatically. The prepare UI renders them cleanly as dotted `proposal` / `border-proposal` overlays labeled `"De xuat"` (`Đề xuất` in UI) with `"Ap dung"` / `"Bo qua"` controls.
   - Only `sign.ai.apply_proposals` (triggered by an authenticated human click) converts selected proposals into real `crove_sign.field` rows (`proposed_by_ai = true`).
   - Vy can **never** call `sign.envelope.send` or `sign.signer.create_link`.
4. **Graceful AI-Off Degradation:**
   - When AI is disabled for the instance/org, a kill switch trips, or the AI budget meter reaches its cap, `Vy` shows a calm inline notice (`"Vy tam nghi - ban van co the ke khung va gui ky thu cong binh thuong"`), while upload, manual field placement, Zalo/email sending, OTP, signing, sealing, and audit export work identically.

---

## 7. UI/UX Design Alignment ([DESIGN.md](../../DESIGN.md))

### 7.1 App Switcher & Navigation Budget

- Add `'sign'` (`eSign` in both `vi` and `en`, updated from `Ký kết` per 2026-11-17 owner decision) to `APP_ORDER` (`apps/app/src/lib/apps.ts`) and `MODULE_SCREENS` (`packages/kernel-contract/src/screens.ts`), toggleable per org under [ADR-0053](../adr/0053-per-org-app-enablement.md).
- Maintain [DESIGN.md](../../DESIGN.md) `#3225` rule: unique sidebar nav labels within the app and fit comfortably within `1366x768` without vertical sidebar scrolling:
  - `/sign/envelopes` (`Hồ sơ ký` / `Envelopes`) - default workspace list view
  - `/sign/verify` (`Kiểm tra tệp` / `Verify PDF`) - drag/drop offline SHA-256 verification tool
  - *(Slice 2)* `/sign/templates` (`Mẫu tài liệu` / `Templates`)
- Register `{ path: '/-/sign', public: true }` (and `{ path: '/-/sign/d', public: true }` in Slice 2a `A1`) in `outside` screens (`packages/kernel-contract/src/screens.ts`) + React router (`apps/app/src/router.tsx`).

### 7.2 Core Screens & Visual Tokens

All screens follow [DESIGN.md](../../DESIGN.md) OKLCH semantic tokens (`primary`, `proposal`, `success`, `warning`, `destructive`, `field-border`, `border`), typography (`Be Vietnam Pro` UI body, `JetBrains Mono` for SHA-256 digests and certificate codes), and radii (`6px` buttons/inputs, `8px` cards, `12px` modals):

1. **Envelope List (`/sign/envelopes`):**
   - Primary CTA button `"Tải hợp đồng lên"` (`New envelope`), status filter pills (`Tất cả`, `Nháp`, `Đang chờ ký`, `Hoàn tất`, `Từ chối / Hết hạn`).
   - Clean single-row cards showing title, signer progress pill (e.g., `1/2 đã ký`), routing badge (`Song song` / `Tuần tự`), and direct quick actions: `"Chép link Zalo"` (calls `sign.signer.create_link` for active link-mode signer), `"Nhắc ký"`, or `"Tải bản đã niêm phong"`.
2. **Prepare & Field Placer (`/sign/envelopes/:id`):**
   - **Left rail (280px):** Signer list with distinct color chips per signer, sequential order selector (`#1`, `#2`, ...), delivery mode toggle (`Link Zalo/Chat` vs `Email`), Email OTP toggle, plus **Vy Clause Summary card** highlighting risks (`warning` / `destructive` chips clickable to jump to that PDF page).
   - **Center canvas:** crisp pure-JS PDF page viewer with keyboard & drag-drop placement (`Chữ ký`, `Ký nháy`, `Ngày ký`, `Văn bản`, `Đánh dấu`). Unapplied Vy suggestions display in `proposal` dashed borders with `"Đề xuất - Kéo hoặc bấm Áp dụng"`.
   - **Header bar:** primary human confirmation button `"Gửi yêu cầu ký"` opening a concise summary dialog (signers, delivery channels, OTP status) before locking the draft.
3. **Public Signing Ceremony (`/-/sign#<token>`, plus Slice 2a `A1` `/-/sign/d#<token>` & `A2` `Approver` UI):**
   - Mobile-first (`375px`+ responsive) chrome-free layout so recipients opening links inside Zalo in-app browser or mobile Safari/Chrome can read comfortably and sign in under 30 seconds.
   - If `require_email_otp = true`: clean 6-digit OTP verification card first (`"Xác thực email trước khi xem tài liệu"`, masked email shown, `"Gửi lại mã"` with countdown). Document stays hidden until OTP passes.
   - Top sticky bar: document title, `"Còn 2 ô cần hoàn tất"` jump-to-next-field pill button, `"Từ chối ký"` secondary action, and `"Hoàn tất ký"` primary action enabled only once required fields + consent checkbox (`"Tôi đồng ý giao dịch và ký kết tài liệu này bằng phương thức điện tử"`) are filled.
   - Signature modal: two clean tabs (**Vẽ tay** using smooth touch/mouse canvas; **Gõ tên** rendering Vietnamese `Be Vietnam Pro` / signature styles into sanitized PNG). Recipients with `Signer` role fill fields and draw/type a signature; Slice 2a `Approver` recipients (`A2`) use a dedicated lightweight approval UI (approve or decline without drawing).
4. **Sealed Evidence & Verify Screen (`/sign/envelopes/:id` sealed tab & `/sign/verify`):**
   - Download buttons for **Original PDF**, **Sealed PDF + Certificate Summary**, and **Certificate JSON**, alongside copyable `source_sha256`, `sealed_sha256`, and `certificate_code` in `JetBrains Mono`.
   - `/sign/verify`: drop any PDF to compute SHA-256 locally in browser and match against `certificate_code` / certificate JSON, showing `success` (`"Toàn vẹn - khớp bản niêm phong gốc"`) or `destructive` (`"Không khớp - tệp đã thay đổi"`).

---

## 8. Vertical Build Slices & Backlog File Map

All slices are sized as standalone, end-to-end PRs under Milestone **`M3 Paid pilot`** and Priority **`priority:P2`** under Epic `#3318`. Protected paths ([AGENTS.md](../../AGENTS.md) / `tools/ci/protected-paths.mjs`) are flagged per slice so the Line PO schedules an independent security review and Platform PO review when shared-core files change.

### Slice 1a: `crove_sign` Schema, Evidence Isolation, `crove-extract` PDF Ops & Core Commands

- **Proposed Issue Title:** `feat(sign): add crove_sign schema, crove-extract pdf_inspect/seal, and envelope commands`
- **Scope:**
  - Migration creating `crove_sign` schema (`envelope`, `signer`, `field`, `ai_analysis`, `signing_token`, `signing_otp`, `signing_event`) with tenant PKs, RLS, `signing_token` immutability trigger, and `signing_event` append-only trigger.
  - Add `'sign'` to `AVAILABLE_MODULES` (`ADR-0031` / `ADR-0053`), `'sign_document'` to `UPLOAD_PURPOSES`, and `'sign_document' | 'sign_sealed' | 'sign_certificate'` to `zIngestFile.source` without changing Finance `isDocumentSource`.
  - Add `pdf_inspect` and `pdf_seal` kinds in `@crove/extract-contract` & `apps/extract/` (`pdf-lib` + `Be Vietnam Pro` subset flattening + active JS/encryption rejection + Audit Certificate PDF summary page).
  - Register `modules/sign` manifest (`DATA_CLASSES`, `PERSONAL_DATA_COLUMNS`, `org-purge`, `retention`, `sign-expire-sweep`, `sign-cleanup`), core authenticated `Runtime.execute()` commands (`create`, `inspect_complete`, `update`, `signer`, `field`, `send`, `create_link`, `remind`, `void`, `seal_complete`), and `crove_kernel.file` sealing helpers.
- **Acceptance Criteria:**
  1. `pnpm db:migrate && pnpm db:types && pnpm test` pass; Finance `finance-file-extract` queue never triggers on `'sign_document'` uploads.
  2. `crove-extract` `pdf_inspect` rejects encrypted or JS-bearing PDFs and returns exact `pageCount` + page dimensions; `pdf_seal` stamps PNG signatures + text at normalized `[0,1]` coords, preserves Vietnamese diacritics, appends Audit Certificate page, and stores verified [ADR-0013](../adr/0013-evidence-storage-and-integrity.md) triples.
  3. `tools/test/parser-imports.test.ts` and container checks stay green (zero PDF libraries in `apps/kernel`, `modules/**`, `packages/**`).
  4. `sign-expire-sweep` & `sign-cleanup` obey [ADR-0053](../adr/0053-per-org-app-enablement.md) `keeping` (`runsWhenOff: true`) and `sign-pdf-inspect` / `sign-pdf-seal` obey `work` (`runsWhenOff: false`).
- **Files Touched:**
  - `supabase/migrations/<ts>_crove_sign_core.sql` *(protected path)*
  - `packages/kernel-contract/src/index.ts`, `packages/kernel-contract/src/screens.ts` *(protected / shared-core)*
  - `packages/kernel/src/files.ts`, `packages/kernel/src/personal-data.ts` *(protected path)*
  - `packages/extract-contract/src/index.ts`, `apps/extract/src/parse.ts`, `apps/extract/src/seal.ts`, `apps/extract/src/server.ts` *(protected extraction boundary)*
  - `apps/kernel/src/config.ts`, `apps/kernel/src/jobs-schema.ts`, `apps/kernel/src/kernel.ts`, `apps/kernel/src/org-purge.ts`, `apps/kernel/src/retention.ts` *(protected / shared-core)*
  - `modules/sign/package.json`, `modules/sign/src/{manifest,commands,queries,sealing,events,index}.ts`, DB & unit tests *(new `modules/sign` `package.json` is protected)*.

### Slice 1b: Public Signing Protocol, Optional Email OTP & Replay Invariants

- **Proposed Issue Title:** `feat(sign): add orgless public signing links, replay protection, and email OTP`
- **Scope:**
  - Add `SIGN_PAGE_PATH = '/-/sign'` and `SIGN_TOKEN_PATTERN` to `@crove/kernel-contract`.
  - Implement `runtime.orgless` `SECURITY DEFINER` resolver checking `org_app_on(org_id, 'sign')` + `entitled(org_id, 'sign')` (`MODULE_OFF` -> identical 404).
  - Add HTTP routes in `apps/kernel/src/http.ts` (`/-/sign` static/SPA route + `/api/sign/view`, `/api/sign/pdf`, `/api/sign/otp/request`, `/api/sign/otp/verify`, `/api/sign/submit`, `/api/sign/decline`, `/api/sign/verify`) with `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `RateLimiter`, PNG validation, and **zero CAPTCHA gates (`#203`)**.
  - Implement `sign.signer.mail_data` and `sign.public.otp_mail_data` + `sign.invite` / `sign.otp` / `sign.completed` email templates via [ADR-0034](../adr/0034-outbound-email.md) without storing plaintext tokens/OTPs in queues.
  - Add dedicated security invariant tests under `modules/sign/test/invariant/` (or `apps/kernel/test/invariant/`) verifying: replay rejection under concurrent submits, sequential order blocking, OTP pre-view isolation, `MODULE_OFF` opaque 404, SVG upload rejection, and token immutability trigger.
- **Acceptance Criteria:**
  1. Viewing `POST /api/sign/view` works strictly from `#fragment` POST body; `GET` query params never carry tokens; `Referrer-Policy: no-referrer` present on every response.
  2. When `require_email_otp = true`, `/api/sign/pdf` returns 403/404 until 6-digit OTP passes; 5 wrong attempts lock that OTP code.
  3. Concurrent `sign.public.submit` requests allow strictly 1 commit and reject duplicates cleanly (`409`); sequential signer 2 cannot view PDF before signer 1 completes.
  4. `pnpm test:db` and `Invariant suite (from base)` pass with zero skipped assertions.
- **Files Touched:**
  - `supabase/migrations/<ts>_crove_sign_orgless_resolver.sql` *(protected path)*
  - `packages/kernel-contract/src/index.ts` *(protected / shared-core)*
  - `apps/kernel/src/http.ts`, `apps/kernel/src/sign-link.ts`, `apps/kernel/src/mail-templates.ts` *(protected path: `http.ts`)*
  - `modules/sign/src/{public-commands,sign-mail}.ts`, `modules/sign/test/*.db.test.ts`
  - `modules/sign/test/invariant/*.test.ts` *(protected invariant path)*.

### Slice 1c: `Ký kết` / `eSign` App UI, PDF Field Placer, Vy AI Proposals & E2E

- **Proposed Issue Title:** `feat(sign): build Ky ket app UI, PDF field placer, mobile signing ceremony, and Vy proposals`
- **Scope:**
  - Add `'sign'` (`Ký kết` / `eSign`) to `apps/app/src/lib/apps.ts`, `apps/app/src/lib/modules.ts`, `apps/app/src/router.tsx`, and `apps/app/src/i18n/messages/{vi,en}.ts`.
  - Build Envelope List, Prepare & Field Placer (pure-JS `pdfjs-dist` without `.wasm` files in `apps/app/dist`), Public Signing Ceremony (`/-/sign#<token>`, mobile `375px`+, draw/type PNG signature generator), and local Web Crypto SHA-256 Verify Document screen.
  - Register `AI_FEATURES` `'sign.field_propose'` and `'sign.clause_summary'` in `packages/agent`, implement `modules/sign/src/ai.ts` (`metered()`, `withAiScope`, `tools: []`, deterministic bounds & quote verifier) + prompt-injection extraction/AI redteam tests.
  - Add Playwright E2E smoke test on `docker compose` stack covering: upload -> manual & AI-disabled fallback -> copy Zalo link -> sequential sign (with email OTP checked via Mailpit) -> seal -> download & verify SHA-256 -> `MODULE_OFF` 404.
- **Acceptance Criteria:**
  1. App switcher toggles `Ký kết` / `eSign` cleanly per org; sidebar fits `1366x768` with unique labels.
  2. `apps/kernel/test/container/image-check.mjs` passes (zero `.wasm` / prohibited parsers shipped in `apps/app/dist` or kernel image).
  3. Vy field proposals render with `"Đề xuất"` (`proposal`) styling, require human click to apply, never auto-send, and core flow passes E2E when AI is turned off.
  4. Mobile `375px` E2E signing ceremony completes without CAPTCHA and matches `sealed_sha256` in `/sign/verify`.
- **Files Touched:**
  - `packages/agent/src/{meter,index}.ts`, `packages/agent/test/*` *(shared-core / agent boundary)*
  - `modules/sign/src/ai.ts`, `modules/sign/test/ai-redteam.test.ts`
  - `apps/app/package.json` *(protected path if adding `pdfjs-dist`)*, `apps/app/src/lib/{apps,modules,sign-hash}.ts`, `apps/app/src/router.tsx`, `apps/app/src/i18n/messages/{vi,en}.ts`, `apps/app/src/routes/sign-*.tsx`, `apps/app/src/components/sign/*`
  - `packages/e2e/tests/sign.spec.ts`.

### Slice 2: Reusable Templates, Direct Links, Engage/HR Handoffs & Pluggable Vietnamese CA Adapter

Derived into focused Slice 2 issues (after Slice 1a-1c land cleanly and incorporating 2026-11-17 owner decisions `A1`-`A4`):

1. **Slice 2a - Reusable Templates, Direct Signing Links (`A1`), Roles/Attachments (`A2`) & Deterministic PDF Text Tags (`A3`) (`M3 Paid pilot` / `priority:P2`):**
   - **Title:** `feat(sign): add reusable eSign templates, direct signing links, role kinds, and PDF tag parser`
   - **Scope:**
     - `crove_sign.template`, `template_role` (`Signer` / `Approver` / `CC` per `A2`), `template_field`, and `template_direct_link` (`MACHINERY` per `A1`) migration + CRUD + one-click envelope instantiation + `/sign/templates` UI.
     - Public direct signing link flow `/-/sign/d#<token>` on 1-signer templates (`POST /api/sign/direct/{view,pdf,otp/request,otp/verify,start}`, pre-registered in `route-coverage.test.ts` `PENDING` and `app-gate-routes.test.ts` `pending` under `#3525`), IP + email/token rate limits, optional email OTP, `org_app_on` + entitlement opaque `404`, single-use submit token returned without storing plaintext token (`A1`).
     - Dedicated lightweight `Approver` ceremony UI without drawing, `CC` completion copy, and size-capped SHA-256 sealed PDF + Audit Certificate email attachments via [ADR-0034](../adr/0034-outbound-email.md) (`A2`).
     - Deterministic PDF text tag parser (`{{signature, r1}}`, `{{date, r1}}`, `{{text, r1}}`) inside `crove-extract` with 100% AI-off parity, and Audit Certificate summary page sized to match the document's last page (`A3`).
   - **Files:** `supabase/migrations/*` *(protected)*, `apps/kernel/src/http.ts` *(protected)*, `apps/kernel/test/invariant/{route-coverage,app-gate-routes}.test.ts` *(protected)*, `apps/extract/src/{parse,seal}.ts` *(protected)*, `modules/sign/src/{templates,direct,sign-mail}.ts`, `apps/app/src/routes/sign-{templates,direct}.tsx`.

2. **Slice 2b - Engage Quote & HR Labor Contract Handoffs + Strict HR Visibility (`A4`) (`M3 Paid pilot` / `priority:P2`):**
   - **Title:** `feat(sign): hand off Engage quotes and HR contracts to Ludy eSign`
   - **Scope:** [ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md) browser-carried handoff + `source_kind = 'crm_quote' | 'hr_contract'` & `source_id` tracking + outbox event `sign.envelope.completed` so Finance/Engage/HR mark documents `"Đã ký kết"` with a link to the sealed PDF without cross-module hard FKs, plus strict `owner` / `admin` / `created_by` visibility enforcement on `source_kind = 'hr_contract'` envelopes across queries, commands, and downloads (`A4`).
   - **Files:** `modules/crm/src/quotes.ts`, `modules/hr/src/contracts.ts` (or contract service), `modules/sign/src/{handoff,queries,commands}.ts`, `apps/app/src/routes/crm-*.tsx`, `apps/app/src/routes/hr-*.tsx`.

3. **Slice 2c - Pluggable Vietnamese Public CA Adapter & Legal Compliance Sign-off (`M3 Paid pilot` / `priority:P2`):**
   - **Title:** `feat(sign): add pluggable Vietnam CA adapter (sandbox, VNPT SmartCA, Viettel MySign, MISA WeSign)`
   - **Scope:** Package `packages/sign` (`CA_PROVIDERS = ['sandbox', 'vnpt_smartca', 'viettel_mysign', 'misa_wesign']`, interface `CaSigningAdapter`, `reconcile_only` async callback/polling flow matching `@crove/einvoice`, offline `sandbox` adapter, encrypted org credentials in `crove_sign.ca_connection` `MACHINERY`, `crove_sign.ca_signing_request`, PAdES-LTV CMS assembly in `crove-extract` `pdf_embed_cms`), UI provider setup, and `[commentary]` **owner-action legal gate (`#62`)** validating Law `20/2023/QH15` / Decree `23/2025/ND-CP` & PDPL `91/2025/QH15` consent wording before enabling external CA signing for pilot tenants.
   - **Files:** `packages/sign/package.json` *(protected)*, `packages/sign/src/{index,adapter,sandbox,vnpt-smartca,viettel-mysign,misa-wesign}.ts`, `supabase/migrations/*` *(protected)*, `apps/extract/src/{cms,seal}.ts`, `modules/sign/src/ca.ts`, `apps/app/src/routes/sign-settings.tsx`.

### Slice 3: Suite Handoffs & Proactive Vy `Hôm nay` (`#3811`, `#3812`, `#3813`)

Benchmarked in [esign-competitors-and-ai-2026.md](../research/esign-competitors-and-ai-2026.md) (`M3 Paid pilot` / `priority:P2`):

1. **Slice 3a ([#3811](https://github.com/DOS/Ludy/issues/3811)) - Shared Meeting Minutes Handoff & Reader-Scoped Confidentiality:**
   - **Title:** `feat(sign,meetings): add shared meeting minutes eSign handoff and reader-scoped confidentiality (Slice 3a)`
   - **Scope & Data/Command Impact:**
     - Extend `SIGN_SOURCE_KINDS` and `crove_sign.envelope.source_kind` with `'meeting_minutes'` (`source_id = meeting.id`, zero cross-module hard FKs).
     - Offer `Ký xác nhận qua eSign` on `Ludy Notes -> Cuộc họp` **only** when the meeting's minutes have been explicitly shared by the recorder (never private unshared drafts under [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) / [ADR-0049](../adr/0049-member-scoped-vy.md)) and `sign` is enabled ([ADR-0031](../adr/0031-module-enablement.md) + [ADR-0053](../adr/0053-per-org-app-enablement.md); zero `sign.*` calls when `MODULE_OFF`).
     - Deterministically generate a clean A4 PDF 1.4 summary of shared minutes (title, date/time, attendees, shared summary, decisions, action items, signature placeholders), prefill attendees/external participants, and surface live eSign status badge (`Nháp`, `Đang chờ ký`, `Đã ký xác nhận`, `Từ chối / Đã hủy`, `Hết hạn`) + `Tải bản đã ký` on the meeting screen.
   - **Confidentiality & AI-Off Invariants:**
     - Enforce [ADR-0047](../adr/0047-meeting-notes-audio-and-transcripts.md) reader-scoped visibility across `crove_sign` RLS, `can_read_sign_file`, and `modules/sign` queries/commands so only members permitted to read that meeting (plus `created_by` of the envelope; system workers and single-use capability tokens preserved) can list, view, mutate, or download `meeting_minutes` envelopes and PDFs (`404` zero-existence-oracle parity for non-readers, including `owner`/`admin` when a meeting is attendees-only and they were not shared on it).
     - Reuses already-approved shared minutes or manual notes; works 100% identically with AI off, and a human explicitly reviews and sends every envelope.
   - **Files Touched:** `supabase/migrations/<ts>_crove_sign_meeting_minutes.sql` *(protected)*, `packages/kernel-contract/src/index.ts` *(protected / shared-core)*, `modules/sign/src/{hr-visibility,queries,commands,handoff}.ts`, `modules/meetings/src/*`, `apps/app/src/routes/meeting-*.tsx`, `modules/sign/test/*.db.test.ts`.

2. **Slice 3b ([#3812](https://github.com/DOS/Ludy/issues/3812)) - Project Acceptance Minutes -> eSign -> Finance Sales Invoice Draft Bridge:**
   - **Title:** `feat(sign,projects): add project acceptance minutes eSign handoff, Vy deliverable draft, and Finance invoice bridge (Slice 3b)`
   - **Scope & Data/Command Impact:**
     - Extend `SIGN_SOURCE_KINDS` and `crove_sign.envelope.source_kind` with `'project_acceptance'` (`source_id = project.id`, zero cross-module hard FKs).
     - Add `Lập biên bản nghiệm thu` on `Ludy Dự án` project detail (hidden cleanly when `sign` is `MODULE_OFF`), generate an A4 `Biên bản nghiệm thu bàn giao` PDF with Party A / Party B signature blocks, show live status (`Đã ký nghiệm thu` + `Tải bản đã ký`), and once sealed provide a one-click [ADR-0050](../adr/0050-quote-acceptance-sales-order-and-accounting-handoff.md) browser-carried link opening `Ludy Kế toán`'s sales document / e-invoice draft form prefilled with the project title and sealed acceptance reference (human enters/confirms amounts and issues).
   - **AI Feature Key & 100% AI-Off Parity:**
     - Register `'sign.acceptance_draft'` in `AI_FEATURES` (`packages/agent/src/meter.ts`, `withAiScope` + `metered()`, `tools: []` per [ADR-0018](../adr/0018-untrusted-content.md)) summarizing completed project tasks into 3-5 concise tainted `Đề xuất` handover bullets verified deterministically against real project task titles/IDs.
     - When AI is off, kill-switched, or out of budget, the acceptance builder populates the deliverable table directly from completed project tasks with 100% parity.
   - **Files Touched:** `supabase/migrations/<ts>_crove_sign_project_acceptance.sql` *(protected)*, `packages/kernel-contract/src/index.ts` *(protected / shared-core)*, `packages/agent/src/meter.ts` *(shared-core)*, `modules/sign/src/{ai,commands,queries}.ts`, `modules/projects/src/*`, `apps/app/src/routes/{project-*,finance-*}.tsx`, AI red-team & DB tests.

3. **Slice 3c ([#3813](https://github.com/DOS/Ludy/issues/3813)) - Expiring & Declined Envelopes on Vy `Hôm nay` + Single 24h Pre-Expiry Reminder:**
   - **Title:** `feat(sign,kernel): surface expiring and declined envelopes on Vy Today and add 24h pre-expiry email reminder (Slice 3c)`
   - **Scope & Data/Command Impact:**
     - Surface pending envelopes expiring within 48h and unacknowledged declined envelopes deterministically on Vy's `Hôm nay` (`Today`, `Hôm nay cần bạn`) screen with direct links to `/o/$orgSlug/sign/envelopes/$envelopeId` and quick Zalo link copy/action.
     - Add `auto_remind_before_expiry BOOLEAN NOT NULL DEFAULT true` on `crove_sign.envelope` and `pre_expiry_reminded_at TIMESTAMPTZ` on `crove_sign.signer`; send at most one automatic polite reminder email ~24h before `expires_at` (`ADR-0034`) to pending/viewed `delivery_mode = 'email'` signers (`ADR-0053` `work` gated on `org_app_on(org_id, 'sign')`, respecting `mail_suppression`, per-org error isolation, and zero plaintext tokens stored in queues).
   - **Confidentiality & AI-Off Invariants:**
     - Strictly enforces `hr_contract` and `meeting_minutes` reader visibility and `org_app_on(org_id, 'sign')` on `Today` feed queries.
     - Uses deterministic SQL/rule evaluation with **zero LLM calls** (100% AI-off by design).
   - **Files Touched:** `supabase/migrations/<ts>_crove_sign_pre_expiry_reminder.sql` *(protected)*, `modules/sign/src/{queries,commands,sign-mail,manifest}.ts`, `apps/kernel/src/mail-templates.ts`, Vy `Today` feed module/UI (`modules/vy/*` or `apps/app/src/routes/today*.tsx`), PostgreSQL 17 DB & component tests.

### Slice 4: Operational Parity, Vietnam SME Essentials & AI-Native Agreement Lifecycle (`#3817` - `#3822`)

Benchmarked in [esign-competitors-and-ai-2026.md](../research/esign-competitors-and-ai-2026.md) (`M3 Paid pilot` / `priority:P2`):

1. **Slice 4a ([#3817](https://github.com/DOS/Ludy/issues/3817)) - Company Stamp Field, Saved Signature/Stamp Profile & 1-Click Initial-All-Pages:**
   - **Title:** `feat(sign,extract): add company stamp field, saved member signature/stamp profile, and 1-click initial-all-pages (Slice 4a)`
   - **Scope & Data/Command Impact:**
     - Add `field_type = 'stamp'` on `crove_sign.field` and `crove_sign.template_field` for red corporate/title stamp boxes rendered cleanly by `crove-extract` `pdf_seal` (validated PNG `<= 256 KB`, zero SVG/XSS).
     - Add `crove_sign.member_signature` (saved member drawn/typed signature & initials) and `crove_sign.org_stamp` (`owner`/`admin` RBAC corporate/title stamp images) with `Runtime.execute()` CRUD commands, `crove_kernel.org_purge`, `DATA_CLASSES`, `PERSONAL_DATA_COLUMNS`, and `rls-matrix.db.test.ts` coverage.
     - Add 1-click **`Ký nháy tất cả các trang`** helper on multi-page contracts/templates placing aligned `initial` boxes across pages `1..N-1` (bottom-right or bottom-left margin).
   - **AI-Off & Security Invariants:** 100% deterministic offline operation on `docker compose up` with AI off; strict PNG magic-byte + dimension validation (`png.ts`) and tenant RLS isolation.
   - **Files Touched:** `supabase/migrations/<ts>_crove_sign_stamp_saved_profiles.sql` *(protected)*, `packages/kernel-contract/src/{index,manifest}.ts` *(protected / shared-core)*, `packages/kernel/src/personal-data.ts` *(protected)*, `apps/kernel/src/org-purge.ts` *(protected)*, `packages/extract-contract/src/index.ts` *(protected)*, `apps/extract/src/seal.ts` *(protected)*, `modules/sign/src/{commands,queries,templates,sealing,png}.ts`, `apps/app/src/components/sign/*`, `packages/db/test/rls-matrix.db.test.ts`.

2. **Slice 4b ([#3818](https://github.com/DOS/Ludy/issues/3818)) - Structured `dropdown` / `radio` Fields & Verified Signer Supporting Attachments:**
   - **Title:** `feat(sign,extract): add dropdown/radio fields and verified signer supporting attachments (Slice 4b)`
   - **Scope & Data/Command Impact:**
     - Extend `field_type` with `'dropdown'`, `'radio'` (`options_json` bounded `<= 50` options, flattened into PDF content streams by `crove-extract` `pdf_seal` with full Vietnamese diacritics + deterministic `{{dropdown, r1, ...}}` text tag parsing) and `'attachment'`.
     - Allow senders to request supporting documents (`CCCD`, `Giấy ĐKKD`, `Giấy ủy quyền`) from signers during `/-/sign` via `POST /api/sign/attachment`: bounded `<= 10 MB` PDF/PNG/JPEG, magic-byte verified, stored via [ADR-0013](../adr/0013-evidence-storage-and-integrity.md) `crove_kernel.file` (`source = 'sign_attachment'`, excluded from Finance OCR), with `sha256` recorded in `crove_sign.signing_event` (`attachment_uploaded`) and the Audit Certificate.
   - **Security & AI-Off Invariants:** Public `/api/sign/attachment` enforces active token validity, OTP precondition (if `require_email_otp = true`), `org_app_on(org_id, 'sign')`, per-IP/token rate limits, strict MIME + magic-byte checks, `can_read_sign_file` confidentiality (`hr_contract` & `meeting_minutes` aware), and zero existence oracle (`404`); 100% deterministic with AI off.
   - **Files Touched:** `supabase/migrations/<ts>_crove_sign_choice_attachments.sql` *(protected)*, `packages/kernel-contract/src/index.ts` *(protected / shared-core)*, `packages/kernel/src/files.ts` *(protected)*, `apps/kernel/src/http.ts` *(protected)*, `apps/kernel/test/invariant/{route-coverage,app-gate-routes}.test.ts` *(protected)*, `packages/extract-contract/src/index.ts` *(protected)*, `apps/extract/src/{parse,seal}.ts` *(protected)*, `modules/sign/src/{commands,public-commands,sealing,templates}.ts`, `apps/app/src/{routes/sign-*,components/sign/*}`.

3. **Slice 4c ([#3819](https://github.com/DOS/Ludy/issues/3819)) - In-Flight Recipient Correction & Audited Signer Delegation:**
   - **Title:** `feat(sign): add in-flight recipient correction and audited signer delegation (Slice 4c)`
   - **Scope & Data/Command Impact:**
     - Add `sign.signer.correct_recipient` (`R2`, human-only): allows envelope `created_by` / org `owner` / `admin` to fix a typo in an unsigned signer's name, email, phone, or delivery mode on a `sent` / `partially_signed` envelope **without voiding already-completed signatures**, atomically revoking prior tokens/OTPs for that signer, appending `signer_corrected` to `signing_event`, and re-sending/minting the updated invitation.
     - Add `allow_delegation BOOLEAN NOT NULL DEFAULT false` on `crove_sign.envelope` and `POST /api/sign/delegate` (`sign.public.delegate`): allows a pending recipient on `/-/sign` to delegate signing authority (e.g., purchasing contact -> company Director `giamdoc@example.com`) with name, email, and reason, atomically consuming/revoking the delegator's token, recording `delegated_from_name` / `delegated_from_email` + `signer_delegated` in `signing_event` and the Audit Certificate.
   - **Security & Anti-Relay Invariants:** Preserves already-signed signers and PDF integrity; prevents open mail relay via strict per-signer delegation cap (`delegation_count <= 2`), single-mailbox RFC validation, `mail_suppression` check, and IP/token rate limiting; 100% deterministic with AI off.
   - **Files Touched:** `supabase/migrations/<ts>_crove_sign_correct_delegate.sql` *(protected)*, `apps/kernel/src/{http,mail-templates}.ts` *(protected: `http.ts`)*, `apps/kernel/test/invariant/{route-coverage,app-gate-routes}.test.ts` *(protected)*, `modules/sign/src/{commands,public-commands,sign-mail,sealing}.ts`, `modules/sign/test/invariant/*.test.ts` *(protected)*, `apps/app/src/routes/sign-*.tsx`.

4. **Slice 4d ([#3820](https://github.com/DOS/Ludy/issues/3820)) - Isolated In-Person Host Signing Ceremony & Self-Service Public Template Hub:**
   - **Title:** `feat(sign): add in-person host signing ceremony and self-service public template hub (Slice 4d)`
   - **Scope & Data/Command Impact:**
     - **In-Person Host Signing (`Ký trực tiếp tại quầy`):** authenticated org member on `/o/$orgSlug/sign/envelopes/$envelopeId` starts an audited face-to-face signing session (`sign.signer.start_in_person`, `R2`) for a pending signer on the same tablet/laptop, recording `host_user_id` and `in_person_signed` in `crove_sign.signing_event` and the Audit Certificate.
     - **Self-Service Public Template Hub (`/-/sign/p/$orgSlug`):** optional toggle `listed_on_public_hub = true` on `crove_sign.template_direct_link` publishing a clean, zero-CAPTCHA (`#203`) public directory (`POST /api/sign/hub/view`) of opted-in active 1-signer templates (NDA, service intake, consent form).
   - **Security & Isolation Invariants:** Handing the device in In-Person mode opens the isolated `/-/sign#<token>` token ceremony (`credentials: 'omit'`, locked kiosk header with no back-links to `/o/$orgSlug/*` so customer taps never expose tenant screens or session cookies); Public Hub exposes only opted-in active 1-signer templates and returns opaque `404` when `org_app_on(org_id, 'sign')` or entitlement is off ([ADR-0053](../adr/0053-per-org-app-enablement.md)); 100% deterministic with AI off.
   - **Files Touched:** `supabase/migrations/<ts>_crove_sign_in_person_hub.sql` *(protected)*, `packages/kernel-contract/src/screens.ts` *(protected / shared-core)*, `apps/kernel/src/http.ts` *(protected)*, `apps/kernel/test/invariant/{route-coverage,app-gate-routes}.test.ts` *(protected)*, `modules/sign/src/{commands,direct-public,templates,sealing}.ts`, `apps/app/src/{router.tsx,routes/sign-*.tsx}`.

5. **Slice 4e ([#3821](https://github.com/DOS/Ludy/issues/3821)) - Post-Signature AI Obligation & Renewal Extraction, Renewals View & Vy `Hôm nay` Alerts:**
   - **Title:** `feat(sign,agent): add post-signature AI obligation & renewal extraction, renewals view, and Vy Today alerts (Slice 4e)`
   - **Scope & Data/Command Impact:**
     - Create `crove_sign.envelope_obligation` (`org_id`, `id`, `envelope_id`, `counterparty_name`, `effective_date`, `expiry_date`, `renewal_notice_days`, `auto_renew`, `contract_value NUMERIC(20,4)`, `currency`, `obligations_json` `{ due_date, title, status }[]`) with `sign.obligation.upsert` (`R1`, human-confirmed) and full `DATA_CLASSES`, `PERSONAL_DATA_COLUMNS`, `org_purge`, and `rls-matrix.db.test.ts` coverage.
     - Add `Sắp gia hạn / Nghĩa vụ` filter/tab on `/o/$orgSlug/sign/envelopes` and surface confirmed upcoming renewal notice windows (`<= 30` days) and overdue contract obligations deterministically on Vy's `Hôm nay` screen.
   - **AI Feature Key, Money & Confidentiality Invariants:**
     - Register `'sign.obligation_extract'` in `packages/agent` (`withAiScope` + `metered()`, `tools: []` per [ADR-0018](../adr/0018-untrusted-content.md)): Vy proposes tainted `Đề xuất` dates, `contract_value` (strict decimal strings via `@crove/l10n-vn`, never JS floats), auto-renewal notice window, and payment/delivery milestones pinned to `{ pageNumber, quoteExcerpt }` verified deterministically against PDF text.
     - Works 100% manually when AI is off; strictly enforces `hr_contract` and `meeting_minutes` confidentiality across obligation queries and Vy `Hôm nay` alerts.
   - **Files Touched:** `supabase/migrations/<ts>_crove_sign_obligations.sql` *(protected)*, `packages/kernel-contract/src/{index,manifest}.ts` *(protected / shared-core)*, `packages/kernel/src/personal-data.ts` *(protected)*, `apps/kernel/src/org-purge.ts` *(protected)*, `packages/agent/src/meter.ts` *(shared-core)*, `modules/sign/src/{ai,commands,queries}.ts`, `modules/vy/*`, `apps/app/src/routes/sign-*.tsx`, `packages/db/test/rls-matrix.db.test.ts`, AI red-team tests.

6. **Slice 4f ([#3822](https://github.com/DOS/Ludy/issues/3822)) - Sender-Approved Counterparty AI Summary, PDF Version Diff & Vietnamese SME Starter Contract Drafter:**
   - **Title:** `feat(sign,agent,extract): add sender-approved counterparty AI summary, PDF version diff, and Vietnamese SME contract drafter (Slice 4f)`
   - **Scope & Data/Command Impact:**
     - **Sender-Approved Counterparty Summary on `/-/sign`:** optional sender toggle `share_summary_with_signers = true` on `crove_sign.envelope` publishing the human-reviewed, page-cited summary of key terms onto `/-/sign` with clickable page jumps and an explicit reference-only disclaimer.
     - **PDF Contract Version Diff (`So sánh bản sửa đổi`):** deterministic page/clause text diff between two uploaded PDFs (e.g., Draft `v1` vs Counterparty-edited `v2`) via `crove-extract` inspected text, plus optional metered Vy commercial risk delta summary (`'sign.version_diff'`).
     - **Vietnamese SME Starter Contract Drafter (`Soạn hợp đồng mẫu`):** built-in Vietnamese/bilingual starter templates (`NDA 2 chiều`, `Hợp đồng dịch vụ`, `Biên bản nghiệm thu`, `Biên bản thanh lý`, `Hợp đồng cộng tác viên`) generating clean A4 PDFs with embedded `{{signature, r1}}` / `{{date, r1}}` tags offline, plus optional metered Vy clause customization (`'sign.contract_draft'`) under `Đề xuất` for human review before creating an envelope or template.
   - **AI Feature Keys, Zero-Public-LLM & AI-Off Invariants:**
     - `'sign.version_diff'` and `'sign.contract_draft'` run strictly in `packages/agent` (`withAiScope` + `metered()`, `tools: []` per [ADR-0018](../adr/0018-untrusted-content.md)) with deterministic citation/clause checks.
     - Counterparty summary on `/-/sign` serves pre-approved static data with **zero unauthenticated public LLM calls or budget drain**; PDF version diff and all 5 Vietnamese starter contract PDFs work **100% offline when AI is off**.
   - **Files Touched:** `supabase/migrations/<ts>_crove_sign_shared_summary.sql` *(protected)*, `packages/agent/src/meter.ts` *(shared-core)*, `packages/extract-contract/src/index.ts` *(protected)*, `apps/extract/src/*` *(protected)*, `modules/sign/src/{ai,commands,public-commands,drafter,diff}.ts`, `apps/app/src/routes/sign-*.tsx`, AI red-team & DB tests.
