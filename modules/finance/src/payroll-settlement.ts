// SPDX-License-Identifier: AGPL-3.0-only
// Where the posting and the payments of an approved pay run stand (#2532, docs/plan/payroll.md 6.4), for the card of the month in the payroll screen. Finance reads its own books and the open
// proposals; nothing here touches a person's line, so the answer holds no name and no amount. Owners and admins, who are the ones that ask for a posting or a payment.
import { sql } from 'kysely';
import {
  PAYROLL_PAYMENT_COMMAND,
  PAYROLL_PAYMENT_KINDS,
  PAYROLL_POSTING_COMMAND,
  zPayrollSettlementRef,
  type PayrollPaymentKind,
  type PayrollSettlement,
} from '@crove/kernel-contract';
import { defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { JOURNAL_VOUCHER_SOURCE } from './domain/journal-voucher.ts';
import { latestRevision } from './source-entry.ts';

type Posting = PayrollSettlement['posting'];

// The open proposals of a command that name this run, newest first: the run id is a field of the request input, compared in lower case as it was typed.
async function openProposals(ctx: QueryContext, command: string, runId: string): Promise<{ id: string; kind: string | null }[]> {
  const rows = await ctx.trx
    .selectFrom('crove_kernel.proposal')
    .select(['id'])
    .select(sql<string | null>`request_input ->> 'kind'`.as('kind'))
    .where('org_id', '=', ctx.orgId)
    .where('command', '=', command)
    .where('status', '=', 'pending')
    .where(sql<boolean>`lower(request_input ->> 'runId') = ${runId.toLowerCase()}`)
    .orderBy('created_at', 'desc')
    .execute();
  return rows;
}

async function postingOf(ctx: QueryContext, runId: string): Promise<Posting> {
  const vouchers = await ctx.trx.selectFrom('crove_finance.journal_voucher').select('id').where('org_id', '=', ctx.orgId).where('payroll_run_id', '=', runId).execute();
  if (vouchers.length > 0) {
    const entries = await ctx.trx
      .selectFrom('crove_finance.journal_entry as e')
      .select(['e.id', 'e.reverses_entry_id'])
      .where('e.org_id', '=', ctx.orgId)
      .where('e.source_type', '=', JOURNAL_VOUCHER_SOURCE)
      .where('e.source_id', 'in', vouchers.map((v) => v.id))
      .where(latestRevision('e'))
      .execute();
    const ids = entries.filter((e) => e.reverses_entry_id === null).map((e) => e.id);
    if (ids.length > 0) {
      const reversals = await ctx.trx.selectFrom('crove_finance.journal_entry').select('reverses_entry_id').where('org_id', '=', ctx.orgId).where('reverses_entry_id', 'in', ids).execute();
      const reversed = new Set(reversals.map((r) => r.reverses_entry_id));
      return { status: ids.every((id) => reversed.has(id)) ? 'reversed' : 'posted', proposalId: null };
    }
  }
  const open = await openProposals(ctx, PAYROLL_POSTING_COMMAND, runId);
  return open[0] ? { status: 'pending', proposalId: open[0].id } : { status: 'none', proposalId: null };
}

export const payrollSettlement = defineQuery({
  name: 'finance.payroll.settlement',
  input: zPayrollSettlementRef,
  access: ['owner', 'admin'] as const,
  handler: async (ctx, { runId }): Promise<PayrollSettlement> => {
    const posting = await postingOf(ctx, runId);
    const recorded = await ctx.trx
      .selectFrom('crove_finance.cash_voucher')
      .select('payroll_payment_kind')
      .where('org_id', '=', ctx.orgId)
      .where('payroll_run_id', '=', runId)
      .execute();
    const done = new Set(recorded.map((v) => v.payroll_payment_kind));
    const open = await openProposals(ctx, PAYROLL_PAYMENT_COMMAND, runId);
    const step = (kind: PayrollPaymentKind): PayrollSettlement['payments'][PayrollPaymentKind] => {
      if (done.has(kind)) return { status: 'recorded', proposalId: null };
      const waiting = open.find((p) => p.kind === kind);
      return waiting ? { status: 'pending', proposalId: waiting.id } : { status: 'none', proposalId: null };
    };
    const [net_pay, insurance, union, tax] = PAYROLL_PAYMENT_KINDS.map(step) as [
      PayrollSettlement['payments']['net_pay'],
      PayrollSettlement['payments']['insurance'],
      PayrollSettlement['payments']['union'],
      PayrollSettlement['payments']['tax'],
    ];
    return { runId, posting, payments: { net_pay, insurance, union, tax } };
  },
});
