// SPDX-License-Identifier: AGPL-3.0-only
// The pure rules of managing a running ad (ads W4, #3835): what a launch holds against the caps once changes were asked for, what state each object is in, what a budget or an end
// date may be changed to, which stop condition stops which change, and what Uy suggests. No database, no platform.
import { committedProblems } from '../src/launch-caps.ts';
import { describe, expect, it } from 'vitest';
import { ADS_MANAGE_KINDS, type AdsManageKind } from '@crove/kernel-contract';
import { addDays, currencyDecimals } from '../src/domain.ts';
import {
  OPENING_KINDS,
  budgetProblem,
  changeIdOfKey,
  flightLength,
  heldValues,
  largestAmount,
  manageCallKey,
  manageStep,
  objectStatusOf,
  sameAmount,
  sameInstant,
  scheduleProblem,
  statusProblem,
  ownAround,
  unclearOpen,
  judgedFrom,
  stopsChange,
  suggestionFor,
  type ChangeRow,
} from '../src/manage-rules.ts';

const LEDGER = { dailyBudget: '100000', endOn: '2026-11-16' };
const budget = (seq: number, kind: 'budget_lower' | 'budget_raise', state: ChangeRow['state'], toBudget: string): ChangeRow => ({ seq, slot: 'ad_set', kind, state, toBudget, toEndOn: null });
const schedule = (seq: number, kind: 'schedule_shorten' | 'schedule_extend', state: ChangeRow['state'], toEndOn: string): ChangeRow => ({ seq, slot: 'ad_set', kind, state, toBudget: null, toEndOn });
const status = (seq: number, kind: 'pause' | 'resume' | 'archive', state: ChangeRow['state'], slot: ChangeRow['slot'] = 'campaign'): ChangeRow => ({ seq, slot, kind, state, toBudget: null, toEndOn: null });

