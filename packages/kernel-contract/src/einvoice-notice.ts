// SPDX-License-Identifier: AGPL-3.0-only
// The notice of an error only in the non-core content of an issued sales e-invoice (#2504, plan einvoice-issue.md section 8 "Errors only in non-core content"; Circular 91 Art. 10 as read
// for #2506, working answers not confirmed by the accountant yet): the buyer's name or address, or the amount in words. No new invoice is made and nothing is cancelled. The seller tells the
// buyer and, as the working answer of #2506 question 1 says, files the form 04/SS-HĐĐT with the tax authority; Ludy sends neither and tracks both steps until a person ticks them.
import { z } from 'zod';
import { zId } from './schemas.ts';

export const EINVOICE_NOTICE_FIELDS = ['buyer_name', 'buyer_address', 'amount_in_words'] as const;
export type EInvoiceNoticeField = (typeof EINVOICE_NOTICE_FIELDS)[number];
export const EINVOICE_NOTICE_STEPS = ['buyer_notice', 'tax_form'] as const;
export type EInvoiceNoticeStep = (typeof EINVOICE_NOTICE_STEPS)[number];

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

export const zEInvoiceNotice = z.object({
  id: zId,
  draftId: zId,
  field: z.enum(EINVOICE_NOTICE_FIELDS),
  correctText: z.string(),
  buyerNoticeState: z.enum(['todo', 'sent']),
  buyerNotifiedAt: z.string().nullable(),
  formState: z.enum(['todo', 'filed']),
  formFiledAt: z.string().nullable(),
  createdAt: z.string(),
});
export type EInvoiceNotice = z.infer<typeof zEInvoiceNotice>;

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
