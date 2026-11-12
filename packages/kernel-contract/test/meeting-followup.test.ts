// SPDX-License-Identifier: AGPL-3.0-only
// The words checks of the follow-up email (L3, #2590): the send command applies them to every text whatever its origin, so they are the gate and "from Vy" is not.
import { describe, expect, it } from 'vitest';
import {
  FOLLOWUP_CLOSING_MAX,
  FOLLOWUP_GREETING_MAX,
  FOLLOWUP_SUBJECT_MAX,
  followupAddress,
  followupClean,
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

describe('the send and mail shapes', () => {
  it('holds a send to twenty recipients and refuses unknown fields', () => {
    const base = { meetingId: '00000000-0000-4000-8000-000000000001', factsKey: 'k', subject: 's', greeting: 'g', lead: 'l', closing: 'c', recipients: ['a@b.test'], confirmedOutsiders: [], confirmRepeat: false, fromVy: false, reviewed: false };
    expect(zFollowupSend.safeParse(base).success).toBe(true);
    expect(zFollowupSend.safeParse({ ...base, recipients: Array.from({ length: 21 }, (_, i) => `a${i}@b.test`) }).success).toBe(false);
    expect(zFollowupSend.safeParse({ ...base, recipients: [] }).success).toBe(false);
    expect(zFollowupSend.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(zFollowupMail.safeParse({ lang: 'vi', org: 'o', batch: base.meetingId, greeting: 'g', lead: 'l', closing: 'c', facts: { summary: '', decisions: [], items: [] } }).success).toBe(true);
  });
});
