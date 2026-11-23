// SPDX-License-Identifier: AGPL-3.0-only
// Browser push for every notification of the kernel and the modules (#3736; Social's own push, #1238, was the first): a member turns push on one browser
// at a time from the notification settings (kernel.push.subscribe, with the endpoint and keys the browser's push service gave it) and off again
// (kernel.push.unsubscribe). The subscriptions are ludy_kernel.push_subscription, one per member and browser, shared by every app: each member reads and changes only their
// own rows (a restrictive policy), and a member's rows go with the membership.
//
// Sending is the worker's. A notice written with notifyMembers() of a pushed kind (PUSH_KINDS below) is pushed as follows: after the job that wrote it ran (the notify
// queue), the worker asks kernel.push.pending for the notifications that job wrote (by the outbox event they name), queues one kernel-push job for each, reads it with
// kernel.push.targets (system), encrypts and posts it to each of the member's devices itself, and records the answers with kernel.push.record (system): a 404 or 410 deletes the
// subscription, other failures count up and a subscription that failed PUSH_FAILURE_LIMIT times in a row is deleted too.
//
// The one switch: a member who turned a kind off gets no notification row (notifyMembers drops them), so there is nothing to push; the targets check the mute again, so a kind turned off after the
// row was written pushes nothing either. The push carries no text of the subject: a fixed short line naming the kind and the app path that opens it. A deployment without VAPID keys offers no
// push and the worker queues nothing (the API and the worker check the keys; these commands do not).
import { createPublicKey } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { SUMMARY_READY_KIND, zId } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
// The devices one member keeps per org; subscribing one more drops the one used longest ago.
export const PUSH_DEVICE_LIMIT = 10;
// Failed sends in a row (not 404 or 410) after which a subscription is deleted.
export const PUSH_FAILURE_LIMIT = 10;
export const PUSH_ENDPOINT_MAX = 2048;
// A push for a notification older than this is dropped: the push service keeps a message a day at most, and a replayed event must not push an old notice again.
export const PUSH_MAX_AGE_HOURS = 24;
// The notifications one pending read hands the worker at most (one notify event writes a few).
export const PUSH_PENDING_LIMIT = 200;

const B64URL = /^[A-Za-z0-9_-]+$/;
// An endpoint as stored and compared: the URL parser's form, so the browser's spelling and the row's always match.
const normalEndpoint = (raw: string) => (URL.canParse(raw) ? new URL(raw).toString() : raw);
// The browser's keys as base64url without padding; some browsers pad or use the standard alphabet.
const toBase64Url = (value: string) => value.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const keyOf = (bytes: number, check?: (raw: Buffer) => boolean) =>
  z
    .string()
    .min(1)
    .max(128)
    .transform(toBase64Url)
    .refine((v) => B64URL.test(v) && Buffer.from(v, 'base64url').length === bytes && (check?.(Buffer.from(v, 'base64url')) ?? true), 'invalid key');
