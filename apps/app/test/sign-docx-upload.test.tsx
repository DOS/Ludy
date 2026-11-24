// SPDX-License-Identifier: AGPL-3.0-only
// Frontend .docx upload validation, 202 polling, and calm Vietnamese warning banner tests (#4721).
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';

vi.mock('../src/lib/auth.ts', () => ({
  accessToken: vi.fn(async () => 'test-token'),
  afterMfaRefusal: vi.fn(),
  auth: vi.fn(),
  getConfig: vi.fn(() => ({ uploads: 'local' })),
  secondFactorStillOwed: vi.fn(async () => false),
}));

vi.mock('../src/lib/api-base.ts', () => ({
  apiUrl: (path: string) => `http://localhost${path}`,
  serverOrigin: () => 'http://localhost',
}));

vi.mock('@ludy/ui/components/dialog', async () => {
  const { createElement } = await import('react');
  const wrap =
    (tag: string) =>
    ({ children }: { children?: ReactNode }) =>
      createElement(tag, null, children);
  return {
    Dialog: wrap('div'),
    DialogContent: wrap('div'),
    DialogDescription: wrap('p'),
    DialogFooter: wrap('div'),
    DialogHeader: wrap('div'),
    DialogTitle: wrap('h2'),
  };
});

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const { createElement } = await import('react');
  return {
    ...(await importOriginal<object>()),
    Link: ({ children, to }: { children?: ReactNode; to: string }) => createElement('a', { href: to }, children),
    useParams: () => ({ slug: 'acme' }),
    useNavigate: () => vi.fn(),
  };
});

const { DocxConversionNotice, DocxWarningsAlert, inspectSelectedSignUploadFile } = await import(
  '../src/components/sign/docx-conversion-notice.tsx'
);
const { catalog } = await import('../src/i18n/runtime.ts');
const { SIGN_DOCX_MAX_BYTES, SIGN_DOCX_MIME, SIGN_UPLOAD_ACCEPT, convertSignDocx } = await import(
  '../src/lib/sign-api.ts'
);
const { queryClient } = await import('../src/lib/api.ts');
const { CreateEnvelopeDialog } = await import('../src/routes/sign-envelopes.tsx');
const { CreateTemplateForm } = await import('../src/routes/sign-templates.tsx');

