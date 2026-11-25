// SPDX-License-Identifier: AGPL-3.0-only
// Mobile-first public signing ceremony (/-/sign#<token>, zero query tokens, zero CAPTCHA, OTP gate, PNG signature pad) (#3325).
import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { cn } from '@ludy/ui/lib/utils';
import { PdfCanvasViewer } from '../components/sign/pdf-canvas-viewer.tsx';
import { SignPacketTabs } from '../components/sign/sign-packet-tabs.tsx';
import { SignCeremonyDepositCard } from '../components/sign/sign-ceremony-deposit-card.tsx';
import { CounterpartySummaryBanner } from '../components/sign/shared-summary-card.tsx';
import { SignQrModal } from '../components/sign/sign-qr-modal.tsx';
import { SignaturePadModal } from '../components/sign/signature-pad-modal.tsx';
import { StampPadModal } from '../components/sign/stamp-pad-modal.tsx';
import { ErrorText, isEmailAddress, ListSkeleton, Logo, ScreenTitle } from '../components/ui.tsx';
import {
  loadCeremonyWorkspaceProfiles,
  publicSignApi,
  PublicSignError,
  saveCeremonyMemberSignature,
  type PublicFieldSubmission,
  type PublicSignField,
  type PublicSignFieldAttachment,
  type PublicSignViewState,
  type SignMemberSignatureItem,
  type SignOrgStampItem,
} from '../lib/sign-api.ts';
import { SIGN_ATTACHMENT_MAX_BYTES, isChoiceFieldType, type SignSignerRole } from '../lib/sign-fields.ts';
import { subscribeCeremonySignedOut } from '../lib/ceremony-boot.ts';
import {
  buildSigningUrl,
  forgetSignToken,
  hasInPersonQueryFlag,
  markInPersonCeremonyIsolated,
  pendingSignToken,
  readSignTokenFromHash,
  rememberSignToken,
  scrubSignTokenHash,
  subscribeToHash,
} from '../lib/sign-hash.ts';
import { rawBase64ToPngDataUrl, stripPngDataUrlPrefix } from '../lib/sign-signature.ts';
import { toast } from '../lib/toast.ts';

export const CEREMONY_QR_POLL_INTERVAL_MS = 4_000;
export const CEREMONY_QR_POLL_MAX_MS = 15 * 60 * 1000;

export interface CeremonyWorkspaceProfileState {
  workspaceOrgSlug: string | null;
  savedSignatures: SignMemberSignatureItem[];
  savedStamps: SignOrgStampItem[];
}

export function bindCeremonyWorkspaceProfileSync(deps: {
  onState: (next: CeremonyWorkspaceProfileState) => void;
  subscribeSignedOut?: (cb: () => void) => () => void;
  loadProfiles?: (orgName: string) => Promise<{
    orgSlug: string;
    signatures: SignMemberSignatureItem[];
    stamps: SignOrgStampItem[];
  } | null>;
}) {
  let generation = 0;
  let unsubscribed = false;
  const subscribe = deps.subscribeSignedOut ?? subscribeCeremonySignedOut;
  const load = deps.loadProfiles ?? ((orgName: string) => loadCeremonyWorkspaceProfiles(orgName));

  const reset = () => {
    generation += 1;
    deps.onState({ workspaceOrgSlug: null, savedSignatures: [], savedStamps: [] });
  };

  const stopSignedOut = subscribe(() => {
    if (!unsubscribed) reset();
  });

  const sync = (params: { readyOrgName: string | null; isInPersonReady: boolean }): (() => void) => {
    const gen = ++generation;
    let cancelled = false;
    if (!params.readyOrgName || params.isInPersonReady) {
      deps.onState({ workspaceOrgSlug: null, savedSignatures: [], savedStamps: [] });
      return () => {
        cancelled = true;
      };
    }
    void load(params.readyOrgName).then((profile) => {
      if (cancelled || unsubscribed || generation !== gen) return;
      if (!profile) {
        deps.onState({ workspaceOrgSlug: null, savedSignatures: [], savedStamps: [] });
        return;
      }
      deps.onState({
        workspaceOrgSlug: profile.orgSlug,
        savedSignatures: profile.signatures,
        savedStamps: profile.stamps,
      });
    });
    return () => {
      cancelled = true;
      if (generation === gen) generation += 1;
    };
  };

  const reloadIfStillCurrent = async (orgName: string, onSignatures: (sigs: SignMemberSignatureItem[]) => void) => {
    const genAtStart = generation;
    const reloaded = await load(orgName);
    if (!unsubscribed && generation === genAtStart && reloaded) {
      onSignatures(reloaded.signatures);
    }
  };

  const dispose = () => {
    unsubscribed = true;
    generation += 1;
    stopSignedOut();
  };

  return { sync, reset, reloadIfStillCurrent, dispose };
}

export function canShowCeremonyQrHandoff(params: {
  viewState: PublicSignViewState | null;
  isInPerson: boolean;
  hasToken: boolean;
  viewError: string | null;
}): boolean {
  return params.hasToken && !params.viewError && !params.isInPerson && params.viewState?.state === 'ready';
}

export function isTerminalCeremonyViewState(view: PublicSignViewState): boolean {
  return (
    view.state === 'already_completed' ||
    view.state === 'declined' ||
    view.state === 'delegated' ||
    view.state === 'voided' ||
    view.state === 'expired'
  );
}

export async function submitCeremonyWithGenerationGuard<T>(params: {
  getGeneration: () => number;
  runSubmit: () => Promise<T>;
  onSuccess: (result: T) => void;
  onError: (error: unknown) => void;
  onSettled: () => void;
}): Promise<void> {
  const submitGeneration = params.getGeneration();
  try {
    const result = await params.runSubmit();
    if (params.getGeneration() !== submitGeneration) return;
    params.onSuccess(result);
  } catch (error) {
    if (params.getGeneration() !== submitGeneration) return;
    params.onError(error);
  } finally {
    if (params.getGeneration() === submitGeneration) {
      params.onSettled();
    }
  }
}

/** Polls public ceremony status while the desktop QR modal stays open, pausing on hidden tabs and capping at 15 min. */
export function startCeremonyQrPolling(params: {
  token: string;
  pollView: (token: string) => Promise<PublicSignViewState>;
  onNonReadyState: (view: PublicSignViewState) => void;
  onNotFound: () => void;
  onTimeout?: () => void;
  intervalMs?: number;
  maxDurationMs?: number;
  now?: () => number;
  isHidden?: () => boolean;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
  subscribeVisibility?: (listener: () => void) => () => void;
}): () => void {
  const intervalMs = params.intervalMs ?? CEREMONY_QR_POLL_INTERVAL_MS;
  const maxDurationMs = params.maxDurationMs ?? CEREMONY_QR_POLL_MAX_MS;
  const now = params.now ?? (() => Date.now());
  const isHidden = params.isHidden ?? (() => typeof document !== 'undefined' && Boolean(document.hidden));
  const setIntervalFn = params.setIntervalFn ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearIntervalFn = params.clearIntervalFn ?? ((id) => globalThis.clearInterval(id));
  const subscribeVisibility =
    params.subscribeVisibility ??
    ((listener) => {
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
        return () => {};
      }
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    });

  let stopped = false;
  let inFlight = false;
  const startedAt = now();
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let unsubVisibility: (() => void) | null = null;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (intervalId !== null) {
      clearIntervalFn(intervalId);
      intervalId = null;
    }
    if (unsubVisibility) {
      unsubVisibility();
      unsubVisibility = null;
    }
  };

  const pollOnce = async () => {
    if (stopped || inFlight) return;
    if (now() - startedAt >= maxDurationMs) {
      stop();
      params.onTimeout?.();
      return;
    }
    if (isHidden()) return;
    inFlight = true;
    try {
      const nextView = await params.pollView(params.token);
      if (stopped) return;
      if (nextView.state !== 'ready') {
        stop();
        params.onNonReadyState(nextView);
      }
    } catch (error) {
      if (stopped) return;
      if (error instanceof PublicSignError && error.status === 404) {
        stop();
        params.onNotFound();
      }
    } finally {
      inFlight = false;
    }
  };

  intervalId = setIntervalFn(() => {
    void pollOnce();
  }, intervalMs);
  unsubVisibility = subscribeVisibility(() => {
    if (!stopped && !isHidden()) {
      void pollOnce();
    }
  });

  return stop;
}

export interface CeremonyFieldAnswer {
  signaturePngDataUrl?: string;
  signatureKind?: 'drawn' | 'typed';
  signatureTypedText?: string;
  valueText?: string;
  valueChecked?: boolean;
  attachment?: PublicSignFieldAttachment | null;
}

