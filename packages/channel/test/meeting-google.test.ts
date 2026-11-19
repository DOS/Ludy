// SPDX-License-Identifier: AGPL-3.0-only
// The Google Meet adapter, transcript only (meetings integrations C2, #3174). No Google call is ever made: a fake fetch answers with JSON in the shapes of Google's Meet REST API v2 reference
// (conferenceRecords, transcripts, participants, transcriptEntries), and the test fails on any other host, any other method and any request without the bearer token.
import { afterEach, describe, expect, it } from 'vitest';
import {
  GOOGLE_MEET_HOSTS,
  GOOGLE_MEET_SPACE_READ_SCOPE,
  GOOGLE_MEET_TRANSCRIPT_MAX_ENTRIES,
  GoogleMeetAdapter,
  MeetingPlatformError,
  type MeetingPlatformCredential,
} from '../src/index.ts';

const CREDENTIAL: MeetingPlatformCredential = { accessToken: 'meet-access-token-not-real-0001', refreshToken: 'meet-refresh-token-not-real-0001' };
const SINCE = new Date('2026-11-04T00:00:00Z');
const T = (minutes: number) => new Date(Date.parse('2026-11-17T02:00:00Z') + minutes * 60_000).toISOString();

interface Route {
  status?: number;
  body: unknown;
}
// What the fake saw that Google would refuse (another host, another method, no bearer token, a path it has no route for). An assertion inside the fake would be caught by the adapter's own try/catch and
// look like a platform error, so a wrong request is recorded here and every test fails on it afterwards.
const violations: string[] = [];
afterEach(() => {
  const found = violations.splice(0);
  expect(found).toEqual([]);
});

