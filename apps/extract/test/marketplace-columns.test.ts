// SPDX-License-Identifier: AGPL-3.0-only
// The marketplace_columns kind of the sandbox (#4035, #3850 slice 1b): the masked sheet of an order report no platform profile fits, and the check of a column mapping on the real file. The files are
// made in code with made-up buyers, planted in columns the headers flag as the buyer's AND in columns they do not: none of their values, and none of the headers of the flagged columns, may be in any answer.
import { describe, expect, it } from 'vitest';
import {
  COLUMN_REFUSAL_REASONS,
  EXTRACT_LIMITS,
  MarketplaceColumnsInputError,
  decodeMarketplaceColumnsInput,
  encodeMarketplaceColumnsInput,
  maxRequestBytes,
  zExtractResponse,
  zExtractedMarketplaceColumns,
  type MarketplaceColumnsInput,
} from '@crove/extract-contract';
import { COLUMN_REFUSALS, findOrderColumns } from '@crove/l10n-vn';
import { readMarketplaceColumns } from '../src/marketplace-columns.ts';
import { readSheetGrid } from '../src/bank-statement.ts';
import { parse } from '../src/parse.ts';
import { runSandboxed } from '../src/sandbox.ts';
import { createExtractApp } from '../src/server.ts';
import { buildXlsx, type XlsxCell } from './xlsx-fixture.ts';

const BUYER = { name: 'Trần Thị Mua Thử', phone: '0900000007', email: 'mua.thu@example.com', address: '2 Phố Thử, Quận Thử, Hà Nội', secondPhone: '0900000011' };

// A shop's own export: no profile fits its headers. Column 3 and 4 are flagged by their headers (a recipient and a phone); 8 and 9 are NOT (a reference and a free column) and hold a phone, an
// email and a name all the same.
const HEAD: XlsxCell[] = ['Số hiệu đơn', 'Ngày tạo', 'Tình trạng', 'Tên người nhận', 'SĐT', 'Mô tả mặt hàng', 'Số lượng', 'Giá bán', 'Tham chiếu 1', 'Cột tự do'];
const row = (order: string, status: string, qty: number, price: number): XlsxCell[] => [order, '2026-10-30', status, BUYER.name, BUYER.phone, `Sản phẩm ${order}`, qty, price, BUYER.secondPhone, `${BUYER.name} ${BUYER.email}`];
const report = (): XlsxCell[][] => [['Báo cáo của cửa hàng'], HEAD, row('9001', 'Hoàn thành', 2, 50000), row('9002', 'Đã hủy', 1, 120000), row('9003', 'Hoàn thành', 3, 50000)];
const FLAGGED_HEADERS = ['Tên người nhận', 'SĐT'];

const envelope = (file: Uint8Array, mapping?: MarketplaceColumnsInput['mapping']): Uint8Array =>
  encodeMarketplaceColumnsInput({ fileBase64: Buffer.from(file).toString('base64'), ...(mapping ? { mapping } : {}) });
type Assignments = NonNullable<MarketplaceColumnsInput['mapping']>['assignments'];
const GOOD: NonNullable<MarketplaceColumnsInput['mapping']> = {
  platform: 'shopee',
  assignments: [
    { index: 0, field: 'orderNo' },
    { index: 1, field: 'orderedAt' },
    { index: 2, field: 'status' },
    { index: 5, field: 'itemName' },
    { index: 6, field: 'quantity' },
    { index: 7, field: 'unitPrice' },
  ],
};

function noBuyerIn(answer: unknown): void {
  const everything = JSON.stringify(answer);
  for (const value of Object.values(BUYER)) expect(everything).not.toContain(value);
  for (const part of ['Trần', 'Mua Thử', 'example.com', '0900000', 'Phố Thử']) expect(everything).not.toContain(part);
  for (const header of FLAGGED_HEADERS) expect(everything).not.toContain(header);
}

