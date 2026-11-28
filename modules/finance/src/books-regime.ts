// SPDX-License-Identifier: AGPL-3.0-only
// The regime of an entity's books (issue #1403, TT99 books phase B1): an owner chooses Circular 99 from the first day of a fiscal year, an owner or an admin takes back a choice for a year nobody has posted in
// yet, and every member reads where an entity stands.
// - finance.books.set_regime: owner only, R3 (the legal side effect: the choice binds the entity before the tax authority for at least a year, so a fresh second factor is required and no later edit lowers it), no
//   proposal, as for the period unlock. It says the tax authority has been told (taxAuthorityNotified, only `true` is accepted); Ludy sends nothing to it, the audit row, which cannot be edited, keeps the
//   acknowledgement. The database does the work and the checks in ludy_finance.set_books_regime (20270403080000), the one write path to the books rows.
// - finance.books.cancel_regime: owner or admin, R3, deletes a Circular 99 row while no entry falls under it (ludy_finance.cancel_books_regime).
// - finance.books.regime_state: every member reads, under their own entity scope and the row security of the entries, what is in force, a choice for a year to come, why a switch is not offered, and the first 1
//   January it can start from (domain/books-switch.ts holds the rules, the database enforces the same ones).
// Nothing moves a balance: an entity that switches opens its Circular 99 books from the first day of the year, and the converting of the balances it carried is a later step.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import { zBooksRegimeCancelInput, zBooksRegimeSetInput, type BooksRegimeResult, type BooksRegimeState } from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@ludy/kernel-runtime';
import { switchState } from './domain/books-switch.ts';
import { legalEntityError, resolveLegalEntity } from './legal-entity.ts';
import { databaseToday, dateLabel } from './period-lock.ts';
import { z } from 'zod';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const TT99 = { regime: 'tt99', chartVersion: '2026.1' } as const;
// The proposals that post to the books and carry no regime of their own to be held to (the same list as ludy_finance.books_pending_proposals).
const POSTING_PROPOSAL_KINDS = ['finance.purchase', 'finance.cash_voucher', 'finance.journal_voucher', 'finance.journal_reversal', 'finance.supplier_payment'];

interface PgError {
  code?: string;
  message?: string;
  detail?: string;
  constraint?: string;
}

