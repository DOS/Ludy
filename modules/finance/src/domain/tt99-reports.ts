// SPDX-License-Identifier: AGPL-3.0-only
// DRAFT: the TT99 (Circular 99/2025/TT-BTC, which replaces Circular 200/2014 for fiscal years from 1 January 2026) income statement B 02-DN as a map of lines to accounts, for the entities whose books on the period's
// last day are TT99 (legal_entity_books). The line codes, labels and formulas are the form's as printed on two public pages, https://ketoanleanh.edu.vn/kinh-nghiem-ke-toan/mau-bao-cao-ket-qua-hoat-dong-kinh-doanh-theo-thong-tu-99-2025-tt-btc.html
// (the whole table) and https://amis.misa.vn/251687/so-sanh-ve-bieu-mau-bao-cao-tai-chinh-giua-thong-tu-99-va-thong-tu-200/ (lines 21 to 24 and 30), which agree. BOTH ARE SECONDARY SOURCES: the official text (Phụ lục IV) has not been read, and
// an accountant has not verified the map or the accounts below (issue #61, #5187); until then these statements are not for filing, as for tt133-reports.ts. The mapping is data: a correction is a change to this table.
//
// What differs from the TT133 map (tt133-reports.ts), so a code is never read across the two: line 21 is new (the gain or loss on selling investment property), financial revenue is 22 (TT133: 21), financial expense 23 (TT133: 22),
// borrowing cost 24 (TT133: 23), selling expense has its own line 25 (TT133 folds it into 24), administration is 26 (TT133: 24), and line 52 (deferred income tax) is new. Lines 01, 02, 10, 11, 20, 30, 31, 32, 40, 50, 51 and 60 keep
// their codes. Lines 70 and 71 (earnings per share, joint-stock companies only) are left out, as the TT133 map leaves them out.
//
// Open points the accountant decides: line 21 reads no account (the TT99 chart seed has no sub-account for it), and line 24 reads 6351, the same Ludy convention as TT133 line 23 (the chart has no standard sub-account for it); line 24
// is a "of which" line and is in no formula. Class 5 to 8 accounts no line reads (621, 622, 623 and 627, production costs normally closed to 154 and 632 before the period ends) stay in `unmapped`.
import { B02_LINES, type ReportLineDef } from './tt133-reports.ts';

export type StatementsRegime = 'tt133' | 'tt99';

export const B02_LINES_TT99: readonly ReportLineDef[] = [
  { code: '01', label: 'Doanh thu bán hàng và cung cấp dịch vụ', rules: [{ prefixes: ['511'], take: 'creditTurnover' }] },
  // A deduction booked on 521, and a return booked straight on 511 (as TT133 reads it).
  { code: '02', label: 'Các khoản giảm trừ doanh thu', rules: [{ prefixes: ['521'], take: 'debitTurnover' }, { prefixes: ['511'], take: 'debitTurnover' }] },
  { code: '10', label: 'Doanh thu thuần về bán hàng và cung cấp dịch vụ', formula: [[1, '01'], [-1, '02']] },
  { code: '11', label: 'Giá vốn hàng bán', rules: [{ prefixes: ['632'], take: 'netDebit' }] },
  { code: '20', label: 'Lợi nhuận gộp về bán hàng và cung cấp dịch vụ', formula: [[1, '10'], [-1, '11']] },
  { code: '21', label: 'Lãi/lỗ của hoạt động bán, thanh lý bất động sản đầu tư' },
  { code: '22', label: 'Doanh thu hoạt động tài chính', rules: [{ prefixes: ['515'], take: 'netCredit' }] },
  { code: '23', label: 'Chi phí tài chính', rules: [{ prefixes: ['635'], take: 'netDebit' }] },
  { code: '24', label: 'Trong đó: Chi phí đi vay', rules: [{ prefixes: ['6351'], take: 'netDebit' }] },
  { code: '25', label: 'Chi phí bán hàng', rules: [{ prefixes: ['641'], take: 'netDebit' }] },
  { code: '26', label: 'Chi phí quản lý doanh nghiệp', rules: [{ prefixes: ['642'], take: 'netDebit' }] },
  { code: '30', label: 'Lợi nhuận thuần từ hoạt động kinh doanh', formula: [[1, '20'], [1, '21'], [1, '22'], [-1, '23'], [-1, '25'], [-1, '26']] },
  { code: '31', label: 'Thu nhập khác', rules: [{ prefixes: ['711'], take: 'netCredit' }] },
  { code: '32', label: 'Chi phí khác', rules: [{ prefixes: ['811'], take: 'netDebit' }] },
  { code: '40', label: 'Lợi nhuận khác', formula: [[1, '31'], [-1, '32']] },
  { code: '50', label: 'Tổng lợi nhuận kế toán trước thuế', formula: [[1, '30'], [1, '40']] },
  // 821 and its current-tax sub-accounts (8211, 82111, 82112), but not the deferred-tax account 8212, which line 52 reads.
  { code: '51', label: 'Chi phí thuế TNDN hiện hành', rules: [{ prefixes: ['821'], exclude: ['8212'], take: 'netDebit' }] },
  { code: '52', label: 'Chi phí thuế TNDN hoãn lại', rules: [{ prefixes: ['8212'], take: 'netDebit' }] },
  { code: '60', label: 'Lợi nhuận sau thuế thu nhập doanh nghiệp', formula: [[1, '50'], [-1, '51'], [-1, '52']] },
];

/** The B02 map of a regime. */
export function b02LinesFor(regime: StatementsRegime): readonly ReportLineDef[] {
  return regime === 'tt99' ? B02_LINES_TT99 : B02_LINES;
}

// The B02 lines other readers use, by what they mean: a code does not mean the same in the two maps (the overview's financial revenue is 21 under TT133 and 22 under TT99, where 21 is the investment-property line).
export interface B02Roles {
  netRevenue: string;
  // Lines whose amounts are added to net revenue and other income for "revenue" in the overview's chart (financial revenue, and TT99's investment-property gain or loss).
  financeRevenue: readonly string[];
  otherIncome: string;
  profit: string;
}
export const B02_ROLES: Record<StatementsRegime, B02Roles> = {
  tt133: { netRevenue: '10', financeRevenue: ['21'], otherIncome: '31', profit: '50' },
  tt99: { netRevenue: '10', financeRevenue: ['21', '22'], otherIncome: '31', profit: '50' },
};
