// SPDX-License-Identifier: AGPL-3.0-only
// Account rules vendor picker & filter (#1453): pure vendor search/filter helpers, SSR rendering for owner/admin vs
// read-only viewer/member scoping, accessible <Label htmlFor> bindings, keyboard/clear-reset hooks, and 44px mobile targets.
import { readFileSync } from 'node:fs';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CategorizationRule } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { ACCOUNT_RULE_EVERY_VENDOR, filterPartyChoices, filterRulesByVendor, ruleVendorOptions } from '../src/lib/account-rules.ts';

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
vi.mock('../src/components/entity-switcher.tsx', () => ({ useChosenEntity: () => ({ ready: true, legalEntityId: undefined }) }));
vi.mock('../src/components/form-dialog.tsx', async () => {
  const React = await import('react');
  return {
    useLive: () => ({ current: true }),
    FormDialog: (p: { title: string; submitLabel: string; children: unknown }) =>
      React.createElement('form', { 'aria-label': p.title }, p.children as never, React.createElement('button', { type: 'submit' }, p.submitLabel)),
  };
});

const { AccountRulesCard, AddKeywordRuleDialog } = await import('../src/routes/account-rules.tsx');

const sampleRules: CategorizationRule[] = [
  {
    id: 'r1',
    vendor: null,
    matchKind: 'keyword',
    matchText: 'chiet khau',
    label: 'Chiết khấu',
    accountCode: '6422',
    confirmedBy: 'an@example.test',
    confirmedAt: '2026-11-20T00:00:00.000Z',
    sourceDocument: null,
    corrections: 0,
  },
  {
    id: 'r2',
    vendor: { partyId: 'p-vnpt', name: 'VNPT Hà Nội' },
    matchKind: 'description',
    matchText: 'cuoc internet thang',
    label: 'Cước internet tháng 10/2026',
    accountCode: '6427',
    confirmedBy: 'an@example.test',
    confirmedAt: '2026-11-21T00:00:00.000Z',
    sourceDocument: { documentId: 'd1', series: 'C26TAB', number: '0012', invoiceDate: '2026-10-15' },
    corrections: 1,
  },
  {
    id: 'r3',
    vendor: { partyId: 'p-evn', name: 'Điện lực TP.HCM' },
    matchKind: 'keyword',
    matchText: 'tien dien',
    label: 'Tiền điện',
    accountCode: '6422',
    confirmedBy: 'an@example.test',
    confirmedAt: '2026-11-22T00:00:00.000Z',
    sourceDocument: null,
    corrections: 0,
  },
];

const sampleParties = [
  { id: 'p-evn', name: 'Điện lực TP.HCM', taxCode: '0300942001', duplicates: [] },
  { id: 'p-vnpt', name: 'VNPT Hà Nội', taxCode: '0100684378', duplicates: [{ name: 'Bưu điện Hà Nội', taxCode: '0100684378-001' }] },
  { id: 'p-fpt', name: 'FPT Telecom', taxCode: null, duplicates: [] },
];

