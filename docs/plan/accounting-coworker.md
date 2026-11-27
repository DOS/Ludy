# The Accounting coworker (Ly, Ludy Kế toán): features beyond the books' own screens

One scope line per owner-approved feature, each linked to its issue. Code computes every figure, the coworker explains in words, a person decides, nothing moves money. Every model call is metered under its own `AI_FEATURES` key and the core works with AI off. Whoever merges a feature adds its line here.

| Feature | Scope | Issue | Plan |
|---|---|---|---|
| Cash-flow forecast, 30/60/90 days | A read-only card on the Tổng quan: booked cash, receipts and payments dated from the books, the lowest balance and its day; the coworker's note on the low point states no figure and no date. | [#4391](https://github.com/DOS/Ludy/issues/4391) | [cash-forecast.md](cash-forecast.md) |
| Month-close checklist | For one legal entity and month, on the Tổng quan: seven items counted by code (pending proposals dated in the month, tax-portal invoices that match no voucher, unbooked bank lines, marketplace settlements and payouts not recorded, the stock close not run, the VAT return not marked as filed, the period lock not covering the month), each with a count, a link and fixed text. The coworker is told which items are open and no count or date, puts them in order and says why in one short note; the order is accepted only if it is exactly the open items. | [#4390](https://github.com/DOS/Ludy/issues/4390) | [below](#month-close-checklist-4390) |
| Cost variance | A read-only card on the Tổng quan: expense lines that moved against last month and the 3-month average, flagged by code under the entity's books; the coworker's possible reason per line states no figure, date or name. | [#4392](https://github.com/DOS/Ludy/issues/4392) | the section below |
| Unusual posted entries | A monthly review of POSTED entries on the Tổng quan, for one legal entity and an ended month: five rules find them (a repeat of an invoice, a manual voucher on a control account, an amount far outside the usual range, an account never used with this supplier or kind of voucher, an entry keyed on a day off), ranked and capped in SQL; the coworker's one possible thing to look at per hit states no figure, date, code or name and never says the entry is wrong; a person may mark a hit as reviewed (audited, idempotent, no ledger write). | [#5182](https://github.com/DOS/Ludy/issues/5182) | the last section below |

## Month-close checklist (#4390)

- **Read only.** One query, `finance.month_close`, with a count per item; no command, no posting, no migration. Every count is scoped by `org_id` and by the legal entity, under the restrictive `le_scope` policy, and no item reads an amount.
- **Items.** Pending proposals: finance proposals still `pending` whose own date (voucher date, invoice issue date, else the day made) is in the month. Tax-portal invoices: the missing and different-amount outcomes of the portal reconciliation of the month's VAT period (the quarter's lists first for a quarterly filer in the last month of the quarter), purchases and sales, shown only when a list was read for it; an invoice that is only a proposal in the Inbox is counted in the first item, not here. Bank lines: dated in the month, with no posted unreversed voucher, no platform payout voucher and no pending voucher proposal. Marketplace: settlements still to post and payouts still to record (the standing and posted rules of the Sàn screen), whose settlement period ends in the month, counted in two month-filtered queries with no cap; one that already waits on a pending proposal is counted in the first item, not here. Stock close: shown only when the month is over and a stock move since the last closed month needs it. VAT: "the return of the period is not marked as filed", shown only for the last month of the filing period (a monthly filer: every month; a quarterly filer: the last month of the quarter). Period lock: the entity's lock does not run through the last day of the month.
- **The coworker.** Told which items are open (a fixed key, a fixed label and a fixed hint on what each depends on) and no count, date, name or amount. It returns an `order` and a `note`. The note is refused when it holds a digit, a number in words, a date or a day word, a link, a promise or a claim that something was done, or is over two sentences; the order is refused unless it is an exact permutation of the open items. Metered under `finance.month_close_explain`.
- **AI off, budget spent, answer refused:** the same checklist in the fixed order, without the note.
- **Default month** is the calendar month before today; the picker offers the last 12 months.

## Cost variance (#4392)

For one legal entity and one month that has ended, the card on the Kế toán overview compares each expense line with
the month before and with the average of the three months before that month, flags the lines that moved, and shows the
top suppliers or vouchers behind each. It reads, never writes: `finance.expense_variance` runs in the member's own
transaction, so only the entities the member may see are counted, and a month still running is refused
(`MONTH_NOT_ENDED`).

**Lines, by the entity's books on the last day of the month.** Expense accounts are class 6 and the class 8 expense
accounts 811 and 821; revenue, income and the year-end closing entries are left out. Under TT133 the line is 4 digits
for 64xx (its chart has 6421, selling expenses, and 6422, administration) and 3 digits for every other account; under
TT99 it is 3 digits everywhere, so 641 and 642 are one line each, whatever their level-2 accounts. A comparison whose months are not all in the chart of the month (a fiscal year that
changed regime) is not made and the card says so; no translation between charts is attempted.

**Thresholds are defaults, not settings.** A line is flagged when its change against the month before, or against the
average, is at least both 5,000,000 dong and 30% of the basis (exact decimals; a basis of 0 is flagged on the amount
alone and shown as new). They are constants for every org and the card states them. A per-org setting is a later P3
and is not built.

**What the coworker does.** One sentence per flagged line (at most 8) with a possible reason, marked as a possibility.
It is told, per line, a fixed kind of expense, the direction, which comparison flagged it, and for each of the top
contributors whether it is a supplier or a voucher with no supplier, what kind of voucher it is and whether there is a
single voucher, several or none this month. It is told no name (a supplier of a small business is often a person, so its
name is personal data, and the table already shows it; the issue's "drawn from the supplier" is superseded by the PO's
decision of 2026-11-22), and no amount, percent, date, count or account number; the note may state none. A note must
open with a hedge word ("Possibly", "Có thể"); any digit, number or size in words, date, capitalised word after the
first (no name is given, so none can be right), hidden character, certainty word, claim that something was done, promise,
advice or direction that contradicts the line refuses it. The table shows every figure. With AI off, the budget spent or
every note refused, the table is the same, without sentences and without a notice.

**Months before the books begin.** A basis month that ends before the entity's first entry is not a month of 0, it is
not there: the comparison that needs it (the month before, or the average of three) is not made, and the card says
where the books begin.

**Known limits (P3, not built).** A voucher and its reversal that are both dated inside the 4 months read are left out of
the contributors and the voucher counts; when only one of them is inside, it stays as booked, because it moved that
month's balance (the line's own figure nets a pair either way). The note check works on words: letters spaced apart
("f i v e") are not caught; no user text reaches the model, so there is no adversarial input path.

