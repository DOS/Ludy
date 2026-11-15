// SPDX-License-Identifier: AGPL-3.0-only
// The text "Gửi qua Zalo" puts in a customer's reply box (meetings integrations B5, #3169): only ticked lines, never an owner, no braces, never cut.
import { describe, expect, it } from 'vitest';
import { MEETING_ZALO_DRAFT_MAX, buildMeetingZaloDraft, hasNamePlaceholder, type MeetingZaloInput } from '../src/index.ts';

const labels = {
  heading: (title: string) => `Biên bản cuộc họp "${title}"`,
  summary: 'Tóm tắt:',
  decisions: 'Quyết định:',
  items: 'Việc cần làm:',
  due: (date: string) => `(hạn ${date})`,
};

const base: MeetingZaloInput = {
  title: 'Họp với anh Nam',
  summary: 'Hai bên thống nhất giá.\n\n\n\nGiao hàng tuần sau.',
  includeSummary: false,
  decisions: ['Chốt giá 10 triệu', 'Nội bộ: giảm 5% nếu khách chê'],
  tickedDecisions: [0],
  items: [
    { title: 'Gửi báo giá', whenDate: '2026-12-31' },
    { title: 'Đặt lịch giao', whenDate: null },
  ],
  tickedItems: [0, 1],
  labels,
};

describe('buildMeetingZaloDraft', () => {
  it('holds the title and only the ticked lines, with dates as day/month/year', () => {
    const d = buildMeetingZaloDraft(base);
    expect(d.text).toBe('Biên bản cuộc họp "Họp với anh Nam"\n\nQuyết định:\n- Chốt giá 10 triệu\n\nViệc cần làm:\n- Gửi báo giá (hạn 31/12/2026)\n- Đặt lịch giao');
    expect(d.text).not.toContain('giảm 5%');
    expect(d.hasLines).toBe(true);
    expect(d.fits).toBe(true);
    expect(d.length).toBe(d.text.length);
  });

  it('leaves the summary out unless it is ticked, and keeps its paragraphs when it is', () => {
    expect(buildMeetingZaloDraft(base).text).not.toContain('thống nhất');
    const withSummary = buildMeetingZaloDraft({ ...base, includeSummary: true, tickedDecisions: [], tickedItems: [] });
    expect(withSummary.text).toBe('Biên bản cuộc họp "Họp với anh Nam"\n\nTóm tắt:\nHai bên thống nhất giá.\n\nGiao hàng tuần sau.');
  });

  it('is empty when nothing is ticked: a title alone is not a message', () => {
    const d = buildMeetingZaloDraft({ ...base, tickedDecisions: [], tickedItems: [] });
    expect(d).toEqual({ text: '', hasLines: false, length: 0, fits: true });
  });

  it('has no owner in an item: the input has no field for one, and an extra field never reaches the text', () => {
    const sneaky = { title: 'Gửi báo giá', whenDate: null, who: 'Chị Lan (nhân viên)', whoUserId: 'x' } as { title: string; whenDate: string | null };
    const d = buildMeetingZaloDraft({ ...base, items: [sneaky], tickedItems: [0], tickedDecisions: [] });
    expect(d.text).toContain('Gửi báo giá');
    expect(d.text).not.toContain('Lan');
  });

  it('ignores a tick that names no line, and a repeated tick', () => {
    const d = buildMeetingZaloDraft({ ...base, tickedDecisions: [0, 0, 7, -1, 1.5], tickedItems: [] });
    expect(d.text.match(/Chốt giá/gu)).toHaveLength(1);
    expect(d.text).not.toContain('Nội bộ');
  });

  it('strips braces, control and invisible characters, so the name placeholder can never be written', () => {
    const d = buildMeetingZaloDraft({ ...base, decisions: ['Gửi {tên} bản\u200b tin\u0007 {{Tên}}'], tickedDecisions: [0], tickedItems: [], title: 'Họp {ten}' });
    expect(['{', '}', '\u200b', '\u0007'].some((c) => d.text.includes(c))).toBe(false);
    expect(hasNamePlaceholder(d.text)).toBe(false);
    expect(d.text).toContain('- Gửi tên bản tin Tên');
  });

  it('never cuts: a text over the limit says it does not fit and keeps every line', () => {
    const long = 'a'.repeat(900);
    const d = buildMeetingZaloDraft({ ...base, decisions: [long, long, long], tickedDecisions: [0, 1, 2], tickedItems: [] });
    expect(d.length).toBeGreaterThan(MEETING_ZALO_DRAFT_MAX);
    expect(d.fits).toBe(false);
    expect(d.text.match(/a{900}/gu)).toHaveLength(3);
    expect(buildMeetingZaloDraft({ ...base, decisions: [long, long, long], tickedDecisions: [0, 1, 2], tickedItems: [], max: 10_000 }).fits).toBe(true);
  });

  it('writes a date only when it is a day', () => {
    const d = buildMeetingZaloDraft({ ...base, items: [{ title: 'Một', whenDate: 'tuần sau' }], tickedItems: [0], tickedDecisions: [] });
    expect(d.text).toContain('- Một');
    expect(d.text).not.toContain('hạn');
  });
});
