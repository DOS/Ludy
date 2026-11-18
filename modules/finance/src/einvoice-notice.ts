// SPDX-License-Identifier: AGPL-3.0-only
// The notice of an error only in the non-core content of an issued sales e-invoice (#2504, plan einvoice-issue.md section 8; the accountant's answers of section 3a row 7 and 3b): the buyer's
// name or address, or the amount in words. No new invoice is made and the invoice is not cancelled. The seller tells the buyer ("Gửi thông báo cho người mua") and, as the working answer of
// #2506 question 1 (not confirmed by the accountant yet), files the form 04/SS-HĐĐT with the tax authority. Both are the seller's own steps outside Ludy: Ludy sends nothing here, it records
// the error, builds the text of the notice by code (never a model) and tracks the two steps until a person ticks each.
// - finance.einvoice.notice_open (owners, admins, members; R1): records an error on an issued invoice with the text that is right.
// - finance.einvoice.notice_step (same roles; R1): ticks one step, once; ticking again changes nothing.
// - finance.einvoice.notice_list: the notices of an invoice and what the notice text names (read only).
import { zEInvoiceNoticeListInput, zEInvoiceNoticeOpen, zEInvoiceNoticeStep, type EInvoiceNotice, type EInvoiceNoticeList } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

function view(row: { id: string; draft_id: string; field: string; correct_text: string; buyer_notice_state: string; buyer_notified_at: Date | string | null; form_state: string; form_filed_at: Date | string | null; created_at: Date | string }): EInvoiceNotice {
  return {
    id: row.id,
    draftId: row.draft_id,
    field: row.field as EInvoiceNotice['field'],
    correctText: row.correct_text,
    buyerNoticeState: row.buyer_notice_state as EInvoiceNotice['buyerNoticeState'],
    buyerNotifiedAt: iso(row.buyer_notified_at),
    formState: row.form_state as EInvoiceNotice['formState'],
    formFiledAt: iso(row.form_filed_at),
    createdAt: iso(row.created_at) as string,
  };
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
    const draft = await ctx.trx
      .selectFrom('crove_finance.einvoice_draft')
      .select(['legal_entity_id', 'state', 'issued_number'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.draftId.toLowerCase())
      .forShare()
      .executeTakeFirst();
    if (!draft) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy hóa đơn');
    if (draft.state !== 'issued' || draft.issued_number === null) throw new DomainError('EINVOICE_ORIGINAL_NOT_ISSUED', 409, 'Chỉ ghi nhận sai sót cho hóa đơn đã phát hành');
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const row = await ctx.trx
      .insertInto('crove_finance.einvoice_notice')
      .values({ org_id: ctx.orgId, legal_entity_id: draft.legal_entity_id, draft_id: input.draftId.toLowerCase(), field: input.field, correct_text: input.correctText, created_by: userId })
      .returningAll()
      .executeTakeFirstOrThrow();
    // Ids and the field only: the text that is right can be a buyer's name or address.
    ctx.audit({ noticeId: row.id, draftId: row.draft_id, field: row.field, legalEntityId: row.legal_entity_id });
    return view(row);
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
      .selectFrom('crove_finance.einvoice_notice')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.noticeId.toLowerCase())
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw notFound();
    const done = input.step === 'buyer_notice' ? existing.buyer_notice_state === 'sent' : existing.form_state === 'filed';
    if (done) return view(existing);
    const row = await ctx.trx
      .updateTable('crove_finance.einvoice_notice')
      .set(input.step === 'buyer_notice' ? { buyer_notice_state: 'sent', buyer_notified_at: ctx.now } : { form_state: 'filed', form_filed_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    ctx.audit({ noticeId: row.id, draftId: row.draft_id, step: input.step });
    return view(row);
  },
});

async function loadList(ctx: Ctx, draftId: string): Promise<EInvoiceNoticeList> {
  const draft = await ctx.trx
    .selectFrom('crove_finance.einvoice_draft as d')
    .leftJoin('crove_finance.einvoice_series as s', (join) => join.onRef('s.org_id', '=', 'd.org_id').onRef('s.id', '=', 'd.series_id'))
    .select(['d.issued_number', 'd.invoice_date', 'd.buyer_name', 'd.buyer_email', 's.template_no', 's.symbol', 'd.state'])
    .where('d.org_id', '=', ctx.orgId)
    .where('d.id', '=', draftId)
    .executeTakeFirst();
  if (!draft || draft.state !== 'issued' || draft.issued_number === null) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy hóa đơn');
  const rows = await ctx.trx.selectFrom('crove_finance.einvoice_notice').selectAll().where('org_id', '=', ctx.orgId).where('draft_id', '=', draftId).orderBy('created_at').orderBy('id').execute();
  return {
    reference: { number: draft.issued_number, templateNo: draft.template_no ?? null, symbol: draft.symbol ?? null, date: draft.invoice_date, buyerName: draft.buyer_name, buyerEmail: draft.buyer_email },
    notices: rows.map(view),
  };
}

export const einvoiceNoticeList = defineQuery({
  name: 'finance.einvoice.notice_list',
  input: zEInvoiceNoticeListInput,
  access: ALL,
  handler: async (ctx, input): Promise<EInvoiceNoticeList> => loadList(ctx, input.draftId.toLowerCase()),
});

export const einvoiceNoticeCommands = [einvoiceNoticeOpen, einvoiceNoticeStep];
export const einvoiceNoticeQueries = [einvoiceNoticeList];
