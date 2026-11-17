import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { brandName } from '../i18n/brand.ts';
import { auth, authErrorText, authFailure, type AuthFailure, verifySecondFactor } from '../lib/auth.ts';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { CardSkeleton, ErrorText, fieldControl, fieldErrorId, Notice, Spinner } from './ui.tsx';

interface Enrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

// A Supabase Auth error as a screen keeps it: by code or server message, worded at render (issue #215).
function failureOf(error: unknown): AuthFailure {
  return authFailure(error as { code?: string; message: string });
}

// The signed-in user's Supabase Auth MFA factors; `totp` lists the verified ones.
export function useFactors() {
  return useQuery({
    queryKey: ['auth', 'factors'],
    queryFn: async () => {
      const { data, error } = await auth().mfa.listFactors();
      if (error) throw error;
      return data;
    },
  });
}

// Verifies a code from the user's authenticator app, which raises the session to aal2.
export function MfaChallengeForm({ onVerified }: { onVerified: () => Promise<void> | void }) {
  const root = useTranslations();
  const t = useTranslations('twoFactor');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  // The code field names the error under it (#1515), and takes the focus back after a refused code.
  const codeId = useId();
  const codeInput = useRef<HTMLInputElement>(null);
  // A Supabase Auth failure, or 'noFactor'; worded at render.
  const [error, setError] = useState<AuthFailure | 'noFactor' | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data: factors, error: listError } = await auth().mfa.listFactors();
      if (listError) return setError(authFailure(listError));
      const factor = factors.totp[0];
      if (!factor) return setError('noFactor');
      const { error: verifyError } = await verifySecondFactor({ factorId: factor.id, code: code.trim() });
      if (verifyError) {
        setCode('');
        setError(authFailure(verifyError));
        codeInput.current?.focus();
        return;
      }
      await onVerified();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="space-y-3" onSubmit={submit}>
      <Label className="flex-col items-stretch gap-1 font-normal">
        <span className="text-muted-foreground">{t('code')}</span>
        <Input
          ref={codeInput}
          {...fieldControl(codeId, { error: Boolean(error) })}
          required
          autoFocus
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          placeholder={t('codePlaceholder')}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </Label>
      {error && <ErrorText id={fieldErrorId(codeId)}>{error === 'noFactor' ? t('noFactor') : authErrorText(error, root)}</ErrorText>}
      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? t('checking') : t('confirm')}
      </Button>
    </form>
  );
}

