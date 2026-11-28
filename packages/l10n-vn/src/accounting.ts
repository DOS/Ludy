// TT133/2016 suggestions for purchase invoices: debit account per line, VAT input account, payable.
import { money, sum, toMoney, type Money } from './money.ts';
import { lineContribution, type InvoiceCheck, type InvoiceLine, type ParsedInvoice } from './invoice.ts';
import { parseVatRate } from './vat-rate.ts';

export const PAYABLE_ACCOUNT = '331';
export const VAT_INPUT_GOODS = '1331';
export const VAT_INPUT_ASSETS = '1332';
export const FIXED_ASSETS = '211';
// 211 or one of its sub-accounts (2111, 211.XE): a sub-account's code starts with its parent's (#319).
export function isFixedAssetAccount(code: string): boolean {
  return code.startsWith(FIXED_ASSETS);
}
export const FIXED_ASSET_THRESHOLD = '30000000';

// What chose a line's account (#1399), shown on the line: a learned rule (ludy_finance.categorization_rule), the
// vendor's default account, the built-in keyword list, or a user who picked it on a revision. A line no rule matched
// has none of these and is 'unclassified' (#2091).
// 'unclassified' (#2091) is no source of an account: it marks a line that no rule matched, which a reviewer must classify.
const ACCOUNT_RULE_SOURCES = ['learned', 'vendor_default', 'builtin', 'user', 'unclassified'] as const;
export type AccountRuleSource = (typeof ACCOUNT_RULE_SOURCES)[number];
const RULE_MATCH_KINDS = ['description', 'keyword'] as const;
export type RuleMatchKind = (typeof RULE_MATCH_KINDS)[number];
export interface AccountRule {
  source: AccountRuleSource;
  // A learned rule: its id, whether it is the vendor's own or applies to every vendor, and what it matched.
  ruleId?: string | undefined;
  scope?: 'vendor' | 'org' | undefined;
  matchKind?: RuleMatchKind | undefined;
}

export interface AccountSuggestion {
  account: string;
  reason: string;
  rule: AccountRule;
}

// A learned rule as the suggestion reads it: `text` is in normalized form (normalizeRuleText), `vendor` is true for a
// rule of this invoice's vendor/customer and false for one that applies to every vendor/customer. `direction` defaults
// to 'purchase' when omitted by callers/tests that build purchase rules directly.
export interface LearnedRule {
  id: string;
  vendor: boolean;
  kind: RuleMatchKind;
  text: string;
  label: string | null;
  account: string;
  direction?: 'purchase' | 'sale' | undefined;
}

// Same rule as isRevenueAccount in @ludy/kernel-contract (which this package does not depend on).
const isRevenueAccountCode = (code: string): boolean => /^(5|711|3387)/.test(code);

// The longest text a rule matches (the database CHECK on ludy_finance.categorization_rule.match_text says the same).
export const RULE_TEXT_MAX = 200;

// The form rules are matched in: lower case, Vietnamese marks stripped and đ read as d, every character other than an
// ASCII letter or digit a separator, single spaces. Matching is plain string comparison on this form, so no pattern
// built from user input is ever compiled.
export function normalizeRuleText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// At most RULE_TEXT_MAX characters, cut at a word boundary when there is one.
function cutWords(text: string): string {
  if (text.length <= RULE_TEXT_MAX) return text;
  const cut = text.slice(0, RULE_TEXT_MAX + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : text.slice(0, RULE_TEXT_MAX)).trim();
}

// The text a description rule learns from a line, or null when too little is left. Words with a digit are dropped
// (a month, an invoice or contract number, a quantity), so next month's "Cước internet tháng 11/2026" is the same item
// as this month's "Cước internet tháng 10/2026".
export function descriptionRuleText(description: string): string | null {
  const words = normalizeRuleText(description)
    .split(' ')
    .filter((w) => w.length > 0 && !/[0-9]/.test(w));
  const text = cutWords(words.join(' '));
  return text.length >= 2 ? text : null;
}

// The text of a keyword rule as a member typed it, or null when too little is left.
export function keywordRuleText(keyword: string): string | null {
  const text = cutWords(normalizeRuleText(keyword));
  return text.length >= 2 ? text : null;
}

