// SPDX-License-Identifier: AGPL-3.0-only
// The notice of an error only in the non-core content of an issued sales e-invoice (#2504, #3697, plan einvoice-issue.md section 8; the accountant's answers of section 3a row 7 and 3b): the buyer's
// name or address, or the amount in words. No new invoice is made and the invoice is not cancelled. The seller tells the buyer ("Gửi thông báo cho người mua") and files the form
// 04/SS-HĐĐT with the tax authority (the research of 2026-11-18, plan einvoice-issue.md section 3c: promptly and before the VAT return of the period, for non-core errors only, never with an adjusting or
// replacing invoice, and Circular 91 sets no day count).
// - finance.einvoice.notice_open (owners, admins, members; R1): records an error on an issued invoice with the text that is right.
// - finance.einvoice.notice_step (same roles; R1): ticks one step, once; ticking again changes nothing (manual fallback when sent outside Ludy, and tax form 04/SS-HĐĐT).
// - finance.einvoice.notice_send (same roles, human actor only; R2, external): after explicit UI review (`expectedHash`, `approved: true`), queues the code-built Vietnamese notice via Ludy's mail queue.
// - finance.einvoice.notice_mail_settle (system only; R1, internal): marks `buyer_notice_state = 'sent'` when the mail worker records `outcome === 'sent'`.
// - finance.einvoice.notice_list: the notices of an invoice, live mail status, and what the notice text names (read only).
import { z } from 'zod';
import { createMailMessage } from '@ludy/kernel';
import {
  einvoiceNoticeSubject,
  isMailAddress,
  zEInvoiceNoticeListInput,
  zEInvoiceNoticeOpen,
  zEInvoiceNoticeSend,
  zEInvoiceNoticeStep,
  zId,
  type EInvoiceNotice,
  type EInvoiceNoticeList,
  type EInvoiceNoticeMailStatus,
  type EInvoiceNoticeSendResult,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, sha256Hex, type QueryContext } from '@ludy/kernel-runtime';
import { EINVOICE_NOTICE_MAIL_SOURCE, EINVOICE_NOTICE_MAIL_TEMPLATE, zEInvoiceNoticeMail, type EInvoiceNoticeMail } from './einvoice-notice-mail.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { oneLine } from './missing-invoices.ts';
import { PLAIN_ADDRESS, orgName } from './payment-reminders.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

interface DraftRef {
  legal_entity_id: string;
  state: string;
  issued_number: string | null;
  invoice_date: string;
  buyer_name: string | null;
  buyer_email: string | null;
  template_no: string | null;
  symbol: string | null;
}

interface NoticeRow {
  id: string;
  draft_id: string;
  legal_entity_id: string;
  field: string;
  correct_text: string;
  buyer_notice_state: string;
  buyer_notified_at: Date | string | null;
  buyer_notice_mail_id: string | null;
  form_state: string;
  form_filed_at: Date | string | null;
  created_at: Date | string;
}

interface MailState {
  id: string;
  status: EInvoiceNoticeMailStatus;
  error_code: string | null;
}

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

function noticeReviewHash(row: Pick<NoticeRow, 'id' | 'draft_id' | 'field' | 'correct_text'>, draft: Pick<DraftRef, 'issued_number' | 'invoice_date' | 'buyer_name' | 'buyer_email' | 'template_no' | 'symbol'>): string {
  return sha256Hex(
    JSON.stringify({
      noticeId: row.id,
      draftId: row.draft_id,
      field: row.field,
      correctText: row.correct_text,
      number: draft.issued_number ?? '',
      templateNo: draft.template_no ?? null,
      symbol: draft.symbol ?? null,
      date: draft.invoice_date,
      buyerName: draft.buyer_name?.trim() ?? null,
      buyerEmail: draft.buyer_email?.trim().toLowerCase() ?? null,
    }),
  );
}

