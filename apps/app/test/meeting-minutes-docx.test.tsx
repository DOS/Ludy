// SPDX-License-Identifier: AGPL-3.0-only
// "Tải về Word (.docx)" on the biên bản page (#4774): the button shows only when something is published (the server builds the file from the published rows and refuses otherwise), it is worded in Vietnamese
// and English, and the answer is saved as a file with the name the server gave, the bytes the server sent and the type of a Word file. Rendered on the server from the query cache, with no network.
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MINUTES_DOCX_MIME, type ActionItemView, type MeetingResults, type MinutesDocx } from '@ludy/kernel-contract';
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
  return { orpc: node([]), queryClient: client.current, errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)) };
});
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    useParams: () => ({ slug: 'acme', id: 'm1' }),
    useNavigate: () => vi.fn(),
    Link: ({ children, to, ...rest }: { children?: ReactNode; to: string } & Record<string, unknown>) => createElement('a', { href: to, ...rest }, children),
  };
});

const { MeetingMinutesPage } = await import('../src/routes/meeting-minutes.tsx');
const { bytesOfBase64, saveDocx } = await import('../src/components/meeting-minutes-docx.tsx');

const MEETING = {
  id: 'm1',
  title: 'Họp giao ban',
  startedAt: '2026-11-14T07:00:00.000Z',
  createdAt: '2026-11-14T06:59:00.000Z',
  endedAt: '2026-11-14T08:30:00.000Z',
  recorderUserId: 'u-rec',
  readers: [],
  summaryTemplate: 'general',
  place: null as string | null,
  minutesTemplate: null,
  isRecorder: true,
};
const published = { id: 'r1', feature: 'manual' as const, stage: 'published' as const, summary: 'Đã giao hàng.', decisions: ['Giữ giá cũ'], tainted: false };
const results = (over: Partial<MeetingResults>): MeetingResults => ({ meetingId: 'm1', isRecorder: true, draft: null, published: null, items: [], transcriptDraft: 0, transcriptUnread: 0, transcriptUnreadKey: '', ...over });

const page = (res: MeetingResults, locale: 'en' | 'vi' = 'en', meeting: typeof MEETING = MEETING) => {
  client.current.setQueryData(['meetings', 'get'], meeting);
  client.current.setQueryData(['meetings', 'results', 'get'], res);
  client.current.setQueryData(['org', 'get'], { name: 'Công ty A', role: 'owner', members: [{ userId: 'u-rec', displayName: 'Anh Nam', email: 'nam@example.com' }] });
  return renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <MeetingMinutesPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
};

beforeEach(() => client.current.clear());

describe('the button', () => {
  it('shows when something is published, and says what it gives', () => {
    const html = page(results({ published }));
    expect(html).toContain('data-testid="minutes-docx"');
    expect(html).toContain(en.meetings.minutes.docx);
    // Next to the print button, which stays.
    expect(html).toContain(en.meetings.minutes.print);
  });

  it('shows when only published action items are shared', () => {
    const item: ActionItemView = { id: 'i1', stage: 'published', status: 'suggested', title: 'Gửi báo giá', who: 'x', whoUserId: null, when: '', whenDate: null, transcriptSeconds: 1, flags: [], tainted: false, taskId: null, positions: [], clean: false, suggestion: null };
    expect(page(results({ items: [item] }))).toContain('data-testid="minutes-docx"');
  });

  it('is not there when nothing is published, even when the recorder has a draft', () => {
    expect(page(results({}))).not.toContain('data-testid="minutes-docx"');
    expect(page(results({ draft: { ...published, stage: 'draft' } }))).not.toContain('data-testid="minutes-docx"');
  });

  it('has Vietnamese words, and words for the refusal of a minutes nobody shared', () => {
    expect(page(results({ published }), 'vi')).toContain(viMessages.meetings.minutes.docx);
    expect(en.kernelErrors.codes.MINUTES_NOT_PUBLISHED).toBeTruthy();
    expect(viMessages.kernelErrors.codes.MINUTES_NOT_PUBLISHED).toBeTruthy();
    expect(en.kernelErrors.codes.MINUTES_VERSION_NOT_FOUND).toBeTruthy();
    expect(viMessages.kernelErrors.codes.MINUTES_VERSION_NOT_FOUND).toBeTruthy();
    expect(en.kernelErrors.codes.MINUTES_VERSION_STAGE).toBeTruthy();
    expect(viMessages.kernelErrors.codes.MINUTES_VERSION_STAGE).toBeTruthy();
  });

  it('shows a language selector with 44px touch targets only when a published vi/en minutes version exists (#5225)', () => {
    expect(page(results({ published }))).not.toContain('data-testid="minutes-docx-language"');

    client.current.clear();
    client.current.setQueryData(['meetings', 'minutesVersion', 'get'], {
      meetingId: 'm1',
      from: 'vi',
      versions: [{ language: 'zh', publishedAt: '2026-11-25T03:00:00.000Z', segments: [{ key: 'summary', text: '摘要' }] }],
    });
    expect(page(results({ published }))).not.toContain('data-testid="minutes-docx-language"');

    client.current.clear();
    client.current.setQueryData(['meetings', 'minutesVersion', 'get'], {
      meetingId: 'm1',
      from: 'vi',
      versions: [{ language: 'en', publishedAt: '2026-11-25T03:00:00.000Z', segments: [{ key: 'summary', text: 'Delivered.' }] }],
    });
    const html = page(results({ published }), 'en');
    expect(html).toContain('data-testid="minutes-docx-language"');
    expect(html).toContain('data-testid="minutes-docx-lang-original"');
    expect(html).toContain('data-testid="minutes-docx-lang-en"');
    expect(html).toContain('Original (Tiếng Việt)');
    expect(html).toContain('English');
    expect(html).toContain('min-h-11');

    client.current.clear();
    client.current.setQueryData(['meetings', 'minutesVersion', 'get'], {
      meetingId: 'm1',
      from: 'vi',
      versions: [{ language: 'en', publishedAt: '2026-11-25T03:00:00.000Z', segments: [{ key: 'summary', text: 'Delivered.' }] }],
    });
    const viHtml = page(results({ published }), 'vi');
    expect(viHtml).toContain('Bản gốc (Tiếng Việt)');
    expect(viHtml).toContain('English');

    client.current.clear();
    client.current.setQueryData(['meetings', 'minutesVersion', 'get'], {
      meetingId: 'm1',
      from: 'en',
      versions: [{ language: 'vi', publishedAt: '2026-11-25T03:00:00.000Z', segments: [{ key: 'summary', text: 'Đã giao.' }] }],
    });
    const enOrigHtml = page(results({ published }), 'en');
    expect(enOrigHtml).toContain('data-testid="minutes-docx-lang-vi"');
    expect(enOrigHtml).toContain('Original (English)');
    expect(enOrigHtml).toContain('Tiếng Việt');
  });
});

