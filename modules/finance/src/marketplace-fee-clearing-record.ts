// SPDX-License-Identifier: AGPL-3.0-only
// The clearing of a platform's waiting fees by its fee e-invoice (issue #2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4 "The payout" and section 11; Accounting PO
// decision 2026-11-14): ONE general journal voucher, Dr 331 / Cr 1388, the platform's party on both lines. The payout (slice B) put the fees on 1388; the platform's fee invoice is a purchase document
// posted as today (Dr expense, Dr 1331, Cr 331). The entry is built by feeClearingProposal (marketplace-fee-clearing-posting.ts) from the posted invoice and the fees waiting on 1388, and nothing is
// built or posted until the accountant has confirmed the account map (requireConfirmedMarketplaceMap, #2520):
// - finance.marketplace_fee_clearing.prepare (R1, internal): the preparer of kernel.proposal.request for `finance.marketplace_fee_clearing.record`. The request carries the purchase document alone.
//   It checks the gate, that the document is the posted, standing purchase invoice of a platform's party (in dong), the invoice's credit to 331, its standing clearings and the platform's 1388 balance,
//   that the period of the entry is open and the accounts usable, then returns the proposal. It writes nothing.
// - finance.marketplace_fee_clearing.record (R3): runs only through kernel.proposal.approve. It builds the entry again, in the approver's context under the platform's lock, and refuses a stored
//   proposal that differs from it. Then, in the same transaction, it records the voucher with the document on it and posts its entry. The database checks at commit that the proposal has such a voucher
//   (crove_finance.ledger_effect_recorded, 20261231190000).
// An invoice may be cleared more than once, as the fees wait and payouts arrive: the sum of its standing clearings never exceeds its credit to 331, and a reversed clearing frees its amount. It works in
// either order of arrival: the clearing is asked for once the payout (1388 up) and the invoice (331 up) both stand. No model call is made: everything here is deterministic over posted facts.
import { sql } from 'kysely';
import { z } from 'zod';
import { JOURNAL_VOUCHER_KIND, MARKETPLACE_FEE_CLEARING_COMMAND, zMarketplaceFeeClearingProposal, zMarketplaceFeeClearingRequest, type JournalVoucherProposal, type MarketplaceFeeClearingProposal } from '@crove/kernel-contract';
import { money } from '@crove/l10n-vn';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, type QueryContext } from '@crove/kernel-runtime';
import { assertUsableAccounts } from './accounts.ts';
import { JOURNAL_VOUCHER_SOURCE, journalVoucherTitle } from './domain/journal-voucher.ts';
import { checkJournalVoucherLines, postJournalVoucher } from './journal-voucher.ts';
import { feeClearingProposal, type FeeClearingProposal } from './marketplace-fee-clearing-posting.ts';
import { requireConfirmedMarketplaceMap, MARKETPLACE_POSTING_MAPS, type MarketplacePostingMap } from './marketplace-posting-map.ts';
import { platformPartyName } from './marketplace-settlement-record.ts';
import { booksOn } from './payroll-posting.ts';
import { dateLabel, periodLockedThrough } from './period-lock.ts';
import { latestRevision, reversedSource } from './source-entry.ts';

const REQUESTERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
type Maps = Readonly<Record<string, MarketplacePostingMap>>;

const PURCHASE_SOURCE = 'finance.purchase_document';
const notUsable = (reason: string, extra: Record<string, unknown> = {}) => new DomainError('MARKETPLACE_FEE_DOCUMENT', 422, 'Hóa đơn này không dùng để cấn trừ phí của sàn được', { reason, ...extra });
const mismatch = (what: string) => new DomainError('MARKETPLACE_FEE_MISMATCH', 422, 'Đề xuất cấn trừ không khớp hóa đơn hoặc số phí đang chờ đã lưu; hãy lập lại đề xuất', { what });

// A voucher holds whole dong (the books have no minor unit); an amount with a fraction is refused, never rounded.
function wholeDong(what: string, value: string): string {
  if (!/^\d{1,15}$/.test(value)) throw new DomainError('MARKETPLACE_FEE_DOCUMENT', 422, 'Số tiền cấn trừ phí phải là số đồng nguyên để hạch toán', { reason: 'FRACTION', what });
  return value;
}

