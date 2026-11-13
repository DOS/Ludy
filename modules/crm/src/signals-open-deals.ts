// SPDX-License-Identifier: AGPL-3.0-only
// The CRM's side of rule 2 (Vy V5, #2969; contract in packages/kernel-contract/src/signals.ts): `crm.signals.open_deals`, one small R0 read that answers the deals still in
// play (a stage that is neither won nor lost) as a deal id and its party id, so the kernel can join them with Accounting's overdue receivables by the party id. It reads one
// table pair and writes nothing, takes no model and no input.
//
// What it returns, per deal: the deal id and its party id. Never an amount, a title, a party name, a note or a stage name; the answer goes through the contract's strict
// schema before it leaves, so a field added by mistake fails here and not at a reader.
//
// Who sees which deal is the deal screens' own rule: a deal belongs to the whole org (the pipeline and the list show every deal to every role the CRM lists), so the row
// policy of the caller's own transaction (org only) is the only filter. The 500 most recently created open deals are listed (the contract's cap); a longer list can hide
// a flag (the oldest open deals), never raise a false one.
import { zCrmOpenDealSignals, type CrmOpenDealSignal } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const LIMIT = 500;

export const crmOpenDealsSignals = defineQuery({
  name: 'crm.signals.open_deals',
  input: z.strictObject({}),
  access: ALL,
  // An AI app the owner or an admin connected may run this read (ADR-0051, #2975, step S2): ids, dates and amounts only, run in the sealed context of the grant (no user, so nothing bound to a user answers).
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<CrmOpenDealSignal[]> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const { rows } = await sql<{ deal_id: string; party_id: string }>`
      SELECT d.id AS deal_id, d.party_id
      FROM crove_crm.deal d
      JOIN crove_crm.pipeline_stage s ON s.org_id = d.org_id AND s.id = d.stage_id
      WHERE d.org_id = ${ctx.orgId}::uuid AND s.kind = 'open' AND d.closed_at IS NULL
      ORDER BY d.created_at DESC, d.id
      LIMIT ${LIMIT}`.execute(ctx.trx);
    // The answer is held to the contract before it leaves: two ids per deal and nothing else.
    return zCrmOpenDealSignals.parse(rows.map((r) => ({ dealId: r.deal_id, partyId: r.party_id })));
  },
});
