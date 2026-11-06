// SPDX-License-Identifier: AGPL-3.0-only
// Unit and integration tests for crove-media (AI Meeting Notes M3, #2577).
// Tests config allowlist, schemas, HTTP server routes, concurrency limiter,
// error mappings, and client SDK.
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { createMediaClient, MediaClientError } from '../src/client.ts';
import { MediaExecutionError } from '../src/ffmpeg.ts';
import {
  credentialVariables,
  enforcesAllowlist,
  loadMediaConfig,
  unexpectedVariables,
} from '../src/main.ts';
import { createMediaApp, type MediaAppOptions } from '../src/server.ts';
import {
  MEDIA_ERROR_CODES,
  MEDIA_ERROR_STATUS,
  zMediaNormalizeResult,
  zMediaProbeResult,
  zMediaProcessResult,
  zMediaSplitResult,
  type MediaNormalizeResult,
  type MediaProbeResult,
  type MediaProcessResult,
  type MediaSplitResult,
} from '../src/types.ts';

const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) {
    await stop();
  }
});

async function startServer(options: MediaAppOptions = {}): Promise<string> {
  const app = createMediaApp(options);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => {
    server.on('listening', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 8095;

  stops.push(
    () =>
      new Promise<void>((resolve) => {
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        server.close(() => resolve());
      }),
  );

  return `http://127.0.0.1:${port}`;
}

const mockProbe: MediaProbeResult = {
  durationSeconds: 120,
  format: 'ogg',
  hasAudio: true,
  hasVideo: false,
  audioCodec: 'opus',
  audioChannels: 1,
  audioSampleRate: 48000,
  videoCodec: null,
  videoWidth: null,
  videoHeight: null,
};

const mockNormalize: MediaNormalizeResult = {
  durationSeconds: 120,
  format: 'opus',
  channels: 1,
  sampleRate: 48000,
  bitrateKbps: 24,
  audioBase64: Buffer.from('mock-audio-data').toString('base64'),
};

const mockSplit: MediaSplitResult = {
  durationSeconds: 120,
  segmentCount: 1,
  maxSegmentSeconds: 600,
  segments: [
    {
      index: 0,
      startSeconds: 0,
      endSeconds: 120,
      durationSeconds: 120,
      dataBase64: Buffer.from('mock-segment-0').toString('base64'),
    },
  ],
};

const mockProcess: MediaProcessResult = {
  probe: { ...mockProbe, hasVideo: true, videoCodec: 'h264', videoWidth: 1280, videoHeight: 720 },
  normalizedAudioBase64: Buffer.from('mock-proc-audio').toString('base64'),
  durationSeconds: 120,
  segments: mockSplit.segments,
};

describe('crove-media config and allowlist', () => {
  it('loads default configuration cleanly in development', () => {
    const config = loadMediaConfig({ NODE_ENV: 'test' });
    expect(config.PORT).toBe(8095);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.MEDIA_CONCURRENCY).toBe(1);
    expect(config.MEDIA_MAX_QUEUE).toBe(4);
  });

  it('detects credential variable names', () => {
    const env = {
      PORT: '8095',
      DATABASE_URL: 'postgres://...',
      AWS_SECRET_ACCESS_KEY: 'secret',
      API_KEY: 'key',
    };
    expect(credentialVariables(env)).toEqual(['API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DATABASE_URL']);
  });

  it('detects unexpected variables', () => {
    const env = {
      PORT: '8095',
      EXTRA_SETTING: '1',
      UNKNOWN_VAR: 'val',
    };
    expect(unexpectedVariables(env)).toEqual(['EXTRA_SETTING', 'UNKNOWN_VAR']);
  });

  it('refuses to start when unexpected variables are present in production', () => {
    const env = {
      NODE_ENV: 'production',
      PORT: '8095',
      EXTRA_SETTING: '1',
    };
    expect(() => loadMediaConfig(env)).toThrow(/crove-media runs with its own settings only; remove EXTRA_SETTING/);
  });

  it('refuses to start when image marker exists, even if NODE_ENV=development', () => {
    // When markerPath exists, allowlist is always enforced
    expect(enforcesAllowlist({ NODE_ENV: 'development' }, process.execPath)).toBe(true);
  });
});

describe('crove-media contract schemas', () => {
  it('validates probe result schema', () => {
    expect(zMediaProbeResult.parse(mockProbe)).toEqual(mockProbe);
  });

  it('validates normalize result schema', () => {
    expect(zMediaNormalizeResult.parse(mockNormalize)).toEqual(mockNormalize);
  });

  it('validates split result schema', () => {
    expect(zMediaSplitResult.parse(mockSplit)).toEqual(mockSplit);
  });

  it('validates process result schema', () => {
    expect(zMediaProcessResult.parse(mockProcess)).toEqual(mockProcess);
  });

  it('maps all error codes to appropriate HTTP status codes', () => {
    for (const code of MEDIA_ERROR_CODES) {
      const status = MEDIA_ERROR_STATUS[code];
      expect(typeof status).toBe('number');
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });
});

describe('crove-media HTTP server & client SDK', () => {
  it('responds 200 on /healthz', async () => {
    const baseUrl = await startServer();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, service: 'crove-media' });
  });

  it('rejects empty payload with 400 bad_request', async () => {
    const baseUrl = await startServer();
    const client = createMediaClient(baseUrl);
    await expect(client.probe(new Uint8Array(0))).rejects.toThrowError(MediaClientError);
  });

  it('rejects payload exceeding maxInputBytes with 413 too_large', async () => {
    const baseUrl = await startServer({ maxInputBytes: 100 });
    const client = createMediaClient(baseUrl);
    const largePayload = new Uint8Array(200).fill(1);
    await expect(client.probe(largePayload)).rejects.toMatchObject({
      code: 'too_large',
      status: 413,
    });
  });

  it('runs probe with client SDK', async () => {
    const baseUrl = await startServer({
      runProbe: async () => mockProbe,
    });
    const client = createMediaClient(baseUrl);
    const result = await client.probe(new Uint8Array([1, 2, 3]));
    expect(result).toEqual(mockProbe);
  });

  it('runs normalize with client SDK', async () => {
    const baseUrl = await startServer({
      runNormalize: async () => mockNormalize,
    });
    const client = createMediaClient(baseUrl);
    const result = await client.normalize(new Uint8Array([1, 2, 3]), { bitrateKbps: 24 });
    expect(result).toEqual(mockNormalize);
  });

  it('runs split with client SDK', async () => {
    const baseUrl = await startServer({
      runSplit: async () => mockSplit,
    });
    const client = createMediaClient(baseUrl);
    const result = await client.split(new Uint8Array([1, 2, 3]), { maxSegmentSeconds: 600 });
    expect(result).toEqual(mockSplit);
  });

  it('runs repackage-video with client SDK', async () => {
    const mockBinary = new Uint8Array([10, 20, 30]);
    const baseUrl = await startServer({
      runRepackageVideo: async () => ({ durationSeconds: 60, format: 'mp4', hasAudio: false }),
    });
    const client = createMediaClient(baseUrl);
    const result = await client.repackageVideo(mockBinary, { dropAudio: true });
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3]);
  });

  it('runs process with client SDK', async () => {
    const baseUrl = await startServer({
      runProcess: async () => mockProcess,
    });
    const client = createMediaClient(baseUrl);
    const result = await client.process(new Uint8Array([1, 2, 3]));
    expect(result).toEqual(mockProcess);
  });

  it('returns typed error when media execution throws MediaExecutionError', async () => {
    const baseUrl = await startServer({
      runProbe: async () => {
        throw new MediaExecutionError('malformed_media', 'Corrupted media file');
      },
    });
    const client = createMediaClient(baseUrl);
    await expect(client.probe(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: 'malformed_media',
      status: 422,
      message: 'Corrupted media file',
    });
  });

  it('enforces concurrency and queue limits, returning 503 busy when queue is full', async () => {
    let unblock: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      unblock = resolve;
    });

    const baseUrl = await startServer({
      concurrency: 1,
      maxQueue: 1,
      runProbe: async () => {
        await blocker;
        return mockProbe;
      },
    });
    const client = createMediaClient(baseUrl);
    const dummy = new Uint8Array([1, 2, 3]);

    // Task 1: active
    const p1 = client.probe(dummy);
    // Task 2: queued (queue length = 1)
    const p2 = client.probe(dummy);
    // Task 3: exceeds queue limit (queue full) -> 503 busy
    await expect(client.probe(dummy)).rejects.toMatchObject({
      code: 'busy',
      status: 503,
    });

    unblock();
    await expect(p1).resolves.toEqual(mockProbe);
    await expect(p2).resolves.toEqual(mockProbe);
  });

  it('strictly limits concurrency across sequential waves and direct slot handoff', async () => {
    let currentConcurrent = 0;
    let maxConcurrent = 0;

    const baseUrl = await startServer({
      concurrency: 1,
      maxQueue: 4,
      runProbe: async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 20));
        currentConcurrent--;
        return mockProbe;
      },
    });
    const client = createMediaClient(baseUrl);
    const dummy = new Uint8Array([1, 2, 3]);

    const [r1, r2, r3] = await Promise.all([
      client.probe(dummy),
      client.probe(dummy),
      client.probe(dummy),
    ]);
    expect(r1).toEqual(mockProbe);
    expect(r2).toEqual(mockProbe);
    expect(r3).toEqual(mockProbe);
    expect(maxConcurrent).toBe(1);
  });

  it('rejects audio payloads exceeding maxAudioBytes on audio endpoints', async () => {
    const baseUrl = await startServer({
      maxInputBytes: 200,
    });
    const client = createMediaClient(baseUrl);
    const oversized = new Uint8Array(250);
    await expect(client.normalize(oversized)).rejects.toMatchObject({
      code: 'too_large',
      status: 413,
    });
  });
});
