// SPDX-License-Identifier: AGPL-3.0-only
// "Load older conversations" under the Inbox list (#2339), rendered on the server: it shows only while the server says there are more, says it
// is working while the next page loads, and its words exist in both languages.
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ client: {}, orpc: {}, queryClient: {}, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false, fetchConversationImage: () => Promise.reject(new Error('not called')) }));

const { LoadOlderConversations } = await import('../src/components/conversation-inbox.tsx');

const render = (props: { hasMore: boolean; loading: boolean; failed?: boolean }, locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <LoadOlderConversations {...props} onLoad={() => undefined} />
    </IntlProvider>,
  );

describe('LoadOlderConversations', () => {
  it('shows nothing when there are no older conversations', () => {
    expect(render({ hasMore: false, loading: false })).toBe('');
  });

  it('shows the button while there are more, in both languages', () => {
    const html = render({ hasMore: true, loading: false });
    expect(html).toContain('data-testid="conversation-more"');
    expect(html).toContain('Load older conversations');
    expect(html).not.toContain('disabled=""');
    expect(render({ hasMore: true, loading: false }, 'vi')).toContain('Tải thêm hội thoại cũ hơn');
  });

  it('is busy, and not clickable, while the next page loads', () => {
    const html = render({ hasMore: true, loading: true });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
  });

  it('says so when the page could not be loaded', () => {
    expect(render({ hasMore: true, loading: false, failed: true })).toContain('Could not load older conversations');
  });
});
