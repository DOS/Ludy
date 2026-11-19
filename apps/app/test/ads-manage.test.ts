// SPDX-License-Identifier: AGPL-3.0-only
// The pure rules of managing a running ad (ads W4, #3835): which controls each role is offered for each launch state, canChange and object status; what each control sends
// (the procedure and its input with the idempotency key); the checks of a typed budget and end date; and the words for the state of a change, why one did not go through and the
// refusals of the server, in both languages.
import { describe, expect, it, vi } from 'vitest';
import type { AdsManageChangeView, AdsManageObjectView, AdsManageStateView, AdsManageSuggestion } from '@crove/kernel-contract';
import { catalog, translatorFor } from '../src/i18n/runtime.ts';
import {
  budgetInput,
  changeReasonText,
  changeSentence,
  changeStateText,
  currencyDecimals,
  endInput,
  heldBudgetHigher,
  heldEndLater,
  manageCall,
  manageErrorText,
  manageOffers,
  needsApproval,
  objectOffers,
  plainDecimal,
  runManage,
  shiftDay,
  suggestionRequest,
  type ManageApi,
  type ManageRequest,
} from '../src/lib/ads-manage.ts';

const LAUNCH = '3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b';
const KEY = '00000000-0000-4000-8000-000000000001';
const money = (amount: string, currency: string) => `${amount} ${currency}`;
const date = (day: string) => `ngày ${day}`;
const fmt = { money, date };

const object = (slot: AdsManageObjectView['slot'], over: Partial<AdsManageObjectView> = {}): AdsManageObjectView => ({
  slot,
  level: slot === 'campaign' ? 'campaign' : slot === 'ad_set' ? 'ad_set' : 'ad',
  name: `Tên ${slot}`,
  status: 'active',
  pending: null,
  ...over,
});
const change = (over: Partial<AdsManageChangeView> = {}): AdsManageChangeView => ({
  id: 'c1',
  kind: 'pause',
  slot: 'campaign',
  state: 'queued',
  fromBudget: null,
  toBudget: null,
  fromEndOn: null,
  toEndOn: null,
  code: null,
  requestedAt: '2026-11-18T03:00:00.000Z',
  settledAt: null,
  ...over,
});
const manage = (over: Partial<AdsManageStateView> = {}): AdsManageStateView => ({
  launchId: LAUNCH,
  currency: 'VND',
  dailyBudget: '100000',
  endOn: '2026-11-30',
  heldDailyBudget: '100000',
  heldEndOn: '2026-11-30',
  canChange: true,
  objects: [object('campaign'), object('ad_set'), object('ad_1')],
  changes: [],
  ...over,
});