export function withPreservedCeremonyFieldValues(
  prev: CeremonyFieldAnswer | undefined,
  patch: CeremonyFieldAnswer,
): CeremonyFieldAnswer {
  return {
    ...(prev?.valueText !== undefined ? { valueText: prev.valueText } : {}),
    ...(prev?.valueChecked !== undefined ? { valueChecked: prev.valueChecked } : {}),
    ...(prev?.attachment !== undefined ? { attachment: prev.attachment } : {}),
    ...patch,
  };
}

export function buildOtpRequiredViewState(input: {
  orgName: string;
  title: string;
  inPerson?: boolean;
}): Extract<PublicSignViewState, { state: 'otp_required' }> {
  return {
    state: 'otp_required',
    orgName: input.orgName,
    title: input.title,
    maskedEmail: null,
    ...(input.inPerson ? { inPerson: true } : {}),
  };
}

type ReadySignView = Extract<PublicSignViewState, { state: 'ready' }>;

function isOtpRequiredError(error: unknown): error is PublicSignError {
  return error instanceof PublicSignError && (error.code === 'OTP_REQUIRED' || error.code === 'SIGN_OTP_REQUIRED');
}

export function isApproverCeremonyMode(view: Pick<ReadySignView, 'signerRole' | 'fields'>): boolean {
  return (
    view.signerRole === 'approver' &&
    view.fields.every(
      (field) => field.fieldType !== 'signature' && field.fieldType !== 'initials' && field.fieldType !== 'stamp',
    )
  );
}

export function jumpToCounterpartySummaryPage(
  selectDoc: (docKey: string, nextPage?: number) => void | Promise<void>,
  doc1Id: string | null,
  page: number,
): void {
  void selectDoc(doc1Id ?? 'doc-1', page);
}

export async function runCeremonyDocumentSelect(deps: {
  docKey: string;
  nextPage?: number;
  currentPageNumber: number;
  pdfBytes: Uint8Array | null;
  cachedPdfBytes: Uint8Array | undefined;
  pdfRendered: boolean;
  bumpGen: () => number;
  getGen: () => number;
  setLoadingPdf: (loading: boolean) => void;
  setActiveDocKey: (docKey: string) => void;
  setPageNumber: (page: number) => void;
  clearErrors: () => void;
  setPdfRendered: (rendered: boolean) => void;
  setPdfBytes: (bytes: Uint8Array | null) => void;
  fetchPdfBytes: () => Promise<Uint8Array>;
  onFetched: (bytes: Uint8Array) => void;
  onFetchError: (err: unknown) => void;
}): Promise<void> {
  const plan = planCachedDocumentSelect({
    currentPageNumber: deps.currentPageNumber,
    ...(deps.nextPage !== undefined ? { nextPage: deps.nextPage } : {}),
    currentPdfBytes: deps.pdfBytes,
    cachedPdfBytes: deps.cachedPdfBytes,
    pdfRendered: deps.pdfRendered,
  });
  if (plan.action === 'noop') {
    deps.bumpGen();
    deps.setLoadingPdf(false);
    deps.setActiveDocKey(deps.docKey);
    return;
  }
  deps.setActiveDocKey(deps.docKey);
  deps.setPageNumber(plan.targetPage);
  deps.clearErrors();
  if (plan.action === 'apply_cache') {
    deps.bumpGen();
    deps.setLoadingPdf(false);
    if (plan.resetRendered) {
      deps.setPdfRendered(false);
    }
    deps.setPdfBytes(plan.cached);
    return;
  }
  const pdfGen = deps.bumpGen();
  deps.setLoadingPdf(true);
  deps.setPdfRendered(false);
  deps.setPdfBytes(null);
  try {
    const bytes = await deps.fetchPdfBytes();
    if (deps.getGen() !== pdfGen) return;
    deps.onFetched(bytes);
    deps.setPdfBytes(bytes);
  } catch (pdfErr) {
    if (deps.getGen() !== pdfGen) return;
    deps.onFetchError(pdfErr);
  } finally {
    if (deps.getGen() === pdfGen) {
      deps.setLoadingPdf(false);
    }
  }
}

export function planCachedDocumentSelect(opts: {
  currentPageNumber: number;
  nextPage?: number;
  currentPdfBytes: Uint8Array | null;
  cachedPdfBytes: Uint8Array | undefined;
  pdfRendered: boolean;
}):
  | { action: 'fetch'; targetPage: number }
  | { action: 'noop' }
  | { action: 'apply_cache'; targetPage: number; resetRendered: boolean; cached: Uint8Array } {
  const targetPage = Math.max(1, opts.nextPage ?? 1);
  if (!opts.cachedPdfBytes) {
    return { action: 'fetch', targetPage };
  }
  if (opts.cachedPdfBytes === opts.currentPdfBytes && targetPage === opts.currentPageNumber && opts.pdfRendered) {
    return { action: 'noop' };
  }
  return {
    action: 'apply_cache',
    targetPage,
    resetRendered: opts.cachedPdfBytes !== opts.currentPdfBytes || targetPage !== opts.currentPageNumber,
    cached: opts.cachedPdfBytes,
  };
}

export function isFieldFilled(field: PublicSignField, answer: CeremonyFieldAnswer | undefined): boolean {
  if (field.fieldType === 'signature' || field.fieldType === 'initials' || field.fieldType === 'stamp') {
    return Boolean(answer?.signaturePngDataUrl);
  }
  if (field.fieldType === 'checkbox') {
    return answer?.valueChecked === true;
  }
  if (field.fieldType === 'attachment') {
    return Boolean(answer?.attachment?.fileId || field.attachment?.fileId);
  }
  if (isChoiceFieldType(field.fieldType)) {
    const selected = answer?.valueText?.trim() ?? '';
    return Boolean(selected && (field.options ?? []).includes(selected));
  }
  return Boolean(answer?.valueText?.trim());
}

export function isFieldComplete(field: PublicSignField, answer: CeremonyFieldAnswer | undefined): boolean {
  return !field.required || isFieldFilled(field, answer);
}

