// SPDX-License-Identifier: AGPL-3.0-only
// The morning mail of the day's meetings (#3955): a count and the link in both languages, nothing of a title or a brief, and merge data that is not exactly the template's is refused.
import { describe, expect, it } from 'vitest';
import { morningMailTemplate } from '../src/morning-mail.ts';

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
const base = { lang: 'vi', org: 'Công ty <A>', count: 3, path: '/o/acme/meetings' };

describe('the morning mail', () => {
  it('says the count and links the meetings page in both languages', async () => {
    const vi = await morningMailTemplate.render(input(base));
    expect(vi?.text).toContain('Hôm nay bạn có 3 cuộc họp.');
    expect(vi?.text).toContain('https://ludy.test/o/acme/meetings');
    expect(vi?.html).toContain('href="https://ludy.test/o/acme/meetings"');
    // The org's name is escaped in the HTML.
    expect(vi?.html).toContain('Công ty &lt;A&gt;');
    expect(vi?.html).not.toContain('<A>');
    const one = await morningMailTemplate.render(input({ ...base, lang: 'en', count: 1 }));
    expect(one?.text).toContain('You have 1 meeting today.');
    const many = await morningMailTemplate.render(input({ ...base, lang: 'en' }));
    expect(many?.text).toContain('You have 3 meetings today.');
  });

  it('refuses merge data with a key it does not use (a title, a time) or a link that is not the meetings page', async () => {
    await expect(morningMailTemplate.render(input({ ...base, title: 'Họp lương' }))).rejects.toThrow();
    await expect(morningMailTemplate.render(input({ ...base, events: ['09:00'] }))).rejects.toThrow();
    await expect(morningMailTemplate.render(input({ ...base, path: 'https://evil.test/' }))).rejects.toThrow();
    await expect(morningMailTemplate.render(input({ ...base, path: `/o/acme/meetings/${ID}` }))).rejects.toThrow();
    await expect(morningMailTemplate.render(input({ ...base, count: -1 }))).rejects.toThrow();
    // No subject, no mail.
    expect(await morningMailTemplate.render(input(base, null))).toBeNull();
  });
});
