// SPDX-License-Identifier: AGPL-3.0-only
// The pure rules of managing a running ad (ads W4, issue #3835, ADR-0043, plan docs/plan/ads-write.md sections 3.1, 3.3 and 3.4): what a launch holds against the caps once changes
// were asked for, what state each object is in, and what a budget or an end date may be changed to. No database and no platform: the same changes always give the same answer,
// and money is a decimal string whose products and comparisons go through decimal.js (AGENTS.md "Money"). The database computes the same hold (ludy_ads.launch_hold) for the
// caps and the guard; the tests pin the two to each other.
import { Decimal } from 'decimal.js';
import type { AdsManageKind, AdsManageObjectView, AdsManageSlot } from '@ludy/kernel-contract';
import { ADS_PLAN_LIMITS } from '@ludy/kernel-contract';
import { addDays, currencyDecimals } from './domain.ts';
import type { Commitment } from './launch-caps.ts';

// A change as the rules read it (the columns of ludy_ads.ad_manage_change that matter here), in the order they were asked for (`seq`).
export interface ChangeRow {
  seq: number;
  kind: AdsManageKind;
  slot: AdsManageSlot;
  state: 'queued' | 'applied' | 'failed' | 'cancelled' | 'unclear';
  toBudget: string | null;
  toEndOn: string | null;
}

export const BUDGET_KINDS: readonly AdsManageKind[] = ['budget_lower', 'budget_raise'];
export const SCHEDULE_KINDS: readonly AdsManageKind[] = ['schedule_shorten', 'schedule_extend'];
// What can start or raise spend: approved like a launch, and refused while launches are blocked.
export const OPENING_KINDS: readonly AdsManageKind[] = ['resume', 'budget_raise', 'schedule_extend'];

// A change of a family waits for the platform while it is queued; an unclear one may have applied.
const open = (c: ChangeRow) => c.state === 'queued' || c.state === 'unclear';

// What a launch holds against the caps: the budget and the last day the platform confirmed (the newest applied change of the family, else what the ledger says), or a raise or an
// extension that is still queued or unclear and newer than that, if it is higher. A lower budget or a shorter schedule holds nothing back until the platform confirms it.
export function heldValues(ledger: { dailyBudget: string; endOn: string }, changes: readonly ChangeRow[]): { dailyBudget: string; endOn: string; confirmedBudget: string; confirmedEndOn: string } {
  const newest = (kinds: readonly AdsManageKind[], state: ChangeRow['state']) => changes.filter((c) => kinds.includes(c.kind) && c.state === state).sort((a, b) => b.seq - a.seq)[0];
  const appliedBudget = newest(BUDGET_KINDS, 'applied');
  const appliedEnd = newest(SCHEDULE_KINDS, 'applied');
  const confirmedBudget = appliedBudget?.toBudget ?? ledger.dailyBudget;
  const confirmedEndOn = appliedEnd?.toEndOn ?? ledger.endOn;
  let dailyBudget = new Decimal(confirmedBudget);
  for (const c of changes) {
    if (c.kind === 'budget_raise' && open(c) && c.seq > (appliedBudget?.seq ?? 0) && c.toBudget !== null && new Decimal(c.toBudget).gt(dailyBudget)) dailyBudget = new Decimal(c.toBudget);
  }
  let endOn = confirmedEndOn;
  for (const c of changes) {
    if (c.kind === 'schedule_extend' && open(c) && c.seq > (appliedEnd?.seq ?? 0) && c.toEndOn !== null && c.toEndOn > endOn) endOn = c.toEndOn;
  }
  return { dailyBudget: dailyBudget.toFixed(), endOn, confirmedBudget: new Decimal(confirmedBudget).toFixed(), confirmedEndOn };
}

const STATUS_OF: Partial<Record<AdsManageKind, AdsManageObjectView['status']>> = { pause: 'paused', resume: 'active', archive: 'archived' };

// The status of one object, as Ludy last set it and the platform confirmed: a launch that is live has switched its objects on; the newest applied pause, resume or archive of the
// slot is what stands (archived stays archived). `pending` is the change of its status that waits for the platform.
export function objectStatusOf(slot: AdsManageSlot, changes: readonly ChangeRow[]): { status: AdsManageObjectView['status']; pending: AdsManageKind | null } {
  const mine = changes.filter((c) => c.slot === slot && STATUS_OF[c.kind] !== undefined).sort((a, b) => a.seq - b.seq);
  let status: AdsManageObjectView['status'] = 'active';
  for (const c of mine) {
    if (status === 'archived') break;
    // A change whose answer could not be told (unclear) may have landed: a resume is taken as done (the object may be spending, so it shows active and can be paused), a pause or an
    // archive as not done (it shows as it was, so it can be asked again). Never a state that hides a way to stop spend.
    if (c.state === 'applied' || (c.state === 'unclear' && c.kind === 'resume')) status = STATUS_OF[c.kind] as AdsManageObjectView['status'];
  }
  const waiting = mine.filter((c) => c.state === 'queued').pop();
  return { status, pending: waiting ? waiting.kind : null };
}

