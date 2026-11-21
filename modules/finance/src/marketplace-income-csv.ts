// SPDX-License-Identifier: AGPL-3.0-only
// The income a marketplace reader pulled, written as the CSV the income path stages (#2516, #4302, plan stock-and-marketplaces.md section 8.4): one Ludy layout per platform, written with the words of that
// platform's INCOME_PROFILES entry, so readMarketplaceIncomeFile (the SAME intake as a file a member drops in the Inbox) reads it unchanged and a member confirms it like any report. The poll writes
// no order, no voucher and no posting by itself: this is only the file.
//
// Not the platform's own export. Shopee's and TikTok Shop's profiles are the words of their exports as far as help pages quote them (unconfirmed, #2521); Lazada has no export of this shape, so its
// profile is Ludy's own layout. In every layout the net is the platform's figure per order and day, and `other` is not a column: the reader derives it as the net less what the named columns
// explain, which gives back exactly the `other` the reader computed (the identity of the lines). The tax columns carry the reader's `taxWithheld` total; what a reader only carries (VAT and
// withholding fields, fee ids) is not written.
//
// Deterministic: the same lines for the same connection give the same bytes (the intake dedupes a file by its hash per org); a text cell goes through marketplaceCellText, so no cell can be read as
// a formula by a spreadsheet.
import { money } from '@crove/l10n-vn';
import { z } from 'zod';
import { marketplaceCellText, marketplaceCsvCell, type MarketplaceIncomeLine, type MarketplaceIncomePage, type MarketplacePlatformKey } from './marketplace-provider.ts';

export const MARKETPLACE_INCOME_CSV_MAX_ROWS = 20_000;

type Column = 'orderNo' | 'paidAt' | 'sales' | 'sellerDiscount' | 'commission' | 'serviceFee' | 'paymentFee' | 'shipping' | 'tax' | 'refund' | 'net';
const COLUMNS: readonly Column[] = ['orderNo', 'paidAt', 'sales', 'sellerDiscount', 'commission', 'serviceFee', 'paymentFee', 'shipping', 'tax', 'refund', 'net'];

interface IncomeLayout {
  // The sign the layout gives a deduction: 'negative' writes a fee of 5,000 as -5000 (the profile says so), 'positive' as 5000.
  deductions: 'negative' | 'positive';
  head: Record<Column, string>;
}

const LAYOUTS: Readonly<Record<MarketplacePlatformKey, IncomeLayout>> = {
  shopee: {
    deductions: 'negative',
    head: {
      orderNo: 'Mã đơn hàng',
      paidAt: 'Ngày hoàn tất thanh toán',
      sales: 'Giá sản phẩm',
      sellerDiscount: 'Mã giảm giá của Shop',
      commission: 'Phí cố định',
      serviceFee: 'Phí dịch vụ',
      paymentFee: 'Phí giao dịch',
      shipping: 'Phí vận chuyển người bán',
      tax: 'Thuế GTGT',
      refund: 'Số tiền hoàn lại',
      net: 'Tổng số tiền đã thanh toán',
    },
  },
  tiktok_shop: {
    deductions: 'negative',
    head: {
      orderNo: 'Order ID',
      paidAt: 'Order settled time',
      sales: 'Total revenue',
      sellerDiscount: 'Seller discount',
      commission: 'Referral fee',
      serviceFee: 'Service fee',
      paymentFee: 'Transaction fee',
      shipping: 'Shipping cost',
      tax: 'VAT withheld',
      refund: 'Refund',
      net: 'Total settlement amount',
    },
  },
  lazada: {
    deductions: 'positive',
    head: {
      orderNo: 'Mã đơn hàng',
      paidAt: 'Ngày giao dịch',
      sales: 'Doanh thu sản phẩm',
      sellerDiscount: 'Giảm giá người bán chịu',
      commission: 'Phí hoa hồng',
      serviceFee: 'Phí dịch vụ khác',
      paymentFee: 'Phí thanh toán',
      shipping: 'Phí vận chuyển',
      tax: 'Thuế khấu trừ',
      refund: 'Hoàn tiền',
      net: 'Lazada thực nhận',
    },
  },
};

