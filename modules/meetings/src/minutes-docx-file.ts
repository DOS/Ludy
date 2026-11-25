// SPDX-License-Identifier: AGPL-3.0-only
// The Word file of a meeting's published minutes (#4774): the pure part, with no database and no library. A .docx is a zip of a few XML files, so this file holds a small zip writer (node:zlib's raw
// deflate and crc32) and the WordprocessingML of the one-page layout Vietnamese offices use (A4, Times New Roman 13 pt, 3 cm left margin), the same sheet as the printable page
// (apps/app/src/routes/meeting-minutes.tsx): company, title and subject, time, place, attendees, the content under the template's headings, the conclusions, the action items in a table with owner and
// due date, and two blank signature blocks (Ludy signs for no one). Every text is cleaned of characters XML cannot hold and of the invisible and bidirectional controls (INVISIBLE_PATTERN), then
// escaped, so no text can break the file or reorder a line. The file is deterministic: the same minutes give the same bytes.
import { crc32, deflateRawSync } from 'node:zlib';
import { INVISIBLE_PATTERN, MINUTES_DOCX_NAME_MAX } from '@ludy/kernel-contract';

/** A day and a time as Vietnamese offices write them, in Vietnam time. */
export interface VnMoment {
  day: string;
  month: string;
  year: string;
  time: string;
}
const VN = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function vnMoment(at: Date): VnMoment {
  const parts = Object.fromEntries(VN.formatToParts(at).map((p) => [p.type, p.value]));
  return { day: parts.day as string, month: parts.month as string, year: parts.year as string, time: `${parts.hour}:${parts.minute}` };
}

/** "2026-11-14" as 14/11/2026; null stays null (the file has a dotted line to fill by hand). */
export function dueText(day: string | null): string | null {
  if (day === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

export interface MinutesDocSection {
  // The heading over the section ("1. Nhu cầu của khách hàng"), null for the general summary's one block.
  heading: string | null;
  text: string;
}
export interface MinutesDocAction {
  title: string;
  owner: string | null;
  due: string | null;
}
export interface MinutesDoc {
  company: string;
  title: string;
  from: VnMoment;
  to: VnMoment | null;
  place: string;
  attendees: string[];
  sections: MinutesDocSection[];
  conclusions: string[];
  actions: MinutesDocAction[];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// The zip writer
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}
// A fixed time (2026-01-01 00:00) keeps the bytes the same for the same minutes.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const UTF8_NAMES = 0x0800;

/** A zip archive of the entries, each deflated, in the order given. The names are ASCII paths of this file's own. */
export function zipFiles(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(UTF8_NAMES, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, directory, end]));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const HIDDEN = new RegExp(INVISIBLE_PATTERN, 'gu');
// What XML 1.0 can hold: tab, line feed, carriage return and the characters from U+0020, except the surrogates and the two non-characters at the end of the plane. Walking the code points (a lone
// surrogate comes out as one) drops what it cannot hold, a lone surrogate included, with no replacement character left in the file.
function xmlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c === 0x09 || c === 0x0a || c === 0x0d || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || (c >= 0x10000 && c <= 0x10ffff)) out += ch;
  }
  return out;
}

