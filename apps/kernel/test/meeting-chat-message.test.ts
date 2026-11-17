// SPDX-License-Identifier: AGPL-3.0-only
// The message of approved minutes posted to a channel (Meetings B4, #3168): the contract builds it from the published facts, the app shows its text, and the Slack and Teams adapter sends the same lines, so
// what the recorder reads is what the channel gets. This pins the three together and the limits of the build.
import { describe, expect, it } from 'vitest';
import { minutesLines, slackMinutesBody } from '@crove/channel';
import { CHAT_MESSAGE_MAX_CHARS, RESULT_SUMMARY_MAX, buildChatMessage, chatMessageCanonical, chatMessageText, chatMessageTooLong, zChatMessage } from '@crove/kernel-contract';

const facts = {
  summary: 'Chốt báo giá tuần này.\nGặp khách thứ hai.',
  decisions: ['Giữ giá cũ', 'Hoãn đợt hai'],
  items: [
    { title: 'Gửi báo giá cho khách', who: 'An', when: 'thứ sáu' },
    { title: 'Đặt phòng họp', who: '', when: '' },
    { title: 'Chuẩn bị mẫu hợp đồng', who: 'Bình', when: '' },
  ],
};

describe('the minutes message', () => {
  it.each(['vi', 'en'] as const)('shows the recorder the very lines the adapter sends (%s)', (lang) => {
    const message = buildChatMessage({ lang, title: 'Họp giao ban', day: '2026-11-13', facts });
    for (const link of [null, 'https://app.test/o/x/meetings/1']) {
      expect(chatMessageText(message, link)).toBe(minutesLines(message, link).join('\n'));
    }
    const sent = JSON.parse(slackMinutesBody(message, null)) as { text: string };
    expect(sent.text).toBe(chatMessageText(message, null));
  });

  it('says only the title, the day, the summary, the decisions and the items, in a fixed order', () => {
    const text = chatMessageText(buildChatMessage({ lang: 'vi', title: 'Họp giao ban', day: '2026-11-13', facts }), 'https://app.test/o/x/meetings/1');
    expect(text.split('\n')).toEqual([
      'Họp giao ban',
      '13/11/2026',
      '',
      'Tóm tắt',
      'Chốt báo giá tuần này.',
      'Gặp khách thứ hai.',
      '',
      'Quyết định',
      '• Giữ giá cũ',
      '• Hoãn đợt hai',
      '',
      'Việc cần làm',
      '• Gửi báo giá cho khách (An, thứ sáu)',
      '• Đặt phòng họp',
      '• Chuẩn bị mẫu hợp đồng (Bình)',
      '',
      'Xem cuộc họp: https://app.test/o/x/meetings/1',
    ]);
    expect(zChatMessage.safeParse(buildChatMessage({ lang: 'vi', title: 'x', day: '2026-11-13', facts })).success).toBe(true);
    // A key beyond the message is refused: nothing else can be carried along.
    expect(zChatMessage.safeParse({ ...buildChatMessage({ lang: 'vi', title: 'x', day: '2026-11-13', facts }), transcript: 'x' }).success).toBe(false);
  });

  it('leaves out an empty summary, decisions and items instead of printing empty headings', () => {
    const text = chatMessageText(buildChatMessage({ lang: 'vi', title: 'Họp', day: '2026-11-13', facts: { summary: '', decisions: [], items: [] } }), null);
    expect(text).toBe('Họp\n13/11/2026');
  });

  it('cleans what the minutes hold: no control or format characters, one-line titles and items, NFKC', () => {
    const message = buildChatMessage({
      lang: 'vi',
      title: '  Họp‮​ giao\nban  ',
      day: '2026-11-13',
      facts: { summary: 'a\u0000b\r\n\r\n\r\n\r\nc', decisions: ['  ', 'ｑｕｙết định'], items: [{ title: ' \n ', who: 'x', when: '' }, { title: 'Việc\nxuống dòng', who: 'An‍', when: 'mai' }] },
    });
    expect(message.title).toBe('Họp giao ban');
    expect(message.summary).toBe('a b\n\nc');
    expect(message.decisions).toEqual(['quyết định']);
    expect(message.items).toEqual([{ title: 'Việc xuống dòng', who: 'An', when: 'mai' }]);
  });

  it('cuts to the limits and refuses a message too long to post', () => {
    const long = buildChatMessage({ lang: 'vi', title: 'x'.repeat(500), day: '2026-11-13', facts: { summary: 'y'.repeat(RESULT_SUMMARY_MAX + 5000), decisions: [], items: [] } });
    expect(Array.from(long.title)).toHaveLength(200);
    expect(Array.from(long.summary)).toHaveLength(RESULT_SUMMARY_MAX);
    expect(chatMessageTooLong(long)).toBe(false);
    const heavy = buildChatMessage({ lang: 'vi', title: 'Họp', day: '2026-11-13', facts: { summary: 'y'.repeat(RESULT_SUMMARY_MAX), decisions: Array.from({ length: 50 }, () => 'z'.repeat(500)), items: [] } });
    expect(Array.from(chatMessageText(heavy, null)).length).toBeGreaterThan(CHAT_MESSAGE_MAX_CHARS);
    expect(chatMessageTooLong(heavy)).toBe(true);
    // A cut never splits a surrogate pair.
    const emoji = buildChatMessage({ lang: 'vi', title: '😀'.repeat(300), day: '2026-11-13', facts: { summary: '', decisions: [], items: [] } });
    expect(emoji.title).toBe('😀'.repeat(200));
  });

  it('has one canonical form whatever the order of the keys, and a different one for a different text', () => {
    const a = buildChatMessage({ lang: 'vi', title: 'Họp', day: '2026-11-13', facts });
    const shuffled = { items: a.items, decisions: a.decisions, summary: a.summary, day: a.day, title: a.title, lang: a.lang, v: a.v } as typeof a;
    expect(chatMessageCanonical(shuffled)).toBe(chatMessageCanonical(a));
    expect(chatMessageCanonical({ ...a, summary: `${a.summary}!` })).not.toBe(chatMessageCanonical(a));
  });
});
