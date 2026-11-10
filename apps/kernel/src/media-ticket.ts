// SPDX-License-Identifier: AGPL-3.0-only
// The short-lived signed ticket that lets a `<video src>` play one meeting's video (#2703). A browser media element cannot
// send the bearer header, so the app asks for a ticket (POST /api/meetings/:id/video/ticket, behind the bearer check) and
// puts it in the stream URL. The ticket is STATELESS: `v1.<base64url JSON payload>.<base64url HMAC-SHA256>`, signed with
// a key the credential broker derives for this one purpose, so no table and no migration. It proves only who asked, for
// which meeting, video file and key, until when; every request that carries it still re-checks the session and the
// reader's access in the database, so a revoked session or a removed reader loses access at once.
//
// This module is pure (no http, no database): signing, shape and the time rules.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The label the broker derives the signing key under; it names no other purpose's key. */
export const MEDIA_TICKET_KEY_LABEL = 'crove.meetings.v1|video-ticket';
export const MEDIA_TICKET_PURPOSE = 'meeting_video';
/** The longest a ticket lives, on issue and on verify (whatever its payload says). */
export const MEDIA_TICKET_MAX_TTL_SECONDS = 600;
/** The clock difference tolerated between the issuing and the verifying process. */
export const MEDIA_TICKET_SKEW_SECONDS = 5;

export interface MediaTicketPayload {
  /** The media key id of the video: it names the broker key the ticket is signed with and binds the ticket to the sealing. */
  keyId: string;
  orgId: string;
  userId: string;
  sessionId: string;
  aal: 'aal1' | 'aal2';
  mfaAt: number | null;
  meetingId: string;
  /** The video's own file: a re-recorded video is another file, so an older ticket stops working. */
  fileId: string;
  purpose: typeof MEDIA_TICKET_PURPOSE;
  /** Unix seconds. */
  iat: number;
  exp: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// v1, a payload of at most 1 KiB of JSON (1366 base64url characters), and a 32-byte MAC (43 characters).
const SHAPE = /^v1\.([A-Za-z0-9_-]{1,1400})\.([A-Za-z0-9_-]{43})$/;

/** A ticket as the URL carries it; anything else is refused before any key is derived. */
export function wellFormedMediaTicket(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1500 && SHAPE.test(value);
}

function mac(key: Buffer, signed: string): Buffer {
  return createHmac('sha256', key).update(signed, 'utf8').digest();
}

export function signMediaTicket(key: Buffer, payload: MediaTicketPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signed = `v1.${body}`;
  return `${signed}.${mac(key, signed).toString('base64url')}`;
}

function isPayload(value: unknown): value is MediaTicketPayload {
  if (value === null || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
  const id = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
  return (
    text(p.keyId) &&
    id(p.orgId) &&
    id(p.userId) &&
    id(p.sessionId) &&
    (p.aal === 'aal1' || p.aal === 'aal2') &&
    (p.mfaAt === null || (typeof p.mfaAt === 'number' && Number.isFinite(p.mfaAt))) &&
    id(p.meetingId) &&
    id(p.fileId) &&
    p.purpose === MEDIA_TICKET_PURPOSE &&
    Number.isInteger(p.iat) &&
    Number.isInteger(p.exp)
  );
}

/**
 * The payload of a well-formed ticket WITHOUT checking its signature: only to learn which key id to derive the signing key
 * for. Nothing in it is to be trusted until verifyMediaTicket has accepted the same ticket.
 */
export function peekMediaTicketKeyId(ticket: string): string | null {
  const parsed = parse(ticket);
  return parsed ? parsed.payload.keyId : null;
}

function parse(ticket: string): { payload: MediaTicketPayload; signed: string; signature: Buffer } | null {
  const match = typeof ticket === 'string' ? SHAPE.exec(ticket) : null;
  if (!match) return null;
  const [, body, signature] = match;
  if (body === undefined || signature === undefined) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isPayload(payload)) return null;
  return { payload, signed: `v1.${body}`, signature: Buffer.from(signature, 'base64url') };
}

/**
 * The payload when the ticket was signed with `key` and is within its time rules, else null (one answer for every reason).
 * The time rules hold whatever the payload says: expired, issued in the future (beyond a few seconds of skew), or living
 * more than MEDIA_TICKET_MAX_TTL_SECONDS from now, are all refused. The MAC is compared in constant time over equal lengths.
 */
export function verifyMediaTicket(ticket: string, key: Buffer, nowSeconds: number): MediaTicketPayload | null {
  const parsed = parse(ticket);
  if (!parsed) return null;
  const expected = mac(key, parsed.signed);
  if (parsed.signature.length !== expected.length || !timingSafeEqual(parsed.signature, expected)) return null;
  const { payload } = parsed;
  if (payload.exp <= nowSeconds) return null;
  if (payload.exp > nowSeconds + MEDIA_TICKET_MAX_TTL_SECONDS) return null;
  if (payload.iat > nowSeconds + MEDIA_TICKET_SKEW_SECONDS) return null;
  if (payload.exp <= payload.iat) return null;
  return payload;
}
