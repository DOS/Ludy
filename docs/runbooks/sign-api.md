# eSign MCP tools and `/api/v1/sign/*` external REST API

Tracking: issue #4441 (Slice 5c of epic #4438). Related: [The MCP endpoint](mcp-endpoint.md), [ADR-0051](../adr/0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md), [ADR-0053](../adr/0053-per-org-app-enablement.md).

Slice 5c exposes two read-first integration surfaces for Ludy eSign (`ludy_sign`) while preserving the human-in-the-loop rule (an AI coworker or external caller can inspect status and prepare a draft, never auto-send an envelope or mint signing links):

1. **Four read-only MCP tools (`ludy.read`, company grants only)** on `PUBLIC_URL/mcp` so connected AI coworkers (Claude, ChatGPT, OpenClaw, DOS Claw) can answer questions about contract status, renewals, and reusable templates.
2. **Scoped org API keys (`ludy_sign.api_key`) and six `/api/v1/sign/*` REST endpoints** so external ERP, accounting, or back-office systems can poll envelope status, download sealed PDFs and audit certificates, list templates, and instantiate draft envelopes from templates for human review.

## Four read-only MCP tools (`ludy.read`, company grants only)

All four tools require an active **company** OAuth grant (`mcp_company`) of an org `owner` or `admin` holding `ludy.read`. Member-bound grants (`mcp_member`) and plain workspace member roles are not offered these tools and are refused (`403 FORBIDDEN`) by all four queries.

| Tool | Query | Input | Returns |
| --- | --- | --- | --- |
| `ludy_sign_envelopes_list` | `sign.mcp.envelopes` | `{ status?, limit? }` (`limit` 1..50, default 25) | Non-confidential envelopes (`id`, `title`, `status`, `routingMode`, `sourceKind`, `expiresAt`, `completedAt`, `createdAt`, `signerCounts`), `total`, `truncated` |
| `ludy_sign_envelope_get` | `sign.mcp.envelope_get` | `{ envelopeId }` | Envelope metadata (`inspectStatus`, `sealStatus`, `certificateCode`, `pageCount`, lifecycle timestamps), `signerCounts`, masked `signers` (`id`, `routingOrder`, `signerRole`, `roleLabel`, `status`, `viewedAt`, `signedAt`, `declinedAt`), and confirmed `obligation` (`effectiveDate`, `expiryDate`, `renewalNoticeDays`, `autoRenew`, `contractValue`, `currency`, `items`) |
| `ludy_sign_renewals_list` | `sign.mcp.renewals` | `{ withinDays?, limit? }` (`withinDays` 1..365, default 90; `limit` 1..50, default 25) | Completed non-confidential contracts with open confirmed obligations or renewal/expiry within `withinDays` (`envelopeId`, `title`, `effectiveDate`, `expiryDate`, `renewalNoticeDate`, `daysUntilNotice`, `daysUntilExpiry`, `autoRenew`, `currency`, `contractValue`, `pendingObligationCount`, `overdueObligationCount`, `nextObligationDueDate`), `total`, `truncated` |
| `ludy_sign_templates_list` | `sign.mcp.templates` | `{ limit? }` (`limit` 1..50, default 25) | Active reusable templates (`id`, `title`, `routingMode`, `roleCount`, `directLinkEnabled`, `updatedAt`), `total`, `truncated` |

### Privacy and confidentiality boundaries