// The rule of one scope (the vendor's own, or every vendor's) that matches a line: a description rule for the same item
// first, then the keyword rule whose words appear in the description as whole words, the longest keyword winning and
// the first in `rules` order on a tie (the lookup orders them by when they were confirmed, newest first).
export function matchLearnedRule(description: string, rules: readonly LearnedRule[], vendor: boolean): LearnedRule | null {
  const item = descriptionRuleText(description);
  if (item !== null) {
    const same = rules.find((r) => r.vendor === vendor && r.kind === 'description' && r.text === item);
    if (same) return same;
  }
  const words = ` ${normalizeRuleText(description)} `;
  let best: LearnedRule | null = null;
  for (const rule of rules) {
    if (rule.vendor !== vendor || rule.kind !== 'keyword') continue;
    if (best !== null && rule.text.length <= best.text.length) continue;
    if (words.includes(` ${rule.text} `)) best = rule;
  }
  return best;
}

function learnedSuggestion(rule: LearnedRule, direction: 'purchase' | 'sale' = 'purchase'): AccountSuggestion {
  const shown = rule.label?.trim() || rule.text;
  const partyPhrase = direction === 'sale' ? 'của khách hàng này' : 'của nhà cung cấp này';
  const reason =
    rule.kind === 'description'
      ? rule.vendor
        ? `Theo quy tắc đã học: cùng mặt hàng ${partyPhrase}`
        : 'Theo quy tắc đã học: cùng mặt hàng'
      : rule.vendor
        ? `Theo quy tắc đã học: từ khóa "${shown}" ${partyPhrase}`
        : `Theo quy tắc đã học: từ khóa "${shown}"`;
  return {
    account: rule.account,
    reason: reason.slice(0, 500),
    rule: { source: 'learned', ruleId: rule.id, scope: rule.vendor ? 'vendor' : 'org', matchKind: rule.kind },
  };
}

const RULES: Array<{ account: string; pattern: RegExp; reason: string }> = [
  { account: '6421', pattern: /quảng cáo|marketing|vận chuyển|giao hàng|hoa hồng|khuyến mãi|ads|facebook|google/i, reason: 'Chi phí bán hàng' },
  { account: '153', pattern: /công cụ|dụng cụ|bàn|ghế|kệ|tủ|dao|kéo|chuột|bàn phím/i, reason: 'Công cụ, dụng cụ' },
  { account: '152', pattern: /nguyên liệu|vật liệu|nguyên vật liệu|phụ liệu/i, reason: 'Nguyên liệu, vật liệu' },
  {
    account: '6422',
    pattern: /dịch vụ|phí|cước|điện|nước|internet|viễn thông|thuê|bảo trì|sửa chữa|phần mềm|hosting|tên miền|văn phòng phẩm|tư vấn|kế toán|kiểm toán/i,
    reason: 'Chi phí quản lý doanh nghiệp',
  },
  { account: '156', pattern: /hàng hóa|sản phẩm|hàng/i, reason: 'Hàng hóa' },
];

// The built-in keyword list under Circular 99 (#1403): the same words, with the expense accounts TT99 has. TT99 splits 641 and 642 by nature where TT133 splits them by function, and its 6421 and 6422 mean staff and materials
// of administration. So TT133's 6421 (selling) becomes 6418 for advertising and introducing products and 6417 for transport and agents' commission, and 6422 (administration) becomes 6427 (outside services of
// administration), except stationery, which Appendix II puts in 6422 itself (vật liệu quản lý, "văn phòng phẩm"). Read from the account principles of 641 and 642 in Circular 99/2025/TT-BTC (Công báo 1573 + 1574,
// pages 64 to 70); no accountant has confirmed these picks, and a reviewer changes any line.
const RULES_TT99: Array<{ account: string; pattern: RegExp; reason: string }> = [
  { account: '6418', pattern: /quảng cáo|marketing|khuyến mãi|ads|facebook|google/i, reason: 'Chi phí bán hàng: quảng cáo, giới thiệu sản phẩm' },
  { account: '6417', pattern: /vận chuyển|giao hàng|hoa hồng/i, reason: 'Chi phí bán hàng: dịch vụ mua ngoài (vận chuyển, hoa hồng)' },
  { account: '153', pattern: /công cụ|dụng cụ|bàn|ghế|kệ|tủ|dao|kéo|chuột|bàn phím/i, reason: 'Công cụ, dụng cụ' },
  { account: '152', pattern: /nguyên liệu|vật liệu|nguyên vật liệu|phụ liệu/i, reason: 'Nguyên liệu, vật liệu' },
  { account: '6422', pattern: /văn phòng phẩm/i, reason: 'Chi phí quản lý doanh nghiệp: vật liệu quản lý (văn phòng phẩm)' },
  {
    account: '6427',
    pattern: /dịch vụ|phí|cước|điện|nước|internet|viễn thông|thuê|bảo trì|sửa chữa|phần mềm|hosting|tên miền|tư vấn|kế toán|kiểm toán/i,
    reason: 'Chi phí quản lý doanh nghiệp: dịch vụ mua ngoài',
  },
  { account: '156', pattern: /hàng hóa|sản phẩm|hàng/i, reason: 'Hàng hóa' },
];

