import { Decimal, approxEqual, money, sum, toMoney, type Money } from './money.ts';
import { parseTaxCode } from './tax-code.ts';

// Normalized purchase invoice, produced by the e-invoice XML parser or by AI extraction.
export interface InvoiceParty {
  name: string;
  taxCode: string | null;
  address: string | null;
  email: string | null;
  phone: string | null;
}

// TChat in the e-invoice XML: 1 goods/services, 2 promotion, 3 trade discount, 4 note.
export type LineNature = 'goods' | 'promotion' | 'discount' | 'note';

export interface InvoiceLine {
  lineNo: number;
  nature: LineNature;
  code: string | null;
  description: string;
  unit: string | null;
  quantity: Money | null;
  unitPrice: Money | null;
  amount: Money;
  vatRate: string | null;
}

export interface TaxBreakdown {
  rate: string;
  taxableAmount: Money;
  vatAmount: Money;
}

// The digital signatures of an e-invoice XML (#674), verified in the crove-extract sandbox: the seller's XML-DSig
// signature and, for an invoice with a tax authority code (MCCQT), the tax authority's. The same lists are the wire
// contract in @crove/extract-contract (its tests compare them).
//   verified        every signature the invoice must carry is valid, covers the invoice data that was read, and its
//                   certificate chains to a Vietnamese national root CA shipped with Crove (no revocation check)
//   unverified      a signature is missing, broken, does not cover the data, or its certificate is not trusted;
//                   reason says which. A warning: the invoice is still read, and approving it asks for a confirmation
//   not_applicable  nothing to verify: an invoice read by AI (an unsigned cash register invoice is unverified, with
//                   the reason cash_register: its series is what the file says)
export const SIGNATURE_STATUSES = ['verified', 'unverified', 'not_applicable'] as const;
export type SignatureStatus = (typeof SIGNATURE_STATUSES)[number];
export const SIGNATURE_REASONS = [
  // The seller's signature.
  'missing',
  'malformed',
  'ambiguous',
  'not_covering',
  'digest_mismatch',
  'bad_signature',
  'unsupported_algorithm',
  'no_certificate',
  'untrusted_certificate',
  'certificate_expired',
  'signer_mismatch',
  // The tax authority's signature on an invoice with a tax authority code.
  'tax_authority_missing',
  'tax_authority_invalid',
  'tax_authority_untrusted',
  // A cash register invoice (series type M) with no signature: allowed by law, but nothing proves who issued it.
  'cash_register',
  // A document too large to verify within the parser's time limit.
  'too_large',
] as const;
export type SignatureReason = (typeof SIGNATURE_REASONS)[number];

export interface InvoiceSignature {
  status: SignatureStatus;
  // Why it is unverified or not applicable; null when verified.
  reason: SignatureReason | null;
  // The seller's certificate: its common name and its issuer's, when a certificate was read.
  signer: string | null;
  issuer: string | null;
  // When the seller signed: the signed SigningTime property, else the invoice date. ISO 8601.
  signedAt: string | null;
}

const SIGNATURE_MESSAGES: Record<SignatureReason, string> = {
  missing: 'Không có chữ ký số của người bán',
  malformed: 'Chữ ký số không đọc được theo chuẩn XML-DSig',
  ambiguous: 'Tệp có nhiều phần hóa đơn hoặc nhiều chữ ký người bán nên không xác định được phần đã ký',
  not_covering: 'Chữ ký số không bao phủ phần dữ liệu hóa đơn được đọc',
  digest_mismatch: 'Nội dung hóa đơn không khớp chữ ký số (có thể đã bị sửa sau khi ký)',
  bad_signature: 'Chữ ký số không hợp lệ với chứng thư số kèm theo',
  unsupported_algorithm: 'Chữ ký số dùng thuật toán chưa hỗ trợ',
  no_certificate: 'Chữ ký số không kèm chứng thư số của người ký',
  untrusted_certificate: 'Chứng thư số không do tổ chức chứng thực được Root CA quốc gia công nhận cấp',
  certificate_expired: 'Chứng thư số không còn hiệu lực tại thời điểm ký',
  signer_mismatch: 'Chứng thư số cấp cho mã số thuế khác người bán',
  tax_authority_missing: 'Có mã của cơ quan thuế nhưng thiếu chữ ký số của cơ quan thuế',
  tax_authority_invalid: 'Chữ ký số của cơ quan thuế không hợp lệ hoặc không bao phủ mã và dữ liệu hóa đơn',
  tax_authority_untrusted: 'Chưa xác minh được tổ chức cấp chứng thư số của cơ quan thuế',
  cash_register: 'Hóa đơn máy tính tiền không có chữ ký số nên không xác minh được người bán',
  too_large: 'Tệp quá lớn để xác minh chữ ký số',
};