describe('heldValues: what a launch holds against the caps', () => {
  it('is the ledger\'s own budget and last day when nothing was asked for', () => {
    expect(heldValues(LEDGER, [])).toEqual({ dailyBudget: '100000', endOn: '2026-11-16', confirmedBudget: '100000', confirmedEndOn: '2026-11-16' });
  });

  it('takes the newest APPLIED change of the family, by seq and not by the order of the list', () => {
    const rows = [budget(3, 'budget_lower', 'applied', '90000'), budget(1, 'budget_raise', 'applied', '150000'), budget(2, 'budget_lower', 'applied', '120000')];
    expect(heldValues(LEDGER, rows)).toMatchObject({ confirmedBudget: '90000', dailyBudget: '90000' });
    const days = [schedule(2, 'schedule_shorten', 'applied', '2026-11-18'), schedule(1, 'schedule_extend', 'applied', '2026-11-20')];
    expect(heldValues(LEDGER, days)).toMatchObject({ confirmedEndOn: '2026-11-18', endOn: '2026-11-18' });
  });

  it('holds a queued or unclear raise that is newer than what was confirmed, if it is higher', () => {
    expect(heldValues(LEDGER, [budget(1, 'budget_raise', 'queued', '150000')])).toMatchObject({ dailyBudget: '150000', confirmedBudget: '100000' });
    expect(heldValues(LEDGER, [budget(1, 'budget_raise', 'unclear', '150000')])).toMatchObject({ dailyBudget: '150000', confirmedBudget: '100000' });
    // The highest of several open raises.
    expect(heldValues(LEDGER, [budget(1, 'budget_raise', 'queued', '150000'), budget(2, 'budget_raise', 'unclear', '180000'), budget(3, 'budget_raise', 'queued', '120000')]).dailyBudget).toBe('180000');
    // Newer than the applied one only: an open raise asked for before the confirmed change is settled by it.
    const older = [budget(1, 'budget_raise', 'unclear', '200000'), budget(2, 'budget_lower', 'applied', '80000')];
    expect(heldValues(LEDGER, older)).toMatchObject({ dailyBudget: '80000', confirmedBudget: '80000' });
    const newer = [budget(1, 'budget_lower', 'applied', '80000'), budget(2, 'budget_raise', 'queued', '200000')];
    expect(heldValues(LEDGER, newer)).toMatchObject({ dailyBudget: '200000', confirmedBudget: '80000' });
    // A raise that is not higher than what was confirmed holds nothing more.
    expect(heldValues(LEDGER, [budget(1, 'budget_raise', 'queued', '100000')]).dailyBudget).toBe('100000');
    expect(heldValues(LEDGER, [budget(1, 'budget_raise', 'queued', '50000')]).dailyBudget).toBe('100000');
  });

  it('holds nothing back for a lower budget or a shorter schedule that waits for the platform', () => {
    expect(heldValues(LEDGER, [budget(1, 'budget_lower', 'queued', '50000')])).toMatchObject({ dailyBudget: '100000', confirmedBudget: '100000' });
    expect(heldValues(LEDGER, [budget(1, 'budget_lower', 'unclear', '50000')])).toMatchObject({ dailyBudget: '100000', confirmedBudget: '100000' });
    expect(heldValues(LEDGER, [schedule(1, 'schedule_shorten', 'queued', '2026-11-12')])).toMatchObject({ endOn: '2026-11-16', confirmedEndOn: '2026-11-16' });
    expect(heldValues(LEDGER, [schedule(1, 'schedule_shorten', 'unclear', '2026-11-12')])).toMatchObject({ endOn: '2026-11-16', confirmedEndOn: '2026-11-16' });
  });

  it('counts a failed or cancelled change for nothing', () => {
    for (const state of ['failed', 'cancelled'] as const) {
      expect(heldValues(LEDGER, [budget(1, 'budget_raise', state, '900000'), schedule(2, 'schedule_extend', state, '2026-12-31')])).toEqual({ dailyBudget: '100000', endOn: '2026-11-16', confirmedBudget: '100000', confirmedEndOn: '2026-11-16' });
      // Nor does a failed lower change what was confirmed.
      expect(heldValues(LEDGER, [budget(1, 'budget_lower', state, '10')]).confirmedBudget).toBe('100000');
      expect(heldValues(LEDGER, [schedule(1, 'schedule_shorten', state, '2026-11-01')]).confirmedEndOn).toBe('2026-11-16');
    }
  });

  it('holds the last day of an open extension that is newer than the confirmed one, if it is later', () => {
    expect(heldValues(LEDGER, [schedule(1, 'schedule_extend', 'queued', '2026-11-25')])).toMatchObject({ endOn: '2026-11-25', confirmedEndOn: '2026-11-16' });
    expect(heldValues(LEDGER, [schedule(1, 'schedule_extend', 'unclear', '2026-11-25'), schedule(2, 'schedule_extend', 'queued', '2026-11-20')]).endOn).toBe('2026-11-25');
    // Asked for before the applied change: settled by it. After it: held.
    expect(heldValues(LEDGER, [schedule(1, 'schedule_extend', 'unclear', '2026-12-10'), schedule(2, 'schedule_shorten', 'applied', '2026-11-14')])).toMatchObject({ endOn: '2026-11-14', confirmedEndOn: '2026-11-14' });
    expect(heldValues(LEDGER, [schedule(1, 'schedule_shorten', 'applied', '2026-11-14'), schedule(2, 'schedule_extend', 'queued', '2026-11-18')])).toMatchObject({ endOn: '2026-11-18', confirmedEndOn: '2026-11-14' });
  });

  it('keeps the two families apart, and changes of a status are not part of either', () => {
    const rows = [budget(1, 'budget_raise', 'applied', '130000'), schedule(2, 'schedule_extend', 'queued', '2026-11-30'), status(3, 'pause', 'applied'), status(4, 'resume', 'queued')];
    expect(heldValues(LEDGER, rows)).toEqual({ dailyBudget: '130000', endOn: '2026-11-30', confirmedBudget: '130000', confirmedEndOn: '2026-11-16' });
  });

  it('does decimal arithmetic on money, whatever the trailing zeros', () => {
    const ledger = { dailyBudget: '100000.50', endOn: '2026-11-16' };
    expect(heldValues(ledger, [])).toMatchObject({ dailyBudget: '100000.5', confirmedBudget: '100000.5' });
    // '100000.50' is not higher than '100000.5', though a text comparison would say so.
    expect(heldValues({ dailyBudget: '100000.5', endOn: '2026-11-16' }, [budget(1, 'budget_raise', 'queued', '100000.50')]).dailyBudget).toBe('100000.5');
    expect(heldValues({ dailyBudget: '100000.5', endOn: '2026-11-16' }, [budget(1, 'budget_raise', 'queued', '100000.51')]).dailyBudget).toBe('100000.51');
    // A number that is longer as text but smaller as a number, and one that is shorter but larger.
    expect(heldValues({ dailyBudget: '9', endOn: '2026-11-16' }, [budget(1, 'budget_raise', 'queued', '10')]).dailyBudget).toBe('10');
    expect(heldValues({ dailyBudget: '10', endOn: '2026-11-16' }, [budget(1, 'budget_raise', 'queued', '9.99')]).dailyBudget).toBe('10');
    expect(heldValues({ dailyBudget: '0.1', endOn: '2026-11-16' }, [budget(1, 'budget_raise', 'applied', '0.30')]).confirmedBudget).toBe('0.3');
  });
});

