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
    expect(senderVerified([`${SERVER}; dmarc=pass header.from=khach.test`], undefined, 'khach.test')).toBe(false);
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

  it('reads results, not the text a sender put in a comment or a quoted string', () => {
    // An envelope sender with a quoted local part, and an SPF comment that repeats it: the ";" and the "dmarc=pass" inside them are not results.
    const quoted = `${SERVER}; spf=pass smtp.mailfrom="x; dmarc=pass header.from=victim.test"@evil.test; dmarc=fail header.from=victim.test`;
    expect(senderVerified([quoted], SERVER, 'victim.test')).toBe(false);
    const commented = `${SERVER}; spf=pass (domain of "x; dmarc=pass header.from=victim.test"@evil.test designates 192.0.2.1 as permitted sender) smtp.mailfrom=evil.test; dmarc=fail header.from=victim.test`;
    expect(senderVerified([commented], SERVER, 'victim.test')).toBe(false);
    // Nested comments, quoted pairs, and a value that is not closed.
    expect(senderVerified([`${SERVER}; spf=pass (a (b; dmarc=pass header.from=victim.test) c) smtp.mailfrom=evil.test`], SERVER, 'victim.test')).toBe(false);
    expect(senderVerified([`${SERVER}; dmarc=fail (unclosed ; dmarc=pass header.from=victim.test`], SERVER, 'victim.test')).toBe(false);
    expect(senderVerified([`${SERVER}; dmarc=fail "unclosed ; dmarc=pass header.from=victim.test`], SERVER, 'victim.test')).toBe(false);
    // OpenDKIM writes a comment with a ";" in it, and the pass still counts.
    expect(senderVerified([`${SERVER}; dkim=pass (2048-bit key; unprotected) header.d=khach.test header.b=abcd`], SERVER, 'khach.test')).toBe(true);
    // A method only counts at the start of its own result.
    expect(senderVerified([`${SERVER}; spf=pass smtp.helo=dmarc=pass header.from=khach.test`], SERVER, 'khach.test')).toBe(false);
  });

  it('reads a quoted property value, and stops at a malformed header of ours instead of reading the one below it', () => {
    expect(senderVerified([`${SERVER}; dmarc=pass header.from="khach.test"`], SERVER, 'khach.test')).toBe(true);
    expect(senderVerified([`${SERVER}; dkim=pass header.d="khach.test"`], SERVER, 'khach.test')).toBe(true);
    // A quoted value that is not a plain domain is blanked, so it cannot carry a result.
    expect(senderVerified([`${SERVER}; dmarc=pass header.from="khach.test; dmarc=pass"`], SERVER, 'khach.test')).toBe(false);
    // The topmost header of ours is malformed (an unclosed comment): the verdict is no, and a clean header of ours below it is not consulted.
    expect(senderVerified([`${SERVER}; spf=pass (unclosed`, `${SERVER}; dmarc=pass header.from=khach.test`], SERVER, 'khach.test')).toBe(false);
    expect(senderVerified([`(unclosed ${SERVER}; dmarc=pass header.from=khach.test`, `${SERVER}; dmarc=pass header.from=khach.test`], SERVER, 'khach.test')).toBe(false);
    // The authserv-id after a comment is still ours; a quoted one too.
    expect(senderVerified([`(a comment) ${SERVER}; dmarc=pass header.from=khach.test`], SERVER, 'khach.test')).toBe(true);
    expect(senderVerified([`"${SERVER}"; dmarc=pass header.from=khach.test`], SERVER, 'khach.test')).toBe(true);
  });

  it('ties a DMARC pass to the From domain', () => {
    expect(senderVerified([`${SERVER}; dmarc=pass header.from=other.test`], SERVER, 'victim.test')).toBe(false);
    expect(senderVerified([`${SERVER}; dmarc=pass`], SERVER, 'victim.test')).toBe(false);
    expect(senderVerified([`${SERVER}; dmarc=pass header.from=victim.test`], SERVER, 'victim.test')).toBe(true);
  });

  it('believes only a header written by our own server: a pass any other hop wrote says nothing', () => {
    expect(senderVerified(['mx.evil.test; dmarc=pass header.from=khach.test'], SERVER, 'khach.test')).toBe(false);
    expect(senderVerified(['mx.evil.test; dmarc=pass header.from=khach.test', `${SERVER}; dmarc=fail`], SERVER, 'khach.test')).toBe(false);
    // The topmost header of ours decides: one an earlier hop wrote further down, claiming our name, is not read.
    expect(senderVerified([`${SERVER}; dmarc=fail`, `${SERVER}; dmarc=pass header.from=khach.test`], SERVER, 'khach.test')).toBe(false);
    expect(senderVerified(['mx.evil.test; dmarc=pass header.from=khach.test', `${SERVER}; dmarc=pass header.from=khach.test`], SERVER, 'khach.test')).toBe(true);
    // The name is the first token only, case aside; a comment or a longer name is not ours.
    expect(senderVerified([`MX.EXAMPLE.TEST 1; dmarc=pass header.from=khach.test`], SERVER, 'khach.test')).toBe(true);
    expect(senderVerified([`${SERVER}.evil.test; dmarc=pass header.from=khach.test`], SERVER, 'khach.test')).toBe(false);
  });
});