function render(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="UTC">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('account rules vendor helpers (#1453)', () => {
  it('collects distinct vendor options sorted in Vietnamese and tracks whether shared rules exist', () => {
    expect(ruleVendorOptions(sampleRules)).toEqual({
      hasEveryVendor: true,
      vendors: [
        { partyId: 'p-evn', name: 'Điện lực TP.HCM' },
        { partyId: 'p-vnpt', name: 'VNPT Hà Nội' },
      ],
    });
    expect(ruleVendorOptions(sampleRules.slice(1, 2))).toEqual({
      hasEveryVendor: false,
      vendors: [{ partyId: 'p-vnpt', name: 'VNPT Hà Nội' }],
    });
    expect(ruleVendorOptions([])).toEqual({ hasEveryVendor: false, vendors: [] });
  });

  it('filters rules by all, shared (every vendor), or a chosen vendor partyId', () => {
    expect(filterRulesByVendor(sampleRules, '')).toHaveLength(3);
    expect(filterRulesByVendor(sampleRules, ACCOUNT_RULE_EVERY_VENDOR).map((r) => r.id)).toEqual(['r1']);
    expect(filterRulesByVendor(sampleRules, 'p-vnpt').map((r) => r.id)).toEqual(['r2']);
    expect(filterRulesByVendor(sampleRules, 'p-missing')).toEqual([]);
  });

  it('searches parties by Vietnamese-folded name, tax code, and duplicate aliases with prefix priority', () => {
    expect(filterPartyChoices(sampleParties, 'dien luc').items.map((p) => p.id)).toEqual(['p-evn']);
    expect(filterPartyChoices(sampleParties, '0100684378').items.map((p) => p.id)).toEqual(['p-vnpt']);
    expect(filterPartyChoices(sampleParties, 'buu dien').items.map((p) => p.id)).toEqual(['p-vnpt']);
    expect(filterPartyChoices(sampleParties, '').total).toBe(3);
    const capped = filterPartyChoices(sampleParties, '', 2);
    expect(capped.items).toHaveLength(2);
    expect(capped.total).toBe(3);
  });
});

describe('AccountRulesCard vendor display, filtering, and viewer scoping', () => {
  beforeEach(() => {
    client.current.clear();
    client.current.setQueryData(['accounts', 'list'], [{ code: '6422', name: 'Chi phí QLDN', parentCode: null, rootCode: '642', active: true, custom: false }]);
    client.current.setQueryData(['accountRules', 'list'], sampleRules);
  });

  it('renders each rule vendor and a labeled, touch-friendly vendor filter for both vi and en', () => {
    for (const [locale, msgs] of [
      ['vi', viMessages],
      ['en', en],
    ] as const) {
      const html = render(<AccountRulesCard canManage />, locale);
      expect(html).toContain(msgs.accountRules.allVendors);
      expect(html).toContain('VNPT Hà Nội');
      expect(html).toContain('Điện lực TP.HCM');
      expect(html).toContain(`>${msgs.accountRules.filterVendor}</label>`);
      const filterMatch = /<label[^>]*for="([^"]+)"[^>]*>[^<]*<\/label>.*?<select[^>]*id="([^"]+)"[^>]*data-testid="account-rules-vendor-filter"/.exec(html);
      expect(filterMatch?.[1]).toBeTruthy();
      expect(filterMatch?.[1]).toBe(filterMatch?.[2]);
      expect(html).toContain(`value="">${msgs.accountRules.filterAll}</option>`);
      expect(html).toContain(`value="${ACCOUNT_RULE_EVERY_VENDOR}">${msgs.accountRules.allVendors}</option>`);
      expect(html).toContain('value="p-vnpt">VNPT Hà Nội</option>');
      expect(html).toContain('max-md:min-h-11');
    }
  });

  it('allows read-only viewers/members to see rules and filter while hiding add and remove controls', () => {
    const html = render(<AccountRulesCard canManage={false} />, 'vi');
    expect(html).toContain('data-testid="account-rules-vendor-filter"');
    expect(html).toContain('VNPT Hà Nội');
    expect(html).not.toContain(`>${viMessages.accountRules.addTitle}<`);
    expect(html).not.toContain(`>${viMessages.accountRules.remove}<`);
    expect(html).not.toContain('<form');
  });

  it('omits the vendor filter when there are no rules yet', () => {
    client.current.setQueryData(['accountRules', 'list'], []);
    const html = render(<AccountRulesCard canManage />, 'vi');
    expect(html).not.toContain('data-testid="account-rules-vendor-filter"');
    expect(html).toContain(viMessages.accountRules.empty);
  });
});

describe('AddKeywordRuleDialog vendor picker accessibility and keyboard/clear wiring', () => {
  beforeEach(() => {
    client.current.clear();
    client.current.setQueryData(['accounts', 'list'], [{ code: '6422', name: 'Chi phí QLDN', parentCode: null, rootCode: '642', active: true, custom: false }]);
  });

  it('renders a labeled optional vendor combobox with hint and 44px mobile touch target in vi and en', () => {
    for (const [locale, msgs] of [
      ['vi', viMessages],
      ['en', en],
    ] as const) {
      const html = render(<AddKeywordRuleDialog rules={[]} onClose={() => undefined} />, locale);
      expect(html).toContain(msgs.accountRules.vendor);
      expect(html).toContain(msgs.accountRules.vendorHint);
      expect(html).toContain('role="combobox"');
      expect(html).toContain('aria-autocomplete="list"');
      expect(html).toContain('data-testid="account-rule-vendor-input"');
      expect(html).toContain('max-md:min-h-11');
      const labelPair = new RegExp(`<label[^>]*for="([^"]+)"[^>]*>${msgs.accountRules.vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/label>[\\s\\S]*?<input[^>]*id="\\1"[^>]*role="combobox"`).exec(html);
      expect(labelPair).not.toBeNull();
      expect(html.indexOf(msgs.accountRules.keyword)).toBeLessThan(html.indexOf(msgs.accountRules.vendor));
      expect(html.indexOf(msgs.accountRules.vendor)).toBeLessThan(html.indexOf(msgs.accountRules.account));
    }
  });

  it('wires keyboard navigation, Escape isolation inside FormDialog, clear resets, and org party listing', () => {
    const src = readFileSync(new URL('../src/routes/account-rules.tsx', import.meta.url), 'utf8');
    expect(src).toContain('orpc.parties.list.queryOptions({ input: { all: true } })');
    expect(src).toContain("event.key === 'ArrowDown'");
    expect(src).toContain("event.key === 'ArrowUp'");
    expect(src).toContain("event.key === 'Enter' && open && !event.metaKey && !event.ctrlKey");
    expect(src).toContain("event.key === 'Escape' && open");
    expect(src).toContain('event.nativeEvent.stopPropagation()');
    expect(src).toContain('ignoreNextFocusRef.current = true');
    expect(src).toContain('aria-controls={listboxMounted ? listId : undefined}');
    expect(src).toContain('role="listbox"');
    expect(src).toContain('role="option"');
    expect(src).toContain('max-md:min-h-11');
    expect(src).toContain('data-testid="account-rule-vendor-clear"');
    expect(src).toContain('data-testid="account-rules-vendor-filter-clear"');
    expect(src).toContain("setVendorError(t('vendorPickRequired'))");
  });
});
