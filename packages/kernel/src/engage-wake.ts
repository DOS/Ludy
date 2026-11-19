// SPDX-License-Identifier: AGPL-3.0-only
// The inbox's side of Engage's wake rules (#3862, E3 of epic #3857; contract in packages/kernel-contract/src/engage-wake.ts). Three small pieces, none calls a model:
//   - kernel.conversation.wake_rules / wake_rules_set: the org's N (hours a customer waits before a thread counts as unanswered, hours before a reply window closes, days a quote waits), set in Settings;
//   - kernel.wake.conversations: the one read the wake sweep runs as an AI coworker's grant (in its sealed context) and Home runs as the member. It answers, for the four conversation rules, the ids of the threads
//     and an instant each, and nothing else: never a message, a name, a subject or a link. Who reads which thread is the inbox's own rule (row-level security on the thread and its messages), so a member's Home
//     lists only what they could open, and a grant's context lists what it may read (a company grant: every thread);
//   - kernel.wake.today: Home's lines for the rules, so the rules show with no agent connected. A viewer cannot answer, so reads none; a member sees the threads waiting for them (unassigned, or assigned to them),
//     as the inbox's own "Hôm nay cần bạn" item does.
// "Unanswered" is the inbox's own state (see conversation-signals.ts): status `new`, and the wait counts from the oldest customer message after the last message of the org's. The instant is when Ludy stored the
// message, never the sender's clock. A message the customer removed or the org hid does not wait.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  ENGAGE_WAKE_DEFAULTS,
  ENGAGE_WAKE_LOOKBACK_DAYS,
  ENGAGE_WAKE_FRESH_HOURS,
  ENGAGE_WAKE_ROWS_MAX,
  zEngageWakeConversations,
  zEngageWakeConversationsInput,
  zEngageWakeRulesSet,
  zTodayItems,
  type EngageWakeConversations,
  type EngageWakeRulesView,
  type TodayItem,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const ADMINS: readonly MemberRole[] = ['owner', 'admin'];
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Threads one look reads (the status `new` threads of the org, the most recent wait first): a longer inbox is a person's to clear.
const THREADS_MAX = 500;

// ---------------------------------------------------------------------------------------------------------------------
// The org's N
// ---------------------------------------------------------------------------------------------------------------------

export async function wakeRulesOf(ctx: Pick<QueryContext, 'trx' | 'orgId'>): Promise<EngageWakeRulesView> {
  const row = await ctx.trx
    .selectFrom('crove_kernel.conversation_setting')
    .select(['wake_unanswered_hours', 'wake_reply_window_hours', 'wake_quote_days'])
    .where('org_id', '=', ctx.orgId)
    .executeTakeFirst();
  if (!row) return { ...ENGAGE_WAKE_DEFAULTS, isDefault: true };
  const view = { unansweredHours: row.wake_unanswered_hours, replyWindowHours: row.wake_reply_window_hours, quoteDays: row.wake_quote_days };
  const same = view.unansweredHours === ENGAGE_WAKE_DEFAULTS.unansweredHours && view.replyWindowHours === ENGAGE_WAKE_DEFAULTS.replyWindowHours && view.quoteDays === ENGAGE_WAKE_DEFAULTS.quoteDays;
  return { ...view, isDefault: same };
}

export const conversationWakeRules = defineQuery({
  name: 'kernel.conversation.wake_rules',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<EngageWakeRulesView> => wakeRulesOf(ctx),
});