describe('conversationEventOf', () => {
  const base = { from: 'khach@mau.test', fromName: null, subject: 'Hỏi giá', messageId: '<m1@mau.test>', inReplyTo: null, references: [], text: 'Xin chào', attachments: [], deliveredTo: null, to: [], sentAt: null, automated: false };
  const now = new Date('2026-11-03T10:00:00Z');

  it('dates a mail by its Date header, up to a few minutes ahead, and by its arrival otherwise', () => {
    const at = (sentAt: string | null) => {
      const made = conversationEventOf({ ...base, sentAt }, 'ab', 'in.test', now, SERVER);
      return 'event' in made ? made.event.at : null;
    };
    expect(at('2026-11-03T09:00:00.000Z')).toBe('2026-11-03T09:00:00.000Z');
    expect(at('2019-01-01T00:00:00.000Z')).toBe('2019-01-01T00:00:00.000Z');
    expect(at('2030-01-01T00:00:00.000Z')).toBe('2026-11-03T10:00:00.000Z');
    expect(at(null)).toBe('2026-11-03T10:00:00.000Z');
  });

  it('keeps In-Reply-To last among the references so a long References list never cuts it, and takes a NUL out of the subject and the name', () => {
    const references = Array.from({ length: 50 }, (_, i) => `<r${i}@mau.test>`);
    const made = conversationEventOf({ ...base, references, inReplyTo: '<parent@mau.test>', subject: 'Hỏi\u0000giá', fromName: 'Chị\u0000Hoa' }, 'ab', 'in.test', now, SERVER);
    if (!('event' in made)) throw new Error('ignored');
    expect(made.event.refs?.at(-1)).toBe('<parent@mau.test>');
    expect(made.event.refs?.length).toBe(50);
    expect(made.event.subject).toBe('Hỏi giá');
    expect(made.event.contact.name).toBe('Chị Hoa');
  });

  it('ignores a sender that is not one mailbox, and marks a verified one', () => {
    expect(conversationEventOf({ ...base, from: 'a@x.test,b@y.test' }, 'ab', 'in.test', now, SERVER)).toEqual({ ignored: 'no_sender' });
    expect(conversationEventOf({ ...base, from: '"a b"@x.test' }, 'ab', 'in.test', now, SERVER)).toEqual({ ignored: 'no_sender' });
    // A valid address longer than a contact id may be is ignored, not left to fail the whole intake and lose the mail.
    expect(conversationEventOf({ ...base, from: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(50)}.test` }, 'ab', 'in.test', now, SERVER)).toEqual({ ignored: 'no_sender' });
    const verified = conversationEventOf({ ...base, authResults: [`${SERVER}; dmarc=pass header.from=mau.test`] }, 'ab', 'in.test', now, SERVER);
    expect(verified).toMatchObject({ event: { verified: true, contact: { id: 'khach@mau.test' } } });
    const unverified = conversationEventOf(base, 'ab', 'in.test', now, SERVER);
    expect(unverified).toMatchObject({ event: { verified: false } });
  });
});
