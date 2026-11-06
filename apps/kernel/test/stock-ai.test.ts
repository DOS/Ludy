// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on stock on the API side (#2514) with stand-ins for the reader: the model is asked once with the lines and the items it may see and nothing else, a suggestion
// names an item that was offered, and every state of `ai` is an answer with no suggestion (and, for a reorder, the fixed template), never an error.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, type ReorderRequest, type ReorderResult, type StockMatchAnswer, type StockMatchItem, type StockMatchLine } from '@crove/agent';
import type { ReorderSource, SuggestSource } from '@crove/mod-finance';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { draftReorder, stockAi, suggestItems, STOCK_KEEP_MS, STOCK_KEEP_NONE_MS, type StockAi } from '../src/stock-ai.ts';

const ORG = 'org-1';
const USER = 'user-1';
const SOURCE: SuggestSource = {
  lines: [
    { documentId: 'doc-1', lineNo: 1, description: 'Ao thun co tron den L', unit: 'cai' },
    { documentId: 'doc-1', lineNo: 2, description: 'Dịch vụ vận chuyển', unit: null },
  ],
  items: [
    { id: 'item-a', code: 'AO01', name: 'Áo thun cổ tròn trắng M', unit: 'cái' },
    { id: 'item-b', code: 'AO02', name: 'Áo thun cổ tròn đen L', unit: 'cái' },
  ],
};
const REORDER: ReorderSource = {
  orgName: 'Công ty Hoa Mai',
  supplier: { partyId: 'party-1', name: 'Phương Nam', email: 'ncc@example.com' },
  items: [{ itemId: 'item-a', name: 'Áo thun cổ tròn trắng M', unit: 'cái', quantity: '40' }],
  template: 'Chào Phương Nam,\n- Áo thun cổ tròn trắng M: 40 cái',
};

type Match = (lines: readonly StockMatchLine[], items: readonly StockMatchItem[]) => Promise<Array<StockMatchAnswer | null>>;
type Word = (request: ReorderRequest) => Promise<ReorderResult>;

function setup(options: { match?: Match | null; word?: Word | null; budget?: DraftBudget } = {}) {
  const asked: { match: Array<{ lines: readonly StockMatchLine[]; items: readonly StockMatchItem[]; language: string | undefined }>; word: ReorderRequest[] } = { match: [], word: [] };
  const match = options.match === undefined ? async () => [{ itemIndex: 1, reason: 'Khớp tên' }, null] : options.match;
  const word = options.word === undefined ? async (): Promise<ReorderResult> => ({ kind: 'text', text: 'Chào Phương Nam, xin đặt thêm.' }) : options.word;
  const ai: StockAi = stockAi(
    match && word
      ? {
          stockMatch: async (lines, items, language) => {
            asked.match.push({ lines, items, language });
            return match(lines, items);
          },
          reorderText: async (request) => {
            asked.word.push(request);
            return word(request);
          },
        }
      : null,
    options.budget ?? new DraftBudget(),
  );
  return { ai, asked };
}

afterEach(() => vi.restoreAllMocks());

