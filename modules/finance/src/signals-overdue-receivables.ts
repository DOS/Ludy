// SPDX-License-Identifier: AGPL-3.0-only
// Accounting's side of rule 2 (Vy V5, #2969; contract in packages/kernel-contract/src/signals.ts): `finance.signals.overdue_receivables`, one small R0 read that answers, for the
// parties it is asked about (the parties of the open deals the CRM listed), the oldest due date among their overdue sales invoices, the overdue total and how many there are,
// so the kernel can raise a flag for a customer who owes late while a deal with them is still open. No text, no model, no write.
//
// It is the numbers of the "nhắc thu nợ" screen (finance.payment_reminders.list), by the same code: what a customer owes is its balance on 131, laid over its sales invoices newest
// first (the oldest are taken as paid first), each due after the customer's payment terms (its own, else the org's), and an invoice is overdue from the day after its due date.
// A party and the parties marked as its duplicates are one customer; a customer who owes in several legal entities is counted across all of them; one row is answered for each
// asked id. A customer whose reminders are paused still owes: the pause is about the mail, not the debt.
//
// The honesty rule: a party that is not listed has nothing overdue, so the read REFUSES a caller who cannot see every book. A caller whose legal-entity scope is narrower than the
// org gets a DomainError with the code SIGNAL_PARTIAL_VIEW, never the part they can see; a caller that is not a user gets FORBIDDEN.
import { Decimal } from '@crove/l10n-vn';
import { SIGNAL_PARTIAL_VIEW_CODE, zFinanceOverdueReceivableSignals, zFinanceSalesSignalsInput, type FinanceOverdueReceivableSignal } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { sql } from 'kysely';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { loadCustomers } from './payment-reminders.ts';
import { databaseToday } from './period-lock.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const financeOverdueReceivablesSignals = defineQuery({
  name: 'finance.signals.overdue_receivables',
  input: zFinanceSalesSignalsInput,
  access: ALL,
  // An AI app the owner or an admin connected may run this read (ADR-0051, #2975, step S2): ids, dates and amounts only, run in the sealed context of the grant (no user, so nothing bound to a user answers).
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<FinanceOverdueReceivableSignal[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const { rows: scope } = await sql<{ whole: boolean }>`SELECT coalesce('*' = ANY (crove_kernel.ctx_le_scope()::text[]), false) AS whole`.execute(ctx.trx);
    if (scope[0]?.whole !== true) throw new DomainError(SIGNAL_PARTIAL_VIEW_CODE, 403, 'Bạn chỉ xem được một phần sổ sách nên chưa kiểm tra được công nợ quá hạn');
    // The asked ids, each mapped to the kept party of its group (a duplicate and its kept party are one customer).
    const { rows: asked } = await sql<{ id: string; kept: string }>`
      SELECT a.id, coalesce(a.duplicate_of, a.id) AS kept
      FROM crove_kernel.party a
      WHERE a.org_id = ${ctx.orgId}::uuid AND a.id IN (${sql.join(input.partyIds.map((id) => sql`${id}::uuid`))})`.execute(ctx.trx);
    if (asked.length === 0) return [];
    const kept = [...new Set(asked.map((r) => r.kept))];
    const today = await databaseToday(ctx.trx);
    const entities = await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).orderBy('id').execute();
    const byKept = new Map<string, { oldest: string; amount: InstanceType<typeof Decimal>; count: number }>();
    for (const entity of entities) {
      for (const customer of await loadCustomers(ctx, entity.id, today, kept)) {
        if (customer.overdue.length === 0) continue;
        const oldest = customer.overdue.map((i) => i.dueDate).sort()[0] as string;
        const amount = customer.overdue.reduce((sum, i) => sum.plus(i.amountDue), new Decimal(0));
        const had = byKept.get(customer.partyId);
        byKept.set(customer.partyId, {
          oldest: had && had.oldest < oldest ? had.oldest : oldest,
          amount: (had?.amount ?? new Decimal(0)).plus(amount),
          count: (had?.count ?? 0) + customer.overdue.length,
        });
      }
    }
    const out = asked
      .flatMap((a) => {
        const found = byKept.get(a.kept);
        return found ? [{ partyId: a.id, oldestDueOn: found.oldest, amount: found.amount.toFixed(), count: found.count }] : [];
      })
      .sort((x, y) => (x.partyId < y.partyId ? -1 : 1));
    // The answer is held to the contract before it leaves: an id, a real day, an amount and a count per party, one row each, and nothing else.
    return zFinanceOverdueReceivableSignals.parse(out);
  },
});
