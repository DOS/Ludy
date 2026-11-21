// SPDX-License-Identifier: AGPL-3.0-only
// What approving a campaign plan says it does (#3639, Engage audit AD-1), checked against the launch path of modules/ads: the approval holds the plan's amount
// against the caps and queues the launch; the launch job creates the campaign PAUSED at the platform; the activation job switches it on by itself from the plan's
// first day, with no second approval (launch-activate.ts, ADR-0043 points 4 and 5). So no string on the approval path may say nothing is sent or that approving only
// marks the plan, and the card, the button, the toast and the subtitles name the amount, the paused state and the automatic start, in both languages.
import { describe, expect, it } from 'vitest';
import type { AdsChange } from '@ludy/kernel-contract';
import { adsChangeLine, adsChangeText, isAdsManageChange } from '../src/lib/ads-change.ts';
import { catalog, translatorFor } from '../src/i18n/runtime.ts';

const money = (amount: string, currency: string) => `${amount} ${currency}`;
const date = (day: string) => `ngày ${day}`;
const plan = {
  name: 'Cà phê Mộc',
  objective: 'traffic' as const,
  dailyBudget: '100000',
  startOn: '2027-01-02',
  endOn: '2027-01-08',
  targeting: { locations: [{ country: 'VN' }], ageMin: 20, ageMax: 45, gender: 'all' as const, interests: [] },
  linkUrl: null,
  pageConnectionId: null,
  sourcePostId: null,
  mediaFileId: null,
  variants: [{ headline: 'Chi nhánh mới', primaryText: 'Ghé quán nhé.', callToAction: 'learn_more' as const }],
};
const launch: AdsChange = { change: 'campaign_launch', draftId: 'd1', adAccountId: 'a1', adAccountName: 'Shop', amount: '700000', currency: 'VND', days: 7, plan, origin: 'human', aiFields: [] };

describe('the approval card of a campaign plan', () => {
  it('says approving allows the spend, holds the amount, creates the campaign paused and starts it by itself from the first day, in Vietnamese', () => {
    const { detail } = adsChangeText(launch, translatorFor('vi'), money, date);
    expect(detail).toContain('Duyệt là cho phép chi tối đa 700000 VND trong 7 ngày, mỗi ngày 100000 VND');
    expect(detail).toContain('giữ 700000 VND trong hạn mức chi tiêu');
    expect(detail).toContain('ở trạng thái tạm dừng');
    expect(detail).toContain('tự bật từ ngày bắt đầu (ngày 2027-01-02) mà không hỏi lại');
    expect(detail).toContain('trừ khi trước đó hạn mức bị giảm hoặc việc chạy quảng cáo bị tắt');
    expect(detail).toContain('Chưa tiêu đồng nào trước ngày đó');
  });

  it('and in English', () => {
    const { detail } = adsChangeText(launch, translatorFor('en'), money, date);
    expect(detail).toContain('Approving allows spending at most 700000 VND over 7 days, 100000 VND a day');
    expect(detail).toContain('holds 700000 VND against your spend caps');
    expect(detail).toContain('creates the campaign at the ad platform paused');
    expect(detail).toContain('switches it on by itself from the start date (ngày 2027-01-02), without asking again');
    expect(detail).toContain('unless a cap is lowered or running ads is turned off before then');
    expect(detail).toContain('Nothing is spent before that day');
    expect(adsChangeLine(launch, translatorFor('en'), money, date)).toContain('Approving allows spending');
  });

  it('is unchanged for the other requests, which do not spend', () => {
    const t = translatorFor('en');
    expect(adsChangeText({ change: 'write_enable' }, t, money).detail).toBe(catalog('en').ads.change.writeEnableDetail);
  });
});