export function buildSignSubmitPayload(params: {
  token: string;
  fields: readonly PublicSignField[];
  answers: Readonly<Record<string, CeremonyFieldAnswer>>;
}): {
  token: string;
  consentAccepted: true;
  signatureKind?: 'draw' | 'type';
  signatureTypedText?: string;
  fields: PublicFieldSubmission[];
} {
  let signatureKind: 'draw' | 'type' | undefined;
  let signatureTypedText: string | undefined;
  let primaryIsSignature = false;
  const payloadFields: PublicFieldSubmission[] = params.fields.map((field) => {
    const answer = params.answers[field.id] ?? {};
    if (field.fieldType === 'attachment') {
      return { fieldId: field.id };
    }
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
  return {
    token: params.token,
    consentAccepted: true,
    ...(signatureKind ? { signatureKind } : {}),
    ...(signatureTypedText ? { signatureTypedText } : {}),
    fields: payloadFields,
  };
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

export function SignInPersonHandoffCard({
  title,
  outcome,
  signerRole,
}: {
  title: string;
  outcome: 'completed' | 'declined';
  signerRole?: SignSignerRole | undefined;
}) {
  const t = useTranslations('sign.ceremony');
  const isApprover = signerRole === 'approver';
  const heading =
    outcome === 'declined'
      ? t(isApprover ? 'approverDeclinedTitle' : 'declinedTitle')
      : t(isApprover ? 'inPersonApproverCompletedTitle' : 'inPersonCompletedTitle');

  return (
    <Card className="mx-auto max-w-lg border-primary/40" data-testid="sign-ceremony-in-person-handoff">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="brand" data-testid="ceremony-in-person-badge">
            {t('inPersonBadge')}
          </Badge>
        </div>
        <CardTitle className="text-lg">{heading}</CardTitle>
        <CardDescription className="font-medium text-foreground">{title}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p>{t('inPersonHandoffHint')}</p>
      </CardContent>
    </Card>
  );
}

export function SignCeremonyQrEndedCard({ title }: { title: string }) {
  const tQr = useTranslations('sign.qrHandoff');
  return (
    <Card className="mx-auto max-w-lg" data-testid="sign-ceremony-qr-ended">
      <CardHeader>
        <CardTitle>{tQr('qrEndedTitle')}</CardTitle>
        <CardDescription className="font-medium text-foreground">{title}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <p>{tQr('qrEndedHint')}</p>
      </CardContent>
    </Card>
  );
}

export function SignCeremonyPage() {
  const t = useTranslations('sign.ceremony');
  const tQr = useTranslations('sign.qrHandoff');

  const [inPersonMode, setInPersonMode] = useState<boolean>(() => {
    const inPerson = hasInPersonQueryFlag();
    if (inPerson) markInPersonCeremonyIsolated();
    return inPerson;
  });
  const inPersonModeRef = useRef(inPersonMode);
  inPersonModeRef.current = inPersonMode;
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
  const [activeDocKey, setActiveDocKey] = useState('doc-1');
  const pdfCacheRef = useRef<Map<string, Uint8Array>>(new Map());
  const pdfLoadGenRef = useRef(0);
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
  const [answers, setAnswers] = useState<Record<string, CeremonyFieldAnswer>>({});
  const [uploadingFieldIds, setUploadingFieldIds] = useState<Record<string, boolean>>({});
  const [attachmentErrors, setAttachmentErrors] = useState<Record<string, string>>({});
  const [padFieldId, setPadFieldId] = useState<string | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [declineError, setDeclineError] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [workspaceOrgSlug, setWorkspaceOrgSlug] = useState<string | null>(null);
  const [savedSignatures, setSavedSignatures] = useState<SignMemberSignatureItem[]>([]);
  const [savedStamps, setSavedStamps] = useState<SignOrgStampItem[]>([]);

  const [delegateOpen, setDelegateOpen] = useState(false);
  const [delegateName, setDelegateName] = useState('');
  const [delegateEmail, setDelegateEmail] = useState('');
  const [delegateReason, setDelegateReason] = useState('');
  const [delegateError, setDelegateError] = useState<string | null>(null);
  const [delegating, setDelegating] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrPollTimedOut, setQrPollTimedOut] = useState(false);
  const [qrHandoffEndedTitle, setQrHandoffEndedTitle] = useState<string | null>(null);

  const fieldCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const qrButtonRef = useRef<HTMLButtonElement | null>(null);
  const requestGenRef = useRef(0);

  const resetCeremonyTransientState = useCallback(() => {
    requestGenRef.current += 1;
    pdfLoadGenRef.current += 1;
    setQrOpen(false);
    setQrPollTimedOut(false);
    setQrHandoffEndedTitle(null);
    setViewState(null);
    setLoadingView(false);
    setViewError(null);
    setPdfError(null);
    setPdfBytes(null);
    setLoadingPdf(false);
    setPdfRendered(false);
    setViewerRenderError(null);
    setAnswers({});
    setUploadingFieldIds({});
    setAttachmentErrors({});
    setPadFieldId(null);
    setConsentChecked(false);
    setOtpSent(false);
    setOtpCode('');
    setOtpError(null);
    setSubmitError(null);
    setSubmitting(false);
    setDeclineOpen(false);
    setDeclineReason('');
    setDeclineError(null);
    setDelegateOpen(false);
    setDelegateName('');
    setDelegateEmail('');
    setDelegateReason('');
    setDelegateError(null);
    setPageNumber(1);
    setWorkspaceOrgSlug(null);
    setSavedSignatures([]);
    setSavedStamps([]);
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
        const nextInPerson = hasInPersonQueryFlag();
        if (nextInPerson) markInPersonCeremonyIsolated();
        inPersonModeRef.current = nextInPerson;
        setInPersonMode(nextInPerson);
        setToken(next);
        setTokenEpoch((n) => n + 1);
      } else if (hadHash) {
        forgetSignToken();
        resetCeremonyTransientState();
        const nextInPerson = hasInPersonQueryFlag();
        if (nextInPerson) markInPersonCeremonyIsolated();
        inPersonModeRef.current = nextInPerson;
        setInPersonMode(nextInPerson);
        setToken(null);
      }
    });
  }, [resetCeremonyTransientState]);

  const loadView = useCallback(async (activeToken: string) => {
    const requestId = ++requestGenRef.current;
    setLoadingView(true);
    setSubmitting(false);
    setViewError(null);
    setPdfError(null);
    setPdfBytes(null);
    setPdfRendered(false);
    setViewerRenderError(null);
    setSubmitError(null);
    try {
      const view = await publicSignApi.view(activeToken);
      if (requestGenRef.current !== requestId) return;
      if ('inPerson' in view && view.inPerson === true) {
        markInPersonCeremonyIsolated();
        inPersonModeRef.current = true;
        setInPersonMode(true);
      }
      setViewState(view);
      const keepDepositToken =
        view.state === 'already_completed' && Boolean(view.deposit) && !(view.inPerson === true);
      if (
        (view.state === 'already_completed' && !keepDepositToken) ||
        view.state === 'declined' ||
        view.state === 'delegated' ||
        view.state === 'voided' ||
        view.state === 'expired'
      ) {
        forgetSignToken();
      }
      if (view.state === 'ready') {
        const firstDoc = view.documents?.[0] ?? null;
        const firstDocKey = firstDoc?.id ?? 'doc-1';
        setActiveDocKey(firstDocKey);
        setPageNumber(1);
        pdfCacheRef.current.clear();
        const pdfGen = (pdfLoadGenRef.current += 1);
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
              next[field.id] = { ...next[field.id], valueText: todayStr };
            } else if (field.fieldType === 'text' && field.valueText && !next[field.id]?.valueText) {
              next[field.id] = { ...next[field.id], valueText: field.valueText };
            } else if (field.fieldType === 'attachment' && field.attachment && !next[field.id]?.attachment) {
              next[field.id] = { ...next[field.id], attachment: field.attachment };
            }
          }
          return next;
        });
        setLoadingPdf(true);
        try {
          const bytes = await publicSignApi.pdf(activeToken, firstDoc?.id ?? undefined);
          if (requestGenRef.current !== requestId || pdfLoadGenRef.current !== pdfGen) return;
          pdfCacheRef.current.set(firstDocKey, bytes);
          setPdfBytes(bytes);
        } catch (pdfErr) {
          if (requestGenRef.current !== requestId || pdfLoadGenRef.current !== pdfGen) return;
          if (isOtpRequiredError(pdfErr)) {
            setOtpSent(false);
            setOtpCode('');
            setViewState(
              buildOtpRequiredViewState({
                orgName: view.orgName,
                title: view.title,
                inPerson: Boolean(inPersonModeRef.current || hasInPersonQueryFlag() || view.inPerson),
              }),
            );
          } else {
            setPdfError(t('invalidHint'));
          }
        } finally {
          if (requestGenRef.current === requestId && pdfLoadGenRef.current === pdfGen) {
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

  const profileSyncRef = useRef<ReturnType<typeof bindCeremonyWorkspaceProfileSync> | null>(null);
  const readyOrgName = viewState?.state === 'ready' ? viewState.orgName : null;
  const isInPersonReady = Boolean(inPersonMode || (viewState?.state === 'ready' && viewState.inPerson));

  useEffect(() => {
    // Create, subscribe, and dispose inside useEffect so SSR never leaks module listeners and React <StrictMode> remounts cleanly.
    const syncer = bindCeremonyWorkspaceProfileSync({
      onState: (next) => {
        setWorkspaceOrgSlug(next.workspaceOrgSlug);
        setSavedSignatures(next.savedSignatures);
        setSavedStamps(next.savedStamps);
      },
    });
    profileSyncRef.current = syncer;
    // Never load or offer the host's personal saved signatures or workspace stamps during an in-person ceremony (#3820).
    const stopSync = syncer.sync({ readyOrgName, isInPersonReady });
    return () => {
      stopSync();
      syncer.dispose();
      if (profileSyncRef.current === syncer) {
        profileSyncRef.current = null;
      }
    };
  }, [readyOrgName, isInPersonReady, tokenEpoch]);

  const handlePdfRenderStatus = useCallback((status: { rendered: boolean; error: string | null }) => {
    setPdfRendered(status.rendered);
    setViewerRenderError(status.error);
  }, []);

  const readyFields = useMemo(() => (viewState?.state === 'ready' ? viewState.fields : []), [viewState]);
  const isApproverCeremony = useMemo(
    () => (viewState?.state === 'ready' ? isApproverCeremonyMode(viewState) : false),
    [viewState],
  );
  const incompleteRequired = useMemo(
    () => readyFields.filter((field) => !isFieldComplete(field, answers[field.id])),
    [readyFields, answers],
  );
  const anyAttachmentUploading = useMemo(
    () => Object.values(uploadingFieldIds).some(Boolean),
    [uploadingFieldIds],
  );
  const canSubmit =
    !anyAttachmentUploading &&
    canSubmitCeremony({
      viewReady: viewState?.state === 'ready',
      incompleteRequiredCount: incompleteRequired.length,
      consentChecked,
      pdfBytes,
      loadingPdf,
      pdfError,
      viewerRenderError,
      pdfRendered,
    });

  const handleUploadAttachment = async (fieldId: string, file: File) => {
    if (!token || viewState?.state !== 'ready') return;
    if (file.size === 0) {
      setAttachmentErrors((prev) => ({ ...prev, [fieldId]: t('attachmentEmptyError') }));
      return;
    }
    if (file.size > SIGN_ATTACHMENT_MAX_BYTES) {
      setAttachmentErrors((prev) => ({ ...prev, [fieldId]: t('attachmentTooLargeError') }));
      return;
    }
    setUploadingFieldIds((prev) => ({ ...prev, [fieldId]: true }));
    setAttachmentErrors((prev) => {
      if (!(fieldId in prev)) return prev;
      const copy = { ...prev };
      delete copy[fieldId];
      return copy;
    });
    setSubmitError(null);
    try {
      const uploaded = await publicSignApi.uploadAttachment({ token, fieldId, file });
      setAnswers((prev) => ({
        ...prev,
        [fieldId]: {
          ...prev[fieldId],
          attachment: uploaded,
        },
      }));
      toast(t('attachmentUploadedToast'));
    } catch (error) {
      if (isOtpRequiredError(error)) {
        setOtpSent(false);
        setOtpCode('');
        setOtpError(error.message || t('otpInvalid'));
        setPdfBytes(null);
        setViewState(
          buildOtpRequiredViewState({
            orgName: viewState.orgName,
            title: viewState.title,
            inPerson: Boolean(inPersonMode || viewState.inPerson),
          }),
        );
        toast(t('otpInvalid'), 'error');
      } else {
        const msg =
          error instanceof PublicSignError && error.status === 413
            ? t('attachmentTooLargeError')
            : error instanceof PublicSignError && error.status === 415
              ? t('attachmentInvalidTypeError')
              : error instanceof Error && error.message
                ? error.message
                : t('attachmentUploadFailed');
        setAttachmentErrors((prev) => ({ ...prev, [fieldId]: msg }));
        toast(msg, 'error');
      }
    } finally {
      setUploadingFieldIds((prev) => ({ ...prev, [fieldId]: false }));
    }
  };

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

  const readyDocs = useMemo(
    () => (viewState?.state === 'ready' ? (viewState.documents ?? []) : []),
    [viewState],
  );
  const readyDoc1Id = readyDocs[0]?.id ?? null;

  const handleSelectDocument = useCallback(
    async (docKey: string, nextPage = 1) => {
      if (!token || viewState?.state !== 'ready') return;
      const targetDoc = readyDocs.find((d) => (d.id ?? 'doc-1') === docKey) ?? null;
      await runCeremonyDocumentSelect({
        docKey,
        nextPage,
        currentPageNumber: pageNumber,
        pdfBytes,
        cachedPdfBytes: pdfCacheRef.current.get(docKey),
        pdfRendered,
        bumpGen: () => (pdfLoadGenRef.current += 1),
        getGen: () => pdfLoadGenRef.current,
        setLoadingPdf,
        setActiveDocKey,
        setPageNumber,
        clearErrors: () => {
          setPdfError(null);
          setViewerRenderError(null);
        },
        setPdfRendered,
        setPdfBytes,
        fetchPdfBytes: () => publicSignApi.pdf(token, targetDoc?.id ?? undefined),
        onFetched: (bytes) => {
          pdfCacheRef.current.set(docKey, bytes);
        },
        onFetchError: (pdfErr) => {
          if (isOtpRequiredError(pdfErr)) {
            setOtpSent(false);
            setOtpCode('');
            setViewState(
              buildOtpRequiredViewState({
                orgName: viewState.orgName,
                title: viewState.title,
                inPerson: Boolean(inPersonMode || viewState.inPerson),
              }),
            );
          } else {
            setPdfError(t('invalidHint'));
          }
        },
      });
    },
    [token, viewState, readyDocs, inPersonMode, t, pageNumber, pdfBytes, pdfRendered],
  );

  const handleJumpToNext = () => {
    const nextField = incompleteRequired[0];
    if (!nextField) return;
    const targetDoc =
      readyDocs.find((d) => d.id === (nextField.documentId ?? readyDoc1Id ?? null)) ?? readyDocs[0] ?? null;
    const targetDocKey = targetDoc?.id ?? 'doc-1';
    if (targetDocKey !== activeDocKey) {
      void handleSelectDocument(targetDocKey, nextField.pageNumber);
    } else {
      setPageNumber(nextField.pageNumber);
    }
    const el = fieldCardRefs.current[nextField.id];
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    if (nextField.fieldType === 'signature' || nextField.fieldType === 'initials' || nextField.fieldType === 'stamp') {
      setPadFieldId(nextField.id);
    } else {
      const inputEl = document.getElementById(
        nextField.fieldType === 'checkbox'
          ? `ceremony-field-checkbox-${nextField.id}`
          : `ceremony-field-input-${nextField.id}`,
      );
      inputEl?.focus();
    }
  };

  const handleSubmit = async () => {
    if (!token || viewState?.state !== 'ready' || incompleteRequired.length > 0 || !consentChecked) return;
    if (!canSubmit) {
      setSubmitError(t(isApproverCeremony ? 'approverPdfRequired' : 'pdfRequiredToSign'));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    await submitCeremonyWithGenerationGuard({
      getGeneration: () => requestGenRef.current,
      runSubmit: () =>
        publicSignApi.submit(
          buildSignSubmitPayload({
            token,
            fields: viewState.fields,
            answers,
          }),
        ),
      onSuccess: (submitRes) => {
        const wasInPerson = Boolean(inPersonMode || viewState.inPerson || submitRes.inPerson);
        if (wasInPerson) {
          setInPersonMode(true);
        }
        const keepDepositToken = !wasInPerson && Boolean(submitRes.deposit);
        if (!keepDepositToken) {
          forgetSignToken();
        }
        toast(t(isApproverCeremony ? 'approverSubmitSuccessToast' : 'submitSuccessToast'));
        setViewState({
          state: 'already_completed',
          title: viewState.title,
          status: 'completed',
          signerRole: isApproverCeremony ? 'approver' : 'signer',
          ...(wasInPerson ? { inPerson: true } : {}),
          ...(keepDepositToken ? { deposit: submitRes.deposit ?? null } : {}),
        });
        setPdfBytes(null);
      },
      onError: (error) => {
        if (isOtpRequiredError(error)) {
          setOtpSent(false);
          setOtpCode('');
          setOtpError(error.message || t('otpInvalid'));
          setPdfBytes(null);
          setViewState(
            buildOtpRequiredViewState({
              orgName: viewState.orgName,
              title: viewState.title,
              inPerson: Boolean(inPersonMode || viewState.inPerson),
            }),
          );
          toast(t('otpInvalid'), 'error');
        } else {
          const msg = error instanceof Error ? error.message : t('invalidTitle');
          setSubmitError(msg);
          toast(msg, 'error');
        }
      },
      onSettled: () => {
        setSubmitting(false);
      },
    });
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
      const wasInPerson = Boolean(inPersonMode || viewState.inPerson);
      forgetSignToken();
      setDeclineOpen(false);
      toast(t(isApproverCeremony ? 'approverDeclineSuccessToast' : 'declineSuccessToast'));
      setViewState({
        state: 'declined',
        title: viewState.title,
        status: 'declined',
        signerRole: isApproverCeremony ? 'approver' : 'signer',
        ...(wasInPerson ? { inPerson: true } : {}),
      });
      setPdfBytes(null);
    } catch (error) {
      if (isOtpRequiredError(error)) {
        setDeclineOpen(false);
        setOtpSent(false);
        setOtpCode('');
        setOtpError(error.message || t('otpInvalid'));
        setPdfBytes(null);
        setViewState(
          buildOtpRequiredViewState({
            orgName: viewState.orgName,
            title: viewState.title,
            inPerson: Boolean(inPersonMode || viewState.inPerson),
          }),
        );
        toast(t('otpInvalid'), 'error');
      } else {
        setDeclineError(error instanceof Error ? error.message : t('invalidTitle'));
      }
    } finally {
      setDeclining(false);
    }
  };

  const handleDelegate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token || viewState?.state !== 'ready' || inPersonMode || viewState.inPerson) return;
    const trimmedName = delegateName.trim();
    const trimmedEmail = delegateEmail.trim().toLowerCase();
    const trimmedReason = delegateReason.trim();
    if (!trimmedName || !isEmailAddress(trimmedEmail)) {
      setDelegateError(t('delegateInvalidFields'));
      return;
    }
    if (!trimmedReason) {
      setDelegateError(t('delegateReasonRequired'));
      return;
    }
    setDelegating(true);
    setDelegateError(null);
    try {
      const res = await publicSignApi.delegate({
        token,
        delegateName: trimmedName,
        delegateEmail: trimmedEmail,
        reason: trimmedReason,
      });
      forgetSignToken();
      setDelegateOpen(false);
      toast(t('delegateSuccessToast'));
      setViewState({
        state: 'delegated',
        title: viewState.title,
        delegateName: res.delegateName,
        maskedDelegateEmail: res.maskedDelegateEmail,
      });
      setPdfBytes(null);
    } catch (error) {
      if (isOtpRequiredError(error)) {
        setDelegateOpen(false);
        setOtpSent(false);
        setOtpCode('');
        setOtpError(error.message || t('otpInvalid'));
        setPdfBytes(null);
        setViewState(
          buildOtpRequiredViewState({
            orgName: viewState.orgName,
            title: viewState.title,
            inPerson: Boolean(inPersonMode || viewState.inPerson),
          }),
        );
        toast(t('otpInvalid'), 'error');
      } else {
        setDelegateError(error instanceof Error ? error.message : t('invalidTitle'));
      }
    } finally {
      setDelegating(false);
    }
  };

  const isInPerson = Boolean(inPersonMode || (viewState && 'inPerson' in viewState && viewState.inPerson));
  const qrHandoffEligible = canShowCeremonyQrHandoff({
    viewState,
    isInPerson,
    hasToken: Boolean(token),
    viewError,
  });

  const readyTitle = viewState?.state === 'ready' ? viewState.title : null;

  useEffect(() => {
    if (!qrOpen || !qrHandoffEligible || !token) return;
    const pollEpoch = requestGenRef.current;
    setQrPollTimedOut(false);
    return startCeremonyQrPolling({
      token,
      pollView: publicSignApi.view,
      onNonReadyState: (nextView) => {
        if (requestGenRef.current !== pollEpoch) return;
        setQrOpen(false);
        setQrPollTimedOut(false);
        setViewState(nextView);
        if (isTerminalCeremonyViewState(nextView)) {
          forgetSignToken();
          setPdfBytes(null);
        } else if (nextView.state === 'otp_required') {
          setOtpSent(false);
          setOtpCode('');
          setPdfBytes(null);
        }
      },
      onNotFound: () => {
        if (requestGenRef.current !== pollEpoch) return;
        setQrOpen(false);
        setQrPollTimedOut(false);
        forgetSignToken();
        setPdfBytes(null);
        setQrHandoffEndedTitle(readyTitle ?? tQr('qrEndedTitle'));
        setViewState(null);
      },
      onTimeout: () => {
        if (requestGenRef.current !== pollEpoch) return;
        setQrPollTimedOut(true);
      },
    });
  }, [qrOpen, qrHandoffEligible, token, readyTitle, tQr]);

  const qrSigningUrl = qrHandoffEligible && token ? buildSigningUrl(token) : '';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <ScreenTitle name={viewState?.title ?? qrHandoffEndedTitle ?? t('invalidTitle')} />

      <header className="border-b bg-card px-4 py-3">
        <div className="mx-auto flex max-w-3xl flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Logo />
            {isInPerson ? (
              <Badge variant="brand" data-testid="ceremony-header-in-person-badge">
                {t('inPersonBadge')}
              </Badge>
            ) : null}
          </div>
          <span className="text-xs leading-relaxed text-muted-foreground">
            {isInPerson ? t('inPersonSecurityNote') : t('securityNote')}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 py-5 pb-28 sm:px-6">
        {qrHandoffEndedTitle !== null ? (
          <SignCeremonyQrEndedCard title={qrHandoffEndedTitle} />
        ) : !token || viewError ? (
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
        ) : isInPerson && (viewState?.state === 'already_completed' || viewState?.state === 'declined') ? (
          <SignInPersonHandoffCard
            title={viewState.title}
            outcome={viewState.state === 'declined' ? 'declined' : 'completed'}
            signerRole={viewState.signerRole}
          />
        ) : viewState?.state === 'already_completed' ? (
          <>
            <Card data-testid="sign-ceremony-completed">
              <CardHeader>
                <CardTitle>{t(viewState.signerRole === 'approver' ? 'approverCompletedTitle' : 'completedTitle')}</CardTitle>
                <CardDescription>
                  {t(viewState.signerRole === 'approver' ? 'approverCompletedHint' : 'completedHint')}
                </CardDescription>
              </CardHeader>
            </Card>
            {viewState.deposit && token ? (
              <SignCeremonyDepositCard token={token} deposit={viewState.deposit} />
            ) : null}
          </>
        ) : viewState?.state === 'declined' ? (
          <Card data-testid="sign-ceremony-declined">
            <CardHeader>
              <CardTitle>{t(viewState.signerRole === 'approver' ? 'approverDeclinedTitle' : 'declinedTitle')}</CardTitle>
            </CardHeader>
          </Card>
        ) : viewState?.state === 'delegated' ? (
          <Card data-testid="sign-ceremony-delegated">
            <CardHeader>
              <CardTitle>{t('delegatedTitle')}</CardTitle>
              <CardDescription>
                {t('delegatedHint', {
                  name: viewState.delegateName,
                  email: viewState.maskedDelegateEmail ?? '',
                })}
              </CardDescription>
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
          <SignCeremonyReadyView
            viewState={viewState}
            inPerson={isInPerson}
            answers={answers}
            activeDocumentKey={activeDocKey}
            onSelectDocument={(docKey, nextPage) => void handleSelectDocument(docKey, nextPage)}
            pdfBytes={pdfBytes}
            loadingPdf={loadingPdf}
            pdfError={pdfError}
            viewerRenderError={viewerRenderError}
            pageNumber={pageNumber}
            scale={scale}
            consentChecked={consentChecked}
            canSubmit={canSubmit}
            submitting={submitting}
            submitError={submitError}
            declineOpen={declineOpen}
            declineReason={declineReason}
            declining={declining}
            declineError={declineError}
            delegateOpen={delegateOpen}
            delegateName={delegateName}
            delegateEmail={delegateEmail}
            delegateReason={delegateReason}
            delegating={delegating}
            delegateError={delegateError}
            padFieldId={padFieldId}
            onPageChange={setPageNumber}
            onScaleChange={setScale}
            onRenderStatusChange={handlePdfRenderStatus}
            onJumpToNext={handleJumpToNext}
            onOpenPad={(fieldId) => {
              if (!isApproverCeremony) {
                setPadFieldId(fieldId);
              }
            }}
            onUpdateAnswer={(fieldId, updater) => {
              setSubmitError(null);
              setAnswers((prev) => ({
                ...prev,
                [fieldId]: updater(prev[fieldId]),
              }));
            }}
            uploadingFieldIds={uploadingFieldIds}
            attachmentErrors={attachmentErrors}
            onUploadAttachment={(fieldId, file) => void handleUploadAttachment(fieldId, file)}
            onConsentChange={(checked) => {
              setConsentChecked(checked);
              setSubmitError(null);
            }}
            onSubmit={() => void handleSubmit()}
            onDeclineOpenChange={setDeclineOpen}
            onDeclineReasonChange={setDeclineReason}
            onDeclineSubmit={(event) => void handleDecline(event)}
            onDelegateOpenChange={(open) => {
              setDelegateOpen(open);
              if (!open) setDelegateError(null);
            }}
            onDelegateNameChange={setDelegateName}
            onDelegateEmailChange={setDelegateEmail}
            onDelegateReasonChange={setDelegateReason}
            onDelegateSubmit={(event) => void handleDelegate(event)}
            onOpenQr={qrHandoffEligible ? () => setQrOpen(true) : undefined}
            qrButtonRef={qrButtonRef}
            savedSignatures={savedSignatures}
            savedStamps={savedStamps}
            canSaveSignatureProfile={Boolean(workspaceOrgSlug)}
            onSaveSignatureProfile={async (input) => {
              if (!workspaceOrgSlug) return;
              const ok = await saveCeremonyMemberSignature(workspaceOrgSlug, input);
              if (!ok) return;
              await profileSyncRef.current?.reloadIfStillCurrent(viewState.orgName, setSavedSignatures);
            }}
            setFieldCardRef={(fieldId, el) => {
              fieldCardRefs.current[fieldId] = el;
            }}
          />
        ) : null}
      </main>

      {qrHandoffEligible && viewState?.state === 'ready' ? (
        <SignQrModal
          open={qrOpen}
          onOpenChange={(next) => {
            setQrOpen(next);
            if (!next) setQrPollTimedOut(false);
          }}
          title={tQr('ceremonyModalTitle')}
          description={tQr('ceremonyModalDescription')}
          url={qrSigningUrl}
          statusNotice={qrPollTimedOut ? tQr('ceremonyPollingTimedOut') : tQr('ceremonyPollingNotice')}
          triggerRef={qrButtonRef}
          testId="ceremony-qr-modal"
        />
      ) : null}
    </div>
  );
}

