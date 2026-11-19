// SPDX-License-Identifier: AGPL-3.0-only
// Zoom's signed webhook, the pure parts (meetings integrations C3, #3175): the signature over `v0:{timestamp}:{body}`, the answer to the URL validation challenge and the reading of a notice. No network, no
// state. The one that matters most is the signing oracle: a challenge whose plainToken has the shape of a signed message gets no HMAC back, because that HMAC would be a valid signature for it.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ZOOM_MAX_NOTICE_BYTES, ZOOM_TIMESTAMP_WINDOW_MS, ZoomNoticeError, parseZoomNotice, zoomSignatureOk, zoomValidationAnswer } from '../src/index.ts';

const SECRET = 'zoom-secret-token-not-real-0001';
const PREVIOUS = 'zoom-secret-token-old-not-real-0002';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const TS = String(Math.floor(NOW / 1000));
const body = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const sign = (bytes: Uint8Array, timestamp: string, secret = SECRET) => `v0=${createHmac('sha256', secret).update(Buffer.concat([Buffer.from(`v0:${timestamp}:`), Buffer.from(bytes)])).digest('hex')}`;
const RECORDING = { event: 'recording.completed', event_ts: 1731931200000, payload: { account_id: 'acc', object: { uuid: 'uuid-1', host_id: 'KdYKjnimT4KPd8FFgQt9FQ', topic: 'Họp', download_token: 'never-read' } } };
const check = (bytes: Uint8Array, over: Partial<Parameters<typeof zoomSignatureOk>[0]> = {}) => zoomSignatureOk({ body: bytes, signature: sign(bytes, TS), timestamp: TS, secret: SECRET, nowMs: NOW, ...over });

describe('zoomSignatureOk', () => {
  it('accepts the signature of the exact bytes, with the current secret or the previous one', () => {
    const bytes = body(RECORDING);
    expect(check(bytes)).toBe(true);
    expect(check(bytes, { signature: sign(bytes, TS, PREVIOUS), secretPrevious: PREVIOUS })).toBe(true);
    // The previous secret is taken only when it is configured.
    expect(check(bytes, { signature: sign(bytes, TS, PREVIOUS) })).toBe(false);
  });

  it('refuses a missing, malformed, wrong or tampered signature, and one for another body, timestamp or secret', () => {
    const bytes = body(RECORDING);
    for (const signature of [undefined, '', 'v0=', 'v0=zz', `v1=${sign(bytes, TS).slice(3)}`, sign(bytes, TS).slice(3), `${sign(bytes, TS)}00`, sign(bytes, TS).toUpperCase().replace('V0=', 'v1=')]) expect(check(bytes, { signature }), String(signature)).toBe(false);
    expect(check(bytes, { signature: sign(body({ ...RECORDING, event: 'other' }), TS) })).toBe(false);
    expect(check(bytes, { signature: sign(bytes, String(Number(TS) + 1)) })).toBe(false);
    expect(check(bytes, { signature: sign(bytes, TS, 'another-secret-0123456789') })).toBe(false);
    expect(check(bytes, { secret: '' })).toBe(false);
    // A tampered body under a signature that was right for the original.
    expect(check(body({ ...RECORDING, payload: { object: { host_id: 'someone-else' } } }), { signature: sign(bytes, TS) })).toBe(false);
  });

  it('refuses a missing, malformed or out-of-window timestamp even when the signature is right for it', () => {
    const bytes = body(RECORDING);
    for (const timestamp of [undefined, '', 'abc', '-5', '1.5', '12345678901234', ` ${TS}x`]) expect(check(bytes, { timestamp, signature: sign(bytes, String(timestamp)) }), String(timestamp)).toBe(false);
    const at = (offsetMs: number) => String(Math.floor((NOW + offsetMs) / 1000));
    for (const offset of [ZOOM_TIMESTAMP_WINDOW_MS - 1000, -(ZOOM_TIMESTAMP_WINDOW_MS - 1000)]) expect(check(bytes, { timestamp: at(offset), signature: sign(bytes, at(offset)) }), String(offset)).toBe(true);
    for (const offset of [ZOOM_TIMESTAMP_WINDOW_MS + 2000, -(ZOOM_TIMESTAMP_WINDOW_MS + 2000), 86_400_000]) expect(check(bytes, { timestamp: at(offset), signature: sign(bytes, at(offset)) }), String(offset)).toBe(false);
  });

  it('reads a timestamp in milliseconds as such, so a sender that uses them is not refused, within the same window', () => {
    const bytes = body(RECORDING);
    const ms = String(NOW);
    expect(check(bytes, { timestamp: ms, signature: sign(bytes, ms) })).toBe(true);
    const old = String(NOW - ZOOM_TIMESTAMP_WINDOW_MS - 2000);
    expect(check(bytes, { timestamp: old, signature: sign(bytes, old) })).toBe(false);
  });

  it('signs the raw bytes, not a re-encoding of them', () => {
    const raw = new TextEncoder().encode('{"event":"recording.completed",  "payload":{"object":{"host_id":"a"}},\n"event_ts":1}');
    expect(check(raw)).toBe(true);
    expect(check(new TextEncoder().encode(JSON.stringify(JSON.parse(new TextDecoder().decode(raw)))), { signature: sign(raw, TS) })).toBe(false);
  });
});