describe('the button, the toast and the subtitles of the approval', () => {
  const messages = (locale: 'vi' | 'en') => catalog(locale) as unknown as { inboxDetail: Record<string, string>; ads: { campaigns: Record<string, string> } };
  const fmt = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? `{${k}}`);

  it('name the amount, the paused state and the automatic start', () => {
    const vi = messages('vi').inboxDetail;
    expect(fmt(vi.approveCampaignLaunch as string, { amount: '700000 VND' })).toBe('Duyệt và giữ chỗ 700000 VND');
    expect(fmt(vi.approvedCampaignToast as string, { name: 'Cà phê Mộc', amount: '700000 VND', from: '2/1/2027' })).toBe('Đã duyệt kế hoạch Cà phê Mộc. Ludy giữ 700000 VND trong hạn mức, đang tạo chiến dịch ở trạng thái tạm dừng và sẽ tự bật từ 2/1/2027.');
    expect(vi.adsLaunchSubtitle).toContain('tạm dừng');
    expect(vi.adsLaunchSubtitle).toContain('tự bật từ ngày bắt đầu, không hỏi lại');
    const en = messages('en').inboxDetail;
    expect(fmt(en.approveCampaignLaunch as string, { amount: '700000 VND' })).toBe('Approve and hold 700000 VND');
    expect(en.approvedCampaignToast).toContain('creating the campaign paused');
    expect(en.adsLaunchSubtitle).toContain('switches it on by itself from its start date');
  });

  it('leave no string on the approval path that says nothing is sent, or that approving only marks the plan', () => {
    for (const locale of ['vi', 'en'] as const) {
      const m = messages(locale);
      const path = [m.inboxDetail.adsSubtitle, m.inboxDetail.adsLaunchSubtitle, m.ads.campaigns.subtitle, m.ads.campaigns.submitHint, m.ads.campaigns.launchQueued, m.ads.campaigns.launchCreated, (catalog(locale) as unknown as { ads: { change: Record<string, string> } }).ads.change.campaignLaunchDetail];
      for (const text of path) {
        expect(text, locale).toBeTruthy();
        expect(text, locale).not.toMatch(/chỉ đánh dấu|chưa gửi gì lên nền tảng\.|chưa chạy gì|only marks|only marked|nothing is sent to the (ad )?platform yet|nothing is launched yet/i);
      }
    }
  });
});

// #3675: on a server with no launch writer an approved plan holds its amount and nothing is created, so every string of the approval says that and none promises a launch.
describe('the approval of a campaign plan on a server that cannot launch (#3675)', () => {
  const promises = /tự bật|tạo chiến dịch ở trạng thái|đang tạo chiến dịch|switches it on|creates the campaign at the ad platform|is creating the campaign/i;
  const m = (locale: 'vi' | 'en') => catalog(locale) as unknown as { inboxDetail: Record<string, string> };
  const fmt = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? `{${k}}`);

  it('words the card, the subtitle, the button and the toast as a hold only, in both languages', () => {
    for (const locale of ['vi', 'en'] as const) {
      const { inboxDetail } = m(locale);
      // The detail is checked below: it may name a later switch-on, but only as a condition.
      for (const text of [inboxDetail.adsNoLauncher, inboxDetail.adsLaunchHeldSubtitle, inboxDetail.approveCampaignHeldOnly, inboxDetail.approvedCampaignHeldToast]) {
        expect(text, locale).toBeTruthy();
        expect(text, locale).not.toMatch(promises);
      }
    }
    // The detail may say what happens if the server turns launching on later, but only as a condition, after saying nothing is created now.
    expect(adsChangeText(launch, translatorFor('en'), money, date, false).detail).toContain('If this server turns on running real ads later');
    expect(adsChangeText(launch, translatorFor('vi'), money, date, false).detail).toContain('Nếu sau này máy chủ bật chạy quảng cáo thật');
    expect(adsChangeText(launch, translatorFor('vi'), money, date, false).detail).toContain('giữ 700000 VND trong hạn mức chi tiêu');
    expect(adsChangeText(launch, translatorFor('vi'), money, date, false).detail).toContain('Máy chủ này chưa bật chạy quảng cáo thật nên chiến dịch chưa được tạo');
    expect(fmt(m('vi').inboxDetail.approveCampaignHeldOnly as string, { amount: '700000 VND' })).toBe('Duyệt và chỉ giữ chỗ 700000 VND (chưa tạo chiến dịch)');
    expect(m('vi').inboxDetail.adsNoLauncher).toBe('Máy chủ này chưa bật chạy quảng cáo thật; duyệt sẽ giữ chỗ hạn mức nhưng chưa tạo chiến dịch.');
    expect(adsChangeLine(launch, translatorFor('en'), money, date, false)).toContain('not created at the ad platform');
  });

  it('keeps the launch sentence when the server can launch or does not say', () => {
    for (const answer of [true, null]) {
      expect(adsChangeText(launch, translatorFor('en'), money, date, answer).detail).toContain('switches it on by itself');
    }
    expect(adsChangeText(launch, translatorFor('en'), money, date).detail).toContain('switches it on by itself');
  });
});

