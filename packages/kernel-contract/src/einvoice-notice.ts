// SPDX-License-Identifier: AGPL-3.0-only
// The notice of an error only in the non-core content of an issued sales e-invoice (#2504, #3697, plan einvoice-issue.md section 8 "Errors only in non-core content"; Circular 91 Art. 10 as read
// for #2506, working answers not confirmed by the accountant yet): the buyer's name or address, or the amount in words. No new invoice is made and nothing is cancelled. The seller tells the
// buyer (via Ludy's mail queue after explicit approval, or manually outside Ludy) and, as the working answer of #2506 question 1 says, files the form 04/SS-HĐĐT with the tax authority.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const EINVOICE_NOTICE_FIELDS = ['buyer_name', 'buyer_address', 'amount_in_words'] as const;
export type EInvoiceNoticeField = (typeof EINVOICE_NOTICE_FIELDS)[number];
export const EINVOICE_NOTICE_STEPS = ['buyer_notice', 'tax_form'] as const;
export type EInvoiceNoticeStep = (typeof EINVOICE_NOTICE_STEPS)[number];
export const EINVOICE_NOTICE_MAIL_STATUSES = ['queued', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed', 'failed', 'ambiguous'] as const;
export type EInvoiceNoticeMailStatus = (typeof EINVOICE_NOTICE_MAIL_STATUSES)[number];

// Records an error found on an issued invoice. EINVOICE_DRAFT_NOT_FOUND (404), EINVOICE_ORIGINAL_NOT_ISSUED (409).
export const zEInvoiceNoticeOpen = z.strictObject({
  draftId: zId,
  field: z.enum(EINVOICE_NOTICE_FIELDS),
  correctText: z.string().trim().min(1).max(500),
});
export type EInvoiceNoticeOpen = z.infer<typeof zEInvoiceNoticeOpen>;

// Ticks a step as done, once: the buyer was told, or the form was filed. EINVOICE_NOTICE_NOT_FOUND (404).
export const zEInvoiceNoticeStep = z.strictObject({ noticeId: zId, step: z.enum(EINVOICE_NOTICE_STEPS) });
export type EInvoiceNoticeStepInput = z.infer<typeof zEInvoiceNoticeStep>;

// Queues the buyer's error notice email after explicit review (#3697). Refusals: EINVOICE_NOTICE_NOT_FOUND (404),
// EINVOICE_DRAFT_NOT_FOUND (404), EINVOICE_ORIGINAL_NOT_ISSUED (409), EINVOICE_NOTICE_ALREADY_SENT (409),
// EINVOICE_NOTICE_MAIL_PENDING (409), EINVOICE_NOTICE_STALE (409), BUYER_EMAIL_REQUIRED (422).
export const zEInvoiceNoticeSend = z.strictObject({
  noticeId: zId,
  approved: z.literal(true),
  expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EInvoiceNoticeSendInput = z.infer<typeof zEInvoiceNoticeSend>;

export const zEInvoiceNotice = z.object({
  id: zId,
  draftId: zId,
  field: z.enum(EINVOICE_NOTICE_FIELDS),
  correctText: z.string(),
  buyerNoticeState: z.enum(['todo', 'sent']),
  buyerNotifiedAt: z.string().nullable(),
  buyerNoticeMailId: zId.nullable(),
  buyerNoticeMailStatus: z.enum(EINVOICE_NOTICE_MAIL_STATUSES).nullable(),
  buyerNoticeMailErrorCode: z.string().nullable(),
  formState: z.enum(['todo', 'filed']),
  formFiledAt: z.string().nullable(),
  createdAt: z.string(),
  reviewHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EInvoiceNotice = z.infer<typeof zEInvoiceNotice>;

export const zEInvoiceNoticeSendResult = z.object({
  notice: zEInvoiceNotice,
  mailId: zId,
  mailStatus: z.enum(['queued', 'suppressed']),
});
export type EInvoiceNoticeSendResult = z.infer<typeof zEInvoiceNoticeSendResult>;

export const zEInvoiceNoticeListInput = z.strictObject({ draftId: zId });
// The invoice the notices are about (what the notice text names) and its notices, oldest first.
export const zEInvoiceNoticeList = z.object({
  reference: z.object({ number: z.string(), templateNo: z.string().nullable(), symbol: z.string().nullable(), date: z.string(), buyerName: z.string().nullable(), buyerEmail: z.string().nullable() }),
  notices: z.array(zEInvoiceNotice),
});
export type EInvoiceNoticeList = z.infer<typeof zEInvoiceNoticeList>;

const FIELD_WORDS: Record<EInvoiceNoticeField, { what: string; right: string }> = {
  buyer_name: { what: 'tên người mua', right: 'Tên người mua đúng là' },
  buyer_address: { what: 'địa chỉ người mua', right: 'Địa chỉ người mua đúng là' },
  amount_in_words: { what: 'số tiền viết bằng chữ', right: 'Số tiền viết bằng chữ đúng là' },
};

const day = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
};

/** The email subject built purely from the invoice number and optional symbol (no model text). */
export function einvoiceNoticeSubject(input: { number: string; symbol: string | null }): string {
  const clean = (s: string) => s.replace(/[\r\n\t]+/g, ' ').trim();
  const symbol = input.symbol ? clean(input.symbol) : '';
  return `Thông báo sai sót hóa đơn điện tử số ${clean(input.number)}${symbol ? `, ký hiệu ${symbol}` : ''}`;
}

/** The text of the notice to the buyer, in Vietnamese (the buyer's own language), built by code from the invoice and the field: no model writes it, and the person reads and sends it. */
export function einvoiceNoticeText(input: { buyerName: string | null; number: string; templateNo: string | null; symbol: string | null; date: string; field: EInvoiceNoticeField; correctText: string }): string {
  const words = FIELD_WORDS[input.field];
  const form = [input.templateNo ? `mẫu số ${input.templateNo}` : null, input.symbol ? `ký hiệu ${input.symbol}` : null].filter((part): part is string => part !== null).join(', ');
  return [
    `Kính gửi ${input.buyerName?.trim() ? input.buyerName.trim() : 'Quý khách'},`,
    '',
    `Chúng tôi xin thông báo hóa đơn điện tử số ${input.number}${form ? `, ${form}` : ''}, ngày ${day(input.date)}, có sai sót về ${words.what}.`,
    `${words.right}: ${input.correctText.trim()}.`,
    '',
    'Sai sót này không ảnh hưởng đến số tiền và thuế của hóa đơn, nên chúng tôi không lập hóa đơn mới; hóa đơn đã phát hành vẫn có hiệu lực. Xin quý khách ghi nhận nội dung đúng nêu trên.',
    '',
    'Trân trọng.',
  ].join('\n');
}
