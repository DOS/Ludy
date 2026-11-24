// SPDX-License-Identifier: AGPL-3.0-only
// Meeting window recognition for Ludy Desktop (#4516): classifies visible native client windows (Zoom, Microsoft Teams, Zalo PC,
// Slack) from executable basename without ever scraping window titles into a meetingKey. Also checks pasted join addresses cleanly.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface NativeWindowInfo {
  hwnd: string;
  pid: number;
  exe: string;
  title: string;
}

export type MeetingClientKind = 'zoom' | 'teams' | 'zalo' | 'slack';

export interface OfferedWindow {
  hwnd: string;
  pid: number;
  client: MeetingClientKind;
  appName: string;
  title: string;
}

const KNOWN_EXECUTABLES: Readonly<Record<string, { client: MeetingClientKind; appName: string }>> = {
  'zoom.exe': { client: 'zoom', appName: 'Zoom' },
  'ms-teams.exe': { client: 'teams', appName: 'Microsoft Teams' },
  'teams.exe': { client: 'teams', appName: 'Microsoft Teams' },
  'zalo.exe': { client: 'zalo', appName: 'Zalo PC' },
  'slack.exe': { client: 'slack', appName: 'Slack' },
};

const IGNORED_TITLES = new Set(['msctfime ui', 'default ime', 'program manager']);

export function classifyMeetingWindow(win: NativeWindowInfo): OfferedWindow | null {
  const exeKey = win.exe.trim().toLowerCase();
  const match = KNOWN_EXECUTABLES[exeKey];
  if (!match || !Number.isInteger(win.pid) || win.pid <= 0) return null;
  const cleanTitle = win.title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!cleanTitle || IGNORED_TITLES.has(cleanTitle.toLowerCase())) return null;
  return {
    hwnd: win.hwnd,
    pid: win.pid,
    client: match.client,
    appName: match.appName,
    title: cleanTitle,
  };
}

export function selectOfferedWindows(windows: readonly NativeWindowInfo[]): OfferedWindow[] {
  const seenPids = new Set<number>();
  const out: OfferedWindow[] = [];
  for (const w of windows) {
    const offered = classifyMeetingWindow(w);
    if (!offered || seenPids.has(offered.pid)) continue;
    seenPids.add(offered.pid);
    out.push(offered);
  }
  return out;
}

// Validates an optional user-pasted meeting join URL (Google Meet, Zoom, or Teams). Window titles are never converted into a join URL.
export function sanitizePastedJoinUrl(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 500) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export function resolveHelperExePath(options: { isPackaged?: boolean; resourcesPath?: string } = {}): string | null {
  if (process.platform !== 'win32') return null;
  const candidates = [
    options.isPackaged && options.resourcesPath ? join(options.resourcesPath, 'app.asar.unpacked', 'bin', 'ludy-wasapi-loopback.exe') : '',
    fileURLToPath(new URL('../../bin/ludy-wasapi-loopback.exe', import.meta.url)),
    fileURLToPath(new URL('../../native/ludy-wasapi-loopback.exe', import.meta.url)),
    fileURLToPath(new URL('../../../out/native/ludy-wasapi-loopback.exe', import.meta.url)),
  ].filter(Boolean);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

export type ExecHelper = (exePath: string, args: readonly string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export const defaultExecHelper: ExecHelper = (exePath, args) =>
  new Promise((resolve) => {
    const child = spawn(exePath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.once('error', () => resolve({ code: 1, stdout: '', stderr: 'SPAWN_FAILED' }));
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });

export async function listMeetingWindows(options: { exePath?: string | null; exec?: ExecHelper } = {}): Promise<OfferedWindow[]> {
  const exePath = options.exePath === undefined ? resolveHelperExePath() : options.exePath;
  if (!exePath) return [];
  const res = await (options.exec ?? defaultExecHelper)(exePath, ['--list-windows']);
  if (res.code !== 0 || !res.stdout.trim()) return [];
  try {
    const parsed = JSON.parse(res.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    const normalized: NativeWindowInfo[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        if (typeof rec.hwnd === 'string' && typeof rec.pid === 'number' && typeof rec.exe === 'string' && typeof rec.title === 'string') {
          normalized.push({ hwnd: rec.hwnd, pid: rec.pid, exe: rec.exe, title: rec.title });
        }
      }
    }
    return selectOfferedWindows(normalized);
  } catch {
    return [];
  }
}
