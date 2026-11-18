// SPDX-License-Identifier: AGPL-3.0-only
// The coworker's line above "Invoices to pay" on the real path (#3113 S4c): the request body that leaves for the model is captured behind chatModel (a fake fetch), through metered() and generateText. The facts
// hold four numbers; a careless caller that adds a supplier name, an invoice number or a bank account to the object changes nothing on the wire, and the feature is booked under its own AI budget key.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxReader, supplierPayableLineFactsText, supplierPayableLineInstructions, withAiScope, type AiMeter, type SupplierPayableLineFacts } from '../src/index.ts';

const PLANTED = ['Công ty TNHH Giấy Canary', 'INV-2610-0042', '0123456789012', 'VCB 1234 5678 9012', 'Nguyễn Văn Chủ'];
const FACTS: SupplierPayableLineFacts = { language: 'vi', invoices: 3, total: '12500000', oldestDate: '2026-10-03', onChangedAccount: 1 };
const tainted = { ...FACTS, supplier: PLANTED[0], invoiceNumber: PLANTED[1], account: PLANTED[2], bank: PLANTED[3], holder: PLANTED[4] } as SupplierPayableLineFacts;

const booked: string[] = [];
const meter: AiMeter = { admit: async (call) => void booked.push(`${call.feature}:${call.module}`), record: async () => {} };
const completion = (content: unknown) => ({ id: 'x', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
const reader = () => new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });

afterEach(() => vi.unstubAllGlobals());

describe('what leaves for the model for the invoices-to-pay line (the bytes of the HTTP request)', () => {
  it('is the instructions and the four facts, with no planted supplier, invoice, account or holder, and is metered', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body ?? ''));
        return new Response(JSON.stringify(completion({ sentence: 'Có 3 hóa đơn cần chi, tổng 12.500.000 đồng, cũ nhất ngày 03/10/2026.' })), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    booked.length = 0;
    const result = await withAiScope({ orgId: 'org', meter }, () => reader().supplierPayableLineSentence(tainted));
    expect(result).toMatchObject({ kind: 'sentence' });
    expect(booked).toEqual(['finance.supplier_payable_line:finance']);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as string;
    for (const secret of PLANTED) expect(body).not.toContain(secret);
    const messages = (JSON.parse(body) as { messages: { role: string; content: string }[] }).messages;
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0]?.content).toBe(supplierPayableLineInstructions('vi'));
    expect(messages[1]?.content).toBe(`${supplierPayableLineFactsText(FACTS)}\n\nWrite the sentence on what is waiting.`);
  });

  it('is refused, not repaired, when the model writes a figure the facts do not hold', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(completion({ sentence: 'Có 4 hóa đơn cần chi.' })), { status: 200, headers: { 'content-type': 'application/json' } })));
    expect(await withAiScope({ orgId: 'org', meter }, () => reader().supplierPayableLineSentence(FACTS))).toEqual({ kind: 'none', code: 'FIGURES' });
  });
});