function view(row: NoticeRow, draft: Pick<DraftRef, 'issued_number' | 'invoice_date' | 'buyer_name' | 'buyer_email' | 'template_no' | 'symbol'>, mail: MailState | null): EInvoiceNotice {
  return {
    id: row.id,
    draftId: row.draft_id,
    field: row.field as EInvoiceNotice['field'],
    correctText: row.correct_text,
    buyerNoticeState: row.buyer_notice_state as EInvoiceNotice['buyerNoticeState'],
    buyerNotifiedAt: iso(row.buyer_notified_at),
    buyerNoticeMailId: row.buyer_notice_mail_id,
    buyerNoticeMailStatus: mail?.status ?? null,
    buyerNoticeMailErrorCode: mail?.error_code ?? null,
    formState: row.form_state as EInvoiceNotice['formState'],
    formFiledAt: iso(row.form_filed_at),
    createdAt: iso(row.created_at) as string,
    reviewHash: noticeReviewHash(row, draft),
  };
}

async function loadDraftRef(ctx: Ctx, draftId: string, lockShare = false): Promise<DraftRef | undefined> {
  const base = ctx.trx
    .selectFrom('ludy_finance.einvoice_draft as d')
    .leftJoin('ludy_finance.einvoice_series as s', (join) => join.onRef('s.org_id', '=', 'd.org_id').onRef('s.id', '=', 'd.series_id'))
    .select(['d.legal_entity_id', 'd.state', 'd.issued_number', 'd.invoice_date', 'd.buyer_name', 'd.buyer_email', 's.template_no', 's.symbol'])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.id', '=', draftId);
  return (lockShare ? base.forShare('d') : base).executeTakeFirst();
}

async function loadMailStates(ctx: Ctx, mailIds: readonly string[]): Promise<Map<string, MailState>> {
  const out = new Map<string, MailState>();
  if (mailIds.length === 0) return out;
  const rows = await ctx.trx
    .selectFrom('ludy_kernel.mail_message')
    .select(['id', 'status', 'error_code'])
    .where('org_id', '=', ctx.orgId)
    .where('id', 'in', [...new Set(mailIds)])
    .execute();
  for (const row of rows) {
    out.set(row.id, { id: row.id, status: row.status as EInvoiceNoticeMailStatus, error_code: row.error_code ?? null });
  }
  return out;
}

const notFound = () => new DomainError('EINVOICE_NOTICE_NOT_FOUND', 404, 'Không tìm thấy thông báo sai sót này');

export const einvoiceNoticeOpen = defineCommand({
  name: 'finance.einvoice.notice_open',
  input: zEInvoiceNoticeOpen,
  // A working record: it sends nothing and changes no invoice.
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'finance.einvoice_draft', id: input.draftId }),
  handler: async (ctx, input): Promise<EInvoiceNotice> => {
    const draft = await loadDraftRef(ctx, input.draftId.toLowerCase(), true);
    if (!draft) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy hóa đơn');
    if (draft.state !== 'issued' || draft.issued_number === null) throw new DomainError('EINVOICE_ORIGINAL_NOT_ISSUED', 409, 'Chỉ ghi nhận sai sót cho hóa đơn đã phát hành');
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const row = await ctx.trx
      .insertInto('ludy_finance.einvoice_notice')
      .values({ org_id: ctx.orgId, legal_entity_id: draft.legal_entity_id, draft_id: input.draftId.toLowerCase(), field: input.field, correct_text: input.correctText, created_by: userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    // Ids and the field only: the text that is right can be a buyer's name or address.
    ctx.audit({ noticeId: row.id, draftId: row.draft_id, field: row.field, legalEntityId: row.legal_entity_id });
    return view(row, draft, null);
  },
});

export const einvoiceNoticeStep = defineCommand({
  name: 'finance.einvoice.notice_step',
  input: zEInvoiceNoticeStep,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input): Promise<EInvoiceNotice> => {
    const existing = await ctx.trx
      .selectFrom('ludy_finance.einvoice_notice')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noticeId.toLowerCase())
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw notFound();
    const draft = await loadDraftRef(ctx, existing.draft_id);
    if (!draft) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy hóa đơn');
    const mail = existing.buyer_notice_mail_id ? (await loadMailStates(ctx, [existing.buyer_notice_mail_id])).get(existing.buyer_notice_mail_id) ?? null : null;
    const done = input.step === 'buyer_notice' ? existing.buyer_notice_state === 'sent' : existing.form_state === 'filed';
    if (done) return view(existing, draft, mail);
    const row = await ctx.trx
      .updateTable('ludy_finance.einvoice_notice')
      .set(input.step === 'buyer_notice' ? { buyer_notice_state: 'sent', buyer_notified_at: ctx.now } : { form_state: 'filed', form_filed_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    ctx.audit({ noticeId: row.id, draftId: row.draft_id, step: input.step });
    return view(row, draft, mail);
  },
});

