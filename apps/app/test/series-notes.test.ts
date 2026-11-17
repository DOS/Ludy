// SPDX-License-Identifier: AGPL-3.0-only
// Carrying an open item of the previous meeting into the recorder's own notes (#3542): one plain line at the end of what they wrote, once, never cut.
import { describe, expect, it } from 'vitest';
import { appendNoteLine, noteLineFor } from '../src/lib/series-notes.ts';

describe('noteLineFor', () => {
  it('writes the item on one line with its owner in brackets, and without the owner when there is none', () => {
    expect(noteLineFor('Gửi báo giá cho khách A', 'Nam')).toBe('- Gửi báo giá cho khách A (Nam)');
    expect(noteLineFor('Gọi lại khách', '')).toBe('- Gọi lại khách');
    expect(noteLineFor('  Gửi\nbáo   giá\t', ' Nam  Nguyễn ')).toBe('- Gửi báo giá (Nam Nguyễn)');
  });
});

describe('appendNoteLine', () => {
  it('adds the line at the end of the notes, or makes it the notes when they are empty', () => {
    expect(appendNoteLine('', '- Việc A')).toBe('- Việc A');
    expect(appendNoteLine('  \n', '- Việc A')).toBe('- Việc A');
    expect(appendNoteLine('Chốt giá cũ\n', '- Việc A')).toBe('Chốt giá cũ\n- Việc A');
  });

  it('adds a line once, whatever else the notes hold', () => {
    const notes = 'Chốt giá cũ\n- Việc A\nGhi chú khác';
    expect(appendNoteLine(notes, '- Việc A')).toBe(notes);
  });

  it('refuses a line that would pass the limit instead of cutting the notes or the line', () => {
    expect(appendNoteLine('x'.repeat(95), '- Việc A', 100)).toBeNull();
    expect(appendNoteLine('x'.repeat(90), '- Việc A', 100)).toBe(`${'x'.repeat(90)}\n- Việc A`);
  });
});
