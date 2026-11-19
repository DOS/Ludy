// SPDX-License-Identifier: AGPL-3.0-only
// Adjusting or replacing an issued sales e-invoice, the person's half (#2504, plan einvoice-issue.md section 8, the accountant's answers of section 3b). Nothing here calls a provider and
// nothing is issued: the command makes a correcting draft that points at the issued invoice, and the draft goes through the same prepare, approve (R3) and job as any invoice, the job
// calling `adjust` or `replace` with the original's reference (einvoice-job.ts). The intake of the signed XML links the new invoice and, for a replacement, voids the original in the
// transaction that posts it (#916). There is no cancel action: an issued invoice is only ever corrected by one of the two.
// - finance.einvoice.start_correction (owners, admins, members; R1): refused unless the original is issued here and is the invoice in force (not itself replaced, not an adjusting invoice);
//   one correction of an original is open at a time; a later correction keeps the method of the first (adjust stays adjust); the reason code is one of Appendix XVII (refused while the list
//   is empty, #3571); a buyer with a tax code needs the signed agreement file ("biên bản thỏa thuận", the accountant's answer to #2506 question 2), an individual buyer none. The person also says what
//   the correction is about (`rateNature`) and confirms the basis the screen proposed for the VAT rate (`rateBasis`, #3709): the code works the basis out from the nature (domain/einvoice-correction-rate.ts)
//   and refuses a different one, and a replacement copy carries the rate that basis gives.
// - finance.einvoice.correction_rate (owners, admins, members; read only): the proposal for a nature, with the fixed reason and the precedent note (#3709).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { computeLineTotals, money, normalizeVatRate, sumLineTotals } from '@crove/l10n-vn';
import { ADJUST_REPLACE_REASON_CODES, isReasonCode, type ReasonCode } from '@crove/einvoice';
import { zEInvoiceCorrectionRateInput, zEInvoiceReasonSourceInput, zEInvoiceStartCorrection, type EInvoiceCorrectionOptions, type EInvoiceCorrectionRate, type EInvoiceDraft, type EInvoiceRateNature, type EInvoiceReasonSource } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { CORRECTION_RATE_PRECEDENT_NOTE, correctionRateReason, proposeCorrectionRate, proposeCorrectionRates, reducedEnd, type CorrectionRateProposal } from './domain/einvoice-correction-rate.ts';
import { loadDraft } from './einvoice-drafts.ts';
import { databaseToday } from './period-lock.ts';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// The reason codes a correction may carry: the package's list, which a test replaces (the list is empty until Appendix XVII is read, so no real correction passes before then).
let reasonCodes: readonly ReasonCode[] | null = null;
export function useCorrectionReasonCodes(list: readonly ReasonCode[] | null): void {
  reasonCodes = list;
}
export const correctionReasonCodes = (): readonly ReasonCode[] => reasonCodes ?? ADJUST_REPLACE_REASON_CODES.codes;

// A decimal read from the database (numeric keeps its scale: '200000.0000') as the API writes it ('200000').
const plain = (value: string): string => money(value).toFixed();
const dayOf = (value: string | Date): string => (typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10));

// The proposal for an original and a nature, worked out on the day of the database (#3709): the distinct VAT rates of the original's lines, the basis, the rates that move.
async function proposalFor(ctx: Pick<QueryContext, 'trx' | 'orgId'>, originalId: string, originalDate: string, nature: EInvoiceRateNature, today: string): Promise<{ proposal: CorrectionRateProposal; has8: boolean }> {
  const rows = await ctx.trx.selectFrom('crove_finance.einvoice_draft_line').select('vat_rate').where('org_id', '=', ctx.orgId).where('draft_id', '=', originalId).orderBy('line_no').execute();
  const rates = rows.map((r) => r.vat_rate);
  return { proposal: proposeCorrectionRates({ nature, rates, originalDate, correctionDate: today }), has8: rates.some((r) => (normalizeVatRate(r) ?? r) === '8%') };
}

