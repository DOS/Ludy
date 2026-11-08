// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on a sales e-invoice draft on the API side (#2505) with stand-ins for the reader: the model is asked once with the text and the customers' names and nothing else, the
// buyer comes from the customer's own record (a tax code that fails its checksum is left out), a line without a stated rate gets the customer's usual rate, else the org's, and every state of
// `ai` is an answer with nothing to fill in, never an error.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type EInvoiceDraftRequest, type EInvoiceDraftResult } from '@crove/agent';
import { enterpriseCheckDigit } from '@crove/l10n-vn';
import type { EInvoiceSuggestSource } from '@crove/mod-finance';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { buyerOf, einvoiceAi, suggestEInvoiceDraft, usualRate, withInvoice, type EInvoiceAi } from '../src/einvoice-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const PREFIX = '010010910';
const VALID_TAX_CODE = `${PREFIX}${enterpriseCheckDigit(PREFIX)}`;
const BAD_TAX_CODE = `${PREFIX}${((enterpriseCheckDigit(PREFIX) ?? 0) + 1) % 10}`;
const INPUT = { text: 'bán 10 hộp bánh A giá 120k cho Hoa Mai', date: '2026-11-05' };
const SOURCE: EInvoiceSuggestSource = {
  parties: [
    { id: 'party-1', kind: 'organization', name: 'Công ty Hoa Mai', taxCode: VALID_TAX_CODE, address: '12 Lê Lợi, Quận 1', email: 'ketoan@hoamai.example', rates: [{ vatRate: '8%', n: 5 }, { vatRate: '10%', n: 2 }] },
    { id: 'party-2', kind: 'person', name: 'Nguyễn Văn Nam', taxCode: null, address: null, email: null, rates: [] },
  ],
  orgRates: [{ vatRate: '10%', n: 9 }],
  invoice: null,
};
const LINES = [{ description: 'Bánh A', unit: 'hộp', quantity: '10', unitPrice: '120000', vatRate: null }];

type Ask = (request: EInvoiceDraftRequest) => Promise<EInvoiceDraftResult>;

