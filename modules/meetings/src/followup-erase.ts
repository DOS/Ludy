// SPDX-License-Identifier: AGPL-3.0-only
// The copy of a meeting's text in its follow-up mails (L3, #2590; erasure #3016, ADR-0047 point 7). meetings.followup.send stores the shared summary, the decisions and the
// action items' owners as the merge data of each mail (crove_kernel.mail_message.payload, source 'meetings.followup', source_id the meeting). The mail queue drops that
// payload 30 days after a final status, which is later than a meeting's own delete, owner delete or text purge: so each of those paths drops it too, in the same transaction.
// The mail table lets a payload only be dropped (never changed): the guard trigger refuses any other change, and the tenant role holds UPDATE on the column for exactly this.
// A mail still queued then fails to render (the queue records TEMPLATE_DATA) rather than send the text of a meeting that no longer exists.
import { sql } from 'kysely';
import { FOLLOWUP_MAIL_SOURCE } from '@crove/kernel-contract';
import type { QueryContext } from '@crove/kernel-runtime';

type Ctx = { trx: QueryContext['trx']; orgId: string };

/** The lock one meeting's follow-up send and the drop below share: a send running while the meeting is deleted either finishes first (its mails are then seen and dropped) or
 * waits and finds the meeting gone, so no mail with the text outlives the delete. Held to the end of the transaction. */
export async function lockFollowup(ctx: Ctx, meetingId: string): Promise<void> {
  await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`meetings.followup:${ctx.orgId}:${meetingId}`}, 0))`.execute(ctx.trx);
}

/** Drops the payload of every follow-up mail of the meeting; answers how many were dropped (a count for the audit row, never text). */
export async function dropFollowupPayloads(ctx: Ctx, meetingId: string): Promise<number> {
  await lockFollowup(ctx, meetingId);
  const result = await ctx.trx
    .updateTable('crove_kernel.mail_message')
    .set({ payload: null })
    .where('org_id', '=', ctx.orgId)
    .where('source', '=', FOLLOWUP_MAIL_SOURCE)
    .where('source_id', '=', meetingId)
    .where('payload', 'is not', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
