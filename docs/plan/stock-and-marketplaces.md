# Stock, cost of goods sold and marketplace orders for small sellers and household businesses: plan

> Plan for [#2499](https://github.com/DOS/Ludy/issues/2499), 2026-11-03. The owner widened the scope the same day in the Accounting PO chat: household businesses (hộ kinh doanh) sell mostly on Shopee, TikTok Shop and Lazada and need stock badly, so stock is fed by marketplace orders, payouts are matched against the bank, and the household business case (the books and declarations Circular 152/2025 asks for) is a kind of client; integrations live in the "Tích hợp" section of [einvoice-issue.md](https://github.com/DOS/Ludy/blob/main/docs/plan/einvoice-issue.md) with the seller's own credentials sealed. Design only: nothing here is built, no money is spent, no account was created, no credential was used, no API was called. Every fact about a platform or a rule comes from public pages read on 2026-11-03 and carries where it comes from and how sure it is. The decision record is [ADR-0045](../adr/0045-stock-and-marketplace-orders.md); a Vietnamese summary for the owner is [stock-and-marketplaces.vi.md](stock-and-marketplaces.vi.md). Not legal advice: the accountant (#61) confirms the rules of section 5.

## 1. Goal

A small business that sells goods must know what it has, what each sale cost it and what the platforms still owe it. Ludy today reads purchase and sales invoices and has goods codes for the MISA export (#1398), but no item, no quantity on hand and no cost of goods sold (accounts 156 and 632).

After this plan a one-person company or a household business can, in Kế toán:

1. keep a list of goods (code, name, unit, the sales channels' SKUs) and see what is on hand, from the purchase invoices Ludy already reads;
2. drop the order report and the income report it downloaded from Shopee, TikTok Shop or Lazada into the Inbox, check what Ludy read and confirm it once: stock goes down per shipped line, returns put it back, and revenue, fees and tax withheld by the platform are booked per payout;
3. see the payout in the bank statement matched to the platform's balance, so "what Shopee still owes me" is a number;
4. close the month: Ludy proposes the cost of goods sold, one entry, and a person approves it; the stock report (nhập xuất tồn) and the stock card come out per item;
5. count the stock and post the differences;
6. for a household business, get the books of Circular 152 (S1a, S2a, S2b, S2c, S2d, S2e) as spreadsheets, derived from the same entries;
7. let the finance coworker say what it cannot match, what is running low and draft the reorder message, for a person to approve.

The marketplace APIs come later, through the same "Tích hợp" section, only where a seller can connect itself or after the owner has registered Ludy as a partner (section 10).

## 2. What the owner decided

- 2026-11-03: #2499 is widened to marketplaces and the household case, and it comes right after #2497 (the Accounting PO's note on the issue).
- 2026-11-03 (the Accounting PO, on the Shopee finding): the first slice is the file path that works for every seller; the API connectors need Ludy registered as a marketplace partner and are an owner decision listed in the plan, not a build step.
- The household research note [household-business-2026.md](../research/household-business-2026.md) (2026-10-18) recommended no product sold directly to household businesses. This plan follows the owner's newer direction. Its facts are used and updated here (section 5); its warning stands: the tax side of a household is mostly served by the state's eTax Mobile and by the till vendors, so what Ludy adds is the stock, the platform reconciliation and the books for the households that pay tax on income.

## 3. Fit, and the AI part

- **Fit (AGENTS.md gate).** A seller does stock, the month's cost of goods and the platform payouts every month. One-person companies and household businesses are the target; several warehouses, lots and manufacturing are not (section 9).
- **Smallest slice.** One person, one warehouse, the defaults: weighted average per month, one currency, no setup but the items (which the first import can create from its lines).
- **AI part, named.** The finance coworker, in the stock and orders screens: (a) matches invoice and order lines to items and says why, learning from corrections; (b) proposes the mapping of a report header the platform profile does not know; (c) flags items running low and drafts the reorder message to the supplier. Model calls go through `metered()` under new `AI_FEATURES` keys (`finance.stock_match`, `finance.stock_columns`, `finance.stock_reorder`) and the AI budget page; the core works with AI off; code decides every number and a person approves every posting and every message. No coworker name appears in strings or stored data (`{finance}`).

## 4. What exists today

| What | Where | Use here |
| --- | --- | --- |
| Purchase and sales documents with lines (`description`, `unit`, `quantity`, `unit_price`, `debit_account` or `credit_account`), direction `purchase` or `sale`, proposals, approval | `crove_finance.purchase_document`, `purchase_line`, `finance.purchase.record` | the source of stock-in and stock-out from invoices |
| Goods codes for the MISA goods-purchase export | `misa-goods-codes.ts` (#1398) | stays; an item's code can feed it |
| Learned per-line account rules with provenance | `categorization.ts` (#1399) | the model for learned item aliases |
| Bank lines, the staged statement import, matching and its suggestions | `bank.ts`, `bank-statement-file.ts` (#2142), #2385 | the model for staged report import; payouts matched to the platform's balance |
| The books regime of a legal entity (`tt133`, `tt99` charts) and the period lock | `legal_entity_books` (20261103020000), `period-lock.ts` | the household kind sits on top; month close respects the lock |
| Connections, sealed credentials, `external_call`, egress guard | ADR-0025, ADR-0044 | the `marketplace` connection kind |
| Sandbox parser, evidence files, the Inbox | `crove-extract`, ADR-0013, ADR-0018 | new document kinds for the two reports |
| TT133 chart: 151, 152, 153, 155, 156, 157, 632, 6421; TT99 chart without 611 and 631 | `crove_finance.account`, `chart_account` | postings use the entity's chart |

There is no item, no quantity, no `channel_order`, no settlement and no household profile.

## 5. The rules a design must encode

Confidence: **[primary]** the primary text was read; **[gov]** a government policy site; **[commentary]** vendor, law-firm or news pages; **[unverified]** not found. Only Circular 152 could be read in primary text (its Official Gazette PDF has a text layer); the rest are commentary, as with the e-invoice rules. The accountant (#61) confirms each row before the build that depends on it merges.

| # | Rule | Source and confidence |
| --- | --- | --- |
| 1 | **Which regime.** Circular 99/2025/TT-BTC (in force 2026-01-01) replaced Circular 200/2014; it did **not** replace Circular 133/2016. A small or medium enterprise may adopt TT99 (Art. 31) or stay on TT133; once TT99 is chosen it is kept at least one fiscal year. A draft that replaces TT133 (22 accounts, planned for 2028) is a draft. Circular 58/2026 is for micro enterprises. | commentary (luatvietnam, thoibaotaichinh); Art. 31's clause number differs between sources, unverified |
| 2 | **Accounts.** TT99 drops 611 and 631 and renames 155 to "Sản phẩm"; 151, 152, 153, 156, 157, 632 and the provision 2294 stay; TT133 still has 611 and 631. Ludy's charts already hold both regimes. | commentary (AMIS); the repo's charts |
| 3 | **Standard postings, perpetual.** Buy: Dr 156 (152, 153), Dr 133, Cr 111, 112, 331; invoice before the goods: Dr 151, then Dr 156 / Cr 151; VAT not deductible goes into cost. Sell: Dr 632 / Cr 156 at issue cost; Dr 131 / Cr 511, Cr 3331. Purchase return: Dr 331 / Cr 156, Cr 133. Sales return: Dr 156 / Cr 632. Count shortage within the norm: Dr 632 / Cr 156; a person at fault: Dr 138 (1388) or 334; cause unknown: Dr 138 (1381) / Cr 156. Count surplus and the provision postings were not found in a readable source. | commentary (MISA, AMIS); surplus and provision unverified |
| 4 | **Cost methods.** VAS 02 allows specific identification, weighted average and FIFO (LIFO is gone from Circulars 200, 133, 99 by commentary); TT99 adds retail and standard cost; the method is kept consistent. The weighted average may be computed after each receipt or at month end (MISA supports both). | VAS 02 part [primary]; the rest commentary |
| 5 | **Household goods book.** For the household on the **income method** (group 3) the goods book S2d-HKD is required and records quantity and value in, out and on hand per item; the cost is the **weighted average per item for the period** (opening value + value in) / (opening quantity + quantity in), the purchase price from the purchase voucher. Groups 1 and 2 need no stock book. | **primary**: Circular 152/2025 Art. 6; whole-period versus moving average to confirm |
| 6 | **The household books.** Circular 152 (issued 2025-12-31, in force 2026-01-01, replaces 88/2021) sets books by tax method, with no revenue threshold in the circular: group 1 (no VAT, no PIT) S1a-HKD; group 2 (VAT and PIT as a percentage of revenue) S2a-HKD, revenue by business line with VAT and PIT per line; group 3 (VAT on revenue, PIT on income) S2b (revenue by line), S2c (revenue and expense detail, with the expense groups), S2d (goods), S2e (cash and demand deposits, optionally per bank); group 4 (other taxes) S3a in addition. Records may be paper or electronic, kept at least 5 years; the household may add books or change forms if each keeps its name, date opened and the representative's name and signature; where the tax system notifies the tax, the books are used to reconcile with it. Source documents: invoices, purchase lists (bảng kê mua hàng) where the seller has none. | **primary**: Circular 152/2025 Art. 2 to 7 |
| 7 | **Groups and thresholds.** Lump-sum tax ended 2026-01-01 (Resolution 198/2025/QH15). Decree 68/2026 (2026-03-05) set the regime; Decree 141/2026 (2026-04-29) raised the 500 million threshold to 1 billion VND a year (probably retroactive to 2026-01-01; the government page gives no date). Up to 1 billion: no VAT or PIT, a yearly revenue report (01/TKN-CNKD, by 31 January; a new household twice). 1 to 3 billion: PIT on a percentage of revenue or on income at 15%, the choice held two years. Above 3 billion: income method, rates quoted 15, 17 and 20%. VAT and PIT quarterly (monthly above 50 billion). Percentages by line quoted as goods 1% and 0.5%, services 5% and 2%, catering and construction with materials 3% and 1.5%, other 2% and 1%. Forms 01/TKN-CNKD, 01/CNKD under Circular 89/2026, earlier 18/2026 and 50/2026; which is current is unverified. | commentary and one government excerpt (xaydungchinhsach.chinhphu.vn); the percentage table and the over-50-billion rate are unverified, sources conflict |
| 8 | **E-invoices of households.** Decree 254/2026 and Circular 91/2026 (from 2026-07-01): mandatory above 1 billion VND a year, tax-coded or a cash-register invoice connected to tax data (Decree 68 Art. 8(5) as amended); at or below 1 billion voluntary; a household in the mandatory group that sells on a platform still issues, and platforms supply transaction data. | commentary and a government excerpt; a free tool for all households is unverified |
| 9 | **Platform withholding.** Decree 117/2025 (from 2025-07-01, now carried in Decree 252/2026 Art. 43): a platform with **both** ordering and payment functions withholds, declares and pays VAT and PIT per successful transaction for household and individual sellers (not companies): goods 1% and 0.5%, services 5% and 2%, transport and services tied to goods 3% and 1.5%; withheld regardless of the threshold (refund or offset where the seller is exempt); the seller does not declare again the revenue and tax the platform did. Gross platform sales still belong in the seller's revenue book; the fees and the tax withheld are reconciliation items against the payout. | commentary; the last sentence is the survey's reading (Circular 152 Art. 3(4) says books reconcile with tax-notified data), not a rule read |
| 10 | **The seller's statement.** Shopee issues a yearly withholding certificate per shop; TikTok Shop offers certificates in Seller Center (Tài chính, Giấy tờ thuế) from 2026-04-01 and shows the tax under fees in each transaction; Lazada's per-transaction finance data carries `WHT_amount` and its semantics for Vietnam are unverified. | commentary (BigSeller, GHN); unverified at first party |
| 11 | **Stock books of an enterprise (TT133).** S06-DNN detailed ledger of materials, tools, products, goods; S07-DNN its summary; S08-DNN stock card; the voucher forms 01-VT, 02-VT, 05-VT are guidance, an enterprise may design its own; invoices stay mandatory by tax law. The book codes of TT99 were not found. | commentary (accgroup, Grant Thornton) |
| 12 | **Count, loss and destruction.** A count at the end of the fiscal year is required (Accounting Law 2015); a natural loss within the norm keeps the input VAT deduction, above it not (Decree 181/2025, amended by Decree 144/2026); destroyed stock is deductible at cost less provision plus destruction cost with the decision and the count record (Circular 20/2026 Art. 3(9)). The deadline to settle count differences and the norms by goods were not found. | commentary |
| 13 | **Internal transfers.** Moving stock between sites of one enterprise is not a sale (EY on Decree 254); a stock-issue-cum-transport note is still used (MISA, 2026-10-06); its content under Decree 254 is unverified. | commentary; matters only for several warehouses (section 9) |
| 14 | **Marketplace data limits.** Buyer personal data is masked by default and must not be kept more than about 90 days: Lazada states it in its security guide (personal data anonymized when no longer needed and at most 90 days, encrypted at rest; unmasked data needs a security review), Shopee's data protection policy is quoted by a partner (Clause 10.6, 90 days), TikTok Shop's review checklist asks for a retention schedule and deletion after the seller disconnects. Lazada's terms ask to destroy its content within 14 days of termination and keep audit trails 6 years. | first-party via mirror (Lazada), commentary (Shopee, TikTok Shop) |

Two further points to settle with the accountant, in the open points of section 11: whether TT99 still allows the periodic count method (two sources disagree), and the date a sale is recognized when the platform, not the seller, takes the money.

## 6. The three marketplaces

All three sources were read on 2026-11-03 from public pages only. The documentation sites of Shopee, TikTok Shop and Lazada are scripts that a reader tool could not open, so most facts come from search excerpts, third-party integration guides and, for Lazada, a public GitHub copy of the official documents dated 2026-04-21. **No row below is a first-party page read in full**; each is a pointer for the person who connects a real account (section 10).

| | Shopee Vietnam | TikTok Shop | Lazada Vietnam |
| --- | --- | --- | --- |
| Can a small seller connect its **own** app | Doubtful. A seller path exists ("Seller In House System", about 3 working days, IP whitelist to go live), but an unofficial FPT Shop article (undated) says Vietnam supports no individual third-party developer and self-connection is for Yêu Thích and Mall shops with their own developers; a partner needs a business licence and website, 1 to 2 weeks | Yes, by the seller (in-house) developer track, no store review, but the shop needs an **account manager** assigned and the verification email equal to the shop's; the docs call these the usual reason registration fails | Yes: a personal self-developed account (no business licence), app category "Seller In-house APP", approval hours to about a day; an app serves 20 to 60 authorized sellers |
| A shared app for many sellers | Partner registration | ISV track, a data security review of about 2 weeks and, for some markets, a compliance review of 3 weeks or more | ERP or ISV category (service market or login-user authorization), a security review for unmasked data |
| Authorization | OAuth, partner key and shop id, token about 4 hours, refresh about 30 days | OAuth, access token 7 days, refresh lifetime unclear, shop id and shop cipher | OAuth, access token 30 days, refresh 180 days (test app 7 and 14), a refresh token cannot be refreshed |
| Orders | order list (15-day window, 100 a page) and detail; statuses unpaid to completed, in cancel, cancelled; lines with item and model SKU, quantity, original and discounted price | order list (100 a page) and detail with line items (seller SKU, original price, platform and seller discount); full status list unverified | orders, order items (per item statuses), SKU and shop SKU, paid price, voucher by seller and platform |
| Returns | return list and detail | cancellations and returns endpoints; read schema unverified | reverse-order APIs; amounts in VND in Vietnam (cents elsewhere) |
| Money per order and per payout | per-order escrow detail (commission, service, transaction fee, shipping, vouchers, seller payout); no settlement-batch report and no certain wallet transaction list for Vietnam were found | finance statements, transactions by statement and by order (revenue, fees, shipping, taxes, refunds), payments and withdrawals; payouts differ from statements by reserves | payout statements (opening, closing, revenue, fees, refunds, payout, paid flag) and per-transaction fee lines with VAT and WHT; fee names are not documented |
| Stock | list and update (50 a call); multi-warehouse and fulfilled-by-Shopee stock unverified | update per warehouse, write scope | adjust sellable quantity by delta, multi-warehouse code, 50 a call |
| Push | live push with a callback and a way to fetch lost pushes; signed | webhooks for orders, returns, cancellations and more, signed, no replay protection, 3 second answer | push messages for orders, reverse orders, low stock, token expiry; certificate OV or EV; retries every 30 minutes up to 12 times |
| Buyer data | masked, deleted within about 90 days | masked unless the category is granted | masked by default, 90 days |
| What the platform gives for tax | yearly withholding certificate per shop | certificates in Seller Center, tax shown under fees | `WHT_amount` per transaction; no certificate found |

What this means for the design:

- **What a seller hands over** is never a password. For an app Ludy owns it is an authorization click, and Ludy seals the resulting tokens and the shop identifiers (ADR-0025); for an app the seller owns it also gives that app's key and secret, which Ludy seals the same way.
- **A seller of any of the three can download reports by hand**, so the file path works for everyone (section 7). The API path will work, from the survey, for Lazada and TikTok Shop sellers who register their own app, for Shopee only for Yêu Thích and Mall shops, and for all sellers of a platform only after Ludy is a registered partner there.
- Ludy self-hosted at a seller's own server fits the "seller in-house" model of each platform; Ludy Cloud serving many unrelated sellers is the ISV model with the heavier duties. Lazada's terms also prohibit "ERP, CRM or OMS back-end calls" for in-house apps, ambiguous for a self-hosted Ludy: ask Lazada (section 10).
- Buyer data never needs to enter Ludy: the books need the order number, the SKU, the quantity and the amounts. That is the design rule (ADR-0045 point 5) and it also removes the 90-day duty for the rows.
- Every platform needs the seller's server to call from a fixed address in at least one path (Shopee's go-live whitelist, Lazada's optional one): a self-hosted install has the address of the seller's own machine; a cloud install has Ludy's.

## 7. The report files a seller can download

A seller can download, by hand, an order report and an income or payout report from each of the three seller portals. What a reader could find about them on public pages is below; **no sample file was seen**, only help pages (first-party where marked) and vendor, community and open-source pages. Header names are listed as found. The Vietnamese header strings of most files could not be found, which is why the importer reads columns through a profile with synonyms and a confirmed mapping (section 8.4), and why the golden files of a real seller are a build prerequisite (section 10).

| | Shopee Vietnam | TikTok Shop Vietnam | Lazada Vietnam |
| --- | --- | --- | --- |
| **Order report**: where | Seller Centre, order management, all, export (no Vietnamese first-party page found); the file is named `Order.all` with the dates, xlsx | Orders, Manage Orders, Export Orders, then Export History; CSV or Excel (first-party, 2025-04-15) | Orders, All, Custom, Export all; xlsx (Thai vendor guide; no Vietnamese first-party page found) |
| Row | one row per product line; order-level amounts repeat on each line, so they are read once per order | SKU-level columns, so one row per line (inferred) | **one row per unit**, each with its own `orderItemId`; no quantity column |
| Columns seen | Vietnamese: "Giá ưu đãi", "Tổng số tiền người mua thanh toán", "Phí cố định", "Phí dịch vụ", "Phí xử lý GD", "Phí hoàn". Malaysian English of the same product: Order ID, Order Status, Return / Refund Status, Order Creation Date, Product Name, Variation Name, SKU Reference No., Original Price, Deal Price, Quantity, Product Subtotal, Seller Voucher, Shopee Voucher, Buyer Paid Shipping Fee, Grand Total | Order ID, Order Status, Order Substatus, Cancellation/Return Type, SKU ID, SKU Unit Original Price, SKU Subtotal Before Discount, SKU Platform Discount, SKU Seller Discount, SKU Subtotal After Discount, shipping fee columns, Order Amount, Order Refund Amount, Fulfilment Type, Warehouse Name, Tracking ID, Payment Method, Package ID, Purchase Channel; seller SKU, quantity and dates not in the first-party list | `orderNumber`, `orderItemId`, `status`, `createTime` ("30 May 2026 13:23"), `itemName`, `variation`, `sellerSku`, `lazadaSku`, `unitPrice`, `paidPrice`, `sellerDiscountTotal`, `platformDiscountTotal`, `shippingProvider`, `trackingCode`, `taxCode` and about 60 more including the buyer's name, phone, email and addresses (Thai seller's file) |
| Limits | not found | up to 40,000 orders per export (vendor, 2024) | not found |
| **Income report**: where | Finance, Revenue, Details, tab "Đã thanh toán", export (first-party, 2026-04-24); an Excel workbook, earlier exports under "Báo cáo của tôi" kept 6 months | Finance, Transactions, tab "Đã quyết toán", export, then the export history; xlsx (first-party excerpt); a vendor says files stay 24 hours | Finance, My Income, income report, a weekly or monthly statement, download: a summary PDF and a "Chi tiết giao dịch" Excel or CSV (vendor, 2025) |
| Structure | five sheets: Summary, Service Fee Details, Adjustment, Shipping Fee Discrepancy, Income; the Summary holds the shop, the bank account, the period and totals of goods, vouchers, shipping, fees and the VAT and PIT of Decree 117/2025; the Income sheet is **per order or per SKU** with order id, refund request id, order date, payment completion date, payment method, fees, vouchers, VAT and PIT per order | four sheets named by a vendor "Chi tiết đơn hàng", "Báo cáo", "Lịch sử rút tiền", "Giải thích về phí"; the US layout (statement id, payment id, order id, SKU, net and gross sales, referral and transaction fees, affiliate commission, shipping, adjustments, reserve) may not match Vietnam | per order item and fee line with the fee type, order number, order item number, amount, WHT, VAT, statement and paid status (the API's transaction details; the Excel's Vietnamese headers unverified); a wallet export separates "Auto Withdrawal" lines |
| Tie to the bank | per order, **not** per payout batch; the payout reference and the bank text were not found; the wallet balance report shares the order id | a payment id exists in the US layout; the Vietnamese bank text not found | a statement id groups lines into a payout; paid weekly or on the 15th, only after delivery (vendor); the bank text not found |
| Signs and notes | deductions are negative; the Income workbook starts with a Summary sheet and an older CSV had 17 rows above the table | refunds are negative (US guide) | 16-digit ids lose digits if a spreadsheet reads them as numbers; the sheet is named "sheet1" |
| **Returns** | no separate file; "Mã yêu cầu hoàn tiền", refunded amounts and the Adjustment sheet | its own export in Manage Return | no separate file found; refund lines in the finance export |
| **Tax statement** | tax shown per order; the yearly withholding certificate is issued electronically (path and format not found) | certificates from 2026-04-01 in Seller Center, Finance, Tax documents (format not found) | none found |

Points that shape the importer:

- **Read one row per line, but order-level amounts once per order** (Shopee and TikTok Shop repeat them); Lazada's row is one unit, so the quantity of a line is the count of rows of the same order and SKU.
- **Money columns are read as decimals from text**, with the sign convention of each platform's profile; an amount that does not parse stops the file with the row number, it is never rounded or guessed.
- **Ids are read as text**; a spreadsheet that already turned a 16-digit id into a number with lost digits is detected (a trailing run of zeros or an exponent) and refused with the reason.
- **Summary and notice rows above the table** are skipped by finding the header row (the browser statement import's header detection already does this for bank statements).
- **The platform's order id and, for Lazada, the order item id are the deduplication keys** of section 8.4; the Shopee income report's order id ties its lines to the order report.
- **The payout reference** is the one thing none of the three public sources could show; the matching of section 8.4 therefore uses amount, date window and the platform name in the transfer text first, and the reference only when a real bank line shows one (a real seller's bank line is part of the golden files, section 10).
- Layouts change: TikTok Shop's Vietnamese fee changed on 2026-05-09 and Shopee added the tax columns for orders completed from 2025-07-01; a profile is versioned data and a layout it does not know is a staged read with what it could not read, not a guess.

## 8. The design

### 8.1 Items and stock moves

`stock_item` per legal entity: code (unique per entity), name, unit, kind (`goods` first; materials and tools later), the stock account (156 by default, from the entity's chart), the **trade** the item is sold in (goods, services, catering, other; used by the household books and the percentages), an active flag. `stock_alias` maps a name a source uses to an item: the marketplace and its SKU, a supplier's description (normalized, as the categorization rules do), with provenance (who taught it, when, from which line). `stock_move` is append-only: item, date, signed quantity, the source (purchase line, sale line, order line, count, adjustment, return), the amount for a stock-in (the cost), the channel for an order, and the id of the entry or order that caused it. Quantity is a decimal string with the unit's precision; money is NUMERIC and decimal strings, never numbers.

Units: one base unit per item; a purchase in boxes converts through a factor on the alias (a carton of 12), shown and confirmed once.

### 8.2 Where moves come from

- **Purchase lines.** When a purchase proposal on a goods account is approved (`finance.purchase.record`), each line with a quantity becomes a stock-in if it matched an item; an unmatched line is listed under "Chưa gán hàng" and a person assigns it; assigning writes the move and teaches an alias. Nothing about the posting changes: the entry stays Dr 156 as today, the stock only mirrors it.
- **Sale lines.** The same for sales documents (a stock-out at the month's cost, taken at close).
- **Marketplace orders** (section 8.4): stock-out per shipped line, stock-in per returned line received.
- **A count** (`stock_count`, a header and lines of counted against book quantity): confirming it posts the differences as adjustment moves and a proposal for the entry (shortage to 632 within a norm the org sets, otherwise 1381 for a person to resolve; surplus to 3381; the accountant confirms the accounts).
- **Negative stock is allowed**: a marketplace order often arrives before the purchase invoice is entered. The item shows negative on hand with a warning; the month **cannot be closed** while any item is negative at month end; the fix is to enter the purchase, or a count adjustment.

### 8.3 Cost and the month close

`finance.stock.close_period` (R3, owners, admins and members who approve entries) for one month and legal entity: for each item the unit cost is (opening value + value in) / (opening quantity + quantity in), rounded in decimal to the money precision with the remainder on the last move so the total equals the opening plus in minus out; the cost of every stock-out of the month is set; one entry is proposed through the finance proposal path (Dr 632 / Cr 156 for goods out, reversed for returns in), listed per item in the proposal so a person can read it. A closed month's moves are not editable; an error found later is a correcting move in the open month (or a reversal of the closing entry while the period lock allows it). Before the close the screens show a **provisional** cost (the running average) marked as such. Moving average and FIFO are a later setting per entity, off for a closed year.

Reports: **Nhập xuất tồn** (opening, in, out, closing, quantity and value per item for a period) and the **stock card** (per item, move by move), with an Excel export of each. The detail books of TT133 (S06-DNN, S07-DNN, S08-DNN) and Circular 152's S2d are layouts of the same data; they are an export profile each, after the accountant has confirmed the columns.

### 8.4 Marketplace orders and payouts

**Orders.** A member drops the order report of a platform in the Inbox (or forwards it to the inbound address). The sandbox reads it (kind `marketplace_orders`), the staged read shows platform, period, orders, lines, how many lines matched an item, and what it could not read; **nothing is stored** until a member confirms, and the file's sender never chooses the legal entity or the platform (a platform profile is chosen by what the file's headers match and shown for confirmation). Confirming stores the orders once, deduplicated on (platform, order number, line), as `channel_order` and its lines (platform, order number, dates, status, SKU, quantity, amounts), **no buyer data**; a re-uploaded or overlapping report adds only what is new and updates a status forward (shipped to completed, shipped to returned), never backward. A line that matches an item moves stock at shipment; one that does not goes to "Chưa gán hàng". Cancelled orders before shipment move nothing.

**Income reports.** The same path for the income or payout report (kind `marketplace_income`), stored as a `channel_settlement` per platform and period with its lines per order (sales, discounts, commission, service and payment fees, shipping, the tax the platform withheld, refunds, the net) and the payout reference. The settlement is checked in code (the lines add up to the report's total; each order it names is known; the amounts are decimals) and **proposed** as one entry per settlement: Dr 131 (the platform, an organization party linked as the entity's marketplace counterparty in `crove_finance.marketplace_party`; the Accounting PO decided on 2026-11-08 against a party kind `marketplace`, which would have widened the kernel party kinds and every contact screen, while the intent, the platform as the counterparty of 131, is the same) / Cr 511 for the sales it paid for net of the seller's own discounts, with the fee and withheld-tax lines kept in the record. A person approves it; the order's revenue is the settlement's, not the shipment's (the accountant confirms the recognition point, section 11).

**The payout.** The bank line of the platform's transfer is matched by the bank matching of #2385 to the settlement (the amount, the platform's reference in the transfer text, the date window). Approving the match posts Dr 112 for the money received, Dr 331 (the platform) for fees already invoiced or Dr 1388 for fees whose invoice has not come, Dr 333 for tax the platform withheld and settled for the seller, Cr 131. The platform's own fee e-invoice then arrives as a purchase document as today (Dr expense, Dr 1331, Cr 331) and clears the 1388. A platform whose balance is not zero shows on the **Sàn** screen: sales awaiting payout, payouts received, fees awaiting an invoice, the difference.

**Why not one entry per order.** There are hundreds a month; the books record what the platform paid, which is the way the seller's tax and bank see it, and the order list keeps the detail.

### 8.5 The household business kind

`household_profile` (per legal entity and effective date): the tax group, the PIT method (percentage of revenue or income), the trades it sells in, whether it is registered for e-invoices, the representative's name for the book signatures. The thresholds, the percentages by trade, the account-to-S2c-group mapping and the form versions are **data with effective dates** in the repo (a seed table, edited by migration), because they changed four times in 2026 alone and the primary texts are not yet confirmed.

The entity keeps TT133 books underneath; nothing in the chart changes and a household user is never asked to pick an account (the defaults are made by the profile). The books of Circular 152 are views:

| Book | Built from |
| --- | --- |
| S1a-HKD | the sales listing: marketplace settlements and sale documents by date, description, amount |
| S2a-HKD | the same by business line (the item's trade), with VAT and PIT per line by the percentages in force |
| S2b-HKD | revenue by line, VAT per line |
| S2c-HKD | revenue and expense detail: expenses grouped by the account-to-group mapping (materials and goods, wages and insurance, depreciation, outside services, interest, other), each with its document |
| S2d-HKD | the stock moves per item, with the cost of section 8.3 |
| S2e-HKD | the cash and bank lines, per account |

Each exports as a spreadsheet laid out like the circular's form, with the household's name, date opened and a place for the signature; the household may adapt the forms as the circular allows. The **return worksheet** (01/CNKD: revenue by trade times the percentage, the PIT on income) is built only after the accountant has confirmed the forms, percentages and thresholds (section 10), and Ludy never files: the household or its accountant files through the tax portal or eTax Mobile.

A household of group 1 or 2 needs little of this: its stock book is optional and its return is prefilled by the state. The household screens show only the books its profile requires.

**Built so far (#2517, slice 1).** `crove_finance.household_profile` (per entity of kind household and effective date, append-only: a change is a later row, refused inside a locked period; a household-kind trigger runs after the row policy) and four global seed tables edited only by migration, each row with its effective date, source and status (`commentary` until the accountant confirms it, #2520): `household_threshold`, `household_trade_rate`, `household_expense_group_map`, `household_form_version`. No rate, threshold or group is a constant in code: `finance.household.rules` reads the row in force on a date (the latest at or before it per key, so a new dated row changes the periods from its date and none before) and says when a row is still `commentary`. The books a household keeps follow its PIT method, not its group number (a household in the middle band may choose its method): none keeps S1a, a percentage of revenue S2a, income S2b to S2e (`finance.household.profile_get`); group 4 and S3a come with their own slice. **S1a-HKD** (`finance.household.s1a`, `GET /api/export/household-s1a.xlsx`, audited by `finance.household.export`) is a view of the ledger, not a second record: one row per entry that touched account 511 and its sub-accounts in a month, quarter or year, so its total equals the ledger's movement of 511 by construction (a sale and its settlement are the same entry, never counted twice); it is refused for an entity whose profile, on the first and the last day of the period, does not require S1a. The screen "Sổ hộ kinh doanh" (`/o/$slug/household`, reached from Settings, Pháp nhân, for an entity of kind household; no menu item) shows the profile form (owners and admins), the books the method requires, the notice that the rules wait for the accountant, and S1a with the Excel download. Still to build: S2a and S2b (with VAT and PIT per line from `household_trade_rate`, only after #2520 confirms rows 6 and 7), S2c, S2d and S2e (they need #2516's settlement entries and #2513's cost), group 4 (S3a), and the 01/CNKD worksheet (#2518).

### 8.6 The finance coworker's part

All proposals, all checked by code, all confirmed by a person; each under `metered(...)` and the finance AI budget.

- **Matching** (`finance.stock_match`): for lines the deterministic chain (code, alias) did not match, the model sees the normalized description, the unit and the list of item names and codes (never amounts or party data) and answers one item and a one-line reason, or none. The answer must be an item of the list; it is shown as a suggestion and never moves stock until a person confirms; a confirmation teaches an alias.
- **Columns** (`finance.stock_columns`): for a report header the profile does not know, the model sees the header texts and a few masked sample values (no buyer fields: the profile's allow-list decides what is ever shown) and proposes which standard field each is. A person confirms; the mapping is stored per org and platform and applied by code afterwards.
- **Running low and reorder** (`finance.stock_reorder`): code finds items whose on-hand covers fewer days than the lead time the org set (default 14), from the average weekly sales of the last 8 weeks; a Home item "Hàng sắp hết" lists them; the coworker words a reorder message to the supplier of the last purchase, with the quantity and the item names **given to it**, and the message is refused if it contains a figure it was not given (the rule of the payment reminder wording). The message is a draft for a person to send; Ludy never orders.
- AI off: the lists, the mappings by profile, the alias teaching and the low-stock item work; the suggestions and the wording are absent.

### 8.7 The marketplace connection kind

A `marketplace` card in the "Tích hợp" section of [einvoice-issue.md](https://github.com/DOS/Ludy/blob/main/docs/plan/einvoice-issue.md) (section 7): the list of platforms whose adapter is enabled, connect (the seller authorizes an app, or enters its own app key and secret where it owns the app), test, status (last call, last failure kind, orders waiting), disconnect. The port `MarketplaceProvider` (`testConnection`, `listOrders` since a cursor, `orderFinance`, `listStock` for the later reconciliation, never an update call), capability data per platform (limits, window, rate), an offline provider in-process that serves recorded orders, and a job that polls with the platform's push as a hint and **writes through the same staging as the files** (so a member confirms the first import of a platform, then an org may let confirmed profiles import on their own, as a setting). A real adapter is built per platform only as in section 6 and section 10; until then the section lists the platform greyed with "nhập file báo cáo".

## 9. What waits, and why

- **Several warehouses and transfers between them.** Needs a warehouse on every move, per-warehouse cost and the transfer note of rule 13 (unverified). A column with a default can be added without a rewrite.
- **Lots, expiry, serial numbers.** Food and cosmetics sellers need them; a first-in-first-out issue and an expiry alert. After the first pilot.
- **Manufacturing** (bill of materials, work in progress, accounts 154 and 155): a different customer.
- **Moving average and FIFO** per entity.
- **Stock write-back to the platforms**: a wrong number stops sales or oversells; it needs an owner decision and the platforms' write terms (Lazada's are silent on write-back; the rest unverified).
- **Retail method, standard cost, the periodic count method** under TT99.
- **TT99 posting templates** for stock: the entity's chart decides the accounts, and no entity can keep TT99 books before the accountant checks the templates (#1403).
- **A cash-register or point-of-sale feed**: Ludy is not a till (backlog review).
- **The return worksheet 01/CNKD** and anything filed with the tax authority: after the accountant confirms the forms.

## 10. What needs a person who is not an agent

| Who | What | Why |
| --- | --- | --- |
| The accountant (#61) | Read the rules of section 5 against the primary texts, above all: rows 1, 4, 5 (whole-period or moving average), 7 (Decree 141 date, bands, the percentage table by trade, forms), 9 and 10 (what the platform withholds and the statement the seller gets, how withholding and fees are booked), 11 (book codes under TT99), 12 | none of them was read in primary text but Circular 152; builds 2, 5 and 6 do not merge before |
| The accountant | Confirm the accounts of section 8.4 (131, 331, 1388, 333, the selling expense), the revenue recognition point and the count postings | the posting of a platform's money is the part most likely to differ from the plan |
| A real seller on each platform | Export, with every buyer column removed, one order report and one income report (a month with a return, a voucher and a withheld tax) from Shopee (the `Order.all` file and the income workbook, all five sheets), TikTok Shop (the order export, the settled-transactions export with its four sheets, the withholding certificate if there is one) and Lazada (the order export, the transaction details and the wallet export), **and the matching line of the bank statement for each payout** (its text is what ties a payout to a report), and add them to the golden files. The fastest check is the header rows of each sheet | the importer is built and tested on these; without them it is guesswork (builds 4 and 5) |
| A real Vietnamese household seller | Try the platform's own-app registration: Shopee (open.shopee.com console, country Vietnam, "Shopee Seller": which category appears), TikTok Shop (seller in-house developer, ask Seller Center for an account manager), Lazada (personal self-developed account): what is asked, how long, what it costs | the survey could not settle who can connect; the answer decides which adapters are worth building |
| The owner | **Decision: register Ludy as a partner on each marketplace**, so one app serves every seller. What each needs from the survey: Shopee a business licence, a website and a trial account (1 to 2 weeks per an unofficial source); TikTok Shop an ISV account, a data security review (about 2 weeks) and perhaps a compliance review (3 weeks or more); Lazada the ERP or ISV category and the security review for unmasked data; Lazada may add fees on 7 days' notice, no fee was seen on any platform; each needs a legal entity that signs the developer terms, an HTTPS callback, in some cases encryption evidence. The build waits for this decision | an agent cannot sign terms or give a licence; a published app is Ludy Cloud's, and a self-hosted install keeps the seller's own app |
| The owner or the Accounting PO | Ask Lazada Partner Support whether a self-hosted install calling the API counts as the prohibited ERP back-end, and whether a shared app must pass the security review | the terms are ambiguous |
| The owner | Decision on the uploaded export's retention (ADR-0045 point 8): delete after 90 days (the default) or keep as evidence | tax record-keeping against the platforms' 90-day rule |

No agent registers an app, signs terms, uses a seller's credentials or calls a platform's API with a real account; adapters are tested on recorded responses.

## 11. Risks and open points

- **The report layouts are unverified** (section 7). A profile built from a help page that is wrong breaks at the first real file; the importer shows what it could not read and stores nothing, and the golden files from real sellers are the cure.
- **The platforms change their reports** without notice. Profiles are data with a version, header detection tolerates reordering and Vietnamese or English headers, and the coworker proposes the new mapping.
- **Revenue recognition for platform sales** (at shipment, delivery or payout), and the platform as the party that takes the money, are for the accountant. The design posts at the settlement and keeps the shipment in the stock report; if the accountant wants revenue at delivery, the posting moves to the delivery without a schema change.
- **Fees posted twice** if a platform's fee invoice and its statement both reach the books. The plan posts fees at the payout against 331 or 1388 and lets the invoice clear 1388; a test with both orders of arrival is part of build 5.
- **Withholding for companies.** Decree 117 withholds for household and individual sellers only; a company seller is not withheld on. The settlement record keeps the tax line, and the posting uses it only for the household profile.
- **Whether TT99 still allows the periodic count method** (two sources disagree) and the cost method default: the plan implements perpetual quantities with a monthly cost, which both readings allow.
- **A seller's own e-invoice and the platform's data.** A household above 1 billion must issue invoices, and in the plan of #2497 a sale entered by an invoice and a sale entered by a marketplace settlement could both report the same revenue. The rule: a platform sale is revenue through its settlement; an e-invoice the seller issues for it is matched to the order and does not post again (the duplicate check of build 5 names the order and the invoice).
- **Personal data in the original file** (ADR-0045 point 8): until the owner decides, the default deletes it 90 days after the import is confirmed or rejected.
- **A self-hosted install behind a seller's changing home address** cannot satisfy an IP whitelist; the file path has no such need.
- **A household that is also a client of an accounting firm** is the multi-client case of the firm product: each household is a legal entity of the firm's org, as companies are.

## 12. What ships first, and the build issues

Order: items and stock from invoices first (a seller with no marketplace needs it), then the file imports, then the household books, then the connection kind. Each build is one issue, one worktree, one PR; every new tenant table goes by the two-step rule (an invariant-only PR first). Milestone M3 Paid pilot, priority P2 unless marked.

| # | Issue | Depends on |
| --- | --- | --- |
| 1 (#2512) | Items, aliases, stock moves from purchase and sale lines, the "Chưa gán hàng" list, the item screen, negative-stock warning (one warehouse) | none |
| 2 (#2513) | Month close (cost per item, the 632 proposal), Nhập xuất tồn and the stock card with Excel export, count and adjustment | 1; the accountant's check of rows 3, 4, 5 and 12 |
| 3 (#2514) | The coworker: match lines to items and learn aliases, the low-stock Home item and the reorder draft | 1 |
| 4 (#2515) | Marketplace order report import: staged read, Shopee, TikTok Shop and Lazada profiles, `channel_order`, stock-out at shipment, returns | 1; golden files from real sellers |
| 5 (#2516) | Income report import: `channel_settlement`, the settlement proposal, the payout matched to the platform's balance, the Sàn screen, fee clearing | 4; the accountant's check of section 8.4 |
| 6 (#2517) | The household client kind: `household_profile`, thresholds and rates as data, the books S1a, S2a, S2b, S2c, S2d, S2e as spreadsheets | 2, 5; the accountant's check of rows 5, 6, 7 |
| 7 (#2518) | The 01/CNKD worksheet for a household, never filed by Ludy | 6; the accountant's check of row 7 and the current forms |
| 8 (#2519) | The `marketplace` connection kind in Tích hợp, the `MarketplaceProvider` port and the offline provider, polling into the staged path | 4, 5 and the Tích hợp build of #2497 |
| 9 (#2520) | owner-action: the accountant confirms the rules of section 5 against the primary texts | none |
| 10 (#2521) | owner-action: a real seller exports sample order and income reports from the three platforms, buyer columns removed | none |
| 11 (#2522) | owner-action: a real household seller tries each platform's own-app registration and reports | none |
| 12 (#2523) | owner-action, a decision: register Ludy as a marketplace partner, and the retention of uploaded exports | none |
| 13 (#2524) | Icebox, P3: a real adapter per platform (Lazada, TikTok Shop, then Shopee), after builds 8, 11 and 12 | 8, 11, 12 |
| 14 (#2525) | Icebox, P3: several warehouses and transfers; lots and expiry; stock write-back; moving average and FIFO | 2 |

Each issue says in its acceptance what the finance coworker does on that screen, that the core works with AI off, and that a person approves every posting and every message.
