// SPDX-License-Identifier: AGPL-3.0-only
// Sales e-invoice drafts and their series (#2500, ADR-0044, plan einvoice-issue.md sections 6 and 8). Nothing here calls a provider
// over a network and nothing issues an invoice: a draft is made, edited, checked and deleted, and a series is read from the offline
// sandbox provider (a real provider's series arrive with the Tích hợp step).
// - finance.einvoice_series.sync (owners and admins; R1): reads the templates and series the provider holds and adds those the
//   entity does not have yet; the first is the entity's default. The sandbox is the only provider; whether it is on is the RPC
//   route's check (EINVOICE_SANDBOX), as for the bank feed sandbox.
// - finance.einvoice_series.list / finance.einvoice_draft.list / .get / .check: every member reads.
// - finance.einvoice_draft.save (owners, admins, members; R1): creates or replaces a draft. The input carries no total, no amount
//   and no VAT figure: they are computed here from the lines by decimal arithmetic and a caller that sends one is refused by the
//   strict schema. A draft that fails a check is saved all the same; the issues are shown and only issuing needs none.
// - finance.einvoice_draft.delete (same roles; R1): deletes a draft that is still a draft.
// The database holds the same rules (state guard, entity of the series, total = subtotal + VAT); the checks here come first so the
// refusal says what to do.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { SANDBOX_EINVOICE_SECRET, createSandboxEInvoiceProvider } from '@ludy/einvoice';
import { zEInvoiceDraftCheckInput, zEInvoiceDraftSave, zEInvoiceSeriesSync, zId, type EInvoiceDraft, type EInvoiceDraftCheck, type EInvoiceDraftLine, type EInvoiceDraftSummary, type EInvoiceSeries, type EInvoiceSeriesSynced } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { buyerNameOnInvoice, money, parseTaxCode } from '@ludy/l10n-vn';
import { checkDraft, computeDraft, isLateSale, isNationalityCode, maskBuyerIdentity, type ComputedDraft, type DraftInput } from './domain/einvoice-draft.ts';
import { correctionRateDate } from './domain/einvoice-correction-rate.ts';
import { einvoiceDraftSuggestSource, einvoicePreviousInvoice } from './einvoice-suggest.ts';
import { resolveLegalEntity } from './legal-entity.ts';
import { databaseToday } from './period-lock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const pgCode = (error: unknown) => (error as { code?: string } | null)?.code;

type Ctx = Pick<QueryContext, 'trx' | 'orgId'>;

// A decimal read from the database (numeric keeps its scale: '200000.0000') as the API writes it ('200000').
const plain = (value: string): string => money(value).toFixed();

export async function loadSeries(ctx: Ctx): Promise<EInvoiceSeries[]> {
  const rows = await ctx.trx
    .selectFrom('ludy_finance.einvoice_series')
    .select(['id', 'legal_entity_id', 'provider', 'template_no', 'symbol', 'description', 'is_default'])
    .where('org_id', '=', ctx.orgId)
    .orderBy('legal_entity_id')
    .orderBy('template_no')
    .orderBy('symbol')
    .execute();
  return rows.map((r) => ({ id: r.id, legalEntityId: r.legal_entity_id, provider: r.provider, templateNo: r.template_no, symbol: r.symbol, description: r.description, isDefault: r.is_default }));
}

export const einvoiceSeriesList = defineQuery({
  name: 'finance.einvoice_series.list',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<EInvoiceSeries[]> => loadSeries(ctx),
});

