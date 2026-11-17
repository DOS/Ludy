// SPDX-License-Identifier: AGPL-3.0-only
// Mobile-first public signing ceremony (/-/sign#<token>, zero query tokens, zero CAPTCHA, OTP gate, PNG signature pad) (#3325).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Checkbox } from '@crove/ui/components/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@crove/ui/components/dialog';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { cn } from '@crove/ui/lib/utils';
import { PdfCanvasViewer } from '../components/sign/pdf-canvas-viewer.tsx';
import { SignaturePadModal } from '../components/sign/signature-pad-modal.tsx';
import { ErrorText, ListSkeleton, Logo, ScreenTitle } from '../components/ui.tsx';
import { publicSignApi, PublicSignError, type PublicFieldSubmission, type PublicSignField, type PublicSignViewState } from '../lib/sign-api.ts';
import { forgetSignToken, pendingSignToken, readSignTokenFromHash, rememberSignToken, scrubSignTokenHash, subscribeToHash } from '../lib/sign-hash.ts';
import { toast } from '../lib/toast.ts';

interface FieldAnswer {
  signaturePngDataUrl?: string;
  signatureKind?: 'drawn' | 'typed';
  signatureTypedText?: string;
  valueText?: string;
  valueChecked?: boolean;
}

function isOtpRequiredError(error: unknown): error is PublicSignError {
  return error instanceof PublicSignError && (error.code === 'OTP_REQUIRED' || error.code === 'SIGN_OTP_REQUIRED');
}

function isFieldComplete(field: PublicSignField, answer: FieldAnswer | undefined): boolean {
  if (!field.required) return true;
  if (field.fieldType === 'signature' || field.fieldType === 'initials') {
    return Boolean(answer?.signaturePngDataUrl);
  }
  if (field.fieldType === 'checkbox') {
    return answer?.valueChecked === true;
  }
  return Boolean(answer?.valueText?.trim());
}

export function canSubmitCeremony(params: {
  viewReady: boolean;
  incompleteRequiredCount: number;
  consentChecked: boolean;
  pdfBytes: Uint8Array | null;
  loadingPdf: boolean;
  pdfError: string | null;
  viewerRenderError: string | null;
  pdfRendered: boolean;
}): boolean {
  return (
    params.viewReady &&
    params.incompleteRequiredCount === 0 &&
    params.consentChecked &&
    Boolean(params.pdfBytes && params.pdfBytes.byteLength > 0) &&
    !params.loadingPdf &&
    !params.pdfError &&
    !params.viewerRenderError &&
    params.pdfRendered
  );
}