describe('objectStatusOf', () => {
  it('is active with nothing pending for an object nothing was asked of', () => {
    expect(objectStatusOf('campaign', [])).toEqual({ status: 'active', pending: null });
    expect(objectStatusOf('campaign', [budget(1, 'budget_raise', 'queued', '1'), schedule(2, 'schedule_extend', 'applied', '2026-12-01')])).toEqual({ status: 'active', pending: null });
  });

  it('follows the newest applied pause or resume of the slot, in the order of seq', () => {
    expect(objectStatusOf('campaign', [status(1, 'pause', 'applied')])).toEqual({ status: 'paused', pending: null });
    expect(objectStatusOf('campaign', [status(2, 'resume', 'applied'), status(1, 'pause', 'applied')])).toEqual({ status: 'active', pending: null });
    expect(objectStatusOf('campaign', [status(3, 'pause', 'applied'), status(1, 'pause', 'applied'), status(2, 'resume', 'applied')])).toEqual({ status: 'paused', pending: null });
  });

  it('never leaves archived', () => {
    expect(objectStatusOf('ad_1', [status(1, 'archive', 'applied', 'ad_1')])).toEqual({ status: 'archived', pending: null });
    expect(objectStatusOf('ad_1', [status(1, 'archive', 'applied', 'ad_1'), status(2, 'resume', 'applied', 'ad_1'), status(3, 'pause', 'applied', 'ad_1')])).toEqual({ status: 'archived', pending: null });
    expect(objectStatusOf('ad_1', [status(1, 'pause', 'applied', 'ad_1'), status(2, 'archive', 'applied', 'ad_1')]).status).toBe('archived');
  });

  it('names the change that waits for the platform (queued) and the newest of them', () => {
    expect(objectStatusOf('campaign', [status(1, 'pause', 'queued')])).toEqual({ status: 'active', pending: 'pause' });
    expect(objectStatusOf('campaign', [status(1, 'pause', 'applied'), status(2, 'resume', 'queued')])).toEqual({ status: 'paused', pending: 'resume' });
    expect(objectStatusOf('campaign', [status(2, 'archive', 'queued'), status(1, 'pause', 'queued')])).toEqual({ status: 'active', pending: 'archive' });
  });

  it('never hides a way to stop spend behind an unclear change: an unclear resume is taken as done (the object may be spending), an unclear pause or archive as not done', () => {
    expect(objectStatusOf('campaign', [status(1, 'pause', 'applied'), status(2, 'resume', 'unclear')])).toEqual({ status: 'active', pending: null });
    expect(objectStatusOf('campaign', [status(1, 'pause', 'unclear')])).toEqual({ status: 'active', pending: null });
    expect(objectStatusOf('campaign', [status(1, 'archive', 'unclear')])).toEqual({ status: 'active', pending: null });
    // A pause can be asked again after an unclear resume.
    expect(statusProblem('pause', objectStatusOf('campaign', [status(1, 'pause', 'applied'), status(2, 'resume', 'unclear')]))).toBeNull();
  });

  it('counts a failed or cancelled change, and a change of another slot, for nothing', () => {
    expect(objectStatusOf('campaign', [status(1, 'pause', 'failed'), status(2, 'archive', 'cancelled')])).toEqual({ status: 'active', pending: null });
    expect(objectStatusOf('ad_2', [status(1, 'pause', 'applied', 'ad_1'), status(2, 'archive', 'queued', 'campaign')])).toEqual({ status: 'active', pending: null });
  });
});

