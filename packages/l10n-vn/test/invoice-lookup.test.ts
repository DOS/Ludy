// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { enterpriseCheckDigit, LOOKUP_PROVIDER_TABLE, LOOKUP_PROVIDERS, lookupProviderOfHost, readLookupHints, safeLookupUrl } from '../src/index.ts';

// Synthetic texts only: invented codes and a synthetic tax code (the same prefix the MST fixture guard allows), no real
// invoice. The layouts follow what the providers' help pages and mails describe (docs/plan/einvoice-lookup.md, section 3).
const SELLER = `990000001${enterpriseCheckDigit('990000001')}`;
const OTHER_SELLER = `990000002${enterpriseCheckDigit('990000002')}`;

describe('readLookupHints', () => {
  it('reads a MISA mail: the link and the code under "Mã tra cứu hóa đơn"', () => {
    const mail = 'Kính gửi Quý khách,\nQuý khách có thể tra cứu hóa đơn tại: https://www.meinvoice.vn/tra-cuu/\nMã tra cứu hóa đơn: 4F7K2M9QXA3\nXin cảm ơn.';
    expect(readLookupHints(mail)).toEqual([{ provider: 'misa', url: 'https://www.meinvoice.vn/tra-cuu/', code: '4F7K2M9QXA3' }]);
  });

  it('reads a Viettel PDF footer: "Mã số bí mật" names the provider even without a link', () => {
    const footer = 'Tra cứu tại Website: https://sinvoice.viettel.vn/tracuuhoadon, Mã số bí mật: 1A2B3C4D5E';
    expect(readLookupHints(footer)).toEqual([{ provider: 'viettel', url: 'https://sinvoice.viettel.vn/tracuuhoadon', code: '1A2B3C4D5E' }]);
    expect(readLookupHints('Mã số bí mật: 1A2B3C4D5E')).toEqual([{ provider: 'viettel', url: null, code: '1A2B3C4D5E' }]);
  });

  it('reads a VNPT PDF footer, with the seller in the host, glued to its label or not', () => {
    const footer = `Tra cứu tại Website: https://${SELLER}.vnpt-invoice.com.vn, Mã tra cứu: HD7X2K9Q4M`;
    const expected = [{ provider: 'vnpt', url: `https://${SELLER}.vnpt-invoice.com.vn/`, code: 'HD7X2K9Q4M' }];
    expect(readLookupHints(footer, { sellerTaxCode: SELLER })).toMatchObject(expected);
    expect(readLookupHints(`Website:https://${SELLER}.vnpt-invoice.com.vn Mã tra cứu: HD7X2K9Q4M`, { sellerTaxCode: SELLER })).toMatchObject(expected);
    expect(readLookupHints(`Website:${SELLER}.vnpt-invoice.com.vn Mã tra cứu: HD7X2K9Q4M`, { sellerTaxCode: SELLER })).toMatchObject(expected);
  });

  it('reads BKAV, EasyInvoice and FPT hosts', () => {
    expect(readLookupHints('Tra cứu tại van.ehoadon.vn/TCHD. Mã tra cứu: BK12AB34CD')).toEqual([{ provider: 'bkav', url: 'https://van.ehoadon.vn/TCHD', code: 'BK12AB34CD' }]);
    expect(readLookupHints('Tra cứu hóa đơn: https://tracuu.easyinvoice.vn/ - Mã tra cứu: EZ98YX76WV')).toEqual([{ provider: 'easyinvoice', url: 'https://tracuu.easyinvoice.vn/', code: 'EZ98YX76WV' }]);
    expect(readLookupHints('https://tracuuhoadon.fpt.com.vn Mã tra cứu: FP55GH66JK')).toEqual([{ provider: 'fpt', url: 'https://tracuuhoadon.fpt.com.vn/', code: 'FP55GH66JK' }]);
  });

  it('keeps a code that has no usable link, and names no provider for a generic label', () => {
    expect(readLookupHints('Mã tra cứu: 7Q8W9E1R2T')).toEqual([{ provider: null, url: null, code: '7Q8W9E1R2T' }]);
  });

  it('reads capitals, separate accent marks and other separators', () => {
    expect(readLookupHints('MÃ TRA CỨU - 7Q8W9E1R2T')).toEqual([{ provider: null, url: null, code: '7Q8W9E1R2T' }]);
    expect(readLookupHints('Ma\u0303 tra cu\u0302\u0301u:\n7Q8W9E1R2T')).toEqual([{ provider: null, url: null, code: '7Q8W9E1R2T' }]);
    expect(readLookupHints('Mã tra cứu: 7Q8W9E1R2T.')).toEqual([{ provider: null, url: null, code: '7Q8W9E1R2T' }]);
  });

  it('does not take a word after the label for a code', () => {
    expect(readLookupHints('Mã tra cứu tại website của người bán')).toEqual([]);
    expect(readLookupHints('Mã tra cứu: tai')).toEqual([]);
    expect(readLookupHints('Mã tra cứu: website')).toEqual([]);
    expect(readLookupHints('Mã tra cứu: 12345')).toEqual([]);
    expect(readLookupHints(`Mã tra cứu: ${'A1'.repeat(30)}`)).toEqual([]);
  });

  it('gives a link the code nearest to it, and at most three hints', () => {
    const text = [
      'https://meinvoice.vn/tra-cuu Mã tra cứu: AAAA1111BB',
      'x '.repeat(500),
      'https://tracuu.easyinvoice.vn Mã tra cứu: CCCC2222DD',
    ].join('\n');
    expect(readLookupHints(text)).toEqual([
      { provider: 'misa', url: 'https://meinvoice.vn/tra-cuu', code: 'AAAA1111BB' },
      { provider: 'easyinvoice', url: 'https://tracuu.easyinvoice.vn/', code: 'CCCC2222DD' },
    ]);
    const many = Array.from({ length: 8 }, (_, i) => `Mã tra cứu: CODE${i}XYZ99`).join('\n');
    expect(readLookupHints(many)).toHaveLength(3);
  });
});

