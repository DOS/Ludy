// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic client-side Project Acceptance Minutes PDF 1.4 builder and ADR-0050 Finance search helpers
// for Ludy Du an -> Ludy eSign -> Ludy Ke toan handoff (#3812, docs/plan/esign.md Slice 3b).
// Produces a clean A4 PDF (automatically paginating across pages and before the Party A / Party B signature block)
// using built-in Type1 Helvetica (WinAnsi) with zero external parser/PDF libraries, plus deterministic
// {{signature, r1}} / {{date, r1}} / {{signature, r2}} tags for crove-extract pdf_inspect & pdf_seal.

export interface ProjectAcceptancePdfInput {
  projectName: string;
  providerName: string;
  recipientName: string;
  recipientEmail?: string | null;
  acceptanceDate: string;
  deliverables: readonly string[];
  note?: string | null;
}

export interface SalesInvoiceHandoffSearch {
  description?: string;
  reference?: string;
}

export const ACCEPTANCE_SEARCH_DESCRIPTION_MAX = 300;
export const ACCEPTANCE_SEARCH_REFERENCE_MAX = 120;

function stripUnsafeSearchChars(raw: string): string {
  let wellFormed = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < raw.length ? raw.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        wellFormed += raw.slice(i, i + 2);
        i += 1;
      }
    } else if (code < 0xdc00 || code > 0xdfff) {
      wellFormed += raw[i];
    }
  }
  let cleaned = '';
  for (const ch of wellFormed.normalize('NFC')) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) {
      cleaned += ' ';
      continue;
    }
    cleaned += ch;
  }
  return cleaned
    .replace(/\p{Cf}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sliceCodePoints(value: string, maxPoints: number): string {
  if (value.length <= maxPoints) return value;
  const points = Array.from(value);
  return points.length <= maxPoints ? value : points.slice(0, maxPoints).join('').trimEnd();
}

/** Validates URL search parameters arriving on /o/$slug/sales-invoices from an ADR-0050 browser handoff. */
export function parseSalesInvoiceHandoffSearch(search: Record<string, unknown>): SalesInvoiceHandoffSearch {
  const rawDescription = typeof search.description === 'string' ? stripUnsafeSearchChars(search.description) : '';
  const rawReference = typeof search.reference === 'string' ? stripUnsafeSearchChars(search.reference) : '';
  const description = rawDescription ? sliceCodePoints(rawDescription, ACCEPTANCE_SEARCH_DESCRIPTION_MAX) : undefined;
  const reference = rawReference ? sliceCodePoints(rawReference, ACCEPTANCE_SEARCH_REFERENCE_MAX) : undefined;
  return {
    ...(description ? { description } : {}),
    ...(reference ? { reference } : {}),
  };
}

/** Builds safe browser-carried URL search parameters linking a sealed acceptance envelope to Ludy Ke toan. */
export function buildSalesInvoiceAcceptanceSearch(input: {
  projectName: string;
  certificateCode?: string | null;
  envelopeId: string;
}): { description: string; reference: string } {
  const cleanCert = input.certificateCode ? stripUnsafeSearchChars(input.certificateCode) : '';
  const fallbackRef = stripUnsafeSearchChars(input.envelopeId).slice(0, 8) || 'esign';
  const reference = sliceCodePoints(cleanCert || fallbackRef, ACCEPTANCE_SEARCH_REFERENCE_MAX);
  const cleanProject = sliceCodePoints(stripUnsafeSearchChars(input.projectName) || 'Du an', 200);
  const description = sliceCodePoints(
    `Nghiệm thu bàn giao dự án: ${cleanProject}`,
    ACCEPTANCE_SEARCH_DESCRIPTION_MAX,
  );
  return { description, reference };
}

/** Composes the initial line 1 description for a prefilled sales e-invoice draft without persisting or issuing. */
export function formatSalesInvoicePrefillDescription(prefill: SalesInvoiceHandoffSearch): string {
  const desc = prefill.description?.trim() ?? '';
  const ref = prefill.reference?.trim() ?? '';
  if (desc && ref) {
    return desc.includes(ref) ? sliceCodePoints(desc, 500) : sliceCodePoints(`${desc} (${ref})`, 500);
  }
  return sliceCodePoints(desc || ref, 500);
}

export function buildProjectAcceptanceFilename(acceptanceDate: string, projectId: string): string {
  const safeDate = acceptanceDate.replace(/[^0-9-]/g, '') || 'acceptance';
  const suffix = projectId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'proj';
  return `bien-ban-nghiem-thu-${safeDate}-${suffix}.pdf`;
}

export function toAcceptancePdfAsciiText(input: string): string {
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

export function sanitizeAcceptancePdfUserText(raw: string, fallback = ''): string {
  const deTagged = raw.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
  const ascii = toAcceptancePdfAsciiText(deTagged);
  if (ascii) return ascii;
  const trimmed = stripUnsafeSearchChars(deTagged);
  if (!trimmed) return fallback;
  const codePointFallback = Array.from(trimmed)
    .slice(0, 32)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp >= 0x20 && cp <= 0x7e ? ch : `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    })
    .join(' ')
    .trim();
  return codePointFallback || fallback;
}

function escapePdfLiteral(ascii: string): string {
  return ascii.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapTextLines(raw: string, maxChars: number): string[] {
  const clean = toAcceptancePdfAsciiText(raw);
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

export function buildProjectAcceptancePdfBytes(input: ProjectAcceptancePdfInput): Uint8Array {
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
  addLine('BIEN BAN NGHIEM THU VA BAN GIAO DU AN', { x: 145, size: 13.5, bold: true });
  addLine('PROJECT ACCEPTANCE & HANDOVER MINUTES', { x: 158, size: 10.5, bold: true, gapAfter: 10 });

  const safeDate = sanitizeAcceptancePdfUserText(input.acceptanceDate, 'N/A');
  const safeProject = sanitizeAcceptancePdfUserText(input.projectName, 'Project');
  const safeProvider = sanitizeAcceptancePdfUserText(input.providerName, 'Provider');
  const safeRecipient = sanitizeAcceptancePdfUserText(input.recipientName, 'Client');
  const safeEmail = input.recipientEmail?.trim()
    ? sanitizeAcceptancePdfUserText(input.recipientEmail.trim())
    : '';

  addLine(`Ngay lap / Acceptance date: ${safeDate}`, { gapAfter: 6 });

  addLine('1. THONG TIN DU AN VA CAC BEN (PROJECT & PARTIES)', { size: 11, bold: true, gapAfter: 2 });
  addLine(`Du an / Project: ${safeProject}`, { bold: true });
  addLine(`Ben giao (Ben A - Provider): ${safeProvider}`);
  addLine(`Ben nhan (Ben B - Client): ${safeRecipient}`);
  if (safeEmail) {
    addLine(`Email lien he Ben B / Client email: ${safeEmail}`);
  }
  y -= 6;

  addLine('2. HANG MUC BAN GIAO VA NGHIEM THU (DELIVERABLES)', { size: 11, bold: true, gapAfter: 4 });
  const cleanDeliverables = input.deliverables
    .map((item) => sanitizeAcceptancePdfUserText(item.trim()))
    .filter((item) => item.length > 0);
  if (cleanDeliverables.length === 0) {
    addLine('1. Hoan thanh va ban giao cac hang muc theo thoa thuan du an.');
  } else {
    cleanDeliverables.forEach((item, idx) => {
      addLine(`${idx + 1}. ${item}`, { x: 58, maxChars: 80, gapAfter: 2 });
    });
  }

  const safeNote = input.note?.trim() ? sanitizeAcceptancePdfUserText(input.note.trim()) : '';
  if (safeNote) {
    y -= 4;
    addLine('3. GHI CHU NGHIEM THU (ACCEPTANCE NOTES)', { size: 11, bold: true, gapAfter: 2 });
    addLine(safeNote, { maxChars: 82 });
  }

  y -= 8;
  addLine(
    'Hai ben xac nhan cac hang muc tren da hoan thanh dung yeu cau va dong y nghiem thu ban giao.',
    { size: 9.5, gapAfter: 16 },
  );

  const clientSigLines = wrapTextLines(safeRecipient, SIGNATURE_COLUMN_MAX_CHARS);
  const providerSigLines = wrapTextLines(safeProvider, SIGNATURE_COLUMN_MAX_CHARS);
  const maxCaptionLines = Math.max(clientSigLines.length, providerSigLines.length);
  const requiredSigHeight = 110 + maxCaptionLines * 13;

  // Break onto a fresh page whenever remaining space cannot hold the full signature block cleanly.
  if (y - 10 - requiredSigHeight < PAGE_BOTTOM_Y) {
    startNewPage();
  }
  const sigTopY = y - 10;

  currentPage.push({ x: 72, y: sigTopY, size: 10.5, bold: true, text: 'DAI DIEN BEN B (CLIENT)' });
  currentPage.push({ x: 72, y: sigTopY - 14, size: 9, text: '(Ky xac nhan nghiem thu / Sign below)' });
  currentPage.push({ x: 72, y: sigTopY - 52, size: 9, text: '{{signature, r1}}' });
  currentPage.push({ x: 72, y: sigTopY - 82, size: 8.5, text: '{{date, r1}}' });
  clientSigLines.forEach((line, idx) => {
    currentPage.push({ x: 72, y: sigTopY - 104 - idx * 13, size: 9.5, text: line });
  });

  currentPage.push({ x: 335, y: sigTopY, size: 10.5, bold: true, text: 'DAI DIEN BEN A (PROVIDER)' });
  currentPage.push({ x: 335, y: sigTopY - 14, size: 9, text: '(Dai dien don vi ban giao / Authorized)' });
  currentPage.push({ x: 335, y: sigTopY - 52, size: 9, text: '{{signature, r2}}' });
  providerSigLines.forEach((line, idx) => {
    currentPage.push({ x: 335, y: sigTopY - 104 - idx * 13, size: 9.5, text: line });
  });

  const encoder = new TextEncoder();
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
