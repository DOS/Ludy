// SPDX-License-Identifier: AGPL-3.0-only
// The words checks of the follow-up email (L3, #2590): the send command applies them to every text whatever its origin, so they are the gate and "from Vy" is not.
import { describe, expect, it } from 'vitest';
import {
  FOLLOWUP_CLOSING_MAX,
  FOLLOWUP_GREETING_MAX,
  FOLLOWUP_NOTE_MAX,
  FOLLOWUP_SUBJECT_MAX,
  followupAddress,
  followupClean,
  followupHasBareLink,
  followupHasPhoneOrLongDigits,
  followupNoteProblem,
  followupSubjectProblem,
  followupWordsProblem,
  zFollowupSend,
  zFollowupMail,
} from '../src/index.ts';

const problem = (text: string, max = 600) => followupWordsProblem(followupClean(text, false), max);

describe('followupClean', () => {
  it('folds the text to the form that is checked and stored', () => {
    expect(followupClean('  Xin  chào\r\n\r\n\r\n\r\nbạn\u200b!  ', false)).toBe('Xin chào\n\nbạn!');
    expect(followupClean('Một\ndòng\u0007thôi', true)).toBe('Một dòng thôi');
    // A fullwidth digit is a digit once folded, and a zero-width joiner cannot hide one.
    expect(problem('hạn １５')).toBe('FIGURES');
    expect(problem('hạn 1\u200d5')).toBe('FIGURES');
    expect(problem('a\u200b@\u200bb')).toBe('LINK');
  });
});

describe('followupWordsProblem', () => {
  it('accepts plain words in either language', () => {
    expect(problem('Cảm ơn mọi người đã dành thời gian cho cuộc họp. Dưới đây là tóm tắt, các quyết định và việc cần làm.')).toBeNull();
    expect(problem('Thank you for your time. Below are the summary, the decisions and the action items.')).toBeNull();
    // Plain number-like words that are not figures stay allowed.
    expect(problem('Hai bên đã thống nhất. Một lần nữa cảm ơn bạn. Thứ hai gặp lại.')).toBeNull();
  });

  it('refuses empty, over-long, figures and addresses', () => {
    expect(problem('   ')).toBe('EMPTY');
    expect(problem('x'.repeat(601))).toBe('TOO_LONG');
    expect(followupWordsProblem('x'.repeat(FOLLOWUP_CLOSING_MAX + 1), FOLLOWUP_CLOSING_MAX)).toBe('TOO_LONG');
    for (const text of ['pay 5', '1.000.000 đồng', '$10', '₫ nhiều', 'twenty days', 'one million', 'hai mươi ngày', 'ba trăm', 'năm triệu', 'ten']) expect(problem(text), text).toBe('FIGURES');
    for (const text of ['https://a.test', 'a@b.test', 'evil.club', 'mail (at) host', 'host (dot) com', 'www tại đây', 'x[.]y', 'an [at] ludy [dot] vn', 'a。com', 'ludy｡vn']) expect(problem(text), text).toBe('LINK');
  });
});

describe('followupSubjectProblem', () => {
  it('lets a date stand in a subject, and refuses an address or a long one', () => {
    expect(followupSubjectProblem('Tóm tắt cuộc họp 15/11/2026')).toBeNull();
    expect(followupSubjectProblem('')).toBe('EMPTY');
    expect(followupSubjectProblem('x'.repeat(FOLLOWUP_SUBJECT_MAX + 1))).toBe('TOO_LONG');
    expect(followupSubjectProblem('Xem tại www.a.test')).toBe('LINK');
    expect(FOLLOWUP_GREETING_MAX).toBeGreaterThan(0);
  });
});

describe('followupAddress', () => {
  it('reads one valid mailbox, lower-cased', () => {
    expect(followupAddress('  An@Example.TEST ')).toBe('an@example.test');
    for (const bad of ['', 'khong-phai-thu', 'a@b.test, c@d.test', 'a@b.test;c@d.test', 'An <a@b.test>']) expect(followupAddress(bad), bad).toBeNull();
  });
});

