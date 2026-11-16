// SPDX-License-Identifier: AGPL-3.0-only
// Pure-JS PDF canvas renderer built on unpdf/pdfjs with zero .wasm binaries and zero Worker threads (#3325).
// Because unpdf/pdfjs binds WorkerMessageHandler in-process and we disable WASM and eval/font-face injection,
// rendering satisfies Ludy's zero-wasm image guard and strict CSP / Trusted Types headers.

export interface PdfPageSize {
  readonly width: number;
  readonly height: number;
}

export interface PdfDocumentHandle {
  readonly pageCount: number;
  getPageSize(pageNumber: number): Promise<PdfPageSize>;
  renderPage(pageNumber: number, canvas: HTMLCanvasElement, scale: number, signal?: AbortSignal): Promise<PdfPageSize>;
  destroy(): Promise<void>;
}

export const PDF_UNSUPPORTED_IMAGE_DECODER_ERROR = 'PDF_UNSUPPORTED_IMAGE_DECODER';

const UNSUPPORTED_IMAGE_FILTER_PATTERN =
  /\/Filter\s*(?:\[[^\]]{0,256}?)?\/(?:CCITTFaxDecode|CCF|JBIG2Decode|JPXDecode)(?=[^A-Za-z0-9_]|$)/;

export function looksLikePdfBytes(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 5) return false;
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

export function hasUnsupportedPdfImageFilter(bytes: Uint8Array): boolean {
  // Scan Latin-1 text of PDF objects/streams for scanned-image filters that require WASM in pdf.js
  // (e.g., ImageMask + CCITTFaxDecode is silently dropped by unpdf's ignoreErrors pipeline).
  return UNSUPPORTED_IMAGE_FILTER_PATTERN.test(new TextDecoder('latin1').decode(bytes));
}

function extractImageObjId(args: unknown): string | null {
  if (!Array.isArray(args) || args.length === 0) return null;
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object' && 'data' in first) {
    const data = (first as { data?: unknown }).data;
    if (typeof data === 'string') return data;
  }
  return null;
}

export function hasUnresolvedImageOperators(
  operatorList: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> },
  imageOpCodes: ReadonlySet<number>,
  stores: {
    objs: { has(id: string): boolean; get(id: string): unknown };
    commonObjs: { has(id: string): boolean; get(id: string): unknown };
  },
): boolean {
  for (let i = 0; i < operatorList.fnArray.length; i += 1) {
    const op = operatorList.fnArray[i];
    if (op === undefined || !imageOpCodes.has(op)) continue;
    const objId = extractImageObjId(operatorList.argsArray[i]);
    if (!objId) continue;
    const primary = objId.startsWith('g_') ? stores.commonObjs : stores.objs;
    const fallback = objId.startsWith('g_') ? stores.objs : stores.commonObjs;
    const store = primary.has(objId) ? primary : fallback.has(objId) ? fallback : null;
    if (!store || store.get(objId) == null) {
      return true;
    }
  }
  return false;
}

async function openPdfDocument(rawBytes: Uint8Array | ArrayBuffer) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes.slice() : new Uint8Array(rawBytes.slice(0));
  if (!looksLikePdfBytes(bytes)) {
    throw new Error('INVALID_PDF_HEADER');
  }

  const pdfjs = await import('unpdf/pdfjs');
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useWasm: false,
    useWorkerFetch: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    enableXfa: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  });

  const doc = await loadingTask.promise;
  return { pdfjs, loadingTask, doc };
}

export const SIGN_AI_MAX_PAGE_CHARS = 250_000;
// Leave generous headroom below /api/rpc/*'s 1 MiB body limit for oRPC envelope framing and UTF-8 / JSON escaping.
export const SIGN_AI_MAX_PAGES_JSON_BYTES = 768 * 1024;

function trimBeforeSplitSurrogate(text: string, end: number): string {
  let limit = Math.min(end, text.length);
  if (limit > 0) {
    const code = text.charCodeAt(limit - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      limit -= 1;
    }
  }
  return text.slice(0, limit).trimEnd();
}