// Owners and admins set the three N. They only move the lines at which a coworker is called in and Home shows a rule, so the command is R1; the row is the one the retention and the auto draft live in.
export const conversationWakeRulesSet = defineCommand({
  name: 'kernel.conversation.wake_rules_set',
  input: zEngageWakeRulesSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: ADMINS,
  handler: async (ctx, input): Promise<EngageWakeRulesView> => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const me = ctx.actor.userId;
    const values = { wake_unanswered_hours: input.unansweredHours, wake_reply_window_hours: input.replyWindowHours, wake_quote_days: input.quoteDays };
    await ctx.trx
      .insertInto('crove_kernel.conversation_setting')
      .values({ org_id: ctx.orgId, ...values, set_by: me })
      .onConflict((oc) => oc.column('org_id').doUpdateSet({ ...values, set_by: me, updated_at: ctx.now }))
      .execute();
    ctx.audit({ unansweredHours: input.unansweredHours, replyWindowHours: input.replyWindowHours, quoteDays: input.quoteDays });
    return wakeRulesOf(ctx);
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// The conversation rules
// ---------------------------------------------------------------------------------------------------------------------

interface ThreadRow {
  id: string;
  kind: 'direct' | 'email' | 'comment_thread';
  external_post_id: string | null;
  reply_window_until: Date | null;
  since: Date | null;
  answered_before: boolean;
}

export const wakeConversations = defineQuery({
  name: 'kernel.wake.conversations',
  input: zEngageWakeConversationsInput,
  access: ALL,
  // Read by the wake sweep as a company grant's own sealed context (the database says which threads it may read), and by Home as the member.
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<EngageWakeConversations> => {
    const empty: EngageWakeConversations = { newInbound: [], unanswered: [], replyWindow: [], comments: [] };
    // A person's own session, or a grant's sealed context: nothing else (no agent, no system).
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const grant = ctx.actor.mcp !== undefined;
    // A company grant's alone (the wake-up of a member-bound grant is for signals of its member, never a line's event): the sealed member context would give only what its member may read, but the rules are
    // the org's, so a member-bound grant is refused rather than given a share the rule was not written for.
    if (ctx.actor.mcp?.kind === 'member') throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP của công ty mới dùng được truy vấn này');
    if (!grant && ctx.role === 'viewer') return empty;
    const me = grant ? null : ctx.actor.userId;
    const now = input.now ? new Date(input.now) : new Date();
    const lookback = new Date(now.getTime() - ENGAGE_WAKE_LOOKBACK_DAYS * DAY_MS);
    const windowEnd = new Date(now.getTime() + input.replyWindowHours * HOUR_MS);
    const { rows } = await sql<ThreadRow>`
      SELECT c.id, c.kind, c.external_post_id, c.reply_window_until, w.since,
             EXISTS (SELECT 1 FROM crove_kernel.conversation_message o WHERE o.org_id = c.org_id AND o.conversation_id = c.id AND o.direction = 'out') AS answered_before
      FROM crove_kernel.conversation c
      CROSS JOIN LATERAL (
        SELECT pg_catalog.min(m.received_at) AS since
        FROM crove_kernel.conversation_message m
        WHERE m.org_id = c.org_id AND m.conversation_id = c.id AND m.direction = 'in'
          AND m.platform_removed_at IS NULL AND m.hidden_at IS NULL
          AND m.seq > COALESCE((SELECT pg_catalog.max(o.seq) FROM crove_kernel.conversation_message o
                                WHERE o.org_id = c.org_id AND o.conversation_id = c.id AND o.direction = 'out'), 0)
      ) w
      WHERE c.org_id = ${ctx.orgId}::uuid AND c.status = 'new' AND w.since IS NOT NULL
        -- Cheap cut before the lateral look at messages is paid for: a wait that began after the lookback means the last customer message is after it too (a day of slack for the platform's clock).
        AND (c.last_inbound_at IS NULL OR c.last_inbound_at >= ${new Date(lookback.getTime() - DAY_MS)}::timestamptz)
        AND w.since >= ${lookback}::timestamptz
        ${me === null ? sql`` : sql`AND (c.assignee_user_id IS NULL OR c.assignee_user_id = ${me}::uuid)`}
      ORDER BY w.since DESC, c.id
      LIMIT ${THREADS_MAX}`.execute(ctx.trx);

    // The reply windows are chosen on their own, soonest first, before any list is cut: a thread with a few minutes left is never hidden behind a longer inbox.
    const closing = await sql<{ id: string; reply_window_until: Date }>`
      SELECT c.id, c.reply_window_until
      FROM crove_kernel.conversation c
      WHERE c.org_id = ${ctx.orgId}::uuid AND c.status = 'new' AND c.reply_window_until > ${now}::timestamptz AND c.reply_window_until <= ${windowEnd}::timestamptz
        AND EXISTS (SELECT 1 FROM crove_kernel.conversation_message m WHERE m.org_id = c.org_id AND m.conversation_id = c.id AND m.direction = 'in' AND m.platform_removed_at IS NULL AND m.hidden_at IS NULL
                    AND m.seq > COALESCE((SELECT pg_catalog.max(o.seq) FROM crove_kernel.conversation_message o WHERE o.org_id = c.org_id AND o.conversation_id = c.id AND o.direction = 'out'), 0))
        ${me === null ? sql`` : sql`AND (c.assignee_user_id IS NULL OR c.assignee_user_id = ${me}::uuid)`}
      ORDER BY c.reply_window_until, c.id
      LIMIT ${ENGAGE_WAKE_ROWS_MAX}`.execute(ctx.trx);

    const freshFrom = new Date(now.getTime() - ENGAGE_WAKE_FRESH_HOURS * HOUR_MS).getTime();
    const waitedUntil = now.getTime() - input.unansweredHours * HOUR_MS;
    const out: EngageWakeConversations = { newInbound: [], unanswered: [], replyWindow: [], comments: [] };
    const push = <T>(list: T[], row: T) => {
      if (list.length < ENGAGE_WAKE_ROWS_MAX) list.push(row);
    };
    for (const r of rows) {
      const since = r.since as Date;
      const direct = r.kind === 'direct' || r.kind === 'email';
      // A first message nobody has answered yet, in the last day.
      if (direct && !r.answered_before && since.getTime() >= freshFrom) push(out.newInbound, { id: r.id, kind: r.kind, since: since.toISOString() });
      // A customer who waited past N hours (less than the lookback: the query already cut older ones).
      if (direct && since.getTime() <= waitedUntil && since >= lookback) push(out.unanswered, { id: r.id, kind: r.kind, since: since.toISOString() });
      // A comment under a published post nobody has answered, in the last day.
      if (r.kind === 'comment_thread' && r.external_post_id !== null && since.getTime() >= freshFrom) push(out.comments, { id: r.id, since: since.toISOString() });
    }
    out.replyWindow = closing.rows.map((r) => ({ id: r.id, closesAt: r.reply_window_until.toISOString() }));
    // The answer is held to the contract before it leaves: ids, a kind and instants, and nothing else.
    return zEngageWakeConversations.parse(out);
  },
});

// ---------------------------------------------------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------------------------------------------------

const INBOX = '/social/inbox?status=new';

// The rules as Home lines (message keys with numbers, a path inside the org; no text). Quotes, bookings and the ad flags show on Home through the CRM's and Ads' own reads (crm.today, ads.today), which use the same
// rules; a new inbound conversation is in the inbox's own "waiting for you" item (kernel.conversation.today).
export const wakeToday = defineQuery({
  name: 'kernel.wake.today',
  input: z.strictObject({}),
  access: ALL,
  handler: async (ctx): Promise<TodayItem[]> => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp || ctx.role === 'viewer') return [];
    const rules = await wakeRulesOf(ctx);
    const answer = await ctx.query<EngageWakeConversations>('kernel.wake.conversations', { unansweredHours: rules.unansweredHours, replyWindowHours: rules.replyWindowHours });
    if (answer.status !== 'ok') return [];
    const read = zEngageWakeConversations.safeParse(answer.value);
    if (!read.success) return [];
    const items: TodayItem[] = [];
    if (read.data.unanswered.length > 0) {
      items.push({ kind: 'message', app: 'conversations', id: 'wake:unanswered', title: { key: 'wake.unanswered', params: { count: read.data.unanswered.length, hours: rules.unansweredHours } }, count: read.data.unanswered.length, severity: 'warn', href: INBOX });
    }
    const closing = read.data.replyWindow;
    if (closing.length > 0) {
      items.push({
        kind: 'deadline',
        app: 'conversations',
        id: 'wake:reply-window',
        title: { key: 'wake.replyWindow', params: { count: closing.length, hours: rules.replyWindowHours } },
        count: closing.length,
        dueAt: (closing[0] as { closesAt: string }).closesAt,
        href: INBOX,
      });
    }
    if (read.data.comments.length > 0) {
      items.push({ kind: 'message', app: 'social', id: 'wake:comments', title: { key: 'wake.postComments', params: { count: read.data.comments.length } }, count: read.data.comments.length, href: INBOX });
    }
    return zTodayItems.parse(items);
  },
});

export const engageWakeCommands = [conversationWakeRulesSet];
export const engageWakeQueries = [conversationWakeRules, wakeConversations, wakeToday];
