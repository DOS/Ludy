// SPDX-License-Identifier: AGPL-3.0-only
// Managing a running ad on the Campaigns screen (ads W4, issue #3835, plan docs/plan/ads-write.md): what a person is offered for a live launch (pause, resume and archive an
// object, lower or raise the daily budget, shorten or extend the schedule), what each control sends, the words for the state of a change and for the refusals of the server,
// and the checks of what was typed. The server decides every rule (the caps, the switches, the approval); these only choose what to show and what to send. Money is a decimal
// string and is compared exactly (lib/decimal.ts), never as a JS number.
import {
  zAdsBudget,
  type AdsManageChangeView,
  type AdsManageKind,
  type AdsManageObjectView,
  type AdsManageSlot,
  type AdsManageState,
  type AdsManageSuggestion,
  type AdsManageStateView,
} from '@crove/kernel-contract';
import type { Translate } from '../i18n/runtime.ts';
import { toUnits } from './decimal.ts';
import { parseMoneyInput } from './money-input.ts';

// What a person asks for. A resume, a raise and an extension are requests for approval (a proposal in the Inbox); the others reduce spend and apply without one.
export type ManageRequest =
  | { kind: 'pause' | 'resume' | 'archive'; launchId: string; slot: AdsManageSlot }
  | { kind: 'budget_lower' | 'budget_raise'; launchId: string; dailyBudget: string }
  | { kind: 'schedule_shorten' | 'schedule_extend'; launchId: string; endOn: string }
  | { kind: 'cancel'; changeId: string };

const APPROVED_KINDS: readonly ManageRequest['kind'][] = ['resume', 'budget_raise', 'schedule_extend'];

// Whether the request makes a proposal that waits in the Inbox, instead of applying (after the platform confirms it) on its own.
export const needsApproval = (request: ManageRequest): boolean => APPROVED_KINDS.includes(request.kind);

// The API call of a request: the procedure of `ads` and its input, with the idempotency key. Kept apart from the screen so what each control sends is checked on its own.
export type ManageCall =
  | { procedure: 'pauseObject' | 'archiveObject'; input: { launchId: string; slot: AdsManageSlot; idempotencyKey: string } }
  | { procedure: 'lowerBudget'; input: { launchId: string; dailyBudget: string; idempotencyKey: string } }
  | { procedure: 'shortenSchedule'; input: { launchId: string; endOn: string; idempotencyKey: string } }
  | { procedure: 'cancelChange'; input: { changeId: string; idempotencyKey: string } }
  | { procedure: 'requestChange'; input: { change: 'object_resume'; launchId: string; slot: AdsManageSlot; idempotencyKey: string } }
  | { procedure: 'requestChange'; input: { change: 'budget_raise'; launchId: string; dailyBudget: string; idempotencyKey: string } }
  | { procedure: 'requestChange'; input: { change: 'schedule_extend'; launchId: string; endOn: string; idempotencyKey: string } };

export function manageCall(request: ManageRequest, idempotencyKey: string): ManageCall {
  switch (request.kind) {
    case 'pause':
      return { procedure: 'pauseObject', input: { launchId: request.launchId, slot: request.slot, idempotencyKey } };
    case 'archive':
      return { procedure: 'archiveObject', input: { launchId: request.launchId, slot: request.slot, idempotencyKey } };
    case 'resume':
      return { procedure: 'requestChange', input: { change: 'object_resume', launchId: request.launchId, slot: request.slot, idempotencyKey } };
    case 'budget_lower':
      return { procedure: 'lowerBudget', input: { launchId: request.launchId, dailyBudget: request.dailyBudget, idempotencyKey } };
    case 'budget_raise':
      return { procedure: 'requestChange', input: { change: 'budget_raise', launchId: request.launchId, dailyBudget: request.dailyBudget, idempotencyKey } };
    case 'schedule_shorten':
      return { procedure: 'shortenSchedule', input: { launchId: request.launchId, endOn: request.endOn, idempotencyKey } };
    case 'schedule_extend':
      return { procedure: 'requestChange', input: { change: 'schedule_extend', launchId: request.launchId, endOn: request.endOn, idempotencyKey } };
    case 'cancel':
      return { procedure: 'cancelChange', input: { changeId: request.changeId, idempotencyKey } };
  }
}

