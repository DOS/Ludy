// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic client-side A4 Meeting Minutes PDF 1.4 builder for Ludy Notes -> Ludy eSign handoff (#3811, Slice 3a).
// Produces a clean multi-page A4 PDF from SHARED meeting minutes only using built-in Type1 Helvetica (WinAnsi)
// with zero external parser or PDF libraries. Embeds deterministic {{signature, r1}}..{{signature, rN}} tags
// so crove-extract detects signature boxes automatically with 100% AI-off parity.
import { SIGN_MAX_TAG_ROLES } from '@ludy/kernel-contract';
import { toPdfAsciiText } from './hr-contract-pdf.ts';
import { vnMoment } from './minutes.ts';

export interface MeetingMinutesPdfSection {
  title?: string | null;
  text: string;
}

export interface MeetingMinutesPdfAction {
  title: string;
  owner?: string | null;
  due?: string | null;
}

export interface MeetingMinutesPdfSigner {
  name: string;
  roleLabel: string;
}

export interface MeetingMinutesPdfInput {
  companyName: string;
  title: string;
  startedAt?: string | null;
  createdAt: string;
  endedAt?: string | null;
  place?: string | null;
  recorderName: string;
  attendees: readonly string[];
  sections: readonly MeetingMinutesPdfSection[];
  conclusions: readonly string[];
  actions: readonly MeetingMinutesPdfAction[];
  signers?: readonly MeetingMinutesPdfSigner[];
}

