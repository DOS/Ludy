// SPDX-License-Identifier: AGPL-3.0-only
// The Ads screen's small rules (ADR-0040, #2217): the periods worked out on the ad account's own clock, the comparison
// with the books as exact decimals, what the settings form sends, the search params, and the words for what the server
// refuses and for how an update failed, in both languages.
import { ADS_ERROR_KINDS, ADS_SANDBOX_CURRENCIES, ADS_SUMMARY_MAX_DAYS, type AdAccountView } from '@crove/kernel-contract';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { translatorFor } from '../src/i18n/runtime.ts';
import {
  AD_OAUTH_PROVIDERS,
  ADS_RANGES,
  NAMED_RESULT_KINDS,
  adOAuthProviders,
  adProviderName,
  adsRange,
  awaitsFirstSync,
  booksDifference,
  booksExpense,
  booksMonths,
  configureChanges,
  errorCode,
  expenseCodeProblem,
  hasFigures,
  isAdOAuthProvider,
  isCalmRefusal,
  isNamedResultKind,
  isSandboxProvider,
  keyFor,
  parseAdsSearch,
  recentlyRan,
  resultKindChoices,
  syncHeld,
  todayIn,
  type AdsRangeKind,
} from '../src/lib/ads.ts';
import { ApiError, describeError } from '../src/lib/errors.ts';

const inVi = translatorFor('vi');
const inEn = translatorFor('en');

const account = (over: Partial<AdAccountView> = {}): AdAccountView => ({
  id: '0190c4a1-0000-7000-8000-000000000001',
  connectionId: '0190c4a1-0000-7000-8000-000000000002',
  connectionStatus: 'active',
  pausedSince: null,
  pausedReason: null,
  writeEnabled: false,
  extraScopes: [],
  provider: 'sandbox_ads',
  name: 'Quảng cáo cửa hàng',
  currency: 'VND',
  timeZone: 'Asia/Ho_Chi_Minh',
  legalEntityId: '0190c4a1-0000-7000-8000-000000000003',
  expenseAccountCode: null,
  resultKind: null,
  resultKinds: ['purchase', 'lead'],
  backfillFrom: '2025-10-01',
  settledThrough: null,
  syncedThrough: null,
  lastRunAt: null,
  lastErrorKind: null,
  nextRunAt: null,
  ...over,
});

describe('todayIn', () => {
  it('reads the wall clock of the account time zone, not the browser one', () => {
    // 20:30 UTC on 1 November 2026: already the 2nd in Vietnam (UTC+7), still the 1st in California and in UTC.
    const now = new Date('2026-11-01T20:30:00Z');
    expect(todayIn('Asia/Ho_Chi_Minh', now)).toBe('2026-11-02');
    expect(todayIn('America/Los_Angeles', now)).toBe('2026-11-01');
    expect(todayIn('UTC', now)).toBe('2026-11-01');
  });

  it('falls back to the browser clock before the first sync (no zone) and for a zone the browser does not know', () => {
    const now = new Date(2026, 10, 2, 12, 0, 0);
    expect(todayIn(null, now)).toBe('2026-11-02');
    expect(todayIn('Not/AZone', now)).toBe('2026-11-02');
  });
});

