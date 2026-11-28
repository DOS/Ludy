// SPDX-License-Identifier: AGPL-3.0-only
// Unit, SSR, and mounted DOM tests for TC2 enterprise tax-code lookup (#4989):
// pure helpers, i18n parity, deployment/org toggles, 10/13-digit lookup vs 12-digit refusal,
// two-click fill without overwriting non-empty fields, error states, stale-response guard,
// accessibility attributes, 44 px mobile hit targets, and PARTY_TAX_CODE_TAKEN handling across all 3 forms.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartyTaxLookupResult } from '@ludy/kernel-contract';
import { FakeDomNode, createScopedDomHarness } from './fake-dom.ts';

const testState = vi.hoisted(() => ({
  partyTaxLookup: true as boolean | undefined,
  queryClient: null as unknown as QueryClient,
  lookupImpl: null as null | ((input: { taxCode: string }) => Promise<PartyTaxLookupResult>),
  lookupCalls: [] as Array<{ taxCode: string }>,
  createImpl: null as null | ((input: Record<string, unknown>) => Promise<{ partyId: string; version: number }>),
  createCalls: [] as Array<Record<string, unknown>>,
  updateImpl: null as null | ((input: Record<string, unknown>) => Promise<{ partyId: string; version: number }>),
  updateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({
    modules: ['kernel', 'crm', 'finance'],
    ...(testState.partyTaxLookup !== undefined ? { partyTaxLookup: testState.partyTaxLookup } : {}),
  }),
}));

vi.mock('@tanstack/react-router', async () => {
  const { createElement: h } = await import('react');
  return {
    useParams: () => ({ slug: 'acme' }),
    Link: ({ children, ...rest }: { children?: unknown }) => h('a', rest, children as never),
  };
});

vi.mock('@ludy/ui/components/sheet', async () => {
  const { createElement: h } = await import('react');
  return {
    Sheet: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? h('div', { 'data-slot': 'sheet' }, children) : null),
    SheetContent: ({ children, closeLabel, ...rest }: { children?: ReactNode; closeLabel: string; [k: string]: unknown }) =>
      h('section', { role: 'dialog', 'data-slot': 'sheet-content', 'data-close-label': closeLabel, ...rest }, children),
    SheetHeader: ({ children, className }: { children?: ReactNode; className?: string }) => h('header', { 'data-slot': 'sheet-header', className }, children),
    SheetTitle: ({ children, className }: { children?: ReactNode; className?: string }) => h('h2', { 'data-slot': 'sheet-title', className }, children),
    SheetDescription: ({ children, className }: { children?: ReactNode; className?: string }) => h('p', { 'data-slot': 'sheet-description', className }, children),
    SheetBody: ({ children, className }: { children?: ReactNode; className?: string }) => h('div', { 'data-slot': 'sheet-body', className }, children),
    SheetFooter: ({ children, className }: { children?: ReactNode; className?: string }) => h('footer', { 'data-slot': 'sheet-footer', className }, children),
  };
});

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  const { describeError } = await import('../src/lib/errors.ts');
  const { activeLocale, translator } = await import('../src/i18n/runtime.ts');
  testState.queryClient = new QC({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  const makeApi = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: unknown }) => ({
            queryKey: opts?.input !== undefined ? [...path, opts.input] : path,
            queryFn: () => Promise.resolve({ items: [], next: null }),
          });
        }
        if (prop === 'mutationOptions') {
          return (opts?: { onSuccess?: (data: unknown) => void; onError?: (err: unknown) => void }) => ({
            mutationFn: async (input: Record<string, unknown>) => {
              const key = path.join('.');
              if (key === 'parties.taxLookup') {
                const payload = input as { taxCode: string };
                testState.lookupCalls.push(payload);
                if (!testState.lookupImpl) throw new Error('lookupImpl not set');
                return testState.lookupImpl(payload);
              }
              if (key === 'parties.create') {
                testState.createCalls.push(input);
                if (!testState.createImpl) return { partyId: '00000000-0000-4000-8000-000000000099', version: 1 };
                return testState.createImpl(input);
              }
              if (key === 'parties.update') {
                testState.updateCalls.push(input);
                if (!testState.updateImpl) return { partyId: '00000000-0000-4000-8000-000000000001', version: 2 };
                return testState.updateImpl(input);
              }
              return {};
            },
            ...(opts?.onSuccess ? { onSuccess: opts.onSuccess } : {}),
            ...(opts?.onError ? { onError: opts.onError } : {}),
          });
        }
        if (prop === 'key') return () => path;
        return makeApi([...path, prop]);
      },
    });

  return {
    orpc: makeApi([]),
    client: {
      parties: {
        create: async (input: Record<string, unknown>) => {
          testState.createCalls.push(input);
          if (!testState.createImpl) return { partyId: '00000000-0000-4000-8000-000000000099', version: 1 };
          return testState.createImpl(input);
        },
        setCompany: async () => ({ partyId: 'p1', version: 2 }),
      },
      crm: {
        contacts: {
          list: async () => ({ items: [], next: null }),
        },
      },
    },
    queryClient: testState.queryClient,
    errorMessage: (e: unknown) => describeError(e, translator(), activeLocale()),
    takeOrgLeftNotice: () => null,
  };
});