function makeTestFile(bytes: Uint8Array, name: string, type = ''): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('eSign .docx client upload and UI components (#4721)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('validates .pdf vs .docx headers, OLE2 refusal, and 10 MB cap', async () => {
    const zipDocx = makeTestFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), 'Hop dong.docx', SIGN_DOCX_MIME);
    expect(await inspectSelectedSignUploadFile(zipDocx)).toEqual({
      ok: true,
      kind: 'docx',
      fallbackTitle: 'Hop dong',
    });

    const pdfFile = makeTestFile(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]), 'Contract.pdf', 'application/pdf');
    expect(await inspectSelectedSignUploadFile(pdfFile)).toEqual({
      ok: true,
      kind: 'pdf',
      fallbackTitle: 'Contract',
    });

    const ole2Docx = makeTestFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), 'encrypted.docx', SIGN_DOCX_MIME);
    expect(await inspectSelectedSignUploadFile(ole2Docx)).toEqual({
      ok: false,
      errorKey: 'docxOle2Unsupported',
    });

    const legacyDoc = makeTestFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), 'old.doc', 'application/msword');
    expect(await inspectSelectedSignUploadFile(legacyDoc)).toEqual({
      ok: false,
      errorKey: 'docxOle2Unsupported',
    });

    const emptyDocx = makeTestFile(new Uint8Array(0), 'empty.docx', SIGN_DOCX_MIME);
    expect(await inspectSelectedSignUploadFile(emptyDocx)).toEqual({
      ok: false,
      errorKey: 'docxEmpty',
    });

    const fakeOverSized = new File([new Uint8Array(SIGN_DOCX_MAX_BYTES + 1)], 'huge.docx', { type: SIGN_DOCX_MIME });
    expect(await inspectSelectedSignUploadFile(fakeOverSized)).toEqual({
      ok: false,
      errorKey: 'docxTooLarge',
    });
  });

  it('polls 202 pending responses on convertSignDocx until completed', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (calls.length === 1) {
        return new Response(JSON.stringify({ status: 'pending', jobId: 'job-docx-1' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          status: 'completed',
          fileId: '01900000-0000-7000-8000-0000000000aa',
          filename: 'hop-dong.pdf',
          pageCount: 2,
          sourceDocxSha256: 'a'.repeat(64),
          warnings: ['images_skipped'],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = makeTestFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), 'hop-dong.docx', SIGN_DOCX_MIME);
    const result = await convertSignDocx(file, 'acme');
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('/api/sign/convert-docx');
    expect(calls[1]).toContain('/api/sign/convert-docx/job-docx-1');
    expect(result).toEqual({
      status: 'completed',
      fileId: '01900000-0000-7000-8000-0000000000aa',
      filename: 'hop-dong.pdf',
      pageCount: 2,
      sourceDocxSha256: 'a'.repeat(64),
      warnings: ['images_skipped'],
    });
  });

  it('renders .pdf/.docx accept attribute, converting indicator, and calm Vietnamese warning banner', () => {
    const tplHtml = renderToStaticMarkup(
      <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
        <CreateTemplateForm
          title="Hop dong dich vu"
          description=""
          routingMode="parallel"
          subject=""
          message=""
          file={makeTestFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'hop-dong.docx', SIGN_DOCX_MIME)}
          error={null}
          pending={false}
          docxStatus="ready"
          docxResult={{
            status: 'completed',
            fileId: '01900000-0000-7000-8000-0000000000bb',
            filename: 'hop-dong.pdf',
            pageCount: 3,
            sourceDocxSha256: 'b'.repeat(64),
            warnings: ['floating_shapes_skipped', 'images_skipped'],
          }}
          onChangeTitle={() => {}}
          onChangeDescription={() => {}}
          onChangeRoutingMode={() => {}}
          onChangeSubject={() => {}}
          onChangeMessage={() => {}}
          onChangeFile={() => {}}
          onSubmit={() => {}}
        />
      </IntlProvider>,
    );
    expect(tplHtml).toContain(`accept="${SIGN_UPLOAD_ACCEPT}"`);
    expect(tplHtml).toContain('data-testid="sign-docx-warning-banner"');
    expect(tplHtml).toContain('Đã chuyển đổi từ .docx; vui lòng kiểm tra lại bố cục trang PDF trước khi gửi ký');

    const convertingHtml = renderToStaticMarkup(
      <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
        <DocxConversionNotice status="converting" result={null} />
      </IntlProvider>,
    );
    expect(convertingHtml).toContain('data-testid="sign-docx-converting"');
    expect(convertingHtml).toContain('Đang chuyển đổi tệp Word (.docx) sang PDF A4...');

    const dismissibleAlert = renderToStaticMarkup(
      <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
        <DocxWarningsAlert warnings={['images_skipped', 'footnotes_skipped']} onDismiss={() => {}} />
      </IntlProvider>,
    );
    expect(dismissibleAlert).toContain('aria-label="Đóng"');
    expect(dismissibleAlert).toContain('min-h-11 min-w-11');
    expect(dismissibleAlert).toContain('aria-hidden="true"');
    expect(dismissibleAlert).toContain('footnote/endnote');

    const envHtml = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
          <CreateEnvelopeDialog onClose={() => {}} onCreated={() => {}} />
        </IntlProvider>
      </QueryClientProvider>,
    );
    expect(envHtml).toContain(`accept="${SIGN_UPLOAD_ACCEPT}"`);

    const tplErrorHtml = renderToStaticMarkup(
      <IntlProvider locale="vi" timeZone="Asia/Ho_Chi_Minh" messages={catalog('vi')}>
        <CreateTemplateForm
          title="Hop dong dich vu"
          description=""
          routingMode="parallel"
          subject=""
          message=""
          file={null}
          error="Tệp .docx được bảo vệ bằng mật khẩu hoặc là định dạng Word cũ (.doc)"
          pending={false}
          inspecting={true}
          docxStatus="error"
          docxResult={null}
          onChangeTitle={() => {}}
          onChangeDescription={() => {}}
          onChangeRoutingMode={() => {}}
          onChangeSubject={() => {}}
          onChangeMessage={() => {}}
          onChangeFile={() => {}}
          onSubmit={() => {}}
        />
      </IntlProvider>,
    );
    expect(tplErrorHtml).toContain('role="alert"');
    expect(tplErrorHtml).toContain('Tệp .docx được bảo vệ bằng mật khẩu hoặc là định dạng Word cũ (.doc)');
    expect(tplErrorHtml).toContain('disabled=""');
  });

  it('bounds poll fetches with a deadline AbortSignal and maps AbortError to timeout', async () => {
    vi.useFakeTimers();
    let seenPollSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/sign/convert-docx')) {
        return new Response(JSON.stringify({ status: 'pending', jobId: 'job-abort-1' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      seenPollSignal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        if (init?.signal?.aborted) {
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = makeTestFile(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2]), 'slow.docx', SIGN_DOCX_MIME);
    const caught = convertSignDocx(file, 'acme').then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(46_000);
    expect(await caught).toMatchObject({ name: 'ClientError', message: 'sign.docxTimedOut' });
    expect(seenPollSignal).toBeDefined();
    expect(seenPollSignal?.aborted).toBe(true);
  });
});
