// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({
  client: null as unknown as import('@tanstack/react-query').QueryClient,
  modules: ['kernel', 'meetings', 'notes'] as string[],
}));

vi.mock('../src/lib/auth.ts', () => ({
  getConfig: () => ({ modules: state.modules }),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children?: React.ReactNode;
    className?: string;
  }) => {
    const href = Object.entries(params ?? {}).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to);
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.client = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), queryClient: state.client, errorMessage: String };
});

const { MeetingResults, SaveSummaryAsNote, hasSummaryText, isSummaryDraftDirty } = await import('../src/components/meeting-results.tsx');

const READER = '0198a0b4-0000-7e6f-8a9b-0c1d2e3f4a5b';

type Results = {
  isRecorder: boolean;
  draft: { summary: string; decisions: string[]; tainted: boolean; translation: null; translatedAt: null } | null;
  published: { summary: string; decisions: string[]; translation: null; translatedAt: null } | null;
  items: never[];
};

function render(results: Results, options: { visibility?: 'attendees' | 'org'; locale?: 'vi' | 'en' } = {}) {
  const locale = options.locale ?? 'en';
  state.client.setQueryData(['meetings', 'results', 'get'], results);
  state.client.setQueryData(['meetings', 'results', 'summaryStatus'], { meetingId: 'm1', enabled: false });
  state.client.setQueryData(['org', 'get'], { members: [{ userId: READER, email: 'lan@example.com', displayName: 'Chi Lan', role: 'member' }] });
  return renderToStaticMarkup(
    <QueryClientProvider client={state.client}>
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
        <MeetingResults
          meetingId="m1"
          slug="acme"
          {...(options.visibility ? { visibility: options.visibility } : {})}
          readers={[READER]}
          template="general"
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('MeetingResults save summary as note (N10)', () => {
  beforeEach(() => {
    state.client.clear();
    state.modules = ['kernel', 'meetings', 'notes'];
  });

  it('shows confirm-dialog Save as shared note button for attendees-scoped meetings with a published summary', () => {
    const html = render(
      {
        isRecorder: false,
        draft: null,
        published: { summary: 'Weekly quote agreed.', decisions: ['Keep price'], translation: null, translatedAt: null },
        items: [],
      },
      { visibility: 'attendees' },
    );
    expect(html).toContain('Save as shared note');
    expect(html).toContain('aria-haspopup="dialog"');

    // Failing closed when visibility is not explicitly 'org'
    const fallbackHtml = render({
      isRecorder: false,
      draft: null,
      published: { summary: 'Weekly quote agreed.', decisions: [], translation: null, translatedAt: null },
      items: [],
    });
    expect(fallbackHtml).toContain('aria-haspopup="dialog"');
  });

  it('shows direct Save as shared note button without confirm dialog for org-scoped meetings', () => {
    const html = render(
      {
        isRecorder: false,
        draft: null,
        published: { summary: 'All-hands summary.', decisions: [], translation: null, translatedAt: null },
        items: [],
      },
      { visibility: 'org' },
    );
    expect(html).toContain('Save as shared note');
    expect(html).not.toContain('aria-haspopup="dialog"');
  });

  it('allows the recorder to save a non-empty unpublished draft when nothing is published yet', () => {
    const html = render(
      {
        isRecorder: true,
        draft: { summary: 'Draft recap for pilot', decisions: [], tainted: false, translation: null, translatedAt: null },
        published: null,
        items: [],
      },
      { visibility: 'attendees', locale: 'vi' },
    );
    expect(html).toContain('Lưu thành ghi chú chung');
  });

  it('hides the button when draft is blank or unreviewed AI draft, when attendee sees no published summary, or when notes is off', () => {
    const blankDraft = render(
      {
        isRecorder: true,
        draft: { summary: '   ', decisions: [], tainted: false, translation: null, translatedAt: null },
        published: null,
        items: [],
      },
      { visibility: 'org' },
    );
    expect(blankDraft).not.toContain('Save as shared note');

    const taintedDraft = render(
      {
        isRecorder: true,
        draft: { summary: 'Unreviewed Vy draft', decisions: [], tainted: true, translation: null, translatedAt: null },
        published: null,
        items: [],
      },
      { visibility: 'org' },
    );
    expect(taintedDraft).not.toContain('Save as shared note');

    const attendeeNoPublished = render(
      {
        isRecorder: false,
        draft: null,
        published: null,
        items: [],
      },
      { visibility: 'org' },
    );
    expect(attendeeNoPublished).not.toContain('Save as shared note');

    state.modules = ['kernel', 'meetings'];
    const notesOff = render(
      {
        isRecorder: true,
        draft: null,
        published: { summary: 'Summary ready.', decisions: [], translation: null, translatedAt: null },
        items: [],
      },
      { visibility: 'org' },
    );
    expect(notesOff).not.toContain('Save as shared note');
  });

  it('exposes Save as shared note for a non-empty untainted draft when the published row has empty summary and decisions (action-items-only publish)', () => {
    expect(hasSummaryText({ summary: '   ', decisions: ['', '  '] })).toBe(false);
    const emptyPublishedWithDraft = render(
      {
        isRecorder: true,
        draft: { summary: 'Draft recap after action items published', decisions: [], tainted: false, translation: null, translatedAt: null },
        published: { summary: '   ', decisions: [''], translation: null, translatedAt: null },
        items: [],
      },
      { visibility: 'org' },
    );
    expect(emptyPublishedWithDraft).toContain('Save as shared note');

    const emptyPublishedWithTaintedDraft = render(
      {
        isRecorder: true,
        draft: { summary: 'Unreviewed Vy draft', decisions: [], tainted: true, translation: null, translatedAt: null },
        published: { summary: '', decisions: [], translation: null, translatedAt: null },
        items: [],
      },
      { visibility: 'org' },
    );
    expect(emptyPublishedWithTaintedDraft).not.toContain('Save as shared note');
  });

  it('disables SaveSummaryAsNote and renders a warning linked by aria-describedby while the draft has unsaved local edits', () => {
    const renderSaveBox = (unsavedDraft: boolean, visibility: 'attendees' | 'org', locale: 'en' | 'vi' = 'en') =>
      renderToStaticMarkup(
        <QueryClientProvider client={state.client}>
          <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
            <SaveSummaryAsNote meetingId="m1" visibility={visibility} slug="acme" unsavedDraft={unsavedDraft} />
          </IntlProvider>
        </QueryClientProvider>,
      );

    const saveButtonTag = (html: string) => /<button[^>]*data-testid="save-summary-as-note"[^>]*>/.exec(html)?.[0] ?? '';

    const cleanOrg = renderSaveBox(false, 'org');
    expect(cleanOrg).not.toContain('data-testid="save-summary-unsaved-warning"');
    expect(saveButtonTag(cleanOrg)).not.toBe('');
    expect(saveButtonTag(cleanOrg)).not.toMatch(/\sdisabled(?:=|\s|>)/);

    const dirtyOrg = renderSaveBox(true, 'org', 'en');
    expect(dirtyOrg).toContain('data-testid="save-summary-unsaved-warning"');
    expect(dirtyOrg).toContain(en.meetings.results.saveAsNoteUnsavedDraft);
    expect(saveButtonTag(dirtyOrg)).toMatch(/\sdisabled(?:=|\s|>)/);
    const warningId = /id="([^"]+)"[^>]*data-testid="save-summary-unsaved-warning"|data-testid="save-summary-unsaved-warning"[^>]*id="([^"]+)"/.exec(dirtyOrg);
    const resolvedId = warningId?.[1] ?? warningId?.[2] ?? '';
    expect(resolvedId).not.toBe('');
    expect(saveButtonTag(dirtyOrg)).toContain(`aria-describedby="${resolvedId}"`);

    const dirtyAttendeesVi = renderSaveBox(true, 'attendees', 'vi');
    expect(dirtyAttendeesVi).toContain(viMessages.meetings.results.saveAsNoteUnsavedDraft);
    expect(saveButtonTag(dirtyAttendeesVi)).toMatch(/\sdisabled(?:=|\s|>)/);
    const attendeesWarningId =
      /id="([^"]+)"[^>]*data-testid="save-summary-unsaved-warning"|data-testid="save-summary-unsaved-warning"[^>]*id="([^"]+)"/.exec(dirtyAttendeesVi);
    const resolvedAttendeesId = attendeesWarningId?.[1] ?? attendeesWarningId?.[2] ?? '';
    expect(resolvedAttendeesId).not.toBe('');
    expect(saveButtonTag(dirtyAttendeesVi)).toContain(`aria-describedby="${resolvedAttendeesId}"`);
  });

  it('detects unsaved local draft edits across free-text summaries, decisions, and sectioned templates', () => {
    expect(
      isSummaryDraftDirty({
        summary: 'Saved summary',
        decisions: ['Keep price'],
        template: 'general',
        copy: null,
        text: 'Saved summary',
        values: {},
        lines: 'Keep price',
      }),
    ).toBe(false);

    expect(
      isSummaryDraftDirty({
        summary: 'Saved summary',
        decisions: ['Keep price'],
        template: 'general',
        copy: null,
        text: 'Saved summary edited locally',
        values: {},
        lines: 'Keep price',
      }),
    ).toBe(true);

    expect(
      isSummaryDraftDirty({
        summary: 'Saved summary',
        decisions: ['Keep price'],
        template: 'general',
        copy: null,
        text: 'Saved summary',
        values: {},
        lines: 'Keep price\nNew decision',
      }),
    ).toBe(true);

    const briefing = 'Kết quả công việc kỳ trước\nĐã gửi hợp đồng.\n\nKế hoạch kỳ tới\nGửi báo giá.';
    expect(
      isSummaryDraftDirty({
        summary: briefing,
        decisions: [],
        template: 'briefing',
        copy: null,
        text: briefing,
        values: { progress: 'Đã gửi hợp đồng.', plan: 'Gửi báo giá.' },
        lines: '',
      }),
    ).toBe(false);

    expect(
      isSummaryDraftDirty({
        summary: briefing,
        decisions: [],
        template: 'briefing',
        copy: null,
        text: briefing,
        values: { progress: 'Đã sửa nháp.', plan: 'Gửi báo giá.' },
        lines: '',
      }),
    ).toBe(true);

    // Reflowed non-matching summary falls into the first section without falsely reporting dirty.
    expect(
      isSummaryDraftDirty({
        summary: 'Free text before switching template',
        decisions: [],
        template: 'briefing',
        copy: null,
        text: 'Free text before switching template',
        values: { progress: 'Free text before switching template', plan: '' },
        lines: '',
      }),
    ).toBe(false);
  });
});
