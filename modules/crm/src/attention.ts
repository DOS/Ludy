// SPDX-License-Identifier: AGPL-3.0-only
// SG1/SG2 contact "Can chu y" (attention) list, batched signals read, and per-member "Da xem" marks (#4993, #4994, docs/plan/crm.md 10.3).
// Computed on read under the calling member's RLS (never calls AI and returns no prose text).
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import {
  CRM_ATTENTION_SIGNALS_READ,
  PARTY_ATTENTION_DAYS,
  PARTY_ATTENTION_MAX,
  SIGNALS_MAX_CRM,
  zCrmAttentionSignals,
  zPartyAttentionMarkSeen,
  zPartyAttentionQuery,
  type CrmAttentionSignal,
  type PartyAttentionItem,
  type PartyAttentionKind,
  type PartyAttentionList,
  type PartyAttentionSeen,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const EDITORS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const DAY_MS = 86_400_000;
const CONVERSATION_SCAN_MAX = 25;
const MESSAGE_SCAN_PER_CONV = 200;

type Reader = Pick<QueryContext, 'trx' | 'orgId' | 'actor'>;

function userOf(actor: QueryContext['actor'] | CommandContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
}

const toDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const iso = (value: Date | string): string => toDate(value).toISOString();

interface PartyInfo {
  id: string;
  name: string;
  email: string | null;
  duplicateOf: string | null;
  orgName: string;
}

async function requireParty(ctx: Pick<QueryContext, 'trx' | 'orgId'>, partyId: string): Promise<PartyInfo> {
  const row = await sql<{ id: string; name: string; email: string | null; duplicate_of: string | null; org_name: string }>`
    SELECT p.id, p.name, p.email, p.duplicate_of,
           (SELECT t.name FROM ludy_kernel.tenant t WHERE t.org_id = p.org_id) AS org_name
    FROM ludy_kernel.party p
    WHERE p.org_id = ${ctx.orgId}::uuid AND p.id = ${partyId}::uuid`.execute(ctx.trx);
  const party = row.rows[0];
  if (!party) throw new DomainError('PARTY_NOT_FOUND', 404, 'Không tìm thấy liên hệ hoặc công ty này');
  return {
    id: party.id,
    name: party.name,
    email: party.email,
    duplicateOf: party.duplicate_of,
    orgName: party.org_name,
  };
}

interface RawAttentionRow {
  party_id: string;
  kind: PartyAttentionKind;
  target_id: string;
  event_at: Date | string;
  deal_id: string | null;
  quote_id: string | null;
  next_step_id: string | null;
  conversation_id: string | null;
}

function candidateTailSql(partyId: string | null) {
  return partyId === null
    ? sql`
        SELECT party_id, kind, target_id, event_at, deal_id, quote_id, next_step_id, conversation_id, prev_sent_at
        FROM (
          SELECT DISTINCT ON (c.party_id)
            c.party_id, c.kind, c.target_id, c.event_at, c.deal_id, c.quote_id, c.next_step_id, c.conversation_id, c.prev_sent_at
          FROM candidates c
          ORDER BY c.party_id ASC, c.event_at DESC, c.target_id DESC
        ) d
        ORDER BY d.event_at DESC, d.party_id ASC
        LIMIT ${SIGNALS_MAX_CRM}`
    : sql`
        SELECT party_id, kind, target_id, event_at, deal_id, quote_id, next_step_id, conversation_id, prev_sent_at
        FROM candidates
        ORDER BY event_at DESC, target_id DESC
        LIMIT ${PARTY_ATTENTION_MAX}`;
}

async function loadQuoteViewed(
  ctx: Reader,
  opts: {
    userId: string | null;
    partyId: string | null;
    skipSeenFilter: boolean;
    onlyQuoteId: string | null;
  },
): Promise<RawAttentionRow[]> {
  const { rows } = await sql<RawAttentionRow>`
    WITH viewed_quotes AS (
      SELECT
        q.id AS quote_id,
        q.deal_id,
        q.party_id AS raw_party_id,
        k.id AS kept_party_id,
        GREATEST(
          COALESCE(q.first_viewed_at, MAX(ql.first_viewed_at)),
          COALESCE(MAX(ql.first_viewed_at), q.first_viewed_at)
        ) AS event_at
      FROM ludy_crm.quote q
      JOIN ludy_crm.deal d ON d.org_id = q.org_id AND d.id = q.deal_id
      JOIN ludy_kernel.party p ON p.org_id = q.org_id AND p.id = q.party_id
      JOIN ludy_kernel.party k ON k.org_id = q.org_id AND k.id = coalesce(p.duplicate_of, p.id) AND k.duplicate_of IS NULL
      LEFT JOIN ludy_crm.quote_link ql
        ON ql.org_id = q.org_id
       AND ql.quote_id = q.id
       AND ql.first_viewed_at IS NOT NULL
      WHERE q.org_id = ${ctx.orgId}::uuid
        AND (${opts.partyId}::uuid IS NULL OR q.party_id = ${opts.partyId}::uuid)
        AND q.status = 'sent'
        AND q.number IS NOT NULL
        AND d.closed_at IS NULL
        AND (${opts.onlyQuoteId}::uuid IS NULL OR q.id = ${opts.onlyQuoteId}::uuid)
        AND (q.first_viewed_at IS NOT NULL OR ql.first_viewed_at IS NOT NULL)
      GROUP BY q.id, q.deal_id, q.party_id, k.id, q.first_viewed_at
      HAVING GREATEST(
        COALESCE(q.first_viewed_at, MAX(ql.first_viewed_at)),
        COALESCE(MAX(ql.first_viewed_at), q.first_viewed_at)
      ) >= pg_catalog.now() - (${PARTY_ATTENTION_DAYS}::int * interval '1 day')
    ),
    candidates AS (
      SELECT
        coalesce(${opts.partyId}::uuid, vq.kept_party_id) AS party_id,
        'quote_viewed'::text AS kind,
        vq.quote_id AS target_id,
        vq.event_at,
        vq.deal_id,
        vq.quote_id,
        NULL::uuid AS next_step_id,
        NULL::uuid AS conversation_id,
        NULL::timestamptz AS prev_sent_at
      FROM viewed_quotes vq
      WHERE ${opts.skipSeenFilter}::boolean
         OR (
           ${opts.userId}::uuid IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM ludy_crm.party_attention_seen s
             WHERE s.org_id = ${ctx.orgId}::uuid
               AND s.user_id = ${opts.userId}::uuid
               AND s.kind = 'quote_viewed'
               AND s.target_id = vq.quote_id
               AND (
                 (${opts.partyId}::uuid IS NOT NULL AND s.party_id = ${opts.partyId}::uuid)
                 OR (${opts.partyId}::uuid IS NULL AND (s.party_id = vq.raw_party_id OR s.party_id = vq.kept_party_id))
               )
               AND pg_catalog.date_trunc('milliseconds', vq.event_at) <= pg_catalog.date_trunc('milliseconds', s.seen_event_at)
           )
         )
    )
    ${candidateTailSql(opts.partyId)}`.execute(ctx.trx);
  return rows;
}

async function loadQuoteSteps(
  ctx: Reader,
  opts: {
    userId: string | null;
    partyId: string | null;
    skipSeenFilter: boolean;
    only?: { kind: 'quote_expiring' | 'quote_unanswered'; nextStepId: string };
  },
): Promise<RawAttentionRow[]> {
  const onlyKind = opts.only?.kind ?? null;
  const onlyId = opts.only?.nextStepId ?? null;
  const { rows } = await sql<RawAttentionRow>`
    WITH candidates AS (
      SELECT
        coalesce(${opts.partyId}::uuid, k.id) AS party_id,
        n.reason AS kind,
        n.id AS target_id,
        n.raised_at AS event_at,
        n.deal_id,
        (
          SELECT q.id FROM ludy_crm.quote q
          WHERE q.org_id = d.org_id
            AND q.deal_id = d.id
            AND q.party_id = d.party_id
            AND q.status = 'sent'
            AND q.number IS NOT NULL
            AND q.valid_until >= (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          ORDER BY CASE WHEN n.reason = 'quote_expiring' THEN q.valid_until END ASC,
                   coalesce(q.sent_at, q.created_at) ASC,
                   q.id ASC
          LIMIT 1
        ) AS quote_id,
        n.id AS next_step_id,
        NULL::uuid AS conversation_id,
        NULL::timestamptz AS prev_sent_at
      FROM ludy_crm.deal_next_step n
      JOIN ludy_crm.deal d ON d.org_id = n.org_id AND d.id = n.deal_id
      JOIN ludy_kernel.party p ON p.org_id = d.org_id AND p.id = d.party_id
      JOIN ludy_kernel.party k ON k.org_id = d.org_id AND k.id = coalesce(p.duplicate_of, p.id) AND k.duplicate_of IS NULL
      WHERE n.org_id = ${ctx.orgId}::uuid
        AND (${opts.partyId}::uuid IS NULL OR d.party_id = ${opts.partyId}::uuid)
        AND d.closed_at IS NULL
        AND n.status = 'open'
        AND (n.snoozed_until IS NULL OR n.snoozed_until <= pg_catalog.now())
        AND n.reason IN ('quote_expiring', 'quote_unanswered')
        AND EXISTS (
          SELECT 1 FROM ludy_crm.quote q
          WHERE q.org_id = d.org_id
            AND q.deal_id = d.id
            AND q.party_id = d.party_id
            AND q.status = 'sent'
            AND q.number IS NOT NULL
            AND q.valid_until >= (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        )
        AND (${onlyKind}::text IS NULL OR (n.reason = ${onlyKind}::text AND n.id = ${onlyId}::uuid))
        AND (
          ${opts.skipSeenFilter}::boolean
          OR (
            ${opts.userId}::uuid IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM ludy_crm.party_attention_seen s
              WHERE s.org_id = n.org_id
                AND s.user_id = ${opts.userId}::uuid
                AND s.kind = n.reason
                AND s.target_id = n.id
                AND (
                  (${opts.partyId}::uuid IS NOT NULL AND s.party_id = ${opts.partyId}::uuid)
                  OR (${opts.partyId}::uuid IS NULL AND (s.party_id = d.party_id OR s.party_id = k.id))
                )
                AND pg_catalog.date_trunc('milliseconds', n.raised_at) <= pg_catalog.date_trunc('milliseconds', s.seen_event_at)
            )
          )
        )
    )
    ${candidateTailSql(opts.partyId)}`.execute(ctx.trx);
  return rows;
}

interface RawCustomerReplyRow extends RawAttentionRow {
  prev_sent_at: Date | string;
}

async function loadCustomerReplied(
  ctx: Reader,
  opts: {
    userId: string;
    partyId: string | null;
    keepId: string | null;
    skipSeenFilter: boolean;
    onlyConversationId: string | null;
  },
): Promise<RawCustomerReplyRow[]> {
  // Runs under ludy_kernel.conversation and ludy_kernel.conversation_message RLS so unreadable threads yield zero rows.
  // For a single contact card, cap to the 25 most recent threads; for the batched org-wide signals read (opts.partyId === null),
  // avoid capping conversations before quiet-spell and seen filtering so active chatter cannot hide qualifying replies (#4994).
  const { rows } = await sql<RawCustomerReplyRow>`
    WITH party_convs AS (
      SELECT
        c.id,
        c.channel_connection_id,
        c.kind,
        c.party_id AS raw_party_id,
        kp.id AS kept_party_id,
        coalesce(co.duplicate_of, co.id) AS company_kept_id
      FROM ludy_kernel.conversation c
      JOIN ludy_kernel.party p ON p.org_id = c.org_id AND p.id = c.party_id
      JOIN ludy_kernel.party kp ON kp.org_id = p.org_id AND kp.id = coalesce(p.duplicate_of, p.id) AND kp.duplicate_of IS NULL
      LEFT JOIN ludy_kernel.party co ON co.org_id = kp.org_id AND co.id = kp.company_id
      WHERE c.org_id = ${ctx.orgId}::uuid
        AND c.party_id IS NOT NULL
        AND c.last_inbound_at IS NOT NULL
        AND (${opts.onlyConversationId}::uuid IS NULL OR c.id = ${opts.onlyConversationId}::uuid)
        AND (
          ${opts.keepId}::uuid IS NULL
          OR kp.id = ${opts.keepId}::uuid
          OR coalesce(co.duplicate_of, co.id) = ${opts.keepId}::uuid
        )
      ${opts.partyId !== null ? sql`ORDER BY c.last_inbound_at DESC NULLS LAST, c.id DESC LIMIT ${CONVERSATION_SCAN_MAX}` : sql``}
    ),
    recent_msgs AS (
      SELECT pc.id AS conversation_id, pc.raw_party_id, pc.kept_party_id, pc.company_kept_id, m.direction, m.sent_at, m.seq, m.id
      FROM party_convs pc
      CROSS JOIN LATERAL (
        SELECT cm.direction, cm.sent_at, cm.seq, cm.id
        FROM ludy_kernel.conversation_message cm
        WHERE cm.org_id = ${ctx.orgId}::uuid
          AND cm.conversation_id = pc.id
          AND cm.channel_connection_id = pc.channel_connection_id
          AND cm.kind = pc.kind
          AND cm.platform_removed_at IS NULL
          AND cm.hidden_at IS NULL
        ORDER BY cm.sent_at DESC, cm.seq DESC, cm.id DESC
        LIMIT ${MESSAGE_SCAN_PER_CONV}
      ) m
    ),
    sequenced AS (
      SELECT
        rm.conversation_id,
        rm.raw_party_id,
        rm.kept_party_id,
        rm.company_kept_id,
        rm.direction,
        rm.sent_at,
        lag(rm.sent_at) OVER (PARTITION BY rm.conversation_id ORDER BY rm.sent_at ASC, rm.seq ASC, rm.id ASC) AS prev_sent_at
      FROM recent_msgs rm
    ),
    latest_per_conv AS (
      SELECT DISTINCT ON (sq.conversation_id)
        sq.conversation_id,
        sq.raw_party_id,
        sq.kept_party_id,
        sq.company_kept_id,
        sq.sent_at AS event_at,
        sq.prev_sent_at
      FROM sequenced sq
      WHERE sq.direction = 'in'
        AND sq.prev_sent_at IS NOT NULL
        AND sq.sent_at - sq.prev_sent_at >= (${PARTY_ATTENTION_DAYS}::int * interval '1 day')
      ORDER BY sq.conversation_id, sq.sent_at DESC
    ),
    candidates AS (
      SELECT
        coalesce(${opts.partyId}::uuid, l.kept_party_id) AS party_id,
        'customer_replied'::text AS kind,
        l.conversation_id AS target_id,
        l.event_at,
        NULL::uuid AS deal_id,
        NULL::uuid AS quote_id,
        NULL::uuid AS next_step_id,
        l.conversation_id,
        l.prev_sent_at
      FROM latest_per_conv l
      WHERE ${opts.skipSeenFilter}::boolean
         OR NOT EXISTS (
           SELECT 1 FROM ludy_crm.party_attention_seen s
           WHERE s.org_id = ${ctx.orgId}::uuid
             AND s.user_id = ${opts.userId}::uuid
             AND s.kind = 'customer_replied'
             AND s.target_id = l.conversation_id
             AND (
               (${opts.partyId}::uuid IS NOT NULL AND s.party_id = ${opts.partyId}::uuid)
               OR (
                 ${opts.partyId}::uuid IS NULL
                 AND (s.party_id = l.raw_party_id OR s.party_id = l.kept_party_id OR s.party_id = l.company_kept_id)
               )
             )
             AND pg_catalog.date_trunc('milliseconds', l.event_at) <= pg_catalog.date_trunc('milliseconds', s.seen_event_at)
         )
    )
    ${candidateTailSql(opts.partyId)}`.execute(ctx.trx);
  return rows;
}

const toAttentionItem = (partyId: string, row: RawAttentionRow): PartyAttentionItem => ({
  kind: row.kind,
  targetId: row.target_id,
  eventAt: iso(row.event_at),
  partyId,
  dealId: row.deal_id,
  quoteId: row.quote_id,
  nextStepId: row.next_step_id,
  conversationId: row.conversation_id,
});

export interface QuoteViewedForFollowup {
  quoteId: string;
  dealId: string;
  contactName: string;
  contactEmail: string | null;
  orgName: string;
  days: number;
  label: string;
  total: string;
  validUntil: string;
}

// Reads the facts for a `quote_viewed` Dy follow-up draft under the member's RLS (#4993).
export async function findQuoteViewedForFollowup(ctx: Reader, quoteId: string): Promise<QuoteViewedForFollowup> {
  const quoteRow = await sql<{
    id: string;
    deal_id: string;
    party_id: string;
    status: string;
    number: string | null;
    revision: number;
    total: string;
    valid_until: string;
    closed: boolean;
    party_name: string;
    party_email: string | null;
    org_name: string;
  }>`
    SELECT q.id, q.deal_id, q.party_id, q.status, q.number, q.revision, q.total::text AS total,
           q.valid_until::text AS valid_until, d.closed_at IS NOT NULL AS closed,
           p.name AS party_name, p.email AS party_email,
           (SELECT t.name FROM ludy_kernel.tenant t WHERE t.org_id = q.org_id) AS org_name
    FROM ludy_crm.quote q
    JOIN ludy_crm.deal d ON d.org_id = q.org_id AND d.id = q.deal_id
    JOIN ludy_kernel.party p ON p.org_id = q.org_id AND p.id = q.party_id
    WHERE q.org_id = ${ctx.orgId}::uuid AND q.id = ${quoteId}::uuid`.execute(ctx.trx);
  const q = quoteRow.rows[0];
  if (!q) throw new DomainError('QUOTE_NOT_FOUND', 404, 'Không tìm thấy báo giá này');
  if (q.status !== 'sent' || q.number === null || q.closed) {
    throw new DomainError('QUOTE_NOT_WAITING', 409, 'Báo giá này đã được trả lời hoặc đóng, không cần soạn tin nhắc nữa');
  }
  const userId = userOf(ctx.actor);
  const viewed = await loadQuoteViewed(ctx, {
    userId,
    partyId: q.party_id,
    skipSeenFilter: true,
    onlyQuoteId: q.id,
  });
  const hit = viewed[0];
  if (!hit) {
    throw new DomainError('QUOTE_NOT_VIEWED', 409, 'Báo giá này chưa có lượt mở gần đây');
  }
  const viewedAt = toDate(hit.event_at);
  const daysRow = await sql<{ days: number }>`
    SELECT greatest(
      ((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - (${viewedAt}::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date),
      0
    )::int AS days`.execute(ctx.trx);
  return {
    quoteId: q.id,
    dealId: q.deal_id,
    contactName: q.party_name,
    contactEmail: q.party_email,
    orgName: q.org_name,
    days: daysRow.rows[0]?.days ?? 0,
    label: q.revision > 1 ? `${q.number}-R${q.revision}` : q.number,
    total: q.total,
    validUntil: q.valid_until,
  };
}

export interface CustomerReplyForFollowup {
  conversationId: string;
  contactName: string;
  contactEmail: string | null;
  orgName: string;
  quietDays: number;
}

// Reads the facts for a `customer_replied` Dy follow-up draft under the member's conversation RLS (#4993).
export async function findCustomerReplyForFollowup(ctx: Reader, partyId: string, conversationId: string): Promise<CustomerReplyForFollowup> {
  const userId = userOf(ctx.actor);
  const party = await requireParty(ctx, partyId);
  const keepId = party.duplicateOf ?? party.id;
  const rows = await loadCustomerReplied(ctx, {
    userId,
    partyId: party.id,
    keepId,
    skipSeenFilter: true,
    onlyConversationId: conversationId,
  });
  const hit = rows[0];
  if (!hit) {
    throw new DomainError('CONVERSATION_NOT_FOUND', 404, 'Không tìm thấy cuộc trò chuyện này');
  }
  const quietDays = Math.max(
    PARTY_ATTENTION_DAYS,
    Math.floor((toDate(hit.event_at).getTime() - toDate(hit.prev_sent_at).getTime()) / DAY_MS),
  );
  return {
    conversationId: hit.target_id,
    contactName: party.name,
    contactEmail: party.email,
    orgName: party.orgName,
    quietDays,
  };
}

export const partyAttention = defineQuery({
  name: 'crm.party.attention',
  input: zPartyAttentionQuery,
  access: ALL,
  handler: async (ctx, input): Promise<PartyAttentionList> => {
    const userId = userOf(ctx.actor);
    const party = await requireParty(ctx, input.partyId);
    const keepId = party.duplicateOf ?? party.id;
    const [viewed, steps, replies] = await Promise.all([
      loadQuoteViewed(ctx, { userId, partyId: party.id, skipSeenFilter: false, onlyQuoteId: null }),
      loadQuoteSteps(ctx, { userId, partyId: party.id, skipSeenFilter: false }),
      loadCustomerReplied(ctx, { userId, partyId: party.id, keepId, skipSeenFilter: false, onlyConversationId: null }),
    ]);
    const combined = [...viewed, ...steps, ...replies]
      .sort((a, b) => {
        const diff = toDate(b.event_at).getTime() - toDate(a.event_at).getTime();
        if (diff !== 0) return diff;
        return b.target_id.localeCompare(a.target_id);
      })
      .slice(0, PARTY_ATTENTION_MAX)
      .map((row) => toAttentionItem(party.id, row));
    return { items: combined };
  },
});

export const crmAttentionSignals = defineQuery({
  name: CRM_ATTENTION_SIGNALS_READ,
  input: z.strictObject({}),
  access: ALL,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx): Promise<CrmAttentionSignal[]> => {
    if (ctx.actor.type !== 'user') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    }
    const isMcp = ctx.actor.mcp !== undefined;
    const userId = isMcp ? null : ctx.actor.userId;
    const skipSeenFilter = isMcp;

    // Under MCP, omit customer_replied so a grant never reads conversation activity and skip user-bound party_attention_seen.
    const [viewed, steps, replies] = await Promise.all([
      loadQuoteViewed(ctx, { userId, partyId: null, skipSeenFilter, onlyQuoteId: null }),
      loadQuoteSteps(ctx, { userId, partyId: null, skipSeenFilter }),
      isMcp
        ? Promise.resolve<RawCustomerReplyRow[]>([])
        : loadCustomerReplied(ctx, {
            userId: ctx.actor.userId,
            partyId: null,
            keepId: null,
            skipSeenFilter: false,
            onlyConversationId: null,
          }),
    ]);

    const newestByParty = new Map<string, RawAttentionRow>();
    for (const row of [...viewed, ...steps, ...replies]) {
      const prev = newestByParty.get(row.party_id);
      if (!prev) {
        newestByParty.set(row.party_id, row);
        continue;
      }
      const prevMs = toDate(prev.event_at).getTime();
      const curMs = toDate(row.event_at).getTime();
      if (curMs > prevMs || (curMs === prevMs && row.target_id < prev.target_id)) {
        newestByParty.set(row.party_id, row);
      }
    }

    const sorted = [...newestByParty.values()]
      .sort((a, b) => {
        const diff = toDate(b.event_at).getTime() - toDate(a.event_at).getTime();
        if (diff !== 0) return diff;
        return a.party_id < b.party_id ? -1 : a.party_id > b.party_id ? 1 : 0;
      })
      .slice(0, SIGNALS_MAX_CRM)
      .map((row) => ({
        partyId: row.party_id,
        kind: row.kind,
        targetId: row.target_id,
        eventAt: iso(row.event_at),
      }));

    return zCrmAttentionSignals.parse(sorted);
  },
});