**Where.** `finance.expense_variance` and `financeExpenseVariance.explain` (contract in
`packages/kernel-contract/src/finance-expense-variance.ts`), the rules in `modules/finance/src/domain/expense-variance.ts`,
the note in `packages/agent/src/expense-variance.ts` under the key `finance.expense_variance_note`, the card in
`apps/app/src/routes/expense-variance-card.tsx`.

## Unusual posted entries (#5182)

Owner decision 2026-11-27 (JOY, Accounting PO, AI round 2). A monthly review of entries already **posted**, for one legal
entity and one ended month. It differs from the flags of #2380, which fire on a proposal before a payment is approved; the
thresholds that fit are reused from it and from the cost variance. It reads, never writes the books: `finance.unusual_entries`
runs in the member's own transaction, every statement filters org and entity, and the one statement that finds, ranks and caps
the hits reads the last 24 months of one entity at most.

**Rules (codes in `packages/kernel-contract/src/finance-unusual-entries.ts`, thresholds are defaults, not settings).**
- `duplicate_invoice`: a purchase document in force with the same supplier, the same invoice number (as the intake compares
  it: spaces dropped, leading zeros dropped when it is all digits, else upper case) and the same total as an earlier one in
  force; a replacement or a correction of it is not a duplicate. The later copy is the hit.
