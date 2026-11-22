// SPDX-License-Identifier: AGPL-3.0-only
// The name proposals under the MISA AMIS preview (#4124, S3b of #4103), rendered on the server: each proposal with the party's name, the catalogue entry's name and code as plain text (never markup), a button
// to confirm and one to reject that say which party they are for, nothing at all when there is no proposal, and the same wording in Vietnamese and English.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MisaAmisNameProposal } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const cache = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  cache.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { client: node([]), orpc: node([]), queryClient: cache.current, errorMessage: (e: unknown) => String(e) };
});

const { MisaAmisNameProposals, ProposalRow } = await import('../src/components/misa-amis-name-proposals.tsx');

const ID = '0192f0a1-2b3c-7d4e-8f50-6172839a4b5d';
const proposal = (over: Partial<MisaAmisNameProposal> = {}): MisaAmisNameProposal => ({
  id: '0192f0a1-2b3c-7d4e-8f50-6172839a4b60',
  partyId: ID,
  partyName: 'Hộ kinh doanh Hoa Sen',
  candidateName: 'Hoa Sen (HKD)',
  candidateCode: 'KH_HS',
  checkedAt: '2026-11-19T12:00:00.000Z',
  ...over,
});

const wrap = (node: React.ReactNode, locale: 'vi' | 'en' = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={cache.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );

const listed = (rows: MisaAmisNameProposal[], locale: 'vi' | 'en' = 'en') => {
  cache.current.setQueryData(['misaAmis', 'matches', 'proposals'], rows);
  return wrap(<MisaAmisNameProposals connectionId={ID} onDecided={() => undefined} />, locale);
};

describe('the name proposals of a check (#4124)', () => {
  beforeEach(() => cache.current.clear());

  it('draws nothing while there is no proposal', () => {
    expect(listed([])).toBe('');
  });

  it('lists each proposal with the two names and the code, a confirm and a reject button that name the party, and says that nothing is matched until the person confirms', () => {
    const html = listed([proposal(), proposal({ id: '0192f0a1-2b3c-7d4e-8f50-6172839a4b61', partyId: '0192f0a1-2b3c-7d4e-8f50-6172839a4b5e', partyName: 'Hộ kinh doanh Hoa Mai', candidateName: 'Hoa Mai', candidateCode: 'KH_HM' })]);
    expect(html).toContain('data-testid="misa-amis-names"');
    expect(html.match(/data-testid="misa-amis-name-proposal"/g)).toHaveLength(2);
    expect(html).toContain('2 parties without a tax code need your confirmation against the MISA catalogue');
    expect(html).toContain('Only when you confirm is that entry&#x27;s code written on the vouchers');
    expect(html).toContain('The party &quot;Hộ kinh doanh Hoa Sen&quot; has the same name as the entry &quot;Hoa Sen (HKD)&quot; (code KH_HS)');
    expect(html).toContain('aria-label="Confirm Hộ kinh doanh Hoa Mai as the entry in the MISA catalogue"');
    expect(html).toContain('aria-label="Reject the proposal for Hộ kinh doanh Hoa Mai"');
    expect(html.match(/data-testid="misa-amis-name-confirm"/g)).toHaveLength(2);
    expect(html.match(/data-testid="misa-amis-name-reject"/g)).toHaveLength(2);
  });

  it('shows a name as text, never as markup, in either language', () => {
    const html = listed([proposal({ partyName: '<img src=x onerror=alert(1)>', candidateName: '<b>đậm</b>' })], 'vi');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;đậm&lt;/b&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('Đúng, xác nhận');
  });

  it('disables both buttons of a row while a decision is being made', () => {
    const busy = wrap(<ProposalRow proposal={proposal()} busy onDecide={() => undefined} />);
    expect(busy.match(/ disabled=""/g)).toHaveLength(2);
    const idle = wrap(<ProposalRow proposal={proposal()} busy={false} onDecide={() => undefined} />);
    expect(idle).not.toContain(' disabled=""');
  });

  it('shows the spinner on the button of the decision in flight and keeps the other one disabled', () => {
    const confirming = wrap(<ProposalRow proposal={proposal()} busy active="confirm" onDecide={() => undefined} />);
    expect(confirming.match(/aria-busy="true"/g)).toHaveLength(1);
    expect(confirming.indexOf('aria-busy="true"')).toBeLessThan(confirming.indexOf('misa-amis-name-reject'));
    const rejecting = wrap(<ProposalRow proposal={proposal()} busy active="reject" onDecide={() => undefined} />);
    expect(rejecting.indexOf('aria-busy="true"')).toBeGreaterThan(rejecting.indexOf('misa-amis-name-confirm'));
  });

  it('says so, with a retry, when the list could not be loaded, and stays silent for a member who may not decide', () => {
    // Rendered on the server the list is not fetched; a failed query is not tried again on mount, so its error is what the component reads.
    cache.current.setDefaultOptions({ queries: { retryOnMount: false } });
    const failWith = (error: Error & { status?: number }) => {
      const query = cache.current.getQueryCache().build(cache.current, { queryKey: ['misaAmis', 'matches', 'proposals'] });
      query.setState({ status: 'error', error, fetchStatus: 'idle', data: undefined });
      return wrap(<MisaAmisNameProposals connectionId={ID} onDecided={() => undefined} />);
    };
    const failed = failWith(new Error('network'));
    expect(failed).toContain('misa-amis-names-load-error');
    expect(failed).toContain('misa-amis-names-retry');
    cache.current.clear();
    expect(failWith(Object.assign(new Error('forbidden'), { status: 403 }))).toBe('');
  });

  it('has the same keys in Vietnamese and English', () => {
    const keys = (o: object, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v !== null ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
    expect(keys(viMessages.misaAmisNames).sort()).toEqual(keys(en.misaAmisNames).sort());
  });
});
