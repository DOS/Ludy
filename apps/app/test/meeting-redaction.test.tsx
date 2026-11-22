// SPDX-License-Identifier: AGPL-3.0-only
// Unit and SSR rendering tests for #4001 Slice 3: draft PII redaction review UI,
// quiet pre-publish nudge, D1-D5 disclosures, selection caps, and localized REDACTION_* error handling.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REDACTION_CANDIDATES_MAX,
  REDACTION_MARK_BY_KIND,
  REDACTION_SELECTIONS_MAX,
  type ActionItemView,
  type Chapter,
  type MeetingResults as ResultsData,
  type RedactionCandidate,
  type Transcript,
  type TranscriptRedactCandidates,
} from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
import { catalog, translatorFor } from '../src/i18n/runtime.ts';
import { ApiError, describeError } from '../src/lib/errors.ts';

const client = vi.hoisted(() => ({ current: null as unknown as QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  const { describeError: describeErr } = await import('../src/lib/errors.ts');
  const { activeLocale, translator } = await import('../src/i18n/runtime.ts');
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
  return {
    orpc: node([]),
    queryClient: client.current,
    errorMessage: (error: unknown) => describeErr(error, translator(), activeLocale()),
  };
});

const {
  RedactionNudge,
  RedactionReviewContent,
  buildCandidateExcerpt,
  canQueryRedactCandidates,
  candidateKey,
  defaultSelectedKeys,
  formatCandidateCount,
  isRedactionReloadableError,
  resolveCandidateSource,
  syncSelectedKeys,
  toRedactionSelections,
  toggleCandidateSelection,
} = await import('../src/components/meeting-redaction.tsx');
const { MeetingResults } = await import('../src/components/meeting-results.tsx');
const { MeetingTranscript } = await import('../src/components/meeting-transcript.tsx');
const { setActiveLocale } = await import('../src/i18n/runtime.ts');

const UUID_MEETING = '01950000-0000-7000-8000-000000000001';
const UUID_SEG = '01950000-0000-7000-8000-000000000002';
const UUID_RES = '01950000-0000-7000-8000-000000000003';
const UUID_ITEM = '01950000-0000-7000-8000-000000000004';
const UUID_CHAP = '01950000-0000-7000-8000-000000000005';
const VERSION = '2026-11-22T10:00:00.000000Z';

function makeCandidate(over: Partial<RedactionCandidate> = {}): RedactionCandidate {
  return {
    surface: 'transcript_segment.text',
    targetId: UUID_SEG,
    decisionIndex: null,
    kind: 'phone',
    startPos: 10,
    endPos: 22,
    matchText: '0912 345 678',
    mark: REDACTION_MARK_BY_KIND.phone,
    version: VERSION,
    startSeconds: 15,
    ...over,
  };
}

function render(node: ReactNode, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client.current}>
        <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
          {node}
        </IntlProvider>
      </QueryClientProvider>,
    );
  } finally {
    setActiveLocale('vi');
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;');
}

