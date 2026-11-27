// SPDX-License-Identifier: AGPL-3.0-only
// Server-rendered component tests for L33 meeting catch-up (#5130):
//   - "Việc của bạn" (user_id + name fallback, status & matchedBy badges) shows even when AI is off, forbidden, or budget-spent
//   - Vy button ("Cập nhật nhanh cho tôi"), written lines with decision/item citation chips, empty state, and error code parity
//   - Hidden for recorder, unpublished, redacted, and AI-off with empty yourItems.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { CatchUpAnswer, CatchUpStatus } from '@ludy/kernel-contract';
import { en } from '../src/i18n/messages/en.ts';
import { vi as viMessages } from '../src/i18n/messages/vi.ts';
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

const { CatchUpResult, MeetingCatchUp, catchUpAnchorId, catchUpRunCodeOf } = await import('../src/components/meeting-catch-up.tsx');

const ITEM_A = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';

const baseStatus = (over: Partial<CatchUpStatus> = {}): CatchUpStatus => ({
  meetingId: 'm1',
  available: true,
  reason: null,
  yourItems: [],
  estimate: { inputTokens: 1800, outputTokens: 350, cost: '0.0042' },
  ...over,
});

function renderStatus(status: CatchUpStatus | null, locale: 'en' | 'vi' = 'en') {
  if (status) client.current.setQueryData(['meetings', 'catchUp', 'status'], status);
  else client.current.removeQueries({ queryKey: ['meetings', 'catchUp', 'status'] });
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MeetingCatchUp meetingId="m1" />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function renderResult(answer: CatchUpAnswer, locale: 'en' | 'vi' = 'en') {
  return renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <CatchUpResult answer={answer} />
    </IntlProvider>,
  );
}

describe('MeetingCatchUp (#5130)', () => {
  it('hides cleanly when status is missing, unpublished, redacted, or AI-off without yourItems, and notes recorder status cleanly', () => {
    expect(renderStatus(null)).toBe('');
    expect(renderStatus(baseStatus({ available: false, reason: 'not_published' }))).toBe('');
    expect(renderStatus(baseStatus({ available: false, reason: 'redacted' }))).toBe('');
    expect(renderStatus(baseStatus({ available: false, reason: 'off', yourItems: [], estimate: null }))).toBe('');

    const recorderHtml = renderStatus(baseStatus({ available: false, reason: 'is_recorder', yourItems: [], estimate: null }), 'vi');
    expect(recorderHtml).toContain('data-testid="catch-up-recorder-note"');
    expect(recorderHtml).toContain(viMessages.meetings.catchUp.recorderOnlyNote);
  });

  it('shows code-built "Việc của bạn" even when AI is off and highlights matchedBy name', () => {
    const html = renderStatus(
      baseStatus({
        available: false,
        reason: 'off',
        estimate: null,
        yourItems: [
          {
            itemId: ITEM_A,
            title: 'Gửi báo giá cho khách A',
            who: 'chị Lan',
            when: 'thứ sáu',
            whenDate: '2026-11-28',
            status: 'suggested',
            taskId: null,
            matchedBy: 'name',
          },
        ],
      }),
      'vi',
    );
    expect(html).toContain('data-testid="catch-up-your-items"');
    expect(html).toContain(viMessages.meetings.catchUp.yourItemsTitle);
    expect(html).toContain('Gửi báo giá cho khách A');
    expect(html).toContain(viMessages.meetings.catchUp.matchedByName);
    expect(html).not.toContain('data-testid="catch-up-button"');
  });

  it('shows the catch-up button in Vietnamese ("Cập nhật nhanh cho tôi") and blocked reasons when forbidden/budget', () => {
    const ready = renderStatus(baseStatus(), 'vi');
    expect(ready).toContain('data-testid="catch-up-button"');
    expect(ready).toContain('Cập nhật nhanh cho tôi');
    expect(ready).toContain('data-testid="catch-up-estimate"');

    const forbidden = renderStatus(baseStatus({ available: false, reason: 'forbidden', estimate: null }));
    expect(forbidden).toContain('data-testid="catch-up-blocked"');
    expect(forbidden).toContain(en.meetings.catchUp.blockedForbidden);

    const paused = renderStatus(baseStatus({ available: false, reason: 'paused', estimate: null }));
    expect(paused).toContain('data-testid="catch-up-blocked"');
    expect(paused).toContain(en.meetings.catchUp.blockedPaused);

    const budget = renderStatus(baseStatus({ available: false, reason: 'budget', estimate: null }));
    expect(budget).toContain(en.meetings.catchUp.blockedBudget);
  });

  it('renders cited lines with decision/item anchor IDs, empty state, and failed error codes', () => {
    expect(catchUpAnchorId({ kind: 'decision', index: 2 })).toBe('meeting-decision-2');
    expect(catchUpAnchorId({ kind: 'item', itemId: ITEM_A })).toBe(`meeting-action-${ITEM_A}`);

    const written = renderResult({
      state: 'written',
      errorCode: null,
      lines: [
        { text: 'Nhóm chốt ngân sách chiến dịch tháng 12.', cite: { kind: 'decision', index: 1 } },
        { text: 'Bạn cần gửi báo giá cho khách A.', cite: { kind: 'item', itemId: ITEM_A } },
      ],
      dropped: 1,
    });
    expect(written).toContain('data-testid="catch-up-result"');
    expect(written).toContain(en.meetings.catchUp.fromVy);
    expect(written).toContain('Decision 1');
    expect(written).toContain(en.meetings.catchUp.citeItem);
    expect(written).toContain('data-testid="catch-up-dropped"');

    expect(renderResult({ state: 'none', errorCode: null, lines: [], dropped: 0 })).toContain(en.meetings.catchUp.empty);

    const failed = renderResult({ state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED', lines: [], dropped: 0 });
    expect(failed).toContain(en.meetings.catchUp.codes.AI_BUDGET_EXHAUSTED);
    expect(catchUpRunCodeOf('CATCH_UP_UNPARSABLE')).toBe('CATCH_UP_UNPARSABLE');
    expect(catchUpRunCodeOf('UNKNOWN_CODE')).toBe('default');
  });
});