describe('readMarketplaceColumns, without a mapping', () => {
  it('is a file no profile fits, so the sheet is what the person and the model are given', () => {
    const grid = readSheetGrid(buildXlsx(report()));
    expect(grid && findOrderColumns(grid)).toBeNull();
  });

  it('returns the masked sheet: the header texts, shapes of a few values, the buyer columns blanked', () => {
    const answer = readMarketplaceColumns(envelope(buildXlsx(report())));
    expect(answer.check).toBeNull();
    expect(answer.sheet?.headerRow).toBe(2);
    const columns = answer.sheet?.columns ?? [];
    expect(columns).toHaveLength(HEAD.length);
    expect(columns.filter((c) => c.buyer).map((c) => c.index)).toEqual([3, 4]);
    // A flagged column is an empty shell.
    for (const c of columns.filter((c) => c.buyer)) expect(c).toEqual({ index: c.index, header: '', samples: [], buyer: true });
    // The others keep the header text and at most three shapes of values.
    const date = columns.find((c) => c.index === 1);
    expect(date).toEqual({ index: 1, header: 'Ngày tạo', samples: ['9999-99-99', '9999-99-99', '9999-99-99'], buyer: false });
    expect(columns.find((c) => c.index === 6)?.samples).toEqual(['9', '9', '9']);
    noBuyerIn(answer);
  });

  it('shows no value of an unflagged column that holds a phone, an email or a name: only its shape', () => {
    const answer = readMarketplaceColumns(envelope(buildXlsx(report())));
    const reference = answer.sheet?.columns.find((c) => c.index === 8);
    const free = answer.sheet?.columns.find((c) => c.index === 9);
    expect(reference).toMatchObject({ header: 'Tham chiếu 1', buyer: false });
    expect(reference?.samples).toEqual(['9999999999', '9999999999', '9999999999']);
    // A name and an email: letters are a, cut at 12 characters, so neither is readable.
    expect(free?.samples[0]).toBe('aaaa aaa aaa');
    expect(free?.samples[0]).toHaveLength(12);
    noBuyerIn(answer);
  });

  it('answers a file that is no sheet, or has no header row, with no sheet', () => {
    expect(readMarketplaceColumns(envelope(new TextEncoder().encode('plain text, no table')))).toEqual({ sheet: null, check: null });
    // An empty file is no request at all.
    expect(() => envelope(new Uint8Array(0))).toThrow(MarketplaceColumnsInputError);
    expect(readMarketplaceColumns(envelope(buildXlsx([['only one cell']])))).toEqual({ sheet: null, check: null });
    // Asked to check a mapping on it, the answer is the check's own: no header.
    expect(readMarketplaceColumns(envelope(buildXlsx([['only one cell']]), GOOD))).toEqual({ sheet: null, check: { ok: false, reason: 'no_header' } });
  });
});

