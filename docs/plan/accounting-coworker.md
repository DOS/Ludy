# The Accounting coworker (Ly, Ludy Kế toán): features beyond the books' own screens

One scope line per owner-approved feature, each linked to its issue. Code computes every figure, the coworker explains in words, a person decides, nothing moves money. Every model call is metered under its own `AI_FEATURES` key and the core works with AI off. Whoever merges a feature adds its line here.

| Feature | Scope | Issue | Plan |
|---|---|---|---|
| Cash-flow forecast, 30/60/90 days | A read-only card on the Tổng quan: booked cash, receipts and payments dated from the books, the lowest balance and its day; the coworker's note on the low point states no figure and no date. | [#4391](https://github.com/DOS/Ludy/issues/4391) | [cash-forecast.md](cash-forecast.md) |
| Month-close checklist | For one legal entity and month, on the Tổng quan: seven items counted by code (pending proposals dated in the month, tax-portal invoices that match no voucher, unbooked bank lines, marketplace settlements and payouts not recorded, the stock close not run, the VAT return not marked as filed, the period lock not covering the month), each with a count, a link and fixed text. The coworker is told which items are open and no count or date, puts them in order and says why in one short note; the order is accepted only if it is exactly the open items. | [#4390](https://github.com/DOS/Ludy/issues/4390) | [below](#month-close-checklist-4390) |
| Cost variance | A read-only card on the Tổng quan: expense lines that moved against last month and the 3-month average, flagged by code under the entity's books; the coworker's possible reason per line states no figure, date or name. | [#4392](https://github.com/DOS/Ludy/issues/4392) | the section below |
| Unusual posted entries | A monthly review of POSTED entries on the Tổng quan, for one legal entity and an ended month: five rules find them (a repeat of an invoice, a manual voucher on a control account, an amount far outside the usual range, an account never used with this supplier or kind of voucher, an entry keyed on a day off), ranked and capped in SQL; the coworker's one possible thing to look at per hit states no figure, date, code or name and never says the entry is wrong; a person may mark a hit as reviewed (audited, idempotent, no ledger write). | [#5182](https://github.com/DOS/Ludy/issues/5182) | the last section below |
| The quarter in plain words | A read-only card on the Tổng quan for a quarter that has ended: revenue, costs and profit against the previous quarter and the same quarter last year, cash, receivables and payables, VAT or the household's tax, stock; the coworker's three to five sentences say how each picked figure moved, from fixed labels only, and state no figure, date, code, name or cause. | [#5183](https://github.com/DOS/Ludy/issues/5183) | [below](#the-quarter-in-plain-words-5183) |
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

**Known limits (P3, not built).** A model that gives a place or a firm in lower case slips past the name check (it is told none, so it cannot leak a real one). A basis the books cover only in part (they begin inside it) is compared as a whole quarter and the card says so. Every `explain` call re-reads the summary (the same pattern as the expense variance card). A voucher and its reversal that are both dated inside the 4 months read are left out of
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
thresholds that fit are reused from it and from the cost variance. It reads, never writes the books: `finance.unusual_entries.list`
runs in the member's own transaction, every statement filters org and entity, and the one statement that finds, ranks and caps
the hits reads the last 24 months of one entity at most.

**Rules (codes in `packages/kernel-contract/src/finance-unusual-entries.ts`, thresholds are defaults, not settings).**
- `duplicate_invoice`: a purchase document in force with the same supplier, the same invoice number (spaces dropped, leading
  zeros dropped when it is all digits, else upper case; the series may differ, which is what the intake's own exact check of
  series and number lets through) and the same total as an earlier one in
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

**Who an entry is about.** A line's party is its own or the one party the whole entry names: an invoice posts the party on
its payable line only, so the expense line takes the entry's party (an entry that names several parties leaves its lines as
they are).

**Left out everywhere (candidates and history).** An entry with a line on 911 (both regimes); an entry that has a reversal
and a reversal entry itself, whatever their dates. This is stricter than the cost variance, which only drops a pair when
both sides fall inside its window, because a hit asks whether an entry is worth a look and a cancelled pair is not. History
rows from before the day the entity's current chart began are not read (TT133 and TT99 codes do not translate).

**Ranking and cap.** In SQL: rule order (the list above), then amount, then the later day. At most 6 hits per rule and 30 in
all; hits already marked reviewed are taken out before the ranking, so they never use a place, and are counted.

**The reviewed mark.** `finance.unusual_entries.review` (R1, user actors only, owners, admins and members) first runs the same rule SQL for that one
entry in the month of its date and refuses `NOT_A_HIT` (writing nothing) unless the pair is a current hit, so a member cannot
pre-suppress a hit that has not happened (PO decision 2026-11-27); it then inserts one row of
`ludy_finance.entry_review_mark` per (org, entry, rule); the unique key makes it idempotent and the runtime audits every run
(entry id, rule, whether it was already marked, no figure or text). No ledger table is touched and there is no unmark in this
slice. The card lists the newest 10 reviewed hits with "reviewed by <name>, <date>" (the name the org knows the member by, the
date in Vietnam time). The table is insert-only for the tenant role, under RLS and the legal-entity scope. It is not purged with the org's
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

**Where.** `finance.unusual_entries.list`, `finance.unusual_entries.review` and `financeUnusualEntries.{get,explain,review}`
(contract in `packages/kernel-contract/src/finance-unusual-entries.ts`), the query in `modules/finance/src/unusual-entries.ts`,
its pure parts in `modules/finance/src/domain/unusual-entries.ts`, the note in `packages/agent/src/unusual-entries.ts` under
the key `finance.unusual_entries_note`, the card in `apps/app/src/routes/unusual-entries-card.tsx`.

## The quarter in plain words (#5183)

For one legal entity and one quarter that has ended (Vietnam day), the card on the Kế toán overview shows the figures a small business owner asks for after a quarter, and the coworker says in three to five sentences how the picked ones moved. It reads, never writes: `finance.quarter_summary` runs in the member's own transaction, so only the entities the member may see are summed, and a quarter still running is refused (`QUARTER_NOT_ENDED`). No migration, no command.

**Every figure comes from a read that already exists**, so the card and the reports cannot disagree (DB tests pin each one):
- revenue, other income, costs and profit before tax: the income statement's lines (`buildB02`, as `finance.statements.period` and `finance.overview` read them) for the quarter, the previous quarter and the same quarter last year, in one statement with the balances;
- cash (B01 line 110), receivables (131) and payables (311): the balances at the last day of each of the three quarters (cash at the start is the previous quarter's balance);
- the oldest overdue sales invoice: the reminders' loader as at the quarter's last day, bounded like the cash forecast's read (receivables only: no existing read gives a payable due date);
- VAT for a company: the VAT screen's read (VAT on sales [35], on purchases [24], their difference before any carry-forward, and whether the return is marked filed); for a household, its 01/CNKD worksheet (`ready`, `held`, or `not_required` when the worksheet is refused);
- stock value where stock is kept: the stock report's closing values for the last month of the quarter and of the previous quarter (compared with the previous quarter only; provisional until the month is closed);
- the period lock (open, partly, locked) and the VAT filed mark, shown whatever they are.

**The income statement's gap (#5187).** B02 is the TT133 map and reads only 511, 632, 515, 635, 642, 711, 811 and 821, so a TT99 entity's 641 (and 621, 622, 623, 627) and its 521 revenue deduction are in its `unmapped` list and its profit is overstated. The card does not drop them: a 521 balance lowers revenue, any other class 6 or 8 balance is a cost, any other class 5 or 7 credit is other income, so revenue + other income - costs = profit, and profit equals B02 line 50 whenever nothing is unmapped (a TT133 test pins it). When any such balance is in, a fixed footnote says the profit can differ from B02. The B02 map itself is not changed here.

**Labels.** Per row, by code, from exact decimals: against the previous quarter and against the same quarter last year, `rose`, `fell`, `steady` (moved by less than 5% of the basis, a constant), `first_time` (basis 0, figure positive; a loss or an overdraft from nothing is `fell`) or `none` (both 0, or the basis is not there because the entity's books begin after it: a basis that ends before the first entry is not 0).

**What the coworker does.** Code picks up to five rows worth a sentence (moved the same way against both bases first, then opposite ways, then one base, then steady; a row with both labels `none` is never asked) and the model is told, per row, a fixed row name, the two labels and whether sales invoices were overdue, and the entity kind. It is told no figure, date, account code, voucher number, party name, regime or period name, and no cause. It returns one sentence per row, tied to the row by its number; the card prints each beside the row's name and marks the row. Metered under `finance.quarter_summary_note`; the meter logic and `DraftBudget` are unchanged.

**What refuses a sentence** (nothing is cut or repaired): any digit, number word (English and Vietnamese, ordinals and joined forms), date word or period word other than the three fixed phrases ("this quarter", "the previous quarter", "the same quarter last year" and the Vietnamese "quý này", "quý trước", "cùng kỳ năm trước"), invisible or combining marks, links, emoji, markup, another script, a capitalised word after the first (`VAT` apart), a cause, certainty, a done-claim, a promise or the future, advice, advice to move money, a size the labels do not carry, a negation, a direction the row does not have, or one said against the wrong basis (each direction word is held to the period phrase it is said against: up needs that basis to have risen or appeared, down to have fallen, steady to have stayed steady, "first time" to have appeared; a direction word before its phrase waits for the next clause that has one; two directions in one clause are refused), a period continuation after a fixed phrase ("quý trước nữa", "the previous quarter before"), month, week, day and season words, any English adverb in -ly ("only" and "possibly" apart), a future form ("set to", "expected to", "dự kiến", "sắp"), more than one sentence, over 140 characters, a row not asked or asked twice. A set is shown only when at least min(3, rows asked) sentences stand.

**AI off, budget spent, set refused:** the same card without sentences and without a notice. VAT and the household's tax are shown, not phrased: the design gave them no comparison basis.

**Known limits (P3, not built).** The oldest overdue payable (no due date to read); the stock against the same quarter last year (each read replays the entity's moves); a per-org steady threshold; a quarter compared across a change of books is compared by account class, so it is not refused.

**Where.** `finance.quarter_summary` and `financeQuarterSummary.explain` (contract in `packages/kernel-contract/src/finance-quarter-summary.ts`), the rules in `modules/finance/src/domain/quarter-summary.ts` and the read in `modules/finance/src/quarter-summary.ts`, the sentences in `packages/agent/src/quarter-summary.ts` under the key `finance.quarter_summary_note`, the row picking and the budget in `apps/kernel/src/finance-quarter-summary-ai.ts`, the card in `apps/app/src/routes/quarter-summary-card.tsx`.

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