// The accounts a Circular 133 chart and the Circular 99 chart both have but mean differently (#1403): a vendor default or a learned rule that names one was made under TT133 and must not be read as the TT99 account
// of the same code. 211 held every fixed asset under TT133 and only tangible ones under TT99; 3386 was deposits received and is unemployment insurance; 6421 and 6422 were selling and administration expenses and
// are staff and materials of administration.
export const TT133_CODES_CHANGED_IN_TT99: readonly string[] = ['211', '3386', '6421', '6422'];

const ASSET_PATTERN = /máy|thiết bị|xe |ô tô|laptop|máy tính|server|điều hòa/i;

// The account proposed for a line (#1399), most specific first: a learned rule of this vendor (the same item, then a
// keyword), the vendor's default account, a learned rule for every vendor, then the built-in keyword list. The
// vendor's own rules come before its default: the default is one account for the whole vendor, and a vendor that sells
// both goods and services needs its lines told apart.
// Under the books regime `tt99` (#1403) the built-in list is TT99's (RULES_TT99) and a declared discount is not guessed: its account depends on what it reduces, which no accountant has said, so the line waits for a reviewer.
// The caller passes only the default and the rules whose account is in the regime's chart.
export function suggestDebitAccount(
  line: InvoiceLine,
  vendorDefault: string | null,
  rules: readonly LearnedRule[] = [],
  // Whether the line's nature was declared by the invoice (an e-invoice's TChat) and not read by a model.
  declared = false,
  // The books regime the purchase is posted under on its date; none is TT133.
  regime?: string,
): AccountSuggestion {
  const purchaseRules = rules.filter((r) => r.direction !== 'sale');
  const own = matchLearnedRule(line.description, purchaseRules, true);
  if (own) return learnedSuggestion(own, 'purchase');
  if (vendorDefault) return { account: vendorDefault, reason: 'Theo lần duyệt trước của nhà cung cấp này', rule: { source: 'vendor_default' } };
  const shared = matchLearnedRule(line.description, purchaseRules, false);
  if (shared) return learnedSuggestion(shared, 'purchase');
  const builtin = { source: 'builtin' } as const;
  if (ASSET_PATTERN.test(line.description) && money(line.amount).greaterThanOrEqualTo(FIXED_ASSET_THRESHOLD)) {
    return { account: '211', reason: 'Giá trị từ 30 triệu, có thể là tài sản cố định', rule: builtin };
  }
  const tt99 = regime === 'tt99';
  for (const rule of tt99 ? RULES_TT99 : RULES) {
    if (rule.pattern.test(line.description)) return { account: rule.account, reason: rule.reason, rule: builtin };
  }
  // A line the invoice itself declares a discount (TChat 3) is not a guess: it keeps the built-in account it always had,
  // shown as built-in on the line, for the reviewer to change. A nature a model read from a photo or PDF is not a
  // declaration (injected text could set it), so that line is unclassified like any other no rule matches.
  if (declared && line.nature === 'discount' && !tt99) return { account: '6422', reason: 'Chiết khấu ghi giảm chi phí quản lý doanh nghiệp', rule: builtin };
  // No rule matched: never a guessed account (#2091). The line carries a placeholder no chart holds, which finance
  // refuses to post, so a reviewer has to choose the account. AI never picks it.
  return { account: UNCLASSIFIED_ACCOUNT, reason: UNCLASSIFIED_REASON, rule: { source: 'unclassified' } };
}

