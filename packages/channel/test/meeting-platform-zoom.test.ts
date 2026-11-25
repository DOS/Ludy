// SPDX-License-Identifier: AGPL-3.0-only
// The Zoom adapter of the recording import (meetings integrations C3, #3175): its list, its description of a download, its token refresh and every refusal, against fixtures written from Zoom's documented
// response shapes (test/fixtures/zoom/) and a mocked transport. No test here may reach the network: the global fetch is replaced by a counter that must stay at zero.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeetingPlatformError, ZOOM_DOWNLOAD_SUFFIX, ZOOM_HOSTS, ZOOM_TRANSCRIPT_MAX_BYTES, ZoomMeetingPlatform, meetingPlatformAdapters, parseZoomNotice, parseZoomVtt, zoomAccountKey, zoomDownloadUrl, type Fetch, type MeetingPlatformCredential } from '../src/index.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/zoom/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
const CREDENTIAL: MeetingPlatformCredential = { accessToken: 'zoom-access-not-real-0001', refreshToken: 'zoom-refresh-not-real-0001' };
const APP = { clientId: 'zoom-client-id-0001', clientSecret: 'zoom-client-secret-not-real' };
const NOW = new Date('2026-11-18T12:00:00Z');
const SINCE = new Date(NOW.getTime() - 14 * 86_400_000);

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  redirect: string | undefined;
}

// A transport that answers from a script, one answer per call, and remembers each call.
function transport(answers: Array<{ status?: number; json?: unknown; text?: string } | Error>) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body as string | undefined, redirect: init?.redirect });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return new Response(answer?.text ?? JSON.stringify(answer?.json ?? {}), { status: answer?.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}
const zoom = (answers: Parameters<typeof transport>[0]) => {
  const t = transport(answers);
  return { adapter: new ZoomMeetingPlatform(APP, { fetch: t.fetchImpl, now: () => NOW }), calls: t.calls };
};

let networkCalls = 0;
beforeEach(() => {
  networkCalls = 0;
  vi.stubGlobal('fetch', () => {
    networkCalls += 1;
    throw new Error('a Zoom adapter test reached the network');
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(networkCalls).toBe(0);
});

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MeetingPlatformError);
    return (error as MeetingPlatformError).code;
  }
  throw new Error('expected a refusal');
};

