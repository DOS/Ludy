// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic pre-meeting contact facts (#4991 PM1, AI-free):
// Given an upcoming synced calendar event (agenda), a Ludy booking (booking), or a recorded meeting (meeting),
// finds up to 3 matching contacts by case-folded attendee email under the caller's own RLS and returns:
//   - open deals (title, stage, decimal-string amount, expectedClose)
//   - latest sent quote (label, decimal-string total, status, validUntil, expired, sentOn)
//   - finance invoice summary via finance.party.invoice_summary (counts, dates, decimal-string overdueAmount)
//   - newest 5 inbound messages of readable conversations under RLS (plus wordsAllowed from auto_draft, as in #3115)
// Writes nothing, audits nothing, runs no AI model, and omits email, phone, address, tax code, and bank accounts.
import { sql } from 'kysely';
import {
  MEETING_BRIEF_QUOTE_STATUSES,
  MEETING_FACTS_CONTACTS_MAX,
  MEETING_FACTS_DEALS_MAX,
  MEETING_FACTS_MESSAGES_MAX,
  SIGNAL_PARTIAL_VIEW_CODE,
  zCrmBookingBriefTargetInput,
  zCrmBookingBriefTargetOutput,
  zMeetingFactsInput,
  zMeetingFactsOutput,
  type MeetingFactsContact,
  type MeetingFactsDeal,
  type MeetingFactsOutput,
  type MeetingFactsQuote,
  type MeetingsAttendeeHashesOutput,
  type PartyInvoiceSummary,
  type PartyInvoiceSummaryOutput,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { money } from '@ludy/l10n-vn';
import { readableBooking } from './bookings.ts';

const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const MESSAGE_CHARS = 300;
const ISO_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

interface MatchedParty {
  id: string;
  name: string;
}

async function resolveBookingMatchedParties(ctx: QueryContext, bookingId: string): Promise<MatchedParty[]> {
  const booking = await readableBooking(ctx, bookingId);
  const email = booking.email?.trim().toLowerCase() ?? '';
  if (email === '') return [];
  const { rows } = await sql<MatchedParty>`
    SELECT k.id, k.name
    FROM (
      SELECT DISTINCT COALESCE(p.duplicate_of, p.id) AS kept_id
      FROM ludy_kernel.party p
      WHERE p.org_id = ${ctx.orgId}::uuid
        AND p.email IS NOT NULL
        AND pg_catalog.lower(pg_catalog.btrim(p.email)) = ${email}
    ) m
    JOIN ludy_kernel.party k ON k.org_id = ${ctx.orgId}::uuid AND k.id = m.kept_id
    ORDER BY k.name, k.id
    LIMIT ${MEETING_FACTS_CONTACTS_MAX}
  `.execute(ctx.trx);
  return rows;
}

async function resolveHashesMatchedParties(
  ctx: QueryContext,
  hashes: readonly string[],
  calendarEventIds: readonly string[],
): Promise<MatchedParty[]> {
  const matched = new Map<string, MatchedParty>();

  if (hashes.length > 0) {
    const hashList = [...new Set(hashes)];
    const { rows } = await sql<MatchedParty>`
      SELECT k.id, k.name
      FROM (
        SELECT DISTINCT COALESCE(p.duplicate_of, p.id) AS kept_id
        FROM ludy_kernel.party p
        WHERE p.org_id = ${ctx.orgId}::uuid
          AND p.email IS NOT NULL
          AND ludy_kernel.email_exact_hash(p.email) = ANY(${hashList}::text[])
      ) m
      JOIN ludy_kernel.party k ON k.org_id = ${ctx.orgId}::uuid AND k.id = m.kept_id
      ORDER BY k.name, k.id
      LIMIT ${MEETING_FACTS_CONTACTS_MAX}
    `.execute(ctx.trx);
    for (const r of rows) matched.set(r.id, r);
  }

  if (matched.size < MEETING_FACTS_CONTACTS_MAX && calendarEventIds.length > 0) {
    const { rows: candidateBookings } = await sql<{ id: string }>`
      SELECT b.id
      FROM ludy_crm.booking b
      WHERE b.org_id = ${ctx.orgId}::uuid
        AND b.calendar_event_id = ANY(${[...calendarEventIds]}::uuid[])
        AND b.email IS NOT NULL
        AND pg_catalog.btrim(b.email) <> ''
        AND b.status = 'confirmed'
      LIMIT 10
    `.execute(ctx.trx);

    const emailSet = new Set<string>();
    for (const candidate of candidateBookings) {
      try {
        const readable = await readableBooking(ctx, candidate.id);
        const normalized = readable.email?.trim().toLowerCase() ?? '';
        if (normalized !== '') emailSet.add(normalized);
      } catch (err) {
        if (!(err instanceof DomainError && err.code === 'BOOKING_NOT_FOUND')) throw err;
      }
    }

    const emails = [...emailSet];
    if (emails.length > 0) {
      const { rows: extra } = await sql<MatchedParty>`
        SELECT k.id, k.name
        FROM (
          SELECT DISTINCT COALESCE(p.duplicate_of, p.id) AS kept_id
          FROM ludy_kernel.party p
          WHERE p.org_id = ${ctx.orgId}::uuid
            AND p.email IS NOT NULL
            AND pg_catalog.lower(pg_catalog.btrim(p.email)) = ANY(${emails}::text[])
        ) m
        JOIN ludy_kernel.party k ON k.org_id = ${ctx.orgId}::uuid AND k.id = m.kept_id
        ORDER BY k.name, k.id
        LIMIT ${MEETING_FACTS_CONTACTS_MAX}
      `.execute(ctx.trx);
      for (const r of extra) {
        if (matched.size >= MEETING_FACTS_CONTACTS_MAX) break;
        if (!matched.has(r.id)) matched.set(r.id, r);
      }
    }
  }

  return [...matched.values()].slice(0, MEETING_FACTS_CONTACTS_MAX);
}

export const crmBookingBriefTargetQuery = defineQuery({
  name: 'crm.booking.brief_target',
  input: zCrmBookingBriefTargetInput,
  access: EDITORS,
  handler: async (ctx, input) => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    try {
      await readableBooking(ctx, input.bookingId);
      return zCrmBookingBriefTargetOutput.parse({ readable: true });
    } catch (err) {
      if (err instanceof DomainError && err.code === 'BOOKING_NOT_FOUND') {
        return zCrmBookingBriefTargetOutput.parse({ readable: false });
      }
      throw err;
    }
  },
});

