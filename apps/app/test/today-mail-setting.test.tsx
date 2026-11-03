// SPDX-License-Identifier: AGPL-3.0-only
// The daily brief by email, in the member's notification settings (#2406): off by default, their own choice, a note when the
// server cannot send mail, and the one-click turn-off the mail's link opens. Rendered on the server from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient, mail: true }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.qc = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: state.qc, errorMessage: (e: unknown) => String(e) };
});
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: ['kernel'], mailEnabled: state.mail }) }));

const { TodayMailSetting } = await import('../src/components/today-mail-setting.tsx');

function render(opts: { enabled?: boolean; search?: string; locale?: 'en' | 'vi' } = {}): string {
  state.qc.clear();
  if (opts.enabled !== undefined) state.qc.setQueryData(['today', 'mail', 'get'], { enabled: opts.enabled });
  vi.stubGlobal('window', { location: { search: opts.search ?? '' } });
  const locale = opts.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <TodayMailSetting />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.mail = true;
});
afterEach(() => vi.unstubAllGlobals());

describe('TodayMailSetting', () => {
  it('is off until the member turns it on, and says what the mail holds', () => {
    const html = render({ enabled: false });
    expect(html).toContain(catalog('en').notifications.todayMail.label);
    expect(html).toContain('counts and links only');
    expect(html).toMatch(/role="checkbox"[^>]*aria-checked="false"|data-state="unchecked"/);
    // Nothing is asked to be turned off on a plain visit.
    expect(html).not.toContain(catalog('en').notifications.todayMail.turnOff);
  });

  it('shows the opt-in as on for a member who chose it', () => {
    expect(render({ enabled: true })).toMatch(/aria-checked="true"|data-state="checked"/);
  });

  it('says so when the server cannot send mail', () => {
    state.mail = false;
    expect(render({ enabled: false })).toContain(catalog('en').notifications.todayMail.noMail);
    state.mail = true;
    expect(render({ enabled: false })).not.toContain(catalog('en').notifications.todayMail.noMail);
  });

  it('offers the one-click turn-off only when the mail’s link asked for it, and the member is opted in', () => {
    const asked = render({ enabled: true, search: '?todayMail=off' });
    expect(asked).toContain(catalog('en').notifications.todayMail.turnOffAsked);
    expect(asked).toContain(`>${catalog('en').notifications.todayMail.turnOff}<`);
    expect(render({ enabled: true, search: '' })).not.toContain(catalog('en').notifications.todayMail.turnOffAsked);
    // Already off: it says so instead of offering again.
    const off = render({ enabled: false, search: '?todayMail=off' });
    expect(off).toContain(catalog('en').notifications.todayMail.turnedOff);
    expect(off).not.toContain(`>${catalog('en').notifications.todayMail.turnOff}<`);
  });

  it('says it in Vietnamese', () => {
    const html = render({ enabled: false, locale: 'vi' });
    expect(html).toContain(catalog('vi').notifications.todayMail.title);
    expect(html).toContain('Gửi cho tôi tóm tắt hằng ngày qua email');
  });
});
