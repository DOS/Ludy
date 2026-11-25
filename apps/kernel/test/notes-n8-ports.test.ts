// SPDX-License-Identifier: AGPL-3.0-only
// Kernel ModelPort adapter wrapper tests for notes.summary and notes.todo_suggest (#1677).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, AiMeterMissingError, withAiScope, type AiConfig, type AiMeter } from '@ludy/agent';
import { NOTE_AI_LIMITS, NOTE_AI_TIMEOUT_MS, NoteAiModelError } from '@ludy/agent/member-vy';
import { summaryModelPort } from '../src/member-vy-ports.ts';

const WHO = { orgId: 'org-1', memberUserId: 'user-1' };
const DEAD_CFG: AiConfig = { baseURL: 'http://127.0.0.1:9/v1', apiKey: null, model: 'test-model' };

async function withStubServer(
  handler: (reqBody: string) => Promise<{ status: number; body: string }> | { status: number; body: string },
  fn: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void Promise.resolve(handler(Buffer.concat(chunks).toString('utf8'))).then((out) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(out.status, { 'content-type': 'application/json', connection: 'close' });
        res.end(out.body);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

describe('summaryModelPort notes adapter wrapper (#1677)', () => {
  it('passes through AiMeterMissingError and AiBudgetExhaustedError directly', async () => {
    const port = summaryModelPort(DEAD_CFG, 500);
    await expect(
      port.generate(WHO, { feature: 'notes.summary', system: 'sys', user: 'secret' }),
    ).rejects.toBeInstanceOf(AiMeterMissingError);

    const meter: AiMeter = {
      admit: async () => {
        throw new AiBudgetExhaustedError('module', null);
      },
      record: async () => undefined,
    };
    await expect(
      withAiScope({ orgId: 'org-1', memberRunId: 'run-budget', meter }, () =>
        port.generate(WHO, { feature: 'notes.todo_suggest', system: 'sys', user: 'secret' }),
      ),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
  });

  it('maps provider errors to NoteAiModelError(failed) and logs only error.name without secrets', async () => {
    const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
    const logLines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a) => String(a)).join(' '));
      }),
    );
    try {
      await withStubServer(
        () => ({
          status: 500,
          body: JSON.stringify({
            error: {
              message:
                'Upstream failed echoing TOP_SECRET_SALARY_DATA and SECRET_ANSWER_FRAGMENT and SYSTEM_MARKER_PRIVATE',
            },
          }),
        }),
        async (baseURL) => {
          const port = summaryModelPort({ baseURL, apiKey: null, model: 'test-model' }, NOTE_AI_TIMEOUT_MS + 10_000);
          for (const feature of ['notes.summary', 'notes.todo_suggest'] as const) {
            const error = await withAiScope({ orgId: 'org-1', memberRunId: `run-${feature}`, meter }, () =>
              port.generate(WHO, {
                feature,
                system: 'SYSTEM_MARKER_PRIVATE',
                user: 'TOP_SECRET_SALARY_DATA',
              }),
            ).then(
              () => null,
              (e: unknown) => e as unknown,
            );
            expect(error).toBeInstanceOf(NoteAiModelError);
            expect((error as NoteAiModelError).kind).toBe('failed');
            expect((error as NoteAiModelError).message).toBe('NOTE_AI_FAILED');
            expect(String((error as Error).message) + String((error as Error).stack)).not.toContain('TOP_SECRET_SALARY_DATA');
            expect(String((error as Error).message) + String((error as Error).stack)).not.toContain('SECRET_ANSWER_FRAGMENT');
          }
        },
      );

      expect(logLines.length).toBeGreaterThanOrEqual(2);
      const joined = logLines.join('\n');
      expect(joined).toContain('AI_APICallError');
      expect(joined).not.toContain('SYSTEM_MARKER_PRIVATE');
      expect(joined).not.toContain('TOP_SECRET_SALARY_DATA');
      expect(joined).not.toContain('SECRET_ANSWER_FRAGMENT');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('maps aborted or timed-out model calls to NoteAiModelError(timeout) without leaking secrets', async () => {
    const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
    const logLines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a) => String(a)).join(' '));
      }),
    );
    try {
      await withStubServer(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { status: 200, body: '{}' };
        },
        async (baseURL) => {
          const port = summaryModelPort({ baseURL, apiKey: null, model: 'test-model' }, 40);
          const error = await withAiScope({ orgId: 'org-1', memberRunId: 'run-timeout', meter }, () =>
            port.generate(WHO, {
              feature: 'notes.summary',
              system: 'SYSTEM_MARKER_PRIVATE',
              user: 'TOP_SECRET_SALARY_DATA',
            }),
          ).then(
            () => null,
            (e: unknown) => e as unknown,
          );
          expect(error).toBeInstanceOf(NoteAiModelError);
          expect((error as NoteAiModelError).kind).toBe('timeout');
          expect((error as NoteAiModelError).message).toBe('NOTE_AI_TIMEOUT');
        },
      );
      expect(logLines.join('\n')).not.toContain('TOP_SECRET_SALARY_DATA');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('normalizes usage tokens to zero-defaulted numbers and logs nothing on success', async () => {
    const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
    const logLines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logLines.push(args.map((a) => String(a)).join(' '));
      }),
    );
    try {
      await withStubServer(
        () => ({
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
        }),
        async (baseURL) => {
          const port = summaryModelPort({ baseURL, apiKey: null, model: 'test-model' }, 2000);
          const out = await withAiScope({ orgId: 'org-1', memberRunId: 'run-ok', meter }, () =>
            port.generate(WHO, {
              feature: 'notes.summary',
              system: 'sys',
              user: 'ok note',
            }),
          );
          expect(out).toEqual({
            text: 'CANARY_SUMMARY_ANSWER_TEXT',
            usage: { inputTokens: 15, outputTokens: 7 },
          });
        },
      );
      expect(logLines).toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('fails closed before any meter or adapter call on invalid prompt bounds or timeoutMs', async () => {
    let meterCalls = 0;
    let serverCalls = 0;
    const meter: AiMeter = {
      admit: async () => {
        meterCalls += 1;
      },
      record: async () => undefined,
    };

    await withStubServer(
      () => {
        serverCalls += 1;
        return { status: 200, body: '{}' };
      },
      async (baseURL) => {
        const cfg: AiConfig = { baseURL, apiKey: null, model: 'test-model' };
        const validPort = summaryModelPort(cfg, 1000);

        const badPrompts: unknown[] = [
          { feature: 'notes.summary', system: '', user: 'valid user' },
          { feature: 'notes.summary', system: 'valid sys', user: '' },
          { feature: 'notes.summary', system: ['array'], user: 'valid user' },
          { feature: 'notes.summary', system: 'valid sys', user: 123 },
          { feature: 'notes.summary', system: 'x'.repeat(16_001), user: 'valid user' },
          { feature: 'notes.todo_suggest', system: 'valid sys', user: 'y'.repeat(NOTE_AI_LIMITS.maxNoteChars * 6 + 4_001) },
          Object.assign(['arr'], { feature: 'notes.summary', system: 'valid sys', user: 'valid user' }),
        ];

        for (const bad of badPrompts) {
          await expect(
            withAiScope({ orgId: 'org-1', memberRunId: 'run-bad-prompt', meter }, () =>
              validPort.generate(WHO, bad as Parameters<typeof validPort.generate>[1]),
            ),
          ).rejects.toMatchObject({ name: 'NoteAiModelError', kind: 'failed', message: 'NOTE_AI_FAILED' });
        }

        for (const badTimeout of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
          const badPort = summaryModelPort(cfg, badTimeout);
          await expect(
            withAiScope({ orgId: 'org-1', memberRunId: 'run-bad-timeout', meter }, () =>
              badPort.generate(WHO, { feature: 'notes.todo_suggest', system: 'valid sys', user: 'valid user' }),
            ),
          ).rejects.toMatchObject({ name: 'NoteAiModelError', kind: 'failed', message: 'NOTE_AI_FAILED' });
        }
      },
    );

    expect(meterCalls).toBe(0);
    expect(serverCalls).toBe(0);

    // JSON-escaped prompts for valid notes (< 40,000 raw chars expanding past 48,000 chars) are admitted cleanly.
    const heavyQuotedPrompt = JSON.stringify({ title: 'Escaped note', body: '"x"\n'.repeat(7000) });
    expect(heavyQuotedPrompt.length).toBeGreaterThan(48_000);
    await withStubServer(
      () => {
        serverCalls += 1;
        return {
          status: 200,
          body: JSON.stringify({
            id: 'chatcmpl-heavy',
            object: 'chat.completion',
            created: 1700000000,
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: '{"summary":"OK","bullets":[]}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          }),
        };
      },
      async (baseURL) => {
        const port = summaryModelPort({ baseURL, apiKey: null, model: 'test-model' }, 2000);
        const out = await withAiScope({ orgId: 'org-1', memberRunId: 'run-heavy-ok', meter }, () =>
          port.generate(WHO, { feature: 'notes.summary', system: 'sys', user: heavyQuotedPrompt }),
        );
        expect(out.text).toBe('{"summary":"OK","bullets":[]}');
      },
    );
    expect(meterCalls).toBe(1);
    expect(serverCalls).toBe(1);
  });

  it('destructures prompt.system and prompt.user once before validation so mutating or throwing getters cannot bypass bounds (#3522)', async () => {
    const sentPayloads: Array<{ system?: string; user?: string }> = [];
    let meterCalls = 0;
    let serverCalls = 0;
    const meter: AiMeter = {
      admit: async () => {
        meterCalls += 1;
      },
      record: async () => undefined,
    };

    await withStubServer(
      (reqBody) => {
        serverCalls += 1;
        const parsed = JSON.parse(reqBody) as {
          messages?: Array<{ role?: string; content?: string }>;
        };
        const system = parsed.messages?.find((m) => m.role === 'system')?.content;
        const user = parsed.messages?.find((m) => m.role === 'user')?.content;
        sentPayloads.push({
          ...(system !== undefined ? { system } : {}),
          ...(user !== undefined ? { user } : {}),
        });
        return {
          status: 200,
          body: JSON.stringify({
            id: 'chatcmpl-getter',
            object: 'chat.completion',
            created: 1700000000,
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: '{"summary":"OK","bullets":[]}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
        };
      },
      async (baseURL) => {
        const port = summaryModelPort({ baseURL, apiKey: null, model: 'test-model' }, 2000);

        // 1. Valid on first read, oversized/wrong-type on any subsequent read: must read once and forward read-1 values only.
        let systemReads = 0;
        let userReads = 0;
        const flipToBadPrompt = {
          feature: 'notes.summary' as const,
          get system(): string {
            systemReads += 1;
            return systemReads === 1 ? 'VALID_SYSTEM_ONCE' : 'x'.repeat(16_001);
          },
          get user(): string {
            userReads += 1;
            return userReads === 1 ? 'VALID_USER_ONCE' : ('y'.repeat(NOTE_AI_LIMITS.maxNoteChars * 6 + 4_001) as string);
          },
        };
        const ok = await withAiScope({ orgId: 'org-1', memberRunId: 'run-getter-once', meter }, () =>
          port.generate(WHO, flipToBadPrompt),
        );
        expect(ok.text).toBe('{"summary":"OK","bullets":[]}');
        expect(systemReads).toBe(1);
        expect(userReads).toBe(1);
        expect(sentPayloads).toEqual([{ system: 'VALID_SYSTEM_ONCE', user: 'VALID_USER_ONCE' }]);

        // 2. Invalid on first read, valid on second read: must read once and fail closed before meter or HTTP call.
        let badSystemReads = 0;
        let badUserReads = 0;
        const flipToValidPrompt = {
          feature: 'notes.todo_suggest' as const,
          get system(): string {
            badSystemReads += 1;
            return badSystemReads === 1 ? '' : 'VALID_ON_SECOND_READ';
          },
          get user(): string {
            badUserReads += 1;
            return badUserReads === 1 ? 'VALID_USER' : 'VALID_USER';
          },
        };
        await expect(
          withAiScope({ orgId: 'org-1', memberRunId: 'run-getter-bad', meter }, () =>
            port.generate(WHO, flipToValidPrompt),
          ),
        ).rejects.toMatchObject({ name: 'NoteAiModelError', kind: 'failed', message: 'NOTE_AI_FAILED' });
        expect(badSystemReads).toBe(1);
        expect(badUserReads).toBe(1);

        // 3. Throwing getters on prompt.system or prompt.user must fail closed across Note AI features without leaking error text.
        const throwingUserPrompt = {
          feature: 'notes.organize' as const,
          system: 'VALID_SYS',
          get user(): string {
            throw new Error('SECRET_GETTER_THROW_TEXT');
          },
        };
        const throwingSystemPrompt = {
          feature: 'notes.todo_plan' as const,
          get system(): string {
            throw new Error('SECRET_SYSTEM_THROW_TEXT');
          },
          user: 'VALID_USER',
        };
        for (const [runId, badPrompt] of [
          ['run-getter-throw-user', throwingUserPrompt],
          ['run-getter-throw-sys', throwingSystemPrompt],
        ] as const) {
          const err = await withAiScope({ orgId: 'org-1', memberRunId: runId, meter }, () =>
            port.generate(WHO, badPrompt),
          ).then(
            () => null,
            (e: unknown) => e,
          );
          expect(err).toBeInstanceOf(NoteAiModelError);
          expect((err as NoteAiModelError).message).toBe('NOTE_AI_FAILED');
          expect(String((err as Error).message) + String((err as Error).stack)).not.toContain('SECRET_GETTER_THROW_TEXT');
          expect(String((err as Error).message) + String((err as Error).stack)).not.toContain('SECRET_SYSTEM_THROW_TEXT');
        }
      },
    );

    expect(meterCalls).toBe(1);
    expect(serverCalls).toBe(1);
  });
});