export function budgetPdfPagesForAi(
  rawPages: ReadonlyArray<{ page: number; text: string }>,
  maxJsonBytes = SIGN_AI_MAX_PAGES_JSON_BYTES,
): Array<{ page: number; text: string }> {
  const encoder = new TextEncoder();
  const result: Array<{ page: number; text: string }> = [];
  let usedBytes = 2; // '[' and ']'

  for (const entry of rawPages) {
    const clipped = entry.text.trim().slice(0, SIGN_AI_MAX_PAGE_CHARS);
    if (!clipped) continue;
    const separator = result.length > 0 ? 1 : 0;
    const itemBytes = encoder.encode(JSON.stringify({ page: entry.page, text: clipped })).byteLength;
    if (usedBytes + separator + itemBytes <= maxJsonBytes) {
      result.push({ page: entry.page, text: clipped });
      usedBytes += separator + itemBytes;
      continue;
    }

    const availableForItem = maxJsonBytes - usedBytes - separator;
    let lo = 0;
    let hi = clipped.length;
    let best = '';
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const candidate = trimBeforeSplitSurrogate(clipped, mid);
      const bytes = encoder.encode(JSON.stringify({ page: entry.page, text: candidate })).byteLength;
      if (bytes <= availableForItem) {
        best = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best.length > 0) {
      result.push({ page: entry.page, text: best });
    }
    break;
  }

  return result;
}

export async function extractPdfPagesText(rawBytes: Uint8Array | ArrayBuffer): Promise<Array<{ page: number; text: string }>> {
  const { loadingTask, doc } = await openPdfDocument(rawBytes);
  try {
    const pages: Array<{ page: number; text: string }> = [];
    const maxPages = Math.min(doc.numPages, 200);
    const encoder = new TextEncoder();
    let usedBytes = 2;
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      try {
        const textContent = await page.getTextContent();
        const text = textContent.items
          .map((item) => ('str' in item && typeof item.str === 'string' ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, SIGN_AI_MAX_PAGE_CHARS);
        if (text.length > 0) {
          pages.push({ page: pageNumber, text });
          usedBytes += encoder.encode(JSON.stringify({ page: pageNumber, text })).byteLength + 1;
          if (usedBytes >= SIGN_AI_MAX_PAGES_JSON_BYTES) {
            break;
          }
        }
      } finally {
        page.cleanup();
      }
    }
    return budgetPdfPagesForAi(pages, SIGN_AI_MAX_PAGES_JSON_BYTES);
  } finally {
    await doc.cleanup();
    await loadingTask.destroy();
  }
}

export async function loadPdfDocument(rawBytes: Uint8Array | ArrayBuffer): Promise<PdfDocumentHandle> {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  if (!looksLikePdfBytes(bytes)) {
    throw new Error('INVALID_PDF_HEADER');
  }
  if (hasUnsupportedPdfImageFilter(bytes)) {
    throw new Error(PDF_UNSUPPORTED_IMAGE_DECODER_ERROR);
  }
  const { pdfjs, loadingTask, doc } = await openPdfDocument(bytes);

  return {
    pageCount: doc.numPages,

    async getPageSize(pageNumber: number): Promise<PdfPageSize> {
      const page = await doc.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        return { width: viewport.width, height: viewport.height };
      } finally {
        page.cleanup?.();
      }
    },

    async renderPage(pageNumber: number, canvas: HTMLCanvasElement, scale: number, signal?: AbortSignal): Promise<PdfPageSize> {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const page = await doc.getPage(pageNumber);
      try {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const viewport = page.getViewport({ scale });
        const dpr = typeof window !== 'undefined' ? Math.min(Math.max(window.devicePixelRatio || 1, 1), 2) : 1;
        const pixelWidth = Math.max(1, Math.floor(viewport.width * dpr));
        const pixelHeight = Math.max(1, Math.floor(viewport.height * dpr));

        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('CANVAS_2D_UNAVAILABLE');
        }

        const renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          annotationMode: pdfjs.AnnotationMode.ENABLE,
          ...(dpr !== 1 ? { transform: [dpr, 0, 0, dpr, 0, 0] } : {}),
        });

        const onAbort = () => {
          renderTask.cancel();
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await renderTask.promise;
        } catch (error) {
          if (error instanceof pdfjs.RenderingCancelledException) {
            throw new DOMException('Cancelled', 'AbortError');
          }
          throw error;
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }

        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const operatorList = await page.getOperatorList();
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const imageOps = new Set<number>([
          pdfjs.OPS.paintImageXObject,
          pdfjs.OPS.paintImageXObjectRepeat,
          pdfjs.OPS.paintImageMaskXObject,
          pdfjs.OPS.paintImageMaskXObjectRepeat,
        ]);
        if (hasUnresolvedImageOperators(operatorList, imageOps, page)) {
          throw new Error(PDF_UNSUPPORTED_IMAGE_DECODER_ERROR);
        }

        return { width: viewport.width, height: viewport.height };
      } finally {
        page.cleanup();
      }
    },

    async destroy(): Promise<void> {
      await doc.cleanup();
      await loadingTask.destroy();
    },
  };
}
