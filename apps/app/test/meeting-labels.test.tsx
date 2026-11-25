// SPDX-License-Identifier: AGPL-3.0-only
// The labels on a meeting's page (#4955): the recorder sees the labels with a remove button, a box to add one and the note on what not to write; a reader sees the labels alone and nothing when there are none;
// a full meeting disables the box; nothing shows when the read failed. Rendered on the server from the query cache, with no network, in vi and en.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { MeetingLabels as Labels } from '@ludy/kernel-contract';
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

const { MeetingLabels } = await import('../src/components/meeting-labels.tsx');

const answer = (labels: string[]): Labels => ({ meetingId: 'm1', labels: labels.map((label, i) => ({ id: `0190b1c2-0000-7000-8000-00000000000${i}`, label })) });

const render = (data: Labels | null, isRecorder: boolean, locale: 'en' | 'vi' = 'en') => {
  if (data) client.current.setQueryData(['meetings', 'label', 'list'], data);
  else client.current.removeQueries({ queryKey: ['meetings', 'label', 'list'] });
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MeetingLabels meetingId="m1" isRecorder={isRecorder} />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

describe('MeetingLabels', () => {
  it('shows the recorder the labels, a remove button for each, the box to add one and the note on what not to write', () => {
    const html = render(answer(['Khách Hoa Sen', 'Họp tuần']), true);
    expect(html).toContain('data-testid="meeting-labels"');
    expect(html).toContain('Khách Hoa Sen');
    expect(html).toContain('Họp tuần');
    expect(html).toContain('aria-label="Remove the label Khách Hoa Sen"');
    expect(html).toContain('Add a label');
    expect(html).toContain('Do not put names of people, e-mail addresses or phone numbers');
    // The box is open (the Add button waits for some text).
    expect(html).not.toMatch(/<input[^>]*\sdisabled=""/);
  });

  it('shows a reader the labels alone, with no box and no button', () => {
    const html = render(answer(['Khách Hoa Sen']), false);
    expect(html).toContain('Khách Hoa Sen');
    expect(html).not.toContain('Add a label');
    expect(html).not.toContain('Remove the label');
    expect(html).not.toContain('<input');
  });

  it('shows a reader nothing when the meeting has no label, and the recorder the box with a note that there are none', () => {
    expect(render(answer([]), false)).toBe('');
    const html = render(answer([]), true);
    expect(html).toContain('No labels yet.');
    expect(html).toContain('Add a label');
  });

  it('disables the box of a meeting that has five labels and says why', () => {
    const html = render(answer(['A', 'B', 'C', 'D', 'E']), true);
    expect(html).toContain('This meeting has 5 labels');
    expect(html).toMatch(/<input[^>]*\sdisabled=""/);
  });

  it('shows nothing before an answer and when the read failed', () => {
    expect(render(null, true)).toBe('');
    expect(render(null, false)).toBe('');
  });

  it('is in Vietnamese too, with the label written as plain text', () => {
    const html = render(answer(['<b>Khách</b>']), true, 'vi');
    expect(html).toContain('Nhãn');
    expect(html).toContain('Thêm nhãn');
    expect(html).toContain('Đừng ghi tên người');
    expect(html).toContain('&lt;b&gt;Khách&lt;/b&gt;');
    expect(html).not.toContain('<b>Khách</b>');
  });
});
