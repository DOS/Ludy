// SPDX-License-Identifier: AGPL-3.0-only
// Native push constants, contract validation, and command/query registry exports (#4883, ADR-0059).
import { describe, expect, it } from 'vitest';
import { zNativePushRegister, zNativePushUnregister } from '@ludy/kernel-contract';
import {
  NATIVE_PUSH_DEVICE_LIMIT,
  NATIVE_PUSH_FAILURE_LIMIT,
  NATIVE_PUSH_KINDS,
  NATIVE_PUSH_MAX_AGE_HOURS,
  kernelCommands,
  kernelQueries,
  nativePushCommands,
  nativePushDevices,
  nativePushQueries,
  nativePushTargets,
  recordNativePushDelivery,
  registerNativePushDevice,
  unregisterNativePushDevice,
} from '../src/index.ts';

const VALID_ID = '01950000-0000-7000-8000-000000000001';

describe('native push kernel definitions and contract schemas', () => {
  it('exports expected notification kinds, limits, risk tags, and registries', () => {
    expect(NATIVE_PUSH_KINDS).toEqual(['kernel.conversation_new', 'kernel.approval_waiting']);
    expect(NATIVE_PUSH_DEVICE_LIMIT).toBe(10);
    expect(NATIVE_PUSH_FAILURE_LIMIT).toBe(10);
    expect(NATIVE_PUSH_MAX_AGE_HOURS).toBe(24);

    expect(registerNativePushDevice.risk).toBe('R2');
    expect(registerNativePushDevice.sideEffect).toBe('external');
    expect(unregisterNativePushDevice.risk).toBe('R1');
    expect(recordNativePushDelivery.access).toBe('system');
    expect(nativePushDevices.access).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(nativePushTargets.access).toBe('system');

    expect(nativePushCommands).toEqual([registerNativePushDevice, unregisterNativePushDevice, recordNativePushDelivery]);
    expect(nativePushQueries).toEqual([nativePushDevices, nativePushTargets]);

    const commands = new Set(kernelCommands);
    for (const cmd of nativePushCommands) expect(commands.has(cmd)).toBe(true);

    const queries = new Set(kernelQueries({ inboundDomain: null }));
    for (const q of nativePushQueries) expect(queries.has(q)).toBe(true);
  });

  it('validates registration tokens and unregister selectors strictly', () => {
    expect(
      zNativePushRegister.parse({
        platform: 'apns',
        token: '  apns-device-token-test  ',
        label: '  iPhone 15  ',
      }),
    ).toEqual({
      platform: 'apns',
      token: 'apns-device-token-test',
      label: 'iPhone 15',
    });

    expect(() => zNativePushRegister.parse({ platform: 'webpush', token: 'test-device-token' })).toThrow();
    expect(() => zNativePushRegister.parse({ platform: 'fcm', token: 'too-short' })).toThrow();
    expect(() => zNativePushRegister.parse({ platform: 'fcm', token: 'token with spaces test' })).toThrow();
    expect(() => zNativePushRegister.parse({ platform: 'fcm', token: 'apns-token-\0-invalid' })).toThrow();
    expect(() => zNativePushRegister.parse({ platform: 'fcm', token: 'test-device-token', label: 'Phone\0One' })).toThrow();
    expect(() => zNativePushRegister.parse({ platform: 'apns', token: 'test-device-token', extra: true })).toThrow();

    expect(zNativePushUnregister.parse({ id: VALID_ID })).toEqual({ id: VALID_ID });
    expect(zNativePushUnregister.parse({ current: true })).toEqual({ current: true });
    expect(zNativePushUnregister.parse({ platform: 'fcm', token: '  test-device-token  ' })).toEqual({
      platform: 'fcm',
      token: 'test-device-token',
    });
    expect(() => zNativePushUnregister.parse({ platform: 'fcm', token: 'apns-token-\0-invalid' })).toThrow();
    expect(() => zNativePushUnregister.parse({ current: false })).toThrow();
    expect(() => zNativePushUnregister.parse({ id: 'bad-id' })).toThrow();
  });
});
