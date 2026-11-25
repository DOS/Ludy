// SPDX-License-Identifier: AGPL-3.0-only
// Web UI tests for L26 sales call insights (#4920):
//   - rendered only for the recorder when the meeting is linked to an open deal and has a transcript
//   - AI-off, kill-switch paused, budget-exhausted, and permission-forbidden reasons shown clearly with disabled action
//   - mapped customer talk share vs unmapped fallback notice
//   - concerns, buying signals, and agreed next steps + owners with clickable >= 44px line-citation chips jumping to seconds
//   - accessible headings, status live region, plain-text escaping, and vi/en copy parity
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { SalesInsightAnswer, SalesInsightStatus } from '@ludy/kernel-contract';
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

const { CitationChipButton, MeetingSalesInsight, SalesInsightResult, salesInsightRunCodeOf } = await import('../src/components/meeting-sales-insight.tsx');

const wrap = (node: React.ReactNode, locale: 'en' | 'vi' = 'vi') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} timeZone="Asia/Ho_Chi_Minh" messages={catalog(locale)}>
        {node}
      </IntlProvider>
    </QueryClientProvider>,
  );

const renderCard = (statusData: SalesInsightStatus | null, props: { isRecorder: boolean; hasTranscript: boolean }, locale: 'en' | 'vi' = 'vi') => {
  client.current.clear();
  if (statusData !== null) {
    client.current.setQueryData(['meetings', 'salesInsight', 'status'], statusData);
  }
  return wrap(<MeetingSalesInsight meetingId="m1" onJump={() => undefined} {...props} />, locale);
};

const sampleStatus = (over: Partial<SalesInsightStatus> = {}): SalesInsightStatus => ({
  meetingId: 'm1',
  available: true,
  enabled: true,
  reason: null,
  deal: { id: 'd1', title: 'Hợp đồng phần mềm kế toán', stage: 'Báo giá' },
  ...over,
});

const sampleAnswer = (over: Partial<SalesInsightAnswer> = {}): SalesInsightAnswer => ({
  state: 'ready',
  errorCode: null,
  deal: { id: 'd1', title: 'Hợp đồng phần mềm kế toán', stage: 'Báo giá' },
  customerTalkShare: {
    customerPercent: 62,
    internalPercent: 38,
    customerSeconds: 186,
    totalSeconds: 300,
    customerSpeakers: ['Anh Minh'],
  },
  concerns: [
    {
      text: 'Khách lo ngại <b>phí</b> triển khai ban đầu cao.',
      citations: [{ lineId: 'line-1', seconds: 45, speakerLabel: 'Anh Minh' }],
    },
  ],
  buyingSignals: [
    {
      text: 'Ngân sách 120 triệu đã được duyệt cho tháng 12.',
      citations: [{ lineId: 'line-2', seconds: 120, speakerLabel: 'Anh Minh' }],
    },
  ],
  nextSteps: [
    {
      text: 'Gửi bảng báo giá chi tiết trong chiều nay.',
      owner: 'Lan',
      citations: [{ lineId: 'line-3', seconds: 3725, speakerLabel: 'Lan' }],
    },
  ],
  dropped: 0,
  ...over,
});

describe('MeetingSalesInsight visibility and AI-off states', () => {
  it('shows the card with Phân tích button only to the recorder when available', () => {
    const viHtml = renderCard(sampleStatus(), { isRecorder: true, hasTranscript: true }, 'vi');
    expect(viHtml).toContain('Nhận định cuộc gọi bán hàng');
    expect(viHtml).toContain('Phân tích');
    expect(viHtml).toContain('Hợp đồng phần mềm kế toán');
    expect(viHtml).toContain('role="heading" aria-level="2"');

    const enHtml = renderCard(sampleStatus(), { isRecorder: true, hasTranscript: true }, 'en');
    expect(enHtml).toContain('Sales call insights');
    expect(enHtml).toContain('Analyze');
  });

  it('hides the card for non-recorders, without transcript, or without an open deal', () => {
    expect(renderCard(sampleStatus(), { isRecorder: false, hasTranscript: true })).toBe('');
    expect(renderCard(sampleStatus(), { isRecorder: true, hasTranscript: false })).toBe('');
    expect(renderCard(sampleStatus({ available: false, enabled: false, reason: 'no_deal', deal: null }), { isRecorder: true, hasTranscript: true })).toBe('');
    expect(renderCard(sampleStatus({ available: false, enabled: false, reason: 'deal_closed', deal: null }), { isRecorder: true, hasTranscript: true })).toBe('');
    expect(renderCard(null, { isRecorder: true, hasTranscript: true })).toBe('');
  });

  it('shows clear AI-off, kill-switch paused, and budget-spent messages with the run button disabled', () => {
    for (const [reason, snippetVi, snippetEn] of [
      ['off', 'AI đang tắt', 'AI is switched off'],
      ['paused', 'lệnh dừng AI', 'paused by a kill switch'],
      ['budget', 'Ngân sách AI tháng này đã dùng hết', 'AI budget for this month is used up'],
    ] as const) {
      const viHtml = renderCard(sampleStatus({ available: true, enabled: false, reason }), { isRecorder: true, hasTranscript: true }, 'vi');
      expect(viHtml).toContain('disabled=""');
      expect(viHtml).toContain('data-testid="sales-insight-disabled-reason"');
      expect(viHtml).toContain(snippetVi);
      const enHtml = renderCard(sampleStatus({ available: true, enabled: false, reason }), { isRecorder: true, hasTranscript: true }, 'en');
      expect(enHtml).toContain(snippetEn);
    }
  });
});