describe('ZoomMeetingPlatform.list', () => {
  it('lists the recordings a person could import from the last 14 days, newest first, and nothing else', async () => {
    const { adapter, calls } = zoom([{ json: fixture('recordings-list') }]);
    const listed = await adapter.list(CREDENTIAL, SINCE);
    expect(listed.map((r) => r.id)).toEqual(['AAAAAAAAAAAAAAAAAAAAAA==', '/BBBB//BBBBBBBBBBBBBBB==', 'CCCCCCCCCCCCCCCCCCCCCC==']);
    expect(listed[0]).toEqual({
      id: 'AAAAAAAAAAAAAAAAAAAAAA==',
      title: 'Weekly sync (audio, video and transcript)',
      startedAt: '2026-11-17T02:00:00.000Z',
      lengthSeconds: 41 * 60,
      // The size of the audio file the job will fetch, not of the audio and the video together.
      sizeBytes: 4_000_000,
      hasAudio: true,
      hasVideo: true,
      hasTranscript: true,
      call: { platform: 'zoom', id: '81000000001' },
    });
    // A video-only recording, and one with a transcript only, say what they have.
    expect(listed[1]).toMatchObject({ hasAudio: false, hasVideo: true, hasTranscript: false, sizeBytes: 20_000_000, call: { platform: 'zoom', id: '81000000002' } });
    expect(listed[2]).toMatchObject({ hasAudio: false, hasVideo: false, hasTranscript: true, sizeBytes: null, call: { platform: 'zoom', id: '81000000003' } });
    // Not listed: a recording Zoom is still processing, one with only a chat and a timeline, and one before the window.
    const ids = listed.map((r) => r.id);
    for (const gone of ['DDDDDDDDDDDDDDDDDDDDDD==', 'EEEEEEEEEEEEEEEEEEEEEE==', 'FFFFFFFFFFFFFFFFFFFFFF==']) expect(ids).not.toContain(gone);
    // One call: the member's own recordings (`me`), the window, a page size, the bearer token, and only the API host.
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? '');
    expect([url.origin, url.pathname, Object.fromEntries(url.searchParams)]).toEqual(['https://api.zoom.us', '/v2/users/me/recordings', { from: '2026-11-04', to: '2026-11-18', page_size: '100' }]);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${CREDENTIAL.accessToken}`);
    expect(calls[0]?.redirect).toBe('manual');
  });

  it('follows next_page_token, reads at most five pages and returns at most 100 recordings, newest first', async () => {
    const meeting = (n: number) => ({ uuid: `u${String(n).padStart(4, '0')}`, topic: `Meeting ${n}`, start_time: new Date(NOW.getTime() - 3_600_000 - n * 60_000).toISOString(), duration: 10, recording_files: [{ id: `f${n}`, file_type: 'M4A', file_size: 1000, recording_type: 'audio_only', status: 'completed', download_url: 'https://us02web.zoom.us/rec/download/x' }] });
    const page = (from: number, token: string) => ({ json: { next_page_token: token, meetings: Array.from({ length: 50 }, (_, i) => meeting(from + i)) } });
    const { adapter, calls } = zoom([page(0, 't1'), page(50, 't2'), page(100, 't3'), page(150, 't4'), page(200, 't5'), page(250, 't6')]);
    const listed = await adapter.list(CREDENTIAL, SINCE);
    expect(calls).toHaveLength(5);
    expect(new URL(calls[1]?.url ?? '').searchParams.get('next_page_token')).toBe('t1');
    expect(new URL(calls[4]?.url ?? '').searchParams.get('next_page_token')).toBe('t4');
    expect(listed).toHaveLength(100);
    expect(listed[0]?.id).toBe('u0000');
    expect(listed[99]?.id).toBe('u0099');
  });

  it('stops at the last page, and never asks for more than the month Zoom allows', async () => {
    const { adapter, calls } = zoom([{ json: { next_page_token: '', meetings: [] } }]);
    expect(await adapter.list(CREDENTIAL, new Date('2026-01-01T00:00:00Z'))).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('from')).toBe('2026-10-19');
  });

  it('records what Zoom said as a short code, never its words or the token', async () => {
    for (const [answer, code] of [
      [{ status: 401, json: { code: 124, message: 'Invalid access token zoom-access-not-real-0001' } }, 'connection_expired'],
      [{ status: 404, json: { message: 'secret words' } }, 'recording_gone'],
      [{ status: 429, json: {} }, 'platform_unavailable'],
      [{ status: 503, json: {} }, 'platform_unavailable'],
      [{ status: 400, json: { message: 'secret words' } }, 'platform_refused'],
      [{ status: 403, json: { message: 'no scope' } }, 'platform_refused'],
      [new TypeError('fetch failed: connect ECONNREFUSED'), 'platform_unavailable'],
      [{ status: 200, text: '<html>not json</html>' }, 'platform_unavailable'],
      [{ status: 200, json: ['not', 'an', 'object'] }, 'platform_unavailable'],
    ] as const) {
      const { adapter } = zoom([answer]);
      const error = await adapter.list(CREDENTIAL, SINCE).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(MeetingPlatformError);
      expect((error as MeetingPlatformError).code).toBe(code);
      expect((error as MeetingPlatformError).message).toBe(code);
      expect(String((error as MeetingPlatformError).message)).not.toContain('zoom-access');
    }
  });

  it('does not offer a kind of file that Zoom made in several segments (a host who stopped and started recording): importing one would hand over part of the meeting', async () => {
    const file = (id: string, type: string, kind: string, size: number) => ({ id, file_type: type, file_size: size, recording_type: kind, status: 'completed', download_url: `https://us02web.zoom.us/rec/download/${id}` });
    const meeting = (uuid: string, files: unknown[]) => ({ uuid, topic: uuid, start_time: '2026-11-17T01:00:00Z', duration: 10, recording_files: files });
    const { adapter } = zoom([
      {
        json: {
          meetings: [
            // Two audio segments and one video: the audio is not offered, the video is.
            meeting('two-audio', [file('a1', 'M4A', 'audio_only', 10), file('a2', 'M4A', 'audio_only', 10), file('v1', 'MP4', 'shared_screen_with_speaker_view', 100)]),
            // Two audio segments and nothing else: not listed at all.
            meeting('only-segments', [file('a1', 'M4A', 'audio_only', 10), file('a2', 'M4A', 'audio_only', 10)]),
            // Two video segments of the preferred kind: no video is offered (a single file of a lesser kind is not taken instead); the audio still is.
            meeting('two-video', [file('a1', 'M4A', 'audio_only', 10), file('v1', 'MP4', 'shared_screen_with_speaker_view', 100), file('v2', 'MP4', 'shared_screen_with_speaker_view', 100), file('g1', 'MP4', 'gallery_view', 100)]),
            // One file of each of two video kinds: the better kind is used.
            meeting('two-kinds', [file('v1', 'MP4', 'gallery_view', 100), file('v2', 'MP4', 'active_speaker', 200)]),
          ],
        },
      },
    ]);
    const listed = await adapter.list(CREDENTIAL, SINCE);
    const by = (id: string) => listed.find((r) => r.id === id);
    expect(by('two-audio')).toMatchObject({ hasAudio: false, hasVideo: true, sizeBytes: 100 });
    expect(by('only-segments')).toBeUndefined();
    expect(by('two-video')).toMatchObject({ hasAudio: true, hasVideo: false, sizeBytes: 10 });
    expect(by('two-kinds')).toMatchObject({ hasAudio: false, hasVideo: true, sizeBytes: 200 });
    // The download of a segmented kind is refused the same way.
    const segmented = { recording_files: [file('a1', 'M4A', 'audio_only', 10), file('a2', 'M4A', 'audio_only', 10)] };
    expect(await codeOf(zoom([{ json: segmented }]).adapter.prepareDownload(CREDENTIAL, 'u', 'audio'))).toBe('no_audio');
  });

  it('keeps a title the database can hold and ignores a meeting without an id or a start', async () => {
    const files = [{ id: 'f', file_type: 'M4A', file_size: 10, recording_type: 'audio_only', status: 'completed', download_url: 'https://us02web.zoom.us/rec/download/x' }];
    const { adapter } = zoom([
      {
        json: {
          meetings: [
            { uuid: 'ok1', topic: `a\u0000${'b'.repeat(300)}`, start_time: '2026-11-17T01:00:00Z', duration: 0, recording_files: files },
            { uuid: '', topic: 'no id', start_time: '2026-11-17T01:00:00Z', recording_files: files },
            { uuid: 'no-start', topic: 'no start', start_time: 'not a date', recording_files: files },
          ],
        },
      },
    ]);
    const listed = await adapter.list(CREDENTIAL, SINCE);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.title).toHaveLength(200);
    expect(listed[0]?.title.startsWith('ab')).toBe(true);
    expect(listed[0]?.lengthSeconds).toBeNull();
    expect(listed[0]?.call).toBeUndefined();
  });

  it('omits call when Zoom omits or returns a malformed numeric meeting id', async () => {
    const files = [{ id: 'f', file_type: 'M4A', file_size: 10, recording_type: 'audio_only', status: 'completed', download_url: 'https://us02web.zoom.us/rec/download/x' }];
    const { adapter } = zoom([
      {
        json: {
          meetings: [
            { uuid: 'str-id', id: '91000000001', topic: 'String ID', start_time: '2026-11-17T01:00:00Z', duration: 10, recording_files: files },
            { uuid: 'bad-id', id: 'short-123', topic: 'Bad ID', start_time: '2026-11-16T01:00:00Z', duration: 10, recording_files: files },
          ],
        },
      },
    ]);
    const listed = await adapter.list(CREDENTIAL, SINCE);
    expect(listed.find((r) => r.id === 'str-id')?.call).toEqual({ platform: 'zoom', id: '91000000001' });
    expect(listed.find((r) => r.id === 'bad-id')?.call).toBeUndefined();
  });
});