function setup(options: { ask?: Ask | null; budget?: DraftBudget } = {}) {
  const asked: EInvoiceDraftRequest[] = [];
  const ask = options.ask === undefined ? async (): Promise<EInvoiceDraftResult> => ({ kind: 'proposal', lines: LINES, buyerIndex: 0 }) : options.ask;
  const ai: EInvoiceAi = einvoiceAi(
    ask
      ? {
          einvoiceDraft: async (request) => {
            asked.push(request);
            return ask(request);
          },
        }
      : null,
    options.budget ?? new DraftBudget(),
  );
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('suggestEInvoiceDraft', () => {
  it('reads the lines of the picked invoice together with the typed text, as one source, and still fills the buyer from the record (#2721)', async () => {
    const { ai, asked } = setup();
    const invoice = { text: 'Hóa đơn trước gửi cùng khách:\n- Bánh A, đơn vị hộp, số lượng 10, đơn giá 120000, VAT 8%' };
    await suggestEInvoiceDraft(ai, ORG, USER, { ...SOURCE, invoice }, { ...INPUT, text: 'giống lần trước' });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.text).toBe(`giống lần trước\n\n${invoice.text}`);
    // The customers offered are still only names.
    expect(asked[0]?.parties).toEqual([{ name: 'Công ty Hoa Mai' }, { name: 'Nguyễn Văn Nam' }]);
  });

  it('adds nothing to the text for an invoice whose text is empty, or when none was picked', async () => {
    const empty = setup();
    await suggestEInvoiceDraft(empty.ai, ORG, USER, { ...SOURCE, invoice: { text: '' } }, INPUT);
    expect(empty.asked[0]?.text).toBe(INPUT.text);
    const none = setup();
    await suggestEInvoiceDraft(none.ai, ORG, USER, SOURCE, INPUT);
    expect(none.asked[0]?.text).toBe(INPUT.text);
  });

  it('with the model off, an invoice source gives nothing to fill in and never reads the model (the form\'s copy by code does not need it)', async () => {
    const off = setup({ ask: null });
    const answer = await suggestEInvoiceDraft(off.ai, ORG, USER, { ...SOURCE, invoice: { text: 'Hóa đơn trước gửi cùng khách:\n- Bánh A, số lượng 1' } }, INPUT);
    expect(answer).toEqual({ ai: 'off', lines: [], buyer: null });
    expect(off.asked).toEqual([]);
  });
  it('asks the model once with the text, the date and the customers\' names only, and fills the buyer from the record', async () => {
    const { ai, asked } = setup();
    const answer = await suggestEInvoiceDraft(ai, ORG, USER, SOURCE, INPUT);
    expect(asked).toEqual([{ text: INPUT.text, date: INPUT.date, parties: [{ name: 'Công ty Hoa Mai' }, { name: 'Nguyễn Văn Nam' }] }]);
    expect(JSON.stringify(asked)).not.toContain('Lê Lợi');
    expect(JSON.stringify(asked)).not.toContain(VALID_TAX_CODE);
    expect(answer.ai).toBe('used');
    expect(answer.buyer).toEqual({ kind: 'business', partyId: 'party-1', taxCode: VALID_TAX_CODE, name: 'Công ty Hoa Mai', address: '12 Lê Lợi, Quận 1', email: 'ketoan@hoamai.example' });
    // The text states no rate: the customer's usual one fills it.
    expect(answer.lines).toEqual([{ description: 'Bánh A', unit: 'hộp', quantity: '10', unitPrice: '120000', vatRate: '8%', vatFrom: 'earlier' }]);
  });

  it('keeps the rate the text stated, falls back to the org\'s rate, and to the form default when there is none', async () => {
    const stated = setup({ ask: async () => ({ kind: 'proposal', lines: [{ ...LINES[0]!, vatRate: '5%' }], buyerIndex: 0 }) });
    expect((await suggestEInvoiceDraft(stated.ai, ORG, USER, SOURCE, INPUT)).lines[0]).toMatchObject({ vatRate: '5%', vatFrom: 'text' });
    const none = setup({ ask: async () => ({ kind: 'proposal', lines: LINES, buyerIndex: 1 }) });
    expect((await suggestEInvoiceDraft(none.ai, ORG, USER, SOURCE, INPUT)).lines[0]).toMatchObject({ vatRate: '10%', vatFrom: 'earlier' });
    const bare = setup();
    expect((await suggestEInvoiceDraft(bare.ai, ORG, USER, { ...SOURCE, orgRates: [], parties: [{ ...SOURCE.parties[0]!, rates: [] }] }, INPUT)).lines[0]).toMatchObject({ vatRate: '10%', vatFrom: 'default' });
  });

  it('gives no buyer when the model named none, and a person\'s record as an individual', async () => {
    const noBuyer = setup({ ask: async () => ({ kind: 'proposal', lines: LINES, buyerIndex: null }) });
    expect((await suggestEInvoiceDraft(noBuyer.ai, ORG, USER, SOURCE, INPUT)).buyer).toBeNull();
    const person = setup({ ask: async () => ({ kind: 'proposal', lines: [], buyerIndex: 1 }) });
    expect(await suggestEInvoiceDraft(person.ai, ORG, USER, SOURCE, INPUT)).toEqual({
      ai: 'used',
      lines: [],
      buyer: { kind: 'individual', partyId: 'party-2', taxCode: null, name: 'Nguyễn Văn Nam', address: null, email: null },
    });
  });

  it('answers off without asking when the deployment has no model', async () => {
    const { ai } = setup({ ask: null });
    expect(await suggestEInvoiceDraft(ai, ORG, USER, SOURCE, INPUT)).toEqual({ ai: 'off', lines: [], buyer: null });
  });

  it('answers refused, with nothing to fill in, when the checks of the answer refuse it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ai } = setup({ ask: async () => ({ kind: 'none', code: 'FIGURES' }) });
    expect(await suggestEInvoiceDraft(ai, ORG, USER, SOURCE, INPUT)).toEqual({ ai: 'refused', lines: [], buyer: null });
    // The code is logged, never the text or the model's words.
    expect(error).toHaveBeenCalledWith('[einvoice-ai] draft refused: FIGURES');
    expect(JSON.stringify(error.mock.calls)).not.toContain('bánh');
  });

  it('answers busy when the member\'s calls are too frequent or one is running, budget when the AI budget is spent, failed when the call fails', async () => {
    let release: () => void = () => undefined;
    const slow = setup({ ask: () => new Promise((resolve) => (release = () => resolve({ kind: 'proposal', lines: [], buyerIndex: 0 }))) });
    const first = suggestEInvoiceDraft(slow.ai, ORG, USER, SOURCE, INPUT);
    expect(await suggestEInvoiceDraft(slow.ai, ORG, USER, SOURCE, INPUT)).toMatchObject({ ai: 'busy' });
    release();
    expect(await first).toMatchObject({ ai: 'used' });

    const spent = setup({ ask: async () => Promise.reject(new AiBudgetExhaustedError('org', null)) });
    expect(await suggestEInvoiceDraft(spent.ai, ORG, USER, SOURCE, INPUT)).toEqual({ ai: 'budget', lines: [], buyer: null });

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = setup({ ask: async () => Promise.reject(new Error('boom: bánh A 120k')) });
    expect(await suggestEInvoiceDraft(broken.ai, ORG, USER, SOURCE, INPUT)).toEqual({ ai: 'failed', lines: [], buyer: null });
    expect(JSON.stringify(error.mock.calls)).not.toContain('bánh');
  });
});