- **Strict exclusion of confidential envelopes:** Envelopes with `source_kind` in `('hr_contract', 'meeting_minutes')` are excluded in both Postgres RLS (`ludy_sign` sealed company policies) and query projections. Asking `ludy_sign_envelope_get` for an `hr_contract`, `meeting_minutes`, or foreign-org envelope returns the same `404 SIGN_ENVELOPE_NOT_FOUND` as an unknown ID.
- **Zero secrets or counterparty PII:** Signing tokens, email OTP challenges, signer names, emails, phones, counterparty names, unconfirmed AI obligation proposals, object-storage keys, direct-link tokens, CA credentials, saved signatures, and org stamps never leave Ludy through MCP.
- **Tainted text hygiene:** Every free-text string (`title`, `roleLabel`, and obligation item `title`) is collapsed to a single plain line with control and bidirectional characters stripped, and tool descriptions mark returned text as untrusted data.
- **Stop switches and app gate:** Disconnecting the grant, engaging the global or org Stop AI switch (`KILL_SWITCH_ON`), or switching off the eSign app (`MODULE_OFF`) cuts access immediately.

## Scoped org API keys (`ludy_sign.api_key`)

Org `owner` and `admin` members manage eSign API keys in `/o/<slug>/sign/settings` (up to 50 active keys per org; active key names are case-insensitively unique, and duplicate active names return `409 SIGN_API_KEY_DUPLICATE_NAME`):

- **Key format and hashing:** Keys are generated at the HTTP RPC edge (`apps/kernel/src/rpc.ts`) as `ludy_sk_<32 CSPRNG bytes base64url>` before `Runtime.execute()`. Only `key_prefix` (for display) and `key_sha256` (64-char lowercase hex SHA-256) enter the command payload, audit trail, idempotency store, and `ludy_sign.api_key`. The cleartext secret is returned once in the creation response and cannot be recovered afterward.
- **`MACHINERY` isolation:** `ludy_sign.api_key` has `ENABLE ROW LEVEL SECURITY`, zero grants to `PUBLIC`, `ludy_tenant`, `ludy_app`, `ludy_worker`, or `ludy_definer_tenant`, and `ludy_kernel.agent_write_guard_install('ludy_sign.api_key')`. Only narrow `SECURITY DEFINER` procedures in `ludy_sign` touch the table.
- **Scopes:**
  - `sign:read`: read envelopes, download completed sealed PDFs and audit certificates, and list active templates.
  - `sign:draft`: instantiate a `draft` envelope from an active, inspected template for human review in Ludy.
- **Expiry and revocation:** Keys optionally carry `expiresAt` and can be revoked immediately (`sign.api_key.revoke`). Revoked or expired keys answer `401 UNAUTHENTICATED`.

## `/api/v1/sign/*` REST API reference

Every request authenticates with `Authorization: Bearer ludy_sk_...` over HTTPS. Passing `?token=`, `?api_key=`, `?access_token=`, or `?key=` in the query string is rejected immediately with `400 SIGN_QUERY_TOKEN_FORBIDDEN` before authentication so secrets never land in access logs or referrers. Every response sets `Cache-Control: no-store`.

When an org's eSign app is switched off (`ludy_kernel.org_app_on(org_id, 'sign') = false`) or its billing subscription does not entitle `sign`, all `/api/v1/sign/*` endpoints return an opaque `404 NOT_FOUND` without updating `last_used_at`.

### 1. List envelopes

`GET /api/v1/sign/envelopes?status=completed&limit=25` (requires `sign:read`)

```bash
curl -sS "$PUBLIC_URL/api/v1/sign/envelopes?status=completed&limit=25" \
  -H "Authorization: Bearer $LUDY_SIGN_API_KEY"
```

- Query parameters: optional `status` (`draft`, `sent`, `in_progress`, `completed`, `declined`, `voided`, `expired`), optional `limit` (`1..100`, default `50`).
- Excludes `hr_contract` and `meeting_minutes` envelopes.
- Status codes: `200`, `400 SIGN_QUERY_TOKEN_FORBIDDEN`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `422 VALIDATION`, `429 RATE_LIMITED`.

### 2. Get envelope detail

`GET /api/v1/sign/envelopes/:id` (requires `sign:read`)

```bash
curl -sS "$PUBLIC_URL/api/v1/sign/envelopes/$ENVELOPE_ID" \
  -H "Authorization: Bearer $LUDY_SIGN_API_KEY"
```

