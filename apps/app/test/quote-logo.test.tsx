// SPDX-License-Identifier: AGPL-3.0-only
// The logo control of the quote settings (#2814): this app's unit tests run without a DOM, so what is pinned here is the rule a chosen image is checked by before it is sent (the
// server checks it again) and the markup: a choose button with none, change and remove buttons with one, plain buttons only (the control sits inside the settings form, whose
// Enter and submit are the save of the other fields), and the hint with the size the server allows.
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { QUOTE_LOGO_MAX_BYTES } from '@crove/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => (prop === 'key' ? () => path : node([...path, prop])),
    });
  return { orpc: node([]), client: node([]), queryClient: new QC(), errorMessage: (e: unknown) => String(e), fetchFile: async () => new Blob(), uploadFiles: async () => ({ files: [] }) };
});

const { QuoteLogoField, logoProblem } = await import('../src/components/quote-logo.tsx');

function render(fileId: string | null, locale: 'vi' | 'en' = 'vi'): string {
  setActiveLocale(locale);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>
        <QuoteLogoField fileId={fileId} />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the logo of the quote letterhead (#2814)', () => {
  it('accepts a PNG or a JPEG within the size the server allows, and says what is wrong with anything else', () => {
    expect(logoProblem({ type: 'image/png', size: 1 })).toBeNull();
    expect(logoProblem({ type: 'image/jpeg', size: QUOTE_LOGO_MAX_BYTES })).toBeNull();
    expect(logoProblem({ type: 'image/jpeg', size: QUOTE_LOGO_MAX_BYTES + 1 })).toBe('size');
    for (const type of ['image/webp', 'image/gif', 'image/svg+xml', 'application/pdf', '']) expect(logoProblem({ type, size: 10 })).toBe('type');
  });

  it('offers to choose a logo when there is none, and to change or remove it when there is one', () => {
    const none = render(null);
    expect(none).toContain('data-testid="quote-logo"');
    expect(none).toContain('Chọn logo');
    expect(none).not.toContain('Gỡ logo');
    expect(none).not.toContain('<img');
    const some = render('00000000-0000-4000-8000-000000000001');
    expect(some).toContain('Đổi logo');
    expect(some).toContain('Gỡ logo');
  });

  it('only takes PNG and JPEG in the file box, never submits the form around it, and states the size limit', () => {
    const html = render(null);
    expect(html).toContain('accept="image/png,image/jpeg"');
    expect(html).not.toContain('type="submit"');
    expect(html).toContain(`${QUOTE_LOGO_MAX_BYTES / 1024} KB`);
    expect(render(null, 'en')).toContain('Choose a logo');
  });
});