function detailOf(error: PgError): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(error.detail ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const text = (value: unknown) => (typeof value === 'string' ? value : null);
const label = (value: unknown) => {
  const date = text(value);
  return date ? dateLabel(date) : '';
};

// The refusals of set_books_regime(), cancel_books_regime() and the guard under them as the domain errors the commands answer; anything else is rethrown for the runtime to map.
function booksRefusal(error: unknown): never {
  const entityError = legalEntityError(error);
  if (entityError) throw entityError;
  const pg = error as PgError | null;
  const detail = pg ? detailOf(pg) : {};
  switch (pg?.message) {
    case 'BOOKS_DATE_INVALID':
      throw new DomainError('BOOKS_DATE_INVALID', 422, 'Chế độ kế toán chỉ đổi được từ ngày 1 tháng 1 của một năm tài chính, và không sớm hơn ngày 01/01/2026', detail);
    case 'BOOKS_NOT_FISCAL_YEAR_START':
      throw new DomainError('BOOKS_DATE_INVALID', 422, 'Chế độ kế toán chỉ đổi được từ ngày đầu của một năm tài chính', detail);
    case 'BOOKS_FISCAL_YEAR_UNSUPPORTED':
      throw new DomainError('BOOKS_FISCAL_YEAR_UNSUPPORTED', 422, 'Năm tài chính của tổ chức không kết thúc vào tháng 12 nên chưa chuyển sang Thông tư 99 được', detail);
    case 'BOOKS_ALREADY_TT99':
      throw new DomainError('BOOKS_ALREADY_TT99', 409, 'Sổ của pháp nhân đã dùng Thông tư 99; chưa chuyển ngược lại được', detail);
    case 'BOOKS_LATER_ROW':
      throw new DomainError('BOOKS_LATER_ROW', 409, 'Pháp nhân đã có một lựa chọn chế độ kế toán cho năm sau ngày này', detail);
    case 'BOOKS_NOT_FOUND':
      throw new DomainError('BOOKS_NOT_FOUND', 404, 'Không có lựa chọn Thông tư 99 nào bắt đầu từ ngày này', detail);
    case 'BOOKS_OPENING_ENTRY_BLOCKS':
      throw new DomainError(
        'BOOKS_OPENING_ENTRY_BLOCKS',
        409,
        `Pháp nhân có bút toán số dư đầu kỳ ngày ${label(detail.entryDate)} (đã đảo hay chưa đều vậy), nên năm bắt đầu từ ngày hôm sau chưa chọn được; năm sớm nhất có thể chọn bắt đầu từ ${label(detail.nextEffectiveFrom)}`,
        detail,
      );
    case 'BOOKS_PENDING_PROPOSALS':
      throw new DomainError(
        'BOOKS_PENDING_PROPOSALS',
        409,
        'Pháp nhân còn đề xuất ghi sổ đang chờ duyệt (hóa đơn, phiếu thu chi, bút toán, đảo bút toán hay thanh toán nhà cung cấp) từ ngày này trở đi; hãy duyệt hoặc từ chối các đề xuất đó trước khi chọn hay hủy chế độ kế toán',
        detail,
      );
    case 'BOOKS_REGIME_IN_USE':
      throw new DomainError(
        'BOOKS_REGIME_IN_USE',
        409,
        `Pháp nhân đã có bút toán từ ngày ${label(detail.firstEntry)}; chỉ chọn được chế độ cho năm bắt đầu sau bút toán cuối cùng, hoặc hủy lựa chọn của một năm chưa ghi sổ`,
        detail,
      );
  }
  if (pg?.code === '23505' && pg.constraint === 'legal_entity_books_from_uq') {
    throw new DomainError('BOOKS_ALREADY_TT99', 409, 'Pháp nhân đã có một lựa chọn chế độ kế toán bắt đầu từ ngày này', detail);
  }
  throw error;
}

async function call(ctx: CommandContext, fn: 'set_books_regime' | 'cancel_books_regime', entity: string, effectiveFrom: string): Promise<void> {
  try {
    await (fn === 'set_books_regime'
      ? sql`SELECT ludy_finance.set_books_regime(${entity}::uuid, ${effectiveFrom}::date)`
      : sql`SELECT ludy_finance.cancel_books_regime(${entity}::uuid, ${effectiveFrom}::date)`
    ).execute(ctx.trx);
  } catch (error) {
    booksRefusal(error);
  }
}

export const booksRegimeSet = defineCommand({
  name: 'finance.books.set_regime',
  input: zBooksRegimeSetInput,
  // The choice binds the entity before the tax authority for at least a year, and it cannot be undone once the year has an entry: legal, which the runtime holds at R3 (a fresh second factor).
  risk: 'R3',
  sideEffect: 'legal',
  access: ['owner'],
  handler: async (ctx, input): Promise<BooksRegimeResult> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    ctx.audit({ legalEntityId: entity, regime: TT99.regime, chartVersion: TT99.chartVersion, effectiveFrom: input.effectiveFrom, taxAuthorityNotified: input.taxAuthorityNotified });
    await call(ctx, 'set_books_regime', entity, input.effectiveFrom);
    // The record is the entity itself: the trigger on activity maps kernel.legal_entity to its own id, so the row is scoped to it.
    await ctx.activity('kernel.legal_entity', entity, 'books.regime_set', `Chọn Thông tư 99 từ ${dateLabel(input.effectiveFrom)}`);
    await ctx.emit('finance.books.regime_set', { legalEntityId: entity, regime: TT99.regime, effectiveFrom: input.effectiveFrom });
    return { legalEntityId: entity, regime: TT99.regime, chartVersion: TT99.chartVersion, effectiveFrom: input.effectiveFrom };
  },
});

export const booksRegimeCancel = defineCommand({
  name: 'finance.books.cancel_regime',
  input: zBooksRegimeCancelInput,
  // Takes back a choice nobody has posted under; legal like the choice itself, so it is held at R3 too.
  risk: 'R3',
  sideEffect: 'legal',
  access: ['owner', 'admin'],
  handler: async (ctx, input): Promise<BooksRegimeResult> => {
    const entity = await resolveLegalEntity(ctx, input.legalEntityId);
    ctx.audit({ legalEntityId: entity, regime: TT99.regime, chartVersion: TT99.chartVersion, effectiveFrom: input.effectiveFrom });
    await call(ctx, 'cancel_books_regime', entity, input.effectiveFrom);
    await ctx.activity('kernel.legal_entity', entity, 'books.regime_cancelled', `Hủy lựa chọn Thông tư 99 từ ${dateLabel(input.effectiveFrom)}`);
    await ctx.emit('finance.books.regime_cancelled', { legalEntityId: entity, regime: TT99.regime, effectiveFrom: input.effectiveFrom });
    return { legalEntityId: entity, regime: TT99.regime, chartVersion: TT99.chartVersion, effectiveFrom: input.effectiveFrom };
  },
});

