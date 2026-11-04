// SPDX-License-Identifier: AGPL-3.0-only
// Issuing a sales e-invoice, the person's half (#2502, ADR-0044 points 3 and 4, plan einvoice-issue.md). Nothing here calls a provider: the approval moves a draft to
// `submitting`, and the job of the next step (a system context, never a person) takes it from there.
// - finance.einvoice.prepare_issue (owners, admins, members; R1): checks a draft and builds the request for approval from it: the draft must be a draft with its series and no issue,
//   its stored amounts must equal what its stored lines compute to, and the payload carries the hash of everything it is issued from (the database computes it) and its total. It
//   writes nothing; kernel.proposal.request stores the proposal. One open request per draft.
// - finance.einvoice.issue (R3 legal, a proposal command: runs only through kernel.proposal.approve, as the approver, in the approving transaction; owners and admins approve,
//   with four-eyes and the one-person path, judged on the members now): moves the draft to `submitting` through crove_finance.einvoice_submit, the one way a person does. The
//   database re-checks that this very approval was for this draft, this content and this total, and that the draft is untouched since (a draft changed after the request is refused).
// Agents never run either: neither declares an agent surface.
import { sql } from 'kysely';
import { z } from 'zod';
import { EINVOICE_ISSUE_COMMAND, EINVOICE_ISSUE_KIND, zEInvoiceIssuePayload, zId, type EInvoiceIssueView } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@crove/kernel-runtime';
import { money } from '@crove/l10n-vn';
import { computeDraft } from './domain/einvoice-draft.ts';
import { loadDraft } from './einvoice-drafts.ts';
import { connectionFor } from './einvoice-job.ts';
import { EINVOICE_ERROR_CODES } from './domain/einvoice-job.ts';
import { databaseToday } from './period-lock.ts';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const pgMessage = (error: unknown) => String((error as { message?: unknown } | null)?.message ?? '');

const changed = () => new DomainError('EINVOICE_DRAFT_CHANGED', 409, 'Bản nháp đã thay đổi từ lúc đề xuất này được tạo; hãy tạo đề xuất mới');