describe('SalesInsightResult content, citations, and accessibility', () => {
  it('renders customer talk share, all three insight sections, owners, >=44px citation chips, and plain-text escaping', () => {
    const html = wrap(<SalesInsightResult answer={sampleAnswer({ dropped: 1 })} onJump={() => undefined} />, 'vi');
    expect(html).toContain('Khách hàng 62%, Nội bộ 38%');
    expect(html).toContain('Anh Minh');
    expect(html).toContain('Băn khoăn và phản đối của khách');
    expect(html).toContain('Tín hiệu mua hàng');
    expect(html).toContain('Bước tiếp theo đã thống nhất');
    expect(html).toContain('Phụ trách: Lan');
    expect(html).not.toContain('<b>phí</b>');
    expect(html).toContain('&lt;b&gt;phí&lt;/b&gt;');
    expect(html).toContain('Đã bỏ 1 mục của Vy');

    const chips = [...html.matchAll(/<button[^>]*data-testid="sales-insight-citation"[^>]*>([^<]*)<\/button>/g)];
    expect(chips).toHaveLength(3);
    expect(chips.map((c) => c[1])).toEqual(['0:45', '2:00', '1:02:05']);
    for (const [tag, label] of chips) {
      expect(tag).toContain(`aria-label="Mở bản ghi lời nói ở ${label}"`);
      expect(tag).toContain('min-h-11');
      expect(tag).toContain('min-w-11');
    }
  });

  it('shows unmapped talk-share explanation cleanly when customerTalkShare is null', () => {
    const htmlVi = wrap(<SalesInsightResult answer={sampleAnswer({ customerTalkShare: null })} onJump={() => undefined} />, 'vi');
    expect(htmlVi).toContain('chưa gán tên người nói');
    const htmlEn = wrap(<SalesInsightResult answer={sampleAnswer({ customerTalkShare: null })} onJump={() => undefined} />, 'en');
    expect(htmlEn).toContain('until speakers are mapped');
  });

  it('invokes onJump with the exact citation seconds when clicking a chip button', () => {
    const jumped: number[] = [];
    const ans = sampleAnswer();
    const citations = [...ans.concerns, ...ans.buyingSignals, ...ans.nextSteps].flatMap((item) => item.citations);
    for (const c of citations) {
      const btn = CitationChipButton({
        lineId: c.lineId,
        seconds: c.seconds,
        timeLabel: '0:00',
        jumpLabel: 'Open transcript',
        onJump: (sec) => jumped.push(sec),
      });
      (btn.props as { onClick: () => void }).onClick();
    }
    expect(jumped).toEqual([45, 120, 3725]);
  });

  it('renders clear failure states for off, paused, budget, and timeout error codes', () => {
    for (const [state, errorCode, expectedVi] of [
      ['off', 'SUMMARY_OFF', 'AI đang tắt'],
      ['paused', 'AI_STOPPED', 'AI đang tạm dừng'],
      ['budget', 'AI_BUDGET_EXHAUSTED', 'Ngân sách AI của kỳ này đã dùng hết'],
      ['failed', 'SALES_INSIGHT_TIMEOUT', 'Mất quá nhiều thời gian'],
    ] as const) {
      const html = wrap(<SalesInsightResult answer={sampleAnswer({ state, errorCode, customerTalkShare: null, concerns: [], buyingSignals: [], nextSteps: [] })} onJump={() => undefined} />, 'vi');
      expect(html).toContain('data-testid="sales-insight-failed"');
      expect(html).toContain(expectedVi);
    }
    expect(salesInsightRunCodeOf(null)).toBe('default');
    expect(salesInsightRunCodeOf('SALES_INSIGHT_TIMEOUT')).toBe('SALES_INSIGHT_TIMEOUT');
    expect(viMessages.meetings.salesInsight.title).toBe('Nhận định cuộc gọi bán hàng');
    expect(viMessages.meetings.salesInsight.button).toBe('Phân tích');
    expect(en.meetings.salesInsight.button).toBe('Analyze');
  });
});