describe('which controls are offered', () => {
  it('offers a member and anyone who is not an owner or an admin nothing: the state only', () => {
    const offers = manageOffers({ canManage: false, launchState: 'live', manage: manage() });
    expect(offers.controls).toBe(false);
    expect(offers.lowerBudget || offers.raiseBudget || offers.shortenSchedule || offers.extendSchedule).toBe(false);
    expect(offers.objects).toEqual({});
  });

  it('offers nothing for a launch that is not live, or that has no management state yet', () => {
    for (const launchState of ['queued', 'launching', 'needs_attention', 'stopped', 'failed', 'cancelled']) {
      expect(manageOffers({ canManage: true, launchState, manage: manage() }).controls, launchState).toBe(false);
    }
    expect(manageOffers({ canManage: true, launchState: 'live', manage: undefined }).controls).toBe(false);
  });

  it('offers an owner or an admin everything on a live launch that can change: pause and archive a running object, resume and archive a paused one, the four forms', () => {
    const offers = manageOffers({
      canManage: true,
      launchState: 'live',
      manage: manage({ objects: [object('campaign'), object('ad_set', { status: 'paused' }), object('ad_1', { status: 'archived' }), object('ad_2', { pending: 'pause' })] }),
    });
    expect(offers.controls).toBe(true);
    expect(offers.limited).toBe(false);
    expect(offers.objects).toEqual({ campaign: ['pause', 'archive'], ad_set: ['resume', 'archive'], ad_1: [], ad_2: [] });
    expect([offers.lowerBudget, offers.raiseBudget, offers.shortenSchedule, offers.extendSchedule]).toEqual([true, true, true, true]);
  });

  it('offers only Pause when the controls cannot change (running ads off, account not enabled, launches blocked), and says it is limited', () => {
    const offers = manageOffers({
      canManage: true,
      launchState: 'live',
      manage: manage({ canChange: false, objects: [object('campaign'), object('ad_set', { status: 'paused' }), object('ad_1')] }),
    });
    expect(offers.controls).toBe(true);
    expect(offers.limited).toBe(true);
    expect(offers.objects).toEqual({ campaign: ['pause'], ad_set: [], ad_1: ['pause'] });
    expect([offers.lowerBudget, offers.raiseBudget, offers.shortenSchedule, offers.extendSchedule]).toEqual([false, false, false, false]);
  });

  it('holds a budget or a schedule form back while a change of its own kind waits for the platform, and only that kind', () => {
    const waiting = (kind: AdsManageChangeView['kind']) => manageOffers({ canManage: true, launchState: 'live', manage: manage({ changes: [change({ kind, slot: 'ad_set', state: 'queued' })] }) });
    const budget = waiting('budget_raise');
    expect([budget.lowerBudget, budget.raiseBudget, budget.budgetWaiting]).toEqual([false, false, true]);
    expect([budget.shortenSchedule, budget.extendSchedule, budget.scheduleWaiting]).toEqual([true, true, false]);
    const schedule = waiting('schedule_shorten');
    expect([schedule.shortenSchedule, schedule.extendSchedule, schedule.scheduleWaiting]).toEqual([false, false, true]);
    expect([schedule.lowerBudget, schedule.raiseBudget]).toEqual([true, true]);
    // A settled change holds nothing back.
    const settled = manageOffers({ canManage: true, launchState: 'live', manage: manage({ changes: [change({ kind: 'budget_lower', state: 'applied' }), change({ id: 'c2', kind: 'schedule_extend', state: 'unclear' })] }) });
    expect([settled.lowerBudget, settled.shortenSchedule]).toEqual([true, true]);
  });

  it('offers no budget or schedule once the ad set is archived', () => {
    const offers = manageOffers({ canManage: true, launchState: 'live', manage: manage({ objects: [object('campaign'), object('ad_set', { status: 'archived' })] }) });
    expect([offers.lowerBudget, offers.raiseBudget, offers.shortenSchedule, offers.extendSchedule]).toEqual([false, false, false, false]);
  });

  it('offers one object nothing while its own change waits, and nothing once it is archived', () => {
    expect(objectOffers({ status: 'active', pending: 'pause' }, true)).toEqual([]);
    expect(objectOffers({ status: 'archived', pending: null }, true)).toEqual([]);
    expect(objectOffers({ status: 'active', pending: null }, true)).toEqual(['pause', 'archive']);
    expect(objectOffers({ status: 'paused', pending: null }, true)).toEqual(['resume', 'archive']);
    expect(objectOffers({ status: 'paused', pending: null }, false)).toEqual([]);
  });

  it('knows when the platform has not confirmed a raise or an extension (what is held is above what is confirmed)', () => {
    expect(heldBudgetHigher(manage())).toBe(false);
    expect(heldBudgetHigher(manage({ heldDailyBudget: '150000' }))).toBe(true);
    expect(heldBudgetHigher(manage({ dailyBudget: '100000.50', heldDailyBudget: '100000.5' }))).toBe(false);
    expect(heldEndLater(manage())).toBe(false);
    expect(heldEndLater(manage({ heldEndOn: '2026-12-05' }))).toBe(true);
  });
});

