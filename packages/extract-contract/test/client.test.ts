// The worker's crove-extract client: every answer is untrusted, so anything malformed, oversized, for the wrong
// kind or late is refused with ExtractServiceError (retried by the job); file-caused failures come back typed.
import { describe, expect, it } from 'vitest';
import {
  DOCX_TO_PDF_WARNINGS,
  EXTRACT_LIMITS,
  ExtractServiceError,
  PdfEmbedCmsInputError,
  PdfSealInputError,
  createExtractClient,
  decodePdfEmbedCmsInput,
  decodePdfSealInput,
  encodePdfEmbedCmsInput,
  encodePdfSealInput,
  maxRequestBytes,
  zDocxToPdfResult,
  zDocxToPdfWarning,
  zExtractResponse,
  zPdfEmbedCmsInput,
  zPdfEmbedCmsResult,
  zPdfInspectResult,
  zPdfSealInput,
  zPdfSealResult,
  type ExtractClient,
  type PdfEmbedCmsInput,
  type PdfSealInput,
} from '../src/index.ts';

const invoice = {
  source: 'einvoice_xml',
  invoiceType: null,
  template: '1',
  series: 'C26TAB',
  number: '1234',
  issueDate: '2026-09-15',
  currency: 'VND',
  exchangeRate: null,
  paymentMethod: null,
  seller: { name: 'Seller', taxCode: '0102030406', address: null, email: null, phone: null },
  buyer: { name: 'Buyer', taxCode: null, address: null, email: null, phone: null },
  lines: [
    { lineNo: 1, nature: 'goods', code: null, description: 'x', unit: null, quantity: '1', unitPrice: '100', amount: '100', vatRate: '10%' },
  ],
  taxBreakdown: [],
  subtotal: '100',
  vatTotal: '10',
  total: '110',
  totalInWords: null,
  taxAuthorityCode: null,
  hasSignature: false,
};

type Seen = { url: string; init: RequestInit | undefined };

function clientAnswering(body: unknown, status = 200, options: { maxResponseBytes?: number; headers?: Record<string, string> } = {}) {
  const seen: Seen[] = [];
  const client = createExtractClient({
    url: 'http://crove-extract:8090',
    ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
    fetch: async (input, init) => {
      seen.push({ url: String(input), init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...options.headers },
      });
    },
  });
  return { client, seen };
}

const bytes = new TextEncoder().encode('<HDon/>');

async function serviceError(client: ExtractClient, kind: 'einvoice_xml' | 'pdf_text' | 'mime' = 'einvoice_xml') {
  const error = await client.extract(kind, bytes).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExtractServiceError);
  return error as ExtractServiceError;
}

