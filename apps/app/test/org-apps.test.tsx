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
    const engageGroup = html.slice(html.indexOf('data-testid="org-app-group-engage"'));
    expect(engageGroup).toContain('role="group"');
    expect(engageGroup).toContain('aria-labelledby="org-app-group-engage-label"');
    expect(engageGroup).toContain('org-app-social');
    expect(engageGroup).toContain('org-app-crm');
    expect(html.indexOf('org-app-finance')).toBeLessThan(html.indexOf('data-testid="org-app-group-engage"'));
    expect(html).not.toContain('org-app-group-finance');
    expect(html).toContain(en.orgApps.hint.slice(0, 30));
    expect(html.match(/aria-checked="true"/g)).toHaveLength(3);
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).not.toContain(en.orgApps.readOnly);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('>Social<');
  });

  it('says why an app is off: switched off by the owner, or not in the plan (and then it has no working switch)', () => {
    const html = render(true, [app('finance'), app('social', { enabled: false }), app('hr', { entitled: false })]);
    expect(html).toContain(en.orgApps.status.off);
    expect(html).toContain(en.orgApps.status.notInPlan);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(1);
  });

  it('shows a member the same list read-only, with who may change it', () => {
    const html = render(false, [app('finance'), app('social', { enabled: false })]);
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
    expect(html).toContain(en.orgApps.readOnly);
  });

  it('leaves out an app the deployment does not run, and shows nothing when none is left', () => {
    const html = render(true, [app('finance'), app('ads', { deployment: false })]);
    expect(html).toContain('org-app-finance');
    expect(html).not.toContain('org-app-ads');
    expect(render(true, [app('ads', { deployment: false })])).toBe('');
  });

  it('speaks Vietnamese with the app and module names', () => {
    const html = render(true, [app('finance'), app('meetings', { enabled: false }), app('notes'), app('sign')], 'vi');
    const escapeHtml = (s: string) => s.replaceAll('&', '&amp;');
    const teamworkStart = html.indexOf('data-testid="org-app-group-teamwork"');
    const financeStart = html.indexOf('data-testid="org-app-finance"');
    const teamworkGroup = html.slice(teamworkStart, financeStart);
    expect(teamworkGroup).toContain('role="group"');
    expect(teamworkGroup).toContain('aria-labelledby="org-app-group-teamwork-label"');
    expect(teamworkGroup).toContain(escapeHtml(viMessages.nav.apps.teamwork));
    expect(teamworkGroup).toContain('org-app-notes');
    expect(teamworkGroup).toContain('org-app-meetings');
    expect(teamworkGroup).toContain(escapeHtml(viMessages.modules.meetings));
    expect(teamworkGroup).toContain(escapeHtml(viMessages.modules.notes));
    expect(html).toContain(escapeHtml(viMessages.modules.finance));
    expect(html).toContain('eSign');
    expect(en.modules.sign).toBe('eSign');
    expect(viMessages.modules.sign).toBe('eSign');
    expect(html).toContain(viMessages.orgApps.status.off);
    expect(html).toContain(escapeHtml(viMessages.orgApps.title));
    expect(html).not.toContain('>Social<');
  });
});