// The requests that can start or raise spend on a running ad (W4, #3835): a resume, a budget raise and a longer schedule. Each card names the largest amount the launch can spend
// before and with the change, the daily budget and the dates, from the structured change, in both languages.
describe('the approval card of a change to a running ad (W4, #3835)', () => {
  const base = { launchId: 'l1', adAccountId: 'a1', adAccountName: 'Shop', campaignName: 'Cà phê Mộc', currency: 'VND', amount: '1500000', previousAmount: '1000000' };
  const resume: AdsChange = { ...base, change: 'object_resume', slot: 'ad_set', objectName: 'Nhóm một', dailyBudget: '100000', endOn: '2027-01-15' };
  const raise: AdsChange = { ...base, change: 'budget_raise', fromBudget: '100000', toBudget: '150000', endOn: '2027-01-10' };
  const extend: AdsChange = { ...base, change: 'schedule_extend', dailyBudget: '100000', fromEndOn: '2027-01-10', toEndOn: '2027-01-15' };

  it('says what a budget raise allows, in English and in Vietnamese, with both amounts, the daily budget and the date', () => {
    const en = adsChangeText(raise, translatorFor('en'), money, date);
    expect(en.title).toBe('Raise the daily budget of the campaign “Cà phê Mộc” on Shop from 100000 VND to 150000 VND.');
    expect(en.detail).toContain('Approving allows the launch to spend at most 1500000 VND (now 1000000 VND): 150000 VND a day until ngày 2027-01-10.');
    expect(en.detail).toContain('holds 1500000 VND against your spend caps');
    expect(en.detail).toContain('lower it again at any time without approval');
    const vi = adsChangeText(raise, translatorFor('vi'), money, date);
    expect(vi.title).toBe('Tăng ngân sách mỗi ngày của chiến dịch “Cà phê Mộc” trên Shop từ 100000 VND lên 150000 VND.');
    expect(vi.detail).toContain('Duyệt là cho phép lần chạy chi tối đa 1500000 VND (hiện là 1000000 VND): mỗi ngày 150000 VND đến ngày ngày 2027-01-10.');
    expect(vi.detail).toContain('giữ 1500000 VND trong hạn mức chi tiêu');
  });

  it('says what a longer schedule allows, with the old and the new end date', () => {
    const en = adsChangeText(extend, translatorFor('en'), money, date);
    expect(en.title).toBe('Extend the schedule of the campaign “Cà phê Mộc” on Shop from ngày 2027-01-10 to ngày 2027-01-15.');
    expect(en.detail).toContain('at most 1500000 VND (now 1000000 VND): 100000 VND a day until ngày 2027-01-15.');
    const vi = adsChangeText(extend, translatorFor('vi'), money, date);
    expect(vi.title).toBe('Kéo dài lịch chạy của chiến dịch “Cà phê Mộc” trên Shop từ ngày 2027-01-10 đến ngày 2027-01-15.');
    expect(vi.detail).toContain('chi tối đa 1500000 VND (hiện là 1000000 VND): mỗi ngày 100000 VND đến ngày ngày 2027-01-15.');
  });

  it('says what a resume allows: the object, the largest amount before and with it, or that the amount stays when it does not move', () => {
    const en = adsChangeText(resume, translatorFor('en'), money, date);
    expect(en.title).toBe('Switch Nhóm một back on in the campaign “Cà phê Mộc” on Shop.');
    expect(en.detail).toContain('Approving asks the ad platform to resume Nhóm một. The most the launch can spend goes from 1000000 VND to 1500000 VND (100000 VND a day until ngày 2027-01-15)');
    const same = adsChangeText({ ...resume, previousAmount: '1500000.00' }, translatorFor('en'), money, date);
    expect(same.detail).toContain('The most the launch can spend stays 1500000 VND (100000 VND a day until ngày 2027-01-15)');
    expect(same.detail).not.toContain('goes from');
    const vi = adsChangeText(resume, translatorFor('vi'), money, date);
    expect(vi.title).toBe('Bật lại Nhóm một trong chiến dịch “Cà phê Mộc” trên Shop.');
    expect(vi.detail).toContain('đổi từ 1000000 VND thành 1500000 VND');
  });

  it('words the waiting list line with the sentence and its amounts, like a cap or a launch', () => {
    for (const change of [resume, raise, extend]) {
      const line = adsChangeLine(change, translatorFor('en'), money, date);
      expect(line).toContain(adsChangeText(change, translatorFor('en'), money, date).title);
      expect(line).toContain('1500000 VND');
    }
  });

  it('shows a hostile campaign, account or object name with its control characters made visible, never applied', () => {
    const hostile: AdsChange = { ...resume, campaignName: 'Mộc‮gnirts', adAccountName: 'Shop​', objectName: 'Nhóm⁦một' };
    const { title } = adsChangeText(hostile, translatorFor('en'), money, date);
    expect(title).toContain('⟨U+202E⟩');
    expect(title).toContain('⟨U+200B⟩');
    expect(title).toContain('⟨U+2066⟩');
    expect(title).not.toMatch(/[‮​⁦]/);
  });

  it('is told apart from the other requests, and is never a launch', () => {
    expect(isAdsManageChange(resume) && isAdsManageChange(raise) && isAdsManageChange(extend)).toBe(true);
    expect(isAdsManageChange(launch)).toBe(false);
    expect(isAdsManageChange({ change: 'write_enable' })).toBe(false);
  });

  it('words the button, the subtitle and the toast of the Inbox, and promises nothing before approval', () => {
    const fmt = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_m, k: string) => values[k] ?? `{${k}}`);
    const vi = (catalog('vi') as unknown as { inboxDetail: Record<string, string> }).inboxDetail;
    const en = (catalog('en') as unknown as { inboxDetail: Record<string, string> }).inboxDetail;
    expect(fmt(vi.approveAdsManage as string, { amount: '1500000 VND' })).toBe('Duyệt và cho phép chi tối đa 1500000 VND');
    expect(fmt(en.approveAdsManage as string, { amount: '1500000 VND' })).toBe('Approve and allow up to 1500000 VND');
    expect(fmt(en.adsManageWas as string, { amount: '1000000 VND' })).toBe('Before this change: 1000000 VND');
    for (const text of [en.adsManageSubtitle, en.approvedAdsManageToast, vi.adsManageSubtitle, vi.approvedAdsManageToast]) {
      expect(text).toBeTruthy();
      expect(text).not.toMatch(/chỉ đánh dấu|only marks|nothing is sent/i);
    }
    expect(en.adsManageSubtitle).toContain('after the approval');
    expect(vi.adsManageSubtitle).toContain('sau khi duyệt');
  });
});
