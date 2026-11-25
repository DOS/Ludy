// SPDX-License-Identifier: AGPL-3.0-only
// Moving saved replies and auto-draft from Channels to the Inbox settings drawer (#3673):
// Channels omits both controls and links straight to /o/$slug/social/inbox?settings=true;
// Inbox opens the settings Sheet when ?settings=true is set, preserves member write access for
// saved replies and admin-only toggling for auto-draft, and keeps >= 44px phone tap targets.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({
  qc: null as unknown as import('@tanstack/react-query').QueryClient,
  search: {} as Record<string, unknown>,
  aiEnabled: true,
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.qc = new QC({ defaultOptions: { queries: { retryOnMount: false, retry: false } } });
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return {
    orpc: node([]),
    client: {},
    queryClient: state.qc,
    errorMessage: (e: unknown) => String(e),
    isStepUpRequired: () => false,
    fetchConversationImage: () => Promise.reject(new Error('not called')),
  };
});

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({
    aiEnabled: state.aiEnabled,
    modules: ['kernel', 'social'],
    channels: { oauth: [], sandbox: false },
  }),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    useSearch: () => state.search,
    useNavigate: () => vi.fn(),
    Link: ({
      children,
      to,
      params,
      search,
      className,
      ...rest
    }: {
      children?: ReactNode;
      to: string;
      params?: Record<string, string>;
      search?: Record<string, unknown>;
      className?: string;
      [k: string]: unknown;
    }) => {
      const base = to.replace('$slug', params?.slug ?? '');
      const entries = search
        ? Object.entries(search)
            .filter(([, v]) => v !== undefined && v !== '')
            .map(([k, v]) => [k, String(v)] as [string, string])
        : [];
      const query = entries.length > 0 ? `?${new URLSearchParams(entries).toString()}` : '';
      return createElement('a', { href: `${base}${query}`, className, ...rest }, children);
    },
  };
});

vi.mock('@ludy/ui/components/sheet', async () => {
  const { createElement: h } = await import('react');
  return {
    Sheet: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? h('div', { 'data-slot': 'sheet' }, children) : null),
    SheetContent: ({ children, closeLabel, finalFocus: _finalFocus, ...rest }: { children?: ReactNode; closeLabel: string; finalFocus?: unknown; [k: string]: unknown }) =>
      h('section', { role: 'dialog', 'data-slot': 'sheet-content', 'data-close-label': closeLabel, ...rest }, children),
    SheetHeader: ({ children, className }: { children?: ReactNode; className?: string }) => h('header', { 'data-slot': 'sheet-header', className }, children),
    SheetTitle: ({ children, className }: { children?: ReactNode; className?: string }) => h('h2', { 'data-slot': 'sheet-title', className }, children),
    SheetDescription: ({ children, className }: { children?: ReactNode; className?: string }) => h('p', { 'data-slot': 'sheet-description', className }, children),
    SheetBody: ({ children, className }: { children?: ReactNode; className?: string }) => h('div', { 'data-slot': 'sheet-body', className }, children),
  };
});

vi.mock('../src/components/conversation-inbox-screen.tsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/components/conversation-inbox-screen.tsx')>();
  return {
    ...actual,
    InboxScreen: ({ covered }: { covered?: boolean }) => <div data-testid="inbox-screen-stub" data-covered={String(Boolean(covered))} />,
  };
});

const stub = (name: string) => () => <div data-stub={name} />;
vi.mock('../src/components/social-brand-voice.tsx', () => ({ VoiceEditor: stub('voice') }));
vi.mock('../src/components/social-watermark.tsx', () => ({ WatermarkCard: stub('watermark') }));
vi.mock('../src/components/social-report-branding.tsx', () => ({ ReportBrandingCard: stub('report-branding') }));
vi.mock('../src/components/social-publish-hold.tsx', () => ({ PublishHoldCard: stub('publish-hold') }));
vi.mock('../src/components/social-banned-words.tsx', () => ({ BannedWordsCard: stub('banned-words') }));
vi.mock('../src/components/social-review-checklist.tsx', () => ({ ReviewChecklistCard: stub('review-checklist') }));
vi.mock('../src/components/social-channel-access.tsx', () => ({
  ChannelAccessCard: stub('channel-access'),
  useChannelScope: () => ({ loading: false, limited: false, allows: () => true }),
}));
vi.mock('../src/components/social-chat-alert.tsx', () => ({ ChatAlertCard: stub('chat-alert') }));
vi.mock('../src/components/social-plan-review.tsx', () => ({ PlanReviewCard: stub('plan-review') }));
vi.mock('../src/components/social-calendar-feed.tsx', () => ({ CalendarFeedCard: stub('calendar-feed') }));
vi.mock('../src/components/social-share.tsx', () => ({ ShareCard: stub('share') }));
vi.mock('../src/components/social-channel-sets.tsx', () => ({ ChannelSetsCard: stub('channel-sets') }));

const { SocialChannelsPage } = await import('../src/routes/social-channels.tsx');
const { SocialInboxPage } = await import('../src/routes/social-inbox.tsx');
const { moveFocusToScreen } = await import('../src/lib/route-focus.ts');

function seed(role: 'owner' | 'admin' | 'member' | 'viewer' = 'owner') {
  state.qc.clear();
  state.qc.setQueryData(['org', 'get'], { role, members: [] });
  state.qc.setQueryData(['me', 'get'], { userId: 'u1', orgs: [{ slug: 'acme', role }] });
  state.qc.setQueryData(['channels', 'list'], []);
  state.qc.setQueryData(['conversations', 'availability'], { me: { status: 'available' } });
  state.qc.setQueryData(['conversations', 'savedReplies'], { replies: [] });
  state.qc.setQueryData(['conversations', 'autoDraft'], { autoDraft: true });
}

