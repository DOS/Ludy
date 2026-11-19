// SPDX-License-Identifier: AGPL-3.0-only
// The machine translation of a meeting's transcript on its page (meetings integrations E2, #3185): the button names the other language and the expected cost, the progress reads "Đã dịch
// 12/20 phần", a spent budget reads "Chờ ngân sách AI", a running translation offers a stop, and each line carries its translation as a second line labelled as a machine translation,
// with a fixed word for a line code refused, a mark for a line code doubts and a note for a line that changed since. Rendered on the server from the query cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { TranscriptTranslationStatus } from '@crove/kernel-contract';
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

const { TranscriptTranslationPanel, TranslatedLine } = await import('../src/components/meeting-transcript-translation.tsx');

const STATUS: TranscriptTranslationStatus = {
  meetingId: 'm1',
  stage: 'published',
  enabled: true,
  reason: null,
  from: 'vi',
  targets: ['en'],
  to: 'en',
  lines: 144,
  translated: 0,
  stale: 0,
  remaining: 144,
  chunksTotal: 20,
  chunksDone: 0,
  state: 'none',
  runId: null,
  errorCode: null,
  estimate: { calls: 20, inputTokens: 26000, outputTokens: 21000, cost: '0.0123' },
};
const METER = { aiOn: true, state: 'ok', percent: 10, scope: null, resetAt: '2026-12-01T00:00:00Z' };

function render(opts: { status?: Partial<TranscriptTranslationStatus>; meter?: Record<string, unknown>; locale?: 'en' | 'vi'; onTarget?: boolean } = {}) {
  client.current.clear();
  client.current.setQueryData(['meetings', 'translation', 'transcriptStatus'], { ...STATUS, ...opts.status });
  client.current.setQueryData(['ai', 'meter'], { ...METER, ...opts.meter });
  const locale = opts.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <TranscriptTranslationPanel meetingId="m1" {...(opts.onTarget ? { onTarget: () => undefined } : {})} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}
const renderLine = (part: Parameters<typeof TranslatedLine>[0]['part'], locale: 'en' | 'vi' = 'en') =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)}>
      <TranslatedLine part={part} to="en" />
    </IntlProvider>,
  );

describe('the transcript translation panel', () => {
  it('shows nothing before the server answered', () => {
    client.current.clear();
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client.current}>
        <IntlProvider locale="en" messages={catalog('en')}>
          <TranscriptTranslationPanel meetingId="m1" />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(html).toBe('');
  });

  it('offers the translation into the other language with the calls and the cost expected before the click', () => {
    const html = render();
    expect(html).toContain('Translate to English');
    expect(html).toContain('20 Vy calls');
    expect(html).not.toContain('translation-blocked');
    expect(render({ status: { to: 'vi', from: 'en' }, locale: 'vi' })).toContain('Dịch sang tiếng Việt');
    // No price set in the deployment: the calls without a figure.
    expect(render({ status: { estimate: { calls: 20, inputTokens: 1, outputTokens: 1, cost: null } } })).toMatch(/20 Vy calls\.</);
  });

  it('reads the progress in parts, as "Đã dịch 12/20 phần", and offers to go on', () => {
    const html = render({ locale: 'vi', status: { translated: 86, remaining: 58, chunksDone: 12, state: 'ready' } });
    expect(html).toContain('Đã dịch 12/20 phần');
    expect(html).toContain('Dịch tiếp');
    expect(render({ status: { translated: 86, remaining: 58, chunksDone: 12, state: 'ready' } })).toContain('Translated 12/20 parts');
  });

  it('says why it cannot be pressed: the switch, nothing to translate, no model, and a spent budget as "Chờ ngân sách AI"', () => {
    expect(render({ status: { enabled: false, reason: 'off' }, locale: 'vi' })).toContain('chưa bật tính năng Vy dịch');
    expect(render({ status: { enabled: false, reason: 'nothing', lines: 0, remaining: 0, chunksTotal: 0, stage: null, estimate: null }, locale: 'vi' })).toContain('Chưa có bản ghi lời để dịch');
    expect(render({ meter: { aiOn: false, state: 'none' }, locale: 'vi' })).toContain('chưa có mô hình AI');
    const spent = render({ meter: { aiOn: true, state: 'stop' }, locale: 'vi', status: { translated: 86, remaining: 58, chunksDone: 12, state: 'ready' } });
    expect(spent).toContain('Chờ ngân sách AI');
    expect(spent).toContain('disabled');
  });

  it('keeps the parts and says so when a run failed for the budget, and words a run that ended or was stopped', () => {
    const failed = render({ locale: 'vi', status: { translated: 86, remaining: 58, chunksDone: 12, state: 'failed', errorCode: 'AI_BUDGET_EXHAUSTED' } });
    expect(failed).toContain('Chờ ngân sách AI');
    expect(failed).toContain('Các phần đã dịch vẫn giữ');
    expect(render({ status: { state: 'failed', errorCode: 'RUN_CANCELLED' } })).toContain('The run was stopped');
    expect(render({ status: { state: 'failed', errorCode: 'SOMETHING_ELSE' } })).toContain('Something went wrong');
  });

  it('offers a stop while a run goes, and says it is done when every line is translated', () => {
    const running = render({ status: { state: 'running', runId: 'r1' } });
    expect(running).toContain('Stop translating');
    expect(running).toContain('Vy is translating');
    expect(running).not.toContain('Translate to English');
    const done = render({ status: { translated: 144, remaining: 0, chunksDone: 20, state: 'ready' } });
    expect(done).toContain('Fully translated');
    expect(done).not.toContain('Translate to English');
  });

  it('notes the lines edited after they were translated, and says the translation is private and no source of anything', () => {
    const html = render({ status: { translated: 80, stale: 3, remaining: 3, chunksDone: 19, state: 'ready' } });
    expect(html).toContain('3 lines were edited after they were translated');
    expect(html).toContain('Only you can see this translation');
  });
});