export const einvoiceStartCorrection = defineCommand({
  name: 'finance.einvoice.start_correction',
  input: zEInvoiceStartCorrection,
  // A working copy, like any draft: it is undone by deleting it, and issuing it is the R3 approval.
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'finance.einvoice_draft', id: input.originalDraftId }),
  handler: async (ctx, input): Promise<EInvoiceDraft> => {
    const originalId = input.originalDraftId.toLowerCase();
    // The original is locked: two corrections of one invoice start one after the other.
    const original = await ctx.trx
      .selectFrom('crove_finance.einvoice_draft')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', originalId)
      .forUpdate()
      .executeTakeFirst();
    if (!original) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy hóa đơn gốc');
    if (original.state !== 'issued' || original.issued_number === null) throw new DomainError('EINVOICE_ORIGINAL_NOT_ISSUED', 409, 'Chỉ điều chỉnh hoặc thay thế được hóa đơn đã phát hành');
    if (original.correction_kind === 'adjustment') {
      throw new DomainError('EINVOICE_ORIGINAL_IS_ADJUSTMENT', 409, 'Đây là hóa đơn điều chỉnh; hãy điều chỉnh hoặc thay thế hóa đơn mà nó điều chỉnh');
    }

    const others = await ctx.trx
      .selectFrom('crove_finance.einvoice_draft')
      .select(['id', 'state', 'correction_kind'])
      .where('org_id', '=', ctx.orgId)
      .where('original_draft_id', '=', originalId)
      .execute();
    // An invoice that was itself replaced is no longer in force: it is corrected through its replacement.
    if (others.some((o) => o.correction_kind === 'replacement' && o.state === 'issued')) {
      throw new DomainError('EINVOICE_ORIGINAL_REPLACED', 409, 'Hóa đơn này đã được thay thế; hãy điều chỉnh hoặc thay thế hóa đơn thay thế nó');
    }
    // One correction is open at a time: a draft, an invoice being sent or one that waits for the tax authority. A rejected one went back to a draft, so it is open too.
    const open = others.find((o) => o.state !== 'issued');
    if (open) throw new DomainError('EINVOICE_CORRECTION_OPEN', 409, 'Hóa đơn này đã có một hóa đơn điều chỉnh hoặc thay thế đang làm dở', { draftId: open.id });
    // The same method as the first correction for the same error (Circular 91 Art. 10, as read for #2506).
    const first = others.find((o) => o.state === 'issued')?.correction_kind;
    if (first && first !== input.kind) {
      throw new DomainError('EINVOICE_CORRECTION_METHOD', 409, first === 'adjustment' ? 'Lần sửa trước là điều chỉnh, các lần sau cũng phải điều chỉnh' : 'Lần sửa trước là thay thế, các lần sau cũng phải thay thế');
    }

    const list = correctionReasonCodes();
    if (!isReasonCode(input.reasonCode, list)) {
      throw new DomainError('EINVOICE_REASON_CODE_INVALID', 422, list.length === 0 ? 'Chưa có danh sách mã lý do điều chỉnh hoặc thay thế, nên chưa lập được' : 'Mã lý do không có trong danh sách');
    }

    // A buyer with a tax code (a business) signs an agreement first; an individual needs none.
    let agreement: string | null = null;
    if (input.agreementFileId) {
      agreement = input.agreementFileId.toLowerCase();
      const file = await ctx.trx.selectFrom('crove_kernel.file').select('id').where('org_id', '=', ctx.orgId).where('id', '=', agreement).where('source', '=', 'agreement').executeTakeFirst();
      if (!file) throw new DomainError('EINVOICE_AGREEMENT_FILE_NOT_FOUND', 404, 'Không tìm thấy tệp biên bản thỏa thuận');
    } else if (original.buyer_kind === 'business') {
      throw new DomainError('EINVOICE_AGREEMENT_REQUIRED', 422, 'Người mua là doanh nghiệp: hãy đính kèm biên bản thỏa thuận đã ký của hai bên trước khi điều chỉnh hoặc thay thế');
    }

    const today = await databaseToday(ctx.trx);
    // The VAT rate of the correcting invoice (#3709): the person says what the correction is about and confirms the basis the screen proposed; the code works the basis out itself, so a stale
    // screen cannot confirm one that no longer holds, and a 2027 correction of an amount at 8% is refused by the draft's own check.
    const { proposal } = await proposalFor(ctx, originalId, dayOf(original.invoice_date), input.rateNature, today);
    if (input.rateBasis !== proposal.basis) {
      throw new DomainError('EINVOICE_RATE_BASIS_MISMATCH', 422, 'Cách tính thuế suất không khớp với loại sai sót đã chọn; hãy tải lại màn hình và xác nhận lại');
    }
    const draftId = randomUUID();
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
    const replacement = input.kind === 'replacement';
    // A replacement starts as a copy to edit; an adjustment starts empty, the difference per line is typed with its sign. The order links of a line are not carried: the order line stays
    // invoiced by the original.
    const copied = replacement
      ? await ctx.trx.selectFrom('crove_finance.einvoice_draft_line').selectAll().where('org_id', '=', ctx.orgId).where('draft_id', '=', originalId).orderBy('line_no').execute()
      : [];
    // A replacement that follows the correction's own date carries the rate that date gives each line, its amounts worked again by code (8% becomes 10% after 2026-12-31); on the original basis the
    // lines are copied as they are.
    const lines = copied.map((line) => {
      const rate = proposal.basis === 'correction_date' ? proposeCorrectionRate({ nature: input.rateNature, rate: line.vat_rate, originalDate: dayOf(original.invoice_date), correctionDate: today }).rate : line.vat_rate;
      if (rate === line.vat_rate) return line;
      const worked = computeLineTotals({ quantity: plain(line.quantity), unitPrice: plain(line.unit_price), vatRate: rate });
      return { ...line, vat_rate: worked.vatRate, amount: worked.amount, vat_amount: worked.vatAmount };
    });
    const totals = replacement ? sumLineTotals(lines.map((l) => ({ amount: plain(l.amount), vatAmount: plain(l.vat_amount) }))) : null;
    await ctx.trx
      .insertInto('crove_finance.einvoice_draft')
      .values({
        org_id: ctx.orgId,
        id: draftId,
        legal_entity_id: original.legal_entity_id,
        created_by: userId,
        series_id: original.series_id,
        invoice_date: today,
        currency: original.currency,
        buyer_kind: original.buyer_kind,
        buyer_party_id: original.buyer_party_id,
        buyer_tax_code: original.buyer_tax_code,
        buyer_name: original.buyer_name,
        buyer_address: original.buyer_address,
        buyer_email: original.buyer_email,
        subtotal: totals ? totals.subtotal : '0',
        vat_amount: totals ? totals.vatAmount : '0',
        total: totals ? totals.total : '0',
        correction_kind: input.kind,
        original_draft_id: originalId,
        reason_code: input.reasonCode,
        agreement_file_id: agreement,
        correction_rate_basis: proposal.basis,
      })
      .execute();
    for (const line of lines) {
      await ctx.trx
        .insertInto('crove_finance.einvoice_draft_line')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: original.legal_entity_id,
          draft_id: draftId,
          line_no: line.line_no,
          description: line.description,
          unit: line.unit,
          quantity: line.quantity,
          unit_price: line.unit_price,
          amount: line.amount,
          vat_rate: line.vat_rate,
          vat_amount: line.vat_amount,
        })
        .execute();
    }
    // Ids and the method only: no buyer detail, no amount.
    ctx.audit({ draftId, originalDraftId: originalId, kind: input.kind, reasonCode: input.reasonCode, agreementFileId: agreement, legalEntityId: original.legal_entity_id, rateNature: input.rateNature, rateBasis: proposal.basis });
    return loadDraft(ctx, draftId, today);
  },
});