// A deduction as the layout writes it: the amount taken from the seller, negated for a layout that writes deductions as negative numbers; zero stays "0".
const signed = (value: string, deductions: IncomeLayout['deductions']): string => {
  const amount = money(value);
  return (deductions === 'negative' && !amount.isZero() ? amount.negated() : amount).toFixed();
};

// The CSV of one day's income lines, with a first row of one cell naming the connection (two connections of one platform never write the same bytes, and the file is tied to its connection; the
// income reader skips a row with fewer than four headers and the row holds no income data). Throws for more rows than one file may carry; the caller maps that to a poll state.
export function marketplaceIncomeCsv(platform: MarketplacePlatformKey, lines: readonly MarketplaceIncomeLine[], connectionId?: string): string {
  if (lines.length > MARKETPLACE_INCOME_CSV_MAX_ROWS) throw new Error('the page writes more rows than one file may carry');
  const layout = LAYOUTS[platform];
  const rows: string[][] = [];
  if (connectionId !== undefined) rows.push([`Ludy marketplace connection ${connectionId}`]);
  rows.push(COLUMNS.map((column) => layout.head[column]));
  for (const line of lines) {
    const deduction = (value: string) => signed(value, layout.deductions);
    rows.push([
      marketplaceCellText(line.orderNo),
      line.paidAt,
      line.sales,
      deduction(line.sellerDiscount),
      deduction(line.commission),
      deduction(line.serviceFee),
      deduction(line.paymentFee),
      deduction(line.shipping),
      deduction(line.taxWithheld),
      deduction(line.refund),
      line.net,
    ]);
  }
  return `${rows.map((row) => row.map(marketplaceCsvCell).join(',')).join('\n')}\n`;
}

// The days a file of income lines spans, for its name.
export function incomeSpan(lines: readonly MarketplaceIncomeLine[]): { from: string; to: string } | null {
  const days = lines.map((line) => line.paidAt).sort();
  const from = days[0];
  const to = days.at(-1);
  return from === undefined || to === undefined ? null : { from, to };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// A page of income as a provider returns it, checked before anything is written
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const validDay = (value: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
};
const zAmount = z.string().regex(/^-?\d{1,16}(\.\d{1,4})?$/);
const zDeduction = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/);

// Strict, like the order page: a field the port does not name refuses the page. The order number is the income profile's own id shape (64 characters of letters, digits and . _ - /, starting with a letter or digit so it can never read as a formula), and the line
// must satisfy the identity net = sales - deductions + other exactly, so a reader's arithmetic slip never becomes a staged line.
export const zMarketplaceIncomePage = z.strictObject({
  lines: z
    .array(
      z
        .strictObject({
          orderNo: z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/).refine((value) => /\d/.test(value)),
          paidAt: z.string().refine(validDay),
          sales: zDeduction,
          sellerDiscount: zDeduction,
          commission: zDeduction,
          serviceFee: zDeduction,
          paymentFee: zDeduction,
          shipping: zDeduction,
          taxWithheld: zDeduction,
          refund: zDeduction,
          other: zAmount,
          net: zAmount,
        })
        .refine((l) => {
          const d = (v: string) => money(v);
          return d(l.sales).minus(l.sellerDiscount).minus(l.commission).minus(l.serviceFee).minus(l.paymentFee).minus(l.shipping).minus(l.taxWithheld).minus(l.refund).plus(l.other).equals(d(l.net));
        }),
    )
    .max(MARKETPLACE_INCOME_CSV_MAX_ROWS),
  nextCursor: z.string().max(100).nullable(),
  more: z.boolean().optional(),
});

export function parseMarketplaceIncomePage(page: unknown): MarketplaceIncomePage | null {
  const parsed = zMarketplaceIncomePage.safeParse(page);
  return parsed.success ? (parsed.data as MarketplaceIncomePage) : null;
}
