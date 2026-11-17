// SPDX-License-Identifier: AGPL-3.0-only
// What approving a campaign plan says it does (#3639, Engage audit AD-1), checked against the launch path of modules/ads: the approval holds the plan's amount
// against the caps and queues the launch; the launch job creates the campaign PAUSED at the platform; the activation job switches it on by itself from the plan's
// first day, with no second approval (launch-activate.ts, ADR-0043 points 4 and 5). So no string on the approval path may say nothing is sent or that approving only
// marks the plan, and the card, the button, the toast and the subtitles name the amount, the paused state and the automatic start, in both languages.
import { describe, expect, it } from 'vitest';
import type { AdsChange } from '@crove/kernel-contract';
import { adsChangeLine, adsChangeText } from '../src/lib/ads-change.ts';
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
    expect(detail).toContain('Chưa tiêu đồng nào trước ngày đó');
  });

  it('and in English', () => {
    const { detail } = adsChangeText(launch, translatorFor('en'), money, date);
    expect(detail).toContain('Approving allows spending at most 700000 VND over 7 days, 100000 VND a day');
    expect(detail).toContain('holds 700000 VND against your spend caps');
    expect(detail).toContain('creates the campaign at the ad platform paused');
    expect(detail).toContain('switches it on by itself from the start date (ngày 2027-01-02), without asking again');
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
    expect(fmt(vi.approveCampaignLaunch as string, { amount: '700000 VND' })).toBe('Duyệt và cho chạy, tối đa 700000 VND');
    expect(fmt(vi.approvedCampaignToast as string, { name: 'Cà phê Mộc', amount: '700000 VND', from: '2/1/2027' })).toBe('Đã duyệt kế hoạch Cà phê Mộc. Ludy giữ 700000 VND trong hạn mức, đang tạo chiến dịch ở trạng thái tạm dừng và sẽ tự bật từ 2/1/2027.');
    expect(vi.adsLaunchSubtitle).toContain('tạm dừng');
    expect(vi.adsLaunchSubtitle).toContain('tự bật từ ngày bắt đầu, không hỏi lại');
    const en = messages('en').inboxDetail;
    expect(fmt(en.approveCampaignLaunch as string, { amount: '700000 VND' })).toBe('Approve and allow up to 700000 VND');
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