// The check code of a signature verification (INVOICE_CHECK_CODES in @crove/kernel-contract, #677): signature.verified,
// or signature.<reason>.
export function signatureCheckCode(signature: InvoiceSignature): string {
  return signature.status === 'verified' || !signature.reason ? `signature.${signature.status}` : `signature.${signature.reason}`;
}

// What the Inbox and the checks say about a signature verification.
export function signatureMessage(signature: InvoiceSignature): string {
  if (signature.status === 'verified') {
    return signature.signer ? `Chữ ký số hợp lệ, đã xác minh (người ký: ${signature.signer})` : 'Chữ ký số hợp lệ, đã xác minh';
  }
  if (signature.reason) return SIGNATURE_MESSAGES[signature.reason];
  return signature.status === 'unverified' ? 'Chưa xác minh được chữ ký số' : 'Không cần xác minh chữ ký số';
}

// The invoice an e-invoice corrects (issue #916), from its TTHDLQuan block: a replacement (thay thế) takes the
// original's place, an adjustment (điều chỉnh) changes its amounts by the difference it carries. The original is named
// by its template, series, number and issue date.
export interface RelatedInvoice {
  kind: 'replacement' | 'adjustment';
  template: string | null;
  series: string;
  number: string;
  issueDate: string | null;
  note: string | null;
}

export interface ParsedInvoice {
  source: 'einvoice_xml' | 'ai';
  invoiceType: string | null;
  template: string | null;
  series: string;
  number: string;
  issueDate: string;
  currency: string;
  exchangeRate: Money | null;
  paymentMethod: string | null;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: InvoiceLine[];
  taxBreakdown: TaxBreakdown[];
  subtotal: Money;
  vatTotal: Money;
  total: Money;
  totalInWords: string | null;
  taxAuthorityCode: string | null;
  hasSignature: boolean;
  // Set by the e-invoice XML parser (#674); an invoice read by AI has none, and nothing to verify.
  signature?: InvoiceSignature | undefined;
  // Set only on a replacement or an adjustment invoice whose XML names the invoice it corrects.
  related?: RelatedInvoice | undefined;
}

export type CheckStatus = 'pass' | 'warn' | 'fail';

// id names the check (stable, BLOCKING_CHECK_IDS refers to it); code names its outcome and wording (one of
// INVOICE_CHECK_CODES in @crove/kernel-contract, issue #677), with params filling the wording. message is the
// Vietnamese sentence, kept for older readers and as the fallback.
export interface InvoiceCheck {
  id: string;
  status: CheckStatus;
  message: string;
  code: string;
  params?: Record<string, string>;
}

// Normalized invoice identifiers used for storage and duplicate detection.
export function normalizeSeries(series: string): string {
  return series.trim().toUpperCase().replace(/\s+/g, '');
}

export function normalizeNumber(number: string): string {
  const trimmed = number.trim().replace(/\s+/g, '');
  return /^\d+$/.test(trimmed) ? trimmed.replace(/^0+(?=\d)/, '') : trimmed.toUpperCase();
}

// Signed contribution of a line to the pre-tax subtotal.
export function lineContribution(line: InvoiceLine): Money {
  if (line.nature === 'note' || line.nature === 'promotion') return '0';
  const amount = money(line.amount);
  return toMoney(line.nature === 'discount' && amount.isPositive() ? amount.negated() : amount);
}

// YYYY-MM-DD that names a real day, year 0001 or later (PostgreSQL rejects year 0000 in date input).
// Never throws (toISOString() does on an Invalid Date).
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value < '0001-01-01') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// The exchange rate a foreign-currency invoice is booked at (#918), or null: only an e-invoice XML's own TGia, positive,
// on a three-letter currency code. A rate read by AI from a PDF or a photo is never used: a hidden instruction could set
// it, so the accountant enters the rate instead (finance.purchase.revise).
export function invoiceExchangeRate(invoice: Pick<ParsedInvoice, 'source' | 'currency' | 'exchangeRate'>): Money | null {
  if (invoice.source !== 'einvoice_xml' || !/^[A-Za-z]{3}$/.test(invoice.currency) || invoice.exchangeRate === null) return null;
  // As written (never rounded), and only within what a proposal stores (zExchangeRate: at most 13 digits before the
  // point and 10 after it); anything else is no rate, so the accountant enters one.
  const rate = money(invoice.exchangeRate);
  return rate.greaterThan(0) && rate.decimalPlaces() <= 10 && rate.lessThan('1e13') ? rate.toFixed() : null;
}

