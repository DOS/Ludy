// SPDX-License-Identifier: AGPL-3.0-only
// The checks on the member's Vy writing the brief before a meeting (#3543): a sentence stays only when it cites numbered facts and every figure in it is written in a cited fact; at most three stay; an
// answer that is not the expected object is refused whole; and an instruction inside a fact is data (the prompt fences it; nothing here acts on it).
import { describe, expect, it } from 'vitest';
import {
  AI_FEATURES,
  AiBudgetExhaustedError,
  AiMeterMissingError,
  BriefModelError,
  generateMeetingBriefText,
  withAiScope,
  type AiConfig,
  type AiMeter,
} from '../src/index.ts';
import { bindPorts, noKnowledge } from '../src/member-vy/ports.ts';
import { BRIEF_LIMITS, BriefError, checkBrief, writeBrief } from '../src/member-vy/meetings-brief.ts';

const facts = [
  { text: 'Decision of the last meeting: Chốt giá gói kế toán 15.000.000 đồng' },
  { text: 'Open item: Gửi báo giá bản cuối (accepted as a task; owner: Lan; due: 2026-12-01; status: in progress)' },
  { text: 'Open deal for Công ty Á Châu: Gói kế toán năm (stage: Mới; amount: 15.000.000 VND; expected close: 2026-12-31)' },
  { text: 'Decision of the last meeting: Liên hệ khách qua nguoi.nhan@example.test' },
];
const answer = (sentences: unknown) => JSON.stringify({ sentences });

describe('checkBrief', () => {
  it('keeps a sentence that cites a fact and writes only figures that fact writes', () => {
    const out = checkBrief(answer([{ text: 'Buổi trước chốt giá 15.000.000 đồng.', cites: [1] }]), facts);
    expect(out).toEqual({ sentences: [{ text: 'Buổi trước chốt giá 15.000.000 đồng.', cites: [1] }], dropped: 0 });
  });

  it('drops a sentence with a number, an amount or a date no cited fact writes, one that cites nothing, and a link', () => {
    const out = checkBrief(
      answer([
        { text: 'Giá đã chốt là 20.000.000 đồng.', cites: [1] },
        { text: 'Hạn gửi báo giá là 2026-12-05.', cites: [2] },
        { text: 'Cơ hội dự kiến chốt ngày 2026-12-31.', cites: [1] },
        { text: 'Không dẫn nguồn.', cites: [] },
        { text: 'Xem thêm tại https://example.test/bao-gia.', cites: [2] },
        { text: 'Khách có một cơ hội đang mở ở giai đoạn Mới.', cites: [3] },
      ]),
      facts,
    );
    expect(out.sentences.map((s) => s.text)).toEqual(['Khách có một cơ hội đang mở ở giai đoạn Mới.']);
    expect(out.dropped).toBe(5);
  });

  it('keeps at most three sentences and counts the rest as dropped', () => {
    const many = [1, 2, 3, 1, 2].map((n, i) => ({ text: `Câu số ${['một', 'hai', 'ba', 'bốn', 'năm'][i]} nói về điều đã nêu.`, cites: [n] }));
    const out = checkBrief(answer(many), facts);
    expect(out.sentences).toHaveLength(BRIEF_LIMITS.sentences);
    expect(out.dropped).toBe(2);
  });

  it('keeps an address only when a cited fact writes it, and never a citation that names no fact', () => {
    const out = checkBrief(
      answer([
        { text: 'Liên hệ khách qua nguoi.nhan@example.test.', cites: [4] },
        { text: 'Liên hệ khách qua khac@example.test.', cites: [4] },
        { text: 'Có một việc còn mở.', cites: [99] },
      ]),
      facts,
    );
    expect(out.sentences.map((s) => s.cites)).toEqual([[4]]);
    expect(out.dropped).toBe(2);
  });

  it('drops a sentence over the bound of the contract (400 characters) instead of letting it through to fail the output check', () => {
    const long = `Buổi trước đã chốt giá gói kế toán 15.000.000 đồng ${'và còn nhiều điều khác cần nhắc lại cho khách '.repeat(8)}`;
    expect(long.length).toBeGreaterThan(BRIEF_LIMITS.sentenceChars);
    expect(long.length).toBeLessThan(600);
    expect(checkBrief(answer([{ text: long, cites: [1] }]), facts)).toEqual({ sentences: [], dropped: 1 });
    const ok = 'Buổi trước đã chốt giá gói kế toán 15.000.000 đồng.';
    expect(checkBrief(answer([{ text: ok, cites: [1] }]), facts).sentences).toHaveLength(1);
  });

  it('treats a date as one figure: the digits of a date are never an amount or a count, and a day written the other way round is another day', () => {
    const dated = [
      { text: 'Open deal for Công ty Á Châu: Gói kế toán năm (stage: Mới; amount: 500.000.000 VND; expected close: 2026-12-20)' },
      { text: 'Open item: Gửi báo giá (accepted as a task; due: 2026-12-01; status: to do)' },
    ];
    const verdict = (text: string, cites: number[]) => checkBrief(answer([{ text, cites }]), dated).sentences.length;
    // The 20 of the closing day is not an amount of 20, the 12 is not a count, and 2026 is not a quantity.
    expect(verdict('Khách đang cân nhắc gói 20 triệu.', [1])).toBe(0);
    expect(verdict('Còn 12 việc đang mở.', [2])).toBe(0);
    expect(verdict('Có 2026 khách hàng quan tâm.', [1])).toBe(0);
    // The same day, however it is written, is the fact's: ISO, day first with the year, day first without it.
    expect(verdict('Dự kiến chốt ngày 2026-12-20.', [1])).toBe(1);
    expect(verdict('Dự kiến chốt ngày 20/12/2026.', [1])).toBe(1);
    expect(verdict('Dự kiến chốt ngày 20/12.', [1])).toBe(1);
    expect(verdict('Hạn gửi báo giá là 1/12.', [2])).toBe(1);
    // A day and month swapped (12 January for 1 December), another year, or a day the facts do not write is refused.
    expect(verdict('Hạn gửi báo giá là 12/01.', [2])).toBe(0);
    expect(verdict('Hạn gửi báo giá là 01/12/2027.', [2])).toBe(0);
    expect(verdict('Hạn gửi báo giá là 2/12.', [2])).toBe(0);
    // The amount the fact writes still holds, next to its date.
    expect(verdict('Cơ hội 500.000.000 đồng, dự kiến chốt 20/12.', [1])).toBe(1);
  });

  it('refuses an answer that is not the expected object, and says nothing of an empty one', () => {
    expect(() => checkBrief('not json', facts)).toThrow(BriefError);
    expect(() => checkBrief('{"other": []}', facts)).toThrow(BriefError);
    expect(checkBrief(answer([]), facts)).toEqual({ sentences: [], dropped: 0 });
  });
});

