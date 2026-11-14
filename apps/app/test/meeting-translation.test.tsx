// SPDX-License-Identifier: AGPL-3.0-only
// The machine translation of a meeting's summary on its page (meetings integrations E1, #3184): the button names the other language and the expected cost, says why it cannot be
// pressed (no model, a spent budget, nothing to translate, the switch), and the translation sits beside the original labelled as a machine translation, with a fixed word for a line
// code refused, a mark for a line code doubts and a note for a translation of an original that changed since. Rendered on the server from the query cache.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { describe, expect, it, vi } from 'vitest';
import type { TranslationStatus, Translations } from '@crove/kernel-contract';
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

const { MeetingTranslation, translateBlocked } = await import('../src/components/meeting-translation.tsx');

const ITEM_ID = '0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b';
const ORIGINAL = { summary: 'Chốt giá 1.250.000 cho khách A.', decisions: ['Giữ giá cũ'], items: [{ id: ITEM_ID, title: 'Gửi báo giá cho khách' }] };
const STATUS: TranslationStatus = { meetingId: 'm1', stage: 'published', enabled: true, reason: null, from: 'vi', to: 'en', estimate: { inputTokens: 500, outputTokens: 400, cost: '0.0123' } };
const METER = { aiOn: true, state: 'ok', percent: 10, scope: null, resetAt: '2026-12-01T00:00:00Z' };
const translations = (over: Partial<Translations['translations'][number]> = {}): Translations => ({
  meetingId: 'm1',
  translations: [
    {
      stage: 'published',
      from: 'vi',
      to: 'en',
      stale: false,
      createdAt: '2026-11-14 10:00:00+00',
      segments: [
        { key: 'summary', text: 'Agreed on 1,250,000 for customer A.', state: 'ok', codes: [] },
        { key: 'decision:0', text: 'Keep the old price', state: 'warn', codes: ['NAME_ADDED'] },
        { key: `item:${ITEM_ID}`, text: '', state: 'refused', codes: ['INVENTED_NUMBER'] },
      ],
      ...over,
    },
  ],
});

function render(opts: { status?: Partial<TranslationStatus> | null; meter?: Record<string, unknown>; mine?: Translations | null; locale?: 'en' | 'vi' } = {}) {
  client.current.clear();
  if (opts.status !== null) client.current.setQueryData(['meetings', 'translation', 'status'], { ...STATUS, ...opts.status });
  client.current.setQueryData(['ai', 'meter'], { ...METER, ...opts.meter });
  if (opts.mine) client.current.setQueryData(['meetings', 'translation', 'get'], opts.mine);
  const locale = opts.locale ?? 'en';
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MeetingTranslation meetingId="m1" stage="published" original={ORIGINAL} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('translateBlocked', () => {
  it('says why in order: no status, the switch, nothing to translate, no model, a spent budget; and null when it can be pressed', () => {
    expect(translateBlocked(undefined, undefined)).toBe('off');
    expect(translateBlocked({ enabled: false, reason: 'off' }, undefined)).toBe('off');
    expect(translateBlocked({ enabled: false, reason: 'nothing' }, undefined)).toBe('nothing');
    expect(translateBlocked({ enabled: true, reason: null }, { aiOn: false, state: 'none' })).toBe('noModel');
    expect(translateBlocked({ enabled: true, reason: null }, { aiOn: true, state: 'stop' })).toBe('budget');
    expect(translateBlocked({ enabled: true, reason: null }, { aiOn: true, state: 'warn' })).toBeNull();
    expect(translateBlocked({ enabled: true, reason: null }, undefined)).toBeNull();
  });
});

describe('MeetingTranslation', () => {
  it('shows nothing until the server has answered', () => {
    expect(render({ status: null })).toBe('');
  });

  it('offers the other language, the expected cost and says what it is for', () => {
    const html = render();
    expect(html).toContain(en.meetings.results.translation.toEnglish);
    expect(html).toContain('Estimated cost: 0.0123');
    expect(html).toContain(en.meetings.results.translation.desc);
    expect(html).not.toContain('data-testid="translation-blocked"');
    expect(render({ status: { to: 'vi' }, locale: 'vi' })).toContain(viMessages.meetings.results.translation.toVietnamese);
    // No price set: no figure rather than a guess.
    expect(render({ status: { estimate: { inputTokens: 500, outputTokens: 400, cost: null } } })).not.toContain('Estimated cost');
  });

  it('disables the button and says why when AI is off, the budget is spent, there is nothing to translate or the switch is off', () => {
    for (const [opts, key] of [
      [{ meter: { aiOn: false, state: 'none' } }, 'noModel'],
      [{ meter: { state: 'stop' } }, 'budget'],
      [{ status: { enabled: false, reason: 'nothing' } }, 'nothing'],
      [{ status: { enabled: false, reason: 'off' } }, 'off'],
    ] as const) {
      const html = render(opts);
      expect(html, key).toContain('data-testid="translation-blocked"');
      expect(html, key).toContain(en.meetings.results.translation.blocked[key]);
      expect(/<button[^>]*>(?:(?!<\/button>).)*<\/button>/.exec(html)?.[0], key).toMatch(/\sdisabled(=|\s|>)/);
      expect(html, key).not.toContain('Estimated cost');
    }
    expect(render({ meter: { state: 'stop' }, locale: 'vi' })).toContain('Chờ ngân sách AI');
  });

  it('shows the translation beside the original, labelled, with a mark for a doubted line and the original with a fixed word for a refused one', () => {
    const html = render({ mine: translations() });
    expect(html).toContain('data-testid="translation-block"');
    expect(html).toContain(en.meetings.results.translation.label);
    expect(html).toContain('Agreed on 1,250,000 for customer A.');
    expect(html).toContain('Keep the old price');
    expect(html).toContain(en.meetings.results.translation.marks.NAME_ADDED);
    // A refused line: the original shows, with the fixed word, and no model text.
    expect(html).toContain('Gửi báo giá cho khách');
    expect(html).toContain(en.meetings.results.translation.refused);
    expect(html).toContain(en.meetings.results.translation.private);
    expect(html).not.toContain(en.meetings.results.translation.stale);
    // The Vietnamese words of the plan.
    const vi = render({ mine: translations(), locale: 'vi' });
    expect(vi).toContain('Bản dịch máy');
    expect(vi).toContain('không dịch được dòng này');
    expect(vi).toContain('Tên riêng có thể khác bản gốc');
  });

  it('marks a translation of an original that changed since as out of date and offers to translate again', () => {
    const html = render({ mine: translations({ stale: true }) });
    expect(html).toContain(en.meetings.results.translation.stale);
    expect(html).toContain(en.meetings.results.translation.again);
    expect(render({ mine: translations({ stale: true }), locale: 'vi' })).toContain('Bản dịch cũ, dịch lại');
  });

  it('keeps a translation the member already has even when translating is now off, and offers no new one', () => {
    const html = render({ status: { enabled: false, reason: 'off' }, mine: translations() });
    expect(html).toContain('data-testid="translation-block"');
    expect(html).toContain(en.meetings.results.translation.blocked.off);
  });
});
