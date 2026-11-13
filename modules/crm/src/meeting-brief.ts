// SPDX-License-Identifier: AGPL-3.0-only
// What the sales coworker (Dy) may see when it prepares the brief before a booking that is linked to a deal (#3115, docs/plan/calendar.md "Deal links as built"):
// - crm.booking.meeting_brief_source (owners, admins, members; read only): the facts of the brief, built by code. The booking is read under the screen's own rule (a member reads the bookings they
//   host or hold, an owner or an admin all of them; any other is not found), and only a confirmed booking that has not ended and is linked to a deal has a brief. From the deal: its title, stage,
//   amount as a decimal string, expected close and its contact's name; the open next steps; the latest sent quote to that contact (number, total as a decimal string, status, validity); and the
//   customer's latest inbound messages of the conversations linked to the contact, as far as the member may read them: row-level security applies, so a direct or email message is read by owners,
//   admins and holders of the direct-message permission, and a member limited to some channels reads those channels' messages only. A member who may not read a conversation gets the brief
//   without its messages. `wordsAllowed` says whether the org lets customers' words reach a model (conversation_setting.auto_draft); the API gives the model no message while it is off.
//   No email, phone, address, tax code, bank account or credential is read.
// Nothing is written here, no agent runs it (it is not in the agent's allowlist), and it leaves no audit row: a read of the member's own records. The model is asked outside any transaction, by the API.
import { sql } from 'kysely';
import { z } from 'zod';
import { zId, zonedDate, zoneOffsetMs } from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { money } from '@crove/l10n-vn';
import { DomainError, defineQuery } from '@crove/kernel-runtime';
import { readableBooking } from './bookings.ts';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// The most messages read and the most characters of each (packages/agent MEETING_BRIEF_MESSAGES_MAX and MEETING_BRIEF_MESSAGE_CHARS say the same).
export const MEETING_BRIEF_MESSAGES = 5;
const MESSAGE_CHARS = 300;
const DAY_MS = 86_400_000;

export type MeetingBriefStepReason = 'no_activity' | 'past_close' | 'quote_unanswered' | 'quote_expiring';

export interface MeetingBriefSource {
  bookingId: string;
  dealId: string;
  // Whether the org lets customers' words reach a model (the default is yes, as for reply drafts).
  wordsAllowed: boolean;
  meeting: { title: string; startsOn: string; startsTime: string; guestName: string | null };
  deal: { title: string; stage: string; status: 'open' | 'won' | 'lost'; amount: string | null; expectedClose: string | null; contactName: string };
  nextSteps: Array<{ reason: MeetingBriefStepReason; sinceOn: string }>;
  quote: { label: string; total: string; status: 'sent' | 'accepted' | 'declined' | 'superseded'; validUntil: string; expired: boolean; sentOn: string | null } | null;
  // The customer's newest inbound messages that the member may read, oldest first.
  messages: string[];
}