export const partyAttentionSeen = defineCommand({
  name: 'crm.party.attention_seen',
  input: zPartyAttentionMarkSeen,
  risk: 'R1',
  sideEffect: 'internal',
  access: EDITORS,
  handler: async (ctx, input): Promise<PartyAttentionSeen> => {
    const userId = userOf(ctx.actor);
    const party = await requireParty(ctx, input.partyId);
    const keepId = party.duplicateOf ?? party.id;
    let match: RawAttentionRow | undefined;
    if (input.kind === 'quote_viewed') {
      match = (await loadQuoteViewed(ctx, { userId, partyId: party.id, skipSeenFilter: true, onlyQuoteId: input.targetId }))[0];
    } else if (input.kind === 'quote_expiring' || input.kind === 'quote_unanswered') {
      match = (
        await loadQuoteSteps(ctx, {
          userId,
          partyId: party.id,
          skipSeenFilter: true,
          only: { kind: input.kind, nextStepId: input.targetId },
        })
      )[0];
    } else {
      match = (
        await loadCustomerReplied(ctx, {
          userId,
          partyId: party.id,
          keepId,
          skipSeenFilter: true,
          onlyConversationId: input.targetId,
        })
      )[0];
    }
    if (!match) {
      throw new DomainError('ATTENTION_ITEM_NOT_FOUND', 404, 'Không tìm thấy mục cần chú ý này');
    }
    // Always record the server's active event timestamp so a client can neither suppress future unseen events
    // nor store a stale client timestamp that fails to dismiss an active item.
    const seenEventAt = toDate(match.event_at);
    await ctx.trx
      .insertInto('ludy_crm.party_attention_seen')
      .values({
        org_id: ctx.orgId,
        user_id: userId,
        party_id: party.id,
        kind: input.kind,
        target_id: input.targetId,
        seen_event_at: seenEventAt,
        seen_at: ctx.now,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'user_id', 'party_id', 'kind', 'target_id']).doUpdateSet({
          seen_event_at: sql`GREATEST(ludy_crm.party_attention_seen.seen_event_at, EXCLUDED.seen_event_at)`,
          seen_at: sql`CASE WHEN EXCLUDED.seen_event_at > ludy_crm.party_attention_seen.seen_event_at THEN EXCLUDED.seen_at ELSE ludy_crm.party_attention_seen.seen_at END`,
        }),
      )
      .execute();
    const seenIso = seenEventAt.toISOString();
    ctx.audit({ partyId: party.id, kind: input.kind, targetId: input.targetId, seenEventAt: seenIso });
    return {
      partyId: party.id,
      kind: input.kind,
      targetId: input.targetId,
      seenEventAt: seenIso,
    };
  },
});

export const attentionQueries = [partyAttention, crmAttentionSignals];
export const attentionCommands = [partyAttentionSeen];