- `control_manual`: a voucher a person typed (no payroll, settlement, payout, stock, closing, surplus or fee link) with a
  line on 131, 331, 133, 333 or 334.
- `amount_outlier`: an entry's amount on a group (supplier or customer and account line: 4 digits for 64xx under TT133, 3
  under TT99) is at least 3 times, or at most a third of, the median of the group's earlier entries of the last 6 months,
  differs from it by at least 5,000,000 dong and by at least 5 times the median absolute deviation; judged only with at
  least 6 earlier entries. Median and spread are computed over NUMERIC in SQL (never `percentile_cont`, which is a double).
- `new_account`: an account line that a supplier with at least 3 earlier entries, or, for a line with no supplier, a kind of
  voucher (invoice, cash or bank voucher, manual) with at least 10, has not used in the last 24 months. The window is bounded
  on purpose: the approved design said "ever", and the PO's condition that the history reads stay bounded replaced it.
- `off_day`: an entry a person keyed (a manual voucher or a cash or bank voucher) of 5,000,000 dong or more, dated on a
  Saturday, a Sunday or a public holiday of the shared calendar (#4387: the fixed dates, Tết and the Hùng Kings day for the
  years in its lunar table). Days the government moves are not in that calendar and the 2027 table is unconfirmed (#2520).

**Left out everywhere (candidates and history).** An entry with a line on 911 (both regimes); an entry that has a reversal
and a reversal entry itself, whatever their dates. This is stricter than the cost variance, which only drops a pair when
both sides fall inside its window, because a hit asks whether an entry is worth a look and a cancelled pair is not. History
rows from before the day the entity's current chart began are not read (TT133 and TT99 codes do not translate).

**Ranking and cap.** In SQL: rule order (the list above), then amount, then the later day. At most 6 hits per rule and 30 in
all; hits already marked reviewed are taken out before the ranking, so they never use a place, and are counted.

**The reviewed mark.** `finance.unusual_entries.review` (R1, user actors only, owners, admins and members) inserts one row of
`ludy_finance.entry_review_mark` per (org, entry, rule); the unique key makes it idempotent and the runtime audits every run
(entry id, rule, whether it was already marked, no figure or text). No ledger table is touched and there is no unmark in this
slice. The table is insert-only for the tenant role, under RLS and the legal-entity scope. It is not purged with the org's
tenant data: it follows the ledger entry it points at, which `ludy_kernel.org_purge` reads and never deletes, as
`input_vat_check` does, so no `ludy_kernel` function is replaced.

**What the coworker does.** One sentence per hit (at most 12), a possibility to look at, never a finding. It is told, per
hit, the rule as a fixed phrase, a fixed kind of voucher and one fixed detail (far above or far below the usual, new for the
supplier or the kind of voucher, a day off without saying which, the control group); no figure, date, account code, voucher
number, name or memo. The note is checked after the call with the very same text checks as the cost variance (hedge first,
no digit or number in words, no date, no name, no certainty, no done-claim, no promise, no advice) plus a refusal of words
that say the entry is wrong and of advice to move money or undo an entry, and an amount note must agree with its direction.
The card shows every figure and an "Open voucher" action; with AI off, the budget spent or every note refused, the list is
the same, without sentences and without a notice.

**Where.** `finance.unusual_entries`, `finance.unusual_entries.review` and `financeUnusualEntries.{get,explain,review}`
(contract in `packages/kernel-contract/src/finance-unusual-entries.ts`), the query in `modules/finance/src/unusual-entries.ts`,
its pure parts in `modules/finance/src/domain/unusual-entries.ts`, the note in `packages/agent/src/unusual-entries.ts` under
the key `finance.unusual_entries_note`, the card in `apps/app/src/routes/unusual-entries-card.tsx`.