/** One line of text as the file may hold it: no control, invisible or bidirectional character, no lone surrogate, whitespace runs kept as typed. */
export function cleanLine(raw: string): string {
  return xmlChars(raw.replace(HIDDEN, ''));
}
/** The lines of a text, each cleaned; a line break is the only thing that separates them. */
export function cleanLines(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/u).map(cleanLine);
}
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
export function xmlEscape(text: string): string {
  return text.replace(/[&<>"']/gu, (c) => ESCAPES[c] as string);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// WordprocessingML
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const DOTS = '………………………………';
// A blank to fill by hand inside a narrow table cell.
const CELL_DOTS = '…………';
// A4 (11906 x 16838 twentieths of a point), margins of a Vietnamese administrative text: 2 cm top and bottom, 3 cm left, 2 cm right.
const MARGIN = { top: 1134, bottom: 1134, left: 1701, right: 1134 };
const CONTENT_WIDTH = 11906 - MARGIN.left - MARGIN.right;

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  // Half points.
  size?: number;
}
const run = (text: string, style: RunStyle = {}): string => {
  const props = `${style.bold ? '<w:b/><w:bCs/>' : ''}${style.italic ? '<w:i/><w:iCs/>' : ''}${style.size ? `<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>` : ''}`;
  return `<w:r>${props === '' ? '' : `<w:rPr>${props}</w:rPr>`}<w:t xml:space="preserve">${xmlEscape(cleanLine(text))}</w:t></w:r>`;
};
interface ParagraphStyle {
  align?: 'center' | 'left';
  before?: number;
  after?: number;
  // A hanging indent for a bullet (twentieths of a point).
  bullet?: boolean;
  keepNext?: boolean;
}
const paragraph = (runs: string, style: ParagraphStyle = {}): string => {
  const spacing = style.before !== undefined || style.after !== undefined ? `<w:spacing${style.before !== undefined ? ` w:before="${style.before}"` : ''}${style.after !== undefined ? ` w:after="${style.after}"` : ''}/>` : '';
  const props = `${style.keepNext ? '<w:keepNext/>' : ''}${spacing}${style.bullet ? '<w:ind w:left="567" w:hanging="283"/>' : ''}${style.align === 'center' ? '<w:jc w:val="center"/>' : ''}`;
  return `<w:p>${props === '' ? '' : `<w:pPr>${props}</w:pPr>`}${runs}</w:p>`;
};
const text = (value: string, style: RunStyle = {}, para: ParagraphStyle = {}) => paragraph(run(value, style), para);
const labelled = (label: string, value: string) => paragraph(run(`${label}: `, { bold: true }) + run(value));
const heading = (value: string) => text(value, { bold: true }, { before: 200, keepNext: true });
const bullet = (value: string) => paragraph(run(`• ${value}`), { bullet: true });
// A multi-line text: one paragraph for each line, an empty line kept as an empty paragraph.
const block = (value: string) => cleanLines(value).map((line) => paragraph(line === '' ? '' : run(line))).join('');

const BORDER = (name: string) => `<w:${name} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`;
const NO_BORDER = (name: string) => `<w:${name} w:val="nil"/>`;
function table(widths: readonly number[], rows: readonly string[][], opts: { borders: boolean; header?: boolean }): string {
  const edge = opts.borders ? BORDER : NO_BORDER;
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(edge).join('');
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const body = rows
    .map((cells, r) => {
      const trPr = `<w:trPr><w:cantSplit/>${opts.header && r === 0 ? '<w:tblHeader/>' : ''}</w:trPr>`;
      // The borders are set on each cell as well as on the table, so Word and LibreOffice both draw them.
      const tcBorders = opts.borders ? `<w:tcBorders>${['top', 'left', 'bottom', 'right'].map(BORDER).join('')}</w:tcBorders>` : '';
      return `<w:tr>${trPr}${cells.map((cell, c) => `<w:tc><w:tcPr><w:tcW w:w="${widths[c]}" w:type="dxa"/>${tcBorders}</w:tcPr>${cell}</w:tc>`).join('')}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
}

/** The word/document.xml of the minutes. */
export function documentXml(doc: MinutesDoc): string {
  const from = doc.from;
  const clock = doc.to
    ? `Từ ${from.time} đến ${doc.to.time}, ngày ${from.day} tháng ${from.month} năm ${from.year}`
    : `Từ ${from.time}, ngày ${from.day} tháng ${from.month} năm ${from.year}`;
  const out: string[] = [];
  out.push(text(doc.company.trim().toUpperCase(), { bold: true }));
  out.push(text('BIÊN BẢN CUỘC HỌP', { bold: true, size: 30 }, { align: 'center', before: 120, after: 40 }));
  out.push(text(`V/v: ${doc.title}`, { bold: true }, { align: 'center', after: 200 }));
  out.push(labelled('Thời gian', clock));
  out.push(labelled('Địa điểm', doc.place.trim() === '' ? DOTS : doc.place.trim()));
  out.push(text('Thành phần tham dự:', { bold: true }, { keepNext: true }));
  doc.attendees.forEach((name, i) => out.push(bullet(i === 0 ? `${name} (Người ghi biên bản)` : name)));

  out.push(heading('I. NỘI DUNG CUỘC HỌP'));
  if (doc.sections.length === 0) out.push(text('Chưa có nội dung được chia sẻ.'));
  for (const section of doc.sections) {
    if (section.heading !== null) out.push(text(section.heading, { bold: true }, { before: 80, keepNext: true }));
    out.push(block(section.text));
  }

  out.push(heading('II. KẾT LUẬN'));
  if (doc.conclusions.length === 0) out.push(text('Chưa có kết luận được ghi.'));
  for (const conclusion of doc.conclusions) out.push(bullet(conclusion));

  out.push(heading('III. CÔNG VIỆC CẦN THỰC HIỆN'));
  if (doc.actions.length === 0) {
    out.push(text('Không có công việc nào được giao.'));
  } else {
    const cell = (value: string, style: RunStyle = {}, align: 'center' | 'left' = 'left') => paragraph(run(value, style), { align, after: 40 });
    const widths = [800, CONTENT_WIDTH - 800 - 2300 - 1900, 2300, 1900];
    const rows = [
      [cell('STT', { bold: true }, 'center'), cell('Nội dung công việc', { bold: true }), cell('Người phụ trách', { bold: true }), cell('Hạn hoàn thành', { bold: true })],
      ...doc.actions.map((a, i) => [cell(String(i + 1), {}, 'center'), cell(a.title), cell(a.owner ?? CELL_DOTS), cell(a.due ?? CELL_DOTS)]),
    ];
    out.push(table(widths, rows, { borders: true, header: true }));
  }

  // Blank on purpose: people sign on paper or with their own e-signature tool.
  const sign = (title: string) =>
    [text(title, { bold: true }, { align: 'center', before: 360, keepNext: true }), text('(Ký, ghi rõ họ tên)', { italic: true }, { align: 'center', after: 1600 })].join('');
  out.push(table([Math.floor(CONTENT_WIDTH / 2), CONTENT_WIDTH - Math.floor(CONTENT_WIDTH / 2)], [[sign('NGƯỜI GHI BIÊN BẢN'), sign('CHỦ TRÌ CUỘC HỌP')]], { borders: false }));
  // A table at the end of the body needs a paragraph after it.
  out.push(paragraph(''));
  const section = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${MARGIN.top}" w:right="${MARGIN.right}" w:bottom="${MARGIN.bottom}" w:left="${MARGIN.left}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${out.join('')}${section}</w:body></w:document>`;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="26"/><w:szCs w:val="26"/><w:lang w:val="vi-VN" w:eastAsia="vi-VN" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;

/** The .docx of the minutes: the zip of its parts, [Content_Types].xml first. */
export function buildMinutesDocx(doc: MinutesDoc): Uint8Array {
  const utf8 = (s: string) => new TextEncoder().encode(s);
  return zipFiles([
    { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES) },
    { name: '_rels/.rels', data: utf8(ROOT_RELS) },
    { name: 'word/document.xml', data: utf8(documentXml(doc)) },
    { name: 'word/_rels/document.xml.rels', data: utf8(DOCUMENT_RELS) },
    { name: 'word/styles.xml', data: utf8(STYLES) },
  ]);
}

/**
 * The file name: "Biên bản họp - <title> - <YYYY-MM-DD>.docx", the title cut to fit and stripped of what a file name cannot hold on Windows, macOS or Linux (path separators, : * ? " < > |, controls, the invisible
 * characters), a title with nothing left named "cuộc họp".
 */
export function minutesFilename(title: string, day: string): string {
  const clean = cleanLine(title)
    .replace(/[\\/:*?"<>|]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/gu, '');
  // The budget is in UTF-16 units (what the answer's schema counts), and a character is never cut in two.
  const budget = MINUTES_DOCX_NAME_MAX - 'Biên bản họp -  - 0000-00-00'.length;
  let cut = '';
  for (const ch of Array.from(clean === '' ? 'cuộc họp' : clean)) {
    if (cut.length + ch.length > budget) break;
    cut += ch;
  }
  return `Biên bản họp - ${cut.trim()} - ${day}.docx`;
}
