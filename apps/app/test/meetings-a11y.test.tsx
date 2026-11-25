// SPDX-License-Identifier: AGPL-3.0-only
// The accessibility audit of the Meetings screens (#3805, docs/qa/meetings-a11y-2026-11.md): what the audit fixed is held here as markup, rendered on the server. The browser
// side (axe on the real routes, the keyboard paths) is e2e/tests/meetings-a11y.spec.ts; this file covers what a static render can see: the live regions, the headings, the
// names of repeated buttons and the touch size of the recorder's buttons.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingResults as Results, MinutesTemplateView } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));
// What the app-level recorder reports to the screen; each test sets the phase it needs.
const recorder = vi.hoisted(() => ({ phase: 'recording' as string }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({ mutationFn: () => Promise.resolve({}) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: client.current, errorMessage: String, uploadMeetingMedia: vi.fn(), sendLiveChunk: vi.fn() };
});
vi.mock('../src/lib/auth.ts', () => ({ getConfig: () => ({ modules: ['kernel', 'meetings'] }) }));
vi.mock('../src/lib/recording-controller.ts', () => ({
  getRecorderSnapshot: () => ({ phase: recorder.phase, error: null, busyId: null, withVideo: true, slug: 'acme', stream: null }),
  subscribeRecorder: () => () => undefined,
  recorderElapsedMs: () => 0,
  isOwnRecording: () => false,
  clearRecorderError: vi.fn(),
  startRecording: vi.fn(),
  pauseOrResume: vi.fn(),
  stop: vi.fn(),
  uploadRecording: vi.fn(),
}));
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

const { MeetingRecordPage } = await import('../src/routes/meeting-record.tsx');
const { MinutesTemplatesCard } = await import('../src/components/minutes-templates.tsx');
const { MeetingResults } = await import('../src/components/meeting-results.tsx');

type Locale = 'vi' | 'en';
const render = (node: ReactNode, locale: Locale = 'en') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );
const tag = (html: string, pattern: RegExp): string => pattern.exec(html)?.[0] ?? '';

describe('the recorder while it records', () => {
  beforeEach(() => {
    client.current.clear();
    recorder.phase = 'recording';
  });

  it('announces the state in a live region and keeps the clock out of it, so the clock is not read every half second', () => {
    const html = render(<MeetingRecordPage />);
    const status = tag(html, /<div[^>]*role="status"[^>]*>.*?<\/div>/s);
    expect(status).toContain('aria-live="polite"');
    expect(status).toContain(en.meetings.record.recording);
    expect(status).not.toMatch(/\d\d:\d\d/);
    // The clock is a timer (implicitly not live), with its own name.
    const timer = tag(html, /<span[^>]*role="timer"[^>]*>[^<]*<\/span>/);
    expect(timer).toContain(`aria-label="${en.meetings.record.timer}"`);
    expect(timer).toMatch(/>\d\d:\d\d</);
  });

  it('takes the focus from the form that was removed: the status can hold it, and Tab leads to Pause and Stop', () => {
    const html = render(<MeetingRecordPage />);
    expect(tag(html, /<div[^>]*role="status"[^>]*>/)).toContain('tabindex="-1"');
    expect(html.indexOf('role="status"')).toBeLessThan(html.indexOf(`>${en.meetings.record.pause}<`));
  });

  it('gives Pause and Stop a 44px hit area on a phone, and the camera picture a name', () => {
    const html = render(<MeetingRecordPage />);
    expect(tag(html, new RegExp(`<button[^>]*>${en.meetings.record.pause}</button>`))).toContain('max-sm:min-h-11');
    expect(tag(html, new RegExp(`<button[^>]*>${en.meetings.record.stop}</button>`))).toContain('max-sm:min-h-11');
    expect(tag(html, /<video[^>]*>/)).toContain(`aria-label="${en.meetings.record.videoPreview}"`);
  });
});

describe('the recorder before it records', () => {
  beforeEach(() => {
    client.current.clear();
    recorder.phase = 'idle';
  });

  it('links the disabled start button to the line that says what it waits for', () => {
    const html = render(<MeetingRecordPage />);
    expect(tag(html, /<button[^>]*>[^<]*Start recording<\/button>/)).toContain('aria-describedby="record-hint"');
    expect(html).toContain(`id="record-hint"`);
  });
});

