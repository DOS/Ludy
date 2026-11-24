// SPDX-License-Identifier: AGPL-3.0-only
// What the tray shows, as data: the icon state, an always-visible tooltip and the menu. No Electron here; main.ts draws it. Labels are
// Vietnamese. Supports sign-in, update, recording status/timer, silent-track warnings, and reconnect prompts for desktop capture (#4516).
import type { UpdateState } from './updater.ts';

export type AuthState =
  | { kind: 'signed-out' }
  | { kind: 'signing-in' }
  // `online`: the last check of the token reached the server. `persisted`: the token is in the OS key store (false: in memory only).
  | { kind: 'signed-in'; orgSlug: string; online: boolean; persisted: boolean };

export type CapturePhase = 'idle' | 'consent' | 'preparing' | 'recording' | 'uploading';

export interface CaptureTrayState {
  enabled: boolean;
  reconnectNeeded: boolean;
  agendaEnabled: boolean;
  phase: CapturePhase;
  meetingTitle: string | null;
  elapsedMs: number;
  detectedApp: string | null;
  warning: string | null;
}

export interface ShellModel {
  auth: AuthState;
  update: UpdateState;
  // The configuration problems (Vietnamese), empty when fine.
  configProblems: readonly string[];
  // Whether a Ludy address is configured at all.
  configured: boolean;
  // The last thing worth telling the member, such as a refused sign-in; cleared by the next action.
  notice: string | null;
  capture?: CaptureTrayState;
}

export type TrayIcon = 'signed-out' | 'signed-in' | 'recording' | 'update' | 'error';
export type TrayItemId = 'open' | 'sign-in' | 'cancel-sign-in' | 'sign-out' | 'record' | 'stop-record' | 'reconnect-capture' | 'restart' | 'quit';

export type TrayItem = { kind: 'status'; label: string } | { kind: 'action'; id: TrayItemId; label: string; enabled: boolean } | { kind: 'separator' };

export interface TraySpec {
  icon: TrayIcon;
  tooltip: string;
  items: TrayItem[];
}

export function formatDurationClock(elapsedMs: number): string {
  const total = Math.floor(Math.max(0, elapsedMs) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

function statusLine(model: ShellModel): string {
  if (!model.configured) return model.configProblems[0] ?? 'Chưa cấu hình địa chỉ Ludy (LUDY_URL)';
  if (model.auth.kind === 'signed-in' && model.capture?.phase === 'recording') {
    const title = model.capture.meetingTitle ? ` ${model.capture.meetingTitle}` : '';
    return `Đang ghi âm${title} (${formatDurationClock(model.capture.elapsedMs)})`;
  }
  if (model.auth.kind === 'signed-in' && model.capture?.phase === 'uploading') {
    return 'Đang tải bản ghi lên máy chủ';
  }
  switch (model.auth.kind) {
    case 'signed-out':
      return 'Chưa đăng nhập';
    case 'signing-in':
      return 'Đang chờ bạn đăng nhập trên trình duyệt';
    case 'signed-in':
      return `Đã đăng nhập (${model.auth.orgSlug})${model.auth.online ? '' : ', chưa kết nối được máy chủ'}${model.auth.persisted ? '' : ', chỉ lưu trong phiên này'}`;
  }
}

function updateLine(update: UpdateState): string | null {
  switch (update.kind) {
    case 'off':
      return update.reason === 'no-feed' ? 'Tự cập nhật: tắt (chưa có địa chỉ cập nhật)' : 'Tự cập nhật: tắt (bản chạy này không cài bằng trình cài đặt)';
    case 'checking':
      return 'Đang kiểm tra bản cập nhật';
    case 'downloading':
      return 'Đang tải bản cập nhật';
    case 'ready':
      return `Có bản cập nhật${update.version ? ` ${update.version}` : ''}, sẵn sàng khởi động lại`;
    case 'failed':
      return 'Cập nhật lỗi, bản đang chạy không đổi';
    case 'idle':
      return null;
  }
}

export function describeTray(model: ShellModel): TraySpec {
  const signedIn = model.auth.kind === 'signed-in';
  const signingIn = model.auth.kind === 'signing-in';
  const capture = model.capture;
  const recording = signedIn && capture?.phase === 'recording';
  const busy = signedIn && (capture?.phase === 'recording' || capture?.phase === 'uploading' || capture?.phase === 'preparing');
  const updateReady = model.update.kind === 'ready';
  const hasError = model.configProblems.length > 0 || model.update.kind === 'failed' || model.notice !== null;
  const icon: TrayIcon = hasError ? 'error' : recording ? 'recording' : updateReady ? 'update' : signedIn ? 'signed-in' : 'signed-out';

  const status = statusLine(model);
  const warning = recording && capture?.warning ? capture.warning : null;
  const update = updateLine(model.update);
  const lines = [status, ...(warning ? [warning] : []), ...(update ? [update] : []), ...(model.notice ? [model.notice] : [])];
  const items: TrayItem[] = [{ kind: 'status', label: status }];
  if (warning) items.push({ kind: 'status', label: warning });
  if (signedIn && capture?.reconnectNeeded && capture.phase === 'idle') {
    items.push({ kind: 'status', label: 'Máy chủ đã bật ghi âm, cần kết nối lại để cấp quyền' });
  }
  if (update) items.push({ kind: 'status', label: update });
  if (model.notice) items.push({ kind: 'status', label: model.notice });
  items.push({ kind: 'separator' });

  if (signedIn && recording) {
    items.push({ kind: 'action', id: 'stop-record', label: 'Dừng ghi âm và lưu', enabled: true });
  } else if (signedIn && capture?.enabled) {
    const label = capture.detectedApp ? `Ghi cuộc họp (${capture.detectedApp})...` : 'Ghi cuộc họp...';
    items.push({ kind: 'action', id: 'record', label, enabled: capture.phase === 'idle' });
  } else if (signedIn && capture?.reconnectNeeded) {
    items.push({ kind: 'action', id: 'reconnect-capture', label: 'Kết nối lại để bật ghi âm', enabled: true });
  }

  items.push({ kind: 'action', id: 'open', label: 'Mở Ludy', enabled: model.configured });
  if (signingIn) items.push({ kind: 'action', id: 'cancel-sign-in', label: 'Hủy đăng nhập', enabled: true });
  else if (signedIn) items.push({ kind: 'action', id: 'sign-out', label: 'Đăng xuất', enabled: !busy });
  else items.push({ kind: 'action', id: 'sign-in', label: 'Đăng nhập', enabled: model.configured });
  if (updateReady) items.push({ kind: 'action', id: 'restart', label: 'Khởi động lại để cập nhật', enabled: true });
  items.push({ kind: 'separator' });
  items.push({ kind: 'action', id: 'quit', label: 'Thoát', enabled: true });
  // The tooltip is the always-visible state; Windows keeps it to 127 characters.
  return { icon, tooltip: `Ludy Desktop: ${lines.join('. ')}`.slice(0, 127), items };
}