describe('buyerOf', () => {
  it('leaves out a tax code that fails its checksum, so the form\'s own check asks for it', () => {
    const party = { ...SOURCE.parties[0]!, taxCode: BAD_TAX_CODE };
    expect(buyerOf(party)).toMatchObject({ kind: 'business', taxCode: null, name: 'Công ty Hoa Mai' });
    expect(buyerOf({ ...party, taxCode: 'abc' }).taxCode).toBeNull();
    expect(buyerOf(SOURCE.parties[0]!).taxCode).toBe(VALID_TAX_CODE);
  });

  it('leaves out a field longer than the draft takes, and keeps the rest', () => {
    const party = { ...SOURCE.parties[0]!, email: `${'a'.repeat(250)}@example.com`, address: 'x'.repeat(501), name: 'y'.repeat(401) };
    expect(buyerOf(party)).toMatchObject({ email: null, address: null, name: null, partyId: party.id });
  });
});

describe('usualRate', () => {
  it('is the most used rate the date allows, the lower rate string on a tie, and null for none', () => {
    expect(usualRate([{ vatRate: '8%', n: 5 }, { vatRate: '10%', n: 2 }], ['0%', '8%', '10%'])).toBe('8%');
    // 8% is not allowed after the periods of the reduced rate.
    expect(usualRate([{ vatRate: '8%', n: 5 }, { vatRate: '10%', n: 2 }], ['0%', '10%'])).toBe('10%');
    expect(usualRate([{ vatRate: '10%', n: 3 }, { vatRate: '5%', n: 3 }], ['5%', '10%'])).toBe('10%');
    expect(usualRate([], ['10%'])).toBeNull();
    expect(usualRate([{ vatRate: 'KHAC:3%', n: 4 }], ['10%'])).toBeNull();
  });
});

describe('withInvoice', () => {
  const invoice = 'Hóa đơn trước gửi cùng khách:\n- Bánh A, số lượng 10, đơn giá 120000\n- Trà B, số lượng 2, đơn giá 1200000';
  it('adds the invoice after the typed text', () => {
    expect(withInvoice('giống lần trước', invoice)).toBe(`giống lần trước\n\n${invoice}`);
    expect(withInvoice('x', '')).toBe('x');
  });
  it('adds only whole lines that fit under the cut, never a figure cut in the middle, and nothing when not even one fits', () => {
    const header = 'Hóa đơn trước gửi cùng khách:';
    const one = '- Bánh A, số lượng 10, đơn giá 120000';
    const typed = 'a'.repeat(2000 - 2 - header.length - 1 - one.length - 1);
    const text = withInvoice(typed, invoice);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text.endsWith(one)).toBe(true);
    expect(withInvoice('a'.repeat(1990), invoice)).toBe('a'.repeat(1990));
  });
});
