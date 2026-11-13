// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up webhook under a connected AI app in Settings (issue #3024), rendered on the server: what an unset, a running and a paused wake-up say, that no secret
// is ever drawn from the API's view, the time helpers, and the English and Vietnamese strings.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpWakeView } from '@crove/kernel-contract';
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

const { OrgMcpWake, minuteToTime, timeToMinute } = await import('../src/components/org-mcp-wake.tsx');

const view = (over: Partial<McpWakeView> = {}): McpWakeView => ({
  grantId: 'g-1',
  url: 'https://agent.example.com/hook',
  enabled: true,
  pausedReason: null,
  secretHint: 'whsec_ab12',
  previousUntil: null,
  schedule: 'daily',
  minute: 480,
  weekday: null,
  nextDueAt: '2026-11-13T01:00:00.000Z',
  failingSince: null,
  consecutiveFailures: 0,
  lastDeliveryAt: null,
  lastStatus: null,
  ...over,
});

function render(v: McpWakeView | undefined, locale: 'en' | 'vi' = 'en'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <OrgMcpWake grantId="g-1" view={v} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('OrgMcpWake', () => {
  beforeEach(() => client.current.clear());

  it('says nothing is set up and offers the setup, with no form open', () => {
    const html = render(undefined);
    expect(html).toContain(en.orgMcpWake.title);
    expect(html).toContain(en.orgMcpWake.notSet);
    expect(html).toContain(`>${en.orgMcpWake.set}<`);
    expect(html).not.toContain('<form');
  });

  it('shows a running wake-up with its next time and never a secret', () => {
    const html = render(view());
    expect(html).toContain(`>${en.orgMcpWake.on}<`);
    expect(html).toContain(`>${en.orgMcpWake.edit}<`);
    expect(html).not.toContain('whsec_');
    expect(html).not.toContain('org-mcp-wake-secret');
  });

  it('says a wake-up that kept failing was paused, and how many sends failed while it still runs', () => {
    expect(render(view({ enabled: false, pausedReason: 'failing' }))).toContain(en.orgMcpWake.pausedFailing);
    expect(render(view({ consecutiveFailures: 3 }))).toContain('The last 3 sends failed');
  });

  it('speaks Vietnamese with the same keys as English', () => {
    expect(render(view({ enabled: false, pausedReason: 'failing' }), 'vi')).toContain(viMessages.orgMcpWake.pausedFailing);
    const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(viMessages.orgMcpWake).sort()).toEqual(keys(en.orgMcpWake).sort());
  });

  it('turns minutes after midnight into a time and back, refusing what is not a time', () => {
    expect(minuteToTime(0)).toBe('00:00');
    expect(minuteToTime(1439)).toBe('23:59');
    expect(timeToMinute('08:30')).toBe(510);
    expect(timeToMinute('24:00')).toBeNull();
    expect(timeToMinute('8:3')).toBeNull();
    expect(timeToMinute('')).toBeNull();
  });
});
