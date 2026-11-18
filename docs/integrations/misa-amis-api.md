# MISA AMIS Kế toán API adapter (#3854)

`packages/misa-amis` (`@crove/misa-amis`) is the adapter for the AMISKT v1.0.0 API, documented at
[developer.misa.vn](https://developer.misa.vn/products-openapi/AMISKT). It is slice S1 of
[#3854](https://github.com/DOS/Ludy/issues/3854); the plan is [accounting-software-sync.md](../plan/accounting-software-sync.md).
Nothing uses it yet: the connection (S2), the push (S3), the callback route (S4) and the AI check (S5) come next.

## What it does

- Calls `token`, `get_company_info`, `get_dictionary`, `save_dictionary`, `save`, `delete` and `get_call_back_detail_error`
  through a transport the caller injects, bound to `developer.misa.vn` and https. The adapter never calls `fetch`.
- The integrator's `ClientID` is one deployment secret (the API has no second one). It is also the callback's HMAC key.
  It lives only in the client's closure and goes out only in the `ClientID` header.
- The customer's `access_code` is given per call and exchanged for a token held in memory for half an hour at most.
  An expired or refused token is renewed once; a second refusal is `credentials`.
- Amounts are written into the JSON text as unquoted number literals from decimal strings, never through a JS number.
  A JS number that is not a safe integer is refused.
- A voucher is refused before anything is sent when it has no line, more than 500 lines (never cut), an unknown
  `voucher_type`, an `org_refid` that is not a UUID, or an amount that is not exact. A call carries one voucher kind.
- The callback reader checks `HMAC-SHA256(data, ClientID)` in constant time before it parses `data`. Only `data` is
  signed: `org_company_code`, `app_id` and `data_type` are not, so the caller finds the organisation from its own stored
  push row by `org_refid` and treats the envelope's `org_company_code` as a hint to compare.
- Errors carry a fixed sentence and, at most, MISA's own error code when it is a plain word. Never a body, a header or a
  secret.

## Unconfirmed in MISA's documentation

Checked by the live sandbox check after the credential handover, never assumed to be right:

- whether an amount may be sent as a string (the adapter sends numbers);
- the shape of `get_call_back_detail_error`'s `Data` (assumed: the entries of a callback's `data`);
- the base path (`https://developer.misa.vn/apis` plus `/amiskt/v1/...`);
- the token's life (the text says 24 hours, the field says 12) and the time zone of `expired_time` (not used);
- rate limits, fees, and any limit on the number of vouchers in one `save` (the adapter's own bound is 50);
- that the callback's `app_id` is the ClientID (the document says so; the reader refuses any other value, so if MISA sends a
  separate app id every real callback is refused as `app_id` until the reader is changed).

## What the callback route (S4) must do, because the reader cannot

- Cap the body size before it is read: the reader parses the whole raw body before the signature is checked.
- Never log or store a raw callback body: if `app_id` is the ClientID, the body carries the secret in clear.
- Order by something other than arrival: a signed `data` can be replayed later with no time or nonce in it, so an old
  `success: false` replayed after a successful push must not move a request back. Moves are forward only, keyed by
  `org_refid`, with `session_id` kept to tell results apart.
- `batchError` is not signed: it never moves the state of a request. At most it is a reason to poll for the signed results.
- `errorMessage` and `sessionId` are MISA's untrusted text: escape them on display and keep them out of logs. Look up push rows by `org_refid` only.
