// SPDX-License-Identifier: AGPL-3.0-only
// Learned sales account rules in extraction (#1452): extractAndPropose passes learned sales rules to
// bookableSaleLines, ignores purchase/non-revenue rules on sales, and ignores sales rules on purchases.
import { describe, expect, it } from 'vitest';
import type { ExtractClient } from '@ludy/extract-contract';
import type { PurchaseProposal } from '@ludy/kernel-contract';
import { sha256Hex, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import type { LearnedRule, ParsedInvoice } from '@ludy/l10n-vn';
import { extractAndPropose, type InvoiceLookup } from '../src/extract.ts';

const FILE_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const RULE_SALE_ID = '00000000-0000-4000-8000-000000000011';
const RULE_PURCHASE_ID = '00000000-0000-4000-8000-000000000012';
const RULE_NONREV_ID = '00000000-0000-4000-8000-000000000013';

function sampleInvoice(overrides: Partial<ParsedInvoice> = {}): ParsedInvoice {
  return {
    source: 'einvoice_xml',
    invoiceType: '01GTKT',
    template: '1',
    series: 'C26TAB',
    number: '0001',
    issueDate: '2026-09-15',
    currency: 'VND',
    exchangeRate: null,
    paymentMethod: 'TM/CK',
    seller: { name: 'CÔNG TY BÁN HÀNG MẪU', taxCode: '0101234564', address: null, email: null, phone: null },
    buyer: { name: 'CÔNG TY KHÁCH HÀNG MẪU', taxCode: '0309876546', address: null, email: null, phone: null },
    lines: [
      {
        lineNo: 1,
        nature: 'goods',
        code: null,
        description: 'Dịch vụ tư vấn phần mềm tháng 9/2026',
        unit: 'Gói',
        quantity: '1',
        unitPrice: '1000000',
        amount: '1000000',
        vatRate: '10%',
      },
      {
        lineNo: 2,
        nature: 'goods',
        code: null,
        description: 'Phí giao nhận hàng hóa',
        unit: 'Chuyến',
        quantity: '1',
        unitPrice: '500000',
        amount: '500000',
        vatRate: '10%',
      },
    ],
    taxBreakdown: [{ rate: '10%', taxableAmount: '1500000', vatAmount: '150000' }],
    subtotal: '1500000',
    vatTotal: '150000',
    total: '1650000',
    totalInWords: null,
    taxAuthorityCode: null,
    hasSignature: false,
    ...overrides,
  };
}

async function runExtraction(lookup: InvoiceLookup, invoice: ParsedInvoice = sampleInvoice()): Promise<PurchaseProposal> {
  const bytes = new TextEncoder().encode('<HDon/>');
  const sha256 = sha256Hex(bytes);
  let recordedPayload: PurchaseProposal | null = null;
  const runtime = {
    query: async (name: string) => {
      if (name === 'finance.extraction.file') {
        return {
          id: FILE_ID,
          filename: 'invoice.xml',
          content_type: 'application/xml',
          storage_key: `${ORG_ID}/${FILE_ID}`,
          generation: null,
          sha256,
          legalEntityId: null,
          hasExtraction: false,
          due: true,
          aiStopped: false,
          waitingAiBudget: false,
        };
      }
      if (name === 'finance.extraction.lookup') return lookup;
      throw new Error(`unexpected query: ${name}`);
    },
    execute: async (name: string, input: { error?: string | null; proposal?: { payload?: PurchaseProposal } | null }) => {
      if (name === 'kernel.extraction.record') {
        if (!input.proposal?.payload) throw new Error(`extraction failed instead of proposing: ${input.error ?? 'unknown'}`);
        recordedPayload = input.proposal.payload;
        return { proposalId: '00000000-0000-4000-8000-000000000099' };
      }
      throw new Error(`unexpected command: ${name}`);
    },
  } as unknown as Runtime;
  const store = {
    get: async () => bytes,
    put: async () => null,
    delete: async () => undefined,
  } as unknown as BlobStore;
  const extract: ExtractClient = {
    extract: async () => ({ ok: true, kind: 'einvoice_xml', invoice }) as never,
  };
  await extractAndPropose({ runtime, store, extractor: null, extract, today: () => '2026-09-20' }, ORG_ID, FILE_ID);
  if (!recordedPayload) throw new Error('expected kernel.extraction.record to receive a proposal payload');
  return recordedPayload;
}

describe('extractAndPropose sales learned account rules (#1452)', () => {
  it('applies learned sales rules to sales lines and falls back to 511 for unmatched lines', async () => {
    const learnedRules: LearnedRule[] = [
      { id: RULE_SALE_ID, direction: 'sale', vendor: true, kind: 'description', text: 'dich vu tu van phan mem thang', label: 'Dịch vụ tư vấn phần mềm tháng 9/2026', account: '5113' },
      // Purchase rule and non-revenue rule must be ignored even if passed in lookup.
      { id: RULE_PURCHASE_ID, direction: 'purchase', vendor: true, kind: 'keyword', text: 'giao nhan', label: 'giao nhận', account: '6421' },
      { id: RULE_NONREV_ID, direction: 'sale', vendor: true, kind: 'keyword', text: 'giao nhan', label: 'giao nhận', account: '6422' },
    ];
    const payload = await runExtraction({
      direction: 'sale',
      ownTaxCode: '0101234564',
      vendorDefault: null,
      learnedRules,
      duplicateDocumentId: null,
      duplicateProposalId: null,
      relatedDocumentId: null,
    });
    expect(payload.direction).toBe('sale');
    expect(payload.lines[0]).toMatchObject({
      debitAccount: '5113',
      accountRule: { source: 'learned', ruleId: RULE_SALE_ID, scope: 'vendor', matchKind: 'description' },
    });
    expect(payload.lines[0]?.reason).toContain('của khách hàng này');
    expect(payload.lines[1]).toMatchObject({
      debitAccount: '511',
      accountRule: { source: 'builtin' },
    });
    expect(payload.journal.some((j) => j.accountCode === '5113' && j.credit === '1000000')).toBe(true);
    expect(payload.journal.some((j) => j.accountCode === '511' && j.credit === '500000')).toBe(true);
  });

  it('ignores sales rules when proposing purchase lines', async () => {
    const learnedRules: LearnedRule[] = [
      { id: RULE_SALE_ID, direction: 'sale', vendor: true, kind: 'keyword', text: 'tu van', label: 'tư vấn', account: '5113' },
    ];
    const payload = await runExtraction({
      direction: 'purchase',
      ownTaxCode: '0309876546',
      vendorDefault: null,
      learnedRules,
      duplicateDocumentId: null,
      duplicateProposalId: null,
      relatedDocumentId: null,
    });
    expect(payload.direction).toBeUndefined();
    expect(payload.lines[0]).toMatchObject({
      debitAccount: '6422',
      accountRule: { source: 'builtin' },
    });
  });
});
