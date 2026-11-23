// SPDX-License-Identifier: AGPL-3.0-only
// The mail template of a sent quote (#2694, #2827): its Reply-To is the org's conversation address, so the customer's answer reaches the Inbox as a conversation. It is
// never the document intake address (a reply there would be read as a document); with no conversation address the mail has no Reply-To.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderQuotePdf, type QuoteDocumentData } from '@ludy/mod-crm';
import { quoteMailTemplate, quotePdfFilename } from '../src/quote-mail.ts';
import type { MailTemplateInput } from '../src/mail-queue.ts';

const TOKEN = 'T'.repeat(43);
const payload = { lang: 'vi', org: 'Công ty ABC', number: 'BG-2026-0007', revision: 1, total: '3300000', validUntil: '2026-12-01', quoteId: '0198f3a2-7b1c-7d2e-8f3a-123456789abc' };

const input = (over: Partial<MailTemplateInput> = {}): MailTemplateInput => ({
  messageId: '0198f3a2-7b1c-7d2e-8f3a-123456789abd',
  subject: 'Báo giá BG-2026-0007 của Công ty ABC',
  payload,
  publicUrl: 'https://app.example.test',
  inboundAddress: null,
  brand: 'Ludy',
  execute: (async () => ({ token: TOKEN })) as MailTemplateInput['execute'],
  ...over,
});

describe('the quote mail template', () => {
  it('replies to the conversation address, not the document intake address', async () => {
    const mail = await quoteMailTemplate.render(input({ inboundAddress: 'intake-token@in.example.test', conversationAddress: 'conversation-token@in.example.test' }));
    expect(mail?.replyTo).toBe('conversation-token@in.example.test');
  });

  it('has no Reply-To when the org has no conversation address, even with a document intake address', async () => {
    for (const conversationAddress of [null, undefined]) {
      const mail = await quoteMailTemplate.render(input({ inboundAddress: 'intake-token@in.example.test', ...(conversationAddress === undefined ? {} : { conversationAddress }) }));
      expect(mail).not.toBeNull();
      expect(mail?.replyTo).toBeUndefined();
    }
  });
});

// The PDF attached to the mail (#3418, Q3's exit): the quote as it was sent, read in the org's system context, made as the mail goes out, and never the reason a mail is not sent.
const QUOTE_ID = payload.quoteId;
const sentQuote = (over: Record<string, unknown> = {}): QuoteDocumentData =>
  ({
    quote: {
      id: QUOTE_ID,
      dealId: '00000000-0000-4000-8000-000000000002',
      dealTitle: 'Gói kế toán năm',
      partyId: '00000000-0000-4000-8000-000000000003',
      partyName: 'Công ty ABC',
      number: 'BG-2026-0007',
      revision: 1,
      revisesId: null,
      status: 'sent',
      expired: false,
      validUntil: '2026-12-01',
      subtotal: '3000000',
      vatAmount: '300000',
      total: '3300000',
      lineCount: 1,
      version: 2,
      createdBy: 'u',
      createdAt: '2026-11-15T02:00:00.000Z',
      updatedAt: '2026-11-15T02:00:00.000Z',
      notes: null,
      terms: null,
      sentAt: '2026-11-15T02:00:00.000Z',
      sentVia: 'email',
      firstViewedAt: null,
      buyer: null,
      links: [],
      lines: [{ lineNo: 1, kind: 'item', description: 'Dịch vụ kế toán đặc biệt', unit: 'gói', quantity: '2', unitPrice: '1500000', discountPercent: '0', vatRate: '10%', amount: '3000000', vatAmount: '300000', stockItemId: null }],
      ...over,
    },
    seller: { name: 'Công ty Ánh Dương', taxCode: null, address: null, phone: null, email: null, bankNote: null },
    buyer: { name: 'Công ty ABC', taxCode: null, address: null, phone: null, email: null },
    issuedOn: '2026-11-15',
    logoFile: null,
  }) as unknown as QuoteDocumentData;

const executeWith = (document: () => unknown): MailTemplateInput['execute'] =>
  (async (command: string) => (command === 'crm.quote.mail_data' ? { token: TOKEN } : document())) as MailTemplateInput['execute'];

describe('the quote mail carries the quote as a PDF (#3418)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('attaches one PDF that is the same bytes as the download writer makes from the same quote, and says so', async () => {
    const data = sentQuote();
    const { logoFile: _logo, ...document } = data;
    const mail = await quoteMailTemplate.render(input({ execute: executeWith(() => data) }));
    expect(mail?.attachments).toHaveLength(1);
    const [file] = mail!.attachments!;
    expect(file).toMatchObject({ filename: 'bao-gia-BG-2026-0007.pdf', contentType: 'application/pdf' });
    expect(Buffer.from(file!.content as Uint8Array).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(file!.content).toEqual(renderQuotePdf({ ...document, logo: null }));
    expect(mail!.text).toContain('Bản PDF của báo giá được đính kèm');
    expect(mail!.html).toContain('Bản PDF của báo giá được đính kèm');
    // The link stays.
    expect(mail!.text).toContain(`quote#${TOKEN}`);
  });

  it('carries the same bytes when the mail is tried again after an unknown outcome', async () => {
    const execute = executeWith(() => sentQuote());
    const first = await quoteMailTemplate.render(input({ execute }));
    const second = await quoteMailTemplate.render(input({ execute }));
    expect(second!.attachments![0]!.content).toEqual(first!.attachments![0]!.content);
  });

  it('still sends the mail with the link alone when the document cannot be read or the writer refuses, and logs a code only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = [
      () => {
        throw new Error('Công ty ABC 3.300.000 Dịch vụ kế toán đặc biệt');
      },
      () => ({ ...sentQuote(), quote: { number: 'BG-1' } }),
    ];
    for (const document of broken) {
      const mail = await quoteMailTemplate.render(input({ execute: executeWith(document) }));
      expect(mail).not.toBeNull();
      expect(mail?.attachments).toBeUndefined();
      expect(mail?.text).toContain(`quote#${TOKEN}`);
      expect(mail?.text).toContain('có thể in hoặc lưu thành PDF');
      expect(mail?.text).not.toContain('đính kèm');
    }
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('QUOTE_PDF_UNAVAILABLE');
    expect(logged).not.toMatch(/ABC|3\.300|Dịch vụ|BG-/);
  });

  it('sends no mail when the quote has no document: a revision was sent between the link and the document', async () => {
    expect(await quoteMailTemplate.render(input({ execute: executeWith(() => null) }))).toBeNull();
  });

  it('still sends no mail for a quote that was replaced meanwhile (no link), and asks for no document then', async () => {
    const asked: string[] = [];
    const execute = (async (command: string) => {
      asked.push(command);
      return { token: null };
    }) as MailTemplateInput['execute'];
    expect(await quoteMailTemplate.render(input({ execute }))).toBeNull();
    expect(asked).toEqual(['crm.quote.mail_data']);
  });

  it('names the file from the quote number made safe for a file name, and the revision', () => {
    expect(quotePdfFilename('BG-2026-0007', 1)).toBe('bao-gia-BG-2026-0007.pdf');
    expect(quotePdfFilename('BG-2026-0007', 2)).toBe('bao-gia-BG-2026-0007-R2.pdf');
    expect(quotePdfFilename('../../etc/passwd "x"\r\n', 1)).toBe('bao-gia-..-..-etc-passwd-x.pdf');
    expect(quotePdfFilename(null, 1)).toBe('bao-gia-bao-gia.pdf');
  });
});
