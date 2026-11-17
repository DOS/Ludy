// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic Vietnamese Labor Contract PDF renderer (Labor Code 2019 Art. 21, #3548).
// Pure function of its input: formats amounts through decimal.js (`money()` from @crove/l10n-vn),
// renders zero em dashes, and leaves clean two-column signature boxes ready for Ludy eSign.
import type { HrContractForm, HrPayFunction, HrProbationRoleTier, HrRegion } from '@crove/kernel-contract';
import {
  Decimal,
  compareCalendarDates,
  deriveFixedTermEndDate,
  deriveFixedTermEndDateIso,
  money,
  parseIsoCalendarDate,
} from '@crove/l10n-vn';
import { contractFonts, type FontSet, type FontWeight } from './pdf/fonts.ts';
import { A4_HEIGHT, A4_WIDTH, PdfDocument, type PdfPage, type Rgb } from './pdf/writer.ts';

export type LaborContractKindInput = 'indefinite' | 'fixed_term' | 'seasonal' | 'under_one_month' | 'none';

export interface LaborContractAllowance {
  name: string;
  amount: string;
}

export interface LaborContractEmployer {
  name: string;
  taxCode: string | null;
  address: string | null;
  representative?: string | null;
}

export interface LaborContractEmployee {
  id?: string | null;
  code?: string | null;
  displayName: string;
  birthDate: string | null;
  address?: string | null;
  identityMasked?: string | null;
  jobTitle: string | null;
  departmentName: string | null;
  workplace?: string | null;
}

export interface LaborContractTerms {
  id?: string | null;
  contractNumber?: string | null;
  contractType: LaborContractKindInput;
  contractForm?: HrContractForm | null;
  termMonths: number | null;
  effectiveFrom: string;
  contractEndOn: string | null;
  fixedTermSequence?: number | null;
  probationRoleTier?: HrProbationRoleTier | null;
  probationEndOn: string | null;
  probationWage?: string | null;
  probationPct?: string | null;
  baseWage: string;
  allowances?: readonly LaborContractAllowance[];
  region: HrRegion;
  payFunction: HrPayFunction;
  employeeInsurable?: boolean;
  taxResident?: boolean;
  flatTax?: boolean;
}

export interface LaborContractDocument {
  employer: LaborContractEmployer;
  employee: LaborContractEmployee;
  terms: LaborContractTerms;
  includeSignTags?: boolean;
}

const MARGIN = 44;
const WIDTH = A4_WIDTH - MARGIN * 2;
const TOP = A4_HEIGHT - MARGIN;
const BOTTOM = MARGIN + 30;
const SIZE = 9.5;
const LEADING = 13.5;

const INK: Rgb = [0.09, 0.1, 0.14];
const MUTED: Rgb = [0.38, 0.41, 0.47];
const RULE: Rgb = [0.76, 0.78, 0.83];
const BOX_BG: Rgb = [0.98, 0.98, 0.99];
const SIGN_TAG_INK: Rgb = [0.62, 0.65, 0.72];

const CONTRACT_TYPE_LABELS: Record<LaborContractKindInput, string> = {
  indefinite: 'Hợp đồng lao động không xác định thời hạn',
  fixed_term: 'Hợp đồng lao động xác định thời hạn',
  seasonal: 'Hợp đồng lao động theo mùa vụ / công việc nhất định',
  under_one_month: 'Hợp đồng lao động có thời hạn dưới 01 tháng',
  none: 'Hợp đồng lao động có thời hạn dưới 01 tháng',
};

const CONTRACT_FORM_LABELS: Record<HrContractForm, string> = {
  written: 'Bằng văn bản',
  electronic: 'Thông điệp dữ liệu điện tử',
  oral: 'Giao kết bằng lời nói (thời hạn dưới 01 tháng)',
};

const PAY_FUNCTION_LABELS: Record<HrPayFunction, string> = {
  admin: 'Quản lý doanh nghiệp',
  sales: 'Bán hàng',
  production: 'Sản xuất trực tiếp',
  overhead: 'Chi phí sản xuất chung',
  construction: 'Xây dựng cơ bản',
};

