// SPDX-License-Identifier: AGPL-3.0-only
// "Tuần này" on Home (#3257) as the member sees it: shown by itself Monday to Wednesday and asked for on the other days, only the figures the member can open, Vy's sentences marked as
// written by it, the template marked as automatic, and the figures alone when the month's AI budget is spent. Rendered on the server with the answer seeded in the cache.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodayWeekly as Weekly } from '@crove/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  return { orpc: {}, client: {}, queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { TodayWeekly, weeklyTiles } = await import('../src/components/today-weekly.tsx');
const { weeklyCacheKey, weeklyAutoShown } = await import('../src/lib/today-weekly.ts');
const { briefDay } = await import('../src/lib/today-brief.ts');

// 2026-11-16 is a Monday, 2026-11-20 a Friday (Vietnam time).
const MONDAY = new Date('2026-11-16T03:00:00Z');
const FRIDAY = new Date('2026-11-20T03:00:00Z');

const FIGURES: Weekly['figures'] = {
  from: '2026-11-10',
  to: '2026-11-16',
  before: '2026-11-09',
  deals: { won: { count: 3, amount: '45000000' }, open: 12 },
  money: { cash: { amount: '120000000', previous: '100000000' }, receivables: { amount: '30000000', previous: '35500000' }, payables: { amount: '8000000', previous: '8000000' } },
  tasks: { late: 2 },
};
const answer = (over: Partial<Weekly> = {}): Weekly => ({ figures: FIGURES, writtenBy: 'vy', sentences: ['Tuần qua có 3 deal thắng.'], budgetSpent: false, final: true, ...over });

function render(opts: { now: Date; data?: Weekly; locale?: 'en' | 'vi' }): string {
  vi.setSystemTime(opts.now);
  const qc = client.current;
  qc.clear();
  const locale = opts.locale ?? 'en';
  if (opts.data) qc.setQueryData(['today', 'weekly', weeklyCacheKey('acme', briefDay(), locale)], opts.data);
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <IntlProvider locale={locale} messages={catalog(locale) as never}>
          <TodayWeekly slug="acme" />
        </IntlProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  client.current.clear();
});
afterEach(() => vi.useRealTimers());

describe('the days the card shows by itself', () => {
  it('are Monday to Wednesday in Vietnam time', () => {
    const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].map((d) => weeklyAutoShown(new Date(`${d}T03:00:00Z`)));
    expect(days).toEqual([true, true, true, false, false, false, false]);
    // 20:00 UTC on a Sunday is already Monday morning in Vietnam.
    expect(weeklyAutoShown(new Date('2026-11-22T20:00:00Z'))).toBe(true);
  });
});

describe('TodayWeekly', () => {
  it('shows the card by itself on a Monday, with Vy’s sentences marked as written by it and every figure the member can open', () => {
    const html = render({ now: MONDAY, data: answer() });
    expect(html).toContain('data-testid="today-weekly"');
    expect(html).toContain('Tuần qua có 3 deal thắng.');
    expect(html).toContain(catalog('en').today.weekly.aiBadge);
    expect(html).toContain(catalog('en').today.weekly.byVy);
    for (const key of ['dealsWon', 'dealsOpen', 'cash', 'receivables', 'payables', 'tasksLate']) expect(html).toContain(`data-testid="weekly-${key}"`);
    expect(html).not.toContain('data-testid="today-weekly-ask"');
  });

  it('asks for the card on any other day, and calls nothing until then', () => {
    const html = render({ now: FRIDAY, data: answer() });
    expect(html).toContain('data-testid="today-weekly-ask"');
    expect(html).toContain(catalog('en').today.weekly.ask);
    expect(html).not.toContain('data-testid="today-weekly"');
  });

  it('says a template is automatic, with no AI mark', () => {
    const html = render({ now: MONDAY, data: answer({ writtenBy: 'template' }) });
    expect(html).toContain(catalog('en').today.weekly.byTemplate);
    expect(html).not.toContain(catalog('en').today.weekly.aiBadge);
  });

  it('shows the template, and says why Vy did not write, when the AI budget is spent or AI is off', () => {
    const html = render({ now: MONDAY, data: answer({ writtenBy: 'template', sentences: ['Trong 7 ngày qua có 3 deal thắng.'], budgetSpent: true, final: false }) });
    expect(html).toContain('data-testid="today-weekly"');
    expect(html).toContain('this summary is automatic');
    expect(html).not.toContain(catalog('en').today.weekly.aiBadge);
    expect(html).toContain('data-testid="weekly-cash"');
  });

  it('shows no figure of a group the member cannot open, and no card when they can open none', () => {
    const partial = render({ now: MONDAY, data: answer({ figures: { ...FIGURES, money: null, deals: null } }) });
    expect(partial).toContain('data-testid="weekly-tasksLate"');
    for (const key of ['dealsWon', 'dealsOpen', 'cash', 'receivables', 'payables']) expect(partial).not.toContain(`data-testid="weekly-${key}"`);
    const none = render({ now: MONDAY, data: answer({ figures: { ...FIGURES, money: null, deals: null, tasks: null }, writtenBy: null, sentences: [] }) });
    expect(none).not.toContain('data-testid="today-weekly"');
  });

  it('shows a quiet placeholder while it loads, in Vietnamese too', () => {
    expect(render({ now: MONDAY })).toContain(catalog('en').today.weekly.loading);
    expect(render({ now: MONDAY, data: answer(), locale: 'vi' })).toContain('Tuần này');
  });
});

describe('the cache', () => {
  it('never reaches sessionStorage: the next person to sign in in the same tab could find balances there', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/components/today-weekly.tsx', import.meta.url)), 'utf8') + readFileSync(fileURLToPath(new URL('../src/lib/today-weekly.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/sessionStorage|localStorage/);
  });
});

describe('weeklyTiles', () => {
  const ZERO_BALANCE = { amount: '0', previous: '0.00' };
  it('lists the figures in order and leaves out an open count that was cut', () => {
    expect(weeklyTiles(FIGURES).map((t) => t.key)).toEqual(['dealsWon', 'dealsOpen', 'cash', 'receivables', 'payables', 'tasksLate']);
    // Nothing won and the open count cut: a deals tile would only say 0, so there is none (#3591).
    expect(weeklyTiles({ ...FIGURES, deals: { won: { count: 0, amount: '0' }, open: null } }).map((t) => t.key)).toEqual(['cash', 'receivables', 'payables', 'tasksLate']);
    // Deals still open show with 0 won.
    expect(weeklyTiles({ ...FIGURES, deals: { won: { count: 0, amount: '0' }, open: 4 } }).map((t) => t.key)).toEqual(['dealsWon', 'dealsOpen', 'cash', 'receivables', 'payables', 'tasksLate']);
  });

  it('shows no zeros for an org that does not use the app: no deal, an empty ledger, no late task (#3591)', () => {
    const empty: Weekly['figures'] = {
      ...FIGURES,
      deals: { won: { count: 0, amount: '0' }, open: 0 },
      money: { cash: ZERO_BALANCE, receivables: ZERO_BALANCE, payables: ZERO_BALANCE },
      tasks: { late: 0 },
    };
    expect(weeklyTiles(empty)).toEqual([]);
    // One balance that moved brings the three money tiles back, so the card does not show a lone figure.
    expect(weeklyTiles({ ...empty, money: { ...empty.money!, cash: { amount: '0', previous: '500000' } } }).map((t) => t.key)).toEqual(['cash', 'receivables', 'payables']);
  });
});