// The reason codes of Appendix XVII, for the screen's picker (#2504). Read-only; no org data.
export const einvoiceCorrectionOptions = defineQuery({
  name: 'finance.einvoice.correction_options',
  input: z.strictObject({}),
  access: EDITORS,
  handler: async (): Promise<EInvoiceCorrectionOptions> => ({ reasonCodes: correctionReasonCodes().map((c) => ({ code: c.code, label: c.label })) }),
});

// The VAT rate a correction proposes for the nature a person picked (#3709): by code only, from the original's own lines and the date of the database. The screen shows it with the fixed reason and
// the precedent note, the accounting coworker may explain it in the API layer, and the person confirms by starting the correction (`rateBasis`).
export const einvoiceCorrectionRate = defineQuery({
  name: 'finance.einvoice.correction_rate',
  input: zEInvoiceCorrectionRateInput,
  access: EDITORS,
  handler: async (ctx, input): Promise<EInvoiceCorrectionRate> => {
    const original = await ctx.trx
      .selectFrom('crove_finance.einvoice_draft')
      .select(['invoice_date', 'state', 'issued_number'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.originalDraftId.toLowerCase())
      .executeTakeFirst();
    if (!original) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy hóa đơn gốc');
    if (original.state !== 'issued' || original.issued_number === null) throw new DomainError('EINVOICE_ORIGINAL_NOT_ISSUED', 409, 'Chỉ điều chỉnh hoặc thay thế được hóa đơn đã phát hành');
    const today = await databaseToday(ctx.trx);
    const originalDate = dayOf(original.invoice_date);
    const { proposal, has8 } = await proposalFor(ctx, input.originalDraftId.toLowerCase(), originalDate, input.nature, today);
    return {
      nature: proposal.nature,
      basis: proposal.basis,
      originalDate,
      correctionDate: today,
      reasonCode: proposal.reasonCode,
      changes: proposal.changes,
      kept: proposal.kept,
      reducedUntil: reducedEnd(),
      reason: correctionRateReason(proposal, today),
      precedentNote: has8 ? CORRECTION_RATE_PRECEDENT_NOTE : null,
    };
  },
});

// What the accounting coworker may see when it proposes the reason code of a correction (#3690): the list of codes, the buyer's KIND and the original's lines without a price or an amount, read in the
// member's own transaction (the row policies of the draft tables decide what the caller sees). No name, address, tax code, email or ID of the buyer, no number of the invoice, no amount, nothing stored. The
// model is asked outside any transaction, by the API (apps/kernel einvoice-reason-ai.ts). Only an invoice issued here has a source; any other is the same not-found as in `start_correction`.
export const einvoiceReasonSource = defineQuery({
  name: 'finance.einvoice.reason_source',
  input: zEInvoiceReasonSourceInput,
  access: EDITORS,
  handler: async (ctx, input): Promise<EInvoiceReasonSource> => {
    const originalId = input.originalDraftId.toLowerCase();
    const original = await ctx.trx
      .selectFrom('crove_finance.einvoice_draft')
      .select(['invoice_date', 'state', 'issued_number', 'buyer_kind'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', originalId)
      .executeTakeFirst();
    if (!original) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy hóa đơn gốc');
    if (original.state !== 'issued' || original.issued_number === null) throw new DomainError('EINVOICE_ORIGINAL_NOT_ISSUED', 409, 'Chỉ điều chỉnh hoặc thay thế được hóa đơn đã phát hành');
    const lines = await ctx.trx
      .selectFrom('crove_finance.einvoice_draft_line')
      .select(['description', 'unit', 'quantity', 'vat_rate'])
      .where('org_id', '=', ctx.orgId)
      .where('draft_id', '=', originalId)
      .orderBy('line_no')
      .execute();
    return {
      codes: correctionReasonCodes().map((c) => ({ code: c.code, label: c.label })),
      buyerKind: original.buyer_kind,
      originalDate: dayOf(original.invoice_date),
      lines: lines.map((l) => ({ description: l.description, unit: l.unit, quantity: plain(l.quantity), vatRate: l.vat_rate })),
    };
  },
});

export const einvoiceCorrectionCommands = [einvoiceStartCorrection];
export const einvoiceCorrectionQueries = [einvoiceCorrectionOptions, einvoiceCorrectionRate, einvoiceReasonSource];