const PROBATION_TIER_LABELS: Record<HrProbationRoleTier, string> = {
  enterprise_manager: 'Người quản lý doanh nghiệp (tối đa 180 ngày lịch)',
  college_or_above: 'Chức danh yêu cầu trình độ cao đẳng trở lên (tối đa 60 ngày lịch)',
  intermediate_technical: 'Chức danh trung cấp, công nhân kỹ thuật (tối đa 30 ngày lịch)',
  other: 'Công việc khác (tối đa 06 ngày làm việc)',
};

export function sanitizeNoEmDash(value: string): string {
  return value.replaceAll('\u2014', '-');
}

export function vnDate(day: string | null | undefined): string {
  const match = day ? /^(\d{4})-(\d{2})-(\d{2})/.exec(day.trim()) : null;
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

export function vnNumber(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const digits = match[2] as string;
  let start = 0;
  while (start < digits.length - 1 && digits[start] === '0') start += 1;
  let whole = '';
  for (let end = digits.length; end > start; end -= 3) {
    whole = `${digits.slice(Math.max(start, end - 3), end)}${whole === '' ? '' : `.${whole}`}`;
  }
  const decimals = match[3] ?? '';
  let last = decimals.length;
  while (last > 0 && decimals[last - 1] === '0') last -= 1;
  return `${match[1]}${whole}${last > 0 ? `,${decimals.slice(0, last)}` : ''}`;
}

export function vnMoney(raw: string): string {
  const normalized = money(raw).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed();
  return vnNumber(normalized);
}

export function computeProbationPct(probationWage: string, baseWage: string): string | null {
  const base = money(baseWage);
  if (base.lte(0)) return null;
  const pct = money(probationWage).times(100).dividedBy(base).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed();
  return vnNumber(pct);
}

export function maskIdentifier(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.length <= 4) return '*'.repeat(trimmed.length);
  return `${'*'.repeat(Math.min(8, trimmed.length - 4))}${trimmed.slice(-4)}`;
}

export function defaultContractNumber(effectiveFrom: string, termsId?: string | null): string {
  const dateCompact = effectiveFrom.replaceAll('-', '');
  const hex = (termsId ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const tail = hex.length >= 6 ? hex.slice(-6) : hex.padStart(6, '0');
  return `HDLD-${dateCompact}-${tail}`;
}

export function defaultEmployeeCode(employeeId?: string | null): string | null {
  if (!employeeId) return null;
  const hex = employeeId.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (hex === '') return null;
  return `NV-${hex.length >= 8 ? hex.slice(-8) : hex}`;
}

export function contractTitle(displayName: string, effectiveFrom: string): string {
  return sanitizeNoEmDash(`Hợp đồng lao động - ${displayName.trim()} (${effectiveFrom})`);
}

export function contractFilename(displayName: string, effectiveFrom: string): string {
  const normalized = displayName.normalize('NFD');
  let slug = '';
  let pendingDash = false;
  for (let i = 0; i < normalized.length && slug.length < 48; i += 1) {
    const code = normalized.charCodeAt(i);
    if (code >= 0x0300 && code <= 0x036f) continue;
    let ch = '';
    if (code === 0x0111 || code === 0x0110) {
      ch = 'd';
    } else if (code >= 0x41 && code <= 0x5a) {
      ch = String.fromCharCode(code + 32);
    } else if ((code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39)) {
      ch = String.fromCharCode(code);
    }
    if (ch !== '') {
      if (pendingDash && slug !== '') {
        if (slug.length + 1 >= 48) break;
        slug += '-';
      }
      slug += ch;
      pendingDash = false;
    } else if (slug !== '') {
      pendingDash = true;
    }
  }
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) ? effectiveFrom : 'contract';
  return slug !== '' ? `hop-dong-lao-dong-${slug}-${safeDate}.pdf` : `hop-dong-lao-dong-${safeDate}.pdf`;
}