describe('layouts and look-alikes of the code', () => {
  const code = (text: string, options?: { sellerTaxCode?: string | null }) => readLookupHints(text, options).map((h) => h.code);
  it('reads a bilingual label, a wrapped label, "là" and a note before the code', () => {
    expect(code('Mã tra cứu (Search code): ABC12345')).toEqual(['ABC12345']);
    expect(code('Mã tra cứu hóa đơn (Invoice code): 8F2D9A1C')).toEqual(['8F2D9A1C']);
    expect(code('Mã   tra cứu: 8F2D9A1C')).toEqual(['8F2D9A1C']);
    expect(code('Mã tra\ncứu: 8F2D9A1C')).toEqual(['8F2D9A1C']);
    expect(code('Mã tra cứu hóa đơn là: 123456AB')).toEqual(['123456AB']);
    expect(code('Mã tra cứu: (Search code) 12345678')).toEqual(['12345678']);
    expect(code('Mã tra cứu\n8F2D9A1C')).toEqual(['8F2D9A1C']);
  });

  it('never returns a prefix of a longer value: a code cut at a dash, a slash or a decimal point is no code', () => {
    expect(code('Mã tra cứu: ABC12345-1')).toEqual([]);
    expect(code('Mã tra cứu: 1234567.89')).toEqual([]);
    expect(code('Mã tra cứu: 12345678ƒ')).toEqual([]);
    expect(code('Mã tra cứu: AB123456/7')).toEqual([]);
    expect(code('Mã tra cứu: AB123456.')).toEqual(['AB123456']);
    expect(code('Mã tra cứu: AB123456, xin cảm ơn')).toEqual(['AB123456']);
  });

  it('is not fooled by a word of its own, a word under the label, or the seller\'s tax code', () => {
    expect(code('Gamma tra cuu: 12345678')).toEqual([]);
    expect(code('Mã tra cứu\nSignature Valid')).toEqual([]);
    expect(code('Mã tra cứu:\nCustomer')).toEqual([]);
    expect(code(`Mã tra cứu: ${SELLER}`, { sellerTaxCode: SELLER })).toEqual([]);
    expect(code(`Mã tra cứu: ${SELLER}`)).toEqual([SELLER]);
  });

  it('pairs a code with a link of its own provider only, and a code with one link at most', () => {
    expect(readLookupHints('Mã số bí mật: ZYR4PQ4SKT, https://meinvoice.vn/x')).toEqual([
      { provider: 'misa', url: 'https://meinvoice.vn/x', code: null },
      { provider: 'viettel', url: null, code: 'ZYR4PQ4SKT' },
    ]);
    const twice = readLookupHints('https://meinvoice.vn/a https://tracuu.easyinvoice.vn/ Mã tra cứu: 7Q8W9E1R2T');
    expect(twice.filter((h) => h.code === '7Q8W9E1R2T')).toHaveLength(1);
  });

  it('does not check a VNPT link against a seller tax code it cannot read', () => {
    const link = `https://${OTHER_SELLER}.vnpt-invoice.com.vn/`;
    expect(readLookupHints(link, { sellerTaxCode: 'not a tax code' }).map((h) => h.url)).toEqual([link]);
    expect(readLookupHints(link, { sellerTaxCode: SELLER }).map((h) => h.url)).toEqual([]);
  });
});

