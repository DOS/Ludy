// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox's own status control (#3582) and the retention card that moved to Settings, rendered on the server from a seeded cache: the switch says
// whether the member takes new conversations, one line says what changes, a viewer has no control, and the words exist in both languages.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient }));

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

const { AvailabilityControl } = await import('../src/components/conversation-inbox-screen.tsx');
const { ConversationRetentionCard } = await import('../src/components/conversation-retention.tsx');

function render(node: 'availability' | 'retention', seed: (qc: typeof state.qc) => void, locale: 'en' | 'vi' = 'en'): string {
  state.qc.clear();
  seed(state.qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node === 'availability' ? <AvailabilityControl /> : <ConversationRetentionCard />}
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const asRole = (role: 'owner' | 'member' | 'viewer') => (qc: typeof state.qc) => qc.setQueryData(['org', 'get'], { role, members: [] });

describe('AvailabilityControl', () => {
  it('shows a switch that is on, its state and what it means, in both languages', () => {
    const seed = (qc: typeof state.qc) => {
      asRole('member')(qc);
      qc.setQueryData(['conversations', 'availability'], { me: { status: 'available' } });
    };
    const en = render('availability', seed);
    expect(en).toContain('data-testid="availability-switch"');
    expect(en).toMatch(/aria-checked="true"|data-checked/);
    expect(en).toContain('Taking new conversations');
    expect(en).toContain('You are told first when a new conversation arrives');
    const vi = render('availability', seed, 'vi');
    expect(vi).toContain('Đang nhận hội thoại mới');
    expect(vi).toContain('Bạn được báo trước khi có hội thoại mới');
  });

  it('shows the away state with what changes while away', () => {
    const html = render('availability', (qc) => {
      asRole('owner')(qc);
      qc.setQueryData(['conversations', 'availability'], { me: { status: 'away' } });
    });
    expect(html).toContain('Away');
    expect(html).toContain('New conversations are told to others first. You can still read and answer.');
    expect(html).not.toContain('Go away');
    expect(render('availability', (qc) => {
      asRole('owner')(qc);
      qc.setQueryData(['conversations', 'availability'], { me: { status: 'away' } });
    }, 'vi')).toContain('Tạm vắng');
  });

  it('shows nothing to a viewer, who answers nothing', () => {
    expect(render('availability', (qc) => {
      asRole('viewer')(qc);
      qc.setQueryData(['conversations', 'availability'], { me: { status: 'available' } });
    })).toBe('');
  });
});

describe('ConversationRetentionCard', () => {
  it('shows the org retention with its default marked, in Settings', () => {
    const html = render('retention', (qc) => qc.setQueryData(['conversations', 'retention'], { retentionMonths: 24, isDefault: true }));
    expect(html).toContain('data-testid="conversation-retention-select"');
    expect(html).toContain('How long conversations are kept');
    expect(html).toContain('(default)');
    expect(render('retention', (qc) => qc.setQueryData(['conversations', 'retention'], { retentionMonths: null, isDefault: false }), 'vi')).toContain('Giữ đến khi tôi xóa');
  });
});