export const einvoiceNoticeSend = defineCommand({
  name: 'finance.einvoice.notice_send',
  input: zEInvoiceNoticeSend,
  risk: 'R2',
  sideEffect: 'external',
  access: EDITORS,
  target: (input) => ({ type: 'finance.einvoice_notice', id: input.noticeId }),
  handler: async (ctx, input): Promise<EInvoiceNoticeSendResult> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới gửi thông báo sai sót cho người mua');
    }
    const existing = await ctx.trx
      .selectFrom('ludy_finance.einvoice_notice')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noticeId.toLowerCase())
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw notFound();
    await resolveLegalEntity(ctx, existing.legal_entity_id);
    const draft = await loadDraftRef(ctx, existing.draft_id, true);
    if (!draft || draft.state !== 'issued' || draft.issued_number === null) {
      throw new DomainError('EINVOICE_ORIGINAL_NOT_ISSUED', 409, 'Chỉ gửi thông báo sai sót cho hóa đơn đã phát hành');
    }
    if (existing.buyer_notice_state === 'sent') {
      throw new DomainError('EINVOICE_NOTICE_ALREADY_SENT', 409, 'Thông báo sai sót này đã được ghi nhận đã gửi cho người mua');
    }
    const existingMail = existing.buyer_notice_mail_id ? (await loadMailStates(ctx, [existing.buyer_notice_mail_id])).get(existing.buyer_notice_mail_id) ?? null : null;
    if (existingMail?.status === 'sent' || existingMail?.status === 'delivered') {
      throw new DomainError('EINVOICE_NOTICE_ALREADY_SENT', 409, 'Email thông báo sai sót này đã được gửi tới người mua');
    }
    if (existingMail?.status === 'queued' || existingMail?.status === 'sending') {
      throw new DomainError('EINVOICE_NOTICE_MAIL_PENDING', 409, 'Email thông báo sai sót đang chờ gửi trong hàng đợi thư');
    }
    if (input.expectedHash !== noticeReviewHash(existing, draft)) {
      throw new DomainError('EINVOICE_NOTICE_STALE', 409, 'Thông tin hóa đơn hoặc email người mua đã thay đổi; hãy tải lại để xem lại trước khi gửi');
    }
    const email = draft.buyer_email?.trim() ?? '';
    if (!PLAIN_ADDRESS.test(email) || !isMailAddress(email)) {
      throw new DomainError('BUYER_EMAIL_REQUIRED', 422, 'Hóa đơn này chưa có email hợp lệ của người mua; hãy kiểm tra lại hoặc dùng cách gửi thủ công');
    }
    const org = (await orgName(ctx, existing.legal_entity_id)) || 'Đơn vị phát hành';
    const payload: EInvoiceNoticeMail = {
      legalEntityId: existing.legal_entity_id,
      org,
      buyerName: draft.buyer_name?.trim() ? oneLine(draft.buyer_name, 400) : null,
      number: oneLine(draft.issued_number, 50),
      templateNo: draft.template_no?.trim() ? oneLine(draft.template_no, 50) : null,
      symbol: draft.symbol?.trim() ? oneLine(draft.symbol, 50) : null,
      date: draft.invoice_date,
      field: existing.field as EInvoiceNotice['field'],
      correctText: existing.correct_text,
    };
    const checked = zEInvoiceNoticeMail.safeParse(payload);
    if (!checked.success) {
      throw new DomainError('VALIDATION', 422, 'Không tạo được nội dung email thông báo sai sót từ thông tin hóa đơn hiện có');
    }
    const subject = oneLine(einvoiceNoticeSubject({ number: checked.data.number, symbol: checked.data.symbol }), 200);
    const mail = await createMailMessage(ctx, {
      stream: 'transactional',
      source: EINVOICE_NOTICE_MAIL_SOURCE,
      sourceId: existing.id,
      templateKey: EINVOICE_NOTICE_MAIL_TEMPLATE,
      to: email,
      subject,
      payload: checked.data,
      status: 'queued',
    });
    const row = await ctx.trx
      .updateTable('ludy_finance.einvoice_notice')
      .set({ buyer_notice_mail_id: mail.id })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const mailStatus = mail.status === 'suppressed' ? 'suppressed' : 'queued';
    await ctx.activity(
      'kernel.mail_message',
      mail.id,
      'einvoice.notice.sent',
      mailStatus === 'suppressed'
        ? `Không gửi được thông báo sai sót hóa đơn số ${checked.data.number}: địa chỉ email người mua đang bị chặn`
        : `Đưa email thông báo sai sót hóa đơn số ${checked.data.number} vào hàng đợi gửi người mua`,
      { legalEntityId: existing.legal_entity_id },
    );
    ctx.audit({
      noticeId: row.id,
      draftId: row.draft_id,
      field: row.field,
      mailId: mail.id,
      mailStatus,
      legalEntityId: row.legal_entity_id,
    });
    return {
      notice: view(row, draft, { id: mail.id, status: mailStatus, error_code: null }),
      mailId: mail.id,
      mailStatus,
    };
  },
});

