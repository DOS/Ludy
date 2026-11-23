// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's line on the Sàn screen on the real path (#2516 slice E): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText.
// The facts hold three numbers; a careless caller that adds a platform name, an order, a buyer or a bank account to the object changes nothing on the wire, and what comes back is display only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, marketplaceLineFactsText, marketplaceLineInstructions, withAiScope, type AiMeter, type MarketplaceLineFacts } from '../src/index.ts';

const PLANTED = ['Shopee Việt Nam', 'Lazada Test Shop', 'Nguyễn Thị Mua', 'ORDER-2611-0042', '0123456789012', 'VCB 1234 5678 9012', 'Công ty Cổ phần Thử Nghiệm'];
const FACTS: MarketplaceLineFacts = { language: 'vi', settlementsToPost: 2, awaitingPayout: '1600000', feesAwaitingInvoice: '120000' };
// A careless caller's object: the same facts plus fields a settlement or an order has.
const tainted = { ...FACTS, platformName: PLANTED[0], shop: PLANTED[1], buyer: PLANTED[2], orderNo: PLANTED[3], account: PLANTED[4], bank: PLANTED[5], company: PLANTED[6] } as MarketplaceLineFacts;

const meter: AiMeter = { admit: async () => {}, record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });

afterEach(() => vi.unstubAllGlobals());

describe('what leaves for the model for the Sàn line (the bytes of the HTTP request)', () => {
  it('is the instructions and the three facts, with no planted platform, buyer, order, account or bank', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify(completion({ sentence: 'Có 2 kỳ đối soát đang chờ ghi sổ.' })), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const reader = new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
    const result = await withAiScope({ orgId: 'org', meter }, () => reader.marketplaceLineSentence(tainted));
    expect(result).toMatchObject({ kind: 'sentence' });
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    for (const secret of PLANTED) expect(body).not.toContain(secret);
    expect(body).not.toMatch(/Shopee|Lazada|Nguy|ORDER-|0123456789|VCB|Cổ phần/);
    // The request is the real one, and its messages are exactly the instructions and the facts.
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(marketplaceLineInstructions('vi'));
    expect(messages[1]?.content).toBe(`${marketplaceLineFactsText(FACTS)}\n\nWrite the sentence on what is waiting.`);
  });

  it('is refused, not repaired, when the model writes a figure the facts do not hold', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(completion({ sentence: 'Có 3 kỳ đối soát đang chờ ghi sổ.' })), { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const reader = new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
    expect(await withAiScope({ orgId: 'org', meter }, () => reader.marketplaceLineSentence(FACTS))).toEqual({ kind: 'none', code: 'FIGURES' });
  });
});
