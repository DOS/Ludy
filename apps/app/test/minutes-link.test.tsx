// SPDX-License-Identifier: AGPL-3.0-only
// The link to the published minutes for people outside the org (#4822): the recorder's panel on the meeting page (only the recorder, only with published minutes; switch off says why; "Tạo liên kết" and
// the address shown once with Copy; the list never holds a token; "Thu hồi" on live links only; the limit at ten live links) and the org switch card in the Meetings settings. Rendered on the server from
// the query cache, like the neighbours: this app's unit tests have no DOM, so a click is not simulated; the pure parts (the address, the copy) are tested in minutes-page.test.tsx.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { MINUTES_LINKS_MAX, zMinutesLinkItem, type MeetingResults as Results, type MinutesLinkItem, type MinutesLinkItems } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: String };
});
vi.mock('../src/lib/toast.ts', () => ({ toast: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, params, ...rest }: { children: ReactNode; to: string; params?: Record<string, string>; [k: string]: unknown }) => (
    <a href={to.replace(/\$(\w+)/g, (_m, k: string) => params?.[k] ?? '')} {...rest}>
      {children}
    </a>
  ),
}));

const { MinutesLinkPanel, MinutesLinkSwitchCard, MinutesLinkView } = await import('../src/components/minutes-link.tsx');
const { MeetingResults } = await import('../src/components/meeting-results.tsx');

const MEETING = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const TOKEN = 'Zq9-_'.repeat(8) + 'Zq9'; // 43 characters
const link = (n: number, over: Partial<MinutesLinkItem> = {}): MinutesLinkItem => ({
  id: `0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f40${String(n).padStart(2, '0')}`,
  state: 'live',
  createdAt: '2026-11-20T03:00:00.000Z',
  expiresAt: '2026-12-20T03:00:00.000Z',
  revokedAt: null,
  views: 0,
  firstViewedAt: null,
  ...over,
});

function wrap(node: ReactNode, locale: 'en' | 'vi' = 'vi') {
  return (
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        {node}
      </IntlProvider>
    </QueryClientProvider>
  );
}
function panel(list: MinutesLinkItems | null, role: 'owner' | 'admin' | 'member' = 'member', locale: 'en' | 'vi' = 'vi') {
  client.current.clear();
  if (list) client.current.setQueryData(['meetings', 'minutesLink', 'list'], list);
  client.current.setQueryData(['org', 'get'], { role });
  return renderToStaticMarkup(wrap(<MinutesLinkPanel meetingId={MEETING} slug="acme" />, locale));
}
const noop = () => undefined;
const baseView = { slug: 'acme', enabled: true, items: [], canEnable: false, made: null, copy: 'idle' as const, creating: false, revokingId: null, error: null, onCreate: noop, onRevoke: noop, onCopy: noop, onDismiss: noop };

