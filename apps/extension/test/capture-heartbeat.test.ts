// SPDX-License-Identifier: AGPL-3.0-only
// One meeting, one live capture, on the extension's side (ADR-0055 slice 1, #4123): the tab's address goes to the server as a hint, the heartbeat and its end are one route, the refusal of a second capture of a call
// says which kind of client holds it and since when, and none of it is ever a reason to stop a recording.
import { describe, expect, it } from 'vitest';
import { createClient, LudyError } from '../src/api.ts';
import { heldOf } from '../src/capture-run.ts';
import { parseCaptureStart, parseStartRequest, tabAddress } from '../src/messages.ts';
import { ENGLISH, VIETNAMESE } from '../src/strings.ts';

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const MEETING = '0195f2b0-0000-7000-8000-000000000001';
const BASE = { title: 'Họp tuần', consentMethod: 'told_at_start', consentAgreed: true, keepVideo: false, liveNotes: false, streamId: 'stream-1' };

describe('the client', () => {
  it('sends the heartbeat and its end to the one route and reads the answer; an unreadable answer is not open', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = createClient('https://ludy.example', 'crx_token', async (url, init) => (calls.push({ url, body: JSON.parse(String(init?.body)) }), answer({ json: { open: true } })));
    expect(await client.captureHeartbeat({ meetingId: MEETING })).toEqual({ open: true });
    expect(await client.captureHeartbeat({ meetingId: MEETING, end: true })).toEqual({ open: true });
    expect(calls.map((c) => c.url)).toEqual(['https://ludy.example/api/rpc/meetings/captureHeartbeat', 'https://ludy.example/api/rpc/meetings/captureHeartbeat']);
    expect(calls[0]?.body).toEqual({ json: { meetingId: MEETING } });
    expect(calls[1]?.body).toEqual({ json: { meetingId: MEETING, end: true } });
    expect(await createClient('https://ludy.example', 'crx_token', async () => answer({ json: { open: 'yes' } })).captureHeartbeat({ meetingId: MEETING })).toEqual({ open: false });
  });

  it('puts the tab address in the create call only when there is one, under capture', async () => {
    const bodies: unknown[] = [];
    const client = createClient('https://ludy.example', 'crx_token', async (_url, init) => (bodies.push(JSON.parse(String(init?.body))), answer({ json: { meetingId: MEETING } })));
    const create = { title: 'Họp', keepVideo: false, consentMethod: 'told_at_start' as const, liveNotes: false };
    await client.createMeeting(create);
    await client.createMeeting({ ...create, joinUrl: 'https://meet.google.com/abc-defg-hij' });
    expect((bodies[0] as { json: Record<string, unknown> }).json).not.toHaveProperty('capture');
    expect((bodies[1] as { json: { capture: unknown } }).json.capture).toEqual({ joinUrl: 'https://meet.google.com/abc-defg-hij' });
  });

  it('reads a refusal in the route form and in the RPC wire form, with its details', async () => {
    const wire = { json: { defined: false, code: 'CAPTURE_ALREADY_RUNNING', status: 409, message: 'This meeting is already being recorded', data: { kind: 'app', since: '2027-01-20T07:02:00.000Z' } } };
    const client = createClient('https://ludy.example', 'crx_token', async () => answer(wire, 409));
    const error = await client.createMeeting({ title: 'Họp', keepVideo: false, consentMethod: 'told_at_start', liveNotes: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LudyError);
    expect(error).toMatchObject({ code: 'CAPTURE_ALREADY_RUNNING', status: 409 });
    expect((error as LudyError).details).toEqual({ kind: 'app', since: '2027-01-20T07:02:00.000Z' });
    const plain = await createClient('https://ludy.example', 'crx_token', async () => answer({ code: 'CONSENT_METHOD_NOT_ALLOWED', message: 'written only' }, 422))
      .createMeeting({ title: 'Họp', keepVideo: false, consentMethod: 'told_at_start', liveNotes: false })
      .catch((e: unknown) => e);
    expect(plain).toMatchObject({ code: 'CONSENT_METHOD_NOT_ALLOWED', status: 422 });
  });
});

