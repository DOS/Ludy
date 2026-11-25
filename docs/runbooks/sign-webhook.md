# Outbound eSign webhooks (`sign-webhook`)

Plan: [Ludy eSign Plan](../plan/esign.md). Tracking: issue #4440 (invariants pre-registered in #4438). Signing and HTTP egress share `postSigned` from [the wake-up webhook](mcp-wake-webhook.md).

What it is: an organization owner or admin configures up to 20 HTTPS receiver endpoints under **Ký kết -> Cài đặt -> Webhook sự kiện ký kết (HMAC)**. When a non-confidential signing envelope transitions through a subscribed lifecycle event, Ludy queues a safe-metadata JSON payload and sends a signed `POST` request through the SSRF egress guard. No AI runs on this path, and core signing never blocks on a receiver.

## Access control and confidentiality boundary

- **Owners and admins only.** Only workspace owners and admins (`owner`, `admin`, never an MCP token) can list, create, update, rotate secrets for, ping, or delete eSign webhook endpoints, or view delivery logs; `create`, `update`, `rotate_secret`, and `ping` also require fresh MFA step-up when `aal2` is active, whereas `list`, `deliveries`, and `delete` never block reading state or stopping exposure. Both `ludy_sign.webhook` and `ludy_sign.webhook_delivery` are definer-only `MACHINERY` tables with zero direct login-role grants; `ludy_app` cannot execute `ludy_sign.webhook_target` or read `secret_envelope`.
- **Automatic exclusion of confidential envelopes.** Envelopes with `source_kind = 'hr_contract'` (HR labor contracts) or `source_kind = 'meeting_minutes'` (restricted meeting minutes) never enqueue webhook deliveries at the SQL layer and are dropped by the delivery worker as defense in depth before opening any secret or making any network call.
- **Per-org app gate.** When Ludy eSign (`sign`) is turned off for an organization, the minute sweep skips handing over queued deliveries and in-flight worker jobs drop unsent rows via `sign.hook.record` (`runsWhenOff`).

## Events and safe metadata payload

Every request is `POST <url>` with `Content-Type: application/json` and three headers:

- `Ludy-Event-Id`: the `ludy_sign.webhook_delivery.id` UUID, stable across retries for idempotent receiver deduplication.
- `Ludy-Timestamp`: Unix epoch seconds (`String(Math.floor(now / 1000))`), refreshed on each retry attempt.
- `Ludy-Signature`: `v1=<hex>` (or `v1=<new_hex>,v1=<previous_hex>` during a 24-hour secret rotation window), where each `<hex>` is `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`.

The JSON body keys are serialized in canonical order (`signWebhookBody`) and enforced by a database `CHECK` constraint (`ludy_sign.webhook_payload_ok`):

- Lifecycle events (`sign.envelope.sent`, `sign.signer.signed`, `sign.envelope.completed`, `sign.envelope.declined`, `sign.envelope.expired`):
  - Always present: `eventId`, `eventType`, `occurredAt`, `orgId`, `envelopeId`, `status` (`sent` | `in_progress` | `completed` | `declined` | `expired`).
  - Present on `sign.signer.signed`: `signerId`, `signerRole` (`signer` | `approver`), `signedAt`.
  - Present on `sign.envelope.completed` (emitted when PDF sealing finishes): `completedAt`, `certificateCode`, `sealedSha256`.
- Connectivity check (`ping`, rate-limited to 1 per minute and 10 per hour per endpoint):
  - Keys: `eventId`, `eventType` (`"ping"`), `occurredAt`, `orgId`, `status` (`"ok"`).

**Never** included in any webhook payload: PDF bytes or URLs, raw signing tokens, direct link tokens, OTP codes, document titles, signer names, signer emails, or signer phone numbers. When a queued delivery is dropped (`dropped`, for instance when an endpoint is disabled or eSign is turned off), `payload_json` is cleared to `NULL` immediately; settled `sent` and `failed` rows retain their safe metadata for 30 days so admins can inspect delivery logs.

## Verifying signatures and rotating secrets

1. Read the raw request body bytes (`rawBody`), `Ludy-Timestamp`, and `Ludy-Signature`.
2. Reject requests whose `Ludy-Timestamp` differs from current UTC time by more than 300 seconds (5 minutes).
3. Split `Ludy-Signature` on `,`, keep entries starting with `v1=`, compute `HMAC-SHA256(secret, "${timestamp}.${rawBody}")` as lowercase hex, and compare with `crypto.timingSafeEqual`.
4. Deduplicate processed events by `Ludy-Event-Id`.

Secrets (`whsec_<base64url>`, 32 random bytes, paired with a non-secret `whk_<8 hex>` hint) are generated at the API edge before `Runtime.execute()`, returned **once** to the caller, and stored only sealed via `CredentialBroker` bound to `(orgId, "sign-webhook", webhookId)`. Clicking **Xoay khóa bí mật** (`sign.webhook.rotate_secret`) promotes a new secret immediately and retains the previous sealed secret for **24 hours** (`previous_expires_at`), sending both `v1=` signatures on every delivery until the overlap window expires.

## Retries, auto-pause, and retention

- `sign-hook-sweep` runs every minute (`egress: 'none'`) to hand unqueued or stale (`> 3 minutes`) deliveries to `sign-hook-deliver` (`egress: ['tenant_url']`, `stately` singleton per delivery) and expire rows older than 8 hours.
- Each delivery attempt enforces HTTPS on port 443 to a public IP via `egressFetch` (DNS re-resolved and pinned per attempt, redirects not followed, 10s timeout, response body capped at 4 KB and ignored). Non-`2xx` responses or network errors retry up to 8 additional times from 30 seconds with exponential backoff.
- If an endpoint fails continuously for **7 days**, Ludy sets `enabled = false` and `paused_reason = 'failing'`. After fixing the receiver, an owner or admin edits and re-enables the endpoint to clear the failure state.
- Settled delivery log rows older than 30 days are pruned automatically, and organization offboarding (`ludy_kernel.org_purge`) deletes both `ludy_sign.webhook_delivery` and `ludy_sign.webhook`.
