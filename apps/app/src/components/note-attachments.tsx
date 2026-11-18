// SPDX-License-Identifier: AGPL-3.0-only
// Isolated note attachments UI (#3561, docs/plan/notes-v2.md V2-5, owner decision A3, ADR-0037):
// clipboard screenshot paste (Ctrl+V / Cmd+V), drag-and-drop + file button (<= 25 MB validation),
// inline raster image gallery + lightbox, inline PDF canvas preview, inline audio player,
// download/delete actions, and crove-extract status badges.
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import { NOTE_ATTACHMENT_MAX_BYTES, type NoteAttachment } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { ClientError, clientForOrg, errorMessage, fetchNoteAttachmentBlob, uploadNoteAttachment } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { refreshNotes } from './notes-panel.tsx';
import { PdfCanvasViewer } from './sign/pdf-canvas-viewer.tsx';
import { ErrorText, Spinner } from './ui.tsx';

const SAFE_RASTER_IMAGES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const SAFE_AUDIO_TYPES: ReadonlySet<string> = new Set([
  'audio/mpeg',
  'audio/wav',
  'audio/ogg',
  'audio/mp4',
  'audio/webm',
]);

const AUTO_PREVIEW_PDF_MAX_BYTES = 10 * 1024 * 1024;

const EXT_BY_MIME: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function isSafeNoteRasterImage(contentType: string): boolean {
  return SAFE_RASTER_IMAGES.has(contentType.trim().toLowerCase());
}

export function isSafeNoteAudio(contentType: string): boolean {
  return SAFE_AUDIO_TYPES.has(contentType.trim().toLowerCase());
}

export function isNotePdf(contentType: string): boolean {
  return contentType.trim().toLowerCase() === 'application/pdf';
}

export function formatAttachmentBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(sizeBytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ClipboardLike {
  items?: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null }> | null;
  files?: ArrayLike<File> | null;
}

export function extractClipboardFiles(clipboardData: ClipboardLike | null | undefined, now = Date.now()): File[] {
  if (!clipboardData) return [];
  const raw: File[] = [];
  if (clipboardData.items && clipboardData.items.length > 0) {
    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (!item || item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) raw.push(file);
    }
  }
  if (raw.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
    for (let i = 0; i < clipboardData.files.length; i++) {
      const file = clipboardData.files[i];
      if (file) raw.push(file);
    }
  }
  return raw.map((file, idx) => {
    const trimmed = file.name.trim();
    const genericImage = trimmed === '' || trimmed === 'image.png' || trimmed === 'blob';
    if (!genericImage) return file;
    const ext = EXT_BY_MIME[file.type.toLowerCase()] ?? 'png';
    const stamp = idx === 0 ? `${now}` : `${now}-${idx + 1}`;
    return new File([file], `anh-chup-${stamp}.${ext}`, {
      type: file.type || 'image/png',
      lastModified: file.lastModified || now,
    });
  });
}

export function validateNoteAttachmentFile(file: File): ClientError | null {
  if (file.size === 0) {
    return new ClientError('notes.attachments.emptyFile', (t) => t('notes.attachments.emptyFile'));
  }
  if (file.size > NOTE_ATTACHMENT_MAX_BYTES) {
    return new ClientError('notes.attachments.fileTooLarge', (t) =>
      t('notes.attachments.fileTooLarge', { name: file.name || 'dinh-kem' }),
    );
  }
  return null;
}

export interface NoteAttachmentUploader {
  uploadingName: string | null;
  uploadError: unknown;
  clearUploadError: () => void;
  uploadFiles: (files: readonly File[], source: 'picker' | 'paste') => Promise<void>;
  onEditorPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
}

export function useNoteAttachmentUploader({
  noteId,
  slug,
  enabled,
}: {
  noteId: string;
  slug: string;
  enabled: boolean;
}): NoteAttachmentUploader {
  const t = useTranslations('notes.attachments');
  const [uploadingName, setUploadingName] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<unknown>(null);

  const uploadFiles = useCallback(
    async (files: readonly File[], source: 'picker' | 'paste') => {
      if (!enabled || files.length === 0) return;
      setUploadError(null);
      for (const file of files) {
        const invalid = validateNoteAttachmentFile(file);
        if (invalid) {
          setUploadError(invalid);
          return;
        }
      }
      for (const file of files) {
        setUploadingName(file.name || 'dinh-kem');
        try {
          await uploadNoteAttachment(noteId, file, slug);
          await refreshNotes();
        } catch (err) {
          setUploadError(err);
          setUploadingName(null);
          return;
        }
      }
      setUploadingName(null);
      toast(source === 'paste' ? t('pastedToast') : t('uploadedToast'), 'success');
    },
    [enabled, noteId, slug, t],
  );

  const onEditorPaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (!enabled) return;
      const files = extractClipboardFiles(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      void uploadFiles(files, 'paste');
    },
    [enabled, uploadFiles],
  );

  return {
    uploadingName,
    uploadError,
    clearUploadError: () => setUploadError(null),
    uploadFiles,
    onEditorPaste,
  };
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function ImageAttachmentPreview({
  attachment,
  slug,
  onOpenLightbox,
}: {
  attachment: NoteAttachment;
  slug: string;
  onOpenLightbox: (url: string, filename: string) => void;
}) {
  const t = useTranslations('notes.attachments');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let currentUrl: string | null = null;
    setFailed(false);
    void fetchNoteAttachmentBlob(attachment.id, slug)
      .then((blob) => {
        if (cancelled) return;
        const typed = new Blob([blob], { type: attachment.contentType });
        currentUrl = URL.createObjectURL(typed);
        setObjectUrl(currentUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [attachment.id, attachment.contentType, slug]);

  if (failed) {
    return <p className="text-xs text-subtle-foreground">{t('previewFailed')}</p>;
  }
  if (!objectUrl) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-subtle-foreground">
        <Spinner />
        <span>{t('loadingPreview')}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpenLightbox(objectUrl, attachment.filename)}
      aria-label={t('openImage', { name: attachment.filename })}
      className="block overflow-hidden rounded-md border bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="note-attachment-image-button"
    >
      <img
        src={objectUrl}
        alt={attachment.filename}
        className="max-h-56 w-auto max-w-full object-contain"
        data-testid="note-attachment-image"
      />
    </button>
  );
}

