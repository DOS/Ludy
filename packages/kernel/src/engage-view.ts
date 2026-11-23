// SPDX-License-Identifier: AGPL-3.0-only
// What the Inbox card of an AI coworker's Engage proposal shows (E4 #3863): the fields of the stored payload as plain text, never as markup. The payload is what an outside AI app sent (tainted), and the approval
// sends exactly what was stored, so the card shows exactly that: a control character, a bidirectional embedding, override or isolate or a zero-width mark is NOT dropped (the customer would then read something
// other than what the approver read) but written out as a visible marker, <U+202E>. Each value is cut to a bounded length.
import { sql, type Transaction } from 'kysely';
import { isEngageProposalKind, markHiddenText, type EngageProposalView } from '@ludy/kernel-contract';
import type { Database } from '@ludy/db';

const MAX_FIELDS = 40;
const VALUE_MAX = 8000;
const LONG_FROM = 80;
// What the card writes out as a visible marker is the one class of the contract (markHiddenText in packages/kernel-contract/src/invisible-chars.ts): controls other than a newline and a tab, the soft hyphen, the Arabic letter
// mark, the Hangul fillers, the direction marks, embeddings, overrides and isolates, the zero-width and invisible marks, the braille blank, line and paragraph separators, annotation marks and tag characters; the same
// set the database's title filter (20270119150000) refuses and the screens use for an AI-written task title (#4423).
const textOf = (value: unknown): string => {
  const raw = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return markHiddenText(raw.slice(0, VALUE_MAX)).slice(0, VALUE_MAX);
};

export function engageViewOf(kind: string, command: string, payload: unknown, about: EngageProposalView['about'] = []): EngageProposalView | null {
  if (!isEngageProposalKind(kind) || typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const fields = Object.entries(payload as Record<string, unknown>)
    .filter(([key]) => /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(key))
    .slice(0, MAX_FIELDS)
    .map(([key, value]) => {
      const text = textOf(value);
      return { key, value: text, long: text.length > LONG_FROM || text.includes('\n') };
    });
  return { command, fields, about };
}

const isId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

type About = EngageProposalView['about'];
const idOf = (value: unknown): string | null => (isId(value) ? value.toLowerCase() : null);
const MAX_VARIANT_IDS = 20;
const CHANNELS_MAX = 6;
// A value missing in the database is left out of the card, never shown as an empty line.
const push = (out: About, label: About[number]['label'], value: string | null | undefined, max = 200): void => {
  if (value !== null && value !== undefined && value !== '') out.push({ label, value: textOf(value).slice(0, max) });
};
// An instant as an ISO string in UTC: the card writes it in the reader's own clock beside it.
const ISO_UTC = `YYYY-MM-DD"T"HH24:MI:SS"Z"`;

// Who and what an ask is about, from the records themselves, so an approver reads names, times, numbers and states and not ids. Read as the approver (an owner or an admin, who reads every record the ask
// names); text is shown as the card shows any text (marked, bounded). An id the database does not know, or a command with nothing to show, leaves the list empty; it never throws.
export async function engageAboutOf(trx: Transaction<Database>, orgId: string, command: string, payload: unknown): Promise<About> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
  const p = payload as Record<string, unknown>;
  switch (command) {
    case 'kernel.conversation.reply_approved':
    case 'kernel.conversation.reply_privately_approved':
    case 'kernel.conversation.hide_approved':
      return conversationAbout(trx, orgId, p);
    case 'kernel.conversation.follow_up_approved':
      return followUpAbout(trx, orgId, p);
    case 'crm.booking.move_approved':
    case 'crm.booking.cancel_approved':
      return bookingAbout(trx, orgId, p);
    case 'crm.quote.send_approved':
      return quoteAbout(trx, orgId, p);
    case 'social.post.submit_approved':
    case 'social.variant.schedule_approved':
      return postAbout(trx, orgId, p);
    case 'ads.launch.stop_approved':
    case 'ads.object.pause_approved':
    case 'ads.object.archive_approved':
    case 'ads.budget.lower_approved':
    case 'ads.schedule.shorten_approved':
      return launchAbout(trx, orgId, command, p);
    case 'ads.manage.cancel_approved':
      return changeAbout(trx, orgId, p);
    default:
      return [];
  }
}

