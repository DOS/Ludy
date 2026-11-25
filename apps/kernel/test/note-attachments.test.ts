// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { NOTE_ATTACHMENT_FILENAME_MAX } from '@ludy/kernel-contract';
import {
  NOTE_ATTACHMENT_CSP,
  classifyNoteAttachment,
  isInlineSafeNoteAttachmentType,
  noteAttachmentContentDisposition,
  sanitizeNoteAttachmentFilename,
} from '../src/note-attachments.ts';

const enc = new TextEncoder();

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

describe('classifyNoteAttachment active-markup sniffing (#4213)', () => {
  it('classifies <svg after a multi-kilobyte XML prolog and comment as image/svg+xml (attachment, skipped)', () => {
    const comment = 'a'.repeat(2048);
    const payload = enc.encode(
      `\ufeff<?xml version="1.0" encoding="utf-8"?>\n<!-- ${comment} -->\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
    );
    const result = classifyNoteAttachment(payload, 'photo.png', 'image/png');
    expect(result).toEqual({ contentType: 'image/svg+xml', extractStatus: 'skipped' });
    expect(isInlineSafeNoteAttachmentType(result.contentType)).toBe(false);
    expect(noteAttachmentContentDisposition('photo.png', result.contentType)).toMatch(/^attachment;/);
    expect(NOTE_ATTACHMENT_CSP).toContain("script-src 'none'");
    expect(NOTE_ATTACHMENT_CSP).toContain('sandbox;');
  });

  it('classifies <!doctype html and <html after a multi-kilobyte comment or preamble as text/html (attachment, skipped)', () => {
    const comment = 'b'.repeat(2048);
    const doctypePayload = enc.encode(`<!-- ${comment} -->\n<!DOCTYPE   html>\n<html><body><script>alert(1)</script></body></html>`);
    const doctypeResult = classifyNoteAttachment(doctypePayload, 'avatar.png', 'image/png');
    expect(doctypeResult).toEqual({ contentType: 'text/html', extractStatus: 'skipped' });
    expect(isInlineSafeNoteAttachmentType(doctypeResult.contentType)).toBe(false);
    expect(noteAttachmentContentDisposition('avatar.png', doctypeResult.contentType)).toMatch(/^attachment;/);

    const htmlTagPayload = enc.encode(`${'x'.repeat(1200)}\n<HTML lang="vi"><script>alert(1)</script></HTML>`);
    const htmlTagResult = classifyNoteAttachment(htmlTagPayload, 'doc.bin', 'application/octet-stream');
    expect(htmlTagResult).toEqual({ contentType: 'text/html', extractStatus: 'skipped' });
    expect(noteAttachmentContentDisposition('doc.bin', htmlTagResult.contentType)).toMatch(/^attachment;/);
  });

  it('keeps xhtml hints as application/xhtml+xml while preserving plain text and markdown extraction', () => {
    const xhtmlPayload = enc.encode(`<?xml version="1.0"?>\n<!-- ${'c'.repeat(1024)} -->\n<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>`);
    expect(classifyNoteAttachment(xhtmlPayload, 'page.xhtml', 'application/xhtml+xml')).toEqual({
      contentType: 'application/xhtml+xml',
      extractStatus: 'skipped',
    });

    const plainText = enc.encode('Biên bản cuộc họp ngày 25/11/2026\nNội dung bình thường không chứa thẻ đánh dấu.');
    expect(classifyNoteAttachment(plainText, 'bien-ban.txt', 'text/plain')).toEqual({
      contentType: 'text/plain',
      extractStatus: 'pending',
    });

    const markdown = enc.encode('# Ghi chú\n\nDanh sách công việc trong tuần.');
    expect(classifyNoteAttachment(markdown, 'notes.md', 'text/markdown')).toEqual({
      contentType: 'text/markdown',
      extractStatus: 'pending',
    });
  });
});
