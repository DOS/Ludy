// SPDX-License-Identifier: AGPL-3.0-only
// Who a customer mail is from (#2439, security review of #2528): one mailbox only, and a sender is verified only on the word of our own receiving server.
import { describe, expect, it } from 'vitest';
import { isMailAddress } from '@crove/kernel-contract';
import { conversationEventOf, senderVerified } from '../src/inbound.ts';

const SERVER = 'mx.example.test';

describe('isMailAddress', () => {
  it('accepts one plain address', () => {
    for (const ok of ['khach@mau.test', 'a.b+tag@sub.mau.test', "o'neil@mau.test", 'x@a-b.example.vn']) expect(isMailAddress(ok), ok).toBe(true);
  });

  it('refuses a list, a display name, a quoted or commented address, and malformed ones', () => {
    const bad = [
      'a@x.test,b@y.test',
      'a@x.test;b@y.test',
      'a@x.test b@y.test',
      '<a@x.test>',
      'A <a@x.test>',
      '"a b"@x.test',
      'a@x.test (c)',
      'a@@x.test',
      '@x.test',
      'a@',
      'a@x',
      'a@-x.test',
      'a@x..test',
      '.a@x.test',
      'a..b@x.test',
      `${'a'.repeat(65)}@x.test`,
      `a@${'b'.repeat(64)}.test`,
      '',
    ];
    for (const value of bad) expect(isMailAddress(value), value).toBe(false);
  });
});

describe('senderVerified', () => {
  it('believes nothing when no server name is configured', () => {
    expect(senderVerified([`${SERVER}; dmarc=pass`], undefined, 'khach.test')).toBe(false);
  });

  it('believes dmarc=pass, or an aligned dkim=pass, written by our own server', () => {
    expect(senderVerified([`${SERVER}; dmarc=pass header.from=khach.test`], SERVER, 'khach.test')).toBe(true);
    expect(senderVerified([`${SERVER}; spf=fail; dkim=pass header.d=khach.test header.s=s1`], SERVER, 'khach.test')).toBe(true);
    // A signing domain that is a parent of the From domain aligns; a different one does not.
    expect(senderVerified([`${SERVER}; dkim=pass header.d=khach.test`], SERVER, 'mail.khach.test')).toBe(true);
    expect(senderVerified([`${SERVER}; dkim=pass header.d=other.test`], SERVER, 'khach.test')).toBe(false);
    expect(senderVerified([`${SERVER}; dkim=pass header.d=khach.test`], SERVER, 'evilkhach.test')).toBe(false);
  });

  it('does not believe a failure, a neutral result, spf alone, or a header with no verdict', () => {
    expect(senderVerified([`${SERVER}; dmarc=fail`], SERVER, 'khach.test')).toBe(false);
    expect(senderVerified([`${SERVER}; dkim=fail header.d=khach.test; dmarc=none`], SERVER, 'khach.test')).toBe(false);
    expect(senderVerified([`${SERVER}; spf=pass smtp.mailfrom=khach.test`], SERVER, 'khach.test')).toBe(false);
    expect(senderVerified([`${SERVER}; none`], SERVER, 'khach.test')).toBe(false);
    expect(senderVerified([], SERVER, 'khach.test')).toBe(false);
  });

  it('believes only a header written by our own server: a pass any other hop wrote says nothing', () => {
    expect(senderVerified(['mx.evil.test; dmarc=pass'], SERVER, 'khach.test')).toBe(false);
    expect(senderVerified(['mx.evil.test; dmarc=pass', `${SERVER}; dmarc=fail`], SERVER, 'khach.test')).toBe(false);
    // The topmost header of ours decides: one an earlier hop wrote further down, claiming our name, is not read.
    expect(senderVerified([`${SERVER}; dmarc=fail`, `${SERVER}; dmarc=pass`], SERVER, 'khach.test')).toBe(false);
    expect(senderVerified(['mx.evil.test; dmarc=pass', `${SERVER}; dmarc=pass`], SERVER, 'khach.test')).toBe(true);
    // The name is the first token only, case aside; a comment or a longer name is not ours.
    expect(senderVerified([`MX.EXAMPLE.TEST 1; dmarc=pass`], SERVER, 'khach.test')).toBe(true);
    expect(senderVerified([`${SERVER}.evil.test; dmarc=pass`], SERVER, 'khach.test')).toBe(false);
  });
});

describe('conversationEventOf', () => {
  const base = { from: 'khach@mau.test', fromName: null, subject: 'Hỏi giá', messageId: '<m1@mau.test>', inReplyTo: null, references: [], text: 'Xin chào', attachments: [], deliveredTo: null, to: [], sentAt: null, automated: false };
  const now = new Date('2026-11-03T10:00:00Z');

  it('ignores a sender that is not one mailbox, and marks a verified one', () => {
    expect(conversationEventOf({ ...base, from: 'a@x.test,b@y.test' }, 'ab', 'in.test', now, SERVER)).toEqual({ ignored: 'no_sender' });
    expect(conversationEventOf({ ...base, from: '"a b"@x.test' }, 'ab', 'in.test', now, SERVER)).toEqual({ ignored: 'no_sender' });
    const verified = conversationEventOf({ ...base, authResults: [`${SERVER}; dmarc=pass header.from=mau.test`] }, 'ab', 'in.test', now, SERVER);
    expect(verified).toMatchObject({ event: { verified: true, contact: { id: 'khach@mau.test' } } });
    const unverified = conversationEventOf(base, 'ab', 'in.test', now, SERVER);
    expect(unverified).toMatchObject({ event: { verified: false } });
  });
});
