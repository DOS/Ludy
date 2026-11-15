// SPDX-License-Identifier: AGPL-3.0-only
// The download job of the recording import (meetings integrations C1, #3173): what it stages, what it refuses before any network call, how each failure is recorded, and that a transient one retries.
import { describe, expect, it } from 'vitest';
import { MeetingPlatformError, SandboxMeetingPlatform, type MeetingPlatformAdapter, type MeetingPlatformDownload } from '@crove/channel';
import { MEETING_PLATFORM_IMPORT_MAX_BYTES } from '@crove/kernel-contract';
import { DomainError, EgressError, type EgressStream } from '@crove/kernel-runtime';
import { MEETINGS_IMPORT_CONCURRENCY, runMeetingsImport, type MeetingsImportDeps, type MeetingsImportJob } from '../src/meetings-import.ts';

const KEY = `staging/${'a'.repeat(64)}`;
const job = (over: Partial<MeetingsImportJob> = {}): MeetingsImportJob => ({
  orgId: '00000000-0000-4000-8000-000000000001',
  id: '00000000-0000-4000-8000-000000000002',
  connectionId: '00000000-0000-4000-8000-000000000003',
  provider: 'sandbox',
  externalId: 'sandbox-rec-audio',
  hasAudio: true,
  hasVideo: false,
  sizeBytes: null,
  stagingKey: KEY,
  ...over,
});

interface Calls {
  executed: Array<{ name: string; input: Record<string, unknown> }>;
  stored: Map<string, Uint8Array>;
  deleted: string[];
}

function harness(over: Partial<MeetingsImportDeps> = {}, executeError?: (name: string) => Error | undefined): { deps: MeetingsImportDeps; calls: Calls } {
  const calls: Calls = { executed: [], stored: new Map(), deleted: [] };
  const sealed = { keyId: 'k1', envelope: Buffer.from('sealed').toString('base64'), provider: 'sandbox', externalAccount: 'sandbox@local' };
  const deps = {
    runtime: {
      query: async (name: string) => {
        if (name === 'kernel.meeting_platform.credential') return sealed;
        throw new Error(`unexpected query ${name}`);
      },
      execute: async (name: string, input: Record<string, unknown>) => {
        const error = executeError?.(name);
        if (error) throw error;
        calls.executed.push({ name, input });
        return {};
      },
    },
    broker: { id: 'test', open: () => JSON.stringify({ accessToken: 'token-123' }) },
    store: {
      put: async (key: string, bytes: Uint8Array) => {
        calls.stored.set(key, bytes);
        return 'content:1';
      },
      delete: async (key: string) => {
        calls.deleted.push(key);
      },
    },
    adapters: { sandbox: new SandboxMeetingPlatform() },
    media: null,
    ...over,
  } as unknown as MeetingsImportDeps;
  return { deps, calls };
}

const attempt = { retryCount: 0, retryLimit: 3 };
const recorded = (calls: Calls) => calls.executed.map((c) => `${c.name}:${String(c.input.code ?? '')}`);

