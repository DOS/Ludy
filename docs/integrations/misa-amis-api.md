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
  is `wrong_credentials`. No answer, a deadline, a 5xx or 429, a body that is not MISA's shape, a refusal of the call itself, an answer whose company data is not the object the document describes (its shape is unconfirmed until the sandbox check), and `InvalidAPPID` (the deployment's own ClientID is unknown to MISA: nothing a customer's new code can fix) are `unreachable`;
  its text tells the person to try again later and to tell the Ludy administrator if it stays, and the worker log carries the adapter's kind and MISA's error code (a plain word) for the operator. A connector's member who left, or a connection no longer
  active, is `wrong_credentials` without calling AMIS (the connection also shows as expired). The test asks for a new token every time (`companyInfo(..., { freshToken: true })`), so the access code goes to AMIS on each test and a code revoked meanwhile reads `wrong_credentials`; other calls keep using the token held in memory for up to half an hour. The job opens only a credential sealed for provider `accounting_misa_amis`.
  No AMIS text, token, header, access code or ClientID is stored, audited, logged or put in the job's data: the log line is the connection's first eight characters, the state, the adapter's error kind and MISA's error code.
- **The screen** shows the last result and time to every member, and the button to owners and admins; the list is read again every two seconds for up to half a minute until the time changes.
- **The transport** (`apps/kernel/src/misa-amis-transport.ts`) goes through `guardedRequest`: https and `developer.misa.vn` only, public addresses, the connection pinned to the checked address, a 30 s deadline, a 16 MB cap on the answer, no redirect followed.
  The client is built once per process, only where `MISA_AMIS_CLIENT_ID` is set, and handed to the worker as `channels.misaAmis` (egress `provider:misa_amis`, classified in the egress invariant first, #3943).
- **No external call ledger here:** the test reads only, so there is no effect whose outcome could be unknown. The push (S3b) commits its `external_call` before it sends.
- **Not in S2b:** reading the dictionary (the branch and party codes of the preview), the push and the callback. The push (S3b) reads the AMIS branch itself; the preview still stands on a placeholder branch and `checkedAgainstAmis: false`.

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

## The push (S3b, #3902)

A person confirms a previewed batch and the worker sends it as "đề nghị sinh chứng từ". It is **off** until the sandbox check ([runbook](../runbooks/misa-amis-sandbox-check.md)) has confirmed what it assumes: the deployment value `MISA_AMIS_PUSH` must be `on`, the connection's last test must be `works`, and an owner or admin must confirm.

- **The confirmation** (`finance.misa_amis.push`, R2 external, owners and admins, never an agent) carries the digest of the preview, which must be the preview of the connection's own legal entity (a preview with no entity covers every entity of the period, so its digest cannot match a one-connection confirmation; the confirm screen of S3b-2 always previews with the connection's entity) (SHA-256 over every voucher part's own digest, the AMIS branch left out). The command rebuilds the batch from the live data with the preview's own path (`modules/finance/src/misa-amis-build.ts`): a different digest is `MISA_AMIS_PUSH_STALE`, any blocker is `MISA_AMIS_PUSH_BLOCKED` and nothing is queued, a period of more than 500 vouchers is `MISA_AMIS_PUSH_TOO_MANY`.
- **The screen** (S3b-2b, [#3902](https://github.com/DOS/Ludy/issues/3902)): under a preview that is whole (no "more"), not empty and has nothing blocked, an owner or admin sees "send these N vouchers" only when the status says `pushOffered` (the ClientID and `MISA_AMIS_PUSH=on`) and the connection's last test `works`; a second click says the send cannot be taken back, then `vouchers.misaAmisPush` carries the preview's own ask, the connection (`misa_amis_connection.id`) and the digest. The route answers 404 `MISA_AMIS_PUSH_DISABLED` before reading anything when the switch is off, so a confirmation made while it is off cannot be sent after it is turned on. Every member reads the rows (`misaAmis.pushes.list`, not gated by the switch); MISA's refusal text is shown as plain text. An owner or admin settles a row MISA never answered for (`misaAmis.pushes.resolve`). The coworker has no part in sending: no agent path confirms or settles.
- **The table** `crove_finance.misa_amis_push`: one row per voucher part (`org_refid` unique per org, `org_refno` at most 20 characters, the digest, the state, MISA's reason, attempts). No voucher body is stored (it holds party names); the row keeps only what rebuilds it (the kind, the period and the choices). The states and their moves are enforced by a trigger: `queued`, `sending`, `sent`, `accepted`, `refused`, `ambiguous`, `failed`. A person moves only `refused` or `failed` back to `queued`, with one more attempt, through a new confirmed push; nothing deletes a row.
- **Idempotency:** the insert is `ON CONFLICT (org_id, org_refid) DO NOTHING`, so a replay, a double press and two presses at once queue each part once. A queued, sending, sent, accepted or `ambiguous` row is never sent again; an accepted voucher whose source was revised since is counted as `revised` and not sent (what a second `save` does under one `org_refid` is unconfirmed).
- **The worker** (`apps/kernel/src/misa-amis-push-job.ts`, queue `finance-misa-amis-push`, egress `provider:misa_amis`): opens the access code (only here), reads the AMIS branch (`get_dictionary` data_type 6), asks MISA for the results of the rows it took, then sends queued batches of at most 50 of one voucher type. Before each send `finance.misa_amis.push_begin` commits the call to the `external_call` ledger and marks the batch `sending`; the worker rebuilds each voucher from its source with the real branch and sends it only if its digest is the one the person approved (else `failed` with `STALE`). "MISA took the request" is `sent`, not `accepted`; the result comes by polling `get_call_back_detail_error` (the callback route is S4, #3903).
- **How a send ends:** success is `sent`; a refused connection puts the rows back in the queue with the code `CREDENTIALS` and sends nothing more; a request MISA understood and refused is `refused` with the text of its error code; a request the client refused before sending is `failed`; any lost answer (timeout, lost answer, 5xx, unreachable) is `ambiguous`, and an `ambiguous` row leaves only with MISA's own answer (`accepted` or `refused`), never by being sent again. A `sending` row with no answer for five minutes becomes `ambiguous`.
- **A confirmation does not last for ever:** a row still `queued` a week after the confirmation is `failed` (`EXPIRED`) and needs a new confirmed push, so turning the push on later never sends an old approval. A connection with vouchers still `sending`, `sent` or `ambiguous` cannot be removed (`MISA_AMIS_PUSH_PENDING`): the API asks `finance.misa_amis_connection.can_disconnect` before it revokes the channel, so a refused disconnect leaves the access code in place and their results can still be read.
- **Nothing sent, nothing lost:** when the host cannot be reached, the connection is refused or the batch cannot be built, the rows go back to `queued` (the call is closed as never made; the next run begins a new one). An unreachable host or a batch that cannot be built is tried again by the job a few times (every two minutes, at most ten rounds). A refused connection (`CREDENTIALS`) is not: the job stops there, the rows stay `queued` with the code on screen, and once an owner has restored the access code (a new connect and test) the same confirmation is pressed again to wake the job; a row still `queued` a week after its confirmation is `failed` (`EXPIRED`). Only an answer that may have been lost (timeout, lost answer, a 5xx) is `ambiguous`, which a person settles in AMIS after three days (`finance.misa_amis.push_resolve`: "it is in AMIS" or "it is not in AMIS"). A `sent` row MISA never answered for in the 24 hours the worker asks is settled the same way: "in AMIS" makes it `accepted`, "not in AMIS" makes it `failed`.
- **Polling:** while rows wait for MISA's answer the job queues itself again every two minutes, for a day from the row's last change. A lost chain is picked up by any later press of the push button (it always nudges the job). A chain that stops while rows may still wait (a day of rounds, ten unreachable rounds, a connection left alone, an unusable access code) logs one warning line with a short connection id, a short org id and a code, nothing else (#4041). A row is `sending` from the begin commit; the window of five minutes is longer than four requests at the transport's 30 s deadline (a token request, a save refused for its token, a second token request, a second save) plus the rebuild and the record, so another run's begin does not flip a row that is still on its way (a test ties the window to the transport's deadline).
- **Voucher numbers (F3 of the S3a review):** the final `org_refno` of every part, after the `/N` of a split voucher, is checked against 20 characters; a longer one makes the voucher blocked (`voucher_number_too_long`), never cut.
- **Nothing sensitive is kept:** no access code, token, ClientID, party name or amount in a row, an audit fact, an event, a ledger row or a log line. MISA's own text is kept only as the capped `reason` of a refused voucher (escaped on display). That text is registered as personal data (`crove_finance.misa_amis_push.reason`, free text, `erase`, #4015): MISA may quote a party or an invoice in it, so an owner's erasure of a person (`kernel.personal_data.erase`) clears the whole text of every refused row that quotes the value, through the owner-only definer `crove_finance.personal_data_clear_misa_amis_push_reason`, and keeps the row and its state; a number of fewer than 10 digits is listed, not cleared. An erasure probe is an email or digits only, so a refusal text that quotes only a party's name is not found: such a text stays until the voucher's party is handled another way. The definer's update passes the table's guard through one narrow branch (`refused` to `refused`, `reason` to null, nothing else moved, `updated_at` kept, owner context only), which also holds on a shared database where the migration login is a member of `crove_tenant`. The codes of our own (`CONFIRMED_IN_AMIS`, `NOT_IN_AMIS`, the worker's failures) hold nothing about a person and stay.

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

**Built (S4, #3903).** `POST /api/webhooks/misa-amis` (`apps/kernel/src/misa-amis-callback.ts`, `http.ts`) exists only where `MISA_AMIS_CLIENT_ID` is set and Finance is installed; without it the route is not registered (a POST to the path is answered by the session check of `/api/*`, 401, and reaches nothing). The API process cannot enter a system context (that is the worker's alone, gate T5), so a callback travels in two steps, as a bank feed notice does (ADR-0039). **The route:** the per-address limit (the bank feed notice limiter, 120 a minute) and the body cap (1 MiB, sized for 1000 results) come before the body is read; `readCallback` checks the signature in constant time and `app_id`; only then the database: one orgless call of `crove_finance.misa_amis_callback_enqueue` (the API login alone) stores the signed results (refid, voucher type, success, MISA's plain code, its capped text for a refusal, and the envelope's company code as a hint; the first copy of a result wins, the unsigned company code is not part of the replay key, so a replay with varied codes cannot fill the backlog) in the machinery table `misa_amis_callback_pending`, which no login or tenant role can read. The route reads no tenant row, so its answer never says whether a refid exists: every verified message gets `200 {"ok":true}`; `401` bad signature or `app_id`, `400` malformed, `413` over the cap, `429` rate limited (before the body is read), `503` the table could not take the results (a fixed code; MISA is expected to retry, unconfirmed). **The worker relay** (`misa-amis-callback-relay.ts`, run on the worker's relay tick) takes them with `crove_finance.misa_amis_callback_claim` (the worker login alone), which finds by `org_refid` in SQL the organisation and the stored push row (never from the envelope; nothing for an org whose Finance is off or that is not active), and records through the one write path, `finance.misa_amis.push_record`, as the system actor. The HMAC key is one per deployment, so a good signature proves MISA sent the message, not for which organisation: a refid stored in two organisations is refused, and the envelope's `org_company_code` and the signed `voucher_type` must equal the located connection's and row's. Only a row in `sent` or `ambiguous` moves, to `accepted` on `success`, else `refused` with MISA's text (capped, untrusted, never logged); the command updates only where the state and the attempt still match, so a replay or an old failure after an acceptance changes nothing. The signed `data` carries no attempt, session or time, so a refusal is recorded only for a row never sent again (`attempts` 1): an old refusal replayed against a second send of the same voucher is ignored, and polling or a person settles that row (an acceptance is recorded for any attempt: the voucher is in AMIS). A result for a row still `sending` or `queued` waits and is taken again after five minutes (MISA can call back before the worker records `sent`); polling also reads it. `batchError` and every unsigned field move nothing. A result is deleted when the relay is done with it (recorded, or nothing can be recorded for it); one whose recording met an outage is taken again after five minutes, and any result older than seven days is purged. A failure logs one fixed code: no body, signature, MISA text or ClientID is logged, and nothing but the results above is stored. **Unconfirmed:** what MISA expects as the callback's answer, and whether it retries on a non-200, are checked in the sandbox (the runbook, item 16); the callback address is the deployment's public base URL plus this path, and registering it in MISA is a step for the owner or the coordinator.

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

## MISA ASP (#4103)

The same adapter serves MISA ASP: `createAmisClient({ product: 'asp' })` (S1 of [#4103](https://github.com/DOS/Ludy/issues/4103), design and the Accounting PO's approval on that issue). The source is the first-party document the developer portal serves for ASP (V1.0.0, dated 2026-08-05, read 2026-11-19), compared field by field with the AMISKT one.

- **Same as AMIS:** host `developer.misa.vn` (so the egress allowlist is unchanged), base `/apis`, the `ClientID` header, `POST token` with `access_code` and `org_company_code`, `X-MISA-AccessToken`, the answer envelope, 500 lines a voucher, asynchronous saves, the `voucher_type` numbers (all seven kinds Ludy pushes exist: 1, 3, 4, 5, 13, 17, 18) and the body of `delete`. The path prefix is `/asp/v1` instead of `/amiskt/v1`.
- **Five endpoints only:** `token`, `get_dictionary`, `save`, `delete`, `get_list_inventory_balance`. A client made for `asp` answers `unsupported` before it asks for a token or sends anything for the three AMIS calls ASP does not have: `companyInfo` (the connection test of S2 reads `get_dictionary` data_type 6 with take 1 instead), `saveDictionary` (ASP's catalogues are read-only: Ludy matches the firm's parties and items and never creates them) and `callbackResults` (no polling). It also refuses the three catalogues ASP does not list (bank, expense item, inventory category); the six it has are 1 parties, 2 items, 3 stock, 4 unit, 5 accounts, 6 organization unit.
- **The callback is not described.** ASP's document says only that a save's result comes back "through the callback": no envelope, no signature (the words signature and HMAC do not occur), no registration, no polling fallback. S4 assumes the AMIS envelope; `MISA_ASP_PUSH` stays off until the sandbox check shows what ASP sends, and a `sent` row ends by callback or by a person's resolve.
- **The mapper against ASP's structures** (`modules/finance/test/misa-asp-fields.test.ts`, field names in `fixtures/asp-voucher-fields.json`, names only): ASP's voucher structures are a subset of AMIS's. Two lists are pinned per kind so a change is decided, not slipped in. **Written but not listed by ASP** (probably ignored; unconfirmed): the party's `account_object_tax_code`, `_name` and `_address` flat keys on several kinds, `account_object_contact_name` on the bank headers, `exchange_rate_operator` on sales, `purchase_purpose_code`, the `tax_account_object_*` keys and `refdate` on purchases, `include_invoice` on the goods header, the invoice number, series and date on goods lines (one input per kind is checked, so the lists hold for those inputs). **Required by ASP but not written today:** the ids of catalogue entries, `inventory_item_id` and `unit_id` on services lines, those two plus `main_unit_id` and `stock_id` on goods lines, and on sales lines the same ids with `stock_code` and `stock_name`. AMIS's document says a code alone maps; ASP's drops that sentence and marks the ids required. Only the read-only catalogue of S3 can give the ids, and the sandbox check decides whether a code alone is taken.
- **Not stated by ASP's document:** rate limits, fees, the format of `expired_time`, whether the `reftype` and `reason_type_id` tables Ludy derived for AMIS (unconfirmed there too) are the same. The document's "Nhập kho" entry points at `/amiskt/v1/save` (a kind Ludy does not push) and its token text lists `save_dictionary`, which has no endpoint.

## The check against the firm's catalogue (S3a, #4112)

Which party code and item code a voucher is written with comes from the firm's own catalogue in MISA, matched by Ludy and never created in it. The access code is sealed and only the worker opens it, so the API never reads the catalogue: an owner or admin presses "Kiểm tra với danh mục" on the preview (`misaAmis.matches.check`, the ask is the preview's own), `finance.misa_amis_match.request_check` (R2 external) files the request in `crove_finance.misa_amis_match_check` (one row per connection; a second press while one asked in the last ten minutes still waits returns it) and queues the worker's job (`finance-misa-amis-match`, egress `provider:misa_amis`, one per connection at a time).

- **The job** (`apps/kernel/src/misa-amis-match-job.ts`) finds the parties' tax codes and the item codes of the batch by the path the preview and the push use, reads the catalogue pages it needs (`get_dictionary` data_type 1 and 2, 1000 a page, at most 20 pages of a kind) into memory, matches there (`modules/finance/src/misa-amis-matching.ts`) and records only what it found with `finance.misa_amis_match.record_check` (system only, replaces the connection's results whole): per party (by tax code, digits only, 10 or 13) and item (by exact code) `matched` (exactly one active entry; its code and id are kept), `unknown` or `ambiguous` (several active entries: nothing picks one). A party is **never** matched by name. The catalogue's names, addresses and tax codes are not recorded, audited, put in a job's output, an error or a log line; the failures are fixed codes (`credentials`, `unreachable`, `invalid_response`, `catalogue_too_large`).
- **What it changes:** the preview reads the last result (`finance.misa_amis_match.results`): with no check done nothing is checked and the preview says so; with one done, a party or item that was not matched is a blocker (`party_code_unknown`, `item_code_unknown`), a matched party's `account_object_code` is written on the voucher, and the preview shows when the check was made. The push command and the worker's rebuild read the same stored result, so a check made after a person confirmed changes the part and the part is `STALE`, never sent. A party without a tax code cannot be matched here, so once a check is done it is a blocker (`party_code_unknown`) like a party the catalogue does not have, and before a check it is sent as before (name and address, no code); matching those by name as a proposal a person confirms, the default items, and a re-read of the entries right before sending are S3b ([#4124](https://github.com/DOS/Ludy/issues/4124)), and units and warehouses are [#4125](https://github.com/DOS/Ludy/issues/4125).
- **Stored:** `misa_amis_match_check` (the batch asked about, state, a fixed failure code, who and when) and `misa_amis_match` (kind, reference, state, the matched entry's code and id): tenant tables with RLS, read by every member of the entity, written by the worker's system context (and by owners and admins by the pattern of the connection's tables, though no command of theirs writes a result); deleted with the connection and by the org purge.
- **Unconfirmed until the sandbox check** (runbook item 17): the paging of `get_dictionary`, the field names of a party and an item row, and that the sandbox's catalogue is whole.