// The procedures `runManage` calls: the `ads` group of the API client, as far as this screen uses it.
export interface ManageApi {
  pauseObject: (input: Extract<ManageCall, { procedure: 'pauseObject' | 'archiveObject' }>['input']) => Promise<unknown>;
  archiveObject: (input: Extract<ManageCall, { procedure: 'pauseObject' | 'archiveObject' }>['input']) => Promise<unknown>;
  lowerBudget: (input: Extract<ManageCall, { procedure: 'lowerBudget' }>['input']) => Promise<unknown>;
  shortenSchedule: (input: Extract<ManageCall, { procedure: 'shortenSchedule' }>['input']) => Promise<unknown>;
  cancelChange: (input: Extract<ManageCall, { procedure: 'cancelChange' }>['input']) => Promise<unknown>;
  requestChange: (input: Extract<ManageCall, { procedure: 'requestChange' }>['input']) => Promise<{ proposalId: string }>;
}

// What the call answered: the proposal a request for approval made (the Inbox item to link to), or nothing for a change that applies on its own.
export interface ManageOutcome {
  proposalId: string | null;
}

export async function runManage(api: ManageApi, request: ManageRequest, idempotencyKey: string): Promise<ManageOutcome> {
  const call = manageCall(request, idempotencyKey);
  switch (call.procedure) {
    case 'requestChange':
      return { proposalId: (await api.requestChange(call.input)).proposalId };
    case 'pauseObject':
      await api.pauseObject(call.input);
      return { proposalId: null };
    case 'archiveObject':
      await api.archiveObject(call.input);
      return { proposalId: null };
    case 'lowerBudget':
      await api.lowerBudget(call.input);
      return { proposalId: null };
    case 'shortenSchedule':
      await api.shortenSchedule(call.input);
      return { proposalId: null };
    case 'cancelChange':
      await api.cancelChange(call.input);
      return { proposalId: null };
  }
}

// A retry of the same request after a lost answer is the same request (the same key); a changed one is another. The signature is what the key is held for.
export const requestSignature = (request: ManageRequest): string => JSON.stringify(request);

// ---- What a person is offered ----

export type ObjectOffer = 'pause' | 'resume' | 'archive';

export interface ManageOffers {
  // Whether the screen shows controls at all: an owner or an admin, on a launch that is live. A member (or anyone else) reads the state only.
  controls: boolean;
  // Only Pause is offered, and the screen says why: running ads is off, the account is not enabled or launches are blocked (stopping spend is always allowed).
  limited: boolean;
  // The ad set's budget and schedule, each offered once no change of its own kind waits for the platform.
  lowerBudget: boolean;
  raiseBudget: boolean;
  shortenSchedule: boolean;
  extendSchedule: boolean;
  // A budget or a schedule change of the same family is still waiting for the platform: its control is held back and the screen says so.
  budgetWaiting: boolean;
  scheduleWaiting: boolean;
  // Per object (by slot), what can be done to it now.
  objects: Record<string, ObjectOffer[]>;
}

const NONE: ManageOffers = { controls: false, limited: false, lowerBudget: false, raiseBudget: false, shortenSchedule: false, extendSchedule: false, budgetWaiting: false, scheduleWaiting: false, objects: {} };

