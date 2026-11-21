// SPDX-License-Identifier: AGPL-3.0-only
// Mobile-first public self-service eSign template hub (/-/sign/p/$orgSlug, zero CAPTCHA, zero raw link tokens) (#3820).
import { useNavigate, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { ListSkeleton, Logo, ScreenTitle } from '../components/ui.tsx';
import {
  publicHubSignApi,
  PublicSignError,
  type PublicDirectSignViewState,
  type PublicHubListResponse,
  type PublicHubTemplateItem,
} from '../lib/sign-api.ts';
import { toast } from '../lib/toast.ts';
import {
  handoffDirectSigningToken,
  SignDirectOtpCard,
  SignDirectReadyView,
  validateDirectStartForm,
} from './sign-direct.tsx';

const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isOtpRequiredError(error: unknown): error is PublicSignError {
  return (
    error instanceof PublicSignError &&
    (error.code === 'OTP_REQUIRED' || error.code === 'SIGN_OTP_REQUIRED' || error.code === 'SIGN_OTP_EMAIL_MISMATCH')
  );
}

export function SignPublicHubDirectory({
  orgName,
  items,
  onSelectTemplate,
}: {
  orgName: string;
  items: readonly PublicHubTemplateItem[];
  onSelectTemplate: (templateId: string) => void;
}) {
  const t = useTranslations('sign.publicHub');
  const tDirect = useTranslations('sign.direct');
  const tSign = useTranslations('sign');

  return (
    <div className="space-y-4" data-testid="sign-public-hub-directory">
      <div className="space-y-1">
        <Badge variant="outline">{orgName}</Badge>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{t('heading', { org: orgName })}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      <ul className="grid grid-cols-1 gap-3" data-testid="sign-public-hub-list">
        {items.map((item) => {
          const isApprover = item.signerRole === 'approver';
          return (
            <li key={item.templateId}>
              <Card data-testid={`sign-public-hub-item-${item.templateId}`}>
                <CardHeader className="space-y-2 pb-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">
                      {isApprover ? tDirect('roleBadgeApprover') : tDirect('roleBadgeSigner')}
                    </Badge>
                    {item.roleLabel ? (
                      <span className="text-xs font-medium text-muted-foreground">{item.roleLabel}</span>
                    ) : null}
                    <Badge variant="outline">{tSign('pagesCount', { count: String(item.pageCount) })}</Badge>
                    {item.requireEmailOtp ? <Badge variant="outline">{t('otpRequiredBadge')}</Badge> : null}
                  </div>
                  <CardTitle className="text-base leading-snug">{item.title}</CardTitle>
                  {item.description ? <CardDescription>{item.description}</CardDescription> : null}
                </CardHeader>
                <CardContent className="pt-0">
                  <Button
                    type="button"
                    className="min-h-11 w-full sm:w-auto"
                    onClick={() => onSelectTemplate(item.templateId)}
                    data-testid={`sign-public-hub-open-${item.templateId}`}
                  >
                    {isApprover ? t('openFormApprover') : t('openFormSigner')}
                  </Button>
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SignPublicHubPage({ orgSlug: propOrgSlug }: { orgSlug?: string | undefined } = {}) {
  const t = useTranslations('sign.publicHub');
  const tDirect = useTranslations('sign.direct');
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { orgSlug?: string };
  const orgSlug = (propOrgSlug ?? params.orgSlug ?? '').trim().toLowerCase();

  const [hub, setHub] = useState<PublicHubListResponse | null>(null);
  const [loadingHub, setLoadingHub] = useState(true);
  const [hubUnavailable, setHubUnavailable] = useState(false);

  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
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

  const hubGenRef = useRef(0);
  const itemGenRef = useRef(0);
  const itemSessionRef = useRef(0);

  const resetSelectedTemplateState = useCallback(() => {
    itemGenRef.current += 1;
    itemSessionRef.current += 1;
    setSelectedTemplateId(null);
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

  const loadHub = useCallback(
    async (slug: string) => {
      if (!slug) {
        setHub(null);
        setHubUnavailable(true);
        setLoadingHub(false);
        return;
      }
      const reqId = ++hubGenRef.current;
      setLoadingHub(true);
      setHubUnavailable(false);
      try {
        const res = await publicHubSignApi.list(slug);
        if (hubGenRef.current !== reqId) return;
        setHub(res);
      } catch {
        if (hubGenRef.current !== reqId) return;
        setHub(null);
        setHubUnavailable(true);
      } finally {
        if (hubGenRef.current === reqId) {
          setLoadingHub(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    resetSelectedTemplateState();
    void loadHub(orgSlug);
  }, [orgSlug, loadHub, resetSelectedTemplateState]);

  const loadTemplateView = useCallback(
    async (slug: string, templateId: string, activeClaim: string | null) => {
      const reqId = ++itemGenRef.current;
      const session = itemSessionRef.current;
      setLoadingView(true);
      setViewError(null);
      setPdfError(null);
      setPdfBytes(null);
      try {
        const view = await publicHubSignApi.view(slug, templateId, activeClaim);
        if (itemGenRef.current !== reqId || itemSessionRef.current !== session) return;
        setViewState(view);
        if (view.state === 'ready') {
          if (view.verifiedEmail) {
            setRecipientEmail(view.verifiedEmail);
          }
          setLoadingPdf(true);
          try {
            const bytes = await publicHubSignApi.pdf(slug, templateId, activeClaim);
            if (itemGenRef.current !== reqId || itemSessionRef.current !== session) return;
            setPdfBytes(bytes);
          } catch (pdfErr) {
            if (itemGenRef.current !== reqId || itemSessionRef.current !== session) return;
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
              setPdfError(t('unavailableHint'));
            }
          } finally {
            if (itemGenRef.current === reqId && itemSessionRef.current === session) {
              setLoadingPdf(false);
            }
          }
        }
      } catch {
        if (itemGenRef.current !== reqId || itemSessionRef.current !== session) return;
        setViewError(t('unavailableHint'));
        setViewState(null);
      } finally {
        if (itemGenRef.current === reqId && itemSessionRef.current === session) {
          setLoadingView(false);
        }
      }
    },
    [t],
  );

  const handleSelectTemplate = (templateId: string) => {
    resetSelectedTemplateState();
    setSelectedTemplateId(templateId);
    void loadTemplateView(orgSlug, templateId, null);
  };

  const handleRequestOtp = async () => {
    if (!selectedTemplateId) return;
    const activeTemplateId = selectedTemplateId;
    const session = itemSessionRef.current;
    const cleanEmail = otpEmail.trim().toLowerCase();
    if (!SIMPLE_EMAIL_PATTERN.test(cleanEmail)) {
      setOtpError(tDirect('emailInvalidError'));
      return;
    }
    setOtpSending(true);
    setOtpError(null);
    setOtpLocked(false);
    try {
      const res = await publicHubSignApi.requestOtp(orgSlug, activeTemplateId, cleanEmail);
      if (itemSessionRef.current !== session) return;
      setOtpSent(true);
      setMaskedEmail(res.maskedEmail ?? cleanEmail);
      setOtpCode('');
      toast(tDirect('otpSentToast'));
    } catch (error) {
      if (itemSessionRef.current !== session) return;
      if (error instanceof PublicSignError && error.status === 404) {
        setViewError(t('unavailableHint'));
        setViewState(null);
        return;
      }
      setOtpError(error instanceof Error ? error.message : t('unavailableHint'));
    } finally {
      if (itemSessionRef.current === session) {
        setOtpSending(false);
      }
    }
  };

  const handleVerifyOtp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTemplateId) return;
    const activeTemplateId = selectedTemplateId;
    const session = itemSessionRef.current;
    const cleanEmail = otpEmail.trim().toLowerCase();
    setOtpVerifying(true);
    setOtpError(null);
    try {
      const res = await publicHubSignApi.verifyOtp(orgSlug, activeTemplateId, cleanEmail, otpCode.trim());
      if (itemSessionRef.current !== session) return;
      if (!res.ok) {
        if (res.locked) {
          setOtpLocked(true);
          setOtpError(tDirect('otpLocked'));
          return;
        }
        if (res.expired) {
          setOtpError(tDirect('otpExpired'));
          return;
        }
        if (res.notReady) {
          setOtpError(tDirect('otpNotReady'));
          return;
        }
        setOtpError(tDirect('otpInvalid', { attempts: String(res.attemptsRemaining) }));
        return;
      }
      const nextClaim = res.otpSessionToken ?? null;
      setOtpSessionToken(nextClaim);
      setRecipientEmail(res.verifiedEmail ?? cleanEmail);
      await loadTemplateView(orgSlug, activeTemplateId, nextClaim);
    } catch (error) {
      if (itemSessionRef.current !== session) return;
      if (error instanceof PublicSignError && error.status === 404) {
        setViewError(t('unavailableHint'));
        setViewState(null);
        return;
      }
      setOtpError(error instanceof Error ? error.message : tDirect('otpExpired'));
    } finally {
      if (itemSessionRef.current === session) {
        setOtpVerifying(false);
      }
    }
  };

  const handleStart = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedTemplateId || viewState?.state !== 'ready') return;
    const activeTemplateId = selectedTemplateId;
    const session = itemSessionRef.current;
    const snapshotView = viewState;
    const effectiveEmail =
      snapshotView.otpVerified && snapshotView.verifiedEmail ? snapshotView.verifiedEmail : recipientEmail;
    const checked = validateDirectStartForm({
      name: recipientName,
      email: effectiveEmail,
      emailRequired: snapshotView.emailRequired,
    });
    if (!checked.ok) {
      setStartError(tDirect(checked.errorKey));
      return;
    }

    setStarting(true);
    setStartError(null);
    try {
      const started = await publicHubSignApi.start({
        orgSlug,
        templateId: activeTemplateId,
        name: checked.name,
        email: checked.email,
        otpSessionToken,
      });
      if (itemSessionRef.current !== session) return;
      handoffDirectSigningToken(started.signingToken, (opts) => navigate(opts as never));
    } catch (error) {
      if (itemSessionRef.current !== session) return;
      if (isOtpRequiredError(error)) {
        setOtpSessionToken(null);
        setOtpSent(false);
        setOtpCode('');
        setOtpError(tDirect('otpExpired'));
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
        setViewError(t('unavailableHint'));
        setViewState(null);
        return;
      }
      setStartError(error instanceof Error ? error.message : t('unavailableTitle'));
    } finally {
      if (itemSessionRef.current === session) {
        setStarting(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ScreenTitle name={viewState?.title ?? (hub ? t('heading', { org: hub.orgName }) : t('unavailableTitle'))} />

      <header className="border-b bg-card px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <Logo />
          <span className="text-xs leading-relaxed text-muted-foreground">{t('securityNote')}</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 py-5 pb-20 sm:px-6">
        {loadingHub ? (
          <ListSkeleton rows={4} />
        ) : hubUnavailable || !hub || hub.items.length === 0 ? (
          <Card data-testid="sign-public-hub-unavailable">
            <CardHeader>
              <CardTitle>{t('unavailableTitle')}</CardTitle>
              <CardDescription>{t('unavailableHint')}</CardDescription>
            </CardHeader>
          </Card>
        ) : !selectedTemplateId ? (
          <SignPublicHubDirectory
            orgName={hub.orgName}
            items={hub.items}
            onSelectTemplate={handleSelectTemplate}
          />
        ) : (
          <div className="space-y-4">
            <div>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  resetSelectedTemplateState();
                  void loadHub(orgSlug);
                }}
                data-testid="sign-public-hub-back-btn"
              >
                {t('backToDirectory')}
              </Button>
            </div>

            {viewError ? (
              <Card data-testid="sign-public-hub-item-unavailable">
                <CardHeader>
                  <CardTitle>{t('unavailableTitle')}</CardTitle>
                  <CardDescription>{viewError}</CardDescription>
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
          </div>
        )}
      </main>
    </div>
  );
}
