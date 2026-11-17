// SPDX-License-Identifier: AGPL-3.0-only
// The checks on the member's Vy writing the brief before a meeting (#3543): a sentence stays only when it cites numbered facts and every figure in it is written in a cited fact; at most three stay; an
// answer that is not the expected object is refused whole; and an instruction inside a fact is data (the prompt fences it; nothing here acts on it).
import { describe, expect, it } from 'vitest';
import { BRIEF_LIMITS, BriefError, checkBrief } from '../src/member-vy/meetings-brief.ts';

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

  it('refuses an answer that is not the expected object, and says nothing of an empty one', () => {
    expect(() => checkBrief('not json', facts)).toThrow(BriefError);
    expect(() => checkBrief('{"other": []}', facts)).toThrow(BriefError);
    expect(checkBrief(answer([]), facts)).toEqual({ sentences: [], dropped: 0 });
  });
});
