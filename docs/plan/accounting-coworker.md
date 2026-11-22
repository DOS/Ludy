# Accounting coworker: month close, cash flow, cost variance (2026-11-22)

Owner decision, 2026-11-22 (JOY, Accounting PO popup): put three AI features of the Kế toán app in the plan and build
them. Each one follows the same rule: code finds the facts, the finance coworker only phrases or suggests, a person
decides. The core works with AI off; every model call goes through `metered()` in `packages/agent` under its own
`AI_FEATURES` key; a text the model writes is checked after the call and dropped, never repaired, when it states what
it was not given.

| Feature | Scope | Issue |
| --- | --- | --- |
| Month-close checklist | the items an entity still has open for a month, ordered and explained by the coworker | #4390 |
| Cash-flow forecast | the forecast card on the Kế toán overview | #4391 |
| Cost variance | expense lines that moved against last month and the 3-month average, with a possible reason | #4392 |

## Cost variance (#4392)

For one legal entity and one month that has ended, the card on the Kế toán overview compares each expense line with
the month before and with the average of the three months before that month, flags the lines that moved, and shows the
top suppliers or vouchers behind each. It reads, never writes: `finance.expense_variance` runs in the member's own
transaction, so only the entities the member may see are counted, and a month still running is refused
(`MONTH_NOT_ENDED`).

**Lines, by the entity's books on the last day of the month.** Expense accounts are class 6 and the class 8 expense
accounts 811 and 821; revenue, income and the year-end closing entries are left out. Under TT133 the line is 4 digits
for 64xx (6411 to 6418, 6421 to 6428) and 3 digits for every other account; under TT99 it is 3 digits everywhere, so
641 and 642 are one line each. A comparison whose months are not all in the chart of the month (a fiscal year that
changed regime) is not made and the card says so; no translation between charts is attempted.

**Thresholds are defaults, not settings.** A line is flagged when its change against the month before, or against the
average, is at least both 5,000,000 dong and 30% of the basis (exact decimals; a basis of 0 is flagged on the amount
alone and shown as new). They are constants for every org and the card states them. A per-org setting is a later P3
and is not built.

**What the coworker does.** One sentence per flagged line (at most 8) with a possible reason, marked as a possibility.
It is told, per line, a fixed kind of expense, the direction, which comparison flagged it, the supplier's name (only an
organization's, with no digit, in plain letters, clipped), what kind of voucher it is and whether there is a single
voucher or several. It is told no amount, percent, date, count or account number, and the note may state none: any
digit, number in words, date, name it was not given, certainty word, claim that something was done, promise, advice or
direction that contradicts the line refuses the note. The table shows every figure. With AI off, the budget spent or
every note refused, the table is the same, without sentences and without a notice.

**Where.** `finance.expense_variance` and `financeExpenseVariance.explain` (contract in
`packages/kernel-contract/src/finance-expense-variance.ts`), the rules in `modules/finance/src/domain/expense-variance.ts`,
the note in `packages/agent/src/expense-variance.ts` under the key `finance.expense_variance_note`, the card in
`apps/app/src/routes/expense-variance-card.tsx`.
