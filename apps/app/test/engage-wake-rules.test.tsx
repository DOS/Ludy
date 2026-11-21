// SPDX-License-Identifier: AGPL-3.0-only
// The "When work is raised" card of Settings (#3862, Engage's wake rules), rendered on the server from a seeded cache: the org's three numbers with the default marked, in both languages, and the words
// of the Home lines of the rules exist in both. No word of the card calls an AI coworker an assistant.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient }));

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
  return { orpc: node([]), client: {}, queryClient: state.qc, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false };
});

const { EngageWakeRulesCard } = await import('../src/components/engage-wake-rules.tsx');

function render(seed: Record<string, unknown>, locale: 'en' | 'vi' = 'en'): string {
  state.qc.clear();
  state.qc.setQueryData(['conversations', 'wakeRules'], seed);
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <EngageWakeRulesCard />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('EngageWakeRulesCard', () => {
  it('shows the three numbers of the org with the default marked, in English and Vietnamese', () => {
    const html = render({ unansweredHours: 4, replyWindowHours: 3, quoteDays: 5, isDefault: true });
    for (const id of ['unansweredHours', 'replyWindowHours', 'quoteDays']) expect(html).toContain(`data-testid="engage-wake-${id}"`);
    expect(html).toContain('When work is raised');
    expect(html).toContain('4 hours (default)');
    expect(html).toContain('5 days (default)');
    const vi = render({ unansweredHours: 8, replyWindowHours: 6, quoteDays: 7, isDefault: false }, 'vi');
    expect(vi).toContain('Khi nào nhắc việc');
    expect(vi).toContain('8 giờ');
    expect(vi).not.toContain('(mặc định)');
    expect(vi).toContain('đồng nghiệp AI');
    expect(vi).not.toMatch(/trợ lý/i);
  });

  it('shows a saved number that is outside the short list, so the select never lies', () => {
    expect(render({ unansweredHours: 5, replyWindowHours: 3, quoteDays: 5, isDefault: false })).toContain('5 hours');
  });

  it('has the Home lines of the rules in both languages', () => {
    for (const locale of ['en', 'vi'] as const) {
      const wake = (catalog(locale) as unknown as { today: { items: { wake: Record<string, string>; crm: Record<string, string> } } }).today.items;
      for (const key of ['unanswered', 'replyWindow', 'postComments']) expect(wake.wake[key], `${locale} ${key}`).toBeTruthy();
      expect(wake.crm.bookingTomorrow).toBeTruthy();
      expect(Object.values(wake.wake).join(' ')).not.toMatch(/trợ lý/i);
    }
  });
});