export const einvoiceNoticeMailSettle = defineCommand({
  name: 'finance.einvoice.notice_mail_settle',
  input: z.strictObject({ mailId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input): Promise<{ settled: boolean; noticeId: string | null }> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ hàng đợi thư mới xác nhận được kết quả gửi thông báo sai sót');
    }
    const mailId = input.mailId.toLowerCase();
    const mail = await ctx.trx
      .selectFrom('ludy_kernel.mail_message')
      .select(['id', 'source', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', mailId)
      .executeTakeFirst();
    if (!mail || mail.source !== EINVOICE_NOTICE_MAIL_SOURCE || (mail.status !== 'sent' && mail.status !== 'delivered')) {
      return { settled: false, noticeId: null };
    }
    const existing = await ctx.trx
      .selectFrom('ludy_finance.einvoice_notice')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('buyer_notice_mail_id', '=', mail.id)
      .forUpdate()
      .executeTakeFirst();
    if (!existing || existing.buyer_notice_state !== 'todo') {
      return { settled: false, noticeId: existing?.id ?? null };
    }
    const row = await ctx.trx
      .updateTable('ludy_finance.einvoice_notice')
      .set({ buyer_notice_state: 'sent', buyer_notified_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .where('buyer_notice_state', '=', 'todo')
      .where('buyer_notice_mail_id', '=', mail.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await ctx.activity(
      'kernel.mail_message',
      mail.id,
      'einvoice.notice.delivered',
      'Đã gửi thông báo sai sót hóa đơn cho người mua qua hàng đợi thư',
      { legalEntityId: row.legal_entity_id },
    );
    ctx.audit({ noticeId: row.id, draftId: row.draft_id, mailId: mail.id, step: 'buyer_notice', via: 'mail_queue' });
    return { settled: true, noticeId: row.id };
  },
});

async function loadList(ctx: Ctx, draftId: string): Promise<EInvoiceNoticeList> {
  const draft = await loadDraftRef(ctx, draftId);
  if (!draft || draft.state !== 'issued' || draft.issued_number === null) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy hóa đơn');
  const rows = await ctx.trx.selectFrom('ludy_finance.einvoice_notice').selectAll().where('org_id', '=', ctx.orgId).where('draft_id', '=', draftId).orderBy('created_at').orderBy('id').execute();
  const mailMap = await loadMailStates(
    ctx,
    rows.map((row) => row.buyer_notice_mail_id).filter((id): id is string => id !== null),
  );
  return {
    reference: { number: draft.issued_number, templateNo: draft.template_no ?? null, symbol: draft.symbol ?? null, date: draft.invoice_date, buyerName: draft.buyer_name, buyerEmail: draft.buyer_email },
    notices: rows.map((row) => view(row, draft, row.buyer_notice_mail_id ? mailMap.get(row.buyer_notice_mail_id) ?? null : null)),
  };
}

export const einvoiceNoticeList = defineQuery({
  name: 'finance.einvoice.notice_list',
  input: zEInvoiceNoticeListInput,
  access: ALL,
  handler: async (ctx, input): Promise<EInvoiceNoticeList> => loadList(ctx, input.draftId.toLowerCase()),
});

export const einvoiceNoticeCommands = [einvoiceNoticeOpen, einvoiceNoticeStep, einvoiceNoticeSend, einvoiceNoticeMailSettle];
export const einvoiceNoticeQueries = [einvoiceNoticeList];
