// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for deterministic Vietnamese/English Quick Add parser (#3556).
import { describe, expect, it } from 'vitest';
import { buildTitleWithoutSpans, parseTodoQuickAdd } from '../src/index.ts';

const VN_TZ = 'Asia/Ho_Chi_Minh';
// Tuesday 2026-11-17 08:00:00 +07:00
const TUE_MORNING = new Date('2026-11-17T08:00:00+07:00');
// Tuesday 2026-11-17 16:00:00 +07:00
const TUE_AFTERNOON = new Date('2026-11-17T16:00:00+07:00');

describe('parseTodoQuickAdd (#3556)', () => {
  it('parses Vietnamese dates with and without diacritics', () => {
    const todayRes = parseTodoQuickAdd('Gửi báo cáo hôm nay', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(todayRes.title).toBe('Gửi báo cáo');
    expect(todayRes.dueOn).toBe('2026-11-17');
    expect(todayRes.dueTime).toBeNull();
    expect(todayRes.dueAt).toBeNull();
    expect(todayRes.remindAt).toBeNull();

    const noDiacriticToday = parseTodoQuickAdd('Gui bao cao hom nay', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(noDiacriticToday.title).toBe('Gui bao cao');
    expect(noDiacriticToday.dueOn).toBe('2026-11-17');

    const tmrRes = parseTodoQuickAdd('Gọi khách ngày mai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(tmrRes.title).toBe('Gọi khách');
    expect(tmrRes.dueOn).toBe('2026-11-18');

    const bareMai = parseTodoQuickAdd('Nộp hồ sơ mai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(bareMai.title).toBe('Nộp hồ sơ');
    expect(bareMai.dueOn).toBe('2026-11-18');

    const dayAfter1 = parseTodoQuickAdd('Kiểm kho ngày kia', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(dayAfter1.title).toBe('Kiểm kho');
    expect(dayAfter1.dueOn).toBe('2026-11-19');

    const dayAfter2 = parseTodoQuickAdd('Kiểm kho mốt', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(dayAfter2.title).toBe('Kiểm kho');
    expect(dayAfter2.dueOn).toBe('2026-11-19');

    const dayAfterNoMark = parseTodoQuickAdd('Kiem kho ngay mot', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(dayAfterNoMark.title).toBe('Kiem kho');
    expect(dayAfterNoMark.dueOn).toBe('2026-11-19');
  });

  it('parses Vietnamese and English weekdays, shorthands, and next-week modifiers', () => {
    // Today is Tuesday 2026-11-17
    expect(parseTodoQuickAdd('Họp thứ sáu', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-20');
    expect(parseTodoQuickAdd('Hop thu sau', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-20');
    expect(parseTodoQuickAdd('Họp t6', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-20');
    expect(parseTodoQuickAdd('Họp thứ hai', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-23');
    expect(parseTodoQuickAdd('Họp chủ nhật', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-22');
    expect(parseTodoQuickAdd('Hop chu nhat', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-22');
    expect(parseTodoQuickAdd('Họp cn', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-22');
    expect(parseTodoQuickAdd('Họp thứ bảy', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-21');
    expect(parseTodoQuickAdd('Họp thứ bẩy', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-21');

    // Next week expressions
    const nextFri = parseTodoQuickAdd('Họp thứ sáu tuần sau', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nextFri.title).toBe('Họp');
    expect(nextFri.dueOn).toBe('2026-11-27');

    const nextMon = parseTodoQuickAdd('Sync next monday', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nextMon.title).toBe('Sync');
    expect(nextMon.dueOn).toBe('2026-11-23');

    const nextFriEn = parseTodoQuickAdd('Sync next friday', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nextFriEn.dueOn).toBe('2026-11-27');

    const tuanSauThuHai = parseTodoQuickAdd('tuần sau thứ hai gửi hóa đơn', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(tuanSauThuHai.title).toBe('gửi hóa đơn');
    expect(tuanSauThuHai.dueOn).toBe('2026-11-23');
  });

  it('parses times of day, clock formats, and timezone-accurate dueAt/remindAt offsets', () => {
    const sangMai = parseTodoQuickAdd('Gọi anh Nam sáng mai 9h', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(sangMai.title).toBe('Gọi anh Nam');
    expect(sangMai.dueOn).toBe('2026-11-18');
    expect(sangMai.dueTime).toBe('09:00');
    expect(sangMai.dueAt).toBe('2026-11-18T09:00:00+07:00');
    expect(sangMai.remindAt).toBe('2026-11-18T08:30:00+07:00');

    const chieuThuSau = parseTodoQuickAdd('Họp chiều thứ sáu', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(chieuThuSau.title).toBe('Họp');
    expect(chieuThuSau.dueOn).toBe('2026-11-20');
    expect(chieuThuSau.dueTime).toBe('14:00');
    expect(chieuThuSau.dueAt).toBe('2026-11-20T14:00:00+07:00');
    expect(chieuThuSau.remindAt).toBe('2026-11-20T13:30:00+07:00');

    const chieu3h = parseTodoQuickAdd('Gặp khách 3h chiều mai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(chieu3h.title).toBe('Gặp khách');
    expect(chieu3h.dueOn).toBe('2026-11-18');
    expect(chieu3h.dueTime).toBe('15:00');

    const toiNay8h = parseTodoQuickAdd('Thanh toán tối nay 8h', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(toiNay8h.title).toBe('Thanh toán');
    expect(toiNay8h.dueOn).toBe('2026-11-17');
    expect(toiNay8h.dueTime).toBe('20:00');

    const enAmPm = parseTodoQuickAdd('Call supplier tomorrow 2:30pm', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(enAmPm.title).toBe('Call supplier');
    expect(enAmPm.dueOn).toBe('2026-11-18');
    expect(enAmPm.dueTime).toBe('14:30');
    expect(enAmPm.dueAt).toBe('2026-11-18T14:30:00+07:00');

    const customRemind = parseTodoQuickAdd('Họp 9h30 ngày mai', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
      defaultRemindBeforeMinutes: 15,
    });
    expect(customRemind.dueTime).toBe('09:30');
    expect(customRemind.remindAt).toBe('2026-11-18T09:15:00+07:00');
  });

  it('handles explicit dates, year boundaries, date rollovers, and DST transitions', () => {
    // 25/11 is later in 2026; 10/01 already passed in 2026 so rolls to 2027
    const dmy = parseTodoQuickAdd('Nộp tờ khai 25/11 14:30', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(dmy.title).toBe('Nộp tờ khai');
    expect(dmy.dueOn).toBe('2026-11-25');
    expect(dmy.dueTime).toBe('14:30');

    const janRollover = parseTodoQuickAdd('Kê khai đầu năm 10/01', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(janRollover.dueOn).toBe('2027-01-10');

    const fullDmy = parseTodoQuickAdd('Quyết toán 31/03/2027', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(fullDmy.dueOn).toBe('2027-03-31');

    const isoDate = parseTodoQuickAdd('Submit report 2027-01-05 9am', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(isoDate.title).toBe('Submit report');
    expect(isoDate.dueOn).toBe('2027-01-05');
    expect(isoDate.dueTime).toBe('09:00');

    // Leap day rolls forward to 2028-02-29; invalid dates are ignored
    expect(parseTodoQuickAdd('Check 29/02', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2028-02-29');
    const invalidDate = parseTodoQuickAdd('Check 31/02 and 29/02/2026', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(invalidDate.dueOn).toBeNull();
    expect(invalidDate.tokens).toEqual([]);

    // Midnight & year boundary across timezones: 2026-12-31T20:00:00Z is 2027-01-01 03:00 in VN, 2026-12-31 15:00 in NY
    const nyeUtc = new Date('2026-12-31T20:00:00Z');
    expect(parseTodoQuickAdd('Họp hôm nay', { now: nyeUtc, timeZone: 'Asia/Ho_Chi_Minh' }).dueOn).toBe('2027-01-01');
    expect(parseTodoQuickAdd('Meeting today', { now: nyeUtc, timeZone: 'America/New_York' }).dueOn).toBe('2026-12-31');
    expect(parseTodoQuickAdd('Meeting tomorrow', { now: nyeUtc, timeZone: 'America/New_York' }).dueOn).toBe('2027-01-01');

    // Time-only rollover when 9h has already passed at 16:00
    const timeRollover = parseTodoQuickAdd('Gọi khách 9h', { now: TUE_AFTERNOON, timeZone: VN_TZ });
    expect(timeRollover.dueOn).toBe('2026-11-18');
    expect(timeRollover.dueTime).toBe('09:00');

    // Explicit "hôm nay 9h" keeps today even at 16:00
    const explicitToday = parseTodoQuickAdd('Gọi khách hôm nay 9h', { now: TUE_AFTERNOON, timeZone: VN_TZ });
    expect(explicitToday.dueOn).toBe('2026-11-17');

    // DST fall-back day in America/New_York (2026-11-01)
    const dstFallBack = parseTodoQuickAdd('Pay rent today 9am', {
      now: new Date('2026-11-01T01:30:00-04:00'),
      timeZone: 'America/New_York',
    });
    expect(dstFallBack.dueOn).toBe('2026-11-01');
    expect(dstFallBack.dueAt).toBe('2026-11-01T09:00:00-05:00');
    expect(dstFallBack.remindAt).toBe('2026-11-01T08:30:00-05:00');
  });

  it('parses recurrence hints in Vietnamese and English', () => {
    const dailyVn = parseTodoQuickAdd('Kiểm tra tồn kho mỗi ngày 8h', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(dailyVn.title).toBe('Kiểm tra tồn kho');
    expect(dailyVn.recurrence).toEqual({ freq: 'daily', interval: 1 });
    expect(dailyVn.dueTime).toBe('08:00');
    expect(dailyVn.dueOn).toBe('2026-11-17');

    expect(parseTodoQuickAdd('Check inbox hang ngay', { now: TUE_MORNING, timeZone: VN_TZ }).recurrence).toEqual({
      freq: 'daily',
      interval: 1,
    });
    expect(parseTodoQuickAdd('Standup every day 9am', { now: TUE_MORNING, timeZone: VN_TZ }).recurrence).toEqual({
      freq: 'daily',
      interval: 1,
    });

    const weeklyVn = parseTodoQuickAdd('Họp giao ban hàng tuần thứ hai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(weeklyVn.title).toBe('Họp giao ban');
    expect(weeklyVn.recurrence).toEqual({ freq: 'weekly', interval: 1, byWeekday: 1 });
    expect(weeklyVn.dueOn).toBe('2026-11-23');

    const weeklyEn = parseTodoQuickAdd('Weekly review every friday', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(weeklyEn.title).toBe('Weekly review');
    expect(weeklyEn.recurrence).toEqual({ freq: 'weekly', interval: 1, byWeekday: 5 });
    expect(weeklyEn.dueOn).toBe('2026-11-20');

    const monthlyDay = parseTodoQuickAdd('Nộp thuế ngày 20 hàng tháng', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(monthlyDay.title).toBe('Nộp thuế');
    expect(monthlyDay.recurrence).toEqual({ freq: 'monthly', interval: 1, byMonthDay: 20 });
    expect(monthlyDay.dueOn).toBe('2026-11-20');

    const eom = parseTodoQuickAdd('Chốt sổ cuối tháng !p1', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(eom.title).toBe('Chốt sổ');
    expect(eom.recurrence).toEqual({ freq: 'monthly', interval: 1, byMonthDay: -1 });
    expect(eom.dueOn).toBe('2026-11-30');
    expect(eom.priority).toBe(1);

    const eomEn = parseTodoQuickAdd('Close books last day of month', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(eomEn.title).toBe('Close books');
    expect(eomEn.recurrence).toEqual({ freq: 'monthly', interval: 1, byMonthDay: -1 });

    const standupDaily = parseTodoQuickAdd('Standup daily 9am', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(standupDaily.title).toBe('Standup');
    expect(standupDaily.recurrence).toEqual({ freq: 'daily', interval: 1 });
    expect(standupDaily.dueTime).toBe('09:00');

    const monthlyClose = parseTodoQuickAdd('Monthly close', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(monthlyClose.title).toBe('Monthly close');
    expect(monthlyClose.recurrence).toBeNull();
  });

  it('parses priorities, #tags, and /List without colliding with dd/mm or URLs', () => {
    const complex = parseTodoQuickAdd(
      'Kiểm tra https://ludy.vn/2026/11/25#sec-1 25/11 14:30 !P2 #ke-toan #Q4 /"Việc riêng"',
      { now: TUE_MORNING, timeZone: VN_TZ },
    );
    expect(complex.title).toBe('Kiểm tra https://ludy.vn/2026/11/25#sec-1');
    expect(complex.dueOn).toBe('2026-11-25');
    expect(complex.dueTime).toBe('14:30');
    expect(complex.priority).toBe(2);
    expect(complex.tags).toEqual(['ke-toan', 'q4']);
    expect(complex.listName).toBe('Việc riêng');

    const dmyVsList = parseTodoQuickAdd('Nộp hồ sơ 25/11 /CongViec', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(dmyVsList.title).toBe('Nộp hồ sơ');
    expect(dmyVsList.dueOn).toBe('2026-11-25');
    expect(dmyVsList.listName).toBe('CongViec');

    // Pure numeric #3556 and Unix-style /etc/hosts stay in title
    const nonTags = parseTodoQuickAdd('Xem issue #3556 tại /etc/hosts hoặc a / b #urgent', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
    });
    expect(nonTags.title).toBe('Xem issue #3556 tại /etc/hosts hoặc a / b');
    expect(nonTags.tags).toEqual(['urgent']);
    expect(nonTags.listName).toBeNull();
  });

  it('avoids Vietnamese vocabulary false positives', () => {
    const cases = [
      'Nộp tờ khai thuế',
      'Kiểm tra hóa đơn nhà cung cấp',
      'Gọi khách xin sao kê',
      'Gửi báo cáo cho tôi ngay',
      'Làm một lần thứ hai xem sao',
      'Chương trình khuyen mai thu tiền',
      'Thiết kế sáng tạo và tối ưu trang chủ',
      'Mua đồ ăn sáng và cơm trưa',
      'Kiểm tra chiều dài và chiều rộng',
      'Gặp chị Mai xem hợp đồng',
    ];
    for (const input of cases) {
      const parsed = parseTodoQuickAdd(input, { now: TUE_MORNING, timeZone: VN_TZ });
      expect(parsed.tokens, input).toEqual([]);
      expect(parsed.title, input).toBe(input);
      expect(parsed.dueOn, input).toBeNull();
      expect(parsed.dueTime, input).toBeNull();
    }
  });

  it('restores exact original token text when any chip is dismissed', () => {
    const input = 'Gọi khách, Ngày Mai! 9h30 !P1 #Sales /"Việc riêng"';
    const first = parseTodoQuickAdd(input, { now: TUE_MORNING, timeZone: VN_TZ });
    expect(first.title).toBe('Gọi khách!');
    expect(first.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['date', 'Ngày Mai'],
      ['time', '9h30'],
      ['priority', '!P1'],
      ['tag', '#Sales'],
      ['list', '/"Việc riêng"'],
    ]);

    // Verify exact span integrity
    for (const tok of first.tokens) {
      expect(input.slice(tok.start, tok.end)).toBe(tok.raw);
    }

    // Dismissing the date token restores exact original casing "Ngày Mai" into the title
    const withoutDate = parseTodoQuickAdd(input, {
      now: TUE_MORNING,
      timeZone: VN_TZ,
      dismissedTokens: [first.tokens[0]!],
    });
    expect(withoutDate.title).toContain('Ngày Mai');
    expect(withoutDate.dueTime).toBe('09:30');
    expect(withoutDate.tokens.some((t) => t.kind === 'date')).toBe(false);

    // Dismissing all tokens restores the exact original input string
    const withoutAll = parseTodoQuickAdd(input, {
      now: TUE_MORNING,
      timeZone: VN_TZ,
      dismissedTokens: first.tokens,
    });
    expect(withoutAll.title).toBe(input);
    expect(withoutAll.tokens).toEqual([]);
    expect(withoutAll.dueOn).toBeNull();
    expect(withoutAll.dueTime).toBeNull();
    expect(withoutAll.priority).toBeNull();
    expect(withoutAll.tags).toEqual([]);
    expect(withoutAll.listName).toBeNull();

    // Dismissing time in "sáng mai 9h" does not leave phantom 09:00 from "sáng"
    const sangMaiClock = parseTodoQuickAdd('Họp sáng mai 9h', { now: TUE_MORNING, timeZone: VN_TZ });
    const timeTok = sangMaiClock.tokens.find((t) => t.kind === 'time')!;
    const afterDismissTime = parseTodoQuickAdd('Họp sáng mai 9h', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
      dismissedTokens: [timeTok],
    });
    expect(afterDismissTime.dueOn).toBe('2026-11-18');
    expect(afterDismissTime.dueTime).toBeNull();
    expect(afterDismissTime.title).toBe('Họp 9h');

    // Non-date tokens stay intact when only date/time spans are stripped for pre-V2-1/V2-3 persistence
    const dateTimeSpans = first.tokens.filter((t) => t.kind === 'date' || t.kind === 'time');
    expect(buildTitleWithoutSpans(input, dateTimeSpans)).toBe('Gọi khách! !P1 #Sales /"Việc riêng"');
  });

  it('runs synchronously in well under 5ms per parse', () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      parseTodoQuickAdd('Nộp báo cáo thuế ngày 20 hàng tháng 9h30 !p1 #thue /KeToan https://ludy.vn/#ok', {
        now: TUE_MORNING,
        timeZone: VN_TZ,
      });
    }
    const avgMs = (performance.now() - start) / 100;
    expect(avgMs).toBeLessThan(5);
  });

  it('handles NFD decomposed Vietnamese text and preserves exact input spans', () => {
    const nfd = 'Gọi khách ngày mai 9h #thuế'.normalize('NFD');
    const res = parseTodoQuickAdd(nfd, { now: TUE_MORNING, timeZone: VN_TZ });
    expect(res.dueOn).toBe('2026-11-18');
    expect(res.dueTime).toBe('09:00');
    expect(res.tags).toEqual(['thuế']);
    for (const tok of res.tokens) {
      expect(nfd.slice(tok.start, tok.end)).toBe(tok.raw);
    }
  });

  it('keeps VN clocks followed by dates or counts separate and ignores dates embedded in identifiers', () => {
    const shortClockThenDate = parseTodoQuickAdd('Họp 9h 25/11', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(shortClockThenDate.dueOn).toBe('2026-11-25');
    expect(shortClockThenDate.dueTime).toBe('09:00');
    expect(shortClockThenDate.title).toBe('Họp');

    const longClockThenDate = parseTodoQuickAdd('Họp 9 giờ 25/11', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(longClockThenDate.dueOn).toBe('2026-11-25');
    expect(longClockThenDate.dueTime).toBe('09:00');
    expect(longClockThenDate.title).toBe('Họp');

    const clockThenCount = parseTodoQuickAdd('Mua 9h 2 người', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(clockThenCount.dueTime).toBe('09:00');
    expect(clockThenCount.title).toBe('Mua 2 người');

    const contractCode = parseTodoQuickAdd('Ký HD25/11/2026 ngày mai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(contractCode.dueOn).toBe('2026-11-18');
    expect(contractCode.title).toBe('Ký HD25/11/2026');
  });

  it('supports separate time dismissal on tối nay and tomorrow morning', () => {
    const toiNay = parseTodoQuickAdd('Họp tối nay', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(toiNay.dueOn).toBe('2026-11-17');
    expect(toiNay.dueTime).toBe('19:00');
    const toiNayTime = toiNay.tokens.find((t) => t.kind === 'time')!;
    const toiNayNoTime = parseTodoQuickAdd('Họp tối nay', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
      dismissedTokens: [toiNayTime],
    });
    expect(toiNayNoTime.dueOn).toBe('2026-11-17');
    expect(toiNayNoTime.dueTime).toBeNull();
    expect(toiNayNoTime.title).toBe('Họp tối');
    expect(toiNayNoTime.tokens.map((t) => [t.kind, t.raw])).toEqual([['date', 'nay']]);

    const tmrMorning = parseTodoQuickAdd('Call tomorrow morning', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(tmrMorning.dueOn).toBe('2026-11-18');
    expect(tmrMorning.dueTime).toBe('09:00');
    expect(tmrMorning.title).toBe('Call');
    expect(tmrMorning.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['date', 'tomorrow'],
      ['time', 'morning'],
    ]);

    const tmrNoTime = parseTodoQuickAdd('Call tomorrow morning', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
      dismissedTokens: [tmrMorning.tokens.find((t) => t.kind === 'time')!],
    });
    expect(tmrNoTime.dueOn).toBe('2026-11-18');
    expect(tmrNoTime.dueTime).toBeNull();
    expect(tmrNoTime.title).toBe('Call morning');

    const tmrNoDate = parseTodoQuickAdd('Call tomorrow morning', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
      dismissedTokens: [tmrMorning.tokens.find((t) => t.kind === 'date')!],
    });
    expect(tmrNoDate.dueOn).toBeNull();
    expect(tmrNoDate.dueTime).toBeNull();
    expect(tmrNoDate.title).toBe('Call tomorrow morning');
  });

  it('handles VN clock+period with nay, avoids thu/sat/toi false positives, and strips empty parens', () => {
    const morningToday = parseTodoQuickAdd('Họp 9h sáng nay', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(morningToday.title).toBe('Họp');
    expect(morningToday.dueOn).toBe('2026-11-17');
    expect(morningToday.dueTime).toBe('09:00');
    expect(morningToday.tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['time', '9h sáng'],
      ['date', 'nay'],
    ]);

    // Must not roll to tomorrow when "nay" explicitly anchors today
    const pastClockToday = parseTodoQuickAdd('Họp 9h sáng nay', { now: TUE_AFTERNOON, timeZone: VN_TZ });
    expect(pastClockToday.dueOn).toBe('2026-11-17');
    expect(pastClockToday.title).toBe('Họp');

    const chieuNay = parseTodoQuickAdd('Họp 3h chiều nay', { now: TUE_AFTERNOON, timeZone: VN_TZ });
    expect(chieuNay.dueOn).toBe('2026-11-17');
    expect(chieuNay.dueTime).toBe('15:00');
    expect(chieuNay.title).toBe('Họp');

    // Vietnamese words next to VN clocks or VN recurrence must not trigger English thu/sat
    const thuTien = parseTodoQuickAdd('9h sáng thu tiền', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(thuTien.title).toBe('thu tiền');
    expect(thuTien.dueTime).toBe('09:00');
    expect(thuTien.dueOn).toBe('2026-11-17');

    const satHach = parseTodoQuickAdd('9h sat hach', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(satHach.title).toBe('sat hach');
    expect(satHach.dueTime).toBe('09:00');

    const weeklyThuTien = parseTodoQuickAdd('Mỗi tuần thu tiền', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(weeklyThuTien.recurrence).toEqual({ freq: 'weekly', interval: 1 });
    expect(weeklyThuTien.title).toBe('thu tiền');

    // English short weekdays still work in English clock / on / every context
    expect(parseTodoQuickAdd('Call 9am thu', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-19');
    expect(parseTodoQuickAdd('Call at 2:30 thu', { now: TUE_MORNING, timeZone: VN_TZ }).dueOn).toBe('2026-11-19');
    expect(parseTodoQuickAdd('Every thu', { now: TUE_MORNING, timeZone: VN_TZ }).recurrence).toEqual({
      freq: 'weekly',
      interval: 1,
      byWeekday: 4,
    });

    // Unaccented "toi" after prepositions/verbs means "tôi" (me), not evening "tối"
    const choToi = parseTodoQuickAdd('Gui bao cao cho toi ngay mai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(choToi.title).toBe('Gui bao cao cho toi');
    expect(choToi.dueOn).toBe('2026-11-18');
    expect(choToi.dueTime).toBeNull();

    const nhacToi = parseTodoQuickAdd('Nhac toi ngay mai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nhacToi.title).toBe('Nhac toi');
    expect(nhacToi.dueOn).toBe('2026-11-18');
    expect(nhacToi.dueTime).toBeNull();

    const choToi9h = parseTodoQuickAdd('Gui cho toi 9h ngay mai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(choToi9h.title).toBe('Gui cho toi');
    expect(choToi9h.dueOn).toBe('2026-11-18');
    expect(choToi9h.dueTime).toBe('09:00');

    // Genuine unaccented evening phrases still work
    const hopToiNay = parseTodoQuickAdd('Hop toi nay', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(hopToiNay.title).toBe('Hop');
    expect(hopToiNay.dueOn).toBe('2026-11-17');
    expect(hopToiNay.dueTime).toBe('19:00');

    // Empty parentheses wrapping multiple stripped tokens collapse cleanly
    const parens = parseTodoQuickAdd('Họp (ngày mai 9h)', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(parens.title).toBe('Họp');
    expect(parens.dueOn).toBe('2026-11-18');
    expect(parens.dueTime).toBe('09:00');

    // English "every month on day <d>"
    const everyMonthDay = parseTodoQuickAdd('Pay rent every month on day 15', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(everyMonthDay.title).toBe('Pay rent');
    expect(everyMonthDay.recurrence).toEqual({ freq: 'monthly', interval: 1, byMonthDay: 15 });

    // Alphanumeric codes containing digits+h/am/colon must not extract fake clocks
    const codeWithClock = parseTodoQuickAdd('Kiểm tra mã AB9h', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(codeWithClock.title).toBe('Kiểm tra mã AB9h');
    expect(codeWithClock.dueTime).toBeNull();
    expect(codeWithClock.tokens).toEqual([]);
    expect(parseTodoQuickAdd('Kiểm tra mã V29am', { now: TUE_MORNING, timeZone: VN_TZ }).dueTime).toBeNull();

    // Long VN clock ("9 giờ") keeps trailing count quantities intact
    const longClockCount1 = parseTodoQuickAdd('Họp 9 giờ 2 người', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(longClockCount1.title).toBe('Họp 2 người');
    expect(longClockCount1.dueTime).toBe('09:00');

    const longClockCount2 = parseTodoQuickAdd('Họp 9 giờ 10 người', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(longClockCount2.title).toBe('Họp 10 người');
    expect(longClockCount2.dueTime).toBe('09:00');

    const longClockMinutes = parseTodoQuickAdd('Họp 9 giờ 5 phút', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(longClockMinutes.title).toBe('Họp');
    expect(longClockMinutes.dueTime).toBe('09:05');

    // NFD decomposed Vietnamese clocks, units, and alphanumeric code boundaries
    const nfdGioPhut = parseTodoQuickAdd('Họp 9 giờ 5 phút'.normalize('NFD'), { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nfdGioPhut.title).toBe('Họp');
    expect(nfdGioPhut.dueTime).toBe('09:05');

    const nfdGioCount = parseTodoQuickAdd('Họp 9 giờ 10 người'.normalize('NFD'), { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nfdGioCount.title).toBe('Họp 10 người');
    expect(nfdGioCount.dueTime).toBe('09:00');

    const nfdRuoi = parseTodoQuickAdd('Họp 9 giờ rưỡi'.normalize('NFD'), { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nfdRuoi.title).toBe('Họp');
    expect(nfdRuoi.dueTime).toBe('09:30');

    const nfdShortRuoi = parseTodoQuickAdd('Họp 9h rưỡi'.normalize('NFD'), { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nfdShortRuoi.title).toBe('Họp');
    expect(nfdShortRuoi.dueTime).toBe('09:30');

    const nfdCodeClock = parseTodoQuickAdd('Kiểm tra mã9h'.normalize('NFD'), { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nfdCodeClock.title).toBe('Kiểm tra mã9h'.normalize('NFD'));
    expect(nfdCodeClock.dueTime).toBeNull();

    const nfdCodeDate = parseTodoQuickAdd('Kiểm tra mã25/11'.normalize('NFD'), { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nfdCodeDate.title).toBe('Kiểm tra mã25/11'.normalize('NFD'));
    expect(nfdCodeDate.dueOn).toBeNull();

    // Relative durations are preserved intact rather than parsed as clock times
    const durSauNua = parseTodoQuickAdd('Gọi khách sau 2 giờ nữa', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(durSauNua.title).toBe('Gọi khách sau 2 giờ nữa');
    expect(durSauNua.dueTime).toBeNull();
    expect(durSauNua.dueOn).toBeNull();

    const durTrong = parseTodoQuickAdd('Làm báo cáo trong 2 giờ', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(durTrong.title).toBe('Làm báo cáo trong 2 giờ');
    expect(durTrong.dueTime).toBeNull();

    const durSau = parseTodoQuickAdd('Gọi khách sau 2 giờ', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(durSau.title).toBe('Gọi khách sau 2 giờ');
    expect(durSau.dueTime).toBeNull();

    // Next-week clock ("tuần sau 9h") still parses cleanly even though it contains "sau"
    const nextWeekClock = parseTodoQuickAdd('Họp tuần sau 9h', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(nextWeekClock.dueOn).toBe('2026-11-23');
    expect(nextWeekClock.dueTime).toBe('09:00');
    expect(nextWeekClock.title).toBe('Họp');

    // Time ranges keep both endpoints intact rather than stripping only one or producing "từ đến"
    const rangeDen = parseTodoQuickAdd('Họp từ 9h đến 10h ngày mai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(rangeDen.title).toBe('Họp từ 9h đến 10h');
    expect(rangeDen.dueOn).toBe('2026-11-18');
    expect(rangeDen.dueTime).toBeNull();

    const rangeDash = parseTodoQuickAdd('Họp 9h - 11h ngày mai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(rangeDash.title).toBe('Họp 9h - 11h');
    expect(rangeDash.dueOn).toBe('2026-11-18');
    expect(rangeDash.dueTime).toBeNull();

    // Multiple disconnected clocks keep only the first clock as dueTime without dropping the second
    const multiClock = parseTodoQuickAdd('Họp 9h ngày mai 10h', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(multiClock.dueOn).toBe('2026-11-18');
    expect(multiClock.dueTime).toBe('09:00');
    expect(multiClock.tokens.filter((t) => t.kind === 'time')).toHaveLength(1);
    expect(multiClock.title).toBe('Họp 10h');

    // Emails and filenames never leak inner date words/weekdays
    const emailInput = parseTodoQuickAdd('Gửi báo cáo cho mai@example.com', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(emailInput.title).toBe('Gửi báo cáo cho mai@example.com');
    expect(emailInput.dueOn).toBeNull();
    expect(emailInput.tokens).toEqual([]);

    const emailWithDate = parseTodoQuickAdd('Gửi báo cáo cho mai@example.com ngày mai 9h', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
    });
    expect(emailWithDate.title).toBe('Gửi báo cáo cho mai@example.com');
    expect(emailWithDate.dueOn).toBe('2026-11-18');
    expect(emailWithDate.dueTime).toBe('09:00');

    const fileInput = parseTodoQuickAdd('Xem file t6.pdf', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(fileInput.title).toBe('Xem file t6.pdf');
    expect(fileInput.dueOn).toBeNull();

    // Colon+AM/PM time ranges deduplicate overlapping matches cleanly
    const colonAmPmRange = parseTodoQuickAdd('Meeting 9:00am - 11:00am tomorrow', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
    });
    expect(colonAmPmRange.title).toBe('Meeting 9:00am - 11:00am');
    expect(colonAmPmRange.dueOn).toBe('2026-11-18');
    expect(colonAmPmRange.dueTime).toBeNull();

    // Short duration form ("sau 2h") stays intact without becoming 02:00 tomorrow
    const shortDurSau = parseTodoQuickAdd('Gọi khách sau 2h', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(shortDurSau.title).toBe('Gọi khách sau 2h');
    expect(shortDurSau.dueOn).toBeNull();
    expect(shortDurSau.dueTime).toBeNull();

    // Multi-date expressions keep full range/list intact, and disconnected second dates stay in title
    const multiDate = parseTodoQuickAdd('Họp 25/11 và 26/11', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(multiDate.title).toBe('Họp 25/11 và 26/11');
    expect(multiDate.dueOn).toBeNull();
    expect(multiDate.tokens).toEqual([]);

    const twoSeparateDates = parseTodoQuickAdd('Họp 25/11 thay cho ngày mai', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(twoSeparateDates.dueOn).toBe('2026-11-25');
    expect(twoSeparateDates.title).toBe('Họp thay cho ngày mai');
    expect(twoSeparateDates.tokens.filter((t) => t.kind === 'date')).toHaveLength(1);

    // English short durations ("in 2h", "after 2h") stay intact while "after 2pm" still parses
    const enDurIn = parseTodoQuickAdd('Call in 2h', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(enDurIn.title).toBe('Call in 2h');
    expect(enDurIn.dueOn).toBeNull();
    expect(enDurIn.dueTime).toBeNull();

    const enDurAfter = parseTodoQuickAdd('Call after 2h', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(enDurAfter.title).toBe('Call after 2h');
    expect(enDurAfter.dueTime).toBeNull();

    const enAfterPm = parseTodoQuickAdd('Call after 2pm tomorrow', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(enAfterPm.dueOn).toBe('2026-11-18');
    expect(enAfterPm.dueTime).toBe('14:00');

    // Quoted list names shield internal #tags and date words
    const quotedListProtected = parseTodoQuickAdd('Call /"Work #sales tomorrow"', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
    });
    expect(quotedListProtected.title).toBe('Call');
    expect(quotedListProtected.listName).toBe('Work #sales tomorrow');
    expect(quotedListProtected.tags).toEqual([]);
    expect(quotedListProtected.dueOn).toBeNull();

    // Underscore and hyphenated identifiers keep date/recurrence segments untouched
    const codeDash = parseTodoQuickAdd('Xem mã T2-123', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(codeDash.title).toBe('Xem mã T2-123');
    expect(codeDash.dueOn).toBeNull();

    const codeUnderscore = parseTodoQuickAdd('Review tomorrow_notes', { now: TUE_MORNING, timeZone: VN_TZ });
    expect(codeUnderscore.title).toBe('Review tomorrow_notes');
    expect(codeUnderscore.dueOn).toBeNull();

    // Skipped time ranges suppress inferred day-period default times (sáng nay -> date only, dueTime: null)
    const rangeWithPeriodToday = parseTodoQuickAdd('Họp 9:30 - 11:30 sáng nay', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
    });
    expect(rangeWithPeriodToday.title).toBe('Họp 9:30 - 11:30');
    expect(rangeWithPeriodToday.dueOn).toBe('2026-11-17');
    expect(rangeWithPeriodToday.dueTime).toBeNull();

    // "buổi chiều/sáng/tối" between date and clock adjusts AM/PM and strips cleanly
    const buoiBetweenDateClock = parseTodoQuickAdd('Họp ngày mai buổi chiều lúc 3 giờ', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
    });
    expect(buoiBetweenDateClock.title).toBe('Họp');
    expect(buoiBetweenDateClock.dueOn).toBe('2026-11-18');
    expect(buoiBetweenDateClock.dueTime).toBe('15:00');

    const buoiBetweenDmyClock = parseTodoQuickAdd('Họp ngày 25/11 buổi chiều lúc 3h', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
    });
    expect(buoiBetweenDmyClock.title).toBe('Họp');
    expect(buoiBetweenDmyClock.dueOn).toBe('2026-11-25');
    expect(buoiBetweenDmyClock.dueTime).toBe('15:00');

    const buoiBeforeDateAfterClock = parseTodoQuickAdd('Họp lúc 3h buổi chiều ngày mai', {
      now: TUE_MORNING,
      timeZone: VN_TZ,
    });
    expect(buoiBeforeDateAfterClock.title).toBe('Họp');
    expect(buoiBeforeDateAfterClock.dueOn).toBe('2026-11-18');
    expect(buoiBeforeDateAfterClock.dueTime).toBe('15:00');

    // Gram quantities ("20 g", "5g") are never misread as hours, while "9g30"/"lúc 9g"/"9g sáng" still parse
    expect(parseTodoQuickAdd('Mua 20 g bột', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Mua 20 g bột',
      dueTime: null,
      dueOn: null,
    });
    expect(parseTodoQuickAdd('Mua 5g vàng', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Mua 5g vàng',
      dueTime: null,
      dueOn: null,
    });
    expect(parseTodoQuickAdd('Họp lúc 9g ngày mai', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Họp',
      dueOn: '2026-11-18',
      dueTime: '09:00',
    });

    // Half-unit time ranges ("9-10h", "9-10am", "từ 9 đến 10 giờ") keep full range intact
    expect(parseTodoQuickAdd('Họp 9-10h ngày mai', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Họp 9-10h',
      dueOn: '2026-11-18',
      dueTime: null,
    });
    expect(parseTodoQuickAdd('Meeting 9-10am tomorrow', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Meeting 9-10am',
      dueOn: '2026-11-18',
      dueTime: null,
    });
    expect(parseTodoQuickAdd('Họp từ 9 đến 10 giờ ngày mai', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Họp từ 9 đến 10 giờ',
      dueOn: '2026-11-18',
      dueTime: null,
    });

    // Recipient name "Mai" is preserved without creating a fake tomorrow due date
    expect(parseTodoQuickAdd('Gửi báo cáo cho Mai', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Gửi báo cáo cho Mai',
      dueOn: null,
      dueTime: null,
    });
    expect(parseTodoQuickAdd('Gọi Mai 9h', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Gọi Mai',
      dueOn: '2026-11-17',
      dueTime: '09:00',
    });

    // Identifier boundaries around clocks ("9h_backup", "AB-9h", "TASK-14:30", "9h-backup") stay untouched
    expect(parseTodoQuickAdd('Kiểm tra mã 9h_backup', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Kiểm tra mã 9h_backup',
      dueOn: null,
      dueTime: null,
    });
    expect(parseTodoQuickAdd('Kiểm tra mã AB-9h', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Kiểm tra mã AB-9h',
      dueOn: null,
      dueTime: null,
    });
    expect(parseTodoQuickAdd('Xem TASK-14:30 và 9h-backup', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Xem TASK-14:30 và 9h-backup',
      dueOn: null,
      dueTime: null,
    });
    expect(parseTodoQuickAdd('Họp 9h-11h sáng ngày mai', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Họp 9h-11h',
      dueOn: '2026-11-18',
      dueTime: null,
    });
    expect(parseTodoQuickAdd('Họp 9h-11h sáng', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Họp 9h-11h sáng',
      dueOn: null,
      dueTime: null,
    });

    // 12h đêm / 12h tối mean midnight (00:00), whereas 12h trưa stays 12:00
    expect(parseTodoQuickAdd('Gọi khách ngày mai 12h đêm', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Gọi khách',
      dueOn: '2026-11-18',
      dueTime: '00:00',
      dueAt: '2026-11-18T00:00:00+07:00',
    });
    expect(parseTodoQuickAdd('Chốt sổ ngày mai 12h trưa', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Chốt sổ',
      dueOn: '2026-11-18',
      dueTime: '12:00',
      dueAt: '2026-11-18T12:00:00+07:00',
    });
    expect(parseTodoQuickAdd('Báo cáo 12h tối ngày mai', { now: TUE_MORNING, timeZone: VN_TZ })).toMatchObject({
      title: 'Báo cáo',
      dueOn: '2026-11-18',
      dueTime: '00:00',
    });
  });
});