// What one object offers: nothing while a change of its own waits for the platform or once it is archived (permanent); a running one can be paused, a paused one resumed
// (an approval); either can be archived. Without `canChange` only a pause is left.
export function objectOffers(object: Pick<AdsManageObjectView, 'status' | 'pending'>, canChange: boolean): ObjectOffer[] {
  if (object.pending !== null || object.status === 'archived') return [];
  if (!canChange) return object.status === 'active' ? ['pause'] : [];
  return object.status === 'active' ? ['pause', 'archive'] : ['resume', 'archive'];
}

// A change of the budget or of the schedule that waits for the platform (the server allows one at a time of each kind).
export const budgetChangeWaiting = (changes: readonly AdsManageChangeView[]): boolean => changes.some((c) => c.state === 'queued' && c.kind.startsWith('budget_'));
export const scheduleChangeWaiting = (changes: readonly AdsManageChangeView[]): boolean => changes.some((c) => c.state === 'queued' && c.kind.startsWith('schedule_'));

// What a role is offered for a launch: `canManage` is the owner or admin role, `launchState` the launch's own state, `manage` what the server says it holds.
export function manageOffers(input: { canManage: boolean; launchState: string; manage: AdsManageStateView | undefined }): ManageOffers {
  const { manage } = input;
  if (!input.canManage || input.launchState !== 'live' || manage === undefined) return NONE;
  const objects: Record<string, ObjectOffer[]> = {};
  for (const object of manage.objects) objects[object.slot] = objectOffers(object, manage.canChange);
  const adSet = manage.objects.find((o) => o.slot === 'ad_set');
  const adSetOpen = manage.canChange && adSet !== undefined && adSet.status !== 'archived';
  const budgetWaiting = budgetChangeWaiting(manage.changes);
  const scheduleWaiting = scheduleChangeWaiting(manage.changes);
  return {
    controls: true,
    limited: !manage.canChange,
    lowerBudget: adSetOpen && !budgetWaiting,
    raiseBudget: adSetOpen && !budgetWaiting,
    shortenSchedule: adSetOpen && !scheduleWaiting,
    extendSchedule: adSetOpen && !scheduleWaiting,
    budgetWaiting: manage.canChange && budgetWaiting,
    scheduleWaiting: manage.canChange && scheduleWaiting,
    objects,
  };
}

// The raise or the extension of a change that is still waiting holds more against the caps than the platform confirmed: the screen says so.
export const heldBudgetHigher = (manage: Pick<AdsManageStateView, 'dailyBudget' | 'heldDailyBudget'>): boolean => toUnits(manage.heldDailyBudget) > toUnits(manage.dailyBudget);
export const heldEndLater = (manage: Pick<AdsManageStateView, 'endOn' | 'heldEndOn'>): boolean => manage.heldEndOn > manage.endOn;

// ---- Checks of what was typed ----

