// SPDX-License-Identifier: AGPL-3.0-only
// What the tray shows, as data: the icon state, an always-visible tooltip and the menu. No Electron here; main.ts draws it. Labels are
// Vietnamese. The only notification this shell has is this tray (ADR-0055: no notifications beyond it in this slice).
import type { UpdateState } from './updater.ts';

export type AuthState =
  | { kind: 'signed-out' }
  | { kind: 'signing-in' }
  // `online`: the last check of the token reached the server. `persisted`: the token is in the OS key store (false: in memory only).
  | { kind: 'signed-in'; orgSlug: string; online: boolean; persisted: boolean };

export interface ShellModel {
  auth: AuthState;
  update: UpdateState;
  // The configuration problems (Vietnamese), empty when fine.
  configProblems: readonly string[];
  // Whether a Ludy address is configured at all.
  configured: boolean;
  // The last thing worth telling the member, such as a refused sign-in; cleared by the next action.
  notice: string | null;
}

export type TrayIcon = 'signed-out' | 'signed-in' | 'update' | 'error';
export type TrayItemId = 'open' | 'sign-in' | 'cancel-sign-in' | 'sign-out' | 'restart' | 'quit';

export type TrayItem = { kind: 'status'; label: string } | { kind: 'action'; id: TrayItemId; label: string; enabled: boolean } | { kind: 'separator' };

export interface TraySpec {
  icon: TrayIcon;
  tooltip: string;
  items: TrayItem[];
}

function statusLine(model: ShellModel): string {
  if (!model.configured) return model.configProblems[0] ?? 'Chưa cấu hình địa chỉ Ludy (LUDY_URL)';
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
  const updateReady = model.update.kind === 'ready';
  const hasError = model.configProblems.length > 0 || model.update.kind === 'failed' || model.notice !== null;
  const icon: TrayIcon = hasError ? 'error' : updateReady ? 'update' : signedIn ? 'signed-in' : 'signed-out';

  const status = statusLine(model);
  const update = updateLine(model.update);
  const lines = [status, ...(update ? [update] : []), ...(model.notice ? [model.notice] : [])];
  const items: TrayItem[] = [{ kind: 'status', label: status }];
  if (update) items.push({ kind: 'status', label: update });
  if (model.notice) items.push({ kind: 'status', label: model.notice });
  items.push({ kind: 'separator' });
  items.push({ kind: 'action', id: 'open', label: 'Mở Ludy', enabled: model.configured });
  if (signingIn) items.push({ kind: 'action', id: 'cancel-sign-in', label: 'Hủy đăng nhập', enabled: true });
  else if (signedIn) items.push({ kind: 'action', id: 'sign-out', label: 'Đăng xuất', enabled: true });
  else items.push({ kind: 'action', id: 'sign-in', label: 'Đăng nhập', enabled: model.configured });
  if (updateReady) items.push({ kind: 'action', id: 'restart', label: 'Khởi động lại để cập nhật', enabled: true });
  items.push({ kind: 'separator' });
  items.push({ kind: 'action', id: 'quit', label: 'Thoát', enabled: true });
  // The tooltip is the always-visible state; Windows keeps it to 127 characters.
  return { icon, tooltip: `Ludy Desktop: ${lines.join('. ')}`.slice(0, 127), items };
}
