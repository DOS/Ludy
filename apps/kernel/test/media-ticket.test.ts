// SPDX-License-Identifier: AGPL-3.0-only
// The signed meeting video ticket (#2703): signing, shape and the time rules, with no database.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MEDIA_TICKET_KEY_LABEL,
  MEDIA_TICKET_MAX_TTL_SECONDS,
  peekMediaTicketKeyId,
  signMediaTicket,
  verifyMediaTicket,
  wellFormedMediaTicket,
  type MediaTicketPayload,
} from '../src/media-ticket.ts';
import { corsMiddleware } from '../src/cors.ts';
import { Hono } from 'hono';

const derive = (root: string, label: string) => createHash('sha256').update(`${root}:${label}`).digest();
const KEY = derive('root', MEDIA_TICKET_KEY_LABEL);
const NOW = 1_800_000_000;

function payload(over: Partial<MediaTicketPayload> = {}): MediaTicketPayload {
  return {
    keyId: 'k1',
    orgId: randomUUID(),
    userId: randomUUID(),
    sessionId: randomUUID(),
    aal: 'aal1',
    mfaAt: null,
    meetingId: randomUUID(),
    fileId: randomUUID(),
    purpose: 'meeting_video',
    iat: NOW,
    exp: NOW + MEDIA_TICKET_MAX_TTL_SECONDS,
    ...over,
  };
}

const swapPayload = (ticket: string, change: (p: Record<string, unknown>) => void) => {
  const [v, body, mac] = ticket.split('.') as [string, string, string];
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  change(p);
  return `${v}.${Buffer.from(JSON.stringify(p)).toString('base64url')}.${mac}`;
};