describe('what each control sends', () => {
  const calls: Array<[ManageRequest, string, unknown]> = [
    [{ kind: 'pause', launchId: LAUNCH, slot: 'campaign' }, 'pauseObject', { launchId: LAUNCH, slot: 'campaign', idempotencyKey: KEY }],
    [{ kind: 'archive', launchId: LAUNCH, slot: 'ad_1' }, 'archiveObject', { launchId: LAUNCH, slot: 'ad_1', idempotencyKey: KEY }],
    [{ kind: 'budget_lower', launchId: LAUNCH, dailyBudget: '80000' }, 'lowerBudget', { launchId: LAUNCH, dailyBudget: '80000', idempotencyKey: KEY }],
    [{ kind: 'schedule_shorten', launchId: LAUNCH, endOn: '2026-11-25' }, 'shortenSchedule', { launchId: LAUNCH, endOn: '2026-11-25', idempotencyKey: KEY }],
    [{ kind: 'cancel', changeId: 'c1' }, 'cancelChange', { changeId: 'c1', idempotencyKey: KEY }],
    [{ kind: 'resume', launchId: LAUNCH, slot: 'ad_set' }, 'requestChange', { change: 'object_resume', launchId: LAUNCH, slot: 'ad_set', idempotencyKey: KEY }],
    [{ kind: 'budget_raise', launchId: LAUNCH, dailyBudget: '150000' }, 'requestChange', { change: 'budget_raise', launchId: LAUNCH, dailyBudget: '150000', idempotencyKey: KEY }],
    [{ kind: 'schedule_extend', launchId: LAUNCH, endOn: '2026-12-10' }, 'requestChange', { change: 'schedule_extend', launchId: LAUNCH, endOn: '2026-12-10', idempotencyKey: KEY }],
  ];

  it.each(calls)('%j goes to ads.%s with the idempotency key', (request, procedure, input) => {
    expect(manageCall(request, KEY)).toEqual({ procedure, input });
  });

  it('makes a request for approval of a resume, a raise and an extension only, never of a pause, an archive, a lower budget or a shorter schedule', () => {
    expect(calls.filter(([request]) => needsApproval(request)).map(([request]) => request.kind)).toEqual(['resume', 'budget_raise', 'schedule_extend']);
  });

  it('runs each request on its own procedure alone and answers the proposal of a request for approval', async () => {
    const seen: string[] = [];
    const answer = (name: string) => (input: unknown) => {
      seen.push(`${name}:${JSON.stringify(input)}`);
      return Promise.resolve({ proposalId: 'p1' });
    };
    const api: ManageApi = {
      pauseObject: answer('pauseObject'),
      archiveObject: answer('archiveObject'),
      lowerBudget: answer('lowerBudget'),
      shortenSchedule: answer('shortenSchedule'),
      cancelChange: answer('cancelChange'),
      requestChange: answer('requestChange'),
    };
    for (const [request] of calls) await runManage(api, request, KEY);
    expect(seen.map((s) => s.split(':')[0])).toEqual(['pauseObject', 'archiveObject', 'lowerBudget', 'shortenSchedule', 'cancelChange', 'requestChange', 'requestChange', 'requestChange']);
    const resume = await runManage(api, { kind: 'resume', launchId: LAUNCH, slot: 'ad_set' }, KEY);
    expect(resume.proposalId).toBe('p1');
    // A change that applies on its own makes no proposal, whatever the procedure answered.
    expect((await runManage(api, { kind: 'pause', launchId: LAUNCH, slot: 'campaign' }, KEY)).proposalId).toBeNull();
  });

  it('never calls the platform-facing procedures for a request it does not know: a raise only ever goes through requestChange', async () => {
    const api: ManageApi = {
      pauseObject: vi.fn(),
      archiveObject: vi.fn(),
      lowerBudget: vi.fn(),
      shortenSchedule: vi.fn(),
      cancelChange: vi.fn(),
      requestChange: vi.fn().mockResolvedValue({ proposalId: 'p2' }),
    };
    await runManage(api, { kind: 'budget_raise', launchId: LAUNCH, dailyBudget: '150000' }, KEY);
    expect(api.lowerBudget).not.toHaveBeenCalled();
    expect(api.requestChange).toHaveBeenCalledTimes(1);
  });
});