describe('crove-extract client', () => {
  it('posts the raw bytes for one kind, refuses redirects and returns a validated result', async () => {
    const { client, seen } = clientAnswering({ ok: true, kind: 'einvoice_xml', invoice });
    const result = await client.extract('einvoice_xml', bytes);
    expect(result).toMatchObject({ ok: true, invoice: { total: '110' } });
    expect(seen[0]?.url).toBe('http://crove-extract:8090/extract?kind=einvoice_xml');
    expect(seen[0]?.init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(new Uint8Array(seen[0]?.init?.body as ArrayBuffer)).toEqual(bytes);
  });

  it('accepts the invoice a replacement or an adjustment corrects, and refuses a malformed one (#916)', async () => {
    const related = { kind: 'replacement', template: '1', series: 'C26TAB', number: '1200', issueDate: '2026-09-01', note: null };
    const { client } = clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, related } });
    expect(await client.extract('einvoice_xml', bytes)).toMatchObject({ ok: true, invoice: { related } });
    for (const bad of [{ ...related, kind: 'cancel' }, { ...related, extra: 'x' }, { ...related, number: 1200 }]) {
      const answer = clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, related: bad } });
      expect((await serviceError(answer.client)).reason).toBe('malformed');
    }
  });

  it('returns failures caused by the file as typed results', async () => {
    const { client } = clientAnswering({ ok: false, code: 'invalid', message: 'XML chứa DOCTYPE/ENTITY, bị từ chối' }, 422);
    expect(await client.extract('einvoice_xml', bytes)).toEqual({ ok: false, code: 'invalid', message: 'XML chứa DOCTYPE/ENTITY, bị từ chối' });
    const { client: timeout } = clientAnswering({ ok: false, code: 'timeout', message: 'slow' }, 422);
    expect(await timeout.extract('pdf_text', bytes)).toMatchObject({ code: 'timeout' });
  });

  it('refuses a file over the limit without calling the service', async () => {
    const { client, seen } = clientAnswering({ ok: true, kind: 'pdf_text', text: '', pages: 0 });
    expect(await client.extract('pdf_text', new Uint8Array(EXTRACT_LIMITS.maxFileBytes + 1))).toMatchObject({ ok: false, code: 'too_large' });
    expect(seen).toHaveLength(0);
  });

  it('throws on service failures, so the job is retried', async () => {
    expect((await serviceError(clientAnswering({ ok: false, code: 'busy', message: 'busy' }, 503).client)).reason).toBe('unavailable');
    expect((await serviceError(clientAnswering({ ok: false, code: 'internal', message: 'x' }, 500).client)).reason).toBe('unavailable');
    const unreachable = createExtractClient({
      url: 'http://crove-extract:8090',
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect((await serviceError(unreachable)).reason).toBe('unreachable');
  });

  it('rejects malformed answers: not JSON, unknown keys, wrong types, oversized fields, wrong kind or status', async () => {
    const malformed = [
      clientAnswering('<html>proxy error</html>', 502),
      clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, injected: 'x' } }),
      clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, total: 110 } }),
      clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, total: '1e9' } }),
      clientAnswering({ ok: true, kind: 'einvoice_xml', invoice: { ...invoice, number: 'x'.repeat(EXTRACT_LIMITS.maxStringChars + 1) } }),
      clientAnswering({ ok: true, kind: 'pdf_text', text: 'x', pages: 1 }),
      clientAnswering({ ok: true, kind: 'einvoice_xml', invoice }, 201),
      clientAnswering({ ok: false, code: 'invalid', message: 'x' }, 200),
      clientAnswering({ ok: false, code: 'invalid', message: 'x'.repeat(EXTRACT_LIMITS.maxErrorChars + 1) }, 422),
    ];
    for (const { client } of malformed) expect((await serviceError(client)).reason).toBe('malformed');
    const badAttachment = clientAnswering({
      ok: true,
      kind: 'mime',
      email: { messageId: null, from: null, subject: null, deliveredTo: null, to: [], attachments: [{ filename: 'a', content: 'not base64!' }] },
    });
    expect((await serviceError(badAttachment.client, 'mime')).reason).toBe('malformed');
  });

  it('rejects an answer over the size limit, declared or streamed', async () => {
    const declared = clientAnswering({ ok: true, kind: 'einvoice_xml', invoice }, 200, { maxResponseBytes: 64 });
    expect((await serviceError(declared.client)).reason).toBe('response_too_large');
    const streamed = createExtractClient({
      url: 'http://crove-extract:8090',
      maxResponseBytes: 1024,
      fetch: async () => {
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1;
            if (sent > 1000) controller.close();
            else controller.enqueue(new Uint8Array(512).fill(0x20));
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    expect((await serviceError(streamed)).reason).toBe('response_too_large');
  });

  it('gives up at the time limit', async () => {
    const hanging = createExtractClient({
      url: 'http://crove-extract:8090',
      timeoutMs: 50,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    const started = Date.now();
    const error = await serviceError(hanging);
    expect(error.reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('accepts only http(s) URLs', () => {
    expect(() => createExtractClient({ url: 'file:///etc/passwd' })).toThrow(/http/);
  });
});

// #2119: the worker runs several extract jobs at once; the client never has more calls in flight than its slots.
describe('crove-extract client concurrency (#2119)', () => {
  function slowClient(concurrency: number | undefined) {
    const state = { inFlight: 0, max: 0, calls: 0 };
    const client = createExtractClient({
      url: 'http://crove-extract:8090',
      ...(concurrency === undefined ? {} : { concurrency }),
      fetch: async () => {
        state.calls += 1;
        state.inFlight += 1;
        state.max = Math.max(state.max, state.inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        state.inFlight -= 1;
        return new Response(JSON.stringify({ ok: false, code: 'invalid', message: 'x' }), { status: 422, headers: { 'content-type': 'application/json' } });
      },
    });
    return { client, state };
  }

  it.each([
    [undefined, 1],
    [1, 1],
    [3, 3],
    [8, 8],
  ])('keeps at most its slots in flight and uses them all (concurrency %s)', async (concurrency, slots) => {
    const { client, state } = slowClient(concurrency);
    expect(client.concurrency).toBe(slots);
    const results = await Promise.all(Array.from({ length: slots * 3 + 1 }, () => client.extract('einvoice_xml', bytes)));
    expect(results).toHaveLength(slots * 3 + 1);
    expect(state.calls).toBe(slots * 3 + 1);
    expect(state.max).toBe(slots);
  });

  it('gives a slot back after a failed call, so one failure cannot stall the rest', async () => {
    let n = 0;
    const client = createExtractClient({
      url: 'http://crove-extract:8090',
      concurrency: 1,
      fetch: async () => {
        n += 1;
        if (n === 1) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({ ok: false, code: 'invalid', message: 'x' }), { status: 422, headers: { 'content-type': 'application/json' } });
      },
    });
    const [first, second] = await Promise.allSettled([client.extract('einvoice_xml', bytes), client.extract('einvoice_xml', bytes)]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
  });

  it('refuses a concurrency that is not a whole number of at least 1', () => {
    for (const concurrency of [0, -1, 1.5, Number.NaN]) expect(() => createExtractClient({ url: 'http://crove-extract:8090', concurrency })).toThrow(/concurrency/);
  });

  it('caps pdf_inspect at maxFileBytes and pdf_seal at maxPdfSealRequestBytes to absorb base64 growth', () => {
    expect(maxRequestBytes('pdf_inspect')).toBe(EXTRACT_LIMITS.maxFileBytes);
    expect(maxRequestBytes('pdf_seal')).toBe(EXTRACT_LIMITS.maxPdfSealRequestBytes);
    expect(EXTRACT_LIMITS.maxPdfSealRequestBytes).toBeGreaterThan(Math.ceil(EXTRACT_LIMITS.maxFileBytes / 3) * 4);
  });

  it('validates pdf_inspect results strictly (page order, 64 KiB text cap, unknown keys)', () => {
    const valid = zPdfInspectResult.safeParse({
      ok: true,
      kind: 'pdf_inspect',
      pageCount: 2,
      pages: [
        { page: 1, widthPt: 595.28, heightPt: 841.89, rotation: 0, text: 'Trang 1' },
        { page: 2, widthPt: 841.89, heightPt: 595.28, rotation: 90, text: 'Trang 2' },
      ],
    });
    expect(valid.success).toBe(true);

    const outOfOrder = zPdfInspectResult.safeParse({
      ok: true,
      kind: 'pdf_inspect',
      pageCount: 2,
      pages: [
        { page: 2, widthPt: 595.28, heightPt: 841.89, rotation: 0, text: 'Trang 2' },
        { page: 1, widthPt: 595.28, heightPt: 841.89, rotation: 0, text: 'Trang 1' },
      ],
    });
    expect(outOfOrder.success).toBe(false);

    const oversizedUtf8 = zPdfInspectResult.safeParse({
      ok: true,
      kind: 'pdf_inspect',
      pageCount: 2,
      pages: [
        { page: 1, widthPt: 595.28, heightPt: 841.89, rotation: 0, text: 'đ'.repeat(20_000) },
        { page: 2, widthPt: 595.28, heightPt: 841.89, rotation: 0, text: 'đ'.repeat(20_000) },
      ],
    });
    expect(oversizedUtf8.success).toBe(false);

    const extraKey = zPdfInspectResult.safeParse({
      ok: true,
      kind: 'pdf_inspect',
      pageCount: 1,
      pages: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0, text: 'ok', extra: true }],
    });
    expect(extraKey.success).toBe(false);
  });

  it('round-trips encodePdfSealInput and decodePdfSealInput and enforces input bounds', () => {
    const sha = 'a'.repeat(64);
    const input: PdfSealInput = {
      pdfBase64: Buffer.from('%PDF-1.7\n').toString('base64'),
      fields: [
        { type: 'signature', page: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.3, hNorm: 0.1, imagePngBase64: 'iVBORw0KGgo=' },
        { type: 'initial', page: 1, xNorm: 0.5, yNorm: 0.7, wNorm: 0.15, hNorm: 0.08, text: 'NVA', fontSizePt: 12 },
        { type: 'date', page: 1, xNorm: 0.1, yNorm: 0.85, wNorm: 0.25, hNorm: 0.05, text: '15/11/2026' },
        { type: 'text', page: 1, xNorm: 0.4, yNorm: 0.85, wNorm: 0.4, hNorm: 0.05, text: 'Nguyễn Văn Ánh' },
        { type: 'checkbox', page: 1, xNorm: 0.85, yNorm: 0.85, wNorm: 0.04, hNorm: 0.04, checked: true },
      ],
      certificate: {
        certificateCode: 'CROVE-ESIGN-2026-0001',
        envelopeTitle: 'Hợp đồng dịch vụ kế toán 2026',
        sourceSha256: sha,
        completedAtIso: '2026-11-15T10:30:00.000Z',
        eventChainTipHash: 'b'.repeat(64),
        signers: [
          {
            name: 'Nguyễn Văn Ánh',
            roleLabel: 'Bên A - Giám đốc',
            maskedEmail: 'n***@example.vn',
            deliveryMode: 'email',
            otpStatus: 'verified',
            signedAtIso: '2026-11-15T10:29:00.000Z',
            ipHashPrefix: 'deadbeef1234',
            signatureKind: 'draw',
          },
          {
            name: 'Trần Thị Bình',
            roleLabel: 'Bên B',
            maskedEmail: null,
            deliveryMode: 'link',
            otpStatus: 'not_required',
            signedAtIso: '2026-11-15T10:30:00.000Z',
            ipHashPrefix: null,
          },
        ],
      },
    };

    const bytes = encodePdfSealInput(input);
    const decoded = decodePdfSealInput(bytes);
    expect(decoded).toEqual(input);

    // Coordinate outside [0, 1] box
    expect(
      zPdfSealInput.safeParse({
        ...input,
        fields: [{ type: 'checkbox', page: 1, xNorm: 0.8, yNorm: 0.1, wNorm: 0.3, hNorm: 0.1, checked: true }],
      }).success,
    ).toBe(false);

    // Initial field without image or text
    expect(
      zPdfSealInput.safeParse({
        ...input,
        fields: [{ type: 'initial', page: 1, xNorm: 0.1, yNorm: 0.1, wNorm: 0.1, hNorm: 0.1 }],
      }).success,
    ).toBe(false);

    // Bad sha256
    expect(
      zPdfSealInput.safeParse({
        ...input,
        certificate: { ...input.certificate, sourceSha256: 'NOT_HEX' },
      }).success,
    ).toBe(false);

    expect(() => decodePdfSealInput(new Uint8Array(0))).toThrow(PdfSealInputError);
    expect(() => decodePdfSealInput(new TextEncoder().encode('{bad json'))).toThrow(PdfSealInputError);
    expect(() => decodePdfSealInput(new TextEncoder().encode(JSON.stringify({ ...input, extra: 1 })))).toThrow(PdfSealInputError);
    expect(() => decodePdfSealInput(new Uint8Array(EXTRACT_LIMITS.maxPdfSealRequestBytes + 1))).toThrow(PdfSealInputError);

    // A 20 MiB raw PDF grows to ~26.7 MiB in base64 and still fits inside maxRequestBytes('pdf_seal').
    const largePdfInput: PdfSealInput = {
      ...input,
      pdfBase64: Buffer.alloc(20 * 1024 * 1024, 0x25).toString('base64'),
    };
    const largeEncoded = encodePdfSealInput(largePdfInput);
    expect(largeEncoded.byteLength).toBeGreaterThan(EXTRACT_LIMITS.maxFileBytes);
    expect(largeEncoded.byteLength).toBeLessThanOrEqual(maxRequestBytes('pdf_seal'));
    expect(decodePdfSealInput(largeEncoded).certificate.certificateCode).toBe(input.certificate.certificateCode);

    expect(
      zPdfSealResult.safeParse({
        ok: true,
        kind: 'pdf_seal',
        sealedPdfBase64: Buffer.from('%PDF-1.7\n').toString('base64'),
        pageCount: 2,
      }).success,
    ).toBe(true);

    const maxCertTotalPages = EXTRACT_LIMITS.maxPdfSignPages + EXTRACT_LIMITS.maxPdfAuditCertPages;
    expect(
      zPdfSealResult.safeParse({
        ok: true,
        kind: 'pdf_seal',
        sealedPdfBase64: Buffer.from('%PDF-1.7\n').toString('base64'),
        pageCount: maxCertTotalPages,
      }).success,
    ).toBe(true);
    expect(
      zPdfSealResult.safeParse({
        ok: true,
        kind: 'pdf_seal',
        sealedPdfBase64: Buffer.from('%PDF-1.7\n').toString('base64'),
        pageCount: maxCertTotalPages + 1,
      }).success,
    ).toBe(false);

    const maxPdfBase64Chars = Math.ceil(EXTRACT_LIMITS.maxFileBytes / 3) * 4;
    expect(
      zPdfSealResult.safeParse({
        ok: true,
        kind: 'pdf_seal',
        sealedPdfBase64: 'A'.repeat(maxPdfBase64Chars + 4),
        pageCount: 2,
      }).success,
    ).toBe(false);
  });

  it('validates pdf_embed_cms limits, input round-trip, and result ByteRange bounds', () => {
    expect(maxRequestBytes('pdf_embed_cms')).toBe(EXTRACT_LIMITS.maxPdfEmbedCmsRequestBytes);
    const input: PdfEmbedCmsInput = {
      pdfBase64: Buffer.from('%PDF-1.4\n').toString('base64'),
      cmsDerBase64: Buffer.from(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01])).toString('base64'),
      signerName: 'Nguyễn Văn Ánh',
      reason: 'Ký hợp đồng dịch vụ',
      location: 'Hà Nội',
      signedAtIso: '2026-11-16T10:00:00.000Z',
      subFilter: 'ETSI.CAdES.detached',
      placeholderBytes: 8192,
    };
    const encoded = encodePdfEmbedCmsInput(input);
    expect(decodePdfEmbedCmsInput(encoded)).toEqual(input);

    expect(zPdfEmbedCmsInput.safeParse({ ...input, signerName: '   ' }).success).toBe(false);
    expect(zPdfEmbedCmsInput.safeParse({ ...input, fieldName: 'bad/name' }).success).toBe(false);
    expect(zPdfEmbedCmsInput.safeParse({ ...input, fieldName: 'Group.Signature2' }).success).toBe(false);
    expect(zPdfEmbedCmsInput.safeParse({ ...input, placeholderBytes: 16 }).success).toBe(false);
    expect(zPdfEmbedCmsInput.safeParse({ ...input, extra: true }).success).toBe(false);

    expect(() => decodePdfEmbedCmsInput(new Uint8Array(0))).toThrow(PdfEmbedCmsInputError);
    expect(() => decodePdfEmbedCmsInput(new TextEncoder().encode('{bad'))).toThrow(PdfEmbedCmsInputError);
    expect(() => decodePdfEmbedCmsInput(new Uint8Array(EXTRACT_LIMITS.maxPdfEmbedCmsRequestBytes + 1))).toThrow(
      PdfEmbedCmsInputError,
    );

    expect(
      zPdfEmbedCmsResult.safeParse({
        ok: true,
        kind: 'pdf_embed_cms',
        pdfBase64: Buffer.from('%PDF-1.4\n').toString('base64'),
        signedSha256: 'a'.repeat(64),
        byteRange: [0, 200, 1200, 300],
      }).success,
    ).toBe(true);

    expect(
      zPdfEmbedCmsResult.safeParse({
        ok: true,
        kind: 'pdf_embed_cms',
        pdfBase64: Buffer.from('%PDF-1.4\n').toString('base64'),
        signedSha256: 'a'.repeat(64),
        byteRange: [0, 1200, 1200, 300],
      }).success,
    ).toBe(false);
  });

  it('validates docx_to_pdf request cap, result schema, warnings, and client dispatch', async () => {
    expect(maxRequestBytes('docx_to_pdf')).toBe(EXTRACT_LIMITS.maxSignDocxBytes);
    expect(EXTRACT_LIMITS.maxSignDocxBytes).toBe(10 * 1024 * 1024);
    expect(EXTRACT_LIMITS.maxFileBytes).toBe(25 * 1024 * 1024);
    expect(DOCX_TO_PDF_WARNINGS).toEqual([
      'floating_shapes_skipped',
      'ole_objects_skipped',
      'complex_columns_simplified',
      'images_skipped',
      'headers_footers_simplified',
      'footnotes_skipped',
    ]);

    const pdfBase64 = Buffer.from('%PDF-1.7\n').toString('base64');
    const valid = {
      ok: true,
      kind: 'docx_to_pdf',
      pdfBase64,
      pageCount: 3,
      warnings: ['images_skipped', 'headers_footers_simplified'],
    };
    expect(zDocxToPdfResult.safeParse(valid).success).toBe(true);
    expect(zExtractResponse.safeParse(valid).success).toBe(true);
    expect(zDocxToPdfWarning.safeParse('unknown_warning').success).toBe(false);
    expect(zDocxToPdfResult.safeParse({ ...valid, pageCount: 0 }).success).toBe(false);
    expect(zDocxToPdfResult.safeParse({ ...valid, pageCount: 201 }).success).toBe(false);
    expect(zDocxToPdfResult.safeParse({ ...valid, pdfBase64: '' }).success).toBe(false);
    expect(zDocxToPdfResult.safeParse({ ...valid, warnings: Array(7).fill('images_skipped') }).success).toBe(false);
    expect(zDocxToPdfResult.safeParse({ ...valid, extra: 1 }).success).toBe(false);

    const client = createExtractClient({
      url: 'http://extract.internal',
      fetch: async () =>
        new Response(JSON.stringify(valid), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const tooLarge = await client.extract('docx_to_pdf', new Uint8Array(EXTRACT_LIMITS.maxSignDocxBytes + 1));
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) expect(tooLarge.code).toBe('too_large');

    const res = await client.extract('docx_to_pdf', new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    expect(res).toEqual(valid);
  });
});
