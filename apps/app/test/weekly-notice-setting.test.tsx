// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in to the weekly notice of the week's meetings (#4967): off by default, the Monday time it was set for, the zone it uses, a note when the server cannot send mail. Rendered on the server from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { createTranslator } from 'use-intl/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: ['kernel', 'meetings'], mailEnabled: state.mail }) }));

const { WeeklyNoticeSetting } = await import('../src/components/weekly-notice-setting.tsx');

function render(opts: { enabled: boolean; minute?: number; locale?: 'en' | 'vi' }): string {
  state.qc.clear();
  state.qc.setQueryData(['meetings', 'weekly', 'get'], { enabled: opts.enabled, minute: opts.minute ?? 480, timeZone: 'Asia/Ho_Chi_Minh', language: 'vi' });
  const locale = opts.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <WeeklyNoticeSetting />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.mail = true;
});

describe('WeeklyNoticeSetting', () => {
  // The text of each element a tag's aria-describedby names (read from the markup: these tests run without a DOM).
  const describedBy = (html: string, tag: RegExp): string[] => {
    const ids = (tag.exec(html)?.[0].match(/aria-describedby="([^"]*)"/)?.[1] ?? '').split(' ').filter(Boolean);
    return ids.map((id) => new RegExp(`<p id="${id}"[^>]*>([^<]*)</p>`).exec(html)?.[1] ?? '');
  };

  it('is off until the member turns it on, with the default Monday time and a time input that waits', () => {
    const html = render({ enabled: false });
    expect(html).toContain('every Monday</label>');
    expect(html).toMatch(/aria-checked="false"|data-state="unchecked"/);
    expect(html).toContain('value="08:00"');
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).not.toContain('Asia/Ho_Chi_Minh');
    // The switch is described by the hint, which says what it holds and what it does not.
    expect(describedBy(html, /<span[^>]*role="checkbox"[^>]*>/)[0]).toContain('no title and no text of a decision');
    expect(/<input[^>]*type="time"[^>]*>/.exec(html)?.[0]).not.toContain('aria-describedby');
  });

  it('shows the chosen time and the zone it counts in once on, and describes the time by the zone', () => {
    const html = render({ enabled: true, minute: 495 });
    expect(html).toMatch(/aria-checked="true"|data-state="checked"/);
    expect(html).toContain('value="08:15"');
    expect(describedBy(html, /<input[^>]*type="time"[^>]*>/)).toEqual(['In your time zone: Asia/Ho_Chi_Minh']);
  });

  it('says so when the server cannot send mail, says it was saved, and speaks Vietnamese', () => {
    state.mail = false;
    const enNoMail = catalog('en').notifications.weeklyNotice.noMail;
    const viNoMail = catalog('vi').notifications.weeklyNotice.noMail;
    expect(render({ enabled: false })).toContain(enNoMail);
    expect(render({ enabled: false, locale: 'vi' })).toContain(viNoMail);
    state.mail = true;
    expect(render({ enabled: false })).not.toContain(enNoMail);
    expect(render({ enabled: false, locale: 'vi' })).toContain(catalog('vi').notifications.weeklyNotice.title);
    expect(catalog('en').notifications.weeklyNotice.saved).toBe('Saved');
    expect(catalog('vi').notifications.weeklyNotice.saved).toBe('Đã lưu');
  });
});

describe('the weekly notice text in the app (#4967)', () => {
  const text = (locale: 'en' | 'vi', values: Record<string, string | number>) => createTranslator({ locale, messages: catalog(locale), namespace: 'notifications' })('text.weekly' as never, values as never) as string;

  it('says the four numbers and "at least" when a limit cut them, in both languages, and nothing else', () => {
    const base = { meetings: 3, decisions: 4, open: 5, overdue: 2, cut: 'no', trackedText: 'none' };
    expect(text('en', base)).toContain('Last 7 days: 3 meetings with a published result, 4 decisions published, 5 open action items, 2 overdue.');
    expect(text('en', { ...base, cut: 'yes', meetings: 1, decisions: 1, open: 1, overdue: 0 })).toContain('at least 1 meeting with a published result, 1 decision published, 1 open action item.');
    expect(text('vi', base)).toContain('7 ngày qua: 3 cuộc họp có kết quả đã công bố, 4 quyết định đã công bố, 5 việc còn mở, 2 việc quá hạn.');
    expect(text('vi', { ...base, cut: 'yes', overdue: 0 })).toContain('ít nhất 3 cuộc họp');
  });

  it('adds the tracked-word clause only when the notice holds the number, "999+" at the most, in both languages (#5019)', () => {
    const base = { meetings: 3, decisions: 4, open: 5, overdue: 2, cut: 'no' };
    expect(text('en', { ...base, trackedText: '12' })).toContain('2 overdue, tracked words came up 12 times. Open the meetings page');
    expect(text('en', { ...base, trackedText: '999+' })).toContain('tracked words came up 999+ times.');
    expect(text('vi', { ...base, trackedText: '12' })).toContain('2 việc quá hạn, từ khóa theo dõi xuất hiện 12 lần. Mở trang Cuộc họp');
    expect(text('vi', { ...base, trackedText: 'none' })).not.toContain('từ khóa');
    expect(text('en', { ...base, trackedText: 'none' })).not.toContain('tracked words');
  });
});
