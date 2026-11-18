// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox's empty, error and loading states and its tap targets (#3638, Engage audit IN-7, IN-8), rendered on the server: an Inbox with no channel says so and offers to connect one
// (and the address to forward email to), an error can be tried again and the retry reads again, the thread and the panel load as shapes, and the controls are 44 px on a phone.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import { TOUCH_BUTTON, TOUCH_MIN_PX, TOUCH_SELECT } from '../src/lib/conversation-touch.ts';

const state = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'shop' }),
    Link: ({ children, to, params, className, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string>; className?: string }) =>
      createElement('a', { href: to.replace(/\$(\w+)/g, (_m, name: string) => params?.[name] ?? ''), className, ...rest }, children),
  };
});
vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.qc = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: state.qc, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false, fetchConversationImage: () => Promise.reject(new Error('not called')) };
});

const { NoChannelsEmpty } = await import('../src/components/conversation-inbox-screen.tsx');
const { PaneError, ThreadSkeleton, PanelSkeleton } = await import('../src/components/conversation-states.tsx');

type Locale = 'en' | 'vi';
const render = (node: ReactNode, locale: Locale = 'vi') =>
  renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );

describe('an Inbox with no channel (IN-7)', () => {
  it('says nothing is connected, offers the one action, and gives the address to forward email to', () => {
    const html = render(<NoChannelsEmpty slug="shop" address="hop-thu-abc@mail.example.com" />);
    expect(html).toContain('Chưa kết nối kênh nào');
    expect(html).not.toContain('Không có hội thoại mới');
    expect(html).toContain('href="/o/shop/social/channels"');
    expect(html).toContain('>Kết nối kênh<');
    expect(html).toContain('hoặc chuyển tiếp email tới địa chỉ này:');
    expect(html).toContain('hop-thu-abc@mail.example.com');
    const en = render(<NoChannelsEmpty slug="shop" address="hop-thu-abc@mail.example.com" />, 'en');
    expect(en).toContain('No channel connected yet');
    expect(en).toContain('>Connect a channel<');
    expect(en).toContain('or forward an email to this address:');
  });

  it('leaves the forwarding line out where the server has no mail address, and is a tap target on a phone', () => {
    const html = render(<NoChannelsEmpty slug="shop" address={null} />);
    expect(html).not.toContain('inbox-forward-address');
    expect(html).toContain('data-testid="inbox-connect-channel"');
    expect(html).toContain('max-sm:min-h-11');
  });
});

describe('a failed read (IN-7)', () => {
  it('shows what went wrong and a button that tries again, in both languages', () => {
    const html = render(<PaneError message="Mất kết nối" onRetry={() => undefined} testId="thread-error" />);
    expect(html).toContain('data-testid="thread-error"');
    expect(html).toContain('Mất kết nối');
    expect(html).toContain('data-testid="pane-retry"');
    expect(html).toContain('>Thử lại<');
    expect(render(<PaneError message="Offline" onRetry={() => undefined} />, 'en')).toContain('>Try again<');
  });
});

describe('loading as shapes (IN-7)', () => {
  it('draws the thread and the panel as skeletons that announce they are busy, never a bare spinner', () => {
    for (const html of [render(<ThreadSkeleton />), render(<PanelSkeleton />)]) {
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('data-slot="skeleton"');
      expect(html).not.toContain('role="status"');
    }
    expect(render(<ThreadSkeleton />)).toContain('data-testid="thread-skeleton"');
    expect(render(<PanelSkeleton />)).toContain('data-testid="panel-skeleton"');
  });
});

describe('tap targets (IN-8)', () => {
  it('are 44 px on a phone or a touch pointer, for buttons and for the select inside its wrapper', () => {
    expect(TOUCH_MIN_PX).toBe(44);
    expect(TOUCH_BUTTON).toBe('max-sm:min-h-11 pointer-coarse:min-h-11');
    expect(TOUCH_SELECT).toContain('[&_select]:min-h-11');
    // min-h-11 is 2.75rem: 44 px at the root size the app uses.
    expect(11 * 4).toBe(TOUCH_MIN_PX);
  });
});