describe('ZoomMeetingPlatform.prepareDownload', () => {
  it('describes the audio-only download with a fresh address, the member\'s token, the exact first host and the zoom.us suffix', async () => {
    const { adapter, calls } = zoom([{ json: fixture('meeting-recordings') }]);
    const download = await adapter.prepareDownload(CREDENTIAL, 'AAAAAAAAAAAAAAAAAAAAAA==', 'audio');
    expect(calls[0]?.url).toBe('https://api.zoom.us/v2/meetings/AAAAAAAAAAAAAAAAAAAAAA%3D%3D/recordings');
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${CREDENTIAL.accessToken}`);
    expect(download).toEqual({
      url: 'https://us02web.zoom.us/rec/download/f-audio-fresh',
      headers: { authorization: `Bearer ${CREDENTIAL.accessToken}` },
      format: 'audio',
      contentType: 'audio/mp4',
      sizeBytes: 4_000_000,
      hosts: ['us02web.zoom.us'],
      hostSuffixes: [ZOOM_DOWNLOAD_SUFFIX],
    });
    const video = await zoom([{ json: fixture('meeting-recordings') }]).adapter.prepareDownload(CREDENTIAL, 'AAAAAAAAAAAAAAAAAAAAAA==', 'video');
    expect(video).toMatchObject({ url: 'https://us02web.zoom.us/rec/download/f-video-fresh', format: 'video', contentType: 'video/mp4', sizeBytes: 48_000_000 });
  });

  it('refuses an id that would climb the path, with no call', async () => {
    for (const id of ['', '.', '..']) {
      const { adapter, calls } = zoom([{ json: fixture('meeting-recordings') }]);
      expect(await codeOf(adapter.prepareDownload(CREDENTIAL, id, 'audio')), id).toBe('recording_gone');
      expect(calls).toEqual([]);
    }
  });

  it('encodes a meeting uuid that begins with a slash or holds two, twice, as Zoom asks', async () => {
    const { adapter, calls } = zoom([{ json: fixture('meeting-recordings') }, { json: fixture('meeting-recordings') }]);
    await adapter.prepareDownload(CREDENTIAL, '/BBBB//BBBBBBBBBBBBBBB==', 'audio');
    await adapter.prepareDownload(CREDENTIAL, 'abc//def==', 'audio');
    expect(calls[0]?.url).toBe('https://api.zoom.us/v2/meetings/%252FBBBB%252F%252FBBBBBBBBBBBBBBB%253D%253D/recordings');
    expect(calls[1]?.url).toBe('https://api.zoom.us/v2/meetings/abc%252F%252Fdef%253D%253D/recordings');
  });

  it('refuses a recording with no audio file (no_audio) or no video file, and records Zoom\'s answers as short codes', async () => {
    const onlyVideo = { recording_files: [{ id: 'v', file_type: 'MP4', file_size: 1, recording_type: 'shared_screen_with_speaker_view', status: 'completed', download_url: 'https://us02web.zoom.us/rec/download/v' }] };
    const processing = { recording_files: [{ id: 'a', file_type: 'M4A', file_size: 1, recording_type: 'audio_only', status: 'processing', download_url: 'https://us02web.zoom.us/rec/download/a' }] };
    expect(await codeOf(zoom([{ json: onlyVideo }]).adapter.prepareDownload(CREDENTIAL, 'u', 'audio'))).toBe('no_audio');
    expect(await codeOf(zoom([{ json: processing }]).adapter.prepareDownload(CREDENTIAL, 'u', 'audio'))).toBe('no_audio');
    expect(await codeOf(zoom([{ json: { recording_files: [] } }]).adapter.prepareDownload(CREDENTIAL, 'u', 'video'))).toBe('platform_refused');
    expect(await codeOf(zoom([{ status: 404 }]).adapter.prepareDownload(CREDENTIAL, 'u', 'audio'))).toBe('recording_gone');
    expect(await codeOf(zoom([{ status: 401 }]).adapter.prepareDownload(CREDENTIAL, 'u', 'audio'))).toBe('connection_expired');
    expect(await codeOf(zoom([{ status: 500 }]).adapter.prepareDownload(CREDENTIAL, 'u', 'audio'))).toBe('platform_unavailable');
  });

  it('refuses a file address that is not https on zoom.us or one of its subdomains, so the token cannot be sent anywhere else', async () => {
    for (const bad of [
      'https://evil.example.com/rec/download/x',
      'http://us02web.zoom.us/rec/download/x',
      'https://zoom.us.evil.example.com/rec/download/x',
      'https://notzoom.us/rec/download/x',
      'https://us02web.zoom.us.evil.example.com/x',
      'https://user:pw@us02web.zoom.us/rec/download/x',
      'https://us02web.zoom.us:8443/rec/download/x',
      'ftp://zoom.us/rec/download/x',
      'https://169.254.169.254/rec/download/x',
      '//us02web.zoom.us/rec/download/x',
      'https://zoom.us./rec/download/x',
      'https://[::1]/rec/download/x',
      'https://us02web.zoom.us%2f.evil.example.com/x',
      'not a url',
    ]) {
      const files = { recording_files: [{ id: 'a', file_type: 'M4A', file_size: 1, recording_type: 'audio_only', status: 'completed', download_url: bad }] };
      expect(await codeOf(zoom([{ json: files }]).adapter.prepareDownload(CREDENTIAL, 'u', 'audio')), bad).toBe('platform_refused');
      expect(zoomDownloadUrl(bad), bad).toBeNull();
    }
    expect(zoomDownloadUrl(undefined)).toBeNull();
    expect(zoomDownloadUrl('https://zoom.us/rec/download/x')).toEqual({ url: 'https://zoom.us/rec/download/x', host: 'zoom.us' });
    expect(zoomDownloadUrl('https://US02WEB.ZOOM.US/rec/download/x')?.host).toBe('us02web.zoom.us');
  });
});

describe('ZoomMeetingPlatform.refresh', () => {
  it('renews the token with the app\'s credentials and keeps the new refresh token Zoom rotates in', async () => {
    const { adapter, calls } = zoom([{ json: fixture('token') }]);
    const renewed = await adapter.refresh(CREDENTIAL);
    expect(renewed).toEqual({ accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: new Date(NOW.getTime() + 3599 * 1000) });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://zoom.us/oauth/token');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers.authorization).toBe(`Basic ${Buffer.from(`${APP.clientId}:${APP.clientSecret}`).toString('base64')}`);
    expect(calls[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({ grant_type: 'refresh_token', refresh_token: CREDENTIAL.refreshToken });
  });

  it('keeps the old refresh token when Zoom sends none, and defaults the life to an hour', async () => {
    const { adapter } = zoom([{ json: { access_token: 'a2' } }]);
    expect(await adapter.refresh(CREDENTIAL)).toEqual({ accessToken: 'a2', refreshToken: CREDENTIAL.refreshToken, expiresAt: new Date(NOW.getTime() + 3600 * 1000) });
  });

  it('says refused (the member connects again) when Zoom will not renew the grant, or there is no refresh token, without a call', async () => {
    for (const status of [400, 401]) expect(await zoom([{ status, json: { error: 'invalid_grant' } }]).adapter.refresh(CREDENTIAL)).toEqual({ refused: true });
    const none = zoom([{ json: fixture('token') }]);
    expect(await none.adapter.refresh({ accessToken: 'x' })).toEqual({ refused: true });
    expect(none.calls).toEqual([]);
  });

  it('throws a short code for a busy or malformed Zoom, so the job tries again', async () => {
    expect(await codeOf(zoom([{ status: 503 }]).adapter.refresh(CREDENTIAL))).toBe('platform_unavailable');
    expect(await codeOf(zoom([{ status: 429 }]).adapter.refresh(CREDENTIAL))).toBe('platform_unavailable');
    expect(await codeOf(zoom([new TypeError('fetch failed')]).adapter.refresh(CREDENTIAL))).toBe('platform_unavailable');
    expect(await codeOf(zoom([{ json: { token_type: 'bearer' } }]).adapter.refresh(CREDENTIAL))).toBe('platform_unavailable');
  });
});

describe('ZoomMeetingPlatform connect (authorizeUrl and exchange)', () => {
  const GRANT = { code: 'code-not-real-0001', redirectUri: 'https://app.example.test/meetings/oauth/zoom/callback', codeVerifier: 'v'.repeat(64) };

  it('builds the authorize address with the app id, the redirect address, the state and the PKCE challenge, and no scope', () => {
    const { adapter, calls } = zoom([]);
    const url = new URL(adapter.authorizeUrl({ state: 'state-0001', redirectUri: GRANT.redirectUri, codeChallenge: 'challenge-0001' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://zoom.us/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: APP.clientId,
      redirect_uri: GRANT.redirectUri,
      state: 'state-0001',
      code_challenge: 'challenge-0001',
      code_challenge_method: 'S256',
    });
    expect(adapter.oauthProvider).toBe('zoom_recordings');
    expect(adapter.pkce).toBe(true);
    // Building an address calls nothing.
    expect(calls).toEqual([]);
  });

  it('exchanges the code with the app credentials and the verifier, reads who the grant is, and returns a credential the job reads', async () => {
    const { adapter, calls } = zoom([{ json: fixture('token') }, { json: fixture('users-me') }]);
    const account = await adapter.exchange(GRANT);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://zoom.us/oauth/token');
    expect(calls[0]?.headers.authorization).toBe(`Basic ${Buffer.from(`${APP.clientId}:${APP.clientSecret}`).toString('base64')}`);
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).toEqual({ grant_type: 'authorization_code', code: GRANT.code, redirect_uri: GRANT.redirectUri, code_verifier: GRANT.codeVerifier });
    expect(calls[1]?.url).toBe('https://api.zoom.us/v2/users/me');
    expect(calls[1]?.headers.authorization).toBe('Bearer access-new');
    // Keyed by the Zoom user's id (lowercased); the address is only the display name.
    expect(account.externalAccount).toBe('synthetic-user-id-0001');
    expect(account.displayName).toBe('Linh Nguyen');
    expect(account.scopes).toEqual(['cloud_recording:read:list_user_recordings', 'cloud_recording:read:list_recording_files']);
    expect(account.expiresAt).toEqual(new Date(NOW.getTime() + 3599 * 1000));
    expect(JSON.parse(account.secret)).toEqual({ accessToken: 'access-new', refreshToken: 'refresh-new', expiresAt: new Date(NOW.getTime() + 3599 * 1000).toISOString() });
  });

  it('names the account by its address when Zoom gives no display name, and omits the verifier when the attempt has none', async () => {
    const { adapter, calls } = zoom([{ json: { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 } }, { json: { id: 'ABC123xyz', email: 'only@example.test' } }]);
    const account = await adapter.exchange({ ...GRANT, codeVerifier: null });
    expect(account.displayName).toBe('only@example.test');
    expect(account.externalAccount).toBe('abc123xyz');
    expect(JSON.parse(account.secret)).toEqual({ accessToken: 'a1', refreshToken: 'r1', expiresAt: new Date(NOW.getTime() + 3600 * 1000).toISOString() });
    expect(Object.fromEntries(new URLSearchParams(calls[0]?.body))).not.toHaveProperty('code_verifier');
  });

  it('keys the connection by the same account key the webhook reads a host id with, whatever the case Zoom writes (decision of #4011, point 2)', async () => {
    const sent = ' ABC123xyz_-Q ';
    const { adapter } = zoom([{ json: { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 } }, { json: { id: sent, email: 'only@example.test' } }]);
    const account = await adapter.exchange(GRANT);
    const notice = parseZoomNotice(new TextEncoder().encode(JSON.stringify({ event: 'recording.completed', event_ts: 1, payload: { object: { host_id: sent.trim().toUpperCase(), uuid: 'u' } } })));
    expect(account.externalAccount).toBe(zoomAccountKey(sent));
    expect(account.externalAccount).toBe('abc123xyz_-q');
    expect(notice).toMatchObject({ kind: 'recording', hostId: account.externalAccount });
    expect(zoomAccountKey(' KdYkJnImT4 ')).toBe('kdykjnimt4');
  });

  it('refuses a code or an app Zoom does not accept, and an account with no address, with short codes and nothing stored', async () => {
    for (const status of [400, 401]) expect(await codeOf(zoom([{ status, json: { error: 'invalid_grant' } }]).adapter.exchange(GRANT))).toBe('platform_refused');
    // The token was accepted but the profile read is refused (the app lacks the permission): the same short code, never the token.
    expect(await codeOf(zoom([{ json: fixture('token') }, { status: 401 }]).adapter.exchange(GRANT))).toBe('platform_refused');
    expect(await codeOf(zoom([{ json: fixture('token') }, { status: 403 }]).adapter.exchange(GRANT))).toBe('platform_refused');
    expect(await codeOf(zoom([{ json: fixture('token') }, { json: { id: 'x', display_name: 'No Address' } }]).adapter.exchange(GRANT))).toBe('platform_refused');
    expect(await codeOf(zoom([{ json: fixture('token') }, { json: { email: 'no-id@example.test' } }]).adapter.exchange(GRANT))).toBe('platform_refused');
  });

  it('says platform_unavailable for a busy or malformed Zoom, and an error carries no token, code or answer body', async () => {
    expect(await codeOf(zoom([{ status: 503 }]).adapter.exchange(GRANT))).toBe('platform_unavailable');
    expect(await codeOf(zoom([new TypeError('fetch failed')]).adapter.exchange(GRANT))).toBe('platform_unavailable');
    expect(await codeOf(zoom([{ json: { token_type: 'bearer' } }]).adapter.exchange(GRANT))).toBe('platform_unavailable');
    // A grant with no refresh token would die within the hour: refused at connect, not an hour later.
    expect(await codeOf(zoom([{ json: { access_token: 'a1', expires_in: 3600 } }]).adapter.exchange(GRANT))).toBe('platform_unavailable');
    expect(await codeOf(zoom([{ json: fixture('token') }, { status: 502 }]).adapter.exchange(GRANT))).toBe('platform_unavailable');
    const failure: unknown = await zoom([{ status: 400, text: 'secret-body-code-not-real-0001 access-new' }]).adapter.exchange(GRANT).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(MeetingPlatformError);
    const message = (failure as MeetingPlatformError).message;
    expect(message).not.toContain(GRANT.code);
    expect(message).not.toContain('secret-body');
    expect(message).not.toContain('access-new');
  });
});

describe('Zoom\'s transcript file', () => {
  const VTT = readFileSync(new URL('./fixtures/zoom/transcript.vtt', import.meta.url), 'utf8');
  const file = (over: Record<string, unknown> = {}) => ({ id: 'f-vtt', file_type: 'TRANSCRIPT', file_extension: 'VTT', file_size: 2000, recording_type: 'audio_transcript', status: 'completed', download_url: 'https://us02web.zoom.us/rec/download/f-vtt-fresh', ...over });

  it('reads the speaker from the text before the first colon, and leaves a figure, a long prefix and a cue with no colon without one', () => {
    const { entries, truncated } = parseZoomVtt(VTT);
    expect(truncated).toBe(false);
    expect(entries.map((e) => [e.startSeconds, e.endSeconds, e.speaker, e.text])).toEqual([
      [3, 5, 'Nguyen Van A', 'Xin chào mọi người, hôm nay mình bàn về báo giá.'],
      [6, 10, 'Tran Thi B', 'Báo giá là 120 triệu, giao trong 10 ngày.'],
      [10, 12, null, 'Không ai nói tên ở dòng này.'],
      // The colon inside the sentence stays in it: only the first one names the speaker.
      [13, 15, 'Nguyen Van A', 'Giờ họp: 10:30 sáng mai. Ghi lại giúp.'],
      // "3: ..." is a figure, not a name.
      [16, 17, null, '3: mục thứ ba'],
      // The cue settings after the end stamp are not part of the time.
      [62, 64, 'Le C', 'Dạ vâng.'],
    ]);
    const long = `WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n${'x'.repeat(90)}: tail\n`;
    expect(parseZoomVtt(long).entries[0]?.speaker).toBeNull();
    expect(parseZoomVtt('').entries).toEqual([]);
    expect(parseZoomVtt('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n   \n').entries).toEqual([]);
  });

  it('describes the one finished transcript file the way a recording\'s file is described: a fresh address, the member\'s token, the exact first host, redirects only inside zoom.us', async () => {
    const { adapter, calls } = zoom([{ json: { uuid: 'U', recording_files: [file(), { ...file({ id: 'f-chat', file_type: 'CHAT', recording_type: 'chat_file' }) }] } }]);
    const download = await adapter.transcriptFile(CREDENTIAL, 'AAAAAAAAAAAAAAAAAAAAAA==');
    expect(download).toEqual({
      url: 'https://us02web.zoom.us/rec/download/f-vtt-fresh',
      headers: { authorization: 'Bearer zoom-access-not-real-0001' },
      format: 'transcript',
      contentType: 'text/vtt',
      sizeBytes: 2000,
      hosts: ['us02web.zoom.us'],
      hostSuffixes: ['zoom.us'],
    });
    expect(calls.map((c) => c.url)).toEqual([`https://api.zoom.us/v2/meetings/${encodeURIComponent('AAAAAAAAAAAAAAAAAAAAAA==')}/recordings`]);
  });

  it('refuses a recording with no transcript, one still processing, two transcript parts, a file off Zoom\'s hosts, and an id that climbs the path', async () => {
    const one = (files: unknown[]) => zoom([{ json: { recording_files: files } }]).adapter.transcriptFile(CREDENTIAL, 'U');
    expect(await codeOf(one([]))).toBe('no_transcript');
    expect(await codeOf(one([file({ status: 'processing' })]))).toBe('no_transcript');
    expect(await codeOf(one([file(), file({ id: 'f-vtt-2' })]))).toBe('no_transcript');
    expect(await codeOf(one([file({ download_url: 'https://evil.example.test/rec/f' })]))).toBe('platform_refused');
    expect(await codeOf(one([file({ download_url: 'http://us02web.zoom.us/rec/f' })]))).toBe('platform_refused');
    expect(await codeOf(one([file({ download_url: 'https://notzoom.us/rec/f' })]))).toBe('platform_refused');
    const { adapter, calls } = zoom([{ json: {} }]);
    for (const id of ['', '.', '..']) expect(await codeOf(adapter.transcriptFile(CREDENTIAL, id))).toBe('recording_gone');
    expect(calls).toEqual([]);
  });

  it('maps a Zoom status the way the list does: 401 expired, 404 gone, 429 busy', async () => {
    for (const [status, code] of [[401, 'connection_expired'], [404, 'recording_gone'], [429, 'platform_unavailable']] as const) {
      expect(await codeOf(zoom([{ status }]).adapter.transcriptFile(CREDENTIAL, 'U'))).toBe(code);
    }
  });

  it('parses the bytes the job got as Zoom\'s own transcript, and refuses an empty one and one over the cap', () => {
    const { adapter } = zoom([{ json: {} }]);
    const parsed = adapter.parseTranscript(new TextEncoder().encode(VTT));
    expect(parsed).toMatchObject({ source: 'zoom', language: null, truncated: false });
    expect(parsed.entries).toHaveLength(6);
    expect(() => adapter.parseTranscript(new TextEncoder().encode('WEBVTT\n'))).toThrow(expect.objectContaining({ code: 'no_transcript' }));
    expect(() => adapter.parseTranscript(new Uint8Array(ZOOM_TRANSCRIPT_MAX_BYTES + 1))).toThrow(expect.objectContaining({ code: 'too_large' }));
  });
});