describe('suggestItems', () => {
  it('asks the model once with the descriptions, the units and the items, and answers the item ids with the reasons', async () => {
    const { ai, asked } = setup();
    expect(await suggestItems(ai, ORG, USER, SOURCE, 'vi')).toEqual({ ai: 'used', suggestions: [{ documentId: 'doc-1', lineNo: 1, itemId: 'item-b', reason: 'Khớp tên' }] });
    expect(asked.match).toHaveLength(1);
    // Nothing of the books but the text and units of the lines and the codes, names and units of the items.
    expect(asked.match[0]).toEqual({
      lines: [
        { description: 'Ao thun co tron den L', unit: 'cai' },
        { description: 'Dịch vụ vận chuyển', unit: null },
      ],
      items: [
        { code: 'AO01', name: 'Áo thun cổ tròn trắng M', unit: 'cái' },
        { code: 'AO02', name: 'Áo thun cổ tròn đen L', unit: 'cái' },
      ],
      language: 'vi',
    });
  });

  it('leaves out an answer whose item is outside the list that was offered', async () => {
    const { ai } = setup({ match: async () => [{ itemIndex: 7, reason: 'Khớp tên' }, null] });
    expect(await suggestItems(ai, ORG, USER, SOURCE, 'vi')).toEqual({ ai: 'used', suggestions: [] });
  });

  it('says off with no call when the deployment has no model, and quiet with no call when there is nothing to ask', async () => {
    const off = setup({ match: null });
    expect(await suggestItems(off.ai, ORG, USER, SOURCE, 'vi')).toEqual({ ai: 'off', suggestions: [] });
    const { ai, asked } = setup();
    expect(await suggestItems(ai, ORG, USER, { lines: [], items: SOURCE.items }, 'vi')).toEqual({ ai: 'quiet', suggestions: [] });
    expect(await suggestItems(ai, ORG, USER, { lines: SOURCE.lines, items: [] }, 'vi')).toEqual({ ai: 'quiet', suggestions: [] });
    expect(asked.match).toEqual([]);
  });

  it('keeps an answer for the same lines against the same items, and asks again for other ones or after a while', async () => {
    const { ai, asked } = setup();
    let clock = 1_000_000;
    const now = () => clock;
    await suggestItems(ai, ORG, USER, SOURCE, 'vi', now);
    await suggestItems(ai, ORG, USER, SOURCE, 'vi', now);
    expect(asked.match).toHaveLength(1);
    // Another org, another language, another item list: asked again.
    await suggestItems(ai, 'org-2', USER, SOURCE, 'vi', now);
    await suggestItems(ai, ORG, USER, SOURCE, 'en', now);
    await suggestItems(ai, ORG, USER, { ...SOURCE, items: [SOURCE.items[0]!] }, 'vi', now);
    expect(asked.match).toHaveLength(4);
    clock += STOCK_KEEP_MS + 1;
    await suggestItems(ai, ORG, USER, SOURCE, 'vi', now);
    expect(asked.match).toHaveLength(5);
  });

  it('keeps "no suggestion" only briefly, so lines whose answers the checks dropped are asked again soon', async () => {
    const { ai, asked } = setup({ match: async () => [null, null] });
    let clock = 1_000_000;
    const now = () => clock;
    expect(await suggestItems(ai, ORG, USER, SOURCE, 'vi', now)).toEqual({ ai: 'used', suggestions: [] });
    await suggestItems(ai, ORG, USER, SOURCE, 'vi', now);
    expect(asked.match).toHaveLength(1);
    clock += STOCK_KEEP_NONE_MS + 1;
    await suggestItems(ai, ORG, USER, SOURCE, 'vi', now);
    expect(asked.match).toHaveLength(2);
  });

  it('says busy when the member asks too often, and budget when the org\'s AI budget is spent', async () => {
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup({ budget });
    expect((await suggestItems(first.ai, ORG, USER, SOURCE, 'vi')).ai).toBe('used');
    const other = { ...SOURCE, lines: [{ documentId: 'doc-9', lineNo: 1, description: 'Bút bi', unit: null }] };
    expect(await suggestItems(first.ai, ORG, USER, other, 'vi')).toEqual({ ai: 'busy', suggestions: [] });
    const spent = setup({
      match: async () => {
        throw new AiBudgetExhaustedError('org', null);
      },
    });
    expect(await suggestItems(spent.ai, ORG, USER, SOURCE, 'vi')).toEqual({ ai: 'budget', suggestions: [] });
  });

  it('says failed when the call fails, logs only a name, and frees the member\'s slot', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const budget = new DraftBudget({ perUserPerMinute: 100, perOrgPerMinute: 100 });
    const broken = setup({
      budget,
      match: async () => {
        throw new Error('boom: Ao thun co tron den L');
      },
    });
    expect(await suggestItems(broken.ai, ORG, USER, SOURCE, 'vi')).toEqual({ ai: 'failed', suggestions: [] });
    expect(JSON.stringify(log.mock.calls)).not.toContain('Ao thun');
    const ok = setup({ budget });
    expect((await suggestItems(ok.ai, ORG, USER, SOURCE, 'vi')).ai).toBe('used');
  });
});

describe('draftReorder', () => {
  it('asks the model once with the names, quantities and units, and answers its text', async () => {
    const { ai, asked } = setup();
    expect(await draftReorder(ai, ORG, USER, REORDER, 'vi', 'lịch sự')).toEqual({ ai: 'used', supplier: REORDER.supplier, text: 'Chào Phương Nam, xin đặt thêm.' });
    expect(asked.word).toEqual([
      { language: 'vi', orgName: 'Công ty Hoa Mai', supplierName: 'Phương Nam', items: [{ name: 'Áo thun cổ tròn trắng M', quantity: '40', unit: 'cái' }], hint: 'lịch sự' },
    ]);
  });

  it('greets a supplier that is not named by a plain word, and leaves the hint out when there is none', async () => {
    const { ai, asked } = setup();
    await draftReorder(ai, ORG, USER, { ...REORDER, supplier: null }, 'en', undefined);
    expect(asked.word[0]).toEqual({ language: 'en', orgName: 'Công ty Hoa Mai', supplierName: 'Supplier', items: [{ name: 'Áo thun cổ tròn trắng M', quantity: '40', unit: 'cái' }] });
  });

  it('gives the fixed template, with the state, whenever there is no text from the model', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const off = setup({ word: null });
    expect(await draftReorder(off.ai, ORG, USER, REORDER, 'vi', undefined)).toEqual({ ai: 'off', supplier: REORDER.supplier, text: REORDER.template });
    const refused = setup({ word: async () => ({ kind: 'none', code: 'FIGURES' }) });
    expect(await draftReorder(refused.ai, ORG, USER, REORDER, 'vi', undefined)).toEqual({ ai: 'failed', supplier: REORDER.supplier, text: REORDER.template });
    expect(JSON.stringify(log.mock.calls)).toContain('FIGURES');
    const spent = setup({
      word: async () => {
        throw new AiBudgetExhaustedError('org', null);
      },
    });
    expect(await draftReorder(spent.ai, ORG, USER, REORDER, 'vi', undefined)).toEqual({ ai: 'budget', supplier: REORDER.supplier, text: REORDER.template });
    const budget = new DraftBudget({ perUserPerMinute: 1, perOrgPerMinute: 1 });
    const first = setup({ budget });
    await draftReorder(first.ai, ORG, USER, REORDER, 'vi', undefined);
    expect(await draftReorder(first.ai, ORG, USER, REORDER, 'vi', undefined)).toEqual({ ai: 'busy', supplier: REORDER.supplier, text: REORDER.template });
  });
});
