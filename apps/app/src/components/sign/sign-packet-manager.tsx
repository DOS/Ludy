// SPDX-License-Identifier: AGPL-3.0-only
// Prepare-screen multi-document packet manager and Vy cross-document consistency card (#4722, Slice 6c).
import { useMutation } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { cn } from '@ludy/ui/lib/utils';
import { errorMessage } from '../../lib/api.ts';
import {
  SIGN_MAX_PACKET_DOCS,
  SIGN_MAX_PAGES,
  SIGN_PACKET_MAX_BYTES,
  SIGN_UPLOAD_ACCEPT,
  convertSignDocx,
  downloadSignPdfBytes,
  isSignDocxFile,
  signApi,
  uploadSignPdf,
  type SignEnvelopeDocumentSummary,
  type SignPacketConsistencyCheckResult,
} from '../../lib/sign-api.ts';
import { extractPdfPagesText } from '../../lib/sign-pdf.ts';
import type { DraftFieldPlacement } from '../../lib/sign-fields.ts';
import { toast } from '../../lib/toast.ts';
import { ConfirmDialog } from '../confirm-dialog.tsx';

export interface SignPacketManagerProps {
  envelopeId: string;
  canEditDraft: boolean;
  canRunConsistency?: boolean | undefined;
  documents: readonly SignEnvelopeDocumentSummary[];
  activeDocumentKey: string;
  fields: readonly DraftFieldPlacement[];
  onSelectDocument: (documentId: string | null, docIndex: number, targetPage?: number) => void;
  onBeforeMutatePacket?: () => Promise<void>;
  onPacketChanged: () => Promise<void> | void;
}

function stripExtension(filename: string): string {
  const leaf = filename.split(/[\\/]/).pop() ?? filename;
  const cleaned = leaf.replace(/\.(pdf|docx)$/i, '').trim();
  return cleaned || leaf.trim() || 'Document';
}

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 10 ? mb.toFixed(1) : mb.toFixed(2);
}

