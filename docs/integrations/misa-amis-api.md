# MISA AMIS Kế toán API adapter (#3854)

`packages/misa-amis` (`@crove/misa-amis`) is the adapter for the AMISKT v1.0.0 API, documented at
[developer.misa.vn](https://developer.misa.vn/products-openapi/AMISKT). It is slice S1 of
[#3854](https://github.com/DOS/Ludy/issues/3854); the plan is [accounting-software-sync.md](../plan/accounting-software-sync.md).
The connection (S2, [#3875](https://github.com/DOS/Ludy/issues/3875)) and its test (S2b, [#3885](https://github.com/DOS/Ludy/issues/3885)) are built on it, and the mapping and its preview (S3a, [#3901](https://github.com/DOS/Ludy/issues/3901)) use it; the push (S3b), the callback route (S4) and the AI check (S5) come next.

## The connection (S2)

- **On only with the deployment's ClientID.** `MISA_AMIS_CLIENT_ID` is the one deployment value (a secret; the API has no second one). Unset, the Tích hợp card says the connector is off and `misaAmis.connections.connect` answers
  `MISA_AMIS_DISABLED`. Crove Cloud sets DOS's own; a self-hoster sets the one MISA issued to their own app.
- **One connection per legal entity** (`crove_finance.misa_amis_connection`), shaped like the marketplace and e-invoice connections: owners and admins connect and disconnect, every member reads it.
- **The access code** the customer makes in AMIS is sealed at the API's edge through the channel-credential path (provider `accounting_misa_amis`, per org, ADR-0025), never in an answer, an audit row or a stored
  readable row; the screen says only "connected since". Disconnecting revokes the channel connection (which drops the credential) and deletes the row; the org purge deletes the row, and the sealed code is
  in `crove_kernel.credential`, which the org export never carries.
- **`org_company_code`** is the opaque code (`ludy-` and 32 hex characters, unique across the deployment) that AMIS is told for this connection and that the callback of S4 compares with the connection of the organisation it found from its own stored push row by `org_refid` (the code is unsigned, so it is a hint to compare, never the authority). It is in no answer
  and not in the org export; a reconnect makes a new one.
- **Not in S2:** the connection test (S2b, below), the push, the callback.

## The connection test (S2b, #3885)

- **Flow.** An owner or admin clicks "Kiểm tra kết nối" on a live connection: route `misaAmis.connections.test` runs `finance.misa_amis_connection.request_test` (R2 external, because it starts a call with the org's sealed
  code), which emits `finance.misa_amis_connection.test_requested`. The outbox relay queues one job on `finance-misa-amis-test` (one per connection at a time, so a double click is one test). The worker job reads
  `finance.misa_amis_connection.test_target`, opens the sealed access code (only here, through the credential broker), asks AMIS for a token and then for the company information (two reads that change nothing
  in AMIS), and records the result with `finance.misa_amis_connection.record_test` (system only).
- **What is recorded:** `last_test_state` (`works`, `wrong_credentials`, `unreachable`) and `last_tested_at`, nothing else. AMIS refusing the access code, a disconnected app, no accounting data connected, or a gateway 401 or 403
  is `wrong_credentials`. No answer, a deadline, a 5xx or 429, a body that is not MISA's shape, a refusal of the call itself, and `InvalidAPPID` (the deployment's own ClientID is unknown to MISA: nothing a customer's new code can fix) are `unreachable`;
  its text tells the person to try again later and to tell the Ludy administrator if it stays, and the worker log carries the adapter's kind and MISA's error code (a plain word) for the operator. A connector's member who left, or a connection no longer
  active, is `wrong_credentials` without calling AMIS (the connection also shows as expired). The test asks for a new token every time (`companyInfo(..., { freshToken: true })`), so the access code goes to AMIS on each test and a code revoked meanwhile reads `wrong_credentials`; other calls keep using the token held in memory for up to half an hour. The job opens only a credential sealed for provider `accounting_misa_amis`.
  No AMIS text, token, header, access code or ClientID is stored, audited, logged or put in the job's data: the log line is the connection's first eight characters, the state, the adapter's error kind and MISA's error code.
- **The screen** shows the last result and time to every member, and the button to owners and admins; the list is read again every two seconds for up to half a minute until the time changes.
- **The transport** (`apps/kernel/src/misa-amis-transport.ts`) goes through `guardedRequest`: https and `developer.misa.vn` only, public addresses, the connection pinned to the checked address, a 30 s deadline, a 16 MB cap on the answer, no redirect followed.
  The client is built once per process, only where `MISA_AMIS_CLIENT_ID` is set, and handed to the worker as `channels.misaAmis` (egress `provider:misa_amis`, classified in the egress invariant first, #3943).
- **No external call ledger here:** the test reads only, so there is no effect whose outcome could be unknown. The push (S3b) commits its `external_call` before it sends.
- **Not in S2b:** reading the dictionary (the branch and party codes of the preview), the push and the callback.

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

## How Ludy's vouchers map to AMIS (S3a, #3901)

`modules/finance/src/misa-amis-vouchers.ts` turns the voucher models of the MISA SME export (`PurchaseVoucher`, `SalesVoucher`,
`CashVoucher`) into the `AmisVoucher`s the push sends. It is pure: nothing is sent and MISA is not called. The field names, the
required fields and the enums are from the voucher structure tables of the AMISKT documentation; none has run against a MISA
sandbox yet.

| Ludy | voucher_type | reftype | reason_type_id |
|---|---|---|---|
| Phiếu thu | 5 | 1010 | none |
| Phiếu chi | 4 | 1020 | 24 pay a supplier (a line on 331), else 23 (**unconfirmed**: derived from the accounts) |
| Giấy báo Có | 1 | 1500 | 29 collect a customer (a line on 131), else 34 (**unconfirmed**: derived from the accounts) |
| Giấy báo Nợ | 3 | 1510 (ủy nhiệm chi; Ludy has no cheque kind; **unconfirmed**) | 44 pay a supplier (331), else 43 (**unconfirmed**: derived from the accounts) |
| Purchase, lines off a stock account | 17 | 330 (Ludy books a purchase on 331: unpaid) | |
| Purchase, lines on a stock account (152, 153, 156) | 18 | 302 | |
| Sales | 13 | 3530 (domestic, not yet collected: Ludy debits 131) | |

- **`org_refid` is the source id** (the purchase or sales document id, the cash voucher id), in lower case. It is not the journal
  entry id: an entry is revised, a revision is a new entry, and keyed on that the same voucher would be a second request in AMIS.
  An invoice with both services and stock lines is two AMIS vouchers: the services one keeps the source id, the goods one gets a
  derived id (SHA-256 of the source id and a tag, written as a version 5 UUID), the same every time.
- **A voucher of more than 500 lines** is split into parts of at most 500 (never cut). The first part keeps the id; each later
  part gets a derived id and `/2`, `/3` on its `org_refno`. The parts' totals add up to the voucher's.
- **What Ludy cannot know comes in as context**, never invented: the AMIS branch (`branch_id`, required by every kind), the party
  code (matched by tax code against `get_dictionary`), the AMIS item the service and sales lines go under, the purchase purpose
  (`mục đích mua vào`, default 1) and a default unit name for a line with none (AMIS requires one). A voucher missing one is not
  written; the result lists a blocker by code and line (`branch_missing`, `party_code_unknown`, `item_code_unknown`,
  `vat_rate_unmapped`, `no_lines`), never a sentence. The deterministic list decides; S5's coworker only explains it.
- A line with no quantity or unit price is one occasion at the line's amount (AMIS requires both). VAT is spread over the lines
  with the same rule as the MISA SME export (`allocateVat`), so the lines add up to the voucher's VAT exactly. `vat_rate` is the
  rate itself for 0, 5, 8, 10, and -1 KCT, -2 KKKNT, -3 KHAC with `other_vat_rate`.
- **The preview** (`vouchers.misaAmisPreview`, a read) lists the vouchers of a period and kind with their AMIS type, parts, lines,
  total and blockers. The branch and the party codes are not read until the dictionary is (a follow-up on the transport of the connection test, S2b), so it
  says `checkedAgainstAmis: false` and leaves those two blockers out.

Unconfirmed, to check in the sandbox. First, the three choices Ludy made itself, each marked unconfirmed in the code and shown in the
preview: the purchase purpose defaults to 1 (`purchase_purpose_id` and code, written on purchases and on cash and bank payments), a bank
payment is written as `reftype` 1510 (ủy nhiệm chi), and the `reason_type_id` of a cash or bank voucher is derived from its accounts
(331 a supplier, 131 a customer). Nothing is pushed without a person approving the push, and the push (S3b, #3902) is not enabled for
any org before the sandbox check has confirmed or corrected them. Then: that a purchase with `reftype` 330 and no `is_paid` is read as unpaid; that AMIS accepts a
party by name and tax code when no `account_object_code` is given; whether `purchase_purpose_id` is a string or the object the
payments' table shows (the mapper sends the id and the code); what AMIS does with a second push of a revised voucher under the
same `org_refid`.

Also unconfirmed, found in the review of S3a:

- A sales line is written without `stock_code` and `stock_name`, which the sales detail table marks required; for a service
  line AMIS may want none (`is_description`), for a stock line it needs one. The sandbox check decides, and the push (S3b) must
  not be enabled for sales before it does.
- A trade discount is a negative line in Ludy, so the discount fields are 0 and the line carries a negative `amount` and
  `unit_price`; AMIS may expect it in `discount_*` instead.
- A party with no tax code is sent by name and address with no `account_object_code` and is no blocker.
- Fields the tables of some kinds do not list are written because the documentation's own examples carry them
  (`account_object_tax_code` on cash and bank lines, `tax_account_object_*` on purchase lines); they are probably ignored.
- A goods line whose saved warehouse is empty is blocked (`stock_missing`) because `stock_code` is required.
- A cash or bank voucher number over MISA's 20 characters is a blocker (`voucher_number_too_long`), never cut.
