// SPDX-License-Identifier: AGPL-3.0-only
// The shared minutes page (#4822), /-/minutes#<token>: rendered on the server from a seeded cache in Vietnamese and English. It shows the published minutes as text (never markup), one neutral
// refusal for a link that does not open, a wait and a retry for a too-busy answer, and its request keeps the token out of the address. This app's unit tests run without a DOM, so the effects
// (the robots tag) are tested through the small functions they call, with a stand-in document, and the page's own wiring is read from its source.
import { QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MinutesPage } from '@ludy/kernel-contract';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  return { errorMessage: (e: unknown) => String(e), queryClient: client.current };
});

const titles = vi.hoisted(() => [] as (string | null | undefined)[]);
vi.mock('../src/lib/screen-title.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useScreenTitle: (name: string | null | undefined) => void titles.push(name),
}));

const { MinutesPageView, MinutesPublicPage, minutesViewOf } = await import('../src/routes/minutes-page.tsx');
const { addNoindexMeta, copyText, loadMinutesPage, minutesShareUrl } = await import('../src/lib/minutes-link.ts');
const { ApiError } = await import('../src/lib/errors.ts');

const TOKEN = 'm'.repeat(43);
const page = (over: Partial<MinutesPage> = {}): MinutesPage => ({
  title: 'Họp giao ban tuần 47',
  startedAt: '2026-11-24T02:00:00.000Z',
  publishedAt: '2026-11-25T09:30:00.000Z',
  summary: 'Chốt báo giá tuần này.\nGiao hàng thứ sáu <b>không</b> đổi.',
  decisions: ['Giữ giá cũ', 'Dời họp sang thứ ba <script>alert(1)</script>'],
  actionItems: [
    { text: 'Gửi báo giá cho khách ABC', owner: 'An', due: '2026-11-28' },
    { text: 'Đặt lịch giao hàng', owner: '', due: 'thứ sáu' },
    { text: 'Kiểm tra kho', owner: 'Bình', due: null },
  ],
  orgName: 'Công ty TNHH Hoa Mai',
  ...over,
});

function renderPage(locale: 'vi' | 'en', data: MinutesPage | null | undefined): string {
  const qc = client.current;
  qc.clear();
  if (data !== undefined) qc.setQueryData(['minutes-page', TOKEN], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
        <MinutesPublicPage />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const view = (v: Parameters<typeof MinutesPageView>[0]['view'], locale: 'vi' | 'en' = 'vi', onRetry?: () => void) =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalog(locale)} timeZone="Asia/Ho_Chi_Minh">
      <MinutesPageView view={v} onRetry={onRetry} />
    </IntlProvider>,
  );

