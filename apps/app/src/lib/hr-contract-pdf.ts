// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic client-side Labor Contract PDF 1.4 builder for Ludy Nhan su -> Ludy eSign handoff (#3553).
// Produces a clean A4 PDF (automatically paginating before the signature block when fields are long) using built-in
// Type1 Helvetica (WinAnsi) with zero external parser/PDF libraries. Monetary amounts stay string-based.
import type { HrContractForm, HrContractType, HrProbationRoleTier, HrRegion } from '@ludy/kernel-contract';

export interface HrContractPdfInput {
  employerName: string;
  employerTaxCode?: string | null;
  employerAddress?: string | null;
  employeeName: string;
  employeeDepartment?: string | null;
  employeeJobTitle?: string | null;
  employeeAddress?: string | null;
  employeeBirthDate?: string | null;
  effectiveFrom: string;
  contractType: HrContractType;
  contractForm?: HrContractForm | null;
  termMonths?: number | null;
  contractEndOn?: string | null;
  fixedTermSequence?: number | null;
  region: HrRegion;
  baseWage: string;
  probationRoleTier?: HrProbationRoleTier | null;
  probationEndOn?: string | null;
  probationWage?: string | null;
}

const DECIMAL_STR_RE = /^(-?)(\d+)(?:\.(\d+))?$/;

export function formatVndAmountForPdf(raw: string): string {
  const trimmed = raw.trim();
  const match = DECIMAL_STR_RE.exec(trimmed);
  if (!match) return `${toPdfAsciiText(trimmed)} VND`;
  const [, sign = '', wholeRaw = '0', fracRaw = ''] = match;
  const wholeClean = wholeRaw.replace(/^0+(?=\d)/, '');
  const grouped = wholeClean.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const trimmedFrac = fracRaw.replace(/0+$/, '');
  return trimmedFrac.length > 0 ? `${sign}${grouped},${trimmedFrac} VND` : `${sign}${grouped} VND`;
}