export function wrapLines(fonts: FontSet, text: string, weight: FontWeight, size: number, maxWidth: number): string[] {
  const cleanText = sanitizeNoEmDash(text);
  const lines: string[] = [];
  for (const paragraph of cleanText.split(/\r\n|\r|\n/)) {
    let current = '';
    const flush = () => {
      if (current !== '') lines.push(current);
      current = '';
    };
    for (const word of paragraph.split(/[ \t]+/).filter((w) => w !== '')) {
      const joined = current === '' ? word : `${current} ${word}`;
      if (fonts.measure(joined, weight, size) <= maxWidth) {
        current = joined;
        continue;
      }
      flush();
      if (fonts.measure(word, weight, size) <= maxWidth) {
        current = word;
        continue;
      }
      for (const ch of word) {
        if (current !== '' && fonts.measure(current + ch, weight, size) > maxWidth) flush();
        current += ch;
      }
    }
    if (current !== '') lines.push(current);
    else if (paragraph.trim() === '') lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length > 0 ? lines : [''];
}

class ContractWriter {
  readonly fonts: FontSet;
  readonly doc: PdfDocument;
  page!: PdfPage;
  y = TOP;

  constructor(fonts: FontSet, title: string, author: string) {
    this.fonts = fonts;
    this.doc = new PdfDocument(fonts, { title: sanitizeNoEmDash(title), author: sanitizeNoEmDash(author), subject: 'Hợp đồng lao động' });
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage();
    this.y = TOP;
  }

  room(height: number): void {
    if (this.y - height >= BOTTOM) return;
    this.newPage();
  }

  centered(text: string, weight: FontWeight, size: number, color: Rgb = INK): void {
    const cleanText = sanitizeNoEmDash(text);
    for (const line of wrapLines(this.fonts, cleanText, weight, size, WIDTH)) {
      this.room(size + 4);
      const x = MARGIN + (WIDTH - this.fonts.measure(line, weight, size)) / 2;
      this.page.text(x, this.y - size, line, { weight, size, color });
      this.y -= size + 4;
    }
  }

  sectionHeading(title: string): void {
    this.room(LEADING * 2.5);
    this.y -= 4;
    const cleanTitle = sanitizeNoEmDash(title);
    for (const line of wrapLines(this.fonts, cleanTitle, 'bold', 10.5, WIDTH)) {
      this.page.text(MARGIN, this.y - 10.5, line, { weight: 'bold', size: 10.5, color: INK });
      this.y -= 14;
    }
  }

  bullet(label: string, value: string): void {
    const lineText = sanitizeNoEmDash(`- ${label}: ${value}`);
    const lines = wrapLines(this.fonts, lineText, 'regular', SIZE, WIDTH - 8);
    for (let i = 0; i < lines.length; i += 1) {
      this.room(LEADING);
      const part = lines[i] ?? '';
      if (part !== '') {
        this.page.text(MARGIN + (i === 0 ? 0 : 10), this.y - SIZE, part, { weight: 'regular', size: SIZE, color: INK });
      }
      this.y -= LEADING;
    }
  }

  paragraph(text: string, color: Rgb = INK, size = SIZE): void {
    const lines = wrapLines(this.fonts, text, 'regular', size, WIDTH);
    for (const line of lines) {
      this.room(LEADING);
      if (line !== '') this.page.text(MARGIN, this.y - size, line, { weight: 'regular', size, color });
      this.y -= LEADING;
    }
  }
}

function renderNationalHeader(w: ContractWriter, contractRef: string): void {
  w.centered('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', 'bold', 10.5);
  w.centered('Độc lập - Tự do - Hạnh phúc', 'bold', 10);
  const ruleHalf = 78;
  const center = MARGIN + WIDTH / 2;
  w.page.line(center - ruleHalf, w.y - 1, center + ruleHalf, w.y - 1, { color: RULE, width: 0.7 });
  w.y -= 14;
  w.centered('HỢP ĐỒNG LAO ĐỘNG', 'bold', 15);
  w.centered(`Số: ${contractRef}`, 'bold', 9.5, MUTED);
  w.y -= 4;
  w.paragraph('Căn cứ Bộ luật Lao động số 45/2019/QH14 ngày 20/11/2019 và các văn bản hướng dẫn thi hành, hai bên thỏa thuận giao kết hợp đồng lao động với các điều khoản sau đây:', MUTED, 8.8);
  w.y -= 2;
}

function renderParties(w: ContractWriter, doc: LaborContractDocument): void {
  const { employer, employee, terms } = doc;
  w.sectionHeading('Điều 1. Các bên giao kết hợp đồng');

  w.paragraph('1. Bên A - Người sử dụng lao động:', INK, SIZE);
  w.bullet('Đơn vị / Pháp nhân', employer.name);
  w.bullet('Mã số thuế', employer.taxCode?.trim() || '(chưa cập nhật)');
  if (employer.address?.trim()) w.bullet('Địa chỉ trụ sở', employer.address.trim());
  if (employer.representative?.trim()) w.bullet('Người đại diện', employer.representative.trim());
  w.y -= 2;

  w.paragraph('2. Bên B - Người lao động:', INK, SIZE);
  w.bullet('Họ và tên', employee.displayName);
  const empCode = employee.code?.trim() || defaultEmployeeCode(employee.id);
  if (empCode) w.bullet('Mã nhân sự', empCode);
  if (employee.birthDate) w.bullet('Ngày sinh', vnDate(employee.birthDate));
  const maskedId = maskIdentifier(employee.identityMasked);
  if (maskedId) w.bullet('Số định danh (ẩn bảo mật)', maskedId);
  if (employee.address?.trim()) w.bullet('Địa chỉ liên hệ', employee.address.trim());
  w.bullet('Chức danh / vị trí chuyên môn', employee.jobTitle?.trim() || 'Theo phân công công việc của Bên A');
  if (employee.departmentName?.trim()) w.bullet('Phòng ban / bộ phận', employee.departmentName.trim());
  const workplace = employee.workplace?.trim() || employer.address?.trim() || null;
  w.bullet('Địa điểm làm việc', workplace ? `${workplace} (Vùng lương tối thiểu: Vùng ${terms.region})` : `Theo bố trí của Bên A (Vùng lương tối thiểu: Vùng ${terms.region})`);
}

function renderTermAndProbation(w: ContractWriter, doc: LaborContractDocument): void {
  const { terms } = doc;
  w.sectionHeading('Điều 2. Loại hợp đồng, thời hạn và thử việc');

  let kindLabel = CONTRACT_TYPE_LABELS[terms.contractType];
  if (terms.contractType === 'fixed_term' && terms.fixedTermSequence === 1) {
    kindLabel = `${kindLabel} (ký lần thứ 1)`;
  } else if (terms.contractType === 'fixed_term' && terms.fixedTermSequence === 2) {
    kindLabel = `${kindLabel} (ký gia hạn lần thứ 2)`;
  }
  w.bullet('Loại hợp đồng lao động', kindLabel);
  w.bullet('Hình thức giao kết', CONTRACT_FORM_LABELS[terms.contractForm ?? 'written']);
  if (terms.termMonths !== null) {
    w.bullet('Thời hạn hợp đồng', `${terms.termMonths} tháng`);
  }
  w.bullet('Ngày bắt đầu có hiệu lực', vnDate(terms.effectiveFrom) || terms.effectiveFrom);

  const effectiveEnd =
    terms.contractEndOn ??
    (terms.contractType === 'fixed_term' && terms.termMonths !== null
      ? deriveFixedTermEndDateIso(terms.effectiveFrom, terms.termMonths)
      : null);
  if (effectiveEnd) {
    w.bullet('Ngày kết thúc hợp đồng', vnDate(effectiveEnd) || effectiveEnd);
  }

  const hasProbation = Boolean(terms.probationEndOn || terms.probationWage || terms.probationPct || terms.probationRoleTier);
  if (!hasProbation) {
    w.bullet('Thử việc', 'Không áp dụng thử việc');
    return;
  }

  const parts: string[] = [];
  if (terms.probationEndOn) {
    parts.push(`từ ngày ${vnDate(terms.effectiveFrom) || terms.effectiveFrom} đến hết ngày ${vnDate(terms.probationEndOn) || terms.probationEndOn}`);
  }
  if (terms.probationRoleTier) {
    parts.push(`nhóm vị trí: ${PROBATION_TIER_LABELS[terms.probationRoleTier]}`);
  }
  const pct =
    terms.probationPct?.trim() ||
    (terms.probationWage ? computeProbationPct(terms.probationWage, terms.baseWage) : null);
  if (terms.probationWage) {
    parts.push(`lương thử việc: ${vnMoney(terms.probationWage)} VND/tháng${pct ? ` (${pct}% mức lương cơ bản, tối thiểu 85% theo Điều 26 Bộ luật Lao động 2019)` : ''}`);
  } else if (pct) {
    parts.push(`hưởng ${pct}% mức lương cơ bản của công việc (tối thiểu 85% theo Điều 26 Bộ luật Lao động 2019)`);
  }
  w.bullet('Thỏa thuận thử việc', parts.join('; '));
}

function renderCompensationAndBenefits(w: ContractWriter, doc: LaborContractDocument): void {
  const { terms } = doc;
  w.sectionHeading('Điều 3. Tiền lương, phụ cấp và chế độ thanh toán');
  w.bullet('Mức lương cơ bản theo công việc / chức danh', `${vnMoney(terms.baseWage)} VND/tháng`);
  w.bullet('Vùng lương tối thiểu áp dụng', `Vùng ${terms.region}`);
  w.bullet('Bộ phận / khoản mục hạch toán', PAY_FUNCTION_LABELS[terms.payFunction]);

  if (terms.allowances && terms.allowances.length > 0) {
    const formatted = terms.allowances.map((a) => `${sanitizeNoEmDash(a.name)}: ${vnMoney(a.amount)} VND/tháng`).join('; ');
    w.bullet('Phụ cấp thỏa thuận theo hợp đồng', formatted);
  } else {
    w.bullet('Phụ cấp và các khoản bổ sung khác', 'Thực hiện theo quy chế tiền lương của Bên A và phụ lục hợp đồng (nếu có)');
  }
  w.bullet('Hình thức và kỳ hạn trả lương', 'Thanh toán hàng tháng bằng chuyển khoản hoặc tiền mặt theo quy chế trả lương của Bên A, đúng thời hạn tại Điều 94 và Điều 97 Bộ luật Lao động 2019');
  w.bullet('Chế độ nâng bậc, nâng lương', 'Xét điều chỉnh định kỳ theo hiệu quả công việc và quy chế lương thưởng của Bên A');
}

function renderComplianceClause(w: ContractWriter, doc: LaborContractDocument): void {
  const { terms } = doc;
  w.sectionHeading('Điều 4. Thời giờ làm việc, bảo hiểm bắt buộc và thuế TNCN');
  w.bullet('Thời giờ làm việc và nghỉ ngơi', 'Thực hiện theo nội quy lao động của Bên A, đảm bảo thời giờ làm việc bình thường, nghỉ hàng tuần, nghỉ lễ Tết và nghỉ phép năm hưởng nguyên lương theo Điều 105, Điều 112 và Điều 113 Bộ luật Lao động 2019');

  const insurable = terms.employeeInsurable ?? (terms.contractType !== 'none' && terms.contractType !== 'under_one_month');
  if (insurable) {
    w.bullet('Bảo hiểm bắt buộc (BHXH, BHYT, BHTN)', 'Bên A và Bên B có trách nhiệm trích nộp bảo hiểm xã hội, bảo hiểm y tế và bảo hiểm thất nghiệp bắt buộc theo đúng tỷ lệ và mức đóng của pháp luật hiện hành');
  } else {
    w.bullet('Bảo hiểm bắt buộc (BHXH, BHYT, BHTN)', 'Đối với hợp đồng có thời hạn dưới 01 tháng, chế độ bảo hiểm thực hiện theo quy định của Luật Bảo hiểm xã hội và Bộ luật Lao động hiện hành');
  }

  if (terms.taxResident === false) {
    w.bullet(
      'Thuế thu nhập cá nhân (TNCN)',
      'Bên A thực hiện khấu trừ thuế TNCN theo biểu thuế toàn phần đối với cá nhân không cư trú trước khi chi trả thu nhập theo quy định của Luật Thuế thu nhập cá nhân',
    );
  } else if (terms.flatTax ?? isFlatTaxContract(terms)) {
    w.bullet(
      'Thuế thu nhập cá nhân (TNCN)',
      'Bên A thực hiện khấu trừ thuế TNCN theo tỷ lệ toàn phần (10% đối với khoản chi trả từ mức luật định trở lên đối với hợp đồng dưới 03 tháng hoặc không ký hợp đồng dài hạn, trừ trường hợp có cam kết theo quy định của Luật Thuế thu nhập cá nhân)',
    );
  } else {
    w.bullet(
      'Thuế thu nhập cá nhân (TNCN)',
      'Bên A thực hiện khấu trừ thuế TNCN theo biểu thuế lũy tiến từng phần đối với cá nhân cư trú sau khi tính giảm trừ gia cảnh theo quy định của Luật Thuế thu nhập cá nhân',
    );
  }
}

export function isFlatTaxContract(
  terms: Pick<LaborContractTerms, 'contractType' | 'termMonths' | 'effectiveFrom' | 'contractEndOn'>,
): boolean {
  if (terms.contractType === 'indefinite') return false;
  if (terms.contractType === 'none' || terms.contractType === 'under_one_month') return true;
  if (terms.termMonths !== null) return terms.termMonths < 3;
  if (terms.contractEndOn !== null) {
    const start = parseIsoCalendarDate(terms.effectiveFrom);
    const end = parseIsoCalendarDate(terms.contractEndOn);
    if (start !== null && end !== null) {
      return compareCalendarDates(end, deriveFixedTermEndDate(start, 3)) < 0;
    }
  }
  return terms.contractType === 'seasonal';
}

function renderExecutionAndSignatures(w: ContractWriter, doc: LaborContractDocument): void {
  const { employer, employee, terms } = doc;
  w.sectionHeading('Điều 5. Điều khoản thi hành');
  w.paragraph(
    `Hợp đồng lao động này có hiệu lực kể từ ngày ${vnDate(terms.effectiveFrom) || terms.effectiveFrom}. Những nội dung lao động khác không ghi trong hợp đồng này được áp dụng theo thỏa ước lao động tập thể, nội quy lao động của Bên A và pháp luật lao động Việt Nam.`,
  );

  const colGap = 24;
  const colWidth = (WIDTH - colGap) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + colWidth + colGap;
  const innerWidth = colWidth - 8;

  const leftHeadLines = wrapLines(w.fonts, 'ĐẠI DIỆN NGƯỜI SỬ DỤNG LAO ĐỘNG (BÊN A)', 'bold', 9, innerWidth);
  const rightHeadLines = wrapLines(w.fonts, 'NGƯỜI LAO ĐỘNG (BÊN B)', 'bold', 9, innerWidth);
  const headRows = Math.max(leftHeadLines.length, rightHeadLines.length);

  const leftSubLines = wrapLines(w.fonts, '(Ký, ghi rõ họ tên và đóng dấu - nếu có)', 'regular', 8, innerWidth);
  const rightSubLines = wrapLines(w.fonts, '(Ký và ghi rõ họ tên)', 'regular', 8, innerWidth);
  const subRows = Math.max(leftSubLines.length, rightSubLines.length);

  const leftNameLines = wrapLines(w.fonts, employer.representative?.trim() || employer.name, 'bold', 9, innerWidth);
  const rightNameLines = wrapLines(w.fonts, employee.displayName, 'bold', 9, innerWidth);
  const nameRows = Math.max(leftNameLines.length, rightNameLines.length);

  // Keep the entire two-column signature block intact on one page so eSign boxes and wrapped names never split or clip.
  const headLeading = 12;
  const subLeading = 11;
  const nameLeading = 12;
  const boxHeight = 76;
  const blockHeight = 10 + headRows * headLeading + 4 + subRows * subLeading + 8 + boxHeight + 14 + nameRows * nameLeading + 8;
  w.room(blockHeight);
  w.y -= 10;

  const drawCenteredLines = (
    colX: number,
    lines: readonly string[],
    startBaselineY: number,
    lineStep: number,
    weight: FontWeight,
    size: number,
    color: Rgb = INK,
  ) => {
    lines.forEach((line, idx) => {
      const tx = colX + (colWidth - w.fonts.measure(line, weight, size)) / 2;
      w.page.text(tx, startBaselineY - idx * lineStep, line, { weight, size, color });
    });
  };

  const headStartY = w.y - 9.5;
  drawCenteredLines(leftX, leftHeadLines, headStartY, headLeading, 'bold', 9);
  drawCenteredLines(rightX, rightHeadLines, headStartY, headLeading, 'bold', 9);

  const subStartY = headStartY - (headRows - 1) * headLeading - 12;
  drawCenteredLines(leftX, leftSubLines, subStartY, subLeading, 'regular', 8, MUTED);
  drawCenteredLines(rightX, rightSubLines, subStartY, subLeading, 'regular', 8, MUTED);

  const boxTop = subStartY - (subRows - 1) * subLeading - 8;
  const boxBottom = boxTop - boxHeight;
  w.page.rect(leftX + 8, boxBottom, colWidth - 16, boxHeight, { fill: BOX_BG, stroke: RULE, lineWidth: 0.6, dash: [3, 2] });
  w.page.rect(rightX + 8, boxBottom, colWidth - 16, boxHeight, { fill: BOX_BG, stroke: RULE, lineWidth: 0.6, dash: [3, 2] });

  if (doc.includeSignTags) {
    w.page.text(leftX + 16, boxBottom + 36, '{{signature, r1}}', { weight: 'regular', size: 8, color: SIGN_TAG_INK });
    w.page.text(leftX + 16, boxBottom + 14, '{{date, r1}}', { weight: 'regular', size: 8, color: SIGN_TAG_INK });
    w.page.text(rightX + 16, boxBottom + 36, '{{signature, r2}}', { weight: 'regular', size: 8, color: SIGN_TAG_INK });
    w.page.text(rightX + 16, boxBottom + 14, '{{date, r2}}', { weight: 'regular', size: 8, color: SIGN_TAG_INK });
  }

  const nameStartY = boxBottom - 14;
  drawCenteredLines(leftX, leftNameLines, nameStartY, nameLeading, 'bold', 9);
  drawCenteredLines(rightX, rightNameLines, nameStartY, nameLeading, 'bold', 9);
  w.y = nameStartY - (nameRows - 1) * nameLeading - 8;
}

function renderFooters(w: ContractWriter, contractRef: string, employerName: string): void {
  const total = w.doc.pages.length;
  const leftLabel = sanitizeNoEmDash(`${employerName} - Hợp đồng lao động số ${contractRef}`);
  w.doc.pages.forEach((page, index) => {
    page.line(MARGIN, MARGIN + 14, MARGIN + WIDTH, MARGIN + 14, { color: RULE, width: 0.4 });
    const fit = wrapLines(w.fonts, leftLabel, 'regular', 7.8, WIDTH - 80)[0] ?? '';
    page.text(MARGIN, MARGIN + 2, fit, { weight: 'regular', size: 7.8, color: MUTED });
    const pageText = `Trang ${index + 1}/${total}`;
    page.text(MARGIN + WIDTH - w.fonts.measure(pageText, 'regular', 7.8), MARGIN + 2, pageText, {
      weight: 'regular',
      size: 7.8,
      color: MUTED,
    });
  });
}

export function renderLaborContractPdf(doc: LaborContractDocument, fonts: FontSet = contractFonts()): Uint8Array {
  const contractRef = doc.terms.contractNumber?.trim() || defaultContractNumber(doc.terms.effectiveFrom, doc.terms.id);
  const title = contractTitle(doc.employee.displayName, doc.terms.effectiveFrom);
  const w = new ContractWriter(fonts, title, doc.employer.name);
  renderNationalHeader(w, contractRef);
  renderParties(w, doc);
  renderTermAndProbation(w, doc);
  renderCompensationAndBenefits(w, doc);
  renderComplianceClause(w, doc);
  renderExecutionAndSignatures(w, doc);
  renderFooters(w, contractRef, doc.employer.name);
  return w.doc.toBytes();
}
