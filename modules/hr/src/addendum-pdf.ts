// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic Vietnamese Labor Contract Addendum PDF generator (#4528 Stage 6C).
// Reuses the Be Vietnam Pro font loader and pure PDF 1.7 writer from contract-pdf.
import { money } from '@ludy/l10n-vn';
import {
  sanitizeNoEmDash as sanitizeBaseNoEmDash,
  vnDate,
  vnMoney,
  wrapLines,
} from './contract-pdf.ts';
import { contractFonts, type FontSet } from './pdf/fonts.ts';
import { A4_HEIGHT, A4_WIDTH, PdfDocument, type Rgb, type TextStyle } from './pdf/writer.ts';

const sanitizeNoEmDash = (value: string): string =>
  sanitizeBaseNoEmDash(value).replace(/[\u2013\u2014]/gu, '-');

export interface ContractAddendumDocument {
  addendumNumber: string;
  effectiveOn: string;
  changeSummary: string;
  previousPayRate: string | null;
  newPayRate: string | null;
  previousTitle: string | null;
  newTitle: string | null;
  contractNumber: string | null;
  contractEffectiveFrom: string | null;
  legalEntityName: string;
  legalEntityTaxCode: string | null;
  employeeName: string;
  employeeBirthDate: string | null;
  employeeCode: string | null;
  includeSignTags?: boolean;
}

const LEFT = 48;
const RIGHT = 48;
const TOP = A4_HEIGHT - 48;
const BOTTOM = 58;
const CONTENT_WIDTH = A4_WIDTH - LEFT - RIGHT;
const INK: Rgb = [0.09, 0.1, 0.12];
const MUTED: Rgb = [0.38, 0.41, 0.46];
const RULE: Rgb = [0.76, 0.78, 0.82];
const PANEL_FILL: Rgb = [0.97, 0.98, 0.99];
const SIGN_TAG_COLOR: Rgb = [0.97, 0.98, 0.99];

const BODY: TextStyle = { weight: 'regular', size: 10, color: INK };
const BOLD: TextStyle = { weight: 'bold', size: 10, color: INK };
const SUBTLE: TextStyle = { weight: 'regular', size: 9, color: MUTED };
const SECTION: TextStyle = { weight: 'bold', size: 11, color: INK };

const safeSlug = (raw: string, fallback: string): string => {
  const ascii = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .replace(/đ/gu, 'd')
    .replace(/Đ/gu, 'D')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
    .join('-');
  return ascii.length > 0 ? ascii.slice(0, 40) : fallback;
};

export function addendumPdfTitle(displayName: string, addendumNumber: string): string {
  return sanitizeNoEmDash(`Phụ lục HĐLĐ ${addendumNumber} - ${displayName}`);
}

export function addendumPdfFilename(displayName: string, addendumNumber: string): string {
  return `phu-luc-hdld-${safeSlug(displayName, 'nhan-vien')}-${safeSlug(addendumNumber, 'addendum')}.pdf`;
}

class AddendumWriter {
  private readonly pdf: PdfDocument;
  private readonly fonts: FontSet;
  private page;
  private y: number;

  constructor(pdf: PdfDocument, fonts: FontSet) {
    this.pdf = pdf;
    this.fonts = fonts;
    this.page = pdf.addPage();
    this.y = TOP;
  }

  ensureSpace(height: number): void {
    if (this.y - height < BOTTOM) {
      this.page = this.pdf.addPage();
      this.y = TOP;
    }
  }

  centered(text: string, style: TextStyle, lineHeight = style.size + 4): void {
    const cleanText = sanitizeNoEmDash(text);
    const lines = wrapLines(this.fonts, cleanText, style.weight, style.size, CONTENT_WIDTH);
    for (const line of lines) {
      this.ensureSpace(lineHeight);
      const width = this.fonts.measure(line, style.weight, style.size);
      const x = LEFT + Math.max(0, (CONTENT_WIDTH - width) / 2);
      this.page.text(x, this.y, line, style);
      this.y -= lineHeight;
    }
  }

  paragraph(text: string, style: TextStyle = BODY, indent = 0, lineHeight = 14.5): void {
    const cleanText = sanitizeNoEmDash(text);
    const lines = wrapLines(this.fonts, cleanText, style.weight, style.size, CONTENT_WIDTH - indent);
    for (const line of lines) {
      this.ensureSpace(lineHeight);
      this.page.text(LEFT + indent, this.y, line, style);
      this.y -= lineHeight;
    }
  }

