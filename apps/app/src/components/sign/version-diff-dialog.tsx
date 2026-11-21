// SPDX-License-Identifier: AGPL-3.0-only
// PDF Contract Version Diff modal (So sanh ban sua doi, #3822):
// compares two uploaded or org-stored PDFs deterministically (100% AI-off parity) and optionally requests
// Vy's metered commercial risk delta summary ('sign.version_diff') with verbatim quote verification.
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { MAX_UPLOAD_BYTES } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { AiMeter } from '../ai-meter.tsx';
import { ErrorText } from '../ui.tsx';
import { errorMessage } from '../../lib/api.ts';
import {
  downloadSignPdfBytes,
  signApi,
  uploadSignPdf,
  type SignDiffCompareResult,
  type SignEnvelopeSummary,
} from '../../lib/sign-api.ts';
import { extractPdfPagesText, looksLikePdfBytes } from '../../lib/sign-pdf.ts';

export interface VersionDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingEnvelopes: readonly SignEnvelopeSummary[];
  onEnvelopeCreated?: (envelopeId: string) => void;
}

const SEVERITY_BADGE = {
  low: 'secondary',
  medium: 'warning',
  high: 'destructive',
} as const;

const HUNK_BADGE = {
  added: 'success',
  removed: 'destructive',
  modified: 'warning',
  unchanged: 'outline',
} as const;

