// SPDX-License-Identifier: AGPL-3.0-only
// Non-blocking post-sign VietQR deposit payment request and optional transfer notice upload card on /-/sign (#4723).
// Signing is already complete before this card appears; signers can scan/copy bank details or optionally notify sender.
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { ErrorText } from '../ui.tsx';
import { safeQrSvgPath } from '../../lib/qr-svg.ts';
import {
  publicSignApi,
  PublicSignError,
  SIGN_DEPOSIT_NOTE_MAX,
  SIGN_DEPOSIT_PROOF_MAX_BYTES,
  type SignPublicDepositSummary,
} from '../../lib/sign-api.ts';
import { copyTextToClipboard } from '../../lib/sign-hash.ts';
import { toast } from '../../lib/toast.ts';
import { SIGN_QR_QUIET_ZONE } from './sign-qr-modal.tsx';

function formatVndMoney(amount: string): string {
  const [wholeRaw = '0', frac] = amount.split('.');
  const grouped = wholeRaw.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (!frac || /^0+$/.test(frac)) return `${grouped} VND`;
  return `${grouped},${frac.replace(/0+$/, '')} VND`;
}

export interface SignCeremonyDepositCardProps {
  token: string;
  deposit: SignPublicDepositSummary;
}

type CeremonyDepositErrorKey =
  | 'invalidProofType'
  | 'proofTooLarge'
  | 'noticeBusy'
  | 'noticeRateLimited'
  | 'noticeOtpRequired'
  | 'noticeFileConflict'
  | 'noticeConfidentialForbidden'
  | 'noticeNotFound'
  | 'noticeFailed';

export function resolveNoticeErrorMessage(
  error: unknown,
  t: (key: CeremonyDepositErrorKey) => string,
): string {
  if (error instanceof PublicSignError) {
    if (error.status === 404 || error.code === 'NOT_FOUND') return t('noticeNotFound');
    switch (error.code) {
      case 'UNSUPPORTED_TYPE':
      case 'SIGN_INVALID_SIGNATURE_PNG':
        return t('invalidProofType');
      case 'TOO_LARGE':
      case 'SIGN_DEPOSIT_PROOF_TOO_LARGE':
        return t('proofTooLarge');
      case 'SIGN_ATTACHMENT_BUSY':
        return t('noticeBusy');
      case 'RATE_LIMITED':
        return t('noticeRateLimited');
      case 'SIGN_OTP_REQUIRED':
        return t('noticeOtpRequired');
      case 'FILE_SOURCE_CONFLICT':
        return t('noticeFileConflict');
      case 'SIGN_CONFIDENTIAL_DEPOSIT_FORBIDDEN':
        return t('noticeConfidentialForbidden');
      default:
        return t('noticeFailed');
    }
  }
  return t('noticeFailed');
}