describe('statusProblem', () => {
  const state = (s: 'active' | 'paused' | 'archived', pending: AdsManageKind | null = null) => ({ status: s, pending });

  it('refuses any change while one is open, whatever the object is', () => {
    for (const kind of ['pause', 'resume', 'archive'] as const) {
      expect(statusProblem(kind, state('active', 'pause'))).toBe('change_open');
      expect(statusProblem(kind, state('archived', 'resume'))).toBe('change_open');
    }
  });

  it('refuses everything for an archived object', () => {
    for (const kind of ['pause', 'resume', 'archive'] as const) expect(statusProblem(kind, state('archived'))).toBe('archived');
  });

  it('pauses what is not paused, resumes only what is paused, archives whatever is live', () => {
    expect(statusProblem('pause', state('active'))).toBeNull();
    expect(statusProblem('pause', state('paused'))).toBe('already_paused');
    expect(statusProblem('resume', state('paused'))).toBeNull();
    expect(statusProblem('resume', state('active'))).toBe('not_paused');
    expect(statusProblem('archive', state('active'))).toBeNull();
    expect(statusProblem('archive', state('paused'))).toBeNull();
  });
});

describe('budgetProblem', () => {
  it('refuses an amount that is not above zero', () => {
    for (const next of ['0', '0.00', '-5']) expect(budgetProblem('budget_raise', '100000', next, 'VND'), next).toBe('budget_invalid');
    expect(budgetProblem('budget_lower', '100000', '0', 'USD')).toBe('budget_invalid');
  });

  it('keeps to the places the currency has: whole dong, cents for the dollar', () => {
    expect(budgetProblem('budget_raise', '100000', '150000', 'VND')).toBeNull();
    expect(budgetProblem('budget_raise', '100000', '150000.5', 'VND')).toBe('budget_decimals');
    // Trailing zeros are no places.
    expect(budgetProblem('budget_raise', '100000', '150000.00', 'VND')).toBeNull();
    expect(budgetProblem('budget_raise', '10', '12.50', 'USD')).toBeNull();
    expect(budgetProblem('budget_raise', '10', '12.505', 'USD')).toBe('budget_decimals');
    expect(budgetProblem('budget_lower', '10', '0.001', 'USD')).toBe('budget_decimals');
    expect(budgetProblem('budget_lower', '10', '9.99', 'USD')).toBeNull();
    expect(currencyDecimals('VND')).toBe(0);
    expect(currencyDecimals('USD')).toBe(2);
  });

  it('refuses a change in the wrong direction, and a change to the same amount', () => {
    expect(budgetProblem('budget_raise', '100000', '100000', 'VND')).toBe('not_higher');
    expect(budgetProblem('budget_raise', '100000', '90000', 'VND')).toBe('not_higher');
    expect(budgetProblem('budget_lower', '100000', '100000', 'VND')).toBe('not_lower');
    expect(budgetProblem('budget_lower', '100000', '110000', 'VND')).toBe('not_lower');
    expect(budgetProblem('budget_lower', '100000', '99999', 'VND')).toBeNull();
    expect(budgetProblem('budget_raise', '100000', '100001', 'VND')).toBeNull();
    // As numbers, not as text.
    expect(budgetProblem('budget_raise', '9', '10', 'USD')).toBeNull();
    expect(budgetProblem('budget_lower', '10', '9', 'USD')).toBeNull();
    expect(budgetProblem('budget_raise', '12.5', '12.50', 'USD')).toBe('not_higher');
  });
});