const MODEL_CONFIG: AiConfig = { baseURL: 'http://127.0.0.1:9/v1', apiKey: null, model: 'test-model' };
const MODEL_PROMPT = { system: 'Chuẩn bị trước họp', user: 'Dữ liệu cuộc họp bí mật' };

describe('generateMeetingBriefText (meetings.brief_daily)', () => {
  it('routes meetings.brief_daily through the meetings module and daily feature key', async () => {
    expect(AI_FEATURES['meetings.brief_daily']).toBe('meetings');
    await expect(generateMeetingBriefText(MODEL_CONFIG, MODEL_PROMPT, 500, 'meetings.brief_daily')).rejects.toBeInstanceOf(AiMeterMissingError);

    const asked: Array<{ feature: string; module: string; memberRunId: string | null | undefined }> = [];
    const meter: AiMeter = {
      admit: async (call) => {
        asked.push({ feature: call.feature, module: call.module, memberRunId: call.memberRunId });
        throw new AiBudgetExhaustedError('module', null);
      },
      record: async () => undefined,
    };
    await expect(
      withAiScope({ orgId: 'org-1', memberRunId: 'run-daily', meter }, () =>
        generateMeetingBriefText(MODEL_CONFIG, MODEL_PROMPT, 500, 'meetings.brief_daily'),
      ),
    ).rejects.toBeInstanceOf(AiBudgetExhaustedError);
    expect(asked).toEqual([{ feature: 'meetings.brief_daily', module: 'meetings', memberRunId: 'run-daily' }]);
  });

  it('forwards feature meetings.brief_daily from writeBrief to the model port', async () => {
    const seenFeatures: Array<string | undefined> = [];
    const ports = bindPorts(
      { orgId: '11111111-1111-4111-8111-111111111111', memberUserId: '22222222-2222-4222-8222-222222222222' },
      {
        model: {
          generate: async (_who, prompt) => {
            seenFeatures.push(prompt.feature);
            return {
              text: JSON.stringify({ sentences: [{ text: 'Buổi trước chốt giá 15.000.000 đồng.', cites: [1] }] }),
              usage: { inputTokens: 12, outputTokens: 8 },
            };
          },
        },
        memory: { read: async () => [], write: async () => ({ id: 'm1' }), forget: async () => undefined },
        knowledge: noKnowledge,
      },
    );
    const out = await writeBrief({ facts: [{ kind: 'decision', text: facts[0]!.text }], feature: 'meetings.brief_daily' }, ports);
    expect(seenFeatures).toEqual(['meetings.brief_daily']);
    expect(out.answer.sentences).toEqual([{ text: 'Buổi trước chốt giá 15.000.000 đồng.', cites: [1] }]);
  });

  it('turns provider failures into a fixed BriefModelError code', async () => {
    const meter: AiMeter = { admit: async () => undefined, record: async () => undefined };
    const error = await withAiScope({ orgId: 'org-1', memberRunId: 'run-daily', meter }, () =>
      generateMeetingBriefText(MODEL_CONFIG, MODEL_PROMPT, 2000, 'meetings.brief_daily'),
    ).then(
      () => null,
      (e: unknown) => e as unknown,
    );
    expect(error).toBeInstanceOf(BriefModelError);
    expect((error as BriefModelError).message).toMatch(/^BRIEF_(FAILED|TIMEOUT)$/);
  });
});