export function SignPacketManager({
  envelopeId,
  canEditDraft,
  canRunConsistency,
  documents,
  activeDocumentKey,
  fields,
  onSelectDocument,
  onBeforeMutatePacket,
  onPacketChanged,
}: SignPacketManagerProps) {
  const allowConsistencyCheck = canRunConsistency ?? canEditDraft;
  const t = useTranslations('sign.packet');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadStage, setUploadStage] = useState<'idle' | 'uploading' | 'converting'>('idle');
  const [removeTarget, setRemoveTarget] = useState<SignEnvelopeDocumentSummary | null>(null);
  const [consistencyResult, setConsistencyResult] = useState<SignPacketConsistencyCheckResult | null>(null);

  const doc1Id = documents[0]?.id ?? null;
  const totalPages = documents.reduce((sum, d) => sum + (d.pageCount ?? 0), 0);
  const totalBytes = documents.reduce((sum, d) => sum + (d.sizeBytes ?? 0), 0);
  const maxMbLabel = String(Math.round(SIGN_PACKET_MAX_BYTES / (1024 * 1024)));

  const fieldCountForDoc = (doc: SignEnvelopeDocumentSummary): number =>
    fields.filter((f) => (f.documentId ?? doc1Id ?? null) === (doc.id ?? null)).length;

  const addMutation = useMutation({
    mutationFn: async (file: File) => {
      await onBeforeMutatePacket?.();
      if (isSignDocxFile(file)) {
        setUploadStage('converting');
        const converted = await convertSignDocx(file);
        return signApi.addEnvelopeDocument({
          envelopeId,
          sourceFileId: converted.fileId,
          title: stripExtension(file.name),
          sourceDocxSha256: converted.sourceDocxSha256,
        });
      }
      setUploadStage('uploading');
      const uploaded = await uploadSignPdf(file);
      return signApi.addEnvelopeDocument({
        envelopeId,
        sourceFileId: uploaded.fileId,
        title: stripExtension(file.name),
      });
    },
    onSuccess: async (res, file) => {
      setConsistencyResult(null);
      toast(t('addedToast', { title: stripExtension(file.name) }));
      await onPacketChanged();
      onSelectDocument(res.documentId, res.docIndex, 1);
    },
    onError: (err) => toast(errorMessage(err), 'error'),
    onSettled: () => setUploadStage('idle'),
  });

  const removeMutation = useMutation({
    mutationFn: async (doc: SignEnvelopeDocumentSummary) => {
      if (!doc.id) return null;
      await onBeforeMutatePacket?.();
      return { doc, res: await signApi.removeEnvelopeDocument({ envelopeId, documentId: doc.id }) };
    },
    onSuccess: async (out) => {
      if (!out) return;
      setRemoveTarget(null);
      setConsistencyResult(null);
      toast(t('removedToast', { title: out.doc.title }));
      await onPacketChanged();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const reorderMutation = useMutation({
    mutationFn: async (orderedIds: string[]) => {
      await onBeforeMutatePacket?.();
      return signApi.reorderEnvelopeDocuments({ envelopeId, documentIds: orderedIds });
    },
    onSuccess: async () => {
      setConsistencyResult(null);
      toast(t('reorderedToast'));
      await onPacketChanged();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const consistencyMutation = useMutation({
    mutationFn: async () => {
      const passedDocs = documents.filter((d) => d.inspectStatus === 'passed');
      const extractedDocs: Array<{
        documentId?: string | null;
        pages: Array<{ page: number; text: string }>;
      }> = [];
      for (const doc of passedDocs) {
        try {
          const bytes = await downloadSignPdfBytes(doc.fileId);
          const pages = await extractPdfPagesText(bytes);
          extractedDocs.push({ documentId: doc.id, pages });
        } catch {
          extractedDocs.push({ documentId: doc.id, pages: [] });
        }
      }
      return signApi.checkPacketConsistency({
        envelopeId,
        ...(extractedDocs.length > 0 ? { documents: extractedDocs } : {}),
      });
    },
    onSuccess: (res) => {
      setConsistencyResult(res);
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const busy = addMutation.isPending || removeMutation.isPending || reorderMutation.isPending;

  const handleMove = (idx: number, delta: -1 | 1) => {
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= documents.length) return;
    if (documents.some((d) => !d.id)) return;
    const ids = documents.map((d) => d.id!);
    const swap = ids[idx]!;
    ids[idx] = ids[targetIdx]!;
    ids[targetIdx] = swap;
    reorderMutation.mutate(ids);
  };

  const degradedHintKey =
    consistencyResult?.ai === 'off'
      ? 'consistencyDegradedOff'
      : consistencyResult?.ai === 'busy'
        ? 'consistencyDegradedBusy'
        : consistencyResult?.ai === 'budget'
          ? 'consistencyDegradedBudget'
          : consistencyResult?.ai === 'not_ready'
            ? 'consistencyDegradedNotReady'
            : consistencyResult?.ai === 'no_text'
              ? 'consistencyDegradedNoText'
              : consistencyResult?.ai === 'failed'
                ? 'consistencyDegradedFailed'
                : null;

  return (
    <Card data-testid="sign-packet-manager">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('sectionTitle', { count: String(documents.length) })}</CardTitle>
        <p className="text-xs text-muted-foreground" data-testid="sign-packet-counters">
          {t('counters', {
            docs: String(documents.length),
            maxDocs: String(SIGN_MAX_PACKET_DOCS),
            pages: String(totalPages),
            maxPages: String(SIGN_MAX_PAGES),
            mb: formatMegabytes(totalBytes),
            maxMb: maxMbLabel,
          })}
        </p>
      </CardHeader>
      <CardContent className="space-y-2.5 text-xs">
        <div className="space-y-1.5">
          {documents.map((doc, idx) => {
            const key = doc.id ?? 'doc-1';
            const isSelected = key === activeDocumentKey;
            const fieldsInDoc = fieldCountForDoc(doc);
            return (
              <div
                key={key}
                className={cn(
                  'rounded-md border p-2 transition-colors',
                  isSelected ? 'border-primary bg-primary/5' : 'border-border bg-background',
                )}
                data-testid={`sign-packet-doc-row-${doc.docIndex}`}
              >
                <button
                  type="button"
                  onClick={() => onSelectDocument(doc.id, doc.docIndex)}
                  className="flex min-h-11 w-full items-start justify-between gap-2 text-left"
                >
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="truncate font-medium text-foreground">
                      {t('docTabLabel', { index: String(doc.docIndex), title: doc.title })}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {doc.pageCount !== null ? t('pagesCount', { count: String(doc.pageCount) }) : t('inspectPending')}
                      {doc.sizeBytes !== null ? ` · ${formatMegabytes(doc.sizeBytes)} MB` : ''}
                      {fieldsInDoc > 0 ? ` · ${t('docFieldsCount', { count: String(fieldsInDoc) })}` : ''}
                    </p>
                  </div>
                  {doc.inspectStatus === 'pending' ? (
                    <Badge variant="outline">{t('inspectPending')}</Badge>
                  ) : doc.inspectStatus === 'failed' ? (
                    <Badge variant="destructive">{t('inspectFailed')}</Badge>
                  ) : null}
                </button>
                {doc.inspectStatus === 'failed' && doc.inspectError ? (
                  <p className="mt-1 text-[11px] text-destructive">{doc.inspectError}</p>
                ) : null}
                {canEditDraft && documents.length > 1 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1 border-t border-border/60 pt-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 px-2 text-xs"
                      disabled={busy || idx === 0}
                      onClick={() => handleMove(idx, -1)}
                      data-testid={`sign-packet-move-up-${doc.docIndex}`}
                    >
                      {t('moveUp')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-11 px-2 text-xs"
                      disabled={busy || idx === documents.length - 1}
                      onClick={() => handleMove(idx, 1)}
                      data-testid={`sign-packet-move-down-${doc.docIndex}`}
                    >
                      {t('moveDown')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="min-h-11 px-2 text-xs text-destructive hover:text-destructive"
                      disabled={busy || !doc.id}
                      onClick={() => setRemoveTarget(doc)}
                      data-testid={`sign-packet-remove-${doc.docIndex}`}
                    >
                      {t('removeButton')}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {canEditDraft && documents.length < SIGN_MAX_PACKET_DOCS ? (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept={SIGN_UPLOAD_ACCEPT}
              className="hidden"
              data-testid="sign-packet-file-input"
              onChange={(e) => {
                const selected = e.target.files?.[0];
                e.target.value = '';
                if (selected) {
                  addMutation.mutate(selected);
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full"
              disabled={busy}
              loading={addMutation.isPending}
              onClick={() => fileInputRef.current?.click()}
              data-testid="sign-packet-add-btn"
            >
              {uploadStage === 'converting'
                ? t('convertingDocx')
                : uploadStage === 'uploading'
                  ? t('addingPdf')
                  : t('addButton')}
            </Button>
          </div>
        ) : null}

        {allowConsistencyCheck && documents.length >= 2 ? (
          <div className="space-y-2 border-t border-border pt-2.5">
            <Button
              type="button"
              variant="secondary"
              className="min-h-11 w-full"
              loading={consistencyMutation.isPending}
              onClick={() => consistencyMutation.mutate()}
              data-testid="sign-packet-consistency-btn"
            >
              {consistencyMutation.isPending ? t('checkingConsistency') : t('checkConsistencyButton')}
            </Button>

            {consistencyResult ? (
              <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2.5" data-testid="sign-packet-consistency-panel">
                <p className="font-semibold text-foreground">{t('consistencyPanelTitle')}</p>
                {degradedHintKey ? (
                  <p className="text-[11px] text-muted-foreground" data-testid="sign-packet-consistency-degraded">
                    {t(degradedHintKey)}
                  </p>
                ) : null}
                {consistencyResult.summaryText ? (
                  <p className="text-muted-foreground">{consistencyResult.summaryText}</p>
                ) : null}
                {consistencyResult.findings.length === 0 ? (
                  <p className="text-muted-foreground">{t('consistencyNoIssues')}</p>
                ) : (
                  <div className="space-y-2">
                    {consistencyResult.findings.map((finding, idx) => {
                      const docMatch = documents.find(
                        (d) => (finding.documentId && d.id === finding.documentId) || d.title === finding.documentTitle,
                      );
                      const docIdx = docMatch?.docIndex ?? 1;
                      return (
                        <div
                          key={`${finding.kind}-${finding.documentId ?? idx}-${idx}`}
                          className="space-y-1 rounded border border-border bg-background p-2"
                          data-testid={`sign-packet-finding-${idx}`}
                        >
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={finding.source === 'ai' ? 'secondary' : 'outline'}>
                              {finding.source === 'ai' ? t('proposedBadge') : t('deterministicBadge')}
                            </Badge>
                            <Badge
                              variant={
                                finding.severity === 'critical'
                                  ? 'destructive'
                                  : finding.severity === 'warn'
                                    ? 'warning'
                                    : 'outline'
                              }
                            >
                              {finding.title}
                            </Badge>
                          </div>
                          <p className="text-foreground">{finding.explanation}</p>
                          {finding.quoteExcerpt ? (
                            <blockquote className="border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground">
                              {finding.quoteExcerpt}
                            </blockquote>
                          ) : null}
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="min-h-11 px-2 text-xs"
                            onClick={() =>
                              onSelectDocument(
                                docMatch?.id ?? finding.documentId,
                                docIdx,
                                finding.pageNumber ?? 1,
                              )
                            }
                            data-testid={`sign-packet-finding-jump-${idx}`}
                          >
                            {finding.pageNumber
                              ? t('jumpToFinding', { index: String(docIdx), page: String(finding.pageNumber) })
                              : t('jumpToDoc', { index: String(docIdx) })}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removeMutation.isPending) setRemoveTarget(null);
        }}
        title={t('removeConfirmTitle')}
        description={t('removeConfirmDescription', { title: removeTarget?.title ?? '' })}
        confirm={t('removeConfirmButton')}
        destructive={true}
        disabled={removeMutation.isPending}
        onConfirm={() => {
          if (removeTarget) removeMutation.mutate(removeTarget);
        }}
      />
    </Card>
  );
}
