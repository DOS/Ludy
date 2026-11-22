# Accounting coworker: month close, cash flow, cost variance

> Plan for the three AI features the owner asked to build on 2026-11-22 (JOY, Accounting PO popup). Each is a screen of Kế toán where code computes every number and the finance coworker only phrases, orders or explains. Milestone GA gate, `priority:P2`, `line:accounting`.

The finance coworker is named in the screens through the `{finance}` placeholder (never written in copy). Every model call goes through the AI budget meter (`metered()`, one `AI_FEATURES` key each), the core works with AI off, and a person approves every step that changes money, a message or a spend. The coworker's text is tainted: a deterministic check after the call refuses it, and the screen then shows the same figures without it.

## The rule that holds for all three

A text the coworker writes about a screen may state **no number and no date** that code did not give it. The first feature goes furthest: it is told no number at all, so a misplaced figure is impossible by construction, and the card shows every count itself. The other two follow the same rule for the figures their cards show.

## Features

| Feature | Scope line | Issue |
| --- | --- | --- |
| Month-close checklist | For one legal entity and month, on the Kế toán overview: seven items counted by code (pending proposals dated in the month, tax-portal invoices that match no voucher, unbooked bank lines, marketplace settlements and payouts not recorded, the stock close not run, the VAT return not marked as filed, the period lock not covering the month), each with a count, a link and fixed text. The coworker puts the open items in order and says why in one short note; the order is accepted only if it is exactly the open items. | [#4390](https://github.com/DOS/Ludy/issues/4390) |
| Cash-flow forecast | A forecast card on the Kế toán overview: the figures are computed by code, and the coworker explains them. | [#4391](https://github.com/DOS/Ludy/issues/4391) |
| Cost variance | An expense variance explanation. | [#4392](https://github.com/DOS/Ludy/issues/4392) |

The lines for the second and third feature are placeholders written by the first PR that merged: the worker of each issue replaces its line with the final scope when its own PR merges.

## Month-close checklist (#4390)

- **Read only.** One query, `finance.month_close`, with a count per item; no command, no posting, no migration. Every count is scoped by `org_id` and by the legal entity, under the restrictive `le_scope` policy, and no item reads an amount.
- **Items.** Pending proposals: finance proposals still `pending` whose own date (voucher date, invoice issue date, else the day made) is in the month. Tax-portal invoices: the missing, different-amount and only-in-the-Inbox outcomes of the portal reconciliation of the month's VAT period, purchases and sales, shown only when a list was imported for it. Bank lines: dated in the month, with no posted unreversed voucher, no platform payout voucher and no pending voucher proposal. Marketplace: the settlements and payouts the Sàn screen still offers, whose settlement period ends in the month. Stock close: shown only for an entity with stock moves and a month that is over. VAT: "the return of the period is not marked as filed", shown only for the last month of the filing period (a monthly filer: every month; a quarterly filer: the last month of the quarter). Period lock: the entity's lock does not run through the last day of the month.
- **The coworker.** Told which items are open (a fixed key, a fixed label and a fixed hint on what each depends on) and no count, date, name or amount. It returns an `order` and a `note`. The note is refused when it holds a digit, a number in words, a date or a day word, a link, a promise or a claim that something was done, or is over two sentences; the order is refused unless it is an exact permutation of the open items. Metered under `finance.month_close_explain`.
- **AI off, budget spent, answer refused:** the same checklist in the fixed order, without the note.
- **Default month** is the calendar month before today; the picker offers the last 12 months.
