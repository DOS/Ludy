// SPDX-License-Identifier: AGPL-3.0-only
// The hint under the new-task title field names the open task that already has the title (#3606); when an AI coworker wrote that title its invisible characters are written out (#4421).
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', () => ({ errorMessage: String, orpc: {}, queryClient: { invalidateQueries: () => undefined } }));
vi.mock('@tanstack/react-router', async () => {
  const { createElement } = await import('react');
  return {
    Link: ({ children, to, params, ...rest }: { children?: ReactNode; to: string; params?: Record<string, string> }) =>
      createElement('a', { href: to.replace('$slug', params?.slug ?? '').replace('$id', params?.id ?? ''), ...rest }, children),
    useParams: () => ({ slug: 'acme' }),
  };
});

const { DuplicateTaskLink } = await import('../src/components/task-panel.tsx');

const render = (duplicate: Parameters<typeof DuplicateTaskLink>[0]['duplicate'], locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <DuplicateTaskLink slug="acme" duplicate={duplicate} />
    </IntlProvider>,
  );

describe('the duplicate hint of the new-task panel (#4421)', () => {
  it('links to the open task with its title, marking the invisible characters of one an AI coworker wrote and leaving a person\'s as typed', () => {
    const marked = render({ id: 't1', title: 'Gửi báo‮ giá​', status: 'todo', tainted: true });
    expect(marked).toContain('href="/o/acme/tasks/t1"');
    expect(marked).toContain('Gửi báo⟨U+202E⟩ giá⟨U+200B⟩');
    expect(marked).not.toContain('Gửi báo‮');
    expect(render({ id: 't2', title: 'Việc‮ riêng', status: 'todo', tainted: false })).toContain('Việc‮ riêng');
    expect(render({ id: 't3', title: 'Không có cờ‮', status: 'todo' })).toContain('Không có cờ‮');
    expect(render({ id: 't1', title: 'Gọi‮', status: 'todo', tainted: true }, 'vi')).toContain('Gọi⟨U+202E⟩');
  });
});
