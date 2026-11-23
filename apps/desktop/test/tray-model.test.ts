// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { describeTray, type ShellModel, type TrayItem } from '../src/tray-model.ts';

const base: ShellModel = { auth: { kind: 'signed-out' }, update: { kind: 'idle' }, configProblems: [], configured: true, notice: null };
const actions = (items: TrayItem[]) => items.filter((i) => i.kind === 'action').map((i) => (i.kind === 'action' ? `${i.id}:${i.label}:${i.enabled}` : ''));

describe('describeTray', () => {
  it('signed out: grey, sign in and open', () => {
    const spec = describeTray(base);
    expect(spec.icon).toBe('signed-out');
    expect(spec.tooltip).toBe('Ludy Desktop: Chưa đăng nhập');
    expect(actions(spec.items)).toEqual(['open:Mở Ludy:true', 'sign-in:Đăng nhập:true', 'quit:Thoát:true']);
  });
  it('signed in: green, sign out replaces sign in', () => {
    const spec = describeTray({ ...base, auth: { kind: 'signed-in', orgSlug: 'acme', online: true, persisted: true } });
    expect(spec.icon).toBe('signed-in');
    expect(spec.tooltip).toContain('Đã đăng nhập (acme)');
    expect(actions(spec.items)).toEqual(['open:Mở Ludy:true', 'sign-out:Đăng xuất:true', 'quit:Thoát:true']);
  });
  it('says when the token is only in memory or the server cannot be reached', () => {
    const spec = describeTray({ ...base, auth: { kind: 'signed-in', orgSlug: 'acme', online: false, persisted: false } });
    expect(spec.tooltip).toContain('chưa kết nối được máy chủ');
    expect(spec.tooltip).toContain('chỉ lưu trong phiên này');
  });
  it('an update ready adds the restart item and the blue icon', () => {
    const spec = describeTray({ ...base, update: { kind: 'ready', version: '0.0.2' } });
    expect(spec.icon).toBe('update');
    expect(actions(spec.items)).toContain('restart:Khởi động lại để cập nhật:true');
  });
  it('shows problems in red, with open and sign in off when no address is configured', () => {
    const spec = describeTray({ ...base, configured: false, configProblems: ['Địa chỉ Ludy phải dùng https'] });
    expect(spec.icon).toBe('error');
    expect(actions(spec.items)).toEqual(['open:Mở Ludy:false', 'sign-in:Đăng nhập:false', 'quit:Thoát:true']);
    expect(describeTray({ ...base, update: { kind: 'failed', message: 'x' } }).icon).toBe('error');
    expect(describeTray({ ...base, notice: 'Bạn đã từ chối đăng nhập' }).tooltip).toContain('Bạn đã từ chối đăng nhập');
  });
  it('while signing in the member can cancel, and the tooltip stays within the Windows limit', () => {
    const spec = describeTray({ ...base, auth: { kind: 'signing-in' }, notice: 'x'.repeat(300) });
    expect(actions(spec.items)).toContain('cancel-sign-in:Hủy đăng nhập:true');
    expect(spec.tooltip.length).toBeLessThanOrEqual(127);
  });
  it('tells when updates are off', () => {
    expect(describeTray({ ...base, update: { kind: 'off', reason: 'no-feed' } }).items.some((i) => i.kind === 'status' && i.label.includes('Tự cập nhật: tắt'))).toBe(true);
  });
});
