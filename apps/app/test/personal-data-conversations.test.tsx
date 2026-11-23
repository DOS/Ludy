// SPDX-License-Identifier: AGPL-3.0-only
// The pointer on Settings > Dữ liệu cá nhân to the Inbox (#3635): the search does not find customer conversations, so the page says where to erase them, with a
// link to the Inbox, only where the Engage app is installed. Rendered on the server with a plain anchor for the router's link.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient, modules: ['social'] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.qc = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: state.qc, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false };
});
vi.mock('../src/lib/auth.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), getConfig: () => ({ modules: state.modules }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, className }: { to: string; params: { slug: string }; children: React.ReactNode; className?: string }) => (
    <a href={to.replace('$slug', params.slug)} className={className}>
      {children}
    </a>
  ),
}));

const { PersonalDataPage } = await import('../src/routes/personal-data.tsx');

function render(locale: 'vi' | 'en', modules: string[]): string {
  state.modules = modules;
  state.qc.clear();
  state.qc.setQueryData(['org', 'get'], { role: 'owner', slug: 'tiem-banh', members: [] });
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <PersonalDataPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the conversations pointer on the personal-data page', () => {
  it('says where customer conversations are erased and links to the Inbox, in both languages', () => {
    const vi = render('vi', ['social']);
    expect(vi).toContain('data-testid="personal-data-conversations"');
    expect(vi).toContain('Hội thoại với khách');
    expect(vi).toContain('href="/o/tiem-banh/social/inbox"');
    expect(vi).toContain('Mở Hộp thư');
    const en = render('en', ['social']);
    expect(en).toContain('Conversations with customers');
    expect(en).toContain('Open the Inbox');
  });

  it('is not shown where Engage is not installed', () => {
    expect(render('vi', [])).not.toContain('personal-data-conversations');
  });
});