describe('followupNoteProblem', () => {
  it('accepts personal note prose with grounded numbers/dates and blocks links, emails and phone/8+-digit runs', () => {
    expect(followupNoteProblem(followupClean('Chào Lan,\n\nCảm ơn bạn đã trao đổi về lộ trình 1 và 2 tháng.\n- Ngân sách 15.000.000 đồng\n- Ngày bắt đầu 2026-12-01\n\nHẹn gặp lại.', false))).toBeNull();
    expect(followupNoteProblem(followupClean('  \u200b\u202e\u3164  ', false))).toBe('EMPTY');
    expect(followupNoteProblem('x'.repeat(FOLLOWUP_NOTE_MAX + 1))).toBe('TOO_LONG');
    for (const link of ['Xem https://evil.test', 'Vào www.evil.test', 'Liên hệ an@example.com', 'Vào 123.com', 'an [at] example [dot] com']) {
      expect(followupNoteProblem(followupClean(link, false)), link).toBe('LINK');
    }
    for (const phone of ['Gọi 09012345', 'Số 090 123 4567', 'Số +84 90-123-4567', 'Mã 12345678', 'Số (028) 3822 1234', 'Số 090.123.4567']) {
      expect(followupNoteProblem(followupClean(phone, false)), phone).toBe('CONTACT');
    }
    expect(followupHasBareLink('check 123.com now')).toBe(true);
    expect(followupHasBareLink('check 123.com:8080 or 123.com?a=1')).toBe(true);
    expect(followupHasBareLink('giá 15.000.000')).toBe(false);
    expect(followupHasPhoneOrLongDigits('15.000.000 và ngày 2026-11-22')).toBe(false);
    expect(followupHasPhoneOrLongDigits('Lương 15.000.000 - 20.000.000 đồng (2025 - 2026)')).toBe(false);
    expect(followupHasPhoneOrLongDigits('Hạn 2026-11-22 - 2026-12-01, gói 15.000.000 (2026)')).toBe(false);
    expect(followupHasPhoneOrLongDigits('Gọi 84 (028) 3822 1234')).toBe(true);
  });

  it('reads a phone typed with spaced hyphens, keeps dot dates and figure ranges out of CONTACT, and sees a domain behind punctuation (#4479)', () => {
    for (const phone of [
      'Số 090 - 123 - 4567',
      'Gọi 090 - 1234567',
      'Số +84 90 - 123 - 4567',
      'Gọi 0901 - 234 - 567',
      'Số 090.123.4567',
      'Mã 09.12.4567',
      // A dot followed by a space, as people type a number: still one run (the first version of this rule let these through).
      'Số 090. 123. 4567',
      'Gọi 0901. 234. 567 nhé',
      'Số 090 . 123 . 4567',
      'Số 090..123..4567',
      'Số 090-123-45',
    ]) {
      expect(followupHasPhoneOrLongDigits(phone), phone).toBe(true);
    }
    expect(followupNoteProblem(followupClean('Số 090 - 123 - 4567', false))).toBe('CONTACT');
    for (const fine of [
      'Họp ngày 28.11.2026',
      'Hạn 28.11.2026 - 30.11.2026',
      'Ngày 28.11.2026 lúc 09.30',
      'Năm 2025. 2026 sẽ khác',
      'Ngân sách 1000 - 2000 USD',
      'Năm 2025 - 2026 - 2027',
      'Từ 2026-11 - 2026-12',
      // Times, days and ranges that open with a 0 or 84 and have spaced hyphens: eight digits or fewer, or a dot, so not a contact.
      'Họp từ 08.30 - 11.30',
      'Ca 07.00 - 11.30 - 13.30',
      'Ca 0700 - 1100',
      'Họp 0900 - 1700 hằng ngày',
      'Ngày 05 - 10 - 2026',
      'Từ 01 - 12 - 2026 đến 05 - 12 - 2026',
      'Từ 01.12 - 05.12.2026',
      'Giá 0 - 15.000.000',
      'Doanh thu 8400 - 9000',
      'Mã 01 - 02 - 03 - 04',
      'Số 09.12.2026',
      'Họp ngày 28.11.2026. 30 người dự',
    ]) {
      expect(followupHasPhoneOrLongDigits(fine), fine).toBe(false);
    }
    for (const link of ['Vào a,123.com', 'Xem (123.com)', 'Vào 123。com', 'Vào 123｡com', 'Xem x;1.ai nhé', 'Kiểm tra unit.test nhé']) {
      expect(followupHasBareLink(link), link).toBe(true);
    }
    for (const fine of ['Giá 1,5 triệu và 2.5', 'Gửi báo giá, xong thì chốt', 'Họp lúc 9.30, tại phòng 5']) expect(followupHasBareLink(fine), fine).toBe(false);
  });
});

