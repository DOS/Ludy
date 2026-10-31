import { describe, expect, it } from 'vitest';
import { isCsvName, safeFilename, sniffType } from '../src/sniff.ts';

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);

describe('upload type detection', () => {
  it('recognises the accepted formats by content', () => {
    expect(sniffType(text('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffType(text('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(sniffType(new Uint8Array([0xef, 0xbb, 0xbf, ...text('\n  <?xml version="1.0"?><HDon/>')]))).toBe('application/xml');
    // A ZIP of documents (bulk intake, #314), empty or not; an Office file is a ZIP too, refused when it is opened.
    expect(sniffType(text('PK\x03\x04\x14\0'))).toBe('application/zip');
    expect(sniffType(text('PK\x05\x06'))).toBe('application/zip');
  });

  it('recognises CSV text by its content: two lines with a delimiter, no control characters (#2142)', () => {
    expect(sniffType(text('Ngày giao dịch,Diễn giải,Ghi có\r\n01/09/2026,Thu tiền,100000\r\n'))).toBe('text/csv');
    expect(sniffType(new Uint8Array([0xef, 0xbb, 0xbf, ...text('Date;Amount\n01/09/2026;100000\n')]))).toBe('text/csv');
    // UTF-16 with its byte order mark, as Excel saves "Unicode text".
    const utf16 = new Uint8Array([0xff, 0xfe, ...[...'Date\tAmount\n01/09/2026\t100000\n'].flatMap((c) => [c.charCodeAt(0), 0])]);
    expect(sniffType(utf16)).toBe('text/csv');
    // Prose, a single line, and binary bytes are no CSV.
    expect(sniffType(text('Xin chào\nĐây là một thư\n'))).toBeNull();
    expect(sniffType(text('a,b,c\n'))).toBeNull();
    expect(sniffType(bytes(0x61, 0x2c, 0x62, 0x0a, 0x01, 0x2c, 0x02, 0x0a))).toBeNull();
    expect(isCsvName('Sao-ke.CSV')).toBe(true);
    expect(isCsvName('sao-ke.csv.exe')).toBe(false);
    expect(safeFilename('sao-ke.txt', 'text/csv')).toBe('sao-ke.csv');
  });

  it('refuses anything else, whatever its name or declared type', () => {
    expect(sniffType(text('MZ\x90\0'))).toBeNull();
    expect(sniffType(text('Rar!\x1a\x07\0'))).toBeNull();
    expect(sniffType(new Uint8Array())).toBeNull();
  });

  it('forces the extension of the detected type', () => {
    expect(safeFilename('hoa-don.exe', 'application/pdf')).toBe('hoa-don.pdf');
    expect(safeFilename('../../etc/passwd', 'application/xml')).toBe('.._.._etc_passwd.xml');
    expect(safeFilename('', 'image/png')).toBe('tep.png');
    expect(safeFilename('thang-10.ZIP', 'application/zip')).toBe('thang-10.zip');
  });
});
