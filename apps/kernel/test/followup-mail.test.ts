// SPDX-License-Identifier: AGPL-3.0-only
// The follow-up mail of a meeting (L3, #2590): rendered from the stored words and facts, every text escaped, in the meeting's language, with no link.
import { describe, expect, it } from 'vitest';
import { renderFollowupMail } from '../src/followup-mail.ts';

const MAIL = {
  lang: 'vi',
  org: 'Công ty <Tiên> Phong',
  batch: '00000000-0000-4000-8000-000000000001',
  greeting: 'Xin chào,',
  lead: 'Cảm ơn <b>mọi người</b>.',
  closing: 'Cảm ơn & hẹn gặp lại.',
  facts: { summary: 'Chốt giá.\n\nGặp khách <script>alert(1)</script>', decisions: ['Giữ giá "cũ"'], items: [{ title: 'Gửi báo giá', who: 'An', when: 'thứ sáu' }, { title: 'Chuẩn bị hợp đồng', who: '', when: '' }] },
};

describe('renderFollowupMail', () => {
  it('renders the words and the facts in Vietnamese, as text and as escaped HTML', () => {
    const out = renderFollowupMail(MAIL, { replyTo: null, brand: 'Ludy' });
    expect(out.text).toContain('Tóm tắt:\nChốt giá.');
    expect(out.text).toContain('- Giữ giá "cũ"');
    expect(out.text).toContain('- Gửi báo giá, Người phụ trách: An, Hạn: thứ sáu');
    expect(out.text).toContain('- Chuẩn bị hợp đồng\n');
    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toContain('<b>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('Công ty &lt;Tiên&gt; Phong');
    expect(out.html).toContain('&quot;cũ&quot;');
    expect(out.html).toContain('Cảm ơn &amp; hẹn gặp lại.');
    expect(out.html).not.toContain('href=');
    expect(out).not.toHaveProperty('replyTo');
  });

  it('renders English labels and a Reply-To when there is one', () => {
    const out = renderFollowupMail({ ...MAIL, lang: 'en' }, { replyTo: 'inbox@reply.test', brand: 'Ludy' });
    expect(out.text).toContain('Decisions:');
    expect(out.text).toContain('Owner: An, Due:');
    expect(out.replyTo).toBe('inbox@reply.test');
  });

  it('renders personal_note style cleanly as plain text and escaped HTML paragraphs and bullets with zero links', () => {
    const out = renderFollowupMail(
      {
        style: 'personal_note',
        lang: 'vi',
        org: 'Công ty Tiên Phong',
        batch: '00000000-0000-4000-8000-000000000002',
        body: 'Chào <b>Lan</b>,\n\nCảm ơn bạn đã tham gia buổi trao đổi.\n- Thử việc 1 và 2 tháng\n- Mức đề xuất <script>alert(1)</script>\n\nMình sẽ phản hồi trong tuần tới.',
      },
      { replyTo: 'inbox@reply.test', brand: 'Ludy' },
    );
    expect(out.text).toContain('Chào <b>Lan</b>,');
    expect(out.text).toContain('- Thử việc 1 và 2 tháng');
    expect(out.text).toContain('Thư này được gửi qua Ludy bởi người tổ chức cuộc họp.');
    expect(out.html).not.toContain('<script>');
    expect(out.html).not.toContain('<b>');
    expect(out.html).toContain('<p>Chào &lt;b&gt;Lan&lt;/b&gt;,</p>');
    expect(out.html).toContain('<p>Cảm ơn bạn đã tham gia buổi trao đổi.</p>');
    expect(out.html).toContain('<ul><li>Thử việc 1 và 2 tháng</li><li>Mức đề xuất &lt;script&gt;alert(1)&lt;/script&gt;</li></ul>');
    expect(out.html).toContain('<p>Mình sẽ phản hồi trong tuần tới.</p>');
    expect(out.html).not.toContain('href=');
    expect(out.replyTo).toBe('inbox@reply.test');
  });

  it('refuses merge data that is not what the template needs', () => {
    expect(() => renderFollowupMail({ ...MAIL, extra: 1 }, { replyTo: null })).toThrow();
    expect(() => renderFollowupMail({ ...MAIL, lang: 'fr' }, { replyTo: null })).toThrow();
    // The payload of a meeting that was erased is gone: the queue hands the template `{}`, and the mail is not sent (TEMPLATE_DATA), never sent empty.
    expect(() => renderFollowupMail({}, { replyTo: null })).toThrow();
  });
});
