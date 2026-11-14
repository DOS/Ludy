// SPDX-License-Identifier: AGPL-3.0-only
// The in-app recorder screen before anything is recorded (AI Meeting Notes M7, #2581): recording cannot start without the
// consent confirmation, the video box is off by default, and the screen says it works with AI off (Vy does nothing here). Rendered on the server.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { catalog } from '../src/i18n/runtime.ts';
import { RECORDING_NOTICE } from '@crove/meeting-recorder';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: String, uploadMeetingMedia: vi.fn(), sendLiveChunk: vi.fn() };
});
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme' }),
    useSearch: () => ({}),
    useNavigate: () => vi.fn(),
    Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement('a', { href: to }, children),
  };
});
vi.mock('../src/components/notes-subnav.tsx', () => ({ NotesSubnav: () => null }));

const { MeetingRecordPage } = await import('../src/routes/meeting-record.tsx');

const render = () =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale="en" messages={catalog('en')}>
        <MeetingRecordPage />
      </IntlProvider>
    </QueryClientProvider>,
  );

describe('MeetingRecordPage before recording', () => {
  const html = render();

  it('has a start button that is disabled until the notice is confirmed', () => {
    const button = /<button[^>]*>[^<]*Start recording<\/button>/.exec(html)?.[0] ?? '';
    expect(button).toContain('disabled');
  });

  it('shows the consent notice, the way participants were told and the confirmation box', () => {
    expect(html).toContain(en.meetings.form.consentConfirmCheckbox);
    expect(html).toContain(en.meetings.form.consentMethod);
    expect(html).toContain(en.meetings.form.consentNotice);
  });

  it('offers "record video too", unticked by default', () => {
    expect(html).toContain(en.meetings.record.withVideo);
    expect(/id="record-video"[^>]*aria-checked="true"/.test(html)).toBe(false);
  });

  it('offers "Ghi chú trực tiếp" with its hint, unticked by default', () => {
    expect(html).toContain(en.meetings.record.liveNotes);
    expect(html).toContain(en.meetings.record.liveNotesHint);
    expect(/id="record-live-notes"[^>]*aria-checked="true"/.test(html)).toBe(false);
  });

  it('shows the recording notice kit: the text, a copy button, the other language, the draft marker, and the new method (A1, #3159)', () => {
    expect(html).toContain(RECORDING_NOTICE.text.vi);
    expect(html).toContain(en.meetings.form.noticeCopy);
    expect(html).toContain(en.meetings.form.noticeShowEn);
    expect(html).toContain('#2585');
    expect(html).toContain(en.meetings.form.inCallChat);
  });

  it('says nothing here uses AI', () => {
    expect(html).toContain('recording works with AI off');
  });
});