describe('the shared minutes page (#4822)', () => {
  const saved = (globalThis as { window?: unknown }).window;
  beforeAll(() => {
    (globalThis as { window?: unknown }).window = { location: { hash: `#${TOKEN}` }, localStorage: { getItem: () => null, setItem: () => undefined } };
  });
  afterAll(() => {
    (globalThis as { window?: unknown }).window = saved;
  });
  beforeEach(() => {
    client.current.clear();
    titles.length = 0;
  });

  it('shows who shared it, the title, the two dates, the summary, the decisions and the action items', () => {
    const html = renderPage('vi', page());
    expect(html).toContain('Biên bản do Công ty TNHH Hoa Mai chia sẻ');
    expect(html).toContain('>Họp giao ban tuần 47</h1>');
    // The dates in Vietnam time: 02:00 UTC on the 24th is the 24th there, 09:30 UTC on the 25th is the 25th.
    expect(html).toContain('Ngày họp: 24/11/2026');
    expect(html).toContain('Xuất bản ngày 25/11/2026');
    expect(html).toContain('Chốt báo giá tuần này.');
    expect(html).toContain('Giữ giá cũ');
    expect(html).toContain('Gửi báo giá cho khách ABC');
    expect(html).toContain('Người phụ trách: An');
    // A due day is formatted for the reader; free text stays as the recorder wrote it; no owner or no due leaves that part out.
    expect(html).toContain('Hạn: 28/11/2026');
    expect(html).toContain('Hạn: thứ sáu');
    expect(html).not.toContain('Người phụ trách: <');
    expect(html.match(/data-testid="minutes-action"/g)).toHaveLength(3);
    expect(titles).toContain('Họp giao ban tuần 47');
  });

  it('says it is read-only and offers print, not a form, an edit or an account', () => {
    const html = renderPage('vi', page());
    expect(html).toContain('data-testid="minutes-read-only"');
    expect(html).toContain('Đây là bản chỉ để xem');
    expect(html).toContain('In hoặc lưu PDF');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    // The notice and the button are not on paper.
    expect(html.slice(html.lastIndexOf('<p', html.indexOf('data-testid="minutes-read-only"')), html.indexOf('data-testid="minutes-read-only"'))).toContain('print:hidden');
  });

  it('shows every text as text, never as markup, and keeps the summary line breaks', () => {
    const html = renderPage('vi', page({ title: '<img src=x onerror=alert(1)>', orgName: '<b>Org</b>' }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;không&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Org&lt;/b&gt;');
    // The line break of the summary is in the text and the element keeps it on screen.
    const summary = html.slice(html.indexOf('data-testid="minutes-summary"'));
    expect(summary).toContain('Chốt báo giá tuần này.\nGiao hàng');
    expect(html.slice(html.lastIndexOf('<p', html.indexOf('data-testid="minutes-summary"')), html.indexOf('data-testid="minutes-summary"'))).toContain('whitespace-pre-line');
  });

  it('has a sentence for no decisions and no action items, and leaves out an empty summary', () => {
    const html = renderPage('vi', page({ summary: '  ', decisions: [], actionItems: [] }));
    expect(html).toContain('Không có quyết định nào được ghi.');
    expect(html).toContain('Không có việc nào được giao.');
    expect(html).not.toContain('data-testid="minutes-summary"');
    expect(renderPage('vi', page({ title: '' }))).toContain('Cuộc họp không có tên');
  });

  it('shows ONE neutral refusal for a link that does not open (404), or none shaped like a token', () => {
    const invalid = renderPage('vi', null);
    expect(invalid).toContain('data-testid="minutes-invalid"');
    expect(invalid).toContain(catalog('vi').minutesPage.invalid);
    expect(invalid).toContain(catalog('vi').minutesPage.invalidNext);
    expect(renderPage('en', null)).toContain(catalog('en').minutesPage.invalid);
    // The words do not say why (expired, revoked, never made, switched off): the reader cannot tell them apart.
    expect(catalog('vi').minutesPage.invalid).toContain('hết hạn');
    expect(minutesViewOf(null, { isLoading: false, error: null, data: undefined })).toEqual({ kind: 'invalid' });
    expect(view({ kind: 'invalid' })).not.toContain('minutes-error');
  });

  it('waits with a spinner while it loads', () => {
    const html = renderPage('vi', undefined);
    expect(html).toContain('aria-label="Đang tải"');
    expect(html).not.toContain('data-testid="minutes-invalid"');
    expect(html).not.toContain('data-testid="minutes-read-only"');
  });

  it('says to wait for a too-busy answer (429) and to try later for any other failure, each with a retry button', () => {
    const busy = view({ kind: 'rateLimited' }, 'vi', () => undefined);
    expect(busy).toContain('data-testid="minutes-rate-limited"');
    expect(busy).toContain(catalog('vi').minutesPage.rateLimited);
    expect(busy).toContain('Thử lại');
    expect(busy).toContain('min-h-11');
    const failed = view({ kind: 'error' }, 'en', () => undefined);
    expect(failed).toContain('data-testid="minutes-error"');
    expect(failed).toContain(catalog('en').minutesPage.error);
    expect(failed).not.toContain('data-testid="minutes-invalid"');
    // The state of the query as a view.
    const idle = { isLoading: false, data: undefined };
    expect(minutesViewOf(TOKEN, { ...idle, error: new ApiError('RATE_LIMITED', 429, null) })).toEqual({ kind: 'rateLimited' });
    expect(minutesViewOf(TOKEN, { ...idle, error: new ApiError('HTTP_500', 500, null) })).toEqual({ kind: 'error' });
    expect(minutesViewOf(TOKEN, { ...idle, error: new Error('network') })).toEqual({ kind: 'error' });
    expect(minutesViewOf(TOKEN, { isLoading: true, error: null, data: undefined })).toEqual({ kind: 'loading' });
    expect(minutesViewOf(TOKEN, { isLoading: false, error: null, data: null })).toEqual({ kind: 'invalid' });
    expect(minutesViewOf(TOKEN, { isLoading: false, error: null, data: page() })).toEqual({ kind: 'ok', page: page() });
  });

  it('follows the token of the hash: the cache is keyed by it, so another link shows other minutes', () => {
    const win = (globalThis as { window: { location: { hash: string } } }).window;
    const other = 'o'.repeat(43);
    win.location.hash = `#${other}`;
    try {
      client.current.setQueryData(['minutes-page', TOKEN], page({ title: 'Của liên kết thứ nhất' }));
      client.current.setQueryData(['minutes-page', other], page({ title: 'Của liên kết thứ hai' }));
      const html = renderToStaticMarkup(
        <QueryClientProvider client={client.current}>
          <IntlProvider locale="vi" messages={catalog('vi')}>
            <MinutesPublicPage />
          </IntlProvider>
        </QueryClientProvider>,
      );
      expect(html).toContain('Của liên kết thứ hai');
      expect(html).not.toContain('Của liên kết thứ nhất');
      // A hash that is not a token is the refusal, whatever is cached.
      win.location.hash = '#nope';
      expect(renderPage('vi', page())).toContain('data-testid="minutes-invalid"');
    } finally {
      win.location.hash = `#${TOKEN}`;
    }
  });

  it('speaks English too', () => {
    const html = renderPage('en', page());
    expect(html).toContain('Minutes shared by Công ty TNHH Hoa Mai');
    expect(html).toContain('Decisions');
    expect(html).toContain('Action items');
    expect(html).toContain('Owner: An');
    expect(html).toContain('Print or save as PDF');
  });

  it('asks search engines to keep it out of the index while it is open: the effect adds the tag and its cleanup removes it', () => {
    const source = readFileSync(new URL('../src/routes/minutes-page.tsx', import.meta.url), 'utf8');
    expect(source).toContain('useEffect(() => addNoindexMeta(document), [])');
    const head: unknown[] = [];
    let removed = 0;
    const doc = {
      createElement: () => ({ name: '', content: '', remove: () => void (removed += 1) }),
      head: { appendChild: (node: unknown) => void head.push(node) },
    };
    const remove = addNoindexMeta(doc);
    expect(head).toHaveLength(1);
    expect(head[0]).toMatchObject({ name: 'robots', content: 'noindex,nofollow' });
    expect(removed).toBe(0);
    remove();
    expect(removed).toBe(1);
  });
});

describe('the request of the shared minutes page (#4822)', () => {
  const answer = (status: number, body: unknown = {}) => vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

  it('posts the token in a JSON body with no cookie and no Referer, and never puts it in the address', async () => {
    const doFetch = answer(200, page());
    const result = await loadMinutesPage(TOKEN, doFetch as unknown as typeof fetch);
    expect(result).toEqual(page());
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0]!;
    expect(String(url)).toBe('/api/minutes/view');
    expect(String(url)).not.toContain(TOKEN);
    expect(String(url)).not.toContain('?');
    expect(String(url)).not.toContain('#');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(String(init?.body))).toEqual({ token: TOKEN });
  });

  it('answers null for the one refusal (404) and an error with its status for a too-busy or failed answer', async () => {
    expect(await loadMinutesPage(TOKEN, answer(404, { code: 'MINUTES_LINK_INVALID' }) as unknown as typeof fetch)).toBeNull();
    const busy = await loadMinutesPage(TOKEN, answer(429, { code: 'RATE_LIMITED', message: 'x' }) as unknown as typeof fetch).catch((e: unknown) => e);
    expect(busy).toBeInstanceOf(ApiError);
    expect(busy).toMatchObject({ status: 429, code: 'RATE_LIMITED' });
    const failed = await loadMinutesPage(TOKEN, answer(500, {}) as unknown as typeof fetch).catch((e: unknown) => e);
    expect(failed).toMatchObject({ status: 500 });
  });

  it('builds the address a recorder sends from where the app is and the path the command answered', () => {
    expect(minutesShareUrl('https://app.example.test', `/-/minutes#${TOKEN}`)).toBe(`https://app.example.test/-/minutes#${TOKEN}`);
    expect(minutesShareUrl('https://app.example.test/', `/-/minutes#${TOKEN}`)).toBe(`https://app.example.test/-/minutes#${TOKEN}`);
  });

  it('copies with the clipboard, falls back to the selected field, and says false when neither works', async () => {
    const written: string[] = [];
    expect(await copyText('x', { clipboard: { writeText: async (t) => void written.push(t) } })).toBe(true);
    expect(written).toEqual(['x']);
    const refusing = { writeText: () => Promise.reject(new Error('denied')) };
    expect(await copyText('x', { clipboard: refusing, execCopy: () => true })).toBe(true);
    expect(await copyText('x', { execCopy: () => true })).toBe(true);
    expect(await copyText('x', { clipboard: refusing, execCopy: () => false })).toBe(false);
    expect(await copyText('x', { clipboard: refusing, execCopy: () => { throw new Error('no'); } })).toBe(false);
    expect(await copyText('x', {})).toBe(false);
  });
});