// What a status change needs the object to be now.
export function statusProblem(kind: 'pause' | 'resume' | 'archive', current: { status: AdsManageObjectView['status']; pending: AdsManageKind | null }): string | null {
  if (current.pending !== null) return 'change_open';
  if (current.status === 'archived') return 'archived';
  if (kind === 'pause' && current.status === 'paused') return 'already_paused';
  if (kind === 'resume' && current.status !== 'paused') return 'not_paused';
  return null;
}

// A budget as a person typed it, against the held one and the currency's own units: refuses a fraction the currency has no place for, and a change in the wrong direction.
export function budgetProblem(kind: 'budget_lower' | 'budget_raise', held: string, next: string, currency: string): string | null {
  const to = new Decimal(next);
  if (to.lte(0)) return 'budget_invalid';
  if (to.decimalPlaces() > currencyDecimals(currency)) return 'budget_decimals';
  if (kind === 'budget_lower' ? !to.lt(held) : !to.gt(held)) return kind === 'budget_lower' ? 'not_lower' : 'not_higher';
  return null;
}

// An end date against the held one, the first day of the flight and today in the account's zone. A shorter schedule ends no earlier than today (what ran counts); a longer one keeps
// the flight within 90 days and cannot revive a flight that is over.
export function scheduleProblem(kind: 'schedule_shorten' | 'schedule_extend', input: { startOn: string; heldEndOn: string; endOn: string; today: string }): string | null {
  if (kind === 'schedule_shorten') {
    if (input.endOn >= input.heldEndOn) return 'not_earlier';
    if (input.endOn < input.startOn || input.endOn < input.today) return 'in_past';
    return null;
  }
  if (input.endOn <= input.heldEndOn) return 'not_later';
  if (input.heldEndOn < input.today) return 'flight_over';
  const days = Math.round((Date.parse(`${input.endOn}T00:00:00Z`) - Date.parse(`${input.startOn}T00:00:00Z`)) / 86_400_000) + 1;
  return days > ADS_PLAN_LIMITS.daysMax ? 'flight_too_long' : null;
}

// The days of a flight, the first and the last day both included.
export const flightLength = (startOn: string, endOn: string): number => Math.round((Date.parse(`${endOn}T00:00:00Z`) - Date.parse(`${startOn}T00:00:00Z`)) / 86_400_000) + 1;

// The largest amount a launch can spend: its daily budget times the days of its flight, in decimal.
export const largestAmount = (dailyBudget: string, startOn: string, endOn: string): string => new Decimal(dailyBudget).times(flightLength(startOn, endOn)).toFixed();

// The key of the one platform call of a change in the kernel's `external_call` ledger (the database's guard looks for this prefix when it cancels a change that was never begun).
export const manageCallKey = (changeId: string): string => `ads.manage:${changeId}:apply`;
export const manageStep = (kind: AdsManageKind): string => `manage_${kind}`;
export function changeIdOfKey(key: string): string | null {
  const match = /^ads\.manage:([0-9a-f-]{36}):apply$/.exec(key);
  return match ? (match[1] as string) : null;
}

// Whether a stop condition (stopConditionOf of the launch job) stops a change before its call: a pause only needs a connection that can still be used (stopping spend is always
// allowed), every other change needs running ads on for the org and the account, and what can start or raise spend is stopped by blocked launches too.
export type StopCondition = 'switch_off' | 'launches_blocked' | 'account_off' | 'connection_closed';
// Every stop condition that holds now (stopConditionOf of the launch job names only the first, and a lower precedence could hide the one that matters for a kind).
export function stopConditions(setting: { write_enabled: boolean; launches_blocked: boolean } | undefined, account: { write_enabled: boolean }, connection: { status: string } | null): StopCondition[] {
  const stops: StopCondition[] = [];
  if (setting?.write_enabled !== true) stops.push('switch_off');
  if (setting?.launches_blocked === true) stops.push('launches_blocked');
  if (account.write_enabled !== true) stops.push('account_off');
  if (!connection || connection.status !== 'active') stops.push('connection_closed');
  return stops;
}

export function stopsChange(stop: StopCondition | readonly StopCondition[] | null, kind: AdsManageKind): boolean {
  const stops = stop === null ? [] : typeof stop === 'string' ? [stop] : stop;
  if (kind === 'pause') return stops.includes('connection_closed');
  return stops.some((s) => s !== 'launches_blocked' || OPENING_KINDS.includes(kind));
}

