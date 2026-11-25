// SPDX-License-Identifier: AGPL-3.0-only
// Envelope detail, pure-JS PDF field placer, Vy AI proposal overlays, send confirmation, and audit evidence (#3325).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import { Alert, AlertDescription, AlertTitle } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { FieldOptionsAndAttachmentEditor } from '../components/sign/field-options-editor.tsx';
import { FieldOverlayLayer } from '../components/sign/field-placer.tsx';
import { EnvelopeKycCard } from '../components/sign/envelope-kyc-card.tsx';
import { EnvelopeObligationsCard } from '../components/sign/envelope-obligations-card.tsx';
import { EnvelopePlaybookCard } from '../components/sign/envelope-playbook-card.tsx';
import { PdfCanvasViewer } from '../components/sign/pdf-canvas-viewer.tsx';
import { SignPacketManager } from '../components/sign/sign-packet-manager.tsx';
import { SignPacketTabs } from '../components/sign/sign-packet-tabs.tsx';
import { SignDepositConfigCard } from '../components/sign/sign-deposit-config-card.tsx';
import { SenderSharedSummaryEditor } from '../components/sign/shared-summary-card.tsx';
import { SignerPanel, type AddSignerFormInput } from '../components/sign/signer-panel.tsx';
import { SignQrModal } from '../components/sign/sign-qr-modal.tsx';
import { SignZaloHandoffPanel } from '../components/sign/sign-zalo-handoff-panel.tsx';
import { VyClauseSheet, VyClauseTrigger } from '../components/sign/vy-clause-panel.tsx';
import { ConfirmDialog } from '../components/confirm-dialog.tsx';
import { ErrorText, isEmailAddress, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import {
  canManageEnvelopeLinks,
  canVoidEnvelope,
  downloadSignFile,
  downloadSignPdfBytes,
  normalizeAiAnalysis,
  signApi,
  type SignAiAnalysis,
  type SignEnvelopeDocumentSummary,
  type SignFieldRecord,
  type SignProposedField,
  type SignSharedSummary,
  type SignSignerRecord,
} from '../lib/sign-api.ts';
import { canManageSignCa } from './sign-settings.tsx';
import {
  SIGN_FIELD_TYPES,
  SIGN_DELIVERY_MODES,
  checkSendReadiness,
  clampFieldBox,
  createPlacedFieldBox,
  isChoiceFieldType,
  normalizeChoiceOptions,
  nudgeFieldBox,
  planDetectedTagsForSigners,
  planInitialAllPrecedingPages,
  resizeFieldBox,
  type DraftFieldPlacement,
  type InitialAllPosition,
  type NormalizedBox,
  type SignDeliveryMode,
  type SignFieldType,
  type SignRoutingMode,
} from '../lib/sign-fields.ts';
import { buildInPersonSigningUrl, buildSigningUrl, copyTextToClipboard } from '../lib/sign-hash.ts';
import { extractPdfPagesText } from '../lib/sign-pdf.ts';
import { toast } from '../lib/toast.ts';

function toDraftPlacements(fields: readonly SignFieldRecord[]): DraftFieldPlacement[] {
  return fields.map((f) => ({
    localId: f.id,
    documentId: f.documentId ?? null,
    signerId: f.signerId,
    fieldType: f.fieldType,
    pageNumber: f.pageNumber,
    xNorm: f.xNorm,
    yNorm: f.yNorm,
    wNorm: f.wNorm,
    hNorm: f.hNorm,
    label: f.label,
    required: f.required,
    proposedByAi: f.proposedByAi,
    fontSizePt: f.fontSizePt,
    options: f.options ? [...f.options] : null,
  }));
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

export function toDatetimeLocalValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const yyyy = String(date.getFullYear()).padStart(4, '0');
  return `${yyyy}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}T${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`;
}

export function fromDatetimeLocalValue(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export { canManageEnvelopeLinks, canVoidEnvelope };

export function filterPendingProposalsForSigners(
  proposals: readonly SignProposedField[],
  signers: readonly SignSignerRecord[],
  dismissedProposalIds: readonly string[],
): SignProposedField[] {
  const assignableIds = new Set(signers.filter((s) => s.signerRole !== 'cc').map((s) => s.id));
  const dismissed = new Set(dismissedProposalIds);
  return proposals.filter((p) => assignableIds.has(p.signerId) && !dismissed.has(p.proposalId));
}

export function MintedZaloLinksCard({
  mintedLinks,
  signers,
  onOpenQr,
}: {
  mintedLinks: ReadonlyArray<{ signerId: string; url: string }>;
  signers: readonly Pick<SignSignerRecord, 'id' | 'name'>[];
  onOpenQr: (target: { url: string; signerName: string }, trigger: HTMLButtonElement) => void;
}) {
  const t = useTranslations('sign');
  if (mintedLinks.length === 0) return null;
  return (
    <Card data-testid="minted-zalo-links-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('actions.copyZalo')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {mintedLinks.map((entry) => {
          const signerName = signers.find((s) => s.id === entry.signerId)?.name ?? entry.signerId;
          return (
            <div key={entry.signerId} className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`zalo-link-input-${entry.signerId}`} className="min-w-28 text-xs font-medium">
                {signerName}
              </Label>
              <Input
                id={`zalo-link-input-${entry.signerId}`}
                readOnly
                value={entry.url}
                className="min-w-0 flex-1 font-mono text-xs"
                data-testid={`zalo-link-input-${entry.signerId}`}
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="min-h-11 shrink-0"
                onClick={(event) => onOpenQr({ url: entry.url, signerName }, event.currentTarget)}
                data-testid={`zalo-link-qr-btn-${entry.signerId}`}
              >
                {t('qrHandoff.showQrButton')}
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function InPersonSessionBody({
  session,
  qrOpen,
  onQrOpenChange,
  qrTriggerRef,
}: {
  session: {
    signerId: string;
    signerName: string;
    url: string;
    expiresAt: string;
  };
  qrOpen: boolean;
  onQrOpenChange: (open: boolean) => void;
  qrTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const t = useTranslations('sign');
  const f = useFormat();
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="in-person-ceremony-url">{t('inPersonDialog.urlLabel')}</Label>
        <Input
          id="in-person-ceremony-url"
          readOnly
          value={session.url}
          className="font-mono text-xs"
          data-testid="in-person-ceremony-url-input"
        />
        <p className="text-xs text-muted-foreground">
          {t('inPersonDialog.expiresAtHint', { time: f.dateTime(session.expiresAt) })}
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          ref={qrTriggerRef}
          type="button"
          variant="secondary"
          className="min-h-11 flex-1"
          onClick={() => onQrOpenChange(true)}
          data-testid="in-person-qr-btn"
        >
          {t('qrHandoff.inPersonButton')}
        </Button>
        <Button
          type="button"
          className="min-h-11 flex-1"
          onClick={() => {
            window.open(session.url, '_blank', 'noopener,noreferrer');
          }}
          data-testid="in-person-open-tab-btn"
        >
          {t('inPersonDialog.openIsolatedTabButton')}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 flex-1"
          onClick={async () => {
            if (await copyTextToClipboard(session.url)) {
              toast(t('inPersonDialog.copiedIncognitoToast'));
            }
          }}
          data-testid="in-person-copy-incognito-btn"
        >
          {t('inPersonDialog.copyIncognitoButton')}
        </Button>
      </div>
      <SignQrModal
        open={qrOpen}
        onOpenChange={onQrOpenChange}
        title={t('qrHandoff.inPersonModalTitle')}
        description={t('qrHandoff.inPersonModalDescription', { signer: session.signerName })}
        url={session.url}
        signerName={session.signerName}
        inPerson
        triggerRef={qrTriggerRef}
        testId="in-person-qr-modal"
      />
    </div>
  );
}

export function SignEnvelopeDetailPage() {
  const t = useTranslations('sign');
  const common = useTranslations('common');
  const f = useFormat();
  const { slug = '', id = '' } = useParams({ strict: false }) as { slug?: string; id?: string };

  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.0);
  const [activeDocKey, setActiveDocKey] = useState('doc-1');
  const [detectedPages, setDetectedPages] = useState<number | null>(null);
  const [activeSignerId, setActiveSignerId] = useState<string | null>(null);
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [initialAllPosition, setInitialAllPosition] = useState<InitialAllPosition>('bottom-right');
  const [draftFields, setDraftFields] = useState<DraftFieldPlacement[]>([]);
  const [fieldsDirty, setFieldsDirty] = useState(false);
  const [dirtyMetaFields, setDirtyMetaFields] = useState<
    ReadonlySet<'title' | 'subject' | 'message' | 'expiresAt' | 'autoRemindBeforeExpiry'>
  >(new Set());
  const metaDirty = dirtyMetaFields.size > 0;
  const fieldsEditRevRef = useRef(0);
  const metaEditRevRef = useRef(0);
  const metaBaseVersionRef = useRef<number | null>(null);
  const pendingActiveSignerIdRef = useRef<string | null>(null);
  const [dismissedProposalIds, setDismissedProposalIds] = useState<string[]>([]);
  const [aiAnalysisOverride, setAiAnalysisOverride] = useState<SignAiAnalysis | null>(null);

  const [titleInput, setTitleInput] = useState('');
  const [subjectInput, setSubjectInput] = useState('');
  const [messageInput, setMessageInput] = useState('');
  const [expiresAtInput, setExpiresAtInput] = useState('');
  const [autoRemindInput, setAutoRemindInput] = useState(true);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [vyOpen, setVyOpen] = useState(false);
  const vyTriggerRef = useRef<HTMLButtonElement>(null);
  const [voidDialogOpen, setVoidDialogOpen] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [mintedLinks, setMintedLinks] = useState<Array<{ signerId: string; url: string }>>([]);
  const [qrModalTarget, setQrModalTarget] = useState<{ url: string; signerName: string } | null>(null);
  const qrModalTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [inPersonQrOpen, setInPersonQrOpen] = useState(false);
  const inPersonQrTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [correctTarget, setCorrectTarget] = useState<SignSignerRecord | null>(null);
  const [correctName, setCorrectName] = useState('');
  const [correctEmail, setCorrectEmail] = useState('');
  const [correctPhone, setCorrectPhone] = useState('');
  const [correctDeliveryMode, setCorrectDeliveryMode] = useState<SignDeliveryMode>('link');
  const [correctRequireOtp, setCorrectRequireOtp] = useState(false);
  const [correctFormError, setCorrectFormError] = useState<string | null>(null);
  const [inPersonSignerId, setInPersonSignerId] = useState<string | null>(null);
  const [inPersonSession, setInPersonSession] = useState<{
    signerId: string;
    signerName: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const inPersonDialogGenRef = useRef(0);
  const inPersonSignerIdRef = useRef<string | null>(null);

  const selectInPersonDialogSigner = useCallback((nextSignerId: string | null) => {
    inPersonDialogGenRef.current += 1;
    inPersonSignerIdRef.current = nextSignerId;
    setInPersonSignerId(nextSignerId);
    setInPersonSession(null);
    setInPersonQrOpen(false);
  }, []);

  useEffect(() => {
    selectInPersonDialogSigner(null);
    return () => {
      inPersonDialogGenRef.current += 1;
      inPersonSignerIdRef.current = null;
    };
  }, [id, selectInPersonDialogSigner]);

  const hasMeQuery = Boolean((orpc as { me?: { get?: { queryOptions?: () => unknown } } }).me?.get?.queryOptions);
  const meQuery = useQuery(
    hasMeQuery
      ? orpc.me.get.queryOptions()
      : { queryKey: ['me', 'get', 'noop'], queryFn: async () => null, enabled: false },
  );

  const hasOrgQuery = Boolean((orpc as { org?: { get?: { queryOptions?: () => unknown } } }).org?.get?.queryOptions);
  const orgQuery = useQuery(
    hasOrgQuery
      ? orpc.org.get.queryOptions()
      : { queryKey: ['org', 'get', 'noop'], queryFn: async () => null, enabled: false },
  );
  const canWriteSign = orgQuery.data
    ? orgQuery.data.role === 'owner' || orgQuery.data.role === 'admin' || orgQuery.data.role === 'member'
    : true;

  const detailQuery = useQuery({
    queryKey: ['sign', 'envelope', id],
    queryFn: () => signApi.getEnvelope(id),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const env = query.state.data?.envelope;
      if (!env) return false;
      const anyDocPending = Boolean(query.state.data?.documents?.some((d) => d.inspectStatus === 'pending'));
      if (env.inspectStatus === 'pending' || anyDocPending) return 3000;
      if (env.status === 'completed' && (env.sealStatus === null || env.sealStatus === 'pending')) return 3000;
      if (env.status === 'sent' || env.status === 'in_progress') return 8000;
      return false;
    },
  });

  const envelope = detailQuery.data?.envelope ?? null;
  const documents = useMemo<readonly SignEnvelopeDocumentSummary[]>(() => {
    const rawDocs = detailQuery.data?.documents;
    if (rawDocs && rawDocs.length > 0) return rawDocs;
    if (!envelope) return [];
    return [
      {
        id: null,
        docIndex: 1,
        title: envelope.title,
        fileId: envelope.sourceFileId,
        sourceSha256: envelope.sourceSha256,
        inspectStatus: envelope.inspectStatus,
        inspectError: envelope.inspectError,
        pageCount: envelope.pageCount,
        pageDimensions: envelope.pageDimensions,
        detectedTags: envelope.detectedTags ?? [],
        sizeBytes: null,
        createdAt: envelope.createdAt,
        updatedAt: envelope.updatedAt,
      },
    ];
  }, [detailQuery.data?.documents, envelope]);
  const doc1Id = documents[0]?.id ?? null;
  const signers = useMemo(() => detailQuery.data?.signers ?? [], [detailQuery.data?.signers]);
  const assignableSigners = useMemo(() => signers.filter((s) => s.signerRole !== 'cc'), [signers]);
  const isDraft = envelope?.status === 'draft';
  const roleHere = meQuery.data?.orgs.find((o) => o.slug === slug)?.role ?? orgQuery.data?.role;
  const currentUserId = meQuery.data?.userId ?? null;
  const canManageLinks = meQuery.data
    ? canManageEnvelopeLinks({
        role: roleHere,
        userId: currentUserId,
        createdBy: envelope?.createdBy,
      })
    : orgQuery.data
      ? orgQuery.data.role === 'owner' || orgQuery.data.role === 'admin'
      : false;
  const canVoid = meQuery.data
    ? canVoidEnvelope({
        role: roleHere,
        userId: currentUserId,
        createdBy: envelope?.createdBy,
      })
    : orgQuery.data
      ? orgQuery.data.role === 'owner' || orgQuery.data.role === 'admin'
      : false;
  // The draft of a meeting-minutes envelope is read by every reader of the meeting but changed and sent only by its creator, an owner or an admin (#4530); the server refuses the others with 403.
  const canChangeDraft = envelope?.sourceKind !== 'meeting_minutes' || canManageLinks;
  const canEditDraft = isDraft && canChangeDraft;
  // Reminding the signers and starting an in-person session follow the same rule on a meeting-minutes envelope (#4530).
  const canRemind =
    canChangeDraft &&
    (meQuery.data ? Boolean(roleHere && roleHere !== 'viewer') : orgQuery.data ? canWriteSign : false);
  const canCorrectRecipients = Boolean(
    envelope &&
      (envelope.status === 'sent' || envelope.status === 'in_progress') &&
      meQuery.data &&
      (roleHere === 'owner' || roleHere === 'admin' || (currentUserId !== null && envelope.createdBy === currentUserId)),
  );

  useEffect(() => {
    fieldsEditRevRef.current = 0;
    metaEditRevRef.current = 0;
    metaBaseVersionRef.current = null;
    pendingActiveSignerIdRef.current = null;
    setFieldsDirty(false);
    setDirtyMetaFields(new Set());
    setSelectedFieldId(null);
    setDismissedProposalIds([]);
    setAiAnalysisOverride(null);
    setActiveDocKey('doc-1');
    setDetectedPages(null);
    setPageNumber(1);
    setMintedLinks([]);
    setQrModalTarget(null);
    setInPersonQrOpen(false);
  }, [id]);

  useEffect(() => {
    if (!detailQuery.data || fieldsDirty) return;
    setDraftFields(toDraftPlacements(detailQuery.data.fields));
  }, [detailQuery.data, fieldsDirty]);

  useEffect(() => {
    if (!detailQuery.data) return;
    const env = detailQuery.data.envelope;
    if (!dirtyMetaFields.has('title')) setTitleInput(env.title);
    if (!dirtyMetaFields.has('subject')) setSubjectInput(env.subject ?? '');
    if (!dirtyMetaFields.has('message')) setMessageInput(env.message ?? '');
    if (!dirtyMetaFields.has('expiresAt')) setExpiresAtInput(toDatetimeLocalValue(env.expiresAt));
    if (!dirtyMetaFields.has('autoRemindBeforeExpiry')) setAutoRemindInput(env.autoRemindBeforeExpiry ?? true);
    if (dirtyMetaFields.size === 0) {
      metaBaseVersionRef.current = env.version;
    }
  }, [detailQuery.data, dirtyMetaFields]);

  useEffect(() => {
    const pendingId = pendingActiveSignerIdRef.current;
    if (pendingId) {
      if (assignableSigners.some((s) => s.id === pendingId)) {
        pendingActiveSignerIdRef.current = null;
        setActiveSignerId(pendingId);
      }
      return;
    }
    if (assignableSigners.length === 0) {
      setActiveSignerId(null);
      return;
    }
    if (!activeSignerId || !assignableSigners.some((s) => s.id === activeSignerId)) {
      setActiveSignerId(assignableSigners[0]!.id);
    }
  }, [assignableSigners, activeSignerId]);

  const activeDoc = useMemo(
    () => documents.find((d) => (d.id ?? 'doc-1') === activeDocKey) ?? documents[0] ?? null,
    [documents, activeDocKey],
  );
  const activeDocId = activeDoc?.id ?? null;
  const resolvedActiveDocKey = activeDoc ? (activeDoc.id ?? 'doc-1') : 'doc-1';
  const isViewingSealedUnified = Boolean(envelope?.sealedFileId);
  const pdfFileId = envelope?.sealedFileId ?? activeDoc?.fileId ?? envelope?.sourceFileId ?? null;
  const pdfQuery = useQuery({
    queryKey: ['sign', 'pdf', pdfFileId],
    queryFn: () => downloadSignPdfBytes(pdfFileId!),
    enabled: Boolean(pdfFileId),
    staleTime: 5 * 60_000,
  });

  const aiQuery = useQuery({
    queryKey: ['sign', 'ai', id],
    queryFn: () => signApi.getAiAnalysis(id),
    enabled: Boolean(id),
  });

  const eventsQuery = useQuery({
    queryKey: ['sign', 'events', id, envelope?.version ?? 0],
    queryFn: () => signApi.getEnvelopeEvents(id),
    enabled: Boolean(id) && envelope !== null && envelope.status !== 'draft',
  });

  const verifyQuery = useQuery({
    queryKey: ['sign', 'verify', id, envelope?.version ?? 0, envelope?.sealStatus ?? 'none'],
    queryFn: () => signApi.verifyEnvelope(id),
    enabled: Boolean(id) && envelope !== null && envelope.status !== 'draft',
  });

  const isCompletedAndSealed = envelope?.status === 'completed' && envelope?.sealStatus === 'sealed';

  const caSettingsQuery = useQuery({
    queryKey: ['sign', 'ca-settings'],
    queryFn: () => signApi.getCaSettings(),
    enabled: Boolean(isCompletedAndSealed),
  });

  const caRequestsQuery = useQuery({
    queryKey: ['sign', 'ca-requests', id],
    queryFn: () => signApi.listCaRequests(id),
    enabled: Boolean(id) && Boolean(isCompletedAndSealed),
    refetchInterval: (query) => {
      const hasPending = query.state.data?.items.some(
        (r) => r.status === 'pending' || (r.status === 'signed' && !r.padesFileId),
      );
      return hasPending ? 3000 : false;
    },
  });

  const activeCaConnection = useMemo(() => {
    const conns = caSettingsQuery.data?.connections.filter((c) => c.status === 'active') ?? [];
    return conns.find((c) => c.provider !== 'sandbox') ?? conns[0] ?? null;
  }, [caSettingsQuery.data]);

  const latestCaRequest = caRequestsQuery.data?.items[0] ?? null;
  const canInitiateCa = canManageSignCa(orgQuery.data?.role) && activeCaConnection !== null;

  const initiateCaMutation = useMutation({
    mutationFn: (caConnectionId: string) =>
      signApi.initiateCaRequest({ envelopeId: id, caConnectionId }),
    onSuccess: async () => {
      toast(t('ca.initiatingToast'));
      await queryClient.invalidateQueries({ queryKey: ['sign', 'ca-requests', id] });
      await invalidateAll();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const invalidateAll = async () => {
    await queryClient.invalidateQueries({ queryKey: ['sign', 'envelope', id] });
    await queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] });
    await queryClient.invalidateQueries({ queryKey: ['sign', 'events', id] });
    await queryClient.invalidateQueries({ queryKey: ['sign', 'verify', id] });
    await queryClient.invalidateQueries({ queryKey: ['today'] });
    await queryClient.invalidateQueries({ queryKey: orpc.today.list.queryKey() });
  };

  const syncMetaBaseVersion = (nextVersion: number) => {
    if (metaBaseVersionRef.current !== null) {
      metaBaseVersionRef.current = nextVersion;
    }
  };

  const saveFieldsMutation = useMutation({
    mutationFn: async (fieldsToSave: readonly DraftFieldPlacement[]) => {
      const revision = fieldsEditRevRef.current;
      const result = await signApi.setFields(
        id,
        fieldsToSave.map((fItem) => ({
          ...(fItem.documentId ? { documentId: fItem.documentId } : {}),
          signerId: fItem.signerId,
          fieldType: fItem.fieldType,
          pageNumber: fItem.pageNumber,
          xNorm: fItem.xNorm,
          yNorm: fItem.yNorm,
          wNorm: fItem.wNorm,
          hNorm: fItem.hNorm,
          ...(fItem.label?.trim() ? { label: fItem.label.trim() } : {}),
          required: fItem.required,
          proposedByAi: fItem.proposedByAi,
          ...(fItem.fontSizePt ? { fontSizePt: fItem.fontSizePt } : {}),
          ...(isChoiceFieldType(fItem.fieldType) ? { options: normalizeChoiceOptions(fItem.options) } : {}),
        })),
      );
      return { result, revision };
    },
    onSuccess: async ({ result, revision }) => {
      syncMetaBaseVersion(result.version);
      toast(t('actions.fieldsSavedToast'));
      await invalidateAll();
      if (fieldsEditRevRef.current === revision) {
        setFieldsDirty(false);
      }
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const markMetaFieldDirty = (
    field: 'title' | 'subject' | 'message' | 'expiresAt' | 'autoRemindBeforeExpiry',
  ) => {
    metaEditRevRef.current += 1;
    setDirtyMetaFields((prev) => {
      if (prev.size === 0 && envelope) {
        metaBaseVersionRef.current = envelope.version;
      }
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  };

  const buildMetadataPayload = (fallbackTitle: string) => ({
    ...(dirtyMetaFields.has('title') ? { title: titleInput.trim() || fallbackTitle } : {}),
    ...(dirtyMetaFields.has('subject') ? { subject: subjectInput.trim() || null } : {}),
    ...(dirtyMetaFields.has('message') ? { message: messageInput.trim() || null } : {}),
    ...(dirtyMetaFields.has('expiresAt') ? { expiresAt: fromDatetimeLocalValue(expiresAtInput) } : {}),
    ...(dirtyMetaFields.has('autoRemindBeforeExpiry') ? { autoRemindBeforeExpiry: autoRemindInput } : {}),
  });

  const updateMetaMutation = useMutation({
    mutationFn: async (input: {
      routingMode?: SignRoutingMode;
      allowDelegation?: boolean;
      title?: string;
      subject?: string | null;
      message?: string | null;
      expiresAt?: string | null;
      autoRemindBeforeExpiry?: boolean;
    }) => {
      const metaRevision = metaEditRevRef.current;
      const hasTextMeta =
        'title' in input ||
        'subject' in input ||
        'message' in input ||
        'expiresAt' in input ||
        'autoRemindBeforeExpiry' in input;
      const expectedVersion = hasTextMeta
        ? (metaBaseVersionRef.current ?? envelope?.version)
        : envelope?.version;
      const result = await signApi.updateEnvelope({
        envelopeId: id,
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        ...input,
      });
      return { result, metaRevision, hasTextMeta };
    },
    onSuccess: async ({ result, metaRevision, hasTextMeta }) => {
      syncMetaBaseVersion(result.version);
      toast(t('draftSavedToast'));
      if (hasTextMeta && metaEditRevRef.current === metaRevision) {
        metaBaseVersionRef.current = result.version;
        setDirtyMetaFields(new Set());
      }
      await invalidateAll();
    },
    onError: async (err) => {
      toast(errorMessage(err), 'error');
      const fresh = await detailQuery.refetch();
      if (fresh.data) {
        metaBaseVersionRef.current = fresh.data.envelope.version;
      }
    },
  });

  const acknowledgeDeclineMutation = useMutation({
    mutationFn: () => signApi.acknowledgeDecline(id),
    onSuccess: async () => {
      toast(t('actions.declineAcknowledgedToast'));
      await invalidateAll();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      const doc1FileId = documents[0]?.fileId ?? envelope?.sourceFileId ?? null;
      const rawPdf =
        !isViewingSealedUnified && activeDoc?.docIndex === 1 && pdfQuery.data
          ? pdfQuery.data
          : doc1FileId
            ? await downloadSignPdfBytes(doc1FileId)
            : null;
      let pages: Array<{ page: number; text: string }> | undefined;
      if (rawPdf) {
        try {
          const extracted = await extractPdfPagesText(rawPdf);
          if (extracted.length > 0) pages = extracted;
        } catch {
          // Fall back cleanly if client PDF text extraction fails on a malformed file.
        }
      }
      return signApi.analyzeAi(id, pages);
    },
    onSuccess: (res) => {
      if (res) {
        setAiAnalysisOverride(res);
        setDismissedProposalIds([]);
      }
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      if (metaDirty) {
        await updateMetaMutation.mutateAsync(buildMetadataPayload(envelope?.title ?? ''));
      }
      if (fieldsDirty) {
        await saveFieldsMutation.mutateAsync(draftFields);
      }
      return signApi.sendEnvelope(id);
    },
    onSuccess: async (res) => {
      setSendDialogOpen(false);
      toast(t('sendConfirm.sentToast'));
      setMintedLinks(res.links.map((item) => ({ signerId: item.signerId, url: buildSigningUrl(item.token) })));
      await invalidateAll();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const voidMutation = useMutation({
    mutationFn: (reason: string) => signApi.voidEnvelope(id, reason.trim() || undefined),
    onSuccess: async () => {
      setVoidDialogOpen(false);
      setVoidReason('');
      toast(t('voidDialog.voidedToast'));
      await invalidateAll();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const canEditSharedSummary = useMemo(() => {
    if (!envelope) return false;
    if (envelope.status !== 'draft' && envelope.status !== 'sent' && envelope.status !== 'in_progress') {
      return false;
    }
    const me = meQuery.data;
    if (!me) return true;
    const orgSummary = me.orgs.find((o) => o.slug === slug);
    if (!orgSummary) return false;
    if (orgSummary.role === 'owner' || orgSummary.role === 'admin') return true;
    return orgSummary.role === 'member' && envelope.createdBy !== null && me.userId === envelope.createdBy;
  }, [envelope, meQuery.data, slug]);

  const sharedSummaryMutation = useMutation({
    mutationFn: (payload: { shareSummaryWithSigners: boolean; sharedSummary: SignSharedSummary | null }) =>
      signApi.setEnvelopeSharedSummary({
        envelopeId: id,
        shareSummaryWithSigners: payload.shareSummaryWithSigners,
        sharedSummary: payload.sharedSummary,
        ...(envelope ? { expectedVersion: envelope.version } : {}),
      }),
    onSuccess: async () => {
      toast(t('sharedSummary.savedToast'));
      await invalidateAll();
    },
    onError: (err) => toast(errorMessage(err), 'error'),
  });

  const openCorrectRecipientDialog = (signer: SignSignerRecord) => {
    setCorrectTarget(signer);
    setCorrectName(signer.name);
    setCorrectEmail(signer.email ?? '');
    setCorrectPhone(signer.phone ?? '');
    setCorrectDeliveryMode(signer.deliveryMode);
    setCorrectRequireOtp(signer.requireEmailOtp);
    setCorrectFormError(null);
  };

  const correctRecipientMutation = useMutation({
    mutationFn: async (payload: {
      signerId: string;
      name: string;
      email: string | null;
      phone: string | null;
      deliveryMode: SignDeliveryMode;
      requireEmailOtp: boolean;
    }) => {
      return signApi.correctSignerRecipient({
        envelopeId: id,
        ...payload,
      });
    },
    onSuccess: async (res) => {
      setCorrectTarget(null);
      setCorrectFormError(null);
      if (res.link) {
        const url = buildSigningUrl(res.link.token);
        setMintedLinks((prev) => [...prev.filter((item) => item.signerId !== res.signerId), { signerId: res.signerId, url }]);
        await copyTextToClipboard(url);
        toast(t('correctDialog.savedLinkToast'));
      } else {
        setMintedLinks((prev) => prev.filter((item) => item.signerId !== res.signerId));
        toast(res.mailStatus ? t('correctDialog.savedEmailToast') : t('correctDialog.savedWaitingToast'));
      }
      await invalidateAll();
    },
    onError: (err) => setCorrectFormError(errorMessage(err)),
  });

  const handleCorrectRecipientSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!correctTarget) return;
    setCorrectFormError(null);
    const trimmedName = correctName.trim();
    const trimmedEmail = correctEmail.trim();
    const trimmedPhone = correctPhone.trim();
    if (!trimmedName) {
      setCorrectFormError(t('signer.nameLabel'));
      return;
    }
    const nextOtp = correctTarget.signerRole === 'cc' ? false : correctRequireOtp;
    if ((correctDeliveryMode === 'email' || nextOtp) && !isEmailAddress(trimmedEmail)) {
      setCorrectFormError(t('signer.emailNeededForOtp'));
      return;
    }
    if (trimmedEmail && !isEmailAddress(trimmedEmail)) {
      setCorrectFormError(t('signer.emailNeededForOtp'));
      return;
    }
    correctRecipientMutation.mutate({
      signerId: correctTarget.id,
      name: trimmedName,
      email: trimmedEmail || null,
      phone: trimmedPhone || null,
      deliveryMode: correctDeliveryMode,
      requireEmailOtp: nextOtp,
    });
  };

  const startInPersonMutation = useMutation({
    mutationFn: async ({ signerId, dialogGen }: { signerId: string; dialogGen: number }) => {
      const res = await signApi.startInPersonSigning(id, signerId);
      const signerName = signers.find((s) => s.id === signerId)?.name ?? '';
      return {
        dialogGen,
        signerId,
        signerName,
        url: buildInPersonSigningUrl(res.token),
        expiresAt: res.expiresAt,
      };
    },
    onSuccess: async ({ dialogGen, ...session }) => {
      setMintedLinks((prev) => prev.filter((item) => item.signerId !== session.signerId));
      if (inPersonDialogGenRef.current === dialogGen && inPersonSignerIdRef.current === session.signerId) {
        setInPersonSession(session);
        toast(t('inPersonDialog.startedToast'));
      }
      await invalidateAll();
    },
    onError: (err, vars) => {
      if (inPersonDialogGenRef.current !== vars.dialogGen || inPersonSignerIdRef.current !== vars.signerId) {
        return;
      }
      toast(errorMessage(err), 'error');
    },
  });
  const effectiveAi = useMemo(
    () => normalizeAiAnalysis(aiAnalysisOverride ?? aiQuery.data ?? null),
    [aiAnalysisOverride, aiQuery.data],
  );
  const pendingProposals = useMemo(
    () => filterPendingProposalsForSigners(effectiveAi?.proposedFields ?? [], signers, dismissedProposalIds),
    [effectiveAi, signers, dismissedProposalIds],
  );

  const effectivePageCount = Math.max(
    1,
    (isViewingSealedUnified
      ? envelope?.pageCount
      : activeDoc?.pageCount ?? (activeDoc?.docIndex === 1 ? envelope?.pageCount : null)) ??
      detectedPages ??
      1,
  );
  const fieldsForActiveDoc = useMemo(() => {
    if (isViewingSealedUnified) return [];
    return draftFields.filter((f) => (f.documentId ?? doc1Id ?? null) === activeDocId);
  }, [draftFields, doc1Id, activeDocId, isViewingSealedUnified]);
  const sealedOverlayFields = useMemo(() => {
    if (!isViewingSealedUnified) return [];
    let offset = 0;
    const offsetByKey = new Map<string, number>();
    for (const doc of documents) {
      offsetByKey.set(doc.id ?? 'doc-1', offset);
      offset += Math.max(0, doc.pageCount ?? 0);
    }
    return draftFields.map((f) => ({
      ...f,
      pageNumber: (offsetByKey.get(f.documentId ?? doc1Id ?? 'doc-1') ?? 0) + f.pageNumber,
    }));
  }, [isViewingSealedUnified, documents, draftFields, doc1Id]);
  const viewerFields = isViewingSealedUnified ? sealedOverlayFields : fieldsForActiveDoc;
  const selectedField = draftFields.find((item) => item.localId === selectedFieldId) ?? null;
  const detectedTags = useMemo(
    () =>
      isViewingSealedUnified
        ? []
        : activeDoc?.detectedTags ?? (activeDoc?.docIndex === 1 ? envelope?.detectedTags ?? [] : []),
    [isViewingSealedUnified, activeDoc, envelope?.detectedTags],
  );
  const tagPlan = useMemo(
    () =>
      planDetectedTagsForSigners({
        detectedTags,
        signers,
        existingFields: fieldsForActiveDoc,
        pageCount: effectivePageCount,
      }),
    [detectedTags, signers, fieldsForActiveDoc, effectivePageCount],
  );

  const readinessIssue = envelope
    ? checkSendReadiness({
        inspectStatus: envelope.inspectStatus,
        documents,
        signers,
        fields: draftFields,
      })
    : 'NOT_INSPECTED';

  const handleSelectDocument = (documentId: string | null, _docIndex: number, targetPage = 1) => {
    setActiveDocKey(documentId ?? 'doc-1');
    setDetectedPages(null);
    setSelectedFieldId(null);
    setPageNumber(Math.max(1, targetPage));
  };

  useEffect(() => {
    if (pageNumber > effectivePageCount) {
      setPageNumber(effectivePageCount);
    }
  }, [pageNumber, effectivePageCount]);

  const updateDraftFields = (updater: (prev: DraftFieldPlacement[]) => DraftFieldPlacement[]) => {
    fieldsEditRevRef.current += 1;
    setDraftFields(updater);
    setFieldsDirty(true);
  };

  const resolveProposalSignerId = (proposedSignerId: string): string =>
    assignableSigners.some((s) => s.id === proposedSignerId) ? proposedSignerId : '';

  const defaultChoiceOptions = () => [
    t('fields.defaultOptionN', { index: '1' }),
    t('fields.defaultOptionN', { index: '2' }),
  ];

  const handleAddField = (fieldType: SignFieldType, coords?: { pageNumber: number; xCenterNorm: number; yCenterNorm: number }) => {
    if (!canEditDraft || !activeSignerId) return;
    const targetPage = coords?.pageNumber ?? pageNumber;
    const existingOnPageCount = fieldsForActiveDoc.filter((item) => item.pageNumber === targetPage).length;
    const box = createPlacedFieldBox({
      fieldType,
      ...(coords ? { xCenterNorm: coords.xCenterNorm, yCenterNorm: coords.yCenterNorm } : {}),
      existingOnPageCount,
    });
    const localId = `draft-${globalThis.crypto.randomUUID()}`;
    updateDraftFields((prev) => [
      ...prev,
      {
        localId,
        documentId: activeDocId,
        signerId: activeSignerId,
        fieldType,
        pageNumber: targetPage,
        ...box,
        label: fieldType === 'attachment' ? t('fields.attachmentPresets.idCard') : null,
        required: true,
        proposedByAi: false,
        options: isChoiceFieldType(fieldType) ? defaultChoiceOptions() : null,
      },
    ]);
    setSelectedFieldId(localId);
  };

  const handleInitialAllPrecedingPages = () => {
    if (!canEditDraft || !activeSignerId || effectivePageCount < 2) return;
    const plan = planInitialAllPrecedingPages({
      signerId: activeSignerId,
      pageCount: effectivePageCount,
      existingFields: fieldsForActiveDoc,
      position: initialAllPosition,
    });
    if (plan.added.length === 0) {
      toast(t('fields.initialAllAlreadyPlacedToast'));
      return;
    }
    const placed: DraftFieldPlacement[] = plan.added.map((item) => ({
      localId: `draft-${globalThis.crypto.randomUUID()}`,
      documentId: activeDocId,
      signerId: item.signerId,
      fieldType: 'initials',
      pageNumber: item.pageNumber,
      xNorm: item.xNorm,
      yNorm: item.yNorm,
      wNorm: item.wNorm,
      hNorm: item.hNorm,
      label: item.label,
      required: item.required,
      proposedByAi: false,
    }));
    updateDraftFields((prev) => [...prev, ...placed]);
    setSelectedFieldId(placed[0]!.localId);
    setPageNumber(placed[0]!.pageNumber);
    toast(t('fields.initialAllAddedToast', { count: String(placed.length) }));
  };

  const handleUpdateFieldBox = (localId: string, nextBox: NormalizedBox) => {
    updateDraftFields((prev) =>
      prev.map((item) => (item.localId === localId ? { ...item, ...clampFieldBox(nextBox) } : item)),
    );
  };

  const handleDeleteField = (localId: string) => {
    updateDraftFields((prev) => prev.filter((item) => item.localId !== localId));
    if (selectedFieldId === localId) setSelectedFieldId(null);
  };

  const handleApplyProposal = (proposal: SignProposedField, adjustedBox?: NormalizedBox) => {
    if (!canEditDraft) return;
    const signerId = resolveProposalSignerId(proposal.signerId);
    if (!signerId) return;
    const box = clampFieldBox(adjustedBox ?? proposal);
    const localId = `prop-${globalThis.crypto.randomUUID()}`;
    const cleanedOpts = isChoiceFieldType(proposal.fieldType) ? normalizeChoiceOptions(proposal.options) : [];
    const doc1PageCount = Math.max(1, documents[0]?.pageCount ?? envelope?.pageCount ?? effectivePageCount);
    updateDraftFields((prev) => [
      ...prev,
      {
        localId,
        documentId: doc1Id,
        signerId,
        fieldType: proposal.fieldType,
        pageNumber: Math.min(doc1PageCount, Math.max(1, proposal.pageNumber)),
        ...box,
        label: proposal.label,
        required: proposal.required,
        proposedByAi: true,
        options: isChoiceFieldType(proposal.fieldType)
          ? (cleanedOpts.length > 0 ? cleanedOpts : defaultChoiceOptions())
          : null,
      },
    ]);
    setDismissedProposalIds((prev) => [...prev, proposal.proposalId]);
    setSelectedFieldId(localId);
  };

  const handleApplyAllProposals = () => {
    if (!canEditDraft || pendingProposals.length === 0) return;
    const nextFields: DraftFieldPlacement[] = [];
    const appliedIds: string[] = [];
    const doc1PageCount = Math.max(1, documents[0]?.pageCount ?? envelope?.pageCount ?? effectivePageCount);
    for (const proposal of pendingProposals) {
      const signerId = resolveProposalSignerId(proposal.signerId);
      if (!signerId) continue;
      const box = clampFieldBox(proposal);
      const cleanedOpts = isChoiceFieldType(proposal.fieldType) ? normalizeChoiceOptions(proposal.options) : [];
      nextFields.push({
        localId: `prop-${globalThis.crypto.randomUUID()}`,
        documentId: doc1Id,
        signerId,
        fieldType: proposal.fieldType,
        pageNumber: Math.min(doc1PageCount, Math.max(1, proposal.pageNumber)),
        ...box,
        label: proposal.label,
        required: proposal.required,
        proposedByAi: true,
        options: isChoiceFieldType(proposal.fieldType)
          ? (cleanedOpts.length > 0 ? cleanedOpts : defaultChoiceOptions())
          : null,
      });
      appliedIds.push(proposal.proposalId);
    }
    if (nextFields.length === 0) return;
    updateDraftFields((prev) => [...prev, ...nextFields]);
    setDismissedProposalIds((prev) => [...prev, ...appliedIds]);
  };

  const handleApplyDetectedTags = () => {
    if (!canEditDraft || tagPlan.applicable.length === 0) return;
    const placed: DraftFieldPlacement[] = tagPlan.applicable.map((item) => ({
      localId: `tag-${globalThis.crypto.randomUUID()}`,
      documentId: activeDocId,
      signerId: item.signerId,
      fieldType: item.fieldType,
      pageNumber: item.pageNumber,
      xNorm: item.xNorm,
      yNorm: item.yNorm,
      wNorm: item.wNorm,
      hNorm: item.hNorm,
      label: item.label,
      required: item.required,
      proposedByAi: false,
      options: isChoiceFieldType(item.fieldType)
        ? (item.options && item.options.length > 0 ? item.options : defaultChoiceOptions())
        : null,
    }));
    updateDraftFields((prev) => [...prev, ...placed]);
    setSelectedFieldId(placed[0]!.localId);
    setPageNumber(placed[0]!.pageNumber);
    toast(t('tags.appliedToast', { count: String(placed.length) }));
  };

  const handleAddSigner = async (input: AddSignerFormInput) => {
    let addedSignerId: string | null = null;
    try {
      const nextRoutingOrder = signers.reduce((max, signer) => Math.max(max, signer.routingOrder), 0) + 1;
      const res = await signApi.addSigner({
        envelopeId: id,
        routingOrder: nextRoutingOrder,
        ...input,
      });
      syncMetaBaseVersion(res.version);
      if (input.signerRole !== 'cc') {
        addedSignerId = res.signerId;
        pendingActiveSignerIdRef.current = addedSignerId;
      }
      await invalidateAll();
      if (addedSignerId && pendingActiveSignerIdRef.current === addedSignerId) {
        setActiveSignerId(addedSignerId);
      }
    } catch (err) {
      if (addedSignerId && pendingActiveSignerIdRef.current === addedSignerId) {
        pendingActiveSignerIdRef.current = null;
      }
      toast(errorMessage(err), 'error');
      throw err;
    }
  };

  const handleRemoveSigner = async (signerId: string) => {
    if (pendingActiveSignerIdRef.current === signerId) {
      pendingActiveSignerIdRef.current = null;
    }
    try {
      const removed = await signApi.removeSigner(id, signerId);
      syncMetaBaseVersion(removed.version);
      setDraftFields((prev) => prev.filter((item) => item.signerId !== signerId));
      await invalidateAll();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const handleMoveSigner = async (signerId: string, direction: -1 | 1) => {
    const idx = signers.findIndex((s) => s.id === signerId);
    const swapIdx = idx + direction;
    if (idx === -1 || swapIdx < 0 || swapIdx >= signers.length) return;
    const reordered = [...signers];
    const current = reordered[idx]!;
    reordered[idx] = reordered[swapIdx]!;
    reordered[swapIdx] = current;
    try {
      const reorderedRes = await signApi.reorderSigners(
        id,
        reordered.map((s, orderIdx) => ({ signerId: s.id, routingOrder: orderIdx + 1 })),
      );
      syncMetaBaseVersion(reorderedRes.version);
      await invalidateAll();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const handleCopyZaloLink = async (signerId: string) => {
    try {
      const minted = await signApi.createSignerLink(id, signerId);
      const url = buildSigningUrl(minted.token);
      setMintedLinks((prev) => [...prev.filter((item) => item.signerId !== signerId), { signerId, url }]);
      if (await copyTextToClipboard(url)) {
        toast(t('actions.linkCopiedToast'));
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const handleRemindSigner = async (signerId: string) => {
    try {
      await signApi.remindEnvelope(id, signerId);
      toast(t('actions.remindedToast'));
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const handleDownload = async (fileId: string | null, filename: string) => {
    if (!fileId) return;
    try {
      const blob = await downloadSignFile(fileId);
      triggerDownload(blob, filename);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const copyDigest = async (value: string) => {
    if (await copyTextToClipboard(value)) {
      toast(t('evidence.copiedToast'));
    }
  };

  if (detailQuery.isLoading) return <ListSkeleton rows={5} />;
  if (detailQuery.isError) return <ErrorText>{errorMessage(detailQuery.error)}</ErrorText>;
  if (!envelope) return null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to="/o/$slug/sign/envelopes" params={{ slug }} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
          {t('actions.backToList')}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{t(`statuses.${envelope.status}`)}</Badge>
          <Badge variant="secondary">{t(`inspectStatuses.${envelope.inspectStatus}`)}</Badge>
          {envelope.allowDelegation ? (
            <Badge variant="outline" data-testid="sign-allow-delegation-badge">
              {t('allowDelegationBadge')}
            </Badge>
          ) : null}
          {envelope.sealStatus || envelope.status === 'completed' ? (
            <Badge variant="secondary">{t(`sealStatuses.${envelope.sealStatus ?? 'pending'}`)}</Badge>
          ) : null}
        </div>
      </div>

      <PageHeader
        title={envelope.title}
        subtitle={`${t(`routing.${envelope.routingMode}`)} - ${t('fieldsCount', { count: String(draftFields.length) })}`}
        actions={
          <div className="flex flex-wrap gap-2">
            <VyClauseTrigger
              open={vyOpen}
              onToggle={() => setVyOpen((v) => !v)}
              buttonRef={vyTriggerRef}
              proposalCount={pendingProposals.length}
            />
            {canEditDraft ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={!fieldsDirty}
                  loading={saveFieldsMutation.isPending}
                  onClick={() => saveFieldsMutation.mutate(draftFields)}
                  data-testid="sign-save-fields-btn"
                >
                  {t('actions.saveFields')}
                </Button>
                <Button
                  type="button"
                  disabled={readinessIssue !== null}
                  onClick={() => setSendDialogOpen(true)}
                  data-testid="sign-send-open-btn"
                >
                  {t('actions.send')}
                </Button>
              </>
            ) : null}
            {canVoid && (envelope.status === 'sent' || envelope.status === 'in_progress') ? (
              <Button type="button" variant="destructive" onClick={() => setVoidDialogOpen(true)}>
                {t('actions.void')}
              </Button>
            ) : null}
            {envelope.status === 'declined' ? (
              envelope.declineAcknowledgedAt ? (
                <Badge variant="outline" data-testid="sign-decline-acked-badge">
                  {t('actions.declineAcknowledgedBadge')}
                </Badge>
              ) : queryClient.getQueryData(orpc.org.get.queryKey())?.role !== 'viewer' ? (
                <Button
                  type="button"
                  variant="outline"
                  loading={acknowledgeDeclineMutation.isPending}
                  onClick={() => acknowledgeDeclineMutation.mutate()}
                  data-testid="sign-ack-decline-btn"
                >
                  {t('actions.acknowledgeDecline')}
                </Button>
              ) : null
            ) : null}
          </div>
        }
      />

      <VyClauseSheet
        open={vyOpen}
        onClose={() => setVyOpen(false)}
        triggerRef={vyTriggerRef}
        aiAnalysis={effectiveAi}
        pendingProposals={pendingProposals}
        editable={canEditDraft}
        analyzing={analyzeMutation.isPending}
        onAnalyze={() => analyzeMutation.mutate()}
        onJumpToPage={(targetPage) => {
          const doc1Pages = Math.max(1, documents[0]?.pageCount ?? envelope.pageCount ?? effectivePageCount);
          setActiveDocKey(doc1Id ?? 'doc-1');
          setPageNumber(Math.min(doc1Pages, Math.max(1, targetPage)));
          setVyOpen(false);
        }}
        onApplyAllProposals={handleApplyAllProposals}
      />

      {envelope.sourceKind === 'hr_contract' ? (
        <Alert data-testid="sign-hr-contract-nd337-banner">
          <AlertTitle>{t('hrContractNd337.title')}</AlertTitle>
          <AlertDescription>{t('hrContractNd337.body')}</AlertDescription>
        </Alert>
      ) : null}

      {envelope.inspectStatus === 'pending' ? (
        <Alert>
          <AlertDescription>{t('inspectPendingBanner')}</AlertDescription>
        </Alert>
      ) : null}
      {envelope.inspectStatus === 'failed' ? <ErrorText>{t('inspectFailedBanner')}</ErrorText> : null}
      {envelope.status === 'completed' && (envelope.sealStatus === null || envelope.sealStatus === 'pending') ? (
        <Alert>
          <AlertDescription>{t('sealPendingBanner')}</AlertDescription>
        </Alert>
      ) : null}
      {envelope.status === 'completed' && envelope.sealStatus === 'failed' ? (
        <ErrorText>{t('sealFailedBanner')}</ErrorText>
      ) : null}
      {canEditDraft && readinessIssue ? (
        <p className="text-xs text-muted-foreground" data-testid="sign-readiness-hint">
          {t(`sendConfirm.readyHints.${readinessIssue}`)}
        </p>
      ) : null}

      <MintedZaloLinksCard
        mintedLinks={mintedLinks}
        signers={signers}
        onOpenQr={(target, trigger) => {
          qrModalTriggerRef.current = trigger;
          setQrModalTarget(target);
        }}
      />

      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <SignPacketManager
            envelopeId={envelope.id}
            canEditDraft={canEditDraft}
            canRunConsistency={canRemind}
            documents={documents}
            activeDocumentKey={resolvedActiveDocKey}
            fields={draftFields}
            onSelectDocument={handleSelectDocument}
            onBeforeMutatePacket={async () => {
              if (fieldsDirty) {
                await saveFieldsMutation.mutateAsync(draftFields);
              }
            }}
            onPacketChanged={invalidateAll}
          />

          <SignerPanel
            envelopeStatus={envelope.status}
            canEditDraft={canChangeDraft}
            routingMode={envelope.routingMode}
            signers={signers}
            activeSignerId={activeSignerId}
            busy={updateMetaMutation.isPending}
            onSelectSigner={(signerId) => {
              pendingActiveSignerIdRef.current = null;
              setActiveSignerId(signerId);
            }}
            onChangeRoutingMode={(mode) => updateMetaMutation.mutate({ routingMode: mode })}
            onAddSigner={handleAddSigner}
            onRemoveSigner={handleRemoveSigner}
            onMoveSigner={handleMoveSigner}
            {...(canManageLinks ? { onCopyZaloLink: handleCopyZaloLink } : {})}
            {...(canRemind ? { onRemindSigner: handleRemindSigner } : {})}
            {...(canCorrectRecipients ? { onCorrectSigner: openCorrectRecipientDialog } : {})}
            onStartInPerson={
              canRemind
                ? (signerId) => {
                    selectInPersonDialogSigner(signerId);
                  }
                : undefined
            }
          />

          <SignZaloHandoffPanel
            key={envelope.id}
            envelope={{
              id: envelope.id,
              title: envelope.title,
              status: envelope.status,
              sourceKind: envelope.sourceKind,
              sourceId: envelope.sourceId,
              expiresAt: envelope.expiresAt,
            }}
            signers={signers}
            canManageLinks={canManageLinks}
            mintedLinks={mintedLinks}
            onMintedLink={(signerId, url) => {
              setMintedLinks((prev) => [...prev.filter((item) => item.signerId !== signerId), { signerId, url }]);
            }}
          />

          {canEditDraft ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t('saveMetadata')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                <div className="space-y-1">
                  <Label htmlFor="env-title-input" className="text-xs">
                    {t('titleLabel')}
                  </Label>
                  <Input
                    id="env-title-input"
                    value={titleInput}
                    onChange={(e) => {
                      setTitleInput(e.target.value);
                      markMetaFieldDirty('title');
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="env-subject-input" className="text-xs">
                    {t('subjectLabel')}
                  </Label>
                  <Input
                    id="env-subject-input"
                    value={subjectInput}
                    onChange={(e) => {
                      setSubjectInput(e.target.value);
                      markMetaFieldDirty('subject');
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="env-message-input" className="text-xs">
                    {t('messageLabel')}
                  </Label>
                  <Input
                    id="env-message-input"
                    value={messageInput}
                    onChange={(e) => {
                      setMessageInput(e.target.value);
                      markMetaFieldDirty('message');
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor="env-expires-at-input" className="text-xs">
                      {t('expiresAtLabel')}
                    </Label>
                    {expiresAtInput ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs max-md:min-h-11"
                        onClick={() => {
                          setExpiresAtInput('');
                          markMetaFieldDirty('expiresAt');
                        }}
                      >
                        {t('expiresAtClear')}
                      </Button>
                    ) : null}
                  </div>
                  <Input
                    id="env-expires-at-input"
                    type="datetime-local"
                    className="max-md:min-h-11"
                    value={expiresAtInput}
                    onChange={(e) => {
                      setExpiresAtInput(e.target.value);
                      markMetaFieldDirty('expiresAt');
                    }}
                  />
                </div>
                <label
                  htmlFor="env-auto-remind-checkbox"
                  className="flex min-h-11 cursor-pointer items-start gap-2.5 rounded-md py-1.5 text-xs text-foreground"
                >
                  <Checkbox
                    id="env-auto-remind-checkbox"
                    data-testid="env-auto-remind-checkbox"
                    className="mt-0.5"
                    checked={autoRemindInput}
                    onCheckedChange={(checked) => {
                      setAutoRemindInput(Boolean(checked));
                      markMetaFieldDirty('autoRemindBeforeExpiry');
                    }}
                  />
                  <span className="space-y-0.5">
                    <span className="block font-medium">{t('autoRemindLabel')}</span>
                    <span className="block text-[11px] text-muted-foreground">{t('autoRemindHint')}</span>
                  </span>
                </label>
                <div className="space-y-1 pt-1">
                  <label
                    htmlFor="env-allow-delegation-checkbox"
                    className="flex min-h-11 cursor-pointer items-start gap-2.5 text-xs text-foreground"
                  >
                    <Checkbox
                      id="env-allow-delegation-checkbox"
                      checked={Boolean(envelope.allowDelegation)}
                      disabled={updateMetaMutation.isPending}
                      onCheckedChange={(checked) => updateMetaMutation.mutate({ allowDelegation: Boolean(checked) })}
                      className="mt-0.5"
                      data-testid="env-allow-delegation-checkbox"
                    />
                    <span>{t('allowDelegationLabel')}</span>
                  </label>
                  <p className="text-[11px] text-muted-foreground">{t('allowDelegationHint')}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full"
                  loading={updateMetaMutation.isPending}
                  onClick={() => updateMetaMutation.mutate(buildMetadataPayload(envelope.title))}
                  data-testid="env-save-metadata-btn"
                >
                  {t('saveMetadata')}
                </Button>
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="min-w-0 space-y-3">
          {canEditDraft && tagPlan.totalTags > 0 ? (
            <Card data-testid="sign-detected-tags-banner">
              <CardContent className="flex flex-col gap-2.5 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1 text-xs">
                  <p className="font-semibold text-foreground">
                    {t('tags.bannerTitle', { count: String(tagPlan.totalTags) })}
                  </p>
                  <p className="text-muted-foreground">{t('tags.bannerHint')}</p>
                  {tagPlan.unmatchedRoleOrders.length > 0 ? (
                    <p className="text-warning" data-testid="sign-detected-tags-unmatched">
                      {t('tags.unmatchedOrdersHint', {
                        orders: tagPlan.unmatchedRoleOrders.map((n) => `#${n}`).join(', '),
                      })}
                    </p>
                  ) : tagPlan.applicable.length === 0 ? (
                    <p className="text-muted-foreground">{t('tags.allAppliedHint', { count: String(tagPlan.totalTags) })}</p>
                  ) : null}
                </div>
                {tagPlan.applicable.length > 0 || tagPlan.alreadyAppliedCount < tagPlan.totalTags ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={tagPlan.applicable.length === 0}
                    onClick={handleApplyDetectedTags}
                    data-testid="sign-apply-detected-tags-btn"
                  >
                    {t('tags.applyButton', {
                      count: String(tagPlan.applicable.length > 0 ? tagPlan.applicable.length : tagPlan.totalTags),
                    })}
                  </Button>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {canEditDraft ? (
            <Card>
              <CardContent className="space-y-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground">{t('fields.paletteTitle')}</span>
                  {activeSignerId ? (
                    <span className="text-xs text-muted-foreground">
                      {t('fields.assignTo', { name: signers.find((s) => s.id === activeSignerId)?.name ?? '' })}
                    </span>
                  ) : (
                    <span className="text-xs text-warning">{t('fields.addSignerFirst')}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5" data-testid="field-palette">
                  {SIGN_FIELD_TYPES.map((fieldType) => (
                    <Button
                      key={fieldType}
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={!activeSignerId}
                      onClick={() => handleAddField(fieldType)}
                      data-testid={`palette-add-${fieldType}`}
                    >
                      + {t(`fields.types.${fieldType}`)}
                    </Button>
                  ))}
                </div>
                {effectivePageCount >= 2 ? (
                  <div
                    className="flex flex-wrap items-center gap-2 border-t border-border pt-2"
                    data-testid="palette-initial-all-row"
                  >
                    <NativeSelect
                      aria-label={t('fields.initialAllPositionLabel')}
                      className="min-h-11 w-auto text-xs"
                      value={initialAllPosition}
                      onChange={(e) => setInitialAllPosition(e.target.value as InitialAllPosition)}
                      data-testid="palette-initial-all-position"
                    >
                      <NativeSelectOption value="bottom-right">{t('fields.initialAllBottomRight')}</NativeSelectOption>
                      <NativeSelectOption value="bottom-left">{t('fields.initialAllBottomLeft')}</NativeSelectOption>
                    </NativeSelect>
                    <Button
                      type="button"
                      variant="secondary"
                      className="min-h-11"
                      disabled={!activeSignerId}
                      onClick={handleInitialAllPrecedingPages}
                      data-testid="palette-initial-all-pages"
                    >
                      {t('fields.initialAllPages')}
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          {!isViewingSealedUnified && documents.length > 1 ? (
            <SignPacketTabs
              items={documents.map((doc) => ({
                key: doc.id ?? 'doc-1',
                documentId: doc.id,
                docIndex: doc.docIndex,
                title: doc.title,
                pageCount: doc.pageCount,
                inspectStatus: doc.inspectStatus,
                badgeCount: draftFields.filter((f) => (f.documentId ?? doc1Id ?? null) === (doc.id ?? null)).length,
              }))}
              activeKey={resolvedActiveDocKey}
              onSelect={(key) => {
                const match = documents.find((d) => (d.id ?? 'doc-1') === key);
                if (match) handleSelectDocument(match.id, match.docIndex, 1);
              }}
            />
          ) : null}

          <PdfCanvasViewer
            pdfBytes={pdfQuery.data ?? null}
            pageNumber={pageNumber}
            pageCount={effectivePageCount}
            scale={scale}
            onPageChange={setPageNumber}
            onScaleChange={setScale}
            onPageCountDetected={setDetectedPages}
            renderOverlay={(page) => (
              <FieldOverlayLayer
                pageNumber={page}
                fields={viewerFields}
                proposals={canEditDraft && !isViewingSealedUnified && (activeDoc?.docIndex ?? 1) === 1 ? pendingProposals : []}
                signers={signers}
                selectedFieldId={selectedFieldId}
                editable={canEditDraft && !isViewingSealedUnified}
                onSelectField={setSelectedFieldId}
                onUpdateFieldBox={handleUpdateFieldBox}
                onDeleteField={handleDeleteField}
                onApplyProposal={handleApplyProposal}
                onDismissProposal={(pid) => setDismissedProposalIds((prev) => [...prev, pid])}
              />
            )}
          />
        </div>

        <div className="space-y-4">
          <SignDepositConfigCard
            slug={slug}
            envelopeId={envelope.id}
            envelopeStatus={envelope.status}
            sourceKind={envelope.sourceKind}
            canEditDraft={canEditDraft}
            deposit={detailQuery.data?.deposit ?? null}
            onDownloadFile={(fileId, filename) => handleDownload(fileId, filename)}
          />

          {envelope.status === 'completed' ? (
            <EnvelopeObligationsCard
              envelopeId={envelope.id}
              sourceFileId={envelope.sourceFileId}
              pdfBytes={
                envelope.sealedFileId && envelope.sealedFileId !== envelope.sourceFileId
                  ? null
                  : (pdfQuery.data ?? null)
              }
              onJumpToPage={(targetPage) => {
              const doc1Pages = Math.max(1, documents[0]?.pageCount ?? envelope.pageCount ?? effectivePageCount);
              setActiveDocKey(doc1Id ?? 'doc-1');
              setPageNumber(Math.min(doc1Pages, Math.max(1, targetPage)));
            }}
            />
          ) : null}

          {!isDraft ? (
            <EnvelopeKycCard
              envelopeId={envelope.id}
              hasUploadedAttachments={Boolean(detailQuery.data?.fields.some((fItem) => Boolean(fItem.attachmentFileId)))}
              onDownloadAttachment={(fileId, filename) => handleDownload(fileId, filename)}
            />
          ) : null}

          <EnvelopePlaybookCard
            envelopeId={envelope.id}
            sourceFileId={envelope.sourceFileId}
            inspectStatus={envelope.inspectStatus}
            pdfBytes={
              envelope.sealedFileId && envelope.sealedFileId !== envelope.sourceFileId
                ? null
                : (pdfQuery.data ?? null)
            }
            onJumpToPage={(targetPage) => {
              const doc1Pages = Math.max(1, documents[0]?.pageCount ?? envelope.pageCount ?? effectivePageCount);
              setActiveDocKey(doc1Id ?? 'doc-1');
              setPageNumber(Math.min(doc1Pages, Math.max(1, targetPage)));
            }}
          />

          {canEditSharedSummary || Boolean(envelope.sharedSummary) || Boolean(envelope.shareSummaryWithSigners) ? (
            <SenderSharedSummaryEditor
              recordKey={`env-${envelope.id}`}
              initialShare={Boolean(envelope.shareSummaryWithSigners)}
              initialSummary={envelope.sharedSummary ?? null}
              pageCount={envelope.pageCount ?? detectedPages}
              aiAnalysis={effectiveAi}
              editable={canEditSharedSummary}
              saving={sharedSummaryMutation.isPending}
              onSave={(payload) => sharedSummaryMutation.mutateAsync(payload)}
            />
          ) : null}

          {canEditDraft && selectedField ? (
            <Card data-testid="field-inspector-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t('fields.selectedLabel')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                <div className="space-y-1">
                  <Label htmlFor="field-assignee-select" className="text-xs">
                    {t('fields.assignedSignerSelect')}
                  </Label>
                  <NativeSelect
                    id="field-assignee-select"
                    value={selectedField.signerId}
                    className="w-full"
                    onChange={(e) => {
                      const nextSignerId = e.target.value;
                      updateDraftFields((prev) =>
                        prev.map((item) => (item.localId === selectedField.localId ? { ...item, signerId: nextSignerId } : item)),
                      );
                    }}
                  >
                    {signers
                      .filter((s) => s.signerRole !== 'cc' || s.id === selectedField.signerId)
                      .map((s) => (
                        <NativeSelectOption key={s.id} value={s.id}>
                          {s.name}
                        </NativeSelectOption>
                      ))}
                  </NativeSelect>
                </div>

                <div className="space-y-1">
                  <Label htmlFor="field-label-input" className="text-xs">
                    {t('fields.fieldLabelInput')}
                  </Label>
                  <Input
                    id="field-label-input"
                    value={selectedField.label ?? ''}
                    onChange={(e) => {
                      const nextLabel = e.target.value;
                      updateDraftFields((prev) =>
                        prev.map((item) =>
                          item.localId === selectedField.localId ? { ...item, label: nextLabel || null } : item,
                        ),
                      );
                    }}
                  />
                </div>

                <label htmlFor="field-required-checkbox" className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    id="field-required-checkbox"
                    checked={selectedField.required}
                    onCheckedChange={(checked) => {
                      updateDraftFields((prev) =>
                        prev.map((item) =>
                          item.localId === selectedField.localId ? { ...item, required: Boolean(checked) } : item,
                        ),
                      );
                    }}
                  />
                  <span>{t('fields.requiredToggle')}</span>
                </label>

                <FieldOptionsAndAttachmentEditor
                  field={selectedField}
                  onChangeOptions={(nextOptions) => {
                    updateDraftFields((prev) =>
                      prev.map((item) =>
                        item.localId === selectedField.localId ? { ...item, options: nextOptions } : item,
                      ),
                    );
                  }}
                  onChangeLabel={(nextLabel) => {
                    updateDraftFields((prev) =>
                      prev.map((item) =>
                        item.localId === selectedField.localId ? { ...item, label: nextLabel } : item,
                      ),
                    );
                  }}
                />

                <p className="text-muted-foreground">{t('fields.nudgeHint')}</p>
                <div className="grid grid-cols-2 gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleUpdateFieldBox(selectedField.localId, nudgeFieldBox(selectedField, -0.02, 0))}
                  >
                    {t('fields.moveLeft')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleUpdateFieldBox(selectedField.localId, nudgeFieldBox(selectedField, 0.02, 0))}
                  >
                    {t('fields.moveRight')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleUpdateFieldBox(selectedField.localId, nudgeFieldBox(selectedField, 0, -0.02))}
                  >
                    {t('fields.moveUp')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleUpdateFieldBox(selectedField.localId, nudgeFieldBox(selectedField, 0, 0.02))}
                  >
                    {t('fields.moveDown')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleUpdateFieldBox(selectedField.localId, resizeFieldBox(selectedField, 0.02, 0))}
                  >
                    {t('fields.wider')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleUpdateFieldBox(selectedField.localId, resizeFieldBox(selectedField, -0.02, 0))}
                  >
                    {t('fields.narrower')}
                  </Button>
                </div>

                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="w-full"
                  onClick={() => handleDeleteField(selectedField.localId)}
                >
                  {t('fields.deleteField')}
                </Button>
              </CardContent>
            </Card>
          ) : null}

          {!isDraft ? (
            <Card data-testid="sign-evidence-card">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">{t('evidence.title')}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-xs">
                {verifyQuery.data ? (
                  <Badge variant={verifyQuery.data.valid ? 'success' : 'destructive'}>
                    {verifyQuery.data.valid
                      ? t('evidence.chainValid', { count: String(verifyQuery.data.eventChain.count) })
                      : t('evidence.chainInvalid')}
                  </Badge>
                ) : null}

                {envelope.certificateCode ? (
                  <div className="space-y-1">
                    <span className="block text-muted-foreground">{t('evidence.certificateCode')}</span>
                    <div className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1 font-mono">
                      <span>{envelope.certificateCode}</span>
                      <Button type="button" size="sm" variant="ghost" onClick={() => void copyDigest(envelope.certificateCode!)}>
                        {t('evidence.copyDigest')}
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="space-y-1">
                  <span className="block text-muted-foreground">{t('evidence.sourceSha256')}</span>
                  <div className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1 font-mono">
                    <span className="truncate">{envelope.sourceSha256}</span>
                    <Button type="button" size="sm" variant="ghost" onClick={() => void copyDigest(envelope.sourceSha256)}>
                      {t('evidence.copyDigest')}
                    </Button>
                  </div>
                </div>

                {envelope.sealedSha256 ? (
                  <div className="space-y-1">
                    <span className="block text-muted-foreground">{t('evidence.sealedSha256')}</span>
                    <div className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1 font-mono">
                      <span className="truncate">{envelope.sealedSha256}</span>
                      <Button type="button" size="sm" variant="ghost" onClick={() => void copyDigest(envelope.sealedSha256!)}>
                        {t('evidence.copyDigest')}
                      </Button>
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-col gap-1.5 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleDownload(envelope.sourceFileId, `${envelope.id}-source.pdf`)}
                  >
                    {t('actions.downloadOriginal')}
                  </Button>
                  {envelope.sealedFileId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void handleDownload(envelope.sealedFileId, `${envelope.certificateCode ?? envelope.id}-sealed.pdf`)}
                    >
                      {t('actions.downloadSealed')}
                    </Button>
                  ) : null}
                  {envelope.certificateFileId ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void handleDownload(envelope.certificateFileId, `${envelope.certificateCode ?? envelope.id}-certificate.json`)
                      }
                    >
                      {t('actions.downloadCertificate')}
                    </Button>
                  ) : null}
                </div>

                {isCompletedAndSealed && (activeCaConnection || latestCaRequest) ? (
                  <div className="space-y-2 border-t pt-2.5" data-testid="sign-ca-pades-section">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-foreground">{t('ca.envelopeSectionTitle')}</span>
                      {latestCaRequest ? (
                        <Badge
                          variant={
                            latestCaRequest.status === 'signed' && latestCaRequest.padesFileId
                              ? 'success'
                              : latestCaRequest.status === 'pending' ||
                                  (latestCaRequest.status === 'signed' && !latestCaRequest.padesFileId)
                                ? 'brand'
                                : 'destructive'
                          }
                          data-testid="sign-ca-request-status"
                        >
                          {t(
                            `ca.requestStatus.${
                              latestCaRequest.status === 'signed' && !latestCaRequest.padesFileId
                                ? 'pending'
                                : latestCaRequest.status
                            }`,
                          )}
                        </Badge>
                      ) : activeCaConnection ? (
                        <span className="text-[11px] text-muted-foreground">
                          {t('ca.envelopeActiveProvider', {
                            provider: t(`ca.providers.${activeCaConnection.provider}`),
                          })}
                        </span>
                      ) : null}
                    </div>

                    {latestCaRequest?.challengeCode && latestCaRequest.status === 'pending' ? (
                      <p className="font-mono text-[11px] text-foreground">
                        {t('ca.challengeCodeLabel', { challenge: latestCaRequest.challengeCode })}
                      </p>
                    ) : null}

                    {latestCaRequest?.padesSha256 ? (
                      <div className="space-y-1">
                        <span className="block text-muted-foreground">{t('ca.padesSha256Label')}</span>
                        <div className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1 font-mono">
                          <span className="truncate">{latestCaRequest.padesSha256}</span>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void copyDigest(latestCaRequest.padesSha256!)}
                          >
                            {t('evidence.copyDigest')}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {latestCaRequest?.padesFileId ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={() =>
                          void handleDownload(
                            latestCaRequest.padesFileId,
                            `${envelope.certificateCode ?? envelope.id}-pades.pdf`,
                          )
                        }
                        data-testid="sign-download-pades-btn"
                      >
                        {t('ca.downloadPadesButton')}
                      </Button>
                    ) : null}

                    {canInitiateCa &&
                    activeCaConnection &&
                    latestCaRequest?.status !== 'pending' &&
                    latestCaRequest?.status !== 'signed' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full"
                        loading={initiateCaMutation.isPending}
                        onClick={() => initiateCaMutation.mutate(activeCaConnection.id)}
                        data-testid="sign-apply-pades-btn"
                      >
                        {t('ca.applyPadesButton', {
                          provider: t(`ca.providers.${activeCaConnection.provider}`),
                        })}
                      </Button>
                    ) : null}
                  </div>
                ) : null}

                {detailQuery.data?.fields.some((fItem) => Boolean(fItem.attachmentFileId)) ? (
                  <div className="space-y-1.5 border-t pt-2" data-testid="sign-uploaded-attachments-list">
                    <p className="font-medium text-foreground">{t('evidence.attachmentsHeading')}</p>
                    <ul className="space-y-1.5">
                      {detailQuery.data.fields
                        .filter((fItem) => Boolean(fItem.attachmentFileId))
                        .map((attField) => {
                          const signerName = signers.find((s) => s.id === attField.signerId)?.name ?? '';
                          const fname = attField.attachmentFilename ?? 'attachment.pdf';
                          return (
                            <li key={attField.id} className="space-y-1 rounded border bg-card px-2 py-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate font-medium text-foreground">
                                  {attField.label || t('fields.types.attachment')}
                                  {signerName ? ` (${signerName})` : ''}
                                </span>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-7 shrink-0 px-2 text-xs max-md:min-h-11"
                                  onClick={() => void handleDownload(attField.attachmentFileId!, fname)}
                                  data-testid={`sign-download-attachment-${attField.id}`}
                                >
                                  {t('evidence.downloadAttachment')}
                                </Button>
                              </div>
                              <div className="truncate text-[11px] text-muted-foreground">{fname}</div>
                              {attField.attachmentSha256 ? (
                                <div className="flex items-center justify-between gap-2 rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px]">
                                  <span className="truncate">{attField.attachmentSha256}</span>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 shrink-0 px-1.5 text-[11px] max-md:min-h-11"
                                    onClick={() => void copyDigest(attField.attachmentSha256!)}
                                  >
                                    {t('evidence.copyDigest')}
                                  </Button>
                                </div>
                              ) : null}
                            </li>
                          );
                        })}
                    </ul>
                  </div>
                ) : null}

                {eventsQuery.data?.events.length ? (
                  <div className="space-y-1.5 border-t pt-2">
                    <p className="font-medium text-foreground">{t('evidence.eventsHeading')}</p>
                    <ul className="max-h-60 space-y-1.5 overflow-y-auto">
                      {eventsQuery.data.events.map((ev) => (
                        <li key={ev.id} className="rounded border bg-card px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="font-mono text-[11px] font-medium">{ev.eventType}</span>
                              {ev.hostUserId ? (
                                <Badge variant="outline" className="text-[10px]">
                                  {t('evidence.inPersonHostBadge')}
                                </Badge>
                              ) : null}
                            </div>
                            <span className="text-[11px] text-muted-foreground">#{ev.seq}</span>
                          </div>
                          <div className="mt-0.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                            <span className="truncate">{ev.actorLabel ?? ev.actorType}</span>
                            <span>{f.dateTime(ev.occurredAt)}</span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        title={t('sendConfirm.title')}
        description={t('sendConfirm.description', {
          title: titleInput.trim() || envelope.title,
          signers: String(signers.length),
          routing: t(`routing.${envelope.routingMode}`),
        })}
        confirm={t('sendConfirm.confirm')}
        onConfirm={() => {
          if (!sendMutation.isPending) void sendMutation.mutate();
        }}
      />

      <Dialog open={voidDialogOpen} onOpenChange={setVoidDialogOpen}>
        <DialogContent className="sm:max-w-md" variant="destructive" closeLabel={common('close')}>
          <DialogHeader>
            <DialogTitle>{t('voidDialog.title')}</DialogTitle>
            <DialogDescription>{t('voidDialog.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="void-reason-input">{t('voidDialog.reasonLabel')}</Label>
            <Input id="void-reason-input" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setVoidDialogOpen(false)}>
              {common('cancel')}
            </Button>
            <Button type="button" variant="destructive" loading={voidMutation.isPending} onClick={() => voidMutation.mutate(voidReason)}>
              {t('voidDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={correctTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCorrectTarget(null);
            setCorrectFormError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md" closeLabel={common('close')} data-testid="sign-correct-recipient-dialog">
          <DialogHeader>
            <DialogTitle>{t('correctDialog.title')}</DialogTitle>
            <DialogDescription>{t('correctDialog.description')}</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCorrectRecipientSubmit} className="space-y-3">
            {correctFormError ? <ErrorText>{correctFormError}</ErrorText> : null}
            <div className="space-y-1.5">
              <Label htmlFor="correct-signer-name">{t('signer.nameLabel')}</Label>
              <Input
                id="correct-signer-name"
                className="min-h-11"
                value={correctName}
                onChange={(e) => setCorrectName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="correct-signer-email">{t('signer.emailLabel')}</Label>
              <Input
                id="correct-signer-email"
                type="email"
                className="min-h-11"
                value={correctEmail}
                onChange={(e) => setCorrectEmail(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="correct-signer-phone">{t('signer.phoneLabel')}</Label>
                <Input
                  id="correct-signer-phone"
                  className="min-h-11"
                  value={correctPhone}
                  onChange={(e) => setCorrectPhone(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="correct-signer-delivery">{t('signer.deliveryLabel')}</Label>
                <NativeSelect
                  id="correct-signer-delivery"
                  value={correctDeliveryMode}
                  className="min-h-11 w-full"
                  onChange={(e) => setCorrectDeliveryMode(e.target.value as SignDeliveryMode)}
                >
                  {SIGN_DELIVERY_MODES.map((mode) => (
                    <NativeSelectOption key={mode} value={mode}>
                      {t(`signer.deliveries.${mode}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
            {correctTarget?.signerRole !== 'cc' ? (
              <label
                htmlFor="correct-signer-otp"
                className="flex min-h-11 cursor-pointer items-center gap-2.5 text-xs text-foreground"
              >
                <Checkbox
                  id="correct-signer-otp"
                  checked={correctRequireOtp}
                  onCheckedChange={(checked) => setCorrectRequireOtp(Boolean(checked))}
                />
                <span>{t('signer.otpLabel')}</span>
              </label>
            ) : null}
            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  setCorrectTarget(null);
                  setCorrectFormError(null);
                }}
              >
                {common('cancel')}
              </Button>
              <Button type="submit" className="min-h-11" loading={correctRecipientMutation.isPending}>
                {t('correctDialog.confirm')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={inPersonSignerId !== null}
        onOpenChange={(open) => {
          if (!open) {
            selectInPersonDialogSigner(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg" closeLabel={common('close')} data-testid="in-person-handoff-dialog">
          <DialogHeader>
            <DialogTitle>{t('inPersonDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('inPersonDialog.description', {
                signer:
                  inPersonSession?.signerName ||
                  signers.find((s) => s.id === inPersonSignerId)?.name ||
                  '',
              })}
            </DialogDescription>
          </DialogHeader>

          <Alert>
            <AlertDescription>{t('inPersonDialog.securityNotice')}</AlertDescription>
          </Alert>

          {inPersonSession ? (
            <InPersonSessionBody
              session={inPersonSession}
              qrOpen={inPersonQrOpen}
              onQrOpenChange={setInPersonQrOpen}
              qrTriggerRef={inPersonQrTriggerRef}
            />
          ) : (
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => selectInPersonDialogSigner(null)}
              >
                {common('cancel')}
              </Button>
              <Button
                type="button"
                className="min-h-11"
                loading={startInPersonMutation.isPending}
                onClick={() => {
                  if (inPersonSignerId) {
                    startInPersonMutation.mutate({
                      signerId: inPersonSignerId,
                      dialogGen: inPersonDialogGenRef.current,
                    });
                  }
                }}
                data-testid="in-person-mint-btn"
              >
                {t('inPersonDialog.mintButton')}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <SignQrModal
        open={qrModalTarget !== null}
        onOpenChange={(open) => {
          if (!open) setQrModalTarget(null);
        }}
        title={t('qrHandoff.signerModalTitle')}
        description={t('qrHandoff.signerModalDescription')}
        url={qrModalTarget?.url ?? ''}
        signerName={qrModalTarget?.signerName}
        triggerRef={qrModalTriggerRef}
        testId="zalo-link-qr-modal"
      />
    </div>
  );
}
