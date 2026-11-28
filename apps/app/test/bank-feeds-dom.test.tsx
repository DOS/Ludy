// SPDX-License-Identifier: AGPL-3.0-only
// Mounted browser-like DOM tests for BankFeedsCard (#2127): DESIGN.md §4.2 form validation errors and focus move on
// empty connect name / Tingee credentials / unselected bank account, role="region" landmarks, revoked & expired
// mapped connections, 44 px unmap controls, and live unmap refreshing both accounts and connections.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BankFeedAccountView, BankFeedConnectionView, BankFeedListedAccount, LegalEntity } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';
import type { ChartAccount } from '../src/lib/accounts.ts';
import type { Role } from '../src/lib/members.ts';
import { FakeDomNode, createScopedDomHarness } from './fake-dom.ts';

type ListedItem = BankFeedListedAccount & { listedAt: string };

const testState = vi.hoisted(() => ({
  queryClient: null as unknown as QueryClient,
  connections: [] as BankFeedConnectionView[],
  accounts: [] as BankFeedAccountView[],
  listedByConnection: new Map<string, ListedItem[]>(),
  chart: [] as ChartAccount[],
  entities: [] as LegalEntity[],
  connectSandboxCalls: [] as Array<Record<string, unknown>>,
  connectTingeeCalls: [] as Array<Record<string, unknown>>,
  mapCalls: [] as Array<Record<string, unknown>>,
  unmapCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  testState.queryClient = new QC({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const makeApi = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') {
          return (opts?: { input?: Record<string, unknown> }) => {
            const key = opts?.input !== undefined ? [...path, opts.input] : path;
            const route = path.join('.');
            return {
              queryKey: key,
              queryFn: async () => {
                if (route === 'bankFeeds.accounts') return [...testState.accounts];
                if (route === 'bankFeeds.connections') {
                  return testState.connections.filter(
                    (c) => c.status !== 'revoked' || testState.accounts.some((a) => a.connectionId === c.id),
                  );
                }
                if (route === 'bankFeeds.listed') {
                  const connectionId = String(opts?.input?.connectionId ?? '');
                  return [...(testState.listedByConnection.get(connectionId) ?? [])];
                }
                if (route === 'bankFeeds.hook') {
                  return { exists: false, createdAt: null, rotatedAt: null, lastSeenAt: null, rejectedCount: 0, stopped: false };
                }
                if (route === 'accounts.list') return [...testState.chart];
                if (route === 'legalEntities.list') return [...testState.entities];
                return [];
              },
            };
          };
        }
        if (prop === 'mutationOptions') {
          return (opts: Record<string, unknown> = {}) => {
            const route = path.join('.');
            return {
              mutationFn: async (input: Record<string, unknown>) => {
                if (route === 'bankFeeds.connectSandbox') {
                  testState.connectSandboxCalls.push(input);
                  const id = `c-sbx-${testState.connectSandboxCalls.length}`;
                  testState.connections.unshift({
                    id,
                    provider: 'bank_sandbox',
                    displayName: String(input.displayName ?? 'Sandbox'),
                    status: 'active',
                    connectedAt: '2026-11-28T00:00:00.000Z',
                  });
                  return { connectionId: id };
                }
                if (route === 'bankFeeds.connectTingee') {
                  testState.connectTingeeCalls.push(input);
                  return { connectionId: 'c-tingee-new' };
                }
                if (route === 'bankFeeds.map') {
                  testState.mapCalls.push(input);
                  return { feedAccountId: 'm-new' };
                }
                if (route === 'bankFeeds.unmap') {
                  testState.unmapCalls.push(input);
                  const id = String(input.feedAccountId ?? '');
                  testState.accounts = testState.accounts.filter((a) => a.id !== id);
                  return { feedAccountId: id };
                }
                return {};
              },
              ...opts,
            };
          };
        }
        if (prop === 'key') return () => path;
        return makeApi([...path, prop]);
      },
    });

  return {
    orpc: makeApi([]),
    queryClient: testState.queryClient,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    takeOrgLeftNotice: () => null,
  };
});

// Install scoped DOM with `oninput`/`onchange` before loading react-dom/client so React 19 enables event tracking on FakeDomNode.
const bootstrapDom = createScopedDomHarness();
bootstrapDom.installScopedDom();
(globalThis.document as unknown as Record<string, unknown>).oninput = null;
(globalThis.document as unknown as Record<string, unknown>).onchange = null;
const { createRoot } = await import('react-dom/client');
await bootstrapDom.teardownScopedDom();

const { BankFeedsCard } = await import('../src/routes/bank-feeds.tsx');

