// SPDX-License-Identifier: AGPL-3.0-only
// The campaign builder's small rules (W1c, #2295): the address params, the form a draft is edited in and its way back to the plan, the format problems found
// before a save, the largest amount a plan can spend (exact), what a Social post pre-fills, which fields still count as drafted by the AI coworker, and the
// words for every finding of local validation and every refusal of the AI coworker, in both languages.
import { describe, expect, it } from 'vitest';
import type { AdsCampaignPlanDraft, AdsPlanIssue } from '@crove/kernel-contract';
import { translatorFor } from '../src/i18n/runtime.ts';
import {
  cutAt,
  draftedFields,
  emptyForm,
  flightDays,
  formFromPost,
  formProblems,
  formToPlan,
  isDirty,
  issueText,
  maxSpendOf,
  parseCampaignsSearch,
  parseInterests,
  planToForm,
  refusalText,
  startFromPost,
} from '../src/lib/ads-campaigns.ts';

const ID = '3f2b8c1e-4d5a-4e6f-8a9b-0c1d2e3f4a5b';

const plan = (over: Partial<AdsCampaignPlanDraft> = {}): AdsCampaignPlanDraft => ({
  name: 'Khai trương chi nhánh',
  objective: 'traffic',
  dailyBudget: '100000',
  startOn: '2026-11-10',
  endOn: '2026-11-16',
  targeting: { locations: [{ country: 'VN', region: 'Hà Nội' }], ageMin: 22, ageMax: 45, gender: 'all', interests: ['cà phê', 'ẩm thực'] },
  linkUrl: 'https://example.com/khai-truong',
  pageConnectionId: null,
  sourcePostId: null,
  mediaFileId: null,
  variants: [{ headline: 'Khai trương', primaryText: 'Mời bạn ghé thử.', callToAction: 'learn_more' }],
  ...over,
});

describe('parseCampaignsSearch', () => {
  it('keeps a draft and an account id, lower-cased, and drops anything else', () => {
    expect(parseCampaignsSearch({ draft: ID.toUpperCase(), account: ID })).toEqual({ draft: ID, account: ID });
    expect(parseCampaignsSearch({ draft: 'nope', account: 5, other: 'x' })).toEqual({});
  });
});

describe('the form and its plan', () => {
  it('turns a plan into a form and back to the same plan', () => {
    const p = plan({ sourcePostId: ID });
    expect(formToPlan(planToForm(p))).toEqual(p);
  });

  it('leaves a text with nothing typed out, and the audience whole or null', () => {
    const form = { ...emptyForm('messenger'), name: 'Tin nhắn' };
    const out = formToPlan(form);
    expect(out.variants).toEqual([]);
    expect(out.dailyBudget).toBeNull();
    expect(out.targeting).toMatchObject({ locations: [{ country: 'VN' }], ageMin: 18, ageMax: 65, gender: 'all', interests: [] });
    expect(formToPlan({ ...form, ageMin: '' }).targeting).toBeNull();
  });

  it('starts a Messenger form on the Send message button and the others on their own', () => {
    expect(emptyForm('messenger').variants[0]?.callToAction).toBe('send_message');
    expect(emptyForm('engagement').variants[0]?.callToAction).toBe('no_button');
    expect(emptyForm('traffic').variants[0]?.callToAction).toBe('learn_more');
  });

  it('is dirty only when the form differs from the plan it came from', () => {
    const p = plan();
    const form = planToForm(p);
    expect(isDirty(form, p)).toBe(false);
    expect(isDirty({ ...form, name: 'Tên khác' }, p)).toBe(true);
    expect(isDirty({ ...form, name: `  ${form.name}  ` }, p)).toBe(false);
  });

  it('splits interests on commas and new lines and keeps a repeat for the server to warn about', () => {
    expect(parseInterests(' cà phê, ẩm thực\n du lịch ,, cà phê ')).toEqual(['cà phê', 'ẩm thực', 'du lịch', 'cà phê']);
  });
});

