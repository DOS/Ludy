// SPDX-License-Identifier: AGPL-3.0-only
// The CRM's side of the first cross-app rule (Vy V4, #2967; contract in packages/kernel-contract/src/signals.ts): `crm.signals.won_deals`, one small R0 read that
// answers the deals in the won stage as ids, a day and an amount, so the kernel can join them with Accounting's sales invoices by the party id. It reads one table
// pair and writes nothing, takes no model and no input.
//
// What it returns, per deal: the deal id, its party id, the day it was won (the Vietnam calendar day of `closed_at`, which moving the deal into the won stage stamps)
// and its amount (a decimal string; a deal is VND only today). Never a title, a party name, a note or a lost reason: the answer goes through the contract's strict
// schema before it leaves, so a field added by mistake fails here and not at a reader.
//
// Who sees which deal is the deal screens' own rule: a deal belongs to the whole org (the pipeline and the list show every deal to every role the CRM lists), so
// the row policy of the caller's own transaction (org only) is the only filter, and a member who can open a deal in the CRM gets its row. There is no legal-entity
// or owner scope on a deal to narrow it. The 500 most recently won deals are listed (the contract's cap); a cut leaves out only the oldest wins, so a longer list
// can hide a flag, never raise a false one.
import { zCrmWonDealSignals, type CrmWonDealSignal } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const LIMIT = 500;

export const crmWonDealsSignals = defineQuery({
  name: 'crm.signals.won_deals',
  input: z.strictObject({}),
  access: ALL,
  // An AI app the owner or an admin connected may run this read (ADR-0051, #2975, step S2): ids, dates and amounts only, run in the sealed context of the grant (no user, so nothing bound to a user answers).
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<CrmWonDealSignal[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const { rows } = await sql<{ deal_id: string; party_id: string; won_on: string; amount: string }>`
      SELECT d.id AS deal_id, d.party_id, to_char((d.closed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS won_on, d.amount::text AS amount
      FROM crove_crm.deal d
      JOIN crove_crm.pipeline_stage s ON s.org_id = d.org_id AND s.id = d.stage_id
      WHERE d.org_id = ${ctx.orgId}::uuid AND s.kind = 'won' AND d.closed_at IS NOT NULL
      ORDER BY d.closed_at DESC, d.id
      LIMIT ${LIMIT}`.execute(ctx.trx);
    // The answer is held to the contract before it leaves: ids, a real day and a non-negative amount, one object per deal and nothing else.
    return zCrmWonDealSignals.parse(rows.map((r) => ({ dealId: r.deal_id, partyId: r.party_id, wonOn: r.won_on, amount: r.amount })));
  },
});
