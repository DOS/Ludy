// SPDX-License-Identifier: AGPL-3.0-only
// The seller's bank account in the model's answer (#2426), against a local fake endpoint through the real AI SDK client: the schema asked for lists it as required (so a strict endpoint takes it), an answer
// that leaves it out is read as no account (never a refusal of the whole invoice), and an account is kept only as a plain copy of the PDF's text.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvoiceExtractor, withAiScope, type AiMeter } from '../src/index.ts';

let server: Server;
let baseURL: string;
const requests: string[] = [];
let answer: Record<string, unknown> = {};

const READING = {
  isInvoice: true,
  series: 'C26TAB',
  number: '00001234',
  issueDate: '2026-09-15',
  currency: 'VND',
  seller: { name: 'Người bán', taxCode: '0101234564', address: null },
  buyer: { name: 'Người mua', taxCode: null, address: null },
  lines: [{ description: 'Dịch vụ', unit: null, quantity: '1', unitPrice: '250000', amount: '250000', vatRate: '10%', isDiscount: false }],
  subtotal: '250000',
  vatTotal: '25000',
  total: '275000',
};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 1,
          model: 'test',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(answer) }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const meter: AiMeter = { admit: async () => {}, record: async () => {} };
const read = (text: string) => withAiScope({ orgId: 'org-1', meter }, () => new InvoiceExtractor({ baseURL, apiKey: 'test-key', model: 'test', maxRetries: 0 }).fromText(text));

describe('seller.bankAccount in the model\'s answer', () => {
  it('is listed as required in the schema the model is asked for', async () => {
    requests.length = 0;
    answer = { ...READING, seller: { ...READING.seller, bankAccount: null } };
    await read('Hóa đơn');
    const asked = JSON.parse(requests[0] ?? '{}') as { response_format?: { json_schema?: { schema?: { properties?: { seller?: { required?: string[]; properties?: Record<string, unknown> } } } } } };
    const seller = asked.response_format?.json_schema?.schema?.properties?.seller;
    expect(seller?.properties).toHaveProperty('bankAccount');
    expect(seller?.required).toContain('bankAccount');
  });

  it('left out by the model is no account, and the invoice is still read', async () => {
    answer = { ...READING };
    const parsed = await read('Hóa đơn số 00001234');
    expect(parsed?.number).toBe('1234');
    expect(parsed?.seller).not.toHaveProperty('bankAccount');
  });

  it('is kept when it is a plain copy of the PDF text, and dropped when the text does not hold it', async () => {
    answer = { ...READING, seller: { ...READING.seller, bankAccount: '501122334455' } };
    expect((await read('Số tài khoản: 5011.2233.4455 tại Vietcombank'))?.seller.bankAccount).toBe('501122334455');
    expect((await read('Hóa đơn không in số tài khoản'))?.seller).not.toHaveProperty('bankAccount');
  });
});