describe('flightLength and largestAmount', () => {
  it('counts the first and the last day both', () => {
    expect(flightLength('2026-11-10', '2026-11-10')).toBe(1);
    expect(flightLength('2026-11-10', '2026-11-16')).toBe(7);
    expect(flightLength('2026-11-28', '2026-12-03')).toBe(6);
    expect(flightLength('2028-02-28', '2028-03-01')).toBe(3);
    expect(flightLength('2026-12-30', '2027-01-02')).toBe(4);
  });

  it('is the daily budget times those days, in decimal', () => {
    expect(largestAmount('100000', '2026-11-10', '2026-11-16')).toBe('700000');
    expect(largestAmount('0.10', '2026-11-10', '2026-11-12')).toBe('0.3');
    expect(largestAmount('100000.50', '2026-11-10', '2026-11-11')).toBe('200001');
    expect(largestAmount('19.99', '2026-11-10', '2026-11-10')).toBe('19.99');
  });
});

describe('scheduleProblem', () => {
  const base = { startOn: '2026-11-10', heldEndOn: '2026-11-16', today: '2026-11-12' };

  it('shortens to a day that is earlier, and not before today or the first day', () => {
    expect(scheduleProblem('schedule_shorten', { ...base, endOn: '2026-11-15' })).toBeNull();
    // Today itself is allowed (what ran today counts).
    expect(scheduleProblem('schedule_shorten', { ...base, endOn: '2026-11-12' })).toBeNull();
    expect(scheduleProblem('schedule_shorten', { ...base, endOn: '2026-11-11' })).toBe('in_past');
    expect(scheduleProblem('schedule_shorten', { ...base, endOn: '2026-11-16' })).toBe('not_earlier');
    expect(scheduleProblem('schedule_shorten', { ...base, endOn: '2026-11-17' })).toBe('not_earlier');
    // A flight that has not begun: not before its first day either.
    const future = { startOn: '2026-11-20', heldEndOn: '2026-11-25', today: '2026-11-12' };
    expect(scheduleProblem('schedule_shorten', { ...future, endOn: '2026-11-19' })).toBe('in_past');
    expect(scheduleProblem('schedule_shorten', { ...future, endOn: '2026-11-20' })).toBeNull();
  });

  it('extends to a day that is later, within 90 days of the first day, and not a flight that is over', () => {
    expect(scheduleProblem('schedule_extend', { ...base, endOn: '2026-11-17' })).toBeNull();
    expect(scheduleProblem('schedule_extend', { ...base, endOn: '2026-11-16' })).toBe('not_later');
    expect(scheduleProblem('schedule_extend', { ...base, endOn: '2026-11-15' })).toBe('not_later');
    // The last day of the flight is today: still live.
    expect(scheduleProblem('schedule_extend', { ...base, heldEndOn: '2026-11-12', endOn: '2026-11-13' })).toBeNull();
    expect(scheduleProblem('schedule_extend', { ...base, heldEndOn: '2026-11-11', endOn: '2026-11-13' })).toBe('flight_over');
    expect(scheduleProblem('schedule_extend', { ...base, today: '2026-11-17', endOn: '2026-11-20' })).toBe('flight_over');
  });

  it('keeps a flight to 90 days, the first and the last day both counted', () => {
    const last = addDays(base.startOn, 89);
    expect(flightLength(base.startOn, last)).toBe(90);
    expect(scheduleProblem('schedule_extend', { ...base, endOn: last })).toBeNull();
    expect(scheduleProblem('schedule_extend', { ...base, endOn: addDays(last, 1) })).toBe('flight_too_long');
  });
});

