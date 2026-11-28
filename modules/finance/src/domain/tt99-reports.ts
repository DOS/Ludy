// SPDX-License-Identifier: AGPL-3.0-only
// DRAFT: the TT99 (Circular 99/2025/TT-BTC, which replaces Circular 200/2014 for fiscal years from 1 January 2026) income statement B 02-DN and statement of financial position B 01-DN as maps of lines to accounts, for the entities whose
// books on the period's last day are TT99 (legal_entity_books). The mapping is data: a correction is a change to these tables. The accountant has NOT confirmed the maps (issue #61), so the statements are not for filing, as for tt133-reports.ts.
//
// SOURCE (#5269, 2026-11-28): the line codes, labels, formulas and the accounts each line reads were checked against the OFFICIAL text, Circular 99 Phụ lục IV in Công báo điện tử numbers 1577+1578 (the forms, pp. 33 to 47) and 1579+1580
// (the "phương pháp lập", pp. 56 to 96) of 16 November 2025, with Phụ lục II (the chart) and the sections of TK 521, 217 and 411; the table with every item and its citation is https://github.com/DOS/Ludy/issues/61#issuecomment-7236284209.
// The first version of the B02 map (#5187) came from two secondary pages (ketoanleanh.edu.vn and amis.misa.vn) and the B01 map (#5204) from a Google Docs copy of the form; the official text agrees with their codes and labels.
//
// What differs from the TT133 map (tt133-reports.ts), so a code is never read across the two: line 21 is new (the gain or loss on selling investment property), financial revenue is 22 (TT133: 21), financial expense 23 (TT133: 22),
// borrowing cost 24 (TT133: 23), selling expense has its own line 25 (TT133 folds it into 24), administration is 26 (TT133: 24), and line 52 (deferred income tax) is new. Lines 01, 02, 10, 11, 20, 30, 31, 32, 40, 50, 51 and 60 keep
// their codes. Lines 70 and 71 (earnings per share, joint-stock companies only) are left out, as the TT133 map leaves them out.
//
// B02 open points, all recorded as uncertain in #61: line 21 reads no account (the official text defines it from detail on 511 and 632 that the chart has no sub-account for, and lines 01 and 11 still include an investment-property sale); line 24
// reads 6351, a Ludy convention (the official text says only "the detail ledger of TK 635", and the chart has no sub-account of 635); the official netting of exchange-rate gains and losses on lines 22 and 23 is not done. Line 02 reads the 521 debit
// and a 511 debit only from an entry that does not touch 521, because the period-end entry Dr 511 / Cr 521 closes the 521 debit (official line 02: the 511 debit that pairs with a 521 credit). Class 6 to 8 accounts no line reads (621, 622, 623 and
// 627 are closed to 154 and 632 before the period ends, and have no ending balance in the circular) stay in `unmapped`.
//
// B01 open points, all recorded as uncertain in #61: Ludy holds no maturity data, so an account the form splits into short and long term is read on the SHORT-term line and the long-term line reads nothing (the TT133 map does the same); only accounts
// long-term by nature feed long-term lines. This covers 1281 (the form puts a term deposit of at most 3 months on 112, the rest on 123 or 265), 244 and 344 (the form reads each on a short and a long line), 2288 (165 or 274) and the provision 2292
// (124, 126 or 264). A preferred share (41112) is read as equity (411b); the form puts one classified as a liability on 341. Line 420b also takes the unclosed result of earlier years (the form has only 4211 and 4212). A balance no line reads
// stays in `unmapped`.
import { B01_TT133, B02_LINES, type B01Setup, type ReportLineDef } from './tt133-reports.ts';

export type StatementsRegime = 'tt133' | 'tt99';