describe('readMarketplaceColumns, with a mapping', () => {
  it('reads the file through the mapping: the lines and summary of marketplace_orders, flagged as no profile of the platform and unconfirmed', () => {
    const answer = readMarketplaceColumns(envelope(buildXlsx(report()), GOOD));
    expect(answer.check?.ok).toBe(true);
    if (!answer.check?.ok) throw new Error('expected a passing check');
    const { orders } = answer.check;
    expect(orders).toMatchObject({ recognized: true, platform: 'shopee', tooMany: false, skippedCount: 0 });
    expect(orders.profile).toEqual({ version: 'shopee-2026-11-a+columns', confirmed: false });
    expect(orders.lines.map((l) => [l.rowNo, l.orderNo, l.stage, l.quantity, l.unitPrice, l.itemName])).toEqual([
      [3, '9001', 'completed', '2', '50000', 'Sản phẩm 9001'],
      [4, '9002', 'cancelled', '1', '120000', 'Sản phẩm 9002'],
      [5, '9003', 'completed', '3', '50000', 'Sản phẩm 9003'],
    ]);
    // The headers the mapping names are the file's own words for the columns it read.
    expect(orders.columns).toEqual(GOOD.assignments.map((a) => ({ field: a.field, header: HEAD[a.index] })));
    noBuyerIn(answer);
  });

  it('refuses a mapping the check refuses, with the check reason, and shows no buyer either way', () => {
    const refusal = (assignments: Assignments) => readMarketplaceColumns(envelope(buildXlsx(report()), { platform: 'shopee', assignments })).check;
    const without = GOOD.assignments.filter((a) => a.field !== 'orderNo');
    // A buyer column can not be mapped to anything, nor a column the file does not have.
    expect(refusal([...GOOD.assignments, { index: 3, field: 'sku' }])).toEqual({ ok: false, reason: 'buyer_column' });
    expect(refusal([...GOOD.assignments, { index: 99, field: 'sku' }])).toEqual({ ok: false, reason: 'bad_column' });
    expect(refusal([...GOOD.assignments, { index: 8, field: 'quantity' }])).toEqual({ ok: false, reason: 'field_twice' });
    expect(refusal([...GOOD.assignments, { index: 6, field: 'sku' }])).toEqual({ ok: false, reason: 'column_twice' });
    expect(refusal(without)).toEqual({ ok: false, reason: 'no_order_no' });
    for (const assignments of [[...GOOD.assignments, { index: 3, field: 'sku' as const }], without]) noBuyerIn(readMarketplaceColumns(envelope(buildXlsx(report()), { platform: 'shopee', assignments })));
  });

  it('refuses an unflagged column that holds an email or a phone number when it is mapped to a text field, so it does not come out as a line', () => {
    // Column 9 holds "name email" and column 8 a phone number, under headers that name no buyer: mapped to the free-text fields they would be copied into the lines.
    const toVariation = (index: number) => readMarketplaceColumns(envelope(buildXlsx(report()), { platform: 'shopee', assignments: [...GOOD.assignments, { index, field: 'variation' }] }));
    for (const index of [8, 9]) {
      const answer = toVariation(index);
      expect(answer.check).toEqual({ ok: false, reason: 'buyer_text' });
      noBuyerIn(answer);
    }
    // The status taken from the free column: the same refusal (an unknown status would also be listed by its label).
    const asStatus = readMarketplaceColumns(envelope(buildXlsx(report()), { platform: 'shopee', assignments: [...GOOD.assignments.filter((a) => a.field !== 'status'), { index: 9, field: 'status' }] }));
    expect(asStatus.check).toEqual({ ok: false, reason: 'buyer_text' });
    noBuyerIn(asStatus);
  });

  it('can not tell a name from a product: a name column with no email or phone that a person maps to a text field is read, and the name comes back in the line key (the limit of the guarantee)', () => {
    // The limit, stated by a test so that nobody reads the guarantee as wider than it is: the sandbox holds a buyer's header list and an email or phone in a text field, not a name. The variation joins the
    // product in the line key, so a name column mapped to `variation` shows in `lineKey`. The person's confirm screen (#4036) shows the parsed lines before anything is saved; the model never sees a value.
    const plain = (): XlsxCell[][] => [['Báo cáo'], ['Số hiệu đơn', 'Số lượng', 'Mô tả', 'Cột tự do'], ['9001', 2, 'Bút', BUYER.name], ['9002', 1, 'Vở', 'Lê Văn Mua']];
    const answer = readMarketplaceColumns(
      envelope(buildXlsx(plain()), {
        platform: 'shopee',
        assignments: [
          { index: 0, field: 'orderNo' },
          { index: 1, field: 'quantity' },
          { index: 2, field: 'itemName' },
          { index: 3, field: 'variation' },
        ],
      }),
    );
    if (!answer.check?.ok) throw new Error('expected a passing check');
    expect(answer.check.orders.lines.map((l) => l.lineKey)).toEqual([`Bút|${BUYER.name}`, 'Vở|Lê Văn Mua']);
    // The sheet itself never shows a name: only its shape.
    expect(JSON.stringify(answer.sheet)).not.toContain(BUYER.name);
  });
});

