# The wake-up webhook (telling a connected AI app that something needs attention)

Decision: [ADR-0051](../adr/0051-vys-brain-is-a-dos-claw-agent-ludy-is-the-gate.md) decision 4. Tracking: issue #3024. The endpoint it complements: [the MCP endpoint](mcp-endpoint.md).

What it is: an owner or admin gives one connected AI app (Settings, "Connected AI apps") an https address. Ludy then sends one signed `POST` there when something new needs attention, or on a daily or weekly schedule. The message only wakes the app up: it carries ids, dates and amounts, never a name, a note or a message. The app then reads what it needs through the [MCP endpoint](mcp-endpoint.md), with its own, read-only access. Ludy runs without it and sends nothing until an address is saved.

## A member's own connected app

A member (or viewer) who connected their own AI app (a member-bound grant, ADR-0051 decision 2, issue #2975) may give it a wake-up too, for that grant and nothing else. The rules:

- **Whose it is.** Only that member sets, reads, rotates, tests or clears it. An owner or admin does not: for another member's grant they see that a wake-up exists and the receiver's host (`https://host`, never the path, which can carry a token), and they cut it off by revoking the grant, which ends delivery at once. A company grant stays the owners' and admins' alone.
- **What is sent.** A schedule (a date) and a test (a ping); never a signal. A member-bound grant is not asked for signals and a signal event for one is refused in the database, so no id of business data leaves for a receiver that reads no more than a member reads.
- **The same address rules** as any other: https only, no address, no other port, no credentials, no private name; the delivery checks every address again on every send, and caps the answer and the time.
- **Rates.** A grant rotates its secret once a minute at most and sends at most ten test pings an hour (besides the one a minute). Both answer `MCP_WAKE_TOO_SOON`.
- **It stops** with the grant: revoked, expired, the member gone or disabled, or the org turned member grants off (an owner's or admin's own grant needs no switch). A demotion of an owner or admin ends every grant of theirs, member-bound ones too.

## What Ludy sends

`POST <your address>`, `Content-Type: application/json`, a body of at most a few KB, and three headers:

| Header | Value |
| --- | --- |
| `Ludy-Event-Id` | the event's id, the same on every retry of the same event |
| `Ludy-Timestamp` | Unix seconds at which this attempt was signed (changes on every retry) |
| `Ludy-Signature` | `v1=<hex>`; during a secret rotation two values, `v1=<new>,v1=<old>` (a comma and a space are both fine) |

The body is one JSON object with the keys `id`, `type`, `created_at`, `org`, `grant` and `data`, in that order. The `type` is one of:

- `ping`: `data` is `{}`. A test.
- `schedule.due`: `data` is `{"date":"YYYY-MM-DD"}`, the day (Vietnam time) the schedule fired for.
- `signal.fired`: `data` is `{"items":[...]}`, 1 to 20 items, each with `rule`, `key`, `severity` (`info`, `warn`, `block`) and some of `party_id`, `deal_id`, `invoice_id`, `amount` (a decimal string), `currency` (ISO 4217, with an amount), `due_on` and `days`. A signal fires when its `key` first appears and again only after it went away.

**Signals, in detail.** Every five minutes the worker asks the kernel's cross-app rules for each company grant with signals due, as the grant itself (the same sealed, read-only, tainted context a pull call from that app gets; the worker has its own door into it, `enter_mcp_wake_company_context`, which only the worker's database login may use and only for a company grant whose wake-up is on). The rules are the ones the `ludy_signals` tool runs:

| Rule (`rule`) | `key` | Fires for |
| --- | --- | --- |
| `kernel.signals.deal_without_invoice` | `deal_without_invoice:<deal id>` | a deal won 7 days ago or more with no sales invoice after the win (`deal_id`, `days`, `amount`) |
| `kernel.signals.receivable_with_open_deal` | `receivable_with_open_deal:<party id>` | a customer with an overdue receivable who has an open deal (`party_id`, `amount`, `due_on`) |
| `kernel.signals.supplier_bank_changed` | `supplier_bank_changed:<party id>` | **never yet**, see below |

An item carries ids, the severity, a day and an amount, nothing a person typed (no name, title, note or invoice number); anything else is read through the MCP tools. A signal fires when its `key` first appears and again only after it went away and came back; up to 20 items go in one event, and the keys are stored in the same transaction as the event, so a failure fires it again and never loses it. A key is forgotten only when its rule answered in full: a rule that failed or answered in part leaves its keys as they were.

- **Quiet on purpose.** When a grant's books are only in part in view (a branch-limited grantor, for instance) the finance reads refuse with `SIGNAL_PARTIAL_VIEW` and the wake-up stays quiet for that rule; it never fires on a part of the books. `ludy_signals` says the same thing out loud (`unchecked`, reason `partial_view`).
- **Rule 3 stays quiet until its data exists.** "A supplier's bank account changed while a payment waits" needs a supplier bank account record and a supplier-payment flow, and Ludy has neither yet (an owner decision). Until then the rule answers nothing and `ludy_signals` lists it as `unchecked`, reason `not_available`. An empty wake-up is never "all clear".
- **A member-bound grant never gets a signal.** The sweep asks no signals for it, the database refuses a `signal.fired` event for it, and the worker's entry refuses anything that is not a company grant. A member's wake-up is a schedule and a ping only.
- **The refusal tally.** If a grant loses its standing between the sweep picking it and the rule call (a revoke or a demotion, a window of seconds), the worker's call is refused and counted in the runtime's bounded refusal tally under the grantor, the same way the same grant asked through the API is counted. No audit row is written and nothing is fired; the next pass drops the grant.

