// SPDX-License-Identifier: AGPL-3.0-only
// What the sales coworker needs to draft the follow-up of one "Cần theo dõi" step (issue #3101, docs/plan/crm.md 4.4a, docs/plan/crm-quotes.md section 7):
// - crm.followup.source (owners, admins, members; read only): the open step's reason, the deal's contact (name and email), the days the deal was quiet (or since its expected close, or
//   since its quote was sent; for an expiring quote the days left) and the deal's sent quote with its number, its total as a decimal string and its validity. The facts are the books':
//   code builds them, the model never sees them (packages/agent crm-followup.ts). No customer message, tax code, address, phone or bank account is read.
// Nothing is written here, no agent runs it, and it leaves no audit row: a read of the member's own records. The link to the quote is made by the person's own command
// (crm.quote.create_link) when the draft is asked for, so its audit row says who made it; the model is asked outside any transaction, by the API.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, type DealNextStepReason } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineQuery } from '@crove/kernel-runtime';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

export interface FollowupSource {
  nextStepId: string;
  reason: DealNextStepReason;
  dealId: string;
  contactName: string;
  contactEmail: string | null;
  // The org's own name: the words of a draft never say it.
  orgName: string;
  // The days quiet; since the expected close; since the sent quote of the draft was sent; for an expiring quote the days left (0 on its last day). Never below 0.
  days: number;
  // The deal's current sent quote, if it has one; null for a deal with none.
  quote: { id: string; label: string; total: string; validUntil: string } | null;
}

export const followupSource = defineQuery({
  name: 'crm.followup.source',
  input: z.strictObject({ nextStepId: zId }),
  access: EDITORS,
  handler: async (ctx, input): Promise<FollowupSource> => {
    const found = await sql<{ id: string; deal_id: string; party_id: string; reason: DealNextStepReason; status: string; party_name: string; party_email: string | null; days: number; org_name: string; closed: boolean }>`
      SELECT n.id, n.deal_id, d.party_id, n.reason, n.status, p.name AS party_name, p.email AS party_email, d.closed_at IS NOT NULL AS closed,
             greatest(((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - n.since_on), 0)::int AS days,
             (SELECT t.name FROM crove_kernel.tenant t WHERE t.org_id = n.org_id) AS org_name
      FROM crove_crm.deal_next_step n
      JOIN crove_crm.deal d ON d.org_id = n.org_id AND d.id = n.deal_id
      JOIN crove_kernel.party p ON p.org_id = d.org_id AND p.id = d.party_id
      WHERE n.org_id = ${ctx.orgId}::uuid AND n.id = ${input.nextStepId}::uuid`.execute(ctx.trx);
    const step = found.rows[0];
    if (!step) throw new DomainError('NEXT_STEP_NOT_FOUND', 404, 'Không tìm thấy việc cần theo dõi này');
    if (step.status !== 'open' || step.closed) throw new DomainError('NEXT_STEP_NOT_OPEN', 409, 'Việc này đã xong hoặc đã đóng, không cần soạn tin nhắc nữa');
    const quoteStep = step.reason === 'quote_unanswered' || step.reason === 'quote_expiring';
    // Only a quote that is still valid today (expiry is not stored, so an expired quote stays `sent`: it is never reminded about). Each step takes the quote its own reason is about, so the days
    // and the quote of one draft are always the same quote's: an unanswered step the one sent longest ago, an expiring step the one that expires first, any other step the latest sent.
    const order =
      step.reason === 'quote_unanswered'
        ? sql`coalesce(q.sent_at, q.created_at) ASC, q.id ASC`
        : step.reason === 'quote_expiring'
          ? sql`q.valid_until ASC, q.id ASC`
          : sql`coalesce(q.sent_at, q.created_at) DESC, q.id DESC`;
    const sent = await sql<{ id: string; number: string | null; revision: number; total: string; valid_until: string; left_days: number; sent_days: number }>`
      SELECT q.id, q.number, q.revision, q.total::text AS total, q.valid_until::text AS valid_until,
             greatest((q.valid_until - (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date), 0)::int AS left_days,
             greatest(((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - (coalesce(q.sent_at, q.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date), 0)::int AS sent_days
      FROM crove_crm.quote q
      WHERE q.org_id = ${ctx.orgId}::uuid AND q.deal_id = ${step.deal_id}::uuid AND q.status = 'sent' AND q.number IS NOT NULL
        AND q.valid_until >= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      ORDER BY ${order}
      LIMIT 1`.execute(ctx.trx);
    const quote = sent.rows[0] ?? null;
    // A step about a quote that nobody waits for any more (accepted, declined, replaced, deleted or expired) closes at the next daily run or stays until it is dealt with; there is nothing to remind about.
    if (quoteStep && !quote) throw new DomainError('QUOTE_NOT_WAITING', 409, 'Báo giá này đã được trả lời hoặc thay bằng bản mới, không cần nhắc nữa');
    return {
      nextStepId: step.id,
      reason: step.reason,
      dealId: step.deal_id,
      contactName: step.party_name,
      contactEmail: step.party_email,
      orgName: step.org_name,
      days: quote && step.reason === 'quote_expiring' ? quote.left_days : quote && step.reason === 'quote_unanswered' ? quote.sent_days : step.days,
      quote: quote ? { id: quote.id, label: quote.revision > 1 ? `${quote.number}-R${quote.revision}` : (quote.number as string), total: quote.total, validUntil: quote.valid_until } : null,
    };
  },
});

export const followupQueries = [followupSource];
