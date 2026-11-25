// SPDX-License-Identifier: AGPL-3.0-only
// Spoken cues to Vy (#4807), the pure finder: which lines are cues (Vietnamese with or without marks, English, "hey Vy"), which are not (a person called Vy, a mention, no verb), what each cue's title,
// owner and due date are (read by the same code as the summary's items), "việc này" taking the line before, a cue with nothing to write down, and the cap.
import { describe, expect, it } from 'vitest';
import { VOICE_CUES_MAX } from '@ludy/kernel-contract';
import { findVoiceCues, type CueLine } from '../src/voice-cue.ts';

// 2026-11-25 is a Wednesday.
const DAY = '2026-11-25';
const NAM = { userId: 'u-nam', name: 'Nguyễn Văn Nam' };
const LAN = { userId: 'u-lan', name: 'Trần Thị Lan' };
const HUNG = { userId: 'u-hung', name: 'Lê Hùng' };
const PEOPLE = [NAM, LAN, HUNG];
const lines = (...texts: string[]): CueLine[] => texts.map((text, i) => ({ seconds: 10 + i * 5 + 0.7, text }));
const one = (text: string, people = PEOPLE) => findVoiceCues(lines(text), people, DAY).cues[0];

describe('which lines are cues', () => {
  it('takes "Vy ơi" followed by a note or remind verb, with or without marks, in any case', () => {
    for (const [text, title] of [
      ['Vy ơi, ghi lại gửi báo giá', 'gửi báo giá'],
      ['vy oi ghi chu gui bao gia', 'gui bao gia'],
      ['VY ƠI, GHI NHỚ gửi báo giá', 'gửi báo giá'],
      ['Vy ơi lưu lại gửi báo giá', 'gửi báo giá'],
      ['Vy ơi, nhắc gửi báo giá', 'gửi báo giá'],
      ['Vy ơi làm ơn ghi lại gửi báo giá', 'gửi báo giá'],
      ['Vy ơi giúp anh ghi lại gửi báo giá', 'gửi báo giá'],
      ['Vy, ghi lại gửi báo giá', 'gửi báo giá'],
      ['Vy: note gửi báo giá', 'gửi báo giá'],
      ['Hey Vy, note gửi báo giá', 'gửi báo giá'],
      ['Vy, please remind us gửi báo giá', 'gửi báo giá'],
      ['Vy - remind me gửi báo giá', 'gửi báo giá'],
    ] as const) {
      expect(one(text)?.title, text).toBe(title);
    }
  });

  it('takes the cue in the middle of a line, and reads only to the end of its sentence', () => {
    const cue = one('Được rồi mọi người. Vy ơi, ghi lại gửi báo giá cho khách. Còn nữa thì tuần sau bàn tiếp.');
    expect(cue?.title).toBe('gửi báo giá cho khách');
  });

  it('is not a cue when Vy is a person, is only mentioned, or no verb follows', () => {
    for (const text of [
      'Anh Vy ghi lại biên bản giúp tôi',
      'Vy ghi lại biên bản rồi',
      'Chị Vy nhắc anh Nam gửi báo giá',
      'Hôm qua Vy ơi là bạn nào nhỉ',
      'Vy ơi, hôm nay trời đẹp quá',
      'Vy, what do you think about the price',
      'Vyvy ơi ghi lại gửi báo giá',
      'Chúng ta cần ghi lại việc này',
      'Mọi người nhớ ghi chú lại nhé',
      'We should note the price and remind everyone',
      '',
    ]) {
      expect(findVoiceCues(lines(text), PEOPLE, DAY), text).toEqual({ cues: [], empty: 0 });
    }
  });

  it('cites the whole second of the cue\'s line and keeps the order they were said in', () => {
    const found = findVoiceCues(
      [
        { seconds: 3.9, text: 'Chào mọi người' },
        { seconds: 65.4, text: 'Vy ơi, ghi lại gọi khách' },
        { seconds: 120, text: 'Vy, remind us to send the invoice' },
      ],
      PEOPLE,
      DAY,
    );
    expect(found.cues.map((c) => [c.seconds, c.title])).toEqual([
      [65, 'gọi khách'],
      [120, 'send the invoice'],
    ]);
  });
});