// The thread itself: the channel, the customer's name and what the customer last wrote (or, for hiding, the comment itself).
async function conversationAbout(trx: Transaction<Database>, orgId: string, p: Record<string, unknown>): Promise<About> {
  const messageId = idOf(p.messageId);
  const conversationId = idOf(p.conversationId);
  if (!messageId && !conversationId) return [];
  const { rows } = await sql<{ channel: string | null; provider: string | null; contact: string | null; said: string | null }>`
    SELECT cc.display_name AS channel, cc.provider AS provider, i.display_name AS contact,
           CASE WHEN ${messageId}::uuid IS NOT NULL THEN m.body ELSE (
             SELECT lm.body FROM ludy_kernel.conversation_message lm
             WHERE lm.org_id = c.org_id AND lm.conversation_id = c.id AND lm.direction = 'in' AND lm.platform_removed_at IS NULL
             ORDER BY lm.seq DESC LIMIT 1) END AS said
    FROM ludy_kernel.conversation c
    LEFT JOIN ludy_kernel.conversation_message m ON m.org_id = c.org_id AND m.id = ${messageId}::uuid
    LEFT JOIN ludy_kernel.channel_connection cc ON cc.org_id = c.org_id AND cc.id = c.channel_connection_id
    LEFT JOIN ludy_kernel.conversation_identity i ON i.org_id = c.org_id AND i.id = c.identity_id
    WHERE c.org_id = ${orgId}::uuid AND c.id = COALESCE(${conversationId}::uuid, m.conversation_id)
    LIMIT 1`.execute(trx);
  const row = rows[0];
  if (!row) return [];
  const out: About = [];
  if (row.channel || row.provider) push(out, 'channel', [row.provider, row.channel].filter(Boolean).join(': '));
  push(out, 'contact', row.contact);
  push(out, 'customerMessage', row.said, 600);
  return out;
}

// A follow-up task: the thread it links to (as above) and the title of the seat that would get the task (none named: the owner at the root of the chart gets it, which the card says by showing no seat).
async function followUpAbout(trx: Transaction<Database>, orgId: string, p: Record<string, unknown>): Promise<About> {
  const out = await conversationAbout(trx, orgId, p);
  const positionId = idOf(p.assigneePositionId);
  if (!positionId) return out;
  const { rows } = await sql<{ title: string | null; status: string | null }>`
    SELECT po.title AS title, po.status AS status FROM ludy_kernel.position po WHERE po.org_id = ${orgId}::uuid AND po.id = ${positionId}::uuid LIMIT 1`.execute(trx);
  push(out, 'assignee', rows[0]?.title);
  // A seat that is not active is said on the card (approving would fail closed with POSITION_ARCHIVED for an archived one, #4370): the state is one of the seat's own enum words, never a person's text.
  if (rows[0]?.status === 'archived' || rows[0]?.status === 'paused') push(out, 'assigneeState', rows[0].status);
  return out;
}

// The guest, the kind of meeting and the time it holds now (the new time the AI proposes is the payload's `startsAt`, shown beside it).
async function bookingAbout(trx: Transaction<Database>, orgId: string, p: Record<string, unknown>): Promise<About> {
  const bookingId = idOf(p.bookingId);
  if (!bookingId) return [];
  const { rows } = await sql<{ guest: string | null; email: string | null; title: string | null; starts: string | null }>`
    SELECT b.visitor_name AS guest, b.email AS email, t.title AS title, to_char(b.starts_at AT TIME ZONE 'UTC', ${ISO_UTC}) AS starts
    FROM ludy_crm.booking b
    LEFT JOIN ludy_crm.event_type t ON t.org_id = b.org_id AND t.id = b.event_type_id
    WHERE b.org_id = ${orgId}::uuid AND b.id = ${bookingId}::uuid
    LIMIT 1`.execute(trx);
  const row = rows[0];
  if (!row) return [];
  const out: About = [];
  push(out, 'guest', row.guest);
  push(out, 'guestEmail', row.email);
  push(out, 'eventType', row.title);
  push(out, 'bookingTime', row.starts);
  return out;
}

// The quote and its customer, with the customer's own email beside the address the AI proposes to send it to, so a different one is seen.
async function quoteAbout(trx: Transaction<Database>, orgId: string, p: Record<string, unknown>): Promise<About> {
  const quoteId = idOf(p.quoteId);
  if (!quoteId) return [];
  const { rows } = await sql<{ number: string | null; status: string | null; total: string | null; party: string | null; email: string | null }>`
    SELECT q.number AS number, q.status AS status, q.total::text AS total, pa.name AS party, pa.email AS email
    FROM ludy_crm.quote q
    LEFT JOIN ludy_kernel.party pa ON pa.org_id = q.org_id AND pa.id = q.party_id
    WHERE q.org_id = ${orgId}::uuid AND q.id = ${quoteId}::uuid
    LIMIT 1`.execute(trx);
  const row = rows[0];
  if (!row) return [];
  const out: About = [];
  push(out, 'quote', row.number);
  push(out, 'quoteStatus', row.status);
  push(out, 'quoteTotal', row.total);
  push(out, 'party', row.party);
  push(out, 'partyEmail', row.email);
  return out;
}