  keyValue(label: string, value: string): void {
    const cleanLabel = sanitizeNoEmDash(label);
    const cleanValue = sanitizeNoEmDash(value);
    const labelWidth = this.fonts.measure(cleanLabel + ' ', 'bold', BODY.size);
    if (labelWidth < 190) {
      const valueWidth = CONTENT_WIDTH - labelWidth - 8;
      const lines = wrapLines(this.fonts, cleanValue, 'regular', BODY.size, valueWidth);
      this.ensureSpace(lines.length * 14.5);
      this.page.text(LEFT, this.y, cleanLabel, BOLD);
      lines.forEach((line, idx) => {
        this.page.text(LEFT + labelWidth + 4, this.y - idx * 14.5, line, BODY);
      });
      this.y -= Math.max(1, lines.length) * 14.5;
      return;
    }
    this.paragraph(`${cleanLabel} ${cleanValue}`, BODY, 0);
  }

  gap(points: number): void {
    this.y -= points;
  }

  rule(width = 0.6): void {
    this.ensureSpace(10);
    this.page.line(LEFT, this.y, LEFT + CONTENT_WIDTH, this.y, { width, color: RULE });
    this.y -= 10;
  }

  sectionHeading(text: string): void {
    this.gap(6);
    this.ensureSpace(22);
    this.page.text(LEFT, this.y, sanitizeNoEmDash(text), SECTION);
    this.y -= 16;
  }

  signatureColumns(employerName: string, employeeName: string, includeSignTags: boolean): void {
    this.gap(12);
    this.ensureSpace(156);
    const topY = this.y;
    const colWidth = 225;
    const leftX = LEFT;
    const rightX = LEFT + CONTENT_WIDTH - colWidth;

    const drawHeader = (x: number, title: string, hint: string, name: string, tag: string | null): number => {
      const tWidth = this.fonts.measure(title, 'bold', 10);
      this.page.text(x + Math.max(0, (colWidth - tWidth) / 2), topY, title, BOLD);
      const hWidth = this.fonts.measure(hint, 'regular', 8.5);
      this.page.text(x + Math.max(0, (colWidth - hWidth) / 2), topY - 13, hint, {
        weight: 'regular',
        size: 8.5,
        color: MUTED,
      });

      this.page.rect(x + 12, topY - 88, colWidth - 24, 62, {
        fill: PANEL_FILL,
        stroke: RULE,
        lineWidth: 0.5,
        dash: [3, 3],
      });
      if (tag) {
        const tagW = this.fonts.measure(tag, 'regular', 8);
        this.page.text(x + Math.max(14, (colWidth - tagW) / 2), topY - 62, tag, {
          weight: 'regular',
          size: 8,
          color: SIGN_TAG_COLOR,
        });
      }
      const cleanName = sanitizeNoEmDash(name);
      const nameLines = wrapLines(this.fonts, cleanName, 'bold', 9.5, colWidth - 8).slice(0, 2);
      for (let i = 0; i < nameLines.length; i++) {
        const line = nameLines[i] as string;
        const nameW = this.fonts.measure(line, 'bold', 9.5);
        this.page.text(x + Math.max(0, (colWidth - nameW) / 2), topY - 104 - i * 11, line, {
          weight: 'bold',
          size: 9.5,
          color: INK,
        });
      }
      return nameLines.length;
    };

    const leftLines = drawHeader(
      leftX,
      'ĐẠI DIỆN BÊN A',
      '(Ký, ghi rõ họ tên và đóng dấu)',
      employerName,
      includeSignTags ? '{{signature, r1}}' : null,
    );
    const rightLines = drawHeader(
      rightX,
      'BÊN B (NGƯỜI LAO ĐỘNG)',
      '(Ký, ghi rõ họ tên)',
      employeeName,
      includeSignTags ? '{{signature, r2}}' : null,
    );
    const maxLines = Math.max(leftLines, rightLines, 1);
    this.y = topY - 122 - (maxLines - 1) * 11;
  }
}

export function formatPayDeltaLabel(previousPayRate: string | null, newPayRate: string | null): string | null {
  if (previousPayRate === null && newPayRate === null) return null;
  if (previousPayRate !== null && newPayRate !== null) {
    const diff = money(newPayRate).minus(money(previousPayRate));
    if (diff.isZero()) return `${vnMoney(newPayRate)} đồng/tháng (giữ nguyên)`;
    const sign = diff.isPositive() ? '+' : '-';
    const absStr = vnMoney(diff.abs().toString());
    return `Từ ${vnMoney(previousPayRate)} đồng/tháng thành ${vnMoney(newPayRate)} đồng/tháng (${sign}${absStr} đồng)`;
  }
  if (newPayRate !== null) {
    return `${vnMoney(newPayRate)} đồng/tháng`;
  }
  return `Trước đây ${vnMoney(previousPayRate as string)} đồng/tháng`;
}

