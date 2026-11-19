// SPDX-License-Identifier: AGPL-3.0-only
// The column proposal on the real path (#3850): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText. It holds the instructions and the
// header texts and masked shapes of the columns shown; a buyer column, and anything a careless caller adds to the objects (raw values, a platform, a party), never reaches the wire. The feature is booked under
// its own AI budget key.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, marketplaceColumnsFactsText, marketplaceColumnsInstructions, withAiScope, type AiMeter, type MarketplaceColumnFacts } from '../src/index.ts';

const PLANTED = ['Nguyễn Văn Mua', '0900000001', 'mua@example.com', 'Gian hàng Canary', 'CRMDV000000123'];
const col = (index: number, header: string, samples: string[]) => ({ index, header, samples, buyer: false });
const FACTS: MarketplaceColumnFacts = { language: 'vi', columns: [col(0, 'Số chứng từ bán', ['a9']), col(3, 'Mặt hàng', ['aaa']), col(4, 'Số lượng bán', ['9'])] };
// A careless caller: a buyer column with its real header kept, raw values, a platform name and a party id on the objects.
const tainted = {
  language: 'vi',
  columns: [
    { ...FACTS.columns[0], values: [PLANTED[0]], platform: PLANTED[3] },
    { index: 1, header: 'Người mua', samples: [PLANTED[0]], buyer: true },
    { index: 2, header: 'Số điện thoại', samples: [PLANTED[1]], buyer: true, email: PLANTED[2] },
    { ...FACTS.columns[1], partyId: PLANTED[4] },
    FACTS.columns[2],
  ],
} as unknown as MarketplaceColumnFacts;

const booked: string[] = [];
const meter: AiMeter = { admit: async (call) => void booked.push(`${call.feature}:${call.module}`), record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const reader = () => new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });

afterEach(() => vi.unstubAllGlobals());

describe('what leaves for the model for the column proposal (the bytes of the HTTP request)', () => {
  it('is the instructions and the shown headers and shapes, with no buyer column and nothing planted, and is metered', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify(completion({ columns: [{ column: 0, field: 'orderNo' }, { column: 4, field: 'quantity' }, { column: 1, field: 'sku' }] })), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    booked.length = 0;
    const result = await withAiScope({ orgId: 'org', meter }, () => reader().marketplaceColumns(tainted));
    // The buyer column was never shown, so an answer for it is dropped.
    expect(result).toEqual({ kind: 'proposal', assignments: [{ index: 0, field: 'orderNo' }, { index: 4, field: 'quantity' }] });
    expect(booked).toEqual(['finance.stock_columns:finance']);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    for (const secret of [...PLANTED, 'Người mua', 'Số điện thoại']) expect(body).not.toContain(secret);
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(marketplaceColumnsInstructions('vi'));
    expect(messages[1]?.content).toBe(`${marketplaceColumnsFactsText(FACTS)}\n\nSay which standard field each column is, or "none".`);
  });

  it('makes no call and books nothing for a sheet with fewer than three columns to show', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    booked.length = 0;
    const result = await withAiScope({ orgId: 'org', meter }, () => reader().marketplaceColumns({ language: 'vi', columns: FACTS.columns.slice(0, 2) }));
    expect(result).toEqual({ kind: 'none', code: 'EMPTY' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(booked).toEqual([]);
  });
});
