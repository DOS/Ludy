// SPDX-License-Identifier: AGPL-3.0-only
// The morning mail and daily briefing contract (#3955, #5080): v1 count-only rendering, strict v1/v2 stored payload bounds (zero titles, attendees, decisions, items, deals, or Vy lines),
// member setting defaults (content='count', vyLines=false), and strict render-time briefing content caps.
import { describe, expect, it } from 'vitest';
import {
  MORNING_BRIEFING_CAPS,
  MORNING_CONTENT_MODES,
  MORNING_DEFAULT_MINUTE,
  MORNING_MAIL_CONTENT_COMMAND,
  zMorningBriefingContent,
  zMorningBriefingDeal,
  zMorningBriefingMail,
  zMorningBriefingMeeting,
  zMorningBriefingOpenItem,
  zMorningContentMode,
  zMorningCountMail,
  zMorningMail,
  zMorningSet,
  zMorningState,
  type MorningBriefingContent,
  type MorningBriefingDeal,
  type MorningBriefingMail,
  type MorningBriefingMeeting,
  type MorningBriefingOpenItem,
  type MorningContentMode,
  type MorningCountMail,
  type MorningMail,
  type MorningSet,
  type MorningState,
} from '@ludy/kernel-contract';
import { morningMailTemplate } from '../src/morning-mail.ts';

const ID = '0b7e7c5e-1d3a-4c7e-9d0a-6a1f3f0a9b11';
const DEAL_ID = '11111111-1111-4111-8111-111111111111';
const input = (payload: Record<string, unknown>, subject: string | null = 'Chủ đề') => ({
  messageId: ID,
  subject,
  payload,
  publicUrl: 'https://ludy.test/',
  inboundAddress: null,
  brand: 'Ludy',
  execute: async () => undefined as never,
});
const base = { lang: 'vi', org: 'Công ty <A>', count: 3, path: '/o/acme/meetings' };

const sampleMeeting = (over: Record<string, unknown> = {}) => ({
  id: ID,
  path: `/o/acme/meetings/${ID}`,
  title: 'Họp giao ban tuần',
  startAt: '2026-11-26T09:00:00+07:00',
  endAt: '2026-11-26T09:30:00+07:00',
  timeZone: 'Asia/Ho_Chi_Minh',
  inviteeCount: 4,
  readerNames: ['An', 'Bình'],
  extraReadersCount: 0,
  previousDecisions: ['Chốt báo giá tháng 12'],
  openItems: [{ text: 'Gửi hợp đồng cho khách', dueOn: '2026-11-26', overdue: false, mine: true }],
  deals: [{ id: DEAL_ID, title: 'Gói Enterprise Q4', stage: 'Thương lượng', stageKind: 'open', amount: '15000000.00', expectedClose: '2026-12-15' }],
  vyLines: ['Kiểm tra lại tiến độ gửi hợp đồng trước giờ họp.'],
  ...over,
});

describe('the morning mail', () => {
  it('says the count and links the meetings page in both languages', async () => {
    const vi = await morningMailTemplate.render(input(base));
    expect(vi?.text).toContain('Hôm nay bạn có 3 cuộc họp.');
    expect(vi?.text).toContain('https://ludy.test/o/acme/meetings');
    expect(vi?.html).toContain('href="https://ludy.test/o/acme/meetings"');
    // The org's name is escaped in the HTML.
    expect(vi?.html).toContain('Công ty &lt;A&gt;');
    expect(vi?.html).not.toContain('<A>');
    const one = await morningMailTemplate.render(input({ ...base, lang: 'en', count: 1 }));
    expect(one?.text).toContain('You have 1 meeting today.');
    const many = await morningMailTemplate.render(input({ ...base, lang: 'en' }));
    expect(many?.text).toContain('You have 3 meetings today.');
  });

  it('refuses merge data with a key it does not use (a title, a time) or a link that is not the meetings page', async () => {
    await expect(morningMailTemplate.render(input({ ...base, title: 'Họp lương' }))).rejects.toThrow();
    await expect(morningMailTemplate.render(input({ ...base, events: ['09:00'] }))).rejects.toThrow();
    await expect(morningMailTemplate.render(input({ ...base, path: 'https://evil.test/' }))).rejects.toThrow();
    await expect(morningMailTemplate.render(input({ ...base, path: `/o/acme/meetings/${ID}` }))).rejects.toThrow();
    await expect(morningMailTemplate.render(input({ ...base, count: -1 }))).rejects.toThrow();
    // No subject, no mail.
    expect(await morningMailTemplate.render(input(base, null))).toBeNull();
    // V2 full briefing payloads fail closed until Slice C implements render-time lookup and template rendering.
    expect(await morningMailTemplate.render(input({ lang: 'vi', org: 'Acme', path: '/o/acme/meetings', day: '2026-11-26' }))).toBeNull();
    // Mixed count + day or extra content keys are rejected.
    await expect(morningMailTemplate.render(input({ ...base, day: '2026-11-26' }))).rejects.toThrow();
    await expect(morningMailTemplate.render(input({ lang: 'vi', org: 'Acme', path: '/o/acme/meetings', day: '2026-11-26', content: 'full' }))).rejects.toThrow();
  });
});

