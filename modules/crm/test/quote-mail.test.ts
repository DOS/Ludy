// SPDX-License-Identifier: AGPL-3.0-only
// The mail of a sent quote (#2694): the words and the link from the stored merge data, escaped, and refused when the data is not what the template needs.
import { describe, expect, it } from 'vitest';
import { renderQuoteMail, zQuoteMail } from '../src/quote-mail.ts';

const TOKEN = 'A'.repeat(43);
const data = { lang: 'vi', org: 'Công ty ABC', number: 'BG-2026-0007', revision: 1, total: '3300000', validUntil: '2026-12-01', quoteId: '0198f3a2-7b1c-7d2e-8f3a-123456789abc' };

describe('renderQuoteMail', () => {
  it('says who sends which quote, for how much and until when, with the link to its page', () => {
    const mail = renderQuoteMail(data, { publicUrl: 'https://app.example.test', replyTo: 'inbox@in.example.test', brand: 'Ludy', token: TOKEN });
    expect(mail.text).toContain('Công ty ABC gửi Quý khách báo giá số BG-2026-0007, tổng cộng 3.300.000 đồng, có hiệu lực đến ngày 01/12/2026.');
    expect(mail.text).toContain(`https://app.example.test/-/quote#${TOKEN}`);
    expect(mail.html).toContain(`href="https://app.example.test/-/quote#${TOKEN}"`);
    expect(mail.replyTo).toBe('inbox@in.example.test');
  });

  it('names a revision and drops a trailing slash of the address', () => {
    const mail = renderQuoteMail({ ...data, revision: 2 }, { publicUrl: 'https://app.example.test/', replyTo: null, token: TOKEN });
    expect(mail.text).toContain('BG-2026-0007-R2');
    expect(mail.text).toContain(`https://app.example.test/-/quote#${TOKEN}`);
    expect(mail.replyTo).toBeUndefined();
  });

  it('escapes the org name in the HTML and keeps it to one line in the text', () => {
    const mail = renderQuoteMail({ ...data, org: 'A <b>"B"</b> & C\nD' }, { publicUrl: 'https://app.example.test', replyTo: null, token: TOKEN });
    expect(mail.html).not.toContain('<b>');
    expect(mail.html).toContain('A &lt;b&gt;&quot;B&quot;&lt;/b&gt; &amp; C D');
    expect(mail.text).toContain('A <b>"B"</b> & C D gửi Quý khách');
  });

  it('refuses merge data that is not a quote mail: another language, a token or any extra field, a number that is not an amount', () => {
    for (const bad of [{ ...data, lang: 'en' }, { ...data, token: TOKEN }, { ...data, quoteId: 'nope' }, { ...data, total: '12.34567' }, { ...data, validUntil: '1/12/2026' }, { ...data, extra: 1 }, { ...data, org: '' }]) {
      expect(zQuoteMail.safeParse(bad).success).toBe(false);
      expect(() => renderQuoteMail(bad, { publicUrl: 'https://app.example.test', replyTo: null, token: TOKEN })).toThrow();
    }
    expect(() => renderQuoteMail(data, { publicUrl: 'https://app.example.test', replyTo: null, token: 'short' })).toThrow();
  });
});
