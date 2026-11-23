// SPDX-License-Identifier: AGPL-3.0-only
// Multi-page pure-JS PDF canvas viewer with an exact normalized [0..1] overlay frame (#3325).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { loadPdfDocument, PDF_UNSUPPORTED_IMAGE_DECODER_ERROR, type PdfDocumentHandle } from '../../lib/sign-pdf.ts';
import { ErrorText, RowsSkeleton } from '../ui.tsx';

export interface PdfCanvasViewerProps {
  pdfBytes: Uint8Array | null;
  pageNumber: number;
  pageCount: number;
  scale: number;
  onPageChange: (nextPage: number) => void;
  onScaleChange: (nextScale: number) => void;
  onPageCountDetected?: (count: number) => void;
  onRenderStatusChange?: (status: { rendered: boolean; error: string | null }) => void;
  onSurfaceClick?: (pageNumber: number, xNorm: number, yNorm: number) => void;
  renderOverlay?: (pageNumber: number) => ReactNode;
  className?: string;
}

const MIN_SCALE = 0.6;
const MAX_SCALE = 2.0;

export interface RenderedPdfTarget {
  doc: PdfDocumentHandle;
  page: number;
  scale: number;
}

export function isCurrentPdfTargetRendered(params: {
  pdfBytes: Uint8Array | null;
  doc: PdfDocumentHandle | null;
  pageSize: { width: number; height: number } | null;
  loadingDoc: boolean;
  renderingPage: boolean;
  renderError: string | null;
  renderedTarget: RenderedPdfTarget | null;
  safePage: number;
  scale: number;
}): boolean {
  const { pdfBytes, doc, pageSize, loadingDoc, renderingPage, renderError, renderedTarget, safePage, scale } = params;
  const targetMatches =
    renderedTarget !== null &&
    doc !== null &&
    renderedTarget.doc === doc &&
    renderedTarget.page === safePage &&
    renderedTarget.scale === scale;
  return Boolean(
    pdfBytes &&
      pdfBytes.byteLength > 0 &&
      doc &&
      pageSize &&
      !loadingDoc &&
      !renderingPage &&
      targetMatches &&
      !renderError,
  );
}

