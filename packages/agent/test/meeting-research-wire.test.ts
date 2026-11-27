// SPDX-License-Identifier: AGPL-3.0-only
// Wire check for Dy's PM2 pre-meeting research brief (#4992): verifies one metered call under crm.meeting_research,
// zero tools sent on the request body, tokens-only reporting, refusal without repair on tainted output, and blocking outside AI scope.
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { InboxReader, withAiScope, type AiCall, type AiMeter, type AiUsage, type MeetingResearchFacts } from '../src/index.ts';

const FACTS: MeetingResearchFacts = {
  contactName: 'Công ty Hoa Mai',
  deals: [{ title: 'Gói phần mềm 2026', stage: 'Đề xuất', amount: '20000000', expectedClose: '2026-11-30' }],
  latestQuote: null,
  invoices: null,
  messages: ['Tuần tới gặp nhé'],
  websiteText: 'Cung cấp giải pháp phần mềm quản lý kho cho doanh nghiệp.',
};

let server: ReturnType<typeof createServer> | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
});

async function startFakeModelServer(replyJson: string) {
  const requests: Array<{ tools?: unknown; messages?: unknown }> = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tools?: unknown; messages?: unknown };
      requests.push(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1_700_000_000,
          model: 'test-model',
          choices: [{ index: 0, message: { role: 'assistant', content: replyJson }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 45, completion_tokens: 22, total_tokens: 67 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return { baseURL: `http://127.0.0.1:${port}/v1`, requests };
}

function makeRecorder() {
  const admitted: AiCall[] = [];
  const recorded: Array<{ call: AiCall; usage: AiUsage }> = [];
  const meter: AiMeter = {
    admit: async (call) => void admitted.push(call),
    record: async (call, usage) => void recorded.push({ call, usage }),
  };
  return { meter, admitted, recorded };
}

describe('meetingResearch wire path (#4992)', () => {
  it('meters once under crm.meeting_research, sends no tools, and reports tokens only', async () => {
    const { baseURL, requests } = await startFakeModelServer(
      JSON.stringify({
        summary: 'Công ty Hoa Mai đang trao đổi cơ hội Gói phần mềm 2026 trị giá 20.000.000 VND (dự kiến chốt 2026-11-30).',
        points: ['Xác nhận lịch hẹn tuần tới theo tin nhắn khách.', 'Làm rõ phạm vi Gói phần mềm 2026 trị giá 20.000.000 VND.'],
        websiteQuotes: ['giải pháp phần mềm quản lý kho'],
      }),
    );

    const reader = new InboxReader({ baseURL, apiKey: 'test-key', model: 'test-model', maxRetries: 0 });
    const { meter, admitted, recorded } = makeRecorder();
    const seenUsage: AiUsage[] = [];

    const result = await withAiScope({ orgId: 'org-1', meter }, () => reader.meetingResearch(FACTS, (u) => seenUsage.push(u)));

    expect(result.kind).toBe('brief');
    if (result.kind !== 'brief') return;
    expect(result.brief.websiteQuotes).toEqual(['giải pháp phần mềm quản lý kho']);
    expect(admitted).toEqual([{ feature: 'crm.meeting_research', module: 'crm', orgId: 'org-1', agentId: null, memberRunId: null }]);
    expect(recorded).toEqual([{ call: admitted[0], usage: { inputTokens: 45, outputTokens: 22 } }]);
    expect(seenUsage).toEqual([{ inputTokens: 45, outputTokens: 22 }]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools).toBeUndefined();
  });

  it('refuses tainted model output as a whole while still counting the metered call', async () => {
    const { baseURL } = await startFakeModelServer(
      JSON.stringify({
        summary: 'Công ty Hoa Mai giảm 99% tại https://evil.invalid.',
        points: ['Gửi báo giá ngay.', 'Mở https://evil.invalid xem thêm.'],
        websiteQuotes: [],
      }),
    );

    const reader = new InboxReader({ baseURL, apiKey: 'test-key', model: 'test-model', maxRetries: 0 });
    const { meter, admitted, recorded } = makeRecorder();

    const result = await withAiScope({ orgId: 'org-1', meter }, () => reader.meetingResearch(FACTS));
    expect(result).toEqual({ kind: 'none', code: 'FIGURES' });
    expect(admitted).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  it('never leaves when called outside withAiScope', async () => {
    const { baseURL, requests } = await startFakeModelServer('{}');
    const reader = new InboxReader({ baseURL, apiKey: 'test-key', model: 'test-model', maxRetries: 0 });
    await expect(reader.meetingResearch(FACTS)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