describe('adsRange', () => {
  const vn = (kind: AdsRangeKind, iso: string) => adsRange(kind, 'Asia/Ho_Chi_Minh', new Date(iso));

  it('this month runs from its first day to today, in the account time zone', () => {
    expect(vn('thisMonth', '2026-11-01T20:30:00Z')).toEqual({ from: '2026-11-01', to: '2026-11-02' });
    // 18:00 UTC on 31 October is 01:00 on 1 November in Vietnam: the month has already turned there, not in UTC.
    expect(vn('thisMonth', '2026-10-31T18:00:00Z')).toEqual({ from: '2026-11-01', to: '2026-11-01' });
    expect(adsRange('thisMonth', 'UTC', new Date('2026-10-31T18:00:00Z'))).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('last month is the whole month before, a leap February and a year end included', () => {
    expect(vn('lastMonth', '2026-03-15T05:00:00Z')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(vn('lastMonth', '2028-03-15T05:00:00Z')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(vn('lastMonth', '2026-01-10T05:00:00Z')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });

  it('the last 3 and 13 months are this month so far and the 2 and 12 months before it', () => {
    expect(vn('last3Months', '2026-11-02T05:00:00Z')).toEqual({ from: '2026-09-01', to: '2026-11-02' });
    expect(vn('last3Months', '2026-02-10T05:00:00Z')).toEqual({ from: '2025-12-01', to: '2026-02-10' });
    expect(vn('last13Months', '2026-11-02T05:00:00Z')).toEqual({ from: '2025-11-01', to: '2026-11-02' });
    expect(vn('last13Months', '2026-01-31T05:00:00Z')).toEqual({ from: '2025-01-01', to: '2026-01-31' });
  });

  it('never asks for more days than the server takes, whatever day it is', () => {
    const start = Date.parse('2027-12-01T00:00:00Z');
    for (let day = 0; day < 800; day++) {
      const now = new Date(start + day * 86_400_000 + 5 * 3_600_000);
      for (const kind of ADS_RANGES) {
        const { from, to } = vn(kind, now.toISOString());
        const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
        expect(span, `${kind} at ${now.toISOString()}`).toBeGreaterThanOrEqual(0);
        // The server refuses a span of ADS_SUMMARY_MAX_DAYS or more.
        expect(span, `${kind} at ${now.toISOString()}`).toBeLessThan(ADS_SUMMARY_MAX_DAYS);
      }
    }
  });
});

describe('the books comparison', () => {
  // A line of the account ledger as the books report it: the account's side, and the accounts on the other side.
  const line = (debit: string, credit: string, counterAccounts: string[], reversal = false) => ({ debit, credit, counterAccounts, reversal });

  it('works out what the books hold as the debits less the credits of the lines, exactly', () => {
    expect(booksExpense({ lines: [line('12000000.0000', '0.0000', ['331']), line('0.0000', '500000.0000', ['111'])] })).toBe('11500000');
    expect(booksExpense({ lines: [] })).toBe('0');
    expect(booksExpense({ lines: [line('0.0000', '0.0000', ['331'])] })).toBe('0');
    expect(booksExpense({ lines: [line('100.5000', '0.0000', ['331']), line('0.0000', '200.2500', ['111'])] })).toBe('-99.75');
  });

  it('leaves out the year closing in December: it credits the whole year against 911, which is not December spend', () => {
    // December's own spend is 3,000,000 and 1,000,000; the closing entry of 31 December credits the year's 40,000,000.
    const december = {
      lines: [line('3000000.0000', '0.0000', ['331']), line('1000000.0000', '0.0000', ['112']), line('0.0000', '40000000.0000', ['911'])],
    };
    // Counted with the closing line, the month would read as December less the year: -36,000,000.
    expect(booksExpense(december)).toBe('4000000');
    expect(booksExpense({ lines: [line('0.0000', '40000000.0000', ['911'])] })).toBe('0');
  });

  it('counts a line against other accounts, and a reversal that is not a closing', () => {
    // A credit against 331 or 111 is an ordinary correction: it stays.
    expect(booksExpense({ lines: [line('5000000.0000', '0.0000', ['331']), line('0.0000', '1200000.0000', ['331'])] })).toBe('3800000');
    // A reversal's credit (reversal: true, the original's accounts on the other side) stays too.
    expect(booksExpense({ lines: [line('2000000.0000', '0.0000', ['112']), line('0.0000', '2000000.0000', ['112'], true)] })).toBe('0');
    expect(booksExpense({ lines: [line('2500000.0000', '0.0000', ['112']), line('0.0000', '500000.0000', ['112', '1331'], true)] })).toBe('2000000');
    // An entry with 911 among several counter accounts is still the closing's.
    expect(booksExpense({ lines: [line('1000000.0000', '0.0000', ['331']), line('0.0000', '900000.0000', ['4212', '911'])] })).toBe('1000000');
  });

  it('shows the platform spend less the books, with no float error and no loss on large amounts', () => {
    expect(booksDifference('12000000', '11500000')).toBe('500000');
    expect(booksDifference('10000000', '10500000.5')).toBe('-500000.5');
    expect(booksDifference('0.1', '0.2')).toBe('-0.1');
    expect(booksDifference('500', '500')).toBe('0');
    // Past 2^53 a JS number is off by whole units; a decimal string is not.
    expect(booksDifference('9999999999999999', '1')).toBe('9999999999999998');
  });

  it('compares only the months that have spend, the last 13 at most', () => {
    expect(booksMonths([{ month: '2026-09', spend: '0' }, { month: '2026-10', spend: '0.00' }, { month: '2026-11', spend: '1500000' }])).toEqual([{ month: '2026-11', spend: '1500000' }]);
    const many = Array.from({ length: 15 }, (_, i) => ({ month: `${2025 + Math.floor((i + 9) / 12)}-${String(((i + 9) % 12) + 1).padStart(2, '0')}`, spend: '1' }));
    expect(booksMonths(many)).toHaveLength(13);
    expect(booksMonths(many)[12]).toEqual(many[14]);
  });
});

describe('the settings form', () => {
  const base = account({ legalEntityId: 'e1' });
  const same = { resultKind: '', expenseAccountCode: '', legalEntityId: 'e1' };

  it('sends nothing when nothing differs', () => {
    expect(configureChanges(base, same, true)).toBeNull();
    expect(configureChanges(account({ resultKind: 'lead', expenseAccountCode: '6421', legalEntityId: 'e1' }), { resultKind: 'lead', expenseAccountCode: ' 6421 ', legalEntityId: 'e1' }, true)).toBeNull();
  });

  it('sends only what changed, the account code as stored', () => {
    expect(configureChanges(base, { ...same, resultKind: 'purchase' }, false)).toEqual({ resultKind: 'purchase' });
    expect(configureChanges(base, { ...same, expenseAccountCode: ' 1121.vcb ' }, false)).toEqual({ expenseAccountCode: '1121.VCB' });
    expect(configureChanges(base, { resultKind: 'lead', expenseAccountCode: '6421', legalEntityId: 'e1' }, false)).toEqual({ resultKind: 'lead', expenseAccountCode: '6421' });
  });

  it('clears a setting with null, never with an empty string', () => {
    const set = account({ resultKind: 'lead', expenseAccountCode: '6421', legalEntityId: 'e1' });
    expect(configureChanges(set, same, false)).toEqual({ resultKind: null, expenseAccountCode: null });
  });

  it('sends the legal entity only where the org has several, and only when it moved', () => {
    expect(configureChanges(base, { ...same, legalEntityId: 'e2' }, false)).toBeNull();
    expect(configureChanges(base, { ...same, legalEntityId: 'e2' }, true)).toEqual({ legalEntityId: 'e2' });
  });

  it('accepts an account code as the books do, or an empty one', () => {
    for (const ok of ['', '  ', '6421', '64211', '6421.QC', '1121.vcb', ' 6421 ']) expect(expenseCodeProblem(ok), ok).toBeNull();
    for (const bad of ['64', '64a1', '6421.', '.QC', '12345678901', '6421 QC', '6421.Q-C']) expect(expenseCodeProblem(bad), bad).toBe('format');
  });

  it('offers the result kinds of the platform, and the chosen one even when the platform no longer lists it', () => {
    expect(resultKindChoices(['purchase', 'lead'], null)).toEqual(['purchase', 'lead']);
    expect(resultKindChoices(['purchase', 'lead'], 'lead')).toEqual(['purchase', 'lead']);
    expect(resultKindChoices(['purchase'], 'messaging_started')).toEqual(['purchase', 'messaging_started']);
    expect(resultKindChoices([], null)).toEqual([]);
  });

  it('has words of its own for the kinds the sandbox offers, and shows any other as the platform names it', () => {
    expect(NAMED_RESULT_KINDS.every(isNamedResultKind)).toBe(true);
    expect(isNamedResultKind('messaging_started')).toBe(false);
    for (const kind of NAMED_RESULT_KINDS) {
      expect(vi.ads.resultKinds[kind]).toBeTruthy();
      expect(en.ads.resultKinds[kind]).toBeTruthy();
    }
  });
});

describe('idempotency keys held across retries', () => {
  it('keeps the key of the same input, so a retry is the same request, and renews it for another input', () => {
    let n = 0;
    const fresh = () => `key-${++n}`;
    const first = keyFor(null, 'a', fresh);
    expect(first).toEqual({ signature: 'a', key: 'key-1' });
    expect(keyFor(first, 'a', fresh)).toBe(first);
    expect(keyFor(first, 'b', fresh)).toEqual({ signature: 'b', key: 'key-2' });
    // A success clears the holder: the next request starts fresh even with the same input.
    expect(keyFor(null, 'a', fresh)).toEqual({ signature: 'a', key: 'key-3' });
  });
});

describe('the address', () => {
  it('keeps a valid account and period, lower-cases the id, and drops anything else', () => {
    expect(parseAdsSearch({ account: '0190C4A1-0000-7000-8000-000000000001', range: 'last3Months' })).toEqual({ account: '0190c4a1-0000-7000-8000-000000000001', range: 'last3Months' });
    expect(parseAdsSearch({ account: 'not-an-id', range: 'forever' })).toEqual({});
    expect(parseAdsSearch({ account: 7, range: 3 })).toEqual({});
    expect(parseAdsSearch({})).toEqual({});
    for (const range of ADS_RANGES) expect(parseAdsSearch({ range })).toEqual({ range });
  });
});

describe('what an account says about its figures', () => {
  it('has figures once the platform has given its currency and time zone', () => {
    expect(hasFigures(account())).toBe(true);
    expect(hasFigures(account({ currency: null }))).toBe(false);
    expect(hasFigures(account({ timeZone: null }))).toBe(false);
  });

  it('awaits the first sync only while connected, never read, and nothing has failed', () => {
    expect(awaitsFirstSync(account({ currency: null }))).toBe(true);
    expect(awaitsFirstSync(account({ currency: null, lastErrorKind: 'transient' }))).toBe(false);
    expect(awaitsFirstSync(account({ currency: null, connectionStatus: 'expired' }))).toBe(false);
    expect(awaitsFirstSync(account())).toBe(false);
  });

  it('keeps asking for a minute after a run, since a first backfill lands slice by slice', () => {
    const now = Date.parse('2026-11-02T10:00:30Z');
    expect(recentlyRan(account({ lastRunAt: '2026-11-02T10:00:00Z' }), now)).toBe(true);
    expect(recentlyRan(account({ lastRunAt: '2026-11-02T09:58:00Z' }), now)).toBe(false);
    expect(recentlyRan(account({ lastRunAt: null }), now)).toBe(false);
  });

  it('holds the account back only while its next try is later than now', () => {
    const now = Date.parse('2026-11-02T10:00:00Z');
    expect(syncHeld(account({ nextRunAt: '2026-11-02T10:05:00Z' }), now)).toBe(true);
    expect(syncHeld(account({ nextRunAt: '2026-11-02T10:00:00Z' }), now)).toBe(false);
    expect(syncHeld(account({ nextRunAt: '2026-11-02T09:00:00Z' }), now)).toBe(false);
    expect(syncHeld(account({ nextRunAt: null }), now)).toBe(false);
  });

  it('says calmly the two refusals of a refresh that are not faults, and alarms for any other', () => {
    expect(isCalmRefusal(new ApiError('ADS_SYNC_TOO_SOON', 429, null))).toBe(true);
    expect(isCalmRefusal(new ApiError('ADS_SYNC_ON_HOLD', 429, null))).toBe(true);
    expect(isCalmRefusal(new ApiError('ADS_CONNECTION_INACTIVE', 422, null))).toBe(false);
    expect(isCalmRefusal(new ApiError('FORBIDDEN', 403, null))).toBe(false);
    expect(isCalmRefusal(null)).toBe(false);
  });

  it('marks the sandbox platform as making its figures up', () => {
    expect(isSandboxProvider('sandbox_ads')).toBe(true);
    expect(isSandboxProvider('meta_ads')).toBe(false);
  });

  it('knows the ad platforms connected through an OAuth dialog, and names them', () => {
    expect(AD_OAUTH_PROVIDERS).toEqual(['meta_ads']);
    expect(isAdOAuthProvider('meta_ads')).toBe(true);
    expect(isAdOAuthProvider('sandbox_ads')).toBe(false);
    expect(isAdOAuthProvider('facebook_page')).toBe(false);
    expect(adProviderName('meta_ads')).toBe('Meta');
    // An unknown platform is shown by its id.
    expect(adProviderName('google_ads')).toBe('google_ads');
  });

  it('offers an ad platform only where the deployment lists it among the OAuth providers', () => {
    expect(adOAuthProviders({ channels: { oauth: ['facebook_page', 'meta_ads'] } })).toEqual(['meta_ads']);
    // Social providers alone offer no ad platform.
    expect(adOAuthProviders({ channels: { oauth: ['facebook_page', 'instagram'] } })).toEqual([]);
    expect(adOAuthProviders({ channels: { oauth: [] } })).toEqual([]);
    // A config without the list, without channels, or none at all.
    expect(adOAuthProviders({ channels: {} })).toEqual([]);
    expect(adOAuthProviders({})).toEqual([]);
    expect(adOAuthProviders(null)).toEqual([]);
    expect(adOAuthProviders(undefined)).toEqual([]);
  });

  it('reads the code of an error, when it has one', () => {
    expect(errorCode(new ApiError('ADS_SYNC_TOO_SOON', 429, null))).toBe('ADS_SYNC_TOO_SOON');
    expect(errorCode(new Error('x'))).toBeNull();
    expect(errorCode(null)).toBeNull();
  });
});

describe('the words of the screen', () => {
  const CODES = ['ADS_ACCOUNT_NOT_FOUND', 'ADS_CONNECTION_NOT_FOUND', 'ADS_CONNECTION_INACTIVE', 'ADS_SYNC_TOO_SOON', 'ADS_SYNC_ON_HOLD', 'ADS_RANGE_INVALID', 'ADS_SANDBOX_DISABLED', 'ADS_ROWS_INVALID', 'ADS_CURRENCY_CHANGED'] as const;

  it('words every refusal of the ads module in both languages, the kernel Vietnamese when the reader reads Vietnamese', () => {
    for (const code of CODES) {
      const refusal = new ApiError(code, 422, 'Thông báo của máy chủ');
      expect(describeError(refusal, inVi, 'vi'), code).toBe('Thông báo của máy chủ');
      expect(describeError(refusal, inEn, 'en'), code).toBe(en.kernelErrors.codes[code]);
      expect(vi.kernelErrors.codes[code], `vi ${code}`).toBeTruthy();
    }
    expect(describeError(new ApiError('ADS_SYNC_TOO_SOON', 429, null), inEn, 'en')).toBe('This account was just refreshed; try again in about a minute.');
  });

  it('has a sentence for each way an update fails, a currency, a period and a connection state, in both languages', () => {
    for (const messages of [vi.ads, en.ads]) {
      for (const kind of ADS_ERROR_KINDS) expect(messages.errors[kind], kind).toBeTruthy();
      for (const currency of ADS_SANDBOX_CURRENCIES) expect(messages.currencies[currency], currency).toBeTruthy();
      for (const range of ADS_RANGES) expect(messages.ranges[range], range).toBeTruthy();
      for (const status of ['expired', 'revoked', 'error'] as const) {
        expect(messages.connection[status], status).toBeTruthy();
        expect(messages.connectionHint[status], status).toBeTruthy();
      }
    }
    expect(describeError(new ApiError('ADS_SYNC_ON_HOLD', 429, null), inEn, 'en')).toBe(
      'The platform is limiting how often this account is read; the system will try again when the limit ends.',
    );
  });

  it('tells, before a disconnect, that the stored figures stay and that the account can be connected again', () => {
    expect(vi.ads.settings.disconnectBody).toContain('Số liệu đã lưu vẫn được giữ để xem lại.');
    expect(en.ads.settings.disconnectBody).toContain('The stored figures are kept, to read.');
    expect(vi.ads.connectionHint.expired).toContain('Chủ sở hữu hoặc quản trị viên cần kết nối lại');
    expect(en.ads.connectionHint.expired).toContain('An owner or admin must connect the account again');
  });

  it('has the Meta connection words in both languages, with the same shape and the same arguments', () => {
    for (const messages of [vi.ads, en.ads]) {
      for (const text of [...Object.values(messages.connectMeta), ...Object.values(messages.oauth)]) expect(text).toBeTruthy();
    }
    expect(Object.keys(vi.ads.connectMeta).sort()).toEqual(Object.keys(en.ads.connectMeta).sort());
    expect(Object.keys(vi.ads.oauth).sort()).toEqual(Object.keys(en.ads.oauth).sort());
    expect(vi.ads.connectMeta.action).toBe('Kết nối tài khoản quảng cáo Meta');
    expect(en.ads.connectMeta.action).toBe('Connect a Meta ad account');
    expect(en.ads.connectMeta.another).toBe('Connect another Meta ad account');
    expect(vi.ads.oauth.backToAds).toBe('Về Quảng cáo');
    expect(en.ads.oauth.backToAds).toBe('Back to Ads');
    // They say it only reads, with the permission named, and that the connection lasts about 60 days.
    expect(en.ads.connectMeta.note).toContain('ads_read');
    expect(vi.ads.connectMeta.note).toContain('ads_read');
    expect(en.ads.connectMeta.expiry).toContain('60 days');
    expect(vi.ads.connectMeta.expiry).toContain('60 ngày');
    // The success text names the connected accounts in both languages.
    expect(vi.ads.oauth.connected).toContain('{list}');
    expect(en.ads.oauth.connected).toContain('{list}');
  });

  it('writes no tax or VAT figure and no em or en dash anywhere in the screen', () => {
    const text = JSON.stringify([vi.ads, en.ads]);
    expect(text).not.toMatch(new RegExp('[\\u2013\\u2014]'));
    expect(text).not.toMatch(/\bVAT\b|GTGT|thuế/i);
  });
});
