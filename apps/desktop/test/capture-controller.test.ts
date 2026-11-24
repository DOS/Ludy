// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for desktop capture pipeline: meeting window recognition, RMS silence alerts, live chunk queue,
// local disk recovery store, consent-before-audio ordering, Win10 fallback policy, 409 handling, and build skip on non-win32.
import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createCaptureController,
  type CaptureDraft,
  type CaptureSessionInfo,
  type ConsentWindowViewState,
  type PillViewState,
} from '../src/capture/controller.ts';
import {
  createDesktopCaptureModule,
  createPcmFrameChunker,
  type ElectronWorkerBridge,
} from '../src/capture/desktop-capture.ts';
import {
  ProcessLoopbackUnsupportedError,
  type CaptureModule,
  type CaptureStartOptions,
} from '../src/capture/interface.ts';
import { createSilenceMonitor, rmsFloat32, rmsInt16Interleaved } from '../src/capture/levels.ts';
import { createDesktopLiveSender, createDiskRecordingStore } from '../src/capture/live-sender.ts';
import { PCM_WORKLET_NAME, registerPcmWorklet } from '../src/capture/ui/pcm-worklet.ts';
import { bootCaptureWorker } from '../src/capture/ui/worker.ts';
import {
  classifyMeetingWindow,
  listMeetingWindows,
  sanitizePastedJoinUrl,
  selectOfferedWindows,
} from '../src/capture/windows.ts';
import type { FetchLike } from '../src/exchange.ts';
import type { CaptureTrayState } from '../src/tray-model.ts';

const TOKEN = `crx_${'d'.repeat(43)}`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function makeDraft(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    title: 'Weekly Team Sync',
    consentMethod: 'told_at_start',
    consentAgreed: true,
    noticeLanguage: 'vi',
    liveNotes: false,
    source: 'system-audio-and-microphone',
    ...overrides,
  };
}

function makeSession(overrides: Partial<CaptureSessionInfo> = {}): CaptureSessionInfo {
  return {
    ludyUrl: 'https://ludy.example.vn',
    token: TOKEN,
    uploads: 'direct',
    meetingsEnabled: true,
    agendaEnabled: true,
    ...overrides,
  };
}

describe('meeting window classification & join URL sanitization', () => {
  it('recognizes Zoom, Microsoft Teams (classic & new), Zalo PC, and Slack by executable basename', () => {
    const raw = [
      { hwnd: '0x1', pid: 101, exe: 'Zoom.exe', title: 'Zoom Meeting' },
      { hwnd: '0x2', pid: 102, exe: 'ms-teams.exe', title: 'Design Review | Microsoft Teams' },
      { hwnd: '0x3', pid: 103, exe: 'Teams.exe', title: 'Classic Teams' },
      { hwnd: '0x4', pid: 104, exe: 'Zalo.exe', title: 'Zalo Call' },
      { hwnd: '0x5', pid: 105, exe: 'Slack.exe', title: 'Huddle - #eng - Slack' },
      { hwnd: '0x6', pid: 106, exe: 'chrome.exe', title: 'Google Meet' },
      { hwnd: '0x7', pid: 107, exe: 'Zoom.exe', title: 'Default IME' },
      { hwnd: '0x8', pid: 101, exe: 'Zoom.exe', title: 'Zoom Toolbar Duplicate PID' },
    ];
    expect(classifyMeetingWindow(raw[5]!)).toBeNull();
    expect(classifyMeetingWindow(raw[6]!)).toBeNull();
    const offered = selectOfferedWindows(raw);
    expect(offered.map((w) => ({ pid: w.pid, client: w.client, appName: w.appName }))).toEqual([
      { pid: 101, client: 'zoom', appName: 'Zoom' },
      { pid: 102, client: 'teams', appName: 'Microsoft Teams' },
      { pid: 103, client: 'teams', appName: 'Microsoft Teams' },
      { pid: 104, client: 'zalo', appName: 'Zalo PC' },
      { pid: 105, client: 'slack', appName: 'Slack' },
    ]);
  });

  it('keeps only clean https join origin + path and drops query tokens or insecure URLs', () => {
    expect(sanitizePastedJoinUrl('https://meet.google.com/abc-defg-hij?authuser=1#frag')).toBe('https://meet.google.com/abc-defg-hij');
    expect(sanitizePastedJoinUrl('https://zoom.us/j/123456?pwd=secret')).toBe('https://zoom.us/j/123456');
    expect(sanitizePastedJoinUrl('http://zoom.us/j/123')).toBeUndefined();
    expect(sanitizePastedJoinUrl('https://user:pass@zoom.us/j/123')).toBeUndefined();
    expect(sanitizePastedJoinUrl('not a url')).toBeUndefined();
  });

  it('parses helper --list-windows JSON safely and tolerates non-zero exit', async () => {
    const windows = await listMeetingWindows({
      exePath: 'C:\\fake\\ludy-wasapi-loopback.exe',
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify([{ hwnd: '0x11', pid: 400, exe: 'Zalo.exe', title: 'Cuoc goi' }]),
        stderr: '',
      }),
    });
    expect(windows).toEqual([{ hwnd: '0x11', pid: 400, client: 'zalo', appName: 'Zalo PC', title: 'Cuoc goi' }]);

    const empty = await listMeetingWindows({
      exePath: 'C:\\fake\\ludy-wasapi-loopback.exe',
      exec: async () => ({ code: 1, stdout: '', stderr: 'fail' }),
    });
    expect(empty).toEqual([]);
  });
});

