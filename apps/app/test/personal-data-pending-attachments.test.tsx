// SPDX-License-Identifier: AGPL-3.0-only
// Settings > Personal data pending note attachments warning and export scrubbing (#5127): verifies that
// pendingNoteAttachments renders shared-only, private-only, and combined notices in Vietnamese and English, and
// that personalDataExportBody omits privateItems, meetingText, and pendingNoteAttachments from requester downloads.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { PersonalDataResult } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const state = vi.hoisted(() => ({ qc: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  state.qc = new QC();
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => {
        if (prop === 'queryOptions') return () => ({ queryKey: path, queryFn: () => Promise.reject(new Error('not fetched')) });
        if (prop === 'mutationOptions') return () => ({});
        if (prop === 'key') return () => path;
        return node([...path, prop]);
      },
    });
  return { orpc: node([]), client: {}, queryClient: state.qc, errorMessage: (e: unknown) => String(e), isStepUpRequired: () => false };
});
vi.mock('../src/lib/auth.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), getConfig: () => ({ modules: [] }) }));

const {
  PendingNoteAttachmentsWarning,
  PersonalDataEmptyState,
  PersonalDataSearchWarnings,
  personalDataExportBody,
} = await import('../src/routes/personal-data.tsx');

function renderWarning(locale: 'vi' | 'en', pending: NonNullable<PersonalDataResult['pendingNoteAttachments']>): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <PendingNoteAttachmentsWarning pending={pending} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function renderSearchResultState(
  locale: 'vi' | 'en',
  result: Pick<PersonalDataResult, 'pendingNoteAttachments' | 'meetingTextSkipped' | 'truncated'>,
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={state.qc}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <PersonalDataSearchWarnings result={result} />
        <PersonalDataEmptyState result={result} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('personal-data pending note attachments warning and export scrubbing (#5127)', () => {
  it('renders shared-only, private-only, and combined warnings in Vietnamese and English', () => {
    const viShared = renderWarning('vi', { shared: 2, private: null });
    expect(viShared).toContain('data-testid="personal-data-pending-note-attachments"');
    expect(viShared).toContain('2 tệp đính kèm ghi chú chung');

    const enShared = renderWarning('en', { shared: 1, private: 0 });
    expect(enShared).toContain('1 shared note attachment is still awaiting text extraction');

    const viPriv = renderWarning('vi', { shared: 0, private: 3 });
    expect(viPriv).toContain('3 tệp đính kèm ghi chú riêng');

    const enPriv = renderWarning('en', { shared: 0, private: 1 });
    expect(enPriv).toContain('1 private note attachment is still awaiting text extraction');

    const viBoth = renderWarning('vi', { shared: 2, private: 3 });
    expect(viBoth).toContain('2 tệp đính kèm ghi chú chung');
    expect(viBoth).toContain('3 tệp đính kèm ghi chú riêng');
    expect(viBoth).toContain('thùng rác');

    const enBoth = renderWarning('en', { shared: 1, private: 2 });
    expect(enBoth).toContain('1 shared note attachment');
    expect(enBoth).toContain('2 private note attachments');
    expect(enBoth).toContain('trash');

    expect(renderWarning('vi', { shared: 0, private: 0 })).toBe('');
  });

  it('strips privateItems, meetingText, and pendingNoteAttachments from requester export JSON', () => {
    const body = personalDataExportBody('khach@example.com', {
      kind: 'email',
      matches: [],
      privateItems: [{ authorUserId: '00000000-0000-7000-8000-000000000001', notes: 2, todos: 1 }],
      meetingText: [{ recorderUserId: '00000000-0000-7000-8000-000000000002', meetings: 1, lines: 3, results: 0, items: 0, titles: 0 }],
      meetingTextSkipped: false,
      pendingNoteAttachments: { shared: 1, private: 4 },
      truncated: false,
    });
    expect(body).toEqual({
      value: 'khach@example.com',
      kind: 'email',
      matches: [],
      meetingTextSkipped: false,
      truncated: false,
    });
    expect('privateItems' in body).toBe(false);
    expect('meetingText' in body).toBe(false);
    expect('pendingNoteAttachments' in body).toBe(false);
  });

  it('shows incomplete-search warnings and qualified empty text even when zero rows matched', () => {
    const enComplete = renderSearchResultState('en', { meetingTextSkipped: false, truncated: false });
    expect(enComplete).toContain('No data matches');
    expect(enComplete).not.toContain('in the records searched so far');

    const enMeetingSkipped = renderSearchResultState('en', { meetingTextSkipped: true, truncated: false });
    expect(enMeetingSkipped).toContain('data-testid="personal-data-meeting-text-skipped"');
    expect(enMeetingSkipped).toContain('No data matches in the records searched so far');

    const viPending = renderSearchResultState('vi', {
      meetingTextSkipped: false,
      truncated: false,
      pendingNoteAttachments: { shared: 1, private: null },
    });
    expect(viPending).toContain('data-testid="personal-data-pending-note-attachments"');
    expect(viPending).toContain('Chưa tìm thấy dữ liệu nào khớp trong phần đã tìm');

    const enBothIncomplete = renderSearchResultState('en', {
      meetingTextSkipped: true,
      truncated: false,
      pendingNoteAttachments: { shared: 1, private: 2 },
    });
    expect(enBothIncomplete).toContain('data-testid="personal-data-pending-note-attachments"');
    expect(enBothIncomplete).toContain('data-testid="personal-data-meeting-text-skipped"');
    expect(enBothIncomplete).not.toContain('The other results are complete');
    expect(enBothIncomplete).toContain('No data matches in the records searched so far');

    const viBothIncomplete = renderSearchResultState('vi', {
      meetingTextSkipped: true,
      truncated: false,
      pendingNoteAttachments: { shared: 1, private: 2 },
    });
    expect(viBothIncomplete).toContain('data-testid="personal-data-pending-note-attachments"');
    expect(viBothIncomplete).toContain('data-testid="personal-data-meeting-text-skipped"');
    expect(viBothIncomplete).not.toContain('Các kết quả khác vẫn đầy đủ');
    expect(viBothIncomplete).toContain('Chưa tìm thấy dữ liệu nào khớp trong phần đã tìm');
  });
});
