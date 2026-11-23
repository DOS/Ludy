// SPDX-License-Identifier: AGPL-3.0-only
// The way back from a task to the Inbox thread it was made from (#3421): shown where the Engage module runs, to the Inbox with the thread selected, and carrying
// none of the thread's words.
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';
import { conversationOf } from '../src/lib/agents.ts';

const authState = vi.hoisted(() => ({ modules: ['kernel', 'social'] as string[] }));
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: authState.modules }) }));
vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    Link: ({ children, to, params, search, className }: { children?: ReactNode; to: string; params?: Record<string, string>; search?: Record<string, string>; className?: string }) => {
      const path = Object.entries(params ?? {}).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to);
      const query = search ? `?${new URLSearchParams(search).toString()}` : '';
      return createElement('a', { href: path + query, className }, children);
    },
  };
});

const { TaskConversationLink } = await import('../src/components/task-conversation-link.tsx');

const ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const render = (locale: 'vi' | 'en', node: ReactNode) =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      {node}
    </IntlProvider>,
  );

describe('TaskConversationLink (#3421)', () => {
  it('links to the Inbox with the thread selected, in Vietnamese and English', () => {
    authState.modules = ['kernel', 'social'];
    const viHtml = render('vi', <TaskConversationLink conversationId={ID} slug="demo-org" />);
    expect(viHtml).toContain(`href="/o/demo-org/social/inbox?c=${ID}"`);
    expect(viHtml).toContain('Mở hội thoại');
    const en = render('en', <TaskConversationLink conversationId={ID} slug="demo-org" />);
    expect(en).toContain('Open the conversation');
  });

  it('is a plain link, reachable by keyboard, and carries only the id', () => {
    authState.modules = ['kernel', 'social'];
    const html = render('en', <TaskConversationLink conversationId={ID} slug="demo-org" />);
    expect(html).toContain('<a ');
    expect(html).not.toContain('tabindex="-1"');
    expect(html.replace(ID, '')).not.toMatch(/title=|aria-hidden/);
  });

  it('is not shown with the Engage module off', () => {
    authState.modules = ['kernel', 'notes'];
    expect(render('en', <TaskConversationLink conversationId={ID} slug="demo-org" />)).toBe('');
  });

  it('is shown only for a task whose source is a conversation', () => {
    expect(conversationOf({ type: 'kernel.conversation', id: ID })).toBe(ID);
    for (const other of [null, undefined, {}, { type: 'social.post', id: ID }, { type: 'kernel.conversation', id: 'x' }]) expect(conversationOf(other)).toBeNull();
  });
});