describe('formProblems', () => {
  it('finds nothing in a complete form and each format problem under its field', () => {
    expect(formProblems(planToForm(plan()))).toEqual({});
    const form = planToForm(plan());
    expect(formProblems({ ...form, name: ' ' }).name).toBe('nameNeeded');
    expect(formProblems({ ...form, dailyBudget: '0' }).dailyBudget).toBe('budgetFormat');
    expect(formProblems({ ...form, dailyBudget: '10.123' }).dailyBudget).toBe('budgetFormat');
    expect(formProblems({ ...form, dailyBudget: '' }).dailyBudget).toBeUndefined();
    expect(formProblems({ ...form, locations: [{ country: 'Vietnam', region: '' }] }).locations).toBe('countryFormat');
    expect(formProblems({ ...form, ageMin: '17' }).age).toBe('ageFormat');
    expect(formProblems({ ...form, ageMax: '66' }).age).toBe('ageFormat');
    expect(formProblems({ ...form, linkUrl: 'http://example.com' }).linkUrl).toBe('linkFormat');
    expect(formProblems({ ...form, linkUrl: 'not a link' }).linkUrl).toBe('linkFormat');
    expect(formProblems({ ...form, interests: Array.from({ length: 21 }, (_, i) => `s${i}`).join(',') }).interests).toBe('interestsFormat');
    expect(formProblems({ ...form, variants: [{ headline: 'Chỉ có tiêu đề', primaryText: '', callToAction: 'learn_more' }] }).variants).toBe('variantIncomplete');
  });

  it('leaves the age order and the dates to the server: they are issues, not format problems', () => {
    const form = planToForm(plan());
    expect(formProblems({ ...form, ageMin: '50', ageMax: '30' })).toEqual({});
    expect(formProblems({ ...form, startOn: '2026-11-20', endOn: '2026-11-01' })).toEqual({});
  });
});

describe('the largest amount a plan can spend', () => {
  it('is the daily budget times the days of the flight, first and last day included, exactly', () => {
    expect(flightDays('2026-11-10', '2026-11-16')).toBe(7);
    expect(flightDays('2026-11-10', '2026-11-10')).toBe(1);
    expect(flightDays('2026-11-10', '2026-11-09')).toBeNull();
    expect(flightDays('', '2026-11-09')).toBeNull();
    expect(maxSpendOf({ dailyBudget: '100000', startOn: '2026-11-10', endOn: '2026-11-16' })).toEqual({ amount: '700000', days: 7 });
    expect(maxSpendOf({ dailyBudget: '12.34', startOn: '2026-11-10', endOn: '2026-11-12' })).toEqual({ amount: '37.02', days: 3 });
    // A number JS floats would get wrong: 0.1 a day for 3 days.
    expect(maxSpendOf({ dailyBudget: '0.10', startOn: '2026-11-10', endOn: '2026-11-12' })).toEqual({ amount: '0.3', days: 3 });
  });

  it('cannot be told while a figure is missing, or the flight is backwards or longer than the most', () => {
    expect(maxSpendOf({ dailyBudget: '', startOn: '2026-11-10', endOn: '2026-11-12' })).toBeNull();
    expect(maxSpendOf({ dailyBudget: '100000', startOn: '', endOn: '2026-11-12' })).toBeNull();
    expect(maxSpendOf({ dailyBudget: '100000', startOn: '2026-11-12', endOn: '2026-11-10' })).toBeNull();
    expect(maxSpendOf({ dailyBudget: '100000', startOn: '2026-11-01', endOn: '2027-03-01' })).toBeNull();
    expect(maxSpendOf({ dailyBudget: '0', startOn: '2026-11-10', endOn: '2026-11-12' })).toBeNull();
  });
});

describe('starting from a post', () => {
  const post = { id: ID, title: 'Khai trương chi nhánh mới', body: 'Chúng tôi khai trương chi nhánh mới vào thứ Bảy này. Mời bạn ghé thử cà phê mới của quán, có nhiều ưu đãi dành riêng cho khách đến sớm trong tuần lễ khai trương.', linkUrl: 'https://example.com/khai-truong' };

  it('takes the title and the words for the request, the soft-limited texts for the ad, the link and the post id', () => {
    const start = startFromPost(post);
    expect(start.sourcePostId).toBe(ID);
    expect(start.name).toBe('Khai trương chi nhánh mới');
    expect(start.brief).toBe(`${post.title}\n\n${post.body}`);
    expect(start.headline).toBe('Khai trương chi nhánh mới');
    expect([...start.primaryText].length).toBeLessThanOrEqual(125);
    expect(start.primaryText.endsWith('…')).toBe(true);
    expect(start.linkUrl).toBe('https://example.com/khai-truong');
  });

  it('uses the first line when the post has no title, keeps a request within its limit and drops a link that is not https', () => {
    const start = startFromPost({ id: ID, title: null, body: `Dòng đầu\n${'x'.repeat(2000)}`, linkUrl: 'http://example.com' });
    expect(start.name).toBe('Dòng đầu');
    expect(start.headline).toBe('Dòng đầu');
    expect([...start.brief].length).toBeLessThanOrEqual(1000);
    expect(start.linkUrl).toBe('');
  });

  it('makes a new form with the post id as an opaque reference and never the post text outside the texts', () => {
    const form = formFromPost(startFromPost(post), 'engagement');
    expect(form.sourcePostId).toBe(ID);
    expect(form.objective).toBe('engagement');
    expect(form.variants[0]?.callToAction).toBe('no_button');
    expect(formToPlan(form).sourcePostId).toBe(ID);
  });

  it('cuts at a word with an ellipsis and leaves a short text alone', () => {
    expect(cutAt('một hai ba bốn năm', 12)).toBe('một hai ba…');
    expect(cutAt('  ngắn  ', 12)).toBe('ngắn');
  });
});

