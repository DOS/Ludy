// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic Vietnamese SME starter contract drafter and A4 PDF renderer for Ludy eSign Slice 4f (#3822).
// Generates clean Unicode Vietnamese/bilingual A4 PDFs offline with zero AI required, formats monetary decimal strings
// without floating-point arithmetic, neutralizes `{{` / `}}` in all user and AI inputs, and embeds genuine
// `{{signature, r1}}`, `{{date, r1}}`, `{{signature, r2}}`, `{{date, r2}}` tags in the signature block only.
import { createHash } from 'node:crypto';
import type {
  SignContractClauseItem,
  SignContractCurrency,
  SignContractDraftVariables,
  SignStarterTemplateKind,
} from '@ludy/kernel-contract';
import { signContractFonts, type SignPdfFontSet, type SignPdfFontWeight } from './pdf/fonts.ts';
import {
  SIGN_PDF_A4_HEIGHT,
  SIGN_PDF_A4_WIDTH,
  SignPdfDocument,
  type SignPdfPage,
  type SignPdfRgb,
} from './pdf/writer.ts';

export interface StarterTemplateMeta {
  readonly kind: SignStarterTemplateKind;
  readonly labelVi: string;
  readonly labelEn: string;
  readonly headingVi: string;
  readonly headingEn: string;
  readonly partyARoleVi: string;
  readonly partyBRoleVi: string;
  readonly requiresValue: boolean;
}

export const STARTER_CONTRACT_TEMPLATES: Readonly<Record<SignStarterTemplateKind, StarterTemplateMeta>> = {
  nda_mutual: {
    kind: 'nda_mutual',
    labelVi: 'NDA 2 chiều',
    labelEn: 'Mutual NDA',
    headingVi: 'THỎA THUẬN BẢO MẬT HAI CHIỀU',
    headingEn: 'MUTUAL NON-DISCLOSURE AGREEMENT',
    partyARoleVi: 'BÊN A (Bên tiết lộ / Bên nhận thông tin)',
    partyBRoleVi: 'BÊN B (Bên nhận / Bên tiết lộ thông tin)',
    requiresValue: false,
  },
  service_agreement: {
    kind: 'service_agreement',
    labelVi: 'Hợp đồng dịch vụ',
    labelEn: 'Service Agreement',
    headingVi: 'HỢP ĐỒNG CUNG CẤP DỊCH VỤ',
    headingEn: 'SERVICE AGREEMENT',
    partyARoleVi: 'BÊN A (Bên thuê dịch vụ / Client)',
    partyBRoleVi: 'BÊN B (Bên cung cấp dịch vụ / Provider)',
    requiresValue: true,
  },
  acceptance_minutes: {
    kind: 'acceptance_minutes',
    labelVi: 'Biên bản nghiệm thu',
    labelEn: 'Acceptance Minutes',
    headingVi: 'BIÊN BẢN NGHIỆM THU BÀN GIAO CÔNG VIỆC',
    headingEn: 'WORK ACCEPTANCE MINUTES',
    partyARoleVi: 'BÊN A (Bên nghiệm thu / Client)',
    partyBRoleVi: 'BÊN B (Bên bàn giao / Contractor)',
    requiresValue: true,
  },
  liquidation_minutes: {
    kind: 'liquidation_minutes',
    labelVi: 'Biên bản thanh lý',
    labelEn: 'Liquidation Minutes',
    headingVi: 'BIÊN BẢN THANH LÝ HỢP ĐỒNG',
    headingEn: 'CONTRACT LIQUIDATION MINUTES',
    partyARoleVi: 'BÊN A (Bên giao / Party A)',
    partyBRoleVi: 'BÊN B (Bên nhận / Party B)',
    requiresValue: true,
  },
  freelancer_contract: {
    kind: 'freelancer_contract',
    labelVi: 'Hợp đồng cộng tác viên',
    labelEn: 'Freelancer Contract',
    headingVi: 'HỢP ĐỒNG CỘNG TÁC VIÊN DỊCH VỤ',
    headingEn: 'INDEPENDENT FREELANCER CONTRACT',
    partyARoleVi: 'BÊN A (Doanh nghiệp thuê khoán / Company)',
    partyBRoleVi: 'BÊN B (Cộng tác viên độc lập / Freelancer)',
    requiresValue: true,
  },
};

