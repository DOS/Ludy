// SPDX-License-Identifier: AGPL-3.0-only
// Component tests for CoworkerBox on the sales e-invoice form (#4119): stale-date guard while a suggest request is pending, filling lines when the date stays unchanged, and clearing status notes on edit,
// request start, and beside request errors.
import { QueryClientProvider } from '@tanstack/react-query';
import { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EInvoiceSuggestInput, EInvoiceSuggested } from '@ludy/kernel-contract';
import { FakeDomNode, createScopedDomHarness } from './fake-dom.ts';

const apiState = vi.hoisted(() => ({
  queryClient: null as unknown as import('@tanstack/react-query').QueryClient,
  suggestImpl: null as null | ((input: EInvoiceSuggestInput) => Promise<EInvoiceSuggested>),
  suggestCalls: [] as EInvoiceSuggestInput[],
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  const { ClientError } = await import('../src/lib/errors.ts');
  apiState.queryClient = new QC({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return (opts?: { input?: unknown }) => ({ queryKey: [...path, opts?.input], queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {
      einvoice: {
        drafts: {
          suggest: async (input: EInvoiceSuggestInput) => {
            apiState.suggestCalls.push(input);
            if (!apiState.suggestImpl) throw new Error('suggestImpl not set');
            return apiState.suggestImpl(input);
          },
        },
      },
    },
    queryClient: apiState.queryClient,
    errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    ClientError,
    getCurrentOrg: () => 'acme',
    isStepUpRequired: () => false,
    uploadAgreement: async () => 'f',
    takeOrgLeftNotice: () => null,
  };
});

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: unknown }) => <a>{children as never}</a>,
  useParams: () => ({ slug: 'acme' }),
}));

// Install a scoped DOM with `oninput` before loading react-dom/client so React 19 enables input/change event tracking on FakeDomNode.
const bootstrapDom = createScopedDomHarness();
bootstrapDom.installScopedDom();
(globalThis.document as unknown as Record<string, unknown>).oninput = null;
const { createRoot } = await import('react-dom/client');
await bootstrapDom.teardownScopedDom();

const { CoworkerBox } = await import('../src/routes/sales-invoices.tsx');
const { I18nProvider } = await import('../src/i18n/provider.tsx');
const { catalog, setActiveLocale } = await import('../src/i18n/runtime.ts');
const { COWORKERS } = await import('../src/i18n/brand.ts');

const USED_PROPOSAL: EInvoiceSuggested = {
  ai: 'used',
  lines: [
    { description: 'Bánh A', unit: 'hộp', quantity: '10', unitPrice: '120000', vatRate: '8%', vatFrom: 'text' },
  ],
  buyer: null,
};

const TWO_LINES_PROPOSAL: EInvoiceSuggested = {
  ai: 'used',
  lines: [
    { description: 'Bánh A', unit: 'hộp', quantity: '10', unitPrice: '120000', vatRate: '8%', vatFrom: 'text' },
    { description: 'Trà B', unit: 'hộp', quantity: '2', unitPrice: '1200000', vatRate: '8%', vatFrom: 'text' },
  ],
  buyer: null,
};

const REFUSED_PROPOSAL: EInvoiceSuggested = { ai: 'refused', lines: [], buyer: null };

const valueSetter = Object.getOwnPropertyDescriptor(FakeDomNode.prototype, 'value')!.set!;

function typeTextarea(node: FakeDomNode, nextValue: string): void {
  valueSetter.call(node, nextValue);
  node.dispatchEvent({ type: 'input', bubbles: true, cancelable: true });
}

function clickButton(node: FakeDomNode): void {
  node.dispatchEvent({ type: 'click', button: 0, bubbles: true, cancelable: true });
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 15));
}