export function SignCeremonyPage() {
  const t = useTranslations('sign.ceremony');
  const tField = useTranslations('sign.fields');
  const common = useTranslations('common');

  const [token, setToken] = useState<string | null>(() => {
    const hadHash = typeof window !== 'undefined' && Boolean(window.location.hash);
    const fromHash = readSignTokenFromHash();
    if (hadHash) {
      scrubSignTokenHash();
    }
    if (fromHash) {
      rememberSignToken(fromHash);
      return fromHash;
    }
    if (hadHash) {
      forgetSignToken();
      return null;
    }
    return pendingSignToken();
  });

  const [tokenEpoch, setTokenEpoch] = useState(0);
  const [viewState, setViewState] = useState<PublicSignViewState | null>(null);
  const [loadingView, setLoadingView] = useState(false);
  const [viewError, setViewError] = useState<string | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pdfRendered, setPdfRendered] = useState(false);
  const [viewerRenderError, setViewerRenderError] = useState<string | null>(null);

  const [otpCode, setOtpCode] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);

  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(0.95);
  const [answers, setAnswers] = useState<Record<string, FieldAnswer>>({});
  const [padFieldId, setPadFieldId] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declineError, setDeclineError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);

  const fieldCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const requestGenRef = useRef(0);

  const resetCeremonyTransientState = useCallback(() => {
    requestGenRef.current += 1;
    setViewState(null);
    setLoadingView(false);
    setViewError(null);
    setPdfError(null);
    setPdfBytes(null);
    setLoadingPdf(false);
    setPdfRendered(false);
    setViewerRenderError(null);
    setAnswers({});
    setConsentChecked(false);
    setOtpSent(false);
    setOtpCode('');
    setOtpError(null);
    setSubmitError(null);
    setDeclineOpen(false);
    setDeclineReason('');
    setDeclineError(null);
    setPageNumber(1);
  }, []);

  useEffect(() => {
    return subscribeToHash(() => {
      const hadHash = typeof window !== 'undefined' && Boolean(window.location.hash);
      const next = readSignTokenFromHash();
      if (hadHash) {
        scrubSignTokenHash();
      }
      if (next) {
        rememberSignToken(next);
        resetCeremonyTransientState();
        setToken(next);
        setTokenEpoch((n) => n + 1);
      } else if (hadHash) {
        forgetSignToken();
        resetCeremonyTransientState();
        setToken(null);
      }
    });
  }, [resetCeremonyTransientState]);

  const loadView = useCallback(async (activeToken: string) => {
    const requestId = ++requestGenRef.current;
    setLoadingView(true);
    setViewError(null);
    setPdfError(null);
    setPdfBytes(null);
    setPdfRendered(false);
    setViewerRenderError(null);
    setSubmitError(null);
    try {
      const view = await publicSignApi.view(activeToken);
      if (requestGenRef.current !== requestId) return;
      setViewState(view);
      if (
        view.state === 'already_completed' ||
        view.state === 'declined' ||
        view.state === 'voided' ||
        view.state === 'expired'
      ) {
        forgetSignToken();
      }
      if (view.state === 'ready') {
        const todayStr = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Ho_Chi_Minh',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date());
        setAnswers((prev) => {
          const next = { ...prev };
          for (const field of view.fields) {
            if (field.fieldType === 'date' && !next[field.id]?.valueText) {
              next[field.id] = { valueText: todayStr };
            }
          }
          return next;
        });
        setLoadingPdf(true);
        try {
          const bytes = await publicSignApi.pdf(activeToken);
          if (requestGenRef.current !== requestId) return;
          setPdfBytes(bytes);
        } catch (pdfErr) {
          if (requestGenRef.current !== requestId) return;
          if (isOtpRequiredError(pdfErr)) {
            setOtpSent(false);
            setOtpCode('');
            setViewState({ state: 'otp_required', orgName: view.orgName, title: view.title, maskedEmail: null });
          } else {
            setPdfError(t('invalidHint'));
          }
        } finally {
          if (requestGenRef.current === requestId) {
            setLoadingPdf(false);
          }
        }
      }
    } catch (error) {
      if (requestGenRef.current !== requestId) return;
      if (error instanceof PublicSignError && error.status === 404) {
        forgetSignToken();
      }
      if (error instanceof PublicSignError && error.status !== 404) {
        setViewError(t('invalidTitle'));
      } else {
        setViewError(t('invalidHint'));
      }
      setViewState(null);
    } finally {
      if (requestGenRef.current === requestId) {
        setLoadingView(false);
      }
    }
  }, [t]);

  useEffect(() => {
    if (!token) return;
    void loadView(token);
  }, [token, tokenEpoch, loadView]);

  const handlePdfRenderStatus = useCallback((status: { rendered: boolean; error: string | null }) => {
    setPdfRendered(status.rendered);
    setViewerRenderError(status.error);
  }, []);

  const readyFields = useMemo(() => (viewState?.state === 'ready' ? viewState.fields : []), [viewState]);
  const incompleteRequired = useMemo(
    () => readyFields.filter((field) => !isFieldComplete(field, answers[field.id])),
    [readyFields, answers],
  );
  const canSubmit = canSubmitCeremony({
    viewReady: viewState?.state === 'ready',
    incompleteRequiredCount: incompleteRequired.length,
    consentChecked,
    pdfBytes,
    loadingPdf,
    pdfError,
    viewerRenderError,
    pdfRendered,
  });

  const handleRequestOtp = async () => {
    if (!token) return;
    setOtpSending(true);
    setOtpError(null);
    try {
      await publicSignApi.requestOtp(token);
      setOtpSent(true);
      toast(t('otpSentToast'));
    } catch (error) {
      setOtpError(error instanceof Error ? error.message : t('otpInvalid'));
    } finally {
      setOtpSending(false);
    }
  };

  const handleVerifyOtp = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token) return;
    setOtpVerifying(true);
    setOtpError(null);
    try {
      const res = await publicSignApi.verifyOtp(token, otpCode.trim());
      if (!res.ok) {
        setOtpError(t('otpInvalid'));
        return;
      }
      await loadView(token);
    } catch {
      setOtpError(t('otpInvalid'));
    } finally {
      setOtpVerifying(false);
    }
  };

  const handleJumpToNext = () => {
    const nextField = incompleteRequired[0];
    if (!nextField) return;
    setPageNumber(nextField.pageNumber);
    const el = fieldCardRefs.current[nextField.id];
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    if (nextField.fieldType === 'signature' || nextField.fieldType === 'initials') {
      setPadFieldId(nextField.id);
    }
  };

  const handleSubmit = async () => {
    if (!token || viewState?.state !== 'ready' || incompleteRequired.length > 0 || !consentChecked) return;
    if (!canSubmit) {
      setSubmitError(t('pdfRequiredToSign'));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      let signatureKind: 'draw' | 'type' | undefined;
      let signatureTypedText: string | undefined;
      let primaryIsSignature = false;
      const payloadFields: PublicFieldSubmission[] = viewState.fields.map((field) => {
        const answer = answers[field.id] ?? {};
        if (answer.signaturePngDataUrl && answer.signatureKind) {
          const isPrimary = field.fieldType === 'signature';
          if (!signatureKind || (isPrimary && !primaryIsSignature)) {
            signatureKind = answer.signatureKind === 'drawn' ? 'draw' : 'type';
            signatureTypedText = answer.signatureTypedText || undefined;
            primaryIsSignature = isPrimary;
          }
        }
        return {
          fieldId: field.id,
          ...(answer.signaturePngDataUrl ? { signaturePngBase64: answer.signaturePngDataUrl } : {}),
          ...(answer.valueText !== undefined ? { valueText: answer.valueText } : {}),
          ...(answer.valueChecked !== undefined ? { valueChecked: answer.valueChecked } : {}),
        };
      });
      await publicSignApi.submit({
        token,
        consentAccepted: true,
        ...(signatureKind ? { signatureKind } : {}),
        ...(signatureTypedText ? { signatureTypedText } : {}),
        fields: payloadFields,
      });
      forgetSignToken();
      toast(t('submitSuccessToast'));
      setViewState({ state: 'already_completed', title: viewState.title, status: 'completed' });
      setPdfBytes(null);
    } catch (error) {
      if (isOtpRequiredError(error)) {
        setOtpSent(false);
        setOtpCode('');
        setOtpError(error.message || t('otpInvalid'));
        setPdfBytes(null);
        setViewState({ state: 'otp_required', orgName: viewState.orgName, title: viewState.title, maskedEmail: null });
        toast(t('otpInvalid'), 'error');
      } else {
        const msg = error instanceof Error ? error.message : t('invalidTitle');
        setSubmitError(msg);
        toast(msg, 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleDecline = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || viewState?.state !== 'ready') return;
    if (!declineReason.trim()) {
      setDeclineError(t('declineReasonRequired'));
      return;
    }
    setDeclining(true);
    setDeclineError(null);
    try {
      await publicSignApi.decline({ token, reason: declineReason.trim() });
      forgetSignToken();
      setDeclineOpen(false);
      toast(t('declineSuccessToast'));
      setViewState({ state: 'declined', title: viewState.title, status: 'declined' });
      setPdfBytes(null);
    } catch (error) {
      if (isOtpRequiredError(error)) {
        setDeclineOpen(false);
        setOtpSent(false);
        setOtpCode('');
        setOtpError(error.message || t('otpInvalid'));
        setPdfBytes(null);
        setViewState({ state: 'otp_required', orgName: viewState.orgName, title: viewState.title, maskedEmail: null });
        toast(t('otpInvalid'), 'error');
      } else {
        setDeclineError(error instanceof Error ? error.message : t('invalidTitle'));
      }
    } finally {
      setDeclining(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ScreenTitle name={viewState?.title ?? t('invalidTitle')} />

      <header className="border-b bg-card px-4 py-3">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
          <Logo />
          <span className="text-xs text-muted-foreground">{t('securityNote')}</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 py-5 pb-28 sm:px-6">
        {!token || viewError ? (
          <Card data-testid="sign-ceremony-invalid">
            <CardHeader>
              <CardTitle>{t('invalidTitle')}</CardTitle>
              <CardDescription>{viewError || t('invalidHint')}</CardDescription>
            </CardHeader>
          </Card>
        ) : loadingView ? (
          <ListSkeleton rows={4} />
        ) : viewState?.state === 'waiting_turn' ? (
          <Card data-testid="sign-ceremony-waiting">
            <CardHeader>
              <CardTitle>{t('waitingTitle')}</CardTitle>
              <CardDescription>{t('waitingHint', { order: String(viewState.order) })}</CardDescription>
            </CardHeader>
          </Card>
        ) : viewState?.state === 'already_completed' ? (
          <Card data-testid="sign-ceremony-completed">
            <CardHeader>
              <CardTitle>{t('completedTitle')}</CardTitle>
              <CardDescription>{t('completedHint')}</CardDescription>
            </CardHeader>
          </Card>
        ) : viewState?.state === 'declined' ? (
          <Card data-testid="sign-ceremony-declined">
            <CardHeader>
              <CardTitle>{t('declinedTitle')}</CardTitle>
            </CardHeader>
          </Card>
        ) : viewState?.state === 'voided' ? (
          <Card data-testid="sign-ceremony-voided">
            <CardHeader>
              <CardTitle>{t('voidedTitle')}</CardTitle>
            </CardHeader>
          </Card>
        ) : viewState?.state === 'expired' ? (
          <Card data-testid="sign-ceremony-expired">
            <CardHeader>
              <CardTitle>{t('expiredTitle')}</CardTitle>
            </CardHeader>
          </Card>
        ) : viewState?.state === 'otp_required' ? (
          <Card className="mx-auto max-w-md" data-testid="sign-ceremony-otp">
            <CardHeader>
              <CardTitle>{t('otpTitle')}</CardTitle>
              <CardDescription>{t('otpHint', { email: viewState.maskedEmail ?? '' })}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {otpSent && !otpError ? (
                <p
                  className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground"
                  role="status"
                  data-testid="otp-sent-notice"
                >
                  {t('otpSentToast')}
                </p>
              ) : null}
              {otpError ? <ErrorText>{otpError}</ErrorText> : null}

              <Button
                type="button"
                variant="outline"
                className="min-h-11 w-full"
                loading={otpSending}
                onClick={() => void handleRequestOtp()}
                data-testid="otp-request-btn"
              >
                {otpSent ? t('otpResend') : t('otpSend')}
              </Button>

              <form onSubmit={(e) => void handleVerifyOtp(e)} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sign-otp-input">{t('otpCodeLabel')}</Label>
                  <Input
                    id="sign-otp-input"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    className="min-h-11 text-center font-mono text-lg tracking-widest"
                    data-testid="otp-code-input"
                  />
                </div>
                <Button
                  type="submit"
                  className="min-h-11 w-full"
                  disabled={otpCode.trim().length < 6}
                  loading={otpVerifying}
                  data-testid="otp-verify-btn"
                >
                  {t('otpVerifyButton')}
                </Button>
              </form>
            </CardContent>
          </Card>
        ) : viewState?.state === 'ready' ? (
          <div className="space-y-4" data-testid="sign-ceremony-ready">
            <div className="sticky top-2 z-30 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card/95 px-3 py-2.5">
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold text-foreground">{viewState.title}</h1>
                <p className="text-xs text-muted-foreground">{viewState.signerName}</p>
              </div>
              <div className="flex items-center gap-2">
                {incompleteRequired.length > 0 ? (
                  <>
                    <Badge variant="warning" data-testid="ceremony-remaining-badge">
                      {t('remainingFields', { count: String(incompleteRequired.length) })}
                    </Badge>
                    <Button type="button" size="sm" className="min-h-11" onClick={handleJumpToNext} data-testid="ceremony-jump-next">
                      {t('jumpNext')}
                    </Button>
                  </>
                ) : (
                  <Badge variant="success">{t('allDoneBadge')}</Badge>
                )}
              </div>
            </div>

            {viewState.message ? (
              <div
                className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground"
                data-testid="ceremony-sender-message"
              >
                <p className="text-xs font-medium text-muted-foreground">{t('senderMessageLabel')}</p>
                <p className="mt-0.5 whitespace-pre-wrap break-words">{viewState.message}</p>
              </div>
            ) : null}

            {loadingPdf ? <ListSkeleton rows={3} /> : null}
            {pdfError ? <ErrorText>{pdfError}</ErrorText> : null}

            <PdfCanvasViewer
              pdfBytes={pdfBytes}
              pageNumber={pageNumber}
              pageCount={viewState.pageCount}
              scale={scale}
              onPageChange={setPageNumber}
              onScaleChange={setScale}
              onRenderStatusChange={handlePdfRenderStatus}
              renderOverlay={(page) => (
                <div className="pointer-events-none relative h-full w-full">
                  {viewState.fields
                    .filter((field) => field.pageNumber === page)
                    .map((field) => {
                      const answer = answers[field.id];
                      const done = isFieldComplete(field, answer);
                      const isSig = field.fieldType === 'signature' || field.fieldType === 'initials';
                      return (
                        <button
                          key={field.id}
                          type="button"
                          onClick={() => {
                            if (isSig) {
                              setPadFieldId(field.id);
                            } else {
                              fieldCardRefs.current[field.id]?.focus();
                            }
                          }}
                          style={{
                            left: `${field.xNorm * 100}%`,
                            top: `${field.yNorm * 100}%`,
                            width: `${field.wNorm * 100}%`,
                            height: `${field.hNorm * 100}%`,
                          }}
                          className={cn(
                            'pointer-events-auto absolute flex items-center justify-center rounded border-2 p-1 text-xs font-medium',
                            done ? 'border-success bg-success/10 text-success' : 'border-primary bg-primary/10 text-primary',
                          )}
                        >
                          {answer?.signaturePngDataUrl ? (
                            <img
                              src={answer.signaturePngDataUrl}
                              alt={tField(`types.${field.fieldType}`)}
                              className="max-h-full max-w-full object-contain"
                            />
                          ) : (
                            <span className="truncate">
                              {answer?.valueText ||
                                (field.fieldType === 'initials' ? t('tapToInitial') : isSig ? t('tapToSign') : tField(`types.${field.fieldType}`))}
                            </span>
                          )}
                        </button>
                      );
                    })}
                </div>
              )}
            />

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{tField('paletteTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {viewState.fields.map((field) => {
                  const answer = answers[field.id];
                  const complete = isFieldComplete(field, answer);
                  const isSig = field.fieldType === 'signature' || field.fieldType === 'initials';
                  return (
                    <div
                      key={field.id}
                      ref={(el) => {
                        fieldCardRefs.current[field.id] = el;
                      }}
                      tabIndex={-1}
                      className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{field.label || tField(`types.${field.fieldType}`)}</span>
                          <Badge variant={complete ? 'success' : 'outline'}>
                            {complete ? t('signedMark') : tField('requiredToggle')}
                          </Badge>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {tField('pageNav', { current: String(field.pageNumber), total: String(viewState.pageCount) })}
                        </span>
                      </div>

                      {isSig ? (
                        <Button
                          type="button"
                          variant={complete ? 'outline' : 'default'}
                          className="min-h-11"
                          onClick={() => setPadFieldId(field.id)}
                          data-testid={`ceremony-sign-btn-${field.id}`}
                        >
                          {answer?.signaturePngDataUrl ? t('signedMark') : field.fieldType === 'initials' ? t('tapToInitial') : t('tapToSign')}
                        </Button>
                      ) : field.fieldType === 'checkbox' ? (
                        <label
                          htmlFor={`ceremony-field-checkbox-${field.id}`}
                          className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
                        >
                          <Checkbox
                            id={`ceremony-field-checkbox-${field.id}`}
                            checked={Boolean(answer?.valueChecked)}
                            onCheckedChange={(checked) =>
                              setAnswers((prev) => ({
                                ...prev,
                                [field.id]: { ...prev[field.id], valueChecked: Boolean(checked) },
                              }))
                            }
                          />
                          <span>{t('checkboxLabel')}</span>
                        </label>
                      ) : (
                        <div className="w-full sm:max-w-xs">
                          <Label htmlFor={`ceremony-field-input-${field.id}`} className="sr-only">
                            {field.label || t('textPlaceholder')}
                          </Label>
                          <Input
                            id={`ceremony-field-input-${field.id}`}
                            className="min-h-11"
                            placeholder={t('textPlaceholder')}
                            value={answer?.valueText ?? ''}
                            onChange={(e) =>
                              setAnswers((prev) => ({
                                ...prev,
                                [field.id]: { ...prev[field.id], valueText: e.target.value },
                              }))
                            }
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-4 p-4">
                <label
                  htmlFor="ceremony-consent-input"
                  className="flex min-h-11 cursor-pointer items-start gap-3 text-sm"
                >
                  <Checkbox
                    id="ceremony-consent-input"
                    checked={consentChecked}
                    onCheckedChange={(checked) => {
                      setConsentChecked(Boolean(checked));
                      setSubmitError(null);
                    }}
                    className="mt-1"
                    data-testid="ceremony-consent-checkbox"
                  />
                  <span>{t('consentLabel')}</span>
                </label>

                {submitError ? (
                  <div data-testid="ceremony-submit-error">
                    <ErrorText>{submitError}</ErrorText>
                  </div>
                ) : pdfError || viewerRenderError ? (
                  <div data-testid="ceremony-pdf-required-error">
                    <ErrorText>{t('pdfRequiredToSign')}</ErrorText>
                  </div>
                ) : null}

                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => setDeclineOpen(true)}
                    data-testid="ceremony-decline-btn"
                  >
                    {t('declineButton')}
                  </Button>
                  <Button
                    type="button"
                    className="min-h-11"
                    disabled={!canSubmit}
                    loading={submitting}
                    onClick={() => void handleSubmit()}
                    data-testid="ceremony-submit-btn"
                  >
                    {t('submitButton')}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <SignaturePadModal
              open={padFieldId !== null}
              defaultName={viewState.signerName}
              onOpenChange={(next) => !next && setPadFieldId(null)}
              onConfirm={({ pngDataUrl, kind, typedText }) => {
                if (!padFieldId) return;
                setSubmitError(null);
                setAnswers((prev) => {
                  const prevEntry = prev[padFieldId];
                  const nextEntry: FieldAnswer = {
                    ...(prevEntry?.valueText !== undefined ? { valueText: prevEntry.valueText } : {}),
                    ...(prevEntry?.valueChecked !== undefined ? { valueChecked: prevEntry.valueChecked } : {}),
                    signaturePngDataUrl: pngDataUrl,
                    signatureKind: kind,
                    ...(kind === 'typed' && typedText ? { signatureTypedText: typedText } : {}),
                  };
                  return { ...prev, [padFieldId]: nextEntry };
                });
              }}
            />

            <Dialog open={declineOpen} onOpenChange={setDeclineOpen}>
              <DialogContent className="sm:max-w-md" variant="destructive" closeLabel={common('close')}>
                <DialogHeader>
                  <DialogTitle>{t('declineTitle')}</DialogTitle>
                </DialogHeader>
                <form onSubmit={(e) => void handleDecline(e)} className="space-y-3">
                  {declineError ? <ErrorText>{declineError}</ErrorText> : null}
                  <div className="space-y-1.5">
                    <Label htmlFor="decline-reason-input">{t('declineReasonLabel')}</Label>
                    <Input
                      id="decline-reason-input"
                      className="min-h-11"
                      value={declineReason}
                      onChange={(e) => setDeclineReason(e.target.value)}
                      required
                    />
                  </div>
                  <DialogFooter className="gap-2">
                    <Button type="button" variant="outline" className="min-h-11" onClick={() => setDeclineOpen(false)}>
                      {common('cancel')}
                    </Button>
                    <Button type="submit" variant="destructive" className="min-h-11" loading={declining}>
                      {t('declineConfirm')}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        ) : null}
      </main>
    </div>
  );
}