export function toPdfAsciiText(input: string): string {
  return input
    .replace(/₫/g, 'VND')
    .replace(/Đ/g, 'D')
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapePdfLiteral(ascii: string): string {
  return ascii.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapTextLines(raw: string, maxChars: number): string[] {
  const clean = toPdfAsciiText(raw);
  if (!clean) return [''];
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    let remaining = word;
    while (remaining.length > maxChars) {
      if (current) {
        lines.push(current);
        current = '';
      }
      lines.push(remaining.slice(0, maxChars));
      remaining = remaining.slice(maxChars);
    }
    if (!remaining) continue;
    if (!current) {
      current = remaining;
    } else if (current.length + 1 + remaining.length <= maxChars) {
      current = `${current} ${remaining}`;
    } else {
      lines.push(current);
      current = remaining;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function contractTypeLabel(contractType: HrContractType): string {
  switch (contractType) {
    case 'indefinite':
      return 'Hop dong lao dong khong xac dinh thoi han (Indefinite-term labor contract)';
    case 'fixed_term':
      return 'Hop dong lao dong xac dinh thoi han (Fixed-term labor contract)';
    case 'none':
      return 'Thoa thuan lao dong duoi 1 thang (Under-one-month labor agreement)';
  }
}

function contractFormLabel(form: HrContractForm | null | undefined): string {
  switch (form) {
    case 'electronic':
      return 'Dien tu (Electronic labor contract - Labor Code 2019 Art. 14)';
    case 'oral':
      return 'Loi noi (Oral agreement)';
    case 'written':
    default:
      return 'Van ban / Dien tu (Written / Electronic)';
  }
}

function probationTierLabel(tier: HrProbationRoleTier | null | undefined): string | null {
  switch (tier) {
    case 'enterprise_manager':
      return 'Quan ly doanh nghiep (Enterprise manager)';
    case 'college_or_above':
      return 'Trinh do cao dang tro len (College or above)';
    case 'intermediate_technical':
      return 'Trung cap / ky thuat (Intermediate / technical)';
    case 'other':
      return 'Cong viec khac (Other work)';
    default:
      return null;
  }
}

interface PdfTextDraw {
  x: number;
  y: number;
  size: number;
  bold?: boolean;
  text: string;
}

const PAGE_TOP_Y = 790;
const PAGE_BOTTOM_Y = 62;
const SIGNATURE_COLUMN_MAX_CHARS = 36;

export function buildHrContractPdfBytes(input: HrContractPdfInput): Uint8Array {
  const pages: PdfTextDraw[][] = [[]];
  let currentPage = pages[0]!;
  let y = PAGE_TOP_Y;

  const startNewPage = () => {
    currentPage = [];
    pages.push(currentPage);
    y = PAGE_TOP_Y;
  };

  const addLine = (
    text: string,
    opts: { x?: number; size?: number; bold?: boolean; gapAfter?: number; maxChars?: number } = {},
  ) => {
    const x = opts.x ?? 52;
    const size = opts.size ?? 10;
    const maxChars = opts.maxChars ?? 84;
    const wrapped = wrapTextLines(text, maxChars);
    for (const segment of wrapped) {
      if (y < PAGE_BOTTOM_Y + size) {
        startNewPage();
      }
      currentPage.push({ x, y, size, ...(opts.bold ? { bold: true } : {}), text: segment });
      y -= size + 4;
    }
    if (opts.gapAfter) {
      y -= opts.gapAfter;
    }
  };

  addLine('CONG HOA XA HOI CHU NGHIA VIET NAM', { x: 185, size: 11, bold: true });
  addLine('Doc lap - Tu do - Hanh phuc', { x: 222, size: 10, gapAfter: 12 });
  addLine('HOP DONG LAO DONG / LABOR CONTRACT', { x: 165, size: 14, bold: true, gapAfter: 10 });

  addLine('1. NGUOI SU DUNG LAO DONG (EMPLOYER)', { size: 11, bold: true, gapAfter: 2 });
  addLine(`Don vi / Employer: ${input.employerName || 'To chuc su dung lao dong'}`);
  if (input.employerTaxCode) {
    addLine(`Ma so thue / Tax code: ${input.employerTaxCode}`);
  }
  if (input.employerAddress) {
    addLine(`Dia chi / Address: ${input.employerAddress}`);
  }
  y -= 6;

  addLine('2. NGUOI LAO DONG (EMPLOYEE)', { size: 11, bold: true, gapAfter: 2 });
  addLine(`Ho va ten / Full name: ${input.employeeName}`);
  if (input.employeeBirthDate) {
    addLine(`Ngay sinh / Date of birth: ${input.employeeBirthDate}`);
  }
  if (input.employeeDepartment || input.employeeJobTitle) {
    const roleParts = [input.employeeDepartment, input.employeeJobTitle].filter(Boolean).join(' - ');
    addLine(`Phong ban - Chuc danh / Department & Title: ${roleParts}`);
  }
  if (input.employeeAddress) {
    addLine(`Dia chi / Address: ${input.employeeAddress}`);
  }
  y -= 6;

  addLine('3. DIEU KHOAN HOP DONG VA TIEN LUONG (TERMS & COMPENSATION)', { size: 11, bold: true, gapAfter: 2 });
  addLine(`Loai hop dong / Contract type: ${contractTypeLabel(input.contractType)}`);
  addLine(`Hinh thuc / Form: ${contractFormLabel(input.contractForm)}`);
  addLine(`Ngay co hieu luc / Effective from: ${input.effectiveFrom}`);
  if (input.termMonths !== null && input.termMonths !== undefined) {
    addLine(`Thoi han / Term duration: ${input.termMonths} thang (months)`);
  }
  if (input.contractEndOn) {
    addLine(`Ngay ket thuc / End date: ${input.contractEndOn}`);
  }
  if (input.fixedTermSequence !== null && input.fixedTermSequence !== undefined) {
    addLine(`Lan giao ket xac dinh thoi han / Fixed-term sequence: Lan ${input.fixedTermSequence}`);
  }
  addLine(`Vung luong toi thieu / Statutory wage region: Vung ${input.region}`);
  addLine(`Muc luong co ban / Base monthly wage: ${formatVndAmountForPdf(input.baseWage)}`, { bold: true });

  const tier = probationTierLabel(input.probationRoleTier);
  if (tier || input.probationEndOn || input.probationWage) {
    y -= 6;
    addLine('4. DIEU KHOAN THU VIEC (PROBATION TERMS)', { size: 11, bold: true, gapAfter: 2 });
    if (tier) addLine(`Nhom vi tri / Probation tier: ${tier}`);
    if (input.probationEndOn) addLine(`Ket thuc thu viec / Probation end date: ${input.probationEndOn}`);
    if (input.probationWage) {
      addLine(`Luong thu viec / Probation monthly wage: ${formatVndAmountForPdf(input.probationWage)}`);
    }
  }

  y -= 8;
  addLine(
    'Hai ben cam ket thuc hien dung cac dieu khoan ghi trong hop dong nay va quy dinh cua Bo luat Lao dong 2019.',
    { size: 9.5, gapAfter: 16 },
  );

  const employeeSigLines = wrapTextLines(input.employeeName, SIGNATURE_COLUMN_MAX_CHARS);
  const employerSigLines = wrapTextLines(input.employerName || 'Employer', SIGNATURE_COLUMN_MAX_CHARS);
  const maxCaptionLines = Math.max(employeeSigLines.length, employerSigLines.length);
  const requiredSigHeight = 82 + maxCaptionLines * 13;

  // Never clamp upward into existing contract lines: break onto a new page when remaining space cannot fit signatures.
  if (y - 10 - requiredSigHeight < PAGE_BOTTOM_Y) {
    startNewPage();
  }
  const sigTopY = y - 10;

  currentPage.push({ x: 72, y: sigTopY, size: 10.5, bold: true, text: 'NGUOI LAO DONG / EMPLOYEE' });
  currentPage.push({ x: 72, y: sigTopY - 14, size: 9, text: '(Ky va ghi ro ho ten / Sign below)' });
  currentPage.push({ x: 72, y: sigTopY - 56, size: 9, text: '{{signature, r1}}' });
  employeeSigLines.forEach((line, idx) => {
    currentPage.push({ x: 72, y: sigTopY - 82 - idx * 13, size: 9.5, text: line });
  });

  currentPage.push({ x: 335, y: sigTopY, size: 10.5, bold: true, text: 'NGUOI SU DUNG LAO DONG / EMPLOYER' });
  currentPage.push({ x: 335, y: sigTopY - 14, size: 9, text: '(Dai dien theo phap luat / Authorized)' });
  employerSigLines.forEach((line, idx) => {
    currentPage.push({ x: 335, y: sigTopY - 82 - idx * 13, size: 9.5, text: line });
  });

  const encoder = new TextEncoder();
  // Object numbering:
  // 1 = Catalog, 2 = Pages, 3 = Font /F1, 4 = Font /F2,
  // and for page index i (0-based): pageObjId = 5 + i * 2, streamObjId = 6 + i * 2.
  const pageObjIds = pages.map((_, idx) => 5 + idx * 2);
  const objects: string[] = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`,
    '3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n',
  ];

  pages.forEach((pageDraws, idx) => {
    const pageObjId = 5 + idx * 2;
    const streamObjId = pageObjId + 1;
    const streamLines: string[] = ['BT'];
    for (const item of pageDraws) {
      const font = item.bold ? '/F2' : '/F1';
      streamLines.push(`${font} ${item.size.toFixed(2)} Tf`);
      streamLines.push(`1 0 0 1 ${item.x.toFixed(2)} ${item.y.toFixed(2)} Tm`);
      streamLines.push(`(${escapePdfLiteral(item.text)}) Tj`);
    }
    streamLines.push('ET');
    const streamContent = `${streamLines.join('\n')}\n`;
    const streamByteLen = encoder.encode(streamContent).byteLength;

    objects.push(
      `${pageObjId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamObjId} 0 R >>\nendobj\n`,
    );
    objects.push(`${streamObjId} 0 obj\n<< /Length ${streamByteLen} >>\nstream\n${streamContent}endstream\nendobj\n`);
  });

  const chunks: Uint8Array[] = [];
  let offset = 0;
  const pushText = (str: string) => {
    const bytes = encoder.encode(str);
    chunks.push(bytes);
    offset += bytes.byteLength;
  };

  pushText('%PDF-1.4\n');
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(offset);
    pushText(obj);
  }

  const xrefOffset = offset;
  const xrefLines: string[] = [`xref\n0 ${objects.length + 1}`, '0000000000 65535 f '];
  for (let i = 1; i <= objects.length; i += 1) {
    const pos = String(offsets[i] ?? 0).padStart(10, '0');
    xrefLines.push(`${pos} 00000 n `);
  }
  pushText(`${xrefLines.join('\n')}\n`);
  pushText(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return out;
}
