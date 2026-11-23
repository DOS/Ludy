// SPDX-License-Identifier: AGPL-3.0-only
// Zoom's signed webhook, the doorbell of the recording import (meetings integrations C3, issue #3175, plan docs/plan/meetings-integrations.md section 6.3). Pure functions, no network and no state:
// the signature check, the answer to the URL validation challenge and the reading of a notice. The route (apps/kernel/src/zoom-webhook.ts) decides what a verified notice does, and all it does is ask the
// sweep to list the member's recordings again; nothing in a notice is stored or used, least of all the download address and token it carries.
//
// Zoom signs `v0:{x-zm-request-timestamp}:{raw body}` with HMAC-SHA256 and the app's secret token, and sends `v0=<hex>` in `x-zm-signature`. The URL validation answers `{ plainToken, encryptedToken }` where
// encryptedToken is the hex HMAC-SHA256 of plainToken with the same secret.
//
// THE SIGNING ORACLE. `HMAC(secret, plainToken)` signs whatever the caller chose as plainToken, and `HMAC(secret, "v0:<ts>:<body>")` is exactly a webhook signature. So a caller who sent
// plainToken = "v0:<ts>:<body>" would be handed a valid signature for that body. The challenge is therefore answered only for a plainToken of [A-Za-z0-9_-]{1,128}: it has no colon, so it can never equal
// a `v0:` message.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ZOOM_SIGNATURE_HEADER = 'x-zm-signature';
export const ZOOM_TIMESTAMP_HEADER = 'x-zm-request-timestamp';
// A recording.completed notice with many files is a few KB; 64 KiB is far above that and still cheap to hash. A bigger body is refused before it is read.
export const ZOOM_MAX_NOTICE_BYTES = 64 * 1024;
// How far the request timestamp may be from our clock, either way. Zoom documents no tolerance, so this is our own choice: a retry refused for age is recovered by the sweep.
export const ZOOM_TIMESTAMP_WINDOW_MS = 5 * 60_000;
// What a challenge's plainToken may be: no colon, so no `v0:` message (see above).
export const ZOOM_PLAIN_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

const SIGNATURE = /^v0=([0-9a-f]{64})$/i;
const TIMESTAMP = /^[0-9]{1,13}$/;
const HOST_ID = /^[A-Za-z0-9_-]{1,200}$/;

// THE KEY OF A ZOOM ACCOUNT. Zoom user ids are case-sensitive, but Ludy keys a connection by the id in lower case: the connect step (meeting-platform-zoom.ts) stores it so, a notice's host id is read
// so (parseZoomNotice), and crove_kernel.meeting_platform_ring compares it so. This one function is the rule for the two sides in this package, so they cannot drift (a test ties them by behaviour); the connect command's schema in
// packages/kernel/src/meeting-platform.ts lowers once more on purpose (the kernel cannot import this package), and the SQL side lowers the same way, held to it by apps/kernel/test/meeting-platform-ring.db.test.ts. Decision of #4011 (point 2, from the shared-core review of #3939): keep the folding. Two Zoom users whose ids differ only in case
// would share a key, and the only effect is that the sweep lists the other one's connection early, with that member's own sealed token; no recording, name or token crosses. Storing the id as Zoom sends
// it would be exact, but the case of every stored id is already lost, so each member would have to connect again, and the notices of the old connections would be missed until they did.
export const zoomAccountKey = (id: string): string => id.trim().toLowerCase();

export interface ZoomSignatureInput {
  body: Uint8Array;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  // The token it replaces while a rotation is under way: a notice signed with either is taken.
  secretPrevious?: string | undefined;
  // The clock, in epoch milliseconds.
  nowMs: number;
}

// Whether the notice is Zoom's and fresh. Yes or no, never why; the comparison is constant time and both secrets are always computed, so the time says nothing of which one (if any) matched.
export function zoomSignatureOk(input: ZoomSignatureInput): boolean {
  const mac = input.signature ? SIGNATURE.exec(input.signature.trim()) : null;
  const timestamp = input.timestamp?.trim();
  if (!mac || !timestamp || !TIMESTAMP.test(timestamp) || !input.secret) return false;
  const value = Number(timestamp);
  // Zoom documents seconds since the epoch; a value that large can only be milliseconds, which is read as such rather than refused (the signature covers the string as sent either way).
  const timeMs = value >= 1e12 ? value : value * 1000;
  if (!Number.isSafeInteger(value) || Math.abs(input.nowMs - timeMs) > ZOOM_TIMESTAMP_WINDOW_MS) return false;
  const given = Buffer.from(mac[1] as string, 'hex');
  const message = Buffer.concat([Buffer.from(`v0:${timestamp}:`, 'utf8'), Buffer.from(input.body)]);
  const matches = (secret: string): boolean => {
    const expected = createHmac('sha256', secret).update(message).digest();
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const current = matches(input.secret);
  const previous = input.secretPrevious ? matches(input.secretPrevious) : false;
  return current || previous;
}

// The answer to Zoom's endpoint.url_validation, or null when the plainToken is not one we sign (see THE SIGNING ORACLE above).
export function zoomValidationAnswer(secret: string, plainToken: unknown): { plainToken: string; encryptedToken: string } | null {
  if (typeof plainToken !== 'string' || !ZOOM_PLAIN_TOKEN.test(plainToken) || !secret) return null;
  return { plainToken, encryptedToken: createHmac('sha256', secret).update(plainToken, 'utf8').digest('hex') };
}

export class ZoomNoticeError extends Error {
  constructor() {
    super('malformed');
    this.name = 'ZoomNoticeError';
  }
}

export type ZoomNotice =
  | { kind: 'validation'; plainToken: unknown }
  // A recording (or its transcript) is finished: the host's Zoom user id (lower case, the way a connection keys its account) and the meeting instance, for the replay guard.
  | { kind: 'recording'; event: string; hostId: string; uuid: string; eventTs: string }
  // Any other event, or a recording notice with no usable host id: acknowledged and ignored.
  | { kind: 'ignored' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// Reads a body that already passed the signature (or is an unsigned challenge). Only the few fields it needs; everything else, the download address and token included, is never looked at.
export function parseZoomNotice(body: Uint8Array): ZoomNotice {
  if (body.byteLength === 0 || body.byteLength > ZOOM_MAX_NOTICE_BYTES) throw new ZoomNoticeError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new ZoomNoticeError();
  }
  if (!isRecord(parsed) || typeof parsed.event !== 'string') throw new ZoomNoticeError();
  const payload = isRecord(parsed.payload) ? parsed.payload : {};
  if (parsed.event === 'endpoint.url_validation') return { kind: 'validation', plainToken: payload.plainToken };
  if (parsed.event !== 'recording.completed' && parsed.event !== 'recording.transcript_completed') return { kind: 'ignored' };
  const object = isRecord(payload.object) ? payload.object : {};
  const hostId = typeof object.host_id === 'string' ? object.host_id.trim() : '';
  if (!HOST_ID.test(hostId)) return { kind: 'ignored' };
  const uuid = typeof object.uuid === 'string' ? object.uuid.slice(0, 200) : '';
  const eventTs = typeof parsed.event_ts === 'number' && Number.isFinite(parsed.event_ts) ? String(parsed.event_ts) : '';
  return { kind: 'recording', event: parsed.event, hostId: zoomAccountKey(hostId), uuid, eventTs };
}
