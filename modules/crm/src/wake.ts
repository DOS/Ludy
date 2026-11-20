// SPDX-License-Identifier: AGPL-3.0-only
// The CRM's side of Engage's wake rules (#3862, E3 of epic #3857; contract in packages/kernel-contract/src/engage-wake.ts): one small R0 read, `crm.wake.facts`, that the wake sweep runs as an AI coworker's grant
// (in its sealed context, a company grant's consenting owner or admin) and that answers only ids, a day and an amount:
//   - the open follow-ups of a sent quote nobody answered (`quote_unanswered`, the CRM's next step raised N days after the quote was sent, N set in Settings; the same step Home lists in "Hôm nay cần bạn"):
//     the step, its deal, the day the quote was sent and the DEAL's amount (not the quote's total) with the deal's own currency, raised in the last week (so connecting a wake-up late does not wake the coworker about old steps);
//   - the confirmed bookings that start tomorrow (Vietnam's calendar).
// A read gives at most ENGAGE_WAKE_ROWS_MAX rows of each list from `offset`; the sweep asks for the next page while a list came back full. Never a customer's name, a contact, a deal's title, a quote number, a note, a guest's words or a link: the answer goes through the contract's strict schema before it leaves. It writes nothing and calls no model.
import { sql } from 'kysely';
import { ENGAGE_WAKE_ROWS_MAX, vietnamToday, zEngageWakeCrm, zEngageWakeCrmInput, type EngageWakeCrm } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const DAY_MS = 86_400_000;
const VIETNAM_OFFSET = '+07:00';

export const crmWakeFacts = defineQuery({
  name: 'crm.wake.facts',
  input: zEngageWakeCrmInput,
  access: MANAGERS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<EngageWakeCrm> => {
    // A company grant's alone: the CRM's whole book is the owner's and admin's, so a member-bound grant (and a member) has no way in.
    if (ctx.actor.type !== 'user' || ctx.actor.mcp?.kind === 'member') throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP của công ty hoặc chủ sở hữu, quản trị viên mới dùng được truy vấn này');
    const now = new Date();
    const tomorrow = vietnamToday(new Date(now.getTime() + DAY_MS));
    const from = new Date(`${tomorrow}T00:00:00${VIETNAM_OFFSET}`);
    const to = new Date(from.getTime() + DAY_MS);
    const raisedSince = new Date(now.getTime() - 7 * DAY_MS);

    const steps = await sql<{ step_id: string; deal_id: string; since_on: string; amount: string; currency: string }>`
      SELECT n.id AS step_id, n.deal_id, n.since_on::text AS since_on, d.amount::text AS amount, d.currency
      FROM crove_crm.deal_next_step n
      JOIN crove_crm.deal d ON d.org_id = n.org_id AND d.id = n.deal_id
      WHERE n.org_id = ${ctx.orgId}::uuid AND n.status = 'open' AND n.reason = 'quote_unanswered'
        AND (n.snoozed_until IS NULL OR n.snoozed_until <= ${now}::timestamptz)
        AND n.raised_at >= ${raisedSince}::timestamptz AND d.closed_at IS NULL
      ORDER BY n.since_on DESC, n.id
      LIMIT ${ENGAGE_WAKE_ROWS_MAX} OFFSET ${input.offset}`.execute(ctx.trx);

    const bookings = await sql<{ booking_id: string; on: string }>`
      SELECT b.id AS booking_id, (b.starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS on
      FROM crove_crm.booking b
      WHERE b.org_id = ${ctx.orgId}::uuid AND b.status = 'confirmed' AND b.starts_at >= ${from}::timestamptz AND b.starts_at < ${to}::timestamptz
      ORDER BY b.starts_at, b.id
      LIMIT ${ENGAGE_WAKE_ROWS_MAX} OFFSET ${input.offset}`.execute(ctx.trx);

    // Held to the contract before it leaves: ids, two days and an amount.
    return zEngageWakeCrm.parse({
      quoteSteps: steps.rows.map((r) => ({ stepId: r.step_id, dealId: r.deal_id, sinceOn: r.since_on, dealAmount: r.amount, currency: r.currency })),
      bookingsTomorrow: bookings.rows.map((r) => ({ bookingId: r.booking_id, on: r.on })),
    });
  },
});

export const crmWakeQueries = [crmWakeFacts];