const AT = '2026-10-31T00:00:00.000Z';
const valueSetter = Object.getOwnPropertyDescriptor(FakeDomNode.prototype, 'value')!.set!;

function setInputValue(node: FakeDomNode, nextValue: string): void {
  if (node.tagName === 'INPUT' && node.type === '') node.type = 'text';
  valueSetter.call(node, nextValue);
  node.dispatchEvent({ type: 'input', bubbles: true, cancelable: true });
}

function setSelectValue(node: FakeDomNode, nextValue: string): void {
  valueSetter.call(node, nextValue);
  node.dispatchEvent({ type: 'change', bubbles: true, cancelable: true });
}

function clickNode(node: FakeDomNode): void {
  node.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
}

function submitForm(form: FakeDomNode): void {
  form.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true });
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
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

const makeAccount = (id: string, connectionId: string, externalAccountId: string, over: Partial<BankFeedAccountView> = {}): BankFeedAccountView => ({
  id,
  connectionId,
  provider: 'bank_sandbox',
  connectionName: 'Ngân hàng thử',
  connectionStatus: 'active',
  externalAccountId,
  bankAccount: '1121',
  legalEntityId: 'e1',
  lastSyncedAt: null,
  feedFrom: null,
  feedFromEarliest: '2026-11-13',
  lastPull: null,
  ...over,
});