describe('heldOf', () => {
  it('reads the kind and the time of the capture that holds the call, and nothing else', () => {
    expect(heldOf({ kind: 'extension', since: '2027-01-20T07:02:00.000Z' })).toEqual({ kind: 'extension', since: '2027-01-20T07:02:00.000Z' });
    expect(heldOf({ kind: 'app', since: '2027-01-20T07:02:00.000Z', userId: 'u1' })).toEqual({ kind: 'app', since: '2027-01-20T07:02:00.000Z' });
    for (const odd of [null, undefined, 'x', {}, { kind: 'bot', since: 'x' }, { kind: 'app' }, { kind: 'app', since: '' }, { kind: 'app', since: 5 }, { kind: 'app', since: 'not a time' }]) expect(heldOf(odd), JSON.stringify(odd)).toBeNull();
  });
});

describe('the start messages', () => {
  it('carry the tab address as a short string, and leave anything else out without refusing the start', () => {
    expect(parseStartRequest({ ...BASE, joinUrl: 'https://zoom.us/j/81234567890' })).toEqual({ ...BASE, joinUrl: 'https://zoom.us/j/81234567890' });
    for (const odd of [5, '', 'x'.repeat(501), null, {}, 'http://meet.google.com/abc-defg-hij', 'https://user:pw@zoom.us/j/81234567890', 'not an address']) expect(parseStartRequest({ ...BASE, joinUrl: odd }), JSON.stringify(odd)).toEqual(BASE);
    expect(parseStartRequest(BASE)).toEqual(BASE);
  });

  it('keep only the host and the path of the tab address: no passcode, no context, no fragment', () => {
    expect(tabAddress('https://us02web.zoom.us/j/81234567890?pwd=SecretPasscode123&from=addon#frag')).toBe('https://us02web.zoom.us/j/81234567890');
    expect(tabAddress(`https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=${'x'.repeat(900)}`)).toBe('https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0');
    expect(parseStartRequest({ ...BASE, joinUrl: 'https://zoom.us/j/81234567890?pwd=Secret' })?.joinUrl).toBe('https://zoom.us/j/81234567890');
    expect(parseCaptureStart({ target: 'offscreen', type: 'capture-start', address: 'https://app.ludy.vn', token: 'crx_t', orgId: 'org', uploads: 'direct', ...BASE, joinUrl: 'https://meet.google.com/abc-defg-hij?authuser=1' })?.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
    for (const odd of [undefined, null, 7, '', 'http://zoom.us/j/81234567890', 'chrome://extensions', 'x'.repeat(10)]) expect(tabAddress(odd), String(odd)).toBeUndefined();
  });

  it('pass it on to the offscreen document, which checks it the same way', () => {
    const command = { target: 'offscreen', type: 'capture-start', address: 'https://app.ludy.vn', token: 'crx_t', orgId: 'org', uploads: 'direct', ...BASE };
    expect(parseCaptureStart({ ...command, joinUrl: 'https://meet.google.com/abc-defg-hij' })?.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
    expect(parseCaptureStart({ ...command, joinUrl: 7 })).not.toHaveProperty('joinUrl');
  });
});

describe('the refusal in words', () => {
  it('says which kind of client holds the call and since when, in both languages, with no person', () => {
    for (const strings of [ENGLISH, VIETNAMESE]) {
      expect(strings.blockers.captureRunning).toContain('{kind}');
      expect(strings.blockers.captureRunning).toContain('{time}');
      // The refusal whose details could not be read says it without a placeholder in sight.
      expect(strings.blockers.captureRunningUnknown).not.toMatch(/[{}]/);
      expect(Object.keys(strings.captureKinds).sort()).toEqual(['app', 'extension']);
    }
    expect(VIETNAMESE.blockers.captureRunning.replace('{kind}', VIETNAMESE.captureKinds.app).replace('{time}', '14:02')).toBe('Ứng dụng Ludy đang ghi cuộc họp này từ 14:02. Hãy dùng bản ghi đó, hoặc dừng nó trước khi ghi lại.');
  });
});