function AudioAttachmentPreview({ attachment, slug }: { attachment: NoteAttachment; slug: string }) {
  const t = useTranslations('notes.attachments');
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let currentUrl: string | null = null;
    setFailed(false);
    void fetchNoteAttachmentBlob(attachment.id, slug)
      .then((blob) => {
        if (cancelled) return;
        const typed = new Blob([blob], { type: attachment.contentType });
        currentUrl = URL.createObjectURL(typed);
        setObjectUrl(currentUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [attachment.id, attachment.contentType, slug]);

  if (failed) return <p className="text-xs text-subtle-foreground">{t('previewFailed')}</p>;
  if (!objectUrl) {
    return (
      <div className="flex items-center gap-2 py-1 text-xs text-subtle-foreground">
        <Spinner />
        <span>{t('loadingPreview')}</span>
      </div>
    );
  }
  return (
    <audio
      controls
      preload="metadata"
      src={objectUrl}
      className="w-full max-w-md"
      data-testid="note-attachment-audio"
    />
  );
}

function PdfAttachmentPreview({ attachment, slug }: { attachment: NoteAttachment; slug: string }) {
  const t = useTranslations('notes.attachments');
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [scale, setScale] = useState(1.0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void fetchNoteAttachmentBlob(attachment.id, slug)
      .then(async (blob) => {
        const buffer = await blob.arrayBuffer();
        if (cancelled) return;
        setPdfBytes(new Uint8Array(buffer));
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, slug]);

  if (failed) return <p className="text-xs text-subtle-foreground">{t('previewFailed')}</p>;
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-subtle-foreground">
        <Spinner />
        <span>{t('loadingPreview')}</span>
      </div>
    );
  }
  return (
    <div data-testid="note-attachment-pdf-viewer" className="mt-2">
      <PdfCanvasViewer
        pdfBytes={pdfBytes}
        pageNumber={pageNumber}
        pageCount={pageCount}
        scale={scale}
        onPageChange={setPageNumber}
        onScaleChange={setScale}
        onPageCountDetected={(count) => {
          setPageCount(count);
          setPageNumber(1);
        }}
      />
    </div>
  );
}

function ExtractStatusBadge({ status }: { status: NoteAttachment['extractStatus'] }) {
  const t = useTranslations('notes.attachments');
  if (status === 'skipped') return null;
  const variant = status === 'failed' ? 'destructive' : status === 'done' ? 'secondary' : 'outline';
  return (
    <Badge variant={variant} data-testid={`note-attachment-status-${status}`}>
      {t(`status.${status}`)}
    </Badge>
  );
}

export function NoteAttachments({
  attachments,
  slug,
  canUpload,
  canDelete,
  uploader,
}: {
  attachments: readonly NoteAttachment[];
  slug: string;
  canUpload: boolean;
  canDelete: boolean;
  uploader: NoteAttachmentUploader;
}) {
  const t = useTranslations('notes.attachments');
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const api = useRef(clientForOrg(slug)).current;
  const [dragActive, setDragActive] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [lightbox, setLightbox] = useState<{ url: string; filename: string } | null>(null);
  const [openPdfs, setOpenPdfs] = useState<Record<string, boolean>>({});

  // Poll while any attachment is waiting on crove-extract so the status badge updates automatically.
  const hasPending = attachments.some((att) => att.extractStatus === 'pending');
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      void refreshNotes();
    }, 2000);
    return () => clearInterval(timer);
  }, [hasPending]);

  const removeMutation = useMutation({
    mutationFn: (attachmentId: string) => api.notes.attachments.delete({ attachmentId }),
    onSuccess: () => {
      setActionError(null);
      toast(t('deletedToast'), 'success');
      void refreshNotes();
    },
    onError: (err) => setActionError(err),
  });

  const handleDownload = async (att: NoteAttachment) => {
    setActionError(null);
    setDownloadingId(att.id);
    try {
      const blob = await fetchNoteAttachmentBlob(att.id, slug);
      triggerBlobDownload(blob, att.filename);
    } catch (err) {
      setActionError(err);
    } finally {
      setDownloadingId(null);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (!canUpload) return;
    const dropped = Array.from(event.dataTransfer?.files ?? []);
    if (dropped.length > 0) {
      void uploader.uploadFiles(dropped, 'picker');
    }
  };

  if (!canUpload && attachments.length === 0) return null;

  return (
    <section className="space-y-3" aria-label={t('heading')} data-testid="note-attachments-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('heading')} {attachments.length > 0 ? `(${attachments.length})` : ''}
        </h3>
        {canUpload && (
          <>
            <input
              id={inputId}
              ref={fileInputRef}
              type="file"
              multiple
              className="sr-only"
              data-testid="note-attachment-file-input"
              onChange={(e) => {
                const selected = Array.from(e.target.files ?? []);
                e.currentTarget.value = '';
                if (selected.length > 0) void uploader.uploadFiles(selected, 'picker');
              }}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={uploader.uploadingName !== null}
              onClick={() => fileInputRef.current?.click()}
              data-testid="note-attachment-upload-button"
            >
              {t('attachButton')}
            </Button>
          </>
        )}
      </div>

      {canUpload && (
        <div
          onDragEnter={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (!dragActive) setDragActive(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDragActive(false);
          }}
          onDrop={handleDrop}
          data-testid="note-attachment-dropzone"
          className={`rounded-md border border-dashed px-3 py-2 text-xs transition-colors ${
            dragActive ? 'border-primary bg-muted text-foreground' : 'border-border bg-muted/20 text-subtle-foreground'
          }`}
        >
          {uploader.uploadingName ? (
            <span className="inline-flex items-center gap-2 text-foreground" role="status">
              <Spinner />
              {t('uploading', { name: uploader.uploadingName })}
            </span>
          ) : dragActive ? (
            t('dropActive')
          ) : (
            t('dropHint')
          )}
        </div>
      )}

      {uploader.uploadError !== null && <ErrorText>{errorMessage(uploader.uploadError)}</ErrorText>}
      {actionError !== null && <ErrorText>{errorMessage(actionError)}</ErrorText>}

      {attachments.length > 0 && (
        <ul className="space-y-3" data-testid="note-attachment-list">
          {attachments.map((att) => {
            const isPdf = isNotePdf(att.contentType);
            const pdfOpen = openPdfs[att.id] ?? att.sizeBytes <= AUTO_PREVIEW_PDF_MAX_BYTES;
            return (
              <li
                key={att.id}
                className="space-y-2 rounded-lg border bg-card p-3"
                data-testid="note-attachment-item"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground" data-testid="note-attachment-filename">
                    {att.filename}
                  </span>
                  <span className="text-xs text-subtle-foreground">{formatAttachmentBytes(att.sizeBytes)}</span>
                  <ExtractStatusBadge status={att.extractStatus} />
                  <div className="ml-auto flex flex-wrap items-center gap-1">
                    {isPdf && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpenPdfs((prev) => ({ ...prev, [att.id]: !pdfOpen }))}
                        data-testid="note-attachment-toggle-pdf"
                      >
                        {pdfOpen ? t('hidePdf') : t('previewPdf')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      loading={downloadingId === att.id}
                      disabled={downloadingId === att.id}
                      onClick={() => void handleDownload(att)}
                      data-testid="note-attachment-download"
                    >
                      {t('download')}
                    </Button>
                    {canDelete && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        loading={removeMutation.isPending && removeMutation.variables === att.id}
                        disabled={removeMutation.isPending}
                        onClick={() => removeMutation.mutate(att.id)}
                        data-testid="note-attachment-delete"
                      >
                        {t('delete')}
                      </Button>
                    )}
                  </div>
                </div>

                {isSafeNoteRasterImage(att.contentType) && (
                  <ImageAttachmentPreview
                    attachment={att}
                    slug={slug}
                    onOpenLightbox={(url, filename) => setLightbox({ url, filename })}
                  />
                )}
                {isSafeNoteAudio(att.contentType) && <AudioAttachmentPreview attachment={att} slug={slug} />}
                {isPdf && pdfOpen && <PdfAttachmentPreview attachment={att} slug={slug} />}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={lightbox !== null} onOpenChange={(open) => !open && setLightbox(null)}>
        <DialogContent className="max-w-4xl" closeLabel={t('closeLightbox')}>
          <DialogHeader>
            <DialogTitle>{lightbox?.filename ?? ''}</DialogTitle>
            <DialogDescription className="sr-only">{t('closeLightbox')}</DialogDescription>
          </DialogHeader>
          {lightbox && (
            <div className="flex max-h-[75vh] items-center justify-center overflow-auto rounded-md bg-muted/30 p-2">
              <img
                src={lightbox.url}
                alt={lightbox.filename}
                className="max-h-[70vh] w-auto max-w-full object-contain"
                data-testid="note-attachment-lightbox-image"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