export function PdfCanvasViewer({
  pdfBytes,
  pageNumber,
  pageCount,
  scale,
  onPageChange,
  onScaleChange,
  onPageCountDetected,
  onRenderStatusChange,
  onSurfaceClick,
  renderOverlay,
  className,
}: PdfCanvasViewerProps) {
  const t = useTranslations('sign.fields');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [doc, setDoc] = useState<PdfDocumentHandle | null>(null);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [renderingPage, setRenderingPage] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [renderedTarget, setRenderedTarget] = useState<RenderedPdfTarget | null>(null);

  useEffect(() => {
    if (!pdfBytes || pdfBytes.byteLength === 0) {
      setDoc(null);
      setPageSize(null);
      setRenderedTarget(null);
      setRenderError(null);
      setLoadingDoc(false);
      return;
    }
    let cancelled = false;
    let loadedHandle: PdfDocumentHandle | null = null;
    setDoc(null);
    setPageSize(null);
    setRenderedTarget(null);
    setLoadingDoc(true);
    setRenderError(null);

    loadPdfDocument(pdfBytes)
      .then((handle) => {
        if (cancelled) {
          void handle.destroy();
          return;
        }
        loadedHandle = handle;
        setDoc(handle);
        onPageCountDetected?.(handle.pageCount);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRenderError(error instanceof Error ? error.message : 'PDF_RENDER_FAILED');
      })
      .finally(() => {
        if (!cancelled) setLoadingDoc(false);
      });

    return () => {
      cancelled = true;
      if (loadedHandle) {
        void loadedHandle.destroy();
      }
    };
  }, [pdfBytes, onPageCountDetected]);

  const effectiveTotal = Math.max(1, doc?.pageCount ?? pageCount);
  const safePage = Math.min(effectiveTotal, Math.max(1, pageNumber));

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    const controller = new AbortController();
    setRenderingPage(true);
    setRenderedTarget(null);

    doc
      .renderPage(safePage, canvasRef.current, scale, controller.signal)
      .then((size) => {
        if (!controller.signal.aborted) {
          setPageSize(size);
          setRenderedTarget({ doc, page: safePage, scale });
          setRenderError(null);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRenderedTarget(null);
        setRenderError(error instanceof Error ? error.message : 'PDF_PAGE_ERROR');
      })
      .finally(() => {
        if (!controller.signal.aborted) setRenderingPage(false);
      });

    return () => {
      controller.abort();
    };
  }, [doc, safePage, scale]);

  const displayRenderError =
    renderError === PDF_UNSUPPORTED_IMAGE_DECODER_ERROR ? t('unsupportedImageDecoder') : renderError;

  useEffect(() => {
    const rendered = isCurrentPdfTargetRendered({
      pdfBytes,
      doc,
      pageSize,
      loadingDoc,
      renderingPage,
      renderError: displayRenderError,
      renderedTarget,
      safePage,
      scale,
    });
    onRenderStatusChange?.({ rendered, error: displayRenderError });
  }, [pdfBytes, doc, pageSize, loadingDoc, renderingPage, renderedTarget, safePage, scale, displayRenderError, onRenderStatusChange]);

  const handleSurfaceClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSurfaceClick || !surfaceRef.current) return;
    if (event.target !== surfaceRef.current && event.target !== canvasRef.current) return;
    const rect = surfaceRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const xNorm = (event.clientX - rect.left) / rect.width;
    const yNorm = (event.clientY - rect.top) / rect.height;
    onSurfaceClick(safePage, xNorm, yNorm);
  };

  return (
    <div className={className} data-testid="pdf-canvas-viewer">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-9"
            disabled={safePage <= 1}
            onClick={() => onPageChange(safePage - 1)}
            aria-label={t('prevPage')}
          >
            {t('prevPage')}
          </Button>
          <span className="px-2 text-xs font-medium text-foreground" data-testid="pdf-page-indicator">
            {t('pageNav', { current: String(safePage), total: String(effectiveTotal) })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-9"
            disabled={safePage >= effectiveTotal}
            onClick={() => onPageChange(safePage + 1)}
            aria-label={t('nextPage')}
          >
            {t('nextPage')}
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-9"
            disabled={scale <= MIN_SCALE}
            onClick={() => onScaleChange(Math.max(MIN_SCALE, Math.round((scale - 0.15) * 100) / 100))}
            aria-label={t('zoomOut')}
          >
            -
          </Button>
          <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-9"
            disabled={scale >= MAX_SCALE}
            onClick={() => onScaleChange(Math.min(MAX_SCALE, Math.round((scale + 0.15) * 100) / 100))}
            aria-label={t('zoomIn')}
          >
            +
          </Button>
        </div>
      </div>

      {displayRenderError ? <ErrorText>{displayRenderError}</ErrorText> : null}

      <div className="overflow-auto rounded-lg border bg-muted/40 p-3 sm:p-4">
        <div
          ref={surfaceRef}
          onClick={handleSurfaceClick}
          data-testid="pdf-page-surface"
          style={pageSize ? { width: `${Math.floor(pageSize.width)}px`, height: `${Math.floor(pageSize.height)}px` } : undefined}
          className={
            pageSize
              ? 'relative mx-auto overflow-hidden border border-field-border bg-image-surface'
              : 'relative mx-auto min-h-[420px] w-full max-w-[720px] overflow-hidden border border-field-border bg-image-surface'
          }
        >
          {loadingDoc || renderingPage ? (
            <div className="pointer-events-none absolute inset-4 z-20">
              <RowsSkeleton rows={5} />
            </div>
          ) : null}
          <canvas ref={canvasRef} className={pageSize ? 'block' : 'block max-w-full'} />
          <div className="pointer-events-none absolute inset-0 z-10">{renderOverlay?.(safePage)}</div>
        </div>
      </div>
    </div>
  );
}