const FORMAT_CONTROL_RE = /\p{Cf}+/gu;
const DECIMAL_VALUE_RE = /^(0|[1-9]\d{0,17})(?:\.(\d{1,4}))?$/;

export function neutralizeContractInputText(raw: string): string {
  let out = raw
    .replace(FORMAT_CONTROL_RE, '')
    .replace(/(?![\t\n\r])\p{Cc}/gu, ' ')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/([{}])\p{M}+/gu, '$1')
    .trim();
  while (out.includes('{{') || out.includes('}}')) {
    out = out.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
  }
  return out;
}

export function formatContractDecimalAmount(rawDecimal: string, currency: SignContractCurrency): string {
  const cleaned = neutralizeContractInputText(rawDecimal);
  const match = DECIMAL_VALUE_RE.exec(cleaned);
  if (!match) {
    throw new Error('Invalid contract decimal value');
  }
  const whole = match[1]!;
  const fracRaw = (match[2] ?? '').replace(/0+$/, '');
  if (currency === 'USD') {
    const groupedUsd = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return fracRaw.length > 0 ? `${groupedUsd}.${fracRaw} USD` : `${groupedUsd} USD`;
  }
  const groupedVnd = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return fracRaw.length > 0 ? `${groupedVnd},${fracRaw} VND` : `${groupedVnd} VND`;
}