describe('the owner', () => {
  it('matches the name after "cho" to exactly one attendee, honorific and all, and takes it out of the title', () => {
    const cue = one('Vy ơi, ghi lại việc gửi báo giá cho anh Nam, hạn thứ Sáu');
    expect(cue).toMatchObject({ title: 'việc gửi báo giá', who: 'anh Nam', whoUserId: 'u-nam' });
  });

  it('works without a comma and for "giao cho" and "for"', () => {
    expect(one('Vy ơi ghi lại soạn hợp đồng giao cho chị Lan hạn ngày mai')).toMatchObject({ title: 'soạn hợp đồng', who: 'chị Lan', whoUserId: 'u-lan', whenDate: '2026-11-26' });
    expect(one('Vy, note send the contract for Hung')).toMatchObject({ title: 'send the contract', who: 'Hung', whoUserId: 'u-hung' });
  });

  it('stops the name where the task starts', () => {
    expect(one('Vy ơi, ghi lại cho anh Nam gửi báo giá')).toMatchObject({ title: 'gửi báo giá', who: 'anh Nam', whoUserId: 'u-nam' });
  });

  it('matches the person a reminder names right after the verb', () => {
    expect(one('Vy ơi, nhắc anh Nam gửi báo giá')).toMatchObject({ title: 'gửi báo giá', who: 'anh Nam', whoUserId: 'u-nam' });
  });

  it('keeps a short name nobody answers to as said text, and matches nobody when two attendees answer to it', () => {
    expect(one('Vy ơi, ghi lại gửi báo giá cho anh Tuấn, hạn thứ sáu')).toMatchObject({ title: 'gửi báo giá', who: 'anh Tuấn', whoUserId: null });
    const twoNams = [NAM, { userId: 'u-nam2', name: 'Phạm Nam' }];
    expect(one('Vy ơi, ghi lại gửi báo giá cho anh Nam, hạn thứ sáu', twoNams)).toMatchObject({ who: 'anh Nam', whoUserId: null });
  });

  it('leaves a long "cho ..." phrase in the title: it is not a name', () => {
    expect(one('Vy ơi, ghi lại làm báo cáo cho buổi họp với khách hàng lớn vào cuối tuần này')).toMatchObject({ who: '', whoUserId: null });
  });
});

describe('the due date', () => {
  it('reads the phrase after a keyword against the meeting day', () => {
    expect(one('Vy ơi, ghi lại gửi báo giá, hạn thứ Sáu')).toMatchObject({ title: 'gửi báo giá', when: 'thứ Sáu', whenDate: '2026-11-27' });
    expect(one('Vy ơi, ghi lại gửi báo giá trước ngày mai')).toMatchObject({ title: 'gửi báo giá', when: 'ngày mai', whenDate: '2026-11-26' });
    expect(one('Vy, remind us to pay the invoice by Friday')).toMatchObject({ title: 'pay the invoice', when: 'Friday', whenDate: '2026-11-27' });
    expect(one('Vy ơi ghi lại gửi báo giá hạn chót 30/11')).toMatchObject({ when: '30/11', whenDate: '2026-11-30' });
  });

  it('reads a date said without a keyword, and leaves a vague one for a person', () => {
    expect(one('Vy ơi, ghi lại gọi khách thứ Sáu')).toMatchObject({ title: 'gọi khách thứ Sáu', whenDate: '2026-11-27' });
    expect(one('Vy ơi, ghi lại gọi khách, hạn tuần sau')).toMatchObject({ when: 'tuần sau', whenDate: null });
    expect(one('Vy ơi, ghi lại gọi khách')).toMatchObject({ when: '', whenDate: null });
  });

  it('keeps the owner when the date comes first, and the date when the owner comes first', () => {
    expect(one('Vy ơi, ghi lại gửi báo giá hạn thứ Sáu cho anh Nam')).toMatchObject({ title: 'gửi báo giá', who: 'anh Nam', whoUserId: 'u-nam', when: 'thứ Sáu', whenDate: '2026-11-27' });
    expect(one('Vy ơi, ghi lại gửi báo giá cho anh Nam hạn thứ Sáu')).toMatchObject({ title: 'gửi báo giá', who: 'anh Nam', whoUserId: 'u-nam', when: 'thứ Sáu', whenDate: '2026-11-27' });
    expect(one('Vy, note the report for Lan by Friday')).toMatchObject({ title: 'the report', who: 'Lan', whoUserId: 'u-lan', when: 'Friday', whenDate: '2026-11-27' });
  });

  it('does not take a phrase that is no time for the due clause', () => {
    expect(one('Vy ơi, ghi lại gửi bản nháp trước cho chị Lan')).toMatchObject({ title: 'gửi bản nháp trước', who: 'chị Lan', whoUserId: 'u-lan', when: '' });
    expect(one('Vy, note the report by Lan')).toMatchObject({ title: 'the report by Lan', when: '' });
    expect(one('Vy, remind me to call the bank by phone')).toMatchObject({ title: 'call the bank by phone', when: '' });
  });

  it('keeps a vague time as said text for a person to read', () => {
    expect(one('Vy ơi, ghi lại gửi báo giá, hạn cuối tháng')).toMatchObject({ title: 'gửi báo giá', when: 'cuối tháng', whenDate: null });
    expect(one('Vy, note the report by next week')).toMatchObject({ title: 'the report', when: 'next week', whenDate: null });
  });

  it('means "hạn" and "cho", not words that fold to them', () => {
    expect(one('Vy ơi, ghi lại gửi hàng Hàn Quốc')).toMatchObject({ title: 'gửi hàng Hàn Quốc', when: '' });
    expect(one('Vy ơi, ghi lại chở anh Nam ra sân bay')).toMatchObject({ title: 'chở anh Nam ra sân bay', who: '', whoUserId: null });
    expect(one('Vy ơi, ghi lại mua chó cho anh Nam')).toMatchObject({ title: 'mua chó', who: 'anh Nam', whoUserId: 'u-nam' });
    expect(one('Vy ơi, ghi lại làm xong trúc bách thứ sáu')).toMatchObject({ when: '' });
  });

  it('does not read a long phrase after "trước" as a due clause', () => {
    expect(one('Vy ơi, ghi lại làm xong hợp đồng trước khi khách gửi lại bản chỉnh sửa cuối cùng')).toMatchObject({ when: '' });
  });
});