export function VersionDiffDialog({
  open,
  onOpenChange,
  existingEnvelopes,
  onEnvelopeCreated,
}: VersionDiffDialogProps) {
  const t = useTranslations('sign.diff');
  const tSign = useTranslations('sign');
  const common = useTranslations('common');

  const [envIdV1, setEnvIdV1] = useState('');
  const [envIdV2, setEnvIdV2] = useState('');
  const [fileV1, setFileV1] = useState<File | null>(null);
  const [fileV2, setFileV2] = useState<File | null>(null);
  const [includeAi, setIncludeAi] = useState(true);
  const [changesOnly, setChangesOnly] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [result, setResult] = useState<SignDiffCompareResult | null>(null);
  const [resolvedV2Source, setResolvedV2Source] = useState<{
    title: string;
    existingFileId?: string;
    uploadedFile?: File;
  } | null>(null);

  const handleFilePick = async (
    event: React.ChangeEvent<HTMLInputElement>,
    slot: 'v1' | 'v2',
  ) => {
    setFormError(null);
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      if (slot === 'v1') setFileV1(null);
      else setFileV2(null);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setFormError(tSign('pdfTooLarge'));
      return;
    }
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (!looksLikePdfBytes(head)) {
      setFormError(tSign('pdfInvalidType'));
      return;
    }
    if (slot === 'v1') {
      setFileV1(file);
      setEnvIdV1('');
    } else {
      setFileV2(file);
      setEnvIdV2('');
    }
  };

  const compareMutation = useMutation({
    mutationFn: async () => {
      const env1 = existingEnvelopes.find((e) => e.id === envIdV1) ?? null;
      const env2 = existingEnvelopes.find((e) => e.id === envIdV2) ?? null;
      if ((!env1 && !fileV1) || (!env2 && !fileV2)) {
        throw new Error(t('missingBothError'));
      }

      const bytesV1 = env1
        ? await downloadSignPdfBytes(env1.sourceFileId)
        : new Uint8Array(await fileV1!.arrayBuffer());
      const bytesV2 = env2
        ? await downloadSignPdfBytes(env2.sourceFileId)
        : new Uint8Array(await fileV2!.arrayBuffer());

      const rawPagesV1 = await extractPdfPagesText(bytesV1);
      const rawPagesV2 = await extractPdfPagesText(bytesV2);
      const pagesV1 = rawPagesV1.length > 0 ? rawPagesV1 : [{ page: 1, text: '' }];
      const pagesV2 = rawPagesV2.length > 0 ? rawPagesV2 : [{ page: 1, text: '' }];

      const titleV1 = env1 ? env1.title : fileV1!.name.replace(/\.pdf$/i, '');
      const titleV2 = env2 ? env2.title : fileV2!.name.replace(/\.pdf$/i, '');

      const compared = await signApi.comparePdfVersions({
        titleV1,
        titleV2,
        ...(env1 ? { fileIdV1: env1.sourceFileId } : {}),
        ...(env2 ? { fileIdV2: env2.sourceFileId } : {}),
        pagesV1,
        pagesV2,
        includeAi,
      });

      setResolvedV2Source({
        title: titleV2,
        ...(env2 ? { existingFileId: env2.sourceFileId } : {}),
        ...(fileV2 ? { uploadedFile: fileV2 } : {}),
      });
      return compared;
    },
    onSuccess: (data) => {
      setFormError(null);
      setResult(data);
    },
    onError: (err) => {
      setFormError(errorMessage(err));
    },
  });

  const createFromV2Mutation = useMutation({
    mutationFn: async () => {
      if (!resolvedV2Source) throw new Error(t('missingBothError'));
      const sourceFileId = resolvedV2Source.existingFileId
        ? resolvedV2Source.existingFileId
        : (await uploadSignPdf(resolvedV2Source.uploadedFile!)).fileId;
      return signApi.createEnvelope({
        title: resolvedV2Source.title || 'Revised Contract v2',
        routingMode: 'parallel',
        sourceFileId,
      });
    },
    onSuccess: (created) => {
      onOpenChange(false);
      onEnvelopeCreated?.(created.envelopeId);
    },
    onError: (err) => {
      setFormError(errorMessage(err));
    },
  });

  const visibleHunks = result
    ? changesOnly
      ? result.diff.hunks.filter((h) => h.kind !== 'unchanged')
      : result.diff.hunks
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" closeLabel={common('close')}>
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
          <DialogDescription>{t('dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-xs">
          <AiMeter module="sign" />
          {formError ? <ErrorText>{formError}</ErrorText> : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <p className="font-semibold text-foreground">{t('v1Heading')}</p>
              <div className="space-y-1">
                <Label htmlFor="sign-diff-file-v1">{t('sourceUploadLabel')}</Label>
                <Input
                  id="sign-diff-file-v1"
                  type="file"
                  accept="application/pdf,.pdf"
                  className="min-h-11"
                  onChange={(e) => void handleFilePick(e, 'v1')}
                  data-testid="sign-diff-file-v1"
                />
              </div>
              {existingEnvelopes.length > 0 ? (
                <div className="space-y-1">
                  <Label htmlFor="sign-diff-env-v1">{t('sourceExistingOption')}</Label>
                  <NativeSelect
                    id="sign-diff-env-v1"
                    value={envIdV1}
                    className="min-h-11 w-full"
                    onChange={(e) => {
                      setEnvIdV1(e.target.value);
                      if (e.target.value) setFileV1(null);
                    }}
                  >
                    <NativeSelectOption value="">{t('sourceNoneOption')}</NativeSelectOption>
                    {existingEnvelopes.map((env) => (
                      <NativeSelectOption key={env.id} value={env.id}>
                        {env.title}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
            </div>

            <div className="space-y-2 rounded-md border bg-muted/20 p-3">
              <p className="font-semibold text-foreground">{t('v2Heading')}</p>
              <div className="space-y-1">
                <Label htmlFor="sign-diff-file-v2">{t('sourceUploadLabel')}</Label>
                <Input
                  id="sign-diff-file-v2"
                  type="file"
                  accept="application/pdf,.pdf"
                  className="min-h-11"
                  onChange={(e) => void handleFilePick(e, 'v2')}
                  data-testid="sign-diff-file-v2"
                />
              </div>
              {existingEnvelopes.length > 0 ? (
                <div className="space-y-1">
                  <Label htmlFor="sign-diff-env-v2">{t('sourceExistingOption')}</Label>
                  <NativeSelect
                    id="sign-diff-env-v2"
                    value={envIdV2}
                    className="min-h-11 w-full"
                    onChange={(e) => {
                      setEnvIdV2(e.target.value);
                      if (e.target.value) setFileV2(null);
                    }}
                  >
                    <NativeSelectOption value="">{t('sourceNoneOption')}</NativeSelectOption>
                    {existingEnvelopes.map((env) => (
                      <NativeSelectOption key={env.id} value={env.id}>
                        {env.title}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="sign-diff-include-ai" className="flex min-h-11 cursor-pointer items-center gap-2">
              <Checkbox
                id="sign-diff-include-ai"
                checked={includeAi}
                onCheckedChange={(checked) => setIncludeAi(Boolean(checked))}
                data-testid="sign-diff-include-ai-checkbox"
              />
              <span>{t('includeAiLabel')}</span>
            </label>
            <Button
              type="button"
              className="min-h-11"
              loading={compareMutation.isPending}
              onClick={() => compareMutation.mutate()}
              data-testid="sign-diff-run-btn"
            >
              {compareMutation.isPending ? t('comparingButton') : t('compareButton')}
            </Button>
          </div>

          {result ? (
            <div className="space-y-3 border-t pt-3" data-testid="sign-diff-results">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="success">{t('statsAdded', { count: String(result.diff.stats.addedCount) })}</Badge>
                  <Badge variant="destructive">{t('statsRemoved', { count: String(result.diff.stats.removedCount) })}</Badge>
                  <Badge variant="warning">{t('statsModified', { count: String(result.diff.stats.modifiedCount) })}</Badge>
                  <Badge variant="outline">{t('statsUnchanged', { count: String(result.diff.stats.unchangedCount) })}</Badge>
                </div>
                <label htmlFor="sign-diff-changes-only" className="flex min-h-11 cursor-pointer items-center gap-2">
                  <Checkbox
                    id="sign-diff-changes-only"
                    checked={changesOnly}
                    onCheckedChange={(checked) => setChangesOnly(Boolean(checked))}
                  />
                  <span>{t('showChangesOnlyLabel')}</span>
                </label>
              </div>

              {includeAi && (result.ai === 'off' || result.ai === 'budget') ? (
                <p className="rounded-md border bg-muted/40 p-2.5 text-muted-foreground" data-testid="sign-diff-ai-off-notice">
                  {t('vyAiOffNotice')}
                </p>
              ) : null}

              {result.summaryText || result.riskDeltas.length > 0 ? (
                <div
                  className="space-y-2 rounded-md border border-dashed border-proposal bg-proposal/10 p-3"
                  data-testid="sign-diff-vy-delta-card"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-foreground">{t('vyDeltaHeading')}</span>
                    <Badge variant="secondary">{t('vyProposalBadge')}</Badge>
                  </div>
                  {result.summaryText ? <p className="text-foreground">{result.summaryText}</p> : null}
                  {result.riskDeltas.map((delta, idx) => (
                    <div key={`${idx}-${delta.title}`} className="space-y-1 rounded border bg-card p-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={SEVERITY_BADGE[delta.severity]}>{delta.severity}</Badge>
                        <span className="font-medium text-foreground">{delta.title}</span>
                      </div>
                      {delta.beforeQuote ? (
                        <p className="italic text-muted-foreground">
                          {t('beforeLabel')} &ldquo;{delta.beforeQuote}&rdquo;
                        </p>
                      ) : null}
                      {delta.afterQuote ? (
                        <p className="italic text-muted-foreground">
                          {t('afterLabel')} &ldquo;{delta.afterQuote}&rdquo;
                        </p>
                      ) : null}
                      <p className="text-foreground">{delta.explanation}</p>
                    </div>
                  ))}
                </div>
              ) : null}

              {result.diff.stats.identical ? (
                <p className="rounded-md border bg-muted/30 p-3 text-muted-foreground">{t('identicalNotice')}</p>
              ) : (
                <ul className="max-h-72 space-y-2 overflow-y-auto" data-testid="sign-diff-hunk-list">
                  {visibleHunks.map((hunk) => (
                    <li key={hunk.index} className="space-y-1.5 rounded-md border bg-card p-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant={HUNK_BADGE[hunk.kind]}>
                          {hunk.kind === 'added'
                            ? t('kindAdded')
                            : hunk.kind === 'removed'
                              ? t('kindRemoved')
                              : hunk.kind === 'modified'
                                ? t('kindModified')
                                : t('kindUnchanged')}
                        </Badge>
                        {hunk.pageV1 !== null ? (
                          <span className="text-muted-foreground">{t('pageV1Badge', { page: String(hunk.pageV1) })}</span>
                        ) : null}
                        {hunk.pageV2 !== null ? (
                          <span className="text-muted-foreground">{t('pageV2Badge', { page: String(hunk.pageV2) })}</span>
                        ) : null}
                      </div>
                      {hunk.beforeText && hunk.kind !== 'added' ? (
                        <div className="rounded bg-destructive/10 px-2 py-1 text-foreground">
                          <span className="font-medium text-destructive">{t('beforeLabel')} </span>
                          <span>{hunk.beforeText}</span>
                        </div>
                      ) : null}
                      {hunk.afterText && hunk.kind !== 'removed' ? (
                        <div className="rounded bg-success/10 px-2 py-1 text-foreground">
                          <span className="font-medium text-success">{t('afterLabel')} </span>
                          <span>{hunk.afterText}</span>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          {result && resolvedV2Source ? (
            <Button
              type="button"
              variant="secondary"
              className="min-h-11"
              loading={createFromV2Mutation.isPending}
              onClick={() => createFromV2Mutation.mutate()}
              data-testid="sign-diff-create-from-v2-btn"
            >
              {t('createEnvelopeFromV2Button')}
            </Button>
          ) : null}
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>
            {common('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
