// SPDX-License-Identifier: AGPL-3.0-only
// The Ludy AI > AI use and budgets screen as each role sees it (#3225): the budget form is the owner's, the figures are for owners and admins, and anyone else
// is told. Rendered on the server with the queries answered from a seeded cache, as agents-screen.test.tsx does.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  // orpc.<a>.<b>.queryOptions() / mutationOptions(): keys are the path, nothing is ever fetched.
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    queryClient: client.current,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    takeOrgLeftNotice: () => null,
  };
});
vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: ['kernel', 'accounting'] }),
  auth: {},
  authErrorText: () => '',
  authFailure: () => ({}),
}));

const { AiUsagePage } = await import('../src/routes/ai-usage.tsx');

const chart = { root: [], positions: [], agents: [{ id: 'a1', templateKey: 'accountant', displayName: 'Kế toán AI', status: 'active', maxRisk: 'R1', dailyRunCap: 50 }], killSwitches: [] };

function page(role: string | null): string {
  const qc = client.current;
  qc.clear();
  qc.setQueryData(['org', 'get'], { role, members: [] });
  qc.setQueryData(['chart', 'get'], chart);
  qc.setQueryData(['agents', 'budgets'], []);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <AiUsagePage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('AiUsagePage', () => {
  beforeEach(() => client.current.clear());

  it('gives owners the budgets, with the form wording its own errors', () => {
    const html = page('owner');
    expect(html).toContain(`>${en.aiUsagePage.title}<`);
    expect(html).toContain(`>${en.agents.budgetsTitle}<`);
    expect(html).toContain(`>${en.agents.setBudget}<`);
    const budget = html.slice(html.lastIndexOf('<form', html.indexOf(`>${en.agents.setBudget}<`)));
    expect(budget).toMatch(/^<form[^>]*novalidate/i);
    expect(budget).not.toContain('-error"');
  });

  it('gives admins the budgets to read, without the form that sets one', () => {
    const html = page('admin');
    expect(html).toContain(`>${en.agents.budgetsTitle}<`);
    expect(html).not.toContain(`>${en.agents.setBudget}<`);
  });

  it('tells anyone else it is for owners and admins', () => {
    const html = page('member');
    expect(html).toContain(en.aiUsagePage.noAccess);
    expect(html).not.toContain(`>${en.agents.budgetsTitle}<`);
  });
});
