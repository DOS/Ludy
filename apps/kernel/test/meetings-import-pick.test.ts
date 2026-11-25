// SPDX-License-Identifier: AGPL-3.0-only
// The pick check in the recording import job (meetings integrations C2, #3174, ADR-0025 amendment of 2026-11-25): a Google Meet recording that is a video file only is downloaded only when the Drive file the
// member picked is the file Meet itself gave for the recording, asked of Meet now. No pick, a gone recording and another file fail the import with a short code and no download is opened. A recording that
// needs no pick (audio, a transcript, another provider) never asks. The platform is a fake; no Google call is made.
import { describe, expect, it } from 'vitest';
import type { MeetingPlatformAdapter } from '@ludy/channel';
import { runMeetingsImport, type MeetingsImportDeps, type MeetingsImportJob } from '../src/meetings-import.ts';

const KEY = `staging/${'c'.repeat(64)}`;
const PICKED = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123456789';
const job = (over: Partial<MeetingsImportJob> = {}): MeetingsImportJob => ({
  orgId: '00000000-0000-4000-8000-000000000001',
  id: '00000000-0000-4000-8000-000000000002',
  connectionId: '00000000-0000-4000-8000-000000000003',
  provider: 'google_meet',
  externalId: 'conferenceRecords/aaa111/recordings/r1',
  hasAudio: false,
  hasVideo: true,
  sizeBytes: null,
  stagingKey: KEY,
  ...over,
});
const attempt = { retryCount: 0, retryLimit: 3 };

function setup(options: { picked: string | null; meet: { fileId: string } | null | Error }) {
  const executed: string[] = [];
  const asked: string[] = [];
  const touched: string[] = [];
  const adapter: MeetingPlatformAdapter = {
    provider: 'google_meet',
    hosts: ['meet.googleapis.com'],
    list: async () => [],
    recordingFile: async (_credential, recordingId) => {
      asked.push(recordingId);
      if (options.meet instanceof Error) throw options.meet;
      return options.meet;
    },
    prepareDownload: async () => {
      touched.push('prepare');
      // An audio answer with its bytes inline: the job stages it without a connection, which is all these tests need after the check.
      return { url: 'sandbox://local/x', headers: {}, format: 'audio', hosts: [], hostSuffixes: [], inline: { bytes: new Uint8Array([1, 2, 3, 4]), contentType: 'audio/wav' } };
    },
  };
  const deps = {
    runtime: {
      query: async (name: string) => {
        if (name === 'kernel.meeting_platform.credential') return { keyId: 'k1', envelope: Buffer.from('sealed').toString('base64'), provider: 'google_meet', externalAccount: 'a@example.test' };
        if (name === 'kernel.meeting_platform.import_holds') return 'importing';
        if (name === 'kernel.meeting_platform.import_pick') return options.picked;
        throw new Error(`unexpected query ${name}`);
      },
      execute: async (name: string, input: Record<string, unknown>) => {
        executed.push(`${name}:${String(input.code ?? '')}`);
        return { applied: 1 };
      },
    },
    broker: { id: 'test', open: () => JSON.stringify({ accessToken: 'token-123' }) },
    store: { put: async () => 'content:1', delete: async () => undefined },
    adapters: { google_meet: adapter },
    extractor: { configured: true },
  } as unknown as MeetingsImportDeps;
  return { deps, executed, asked, touched };
}

describe('the pick check of the import job', () => {
  it('downloads when the picked file is the one Meet gave for this recording', async () => {
    const run = setup({ picked: PICKED, meet: { fileId: PICKED } });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('staged');
    expect(run.asked).toEqual(['conferenceRecords/aaa111/recordings/r1']);
    expect(run.touched).toEqual(['prepare']);
    expect(run.executed).toEqual(['kernel.meeting_platform.import_staged:']);
  });

  it('fails with pick_missing when no file was picked, and opens nothing', async () => {
    const run = setup({ picked: null, meet: { fileId: PICKED } });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
    expect(run.executed).toEqual(['kernel.meeting_platform.import_failed:pick_missing']);
    expect(run.asked).toEqual([]);
    expect(run.touched).toEqual([]);
  });

  it('fails with pick_mismatch when the member picked another file than Meet\'s, and opens nothing', async () => {
    const run = setup({ picked: `${PICKED}Z`, meet: { fileId: PICKED } });
    expect(await runMeetingsImport(run.deps, job(), attempt)).toBe('failed');
    expect(run.executed).toEqual(['kernel.meeting_platform.import_failed:pick_mismatch']);
    expect(run.touched).toEqual([]);
  });

  it('fails with recording_gone when Meet no longer has the recording file, and as expired when Meet refuses the grant', async () => {
    const gone = setup({ picked: PICKED, meet: null });
    expect(await runMeetingsImport(gone.deps, job(), attempt)).toBe('failed');
    expect(gone.executed).toEqual(['kernel.meeting_platform.import_failed:recording_gone']);
    expect(gone.touched).toEqual([]);
    const { MeetingPlatformError } = await import('@ludy/channel');
    const refused = setup({ picked: PICKED, meet: new MeetingPlatformError('connection_expired', 'Google refused the grant (403)') });
    expect(await runMeetingsImport(refused.deps, job(), attempt)).toBe('failed');
    expect(refused.executed).toEqual(['kernel.meeting_platform.import_failed:connection_expired']);
    expect(refused.touched).toEqual([]);
  });

  it('fails closed when the provider\'s adapter cannot name the file, and a row with no pick costs no token renewal', async () => {
    const run = setup({ picked: PICKED, meet: { fileId: PICKED } });
    const bare = { ...run.deps.adapters.google_meet } as MeetingPlatformAdapter;
    delete (bare as { recordingFile?: unknown }).recordingFile;
    const deps = { ...run.deps, adapters: { google_meet: bare } } as MeetingsImportDeps;
    expect(await runMeetingsImport(deps, job(), attempt)).toBe('failed');
    expect(run.executed).toEqual(['kernel.meeting_platform.import_failed:platform_unavailable']);
    expect(run.touched).toEqual([]);
    const none = setup({ picked: null, meet: { fileId: PICKED } });
    const credentials: string[] = [];
    const query = none.deps.runtime.query.bind(none.deps.runtime);
    (none.deps.runtime as { query: unknown }).query = async (name: string, ...rest: unknown[]) => {
      credentials.push(name);
      return (query as (name: string, ...rest: unknown[]) => Promise<unknown>)(name, ...rest);
    };
    expect(await runMeetingsImport(none.deps, job(), attempt)).toBe('failed');
    expect(credentials).not.toContain('kernel.meeting_platform.credential');
  });

  it('never asks for a pick of a recording that needs none: audio, another provider', async () => {
    const audio = setup({ picked: null, meet: null });
    expect(await runMeetingsImport(audio.deps, job({ hasAudio: true, hasVideo: false }), attempt)).toBe('staged');
    expect(audio.asked).toEqual([]);
  });
});
