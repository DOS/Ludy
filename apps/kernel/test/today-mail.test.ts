// SPDX-License-Identifier: AGPL-3.0-only
// The daily "Hôm nay cần bạn" mail (#2406): what it says in both languages, counts and links only, the links it builds from app
// paths only, and the merge data it refuses.
import { describe, expect, it } from 'vitest';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { renderTodayMail } from '../src/today-mail.ts';

const base = {
  org: 'Cửa hàng <A>',
  language: 'vi',
  day: '2026-11-03',
  counts: { flags: 2, blocking: 1, proposals: 12, messages: 3, deadlines: 2 },
  home: '/o/cua-hang-a/overview',
  settings: '/o/cua-hang-a/notifications?todayMail=off',
};
const render = (payload: unknown, brand = 'Ludy') =>
  renderTodayMail({
    messageId: 'm1',
    subject: null,
    payload: payload as Record<string, unknown>,
    publicUrl: 'https://ludy.example/',
    brand,
    inboundAddress: null,
    execute: () => Promise.reject(new Error('the daily mail mints nothing')),
  });

describe('the daily mail', () => {
  it('is registered under its template key', () => {
    expect(MAIL_TEMPLATES['kernel.today_mail']).toBeDefined();
  });

  it('says the counts in Vietnamese, with the product name and the links of the org', async () => {
    const mail = await render(base, 'Tên Mới');
    expect(mail?.subject).toBe('Hôm nay có 19 việc cần bạn trên Tên Mới');
    expect(mail?.text).toContain('Hôm nay có 19 việc cần bạn: 2 cảnh báo, 12 đề xuất chờ duyệt, 3 tin nhắn chưa trả lời, 2 hạn sắp đến.');
    expect(mail?.text).toContain('- Chờ bạn duyệt: 12');
    expect(mail?.text).toContain('Mở Tên Mới: https://ludy.example/o/cua-hang-a/overview');
    expect(mail?.text).toContain('https://ludy.example/o/cua-hang-a/notifications?todayMail=off');
    expect(mail?.html).toContain('href="https://ludy.example/o/cua-hang-a/overview"');
    expect(mail?.html).toContain('lang="vi"');
  });

  it('says it in English', async () => {
    const mail = await render({ ...base, language: 'en' });
    expect(mail?.subject).toBe('19 items need you today on Ludy');
    expect(mail?.text).toContain('19 items need you today: 2 warnings, 12 proposals waiting for approval, 3 unanswered messages, 2 upcoming deadlines.');
    expect(mail?.text).toContain('- Waiting for your approval: 12');
    expect(mail?.html).toContain('lang="en"');
  });

  it('holds counts and links only: no amount, no date, no name of anyone, the org name escaped', async () => {
    const mail = await render(base);
    expect(mail?.html).toContain('Cửa hàng &lt;A&gt;');
    expect(mail?.html).not.toContain('<A>');
    // Nothing but the counts, the org's own name and fixed words: no currency sign and no dated deadline.
    expect(mail?.text).not.toMatch(/₫|VND|USD|\d{1,2}\/\d{1,2}\/\d{4}/);
  });

  it('says nothing needs the member when nothing does', async () => {
    const mail = await render({ ...base, counts: { flags: 0, blocking: 0, proposals: 0, messages: 0, deadlines: 0 } });
    expect(mail?.subject).toBe('Hôm nay chưa có việc nào cần bạn trên Ludy');
    expect(mail?.text).toContain('Hôm nay chưa có việc nào cần bạn.');
  });

  it('builds its links from app paths of the org only, and refuses merge data it does not know', async () => {
    expect(await render({ ...base, home: 'https://evil.example/o/x/overview' })).toBeNull();
    expect(await render({ ...base, home: '/o/cua-hang-a/overview/../../x' })).toBeNull();
    expect(await render({ ...base, settings: '/o/cua-hang-a/notifications' })).toBeNull();
    expect(await render({ ...base, settings: '/o/cua-hang-a/notifications?todayMail=off&x=//evil' })).toBeNull();
    expect(await render({ ...base, language: 'fr' })).toBeNull();
    expect(await render({ ...base, day: '2026-13-01' })).toBeNull();
    expect(await render({ ...base, counts: { ...base.counts, flags: -1 } })).toBeNull();
    expect(await render({ ...base, counts: { flags: 1 } })).toBeNull();
    expect(await render({})).toBeNull();
  });
});