describe('CoworkerBox (#4119)', () => {
  const domHarness = createScopedDomHarness();

  beforeEach(() => {
    setActiveLocale('vi');
    apiState.queryClient.clear();
    apiState.suggestImpl = null;
    apiState.suggestCalls = [];
  });

  afterEach(async () => {
    apiState.suggestImpl = null;
    await domHarness.teardownScopedDom();
  });

  function mountHost(initialDate = '2026-11-26', room = 20) {
    const body = domHarness.installScopedDom();
    const container = new FakeDomNode(1, 'div');
    body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    domHarness.setMountedRoot(root);

    let setHostDate!: (next: string) => void;
    const filled: EInvoiceSuggested[] = [];

    function Host() {
      const [date, setDate] = useState(initialDate);
      const [text, setText] = useState('');
      const [lines, setLines] = useState<EInvoiceSuggested['lines']>([]);
      setHostDate = setDate;
      return (
        <QueryClientProvider client={apiState.queryClient}>
          <I18nProvider>
            <CoworkerBox
              date={date}
              room={room}
              legalEntityId={undefined}
              invoiceSource={null}
              buyerPartyId={null}
              text={text}
              onText={setText}
              onProposal={(proposal) => {
                filled.push(proposal);
                setLines(proposal.lines.slice(0, room));
              }}
            />
            <div data-testid="test-filled-count">{String(lines.length)}</div>
          </I18nProvider>
        </QueryClientProvider>
      );
    }

    const mount = async () => {
      await act(async () => {
        root.render(<Host />);
      });
    };

    const textarea = () => container.querySelector('[data-testid="invoice-ai-text"]')!;
    const askButton = () => container.querySelector('[data-testid="invoice-ai-ask"]')!;
    const statusNode = () => container.querySelector('[data-testid="invoice-ai-state"]');
    const alertNode = () => container.querySelector('[role="alert"]');
    const filledCount = () => Number(container.querySelector('[data-testid="test-filled-count"]')?.textContent ?? '0');

    return {
      container,
      mount,
      setDate: (next: string) => setHostDate(next),
      filled,
      textarea,
      askButton,
      statusNode,
      alertNode,
      filledCount,
    };
  }

  it('fills nothing and displays the stale note when the invoice date changes while a request is pending', async () => {
    let resolveSuggest!: (value: EInvoiceSuggested) => void;
    apiState.suggestImpl = () =>
      new Promise<EInvoiceSuggested>((resolve) => {
        resolveSuggest = resolve;
      });

    const host = mountHost('2026-11-26');
    await host.mount();

    await act(async () => {
      typeTextarea(host.textarea(), 'bán 10 hộp bánh A giá 120k, thuế 8%');
    });
    expect(host.askButton().disabled).toBe(false);

    await act(async () => {
      clickButton(host.askButton());
    });
    expect(apiState.suggestCalls).toEqual([{ text: 'bán 10 hộp bánh A giá 120k, thuế 8%', date: '2026-11-26' }]);
    expect(host.textarea().disabled).toBe(true);
    expect(host.askButton().disabled).toBe(true);
    expect(host.statusNode()).toBeNull();

    // Change the invoice date while the request is still pending.
    await act(async () => {
      host.setDate('2026-11-27');
    });

    await act(async () => {
      resolveSuggest(USED_PROPOSAL);
      await flushAsync();
    });

    expect(host.filled).toEqual([]);
    expect(host.filledCount()).toBe(0);
    expect(host.textarea().disabled).toBe(false);
    expect(host.statusNode()?.getAttribute('data-state')).toBe('stale');
    expect(host.statusNode()?.textContent).toBe(catalog('vi').salesInvoices.ai.state.stale.replace('{finance}', COWORKERS.finance));
    // Live region remains mounted for accessible status announcements.
    expect(host.container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
  });

  it('fills suggested lines and shows the filled note when the invoice date stays unchanged', async () => {
    apiState.suggestImpl = async () => USED_PROPOSAL;

    const host = mountHost('2026-11-26');
    await host.mount();

    await act(async () => {
      typeTextarea(host.textarea(), 'bán 10 hộp bánh A giá 120k, thuế 8%');
    });
    await act(async () => {
      clickButton(host.askButton());
      await flushAsync();
    });

    expect(host.filled).toEqual([USED_PROPOSAL]);
    expect(host.filledCount()).toBe(1);
    expect(host.statusNode()?.getAttribute('data-state')).toBe('filled');
    expect(host.statusNode()?.textContent).toBe(catalog('vi').salesInvoices.ai.state.filled.replace('{finance}', COWORKERS.finance));
  });

  it('clears filled, partial, stale, and refused status notes on text edit, date edit, request start, and before request errors', async () => {
    let mode: 'filled' | 'partial' | 'refused' | 'deferred' | 'reject' = 'filled';
    let resolveDeferred!: (value: EInvoiceSuggested) => void;
    let rejectDeferred!: (error: Error) => void;

    apiState.suggestImpl = () => {
      if (mode === 'filled') return Promise.resolve(USED_PROPOSAL);
      if (mode === 'partial') return Promise.resolve(TWO_LINES_PROPOSAL);
      if (mode === 'refused') return Promise.resolve(REFUSED_PROPOSAL);
      if (mode === 'deferred') {
        return new Promise<EInvoiceSuggested>((resolve) => {
          resolveDeferred = resolve;
        });
      }
      return new Promise<EInvoiceSuggested>((_resolve, reject) => {
        rejectDeferred = reject;
      });
    };

    const host = mountHost('2026-11-26', 1);
    await host.mount();

    // 1. `filled` clears when the source text is edited.
    await act(async () => {
      typeTextarea(host.textarea(), 'bán 10 hộp bánh A giá 120k');
    });
    await act(async () => {
      clickButton(host.askButton());
      await flushAsync();
    });
    expect(host.statusNode()?.getAttribute('data-state')).toBe('filled');

    await act(async () => {
      typeTextarea(host.textarea(), 'bán 10 hộp bánh A giá 120k, thuế 8%');
    });
    expect(host.statusNode()).toBeNull();

    // 2. `partial` clears when the invoice date is edited.
    mode = 'partial';
    await act(async () => {
      clickButton(host.askButton());
      await flushAsync();
    });
    expect(host.statusNode()?.getAttribute('data-state')).toBe('partial');

    await act(async () => {
      host.setDate('2026-11-27');
    });
    expect(host.statusNode()).toBeNull();

    // 3. `stale` clears when the source text is edited.
    mode = 'deferred';
    await act(async () => {
      clickButton(host.askButton());
    });
    await act(async () => {
      host.setDate('2026-11-28');
    });
    await act(async () => {
      resolveDeferred(USED_PROPOSAL);
      await flushAsync();
    });
    expect(host.statusNode()?.getAttribute('data-state')).toBe('stale');

    await act(async () => {
      typeTextarea(host.textarea(), 'bán 5 hộp bánh A giá 120k');
    });
    expect(host.statusNode()).toBeNull();

    // 3b. `stale` clears when the invoice date is edited too.
    await act(async () => {
      clickButton(host.askButton());
    });
    await act(async () => {
      host.setDate('2026-11-29');
    });
    await act(async () => {
      resolveDeferred(USED_PROPOSAL);
      await flushAsync();
    });
    expect(host.statusNode()?.getAttribute('data-state')).toBe('stale');

    await act(async () => {
      host.setDate('2026-11-30');
    });
    expect(host.statusNode()).toBeNull();

    // 4. `refused` clears immediately when a new request starts and never lingers beside a request error.
    mode = 'refused';
    await act(async () => {
      clickButton(host.askButton());
      await flushAsync();
    });
    expect(host.statusNode()?.getAttribute('data-state')).toBe('refused');

    mode = 'reject';
    await act(async () => {
      clickButton(host.askButton());
    });
    // Cleared immediately while pending.
    expect(host.statusNode()).toBeNull();

    await act(async () => {
      rejectDeferred(new Error('Không kết nối được máy chủ'));
      await flushAsync();
    });
    expect(host.statusNode()).toBeNull();
    expect(host.alertNode()?.textContent).toContain('Không kết nối được máy chủ');

    // Editing the source text while idle clears the displayed error as well.
    await act(async () => {
      typeTextarea(host.textarea(), 'bán 6 hộp bánh A giá 120k');
    });
    expect(host.alertNode()).toBeNull();
  });
});