describe('a translated line', () => {
  it('shows the translation under the original with its label, and a mark for each doubt', () => {
    const html = renderLine({ lineId: 'l1', text: 'Agreed 1,250,000 for customer A', state: 'warn', codes: ['NAME_ADDED'], stale: false });
    expect(html).toContain('Machine translation');
    expect(html).toContain('Agreed 1,250,000 for customer A');
    expect(html).toContain('translation-mark');
    expect(html).toContain('A name may differ from the original');
    expect(html).toContain('lang="en"');
    expect(html).not.toContain('Out of date');
  });

  it('shows only the fixed word for a refused line and the old note for a stale one', () => {
    const refused = renderLine({ lineId: 'l2', text: '', state: 'refused', codes: ['INVENTED_NUMBER'], stale: false }, 'vi');
    expect(refused).toContain('Bản dịch máy');
    expect(refused).toContain('không dịch được dòng này');
    const stale = renderLine({ lineId: 'l3', text: 'Old text', state: 'ok', codes: [], stale: true }, 'vi');
    expect(stale).toContain('Bản dịch cũ, dịch lại');
  });
});

describe('the language picker of the transcript panel (E3, #3186)', () => {
  it('shows it only where the server offers more than the other language of the pair and the page can take a choice, and words the button for the language shown', () => {
    expect(render({ status: { targets: ['en'] }, onTarget: true })).not.toContain('data-testid="translation-target"');
    // Without a handler (the panel used on its own) there is nothing to pick into.
    expect(render({ status: { to: 'ja', targets: ['en', 'ja'] } })).not.toContain('data-testid="translation-target"');
    for (const locale of ['en', 'vi'] as const) {
      const messages = locale === 'en' ? en : viMessages;
      const html = render({ status: { to: 'ja', targets: ['en', 'ja'] }, locale, onTarget: true });
      expect(html, locale).toContain('data-testid="translation-target"');
      expect(html, locale).toContain('日本語');
      expect(html, locale).toContain(messages.meetings.translationTargets.to.replace('{language}', '日本語'));
    }
  });

  it('tags a translated line with its own language, Chinese as Simplified', () => {
    const line = (to: string) =>
      renderToStaticMarkup(
        <IntlProvider locale="en" messages={catalog('en')}>
          <TranslatedLine part={{ lineId: 'l1', text: '你好', state: 'ok', codes: [], stale: false }} to={to} />
        </IntlProvider>,
      );
    expect(line('zh')).toContain('lang="zh-Hans"');
    expect(line('ko')).toContain('lang="ko"');
  });
});
