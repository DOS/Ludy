// SPDX-License-Identifier: AGPL-3.0-only
// The weekly mail of the week's meetings (#4967): four numbers and the link in both languages, "at least" when a limit cut them, nothing of a title or a decision, and merge data that is not exactly the template's is refused.
import { describe, expect, it } from 'vitest';
import { weeklyLines, weeklyMailTemplate } from '../src/weekly-mail.ts';

const ID = '0b7e7c5e-1d3a-4c7e-9d0a-6a1f3f0a9b11';
const input = (payload: Record<string, unknown>, subject: string | null = 'Chủ đề') => ({
  messageId: ID,
  subject,
  payload,
  publicUrl: 'https://ludy.test/',
  inboundAddress: null,
  brand: 'Ludy',
  execute: async () => undefined as never,
});
const base = { lang: 'vi', org: 'Công ty <A>', meetings: 3, decisions: 4, open: 5, overdue: 2, cut: false, path: '/o/acme/meetings?tool=digest' };

describe('the weekly mail', () => {
  it('says the four numbers and links the "this week" card in both languages', async () => {
    const vi = await weeklyMailTemplate.render(input(base));
    expect(vi?.text).toContain('3 cuộc họp có kết quả đã công bố');
    expect(vi?.text).toContain('4 quyết định đã công bố');
    expect(vi?.text).toContain('5 việc còn mở, 2 việc đã quá hạn');
    expect(vi?.text).toContain('https://ludy.test/o/acme/meetings?tool=digest');
    expect(vi?.html).toContain('href="https://ludy.test/o/acme/meetings?tool=digest"');
    // The org's name is escaped in the HTML.
    expect(vi?.html).toContain('Công ty &lt;A&gt;');
    expect(vi?.html).not.toContain('<A>');
    const en = await weeklyMailTemplate.render(input({ ...base, lang: 'en' }));
    expect(en?.text).toContain('3 meetings with a published result');
    expect(en?.text).toContain('4 decisions published');
    expect(en?.text).toContain('5 open action items, 2 overdue');
    const one = await weeklyMailTemplate.render(input({ ...base, lang: 'en', meetings: 1, decisions: 1, open: 1, overdue: 0 }));
    expect(one?.text).toContain('1 meeting with a published result');
    expect(one?.text).toContain('1 decision published');
    expect(one?.text).toContain('1 open action item\n');
    expect(one?.text).not.toContain('overdue');
  });

  it('says "at least" when a limit cut the numbers', () => {
    expect(weeklyLines({ ...base, lang: 'vi', cut: true } as never)).toEqual(['Ít nhất 3 cuộc họp có kết quả đã công bố', 'Ít nhất 4 quyết định đã công bố', 'Ít nhất 5 việc còn mở, 2 việc đã quá hạn']);
    expect(weeklyLines({ ...base, lang: 'en', cut: true } as never)[0]).toBe('At least 3 meetings with a published result');
  });

  it('adds the tracked-word line only when the merge data holds the number, "999+" at the most, and refuses a number past the limit or a word (#5019)', async () => {
    // No number, no line: an org with no tracked word, or none that came up, gets the three lines it always had.
    expect(weeklyLines({ ...base, lang: 'vi' } as never)).toHaveLength(3);
    expect(weeklyLines({ ...base, lang: 'vi', tracked: 12 } as never)[3]).toBe('Từ khóa theo dõi của tổ chức xuất hiện 12 lần');
    expect(weeklyLines({ ...base, lang: 'en', tracked: 1 } as never)[3]).toBe("The organization's tracked words came up 1 time");
    expect(weeklyLines({ ...base, lang: 'en', tracked: 999 } as never)[3]).toBe("The organization's tracked words came up 999+ times");
    const mail = await weeklyMailTemplate.render(input({ ...base, tracked: 7 }));
    expect(mail?.text).toContain('Từ khóa theo dõi của tổ chức xuất hiện 7 lần');
    expect(mail?.html).toContain('<li>Từ khóa theo dõi của tổ chức xuất hiện 7 lần</li>');
    await expect(weeklyMailTemplate.render(input({ ...base, tracked: 1000 }))).rejects.toThrow();
    await expect(weeklyMailTemplate.render(input({ ...base, tracked: 0 }))).rejects.toThrow();
    await expect(weeklyMailTemplate.render(input({ ...base, tracked: 'giá' }))).rejects.toThrow();
    await expect(weeklyMailTemplate.render(input({ ...base, tracked: 3, term: 'giá' }))).rejects.toThrow();
  });

  it('refuses merge data with a key it does not use (a title, a decision) or a link that is not the "this week" card', async () => {
    await expect(weeklyMailTemplate.render(input({ ...base, title: 'Họp lương' }))).rejects.toThrow();
    await expect(weeklyMailTemplate.render(input({ ...base, decisions_text: ['Chốt giá'] }))).rejects.toThrow();
    await expect(weeklyMailTemplate.render(input({ ...base, path: 'https://evil.test/' }))).rejects.toThrow();
    await expect(weeklyMailTemplate.render(input({ ...base, path: '/o/acme/meetings' }))).rejects.toThrow();
    await expect(weeklyMailTemplate.render(input({ ...base, path: `/o/acme/meetings/${ID}?tool=digest` }))).rejects.toThrow();
    // A number past the card's own limits, or a week with no meeting, is not a mail.
    await expect(weeklyMailTemplate.render(input({ ...base, decisions: 31 }))).rejects.toThrow();
    await expect(weeklyMailTemplate.render(input({ ...base, meetings: 0 }))).rejects.toThrow();
    // No subject, no mail.
    expect(await weeklyMailTemplate.render(input(base, null))).toBeNull();
  });
});