describe('the envelope and the contract', () => {
  it('lists the same refusal reasons as the check', () => {
    expect([...COLUMN_REFUSAL_REASONS]).toEqual([...COLUMN_REFUSALS]);
  });

  it('holds a sample to a shape and a buyer column to nothing: a value does not pass the schema', () => {
    const column = { index: 0, header: 'Tham chiếu', samples: ['9999999999'], buyer: false };
    const ok = (c: object) => zExtractedMarketplaceColumns.safeParse({ sheet: { headerRow: 1, columns: [c] }, check: null }).success;
    expect(ok(column)).toBe(true);
    // A digit other than 9, a letter other than a, a non-Latin letter: not a shape.
    expect(ok({ ...column, samples: ['0900000007'] })).toBe(false);
    expect(ok({ ...column, samples: ['b'] })).toBe(false);
    expect(ok({ ...column, samples: ['Trần'] })).toBe(false);
    expect(ok({ ...column, samples: ['aaaa aaa aaaa a'] })).toBe(false);
    expect(ok({ ...column, samples: ['9', '9', '9', '9'] })).toBe(false);
    // A buyer column carries no header and no sample, and nothing else (no field for a value).
    expect(ok({ index: 3, header: '', samples: [], buyer: true })).toBe(true);
    expect(ok({ index: 3, header: 'Tên người nhận', samples: [], buyer: true })).toBe(false);
    expect(ok({ index: 3, header: '', samples: ['aaaa'], buyer: true })).toBe(false);
    expect(ok({ ...column, value: BUYER.phone })).toBe(false);
  });

  it('holds the request to the file and one assignment per field at most', () => {
    const file = Buffer.from('x').toString('base64');
    const parsed = (input: unknown) => decodeMarketplaceColumnsInput(new TextEncoder().encode(JSON.stringify(input)));
    expect(parsed({ fileBase64: file })).toEqual({ fileBase64: file });
    expect(() => parsed({ fileBase64: file, mapping: { platform: 'shopee', assignments: [] } })).toThrow(MarketplaceColumnsInputError);
    expect(() => parsed({ fileBase64: file, mapping: { assignments: [{ index: 0, field: 'orderNo' }] } })).toThrow(MarketplaceColumnsInputError);
    expect(() => parsed({ fileBase64: file, mapping: { platform: 'amazon', assignments: [{ index: 0, field: 'orderNo' }] } })).toThrow(MarketplaceColumnsInputError);
    // A field that is not a standard one (a buyer field is not) can not be a target.
    expect(() => parsed({ fileBase64: file, mapping: { platform: 'shopee', assignments: [{ index: 0, field: 'buyerName' }] } })).toThrow(MarketplaceColumnsInputError);
    expect(() => parsed({ fileBase64: file, extra: 1 })).toThrow(MarketplaceColumnsInputError);
    expect(() => parsed({ fileBase64: 'not base64 !' })).toThrow(MarketplaceColumnsInputError);
    expect(() => decodeMarketplaceColumnsInput(new TextEncoder().encode('{'))).toThrow(MarketplaceColumnsInputError);
    expect(() => decodeMarketplaceColumnsInput(new Uint8Array(0))).toThrow(MarketplaceColumnsInputError);
  });

  it('carries a report of the largest size and a full mapping within the limit it states', () => {
    const full: NonNullable<MarketplaceColumnsInput['mapping']> = {
      platform: 'lazada',
      assignments: Array.from({ length: 13 }, (_, i) => ({ index: 16_383, field: (['orderNo', 'lineKey', 'orderedAt', 'shippedAt', 'deliveredAt', 'status', 'returnStatus', 'sku', 'itemName', 'variation', 'quantity', 'unitPrice', 'amount'] as const)[i] as 'orderNo' })),
    };
    const encoded = envelope(new Uint8Array(EXTRACT_LIMITS.maxOrderReportBytes), full);
    expect(encoded.byteLength).toBeLessThanOrEqual(maxRequestBytes('marketplace_columns'));
    expect(maxRequestBytes('marketplace_columns')).toBe(EXTRACT_LIMITS.maxColumnsRequestBytes);
  });
});

describe('through the parser, the sandbox and the door', () => {
  it('answers a valid contract result for the sheet and for the check', async () => {
    const sheet = zExtractResponse.parse(await parse('marketplace_columns', envelope(buildXlsx(report()))));
    expect(sheet).toMatchObject({ ok: true, kind: 'marketplace_columns', columns: { check: null, sheet: { headerRow: 2 } } });
    const checked = zExtractResponse.parse(await parse('marketplace_columns', envelope(buildXlsx(report()), GOOD)));
    expect(checked).toMatchObject({ ok: true, kind: 'marketplace_columns', columns: { check: { ok: true } } });
    noBuyerIn([sheet, checked]);
  });

  it('refuses a request that is no envelope, or whose file is over the cap, as invalid input', async () => {
    expect(await parse('marketplace_columns', new TextEncoder().encode('nope'))).toMatchObject({ ok: false, code: 'invalid' });
    // One byte over the report cap passes the encoded-size schema (base64 pads to the same length) and is refused after decoding.
    expect(await parse('marketplace_columns', envelope(new Uint8Array(EXTRACT_LIMITS.maxOrderReportBytes + 1)))).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('works in a parser process, and the buyer stays out of what it answers', async () => {
    const answer = await runSandboxed('marketplace_columns', envelope(buildXlsx(report()), GOOD));
    expect(answer).toMatchObject({ ok: true, kind: 'marketplace_columns', columns: { check: { ok: true } } });
    noBuyerIn(answer);
  });

  it('is refused at the door over the request cap, before a byte is read, and accepts an envelope under it', async () => {
    const app = createExtractApp();
    const post = (body: Uint8Array) => app.fetch(new Request('http://crove-extract.test/extract?kind=marketplace_columns', { method: 'POST', body: new Uint8Array(body), headers: { 'content-type': 'application/octet-stream' } }));
    const over = await post(new Uint8Array(EXTRACT_LIMITS.maxColumnsRequestBytes + 1));
    expect(over.status).toBe(413);
    expect(zExtractResponse.parse(await over.json())).toMatchObject({ ok: false, code: 'too_large' });
    const fine = await post(envelope(buildXlsx(report()), GOOD));
    expect(fine.status).toBe(200);
    expect(zExtractResponse.parse(await fine.json())).toMatchObject({ ok: true, kind: 'marketplace_columns' });
  });
});
