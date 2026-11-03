// SPDX-License-Identifier: AGPL-3.0-only
// The rules that point a person to a company (#2438): which address says something about a company, the word at the heart of a domain, and the tax codes written in
// a text.
import { describe, expect, it } from 'vitest';
import { domainLabelOf, emailDomainOf, taxCodesIn } from '@crove/mod-crm';

describe('emailDomainOf', () => {
  it('reads the domain of an address in lower case, and says nothing for a free mail, no address or a malformed one', () => {
    expect(emailDomainOf('Nam@Acme.com.vn')).toBe('acme.com.vn');
    expect(emailDomainOf('nam@gmail.com')).toBeNull();
    expect(emailDomainOf('nam@yahoo.com.vn')).toBeNull();
    expect(emailDomainOf('nam@mail.ru')).toBeNull();
    expect(emailDomainOf('nam@outlook.com.vn')).toBeNull();
    expect(emailDomainOf(null)).toBeNull();
    expect(emailDomainOf('khong-co-a-cong')).toBeNull();
    expect(emailDomainOf('nam@acme')).toBeNull();
    expect(emailDomainOf('nam@ac me.vn')).toBeNull();
  });
});

describe('domainLabelOf', () => {
  it('takes the label before the public suffix, one or two labels long, and none shorter than three letters', () => {
    expect(domainLabelOf('acme.com')).toBe('acme');
    expect(domainLabelOf('acme.com.vn')).toBe('acme');
    expect(domainLabelOf('mail.acme.com.vn')).toBe('acme');
    expect(domainLabelOf('hr.acme.vn')).toBe('acme');
    expect(domainLabelOf('acme.com.cn')).toBe('acme');
    expect(domainLabelOf('ab.vn')).toBeNull();
    expect(domainLabelOf('com.vn')).toBeNull();
    expect(domainLabelOf('a-b-c.com')).toBeNull();
  });
});

describe('taxCodesIn', () => {
  it('finds each ten-digit tax code once, with its branch suffix, and not a longer number or part of one', () => {
    expect(taxCodesIn('MST 0123456780 và 0123456780-001, số khác 01234567890.')).toEqual(['0123456780', '0123456780-001']);
    expect(taxCodesIn('đơn 20260101123456 giá 1234567890.5')).toEqual([]);
    // A code that ends a sentence counts, as one followed by a comma does.
    expect(taxCodesIn('MST của công ty em là 0123456780.')).toEqual(['0123456780']);
    expect(taxCodesIn('MST: 0123456780, cảm ơn')).toEqual(['0123456780']);
    expect(taxCodesIn('')).toEqual([]);
  });
});