describe('the Zoom adapter\'s hosts and registration', () => {
  it('may call only the API host and the token host, and a call to any other host is refused before the transport', async () => {
    const t = transport([{ json: {} }]);
    expect([...new ZoomMeetingPlatform(APP, { fetch: t.fetchImpl }).hosts]).toEqual([...ZOOM_HOSTS]);
    expect([...ZOOM_HOSTS]).toEqual(['api.zoom.us', 'zoom.us']);
    // The adapter builds every address itself; the guard on its transport is the allowlist all adapters share.
    const { allowlistedFetch } = await import('../src/oauth.ts');
    const guarded = allowlistedFetch(ZOOM_HOSTS, t.fetchImpl);
    await expect(guarded('https://evil.example.com/x')).rejects.toThrow(/host not allowed/);
    await expect(guarded('http://api.zoom.us/x')).rejects.toThrow(/host not allowed/);
    await expect(guarded('https://api.zoom.us.evil.example.com/x')).rejects.toThrow(/host not allowed/);
    expect(t.calls).toEqual([]);
  });

  it('is registered only when the deployment has a Zoom app: off by default', () => {
    expect('zoom' in meetingPlatformAdapters({})).toBe(false);
    expect(Object.keys(meetingPlatformAdapters({ sandbox: false }))).toEqual([]);
    const on = meetingPlatformAdapters({ sandbox: false, zoom: APP });
    expect(Object.keys(on)).toEqual(['zoom']);
    expect(on.zoom).toBeInstanceOf(ZoomMeetingPlatform);
    expect(on.zoom?.provider).toBe('zoom');
  });
});