export function SignCeremonyDepositCard({ token, deposit: initialDeposit }: SignCeremonyDepositCardProps) {
  const t = useTranslations('sign.ceremonyDeposit');
  const idPrefix = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [deposit, setDeposit] = useState<SignPublicDepositSummary>(initialDeposit);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [noticeNote, setNoticeNote] = useState(initialDeposit.signerNoticeNote ?? '');
  const [noticeFile, setNoticeFile] = useState<File | null>(null);
  const [submittingNotice, setSubmittingNotice] = useState(false);
  const [noticeError, setNoticeError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState('');

  useEffect(() => {
    setDeposit(initialDeposit);
    setNoticeNote(initialDeposit.signerNoticeNote ?? '');
  }, [initialDeposit]);

  useEffect(() => {
    if (!deposit.hasQrPng || !token) {
      setQrUrl(null);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    void publicSignApi
      .depositQr(token)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setQrUrl(objectUrl);
      })
      .catch(() => {
        if (active) setQrUrl(null);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [token, deposit.hasQrPng]);

  const emvcoQr = !qrUrl && deposit.emvcoPayload ? safeQrSvgPath(deposit.emvcoPayload, SIGN_QR_QUIET_ZONE) : null;

  const handleCopy = async (text: string, fieldLabel: string) => {
    const ok = await copyTextToClipboard(text);
    const msg = ok ? t('copiedFieldStatus', { field: fieldLabel }) : t('copyFailedToast');
    setCopyStatus(msg);
    toast(msg, ok ? undefined : 'error');
  };

  const handleProofPick = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    setNoticeError(null);
    if (!picked) {
      setNoticeFile(null);
      return;
    }
    const lowerType = picked.type.toLowerCase();
    const lowerName = picked.name.toLowerCase();
    const validMime =
      lowerType === 'image/png' ||
      lowerType === 'image/jpeg' ||
      lowerName.endsWith('.png') ||
      lowerName.endsWith('.jpg') ||
      lowerName.endsWith('.jpeg');
    if (!validMime) {
      setNoticeError(t('invalidProofType'));
      return;
    }
    if (picked.size <= 0 || picked.size > SIGN_DEPOSIT_PROOF_MAX_BYTES) {
      setNoticeError(t('proofTooLarge'));
      return;
    }
    setNoticeFile(picked);
  };

  const handleNoticeSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setNoticeError(null);
    setSubmittingNotice(true);
    try {
      const res = await publicSignApi.depositNotice({
        token,
        note: noticeNote.trim() || null,
        file: noticeFile,
      });
      setDeposit(res.deposit);
      setNoticeNote(res.deposit.signerNoticeNote ?? '');
      setNoticeFile(null);
      toast(t('noticeSavedToast'));
    } catch (error) {
      const msg = resolveNoticeErrorMessage(error, t);
      setNoticeError(msg);
      toast(msg, 'error');
    } finally {
      setSubmittingNotice(false);
    }
  };

  return (
    <Card className="mt-4" data-testid="sign-ceremony-deposit-card">
      <CardHeader className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <Badge variant="secondary">{t('optionalBadge')}</Badge>
        </div>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {qrUrl ? (
          <div className="flex flex-col items-center gap-2">
            <div className="w-fit rounded-xl border border-border bg-image-surface p-3">
              <img
                src={qrUrl}
                alt={t('qrImageAlt')}
                className="h-56 w-56 object-contain"
                data-testid="sign-ceremony-deposit-qr-img"
              />
            </div>
            <p className="text-center text-xs text-muted-foreground">{t('scanHint')}</p>
          </div>
        ) : emvcoQr && emvcoQr.ok ? (
          <div className="flex flex-col items-center gap-2">
            <div className="w-fit rounded-xl border border-border bg-image-surface p-3 text-foreground dark:text-background">
              <svg
                viewBox={emvcoQr.viewBox}
                className="h-56 w-56"
                role="img"
                aria-label={t('qrImageAlt')}
                shapeRendering="crispEdges"
                data-testid="sign-ceremony-deposit-qr-svg"
              >
                <path d={emvcoQr.d} fill="currentColor" />
              </svg>
            </div>
            <p className="text-center text-xs text-muted-foreground">{t('scanHint')}</p>
          </div>
        ) : (
          <Alert data-testid="sign-ceremony-deposit-manual-notice">
            <AlertDescription className="text-xs">{t('manualTransferHint')}</AlertDescription>
          </Alert>
        )}

        <dl className="space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted-foreground">{t('bankLabel')}</dt>
            <dd className="text-right font-medium text-foreground">{deposit.bankName}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted-foreground">{t('accountNumberLabel')}</dt>
            <dd className="flex items-center gap-1.5">
              <span className="font-mono font-semibold text-foreground" data-testid="sign-ceremony-deposit-account">
                {deposit.accountNumber}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="px-2 text-xs md:min-h-8"
                aria-label={t('copyFieldAria', { field: t('accountNumberLabel') })}
                onClick={() => void handleCopy(deposit.accountNumber, t('accountNumberLabel'))}
              >
                {t('copyButton')}
              </Button>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted-foreground">{t('accountHolderLabel')}</dt>
            <dd className="text-right font-medium text-foreground">{deposit.accountHolder}</dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted-foreground">{t('amountLabel')}</dt>
            <dd className="flex items-center gap-1.5">
              <span className="font-mono font-semibold text-foreground" data-testid="sign-ceremony-deposit-amount">
                {formatVndMoney(deposit.amount)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="px-2 text-xs md:min-h-8"
                aria-label={t('copyFieldAria', { field: t('amountLabel') })}
                onClick={() => void handleCopy(deposit.amount, t('amountLabel'))}
              >
                {t('copyButton')}
              </Button>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-xs text-muted-foreground">{t('memoLabel')}</dt>
            <dd className="flex items-center gap-1.5">
              <span className="font-mono font-semibold text-foreground" data-testid="sign-ceremony-deposit-memo">
                {deposit.memoToken}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="px-2 text-xs md:min-h-8"
                aria-label={t('copyFieldAria', { field: t('memoLabel') })}
                onClick={() => void handleCopy(deposit.memoToken, t('memoLabel'))}
              >
                {t('copyButton')}
              </Button>
            </dd>
          </div>
          {deposit.dueDays !== null ? (
            <div className="flex items-center justify-between gap-2">
              <dt className="text-xs text-muted-foreground">{t('dueDaysLabel')}</dt>
              <dd className="text-right text-xs text-foreground">{t('dueDaysValue', { days: String(deposit.dueDays) })}</dd>
            </div>
          ) : null}
          {deposit.note ? (
            <div className="border-t border-border pt-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{t('senderNoteLabel')}: </span>
              {deposit.note}
            </div>
          ) : null}
        </dl>

        {deposit.signerNoticeAt ? (
          <Alert data-testid="sign-ceremony-deposit-noticed">
            <AlertDescription className="space-y-1 text-xs">
              <p className="font-medium text-foreground">{t('noticedBanner')}</p>
              {deposit.signerNoticeNote ? <p className="text-muted-foreground">{deposit.signerNoticeNote}</p> : null}
              {deposit.signerProofFilename ? (
                <p className="font-mono text-muted-foreground">
                  {t('proofRecordedLabel', { filename: deposit.signerProofFilename })}
                </p>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={(e) => void handleNoticeSubmit(e)} className="space-y-3 border-t border-border pt-3" data-testid="sign-ceremony-deposit-notice-form">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-note`} className="text-xs">
              {t('noticeNoteLabel')}
            </Label>
            <Input
              id={`${idPrefix}-note`}
              className="max-md:min-h-11"
              value={noticeNote}
              maxLength={SIGN_DEPOSIT_NOTE_MAX}
              placeholder={t('noticeNotePlaceholder')}
              disabled={submittingNotice}
              onChange={(e) => setNoticeNote(e.target.value)}
              data-testid="sign-ceremony-deposit-note-input"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              id={`${idPrefix}-proof`}
              type="file"
              accept="image/png,image/jpeg,.png,.jpg,.jpeg"
              className="sr-only"
              onChange={handleProofPick}
              data-testid="sign-ceremony-deposit-proof-input"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-md:min-h-11"
              disabled={submittingNotice}
              onClick={() => fileInputRef.current?.click()}
              data-testid="sign-ceremony-deposit-proof-btn"
            >
              {noticeFile ? noticeFile.name : t('attachProofButton')}
            </Button>
            {noticeFile ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="max-md:min-h-11"
                disabled={submittingNotice}
                onClick={() => setNoticeFile(null)}
              >
                {t('removeProofButton')}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{t('proofHint')}</p>

          {noticeError ? <ErrorText>{noticeError}</ErrorText> : null}

          <Button
            type="submit"
            className="w-full max-md:min-h-11"
            loading={submittingNotice}
            data-testid="sign-ceremony-deposit-notice-submit"
          >
            {deposit.signerNoticeAt ? t('updateNoticeButton') : t('submitNoticeButton')}
          </Button>
        </form>
        <div role="status" aria-live="polite" className="sr-only" data-testid="sign-ceremony-deposit-copy-status">
          {copyStatus}
        </div>
      </CardContent>
    </Card>
  );
}
