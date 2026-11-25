// SPDX-License-Identifier: AGPL-3.0-only
// Organization default VietQR deposit bank profile settings card for eSign Settings (#4723).
// Owners/admins manage receiving bank metadata and optional <= 256 KB static VietQR PNG; members see read-only details.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { ACCOUNT_CODE_PATTERN, normalizeAccountCode } from '@ludy/kernel-contract';
import { bankByCode } from '@ludy/l10n-vn';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { BankSelect } from '../bank-select.tsx';
import { ConfirmDialog } from '../confirm-dialog.tsx';
import { ErrorText, ListSkeleton } from '../ui.tsx';
import { errorMessage, queryClient } from '../../lib/api.ts';
import { downloadSignFile, signApi, type SignDepositProfileContract } from '../../lib/sign-api.ts';
import { rawBase64ToPngDataUrl, readPngFileAsDataUrl, stripPngDataUrlPrefix } from '../../lib/sign-signature.ts';
import { toast } from '../../lib/toast.ts';

export function shouldSyncDepositProfileForm(params: {
  prevSlug: string | null;
  slug: string | null;
  dirty: boolean;
}): boolean {
  return params.prevSlug !== params.slug || !params.dirty;
}

export function canRemoveDepositProfileQr(params: {
  savedFileId: string | null;
  clearStoredQr: boolean;
  pendingPngBase64: string | null;
}): boolean {
  return Boolean((params.savedFileId && !params.clearStoredQr) || params.pendingPngBase64);
}

export function normalizeDepositDestination(
  bankCode: string,
  accountNumber: string,
): { bankCode: string; accountNumber: string } {
  return {
    bankCode: bankCode.trim().toUpperCase(),
    accountNumber: accountNumber.replace(/\s+/g, '').trim(),
  };
}

export function didDepositDestinationChange(
  prev: { bankCode: string; accountNumber: string },
  next: { bankCode: string; accountNumber: string },
): boolean {
  return prev.bankCode !== next.bankCode || prev.accountNumber !== next.accountNumber;
}