export const B02_LINES_TT99: readonly ReportLineDef[] = [
  { code: '01', label: 'Doanh thu bán hàng và cung cấp dịch vụ', rules: [{ prefixes: ['511'], take: 'creditTurnover' }] },
  // Official: the 511 debit that pairs with a 521 credit (the period-end entry Dr 511 / Cr 521), which is the 521 debit turnover; 521 has no closing balance. So the 521 debit is read, and a 511 debit is read only from an entry that does not touch 521:
  // that leaves out the closing entry (it does not touch 911, so the engine would read it on top of the 521 debit, twice the deduction in a closed period) and keeps a return booked straight on 511 (as TT133 reads it).
  { code: '02', label: 'Các khoản giảm trừ doanh thu', rules: [{ prefixes: ['521'], take: 'debitTurnover' }, { prefixes: ['511'], skipEntriesTouching: ['521'], take: 'debitTurnover' }] },
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

const sum = (...codes: string[]) => codes.map((code) => [1, code] as const);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

// B01-DN (TT99), going-concern form, in the form's own order: a total comes before its parts (evaluate resolves the later lines). Lines with no rule and no formula read no account (see the header).
export const B01_LINES_TT99: readonly ReportLineDef[] = [
  { code: '100', label: 'TÀI SẢN NGẮN HẠN', formula: sum('110', '120', '130', '140', '150', '160') },
  { code: '110', label: 'Tiền và các khoản tương đương tiền', formula: sum('111', '112') },
  { code: '111', label: 'Tiền', rules: [{ prefixes: ['111', '112', '113'], take: 'debit' }] },
  { code: '112', label: 'Các khoản tương đương tiền' },
  { code: '120', label: 'Đầu tư tài chính ngắn hạn', formula: sum(...range(121, 126)) },
  { code: '121', label: 'Chứng khoán kinh doanh', rules: [{ prefixes: ['121'], take: 'debit' }] },
  { code: '122', label: 'Dự phòng giảm giá chứng khoán kinh doanh (*)', rules: [{ prefixes: ['2291'], take: 'credit', sign: -1 }] },
  { code: '123', label: 'Đầu tư nắm giữ đến ngày đáo hạn ngắn hạn', rules: [{ prefixes: ['128'], take: 'debit' }] },
  { code: '124', label: 'Dự phòng đầu tư nắm giữ đến ngày đáo hạn ngắn hạn (*)' },
  { code: '125', label: 'Đầu tư ngắn hạn khác' },
  { code: '126', label: 'Dự phòng tổn thất các khoản đầu tư ngắn hạn khác (*)' },
  { code: '130', label: 'Các khoản phải thu ngắn hạn', formula: sum(...range(131, 137)) },
  { code: '131', label: 'Phải thu ngắn hạn của khách hàng', rules: [{ prefixes: ['131'], take: 'debit', byParty: true }] },
  { code: '132', label: 'Trả trước cho người bán ngắn hạn', rules: [{ prefixes: ['331'], take: 'debit', byParty: true }] },
  { code: '133', label: 'Phải thu nội bộ ngắn hạn', rules: [{ prefixes: ['136'], exclude: ['1361'], take: 'debit' }] },
  { code: '134', label: 'Phải thu theo tiến độ hợp đồng xây dựng', rules: [{ prefixes: ['337'], take: 'debit' }] },
  { code: '135', label: 'Phải thu ngắn hạn khác', rules: [{ prefixes: ['138', '141', '334', '338'], exclude: ['1381', '1383'], take: 'debit' }] },
  { code: '136', label: 'Dự phòng phải thu ngắn hạn khó đòi (*)', rules: [{ prefixes: ['2293'], take: 'credit', sign: -1 }] },
  { code: '137', label: 'Tài sản thiếu chờ xử lý', rules: [{ prefixes: ['1381'], take: 'debit' }] },
  { code: '140', label: 'Hàng tồn kho', formula: sum('141', '142') },
  { code: '141', label: 'Hàng tồn kho', rules: [{ prefixes: range(151, 158), take: 'debit' }] },
  { code: '142', label: 'Dự phòng giảm giá hàng tồn kho (*)', rules: [{ prefixes: ['2294'], take: 'credit', sign: -1 }] },
  { code: '150', label: 'Tài sản sinh học ngắn hạn', formula: sum('151', '152', '153') },
  { code: '151', label: 'Súc vật nuôi lấy sản phẩm một lần ngắn hạn', rules: [{ prefixes: ['2152'], take: 'debit' }] },
  { code: '152', label: 'Cây trồng theo mùa vụ hoặc lấy sản phẩm một lần ngắn hạn', rules: [{ prefixes: ['2153'], take: 'debit' }] },
  { code: '153', label: 'Dự phòng tổn thất tài sản sinh học ngắn hạn (*)', rules: [{ prefixes: ['2295'], take: 'credit', sign: -1 }] },
  { code: '160', label: 'Tài sản ngắn hạn khác', formula: sum(...range(161, 165)) },
  { code: '161', label: 'Chi phí chờ phân bổ ngắn hạn', rules: [{ prefixes: ['242'], take: 'debit' }] },
  { code: '162', label: 'Thuế GTGT được khấu trừ', rules: [{ prefixes: ['133'], take: 'debit' }] },
  // Official: the debit of 1383 (special consumption tax on imported goods) and of 333.
  { code: '163', label: 'Thuế và các khoản khác phải thu Nhà nước', rules: [{ prefixes: ['333', '1383'], take: 'debit' }] },
  { code: '164', label: 'Giao dịch mua bán lại trái phiếu Chính phủ', rules: [{ prefixes: ['171'], take: 'debit' }] },
  // Official: the debit of 2288 (other investments), short term; its long-term part is line 274. Ludy holds no maturity data, so all of it is read here, and line 274 reads nothing.
  { code: '165', label: 'Tài sản ngắn hạn khác', rules: [{ prefixes: ['2288'], take: 'debit' }] },
  { code: '200', label: 'TÀI SẢN DÀI HẠN', formula: sum('210', '220', '230', '240', '250', '260', '270') },
  { code: '210', label: 'Các khoản phải thu dài hạn', formula: sum(...range(211, 216)) },
  { code: '211', label: 'Phải thu dài hạn của khách hàng' },
  { code: '212', label: 'Trả trước cho người bán dài hạn' },
  { code: '213', label: 'Vốn kinh doanh ở đơn vị trực thuộc', rules: [{ prefixes: ['1361'], take: 'debit' }] },
  { code: '214', label: 'Phải thu nội bộ dài hạn' },
  { code: '215', label: 'Phải thu dài hạn khác', rules: [{ prefixes: ['244'], take: 'debit' }] },
  { code: '216', label: 'Dự phòng phải thu dài hạn khó đòi (*)' },
  { code: '220', label: 'Tài sản cố định', formula: sum('221', '224', '227') },
  { code: '221', label: 'Tài sản cố định hữu hình', formula: sum('222', '223') },
  { code: '222', label: 'Tài sản cố định hữu hình: nguyên giá', rules: [{ prefixes: ['211'], take: 'debit' }] },
  { code: '223', label: 'Tài sản cố định hữu hình: giá trị hao mòn lũy kế (*)', rules: [{ prefixes: ['2141'], take: 'credit', sign: -1 }] },
  { code: '224', label: 'Tài sản cố định thuê tài chính', formula: sum('225', '226') },
  { code: '225', label: 'Tài sản cố định thuê tài chính: nguyên giá', rules: [{ prefixes: ['212'], take: 'debit' }] },
  { code: '226', label: 'Tài sản cố định thuê tài chính: giá trị hao mòn lũy kế (*)', rules: [{ prefixes: ['2142'], take: 'credit', sign: -1 }] },
  { code: '227', label: 'Tài sản cố định vô hình', formula: sum('228', '229') },
  { code: '228', label: 'Tài sản cố định vô hình: nguyên giá', rules: [{ prefixes: ['213'], take: 'debit' }] },
  { code: '229', label: 'Tài sản cố định vô hình: giá trị hao mòn lũy kế (*)', rules: [{ prefixes: ['2143'], take: 'credit', sign: -1 }] },
  { code: '230', label: 'Tài sản sinh học dài hạn', formula: sum('231', '236', '237', '238') },
  { code: '231', label: 'Súc vật nuôi cho sản phẩm định kỳ', formula: sum('232', '233') },
  { code: '232', label: 'Súc vật nuôi cho sản phẩm định kỳ chưa đến giai đoạn trưởng thành', rules: [{ prefixes: ['21511'], take: 'debit' }] },
  { code: '233', label: 'Súc vật nuôi cho sản phẩm định kỳ đến giai đoạn trưởng thành', formula: sum('234', '235') },
  { code: '234', label: 'Súc vật nuôi cho sản phẩm định kỳ đến giai đoạn trưởng thành: nguyên giá', rules: [{ prefixes: ['215121'], take: 'debit' }] },
  { code: '235', label: 'Súc vật nuôi cho sản phẩm định kỳ đến giai đoạn trưởng thành: giá trị khấu hao lũy kế (*)', rules: [{ prefixes: ['215122'], take: 'credit', sign: -1 }] },
  { code: '236', label: 'Súc vật nuôi lấy sản phẩm một lần dài hạn' },
  { code: '237', label: 'Cây trồng theo mùa vụ hoặc lấy sản phẩm một lần dài hạn' },
  { code: '238', label: 'Dự phòng tổn thất tài sản sinh học dài hạn (*)' },
  { code: '240', label: 'Bất động sản đầu tư', formula: sum('241', '242') },
  { code: '241', label: 'Bất động sản đầu tư: nguyên giá', rules: [{ prefixes: ['217'], take: 'debit' }] },
  { code: '242', label: 'Bất động sản đầu tư: giá trị hao mòn lũy kế (*)', rules: [{ prefixes: ['2147'], take: 'credit', sign: -1 }] },
  { code: '250', label: 'Tài sản dở dang dài hạn', formula: sum('251', '252') },
  { code: '251', label: 'Chi phí sản xuất, kinh doanh dở dang dài hạn' },
  { code: '252', label: 'Chi phí xây dựng cơ bản dở dang', rules: [{ prefixes: ['241'], take: 'debit' }] },
  { code: '260', label: 'Đầu tư tài chính dài hạn', formula: sum(...range(261, 266)) },
  { code: '261', label: 'Đầu tư vào công ty con', rules: [{ prefixes: ['221'], take: 'debit' }] },
  { code: '262', label: 'Đầu tư vào công ty liên doanh, liên kết', rules: [{ prefixes: ['222'], take: 'debit' }] },
  { code: '263', label: 'Đầu tư góp vốn vào đơn vị khác', rules: [{ prefixes: ['2281'], take: 'debit' }] },
  { code: '264', label: 'Dự phòng tổn thất đầu tư vào đơn vị khác dài hạn (*)', rules: [{ prefixes: ['2292'], take: 'credit', sign: -1 }] },
  { code: '265', label: 'Đầu tư nắm giữ đến ngày đáo hạn dài hạn' },
  { code: '266', label: 'Dự phòng đầu tư nắm giữ đến ngày đáo hạn dài hạn (*)' },
  { code: '270', label: 'Tài sản dài hạn khác', formula: sum(...range(271, 274)) },
  { code: '271', label: 'Chi phí chờ phân bổ dài hạn' },
  { code: '272', label: 'Tài sản thuế thu nhập hoãn lại', rules: [{ prefixes: ['243'], take: 'debit' }] },
  { code: '273', label: 'Thiết bị, vật tư, phụ tùng thay thế dài hạn' },
  { code: '274', label: 'Tài sản dài hạn khác' },
  { code: '280', label: 'TỔNG CỘNG TÀI SẢN', formula: sum('100', '200') },
  { code: '300', label: 'NỢ PHẢI TRẢ', formula: sum('310', '330') },
  { code: '310', label: 'Nợ ngắn hạn', formula: sum(...range(311, 325)) },
  { code: '311', label: 'Phải trả người bán ngắn hạn', rules: [{ prefixes: ['331'], take: 'credit', byParty: true }] },
  { code: '312', label: 'Người mua trả tiền trước ngắn hạn', rules: [{ prefixes: ['131'], take: 'credit', byParty: true }] },
  { code: '313', label: 'Phải trả cổ tức, lợi nhuận', rules: [{ prefixes: ['332'], take: 'credit' }] },
  { code: '314', label: 'Thuế và các khoản phải nộp Nhà nước ngắn hạn', rules: [{ prefixes: ['333'], take: 'credit' }] },
  { code: '315', label: 'Phải trả người lao động', rules: [{ prefixes: ['334'], take: 'credit' }] },
  { code: '316', label: 'Chi phí phải trả ngắn hạn', rules: [{ prefixes: ['335'], take: 'credit' }] },
  { code: '317', label: 'Phải trả nội bộ ngắn hạn', rules: [{ prefixes: ['336'], exclude: ['3361'], take: 'credit' }] },
  { code: '318', label: 'Phải trả theo tiến độ hợp đồng xây dựng ngắn hạn', rules: [{ prefixes: ['337'], take: 'credit' }] },
  { code: '319', label: 'Doanh thu chờ phân bổ ngắn hạn', rules: [{ prefixes: ['3387'], take: 'credit' }] },
  { code: '320', label: 'Phải trả ngắn hạn khác', rules: [{ prefixes: ['338', '1388'], exclude: ['3387'], take: 'credit' }] },
  { code: '321', label: 'Vay và nợ thuê tài chính ngắn hạn', rules: [{ prefixes: ['341'], take: 'credit' }] },
  { code: '322', label: 'Dự phòng phải trả ngắn hạn', rules: [{ prefixes: ['352'], take: 'credit' }] },
  { code: '323', label: 'Quỹ khen thưởng, phúc lợi', rules: [{ prefixes: ['353'], take: 'credit' }] },
  { code: '324', label: 'Quỹ bình ổn giá', rules: [{ prefixes: ['357'], take: 'credit' }] },
  { code: '325', label: 'Giao dịch mua bán lại trái phiếu Chính phủ' },
  { code: '330', label: 'Nợ dài hạn', formula: sum(...range(331, 344)) },
  { code: '331', label: 'Phải trả người bán dài hạn' },
  { code: '332', label: 'Người mua trả tiền trước dài hạn' },
  { code: '333', label: 'Thuế và các khoản phải nộp Nhà nước dài hạn' },
  { code: '334', label: 'Chi phí phải trả dài hạn' },
  { code: '335', label: 'Phải trả nội bộ về vốn kinh doanh', rules: [{ prefixes: ['3361'], take: 'credit' }] },
  { code: '336', label: 'Phải trả nội bộ dài hạn' },
  { code: '337', label: 'Doanh thu chờ phân bổ dài hạn' },
  { code: '338', label: 'Phải trả dài hạn khác', rules: [{ prefixes: ['344'], take: 'credit' }] },
  { code: '339', label: 'Vay và nợ thuê tài chính dài hạn', rules: [{ prefixes: ['3431'], take: 'credit' }] },
  { code: '340', label: 'Trái phiếu chuyển đổi', rules: [{ prefixes: ['3432'], take: 'credit' }] },
  { code: '341', label: 'Cổ phiếu ưu đãi' },
  { code: '342', label: 'Thuế thu nhập hoãn lại phải trả', rules: [{ prefixes: ['347'], take: 'credit' }] },
  { code: '343', label: 'Dự phòng phải trả dài hạn' },
  { code: '344', label: 'Quỹ phát triển khoa học và công nghệ', rules: [{ prefixes: ['356'], take: 'credit' }] },
  { code: '400', label: 'VỐN CHỦ SỞ HỮU', formula: sum(...range(411, 420)) },
  { code: '411', label: 'Vốn góp của chủ sở hữu', formula: sum('411a', '411b') },
  { code: '411a', label: 'Vốn góp: cổ phiếu phổ thông có quyền biểu quyết', rules: [{ prefixes: ['4111'], exclude: ['41112'], take: 'credit' }] },
  { code: '411b', label: 'Vốn góp: cổ phiếu ưu đãi', rules: [{ prefixes: ['41112'], take: 'credit' }] },
  { code: '412', label: 'Thặng dư vốn', rules: [{ prefixes: ['4112'], take: 'netCredit' }] },
  { code: '413', label: 'Quyền chọn chuyển đổi trái phiếu', rules: [{ prefixes: ['4113'], take: 'credit' }] },
  { code: '414', label: 'Vốn khác của chủ sở hữu', rules: [{ prefixes: ['4118'], take: 'credit' }] },
  { code: '415', label: 'Cổ phiếu mua lại của chính mình (*)', rules: [{ prefixes: ['419'], take: 'debit', sign: -1 }] },
  { code: '416', label: 'Chênh lệch đánh giá lại tài sản', rules: [{ prefixes: ['412'], take: 'netCredit' }] },
  { code: '417', label: 'Chênh lệch tỷ giá hối đoái', rules: [{ prefixes: ['413'], take: 'netCredit' }] },
  { code: '418', label: 'Quỹ đầu tư phát triển', rules: [{ prefixes: ['414'], take: 'credit' }] },
  { code: '419', label: 'Quỹ khác thuộc vốn chủ sở hữu', rules: [{ prefixes: ['418'], take: 'credit' }] },
  { code: '420', label: 'Lợi nhuận sau thuế chưa phân phối', formula: sum('420a', '420b') },
  { code: '420a', label: 'LNST chưa phân phối lũy kế đến cuối kỳ trước', rules: [{ prefixes: ['421'], exclude: ['4212'], take: 'netCredit' }] },
  // The result not yet closed to 421 (classes 5 to 8 and 911) belongs to this period's line, as line 417 of the TT133 map has it; after the year-end closing entries those are all zero.
  { code: '420b', label: 'LNST chưa phân phối kỳ này', rules: [{ prefixes: ['4212', '5', '6', '7', '8', '911'], take: 'netCredit' }] },
  { code: '440', label: 'TỔNG CỘNG NGUỒN VỐN', formula: sum('300', '400') },
];

/** The B01 map of a regime with the two lines whose equality is the balance check (total assets 280 and total sources 440 under TT99). */
export const B01_TT99: B01Setup = { defs: B01_LINES_TT99, assets: '280', sources: '440' };
export function b01For(regime: StatementsRegime): B01Setup {
  return regime === 'tt99' ? B01_TT99 : B01_TT133;
}

// The B01 lines other readers use, by what they mean (cash, what customers owe, what is owed to suppliers). The codes are 110, 131 and 311 under both maps and mean the same; the table makes that a tested fact.
export interface B01Roles {
  cash: string;
  receivables: string;
  payables: string;
}
export const B01_ROLES: Record<StatementsRegime, B01Roles> = {
  tt133: { cash: '110', receivables: '131', payables: '311' },
  tt99: { cash: '110', receivables: '131', payables: '311' },
};
