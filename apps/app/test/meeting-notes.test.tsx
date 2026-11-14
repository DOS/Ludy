// SPDX-License-Identifier: AGPL-3.0-only
// "Ghi chú của tôi" and "Viết lại đầy đủ" on the meeting page (Meetings A5, #3163): the recorder's box saves with no AI; the button that asks Vy appears only when this system lets Vy
// summarize and there are saved notes; the expansion is read with the recorder's own lines and Vy's told apart, each of Vy's with the time of its transcript line.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { NotesPreview } from '@crove/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
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

const { MeetingNotes, NotesPreviewPanel } = await import('../src/components/meeting-notes.tsx');

function wrap(node: React.ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale="en" messages={catalog('en')}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
}
const box = (body: string, enabled: boolean) => {
  client.current.setQueryData(['meetings', 'results', 'notesGet'], { meetingId: 'm1', body, updatedAt: body ? '2026-11-14T10:00:00.000Z' : null });
  client.current.setQueryData(['meetings', 'results', 'summaryStatus'], { meetingId: 'm1', enabled, reason: enabled ? null : 'off' });
  return wrap(<MeetingNotes meetingId="m1" />);
};
const buttons = (html: string) => [...html.matchAll(/<button([^>]*)>((?:(?!<\/button>).)*)<\/button>/g)].map((m) => ({ attrs: m[1] ?? '', text: (m[2] ?? '').replace(/<[^>]*>/g, '') }));

describe('MeetingNotes', () => {
  it('shows the recorder their saved notes and a private note, and saves with no AI at all', () => {
    const html = box('báo giá khách A\nNam gửi trước thứ sáu', false);
    expect(html).toContain('data-testid="meeting-notes"');
    expect(html).toContain('báo giá khách A');
    expect(html).toContain(en.meetings.notes.private);
    const save = buttons(html).find((b) => b.text === en.meetings.notes.save);
    expect(save).toBeDefined();
    // Nothing typed since the last save: nothing to save yet.
    expect(save?.attrs).toMatch(/\sdisabled(=|\s|>|$)/);
    // AI off: the box works and no "write it out" button is offered.
    expect(html).not.toContain(en.meetings.notes.enhance);
  });

  it('offers "Write it out in full" only when Vy may summarize here, and only with saved notes', () => {
    const on = box('một dòng', true);
    const ask = buttons(on).find((b) => b.text === en.meetings.notes.enhance);
    expect(ask).toBeDefined();
    expect(ask?.attrs).not.toMatch(/\sdisabled(=|\s|>|$)/);
    expect(on).toContain(en.meetings.notes.enhanceHint);
    const empty = box('', true);
    expect(buttons(empty).find((b) => b.text === en.meetings.notes.enhance)?.attrs).toMatch(/\sdisabled(=|\s|>|$)/);
  });
});

describe('the expansion', () => {
  const preview = (over: Partial<NotesPreview> = {}): NotesPreview => ({
    meetingId: 'm1',
    runId: 'r1',
    template: 'briefing',
    dropped: 2,
    enhanced: {
      sections: [
        { key: 'progress', lines: [{ own: true, text: 'báo giá khách A', seconds: null }, { own: false, text: 'Khách A hẹn gặp lúc 9 giờ.', seconds: 125 }] },
        { key: 'plan', lines: [{ own: true, text: 'Nam gửi trước thứ sáu', seconds: null }] },
      ],
    },
    ...over,
  });
  const render = (p: NotesPreview) => {
    client.current.setQueryData(['meetings', 'results', 'enhancePreview'], p);
    return wrap(<NotesPreviewPanel meetingId="m1" runId="r1" onCopied={() => undefined} />);
  };

  it('tells the recorder\'s own lines from the lines Vy added, and gives each added line the time of its transcript line', () => {
    const html = render(preview());
    const own = [...html.matchAll(/<li[^>]*data-own="true"[^>]*>(.*?)<\/li>/g)].map((m) => (m[1] ?? '').replace(/<[^>]*>/g, ''));
    const added = [...html.matchAll(/<li[^>]*data-own="false"[^>]*>(.*?)<\/li>/g)].map((m) => (m[1] ?? '').replace(/<[^>]*>/g, ''));
    expect(own).toEqual(['báo giá khách A', 'Nam gửi trước thứ sáu']);
    expect(added).toHaveLength(1);
    expect(added[0]).toContain(en.meetings.notes.added);
    expect(added[0]).toContain('Khách A hẹn gặp lúc 9 giờ.');
    // 125 seconds is 2:05 in the transcript.
    expect(added[0]).toContain('2:05');
    // Only the lines Vy added carry the badge.
    expect(own.join(' ')).not.toContain(en.meetings.notes.added);
  });

  it('groups the lines under the template\'s section names, says how many of Vy\'s lines were dropped, and asks for the recorder\'s click to copy', () => {
    const html = render(preview());
    expect(html).toContain(en.meetings.templates.sections.briefing.progress);
    expect(html).toContain(en.meetings.templates.sections.briefing.plan);
    expect(html).toContain('2 of Vy');
    expect(html).toContain(en.meetings.results.vy.copy);
    expect(html).toContain(en.meetings.notes.copyReplaces);
  });

  it('shows the general summary\'s one block with no heading, and no dropped note when nothing was dropped', () => {
    const html = render(preview({ template: 'general', dropped: 0, enhanced: { sections: [{ key: null, lines: [{ own: true, text: 'một dòng', seconds: null }, { own: false, text: 'Thêm một dòng.', seconds: 5 }] }] } }));
    expect(html).not.toContain('<h4');
    expect(html).not.toContain('were dropped');
    expect(html.match(/data-own=/g)).toHaveLength(2);
  });
});
