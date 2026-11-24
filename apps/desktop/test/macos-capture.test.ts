// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for #4701 (ADR-0055 slice 3c): macOS Darwin >= 23.2 (macOS 14.2+) Core Audio version gate,
// `ps -axo pid=,comm=` meeting app detection (Zoom, Microsoft Teams, Zalo, Slack), zero silent fallback,
// Core Audio arming, silent-permission alerts within seconds, mic-only capture, and win32 preservation.
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createCaptureController, type ConsentWindowViewState } from '../src/capture/controller.ts';
import { createDesktopCaptureModule, type ElectronWorkerBridge } from '../src/capture/desktop-capture.ts';
import { ProcessLoopbackUnsupportedError } from '../src/capture/interface.ts';
import { createDiskRecordingStore } from '../src/capture/live-sender.ts';
import {
  classifyMacMeetingProcess,
  isMacOsCoreAudioSupported,
  listMacMeetingApps,
  parseDarwinMajorMinor,
  selectMacMeetingApps,
} from '../src/capture/macos.ts';
import { listMeetingWindows } from '../src/capture/windows.ts';

function makeBridgeHarness() {
  const readyHandlers = new Set<(res: { ok: boolean; error?: string; micMissing?: boolean }) => void>();
  const stopHandlers = new Set<() => void>();
  const levelHandlers = new Set<(levels: { loopbackRms: number; micRms: number }) => void>();
  const startConfigs: Array<{ source: string; mode: string; liveNotes: boolean }> = [];
  let armed = 0;
  let disarmed = 0;

  const bridge: ElectronWorkerBridge = {
    async openWorkerWindow() {
      return {
        webContentsId: 91,
        sendStart: (cfg) => {
          startConfigs.push(cfg);
          queueMicrotask(() => readyHandlers.forEach((cb) => cb({ ok: true })));
        },
        sendStop: () => {
          queueMicrotask(() => stopHandlers.forEach((cb) => cb()));
        },
        sendPcm: () => undefined,
        close: () => undefined,
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
    onWorkerLevels: (cb) => {
      levelHandlers.add(cb);
      return () => levelHandlers.delete(cb);
    },
    onWorkerEnded: () => () => undefined,
  };

  return {
    bridge,
    startConfigs,
    emitLevels: (loopbackRms: number, micRms: number) => levelHandlers.forEach((cb) => cb({ loopbackRms, micRms })),
    counts: () => ({ armed, disarmed }),
  };
}

describe('Darwin version gating for macOS Core Audio loopback', () => {
  it('parses major.minor cleanly and rejects malformed kernel releases', () => {
    expect(parseDarwinMajorMinor('23.1.0')).toEqual({ major: 23, minor: 1 });
    expect(parseDarwinMajorMinor('23.2.0')).toEqual({ major: 23, minor: 2 });
    expect(parseDarwinMajorMinor('24.0.0-arm64')).toEqual({ major: 24, minor: 0 });
    expect(parseDarwinMajorMinor('23.2')).toEqual({ major: 23, minor: 2 });
    expect(parseDarwinMajorMinor('')).toBeNull();
    expect(parseDarwinMajorMinor('23')).toBeNull();
    expect(parseDarwinMajorMinor('invalid')).toBeNull();
  });

  it('requires Darwin >= 23.2 (macOS 14.2+) for Core Audio loopback', () => {
    expect(isMacOsCoreAudioSupported('22.6.0')).toBe(false);
    expect(isMacOsCoreAudioSupported('23.0.0')).toBe(false);
    expect(isMacOsCoreAudioSupported('23.1.0')).toBe(false);
    expect(isMacOsCoreAudioSupported('23.2.0')).toBe(true);
    expect(isMacOsCoreAudioSupported('23.6.0')).toBe(true);
    expect(isMacOsCoreAudioSupported('24.0.0')).toBe(true);
    expect(isMacOsCoreAudioSupported('25.1.0')).toBe(true);
    expect(isMacOsCoreAudioSupported('unknown')).toBe(false);
  });
});

describe('macOS ps meeting app detection', () => {
  it('detects Zoom, Microsoft Teams, Zalo, and Slack, deduplicates PIDs, and ignores helper/unknown processes', async () => {
    const samplePs = [
      '  101 /Applications/zoom.us.app/Contents/MacOS/zoom.us',
      '  101 /Applications/zoom.us.app/Contents/MacOS/zoom.us',
      '  102 /Applications/zoom.us.app/Contents/Frameworks/CptHost.app/Contents/MacOS/CptHost',
      '  201 /Applications/Microsoft Teams.app/Contents/MacOS/MSTeams',
      '  202 /Applications/Microsoft Teams.app/Contents/Frameworks/Microsoft Teams Helper (GPU).app/Contents/MacOS/Microsoft Teams Helper (GPU)',
      '  301 /Applications/Zalo.app/Contents/MacOS/Zalo',
      '  302 /Applications/Zalo.app/Contents/Frameworks/Zalo Helper.app/Contents/MacOS/Zalo Helper',
      '  401 /Applications/Slack.app/Contents/MacOS/Slack',
      '  402 /Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer)',
      '  501 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '    0 /Applications/Slack.app/Contents/MacOS/Slack',
    ].join('\n');

    expect(classifyMacMeetingProcess(102, '/Applications/zoom.us.app/Contents/Frameworks/CptHost.app/Contents/MacOS/CptHost')).toBeNull();
    expect(classifyMacMeetingProcess(-1, '/Applications/Slack.app/Contents/MacOS/Slack')).toBeNull();
    expect(classifyMacMeetingProcess(901, '/usr/local/bin/constructor')).toBeNull();
    expect(classifyMacMeetingProcess(902, '__proto__')).toBeNull();
    expect(classifyMacMeetingProcess(903, '/Applications/toString')).toBeNull();
    expect(selectMacMeetingApps('  901 /usr/local/bin/constructor\n  902 __proto__\n  903 toString')).toEqual([]);

    let seenPsArgs: { file: string; args: readonly string[] } | null = null;
    const apps = await listMacMeetingApps({
      execPs: async (file, args) => {
        seenPsArgs = { file, args };
        return { stdout: samplePs };
      },
    });

    expect(seenPsArgs).toEqual({ file: 'ps', args: ['-axo', 'pid=,comm='] });
    expect(apps).toEqual([
      { hwnd: 'mac:101', pid: 101, client: 'zoom', appName: 'Zoom', title: 'Zoom' },
      { hwnd: 'mac:201', pid: 201, client: 'teams', appName: 'Microsoft Teams', title: 'Microsoft Teams' },
      { hwnd: 'mac:301', pid: 301, client: 'zalo', appName: 'Zalo', title: 'Zalo' },
      { hwnd: 'mac:401', pid: 401, client: 'slack', appName: 'Slack', title: 'Slack' },
    ]);
    expect(selectMacMeetingApps('  99 /Applications/Microsoft Teams classic.app/Contents/MacOS/Teams')).toEqual([
      { hwnd: 'mac:99', pid: 99, client: 'teams', appName: 'Microsoft Teams', title: 'Microsoft Teams' },
    ]);
  });

  it('returns an empty list on ps error and wires listMeetingWindows cleanly on darwin vs win32', async () => {
    expect(await listMacMeetingApps({ execPs: async () => { throw new Error('ps unavailable'); } })).toEqual([]);

    const darwinList = await listMeetingWindows({
      platform: 'darwin',
      listMacApps: async () => [{ hwnd: 'mac:77', pid: 77, client: 'zalo', appName: 'Zalo', title: 'Zalo' }],
    });
    expect(darwinList).toEqual([{ hwnd: 'mac:77', pid: 77, client: 'zalo', appName: 'Zalo', title: 'Zalo' }]);

    const winList = await listMeetingWindows({
      platform: 'win32',
      exePath: 'C:\\fake\\helper.exe',
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify([{ hwnd: '0x1', pid: 50, exe: 'Slack.exe', title: 'Huddle' }]),
        stderr: '',
      }),
    });
    expect(winList).toEqual([{ hwnd: '0x1', pid: 50, client: 'slack', appName: 'Slack', title: 'Huddle' }]);
  });
});

