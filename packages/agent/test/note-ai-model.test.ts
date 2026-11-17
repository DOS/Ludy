// SPDX-License-Identifier: AGPL-3.0-only
// Thin metered model adapter tests for notes.summary and notes.todo_suggest (#1677).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import {
  AI_FEATURES,
  AiBudgetExhaustedError,
  AiMeterMissingError,
  generateNoteSummaryText,
  generateTodoSuggestText,
  withAiScope,
  type AiConfig,
  type AiMeter,
} from '../src/index.ts';

const CONFIG: AiConfig = { baseURL: 'http://127.0.0.1:9/v1', apiKey: null, model: 'test-model' };
const PROMPT = {
  system: 'SYSTEM_MARKER_PRIVATE summarize carefully',
  user: 'Secret private note content TOP_SECRET_SALARY_DATA',
};

async function withStubServer(
  handler: (reqBody: string) => { status: number; body: string },
  fn: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const out = handler(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('note-ai-model adapters (#1677)', () => {
  it('registers both notes meter keys in the notes module', () => {
    expect(AI_FEATURES['notes.summary']).toBe('notes');
    expect(AI_FEATURES['notes.todo_suggest']).toBe('notes');
  });

  it('refuses outside an AI scope before any request', async () => {
    await expect(generateNoteSummaryText(CONFIG, PROMPT, AbortSignal.timeout(500))).rejects.toBeInstanceOf(
      AiMeterMissingError,
    );
    await expect(generateTodoSuggestText(CONFIG, PROMPT, AbortSignal.timeout(500))).rejects.toBeInstanceOf(
      AiMeterMissingError,
    );
  });

  it('checks the meter under notes.summary and notes.todo_suggest with memberRunId', async () => {
    const asked: Array<{ feature: string; module: string; memberRunId: string | null | undefined }> = [];
    const meter: AiMeter = {
      admit: async (call) => {
        asked.push({ feature: call.feature, module: call.module, memberRunId: call.memberRunId });
        throw new AiBudgetExhaustedError('module', null);
      },
      record: async () => undefined,
    };
    await expect(
      withAiScope({ orgId: 'org-1', memberRunId: 'run-sum', meter }, () =>
        generateNoteSummaryText(CONFIG, PROMPT, AbortSignal.timeout(500)),
      ),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    await expect(
      withAiScope({ orgId: 'org-1', memberRunId: 'run-todo', meter }, () =>
        generateTodoSuggestText(CONFIG, PROMPT, AbortSignal.timeout(500)),
      ),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(asked).toEqual([
      { feature: 'notes.summary', module: 'notes', memberRunId: 'run-sum' },
      { feature: 'notes.todo_suggest', module: 'notes', memberRunId: 'run-todo' },
    ]);
  });

  it('calls the OpenAI-compatible endpoint with zero tools, bounded tokens, abort support, and zero logs', async () => {
    const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
    const seenRequests: Array<Record<string, unknown>> = [];
    const logLines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a) => String(a)).join(' '));
      }),
    );
    try {
      await withStubServer(
        (reqBody) => {
          seenRequests.push(JSON.parse(reqBody) as Record<string, unknown>);
          return {
            status: 200,
            body: JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              created: 1700000000,
              model: 'test-model',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'CANARY_SUMMARY_ANSWER_TEXT' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 15, completion_tokens: 7, total_tokens: 22 },
            }),
          };
        },
        async (baseURL) => {
          const cfg: AiConfig = { baseURL, apiKey: null, model: 'test-model' };
          const summaryOut = await withAiScope({ orgId: 'org-1', memberRunId: 'run-ok-1', meter }, () =>
            generateNoteSummaryText(cfg, PROMPT, AbortSignal.timeout(2000)),
          );
          expect(summaryOut.text).toBe('CANARY_SUMMARY_ANSWER_TEXT');
          expect(summaryOut.usage.inputTokens).toBe(15);
          expect(summaryOut.usage.outputTokens).toBe(7);

          const todoOut = await withAiScope({ orgId: 'org-1', memberRunId: 'run-ok-2', meter }, () =>
            generateTodoSuggestText(cfg, PROMPT, AbortSignal.timeout(2000)),
          );
          expect(todoOut.text).toBe('CANARY_SUMMARY_ANSWER_TEXT');

          await expect(
            withAiScope({ orgId: 'org-1', memberRunId: 'run-abort', meter }, () =>
              generateNoteSummaryText(cfg, PROMPT, AbortSignal.abort()),
            ),
          ).rejects.toThrow();
        },
      );
      expect(seenRequests).toHaveLength(2);
      for (const req of seenRequests) {
        expect(req.tools).toBeUndefined();
        expect(req.tool_choice).toBeUndefined();
        expect(req.max_tokens).toBe(2000);
        expect(Array.isArray(req.messages)).toBe(true);
        const msgs = req.messages as Array<{ role?: unknown; content?: unknown }>;
        expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
        for (const msg of msgs) {
          expect(typeof msg.content).toBe('string');
        }
      }
      expect(logLines).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