// The first amount of a VND invoice that has a fraction of a dong (a line, the VAT breakdown or a total), or null.
export function belowOneDong(invoice: Pick<ParsedInvoice, 'lines' | 'taxBreakdown' | 'subtotal' | 'vatTotal' | 'total'>): Money | null {
  const amounts = [
    ...invoice.lines.map((l) => l.amount),
    ...invoice.taxBreakdown.flatMap((t) => [t.taxableAmount, t.vatAmount]),
    invoice.subtotal,
    invoice.vatTotal,
    invoice.total,
  ];
  return amounts.find((a) => !money(a).isInteger()) ?? null;
}

function wholeDong(amount: Money): Money {
  const rounded = money(amount).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  // decimal.js keeps the sign of a negative amount rounded to zero ("-0").
  return rounded.isZero() ? '0' : rounded.toFixed();
}

export type DongRoundable = Pick<ParsedInvoice, 'currency' | 'lines' | 'taxBreakdown' | 'subtotal' | 'vatTotal' | 'total'>;

// What rounding a VND invoice to whole dong did (#1308, option 2; ADR-0021 decision 1: round once, at the line).
//   applied   set when the invoice had an amount below one dong and was rounded: firstFraction is the first such amount,
//             difference the dong (signed) put on the line lineNo (null when the rounded lines already add up)
//   refused   set when it had one and could not be rounded: the first amount below one dong, which keeps the blocking check
// `invoice` is the rounded invoice when applied, else the one given.
export interface DongRounding<T extends DongRoundable> {
  invoice: T;
  applied: { firstFraction: Money; difference: Money; lineNo: number | null } | null;
  refused: Money | null;
}

// Rounds every amount of a VND invoice half up to the dong, then puts the difference between the rounded lines and the
// invoice's own subtotal on its largest goods or service line (the first on a tie), so the lines add up to the subtotal
// exactly. VAT is never adjusted: an invoice whose VAT has a fraction of a dong is refused, as is one whose rounded total
// is not its rounded subtotal plus its VAT, one with a difference above 1 dong per goods or discount line (it is probably
// wrong), and one with no goods line to carry the difference or whose largest line the difference would turn over.
export function roundInvoiceToDong<T extends DongRoundable>(invoice: T): DongRounding<T> {
  if (invoice.currency.trim().toUpperCase() !== 'VND') return { invoice, applied: null, refused: null };
  const firstFraction = belowOneDong(invoice);
  if (firstFraction === null) return { invoice, applied: null, refused: null };
  const refused: DongRounding<T> = { invoice, applied: null, refused: firstFraction };
  if (!money(invoice.vatTotal).isInteger() || invoice.taxBreakdown.some((t) => !money(t.vatAmount).isInteger())) return refused;

  const subtotal = wholeDong(invoice.subtotal);
  const total = money(subtotal).plus(money(invoice.vatTotal));
  if (!total.equals(money(wholeDong(invoice.total)))) return refused;

  const lines = invoice.lines.map((l) => ({ ...l, amount: wholeDong(l.amount) }));
  const difference = money(subtotal).minus(sum(lines.map(lineContribution)));
  // 1 dong per line that carries an amount: a note or a promotion line adds nothing to the subtotal, so it adds no allowance.
  if (difference.abs().greaterThan(lines.filter((l) => l.nature === 'goods' || l.nature === 'discount').length)) return refused;
  let lineNo: number | null = null;
  if (!difference.isZero()) {
    let largest = -1;
    lines.forEach((l, i) => {
      if (l.nature === 'goods' && (largest < 0 || money(l.amount).abs().greaterThan(money(lines[largest]!.amount).abs()))) largest = i;
    });
    if (largest < 0) return refused;
    const before = money(lines[largest]!.amount);
    const adjusted = before.plus(difference);
    // The adjustment never turns a line over: a credit invoice's negative line stays negative, a positive one positive.
    if (!adjusted.isZero() && adjusted.isNegative() !== before.isNegative()) return refused;
    lines[largest] = { ...lines[largest]!, amount: adjusted.toFixed() };
    lineNo = lines[largest]!.lineNo;
  }
  return {
    invoice: {
      ...invoice,
      lines,
      taxBreakdown: invoice.taxBreakdown.map((t) => ({ ...t, taxableAmount: wholeDong(t.taxableAmount) })),
      subtotal,
      total: total.toFixed(),
    },
    applied: { firstFraction, difference: difference.toFixed(), lineNo },
    refused: null,
  };
}

