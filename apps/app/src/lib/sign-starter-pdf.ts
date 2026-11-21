// SPDX-License-Identifier: AGPL-3.0-only
// Offline client-side A4 PDF 1.4 fallback and base64 decoder for Ludy eSign starter contracts (#3822).
// Validates decimal amounts strictly through decimal.js (`money()` from @ludy/l10n-vn), neutralizes `{{` / `}}`
// in all user and AI text fields, and embeds genuine `{{signature, r1}}`, `{{date, r1}}`, `{{signature, r2}}`,
// `{{date, r2}}` tags in the two-column signature block only.
import type {
  SignContractCurrency,
  SignContractDraftVariables,
  SignStarterTemplateKind,
} from '@ludy/kernel-contract';
import { Decimal, money } from '@ludy/l10n-vn';

const FORMAT_CONTROL_RE = /\p{Cf}+/gu;

export function neutralizeClientContractText(raw: string): string {
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

export function normalizeStarterDecimalValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,4})?$/.test(trimmed)) {
    return null;
  }
  try {
    const dec = money(trimmed);
    if (!dec.isFinite() || dec.isNegative()) return null;
    return dec.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed();
  } catch {
    return null;
  }
}

export function formatStarterAmountDisplay(decimalStr: string, currency: SignContractCurrency): string {
  const normalized = normalizeStarterDecimalValue(decimalStr);
  if (!normalized) return `${neutralizeClientContractText(decimalStr)} ${currency}`;
  const [whole = '0', fracRaw = ''] = normalized.split('.');
  const frac = fracRaw.replace(/0+$/, '');
  if (currency === 'USD') {
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${grouped}.${frac} USD` : `${grouped} USD`;
  }
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return frac ? `${grouped},${frac} VND` : `${grouped} VND`;
}

export function base64ToPdfBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toPdfAscii(input: string): string {
  let ascii = neutralizeClientContractText(input)
    .replace(/₫/g, 'VND')
    .replace(/Đ/g, 'D')
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\x20-\x7e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  while (ascii.includes('{{') || ascii.includes('}}')) {
    ascii = ascii.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
  }
  return ascii;
}

function escapePdfLiteral(ascii: string): string {
  return ascii.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapAsciiLines(raw: string, maxChars: number): string[] {
  const clean = toPdfAscii(raw);
  if (!clean) return [''];
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    let rem = word;
    while (rem.length > maxChars) {
      if (current) {
        lines.push(current);
        current = '';
      }
      lines.push(rem.slice(0, maxChars));
      rem = rem.slice(maxChars);
    }
    if (!rem) continue;
    if (!current) current = rem;
    else if (current.length + 1 + rem.length <= maxChars) current = `${current} ${rem}`;
    else {
      lines.push(current);
      current = rem;
    }
  }
  if (current) lines.push(current);
  return lines;
}

const HEADINGS: Record<SignStarterTemplateKind, string> = {
  nda_mutual: 'THOA THUAN BAO MAT HAI CHIEU / MUTUAL NDA',
  service_agreement: 'HOP DONG DICH VU / SERVICE AGREEMENT',
  acceptance_minutes: 'BIEN BAN NGHIEM THU / ACCEPTANCE MINUTES',
  liquidation_minutes: 'BIEN BAN THANH LY HOP DONG / LIQUIDATION MINUTES',
  freelancer_contract: 'HOP DONG CONG TAC VIEN / FREELANCER CONTRACT',
};

interface TextDraw {
  x: number;
  y: number;
  size: number;
  bold?: boolean;
  text: string;
}

export function buildOfflineStarterContractPdfBytes(input: SignContractDraftVariables): Uint8Array {
  const pages: TextDraw[][] = [[]];
  let currentPage = pages[0]!;
  let y = 790;
  const bottomY = 62;

  const nextPage = () => {
    currentPage = [];
    pages.push(currentPage);
    y = 790;
  };

  const addLine = (text: string, opts: { x?: number; size?: number; bold?: boolean; gapAfter?: number } = {}) => {
    const x = opts.x ?? 52;
    const size = opts.size ?? 10;
    for (const seg of wrapAsciiLines(text, 84)) {
      if (y < bottomY + size) nextPage();
      currentPage.push({ x, y, size, ...(opts.bold ? { bold: true } : {}), text: seg });
      y -= size + 4;
    }
    if (opts.gapAfter) y -= opts.gapAfter;
  };

  addLine('CONG HOA XA HOI CHU NGHIA VIET NAM', { x: 185, size: 11, bold: true });
  addLine('Doc lap - Tu do - Hanh phuc', { x: 222, size: 10, gapAfter: 10 });
  addLine(HEADINGS[input.templateKind], { x: 135, size: 13, bold: true, gapAfter: 8 });
  addLine(`Ngay hieu luc / Effective date: ${input.effectiveDate}${input.expiryDate ? ` - ${input.expiryDate}` : ''}`, {
    gapAfter: 8,
  });

  addLine('I. BEN A / PARTY A', { size: 11, bold: true });
  addLine(`Ten / Name: ${input.partyA.name}`);
  if (input.partyA.taxCode) addLine(`Ma so thue / Tax ID: ${input.partyA.taxCode}`);
  if (input.partyA.address) addLine(`Dia chi / Address: ${input.partyA.address}`);
  if (input.partyA.representative) addLine(`Dai dien / Representative: ${input.partyA.representative}`);
  y -= 6;

  addLine('II. BEN B / PARTY B', { size: 11, bold: true });
  addLine(`Ten / Name: ${input.partyB.name}`);
  if (input.partyB.taxCode) addLine(`Ma so thue / Tax ID: ${input.partyB.taxCode}`);
  if (input.partyB.address) addLine(`Dia chi / Address: ${input.partyB.address}`);
  if (input.partyB.representative) addLine(`Dai dien / Representative: ${input.partyB.representative}`);
  y -= 6;

  addLine('III. PHAM VI VA GIA TRI / SCOPE & VALUE', { size: 11, bold: true });
  addLine(`Noi dung / Scope: ${input.scopeSummary}`);
  if (input.contractValue) {
    addLine(`Gia tri / Value: ${formatStarterAmountDisplay(input.contractValue, input.currency)}`, { bold: true });
  }
  y -= 6;

  for (const clause of input.customClauses) {
    addLine(clause.heading, { size: 10.5, bold: true });
    addLine(clause.body, { gapAfter: 6 });
  }

  if (y - 120 < bottomY) nextPage();
  const sigTop = y - 12;
  currentPage.push({ x: 72, y: sigTop, size: 10, bold: true, text: 'DAI DIEN BEN A / PARTY A' });
  currentPage.push({ x: 72, y: sigTop - 36, size: 9, text: '{{signature, r1}}' });
  currentPage.push({ x: 72, y: sigTop - 58, size: 9, text: '{{date, r1}}' });
  currentPage.push({ x: 72, y: sigTop - 80, size: 9.5, text: toPdfAscii(input.partyA.name).slice(0, 34) });

  currentPage.push({ x: 335, y: sigTop, size: 10, bold: true, text: 'DAI DIEN BEN B / PARTY B' });
  currentPage.push({ x: 335, y: sigTop - 36, size: 9, text: '{{signature, r2}}' });
  currentPage.push({ x: 335, y: sigTop - 58, size: 9, text: '{{date, r2}}' });
  currentPage.push({ x: 335, y: sigTop - 80, size: 9.5, text: toPdfAscii(input.partyB.name).slice(0, 34) });

  const pageCount = pages.length;
  const pageObjNums = pages.map((_, idx) => 5 + idx * 2);
  const objects: Array<{ id: number; body: string }> = [
    { id: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { id: 2, body: `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageCount} >>` },
    { id: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    { id: 4, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>' },
  ];

  pages.forEach((draws, idx) => {
    const pageId = 5 + idx * 2;
    const contentId = pageId + 1;
    const stream = draws
      .map((d) => `BT /${d.bold ? 'F2' : 'F1'} ${d.size} Tf 1 0 0 1 ${d.x} ${d.y} Tm (${escapePdfLiteral(d.text)}) Tj ET`)
      .join('\n');
    objects.push({
      id: pageId,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
    });
    objects.push({ id: contentId, body: `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream` });
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets[obj.id] = pdf.length;
    pdf += `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  const size = objects.length + 1;
  pdf += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id += 1) {
    pdf += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