// Install a scoped DOM with `oninput` before loading react-dom/client so React 19 tracks input events on FakeDomNode.
const bootstrapDom = createScopedDomHarness();
bootstrapDom.installScopedDom();
(globalThis.document as unknown as Record<string, unknown>).oninput = null;
const { createRoot } = await import('react-dom/client');
await bootstrapDom.teardownScopedDom();

const { renderToStaticMarkup } = await import('react-dom/server');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { catalog, setActiveLocale } = await import('../src/i18n/runtime.ts');
const { classifyTaxLookupStatus, enterpriseTaxCode, isPartyTaxLookupDeployed } = await import('../src/components/tax-lookup-card.tsx');
const { EditParty } = await import('../src/components/party-edit.tsx');
const { AddContactPanel } = await import('../src/components/add-contact-panel.tsx');
const { NewPartyGroup } = await import('../src/components/deal-party-new.tsx');

const valueSetter = Object.getOwnPropertyDescriptor(FakeDomNode.prototype, 'value')!.set!;

function setInputValue(node: FakeDomNode, nextValue: string): void {
  // React 19's isTextInputElement rejects <input> when node.type is ''; HTML DOM defaults untyped inputs to 'text'.
  if (node.tagName === 'INPUT' && node.type === '') node.type = 'text';
  valueSetter.call(node, nextValue);
  node.dispatchEvent({ type: 'input', bubbles: true, cancelable: true });
}

function blurNode(node: FakeDomNode): void {
  node.dispatchEvent({ type: 'blur', bubbles: true, cancelable: true });
  node.dispatchEvent({ type: 'focusout', bubbles: true, cancelable: true });
}