// "09:30" on the wall clock of the zone.
function timeOf(timeZone: string, at: number): string {
  const minutes = Math.round((((at + zoneOffsetMs(timeZone, at)) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export const meetingBriefSourceQuery = defineQuery({
  name: 'crm.booking.meeting_brief_source',
  input: z.strictObject({ bookingId: zId }),
  access: EDITORS,
  handler: async (ctx, input): Promise<MeetingBriefSource> => {
    const booking = await readableBooking(ctx, input.bookingId);
    if (booking.deal === null) throw new DomainError('BOOKING_NO_DEAL', 409, 'Lịch hẹn này chưa liên kết với cơ hội nào');
    if (booking.status !== 'confirmed' || Date.parse(booking.endsAt) <= Date.now()) throw new DomainError('BOOKING_NOT_UPCOMING', 409, 'Chỉ chuẩn bị được cho lịch hẹn sắp tới');
    const found = await sql<{ title: string; amount: string; expected_close: string | null; party_id: string; party_name: string; stage: string; kind: 'open' | 'won' | 'lost' }>`
      SELECT d.title, d.amount::text AS amount, d.expected_close::text AS expected_close, d.party_id, p.name AS party_name, s.name AS stage, s.kind
      FROM crove_crm.deal d
      JOIN crove_kernel.party p ON p.org_id = d.org_id AND p.id = d.party_id
      JOIN crove_crm.pipeline_stage s ON s.org_id = d.org_id AND s.id = d.stage_id
      WHERE d.org_id = ${ctx.orgId}::uuid AND d.id = ${booking.deal.id}::uuid`.execute(ctx.trx);
    const deal = found.rows[0];
    if (!deal) throw new DomainError('DEAL_NOT_FOUND', 404, 'Không tìm thấy cơ hội này');
    const steps = await sql<{ reason: MeetingBriefStepReason; since_on: string }>`
      SELECT n.reason, n.since_on::text AS since_on
      FROM crove_crm.deal_next_step n
      WHERE n.org_id = ${ctx.orgId}::uuid AND n.deal_id = ${booking.deal.id}::uuid AND n.status = 'open' AND (n.snoozed_until IS NULL OR n.snoozed_until <= now())
      ORDER BY n.since_on, n.id
      LIMIT 3`.execute(ctx.trx);
    // Only a quote to the deal's customer as they are now (a deal moved to another customer keeps the quotes made to the first one: their total is not the new customer's to read), and only one
    // that was sent (a draft has no number). Expiry is not stored, so a lapsed quote stays `sent` and is told apart here.
    const quotes = await sql<{ number: string; revision: number; total: string; status: 'sent' | 'accepted' | 'declined' | 'superseded'; valid_until: string; expired: boolean; sent_on: string | null }>`
      SELECT q.number, q.revision, q.total::text AS total, q.status, q.valid_until::text AS valid_until,
             (q.status = 'sent' AND q.valid_until < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS expired,
             ((coalesce(q.sent_at, q.created_at)) AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS sent_on
      FROM crove_crm.quote q
      WHERE q.org_id = ${ctx.orgId}::uuid AND q.deal_id = ${booking.deal.id}::uuid AND q.party_id = ${deal.party_id}::uuid AND q.number IS NOT NULL AND q.status IN ('sent', 'accepted', 'declined')
      ORDER BY coalesce(q.sent_at, q.created_at) DESC, q.id DESC
      LIMIT 1`.execute(ctx.trx);
    const setting = await sql<{ auto_draft: boolean }>`SELECT auto_draft FROM crove_kernel.conversation_setting WHERE org_id = ${ctx.orgId}::uuid`.execute(ctx.trx);
    // The messages go through the member's own row-level security: a conversation they may not read gives none.
    const said = await sql<{ body: string }>`
      SELECT pg_catalog.left(m.body, ${MESSAGE_CHARS}::int) AS body
      FROM crove_kernel.conversation_message m
      JOIN crove_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id
      WHERE c.org_id = ${ctx.orgId}::uuid AND c.party_id = ${deal.party_id}::uuid AND m.direction = 'in' AND m.platform_removed_at IS NULL AND m.body <> ''
      ORDER BY m.id DESC LIMIT ${MEETING_BRIEF_MESSAGES}::int`.execute(ctx.trx);
    const startsAt = Date.parse(booking.startsAt);
    const amount = money(deal.amount);
    const quote = quotes.rows[0];
    return {
      bookingId: booking.id,
      dealId: booking.deal.id,
      wordsAllowed: setting.rows[0]?.auto_draft ?? true,
      meeting: { title: booking.eventType.title, startsOn: zonedDate(booking.timeZone, startsAt), startsTime: timeOf(booking.timeZone, startsAt), guestName: booking.visitor.name },
      deal: { title: deal.title, stage: deal.stage, status: deal.kind, amount: amount.greaterThan(0) ? amount.toFixed() : null, expectedClose: deal.expected_close, contactName: deal.party_name },
      nextSteps: steps.rows.map((r) => ({ reason: r.reason, sinceOn: r.since_on })),
      quote: quote
        ? { label: quote.revision > 1 ? `${quote.number}-R${quote.revision}` : quote.number, total: money(quote.total).toFixed(), status: quote.status, validUntil: quote.valid_until, expired: quote.expired, sentOn: quote.sent_on }
        : null,
      messages: said.rows.map((r) => r.body).reverse(),
    };
  },
});

export const meetingBriefQueries = [meetingBriefSourceQuery];