describe('the checks of what was typed', () => {
  it('knows the decimals of a currency: none for the dong, two for the dollar', () => {
    expect(currencyDecimals('VND')).toBe(0);
    expect(currencyDecimals('USD')).toBe(2);
  });

  it('reads a budget the way people type money, to the canonical decimal string', () => {
    expect(budgetInput('80.000', 'budget_lower', '100000', 'VND')).toEqual({ ok: true, value: '80000' });
    expect(budgetInput('80,000', 'budget_lower', '100000', 'VND')).toEqual({ ok: true, value: '80000' });
    expect(budgetInput('150000', 'budget_raise', '100000', 'VND')).toEqual({ ok: true, value: '150000' });
    expect(budgetInput('19,5', 'budget_lower', '20', 'USD')).toEqual({ ok: true, value: '19.5' });
  });

  it('refuses what is not an amount above zero', () => {
    for (const text of ['', 'abc', '0', '0.00', '-5', '1e5', '12.345.6']) expect(budgetInput(text, 'budget_lower', '100000', 'VND'), text).toEqual({ ok: false, problem: 'format' });
  });

  it('refuses more decimals than the currency has', () => {
    expect(budgetInput('80000.5', 'budget_lower', '100000', 'VND')).toEqual({ ok: false, problem: 'decimals', decimals: 0 });
    // "19.555" is nineteen thousand five hundred fifty-five in the Vietnamese grouping; a third decimal cannot be typed at all.
    expect(budgetInput('19.5551', 'budget_lower', '20', 'USD')).toEqual({ ok: false, problem: 'format' });
    expect(budgetInput('19.5', 'budget_lower', '20', 'USD').ok).toBe(true);
  });

  it('compares exactly with the budget held: a lower budget must be below it and a raise above it, never equal', () => {
    expect(budgetInput('100000', 'budget_lower', '100000', 'VND')).toEqual({ ok: false, problem: 'notLower' });
    expect(budgetInput('100001', 'budget_lower', '100000', 'VND')).toEqual({ ok: false, problem: 'notLower' });
    expect(budgetInput('100000', 'budget_raise', '100000', 'VND')).toEqual({ ok: false, problem: 'notHigher' });
    expect(budgetInput('99999', 'budget_raise', '100000', 'VND')).toEqual({ ok: false, problem: 'notHigher' });
    // A cent apart is still apart (no float rounding).
    expect(budgetInput('20.01', 'budget_raise', '20.00', 'USD')).toEqual({ ok: true, value: '20.01' });
    expect(budgetInput('19.99', 'budget_lower', '20.00', 'USD')).toEqual({ ok: true, value: '19.99' });
    expect(budgetInput('9999999999999', 'budget_raise', '9999999999998', 'VND')).toEqual({ ok: true, value: '9999999999999' });
    expect(budgetInput('99999999999999', 'budget_raise', '9999999999998', 'VND')).toEqual({ ok: false, problem: 'format' });
  });

  it('checks an end date against the one held: a shorter schedule ends before it, a longer one after it', () => {
    expect(endInput('', 'schedule_shorten', '2026-11-30')).toEqual({ ok: false, problem: 'needed' });
    expect(endInput('2026-11-25', 'schedule_shorten', '2026-11-30')).toEqual({ ok: true, value: '2026-11-25' });
    expect(endInput('2026-11-30', 'schedule_shorten', '2026-11-30')).toEqual({ ok: false, problem: 'notEarlier' });
    expect(endInput('2026-12-01', 'schedule_shorten', '2026-11-30')).toEqual({ ok: false, problem: 'notEarlier' });
    expect(endInput('2026-12-10', 'schedule_extend', '2026-11-30')).toEqual({ ok: true, value: '2026-12-10' });
    expect(endInput('2026-11-30', 'schedule_extend', '2026-11-30')).toEqual({ ok: false, problem: 'notLater' });
    expect(endInput('2026-11-01', 'schedule_extend', '2026-11-30')).toEqual({ ok: false, problem: 'notLater' });
  });

  it('shifts a day across a month and a year end', () => {
    expect(shiftDay('2026-12-01', -1)).toBe('2026-11-30');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('the words', () => {
  it('says each state of a change in both languages, and "could not confirm, check at the platform" for an unclear one', () => {
    const en = translatorFor('en');
    const vi = translatorFor('vi');
    expect(changeStateText('queued', en)).toBe('Waiting for the platform');
    expect(changeStateText('applied', en)).toBe('Done');
    expect(changeStateText('failed', en)).toBe('Did not go through');
    expect(changeStateText('cancelled', en)).toBe('Cancelled');
    expect(changeStateText('unclear', en)).toBe('Could not confirm, check at the platform');
    expect(changeStateText('queued', vi)).toBe('Đang chờ nền tảng');
    expect(changeStateText('unclear', vi)).toBe('Chưa xác nhận được, hãy kiểm tra trên nền tảng');
    expect(changeStateText('failed', vi)).toBe('Không thực hiện được');
  });

  it('words the code of a failed change, and falls back to a general line that shows an unknown value as plain text', () => {
    const en = translatorFor('en');
    expect(changeReasonText('token_expired', en)).toContain('reconnect it on the Ads screen');
    expect(changeReasonText('launches_blocked', en)).toBe('launches were blocked');
    expect(changeReasonText('reconcile_unclear', en)).toContain('could not confirm');
    const odd = '<img src=x onerror=alert(1)>';
    expect(changeReasonText(odd, en)).toBe(`the change did not go through (code ${odd})`);
    expect(changeReasonText(odd, translatorFor('vi'))).toBe(`thay đổi không thực hiện được (mã ${odd})`);
    // A long code is cut, so a hostile one cannot fill the screen.
    expect(changeReasonText('X'.repeat(300), en).length).toBeLessThan(120);
  });

  it('words each kind of change as a sentence with its amounts and dates', () => {
    const en = translatorFor('en');
    const objects = [object('campaign', { name: 'Khai trương' }), object('ad_set', { name: 'Nhóm 1' })];
    expect(changeSentence(change({ kind: 'pause', slot: 'campaign' }), objects, 'VND', en, fmt)).toBe('Pause Khai trương');
    expect(changeSentence(change({ kind: 'archive', slot: 'ad_set' }), objects, 'VND', en, fmt)).toBe('Archive Nhóm 1');
    expect(changeSentence(change({ kind: 'resume', slot: 'ad_set' }), objects, 'VND', en, fmt)).toBe('Resume Nhóm 1');
    expect(changeSentence(change({ kind: 'budget_lower', slot: 'ad_set', fromBudget: '100000', toBudget: '80000' }), objects, 'VND', en, fmt)).toBe('Lower the daily budget from 100000 VND to 80000 VND');
    expect(changeSentence(change({ kind: 'budget_raise', slot: 'ad_set', fromBudget: '100000', toBudget: '150000' }), objects, 'VND', en, fmt)).toBe('Raise the daily budget from 100000 VND to 150000 VND');
    expect(changeSentence(change({ kind: 'schedule_shorten', slot: 'ad_set', fromEndOn: '2026-11-30', toEndOn: '2026-11-25' }), objects, 'VND', en, fmt)).toBe('End on ngày 2026-11-25 instead of ngày 2026-11-30');
    expect(changeSentence(change({ kind: 'schedule_extend', slot: 'ad_set', fromEndOn: '2026-11-30', toEndOn: '2026-12-10' }), objects, 'VND', en, fmt)).toBe('Extend the end date from ngày 2026-11-30 to ngày 2026-12-10');
    // Without the figures the sentence says only what kind of change it was.
    expect(changeSentence(change({ kind: 'budget_raise', slot: 'ad_set' }), objects, 'VND', en, fmt)).toBe('Raise the daily budget');
    expect(changeSentence(change({ kind: 'pause', slot: 'campaign' }), objects, 'VND', translatorFor('vi'), fmt)).toBe('Tạm dừng Khai trương');
  });

  it('words the refusals of managing a running ad in both languages, with the problem when the server names one', () => {
    for (const locale of ['en', 'vi'] as const) {
      const t = translatorFor(locale);
      for (const code of ['ADS_WRITE_OFF', 'ADS_LAUNCHES_BLOCKED', 'ADS_CHANGE_OPEN', 'ADS_MANAGE_NOT_LIVE', 'ADS_FLIGHT_OVER', 'ADS_ZONE_UNKNOWN', 'ADS_REQUEST_OPEN', 'ADS_OBJECT_STATE', 'ADS_BUDGET_INVALID', 'ADS_SCHEDULE_INVALID', 'ADS_CHANGE_BEGUN', 'ADS_CHANGE_SETTLED', 'ADS_SPEND_CAP']) {
        expect(manageErrorText({ code }, t, fmt, 'VND'), `${locale} ${code}`).toBeTruthy();
      }
    }
    const en = translatorFor('en');
    expect(manageErrorText({ code: 'ADS_BUDGET_INVALID', data: { problem: 'not_lower' } }, en, fmt, 'VND')).toContain('must be below');
    expect(manageErrorText({ code: 'ADS_BUDGET_INVALID', data: { problem: 'not_higher' } }, en, fmt, 'VND')).toContain('must be above');
    expect(manageErrorText({ code: 'ADS_SCHEDULE_INVALID', data: { problem: 'flight_too_long' } }, en, fmt, 'VND')).toContain('90 days');
    expect(manageErrorText({ code: 'ADS_OBJECT_STATE', data: { problem: 'archived' } }, en, fmt, 'VND')).toContain('archived');
    expect(manageErrorText({ code: 'ADS_OBJECT_STATE', data: { problem: 'not_paused' } }, en, fmt, 'VND')).toContain('Only a paused ad');
    expect(manageErrorText({ code: 'ADS_WRITE_OFF' }, en, fmt, 'VND')).toContain('only Pause is available');
  });

  it('puts the numbers of a spend cap into its refusal, and ignores numbers that are not decimals', () => {
    const problems = [{ code: 'daily_cap_exceeded', scope: 'org', period: 'daily', cap: '500000', committed: '450000', plan: '100000', day: '2026-11-20' }];
    const en = manageErrorText({ code: 'ADS_SPEND_CAP', data: { problems } }, translatorFor('en'), fmt, 'VND');
    expect(en).toBe('This change, together with the other campaigns, would pass the daily spend cap of the whole org: the cap is 500000 VND, 450000 VND is already held and this launch would add 100000 VND.');
    const vi = manageErrorText({ code: 'ADS_SPEND_CAP', data: { problems: [{ ...problems[0], scope: 'account', period: 'monthly' }] } }, translatorFor('vi'), fmt, 'VND');
    expect(vi).toContain('hạn mức chi tiêu theo tháng của tài khoản quảng cáo này');
    expect(vi).toContain('500000 VND');
    const hostile = manageErrorText({ code: 'ADS_SPEND_CAP', data: { problems: [{ ...problems[0], cap: '<b>1</b>' }] } }, translatorFor('en'), fmt, 'VND');
    expect(hostile).toBe(catalog('en').ads.manage.error.ADS_SPEND_CAP);
    expect(manageErrorText({ code: 'ADS_SPEND_CAP' }, translatorFor('en'), fmt, 'VND')).toBe(catalog('en').ads.manage.error.ADS_SPEND_CAP);
  });

  it('leaves a code that is not one of these to the general wording', () => {
    expect(manageErrorText({ code: 'FORBIDDEN' }, translatorFor('en'), fmt, 'VND')).toBeUndefined();
    expect(manageErrorText(new Error('x'), translatorFor('en'), fmt, 'VND')).toBeUndefined();
    expect(manageErrorText(null, translatorFor('en'), fmt, 'VND')).toBeUndefined();
  });

  it('keeps the Vietnamese and the English catalogs of the section in step', () => {
    const keys = (value: unknown, prefix = ''): string[] =>
      Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (typeof v === 'string' ? [`${prefix}${k}`] : keys(v, `${prefix}${k}.`)));
    expect(keys(catalog('vi').ads.manage).sort()).toEqual(keys(catalog('en').ads.manage).sort());
    const textOf = (key: string) => key.split('.').reduce((o: unknown, part) => (o as Record<string, unknown>)[part], catalog('en').ads.manage) as string;
    for (const key of keys(catalog('en').ads.manage)) expect(textOf(key)).not.toMatch(/\u2014/);
  });
});

describe('the suggestion of the AI coworker', () => {
  const suggestion = (over: Partial<AdsManageSuggestion> = {}): AdsManageSuggestion => ({
    launchId: LAUNCH,
    adAccountId: 'a1',
    campaignName: 'Khai trương',
    kind: 'pause',
    slot: 'campaign',
    toBudget: null,
    currency: 'VND',
    recentCost: '90000',
    medianCost: '30000',
    ratio: '3.00',
    recentResults: '12',
    day: '2026-11-18',
    ...over,
  });

  it('is a pause of the campaign or a lower budget with its own figure, and nothing else', () => {
    expect(suggestionRequest(suggestion())).toEqual({ kind: 'pause', launchId: LAUNCH, slot: 'campaign' });
    expect(suggestionRequest(suggestion({ kind: 'budget_lower', toBudget: '70000' }))).toEqual({ kind: 'budget_lower', launchId: LAUNCH, dailyBudget: '70000' });
    // A lower budget with no figure has nothing to apply.
    expect(suggestionRequest(suggestion({ kind: 'budget_lower', toBudget: null }))).toBeNull();
  });

  it('is never a raise, and never a request for approval: it goes through the person\'s own pause or lower-budget command', () => {
    for (const s of [suggestion(), suggestion({ kind: 'budget_lower', toBudget: '70000' })]) {
      const request = suggestionRequest(s);
      expect(request).not.toBeNull();
      expect(['pause', 'budget_lower']).toContain(request?.kind);
      expect(needsApproval(request as ManageRequest)).toBe(false);
    }
  });

  it('trims the zeros that only pad a decimal, for reading', () => {
    expect(plainDecimal('3.00')).toBe('3');
    expect(plainDecimal('2.40')).toBe('2.4');
    expect(plainDecimal('12')).toBe('12');
    expect(plainDecimal('100')).toBe('100');
    expect(plainDecimal('0.05')).toBe('0.05');
  });
});
