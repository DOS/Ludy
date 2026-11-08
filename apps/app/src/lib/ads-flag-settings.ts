// SPDX-License-Identifier: AGPL-3.0-only
// The thresholds of the spend flags as the Ads screen edits them (issue #2378): five fields of text, each empty (the default applies) or a
// number inside the server's bounds. Nothing here reads or writes: it turns the stored setting into the form and the form into the call, and
// says which field is wrong. The server checks the same bounds again (and so does the database). A comma is read as the decimal point, since
// the keypad of a phone set to Vietnamese shows only a comma.
import { ADS_FLAG_FACTOR, type AdsFlagSetting } from '@crove/kernel-contract';

export const FLAG_FIELDS = ['paceMinDays', 'dayFactor', 'cprFactor', 'cprMinResults', 'cprMinHistoryDays'] as const;
export type FlagField = (typeof FLAG_FIELDS)[number];
export type FlagForm = Record<FlagField, string>;

// Whole numbers, with the bounds of the contract; the factors are ratios above 1 and at most 10 with at most two decimals.
const WHOLE: Record<'paceMinDays' | 'cprMinResults' | 'cprMinHistoryDays', { min: number; max: number }> = {
  paceMinDays: { min: 1, max: 15 },
  cprMinResults: { min: 1, max: 100000 },
  cprMinHistoryDays: { min: 3, max: 14 },
};

// What was typed, without spaces around it and with the decimal point a comma stands for.
const typed = (text: string): string => text.trim().replace(',', '.');

export const formOf = (set: AdsFlagSetting): FlagForm => ({
  paceMinDays: set.paceMinDays === null ? '' : String(set.paceMinDays),
  dayFactor: set.dayFactor ?? '',
  cprFactor: set.cprFactor ?? '',
  cprMinResults: set.cprMinResults === null ? '' : String(set.cprMinResults),
  cprMinHistoryDays: set.cprMinHistoryDays === null ? '' : String(set.cprMinHistoryDays),
});

export const isFlagFieldValid = (field: FlagField, text: string): boolean => {
  const value = typed(text);
  if (value === '') return true;
  if (field === 'dayFactor' || field === 'cprFactor') return ADS_FLAG_FACTOR.test(value);
  if (!/^\d{1,6}$/.test(value)) return false;
  const bounds = WHOLE[field];
  return Number(value) >= bounds.min && Number(value) <= bounds.max;
};

// The fields that are wrong, in the form's order; the call can be made when there are none.
export const wrongFlagFields = (form: FlagForm): FlagField[] => FLAG_FIELDS.filter((field) => !isFlagFieldValid(field, form[field]));

// The call's thresholds: an empty field goes back to the default (`null`). Only for a form with no wrong field.
export function settingOf(form: FlagForm): AdsFlagSetting {
  const whole = (field: keyof typeof WHOLE): number | null => (typed(form[field]) === '' ? null : Number(typed(form[field])));
  const factor = (field: 'dayFactor' | 'cprFactor'): string | null => (typed(form[field]) === '' ? null : typed(form[field]));
  return { paceMinDays: whole('paceMinDays'), dayFactor: factor('dayFactor'), cprFactor: factor('cprFactor'), cprMinResults: whole('cprMinResults'), cprMinHistoryDays: whole('cprMinHistoryDays') };
}

export const sameForm = (a: FlagForm, b: FlagForm): boolean => FLAG_FIELDS.every((field) => typed(a[field]) === typed(b[field]));
