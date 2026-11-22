// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's note on a pending marketplace proposal on the real path (#4389): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText.
// The facts name the things the proposal has and the classified kinds, never an amount or an account code; a careless caller that adds a platform name, a party, a date or an id to the object changes nothing on the wire,
// and the feature is booked under its own AI budget key in the finance group.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AI_FEATURES, InboxReader, marketplaceProposalNoteFactsText, marketplaceProposalNoteInstructions, withAiScope, type AiMeter, type MarketplaceProposalNoteFacts } from '../src/index.ts';

const PLANTED = ['Gian hàng Cửa Hàng Canary', 'Shopee', '0101234564', 'CRMDV000000123', '99999999', '2026-10-15', 'MK000123456'];
const FACTS: MarketplaceProposalNoteFacts = { language: 'vi', kind: 'payout', figures: { received: '304000', fees: '28000', taxWithheld: '3000' }, lineKinds: [] };
const tainted = { ...FACTS, platform: PLANTED[1], platformName: PLANTED[0], taxCode: PLANTED[2], voucher: PLANTED[3], legalEntityId: PLANTED[4], periodFrom: PLANTED[5], orderNo: PLANTED[6] } as unknown as MarketplaceProposalNoteFacts;

const booked: string[] = [];
const meter: AiMeter = { admit: async (call) => void booked.push(`${call.feature}:${call.module}`), record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
const reader = () => new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
const answer = (note: string) => vi.fn(async () => new Response(JSON.stringify(completion({ note })), { status: 200, headers: { 'content-type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('what leaves for the model for the proposal note (the bytes of the HTTP request)', () => {
  it('is the instructions and the facts, with nothing planted, and is metered under the finance key', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify(completion({ note: 'Sàn giữ lại phí và thuế trước khi chuyển tiền; xem các con số và dòng bút toán bên cạnh.' })), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    booked.length = 0;
    const result = await withAiScope({ orgId: 'org', meter }, () => reader().marketplaceProposalNote(tainted));
    expect(result).toMatchObject({ kind: 'note' });
    expect(AI_FEATURES['finance.marketplace_proposal_note']).toBe('finance');
    expect(booked).toEqual(['finance.marketplace_proposal_note:finance']);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    for (const secret of PLANTED) expect(body).not.toContain(secret);
    // No amount and no account code leaves: not as stored, not as grouped, not in any digit at all in what the facts add.
    for (const figure of ['304000', '304.000', '28000', '28.000', '3000', '3.000', '331', '3331', '1121']) expect(body).not.toContain(figure);
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(marketplaceProposalNoteInstructions('vi'));
    expect(messages[1]?.content).toBe(`${marketplaceProposalNoteFactsText(FACTS)}\n\nWrite the text.`);
  });

  it('refuses a text with any figure in it, and says none stands', async () => {
    vi.stubGlobal('fetch', answer('Sàn giữ lại phí 9.999.000 đồng.'));
    expect(await withAiScope({ orgId: 'org', meter }, () => reader().marketplaceProposalNote(FACTS))).toEqual({ kind: 'none', code: 'REFUSED' });
  });
});
