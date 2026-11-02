// SPDX-License-Identifier: AGPL-3.0-only
// A Google Meet made with a booking's event (C7, #1375) against recorded answers (shapes from Google's Calendar API: events.insert with conferenceDataVersion=1
// and a conferenceData.createRequest of the type hangoutsMeet); no live call. The Meet is made in the same call that writes the event, asked once by a request
// named after the event's id; the answer's join link is the result, only ever a meet.google.com address; Google refusing the conference leaves the event written
// without one.
import { describe, expect, it } from 'vitest';
import { GoogleCalendarAdapter, type Fetch } from '../src/index.ts';

const APP = { clientId: '123456789-testclientid0001.apps.googleusercontent.com', clientSecret: 'test-google-secret-not-real' };
const SECRET = JSON.stringify({ accessToken: 'ya29.token-1', refreshToken: '1//refresh-1' });
const EVENT = { externalId: 'abcde0123456789abcde0123456789abcde01234567890123456', summary: 'Tư vấn: Lan', startsAt: '2026-11-04T02:00:00.000Z', endsAt: '2026-11-04T03:00:00.000Z' };
const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const MEET = 'https://meet.google.com/abc-defg-hij';

interface Answer {
  status?: number;
  body: unknown;
}
// Answers in order for each "METHOD path"; remembers the whole URL and body of every call.
function google(routes: Record<string, Answer[]>) {
  const calls: Array<{ route: string; url: string; body: Record<string, unknown> | undefined }> = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(input);
    const route = `${init?.method ?? 'GET'} ${url.origin}${url.pathname}`;
    calls.push({ route, url: input, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    const answer = routes[route]?.shift() ?? { status: 500, body: { error: { code: 500, message: `no answer for ${route}`, status: 'INTERNAL' } } };
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}
const adapterOf = (fetchImpl: Fetch, sleeps: number[] = []) => new GoogleCalendarAdapter(APP, fetchImpl, { sleep: async (ms) => void sleeps.push(ms) });
const POST = `POST ${BASE}`;
const ITEM = `${BASE}/${EVENT.externalId}`;
const conferenceOf = (call: { body: Record<string, unknown> | undefined } | undefined) => (call?.body?.conferenceData as { createRequest?: { requestId?: string; conferenceSolutionKey?: { type?: string } } } | undefined)?.createRequest;
const exists = { status: 409, body: { error: { code: 409, message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } } };

describe('GoogleCalendarAdapter, a Google Meet with the event', () => {
  it('asks for the conference in the insert (version 1, a hangoutsMeet request named after the event) and gives back the join link', async () => {
    const { fetchImpl, calls } = google({ [POST]: [{ body: { id: EVENT.externalId, hangoutLink: MEET, conferenceData: { createRequest: { status: { statusCode: 'success' } } } } }] });
    expect(await adapterOf(fetchImpl).writeEvent(SECRET, { ...EVENT, conference: true })).toEqual({ ok: true, meetUrl: MEET });
    expect(new URL(calls[0]?.url ?? '').searchParams.get('conferenceDataVersion')).toBe('1');
    expect(conferenceOf(calls[0])).toEqual({ requestId: EVENT.externalId, conferenceSolutionKey: { type: 'hangoutsMeet' } });
    // Nothing else of the booking goes with it: the title and the instants, private and opaque.
    expect(calls[0]?.body).toMatchObject({ id: EVENT.externalId, summary: 'Tư vấn: Lan', visibility: 'private', transparency: 'opaque' });
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/attendees|description|email/);
  });

  it('makes no conference, and sends no conference version, for an event that did not ask for one', async () => {
    const { fetchImpl, calls } = google({ [POST]: [{ body: { id: EVENT.externalId } }] });
    expect(await adapterOf(fetchImpl).writeEvent(SECRET, EVENT)).toEqual({ ok: true });
    expect(new URL(calls[0]?.url ?? '').searchParams.has('conferenceDataVersion')).toBe(false);
    expect(calls[0]?.body).not.toHaveProperty('conferenceData');
  });

  it('reads the link from the video entry point when there is no hangoutLink, and takes no other address for a Meet', async () => {
    const entry = (uri: string) => ({ body: { conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+84123456789' }, { entryPointType: 'video', uri }] } } });
    const run = (answer: Answer) => adapterOf(google({ [POST]: [answer] }).fetchImpl).writeEvent(SECRET, { ...EVENT, conference: true });
    expect(await run(entry(MEET))).toEqual({ ok: true, meetUrl: MEET });
    // An address that is not a Meet (another host, plain http, a path with more in it) is no link: the event stands without one.
    for (const uri of ['https://evil.example/abc-defg-hij', 'http://meet.google.com/abc-defg-hij', 'https://meet.google.com/abc-defg-hij?authuser=2', 'https://meet.google.com.evil.example/abc-defg-hij']) {
      expect(await run(entry(uri)), uri).toEqual({ ok: true, meetUrl: null });
    }
    expect(await run({ body: { hangoutLink: 'javascript:alert(1)' } })).toEqual({ ok: true, meetUrl: null });
  });

  it('looks again at a request Google has not finished, a couple of times, and gives the link once it is there', async () => {
    const pending = { body: { conferenceData: { createRequest: { status: { statusCode: 'pending' } } } } };
    const sleeps: number[] = [];
    const { fetchImpl, calls } = google({ [POST]: [pending], [`GET ${ITEM}`]: [pending, { body: { hangoutLink: MEET } }] });
    expect(await adapterOf(fetchImpl, sleeps).writeEvent(SECRET, { ...EVENT, conference: true })).toEqual({ ok: true, meetUrl: MEET });
    expect(calls.map((c) => c.route)).toEqual([POST, `GET ${ITEM}`, `GET ${ITEM}`]);
    expect(sleeps).toHaveLength(2);
    // Still pending after the looks: written without a link, so the booking goes on with its fixed link.
    const stuck = google({ [POST]: [pending], [`GET ${ITEM}`]: [pending, pending] });
    expect(await adapterOf(stuck.fetchImpl).writeEvent(SECRET, { ...EVENT, conference: true })).toEqual({ ok: true, meetUrl: null });
  });

  it('on an event Google already has, changes it and reads the link from the answer, asking for the same request again', async () => {
    const { fetchImpl, calls } = google({ [POST]: [exists], [`PATCH ${ITEM}`]: [{ body: { id: EVENT.externalId, hangoutLink: MEET } }] });
    expect(await adapterOf(fetchImpl).writeEvent(SECRET, { ...EVENT, conference: true })).toEqual({ ok: true, meetUrl: MEET });
    expect(conferenceOf(calls[1])?.requestId).toBe(EVENT.externalId);
    expect(new URL(calls[1]?.url ?? '').searchParams.get('conferenceDataVersion')).toBe('1');
    expect(calls[1]?.body).toMatchObject({ status: 'confirmed' });
  });

  it('writes the event without a conference when Google will not make one (an account that cannot host Meet), and says there is no link', async () => {
    const refused = { status: 400, body: { error: { code: 400, message: 'Invalid conference type value.', errors: [{ reason: 'invalid' }] } } };
    const { fetchImpl, calls } = google({ [POST]: [refused, { body: { id: EVENT.externalId } }] });
    expect(await adapterOf(fetchImpl).writeEvent(SECRET, { ...EVENT, conference: true })).toEqual({ ok: true, meetUrl: null });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).not.toHaveProperty('conferenceData');
    // When the plain write fails too, that failure is the answer.
    const both = google({ [POST]: [refused, { status: 503, body: { error: { code: 503, message: 'x', status: 'UNAVAILABLE' } } }] });
    expect(await adapterOf(both.fetchImpl).writeEvent(SECRET, { ...EVENT, conference: true })).toEqual({ failed: 'UNAVAILABLE', transient: true });
  });

  it('answers a refused token, a missing permission and an outage of a conference write as it does for any write, with no link', async () => {
    const run = (answer: Answer) => adapterOf(google({ [POST]: [answer] }).fetchImpl).writeEvent(SECRET, { ...EVENT, conference: true });
    expect(await run({ status: 401, body: { error: { code: 401, message: 'Invalid Credentials' } } })).toEqual({ refused: 'invalid_token' });
    expect(await run({ status: 403, body: { error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] } } })).toEqual({ scope: true });
    expect(await run({ status: 429, body: { error: { code: 429, message: 'x' } } })).toEqual({ failed: '429', transient: true });
  });
});
