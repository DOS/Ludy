// SPDX-License-Identifier: AGPL-3.0-only
// The worker's half of the column check of an unrecognised order report (#4036): the file is read from the blob store and sent to the sandbox's `marketplace_columns` kind with the platform and mapping the
// member picked, and what comes back is recorded as the masked sheet and the verdict (a refusal, or a preview of at most 20 lines). A file that is gone, too large or unreadable, a sandbox that cannot be
// reached and an answer that names a limit are recorded as a code of ours; nothing the sandbox says is passed on; an older request's record is reported so the job runs again.
import { describe, expect, it, vi } from 'vitest';
import { EXTRACT_LIMITS, decodeMarketplaceColumnsInput, type ExtractClient } from '@crove/extract-contract';
import { sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { runMarketplaceColumns } from '../src/marketplace-columns-job.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';
const REQUESTED = '2026-11-20T10:00:00.000Z';
const BYTES = new TextEncoder().encode('a made-up report');
const SHEET = { headerRow: 2, columns: [{ index: 0, header: 'Số hiệu đơn', samples: ['9999'], buyer: false }, { index: 1, header: '', samples: [], buyer: true }] };
const MAPPING = { platform: 'shopee', assignments: [{ index: 0, field: 'orderNo' }] } as const;

function line(n: number) {
  return { rowNo: n + 2, orderNo: `90${n}`, lineKey: `Bút|${n}`, orderedAt: null, shippedAt: null, deliveredAt: null, stage: 'completed' as const, statusLabel: 'Hoàn thành', sku: null, itemName: 'Bút', quantity: '1', unitPrice: '1000', amount: '1000' };
}

function setup(opts: { target?: unknown; bytes?: Uint8Array | 'missing'; answer?: unknown; throws?: boolean; recorded?: boolean } = {}) {
  const records: Array<{ fileId: string; requestedAt: string; result: Record<string, unknown> }> = [];
  const sent: Uint8Array[] = [];
  const runtime = {
    query: async () => opts.target ?? { action: 'check', fileId: FILE, storageKey: 'k', generation: null, sha256: sha256Hex(BYTES), sizeBytes: BYTES.byteLength, requestedAt: REQUESTED, mapping: null },
    execute: async (_name: string, input: { fileId: string; requestedAt: string; result: Record<string, unknown> }) => {
      records.push(input);
      return { recorded: opts.recorded ?? true };
    },
  } as unknown as Runtime;
  const store = {
    get: async () => {
      if (opts.bytes === 'missing') throw new Error('missing blob');
      return opts.bytes ?? BYTES;
    },
  } as unknown as BlobStore;
  const extract = {
    extract: async (_kind: string, body: Uint8Array) => {
      sent.push(body);
      if (opts.throws) throw new Error('unreachable');
      return opts.answer;
    },
  } as unknown as ExtractClient;
  return { deps: { runtime, store, extract }, records, sent };
}

describe('runMarketplaceColumns', () => {
  it('leaves a file alone when there is nothing waiting for it', async () => {
    const { deps, records, sent } = setup({ target: { action: 'none', reason: 'not_requested' } });
    expect(await runMarketplaceColumns(deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'skipped', reason: 'not_requested' });
    expect(records).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('sends the file as an envelope with no mapping, and records the sheet alone', async () => {
    const { deps, records, sent } = setup({ answer: { ok: true, kind: 'marketplace_columns', columns: { sheet: SHEET, check: null } } });
    expect(await runMarketplaceColumns(deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'done' });
    expect(decodeMarketplaceColumnsInput(sent[0] as Uint8Array)).toEqual({ fileBase64: Buffer.from(BYTES).toString('base64') });
    expect(records).toEqual([{ fileId: FILE, requestedAt: REQUESTED, result: { state: 'done', sheet: SHEET, refusal: null, preview: null } }]);
  });

  it('sends the platform and the mapping the member picked, and records the first 20 lines with the total', async () => {
    const lines = Array.from({ length: 25 }, (_, i) => line(i));
    const target = { action: 'check', fileId: FILE, storageKey: 'k', generation: null, sha256: sha256Hex(BYTES), sizeBytes: BYTES.byteLength, requestedAt: REQUESTED, mapping: MAPPING };
    const { deps, records, sent } = setup({ target, answer: { ok: true, kind: 'marketplace_columns', columns: { sheet: SHEET, check: { ok: true, orders: { lines, skippedCount: 3 } } } } });
    expect(await runMarketplaceColumns(deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'done' });
    expect(decodeMarketplaceColumnsInput(sent[0] as Uint8Array).mapping).toEqual(MAPPING);
    const recorded = records[0];
    if (!recorded) throw new Error('nothing was recorded');
    const preview = (recorded.result as { preview: { lines: unknown[]; total: number; skipped: number } }).preview;
    expect(preview.lines).toHaveLength(20);
    expect(preview).toMatchObject({ total: 25, skipped: 3 });
    // Only what the confirm screen shows: no date, no stage, no unit price.
    expect(Object.keys(preview.lines[0] as object).sort()).toEqual(['amount', 'itemName', 'lineKey', 'orderNo', 'quantity', 'rowNo', 'sku', 'status']);
  });

  it('records the refusal of a mapping with no preview', async () => {
    const target = { action: 'check', fileId: FILE, storageKey: 'k', generation: null, sha256: sha256Hex(BYTES), sizeBytes: BYTES.byteLength, requestedAt: REQUESTED, mapping: MAPPING };
    const { deps, records } = setup({ target, answer: { ok: true, kind: 'marketplace_columns', columns: { sheet: SHEET, check: { ok: false, reason: 'buyer_text' } } } });
    await runMarketplaceColumns(deps, { orgId: ORG, fileId: FILE });
    expect(records[0]?.result).toEqual({ state: 'done', sheet: SHEET, refusal: 'buyer_text', preview: null });
  });

  it('records a code of ours when the file is no sheet, too large, gone or unreadable, and when the sandbox does not answer, never its words', async () => {
    const noSheet = setup({ answer: { ok: true, kind: 'marketplace_columns', columns: { sheet: null, check: null } } });
    expect(await runMarketplaceColumns(noSheet.deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'failed', failure: 'not_a_sheet' });
    const big = { action: 'check', fileId: FILE, storageKey: 'k', generation: null, sha256: sha256Hex(BYTES), sizeBytes: EXTRACT_LIMITS.maxOrderReportBytes + 1, requestedAt: REQUESTED, mapping: null };
    const tooBig = setup({ target: big });
    expect(await runMarketplaceColumns(tooBig.deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'failed', failure: 'too_large' });
    expect(tooBig.sent).toEqual([]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const gone = setup({ bytes: 'missing' });
    expect(await runMarketplaceColumns(gone.deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'failed', failure: 'unreadable' });
    const swapped = setup({ bytes: new TextEncoder().encode('other bytes') });
    expect(await runMarketplaceColumns(swapped.deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'failed', failure: 'unreadable' });
    const down = setup({ throws: true });
    expect(await runMarketplaceColumns(down.deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'failed', failure: 'unavailable' });
    const limit = setup({ answer: { ok: false, code: 'timeout', message: 'a planted sandbox message' } });
    expect(await runMarketplaceColumns(limit.deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'failed', failure: 'unreadable' });
    const busy = setup({ answer: { ok: false, code: 'busy', message: 'a planted sandbox message' } });
    expect(await runMarketplaceColumns(busy.deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'failed', failure: 'unavailable' });
    expect(JSON.stringify([noSheet.records, gone.records, down.records, limit.records, busy.records])).not.toContain('planted');
  });

  it('says when the record was dropped because the request was filed again, so the job runs again', async () => {
    const { deps } = setup({ answer: { ok: true, kind: 'marketplace_columns', columns: { sheet: SHEET, check: null } }, recorded: false });
    expect(await runMarketplaceColumns(deps, { orgId: ORG, fileId: FILE })).toEqual({ state: 'done', superseded: true });
  });
});
