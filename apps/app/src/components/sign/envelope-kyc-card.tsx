// SPDX-License-Identifier: AGPL-3.0-only
// Sender-side Signer KYC Attachment Verification Card on /o/$slug/sign/envelopes/$id (Slice 5e, #4443).
// Provides 100% AI-off deterministic MIME/size/SHA-256 & Vietnamese MST/CCCD/name checks, side-by-side preview,
// optional metered Vy review ('sign.kyc_check', tainted 'De xuat'), and explicit human confirmation.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { useFormat } from '../../i18n/provider.tsx';
import { errorMessage, queryClient } from '../../lib/api.ts';
import {
  downloadSignFile,
  downloadSignPdfBytes,
  signApi,
  type SignKycAttachmentSlotContract,
} from '../../lib/sign-api.ts';
import { copyTextToClipboard } from '../../lib/sign-hash.ts';
import { extractPdfPagesText } from '../../lib/sign-pdf.ts';
import { toast } from '../../lib/toast.ts';
import { ErrorText } from '../ui.tsx';

export interface EnvelopeKycCardProps {
  envelopeId: string;
  hasUploadedAttachments: boolean;
  onDownloadAttachment: (fileId: string, filename: string) => Promise<void> | void;
}

type AiNoticeKey =
  | 'aiOffNotice'
  | 'aiBusyNotice'
  | 'aiNoTextNotice'
  | 'aiEmptyNotice'
  | 'aiFailedNotice';

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function statusBadgeVariant(
  status: 'unverified' | 'pending' | 'matched' | 'mismatch' | 'needs_review',
): 'outline' | 'brand' | 'success' | 'destructive' | 'secondary' {
  switch (status) {
    case 'matched':
      return 'success';
    case 'mismatch':
      return 'destructive';
    case 'needs_review':
      return 'brand';
    case 'pending':
      return 'secondary';
    default:
      return 'outline';
  }
}

interface KycSlotRowProps {
  envelopeId: string;
  slot: SignKycAttachmentSlotContract;
  canWrite: boolean;
  onDownloadAttachment: (fileId: string, filename: string) => Promise<void> | void;
}