// The account of a line no rule matched (#2091): a placeholder that satisfies the account code shape but is in no chart
// (TT133's off-balance accounts are 001 to 008), so posting it is refused twice: by the line's own mark and by the
// account check. The proposal's journal draft shows it until a reviewer picks the real account.
export const UNCLASSIFIED_ACCOUNT = '000';
export const UNCLASSIFIED_REASON = 'Chưa phân loại: không khớp quy tắc nào, cần chọn tài khoản';

// Whether a proposed line still waits for its account (#2091): marked by the suggestion, or carrying the placeholder.
export function isUnclassifiedLine(line: { debitAccount: string; accountRule?: { source: string } | undefined }): boolean {
  return line.accountRule?.source === 'unclassified' || line.debitAccount === UNCLASSIFIED_ACCOUNT;
}

// The line numbers still waiting for an account, in line order.
export function unclassifiedLineNos(lines: ReadonlyArray<{ lineNo: number; debitAccount: string; accountRule?: { source: string } | undefined }>): number[] {
  return lines.filter(isUnclassifiedLine).map((l) => l.lineNo);
}

// The deterministic check on the account of every line (#2091), id 'accounts': a warning naming the lines no rule
// matched, a pass once every line has its account (a reviewer picked the rest), and nothing for a proposal with no
// lines. The warning does not decide: finance.purchase.record refuses an unclassified line whatever the check says.
export function classificationCheck(lines: ReadonlyArray<{ lineNo: number; debitAccount: string; accountRule?: { source: string } | undefined }>): InvoiceCheck | null {
  if (lines.length === 0) return null;
  const waiting = unclassifiedLineNos(lines);
  if (waiting.length === 0) {
    return { id: 'accounts', status: 'pass', code: 'accounts.classified', message: 'Mọi dòng đã có tài khoản hạch toán' };
  }
  // At most CHECK_LINES_SHOWN numbers are named (params hold 200 characters); the count stays whole.
  const shown = waiting.slice(0, CHECK_LINES_SHOWN).join(', ');
  const list = waiting.length > CHECK_LINES_SHOWN ? `${shown}, ...` : shown;
  return {
    id: 'accounts',
    status: 'warn',
    code: 'accounts.unclassified',
    params: { count: String(waiting.length), lines: list },
    message: `Chưa phân loại ${waiting.length} dòng (dòng ${list}): không khớp quy tắc nào, hãy chọn tài khoản trước khi duyệt`,
  };
}
const CHECK_LINES_SHOWN = 20;

export interface ProposedLine {
  lineNo: number;
  description: string;
  unit: string | null;
  quantity: Money | null;
  unitPrice: Money | null;
  amount: Money;
  vatRate: string | null;
  debitAccount: string;
  reason: string;
  // What chose debitAccount (#1399); absent on proposals made before.
  accountRule?: AccountRule | undefined;
}

export interface JournalLineDraft {
  lineNo: number;
  accountCode: string;
  debit: Money;
  credit: Money;
  memo: string;
}

// Lines that carry value for bookkeeping (notes and promotions with no amount are dropped).
export function bookableLines(invoice: ParsedInvoice, vendorDefault: string | null, rules: readonly LearnedRule[] = [], regime?: string): ProposedLine[] {
  return invoice.lines
    .filter((l) => !money(lineContribution(l)).isZero())
    .map((l) => {
      const suggestion = suggestDebitAccount(l, vendorDefault, rules, invoice.source === 'einvoice_xml', regime);
      return {
        lineNo: l.lineNo,
        description: l.description,
        unit: l.unit,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: lineContribution(l),
        vatRate: l.vatRate,
        debitAccount: suggestion.account,
        reason: suggestion.reason,
        accountRule: suggestion.rule,
      };
    });
}

