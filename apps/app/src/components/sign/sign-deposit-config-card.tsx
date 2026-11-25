// SPDX-License-Identifier: AGPL-3.0-only
// Envelope detail sidebar card for configuring post-sign VietQR deposit (drafts) and inspecting the frozen snapshot
// plus signer transfer confirmation/receipt after send (#4723). Hidden on hr_contract and meeting_minutes envelopes.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { ErrorText } from '../ui.tsx';
import { useFormat } from '../../i18n/provider.tsx';
import { errorMessage, queryClient } from '../../lib/api.ts';
import { isZeroAmount } from '../../lib/decimal.ts';
import {
  SIGN_DEPOSIT_DUE_DAYS_MAX,
  SIGN_DEPOSIT_MEMO_TOKEN_PATTERN,
  SIGN_DEPOSIT_NOTE_MAX,
  signApi,
  type SignEnvelopeDepositRecordContract,
} from '../../lib/sign-api.ts';
import { copyTextToClipboard } from '../../lib/sign-hash.ts';
import { toast } from '../../lib/toast.ts';

const WHOLE_VND_INPUT_RE = /^[0-9]+(?:\.0{1,4})?$/;

export interface SignDepositConfigCardProps {
  slug: string;
  envelopeId: string;
  envelopeStatus: string;
  sourceKind: string;
  canEditDraft: boolean;
  deposit: SignEnvelopeDepositRecordContract | null;
  onDownloadFile?: (fileId: string, filename: string) => void;
}

