// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for typed-note line splitting and redaction detection (#5129, L32).
import { describe, expect, it } from 'vitest';
import { NOTES_MINUTES_LINES_MAX, REDACTION_MARK_BY_KIND } from '@ludy/kernel-contract';
import { hasRedactedNotes, splitNoteLines } from '../src/notes-minutes.ts';

describe('notes-minutes helpers (#5129)', () => {
  it('splits typed notes into trimmed non-empty lines and caps at NOTES_MINUTES_LINES_MAX', () => {
    expect(splitNoteLines('  \n\r\n  ')).toEqual([]);
    expect(splitNoteLines('Dong 1\r\n\n  Dong 2  \n\nDong 3')).toEqual(['Dong 1', 'Dong 2', 'Dong 3']);

    const many = Array.from({ length: NOTES_MINUTES_LINES_MAX + 10 }, (_, idx) => `Dong ${idx + 1}`).join('\n');
    expect(splitNoteLines(many)).toHaveLength(NOTES_MINUTES_LINES_MAX);
  });

  it('detects every redaction marker and PDPL note erasure placeholder', () => {
    expect(hasRedactedNotes('Chot ke hoach ban hang quy 4.')).toBe(false);
    for (const mark of Object.values(REDACTION_MARK_BY_KIND)) {
      expect(hasRedactedNotes(`Goi cho khach qua ${mark}`)).toBe(true);
    }
    expect(hasRedactedNotes('Ghi chu: [đã xóa]')).toBe(true);
  });
});
