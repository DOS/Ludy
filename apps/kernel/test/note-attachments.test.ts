// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { NOTE_ATTACHMENT_FILENAME_MAX } from '@crove/kernel-contract';
import { noteAttachmentContentDisposition, sanitizeNoteAttachmentFilename } from '../src/note-attachments.ts';

describe('sanitizeNoteAttachmentFilename (#3561)', () => {
  it('truncates long astral-emoji filenames without leaving a lone surrogate so Content-Disposition never throws', () => {
    // 126 pairs (252 UTF-16 code units) with '.pdf' gives length 256 > 255; keep = 251 lands mid-surrogate pair.
    const withOddBoundaryExt = `${'📄'.repeat(126)}.pdf`;
    expect(withOddBoundaryExt.length).toBe(256);
    const cleanedWithExt = sanitizeNoteAttachmentFilename(withOddBoundaryExt, 'application/pdf');
    expect(cleanedWithExt.length).toBeLessThanOrEqual(NOTE_ATTACHMENT_FILENAME_MAX);
    expect(cleanedWithExt.endsWith('.pdf')).toBe(true);
    expect(cleanedWithExt.isWellFormed()).toBe(true);
    expect(() => noteAttachmentContentDisposition(cleanedWithExt, 'application/pdf')).not.toThrow();

    // Odd code-unit prefix + 130 astral pairs pushes index 255 mid-surrogate in the extensionless branch.
    const extensionlessOdd = `a${'📎'.repeat(130)}`;
    expect(extensionlessOdd.length).toBe(261);
    const cleanedNoExt = sanitizeNoteAttachmentFilename(extensionlessOdd, 'application/octet-stream');
    expect(cleanedNoExt.length).toBeLessThanOrEqual(NOTE_ATTACHMENT_FILENAME_MAX);
    expect(cleanedNoExt.isWellFormed()).toBe(true);
    expect(() => noteAttachmentContentDisposition(cleanedNoExt, 'application/octet-stream')).not.toThrow();
  });
});