describe('macOS Core Audio capture gating, silent-permission warning, and win32 preservation', () => {
  it('refuses loopback capture on macOS < 14.2 (Darwin 23.1) even with fallback, while keeping mic-only working', async () => {
    const h = makeBridgeHarness();
    const mod = createDesktopCaptureModule({
      isPackaged: false,
      resourcesPath: '',
      platform: 'darwin',
      darwinRelease: '23.1.0',
      bridge: h.bridge,
    });

    await expect(mod.start('system-audio-and-microphone', '', { targetPid: 101 })).rejects.toBeInstanceOf(
      ProcessLoopbackUnsupportedError,
    );
    await expect(mod.start('system-audio', '', { allowSystemFallback: true })).rejects.toMatchObject({
      code: 'PROCESS_LOOPBACK_UNSUPPORTED',
      systemFallbackAvailable: false,
    });
    expect(h.counts().armed).toBe(0);

    // Microphone-only works cleanly on macOS < 14.2.
    await mod.start('microphone', '');
    expect(h.startConfigs.at(-1)).toEqual({ source: 'microphone', mode: 'mic-only', liveNotes: false });
    expect(h.counts().armed).toBe(0);
    await mod.stop();
  });

  it('refuses per-app capture on macOS 14.2+ without silent fallback, then arms Core Audio and surfaces silence-permission alert on system confirmation', async () => {
    const h = makeBridgeHarness();
    const mod = createDesktopCaptureModule({
      isPackaged: false,
      resourcesPath: '',
      platform: 'darwin',
      darwinRelease: '23.2.0',
      bridge: h.bridge,
    });

    // App selection without explicit whole-system confirmation refuses cleanly (no silent whole-system fallback).
    await expect(mod.start('system-audio-and-microphone', 'https://meet.google.com/abc', { targetPid: 201 })).rejects.toMatchObject({
      code: 'PROCESS_LOOPBACK_UNSUPPORTED',
      systemFallbackAvailable: true,
    });
    expect(h.counts().armed).toBe(0);

    // Without allowSystemFallback on system audio, refuses as well.
    await expect(mod.start('system-audio', '')).rejects.toBeInstanceOf(ProcessLoopbackUnsupportedError);
    expect(h.counts().armed).toBe(0);

    // Explicit whole-system Core Audio capture arms bridge and alerts on silent zero-buffer permission denial within 3.5s (7 ticks).
    const alerts: Array<'silent-loopback' | 'silent-mic'> = [];
    await mod.start('system-audio-and-microphone', '', {
      allowSystemFallback: true,
      onSilentAlert: (kind) => alerts.push(kind),
    });
    expect(h.counts().armed).toBe(1);
    expect(h.startConfigs.at(-1)).toEqual({ source: 'system-audio-and-microphone', mode: 'system-fallback', liveNotes: false });

    for (let i = 0; i < 6; i += 1) {
      h.emitLevels(0, 0.08);
      expect(alerts).toEqual([]);
    }
    h.emitLevels(0, 0.08);
    expect(alerts).toEqual(['silent-loopback']);
    await mod.stop();
  });

  it('prevents controller from showing system-fallback checkbox on macOS < 14.2 and enforces explicit consent on >= 14.2', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ludy-mac-ctrl-'));
    try {
      const views: ConsentWindowViewState[] = [];
      let meetingsCreated = 0;
      const h = makeBridgeHarness();

      const oldMacController = createCaptureController({
        capture: createDesktopCaptureModule({
          isPackaged: false,
          resourcesPath: '',
          platform: 'darwin',
          darwinRelease: '23.1.0',
          bridge: h.bridge,
        }),
        recordingStore: createDiskRecordingStore(root),
        fetch: async () => {
          meetingsCreated += 1;
          return new Response(JSON.stringify({ json: { meetingId: 'never' } }), { status: 200 });
        },
        listWindows: async () => [],
        getSession: () => ({ ludyUrl: 'https://ludy.example.vn', token: 'crx_t', uploads: 'direct', meetingsEnabled: true, agendaEnabled: false }),
        onTrayState: () => undefined,
        ui: {
          updateConsentState: (s) => views.push(s),
          showPill: () => undefined,
          updatePill: () => undefined,
          hidePill: () => undefined,
          closeConsent: () => undefined,
        },
      });

      const oldOutcome = await oldMacController.startCapture({
        title: 'Mac 14.1 Test',
        consentMethod: 'told_at_start',
        consentAgreed: true,
        noticeLanguage: 'en',
        liveNotes: false,
        source: 'system-audio-and-microphone',
        targetPid: 101,
      });
      expect(oldOutcome.ok).toBe(false);
      expect(oldOutcome.systemFallbackRequired).toBe(false);
      expect(oldOutcome.error).toContain('macOS 14.2');
      expect(views.at(-1)?.systemFallbackRequired).toBe(false);
      expect(meetingsCreated).toBe(0);

      const newViews: ConsentWindowViewState[] = [];
      let createdOnNewMac = 0;
      const newMacHarness = makeBridgeHarness();
      const newMacController = createCaptureController({
        capture: createDesktopCaptureModule({
          isPackaged: false,
          resourcesPath: '',
          platform: 'darwin',
          darwinRelease: '23.2.0',
          bridge: newMacHarness.bridge,
        }),
        recordingStore: createDiskRecordingStore(root),
        fetch: async (url) => {
          if (String(url).endsWith('/api/rpc/meetings/create')) {
            createdOnNewMac += 1;
            return new Response(JSON.stringify({ json: { meetingId: 'mtg-mac-23-2' } }), { status: 200 });
          }
          return new Response(JSON.stringify({ json: { open: true } }), { status: 200 });
        },
        listWindows: async () => [],
        getSession: () => ({ ludyUrl: 'https://ludy.example.vn', token: 'crx_t', uploads: 'direct', meetingsEnabled: true, agendaEnabled: false }),
        onTrayState: () => undefined,
        ui: {
          updateConsentState: (s) => newViews.push(s),
          showPill: () => undefined,
          updatePill: () => undefined,
          hidePill: () => undefined,
          closeConsent: () => undefined,
        },
      });

      const enPrompt = await newMacController.startCapture({
        title: 'Mac 14.2 English Consent',
        consentMethod: 'told_at_start',
        consentAgreed: true,
        noticeLanguage: 'en',
        liveNotes: false,
        source: 'system-audio-and-microphone',
        targetPid: 201,
      });
      expect(enPrompt.ok).toBe(false);
      expect(enPrompt.systemFallbackRequired).toBe(true);
      expect(enPrompt.error).toContain('Per-app audio capture is not supported on macOS yet');
      expect(newViews.at(-1)?.systemFallbackRequired).toBe(true);

      const viPrompt = await newMacController.startCapture({
        title: 'Mac 14.2 Vietnamese Consent',
        consentMethod: 'told_at_start',
        consentAgreed: true,
        noticeLanguage: 'vi',
        liveNotes: false,
        source: 'system-audio-and-microphone',
        targetPid: 201,
      });
      expect(viPrompt.ok).toBe(false);
      expect(viPrompt.systemFallbackRequired).toBe(true);
      expect(viPrompt.error).toContain('Trên macOS, Ludy chưa tách riêng âm thanh từng ứng dụng');
      expect(createdOnNewMac).toBe(0);
      expect(newMacHarness.counts().armed).toBe(0);

      const confirmed = await newMacController.startCapture({
        title: 'Mac 14.2 Confirmed System Capture',
        consentMethod: 'told_at_start',
        consentAgreed: true,
        noticeLanguage: 'vi',
        liveNotes: false,
        source: 'system-audio-and-microphone',
        targetPid: 201,
        allowSystemFallback: true,
      });
      expect(confirmed).toEqual({ ok: true, meetingId: 'mtg-mac-23-2' });
      expect(createdOnNewMac).toBe(1);
      expect(newMacHarness.counts().armed).toBe(1);
      await newMacController.stopCapture('user');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps win32 WASAPI per-app loopback path completely intact', async () => {
    const h = makeBridgeHarness();
    let spawnedArgs: readonly string[] = [];
    const mod = createDesktopCaptureModule({
      isPackaged: false,
      resourcesPath: '',
      platform: 'win32',
      bridge: h.bridge,
      resolveHelperPath: () => 'C:\\fake\\ludy-wasapi-loopback.exe',
      spawnHelper: (_exe, args) => {
        spawnedArgs = args;
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
        queueMicrotask(() => ee.stderr.write('WASAPI_READY\n'));
        return ee as unknown as ChildProcessWithoutNullStreams;
      },
    });

    await mod.start('system-audio-and-microphone', '', { targetPid: 4242 });
    expect(spawnedArgs).toEqual(['--pid', '4242']);
    expect(h.counts().armed).toBe(0);
    expect(h.startConfigs.at(-1)).toEqual({ source: 'system-audio-and-microphone', mode: 'wasapi', liveNotes: false });
    await mod.stop();
  });
});