// Deterministic checks. Confidence comes from these, never from a model's self-assessment.
export function checkInvoice(
  invoice: ParsedInvoice,
  today: string = new Date().toISOString().slice(0, 10),
  baseCurrency = 'VND',
): InvoiceCheck[] {
  const checks: InvoiceCheck[] = [];
  if (invoice.currency.toUpperCase() !== baseCurrency) {
    const rate = invoiceExchangeRate(invoice);
    if (rate) {
      // Booked in the base currency at the invoice's own rate (#918): a warning, so the approver sees the conversion.
      const currency = invoice.currency.toUpperCase();
      checks.push({ id: 'currency', status: 'warn', code: 'currency.converted', params: { currency, rate }, message: `Hóa đơn bằng ${currency}; ghi sổ bằng ${baseCurrency} theo tỷ giá ${rate} của hóa đơn` });
    } else {
      // The code as read can be any text (an XML element, a model's answer): only its start is shown.
      const currency = Array.from(invoice.currency.trim()).slice(0, 20).join('');
      checks.push({ id: 'currency', status: 'fail', code: 'currency.unsupported', params: { currency }, message: `Hóa đơn bằng ${currency}, chưa có tỷ giá để ghi sổ; nhập tỷ giá khi sửa đề xuất` });
    }
  }
  // A VND invoice with amounts below one dong is read as rounded to the dong (#2235): the lines, the subtotal and the
  // total below are the rounded ones, and the amount_scale warning says what was moved.
  const rounding = roundInvoiceToDong(invoice);
  const view = rounding.invoice;
  const linesTotal = sum(view.lines.map(lineContribution));

  checks.push(
    approxEqual(linesTotal, view.subtotal, '0')
      ? { id: 'lines_sum', status: 'pass', code: 'lines_sum.ok', message: 'Tổng các dòng khớp tiền trước thuế' }
      : {
          id: 'lines_sum',
          status: 'fail',
          code: 'lines_sum.mismatch',
          params: { lines: toMoney(linesTotal), subtotal: view.subtotal },
          message: `Tổng các dòng (${toMoney(linesTotal)}) lệch tiền trước thuế (${view.subtotal})`,
        },
  );

  checks.push(
    approxEqual(money(view.subtotal).plus(money(view.vatTotal)), view.total, '0')
      ? { id: 'total', status: 'pass', code: 'total.ok', message: 'Tiền trước thuế + VAT khớp tổng thanh toán' }
      : { id: 'total', status: 'fail', code: 'total.mismatch', message: 'Tiền trước thuế + VAT lệch tổng thanh toán' },
  );

  // VND has no minor units (ADR-0021, #1282): the ledger refuses an amount below one dong instead of rounding it. The
  // owner's rule (#1308, option 2): each line is rounded half up to the dong and the difference goes to the largest line,
  // VAT untouched; the approver sees a warning naming it. What cannot be rounded that way (a fraction in the VAT, a
  // difference above 1 dong per line, no goods line) stays a blocking check, so the invoice waits in the Inbox. A
  // foreign-currency invoice is booked in VND after conversion, which rounds to the dong.
  if (rounding.applied) {
    const { firstFraction, difference, lineNo } = rounding.applied;
    checks.push(
      lineNo === null
        ? {
            id: 'amount_scale',
            status: 'warn',
            code: 'amount_scale.rounded_even',
            params: { amount: firstFraction },
            message: `Hóa đơn có số tiền lẻ dưới một đồng (${firstFraction}); đã làm tròn từng dòng về đồng, tổng các dòng vẫn khớp tiền trước thuế`,
          }
        : {
            id: 'amount_scale',
            status: 'warn',
            code: 'amount_scale.rounded',
            params: { amount: firstFraction, difference, line: String(lineNo) },
            message: `Hóa đơn có số tiền lẻ dưới một đồng (${firstFraction}); đã làm tròn từng dòng về đồng, dòng ${lineNo} được điều chỉnh ${difference} đồng để khớp tiền trước thuế`,
          },
    );
  } else if (rounding.refused !== null) {
    checks.push({
      id: 'amount_scale',
      status: 'fail',
      code: 'amount_scale.fraction',
      params: { amount: rounding.refused },
      message: `Hóa đơn có số tiền lẻ dưới một đồng (${rounding.refused}) mà không tự làm tròn về đồng được; hãy xin người bán điều chỉnh hóa đơn`,
    });
  }

  if (invoice.taxBreakdown.length > 0) {
    const vat = sum(invoice.taxBreakdown.map((t) => t.vatAmount));
    checks.push(
      approxEqual(vat, invoice.vatTotal, '0')
        ? { id: 'vat_breakdown', status: 'pass', code: 'vat_breakdown.ok', message: 'Bảng thuế suất khớp tổng VAT' }
        : { id: 'vat_breakdown', status: 'fail', code: 'vat_breakdown.mismatch', message: 'Bảng thuế suất lệch tổng VAT' },
    );
  }

  const seller = parseTaxCode(invoice.seller.taxCode);
  if (!seller) {
    checks.push({ id: 'seller_tax_code', status: 'warn', code: 'seller_tax_code.unreadable', message: 'Không đọc được MST người bán' });
  } else if (seller.checksumValid === false) {
    checks.push({
      id: 'seller_tax_code',
      status: 'warn',
      code: 'seller_tax_code.checksum',
      params: { taxCode: seller.normalized },
      message: `MST người bán ${seller.normalized} sai số kiểm tra`,
    });
  } else {
    checks.push({ id: 'seller_tax_code', status: 'pass', code: 'seller_tax_code.ok', params: { taxCode: seller.normalized }, message: `MST người bán ${seller.normalized} hợp lệ` });
  }

  if (!isCalendarDate(invoice.issueDate)) {
    checks.push({ id: 'issue_date', status: 'fail', code: 'issue_date.invalid', message: 'Ngày lập hóa đơn không hợp lệ' });
  } else if (invoice.issueDate > today) {
    checks.push({ id: 'issue_date', status: 'warn', code: 'issue_date.future', message: 'Ngày lập hóa đơn ở tương lai' });
  } else {
    checks.push({ id: 'issue_date', status: 'pass', code: 'issue_date.ok', params: { date: invoice.issueDate }, message: `Ngày lập ${invoice.issueDate}` });
  }

  if (invoice.source === 'einvoice_xml') {
    checks.push(
      invoice.taxAuthorityCode
        ? { id: 'tax_authority_code', status: 'pass', code: 'tax_authority_code.present', message: 'Có mã của cơ quan thuế' }
        : { id: 'tax_authority_code', status: 'warn', code: 'tax_authority_code.missing', message: 'Không có mã của cơ quan thuế' },
    );
    // Verified in the sandbox (#674). An unverified signature is a warning, never a failed check: it must not block
    // the invoice; approving it needs the approver's confirmation (kernel.proposal.approve). Without a verification
    // (an answer from a sandbox older than #674) it stays a warning, as before.
    const signature = invoice.signature;
    checks.push(
      signature
        ? {
            id: 'signature',
            // Only a verified signature passes. A cash register invoice (not applicable) stays a warning: its series is
            // what the file says, so an unsigned forgery could claim it.
            status: signature.status === 'verified' ? 'pass' : 'warn',
            code: signatureCheckCode(signature),
            ...(signature.status === 'verified' && signature.signer ? { params: { signer: signature.signer.slice(0, 200) } } : {}),
            message: signatureMessage(signature),
          }
        : {
            id: 'signature',
            status: 'warn',
            code: invoice.hasSignature ? 'signature.unverified' : 'signature.missing',
            message: invoice.hasSignature ? 'Có chữ ký số, chưa xác minh với nguồn chính thức' : 'Không có chữ ký số',
          },
    );
  } else {
    checks.push({ id: 'source', status: 'warn', code: 'source.ai', message: 'Đọc bằng AI từ ảnh/PDF, cần người kiểm tra' });
  }
  return checks;
}
