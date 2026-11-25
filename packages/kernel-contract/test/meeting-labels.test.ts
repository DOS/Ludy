// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { MEETING_LABEL_LENGTH_MAX, cleanLabelText, labelKey, labelProblem, zLabelAdd, zMeetingListItem } from '../src/index.ts';

describe('meeting label text (#4955)', () => {
  it('collapses runs of spaces and tabs and trims the ends', () => {
    expect(cleanLabelText('  Khách \t  Hoa   Sen ')).toBe('Khách Hoa Sen');
    expect(cleanLabelText(' Họp tuần ')).toBe('Họp tuần');
  });

  it('knows the same label by its lower-cased text', () => {
    expect(labelKey(' Dự ÁN  Website ')).toBe('dự án website');
    expect(labelKey('Khách Hoa Sen')).toBe(labelKey('khách hoa sen'));
  });

  it('accepts plain short labels, with Vietnamese marks, a short number and a month and year', () => {
    for (const ok of ['Khách Hoa Sen', 'Dự án website', 'Họp tuần', 'Quý 4 - 2026', 'Tháng 12/2026', 'A', 'x'.repeat(MEETING_LABEL_LENGTH_MAX), '2026 11']) {
      expect(labelProblem(ok), ok).toBeNull();
    }
  });

  it('refuses an empty label, one that is too long, a line break, an "@" and a run of seven digits', () => {
    expect(labelProblem('')).toBe('empty');
    expect(labelProblem('   ')).toBe('empty');
    expect(labelProblem('x'.repeat(MEETING_LABEL_LENGTH_MAX + 1))).toBe('too_long');
    expect(labelProblem('một\nhai')).toBe('control');
    expect(labelProblem('một\u0007hai')).toBe('control');
    expect(labelProblem('một hai')).toBe('control');
    expect(labelProblem('m\u200bt')).toBe('control');
    expect(labelProblem('\u202eabc')).toBe('control');
    expect(labelProblem('\u200b')).toBe('control');
    expect(labelProblem('khach@example.com')).toBe('address');
    expect(labelProblem('0901234567')).toBe('digits');
    expect(labelProblem('Gọi 0901 234 567')).toBe('digits');
    expect(labelProblem('MST 0101.234.567')).toBe('digits');
    expect(labelProblem('1234567')).toBe('digits');
    // Separators a phone number or an ID is written with do not hide the run: spaces, dots, dashes, slashes, brackets and a plus.
    for (const bad of ['090-123-4567', '(090) 123 4567', '+84 90 123 4567', '090/123/4567', '0101-234-567']) expect(labelProblem(bad), bad).toBe('digits');
    // Six digits are fine, and so is a month and year or a date without the year.
    expect(labelProblem('123456')).toBeNull();
    expect(labelProblem('Tháng 12/2026')).toBeNull();
    expect(labelProblem('Họp 25/11')).toBeNull();
    // Invisible format characters are refused: bidi isolates, the soft hyphen, the Arabic letter mark, the Mongolian vowel separator, interlinear marks and tag characters.
    for (const code of [0x2066, 0x2067, 0x2068, 0x2069, 0x00ad, 0x061c, 0x180e, 0xfff9, 0xfffa, 0xfffb, 0xe0001, 0xe0041, 0xe007f, 0xfeff]) {
      expect(labelProblem(`ab${String.fromCodePoint(code)}cd`), code.toString(16)).toBe('control');
    }
  });

  it('counts the characters of a label, not its UTF-16 units', () => {
    expect(labelProblem('😀'.repeat(MEETING_LABEL_LENGTH_MAX))).toBeNull();
    expect(labelProblem('😀'.repeat(MEETING_LABEL_LENGTH_MAX + 1))).toBe('too_long');
  });

  it('takes a meeting id and a text, and nothing else', () => {
    const meetingId = '0190b1c2-0000-7000-8000-000000000001';
    expect(zLabelAdd.safeParse({ meetingId, label: 'Họp tuần' }).success).toBe(true);
    expect(zLabelAdd.safeParse({ meetingId, label: 'Họp tuần', extra: 1 }).success).toBe(false);
    expect(zLabelAdd.safeParse({ meetingId: 'x', label: 'Họp tuần' }).success).toBe(false);
  });

  it('bounds the labels of a row of the meetings list (#4966): at most five, each a label-sized text, and required', () => {
    const row = {
      id: '0190b1c2-0000-7000-8000-000000000001',
      title: 'Weekly sync',
      language: 'vi',
      visibility: 'attendees',
      status: 'ready',
      recorderUserId: '0190b1c2-0000-7000-8000-000000000002',
      startedAt: '2026-11-23T02:00:00.000Z',
      endedAt: null,
      lengthSeconds: 1800,
      keepVideo: false,
      liveNotes: false,
      summaryTemplate: 'general',
      audioRetentionDate: '2026-12-23',
      textRetentionDate: null,
      hasAudio: true,
      hasVideo: false,
      hasTranscript: true,
      platform: null,
      readersCount: 2,
      createdAt: '2026-11-23T02:00:00.000Z',
      updatedAt: '2026-11-23T02:00:00.000Z',
    };
    expect(zMeetingListItem.safeParse({ ...row, labels: [] }).success).toBe(true);
    expect(zMeetingListItem.safeParse({ ...row, labels: ['A', 'B', 'C', 'D', 'E'] }).success).toBe(true);
    expect(zMeetingListItem.safeParse({ ...row, labels: ['A', 'B', 'C', 'D', 'E', 'F'] }).success).toBe(false);
    expect(zMeetingListItem.safeParse({ ...row, labels: ['x'.repeat(MEETING_LABEL_LENGTH_MAX + 1)] }).success).toBe(false);
    // The list says what each meeting carries: a row without the field is refused.
    expect(zMeetingListItem.safeParse(row).success).toBe(false);
  });
});
