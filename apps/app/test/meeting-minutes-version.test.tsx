// SPDX-License-Identifier: AGPL-3.0-only
// The second-language version of the published minutes on the meeting page (#4777): the segments the review works on are the ones the translation run works on, in the order the server reads
// them; the review starts from Vy's checked text with a refused segment empty; only segments with text are sent, in the original's order; readers get a switch only when a version is
// published, with the original first; and the recorder sees the review only when they have a translation of the shared minutes to review or a version to take down.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
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

const { MinutesVersionPublisher, MinutesVersionSwitch, draftFrom, publishable, segmentsOf } = await import('../src/components/meeting-minutes-version.tsx');

const ITEM = '11111111-1111-4111-8111-111111111111';
const original = {
  summary: 'Chốt báo giá 1.250.000 cho khách A.',
  decisions: ['Giữ giá cũ', '  '],
  items: [
    { id: ITEM, title: 'Gửi báo giá' },
    { id: '22222222-2222-4222-8222-222222222222', title: '' },
  ],
};

describe('segmentsOf', () => {
  it("lists the summary, each decision and each item title that has text, in the server's order and keys", () => {
    expect(segmentsOf(original).map((s) => s.key)).toEqual(['summary', 'decision:0', `item:${ITEM}`]);
    expect(segmentsOf({ summary: ' ', decisions: [], items: [] })).toEqual([]);
  });
});

describe('draftFrom and publishable', () => {
  const translated = [
    { key: 'summary', text: 'Quote of 1,250,000 agreed for customer A.', state: 'warn' as const, codes: ['NAME_ADDED' as const] },
    { key: 'decision:0', text: '', state: 'refused' as const, codes: ['UNCHANGED' as const] },
  ];

  it('starts from the checked text and leaves a refused or missing segment empty', () => {
    expect(draftFrom(original, translated)).toEqual({ summary: 'Quote of 1,250,000 agreed for customer A.', 'decision:0': '', [`item:${ITEM}`]: '' });
  });

  it("sends only segments with text, trimmed, in the original's order", () => {
    const draft = { summary: ' Quote agreed. ', 'decision:0': '', [`item:${ITEM}`]: 'Send the quote', stray: 'not a segment' };
    expect(publishable(original, draft)).toEqual([
      { key: 'summary', text: 'Quote agreed.' },
      { key: `item:${ITEM}`, text: 'Send the quote' },
    ]);
    expect(publishable(original, {})).toEqual([]);
  });
});

function renderSwitch(versions: unknown[] | null, locale: 'en' | 'vi' = 'en') {
  client.current.clear();
  if (versions !== null) client.current.setQueryData(['meetings', 'minutesVersion', 'get'], { meetingId: 'm1', from: 'vi', versions });
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MinutesVersionSwitch meetingId="m1" original={original}>
          <p>ORIGINAL TEXT</p>
        </MinutesVersionSwitch>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('the reader\'s switch', () => {
  it('shows only the original when no version is published', () => {
    expect(renderSwitch(null)).toBe('<p>ORIGINAL TEXT</p>');
    expect(renderSwitch([])).toBe('<p>ORIGINAL TEXT</p>');
  });

  it('shows the original first, with a switch to each published language', () => {
    const html = renderSwitch([{ language: 'en', publishedAt: '2026-11-25T03:00:00.000Z', segments: [{ key: 'summary', text: 'Quote agreed.' }] }]);
    expect(html).toContain('ORIGINAL TEXT');
    expect(html).not.toContain('Quote agreed.');
    expect(html).toContain('Original');
    expect(html).toContain('English');
    expect(html).toContain('aria-pressed="true"');
    expect(renderSwitch([{ language: 'en', publishedAt: '2026-11-25T03:00:00.000Z', segments: [{ key: 'summary', text: 'Quote agreed.' }] }], 'vi')).toContain('Bản gốc');
  });
});

describe('the recorder\'s review', () => {
  const render = (mine: unknown, versions: unknown) => {
    client.current.clear();
    if (mine !== null) client.current.setQueryData(['meetings', 'translation', 'get'], mine);
    if (versions !== null) client.current.setQueryData(['meetings', 'minutesVersion', 'get'], versions);
    return renderToStaticMarkup(
      <QueryClientProvider client={client.current}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <MinutesVersionPublisher meetingId="m1" original={original} />
        </IntlProvider>
      </QueryClientProvider>,
    );
  };
  const translation = (stale: boolean) => ({ meetingId: 'm1', translations: [{ stage: 'published', from: 'vi', to: 'en', stale, createdAt: '2026-11-25', segments: [{ key: 'summary', text: 'Quote agreed.', state: 'ok', codes: [] }] }] });

  it('shows nothing with no translation of the shared minutes to review and no version to take down', () => {
    expect(render(null, null)).toBe('');
    expect(render({ meetingId: 'm1', translations: [] }, { meetingId: 'm1', from: 'vi', versions: [] })).toBe('');
    // A translation of the text as it was before a change is not offered for review.
    expect(render(translation(true), { meetingId: 'm1', from: 'vi', versions: [] })).toBe('');
  });

  it('offers the review of a current translation, and a published version can be taken down', () => {
    const html = render(translation(false), { meetingId: 'm1', from: 'vi', versions: [] });
    expect(html).toContain('Review and publish the translation');
    const published = render(translation(false), { meetingId: 'm1', from: 'vi', versions: [{ language: 'en', publishedAt: '2026-11-25T03:00:00.000Z', segments: [{ key: 'summary', text: 'Quote agreed.' }] }] });
    expect(published).toContain('Publish the translation again');
    expect(published).toContain('Take down translation');
  });
});
