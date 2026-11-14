// SPDX-License-Identifier: AGPL-3.0-only
// A member's own webhook for the minutes they publish (meetings integrations A6, issue #3164, plan docs/plan/meetings-integrations.md section 4.5).
//
// - The member sets one https address, ticks the fields and gets a secret once; every time they publish a result (meetings.result.publish) one signed POST is stored for that address in the
//   recorder's own transaction and sent at least once by the worker (apps/kernel/src/meeting-hook.ts), through the egress guard. No model touches it: what leaves is what the person approved.
// - The secret never passes through a command in the clear: the API makes it, seals it with the credential broker and hands the command only the envelope; the audit rows name the host and the
//   fields, never the address, the secret or any text.
// - The body is built only by meetingHookBody (packages/kernel-contract/src/meeting-hook-body.ts), here from rows the recorder reads under row security, and checked again by the database
//   (crove_meetings.hook_body_ok). The system context cannot read meetings, so the body is built at publish and kept only while the delivery is queued.
// - The owner's switch (crove_kernel.tenant.meeting_hooks, off by default) gates all of it; turning it off drops every queued delivery in the same transaction.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import {
  mcpWakeUrlProblem,
  meetingHookBody,
  zMeetingHookEventRef,
  zMeetingHookNone,
  zMeetingHookRecord,
  zMeetingHookRotateCommand,
  zMeetingHookSetCommand,
  zMeetingHooksSwitch,
  zMeetingHookTargetRef,
  type MeetingHookField,
  type MeetingHookView, type MeetingHookDeliveryRow, type MeetingHookTargetRow } from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, hasFreshMfa, type CommandContext } from '@crove/kernel-runtime';
import { ROLES } from './transcript.ts';

type Trx = CommandContext['trx'];

function hookError(error: unknown): never {
  const message = (error as { message?: unknown } | null)?.message;
  switch (message) {
    case 'MEETING_HOOKS_OFF':
      throw new DomainError('MEETING_HOOKS_OFF', 409, 'Chủ sở hữu tổ chức chưa cho phép thành viên gửi biên bản tới địa chỉ riêng');
    case 'MEETING_HOOK_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Bạn không cài được địa chỉ nhận biên bản trong tổ chức này');
    case 'MEETING_HOOKS_FORBIDDEN':
      throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu tổ chức mới bật hoặc tắt được việc gửi biên bản tới địa chỉ riêng');
    case 'MEETING_HOOK_NOT_FOUND':
      throw new DomainError('MEETING_HOOK_NOT_FOUND', 404, 'Bạn chưa có địa chỉ nhận biên bản, hoặc địa chỉ này đang tắt');
    case 'MEETING_HOOK_TOO_SOON':
      throw new DomainError('MEETING_HOOK_TOO_SOON', 429, 'Gửi thử được một lần mỗi phút và tối đa mười lần mỗi giờ');
    case 'MEETING_HOOK_INVALID':
      throw new DomainError('INVALID', 422, 'Địa chỉ nhận hoặc các mục gửi không hợp lệ');
    default:
      throw error;
  }
}

function userOnly(ctx: CommandContext | { actor: CommandContext['actor'] }, what: string): void {
  if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, `Chỉ người dùng mới ${what}`);
}

// An address is where meeting text leaves the deployment: a member with a second factor sets it with a fresh one (ADR-0047 point 10).
function stepUp(ctx: CommandContext, what: string): void {
  if (ctx.actor.type === 'user' && ctx.actor.aal === 'aal2' && !hasFreshMfa(ctx.actor)) {
    throw new DomainError('STEP_UP_REQUIRED', 403, `Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để ${what}`);
  }
}

const sealedOf = (c: { keyId: string; envelope: string }) => JSON.stringify({ keyId: c.keyId, envelope: c.envelope });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The member's setup
// ---------------------------------------------------------------------------------------------------------------------------------------------
type HookRow = {
  url: string;
  fields: string[];
  enabled: boolean;
  paused_reason: 'failing' | null;
  secret_hint: string;
  previous_until: Date | null;
  failing_since: Date | null;
  consecutive_failures: number;
  last_delivery_at: Date | null;
  last_status: 'sent' | 'failed' | null;
  created_at: Date;
};
const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function readHook(trx: Trx): Promise<MeetingHookView | null> {
  const { rows } = await sql<HookRow>`SELECT url, fields, enabled, paused_reason, secret_hint, previous_until, failing_since, consecutive_failures, last_delivery_at, last_status, created_at FROM crove_meetings.hook_get()`
    .execute(trx)
    .catch(hookError);
  const r = rows[0];
  if (!r) return null;
  return {
    url: r.url,
    fields: r.fields as MeetingHookField[],
    enabled: r.enabled,
    pausedReason: r.paused_reason,
    secretHint: r.secret_hint,
    previousUntil: iso(r.previous_until),
    failingSince: iso(r.failing_since),
    consecutiveFailures: r.consecutive_failures,
    lastDeliveryAt: iso(r.last_delivery_at),
    lastStatus: r.last_status,
    createdAt: r.created_at.toISOString(),
  };
}

