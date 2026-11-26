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
import { morningMailTemplate, renderMorningBriefingMail } from '../src/morning-mail.ts';

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

  const briefingMail = (over: Record<string, unknown> = {}) => ({
    lang: 'vi',
    org: 'Công ty <A>',
    path: '/o/acme/meetings',
    day: '2026-11-26',
    ...over,
  });

  const briefingContent = (over: Record<string, unknown> = {}) => ({
    day: '2026-11-26',
    totalMeetings: 1,
    meetings: [sampleMeeting()],
    ...over,
  });

  const briefingCtx = (over: Record<string, unknown> = {}) => ({
    subject: 'Họp hôm nay',
    publicUrl: 'https://ludy.test/',
    brand: 'Ludy',
    ...over,
  });

  it('renders full Vietnamese daily briefing in text and escaped HTML with O2/O3/O5 sections', () => {
    const out = renderMorningBriefingMail(
      briefingMail(),
      briefingContent({
        totalMeetings: 1,
        meetings: [
          sampleMeeting({
            extraReadersCount: 2,
            openItems: [
              { text: 'Gửi hợp đồng cho khách', dueOn: '2026-11-26', overdue: false, mine: true },
              { text: 'Rà soát điều khoản thanh toán', dueOn: '2026-11-20', overdue: true, mine: false },
            ],
            deals: [
              { id: DEAL_ID, title: 'Gói Enterprise Q4', stage: 'Thương lượng', stageKind: 'open', amount: '15000000.00', expectedClose: '2026-12-15' },
              { id: '22222222-2222-4222-8222-222222222222', title: 'Gói Mở Rộng', stage: '', amount: null, expectedClose: null },
            ],
            vyLines: ['Kiểm tra lại tiến độ gửi hợp đồng trước giờ họp.', 'Xác nhận hạn chốt gói Q4.'],
          }),
        ],
      }),
      briefingCtx(),
    );

    expect(out).not.toBeNull();
    expect(out?.subject).toBe('Họp hôm nay');
    expect(out?.html).toContain('lang="vi"');
    expect(out?.text).toContain('Lịch họp ngày 26/11/2026 tại Công ty <A>');
    expect(out?.text).toContain('Hôm nay bạn có 1 cuộc họp.');
    expect(out?.text).toContain('09:00 - 09:30 | Họp giao ban tuần');
    expect(out?.text).toContain(`Mở cuộc họp: https://ludy.test/o/acme/meetings/${ID}`);
    expect(out?.text).toContain('Thành phần: 4 khách mời; Người đọc trong tổ chức: An, Bình (+2 khác)');
    expect(out?.text).toContain('Quyết định từ cuộc họp trước:\n  - Chốt báo giá tháng 12');
    expect(out?.text).toContain('Gửi hợp đồng cho khách (Việc của bạn, Hạn 26/11/2026)');
    expect(out?.text).toContain('Rà soát điều khoản thanh toán (Quá hạn, Hạn 20/11/2026)');
    expect(out?.text).toContain('Gói Enterprise Q4 (Thương lượng | 15.000.000 đồng | Dự kiến chốt 15/12/2026)');
    expect(out?.text).toContain('  - Gói Mở Rộng\n');
    expect(out?.text).toContain('Xem danh sách cơ hội: https://ludy.test/o/acme/deals');
    expect(out?.text).toContain('Gợi ý chuẩn bị của Vy:\n  - Kiểm tra lại tiến độ gửi hợp đồng trước giờ họp.');
    expect(out?.text).toContain('Tắt thông báo này trong Cài đặt thông báo: https://ludy.test/o/acme/settings/notifications');

    expect(out?.html).toContain('Công ty &lt;A&gt;');
    expect(out?.html).toContain(`href="https://ludy.test/o/acme/meetings/${ID}"`);
    expect(out?.html).toContain('href="https://ludy.test/o/acme/deals"');
    expect(out?.html).toContain('href="https://ludy.test/o/acme/settings/notifications"');
    expect(out?.html).toContain('Gợi ý chuẩn bị của Vy');
    expect(out?.html).toContain('Việc của bạn');
    expect(out?.html).toContain('Quá hạn');
  });

  it('renders full English daily briefing with timezone conversion, untitled fallback, and fallback meeting path', () => {
    const out = renderMorningBriefingMail(
      briefingMail({ lang: 'en', org: 'Acme Co' }),
      briefingContent({
        totalMeetings: 2,
        meetings: [
          sampleMeeting({
            path: undefined,
            title: '',
            startAt: '2026-11-26T14:00:00Z',
            endAt: '2026-11-26T15:30:00Z',
            timeZone: 'America/New_York',
            inviteeCount: 1,
            readerNames: ['Alice'],
            extraReadersCount: 1,
            previousDecisions: ['Approve Q4 discount tiers'],
            openItems: [{ text: 'Send signed addendum', dueOn: '2026-11-24', overdue: true, mine: true }],
            deals: [{ id: DEAL_ID, title: 'Acme Renewal', stage: 'Proposal', stageKind: 'open', amount: '15000000.00', expectedClose: '2026-12-15' }],
            vyLines: ['Confirm pricing tier before the call.'],
          }),
          sampleMeeting({
            id: '33333333-3333-4333-8333-333333333333',
            path: '/o/acme/meetings/record',
            title: 'Engineering Sync',
            startAt: '2026-11-26T16:00:00+07:00',
            endAt: '2026-11-26T16:45:00+07:00',
            timeZone: 'Asia/Ho_Chi_Minh',
            inviteeCount: 0,
            readerNames: [],
            extraReadersCount: 0,
            previousDecisions: [],
            openItems: [],
            deals: [],
            vyLines: undefined,
          }),
        ],
      }),
      briefingCtx({ subject: 'You have meetings today' }),
    );

    expect(out).not.toBeNull();
    expect(out?.html).toContain('lang="en"');
    expect(out?.text).toContain('Meetings for 2026-11-26 at Acme Co');
    expect(out?.text).toContain('You have 2 meetings today.');
    expect(out?.text).toContain('09:00 - 10:30 | Untitled meeting');
    expect(out?.text).toContain("See today's meetings: https://ludy.test/o/acme/meetings");
    expect(out?.text).toContain('Attendees: 1 invitee; Org readers: Alice (+1 more)');
    expect(out?.text).toContain('Decisions from previous meeting:\n  - Approve Q4 discount tiers');
    expect(out?.text).toContain('Send signed addendum (Yours, Overdue, Due 2026-11-24)');
    expect(out?.text).toContain('Acme Renewal (Proposal | 15,000,000 VND | Expected close 2026-12-15)');
    expect(out?.text).toContain('Open deals: https://ludy.test/o/acme/deals');
    expect(out?.text).toContain('Vy prep lines:\n  - Confirm pricing tier before the call.');
    expect(out?.text).toContain('16:00 - 16:45 | Engineering Sync');
    expect(out?.text).toContain('Open meeting: https://ludy.test/o/acme/meetings/record');
    expect(out?.text).toContain('Turn this notice off in Notification settings: https://ludy.test/o/acme/settings/notifications');
  });

  it('formats large decimal-string CRM amounts without JS float precision loss and handles nullable amount', () => {
    const largeAmount = '9007199254740993.25';
    const eighteenDigitAmount = '123456789012345678.99';
    const vi = renderMorningBriefingMail(
      briefingMail({ lang: 'vi' }),
      briefingContent({
        meetings: [
          sampleMeeting({
            vyLines: undefined,
            deals: [
              { id: DEAL_ID, title: 'Deal Lớn', stage: 'Báo giá', amount: largeAmount, expectedClose: null },
              { id: '22222222-2222-4222-8222-222222222222', title: 'Deal Tối Đa', stage: 'Mới', amount: eighteenDigitAmount, expectedClose: null },
              { id: '33333333-3333-4333-8333-333333333333', title: 'Deal Chưa Chốt Giá', stage: 'Mới', amount: null, expectedClose: '2026-12-01' },
            ],
          }),
        ],
      }),
      briefingCtx(),
    );
    expect(vi?.text).toContain('9.007.199.254.740.993,25 đồng');
    expect(vi?.text).toContain('123.456.789.012.345.678,99 đồng');
    expect(vi?.text).toContain('Deal Chưa Chốt Giá (Mới | Dự kiến chốt 01/12/2026)');
    expect(vi?.html).toContain('9.007.199.254.740.993,25 đồng');

    const en = renderMorningBriefingMail(
      briefingMail({ lang: 'en' }),
      briefingContent({
        meetings: [
          sampleMeeting({
            vyLines: undefined,
            deals: [
              { id: DEAL_ID, title: 'Large Deal', stage: 'Proposal', amount: largeAmount, expectedClose: null },
              { id: '22222222-2222-4222-8222-222222222222', title: 'Max Deal', stage: 'New', amount: eighteenDigitAmount, expectedClose: null },
            ],
          }),
        ],
      }),
      briefingCtx({ subject: 'Morning briefing' }),
    );
    expect(en?.text).toContain('9,007,199,254,740,993.25 VND');
    expect(en?.text).toContain('123,456,789,012,345,678.99 VND');
  });

  it('omits Vy prep lines section cleanly when vyLines is undefined or empty (AI-off facts-only)', () => {
    const viOff = renderMorningBriefingMail(
      briefingMail({ lang: 'vi' }),
      briefingContent({
        totalMeetings: 2,
        meetings: [
          sampleMeeting({ vyLines: undefined }),
          sampleMeeting({ id: '22222222-2222-4222-8222-222222222222', vyLines: [] }),
        ],
      }),
      briefingCtx(),
    );
    expect(viOff?.text).not.toContain('Vy');
    expect(viOff?.html).not.toContain('Vy');
    expect(viOff?.text).toContain('Quyết định từ cuộc họp trước');
    expect(viOff?.text).toContain('Việc cần làm còn mở');
    expect(viOff?.text).toContain('Cơ hội CRM đang mở');

    const enOff = renderMorningBriefingMail(
      briefingMail({ lang: 'en' }),
      briefingContent({ meetings: [sampleMeeting({ vyLines: undefined })] }),
      briefingCtx({ subject: 'Morning briefing' }),
    );
    expect(enOff?.text).not.toContain('Vy');
    expect(enOff?.html).not.toContain('Vy');
    expect(enOff?.text).toContain('Decisions from previous meeting');
  });

  it('renders up to vyMeetingsMax and vyLinesPerMeetingMax cleanly', () => {
    const meetings = Array.from({ length: 7 }, (_, idx) =>
      sampleMeeting({
        id: `00000000-0000-4000-8000-00000000000${idx + 1}`,
        title: `Meeting ${idx + 1}`,
        vyLines: idx < MORNING_BRIEFING_CAPS.vyMeetingsMax ? ['Line A', 'Line B', 'Line C'] : undefined,
      }),
    );
    const out = renderMorningBriefingMail(
      briefingMail({ lang: 'en' }),
      briefingContent({ totalMeetings: 7, meetings }),
      briefingCtx({ subject: 'Morning briefing' }),
    );
    expect(out?.text.match(/Vy prep lines:/g)).toHaveLength(MORNING_BRIEFING_CAPS.vyMeetingsMax);
    expect(out?.text).toContain('Line C');
  });

  it('escapes HTML/XSS across every dynamic field and strips bidi/control characters', () => {
    const xss = '<script>alert("x")</script> & \'test\'';
    const bidi = 'Clean\u202e\u200b\u0007\u2028\r\nText';
    const out = renderMorningBriefingMail(
      briefingMail({ lang: 'vi', org: `Org ${xss} ${bidi}` }),
      briefingContent({
        meetings: [
          sampleMeeting({
            title: `Title ${xss} ${bidi}`,
            readerNames: [`Reader ${xss} ${bidi}`],
            previousDecisions: [`Decision ${xss} ${bidi}`],
            openItems: [{ text: `Item ${xss} ${bidi}`, dueOn: '2026-11-26', overdue: false, mine: true }],
            deals: [{ id: DEAL_ID, title: `Deal ${xss} ${bidi}`, stage: `Stage ${xss} ${bidi}`, amount: '1000', expectedClose: '2026-12-01' }],
            vyLines: [`Vy ${xss} ${bidi}`],
          }),
        ],
      }),
      briefingCtx({
        subject: `Subject\u202e\r\nBcc: evil@example.com`,
        brand: `Brand ${xss} ${bidi}`,
      }),
    );

    expect(out).not.toBeNull();
    expect(out?.subject).toBe('Subject Bcc: evil@example.com');
    expect(out?.subject).not.toMatch(/[\p{Cc}\p{Cf}\u2028]/u);
    expect(out?.text).not.toMatch(/[\u202e\u200b\u2028]/);
    expect(out?.text).not.toContain('\u0007');
    expect(out?.html).not.toMatch(/[\u202e\u200b\u2028]/);
    expect(out?.html).not.toContain('\u0007');
    expect(out?.html).not.toContain('<script>');
    expect(out?.html).not.toContain('</script>');
    for (const prefix of ['Org', 'Brand', 'Title', 'Reader', 'Decision', 'Item', 'Deal', 'Stage', 'Vy']) {
      expect(out?.html).toContain(`${prefix} &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;test&#39; Clean Text`);
    }
  });

  it('formats overnight meetings across midnight cleanly in the meeting timeZone', () => {
    const out = renderMorningBriefingMail(
      briefingMail({ lang: 'vi' }),
      briefingContent({
        meetings: [
          sampleMeeting({
            startAt: '2026-11-26T23:30:00+07:00',
            endAt: '2026-11-27T00:30:00+07:00',
            timeZone: 'Asia/Ho_Chi_Minh',
            vyLines: undefined,
          }),
        ],
      }),
      briefingCtx(),
    );
    expect(out?.text).toContain('26/11/2026 23:30 - 27/11/2026 00:30 | Họp giao ban tuần');
  });

  it('renders clean zero-meetings state and truncated-day indicator', () => {
    const emptyVi = renderMorningBriefingMail(
      briefingMail({ lang: 'vi' }),
      briefingContent({ totalMeetings: 0, meetings: [] }),
      briefingCtx(),
    );
    expect(emptyVi?.text).toContain('Hôm nay bạn không có cuộc họp nào trong lịch.');
    expect(emptyVi?.text).not.toContain('Đang hiển thị');
    expect(emptyVi?.text).toContain('https://ludy.test/o/acme/meetings');
    expect(emptyVi?.text).toContain('https://ludy.test/o/acme/settings/notifications');

    const emptyEn = renderMorningBriefingMail(
      briefingMail({ lang: 'en' }),
      briefingContent({ totalMeetings: 0, meetings: [] }),
      briefingCtx({ subject: 'Morning briefing' }),
    );
    expect(emptyEn?.text).toContain('You have no meetings scheduled today.');
    expect(emptyEn?.text).not.toContain('Showing the first');

    const truncatedEn = renderMorningBriefingMail(
      briefingMail({ lang: 'en' }),
      briefingContent({
        totalMeetings: 15,
        meetings: Array.from({ length: 12 }, (_, idx) =>
          sampleMeeting({
            id: `00000000-0000-4000-8000-0000000000${String(idx + 1).padStart(2, '0')}`,
            vyLines: undefined,
          }),
        ),
      }),
      briefingCtx({ subject: 'Morning briefing' }),
    );
    expect(truncatedEn?.text).toContain('You have 15 meetings today.');
    expect(truncatedEn?.text).toContain('Showing the first 12 of 15 meetings.');

    const truncatedVi = renderMorningBriefingMail(
      briefingMail({ lang: 'vi' }),
      briefingContent({ totalMeetings: 3, meetings: [] }),
      briefingCtx(),
    );
    expect(truncatedVi?.text).toContain('Hôm nay bạn có 3 cuộc họp.');
    expect(truncatedVi?.text).toContain('Mở trang Cuộc họp để xem chi tiết 3 cuộc họp hôm nay.');
  });

  it('returns null on blank/missing subject and rejects invalid paths, mismatched day, cap breaches, numeric amount, and rogue fields', () => {
    expect(renderMorningBriefingMail(briefingMail(), briefingContent(), briefingCtx({ subject: null }))).toBeNull();
    expect(renderMorningBriefingMail(briefingMail(), briefingContent(), briefingCtx({ subject: '   ' }))).toBeNull();
    expect(renderMorningBriefingMail(briefingMail(), briefingContent(), briefingCtx({ subject: '\u202e\n\t ' }))).toBeNull();

    // v1 count-only mail payload rejected by v2 briefing renderer.
    expect(() => renderMorningBriefingMail(base, briefingContent(), briefingCtx())).toThrow();
    // Invalid mail path or cross-org meeting path.
    expect(() =>
      renderMorningBriefingMail(briefingMail({ path: 'https://evil.test/o/acme/meetings' }), briefingContent(), briefingCtx()),
    ).toThrow();
    expect(() =>
      renderMorningBriefingMail(
        briefingMail({ path: '/o/acme/meetings' }),
        briefingContent({ meetings: [sampleMeeting({ path: `/o/other/meetings/${ID}` })] }),
        briefingCtx(),
      ),
    ).toThrow();
    expect(() =>
      renderMorningBriefingMail(
        briefingMail(),
        briefingContent({ meetings: [sampleMeeting({ path: '/o/acme/meetings/../admin' })] }),
        briefingCtx(),
      ),
    ).toThrow();
    // Invalid publicUrl protocol or control chars.
    expect(() =>
      renderMorningBriefingMail(briefingMail(), briefingContent(), briefingCtx({ publicUrl: 'javascript:alert(1)' })),
    ).toThrow();
    expect(() =>
      renderMorningBriefingMail(briefingMail(), briefingContent(), briefingCtx({ publicUrl: 'https://ludy.test\n' })),
    ).toThrow();
    // Day mismatch between stored payload and render-time content.
    expect(() =>
      renderMorningBriefingMail(briefingMail({ day: '2026-11-26' }), briefingContent({ day: '2026-11-27' }), briefingCtx()),
    ).toThrow();
    // > vyMeetingsMax meetings with vyLines.
    expect(() =>
      renderMorningBriefingMail(
        briefingMail(),
        briefingContent({
          totalMeetings: 6,
          meetings: Array.from({ length: 6 }, () => sampleMeeting({ vyLines: ['Prep line'] })),
        }),
        briefingCtx(),
      ),
    ).toThrow();
    // Numeric money amount.
    expect(() =>
      renderMorningBriefingMail(
        briefingMail(),
        briefingContent({
          meetings: [sampleMeeting({ deals: [{ id: DEAL_ID, title: 'Deal', stage: 'Mới', amount: 15000000 }] })],
        }),
        briefingCtx(),
      ),
    ).toThrow();
    // Rogue external invitee names field refused.
    expect(() =>
      renderMorningBriefingMail(
        briefingMail(),
        briefingContent({
          meetings: [sampleMeeting({ inviteeNames: ['External Guest'] })],
        }),
        briefingCtx(),
      ),
    ).toThrow();
  });
});
