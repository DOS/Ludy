// SPDX-License-Identifier: AGPL-3.0-only
// The Ads screen's small rules (ADR-0040, plan docs/plan/ads.md): the periods it offers worked out on the wall clock of
// the ad account's own time zone, the comparison with the books as exact decimals, what the settings form changes, and
// the few facts it reads from an account. The server decides every rule; these only choose what to show and what to send.
// Money is a decimal string (AGENTS.md): the sums go through lib/decimal.ts, never through JS numbers.
import { ACCOUNT_CODE_PATTERN, ADS_BACKFILL_MONTHS, normalizeAccountCode, zonedDate, type AdAccountView } from '@crove/kernel-contract';
import { fromUnits, isZeroAmount, toUnits } from './decimal.ts';

// The periods of the range control, in the order the control lists them.
export const ADS_RANGES = ['thisMonth', 'lastMonth', 'last3Months', 'last13Months'] as const;
export type AdsRangeKind = (typeof ADS_RANGES)[number];
export const DEFAULT_ADS_RANGE: AdsRangeKind = 'thisMonth';

// ?account= is the ad account shown and ?range= the period; each is left out for its default (the first account, this month).
export interface AdsSearch {
  account?: string;
  range?: AdsRangeKind;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A param that fails its check is left out, so the screen falls back to its default instead of an error page (#1513).
export function parseAdsSearch(search: Record<string, unknown>): AdsSearch {
  const out: AdsSearch = {};
  if (typeof search.account === 'string' && ID.test(search.account)) out.account = search.account.toLowerCase();
  if (typeof search.range === 'string' && (ADS_RANGES as readonly string[]).includes(search.range)) out.range = search.range as AdsRangeKind;
  return out;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

// Today's date on the wall clock of the account's time zone, which is how the platform bounds its days. A zone the
// browser does not know, or none yet (before the first sync), reads the browser's own clock.
export function todayIn(timeZone: string | null, now: Date): string {
  if (timeZone) {
    try {
      return zonedDate(timeZone, now.getTime());
    } catch {
      // An unknown zone: fall through to the browser's clock.
    }
  }
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The first day of the month `back` months before the month of `day` (YYYY-MM-DD).
function monthStart(day: string, back: number): string {
  const [year, month] = day.split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) - back;
  return `${pad(Math.floor(index / 12), 4)}-${pad((index % 12) + 1)}-01`;
}

// The last day of the month of `day`.
function monthEnd(day: string): string {
  const [year, month] = day.split('-').map(Number) as [number, number];
  return `${pad(year, 4)}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
}

// The days a period covers, in the account's own time zone: this month so far, the whole month before, this month and the
// two before it so far, and the most the app keeps (13 months, this one included). The server takes at most
// ADS_SUMMARY_MAX_DAYS days; 13 calendar months never reach it.
export function adsRange(kind: AdsRangeKind, timeZone: string | null, now: Date): { from: string; to: string } {
  const today = todayIn(timeZone, now);
  switch (kind) {
    case 'thisMonth':
      return { from: monthStart(today, 0), to: today };
    case 'lastMonth': {
      const from = monthStart(today, 1);
      return { from, to: monthEnd(from) };
    }
    case 'last3Months':
      return { from: monthStart(today, 2), to: today };
    case 'last13Months':
      return { from: monthStart(today, ADS_BACKFILL_MONTHS - 1), to: today };
  }
}

// What the screen reads from an account to know what to show. The platform's currency and time zone arrive with the first
// sync; until then there are no figures, and the screen says so instead of showing numbers.
export const hasFigures = (account: Pick<AdAccountView, 'currency' | 'timeZone'>): boolean => account.currency !== null && account.timeZone !== null;
// Connected, never read, nothing failed: the first sync is on its way.
export const awaitsFirstSync = (account: Pick<AdAccountView, 'currency' | 'connectionStatus' | 'lastErrorKind'>): boolean =>
  account.currency === null && account.lastErrorKind === null && account.connectionStatus === 'active';

// A run that ended a moment ago may be followed by the next slice of a first backfill: the worker records an account's
// history slice by slice, each moving `lastRunAt`. So the screen keeps asking for a minute after each run it sees.
export const RECENT_RUN_MS = 60_000;
export const recentlyRan = (account: Pick<AdAccountView, 'lastRunAt'>, nowMs: number): boolean =>
  account.lastRunAt !== null && nowMs - Date.parse(account.lastRunAt) < RECENT_RUN_MS;

// How the screen asks again while a first sync is awaited or has just run (every few seconds, a couple of minutes at the
// most), and for how long after "Refresh now" (the worker answers within seconds, so the figures follow without a reload).
export const FIRST_SYNC_POLL_MS = 5_000;
export const FIRST_SYNC_POLL_LIMIT = 24;
export const REFRESH_POLL_MS = 3_000;
export const REFRESH_WATCH_MS = 45_000;

// The `sandbox_ads` platform makes up its figures, so the screen says so beside the account.
export const isSandboxProvider = (provider: string): boolean => provider === 'sandbox_ads';

// The result kinds the screen has its own words for; any other key is shown as the platform gives it.
export const NAMED_RESULT_KINDS = ['purchase', 'lead'] as const;
export type NamedResultKind = (typeof NAMED_RESULT_KINDS)[number];
export const isNamedResultKind = (kind: string): kind is NamedResultKind => (NAMED_RESULT_KINDS as readonly string[]).includes(kind);

// The result kinds a select offers: none, those the platform's adapter lists, and the one already chosen even when the
// adapter no longer lists it, so the select is never blank for a choice that was made.
export function resultKindChoices(resultKinds: readonly string[], current: string | null): string[] {
  return current !== null && !resultKinds.includes(current) ? [...resultKinds, current] : [...resultKinds];
}

// The expense account code as stored (trimmed, the tag in upper case), and whether it is a code the books accept. Empty
// is fine: it clears the setting.
export type ExpenseCodeProblem = 'format';
export function expenseCodeProblem(input: string): ExpenseCodeProblem | null {
  const code = normalizeAccountCode(input);
  return code === '' || ACCOUNT_CODE_PATTERN.test(code) ? null : 'format';
}

// What the settings form holds, each as typed: '' is "none" for the result kind and "clear" for the account code.
export interface AdsSettingsForm {
  resultKind: string;
  expenseAccountCode: string;
  legalEntityId: string;
}

export interface AdsConfigureChanges {
  resultKind?: string | null;
  expenseAccountCode?: string | null;
  legalEntityId?: string;
}

// Only what differs from the account, so a save that changes one setting leaves the others alone (and the audit row names
// only that); null when nothing differs. The legal entity is sent only where the org has several to choose between.
export function configureChanges(
  account: Pick<AdAccountView, 'resultKind' | 'expenseAccountCode' | 'legalEntityId'>,
  form: AdsSettingsForm,
  entityChoice: boolean,
): AdsConfigureChanges | null {
  const changes: AdsConfigureChanges = {};
  const resultKind = form.resultKind.trim() === '' ? null : form.resultKind.trim();
  if (resultKind !== account.resultKind) changes.resultKind = resultKind;
  const code = normalizeAccountCode(form.expenseAccountCode) === '' ? null : normalizeAccountCode(form.expenseAccountCode);
  if (code !== account.expenseAccountCode) changes.expenseAccountCode = code;
  if (entityChoice && form.legalEntityId !== '' && form.legalEntityId !== account.legalEntityId) changes.legalEntityId = form.legalEntityId;
  return Object.keys(changes).length === 0 ? null : changes;
}

// An idempotency key held across retries of one request: the same input keeps its key (a retry after a lost answer
// returns the first result), another input gets a fresh one, and a success clears it. Read and written from event
// handlers only, never while rendering.
export interface KeyHolder {
  signature: string;
  key: string;
}
export function keyFor(held: KeyHolder | null, signature: string, fresh: () => string = () => crypto.randomUUID()): KeyHolder {
  return held && held.signature === signature ? held : { signature, key: fresh() };
}

// The months of the range that have spend, the most the app keeps; each is a row of the books strip. A month with no
// spend has nothing to compare, and the platform's own zero would only invite a difference with the books.
export function booksMonths<T extends { month: string; spend: string }>(months: readonly T[]): T[] {
  return months.filter((m) => !isZeroAmount(m.spend)).slice(-ADS_BACKFILL_MONTHS);
}

// What the books hold for the advertising expense account in a month: its debits less its credits, as the ledger reports
// them (4 decimals). Exact: a decimal string in, a decimal string out.
export function booksExpense(ledger: { debit: string; credit: string }): string {
  return fromUnits(toUnits(ledger.debit) - toUnits(ledger.credit));
}

// The platform's spend less the books' expense: positive when the platform reports more than the books hold. Shown as it
// is, never explained away.
export function booksDifference(platformSpend: string, books: string): string {
  return fromUnits(toUnits(platformSpend) - toUnits(books));
}

// The kernel code an error carries (oRPC errors have a `code`), or null.
export const errorCode = (error: unknown): string | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};