// Purchase on credit: Dr expense/inventory lines, Dr input VAT, Cr payable (331) for the total.
export function buildPurchaseJournal(lines: ProposedLine[], vatTotal: Money, memo: string): JournalLineDraft[] {
  const byAccount = new Map<string, ReturnType<typeof money>>();
  for (const line of lines) {
    byAccount.set(line.debitAccount, (byAccount.get(line.debitAccount) ?? money(0)).plus(money(line.amount)));
  }
  const drafts: JournalLineDraft[] = [];
  let lineNo = 1;
  for (const [account, value] of [...byAccount.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (value.isZero()) continue;
    drafts.push(value.isNegative()
      ? { lineNo: lineNo++, accountCode: account, debit: '0', credit: toMoney(value.negated()), memo }
      : { lineNo: lineNo++, accountCode: account, debit: toMoney(value), credit: '0', memo });
  }
  const vat = money(vatTotal);
  const assetVat = fixedAssetVat(lines, vat);
  for (const [account, value] of [[VAT_INPUT_GOODS, vat.minus(assetVat)], [VAT_INPUT_ASSETS, assetVat]] as const) {
    if (value.isZero()) continue;
    drafts.push(value.isNegative()
      ? { lineNo: lineNo++, accountCode: account, debit: '0', credit: toMoney(value.negated()), memo: `Thuế GTGT ${memo}` }
      : { lineNo: lineNo++, accountCode: account, debit: toMoney(value), credit: '0', memo: `Thuế GTGT ${memo}` });
  }
  const net = sum(drafts.map((d) => money(d.debit).minus(money(d.credit))));
  if (!net.isZero()) {
    drafts.push(net.isPositive()
      ? { lineNo: lineNo++, accountCode: PAYABLE_ACCOUNT, debit: '0', credit: toMoney(net), memo }
      : { lineNo: lineNo++, accountCode: PAYABLE_ACCOUNT, debit: toMoney(net.negated()), credit: '0', memo });
  }
  return drafts;
}

// The VAT percent of a rate text (see parseVatRate); exempt, untaxed and unreadable rates count as 0.
export function vatPercent(rate: string | null): number {
  const parsed = parseVatRate(rate);
  return parsed.kind === 'unknown' ? 0 : Number(parsed.percent?.toFixed() ?? 0);
}

// Input VAT on fixed assets goes to 1332, the rest to 1331. For a mixed invoice the asset share is
// estimated from each asset line's rate, rounded to whole VND and capped at the invoice VAT.
export function fixedAssetVat(lines: Array<Pick<ProposedLine, 'debitAccount' | 'amount' | 'vatRate'>>, vat: ReturnType<typeof money>) {
  const assets = lines.filter((l) => isFixedAssetAccount(l.debitAccount));
  if (assets.length === 0 || vat.isZero()) return money(0);
  if (assets.length === lines.length) return vat;
  const estimate = sum(assets.map((l) => money(l.amount).times(vatPercent(l.vatRate)).dividedBy(100))).toDecimalPlaces(0);
  return vat.isPositive() ? minOf(maxOf(estimate, money(0)), vat) : maxOf(minOf(estimate, money(0)), vat);
}

function minOf(a: ReturnType<typeof money>, b: ReturnType<typeof money>) {
  return a.lessThan(b) ? a : b;
}

function maxOf(a: ReturnType<typeof money>, b: ReturnType<typeof money>) {
  return a.greaterThan(b) ? a : b;
}

// Sales e-invoices (issue #313): the org is the seller. TT133 posts a sale on credit as Dr 131 (receivable from the
// customer) for the total, Cr 511 (revenue) for the goods and services, Cr 3331 (output VAT) for the tax.
export const RECEIVABLE_ACCOUNT = '131';
export const REVENUE_ACCOUNT = '511';
export const VAT_OUTPUT = '3331';

// The revenue account proposed for a sales line (#1452), most specific first: a learned sales rule of this customer
// (same item, then keyword), a learned sales rule for every customer, then the built-in 511 revenue account. Purchase
// rules and non-revenue accounts are ignored so a sales rule can never propose a non-revenue account and a purchase
// rule can never apply to a sale.
export function suggestSalesAccount(line: InvoiceLine, rules: readonly LearnedRule[] = []): AccountSuggestion {
  const salesRules = rules.filter((r) => r.direction !== 'purchase' && isRevenueAccountCode(r.account));
  const own = matchLearnedRule(line.description, salesRules, true);
  if (own) return learnedSuggestion(own, 'sale');
  const shared = matchLearnedRule(line.description, salesRules, false);
  if (shared) return learnedSuggestion(shared, 'sale');
  return { account: REVENUE_ACCOUNT, reason: 'Doanh thu bán hàng và cung cấp dịch vụ', rule: { source: 'builtin' } };
}

// Lines of a sales invoice that carry value for bookkeeping: each line uses learned sales rules before 511 (#1452).
export function bookableSaleLines(invoice: ParsedInvoice, rules: readonly LearnedRule[] = []): ProposedLine[] {
  return invoice.lines
    .filter((l) => !money(lineContribution(l)).isZero())
    .map((l) => {
      const suggestion = suggestSalesAccount(l, rules);
      return {
        lineNo: l.lineNo,
        description: l.description,
        unit: l.unit,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: lineContribution(l),
        vatRate: l.vatRate,
        debitAccount: suggestion.account,
        reason: suggestion.reason,
        accountRule: suggestion.rule,
      };
    });
}

// Revenue deductions under Circular 99 (#3712 slice 4, research C3): a sale's returns, trade discounts and price reductions are debited to 521, one account (never 5211 to 5213), and closed to
// 511 at period end. Circular 133 has no 521 and debits the revenue account itself.
export const REVENUE_DEDUCTION_TT99 = '521';

// Sale on credit: Cr revenue per account (a net discount becomes a debit), Cr output VAT, Dr receivable (131) for the
// total. `debitAccount` of a sale line is the account the line is posted to, here a revenue (credit) account.
// Under the books regime `tt99` the net reduction of a sales-revenue account (511 or a sub-account: a credit invoice or an adjustment that lowers it) is debited to 521 instead, as one line;
// any other regime (tt133, or none given) keeps the revenue account. The output VAT stays on 3331 either way.
export function buildSalesJournal(lines: ProposedLine[], vatTotal: Money, memo: string, regime?: string): JournalLineDraft[] {
  const byAccount = new Map<string, ReturnType<typeof money>>();
  for (const line of lines) {
    byAccount.set(line.debitAccount, (byAccount.get(line.debitAccount) ?? money(0)).plus(money(line.amount)));
  }
  let deducted = money(0);
  if (regime === 'tt99') {
    const lowered: string[] = [];
    for (const [account, value] of byAccount) {
      if (account.startsWith(REVENUE_ACCOUNT) && value.isNegative()) {
        deducted = deducted.plus(value.negated());
        lowered.push(account);
      }
    }
    for (const account of lowered) byAccount.delete(account);
  }
  const credits: Array<Omit<JournalLineDraft, 'lineNo'>> = [];
  const credit = (account: string, value: ReturnType<typeof money>, text: string) => {
    if (value.isZero()) return;
    credits.push(value.isNegative()
      ? { accountCode: account, debit: toMoney(value.negated()), credit: '0', memo: text }
      : { accountCode: account, debit: '0', credit: toMoney(value), memo: text });
  };
  for (const [account, value] of [...byAccount.entries()].sort(([a], [b]) => a.localeCompare(b))) credit(account, value, memo);
  // One 521 debit for every deducted revenue account (zero when none), after the revenue lines and before the VAT, as the entry is read.
  credit(REVENUE_DEDUCTION_TT99, deducted.negated(), memo);
  credit(VAT_OUTPUT, money(vatTotal), `Thuế GTGT ${memo}`);
  // The receivable comes first, as an accountant writes a sale.
  const net = sum(credits.map((d) => money(d.credit).minus(money(d.debit))));
  const receivable: Array<Omit<JournalLineDraft, 'lineNo'>> = net.isZero()
    ? []
    : [net.isPositive()
        ? { accountCode: RECEIVABLE_ACCOUNT, debit: toMoney(net), credit: '0', memo }
        : { accountCode: RECEIVABLE_ACCOUNT, debit: '0', credit: toMoney(net.negated()), memo }];
  return [...receivable, ...credits].map((d, i) => ({ lineNo: i + 1, ...d }));
}

export function journalIsBalanced(lines: JournalLineDraft[]): boolean {
  return sum(lines.map((l) => money(l.debit).minus(money(l.credit)))).isZero() && lines.length >= 2;
}
