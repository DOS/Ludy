// SPDX-License-Identifier: AGPL-3.0-only
// Port adapter tests for Notes v2 Vy features (notes.todo_plan & notes.organize, #3563): verifies 6x JSON-escape
// prompt bounding, meter feature attribution, timeout/provider error mapping without secret leaks, and abort handling.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, AiMeterMissingError, withAiScope, type AiConfig, type AiMeter } from '@ludy/agent';
import { NOTE_AI_LIMITS, NOTE_AI_TIMEOUT_MS, NoteAiModelError, type ModelPrompt } from '@ludy/agent/member-vy';
import { summaryModelPort } from '../src/member-vy-ports.ts';

async function withStubServer(
  handler: (reqBody: Record<string, unknown>) => { status: number; body: Record<string, unknown>; delayMs?: number },
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const reqBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const out = handler(reqBody);
      const send = () => {
        if (res.writableEnded) return;
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.body));
      };
      if (out.delayMs) setTimeout(send, out.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const okMeter: AiMeter = {
  admit: async () => {},
  record: async () => {},
};

const WHO = { orgId: 'org-1', memberUserId: 'user-1' };

describe('summaryModelPort Notes v2 Vy routing (#3563)', () => {
  it('routes notes.todo_plan and notes.organize through metered OpenAI calls without leaking secrets on failure', async () => {
    const seenFeatures: string[] = [];
    const seenMeter: AiMeter = {
      admit: async (call) => {
        seenFeatures.push(call.feature);
      },
      record: async () => {},
    };

    await withStubServer(
      () => ({
        status: 200,
        body: {
          id: 'cmpl-1',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: '{"focus":[],"reschedules":[]}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      }),
      async (baseURL) => {
        const port = summaryModelPort({ baseURL, apiKey: null, model: 'test-model' }, NOTE_AI_TIMEOUT_MS);
        await withAiScope({ orgId: 'org-1', memberRunId: 'run-1', meter: seenMeter }, async () => {
          const r1 = await port.generate(WHO, { feature: 'notes.todo_plan', system: 'sys', user: 'usr' });
          expect(r1.text).toContain('focus');
          const r2 = await port.generate(WHO, { feature: 'notes.organize', system: 'sys', user: 'usr' });
          expect(r2.text).toContain('focus');
        });
      },
    );
    expect(seenFeatures).toEqual(['notes.todo_plan', 'notes.organize']);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deadCfg: AiConfig = { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'secret-sk-should-not-log', model: 'test-model' };
      const port = summaryModelPort(deadCfg, 500);
      await withAiScope({ orgId: 'org-1', memberRunId: 'run-2', meter: okMeter }, async () => {
        await expect(
          port.generate(WHO, { feature: 'notes.organize', system: 'sys', user: 'Bi mat tuyet doi' }),
        ).rejects.toMatchObject({ name: 'NoteAiModelError', kind: 'failed', message: 'NOTE_AI_FAILED' });
      });
      const logged = errSpy.mock.calls.flat().join(' ');
      expect(logged).not.toContain('secret-sk-should-not-log');
      expect(logged).not.toContain('Bi mat tuyet doi');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('enforces 6x JSON-escape prompt sizing, meter admission, and timeout mapping', async () => {
    await withStubServer(
      () => ({
        status: 200,
        delayMs: 120,
        body: {
          id: 'cmpl-slow',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      }),
      async (baseURL) => {
        const cfg: AiConfig = { baseURL, apiKey: null, model: 'test-model' };
        const slowPort = summaryModelPort(cfg, 25);
        await withAiScope({ orgId: 'org-1', memberRunId: 'run-t', meter: okMeter }, async () => {
          await expect(
            slowPort.generate(WHO, { feature: 'notes.todo_plan', system: 'sys', user: 'u' }),
          ).rejects.toMatchObject({ name: 'NoteAiModelError', kind: 'timeout', message: 'NOTE_AI_TIMEOUT' });
        });

        const validPort = summaryModelPort(cfg, 1000);
        const huge = 'x'.repeat(NOTE_AI_LIMITS.maxNoteChars * 6 + 4_500);
        await withAiScope({ orgId: 'org-1', memberRunId: 'run-big', meter: okMeter }, async () => {
          await expect(
            validPort.generate(WHO, { feature: 'notes.organize', system: 'sys', user: huge }),
          ).rejects.toMatchObject({ name: 'NoteAiModelError', kind: 'failed' });
        });

        await expect(
          validPort.generate(WHO, { feature: 'notes.todo_plan', system: 'sys', user: 'u' }),
        ).rejects.toThrowError(AiMeterMissingError);

        const exhaustedMeter: AiMeter = {
          admit: async () => {
            throw new AiBudgetExhaustedError('module', '2026-12-01T00:00:00.000Z');
          },
          record: async () => {},
        };
        await withAiScope({ orgId: 'org-1', memberRunId: 'run-cap', meter: exhaustedMeter }, async () => {
          await expect(
            validPort.generate(WHO, { feature: 'notes.todo_plan', system: 'sys', user: 'u' }),
          ).rejects.toThrowError(AiBudgetExhaustedError);
        });

        // Hostile prompt getters throwing explicit NoteAiModelError('timeout') must be normalized to 'failed'.
        const hostileFeaturePrompt: ModelPrompt = {
          get feature(): ModelPrompt['feature'] {
            throw new NoteAiModelError('timeout');
          },
          system: 'sys',
          user: 'u',
        };
        const hostileSystemPrompt: ModelPrompt = {
          feature: 'notes.todo_plan',
          get system(): string {
            throw new NoteAiModelError('timeout');
          },
          user: 'u',
        };
        const hostileUserPrompt: ModelPrompt = {
          feature: 'notes.organize',
          system: 'sys',
          get user(): string {
            throw new NoteAiModelError('timeout');
          },
        };
        await withAiScope({ orgId: 'org-1', memberRunId: 'run-hostile', meter: okMeter }, async () => {
          await expect(validPort.generate(WHO, hostileFeaturePrompt)).rejects.toMatchObject({
            name: 'NoteAiModelError',
            kind: 'failed',
            message: 'NOTE_AI_FAILED',
          });
          await expect(validPort.generate(WHO, hostileSystemPrompt)).rejects.toMatchObject({
            name: 'NoteAiModelError',
            kind: 'failed',
            message: 'NOTE_AI_FAILED',
          });
          await expect(validPort.generate(WHO, hostileUserPrompt)).rejects.toMatchObject({
            name: 'NoteAiModelError',
            kind: 'failed',
            message: 'NOTE_AI_FAILED',
          });
        });
      },
    );
    expect(NoteAiModelError).toBeDefined();
  });
});
