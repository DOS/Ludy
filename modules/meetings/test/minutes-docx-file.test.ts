// SPDX-License-Identifier: AGPL-3.0-only
// The Word file of the published minutes (#4774), the pure part: the zip is a valid archive (read back here with node:zlib and checked against its own CRCs), the same minutes give the same bytes, the XML is
// well formed and escaped whatever the text holds, the layout has what the printable page has (company, title, time, place, attendees, content, conclusions, the action table, the signature blocks), and the
// file name is safe on every system and fits the answer's schema.
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { zMinutesDocx, MINUTES_DOCX_MIME } from '@ludy/kernel-contract';
import { buildMinutesDocx, cleanLine, documentXml, dueText, minutesFilename, vnMoment, xmlEscape, zipFiles, type MinutesDoc } from '../src/minutes-docx-file.ts';

// A zip read back: the entries by name, each inflated and checked against the CRC and size its headers state.
function unzip(bytes: Uint8Array): Map<string, string> {
  const buf = Buffer.from(bytes);
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  expect(at + buf.readUInt32LE(end + 12)).toBe(end);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(start, start + packed));
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data.toString('utf8'));
    at += 46 + nameLength;
  }
  return out;
}

// A well-formedness check for the markup this file writes: tags balance, a text holds no bare "<" or "&", every entity is one of the five.
function assertWellFormed(xml: string): void {
  const body = xml.replace(/^<\?xml[^>]*\?>\n?/u, '');
  const stack: string[] = [];
  let last = 0;
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+="[^"<&]*")*)\s*(\/?)>/gu)) {
    const between = body.slice(last, m.index);
    expect(between, 'text between tags').not.toMatch(/[<>]/u);
    expect(between.replace(/&(?:amp|lt|gt|quot|apos);/gu, ''), 'bare ampersand').not.toContain('&');
    last = (m.index ?? 0) + m[0].length;
    if (m[4] === '/') continue;
    if (m[1] === '/') expect(stack.pop()).toBe(m[2]);
    else stack.push(m[2] as string);
  }
  expect(body.slice(last).trim()).toBe('');
  expect(stack).toEqual([]);
}

const doc = (over: Partial<MinutesDoc> = {}): MinutesDoc => ({
  company: 'Công ty TNHH Giao Ban',
  title: 'Họp giao ban tuần',
  from: vnMoment(new Date('2026-11-24T02:00:00Z')),
  to: vnMoment(new Date('2026-11-24T03:30:00Z')),
  place: '',
  attendees: ['Nguyễn Văn Lan', 'Trần Thị Hùng'],
  sections: [{ heading: '1. Kết quả công việc kỳ trước', text: 'Đã giao 12 đơn hàng.\n\nCòn 3 đơn chờ.' }],
  conclusions: ['Chốt giá gói kế toán 15.000.000 đồng'],
  actions: [
    { title: 'Gửi báo giá bản cuối', owner: 'Trần Thị Hùng', due: '14/11/2026' },
    { title: 'Soạn hợp đồng', owner: null, due: null },
  ],
  ...over,
});

describe('zipFiles', () => {
  it('writes a valid archive that reads back entry by entry, in the order given', () => {
    const entries = unzip(zipFiles([{ name: 'a/b.txt', data: new TextEncoder().encode('xin chào '.repeat(200)) }, { name: 'c.xml', data: new Uint8Array(0) }]));
    expect([...entries.keys()]).toEqual(['a/b.txt', 'c.xml']);
    expect(entries.get('a/b.txt')).toBe('xin chào '.repeat(200));
    expect(entries.get('c.xml')).toBe('');
  });
});

