# Sync with the firm's accounting software: MISA AMIS, MISA ASP, Fast (2026-11-18)

Owner request, 2026-11-18: once the current work is done, make Ludy sync with MISA ASP, MISA AMIS Kế toán, Fast and
other common Vietnamese accounting software. This plan extends M2-5 and decision D10 of
[backlog-review-2026-10-17.md](backlog-review-2026-10-17.md): Ludy works alongside the firm's system of record and
feeds it, it does not replace it.

## What exists

Ludy exports vouchers as Excel files in MISA SME's own import templates, seven of them. See
[misa-sme-import.md](../integrations/misa-sme-import.md):

- purchase services;
- purchase goods into stock;
- sales;
- cash receipts and cash payments;
- bank credit notes and bank debit notes.

The acceptance of #317 (the partner imports once successfully) is still waiting on a person.

## What the research found

Sources and the date read are in the research notes this plan summarizes. Each source was marked first-party or
third-party, and anything not confirmed is marked unconfirmed.

### MISA AMIS Kế toán

**Public API: confirmed and documented.** The documentation is at
[developer.misa.vn, product AMISKT](https://developer.misa.vn/products-openapi/AMISKT), version 1.0.0, 05/08/2026.

- It creates 19 voucher types. Every type Ludy exports to MISA SME is among them:
  - purchase of services, and purchase of goods into stock;
  - sales;
  - cash receipts and payments;
  - bank receipts and payments.
- It reads and creates parties, items, warehouses, bank accounts and units. It reads the chart of accounts but cannot change it.

**Access.**
- Every call needs a `ClientID` that MISA issues once it approves a product registration on the developer portal. The registration needs a business registration certificate.
- Each customer then generates their own `access_code` in AMIS and switches on "Cho phép đẩy dữ liệu từ phần mềm khác qua kết nối API" ([help page](https://helpact.misa.vn/kb/lap-chung-tu-hach-toan-tu-du-lieu-ket-noi-voi-cac-ung-dung-khac-qua-api/)).

**Flow.**
- Processing is asynchronous. The result goes to a callback the integrator hosts, signed with the `ClientID` as the key, with a polling fallback.
- A voucher holds at most 500 lines.
- A pushed voucher arrives as a request ("đề nghị sinh chứng từ") that a person in AMIS turns into the voucher. That matches Ludy's rule that a person approves what goes into the books.

**Not published:** pricing, rate limits, and whether a partner contract is needed. The token lifetime is also unclear: the
documentation says both 12 and 24 hours.

**Excel import: confirmed.** In AMIS, "Nhập từ Excel" offers per-voucher-type templates with column mapping. The
templates download only inside the product, so their headers are not known yet.

### MISA ASP

**What it is.** A platform that connects businesses with accounting service firms. Its homepage on 2026-11-18 reads:
- 91,843 businesses;
- 16,001 household businesses;
- 14,984 accounting service firms and tax agents.

**API: confirmed.** ASP has the same Open API as AMIS, under `/asp/v1/`, with the same `ClientID` requirement. Its catalogues are read-only, so Ludy must match the firm's existing parties and items rather than create them.

**Competitor or target: both.** ASP is a target to feed. MISA also runs its own AI on e-invoice intake (AVA Kế toán), so ASP competes with Ludy's intake layer. No MISA feature that reads paper receipts or photos was found.

### Fast

Fast Accounting desktop, Fast Accounting Online and Fast Business Online:

- **API:** none public was found.
- **Excel import:** the Fast Accounting Online brochure confirms that vouchers can be imported from Excel, "including data sent in from elsewhere". The templates are not public.
- **Size:** 68,000 to 70,000 customers, per the vendor.

### Others

- **BRAVO:** an ERP for larger firms, integrated per project. No public API and no public import format. Not a fit for SMEs.
- **1C:** OData REST on the platform. Not confirmed for 1C Vietnam's local versions.
- **KiotViet:** a public API. It is a source of sales data, not a system of record.
- **Sapo:** its API sits behind a partner sign-in, so it is unconfirmed.
- **Effect, SAS Innova, Smart Pro, Base:** nothing confirmed.

**Market share:** no independent figures exist. Vendor claims put MISA first and Fast second.

## What belongs in open source and what in Crove Cloud

- **Ludy, open source, with no vendor approval:** Excel exports in another product's import template. AMIS and Fast fall here once a person obtains the real template files.
- **Crove Cloud, a private connector:** the AMIS and ASP APIs.
  - The `ClientID` is issued to one registered company (DOS) and is a secret. It also signs the callbacks, so it cannot ship in an AGPL repository.
  - The callback needs a public address.
  - Each customer's `access_code` would be stored sealed, under the customer's subject key, as the supplier bank numbers are.
  - Ludy's core keeps the voucher model and the "what would be sent" preview. The Cloud connector does the push.
  - This follows AGENTS.md: anything DOS-specific belongs in the private Crove Cloud layer.

## The AI part (product gate)

AI never decides what is sent:
- The accounting coworker checks a batch before export or push, and names what the target product will refuse: a missing party code or item code, a VAT rate code the product does not accept, or an account that is not in the firm's chart. AMIS's chart can be read through the API.
- It explains each problem in plain Vietnamese.
- Deterministic checks decide.
- A person sends.
- With AI off, the export and the push still work.

## Build order

| Step | What | Where | Blocked on | Milestone, priority |
|---|---|---|---|---|
| 1 | Keep the MISA SME exports; finish #317's acceptance (one real import by the partner) | Ludy | the partner's accountant (#61) | M2, P0 (as now) |
| 2 | AMIS Kế toán Excel export for the 7 voucher kinds Ludy already exports to MISA SME, sharing the MISA SME mappers where columns match | Ludy | the 7 AMIS template files, downloaded by a person with an AMIS account (a trial account is enough) | M3, P2 |
| 3 | Register a product on developer.misa.vn for AMIS Kế toán and MISA ASP, and ask MISA in writing about fees, rate limits and whether a contract is needed | owner | the owner: an account, the business registration certificate, an approval wait of unknown length | M3, P2, `owner-action` |
| 4 | AMIS API connector: push the vouchers as "đề nghị sinh chứng từ", read results by callback with a polling fallback, match parties and items | Crove Cloud | step 3 | M3, P2 |
| 5 | MISA ASP API connector: the same, against ASP's read-only catalogues | Crove Cloud | step 3 | GA gate, P2 |
| 6 | Fast Excel export | Ludy | the real Fast import templates (a firm or the partner on Fast) | Icebox, P3 until a pilot firm uses Fast |
| 7 | BRAVO, Effect, SAS Innova, Smart Pro, Base, 1C, KiotViet | none | not a fit, or nothing confirmed | Icebox, P3 |

Steps 2 and 6 follow the MISA SME pattern exactly:
- one mapping array per template;
- a golden header test;
- a route and button per voucher kind;
- an audit format per export.

No new kernel surface is needed. Step 4 needs a design of its own: the sealed `access_code`, the callback endpoint in
Cloud, idempotency through MISA's own reference field, and how a refused voucher shows in Ludy.

## Decisions for the owner

1. **Which software does the pilot partner use?**
   - If it is AMIS or ASP, steps 2 to 4 move ahead of other M3 work.
   - If it is MISA SME, as #317 assumed, the order stays as above.
   - Recommendation: ask the partner. Until then, keep the order above.
2. **Register on MISA's developer portal (step 3)?**
   - Only the owner can do it, because it needs the company's account and documents.
   - Recommendation: yes, now. It is the slowest step and costs nothing to start, as far as the public pages say.
   - Without it, the API connectors (steps 4 and 5) cannot start, and the Excel exports still work.
3. **Who gets the AMIS templates (step 2)?**
   - Recommendation: the partner's accountant, if they use AMIS. Otherwise the owner, on a free AMIS trial.
   - Without them, step 2 waits.
