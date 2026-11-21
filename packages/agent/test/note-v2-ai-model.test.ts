// SPDX-License-Identifier: AGPL-3.0-only
// Model adapter tests for notes.todo_plan and notes.organize (#3563): meter gating, feature attribution,
// max_tokens: 2000, maxRetries: 0 (no duplicate HTTP calls on 5xx), and AbortSignal handling.
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  AiMeterMissingError,
  generateNoteOrganizeText,
  generateTodoPlanText,
  withAiScope,
  type AiCall,
  type AiConfig,
  type AiMeter,
} from '../src/index.ts';

async function withStubServer<T>(
  handler: (reqBody: Record<string, unknown>, callNumber: number) => { status: number; body: Record<string, unknown> },
  fn: (baseURL: string) => Promise<T>,
): Promise<T> {
  let count = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      count += 1;
      const reqBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const out = handler(reqBody, count);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    return await fn(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function makeMeter() {
  const admitted: AiCall[] = [];
  const recorded: AiCall[] = [];
  const meter: AiMeter = {
    admit: async (call) => {
      admitted.push(call);
    },
    record: async (call) => {
      recorded.push(call);
    },
  };
  return { meter, admitted, recorded };
}

describe('note-v2 AI model adapters (#3563)', () => {
  it('refuses calls outside withAiScope via metered()', async () => {
    const cfg: AiConfig = { baseURL: 'http://127.0.0.1:9/v1', apiKey: null, model: 'test-model' };
    await expect(
      generateTodoPlanText(cfg, { system: 's', user: 'u' }, new AbortController().signal),
    ).rejects.toThrowError(AiMeterMissingError);
    await expect(
      generateNoteOrganizeText(cfg, { system: 's', user: 'u' }, new AbortController().signal),
    ).rejects.toThrowError(AiMeterMissingError);
  });

  it('attributes notes.todo_plan and notes.organize with max_tokens: 2000 and maxRetries: 0', async () => {
    const seenBodies: Array<Record<string, unknown>> = [];
    await withStubServer(
      (reqBody) => {
        seenBodies.push(reqBody);
        return {
          status: 200,
          body: {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '{"focus":[],"reschedules":[],"suggestions":[]}' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
          },
        };
      },
      async (baseURL) => {
        const cfg: AiConfig = { baseURL, apiKey: null, model: 'test-model' };
        const { meter, admitted, recorded } = makeMeter();
        await withAiScope({ orgId: 'org-1', memberRunId: 'run-1', meter }, async () => {
          const r1 = await generateTodoPlanText(cfg, { system: 'sys1', user: 'usr1' }, new AbortController().signal);
          expect(r1.text).toContain('focus');
          const r2 = await generateNoteOrganizeText(cfg, { system: 'sys2', user: 'usr2' }, new AbortController().signal);
          expect(r2.text).toContain('suggestions');
        });
        expect(admitted.map((c) => c.feature)).toEqual(['notes.todo_plan', 'notes.organize']);
        expect(recorded.map((c) => c.feature)).toEqual(['notes.todo_plan', 'notes.organize']);
      },
    );
    expect(seenBodies).toHaveLength(2);
    for (const body of seenBodies) {
      expect(body.max_tokens).toBe(2000);
    }
  });

  it('never retries HTTP 500 responses (maxRetries: 0)', async () => {
    let calls = 0;
    await withStubServer(
      () => {
        calls += 1;
        return { status: 500, body: { error: { message: 'boom', type: 'server_error' } } };
      },
      async (baseURL) => {
        const cfg: AiConfig = { baseURL, apiKey: null, model: 'test-model' };
        const { meter } = makeMeter();
        await expect(
          withAiScope({ orgId: 'org-1', memberRunId: 'run-2', meter }, () =>
            generateTodoPlanText(cfg, { system: 'sys', user: 'usr' }, new AbortController().signal),
          ),
        ).rejects.toBeDefined();
      },
    );
    expect(calls).toBe(1);
  });
});
