// SPDX-License-Identifier: AGPL-3.0-only
// Mobile-first public direct signing link ceremony (/-/sign/d#<token>, zero query tokens, zero CAPTCHA, optional OTP gate) (#3551).
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { PdfCanvasViewer } from '../components/sign/pdf-canvas-viewer.tsx';
import { CounterpartySummaryBanner } from '../components/sign/shared-summary-card.tsx';
import { ErrorText, ListSkeleton, Logo, ScreenTitle } from '../components/ui.tsx';
import {
  publicDirectSignApi,
  PublicSignError,
  type PublicDirectSignViewState,
} from '../lib/sign-api.ts';
import {
  buildSigningUrl,
  forgetDirectSignToken,
  pendingDirectSignToken,
  pendingSignToken,
  readSignTokenFromHash,
  rememberDirectSignToken,
  rememberSignToken,
  scrubSignTokenHash,
  SIGN_PAGE_PATH,
  subscribeToHash,
} from '../lib/sign-hash.ts';
import { toast } from '../lib/toast.ts';

type DirectReadyView = Extract<PublicDirectSignViewState, { state: 'ready' }>;
type DirectOtpView = Extract<PublicDirectSignViewState, { state: 'otp_required' }>;

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isOtpRequiredError(error: unknown): error is PublicSignError {
  return (
    error instanceof PublicSignError &&
    (error.code === 'OTP_REQUIRED' || error.code === 'SIGN_OTP_REQUIRED' || error.code === 'SIGN_OTP_EMAIL_MISMATCH')
  );
}

export function extractInitialDirectToken(): string | null {
  const hadHash = typeof window !== 'undefined' && Boolean(window.location.hash);
  const fromHash = readSignTokenFromHash();
  if (hadHash) {
    scrubSignTokenHash();
  }
  if (fromHash) {
    rememberDirectSignToken(fromHash);
    return fromHash;
  }
  if (hadHash) {
    forgetDirectSignToken();
    return null;
  }
  return pendingDirectSignToken();
}

export function validateDirectStartForm(input: {
  name: string;
  email: string;
  emailRequired: boolean;
}): { ok: true; name: string; email: string | null } | { ok: false; errorKey: 'nameRequiredError' | 'emailRequiredError' | 'emailInvalidError' } {
  const cleanName = input.name.trim();
  if (!cleanName || cleanName.length > 200) {
    return { ok: false, errorKey: 'nameRequiredError' };
  }
  const cleanEmail = input.email.trim().toLowerCase();
  if (!cleanEmail) {
    if (input.emailRequired) {
      return { ok: false, errorKey: 'emailRequiredError' };
    }
    return { ok: true, name: cleanName, email: null };
  }
  if (cleanEmail.length > 254 || !SIMPLE_EMAIL_PATTERN.test(cleanEmail)) {
    return { ok: false, errorKey: 'emailInvalidError' };
  }
  return { ok: true, name: cleanName, email: cleanEmail };
}

export function handoffDirectSigningToken(
  signingToken: string,
  navigate: (opts: { to: string; replace?: boolean }) => unknown,
  replaceLocation?: (url: string) => void,
): 'session' | 'hash_fallback' {
  forgetDirectSignToken();
  rememberSignToken(signingToken);
  if (pendingSignToken() === signingToken) {
    void navigate({ to: SIGN_PAGE_PATH, replace: true });
    return 'session';
  }
  const fallbackUrl = buildSigningUrl(signingToken);
  if (replaceLocation) {
    replaceLocation(fallbackUrl);
  } else if (typeof window !== 'undefined') {
    window.location.replace(fallbackUrl);
  }
  return 'hash_fallback';
}

export interface SignDirectOtpCardProps {
  viewState: DirectOtpView;
  email: string;
  otpCode: string;
  otpSent: boolean;
  maskedEmail: string | null;
  otpSending: boolean;
  otpVerifying: boolean;
  otpLocked: boolean;
  otpError: string | null;
  onEmailChange: (value: string) => void;
  onOtpCodeChange: (value: string) => void;
  onRequestOtp: () => void;
  onVerifyOtp: (event: React.FormEvent<HTMLFormElement>) => void;
}

