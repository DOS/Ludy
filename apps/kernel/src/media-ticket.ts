// SPDX-License-Identifier: AGPL-3.0-only
// The short-lived signed ticket that lets a `<video src>` play one meeting's video (#2703). A browser media element cannot
// send the bearer header, so the app asks for a ticket (POST /api/meetings/:id/video/ticket, behind the bearer check) and
// puts it in the stream URL. The ticket is STATELESS: `v2.<base64url JSON payload>.<base64url HMAC-SHA256>`, signed with
// a key the credential broker derives for this one purpose, so no table and no migration. It proves only who asked, for
// which meeting, video file and key, until when; every request that carries it still re-checks the session and the
// reader's access in the database, so a revoked session or a removed reader loses access at once.
//
// One ticket has one spelling (#2965). The signed bytes are the text `v2.<body>`, and the body is the payload's JSON in one fixed
// field order with no spare whitespace; a ticket is accepted only when its body is exactly that canonical text and both of its
// base64url parts are the canonical encoding of their bytes (base64url ignores the unused low bits of a last character, so a
// signature has four spellings that decode alike). So two different payloads can never sign the same text, and one payload has
// one valid ticket: an extra or repeated or reordered field, a different spacing or escape, a re-spelled last character, are all
// refused even when the signature covers them. The version in the text moved from v1 to v2 with this rule; a v1 ticket
// (10 minutes at most) is refused and the player asks for another.
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
// v2, a payload of at most 1 KiB of JSON (1366 base64url characters), and a 32-byte MAC (43 characters).
const SHAPE = /^v2\.([A-Za-z0-9_-]{1,1400})\.([A-Za-z0-9_-]{43})$/;

/** A ticket as the URL carries it; anything else is refused before any key is derived. */
export function wellFormedMediaTicket(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1500 && SHAPE.test(value);
}

function mac(key: Buffer, signed: string): Buffer {
  return createHmac('sha256', key).update(signed, 'utf8').digest();
}

// The payload as the one text it is signed as: the fields in this order, nothing else, no whitespace.
function canonicalJson(p: MediaTicketPayload): string {
  return JSON.stringify({
    keyId: p.keyId,
    orgId: p.orgId,
    userId: p.userId,
    sessionId: p.sessionId,
    aal: p.aal,
    mfaAt: p.mfaAt,
    meetingId: p.meetingId,
    fileId: p.fileId,
    purpose: p.purpose,
    iat: p.iat,
    exp: p.exp,
  });
}

// True when the text is the canonical base64url spelling of the bytes it decodes to (no stray low bits in the last character).
const isCanonicalBase64Url = (text: string): boolean => Buffer.from(text, 'base64url').toString('base64url') === text;

export function signMediaTicket(key: Buffer, payload: MediaTicketPayload): string {
  const body = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
  const signed = `v2.${body}`;
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
  if (!isCanonicalBase64Url(body) || !isCanonicalBase64Url(signature)) return null;
  let payload: unknown;
  let text: string;
  try {
    text = Buffer.from(body, 'base64url').toString('utf8');
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPayload(payload)) return null;
  // The body must be exactly the canonical text of what it says: no extra, repeated or reordered field, no other spacing or escape.
  if (canonicalJson(payload) !== text) return null;
  return { payload, signed: `v2.${body}`, signature: Buffer.from(signature, 'base64url') };
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