describe('meeting video ticket', () => {
  it('round-trips and names its key id before it is verified', () => {
    const p = payload({ aal: 'aal2', mfaAt: NOW - 30 });
    const ticket = signMediaTicket(KEY, p);
    expect(ticket).toMatch(/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(wellFormedMediaTicket(ticket)).toBe(true);
    expect(peekMediaTicketKeyId(ticket)).toBe('k1');
    expect(verifyMediaTicket(ticket, KEY, NOW)).toEqual(p);
  });

  it('refuses a changed payload, a changed signature and another key', () => {
    const ticket = signMediaTicket(KEY, payload());
    expect(verifyMediaTicket(swapPayload(ticket, (p) => (p.userId = randomUUID())), KEY, NOW)).toBeNull();
    expect(verifyMediaTicket(swapPayload(ticket, (p) => (p.exp = NOW + 5000)), KEY, NOW)).toBeNull();
    const parts = ticket.split('.');
    const flipped = `${parts[2]!.startsWith('A') ? 'B' : 'A'}${parts[2]!.slice(1)}`;
    expect(verifyMediaTicket(`${parts[0]}.${parts[1]}.${flipped}`, KEY, NOW)).toBeNull();
    expect(verifyMediaTicket(ticket, randomBytes(32), NOW)).toBeNull();
  });

  it('refuses a ticket signed with any other derived key', () => {
    const p = payload();
    for (const label of ['crove.meetings.v1|wrap', 'crove.audit.read.v1', `random-${randomUUID()}`]) {
      expect(MEDIA_TICKET_KEY_LABEL).not.toBe(label);
      expect(verifyMediaTicket(signMediaTicket(derive('root', label), p), KEY, NOW), label).toBeNull();
    }
    // The same label under another root key does not verify either.
    expect(verifyMediaTicket(signMediaTicket(derive('other-root', MEDIA_TICKET_KEY_LABEL), p), KEY, NOW)).toBeNull();
  });

  it('holds the time rules whatever the payload says', () => {
    const ok = (over: Partial<MediaTicketPayload>, now = NOW) => verifyMediaTicket(signMediaTicket(KEY, payload(over)), KEY, now) !== null;
    expect(ok({})).toBe(true);
    // Expired, and expiring this very second.
    expect(ok({ exp: NOW - 1 })).toBe(false);
    expect(ok({ exp: NOW })).toBe(false);
    expect(ok({ iat: NOW - 600, exp: NOW + 1 })).toBe(true);
    // More than now + 600 s ahead, even with a good signature (a forged-by-bug long ticket).
    expect(ok({ exp: NOW + MEDIA_TICKET_MAX_TTL_SECONDS + 1 })).toBe(false);
    expect(ok({ exp: NOW + 86_400 })).toBe(false);
    // Issued in the future beyond the skew; a few seconds of skew are accepted.
    expect(ok({ iat: NOW + 60, exp: NOW + 120 })).toBe(false);
    expect(ok({ iat: NOW + 3, exp: NOW + 100 })).toBe(true);
    // Never valid before it was issued.
    expect(ok({ iat: NOW, exp: NOW - 1 })).toBe(false);
  });

  it('refuses another purpose and a payload of the wrong shape even when signed', () => {
    for (const bad of [
      { purpose: 'meeting_audio' },
      { meetingId: 'not-a-uuid' },
      { aal: 'aal3' },
      { mfaAt: 'now' },
      { exp: 'soon' },
      { exp: 1.5 },
    ]) {
      expect(verifyMediaTicket(signMediaTicket(KEY, payload(bad as unknown as Partial<MediaTicketPayload>)), KEY, NOW), JSON.stringify(bad)).toBeNull();
    }
    // Signed JSON that is not an object, and an object missing fields.
    const signRaw = (value: unknown) => {
      const signed = `v2.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
      return `${signed}.${createHmac('sha256', KEY).update(signed).digest().toString('base64url')}`;
    };
    for (const value of [null, 7, 'x', [], {}, { keyId: 'k1' }]) expect(verifyMediaTicket(signRaw(value), KEY, NOW)).toBeNull();
  });

  it('refuses malformed forms before any key is derived', () => {
    const good = signMediaTicket(KEY, payload());
    const [, body, mac] = good.split('.') as [string, string, string];
    for (const bad of [
      '',
      'v1',
      'v2.',
      'v2..',
      // The version before the canonical rule: refused, so the player asks for a new ticket.
      `v1.${body}.${mac}`,
      `${body}.${mac}`,
      `v2.${body}`,
      `v2.${body}.${mac}.extra`,
      `v2.${body}.${mac.slice(1)}`,
      `v2.${body}.${mac}A`,
      `v2.${body}!.${mac}`,
      `v2.${'A'.repeat(2000)}.${mac}`,
      'v2.e30.' + 'A'.repeat(43),
      `v2.bm90LWpzb24.${mac}`,
    ]) {
      expect(verifyMediaTicket(bad, KEY, NOW), bad.slice(0, 30)).toBeNull();
    }
    for (const bad of [undefined, null, 7, '', 'v1', `v2.${body}`, 'x'.repeat(5000)]) expect(wellFormedMediaTicket(bad)).toBe(false);
    expect(peekMediaTicketKeyId('garbage')).toBeNull();
  });
});

describe('CORS on the ticket stream', () => {
  it('gets no CORS header for an allowed origin, while another route of the same API does', async () => {
    const app = new Hono();
    app.use('*', corsMiddleware(['https://app.example.com']));
    app.get('/api/meetings/:id/video/stream', (c) => c.text('v'));
    app.get('/api/meetings/:id/video', (c) => c.text('v'));
    const headers = { origin: 'https://app.example.com' };
    const stream = await app.request('/api/meetings/abc/video/stream?ticket=x', { headers });
    expect([...stream.headers.keys()].filter((k) => k.startsWith('access-control-') || k === 'vary')).toEqual([]);
    const other = await app.request('/api/meetings/abc/video', { headers });
    expect(other.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
  });
});

describe('one ticket, one spelling (#2965)', () => {
  const sign = (text: string) => {
    const signed = `v2.${Buffer.from(text, 'utf8').toString('base64url')}`;
    return `${signed}.${createHmac('sha256', KEY).update(signed).digest().toString('base64url')}`;
  };
  const canonical = (p: MediaTicketPayload) =>
    JSON.stringify({ keyId: p.keyId, orgId: p.orgId, userId: p.userId, sessionId: p.sessionId, aal: p.aal, mfaAt: p.mfaAt, meetingId: p.meetingId, fileId: p.fileId, purpose: p.purpose, iat: p.iat, exp: p.exp });

  it('signs the payload in one field order whatever order the caller built it in', () => {
    const a = payload();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as unknown as MediaTicketPayload;
    expect(signMediaTicket(KEY, reordered)).toBe(signMediaTicket(KEY, a));
    expect(verifyMediaTicket(signMediaTicket(KEY, reordered), KEY, NOW)).toEqual(a);
  });

  it('accepts only the canonical text, even when the signature covers another: extra, repeated, reordered and spaced fields, escapes', () => {
    const p = payload();
    const text = canonical(p);
    expect(verifyMediaTicket(sign(text), KEY, NOW)).toEqual(p);
    const variants: Record<string, string> = {
      'an extra field': text.replace(/}$/, ',"extra":1}'),
      'a repeated field': text.replace(/}$/, `,"exp":${p.exp}}`),
      'a repeated field with another value first': `{"exp":${p.exp + 1},${text.slice(1)}`,
      'reordered fields': JSON.stringify({ exp: p.exp, ...JSON.parse(text) }),
      'a space': `${text.slice(0, text.indexOf(',') + 1)} ${text.slice(text.indexOf(',') + 1)}`,
      'a newline': `${text}\n`,
      'an escaped letter': `{"\\u006beyId"${text.slice('{"keyId"'.length)}`,
      'an escaped slash in a value': `${text.slice(0, text.indexOf(p.keyId))}${p.keyId.slice(0, -1)}\\${p.keyId.slice(-1)}${text.slice(text.indexOf(p.keyId) + p.keyId.length)}`,
    };
    for (const [name, value] of Object.entries(variants)) expect(verifyMediaTicket(sign(value), KEY, NOW), name).toBeNull();
  });

  it('refuses every other spelling of the signature: the four values of the unused low bits of its last character', () => {
    const good = signMediaTicket(KEY, payload());
    const [version, body, mac] = good.split('.') as [string, string, string];
    expect(mac).toHaveLength(43);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    // The last character holds 4 bits of the signature and 2 that decode to nothing: 4 characters share the same bytes.
    const last = alphabet.indexOf(mac.slice(-1));
    const sameBytes = [0, 1, 2, 3].map((low) => alphabet[(last & ~3) | low]!);
    expect(sameBytes).toContain(mac.slice(-1));
    for (const c of sameBytes) {
      const spelled = `${version}.${body}.${mac.slice(0, -1)}${c}`;
      expect(Buffer.from(spelled.split('.')[2]!, 'base64url').equals(Buffer.from(mac, 'base64url'))).toBe(true);
      expect(verifyMediaTicket(spelled, KEY, NOW) !== null, `${c}`).toBe(c === mac.slice(-1));
    }
  });

  it('refuses another spelling of the body, even re-signed', () => {
    const text = canonical(payload());
    const body = Buffer.from(text, 'utf8').toString('base64url');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(body.slice(-1));
    const spare = body.length % 4 === 0 ? 0 : body.length % 4 === 2 ? 4 : 2;
    if (spare === 0) return;
    const mask = (1 << (spare === 4 ? 4 : 2)) - 1;
    for (let low = 0; low <= mask; low += 1) {
      const c = alphabet[(last & ~mask) | low]!;
      const respelled = `${body.slice(0, -1)}${c}`;
      const signed = `v2.${respelled}`;
      const ticket = `${signed}.${createHmac('sha256', KEY).update(signed).digest().toString('base64url')}`;
      expect(verifyMediaTicket(ticket, KEY, NOW) !== null, `${c}`).toBe(c === body.slice(-1));
    }
  });

  it('refuses a version 1 ticket', () => {
    const body = Buffer.from(canonical(payload()), 'utf8').toString('base64url');
    const signed = `v1.${body}`;
    expect(verifyMediaTicket(`${signed}.${createHmac('sha256', KEY).update(signed).digest().toString('base64url')}`, KEY, NOW)).toBeNull();
  });
});

