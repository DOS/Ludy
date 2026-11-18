// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  APP_IDS,
  MODULE_CATALOG,
  MODULE_IDS,
  MODULE_SCREENS,
  SWITCHABLE_MODULE_IDS,
  appOfModule,
  isKnownModule,
  isSwitchableModule,
  modulesOfApp,
} from '../src/index.ts';

describe('canonical app and module naming hierarchy', () => {
  it('keeps MODULE_IDS, MODULE_CATALOG, and MODULE_SCREENS in lockstep', () => {
    expect(Object.keys(MODULE_CATALOG).sort()).toEqual([...MODULE_IDS].sort());
    expect(Object.keys(MODULE_SCREENS).sort()).toEqual([...MODULE_IDS].sort());
  });

  it('maps every non-kernel module to a declared AppId', () => {
    expect(appOfModule('kernel')).toBeNull();
    expect(isSwitchableModule('kernel')).toBe(false);
    for (const id of SWITCHABLE_MODULE_IDS) {
      const appId = appOfModule(id);
      expect(appId).not.toBeNull();
      expect(APP_IDS).toContain(appId);
      expect(modulesOfApp(appId!)).toContain(id);
      expect(isKnownModule(id)).toBe(true);
      expect(isSwitchableModule(id)).toBe(true);
    }
  });

  it('groups multi-module Apps and leaves ai without a separate switchable module', () => {
    expect(modulesOfApp('teamwork')).toEqual(['notes', 'projects', 'meetings']);
    expect(modulesOfApp('engage')).toEqual(['social', 'crm', 'ads']);
    expect(modulesOfApp('finance')).toEqual(['finance']);
    expect(modulesOfApp('hr')).toEqual(['hr']);
    expect(modulesOfApp('sign')).toEqual(['sign']);
    expect(modulesOfApp('ai')).toEqual([]);
  });

  it('rejects unknown module slugs', () => {
    expect(isKnownModule('accounting')).toBe(false);
    expect(isSwitchableModule('accounting')).toBe(false);
    expect(appOfModule('accounting')).toBeNull();
  });
});
