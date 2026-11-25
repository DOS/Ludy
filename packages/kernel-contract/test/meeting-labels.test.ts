// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { MEETING_LABEL_LENGTH_MAX, cleanLabelText, labelKey, labelProblem, zLabelAdd, zLabelIndex } from '../src/index.ts';

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
    expect(labelProblem('khach@example.com')).toBe('address');
    expect(labelProblem('0901234567')).toBe('digits');
    expect(labelProblem('Gọi 0901 234 567')).toBe('digits');
    expect(labelProblem('MST 0101.234.567')).toBe('digits');
    expect(labelProblem('1234567')).toBe('digits');
    // Six digits are fine.
    expect(labelProblem('123456')).toBeNull();
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

  it('bounds the list of labels', () => {
    const meetingId = '0190b1c2-0000-7000-8000-000000000001';
    expect(zLabelIndex.safeParse({ labels: [{ label: 'A', count: 1 }], meetings: [{ meetingId, labels: ['A'] }] }).success).toBe(true);
    expect(zLabelIndex.safeParse({ labels: [], meetings: [{ meetingId, labels: [] }] }).success).toBe(false);
    expect(zLabelIndex.safeParse({ labels: [], meetings: [{ meetingId, labels: ['1', '2', '3', '4', '5', '6'] }] }).success).toBe(false);
  });
});
