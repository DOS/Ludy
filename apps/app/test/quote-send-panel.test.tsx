// SPDX-License-Identifier: AGPL-3.0-only
// The send panel of a quote (#2694, bug #2825): it sits inside the editor's <form>, so it must not be a form itself. A nested form's submit bubbles to the editor's
// save, which would run with the same version as the send and make one of them fail. This app's unit tests run without a DOM, so what is pinned here is the markup: no
// form, a plain button and the group's label. That a click sends once and Enter in the address box sends instead of saving is the component's code (sendNow).
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Quote } from '@crove/kernel-contract';
import { I18nProvider } from '../src/i18n/provider.tsx';
import { setActiveLocale } from '../src/i18n/runtime.ts';

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  const node = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop: string) => (prop === 'key' ? () => path : node([...path, prop])),
    });
  return { orpc: node([]), client: node([]), queryClient: new QC(), errorMessage: (e: unknown) => String(e) };
});

const { QuoteSendPanel } = await import('../src/components/quote-send.tsx');

const quote = { id: '00000000-0000-4000-8000-000000000001', version: 3, status: 'draft' } as unknown as Quote;

function render(dirty: boolean, wrapInForm = false): string {
  setActiveLocale('vi');
  const panel = <QuoteSendPanel quote={quote} dirty={dirty} onSent={() => undefined} />;
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider>{wrapInForm ? <form data-testid="quote-editor">{panel}</form> : panel}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe('the send panel inside the quote editor (#2825)', () => {
  it('is not a form: a form inside the editor form would submit the editor\'s save with the send', () => {
    const html = render(false);
    expect(html).not.toContain('<form');
    expect(html).toContain('data-testid="quote-send"');
    expect(html).toContain('role="group"');
  });

  it('sends with a plain button, never a submit button, and the editor around it stays the only form', () => {
    const html = render(false, true);
    expect(html.split('<form').length - 1).toBe(1);
    expect(html).not.toContain('type="submit"');
    expect(html).toContain('type="button"');
  });

  it('is not offered to send while the editor has unsaved changes', () => {
    const html = render(true);
    expect(html).toContain('Hãy lưu báo giá trước khi gửi.');
    expect(html).toMatch(/<button[^>]*disabled/);
    expect(render(false)).not.toContain('Hãy lưu báo giá trước khi gửi.');
  });
});
