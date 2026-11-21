// SPDX-License-Identifier: AGPL-3.0-only
// The words and TodayList rendering of eSign items on Home (#3813): every title key `sign.today` emits
// (modules/sign/src/today-and-reminders.ts) has natural bilingual text, renders numeric params cleanly,
// never duplicates coworker names or forbidden terms, and links directly to `/o/<slug>/sign/envelopes/<id>`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayItem } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viCatalog } from '../src/i18n/messages/vi.ts';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale, translatorFor } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});
vi.mock('../src/lib/stream-hook.ts', () => ({ useStreamLive: () => false, pollEvery: () => false, SAFETY_POLL_MS: 300_000 }));
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ history: { push: () => undefined } }),
  Link: ({ to, params, children, className }: { to: string; params: { slug: string }; children?: unknown; className?: string }) => (
    <a href={to.replace('$slug', params.slug)} className={className}>
      {children as never}
    </a>
  ),
}));
vi.mock('../src/lib/org-modules.ts', () => ({ installedModules: () => ['sign'], useModulesVersion: () => 0 }));

const { TodayList } = await import('../src/components/today-list.tsx');

const TITLES: Array<{ key: string; params: Record<string, string | number> }> = [
  { key: 'sign.envelopeDeclinedToday', params: {} },
  { key: 'sign.envelopeDeclinedDays', params: { days: 3 } },
  { key: 'sign.envelopeExpiringHours', params: { hours: 18 } },
  { key: 'sign.more', params: { count: 4 } },
];

type Say = (key: string, values?: Record<string, string | number>) => string;
const sayIn = (lang: 'en' | 'vi'): Say => translatorFor(lang) as unknown as Say;

const source = readFileSync(
  fileURLToPath(new URL('../../../modules/sign/src/today-and-reminders.ts', import.meta.url)),
  'utf8',
);
const sourceKeys = [...new Set([...source.matchAll(/key:\s*'(sign\.[A-Za-z]+)'/g)].map((m) => m[1] as string))];

beforeEach(() => {
  client.current.clear();
});

describe('the eSign items of Home, in words and TodayList (#3813)', () => {
  it('covers every title key emitted by modules/sign/src/today-and-reminders.ts in both catalogs', () => {
    expect(sourceKeys.sort()).toEqual(TITLES.map((t) => t.key).sort());
    for (const [locale, messages] of [
      ['en', en],
      ['vi', viCatalog],
    ] as const) {
      const sign = (messages as unknown as { today: { items: { sign: Record<string, unknown> } } }).today.items.sign;
      for (const fullKey of sourceKeys) {
        const subKey = fullKey.replace(/^sign\./, '');
        expect(typeof sign[subKey], `${locale} ${fullKey}`).toBe('string');
      }
    }
  });

  it('has text in both languages with every param rendered and no coworker or forbidden terms', () => {
    for (const lang of ['en', 'vi'] as const) {
      const say = sayIn(lang);
      for (const title of TITLES) {
        const text = say(`today.items.${title.key}`, title.params);
        expect(text, `${lang} ${title.key}`).not.toContain('today.items');
        expect(text.length, `${lang} ${title.key}`).toBeGreaterThan(10);
        // TodayRow already prints "Từ Vy" / "From Vy" from todayCoworkerKey('sign') === 'gm'.
        expect(text, `${lang} ${title.key}`).not.toMatch(/\b(Vy|Ly|Dy|Uy|Hy)\b/);
        expect(text, `${lang} ${title.key}`).not.toMatch(/assistant|trợ lý/i);
        for (const [name, value] of Object.entries(title.params)) {
          expect(text, `${lang} ${title.key} ${name}`).toContain(String(value));
        }
      }
    }
  });

  it('renders singular and plural hour, day, and count forms cleanly', () => {
    const enSay = sayIn('en');
    const viSay = sayIn('vi');
    expect(enSay('today.items.sign.envelopeExpiringHours', { hours: 1 })).toBe('A signing envelope expires in 1 hour');
    expect(enSay('today.items.sign.envelopeExpiringHours', { hours: 24 })).toBe('A signing envelope expires in 24 hours');
    expect(viSay('today.items.sign.envelopeExpiringHours', { hours: 24 })).toBe(
      'Một hồ sơ ký kết sẽ hết hạn trong 24 giờ tới',
    );
    expect(enSay('today.items.sign.envelopeDeclinedDays', { days: 1 })).toBe('A signing envelope was declined 1 day ago');
    expect(enSay('today.items.sign.envelopeDeclinedDays', { days: 5 })).toBe('A signing envelope was declined 5 days ago');
    expect(viSay('today.items.sign.envelopeDeclinedDays', { days: 5 })).toBe(
      'Một hồ sơ ký kết đã bị từ chối 5 ngày trước',
    );
    expect(enSay('today.items.sign.more', { count: 1 })).toBe('1 more signing envelope needs your attention');
    expect(enSay('today.items.sign.more', { count: 3 })).toBe('3 more signing envelopes need your attention');
  });

  it('renders eSign items inside TodayList with direct /o/<slug>/sign/envelopes/<id> links and Vy attribution', () => {
    const items: TodayItem[] = [
      {
        kind: 'flag',
        app: 'sign',
        id: 'declined:01900000-0000-7000-8000-000000000701',
        title: { key: 'sign.envelopeDeclinedToday', params: {} },
        severity: 'warn',
        href: '/sign/envelopes/01900000-0000-7000-8000-000000000701',
      },
      {
        kind: 'deadline',
        app: 'sign',
        id: 'expiring:01900000-0000-7000-8000-000000000702',
        title: { key: 'sign.envelopeExpiringHours', params: { hours: 12 } },
        dueAt: '2026-11-20T08:00:00.000Z',
        href: '/sign/envelopes/01900000-0000-7000-8000-000000000702',
      },
    ];
    const data = {
      items,
      coworkers: { gm: 'Vy', finance: 'Ly', sales: 'Dy', marketing: 'Uy' },
      dropped: 0,
      truncated: 0,
      failed: 0,
    };

    for (const locale of ['vi', 'en'] as const) {
      client.current.clear();
      client.current.setQueryData(['today', 'list'], data);
      setActiveLocale(locale);
      const html = renderToStaticMarkup(
        <I18nProvider>
          <QueryClientProvider client={client.current}>
            <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
              <TodayList slug="acme" />
            </IntlProvider>
          </QueryClientProvider>
        </I18nProvider>,
      );
      expect(html).toContain('href="/o/acme/sign/envelopes/01900000-0000-7000-8000-000000000701"');
      expect(html).toContain('href="/o/acme/sign/envelopes/01900000-0000-7000-8000-000000000702"');
      if (locale === 'vi') {
        expect(html).toContain('Một hồ sơ ký kết vừa bị từ chối hôm nay');
        expect(html).toContain('Một hồ sơ ký kết sẽ hết hạn trong 12 giờ tới');
        expect(html).toContain('Từ Vy');
      } else {
        expect(html).toContain('A signing envelope was declined today');
        expect(html).toContain('A signing envelope expires in 12 hours');
        expect(html).toContain('From Vy');
      }
    }
  });
});