describe('runMeetingsImport', () => {
  it('stages the bytes of an audio recording under the row\'s staging key and says so', async () => {
    const { deps, calls } = harness();
    expect(await runMeetingsImport(deps, job(), attempt)).toBe('staged');
    expect(calls.stored.get(KEY)?.byteLength).toBeGreaterThan(44);
    expect(calls.executed.map((c) => c.name)).toEqual(['kernel.meeting_platform.import_staged']);
    expect(calls.executed[0]?.input).toEqual({ recordingId: job().id });
  });

  it('refuses a declared size over the cap before any network call, and a video-only recording while no audio extraction is wired', async () => {
    const touched: string[] = [];
    const spy: MeetingPlatformAdapter = {
      provider: 'sandbox',
      hosts: [],
      list: async () => [],
      prepareDownload: async () => {
        touched.push('prepare');
        throw new Error('not reached');
      },
    };
    const { deps, calls } = harness({ adapters: { sandbox: spy } });
    expect(await runMeetingsImport(deps, job({ sizeBytes: MEETING_PLATFORM_IMPORT_MAX_BYTES + 1 }), attempt)).toBe('failed');
    expect(await runMeetingsImport(deps, job({ hasAudio: false, hasVideo: true }), attempt)).toBe('failed');
    expect(touched).toEqual([]);
    expect(recorded(calls)).toEqual(['kernel.meeting_platform.import_failed:too_large', 'kernel.meeting_platform.import_failed:no_audio']);
    expect(calls.deleted).toEqual([KEY, KEY]);
  });

  it('records the platform\'s answers as short codes: a recording that is gone, a refused token, and never the platform\'s words', async () => {
    const failing = (error: Error): MeetingPlatformAdapter => ({ provider: 'sandbox', hosts: [], list: async () => [], prepareDownload: async () => Promise.reject(error) });
    for (const [error, code] of [
      [new MeetingPlatformError('recording_gone', 'secret platform words'), 'recording_gone'],
      [new MeetingPlatformError('connection_expired'), 'connection_expired'],
      [new MeetingPlatformError('platform_refused'), 'platform_refused'],
    ] as const) {
      const { deps, calls } = harness({ adapters: { sandbox: failing(error) } });
      expect(await runMeetingsImport(deps, job(), attempt)).toBe('failed');
      expect(JSON.stringify(calls.executed)).not.toContain('secret platform words');
      expect(recorded(calls)).toEqual([`kernel.meeting_platform.import_failed:${code}`]);
    }
  });

  it('fails with connection_expired when the credential is not available (the member left, or the connection expired)', async () => {
    const { deps, calls } = harness({
      runtime: {
        query: async () => Promise.reject(new DomainError('MEETING_PLATFORM_OWNER_LEFT', 409, 'x')),
        execute: async (name: string, input: Record<string, unknown>) => {
          calls.executed.push({ name, input });
          return {};
        },
      } as unknown as MeetingsImportDeps['runtime'],
    });
    expect(await runMeetingsImport(deps, job(), attempt)).toBe('failed');
    expect(recorded(calls)).toEqual(['kernel.meeting_platform.import_failed:connection_expired']);
  });

  it('retries a transient failure by throwing while tries remain, and records platform_unavailable on the last try', async () => {
    const down: MeetingPlatformAdapter = { provider: 'sandbox', hosts: [], list: async () => [], prepareDownload: async () => Promise.reject(new MeetingPlatformError('platform_unavailable')) };
    const first = harness({ adapters: { sandbox: down } });
    await expect(runMeetingsImport(first.deps, job(), { retryCount: 0, retryLimit: 3 })).rejects.toThrow(/not staged/);
    expect(first.calls.executed).toEqual([]);
    const last = harness({ adapters: { sandbox: down } });
    expect(await runMeetingsImport(last.deps, job(), { retryCount: 3, retryLimit: 3 })).toBe('failed');
    expect(recorded(last.calls)).toEqual(['kernel.meeting_platform.import_failed:platform_unavailable']);
  });

  it('drops the bytes and skips when the row is no longer importing', async () => {
    const { deps, calls } = harness({}, (name) => (name === 'kernel.meeting_platform.import_staged' ? new DomainError('MEETING_PLATFORM_STATE', 409, 'x') : undefined));
    expect(await runMeetingsImport(deps, job(), attempt)).toBe('skipped');
    expect(calls.deleted).toEqual([KEY]);
  });

  describe('a download over the network', () => {
    const remote = (url = 'https://files.example.test/rec.m4a'): MeetingPlatformAdapter => ({
      provider: 'sandbox',
      hosts: [],
      list: async () => [],
      prepareDownload: async (): Promise<MeetingPlatformDownload> => ({ url, headers: { authorization: 'Bearer token-123' }, format: 'audio', hosts: ['files.example.test'], hostSuffixes: ['.cdn.example.test'] }),
    });
    const stream = (status: number, pieces: number[][], headers: Record<string, string> = {}): NonNullable<MeetingsImportDeps['stream']> => async () =>
      ({
        url: 'https://files.example.test/rec.m4a',
        status,
        headers,
        body: (async function* () {
          for (const piece of pieces) yield new Uint8Array(piece);
        })(),
        destroy: () => undefined,
      }) as EgressStream;

    it('joins the pieces in order, with or without a declared size', async () => {
      for (const headers of [{}, { 'content-length': '5' }]) {
        const { deps, calls } = harness({ adapters: { sandbox: remote() }, stream: stream(200, [[1, 2], [3, 4, 5]], headers) });
        expect(await runMeetingsImport(deps, job(), attempt)).toBe('staged');
        expect([...(calls.stored.get(KEY) ?? [])]).toEqual([1, 2, 3, 4, 5]);
      }
    });

    it('fails a stream that does not match its declared size, and one over the cap by header', async () => {
      const short = harness({ adapters: { sandbox: remote() }, stream: stream(200, [[1, 2]], { 'content-length': '5' }) });
      await expect(runMeetingsImport(short.deps, job(), { retryCount: 0, retryLimit: 3 })).rejects.toThrow();
      const big = harness({ adapters: { sandbox: remote() }, stream: stream(200, [[1]], { 'content-length': String(MEETING_PLATFORM_IMPORT_MAX_BYTES + 1) }) });
      expect(await runMeetingsImport(big.deps, job(), attempt)).toBe('failed');
      expect(recorded(big.calls)).toEqual(['kernel.meeting_platform.import_failed:too_large']);
    });

    it('maps statuses: 401 expired, 404 gone, 503 retries, 400 refused', async () => {
      const cases: Array<[number, string | 'retry']> = [[401, 'connection_expired'], [404, 'recording_gone'], [400, 'platform_refused'], [503, 'retry']];
      for (const [status, expected] of cases) {
        const { deps, calls } = harness({ adapters: { sandbox: remote() }, stream: stream(status, []) });
        if (expected === 'retry') {
          await expect(runMeetingsImport(deps, job(), { retryCount: 0, retryLimit: 3 })).rejects.toThrow();
        } else {
          expect(await runMeetingsImport(deps, job(), attempt)).toBe('failed');
          expect(recorded(calls)).toEqual([`kernel.meeting_platform.import_failed:${expected}`]);
        }
      }
    });

    it('treats a refusal of the egress guard as platform_refused and a size refusal as too_large', async () => {
      for (const [code, expected] of [['blocked', 'platform_refused'], ['too_large', 'too_large']] as const) {
        const { deps, calls } = harness({ adapters: { sandbox: remote() }, stream: async () => Promise.reject(new EgressError(code, 'x')) });
        expect(await runMeetingsImport(deps, job(), attempt)).toBe('failed');
        expect(recorded(calls)).toEqual([`kernel.meeting_platform.import_failed:${expected}`]);
      }
    });

    it('lets the guard talk to the adapter\'s hosts and CDN suffixes only', async () => {
      let allowed: ((host: string) => boolean) | undefined;
      const { deps } = harness({
        adapters: { sandbox: remote() },
        stream: (async (_url: string, _request: unknown, options: { hostAllowed?: (host: string) => boolean }) => {
          allowed = options.hostAllowed;
          return { url: _url, status: 200, headers: {}, body: (async function* () { yield new Uint8Array([1]); })(), destroy: () => undefined } as EgressStream;
        }) as unknown as NonNullable<MeetingsImportDeps['stream']>,
      });
      await runMeetingsImport(deps, job(), attempt);
      expect(allowed?.('files.example.test')).toBe(true);
      expect(allowed?.('a.cdn.example.test')).toBe(true);
      expect(allowed?.('cdn.example.test')).toBe(true);
      expect(allowed?.('evilcdn.example.test')).toBe(false);
      expect(allowed?.('files.example.test.evil.test')).toBe(false);
    });
  });

  it('buffers at most two downloads at once per worker (the pinned concurrency)', () => {
    expect(MEETINGS_IMPORT_CONCURRENCY).toBe(2);
  });
});