// The place the recorder saved for the meeting (#5013): the page's field starts from it, the recorder is told it is saved once and the readers see it, and a reader is told it is for printing only.
describe('the place of the meeting', () => {
  const field = (html: string) => /<input[^>]*id="minutes-place"[^>]*>/.exec(html)?.[0] ?? '';
  const sheetPlace = (html: string) => /data-testid="minutes-place">([^<]*)</.exec(html)?.[1];

  it('fills the field and the sheet from the saved place, and the recorder has no save button until the text changes', () => {
    const html = page(results({ published }), 'en', { ...MEETING, place: 'Phòng họp tầng 3' });
    expect(field(html)).toContain('value="Phòng họp tầng 3"');
    expect(sheetPlace(html)).toBe('Phòng họp tầng 3');
    expect(html).toContain(en.meetings.minutes.placeHintRecorder);
    expect(html).not.toContain(en.meetings.minutes.placeSave);
  });

  it('prints the dots when no place is saved', () => {
    const html = page(results({ published }));
    expect(field(html)).toContain('value=""');
    expect(sheetPlace(html)).toContain('……');
  });

  it('shows a reader the saved place, tells them it is for printing only, and gives them no save button', () => {
    const html = page(results({ published }), 'en', { ...MEETING, place: 'Văn phòng Đà Nẵng', isRecorder: false });
    expect(sheetPlace(html)).toBe('Văn phòng Đà Nẵng');
    expect(html).toContain(en.meetings.minutes.placeHint);
    expect(html).not.toContain(en.meetings.minutes.placeHintRecorder);
    expect(html).not.toContain(en.meetings.minutes.placeSave);
  });

  it('has Vietnamese words for the hints and the button', () => {
    expect(viMessages.meetings.minutes.placeHintRecorder.length).toBeGreaterThan(10);
    expect(viMessages.meetings.minutes.placeSave).toBeTruthy();
    expect(page(results({ published }), 'vi', { ...MEETING, place: 'Hà Nội' })).toContain(viMessages.meetings.minutes.placeHintRecorder);
  });
});

describe('saving the file', () => {
  const clicked: Array<{ href: string; download: string }> = [];
  const revoked: string[] = [];
  let blob: Blob | null = null;

  beforeEach(() => {
    clicked.length = 0;
    revoked.length = 0;
    blob = null;
    vi.useFakeTimers();
    vi.stubGlobal('URL', {
      createObjectURL: (b: Blob) => {
        blob = b;
        return 'blob:minutes';
      },
      revokeObjectURL: (u: string) => void revoked.push(u),
    });
    vi.stubGlobal('document', {
      createElement: () => {
        const link = { href: '', download: '', click: () => clicked.push({ href: link.href, download: link.download }), remove: () => undefined };
        return link;
      },
      body: { appendChild: () => undefined },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reads base64 into the bytes it stands for', () => {
    expect([...bytesOfBase64(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 255]).toString('base64'))]).toEqual([0x50, 0x4b, 0x03, 0x04, 0, 255]);
    expect(bytesOfBase64('').length).toBe(0);
  });

  it('saves the answer under the name the server gave, with the bytes and the Word type, and lets the address go', async () => {
    const file: MinutesDocx = { filename: 'Biên bản họp - Họp giao ban - 2026-11-14.docx', mimeType: MINUTES_DOCX_MIME, bytes: 4, contentBase64: Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString('base64') };
    saveDocx(file);
    expect(clicked).toEqual([{ href: 'blob:minutes', download: 'Biên bản họp - Họp giao ban - 2026-11-14.docx' }]);
    // The address is let go of a moment later, not before the browser has started the save.
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(revoked).toEqual(['blob:minutes']);
    const saved = blob as unknown as Blob;
    expect(saved.type).toBe(MINUTES_DOCX_MIME);
    expect([...new Uint8Array(await saved.arrayBuffer())]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });
});
