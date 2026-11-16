// SPDX-License-Identifier: AGPL-3.0-only
// Settings "Ứng dụng" (ADR-0053, slice d of #3307), rendered on the server with the API's answer seeded: every app on by default with a switch for an owner or admin, the
// reason an app is off or not in the plan, read-only for anyone else, no row for an app the deployment does not run, and the words in both languages.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => String(e) };
});

const { OrgAppsCard } = await import('../src/components/org-apps.tsx');

const app = (id: string, over: Partial<{ deployment: boolean; entitled: boolean; enabled: boolean }> = {}) => {
  const row = { deployment: true, entitled: true, enabled: true, ...over };
  return { id, ...row, effective: row.deployment && row.entitled && row.enabled };
};

function render(canChange: boolean, apps: ReturnType<typeof app>[], locale: 'en' | 'vi' = 'en'): string {
  client.current.setQueryData(['org', 'apps'], { apps, version: 1, canChange });
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <OrgAppsCard />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('Settings Apps', () => {
  beforeEach(() => client.current.clear());

  it('shows an owner every app on with a switch each, no confirmation open, and the plain hint', () => {
    const html = render(true, [app('finance'), app('social'), app('crm')]);
    for (const id of ['finance', 'social', 'crm']) expect(html).toContain(`org-app-${id}`);
    expect(html).toContain(en.orgApps.hint.slice(0, 30));
    expect(html.match(/checked=""/g)).toHaveLength(3);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain(en.orgApps.readOnly);
    expect(html).not.toContain('role="dialog"');
  });

  it('says why an app is off: switched off by the owner, or not in the plan (and then it has no working switch)', () => {
    const html = render(true, [app('finance'), app('social', { enabled: false }), app('hr', { entitled: false })]);
    expect(html).toContain(en.orgApps.status.off);
    expect(html).toContain(en.orgApps.status.notInPlan);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });

  it('shows a member the same list read-only, with who may change it', () => {
    const html = render(false, [app('finance'), app('social', { enabled: false })]);
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain(en.orgApps.readOnly);
  });

  it('leaves out an app the deployment does not run, and shows nothing when none is left', () => {
    const html = render(true, [app('finance'), app('ads', { deployment: false })]);
    expect(html).toContain('org-app-finance');
    expect(html).not.toContain('org-app-ads');
    expect(render(true, [app('ads', { deployment: false })])).toBe('');
  });

  it('speaks Vietnamese with the app names', () => {
    const html = render(true, [app('finance'), app('meetings', { enabled: false })], 'vi');
    expect(html).toContain(viMessages.orgApps.names.finance);
    expect(html).toContain(viMessages.orgApps.names.meetings);
    expect(html).toContain(viMessages.orgApps.status.off);
    expect(html).toContain('Ứng dụng');
  });
});
