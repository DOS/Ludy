// SPDX-License-Identifier: AGPL-3.0-only
// The inbox's side of rule 4 of Vy's cross-app alerts (#3124, docs/plan/vy.md, capability C4; contract in packages/kernel-contract/src/signals.ts):
// `kernel.conversation.signals_unanswered`, one small R0 read that answers, for the parties it is asked about (the parties of the open deals), the conversation
// that has waited longest for an answer and since when, so the kernel can join it with the CRM's open deals by the party id. It writes nothing, calls no model
// and reads only the thread and message tables of the inbox.
//
// What it returns, per party: the id of the thread and the moment its oldest unanswered customer message arrived. Never a message, a name, a subject, a channel or a
// link: the answer goes through the contract's strict schema before it leaves, so a field added by mistake fails here and not at a reader.
//
// Who sees which thread is the inbox's own rule and nothing here widens it: the query runs in the member's own transaction and role, and `conversation_access` (row-level
// security on the thread and its messages) hides a thread the member may not read (a private message without the permission, a channel they are limited away from).
// A hidden thread is simply not in the answer, which can only mean no item for it, never a false one. It is the one read of the family that is not open to an AI app's
// grant: the context of a grant reads no conversation (the policy answers false for it), so it would answer "nothing waits" about threads it could not look at. It
// refuses instead, and the rule reports "could not check".
//
// "Unanswered" is the inbox's own state: status `new`, the customer wrote last and nobody has answered or resolved. The wait counts from the oldest customer message after
// the last message of the org's (any outbound message, whatever its delivery state: the thread is `pending` from the moment a reply is queued). A message the customer removed
// or the org hid does not wait. The instant is the later of the platform's time and the arrival time, so a mail whose Date header is years old never makes a thread look
// older than it is (the same care the thread's own activity time takes).
import { zConversationUnansweredSignals, zConversationUnansweredSignalsInput, type ConversationUnansweredSignal } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { sql } from 'kysely';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

export const conversationUnansweredSignals = defineQuery({
  name: 'kernel.conversation.signals_unanswered',
  input: zConversationUnansweredSignalsInput,
  access: ALL,
  handler: async (ctx, input): Promise<ConversationUnansweredSignal[]> => {
    // A person's own session only: no agent or system context, and no AI app's grant (see above).
    if (ctx.actor.type !== 'user' || ctx.actor.mcp !== undefined) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const { rows } = await sql<{ party_id: string; conversation_id: string; since: Date }>`
      SELECT DISTINCT ON (c.party_id) c.party_id, c.id AS conversation_id, w.since
      FROM crove_kernel.conversation c
      CROSS JOIN LATERAL (
        SELECT pg_catalog.min(GREATEST(m.sent_at, m.received_at)) AS since
        FROM crove_kernel.conversation_message m
        WHERE m.org_id = c.org_id AND m.conversation_id = c.id AND m.direction = 'in'
          AND m.platform_removed_at IS NULL AND m.hidden_at IS NULL
          AND m.seq > COALESCE((SELECT pg_catalog.max(o.seq) FROM crove_kernel.conversation_message o
                                WHERE o.org_id = c.org_id AND o.conversation_id = c.id AND o.direction = 'out'), 0)
      ) w
      WHERE c.org_id = ${ctx.orgId}::uuid AND c.status = 'new' AND w.since IS NOT NULL
        AND c.party_id IN (${sql.join(input.partyIds.map((id) => sql`${id}::uuid`))})
      ORDER BY c.party_id, w.since, c.id`.execute(ctx.trx);
    // The answer is held to the contract before it leaves: two ids and an instant per party and nothing else.
    return zConversationUnansweredSignals.parse(rows.map((r) => ({ partyId: r.party_id, conversationId: r.conversation_id, since: r.since.toISOString() })));
  },
});

export const conversationSignalsQueries = [conversationUnansweredSignals];