Anything else you read from Ludy (names, invoice lines) you read through the MCP tools; the body is never the source of truth.

## Verify it

The signature is HMAC-SHA256, keyed with the secret (the whole `whsec_...` string as text), over the timestamp, a dot and the **exact bytes of the body**, written as lower-case hex after `v1=`. Verify before you parse, on the raw body:

1. Take the timestamp and refuse the message if it differs from your clock by more than **5 minutes** (replay window).
2. Compute the signature and compare it, in constant time, with **each** `v1=` value; accept if any matches (that is what makes a rotation seamless).
3. Only then parse the JSON, and ignore an event id you already handled in the last **24 hours** (delivery is at least once: a retry carries the same `Ludy-Event-Id`).
4. Answer `2xx` quickly. Ludy reads at most 4 KB of your answer, never looks at it, and waits 10 seconds per attempt. A redirect counts as a failure; do not redirect.

Node (no dependencies):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyLudy(secret, headers, rawBody, now = Date.now()) {
  const ts = headers['ludy-timestamp'];
  if (!/^\d{9,12}$/.test(ts ?? '') || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const want = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
  return String(headers['ludy-signature'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1='))
    .some((part) => {
      const got = Buffer.from(part.slice(3), 'hex');
      return got.length === want.length && timingSafeEqual(got, want);
    });
}
```

Python:

```python
import hashlib, hmac, time

def verify_ludy(secret: str, headers: dict, raw_body: bytes, now: float | None = None) -> bool:
    ts = headers.get("ludy-timestamp", "")
    if not (ts.isdigit() and 9 <= len(ts) <= 12) or abs((now or time.time()) - int(ts)) > 300:
        return False
    want = hmac.new(secret.encode(), ts.encode() + b"." + raw_body, hashlib.sha256).hexdigest()
    parts = [p.strip() for p in headers.get("ludy-signature", "").split(",")]
    return any(hmac.compare_digest(p[3:], want) for p in parts if p.startswith("v1="))
```

Header names arrive lower-cased in most servers; pass them lower-cased.

## Test vectors

Secret `whsec_test_secret_0123456789abcdef`, timestamp `1700000000` (pass `now = 1700000000000` to the Node function so the window is not what you are testing).

Body (one line, no trailing newline):

```
{"id":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a10","type":"ping","created_at":"2026-11-12T03:00:00.000Z","org":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a11","grant":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a12","data":{}}
```

`Ludy-Signature: v1=1b9e5052b71fa74cc80fe158f86ea39f178fdfeb59060102e9fd3793d96f47fb`

Body of a `schedule.due` event (same secret and timestamp):

```
{"id":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a10","type":"schedule.due","created_at":"2026-11-12T03:00:00.000Z","org":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a11","grant":"0197a1c2-7b3e-7c11-9a55-3f2d8e6b4a12","data":{"date":"2026-11-12"}}
```

`Ludy-Signature: v1=250e53a9834e4a5b6c4e385b2112157f001bbbc4a09126aad833aee1db9205f0`

During a rotation, with the ping body and the old secret `whsec_other_secret_0123456789abcdef` beside the new one:

`Ludy-Signature: v1=1b9e5052b71fa74cc80fe158f86ea39f178fdfeb59060102e9fd3793d96f47fb,v1=92211602375e74f1fb5c5818ae5848dfaa15cfc7643e3576209a22854f4df395`

A receiver must accept all three, and must refuse the ping body with the first signature changed in one digit, or with a body that has one space added.

## The secret

- Ludy makes it (`whsec_` and 32 random bytes) when you save an address, shows it **once**, and keeps it only sealed. Store it in your secret manager at once.
- **Rotate** (Settings, "New secret") shows the new secret once. For **24 hours** every message carries two signatures, new and old, so you can switch without a gap; after that only the new one.
- **Remove** deletes the address and the secret. Saving a new address makes a new secret.
- The address is kept in the clear (it is not a secret) but is never written to the audit log in full, only its host.

## Retries, pause and what you will see in Settings

- A failed attempt (not `2xx`, a timeout, a redirect, a refused connection) is retried **8 times**, from 30 seconds and doubling (about two hours in all). Each retry is signed again with a fresh timestamp, so a late retry still verifies.
- An event that never reached the queue is handed over by a sweep that runs every minute; one still waiting after 8 hours is dropped and does not count against you.
- If the address fails for **7 days** running, the wake-up is **paused** and Settings says so. Fix the receiver, open the wake-up and save to turn it back on.
- An event is dropped, not sent, when the connection is gone: revoked or expired, the person who allowed it is no longer an owner or admin, or the organization is stopped.

## Rules the address must follow

https only, a public domain name (never an IP address), the default port 443, no user name or password in it. Ludy looks the name up on every attempt, refuses it if any address it resolves to is private, and connects to the address it checked (so a name that changes between the check and the connection cannot reach a private one). Plan for sends from the deployment's own network.

## If it does not arrive

1. Settings shows "last attempt failed" or "paused": check that your receiver answers `2xx` within 10 seconds, without a redirect, over a certificate that validates.
2. It arrives but verification fails: you are hashing a parsed and re-serialized body, or an old secret. Hash the raw bytes, and use the secret of the latest rotation (or accept both within the 24 hours).
3. Nothing arrives and Settings shows nothing sent: with schedule "only when something new needs attention", nothing is sent until a signal fires. Signals are checked every five minutes for company grants (rules above): a quiet grant has nothing flagged, or its rules could only see part of the books (`ludy_signals` shows which with `unchecked`). To test the receiver without waiting for a signal, send a test ping from Settings.