const at = '2026-11-17T00:00:00.000Z';
const template = (id: string, name: string): MinutesTemplateView => ({ id, name, sections: [{ key: 's1', title: 'Kết quả', hint: '' }], archived: false, createdAt: at, updatedAt: at });

describe('the template settings card', () => {
  beforeEach(() => client.current.clear());

  it('is a named region with a real heading, and the Edit and Archive buttons of a row say which template they are on', () => {
    client.current.setQueryData(['meetings', 'template', 'list'], { templates: [template('t1', 'Giao ban'), template('t2', 'Họp khách hàng')] });
    const html = render(<MinutesTemplatesCard />);
    expect(tag(html, /<div[^>]*data-testid="minutes-templates-card"[^>]*>/)).toMatch(/role="region"[^>]*aria-labelledby="minutes-templates-title"|aria-labelledby="minutes-templates-title"[^>]*role="region"/);
    expect(html).toMatch(/<h2 id="minutes-templates-title"[^>]*>/);
    const rows = html.split('data-testid="minutes-template"').slice(1);
    expect(rows).toHaveLength(2);
    for (const [i, id] of ['t1', 't2'].entries()) {
      expect(rows[i]).toContain(`id="mt-name-text-${id}"`);
      expect(tag(rows[i] as string, /<button[^>]*>Edit<\/button>/)).toContain(`aria-describedby="mt-name-text-${id}"`);
      expect(tag(rows[i] as string, /<button[^>]*>Edit<\/button>/)).toContain('aria-expanded="false"');
      expect(tag(rows[i] as string, /<button[^>]*>Archive<\/button>/)).toContain(`aria-describedby="mt-name-text-${id}"`);
    }
  });

  it('has the toast words in both languages', () => {
    for (const key of ['saved', 'created', 'archivedDone'] as const) {
      expect(viMessages.minutesTemplates[key]).not.toBe('');
      expect(en.minutesTemplates[key]).not.toBe('');
    }
  });
});

const published = { id: 'r-pub', feature: 'manual' as const, stage: 'published' as const, summary: 'Chốt báo giá.', decisions: ['Giữ giá cũ'], tainted: false };
const draft = { ...published, id: 'r-draft', stage: 'draft' as const };
const results = (over: Partial<Results>): Results => ({ meetingId: 'm1', isRecorder: true, draft: null, published: null, items: [], transcriptUnread: 0, ...over });

describe('the results panel', () => {
  beforeEach(() => client.current.clear());
  const show = (data: Results, summaryEnabled: boolean) => {
    client.current.setQueryData(['meetings', 'results', 'get'], data);
    client.current.setQueryData(['meetings', 'results', 'summaryStatus'], { meetingId: 'm1', enabled: summaryEnabled });
    client.current.setQueryData(['org', 'get'], { members: [] });
    return render(<MeetingResults meetingId="m1" readers={[]} />);
  };

  it('titles the panel as a level 2 heading, so its level 3 headings do not skip a level under the page title', () => {
    const html = show(results({ draft }), false);
    expect(tag(html, /<div[^>]*data-slot="card-title"[^>]*>/)).toContain('role="heading"');
    expect(tag(html, /<div[^>]*data-slot="card-title"[^>]*>/)).toContain('aria-level="2"');
    expect(html).toMatch(/<h3[^>]*>/);
  });

  it('keeps one polite live region in the page for the run of Vy, empty until something changes, so the draft ready line is announced', () => {
    const html = show(results({ draft }), true);
    const live = tag(html, /<div[^>]*data-testid="vy-live"[^>]*>.*?<\/div>/s);
    expect(live).toContain('role="status"');
    expect(live).toContain('aria-live="polite"');
    expect(live).not.toContain(en.meetings.results.vy.running);
    expect(live).not.toContain(en.meetings.results.vy.ready);
  });

  it('puts the heading of what was shared where the focus goes after publishing', () => {
    const html = show(results({ published }), false);
    expect(tag(html, /<h3[^>]*>[^<]*Shared with attendees[^<]*<\/h3>|<h3[^>]*>[^<]*<\/h3>/)).toContain('tabindex="-1"');
  });
});
