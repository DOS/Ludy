// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace income reports (#2516, ADR-0045 points 5 and 7, plan stock-and-marketplaces.md section 8.4): the "income" or "released" export of Shopee and of TikTok Shop, one row per order,
// read through one profile per platform. A profile is DATA: the words each wanted column is called in Vietnamese and in English, the sign the file gives its deductions, a version, and whether a
// real seller's file confirmed it.
//
// What is read is an ALLOW-LIST: the order number, the payment date and the amounts. Every other column (the buyer's name, phone, email and address among them, which these files may carry)
// has no field here, so it is never read, never returned and never stored.
//
// **Unconfirmed until #2521.** No real income report of a seller was available (plan section 7: "no sample file was seen"). Every profile says `confirmed: false`, the staged read shows it,
// and the confirm step is the protection against a wrong mapping. Lazada has NO profile here: its public documentation describes a fee-line layout (one row per order item and fee type),
// not one row per order, and a mapping guessed for it would be worse than none; the golden file of #2521 decides it.
//
// The sign. A file gives its deductions as negative numbers (Shopee) or as positive ones (declared by the profile). A deduction column is read as the amount taken from the seller, always
// stored as a positive number; a value of the other sign in such a column (a rebate) is not hidden: it stays in the line's `other`, which is the net the file states minus everything the
// named columns explain, so every line's net is the file's own and the table's identity holds. The staged read shows the total of `other`, so a person sees what no column explained.
//
// Pure functions over the grids the sheet readers give (bank-statement-sheet.ts: rows by 1-based number, cells by 0-based column), shared by the parsing sandbox and, later, the screens.
import { Decimal } from 'decimal.js';
import { headerKey, type StatementCell, type StatementGrid } from './bank-statement-sheet.ts';
import { readDay, readDecimal, type MarketplacePlatform } from './marketplace-orders.ts';

export const INCOME_PLATFORMS = ['shopee', 'tiktok_shop'] as const satisfies readonly MarketplacePlatform[];
export type IncomePlatform = (typeof INCOME_PLATFORMS)[number];

// The columns of an income report that are read. taxVat and taxPit are summed into the line's taxWithheld.
export const INCOME_FIELDS = ['orderNo', 'paidAt', 'sales', 'sellerDiscount', 'commission', 'serviceFee', 'paymentFee', 'shipping', 'taxVat', 'taxPit', 'refund', 'net'] as const;
export type IncomeField = (typeof INCOME_FIELDS)[number];

interface Words {
  // A header matches when its normalized text (headerKey) equals one of these or contains it, tried in order.
  contains: string[];
}

export interface IncomeProfile {
  platform: IncomePlatform;
  // Bumped whenever the words change; kept with every staged read.
  version: string;
  // Whether the mapping was checked against a real seller's file (#2521). False for every profile until then.
  confirmed: boolean;
  // Header words only this platform's income report uses: at least one must be present for the file to be taken for the platform.
  markers: string[];
  // The sign the file gives the amounts taken from the seller: 'negative' (a fee of 5,000 is -5000) or 'positive'.
  deductions: 'negative' | 'positive';
  columns: Record<IncomeField, Words>;
}

