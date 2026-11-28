// SPDX-License-Identifier: AGPL-3.0-only
// The mail template and code-built rendering of an e-invoice buyer error notice (#3697, follow-up of #2504):
// no model writes any words, HTML escapes all invoice and buyer fields, and Reply-To uses the org's conversation address
// rather than the document intake address.
import { describe, expect, it } from 'vitest';
import { einvoiceNoticeSubject } from '@ludy/kernel-contract';
import { EINVOICE_NOTICE_MAIL_TEMPLATE, renderEInvoiceNoticeMail } from '@ludy/mod-finance';
import { MAIL_TEMPLATES } from '../src/mail-templates.ts';
import { einvoiceNoticeMailTemplate } from '../src/einvoice-notice-mail.ts';
import type { MailTemplateInput } from '../src/mail-queue.ts';

const payload = {
  legalEntityId: '0198f3a2-7b1c-7d2e-8f3a-123456789abc',
  org: 'Công ty Ánh Dương',
  buyerName: 'Công ty Mua <Thử> & Cộng sự',
  number: '0000007',
  templateNo: '1',
  symbol: 'C26TAA',
  date: '2026-11-17',
  field: 'buyer_address' as const,
  correctText: '12 Lê Lợi <Quận 1> & TP.HCM',
};

const input = (over: Partial<MailTemplateInput> = {}): MailTemplateInput => ({
  messageId: '0198f3a2-7b1c-7d2e-8f3a-123456789abd',
  subject: einvoiceNoticeSubject({ number: payload.number, symbol: payload.symbol }),
  payload,
  publicUrl: 'https://app.example.test',
  inboundAddress: 'intake-token@in.example.test',
  brand: 'Ludy',
  execute: (async () => ({})) as MailTemplateInput['execute'],
  ...over,
});

describe('einvoice notice mail (#3697)', () => {
  it('is registered on MAIL_TEMPLATES', () => {
    expect(MAIL_TEMPLATES[EINVOICE_NOTICE_MAIL_TEMPLATE]).toBe(einvoiceNoticeMailTemplate);
  });

  it('builds a Vietnamese subject cleanly with and without symbol', () => {
    expect(einvoiceNoticeSubject({ number: '0000007', symbol: 'C26TAA' })).toBe('Thông báo sai sót hóa đơn điện tử số 0000007, ký hiệu C26TAA');
    expect(einvoiceNoticeSubject({ number: ' 0000007\n', symbol: null })).toBe('Thông báo sai sót hóa đơn điện tử số 0000007');
  });

  it('renders code-built Vietnamese notice text, escapes HTML, and sets Reply-To only to conversationAddress', async () => {
    const rendered = await einvoiceNoticeMailTemplate.render(input({ conversationAddress: 'conversation-token@in.example.test' }));
    expect(rendered).not.toBeNull();
    expect(rendered?.replyTo).toBe('conversation-token@in.example.test');
    expect(rendered?.text).toContain('Kính gửi Công ty Mua <Thử> & Cộng sự,');
    expect(rendered?.text).toContain('hóa đơn điện tử số 0000007, mẫu số 1, ký hiệu C26TAA, ngày 17/11/2026');
    expect(rendered?.text).toContain('Địa chỉ người mua đúng là: 12 Lê Lợi <Quận 1> & TP.HCM.');
    expect(rendered?.text).toContain('Công ty Ánh Dương');
    expect(rendered?.html).toContain('Công ty Mua &lt;Thử&gt; &amp; Cộng sự');
    expect(rendered?.html).toContain('12 Lê Lợi &lt;Quận 1&gt; &amp; TP.HCM');
    expect(rendered?.html).not.toContain('<Thử>');
  });

  it('omits Reply-To when conversationAddress is missing even if inboundAddress exists', async () => {
    for (const conversationAddress of [null, undefined]) {
      const rendered = await einvoiceNoticeMailTemplate.render(input(conversationAddress === undefined ? {} : { conversationAddress }));
      expect(rendered).not.toBeNull();
      expect(rendered?.replyTo).toBeUndefined();
    }
  });

  it('returns null when subject is missing and rejects malformed payload data', async () => {
    expect(await einvoiceNoticeMailTemplate.render(input({ subject: null }))).toBeNull();
    expect(() => renderEInvoiceNoticeMail({ ...payload, field: 'tax_code' }, { replyTo: null })).toThrow();
    expect(() => renderEInvoiceNoticeMail({ ...payload, correctText: '   ' }, { replyTo: null })).toThrow();
  });
});
