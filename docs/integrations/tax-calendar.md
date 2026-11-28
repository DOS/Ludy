# Tax calendar per client (issue #921)

The multi-client home screen lists each client's recurring tax obligations, not only the VAT return. It shows:

- the next one, per client;
- a list across all clients of what is due in the next 30 days or overdue and not marked done, by due date.

A member marks an obligation done for a period, and it leaves the list.

- **Rules:** `packages/kernel-contract/src/tax-calendar.ts`, `TAX_RULES`. Each line gives:
  - the obligation and its frequency;
  - its year basis: the calendar, or the org's fiscal year;
  - the due-day rule;
  - the periods it covers;
  - its legal basis;
  - `confirmed`, false until the partner's accountant (#61) confirms the line.

  A change of the law is a change of this table. Unit tests: `packages/kernel-contract/test/tax-calendar.test.ts`.
- **What an org chose:** `ludy_kernel.tax_profile`, one row per org. Owners and admins set it in Settings, "Lịch thuế" (`kernel.tax_profile.save`, R1, audited). It holds:
  - the obligations that apply;
  - the PIT withholding frequency;
  - the last month of the fiscal year.

  The VAT return follows the VAT filing period chosen just above it (#318).
- **Done marks:** `ludy_kernel.tax_obligation_done`, at most one per obligation and period. Owners, admins and members mark an obligation done or take the mark back (`kernel.tax_obligation.done` and `.undo`, R1, audited). A period of another frequency is refused (`TAX_PERIOD_MISMATCH`).
- **Who sees the button (#1917):** each due row of `kernel.org.overview` lists its open legal entities with `canMark`, the server's answer to whether the reader may mark it done there. It applies the same rule as the mark: owners, admins and members for most obligations, and, for the VAT return with finance on, the filers of that entity. The Overview and the multi-client home show the button only where `canMark` is true. `kernel.tax_obligation.done` and `.undo` apply the same rule, so with finance on they refuse the VAT return to a member who is not a filer (`FORBIDDEN`).
- **The VAT return with finance on (#1400):** its mark goes through `finance.vat.return_mark` (owners and admins, and a chief accountant for the entity, #1508), which records the return as filed with [22], [25] and [43] (Ludy's own working when marked from the calendar) and writes the same done mark in the same transaction, so the next period's [22] starts from that [43]. See [htkk-01gtgt-xml.md](htkk-01gtgt-xml.md).
- **What the screen lists:** `kernel.org.overview` `taxDues`, read in each org's own context (`packages/kernel/src/tax-calendar.ts`). It holds:
  - what is due from today to 30 days ahead;
  - what is overdue and not marked done, back to the day the org first saved its calendar and at most a year.

  An org that just set its calendar is not shown a year of returns it filed elsewhere. Without a saved calendar, only the VAT return is listed.

## The table

A due date on a Saturday, a Sunday, a public holiday or the compensatory day off of a holiday that fell on a weekend moves to the next working day (Decree 252/2026/NĐ-CP, Article 3(7), pages 7-8 of the signed text: when the last day of a filing or payment deadline falls on a day off, the last day is the working day right after it; before 2026-07-01 the Civil Code 2015, Article 148(5)). The VAT return uses the same function (`packages/kernel-contract/src/deadline-day.ts`) and the shared holiday calendar (`holidays.ts`): the fixed dates every year, and Tet and the Hung Kings day for 2026 to 2028. A holiday on a Saturday or a Sunday has its compensatory day off on the next working day (Labor Code 45/2019/QH14, Art. 111(3); it assumes the Saturday and Sunday week of a state agency, Decision 188/1999/QĐ-TTg Art. 1, read in a secondary copy only with its present validity unconfirmed, since Art. 111(2) leaves the weekly rest day to the employer: compensating a Saturday holiday is an inference): 1 May 2027 is a Saturday, so Monday 3 May 2027 is off and a deadline on 30 April 2027 is Tuesday 4 May. The compensatory days are a separate list used by the deadline rule only. The government also fixes the exact days of Tet and National Day each year (Art. 112(3)) and may arrange the days around them differently, and the calendar does not carry those, so a day it lacks shows an earlier date than the real one (the safe side). A day it lists wrongly shows a later one: the 2027 table is uncertain until the accountant confirms it (#2520).

| Obligation | Frequency | Due | Legal basis (as recorded) |
|---|---|---|---|
| VAT return (`vat_return`) | month | 20th of the next month | Decree 252/2026/NĐ-CP, Art. 10(2), from 2026-07-01; before that Law 38/2019/QH14, Art. 44(1)(a) |
| | quarter | last day of the first month of the next quarter | Decree 252/2026/NĐ-CP, Art. 10(3); before that Law 38/2019/QH14, Art. 44(1)(b) |
| PIT withholding return (`pit_withholding`) | month or quarter, per the org | as the VAT return | Decree 252/2026/NĐ-CP, Art. 10(2) and (3); before that Law 38/2019/QH14, Art. 44(1) and Decree 126/2020/NĐ-CP, Art. 8 and 9 |
| Provisional CIT (`cit_provisional`, a payment) | quarter of the fiscal year, quarter began before 2026-07-01 | 30th of the first month of the next quarter | Law 38/2019/QH14, Art. 55(1) |
| | quarter of the fiscal year, quarter began on or after 2026-07-01 | last day of the first month of the next quarter | Decree 252/2026/NĐ-CP, Art. 24(2) |
| CIT finalization (`cit_finalization`) | fiscal year | last day of the third month after the fiscal year | Decree 252/2026/NĐ-CP, Art. 10(5)(a); before that Law 38/2019/QH14, Art. 44(2)(a) |
| PIT finalization (`pit_finalization`, the employer's) | calendar year | last day of the third month after the year | Decree 252/2026/NĐ-CP, Art. 10(5)(a); before that Law 38/2019/QH14, Art. 44(2)(a) |
| Annual financial statements (`financial_statements`) | fiscal year | 90 days after the fiscal year ends | Law 88/2015/QH13, Art. 29(3); Circular 99/2025/TT-BTC, Art. 25; Circular 133/2016/TT-BTC, Art. 80(1); Circular 58/2026/TT-BTC, Art. 10(1) for micro enterprises |
| Business license fee (`license_fee`) | calendar year, 2020 to 2025 | 30 January of the year | Decree 139/2016/NĐ-CP, Art. 6(3), amended by Decree 22/2020/NĐ-CP; abolished from 2026 by Resolution 198/2025/QH15 |

Law 108/2025/QH15 took effect on 2026-07-01 and replaced Law 38/2019/QH14; it leaves the filing deadlines to the Government, which set them in Decree 252/2026/NĐ-CP (Art. 10 and 24). Every date above is the same under both laws except the provisional CIT, which moved from the 30th to the last day of the month, so that obligation has a row per law, split by the first day of the quarter. A quarter that began before 2026-07-01 keeps the 30th even where its payment falls after the change: the earlier date, so the date shown is never later than the real one (the transition rule for it is not read). The 30 April deadline of Art. 10(5)(c) is for an individual who files their own wage-income finalization, not for an org, so it has no row. The Art. 24(3)(a) rule that four provisional quarters must reach 80% of the finalized tax is not modelled.

Read from the signed official text (Decree 252/2026/NĐ-CP, pages 21 and 48); the clauses of Art. 10 and 24 were checked on the page images. Law 88/2015/QH13, Circular 99/2025/TT-BTC and Circular 133/2016/TT-BTC were read once, from copies that are not the signed scan; Circular 58/2026/TT-BTC, Art. 10(1) twice.

How periods are named:

- A fiscal year is named by the calendar year it ends in. With the year ending in March, fiscal year 2027 runs from April 2026 to March 2027.
- Its quarters are numbered from its first month, so "2027-Q1" is April to June 2026.

## Not covered, and unconfirmed

- **Not covered:**
  - Compensatory days off and the extra days the government sets each year, and extensions (gia hạn).
  - Returns filed per event rather than per period (on cessation, on a change of ownership).
  - The obligations of household businesses.
- **Law 108/2025/QH15 (from 2026-07-01):** it replaces Law 38/2019/QH14 (see htkk-01gtgt-xml.md); the table cites Decree 252/2026/NĐ-CP for the periods from that date (see above). Whether the accountant reads the transition the same way is **unconfirmed**; that is question 1 below.
- **Every line is `confirmed: false`,** and the screen says the table is not confirmed yet.

## Questions for the partner's accountant

1. Do the deadlines above still hold for periods from July 2026 under Law 108/2025/QH15 and Circular 89/2026? Which articles should the table cite instead?
2. Is the provisional CIT due on the last day of the first month of the next quarter (Decree 252/2026/NĐ-CP, Art. 24(2)) for every client, including the second quarter of 2026? How do you track a client whose fiscal year is not the calendar year?
3. Is 90 days after the year end the right deadline for the financial statements of your clients (30 days for a sole proprietorship)? Do you treat it as the same day as the CIT finalization?
4. Should the calendar add other recurring obligations your clients have, such as the land rental fee, the environmental fee, or the statistics reports?
5. With the license fee abolished from 2026 (Resolution 198/2025/QH15), is there anything left to file for it?
6. When a public holiday falls on a Saturday (1 May 2027 is one), does the tax authority give the Monday as a compensatory day off, so that a deadline on 30 April 2027 is Tuesday 4 May? The code assumes the Saturday and Sunday week of state agencies (Decision 188/1999/QĐ-TTg Art. 1, a secondary copy, validity unconfirmed) and Labor Code Art. 111(3); the exact days around Tet and National Day come from the Prime Minister's yearly decision (Art. 112(3)) and are not in the table. Please confirm against the notice you use each year, and for 2027 (#2520).
