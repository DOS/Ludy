// SPDX-License-Identifier: AGPL-3.0-only
// macOS Core Audio loopback support check & meeting app detection (ADR-0055 slice 3c, #4701):
// gates system-audio loopback cleanly to macOS 14.2+ (Darwin >= 23.2) and detects running Zoom,
// Microsoft Teams, Zalo, and Slack processes via `ps -axo pid=,comm=` with zero shell and zero Accessibility prompt.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MeetingClientKind, OfferedWindow } from './windows.ts';

const execFileAsync = promisify(execFile);

// Electron Core Audio system-audio loopback requires macOS 14.2+ (Darwin kernel 23.2+).
export const MIN_DARWIN_MAJOR = 23;
export const MIN_DARWIN_MINOR = 2;

export interface DarwinVersion {
  major: number;
  minor: number;
}

export function parseDarwinMajorMinor(release: string): DarwinVersion | null {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?(?:[.-].*)?$/.exec(release.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 0 || minor < 0) return null;
  return { major, minor };
}

export function isMacOsCoreAudioSupported(release: string): boolean {
  const parsed = parseDarwinMajorMinor(release);
  if (!parsed) return false;
  return parsed.major > MIN_DARWIN_MAJOR || (parsed.major === MIN_DARWIN_MAJOR && parsed.minor >= MIN_DARWIN_MINOR);
}

const MAC_MEETING_APPS = new Map<string, { client: MeetingClientKind; appName: string }>([
  ['zoom.us', { client: 'zoom', appName: 'Zoom' }],
  ['msteams', { client: 'teams', appName: 'Microsoft Teams' }],
  ['microsoft teams', { client: 'teams', appName: 'Microsoft Teams' }],
  ['microsoft teams (work or school)', { client: 'teams', appName: 'Microsoft Teams' }],
  ['teams', { client: 'teams', appName: 'Microsoft Teams' }],
  ['zalo', { client: 'zalo', appName: 'Zalo' }],
  ['slack', { client: 'slack', appName: 'Slack' }],
]);

export function classifyMacMeetingProcess(pid: number, comm: string): OfferedWindow | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const trimmed = comm.trim();
  if (!trimmed || trimmed.includes('/Contents/Frameworks/')) return null;
  const basename = trimmed.replace(/^.*\//, '').toLowerCase();
  const match = MAC_MEETING_APPS.get(basename);
  if (!match) return null;
  return {
    hwnd: `mac:${pid}`,
    pid,
    client: match.client,
    appName: match.appName,
    title: match.appName,
  };
}

export type ExecPs = (file: string, args: readonly string[]) => Promise<{ stdout: string }>;

const defaultExecPs: ExecPs = (file, args) => execFileAsync(file, args, { encoding: 'utf8', timeout: 3000 });

export function selectMacMeetingApps(psOutput: string): OfferedWindow[] {
  const seenPids = new Set<number>();
  const out: OfferedWindow[] = [];
  for (const rawLine of psOutput.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const comm = match[2] ?? '';
    const app = classifyMacMeetingProcess(pid, comm);
    if (!app || seenPids.has(app.pid)) continue;
    seenPids.add(app.pid);
    out.push(app);
  }
  return out;
}

export async function listMacMeetingApps(options: { execPs?: ExecPs } = {}): Promise<OfferedWindow[]> {
  try {
    const { stdout } = await (options.execPs ?? defaultExecPs)('ps', ['-axo', 'pid=,comm=']);
    return selectMacMeetingApps(stdout);
  } catch {
    return [];
  }
}
