// SPDX-License-Identifier: AGPL-3.0-only
// eSign envelopes list route (/o/$slug/sign/envelopes): upload PDF, filter status tabs, copy Zalo link, remind, download (#3325).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { COWORKER_ROSTER } from '@ludy/kernel-contract';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { cn } from '@ludy/ui/lib/utils';
import { ContractDrafterDialog } from '../components/sign/contract-drafter-dialog.tsx';
import { ContractVaultBar } from '../components/sign/contract-vault-bar.tsx';
import {
  DocxConversionNotice,
  DocxWarningsAlert,
  clearCreatedDocxWarnings,
  inspectSelectedSignUploadFile,
  saveCreatedDocxWarnings,
  type DocxConversionStatus,
} from '../components/sign/docx-conversion-notice.tsx';
import { sanitizeDocxWarnings } from '../lib/sign-docx-notices.ts';
import { VersionDiffDialog } from '../components/sign/version-diff-dialog.tsx';
import { FormDialog } from '../components/form-dialog.tsx';
import { CoworkerAttribution, ProposalSurface } from '../components/proposal-surface.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { useListPeekNav } from '../lib/list-peek-nav.ts';
import {
  SIGN_UPLOAD_ACCEPT,
  canManageEnvelopeLinks,
  convertSignDocx,
  downloadSignFile,
  isSignDocxFile,
  signApi,
  uploadSignPdf,
  type SignAiAnalysis,
  type SignDocxConvertCompletedResult,
  type SignDocxToPdfWarning,
  type SignEnvelopeSummary,
  type SignObligationRenewalListItem,
} from '../lib/sign-api.ts';
import type { SignEnvelopeStatus } from '../lib/sign-fields.ts';
import { buildInPersonSigningUrl, buildSigningUrl, copyTextToClipboard } from '../lib/sign-hash.ts';
import { toast } from '../lib/toast.ts';
import { DataTable, Empty, ErrorText, PageHeader, PeekSheet, TableSkeleton } from '../components/ui.tsx';

export type EnvelopeFilterTab = 'all' | 'actionNeeded' | 'waiting' | 'completed' | 'renewals' | 'closed';

const ENVELOPE_BADGE_VARIANT = {
  draft: 'secondary',
  sent: 'warning',
  in_progress: 'warning',
  completed: 'success',
  declined: 'destructive',
  voided: 'destructive',
  expired: 'outline',
} as const;

const TAB_STATUS_FILTERS: Record<EnvelopeFilterTab, readonly SignEnvelopeStatus[] | null> = {
  all: null,
  actionNeeded: ['draft', 'sent', 'in_progress'],
  waiting: ['sent', 'in_progress'],
  completed: ['completed'],
  renewals: ['completed'],
  closed: ['declined', 'voided', 'expired'],
};

export async function fetchEnvelopesForTab(tab: EnvelopeFilterTab): Promise<{ items: SignEnvelopeSummary[] }> {
  const statuses = TAB_STATUS_FILTERS[tab];
  if (!statuses) {
    return signApi.listEnvelopes({ limit: 100 });
  }
  const responses = await Promise.all(statuses.map((status) => signApi.listEnvelopes({ status, limit: 100 })));
  const byId = new Map<string, SignEnvelopeSummary>();
  for (const res of responses) {
    for (const item of res.items) {
      byId.set(item.id, item);
    }
  }
  const merged = [...byId.values()];
  merged.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0,
  );
  return { items: merged };
}