describe('MinutesLinkPanel states', () => {
  it('draws nothing until the list is read', () => {
    expect(panel(null)).toBe('');
  });

  it('with the org switch off says why and has no create button; an owner or admin is pointed at the Meetings settings, a member at them', () => {
    const member = panel({ enabled: false, items: [] }, 'member');
    expect(member).toContain('data-testid="minutes-link-off"');
    expect(member).toContain(viMessages.meetings.minutesLink.offNote);
    expect(member).toContain(viMessages.meetings.minutesLink.offMember);
    expect(member).not.toContain('data-testid="minutes-link-create"');
    expect(member).not.toContain('href=');
    for (const role of ['owner', 'admin'] as const) {
      const admin = panel({ enabled: false, items: [] }, role);
      expect(admin.replace(/&quot;/g, '"')).toContain(viMessages.meetings.minutesLink.offAdmin);
      expect(admin).toContain('href="/o/acme/meetings"');
      expect(admin).toContain('Mở trang Cuộc họp');
      expect(admin).not.toContain('data-testid="minutes-link-create"');
      expect(admin).not.toContain(viMessages.meetings.minutesLink.offMember);
    }
  });

  it('with the switch on offers "Tạo liên kết" and says there are no links yet', () => {
    const html = panel({ enabled: true, items: [] });
    expect(html).toContain('data-testid="minutes-link-create"');
    expect(html).toContain('Tạo liên kết');
    expect(html).toContain('data-testid="minutes-link-empty"');
    expect(html).not.toContain('data-testid="minutes-link-made"');
    expect(html).not.toContain('data-testid="minutes-link-off"');
    expect(html).toContain(viMessages.meetings.minutesLink.hint);
  });

  it('lists each link with its state, dates, views and first view, offers "Thu hồi" on live links only, and shows no token or address', () => {
    const items = [
      link(1, { views: 3, firstViewedAt: '2026-11-21T04:00:00.000Z' }),
      link(2, { state: 'expired', expiresAt: '2026-11-01T03:00:00.000Z' }),
      link(3, { state: 'revoked', revokedAt: '2026-11-22T03:00:00.000Z' }),
    ];
    const html = panel({ enabled: true, items });
    expect(html.match(/data-testid="minutes-link-item"/g)).toHaveLength(3);
    expect(html).toContain('Còn hạn');
    expect(html).toContain('Hết hạn');
    expect(html).toContain('Đã thu hồi');
    expect(html).toContain('3 lượt mở');
    expect(html).toContain('Chưa ai mở');
    expect(html).toContain('Mở lần đầu');
    // One live link, one "Thu hồi" trigger, named for the link it ends.
    expect(html.match(/aria-label="Thu hồi liên kết tạo/g)).toHaveLength(1);
    expect(html).toContain('min-h-11');
    // Nothing that could be opened: no address, no route of the page, no token.
    expect(html).not.toContain('/-/minutes');
    expect(html).not.toContain('<input');
  });

  it('cannot hold a token in the list: the contract item is strict', () => {
    expect(zMinutesLinkItem.safeParse(link(1)).success).toBe(true);
    expect(zMinutesLinkItem.safeParse({ ...link(1), token: TOKEN }).success).toBe(false);
    expect(zMinutesLinkItem.safeParse({ ...link(1), path: `/-/minutes#${TOKEN}` }).success).toBe(false);
  });

  it('at the limit of live links says so and disables "Tạo liên kết"; an expired or revoked link does not count', () => {
    const live = Array.from({ length: MINUTES_LINKS_MAX }, (_, i) => link(i + 1));
    const full = panel({ enabled: true, items: live });
    expect(full).toContain('data-testid="minutes-link-limit"');
    expect(full).toContain('Cuộc họp này đã có 10 liên kết còn hạn');
    expect(/<button[^>]*data-testid="minutes-link-create"/.test(full) && /<button[^>]*disabled=""[^>]*data-testid="minutes-link-create"|<button[^>]*data-testid="minutes-link-create"[^>]*disabled=""/.test(full)).toBe(true);
    const roomy = panel({ enabled: true, items: [...live.slice(0, 9), link(11, { state: 'revoked', revokedAt: '2026-11-22T03:00:00.000Z' })] });
    expect(roomy).not.toContain('data-testid="minutes-link-limit"');
  });

  it('speaks English too', () => {
    const html = panel({ enabled: true, items: [link(1, { views: 1 })] }, 'member', 'en');
    expect(html).toContain('Share the minutes');
    expect(html).toContain('Make a link');
    expect(html).toContain('1 view');
    expect(html).toContain('Revoke');
  });
});

describe('MinutesLinkView with a new link', () => {
  const made = { url: `https://app.example.test/-/minutes#${TOKEN}`, expiresAt: '2026-12-20T03:00:00.000Z' };

  it('shows the full address once, the warning that it is shown only now, Copy and a live region for "Đã sao chép"', () => {
    const html = renderToStaticMarkup(wrap(<MinutesLinkView {...baseView} made={made} items={[link(1)]} />));
    expect(html).toContain('data-testid="minutes-link-made"');
    expect(html).toContain('value="https://app.example.test/-/minutes#' + TOKEN + '"');
    expect(html.split(TOKEN)).toHaveLength(2);
    expect(html).toContain(viMessages.meetings.minutesLink.madeWarn);
    expect(html).toContain('chỉ hiện một lần');
    expect(html).toContain('data-testid="minutes-link-copy"');
    expect(html).toMatch(/<label[^>]*for="minutes-link-url"/);
    expect(html).toMatch(/<p[^>]*role="status"[^>]*aria-live="polite"[^>]*data-testid="minutes-link-copy-status"[^>]*><\/p>/);
    expect(html).toContain('readOnly');
    // The list below does not repeat it: the token is in the field and nowhere else.
    const list = html.slice(html.indexOf('data-testid="minutes-link-list"'));
    expect(list).not.toContain(TOKEN);
  });

  it('says "Đã sao chép" when it worked and tells the person to copy by hand when it did not', () => {
    const copied = renderToStaticMarkup(wrap(<MinutesLinkView {...baseView} made={made} copy="copied" />));
    expect(copied).toMatch(/data-testid="minutes-link-copy-status"[^>]*>Đã sao chép</);
    const failed = renderToStaticMarkup(wrap(<MinutesLinkView {...baseView} made={made} copy="failed" />));
    expect(failed).toMatch(/data-testid="minutes-link-copy-status"[^>]*>Chưa sao chép được/);
    const idle = renderToStaticMarkup(wrap(<MinutesLinkView {...baseView} made={made} />));
    expect(idle).not.toContain('Đã sao chép');
  });

  it('is gone once dismissed: no address anywhere', () => {
    const html = renderToStaticMarkup(wrap(<MinutesLinkView {...baseView} made={null} items={[link(1)]} />));
    expect(html).not.toContain(TOKEN);
    expect(html).not.toContain('data-testid="minutes-link-made"');
    expect(html).not.toContain('data-testid="minutes-link-url"');
  });

  it('shows a refusal of the command in words', () => {
    const html = renderToStaticMarkup(wrap(<MinutesLinkView {...baseView} error={new Error('MINUTES_LINK_LIMIT')} />));
    expect(html).toContain('MINUTES_LINK_LIMIT');
  });
});

describe('the panel on the meeting page', () => {
  const publishedView = { id: 'r-pub', feature: 'manual' as const, stage: 'published' as const, summary: 'Đã chia sẻ', decisions: ['Giữ giá cũ'], tainted: false };
  const draftView = { ...publishedView, id: 'r-draft', stage: 'draft' as const };
  function results(r: Results): string {
    client.current.clear();
    client.current.setQueryData(['meetings', 'results', 'get'], r);
    client.current.setQueryData(['meetings', 'results', 'summaryStatus'], { meetingId: 'm1', enabled: false });
    client.current.setQueryData(['org', 'get'], { role: 'owner', members: [] });
    client.current.setQueryData(['meetings', 'minutesLink', 'list'], { enabled: true, items: [] });
    return renderToStaticMarkup(wrap(<MeetingResults meetingId="m1" slug="acme" readers={[]} />, 'en'));
  }

  it('shows to the recorder with published minutes, and to no one else, and not before anything is published', () => {
    expect(results({ meetingId: 'm1', isRecorder: true, draft: null, published: publishedView, items: [] })).toContain('data-testid="minutes-link"');
    expect(results({ meetingId: 'm1', isRecorder: false, draft: null, published: publishedView, items: [] })).not.toContain('data-testid="minutes-link"');
    expect(results({ meetingId: 'm1', isRecorder: true, draft: draftView, published: null, items: [] })).not.toContain('data-testid="minutes-link"');
    expect(results({ meetingId: 'm1', isRecorder: true, draft: null, published: null, items: [] })).not.toContain('data-testid="minutes-link"');
  });
});

describe('MinutesLinkSwitchCard', () => {
  function card(enabled: boolean | null, role: string, locale: 'en' | 'vi' = 'vi') {
    client.current.clear();
    if (enabled !== null) client.current.setQueryData(['meetings', 'minutesLink', 'switch', 'get'], { enabled });
    client.current.setQueryData(['org', 'get'], { role });
    return renderToStaticMarkup(wrap(<MinutesLinkSwitchCard />, locale));
  }

  it('is off by default in its words, and on once it is turned on', () => {
    expect(card(false, 'owner')).toContain('Đang tắt');
    expect(card(true, 'owner')).toContain('Đang bật');
    expect(card(false, 'owner', 'en')).toContain(en.meetings.minutesLinkSwitch.stateOff);
    // Nothing is drawn until the setting is read.
    expect(card(null, 'owner')).toBe('');
  });

  it('lets an owner or admin turn it on or off and tells a member only they can', () => {
    for (const role of ['owner', 'admin']) {
      expect(card(false, role)).toContain('data-testid="minutes-link-switch-toggle"');
      expect(card(false, role)).toContain('>Bật<');
      expect(card(true, role)).toContain('>Tắt<');
      expect(card(false, role)).not.toContain(viMessages.meetings.minutesLinkSwitch.adminOnly);
    }
    const member = card(false, 'member');
    expect(member).toContain(viMessages.meetings.minutesLinkSwitch.adminOnly);
    expect(member).not.toContain('minutes-link-switch-toggle');
  });

  it('explains plainly what is shared, for how long and that it can be revoked', () => {
    const html = card(false, 'owner');
    expect(html).toContain('Chia sẻ biên bản ra ngoài');
    expect(html).toContain('tóm tắt, các quyết định và việc cần làm');
    expect(html).toContain('tối đa 30 ngày');
    expect(html).toContain('thu hồi được bất cứ lúc nào');
    expect(en.meetings.minutesLinkSwitch.hint).toContain('at most {days, number} days');
  });
});