export function SignDirectOtpCard({
  viewState,
  email,
  otpCode,
  otpSent,
  maskedEmail,
  otpSending,
  otpVerifying,
  otpLocked,
  otpError,
  onEmailChange,
  onOtpCodeChange,
  onRequestOtp,
  onVerifyOtp,
}: SignDirectOtpCardProps) {
  const t = useTranslations('sign.direct');
  const emailValid = SIMPLE_EMAIL_PATTERN.test(email.trim());

  return (
    <Card className="mx-auto max-w-md" data-testid="sign-direct-otp">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">
            {viewState.signerRole === 'approver' ? t('roleBadgeApprover') : t('roleBadgeSigner')}
          </Badge>
          {viewState.roleLabel ? (
            <span className="text-xs font-medium text-muted-foreground">{viewState.roleLabel}</span>
          ) : null}
          {viewState.orgName ? (
            <span className="text-xs text-muted-foreground">· {viewState.orgName}</span>
          ) : null}
        </div>
        <CardTitle className="text-lg leading-snug">{viewState.title}</CardTitle>
        <CardDescription>{t('otpHint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {otpSent && !otpError ? (
          <p
            className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
            role="status"
            data-testid="direct-otp-sent-notice"
          >
            {t('otpSentHint', { email: maskedEmail ?? email.trim() })}
          </p>
        ) : null}
        {otpError ? <ErrorText>{otpError}</ErrorText> : null}

        <div className="space-y-2">
          <Label htmlFor="direct-otp-email">{t('otpEmailLabel')}</Label>
          <Input
            id="direct-otp-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder={t('otpEmailPlaceholder')}
            value={email}
            onChange={(e) => onEmailChange(e.target.value)}
            className="min-h-11"
            data-testid="direct-otp-email-input"
          />
          <Button
            type="button"
            variant="outline"
            className="min-h-11 w-full"
            disabled={!emailValid}
            loading={otpSending}
            onClick={onRequestOtp}
            data-testid="direct-otp-request-btn"
          >
            {otpSent ? t('otpResend') : t('otpSend')}
          </Button>
        </div>

        <form onSubmit={onVerifyOtp} className="space-y-3 border-t pt-3">
          <div className="space-y-1.5">
            <Label htmlFor="direct-otp-code">{t('otpCodeLabel')}</Label>
            <Input
              id="direct-otp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otpCode}
              disabled={otpLocked}
              onChange={(e) => onOtpCodeChange(e.target.value)}
              className="min-h-11 text-center font-mono text-lg tracking-widest"
              data-testid="direct-otp-code-input"
            />
          </div>
          <Button
            type="submit"
            className="min-h-11 w-full"
            disabled={!emailValid || otpLocked || otpCode.trim().length < 6}
            loading={otpVerifying}
            data-testid="direct-otp-verify-btn"
          >
            {t('otpVerifyButton')}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export interface SignDirectReadyViewProps {
  viewState: DirectReadyView;
  name: string;
  email: string;
  starting: boolean;
  startError: string | null;
  pdfBytes: Uint8Array | null;
  loadingPdf: boolean;
  pdfError: string | null;
  pageNumber: number;
  scale: number;
  onNameChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPageChange: (page: number) => void;
  onScaleChange: (scale: number) => void;
  onStart: (event: React.FormEvent<HTMLFormElement>) => void;
}

export function SignDirectReadyView({
  viewState,
  name,
  email,
  starting,
  startError,
  pdfBytes,
  loadingPdf,
  pdfError,
  pageNumber,
  scale,
  onNameChange,
  onEmailChange,
  onPageChange,
  onScaleChange,
  onStart,
}: SignDirectReadyViewProps) {
  const t = useTranslations('sign.direct');
  const isApprover = viewState.signerRole === 'approver';
  const emailLocked = Boolean(viewState.otpVerified && viewState.verifiedEmail);

  return (
    <div className="space-y-4" data-testid="sign-direct-ready">
      <Card>
        <CardHeader className="space-y-2 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">
              {isApprover ? t('roleBadgeApprover') : t('roleBadgeSigner')}
            </Badge>
            {viewState.roleLabel ? (
              <span className="text-xs font-medium text-muted-foreground">{viewState.roleLabel}</span>
            ) : null}
            {viewState.orgName ? (
              <span className="text-xs text-muted-foreground">· {viewState.orgName}</span>
            ) : null}
            {emailLocked && viewState.verifiedEmail ? (
              <Badge variant="secondary" data-testid="direct-verified-email-badge">
                {t('verifiedEmailBadge', { email: viewState.verifiedEmail })}
              </Badge>
            ) : null}
          </div>
          <CardTitle className="text-xl leading-snug">{viewState.title}</CardTitle>
          {viewState.description ? <CardDescription>{viewState.description}</CardDescription> : null}
        </CardHeader>
        {viewState.message ? (
          <CardContent className="pt-0">
            <div className="rounded-md border bg-muted/40 px-3 py-2.5 text-sm">
              <p className="mb-0.5 text-xs font-medium text-muted-foreground">{t('senderMessageLabel')}</p>
              <p className="whitespace-pre-line text-foreground">{viewState.message}</p>
            </div>
          </CardContent>
        ) : null}
      </Card>

      {viewState.sharedSummary ? (
        <CounterpartySummaryBanner
          sharedSummary={viewState.sharedSummary}
          pageCount={viewState.pageCount}
          onJumpToPage={onPageChange}
        />
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t('recipientCardTitle')}</CardTitle>
          <CardDescription>
            {isApprover ? t('recipientCardHintApprover') : t('recipientCardHintSigner')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onStart} className="space-y-3" data-testid="sign-direct-start-form">
            {startError ? <ErrorText>{startError}</ErrorText> : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="direct-recipient-name">{t('nameLabel')}</Label>
                <Input
                  id="direct-recipient-name"
                  autoComplete="name"
                  maxLength={200}
                  placeholder={t('namePlaceholder')}
                  value={name}
                  onChange={(e) => onNameChange(e.target.value)}
                  className="min-h-11"
                  data-testid="direct-recipient-name-input"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="direct-recipient-email">
                  {viewState.emailRequired ? t('emailLabel') : t('emailOptionalLabel')}
                </Label>
                <Input
                  id="direct-recipient-email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  maxLength={254}
                  placeholder={t('emailPlaceholder')}
                  value={emailLocked && viewState.verifiedEmail ? viewState.verifiedEmail : email}
                  readOnly={emailLocked}
                  disabled={emailLocked}
                  onChange={(e) => onEmailChange(e.target.value)}
                  className="min-h-11"
                  data-testid="direct-recipient-email-input"
                />
              </div>
            </div>

            <Button
              type="submit"
              className="min-h-11 w-full"
              loading={starting}
              data-testid="direct-start-btn"
            >
              {starting
                ? t('startingButton')
                : isApprover
                  ? t('startButtonApprover')
                  : t('startButtonSigner', { count: String(viewState.fieldCount) })}
            </Button>
          </form>
        </CardContent>
      </Card>

      <div className="space-y-2" data-testid="sign-direct-pdf-preview">
        {pdfError ? (
          <ErrorText>{pdfError}</ErrorText>
        ) : loadingPdf && !pdfBytes ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {t('pdfLoading')}
            </CardContent>
          </Card>
        ) : (
          <PdfCanvasViewer
            pdfBytes={pdfBytes}
            pageNumber={pageNumber}
            pageCount={viewState.pageCount}
            scale={scale}
            onPageChange={onPageChange}
            onScaleChange={onScaleChange}
          />
        )}
      </div>
    </div>
  );
}

export function SignDirectPage() {
  const t = useTranslations('sign.direct');
  const navigate = useNavigate();

  const [token, setToken] = useState<string | null>(() => extractInitialDirectToken());
  const [tokenEpoch, setTokenEpoch] = useState(0);
  const [otpSessionToken, setOtpSessionToken] = useState<string | null>(null);

  const [viewState, setViewState] = useState<PublicDirectSignViewState | null>(null);
  const [loadingView, setLoadingView] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);

  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(0.95);

  const [otpEmail, setOtpEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [maskedEmail, setMaskedEmail] = useState<string | null>(null);
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [otpLocked, setOtpLocked] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const requestGenRef = useRef(0);
  const linkSessionRef = useRef(0);

  const resetDirectTransientState = useCallback(() => {
    requestGenRef.current += 1;
    linkSessionRef.current += 1;
    setOtpSessionToken(null);
    setViewState(null);
    setLoadingView(false);
    setViewError(null);
    setPdfBytes(null);
    setLoadingPdf(false);
    setPdfError(null);
    setPageNumber(1);
    setOtpEmail('');
    setOtpCode('');
    setOtpSent(false);
    setMaskedEmail(null);
    setOtpSending(false);
    setOtpVerifying(false);
    setOtpLocked(false);
    setOtpError(null);
    setRecipientName('');
    setRecipientEmail('');
    setStarting(false);
    setStartError(null);
  }, []);

  useEffect(() => {
    return subscribeToHash(() => {
      const hadHash = typeof window !== 'undefined' && Boolean(window.location.hash);
      const next = readSignTokenFromHash();
      if (hadHash) {
        scrubSignTokenHash();
      }
      if (next) {
        rememberDirectSignToken(next);
        resetDirectTransientState();
        setToken(next);
        setTokenEpoch((n) => n + 1);
      } else if (hadHash) {
        forgetDirectSignToken();
        resetDirectTransientState();
        setToken(null);
      }
    });
  }, [resetDirectTransientState]);

  const loadView = useCallback(
    async (activeToken: string, activeClaim: string | null) => {
      const requestId = ++requestGenRef.current;
      const session = linkSessionRef.current;
      setLoadingView(true);
      setViewError(null);
      setPdfError(null);
      setPdfBytes(null);
      try {
        const view = await publicDirectSignApi.view(activeToken, activeClaim);
        if (requestGenRef.current !== requestId || linkSessionRef.current !== session) return;
        setViewState(view);
        if (view.state === 'ready') {
          if (view.verifiedEmail) {
            setRecipientEmail(view.verifiedEmail);
          }
          setLoadingPdf(true);
          try {
            const bytes = await publicDirectSignApi.pdf(activeToken, activeClaim);
            if (requestGenRef.current !== requestId || linkSessionRef.current !== session) return;
            setPdfBytes(bytes);
          } catch (pdfErr) {
            if (requestGenRef.current !== requestId || linkSessionRef.current !== session) return;
            if (isOtpRequiredError(pdfErr)) {
              setOtpSessionToken(null);
              setOtpSent(false);
              setOtpCode('');
              setViewState({
                state: 'otp_required',
                orgName: view.orgName,
                title: view.title,
                description: view.description,
                roleLabel: view.roleLabel,
                signerRole: view.signerRole,
                requireEmailOtp: true,
              });
            } else {
              setPdfError(t('invalidHint'));
            }
          } finally {
            if (requestGenRef.current === requestId && linkSessionRef.current === session) {
              setLoadingPdf(false);
            }
          }
        }
      } catch (error) {
        if (requestGenRef.current !== requestId || linkSessionRef.current !== session) return;
        if (error instanceof PublicSignError && error.status === 404) {
          forgetDirectSignToken();
        }
        setViewError(t('invalidHint'));
        setViewState(null);
      } finally {
        if (requestGenRef.current === requestId && linkSessionRef.current === session) {
          setLoadingView(false);
        }
      }
    },
    [t],
  );

  useEffect(() => {
    if (!token) return;
    void loadView(token, null);
  }, [token, tokenEpoch, loadView]);

  const handleRequestOtp = async () => {
    if (!token) return;
    const activeToken = token;
    const session = linkSessionRef.current;
    const cleanEmail = otpEmail.trim().toLowerCase();
    if (!SIMPLE_EMAIL_PATTERN.test(cleanEmail)) {
      setOtpError(t('emailInvalidError'));
      return;
    }
    setOtpSending(true);
    setOtpError(null);
    setOtpLocked(false);
    try {
      const res = await publicDirectSignApi.requestOtp(activeToken, cleanEmail);
      if (linkSessionRef.current !== session) return;
      setOtpSent(true);
      setMaskedEmail(res.maskedEmail ?? cleanEmail);
      setOtpCode('');
      toast(t('otpSentToast'));
    } catch (error) {
      if (linkSessionRef.current !== session) return;
      if (error instanceof PublicSignError && error.status === 404) {
        forgetDirectSignToken();
        setViewError(t('invalidHint'));
        setViewState(null);
        return;
      }
      setOtpError(error instanceof Error ? error.message : t('invalidHint'));
    } finally {
      if (linkSessionRef.current === session) {
        setOtpSending(false);
      }
    }
  };

  const handleVerifyOtp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;
    const activeToken = token;
    const session = linkSessionRef.current;
    const cleanEmail = otpEmail.trim().toLowerCase();
    setOtpVerifying(true);
    setOtpError(null);
    try {
      const res = await publicDirectSignApi.verifyOtp(activeToken, cleanEmail, otpCode.trim());
      if (linkSessionRef.current !== session) return;
      if (!res.ok) {
        if (res.locked) {
          setOtpLocked(true);
          setOtpError(t('otpLocked'));
          return;
        }
        if (res.expired) {
          setOtpError(t('otpExpired'));
          return;
        }
        if (res.notReady) {
          setOtpError(t('otpNotReady'));
          return;
        }
        setOtpError(t('otpInvalid', { attempts: String(res.attemptsRemaining) }));
        return;
      }
      const nextClaim = res.otpSessionToken ?? null;
      setOtpSessionToken(nextClaim);
      setRecipientEmail(res.verifiedEmail ?? cleanEmail);
      await loadView(activeToken, nextClaim);
    } catch (error) {
      if (linkSessionRef.current !== session) return;
      if (error instanceof PublicSignError && error.status === 404) {
        forgetDirectSignToken();
        setViewError(t('invalidHint'));
        setViewState(null);
        return;
      }
      setOtpError(error instanceof Error ? error.message : t('otpExpired'));
    } finally {
      if (linkSessionRef.current === session) {
        setOtpVerifying(false);
      }
    }
  };

  const handleStart = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || viewState?.state !== 'ready') return;
    const activeToken = token;
    const session = linkSessionRef.current;
    const snapshotView = viewState;
    const effectiveEmail =
      snapshotView.otpVerified && snapshotView.verifiedEmail ? snapshotView.verifiedEmail : recipientEmail;
    const checked = validateDirectStartForm({
      name: recipientName,
      email: effectiveEmail,
      emailRequired: snapshotView.emailRequired,
    });
    if (!checked.ok) {
      setStartError(t(checked.errorKey));
      return;
    }

    setStarting(true);
    setStartError(null);
    try {
      const started = await publicDirectSignApi.start({
        token: activeToken,
        name: checked.name,
        email: checked.email,
        otpSessionToken,
      });
      if (linkSessionRef.current !== session) return;
      handoffDirectSigningToken(started.signingToken, (opts) => navigate(opts as never));
    } catch (error) {
      if (linkSessionRef.current !== session) return;
      if (isOtpRequiredError(error)) {
        setOtpSessionToken(null);
        setOtpSent(false);
        setOtpCode('');
        setOtpError(t('otpExpired'));
        setPdfBytes(null);
        setViewState({
          state: 'otp_required',
          orgName: snapshotView.orgName,
          title: snapshotView.title,
          description: snapshotView.description,
          roleLabel: snapshotView.roleLabel,
          signerRole: snapshotView.signerRole,
          requireEmailOtp: true,
        });
        return;
      }
      if (error instanceof PublicSignError && error.status === 404) {
        forgetDirectSignToken();
        setViewError(t('invalidHint'));
        setViewState(null);
        return;
      }
      setStartError(error instanceof Error ? error.message : t('invalidTitle'));
    } finally {
      if (linkSessionRef.current === session) {
        setStarting(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ScreenTitle name={viewState?.title ?? t('invalidTitle')} />

      <header className="border-b bg-card px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <Logo />
          <span className="text-xs leading-relaxed text-muted-foreground">{t('securityNote')}</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 py-5 pb-20 sm:px-6">
        {!token || viewError ? (
          <Card data-testid="sign-direct-invalid">
            <CardHeader>
              <CardTitle>{t('invalidTitle')}</CardTitle>
              <CardDescription>{viewError || t('invalidHint')}</CardDescription>
            </CardHeader>
          </Card>
        ) : loadingView ? (
          <ListSkeleton rows={4} />
        ) : viewState?.state === 'otp_required' ? (
          <SignDirectOtpCard
            viewState={viewState}
            email={otpEmail}
            otpCode={otpCode}
            otpSent={otpSent}
            maskedEmail={maskedEmail}
            otpSending={otpSending}
            otpVerifying={otpVerifying}
            otpLocked={otpLocked}
            otpError={otpError}
            onEmailChange={(value) => {
              setOtpEmail(value);
              setOtpError(null);
              setOtpLocked(false);
            }}
            onOtpCodeChange={(value) => {
              setOtpCode(value);
              setOtpError(null);
            }}
            onRequestOtp={() => void handleRequestOtp()}
            onVerifyOtp={(e) => void handleVerifyOtp(e)}
          />
        ) : viewState?.state === 'ready' ? (
          <SignDirectReadyView
            viewState={viewState}
            name={recipientName}
            email={recipientEmail}
            starting={starting}
            startError={startError}
            pdfBytes={pdfBytes}
            loadingPdf={loadingPdf}
            pdfError={pdfError}
            pageNumber={pageNumber}
            scale={scale}
            onNameChange={(value) => {
              setRecipientName(value);
              setStartError(null);
            }}
            onEmailChange={(value) => {
              setRecipientEmail(value);
              setStartError(null);
            }}
            onPageChange={setPageNumber}
            onScaleChange={setScale}
            onStart={(e) => void handleStart(e)}
          />
        ) : null}
      </main>
    </div>
  );
}
