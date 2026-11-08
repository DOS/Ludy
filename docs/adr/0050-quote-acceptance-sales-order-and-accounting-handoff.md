# 0050. Quote acceptance, the sales order and the hand-off to Kế toán

- Status: Proposed (2026-11-08). Nothing here is built. Written first, as step Q4 of the plan requires, so that the Q4 and Q4b builds and the Accounting line's side work from one contract. The Accounting PO confirmed A1 to A6 in the [#2696 comment of 2026-11-08](https://github.com/DOS/Ludy/issues/2696#issuecomment-6720692778), which this ADR cites; A7 is open (see "Open points").
- Date: 2026-11-08
- Deciders: owner (JOY) for the product choices already made on 2026-11-06 (O1: a person records acceptance; O2: no discount approval; O3: link first; O4: two steps); the engineering choices below by the Claude Code session that wrote this ADR, for the Engage PO to accept
- Builds on: ADR-0029 (agents and their write allowlist), ADR-0031 (module enablement), ADR-0034 (outbound email), ADR-0037 (personal data), ADR-0044 (e-invoice drafts; issuing needs finance's approval), ADR-0045 (stock; stock moves from document lines and marketplace orders), the Accounting PO's view on #2690 (2026-11-06) and their final answers on #2696 (2026-11-08)
- Issue: [#2696](https://github.com/DOS/Ludy/issues/2696) (this ADR is its first part), part of [#2690](https://github.com/DOS/Ludy/issues/2690); the plan is [crm-quotes.md](../plan/crm-quotes.md) sections 4.7, 4.8 and 6

## Context and problem statement

Slice 2 of the CRM lets a seller make a quote from a deal and send it. Once the customer says yes, three things must happen in three places, and the seller must never do any of them by mistake:

1. Engage records that the customer accepted and keeps what was agreed (a sales order).
2. Kế toán makes an e-invoice **draft** from that order, when a person asks.
3. Kế toán moves stock when goods leave, not when the order is confirmed.

Engage (`crove_crm`) and Kế toán (`crove_finance`) are separate modules. The CRM module reaches only `crove_kernel`; finance holds no foreign key into the CRM. What has to be decided:

1. who may accept a quote, and what accepting does;
2. the shape and states of the sales order;
3. how the order reaches Kế toán without either module writing the other's tables;
4. how a line is invoiced once and only once, and how stock moves once and only once;
5. keys, audit, tenancy, the AI's part, and what is left out.

## Decision drivers

- One write path: every state change is a command through `Runtime.execute()`; no code writes another module's tables (AGENTS.md).
- Money is NUMERIC in SQL and a decimal string elsewhere; arithmetic through the `@crove/l10n-vn` helpers; totals are computed by code.
- A person approves money, messages and spend. AI output is tainted: deterministic checks decide, a person approves. Dy is a coworker that may suggest, never confirms.
- A one-person company uses the defaults with no setup: one click to accept, one click to invoice.
- Issuing an invoice, and everything that carries tax meaning, stays Kế toán's, behind its own approval (ADR-0044).
- An order is a record of what the customer agreed to; it must not change under the customer's feet.

## Decision

### 1. Accepting a quote is a person recording it

- **Who.** An owner, admin or member records the customer's acceptance (`crm.quote.accept`), after the customer said yes by any channel (chat, email, phone, in person). A viewer cannot. **No agent holds the command** and the ADR-0029 allowlist does not change. The customer has no accept button in this slice (O1).
- **Input.** `{ quoteId, expectedVersion, acceptedOn?, acceptedVia? }` plus the client's idempotency key. `acceptedOn` is a date in Vietnam's calendar, today by default, never in the future. `acceptedVia` is one of `chat`, `email`, `phone`, `in_person`, `other`, optional; it is a record of how the yes arrived, not a proof.
- **Preconditions** (each refused with its own typed error, nothing written): the quote is `sent`, is the newest revision, has a customer, is not expired (`valid_until` is derived, never stored), and its stored totals equal the totals the code recomputes from its lines (a quote whose lines were changed behind the command's back is refused, not repaired). An expired quote is revised into a new draft and sent again; it is never accepted late.
- **Effect, in one transaction:** the quote becomes `accepted` (final), a sales order is created from it (section 2), the order number is taken from the kernel's gapless yearly series (doc type `crm.sales_order`), and one audit row is written. Nothing is posted, no stock moves, no mail is sent, nothing is called outside the database.
- **Decline.** `crm.quote.decline { quoteId, expectedVersion, reason? }` takes a `sent` quote to `declined`, records who and when, and keeps an optional reason of up to 200 characters. A declined quote may be revised into a new draft.
- **What accepting does not do.** It does not move the deal. Dy may offer "move the deal to Thắng and set its amount to the quote total" as a suggestion with a fixed reason (no model needed); a person confirms each.

### 2. The sales order

Two tables in `crove_crm`: `sales_order` and `sales_order_line` (plan 4.7). **Amended in the Q4 build (Engage PO, 2026-11-08):** there is no `sales_order_counter` table; the number comes from the kernel's gapless series (ADR-0021 section 2, `ctx.numbering.allocate`, yearly reset), as the quote's `BG-` number does. One gapless mechanism, not two.

- **One order per accepted quote**, `UNIQUE (org_id, quote_id)`. Number `DH-YYYY-NNNN` from the kernel's series of the issuing entity (doc type `crm.sales_order`, the year of the accepted date), taken in the accept transaction as the last step before the order's insert: a rolled-back accept gives the number back, so there is no gap. An order number is not a tax document number; the invoice number is Kế toán's.
- **Frozen.** The order copies the buyer snapshot of the quote (name, tax code or none for a consumer, address, invoice email), the legal entity, the currency (`VND`), the lines (same columns and domains as `quote_line`, so a line copies to a draft line without rounding) and the totals. Nothing on it is edited afterwards; it keeps its own copy even if the quote row is later archived or purged.
- **Stored states: `confirmed` and `cancelled`.** Everything else is derived, never stored, so it cannot disagree with its source:
  - invoiced per line: `Chưa lập hóa đơn`, `Đã lập nháp`, `Đã phát hành`, read from the Kế toán drafts that name the order (section 3);
  - delivered per line: from `sales_order_delivery` (section 4);
  - whether stock was recorded per delivery: from the stock moves that name the line.
- **Cancel.** `crm.sales_order.cancel { orderId, expectedVersion, reason }` moves `confirmed` to `cancelled`. It is refused when any line has a delivery (CRM's own table, checked in the transaction). It is also refused when the Orders screen last read a draft for a line; this second check is **advisory** (see "Consequences": the two modules cannot lock each other). A cancelled order cannot be handed off. A cancelled order is final; selling again means a new quote from the deal.
- **Reads.** `crm.sales_order.list`, `get` and `handoff` are R0 queries; RLS decides who reads, with the same visibility as the deal and quote it came from. Viewers read.
- **Tenancy.** Every table has `org_id`, `PRIMARY KEY (org_id, id)`, RLS through `crove_kernel.apply_tenant_rls`, composite foreign keys led by `org_id` and backed by an index (`quote`, `deal`, `party`: `ON DELETE RESTRICT`; an order's lines `ON DELETE CASCADE`), `timestamptz` only, money `numeric`. Each table is in its own migration with the org purge, the manifest classes, the personal data registry (the buyer snapshot of a consumer is personal data) and `pnpm db:types`. `crm.deal.delete` refuses a deal that has an order, as it refuses one that has a quote.

### 3. The hand-off to Kế toán: facts out, a draft back, on a person's click

- **Engage emits, Kế toán takes.** `crm.sales_order.handoff { orderId }` (R0) returns the contract schema `SalesOrderHandoff` in `@crove/kernel-contract` (plan 6.1): the order id, number and date, the legal entity, the currency, the buyer, the lines (line number, optional stock item id, description, unit, quantity, unit price, discount percent, discount amount, amount, VAT rate, VAT amount) and the totals, all money and quantities as decimal strings. It refuses a cancelled order. It emits only the invalidation hint `crm.sales_order` (the id), no other event.
- **Kế toán's command.** `finance.einvoice.draft_from_order` (working name; R1; owners, admins and members; **no agent**) takes `{ handoff, lineNos? }` plus an idempotency key, and makes a normal draft in state `draft`. With no list it takes every open line, that is every line not already on a draft. The browser carries the payload from the CRM query to the finance command; neither module imports the other (the pattern the plans already use for Social and Ads).
- **No foreign key, one source reference.** Each draft line stores `source_kind` (`crm.sales_order`), `source_id` (the order id) and `source_line_no`. A partial unique index over those three columns, for lines of drafts that are not `rejected` (a deleted draft takes its lines with it), makes a second invoice of a line impossible: the second call is refused with `ORDER_LINE_ALREADY_INVOICED`. Deleting or rejecting the draft frees its lines. The same columns serve a booking or a marketplace order as another source kind.
- **Per line, whole lines only (A6).** The person invoices all lines in one go or picks lines. A partial quantity of a line is not supported: split the line in the quote before sending it.
- **Re-checked, never trusted.** The command re-runs every deterministic check a draft already has (buyer fields by buyer kind, the tax code checksum, the VAT rate set, totals by code) and refuses a payload whose line amounts do not add up to its own totals. A payload from the browser can be forged, but only by someone who can already write any draft by hand; the `source_*` columns exist so an audit can compare a draft to its order afterwards. A line with a stock item id that is not an item of that entity, or a text line, is matched by the alias rules of ADR-0045 or listed under "Chưa gán hàng".
- **Discounts (A2).** The draft has no discount column on `main`. The order carries both the percent and the rounded amount (half up, as in plan 4.4). Until Kế toán adds the column, "Lập hóa đơn" is disabled for a line with a discount, with one line telling the person to give the net price instead.
- **Issuing stays Kế toán's.** The draft is read by a person; issuing needs finance's approval (owners and admins, four-eyes, ADR-0044 as amended). `{finance}` may suggest VAT rates and buyer details on the draft (#2505); it never changes the order.
- **Two steps (O4).** Confirm (accept) first, then "Lập hóa đơn". No "confirm and invoice now" setting in this slice. A draft is never made from a quote, only from a `confirmed` order.

### 4. Delivery and stock

- **Stock moves when goods leave** (the rule of the marketplace import, #2515), never when the order is confirmed or invoiced.
- **Engage records the delivery.** `crm.sales_order.deliver { orderId, lineNo, deliveredOn }` (R1; no agent) adds a row to `sales_order_delivery`, append-only, `UNIQUE (org_id, order_id, line_no)`, a whole line, no partial quantity. A service (text) line takes none. A wrongly marked delivery is reversed by `crm.sales_order.undeliver`, which adds a reversing row, never deletes. A cancelled order takes no delivery.
- **Kế toán makes the move.** After the delivery is recorded the Orders screen runs `finance.stock.move_from_order_line` (working name) with the line as its source, read from `crm.sales_order.handoff`, as in section 3. Finance re-checks the line and makes the move at the month's cost taken at close (ADR-0045). Its key is `(order id, line no)`: the command is idempotent on it, so a retry makes no second move, it takes the whole line only, the move date is the delivery date and negative stock is allowed with the stock plan's warning. A return reverses through the same path with a reversing move (`source_type` reversal), never an edit or a deletion; a reversed line is not delivered again in this slice (see "Left out"). `crove_finance.stock_move.source_type` gains a value for an order line, in a migration of the Accounting line.
- **Not one transaction.** If the stock command fails after the delivery was recorded, the line shows `Chưa ghi kho` with a retry, and the retry is safe by the key.
- **Stock moves once, whatever the order of events (A4).** A sale document made from an issued invoice whose draft came from an order would take a stock-out from its sale lines under ADR-0045 8.2, and the delivery takes one too. The source columns carry from the draft line into the sale document line, and the document-line stock path skips a line whose source is an order line (the delivery owns the move). A test issues and delivers one line in either order and expects exactly one move.

### 5. Keys, idempotency and audit

| Command | Retry and double-click safety |
|---|---|
| `crm.quote.accept` | the runtime idempotency key (one UUID per attempt, kept across a step-up or network retry) replays the same result; without it, `UNIQUE (org_id, quote_id)` and the quote's `version` make a second accept refuse with `QUOTE_ALREADY_ACCEPTED`, carrying the existing order id, and write nothing |
| `crm.quote.decline` | the quote's `version`; a second call is refused as a stale version |
| `crm.sales_order.cancel` | the order's `version`; a second call refuses as already cancelled |
| `crm.sales_order.deliver`, `undeliver` | `UNIQUE (org_id, order_id, line_no)` for the delivery; the reversing row is keyed by the delivery it reverses |
| `finance.einvoice.draft_from_order` | the idempotency key replays the same draft; the partial unique index on the source columns refuses a second invoice of a line made with another key |
| `finance.stock.move_from_order_line` | the command is idempotent on `(order id, line no)`; a unique index on the order-line source guarantees one forward move per line |

Every command writes one audit row with ids and counts only (`auditValue`, #1626): never a customer value, a price, a line text or the reason text. Events and idempotency responses carry ids, never customer text.

### 6. The AI's part

Dy, the coworker of Ludy Engage's customers and sales, **may suggest and never decides**: it may offer to move the deal to Thắng and to set the deal amount to the quote total (fixed reasons, deterministic, no model call). It never accepts, declines, cancels, makes an order, invoices, marks a delivery or moves stock. No agent holds any command of this ADR; a test asserts none of them is on any agent template's allowlist, and the ADR-0029 allowlist is unchanged. With the AI off everything here works the same. The suggestion of quote lines (Q5, `crm.quote_suggest`) is a separate read and not part of this contract.

## Consequences

- Positive: acceptance is one click for a one-person company and cannot be done by an agent; the order is a frozen record; the draft and the stock move are made by Kế toán's own commands with Kế toán's own checks; no foreign key crosses a schema; a line is invoiced once and moved once, enforced by unique indexes in the database that owns the document.
- Positive: the order carries no invoice or stock state of its own, so it cannot disagree with Kế toán.
- Negative: the two sides are not one transaction. A delivery recorded in Engage may lack its stock move for a while (shown, retryable, idempotent).
- Negative: **cancel versus a fresh draft is a race the design does not close.** Engage cannot read finance tables and finance cannot read the order, so a cancel and a "Lập hóa đơn" from a payload read just before it can both succeed, leaving a draft that names a cancelled order. The draft is only a draft, a person reads it, and issuing needs finance's approval; the Orders screen shows it. The chosen mitigation is the advisory check above. A kernel-held claim on `(source kind, source id, line)` that both modules update through their own commands would close it; that is not worth a new kernel table before orders are in use, and is listed under "Open points".
- Negative: the payload crosses the browser, so Kế toán re-checks it but cannot prove it is the order's. That is no new privilege (a member can write any draft), and the source columns allow a later reconciliation.
- Migrations are protected paths; the Q4 and Q4b builds get the independent security review, and so does the Kế toán side.

## Alternatives considered

- **Create the order when the quote is sent, confirm it on accept.** Rejected: an order that exists before acceptance is a promise nobody made, and a second step for a one-person company.
- **Let the customer press accept on the public link (O1).** Out of this slice by the owner's decision: a public write that creates a commitment needs its own abuse rules and security review.
- **Let Engage write the e-invoice draft, or finance read the order.** Rejected: breaks "no module writes another's tables" and creates the cross-schema coupling the plans avoid. Marketplace orders and the payroll posting already use a source reference instead.
- **Store invoiced and delivered flags on the order.** Rejected: a second copy of what Kế toán knows; it drifts when a draft is deleted or a move is reversed.
- **A stock move when the order is confirmed.** Rejected by the Accounting PO and ADR-0045: stock leaves when goods leave.
- **A setting "confirm and invoice now" (O4).** Not in the first slice; a later option, off by default.
- **A kernel claim table for cancel versus draft.** Deferred, see Consequences.

## Open points

Statuses are as of 2026-11-08. The Accounting PO's final answers are in the [#2696 comment of 2026-11-08](https://github.com/DOS/Ludy/issues/2696#issuecomment-6720692778), which confirms their view on #2690 of 2026-11-06 and allows this ADR to cite it. The command and column names below are theirs there; the ADR adds only the detail it marks as its own.

| # | Question | Status |
|---|---|---|
| A1 | The source reference (`source_kind`, `source_id`, `source_line_no` on each draft line), the unique index over the lines of drafts that are not rejected or deleted, and `finance.einvoice.draft_from_order` taking the order and a list of line numbers (no list: every open line), from a confirmed order only | **Confirmed** by the Accounting PO (#2696). The same shape serves a booking or a marketplace order as another source kind |
| A2 | Discount per line on the draft (Decree 254, #2506) | **Confirmed as recommended**: the form waits for the accountant's reading of the decree; until then "Lập hóa đơn" is disabled for a discounted line |
| A3 | How a stock item id reaches an order line | **Confirmed**: alias matching in finance only in this slice, no catalog pick in CRM; a read query in the contract (never a foreign key) comes later |
| A4 | One stock move per line: the draft line's source columns carry into the sale document line and the document-line stock path skips a line whose source is an order line | **Confirmed**; a test must show that issuing and delivering one line moves stock once, in either order |
| A5 | `finance.stock.move_from_order_line`: key `(order id, line no)`, whole line only, move date = delivery date, cost at the month's close, idempotent on the key, a return is a reversal row never an edit, negative stock allowed with the stock plan's warning, a service line moves no stock, Engage records the delivery and calls the command and never writes finance tables | **Confirmed** by the Accounting PO (#2696) |
| A6 | Invoicing granularity: whole lines only | **Confirmed** (no partial quantity of a line in this slice) |
| A7 | Cancel versus a fresh draft (the race above); and whether a consumer's order snapshot is redacted when its party is erased and no invoice draft exists, which the personal data registry entry of the Q4 migration must decide with the personal data runbook | **Open**, not covered by the Accounting PO's answers; for the Accounting PO and, for the erasure rule, the lawyer |

## Left out

- The customer's own accept button on the quote link (O1); e-signature, contracts, deposits and payment links.
- Partial quantities of a line, in invoicing and in delivery (A6); delivery documents, carriers and tracking; delivering a line again after its delivery was reversed (a line that really left later is handled in the quote or with a new order).
- "Confirm and invoice now" as one click (O4); a discount above a threshold needing a second person (O2).
- Invoicing a discounted line (A2); multi-currency; editing an order (change it by cancelling and making a new quote).
- A signed hand-off payload, and a reconciliation read comparing orders with their drafts.
- Payments against an order, returns beyond the reversal row, an order in English.
- Dy's wording of a follow-up message; Dy writing anything on an order.