describe('BankFeedsCard DOM behavior (#2127)', () => {
  const domHarness = createScopedDomHarness();

  beforeEach(() => {
    testState.queryClient.clear();
    testState.connections = [{ id: 'c1', provider: 'bank_sandbox', displayName: 'Ngân hàng thử', status: 'active', connectedAt: AT }];
    testState.accounts = [];
    testState.listedByConnection = new Map([
      [
        'c1',
        [
          { externalAccountId: 'SBX-001', displayName: 'Tài khoản thanh toán', listedAt: AT },
          { externalAccountId: 'SBX-002', displayName: 'Tài khoản tiết kiệm', listedAt: AT },
        ],
      ],
    ]);
    testState.chart = [
      { code: '1121', name: 'Tiền Việt Nam', parentCode: '112', rootCode: '1121', active: true, custom: false },
      { code: '1121.VCB', name: 'Vietcombank', parentCode: '1121', rootCode: '1121', active: true, custom: true },
    ];
    testState.entities = [{ id: 'e1', name: 'Công ty TNHH Mẫu', kind: 'company', taxCode: null, parentId: null, isDefault: true, createdAt: AT, updatedAt: AT }];
    testState.connectSandboxCalls = [];
    testState.connectTingeeCalls = [];
    testState.mapCalls = [];
    testState.unmapCalls = [];
  });

  afterEach(async () => {
    await domHarness.teardownScopedDom();
  });

  async function mountCard(
    role: Role,
    options: { locale?: 'en' | 'vi'; offers?: { sandbox: boolean; tingee: boolean } } = {},
  ): Promise<FakeDomNode> {
    const locale = options.locale ?? 'en';
    const body = domHarness.installScopedDom();
    const container = new FakeDomNode(1, 'div');
    body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    domHarness.setMountedRoot(root);
    const node: ReactNode = (
      <QueryClientProvider client={testState.queryClient}>
        <IntlProvider locale={locale} messages={catalog(locale)} timeZone="UTC">
          <BankFeedsCard role={role} {...(options.offers ? { offers: options.offers } : {})} />
        </IntlProvider>
      </QueryClientProvider>
    );
    await act(async () => {
      root.render(node);
      await flushAsync();
    });
    return container;
  }

  it('places aria-label on a valid region landmark for both managers and read-only viewers', async () => {
    const ownerContainer = await mountCard('owner');
    await waitUntil(() => ownerContainer.querySelectorAll('li').length > 0, 'owner card loaded');
    const ownerCard = ownerContainer.querySelector('[data-slot="card"]');
    expect(ownerCard?.getAttribute('role')).toBe('region');
    expect(ownerCard?.getAttribute('aria-label')).toBe(en.bankFeeds.title);

    await domHarness.teardownScopedDom();
    testState.queryClient.clear();
    testState.accounts = [makeAccount('m1', 'c1', 'SBX-001')];
    const viewerContainer = await mountCard('viewer');
    await waitUntil(() => viewerContainer.querySelector('[data-slot="card"]') !== null, 'viewer card loaded');
    const viewerCard = viewerContainer.querySelector('[data-slot="card"]');
    expect(viewerCard?.getAttribute('role')).toBe('region');
    expect(viewerCard?.getAttribute('aria-label')).toBe(en.bankFeeds.title);
  });

  it('shows inline DESIGN.md §4.2 error under empty connect name, moves focus to it, clears on input, and submits once filled', async () => {
    const container = await mountCard('owner', { offers: { sandbox: true, tingee: false } });
    await waitUntil(() => container.querySelector(`form[aria-label="${en.bankFeeds.connectTitle}"]`) !== null, 'connect form rendered');

    const form = container.querySelector(`form[aria-label="${en.bankFeeds.connectTitle}"]`)!;
    const nameInput = form.querySelector('input')!;
    expect(nameInput.getAttribute('aria-invalid')).toBeNull();

    // Empty submit (whitespace only): refuses, renders FieldError under field, and moves focus onto input.
    await act(async () => {
      setInputValue(nameInput, '   ');
    });
    await act(async () => {
      submitForm(form);
    });

    expect(testState.connectSandboxCalls).toEqual([]);
    const errorId = `${nameInput.id}-error`;
    const errorEl = form.querySelector(`[id="${errorId}"]`);
    expect(errorEl?.textContent).toBe(en.bankFeeds.nameNeeded);
    expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    expect(nameInput.getAttribute('aria-describedby')).toBe(errorId);
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(nameInput);

    // Editing clears the error immediately; valid submit calls connectSandbox and resets the field.
    await act(async () => {
      setInputValue(nameInput, 'Ngân hàng ACB');
    });
    expect(form.querySelector(`[id="${errorId}"]`)).toBeNull();
    expect(nameInput.getAttribute('aria-invalid')).toBeNull();

    await act(async () => {
      submitForm(form);
      await flushAsync();
    });
    expect(testState.connectSandboxCalls).toEqual([{ displayName: 'Ngân hàng ACB' }]);
    expect(nameInput.value).toBe('');
  });

  it('validates Tingee credentials inline and moves focus to the first missing field', async () => {
    const container = await mountCard('owner', { locale: 'vi', offers: { sandbox: false, tingee: true } });
    await waitUntil(() => container.querySelector(`form[aria-label="${viMessages.bankFeeds.tingee.title}"]`) !== null, 'tingee form rendered');

    const form = container.querySelector(`form[aria-label="${viMessages.bankFeeds.tingee.title}"]`)!;
    const inputs = form.querySelectorAll('input');
    const clientInput = inputs[0]!;
    const secretInput = inputs[1]!;

    await act(async () => {
      submitForm(form);
    });
    expect(testState.connectTingeeCalls).toEqual([]);
    expect(form.querySelector(`[id="${clientInput.id}-error"]`)?.textContent).toBe(viMessages.bankFeeds.tingee.clientIdNeeded);
    expect(form.querySelector(`[id="${secretInput.id}-error"]`)?.textContent).toBe(viMessages.bankFeeds.tingee.secretNeeded);
    expect(clientInput.getAttribute('aria-invalid')).toBe('true');
    expect(secretInput.getAttribute('aria-invalid')).toBe('true');
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(clientInput);

    // Fill Client ID only: second submit focuses Secret Token.
    await act(async () => {
      setInputValue(clientInput, 'client-123');
    });
    expect(form.querySelector(`[id="${clientInput.id}-error"]`)).toBeNull();
    await act(async () => {
      submitForm(form);
    });
    expect(testState.connectTingeeCalls).toEqual([]);
    expect(form.querySelector(`[id="${secretInput.id}-error"]`)?.textContent).toBe(viMessages.bankFeeds.tingee.secretNeeded);
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(secretInput);
  });

  it('shows inline error under unselected bank account, focuses the select, clears on choice, and submits map', async () => {
    const container = await mountCard('owner');
    const formSelector = `form[aria-label="${en.bankFeeds.mapForm.replace('{name}', 'Tài khoản thanh toán')}"]`;
    await waitUntil(() => container.querySelector(formSelector) !== null, 'map form rendered');

    const form = container.querySelector(formSelector)!;
    const bankSelect = form.querySelector(`select[aria-label="${en.bankFeeds.bankAccount}"]`)!;
    expect(bankSelect.value).toBe('');

    await act(async () => {
      submitForm(form);
    });

    expect(testState.mapCalls).toEqual([]);
    const errorId = `${bankSelect.id}-error`;
    expect(form.querySelector(`[id="${errorId}"]`)?.textContent).toBe(en.bankFeeds.bankAccountNeeded);
    expect(bankSelect.getAttribute('aria-invalid')).toBe('true');
    expect(bankSelect.getAttribute('aria-describedby')).toBe(errorId);
    expect((globalThis.document as unknown as { activeElement: unknown }).activeElement).toBe(bankSelect);

    await act(async () => {
      setSelectValue(bankSelect, '1121.VCB');
    });
    expect(form.querySelector(`[id="${errorId}"]`)).toBeNull();
    expect(bankSelect.getAttribute('aria-invalid')).toBeNull();

    await act(async () => {
      submitForm(form);
      await flushAsync();
    });
    expect(testState.mapCalls).toHaveLength(1);
    expect(testState.mapCalls[0]).toMatchObject({
      connectionId: 'c1',
      externalAccountId: 'SBX-001',
      bankAccount: '1121.VCB',
      feedFrom: null,
    });
  });

  it('displays mapped revoked and expired connections with hints and 44 px unmap buttons, and detaches cleanly on click', async () => {
    testState.connections = [
      { id: 'c-rev', provider: 'bank_sandbox', displayName: 'Kết nối đã ngắt', status: 'revoked', connectedAt: AT },
      { id: 'c-exp', provider: 'bank_sandbox', displayName: 'Kết nối hết hạn', status: 'expired', connectedAt: AT },
    ];
    testState.accounts = [
      makeAccount('m-rev', 'c-rev', 'SBX-001', { connectionName: 'Kết nối đã ngắt', connectionStatus: 'revoked' }),
      makeAccount('m-exp', 'c-exp', 'SBX-003', { connectionName: 'Kết nối hết hạn', connectionStatus: 'expired', bankAccount: '1121.VCB' }),
    ];
    testState.listedByConnection = new Map([
      [
        'c-rev',
        [
          { externalAccountId: 'SBX-001', displayName: 'TK Cũ', listedAt: AT },
          { externalAccountId: 'SBX-002', displayName: 'TK Chưa Gắn', listedAt: AT },
        ],
      ],
      ['c-exp', [{ externalAccountId: 'SBX-003', displayName: 'TK Hết Hạn', listedAt: AT }]],
    ]);

    const container = await mountCard('owner', { locale: 'vi' });
    await waitUntil(() => container.textContent.includes('TK Cũ') && container.textContent.includes('TK Hết Hạn'), 'revoked and expired mappings rendered');

    // Revoked connection shows hint + mapped account + enabled min-h-11 unmap, without unmapped accounts or a map form.
    expect(container.textContent).toContain(viMessages.bankFeeds.status.revoked);
    expect(container.textContent).toContain(viMessages.bankFeeds.revokedHint);
    expect(container.textContent).not.toContain('TK Chưa Gắn');
    expect(container.querySelector(`form[aria-label="${viMessages.bankFeeds.mapForm.replace('{name}', 'TK Cũ')}"]`)).toBeNull();

    // Expired connection shows hint + disabled map form + enabled min-h-11 unmap.
    expect(container.textContent).toContain(viMessages.bankFeeds.status.expired);
    expect(container.textContent).toContain(viMessages.bankFeeds.expiredHint);

    const revUnmapBtn = container.querySelector(`button[aria-label="${viMessages.bankFeeds.unmapOf.replace('{name}', 'TK Cũ')}"]`)!;
    const expUnmapBtn = container.querySelector(`button[aria-label="${viMessages.bankFeeds.unmapOf.replace('{name}', 'TK Hết Hạn')}"]`)!;
    expect(revUnmapBtn.disabled).toBe(false);
    expect(revUnmapBtn.className).toContain('min-h-11');
    expect(expUnmapBtn.disabled).toBe(false);
    expect(expUnmapBtn.className).toContain('min-h-11');

    // Unmap the revoked mapping: mutation fires, both accounts and connections refresh, and the revoked connection leaves the list.
    await act(async () => {
      clickNode(revUnmapBtn);
      await flushAsync();
    });
    await waitUntil(() => !container.textContent.includes('Kết nối đã ngắt'), 'revoked connection removed after last unmap');
    expect(testState.unmapCalls[0]).toMatchObject({ feedAccountId: 'm-rev' });

    // Unmap the expired mapping: mutation fires and mapping text clears while the expired connection stays until replaced/disconnected.
    await act(async () => {
      clickNode(expUnmapBtn);
      await flushAsync();
    });
    await waitUntil(() => container.querySelector(`button[aria-label="${viMessages.bankFeeds.unmapOf.replace('{name}', 'TK Hết Hạn')}"]`) === null, 'expired mapping unmapped');
    expect(testState.unmapCalls[1]).toMatchObject({ feedAccountId: 'm-exp' });
    expect(container.textContent).toContain('Kết nối hết hạn');
  });
});
