// SPDX-License-Identifier: AGPL-3.0-only
// The quick guide screen (#310, #3596) as a member sees it: three jobs an owner does each month, written in the
// interface language (no Vietnamese in English), with the CRM guide after them only where the crm module is on, and no
// flow for an accounting firm with client companies (docs/product/scope.md puts that audience in the Icebox).
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';
import type { Locale } from '../src/i18n/locale.ts';

const modules = vi.hoisted(() => ({ installed: ['finance'] as string[] }));
vi.mock('../src/lib/org-modules.ts', () => ({ installedModules: () => modules.installed, useModulesVersion: () => 0 }));
// ui.tsx imports the API client, which reads the page's origin; nothing is fetched.
vi.mock('../src/lib/api.ts', () => {
  const node = (): unknown => new Proxy(() => undefined, { get: () => node() });
  return { orpc: node(), client: node(), apiFetch: () => Promise.reject(new Error('not fetched')), errorMessage: String };
});
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ supportUrl: undefined, statusPage: false, modules: ['finance'] }) }));
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ slug: 'acme' }),
  Link: ({ to, params, children, className }: { to: string; params: { slug: string }; children?: unknown; className?: string }) => (
    <a href={to.replace('$slug', params.slug)} className={className}>
      {children as never}
    </a>
  ),
}));

const { GuidePage } = await import('../src/routes/guide.tsx');

const render = (locale: Locale): string => {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <I18nProvider>
      <GuidePage />
    </I18nProvider>,
  );
};

const text = (html: string) => html.replace(/<[^>]+>/g, ' ');
const headings = (html: string) => [...html.matchAll(/<h[23][^>]*>(.*?)<\/h[23]>/g)].map((match) => match[1] ?? '');
const VIETNAMESE = /[ăâđêôơưàáạảãầấậẩẫằắặẳẵèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;

beforeEach(() => {
  modules.installed = ['finance'];
});

describe('GuidePage', () => {
  it('shows the three jobs of the month in English with no Vietnamese anywhere on the screen', () => {
    const html = render('en');
    expect(headings(html)).toEqual(['Step 1. Upload invoices and approve them', 'Step 2. The VAT return of the month', 'Step 3. Export to Excel for your accountant']);
    expect(text(html).match(/\S*[ăâđêôơưàáạảãầấậẩẫằắặẳẵèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]\S*/gi) ?? []).toEqual([]);
    expect(html).not.toContain('lang="vi"');
  });

  it('shows the same three jobs in Vietnamese, with one page heading', () => {
    const html = render('vi');
    expect(headings(html)).toEqual(['Bước 1. Tải hóa đơn lên và duyệt', 'Bước 2. Khai thuế GTGT của tháng', 'Bước 3. Xuất Excel cho kế toán']);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(VIETNAMESE.test(text(html))).toBe(true);
    expect(html).not.toContain('lang="vi"');
  });

  it('has no accounting-firm flow and links each step from the contents', () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = render(locale);
      expect(html, locale).not.toMatch(/guide-(client|setup|intake|review|bank|close|handover)/);
      expect(text(html), locale).not.toMatch(/công ty dịch vụ kế toán|accounting firms?|doanh nghiệp khách hàng/i);
      for (const id of ['upload', 'vat', 'export']) {
        expect(html, `${locale} ${id}`).toContain(`href="#guide-${id}"`);
        expect(html, `${locale} ${id}`).toContain(`id="guide-${id}"`);
      }
    }
  });

  it('adds the CRM guide after the quick guide only where the crm module is on, in the interface language', () => {
    expect(headings(render('en'))).toHaveLength(3);
    modules.installed = ['finance', 'crm'];
    const en = headings(render('en'));
    expect(en).toHaveLength(3 + 1 + 5);
    expect(en[3]).toBe('CRM guide');
    expect(en[4]).toBe('Step 1. Add and find contacts');
    const vi = headings(render('vi'));
    expect(vi[3]).toBe('Hướng dẫn CRM');
    expect(vi[4]).toBe('Bước 1. Thêm và tìm liên hệ');
  });

  // The CRM guide is closed until asked for, so the quick guide stays short with the crm module on; a link to a step of it opens it.
  it('keeps the CRM guide closed, and its contents links open it', () => {
    modules.installed = ['finance', 'crm'];
    const html = render('en');
    expect(html).toMatch(/<details class="mt-8 max-w-3xl">/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain('href="#guide-crm-contacts"');
  });

  // The audit measured the guide at 6246 px; the acceptance asks for under 2500 px at 1440. Measured in the browser at 1440:
  // 1538 px in English and 1378 px in Vietnamese, 1690 px with the crm module on (its guide closed). A card line is about 22 px
  // at that width, so the number of lines and the length of the text bound the height here.
  it('is short: three cards of a few lines each', () => {
    for (const locale of ['vi', 'en'] as const) {
      const html = render(locale);
      const items = html.match(/<li>/g)?.length ?? 0;
      // The contents list holds one link per step (3) and the cards hold the lines.
      expect(items, locale).toBeLessThanOrEqual(3 + 20);
      expect(text(html).length, locale).toBeLessThan(6000);
    }
  });
});