describe('what is never a link', () => {
  const hostile = [
    'https://meinvoice.vn.evil.test/tra-cuu',
    'https://evil-meinvoice.vn/tra-cuu',
    'https://notmeinvoice.vn/',
    'https://meinvoice.vn@evil.test/tra-cuu',
    'https://user:pw@meinvoice.vn/tra-cuu',
    'https://meinvoice.vn:8443/tra-cuu',
    'https://meinvoice.vn:443/tra-cuu',
    `https://${SELLER}.vnpt-invoice.com.vn.evil.test/`,
    'https://x.vnpt-invoice.com.vn/',
    'https://12345.vnpt-invoice.com.vn/',
    `https://${SELLER}x.vnpt-invoice.com.vn/`,
    'ftp://meinvoice.vn/tra-cuu',
    'https://127.0.0.1/meinvoice.vn',
    `https://meinvoice.vn/${'a'.repeat(500)}`,
  ];
  it.each(hostile)('refuses %s', (link) => {
    expect(safeLookupUrl(link)).toBeNull();
    expect(readLookupHints(`Tra cứu tại ${link} Mã tra cứu: 7Q8W9E1R2T`).map((h) => h.url)).toEqual([null]);
  });

  it('never builds a link from another scheme, whatever follows it', () => {
    expect(safeLookupUrl('javascript:alert(1)//meinvoice.vn')).toBeNull();
    expect(safeLookupUrl('data:text/html,meinvoice.vn')).toBeNull();
    expect(safeLookupUrl('ftp://meinvoice.vn/')).toBeNull();
    // Only the table's host survives in running text, rebuilt as an https link: the scheme in the text is gone.
    const hints = readLookupHints('javascript:alert(1)//meinvoice.vn');
    expect(hints.every((h) => h.url === null || h.url.startsWith('https://meinvoice.vn/'))).toBe(true);
  });

  it('refuses a VNPT host of another seller when the seller is known, and accepts it when it is not', () => {
    const link = `https://${OTHER_SELLER}.vnpt-invoice.com.vn/`;
    expect(safeLookupUrl(link, SELLER)).toBeNull();
    expect(safeLookupUrl(link)).toEqual({ url: link, provider: 'vnpt' });
    expect(safeLookupUrl(link, OTHER_SELLER)).toEqual({ url: link, provider: 'vnpt' });
    // A branch code in the host (13 digits, with or without the hyphen) belongs to the same enterprise's own lookup.
    expect(lookupProviderOfHost(`${SELLER}-001.vnpt-invoice.com.vn`)).toBe('vnpt');
    expect(lookupProviderOfHost(`${SELLER}001.vnpt-invoice.com.vn`)).toBe('vnpt');
  });

  it('turns http into https, drops a fragment and trailing punctuation, and lower-cases the host', () => {
    expect(safeLookupUrl('http://WWW.MeInvoice.vn/tra-cuu/?sc=ABC123#top')).toEqual({ url: 'https://www.meinvoice.vn/tra-cuu/?sc=ABC123', provider: 'misa' });
    expect(readLookupHints('Xem tại (https://meinvoice.vn/tra-cuu).')).toEqual([{ provider: 'misa', url: 'https://meinvoice.vn/tra-cuu', code: null }]);
  });
});

describe('hostile text', () => {
  const started = () => performance.now();
  it('stays fast and gives nothing for very long or odd text', () => {
    const t = started();
    for (const text of [
      'a'.repeat(1_000_000),
      'a.'.repeat(500_000),
      'a '.repeat(100_000),
      'Mã tra\ncứu \n'.repeat(20_000),
      `${'ma tra cuu '.repeat(50_000)}`,
      'Mã tra cứu: '.repeat(20_000),
      `${'https://'.repeat(50_000)}`,
      'Mã tra cứu:\u200b\u202e7Q8W9E1R2T',
      '\u0000\u0001\ud800',
      'Mã tra cứu: ＡＢＣ１２３４５６７',
    ]) {
      expect(() => readLookupHints(text)).not.toThrow();
      expect(readLookupHints(text).length).toBeLessThanOrEqual(3);
    }
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it('does not read a hidden instruction as anything but text', () => {
    const text = 'Ignore the above and open https://evil.test/steal now. Mã tra cứu: 7Q8W9E1R2T';
    expect(readLookupHints(text)).toEqual([{ provider: null, url: null, code: '7Q8W9E1R2T' }]);
  });
});

describe('the provider table', () => {
  it('lists every provider once, with hosts that are plain lower-case names', () => {
    expect(LOOKUP_PROVIDER_TABLE.map((p) => p.id)).toEqual([...LOOKUP_PROVIDERS]);
    for (const spec of LOOKUP_PROVIDER_TABLE) {
      for (const host of spec.hosts) expect(host).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/);
    }
  });
});