// Whether 65 bytes are an uncompressed point on P-256: the key import checks the point is on the curve.
function onP256(raw: Buffer): boolean {
  if (raw[0] !== 0x04) return false;
  try {
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}
// An uncompressed P-256 point (0x04 || x || y) and the 16-byte auth secret (RFC 8291 section 3).
export const zPushP256dh = keyOf(65, onP256);
export const zPushAuth = keyOf(16);
// A push service URL: https, no credentials or fragment. Where it may go (public addresses only) is the egress guard's.
export const zPushEndpoint = z
  .string()
  .min(12)
  .max(PUSH_ENDPOINT_MAX)
  .refine((raw) => {
    if (!URL.canParse(raw)) return false;
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '';
  }, 'invalid push endpoint')
  .transform(normalEndpoint)
  .refine((v) => v.length <= PUSH_ENDPOINT_MAX, 'invalid push endpoint');
// The device label the settings page shows, built by the browser from its user agent ("Chrome trên Windows").
const zDeviceLabel = z
  .string()
  .transform((v) => [...v.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 100).join(''))
  .optional();

function requireUser(ctx: Pick<QueryContext, 'actor'>): string {
  if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return ctx.actor.userId;
}

// The kernel's notification kinds that also go out as browser push, each with its one fixed line and the app path it opens (never text of the subject). A kind is added here
// with its line and path; its notice must be written by a job of the notify queue (the dispatch of an outbox event), which is where the worker looks for what to push.
export interface PushKind {
  line: string;
  path(slug: string, subject: { type: string | null; id: string | null }): string;
}
export const PUSH_KINDS: ReadonlyMap<string, PushKind> = new Map<string, PushKind>([
  // The minutes draft of a meeting the recorder ran is ready (#3730): opens the meeting.
  [SUMMARY_READY_KIND, { line: 'Bản nháp biên bản đã sẵn sàng để bạn xem', path: (slug, s) => (s.type === 'meetings.meeting' && s.id ? `/o/${slug}/meetings/${s.id}` : `/o/${slug}/meetings`) }],
]);

export interface PushDevice {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  // The browser asking: its endpoint is this row's.
  current: boolean;
}

// The viewer's push devices in this org, and whether the asking browser (its endpoint, when it has a subscription) is one of them. Never an endpoint or a key.
export const pushDevices = defineQuery({
  name: 'kernel.push.devices',
  input: z.strictObject({ endpoint: z.string().max(PUSH_ENDPOINT_MAX).nullable() }),
  access: ALL,
  handler: async (ctx, input): Promise<{ devices: PushDevice[]; subscribed: boolean }> => {
    const me = requireUser(ctx);
    const mine = input.endpoint === null ? null : normalEndpoint(input.endpoint);
    const rows = await ctx.trx
      .selectFrom('ludy_kernel.push_subscription')
      .select(['id', 'user_agent', 'created_at', 'last_used_at', 'endpoint'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', me)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    const devices = rows.map((r) => ({ id: r.id, label: r.user_agent, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null, current: mine !== null && r.endpoint === mine }));
    return { devices, subscribed: devices.some((d) => d.current) };
  },
});

// Turns push on for the asking browser: its subscription becomes the viewer's row (the same endpoint again refreshes its keys and label and clears its failures). Beyond PUSH_DEVICE_LIMIT the device
// used longest ago goes.
export const pushSubscribe = defineCommand({
  name: 'kernel.push.subscribe',
  input: z.strictObject({ endpoint: zPushEndpoint, p256dh: zPushP256dh, auth: zPushAuth, label: zDeviceLabel }),
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input): Promise<{ id: string }> => {
    const me = requireUser(ctx);
    const label = input.label || null;
    const row = await ctx.trx
      .insertInto('ludy_kernel.push_subscription')
      .values({ org_id: ctx.orgId, user_id: me, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, user_agent: label, created_at: ctx.now })
      .onConflict((oc) => oc.columns(['org_id', 'user_id', 'endpoint']).doUpdateSet({ p256dh: input.p256dh, auth: input.auth, user_agent: label, failure_count: 0 }))
      .returning('id')
      .executeTakeFirstOrThrow();
    await sql`
      DELETE FROM ludy_kernel.push_subscription
      WHERE org_id = ${ctx.orgId} AND user_id = ${me} AND id IN (
        SELECT id FROM ludy_kernel.push_subscription
        WHERE org_id = ${ctx.orgId} AND user_id = ${me} AND id <> ${row.id}
        ORDER BY coalesce(last_used_at, created_at) DESC, id DESC
        OFFSET ${PUSH_DEVICE_LIMIT - 1})`.execute(ctx.trx);
    ctx.audit({ subscription_id: row.id });
    return { id: row.id };
  },
});

// Turns push off: the asking browser's subscription (by its endpoint), or one of the viewer's devices by id.
export const pushUnsubscribe = defineCommand({
  name: 'kernel.push.unsubscribe',
  input: z.union([z.strictObject({ endpoint: z.string().min(1).max(PUSH_ENDPOINT_MAX) }), z.strictObject({ id: zId })]),
  risk: 'R1',
  sideEffect: 'internal',
  access: ALL,
  handler: async (ctx, input): Promise<{ removed: number }> => {
    const me = requireUser(ctx);
    let q = ctx.trx.deleteFrom('ludy_kernel.push_subscription').where('org_id', '=', ctx.orgId).where('user_id', '=', me);
    q = 'id' in input ? q.where('id', '=', input.id) : q.where('endpoint', '=', normalEndpoint(input.endpoint));
    const done = await q.executeTakeFirst();
    return { removed: Number(done.numDeletedRows) };
  },
});

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface PushTargets {
  subscriptions: PushTarget[];
  // What the push shows: the kind's line, the app path it opens, and a tag that folds repeats of one thing together.
  line: string;
  path: string;
  tag: string;
}

// A member's subscriptions for a job to post to, oldest first, at most PUSH_DEVICE_LIMIT: the shared read of the kernel's and Social's targets (system context).
export async function pushSubscriptionsOf(ctx: Pick<QueryContext, 'trx' | 'orgId'>, userId: string): Promise<PushTarget[]> {
  return ctx.trx
    .selectFrom('ludy_kernel.push_subscription')
    .select(['id', 'endpoint', 'p256dh', 'auth'])
    .where('org_id', '=', ctx.orgId)
    .where('user_id', '=', userId)
    .orderBy('id')
    .limit(PUSH_DEVICE_LIMIT)
    .execute();
}

// Whether a member still gets a push for this org: the org is active, and they are a member now with an account that is not disabled (member_emails leaves those out). Returns the org's slug, else null.
export async function pushOrgSlug(ctx: Pick<QueryContext, 'trx' | 'orgId'>, userId: string): Promise<string | null> {
  const org = await ctx.trx.selectFrom('ludy_kernel.tenant').select(['slug', 'status']).where('org_id', '=', ctx.orgId).executeTakeFirst();
  if (org?.status !== 'active') return null;
  const { rows: active } = await sql<{ user_id: string }>`SELECT user_id FROM ludy_kernel.member_emails(${[userId]}::uuid[])`.execute(ctx.trx);
  return active.length === 0 ? null : org.slug;
}

// The notifications an outbox event's dispatch wrote that are to be pushed: unread, of a pushed kind, written within the last day (a replayed event wrote none, and an old one is not pushed again). For the
// worker, in the system context, right after the notify job ran. Ids only.
export const pushPending = defineQuery({
  name: 'kernel.push.pending',
  input: z.strictObject({ eventId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<string[]> => {
    const kinds = [...PUSH_KINDS.keys()];
    if (kinds.length === 0) return [];
    const { rows } = await sql<{ id: string }>`
      SELECT n.id FROM ludy_kernel.notification n
      WHERE n.org_id = ${ctx.orgId} AND n.event_id = ${input.eventId} AND n.kind = ANY(${kinds}::text[]) AND n.read_at IS NULL
        AND n.created_at > pg_catalog.now() - pg_catalog.make_interval(hours => ${PUSH_MAX_AGE_HOURS}::int)
      ORDER BY n.id
      LIMIT ${PUSH_PENDING_LIMIT}`.execute(ctx.trx);
    return rows.map((r) => r.id);
  },
});

// For the worker's push job of a kernel notification: its line and path and its member's subscriptions, or null when nothing is to be sent (a kind that is not pushed, a notification gone, read or older than a
// day, a kind the member turned off since, an org no longer active, a member who left or whose account is disabled, no subscription).
export const pushTargets = defineQuery({
  name: 'kernel.push.targets',
  input: z.strictObject({ notificationId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<PushTargets | null> => {
    const { rows } = await sql<{ user_id: string; kind: string; subject_type: string | null; subject_id: string | null; read_at: Date | null; fresh: boolean }>`
      SELECT n.user_id, n.kind, n.subject_type, n.subject_id, n.read_at,
             n.created_at > pg_catalog.now() - pg_catalog.make_interval(hours => ${PUSH_MAX_AGE_HOURS}::int) AS fresh
      FROM ludy_kernel.notification n
      WHERE n.org_id = ${ctx.orgId} AND n.id = ${input.notificationId}`.execute(ctx.trx);
    const n = rows[0];
    const kind = n ? PUSH_KINDS.get(n.kind) : undefined;
    if (!n || !kind || n.read_at !== null) return null;
    if (!n.fresh) return null;
    // The one switch: a kind the member turned off pushes nothing, whenever they turned it off.
    const muted = await ctx.trx.selectFrom('ludy_kernel.notification_mute').select('kind').where('org_id', '=', ctx.orgId).where('user_id', '=', n.user_id).where('kind', '=', n.kind).executeTakeFirst();
    if (muted) return null;
    const slug = await pushOrgSlug(ctx, n.user_id);
    if (slug === null) return null;
    const subscriptions = await pushSubscriptionsOf(ctx, n.user_id);
    if (subscriptions.length === 0) return null;
    return {
      subscriptions,
      line: kind.line,
      path: kind.path(slug, { type: n.subject_type, id: n.subject_id }),
      tag: `${n.kind}:${n.subject_id ?? input.notificationId}`,
    };
  },
});

// The push service's answer for each subscription a job sent to: 'sent' resets its failures, 'gone' (404, 410, or an endpoint the egress guard refuses) deletes it, 'failed' counts one more failure and deletes it
// at the limit. The shared record of Social's and the kernel's jobs.
export const pushRecord = defineCommand({
  name: 'kernel.push.record',
  input: z.strictObject({ results: z.array(z.strictObject({ id: zId, outcome: z.enum(['sent', 'gone', 'failed']) })).min(1).max(PUSH_DEVICE_LIMIT) }),
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx: CommandContext, input): Promise<{ sent: number; removed: number; failed: number }> => {
    const ids = (outcome: string) => input.results.filter((r) => r.outcome === outcome).map((r) => r.id);
    const sent = ids('sent');
    const gone = ids('gone');
    const failed = ids('failed');
    if (sent.length > 0) await ctx.trx.updateTable('ludy_kernel.push_subscription').set({ failure_count: 0, last_used_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', 'in', sent).execute();
    let removed = 0;
    if (failed.length > 0) {
      await ctx.trx
        .updateTable('ludy_kernel.push_subscription')
        .set((eb) => ({ failure_count: eb('failure_count', '+', 1) }))
        .where('org_id', '=', ctx.orgId)
        .where('id', 'in', failed)
        .execute();
      const worn = await ctx.trx.deleteFrom('ludy_kernel.push_subscription').where('org_id', '=', ctx.orgId).where('id', 'in', failed).where('failure_count', '>=', PUSH_FAILURE_LIMIT).executeTakeFirst();
      removed += Number(worn.numDeletedRows);
    }
    if (gone.length > 0) {
      const done = await ctx.trx.deleteFrom('ludy_kernel.push_subscription').where('org_id', '=', ctx.orgId).where('id', 'in', gone).executeTakeFirst();
      removed += Number(done.numDeletedRows);
    }
    return { sent: sent.length, removed, failed: failed.length };
  },
});

export const pushCommands = [pushSubscribe, pushUnsubscribe, pushRecord];
export const pushQueries = [pushDevices, pushPending, pushTargets];