// TOTP enrollment for the signed-in user (Supabase Auth MFA). A verified factor makes the next sign-in aal2.
// `bare` leaves the card frame, the title and the on/off badge to the caller (a dialog that names the step itself).
export function TwoFactorCard({ onEnabled, bare = false }: { onEnabled?: () => void; bare?: boolean }) {
  const root = useTranslations();
  const t = useTranslations('twoFactor');
  const factors = useFactors();
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  // Kept as a code or message key and worded at render, so a language switch rewords them (issue #215).
  const [error, setError] = useState<AuthFailure | null>(null);
  // While the setup form is open, a refusal is about the code it asks for: the field names it and takes the focus back
  // (#1515).
  const codeId = useId();
  const codeInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<'enabled' | 'disabled' | null>(null);
  const verified = factors.data?.totp ?? [];

  async function run(action: () => Promise<AuthFailure | null>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setError(await action());
    } finally {
      setBusy(false);
      await factors.refetch();
    }
  }

  const start = () =>
    run(async () => {
      // An abandoned setup leaves an unverified factor behind; remove it so they do not pile up.
      for (const f of factors.data?.all ?? []) {
        if (f.factor_type === 'totp' && f.status !== 'verified') await auth().mfa.unenroll({ factorId: f.id });
      }
      const { data, error: e } = await auth().mfa.enroll({ factorType: 'totp', issuer: brandName() });
      if (e) return authFailure(e);
      setCode('');
      setEnrollment({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
      return null;
    });

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    if (!enrollment) return;
    void run(async () => {
      const { error: e } = await verifySecondFactor({ factorId: enrollment.factorId, code: code.trim() });
      if (e) {
        setCode('');
        codeInput.current?.focus();
        return authFailure(e);
      }
      setEnrollment(null);
      setNotice('enabled');
      onEnabled?.();
      return null;
    });
  };

  const cancel = () =>
    run(async () => {
      if (enrollment) await auth().mfa.unenroll({ factorId: enrollment.factorId });
      setEnrollment(null);
      return null;
    });

  // Asked first in a dialog (ConfirmDialog below).
  const disable = (factorId: string) => {
    void run(async () => {
      const { error: e } = await auth().mfa.unenroll({ factorId });
      if (e) return authFailure(e);
      setNotice('disabled');
      return null;
    });
  };

  const Frame = bare ? 'div' : Card;
  return (
    <Frame className={bare ? 'block' : 'block p-4'}>
      {!bare && (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-muted-foreground">{t('title')}</p>
            {factors.isSuccess && (verified.length > 0 ? <Badge variant="success">{t('on')}</Badge> : <Badge variant="secondary">{t('off')}</Badge>)}
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{t('intro')}</p>
        </>
      )}
      <div className={bare ? 'space-y-3' : 'mt-4 space-y-3'}>
        {factors.isLoading && <Spinner />}
        {factors.error && <ErrorText>{authErrorText(failureOf(factors.error), root)}</ErrorText>}
        {enrollment ? (
          <form className="space-y-3" onSubmit={confirm}>
            <p className="text-sm text-muted-foreground">{t('scan')}</p>
            {/* The QR code draws black modules on a transparent background: it needs a light backdrop in both themes. */}
            <img src={enrollment.qrCode} alt={t('qrAlt')} className="h-44 w-44 rounded-lg bg-primary-foreground p-2" />
            <div className="text-xs text-subtle-foreground">
              {t('manualKey')}
              <code className="mt-1 block break-all font-mono text-sm text-foreground" aria-label={t('setupKey')}>
                {enrollment.secret}
              </code>
            </div>
            <Label className="flex-col items-stretch gap-1 font-normal">
              <span className="text-muted-foreground">{t('code')}</span>
              <Input
                ref={codeInput}
                {...fieldControl(codeId, { error: Boolean(error) })}
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                placeholder={t('codePlaceholder')}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </Label>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                {t('confirm')}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancel()}>
                {root('common.cancel')}
              </Button>
            </div>
          </form>
        ) : factors.isSuccess && verified.length > 0 ? (
          verified.map((f) => (
            <ConfirmDialog
              key={f.id}
              render={<Button variant="destructive" />}
              disabled={busy}
              title={t('disableTitle')}
              description={t('disableDescription')}
              confirm={t('disableConfirm')}
              destructive
              onConfirm={() => disable(f.id)}
            >
              {t('disable')}
            </ConfirmDialog>
          ))
        ) : (
          factors.isSuccess && (
            <Button loading={busy} onClick={() => void start()}>
              {t('enable')}
            </Button>
          )
        )}
        {error && <ErrorText id={enrollment ? fieldErrorId(codeId) : undefined}>{authErrorText(error, root)}</ErrorText>}
        {notice && <Notice>{t(notice)}</Notice>}
      </div>
    </Frame>
  );
}

// Shown when the kernel answers STEP_UP_REQUIRED (policy P11): approving and other R3 work need a second factor
// verified in the last 5 minutes. With a factor, the user enters a fresh code; without one, they enable it here
// (or, where `enroll` is false, in the two-factor card on the same page). Either way `onVerified` repeats the request
// that was refused, which `action` names; `onCancel` drops it.
export function StepUpPrompt({
  action,
  onVerified,
  onCancel,
  enroll = true,
}: {
  action: string;
  onVerified: () => void;
  onCancel?: () => void;
  enroll?: boolean;
}) {
  const root = useTranslations();
  const t = useTranslations('twoFactor.stepUp');
  const factors = useFactors();
  if (factors.isLoading) return <CardSkeleton className="max-w-sm" />;
  if (factors.error) return <ErrorText>{authErrorText(failureOf(factors.error), root)}</ErrorText>;
  const pending = <p className="text-sm text-muted-foreground">{t('pending', { action })}</p>;
  const cancel = onCancel && (
    <Button type="button" variant="ghost" onClick={onCancel}>
      {t('cancel')}
    </Button>
  );
  if ((factors.data?.totp.length ?? 0) > 0) {
    return (
      <Card className="block max-w-sm space-y-3 p-4">
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-sm text-muted-foreground">{t('recent')}</p>
        {pending}
        <MfaChallengeForm onVerified={onVerified} />
        {cancel}
      </Card>
    );
  }
  return (
    <div className="max-w-md space-y-3">
      <p className="text-sm text-muted-foreground">{enroll ? t('enrollHere') : t('enrollBeside')}</p>
      {pending}
      {enroll && <TwoFactorCard onEnabled={onVerified} />}
      {cancel}
    </div>
  );
}