describe('the key of a change\'s platform call', () => {
  it('round trips the change id', () => {
    for (const id of ['0190c4a1-0000-7000-8000-000000000001', '0198f3c2-7b1e-7000-8000-0123456789ab']) {
      const key = manageCallKey(id);
      expect(key).toBe(`ads.manage:${id}:apply`);
      expect(changeIdOfKey(key)).toBe(id);
    }
  });

  it('knows no key that is not one of its own', () => {
    const id = '0190c4a1-0000-7000-8000-000000000001';
    for (const key of ['', id, `ads.launch:${id}:apply`, `ads.manage:${id}`, `ads.manage:${id}:apply:x`, `x ads.manage:${id}:apply`, 'ads.manage:short:apply', `ads.manage:${id.toUpperCase()}:apply`, `ads.manage:${id}:activate`]) {
      expect(changeIdOfKey(key), key).toBeNull();
    }
  });

  it('names the step of a change by its kind', () => {
    for (const kind of ADS_MANAGE_KINDS) expect(manageStep(kind)).toBe(`manage_${kind}`);
  });
});

describe('stopsChange', () => {
  const STOPS = ['switch_off', 'launches_blocked', 'account_off', 'connection_closed'] as const;

  it('stops nothing when there is no stop condition', () => {
    for (const kind of ADS_MANAGE_KINDS) expect(stopsChange(null, kind), kind).toBe(false);
  });

  it('stops a pause only when the connection is closed: stopping spend is always allowed', () => {
    for (const stop of STOPS) expect(stopsChange(stop, 'pause'), stop).toBe(stop === 'connection_closed');
  });

  it('stops every other change on any condition, but blocked launches stop only what can raise spend', () => {
    expect(OPENING_KINDS).toEqual(['resume', 'budget_raise', 'schedule_extend']);
    for (const kind of ADS_MANAGE_KINDS.filter((k) => k !== 'pause')) {
      for (const stop of STOPS) {
        const expected = stop === 'launches_blocked' ? OPENING_KINDS.includes(kind) : true;
        expect(stopsChange(stop, kind), `${stop} ${kind}`).toBe(expected);
      }
    }
    // The ones that only reduce spend go on while launches are blocked.
    for (const kind of ['archive', 'budget_lower', 'schedule_shorten'] as const) expect(stopsChange('launches_blocked', kind)).toBe(false);
  });
});

