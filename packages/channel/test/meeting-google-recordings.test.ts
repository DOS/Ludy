// SPDX-License-Identifier: AGPL-3.0-only
// The Google Meet adapter's Picker route (meetings integrations C2, #3174, ADR-0025 amendment of 2026-11-25): the recording of a conference that has no transcript is offered as a video, the Drive file id
// Meet gave for it is what the pick command compares with, and the download is the Drive media URL with the bearer on the first host only. No Google call is ever made: a fake fetch answers in the shapes of
// the Meet REST API v2 reference (conferenceRecords, transcripts, recordings with driveDestination) and fails on any other host, method or a request without the bearer token.
import { afterEach, describe, expect, it } from 'vitest';
import { GOOGLE_DRIVE_DOWNLOAD_HOST, GOOGLE_DRIVE_REDIRECT_SUFFIX, GOOGLE_MEET_AUTH_SCOPES, GOOGLE_MEET_DRIVE_FILE_SCOPE, GoogleMeetAdapter, type MeetingPlatformCredential } from '../src/index.ts';

const CREDENTIAL: MeetingPlatformCredential = { accessToken: 'meet-access-token-not-real-0002', refreshToken: 'meet-refresh-token-not-real-0002' };
const SINCE = new Date('2026-11-04T00:00:00Z');
const T = (minutes: number) => new Date(Date.parse('2026-11-17T02:00:00Z') + minutes * 60_000).toISOString();
const FILE = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123456789';

const violations: string[] = [];
afterEach(() => {
  const found = violations.splice(0);
  expect(found).toEqual([]);
});