describe('zoomValidationAnswer (the URL validation challenge)', () => {
  it('answers a plainToken of a safe shape with the hex HMAC-SHA256 of it under the secret', () => {
    const answer = zoomValidationAnswer(SECRET, 'challenge-token-0001');
    expect(answer).toEqual({ plainToken: 'challenge-token-0001', encryptedToken: createHmac('sha256', SECRET).update('challenge-token-0001').digest('hex') });
    expect(zoomValidationAnswer(SECRET, 'a'.repeat(128))).not.toBeNull();
    expect(zoomValidationAnswer(SECRET, 'a-b_C9')).not.toBeNull();
  });

  it('gives no HMAC for a plainToken shaped like a signed message, so the route is no signing oracle (PO test)', () => {
    const bytes = body(RECORDING);
    const message = `v0:${TS}:${new TextDecoder().decode(bytes)}`;
    // The HMAC of this plainToken would be exactly the signature Zoom puts on that body.
    expect(createHmac('sha256', SECRET).update(message).digest('hex')).toBe(sign(bytes, TS).slice(3));
    expect(zoomValidationAnswer(SECRET, message)).toBeNull();
    for (const shaped of [`v0:${TS}:{}`, 'v0:1:', 'v0:abc', 'a:b', ' ', '', 'x'.repeat(129), 'with space', 'tab\t', 'new\nline', 'ü', '../etc', 'a.b', 'a+b', 'a=']) expect(zoomValidationAnswer(SECRET, shaped), JSON.stringify(shaped)).toBeNull();
    for (const notAString of [undefined, null, 5, {}, [], ['a']]) expect(zoomValidationAnswer(SECRET, notAString)).toBeNull();
    expect(zoomValidationAnswer('', 'abc')).toBeNull();
  });
});

describe('parseZoomNotice', () => {
  it('reads a validation challenge, and a finished recording down to the host id (lower case), the instance and the event time, and nothing else', () => {
    expect(parseZoomNotice(body({ event: 'endpoint.url_validation', payload: { plainToken: 'abc' } }))).toEqual({ kind: 'validation', plainToken: 'abc' });
    expect(parseZoomNotice(body(RECORDING))).toEqual({ kind: 'recording', event: 'recording.completed', hostId: 'kdykjnimt4kpd8ffgqt9fq', uuid: 'uuid-1', eventTs: '1731931200000' });
    expect(parseZoomNotice(body({ ...RECORDING, event: 'recording.transcript_completed' }))).toMatchObject({ kind: 'recording', event: 'recording.transcript_completed' });
    // The download address and token, the email and the topic are not in what it hands on.
    expect(JSON.stringify(parseZoomNotice(body(RECORDING)))).not.toMatch(/never-read|topic|Họp|download/);
  });

  it('ignores other events and a recording notice without a usable host id, and refuses a body that is no notice', () => {
    expect(parseZoomNotice(body({ event: 'meeting.ended', payload: {} }))).toEqual({ kind: 'ignored' });
    for (const host of [undefined, '', 5, 'a b', 'a/b', 'x'.repeat(201), 'üser']) expect(parseZoomNotice(body({ ...RECORDING, payload: { object: { host_id: host } } })), String(host)).toEqual({ kind: 'ignored' });
    for (const bad of [new Uint8Array(), new TextEncoder().encode('not json'), new TextEncoder().encode('[]'), new TextEncoder().encode('{"event":5}'), new TextEncoder().encode('null'), new Uint8Array(ZOOM_MAX_NOTICE_BYTES + 1)]) expect(() => parseZoomNotice(bad)).toThrow(ZoomNoticeError);
  });
});