export interface MeetingHookStateRead {
  switchOn: boolean;
  hook: MeetingHookView | null;
}

// The card's state for the member: the owner's switch and the member's own webhook (the secret never). Every member who records reads it.
export const meetingHookGet = defineQuery({
  name: 'meetings.hook.get',
  input: zMeetingHookNone,
  access: ROLES,
  handler: async (ctx): Promise<MeetingHookStateRead> => {
    if (ctx.actor.type !== 'user' || ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới xem được địa chỉ nhận biên bản');
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select(['meeting_hooks']).where('org_id', '=', ctx.orgId).executeTakeFirst();
    return { switchOn: tenant?.meeting_hooks === true, hook: await readHook(ctx.trx) };
  },
});

export const meetingHookSet = defineCommand({
  name: 'meetings.hook.set',
  input: zMeetingHookSetCommand,
  risk: 'R2',
  // The text the member ticked leaves the deployment for the address they set, once a result is published.
  sideEffect: 'external',
  access: ROLES,
  handler: async (ctx, input) => {
    userOnly(ctx, 'cài được địa chỉ nhận biên bản');
    stepUp(ctx, 'cài địa chỉ nhận biên bản');
    if (mcpWakeUrlProblem(input.url) !== null) throw new DomainError('INVALID', 422, 'Địa chỉ nhận phải là https, dùng tên miền công khai, cổng 443, không kèm tài khoản');
    const url = new URL(input.url);
    const { rows } = await sql<{ created: boolean }>`
      SELECT crove_meetings.hook_put(${url.href}, ${sealedOf(input.credential)}::jsonb, ${input.credential.hint}, ${input.fields}::text[], ${input.enabled}) AS created`
      .execute(ctx.trx)
      .catch(hookError);
    const created = rows[0]?.created === true;
    // The host, the fields and the state: never the address (it can carry a token in its path), a secret or the sealed envelope.
    ctx.audit({ host: url.hostname, fields: input.fields, enabled: input.enabled, created });
    return { created };
  },
});

export const meetingHookRotate = defineCommand({
  name: 'meetings.hook.rotate_secret',
  input: zMeetingHookRotateCommand,
  risk: 'R2',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx, input) => {
    userOnly(ctx, 'đổi được khóa bí mật của địa chỉ nhận biên bản');
    stepUp(ctx, 'đổi khóa bí mật');
    const { rows } = await sql<{ rotated: boolean }>`SELECT crove_meetings.hook_rotate(${sealedOf(input.credential)}::jsonb, ${input.credential.hint}) AS rotated`.execute(ctx.trx).catch(hookError);
    if (rows[0]?.rotated !== true) throw new DomainError('MEETING_HOOK_NOT_FOUND', 404, 'Bạn chưa có địa chỉ nhận biên bản');
    ctx.audit({ hint: input.credential.hint });
    return { rotated: true as const };
  },
});

export const meetingHookClear = defineCommand({
  name: 'meetings.hook.clear',
  input: zMeetingHookNone,
  risk: 'R2',
  sideEffect: 'internal',
  access: ROLES,
  handler: async (ctx) => {
    userOnly(ctx, 'gỡ được địa chỉ nhận biên bản');
    const { rows } = await sql<{ cleared: boolean }>`SELECT crove_meetings.hook_clear() AS cleared`.execute(ctx.trx).catch(hookError);
    if (rows[0]?.cleared !== true) throw new DomainError('MEETING_HOOK_NOT_FOUND', 404, 'Bạn chưa có địa chỉ nhận biên bản');
    ctx.audit({});
    return { cleared: true as const };
  },
});

// "Gửi thử": stores a `ping` for the member's own address (the sweep hands it to the queue within a minute). It carries no meeting data.
export const meetingHookTest = defineCommand({
  name: 'meetings.hook.test',
  input: zMeetingHookNone,
  risk: 'R2',
  sideEffect: 'external',
  access: ROLES,
  handler: async (ctx) => {
    userOnly(ctx, 'gửi thử được tới địa chỉ nhận biên bản');
    stepUp(ctx, 'gửi thử');
    const { rows } = await sql<{ id: string }>`SELECT crove_meetings.hook_test() AS id`.execute(ctx.trx).catch(hookError);
    const eventId = rows[0]?.id;
    if (!eventId) throw new DomainError('MEETING_HOOK_NOT_FOUND', 404, 'Bạn chưa có địa chỉ nhận biên bản');
    ctx.audit({ eventId });
    return { eventId, queued: true as const };
  },
});