// Adds the templates and series a provider holds that the entity does not have yet; the first series an entity ever gets is its default. The caller holds the
// entity's lock (two syncs of one entity wait for each other, so neither adds a row the other already did nor a second default).
export async function addSeriesFrom(
  ctx: Pick<QueryContext, 'trx' | 'orgId' | 'actor'>,
  entity: string,
  provider: string,
  templates: ReadonlyArray<{ templateNo: string; symbol: string; description: string }>,
): Promise<number> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`finance.einvoice_series:${ctx.orgId}:${entity}`}, 0))`.execute(ctx.trx);
  // The default is the entity's, whatever provider holds it: only the first series an entity ever gets is made the default.
  const existing = await ctx.trx
    .selectFrom('ludy_finance.einvoice_series')
    .select(['provider', 'template_no', 'symbol', 'is_default'])
    .where('org_id', '=', ctx.orgId)
    .where('legal_entity_id', '=', entity)
    .execute();
  let hasDefault = existing.some((r) => r.is_default);
  const known = new Set(existing.filter((r) => r.provider === provider).map((r) => `${r.template_no}/${r.symbol}`));
  const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;
  let added = 0;
  for (const template of templates) {
    if (known.has(`${template.templateNo}/${template.symbol}`)) continue;
    known.add(`${template.templateNo}/${template.symbol}`);
    await ctx.trx
      .insertInto('ludy_finance.einvoice_series')
      .values({ org_id: ctx.orgId, legal_entity_id: entity, provider, template_no: template.templateNo, symbol: template.symbol, description: template.description, is_default: !hasDefault, created_by: userId })
      .execute();
    hasDefault = true;
    added += 1;
  }
  return added;
}

export const einvoiceSeriesSync = defineCommand({
  name: 'finance.einvoice_series.sync',
  input: zEInvoiceSeriesSync,
  // It adds rows that name a template and a symbol the provider already holds; no invoice, no money.
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  handler: async (ctx, input): Promise<EInvoiceSeriesSynced> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    const { provider } = createSandboxEInvoiceProvider();
    const templates = await provider.listTemplates(SANDBOX_EINVOICE_SECRET);
    const added = await addSeriesFrom(ctx, entity, input.provider, templates);
    ctx.audit({ legalEntityId: entity, provider: input.provider, added });
    return { added, series: (await loadSeries(ctx)).filter((s) => s.legalEntityId === entity) };
  },
});

const selectDrafts = (ctx: Ctx) => ctx.trx.selectFrom('ludy_finance.einvoice_draft').selectAll().where('org_id', '=', ctx.orgId);
const selectLines = (ctx: Ctx) => ctx.trx.selectFrom('ludy_finance.einvoice_draft_line').selectAll().where('org_id', '=', ctx.orgId);
type DraftRow = Awaited<ReturnType<ReturnType<typeof selectDrafts>['execute']>>[number];
type LineRow = Awaited<ReturnType<ReturnType<typeof selectLines>['execute']>>[number];

// The identity an individual buyer gave, from a draft's row (both columns or neither).
// A passport's nationality (#3709) comes with it.
const identityOf = (row: Pick<DraftRow, 'buyer_identity_kind' | 'buyer_identity' | 'buyer_nationality'>) =>
  row.buyer_identity_kind && row.buyer_identity ? { kind: row.buyer_identity_kind, value: row.buyer_identity, nationality: row.buyer_nationality } : null;

// The day the 8% of a correcting draft's lines is judged on (#2504, #3709): the original's date, unless the person confirmed that the rate follows the correction's own date.
const rateDateOf = (row: Pick<DraftRow, 'correction_rate_basis' | 'invoice_date'>, originalDate: string | null): string | null => correctionRateDate(row.correction_rate_basis, originalDate, row.invoice_date);

// A draft as the API gives it, from its row and its line rows: the amounts as the API writes them, and the checks run on what is stored.
// `rateDate` is the invoice date of the original a correcting draft corrects (#2504), or the draft's own invoice date when the rate follows the correction's date (#3709, `rateDateOf`).
function buildDraft(row: DraftRow, lineRows: readonly LineRow[], today: string, rateDate: string | null = null): EInvoiceDraft {
  const lines: EInvoiceDraftLine[] = [...lineRows]
    .sort((x, y) => x.line_no - y.line_no)
    .map((l) => ({
      lineNo: l.line_no,
      description: l.description,
      unit: l.unit,
      quantity: plain(l.quantity),
      unitPrice: plain(l.unit_price),
      amount: plain(l.amount),
      vatRate: l.vat_rate,
      vatAmount: plain(l.vat_amount),
    }));
  const input: DraftInput = {
    date: row.invoice_date,
    saleDate: row.sale_date,
    lateReason: row.late_reason,
    currency: row.currency,
    seriesId: row.series_id,
    buyer: { kind: row.buyer_kind, taxCode: row.buyer_tax_code, name: row.buyer_name, address: row.buyer_address, email: row.buyer_email, identity: identityOf(row) },
    lines: lines.map((l) => ({ description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate })),
    adjustment: row.correction_kind === 'adjustment',
    rateDate,
  };
  const computed: ComputedDraft = { lines: lines.map((l) => ({ ...l })), subtotal: plain(row.subtotal), vatAmount: plain(row.vat_amount), total: plain(row.total) };
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    state: row.state,
    seriesId: row.series_id,
    date: row.invoice_date,
    saleDate: row.sale_date,
    lateReason: row.late_reason,
    lateSale: isLateSale(row.sale_date, row.invoice_date),
    currency: row.currency,
    buyer: { kind: row.buyer_kind, partyId: row.buyer_party_id, taxCode: row.buyer_tax_code, name: row.buyer_name, address: row.buyer_address, email: row.buyer_email, identity: identityOf(row) },
    lines,
    subtotal: plain(row.subtotal),
    vatAmount: plain(row.vat_amount),
    total: plain(row.total),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    issues: checkDraft(input, computed, today),
    issuedNumber: row.issued_number,
    errorCode: row.error_code,
    correction:
      row.correction_kind === 'adjustment' || row.correction_kind === 'replacement'
        ? { kind: row.correction_kind, originalDraftId: row.original_draft_id as string, reasonCode: row.reason_code as string, agreementFileId: row.agreement_file_id, rateBasis: row.correction_rate_basis }
        : null,
  };
}

export async function loadDraft(ctx: Ctx, id: string, today: string): Promise<EInvoiceDraft> {
  const row = await selectDrafts(ctx).where('id', '=', id).executeTakeFirst();
  if (!row) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy bản nháp hóa đơn');
  const original = row.original_draft_id ? await selectDrafts(ctx).select('invoice_date').where('id', '=', row.original_draft_id).executeTakeFirst() : undefined;
  return buildDraft(row, await selectLines(ctx).where('draft_id', '=', id).execute(), today, rateDateOf(row, original?.invoice_date ?? null));
}

export const einvoiceDraftList = defineQuery({
  name: 'finance.einvoice_draft.list',
  // The entity on screen; left out, every draft the caller may see.
  input: z.object({ legalEntityId: zId.optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<EInvoiceDraftSummary[]> => {
    const today = await databaseToday(ctx.trx);
    let list = selectDrafts(ctx);
    if (input.legalEntityId) list = list.where('legal_entity_id', '=', input.legalEntityId);
    const rows = await list.orderBy('invoice_date', 'desc').orderBy('id', 'desc').limit(200).execute();
    // The lines of all of them in one read.
    const lines = rows.length === 0 ? [] : await selectLines(ctx).where('draft_id', 'in', rows.map((r) => r.id)).execute();
    // The dates of the originals the correcting drafts of this page correct, in one read.
    const originalIds = [...new Set(rows.flatMap((r) => (r.original_draft_id ? [r.original_draft_id] : [])))];
    const originals = new Map(
      originalIds.length === 0 ? [] : (await selectDrafts(ctx).select(['id', 'invoice_date']).where('id', 'in', originalIds).execute()).map((o) => [o.id, o.invoice_date] as const),
    );
    // The issued corrections of the issued invoices of this page, in one read: the method of the first one (the next correction keeps it) and whether the invoice was replaced (#2504). The
    // corrections are looked for beyond the page: a correction made later is not among the 200 newest only when the invoice is old, and the original is then on this page.
    const issuedIds = rows.filter((r) => r.state === 'issued').map((r) => r.id);
    const corrections =
      issuedIds.length === 0
        ? []
        : await ctx.trx
            .selectFrom('ludy_finance.einvoice_draft')
            .select(['original_draft_id', 'correction_kind', 'created_at'])
            .where('org_id', '=', ctx.orgId)
            .where('state', '=', 'issued')
            .where('original_draft_id', 'in', issuedIds)
            .orderBy('created_at')
            .execute();
    const firstKind = new Map<string, 'adjustment' | 'replacement'>();
    const replaced = new Set<string>();
    for (const c of corrections) {
      if (!c.original_draft_id || (c.correction_kind !== 'adjustment' && c.correction_kind !== 'replacement')) continue;
      if (!firstKind.has(c.original_draft_id)) firstKind.set(c.original_draft_id, c.correction_kind);
      if (c.correction_kind === 'replacement') replaced.add(c.original_draft_id);
    }
    return rows.map((row) => {
      const draft = buildDraft(row, lines.filter((l) => l.draft_id === row.id), today, rateDateOf(row, row.original_draft_id ? (originals.get(row.original_draft_id) ?? null) : null));
      return {
        id: row.id,
        state: row.state,
        date: row.invoice_date,
        // A consumer gave no name: the list says what the invoice will say (#3709).
        buyerName: buyerNameOnInvoice(row.buyer_kind, row.buyer_name),
        buyerIdentity: ((identity) => (identity ? { kind: identity.kind, masked: maskBuyerIdentity(identity.value) } : null))(identityOf(row)),
        total: plain(row.total),
        issueCount: draft.issues.length,
        issuedNumber: row.issued_number,
        errorCode: row.error_code,
        evidenceStored: row.signed_file_id !== null,
        updatedAt: new Date(row.updated_at).toISOString(),
        buyerKind: row.buyer_kind,
        correction:
          (row.correction_kind === 'adjustment' || row.correction_kind === 'replacement') && row.original_draft_id ? { kind: row.correction_kind, originalDraftId: row.original_draft_id } : null,
        correctedBy: firstKind.get(row.id) ?? null,
        replaced: replaced.has(row.id),
      };
    });
  },
});

export const einvoiceDraftGet = defineQuery({
  name: 'finance.einvoice_draft.get',
  input: z.object({ draftId: zId }),
  access: ALL,
  handler: async (ctx, input): Promise<EInvoiceDraft> => loadDraft(ctx, input.draftId, await databaseToday(ctx.trx)),
});

// The amounts and the issues of what the form holds, without saving it: the form's live check. Nothing is read or written.
export const einvoiceDraftCheck = defineQuery({
  name: 'finance.einvoice_draft.check',
  input: zEInvoiceDraftCheckInput,
  access: EDITORS,
  handler: async (ctx, input): Promise<EInvoiceDraftCheck> => {
    const today = await databaseToday(ctx.trx);
    const draft = toDraftInput(input);
    // A correction is checked as it will be stored: signed prices for an adjustment, and the rate day of its original (#2504).
    if (input.correction) {
      draft.adjustment = input.correction.kind === 'adjustment';
      const original = await selectDrafts(ctx).select('invoice_date').where('id', '=', input.correction.originalDraftId).executeTakeFirst();
      draft.rateDate = correctionRateDate(input.correction.rateBasis, original?.invoice_date ?? null, input.date);
    }
    const computed = computeDraft(draft.lines);
    return {
      lines: computed.lines.map((l, i) => ({ lineNo: i + 1, description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, amount: l.amount, vatRate: l.vatRate, vatAmount: l.vatAmount })),
      subtotal: computed.subtotal,
      vatAmount: computed.vatAmount,
      total: computed.total,
      issues: checkDraft(draft, computed, today),
      lateSale: isLateSale(draft.saleDate, draft.date),
    };
  },
});

export function toDraftInput(input: Pick<z.infer<typeof zEInvoiceDraftSave>, 'date' | 'seriesId' | 'buyer' | 'lines'> & Partial<Pick<z.infer<typeof zEInvoiceDraftSave>, 'saleDate' | 'lateReason'>>): DraftInput {
  const blank = (value: string | null): string | null => (value && value.trim() !== '' ? value.trim() : null);
  // A tax code that reads as one is kept in its written form (spaces and dots out, a branch code with its dash); one that does not is kept as typed, for the checks to report.
  const taxCode = (value: string | null): string | null => {
    const text = blank(value);
    return text === null ? null : (parseTaxCode(text)?.normalized ?? text);
  };
  // A sale to a consumer carries no buyer details, whatever the form still held from before the kind was chosen.
  const consumer = input.buyer.kind === 'consumer';
  // An identity belongs to an individual: a business keeps a tax code, so what the form still held from before the kind was changed is dropped. A passport is written in capitals and without spaces.
  const given = input.buyer.identity ?? null;
  const written = given ? (given.kind === 'passport' ? given.value.replace(/\s+/g, '').toUpperCase() : given.value.replace(/\s+/g, '')) : '';
  // A passport carries the nationality in capitals; no other identity does (#3709).
  const nationality = given?.kind === 'passport' ? (given.nationality ?? '').replace(/\s+/g, '').toUpperCase() : '';
  const identity = input.buyer.kind === 'individual' && given && written !== '' ? { kind: given.kind, value: written, nationality: nationality === '' ? null : nationality } : null;
  // A sale date equal to the invoice's day is no sale date of its own; the reason belongs only to a late sale.
  const saleDate = input.saleDate && input.saleDate !== input.date ? input.saleDate : null;
  return {
    date: input.date,
    saleDate,
    lateReason: isLateSale(saleDate, input.date) ? blank(input.lateReason ?? null) : null,
    currency: 'VND',
    seriesId: input.seriesId,
    buyer: consumer
      ? { kind: input.buyer.kind, taxCode: null, name: null, address: null, email: null, identity: null }
      : { kind: input.buyer.kind, taxCode: taxCode(input.buyer.taxCode), name: blank(input.buyer.name), address: blank(input.buyer.address), email: blank(input.buyer.email), identity },
    lines: input.lines.map((l) => ({ description: l.description.trim(), unit: blank(l.unit), quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate })),
  };
}

export const einvoiceDraftSave = defineCommand({
  name: 'finance.einvoice_draft.save',
  input: zEInvoiceDraftSave,
  // A draft is a working copy: no invoice exists until a person issues it (a later step), so it is undone by editing or deleting it.
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  // A new draft has no id yet: its audit row carries it in the facts.
  target: (input) => (input.draftId ? { type: 'finance.einvoice_draft', id: input.draftId } : null),
  handler: async (ctx, input): Promise<EInvoiceDraft> => {
    const today = await databaseToday(ctx.trx);
    const draft = toDraftInput(input);
    const computed = computeDraft(draft.lines);
    // The amounts the database can hold (20 digits with 4 decimals): a sum above 15 digits is refused here with its own words, it is no draft.
    if ([computed.subtotal, computed.vatAmount, computed.total, ...computed.lines.flatMap((l) => [l.amount, l.vatAmount])].some((v) => money(v).abs().toFixed(0).length > 15)) {
      throw new DomainError('EINVOICE_TOTAL_TOO_LARGE', 422, 'Số tiền của hóa đơn quá lớn');
    }
    // A passport comes with the buyer's nationality (Decree 254 Appendix point 4.b, #3709): a draft with one and not the other is no draft, so it is refused here with its own words (the form's
    // check shows the same as an issue while the person types). Drafts saved before this rule are shown with the issue and cannot be issued until it is filled.
    if (draft.buyer.identity?.kind === 'passport') {
      if (!draft.buyer.identity.nationality) throw new DomainError('EINVOICE_BUYER_NATIONALITY_REQUIRED', 422, 'Người mua dùng hộ chiếu thì phải ghi quốc tịch');
      if (!isNationalityCode(draft.buyer.identity.nationality)) throw new DomainError('EINVOICE_BUYER_NATIONALITY_INVALID', 422, 'Quốc tịch ghi bằng mã hai chữ cái, ví dụ US, KR, JP');
    }
    const userId = ctx.actor.type === 'user' ? ctx.actor.userId : null;

    // The party, when the buyer was picked from the org's customers: it must be one of the org's.
    if (input.buyer.partyId && draft.buyer.kind !== 'consumer') {
      const party = await ctx.trx.selectFrom('ludy_kernel.party').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.buyer.partyId).executeTakeFirst();
      if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy khách hàng này');
    }

    let draftId = input.draftId;
    let entity: string;
    if (draftId === null) {
      entity = await resolveLegalEntity(ctx, input.legalEntityId);
    } else {
      const existing = await ctx.trx
        .selectFrom('ludy_finance.einvoice_draft')
        .select(['legal_entity_id', 'state'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', draftId)
        .forUpdate()
        .executeTakeFirst();
      if (!existing) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy bản nháp hóa đơn');
      if (existing.state !== 'draft') throw new DomainError('EINVOICE_NOT_DRAFT', 409, 'Hóa đơn đã được gửi đi, không sửa được nữa');
      if (input.legalEntityId && input.legalEntityId !== existing.legal_entity_id) throw new DomainError('EINVOICE_ENTITY_FIXED', 422, 'Bản nháp thuộc về một pháp nhân và không đổi được');
      entity = existing.legal_entity_id;
    }

    // A series of another entity is refused, here with a message and by the database's composite key.
    if (draft.seriesId) {
      const series = await ctx.trx
        .selectFrom('ludy_finance.einvoice_series')
        .select('legal_entity_id')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', draft.seriesId)
        .executeTakeFirst();
      if (!series) throw new DomainError('EINVOICE_SERIES_NOT_FOUND', 404, 'Không tìm thấy ký hiệu hóa đơn này');
      if (series.legal_entity_id !== entity) throw new DomainError('EINVOICE_SERIES_ENTITY', 422, 'Ký hiệu hóa đơn này thuộc về pháp nhân khác');
    }

    const values = {
      series_id: draft.seriesId,
      invoice_date: draft.date,
      sale_date: draft.saleDate,
      late_reason: draft.lateReason,
      currency: draft.currency,
      buyer_kind: draft.buyer.kind,
      buyer_party_id: draft.buyer.kind === 'consumer' ? null : input.buyer.partyId,
      buyer_tax_code: draft.buyer.taxCode,
      buyer_name: draft.buyer.name,
      buyer_address: draft.buyer.address,
      buyer_email: draft.buyer.email,
      buyer_identity_kind: draft.buyer.identity?.kind ?? null,
      buyer_identity: draft.buyer.identity?.value ?? null,
      buyer_nationality: draft.buyer.identity?.nationality ?? null,
      subtotal: computed.subtotal,
      vat_amount: computed.vatAmount,
      total: computed.total,
    };
    let carried = new Map<number, { source_kind: string | null; source_id: string | null; source_line_no: number | null }>();
    try {
      if (draftId === null) {
        draftId = randomUUID();
        await ctx.trx
          .insertInto('ludy_finance.einvoice_draft')
          .values({ org_id: ctx.orgId, id: draftId, legal_entity_id: entity, created_by: userId, ...values })
          .execute();
      } else {
        await ctx.trx
          .updateTable('ludy_finance.einvoice_draft')
          .set({ ...values, updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', draftId)
          .execute();
        // A line made from an order line keeps its source (ADR-0050): the order line stays invoiced, so a second draft of it is refused. Its amount cannot change and it cannot go;
        // a description or unit fix is allowed. The person deletes the draft and drafts the order again for anything else.
        const kept = await ctx.trx
          .selectFrom('ludy_finance.einvoice_draft_line')
          .select(['line_no', 'amount', 'source_kind', 'source_id', 'source_line_no'])
          .where('org_id', '=', ctx.orgId)
          .where('draft_id', '=', draftId)
          .where('source_kind', 'is not', null)
          .execute();
        for (const old of kept) {
          const next = computed.lines[old.line_no - 1];
          if (!next || !money(next.amount).equals(money(old.amount))) {
            throw new DomainError('EINVOICE_SOURCE_LINE_LOCKED', 422, 'Dòng này lập từ đơn hàng nên không đổi số tiền hoặc xóa được; hãy xóa bản nháp và lập lại từ đơn hàng');
          }
        }
        carried = new Map(kept.map((k) => [k.line_no, k]));
        await ctx.trx.deleteFrom('ludy_finance.einvoice_draft_line').where('org_id', '=', ctx.orgId).where('draft_id', '=', draftId).execute();
      }
      for (const [index, line] of computed.lines.entries()) {
        await ctx.trx
          .insertInto('ludy_finance.einvoice_draft_line')
          .values({
            org_id: ctx.orgId,
            legal_entity_id: entity,
            draft_id: draftId,
            line_no: index + 1,
            description: line.description,
            unit: line.unit,
            quantity: line.quantity,
            unit_price: line.unitPrice,
            amount: line.amount,
            vat_rate: line.vatRate,
            vat_amount: line.vatAmount,
            source_kind: carried.get(index + 1)?.source_kind ?? null,
            source_id: carried.get(index + 1)?.source_id ?? null,
            source_line_no: carried.get(index + 1)?.source_line_no ?? null,
          })
          .execute();
      }
    } catch (error) {
      // A value the database refuses (a check on a length, a tax code's shape) is the caller's, not a server fault.
      if (pgCode(error) === '23514') throw new DomainError('EINVOICE_DRAFT_INVALID', 422, 'Bản nháp có giá trị không hợp lệ');
      throw error;
    }
    // Facts without a name, an address, an email, a tax code or an identity: the ids and the counts (hasIdentity says only that one was given).
    // A late sale is in the facts with its date, and the reason is the person's own words under the later approval (finance.einvoice.issue).
    ctx.audit({ draftId, legalEntityId: entity, lines: computed.lines.length, total: computed.total, created: input.draftId === null, ...(draft.buyer.identity ? { hasIdentity: true } : {}), ...(draft.saleDate ? { saleDate: draft.saleDate, lateSale: isLateSale(draft.saleDate, draft.date) } : {}) });
    return loadDraft(ctx, draftId, today);
  },
});

export const einvoiceDraftDelete = defineCommand({
  name: 'finance.einvoice_draft.delete',
  input: z.strictObject({ draftId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  target: (input) => ({ type: 'finance.einvoice_draft', id: input.draftId }),
  handler: async (ctx, input): Promise<{ deleted: true }> => {
    const existing = await ctx.trx
      .selectFrom('ludy_finance.einvoice_draft')
      .select('state')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.draftId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw new DomainError('EINVOICE_DRAFT_NOT_FOUND', 404, 'Không tìm thấy bản nháp hóa đơn');
    if (existing.state !== 'draft') throw new DomainError('EINVOICE_NOT_DRAFT', 409, 'Hóa đơn đã được gửi đi, không xóa được');
    await ctx.trx.deleteFrom('ludy_finance.einvoice_draft').where('org_id', '=', ctx.orgId).where('id', '=', input.draftId).execute();
    ctx.audit({ draftId: input.draftId });
    return { deleted: true };
  },
});

export const einvoiceCommands = [einvoiceSeriesSync, einvoiceDraftSave, einvoiceDraftDelete];
export const einvoiceQueries = [einvoiceSeriesList, einvoiceDraftList, einvoiceDraftGet, einvoiceDraftCheck, einvoiceDraftSuggestSource, einvoicePreviousInvoice];
