// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker's follow-up draft on the deals screen (#3101), rendered on the server: the button names the coworker (never "assistant"), nothing is asked until the person presses it,
// the draft reaches only a box the person edits (a copy, the mail program or the reply box: no "send" here), every state the server can answer has a sentence in both languages, and the
// mail program's draft carries the contact's address, the subject and the edited text without letting a character of the text end the link.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { CRM_FOLLOWUP_STATES, DEAL_NEXT_STEP_REASONS } from '@crove/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { catalog, setActiveLocale } from '../src/i18n/runtime.ts';

const draft = vi.fn();
vi.mock('../src/lib/api.ts', () => ({
  errorMessage: (e: unknown) => String(e),
  client: { crm: { nextSteps: { draft: (...args: unknown[]) => draft(...args) } } },
  orpc: { crm: { nextSteps: { list: { queryOptions: () => ({ queryKey: ['x'], queryFn: async () => ({ items: [] }) }) } }, quotes: { key: () => ['q'] }, deals: { list: { key: () => ['d'] } } } },
  queryClient: { invalidateQueries: () => Promise.resolve() },
}));

const { FollowupDraftAction, mailtoOf } = await import('../src/components/followup-draft.tsx');

const render = (locale: 'vi' | 'en') => {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <FollowupDraftAction stepId="0192c6a0-7b3e-7c1d-8a4f-2b9d3c5e6f70" dealTitle="Đơn bánh Tết" />
      </I18nProvider>
    </QueryClientProvider>,
  );
};

describe('the follow-up draft button', () => {
  it('names the coworker, asks nothing before it is pressed and shows no draft', () => {
    const html = render('vi');
    expect(html).toContain('data-testid="followup-ask"');
    expect(html).toMatch(/Nhờ [^<]+ soạn tin nhắc/);
    expect(html).not.toContain('{sales}');
    expect(html).not.toContain('data-testid="followup-draft"');
    expect(html).not.toContain('data-testid="followup-text"');
    expect(draft).not.toHaveBeenCalled();
  });

  it('is labelled with the deal for a screen reader, in both languages', () => {
    expect(render('vi')).toContain('aria-label="Nhờ ');
    expect(render('vi')).toContain('Đơn bánh Tết');
    expect(render('en')).toMatch(/aria-label="Ask [^"]+ to write a reminder: deal /);
  });
});

describe('the mail program\'s draft', () => {
  it('has the address, the subject and the edited text, each encoded so that nothing ends the link early', () => {
    const link = mailtoOf({ email: 'hoamai@khach.test', subject: 'Về báo giá số BG-2026-0042' }, 'Chào chị,\nTổng 19.800.000 đồng & phí?\nXem https://app.example.test/-/quote#abc');
    expect(link.startsWith('mailto:hoamai@khach.test?subject=')).toBe(true);
    expect(link).toContain('body=Ch%C3%A0o%20ch%E1%BB%8B%2C%0AT%E1%BB%95ng%2019.800.000');
    expect(link).toContain('%26%20ph%C3%AD%3F');
    expect(new URL(link).searchParams.get('subject')).toBe('Về báo giá số BG-2026-0042');
    expect(new URL(link).searchParams.get('body')).toBe('Chào chị,\nTổng 19.800.000 đồng & phí?\nXem https://app.example.test/-/quote#abc');
  });

  it('has no address when the contact has none, and keeps the subject and the text', () => {
    const link = mailtoOf({ email: null, subject: 'Hỏi thăm' }, 'Chào chị');
    expect(link.startsWith('mailto:?subject=')).toBe(true);
    expect(new URL(link).searchParams.get('body')).toBe('Chào chị');
  });
});

describe('the copy', () => {
  for (const locale of ['vi', 'en'] as const) {
    it(`has a sentence for every state and every reason the server answers, in ${locale}, with no leftover placeholder and no "assistant"`, () => {
      const copy = (catalog(locale) as unknown as { deals: { nextSteps: { followup: { state: Record<string, string>; reason: Record<string, string> } } } }).deals.nextSteps.followup;
      expect(Object.keys(copy.state).sort()).toEqual([...CRM_FOLLOWUP_STATES].sort());
      expect(Object.keys(copy.reason)).toHaveLength(DEAL_NEXT_STEP_REASONS.length);
      const all = JSON.stringify(copy);
      expect(all).not.toContain('{sales}');
      expect(all).not.toMatch(/assistant|trợ lý/i);
      expect(all).not.toMatch(/[\u2013\u2014]/);
    });
  }
});
