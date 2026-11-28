// SPDX-License-Identifier: AGPL-3.0-only
// Buyer tax code check on extracted purchase invoices (#899): warns when the org (or target legal entity) has an own
// tax code and the buyer tax code parses to another taxpayer, while sparing own/branch codes, missing/unparseable buyer
// codes, unconfigured orgs, and sales invoices.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { zPurchaseProposal, type PurchaseProposal } from '@ludy/kernel-contract';
import type { ExtractClient } from '@ludy/extract-contract';
import { sha256Hex, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import type { ParsedInvoice } from '@ludy/l10n-vn';
import { buyerTaxCodeCheck, extractAndPropose } from '../src/extract.ts';

const ORG = '00000000-0000-4000-8000-000000000001';
const FILE = '00000000-0000-4000-8000-000000000002';
const BYTES = new TextEncoder().encode('%PDF');
const SHA256 = sha256Hex(BYTES);
const parsed = JSON.parse(readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;

const OWN_ENTERPRISE = '0101234564';
const OWN_BRANCH = '0101234564-001';
const OTHER_COMPANY = '0309876546';
const PERSONAL_CODE = '012345678901';

async function propose(buyerTaxCode: string | null, lookup: { direction?: 'purchase' | 'sale'; ownTaxCode?: string | null }): Promise<PurchaseProposal> {
  const seen: { payload: PurchaseProposal | undefined } = { payload: undefined };
  const invoice = structuredClone(parsed);
  invoice.source = 'ai';
  invoice.buyer.taxCode = buyerTaxCode;
  if (lookup.direction === 'sale') {
    invoice.seller.taxCode = lookup.ownTaxCode ?? OWN_ENTERPRISE;
  }
  const runtime = {
    query: async (name: string) =>
      name === 'finance.extraction.file'
        ? { id: FILE, filename: 'hd.pdf', content_type: 'application/pdf', storage_key: `org/${ORG}/${SHA256}`, generation: `content:${SHA256}`, sha256: SHA256, hasExtraction: false, due: true }
        : { direction: lookup.direction ?? 'purchase', ownTaxCode: lookup.ownTaxCode, vendorDefault: null, duplicateDocumentId: null, duplicateProposalId: null },
    execute: async (_name: string, input: unknown) => {
      seen.payload = (input as { proposal: { payload: PurchaseProposal } | null }).proposal?.payload;
      return { proposalId: null };
    },
  } as unknown as Runtime;
  const store = { get: async () => BYTES } as unknown as BlobStore;
  const extract: ExtractClient = { extract: async () => ({ ok: true, kind: 'pdf_text', text: 'x'.repeat(100), pages: 1 }) as never };
  const extractor = { fromText: async () => invoice, fromImage: async () => null };
  await extractAndPropose({ runtime, store, extractor: extractor as never, extract, today: () => '2026-10-13' }, ORG, FILE);
  const payload = seen.payload;
  if (!payload) throw new Error('no proposal was recorded');
  expect(zPurchaseProposal.safeParse(payload).success).toBe(true);
  return payload;
}

describe('buyerTaxCodeCheck (#899)', () => {
  it('warns with the normalized buyer tax code when it parses to another taxpayer', () => {
    expect(buyerTaxCodeCheck(OTHER_COMPANY, OWN_ENTERPRISE)).toMatchObject({
      id: 'buyer_tax_code',
      status: 'warn',
      code: 'buyer_tax_code.other',
      params: { taxCode: OTHER_COMPANY },
    });
    expect(buyerTaxCodeCheck(' 0309.876.546 ', OWN_ENTERPRISE)).toMatchObject({
      code: 'buyer_tax_code.other',
      params: { taxCode: OTHER_COMPANY },
    });
    expect(buyerTaxCodeCheck(`${OTHER_COMPANY}002`, OWN_ENTERPRISE)).toMatchObject({
      code: 'buyer_tax_code.other',
      params: { taxCode: `${OTHER_COMPANY}-002` },
    });
    expect(buyerTaxCodeCheck(PERSONAL_CODE, OWN_ENTERPRISE)).toMatchObject({
      code: 'buyer_tax_code.other',
      params: { taxCode: PERSONAL_CODE },
    });
  });

  it('does not fire when the org has no tax code, when the buyer code is missing/unparseable, or for own/branch codes', () => {
    for (const own of [null, undefined, '', '   ', 'bad']) {
      expect(buyerTaxCodeCheck(OTHER_COMPANY, own)).toBeNull();
    }
    for (const buyer of [null, undefined, '', '   ', 'not a code', '12345', '01012345640', '０３０９８７６５４６']) {
      expect(buyerTaxCodeCheck(buyer, OWN_ENTERPRISE), String(buyer)).toBeNull();
    }
    for (const ownLike of [OWN_ENTERPRISE, ' 0101.234.564 ', OWN_BRANCH, `${OWN_ENTERPRISE}001`, `${OWN_ENTERPRISE} - 123`]) {
      expect(buyerTaxCodeCheck(ownLike, OWN_ENTERPRISE), ownLike).toBeNull();
    }
    expect(buyerTaxCodeCheck(OWN_BRANCH, OWN_BRANCH)).toBeNull();
    expect(buyerTaxCodeCheck(OWN_ENTERPRISE, OWN_BRANCH)).toMatchObject({ code: 'buyer_tax_code.other', params: { taxCode: OWN_ENTERPRISE } });
    expect(buyerTaxCodeCheck(`${OWN_ENTERPRISE}-002`, OWN_BRANCH)).toMatchObject({ code: 'buyer_tax_code.other', params: { taxCode: `${OWN_ENTERPRISE}-002` } });
  });
});

describe('buyer_tax_code.other during extraction (#899)', () => {
  it('adds buyer_tax_code.other on a purchase when the buyer tax code differs from the org', async () => {
    const payload = await propose(` ${OTHER_COMPANY} `, { ownTaxCode: OWN_ENTERPRISE });
    expect(payload.checks.filter((c) => c.id === 'buyer_tax_code')).toEqual([
      expect.objectContaining({ id: 'buyer_tax_code', status: 'warn', code: 'buyer_tax_code.other', params: { taxCode: OTHER_COMPANY } }),
    ]);
  });

  it('spares purchases matching own/branch tax codes, missing/unparseable buyer codes, orgs without a tax code, and sales', async () => {
    for (const [buyer, lookup] of [
      [OWN_ENTERPRISE, { ownTaxCode: OWN_ENTERPRISE }],
      [OWN_BRANCH, { ownTaxCode: OWN_ENTERPRISE }],
      [null, { ownTaxCode: OWN_ENTERPRISE }],
      ['', { ownTaxCode: OWN_ENTERPRISE }],
      ['not-a-tax-code', { ownTaxCode: OWN_ENTERPRISE }],
      [OTHER_COMPANY, { ownTaxCode: null }],
      [OTHER_COMPANY, {}],
      [OTHER_COMPANY, { direction: 'sale' as const, ownTaxCode: OWN_ENTERPRISE }],
    ] as const) {
      const payload = await propose(buyer, lookup);
      expect(payload.checks.some((c) => c.id === 'buyer_tax_code'), JSON.stringify({ buyer, lookup })).toBe(false);
    }
  });
});