function ProfileFormBody({
  profile,
  canEdit,
  slug,
}: {
  profile: SignDepositProfileContract | null;
  canEdit: boolean;
  slug: string | null;
}) {
  const t = useTranslations('sign.depositProfile');
  const idPrefix = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const selectionGenRef = useRef(0);
  const readingTargetRef = useRef<{ bankCode: string; accountNumber: string } | null>(null);
  const prevSlugRef = useRef(slug);

  const [dirty, setDirty] = useState(false);
  const [readingPng, setReadingPng] = useState(false);
  const [bankCode, setBankCode] = useState(profile?.bankCode ?? '');
  const [bankName, setBankName] = useState(profile?.bankName ?? '');
  const [accountNumber, setAccountNumber] = useState(profile?.accountNumber ?? '');
  const [accountHolder, setAccountHolder] = useState(profile?.accountHolder ?? '');
  const [financeBankAccount, setFinanceBankAccount] = useState(profile?.financeBankAccount ?? '');
  const [pendingPngBase64, setPendingPngBase64] = useState<string | null>(null);
  const [pendingPngTarget, setPendingPngTarget] = useState<{ bankCode: string; accountNumber: string } | null>(null);
  const [clearStoredQr, setClearStoredQr] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmClearProfileId, setConfirmClearProfileId] = useState<string | null>(null);
  const [savedQrUrl, setSavedQrUrl] = useState<string | null>(null);

  useEffect(() => {
    const slugChanged = prevSlugRef.current !== slug;
    const shouldSync = shouldSyncDepositProfileForm({
      prevSlug: prevSlugRef.current,
      slug,
      dirty,
    });
    prevSlugRef.current = slug;
    if (slugChanged) {
      setConfirmClearProfileId(null);
    }
    if (!shouldSync) return;
    selectionGenRef.current += 1;
    readingTargetRef.current = null;
    setReadingPng(false);
    setDirty(false);
    setBankCode(profile?.bankCode ?? '');
    setBankName(profile?.bankName ?? '');
    setAccountNumber(profile?.accountNumber ?? '');
    setAccountHolder(profile?.accountHolder ?? '');
    setFinanceBankAccount(profile?.financeBankAccount ?? '');
    setPendingPngBase64(null);
    setPendingPngTarget(null);
    setClearStoredQr(false);
    setLocalError(null);
  }, [profile, slug, dirty]);

  const savedFileId = profile?.vietqrFileId ?? null;
  useEffect(() => {
    if (!savedFileId || clearStoredQr || pendingPngBase64) {
      setSavedQrUrl(null);
      return;
    }
    let active = true;
    let objectUrl: string | null = null;
    void downloadSignFile(savedFileId)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setSavedQrUrl(objectUrl);
      })
      .catch(() => {
        if (active) setSavedQrUrl(null);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [savedFileId, clearStoredQr, pendingPngBase64]);

  const invalidateProfile = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sign', 'deposit-profile', slug] });
  };

  const upsertMutation = useMutation({
    mutationFn: () => {
      const trimmedAccount = accountNumber.trim();
      const trimmedHolder = accountHolder.trim();
      const trimmedBankName = bankName.trim();
      const trimmedFinanceAcc = normalizeAccountCode(financeBankAccount);
      return signApi.upsertDepositProfile({
        ...(profile?.id ? { id: profile.id } : {}),
        bankCode,
        ...(trimmedBankName ? { bankName: trimmedBankName } : {}),
        accountNumber: trimmedAccount,
        accountHolder: trimmedHolder,
        financeBankAccount: trimmedFinanceAcc.length > 0 ? trimmedFinanceAcc : null,
        ...(pendingPngBase64
          ? { vietqrPngBase64: pendingPngBase64 }
          : clearStoredQr
            ? { clearVietqr: true }
            : {}),
      });
    },
    onSuccess: async () => {
      selectionGenRef.current += 1;
      readingTargetRef.current = null;
      setReadingPng(false);
      setDirty(false);
      toast(t('savedToast'));
      setPendingPngBase64(null);
      setPendingPngTarget(null);
      setClearStoredQr(false);
      await invalidateProfile();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const clearMutation = useMutation({
    mutationFn: (expectedId: string) => signApi.clearDepositProfile({ expectedId }),
    onSuccess: async () => {
      selectionGenRef.current += 1;
      readingTargetRef.current = null;
      setReadingPng(false);
      setDirty(false);
      toast(t('clearedToast'));
      setPendingPngBase64(null);
      setPendingPngTarget(null);
      setClearStoredQr(false);
      setConfirmClearProfileId(null);
      await invalidateProfile();
    },
    onError: (err) => {
      const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code : null;
      if (code === 'SIGN_DEPOSIT_PROFILE_CHANGED') {
        setConfirmClearProfileId(null);
        void invalidateProfile();
      }
      toast(errorMessage(err), 'error');
    },
  });

  const resetQrSelectionIfDestinationChanged = (
    nextBankCode: string,
    nextAccountNumber: string,
    clearNonDestinationError: boolean,
  ) => {
    const nextTarget = normalizeDepositDestination(nextBankCode, nextAccountNumber);
    const activeTarget = pendingPngBase64 ? pendingPngTarget : readingPng ? readingTargetRef.current : null;
    if (activeTarget && didDepositDestinationChange(activeTarget, nextTarget)) {
      selectionGenRef.current += 1;
      readingTargetRef.current = null;
      setReadingPng(false);
      setPendingPngBase64(null);
      setPendingPngTarget(null);
      setLocalError(t('qrClearedOnDestinationChange'));
      return;
    }
    if (clearNonDestinationError) {
      setLocalError(null);
    }
  };

  const handleBankChange = (nextCode: string) => {
    setDirty(true);
    setBankCode(nextCode);
    const found = bankByCode(nextCode);
    if (found) {
      setBankName(found.name);
    } else if (!nextCode) {
      setBankName('');
    }
    resetQrSelectionIfDestinationChanged(nextCode, accountNumber, true);
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const pickGen = ++selectionGenRef.current;
    const selectedTarget = normalizeDepositDestination(bankCode, accountNumber);
    readingTargetRef.current = selectedTarget;
    setLocalError(null);
    setReadingPng(true);
    try {
      const dataUrl = await readPngFileAsDataUrl(file);
      if (selectionGenRef.current !== pickGen) return;
      const b64 = stripPngDataUrlPrefix(dataUrl);
      setDirty(true);
      setPendingPngBase64(b64);
      setPendingPngTarget(selectedTarget);
      setClearStoredQr(false);
    } catch {
      if (selectionGenRef.current !== pickGen) return;
      setLocalError(t('invalidQrPng'));
    } finally {
      if (selectionGenRef.current === pickGen) {
        readingTargetRef.current = null;
        setReadingPng(false);
      }
    }
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (readingPng || upsertMutation.isPending || clearMutation.isPending) return;
    setLocalError(null);
    if (!bankCode) {
      setLocalError(t('bankRequired'));
      return;
    }
    const acct = accountNumber.trim();
    if (acct.length < 4 || acct.length > 34) {
      setLocalError(t('accountNumberRequired'));
      return;
    }
    if (!accountHolder.trim()) {
      setLocalError(t('accountHolderRequired'));
      return;
    }
    const glCode = normalizeAccountCode(financeBankAccount);
    if (glCode.length > 0 && !ACCOUNT_CODE_PATTERN.test(glCode)) {
      setLocalError(t('invalidFinanceAccount'));
      return;
    }
    upsertMutation.mutate();
  };

  const previewDataUrl = pendingPngBase64 ? rawBase64ToPngDataUrl(pendingPngBase64) : savedQrUrl;
  const canRemoveQr = canRemoveDepositProfileQr({
    savedFileId,
    clearStoredQr,
    pendingPngBase64,
  });
  const bankObj = bankCode ? bankByCode(bankCode) : undefined;
  const hasVerifiedBin = Boolean(bankObj?.napasBin);

  if (!canEdit) {
    if (!profile) {
      return (
        <p className="text-sm text-muted-foreground" data-testid="sign-deposit-profile-empty-readonly">
          {t('emptyReadonly')}
        </p>
      );
    }
    return (
      <div className="space-y-3 text-sm" data-testid="sign-deposit-profile-readonly">
        <dl className="grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">{t('bankLabel')}</dt>
            <dd className="font-medium text-foreground">{profile.bankName}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('accountNumberLabel')}</dt>
            <dd className="font-mono font-medium text-foreground">{profile.accountNumber}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('accountHolderLabel')}</dt>
            <dd className="font-medium text-foreground">{profile.accountHolder}</dd>
          </div>
          {profile.financeBankAccount ? (
            <div>
              <dt className="text-xs text-muted-foreground">{t('financeBankAccountLabel')}</dt>
              <dd className="font-mono text-foreground">{profile.financeBankAccount}</dd>
            </div>
          ) : null}
        </dl>
        {previewDataUrl ? (
          <div className="w-fit rounded-lg border border-border bg-image-surface p-2">
            <img src={previewDataUrl} alt={t('qrPreviewAlt')} className="h-36 w-36 object-contain" />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4" data-testid="sign-deposit-profile-form">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-bank`} className="text-xs">
              {t('bankLabel')}
            </Label>
            <BankSelect
              id={`${idPrefix}-bank`}
              value={bankCode}
              disabled={upsertMutation.isPending}
              onChange={handleBankChange}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-bank-name`} className="text-xs">
              {t('bankDisplayNameLabel')}
            </Label>
            <Input
              id={`${idPrefix}-bank-name`}
              className="max-md:min-h-11"
              value={bankName}
              maxLength={200}
              disabled={upsertMutation.isPending}
              onChange={(e) => {
                setDirty(true);
                setBankName(e.target.value);
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-account-number`} className="text-xs">
              {t('accountNumberLabel')}
            </Label>
            <Input
              id={`${idPrefix}-account-number`}
              className="font-mono max-md:min-h-11"
              value={accountNumber}
              maxLength={34}
              autoComplete="off"
              disabled={upsertMutation.isPending}
              onChange={(e) => {
                const nextAccountNumber = e.target.value;
                setDirty(true);
                setAccountNumber(nextAccountNumber);
                resetQrSelectionIfDestinationChanged(bankCode, nextAccountNumber, false);
              }}
              data-testid="sign-deposit-account-number"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${idPrefix}-account-holder`} className="text-xs">
              {t('accountHolderLabel')}
            </Label>
            <Input
              id={`${idPrefix}-account-holder`}
              className="max-md:min-h-11"
              value={accountHolder}
              maxLength={200}
              disabled={upsertMutation.isPending}
              onChange={(e) => {
                setDirty(true);
                setAccountHolder(e.target.value);
              }}
              data-testid="sign-deposit-account-holder"
            />
          </div>

          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor={`${idPrefix}-finance-account`} className="text-xs">
              {t('financeBankAccountLabel')}
            </Label>
            <Input
              id={`${idPrefix}-finance-account`}
              className="font-mono md:max-w-xs max-md:min-h-11"
              value={financeBankAccount}
              maxLength={31}
              placeholder="1121"
              disabled={upsertMutation.isPending}
              onChange={(e) => {
                setDirty(true);
                setFinanceBankAccount(e.target.value);
              }}
              data-testid="sign-deposit-finance-account"
            />
            <p className="text-xs text-muted-foreground">{t('financeBankAccountHint')}</p>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p id={`${idPrefix}-qr-png-label`} className="text-xs font-medium text-foreground">
                {t('qrPngLabel')}
              </p>
              <p id={`${idPrefix}-qr-png-hint`} className="text-xs text-muted-foreground">
                {t('qrPngHint')}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                id={`${idPrefix}-qr-png`}
                type="file"
                accept="image/png"
                tabIndex={-1}
                aria-hidden="true"
                className="sr-only"
                onChange={(e) => void handleFileChange(e)}
                data-testid="sign-deposit-qr-file-input"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="max-md:min-h-11"
                disabled={upsertMutation.isPending}
                aria-describedby={`${idPrefix}-qr-png-label ${idPrefix}-qr-png-hint`}
                onClick={() => fileInputRef.current?.click()}
                data-testid="sign-deposit-qr-upload-btn"
              >
                {t('uploadQrPng')}
              </Button>
              {canRemoveQr ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="max-md:min-h-11"
                  disabled={upsertMutation.isPending}
                  onClick={() => {
                    selectionGenRef.current += 1;
                    readingTargetRef.current = null;
                    setReadingPng(false);
                    setDirty(true);
                    setPendingPngBase64(null);
                    setPendingPngTarget(null);
                    setClearStoredQr(true);
                  }}
                  data-testid="sign-deposit-qr-clear-btn"
                >
                  {t('removeQrPng')}
                </Button>
              ) : null}
            </div>
          </div>

          {previewDataUrl ? (
            <div className="flex items-center gap-3 pt-1">
              <div className="w-fit rounded-lg border border-border bg-image-surface p-2">
                <img
                  src={previewDataUrl}
                  alt={t('qrPreviewAlt')}
                  className="h-28 w-28 object-contain"
                  data-testid="sign-deposit-qr-preview"
                />
              </div>
              {pendingPngBase64 ? <Badge variant="secondary">{t('pendingQrBadge')}</Badge> : null}
            </div>
          ) : null}

          {!previewDataUrl && !hasVerifiedBin && bankCode ? (
            <Alert data-testid="sign-deposit-no-bin-notice">
              <AlertDescription className="text-xs">{t('noVerifiedBinNotice')}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        {localError ? <ErrorText>{localError}</ErrorText> : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            className="max-md:min-h-11"
            loading={upsertMutation.isPending}
            disabled={readingPng || clearMutation.isPending}
            data-testid="sign-deposit-profile-save-btn"
          >
            {t('saveButton')}
          </Button>
          {profile ? (
            <Button
              type="button"
              variant="outline"
              className="max-md:min-h-11"
              disabled={readingPng || upsertMutation.isPending || clearMutation.isPending}
              onClick={() => setConfirmClearProfileId(profile.id)}
              data-testid="sign-deposit-profile-clear-btn"
            >
              {t('clearButton')}
            </Button>
          ) : null}
        </div>
      </form>

      <ConfirmDialog
        open={confirmClearProfileId !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmClearProfileId(null);
        }}
        title={t('clearConfirmTitle')}
        description={t('clearConfirmBody')}
        confirm={t('clearConfirmAction')}
        disabled={clearMutation.isPending}
        destructive
        onConfirm={() => {
          if (!confirmClearProfileId) return;
          clearMutation.mutate(confirmClearProfileId);
        }}
      />
    </>
  );
}

export function SignDepositProfileSettingsCard({ slug }: { slug: string | null }) {
  const t = useTranslations('sign.depositProfile');
  const query = useQuery({
    queryKey: ['sign', 'deposit-profile', slug],
    queryFn: () => signApi.getDepositProfile(),
  });

  return (
    <Card id="sign-deposit-profile" data-testid="sign-deposit-profile-card">
      <CardHeader className="space-y-1">
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        {query.isPending ? (
          <ListSkeleton rows={3} />
        ) : query.data ? (
          <div className="space-y-3">
            {query.error ? <ErrorText>{errorMessage(query.error)}</ErrorText> : null}
            <ProfileFormBody profile={query.data.profile} canEdit={query.data.canEdit} slug={slug} />
          </div>
        ) : query.error ? (
          <ErrorText>{errorMessage(query.error)}</ErrorText>
        ) : null}
      </CardContent>
    </Card>
  );
}