export interface SignCeremonyReadyViewProps {
  viewState: ReadySignView;
  inPerson?: boolean;
  answers: Readonly<Record<string, CeremonyFieldAnswer>>;
  activeDocumentKey?: string;
  onSelectDocument?: (docKey: string, nextPage?: number) => void;
  pdfBytes: Uint8Array | null;
  loadingPdf: boolean;
  pdfError: string | null;
  viewerRenderError: string | null;
  pageNumber: number;
  scale: number;
  consentChecked: boolean;
  canSubmit: boolean;
  submitting: boolean;
  submitError: string | null;
  declineOpen: boolean;
  declineReason: string;
  declining: boolean;
  declineError: string | null;
  delegateOpen?: boolean;
  delegateName?: string;
  delegateEmail?: string;
  delegateReason?: string;
  delegating?: boolean;
  delegateError?: string | null;
  padFieldId: string | null;
  uploadingFieldIds?: Readonly<Record<string, boolean>>;
  attachmentErrors?: Readonly<Record<string, string>>;
  onUploadAttachment?: (fieldId: string, file: File) => void;
  onPageChange: (page: number) => void;
  onScaleChange: (scale: number) => void;
  onRenderStatusChange: (status: { rendered: boolean; error: string | null }) => void;
  onJumpToNext: () => void;
  onOpenPad: (fieldId: string | null) => void;
  onUpdateAnswer: (fieldId: string, updater: (prev: CeremonyFieldAnswer | undefined) => CeremonyFieldAnswer) => void;
  onConsentChange: (checked: boolean) => void;
  onSubmit: () => void;
  onDeclineOpenChange: (open: boolean) => void;
  onDeclineReasonChange: (reason: string) => void;
  onDeclineSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  onDelegateOpenChange?: (open: boolean) => void;
  onDelegateNameChange?: (name: string) => void;
  onDelegateEmailChange?: (email: string) => void;
  onDelegateReasonChange?: (reason: string) => void;
  onDelegateSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
  onOpenQr?: (() => void) | undefined;
  qrButtonRef?: RefObject<HTMLButtonElement | null> | undefined;
  savedSignatures?: readonly SignMemberSignatureItem[];
  savedStamps?: readonly SignOrgStampItem[];
  canSaveSignatureProfile?: boolean;
  onSaveSignatureProfile?: (input: {
    kind: 'signature' | 'initials';
    signatureKind: 'draw' | 'type';
    signatureTypedText?: string | null;
    signaturePngBase64: string;
  }) => Promise<void> | void;
  setFieldCardRef?: (fieldId: string, el: HTMLDivElement | null) => void;
}