describe('the .docx', () => {
  it('is a zip of the five parts of a Word package, [Content_Types].xml first, every part well formed', () => {
    const bytes = buildMinutesDocx(doc());
    expect(Buffer.from(bytes.subarray(0, 4))).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const parts = unzip(bytes);
    expect([...parts.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml']);
    for (const xml of parts.values()) assertWellFormed(xml);
    expect(parts.get('[Content_Types].xml')).toContain('wordprocessingml.document.main+xml');
    expect(parts.get('_rels/.rels')).toContain('Target="word/document.xml"');
  });

  it('gives the same bytes for the same minutes', () => {
    expect(Buffer.from(buildMinutesDocx(doc())).equals(Buffer.from(buildMinutesDocx(doc())))).toBe(true);
  });

  it('lays out the sheet of the printable page', () => {
    const xml = documentXml(doc({ place: 'Phòng họp tầng 3' }));
    assertWellFormed(xml);
    const text = [...xml.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/gu)].map((m) => m[1]);
    expect(text).toEqual([
      'CÔNG TY TNHH GIAO BAN',
      'BIÊN BẢN CUỘC HỌP',
      'V/v: Họp giao ban tuần',
      'Thời gian: ',
      'Từ 09:00 đến 10:30, ngày 24 tháng 11 năm 2026',
      'Địa điểm: ',
      'Phòng họp tầng 3',
      'Thành phần tham dự:',
      '• Nguyễn Văn Lan (Người ghi biên bản)',
      '• Trần Thị Hùng',
      'I. NỘI DUNG CUỘC HỌP',
      '1. Kết quả công việc kỳ trước',
      'Đã giao 12 đơn hàng.',
      'Còn 3 đơn chờ.',
      'II. KẾT LUẬN',
      '• Chốt giá gói kế toán 15.000.000 đồng',
      'III. CÔNG VIỆC CẦN THỰC HIỆN',
      'STT',
      'Nội dung công việc',
      'Người phụ trách',
      'Hạn hoàn thành',
      '1',
      'Gửi báo giá bản cuối',
      'Trần Thị Hùng',
      '14/11/2026',
      '2',
      'Soạn hợp đồng',
      '…………',
      '…………',
      'NGƯỜI GHI BIÊN BẢN',
      '(Ký, ghi rõ họ tên)',
      'CHỦ TRÌ CUỘC HỌP',
      '(Ký, ghi rõ họ tên)',
    ]);
    // The table has a header row that repeats and its borders; the page is A4 with the 3 cm left margin.
    expect(xml).toContain('<w:tblHeader/>');
    expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(xml).toContain('w:left="1701"');
    // An empty paragraph keeps the blank line of the text.
    expect(xml).toContain('<w:p></w:p>');
  });

  it('writes a dotted line for a place nobody typed and for no end time, and says so for nothing shared in a part', () => {
    const xml = documentXml(doc({ place: '   ', to: null, sections: [], conclusions: [], actions: [] }));
    assertWellFormed(xml);
    expect(xml).toContain('Từ 09:00, ngày 24 tháng 11 năm 2026');
    expect(xml).toContain('………………………………');
    expect(xml).toContain('Chưa có nội dung được chia sẻ.');
    expect(xml).toContain('Chưa có kết luận được ghi.');
    expect(xml).toContain('Không có công việc nào được giao.');
    expect(xml).not.toContain('<w:tblHeader/>');
  });

  it('puts the general summary in as plain paragraphs with no heading', () => {
    const xml = documentXml(doc({ sections: [{ heading: null, text: 'Một dòng\nHai dòng' }] }));
    expect(xml).toContain('>Một dòng<');
    expect(xml).toContain('>Hai dòng<');
  });

  it('keeps whatever the text holds out of the markup: escaped, with controls and bidirectional overrides removed', () => {
    const hostile = '<w:p>&amp;</w:p> "quoted" \'single\' \u0000nul\u0007bell\u202eoverride\u200bzero\ud800lone';
    const xml = documentXml(doc({ title: hostile, company: hostile, place: hostile, attendees: [hostile], conclusions: [hostile], sections: [{ heading: hostile, text: hostile }], actions: [{ title: hostile, owner: hostile, due: null }] }));
    assertWellFormed(xml);
    expect(xml).not.toContain('<w:p>&amp;');
    expect(xml).toContain('&lt;w:p&gt;&amp;amp;&lt;/w:p&gt; &quot;quoted&quot; &apos;single&apos; nulbelloverridezerolone');
    for (const bad of ['\u0000', '\u0007', '\u202e', '\u200b', '\ud800']) expect(xml).not.toContain(bad);
  });
});

describe('text helpers', () => {
  it('cleans a line and escapes the five characters', () => {
    expect(cleanLine('a\u0000b\u202ec\ud83d')).toBe('abc');
    expect(cleanLine('Đặng Thị 😀 tốt')).toBe('Đặng Thị 😀 tốt');
    expect(xmlEscape(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
  });

  it('writes a moment in Vietnam time, across midnight in UTC, and a due date as day/month/year', () => {
    expect(vnMoment(new Date('2026-11-24T17:30:00Z'))).toEqual({ day: '25', month: '11', year: '2026', time: '00:30' });
    expect(vnMoment(new Date('2026-11-24T16:59:00Z'))).toEqual({ day: '24', month: '11', year: '2026', time: '23:59' });
    expect(dueText('2026-11-14')).toBe('14/11/2026');
    expect(dueText(null)).toBeNull();
    expect(dueText('14-11-2026')).toBeNull();
  });
});

describe('minutesFilename', () => {
  it('names the file from the meeting title and its day', () => {
    expect(minutesFilename('Họp giao ban tuần', '2026-11-24')).toBe('Biên bản họp - Họp giao ban tuần - 2026-11-24.docx');
  });

  it('strips what a file name cannot hold on Windows, macOS or Linux, controls and invisible characters included', () => {
    const name = minutesFilename('Họp: giao/ban? *tuần* "một" <hai> |ba| \\bốn\u0000\u202e', '2026-11-24');
    expect(name).toBe('Biên bản họp - Họp giao ban tuần một hai ba bốn - 2026-11-24.docx');
    expect([...name].some((ch) => '\\/:*?"<>|'.includes(ch) || (ch.codePointAt(0) as number) < 0x20 || ch === '\u202e')).toBe(false);
  });

  it('falls back to "cuộc họp" for a title with nothing left, and trims leading and trailing dots', () => {
    expect(minutesFilename('  ...  ', '2026-11-24')).toBe('Biên bản họp - cuộc họp - 2026-11-24.docx');
    expect(minutesFilename('///', '2026-11-24')).toBe('Biên bản họp - cuộc họp - 2026-11-24.docx');
    expect(minutesFilename('..Báo cáo..', '2026-11-24')).toBe('Biên bản họp - Báo cáo - 2026-11-24.docx');
  });

  it('cuts a long title to fit the answer, never in the middle of a character', () => {
    for (const title of ['x'.repeat(500), 'Họp '.repeat(100), '😀'.repeat(300), 'a😀'.repeat(200)]) {
      const filename = minutesFilename(title, '2026-11-24');
      expect(filename.endsWith(' - 2026-11-24.docx')).toBe(true);
      expect(filename).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
      expect(zMinutesDocx.safeParse({ filename, mimeType: MINUTES_DOCX_MIME, bytes: 1, contentBase64: 'AA==' }).success, title.slice(0, 8)).toBe(true);
    }
  });
});
