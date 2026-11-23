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
    expect(html.match(/role="switch"/g)).toHaveLength(3);
    expect(html).not.toContain('role="checkbox"');
    expect(html).toContain('aria-label="Use Finance"');
    expect(html).toContain('aria-label="Use Inbox &amp; Posts"');
    expect(html.match(/aria-checked="true"/g)).toHaveLength(3);
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).not.toContain(en.orgApps.readOnly);
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('>Social<');
  });

  it('separates each top-level app into its own bordered block with uniform left padding and right-aligned switches (#4508)', () => {
    const html = render(true, [
      app('notes'),
      app('meetings'),
      app('finance'),
      app('social', { enabled: false }),
      app('hr'),
      app('sign', { entitled: false }),
    ]);
    // Separated blocks (5 top-level apps), never one merged list or jagged pl-7 indentation.
    expect(html).toContain('space-y-3');
    expect(html.split('rounded-lg border')).toHaveLength(6);
    expect(html).not.toContain('pl-7');
    expect(html.match(/max-md:min-h-11/g)).toHaveLength(6);
    expect(html.match(/max-md:min-w-11/g)).toHaveLength(6);
    // Optional status badges sit before the switch in the right column so the switch alignment never shifts.
    const socialStart = html.indexOf('data-testid="org-app-social"');
    const socialRow = html.slice(socialStart, html.indexOf('</li>', socialStart));
    expect(socialRow.indexOf(en.orgApps.status.off)).toBeLessThan(socialRow.indexOf('role="switch"'));
    const signStart = html.indexOf('data-testid="org-app-sign"');
    const signRow = html.slice(signStart, html.indexOf('</li>', signStart));
    expect(signRow.indexOf(en.orgApps.status.notInPlan)).toBeLessThan(signRow.indexOf('role="switch"'));
  });

  it('shows one status signal per row: no badge on a row in use, a badge on a row that is off or not in the plan (ST-2)', () => {
    for (const locale of ['en', 'vi'] as const) {
      const messages = locale === 'en' ? en : viMessages;
      const inUse = render(true, [app('finance'), app('hr')], locale);
      expect(inUse).not.toContain('In use');
      expect(inUse).not.toContain('Đang dùng');
      expect(inUse.match(/aria-checked="true"/g)).toHaveLength(2);
      expect(inUse).not.toContain(messages.orgApps.status.off);
      expect(inUse).not.toContain(messages.orgApps.status.notInPlan);
      const mixed = render(true, [app('finance'), app('hr', { enabled: false }), app('sign', { entitled: false })], locale);
      expect(mixed.split(messages.orgApps.status.off)).toHaveLength(2);
      expect(mixed.split(messages.orgApps.status.notInPlan)).toHaveLength(2);
    }
  });

  it('names the groups and rows with the shell\'s own words, never "Social" as an app (ST-2)', () => {
    const html = render(true, [app('notes'), app('social'), app('crm'), app('ads')], 'vi');
    const escapeHtml = (s: string) => s.replaceAll('&', '&amp;');
    expect(html).toContain(escapeHtml(viMessages.nav.apps.teamwork));
    expect(html).toContain(escapeHtml(viMessages.nav.apps.engage));
    expect(html).toContain(escapeHtml('Ghi chú & Việc của tôi'));
    expect(html).toContain(escapeHtml('Hộp thư & Bài đăng'));
    expect(html).not.toMatch(/>(Social|Ghi chú &amp; Việc cá nhân)</);
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