function KycSlotRow({ envelopeId, slot, canWrite, onDownloadAttachment }: KycSlotRowProps) {
  const t = useTranslations('sign');
  const f = useFormat();
  const check = slot.check;
  const findings = check?.findings ?? null;

  const [expectedEntity, setExpectedEntity] = useState(
    findings?.expectedEntityName ?? slot.obligationCounterpartyName ?? '',
  );
  const [expectedTaxCode, setExpectedTaxCode] = useState(findings?.expectedTaxCode ?? '');
  const [manualNote, setManualNote] = useState(findings?.manualNote ?? '');
  const [dirtyInputs, setDirtyInputs] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const [aiNoticeKey, setAiNoticeKey] = useState<AiNoticeKey | null>(null);
  const [slotError, setSlotError] = useState<string | null>(null);

  const isImage = slot.contentType === 'image/png' || slot.contentType === 'image/jpeg';

  useEffect(() => {
    if (dirtyInputs) return;
    setExpectedEntity(findings?.expectedEntityName ?? slot.obligationCounterpartyName ?? '');
    setExpectedTaxCode(findings?.expectedTaxCode ?? '');
    setManualNote(findings?.manualNote ?? '');
  }, [dirtyInputs, findings?.expectedEntityName, findings?.expectedTaxCode, findings?.manualNote, slot.obligationCounterpartyName]);

  useEffect(() => {
    if (!previewOpen || !isImage) {
      setImagePreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    void downloadSignFile(slot.fileId)
      .then((blob) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setImagePreviewUrl(createdUrl);
      })
      .catch((err) => {
        if (!cancelled) setSlotError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [isImage, previewOpen, slot.fileId]);

  const invalidateKyc = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sign', 'kyc', envelopeId] });
  };

  const loadAttachmentPdfPages = async (): Promise<Array<{ page: number; text: string }> | undefined> => {
    if (slot.contentType !== 'application/pdf') return undefined;
    try {
      const bytes = await downloadSignPdfBytes(slot.fileId);
      const pages = await extractPdfPagesText(bytes);
      return pages.length > 0 ? pages : [];
    } catch {
      return undefined;
    }
  };

  const deterministicMutation = useMutation({
    mutationFn: async () => {
      setSlotError(null);
      setAiNoticeKey(null);
      const pages = await loadAttachmentPdfPages();
      return signApi.runKycDeterministic({
        envelopeId,
        fieldId: slot.fieldId,
        expectedEntityName: expectedEntity.trim() || null,
        expectedTaxCode: expectedTaxCode.trim() || null,
        ...(pages !== undefined ? { attachmentPages: pages } : {}),
      });
    },
    onSuccess: async () => {
      setDirtyInputs(false);
      toast(t('kyc.deterministicDoneToast'));
      await invalidateKyc();
    },
    onError: (err) => {
      setSlotError(errorMessage(err));
    },
  });

  const analyzeVyMutation = useMutation({
    mutationFn: async () => {
      setSlotError(null);
      setAiNoticeKey(null);
      const pages = await loadAttachmentPdfPages();
      return signApi.analyzeKycWithVy({
        envelopeId,
        fieldId: slot.fieldId,
        expectedEntityName: expectedEntity.trim() || null,
        expectedTaxCode: expectedTaxCode.trim() || null,
        ...(pages && pages.length > 0 ? { attachmentPages: pages } : {}),
      });
    },
    onSuccess: async (res) => {
      if (res.ai === 'off' || res.ai === 'budget') {
        setAiNoticeKey('aiOffNotice');
      } else if (res.ai === 'busy') {
        setAiNoticeKey('aiBusyNotice');
      } else if (res.ai === 'no_text') {
        setAiNoticeKey('aiNoTextNotice');
      } else if (res.ai === 'empty') {
        setAiNoticeKey('aiEmptyNotice');
      } else if (res.ai === 'failed' || res.ai === 'not_ready') {
        setAiNoticeKey('aiFailedNotice');
      } else {
        setDirtyInputs(false);
        setAiNoticeKey(null);
      }
      await invalidateKyc();
    },
    onError: (err) => {
      setSlotError(errorMessage(err));
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (nextStatus: 'matched' | 'mismatch') => {
      setSlotError(null);
      return signApi.confirmKycCheck({
        envelopeId,
        fieldId: slot.fieldId,
        status: nextStatus,
        manualNote: manualNote.trim() || null,
        expectedEntityName: expectedEntity.trim() || null,
        expectedTaxCode: expectedTaxCode.trim() || null,
      });
    },
    onSuccess: async (saved) => {
      setDirtyInputs(false);
      toast(saved.status === 'matched' ? t('kyc.confirmedMatchedToast') : t('kyc.confirmedMismatchToast'));
      await invalidateKyc();
    },
    onError: (err) => {
      setSlotError(errorMessage(err));
    },
  });

  const effectiveStatus = check?.status ?? 'unverified';
  const docKind = findings?.documentKind ?? 'other';
  const entityInputId = `kyc-expected-entity-${slot.fieldId}`;
  const mstInputId = `kyc-expected-mst-${slot.fieldId}`;
  const noteInputId = `kyc-manual-note-${slot.fieldId}`;

  return (
    <div
      className="space-y-3 rounded-lg border bg-card p-3 text-xs"
      data-testid={`sign-kyc-slot-${slot.fieldId}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium text-foreground">
              {slot.fieldLabel || t(`kyc.docKind.${docKind}`)}
            </span>
            <Badge variant="outline" className="text-[10px]">
              {slot.contentType === 'application/pdf'
                ? 'PDF'
                : slot.contentType === 'image/png'
                  ? 'PNG'
                  : 'JPEG'}
            </Badge>
            <span className="text-[11px] text-muted-foreground">({formatByteSize(slot.sizeBytes)})</span>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t('kyc.signerLabel', { name: slot.signerName, role: slot.signerRoleLabel })}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{slot.filename}</p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {check ? (
            <Badge variant="secondary" className="text-[10px]">
              {t(`kyc.mode.${check.mode}`)}
            </Badge>
          ) : null}
          <Badge
            variant={statusBadgeVariant(effectiveStatus)}
            data-testid={`sign-kyc-status-${slot.fieldId}`}
          >
            {t(`kyc.status.${effectiveStatus}`)}
          </Badge>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1 font-mono text-[11px]">
        <span className="truncate">{slot.fileSha256}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-[11px] max-md:min-h-11"
          onClick={async () => {
            if (await copyTextToClipboard(slot.fileSha256)) {
              toast(t('evidence.copiedToast'));
            }
          }}
        >
          {t('evidence.copyDigest')}
        </Button>
      </div>

      {canWrite ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={entityInputId} className="text-[11px]">
              {t('kyc.expectedEntityLabel')}
            </Label>
            <Input
              id={entityInputId}
              value={expectedEntity}
              placeholder={t('kyc.expectedEntityPlaceholder')}
              className="h-8 text-xs max-md:min-h-11"
              onChange={(e) => {
                setExpectedEntity(e.target.value);
                setDirtyInputs(true);
              }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={mstInputId} className="text-[11px]">
              {t('kyc.expectedTaxCodeLabel')}
            </Label>
            <Input
              id={mstInputId}
              value={expectedTaxCode}
              placeholder={t('kyc.expectedTaxCodePlaceholder')}
              className="h-8 font-mono text-xs max-md:min-h-11"
              onChange={(e) => {
                setExpectedTaxCode(e.target.value);
                setDirtyInputs(true);
              }}
            />
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {canWrite ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="max-md:min-h-11"
              loading={deterministicMutation.isPending}
              onClick={() => deterministicMutation.mutate()}
              data-testid={`sign-kyc-run-deterministic-${slot.fieldId}`}
            >
              {deterministicMutation.isPending
                ? t('kyc.runningDeterministic')
                : t('kyc.runDeterministicButton')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5 max-md:min-h-11"
              loading={analyzeVyMutation.isPending}
              onClick={() => analyzeVyMutation.mutate()}
              data-testid={`sign-kyc-analyze-vy-${slot.fieldId}`}
            >
              <span>{analyzeVyMutation.isPending ? t('kyc.analyzingVy') : t('kyc.analyzeVyButton')}</span>
              <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                {t('kyc.proposalBadge')}
              </Badge>
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="max-md:min-h-11"
          aria-expanded={previewOpen}
          onClick={() => setPreviewOpen((prev) => !prev)}
          data-testid={`sign-kyc-toggle-preview-${slot.fieldId}`}
        >
          {previewOpen ? t('kyc.togglePreviewHide') : t('kyc.togglePreviewShow')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="max-md:min-h-11"
          onClick={() => void onDownloadAttachment(slot.fileId, slot.filename)}
          data-testid={`sign-kyc-download-${slot.fieldId}`}
        >
          {t('kyc.downloadButton')}
        </Button>
      </div>

      {slotError ? <ErrorText>{slotError}</ErrorText> : null}

      {aiNoticeKey ? (
        <Alert data-testid={`sign-kyc-ai-notice-${slot.fieldId}`}>
          <AlertDescription className="text-xs">{t(`kyc.${aiNoticeKey}`)}</AlertDescription>
        </Alert>
      ) : null}

      {previewOpen ? (
        <div
          className="grid grid-cols-1 gap-2 rounded border bg-muted/40 p-2.5 sm:grid-cols-2"
          data-testid={`sign-kyc-preview-pane-${slot.fieldId}`}
        >
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {t('kyc.signerLabel', { name: slot.signerName, role: slot.signerRoleLabel })}
            </p>
            {slot.signerEmail ? <p className="text-muted-foreground">{slot.signerEmail}</p> : null}
            {expectedEntity.trim() ? (
              <p className="text-foreground">
                {t('kyc.category.entity_name')}: <span className="font-medium">{expectedEntity.trim()}</span>
              </p>
            ) : null}
            {expectedTaxCode.trim() ? (
              <p className="font-mono text-foreground">
                {t('kyc.category.tax_code')}: {expectedTaxCode.trim()}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            {isImage ? (
              imagePreviewUrl ? (
                <img
                  src={imagePreviewUrl}
                  alt={t('kyc.imagePreviewAlt', { signer: slot.signerName })}
                  className="max-h-56 w-full rounded border bg-card object-contain"
                />
              ) : null
            ) : findings?.extractedTextPreview ? (
              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded border bg-card p-2 font-mono text-[11px] text-foreground">
                {findings.extractedTextPreview}
              </pre>
            ) : (
              <p className="text-muted-foreground">{t('kyc.pdfPreviewHint')}</p>
            )}
          </div>
        </div>
      ) : null}

      {findings && findings.deterministicChecks.length > 0 ? (
        <div className="space-y-1.5 border-t pt-2" data-testid={`sign-kyc-deterministic-list-${slot.fieldId}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-medium text-foreground">{t('kyc.deterministicHeading')}</p>
            <div className="flex flex-wrap gap-1.5 font-mono text-[11px] text-muted-foreground">
              {findings.extractedTaxCodes.length > 0 ? (
                <span>{t('kyc.extractedMstLabel', { codes: findings.extractedTaxCodes.join(', ') })}</span>
              ) : null}
              {findings.extractedNationalIds.length > 0 ? (
                <span>{t('kyc.extractedCccdLabel', { ids: findings.extractedNationalIds.join(', ') })}</span>
              ) : null}
            </div>
          </div>
          <ul className="space-y-1">
            {findings.deterministicChecks.map((item, idx) => (
              <li
                key={`${item.category}-${idx}`}
                className="flex flex-col gap-0.5 rounded border bg-muted/40 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="font-medium text-foreground">{t(`kyc.category.${item.category}`)}</span>
                  <Badge variant={statusBadgeVariant(item.status)} className="text-[10px]">
                    {t(`kyc.status.${item.status}`)}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground">{item.detail}</p>
                {item.extractedValue || item.expectedValue ? (
                  <p className="font-mono text-[11px] text-foreground">
                    {item.extractedValue ?? '-'}
                    {item.expectedValue ? ` / ${item.expectedValue}` : ''}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {findings?.aiProposal ? (
        <div
          className="space-y-2 rounded border border-dashed bg-muted/40 p-2.5"
          data-testid={`sign-kyc-ai-proposal-${slot.fieldId}`}
        >
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-foreground">{t('kyc.vyProposalHeading')}</span>
              <Badge variant="outline" className="text-[10px]">
                {t('kyc.proposalBadge')}
              </Badge>
            </div>
            <Badge variant={statusBadgeVariant(findings.aiProposal.suggestedStatus)} className="text-[10px]">
              {t(`kyc.status.${findings.aiProposal.suggestedStatus}`)}
            </Badge>
          </div>
          <p className="text-[11px] text-muted-foreground">{t('kyc.vyProposalHint')}</p>
          {findings.aiProposal.summaryNote ? (
            <p className="text-foreground">{findings.aiProposal.summaryNote}</p>
          ) : null}
          <ul className="space-y-1.5">
            {findings.aiProposal.findings.map((item, idx) => (
              <li key={`${item.category}-${item.pageNumber}-${idx}`} className="space-y-1 rounded border bg-card p-2">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="font-medium text-foreground">{t(`kyc.category.${item.category}`)}</span>
                  <Badge
                    variant={
                      item.assessment === 'match'
                        ? 'success'
                        : item.assessment === 'mismatch'
                          ? 'destructive'
                          : 'outline'
                    }
                    className="text-[10px]"
                  >
                    {t(`kyc.assessment.${item.assessment}`)}
                  </Badge>
                </div>
                <p className="text-foreground">{item.explanation}</p>
                <p className="rounded bg-muted/50 px-1.5 py-1 font-mono text-[11px] text-muted-foreground">
                  {t('kyc.pageQuoteLabel', { page: String(item.pageNumber), quote: item.quoteExcerpt })}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {canWrite ? (
        <div className="space-y-2 border-t pt-2">
          <div className="space-y-1">
            <Label htmlFor={noteInputId} className="text-[11px]">
              {t('kyc.manualNoteLabel')}
            </Label>
            <Input
              id={noteInputId}
              value={manualNote}
              placeholder={t('kyc.manualNotePlaceholder')}
              className="h-8 text-xs max-md:min-h-11"
              onChange={(e) => {
                setManualNote(e.target.value);
                setDirtyInputs(true);
              }}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="max-md:min-h-11"
              loading={confirmMutation.isPending && confirmMutation.variables === 'matched'}
              onClick={() => confirmMutation.mutate('matched')}
              data-testid={`sign-kyc-confirm-matched-${slot.fieldId}`}
            >
              {t('kyc.confirmMatchedButton')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="max-md:min-h-11"
              loading={confirmMutation.isPending && confirmMutation.variables === 'mismatch'}
              onClick={() => confirmMutation.mutate('mismatch')}
              data-testid={`sign-kyc-confirm-mismatch-${slot.fieldId}`}
            >
              {t('kyc.confirmMismatchButton')}
            </Button>
          </div>
        </div>
      ) : (
        <p className="border-t pt-2 text-[11px] text-muted-foreground">{t('kyc.viewerReadOnly')}</p>
      )}

      {check?.checkedAt ? (
        <p className="text-[11px] text-muted-foreground">
          {t('kyc.confirmedAtHint', { time: f.dateTime(check.checkedAt) })}
        </p>
      ) : null}
    </div>
  );
}

export const SIGN_KYC_POLL_INTERVAL_MS = 2_500;

export function kycRefetchIntervalMs(
  data: { items: ReadonlyArray<{ check: { status: string } | null }> } | undefined,
): number | false {
  return data?.items.some((item) => item.check?.status === 'pending') ? SIGN_KYC_POLL_INTERVAL_MS : false;
}

export function EnvelopeKycCard({
  envelopeId,
  hasUploadedAttachments,
  onDownloadAttachment,
}: EnvelopeKycCardProps) {
  const t = useTranslations('sign');

  const kycQuery = useQuery({
    queryKey: ['sign', 'kyc', envelopeId],
    queryFn: () => signApi.listKycChecks(envelopeId),
    enabled: Boolean(envelopeId) && hasUploadedAttachments,
    refetchInterval: (query) => kycRefetchIntervalMs(query.state.data),
  });

  if (!hasUploadedAttachments) return null;
  if (kycQuery.isPending) return null;
  if (kycQuery.error) {
    return (
      <Card data-testid="sign-kyc-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('kyc.cardTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorText>{errorMessage(kycQuery.error)}</ErrorText>
        </CardContent>
      </Card>
    );
  }

  const items = kycQuery.data?.items ?? [];
  if (items.length === 0) return null;

  return (
    <Card data-testid="sign-kyc-card">
      <CardHeader className="space-y-1 pb-2">
        <CardTitle className="text-sm">{t('kyc.cardTitle')}</CardTitle>
        <p className="text-xs text-muted-foreground">{t('kyc.cardHint')}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {items.map((slot) => (
          <KycSlotRow
            key={slot.fieldId}
            envelopeId={envelopeId}
            slot={slot}
            canWrite={Boolean(kycQuery.data?.canWrite)}
            onDownloadAttachment={onDownloadAttachment}
          />
        ))}
      </CardContent>
    </Card>
  );
}
