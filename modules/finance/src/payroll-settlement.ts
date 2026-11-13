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
import { VOUCHER_SOURCE } from './domain/cash-voucher.ts';
import { JOURNAL_VOUCHER_SOURCE } from './domain/journal-voucher.ts';
import { reversedSource } from './source-entry.ts';

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
  // A reversed posting frees the run (#2931): the run is `posted` while any of its posting vouchers stands, `reversed` when all were reversed and nothing new waits, `pending` when a new proposal
  // waits in the Inbox (also after a reversal), `none` when the run was never posted.
  const vouchers = await ctx.trx
    .selectFrom('crove_finance.journal_voucher as j')
    .select(reversedSource('j', JOURNAL_VOUCHER_SOURCE).as('reversed'))
    .where('j.org_id', '=', ctx.orgId)
    .where('j.payroll_run_id', '=', runId)
    .execute();
  if (vouchers.some((v) => !v.reversed)) return { status: 'posted', proposalId: null };
  const open = await openProposals(ctx, PAYROLL_POSTING_COMMAND, runId);
  if (open[0]) return { status: 'pending', proposalId: open[0].id };
  return { status: vouchers.length > 0 ? 'reversed' : 'none', proposalId: null };
}

export const payrollSettlement = defineQuery({
  name: 'finance.payroll.settlement',
  input: zPayrollSettlementRef,
  access: ['owner', 'admin'] as const,
  handler: async (ctx, { runId }): Promise<PayrollSettlement> => {
    const posting = await postingOf(ctx, runId);
    // A payment voucher that was reversed no longer counts as recorded: its kind is free again and the card offers the step (#2854).
    const recorded = await ctx.trx
      .selectFrom('crove_finance.cash_voucher as v')
      .select('v.payroll_payment_kind')
      .where('v.org_id', '=', ctx.orgId)
      .where('v.payroll_run_id', '=', runId)
      .where(sql<boolean>`NOT ${reversedSource('v', VOUCHER_SOURCE)}`)
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