describe('the contact and link shapes of #4553', () => {
  // Gaps of #4479's review that were open before it: other dash characters, a line break between groups, a number typed without its leading 0, other separators, and links behind other
  // punctuation or spaced dots. Nothing the guard refused before is allowed now (checked against the old guard on random strings).
  it('refuses a phone typed with other dashes, line breaks, other separators or no leading 0, and keeps dates, times and ranges out of CONTACT', () => {
    const en = String.fromCharCode(0x2013);
    const minus = String.fromCharCode(0x2212);
    for (const phone of [
      `Số 090 ${en} 123 ${en} 4567`,
      `Số 090${minus}123${minus}4567`,
      'Số\n090\n123\n4567',
      'Số 090 -\n123 -\n4567',
      'Số 90 - 123 - 4567',
      'US 415 - 555 - 2671',
      'Gọi 1 - 415 - 555 - 2671',
      'Số +1 415 - 555 - 2671',
      'Số 090/123/4567',
      'Số 090_123_4567',
      'Số 090,123,4567',
      'Số 090-123 - 4567',
      // A date opens the run, a phone follows it: the date does not hide the phone.
      'Họp 05/12/2026, 090_123_4567',
      '05/12/2026 - 090/123/4567',
      'Ngày 05/12/2026\n090 123\n4567',
      // A numbered line or item just before the phone does not hide it.
      'Mục 1\n090_123_4567',
      'Phòng 5 - 090/123/4567',
      'Mục 1\n90 - 123 - 4567',
    ]) {
      expect(followupHasPhoneOrLongDigits(phone), phone).toBe(true);
    }
    for (const fine of [
      'Hạn 28/11/2026 12 người',
      'Hạn 05/10/2026 12 người',
      'Ngày 01-12-2026 12 người',
      'Từ 05 - 10 - 2026 đến 07 - 10 - 2026',
      `Ngày 28${en}11${en}2026`,
      'Ca 07.00 - 11.30',
      'Năm 2025 - 2026 - 2027',
      'Doanh thu 10000 - 20000',
      'Giá 0,5 - 0,75 triệu',
      'Mục 1, 2, 3, 4',
      'Họp 0900 - 1700',
      'Dòng 1\nDòng 2\nDòng 3',
      // Lists and tiers: a comma and a space, day and month lists, three tiers of figures.
      'Lô 01, 02, 03, 04, 05',
      'Điểm: 0, 10, 20, 30, 40',
      'Doanh số 845, 920, 1050 triệu',
      'Giao hàng các ngày 05/12, 12/12, 19/12',
      'Lịch 08/12 - 15/12 - 22/12',
      'Ngày 15-05-2026 0900',
      'Kỳ 12/08/2025\n0900 khách',
      'Phương án 0/1/2/3/4/5/6/7/8',
      'Gói 100 - 200 - 300 nghìn',
      '150 - 200 - 250 khách',
    ]) {
      expect(followupHasPhoneOrLongDigits(fine), fine).toBe(false);
    }
  });

  it('sees a domain behind any ASCII punctuation or with spaces around its dot, and still reads ordinary prose as prose', () => {
    const ideographic = String.fromCharCode(0x3002);
    for (const glued of ['a|x.com', 'a/x.com', 'a*x.com', 'a&x.com', 'a=x.com', 'a~x.com', 'a:x.com', 'a#x.com', 'a+x.com', 'a%x.com', 'a_x.com', 'abc . com', `abc ${ideographic} com`]) {
      expect(followupHasBareLink(`Vào ${glued} nhé`), glued).toBe(true);
    }
    for (const fine of ['chốt.Co thể', 'Họp lúc 9.30, tại phòng 5', 'và/hoặc đi', 'Giá 1,5 triệu và 2.5', 'Gửi báo giá, xong thì chốt', 'đi.Me', 'Giá 2.5,vn', 'Xong . Ai làm tiếp?', 'Hàng về 3 . Vn sẽ xác nhận', 'BTC . VN']) {
      expect(followupHasBareLink(fine), fine).toBe(false);
    }
  });
});

describe('the send and mail shapes', () => {
  it('holds a send to twenty recipients and refuses unknown fields', () => {
    const base = { meetingId: '00000000-0000-4000-8000-000000000001', factsKey: 'k', subject: 's', greeting: 'g', lead: 'l', closing: 'c', recipients: ['a@b.test'], confirmedOutsiders: [], confirmRepeat: false, fromVy: false, reviewed: false };
    expect(zFollowupSend.safeParse(base).success).toBe(true);
    expect(zFollowupSend.safeParse({ ...base, style: 'personal_note', stage: 'draft', confirmUnpublished: true, body: 'Cảm ơn bạn.' }).success).toBe(true);
    expect(zFollowupSend.safeParse({ ...base, recipients: Array.from({ length: 21 }, (_, i) => `a${i}@b.test`) }).success).toBe(false);
    expect(zFollowupSend.safeParse({ ...base, recipients: [] }).success).toBe(false);
    expect(zFollowupSend.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(zFollowupMail.safeParse({ lang: 'vi', org: 'o', batch: base.meetingId, greeting: 'g', lead: 'l', closing: 'c', facts: { summary: '', decisions: [], items: [] } }).success).toBe(true);
    expect(zFollowupMail.safeParse({ style: 'personal_note', lang: 'vi', org: 'o', batch: base.meetingId, body: 'Cảm ơn bạn.' }).success).toBe(true);
    expect(zFollowupMail.safeParse({ style: 'personal_note', lang: 'vi', org: 'o', batch: base.meetingId, body: '' }).success).toBe(false);
    expect(zFollowupMail.safeParse({ style: 'personal_note', lang: 'vi', org: 'o', batch: base.meetingId, body: 'x', extra: 1 }).success).toBe(false);
  });
});
