// SPDX-License-Identifier: AGPL-3.0-only
// The masked sheet of an unrecognised order report (#4036): what the worker records, what the screen reads and what the model is told can only ever be shapes (a digit is 9, a letter a, spaces and the marks of a
// date or an amount), and a buyer column carries nothing. The same rules as the sandbox's answer, so a value cannot get in on this side either.
import { describe, expect, it } from 'vitest';
import { zMarketplaceColumnSheet, zMarketplaceColumnsRecord } from '../src/marketplace-columns.ts';

const FILE = '22222222-2222-4222-8222-222222222222';
const sheetOf = (column: object) => ({ headerRow: 2, columns: [{ index: 0, header: 'Số hiệu đơn', samples: ['9999'], buyer: false, ...column }] });

describe('zMarketplaceColumnSheet', () => {
  it('takes shapes: digits as 9, letters as a, and the marks of a date or an amount', () => {
    expect(zMarketplaceColumnSheet.safeParse(sheetOf({ samples: ['9999-99-99', '9.999.999', 'aaaa aaa aaa'] })).success).toBe(true);
    expect(zMarketplaceColumnSheet.safeParse(sheetOf({ samples: ['a@a.aaa'] })).success).toBe(true);
    expect(zMarketplaceColumnSheet.safeParse(sheetOf({ samples: [] })).success).toBe(true);
  });

  it('refuses a sample that is a value: another digit, another letter, a non-Latin letter, a longer text, or a fourth sample', () => {
    for (const sample of ['0900000007', 'b', 'Trần', 'aaaa aaa aaaa a']) expect(zMarketplaceColumnSheet.safeParse(sheetOf({ samples: [sample] })).success, sample).toBe(false);
    expect(zMarketplaceColumnSheet.safeParse(sheetOf({ samples: ['9', '9', '9', '9'] })).success).toBe(false);
  });

  it('holds a buyer column to no header and no sample, and refuses a field for a value', () => {
    expect(zMarketplaceColumnSheet.safeParse(sheetOf({ header: '', samples: [], buyer: true })).success).toBe(true);
    expect(zMarketplaceColumnSheet.safeParse(sheetOf({ header: 'Tên người nhận', samples: [], buyer: true })).success).toBe(false);
    expect(zMarketplaceColumnSheet.safeParse(sheetOf({ header: '', samples: ['aaaa'], buyer: true })).success).toBe(false);
    expect(zMarketplaceColumnSheet.safeParse(sheetOf({ value: '0900000007' })).success).toBe(false);
  });
});

describe('zMarketplaceColumnsRecord', () => {
  const done = (sheet: unknown) => ({ fileId: FILE, requestedAt: '2026-11-20T10:00:00.000Z', result: { state: 'done', sheet, refusal: null, preview: null } });

  it('refuses a recorded sheet that is not made of shapes, so the worker cannot store a value', () => {
    expect(zMarketplaceColumnsRecord.safeParse(done(sheetOf({}))).success).toBe(true);
    expect(zMarketplaceColumnsRecord.safeParse(done(sheetOf({ samples: ['0900000007'] }))).success).toBe(false);
    expect(zMarketplaceColumnsRecord.safeParse(done(sheetOf({ header: 'Tên', samples: ['aaa'], buyer: true }))).success).toBe(false);
  });
});