export function filterEnvelopesByTab(items: readonly SignEnvelopeSummary[], tab: EnvelopeFilterTab): SignEnvelopeSummary[] {
  switch (tab) {
    case 'all':
      return [...items];
    case 'actionNeeded':
      return items.filter((item) => item.status === 'draft' || item.signerSummary.waitingForMe);
    case 'waiting':
      return items.filter((item) => item.status === 'sent' || item.status === 'in_progress');
    case 'completed':
    case 'renewals':
      return items.filter((item) => item.status === 'completed');
    case 'closed':
      return items.filter((item) => item.status === 'voided' || item.status === 'declined' || item.status === 'expired');
  }
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function handleEnvelopeCreatedWithWarnings(deps: {
  envelopeId: string;
  warnings: readonly SignDocxToPdfWarning[];
  slug: string;
  orgId?: string | null;
  userId?: string | null;
  resolveUserScope?: () => Promise<{ orgId?: string | null; userId?: string | null } | null>;
  setCreateOpen: (open: boolean) => void;
  setCreatedDocxNotice: (notice: { envelopeId: string; warnings: readonly SignDocxToPdfWarning[] } | null) => void;
  invalidateEnvelopes: () => Promise<unknown>;
  navigateToEnvelope: (slug: string, envelopeId: string) => Promise<unknown>;
}): Promise<void> {
  deps.setCreateOpen(false);
  const cleanWarnings = sanitizeDocxWarnings(deps.warnings);
  let resolvedOrgId = deps.orgId ?? null;
  let resolvedUserId = deps.userId ?? null;
  if (cleanWarnings.length > 0 && (!resolvedUserId || !resolvedOrgId) && deps.resolveUserScope) {
    try {
      const fetched = await deps.resolveUserScope();
      if (fetched) {
        resolvedOrgId = resolvedOrgId ?? fetched.orgId ?? null;
        resolvedUserId = resolvedUserId ?? fetched.userId ?? null;
      }
    } catch {
      // Non-fatal: fail closed by skipping cross-session storage if identity cannot be resolved.
    }
  }
  const scope = { org: resolvedOrgId ?? (deps.slug || null), userId: resolvedUserId };
  if (cleanWarnings.length > 0) {
    saveCreatedDocxWarnings(deps.envelopeId, cleanWarnings, scope);
    deps.setCreatedDocxNotice({ envelopeId: deps.envelopeId, warnings: cleanWarnings });
  } else {
    clearCreatedDocxWarnings(deps.envelopeId, scope);
    deps.setCreatedDocxNotice(null);
  }
  await deps.invalidateEnvelopes();
  if (deps.slug) {
    await deps.navigateToEnvelope(deps.slug, deps.envelopeId);
  }
}

export function CreateEnvelopeDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (envelopeId: string, warnings?: readonly SignDocxToPdfWarning[]) => Promise<void> | void;
}) {
  const t = useTranslations('sign');
  const [title, setTitle] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [inspectingFile, setInspectingFile] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [docxStatus, setDocxStatus] = useState<DocxConversionStatus>('idle');
  const [docxResult, setDocxResult] = useState<SignDocxConvertCompletedResult | null>(null);
  const pickTokenRef = useRef(0);

  useEffect(() => {
    return () => {
      pickTokenRef.current += 1;
    };
  }, []);

  const createMutation = useMutation({
    mutationFn: async (input: { title: string; file: File; converted: SignDocxConvertCompletedResult | null }) => {
      if (input.converted) {
        return {
          created: await signApi.createEnvelope({
            title: input.title,
            routingMode: 'parallel',
            sourceFileId: input.converted.fileId,
            sourceDocxSha256: input.converted.sourceDocxSha256,
          }),
          warnings: input.converted.warnings,
        };
      }
      if (isSignDocxFile(input.file)) {
        throw new Error(t('pdfRequired'));
      }
      const uploaded = await uploadSignPdf(input.file);
      return {
        created: await signApi.createEnvelope({
          title: input.title,
          routingMode: 'parallel',
          sourceFileId: uploaded.fileId,
        }),
        warnings: [],
      };
    },
    onSuccess: async ({ created, warnings }) => {
      toast(warnings.length > 0 ? t('docxWarningBanner') : t('createdToast'));
      await onCreated(created.envelopeId, warnings);
    },
    onError: (error) => {
      setFormError(errorMessage(error));
    },
  });

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const token = ++pickTokenRef.current;
    setSelectedFile(null);
    setFormError(null);
    setDocxStatus('idle');
    setDocxResult(null);
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setInspectingFile(false);
      return;
    }
    setInspectingFile(true);
    const checked = await inspectSelectedSignUploadFile(file);
    if (pickTokenRef.current !== token) return;
    setInspectingFile(false);
    if (!checked.ok) {
      setFormError(t(checked.errorKey));
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    setTitle((prev) => (prev.trim() ? prev : checked.fallbackTitle));
    if (checked.kind === 'docx') {
      setDocxStatus('converting');
      try {
        const converted = await convertSignDocx(file);
        if (pickTokenRef.current !== token) return;
        setDocxResult(converted);
        setDocxStatus('ready');
      } catch (error) {
        if (pickTokenRef.current !== token) return;
        setSelectedFile(null);
        setDocxStatus('error');
        setFormError(errorMessage(error));
      }
    }
  };

  const handleCreateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inspectingFile || createMutation.isPending || docxStatus === 'converting') return;
    setFormError(null);
    if (!selectedFile) {
      setFormError(t('pdfRequired'));
      return;
    }
    if (docxStatus === 'error' || (isSignDocxFile(selectedFile) && !docxResult)) {
      setSelectedFile(null);
      setDocxStatus('error');
      setFormError(t('pdfRequired'));
      return;
    }
    const cleanTitle = title.trim() || selectedFile.name.replace(/\.(pdf|docx)$/i, '') || selectedFile.name;
    createMutation.mutate({ title: cleanTitle, file: selectedFile, converted: docxResult });
  };

  return (
    <FormDialog
      testId="sign-create-dialog"
      title={t('createTitle')}
      description={t('createHint')}
      busy={createMutation.isPending}
      submitDisabled={inspectingFile || docxStatus === 'converting' || docxStatus === 'error'}
      dirty={title.trim() !== '' || selectedFile !== null}
      submitLabel={t('createSubmit')}
      submitTestId="sign-create-submit-btn"
      onClose={onClose}
      onSubmit={handleCreateSubmit}
    >
      {formError ? <ErrorText>{formError}</ErrorText> : null}
      <div className="space-y-1.5">
        <Label htmlFor="sign-new-pdf">{t('pdfLabel')}</Label>
        <Input
          id="sign-new-pdf"
          type="file"
          accept={SIGN_UPLOAD_ACCEPT}
          autoFocus
          onChange={(e) => void handleFileChange(e)}
          data-testid="sign-upload-pdf-input"
        />
        <DocxConversionNotice status={docxStatus} result={docxResult} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="sign-new-title">{t('titleLabel')}</Label>
        <Input
          id="sign-new-title"
          placeholder={t('titlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
      </div>
    </FormDialog>
  );
}

const SIGNER_ROLE_KEYS = {
  signer: 'signer.roles.signer',
  approver: 'signer.roles.approver',
  cc: 'signer.roles.cc',
} as const;

const SIGNER_STATUS_KEYS = {
  waiting: 'signer.statuses.waiting',
  pending: 'signer.statuses.pending',
  viewed: 'signer.statuses.viewed',
  signed: 'signer.statuses.signed',
  declined: 'signer.statuses.declined',
  voided: 'signer.statuses.voided',
  expired: 'signer.statuses.expired',
} as const;

type EnvelopeDetailPayload = Awaited<ReturnType<typeof signApi.getEnvelope>>;
type EnvelopeObligationPayload = Awaited<ReturnType<typeof signApi.getObligation>>;

function SignEnvelopePeekContent({
  item,
  detail,
  detailLoading,
  detailError,
  renewalEntry,
  obligationData,
  aiAnalysis,
  canStartInPerson,
  inPersonPendingSignerId,
  onStartInPerson,
}: {
  item: SignEnvelopeSummary;
  detail: EnvelopeDetailPayload | null | undefined;
  detailLoading: boolean;
  detailError: unknown;
  renewalEntry: SignObligationRenewalListItem | null;
  obligationData: EnvelopeObligationPayload | null | undefined;
  aiAnalysis: SignAiAnalysis | null | undefined;
  canStartInPerson: boolean;
  inPersonPendingSignerId: string | null;
  onStartInPerson: (signerId: string) => void;
}) {
  const t = useTranslations('sign');
  const f = useFormat();
  const signers = detail?.signers ?? [];
  const obligation = renewalEntry?.obligation ?? obligationData?.obligation ?? null;
  const pendingObligationCount =
    renewalEntry?.pendingObligationCount ??
    (obligation ? obligation.obligations.filter((entry) => entry.status === 'pending').length : 0);
  const nextObligationDueDate =
    renewalEntry?.nextObligationDueDate ??
    obligation?.obligations
      .filter((entry) => entry.status === 'pending' && Boolean(entry.dueDate))
      .map((entry) => entry.dueDate as string)
      .sort()[0] ??
    null;

  const hasAiSummary = Boolean(
    aiAnalysis &&
      (aiAnalysis.status === 'completed' ||
        aiAnalysis.summaryText ||
        aiAnalysis.riskClauses.length > 0 ||
        aiAnalysis.proposedFields.length > 0),
  );
  const isActive = item.status === 'sent' || item.status === 'in_progress';

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-muted-foreground">{t('peek.metaSection')}</h3>
        <dl className="grid gap-2 rounded-lg border border-border bg-card p-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-subtle-foreground">{t('routing.label')}</dt>
            <dd className="font-medium text-foreground">{t(`routing.${item.routingMode}`)}</dd>
          </div>
          <div>
            <dt className="text-subtle-foreground">{t('columns.createdAt')}</dt>
            <dd className="tabular-nums text-muted-foreground">{f.dateTime(item.createdAt)}</dd>
          </div>
          {item.expiresAt ? (
            <div>
              <dt className="text-subtle-foreground">{t('peek.expiresAt')}</dt>
              <dd className="tabular-nums text-muted-foreground">{f.dateTime(item.expiresAt)}</dd>
            </div>
          ) : null}
          {item.certificateCode ? (
            <div>
              <dt className="text-subtle-foreground">{t('peek.certificateCode')}</dt>
              <dd className="font-mono text-foreground">{item.certificateCode}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="space-y-2" data-testid="sign-peek-signers">
        <h3 className="text-xs font-semibold text-muted-foreground">
          {t('peek.signersSection', { count: String(signers.length || item.signerSummary.total) })}
        </h3>
        {detailLoading ? (
          <p className="text-xs text-subtle-foreground">{t('peek.signersLoading')}</p>
        ) : detailError ? (
          <ErrorText>{errorMessage(detailError)}</ErrorText>
        ) : signers.length === 0 ? (
          <p className="text-xs text-subtle-foreground">{t('peek.noSigners')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-card">
            {signers.map((signer) => {
              const dueHere = signer.signerRole !== 'cc' && (signer.status === 'pending' || signer.status === 'viewed');
              return (
                <li key={signer.id} className="flex flex-wrap items-center justify-between gap-2 p-2.5 text-xs">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium text-foreground">{signer.name}</span>
                      <Badge variant="outline">
                        {t(SIGNER_ROLE_KEYS[signer.signerRole as keyof typeof SIGNER_ROLE_KEYS] ?? 'signer.roles.signer')}
                      </Badge>
                      <Badge
                        variant={
                          signer.status === 'signed'
                            ? 'success'
                            : signer.status === 'declined' || signer.status === 'voided' || signer.status === 'expired'
                              ? 'destructive'
                              : signer.status === 'waiting'
                                ? 'outline'
                                : 'secondary'
                        }
                      >
                        {t(SIGNER_STATUS_KEYS[signer.status as keyof typeof SIGNER_STATUS_KEYS] ?? 'signer.statuses.pending')}
                      </Badge>
                    </div>
                    {signer.email ? <p className="truncate font-mono text-subtle-foreground">{signer.email}</p> : null}
                  </div>
                  {isActive && canStartInPerson && dueHere ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      loading={inPersonPendingSignerId === signer.id}
                      disabled={inPersonPendingSignerId !== null}
                      onClick={() => onStartInPerson(signer.id)}
                      data-testid="sign-peek-signer-in-person"
                    >
                      {t('actions.startInPerson')}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {obligation ? (
        <section className="space-y-2" data-testid="sign-peek-obligations">
          <h3 className="text-xs font-semibold text-muted-foreground">{t('peek.obligationsSection')}</h3>
          <dl className="grid gap-2 rounded-lg border border-border bg-card p-3 text-xs sm:grid-cols-2">
            {obligation.counterpartyName ? (
              <div>
                <dt className="text-subtle-foreground">{t('peek.counterparty')}</dt>
                <dd className="font-medium text-foreground">{obligation.counterpartyName}</dd>
              </div>
            ) : null}
            {obligation.contractValue !== null ? (
              <div>
                <dt className="text-subtle-foreground">{t('peek.contractValue')}</dt>
                <dd className="font-mono tabular-nums text-foreground">
                  {f.money(obligation.contractValue, obligation.currency)}
                </dd>
              </div>
            ) : null}
            {obligation.expiryDate ? (
              <div>
                <dt className="text-subtle-foreground">{t('peek.expiryDate')}</dt>
                <dd className="tabular-nums text-muted-foreground">{f.date(obligation.expiryDate)}</dd>
              </div>
            ) : null}
            {nextObligationDueDate || pendingObligationCount > 0 ? (
              <div>
                <dt className="text-subtle-foreground">{t('peek.nextObligation')}</dt>
                <dd className="flex flex-wrap items-center gap-1.5 tabular-nums text-muted-foreground">
                  {nextObligationDueDate ? <span>{f.date(nextObligationDueDate)}</span> : null}
                  {pendingObligationCount > 0 ? (
                    <Badge variant="secondary">{t('peek.pendingObligations', { count: String(pendingObligationCount) })}</Badge>
                  ) : null}
                </dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}

      <section className="space-y-2" data-testid="sign-peek-ai">
        <h3 className="text-xs font-semibold text-muted-foreground">{t('peek.aiSection', { name: COWORKER_ROSTER.gm })}</h3>
        <ProposalSurface proposed={hasAiSummary} className="space-y-2 p-3">
          <CoworkerAttribution
            coworker="gm"
            badgeLabel={hasAiSummary ? t('obligations.statusProposed') : undefined}
          />
          {hasAiSummary && aiAnalysis ? (
            <div className="space-y-1.5 text-xs">
              {aiAnalysis.summaryText ? <p className="text-muted-foreground">{aiAnalysis.summaryText}</p> : null}
              <div className="flex flex-wrap gap-1.5">
                <Badge variant={aiAnalysis.riskClauses.length > 0 ? 'warning' : 'secondary'}>
                  {t('peek.aiRiskClauses', { count: String(aiAnalysis.riskClauses.length) })}
                </Badge>
                <Badge variant="outline">
                  {t('peek.aiProposedFields', { count: String(aiAnalysis.proposedFields.length) })}
                </Badge>
              </div>
            </div>
          ) : (
            <p className="text-xs text-subtle-foreground">{t('peek.aiOff')}</p>
          )}
        </ProposalSurface>
      </section>
    </div>
  );
}

export function SignEnvelopesPage() {
  const t = useTranslations('sign');
  const common = useTranslations('common');
  const f = useFormat();
  const navigate = useNavigate();
  const { slug = '' } = useParams({ strict: false }) as { slug?: string };

  const [tab, setTab] = useState<EnvelopeFilterTab>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [createdDocxNotice, setCreatedDocxNotice] = useState<{
    envelopeId: string;
    warnings: readonly SignDocxToPdfWarning[];
  } | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [drafterOpen, setDrafterOpen] = useState(false);
  const [sharedLinkDialog, setSharedLinkDialog] = useState<{ title: string; url: string } | null>(null);
  const [pendingRowAction, setPendingRowAction] = useState<{ id: string; kind: 'zalo' | 'remind' | 'sealed' } | null>(null);
  const [inPersonModal, setInPersonModal] = useState<{
    envelopeId: string;
    envelopeTitle: string;
    signerId: string;
    signerName: string;
    session: { url: string; expiresAt: string } | null;
  } | null>(null);
  const inPersonReqRef = useRef(0);
  const rowActionReqRef = useRef(0);
  const listContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inPersonReqRef.current += 1;
    rowActionReqRef.current += 1;
    setInPersonModal(null);
    setSharedLinkDialog(null);
    setCreateOpen(false);
    setCreatedDocxNotice(null);
    setDiffOpen(false);
    setDrafterOpen(false);
    setPendingRowAction(null);
  }, [slug]);

  useEffect(() => {
    return () => {
      inPersonReqRef.current += 1;
      rowActionReqRef.current += 1;
    };
  }, []);

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
  const currentOrgInfo = meQuery.data?.orgs.find((o) => o.slug === slug);
  const defaultPartyAName = currentOrgInfo?.name ?? '';
  const roleHere = currentOrgInfo?.role ?? orgQuery.data?.role ?? null;
  const currentUserId = meQuery.data?.userId ?? null;
  const hasAuthRole = Boolean(meQuery.data || orgQuery.data);
  const canWriteSign = hasAuthRole && Boolean(roleHere && roleHere !== 'viewer');
  const canAskVy = canWriteSign;
  const canManageEnvelope = (item: Pick<SignEnvelopeSummary, 'createdBy'>): boolean => {
    if (meQuery.data) {
      return canManageEnvelopeLinks({
        role: roleHere,
        userId: currentUserId,
        createdBy: item.createdBy,
      });
    }
    if (orgQuery.data) {
      return orgQuery.data.role === 'owner' || orgQuery.data.role === 'admin';
    }
    return false;
  };
  // Meeting-minutes envelopes are read by all meeting readers, but only creators, owners, or admins may act on them (#4530).
  const canActOnEnvelope = (item: Pick<SignEnvelopeSummary, 'createdBy' | 'sourceKind'>): boolean =>
    canWriteSign && (item.sourceKind !== 'meeting_minutes' || canManageEnvelope(item));
  const isRenewalsTab = tab === 'renewals';

  const envelopesQuery = useQuery({
    queryKey: ['sign', 'envelopes', slug, tab],
    queryFn: () => fetchEnvelopesForTab(tab),
    enabled: !isRenewalsTab,
  });

  const renewalsQuery = useQuery({
    queryKey: ['sign', 'renewals', slug],
    queryFn: () => signApi.listRenewalEnvelopes({ limit: 100 }),
    enabled: isRenewalsTab,
  });

  const getDueSigners = (signers: readonly { id: string; signerRole: string; status: string; deliveryMode: string; email: string | null }[]) =>
    signers.filter((s) => s.signerRole !== 'cc' && (s.status === 'pending' || s.status === 'viewed'));

  const copyOrShowSignerLink = async (
    item: Pick<SignEnvelopeSummary, 'id' | 'title'>,
    signerId: string,
    copiedToast: string,
    reqId: number,
  ) => {
    const minted = await signApi.createSignerLink(item.id, signerId);
    if (rowActionReqRef.current !== reqId) return;
    const url = buildSigningUrl(minted.token);
    if (await copyTextToClipboard(url)) {
      if (rowActionReqRef.current === reqId) toast(copiedToast);
    } else if (rowActionReqRef.current === reqId) {
      setInPersonModal(null);
      setSharedLinkDialog({ title: item.title, url });
    }
  };

  const handleCopyZaloLink = async (item: SignEnvelopeSummary) => {
    if (!canManageEnvelope(item)) return;
    const reqId = rowActionReqRef.current + 1;
    rowActionReqRef.current = reqId;
    setPendingRowAction({ id: item.id, kind: 'zalo' });
    try {
      const detail = await signApi.getEnvelope(item.id);
      if (rowActionReqRef.current !== reqId) return;
      const activeSigners = getDueSigners(detail.signers);
      const dueSigner =
        activeSigners.find((s) => s.deliveryMode === 'link') ?? activeSigners[0];
      if (!dueSigner) {
        toast(t('actions.noActiveSignerToast'));
        return;
      }
      await copyOrShowSignerLink(item, dueSigner.id, t('actions.linkCopiedToast'), reqId);
    } catch (error) {
      if (rowActionReqRef.current === reqId) toast(errorMessage(error), 'error');
    } finally {
      if (rowActionReqRef.current === reqId) {
        setPendingRowAction((prev) => (prev?.id === item.id && prev.kind === 'zalo' ? null : prev));
      }
    }
  };

  const handleRemind = async (item: SignEnvelopeSummary) => {
    if (!canActOnEnvelope(item)) return;
    const reqId = rowActionReqRef.current + 1;
    rowActionReqRef.current = reqId;
    setPendingRowAction({ id: item.id, kind: 'remind' });
    try {
      const detail = await signApi.getEnvelope(item.id);
      if (rowActionReqRef.current !== reqId) return;
      const dueSigners = getDueSigners(detail.signers);
      if (dueSigners.length === 0) {
        toast(t('actions.noActiveSignerToast'));
        return;
      }
      const emailDue = dueSigners.filter((s) => s.deliveryMode === 'email' && Boolean(s.email));
      if (emailDue.length > 0) {
        if (emailDue.length === dueSigners.length) {
          await signApi.remindEnvelope(item.id);
        } else {
          for (const signer of emailDue) {
            if (rowActionReqRef.current !== reqId) return;
            await signApi.remindEnvelope(item.id, signer.id);
          }
        }
        if (rowActionReqRef.current === reqId) toast(t('actions.remindedToast'));
        return;
      }
      // Link-only reminders mint a raw signing token, so restrict them to creators, owners, and admins.
      if (!canManageEnvelope(item)) {
        toast(t('actions.noActiveSignerToast'));
        return;
      }
      const target = dueSigners.find((s) => s.deliveryMode === 'link') ?? dueSigners[0];
      if (!target) {
        toast(t('actions.noActiveSignerToast'));
        return;
      }
      await copyOrShowSignerLink(item, target.id, t('actions.remindUseLinkToast'), reqId);
    } catch (error) {
      if (rowActionReqRef.current === reqId) toast(errorMessage(error), 'error');
    } finally {
      if (rowActionReqRef.current === reqId) {
        setPendingRowAction((prev) => (prev?.id === item.id && prev.kind === 'remind' ? null : prev));
      }
    }
  };

  const handleDownloadSealed = async (item: SignEnvelopeSummary) => {
    const reqId = rowActionReqRef.current + 1;
    rowActionReqRef.current = reqId;
    setPendingRowAction({ id: item.id, kind: 'sealed' });
    try {
      const detail = await signApi.getEnvelope(item.id);
      if (rowActionReqRef.current !== reqId) return;
      const fileId = detail.envelope.sealedFileId;
      if (!fileId) return;
      const blob = await downloadSignFile(fileId);
      if (rowActionReqRef.current !== reqId) return;
      triggerBlobDownload(blob, `${item.certificateCode ?? item.id}-sealed.pdf`);
    } catch (error) {
      if (rowActionReqRef.current === reqId) toast(errorMessage(error), 'error');
    } finally {
      if (rowActionReqRef.current === reqId) {
        setPendingRowAction((prev) => (prev?.id === item.id && prev.kind === 'sealed' ? null : prev));
      }
    }
  };

  const items = envelopesQuery.data?.items ?? [];
  const filtered = filterEnvelopesByTab(items, tab);
  const renewalItems: readonly SignObligationRenewalListItem[] = renewalsQuery.data?.items ?? [];
  const visibleEnvelopes: readonly SignEnvelopeSummary[] = isRenewalsTab
    ? renewalItems.map((entry) => entry.envelope)
    : filtered;

  const peek = useListPeekNav({
    items: visibleEnvelopes,
    getId: (item) => item.id,
    containerRef: listContainerRef,
    resetKey: `${slug}:${tab}`,
  });
  const activeEnvelope = peek.activeItem;
  const activeRenewal = activeEnvelope
    ? renewalItems.find((entry) => entry.envelope.id === activeEnvelope.id) ?? null
    : null;

  const peekDetailSupported = typeof signApi.getEnvelope === 'function';
  const peekDetailQuery = useQuery({
    queryKey: ['sign', 'envelope', slug, activeEnvelope?.id ?? 'none'],
    queryFn: () => signApi.getEnvelope(activeEnvelope!.id),
    enabled: Boolean(peek.open && activeEnvelope && peekDetailSupported),
  });

  const peekObligationSupported = typeof signApi.getObligation === 'function';
  const peekObligationQuery = useQuery({
    queryKey: ['sign', 'obligation', slug, activeEnvelope?.id ?? 'none'],
    queryFn: async () => {
      try {
        return await signApi.getObligation(activeEnvelope!.id);
      } catch {
        return null;
      }
    },
    enabled: Boolean(peek.open && activeEnvelope && !activeRenewal && peekObligationSupported),
  });

  const peekAiSupported = typeof signApi.getAiAnalysis === 'function';
  const peekAiQuery = useQuery({
    queryKey: ['sign', 'ai', slug, activeEnvelope?.id ?? 'none'],
    queryFn: async () => {
      try {
        return await signApi.getAiAnalysis(activeEnvelope!.id);
      } catch {
        return null;
      }
    },
    enabled: Boolean(peek.open && activeEnvelope && peekAiSupported),
  });

  const startInPersonMutation = useMutation({
    mutationFn: async ({
      envelopeId,
      envelopeTitle,
      signerId,
      signerName,
      reqId,
    }: {
      envelopeId: string;
      envelopeTitle: string;
      signerId: string;
      signerName: string;
      reqId: number;
    }) => {
      const res = await signApi.startInPersonSigning(envelopeId, signerId);
      return {
        reqId,
        envelopeId,
        envelopeTitle,
        signerId,
        signerName,
        url: buildInPersonSigningUrl(res.token),
        expiresAt: res.expiresAt,
      };
    },
    onSuccess: async (res) => {
      if (inPersonReqRef.current === res.reqId) {
        setInPersonModal({
          envelopeId: res.envelopeId,
          envelopeTitle: res.envelopeTitle,
          signerId: res.signerId,
          signerName: res.signerName,
          session: { url: res.url, expiresAt: res.expiresAt },
        });
        toast(t('inPersonDialog.startedToast'));
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] }),
        queryClient.invalidateQueries({ queryKey: ['sign', 'envelope', slug, res.envelopeId] }),
        queryClient.invalidateQueries({ queryKey: ['sign', 'renewals', slug] }),
      ]);
    },
    onError: (err, vars) => {
      if (inPersonReqRef.current !== vars.reqId) return;
      toast(errorMessage(err), 'error');
    },
  });

  const handleStartInPerson = (envelope: SignEnvelopeSummary, signerId: string) => {
    if (!canActOnEnvelope(envelope)) return;
    const signerName = peekDetailQuery.data?.signers.find((s) => s.id === signerId)?.name ?? '';
    inPersonReqRef.current += 1;
    setSharedLinkDialog(null);
    setInPersonModal({
      envelopeId: envelope.id,
      envelopeTitle: envelope.title,
      signerId,
      signerName,
      session: null,
    });
  };

  const peekSigners = peekDetailQuery.data?.signers ?? [];
  const peekDueSigners = getDueSigners(peekSigners);
  const firstDuePeekSigner = peekDueSigners[0] ?? null;
  const activeEnvelopeIsActive = activeEnvelope
    ? activeEnvelope.status === 'sent' || activeEnvelope.status === 'in_progress'
    : false;
  const activeEnvelopeIsSealed = activeEnvelope
    ? activeEnvelope.status === 'completed' && activeEnvelope.sealStatus === 'sealed'
    : false;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canWriteSign ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setDiffOpen(true)}
                data-testid="sign-open-version-diff-btn"
              >
                {t('diff.openButton')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDrafterOpen(true)}
                data-testid="sign-open-drafter-btn"
              >
                {t('drafter.openButton')}
              </Button>
              <Button
                type="button"
                onClick={() => setCreateOpen(true)}
                data-testid="sign-new-envelope-btn"
              >
                {t('createButton')}
              </Button>
            </div>
          ) : undefined
        }
      />

      <ContractVaultBar key={slug} slug={slug} canAskVy={canAskVy} />

      {createdDocxNotice ? (
        <DocxWarningsAlert
          warnings={createdDocxNotice.warnings}
          onDismiss={() => {
            clearCreatedDocxWarnings(createdDocxNotice.envelopeId, {
              org: currentOrgInfo?.orgId ?? (slug || null),
              userId: currentUserId,
            });
            setCreatedDocxNotice(null);
          }}
        />
      ) : null}

      <Tabs value={tab} onValueChange={(next) => setTab(next as EnvelopeFilterTab)}>
        <TabsList className="flex max-w-full flex-wrap group-data-horizontal/tabs:h-auto">
          <TabsTrigger value="all">{t('tabs.all')}</TabsTrigger>
          <TabsTrigger value="actionNeeded">{t('tabs.actionNeeded')}</TabsTrigger>
          <TabsTrigger value="waiting">{t('tabs.waiting')}</TabsTrigger>
          <TabsTrigger value="completed">{t('tabs.completed')}</TabsTrigger>
          <TabsTrigger value="renewals" data-testid="sign-tab-renewals">
            {t('tabs.renewals')}
          </TabsTrigger>
          <TabsTrigger value="closed">{t('tabs.closed')}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div ref={listContainerRef}>
        {isRenewalsTab ? (
        <>
          {renewalsQuery.isLoading ? <TableSkeleton columns={6} rows={4} /> : null}
          {renewalsQuery.isError ? <ErrorText>{errorMessage(renewalsQuery.error)}</ErrorText> : null}

          {!renewalsQuery.isLoading && !renewalsQuery.isError && renewalItems.length === 0 ? (
            <Empty title={t('obligations.renewalsEmptyTitle')} hint={t('obligations.renewalsEmptyHint')} />
          ) : null}

          {renewalItems.length > 0 ? (
            <div data-testid="sign-renewals-list">
              <DataTable
                stacked
                numeric={[2]}
                head={[
                  t('columns.title'),
                  t('columns.counterparty'),
                  t('columns.contractValue'),
                  t('columns.expiryDate'),
                  t('columns.nextObligation'),
                  '',
                ]}
              >
                {renewalItems.map((entry) => {
                  const { envelope: item, obligation } = entry;
                  const isSealed = item.status === 'completed' && item.sealStatus === 'sealed';
                  const selected = peek.selectedId === item.id;
                  const renewalBadge =
                    entry.daysUntilExpiry !== null ? (
                      entry.daysUntilExpiry < 0 ? (
                        <Badge variant="outline">{t('obligations.expiredBadge')}</Badge>
                      ) : entry.daysUntilExpiry === 0 ? (
                        <Badge variant="destructive">{t('obligations.expiresTodayBadge')}</Badge>
                      ) : entry.daysUntilNotice !== null && entry.daysUntilNotice <= 0 ? (
                        <Badge variant="warning">
                          {t('obligations.noticeWindowOpenBadge', { days: String(entry.daysUntilExpiry) })}
                        </Badge>
                      ) : entry.daysUntilNotice !== null && entry.daysUntilNotice <= 30 ? (
                        <Badge variant="secondary">
                          {t('obligations.noticeSoonBadge', { days: String(entry.daysUntilNotice) })}
                        </Badge>
                      ) : null
                    ) : null;

                  return (
                    <TableRow
                      key={item.id}
                      data-peek-row={item.id}
                      data-selected={selected ? 'true' : undefined}
                      onClick={(event) => peek.onRowClick(item.id, event)}
                      className={cn(
                        'cursor-pointer',
                        selected ? 'bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]' : 'hover:bg-muted/40',
                      )}
                    >
                      <TableCell data-label={t('columns.title')}>
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <Link
                            to="/o/$slug/sign/envelopes/$id"
                            params={{ slug, id: item.id }}
                            className="inline-flex max-md:min-h-11 items-center font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            {item.title}
                          </Link>
                          {entry.overdueObligationCount > 0 ? (
                            <Badge variant="destructive">
                              {t('obligations.overdueCountBadge', { count: String(entry.overdueObligationCount) })}
                            </Badge>
                          ) : null}
                          {renewalBadge}
                          {obligation.autoRenew ? (
                            <Badge variant="outline">{t('obligations.autoRenewBadge')}</Badge>
                          ) : null}
                          {entry.pendingObligationCount > 0 ? (
                            <Badge variant="secondary">
                              {t('obligations.pendingCountBadge', { count: String(entry.pendingObligationCount) })}
                            </Badge>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell data-label={t('columns.counterparty')} className="text-foreground">
                        {obligation.counterpartyName ?? ''}
                      </TableCell>
                      <TableCell data-label={t('columns.contractValue')} className="text-right font-mono tabular-nums text-foreground">
                        {obligation.contractValue !== null ? f.money(obligation.contractValue, obligation.currency) : ''}
                      </TableCell>
                      <TableCell data-label={t('columns.expiryDate')} className="text-muted-foreground tabular-nums">
                        {obligation.expiryDate ? f.date(obligation.expiryDate) : ''}
                      </TableCell>
                      <TableCell data-label={t('columns.nextObligation')} className="text-muted-foreground tabular-nums">
                        {entry.nextObligationDueDate ? f.date(entry.nextObligationDueDate) : ''}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-1.5 max-sm:justify-start">
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            data-peek-trigger={item.id}
                            data-testid="sign-envelope-peek-btn"
                            aria-label={t('peek.inspectOf', { title: item.title })}
                            onClick={() => peek.openPeek(item.id)}
                          >
                            {t('peek.inspect')}
                          </Button>
                          {isSealed ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              loading={pendingRowAction?.id === item.id && pendingRowAction.kind === 'sealed'}
                              disabled={pendingRowAction !== null}
                              onClick={() => void handleDownloadSealed(item)}
                            >
                              {t('actions.downloadSealed')}
                            </Button>
                          ) : null}
                          <Link
                            to="/o/$slug/sign/envelopes/$id"
                            params={{ slug, id: item.id }}
                            className={buttonVariants({ size: 'sm', variant: 'secondary' })}
                          >
                            {t('actions.open')}
                          </Link>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </DataTable>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {envelopesQuery.isLoading ? <TableSkeleton columns={5} rows={4} /> : null}
          {envelopesQuery.isError ? <ErrorText>{errorMessage(envelopesQuery.error)}</ErrorText> : null}

          {!envelopesQuery.isLoading && !envelopesQuery.isError && filtered.length === 0 ? (
            <Empty
              title={t('emptyTitle')}
              hint={t('emptyHint')}
              action={
                canWriteSign ? (
                  <Button type="button" onClick={() => setCreateOpen(true)}>
                    {t('createButton')}
                  </Button>
                ) : undefined
              }
            />
          ) : null}

          {filtered.length > 0 ? (
            <div data-testid="sign-envelope-list">
              <DataTable
                stacked
                head={[
                  t('columns.title'),
                  t('columns.status'),
                  t('columns.progress'),
                  t('columns.createdAt'),
                  '',
                ]}
              >
                {filtered.map((item) => {
                  const isActive = item.status === 'sent' || item.status === 'in_progress';
                  const isSealed = item.status === 'completed' && item.sealStatus === 'sealed';
                  const selected = peek.selectedId === item.id;
                  return (
                    <TableRow
                      key={item.id}
                      data-peek-row={item.id}
                      data-selected={selected ? 'true' : undefined}
                      onClick={(event) => peek.onRowClick(item.id, event)}
                      className={cn(
                        'cursor-pointer',
                        selected ? 'bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]' : 'hover:bg-muted/40',
                      )}
                    >
                      <TableCell data-label={t('columns.title')}>
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <Link
                            to="/o/$slug/sign/envelopes/$id"
                            params={{ slug, id: item.id }}
                            className="inline-flex max-md:min-h-11 items-center font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                          >
                            {item.title}
                          </Link>
                          {item.certificateCode ? <span className="font-mono text-xs text-muted-foreground">{item.certificateCode}</span> : null}
                          {item.pageCount ? <span className="text-xs text-subtle-foreground">{t('pagesCount', { count: String(item.pageCount) })}</span> : null}
                        </span>
                      </TableCell>
                      <TableCell data-label={t('columns.status')}>
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <Badge variant={ENVELOPE_BADGE_VARIANT[item.status]}>{t(`statuses.${item.status}`)}</Badge>
                          <Badge variant="outline">{t(`routing.${item.routingMode}`)}</Badge>
                          {item.status === 'completed' || item.sealStatus ? (
                            <Badge variant="secondary">{t(`sealStatuses.${item.sealStatus ?? 'pending'}`)}</Badge>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell data-label={t('columns.progress')} className="tabular-nums">
                        {item.signerSummary.total > 0 ? (
                          <Badge variant="secondary">
                            {t('progress', {
                              signed: String(item.signerSummary.signed),
                              total: String(item.signerSummary.total),
                            })}
                          </Badge>
                        ) : (
                          ''
                        )}
                      </TableCell>
                      <TableCell data-label={t('columns.createdAt')} className="text-muted-foreground tabular-nums">
                        {f.dateTime(item.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex flex-wrap justify-end gap-1.5 max-sm:justify-start">
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            data-peek-trigger={item.id}
                            data-testid="sign-envelope-peek-btn"
                            aria-label={t('peek.inspectOf', { title: item.title })}
                            onClick={() => peek.openPeek(item.id)}
                          >
                            {t('peek.inspect')}
                          </Button>
                          {isActive && canManageEnvelope(item) ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              loading={pendingRowAction?.id === item.id && pendingRowAction.kind === 'zalo'}
                              disabled={pendingRowAction !== null}
                              onClick={() => void handleCopyZaloLink(item)}
                            >
                              {t('actions.copyZalo')}
                            </Button>
                          ) : null}
                          {isActive && canActOnEnvelope(item) ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              loading={pendingRowAction?.id === item.id && pendingRowAction.kind === 'remind'}
                              disabled={pendingRowAction !== null}
                              onClick={() => void handleRemind(item)}
                            >
                              {t('actions.remind')}
                            </Button>
                          ) : null}
                          {isSealed ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              loading={pendingRowAction?.id === item.id && pendingRowAction.kind === 'sealed'}
                              disabled={pendingRowAction !== null}
                              onClick={() => void handleDownloadSealed(item)}
                            >
                              {t('actions.downloadSealed')}
                            </Button>
                          ) : null}
                          <Link
                            to="/o/$slug/sign/envelopes/$id"
                            params={{ slug, id: item.id }}
                            className={buttonVariants({ size: 'sm', variant: 'secondary' })}
                          >
                            {t('actions.open')}
                          </Link>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </DataTable>
            </div>
          ) : null}
        </>
      )}
      </div>

      {activeEnvelope ? (
        <PeekSheet
          open={peek.open}
          onClose={peek.closePeek}
          peekId={peek.peekId}
          data-testid="sign-envelope-peek-sheet"
          title={activeEnvelope.title}
          description={`${t(`statuses.${activeEnvelope.status}`)} · ${t(`routing.${activeEnvelope.routingMode}`)}`}
          badges={
            <>
              <Badge variant={ENVELOPE_BADGE_VARIANT[activeEnvelope.status]}>{t(`statuses.${activeEnvelope.status}`)}</Badge>
              {activeEnvelope.signerSummary.total > 0 ? (
                <Badge variant="secondary">
                  {t('progress', {
                    signed: String(activeEnvelope.signerSummary.signed),
                    total: String(activeEnvelope.signerSummary.total),
                  })}
                </Badge>
              ) : null}
            </>
          }
          positionLabel={common('peek.position', { index: String(peek.activeIndex + 1), total: String(peek.total) })}
          canPrevious={peek.canPrevious}
          canNext={peek.canNext}
          onPrevious={() => peek.step(-1)}
          onNext={() => peek.step(1)}
          actions={
            <>
              {activeEnvelopeIsActive && canManageEnvelope(activeEnvelope) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={pendingRowAction?.id === activeEnvelope.id && pendingRowAction.kind === 'zalo'}
                  disabled={pendingRowAction !== null}
                  onClick={() => void handleCopyZaloLink(activeEnvelope)}
                  data-testid="sign-peek-copy-zalo"
                >
                  {t('actions.copyZalo')}
                </Button>
              ) : null}
              {activeEnvelopeIsActive && canActOnEnvelope(activeEnvelope) ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={pendingRowAction?.id === activeEnvelope.id && pendingRowAction.kind === 'remind'}
                  disabled={pendingRowAction !== null}
                  onClick={() => void handleRemind(activeEnvelope)}
                  data-testid="sign-peek-remind"
                >
                  {t('actions.remind')}
                </Button>
              ) : null}
              {activeEnvelopeIsActive && canActOnEnvelope(activeEnvelope) && firstDuePeekSigner ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={
                    startInPersonMutation.isPending &&
                    startInPersonMutation.variables?.envelopeId === activeEnvelope.id &&
                    startInPersonMutation.variables?.signerId === firstDuePeekSigner.id
                  }
                  disabled={startInPersonMutation.isPending}
                  onClick={() => handleStartInPerson(activeEnvelope, firstDuePeekSigner.id)}
                  data-testid="sign-peek-in-person"
                >
                  {t('actions.startInPerson')}
                </Button>
              ) : null}
              {activeEnvelopeIsSealed ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  loading={pendingRowAction?.id === activeEnvelope.id && pendingRowAction.kind === 'sealed'}
                  disabled={pendingRowAction !== null}
                  onClick={() => void handleDownloadSealed(activeEnvelope)}
                  data-testid="sign-peek-download-sealed"
                >
                  {t('actions.downloadSealed')}
                </Button>
              ) : null}
              <Link
                to="/o/$slug/sign/envelopes/$id"
                params={{ slug, id: activeEnvelope.id }}
                className={buttonVariants({ size: 'sm', variant: 'default' })}
                data-testid="sign-peek-open-link"
              >
                {t('actions.open')}
              </Link>
            </>
          }
        >
          <SignEnvelopePeekContent
            item={activeEnvelope}
            detail={peekDetailQuery.data}
            detailLoading={peekDetailQuery.isLoading}
            detailError={peekDetailQuery.isError ? peekDetailQuery.error : null}
            renewalEntry={activeRenewal}
            obligationData={peekObligationQuery.data}
            aiAnalysis={peekAiQuery.data}
            canStartInPerson={canActOnEnvelope(activeEnvelope)}
            inPersonPendingSignerId={
              startInPersonMutation.isPending && startInPersonMutation.variables?.envelopeId === activeEnvelope.id
                ? startInPersonMutation.variables.signerId
                : null
            }
            onStartInPerson={(signerId) => handleStartInPerson(activeEnvelope, signerId)}
          />
        </PeekSheet>
      ) : null}

      {createOpen ? (
        <CreateEnvelopeDialog
          key={slug}
          onClose={() => setCreateOpen(false)}
          onCreated={async (envelopeId, warnings = []) => {
            await handleEnvelopeCreatedWithWarnings({
              envelopeId,
              warnings,
              slug,
              orgId: currentOrgInfo?.orgId ?? null,
              userId: currentUserId,
              resolveUserScope:
                currentUserId && currentOrgInfo?.orgId
                  ? undefined
                  : async () => {
                      if (!hasMeQuery) return null;
                      const me = await queryClient.fetchQuery(orpc.me.get.queryOptions());
                      return {
                        userId: me.userId,
                        orgId: me.orgs.find((o) => o.slug === slug)?.orgId ?? null,
                      };
                    },
              setCreateOpen,
              setCreatedDocxNotice,
              invalidateEnvelopes: () => queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] }),
              navigateToEnvelope: (targetSlug, targetId) =>
                navigate({ to: '/o/$slug/sign/envelopes/$id', params: { slug: targetSlug, id: targetId } }),
            });
          }}
        />
      ) : null}

      <Dialog
        open={sharedLinkDialog !== null || inPersonModal !== null}
        onOpenChange={(next) => {
          if (!next) {
            inPersonReqRef.current += 1;
            setInPersonModal(null);
            setSharedLinkDialog(null);
          }
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          closeLabel={common('close')}
          data-testid={inPersonModal ? 'sign-peek-in-person-dialog' : undefined}
        >
          <DialogHeader>
            <DialogTitle>{inPersonModal ? t('inPersonDialog.title') : sharedLinkDialog?.title}</DialogTitle>
            <DialogDescription>
              {inPersonModal
                ? t('inPersonDialog.description', {
                    signer: inPersonModal.signerName || inPersonModal.envelopeTitle,
                  })
                : sharedLinkDialog
                  ? t('actions.linkCopiedToast')
                  : null}
            </DialogDescription>
          </DialogHeader>
          {inPersonModal ? (
            <div className="space-y-3">
              <Alert>
                <AlertDescription>{t('inPersonDialog.securityNotice')}</AlertDescription>
              </Alert>
              {inPersonModal.session ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="sign-peek-in-person-url">{t('inPersonDialog.urlLabel')}</Label>
                    <Input
                      id="sign-peek-in-person-url"
                      readOnly
                      value={inPersonModal.session.url}
                      className="font-mono text-xs"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {t('inPersonDialog.expiresAtHint', { time: f.dateTime(inPersonModal.session.expiresAt) })}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <a
                      href={inPersonModal.session.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={buttonVariants({ size: 'sm', variant: 'default' })}
                    >
                      {t('inPersonDialog.openIsolatedTabButton')}
                    </a>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        if (inPersonModal.session && (await copyTextToClipboard(inPersonModal.session.url))) {
                          toast(t('inPersonDialog.copiedIncognitoToast'));
                        } else if (typeof document !== 'undefined') {
                          const inputEl = document.getElementById('sign-peek-in-person-url') as HTMLInputElement | null;
                          inputEl?.focus();
                          inputEl?.select();
                        }
                      }}
                    >
                      {t('inPersonDialog.copyIncognitoButton')}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    loading={startInPersonMutation.isPending}
                    onClick={() => {
                      const reqId = inPersonReqRef.current + 1;
                      inPersonReqRef.current = reqId;
                      startInPersonMutation.mutate({
                        envelopeId: inPersonModal.envelopeId,
                        envelopeTitle: inPersonModal.envelopeTitle,
                        signerId: inPersonModal.signerId,
                        signerName: inPersonModal.signerName,
                        reqId,
                      });
                    }}
                    data-testid="sign-peek-in-person-mint-btn"
                  >
                    {t('inPersonDialog.mintButton')}
                  </Button>
                </div>
              )}
            </div>
          ) : sharedLinkDialog ? (
            <div className="space-y-1.5">
              <Label htmlFor="shared-sign-link-url" className="sr-only">
                {sharedLinkDialog.title}
              </Label>
              <Input
                id="shared-sign-link-url"
                readOnly
                value={sharedLinkDialog.url}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant={inPersonModal ? 'outline' : 'default'}
              onClick={() => {
                inPersonReqRef.current += 1;
                setInPersonModal(null);
                setSharedLinkDialog(null);
              }}
            >
              {common('close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {diffOpen ? (
        <VersionDiffDialog
          open={diffOpen}
          onOpenChange={setDiffOpen}
          existingEnvelopes={items}
          onEnvelopeCreated={async (envelopeId) => {
            await queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] });
            if (slug) {
              await navigate({ to: '/o/$slug/sign/envelopes/$id', params: { slug, id: envelopeId } });
            }
          }}
        />
      ) : null}

      {drafterOpen ? (
        <ContractDrafterDialog
          open={drafterOpen}
          onOpenChange={setDrafterOpen}
          defaultPartyAName={defaultPartyAName}
          onEnvelopeCreated={async (envelopeId) => {
            await queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] });
            if (slug) {
              await navigate({ to: '/o/$slug/sign/envelopes/$id', params: { slug, id: envelopeId } });
            }
          }}
          onTemplateCreated={async () => {
            await queryClient.invalidateQueries({ queryKey: ['sign', 'templates'] });
            if (slug) {
              await navigate({ to: '/o/$slug/sign/templates', params: { slug } });
            }
          }}
        />
      ) : null}
    </div>
  );
}