// The owner's switch (off by default). Turning it off drops every queued delivery of the org in the same transaction, so nothing already stored goes out afterwards. The database's guard
// trigger lets only this command's actors (an owner in the org's own context) change the column.
export const meetingHooksSwitchSet = defineCommand({
  name: 'meetings.hooks.switch.set',
  input: zMeetingHooksSwitch,
  risk: 'R2',
  sideEffect: 'internal',
  access: ['owner'],
  handler: async (ctx, input) => {
    userOnly(ctx, 'bật hoặc tắt được việc gửi biên bản tới địa chỉ riêng');
    stepUp(ctx, 'đổi cài đặt này');
    const tenant = await ctx.trx.selectFrom('crove_kernel.tenant').select(['meeting_hooks']).where('org_id', '=', ctx.orgId).executeTakeFirst();
    const previous = tenant?.meeting_hooks === true;
    await ctx.trx.updateTable('crove_kernel.tenant').set({ meeting_hooks: input.on }).where('org_id', '=', ctx.orgId).execute().catch(hookError);
    let dropped = 0;
    if (!input.on) {
      const { rows } = await sql<{ n: number }>`SELECT crove_meetings.hooks_drop_all() AS n`.execute(ctx.trx).catch(hookError);
      dropped = rows[0]?.n ?? 0;
    }
    ctx.audit({ on: input.on, previous, dropped });
    return { on: input.on };
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// At publish: the event for the recorder's own webhook, built here from what they read and just published
// ---------------------------------------------------------------------------------------------------------------------------------------------
export interface PublishedMinutes {
  meetingId: string;
  // The published result's id when this publish carried one (a stable event id), else null.
  resultId: string | null;
  summary: string | null;
  decisions: string[] | null;
  items: Array<{ title: string; whoDrafted: string | null; whenParsed: string | null }>;
}

// The owner and due as the receiver gets them: the owner as said in the meeting (text), the due date the one the system read, a plain date.
const dateOnly = (value: string | Date | null): string | null => (value === null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10));

// Stores the event for the recorder's webhook when there is one to send to: the member has an enabled address, the owner's switch is on and they are still in the org. Called by
// meetings.result.publish in its own transaction, after the result and the items are published, so a publish that fails stores nothing and a stored event is for a publish that happened.
export async function enqueueMinutesHook(ctx: CommandContext, published: PublishedMinutes): Promise<boolean> {
  const { rows: found } = await sql<{ hook_id: string; fields: MeetingHookField[] }>`SELECT hook_id, fields FROM crove_meetings.hook_for_publish(${published.meetingId}::uuid)`.execute(ctx.trx);
  const hook = found[0];
  if (!hook) return false;
  const meeting = await ctx.trx.selectFrom('crove_meetings.meeting').select(['title', 'started_at', 'length_seconds']).where('org_id', '=', ctx.orgId).where('id', '=', published.meetingId).executeTakeFirst();
  if (!meeting) return false;
  const eventId = published.resultId ?? randomUUID();
  const publishedAt = new Date().toISOString();
  const data: Record<string, unknown> = {
    meeting_id: published.meetingId,
    published_at: publishedAt,
    // A meeting without a start time (not expected for one with a result) is dated by its publish.
    started_at: meeting.started_at ? new Date(meeting.started_at).toISOString() : publishedAt,
    // A length the body cannot carry (the meeting row only requires it to be a whole number of seconds, not a day or less) is sent as null: the webhook never blocks a publish.
    length_seconds: meeting.length_seconds !== null && Number.isInteger(meeting.length_seconds) && meeting.length_seconds >= 0 && meeting.length_seconds <= 86400 ? meeting.length_seconds : null,
  };
  // Each value is cut to what the body carries (the builder's limits), so a long text never fails a publish; nothing is added.
  if (hook.fields.includes('title') && meeting.title) data.title = meeting.title.slice(0, 300);
  if (hook.fields.includes('summary') && published.summary) data.summary = published.summary.slice(0, 8000);
  if (hook.fields.includes('decisions') && published.decisions && published.decisions.length > 0) data.decisions = published.decisions.slice(0, 50).map((d) => d.slice(0, 1000)).filter((d) => d.length > 0);
  if (hook.fields.includes('action_items') && published.items.length > 0) {
    data.action_items = published.items
      .slice(0, 100)
      .filter((i) => i.title.length > 0)
      .map((i) => ({ text: i.title.slice(0, 300), owner: i.whoDrafted && i.whoDrafted.length > 0 ? i.whoDrafted.slice(0, 200) : null, due: dateOnly(i.whenParsed) }));
  }
  // The strict builder: a key or a value that does not fit is refused. The webhook is optional and never blocks the minutes: a body that cannot be built stores nothing and the publish goes on.
  let text: string;
  try {
    text = meetingHookBody({ id: eventId, type: 'meeting.result_published', created_at: publishedAt, org: ctx.orgId, data });
  } catch {
    return false;
  }
  const { rows } = await sql<{ stored: boolean }>`
    SELECT crove_meetings.hook_enqueue_publish(${eventId}::uuid, ${hook.hook_id}::uuid, ${published.meetingId}::uuid, ${text}::jsonb) AS stored`
    .execute(ctx.trx)
    .catch(hookError);
  return rows[0]?.stored === true;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The delivery's own steps: commands and queries of the system actor, run by the worker's sweep and delivery job in the org's system context. None is a procedure of the contract,
// and no user, agent or MCP grant reaches any of them. The address and the secret are never an input of any of them.
// ---------------------------------------------------------------------------------------------------------------------------------------------
function systemOnly(ctx: { actor: CommandContext['actor'] }, what: string): void {
  if (ctx.actor.type !== 'system') throw new DomainError('FORBIDDEN', 403, `Chỉ hệ thống mới ${what}`);
}

export const meetingHookQueued = defineCommand({
  name: 'meetings.hook.queued',
  input: zMeetingHookEventRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    systemOnly(ctx, 'ghi nhận lần chuyển vào hàng đợi');
    const { rows } = await sql<{ done: boolean }>`SELECT crove_meetings.hook_touch(${input.id}::uuid) AS done`.execute(ctx.trx).catch(hookError);
    return { id: input.id, touched: rows[0]?.done === true };
  },
});

export const meetingHookRecord = defineCommand({
  name: 'meetings.hook.record',
  input: zMeetingHookRecord,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  handler: async (ctx, input) => {
    systemOnly(ctx, 'ghi nhận kết quả một lần gửi');
    const { rows } = await sql<{ done: boolean }>`SELECT crove_meetings.hook_record(${input.id}::uuid, ${input.outcome}, ${input.code ?? null}::int) AS done`.execute(ctx.trx).catch(hookError);
    const done = rows[0]?.done === true;
    // The outcome and the receiver's status code: never the answer, which is not read, and never the body, which is wiped here.
    ctx.audit({ eventId: input.id, outcome: input.outcome, code: input.code ?? null, settled: done });
    return { id: input.id, recorded: done };
  },
});

// What the delivery job reads: the delivery by its event id (its body is what the receiver gets), and the address and sealed secrets of the hook while it stands.
export const meetingHookDelivery = defineQuery({
  name: 'meetings.hook.delivery',
  input: zMeetingHookEventRef,
  access: 'system',
  handler: async (ctx, input): Promise<MeetingHookDeliveryRow | null> => {
    systemOnly(ctx, 'đọc một lần gửi biên bản đang chờ');
    const { rows } = await sql<{ id: string; hook_id: string; type: MeetingHookDeliveryRow['type']; body: Record<string, unknown> | null; status: MeetingHookDeliveryRow['status']; attempts: number }>`
      SELECT id, hook_id, type, body, status, attempts FROM crove_meetings.hook_delivery_get(${ctx.orgId}::uuid, ${input.id}::uuid)`.execute(ctx.trx);
    const r = rows[0];
    return r ? { id: r.id, hookId: r.hook_id, type: r.type, body: r.body, status: r.status, attempts: r.attempts } : null;
  },
});

export const meetingHookTarget = defineQuery({
  name: 'meetings.hook.target',
  input: zMeetingHookTargetRef,
  access: 'system',
  handler: async (ctx, input): Promise<MeetingHookTargetRow | null> => {
    systemOnly(ctx, 'đọc địa chỉ nhận biên bản');
    const { rows } = await sql<{ user_id: string; url: string; secret_sealed: { keyId: string; envelope: string }; previous_sealed: { keyId: string; envelope: string } | null }>`
      SELECT user_id, url, secret_sealed, previous_sealed FROM crove_meetings.hook_target(${input.hookId}::uuid)`.execute(ctx.trx);
    const r = rows[0];
    return r ? { userId: r.user_id, url: r.url, sealed: r.secret_sealed, previous: r.previous_sealed } : null;
  },
});

export const hookCommands = [meetingHookSet, meetingHookRotate, meetingHookClear, meetingHookTest, meetingHooksSwitchSet, meetingHookQueued, meetingHookRecord];
export const hookQueries = [meetingHookGet, meetingHookDelivery, meetingHookTarget];