// For each entity the caller sees. Read under the caller's own role, so the opening entry a blocker names is one the caller may see (row security), and nothing here writes.
export const booksRegimeState = defineQuery({
  name: 'finance.books.regime_state',
  input: z.object({}),
  access: ALL,
  handler: async (ctx): Promise<BooksRegimeState> => {
    const entities = await ctx.trx
      .selectFrom('ludy_kernel.legal_entity')
      .select(['id', 'name', 'is_default'])
      .where('org_id', '=', ctx.orgId)
      .orderBy('is_default', 'desc')
      .orderBy('name')
      .orderBy('id')
      .execute();
    const today = await databaseToday(ctx.trx);
    const profile = await ctx.trx.selectFrom('ludy_kernel.tax_profile').select('fiscal_year_end_month').where('org_id', '=', ctx.orgId).executeTakeFirst();
    const out: BooksRegimeState['entities'] = [];
    for (const entity of entities) {
      const rows = await ctx.trx
        .selectFrom('ludy_finance.legal_entity_books')
        .select(['regime', 'chart_version', 'effective_from'])
        .where('org_id', '=', ctx.orgId)
        .where('legal_entity_id', '=', entity.id)
        .orderBy('effective_from')
        .execute();
      // The latest entry that is not an opening entry, and every opening entry with whether it has been reversed: all the switch rules need of the entries.
      const last = await ctx.trx
        .selectFrom('ludy_finance.journal_entry')
        .select('entry_date')
        .where('org_id', '=', ctx.orgId)
        .where('legal_entity_id', '=', entity.id)
        .where('source_type', '<>', 'finance.opening_balance')
        .orderBy('entry_date', 'desc')
        .limit(1)
        .executeTakeFirst();
      const openings = await ctx.trx
        .selectFrom('ludy_finance.journal_entry as e')
        .select(['e.id', 'e.entry_date'])
        .select((eb) =>
          eb
            .exists(eb.selectFrom('ludy_finance.journal_entry as r').select('r.id').whereRef('r.org_id', '=', 'e.org_id').whereRef('r.reverses_entry_id', '=', 'e.id'))
            .as('reversed'),
        )
        .where('e.org_id', '=', ctx.orgId)
        .where('e.legal_entity_id', '=', entity.id)
        .where('e.source_type', '=', 'finance.opening_balance')
        .where('e.reverses_entry_id', 'is', null)
        .orderBy('e.entry_date')
        .limit(50)
        .execute();
      const state = switchState({
        today,
        fiscalYearEndMonth: profile?.fiscal_year_end_month ?? 12,
        rows: rows.map((r) => ({ regime: r.regime, chartVersion: r.chart_version, effectiveFrom: r.effective_from })),
        lastOrdinaryDate: last?.entry_date ?? null,
        openingEntries: openings.map((o) => ({ id: o.id, entryDate: o.entry_date, reversed: o.reversed === true })),
      });
      // The posting proposals that wait for approval from that date on hold the switch, as set_books_regime() holds it (BOOKS_PENDING_PROPOSALS); seen as far as the caller may see proposals.
      let blockers = state.blockers;
      if (state.nextSwitchDate !== null) {
        const proposalDate = sql<string | null>`coalesce(payload #>> '{invoice,issueDate}', payload ->> 'date', payload ->> 'entryDate')`;
        const pending = await ctx.trx
          .selectFrom('ludy_kernel.proposal')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('legal_entity_id', '=', entity.id)
          .where('status', 'in', ['pending', 'approved'])
          .where('kind', 'in', POSTING_PROPOSAL_KINDS)
          .where((eb) => eb.or([eb(proposalDate, 'is', null), eb(proposalDate, '>=', state.nextSwitchDate as string)]))
          .orderBy('id')
          .limit(20)
          .execute();
        if (pending.length > 0) blockers = [...blockers, { code: 'PENDING_PROPOSALS', proposalIds: pending.map((p) => p.id), nextSwitchDate: state.nextSwitchDate }];
      }
      out.push({ legalEntityId: entity.id, name: entity.name, isDefault: entity.is_default, ...state, blockers });
    }
    return { entities: out };
  },
});