const render = (node: ReactNode, locale: 'vi' | 'en' = 'vi') =>
  renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );

describe('Channels to Inbox settings move (#3673)', () => {
  beforeEach(() => {
    state.search = {};
    state.aiEnabled = true;
    seed('owner');
  });

  it('removes saved replies and auto-draft from Channels and leaves a Vietnamese and English link to Inbox settings', () => {
    const viHtml = render(<SocialChannelsPage />, 'vi');
    expect(viHtml).not.toContain('data-testid="saved-replies"');
    expect(viHtml).not.toContain('data-testid="auto-draft"');
    expect(viHtml).not.toContain('data-testid="conversation-replies-card"');
    expect(viHtml).toContain('data-testid="channels-inbox-settings-card"');
    expect(viHtml).toContain('href="/o/acme/social/inbox?settings=true"');
    expect(viHtml).toContain('Mở cài đặt Hộp thư');
    expect(viHtml).toContain('max-md:min-h-11');

    const enHtml = render(<SocialChannelsPage />, 'en');
    expect(enHtml).toContain('Open Inbox settings');
    expect(enHtml).toContain('href="/o/acme/social/inbox?settings=true"');
  });

  it('renders the Inbox settings trigger closed by default and opens the Sheet when ?settings=true is set', () => {
    const closed = render(<SocialInboxPage />, 'vi');
    expect(closed).toContain('data-testid="inbox-settings-trigger"');
    expect(closed).toContain('Cài đặt Hộp thư');
    expect(closed).toContain('max-md:min-h-11');
    expect(closed).toContain('data-covered="false"');
    expect(closed).not.toContain('data-testid="inbox-settings-sheet"');

    state.search = { settings: true };
    const openVi = render(<SocialInboxPage />, 'vi');
    expect(openVi).toContain('data-covered="true"');
    expect(openVi).toContain('data-testid="inbox-settings-sheet"');
    expect(openVi).toContain('data-close-label="Đóng"');
    expect(openVi).toContain('data-testid="saved-replies"');
    expect(openVi).toContain('data-testid="saved-reply-add"');
    expect(openVi).toContain('data-testid="auto-draft"');
    expect(openVi).toContain('data-testid="auto-draft-toggle"');

    const openEn = render(<SocialInboxPage />, 'en');
    expect(openEn).toContain('Inbox settings');
    expect(openEn).toContain('data-close-label="Close"');
  });

  it('preserves member write access for saved replies and admin-only toggling for auto-draft', () => {
    state.search = { settings: true };
    seed('member');
    const memberHtml = render(<SocialInboxPage />, 'vi');
    expect(memberHtml).toContain('data-testid="saved-reply-add"');
    // Checkbox is disabled for members on AutoDraftSetting.
    expect(memberHtml).toMatch(/data-testid="auto-draft-toggle"[^>]*disabled=""|disabled=""[^>]*data-testid="auto-draft-toggle"/);

    seed('viewer');
    const viewerHtml = render(<SocialInboxPage />, 'vi');
    expect(viewerHtml).toContain('data-testid="saved-replies"');
    expect(viewerHtml).not.toContain('data-testid="saved-reply-add"');
    expect(viewerHtml).toMatch(/data-testid="auto-draft-toggle"[^>]*disabled=""|disabled=""[^>]*data-testid="auto-draft-toggle"/);
  });

  it('hides auto-draft and uses saved-replies-only copy on Channels and Inbox when AI is disabled', () => {
    state.aiEnabled = false;
    state.search = { settings: true };
    seed('owner');
    const channelsVi = render(<SocialChannelsPage />, 'vi');
    expect(channelsVi).toContain('Câu trả lời mẫu cho hội thoại khách hàng đã chuyển sang màn hình Hộp thư.');
    expect(channelsVi).not.toContain('tự soạn nháp');

    const channelsEn = render(<SocialChannelsPage />, 'en');
    expect(channelsEn).toContain('Saved replies for customer conversations have moved to the Inbox screen.');
    expect(channelsEn).not.toContain('auto-draft');

    const inboxVi = render(<SocialInboxPage />, 'vi');
    expect(inboxVi).toContain('data-testid="saved-replies"');
    expect(inboxVi).not.toContain('data-testid="auto-draft"');
    expect(inboxVi).toContain('Câu trả lời mẫu cho hội thoại khách hàng.');
    expect(inboxVi).not.toContain('tự soạn nháp');

    const inboxEn = render(<SocialInboxPage />, 'en');
    expect(inboxEn).toContain('Saved replies for customer conversations.');
    expect(inboxEn).not.toContain('auto-draft');
  });

  it('does not steal focus onto <main> or <h1> when navigating directly into an open modal Sheet (#3673)', () => {
    const focusHeading = vi.fn();
    const heading = { hasAttribute: () => true, tabIndex: -1, focus: focusHeading };
    const focusMain = vi.fn();
    const mainWithOpenModal = {
      contains: () => false,
      querySelector: () => heading,
      focus: focusMain,
      ownerDocument: {
        activeElement: null,
        body: {},
        querySelector: (sel: string) => (sel.includes('[role="dialog"]') ? {} : null),
      },
    } as unknown as HTMLElement;
    moveFocusToScreen(mainWithOpenModal);
    expect(focusHeading).not.toHaveBeenCalled();
    expect(focusMain).not.toHaveBeenCalled();

    const mainWithoutModal = {
      contains: () => false,
      querySelector: () => heading,
      focus: focusMain,
      ownerDocument: {
        activeElement: null,
        body: {},
        querySelector: () => null,
      },
    } as unknown as HTMLElement;
    moveFocusToScreen(mainWithoutModal);
    expect(focusHeading).toHaveBeenCalledTimes(1);
  });
});