function escapePdfLiteral(ascii: string): string {
  return ascii.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function neutralizePdfTags(text: string): string {
  return text.replace(/\{\{/g, '{ {').replace(/\}\}/g, '} }');
}

function wrapAsciiSegment(raw: string, maxChars: number): string[] {
  const clean = toPdfAsciiText(neutralizePdfTags(raw));
  if (!clean) return [];
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

function wrapMultilineText(raw: string, maxChars: number): string[] {
  const rawLines = raw.split(/\r?\n/);
  const out: string[] = [];
  for (const line of rawLines) {
    const wrapped = wrapAsciiSegment(line, maxChars);
    if (wrapped.length > 0) {
      out.push(...wrapped);
    }
  }
  return out;
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
const LEFT_SIG_X = 68;
const RIGHT_SIG_X = 328;

export function buildMeetingMinutesFilename(meetingDateIso: string, meetingId: string): string {
  const moment = vnMoment(meetingDateIso);
  const safeDate = `${moment.year}-${moment.month}-${moment.day}`;
  const suffix = meetingId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'mtg';
  return `bien-ban-cuoc-hop-${safeDate}-${suffix}.pdf`;
}

export function buildMeetingMinutesPdfBytes(input: MeetingMinutesPdfInput): Uint8Array {
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
    const wrapped = wrapMultilineText(text, maxChars);
    const segments = wrapped.length > 0 ? wrapped : [''];
    for (const segment of segments) {
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

  const companyHeader = toPdfAsciiText(neutralizePdfTags(input.companyName || 'TO CHUC / WORKSPACE')).toUpperCase();
  addLine(companyHeader, { size: 10.5, bold: true, gapAfter: 8 });
  addLine('BIEN BAN CUOC HOP / MEETING MINUTES', { x: 162, size: 14, bold: true, gapAfter: 4 });
  addLine(`V/v: ${input.title || 'Cuoc hop'}`, { size: 11, bold: true, gapAfter: 10 });

  const from = vnMoment(input.startedAt ?? input.createdAt);
  const to = input.endedAt ? vnMoment(input.endedAt) : null;
  const timeText = to
    ? `Tu ${from.time} den ${to.time}, ngay ${from.day}/${from.month}/${from.year}`
    : `Tu ${from.time}, ngay ${from.day}/${from.month}/${from.year}`;
  addLine(`Thoi gian / Time: ${timeText}`);

  const placeText = input.place?.trim() ? input.place.trim() : '........................';
  addLine(`Dia diem / Place: ${placeText}`, { gapAfter: 4 });

  addLine('Thanh phan tham du / Attendees:', { bold: true });
  const uniqueAttendees = input.attendees.length > 0 ? input.attendees : [input.recorderName || 'Nguoi ghi bien ban'];
  uniqueAttendees.forEach((attendee, index) => {
    const suffix = index === 0 ? ' (Nguoi ghi bien ban / Minute taker)' : '';
    addLine(`- ${attendee}${suffix}`, { x: 64, maxChars: 80 });
  });
  y -= 6;

  addLine('I. NOI DUNG CUOC HOP (MEETING SUMMARY)', { size: 11, bold: true, gapAfter: 2 });
  if (input.sections.length === 0) {
    addLine('Chua co noi dung tom tat duoc chia se.');
  } else {
    input.sections.forEach((section, index) => {
      if (section.title && section.title.trim() !== '') {
        addLine(`${index + 1}. ${section.title.trim()}`, { bold: true });
      }
      addLine(section.text, { gapAfter: 4 });
    });
  }
  y -= 4;

  addLine('II. KET LUAN VA QUYET DINH (CONCLUSIONS & DECISIONS)', { size: 11, bold: true, gapAfter: 2 });
  if (input.conclusions.length === 0) {
    addLine('Chua co ket luan duoc ghi.');
  } else {
    for (const conclusion of input.conclusions) {
      addLine(`- ${conclusion}`, { x: 64, maxChars: 80 });
    }
  }
  y -= 6;

  addLine('III. CONG VIEC CAN THUC HIEN (ACTION ITEMS)', { size: 11, bold: true, gapAfter: 2 });
  if (input.actions.length === 0) {
    addLine('Khong co cong viec nao duoc giao.');
  } else {
    input.actions.forEach((action, index) => {
      const ownerPart = action.owner?.trim() ? action.owner.trim() : '........';
      const duePart = action.due?.trim() ? action.due.trim() : '........';
      addLine(`${index + 1}. ${action.title} [Phu trach: ${ownerPart} | Han: ${duePart}]`, {
        x: 64,
        maxChars: 80,
      });
    });
  }
  y -= 10;

  const effectiveSigners: MeetingMinutesPdfSigner[] =
    input.signers && input.signers.length > 0
      ? input.signers.slice(0, SIGN_MAX_TAG_ROLES)
      : [
          { name: input.recorderName || 'Nguoi ghi bien ban', roleLabel: 'NGUOI GHI BIEN BAN' },
          { name: '', roleLabel: 'CHU TRI CUOC HOP' },
        ];

  for (let i = 0; i < effectiveSigners.length; i += 2) {
    const left = effectiveSigners[i]!;
    const right = effectiveSigners[i + 1] ?? null;
    const leftNameLines = left.name.trim() ? wrapAsciiSegment(left.name, SIGNATURE_COLUMN_MAX_CHARS) : [''];
    const rightNameLines = right && right.name.trim() ? wrapAsciiSegment(right.name, SIGNATURE_COLUMN_MAX_CHARS) : [''];
    const leftRoleLines = wrapAsciiSegment(left.roleLabel.toUpperCase(), SIGNATURE_COLUMN_MAX_CHARS);
    const rightRoleLines = right ? wrapAsciiSegment(right.roleLabel.toUpperCase(), SIGNATURE_COLUMN_MAX_CHARS) : [];
    const maxRoleLines = Math.max(leftRoleLines.length, rightRoleLines.length, 1);
    const maxNameLines = Math.max(leftNameLines.length, rightNameLines.length, 1);
    const rowHeight = maxRoleLines * 13 + 74 + maxNameLines * 13;

    if (y - 6 - rowHeight < PAGE_BOTTOM_Y) {
      startNewPage();
    }
    const rowTopY = y - 6;

    const renderSigColumn = (colX: number, signer: MeetingMinutesPdfSigner, roleIndex: number, roleLines: string[], nameLines: string[]) => {
      const safeRoleLines = roleLines.length > 0 ? roleLines : ['NGUOI KY'];
      safeRoleLines.forEach((line, idx) => {
        currentPage.push({ x: colX, y: rowTopY - idx * 13, size: 10, bold: true, text: line });
      });
      const hintY = rowTopY - maxRoleLines * 13 - 2;
      currentPage.push({ x: colX, y: hintY, size: 8.5, text: '(Ky, ghi ro ho ten / Sign below)' });
      currentPage.push({ x: colX, y: hintY - 42, size: 9, text: `{{signature, r${roleIndex + 1}}}` });
      nameLines.forEach((line, idx) => {
        if (!line) return;
        currentPage.push({ x: colX, y: hintY - 66 - idx * 13, size: 9.5, text: line });
      });
    };

    renderSigColumn(LEFT_SIG_X, left, i, leftRoleLines, leftNameLines);
    if (right) {
      renderSigColumn(RIGHT_SIG_X, right, i + 1, rightRoleLines, rightNameLines);
    }

    y = rowTopY - rowHeight - 10;
  }

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
