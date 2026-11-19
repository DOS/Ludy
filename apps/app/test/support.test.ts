// The feedback and support link and the quick guide (issues #310, #3596).
import { describe, expect, it } from 'vitest';
import { LOCALES } from '../src/i18n/locale.ts';
import { SOURCE_CATALOGS } from '../src/i18n/runtime.ts';
import { fill } from '../src/lib/guide-text.ts';
import { quickGuide } from '../src/lib/quick-guide.ts';
import { supportLink } from '../src/lib/support.ts';

describe('support link', () => {
  it('hides the link when the deployment sets none', () => {
    expect(supportLink(undefined)).toBeNull();
    expect(supportLink(null)).toBeNull();
    expect(supportLink('')).toBeNull();
  });

  it('opens an https: page in a new tab and hands a mailto: address to the mail app', () => {
    expect(supportLink('https://chat.example.com/g/crove-pilot')).toEqual({ href: 'https://chat.example.com/g/crove-pilot', external: true });
    expect(supportLink('mailto:support@example.com?subject=Crove')).toEqual({ href: 'mailto:support@example.com?subject=Crove', external: false });
  });

  it('hides any other scheme, a mailto: without an address and a value that is not a URL', () => {
    for (const url of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', 'ftp://example.com', 'mailto:', 'mailto: ', 'not a url', '/support']) {
      expect(supportLink(url), url).toBeNull();
    }
  });
});

// Accented Vietnamese letters: what must not show in the English guide.
const VIETNAMESE = /[ăâđêôơưàáạảãầấậẩẫằắặẳẵèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;

const lines = (locale: 'vi' | 'en', brand = 'Ludy') => quickGuide(brand, locale).flatMap((step) => [step.title, ...step.items]);

describe('quick guide (#310, #3596)', () => {
  it('covers upload and approve, the VAT month and the export, in that order, in both languages', () => {
    for (const locale of LOCALES) {
      const steps = quickGuide('Ludy', locale);
      expect(steps.map((step) => step.id), locale).toEqual(['upload', 'vat', 'export']);
      for (const step of steps) expect(step.items.length, `${locale} ${step.id}`).toBeGreaterThan(0);
    }
    // The same steps, with the same number of lines, whatever the language.
    expect(quickGuide('Ludy', 'en').map((step) => step.items.length)).toEqual(quickGuide('Ludy', 'vi').map((step) => step.items.length));
  });

  it('has a full title in each language', () => {
    expect(quickGuide('Ludy', 'vi').map((step) => step.title)).toEqual(['Bước 1. Tải hóa đơn lên và duyệt', 'Bước 2. Khai thuế GTGT của tháng', 'Bước 3. Xuất Excel cho kế toán']);
    expect(quickGuide('Ludy', 'en').map((step) => step.title)).toEqual(['Step 1. Upload invoices and approve them', 'Step 2. The VAT return of the month', 'Step 3. Export to Excel for your accountant']);
  });

  it('names the buttons the screens show, by the labels of the language it is written in', () => {
    for (const locale of LOCALES) {
      const m = SOURCE_CATALOGS[locale];
      const text = lines(locale).join('\n');
      for (const label of [m.inbox.upload, m.inboxDetail.approve, m.inboxDetail.reject, m.vat.export, m.vat.exportXml, fill(m.periodLock.lock, { month: 'MM/YYYY' }), m.journal.export, m.nav.inbox, m.nav.vat, m.nav.journal]) {
        expect(text, `${locale} ${label}`).toContain(`"${label}"`);
      }
    }
  });

  it('quotes only labels the catalog has, so no quote can drift from its screen', () => {
    for (const locale of LOCALES) {
      // Every string of the catalog, with its placeholders filled as the guide fills them.
      const catalog = new Set<string>();
      const walk = (node: unknown) => {
        if (typeof node === 'string') catalog.add(fill(node, { count: 'N', month: 'MM/YYYY', brand: 'Ludy' }));
        else if (node && typeof node === 'object') Object.values(node).forEach(walk);
      };
      walk(SOURCE_CATALOGS[locale]);
      const quoted = [...lines(locale).join('\n').matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
      expect(quoted.length, locale).toBeGreaterThan(20);
      expect(quoted.filter((label) => !catalog.has(label)), locale).toEqual([]);
    }
  });

  // #3596: the English interface shows no Vietnamese in the guide.
  it('has no Vietnamese in English', () => {
    expect(lines('en').filter((line) => VIETNAMESE.test(line))).toEqual([]);
  });

  it('is Vietnamese with diacritics, and neither language has em dashes, en dashes or an unfilled placeholder', () => {
    expect(lines('vi').filter((line) => !VIETNAMESE.test(line))).toEqual([]);
    for (const locale of LOCALES) {
      for (const line of lines(locale)) {
        expect(line.trim(), line).not.toBe('');
        expect(line, line).not.toMatch(/[–—]/);
        expect(line, line).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    }
  });

  // #1040: the guide names the product by BRAND_NAME, in its own text and in the labels it quotes.
  it('names the product by the brand it is given', () => {
    for (const locale of LOCALES) {
      const renamed = lines(locale, 'Tên Mới').join('\n');
      expect(renamed, locale).toContain('Tên Mới');
      expect(renamed, locale).not.toContain('Crove');
      expect(renamed, locale).not.toMatch(/[{}]/);
    }
  });

  // #3596: docs/product/scope.md sends the accounting firm with many client companies to the Icebox.
  it('has no flow for an accounting firm with client companies', () => {
    for (const locale of LOCALES) {
      const text = lines(locale).join('\n');
      expect(text, locale).not.toMatch(/khách hàng của hãng|doanh nghiệp khách hàng|công ty dịch vụ kế toán|client compan|accounting firm|MISA/i);
      for (const [key] of Object.entries(SOURCE_CATALOGS[locale].guide)) expect(key, locale).not.toMatch(/^firm/);
    }
  });

  it('fills ICU placeholders and leaves unknown ones', () => {
    expect(fill('Duyệt {count, number} đề xuất', { count: 'N' })).toBe('Duyệt N đề xuất');
    expect(fill('Khóa sổ tháng {month}', { month: '09/2026' })).toBe('Khóa sổ tháng 09/2026');
    expect(fill('{a} và {b}', { a: 'x' })).toBe('x và {b}');
    // A placeholder named like an Object.prototype member is not filled from the prototype.
    expect(fill('{toString}', {})).toBe('{toString}');
  });
});