describe('meeting redaction helpers (#4001 Slice 3)', () => {
  it('formats candidate counts including truncated 2000+ cap', () => {
    expect(formatCandidateCount(3, false)).toBe('3');
    expect(formatCandidateCount(REDACTION_CANDIDATES_MAX, true)).toBe('2000+');
  });

  it('enables candidate query only for recorder when draft surface or editable title exists (including AI off)', () => {
    expect(canQueryRedactCandidates({ isRecorder: false, hasAnyPublished: false, hasAnyDraftSurface: true })).toBe(false);
    expect(canQueryRedactCandidates({ isRecorder: true, hasAnyPublished: true, hasAnyDraftSurface: false })).toBe(false);
    expect(canQueryRedactCandidates({ isRecorder: true, hasAnyPublished: false, hasAnyDraftSurface: false })).toBe(true);
    expect(canQueryRedactCandidates({ isRecorder: true, hasAnyPublished: true, hasAnyDraftSurface: true })).toBe(true);
  });

  it('extracts excerpts using 1-based Unicode code-point positions even after surrogate-pair emoji', () => {
    const text = '😊 Gọi ngay 0912 345 678 để xác nhận.';
    // Code points: 1:'😊' 2:' ' 3:'G' 4:'ọ' 5:'i' 6:' ' 7:'n' 8:'g' 9:'a' 10:'y' 11:' ' 12:'0'...24:' '
    const excerpt = buildCandidateExcerpt(text, 12, 24, '0912 345 678', 8);
    expect(excerpt).toEqual({
      before: '...ọi ngay ',
      match: '0912 345 678',
      after: ' để xác ...',
    });
    expect(buildCandidateExcerpt(undefined, 12, 24, '0912 345 678')).toEqual({
      before: '',
      match: '0912 345 678',
      after: '',
    });
  });

  it('resolves text and speaker context across all 9 publish surfaces', () => {
    const sources = {
      meetingTitle: 'Họp 0912 345 678',
      segments: [
        { id: UUID_SEG, startSeconds: 15, endSeconds: 20, speakerLabel: 'Anh Minh 0900 000 001', text: 'Gọi 0912 345 678', stage: 'draft' as const, corrected: false, source: 'ludy' as const },
      ],
      draftResult: { id: UUID_RES, feature: 'manual' as const, stage: 'draft' as const, summary: 'Email a@example.com', decisions: ['MST 0100000003'], tainted: false },
      items: [
        {
          id: UUID_ITEM,
          stage: 'draft' as const,
          status: 'suggested' as const,
          title: 'STK 1234567890123456',
          who: 'Chị Lan 0912 345 678',
          whoUserId: null,
          when: 'gọi 0912 345 678',
          whenDate: null,
          transcriptSeconds: 20,
          flags: [],
          tainted: false,
          taskId: null,
          positions: [],
          clean: false,
          suggestion: null,
        } satisfies ActionItemView,
      ],
      draftChapters: [{ id: UUID_CHAP, position: 1, title: 'CCCD 001200000001', startSeconds: 15, tainted: false } satisfies Chapter],
    };

    expect(resolveCandidateSource(makeCandidate({ surface: 'meeting.title', targetId: UUID_MEETING }), sources)).toEqual({ text: 'Họp 0912 345 678' });
    expect(resolveCandidateSource(makeCandidate({ surface: 'transcript_segment.text' }), sources)).toEqual({ text: 'Gọi 0912 345 678', speaker: 'Anh Minh 0900 000 001' });
    expect(resolveCandidateSource(makeCandidate({ surface: 'transcript_segment.speaker_label' }), sources)).toEqual({ text: 'Anh Minh 0900 000 001' });
    expect(resolveCandidateSource(makeCandidate({ surface: 'meeting_result.summary', targetId: UUID_RES }), sources)).toEqual({ text: 'Email a@example.com' });
    expect(resolveCandidateSource(makeCandidate({ surface: 'meeting_result.decision', targetId: UUID_RES, decisionIndex: 0 }), sources)).toEqual({ text: 'MST 0100000003' });
    expect(resolveCandidateSource(makeCandidate({ surface: 'action_item.title', targetId: UUID_ITEM }), sources)).toEqual({ text: 'STK 1234567890123456', speaker: 'Chị Lan 0912 345 678' });
    expect(resolveCandidateSource(makeCandidate({ surface: 'action_item.who_drafted', targetId: UUID_ITEM }), sources)).toEqual({ text: 'Chị Lan 0912 345 678' });
    expect(resolveCandidateSource(makeCandidate({ surface: 'action_item.when_drafted', targetId: UUID_ITEM }), sources)).toEqual({ text: 'gọi 0912 345 678', speaker: 'Chị Lan 0912 345 678' });
    expect(resolveCandidateSource(makeCandidate({ surface: 'meeting_chapter.title', targetId: UUID_CHAP }), sources)).toEqual({ text: 'CCCD 001200000001' });
  });

  it('caps default selection at 500, preserves unchanged toggles on rescan, and emits strict selection items', () => {
    const many = Array.from({ length: 550 }, (_, i) => makeCandidate({ startPos: i + 1, endPos: i + 5 }));
    const defaults = defaultSelectedKeys(many);
    expect(defaults.size).toBe(REDACTION_SELECTIONS_MAX);

    const k1 = candidateKey(many[0]!);
    const k2 = candidateKey(many[1]!);
    const toggled = toggleCandidateSelection(defaults, k1, false);
    expect(toggled.has(k1)).toBe(false);
    expect(toggled.has(k2)).toBe(true);

    // Syncing with unchanged versions preserves k1 unchecked, while a version bump re-selects it.
    const prevTokens = new Map(many.map((c) => [candidateKey(c), `${candidateKey(c)}@${c.version}`]));
    const kept = syncSelectedKeys(many, toggled, prevTokens);
    expect(kept.selected.has(k1)).toBe(false);

    const updated = many.map((c, idx) => (idx === 0 ? { ...c, version: '2026-11-22T10:05:00.000000Z' } : c));
    const refreshed = syncSelectedKeys(updated, toggled, prevTokens);
    expect(refreshed.selected.has(k1)).toBe(true);

    // Pure under React StrictMode double-invocation: calling twice with the same inputs yields identical selections and does not mutate prevTokens.
    const untouchedTokens = new Map<string, string>();
    const firstPass = syncSelectedKeys(many.slice(0, 3), new Set<string>(), untouchedTokens);
    const secondPass = syncSelectedKeys(many.slice(0, 3), new Set<string>(), untouchedTokens);
    expect(untouchedTokens.size).toBe(0);
    expect(Array.from(firstPass.selected)).toEqual(Array.from(secondPass.selected));
    expect(firstPass.selected.size).toBe(3);

    const payload = toRedactionSelections(
      [
        makeCandidate({ surface: 'meeting_result.decision', targetId: UUID_RES, decisionIndex: 2, kind: 'tax_code', startPos: 5 }),
      ],
      new Set([`meeting_result.decision:${UUID_RES}:2:5`]),
    );
    expect(payload).toEqual([
      {
        surface: 'meeting_result.decision',
        targetId: UUID_RES,
        decisionIndex: 2,
        kind: 'tax_code',
        startPos: 5,
        version: VERSION,
      },
    ]);
  });

  it('renders localized vi and en error messages for all REDACTION_* codes and VY_RUN_BUSY (never raw English DomainError in vi)', () => {
    const vi = translatorFor('vi');
    const enTr = translatorFor('en');

    const cases = [
      ['REDACTION_DUPLICATE_SELECTION', 'Duplicate redaction selection', true],
      ['REDACTION_PUBLISHED_IMMUTABLE', 'Published meeting text cannot be redacted', true],
      ['REDACTION_SPAN_MISMATCH', 'Selected item no longer matches detected personal data', true],
      ['REDACTION_STALE', 'This draft changed since you reviewed it; reload and review again', true],
      ['VY_RUN_BUSY', 'A private Vy run for this item just started; try again', false],
    ] as const;

    for (const [code, rawEnglish, reloadable] of cases) {
      const err = new ApiError(code, 409, rawEnglish);
      const viText = describeError(err, vi, 'vi');
      const enText = describeError(err, enTr, 'en');
      expect(viText).toBe(viMessages.kernelErrors.codes[code]);
      expect(viText).not.toBe(rawEnglish);
      expect(enText).toBe(en.kernelErrors.codes[code]);
      expect(isRedactionReloadableError(err)).toBe(reloadable);
    }
  });
});