describe('a cue with no title of its own', () => {
  it('takes the line before for "việc này", "cái này" or "this", and keeps the owner and the date', () => {
    const found = findVoiceCues(lines('Cần gửi báo giá bản cuối cho khách Á Châu', 'Vy ơi, ghi lại việc này cho anh Nam, hạn thứ Sáu'), PEOPLE, DAY);
    expect(found.cues).toEqual([{ seconds: 15, title: 'Cần gửi báo giá bản cuối cho khách Á Châu', who: 'anh Nam', whoUserId: 'u-nam', when: 'thứ Sáu', whenDate: '2026-11-27' }]);
    expect(findVoiceCues(lines('Update the pricing page', 'Vy, note this'), PEOPLE, DAY).cues[0]?.title).toBe('Update the pricing page');
    expect(findVoiceCues(lines('Gọi lại khách', 'Vy ơi, nhắc cái này nhé'), PEOPLE, DAY).cues[0]?.title).toBe('Gọi lại khách');
  });

  it('skips a cue with nothing to write down and nothing before it, and counts it', () => {
    expect(findVoiceCues(lines('Vy ơi, ghi lại việc này'), PEOPLE, DAY)).toEqual({ cues: [], empty: 1 });
    expect(findVoiceCues(lines('Vy ơi, ghi lại', 'Vy ơi, ghi lại việc này cho anh Nam'), PEOPLE, DAY)).toEqual({ cues: [], empty: 2 });
  });
});

describe('what the title may hold', () => {
  it('has no control or invisible character and no line break, and is cut to the title limit', () => {
    const cue = one('Vy ơi, ghi lại gửi‮ báo​ giá\u0000');
    expect(cue?.title).toBe('gửi báo giá');
    const long = one(`Vy ơi, ghi lại ${'rất dài '.repeat(100)}`);
    expect(Array.from(long?.title ?? '').length).toBeLessThanOrEqual(300);
  });

  it('works for a transcript with emoji and combining marks without losing its place', () => {
    const cue = one('😀 Vy ơi, ghi lại gửi báo giá 😀 cho anh Nam, hạn thứ Sáu.');
    expect(cue).toMatchObject({ title: 'gửi báo giá 😀', who: 'anh Nam', whoUserId: 'u-nam', when: 'thứ Sáu' });
    const decomposed = one('Vy ơi, ghi lại gửi báo giá cho anh Nam'.normalize('NFD'));
    expect(decomposed?.whoUserId).toBe('u-nam');
  });
});

describe('the cap', () => {
  it('reads at most as many cues as one click may draft', () => {
    const many = Array.from({ length: VOICE_CUES_MAX + 20 }, (_, i) => ({ seconds: i, text: `Vy ơi, ghi lại việc số ${i}` }));
    expect(findVoiceCues(many, PEOPLE, DAY).cues).toHaveLength(VOICE_CUES_MAX);
  });
});
