// SPDX-License-Identifier: AGPL-3.0-only
// The "minutes draft ready" mail (#3730): a fixed line and the link in both languages, nothing of a title or a draft, and merge data that is not exactly the template's is refused.
import { describe, expect, it } from 'vitest';
import { summaryReadyMailTemplate } from '../src/summary-ready-mail.ts';

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

describe('the summary ready mail', () => {
  it('names the link in both languages and holds nothing else of the meeting', async () => {
    for (const lang of ['vi', 'en'] as const) {
      const out = await summaryReadyMailTemplate.render(input({ lang, org: 'Công ty <A>', path: `/o/acme/meetings/${ID}` }));
      expect(out?.text).toContain(`https://ludy.test/o/acme/meetings/${ID}`);
      expect(out?.html).toContain(`href="https://ludy.test/o/acme/meetings/${ID}"`);
      // The org's name is escaped in the HTML.
      expect(out?.html).toContain('Công ty &lt;A&gt;');
      expect(out?.html).not.toContain('<A>');
    }
  });

  it('refuses merge data with a key it does not use (a title, a summary) or a path that is not a meeting of the app', async () => {
    const base = { lang: 'vi', org: 'Acme', path: `/o/acme/meetings/${ID}` };
    await expect(summaryReadyMailTemplate.render(input({ ...base, title: 'Họp lương' }))).rejects.toThrow();
    await expect(summaryReadyMailTemplate.render(input({ ...base, summary: 'Quyết định' }))).rejects.toThrow();
    await expect(summaryReadyMailTemplate.render(input({ ...base, path: 'https://evil.test/' }))).rejects.toThrow();
    await expect(summaryReadyMailTemplate.render(input({ ...base, path: `/o/acme/inbox/${ID}` }))).rejects.toThrow();
    // No subject, no mail.
    expect(await summaryReadyMailTemplate.render(input(base, null))).toBeNull();
  });
});
