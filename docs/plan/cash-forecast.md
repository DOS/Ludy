# Cash-flow forecast, 30/60/90 days (#4391)

Owner decision 2026-11-22 (popup to the Accounting PO): a 30/60/90-day cash-flow view per legal entity, computed by code, with the Accounting coworker (Ly) explaining the low point. Plan line for the issue; the design and the PO's four decisions are on [#4391](https://github.com/DOS/Ludy/issues/4391).

## What it is

A read-only card on the Kế toán Tổng quan (`finance.cash_forecast`, `modules/finance/src/cash-forecast.ts`, pure rules in `domain/cash-forecast.ts`). One legal entity at a time, VND only, day 0 to day 90, every amount a decimal string. Nothing is posted, paid or stored.

| Part | Rule |
|---|---|
| Opening cash | The booked 111 + 112 on day 0 (the overview's own balances, so it equals B01 line 110). A bank line not yet booked is not in it. |
| Receipts | The open sales invoices of the reminders' loader (`loadCustomers`: the 131 balance laid over the invoices, newest first), each on its due date (invoice date + the customer's or the org's terms). **An overdue invoice is not counted**; it is shown apart. The part of 131 no invoice covers is not counted either. |
| Payments | The 331 balance per supplier laid over its purchase invoices, newest first, each on invoice date + 30 days (**an estimate, Uncertain**: a received invoice has no due date). An overdue one counts on day 0. The part of 331 no invoice covers (and 331 lines naming no party) counts on day 0. |
| Approved supplier payments (#3113) | A dated outflow on the first day the bank file may go (the end of the 24-hour hold, else today). Its amount is still inside 331 until a bank line is matched, so it is taken out of that supplier's pool first and its invoice out of the allocation; what it counts for is capped by the 331 balance (a payment already booked by hand leaves once). |
| Left out, always said | Payroll, social insurance, tax payments, rent, loans and any other recurring cost. Finance cannot read payroll (ADR-0046: `hr` depends on `finance`; no pay date or amount is stored), and no tax amount is computed anywhere. The tax due dates of the horizon (the tax calendar's own 30-day window) are shown as markers with no amount. |
| Low point | The lowest balance of the 91 days and its day (the earliest on a tie), shown with or without AI. The five largest items up to that day drive the note; no party names. |

Asymmetry on purpose: an overdue receivable is not expected, an overdue payable is. Every date is derived (terms, the first day a file may go); none is stated by a document.

## The coworker's note

`finance.cash_forecast_explain` in `AI_FEATURES` (the finance budget line), the same flow as the overview sentence: the model is told the figures and dates, no name, and answers up to 3 sentences. The text is refused (the card then shows the figures alone) when it states a number or date the facts do not hold, a link, **advice about money** (move, transfer, borrow, delay, chase, cut) or **a promise or certainty** (will, sẽ, guaranteed). Those last two are checked in code (`packages/agent/src/cash-forecast.ts`), not only asked for in the prompt. No model call when nothing is expected in the 90 days; the core works with AI off.

## Bounds (performance)

At most 500 customers and 500 suppliers (largest balances first), 10,000 purchase invoices and 1,000 approved payments are read; past a bound the forecast says it is partial (`truncated`). Reads are aggregates on `journal_line` by org, entity, account prefix and entry date, the predicates the overview and the customers list already run. No new table, index or migration.

## Not built

- Owner-entered expected items (rent, loans, payroll, a one-off), the way to bring the left-out costs in: a later slice with its own table and command.
- Supplier payment terms on a purchase invoice, so the payable date is real: [#4395](https://github.com/DOS/Ludy/issues/4395) (Icebox, P3).
- A chart of the daily series (the card shows the three checkpoints and the low point; the daily series is in the answer).
- MCP exposure and a client-facing page.