describe('RMS levels & silence monitor', () => {
  it('computes RMS on Int16 PCM and Float32 samples and alerts once after consecutive silent ticks', () => {
    const silence = new Uint8Array(16);
    expect(rmsInt16Interleaved(silence)).toBe(0);
    expect(rmsFloat32(new Float32Array(16))).toBe(0);

    const loud = new Uint8Array(4);
    const dv = new DataView(loud.buffer);
    dv.setInt16(0, 16384, true);
    dv.setInt16(2, -16384, true);
    expect(rmsInt16Interleaved(loud)).toBeCloseTo(0.5, 4);
    expect(rmsFloat32(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5, 6);

    const monitor = createSilenceMonitor({ checkLoopback: true, checkMic: true, silenceThreshold: 1e-4, ticksBeforeAlert: 7 });
    for (let i = 0; i < 6; i += 1) {
      const snap = monitor.recordTick(0, 0.05);
      expect(snap.newlyTriggered).toEqual([]);
    }
    const triggered = monitor.recordTick(0, 0.05);
    expect(triggered.loopbackSilent).toBe(true);
    expect(triggered.micSilent).toBe(false);
    expect(triggered.newlyTriggered).toEqual(['silent-loopback']);

    const repeated = monitor.recordTick(0, 0);
    expect(repeated.newlyTriggered).toEqual([]);

    const recovered = monitor.recordTick(0.02, 0.02);
    expect(recovered.loopbackSilent).toBe(false);
    expect(recovered.micSilent).toBe(false);
  });
});

describe('live sender & disk recovery store', () => {
  it('keeps header seq 0 during queue overflow, retries transient 503, and stops permanently on 409', async () => {
    const sentSeqs: number[] = [];
    let attempts = 0;
    let releaseFirstSend: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    const sender = createDesktopLiveSender({
      maxQueue: 2,
      maxRetries: 2,
      baseDelayMs: 1,
      sleep: async () => undefined,
      send: async (piece) => {
        if (piece.seq === 0) await gate;
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('busy'), { status: 503 });
        sentSeqs.push(piece.seq);
      },
    });
    sender.push(new Uint8Array([1]), 'audio/webm', 15000);
    sender.push(new Uint8Array([2]), 'audio/webm', 15000);
    sender.push(new Uint8Array([3]), 'audio/webm', 15000);
    sender.push(new Uint8Array([4]), 'audio/webm', 15000);
    releaseFirstSend!();
    await sender.finish({ timeoutMs: 2000 });
    expect(sentSeqs).toEqual([0, 2, 3]);
    expect(sender.status().dropped).toBe(1);

    const permanentSender = createDesktopLiveSender({
      maxRetries: 3,
      sleep: async () => undefined,
      send: async () => {
        throw Object.assign(new Error('conflict'), { status: 409 });
      },
    });
    permanentSender.push(new Uint8Array([9]), 'audio/webm', 15000);
    await permanentSender.finish({ timeoutMs: 1000 });
    expect(permanentSender.status().stopped).toBe(true);
    expect(permanentSender.status().dropped).toBe(1);
  });

  it('writes ordered chunks to disk, assembles identically, and removes recovery directory cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludy-store-'));
    try {
      const store = createDiskRecordingStore(root);
      await store.prepareDir('rec-1');
      await store.appendChunk('rec-1', 1, new Uint8Array([4, 5]));
      await store.appendChunk('rec-1', 0, new Uint8Array([1, 2, 3]));
      const assembled = await store.assemble('rec-1');
      expect(Array.from(assembled)).toEqual([1, 2, 3, 4, 5]);
      await store.remove('rec-1');
      expect(await readdir(join(root, 'recordings'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('capture controller (consent, Win10 fallback policy, 409 lock, heartbeat, upload)', () => {
  it('blocks missing consent before probing audio or calling the server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludy-ctrl-'));
    try {
      let fetchCalls = 0;
      let startCalls = 0;
      const consentViews: ConsentWindowViewState[] = [];
      const controller = createCaptureController({
        capture: {
          async start() {
            startCalls += 1;
          },
          async stop() {},
          pieces: (async function* () {})(),
        },
        recordingStore: createDiskRecordingStore(root),
        fetch: async () => {
          fetchCalls += 1;
          return json(200, {});
        },
        listWindows: async () => [],
        getSession: () => makeSession(),
        onTrayState: () => undefined,
        ui: {
          updateConsentState: (s) => consentViews.push(s),
          showPill: () => undefined,
          updatePill: () => undefined,
          hidePill: () => undefined,
          closeConsent: () => undefined,
        },
      });
      const res = await controller.startCapture(makeDraft({ consentAgreed: false }));
      expect(res.ok).toBe(false);
      expect(startCalls).toBe(0);
      expect(fetchCalls).toBe(0);
      expect(consentViews.at(-1)?.error).toContain('xác nhận');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('never falls back silently on Win10 unsupported loopback until user ticks allowSystemFallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludy-win10-'));
    try {
      const seenFallbackFlags: Array<boolean | undefined> = [];
      let createCalls = 0;
      const consentViews: ConsentWindowViewState[] = [];
      const capture: CaptureModule = {
        async start(_s, _k, options) {
          seenFallbackFlags.push(options?.allowSystemFallback);
          if (!options?.allowSystemFallback) throw new ProcessLoopbackUnsupportedError();
        },
        async stop() {},
        pieces: (async function* () {})(),
      };
      const controller = createCaptureController({
        capture,
        recordingStore: createDiskRecordingStore(root),
        fetch: async (url) => {
          if (String(url).endsWith('/api/rpc/meetings/create')) {
            createCalls += 1;
            return json(200, { json: { meetingId: 'm-win10' } });
          }
          return json(200, {});
        },
        listWindows: async () => [],
        getSession: () => makeSession(),
        onTrayState: () => undefined,
        ui: {
          updateConsentState: (s) => consentViews.push(s),
          showPill: () => undefined,
          updatePill: () => undefined,
          hidePill: () => undefined,
          closeConsent: () => undefined,
        },
      });

      const first = await controller.startCapture(makeDraft({ noticeLanguage: 'en' }));
      expect(first.ok).toBe(false);
      expect(first.systemFallbackRequired).toBe(true);
      expect(createCalls).toBe(0);
      expect(consentViews.at(-1)?.systemFallbackRequired).toBe(true);
      expect(consentViews.at(-1)?.error).toContain('does not support per-app audio loopback');

      const second = await controller.startCapture(makeDraft({ noticeLanguage: 'en', allowSystemFallback: true }));
      expect(second).toEqual({ ok: true, meetingId: 'm-win10' });
      expect(seenFallbackFlags).toEqual([undefined, true]);
      await controller.stopCapture('user');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops cleanly on 409 CAPTURE_ALREADY_RUNNING with zero audio pieces stored or sent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludy-409-'));
    try {
      let stopped = false;
      const store = createDiskRecordingStore(root);
      const sentUrls: string[] = [];
      const controller = createCaptureController({
        capture: {
          async start() {},
          async stop() {
            stopped = true;
          },
          pieces: {
            async *[Symbol.asyncIterator]() {
              yield { sequence: 0, offsetMs: 0, mimeType: 'audio/webm', data: new Uint8Array([1, 2, 3]) };
            },
          },
        },
        recordingStore: store,
        fetch: async (url) => {
          sentUrls.push(String(url));
          return json(409, {
            code: 'CAPTURE_ALREADY_RUNNING',
            message: 'Already recording',
            data: { kind: 'extension', since: '2026-11-24T09:00:00.000Z' },
          });
        },
        listWindows: async () => [],
        getSession: () => makeSession(),
        onTrayState: () => undefined,
        ui: {
          updateConsentState: () => undefined,
          showPill: () => undefined,
          updatePill: () => undefined,
          hidePill: () => undefined,
          closeConsent: () => undefined,
        },
      });

      const res = await controller.startCapture(makeDraft());
      expect(res.ok).toBe(false);
      expect(res.error).toContain('Tiện ích Ludy đang ghi cuộc họp này từ ');
      expect(stopped).toBe(true);
      expect(sentUrls).toEqual(['https://ludy.example.vn/api/rpc/meetings/create']);
      expect(await readdir(join(root, 'recordings'))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('runs heartbeat, live chunks, silent alerts, presigned upload, and cleanup across a full recording', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludy-full-'));
    try {
      const requests: Array<{ url: string; method: string; body: unknown }> = [];
      const intervals: Array<{ ms: number; cb: () => void }> = [];
      const trayPatches: Array<Partial<CaptureTrayState>> = [];
      const pillsShown: PillViewState[] = [];
      const pillsUpdated: PillViewState[] = [];
      let captureOpts: CaptureStartOptions | undefined;
      let piecesStopped = false;
      let wakePieces: (() => void) | null = null;
      let clock = 10_000;

      const fetchImpl: FetchLike = async (url, init) => {
        const u = String(url);
        let body: unknown = null;
        if (typeof init?.body === 'string') {
          try {
            body = JSON.parse(init.body);
          } catch {
            body = init.body;
          }
        }
        requests.push({ url: u, method: init?.method ?? 'GET', body });
        if (u.endsWith('/api/rpc/meetings/create')) return json(200, { json: { meetingId: 'mtg-123' } });
        if (u.endsWith('/api/rpc/meetings/captureHeartbeat')) return json(200, { json: { open: true } });
        if (u.includes('/live-chunk')) return json(200, { ok: true });
        if (u.endsWith('/api/files/uploads')) {
          return json(200, { uploadId: 'up-1', url: 'https://storage.example.vn/upload', fields: { key: 'k' } });
        }
        if (u === 'https://storage.example.vn/upload') return new Response(null, { status: 204 });
        if (u.endsWith('/api/meetings/mtg-123/media')) return json(200, { fileId: 'file-1' });
        return json(200, {});
      };

      const controller = createCaptureController({
        capture: {
          async start(_s, _k, opts) {
            captureOpts = opts;
          },
          async stop() {
            piecesStopped = true;
            wakePieces?.();
            wakePieces = null;
          },
          pieces: {
            async *[Symbol.asyncIterator]() {
              yield { sequence: 0, offsetMs: 0, mimeType: 'audio/webm;codecs=opus', data: new Uint8Array([10, 20, 30]) };
              if (!piecesStopped) {
                await new Promise<void>((resolve) => {
                  wakePieces = resolve;
                });
              }
            },
          },
        },
        recordingStore: createDiskRecordingStore(root),
        fetch: fetchImpl,
        listWindows: async () => [{ hwnd: '0x1', pid: 42, client: 'zoom', appName: 'Zoom', title: 'Sync' }],
        getSession: () => makeSession({ uploads: 'presigned' }),
        onTrayState: (p) => trayPatches.push(p),
        now: () => clock,
        setInterval: (cb, ms) => {
          const entry = { cb, ms };
          intervals.push(entry);
          return entry;
        },
        clearInterval: () => undefined,
        ui: {
          updateConsentState: () => undefined,
          showPill: (p) => pillsShown.push(p),
          updatePill: (p) => pillsUpdated.push(p),
          hidePill: () => undefined,
          closeConsent: () => undefined,
        },
      });

      const started = await controller.startCapture(
        makeDraft({
          liveNotes: true,
          targetPid: 42,
          agendaId: 'ag-1',
          joinUrl: 'https://zoom.us/j/555?pwd=ignored',
        }),
      );
      expect(started).toEqual({ ok: true, meetingId: 'mtg-123' });
      expect(pillsShown[0]?.meetingId).toBe('mtg-123');
      expect(requests[0]?.url).toBe('https://ludy.example.vn/api/rpc/meetings/create');
      expect(requests[0]?.body).toMatchObject({
        json: {
          title: 'Weekly Team Sync',
          consentMethod: 'told_at_start',
          consentNoticeVersion: '2026-11-v1',
          liveNotes: true,
          capture: { agendaId: 'ag-1', joinUrl: 'https://zoom.us/j/555' },
        },
      });

      // Trigger 30 s heartbeat + silent track warning + live chunk
      expect(intervals.some((t) => t.ms === 30_000)).toBe(true);
      intervals.find((t) => t.ms === 30_000)?.cb();
      captureOpts?.onSilentAlert?.('silent-loopback');
      expect(pillsUpdated.at(-1)?.warning).toContain('Không nghe thấy âm thanh từ ứng dụng họp');
      expect(trayPatches.at(-1)?.warning).toContain('Không nghe thấy âm thanh');

      captureOpts?.onLiveChunk?.({ bytes: new Uint8Array([9, 8, 7]), mimeType: 'audio/webm;codecs=opus', durationMs: 15_000 });
      clock += 25_000;
      await controller.stopCapture('user');

      expect(requests.some((r) => r.url.includes('/api/meetings/mtg-123/live-chunk?seq=0&lengthSeconds=15'))).toBe(true);
      expect(requests.some((r) => r.url.endsWith('/api/rpc/meetings/captureHeartbeat') && JSON.stringify(r.body).includes('"end":true'))).toBe(true);
      expect(requests.some((r) => r.url === 'https://storage.example.vn/upload')).toBe(true);
      expect(requests.some((r) => r.url.endsWith('/api/meetings/mtg-123/media'))).toBe(true);
      expect(await readdir(join(root, 'recordings'))).toEqual([]);
      expect(controller.phase()).toBe('idle');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('calls recordingStopped and preserves local chunks when media upload fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludy-failup-'));
    try {
      const store = createDiskRecordingStore(root);
      const urls: string[] = [];
      let piecesStopped = false;
      let wakePieces: (() => void) | null = null;
      const controller = createCaptureController({
        capture: {
          async start() {},
          async stop() {
            piecesStopped = true;
            wakePieces?.();
            wakePieces = null;
          },
          pieces: {
            async *[Symbol.asyncIterator]() {
              yield { sequence: 0, offsetMs: 0, mimeType: 'audio/webm', data: new Uint8Array([77, 88]) };
              if (!piecesStopped) {
                await new Promise<void>((resolve) => {
                  wakePieces = resolve;
                });
              }
            },
          },
        },
        recordingStore: store,
        fetch: async (url) => {
          const u = String(url);
          urls.push(u);
          if (u.endsWith('/api/rpc/meetings/create')) return json(200, { json: { meetingId: 'mtg-fail' } });
          if (u.includes('/media')) return json(500, { code: 'INTERNAL_ERROR' });
          return json(200, { json: { open: true } });
        },
        listWindows: async () => [],
        getSession: () => makeSession({ uploads: 'direct' }),
        onTrayState: () => undefined,
        ui: {
          updateConsentState: () => undefined,
          showPill: () => undefined,
          updatePill: () => undefined,
          hidePill: () => undefined,
          closeConsent: () => undefined,
        },
      });

      await controller.startCapture(makeDraft());
      await controller.stopCapture('mic_lost');
      expect(urls.some((u) => u.endsWith('/api/rpc/meetings/recordingStopped'))).toBe(true);
      expect(await store.assemble('mtg-fail')).toEqual(new Uint8Array(0));
      const preserved = await readdir(join(root, 'recordings'));
      expect(preserved.length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces initial micMissing alert on start and omits reason on user recordingStopped (B5, NB5)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludy-micmiss-'));
    try {
      const trayPatches: Array<Partial<CaptureTrayState>> = [];
      const pillsShown: PillViewState[] = [];
      const stoppedPayloads: Array<Record<string, unknown>> = [];
      const controller = createCaptureController({
        capture: {
          async start(_s, _k, opts) {
            opts?.onMicMissing?.();
          },
          async stop() {},
          pieces: (async function* () {})(),
        },
        recordingStore: createDiskRecordingStore(root),
        fetch: async (url, init) => {
          const u = String(url);
          if (u.endsWith('/api/rpc/meetings/create')) return json(200, { json: { meetingId: 'mtg-mic' } });
          if (u.endsWith('/api/rpc/meetings/recordingStopped')) {
            stoppedPayloads.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          }
          return json(200, { json: { open: true } });
        },
        listWindows: async () => [],
        getSession: () => makeSession({ uploads: 'direct' }),
        onTrayState: (p) => trayPatches.push(p),
        ui: {
          updateConsentState: () => undefined,
          showPill: (p) => pillsShown.push(p),
          updatePill: () => undefined,
          hidePill: () => undefined,
          closeConsent: () => undefined,
        },
      });

      await controller.startCapture(makeDraft());
      expect(pillsShown[0]?.warning).toContain('Micro đang im lặng hoặc chưa bật');
      expect(trayPatches.some((p) => p.warning?.includes('Micro đang im lặng'))).toBe(true);

      await controller.stopCapture('user');
      expect(stoppedPayloads.length).toBe(1);
      const rpcJson = stoppedPayloads[0]?.json as Record<string, unknown>;
      expect('reason' in rpcJson).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('PCM 4-byte framing, worker startup cleanup, WASAPI ready handshake & MediaRecorder flush', () => {
  it('buffers 0..3 remainder bytes in createPcmFrameChunker and guards worklet misalignment (B4)', () => {
    const emitted: Uint8Array[] = [];
    const chunker = createPcmFrameChunker((buf) => emitted.push(new Uint8Array(buf)));

    chunker.push(new Uint8Array([1, 2, 3, 4, 5])); // 4n+1 -> emits 4, keeps 1
    chunker.push(new Uint8Array([6, 7, 8, 9, 10, 11])); // 1+6 = 7 (4n+3) -> emits 4, keeps 3
    chunker.push(new Uint8Array([12, 13, 14, 15, 16, 17])); // 3+6 = 9 (4n+1) -> emits 8, keeps 1
    chunker.push(new Uint8Array([18, 19])); // 1+2 = 3 (4n+3) -> emits 0, keeps 3
    chunker.push(new Uint8Array([20])); // 3+1 = 4 -> emits 4, keeps 0

    for (const piece of emitted) expect(piece.byteLength % 4).toBe(0);
    expect(Array.from(Buffer.concat(emitted))).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    // Direct worklet check with malformed 4n+2 payload truncates cleanly without throwing RangeError.
    const g = globalThis as Record<string, unknown>;
    const prevProc = g.AudioWorkletProcessor;
    const prevReg = g.registerProcessor;
    try {
      class FakeAudioWorkletProcessor {
        port = { onmessage: null as ((ev: { data: ArrayBuffer }) => void) | null };
      }
      let registeredCtor: (new () => FakeAudioWorkletProcessor & { process(i: Float32Array[][], o: Float32Array[][]): boolean }) | null = null;
      g.AudioWorkletProcessor = FakeAudioWorkletProcessor;
      g.registerProcessor = (name: string, ctor: typeof registeredCtor) => {
        if (name === PCM_WORKLET_NAME) registeredCtor = ctor;
      };
      registerPcmWorklet();
      const proc = new registeredCtor!();
      const malformed = new Uint8Array(6);
      const dv = new DataView(malformed.buffer);
      dv.setInt16(0, 16384, true);
      dv.setInt16(2, -16384, true);
      dv.setInt16(4, 32767, true);
      expect(() => proc.port.onmessage?.({ data: malformed.buffer })).not.toThrow();
      const left = new Float32Array(2);
      const right = new Float32Array(2);
      proc.process([], [[left, right]]);
      expect(left[0]).toBeCloseTo(0.5, 4);
      expect(right[0]).toBeCloseTo(-0.5, 4);
      expect(left[1]).toBe(0);
    } finally {
      g.AudioWorkletProcessor = prevProc;
      g.registerProcessor = prevReg;
    }
  });

  it('cleans worker/helper/fallback state if worker startup rejects and supports restart (B3, B8)', async () => {
    let workerClosed = 0;
    let disarmed = 0;
    let armed = 0;
    let sentPcm: Uint8Array[] = [];
    let readyOutcome: { ok: boolean; error?: string } = { ok: false, error: 'NO_MIC' };
    let fakeProc: (EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean }) | null = null;

    const bridge: ElectronWorkerBridge = {
      async openWorkerWindow() {
        return {
          webContentsId: 77,
          sendStart: () => {
            queueMicrotask(() => readyHandlers.forEach((cb) => cb(readyOutcome)));
          },
          sendStop: () => {
            queueMicrotask(() => stopHandlers.forEach((cb) => cb()));
          },
          sendPcm: (buf) => sentPcm.push(new Uint8Array(buf)),
          close: () => {
            workerClosed += 1;
          },
        };
      },
      armSystemFallback: () => {
        armed += 1;
      },
      disarmSystemFallback: () => {
        disarmed += 1;
      },
      onWorkerReady: (cb) => {
        readyHandlers.add(cb);
        return () => readyHandlers.delete(cb);
      },
      onWorkerStopped: (cb) => {
        stopHandlers.add(cb);
        return () => stopHandlers.delete(cb);
      },
      onWorkerChunk: () => () => undefined,
      onWorkerLevels: () => () => undefined,
      onWorkerEnded: () => () => undefined,
    };
    const readyHandlers = new Set<(res: { ok: boolean; error?: string }) => void>();
    const stopHandlers = new Set<() => void>();

    const makeFakeChild = () => {
      const ee = new EventEmitter() as EventEmitter & {
        stdin: PassThrough;
        stdout: PassThrough;
        stderr: PassThrough;
        kill(): boolean;
      };
      ee.stdin = new PassThrough();
      ee.stdout = new PassThrough();
      ee.stderr = new PassThrough();
      ee.kill = () => {
        ee.emit('exit', 0);
        return true;
      };
      return ee;
    };

    const mod = createDesktopCaptureModule({
      isPackaged: false,
      resourcesPath: '',
      bridge,
      startupTimeoutMs: 40,
      resolveHelperPath: () => 'C:\\fake\\ludy-wasapi-loopback.exe',
      spawnHelper: () => {
        fakeProc = makeFakeChild();
        return fakeProc as unknown as ChildProcessWithoutNullStreams;
      },
    });

    // Startup timeout without WASAPI_READY sentinel rejects cleanly (no blind 400ms pass).
    await expect(mod.start('system-audio-and-microphone', '', { targetPid: 100 })).rejects.toThrow(/WASAPI_READY/);
    expect(disarmed).toBeGreaterThanOrEqual(1);

    // Worker failing ready after system-fallback cleans up queue, closes worker, and disarms fallback.
    readyOutcome = { ok: false, error: 'NO_MIC' };
    await expect(mod.start('system-audio', '', { allowSystemFallback: true })).rejects.toThrow('NO_MIC');
    expect(armed).toBe(1);
    expect(disarmed).toBeGreaterThanOrEqual(2);
    expect(workerClosed).toBe(1);
    expect(() => mod.pieces).toThrow('capture is not running');

    // Second start recovers cleanly when WASAPI_READY + worker ok both succeed, aligning 4n+1 PCM stdout splits.
    readyOutcome = { ok: true };
    const startPromise = createDesktopCaptureModule({
      isPackaged: false,
      resourcesPath: '',
      bridge,
      startupTimeoutMs: 200,
      resolveHelperPath: () => 'C:\\fake\\ludy-wasapi-loopback.exe',
      spawnHelper: () => {
        fakeProc = makeFakeChild();
        queueMicrotask(() => fakeProc?.stderr.write('WASAPI_READY\n'));
        return fakeProc as unknown as ChildProcessWithoutNullStreams;
      },
    });
    await startPromise.start('system-audio-and-microphone', '', { targetPid: 200 });
    fakeProc!.stdout.write(Buffer.from([1, 2, 3, 4, 5]));
    fakeProc!.stdout.write(Buffer.from([6, 7, 8]));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sentPcm.every((b) => b.byteLength % 4 === 0)).toBe(true);
    expect(Array.from(Buffer.concat(sentPcm))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await startPromise.stop();
  });

  it('awaits pending Blob.arrayBuffer() before firing workerStopped (NB2)', async () => {
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g.window;
    const prevAudioCtx = g.AudioContext;
    const prevMediaRecorder = g.MediaRecorder;

    try {
      let startHandler: ((cfg: { source: string; mode: string; liveNotes: boolean }) => void) | null = null;
      let stopHandler: (() => Promise<void> | void) | null = null;
      const events: string[] = [];
      const releaseReads: Array<() => void> = [];

      g.AudioContext = class {
        createMediaStreamDestination() {
          return { stream: {} };
        }
        async close() {}
      };

      class FakeMediaRecorder {
        state = 'recording';
        mimeType = 'audio/webm';
        ondataavailable: ((ev: { data: { size: number; arrayBuffer(): Promise<ArrayBuffer> } }) => void) | null = null;
        private stopListeners: Array<() => void> = [];
        static isTypeSupported(t: string) {
          return t === 'audio/webm;codecs=opus';
        }
        constructor(_stream: unknown, opts?: { audioBitsPerSecond?: number }) {
          if (opts?.audioBitsPerSecond) events.push(`bps:${opts.audioBitsPerSecond}`);
        }
        addEventListener(type: string, cb: () => void) {
          if (type === 'stop') this.stopListeners.push(cb);
        }
        start() {}
        stop() {
          this.state = 'inactive';
          this.ondataavailable?.({
            data: {
              size: 4,
              arrayBuffer: () =>
                new Promise<ArrayBuffer>((resolve) => {
                  releaseReads.push(() => resolve(new Uint8Array([1, 2, 3, 4]).buffer));
                }),
            },
          });
          for (const cb of this.stopListeners) cb();
        }
      }
      g.MediaRecorder = FakeMediaRecorder;
      g.window = {
        ludyDesktopBridge: {
          onWorkerStart: (cb: typeof startHandler) => {
            startHandler = cb;
            return () => undefined;
          },
          onWorkerStop: (cb: typeof stopHandler) => {
            stopHandler = cb;
            return () => undefined;
          },
          onWorkerPcm: () => () => undefined,
          workerReady: () => events.push('ready'),
          workerStopped: () => events.push('stopped'),
          workerChunk: (c: { kind: string }) => events.push(`chunk:${c.kind}`),
          workerLevels: () => undefined,
          workerUnexpectedEnd: () => undefined,
        },
      };

      bootCaptureWorker();
      startHandler!({ source: 'system-audio', mode: 'mic-only', liveNotes: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(events).toContain('bps:64000');
      expect(events).toContain('ready');

      const stopPromise = Promise.resolve(stopHandler!());
      await new Promise((resolve) => setTimeout(resolve, 10));
      // workerStopped must still be blocked on pending main + live Blob.arrayBuffer() reads!
      expect(events).not.toContain('stopped');
      expect(releaseReads.length).toBe(2);
      for (const release of releaseReads) release();
      await stopPromise;
      expect(events.indexOf('chunk:main')).toBeLessThan(events.indexOf('stopped'));
      expect(events.indexOf('chunk:live')).toBeLessThan(events.indexOf('stopped'));
    } finally {
      g.window = prevWindow;
      g.AudioContext = prevAudioCtx;
      g.MediaRecorder = prevMediaRecorder;
    }
  });
});

describe('build-native host guard & MSVC flag escaping', () => {
  it('skips natively outside win32 unless --require-win32 is enforced', async () => {
    if (process.platform === 'win32') return;
    const run = promisify(execFile);
    const script = fileURLToPath(new URL('../scripts/build-native.mjs', import.meta.url));
    const skipped = await run(process.execPath, [script]);
    expect(skipped.stdout).toContain('skipped native helper build');
    await expect(run(process.execPath, [script, '--require-win32'])).rejects.toThrow(/requires win32/);
  });

  it('formats cl.exe /Fo path without a trailing backslash before closing quote (B1)', async () => {
    const run = promisify(execFile);
    const script = fileURLToPath(new URL('../scripts/build-native.mjs', import.meta.url));
    const { stdout } = await run(process.execPath, [script, '--print-cl-args']);
    const line = stdout.trim();
    expect(line).toMatch(/\/Fo:"[^"]+ludy-wasapi-loopback\.obj"/);
    expect(line).not.toMatch(/\\"/);
    expect(line).toContain(' /MT /GS ');
    expect(line).toContain('/link /DYNAMICBASE /HIGHENTROPYVA /NXCOMPAT ole32.lib mmdevapi.lib user32.lib');
  });
});