describe('suggestionFor', () => {
  it('is a pause when the cost per result is three times its median or more', () => {
    expect(suggestionFor({ ratio: '3', heldBudget: '100000', currency: 'VND' })).toEqual({ kind: 'pause' });
    expect(suggestionFor({ ratio: '3.0000001', heldBudget: '100000', currency: 'VND' })).toEqual({ kind: 'pause' });
    expect(suggestionFor({ ratio: '12', heldBudget: '100000', currency: 'VND' })).toEqual({ kind: 'pause' });
    expect(suggestionFor({ ratio: '2.99', heldBudget: '100000', currency: 'VND' })).toEqual({ kind: 'budget_lower', toBudget: '70000' });
  });

  it('is 70% of the held budget otherwise, rounded down to the currency\'s own unit', () => {
    expect(suggestionFor({ ratio: '1.5', heldBudget: '100000', currency: 'VND' })).toEqual({ kind: 'budget_lower', toBudget: '70000' });
    expect(suggestionFor({ ratio: '1.5', heldBudget: '100001', currency: 'VND' })).toEqual({ kind: 'budget_lower', toBudget: '70000' });
    expect(suggestionFor({ ratio: '1.5', heldBudget: '100009', currency: 'VND' })).toEqual({ kind: 'budget_lower', toBudget: '70006' });
    expect(suggestionFor({ ratio: '1.5', heldBudget: '10.55', currency: 'USD' })).toEqual({ kind: 'budget_lower', toBudget: '7.38' });
    expect(suggestionFor({ ratio: '1.5', heldBudget: '0.02', currency: 'USD' })).toEqual({ kind: 'budget_lower', toBudget: '0.01' });
  });

  it('is a pause when 70% would round to nothing or would not be lower', () => {
    expect(suggestionFor({ ratio: '1.2', heldBudget: '1', currency: 'VND' })).toEqual({ kind: 'pause' });
    expect(suggestionFor({ ratio: '1.2', heldBudget: '0.01', currency: 'USD' })).toEqual({ kind: 'pause' });
  });

  it('never raises, and a lowered budget is above zero, below the held one and in whole units of the currency (a property over many cases)', () => {
    let seed = 20261119;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let i = 0; i < 3000; i += 1) {
      const currency = (['VND', 'USD', 'JPY'] as const)[next() % 3] as string;
      const places = currencyDecimals(currency);
      // The budget as a whole number of the currency's smallest unit, so the expected answer is exact integer arithmetic.
      const units = BigInt((next() % 5_000_000) + 1);
      const held = places === 0 ? units.toString() : `${units / 100n}.${String(units % 100n).padStart(2, '0')}`;
      const ratio = `${next() % 6}.${String(next() % 100).padStart(2, '0')}`;
      const out = suggestionFor({ ratio, heldBudget: held, currency });
      expect(['pause', 'budget_lower'], `${held} ${currency} ${ratio}`).toContain(out.kind);
      if (Number(ratio) >= 3) {
        expect(out, `${held} ${currency} ${ratio}`).toEqual({ kind: 'pause' });
        continue;
      }
      const expectedUnits = (units * 7n) / 10n;
      if (out.kind === 'pause') {
        expect(expectedUnits === 0n || expectedUnits >= units, `${held} ${currency} ${ratio}`).toBe(true);
        continue;
      }
      expect(out.toBudget).toMatch(places === 0 ? /^[1-9]\d*$/ : /^(0|[1-9]\d*)(\.\d{1,2})?$/);
      const lowered = places === 0 ? BigInt(out.toBudget) : BigInt(Math.round(Number(out.toBudget) * 100));
      expect(lowered, `${held} ${currency} ${ratio}`).toBe(expectedUnits);
      expect(lowered > 0n && lowered < units, `${held} ${currency} ${ratio}`).toBe(true);
    }
  });
});

describe('sameInstant', () => {
  it('is the same moment whatever the offset is written as', () => {
    expect(sameInstant('2026-11-17T00:00:00+0700', '2026-11-17T00:00:00+07:00')).toBe(true);
    expect(sameInstant('2026-11-17T00:00:00+0700', '2026-11-16T17:00:00Z')).toBe(true);
    expect(sameInstant('2026-11-17T00:00:00+0700', '2026-11-16T17:00:00+0000')).toBe(true);
    expect(sameInstant('2026-11-16T19:00:00-0500', '2026-11-17T00:00:00+00:00')).toBe(true);
    expect(sameInstant('2026-11-17T00:00:00-05:00', '2026-11-17T00:00:00-0500')).toBe(true);
    expect(sameInstant('2026-11-17T00:00:00Z', '2026-11-17T00:00:00.000Z')).toBe(true);
  });

  it('is not the same when the moment differs, and never for what is not a time', () => {
    expect(sameInstant('2026-11-17T00:00:00+0700', '2026-11-17T00:00:00+0000')).toBe(false);
    expect(sameInstant('2026-11-17T00:00:00+0700', '2026-11-17T00:00:01+0700')).toBe(false);
    expect(sameInstant('2026-11-17T00:00:00+0700', '2026-11-17')).toBe(false);
    expect(sameInstant('nope', 'nope')).toBe(false);
    expect(sameInstant('', '')).toBe(false);
    expect(sameInstant('2026-11-17T00:00:00+0700', 'nope')).toBe(false);
  });
});

