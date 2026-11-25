// SPDX-License-Identifier: AGPL-3.0-only
// "Tải bản ghi lời về" on the transcript card (#4817), in English and Vietnamese: a button for each format with a 44 px target on a phone, a label for the group, the note that the file is made
// on the server without AI, and the saving of the file the server sends back (its name, bytes and type; the address let go later). Rendered on the server.
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalog } from '../src/i18n/runtime.ts';

const client = vi.hoisted(() => ({ current: null as unknown as import('@tanstack/react-query').QueryClient }));

vi.mock('../src/lib/api.ts', async () => {
  const { QueryClient: QC } = await import('@tanstack/react-query');
  client.current = new QC();
  return { orpc: {}, queryClient: client.current, errorMessage: String };
});

const { TranscriptExport } = await import('../src/components/meeting-transcript-export.tsx');
const { bytesOfBase64, saveBase64File } = await import('../src/lib/save-file.ts');

const render = (locale: 'en' | 'vi') =>
  renderToStaticMarkup(
    <QueryClientProvider client={client.current}>
      <IntlProvider locale={locale} messages={catalog(locale)}>
        <TranscriptExport meetingId="0198a0b4-3c5d-7e6f-8a9b-0c1d2e3f4a5b" />
      </IntlProvider>
    </QueryClientProvider>,
  );

describe('the transcript export buttons', () => {
  it('offers text and SRT in English, with a label for the group and the note that no AI is used', () => {
    const html = render('en');
    expect(html).toContain('data-testid="transcript-export-txt"');
    expect(html).toContain('data-testid="transcript-export-srt"');
    expect(html).toContain('Text (.txt)');
    expect(html).toContain('Captions (.srt)');
    expect(html).toContain('Word (.docx)');
    expect(html).toContain('data-testid="transcript-export-docx"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Download the transcript"');
    expect(html).toContain('No AI.');
  });

  it('says the same in Vietnamese, and each button is 44 px tall on a phone', () => {
    const html = render('vi');
    expect(html).toContain('Tải bản ghi lời về');
    expect(html).toContain('Văn bản (.txt)');
    expect(html).toContain('Phụ đề (.srt)');
    expect(html).toContain('Word (.docx)');
    expect(html).toContain('Không dùng AI.');
    // The small button is 44 px tall below the md breakpoint (the Button's own rule).
    expect(html.match(/max-md:min-h-11/gu)).toHaveLength(3);
  });
});

describe('saving the file the server sent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reads the bytes of the base64 text, Vietnamese letters included', () => {
    const text = '[00:00:05] Hà: Chào\n';
    expect(new TextDecoder().decode(bytesOfBase64(Buffer.from(text, 'utf8').toString('base64')))).toBe(text);
  });

  it('saves it under the server\'s name and type, and lets go of the address a moment later', () => {
    vi.useFakeTimers();
    const clicked: { href: string; download: string }[] = [];
    const created: Blob[] = [];
    const revoked: string[] = [];
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return 'blob:test';
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    });
    vi.stubGlobal('document', {
      createElement: () => ({
        href: '',
        download: '',
        click() {
          clicked.push({ href: this.href, download: this.download });
        },
        remove() {},
      }),
      body: { appendChild() {} },
    });
    saveBase64File({ filename: 'Bản ghi - Họp - 2026-11-15.srt', mimeType: 'application/x-subrip; charset=utf-8', contentBase64: Buffer.from('1\n', 'utf8').toString('base64') });
    expect(clicked).toEqual([{ href: 'blob:test', download: 'Bản ghi - Họp - 2026-11-15.srt' }]);
    expect(created[0]?.type).toBe('application/x-subrip; charset=utf-8');
    expect(created[0]?.size).toBe(2);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(revoked).toEqual(['blob:test']);
  });
});
