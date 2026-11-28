// SPDX-License-Identifier: AGPL-3.0-only
// Learned sales account rules in extraction (#1452): extractAndPropose passes learned sales rules to
// bookableSaleLines, ignores purchase/non-revenue rules on sales, and ignores sales rules on purchases.
import { describe, expect, it } from 'vitest';
import type { ExtractClient } from '@ludy/extract-contract';
import type { InvoiceLookup, PurchaseProposal } from '../src/extract.ts';
import { sha256Hex, type BlobStore, type Runtime } from '@ludy/kernel-runtime';
import { money, type LearnedRule, type ParsedInvoice } from '@ludy/l10n-vn';
import { extractAndPropose } from '../src/extract.ts';

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
        quantity: money('1'),
        unitPrice: money('1000000'),
        amount: money('1000000'),
        vatRate: '10%',
      },
      {
        lineNo: 2,
        nature: 'goods',
        code: null,
        description: 'Phí giao nhận hàng hóa',
        unit: 'Chuyến',
        quantity: money('1'),
        unitPrice: money('500000'),
        amount: money('500000'),
        vatRate: '10%',
      },
    ],
    taxBreakdown: [{ rate: '10%', taxableAmount: money('1500000'), vatAmount: money('150000') }],
    subtotal: money('1500000'),
    vatTotal: money('150000'),
    total: money('1650000'),
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
          id: 'file-1',
          filename: 'invoice.xml',
          content_type: 'application/xml',
          storage_key: 'org-1/file-1',
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
    execute: async (name: string, input: { proposal?: { payload?: PurchaseProposal } }) => {
      if (name === 'kernel.extraction.record') {
        recordedPayload = input.proposal?.payload ?? null;
        return { proposalId: 'prop-1' };
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
  await extractAndPropose({ runtime, store, extractor: null, extract, today: () => '2026-09-20' }, 'org-1', 'file-1');
  if (!recordedPayload) throw new Error('expected kernel.extraction.record to receive a proposal payload');
  return recordedPayload;
}

describe('extractAndPropose sales learned account rules (#1452)', () => {
  it('applies learned sales rules to sales lines and falls back to 511 for unmatched lines', async () => {
    const learnedRules: LearnedRule[] = [
      { id: 'rule-sale-1', direction: 'sale', vendor: true, kind: 'description', text: 'dich vu tu van phan mem thang', label: 'Dịch vụ tư vấn phần mềm tháng 9/2026', account: '5113' },
      // Purchase rule and non-revenue rule must be ignored even if passed in lookup.
      { id: 'rule-purchase', direction: 'purchase', vendor: true, kind: 'keyword', text: 'giao nhan', label: 'giao nhận', account: '6421' },
      { id: 'rule-nonrev', direction: 'sale', vendor: true, kind: 'keyword', text: 'giao nhan', label: 'giao nhận', account: '6422' },
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
      accountRule: { source: 'learned', ruleId: 'rule-sale-1', scope: 'vendor', matchKind: 'description' },
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
      { id: 'rule-sale-only', direction: 'sale', vendor: true, kind: 'keyword', text: 'tu van', label: 'tư vấn', account: '5113' },
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