describe('morning briefing contract (#5080)', () => {
  it('accepts v1 and v2 metadata-only zMorningMail payloads and strictly rejects extra or mixed keys', () => {
    const v1: MorningCountMail = zMorningCountMail.parse(base);
    expect(v1).toEqual(base);
    const v1Union: MorningMail = zMorningMail.parse(base);
    expect(v1Union).toEqual(base);

    // ADR-0049 (#5108): exact 4-field v2 briefing payload `{ lang, org, path, day }`.
    const adrBriefing = { lang: 'vi', org: 'Công ty <A>', path: '/o/acme/meetings', day: '2026-11-26' };
    const v2Adr: MorningBriefingMail = zMorningBriefingMail.parse(adrBriefing);
    expect(v2Adr).toEqual(adrBriefing);
    const v2Union: MorningMail = zMorningMail.parse(adrBriefing);
    expect(v2Union).toEqual(adrBriefing);

    // Reject invalid dates, extra fields (`content` belongs in settings, not mail payload), missing discriminators, and mixed payloads.
    expect(zMorningMail.safeParse({ ...adrBriefing, day: '2026-02-30' }).success).toBe(false);
    expect(zMorningMail.safeParse({ ...base, content: 'count' }).success).toBe(false);
    expect(zMorningMail.safeParse({ ...adrBriefing, content: 'full' }).success).toBe(false);
    expect(zMorningMail.safeParse({ ...base, content: 'full' }).success).toBe(false);
    expect(zMorningMail.safeParse({ ...base, day: '2026-11-26' }).success).toBe(false);
    expect(zMorningMail.safeParse({ lang: 'vi', org: 'Acme', path: '/o/acme/meetings' }).success).toBe(false);

    // Zero titles, attendee names, decisions, items, CRM deals, or Vy lines in stored mail payloads.
    for (const rogue of [
      { title: 'Họp kín' },
      { titles: ['Họp kín'] },
      { meetings: [] },
      { attendees: ['An'] },
      { readerNames: ['An'] },
      { decisions: ['Chốt'] },
      { previousDecisions: ['Chốt'] },
      { openItems: [] },
      { deals: [] },
      { lines: ['Chuẩn bị'] },
      { vyLines: ['Chuẩn bị'] },
    ]) {
      expect(zMorningMail.safeParse({ ...base, ...rogue }).success).toBe(false);
      expect(zMorningMail.safeParse({ ...adrBriefing, ...rogue }).success).toBe(false);
    }
  });

  it('defaults zMorningSet consent fields safely and keeps zMorningState backward compatible', () => {
    const mode: MorningContentMode = zMorningContentMode.parse('full');
    expect(mode).toBe('full');
    expect(MORNING_CONTENT_MODES).toEqual(['count', 'full']);
    expect(MORNING_MAIL_CONTENT_COMMAND).toBe('meetings.morning.mail_content');

    const legacyCall: MorningSet = zMorningSet.parse({
      enabled: true,
      minute: 450,
      timeZone: 'Asia/Ho_Chi_Minh',
      language: 'en',
    });
    expect(legacyCall).toEqual({
      enabled: true,
      minute: 450,
      timeZone: 'Asia/Ho_Chi_Minh',
      language: 'en',
      content: 'count',
      vyLines: false,
    });

    const minimal: MorningSet = zMorningSet.parse({ enabled: true });
    expect(minimal).toEqual({
      enabled: true,
      minute: MORNING_DEFAULT_MINUTE,
      timeZone: 'Asia/Ho_Chi_Minh',
      language: 'vi',
      content: 'count',
      vyLines: false,
    });

    const fullWithVy: MorningSet = zMorningSet.parse({ enabled: true, content: 'full', vyLines: true });
    expect(fullWithVy.content).toBe('full');
    expect(fullWithVy.vyLines).toBe(true);

    // Enabling Vy prep lines without full briefing content is rejected; turning off is always permitted.
    expect(zMorningSet.safeParse({ enabled: true, content: 'count', vyLines: true }).success).toBe(false);
    expect(zMorningSet.safeParse({ enabled: true, vyLines: true }).success).toBe(false);
    expect(zMorningSet.safeParse({ enabled: false, content: 'count', vyLines: true }).success).toBe(true);

    expect(zMorningSet.safeParse({ enabled: true, content: 'all' }).success).toBe(false);
    expect(zMorningSet.safeParse({ enabled: true, extra: true }).success).toBe(false);

    // Existing producers omit content/vyLines until DB columns land.
    const legacyState: MorningState = zMorningState.parse({
      enabled: true,
      minute: 420,
      timeZone: 'Asia/Ho_Chi_Minh',
      language: 'vi',
    });
    expect(legacyState).toEqual({ enabled: true, minute: 420, timeZone: 'Asia/Ho_Chi_Minh', language: 'vi' });
    expect('content' in legacyState).toBe(false);

    const v2State: MorningState = zMorningState.parse({
      enabled: true,
      minute: 420,
      timeZone: 'Asia/Ho_Chi_Minh',
      language: 'vi',
      content: 'full',
      vyLines: true,
    });
    expect(v2State.content).toBe('full');
    expect(v2State.vyLines).toBe(true);
  });

  it('validates MORNING_BRIEFING_CAPS, safe internal paths, and strict zMorningBriefingContent bounds', () => {
    expect(MORNING_BRIEFING_CAPS).toMatchObject({
      meetingsMax: 12,
      titleMax: 120,
      nameMax: 80,
      orgNamesMax: 8,
      decisionTextMax: 240,
      decisionsPerMeetingMax: 5,
      actionItemTextMax: 240,
      actionItemsPerMeetingMax: 8,
      dealTitleMax: 120,
      dealStageMax: 80,
      dealsPerMeetingMax: 3,
      vyLineTextMax: 240,
      vyLinesPerMeetingMax: 3,
      vyMeetingsMax: 5,
    });

    for (const goodPath of [
      '/o/acme/meetings',
      `/o/acme/meetings/${ID}`,
      '/o/acme/meetings/record',
      '/o/acme/deals',
      '/o/acme/settings/notifications',
    ]) {
      expect(MORNING_BRIEFING_CAPS.pathRegex.test(goodPath), goodPath).toBe(true);
    }
    for (const badPath of [
      'https://evil.test/o/acme/meetings',
      '//evil.test/o/acme/meetings',
      '/o/acme/meetings/../admin',
      '/o/acme/meetings?next=https://evil.test',
      '/o/acme/meetings/not-a-uuid',
      '/o/Acme/meetings',
    ]) {
      expect(MORNING_BRIEFING_CAPS.pathRegex.test(badPath), badPath).toBe(false);
    }

    const item: MorningBriefingOpenItem = zMorningBriefingOpenItem.parse({ text: 'Theo dõi báo giá', dueOn: null });
    expect(item).toEqual({ text: 'Theo dõi báo giá', dueOn: null, overdue: false, mine: false });

    const deal: MorningBriefingDeal = zMorningBriefingDeal.parse({ id: DEAL_ID, title: 'Gói năm', stage: 'Mới' });
    expect(deal.title).toBe('Gói năm');

    const meeting: MorningBriefingMeeting = zMorningBriefingMeeting.parse(sampleMeeting());
    expect(meeting.readerNames).toEqual(['An', 'Bình']);

    const content: MorningBriefingContent = zMorningBriefingContent.parse({
      day: '2026-11-26',
      totalMeetings: 15,
      meetings: Array.from({ length: 12 }, (_, idx) =>
        sampleMeeting({
          vyLines: idx < 5 ? ['Gợi ý 1'] : undefined,
        }),
      ),
    });
    expect(content.totalMeetings).toBe(15);
    expect(content.meetings).toHaveLength(12);

    // Emoji code-point boundary & untitled event pass; 121 chars fail.
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ title: '', vyLines: undefined })).success,
    ).toBe(true);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ title: '🎉'.repeat(MORNING_BRIEFING_CAPS.titleMax) })).success,
    ).toBe(true);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ title: 'a'.repeat(MORNING_BRIEFING_CAPS.titleMax + 1) })).success,
    ).toBe(false);

    // Cap rejections.
    expect(
      zMorningBriefingContent.safeParse({
        day: '2026-11-26',
        totalMeetings: 13,
        meetings: Array.from({ length: 13 }, () => sampleMeeting({ vyLines: undefined })),
      }).success,
    ).toBe(false);
    expect(
      zMorningBriefingContent.safeParse({
        day: '2026-11-26',
        totalMeetings: 1,
        meetings: [sampleMeeting(), sampleMeeting()],
      }).success,
    ).toBe(false);
    // Max 5 meetings with Vy lines per day (O3); empty vyLines does not count toward cap.
    expect(
      zMorningBriefingContent.safeParse({
        day: '2026-11-26',
        totalMeetings: 6,
        meetings: Array.from({ length: 6 }, () => sampleMeeting({ vyLines: ['Line 1'] })),
      }).success,
    ).toBe(false);
    expect(
      zMorningBriefingContent.safeParse({
        day: '2026-11-26',
        totalMeetings: 6,
        meetings: Array.from({ length: 6 }, (_, idx) => sampleMeeting({ vyLines: idx < 5 ? ['Line 1'] : [] })),
      }).success,
    ).toBe(true);

    // Per-meeting sub-caps & strict schema rules.
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ readerNames: Array.from({ length: 9 }, (_, i) => `User ${i}`) })).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ readerNames: ['n'.repeat(MORNING_BRIEFING_CAPS.nameMax + 1)] })).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ previousDecisions: Array.from({ length: 6 }, (_, i) => `D${i}`) })).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ previousDecisions: ['d'.repeat(MORNING_BRIEFING_CAPS.decisionTextMax + 1)] })).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(
        sampleMeeting({ openItems: Array.from({ length: 9 }, (_, i) => ({ text: `Item ${i}`, overdue: false, mine: false })) }),
      ).success,
    ).toBe(false);
    expect(
      zMorningBriefingOpenItem.safeParse({ text: 't'.repeat(MORNING_BRIEFING_CAPS.actionItemTextMax + 1) }).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(
        sampleMeeting({ deals: Array.from({ length: 4 }, () => ({ id: DEAL_ID, title: 'Deal', stage: 'Mới' })) }),
      ).success,
    ).toBe(false);
    expect(
      zMorningBriefingDeal.safeParse({ id: DEAL_ID, title: 'd'.repeat(MORNING_BRIEFING_CAPS.dealTitleMax + 1), stage: 'Mới' }).success,
    ).toBe(false);
    expect(
      zMorningBriefingDeal.safeParse({ id: DEAL_ID, title: 'Deal', stage: 's'.repeat(MORNING_BRIEFING_CAPS.dealStageMax + 1) }).success,
    ).toBe(false);
    // Only open deals are eligible; closed deal stageKinds ('won', 'lost') are rejected.
    expect(
      zMorningBriefingDeal.safeParse({ id: DEAL_ID, title: 'Deal', stage: 'Mới', stageKind: 'open' }).success,
    ).toBe(true);
    expect(
      zMorningBriefingDeal.safeParse({ id: DEAL_ID, title: 'Deal', stage: 'Thắng', stageKind: 'won' }).success,
    ).toBe(false);
    expect(
      zMorningBriefingDeal.safeParse({ id: DEAL_ID, title: 'Deal', stage: 'Thua', stageKind: 'lost' }).success,
    ).toBe(false);
    // Invalid timeZone and overlong fractional seconds in timestamps are rejected.
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ timeZone: 'Mars/Olympus' })).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ startAt: `2026-11-26T09:00:00.${'0'.repeat(60)}Z` })).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ endAt: `2026-11-26T09:30:00.${'0'.repeat(60)}Z` })).success,
    ).toBe(false);
    // Money must be decimal string, never JS number.
    expect(
      zMorningBriefingDeal.safeParse({ id: DEAL_ID, title: 'Deal', stage: 'Mới', amount: 15000000 }).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ vyLines: ['1', '2', '3', '4'] })).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ vyLines: ['v'.repeat(MORNING_BRIEFING_CAPS.vyLineTextMax + 1)] })).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ path: 'https://evil.test/phish' })).success,
    ).toBe(false);
    expect(
      zMorningBriefingMeeting.safeParse(sampleMeeting({ unknownField: 1 })).success,
    ).toBe(false);
  });
});