// The decimals of a currency's smallest unit (0 for the dong, 2 for the dollar), as the runtime's Intl knows them: the same rule as the server's.
export function currencyDecimals(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export type BudgetProblem = 'format' | 'decimals' | 'notLower' | 'notHigher';

// The daily budget as typed ("100.000", "100,000", "20,5") against the one the launch holds: the canonical decimal string to send, or what is wrong with it. A lower budget must
// be below the held one and a raise above it; the server checks the same, and the caps, again.
export function budgetInput(text: string, kind: 'budget_lower' | 'budget_raise', held: string, currency: string): { ok: true; value: string } | { ok: false; problem: BudgetProblem; decimals?: number } {
  const value = parseMoneyInput(text);
  if (value === null || !zAdsBudget.safeParse(value).success) return { ok: false, problem: 'format' };
  const places = currencyDecimals(currency);
  const fraction = value.split('.')[1] ?? '';
  if (fraction.length > places) return { ok: false, problem: 'decimals', decimals: places };
  const then = toUnits(value);
  const now = toUnits(held);
  if (kind === 'budget_lower' ? then >= now : then <= now) return { ok: false, problem: kind === 'budget_lower' ? 'notLower' : 'notHigher' };
  return { ok: true, value };
}

export type EndProblem = 'needed' | 'notEarlier' | 'notLater';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The new end date against the one the launch holds: a shorter schedule ends before it, a longer one after it. The server also checks it against today and the longest flight.
export function endInput(value: string, kind: 'schedule_shorten' | 'schedule_extend', heldEndOn: string): { ok: true; value: string } | { ok: false; problem: EndProblem } {
  if (!DAY.test(value)) return { ok: false, problem: 'needed' };
  if (kind === 'schedule_shorten' ? value >= heldEndOn : value <= heldEndOn) return { ok: false, problem: kind === 'schedule_shorten' ? 'notEarlier' : 'notLater' };
  return { ok: true, value };
}

// A day before or after an ISO day (for the bounds of the date fields).
export function shiftDay(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

// ---- Words ----

export function budgetProblemText(problem: BudgetProblem, t: Translate, args: { held: string; decimals?: number; currency: string }): string {
  switch (problem) {
    case 'format':
      return t('ads.manage.problem.budgetFormat');
    case 'decimals':
      return t('ads.manage.problem.budgetDecimals', { decimals: args.decimals ?? 0, currency: args.currency });
    case 'notLower':
      return t('ads.manage.problem.budgetNotLower', { amount: args.held });
    case 'notHigher':
      return t('ads.manage.problem.budgetNotHigher', { amount: args.held });
  }
}

export function endProblemText(problem: EndProblem, t: Translate, held: string): string {
  switch (problem) {
    case 'needed':
      return t('ads.manage.problem.dateNeeded');
    case 'notEarlier':
      return t('ads.manage.problem.endNotEarlier', { date: held });
    case 'notLater':
      return t('ads.manage.problem.endNotLater', { date: held });
  }
}

export function objectStatusText(status: AdsManageObjectView['status'], t: Translate): string {
  switch (status) {
    case 'active':
      return t('ads.manage.objectStatus.active');
    case 'paused':
      return t('ads.manage.objectStatus.paused');
    case 'archived':
      return t('ads.manage.objectStatus.archived');
  }
}

export function objectStatusVariant(status: AdsManageObjectView['status']): 'success' | 'warning' | 'outline' {
  return status === 'active' ? 'success' : status === 'paused' ? 'warning' : 'outline';
}

// The state of a change in words: waiting for the platform, done, did not go through, cancelled, or could not be confirmed (check at the platform).
export function changeStateText(state: AdsManageState, t: Translate): string {
  switch (state) {
    case 'queued':
      return t('ads.manage.state.queued');
    case 'applied':
      return t('ads.manage.state.applied');
    case 'failed':
      return t('ads.manage.state.failed');
    case 'cancelled':
      return t('ads.manage.state.cancelled');
    case 'unclear':
      return t('ads.manage.state.unclear');
  }
}

export function changeStateVariant(state: AdsManageState): 'success' | 'warning' | 'destructive' | 'outline' {
  switch (state) {
    case 'applied':
      return 'success';
    case 'queued':
    case 'unclear':
      return 'warning';
    case 'failed':
      return 'destructive';
    case 'cancelled':
      return 'outline';
  }
}

// What can add to the amount held against the caps: while one of these is unclear the amount stays held.
export const addsSpend = (kind: AdsManageKind): boolean => kind === 'resume' || kind === 'budget_raise' || kind === 'schedule_extend';

// Why a change did not go through or was cancelled, in words. The code is the platform's own or the server's class of failure; a value this build does not know is a general
// line with the value as plain text (the caller puts it in a text node, never in markup).
export function changeReasonText(code: string, t: Translate): string {
  switch (code) {
    case 'switch_off':
      return t('ads.manage.reason.switch_off');
    case 'account_off':
      return t('ads.manage.reason.account_off');
    case 'launches_blocked':
      return t('ads.manage.reason.launches_blocked');
    case 'connection_closed':
      return t('ads.manage.reason.connection_closed');
    case 'stopped':
      return t('ads.manage.reason.stopped');
    case 'token_expired':
      return t('ads.manage.reason.token_expired');
    case 'permission':
      return t('ads.manage.reason.permission');
    case 'bad_request':
      return t('ads.manage.reason.bad_request');
    case 'rate_limited':
      return t('ads.manage.reason.rate_limited');
    case 'transient':
      return t('ads.manage.reason.transient');
    case 'unknown':
      return t('ads.manage.reason.unknown');
    case 'step_failed':
      return t('ads.manage.reason.step_failed');
    case 'reconcile_unclear':
      return t('ads.manage.reason.reconcile_unclear');
    case 'CREDENTIAL_UNREADABLE':
      return t('ads.manage.reason.credential_unreadable');
    default:
      return t('ads.manage.reason.other', { code: code.slice(0, 64) });
  }
}

export interface ManageFormat {
  money: (amount: string, currency: string) => string;
  date: (day: string) => string;
}

// One change as a sentence: what was asked, from what to what.
export function changeSentence(change: AdsManageChangeView, objects: readonly AdsManageObjectView[], currency: string, t: Translate, fmt: ManageFormat): string {
  const name = objects.find((o) => o.slot === change.slot)?.name ?? '';
  switch (change.kind) {
    case 'pause':
      return t('ads.manage.change.pause', { name });
    case 'resume':
      return t('ads.manage.change.resume', { name });
    case 'archive':
      return t('ads.manage.change.archive', { name });
    case 'budget_lower':
    case 'budget_raise': {
      if (change.fromBudget === null || change.toBudget === null) return t(change.kind === 'budget_lower' ? 'ads.manage.change.budget_lower_plain' : 'ads.manage.change.budget_raise_plain');
      const amounts = { from: fmt.money(change.fromBudget, currency), to: fmt.money(change.toBudget, currency) };
      return t(change.kind === 'budget_lower' ? 'ads.manage.change.budget_lower' : 'ads.manage.change.budget_raise', amounts);
    }
    case 'schedule_shorten':
    case 'schedule_extend': {
      if (change.fromEndOn === null || change.toEndOn === null) return t(change.kind === 'schedule_shorten' ? 'ads.manage.change.schedule_shorten_plain' : 'ads.manage.change.schedule_extend_plain');
      const days = { from: fmt.date(change.fromEndOn), to: fmt.date(change.toEndOn) };
      return t(change.kind === 'schedule_shorten' ? 'ads.manage.change.schedule_shorten' : 'ads.manage.change.schedule_extend', days);
    }
  }
}

// What a refusal of the server says here, in words: the codes of managing a running ad. `undefined` for a code that is not one of these, which the caller words as any other
// error. ADS_SPEND_CAP carries the numbers of the cap it would pass (details.problems); a code without them gets the general line.
export function manageErrorText(error: unknown, t: Translate, fmt: ManageFormat, currency: string): string | undefined {
  const e = (error ?? {}) as { code?: unknown; data?: unknown };
  const data = (e.data ?? {}) as { problem?: unknown; problems?: unknown };
  const problem = typeof data.problem === 'string' ? data.problem : null;
  switch (e.code) {
    case 'ADS_WRITE_OFF':
      return t('ads.manage.error.ADS_WRITE_OFF');
    case 'ADS_LAUNCHES_BLOCKED':
      return t('ads.manage.error.ADS_LAUNCHES_BLOCKED');
    case 'ADS_CHANGE_OPEN':
      return t('ads.manage.error.ADS_CHANGE_OPEN');
    case 'ADS_CHANGE_UNCLEAR':
      return t('ads.manage.error.ADS_CHANGE_UNCLEAR');
    case 'ADS_MANAGE_NOT_LIVE':
      return t('ads.manage.error.ADS_MANAGE_NOT_LIVE');
    case 'ADS_FLIGHT_OVER':
      return t('ads.manage.error.ADS_FLIGHT_OVER');
    case 'ADS_ZONE_UNKNOWN':
      return t('ads.manage.error.ADS_ZONE_UNKNOWN');
    case 'ADS_REQUEST_OPEN':
      return t('ads.manage.error.ADS_REQUEST_OPEN');
    case 'ADS_OBJECT_STATE':
      return problem === 'archived' ? t('ads.manage.error.ADS_OBJECT_STATE_archived') : problem === 'already_paused' ? t('ads.manage.error.ADS_OBJECT_STATE_already_paused') : problem === 'not_paused' ? t('ads.manage.error.ADS_OBJECT_STATE_not_paused') : t('ads.manage.error.ADS_OBJECT_STATE');
    case 'ADS_BUDGET_INVALID':
      return problem === 'not_lower' ? t('ads.manage.error.ADS_BUDGET_INVALID_not_lower') : problem === 'not_higher' ? t('ads.manage.error.ADS_BUDGET_INVALID_not_higher') : t('ads.manage.error.ADS_BUDGET_INVALID');
    case 'ADS_SCHEDULE_INVALID':
      return problem === 'not_earlier'
        ? t('ads.manage.error.ADS_SCHEDULE_INVALID_not_earlier')
        : problem === 'not_later'
          ? t('ads.manage.error.ADS_SCHEDULE_INVALID_not_later')
          : problem === 'in_past'
            ? t('ads.manage.error.ADS_SCHEDULE_INVALID_in_past')
            : problem === 'flight_too_long'
              ? t('ads.manage.error.ADS_SCHEDULE_INVALID_flight_too_long')
              : t('ads.manage.error.ADS_SCHEDULE_INVALID');
    case 'ADS_CHANGE_BEGUN':
      return t('ads.manage.error.ADS_CHANGE_BEGUN');
    case 'ADS_CHANGE_SETTLED':
      return t('ads.manage.error.ADS_CHANGE_SETTLED');
    case 'ADS_SPEND_CAP': {
      const first = Array.isArray(data.problems) ? (data.problems[0] as Record<string, unknown> | undefined) : undefined;
      const text = (value: unknown): string | null => (typeof value === 'string' && /^\d{1,16}(\.\d{1,8})?$/.test(value) ? value : null);
      const cap = text(first?.cap);
      const committed = text(first?.committed);
      const plan = text(first?.plan);
      if (!first || cap === null || committed === null || plan === null) return t('ads.manage.error.ADS_SPEND_CAP');
      const daily = first.period === 'daily';
      const org = first.scope === 'org';
      return t('ads.manage.error.ADS_SPEND_CAP_numbers', {
        period: t(daily ? 'ads.manage.error.capDaily' : 'ads.manage.error.capMonthly'),
        scope: t(org ? 'ads.manage.error.capOrg' : 'ads.manage.error.capAccount'),
        cap: fmt.money(cap, currency),
        committed: fmt.money(committed, currency),
        plan: fmt.money(plan, currency),
      });
    }
    default:
      return undefined;
  }
}

// ---- The AI coworker's suggestion ----

// The request a suggestion stands for, to be sent only by the person's own click: a pause, or a lower budget. Never a raise (the contract has none); null for a lower budget that
// names no figure.
export function suggestionRequest(suggestion: Pick<AdsManageSuggestion, 'kind' | 'launchId' | 'slot' | 'toBudget'>): ManageRequest | null {
  if (suggestion.kind === 'pause') return { kind: 'pause', launchId: suggestion.launchId, slot: suggestion.slot };
  return suggestion.toBudget === null ? null : { kind: 'budget_lower', launchId: suggestion.launchId, dailyBudget: suggestion.toBudget };
}

// A decimal string without the zeros that only pad it ("2.40" is "2.4", "3.00" is "3"): a ratio or a count of results to read, never to compute with.
export function plainDecimal(value: string): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
}