export function buildStarterContractClauses(input: SignContractDraftVariables): Array<{ heading: string; body: string }> {
  const scope = neutralizeContractInputText(input.scopeSummary);
  const effectiveDate = neutralizeContractInputText(input.effectiveDate);
  const expiryDate = input.expiryDate ? neutralizeContractInputText(input.expiryDate) : null;
  const formattedValue = input.contractValue
    ? formatContractDecimalAmount(input.contractValue, input.currency)
    : null;

  const baseClauses: Array<{ heading: string; body: string }> = [];

  switch (input.templateKind) {
    case 'nda_mutual':
      baseClauses.push(
        {
          heading: 'Điều 1. Mục đích và Thông tin mật (Purpose & Confidential Information)',
          body: `Hai bên trao đổi thông tin phục vụ nội dung hợp tác: ${scope}. Mọi tài liệu kỹ thuật, dữ liệu khách hàng, báo giá, mã nguồn và kế hoạch kinh doanh được chia sẻ giữa hai bên đều là Thông tin mật.`,
        },
        {
          heading: 'Điều 2. Nghĩa vụ bảo mật hai chiều (Mutual Confidentiality Obligations)',
          body: 'Mỗi bên cam kết bảo vệ Thông tin mật của bên kia tối thiểu như thông tin mật của chính mình, không tiết lộ cho bên thứ ba nếu không có sự chấp thuận bằng văn bản của bên sở hữu thông tin.',
        },
        {
          heading: 'Điều 3. Thời hạn hiệu lực (Term & Survival)',
          body: expiryDate
            ? `Thỏa thuận có hiệu lực từ ngày ${effectiveDate} đến ngày ${expiryDate}. Nghĩa vụ bảo mật tiếp tục duy trì sau khi kết thúc trao đổi.`
            : `Thỏa thuận có hiệu lực kể từ ngày ${effectiveDate} và nghĩa vụ bảo mật tiếp tục có hiệu lực trong suốt thời gian hợp tác và 24 tháng sau khi chấm dứt.`,
        },
      );
      break;

    case 'service_agreement':
      baseClauses.push(
        {
          heading: 'Điều 1. Phạm vi dịch vụ (Scope of Services)',
          body: `Bên B thực hiện cung cấp dịch vụ cho Bên A theo phạm vi sau: ${scope}.`,
        },
        {
          heading: 'Điều 2. Phí dịch vụ và Thanh toán (Service Fee & Payment)',
          body: formattedValue
            ? `Tổng giá trị hợp đồng (chưa bao gồm thuế GTGT nếu có theo quy định pháp luật): ${formattedValue}. Bên A thanh toán chuyển khoản theo tiến độ nghiệm thu thực tế.`
            : 'Phí dịch vụ và lộ trình thanh toán thực hiện theo phụ lục báo giá được hai bên xác nhận bằng văn bản.',
        },
        {
          heading: 'Điều 3. Thời hạn thực hiện và Nghiệm thu (Term & Acceptance)',
          body: expiryDate
            ? `Hợp đồng có hiệu lực từ ngày ${effectiveDate} đến ngày ${expiryDate}. Hai bên lập biên bản nghiệm thu khi hoàn thành từng hạng mục.`
            : `Hợp đồng có hiệu lực kể từ ngày ${effectiveDate} cho đến khi hai bên hoàn tất nghĩa vụ bàn giao và thanh toán.`,
        },
      );
      break;

    case 'acceptance_minutes':
      baseClauses.push(
        {
          heading: 'Điều 1. Nội dung công việc nghiệm thu (Accepted Deliverables)',
          body: `Hai bên tiến hành kiểm tra, đối chiếu và nghiệm thu kết quả thực hiện công việc: ${scope}.`,
        },
        {
          heading: 'Điều 2. Kết luận nghiệm thu và Giá trị xác nhận (Acceptance Conclusion & Value)',
          body: formattedValue
            ? `Hai bên thống nhất xác nhận công việc đạt yêu cầu chất lượng. Giá trị khối lượng hoàn thành được nghiệm thu là: ${formattedValue}.`
            : 'Hai bên thống nhất xác nhận toàn bộ hạng mục bàn giao đạt yêu cầu theo thỏa thuận.',
        },
        {
          heading: 'Điều 3. Hiệu lực biên bản (Effect of Minutes)',
          body: `Biên bản được lập ngày ${effectiveDate}${expiryDate ? ` (thời hạn bảo hành/hỗ trợ đến ${expiryDate})` : ''} làm căn cứ xuất hóa đơn và thanh toán giữa hai bên.`,
        },
      );
      break;

    case 'liquidation_minutes':
      baseClauses.push(
        {
          heading: 'Điều 1. Xác nhận hoàn thành nghĩa vụ (Confirmation of Performance)',
          body: `Hai bên xác nhận đã thực hiện đầy đủ quyền và nghĩa vụ đối với nội dung hợp tác: ${scope}.`,
        },
        {
          heading: 'Điều 2. Quyết toán tài chính (Financial Settlement)',
          body: formattedValue
            ? `Tổng giá trị quyết toán thanh lý được hai bên đối chiếu thống nhất là: ${formattedValue}. Sau khi hoàn tất thanh toán khoản này, không bên nào còn công nợ tồn đọng.`
            : 'Hai bên xác nhận đã hoàn tất toàn bộ nghĩa vụ đối chiếu và thanh toán, không còn công nợ phát sinh.',
        },
        {
          heading: 'Điều 3. Chấm dứt và Thanh lý hợp đồng (Termination & Release)',
          body: `Hợp đồng chính thức được thanh lý kể từ ngày ${effectiveDate}${expiryDate ? ` (ngày tất toán cuối: ${expiryDate})` : ''}. Các cam kết bảo mật thông tin vẫn giữ nguyên hiệu lực theo thỏa thuận gốc.`,
        },
      );
      break;

    case 'freelancer_contract':
      baseClauses.push(
        {
          heading: 'Điều 1. Nội dung công việc giao khoán (Contracted Deliverables)',
          body: `Bên A giao khoán và Bên B nhận thực hiện độc lập các đầu việc chuyên môn: ${scope}. Hợp đồng này là hợp đồng dịch vụ dân sự độc lập theo Bộ luật Dân sự 2015.`,
        },
        {
          heading: 'Điều 2. Thù lao dịch vụ và Khấu trừ thuế TNCN (Service Fee & PIT Withholding)',
          body: formattedValue
            ? `Tổng thù lao dịch vụ hoàn thành công việc là: ${formattedValue}. Bên A thực hiện khấu trừ thuế thu nhập cá nhân tại nguồn (nếu thuộc diện khấu trừ theo quy định thuế hiện hành) trước khi chuyển khoản cho Bên B.`
            : 'Thù lao được tính theo khối lượng bàn giao được Bên A nghiệm thu và khấu trừ thuế TNCN theo quy định pháp luật hiện hành.',
        },
        {
          heading: 'Điều 3. Thời gian thực hiện và Bảo mật (Timeline & Confidentiality)',
          body: expiryDate
            ? `Thời gian thực hiện từ ngày ${effectiveDate} đến ngày ${expiryDate}. Bên B cam kết bảo mật tài liệu nội bộ và bàn giao quyền sở hữu sản phẩm hoàn thành cho Bên A.`
            : `Hợp đồng bắt đầu từ ngày ${effectiveDate}. Bên B cam kết bảo mật tài liệu nội bộ và bàn giao sản phẩm đúng tiến độ cam kết.`,
        },
      );
      break;
  }

  const custom: Array<{ heading: string; body: string }> = (input.customClauses ?? []).map(
    (clause: SignContractClauseItem, idx: number) => ({
      heading: neutralizeContractInputText(clause.heading) || `Điều bổ sung ${idx + 1}`,
      body: neutralizeContractInputText(clause.body),
    }),
  );

  baseClauses.push(...custom.filter((c) => c.body.length > 0));

  baseClauses.push({
    heading: `Điều ${baseClauses.length + 1}. Điều khoản chung và Chữ ký điện tử (General Provisions & e-Signature)`,
    body: 'Văn bản này được giao kết theo pháp luật Việt Nam (Bộ luật Dân sự 2015 và Luật Giao dịch điện tử 2023). Hai bên đã đọc kỹ toàn văn, thống nhất nội dung và ký xác nhận điện tử dưới đây.',
  });

  return baseClauses;
}

