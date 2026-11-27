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

function render(opts: { enabled: boolean; minute?: number; locale?: 'en' | 'vi'; content?: 'count' | 'full'; vyLines?: boolean }): string {
  state.qc.clear();
  state.qc.setQueryData(['meetings', 'morning', 'get'], {
    enabled: opts.enabled,
    minute: opts.minute ?? 420,
    timeZone: 'Asia/Ho_Chi_Minh',
    language: 'vi',
    content: opts.content ?? 'count',
    vyLines: opts.vyLines ?? false,
  });
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
    const enNoMail = catalog('en').notifications.morningNotice.noMail;
    const viNoMail = catalog('vi').notifications.morningNotice.noMail;
    expect(enNoMail).toContain('In-app notices');
    expect(enNoMail).toContain('browser push');
    expect(viNoMail).toContain('Thông báo trong ứng dụng');
    expect(viNoMail).toContain('thông báo đẩy');
    expect(render({ enabled: false })).toContain(enNoMail);
    expect(render({ enabled: false, locale: 'vi' })).toContain(viNoMail);
    state.mail = true;
    expect(render({ enabled: false })).not.toContain(enNoMail);
    expect(render({ enabled: false, locale: 'vi' })).toContain(catalog('vi').notifications.morningNotice.title);
  });

  it('keeps content mode defaulting to count-only, disables full options until enabled, and gates vyLines behind full briefing (#5080)', () => {
    const offHtml = render({ enabled: false, content: 'full', vyLines: true });
    expect(offHtml).toContain('role="radiogroup"');
    expect(offHtml).toContain('aria-labelledby="morning-notice-content-label"');
    const countBtnOff = /<button[^>]*data-testid="morning-notice-content-count"[^>]*>/.exec(offHtml)?.[0] ?? '';
    const fullBtnOff = /<button[^>]*data-testid="morning-notice-content-full"[^>]*>/.exec(offHtml)?.[0] ?? '';
    expect(countBtnOff).toContain('role="radio"');
    expect(countBtnOff).toContain('min-h-11');
    expect(countBtnOff).toContain('disabled');
    expect(fullBtnOff).toContain('role="radio"');
    expect(fullBtnOff).toContain('min-h-11');
    expect(fullBtnOff).toContain('disabled');
    expect(offHtml).not.toContain('data-testid="morning-notice-full-notice"');
    const vyOff = /<span[^>]*data-testid="morning-notice-vy-lines"[^>]*>/.exec(offHtml)?.[0] ?? '';
    expect(vyOff).toContain('aria-checked="false"');
    expect(vyOff).toMatch(/aria-disabled="true"|data-disabled/);

    const countHtml = render({ enabled: true, content: 'count' });
    const countBtnOn = /<button[^>]*data-testid="morning-notice-content-count"[^>]*>/.exec(countHtml)?.[0] ?? '';
    const fullBtnOn = /<button[^>]*data-testid="morning-notice-content-full"[^>]*>/.exec(countHtml)?.[0] ?? '';
    expect(countBtnOn).toContain('aria-checked="true"');
    expect(countBtnOn).toContain('tabindex="0"');
    expect(countBtnOn).not.toContain('disabled');
    expect(fullBtnOn).toContain('aria-checked="false"');
    expect(fullBtnOn).toContain('tabindex="-1"');
    expect(countHtml).not.toContain('data-testid="morning-notice-full-notice"');
    const vyCount = /<span[^>]*data-testid="morning-notice-vy-lines"[^>]*>/.exec(countHtml)?.[0] ?? '';
    expect(vyCount).toContain('aria-checked="false"');
    expect(vyCount).toMatch(/aria-disabled="true"|data-disabled/);

    const fullHtml = render({ enabled: true, content: 'full', vyLines: false });
    const fullBtnChosen = /<button[^>]*data-testid="morning-notice-content-full"[^>]*>/.exec(fullHtml)?.[0] ?? '';
    const countBtnUnchosen = /<button[^>]*data-testid="morning-notice-content-count"[^>]*>/.exec(fullHtml)?.[0] ?? '';
    expect(fullBtnChosen).toContain('aria-checked="true"');
    expect(fullBtnChosen).toContain('tabindex="0"');
    expect(countBtnUnchosen).toContain('aria-checked="false"');
    expect(countBtnUnchosen).toContain('tabindex="-1"');
    expect(fullHtml).toContain('data-testid="morning-notice-full-notice"');
    expect(fullHtml).toContain(catalog('en').notifications.morningNotice.fullNotice);
    const vyFullOff = /<span[^>]*data-testid="morning-notice-vy-lines"[^>]*>/.exec(fullHtml)?.[0] ?? '';
    expect(vyFullOff).toContain('aria-checked="false"');
    expect(vyFullOff).not.toContain('aria-disabled="true"');
    expect(vyFullOff).not.toContain('data-disabled');

    const vyEnabledVi = render({ enabled: true, content: 'full', vyLines: true, locale: 'vi' });
    const vyFullOn = /<span[^>]*data-testid="morning-notice-vy-lines"[^>]*>/.exec(vyEnabledVi)?.[0] ?? '';
    expect(vyFullOn).toContain('aria-checked="true"');
    expect(vyEnabledVi).toContain(catalog('vi').notifications.morningNotice.content.full.title);
    expect(vyEnabledVi).toContain(catalog('vi').notifications.morningNotice.vyLinesLabel);
    expect(vyEnabledVi).toContain(catalog('vi').notifications.morningNotice.fullNotice);
  });
});