// A request for the draft as it stands now is open (waiting or being approved): a second for the same content is refused. A request made for an earlier state of the draft (it was
// edited since) can no longer be approved, so it does not stand in the way of a new one. Requests for one draft are serialized by a transaction-level advisory lock, so two at once
// cannot both pass (the second waits for the first to commit, then finds its proposal; this relies on READ COMMITTED, the runtime's isolation for commands).
async function lockDraftRequests(ctx: CommandContext, draftId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`${EINVOICE_ISSUE_COMMAND}:${draftId}`}, 0))`.execute(ctx.trx);
}
async function refuseOpenRequest(ctx: CommandContext, draftId: string, contentHash: string): Promise<void> {
  const open = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select('id')
    .where('org_id', '=', ctx.orgId)
    .where('command', '=', EINVOICE_ISSUE_COMMAND)
    .where('status', 'in', ['pending', 'approved'])
    .where(sql<string>`pg_catalog.lower(payload->>'draftId')`, '=', draftId)
    .where(sql<string>`payload->>'contentHash'`, '=', contentHash)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();
  if (open) throw new DomainError('EINVOICE_ISSUE_PENDING', 409, 'Hóa đơn này đã có đề xuất phát hành đang chờ duyệt', { proposalId: open.id });
}

export const einvoicePrepareIssue = defineCommand({
  name: 'finance.einvoice.prepare_issue',
  input: z.strictObject({ draftId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input) => {
    const draftId = input.draftId.toLowerCase();
    await lockDraftRequests(ctx, draftId);
    const draft = await loadDraft(ctx, draftId, await databaseToday(ctx.trx));
    if (draft.state !== 'draft') throw new DomainError('EINVOICE_NOT_DRAFT', 409, 'Hóa đơn này đã gửi đi, không phát hành lại được');
    if (draft.seriesId === null) throw new DomainError('EINVOICE_DRAFT_INVALID', 422, 'Chọn ký hiệu hóa đơn trước khi phát hành', { issues: draft.issues.map((i) => i.code) });
    if (draft.issues.length > 0) throw new DomainError('EINVOICE_DRAFT_INVALID', 422, 'Bản nháp chưa hợp lệ; sửa các lỗi trước khi phát hành', { issues: draft.issues.map((i) => i.code) });
    // What is stored is what the lines compute to: the totals, each line's amount and VAT. A draft whose stored figures disagree with its lines is never put to an approver.
    const computed = computeDraft(draft.lines.map((l) => ({ description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate })));
    const same = (a: string, b: string) => money(a).equals(money(b));
    if (
      computed.lines.length !== draft.lines.length ||
      !same(computed.subtotal, draft.subtotal) ||
      !same(computed.vatAmount, draft.vatAmount) ||
      !same(computed.total, draft.total) ||
      computed.lines.some((l, i) => !same(l.amount, draft.lines[i]?.amount ?? '0') || !same(l.vatAmount, draft.lines[i]?.vatAmount ?? '0'))
    ) {
      throw new DomainError('EINVOICE_DRAFT_MISMATCH', 409, 'Số tiền của bản nháp không khớp với các dòng của nó; hãy lưu lại bản nháp');
    }
    // The entity has a working connection to the series' provider under the tax code it has now, so nothing is asked of an approver that the job could not send.
    const ready = await connectionFor(ctx, { legal_entity_id: draft.legalEntityId, series_id: draft.seriesId, channel_connection_id: null }, true);
    if ('code' in ready) {
      if (ready.code === EINVOICE_ERROR_CODES.taxCodeNeeded) throw new DomainError('EINVOICE_TAX_CODE_NEEDED', 422, 'Hãy nhập mã số thuế của công ty trong Cài đặt trước khi phát hành hóa đơn');
      if (ready.code === EINVOICE_ERROR_CODES.sellerTaxCodeChanged) throw new DomainError('EINVOICE_TAX_CODE_MISMATCH', 422, 'Mã số thuế của công ty đã đổi so với kết nối nhà cung cấp; hãy kết nối lại với mã số thuế mới');
      throw new DomainError('EINVOICE_PROVIDER_NOT_READY', 409, 'Chưa có kết nối nhà cung cấp hóa đơn điện tử dùng được cho pháp nhân này; hãy kiểm tra mục Tích hợp trong Cài đặt');
    }
    const hash = (await sql<{ hash: string | null }>`SELECT crove_finance.einvoice_content_hash(${ctx.orgId}::uuid, ${draftId}::uuid) AS hash`.execute(ctx.trx)).rows[0]?.hash;
    if (!hash) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy bản nháp hóa đơn');
    await refuseOpenRequest(ctx, draftId, hash);
    return {
      kind: EINVOICE_ISSUE_KIND,
      command: EINVOICE_ISSUE_COMMAND,
      title: `Phát hành hóa đơn bán ra ${money(draft.total).toFixed()} ${draft.currency}`.slice(0, 300),
      // Parsed here as well as at the approval: a request the card or the approval could not read would sit in the Inbox stuck.
      payload: zEInvoiceIssuePayload.parse({ draftId, contentHash: hash, amount: money(draft.total).toFixed(), currency: draft.currency, lineCount: draft.lines.length }),
      // The proposal belongs to the draft's legal entity (#1538), and its payload does not name it.
      legalEntityId: draft.legalEntityId,
    };
  },
});

export const einvoiceIssue = defineCommand({
  // A literal, not EINVOICE_ISSUE_COMMAND: the job egress analysis reads a command's name from its source.
  name: 'finance.einvoice.issue',
  input: z.object({ payload: zEInvoiceIssuePayload, acceptFailedChecks: z.boolean().default(false) }),
  risk: 'R3',
  sideEffect: 'legal',
  access: 'proposal',
  proposalKind: EINVOICE_ISSUE_KIND,
  target: (input) => ({ type: 'finance.einvoice_draft', id: input.payload.draftId }),
  handler: async (ctx, { payload }): Promise<{ draftId: string; state: 'submitting' }> => {
    if (!ctx.proposalId || ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
    const draftId = payload.draftId.toLowerCase();
    // The draft is locked first; the definer takes the same lock, and a line is written only under a KEY SHARE of it, so what is read below is what is committed.
    const draft = await ctx.trx
      .selectFrom('crove_finance.einvoice_draft')
      .select(['legal_entity_id', 'state', 'total', 'currency'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', draftId)
      .forUpdate()
      .executeTakeFirst();
    if (!draft) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy bản nháp hóa đơn');
    if (draft.state !== 'draft') throw new DomainError('EINVOICE_NOT_DRAFT', 409, 'Hóa đơn này đã gửi đi, không phát hành lại được');
    // The proposal belongs to the entity the draft was in when it was asked for; the total and the currency it showed are the draft's now.
    const proposal = await ctx.trx.selectFrom('crove_kernel.proposal').select('legal_entity_id').where('org_id', '=', ctx.orgId).where('id', '=', ctx.proposalId).executeTakeFirst();
    if (proposal?.legal_entity_id !== draft.legal_entity_id || !money(payload.amount).equals(money(draft.total)) || payload.currency !== draft.currency) throw changed();
    try {
      await sql`SELECT crove_finance.einvoice_submit(${draftId}::uuid, ${payload.contentHash})`.execute(ctx.trx);
    } catch (error) {
      // The draft was edited after the request: a new request, not a retry.
      if (pgMessage(error).includes('EINVOICE_CONTENT_CHANGED')) throw changed();
      if (pgMessage(error).includes('EINVOICE_ISSUE_FORBIDDEN')) throw new DomainError('EINVOICE_ISSUE_FORBIDDEN', 403, 'Không phát hành được hóa đơn này theo đề xuất này');
      throw error;
    }
    ctx.audit({ draftId, legalEntityId: draft.legal_entity_id, total: money(draft.total).toFixed(), currency: draft.currency });
    // The worker's job takes it from here (ids only in the event).
    await ctx.emit('finance.einvoice_issue_requested', { draft_id: draftId });
    return { draftId, state: 'submitting' };
  },
});

// The request to issue a draft as the Inbox card shows it: the draft as it stands now and whether it is still the one the request was made for. Reads the proposal's payload and the
// draft under the caller's own policies, so a member who cannot see either sees nothing.
export const einvoiceIssueRequest = defineQuery({
  name: 'finance.einvoice.issue_request',
  input: z.strictObject({ proposalId: zId }),
  access: ['owner', 'admin', 'member'],
  handler: async (ctx, input): Promise<EInvoiceIssueView> => {
    const proposal = await ctx.trx
      .selectFrom('crove_kernel.proposal')
      .select('payload')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.proposalId.toLowerCase())
      .where('command', '=', EINVOICE_ISSUE_COMMAND)
      .executeTakeFirst();
    const payload = proposal ? zEInvoiceIssuePayload.safeParse(proposal.payload) : null;
    if (!payload?.success) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy bản nháp hóa đơn');
    const draftId = payload.data.draftId.toLowerCase();
    const draft = await loadDraft(ctx, draftId, await databaseToday(ctx.trx));
    const series = draft.seriesId
      ? await ctx.trx.selectFrom('crove_finance.einvoice_series').select(['template_no', 'symbol']).where('org_id', '=', ctx.orgId).where('id', '=', draft.seriesId).executeTakeFirst()
      : undefined;
    const hash = (await sql<{ hash: string | null }>`SELECT crove_finance.einvoice_content_hash(${ctx.orgId}::uuid, ${draftId}::uuid) AS hash`.execute(ctx.trx)).rows[0]?.hash;
    return {
      draftId,
      state: draft.state,
      date: draft.date,
      currency: draft.currency,
      total: draft.total,
      lineCount: draft.lines.length,
      buyerKind: draft.buyer.kind,
      buyerName: draft.buyer.name,
      buyerTaxCode: draft.buyer.taxCode,
      series: series ? `${series.template_no}/${series.symbol}` : null,
      subtotal: draft.subtotal,
      vatAmount: draft.vatAmount,
      lines: draft.lines,
      current: draft.state === 'draft' && hash === payload.data.contentHash,
    };
  },
});

export const einvoiceIssueCommands = [einvoicePrepareIssue, einvoiceIssue];
export const einvoiceIssueQueries = [einvoiceIssueRequest];