type Route = { status?: number; body: unknown };
function google(routes: Record<string, Route>) {
  const seen: string[] = [];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    seen.push(url.pathname.replace(/^\/v2\//, ''));
    if (url.hostname !== 'meet.googleapis.com') violations.push(`host ${url.hostname}`);
    if ((init?.method ?? 'GET') !== 'GET') violations.push(`method ${init?.method}`);
    if ((init?.headers as Record<string, string> | undefined)?.authorization !== `Bearer ${CREDENTIAL.accessToken}`) violations.push('no bearer token');
    const route = routes[url.pathname.replace(/^\/v2\//, '')];
    if (route === undefined) {
      violations.push(`no route for ${url.pathname}`);
      return new Response('{}', { status: 500 });
    }
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen };
}
const refresher = { refresh: async () => ({ refused: 'no' }) };
const over = (routes: Record<string, Route>, recordings: boolean) => {
  const fake = google(routes);
  return { adapter: new GoogleMeetAdapter({ refresher, fetch: fake.fetch, recordings }), ...fake };
};

const REC = (conference: string, over: Record<string, unknown> = {}) => ({
  name: `conferenceRecords/${conference}/recordings/r1`,
  state: 'FILE_GENERATED',
  startTime: T(0),
  endTime: T(30),
  driveDestination: { file: FILE, exportUri: `https://drive.google.com/file/d/${FILE}/view` },
  ...over,
});
const ROUTES: Record<string, Route> = {
  conferenceRecords: {
    body: {
      conferenceRecords: [
        { name: 'conferenceRecords/aaa111', startTime: T(0), endTime: T(30), space: 'spaces/s1' },
        { name: 'conferenceRecords/bbb222', startTime: T(-120), endTime: T(-90), space: 'spaces/s2' },
        { name: 'conferenceRecords/ccc333', startTime: T(-300), endTime: T(-270), space: 'spaces/s3' },
      ],
    },
  },
  'spaces/s1': { body: { name: 'spaces/s1', meetingCode: 'abc-mnop-xyz' } },
  'spaces/s2': { body: { name: 'spaces/s2', meetingCode: 'def-mnop-xyz' } },
  'spaces/s3': { body: { name: 'spaces/s3', meetingCode: 'ghi-mnop-xyz' } },
  // aaa111: a recording and no transcript. bbb222: a transcript and a recording. ccc333: a recording that is still being written.
  'conferenceRecords/aaa111/transcripts': { body: {} },
  'conferenceRecords/bbb222/transcripts': { body: { transcripts: [{ name: 'conferenceRecords/bbb222/transcripts/t1', state: 'FILE_GENERATED' }] } },
  'conferenceRecords/ccc333/transcripts': { body: {} },
  'conferenceRecords/aaa111/recordings': { body: { recordings: [REC('aaa111')] } },
  'conferenceRecords/bbb222/recordings': { body: { recordings: [REC('bbb222')] } },
  'conferenceRecords/ccc333/recordings': { body: { recordings: [REC('ccc333', { state: 'STARTED' })] } },
};

describe('Google Meet recordings through the Picker route', () => {
  it('is off unless asked for: the listing is the transcripts only, no recording is requested and nothing is downloaded', async () => {
    const { adapter, seen } = over(ROUTES, false);
    const rows = await adapter.list(CREDENTIAL, SINCE);
    expect(rows.map((r) => r.id)).toEqual(['conferenceRecords/bbb222/transcripts/t1']);
    expect(seen.some((p) => p.endsWith('/recordings'))).toBe(false);
    expect(await adapter.recordingFile(CREDENTIAL, 'conferenceRecords/aaa111/recordings/r1')).toBeNull();
    await expect(adapter.prepareDownload(CREDENTIAL, 'conferenceRecords/aaa111/recordings/r1', 'video')).rejects.toMatchObject({ code: 'platform_refused' });
  });

  it('offers the recording of a conference with no transcript as a video, and the transcript of one that has it (nothing to pick)', async () => {
    const { adapter, seen } = over(ROUTES, true);
    const rows = await adapter.list(CREDENTIAL, SINCE);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect([...byId.keys()].sort()).toEqual(['conferenceRecords/aaa111/recordings/r1', 'conferenceRecords/bbb222/transcripts/t1']);
    expect(byId.get('conferenceRecords/aaa111/recordings/r1')).toMatchObject({ hasVideo: true, hasAudio: false, hasTranscript: false, sizeBytes: null, call: { platform: 'google_meet', id: 'abc-mnop-xyz' } });
    expect(byId.get('conferenceRecords/bbb222/transcripts/t1')).toMatchObject({ hasVideo: false, hasTranscript: true });
    // A conference with a transcript is never asked for its recordings; one still being written is not offered.
    expect(seen).not.toContain('conferenceRecords/bbb222/recordings');
    expect(rows.some((r) => r.id.startsWith('conferenceRecords/ccc333'))).toBe(false);
  });

  it('drops a recording whose name belongs to another conference, or whose file id is not a Drive file id', async () => {
    const odd = { ...ROUTES, 'conferenceRecords/aaa111/recordings': { body: { recordings: [REC('zzz999'), REC('aaa111', { driveDestination: { file: '../../etc/passwd?x=1' } }), REC('aaa111', { driveDestination: { file: 'short' } })] } } };
    const { adapter } = over(odd, true);
    expect((await adapter.list(CREDENTIAL, SINCE)).map((r) => r.id)).toEqual(['conferenceRecords/bbb222/transcripts/t1']);
  });

  it('gives the Drive file id Meet named for a recording, and nothing for another, a missing or a malformed one', async () => {
    const { adapter } = over({ ...ROUTES, 'conferenceRecords/eee555/recordings': { status: 404, body: {} } }, true);
    expect(await adapter.recordingFile(CREDENTIAL, 'conferenceRecords/aaa111/recordings/r1')).toEqual({ fileId: FILE });
    expect(await adapter.recordingFile(CREDENTIAL, 'conferenceRecords/aaa111/recordings/other')).toBeNull();
    expect(await adapter.recordingFile(CREDENTIAL, 'conferenceRecords/eee555/recordings/r1')).toBeNull();
    expect(await adapter.recordingFile(CREDENTIAL, 'conferenceRecords/aaa111/transcripts/t1')).toBeNull();
    expect(await adapter.recordingFile(CREDENTIAL, '../x')).toBeNull();
  });

  it('prepares the Drive media download: the bearer on the first Google host only, a video, a file id Meet gave and nothing the client sent', async () => {
    const { adapter } = over(ROUTES, true);
    const download = await adapter.prepareDownload(CREDENTIAL, 'conferenceRecords/aaa111/recordings/r1', 'video');
    expect(download).toMatchObject({
      url: `https://${GOOGLE_DRIVE_DOWNLOAD_HOST}/drive/v3/files/${FILE}?alt=media`,
      headers: { authorization: `Bearer ${CREDENTIAL.accessToken}` },
      format: 'video',
      contentType: 'video/mp4',
      hosts: ['www.googleapis.com'],
      hostSuffixes: [GOOGLE_DRIVE_REDIRECT_SUFFIX],
    });
    expect(download.inline).toBeUndefined();
    await expect(adapter.prepareDownload(CREDENTIAL, 'conferenceRecords/aaa111/recordings/r1', 'audio')).rejects.toMatchObject({ code: 'no_audio' });
    await expect(adapter.prepareDownload(CREDENTIAL, 'conferenceRecords/aaa111/transcripts/t1', 'video')).rejects.toMatchObject({ code: 'platform_refused' });
    await expect(adapter.prepareDownload(CREDENTIAL, 'conferenceRecords/aaa111/recordings/gone', 'video')).rejects.toMatchObject({ code: 'recording_gone' });
  });

  it('keeps the connect scopes as they are until the pick step asks for the Drive scope, and never names a restricted one', () => {
    expect(GOOGLE_MEET_DRIVE_FILE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
    expect(GOOGLE_MEET_AUTH_SCOPES).not.toContain(GOOGLE_MEET_DRIVE_FILE_SCOPE);
    for (const scope of GOOGLE_MEET_AUTH_SCOPES) expect(scope).not.toMatch(/drive\.(readonly|meet\.readonly)$/u);
  });
});
