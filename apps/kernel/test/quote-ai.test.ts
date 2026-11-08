// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker on the lines of a quote on the API side (#2698) with stand-ins for the reader: the model is asked once with the deal, the customer's words and the earlier lines and nothing
// else; with the org's switch for AI on customers' words off, or with the model off, the budget spent, the member too fast, the call failing or its answer refused, the answer names the state and
// gives nothing to apply, never an error; and nothing the customer wrote is logged.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type QuoteSuggestRequest, type QuoteSuggestResult } from '@crove/agent';
import type { QuoteSuggestSource } from '@crove/mod-crm';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { quoteAi, suggestQuoteLines, type QuoteAi } from '../src/quote-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const SOURCE: QuoteSuggestSource = {
  dealTitle: 'Đơn bánh Tết',
  dealAmount: '3600000',
  partyName: 'Công ty Hoa Mai',
  wordsAllowed: true,
  messages: ['Chị cần 10 hộp bánh A giá 120k, số của chị 0912345678'],
  earlier: [{ description: 'Trà B', unit: 'hộp', unitPrice: '250000', vatRate: '8%' }],
};
const PROPOSAL: QuoteSuggestResult = { kind: 'proposal', lines: [{ description: 'Bánh A', unit: 'hộp', quantity: '10', unitPrice: '120000', priceFrom: 'message', vatRate: null }] };

type Ask = (request: QuoteSuggestRequest) => Promise<QuoteSuggestResult>;

function setup(options: { ask?: Ask | null; budget?: DraftBudget } = {}) {
  const asked: QuoteSuggestRequest[] = [];
  const ask = options.ask === undefined ? async (): Promise<QuoteSuggestResult> => PROPOSAL : options.ask;
  const ai: QuoteAi = quoteAi(
    ask
      ? {
          quoteLines: async (request) => {
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

describe('suggestQuoteLines', () => {
  it('asks the model once with the deal, the words and the earlier lines, and returns the proposed lines', async () => {
    const { ai, asked } = setup();
    const answer = await suggestQuoteLines(ai, ORG, USER, SOURCE);
    expect(asked).toEqual([{ dealTitle: SOURCE.dealTitle, dealAmount: '3600000', partyName: SOURCE.partyName, messages: SOURCE.messages, earlier: SOURCE.earlier }]);
    expect(answer).toEqual({ ai: 'used', lines: [{ description: 'Bánh A', unit: 'hộp', quantity: '10', unitPrice: '120000', priceFrom: 'message', vatRate: null }] });
  });

  it('sends nothing to the model while the org\'s switch for AI on customers\' words is off', async () => {
    const { ai, asked } = setup();
    expect(await suggestQuoteLines(ai, ORG, USER, { ...SOURCE, wordsAllowed: false, messages: [] })).toEqual({ ai: 'words_off', lines: [] });
    expect(asked).toEqual([]);
  });

  it('works as it does with AI off when the deployment has no model', async () => {
    const { ai } = setup({ ask: null });
    expect(await suggestQuoteLines(ai, ORG, USER, SOURCE)).toEqual({ ai: 'off', lines: [] });
  });

  it('says there is nothing to read when the customer has written nothing, without a call', async () => {
    const { ai, asked } = setup();
    expect(await suggestQuoteLines(ai, ORG, USER, { ...SOURCE, messages: [] })).toEqual({ ai: 'no_text', lines: [] });
    expect(asked).toEqual([]);
  });

  it('names a spent AI budget, a failing call and a refused answer, and gives nothing to apply', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await suggestQuoteLines(setup({ ask: async () => Promise.reject(new AiBudgetExhaustedError('org', null)) }).ai, ORG, USER, SOURCE)).toEqual({ ai: 'budget', lines: [] });
    expect(await suggestQuoteLines(setup({ ask: async () => Promise.reject(new Error('boom')) }).ai, ORG, USER, SOURCE)).toEqual({ ai: 'failed', lines: [] });
    expect(await suggestQuoteLines(setup({ ask: async () => ({ kind: 'none', code: 'FIGURES' }) }).ai, ORG, USER, SOURCE)).toEqual({ ai: 'refused', lines: [] });
  });

  it('refuses a second ask of the same member while one runs, and releases the slot afterwards', async () => {
    let release: () => void = () => undefined;
    const { ai } = setup({ ask: () => new Promise((resolve) => (release = () => resolve(PROPOSAL))) });
    const first = suggestQuoteLines(ai, ORG, USER, SOURCE);
    expect(await suggestQuoteLines(ai, ORG, USER, SOURCE)).toEqual({ ai: 'busy', lines: [] });
    release();
    expect((await first).ai).toBe('used');
    expect((await suggestQuoteLines(setup().ai, ORG, USER, SOURCE)).ai).toBe('used');
  });

  it('logs a code or an error name, never what the customer wrote or the model answered', async () => {
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
    await suggestQuoteLines(setup({ ask: async () => ({ kind: 'none', code: 'LINK' }) }).ai, ORG, USER, SOURCE);
    await suggestQuoteLines(setup({ ask: async () => Promise.reject(new Error('0912345678 Bánh A')) }).ai, ORG, USER, SOURCE);
    expect(logged.join('\n')).not.toMatch(/0912345678|Bánh A|Hoa Mai/);
    expect(logged.length).toBe(2);
  });
});