export function renderContractAddendumPdf(
  doc: ContractAddendumDocument,
  fonts: FontSet = contractFonts(),
): Uint8Array {
  const pdf = new PdfDocument(fonts, {
    title: addendumPdfTitle(doc.employeeName, doc.addendumNumber),
    author: sanitizeNoEmDash(doc.legalEntityName),
    subject: sanitizeNoEmDash(`Phụ lục hợp đồng lao động số ${doc.addendumNumber}`),
  });
  const w = new AddendumWriter(pdf, fonts);

  w.centered('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', { weight: 'bold', size: 11, color: INK }, 15);
  w.centered('Độc lập - Tự do - Hạnh phúc', { weight: 'bold', size: 10, color: INK }, 14);
  w.gap(2);
  w.rule(0.8);
  w.gap(6);
  w.centered('PHỤ LỤC HỢP ĐỒNG LAO ĐỘNG', { weight: 'bold', size: 14, color: INK }, 18);
  w.centered(`Số: ${sanitizeNoEmDash(doc.addendumNumber)}`, { weight: 'bold', size: 10, color: MUTED }, 15);
  w.gap(8);

  w.paragraph('- Căn cứ Bộ luật Lao động năm 2019 (Điều 33 về sửa đổi, bổ sung hợp đồng lao động);');
  if (doc.contractNumber && doc.contractEffectiveFrom) {
    w.paragraph(
      `- Căn cứ Hợp đồng lao động số ${sanitizeNoEmDash(doc.contractNumber)} có hiệu lực từ ngày ${vnDate(doc.contractEffectiveFrom)};`,
    );
  } else {
    w.paragraph('- Căn cứ Hợp đồng lao động đang có hiệu lực giữa hai bên;');
  }
  w.paragraph(
    `- Căn cứ thỏa thuận của hai bên, áp dụng kể từ ngày ${vnDate(doc.effectiveOn)}, hai bên cùng thống nhất ký kết Phụ lục hợp đồng lao động với các điều khoản sau:`,
  );

  w.sectionHeading('BÊN A: NGƯỜI SỬ DỤNG LAO ĐỘNG');
  w.keyValue('Đơn vị sử dụng lao động:', doc.legalEntityName);
  if (doc.legalEntityTaxCode) {
    w.keyValue('Mã số thuế:', doc.legalEntityTaxCode);
  }

  w.sectionHeading('BÊN B: NGƯỜI LAO ĐỘNG');
  w.keyValue(
    'Họ và tên:',
    doc.employeeCode ? `${doc.employeeName} (Mã NV: ${doc.employeeCode})` : doc.employeeName,
  );
  if (doc.employeeBirthDate) {
    w.keyValue('Ngày sinh:', vnDate(doc.employeeBirthDate));
  }

  w.sectionHeading('ĐIỀU 1. NỘI DUNG SỬA ĐỔI, BỔ SUNG HỢP ĐỒNG LAO ĐỘNG');
  w.keyValue('Ngày hiệu lực điều chỉnh:', vnDate(doc.effectiveOn));

  if (doc.previousTitle !== null || doc.newTitle !== null) {
    const titleLabel = `Từ "${doc.previousTitle ?? 'Theo hợp đồng hiện hành'}" thành "${doc.newTitle ?? 'Giữ nguyên'}"`;
    w.keyValue('Chức danh / vị trí công việc:', titleLabel);
  }

  const payDeltaLabel = formatPayDeltaLabel(doc.previousPayRate, doc.newPayRate);
  if (payDeltaLabel !== null) {
    w.keyValue('Mức lương thỏa thuận:', payDeltaLabel);
  }

  w.gap(4);
  w.paragraph('Nội dung thay đổi chi tiết:', BOLD);
  w.paragraph(doc.changeSummary, BODY, 12);

  w.sectionHeading('ĐIỀU 2. ĐIỀU KHOẢN THI HÀNH');
  const refLabel = doc.contractNumber
    ? `Hợp đồng lao động số ${sanitizeNoEmDash(doc.contractNumber)}`
    : 'Hợp đồng lao động đã ký';
  w.paragraph(
    `1. Phụ lục này là một bộ phận không tách rời của ${refLabel}, có hiệu lực thi hành kể từ ngày ${vnDate(doc.effectiveOn)}.`,
  );
  w.paragraph(
    '2. Các điều khoản khác của Hợp đồng lao động không được sửa đổi, bổ sung tại Phụ lục này vẫn giữ nguyên giá trị pháp lý và tiếp tục có hiệu lực.',
  );
  w.paragraph(
    '3. Phụ lục được lập và xác nhận điện tử (hoặc 02 bản có giá trị pháp lý như nhau), mỗi bên giữ 01 bản làm căn cứ thực hiện.',
    SUBTLE,
  );

  w.signatureColumns(doc.legalEntityName, doc.employeeName, doc.includeSignTags ?? false);

  return pdf.toBytes();
}