// Uy's suggestion for a campaign whose cost per result is `ratio` times its own median: a pause when it is far over (three times), otherwise a lower daily budget (70% of the
// one the launch holds, rounded down to the currency's own unit), and a pause when that would not be lower. Deterministic, and never a raise.
export function suggestionFor(input: { ratio: string; heldBudget: string; currency: string }): { kind: 'pause' } | { kind: 'budget_lower'; toBudget: string } {
  if (new Decimal(input.ratio).gte(3)) return { kind: 'pause' };
  const lowered = new Decimal(input.heldBudget).times('0.7').toDecimalPlaces(currencyDecimals(input.currency), Decimal.ROUND_DOWN);
  if (lowered.lte(0) || lowered.gte(input.heldBudget)) return { kind: 'pause' };
  return { kind: 'budget_lower', toBudget: lowered.toFixed() };
}

// Whether two ISO 8601 moments are the same instant, whatever offset each is written in (`+0700` and `+07:00`): the read that settles a lost answer compares the platform's end
// time with the one asked for.
export function sameInstant(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const x = Date.parse(norm(a));
  const y = Date.parse(norm(b));
  return Number.isFinite(x) && Number.isFinite(y) && x === y;
}

// Whether two amounts (decimal strings) are the same number, whatever their trailing zeros: the read that settles a lost answer compares the platform's budget with the one asked for.
export const sameAmount = (a: string, b: string): boolean => new Decimal(a).eq(b);

// The first day a change of a launch is judged from: the day before today in the account's zone (the latest any zone can be on, minus one: a raise approved now may run from
// today, and in a zone ahead of this one it already is tomorrow), never before the launch's first day.
export const judgedFrom = (today: string, startOn: string): string => {
  const day = addDays(today, -1);
  return day < startOn ? startOn : day;
};

// A launch's own commitment around the day a change is judged from, as what the caps are judged with. Before that day the rows stay as they are (what ran is never released and
// never replaced). From that day on the plan is the launch's budget, but on a day where the commitment already holds a HIGHER budget (a lower budget confirmed today, a raise that
// may already be running) the higher one still counts: the plan carries `budget` for every day and an extra row carries the difference on those days, so the day counts at the
// higher of the two, once.
export function ownAround(own: readonly Commitment[], from: string, to: string, budget: string): Commitment[] {
  const out: Commitment[] = [];
  const perDay = new Map<string, Decimal>();
  for (const row of own) {
    if (row.startOn < from) out.push(row.endOn >= from ? { ...row, endOn: addDays(from, -1) } : row);
    for (let day = row.startOn < from ? from : row.startOn; day <= row.endOn && day <= to; day = addDays(day, 1)) {
      const held = new Decimal(row.dailyBudget);
      const seen = perDay.get(day);
      if (!seen || held.gt(seen)) perDay.set(day, held);
    }
  }
  for (const [day, held] of perDay) {
    if (held.gt(budget)) {
      const base = own[0];
      if (base) out.push({ adAccountId: base.adAccountId, currency: base.currency, dailyBudget: held.minus(budget).toFixed(), startOn: day, endOn: day });
    }
  }
  return out;
}

// Whether a change of a family (the budget, the schedule) is unclear and no later change of it was confirmed: what the platform runs is not known, so a lower budget or a shorter
// schedule (which needs no approval) could really be a raise, and is refused until the unclear change is settled by a confirmed one.
export function unclearOpen(changes: readonly ChangeRow[], kinds: readonly AdsManageKind[]): boolean {
  const mine = changes.filter((c) => kinds.includes(c.kind));
  const applied = mine.filter((c) => c.state === 'applied').reduce((max, c) => Math.max(max, c.seq), 0);
  return mine.some((c) => c.state === 'unclear' && c.seq > applied);
}

// How old the last touch of an unclear change's call must be before the sweep settles it by a read: a call whose answer was lost may still be landing, and a read that comes too
// soon would take "not yet" for "never". The database's pick function uses the same ten minutes.
export const SETTLE_MIN_AGE_SECONDS = 600;

// Whether a read of the object can settle this unclear change: it is unclear, and no newer change of its family is queued, applied or unclear (a newer one is what the platform shows
// now, so the read says nothing of this one; a failed or cancelled one never ran). The family is the budget, the schedule, or the status of one slot. The same rule as the database's
// guard, which refuses the settlement of any other.
export function settleCandidate(changes: readonly (ChangeRow & { id: string })[], changeId: string): boolean {
  const change = changes.find((c) => c.id === changeId);
  if (!change || change.state !== 'unclear') return false;
  const familyOf = (c: ChangeRow): string => (BUDGET_KINDS.includes(c.kind) ? 'budget' : SCHEDULE_KINDS.includes(c.kind) ? 'schedule' : `status:${c.slot}`);
  const mine = familyOf(change);
  return !changes.some((c) => c.seq > change.seq && familyOf(c) === mine && (c.state === 'queued' || c.state === 'applied' || c.state === 'unclear'));
}