describe('sameAmount', () => {
  it('compares numbers, not text', () => {
    expect(sameAmount('100000.50', '100000.5')).toBe(true);
    expect(sameAmount('0.1', '0.10')).toBe(true);
    expect(sameAmount('100000', '100000.00')).toBe(true);
    expect(sameAmount('100000', '100000.01')).toBe(false);
    expect(sameAmount('9', '10')).toBe(false);
  });
});

describe('judging a change from the day before today', () => {
  it('starts the day before today, never before the launch\'s first day', () => {
    expect(judgedFrom('2026-11-30', '2026-11-16')).toBe('2026-11-29');
    expect(judgedFrom('2026-11-16', '2026-11-16')).toBe('2026-11-16');
    expect(judgedFrom('2026-12-01', '2026-11-16')).toBe('2026-11-30');
  });

  it('keeps what the launch committed before that day and counts the higher budget once on the days where history and plan overlap', () => {
    const row = (startOn: string, endOn: string, dailyBudget = '100000') => ({ adAccountId: 'a', currency: 'VND', dailyBudget, startOn, endOn });
    // Before the day: kept as is. From it on: the plan carries 60 000, and a day that already holds 100 000 carries the 40 000 difference in an extra row.
    expect(ownAround([row('2026-11-16', '2026-11-30')], '2026-11-29', '2026-12-05', '60000')).toEqual([row('2026-11-16', '2026-11-28'), row('2026-11-29', '2026-11-29', '40000'), row('2026-11-30', '2026-11-30', '40000')]);
    // A plan at or above the history adds nothing.
    expect(ownAround([row('2026-11-16', '2026-11-30')], '2026-11-29', '2026-12-05', '140000')).toEqual([row('2026-11-16', '2026-11-28')]);
  });

  it('never replaces history with the plan: a lower budget then an extension is judged at the higher of the two on the days they share (the monthly cap example: 1 125 000, not 975 000)', () => {
    const cap = [{ scope: 'org' as const, adAccountId: null, period: 'monthly' as const, amount: '1000000', currency: 'VND' }];
    // Days 1 to 10 at 100 000; on day 5 a lower budget to 25 000 was confirmed: per day, days 1 to 5 stay at 100 000 and days 6 to 10 are at 25 000.
    const history = [
      { adAccountId: 'a', currency: 'VND', dailyBudget: '100000', startOn: '2026-11-01', endOn: '2026-11-05' },
      { adAccountId: 'a', currency: 'VND', dailyBudget: '25000', startOn: '2026-11-06', endOn: '2026-11-10' },
    ];
    const from = judgedFrom('2026-11-05', '2026-11-01');
    const own = ownAround(history, from, '2026-11-30', '25000');
    const problems = committedProblems({ adAccountId: 'a', currency: 'VND', dailyBudget: '25000', startOn: from, endOn: '2026-11-30' }, own, cap);
    expect(problems.map((p) => p.code)).toEqual(['monthly_cap_exceeded']);
    // 3 days at 100 000 before the judged day, the 2 days after it at 100 000 (25 000 plan + 75 000 extra), then 25 days at 25 000.
    expect(Number(problems[0]?.committed) + Number(problems[0]?.plan)).toBe(1125000);
  });

  it('knows a change of a family that is unclear and not yet replaced by a confirmed one', () => {
    expect(unclearOpen([budget(1, 'budget_raise', 'unclear', '150000')], ['budget_lower', 'budget_raise'])).toBe(true);
    expect(unclearOpen([budget(1, 'budget_raise', 'unclear', '150000'), budget(2, 'budget_lower', 'applied', '120000')], ['budget_lower', 'budget_raise'])).toBe(false);
    expect(unclearOpen([budget(1, 'budget_raise', 'applied', '150000'), budget(2, 'budget_lower', 'unclear', '120000')], ['budget_lower', 'budget_raise'])).toBe(true);
    expect(unclearOpen([schedule(1, 'schedule_extend', 'unclear', '2026-11-20')], ['budget_lower', 'budget_raise'])).toBe(false);
  });
});