// A fake Google: routes by path (the part after /v2/), recording every request it sees.
function google(routes: Record<string, Route | ((url: URL) => Route)>) {
  const seen: { url: URL; init: RequestInit | undefined }[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    seen.push({ url, init });
    if (url.hostname !== 'meet.googleapis.com') violations.push(`host ${url.hostname}`);
    if ((init?.method ?? 'GET') !== 'GET') violations.push(`method ${init?.method}`);
    if ((init?.headers as Record<string, string> | undefined)?.authorization !== `Bearer ${CREDENTIAL.accessToken}`) violations.push('no bearer token');
    const key = url.pathname.replace(/^\/v2\//, '');
    const route = routes[key];
    if (route === undefined) {
      violations.push(`no route for ${key}`);
      return new Response('{}', { status: 500 });
    }
    const { status = 200, body } = typeof route === 'function' ? route(url) : route;
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}

const refresher = {
  async refresh(secret: string) {
    const s = JSON.parse(secret) as { accessToken: string; refreshToken: string };
    return { secret: JSON.stringify({ accessToken: `${s.accessToken}-renewed`, refreshToken: s.refreshToken }), expiresAt: new Date('2026-11-17T03:00:00Z') };
  },
};
const adapterOver = (routes: Parameters<typeof google>[0]) => {
  const fake = google(routes);
  return { adapter: new GoogleMeetAdapter({ refresher, fetch: fake.fetch }), ...fake };
};

const RECORDS = {
  conferenceRecords: [
    { name: 'conferenceRecords/aaa111', startTime: T(0), endTime: T(30), expireTime: T(60 * 24 * 30), space: 'spaces/s1' },
    { name: 'conferenceRecords/bbb222', startTime: T(-120), endTime: T(-90), space: 'spaces/s2' },
    // Still running: no end time, never listed.
    { name: 'conferenceRecords/ccc333', startTime: T(40), space: 'spaces/s3' },
    // A name that is not a record name is dropped.
    { name: 'conferenceRecords/../../x', startTime: T(-300), endTime: T(-280) },
  ],
};

describe('GoogleMeetAdapter list', () => {
  it('lists the finished conferences that have a finished transcript, as transcript-only recordings, newest first', async () => {
    const { adapter, seen } = adapterOver({
      conferenceRecords: { body: RECORDS },
      'conferenceRecords/aaa111/transcripts': { body: { transcripts: [{ name: 'conferenceRecords/aaa111/transcripts/ttt1', state: 'FILE_GENERATED', startTime: T(1), endTime: T(29) }] } },
      // Still being written: not importable yet.
      'conferenceRecords/bbb222/transcripts': { body: { transcripts: [{ name: 'conferenceRecords/bbb222/transcripts/ttt2', state: 'STARTED' }] } },
    });
    expect(await adapter.list(CREDENTIAL, SINCE)).toEqual([
      { id: 'conferenceRecords/aaa111/transcripts/ttt1', title: 'Google Meet', startedAt: T(0), lengthSeconds: 1800, sizeBytes: null, hasAudio: false, hasVideo: false, hasTranscript: true },
    ]);
    // The window goes to Google as a filter on the start time, 100 per page.
    const first = seen[0]!.url;
    expect(first.searchParams.get('filter')).toBe(`start_time>="${SINCE.toISOString()}"`);
    expect(first.searchParams.get('pageSize')).toBe('100');
    // A conference that has not ended and a malformed name cost no transcript lookup.
    expect(seen.map((s) => s.url.pathname)).not.toContain('/v2/conferenceRecords/ccc333/transcripts');
    expect(seen.every((s) => s.url.hostname === 'meet.googleapis.com')).toBe(true);
  });

  it('follows the page token of the conference list', async () => {
    const { adapter, seen } = adapterOver({
      conferenceRecords: (url) =>
        url.searchParams.get('pageToken') === 'p2'
          ? { body: { conferenceRecords: [{ name: 'conferenceRecords/bbb222', startTime: T(-120), endTime: T(-90) }] } }
          : { body: { conferenceRecords: [{ name: 'conferenceRecords/aaa111', startTime: T(0), endTime: T(30) }], nextPageToken: 'p2' } },
      'conferenceRecords/aaa111/transcripts': { body: { transcripts: [{ name: 'conferenceRecords/aaa111/transcripts/t1', state: 'FILE_GENERATED' }] } },
      'conferenceRecords/bbb222/transcripts': { body: { transcripts: [{ name: 'conferenceRecords/bbb222/transcripts/t2', state: 'FILE_GENERATED' }] } },
    });
    const listed = await adapter.list(CREDENTIAL, SINCE);
    expect(listed.map((r) => r.id)).toEqual(['conferenceRecords/aaa111/transcripts/t1', 'conferenceRecords/bbb222/transcripts/t2']);
    expect(seen.filter((s) => s.url.pathname === '/v2/conferenceRecords')).toHaveLength(2);
  });

  it('skips one conference whose transcripts Google no longer shows (404 or 403) and still lists the others; a 5xx or 429 on a lookup fails the listing for a later retry', async () => {
    const both = {
      conferenceRecords: {
        body: {
          conferenceRecords: [
            { name: 'conferenceRecords/aaa111', startTime: T(0), endTime: T(30) },
            { name: 'conferenceRecords/bbb222', startTime: T(-120), endTime: T(-90) },
            { name: 'conferenceRecords/ddd444', startTime: T(-240), endTime: T(-200) },
          ],
        },
      },
      'conferenceRecords/aaa111/transcripts': { body: { transcripts: [{ name: 'conferenceRecords/aaa111/transcripts/t1', state: 'FILE_GENERATED' }] } },
      'conferenceRecords/bbb222/transcripts': { status: 404, body: { error: { status: 'NOT_FOUND' } } },
      'conferenceRecords/ddd444/transcripts': { status: 403, body: { error: { status: 'PERMISSION_DENIED' } } },
    };
    expect((await adapterOver(both).adapter.list(CREDENTIAL, SINCE)).map((r) => r.id)).toEqual(['conferenceRecords/aaa111/transcripts/t1']);
    for (const status of [429, 500]) {
      const down = adapterOver({ ...both, 'conferenceRecords/bbb222/transcripts': { status, body: {} } });
      await expect(down.adapter.list(CREDENTIAL, SINCE)).rejects.toMatchObject({ code: 'platform_unavailable' });
    }
  });

  it('does not list a transcript whose name belongs to another conference', async () => {
    const { adapter } = adapterOver({
      conferenceRecords: { body: { conferenceRecords: [{ name: 'conferenceRecords/aaa111', startTime: T(0), endTime: T(30) }] } },
      'conferenceRecords/aaa111/transcripts': { body: { transcripts: [{ name: 'conferenceRecords/zzz999/transcripts/t1', state: 'FILE_GENERATED' }] } },
    });
    expect(await adapter.list(CREDENTIAL, SINCE)).toEqual([]);
  });

  it('looks at no more than three pages of conferences and lists no more than 100 recordings, with at most four lookups at once', async () => {
    let active = 0;
    let peak = 0;
    const lookups: Record<string, Route | ((url: URL) => Route)> = {};
    const names = Array.from({ length: 300 }, (_, i) => `conferenceRecords/r${i}`);
    for (const name of names) lookups[`${name}/transcripts`] = { body: { transcripts: [{ name: `${name}/transcripts/t`, state: 'FILE_GENERATED' }] } };
    const fake = google({
      conferenceRecords: (url) => {
        const page = Number(url.searchParams.get('pageToken') ?? '0');
        // A fourth page would be offered, and must never be asked for.
        return { body: { conferenceRecords: names.slice(page * 100, page * 100 + 100).map((name, i) => ({ name, startTime: T(-(page * 100 + i)), endTime: T(-(page * 100 + i) + 10) })), nextPageToken: String(page + 1) } };
      },
      ...lookups,
    });
    const adapter = new GoogleMeetAdapter({
      refresher,
      fetch: async (input, init) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        try {
          return await fake.fetch(input, init);
        } finally {
          active -= 1;
        }
      },
    });
    const listed = await adapter.list(CREDENTIAL, SINCE);
    expect(listed).toHaveLength(100);
    expect(fake.seen.filter((s) => s.url.pathname === '/v2/conferenceRecords')).toHaveLength(3);
    expect(peak).toBeLessThanOrEqual(4);
    // Newest first.
    expect(listed[0]!.id).toBe('conferenceRecords/r0/transcripts/t');
  });

  it('lists nothing for an account with no conferences, and never offers audio or video', async () => {
    const { adapter } = adapterOver({ conferenceRecords: { body: {} } });
    expect(await adapter.list(CREDENTIAL, SINCE)).toEqual([]);
    await expect(adapter.prepareDownload(CREDENTIAL, 'conferenceRecords/aaa111/transcripts/ttt1', 'audio')).rejects.toMatchObject({ code: 'platform_refused' });
    await expect(adapter.prepareDownload(CREDENTIAL, 'conferenceRecords/aaa111/transcripts/ttt1', 'video')).rejects.toMatchObject({ code: 'platform_refused' });
  });
});

describe('GoogleMeetAdapter transcript', () => {
  const NAME = 'conferenceRecords/aaa111/transcripts/ttt1';
  const routes = (entries: (url: URL) => Route) => ({
    'conferenceRecords/aaa111': { body: { name: 'conferenceRecords/aaa111', startTime: T(0), endTime: T(30) } },
    'conferenceRecords/aaa111/participants': {
      body: {
        participants: [
          { name: 'conferenceRecords/aaa111/participants/p1', signedinUser: { user: 'users/111', displayName: 'Nguyễn Văn Nam' } },
          { name: 'conferenceRecords/aaa111/participants/p2', anonymousUser: { displayName: 'Khách A' } },
          { name: 'conferenceRecords/aaa111/participants/p3', phoneUser: { displayName: '+84 90 000 0000' } },
          { name: 'conferenceRecords/aaa111/participants/p4' },
        ],
      },
    },
    [`${NAME}/entries`]: entries,
  });

  it('reads the lines in order with seconds from the start of the conference and the speakers\' names, labelled as Google\'s own transcript', async () => {
    const { adapter } = adapterOver(
      routes(() => ({
        body: {
          transcriptEntries: [
            { name: `${NAME}/entries/e1`, participant: 'conferenceRecords/aaa111/participants/p1', text: 'Chào mọi người, ta bắt đầu họp.', languageCode: 'vi', startTime: T(0.5), endTime: T(0.6) },
            { name: `${NAME}/entries/e2`, participant: 'conferenceRecords/aaa111/participants/p2', text: 'Báo giá cho khách A là 120 triệu.', languageCode: 'vi', startTime: T(1), endTime: T(1.2) },
            // No participant name: the line stays, with no speaker. A blank line and a line without a time are dropped.
            { name: `${NAME}/entries/e3`, participant: 'conferenceRecords/aaa111/participants/p4', text: 'Đồng ý.', startTime: T(2), endTime: T(2.1) },
            { name: `${NAME}/entries/e4`, participant: 'conferenceRecords/aaa111/participants/p1', text: '   ', startTime: T(3) },
            { name: `${NAME}/entries/e5`, participant: 'conferenceRecords/aaa111/participants/p1', text: 'không có giờ' },
            { name: `${NAME}/entries/e6`, participant: 'conferenceRecords/aaa111/participants/p3', text: 'Alo\u0000 nghe rõ.\u0007', startTime: T(4), endTime: T(3.9) },
          ],
        },
      })),
    );
    const transcript = await adapter.transcript(CREDENTIAL, NAME);
    expect(transcript.source).toBe('google_meet');
    expect(transcript.language).toBe('vi');
    expect(transcript.truncated).toBe(false);
    expect(transcript.entries).toEqual([
      { startSeconds: 30, endSeconds: 36, speaker: 'Nguyễn Văn Nam', text: 'Chào mọi người, ta bắt đầu họp.' },
      { startSeconds: 60, endSeconds: 72, speaker: 'Khách A', text: 'Báo giá cho khách A là 120 triệu.' },
      { startSeconds: 120, endSeconds: 126, speaker: null, text: 'Đồng ý.' },
      // Control characters are removed, an end before the start is lifted to the start.
      { startSeconds: 240, endSeconds: 240, speaker: '+84 90 000 0000', text: 'Alo nghe rõ.' },
    ]);
  });

  it('reads every page of entries and cuts a transcript longer than the cap, saying so', async () => {
    let pages = 0;
    const { adapter } = adapterOver(
      routes((url) => {
        pages += 1;
        const page = Number(url.searchParams.get('pageToken') ?? '0');
        return {
          body: {
            transcriptEntries: Array.from({ length: 100 }, (_, i) => ({ text: `line ${page * 100 + i}`, startTime: T((page * 100 + i) / 60), endTime: T((page * 100 + i) / 60) })),
            nextPageToken: String(page + 1),
          },
        };
      }),
    );
    const transcript = await adapter.transcript(CREDENTIAL, NAME);
    expect(transcript.entries).toHaveLength(GOOGLE_MEET_TRANSCRIPT_MAX_ENTRIES);
    expect(transcript.truncated).toBe(true);
    expect(pages).toBe(GOOGLE_MEET_TRANSCRIPT_MAX_ENTRIES / 100);
    expect(transcript.entries[0]!.text).toBe('line 0');
  });

  it('says truncated when blank lines used up the page budget before the line cap, and bounds a time stamped absurdly late', async () => {
    const { adapter } = adapterOver(
      routes((url) => {
        const page = Number(url.searchParams.get('pageToken') ?? '0');
        // 6 of every 100 lines are blank, so the line cap is never reached inside the page budget.
        return {
          body: {
            transcriptEntries: Array.from({ length: 100 }, (_, i) => ({ text: i < 6 ? ' ' : `line ${page}-${i}`, startTime: page === 0 && i === 6 ? '9999-12-31T23:59:59Z' : T(1), endTime: T(1) })),
            nextPageToken: String(page + 1),
          },
        };
      }),
    );
    const transcript = await adapter.transcript(CREDENTIAL, NAME);
    expect(transcript.entries.length).toBeLessThan(GOOGLE_MEET_TRANSCRIPT_MAX_ENTRIES);
    expect(transcript.truncated).toBe(true);
    // Meet stops a conference at 24 hours: a later stamp is clamped to it.
    expect(transcript.entries[0]).toMatchObject({ startSeconds: 86_400, endSeconds: 86_400 });
  });

  it('refuses a name that is not a Google Meet transcript before any call', async () => {
    const { adapter, seen } = adapterOver({});
    for (const bad of ['', 'conferenceRecords/aaa111', 'conferenceRecords/aaa111/transcripts/', '../conferenceRecords/a/transcripts/b', 'conferenceRecords/a/b/transcripts/c', 'conferenceRecords/a/transcripts/b/entries']) {
      await expect(adapter.transcript(CREDENTIAL, bad)).rejects.toMatchObject({ code: 'recording_gone' });
    }
    expect(seen).toEqual([]);
  });
});

describe('GoogleMeetAdapter errors and refresh', () => {
  it.each([
    [401, 'connection_expired'],
    [403, 'connection_expired'],
    [404, 'recording_gone'],
    [400, 'platform_refused'],
    [429, 'platform_unavailable'],
    [500, 'platform_unavailable'],
    [503, 'platform_unavailable'],
  ])('maps Google %i to %s and the error carries no token and no response body', async (status, code) => {
    const { adapter } = adapterOver({ conferenceRecords: { status, body: { error: { message: `secret detail ${CREDENTIAL.accessToken}`, status: 'X' } } } });
    const error = await adapter.list(CREDENTIAL, SINCE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MeetingPlatformError);
    expect((error as MeetingPlatformError).code).toBe(code);
    expect((error as MeetingPlatformError).message).not.toContain(CREDENTIAL.accessToken);
    expect((error as MeetingPlatformError).message).not.toContain('secret detail');
  });

  it('is platform_unavailable when Google cannot be reached or answers with something unreadable', async () => {
    const down = new GoogleMeetAdapter({ refresher, fetch: async () => Promise.reject(new Error('socket hang up with a token meet-access-token-not-real-0001')) });
    const error = await down.list(CREDENTIAL, SINCE).catch((e: unknown) => e);
    expect((error as MeetingPlatformError).code).toBe('platform_unavailable');
    expect((error as MeetingPlatformError).message).not.toContain(CREDENTIAL.accessToken);
    const garbled = new GoogleMeetAdapter({ refresher, fetch: async () => new Response('<html>', { status: 200 }) });
    await expect(garbled.list(CREDENTIAL, SINCE)).rejects.toMatchObject({ code: 'platform_unavailable' });
  });

  it('is bound to meet.googleapis.com and asks the fetch never to follow a redirect', async () => {
    expect([...GOOGLE_MEET_HOSTS]).toEqual(['meet.googleapis.com']);
    expect(new GoogleMeetAdapter({ refresher }).hosts).toEqual(['meet.googleapis.com']);
    expect(GOOGLE_MEET_SPACE_READ_SCOPE).toBe('https://www.googleapis.com/auth/meetings.space.readonly');
    // The fetch is bound to the allowlist: an adapter given a fetch sees only requests the allowlist let through, and a redirect is never followed (the bound fetch sets redirect: manual).
    let init: RequestInit | undefined;
    const adapter = new GoogleMeetAdapter({
      refresher,
      fetch: async (_url, i) => {
        init = i;
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });
    await adapter.list(CREDENTIAL, SINCE);
    expect(init?.redirect).toBe('manual');
  });

  it('renews the token through the one Google refresh, keeps the refresh token, and says refused when Google will not renew', async () => {
    const { adapter } = adapterOver({});
    expect(await adapter.refresh(CREDENTIAL)).toEqual({ accessToken: `${CREDENTIAL.accessToken}-renewed`, refreshToken: CREDENTIAL.refreshToken, expiresAt: new Date('2026-11-17T03:00:00Z') });
    expect(await adapter.refresh({ accessToken: 'x' })).toEqual({ refused: true });
    const refusing = new GoogleMeetAdapter({ refresher: { refresh: async () => ({ refused: 'invalid_grant' }) } });
    expect(await refusing.refresh(CREDENTIAL)).toEqual({ refused: true });
    const failing = new GoogleMeetAdapter({ refresher: { refresh: async () => ({ failed: 'NETWORK' }) } });
    await expect(failing.refresh(CREDENTIAL)).rejects.toMatchObject({ code: 'platform_unavailable' });
  });
});