export function SignCeremonyReadyView(props: SignCeremonyReadyViewProps) {
  const { viewState, answers } = props;
  const t = useTranslations('sign.ceremony');
  const tPacket = useTranslations('sign.packet');
  const tQr = useTranslations('sign.qrHandoff');
  const tField = useTranslations('sign.fields');
  const common = useTranslations('common');

  const packetDocuments = useMemo(
    () =>
      viewState.documents && viewState.documents.length > 0
        ? viewState.documents
        : [
            {
              id: null,
              docIndex: 1,
              title: viewState.title,
              pageCount: viewState.pageCount,
              pageDimensions: viewState.pageDimensions ?? [],
              sourceSha256: '',
            },
          ],
    [viewState.documents, viewState.title, viewState.pageCount, viewState.pageDimensions],
  );
  const packetPanelId = `${useId()}-packet-panel`;
  const [uncontrolledDocKey, setUncontrolledDocKey] = useState('doc-1');
  const resolvedDocKey = props.activeDocumentKey ?? uncontrolledDocKey;
  const activeDoc =
    packetDocuments.find((d) => (d.id ?? 'doc-1') === resolvedDocKey) ?? packetDocuments[0]!;
  const doc1Id = packetDocuments[0]?.id ?? null;
  const selectDoc = (docKey: string, nextPage = 1) => {
    if (props.onSelectDocument) {
      props.onSelectDocument(docKey, nextPage);
    } else {
      setUncontrolledDocKey(docKey);
      props.onPageChange(nextPage);
    }
  };

  const isApproverCeremony = isApproverCeremonyMode(viewState);
  const isInPerson = Boolean(props.inPerson || viewState.inPerson);
  const canDelegateCeremony = Boolean(
    !isInPerson &&
      viewState.allowDelegation &&
      viewState.signerRole !== 'cc' &&
      (viewState.delegationCount ?? 0) < 2 &&
      props.onDelegateOpenChange,
  );
  const incompleteRequired = useMemo(
    () => viewState.fields.filter((field) => !isFieldComplete(field, answers[field.id])),
    [viewState.fields, answers],
  );

  return (
    <div className="space-y-4" data-testid="sign-ceremony-ready">
      <div className="sticky top-2 z-30 flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card/95 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 truncate text-base font-semibold text-foreground">{viewState.title}</h1>
            {isApproverCeremony ? (
              <Badge variant="brand" data-testid="ceremony-role-badge">
                {t('approverBadge')}
              </Badge>
            ) : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {viewState.signerName}
            {viewState.roleLabel ? ` (${viewState.roleLabel})` : ''}
          </p>
          {viewState.delegatedFromName ? (
            <p className="truncate text-xs text-muted-foreground" data-testid="ceremony-delegated-from">
              {t('delegatedFromNotice', { name: viewState.delegatedFromName })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isInPerson && props.onOpenQr ? (
            <Button
              ref={props.qrButtonRef}
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              onClick={props.onOpenQr}
              data-testid="ceremony-qr-handoff-btn"
            >
              {tQr('ceremonyButton')}
            </Button>
          ) : null}
          {incompleteRequired.length > 0 ? (
            <>
              <Badge variant="warning" data-testid="ceremony-remaining-badge">
                {t('remainingFields', { count: String(incompleteRequired.length) })}
              </Badge>
              <Button
                type="button"
                size="sm"
                className="min-h-11"
                onClick={props.onJumpToNext}
                data-testid="ceremony-jump-next"
              >
                {t('jumpNext')}
              </Button>
            </>
          ) : viewState.fields.length > 0 || !isApproverCeremony ? (
            <Badge variant="success">{t('allDoneBadge')}</Badge>
          ) : null}
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

      {viewState.sharedSummary ? (
        <CounterpartySummaryBanner
          sharedSummary={viewState.sharedSummary}
          pageCount={packetDocuments[0]?.pageCount ?? viewState.pageCount}
          onJumpToPage={(page) => jumpToCounterpartySummaryPage(selectDoc, doc1Id, page)}
        />
      ) : null}

      {props.loadingPdf ? <ListSkeleton rows={3} /> : null}
      {props.pdfError ? <ErrorText>{props.pdfError}</ErrorText> : null}

      {packetDocuments.length > 1 ? (
        <SignPacketTabs
          idPrefix={packetPanelId}
          panelId={packetPanelId}
          items={packetDocuments.map((doc) => {
            const docFields = viewState.fields.filter((f) => (f.documentId ?? doc1Id ?? null) === (doc.id ?? null));
            const requiredDocsFields = docFields.filter((f) => f.required);
            const missingCount = docFields.filter((f) => !isFieldComplete(f, answers[f.id])).length;
            return {
              key: doc.id ?? 'doc-1',
              documentId: doc.id,
              docIndex: doc.docIndex,
              title: doc.title,
              pageCount: doc.pageCount,
              remainingRequiredCount: missingCount,
              totalRequiredCount: requiredDocsFields.length,
            };
          })}
          activeKey={activeDoc.id ?? 'doc-1'}
          onSelect={(key) => selectDoc(key, 1)}
        />
      ) : null}

      <PdfCanvasViewer
        panelId={packetDocuments.length > 1 ? packetPanelId : undefined}
        panelRole={packetDocuments.length > 1 ? 'tabpanel' : undefined}
        panelAriaLabelledBy={
          packetDocuments.length > 1 ? `${packetPanelId}-tab-${activeDoc.id ?? 'doc-1'}` : undefined
        }
        pdfBytes={props.pdfBytes}
        pageNumber={props.pageNumber}
        pageCount={Math.max(1, activeDoc.pageCount)}
        scale={props.scale}
        onPageChange={props.onPageChange}
        onScaleChange={props.onScaleChange}
        onRenderStatusChange={props.onRenderStatusChange}
        renderOverlay={(page) => (
          <div className="pointer-events-none relative h-full w-full">
            {viewState.fields
              .filter(
                (field) =>
                  (field.documentId ?? doc1Id ?? null) === (activeDoc.id ?? null) && field.pageNumber === page,
              )
              .map((field) => {
                const answer = answers[field.id];
                const filled = isFieldFilled(field, answer);
                const isSig =
                  field.fieldType === 'signature' || field.fieldType === 'initials' || field.fieldType === 'stamp';
                return (
                  <button
                    key={field.id}
                    type="button"
                    onClick={() => {
                      if (isSig && !isApproverCeremony) {
                        props.onOpenPad(field.id);
                      } else {
                        const inputEl = document.getElementById(
                          field.fieldType === 'checkbox'
                            ? `ceremony-field-checkbox-${field.id}`
                            : `ceremony-field-input-${field.id}`,
                        );
                        inputEl?.focus();
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
                      filled ? 'border-success bg-success/10 text-success' : 'border-primary bg-primary/10 text-primary',
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
                        {field.fieldType === 'attachment'
                          ? answer?.attachment?.filename ||
                            field.attachment?.filename ||
                            (field.label || tField('types.attachment'))
                          : answer?.valueText ||
                            (field.fieldType === 'checkbox'
                              ? answer?.valueChecked
                                ? t('filledMark')
                                : field.label || tField('types.checkbox')
                              : field.fieldType === 'initials'
                                ? t('tapToInitial')
                                : field.fieldType === 'stamp'
                                  ? t('tapToStamp')
                                : isSig
                                  ? t('tapToSign')
                                  : field.label || tField(`types.${field.fieldType}`))}
                      </span>
                    )}
                  </button>
                );
              })}
          </div>
        )}
      />

      {isApproverCeremony ? (
        <Card data-testid="ceremony-approver-card">
          <CardContent className="p-4 text-sm text-foreground">{t('approverGuidance')}</CardContent>
        </Card>
      ) : null}

      {viewState.fields.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{tField('paletteTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {viewState.fields.map((field) => {
              const answer = answers[field.id];
              const complete = isFieldComplete(field, answer);
              const filled = isFieldFilled(field, answer);
              const isSig =
                field.fieldType === 'signature' || field.fieldType === 'initials' || field.fieldType === 'stamp';
              const fieldLabel = field.label || tField(`types.${field.fieldType}`);
              const quickSavedSig =
                field.fieldType === 'signature' || field.fieldType === 'initials'
                  ? (props.savedSignatures ?? []).find((item) => item.kind === field.fieldType) ?? null
                  : null;
              return (
                <div
                  key={field.id}
                  ref={(el) => {
                    props.setFieldCardRef?.(field.id, el);
                  }}
                  tabIndex={-1}
                  className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{fieldLabel}</span>
                      <Badge variant={filled ? 'success' : 'outline'}>
                        {filled
                          ? field.fieldType === 'stamp'
                            ? t('stampedMark')
                            : isSig
                              ? t('signedMark')
                              : t('filledMark')
                          : field.required
                            ? tField('requiredToggle')
                            : tField('optionalBadge')}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {(() => {
                        const fieldDoc =
                          packetDocuments.find((d) => (d.id ?? null) === (field.documentId ?? doc1Id ?? null)) ??
                          activeDoc;
                        const pageLabel = tField('pageNav', {
                          current: String(field.pageNumber),
                          total: String(Math.max(1, fieldDoc.pageCount)),
                        });
                        return packetDocuments.length > 1 ? (
                          <button
                            type="button"
                            className="inline-flex min-h-11 items-center underline decoration-dotted underline-offset-2 hover:text-foreground"
                            onClick={() => selectDoc(fieldDoc.id ?? 'doc-1', field.pageNumber)}
                          >
                            {tPacket('docTabLabel', {
                              index: String(fieldDoc.docIndex),
                              title: fieldDoc.title,
                            })}{' '}
                            · {pageLabel}
                          </button>
                        ) : (
                          pageLabel
                        );
                      })()}
                    </span>
                  </div>

                  {isSig ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {quickSavedSig && !answer?.signaturePngDataUrl ? (
                        <Button
                          type="button"
                          variant="secondary"
                          className="min-h-11"
                          onClick={() => {
                            const pngDataUrl = rawBase64ToPngDataUrl(quickSavedSig.signaturePngBase64);
                            if (!pngDataUrl) return;
                            const targets =
                              field.fieldType === 'initials'
                                ? viewState.fields.filter((f) => f.fieldType === 'initials')
                                : [field];
                            for (const target of targets) {
                              props.onUpdateAnswer(target.id, (prev) =>
                                withPreservedCeremonyFieldValues(prev, {
                                  signaturePngDataUrl: pngDataUrl,
                                  signatureKind: quickSavedSig.signatureKind === 'type' ? 'typed' : 'drawn',
                                  ...(quickSavedSig.signatureTypedText
                                    ? { signatureTypedText: quickSavedSig.signatureTypedText }
                                    : {}),
                                }),
                              );
                            }
                          }}
                          data-testid={`ceremony-quick-saved-btn-${field.id}`}
                        >
                          {t('useSavedSignature')}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant={complete ? 'outline' : 'default'}
                        className="min-h-11"
                        onClick={() => props.onOpenPad(field.id)}
                        data-testid={`ceremony-sign-btn-${field.id}`}
                      >
                        {answer?.signaturePngDataUrl
                          ? field.fieldType === 'stamp'
                            ? t('stampedMark')
                            : t('signedMark')
                          : field.fieldType === 'initials'
                            ? t('tapToInitial')
                            : field.fieldType === 'stamp'
                              ? t('tapToStamp')
                              : t('tapToSign')}
                      </Button>
                    </div>
                  ) : field.fieldType === 'checkbox' ? (
                    <label
                      htmlFor={`ceremony-field-checkbox-${field.id}`}
                      className="flex min-h-11 cursor-pointer items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={`ceremony-field-checkbox-${field.id}`}
                        checked={Boolean(answer?.valueChecked)}
                        onCheckedChange={(checked) =>
                          props.onUpdateAnswer(field.id, (prev) => ({ ...prev, valueChecked: Boolean(checked) }))
                        }
                      />
                      <span>{field.label || t('checkboxLabel')}</span>
                    </label>
                  ) : field.fieldType === 'dropdown' ? (
                    <div className="w-full sm:max-w-xs">
                      <Label htmlFor={`ceremony-field-input-${field.id}`} className="sr-only">
                        {fieldLabel}
                      </Label>
                      <NativeSelect
                        id={`ceremony-field-input-${field.id}`}
                        className="min-h-11 w-full"
                        value={answer?.valueText ?? ''}
                        onChange={(e) =>
                          props.onUpdateAnswer(field.id, (prev) => ({ ...prev, valueText: e.target.value }))
                        }
                        data-testid={`ceremony-dropdown-${field.id}`}
                      >
                        <NativeSelectOption value="">{t('dropdownPlaceholder')}</NativeSelectOption>
                        {(field.options ?? []).map((opt) => (
                          <NativeSelectOption key={opt} value={opt}>
                            {opt}
                          </NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  ) : field.fieldType === 'radio' ? (
                    <fieldset
                      role="radiogroup"
                      aria-labelledby={`ceremony-radiogroup-legend-${field.id}`}
                      className="w-full sm:max-w-xs"
                      data-testid={`ceremony-radiogroup-${field.id}`}
                    >
                      <legend id={`ceremony-radiogroup-legend-${field.id}`} className="sr-only">
                        {fieldLabel}
                      </legend>
                      <div className="space-y-1.5">
                        {(field.options ?? []).map((opt, idx) => {
                          const radioId =
                            idx === 0 ? `ceremony-field-input-${field.id}` : `ceremony-field-radio-${field.id}-${idx}`;
                          const checked = answer?.valueText === opt;
                          return (
                            <label
                              key={opt}
                              htmlFor={radioId}
                              className={cn(
                                'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 text-sm transition-colors',
                                checked
                                  ? 'border-primary bg-primary/5 font-medium text-foreground'
                                  : 'border-border bg-card text-foreground',
                              )}
                            >
                              <input
                                id={radioId}
                                type="radio"
                                name={`ceremony-radio-${field.id}`}
                                value={opt}
                                checked={checked}
                                onChange={() =>
                                  props.onUpdateAnswer(field.id, (prev) => ({ ...prev, valueText: opt }))
                                }
                                className="size-4 shrink-0 accent-primary"
                              />
                              <span className="min-w-0 break-words">{opt}</span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>
                  ) : field.fieldType === 'attachment' ? (
                    <div className="w-full space-y-1.5 sm:max-w-xs" data-testid={`ceremony-attachment-${field.id}`}>
                      {(() => {
                        const isUploading = Boolean(props.uploadingFieldIds?.[field.id]);
                        const currentAttachment = answer?.attachment ?? field.attachment ?? null;
                        const fieldAttachmentError = props.attachmentErrors?.[field.id] ?? null;
                        return (
                          <>
                            <input
                              id={`ceremony-file-picker-${field.id}`}
                              type="file"
                              tabIndex={-1}
                              aria-hidden="true"
                              accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
                              disabled={isUploading}
                              className="sr-only"
                              onChange={(e) => {
                                const picked = e.currentTarget.files?.[0];
                                e.currentTarget.value = '';
                                if (picked) {
                                  props.onUploadAttachment?.(field.id, picked);
                                }
                              }}
                              data-testid={`ceremony-attachment-input-${field.id}`}
                            />
                            <Button
                              id={`ceremony-field-input-${field.id}`}
                              type="button"
                              variant={currentAttachment ? 'outline' : 'default'}
                              className="min-h-11 w-full"
                              loading={isUploading}
                              aria-label={`${fieldLabel} - ${
                                isUploading
                                  ? t('attachmentUploading')
                                  : currentAttachment
                                    ? t('attachmentReplaceButton')
                                    : t('attachmentPickButton')
                              }`}
                              onClick={() => document.getElementById(`ceremony-file-picker-${field.id}`)?.click()}
                              data-testid={`ceremony-attachment-btn-${field.id}`}
                            >
                              {isUploading
                                ? t('attachmentUploading')
                                : currentAttachment
                                  ? t('attachmentReplaceButton')
                                  : t('attachmentPickButton')}
                            </Button>
                            {currentAttachment ? (
                              <div
                                className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs"
                                data-testid={`ceremony-attachment-summary-${field.id}`}
                              >
                                <p className="truncate font-medium text-foreground">{currentAttachment.filename}</p>
                                {currentAttachment.sha256 ? (
                                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                                    SHA-256: {currentAttachment.sha256.slice(0, 16)}...
                                  </p>
                                ) : null}
                              </div>
                            ) : (
                              <p className="text-[11px] text-muted-foreground">{t('attachmentAcceptHint')}</p>
                            )}
                            {fieldAttachmentError ? <ErrorText>{fieldAttachmentError}</ErrorText> : null}
                          </>
                        );
                      })()}
                    </div>
                  ) : (
                    <div className="w-full sm:max-w-xs">
                      <Label htmlFor={`ceremony-field-input-${field.id}`} className="sr-only">
                        {fieldLabel}
                      </Label>
                      <Input
                        id={`ceremony-field-input-${field.id}`}
                        className="min-h-11"
                        placeholder={t('textPlaceholder')}
                        value={answer?.valueText ?? ''}
                        onChange={(e) =>
                          props.onUpdateAnswer(field.id, (prev) => ({ ...prev, valueText: e.target.value }))
                        }
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-4 p-4">
          {packetDocuments.length > 1 ? (
            <p className="text-xs text-muted-foreground" data-testid="ceremony-multi-doc-consent-note">
              {tPacket('singleConsentAllDocsNotice', { count: String(packetDocuments.length) })}
            </p>
          ) : null}
          <label
            htmlFor="ceremony-consent-input"
            className="flex min-h-11 cursor-pointer items-start gap-3 text-sm"
          >
            <Checkbox
              id="ceremony-consent-input"
              checked={props.consentChecked}
              onCheckedChange={(checked) => props.onConsentChange(Boolean(checked))}
              className="mt-1"
              data-testid="ceremony-consent-checkbox"
            />
            <span>{t(isApproverCeremony ? 'approverConsentLabel' : 'consentLabel')}</span>
          </label>

          {props.submitError ? (
            <div data-testid="ceremony-submit-error">
              <ErrorText>{props.submitError}</ErrorText>
            </div>
          ) : props.pdfError || props.viewerRenderError ? (
            <div data-testid="ceremony-pdf-required-error">
              <ErrorText>{t(isApproverCeremony ? 'approverPdfRequired' : 'pdfRequiredToSign')}</ErrorText>
            </div>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => props.onDeclineOpenChange(true)}
                data-testid="ceremony-decline-btn"
              >
                {t(isApproverCeremony ? 'approverDeclineButton' : 'declineButton')}
              </Button>
              {canDelegateCeremony ? (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => props.onDelegateOpenChange?.(true)}
                  data-testid="ceremony-delegate-btn"
                >
                  {t('delegateButton')}
                </Button>
              ) : null}
            </div>
            <Button
              type="button"
              className="min-h-11"
              disabled={!props.canSubmit}
              loading={props.submitting}
              onClick={props.onSubmit}
              data-testid="ceremony-submit-btn"
            >
              {t(isApproverCeremony ? 'approverSubmitButton' : 'submitButton')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {!isApproverCeremony ? (
        (() => {
          const activePadField = props.padFieldId
            ? viewState.fields.find((f) => f.id === props.padFieldId) ?? null
            : null;
          if (activePadField?.fieldType === 'stamp') {
            return (
              <StampPadModal
                open={props.padFieldId !== null}
                defaultOrgName={viewState.orgName}
                savedStamps={props.savedStamps ?? []}
                onOpenChange={(next) => !next && props.onOpenPad(null)}
                onConfirm={({ pngDataUrl }) => {
                  if (!props.padFieldId) return;
                  props.onUpdateAnswer(props.padFieldId, (prev) =>
                    withPreservedCeremonyFieldValues(prev, {
                      signaturePngDataUrl: pngDataUrl,
                    }),
                  );
                }}
              />
            );
          }
          const padMode: 'signature' | 'initials' = activePadField?.fieldType === 'initials' ? 'initials' : 'signature';
          const savedForMode = (props.savedSignatures ?? []).find((item) => item.kind === padMode) ?? null;
          const initialsCount = viewState.fields.filter((f) => f.fieldType === 'initials').length;
          return (
            <SignaturePadModal
              open={props.padFieldId !== null}
              mode={padMode}
              defaultName={viewState.signerName}
              savedSignature={savedForMode}
              canSaveProfile={Boolean(props.canSaveSignatureProfile)}
              showApplyAllInitials={padMode === 'initials' && initialsCount > 1}
              onOpenChange={(next) => !next && props.onOpenPad(null)}
              onConfirm={({ pngDataUrl, kind, typedText, saveForNextTime, applyToAllInitials }) => {
                if (!props.padFieldId) return;
                const targets =
                  padMode === 'initials' && applyToAllInitials
                    ? viewState.fields.filter((f) => f.fieldType === 'initials').map((f) => f.id)
                    : [props.padFieldId];
                for (const targetFieldId of targets) {
                  props.onUpdateAnswer(targetFieldId, (prev) =>
                    withPreservedCeremonyFieldValues(prev, {
                      signaturePngDataUrl: pngDataUrl,
                      signatureKind: kind,
                      ...(kind === 'typed' && typedText ? { signatureTypedText: typedText } : {}),
                    }),
                  );
                }
                if (saveForNextTime && props.onSaveSignatureProfile) {
                  void props.onSaveSignatureProfile({
                    kind: padMode,
                    signatureKind: kind === 'typed' ? 'type' : 'draw',
                    ...(kind === 'typed' && typedText ? { signatureTypedText: typedText } : {}),
                    signaturePngBase64: stripPngDataUrlPrefix(pngDataUrl),
                  });
                }
              }}
            />
          );
        })()
      ) : null}

      <Dialog open={props.declineOpen} onOpenChange={props.onDeclineOpenChange}>
        <DialogContent className="sm:max-w-md" variant="destructive" closeLabel={common('close')}>
          <DialogHeader>
            <DialogTitle>{t(isApproverCeremony ? 'approverDeclineTitle' : 'declineTitle')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={props.onDeclineSubmit} className="space-y-3">
            {props.declineError ? <ErrorText>{props.declineError}</ErrorText> : null}
            <div className="space-y-1.5">
              <Label htmlFor="decline-reason-input">{t('declineReasonLabel')}</Label>
              <Input
                id="decline-reason-input"
                className="min-h-11"
                value={props.declineReason}
                onChange={(e) => props.onDeclineReasonChange(e.target.value)}
                required
              />
            </div>
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => props.onDeclineOpenChange(false)}
              >
                {common('cancel')}
              </Button>
              <Button type="submit" variant="destructive" className="min-h-11" loading={props.declining}>
                {t('declineConfirm')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {canDelegateCeremony ? (
        <Dialog open={Boolean(props.delegateOpen)} onOpenChange={props.onDelegateOpenChange}>
          <DialogContent className="sm:max-w-md" closeLabel={common('close')} data-testid="ceremony-delegate-dialog">
            <DialogHeader>
              <DialogTitle>{t('delegateTitle')}</DialogTitle>
              <DialogDescription>{t('delegateDescription')}</DialogDescription>
            </DialogHeader>
            <form onSubmit={props.onDelegateSubmit} className="space-y-3">
              {props.delegateError ? <ErrorText>{props.delegateError}</ErrorText> : null}
              <div className="space-y-1.5">
                <Label htmlFor="delegate-name-input">{t('delegateNameLabel')}</Label>
                <Input
                  id="delegate-name-input"
                  className="min-h-11"
                  value={props.delegateName ?? ''}
                  onChange={(e) => props.onDelegateNameChange?.(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="delegate-email-input">{t('delegateEmailLabel')}</Label>
                <Input
                  id="delegate-email-input"
                  type="email"
                  className="min-h-11"
                  value={props.delegateEmail ?? ''}
                  onChange={(e) => props.onDelegateEmailChange?.(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="delegate-reason-input">{t('delegateReasonLabel')}</Label>
                <Input
                  id="delegate-reason-input"
                  className="min-h-11"
                  value={props.delegateReason ?? ''}
                  onChange={(e) => props.onDelegateReasonChange?.(e.target.value)}
                  required
                />
              </div>
              <DialogFooter className="gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={() => props.onDelegateOpenChange?.(false)}
                >
                  {common('cancel')}
                </Button>
                <Button type="submit" className="min-h-11" loading={Boolean(props.delegating)}>
                  {t('delegateConfirm')}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