export const INCOME_PROFILES: readonly IncomeProfile[] = [
  {
    // The "Income" sheet of Shopee's "Đã thanh toán" (released) export: per order, with the fees, vouchers, VAT and PIT of Decree 117/2025. Vietnamese headers as far as help pages quote them,
    // the English ones of the same product beside them. Deductions are negative (plan section 7).
    platform: 'shopee',
    version: 'shopee-income-2026-11-a',
    confirmed: false,
    markers: ['tong so tien da thanh toan', 'total released amount', 'phi giao dich', 'transaction fee', 'phi co dinh', 'commission fee', 'released amount'],
    deductions: 'negative',
    columns: {
      orderNo: { contains: ['ma don hang', 'order id'] },
      paidAt: { contains: ['ngay hoan tat thanh toan', 'payment completed date', 'ngay thanh toan', 'released date'] },
      sales: { contains: ['gia san pham', 'original product price', 'product price', 'tong gia ban san pham'] },
      sellerDiscount: { contains: ['ma giam gia cua shop', 'seller voucher', 'shop voucher', 'giam gia cua nguoi ban'] },
      commission: { contains: ['phi co dinh', 'commission fee'] },
      serviceFee: { contains: ['phi dich vu', 'service fee'] },
      paymentFee: { contains: ['phi giao dich', 'phi xu ly gd', 'transaction fee'] },
      shipping: { contains: ['phi van chuyen nguoi ban', 'seller shipping fee', 'phi van chuyen thuc te', 'actual shipping fee', 'phi van chuyen'] },
      taxVat: { contains: ['thue gtgt', 'vat withheld', 'vat'] },
      taxPit: { contains: ['thue tncn', 'personal income tax', 'pit'] },
      refund: { contains: ['so tien hoan lai', 'refund amount', 'refund'] },
      net: { contains: ['tong so tien da thanh toan', 'total released amount', 'released amount'] },
    },
  },
  {
    // The "Đã quyết toán" (settled) export of TikTok Shop's Seller Center, per order. Only the English column names of the first-party layout are certain, and Vietnam's layout changed on
    // 2026-05-09, so this profile is the thinnest of the two; the golden file decides it. Deductions are negative (refunds negative in the US guide).
    platform: 'tiktok_shop',
    version: 'tiktok-shop-income-2026-11-a',
    confirmed: false,
    markers: ['total settlement amount', 'settlement amount', 'tong so tien quyet toan', 'transaction fee', 'referral fee', 'affiliate commission'],
    deductions: 'negative',
    columns: {
      orderNo: { contains: ['order id', 'order adjustment id', 'ma don hang'] },
      paidAt: { contains: ['order settled time', 'settled time', 'settlement time', 'thoi gian quyet toan'] },
      sales: { contains: ['total revenue', 'subtotal after seller discounts', 'gross sales', 'tong doanh thu'] },
      sellerDiscount: { contains: ['seller discount', 'giam gia cua nguoi ban'] },
      commission: { contains: ['referral fee', 'commission fee', 'affiliate commission', 'phi hoa hong'] },
      serviceFee: { contains: ['service fee', 'phi dich vu'] },
      paymentFee: { contains: ['transaction fee', 'payment fee', 'phi giao dich'] },
      shipping: { contains: ['shipping cost', 'shipping fee', 'phi van chuyen'] },
      taxVat: { contains: ['vat withheld', 'vat'] },
      taxPit: { contains: ['pit withheld', 'personal income tax', 'pit'] },
      refund: { contains: ['refund', 'hoan tien'] },
      net: { contains: ['total settlement amount', 'settlement amount', 'tong so tien quyet toan'] },
    },
  },
];

const cellText = (cell: StatementCell | undefined): string => (cell?.value ?? '').trim();

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// The 0-based column of each field of a profile (null when the file has none). A column is claimed once; the specific fields go before the ones with short words.
function claim(profile: IncomeProfile, headers: Map<number, string>): Record<IncomeField, number | null> {
  const columns = Object.fromEntries(INCOME_FIELDS.map((f) => [f, null])) as Record<IncomeField, number | null>;
  const taken = new Set<number>();
  const order: IncomeField[] = ['net', 'orderNo', 'paidAt', 'commission', 'serviceFee', 'paymentFee', 'sellerDiscount', 'shipping', 'taxPit', 'taxVat', 'refund', 'sales'];
  for (const field of order) {
    for (const word of profile.columns[field].contains) {
      const open = [...headers].filter(([col]) => !taken.has(col));
      const hit = open.find(([, key]) => key === word) ?? open.find(([, key]) => key.includes(word));
      if (hit) {
        columns[field] = hit[0];
        taken.add(hit[0]);
        break;
      }
    }
  }
  return columns;
}

export interface IncomeMapping {
  profile: IncomeProfile;
  headerRow: number;
  columns: Record<IncomeField, number | null>;
  // The header text each field was read from.
  headers: Array<{ field: IncomeField; header: string }>;
}

