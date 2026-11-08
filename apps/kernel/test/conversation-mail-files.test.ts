// SPDX-License-Identifier: AGPL-3.0-only
// What a customer's mail carries besides its text (#2758): images are told by their bytes alone (never the name or the MIME type the sender gave),
// held to the size cap and a count, and every other file is a line of name, size and type with no bytes. No database needed.
import { describe, expect, it } from 'vitest';
import { CONVERSATION_ATTACHMENTS_MAX, CONVERSATION_IMAGE_MAX_BYTES } from '@crove/kernel-contract';
import type { ExtractedEmail } from '@crove/extract-contract';
import { cleanFileName, mailFilesNote, readMailFiles } from '../src/conversation-mail-files.ts';

import { conversationEventOf } from '../src/inbound.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
// A PNG whose header says 10000 x 10000 pixels (100 MP) in a few bytes: a small file that unpacks into a huge picture.
const BOMB = Buffer.from(PNG);
BOMB.writeUInt32BE(10_000, 16);
BOMB.writeUInt32BE(10_000, 20);
const file = (filename: string | null, bytes: Buffer) => ({ filename, content: bytes.toString('base64') });

describe('readMailFiles', () => {
  it('keeps a PNG and a JPEG as images in the mail’s order and lists a PDF with its name, type and size', () => {
    const got = readMailFiles([file('a.png', PNG), file('b.jpg', JPEG), file('hoa-don.pdf', PDF)]);
    expect(got.images.map((i) => i.contentType)).toEqual(['image/png', 'image/jpeg']);
    expect(got.images[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(got.lines).toEqual(['- hoa-don.pdf (PDF, 1 KB)']);
  });

  it('decides by the bytes: a name or type that says image over other bytes is a file, never an image, and SVG is never stored', () => {
    const got = readMailFiles([file('gia-mao.png', PDF), file('logo.svg', SVG), file('text.jpg', Buffer.from('not an image'))]);
    expect(got.images).toEqual([]);
    expect(got.lines).toEqual(['- gia-mao.png (PDF, 1 KB)', '- logo.svg (không phải ảnh hợp lệ, 1 KB)', '- text.jpg (không phải ảnh hợp lệ, 1 KB)']);
  });

  it('skips an image over the size cap and the images past the count, with a note, and never drops the others', () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(CONVERSATION_IMAGE_MAX_BYTES)]);
    const many = Array.from({ length: CONVERSATION_ATTACHMENTS_MAX + 2 }, (_, i) => file(`m${i}.png`, PNG));
    const got = readMailFiles([file('lon.png', huge), ...many]);
    expect(got.images).toHaveLength(CONVERSATION_ATTACHMENTS_MAX);
    expect(got.lines[0]).toMatch(/^- lon\.png \(ảnh 5(,0)? MB, quá lớn nên không lưu\)$/);
    expect(got.lines.slice(1)).toHaveLength(2);
    expect(got.lines[1]).toContain('quá nhiều ảnh');
  });

  it('lists an image whose header says it has too many pixels, and every image once the org’s day of mailed images is spent', () => {
    const got = readMailFiles([file('bom.png', BOMB), file('a.png', PNG)]);
    expect(got.images.map((i) => i.width)).toEqual([1]);
    expect(got.lines).toEqual(['- bom.png (ảnh 10000x10000, độ phân giải quá lớn nên không lưu)']);
    const spent = readMailFiles([file('a.png', PNG), file('b.jpg', JPEG)], false);
    expect(spent.images).toEqual([]);
    expect(spent.lines).toHaveLength(2);
    expect(spent.lines[0]).toContain('hôm nay Hộp thư đã nhận nhiều ảnh nên không lưu');
  });

  it('strips the line and paragraph separators, word joiners and Arabic letter mark from a file name', () => {
    const unsafe = [0x2028, 0x2029, 0x2060, 0x2064, 0x061c, 0x180e].map((c) => String.fromCharCode(c)).join('');
    expect(cleanFileName(`a${unsafe}b.pdf`)).toBe('a b.pdf');
  });

  it('cleans the sender’s file name to one short line', () => {
    expect(cleanFileName('C:\\Users\\x\\..\\hóa đơn\u202Egnp.exe\n.pdf')).toBe('hóa đơn gnp.exe .pdf');
    expect(cleanFileName(null)).toBe('tệp không tên');
    expect(cleanFileName('a'.repeat(300))).toHaveLength(80);
  });

  it('lists a long run of files within the note’s cap', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `- ${'x'.repeat(78)}${i} (PDF, 1 KB)`);
    const note = mailFilesNote(lines);
    expect(note.length).toBeLessThanOrEqual(1600);
    expect(note).toMatch(/và \d+ tệp khác$/);
    expect(mailFilesNote([])).toBe('');
  });
});

describe('conversationEventOf with attachments', () => {
  const base: ExtractedEmail = {
    from: 'khach@mau.test',
    fromName: 'Khách',
    to: ['x@in.test'],
    subject: 'Hỏi',
    messageId: '<m1@mau.test>',
    text: 'Xin chào',
    attachments: [],
  } as unknown as ExtractedEmail;

  it('counts the images in the event, keeps their bytes out of it, and lists the other files in the text', () => {
    const made = conversationEventOf({ ...base, attachments: [file('a.png', PNG), file('b.pdf', PDF)] }, 'a'.repeat(64), 'in.test', new Date());
    if (!('event' in made)) throw new Error('expected an event');
    expect(made.event.mailImages).toBe(1);
    expect(made.event.mailImageBytes).toBe(PNG.byteLength);
    expect(made.images).toHaveLength(1);
    expect(made.event.text).toBe('Xin chào\n\nTệp đính kèm (chỉ hiện tên, không lưu nội dung):\n- b.pdf (PDF, 1 KB)');
    expect(JSON.stringify(made.event)).not.toContain(PNG.toString('base64'));
    expect(made.event.text).not.toContain('a.png');
  });

  it('keeps a mail with only images readable, and a mail with none unchanged', () => {
    const imagesOnly = conversationEventOf({ ...base, text: '', attachments: [file('a.png', PNG)] }, 'a'.repeat(64), 'in.test', new Date());
    if (!('event' in imagesOnly)) throw new Error('expected an event');
    expect(imagesOnly.event.text).toBe('[Thư không có chữ, chỉ có ảnh đính kèm]');
    const plain = conversationEventOf(base, 'a'.repeat(64), 'in.test', new Date());
    if (!('event' in plain)) throw new Error('expected an event');
    expect(plain.event.text).toBe('Xin chào');
    expect(plain.event.mailImages).toBeUndefined();
  });
});