interface Built {
  documentId: string;
  legalEntityId: string;
  platform: string;
  date: string;
  proposal: FeeClearingProposal;
  payable: string;
  awaiting: string;
  party: { id: string; name: string; taxCode: string | null };
}

// The sum of the account's lines (debit minus credit) that name the party, in the entity: a reversal entry takes back what it reverses, so the balance already counts it.
async function balanceOf(ctx: QueryContext, legalEntityId: string, partyId: string, prefix: string): Promise<{ balance: string; lastDate: string | null }> {
  const row = await ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .innerJoin('crove_finance.journal_entry as e', (join) => join.onRef('e.org_id', '=', 'l.org_id').onRef('e.id', '=', 'l.entry_id'))
    .select([sql<string>`coalesce(sum(l.debit) - sum(l.credit), 0)`.as('balance'), sql<string | null>`max(e.entry_date)::text`.as('last_date')])
    .where('l.org_id', '=', ctx.orgId)
    .where('l.legal_entity_id', '=', legalEntityId)
    .where('l.party_id', '=', partyId)
    .where('l.account_code', 'like', `${prefix}%`)
    .executeTakeFirstOrThrow();
  return { balance: money(row.balance).toFixed(), lastDate: row.last_date };
}

// Everything the proposal and the posting share, read in the caller's context: the invoice, the platform's link, what the invoice has to clear, the platform's waiting fees, the date, the gate. `lock`
// takes the platform's lock (the one the settlement guards use, 20261126110000) for the rest of the transaction, so the sum of an invoice's clearings and the 1388 balance are read and written together.
async function buildClearing(ctx: QueryContext, maps: Maps, documentId: string, lock: boolean): Promise<Built> {
  const doc = await ctx.trx
    .selectFrom('crove_finance.purchase_document')
    .select(['id', 'party_id', 'legal_entity_id', 'invoice_series', 'invoice_number', 'invoice_date', 'currency', 'direction'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', documentId)
    .executeTakeFirst();
  if (!doc) throw notUsable('NOT_FOUND');
  if (doc.direction !== 'purchase') throw notUsable('DIRECTION');
  if (doc.currency !== 'VND') throw notUsable('CURRENCY');
  const link = await ctx.trx
    .selectFrom('crove_finance.marketplace_party as m')
    .innerJoin('crove_kernel.party as p', (join) => join.onRef('p.org_id', '=', 'm.org_id').onRef('p.id', '=', 'm.party_id'))
    .select(['m.platform', 'p.id', 'p.name', 'p.tax_code'])
    .where('m.org_id', '=', ctx.orgId)
    .where('m.legal_entity_id', '=', doc.legal_entity_id)
    .where('m.party_id', '=', doc.party_id)
    .executeTakeFirst();
  if (!link) throw notUsable('NOT_PLATFORM');
  if (lock) {
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`channel_settlement:${ctx.orgId}:${doc.legal_entity_id}:${link.platform}`}, 0))`.execute(ctx.trx);
  }
  // The invoice's standing entry (its latest revision, not reversed) and its credit to 331 naming the platform: what it has to clear. An invoice paid another way credits no 331 and clears nothing.
  const entry = await ctx.trx
    .selectFrom('crove_finance.journal_entry as e')
    .leftJoin('crove_finance.journal_entry as r', (join) => join.onRef('r.org_id', '=', 'e.org_id').onRef('r.reverses_entry_id', '=', 'e.id'))
    .select(['e.id', 'r.id as reversal'])
    .where('e.org_id', '=', ctx.orgId)
    .where('e.source_type', '=', PURCHASE_SOURCE)
    .where('e.source_id', '=', doc.id)
    .where('e.reverses_entry_id', 'is', null)
    .where(latestRevision('e'))
    .executeTakeFirst();
  if (!entry) throw notUsable('NOT_POSTED');
  if (entry.reversal) throw notUsable('REVERSED');
  const payable = (await ctx.trx
    .selectFrom('crove_finance.journal_line as l')
    .select(sql<string>`coalesce(sum(l.credit) - sum(l.debit), 0)`.as('total'))
    .where('l.org_id', '=', ctx.orgId)
    .where('l.entry_id', '=', entry.id)
    .where('l.party_id', '=', link.id)
    .where('l.account_code', 'like', `${(MARKETPLACE_POSTING_MAPS.tt133?.feePayable.code ?? '331')}%`)
    .executeTakeFirstOrThrow()).total;
  if (!money(payable).greaterThan(0)) throw notUsable('NO_PAYABLE');
  // What the invoice's standing clearings took: the credit to 1388 of every clearing voucher that names it and whose entry is not reversed.
  const cleared = (await ctx.trx
    .selectFrom('crove_finance.journal_voucher as j')
    .innerJoin('crove_finance.journal_entry as e', (join) => join.onRef('e.org_id', '=', 'j.org_id').onRef('e.source_id', '=', 'j.id').on('e.source_type', '=', JOURNAL_VOUCHER_SOURCE).on('e.reverses_entry_id', 'is', null))
    .innerJoin('crove_finance.journal_line as l', (join) => join.onRef('l.org_id', '=', 'e.org_id').onRef('l.entry_id', '=', 'e.id'))
    .select(sql<string>`coalesce(sum(l.credit), 0)`.as('total'))
    .where('j.org_id', '=', ctx.orgId)
    .where('j.fee_document_id', '=', doc.id)
    .where('l.account_code', 'like', `${(MARKETPLACE_POSTING_MAPS.tt133?.feeAwaitingInvoice.code ?? '1388')}%`)
    .where(sql<boolean>`NOT ${reversedSource('j', JOURNAL_VOUCHER_SOURCE)}`)
    .executeTakeFirstOrThrow()).total;
  const waiting = await balanceOf(ctx, doc.legal_entity_id, link.id, MARKETPLACE_POSTING_MAPS.tt133?.feeAwaitingInvoice.code ?? '1388');
  // The entry is dated the later of the invoice and the last posting on the platform's 1388, so it never precedes either.
  const invoiceDate = String(doc.invoice_date).slice(0, 10);
  const date = waiting.lastDate && waiting.lastDate > invoiceDate ? waiting.lastDate : invoiceDate;
  const regime = (await booksOn(ctx, doc.legal_entity_id, date)).regime;
  const map = requireConfirmedMarketplaceMap(regime, maps);
  const lockedThrough = await periodLockedThrough(ctx, doc.legal_entity_id);
  if (lockedThrough && date <= lockedThrough) {
    throw new DomainError('PERIOD_LOCKED', 409, `Sổ đã khóa đến hết ngày ${dateLabel(lockedThrough)}, nên không ghi được bút toán ngày ${dateLabel(date)}`, { lockedThrough, entryDate: date });
  }
  const proposal = feeClearingProposal(
    { regime: map.regime, platform: platformPartyName(link.platform), invoice: `${doc.invoice_series ?? ''}${doc.invoice_number ?? ''}`.trim() || doc.id.slice(0, 8), partyId: link.id, invoiceTotal: money(payable).toFixed(), alreadyCleared: money(cleared).toFixed(), waiting: waiting.balance },
    maps,
  );
  for (const [what, value] of [['invoiceTotal', proposal.invoiceTotal], ['alreadyCleared', proposal.alreadyCleared], ['waiting', proposal.waiting], ['amount', proposal.amount], ['total', proposal.total]] as const) wholeDong(what, value);
  return {
    documentId: doc.id,
    legalEntityId: doc.legal_entity_id,
    platform: link.platform,
    date,
    proposal,
    payable: map.feePayable.code,
    awaiting: map.feeAwaitingInvoice.code,
    party: { id: link.id, name: link.name, taxCode: link.tax_code },
  };
}

// The proposal of a built clearing: lines as the voucher holds them, both naming the platform's party.
function proposalPayload(built: Built): MarketplaceFeeClearingProposal {
  const { proposal } = built;
  return zMarketplaceFeeClearingProposal.parse({
    date: built.date,
    description: proposal.description,
    lines: proposal.lines.map((l) => ({ account: l.account, party: { id: built.party.id, name: built.party.name, taxCode: built.party.taxCode }, debit: l.debit, credit: l.credit, memo: l.memo })),
    total: proposal.total,
    legalEntityId: built.legalEntityId,
    purchaseDocumentId: built.documentId,
    platform: built.platform,
    invoiceTotal: proposal.invoiceTotal,
    alreadyCleared: proposal.alreadyCleared,
    waiting: proposal.waiting,
    amount: proposal.amount,
  });
}

// What a stored proposal holds that the invoice and the waiting fees, rebuilt now, do not: the first difference, or null when they are the same.
export function feeClearingProposalMismatch(stored: MarketplaceFeeClearingProposal, built: MarketplaceFeeClearingProposal): string | null {
  if (stored.purchaseDocumentId.toLowerCase() !== built.purchaseDocumentId.toLowerCase()) return 'purchaseDocumentId';
  if (!stored.legalEntityId || stored.legalEntityId.toLowerCase() !== built.legalEntityId?.toLowerCase()) return 'legalEntityId';
  if (stored.platform !== built.platform) return 'platform';
  if (stored.date !== built.date) return 'date';
  if (stored.description !== built.description) return 'description';
  for (const key of ['invoiceTotal', 'alreadyCleared', 'waiting', 'amount', 'total'] as const) if (!money(stored[key]).equals(money(built[key]))) return key;
  if (stored.lines.length !== built.lines.length) return 'lines';
  for (const [i, line] of built.lines.entries()) {
    const have = stored.lines[i];
    if (!have || have.account !== line.account || !money(have.debit).equals(money(line.debit)) || !money(have.credit).equals(money(line.credit)) || (have.memo ?? '') !== (line.memo ?? '')) return 'lines';
    if (have.party?.id.toLowerCase() !== line.party?.id.toLowerCase()) return 'party';
  }
  return null;
}

// The commands over a set of account maps. A test passes its own with a confirmed map; the shipped set is made from MARKETPLACE_POSTING_MAPS.
export function createMarketplaceFeeClearingCommands(options: { maps?: Maps } = {}) {
  const maps = options.maps ?? MARKETPLACE_POSTING_MAPS;

  const prepare = defineCommand({
    name: 'finance.marketplace_fee_clearing.prepare',
    input: zMarketplaceFeeClearingRequest,
    risk: 'R1',
    sideEffect: 'internal',
    access: REQUESTERS,
    writes: [],
    handler: async (ctx, input) => {
      // The lock is taken here too: the sums are read under the platform's lock at the request as at the approval (Accounting PO, 2026-11-14).
      const built = await buildClearing(ctx, maps, input.purchaseDocumentId, true);
      await assertUsableAccounts(ctx, built.proposal.lines.map((l) => l.account));
      const payload = proposalPayload(built);
      return { kind: JOURNAL_VOUCHER_KIND, command: MARKETPLACE_FEE_CLEARING_COMMAND, title: journalVoucherTitle(payload), payload };
    },
  });

  const record = defineCommand({
    // A literal, not the shared constant: the job-egress analyzer reads a command's name from the source (the contract's MARKETPLACE_FEE_CLEARING_COMMAND equals it).
    name: 'finance.marketplace_fee_clearing.record',
    input: z.object({ payload: zMarketplaceFeeClearingProposal, acceptFailedChecks: z.boolean().default(false) }),
    risk: 'R3',
    sideEffect: 'financial',
    access: 'proposal',
    proposalKind: JOURNAL_VOUCHER_KIND,
    handler: async (ctx, { payload }) => {
      if (!ctx.proposalId) throw new DomainError('FORBIDDEN', 403, 'Lệnh này chỉ chạy qua đề xuất đã duyệt');
      // The entry is built again from the posted invoice and the waiting fees, in the approver's context under the platform's lock, and the stored proposal must equal it: a proposal row not written by
      // the preparer (raw SQL) cannot clear more than the invoice and the waiting fees allow, nor into another entity.
      const built = await buildClearing(ctx, maps, payload.purchaseDocumentId, true);
      const rebuilt = proposalPayload(built);
      const wrong = feeClearingProposalMismatch(payload, rebuilt);
      if (wrong) throw mismatch(wrong);
      const voucher: JournalVoucherProposal = { date: rebuilt.date, description: rebuilt.description, lines: rebuilt.lines, total: rebuilt.total, legalEntityId: rebuilt.legalEntityId };
      // The shape, the accounts and the parties checked as any voucher's, the parties read FOR SHARE so they stay as read until commit.
      await checkJournalVoucherLines(ctx, voucher.lines.map((l) => ({ account: l.account, partyId: l.party?.id ?? null, debit: l.debit, credit: l.credit })), true);
      return postJournalVoucher(ctx, voucher, null, null, null, null, null, null, built.documentId);
    },
  });

  return { prepare, record, commands: [prepare, record] };
}

export const marketplaceFeeClearingCommands = createMarketplaceFeeClearingCommands().commands;
