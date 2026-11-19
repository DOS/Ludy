// SPDX-License-Identifier: AGPL-3.0-only
// The opt-in to the morning notice of the day's meetings (#3955): off by default, the time of day it was set for, the zone it uses, a note when the server cannot send mail. Rendered on the server from a seeded cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
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

const { MorningNoticeSetting, minuteToTime, timeToMinute } = await import('../src/components/morning-notice-setting.tsx');

function render(opts: { enabled: boolean; minute?: number; locale?: 'en' | 'vi' }): string {
  state.qc.clear();
  state.qc.setQueryData(['meetings', 'morning', 'get'], { enabled: opts.enabled, minute: opts.minute ?? 420, timeZone: 'Asia/Ho_Chi_Minh', language: 'vi' });
  const locale = opts.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MorningNoticeSetting />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.mail = true;
});

describe('the time of day', () => {
  it('converts between minutes and the time input', () => {
    expect(minuteToTime(420)).toBe('07:00');
    expect(minuteToTime(1439)).toBe('23:59');
    expect(timeToMinute('07:30')).toBe(450);
    expect(timeToMinute('24:00')).toBeNull();
    expect(timeToMinute('7:30')).toBeNull();
    expect(timeToMinute('')).toBeNull();
  });
});

describe('what a screen reader is told (#4055)', () => {
  // The text of each element a tag's aria-describedby names (read from the markup: these tests run without a DOM).
  const describedBy = (html: string, tag: RegExp): string[] => {
    const ids = (tag.exec(html)?.[0].match(/aria-describedby="([^"]*)"/)?.[1] ?? '').split(' ').filter(Boolean);
    return ids.map((id) => new RegExp(`<p id="${id}"[^>]*>([^<]*)</p>`).exec(html)?.[1] ?? '');
  };

  it('describes the switch by the hint and, once on, the time field by the zone it counts in', () => {
    const off = render({ enabled: false });
    expect(describedBy(off, /<span[^>]*role="checkbox"[^>]*>/)[0]).toContain('how many meetings you have today');
    // Nothing to describe the time with while the notice is off: no dangling reference.
    expect(/<input[^>]*type="time"[^>]*>/.exec(off)?.[0]).not.toContain('aria-describedby');
    const on = render({ enabled: true });
    expect(describedBy(on, /<input[^>]*type="time"[^>]*>/)).toEqual(['In your time zone: Asia/Ho_Chi_Minh']);
    expect(describedBy(on, /<span[^>]*role="checkbox"[^>]*>/)).toHaveLength(1);
  });

  it('has the words that say it was saved, in both languages', () => {
    expect(catalog('en').notifications.morningNotice.saved).toBe('Saved');
    expect(catalog('vi').notifications.morningNotice.saved).toBe('Đã lưu');
  });
});

describe('MorningNoticeSetting', () => {
  it('is off until the member turns it on, with the default time and a time input that waits', () => {
    const html = render({ enabled: false });
    expect(html).toContain('every morning</label>');
    expect(html).toMatch(/aria-checked="false"|data-state="unchecked"/);
    expect(html).toContain('value="07:00"');
    expect(html).toMatch(/<input[^>]*disabled/);
    expect(html).not.toContain('Asia/Ho_Chi_Minh');
  });

  it('shows the chosen time and the zone it counts in once on', () => {
    const html = render({ enabled: true, minute: 495 });
    expect(html).toMatch(/aria-checked="true"|data-state="checked"/);
    expect(html).toContain('value="08:15"');
    expect(html).toContain('Asia/Ho_Chi_Minh');
  });

  it('says so when the server cannot send mail, and speaks Vietnamese', () => {
    state.mail = false;
    expect(render({ enabled: false })).toContain(catalog('en').notifications.morningNotice.noMail);
    state.mail = true;
    expect(render({ enabled: false })).not.toContain(catalog('en').notifications.morningNotice.noMail);
    expect(render({ enabled: false, locale: 'vi' })).toContain(catalog('vi').notifications.morningNotice.title);
  });
});
