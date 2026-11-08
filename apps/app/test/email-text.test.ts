// SPDX-License-Identifier: AGPL-3.0-only
// An email as a chat bubble (#2439): the new text on top and the quoted history and signature folded, with nothing lost.
import { describe, expect, it } from 'vitest';
import { splitQuoted } from '../src/lib/email-text.ts';

describe('splitQuoted', () => {
  it('keeps a mail with no quote whole', () => {
    expect(splitQuoted('Cho tôi hỏi giá gạo ST25.\n\nCảm ơn.')).toEqual({ fresh: 'Cho tôi hỏi giá gạo ST25.\n\nCảm ơn.', quoted: '' });
  });

  it('folds the history under "On ... wrote:" and its Vietnamese form, also when the client wraps the line', () => {
    const english = splitQuoted('Tôi lấy 10 ký.\n\nOn Tue, 3 Nov 2026 at 09:00, Shop <shop@x.test> wrote:\n> Giá 25.000\n> Cảm ơn');
    expect(english.fresh).toBe('Tôi lấy 10 ký.');
    expect(english.quoted).toContain('Giá 25.000');
    const wrapped = splitQuoted('Ok.\n\nOn Tue, 3 Nov 2026 at 09:00, Shop <shop@x.test>\nwrote:\n> Giá 25.000');
    expect(wrapped.fresh).toBe('Ok.');
    const vietnamese = splitQuoted('Đồng ý.\n\nVào Th 3, 3 Th11, 2026 lúc 09:00 Cửa hàng <shop@x.test> đã viết:\n> Giá 25.000');
    expect(vietnamese).toMatchObject({ fresh: 'Đồng ý.' });
    expect(vietnamese.quoted).toContain('> Giá 25.000');
  });

  it('folds an original-message rule, a repeated header block, a trailing quote block and the signature', () => {
    expect(splitQuoted('Xin chào.\n\n-----Original Message-----\nFrom: a\nSent: b').fresh).toBe('Xin chào.');
    expect(splitQuoted('Xin chào.\n\nFrom: Shop <shop@x.test>\nSent: Tuesday\nTo: me\nSubject: Giá').fresh).toBe('Xin chào.');
    expect(splitQuoted('Xin chào.\n> trích dẫn\n> thêm').fresh).toBe('Xin chào.');
    const signed = splitQuoted('Gửi anh.\n\n-- \nNguyễn Văn A\n0912345678');
    expect(signed.fresh).toBe('Gửi anh.');
    expect(signed.quoted).toContain('0912345678');
  });

  it('keeps a sentence that merely begins with "From:" and a quote in the middle of the text', () => {
    expect(splitQuoted('From: tháng sau tôi sẽ lấy hàng nhiều hơn.\nCảm ơn.').quoted).toBe('');
    const middle = splitQuoted('> dòng đầu\nTrả lời xen kẽ.\n> dòng sau\nVà thêm một dòng nữa.');
    expect(middle.quoted).toBe('');
  });

  it('stays fast on a mail of thousands of quote lines', () => {
    const started = Date.now();
    const body = `${'> trích dẫn\n'.repeat(10_000)}một dòng thường`;
    expect(splitQuoted(body).quoted).toBe('');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('shows a mail that is all quote whole, so no bubble is empty', () => {
    const all = splitQuoted('> chỉ có trích dẫn');
    expect(all).toEqual({ fresh: '> chỉ có trích dẫn', quoted: '' });
  });
});