describe('meeting redaction SSR components (#4001 Slice 3)', () => {
  beforeEach(() => client.current.clear());

  it('shows quiet pre-publish nudge with count and truncated 2000+ without blocking publish, and hides for 0 candidates or non-recorder', () => {
    const draftResults: ResultsData = {
      meetingId: UUID_MEETING,
      isRecorder: true,
      draft: { id: UUID_RES, feature: 'manual', stage: 'draft', summary: 'Gọi 0912 345 678', decisions: [], tainted: false },
      published: null,
      items: [],
    };
    client.current.setQueryData(['meetings', 'results', 'get'], draftResults);
    client.current.setQueryData(['meetings', 'results', 'summaryStatus'], { meetingId: UUID_MEETING, enabled: false });
    client.current.setQueryData(['org', 'get'], { members: [] });
    client.current.setQueryData(['meetings', 'transcript', 'redactCandidates'], {
      meetingId: UUID_MEETING,
      titleEditable: true,
      candidates: [makeCandidate()],
      truncated: false,
    } satisfies TranscriptRedactCandidates);

    const htmlWithNudge = render(<MeetingResults meetingId={UUID_MEETING} readers={[]} />, 'vi');
    expect(htmlWithNudge).toContain('data-testid="redaction-prepublish-nudge"');
    expect(htmlWithNudge).toContain('Phát hiện 1 thông tin nhạy cảm');
    expect(htmlWithNudge).toContain(escapeHtml(viMessages.meetings.redaction.nudgeButton));
    // Publish button stays enabled when PII candidates exist (D6: never blocks publish).
    expect(htmlWithNudge).not.toMatch(/<button[^>]*disabled=""[^>]*>Chia sẻ cho người dự họp<\/button>/);

    // Truncated count shows 2000+.
    const truncHtml = render(<RedactionNudge count={2000} truncated onOpen={() => undefined} testId="redaction-prepublish-nudge" />, 'en');
    expect(truncHtml).toContain('2000+');

    // Zero candidates renders no clutter.
    client.current.setQueryData(['meetings', 'transcript', 'redactCandidates'], {
      meetingId: UUID_MEETING,
      titleEditable: true,
      candidates: [],
      truncated: false,
    } satisfies TranscriptRedactCandidates);
    const htmlClean = render(<MeetingResults meetingId={UUID_MEETING} readers={[]} />, 'vi');
    expect(htmlClean).not.toContain('data-testid="redaction-prepublish-nudge"');

    // Non-recorder never sees nudge even with candidates in cache.
    client.current.setQueryData(['meetings', 'results', 'get'], {
      ...draftResults,
      isRecorder: false,
      draft: null,
      published: { id: UUID_RES, feature: 'manual', stage: 'published', summary: 'Đã chia sẻ', decisions: [], tainted: false },
    });
    client.current.setQueryData(['meetings', 'transcript', 'redactCandidates'], {
      meetingId: UUID_MEETING,
      titleEditable: false,
      candidates: [makeCandidate()],
      truncated: false,
    } satisfies TranscriptRedactCandidates);
    const readerHtml = render(<MeetingResults meetingId={UUID_MEETING} readers={[]} />, 'en');
    expect(readerHtml).not.toContain('data-testid="redaction-prepublish-nudge"');
  });

  it('shows draft transcript nudge for recorder when candidates exist and hides for non-recorder', () => {
    const transcript: Transcript = {
      meetingId: UUID_MEETING,
      isRecorder: true,
      stage: 'draft',
      segments: [{ id: UUID_SEG, startSeconds: 15, endSeconds: 20, speakerLabel: 'An', text: 'Gọi 0912 345 678', stage: 'draft', corrected: false, source: 'ludy' }],
    };
    client.current.setQueryData(['meetings', 'transcript', 'get'], transcript);
    client.current.setQueryData(['meetings', 'transcript', 'redactCandidates'], {
      meetingId: UUID_MEETING,
      titleEditable: true,
      candidates: [makeCandidate()],
      truncated: false,
    } satisfies TranscriptRedactCandidates);

    const recorderHtml = render(<MeetingTranscript meetingId={UUID_MEETING} />, 'vi');
    expect(recorderHtml).toContain('data-testid="transcript-redaction-nudge"');

    client.current.setQueryData(['meetings', 'transcript', 'get'], { ...transcript, isRecorder: false, stage: 'published' });
    const readerHtml = render(<MeetingTranscript meetingId={UUID_MEETING} />, 'vi');
    expect(readerHtml).not.toContain('data-testid="transcript-redaction-nudge"');
  });

  it('renders review dialog content with all D1-D5 disclosures, surface groups, marks, and stale reload prompt in vi and en', () => {
    const candidates: RedactionCandidate[] = [
      makeCandidate({ surface: 'meeting.title', targetId: UUID_MEETING, kind: 'phone', startPos: 5, endPos: 17, matchText: '0912 345 678', mark: REDACTION_MARK_BY_KIND.phone, startSeconds: null }),
      makeCandidate({ surface: 'transcript_segment.text', targetId: UUID_SEG, kind: 'email', startPos: 7, endPos: 24, matchText: 'a@example.com', mark: REDACTION_MARK_BY_KIND.email, startSeconds: 75 }),
      makeCandidate({ surface: 'meeting_result.decision', targetId: UUID_RES, decisionIndex: 0, kind: 'tax_code', startPos: 5, endPos: 15, matchText: '0100000003', mark: REDACTION_MARK_BY_KIND.tax_code, startSeconds: null }),
    ];
    const data: TranscriptRedactCandidates = {
      meetingId: UUID_MEETING,
      titleEditable: false,
      candidates,
      truncated: true,
    };
    const sources = {
      meetingTitle: 'Họp 0912 345 678',
      segments: [{ id: UUID_SEG, startSeconds: 75, endSeconds: 80, speakerLabel: 'Anh Minh', text: 'Email a@example.com nhé', stage: 'draft' as const, corrected: false, source: 'ludy' as const }],
      draftResult: { id: UUID_RES, feature: 'manual' as const, stage: 'draft' as const, summary: 'S', decisions: ['MST 0100000003'], tainted: false },
    };

    const htmlVi = render(
      <RedactionReviewContent
        data={data}
        isLoading={false}
        queryError={null}
        sources={sources}
        selectedKeys={defaultSelectedKeys(candidates)}
        onToggleKey={() => undefined}
        onSelectAll={() => undefined}
        onClearAll={() => undefined}
        onRescan={() => undefined}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onReload={() => undefined}
        isSubmitting={false}
        submitError={{ code: 'REDACTION_STALE', message: 'This draft changed since you reviewed it; reload and review again' }}
      />,
      'vi',
    );

    // D2, D5, audio/video, D4 disclosures.
    expect(htmlVi).toContain(escapeHtml(viMessages.meetings.redaction.disclosureNoUndo));
    expect(htmlVi).toContain(escapeHtml(viMessages.meetings.redaction.disclosureDropsCopies));
    expect(htmlVi).toContain(escapeHtml(viMessages.meetings.redaction.disclosureMedia));
    expect(htmlVi).toContain(escapeHtml(viMessages.meetings.redaction.disclosureCodeOnly));
    expect(htmlVi).toContain('data-testid="redaction-title-locked"');
    expect(htmlVi).toContain('data-testid="redaction-truncated"');
    expect(htmlVi).toContain('Anh Minh · 1:15');
    expect(htmlVi).toContain('Quyết định #1');
    expect(htmlVi).toContain('[đã ẩn: số điện thoại]');
    expect(htmlVi).toContain('[đã ẩn: email]');
    expect(htmlVi).toContain('[đã ẩn: mã số thuế]');
    // Localized Vietnamese REDACTION_STALE message and reload button.
    expect(htmlVi).toContain(escapeHtml(viMessages.kernelErrors.codes.REDACTION_STALE));
    expect(htmlVi).not.toContain('This draft changed since you reviewed it');
    expect(htmlVi).toContain('data-testid="redaction-reload"');

    const htmlEn = render(
      <RedactionReviewContent
        data={{ ...data, titleEditable: true, truncated: false }}
        isLoading={false}
        queryError={null}
        sources={sources}
        selectedKeys={new Set()}
        onToggleKey={() => undefined}
        onSelectAll={() => undefined}
        onClearAll={() => undefined}
        onRescan={() => undefined}
        onConfirm={() => undefined}
        onCancel={() => undefined}
        onReload={() => undefined}
        isSubmitting={false}
        submitError={{ code: 'VY_RUN_BUSY', message: 'A private Vy run for this item just started; try again' }}
      />,
      'en',
    );
    expect(htmlEn).toContain(escapeHtml(en.meetings.redaction.disclosureNoUndo));
    expect(htmlEn).toContain(escapeHtml(en.meetings.redaction.disclosureDropsCopies));
    expect(htmlEn).toContain(escapeHtml(en.meetings.redaction.disclosureMedia));
    expect(htmlEn).toContain(escapeHtml(en.meetings.redaction.disclosureCodeOnly));
    expect(htmlEn).toContain(escapeHtml(en.kernelErrors.codes.VY_RUN_BUSY));
    expect(htmlEn).not.toContain('data-testid="redaction-reload"');
    // Confirm button disabled when 0 selected.
    expect(htmlEn).toMatch(/<button[^>]*disabled=""[^>]*data-testid="redaction-confirm"/);
  });
});