describe('the fields still drafted by the AI coworker', () => {
  const draft = { plan: plan(), aiFields: ['name', 'dailyBudget', 'targeting', 'variants'] };

  it('are all of them while the form is as drafted', () => {
    expect(draftedFields(planToForm(draft.plan), draft)).toEqual(['name', 'dailyBudget', 'targeting', 'variants']);
  });

  it('lose a field the person changed, and only that one', () => {
    const form = { ...planToForm(draft.plan), dailyBudget: '200000' };
    expect(draftedFields(form, draft)).toEqual(['name', 'targeting', 'variants']);
    const edited = { ...planToForm(draft.plan), variants: [{ headline: 'Khác', primaryText: 'Chữ khác.', callToAction: 'learn_more' as const }] };
    expect(draftedFields(edited, draft)).toEqual(['name', 'dailyBudget', 'targeting']);
  });
});

const ISSUES: AdsPlanIssue[] = [
  { code: 'missing_field', severity: 'error', field: 'dailyBudget', params: {} },
  { code: 'end_before_start', severity: 'error', field: 'endOn', params: {} },
  { code: 'start_in_past', severity: 'error', field: 'startOn', params: { today: '2026-11-03' } },
  { code: 'flight_too_long', severity: 'error', field: 'endOn', params: { days: 120, max: 90 } },
  { code: 'age_range', severity: 'error', field: 'targeting', params: {} },
  { code: 'interests_repeated', severity: 'warning', field: 'targeting', params: {} },
  { code: 'headline_long', severity: 'warning', field: 'variants', params: { variant: 2, soft: 40 } },
  { code: 'primary_text_long', severity: 'warning', field: 'variants', params: { variant: 1, soft: 125 } },
  { code: 'messenger_call_to_action', severity: 'warning', field: 'variants', params: { variant: 1 } },
  { code: 'page_not_found', severity: 'error', field: 'pageConnectionId', params: {} },
  { code: 'account_currency_unknown', severity: 'error', field: null, params: {} },
  { code: 'budget_decimals', severity: 'error', field: 'dailyBudget', params: { currency: 'VND', decimals: 0 } },
  { code: 'cap_currency', severity: 'error', field: 'dailyBudget', params: { currency: 'VND' } },
  { code: 'no_cap', severity: 'error', field: null, params: {} },
  { code: 'daily_cap_exceeded', severity: 'error', field: 'dailyBudget', params: { scope: 'org' } },
  { code: 'monthly_cap_exceeded', severity: 'error', field: 'dailyBudget', params: { scope: 'org', month: '2026-11' } },
  { code: 'writing_off', severity: 'error', field: null, params: {} },
  { code: 'account_not_enabled', severity: 'error', field: null, params: {} },
  { code: 'launches_blocked', severity: 'error', field: null, params: {} },
];
const REFUSALS = ['AI_OFF', 'AI_BUDGET', 'RATE_LIMITED', 'AI_ERROR', 'INVALID', 'EMPTY', 'FIGURES', 'LINK', 'EXPIRED'];

describe.each(['en', 'vi'] as const)('the words in %s', (locale) => {
  const t = translatorFor(locale);

  it('say every finding of local validation in a sentence, never as its code', () => {
    for (const issue of ISSUES) {
      const sentence = issueText(issue, t);
      expect(sentence, issue.code).not.toBe(issue.code);
      expect(sentence, issue.code).not.toMatch(/[{}]/);
      expect(sentence.length, issue.code).toBeGreaterThan(10);
    }
  });

  it('say every refusal of the AI coworker, and the general line for one this build does not know', () => {
    const lines = REFUSALS.map((code) => refusalText(code, t));
    expect(new Set(lines).size).toBe(REFUSALS.length);
    for (const line of lines) expect(line).not.toMatch(/[{}]/);
    expect(refusalText('SOMETHING_NEW', t)).toBe(refusalText(null, t));
    // The meter's refusal says the AI budget of the month is used up and that the rest keeps working.
    expect(refusalText('AI_BUDGET', t)).toMatch(locale === 'en' ? /budget/i : /ngân sách/i);
  });

  it('name the numbers a finding is about', () => {
    expect(issueText(ISSUES[3]!, t)).toContain('90');
    expect(issueText(ISSUES[3]!, t)).toContain('120');
    expect(issueText(ISSUES[2]!, t)).toContain('2026-11-03');
    expect(issueText(ISSUES[6]!, t)).toContain('40');
    expect(issueText(ISSUES[0]!, t)).not.toBe(issueText({ ...ISSUES[0]!, field: 'startOn' }, t));
  });

  it('show a code this build does not know as it is, so a newer server never hides a finding', () => {
    expect(issueText({ code: 'brand_new_rule', severity: 'error', field: null, params: {} }, t)).toBe('brand_new_rule');
  });
});