export function SignDepositConfigCard({
  slug,
  envelopeId,
  envelopeStatus,
  sourceKind,
  canEditDraft,
  deposit,
  onDownloadFile,
}: SignDepositConfigCardProps) {
  const t = useTranslations('sign.depositConfig');
  const common = useTranslations('common');
  const f = useFormat();
  const idPrefix = useId();

  const isConfidential = sourceKind === 'hr_contract' || sourceKind === 'meeting_minutes';
  const isDraft = envelopeStatus === 'draft';

  const profileQuery = useQuery({
    queryKey: ['sign', 'deposit-profile', slug],
    queryFn: () => signApi.getDepositProfile(),
    enabled: !isConfidential && isDraft && canEditDraft,
  });

  const [editing, setEditing] = useState(Boolean(deposit));
  const [amountInput, setAmountInput] = useState(deposit?.amount ?? '');
  const [dueDaysInput, setDueDaysInput] = useState(deposit?.dueDays !== null && deposit?.dueDays !== undefined ? String(deposit.dueDays) : '');
  const [memoTokenInput, setMemoTokenInput] = useState(deposit?.memoToken ?? '');
  const [noteInput, setNoteInput] = useState(deposit?.note ?? '');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(Boolean(deposit));
    setAmountInput(deposit?.amount ?? '');
    setDueDaysInput(deposit?.dueDays !== null && deposit?.dueDays !== undefined ? String(deposit.dueDays) : '');
    setMemoTokenInput(deposit?.memoToken ?? '');
    setNoteInput(deposit?.note ?? '');
    setLocalError(null);
  }, [deposit]);

  const invalidateEnvelope = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sign', 'envelope', slug, envelopeId] });
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const normalizedAmount = amountInput.trim();
      const trimmedDue = dueDaysInput.trim();
      const trimmedMemo = memoTokenInput.trim().toUpperCase();
      const trimmedNote = noteInput.trim();
      return signApi.setEnvelopeDeposit({
        envelopeId,
        amount: normalizedAmount,
        dueDays: trimmedDue ? Number.parseInt(trimmedDue, 10) : null,
        ...(trimmedMemo ? { memoToken: trimmedMemo } : {}),
        note: trimmedNote || null,
      });
    },
    onSuccess: async () => {
      toast(t('savedToast'));
      await invalidateEnvelope();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const clearMutation = useMutation({
    mutationFn: () => signApi.clearEnvelopeDeposit(envelopeId),
    onSuccess: async () => {
      toast(t('clearedToast'));
      setEditing(false);
      setAmountInput('');
      setDueDaysInput('');
      setMemoTokenInput('');
      setNoteInput('');
      await invalidateEnvelope();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  if (isConfidential) return null;
  if (!isDraft && !deposit) return null;
  if (isDraft && !canEditDraft && !deposit) return null;

  const handleSave = (event: FormEvent) => {
    event.preventDefault();
    setLocalError(null);
    const trimmedAmount = amountInput.trim();
    if (!WHOLE_VND_INPUT_RE.test(trimmedAmount) || isZeroAmount(trimmedAmount)) {
      setLocalError(t('invalidAmount'));
      return;
    }
    const trimmedDue = dueDaysInput.trim();
    if (trimmedDue) {
      if (!/^[0-9]+$/.test(trimmedDue)) {
        setLocalError(t('invalidDueDays'));
        return;
      }
      const parsedDue = Number.parseInt(trimmedDue, 10);
      if (parsedDue < 0 || parsedDue > SIGN_DEPOSIT_DUE_DAYS_MAX) {
        setLocalError(t('invalidDueDays'));
        return;
      }
    }
    const trimmedMemo = memoTokenInput.trim().toUpperCase();
    if (trimmedMemo && !SIGN_DEPOSIT_MEMO_TOKEN_PATTERN.test(trimmedMemo)) {
      setLocalError(t('invalidMemoToken'));
      return;
    }
    saveMutation.mutate();
  };

  const handleCopy = async (text: string) => {
    const ok = await copyTextToClipboard(text);
    toast(ok ? t('copiedToast') : t('copyFailedToast'), ok ? undefined : 'error');
  };

  if (!isDraft && deposit) {
    return (
      <Card data-testid="sign-envelope-deposit-snapshot-card">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">{t('cardTitle')}</CardTitle>
            <Badge variant={deposit.signerNoticeAt ? 'success' : 'secondary'}>
              {deposit.signerNoticeAt ? t('noticeReceivedBadge') : t('awaitingTransferBadge')}
            </Badge>
          </div>
          <CardDescription className="text-xs">{t('frozenHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-xs">
          <dl className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">{t('amountLabel')}</dt>
              <dd className="font-mono font-semibold text-foreground">{`${f.money(deposit.amount)} VND`}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">{t('memoTokenLabel')}</dt>
              <dd className="flex items-center gap-1.5">
                <span className="font-mono font-semibold text-foreground" data-testid="sign-deposit-snapshot-memo">
                  {deposit.memoToken}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="px-1.5 text-[11px] md:h-6"
                  aria-label={t('copyMemoAria')}
                  onClick={() => void handleCopy(deposit.memoToken)}
                >
                  {t('copyButton')}
                </Button>
              </dd>
            </div>
            {deposit.dueDays !== null ? (
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{t('dueDaysSummaryLabel')}</dt>
                <dd className="text-foreground">{t('dueDaysSummaryValue', { days: String(deposit.dueDays) })}</dd>
              </div>
            ) : null}
            {deposit.snapshotBankName ? (
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{t('bankSnapshotLabel')}</dt>
                <dd className="text-right text-foreground">
                  {deposit.snapshotBankName} ({deposit.snapshotAccountNumber})
                </dd>
              </div>
            ) : null}
            {deposit.snapshotAccountHolder ? (
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">{t('holderSnapshotLabel')}</dt>
                <dd className="text-right text-foreground">{deposit.snapshotAccountHolder}</dd>
              </div>
            ) : null}
            {deposit.note ? (
              <div className="rounded border bg-muted/30 p-2 text-foreground">
                <span className="font-medium">{t('noteLabel')}: </span>
                {deposit.note}
              </div>
            ) : null}
          </dl>

          {deposit.signerNoticeAt ? (
            <div className="space-y-1.5 rounded border border-border bg-muted/20 p-2.5" data-testid="sign-deposit-signer-notice-box">
              <p className="font-medium text-foreground">
                {t('signerNoticedAt', { date: f.date(deposit.signerNoticeAt.slice(0, 10)) })}
              </p>
              {deposit.signerNoticeNote ? (
                <p className="text-muted-foreground">{deposit.signerNoticeNote}</p>
              ) : null}
              {deposit.signerProofFileId && onDownloadFile ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => onDownloadFile(deposit.signerProofFileId!, deposit.signerProofFilename ?? 'deposit-receipt.png')}
                  data-testid="sign-deposit-proof-download-btn"
                >
                  {t('downloadProof', { filename: deposit.signerProofFilename ?? 'receipt' })}
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  const profileMissing = profileQuery.isSuccess && !profileQuery.data.profile;

  return (
    <Card data-testid="sign-envelope-deposit-config-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('cardTitle')}</CardTitle>
        <CardDescription className="text-xs">{t('draftHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {!canEditDraft && deposit ? (
          <dl className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">{t('amountLabel')}</dt>
              <dd className="font-mono font-semibold text-foreground">{`${f.money(deposit.amount)} VND`}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-muted-foreground">{t('memoTokenLabel')}</dt>
              <dd className="font-mono text-foreground">{deposit.memoToken}</dd>
            </div>
          </dl>
        ) : !editing ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full max-md:min-h-11"
            onClick={() => setEditing(true)}
            data-testid="sign-deposit-enable-btn"
          >
            {t('enableButton')}
          </Button>
        ) : (
          <>
            {profileMissing ? (
              <Alert data-testid="sign-deposit-missing-profile-alert">
                <AlertDescription className="text-xs">
                  {t('missingProfileWarning')}{' '}
                  <Link
                    to="/o/$slug/sign/settings"
                    params={{ slug }}
                    hash="sign-deposit-profile"
                    className="text-link underline"
                  >
                    {t('openSettingsLink')}
                  </Link>
                </AlertDescription>
              </Alert>
            ) : null}

            <form onSubmit={handleSave} className="space-y-2.5" data-testid="sign-envelope-deposit-form">
              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-amount`} className="text-xs">
                  {t('amountLabel')} (VND)
                </Label>
                <Input
                  id={`${idPrefix}-amount`}
                  className="font-mono max-md:min-h-11"
                  value={amountInput}
                  placeholder="5000000"
                  disabled={saveMutation.isPending}
                  onChange={(e) => setAmountInput(e.target.value)}
                  data-testid="sign-deposit-amount-input"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor={`${idPrefix}-due`} className="text-xs">
                    {t('dueDaysLabel')}
                  </Label>
                  <Input
                    id={`${idPrefix}-due`}
                    type="number"
                    min={0}
                    max={SIGN_DEPOSIT_DUE_DAYS_MAX}
                    className="max-md:min-h-11"
                    value={dueDaysInput}
                    placeholder="3"
                    disabled={saveMutation.isPending}
                    onChange={(e) => setDueDaysInput(e.target.value)}
                    data-testid="sign-deposit-due-days-input"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${idPrefix}-memo`} className="text-xs">
                    {t('memoTokenOptionalLabel')}
                  </Label>
                  <Input
                    id={`${idPrefix}-memo`}
                    className="font-mono uppercase max-md:min-h-11"
                    value={memoTokenInput}
                    placeholder="CK-..."
                    maxLength={15}
                    disabled={saveMutation.isPending}
                    onChange={(e) => setMemoTokenInput(e.target.value)}
                    data-testid="sign-deposit-memo-input"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-note`} className="text-xs">
                  {t('noteLabel')}
                </Label>
                <Input
                  id={`${idPrefix}-note`}
                  className="max-md:min-h-11"
                  value={noteInput}
                  maxLength={SIGN_DEPOSIT_NOTE_MAX}
                  placeholder={t('notePlaceholder')}
                  disabled={saveMutation.isPending}
                  onChange={(e) => setNoteInput(e.target.value)}
                  data-testid="sign-deposit-note-input"
                />
              </div>

              {localError ? <ErrorText>{localError}</ErrorText> : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  size="sm"
                  className="max-md:min-h-11"
                  loading={saveMutation.isPending}
                  data-testid="sign-deposit-save-btn"
                >
                  {t('saveButton')}
                </Button>
                {deposit ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="max-md:min-h-11"
                    loading={clearMutation.isPending}
                    disabled={saveMutation.isPending}
                    onClick={() => clearMutation.mutate()}
                    data-testid="sign-deposit-remove-btn"
                  >
                    {t('removeButton')}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="max-md:min-h-11"
                    disabled={saveMutation.isPending}
                    onClick={() => setEditing(false)}
                  >
                    {common('cancel')}
                  </Button>
                )}
              </div>
            </form>
          </>
        )}
      </CardContent>
    </Card>
  );
}
