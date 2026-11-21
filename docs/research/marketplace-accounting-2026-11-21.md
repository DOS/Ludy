# Marketplace accounting rules, researched 2026-11-21 (TT133, TT99, household)

Status: **research, not an accountant's opinion.** The owner decided on 2026-11-21 not to wait for the accountant (#2520): research the public law, apply it to the marketplace posting maps (`MARKETPLACE_POSTING_MAPS`, issue #4303) and list every uncertain point for a later check. Two independent research passes (A and B) answered the open questions of #61 (1 to 8) for the regimes Ludy supports, Circular 133/2016/TT-BTC (TT133) and Circular 99/2025/TT-BTC (TT99), plus the household flow under Circular 152/2025. Each read the primary texts it could reach (the official gazette and the government document portal) and did not see the other's work. Some commercial legal sites, the tax authority site and the Ministry of Finance Q&A pages were not reachable from the research environment. **A and B agree on every account below; where they differ, it is presentation or an uncertain legal reading, listed in "Uncertain points".** The full texts, with their citations and source grades, follow as the appendices.

How to read it: *L* is a legal reading that a person with the accountant's authority should confirm; *F* is what a platform's field means in a real export, to confirm against a real file (#2521 for Shopee, #2522 for Lazada and TikTok Shop).

## Rules applied

**The legal ground moved in 2026; build on the new texts:**
- Decree 252/2026, Art. 43-46, replaces Decree 117/2025 for platform withholding from 1 July 2026.
- Decree 254/2026 and Circular 91/2026 replace Decree 123 and Circular 32 for invoices.
- Decree 141/2026 raises the household threshold to 1 billion VND.
- Resolution 204/2025 keeps VAT at 8% for most goods until 31 Dec 2026.

| # | Rule Ludy applies | TT133 | TT99 | Confidence |
|---|---|---|---|---|
| 1 | Revenue = item price minus the **seller's** voucher, VAT included. The **platform's** voucher stays in revenue and in the VAT base, and is owed by the platform. The seller voucher is shown on the invoice. If a report gives only `paid_price`, add the platform voucher back. | Dr 131 (platform) / Cr 5111, Cr 33311 | Dr 131 / Cr 511, Cr 33311 | high / medium |
| 2 | Goods lost or damaged by the carrier, cost already in 632 at shipment: compensation reduces 632 up to cost, and any excess is other income. No output VAT, no invoice, and input VAT stays deductible. Claim not yet decided: 1381 first. | Dr 1388 (platform) / Cr 632; excess Cr 711 | same | high |
| 3 | Platform fees: 6421 (TT133) or 6417/6418 (TT99) with 1331 on a VAT invoice, through 331 and netted at payout. A fee rebate with an adjusting invoice reduces the expense and 1331. A seller incentive not tied to a sale is 711. A platform price subsidy tied to an order is revenue (as in rule 1). | Dr 6421, 1331 / Cr 331 | Dr 6417, 1331 / Cr 331 | high (accounts) / low (who invoices for TikTok) |
| 4 | Platform withholding applies only to households, individuals and foreign suppliers. **A Vietnamese company is never withheld.** A wrong withholding from a company goes to Dr 1388 / Cr 131 and is not a prepayment. For a household, the withheld VAT and PIT is tax already paid: Dr 3331, Dr 3335 / Cr 131. Lazada's `VAT_in_amount` is likely the VAT inside a fee, not a withholding. | company: none | same | high (law) / low (field meaning) |
| 5 | Revenue date = delivery date, the transfer of ownership, not the payout date. The invoice is dated at delivery. TT133 Art. 57 allows waiting for the end of the return window; TT99 dropped that clause. | delivery | delivery | high / medium |
| 6 | Delivered but not yet paid out: a receivable on 131 per platform. The paid flag changes nothing until the money arrives (Dr 112, Dr 331 / Cr 131). | 131 | 131 | high |
| 7 | Books in whole dong. Invoices may show decimals. There is no general VAT rounding rule, so derive the invoice from the settlement amounts. A 1-dong difference goes to 811/711. | | | high / low |
| 8 | A return or refund after close is a revenue deduction in the period it happens, with an adjusting invoice declared when issued. No written buyer agreement is needed on a platform. | Dr 5111, 33311 / Cr 131; Dr 156 / Cr 632 | Dr 521, 33311 / Cr 131; 521 closed to 511 | high |

**Applied now (PO decision, per the owner):** these rules become the marketplace posting maps (`MARKETPLACE_POSTING_MAPS`, the commentary rows of this issue). Each uncertain point is marked in the code and the docs.

**Default for TT133 rule 5:** recognition at delivery, the same as TT99, so reports compare. A setting for "end of return window" is an option for later.

**Still to confirm later (does not block):**
1. The platform voucher on the invoice: show it as a note or not.
2. Who issues TikTok's fee invoices, and the VAT rate per fee type on all three platforms.
3. Circular 89/2026 Art. 33 and Appendix I, and Decree 174/2025, for the household flow.
4. The meaning of each platform's withholding fields against a real export (#2521, #2522).
5. Whether 131 per platform or 1388 is the better clearing account (131 is the default).

## Uncertain points

Every point below is also marked where it is applied (a `comment` of the map row, or a code comment at the posting).

1. **Rule 1, revenue and vouchers.** L: no tax ruling on a platform voucher was found; the Ministry of Finance Q&A that asks this case could not be read; a seller voucher is treated as a commercial discount on the invoice (a notified promotion under Decree 181 Art. 6.2, or taxed like a gift otherwise). L: whether the platform's own withholding base includes its voucher; coins and bank-funded discounts. F: only Shopee's invoice base is first-party; Lazada and TikTok Shop split and coin semantics are unverified.
2. **Rule 2, lost goods.** L: compensation netted into 632 against gross into 711 (A says the accountant's choice, B recommends net); household VAT on a compensation; corporate income tax deduction of a carrier loss (B, medium). F: whether compensation is paid at the selling price for a buyer who actually received the goods; the data must tell a loss before delivery from a refund after delivery. F: platform withholding on a compensation payout.
3. **Rule 3, fees and incentives.** F: who issues TikTok Shop fee invoices (neither text confirmed it; both read TikTok ads as invoiced from abroad, with no 1331), and Lazada's issuer (B unverified, A reads a Vietnamese company). L: the VAT rate per fee type (8% against 10%); whether netting at the payout counts as a non-cash payment (Decree 181 Art. 26.2.a); whether an incentive not tied to a sale is 711 or a taxed service. L/F: whether a fee rebate arrives as an adjusting invoice or as a bonus.
4. **Rule 4, withholding.** L: A and B differ on whether Decree 252 repeats Decree 117 Art. 11.4 ("no second declaration"); B says it is not settled whether a household above 1 billion VND still files. L: Circular 89/2026 was not opened by either pass and Decree 252 itself was read through summaries by A. L: the PIT debit account 4212 (owner's equity) is a proposal, and the PIT cut of Decree 398/2026. F: every platform withholding field is low confidence; Lazada `VAT_in_amount` is probably the VAT inside a fee (A from the legacy API document, B from the name), and Lazada `WHT_amount` and TikTok Shop `local_vat_amount` are unknown (B reads `local_vat_amount` and `pit_amount` as withholding, A says `local_vat_amount` might be VAT on fees).
5. **Rule 5, revenue date.** L: TT133 Art. 57.1.2.a points to the end of the return window, TT99 dropped that clause; delivery is the default for both so the reports compare (a setting for the end of the return window is an option for later). F: whether the platform's "completed" status or the carrier's "delivered" status is the better proxy for delivery. L: one summary invoice per day is not allowed for a goods seller.
6. **Rule 6, unpaid payout.** 131 per platform (A high, B medium because 1388 also looks defensible); long platform holds are a question for the accountant.
7. **Rule 7, rounding.** L: no general VAT rounding rule exists (the airline clause only); A and B differ on the 1-dong difference (A: whole dong, half up, remainder on the last line; B: VAT per rate per invoice, the dong goes into the net amount, not the VAT). F: the tax XML schema may limit decimals.
8. **Rule 8, returns.** L: Circular 91 Art. 10.5.c was read by A only through summaries, B read it in the gazette (B is the stronger source); the corporate income tax effect of a return after the year closed is unsettled. F: a goodwill refund funded by the platform is not the seller's deduction; check who funds each refund.

## Appendix A: research pass A

### Marketplace sales (Lazada, TikTok Shop, Shopee): accounting and tax answers for Ludy

Research date: 2026-11-21. Scope: the eight questions on booking marketplace sales for one-person companies, SMEs and household businesses, for each books regime Ludy supports: **Circular 133/2016/TT-BTC (TT133, SMEs)** and **Circular 99/2025/TT-BTC (TT99, replaced Circular 200 from 2026-01-01)**. Ludy has no TT200 map (`modules/finance/src/marketplace-posting-map.ts` holds `tt133` and `tt99`), so TT200 is answered only where it explains an account number (5211 to 5213). Household businesses keep books under Circular 152/2025 and have **no chart of accounts**; their accounts below are Ludy's internal ledger, as the plan already says.

This page builds on, and does not repeat, `docs/plan/accounting-rules-research-2026-11-18.md` (answers A1 to A7, D1 to D3 of #2520). Where this page and that page agree, it says so; where it adds or differs, it says so.

#### How to read the confidence

- **High**: the rule was read in the text of the law, decree or circular (a full-text reproduction with its number and date headers, or a first-party page), and the reading needs no judgement.
- **Medium**: the text was read but applying it to a marketplace needs a judgement, or the text came from a reputable firm's summary (KPMG, Forvis Mazars), not the decree.
- **Low**: blog, forum or vendor material, or a judgement with no text behind it.

#### Sources, and what could not be read

Opened and read (the numbers are used in the answers):

| # | Source | Kind |
|---|---|---|
| S1 | Decree 117/2025/ND-CP, English translation, full text: `` https://english.luatvietnam.vn/thue/decree-117-2025-nd-cp-tax-administration-for-business-activities-on-e-commerce-platforms-402622-d1 ``.html | reputable translation of the primary text (in force 2025-07-01 to 2026-06-30) |
| S2 | Decree 254/2026/ND-CP on e-invoices, full-text reproduction: https://ketoananpha.vn/nghi-dinh-254-2026-nd-cp (the signed scan https://xdcs.cdnchinhphu.vn/446259493575335936/2026/7/13/254-ndcp-signed-hoa-don-dien-tu-1783935351029278986043.pdf was downloaded but has no text layer) | full-text reproduction |
| S3 | Decree 181/2025/ND-CP (VAT Law guidance), full text: https://ketoananpha.vn/nghi-dinh-181-2025-nd-cp | full-text reproduction |
| S4 | VAT Law 48/2024/QH15, full text: https://ketoananpha.vn/luat-thue-gia-tri-gia-tang-2024 | full-text reproduction |
| S5 | Circular 133/2016/TT-BTC, full text: https://ketoananpha.vn/thong-tu-133-2016-tt-btc | full-text reproduction |
| S6 | Circular 99/2025/TT-BTC with Appendix II (chart and account guidance), full text: https://ketoananpha.vn/thong-tu-99-2025-tt-btc | full-text reproduction |
| S7 | Decree 68/2026/ND-CP (household and individual business tax), full text as issued: https://ketoananpha.vn/nghi-dinh-68-2026-nd-cp | full-text reproduction; NOT the version amended by Decree 141/2026 |
| S8 | Accounting Law 88/2015/QH13: https://ketoananpha.vn/luat-ke-toan-2015 ; Decree 174/2016/ND-CP: https://ketoananpha.vn/nghi-dinh-174-2016-nd-cp | full-text reproductions |
| S9 | Circular 91/2026/TT-BTC Art. 10 as summarised by an e-invoice provider: https://einvoice.vn/tin-tuc/xu-ly-hddt-lap-sai ; the Tax Department (Cục Thuế) guidance on returns as reported by VCCI, 2026-10-28: https://vcci.com.vn/news/cuc-thue-huong-dan-ho-kinh-doanh-xu-ly-hoa-don-khi-khach-doi-tra-hang | provider summary (medium); government guidance reported by VCCI (medium-high) |
| S10 | Decree 252/2026/ND-CP summaries: KPMG https://kpmg.com/vn/vi/insights/2026/07/decree-252-on-tax-administration.html ; Forvis Mazars https://www.forvismazars.com/vn/vi/content/download/1309056/file/ (Vietnamese update on Decree 252) ; ketoanleanh.edu.vn and sapo.vn (blogs) | reputable summaries (medium) and blogs (low); the decree's own text was not reachable |
| S11 | Shopee Help Centre, "[Thuế & Hóa đơn] Xuất hóa đơn Điện Tử/hóa đơn VAT cho đơn hàng Shopee": https://help.shopee.vn/portal/4/article/79636 | first party |
| S12 | Lazada E-Commerce Services Agreement (LazMall), template published by Lazada: https://img-ovs.alicdn.com/other/common/1d3ee98ed5614641bbc10159bce8332e | first party |
| S13 | Lazada Seller Center legacy API doc, GetTransactionDetails: https://lazada-sellercenter.readme.io/docs/gettranscationdetails | first party but legacy and regional (examples in a non-VND currency) |
| S14 | BigSeller, "Làm thế nào để nhận hóa đơn điện tử từ Shopee": https://www.bigseller.com/blog/articleDetails/hoa-don-dien-tu-shopee-cho-nguoi-ban.4253.htm | blog (low) |
| S15 | eimskip.vn, Shopee renamed "Phí Thanh Toán" to "Phí Xử Lý Giao Dịch" from 2026-04-24 "to match the financial invoice issued to the seller": https://eimskip.vn/chi-phi-ban-hang-tren-cac-san-thuong-mai-dien-tu | blog (low) |
| S16 | taca.com.vn, TikTok invoices and VAT deduction: https://taca.com.vn/hoa-don-tiktok-co-duoc-khau-tru-thue-khong/ ; varecom.vn on TikTok Shop invoicing: https://varecom.vn/xuat-hoa-don-ban-hang-tiktok-shop/ ; congdongketoan.vn forum thread on TikTok Shop fees: https://congdongketoan.vn/threads/hach-toan-chi-phi-tiktokshop.61584/ | blogs and a forum (low) |
| S17 | Official Letter 54963/CTHN-TTHT (Hanoi Tax Department, 2023-07-31) on vouchers sold through a platform, reproduced at ``` https://hethongphapluat.com/cong-van-54963-cthn-ttht-nam-2023-quy-dinh-ve-hoa-don-khi-ban-voucher-phieu-qua-tang-qua-san-thuong-mai-dien-tu-do-cuc-thue-thanh-pho-ha-noi-ban-hanh.html ``` | official letter, reproduced; adjacent topic only |
| S18 | MISA AMIS, "Những điều cần biết về làm tròn số trong kế toán": https://amis.misa.vn/79351/lam-tron-so-trong-ke-toan/ | vendor (low to medium) |
| S19 | Baijing (Chinese trade news) on Shopee Vietnam withholding 1% CIT from corporate cross-border sellers from 2026-07-01: https://www.baijing.cn/article/55743 | news (low) |

Could not be read from this session (blocked or not resolving): thuvienphapluat.vn and luatvietnam.vn (Cloudflare 403 or DNS), lsvn.vn, gdt.gov.vn and its subdomains, vanban.chinhphu.vn, xaydungchinhsach.chinhphu.vn, datafiles.chinhphu.vn (403), vbpl.vn (403), qlg.mof.gov.vn and isa.mof.gov.vn (the Ministry of Finance Q&A pages; one of them, question 164353, asks exactly the platform-voucher question of Q1, and its answer could not be read), sellercenter.lazada.vn, meinvoice.vn. **The text of Decree 252/2026 (which replaced Decree 117 on 2026-07-01) and of Circular 91/2026 was not read in full**; answers that depend on them are medium at best. Allowing thuvienphapluat.vn, gdt.gov.vn and the mof.gov.vn Q&A hosts would let most medium points be checked.

Points taken from the repository's 2026-11-18 research page (not re-opened here): the 1 billion VND household threshold from 2026-01-01 (Decree 141/2026), the VAT 8% rate to 2026-12-31 (Decree 174/2025), the Decree 398/2026 PIT cut, and the Decree 252 article numbers 43 to 46.

---

#### Q1. Revenue of a marketplace order line: list price, paid price, seller voucher, platform voucher

##### Answer

Let `item_price` be the listed price (VAT included, as consumer prices are), `seller_discount` every discount or voucher the seller funds, `platform_voucher` every voucher or subsidy the platform funds (Shopee Voucher, Lazada platform voucher, TikTok platform discount, coins paid by the platform), and `paid_price` what the buyer paid. Then normally `paid_price = item_price - seller_discount - platform_voucher` (shipping aside).

1. **Revenue, accounting and tax, is the price after the seller's own discounts: `item_price - seller_discount`, VAT included; the platform voucher is NOT deducted.** The seller sold at that price; the platform pays part of it on the buyer's behalf and owes it to the seller. Revenue is measured at the fair value of what the seller is entitled to, whether or not collected (TT133 Art. 56.1; TT99 Appendix II, account 511 principles). For VAT, the taxable price is the selling price before VAT (Decree 181 Art. 5.1), including surcharges the seller is entitled to (VAT Law Art. 7.2; Decree 181 Art. 14.1.a), and after a commercial discount (Decree 181 Art. 14.2) or after a registered or notified promotional price reduction (Decree 181 Art. 6.2). Shopee's own help page states that the seller's e-invoice for an order is "tính trên tổng giá trị ban đầu của (các) sản phẩm có trong đơn hàng (trước khi áp dụng Shopee Voucher và chưa bao gồm phí vận chuyển)" (S11).
2. **The platform voucher is part of the sale price, collected from the platform, so it is a receivable from the platform on 131 (the platform's party), not income on 711 and not 1388.** It comes in the payout with the rest of the order money. Ludy's settlement already books Dr 131 (platform) / Cr 511 "net of the seller's own discounts"; that matches this answer as long as the settlement's "sales" figure adds the platform voucher back (see "for the build" below).
3. **The seller voucher is a price reduction given by the seller.** When it is shown on the invoice as a reduction of what the buyer pays, revenue is recorded net and **no deduction account is used**: TT99 Appendix II, account 521, principles c and d ("giá bán phản ánh trên hóa đơn là giá đã trừ chiết khấu thương mại ... không sử dụng tài khoản này, doanh thu bán hàng phản ánh theo giá đã trừ"). Under TT133 there is no 521 at all and 511 is recorded net. It is a commercial discount (chiết khấu thương mại) or a promotional price reduction (khuyến mại bằng hình thức giảm giá), not a deduction booked after the sale, because it is known at the sale.
4. **On the e-invoice:** the line shows the goods at the listed unit price, then the seller's discount shown clearly ("phải thể hiện rõ khoản chiết khấu thương mại, khuyến mại trên hóa đơn", Decree 254 Appendix point 5.đ, from Art. 10.1.k), the amount before VAT after that discount, the VAT rate and VAT, and the total payment. The platform voucher does **not** appear as a discount: the total payment is the price after the seller's discount; who paid it (buyer or platform) is a payment matter. Shipping paid by the buyer is excluded (S11) because the platform collects it for the carrier (an amount collected on behalf, "khoản thu hộ", which is outside the VAT base: Decree 181 Art. 14.1.b).
5. **Households and individuals.** Household revenue for PIT expressly includes "trợ giá, ... khuyến mại, ... khoản hỗ trợ được nhận bằng tiền hoặc không bằng tiền" and excludes "chiết khấu thương mại, giảm giá hàng bán và giá trị hàng bán bị trả lại" (Decree 68/2026 Art. 5.1). So the platform voucher is household revenue and the seller voucher is not. The platform withholds on "the amount received by the household or individual for the goods or services sold, which is collected on their behalf by the e-commerce platform administrator" (Decree 117 Art. 5.2.d); whether a platform includes its own voucher in that base is not stated (see uncertain points).

##### Accounts (one order line, enterprise on the VAT credit method; `R` = item_price - seller_discount, VAT included; `T` = VAT in R)

| Step | TT133 | TT99 |
|---|---|---|
| Sale recognised (Q5 for the date) | Dr 131 (platform) R / Cr 5111 (R - T), Cr 33311 T | Dr 131 (platform) R / Cr 511 (R - T), Cr 33311 T |
| Seller discount shown on the invoice | already netted in R; no entry | already netted in R; no 521 entry (521 principle c) |
| Seller discount granted after the invoice (rare) | Dr 5111, Dr 33311 / Cr 131 | Dr 521, Dr 33311 / Cr 131; 521 closed to 511 at period end |
| Platform voucher | inside the 131 receivable; no separate line | same |
| Household (internal ledger, VAT direct method) | revenue includes the platform voucher; VAT and PIT per Q4 | same |

Note: TT99's chart lists 511 and 521 with no level-2 accounts (S6, chart rows 57 and 59); TT133's chart has 5111, 5112, 5113, 5118 (S5, Art. 57 point 2). Ludy's tt99 map uses 511 and 521, which is consistent.

##### Legal basis

- Circular 133/2016 Art. 56.1 (revenue at fair value of amounts receivable), Art. 57.1.2 (recognition conditions), Art. 57.1.4 (deductions): S5.
- Circular 99/2025 Appendix II, account 511 points 1.2 and 1.4, account 521 points 1.c and 1.d: S6.
- VAT Law 48/2024/QH15 Art. 7.2: S4. Decree 181/2025 Art. 5.1, 6.2, 14.1.a, 14.1.b, 14.2: S3.
- Decree 254/2026 Art. 4.1, Art. 10.1.k, Appendix point 5.đ: S2.
- Decree 68/2026 Art. 5.1: S7. Decree 117/2025 Art. 5.2.d: S1.
- Shopee Help Centre article 79636: S11.

##### Confidence

High that the seller discount reduces revenue and VAT base and must be shown on the invoice. Medium-high that the platform voucher stays in revenue and the VAT base (first-party Shopee statement plus the general rules; no tax ruling read). High for households (Decree 68 Art. 5.1 text).

##### Uncertain points

- Q1-a. No tax authority ruling on platform-funded vouchers was read; the Ministry of Finance Q&A 164353 asks this exact case (list price 100,000, platform voucher 20,000, "lập hóa đơn theo 100.000 hay 80.000") and its answer could not be opened. Confirm with the accountant or that answer.
- Q1-b. Lazada and TikTok Shop have no first-party statement read on what the seller's invoice shows; only Shopee's (S11).
- Q1-c. A seller voucher as a "promotion by price reduction" gets the reduced VAT base only if the promotion is registered or notified under trade law (Decree 181 Art. 6.2); otherwise the price may be treated like a gift (Art. 6.2 last paragraph). Whether a platform voucher campaign counts as notified, and whether the trade-promotion rules (Decree 81/2018 as amended, not opened) apply to an online seller voucher, needs the accountant. Treating it as a commercial discount shown on the invoice (Decree 181 Art. 14.2) avoids the question; which label to use is the accountant's call.
- Q1-d. Whether the platform's withholding base (Decree 117 Art. 5.2.d, now Decree 252) includes the platform's own voucher: the decree text says "the amount received by the household ... collected on their behalf by the platform"; a platform may compute it on `paid_price` only. Compare with a real withholding certificate (#2521).
- Q1-e. Coins and payment-method discounts funded by a bank or wallet: treated here like a platform voucher (a third party pays part of the price). Not checked.

##### For the build

The settlement line's "sales" must be `item_price - seller-funded discounts`, with the platform voucher added back if the report shows `paid_price`. A line that has `paid_price` only, with no voucher split, cannot be posted without understating revenue: refuse it or ask.

---

#### Q2. Goods lost, damaged or scrapped by the carrier, and the platform's compensation (Lazada "Orders-Claims")

##### Answer

1. **The loss is a loss of inventory, charged to cost of goods sold (632) after deducting the compensation.** Both circulars say so: "Giá trị hàng tồn kho bị hao hụt, mất mát ... sau khi trừ số thu bồi thường được hạch toán vào giá vốn hàng bán" (TT133 Art. 20 point 1.3), and "Đối với phần giá trị hàng tồn kho hao hụt, mất mát, kế toán phải tính ngay vào giá vốn hàng bán (sau khi trừ đi các khoản bồi thường, nếu có)" (TT133 Art. 62 point 1.c; the same words in TT99 Appendix II, account 632 point 1.d). Not 811: 811 takes the residual value of a missing fixed asset, not inventory.
2. **The compensation receivable is 1388 (other receivables), with the platform (or the carrier) as the party.** TT99 Appendix II account 1388 names "Phải thu các khoản bồi thường"; TT133 Art. 20 point 3 likewise. Not 131: compensation is not a sale.
3. **When the cause is known and the claim decided in the period**, book directly: Dr 1388 (compensation), Dr 632 (cost not compensated) / Cr 156 (or 157). **When it is not yet decided** (claim filed, result pending), book the missing goods to 1381 first and clear it on the decision (TT99 Appendix II, account 138, point 3.3.a and 3.3.b; TT133 Art. 20 point 1.3). Under TT99, a 1381 balance with no firm evidence of recovery at a reporting date is expensed (TT99 Appendix II, account 138, 1381 description).
4. **Ludy specifics.** Ludy posts Dr 632 / Cr 156 at shipment (month-end close). A parcel lost after shipment has therefore already left 156 and sits in 632, and the order was never delivered, so no revenue should exist for it. The compensation then reduces 632: Dr 1388 (platform) / Cr 632 up to the cost of the lost goods; any compensation above that cost is other income, Cr 711 (TT99 Appendix II account 711: "Thu tiền bồi thường của bên thứ ba để bù đắp cho tài sản bị tổn thất"; TT133 Art. 65 the same). If revenue was already booked because the platform marked the order delivered, reverse the sale first (as a return, Q8).
5. **Goods the seller scraps (damaged, returned unsellable):** Dr 632 / Cr 156 for the cost, after any compensation (same rule). Keep a destruction or count record; the deductibility of destroyed stock for CIT needs a decision record and the count record (the 2026-11-18 page cites Circular 20/2026 Art. 3(9); not opened here).
6. **VAT.** Compensation in money is **not** part of the VAT base: "Không bao gồm các khoản thu không liên quan đến bán hàng hóa, cung cấp dịch vụ của cơ sở kinh doanh: các khoản thu về bồi thường bằng tiền ..." (Decree 181 Art. 14.1.b). The seller issues **no VAT invoice** for the compensation and declares no output VAT on it; it keeps the platform's claim record and the payout statement as the voucher. The input VAT already deducted on the lost goods stays deductible, "kể cả thuế giá trị gia tăng đầu vào không được bồi thường của hàng hóa ... bị tổn thất", with documents proving the loss (VAT Law Art. 14.1.a; Decree 181 Art. 23.1).
7. **Households.** For household PIT, revenue includes "các khoản bồi thường vi phạm hợp đồng, bồi thường khác liên quan đến hoạt động kinh doanh" (Decree 68 Art. 5.1), so the compensation is household revenue for PIT. Whether it is also in the household's VAT revenue is unclear (VAT follows the VAT Law, which excludes compensation: Decree 68 Art. 3.2 refers to the VAT Law).

##### Accounts

| Event | TT133 | TT99 |
|---|---|---|
| Lost or damaged in transit, cost already in 632 at shipment (Ludy), claim accepted | Dr 1388 (platform) / Cr 632 (up to cost); excess Cr 711 | same |
| Lost goods still on 156 or 157, cause known, claim decided | Dr 1388 (compensation), Dr 632 (rest) / Cr 156 or 157 | same |
| Cause or claim not yet known | Dr 1381 / Cr 156 or 157; on decision Dr 1388, Dr 632 / Cr 1381 | same; at a reporting date with no firm evidence of recovery, Dr 632 (or the relevant expense) / Cr 1381 |
| Compensation received in the payout | Dr 112 (or Dr 131-side netting) / Cr 1388 | same |
| Scrapped by the seller | Dr 632 / Cr 156 | same |

##### Legal basis

TT133 Art. 20 points 1.3 and 3 (account 138), Art. 62 point 1.c and 2.1 (632), Art. 65 (711): S5. TT99 Appendix II, account 138 (1381, 1388 descriptions; point 3.3), account 632 points 1.d and 3.b, account 711: S6. Decree 181/2025 Art. 14.1.b and Art. 23.1: S3. VAT Law Art. 14.1.a: S4. Decree 68/2026 Art. 5.1 and 3.2: S7.

##### Confidence

High for the accounts and the VAT exclusion of compensation. Medium for crediting 632 rather than 711 when the cost already sits in 632 (the circulars say "net of compensation into 632"; TT99's 711 also lists third-party compensation for lost assets, so a gross 711 entry is a defensible alternative).

##### Uncertain points

- Q2-a. Net into 632 versus gross into 711 when the cost was already expensed at shipment: accountant's choice; pick one and keep it.
- Q2-b. Some platforms compensate at the item's sale price, not its cost. The part above cost is 711 under the answer above; confirm it is not revenue (no sale occurred) and not subject to platform withholding.
- Q2-c. Household VAT on compensation (PIT revenue includes it under Decree 68 Art. 5.1; the VAT Law excludes it). Ask.
- Q2-d. Whether the platform withholds VAT or PIT on a compensation payment to a household (it is not a sale transaction under Decree 117 Art. 4). Check a real file.
- Q2-e. When the carrier is chosen and paid by the seller (not the platform's logistics), the receivable is from the carrier, not the platform.

---

#### Q3. Platform fees and credits

##### Answer

**Fees the platform charges the seller** (commission or fixed fee, payment or transaction processing fee, service fees such as free-shipping or voucher programmes, infrastructure fee, shipping charged to the seller, advertising) are **selling expenses**:

- TT133: **6421 Chi phí bán hàng** (TT133 Art. 64 point 1.1 lists "hoa hồng bán hàng", "vận chuyển", "quảng cáo"; the 6421 and 6422 split is in Art. 64 point 2).
- TT99: **641**, sub-account **6417 Chi phí dịch vụ mua ngoài** for commission, payment and service fees and shipping ("tiền thuê bốc vác, vận chuyển sản phẩm, hàng hóa đi bán, tiền trả hoa hồng cho đại lý bán hàng"), **6418 Chi phí bằng tiền khác** for advertising and promotion ("giới thiệu sản phẩm, hàng hóa, quảng cáo"). (TT99 Appendix II, account 641 point 2.)
- **Not 6278** (production overhead, TT99 account 627) and **not 642 / 6422** (administration). Not 711.
- The deducted fees go through 331 (the platform) as in research A1: Dr 331 at the payout; the fee invoice Dr 6421 or 6417/6418, Dr 1331 / Cr 331; month-end accrual Dr 6421 or 641x / Cr 335 when no invoice has come. Unchanged from the 2026-11-18 page.

**Credits the platform gives the seller:**

| Credit | Nature | Enterprise booking |
|---|---|---|
| Platform voucher or platform-funded price subsidy tied to an order | part of the sale price (Q1) | inside Dr 131 (platform) / Cr 511 |
| Shipping fee paid by the buyer, collected by the platform for the carrier | amount collected on behalf, not revenue (Decree 181 Art. 14.1.b "các khoản thu hộ") | net to zero; if it passes through the payout, Dr 131 or 1388 / Cr 3388 and back, never 511 or 641 |
| Shipping subsidy or rebate that lowers a shipping fee the seller bears | reduction of the expense | Cr 6421 (TT133) or Cr 6417 (TT99), with Cr 1331 if the platform issues a decrease invoice |
| Commission or fee rebate, fee refund (cancelled order, fee charged in error) | reduction of the fee | the platform's adjusting (decrease) invoice: Dr 331 / Cr 6421 or 6417, Cr 1331; without an invoice, reduce the expense only and leave 1331 as invoiced |
| Seller incentive or bonus not tied to a specific sale (campaign reward, cash bonus) | other income, unless it pays for a service the seller performs | Dr 131 or 1388 (platform) / Cr 711 ("tiền thưởng của khách hàng liên quan đến tiêu thụ ... không tính trong doanh thu", TT99 711 and TT133 Art. 65); outside the VAT base as a bonus (Decree 181 Art. 14.1.b "tiền thưởng") |
| Payment for a service the seller does for the platform (paid placement in a platform campaign, affiliate content) | a sale of a service by the seller | Cr 511 with output VAT and a seller invoice |
| Compensation for lost goods | Q2 | Dr 1388 / Cr 632 or 711 |

**Input VAT on fee invoices is deductible** for an enterprise on the credit method when (a) it holds a VAT invoice and (b) for a purchase of 5 million VND or more including VAT, a non-cash payment document (VAT Law Art. 14.2.a and b; Decree 181 Art. 26). Netting the fees against the platform's payout counts as a non-cash payment only if the contract provides for set-off and both sides confirm the reconciliation in writing (Decree 181 Art. 26.2.a); any remainder of 5 million or more paid in money must be paid non-cash (Art. 26.2.đ). Keep the platform's terms and the confirmed statements (as in research A2). A household on the direct method deducts no input VAT; the fee (VAT included) is a cost for the income method only.

**Do the platforms issue Vietnamese VAT invoices for their fees?**

- **Shopee:** yes. The seller contracts with Công ty TNHH Shopee (Vietnamese company, tax code 0106773786 per a registry page seen only in a search result, not opened). Shopee issues e-invoices for its service fees monthly; a lookup code is sent on the 15th of the next month for the previous month's fees, some fee invoices come by email from a Shopee e-invoice mailbox as .xml and .pdf (S14, blog, low). Shopee renamed "Phí Thanh Toán" to "Phí Xử Lý Giao Dịch" from 2026-04-24 to match the invoice it issues (S15, blog, low). Cambodia-market orders are invoiced by Shopee International XI Private Limited (S14), which is a foreign invoice.
- **Lazada:** the seller's contracting party is **Recess Company Limited, tax code 0308808576**, a Ho Chi Minh City company (S12, first party). The agreement states the commission fee is **exclusive of VAT** and the order processing fee (2.497% of order value) is **inclusive of VAT** (S12, LazMall clause 3C). A Vietnamese company charging Vietnamese VAT must issue Vietnamese e-invoices, so Lazada fee invoices are Vietnamese VAT invoices; the monthly invoicing practice itself was not confirmed from a Lazada page.
- **TikTok Shop:** not confirmed. A forum thread (S16, low) says TikTok Shop sends seller fee invoices each month; which legal entity issues them (a Vietnamese TikTok company or TikTok Pte. Ltd., Singapore) was not found. TikTok **advertising** is invoiced by TikTok Pte. Ltd. (Singapore), whose invoice is not a Vietnamese VAT invoice and does not support input VAT deduction (S16 taca.com.vn, blog, low); for advertising Dr 6418 (TT99) or 6421 (TT133) for the full amount, no 1331.
- **Timing rule that supports monthly fee invoices:** for e-commerce services sold to businesses in volume, the invoice date is the end of reconciliation, at the latest the 7th of the next month (Decree 254 Art. 9.4.a lists "dịch vụ thương mại điện tử"). So a fee accrual at month end (Dr 641x or 6421 / Cr 335) is normal, as research A1 says.

##### Legal basis

TT133 Art. 64 (642, 6421, 6422), Art. 65 (711): S5. TT99 Appendix II, accounts 641 (6417, 6418), 627 (6278), 711: S6. VAT Law Art. 14.2: S4. Decree 181 Art. 14.1.b, Art. 26: S3. Decree 254 Art. 9.4.a: S2. Lazada agreement: S12. Shopee practice: S14, S15 (low). TikTok: S16 (low).

##### Confidence

High on the expense accounts and the deduction conditions. Medium on the credits table (classification is a judgement; texts are clear only for bonuses and compensation). High that Lazada's counterparty is a Vietnamese VAT payer; medium that Shopee issues Vietnamese VAT invoices (blogs, consistent); low on TikTok Shop.

##### Uncertain points

- Q3-a. TikTok Shop's invoicing entity and whether its fee invoices are Vietnamese VAT invoices. Ask a seller with a real TikTok Shop fee invoice, or the accountant.
- Q3-b. Whether a platform's "seller incentive" is a bonus (711, no VAT) or payment for a promotional service by the seller (511 with VAT): depends on the programme terms. The accountant should classify each named credit in the real reports (#2521).
- Q3-c. Shopee sends its invoice lookup code on the 15th while Decree 254 Art. 9.4.a sets the invoice date no later than the 7th of the next month; the invoice date may still be on or before the 7th. Check a real Shopee fee invoice.
- Q3-d. Whether platform netting satisfies Decree 181 Art. 26.2.a (contract clause plus a confirmed reconciliation record). Lazada's agreement lets Lazada "withhold and/or set-off any payments due" (S12) but no signed reconciliation record exists per payout. Same open point as research A2.
- Q3-e. VAT rate on fees: 8% to 2026-12-31 then 10% (from the 2026-11-18 page, not re-opened). Always take the rate printed on the invoice.

---

#### Q4. Tax withheld by the platform (Shopee `withholding_vat_tax`, `withholding_pit_tax`, `withholding_cit_tax`; TikTok `pit_amount`, `local_vat_amount`; Lazada `VAT_in_amount`, `WHT_amount`)

##### Answer

**Who is withheld.**

- **Household businesses and individuals (resident or not): yes.** A platform with ordering and payment functions withholds, declares and pays VAT and PIT on each transaction of households and individuals (Decree 117 Art. 4.1 and 4.2, Art. 5; in force 2025-07-01). From 2026-07-01 Decree 252 carries this in its Chapter III (Arts. 40 to 46 per S10; KPMG: "Bổ sung đối tượng khấu trừ, nộp thay thuế đối với hoạt động kinh doanh trên nền tảng TMĐT"). Rates (Decree 117 Art. 5.2): VAT goods 1%, services 5%, transport and services tied to goods 3%; PIT for residents 0.5%, 2%, 1.5%; for non-residents 1%, 5%, 2%; the highest rates when the platform cannot classify the transaction (Art. 5.2.c).
- **A Vietnamese company (enterprise) seller: no VAT or PIT withholding.** Decree 117 applies only to households and individuals (Art. 1, 2, 4). Decree 252 adds withholding of VAT and **CIT for foreign suppliers** (nhà cung cấp nước ngoài) selling on a platform (KPMG and Forvis Mazars, S10), not for domestic companies. Shopee's `withholding_cit_tax` is that foreign-supplier CIT: from 2026-07-01 Shopee withholds 1% CIT from corporate **cross-border** sellers (S19, news, low). A Vietnamese company should see zero in all three Shopee fields; a non-zero value means the shop is registered with the wrong seller type.

**What it does for the seller.**

- The household **does not declare again** the VAT and PIT the platform withheld for those transactions (Decree 117 Art. 11.4; Decree 68 Art. 11.1 refers to Decree 117).
- It is **final** for a household on the percentage-of-revenue PIT method (VAT is always a percentage of revenue for households: Decree 68 Art. 3.2).
- It is a **credit against the annual PIT** for a household on the income method (above 3 billion, or above the threshold and choosing it): "Số thuế thu nhập cá nhân đã được chủ quản nền tảng ... khấu trừ, nộp thay được trừ khi xác định số thuế thu nhập cá nhân phải nộp" (Decree 68 Art. 11.3).
- It is **refundable** when the household's whole-year revenue is under the exemption threshold (Decree 117 Art. 10.1; Decree 68 Art. 12.3), threshold 1 billion VND from 2026 (Decree 141/2026, per the 2026-11-18 page).
- Withheld revenue still counts toward the household's annual revenue and threshold (Decree 68 Art. 8.1.b: "bao gồm cả doanh thu đã được tổ chức, cá nhân khấu trừ, khai thay, nộp thay").
- Cancelled or returned transactions: the platform offsets the tax in its monthly declaration and refunds the household (Decree 117 Art. 6.1 and 7.6; Decree 252 per S10).

**Booking (household, Ludy's internal ledger; a household has no chart under Circular 152).** As built in #2516 slice C2 and #3711: at the settlement, VAT Dr 511 / Cr 3331 and PIT Dr owner's equity (proposed 4212) / Cr 3335; at the payout, Dr 3331, Dr 3335 / Cr 131 (platform). This page agrees: the withheld tax reduces 3331 and 3335, the household's own payable; it is not an expense (PIT is the owner's tax; VAT under the direct method reduces revenue). Using 3334 (CIT) is wrong for a household; 3335 is "Thuế thu nhập cá nhân" in the TT99 chart (S6, chart row 333).

**Booking (enterprise).** No withholding line. Output VAT on 33311 at the sale and declared by the company; CIT on its own return. If a platform withheld from an enterprise by mistake: Dr 1388 (platform or the tax authority, as the refund route decides) / Cr 131 (platform), never Dr 3331 or 3334, because the company's own VAT and CIT are not reduced by a tax paid under a household's code. Ask the platform to correct the seller type.

**Field mapping (proposal; verify with real files, #2521):**

| Platform field | Meaning (best reading) | Household | Enterprise |
|---|---|---|---|
| Shopee `withholding_vat_tax` | VAT withheld under Decree 117/252 | 3331 | expect 0; if not, 1388 and flag |
| Shopee `withholding_pit_tax` | PIT withheld | 3335 | expect 0; if not, 1388 and flag |
| Shopee `withholding_cit_tax` | CIT withheld from a foreign corporate seller | not applicable; flag | expect 0 for a Vietnamese company; flag |
| TikTok `pit_amount` | PIT withheld | 3335 | expect 0; flag |
| TikTok `local_vat_amount` | probably VAT withheld; could be VAT on fees | 3331 if withholding | flag |
| Lazada `VAT_in_amount` | **VAT included in a fee line** (input VAT on Lazada's fee), not a withholding: in Lazada's API doc it appears only on fee lines (Payment Fee, Commission) next to their amount (S13) | not deductible for a household (direct method); part of the fee cost | 1331 only when the fee invoice shows it |
| Lazada `WHT_amount` | a withholding amount; in Lazada's regional doc it sits on fee lines (S13), a pattern of countries where the seller withholds on fees; its Vietnamese meaning is unknown | keep unmapped (as decided on #3711) | keep unmapped |

##### Legal basis

Decree 117/2025 Art. 1, 2, 4, 5, 6.1, 7.2, 7.6, 10.1, 11.4: S1. Decree 68/2026 Art. 3.2, 8.1.b, 11.1, 11.3, 12.3: S7. Decree 252/2026 Chapter III: S10 (summaries only). TT99 chart (3331, 3334, 3335): S6. Lazada field doc: S13. Shopee CIT: S19.

##### Confidence

High that only households and individuals (and foreign suppliers) are withheld and that a Vietnamese company is not. High on "no second declaration", "credit against income-method PIT" and "refund below threshold" (decree text). Medium on Decree 252 continuity (summaries only). Low to medium on the field meanings.

##### Uncertain points

- Q4-a. Decree 252's own text (Arts. 43 to 46) was not read; S10 summaries say the mechanism continues. Confirm the article numbers and any change to the withholding base or rates.
- Q4-b. TikTok `local_vat_amount` and Lazada `WHT_amount` meanings in Vietnam: need a real export or the current Open Platform docs (#2521).
- Q4-c. The debit account for a household's PIT (4212 proposed): the accountant names it (#2520, #3711).
- Q4-d. The Decree 398/2026 PIT cut (30% for 2026 and 2027): whether platforms withhold at the reduced amount or the household claims it at finalization. Not researched here.
- Q4-e. Whether a sole individual who is not a registered household (cá nhân kinh doanh) needs any ledger at all in Ludy: the law treats both alike for withholding.

---

#### Q5. The revenue recognition date, and the e-invoice date

##### Answer

1. **Accounting (both regimes): when control of the goods passes to the buyer, which for a marketplace parcel is the date of successful delivery to the buyer**, not the payout date and not the platform's transaction date. Both circulars require all five conditions, the first two being that the significant risks and rewards have passed and the seller no longer controls the goods (TT133 Art. 57.1.2.a; TT99 Appendix II, account 511 point 1.2.a). The seller still bears the risk while the carrier holds the parcel (Q2 shows the seller absorbs the loss), so shipment is too early.
2. **TT133 adds a condition that matters for marketplaces:** "Khi hợp đồng quy định người mua được quyền trả lại sản phẩm, hàng hóa, đã mua theo những điều kiện cụ thể, doanh nghiệp chỉ được ghi nhận doanh thu khi những điều kiện cụ thể đó không còn tồn tại và người mua không được quyền trả lại" (TT133 Art. 57.1.2.a, third bullet). Platforms give a return window after delivery, so a literal reading of TT133 puts revenue at the end of the return window, which is close to the platform's "order completed" (buyer confirmed or window expired) date. **TT99 does not contain that sentence**: its condition is only "Doanh thu được xác định tương đối chắc chắn" (TT99 Appendix II, 511 point 1.2.a). So: TT99, delivery date; TT133, delivery date in practice, but the text points to the completion date. This refines research A5 and D3.
3. **Tax.** VAT arises at the transfer of ownership or the invoice date, whether paid or not (VAT Law Art. 8.1.a). Household revenue arises at the transfer of ownership (Decree 68 Art. 5.3.a). The platform withholds when it confirms the transaction successful and accepts payment (Decree 117 Art. 5.1), which may be later than delivery.
4. **The e-invoice date is the transfer of ownership to the buyer, whether paid or not** (Decree 254 Art. 9.1): for a delivered parcel, the delivery date. Shopee's practice matches: invoices requested by buyers are sent within 7 working days from successful delivery (S11), and the date shown is the invoice's issue time (Decree 254 Art. 10.1.g; the signing and sending must follow by the next working day, Appendix point 7). The seller declares output VAT by invoice date (Appendix point 7: "Người bán khai thuế theo thời điểm lập hóa đơn").
5. **Practical rule for Ludy:** revenue month = month of successful delivery (`delivered_at`), as built; for TT133 entities, show the accountant the choice between delivery and completion; fall back to the platform's completion date when no delivery date exists (research D3), never the payout date.

##### Accounts

Unaffected by the date choice: Dr 131 (platform) / Cr 5111 (TT133) or 511 (TT99), Cr 33311.

##### Legal basis

TT133 Art. 57.1.2.a: S5. TT99 Appendix II 511 point 1.2.a: S6. VAT Law Art. 8.1.a: S4. Decree 68 Art. 5.3.a: S7. Decree 117 Art. 5.1: S1. Decree 254 Art. 9.1, 10.1.g, Appendix point 7: S2. Shopee S11.

##### Confidence

High on delivery rather than payout. High on the invoice date rule. Medium on the TT133 return-window point (the text is clear, practice usually ignores it; the accountant decides).

##### Uncertain points

- Q5-a. TT133 entities: delivery date or end of return window? Ask the accountant; record the choice per entity.
- Q5-b. Cash on delivery (COD) orders: delivery and payment coincide; no issue. Orders paid in advance: an advance received before delivery is not revenue (Dr 131 credit balance or 3387 is not used for goods); check that the settlement never posts an undelivered order.
- Q5-c. Whether a seller may issue one daily summary invoice for consumer marketplace orders instead of one per order: Decree 254 Art. 9.4.r gives this to service businesses only; goods sellers appear to need one invoice per order (or a cash-register invoice). Not confirmed.

---

#### Q6. Payout lines "not paid yet": recognise before payout?

##### Answer

**Yes. Once the order is delivered (Q5), the sale is recognised and the money the platform holds for the seller is a receivable from the platform on 131, whether or not it is paid out.** Revenue does not wait for cash ("không phân biệt đã thu tiền hay sẽ thu được tiền", TT133 Art. 56.1; the same in TT99's revenue principles). The platform collects the buyer's money for the seller (Decree 117 Art. 5.2.d: "collected on their behalf by the e-commerce platform administrator"), so the claim arises from a sale and belongs on **131 (phải thu của khách hàng), with the platform as the party**, not 1388: 131 records receivables "về tiền bán sản phẩm, hàng hóa" (TT133 Art. 17 point 1.a; TT99 Appendix II 131 point 1.a), and 1388 is for receivables outside 131 (TT99 Appendix II, 1388 description). Use 1388 only for non-sale claims (compensation, Q2; tax withheld in error, Q4).

The "paid" flag (Lazada `Paid Status`, S13) changes nothing in the books until the money arrives: then Dr 112 / Cr 131. Fees deducted before payout follow research A1 (Dr 331 at the payout). A delivered order still in its return window stays in 131; a later return is booked as in Q8.

##### Accounts

| Event | TT133 | TT99 |
|---|---|---|
| Delivered, not paid out | Dr 131 (platform) / Cr 5111, Cr 33311 | Dr 131 (platform) / Cr 511, Cr 33311 |
| Payout received | Dr 112, Dr 331 (fees) / Cr 131 | same |
| Year end, receivable old or disputed | provision for doubtful debts (229 / 2293) as for any receivable | same |

##### Legal basis

TT133 Art. 17 point 1.a, Art. 56.1: S5. TT99 Appendix II 131 point 1.a and 1.b, 138 (1388): S6. Decree 117 Art. 5.2.d: S1.

##### Confidence

High.

##### Uncertain points

- Q6-a. Platform reserves or holds beyond the normal cycle (TikTok payouts differ from statements by reserves, plan section 6): still 131, but flag them; whether a long hold needs a separate sub-ledger is the accountant's choice.

---

#### Q7. Are VND amounts whole dong? Rounding on e-invoices and in the books

##### Answer

1. **The accounting currency is the đồng (VND)** (Accounting Law Art. 10.1; Decree 174/2016 Art. 4.1). No text requires every booked amount to be a whole đồng, and no text forbids it. **Rounding is expressly allowed when preparing or publishing financial statements** (Accounting Law Art. 10.3), and when a reduced unit (thousands, millions) is used the rule is half up: "Chữ số sau chữ số đơn vị tiền tệ rút gọn nếu bằng 5 trở lên thì được tăng thêm 1 đơn vị; nếu nhỏ hơn 5 thì không tính" (Decree 174/2016 Art. 4.6).
2. **E-invoices may carry decimals.** Decree 254 lets the seller write digits after the units digit with a comma (Appendix point 8.b: "nếu có ghi chữ số sau chữ số hàng đơn vị đặt dấu phẩy (,) sau chữ số hàng đơn vị"); amounts are in VND, symbol "đ" (point 8.c), and the total is also written in Vietnamese words (point 5.d). The VAT rate is never rounded (S18, vendor, consistent with Appendix point 5.b). No rule in the texts read sets how the VAT amount is rounded; the only explicit rounding rule in Decree 254 is for airlines (to thousands, IATA rule, Appendix point 5.e).
3. **Marketplace amounts in Vietnam are VND** (Lazada: VND in Vietnam, cents elsewhere, plan section 6). Platforms may still return fractional values in computed fields (withholding, fees).
4. **Recommendation for Ludy:** keep the platform's amounts as decimal strings exactly as received (the money rule of the repo), post journal lines in whole đồng, round half up (Decree 174 Art. 4.6 by analogy) and carry the remainder to the last line so totals match the report (as the stock close and the household tax split already do). On the e-invoice, compute VAT per rate group from the before-tax amount and show whole đồng unless the seller's invoice provider and the seller choose decimals; never round the rate. Tax returns are filed in đồng.

##### Legal basis

Accounting Law 88/2015 Art. 10.1 and 10.3: S8. Decree 174/2016 Art. 4.1, 4.4 to 4.6: S8. Decree 254 Appendix points 5.b to 5.e and 8.b, 8.c: S2. MISA S18 (vendor).

##### Confidence

High that decimals are allowed on invoices and that rounding is allowed for statements. Medium on the recommended whole-đồng posting (practice, no text requires it). Low on any rule for rounding VAT on an invoice: none found.

##### Uncertain points

- Q7-a. No official letter on rounding differences of VAT on e-invoices was read (searches found none). Ask the accountant whether per-line or per-invoice VAT rounding is expected for marketplace orders with several lines.
- Q7-b. Whether the tax return forms (VAT and household returns) accept decimals: assumed whole đồng, not verified.

---

#### Q8. Returns and refunds after the period closes

##### Answer

1. **Accounting: a return reduces revenue and output VAT, and puts the goods back at cost.**
   - **TT133**: there is no 521; the return reduces 511 directly: Dr 5111, Dr 33311 / Cr 131 (or 111, 112), and Dr 156 / Cr 632 for the goods back (TT133 Art. 57 point 1.4).
   - **TT99**: Dr **521**, Dr 33311 / Cr 131; Dr 156 / Cr 632; 521 is closed to 511 at period end (TT99 Appendix II 521 point 3.b and 3.c).
   - **5212 and 5213 are Circular 200 sub-accounts. TT99 has a single 521 with no level-2 accounts** (TT99 chart row 59); a company may open its own detail accounts "như: Chiết khấu thương mại, Giảm giá hàng bán, Hàng bán bị trả lại" (TT99 Appendix II 521, after point 2). TT133 has neither. Ludy's tt99 map uses 521, which is right.
2. **A return of a sale from an earlier period** (both regimes, same words): if it happens **before the financial statements are issued**, treat it as an adjusting event after the reporting date and reduce the revenue in the statements of the earlier period; if **after** the statements are issued, reduce the revenue of the period in which it happens (TT133 Art. 57 point 1.4; TT99 Appendix II 511 point 1.4 and 521 point 1.b). This is about the annual statements. A month that Ludy has locked internally is not "issued statements": the return is booked in the open month, and only a return of a prior-year sale found before the year's statements are issued needs an adjustment of the prior year (research A6: never edit, adjust with a linked voucher, Accounting Law Art. 27).
3. **E-invoice: an adjusting invoice is needed whenever an invoice was issued for the returned goods.** From 2026-07-01 the seller issues an adjusting invoice when the buyer returns all or part of the goods, including an exchange that changes the value (Circular 91/2026 Art. 10.5.c, as stated by the Tax Department for households, S9 VCCI; the same clause for all sellers per S9 einvoice.vn). If the parties agree that the buyer issues an invoice for the return, a buyer who uses e-invoices issues it instead (S9). The adjusting invoice records only the difference, negative for a decrease, with "Điều chỉnh cho hóa đơn Mẫu số ... ký hiệu ... số ... ngày ..." (S9). **The seller declares it in the period the adjusting invoice is issued** (not a supplementary return for the old period) (Circular 91 Art. 10 per S9). An order cancelled **before** delivery has no invoice (the invoice date is delivery, Q5) and needs nothing.
4. **Refund without a return of goods** (a price reduction after a complaint): Dr 5111 (TT133) or Dr 521 (TT99), Dr 33311 / Cr 131, with an adjusting invoice for the reduction (Circular 91 Art. 10.5 covers decreases).
5. **Households:** returned goods are excluded from revenue (Decree 68 Art. 5.1: "không bao gồm ... giá trị hàng bán bị trả lại"); the platform offsets and refunds the tax it withheld on a returned transaction (Decree 117 Art. 6.1 and 7.6); the household with an invoice issues an adjusting invoice (S9, the Tax Department's guidance is addressed to households).
6. **Costs of a return** (return shipping the seller pays): Dr 6421 (TT133) or 6417 (TT99) (TT99 Appendix II 521 point 3.b: "Các chi phí phát sinh liên quan đến hàng bán bị trả lại ... Nợ TK 641").

##### Legal basis

TT133 Art. 57 point 1.4: S5. TT99 Appendix II 511 point 1.4, 521 points 1.a to 1.e, 2, 3.b, 3.c: S6. Circular 91/2026 Art. 10.5.c and Art. 10 declaration rule: S9 (summaries). Decree 68 Art. 5.1: S7. Decree 117 Art. 6.1, 7.6: S1. Accounting Law Art. 27 (via the 2026-11-18 page).

##### Confidence

High on the accounts and the prior-period rule (circular text). Medium-high on the adjusting-invoice rule (Tax Department guidance as reported, provider summary; Circular 91's own text not read).

##### Uncertain points

- Q8-a. Circular 91 Art. 10.5.c text not read directly; confirm that it applies to enterprises as well as households and how it treats consumer buyers who are not invoice users.
- Q8-b. The 8% to 10% change on 2027-01-01: an adjusting invoice in 2027 for a 2026 return keeps 8% by the 2023 precedent (Official Letter 2121/TCT-CS, from the 2026-11-18 page); no 2027 guidance yet (#3709).
- Q8-c. Whether a platform's "refund" line that is a goodwill payment funded by the platform (not a return) should reduce the seller's revenue at all: if the platform bears it, it is not the seller's revenue deduction. Check the reports for who funds each refund.

---

#### Summary of changes or confirmations for the design

1. **Confirmed** (adds primary text to the 2026-11-18 answers): fees on 6421 (TT133) or 6417/6418 (TT99) via 331 and 335; household withholding to 3331 and 3335, never an expense, never for an enterprise; revenue on delivery, not payout; 131 for the platform receivable; returns on 511 (TT133) or 521 (TT99), no 5212/5213.
2. **New:** platform vouchers stay in revenue and in the VAT base, and must be added back when a report gives only `paid_price` (Q1); compensation for lost goods: Dr 1388 / Cr 632 (excess 711), no output VAT, no invoice; household PIT counts it as revenue (Q2); credits table (Q3); Lazada `VAT_in_amount` is VAT inside a fee, not a withholding (Q4); TT133's return-right condition may move revenue to the completion date for TT133 entities (Q5); post whole đồng, round half up, keep source decimals (Q7); returns need an adjusting invoice declared in the period issued (Q8).
3. **For the accountant (#2520), the questions that remain:** Q1-a, Q1-c, Q1-d; Q2-a, Q2-c; Q3-a, Q3-b, Q3-d; Q4-a, Q4-b, Q4-c; Q5-a, Q5-c; Q7-a; Q8-a, Q8-c.

## Appendix B: research pass B

### Marketplace sales (Shopee, Lazada, TikTok Shop): accounting and tax answers, cross-check B

Researcher B, independent cross-check, written 2026-11-21. Read-only on the repository. Not reviewed by an accountant: every entry below is a proposal for the accountant (#61) and the owner to confirm.

#### 0. Scope, regimes and what changed in 2026

##### Regimes the code supports

`grep -rn "TT133\|TT200\|TT99" docs modules/finance/src` and `supabase/migrations/20261103020000_crove_finance_books_regime.sql` show:

- **TT133** (Circular 133/2016/TT-BTC, SMEs): the default books (`crove_finance.account`, chart `('tt133','2026.1')`). Statements exist with a draft banner (#154).
- **TT99** (Circular 99/2025/TT-BTC, replaces Circular 200 for fiscal years from 1 January 2026): chart of accounts seeded (`('tt99','2026.1')`, #1403); posting templates are "phase B" and not built yet. In the seeded chart, 521 has no sub-accounts and 1381/1388/3388/6417 exist.
- **TT200**: not supported (replaced by TT99, so not answered separately).
- **Household businesses** (hộ kinh doanh): `supabase/migrations/20261231030035_crove_finance_household.sql` maps cost categories to TT133 accounts "as a proposal for the accountant". The legal regime for households is Circular 152/2025/TT-BTC (single-entry books S1a to S2e-HKD), not a chart of accounts. I give the household treatment as a third column where it differs.

So each answer gives entries for **TT133** and **TT99**, plus a **household (TT152)** note.

##### The legal ground moved during 2026 (read this first)

1. **Invoices: Decree 254/2026/NĐ-CP and Circular 91/2026/TT-BTC apply from 1 July 2026** and repeal Decree 123/2020, Decree 70/2025 and Circular 32/2025 (Decree 254 Art. 43; Circular 91 Art. 25). Anything citing "Decree 123 / Decree 70 / Circular 32" is now history for invoices issued from 1 July 2026 (Circular 91 Art. 24.2 keeps the old adjust/replace rules for invoices issued under them).
2. **Platform withholding: Decree 117/2025/NĐ-CP was replaced from 1 July 2026 by Decree 252/2026/NĐ-CP Art. 43 to 46** (Decree 252 Art. 74.3.d). The substance is the same for households and individuals, and Decree 252 adds withholding of VAT and **CIT for foreign suppliers** (which explains Shopee's `withholding_cit_tax` field). The legal basis is the new Law on Tax Administration 108/2025/QH15 Art. 13.4 (in force from 1 January 2026 for Art. 13; the rest from 1 July 2026, Art. 52).
3. **Household thresholds rose to 1 billion VND** from 1 January 2026: Decree 141/2026/NĐ-CP Art. 1.1 replaces "500 million" with "1 billion" throughout Decree 68/2026/NĐ-CP (VAT exemption, PIT exemption, mandatory e-invoices).
4. **Small enterprises with annual revenue of 1 billion VND or less are CIT-exempt** from tax year 2026 (Decree 320/2025 Art. 4.15, added by Decree 141/2026 Art. 2). Relevant for one-person companies.
5. **VAT 8% instead of 10%** for most goods and services until 31 December 2026 (Resolution 204/2025/QH15 Art. 1 and 2), not for finance and banking, telecoms and some others. A payment-processing fee is therefore likely 10%, a commission or service fee likely 8% until year end.

##### Sources opened (all primary unless marked)

thuvienphapluat.vn returned HTTP 403 (bot challenge) from this session, and mof.gov.vn's Q&A portal reset the connection, so every primary source below is the official gazette (congbao.chinhphu.vn), the government document system (vanban.chinhphu.vn, datafiles.chinhphu.vn) or the government policy portal (xaydungchinhsach.chinhphu.vn), all under chinhphu.vn.

| Key | Document | URL opened |
|---|---|---|
| L108 | Law on Tax Administration 108/2025/QH15 | https://congbao.chinhphu.vn/van-ban/luat-so-108-2025-qh15-468670.htm |
| VAT | Consolidated VAT Law, 114/VBHN-VPQH (Law 48/2024 as amended by 90/2025, 149/2025, 09/2026) | https://congbao.chinhphu.vn/van-ban/van-ban-hop-nhat-so-114-vbhn-vpqh-469597.htm |
| PIT | Consolidated PIT Law, 112/VBHN-VPQH (Law 109/2025 as amended by 09/2026) | https://congbao.chinhphu.vn/van-ban/van-ban-hop-nhat-so-112-vbhn-vpqh-469595.htm |
| D117 | Decree 117/2025/NĐ-CP (platform withholding, 1 Jul 2025 to 30 Jun 2026) | https://congbao.chinhphu.vn/van-ban/nghi-dinh-so-117-2025-nd-cp-45045.htm |
| D252 | Decree 252/2026/NĐ-CP (Tax Administration detail, from 1 Jul 2026) | https://congbao.chinhphu.vn/van-ban/nghi-dinh-so-252-2026-nd-cp-469958.htm |
| D68 | Decree 68/2026/NĐ-CP (household tax policy and administration) | `` https://xaydungchinhsach.chinhphu.vn/toan-van-nghi-dinh-68-2026-nd-cp-quy-dinh-ve-chinh-sach-thue-quan-ly-thue-voi-ho-kinh-doanh-119260306102906789 ``.htm (signed PDF linked there) |
| D141 | Decree 141/2026/NĐ-CP (amends D68 and Decree 320) | https://vanban.chinhphu.vn/?amp=&docid=217960&pageid=27160 |
| D181 | Decree 181/2025/NĐ-CP (VAT detail) | https://congbao.chinhphu.vn/van-ban/nghi-dinh-so-181-2025-nd-cp-45379.htm |
| D254 | Decree 254/2026/NĐ-CP (e-invoices, from 1 Jul 2026) | https://congbao.chinhphu.vn/van-ban/nghi-dinh-so-254-2026-nd-cp-469957/66826.htm |
| C91 | Circular 91/2026/TT-BTC (e-invoices, from 1 Jul 2026) | https://congbao.chinhphu.vn/van-ban/thong-tu-so-91-2026-tt-btc-470171/67424.htm |
| CIT | Consolidated Decree 320/2025 (CIT detail), 19/VBHN-BTC | https://congbao.chinhphu.vn/van-ban/van-ban-hop-nhat-so-19-vbhn-btc-469710/65708.htm |
| TT99 | Circular 99/2025/TT-BTC (accounts 131, 133, 138: gazette 1565+1566; 511, 521, 632, 641, 711, 811: gazette 1573+1574) | https://congbao.chinhphu.vn/van-ban/thong-tu-so-99-2025-tt-btc-46529/59634.htm and https://congbao.chinhphu.vn/van-ban/thong-tu-so-99-2025-tt-btc-46529/59646.htm |
| TT133 | Circular 133/2016/TT-BTC | https://congbao.chinhphu.vn/van-ban/thong-tu-so-133-2016-tt-btc-21048.htm |
| TT152 | Circular 152/2025/TT-BTC (household accounting) | https://congbao.chinhphu.vn/van-ban/thong-tu-so-152-2025-tt-btc-468714.htm |
| TT18 | Consolidated Circular 18/2026/TT-BTC, 24/2026/VBHN-BTC (household tax forms) | https://vanban.chinhphu.vn/?classid=2629&docid=219107&pageid=27160 |
| R204 | Resolution 204/2025/QH15 (VAT cut to 8%) | https://congbao.chinhphu.vn/van-ban/nghi-quyet-so-204-2025-qh15-45219/57028.htm |
| XD-D68 | Government portal article quoting D68 Art. 11 (secondary, official) | ``` https://xaydungchinhsach.chinhphu.vn/huong-dan-khai-thue-khau-tru-thue-voi-hoat-dong-kinh-doanh-tren-nen-tang-thuong-mai-dien-tu-119260309150311529 ```.htm |
| TCTC | MOF journal article on D254 e-commerce invoicing (secondary, medium) | ```` https://thuehaiquan.tapchikinhtetaichinh.vn/nguoi-ban-tren-san-thuong-mai-dien-tu-duoc-ho-tro-them-du-lieu-de-lap-hoa-don-dien-tu-161924 ````.html |

Not read in full (only search snippets or JS pages that did not render): Circular 89/2026/TT-BTC (Tax Administration detail, from 1 July 2026; known only from search snippets and from footnotes in TT18), Shopee seller-education article https://banhang.shopee.vn/edu/article/10513 (JavaScript page, content not readable here), Lazada and TikTok fee-invoice pages (not found). Claims that rest on these are marked low.

##### Worked example used below

One order line on Shopee, consumer buyer, goods at 8% VAT (R204), seller is a VAT credit-method company (phương pháp khấu trừ):

| Field | VND |
|---|---|
| `item_price` (list price, VAT included) | 200,000 |
| Seller-funded voucher (voucher người bán) | 20,000 |
| Platform-funded voucher (voucher sàn tài trợ) | 30,000 |
| `paid_price` (buyer pays) | 150,000 |
| Consideration for the goods = 200,000 - 20,000 | 180,000 |
| Net of VAT = 180,000 / 1.08 | 166,667 |
| Output VAT (thuế GTGT đầu ra) | 13,333 |

---

#### Q1. Revenue for an order line; seller-funded and platform-funded vouchers; the e-invoice

##### Answer

- **Seller-funded voucher** is a price reduction the seller grants at the moment of sale (khuyến mại bằng hình thức giảm giá / chiết khấu thương mại). It **reduces revenue and the VAT taxable price**. Show it on the invoice as a discount line; then revenue is booked net and TT99's 521 is not used.
  - VAT: taxable price after a commercial discount is the discounted price (D181 Art. 14.2); for a promotion by price reduction it is the reduced price during the registered or notified promotion period (D181 Art. 6.2).
  - Invoice: a commercial discount or promotion must be shown clearly on the invoice (D254 Annex point 5.đ; Art. 10.1.k).
- **Platform-funded voucher** is paid by the platform, not given up by the seller: the seller still gets 180,000 for the goods (150,000 from the buyer via the platform plus 30,000 from the platform). It is a third-party part-payment of the buyer's price (or a price subsidy, trợ giá), so it **does not reduce the seller's revenue or VAT taxable price**.
  - VAT taxable price includes surcharges and extra amounts the seller is entitled to (VAT Art. 7.2; D181 Art. 14.1.a).
  - CIT revenue includes "trợ giá, phụ thu, phụ trội" the enterprise is entitled to, whether or not collected (CIT Art. 8.1).
  - Invoice: invoice the consideration of 180,000 (166,667 + VAT 13,333). Do not show the platform voucher as a seller discount; at most add a free-text note such as "Sàn hỗ trợ thanh toán 30.000 đ" (D254 Annex point 5 allows other content).
- **The test is the settlement**: if the payout statement adds the platform voucher back to the seller (for example Shopee escrow "voucher from Shopee" as income), it is platform-funded. If the payout deducts it from the seller, it is in substance seller-funded (or co-funded: split it).
- **`paid_price` is not the revenue figure.** Revenue = `item_price` minus seller-funded discounts. Fees are expenses and never net against revenue (TT99 and TT133 511 principles book revenue at the sale consideration; fees go to 641/642, see Q3).
- **Buyer identity on the invoice**: if the consumer gives no name, address or personal ID, write "Bán cho người tiêu dùng" (D254 Annex point 4.b). The platform must give the seller the buyer and transaction data, delivery time and order-completed status so the seller can invoice (D254 Art. 17.1.c, Art. 19.2).

##### Entries

**TT133** (no 521; deductions are debited straight to 511, TT133 Art. 57 section 2 "Bên Nợ: Các khoản giảm trừ doanh thu"):

| When | Nợ | Có | Amount |
|---|---|---|---|
| Delivery (Q5), seller voucher shown on invoice | 131 (detail: Shopee) | 5111 | 166,667 |
| | 131 (Shopee) | 33311 | 13,333 |
| Cost of goods | 632 | 156 (or 157 if shipped earlier) | cost |
| If the seller discount was not on the invoice (not recommended) | 5111 / 33311 | 131 (Shopee) | 18,519 / 1,481 |

**TT99** (521 used only for discounts not shown on the invoice, TT99 521 principle c):

| When | Nợ | Có | Amount |
|---|---|---|---|
| Delivery, seller voucher on invoice | 131 (Shopee) | 511 | 166,667 |
| | 131 (Shopee) | 33311 | 13,333 |
| Cost | 632 | 156 / 157 | cost |
| Discount not on invoice (e.g. later) | 521 + 33311 | 131 | 18,519 + 1,481 |
| Period end | 511 | 521 | total 521 |

**VAT direct-method company** (enterprise with revenue under 1 billion, VAT Art. 12.2.a1): revenue excludes the 1% VAT (TT133 Art. 57 point 1.5.1; TT99 511 point 1.5.1): Nợ 131 / Có 5111 at 180,000, then periodically Nợ 5111 / Có 33311 for 1% of revenue.

**Household (TT152)**: S2a-HKD (percentage method) or S2b/S2c (income method) records revenue of 180,000 per industry group (TT152 Art. 5 and 6). PIT revenue excludes trade discounts and price reductions and includes support amounts and promotions received (D68 Art. 5.1), so the same split applies.

##### Legal basis

D181 Art. 6.2, Art. 14.1.a, 14.2; VAT Art. 7.1.a, 7.2; CIT Art. 8.1; D254 Art. 10.1.k, Annex points 4.b and 5.đ, Art. 17.1.c, 19.2; TT99 accounts 511 (points 1.4, 1.5.1, 1.5.3) and 521 (principle c); TT133 Art. 57; D68 Art. 5.1.

##### Confidence

- Seller voucher reduces revenue and is shown on the invoice: **high**.
- Platform voucher stays in revenue and VAT base: **medium**. The law supports it (consideration and subsidies the seller is entitled to), but I found no published ruling that names marketplace platform vouchers. A Ministry of Finance Q&A (portal.mof.gov.vn, Q&A 164353, seen only as a search snippet, could not be opened) asks exactly this question for a case where the platform did not reimburse the seller; I could not read the answer.

##### Uncertain

- Whether a seller voucher counts as a "promotion" that must be notified under trade-promotion law; D181 Art. 6.2 last paragraph says a promotion not done under trade law is taxed like a gift (full price). Treating it as a commercial discount shown on the invoice (D181 Art. 14.2) avoids that, but an accountant should confirm.
- Coins, shipping vouchers and co-funded vouchers need a per-field mapping from each platform's settlement API; I did not verify field semantics.

---

#### Q2. Goods lost, damaged or scrapped by the carrier; platform compensation

##### Answer

- Goods lost or destroyed in transit before the buyer receives them were never sold: no revenue, no sales invoice, reverse any revenue already booked (or issue an adjusting invoice if one was issued, Q8).
- Write the goods off with a record (biên bản) and the platform's or carrier's claim decision. When the cause and the liable party are known, book directly; when not yet known, park the cost in 1381 (TT99 138 point 3.3; TT133 Art. 20 point 1.3).
- **Compensation is not a sale**: cash compensation is excluded from the VAT taxable price (D181 Art. 14.1.b) and no invoice is required for it (D254 Art. 7.8.c). The seller charges **no output VAT** and issues **no invoice** for the compensation; the platform's payout line or claim notice is the voucher (chứng từ).
- **Input VAT** on the lost goods stays deductible, including the part not compensated (VAT Art. 14.1.a; D181 Art. 23.1, which requires records proving the loss).
- **CIT**: the loss net of compensation is the cost; compensation received in a later period is income of that period. The explicit rule is for force-majeure losses (CIT Art. 9.1.g, g1, g2); a carrier's fault is not force majeure, so the deduction rests on the general conditions (actual, business-related, documented: CIT Art. 9.1.a, b).

##### Entries

**TT99** (138 point 3.3, 711 principle a):

| Case | Nợ | Có |
|---|---|---|
| Shipped to carrier (optional) | 157 | 156 |
| Lost, liable party known, compensation agreed | 1388 (Shopee/carrier) | 157 / 156 (cost) |
| | 632 (loss not compensated) | |
| Compensation above cost | 1388 | 711 (excess) |
| Lost, cause not yet known | 1381 | 157 / 156 |
| On decision | 1388 / 112 (compensation), 632 (rest) | 1381 |
| Compensation received in payout | 112 (or 131 Shopee clearing) | 1388 |
| Damaged goods returned and scrapped | 632 | 156 (net of salvage) |

**TT133**: the same codes exist (1381, 1388, 157, 632, 711; TT133 Art. 20, 29, 62, 65). TT133 Art. 20 point 1.3 says inventory lost, net of compensation, goes to 632; TT133 Art. 65 lists "thu tiền bồi thường của bên thứ ba để bù đắp cho tài sản bị tổn thất" under 711. Two acceptable presentations: (a) net: Nợ 1388 + Nợ 632 / Có 156; (b) gross: Nợ 632 / Có 156 for the full cost, and Nợ 1388 / Có 711 for the compensation. Recommend (a) up to cost and 711 only for any excess, the same in both regimes, so reports compare.

**Household**: record the loss as a cost in S2c-HKD only for income-method households (TT152 Art. 6); compensation is "bồi thường khác liên quan đến hoạt động kinh doanh", which **is PIT revenue** for households (D68 Art. 5.1). Percentage-method households: compensation counted in revenue for PIT under D68 Art. 5.1 (uncertain whether for VAT; VAT excludes it, D181 Art. 14.1.b).

##### Legal basis

D181 Art. 14.1.b, Art. 23.1; D254 Art. 7.8.c; VAT Art. 14.1.a; CIT Art. 9.1.a, b, g; TT99 138 (principles, 1381, 1388, point 3.3) and 711; TT133 Art. 20 (point 1.3), Art. 29, Art. 65; D68 Art. 5.1.

##### Confidence

No VAT on compensation and no invoice: **high**. Input VAT stays deductible: **high**. Account entries: **high** (they follow the circulars' own examples). CIT deductibility of a non-force-majeure transit loss: **medium**.

##### Uncertain

- If the platform "compensates" at the selling price for an order the buyer actually received (a dispute where the buyer keeps the goods), it is a sale, not compensation. The data must distinguish "lost before delivery" from "refund after delivery".
- Whether the compensation counts in the household's VAT turnover is unclear (PIT revenue includes it by D68 Art. 5.1; VAT base excludes it by D181 Art. 14.1.b).

---

#### Q3. Platform fees and credits

##### Answer: what each item is

| Item (Vietnamese) | Nature | TT133 | TT99 | VAT |
|---|---|---|---|---|
| Commission (phí cố định / hoa hồng) | Service bought | Nợ 6421 + 1331 | Nợ 6417 (or 6418) + 1331 | Input VAT deductible with a VAT invoice; likely 8% until 31 Dec 2026 (R204) |
| Payment / transaction fee (phí thanh toán, phí xử lý giao dịch) | Service bought | 6421 + 1331 | 6417 + 1331 | Taxable (payment services are not in VAT Art. 5.9's exempt list); finance is excluded from the 8% cut, so likely 10% |
| Service fee (phí dịch vụ, Freeship Xtra, voucher Xtra programs) | Service bought | 6421 + 1331 | 6417 + 1331 | Deductible with invoice |
| Ads (Shopee Ads, TikTok Ads) | Advertising | 6421 | 6418 or 6417 | Deductible with invoice; ads bought from a foreign entity follow the foreign-supplier rules (VAT Art. 4.4) |
| Seller-paid shipping (phí vận chuyển người bán trả) | Selling cost | 6421 + 1331 | 6417 + 1331 | Invoice from carrier or platform |
| Buyer-paid shipping the platform collects and passes to the carrier | Not the seller's money if the platform contracts the carrier for the buyer | no entry, or 131 in/out | same | none for the seller |
| Platform price subsidy (trợ giá, platform discount) | Part of the sale consideration (Q1) | 5111 | 511 | Output VAT on it (VAT Art. 7.2; CIT Art. 8.1 "trợ giá") |
| Commission rebate / fee refund, if the platform issues an adjusting (negative) invoice | Reduction of a purchase | Có 6421 + Có 1331 | Có 6417 + Có 1331 | Reverse input VAT |
| Seller incentive / bonus not tied to a specific sale, paid as cash without invoice | Bonus (tiền thưởng) | Có 711 | Có 711 | Not in VAT base (D181 Art. 14.1.b "tiền thưởng"); no invoice needed (D254 Art. 7.8.c) |
| Other taxable credits (e.g. platform buys ad space or services from the seller) | Seller's sale | 5113 + 33311 | 511 + 33311 | Seller issues a VAT invoice |

Account basis: TT133 Art. 64 (642 covers selling costs including commission, transport, advertising; sub-account 6421 "Chi phí bán hàng"); TT99 641 principles a and d (sub-accounts 6417 "Chi phí dịch vụ mua ngoài" including "tiền trả hoa hồng cho đại lý bán hàng", 6418 "Chi phí bằng tiền khác"); TT99 711 and TT133 Art. 65 (other income, including "tiền thưởng của khách hàng ... không tính trong doanh thu").

##### Entries (fees netted from the payout)

| | TT133 | TT99 |
|---|---|---|
| Monthly fee invoice received | Nợ 6421, Nợ 1331 / Có 331 (Shopee) | Nợ 6417, Nợ 1331 / Có 331 (Shopee) |
| Netting against collected sales (with the platform's settlement statement as the offset record) | Nợ 331 / Có 131 (Shopee) | Nợ 331 / Có 131 (Shopee) |
| Payout to bank | Nợ 112 / Có 131 (Shopee) | Nợ 112 / Có 131 (Shopee) |

Using 331 for the fee and offsetting it against 131 keeps the gross sale, the gross fee and the payout separately visible, which also gives the record the VAT rules want when payment is made by offset (below).

##### Is input VAT on fee invoices deductible?

Yes, for a credit-method seller, when (1) there is a VAT invoice in the seller's name and tax code (VAT Art. 14.2.a; D181 Art. 25) and (2) for purchases of 5 million VND or more (VAT included) there is a non-cash payment document (VAT Art. 14.2.b; D181 Art. 26). Fees netted from the payout are payment by offset: D181 Art. 26.2.a and 26.2.b accept offsetting when the contract provides for it and there is a reconciliation or offset record. The platform's seller agreement (which authorizes the deduction) plus its monthly settlement statement should serve as that record; keep both. Fee invoices under 5 million each need no non-cash proof (D181 Art. 26.2.h), but several invoices from one supplier on one day totalling 5 million or more do (D181 Art. 26.3).

Direct-method sellers (enterprises under 1 billion revenue, households) cannot deduct input VAT: the VAT is part of the expense.

Fee invoice timing: e-commerce services to business customers are invoiced at the end of reconciliation, no later than the 7th of the following month (D254 Art. 9.4.a). Book fees on an accrual basis at the order or month end, then match the invoice (the repo already has `marketplace-fee-accrual.ts`; I did not read it).

##### Do the platforms issue VAT invoices for fees?

- **Shopee**: yes, according to its seller-education page "Cách nhận hóa đơn điện tử từ Shopee (Hóa đơn GTGT)" (https://banhang.shopee.vn/edu/article/10513). I could not render that JavaScript page; the search snippet says Shopee invoices all service fees sellers pay (transaction, fixed, service, withdrawal and e-commerce service fees), emails them to the address in the seller's tax information, and they can be looked up from the 7th of the next month. **Low** (snippet only), consistent with D254 Art. 9.4.a.
- **Lazada**: operated in Vietnam by Công ty TNHH Recess, tax code 0308808576 (Lazada affiliate terms, https://terms.alicdn.com/legal-agreement/terms/platform_service/20230406233411842/20230406233411842.html). I found no Lazada page on fee invoices. **Unverified.**
- **TikTok Shop**: I found no primary page naming the invoicing entity or confirming fee invoices. **Unverified.** If fees are invoiced by a foreign entity, the seller gets no Vietnamese VAT invoice and the foreign-supplier rules apply (VAT Art. 4.4; D252 Art. 43.3 for credit-method buyers of a foreign supplier's services on a platform).

##### Confidence

Account mapping: **high**. Input VAT deductibility with invoice: **high**; netting as acceptable non-cash payment: **medium**. Platform-subsidy-as-revenue: **medium**. Incentives as 711 without VAT: **medium**. Which platforms invoice: **low**.

##### Uncertain

- The exact VAT rate each platform applies per fee type (8% vs 10%).
- Whether a "commission rebate" arrives as an adjusting invoice (expense reduction) or as a cash bonus (711). The data must say which; treat as 711 only when no adjusting invoice exists.
- A household seller without a tax code may get fee invoices "for a consumer", which an income-method household could not use as a deductible cost (D254 Annex point 4.b, last paragraph).

---

#### Q4. Tax withheld by platforms (Shopee, TikTok, Lazada fields)

##### Answer

**Who is withheld.** Only **household businesses and individual sellers** (hộ kinh doanh, cá nhân kinh doanh), resident or not, are withheld VAT and PIT, on platforms that have online ordering and a payment function (including COD) (L108 Art. 13.4.a; D252 Art. 43.1; before 1 July 2026 D117 Art. 2 to 4). **Foreign suppliers** selling on the platform are withheld VAT and **CIT** (D252 Art. 43.2). **Vietnamese enterprises** (công ty, including one-person companies) are **not withheld**: they declare their own VAT and CIT. So for Ludy's company users, `withholding_vat_tax`, `withholding_pit_tax`, `withholding_cit_tax`, `pit_amount`, `local_vat_amount` and `WHT_amount` should be zero; a non-zero value is an error to raise with the platform.

**When and how much.** At the moment the transaction is confirmed successful and payment accepted (D252 Art. 44.1.b; D117 Art. 5.1), on the amount the seller is entitled to that the platform collects (D252 Art. 44.2.a.2; D117 Art. 5.2.d), at the rates of the tax laws. Rates written in D117 Art. 5.2 (still the reference in D68 Art. 11.1 and Art. 18.2): VAT 1% goods, 5% services, 3% transport and goods-related services; PIT for residents 0.5% goods, 2% services, 1.5% transport; non-residents 1%, 5%, 2%; the highest rate when the type is unknown (D252 Art. 44.2.b). Cancelled or returned orders: the platform offsets the withheld tax and must pay it back to the seller (D252 Art. 45.2, Art. 46.1.d; D117 Art. 6.1, Art. 7.6).

**Does it reduce the tax the household owes? Yes:**
- PIT withheld is credited when the household computes its PIT (D68 Art. 11.3; XD-D68 quotes it).
- Under D117 Art. 11.4 (until 30 June 2026) a withheld household did not declare VAT and PIT again for those transactions.
- Households with annual revenue of 1 billion or less owe neither VAT nor PIT (D68 Art. 3.1 and 4.1 as amended by D141 Art. 1.1), so everything withheld is overpaid and is offset or refunded (D68 Art. 12.1 and 12.3; refund filed where the household lives, Art. 12.5).
- Households above 1 billion on the percentage method pay PIT at 0.5% only on revenue above 1 billion (PIT Art. 7.3.a and b; D68 Art. 4.3), so the platform's 0.5% on every sale over-withholds about 5 million per year (0.5% x 1 billion): offset or refund (D68 Art. 12.3). Income-method households (15% to 20% of profit, PIT Art. 7.2) credit the withheld PIT in the annual finalization (D68 Art. 11.3).
- The 1-billion test counts platform revenue too (D68 Art. 8.1.b: "bao gồm cả doanh thu đã được tổ chức, cá nhân khấu trừ, khai thay, nộp thay").

**Field meaning (low confidence: platform docs not opened):**
- Shopee `withholding_vat_tax` / `withholding_pit_tax`: VAT and PIT withheld from a household or individual. `withholding_cit_tax`: CIT withheld, which the law allows only for foreign suppliers (D252 Art. 43.2).
- TikTok `local_vat_amount` / `pit_amount`: VAT and PIT withheld from a household or individual (the name "local" suggests the domestic-seller case).
- Lazada `WHT_amount`: withholding tax. `VAT_in_amount`: the name suggests VAT included in Lazada's fee ("VAT in"), which would be **input VAT on fees**, not withholding. Verify against Lazada's API docs before mapping.

##### Entries

**Company (TT133 or TT99)**: normally none. If a platform wrongly withholds: Nợ 1388 (Shopee, tax wrongly withheld) / Có 131 (Shopee); clear it when refunded (Nợ 112 / Có 1388). It is **not** a prepayment of the company's VAT or CIT, because the platform files it under the seller's personal or household identity (D252 Art. 43, 45).

**Household (TT152)**: record gross revenue in S2a-HKD (percentage method) with the VAT and PIT lines (TT152 Art. 5 point 2.1); record the withheld VAT and PIT as tax already paid, and the net payout in the cash book S2e-HKD (TT152 Art. 6 point 2.2.4). If Ludy keeps a double-entry ledger for a household on TT133 codes (the household migration's "proposal" approach), a consistent mapping is: at sale Nợ 131 (Shopee) / Có 5111 gross; tax due Nợ 5111 or 642 / Có 33311 (VAT) and Có 3335 (PIT); withheld Nợ 33311, Nợ 3335 / Có 131 (Shopee); overpayment to recover Nợ 1388 (tax to refund) / Có 33311 or 3335. These are proposals only: TT152 has no chart of accounts.

##### Legal basis

L108 Art. 2.1.c, 2.1.đ, Art. 12.3, Art. 13.4, Art. 52.2; D252 Art. 43 to 46, Art. 74.3.d; D117 Art. 2, 4, 5, 6, 7, 10, 11 (for transactions until 30 June 2026); D68 Art. 3, 4, 8.1, 11, 12 as amended by D141 Art. 1; PIT Art. 7; VAT Art. 4.5; TT152 Art. 5, 6; TT18 Art. 4 and 5 (household returns and refund forms; points on withholding forms repealed by Circular 89/2026 from 1 July 2026, per TT18's consolidated footnotes).

##### Confidence

Who is withheld and that it counts as tax paid for households: **high**. Over-withholding and refund under the 1-billion rule: **high** on the law, **medium** on how the tax office applies it automatically. Field semantics: **low**.

##### Uncertain

- Circular 89/2026/TT-BTC (the implementing circular from 1 July 2026, said to cover platform withholding returns in its Art. 33 and Appendix I form 01/CNKD-NCCNN-TMĐT) was **not opened**; only search snippets. Its content on certificates and auto-crediting to the household's e-tax account needs a read.
- D252 does not repeat D117 Art. 11.4 ("no need to declare again") for households; D68 Art. 11 and the TT18 forms govern. Whether a percentage-method household above 1 billion still files VAT and PIT returns including platform revenue and then credits the withheld amounts, or omits that revenue, is not settled by what I read.
- Whether platforms apply the 20% household VAT reduction (Decree 174/2025, not opened) to the 1% rate.
- An individual or household whose total revenue stays at or under 1 billion still suffers withholding; the refund needs a filing.

---

#### Q5. Revenue recognition date and e-invoice date

##### Answer

- **E-invoice date** for goods = the time ownership or the right to use passes to the buyer, whether or not paid (D254 Art. 9.1). VAT arises at the same time or at invoicing (VAT Art. 8.1.a). CIT revenue arises at transfer of ownership (CIT Art. 8.2.a).
- For a marketplace delivery to a consumer this is in practice the **successful-delivery date** reported by the platform; D254 Art. 17.1.c and Art. 19.2 entitle the seller to "thời điểm giao hàng và xác nhận trạng thái hoàn tất đơn hàng" from the platform precisely to set the invoice date. Handover to the platform's carrier is not delivery to the buyer: the goods stay in 157 (TT133 Art. 29; TT99 157).
- The invoice must be sent to the tax authority (code issued, or data transmitted) no later than the next working day after the invoice date (D254 Annex point 7).
- **Accounting revenue**:
  - TT99 511 point 1.2.a: five conditions (risks and rewards passed, no control, amount reasonably certain, benefits probable, costs identifiable). Recognize at delivery.
  - **TT133 Art. 57 point 1.2.a adds**: when the contract gives the buyer a right to return goods under specific conditions, recognize revenue only when those conditions no longer exist (except exchanges). Read literally, a TT133 seller recognizes revenue after the marketplace return window ends. TT99's text dropped this clause (it keeps it only for services).
- Consequence for TT133: the invoice date (delivery) and the accounting revenue date (end of return window) can differ. Practical options: (a) recognize at delivery and treat returns as revenue deductions (most SMEs do this; tax follows the invoice date anyway); or (b) follow TT133 literally and hold the sale in 131/3387-style deferral until the window closes. Recommend (a) with an accountant sign-off, because tax revenue follows the invoice and (a) keeps book and tax aligned.
- **Households** under 1 billion need not use e-invoices (D68 Art. 8.5 as replaced by D141 Art. 1.2; D254 Art. 6.1.d); above 1 billion they must use tax-authority-coded e-invoices or cash-register e-invoices. Households at 1 billion or more on platforms may delegate invoicing to the platform (D254 Art. 4.5, Art. 19; TCTC article, secondary).

##### Entries

**TT133**: on handover to carrier Nợ 157 / Có 156; on delivery Nợ 131 / Có 5111, Có 33311; Nợ 632 / Có 157. **TT99**: identical codes (157, 131, 511, 33311, 632).

##### Legal basis

D254 Art. 9.1, Art. 17.1.c, Art. 19.2, Annex point 7; VAT Art. 8.1.a; CIT Art. 8.2.a; TT133 Art. 57 point 1.2.a, Art. 29; TT99 511 point 1.2, 157; D68 Art. 8.5 (as amended); D254 Art. 6.1.d.

##### Confidence

Invoice at delivery: **high** on the rule, **medium** on "delivery" as the transfer point (the platform terms decide where ownership passes; I did not read Civil Code or Commercial Law delivery articles). TT133 return-right clause: **high** that it exists, **medium** on how strictly auditors apply it to marketplace returns.

##### Uncertain

- Cash on delivery vs prepaid orders: both invoice at delivery (payment is irrelevant, D254 Art. 9.1).
- Whether a platform's "completed" status (after the buyer's confirmation or auto-confirm) or the carrier's "delivered" status is the better proxy. Use the earliest proof of delivery; keep both timestamps.

---

#### Q6. Unpaid payout lines: recognize a receivable?

##### Answer

Yes. Accounting is accrual-based: revenue is recognized when earned, "không phân biệt đã thu được tiền hay chưa" for CIT (CIT Art. 8.1) and VAT (VAT Art. 8.1), and the receivable sits in 131 until the platform pays out (TT99 131 principle a and point 3.1; TT133 Art. 17). Payout lines not yet released (escrow, hold for the return window) are a receivable; fees and withheld tax on those lines are recognized at the same time (expense matching, TT99 "Nguyên tắc kế toán các khoản chi phí" points 1 and 2).

Which account: the buyer has paid the platform, which collects on the seller's behalf ("thu hộ", D117 Art. 5.2.d; D252 Art. 44.2.a.2). Two defensible options:
- **131 with a detail per platform** (simple, matches how SMEs reconcile; TT133 Art. 17 point 1.b and TT99 131 point b require detail per counterparty).
- **1388 "phải thu khác: tiền sàn thu hộ"** once the buyer has paid, because the debtor is then the platform as collection agent, not a customer (TT99 138 principle: other receivables outside 131; 1388 detail).
Recommend 131 detailed by platform (one clearing per platform and payout cycle) for both regimes, and disclose it; it keeps aging, bad-debt provisioning and B01 presentation simple. A credit balance in 131 per platform (refunds above sales) is shown on the liabilities side (TT99 131 structure, last paragraph).

##### Entries (TT133 and TT99 identical)

| Event | Nợ | Có |
|---|---|---|
| Delivery | 131 (Shopee) | 511/5111, 33311 |
| Fees accrued | 6421 (TT133) / 6417 (TT99), 1331 | 331 (Shopee) |
| Offset at settlement | 331 (Shopee) | 131 (Shopee) |
| Payout | 112 | 131 (Shopee) |
| Payout never comes (dispute) | 642 / 6422 or provision 2293 (TT99) / 2293 (TT133) | 131 |

##### Confidence

Recognize the receivable: **high**. 131 vs 1388 for the platform: **medium** (both appear defensible; no rule names marketplaces).

##### Uncertain

Whether a platform's "pending" lines that may still be reversed by returns warrant an allowance; that is an estimate, not a rule.

---

#### Q7. VND rounding on e-invoices and in the books

##### Answer

- **No general rounding rule** exists in the e-invoice decree or circular. The only explicit rounding permission in D254 is for airlines (round to thousands, IATA; Annex point 5.e).
- Invoices show amounts in VND in Arabic numerals and the total also in Vietnamese words (D254 Annex points 5.c, 5.d, 8.c). The VAT total is shown **per VAT rate** and in total (D254 Art. 10.1.đ; Annex point 5).
- Decimal digits are allowed in display: "nếu có ghi chữ số sau chữ số hàng đơn vị đặt dấu phẩy (,)" (D254 Annex point 8.b), so unit prices may carry decimals (for example 166.666,67).
- The accounting currency unit is the dong, symbol "đ" / VND (TT99 Art. 4.1; TT133 Art. 5).
- Practical rule to implement (my recommendation, not law): keep line amounts in decimal strings; compute VAT per invoice per rate on the sum of net line amounts (matches "tổng số tiền thuế theo từng loại thuế suất"); round the VAT and the net to whole dong half-up; make the total = net + VAT so the total equals what the buyer pays (`paid_price` plus platform contribution). When the platform's VAT-inclusive price does not split exactly, put the 1-dong difference in the net amount, not the VAT. Book whole dong in the ledger.
- For a VAT-inclusive price the split formula is net = price / (1 + rate) (VAT Art. 7.1.k).

##### Entries

No special account. Differences of one dong arising between the platform settlement and the ledger: Nợ 811 / Có 131 or Nợ 131 / Có 711 (TT133 Art. 65, 66; TT99 711, 811). Better to avoid them by deriving the invoice from the settlement amounts.

##### Confidence

No explicit rule: **high** (searched D254, C91, D181, the VAT Law, TT99 and TT133 texts for "làm tròn" and found only the airline clause). The recommended method: **low to medium** (a practice, not a rule).

##### Uncertain

The tax authority's XML invoice standard may constrain decimals per field; I did not open the data-format decision.

---

#### Q8. Returns and refunds after the period closes

##### Answer

**Accounting** (both regimes, same wording):
- Same period: reduce revenue of that period.
- Return occurs in a later period but **before the financial statements are issued**: an adjusting event after the reporting date; reduce revenue in the statements of the earlier period.
- Return occurs **after the financial statements are issued**: reduce revenue of the period in which it occurs.
(TT133 Art. 57 point 1.4; TT99 511 point 1.4 and 521 principle b.)

**Tax and invoice**:
- For a return of all or part of the goods (including an exchange that changes value), the **seller issues an adjusting e-invoice** (hóa đơn điều chỉnh), unless the parties agreed the buyer issues a return invoice (C91 Art. 10.5.c.1). The value is shown as negative (C91 Art. 10.6.c).
- The seller **declares the adjusting invoice in the period it is issued**; the buyer in the period received (C91 Art. 10.6.d). So no amendment of the earlier VAT return is needed.
- No written agreement with the buyer is required for sales on e-commerce platforms (C91 Art. 10.1.b, last paragraph); for consumers the seller notifies the buyer or posts on its website.
- Both sides must keep the return documents (C91 Art. 10.5.c, last paragraph): keep the platform's return or refund record.
- An order cancelled **before delivery** never had an invoice: nothing to adjust.
- A refund without return (partial refund for a defect) is a price reduction (giảm giá hàng bán): also an adjusting invoice (C91 Art. 10.1.b, money amount wrong) and a revenue deduction.
- For withheld households: the platform offsets the withheld tax of returned orders and pays it back (D252 Art. 45.2, Art. 46.1.d).
- Invoices issued before 1 July 2026 under Decree 123/70 and Circular 32 are adjusted "theo quy định" (C91 Art. 24.2); in practice the adjusting invoice is now made under C91.

##### Entries

**TT133** (no 521):

| Event | Nợ | Có |
|---|---|---|
| Goods back in stock | 156 | 632 |
| Revenue reversal | 5111 | 131 (Shopee) |
| Output VAT reversal | 33311 | 131 (Shopee) |
| Return shipping borne by seller | 6421, 1331 | 331 / 131 |
| Goods damaged, scrapped | 632 | 156 |

**TT99**:

| Event | Nợ | Có |
|---|---|---|
| Goods back in stock | 156 | 632 |
| Revenue deduction | 521 | 131 (Shopee) |
| VAT | 33311 | 131 (Shopee) |
| Return costs | 641 (6417) | 111 / 112 / 331 (TT99 521 point 3.b) |
| Period end | 511 | 521 |

If the return belongs to an earlier, already closed year whose statements are issued, post in the current period (above). If statements are not yet issued, post in the old period (the period-lock design in Ludy must allow a controlled "post-closing adjusting event" entry, or the accountant reopens the period).

##### Legal basis

TT133 Art. 57 point 1.4; TT99 511 point 1.4, 521 principle b and point 3.b; C91 Art. 10.1.b, 10.5.c.1, 10.6.c, 10.6.d, Art. 24.2; D252 Art. 45.2, 46.1.d.

##### Confidence

Accounting rule: **high**. Adjusting invoice and declaring in the issue period: **high**. No written agreement for e-commerce: **high**.

##### Uncertain

- CIT: whether a return after the tax year closes reduces the old year's taxable revenue (amended CIT return) or the new year's. The accounting rule above points to the new year once statements are issued, and VAT follows the adjusting invoice's period; for CIT I did not find an explicit rule in what I read (Circular 20/2026/TT-BTC not opened).
- TT133's return-right recognition rule (Q5) would make most in-window returns pre-revenue, which changes this answer for literal TT133 users.

---

#### Summary of confidence

| Q | Core answer | Confidence |
|---|---|---|
| 1 | Seller voucher reduces revenue and is on the invoice; platform voucher stays in revenue and VAT base | high / medium |
| 2 | Write-off via 1388/1381 and 632; compensation has no VAT and no invoice; input VAT stays deductible | high |
| 3 | Fees to 6421 (TT133) or 6417/6418 (TT99) with 1331; incentives 711; subsidy is revenue; Shopee invoices fees, others unverified | high / medium / low |
| 4 | Withholding only for households, individuals and foreign suppliers; it is tax paid for households, refundable under 1 billion; companies should see zero | high (law), low (field semantics) |
| 5 | Invoice at transfer of ownership, in practice delivery; TT133 has a return-window recognition clause TT99 dropped | high / medium |
| 6 | Yes, receivable in 131 detailed per platform | high / medium |
| 7 | No general rounding rule; VAT per rate per invoice; whole dong in books | high / low |
| 8 | Revenue deduction per TT133/TT99 timing; adjusting invoice declared when issued; no written agreement needed on platforms | high |

#### Items for the accountant (#61) and the owner

1. Confirm the platform-voucher treatment (Q1) and whether to show the platform contribution as a note on the invoice.
2. Choose TT133 recognition at delivery vs end of return window (Q5).
3. Confirm 131-per-platform vs 1388 for platform clearing (Q6).
4. Read Circular 89/2026/TT-BTC (Art. 33 and Appendix I) and Decree 174/2025 before finalizing the household flow (Q4).
5. Get each platform's fee-invoice issuer and VAT rate per fee type (Q3).
