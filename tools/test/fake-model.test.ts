// SPDX-License-Identifier: AGPL-3.0-only
// The fake model of the AI end-to-end stack (e2e/fake-model, #3805): it answers every chat completion with the same fixed text, refuses another host name, and caps a request body by BYTES (a body of
// multi-byte text under the limit in characters but over it in bytes is cut). Started on a free port of the loopback address; no other network is touched.
import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXED_SUMMARY, startFakeModel, type FakeModel } from '../../e2e/fake-model/server.ts';

let fake: FakeModel;
beforeAll(async () => {
  fake = await startFakeModel({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await fake.close();
});

const chat = (body: string) => fetch(`${fake.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('the fake model', () => {
  it('answers a chat completion with the fixed summary and echoes the model name', async () => {
    const response = await chat(JSON.stringify({ model: 'fake-summary', messages: [{ role: 'user', content: 'Tóm tắt cuộc họp' }] }));
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { model: string; choices: { message: { content: string } }[] };
    expect(answer.model).toBe('fake-summary');
    expect(JSON.parse(answer.choices[0]!.message.content)).toEqual(FIXED_SUMMARY);
  });

  it('answers 400 to a body that is not JSON and 404 to any other path', async () => {
    expect((await chat('not json')).status).toBe(400);
    expect((await fetch(`${fake.url}/v1/models`)).status).toBe(404);
  });

  it('refuses a host name that is not its own', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: new URL(fake.url).port, path: '/healthz', headers: { host: 'api.openai.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it('counts the cap in bytes: multi-byte text under the limit in characters but over it in bytes is cut, and a small multi-byte body is taken', async () => {
    // 'é' is two bytes: 600 000 characters are 1 200 000 bytes, over the 1 000 000 byte cap, though under it as a character count.
    const big = JSON.stringify({ model: 'fake-summary', note: 'é'.repeat(600_000) });
    expect(big.length).toBeLessThan(1_000_000);
    expect(Buffer.byteLength(big)).toBeGreaterThan(1_000_000);
    await expect(chat(big)).rejects.toThrow();
    const small = JSON.stringify({ model: 'fake-summary', note: 'é'.repeat(1000) });
    expect((await chat(small)).status).toBe(200);
  });
});