// The platform's profile and the header row: the first of the first 30 rows that names an order number and a net amount and at least one word only that platform uses. When two platforms
// fit equally the file is not taken for either.
export function findIncomeColumns(rows: StatementGrid): IncomeMapping | null {
  const numbers = [...rows.keys()].sort((a, b) => a - b).slice(0, 30);
  for (const n of numbers) {
    const headers = new Map<number, string>();
    const labels = new Map<number, string>();
    for (const [col, cell] of rows.get(n) ?? []) {
      const key = headerKey(cellText(cell));
      if (key) {
        headers.set(col, key);
        labels.set(col, cellText(cell));
      }
    }
    if (headers.size < 4) continue;
    const fits: Array<{ profile: IncomeProfile; columns: Record<IncomeField, number | null>; score: number }> = [];
    for (const profile of INCOME_PROFILES) {
      if (!profile.markers.some((marker) => [...headers.values()].some((key) => key === marker || key.includes(marker)))) continue;
      const columns = claim(profile, headers);
      if (columns.orderNo === null || columns.net === null) continue;
      fits.push({ profile, columns, score: INCOME_FIELDS.filter((f) => columns[f] !== null).length });
    }
    fits.sort((a, b) => b.score - a.score);
    const best = fits[0];
    if (!best || (fits[1] && fits[1].score === best.score)) continue;
    return {
      profile: best.profile,
      headerRow: n,
      columns: best.columns,
      headers: INCOME_FIELDS.flatMap((field) => {
        const col = best.columns[field];
        return col === null ? [] : [{ field, header: labels.get(col) ?? '' }];
      }),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Reading the lines
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// Why a row below the header was not read as the income of an order. `no_order_no` (a totals or notice row) is ignored by the confirm step; every other reason stops the file.
export const INCOME_SKIP_REASONS = ['no_order_no', 'bad_amount', 'bad_date', 'bad_id', 'too_long'] as const;
export type IncomeSkipReason = (typeof INCOME_SKIP_REASONS)[number];

export interface IncomeLine {
  rowNo: number;
  orderNo: string;
  // The line inside its settlement: the order number, and "#2" and so on when the file pays an order in several rows.
  lineKey: string;
  // YYYY-MM-DD, or null when the file has no such column or the cell is empty.
  paidAt: string | null;
  // Decimal strings (four places at most), every deduction a positive amount taken from the seller; `other` signed.
  sales: string;
  sellerDiscount: string;
  commission: string;
  serviceFee: string;
  paymentFee: string;
  shipping: string;
  taxWithheld: string;
  refund: string;
  other: string;
  net: string;
}

export interface IncomeRead {
  mapping: IncomeMapping;
  lines: IncomeLine[];
  // The net of the one row below the table that has no order number and a number in the net column (a totals row), when there is exactly one; null otherwise.
  statedNet: string | null;
  skipped: Array<{ rowNo: number; reason: IncomeSkipReason }>;
}

const MAX_ID = 64;
const MAX_KEY = 120;
const ZERO = new Decimal(0);

// A decimal string as the tables keep it (numeric(20, 4)): rounded half up to four places, null when it does not fit sixteen whole digits.
function money(value: Decimal): string | null {
  const rounded = value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (rounded.abs().gte(new Decimal(10).pow(16))) return null;
  return rounded.toFixed();
}

// An id that a spreadsheet turned into a number has lost its last digits: a number of 16 or more digits (a double holds 15), or one with an exponent.
function brokenId(cell: StatementCell | undefined): boolean {
  const text = cellText(cell);
  return /^(?:\d+\.\d+e[+-]?\d+|\d+e\+\d+)$/i.test(text) || (cell?.kind === 'number' && /^\d{16,}$/.test(text));
}

// The lines of the file under its header, at most maxRows of them; null when the file has more. Rows with nothing in any read column are blank and not reported.
export function incomeLines(rows: StatementGrid, mapping: IncomeMapping, maxRows: number): IncomeRead | null {
  const { profile, headerRow, columns } = mapping;
  const out: IncomeLine[] = [];
  const skipped: IncomeRead['skipped'] = [];
  const seen = new Map<string, number>();
  const totals: string[] = [];
  const cell = (row: ReadonlyMap<number, StatementCell>, field: IncomeField) => (columns[field] === null ? undefined : row.get(columns[field] as number));
  const text = (row: ReadonlyMap<number, StatementCell>, field: IncomeField) => cellText(cell(row, field));
  // What a deduction column holds, as the amount taken from the seller (positive), by the profile's sign; a value of the other sign is not a deduction.
  const taken = (value: Decimal): Decimal => (profile.deductions === 'negative' ? value.negated() : value);
  let rowCount = 0;
  for (const rowNo of [...rows.keys()].sort((a, b) => a - b)) {
    if (rowNo <= headerRow) continue;
    const row = rows.get(rowNo) as ReadonlyMap<number, StatementCell>;
    const filled = INCOME_FIELDS.filter((f) => columns[f] !== null).some((f) => text(row, f) !== '');
    if (!filled) continue;
    rowCount++;
    if (rowCount > maxRows) return null;
    const orderNo = text(row, 'orderNo');
    if (orderNo === '') {
      // A totals row: the net of the whole report, when the file states one.
      const total = readDecimal(cell(row, 'net'));
      if (total !== null && total !== 'bad') totals.push(total);
      skipped.push({ rowNo, reason: 'no_order_no' });
      continue;
    }
    if (orderNo.length > MAX_ID || brokenId(cell(row, 'orderNo'))) {
      skipped.push({ rowNo, reason: orderNo.length > MAX_ID ? 'too_long' : 'bad_id' });
      continue;
    }
    const amounts = new Map<IncomeField, Decimal>();
    let bad = false;
    for (const field of INCOME_FIELDS) {
      if (field === 'orderNo' || field === 'paidAt' || columns[field] === null) continue;
      const read = readDecimal(cell(row, field));
      if (read === 'bad') {
        bad = true;
        break;
      }
      // Rounded to the four places the tables keep before any arithmetic, so what is stored satisfies the net identity exactly.
      amounts.set(field, read === null ? ZERO : new Decimal(read).toDecimalPlaces(4, Decimal.ROUND_HALF_UP));
    }
    // The net is the file's own figure: a row without one is no income of an order.
    if (bad || text(row, 'net') === '') {
      skipped.push({ rowNo, reason: 'bad_amount' });
      continue;
    }
    const paidText = text(row, 'paidAt');
    const paidAt = paidText === '' ? null : readDay(cell(row, 'paidAt'));
    if (paidText !== '' && paidAt === null) {
      skipped.push({ rowNo, reason: 'bad_date' });
      continue;
    }
    const get = (field: IncomeField): Decimal => amounts.get(field) ?? ZERO;
    const sales = get('sales');
    const deduction = (field: IncomeField): Decimal => Decimal.max(ZERO, taken(get(field)));
    const sellerDiscount = deduction('sellerDiscount');
    const commission = deduction('commission');
    const serviceFee = deduction('serviceFee');
    const paymentFee = deduction('paymentFee');
    const shipping = deduction('shipping');
    const taxWithheld = deduction('taxVat').plus(deduction('taxPit'));
    const refund = deduction('refund');
    const net = get('net');
    // What no named column explains: the net the file states less sales and every deduction. A sales column below zero is not a sale; it goes through `other` like any figure the profile cannot place.
    const salesPositive = Decimal.max(ZERO, sales);
    const explained = salesPositive.minus(sellerDiscount).minus(commission).minus(serviceFee).minus(paymentFee).minus(shipping).minus(taxWithheld).minus(refund);
    const other = net.minus(explained);
    const parts = [salesPositive, sellerDiscount, commission, serviceFee, paymentFee, shipping, taxWithheld, refund, other, net].map(money);
    if (parts.some((p) => p === null)) {
      skipped.push({ rowNo, reason: 'bad_amount' });
      continue;
    }
    const [vSales, vDisc, vComm, vSvc, vPay, vShip, vTax, vRefund, vOther, vNet] = parts as string[];
    const orderKey = orderNo;
    const count = (seen.get(orderKey) ?? 0) + 1;
    seen.set(orderKey, count);
    const lineKey = count === 1 ? orderNo : `${orderNo}#${count}`;
    if (lineKey.length > MAX_KEY) {
      skipped.push({ rowNo, reason: 'too_long' });
      continue;
    }
    out.push({
      rowNo,
      orderNo,
      lineKey,
      paidAt,
      sales: vSales as string,
      sellerDiscount: vDisc as string,
      commission: vComm as string,
      serviceFee: vSvc as string,
      paymentFee: vPay as string,
      shipping: vShip as string,
      taxWithheld: vTax as string,
      refund: vRefund as string,
      other: vOther as string,
      net: vNet as string,
    });
  }
  const stated = totals.length === 1 ? money(new Decimal(totals[0] as string)) : null;
  return { mapping, lines: out, statedNet: stated, skipped };
}
