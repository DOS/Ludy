// SPDX-License-Identifier: AGPL-3.0-only
// Reading a contacts CSV in the browser (#2229): delimiters, quotes, header guesses without Vietnamese marks, the rows as the
// server takes them, and the file of rejected rows.
import { describe, expect, it } from 'vitest';
import { foldHeader, guessMapping, mappedRows, parseContactCsv, rejectsCsv } from '../src/lib/contact-csv.ts';

describe('parseContactCsv', () => {
  it('reads commas, semicolons and tabs, keeping empty cells and dropping blank lines', () => {
    expect(parseContactCsv('Tên,Email\nAn,an@khach.test\n\nBình,\n')).toEqual({ header: ['Tên', 'Email'], rows: [['An', 'an@khach.test'], ['Bình', '']] });
    expect(parseContactCsv('Tên;Email\r\nAn;an@khach.test\r\n').rows).toEqual([['An', 'an@khach.test']]);
    expect(parseContactCsv('Tên\tEmail\nAn\tan@khach.test').rows).toEqual([['An', 'an@khach.test']]);
  });

  it('keeps a delimiter, a quote and a line break inside quoted cells, and drops the byte order mark', () => {
    const parsed = parseContactCsv('﻿Tên,Địa chỉ\n"Công ty ""ABC""","12 Lê Lợi, Quận 1\nTP.HCM"\n');
    expect(parsed.header).toEqual(['Tên', 'Địa chỉ']);
    expect(parsed.rows).toEqual([['Công ty "ABC"', '12 Lê Lợi, Quận 1\nTP.HCM']]);
    // A comma inside quotes does not decide the delimiter.
    expect(parseContactCsv('"a,b,c,d";"e"\n"x";"y"').rows).toEqual([['x', 'y']]);
  });

  it('picks the delimiter that splits every line the same way, not the one that shows up most', () => {
    // Semicolons separate the cells; the commas are in the addresses.
    const parsed = parseContactCsv('Tên;Địa chỉ;Email\nAn;12 Lê Lợi, Quận 1, TP.HCM;an@khach.test\nBình;5 Hai Bà Trưng, Quận 3, TP.HCM, Việt Nam;binh@khach.test');
    expect(parsed.header).toEqual(['Tên', 'Địa chỉ', 'Email']);
    expect(parsed.rows[1]).toEqual(['Bình', '5 Hai Bà Trưng, Quận 3, TP.HCM, Việt Nam', 'binh@khach.test']);
  });
});

describe('guessMapping', () => {
  it('names the fields from Vietnamese and English headers, with or without marks', () => {
    expect(guessMapping(['Họ và tên', 'Mã số thuế', 'Email', 'Số điện thoại', 'Địa chỉ', 'Loại', 'Ghi chú'])).toEqual(['name', 'taxCode', 'email', 'phone', 'address', 'kind', null]);
    expect(guessMapping(['name', 'tax id', 'e-mail', 'Phone', 'address'])).toEqual(['name', 'taxCode', 'email', 'phone', 'address']);
    expect(foldHeader('  Đia chỉ / Địa-Chỉ ')).toBe('dia chi dia chi');
  });

  it('gives a field to the first header that names it only', () => {
    expect(guessMapping(['Tên', 'Tên khách hàng', 'SĐT'])).toEqual(['name', null, 'phone']);
  });
});

describe('mappedRows', () => {
  it('takes the mapped cells, trimmed, and leaves the rest empty', () => {
    const rows = [[' An ', 'an@khach.test', '0912 345 678', 'bỏ'], ['Bình', '', '', '']];
    expect(mappedRows(rows, ['name', 'email', 'phone', null])).toEqual([
      { kind: null, name: 'An', taxCode: null, email: 'an@khach.test', phone: '0912 345 678', address: null },
      { kind: null, name: 'Bình', taxCode: null, email: null, phone: null, address: null },
    ]);
  });
});

describe('rejectsCsv', () => {
  it('writes the rows with the file columns and a reason, quoting and defusing formulas', () => {
    const csv = rejectsCsv(['Tên', 'Email'], [['=SUM(A1)', 'a,"b"@x.test'], ['Bình']], ['Email chưa đúng', 'Trùng'], 'Lý do');
    expect(csv).toBe('﻿"Tên","Email","Lý do"\r\n"\'=SUM(A1)","a,""b""@x.test","Email chưa đúng"\r\n"Bình","","Trùng"\r\n');
    // Read back, the reason column is there and the formula is text.
    const back = parseContactCsv(csv);
    expect(back.header).toEqual(['Tên', 'Email', 'Lý do']);
    expect(back.rows[0]).toEqual(["'=SUM(A1)", 'a,"b"@x.test', 'Email chưa đúng']);
  });

  it('leaves a phone number or a plain number as it was, so the file can be imported again', () => {
    const csv = rejectsCsv(['Tên', 'Điện thoại', 'Ghi chú'], [['An', '+84 912 345 678', '-5'], ['Bình', '+84 912', '@lệnh']], ['a', 'b'], 'Lý do');
    const back = parseContactCsv(csv);
    expect(back.rows[0]).toEqual(['An', '+84 912 345 678', '-5', 'a']);
    expect(back.rows[1]).toEqual(['Bình', '+84 912', "'@lệnh", 'b']);
  });
});