// The post (its title, or the start of its text) and the channels of the variants the ask names (all of the post's when it names none).
async function postAbout(trx: Transaction<Database>, orgId: string, p: Record<string, unknown>): Promise<About> {
  const postId = idOf(p.postId);
  if (!postId) return [];
  const named = Array.isArray(p.variantIds) ? p.variantIds.slice(0, MAX_VARIANT_IDS).map(idOf).filter((v): v is string => v !== null) : [];
  const variantIds = Array.isArray(p.variantIds) ? named : null;
  const { rows: posts } = await sql<{ shown: string | null }>`
    SELECT COALESCE(NULLIF(pg_catalog.btrim(p.title), ''), NULLIF(pg_catalog.left(p.body, 120), '')) AS shown
    FROM ludy_social.post p
    WHERE p.org_id = ${orgId}::uuid AND p.id = ${postId}::uuid
    LIMIT 1`.execute(trx);
  const post = posts[0];
  if (!post) return [];
  const { rows: channels } = await sql<{ name: string | null }>`
    SELECT COALESCE(cc.display_name, v.provider) AS name
    FROM ludy_social.post_variant v
    LEFT JOIN ludy_kernel.channel_connection cc ON cc.org_id = v.org_id AND cc.id = v.channel_connection_id
    WHERE v.org_id = ${orgId}::uuid AND v.post_id = ${postId}::uuid AND (${variantIds}::uuid[] IS NULL OR v.id = ANY(${variantIds}::uuid[]))
    ORDER BY v.position, v.id
    LIMIT ${CHANNELS_MAX}`.execute(trx);
  const out: About = [];
  push(out, 'post', post.shown);
  push(out, 'channels', channels.map((c) => textOf(c.name ?? '').slice(0, 100)).filter(Boolean).join(', '), 700);
  return out;
}

// The queued change the ask would cancel: the launch it is on (as below) and the change's kind, its state and what it would set (a budget with its currency, a last day, or the object it would start again).
async function changeAbout(trx: Transaction<Database>, orgId: string, p: Record<string, unknown>): Promise<About> {
  const changeId = idOf(p.changeId);
  if (!changeId) return [];
  const { rows } = await sql<{ launch_id: string; kind: string; state: string; slot: string; budget: string | null; ends: string | null; currency: string | null }>`
    SELECT c.launch_id AS launch_id, c.kind AS kind, c.state AS state, c.slot AS slot, c.to_budget::text AS budget, c.to_end_on::text AS ends, l.currency AS currency
    FROM ludy_ads.ad_manage_change c
    LEFT JOIN ludy_ads.ad_launch l ON l.org_id = c.org_id AND l.id = c.launch_id
    WHERE c.org_id = ${orgId}::uuid AND c.id = ${changeId}::uuid
    LIMIT 1`.execute(trx);
  const row = rows[0];
  if (!row) return [];
  const out = await launchAbout(trx, orgId, 'ads.manage.cancel_approved', { launchId: row.launch_id });
  push(out, 'changeKind', row.kind);
  push(out, 'changeState', row.state);
  push(out, 'changeTo', row.budget ? [row.budget, row.currency].filter(Boolean).join(' ') : (row.ends ?? row.slot));
  return out;
}

// The launch the ask changes: the campaign's (plan's) name, its ad account, its state, the daily budget it holds (a decimal string and its currency) and, for a shorter flight, the day it ends now.
async function launchAbout(trx: Transaction<Database>, orgId: string, command: string, p: Record<string, unknown>): Promise<About> {
  const launchId = idOf(p.launchId);
  if (!launchId) return [];
  const { rows } = await sql<{ name: string | null; account: string | null; state: string | null; budget: string | null; currency: string | null; ends: string | null }>`
    SELECT d.name AS name, a.name AS account, l.state AS state, l.daily_budget::text AS budget, l.currency AS currency, l.end_on::text AS ends
    FROM ludy_ads.ad_launch l
    LEFT JOIN ludy_ads.ad_campaign_draft d ON d.org_id = l.org_id AND d.id = l.draft_id
    LEFT JOIN ludy_ads.ad_account a ON a.org_id = l.org_id AND a.id = l.ad_account_id
    WHERE l.org_id = ${orgId}::uuid AND l.id = ${launchId}::uuid
    LIMIT 1`.execute(trx);
  const row = rows[0];
  if (!row) return [];
  const out: About = [];
  push(out, 'launch', row.name);
  push(out, 'adAccount', row.account);
  push(out, 'launchState', row.state);
  if (row.budget) push(out, 'launchBudget', [row.budget, row.currency].filter(Boolean).join(' '));
  if (command === 'ads.schedule.shorten_approved') push(out, 'launchEnds', row.ends);
  return out;
}