export const contactMeetingFactsQuery = defineQuery({
  name: 'crm.contact.meeting_facts',
  input: zMeetingFactsInput,
  access: EDITORS,
  handler: async (ctx, input): Promise<MeetingFactsOutput> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới đọc được tóm tắt liên hệ trước cuộc họp');
    }

    const setting = await sql<{ auto_draft: boolean }>`
      SELECT auto_draft FROM ludy_kernel.conversation_setting WHERE org_id = ${ctx.orgId}::uuid
    `.execute(ctx.trx);
    const wordsAllowed = setting.rows[0]?.auto_draft ?? true;

    let parties: MatchedParty[] = [];
    if (input.targetKind === 'booking') {
      parties = await resolveBookingMatchedParties(ctx, input.targetId);
    } else {
      const attendees = await ctx.query<MeetingsAttendeeHashesOutput>('meetings.agenda.attendee_hashes', {
        targetKind: input.targetKind,
        targetId: input.targetId,
      });
      if (attendees.status === 'not_installed') {
        return zMeetingFactsOutput.parse({ targetKind: input.targetKind, targetId: input.targetId, wordsAllowed, contacts: [] });
      }
      if (!attendees.value.found) {
        if (input.targetKind === 'agenda') throw new DomainError('AGENDA_NOT_FOUND', 404, 'Không tìm thấy sự kiện lịch');
        throw new DomainError('MEETING_NOT_FOUND', 404, 'Không tìm thấy cuộc họp');
      }
      parties = await resolveHashesMatchedParties(ctx, attendees.value.hashes, attendees.value.calendarEventIds);
    }

    if (parties.length === 0) {
      return zMeetingFactsOutput.parse({
        targetKind: input.targetKind,
        targetId: input.targetId,
        wordsAllowed,
        contacts: [],
      });
    }

    const partyIds = parties.map((p) => p.id);
    const groupRows = await sql<{ id: string; kept_id: string }>`
      SELECT p.id, COALESCE(p.duplicate_of, p.id) AS kept_id
      FROM ludy_kernel.party p
      WHERE p.org_id = ${ctx.orgId}::uuid
        AND (p.id = ANY(${partyIds}::uuid[]) OR p.duplicate_of = ANY(${partyIds}::uuid[]))
    `.execute(ctx.trx);
    const allGroupPartyIds = groupRows.rows.map((r) => r.id);

    const today = ISO_DAY.format(ctx.now);

    const dealsResult = await sql<{
      id: string;
      kept_id: string;
      title: string;
      amount: string;
      expected_close: string | null;
      stage: string;
    }>`
      WITH ranked_deals AS (
        SELECT
          d.id,
          COALESCE(p.duplicate_of, p.id) AS kept_id,
          d.title,
          d.amount::text AS amount,
          d.expected_close::text AS expected_close,
          s.name AS stage,
          ROW_NUMBER() OVER (PARTITION BY COALESCE(p.duplicate_of, p.id) ORDER BY d.updated_at DESC, d.id DESC) AS rn
        FROM ludy_crm.deal d
        JOIN ludy_crm.pipeline_stage s ON s.org_id = d.org_id AND s.id = d.stage_id
        JOIN ludy_kernel.party p ON p.org_id = d.org_id AND p.id = d.party_id
        WHERE d.org_id = ${ctx.orgId}::uuid
          AND d.party_id = ANY(${allGroupPartyIds}::uuid[])
          AND s.kind = 'open'
      )
      SELECT id, kept_id, title, amount, expected_close, stage
      FROM ranked_deals
      WHERE rn <= ${MEETING_FACTS_DEALS_MAX}
      ORDER BY kept_id, rn
    `.execute(ctx.trx);

    const dealsByKept = new Map<string, MeetingFactsDeal[]>();
    for (const row of dealsResult.rows) {
      const list = dealsByKept.get(row.kept_id) ?? [];
      const amount = money(row.amount);
      list.push({
        dealId: row.id,
        title: row.title,
        stage: row.stage,
        amount: amount.greaterThan(0) ? amount.toFixed() : null,
        expectedClose: row.expected_close,
      });
      dealsByKept.set(row.kept_id, list);
    }

    const sentQuotesResult = await sql<{
      id: string;
      kept_id: string;
      number: string;
      revision: number;
      status: 'sent' | 'accepted' | 'declined' | 'superseded';
      total: string;
      valid_until: string;
      sent_at: Date | null;
    }>`
      WITH ranked_quotes AS (
        SELECT
          q.id,
          COALESCE(p.duplicate_of, p.id) AS kept_id,
          q.number,
          q.revision,
          q.status,
          q.total::text AS total,
          q.valid_until::text AS valid_until,
          q.sent_at,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(p.duplicate_of, p.id)
            ORDER BY COALESCE(q.sent_at, q.created_at) DESC, q.id DESC
          ) AS rn
        FROM ludy_crm.quote q
        JOIN ludy_kernel.party p ON p.org_id = q.org_id AND p.id = q.party_id
        WHERE q.org_id = ${ctx.orgId}::uuid
          AND q.party_id = ANY(${allGroupPartyIds}::uuid[])
          AND q.number IS NOT NULL
          AND q.status IN (${sql.join(MEETING_BRIEF_QUOTE_STATUSES.map((s) => sql`${s}`))})
      )
      SELECT id, kept_id, number, revision, status, total, valid_until, sent_at
      FROM ranked_quotes
      WHERE rn = 1
    `.execute(ctx.trx);

    const quoteByKept = new Map<string, MeetingFactsQuote>();
    for (const q of sentQuotesResult.rows) {
      quoteByKept.set(q.kept_id, {
        quoteId: q.id,
        label: q.revision > 1 ? `${q.number}-R${q.revision}` : q.number,
        total: money(q.total).toFixed(),
        status: q.status,
        validUntil: q.valid_until,
        expired: q.status === 'sent' && q.valid_until < today,
        sentOn: q.sent_at ? ISO_DAY.format(q.sent_at) : null,
      });
    }

    const invoicesByKept = new Map<string, PartyInvoiceSummary>();
    try {
      const invoiceRes = await ctx.query<PartyInvoiceSummaryOutput>('finance.party.invoice_summary', {
        partyIds,
      });
      if (invoiceRes.status === 'ok') {
        for (const item of invoiceRes.value.items) {
          invoicesByKept.set(item.partyId, item);
        }
      }
    } catch (err) {
      if (!(err instanceof DomainError && (err.code === SIGNAL_PARTIAL_VIEW_CODE || err.code === 'FORBIDDEN'))) {
        throw err;
      }
    }

    const contacts: MeetingFactsContact[] = [];
    for (const party of parties) {
      const partyGroup = groupRows.rows.filter((r) => r.kept_id === party.id).map((r) => r.id);
      const msgsResult = await sql<{ body: string }>`
        SELECT pg_catalog.left(m.body, ${MESSAGE_CHARS}) AS body
        FROM ludy_kernel.conversation_message m
        JOIN ludy_kernel.conversation c ON c.org_id = m.org_id AND c.id = m.conversation_id
        WHERE c.org_id = ${ctx.orgId}::uuid
          AND c.party_id = ANY(${partyGroup}::uuid[])
          AND m.direction = 'in'
          AND m.platform_removed_at IS NULL
          AND m.hidden_at IS NULL
          AND m.body <> ''
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT ${MEETING_FACTS_MESSAGES_MAX}
      `.execute(ctx.trx);

      const inv = invoicesByKept.get(party.id);
      contacts.push({
        partyId: party.id,
        contactName: party.name,
        deals: dealsByKept.get(party.id) ?? [],
        latestQuote: quoteByKept.get(party.id) ?? null,
        invoices: inv
          ? {
              openCount: inv.openCount,
              overdueAmount: inv.overdueAmount,
              lastInvoiceDate: inv.lastInvoiceDate,
              lastPaidDate: inv.lastPaidDate,
            }
          : null,
        messages: msgsResult.rows.map((r) => r.body).reverse(),
      });
    }

    return zMeetingFactsOutput.parse({
      targetKind: input.targetKind,
      targetId: input.targetId,
      wordsAllowed,
      contacts,
    });
  },
});

export const meetingFactsQueries = [crmBookingBriefTargetQuery, contactMeetingFactsQuery];