- Returns envelope metadata, SHA-256 digests (`sourceSha256`, `sealedSha256`, `certificateSha256`), and signer progress (`id`, `roleKey`, `routingOrder`, `signerRole`, `roleLabel`, `name`, `deliveryMode`, `requireEmailOtp`, `status`, `viewedAt`, `signedAt`, `declinedAt`).
- Never returns signing tokens, OTP hashes, signer emails/phones, or storage keys. Confidential (`hr_contract`, `meeting_minutes`) and foreign-org IDs return `404 NOT_FOUND`.
- Status codes: `200`, `400 SIGN_QUERY_TOKEN_FORBIDDEN`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `429 RATE_LIMITED`.

### 3. Download sealed PDF

`GET /api/v1/sign/envelopes/:id/sealed` (requires `sign:read`)

```bash
curl -sS "$PUBLIC_URL/api/v1/sign/envelopes/$ENVELOPE_ID/sealed" \
  -H "Authorization: Bearer $LUDY_SIGN_API_KEY" \
  -o sealed-contract.pdf
```

- Requires `status = 'completed'` and `seal_status = 'sealed'` (otherwise returns `409 SIGN_ENVELOPE_NOT_SEALED`).
- Streams verified bytes (`store.readVerified` against `sealed_sha256` and `sealed_generation`) as `application/pdf` with `X-Content-SHA256`.
- Status codes: `200`, `400 SIGN_QUERY_TOKEN_FORBIDDEN`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 SIGN_ENVELOPE_NOT_SEALED`, `429 RATE_LIMITED`, `503 SIGN_PDF_BUSY`.

### 4. Download audit certificate

`GET /api/v1/sign/envelopes/:id/certificate` (requires `sign:read`)

```bash
curl -sS "$PUBLIC_URL/api/v1/sign/envelopes/$ENVELOPE_ID/certificate" \
  -H "Authorization: Bearer $LUDY_SIGN_API_KEY" \
  -o certificate.json
```

- Requires `status = 'completed'` and `seal_status = 'sealed'` (otherwise returns `409 SIGN_ENVELOPE_NOT_SEALED`).
- Streams the verified audit certificate JSON (`store.readVerified` against `certificate_sha256` and `certificate_generation`) as `application/json; charset=utf-8` with `X-Content-SHA256`.
- Status codes: `200`, `400 SIGN_QUERY_TOKEN_FORBIDDEN`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 SIGN_ENVELOPE_NOT_SEALED`, `429 RATE_LIMITED`, `503 SIGN_PDF_BUSY`.

### 5. List active templates

`GET /api/v1/sign/templates?limit=50` (requires `sign:read`)

```bash
curl -sS "$PUBLIC_URL/api/v1/sign/templates?limit=50" \
  -H "Authorization: Bearer $LUDY_SIGN_API_KEY"
```

- Returns active templates with `roles` (`roleKey`, `signerRole`, `roleLabel`, `routingOrder`, `deliveryMode`, `requireEmailOtp`) and `textFieldLabels` (distinct non-empty labels of `text` template fields that `POST /api/v1/sign/envelopes/from-template` can prefill via `textDefaults`). Never returns direct-link tokens.
- Status codes: `200`, `400 SIGN_QUERY_TOKEN_FORBIDDEN`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `422 VALIDATION`, `429 RATE_LIMITED`.

### 6. Create a draft envelope from a template

`POST /api/v1/sign/envelopes/from-template` (requires `sign:draft`)

```bash
curl -sS -X POST "$PUBLIC_URL/api/v1/sign/envelopes/from-template" \
  -H "Authorization: Bearer $LUDY_SIGN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "01950000-0000-7000-8000-000000000001",
    "title": "Service Agreement - Acme Co",
    "recipients": [
      {
        "roleKey": "client",
        "name": "Nguyen Van A",
        "email": "a.nguyen@example.com"
      }
    ],
    "textDefaults": {
      "Contract Number": "HD-2027-042"
    }
  }'
```

