// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Personal data conversations section (#3635 pointer + #3669 lookup/erase list): rendered on the server in
// both Vietnamese and English across direct matches, linked contacts, commenter-only identities, truncation, and errors.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationPersonalDataResult } from '@ludy/kernel-contract';
import { PersonalDataConversations } from '../src/components/personal-data-conversations.tsx';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient, modules: ['social'] as string[] }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.qc = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: state.qc, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false };
});
vi.mock('../src/lib/auth.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), getConfig: () => ({ modules: state.modules }) }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, className }: { to: string; params: { slug: string }; children: React.ReactNode; className?: string }) => (
    <a href={to.replace('$slug', params.slug)} className={className}>
      {children}
    </a>
  ),
}));

const { PersonalDataPage } = await import('../src/routes/personal-data.tsx');

function renderPage(locale: 'vi' | 'en', modules: string[], role: 'owner' | 'admin' = 'owner'): string {
  state.modules = modules;
  state.qc.clear();
  state.qc.setQueryData(['org', 'get'], { role, slug: 'tiem-banh', members: [] });
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <PersonalDataPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function renderSection(
  locale: 'vi' | 'en',
  props: { data: ConversationPersonalDataResult | undefined; isFetching?: boolean; error?: unknown },
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <PersonalDataConversations data={props.data} isFetching={props.isFetching ?? false} error={props.error ?? null} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const sampleResult: ConversationPersonalDataResult = {
  kind: 'digits',
  truncated: true,
  items: [
    {
      identityId: '00000000-0000-7000-8000-000000000001',
      provider: 'whatsapp',
      channelName: 'WhatsApp Cửa Hàng',
      displayName: 'Chị Lan',
      idTail: '5678',
      address: null,
      matchSource: 'direct',
      linkedContactNames: [],
      threads: 2,
      messages: 5,
      notes: 1,
      inComments: false,
      eraseTarget: { conversationId: '00000000-0000-7000-8000-000000000010' },
    },
    {
      identityId: '00000000-0000-7000-8000-000000000002',
      provider: 'facebook_page',
      channelName: 'Trang Tiệm Bánh',
      displayName: null,
      idTail: '4321',
      address: null,
      matchSource: 'linked_contact',
      linkedContactNames: ['Công ty ABC'],
      threads: 0,
      messages: 3,
      notes: 0,
      inComments: false,
      eraseTarget: {
        conversationId: '00000000-0000-7000-8000-000000000020',
        messageId: '00000000-0000-7000-8000-000000000030',
      },
    },
    {
      identityId: '00000000-0000-7000-8000-000000000003',
      provider: 'email',
      channelName: 'Email',
      displayName: 'Anh Minh',
      idTail: 'test',
      address: 'minh@example.test',
      matchSource: 'linked_contact',
      linkedContactNames: ['Công ty ABC', 'Anh Minh'],
      threads: 1,
      messages: 2,
      notes: 1,
      inComments: true,
      eraseTarget: { conversationId: '00000000-0000-7000-8000-000000000040' },
    },
  ],
};

describe('the conversations pointer and lookup section on the personal-data page', () => {
  it('says where customer conversations are erased and links to the Inbox for both owners and admins', () => {
    for (const role of ['owner', 'admin'] as const) {
      const vi = renderPage('vi', ['social'], role);
      expect(vi).toContain('data-testid="personal-data-conversations"');
      expect(vi).toContain('Hội thoại với khách');
      expect(vi).toContain('href="/o/tiem-banh/social/inbox"');
      expect(vi).toContain('Mở Hộp thư');
    }
    const en = renderPage('en', ['social']);
    expect(en).toContain('Conversations with customers');
    expect(en).toContain('Open the Inbox');
  });

  it('is not shown where Engage is not installed', () => {
    expect(renderPage('vi', [])).not.toContain('personal-data-conversations');
  });

  it('renders matched direct, linked-contact, email, and commenter-only identities with mobile touch targets in Vietnamese and English', () => {
    const vi = renderSection('vi', { data: sampleResult });
    expect(vi).toContain('data-testid="personal-data-conversations-results"');
    expect(vi).toContain('3 khách · 3 hội thoại · 10 tin nhắn · 2 ghi chú nội bộ');
    expect(vi).toContain('Khớp quá 50 khách');
    expect(vi).toContain('Chị Lan');
    expect(vi).toContain('WhatsApp Cửa Hàng · WhatsApp');
    expect(vi).toContain('Trực tiếp');
    expect(vi).toContain('Qua liên hệ');
    expect(vi).toContain('Liên hệ: Công ty ABC');
    expect(vi).toContain('Bình luận trong hội thoại khác · 3 tin nhắn');
    expect(vi).toContain('minh@example.test');
    expect(vi).toContain('Có chuỗi bình luận');
    expect(vi).toContain('aria-label="Xóa hội thoại của Chị Lan trên WhatsApp Cửa Hàng · WhatsApp"');
    expect(vi).toContain('max-sm:min-h-11');
    expect(vi).not.toContain('>Xóa tất cả<');

    const en = renderSection('en', { data: sampleResult });
    expect(en).toContain('3 customers · 3 threads · 10 messages · 2 internal notes');
    expect(en).toContain('More than 50 identities match');
    expect(en).toContain('Direct');
    expect(en).toContain('Linked contact');
    expect(en).toContain('Contact: Công ty ABC');
    expect(en).toContain('Commented in other threads · 3 messages');
    expect(en).toContain('Includes comment threads');
    expect(en).toContain('aria-label="Erase conversations of Chị Lan on WhatsApp Cửa Hàng · WhatsApp"');
  });

  it('renders nothing for empty results and shows an error when the lookup fails', () => {
    expect(renderSection('vi', { data: { kind: 'email', items: [], truncated: false } })).toBe('');
    expect(renderSection('vi', { data: undefined, error: new Error('lookup failed') })).toContain('lookup failed');
  });
});
