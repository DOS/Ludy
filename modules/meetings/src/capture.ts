// SPDX-License-Identifier: AGPL-3.0-only
// One meeting, one live capture (ADR-0055 slice 1, issue #4123). When a client starts to record a call (the browser extension, or the app's recorder), meetings.meeting.create opens a capture here, in the same
// transaction as the meeting, and a second open capture of the same call is refused: 409 CAPTURE_ALREADY_RUNNING, saying to an attendee which kind of client holds the call and since when (to anyone else, nothing more than the refusal), never a person and never the other
// meeting, and the refusal rolls the meeting back, so a refused start leaves nothing. "The same call" is the member's own calendar event or a meeting key (a hash of the org, the platform and the platform's
// meeting id, read from a join address that is never stored); a capture that names neither is recorded and conflicts with nothing. The rule lives in the database (ludy_meetings.capture_open and its unique indexes over open rows): code
// here reads what the client says of its call, asks the definer, and turns its answer into the refusal.
//
// A capture is kept alive by the client's heartbeat (meetings.capture.heartbeat, every 30 seconds) and is over when it has not been heard from for 90 seconds, which the next start of the same call reads: no job
// runs for it. It also ends when its media reaches the server or the recording is reported stopped (endCapture, called where the meeting's end time is set). The rule never destroys a recording: a client whose
// capture was lost keeps recording and uploading, and its next heartbeat takes the call back when nothing else holds it. No model is called here.
import { sql } from 'kysely';
import { captureCallKey } from '@ludy/kernel';
import {
  captureCallOf,
  zCaptureHeartbeat,
  zCaptureHeartbeatDone,
  type CaptureEndedReason,
  type CaptureHeartbeatDone,
  type CaptureKind,
  type CaptureRunning,
  type CaptureStart,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@ludy/kernel-runtime';
import type { MemberRole } from '@ludy/db';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

// The kind of client that is calling, from who is calling: an extension token carries client 'extension' or 'desktop', everything else is the app. A client never says it.
export function captureKindOf(ctx: CommandContext): CaptureKind {
  if (ctx.actor.type === 'user' && ctx.actor.extension) {
    return ctx.actor.extension.client === 'desktop' ? 'desktop' : 'extension';
  }
  return 'app';
}

// What identifies a call in this org: the hash of the org, the platform and the platform's meeting id. The org is part of it so one call in two orgs has two unrelated keys.
export function captureKeyOf(orgId: string, joinUrl: string): string | null {
  const call = captureCallOf(joinUrl);
  return call === null ? null : captureCallKey(orgId, call);
}

/**
 * Opens the capture of a meeting the caller has just made, or refuses with CAPTURE_ALREADY_RUNNING (409, details {kind, since} for an attendee only) when the call is already held; the command's transaction then rolls back,
 * the meeting row included. `start` is what the client said of the call; an extension token is a capture even when it said nothing.
 */
export async function openCapture(ctx: CommandContext, meetingId: string, start: CaptureStart | undefined): Promise<CaptureKind> {
  const kind = captureKindOf(ctx);
  let joinUrl = start?.joinUrl ?? null;
  let agendaId: string | null = null;
  // The caller's own calendar event for this call, if they named one: the proof that they are an attendee (#4538).
  let eventKey: string | null = null;
  if (start?.agendaId !== undefined) {
    // The member's own event only (their row security shows no other); an id that is not theirs, or is gone, is left out rather than refused.
    const { rows } = await sql<{ id: string; join_url: string | null }>`
      SELECT id, join_url FROM ludy_meetings.calendar_agenda WHERE org_id = ${ctx.orgId}::uuid AND id = ${start.agendaId}::uuid`.execute(ctx.trx);
    const event = rows[0];
    if (event) {
      agendaId = event.id;
      eventKey = event.join_url === null ? null : captureKeyOf(ctx.orgId, event.join_url);
      // The call's address is also read from the event when the client gave none, or one this cannot read.
      if ((joinUrl === null || captureCallOf(joinUrl) === null) && event.join_url !== null) joinUrl = event.join_url;
    }
  }
  const key = joinUrl === null ? null : captureKeyOf(ctx.orgId, joinUrl);
  const { rows: held } = await sql<{ kind: CaptureKind; since: Date | string }>`
    SELECT kind, since FROM ludy_meetings.capture_open(${meetingId}::uuid, ${kind}::text, ${agendaId}::uuid, ${key}::text)`.execute(ctx.trx);
  const holder = held[0];
  if (holder) {
    // Who holds the call, and since when, is told to an attendee only: a caller with their own calendar event for this very call (its address gives the same key, or the call is known by the event alone).
    // A member who merely knows the join address gets the same 409 without the details, so it cannot be used to learn that someone in the org is recording that call (#4538).
    const attendee = agendaId !== null && (key === null || eventKey === key);
    const details: CaptureRunning | undefined = attendee ? { kind: holder.kind, since: new Date(holder.since).toISOString() } : undefined;
    throw new DomainError('CAPTURE_ALREADY_RUNNING', 409, 'This meeting is already being recorded', details);
  }
  return kind;
}

/**
 * Ends the capture of a meeting, if it has one. Called where a meeting's recording ends: its media is recorded, or it is reported stopped. A capture already ended as lost is finished with the real reason, so
 * a late heartbeat cannot take the call back for a recording that is over. A no-op for a meeting with no capture, or one that already ended for a real reason.
 */
export async function endCapture(ctx: CommandContext, meetingId: string, reason: CaptureEndedReason): Promise<void> {
  await sql`
    UPDATE ludy_meetings.capture_session
       SET ended_at = COALESCE(ended_at, ${ctx.now}::timestamptz), ended_reason = ${reason}::text
     WHERE org_id = ${ctx.orgId}::uuid AND meeting_id = ${meetingId}::uuid AND (ended_at IS NULL OR ended_reason = 'lost')`.execute(ctx.trx);
}

export const meetingCaptureHeartbeat = defineCommand({
  name: 'meetings.capture.heartbeat',
  input: zCaptureHeartbeat,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // The extension's meetings scope keeps alive, and ends, the capture of a meeting its own token created (ADR-0055 slice 1, #4123).
  extension: { scope: 'meetings' },
  target: (input) => ({ type: 'meetings.meeting', id: input.meetingId }),
  handler: async (ctx: CommandContext, input): Promise<CaptureHeartbeatDone> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Only authenticated members can perform this action');
    const meeting = await ctx.trx
      .selectFrom('ludy_meetings.meeting')
      .select(['recorder_user_id', 'extension_token_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.meetingId)
      .executeTakeFirst();
    if (!meeting) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    if (meeting.recorder_user_id !== ctx.actor.userId) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder may send its heartbeat');
    // An extension token reaches only the meetings it created: any other is answered as one that does not exist.
    if (ctx.actor.extension && meeting.extension_token_id !== ctx.actor.extension.tokenId) throw new DomainError('MEETING_NOT_FOUND', 404, 'Meeting not found');
    if (input.end === true) {
      await endCapture(ctx, input.meetingId, 'stopped');
      ctx.audit({ meetingId: input.meetingId, ended: true });
      return zCaptureHeartbeatDone.parse({ open: false });
    }
    const { rows } = await sql<{ open: boolean }>`SELECT ludy_meetings.capture_beat(${input.meetingId}::uuid) AS open`.execute(ctx.trx);
    const open = rows[0]?.open === true;
    ctx.audit({ meetingId: input.meetingId, open });
    return zCaptureHeartbeatDone.parse({ open });
  },
});

export const captureCommands = [meetingCaptureHeartbeat];