- **Draft-only guarantee:** Creates an envelope in `status = 'draft'` (`source_kind = 'standalone'`), copies template roles and fields (prefilling matching `text` fields from `textDefaults`), appends a hash-chained `envelope_created` event (`actor_label = 'api_key:<prefix>'`), and returns HTTP `201`:
  ```json
  {
    "id": "01950000-0000-7000-8000-000000000099",
    "status": "draft",
    "reviewUrl": "https://app.example.com/o/acme/sign/envelopes/01950000-0000-7000-8000-000000000099"
  }
  ```
- **Human-in-the-loop:** No signing token is minted and no email is queued. An authorized workspace member opens `reviewUrl`, checks recipients and prefilled fields, and sends the envelope in Ludy.
- Status codes: `201`, `400 SIGN_QUERY_TOKEN_FORBIDDEN`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `404 NOT_FOUND`, `409 SIGN_TEMPLATE_ARCHIVED` / `SIGN_TEMPLATE_NOT_ACTIVE` / `SIGN_INSPECT_FAILED` / `SIGN_DOCUMENT_NOT_INSPECTED`, `413 Payload Too Large`, `422 VALIDATION` / `SIGN_UNKNOWN_ROLE_KEY` / `SIGN_DUPLICATE_ROLE_KEY` / `SIGN_RECIPIENT_REQUIRED` / `SIGN_EMAIL_REQUIRED` / `SIGN_INVALID_EXPIRY` / `SIGN_TEXT_DEFAULT_TOO_LONG`, `429 RATE_LIMITED`.

## Rate limits and error codes

- **Per-IP and per-key rate limits:** Requests default to 120/min per IP, 60/min per key on read routes (`GET`), and 20/min per key on `POST /api/v1/sign/envelopes/from-template` (with a 32 KB JSON body cap and an isolated download concurrency bucket on `/sealed` and `/certificate`). Exceeding any rate limit returns `429 RATE_LIMITED` with `Retry-After`; saturating download concurrency slots returns `503 SIGN_PDF_BUSY` with `Retry-After`.
- **Status codes:**
  - `400 SIGN_QUERY_TOKEN_FORBIDDEN`: token sent in a URL query string.
  - `401 UNAUTHENTICATED`: missing, malformed, unknown, expired, or revoked Bearer key (`WWW-Authenticate: Bearer`).
  - `403 FORBIDDEN`: valid key missing the required scope (`sign:read` or `sign:draft`).
  - `404 NOT_FOUND`: org eSign app off, unentitled billing, invalid envelope UUID, unknown envelope or template ID, foreign-org ID, or confidential envelope (`hr_contract` / `meeting_minutes`).
  - `409 SIGN_ENVELOPE_NOT_SEALED` / `SIGN_TEMPLATE_ARCHIVED` / `SIGN_TEMPLATE_NOT_ACTIVE` / `SIGN_INSPECT_FAILED` / `SIGN_DOCUMENT_NOT_INSPECTED`: lifecycle precondition not met.
  - `413 Payload Too Large`: request body on `POST /api/v1/sign/envelopes/from-template` exceeds 32 KB (`text/plain` response).
  - `422 VALIDATION` / `SIGN_UNKNOWN_ROLE_KEY` / `SIGN_DUPLICATE_ROLE_KEY` / `SIGN_RECIPIENT_REQUIRED` / `SIGN_EMAIL_REQUIRED` / `SIGN_INVALID_EXPIRY` / `SIGN_TEXT_DEFAULT_TOO_LONG`: invalid query parameter, malformed JSON or payload schema, expiry, text default length, or recipient role mapping.
  - `429 RATE_LIMITED`: per-IP or per-key rate limit exceeded.
  - `503 SIGN_PDF_BUSY`: download concurrency slots full on `/sealed` or `/certificate`.
