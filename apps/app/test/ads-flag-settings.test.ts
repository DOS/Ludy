// SPDX-License-Identifier: AGPL-3.0-only
// The form of the spend-flag thresholds (#2378): an empty field is the default, a field inside the server's bounds is a number or a ratio, and
// the call carries `null` for every field left empty.
import { describe, expect, it } from 'vitest';
import { zAdsFlagSetting } from '@crove/kernel-contract';
import { formOf, isFlagFieldValid, sameForm, settingOf, wrongFlagFields, type FlagForm } from '../src/lib/ads-flag-settings.ts';

const empty: FlagForm = { paceMinDays: '', dayFactor: '', cprFactor: '', cprMinResults: '', cprMinHistoryDays: '' };

describe('the flag thresholds form', () => {
  it('shows a threshold that was never set as an empty field, and sends an empty field back as the default', () => {
    expect(formOf({ paceMinDays: null, dayFactor: null, cprFactor: null, cprMinResults: null, cprMinHistoryDays: null })).toEqual(empty);
    expect(formOf({ paceMinDays: 4, dayFactor: '2.5', cprFactor: null, cprMinResults: 20, cprMinHistoryDays: 7 })).toEqual({ paceMinDays: '4', dayFactor: '2.5', cprFactor: '', cprMinResults: '20', cprMinHistoryDays: '7' });
    expect(settingOf(empty)).toEqual({ paceMinDays: null, dayFactor: null, cprFactor: null, cprMinResults: null, cprMinHistoryDays: null });
    expect(settingOf({ paceMinDays: ' 4 ', dayFactor: '2.5', cprFactor: '', cprMinResults: '20', cprMinHistoryDays: '7' })).toEqual({ paceMinDays: 4, dayFactor: '2.5', cprFactor: null, cprMinResults: 20, cprMinHistoryDays: 7 });
  });

  it('accepts the whole numbers inside their bounds and the ratios above 1 and up to 10, and names what is wrong', () => {
    expect(isFlagFieldValid('paceMinDays', '1')).toBe(true);
    expect(isFlagFieldValid('paceMinDays', '15')).toBe(true);
    expect(isFlagFieldValid('paceMinDays', '0')).toBe(false);
    expect(isFlagFieldValid('paceMinDays', '16')).toBe(false);
    expect(isFlagFieldValid('paceMinDays', '2.5')).toBe(false);
    expect(isFlagFieldValid('cprMinHistoryDays', '2')).toBe(false);
    expect(isFlagFieldValid('cprMinHistoryDays', '14')).toBe(true);
    expect(isFlagFieldValid('cprMinResults', '100000')).toBe(true);
    expect(isFlagFieldValid('cprMinResults', '100001')).toBe(false);
    for (const ok of ['1.01', '1.5', '2', '9.99', '10', '10.00']) expect(isFlagFieldValid('dayFactor', ok), ok).toBe(true);
    for (const bad of ['1', '1.0', '1.00', '0.5', '10.01', '11', '1.555', 'abc', '-2']) expect(isFlagFieldValid('cprFactor', bad), bad).toBe(false);
    expect(wrongFlagFields({ ...empty, paceMinDays: '0', cprFactor: '1', cprMinResults: '5' })).toEqual(['paceMinDays', 'cprFactor']);
    expect(wrongFlagFields(empty)).toEqual([]);
  });

  it('only ever sends what the contract accepts', () => {
    const good: FlagForm = { paceMinDays: '15', dayFactor: '10', cprFactor: '1.01', cprMinResults: '100000', cprMinHistoryDays: '14' };
    expect(wrongFlagFields(good)).toEqual([]);
    expect(zAdsFlagSetting.safeParse(settingOf(good)).success).toBe(true);
    expect(zAdsFlagSetting.safeParse(settingOf(empty)).success).toBe(true);
    // The contract and the form agree on the ratio edges.
    for (const text of ['1', '1.0', '1.00', '10.01', '1.555', '2.5']) expect(zAdsFlagSetting.safeParse({ ...settingOf(empty), dayFactor: text }).success, text).toBe(isFlagFieldValid('dayFactor', text));
  });

  it('tells a form that changed from the stored one, ignoring spaces', () => {
    expect(sameForm(empty, { ...empty, paceMinDays: ' ' })).toBe(true);
    expect(sameForm(empty, { ...empty, paceMinDays: '4' })).toBe(false);
  });

  it('reads a comma as the decimal point, since a phone set to Vietnamese has no other key', () => {
    expect(isFlagFieldValid('dayFactor', '1,5')).toBe(true);
    expect(isFlagFieldValid('cprFactor', '2,25')).toBe(true);
    expect(isFlagFieldValid('cprFactor', '1,0')).toBe(false);
    expect(isFlagFieldValid('cprFactor', '10,01')).toBe(false);
    expect(isFlagFieldValid('paceMinDays', '2,5')).toBe(false);
    expect(settingOf({ ...empty, dayFactor: ' 1,5 ', cprFactor: '2.5' })).toMatchObject({ dayFactor: '1.5', cprFactor: '2.5' });
    expect(zAdsFlagSetting.safeParse(settingOf({ ...empty, dayFactor: '1,5' })).success).toBe(true);
    expect(sameForm({ ...empty, dayFactor: '1,5' }, { ...empty, dayFactor: '1.5' })).toBe(true);
  });
});