// The step-up of an R3 action as a small dialog over the screen, not a card in the middle of it (#3599): the page behind does not move, Escape or the close button
// drops the request (`onCancel`), and a fresh code (or a factor enabled here) repeats the refused request through `onVerified` as StepUpPrompt does. Focus goes back to
// the element `returnFocus` names (the button that asked), else to where it was before. The rule is the kernel's and is not decided here.
export function StepUpDialog({
  open,
  action,
  onVerified,
  onCancel,
  returnFocus,
}: {
  open: boolean;
  action: string;
  onVerified: () => Promise<void> | void;
  onCancel: () => void;
  returnFocus?: () => HTMLElement | null;
}) {
  const root = useTranslations();
  const t = useTranslations('twoFactor.stepUp');
  const factors = useFactors();
  const enrolled = (factors.data?.totp.length ?? 0) > 0;
  // Closing the dialog ends the attempt: a code or an enrollment that finishes afterwards, even once the dialog is open again, must not repeat the refused request
  // (an approval the person cancelled). Each render hands its form the attempt it belongs to; a cancel moves the counter on.
  const attempt = useRef(0);
  const mine = attempt.current;
  const verified = () => (attempt.current === mine ? onVerified() : undefined);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        attempt.current += 1;
        onCancel();
      }}
    >
      <DialogContent closeLabel={root('common.close')} finalFocus={() => returnFocus?.() ?? true}>
        <DialogHeader>
          <DialogTitle>{factors.isSuccess && !enrolled ? t('enrollTitle') : t('title')}</DialogTitle>
          <DialogDescription>{factors.isSuccess && !enrolled ? t('enrollHere') : t('recent')}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{t('pending', { action })}</p>
        {factors.isLoading && <CardSkeleton />}
        {factors.error && <ErrorText>{authErrorText(failureOf(factors.error), root)}</ErrorText>}
        {factors.isSuccess && (enrolled ? <MfaChallengeForm onVerified={verified} /> : <TwoFactorCard bare onEnabled={verified} />)}
      </DialogContent>
    </Dialog>
  );
}

// Offered before the first approval needs it (#3599): one sentence on why and a button that opens the setup in a dialog, so the owner is not met by an authenticator
// app in the middle of a proposal. Shown only while `show` holds (the caller knows who approves) and the account has no verified factor; "Để sau" hides it for this
// browser session. Whether two-factor is required stays the kernel's rule (R3 step-up).
const OFFER_HIDDEN_KEY = 'ludy.twoFactorOfferHidden';
function offerHidden(): boolean {
  try {
    return window.sessionStorage.getItem(OFFER_HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

// returnFocus: a control that stays on the page once the offer is gone, where focus goes when the setup is done (the offer, and the button that opened the dialog, unmount).
export function TwoFactorOffer({ show = true, returnFocus }: { show?: boolean; returnFocus?: () => HTMLElement | null }) {
  const t = useTranslations('twoFactor.offer');
  const root = useTranslations();
  const factors = useFactors();
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(offerHidden);
  if (!show || hidden || !factors.isSuccess || factors.data.totp.length > 0) return null;
  const hide = () => {
    try {
      window.sessionStorage.setItem(OFFER_HIDDEN_KEY, '1');
    } catch {
      // Without storage the banner returns on the next visit, which is harmless.
    }
    setHidden(true);
  };
  return (
    <div role="region" aria-label={t('title')} data-testid="two-factor-offer" className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/40 p-3">
      <div className="min-w-0 flex-1 basis-64">
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-sm text-muted-foreground">{t('text')}</p>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => setOpen(true)}>{t('action')}</Button>
        <Button variant="ghost" onClick={hide}>
          {t('later')}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={root('common.close')} finalFocus={() => returnFocus?.() ?? true}>
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogDescription')}</DialogDescription>
          </DialogHeader>
          <TwoFactorCard
            bare
            onEnabled={() => {
              setOpen(false);
              returnFocus?.()?.focus();
              void factors.refetch();
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