function clickNode(node: FakeDomNode): void {
  node.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function waitUntil(predicate: () => boolean, label: string, maxAttempts = 60): Promise<void> {
  for (let i = 0; i < maxAttempts; i += 1) {
    if (predicate()) return;
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    });
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

const ACTIVE_RESULT: PartyTaxLookupResult = {
  found: true,
  taxCode: '0101234564',
  name: 'CÔNG TY TNHH MẪU SÁNG',
  address: 'Số 12 Đường Lê Lợi, Quận 1, TP. Hồ Chí Minh',
  statusText: 'Đang hoạt động',
  source: 'casso',
  cached: false,
  household: false,
};

const INACTIVE_BRANCH_RESULT: PartyTaxLookupResult = {
  found: true,
  taxCode: '0101234564-001',
  name: 'CHI NHÁNH CÔNG TY MẪU SÁNG',
  address: 'Số 45 Đường Trần Phú, Hà Nội',
  statusText: 'Ngừng hoạt động',
  source: 'casso',
  cached: true,
  household: false,
};

function renderStatic(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={testState.queryClient}>
      <I18nProvider>{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('tax lookup pure helpers and i18n (#4989)', () => {
  it('accepts 10 and 13 (10-3) tax codes and refuses 12-digit citizen IDs and invalid inputs', () => {
    expect(enterpriseTaxCode('0101234564')).toBe('0101234564');
    expect(enterpriseTaxCode('0101 234 564')).toBe('0101234564');
    expect(enterpriseTaxCode('0101.234.564')).toBe('0101234564');
    expect(enterpriseTaxCode('0101234564-001')).toBe('0101234564-001');
    expect(enterpriseTaxCode('0101234564001')).toBe('0101234564-001');

    // 12-digit personal citizen IDs must never trigger lookup.
    expect(enterpriseTaxCode('001000000001')).toBeNull();
    expect(enterpriseTaxCode('0010 0000 0001')).toBeNull();
    expect(enterpriseTaxCode('')).toBeNull();
    expect(enterpriseTaxCode('12345')).toBeNull();
  });

  it('classifies operating status strings without relying on color alone', () => {
    expect(classifyTaxLookupStatus('Đang hoạt động')).toBe('active');
    expect(classifyTaxLookupStatus('Active')).toBe('active');
    expect(classifyTaxLookupStatus('Ngừng hoạt động')).toBe('inactive');
    expect(classifyTaxLookupStatus('Tạm ngừng hoạt động')).toBe('inactive');
    expect(classifyTaxLookupStatus('Không hoạt động')).toBe('inactive');
    expect(classifyTaxLookupStatus('Inactive')).toBe('inactive');
    expect(classifyTaxLookupStatus(null)).toBe('unknown');
    expect(classifyTaxLookupStatus('')).toBe('unknown');
    expect(classifyTaxLookupStatus('Chờ xác minh')).toBe('unknown');
  });

  it('has complete vi and en labels without em or en dashes', () => {
    expect(catalog('vi').contacts.taxLookup.status).toEqual({
      active: 'Đang hoạt động',
      inactive: 'Ngừng hoạt động',
      unknown: 'Không rõ',
    });
    expect(catalog('en').contacts.taxLookup.status).toEqual({
      active: 'Active',
      inactive: 'Inactive',
      unknown: 'Unknown',
    });
    for (const locale of ['vi', 'en'] as const) {
      const msg = JSON.stringify(catalog(locale).contacts.taxLookup);
      expect(msg).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe('tax lookup UI across EditParty, AddContactPanel, and NewPartyGroup (#4989)', () => {
  const domHarness = createScopedDomHarness();

  beforeEach(() => {
    setActiveLocale('vi');
    testState.partyTaxLookup = true;
    testState.queryClient.clear();
    testState.lookupImpl = null;
    testState.lookupCalls = [];
    testState.createImpl = null;
    testState.createCalls = [];
    testState.updateImpl = null;
    testState.updateCalls = [];
  });

  afterEach(async () => {
    testState.lookupImpl = null;
    await domHarness.teardownScopedDom();
  });

  function mount(node: ReactNode, locale: 'vi' | 'en' = 'vi') {
    setActiveLocale(locale);
    const body = domHarness.installScopedDom();
    const container = new FakeDomNode(1, 'div');
    body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    domHarness.setMountedRoot(root);
    return {
      container,
      render: async (nextNode: ReactNode = node) => {
        await act(async () => {
          root.render(
            <QueryClientProvider client={testState.queryClient}>
              <I18nProvider>{nextNode}</I18nProvider>
            </QueryClientProvider>,
          );
        });
      },
    };
  }

  it('keeps forms hidden and unchanged when deployment partyTaxLookup is off', () => {
    testState.partyTaxLookup = false;
    expect(isPartyTaxLookupDeployed()).toBe(false);

    const editHtml = renderStatic(
      <EditParty party={{ id: 'p1', name: '', taxCode: null, address: null, email: null, phone: null, version: 1 }} ns="contacts" onDone={() => undefined} />,
    );
    expect(editHtml).not.toContain('tax-lookup-trigger');
    expect(editHtml).not.toContain('tax-lookup-region');

    const dealHtml = renderStatic(<NewPartyGroup initialName="0101234564" onCreated={() => undefined} onCancel={() => undefined} />);
    expect(dealHtml).not.toContain('tax-lookup-trigger');
    expect(dealHtml).not.toContain('tax-lookup-region');
  });

  it('EditParty: skips 12-digit citizen ID, triggers on blur without duplicate calls, preserves non-empty name, and fills empty address', async () => {
    testState.lookupImpl = async () => ACTIVE_RESULT;
    const { container, render } = mount(
      <EditParty
        party={{ id: 'p1', name: 'Tên giữ nguyên', taxCode: null, address: null, email: null, phone: null, version: 1 }}
        ns="contacts"
        kind="organization"
        onDone={() => undefined}
      />,
    );
    await render();

    const taxInput = container.querySelector('#party-p1-taxCode')!;
    const nameInput = container.querySelector('#party-p1-name')!;
    const addressInput = container.querySelector('#party-p1-address')!;

    // 12-digit citizen ID must not show the button or call lookup on blur.
    await act(async () => {
      setInputValue(taxInput, '001000000001');
    });
    expect(container.querySelector('[data-testid="tax-lookup-trigger"]')).toBeNull();
    await act(async () => {
      blurNode(taxInput);
      await flushMicrotasks();
    });
    expect(testState.lookupCalls).toEqual([]);

    // Valid 10-digit tax code shows button without remounting the input and looks up once on blur.
    await act(async () => {
      setInputValue(taxInput, '0101234564');
    });
    expect(container.querySelector('#party-p1-taxCode')).toBe(taxInput);
    const triggerBtn = container.querySelector('[data-testid="tax-lookup-trigger"]');
    expect(triggerBtn).not.toBeNull();
    expect(triggerBtn?.className).toContain('max-md:min-h-11');

    await act(async () => {
      blurNode(taxInput);
      await flushMicrotasks();
    });
    await waitUntil(() => container.querySelector('[data-testid="tax-lookup-card"]') !== null, 'EditParty card renders');
    expect(testState.lookupCalls).toEqual([{ taxCode: '0101234564' }]);

    // Blurring again without changing the tax code must not refetch.
    await act(async () => {
      blurNode(taxInput);
      await flushMicrotasks();
    });
    expect(testState.lookupCalls).toHaveLength(1);

    // Non-empty name shows existing beside looked-up with NO fill button; empty address has fill button.
    expect(container.querySelector('[data-testid="tax-lookup-field-name-current"]')?.textContent).toBe('Tên giữ nguyên');
    expect(container.querySelector('[data-testid="tax-lookup-field-name-looked-up"]')?.textContent).toBe(ACTIVE_RESULT.name);
    expect(container.querySelector('[data-testid="tax-lookup-fill-name"]')).toBeNull();
    expect(container.querySelector('[data-testid="tax-lookup-status"]')?.textContent).toContain('Đang hoạt động');
    expect(container.querySelector('[data-testid="tax-lookup-date"]')?.textContent).toMatch(/Tra cứu ngày/);

    const fillAddressBtn = container.querySelector('[data-testid="tax-lookup-fill-address"]')!;
    expect(fillAddressBtn.getAttribute('aria-label')).toBe('Điền Địa chỉ');
    expect(fillAddressBtn.className).toContain('max-md:min-h-11');

    await act(async () => {
      clickNode(fillAddressBtn);
    });
    expect(addressInput.value).toBe(ACTIVE_RESULT.address);
    expect(nameInput.value).toBe('Tên giữ nguyên');
    expect(testState.updateCalls).toEqual([]);

    // After filling, address is now non-empty, so its fill button disappears and existing is shown beside looked-up.
    expect(container.querySelector('[data-testid="tax-lookup-fill-address"]')).toBeNull();
    expect(container.querySelector('[data-testid="tax-lookup-field-address-current"]')?.textContent).toBe(ACTIVE_RESULT.address);
  });

  it('EditParty: two clicks fill both empty name and address, and renders outside content as plain text', async () => {
    const xssName = '<script>alert("x")</script> Công ty Thử';
    testState.lookupImpl = async () => ({
      ...ACTIVE_RESULT,
      name: xssName,
      address: '100 Đường Nguyễn Huệ, TP.HCM',
    });
    const { container, render } = mount(
      <EditParty party={{ id: 'p2', name: '', taxCode: null, address: null, email: null, phone: null, version: 1 }} ns="vendors" onDone={() => undefined} />,
    );
    await render();

    await act(async () => {
      setInputValue(container.querySelector('#party-p2-taxCode')!, '0101234564');
    });
    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-trigger"]')!);
      await flushMicrotasks();
    });
    await waitUntil(() => container.querySelector('[data-testid="tax-lookup-card"]') !== null, 'card renders');

    // No <script> element was created in the DOM; textContent preserves literal text.
    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(container.querySelector('[data-testid="tax-lookup-field-name-looked-up"]')?.textContent).toBe(xssName);

    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-fill-name"]')!);
    });
    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-fill-address"]')!);
    });
    expect(container.querySelector('#party-p2-name')?.value).toBe(xssName);
    expect(container.querySelector('#party-p2-address')?.value).toBe('100 Đường Nguyễn Huệ, TP.HCM');
  });

  it('AddContactPanel: supports 13-digit lookup, expands folded address on fill, submits via parties.create, and shows PARTY_TAX_CODE_TAKEN', async () => {
    testState.lookupImpl = async () => INACTIVE_BRANCH_RESULT;
    testState.createImpl = async () => {
      throw Object.assign(new Error('Mã số thuế 0101234564-001 đã thuộc về Công ty Đã Có'), { code: 'PARTY_TAX_CODE_TAKEN' });
    };

    const { container, render } = mount(
      <AddContactPanel kind="organization" open onOpenChange={() => undefined} onSaved={() => undefined} onOpenExisting={() => undefined} />,
    );
    await render();

    // Address starts folded in AddContactPanel.
    expect(container.querySelector('#add-contact-address')).toBeNull();

    const taxInput = container.querySelector('#add-contact-taxCode')!;
    await act(async () => {
      setInputValue(taxInput, '0101234564001');
    });
    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-trigger"]')!);
      await flushMicrotasks();
    });
    await waitUntil(() => container.querySelector('[data-testid="tax-lookup-card"]') !== null, 'AddContactPanel card renders');

    expect(testState.lookupCalls).toEqual([{ taxCode: '0101234564-001' }]);
    expect(container.querySelector('[data-testid="tax-lookup-status"]')?.textContent).toContain('Ngừng hoạt động');

    // Click Fill for name and address; filling address expands "Thông tin thêm".
    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-fill-name"]')!);
    });
    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-fill-address"]')!);
    });
    expect(container.querySelector('#add-contact-name')?.value).toBe(INACTIVE_BRANCH_RESULT.name);
    expect(container.querySelector('#add-contact-address')?.value).toBe(INACTIVE_BRANCH_RESULT.address);

    // Submitting calls parties.create and surfaces PARTY_TAX_CODE_TAKEN naming the existing party.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true });
      await flushMicrotasks();
    });
    await waitUntil(() => container.textContent.includes('Công ty Đã Có'), 'PARTY_TAX_CODE_TAKEN displays');
    expect(testState.createCalls).toHaveLength(1);
    expect(testState.createCalls[0]).toMatchObject({
      kind: 'organization',
      name: INACTIVE_BRANCH_RESULT.name,
      taxCode: '0101234564001',
      address: INACTIVE_BRANCH_RESULT.address,
    });
  });

  it('NewPartyGroup: fills empty name and address from unknown-status lookup, submits via parties.create, and surfaces PARTY_TAX_CODE_TAKEN', async () => {
    testState.lookupImpl = async () => ({
      found: true,
      taxCode: '0123456780',
      name: 'CÔNG TY CỔ PHẦN BÌNH MINH',
      address: 'Số 9 Phan Chu Trinh, Đà Nẵng',
      statusText: null,
      source: 'casso',
      cached: false,
      household: false,
    });
    testState.createImpl = async () => {
      throw Object.assign(new Error('Mã số thuế 0123456780 đã thuộc về Công ty Thuế'), { code: 'PARTY_TAX_CODE_TAKEN' });
    };

    const { container, render } = mount(<NewPartyGroup initialName="0123456780" onCreated={() => undefined} onCancel={() => undefined} />);
    await render();

    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-trigger"]')!);
      await flushMicrotasks();
    });
    await waitUntil(() => container.querySelector('[data-testid="tax-lookup-card"]') !== null, 'NewPartyGroup card renders');
    expect(container.querySelector('[data-testid="tax-lookup-status"]')?.textContent).toContain('Không rõ');

    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-fill-name"]')!);
    });
    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-fill-address"]')!);
    });

    const inputs = container.querySelectorAll('input');
    expect(inputs[0]?.value).toBe('CÔNG TY CỔ PHẦN BÌNH MINH');
    expect(inputs[inputs.length - 1]?.value).toBe('Số 9 Phan Chu Trinh, Đà Nẵng');

    const submitBtn = container.querySelectorAll('button').find((b) => b.textContent.includes('Thêm liên hệ'))!;
    await act(async () => {
      clickNode(submitBtn);
      await flushMicrotasks();
    });
    await waitUntil(() => container.textContent.includes('Công ty Thuế'), 'PARTY_TAX_CODE_TAKEN shows in NewPartyGroup');
    expect(testState.createCalls[0]).toMatchObject({
      kind: 'organization',
      name: 'CÔNG TY CỔ PHẦN BÌNH MINH',
      taxCode: '0123456780',
      address: 'Số 9 Phan Chu Trinh, Đà Nẵng',
    });
  });

  it('shows one clear explanatory line in vi/en when org toggle off, unavailable, rate-limited, or not found, and still allows saving', async () => {
    const errors: Array<{ code: string; msgVi: string; expectedEn: string }> = [
      {
        code: 'TAX_LOOKUP_ORG_DISABLED',
        msgVi: 'Tổ chức chưa bật tra cứu mã số thuế',
        expectedEn: 'Enterprise tax-code lookup is turned off for this organization',
      },
      {
        code: 'TAX_LOOKUP_UNAVAILABLE',
        msgVi: 'Tạm thời không tra được mã số thuế, hãy nhập thủ công hoặc thử lại sau',
        expectedEn: 'The tax code lookup is not answering',
      },
      {
        code: 'TAX_LOOKUP_RATE_LIMIT',
        msgVi: 'Bạn tra cứu mã số thuế quá nhanh, hãy thử lại sau ít phút',
        expectedEn: 'Tax-code lookup rate limit reached for now',
      },
    ];

    const { container, render } = mount(
      <EditParty party={{ id: 'p3', name: 'Công ty Tự Nhập', taxCode: null, address: null, email: null, phone: null, version: 1 }} ns="contacts" onDone={() => undefined} />,
      'en',
    );
    await render();

    const taxInput = container.querySelector('#party-p3-taxCode')!;
    await act(async () => {
      setInputValue(taxInput, '0101234564');
    });
    expect(container.querySelector('[data-testid="tax-lookup-trigger"]')?.textContent).toBe('Look up tax code');

    for (const errCase of errors) {
      testState.lookupImpl = async () => {
        throw Object.assign(new Error(errCase.msgVi), { code: errCase.code });
      };
      await act(async () => {
        clickNode(container.querySelector('[data-testid="tax-lookup-trigger"]')!);
        await flushMicrotasks();
      });
      await waitUntil(
        () => container.querySelector('[data-testid="tax-lookup-error"]')?.textContent?.includes(errCase.expectedEn) ?? false,
        errCase.code,
      );
      expect(container.querySelector('[data-testid="tax-lookup-error"]')?.textContent).toContain(errCase.expectedEn);
    }

    // Not found renders one line and still permits manual submit.
    testState.lookupImpl = async () => ({
      found: false,
      taxCode: '0101234564',
      name: null,
      address: null,
      statusText: null,
      source: 'casso',
      cached: false,
      household: false,
    });
    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-trigger"]')!);
      await flushMicrotasks();
    });
    await waitUntil(() => container.querySelector('[data-testid="tax-lookup-not-found"]') !== null, 'not found renders');
    expect(container.querySelector('[data-testid="tax-lookup-not-found"]')?.textContent).toContain('not in the lookup data');

    // Form remains completely functional and saves normally.
    await act(async () => {
      container.querySelector('form')!.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true });
      await flushMicrotasks();
    });
    expect(testState.updateCalls).toHaveLength(1);
    expect(testState.updateCalls[0]).toMatchObject({ name: 'Công ty Tự Nhập', taxCode: '0101234564' });
  });

  it('allows blur retry on the same tax code after a failed lookup, and stops refetching once it succeeds', async () => {
    let shouldFail = true;
    testState.lookupImpl = async () => {
      if (shouldFail) {
        throw Object.assign(new Error('Tạm thời không tra được mã số thuế, hãy nhập thủ công hoặc thử lại sau'), { code: 'TAX_LOOKUP_UNAVAILABLE' });
      }
      return ACTIVE_RESULT;
    };

    const { container, render } = mount(
      <EditParty party={{ id: 'p-retry', name: '', taxCode: null, address: null, email: null, phone: null, version: 1 }} ns="contacts" onDone={() => undefined} />,
    );
    await render();

    const taxInput = container.querySelector('#party-p-retry-taxCode')!;
    await act(async () => {
      setInputValue(taxInput, '0101234564');
    });

    // First blur fails: error renders and blur dedup resets so the user can retry on blur.
    await act(async () => {
      blurNode(taxInput);
      await flushMicrotasks();
    });
    await waitUntil(() => container.querySelector('[data-testid="tax-lookup-error"]') !== null, 'blur error renders');
    expect(testState.lookupCalls).toHaveLength(1);

    // Second blur on the same unchanged tax code retries lookup and succeeds.
    shouldFail = false;
    await act(async () => {
      blurNode(taxInput);
      await flushMicrotasks();
    });
    await waitUntil(() => container.querySelector('[data-testid="tax-lookup-card"]') !== null, 'blur retry card renders');
    expect(testState.lookupCalls).toHaveLength(2);

    // Third blur after success does not duplicate lookup for the already-loaded snapshot.
    await act(async () => {
      blurNode(taxInput);
      await flushMicrotasks();
    });
    expect(testState.lookupCalls).toHaveLength(2);
  });

  it('discards stale response when taxCode changes while a lookup request is pending', async () => {
    let resolveFirst!: (val: PartyTaxLookupResult) => void;
    testState.lookupImpl = (input) => {
      if (input.taxCode === '0101234564') {
        return new Promise<PartyTaxLookupResult>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(INACTIVE_BRANCH_RESULT);
    };

    const { container, render } = mount(
      <EditParty party={{ id: 'p4', name: '', taxCode: null, address: null, email: null, phone: null, version: 1 }} ns="contacts" onDone={() => undefined} />,
    );
    await render();

    const taxInput = container.querySelector('#party-p4-taxCode')!;
    await act(async () => {
      setInputValue(taxInput, '0101234564');
    });
    await act(async () => {
      clickNode(container.querySelector('[data-testid="tax-lookup-trigger"]')!);
    });
    await waitUntil(() => container.querySelector('[data-testid="tax-lookup-loading"]') !== null, 'loading renders');

    // User switches to a 12-digit citizen ID while the first lookup is still pending.
    await act(async () => {
      setInputValue(taxInput, '001000000001');
    });
    expect(container.querySelector('[data-testid="tax-lookup-loading"]')).toBeNull();

    // First response resolves late: must be discarded and never render the stale card.
    await act(async () => {
      resolveFirst(ACTIVE_RESULT);
      await flushMicrotasks();
    });
    expect(container.querySelector('[data-testid="tax-lookup-card"]')).toBeNull();
  });

  it('AddContactPanel(person) hides tax lookup, EditParty with locked tax code offers lookup for missing address, and NewPartyGroup keeps non-empty name', async () => {
    const personHtml = renderStatic(
      <AddContactPanel kind="person" open onOpenChange={() => undefined} onSaved={() => undefined} onOpenExisting={() => undefined} />,
    );
    expect(personHtml).not.toContain('tax-lookup-trigger');
    expect(personHtml).not.toContain('tax-lookup-region');

    testState.lookupImpl = async () => ACTIVE_RESULT;
    const lockedMount = mount(
      <EditParty party={{ id: 'p5', name: 'Khách Có MST', taxCode: '0101234564', address: null, email: null, phone: null, version: 1 }} ns="customers" onDone={() => undefined} />,
    );
    await lockedMount.render();
    await act(async () => {
      clickNode(lockedMount.container.querySelector('[data-testid="tax-lookup-trigger"]')!);
      await flushMicrotasks();
    });
    await waitUntil(() => lockedMount.container.querySelector('[data-testid="tax-lookup-card"]') !== null, 'locked EditParty card renders');
    expect(lockedMount.container.querySelector('[data-testid="tax-lookup-fill-name"]')).toBeNull();
    expect(lockedMount.container.querySelector('[data-testid="tax-lookup-fill-address"]')).not.toBeNull();
    await domHarness.teardownScopedDom();

    const newPartyMount = mount(<NewPartyGroup initialName="" onCreated={() => undefined} onCancel={() => undefined} />);
    await newPartyMount.render();
    const kindSelect = newPartyMount.container.querySelector('select')!;
    valueSetter.call(kindSelect, 'organization');
    await act(async () => {
      kindSelect.dispatchEvent({ type: 'change', bubbles: true, cancelable: true });
    });
    const allInputs = newPartyMount.container.querySelectorAll('input');
    const nameInput = allInputs[0]!;
    const taxInput = allInputs[3]!;
    await act(async () => {
      setInputValue(nameInput, 'Tên đã gõ trước');
      setInputValue(taxInput, '0101234564');
    });
    await act(async () => {
      clickNode(newPartyMount.container.querySelector('[data-testid="tax-lookup-trigger"]')!);
      await flushMicrotasks();
    });
    await waitUntil(() => newPartyMount.container.querySelector('[data-testid="tax-lookup-card"]') !== null, 'NewPartyGroup non-empty card renders');
    expect(newPartyMount.container.querySelector('[data-testid="tax-lookup-fill-name"]')).toBeNull();
    expect(newPartyMount.container.querySelector('[data-testid="tax-lookup-field-name-current"]')?.textContent).toBe('Tên đã gõ trước');
    await act(async () => {
      clickNode(newPartyMount.container.querySelector('[data-testid="tax-lookup-fill-address"]')!);
    });
    expect(nameInput.value).toBe('Tên đã gõ trước');
  });
});
