// SPDX-License-Identifier: AGPL-3.0-only
// Recording cannot start without the consent step: the gate refuses before any device is opened or any meeting created.
import { describe, expect, it, vi } from 'vitest';
import { CONSENT_METHODS as CONTRACT_METHODS } from '@crove/kernel-contract';
import { consentBlocker, CONSENT_METHODS } from '../src/consent.ts';
import { startCapture, type CaptureDeps } from '../src/capture-run.ts';

const ok = { title: 'Họp tuần', consentMethod: 'told_at_start', consentAgreed: true };

describe('consent gate', () => {
  it('lets a named meeting with a method and a confirmation start', () => {
    expect(consentBlocker(ok)).toBeNull();
  });

  it.each([
    ['no title', { ...ok, title: '   ' }, 'title'],
    ['no method', { ...ok, consentMethod: '' }, 'consentMethod'],
    ['an unknown method', { ...ok, consentMethod: 'verbally' }, 'consentMethod'],
    ['no confirmation', { ...ok, consentAgreed: false }, 'consentAgreed'],
  ])('blocks %s', (_name, input, expected) => {
    expect(consentBlocker(input)).toBe(expected);
  });

  it('offers exactly the methods the kernel knows', () => {
    expect([...CONSENT_METHODS]).toEqual([...CONTRACT_METHODS]);
  });

  it('startCapture opens no device, store or meeting without the consent', async () => {
    const deps = {
      store: { list: vi.fn(), put: vi.fn(), append: vi.fn(), chunks: vi.fn(), remove: vi.fn() },
      client: vi.fn(),
      getTabStream: vi.fn(),
      getMicStream: vi.fn(),
      now: () => 0,
    } satisfies CaptureDeps;
    const params = { address: 'https://app.ludy.vn', token: 'crx_x', orgId: 'o', uploads: 'direct', title: 'Họp', consentMethod: 'told_at_start', consentAgreed: false, keepVideo: false, streamId: 's' } as const;
    expect(await startCapture(params, deps)).toEqual({ ok: false, reason: 'consentAgreed' });
    expect(deps.getTabStream).not.toHaveBeenCalled();
    expect(deps.getMicStream).not.toHaveBeenCalled();
    expect(deps.store.list).not.toHaveBeenCalled();
    expect(deps.client).not.toHaveBeenCalled();
  });
});
