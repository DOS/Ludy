// SPDX-License-Identifier: AGPL-3.0-only
// The seller's lookup link and code read from a PDF's text lands on the proposal (#2267): only for a purchase read from a
// PDF, only links on a table host, and the provider lists of the contract and of l10n-vn are the same.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOOKUP_PROVIDER_IDS, zPurchaseProposal, type PurchaseProposal } from '@crove/kernel-contract';
import type { ExtractClient } from '@crove/extract-contract';
import { sha256Hex, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { LOOKUP_PROVIDERS, type ParsedInvoice } from '@crove/l10n-vn';
import { extractAndPropose } from '../src/extract.ts';

const ORG = '00000000-0000-4000-8000-000000000001';
const FILE = '00000000-0000-4000-8000-000000000002';
const BYTES = new TextEncoder().encode('%PDF');
const SHA256 = sha256Hex(BYTES);
const parsed = JSON.parse(readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;

// A PDF read by AI into the fixture invoice; `pdfText` is what crove-extract answers as its text, `direction` what the
// duplicate lookup says about the seller.
async function propose(pdfText: string, direction: 'purchase' | 'sale' = 'purchase'): Promise<PurchaseProposal> {
  const seen: { payload: PurchaseProposal | undefined } = { payload: undefined };
  const runtime = {
    query: async (name: string) =>
      name === 'finance.extraction.file'
        ? { id: FILE, filename: 'hd.pdf', content_type: 'application/pdf', storage_key: `org/${ORG}/${SHA256}`, generation: `content:${SHA256}`, sha256: SHA256, hasExtraction: false, due: true }
        : { direction, vendorDefault: null, duplicateDocumentId: null, duplicateProposalId: null },
    execute: async (_name: string, input: unknown) => {
      seen.payload = (input as { proposal: { payload: PurchaseProposal } | null }).proposal?.payload;
      return { proposalId: null };
    },
  } as unknown as Runtime;
  const store = { get: async () => BYTES } as unknown as BlobStore;
  const extract: ExtractClient = { extract: async () => ({ ok: true, kind: 'pdf_text', text: pdfText, pages: 1 }) as never };
  const invoice = structuredClone(parsed);
  invoice.source = 'ai';
  const extractor = { fromText: async () => invoice, fromImage: async () => null };
  await extractAndPropose({ runtime, store, extractor: extractor as never, extract, today: () => '2026-10-13' }, ORG, FILE);
  if (!seen.payload) throw new Error('no proposal was recorded');
  expect(zPurchaseProposal.safeParse(seen.payload).success).toBe(true);
  return seen.payload;
}

const PADDING = 'Hóa đơn giá trị gia tăng. '.repeat(5);

describe('lookup hints on a proposal read from a PDF (#2267)', () => {
  it('keeps the link and code printed on the PDF', async () => {
    const payload = await propose(`${PADDING}Tra cứu tại Website: https://sinvoice.viettel.vn/tracuuhoadon, Mã số bí mật: 1A2B3C4D5E`);
    expect(payload.lookupHints).toEqual([{ provider: 'viettel', url: 'https://sinvoice.viettel.vn/tracuuhoadon', code: '1A2B3C4D5E' }]);
  });

  it('adds nothing when the text has no lookup code or link on a known host', async () => {
    expect((await propose(PADDING)).lookupHints).toBeUndefined();
    expect((await propose(`${PADDING}Xem tại https://evil.test/meinvoice.vn`)).lookupHints).toBeUndefined();
  });

  it('keeps a link of another seller out, since the VNPT host must carry the invoice seller', async () => {
    const seller = (parsed.seller.taxCode ?? '').replace(/\D/g, '');
    const other = seller === '0000000000' ? '1111111111' : '0000000000';
    const payload = await propose(`${PADDING}Website: https://${other}.vnpt-invoice.com.vn Mã tra cứu: HD7X2K9Q4M`);
    expect(payload.lookupHints).toEqual([{ provider: null, url: null, code: 'HD7X2K9Q4M' }]);
  });

  it('reads no hint for a sale: the original of an invoice the org issued is not looked up', async () => {
    const payload = await propose(`${PADDING}Tra cứu tại https://meinvoice.vn/tra-cuu Mã tra cứu: 4F7K2M9QXA3`, 'sale');
    expect(payload.lookupHints).toBeUndefined();
  });
});

describe('the providers of the contract and of l10n-vn', () => {
  it('are the same list', () => {
    expect([...LOOKUP_PROVIDER_IDS]).toEqual([...LOOKUP_PROVIDERS]);
  });
});
