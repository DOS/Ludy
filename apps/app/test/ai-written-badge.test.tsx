// SPDX-License-Identifier: AGPL-3.0-only
// The mark on what a connected AI app wrote (#4149): shown for a row an app made and for a row whose text an app changed, hidden for a person's own row, in Vietnamese and English, and Vietnamese never calls
// the AI coworker "trợ lý" (owner decision 2026-11-10: Vy is a trợ lý, each app's coworker is not).
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { AiWrittenBadge } from '../src/components/ai-written-badge.tsx';
import { en } from '../src/i18n/messages/en.ts';
import { vi } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const render = (props: Parameters<typeof AiWrittenBadge>[0], locale: 'en' | 'vi' = 'vi') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <AiWrittenBadge {...props} />
    </IntlProvider>,
  );

describe('the AI-written mark', () => {
  it('says "Do đồng nghiệp AI viết" on a row an app made, and that an app changed the text of a row a person made', () => {
    expect(render({ actorOrigin: 'mcp', tainted: true })).toContain('Do đồng nghiệp AI viết');
    expect(render({ actorOrigin: 'ui', tainted: true })).toContain('Đồng nghiệp AI đã sửa nội dung');
    expect(render({ actorOrigin: 'mcp', tainted: true }, 'en')).toContain('Written by an AI coworker');
    expect(render({ actorOrigin: 'ui', tainted: true }, 'en')).toContain('Text changed by an AI coworker');
    // A timeline row has no taint: the origin alone is enough.
    expect(render({ actorOrigin: 'mcp' })).toContain('data-testid="ai-written-badge"');
  });

  it('shows nothing on a person\'s own row', () => {
    expect(render({ actorOrigin: 'ui' })).toBe('');
    expect(render({ actorOrigin: 'ui', tainted: false }, 'en')).toBe('');
  });

  it('has a Vietnamese and an English text for every key and never calls the coworker a "trợ lý"', () => {
    expect(Object.keys(vi.aiWritten).sort()).toEqual(Object.keys(en.aiWritten).sort());
    for (const text of Object.values(vi.aiWritten)) expect(text).not.toMatch(/trợ lý/i);
    for (const text of Object.values(en.aiWritten)) expect(text).not.toMatch(/assistant/i);
  });
});