const MARGIN = 44;
const CONTENT_WIDTH = SIGN_PDF_A4_WIDTH - MARGIN * 2;
const PAGE_TOP = SIGN_PDF_A4_HEIGHT - MARGIN;
const PAGE_BOTTOM = MARGIN + 30;
const BODY_SIZE = 9.5;
const BODY_LEADING = 13.5;

const INK: SignPdfRgb = [0.09, 0.1, 0.14];
const MUTED: SignPdfRgb = [0.38, 0.41, 0.47];
const RULE: SignPdfRgb = [0.76, 0.78, 0.83];
const BOX_BG: SignPdfRgb = [0.98, 0.98, 0.99];
const SIGN_TAG_INK: SignPdfRgb = [0.55, 0.58, 0.65];

function wrapText(fonts: SignPdfFontSet, text: string, weight: SignPdfFontWeight, size: number, maxWidth: number): string[] {
  const cleaned = neutralizeContractInputText(text);
  if (!cleaned) return [''];
  const paragraphs = cleaned.split(/\n+/);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of words) {
      if (!current) {
        if (fonts.measure(word, weight, size) <= maxWidth) {
          current = word;
        } else {
          let chunk = '';
          for (const ch of Array.from(word)) {
            if (chunk && fonts.measure(chunk + ch, weight, size) > maxWidth) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          current = chunk;
        }
        continue;
      }
      const candidate = `${current} ${word}`;
      if (fonts.measure(candidate, weight, size) <= maxWidth) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length > 0 ? lines : [''];
}

class StarterPdfCursor {
  readonly doc: SignPdfDocument;
  readonly fonts: SignPdfFontSet;
  page: SignPdfPage;
  y: number;

  constructor(fonts: SignPdfFontSet, title: string, author: string) {
    this.fonts = fonts;
    this.doc = new SignPdfDocument(fonts, { title, author, subject: title });
    this.page = this.doc.addPage();
    this.y = PAGE_TOP;
  }

  ensureSpace(requiredPt: number): void {
    if (this.y - requiredPt < PAGE_BOTTOM) {
      this.page = this.doc.addPage();
      this.y = PAGE_TOP;
    }
  }

  writeParagraph(
    text: string,
    opts: { weight?: SignPdfFontWeight; size?: number; color?: SignPdfRgb; align?: 'left' | 'center'; gapAfter?: number } = {},
  ): void {
    const weight = opts.weight ?? 'regular';
    const size = opts.size ?? BODY_SIZE;
    const color = opts.color ?? INK;
    const leading = Math.max(BODY_LEADING, size * 1.42);
    const wrapped = wrapText(this.fonts, text, weight, size, CONTENT_WIDTH);
    for (const line of wrapped) {
      this.ensureSpace(leading);
      this.y -= size;
      const x =
        opts.align === 'center'
          ? MARGIN + Math.max(0, (CONTENT_WIDTH - this.fonts.measure(line, weight, size)) / 2)
          : MARGIN;
      this.page.text(x, this.y, line, { weight, size, color });
      this.y -= leading - size;
    }
    if (opts.gapAfter) {
      this.y -= opts.gapAfter;
    }
  }
}

export function buildStarterContractTitle(input: SignContractDraftVariables): string {
  const meta = STARTER_CONTRACT_TEMPLATES[input.templateKind];
  const partyBName = neutralizeContractInputText(input.partyB.name);
  return `${meta.labelVi} - ${partyBName}`.slice(0, 280);
}

export function buildStarterContractFilename(input: SignContractDraftVariables): string {
  const slugKind = input.templateKind.replace(/_/g, '-');
  const datePart = neutralizeContractInputText(input.effectiveDate).replace(/[^0-9-]/g, '') || 'draft';
  return `${slugKind}-${datePart}.pdf`;
}

export interface RenderedStarterContractPdf {
  readonly title: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly pageCount: number;
}

export function renderStarterContractPdf(
  input: SignContractDraftVariables,
  fonts: SignPdfFontSet = signContractFonts(),
): RenderedStarterContractPdf {
  const meta = STARTER_CONTRACT_TEMPLATES[input.templateKind];
  const partyAName = neutralizeContractInputText(input.partyA.name);
  const partyBName = neutralizeContractInputText(input.partyB.name);
  const title = buildStarterContractTitle(input);
  const filename = buildStarterContractFilename(input);
  const contractRef = input.contractNumber?.trim()
    ? neutralizeContractInputText(input.contractNumber)
    : `${input.effectiveDate.replace(/-/g, '')}/${input.templateKind.toUpperCase().slice(0, 4)}`;

  const cursor = new StarterPdfCursor(fonts, title, partyAName);

  cursor.writeParagraph('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', { weight: 'bold', size: 10.5, align: 'center' });
  cursor.writeParagraph('Độc lập - Tự do - Hạnh phúc', { weight: 'bold', size: 9.5, align: 'center', gapAfter: 4 });
  cursor.page.line(MARGIN + 170, cursor.y + 2, MARGIN + CONTENT_WIDTH - 170, cursor.y + 2, { color: RULE, width: 0.6 });
  cursor.y -= 10;

  cursor.writeParagraph(meta.headingVi, { weight: 'bold', size: 13.5, align: 'center' });
  cursor.writeParagraph(meta.headingEn, { weight: 'regular', size: 9, color: MUTED, align: 'center', gapAfter: 2 });
  cursor.writeParagraph(`Số / Ref: ${contractRef} | Ngày hiệu lực / Effective: ${neutralizeContractInputText(input.effectiveDate)}`, {
    weight: 'regular',
    size: 8.8,
    color: MUTED,
    align: 'center',
    gapAfter: 10,
  });

  const renderPartySection = (heading: string, party: SignContractDraftVariables['partyA']) => {
    cursor.writeParagraph(heading, { weight: 'bold', size: 10, gapAfter: 2 });
    cursor.writeParagraph(`Tên đơn vị / Cá nhân (Name): ${neutralizeContractInputText(party.name)}`, { weight: 'bold' });
    if (party.taxCode?.trim()) {
      cursor.writeParagraph(`Mã số thuế / CCCD (Tax/ID code): ${neutralizeContractInputText(party.taxCode)}`);
    }
    if (party.address?.trim()) {
      cursor.writeParagraph(`Địa chỉ (Address): ${neutralizeContractInputText(party.address)}`);
    }
    if (party.representative?.trim()) {
      const rep = neutralizeContractInputText(party.representative);
      const role = party.roleTitle?.trim() ? ` - Chức vụ: ${neutralizeContractInputText(party.roleTitle)}` : '';
      cursor.writeParagraph(`Đại diện (Representative): ${rep}${role}`);
    }
    cursor.y -= 6;
  };

  renderPartySection(`I. ${meta.partyARoleVi}`, input.partyA);
  renderPartySection(`II. ${meta.partyBRoleVi}`, input.partyB);

  const clauses = buildStarterContractClauses(input);
  for (const clause of clauses) {
    cursor.ensureSpace(34);
    cursor.writeParagraph(clause.heading, { weight: 'bold', size: 10, gapAfter: 2 });
    cursor.writeParagraph(clause.body, { weight: 'regular', size: BODY_SIZE, gapAfter: 7 });
  }

  // Two-column signature block with genuine {{signature, r1}}, {{date, r1}}, {{signature, r2}}, {{date, r2}} tags.
  const colGap = 24;
  const colWidth = (CONTENT_WIDTH - colGap) / 2;
  const leftX = MARGIN;
  const rightX = MARGIN + colWidth + colGap;

  const repALabel = input.partyA.representative?.trim()
    ? neutralizeContractInputText(input.partyA.representative)
    : partyAName;
  const repBLabel = input.partyB.representative?.trim()
    ? neutralizeContractInputText(input.partyB.representative)
    : partyBName;
  const leftNameLines = wrapText(fonts, repALabel, 'bold', 9, colWidth - 16);
  const rightNameLines = wrapText(fonts, repBLabel, 'bold', 9, colWidth - 16);
  const maxNameRows = Math.max(leftNameLines.length, rightNameLines.length);

  const boxHeight = 76;
  const totalSigBlockHeight = 14 + 13 + 12 + 8 + boxHeight + 16 + maxNameRows * 12 + 10;
  cursor.ensureSpace(totalSigBlockHeight);
  cursor.y -= 10;

  const drawCenteredColLine = (
    colX: number,
    baselineY: number,
    text: string,
    weight: SignPdfFontWeight,
    size: number,
    color: SignPdfRgb = INK,
  ) => {
    const x = colX + Math.max(0, (colWidth - fonts.measure(text, weight, size)) / 2);
    cursor.page.text(x, baselineY, text, { weight, size, color });
  };

  const headY = cursor.y - 10;
  drawCenteredColLine(leftX, headY, 'ĐẠI DIỆN BÊN A / PARTY A', 'bold', 9.5);
  drawCenteredColLine(rightX, headY, 'ĐẠI DIỆN BÊN B / PARTY B', 'bold', 9.5);

  const subY = headY - 12;
  drawCenteredColLine(leftX, subY, '(Ký và ghi rõ họ tên / Sign & date)', 'regular', 8, MUTED);
  drawCenteredColLine(rightX, subY, '(Ký và ghi rõ họ tên / Sign & date)', 'regular', 8, MUTED);

  const boxTop = subY - 8;
  const boxBottom = boxTop - boxHeight;
  cursor.page.rect(leftX + 8, boxBottom, colWidth - 16, boxHeight, {
    fill: BOX_BG,
    stroke: RULE,
    lineWidth: 0.6,
    dash: [3, 2],
  });
  cursor.page.rect(rightX + 8, boxBottom, colWidth - 16, boxHeight, {
    fill: BOX_BG,
    stroke: RULE,
    lineWidth: 0.6,
    dash: [3, 2],
  });

  // Genuine field tags placed strictly here after all user/AI inputs were neutralized.
  cursor.page.text(leftX + 16, boxBottom + 40, '{{signature, r1}}', { weight: 'regular', size: 8, color: SIGN_TAG_INK });
  cursor.page.text(leftX + 16, boxBottom + 14, '{{date, r1}}', { weight: 'regular', size: 8, color: SIGN_TAG_INK });
  cursor.page.text(rightX + 16, boxBottom + 40, '{{signature, r2}}', { weight: 'regular', size: 8, color: SIGN_TAG_INK });
  cursor.page.text(rightX + 16, boxBottom + 14, '{{date, r2}}', { weight: 'regular', size: 8, color: SIGN_TAG_INK });

  const nameStartY = boxBottom - 14;
  leftNameLines.forEach((line, idx) => drawCenteredColLine(leftX, nameStartY - idx * 12, line, 'bold', 9));
  rightNameLines.forEach((line, idx) => drawCenteredColLine(rightX, nameStartY - idx * 12, line, 'bold', 9));

  const totalPages = cursor.doc.pages.length;
  const footerLeft = `${partyAName} - ${meta.labelVi} (${contractRef})`;
  cursor.doc.pages.forEach((p, idx) => {
    p.line(MARGIN, MARGIN + 14, MARGIN + CONTENT_WIDTH, MARGIN + 14, { color: RULE, width: 0.4 });
    const clippedLeft = wrapText(fonts, footerLeft, 'regular', 7.8, CONTENT_WIDTH - 80)[0] ?? '';
    p.text(MARGIN, MARGIN + 2, clippedLeft, { weight: 'regular', size: 7.8, color: MUTED });
    const pageLabel = `Trang ${idx + 1}/${totalPages}`;
    p.text(MARGIN + CONTENT_WIDTH - fonts.measure(pageLabel, 'regular', 7.8), MARGIN + 2, pageLabel, {
      weight: 'regular',
      size: 7.8,
      color: MUTED,
    });
  });

  const bytes = cursor.doc.toBytes();
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  return {
    title,
    filename,
    bytes,
    sha256,
    pageCount: totalPages,
  };
}
