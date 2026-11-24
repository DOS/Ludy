// SPDX-License-Identifier: AGPL-3.0-only
// One meeting, one live capture (ADR-0055 slice 1, issue #4123): the shapes of the capture a client starts when it records a call, the heartbeat that keeps it alive, and the one rule that reads which call
// a join address names. The server decides: a second capture of a call that is already being captured is refused, naming the kind of client and since when, never a person and never the other meeting.
// The table is ludy_meetings.capture_session; nothing here calls a model.
import { z } from 'zod';
import { zId } from './schemas.ts';

// A running capture is heard from at least this often (a client sends its heartbeat every CAPTURE_HEARTBEAT_SECONDS); one not heard from for CAPTURE_LOST_SECONDS is over (a crashed browser or a closed
// laptop must not lock the call). The end is read when the next capture of the same call starts, so no job runs for it.
export const CAPTURE_HEARTBEAT_SECONDS = 30;
export const CAPTURE_LOST_SECONDS = 90;

// Which client is capturing: decided by the server from who is calling (an extension token, a Ludy Desktop token, or the member's session in the app), never sent by a client.
export const zCaptureKind = z.enum(['extension', 'app', 'desktop']);
export type CaptureKind = z.infer<typeof zCaptureKind>;

// How a capture ended: its media reached the server, the recording was reported stopped, or no heartbeat came for CAPTURE_LOST_SECONDS.
export const zCaptureEndedReason = z.enum(['media', 'stopped', 'lost']);
export type CaptureEndedReason = z.infer<typeof zCaptureEndedReason>;

// What a client says about the call it records, when it knows: the member's own calendar event (the event's join address is read on the server) and/or the join address of the tab or the event. Both are
// optional: with neither the call is unknown, and the capture is recorded but conflicts with nothing. The address is read into a key and never stored.
export const zCaptureStart = z.strictObject({
  agendaId: zId.optional(),
  joinUrl: z.string().max(500).optional(),
});
export type CaptureStart = z.infer<typeof zCaptureStart>;

// The heartbeat of a running capture, and the answer: `open` is true while the capture is the one that holds its call. A client whose capture is not open keeps recording (the rule only stops a second
// start; it never destroys a recording) and may tell the person.
// `end` is the client's last word when the person stops recording: it ends the capture at once, so a new recording begun within the next 90 seconds is not refused by the one that just ended.
export const zCaptureHeartbeat = z.strictObject({ meetingId: zId, end: z.boolean().optional() });
export type CaptureHeartbeat = z.infer<typeof zCaptureHeartbeat>;
export const zCaptureHeartbeatDone = z.strictObject({ open: z.boolean() });
export type CaptureHeartbeatDone = z.infer<typeof zCaptureHeartbeatDone>;

// The details of the refusal CAPTURE_ALREADY_RUNNING (409): the kind of client that holds the call and since when (ISO time). Nothing else: no name, no meeting.
export const zCaptureRunning = z.strictObject({ kind: zCaptureKind, since: z.string() });
export type CaptureRunning = z.infer<typeof zCaptureRunning>;

export type CapturePlatform = 'google_meet' | 'zoom' | 'microsoft_teams';

// The call a join address names: the platform and the id the platform gives the meeting (a Meet code, a Zoom meeting number, a Teams thread). Null for any address this does not recognise (a calendar link, a
// vanity address, another host), so a call is never taken for another by a guess. Pure: the server turns it into a key by hashing it with the org, and stores only the hash.
export function captureCallOf(joinUrl: string): { platform: CapturePlatform; id: string } | null {
  let url: URL;
  try {
    url = new URL(joinUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, '');
  if (host === 'meet.google.com') {
    const m = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})$/i.exec(path);
    return m ? { platform: 'google_meet', id: (m[1] as string).toLowerCase() } : null;
  }
  if (host === 'zoom.us' || host.endsWith('.zoom.us')) {
    const m = /^\/(?:j|wc\/join)\/(\d{9,11})$/.exec(path);
    return m ? { platform: 'zoom', id: m[1] as string } : null;
  }
  if (host === 'teams.microsoft.com') {
    const thread = /^\/l\/meetup-join\/([^/]+)(?:\/|$)/.exec(path);
    if (thread) {
      try {
        const id = decodeURIComponent(thread[1] as string).toLowerCase();
        return /^19:meeting_[a-z0-9_-]+@thread\.(?:v2|skype)$/.test(id) ? { platform: 'microsoft_teams', id } : null;
      } catch {
        return null;
      }
    }
    const meet = /^\/meet\/(\d{9,15})$/.exec(path);
    return meet ? { platform: 'microsoft_teams', id: meet[1] as string } : null;
  }
  return null;
}
