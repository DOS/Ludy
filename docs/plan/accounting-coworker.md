# The Accounting coworker (Ly, Ludy Kế toán): features beyond the books' own screens

One scope line per owner-approved feature, each linked to its issue. Code computes every figure, the coworker explains in words, a person decides, nothing moves money. Every model call is metered under its own `AI_FEATURES` key and the core works with AI off. Whoever merges a feature adds its line here.

| Feature | Scope | Issue | Plan |
|---|---|---|---|
| Cash-flow forecast, 30/60/90 days | A read-only card on the Tổng quan: booked cash, receipts and payments dated from the books, the lowest balance and its day; the coworker's note on the low point states no figure and no date. | [#4391](https://github.com/DOS/Ludy/issues/4391) | [cash-forecast.md](cash-forecast.md) |
| Month-close checklist | For one legal entity and month, on the Tổng quan: seven items counted by code (pending proposals dated in the month, tax-portal invoices that match no voucher, unbooked bank lines, marketplace settlements and payouts not recorded, the stock close not run, the VAT return not marked as filed, the period lock not covering the month), each with a count, a link and fixed text. The coworker is told which items are open and no count or date, puts them in order and says why in one short note; the order is accepted only if it is exactly the open items. | [#4390](https://github.com/DOS/Ludy/issues/4390) | [below](#month-close-checklist-4390) |
| Cost variance | A read-only card on the Tổng quan: expense lines that moved against last month and the 3-month average, flagged by code under the entity's books; the coworker's possible reason per line states no figure, date or name. | [#4392](https://github.com/DOS/Ludy/issues/4392) | the section below |
| Ask the books in plain words | A read-only card on the Tổng quan: the owner types a question ("Tháng 10 lãi bao nhiêu?") or picks a report. The coworker only chooses one entry of a closed catalogue of six existing reads (profit and loss, cash and bank, receivables, payables, VAT, stock value) and a kind of period; code resolves the period, runs that read as the asking member and shows every figure with a link to the full report. A question outside the catalogue gets a fixed list of what can be asked. | [#5181](https://github.com/DOS/Ludy/issues/5181) | [below](#ask-the-books-in-plain-words-5181) |

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

## Ask the books in plain words (#5181)

**What the coworker does.** It reads the owner's question and returns a structured choice: one entry of the catalogue (or "none"), a kind of period (`this_month`, `last_month`, `this_quarter`, `last_quarter`, `this_year`, `last_year`, `named`, `as_of_today`) and at most one short sentence. It never returns a figure, a date, SQL or a name. Everything else is code, and the core works with AI off: the question box is hidden and the list of reports below it does the same job, without the sentence.

**The catalogue.** Each entry is backed by a read the Kế toán screens already use, run through the runtime as the asking member, so that read's own role list, row security, legal-entity scope and refusal apply unchanged.

| Entry | Read | Period | Card |
|---|---|---|---|
| `profit_loss` | `finance.statements.period` (B02 lines 10, 11, 50, 60) | month, quarter, year | revenue, cost of goods, profit before and after tax |
| `cash_balance` | `finance.statements.period` (B01 line 110) | month, quarter, year | cash and bank at the period's end |
| `receivables_top` | `finance.ledger.period` (131 per party) | month, quarter, year | total and the 5 largest balances at the period's end |
| `payables_top` | `finance.ledger.period` (331 per party) | month, quarter, year | total and the 5 largest balances at the period's end |
| `vat_position` | `finance.vat.period` | month, quarter | output, input, difference, carry-forward |
| `stock_value` | `finance.stock.report` | month | closing value summed over the items |

Not in the catalogue, because no existing read ranks them: the top customers by sales and the top suppliers by purchases. They get the "none" card (a follow-up if the owner wants them).

**What the model reads.** Only the owner's question, and only after code found any month, quarter or year in it with its own parser and replaced every period phrase with `[period]` and every number with `[number]`. A name the owner typed can still reach the model as part of their own question; an echo guard refuses a sentence that repeats a typed word outside the catalogue's vocabulary. The period is resolved by code: from the books' day for a relative word, from the parser for a named one, and a list to pick from when it is unclear, not allowed for the entry (a year for VAT, a quarter for stock) or not begun.

**The sentence's checks** (NFKC text): no digit of any script, number words in both languages, date words, invisible marks and look-alike scripts, links, promises, done-claims, advice about money, causes, markup, or echo of a typed word; a refused sentence is dropped and the card keeps its fixed text.

**What is kept.** For 30 minutes, the coworker's validated choice (the entry and the kind of period) for a redacted question, by org and language; never a figure, a card or a sentence. The read runs again on every request as the member who asks.

**Where.** `finance.ask_books` is the metered key (`packages/agent/src/meter.ts`); the question's preparation, the prompt and every check are in `packages/agent/src/ask-books.ts`, the call in `ask-books-coworker.ts`; the contract and the period resolver in `packages/kernel-contract/src/finance-ask-books.ts`; the orchestration in `apps/kernel/src/finance-ask-books.ts` (`financeAskBooks.ask` in `rpc.ts`); the card in `apps/app/src/components/ask-books-card.tsx`. The eval set (more than 40 questions in Vietnamese and English) is `apps/kernel/test/finance-ask-books-eval-cases.ts`; it runs in CI with a fake model, so it proves the plumbing, the validator and the catalogue contract, not how well a live model chooses.
