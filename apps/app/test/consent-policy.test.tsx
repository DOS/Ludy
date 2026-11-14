// SPDX-License-Identifier: AGPL-3.0-only
// "Cần xác nhận trước khi ghi" (Meetings A2, #3160): the card explains in plain words what strict does, only an owner or admin can change it, and the
// hook reads the policy (standard while it loads). Rendered on the server.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { WRITTEN_CONSENT_METHODS, consentMethodAllowed } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => {
  const opts = (key: string) => ({ queryOptions: () => ({ queryKey: [key], queryFn: () => Promise.reject(new Error('not fetched')) }), key: () => [key] });
  return {
    orpc: { meetings: { consentPolicy: { get: opts('policy'), set: { call: vi.fn() }, key: () => ['policy'] } }, org: { get: opts('org') } },
    queryClient: new (class {
      invalidateQueries() {
        return Promise.resolve();
      }
    })(),
    errorMessage: String,
  };
});
vi.mock('../src/lib/toast.ts', () => ({ toast: vi.fn() }));

const { ConsentPolicyCard } = await import('../src/components/consent-policy.tsx');

const render = (policy: 'standard' | 'strict', role: string, locale: 'en' | 'vi' = 'en') => {
  const client = new QueryClient();
  client.setQueryData(['policy'], { policy });
  client.setQueryData(['org'], { role });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <ConsentPolicyCard />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

describe('ConsentPolicyCard', () => {
  it('explains what strict does, in Vietnamese and English', () => {
    expect(render('strict', 'owner')).toContain(en.meetings.consentPolicy.explain.strict.slice(0, 40));
    expect(render('strict', 'owner', 'vi')).toContain('Cần xác nhận trước khi ghi');
    expect(render('standard', 'owner')).toContain(en.meetings.consentPolicy.explain.standard);
    expect(viMessages.meetings.consentPolicy.explain.strict).toContain('bị từ chối');
  });

  it('lets an owner or admin save, and tells a member only they can', () => {
    for (const role of ['owner', 'admin']) {
      const html = render('standard', role);
      expect(html).toContain(en.meetings.consentPolicy.save);
      expect(html).not.toContain(en.meetings.consentPolicy.adminOnly);
      expect(/<select[^>]*\sdisabled=""/.test(html)).toBe(false);
    }
    const member = render('strict', 'member');
    expect(member).toContain(en.meetings.consentPolicy.adminOnly);
    expect(/<select[^>]*\sdisabled=""/.test(member)).toBe(true);
  });
});

describe('the rule the server applies', () => {
  it('standard accepts every method; strict only the written ones', () => {
    for (const method of ['told_at_start', 'in_invite', 'in_writing', 'in_call_chat'] as const) expect(consentMethodAllowed('standard', method)).toBe(true);
    expect(consentMethodAllowed('strict', 'told_at_start')).toBe(false);
    expect([...WRITTEN_CONSENT_METHODS].every((m) => consentMethodAllowed('strict', m))).toBe(true);
    expect(WRITTEN_CONSENT_METHODS).toEqual(['in_invite', 'in_writing', 'in_call_chat']);
  });
});
