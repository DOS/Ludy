// SPDX-License-Identifier: AGPL-3.0-only
// Browser-carried handoff from Ludy Du an project completion to Ludy eSign acceptance minutes and Ludy Ke toan sales invoice draft (#3812, Slice 3b, ADR-0050, ADR-0053).
// Strict gating: when 'sign' is MODULE_OFF or disabled for the org, zero sign.* queries run and zero UI controls render.
// AI-off parity: completed project tasks populate handover deliverables deterministically; Vy summary ('sign.acceptance_draft') is strictly optional and tainted ('proposal' badge, human-editable).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useLocale, useTranslations } from 'use-intl';
import { z } from 'zod';
import {
  vietnamToday,
  type ProjectStatus,
  type SignAcceptanceDraftResult,
  type SignAcceptanceDraftStatus,
  type SignEnvelopeBySourceItem,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { DateInput, hasInvalidDate } from './date-input.tsx';
import { ErrorText } from './ui.tsx';
import * as apiModule from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import {
  buildProjectAcceptanceFilename,
  buildProjectAcceptancePdfBytes,
  buildSalesInvoiceAcceptanceSearch,
} from '../lib/project-acceptance-pdf.ts';
import type { SignDeliveryMode, SignEnvelopeStatus } from '../lib/sign-fields.ts';
import { taskTitleText } from '../lib/task-title.ts';

const RETRYABLE_ENVELOPE_STATUSES = new Set<SignEnvelopeStatus>(['voided', 'expired', 'declined']);
const zValidEmail = z.email().max(254);

const ACTIVE_ENVELOPE_POLL_MS = 15_000;
const SEALING_ENVELOPE_POLL_MS = 5_000;

const SIGN_STATUS_BADGE_VARIANT: Record<
  SignEnvelopeStatus,
  'secondary' | 'warning' | 'success' | 'destructive' | 'outline'
> = {
  draft: 'secondary',
  sent: 'warning',
  in_progress: 'warning',
  completed: 'success',
  declined: 'destructive',
  voided: 'outline',
  expired: 'warning',
};

export interface ProjectAcceptanceCompletedTask {
  id: string;
  title: string;
  // The title is an AI coworker's text (#4421): the handover copy shows its invisible characters instead of carrying them into editable text.
  tainted?: boolean;
}

export interface ProjectAcceptanceProjectSource {
  id: string;
  name: string;
  status: ProjectStatus;
}

export interface EditableAcceptanceDeliverable {
  localId: string;
  text: string;
  proposedByAi: boolean;
}

export interface ProjectAcceptanceSignHandoffProps {
  project: ProjectAcceptanceProjectSource;
  completedTasks: readonly ProjectAcceptanceCompletedTask[];
  boardFiltered?: boolean;
  canEdit: boolean;
  providerDefaultName?: string | null;
  envelope?: SignEnvelopeBySourceItem | null;
  envelopeLoading?: boolean;
  envelopeError?: unknown;
  onRetryEnvelope?: () => void;
  unfinishedEnvelopeId?: string | null;
  signEnabled?: boolean;
  financeEnabled?: boolean;
  onCreated?: (envelopeId: string) => void;
}

export function projectAcceptanceModuleDeployed(moduleId: 'sign' | 'finance'): boolean {
  try {
    return getConfig().modules.includes(moduleId);
  } catch {
    return false;
  }
}

export function useSignAppEnabled(active = true): boolean {
  const deployed = active && projectAcceptanceModuleDeployed('sign');
  const orgApps = useQuery({
    ...apiModule.orpc.org.apps.queryOptions(),
    enabled: deployed,
    retry: false,
  });
  if (!deployed) return false;
  return orgApps.data?.apps.find((app) => app.id === 'sign')?.effective === true;
}

export function useFinanceAppEnabled(active = true): boolean {
  const deployed = active && projectAcceptanceModuleDeployed('finance');
  const orgApps = useQuery({
    ...apiModule.orpc.org.apps.queryOptions(),
    enabled: deployed,
    retry: false,
  });
  if (!deployed) return false;
  return orgApps.data?.apps.find((app) => app.id === 'finance')?.effective === true;
}

export function projectAcceptancePollMs(items: readonly SignEnvelopeBySourceItem[] | undefined): number | false {
  if (!items || items.length === 0) return false;
  if (items.some((e) => e.status === 'completed' && (e.sealStatus === null || e.sealStatus === 'pending'))) {
    return SEALING_ENVELOPE_POLL_MS;
  }
  if (items.some((e) => e.status === 'draft' || e.status === 'sent' || e.status === 'in_progress')) {
    return ACTIVE_ENVELOPE_POLL_MS;
  }
  return false;
}

export function canStartProjectAcceptanceHandoff(
  projectStatus: ProjectStatus,
  envelope: Pick<SignEnvelopeBySourceItem, 'envelopeId' | 'status'> | null | undefined,
  unfinishedEnvelopeId: string | null = null,
): boolean {
  if (projectStatus === 'archived') return false;
  if (!envelope) return true;
  if (unfinishedEnvelopeId !== null && envelope.envelopeId === unfinishedEnvelopeId && envelope.status === 'draft') {
    return true;
  }
  return RETRYABLE_ENVELOPE_STATUSES.has(envelope.status);
}

export function canDownloadSealedProjectAcceptance(
  envelope: Pick<SignEnvelopeBySourceItem, 'status' | 'sealStatus' | 'sealedFileId'> | null | undefined,
): envelope is Pick<SignEnvelopeBySourceItem, 'status' | 'sealStatus' | 'sealedFileId'> & { sealedFileId: string } {
  return Boolean(
    envelope &&
      envelope.status === 'completed' &&
      envelope.sealStatus === 'sealed' &&
      typeof envelope.sealedFileId === 'string' &&
      envelope.sealedFileId.length > 0,
  );
}

export function canCreateInvoiceFromAcceptance(
  envelope: Pick<SignEnvelopeBySourceItem, 'status' | 'sealStatus'> | null | undefined,
  financeEnabled: boolean,
  canEdit: boolean,
): boolean {
  return Boolean(
    canEdit &&
      financeEnabled &&
      envelope &&
      envelope.status === 'completed' &&
      envelope.sealStatus === 'sealed',
  );
}

// The done tasks of a board read as the handover's completed tasks, each with the taint of its title (#4421): a filtered or truncated board is read again for them, and the copy then marks the title the same way.
export function completedTasksOfBoard(tasks: readonly { id: string; title: string; status: string; tainted: boolean }[]): ProjectAcceptanceCompletedTask[] {
  return tasks.filter((task) => task.status === 'done').map((task) => ({ id: task.id, title: task.title, tainted: task.tainted }));
}

export function buildDeterministicDeliverables(
  completedTasks: readonly ProjectAcceptanceCompletedTask[],
): EditableAcceptanceDeliverable[] {
  if (completedTasks.length === 0) {
    return [{ localId: 'manual-0', text: '', proposedByAi: false }];
  }
  return completedTasks.map((task) => ({
    localId: `task-${task.id}`,
    text: taskTitleText(task),
    proposedByAi: false,
  }));
}

export interface ProjectAcceptanceHandoffAttempt {
  orgSlug?: string | null;
  sourceFileId?: string;
  envelopeCreateKey: string;
  pendingCreate?: boolean;
  priorEnvelopeId?: string | null;
  envelopeId?: string;
  signerAddKey: string;
  signerAdded?: boolean;
}

export function createProjectAcceptanceHandoffAttempt(
  priorEnvelopeId: string | null = null,
): ProjectAcceptanceHandoffAttempt {
  return {
    envelopeCreateKey: crypto.randomUUID(),
    signerAddKey: crypto.randomUUID(),
    priorEnvelopeId,
  };
}

interface LooseApiBindings {
  getCurrentOrg?: () => string | null;
  uploadFiles?: (files: readonly File[], purpose: string, orgSlug?: string | null) => Promise<{ files: Array<{ fileId: string }> }>;
  fetchFile?: (fileId: string) => Promise<Blob>;
  client?: typeof apiModule.client;
}

function currentActiveOrg(): string | null {
  const fn = (apiModule as unknown as LooseApiBindings).getCurrentOrg;
  return typeof fn === 'function' ? fn() : null;
}

function isSameOrgActive(pinnedOrg: string | null): boolean {
  if (!pinnedOrg) return true;
  const live = currentActiveOrg();
  return live === null || live === pinnedOrg;
}

function assertSameOrgActive(pinnedOrg: string | null): void {
  if (!isSameOrgActive(pinnedOrg)) {
    throw new Error('Organization changed while preparing eSign envelope');
  }
}

async function defaultUploadSignPdf(file: File, orgSlug?: string | null): Promise<{ fileId: string }> {
  const uploadFn = (apiModule as unknown as LooseApiBindings).uploadFiles;
  if (typeof uploadFn !== 'function') {
    throw new Error('UPLOAD_UNAVAILABLE');
  }
  const result = await uploadFn([file], 'sign_document', orgSlug);
  const uploaded = result.files[0];
  if (!uploaded) {
    throw new Error('UPLOAD_FAILED');
  }
  return { fileId: uploaded.fileId };
}

async function defaultDownloadSignFile(fileId: string): Promise<Blob> {
  const fetchFn = (apiModule as unknown as LooseApiBindings).fetchFile;
  if (typeof fetchFn !== 'function') {
    throw new Error('DOWNLOAD_UNAVAILABLE');
  }
  return fetchFn(fileId);
}

export interface PerformProjectAcceptanceSignHandoffDeps {
  project: ProjectAcceptanceProjectSource;
  slug: string;
  acceptanceDate: string;
  providerName: string;
  recipientName: string;
  deliveryMode: SignDeliveryMode;
  recipientEmail?: string | null;
  deliverables: readonly string[];
  note?: string | null;
  envelopeTitle: string;
  signerRoleLabel: string;
  navigate: (opts: { to: '/o/$slug/sign/envelopes/$id'; params: { slug: string; id: string } }) => unknown;
  attempt?: ProjectAcceptanceHandoffAttempt;
  uploadPdf?: (file: File, orgSlug?: string | null) => Promise<{ fileId: string }>;
  rpcClient?: Pick<typeof apiModule.client, 'sign'>;
  onCreated?: (envelopeId: string) => void;
}

export async function performProjectAcceptanceSignHandoff({
  project,
  slug,
  acceptanceDate,
  providerName,
  recipientName,
  deliveryMode,
  recipientEmail,
  deliverables,
  note,
  envelopeTitle,
  signerRoleLabel,
  navigate,
  attempt: givenAttempt,
  uploadPdf = defaultUploadSignPdf,
  rpcClient,
  onCreated,
}: PerformProjectAcceptanceSignHandoffDeps): Promise<string> {
  const pinnedOrg = slug || currentActiveOrg() || null;
  assertSameOrgActive(pinnedOrg);
  const attempt = givenAttempt ?? createProjectAcceptanceHandoffAttempt();
  if (attempt.orgSlug && pinnedOrg && attempt.orgSlug !== pinnedOrg) {
    throw new Error('Organization changed while preparing eSign envelope');
  }
  attempt.orgSlug ??= pinnedOrg;

  const fallbackClient = (apiModule as unknown as LooseApiBindings).client;
  const orgClient =
    rpcClient ??
    (pinnedOrg && typeof apiModule.clientForOrg === 'function'
      ? apiModule.clientForOrg(pinnedOrg)
      : fallbackClient);
  if (!orgClient) {
    throw new Error('API_CLIENT_UNAVAILABLE');
  }

  const trimmedRecipient = recipientName.trim().slice(0, 200);
  const trimmedEmail = recipientEmail?.trim().toLowerCase() ?? '';
  const validEmail = trimmedEmail && zValidEmail.safeParse(trimmedEmail).success ? trimmedEmail : null;
  // Never leak a hidden email into the PDF or signer record when 'link' delivery mode is chosen.
  const effectiveEmail = deliveryMode === 'email' ? validEmail : null;

  const cleanDeliverables = deliverables
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!attempt.sourceFileId) {
    const pdfBytes = buildProjectAcceptancePdfBytes({
      projectName: project.name,
      providerName: providerName.trim(),
      recipientName: trimmedRecipient,
      recipientEmail: effectiveEmail,
      acceptanceDate,
      deliverables: cleanDeliverables,
      note: note?.trim() || null,
    });
    const filename = buildProjectAcceptanceFilename(acceptanceDate, project.id);
    const pdfBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
    const pdfFile = new File([pdfBuffer], filename, { type: 'application/pdf' });
    const uploaded = await uploadPdf(pdfFile, pinnedOrg ?? undefined);
    assertSameOrgActive(pinnedOrg);
    attempt.sourceFileId = uploaded.fileId;
  }

  let attemptedCreateOrSigner = false;
  try {
    if (!attempt.envelopeId) {
      assertSameOrgActive(pinnedOrg);
      attemptedCreateOrSigner = true;
      attempt.pendingCreate = true;
      const created = await orgClient.sign.envelope.create({
        title: envelopeTitle.trim().slice(0, 300),
        sourceKind: 'project_acceptance',
        sourceId: project.id,
        sourceFileId: attempt.sourceFileId,
        idempotencyKey: attempt.envelopeCreateKey,
      });
      attempt.envelopeId = created.envelopeId;
      attempt.pendingCreate = false;
    }

    if (!attempt.signerAdded) {
      assertSameOrgActive(pinnedOrg);
      attemptedCreateOrSigner = true;
      if (trimmedRecipient) {
        await orgClient.sign.signer.add({
          envelopeId: attempt.envelopeId,
          routingOrder: 1,
          signerRole: 'signer',
          roleLabel: signerRoleLabel,
          name: trimmedRecipient,
          ...(effectiveEmail ? { email: effectiveEmail } : {}),
          deliveryMode,
          requireEmailOtp: false,
          idempotencyKey: attempt.signerAddKey,
        });
      }
      attempt.signerAdded = true;
    }
  } finally {
    if (attemptedCreateOrSigner && isSameOrgActive(pinnedOrg)) {
      await apiModule.queryClient.invalidateQueries({ queryKey: apiModule.orpc.sign.envelope.by_source.key() });
      await apiModule.queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] });
      if (attempt.envelopeId) {
        onCreated?.(attempt.envelopeId);
      }
    }
  }

  assertSameOrgActive(pinnedOrg);
  const envelopeId = attempt.envelopeId;
  if (slug) {
    await navigate({ to: '/o/$slug/sign/envelopes/$id', params: { slug, id: envelopeId } });
  }
  return envelopeId;
}

function triggerBrowserBlobDownload(blob: Blob, filename: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return;
  }
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export interface ProjectAcceptanceDialogBodyProps {
  project: ProjectAcceptanceProjectSource;
  slug: string;
  completedTasks: readonly ProjectAcceptanceCompletedTask[];
  boardFiltered?: boolean;
  loadAllDoneTasks?: boolean;
  providerDefaultName?: string | null;
  priorEnvelopeId?: string | null;
  draftSummaryFn?: (input: { projectId: string; language: 'vi' | 'en' }) => Promise<SignAcceptanceDraftResult>;
  onCancel: () => void;
  onCreated?: (envelopeId: string) => void;
}

export function ProjectAcceptanceDialogBody({
  project,
  slug,
  completedTasks,
  boardFiltered = false,
  loadAllDoneTasks = false,
  providerDefaultName,
  priorEnvelopeId = null,
  draftSummaryFn,
  onCancel,
  onCreated,
}: ProjectAcceptanceDialogBodyProps) {
  const t = useTranslations('projects.acceptance');
  const tc = useTranslations('common');
  const locale = useLocale();
  const navigate = useNavigate();
  const baseId = useId();

  const shouldFetchDoneTasks = loadAllDoneTasks || boardFiltered;
  const doneTasksQuery = useQuery({
    ...apiModule.orpc.projects.board.queryOptions({
      input: { projectId: project.id, status: ['done'] },
    }),
    enabled: shouldFetchDoneTasks,
    retry: false,
  });

  const effectiveCompletedTasks = useMemo<readonly ProjectAcceptanceCompletedTask[]>(() => {
    if (shouldFetchDoneTasks && doneTasksQuery.data?.tasks) {
      return completedTasksOfBoard(doneTasksQuery.data.tasks);
    }
    return completedTasks;
  }, [shouldFetchDoneTasks, doneTasksQuery.data, completedTasks]);

  const tasksLoading = shouldFetchDoneTasks && doneTasksQuery.isPending;
  const tasksError = shouldFetchDoneTasks && doneTasksQuery.isError ? doneTasksQuery.error : null;
  const tasksTruncated = Boolean(shouldFetchDoneTasks && doneTasksQuery.data?.truncated);

  const [acceptanceDate, setAcceptanceDate] = useState(() => vietnamToday());
  const [providerName, setProviderName] = useState(() => providerDefaultName?.trim() ?? '');
  const [recipientName, setRecipientName] = useState('');
  const [deliveryMode, setDeliveryMode] = useState<SignDeliveryMode>('link');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [deliverablesTouched, setDeliverablesTouched] = useState(false);
  const [deliverables, setDeliverables] = useState<EditableAcceptanceDeliverable[]>(() =>
    buildDeterministicDeliverables(completedTasks),
  );
  const [note, setNote] = useState('');
  const [vyStatus, setVyStatus] = useState<SignAcceptanceDraftStatus | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [lockedEnvelopeId, setLockedEnvelopeId] = useState<string | null>(null);

  const manualCounterRef = useRef(1);
  const vyTicketRef = useRef(0);
  const activeOrgRef = useRef(slug);
  activeOrgRef.current = slug;

  useEffect(() => {
    if (!providerName && providerDefaultName?.trim()) {
      setProviderName(providerDefaultName.trim());
    }
  }, [providerDefaultName, providerName]);

  useEffect(() => {
    if (shouldFetchDoneTasks && doneTasksQuery.data?.tasks && !deliverablesTouched && vyStatus !== 'used') {
      setDeliverables(buildDeterministicDeliverables(effectiveCompletedTasks));
    }
  }, [shouldFetchDoneTasks, doneTasksQuery.data, deliverablesTouched, vyStatus, effectiveCompletedTasks]);

  const askVy = useMutation({
    mutationFn: async (ticket: number) => {
      const pinnedOrg = slug || currentActiveOrg() || null;
      assertSameOrgActive(pinnedOrg);
      const language: 'vi' | 'en' = locale === 'en' ? 'en' : 'vi';
      if (draftSummaryFn) {
        return { ticket, pinnedOrg, result: await draftSummaryFn({ projectId: project.id, language }) };
      }
      const fallbackClient = (apiModule as unknown as LooseApiBindings).client;
      const orgClient =
        pinnedOrg && typeof apiModule.clientForOrg === 'function'
          ? apiModule.clientForOrg(pinnedOrg)
          : fallbackClient;
      if (!orgClient) {
        throw new Error('API_CLIENT_UNAVAILABLE');
      }
      const result = await orgClient.sign.acceptance.draft_summary({
        projectId: project.id,
        language,
      });
      return { ticket, pinnedOrg, result };
    },
    onSuccess: ({ ticket, pinnedOrg, result }) => {
      if (ticket !== vyTicketRef.current || activeOrgRef.current !== slug || !isSameOrgActive(pinnedOrg)) {
        return;
      }
      setVyStatus(result.status);
      if (result.status === 'used' && result.bullets.length > 0) {
        setDeliverables(
          result.bullets.map((b, idx) => ({
            localId: `vy-${ticket}-${idx}`,
            text: b.text,
            proposedByAi: true,
          })),
        );
      }
    },
  });

  const pdfFingerprint = useMemo(
    () =>
      JSON.stringify({
        projectId: project.id,
        acceptanceDate,
        providerName: providerName.trim(),
        recipientName: recipientName.trim(),
        deliveryMode,
        recipientEmail: deliveryMode === 'email' ? recipientEmail.trim().toLowerCase() : '',
        deliverables: deliverables.map((d) => d.text.trim()),
        note: note.trim(),
      }),
    [project.id, acceptanceDate, providerName, recipientName, deliveryMode, recipientEmail, deliverables, note],
  );

  const attemptRef = useRef<{ fingerprint: string; attempt: ProjectAcceptanceHandoffAttempt } | null>(null);

  const createEnvelope = useMutation({
    mutationFn: async () => {
      const trimmedRecipient = recipientName.trim();
      if (!trimmedRecipient) {
        throw new Error(t('validationRecipientRequired'));
      }
      const trimmedEmail = recipientEmail.trim().toLowerCase();
      if (deliveryMode === 'email' && (!trimmedEmail || !zValidEmail.safeParse(trimmedEmail).success)) {
        throw new Error(t('validationEmailRequired'));
      }
      const nonEmptyDeliverables = deliverables.map((d) => d.text.trim()).filter((line) => line.length > 0);
      if (nonEmptyDeliverables.length === 0) {
        throw new Error(t('validationDeliverableRequired'));
      }

      // If an earlier attempt in this dialog already created a draft envelope and only signer.add failed,
      // keep reusing that envelopeId instead of creating a duplicate envelope on retry.
      const existingCreated = attemptRef.current?.attempt.envelopeId && !attemptRef.current.attempt.signerAdded;
      if (!existingCreated && (!attemptRef.current || attemptRef.current.fingerprint !== pdfFingerprint)) {
        attemptRef.current = {
          fingerprint: pdfFingerprint,
          attempt: createProjectAcceptanceHandoffAttempt(priorEnvelopeId),
        };
      }

      return performProjectAcceptanceSignHandoff({
        project,
        slug,
        acceptanceDate,
        providerName,
        recipientName: trimmedRecipient,
        deliveryMode,
        recipientEmail: deliveryMode === 'email' ? trimmedEmail || null : null,
        deliverables: nonEmptyDeliverables,
        note,
        envelopeTitle: t('envelopeTitle', { project: project.name, date: acceptanceDate }),
        signerRoleLabel: t('partyBSignerRole'),
        navigate: (opts) => navigate(opts),
        attempt: attemptRef.current!.attempt,
        ...(onCreated ? { onCreated } : {}),
      });
    },
    onSuccess: () => {
      attemptRef.current = null;
      setLockedEnvelopeId(null);
      setValidationError(null);
      onCancel();
    },
    onError: (err) => {
      const cur = attemptRef.current?.attempt;
      if (cur?.envelopeId && !cur.signerAdded) {
        setLockedEnvelopeId(cur.envelopeId);
      }
      setValidationError(apiModule.errorMessage(err));
    },
  });

  const hasAiProposals = deliverables.some((d) => d.proposedByAi);
  const vyDisabledPermanently = vyStatus === 'off' || vyStatus === 'budget';
  const nonEmptyCount = deliverables.filter((d) => d.text.trim().length > 0).length;
  const pdfContentLocked = lockedEnvelopeId !== null || tasksLoading;

  const handleResetToTasks = () => {
    vyTicketRef.current += 1;
    setVyStatus(null);
    setDeliverablesTouched(false);
    setDeliverables(buildDeterministicDeliverables(effectiveCompletedTasks));
  };

  const handleUpdateDeliverable = (index: number, nextText: string) => {
    vyTicketRef.current += 1;
    setDeliverablesTouched(true);
    setDeliverables((prev) =>
      prev.map((item, idx) => (idx === index ? { ...item, text: nextText, proposedByAi: false } : item)),
    );
  };

  const handleRemoveDeliverable = (index: number) => {
    vyTicketRef.current += 1;
    setDeliverablesTouched(true);
    setDeliverables((prev) => {
      const next = prev.filter((_, idx) => idx !== index);
      return next.length > 0 ? next : [{ localId: `manual-${manualCounterRef.current++}`, text: '', proposedByAi: false }];
    });
  };

  const handleAddDeliverable = () => {
    vyTicketRef.current += 1;
    setDeliverablesTouched(true);
    setDeliverables((prev) => [
      ...prev,
      { localId: `manual-${manualCounterRef.current++}`, text: '', proposedByAi: false },
    ]);
  };

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (hasInvalidDate(e.currentTarget)) return;
        if (!tasksLoading && tasksError === null && !createEnvelope.isPending) {
          createEnvelope.mutate();
        }
      }}
      data-testid="project-acceptance-dialog-body"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${baseId}-date`}>{t('dateLabel')}</Label>
          <DateInput
            id={`${baseId}-date`}
            value={acceptanceDate}
            disabled={pdfContentLocked}
            onChange={setAcceptanceDate}
            data-testid="project-acceptance-date"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${baseId}-provider`}>{t('providerLabel')}</Label>
          <Input
            id={`${baseId}-provider`}
            value={providerName}
            maxLength={200}
            disabled={pdfContentLocked}
            placeholder={t('providerPlaceholder')}
            onChange={(e) => setProviderName(e.target.value)}
            data-testid="project-acceptance-provider"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor={`${baseId}-recipient`}>{t('recipientNameLabel')}</Label>
          <Input
            id={`${baseId}-recipient`}
            value={recipientName}
            maxLength={200}
            placeholder={t('recipientNamePlaceholder')}
            onChange={(e) => {
              setRecipientName(e.target.value);
              if (validationError) setValidationError(null);
            }}
            data-testid="project-acceptance-recipient-name"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${baseId}-delivery`}>{t('deliveryModeLabel')}</Label>
          <NativeSelect
            id={`${baseId}-delivery`}
            className="w-full"
            value={deliveryMode}
            onChange={(e) => {
              setDeliveryMode(e.target.value as SignDeliveryMode);
              if (validationError) setValidationError(null);
            }}
            data-testid="project-acceptance-delivery-mode"
          >
            <NativeSelectOption value="link">{t('deliveryLink')}</NativeSelectOption>
            <NativeSelectOption value="email">{t('deliveryEmail')}</NativeSelectOption>
          </NativeSelect>
        </div>
      </div>

      {deliveryMode === 'email' && (
        <div className="space-y-1">
          <Label htmlFor={`${baseId}-email`}>{t('recipientEmailLabel')}</Label>
          <Input
            id={`${baseId}-email`}
            type="email"
            value={recipientEmail}
            maxLength={254}
            placeholder={t('recipientEmailPlaceholder')}
            onChange={(e) => {
              setRecipientEmail(e.target.value);
              if (validationError) setValidationError(null);
            }}
            data-testid="project-acceptance-recipient-email"
          />
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {t('deliverablesTitle', { count: nonEmptyCount })}
            </span>
            {hasAiProposals && (
              <Badge variant="proposal" data-testid="project-acceptance-proposal-badge">
                {t('proposalBadge')}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {effectiveCompletedTasks.length > 0 && !vyDisabledPermanently && !pdfContentLocked && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                loading={askVy.isPending}
                disabled={askVy.isPending || createEnvelope.isPending || tasksLoading || tasksError !== null}
                onClick={() => {
                  const nextTicket = vyTicketRef.current + 1;
                  vyTicketRef.current = nextTicket;
                  askVy.mutate(nextTicket);
                }}
                data-testid="project-acceptance-ask-vy"
              >
                {t('askVyBtn')}
              </Button>
            )}
            {hasAiProposals && effectiveCompletedTasks.length > 0 && !pdfContentLocked && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={createEnvelope.isPending}
                onClick={handleResetToTasks}
                data-testid="project-acceptance-reset-tasks"
              >
                {t('resetToTasksBtn')}
              </Button>
            )}
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          {tasksLoading
            ? t('loadingCompletedTasks')
            : effectiveCompletedTasks.length === 0
              ? t('emptyCompletedTasks')
              : t('completedTasksHint')}
        </p>

        {tasksTruncated && (
          <p className="text-xs text-warning" role="status" data-testid="project-acceptance-truncated-tasks">
            {t('truncatedCompletedTasks', { count: effectiveCompletedTasks.length })}
          </p>
        )}

        {tasksError !== null && (
          <div className="flex flex-wrap items-center gap-2">
            <ErrorText>{apiModule.errorMessage(tasksError)}</ErrorText>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void doneTasksQuery.refetch()}
              data-testid="project-acceptance-retry-tasks"
            >
              {t('retryLoadStatus')}
            </Button>
          </div>
        )}

        {vyStatus !== null && (
          <p
            className="text-xs text-foreground"
            role="status"
            data-testid="project-acceptance-vy-status"
            data-status={vyStatus}
          >
            {t(`vyState.${vyStatus}`)}
          </p>
        )}
        {askVy.error && <ErrorText>{apiModule.errorMessage(askVy.error)}</ErrorText>}

        {!tasksLoading && tasksError === null && (
          <>
            <ul className="max-h-56 space-y-2 overflow-y-auto pr-1" data-testid="project-acceptance-deliverables">
              {deliverables.map((item, idx) => (
                <li
                  key={item.localId}
                  className={`flex items-start gap-2 rounded-md p-1.5 ${
                    item.proposedByAi ? 'border border-dashed border-proposal bg-muted/20' : ''
                  }`}
                  data-testid="project-acceptance-deliverable-row"
                  data-proposed={item.proposedByAi ? 'true' : 'false'}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`${baseId}-item-${idx}`} className="text-xs text-subtle-foreground">
                        {t('deliverableItemLabel', { index: idx + 1 })}
                      </Label>
                      {item.proposedByAi && <Badge variant="proposal">{t('proposalBadge')}</Badge>}
                    </div>
                    <Input
                      id={`${baseId}-item-${idx}`}
                      value={item.text}
                      maxLength={240}
                      disabled={pdfContentLocked}
                      placeholder={t('deliverablePlaceholder')}
                      onChange={(e) => {
                        handleUpdateDeliverable(idx, e.target.value);
                        if (validationError) setValidationError(null);
                      }}
                      data-testid={`project-acceptance-deliverable-input-${idx}`}
                    />
                  </div>
                  {deliverables.length > 1 && !pdfContentLocked && (
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('removeDeliverable', { index: idx + 1 })}
                      onClick={() => handleRemoveDeliverable(idx)}
                      className="mt-5"
                      data-testid={`project-acceptance-remove-item-${idx}`}
                    >
                      ×
                    </Button>
                  )}
                </li>
              ))}
            </ul>

            {!pdfContentLocked && (
              <div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={handleAddDeliverable}
                  data-testid="project-acceptance-add-item"
                >
                  + {t('addDeliverable')}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      <div className="space-y-1">
        <Label htmlFor={`${baseId}-note`}>{t('noteLabel')}</Label>
        <Textarea
          id={`${baseId}-note`}
          rows={2}
          maxLength={1000}
          disabled={pdfContentLocked}
          value={note}
          placeholder={t('notePlaceholder')}
          onChange={(e) => setNote(e.target.value)}
          data-testid="project-acceptance-note"
        />
      </div>

      {lockedEnvelopeId !== null && (
        <p className="text-xs text-muted-foreground" role="status" data-testid="project-acceptance-envelope-locked">
          {t('envelopeCreatedRetryHint')}
        </p>
      )}

      {validationError && <ErrorText>{validationError}</ErrorText>}

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={createEnvelope.isPending}
          onClick={onCancel}
          data-testid="project-acceptance-cancel"
        >
          {tc('cancel')}
        </Button>
        <Button
          type="submit"
          loading={createEnvelope.isPending}
          disabled={createEnvelope.isPending || tasksLoading || tasksError !== null}
          data-testid="project-acceptance-submit"
        >
          {t('submitBtn')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ProjectAcceptanceSignHandoffView({
  project,
  completedTasks,
  boardFiltered = false,
  loadAllDoneTasks = false,
  canEdit,
  providerDefaultName,
  envelope,
  envelopeLoading,
  envelopeError,
  onRetryEnvelope,
  unfinishedEnvelopeId = null,
  financeEnabled,
  onCreated,
}: {
  project: ProjectAcceptanceProjectSource;
  completedTasks: readonly ProjectAcceptanceCompletedTask[];
  boardFiltered?: boolean;
  loadAllDoneTasks?: boolean;
  canEdit: boolean;
  providerDefaultName?: string | null;
  envelope: SignEnvelopeBySourceItem | null;
  envelopeLoading: boolean;
  envelopeError?: unknown;
  onRetryEnvelope?: () => void;
  unfinishedEnvelopeId?: string | null;
  financeEnabled: boolean;
  onCreated?: (envelopeId: string) => void;
}) {
  const t = useTranslations('projects.acceptance');
  const tc = useTranslations('common');
  const { slug = '' } = useParams({ strict: false }) as { slug?: string };
  const [dialogOpen, setDialogOpen] = useState(false);

  const downloadSealed = useMutation({
    mutationFn: async () => {
      if (!canDownloadSealedProjectAcceptance(envelope)) return;
      const pinnedOrg = slug || currentActiveOrg() || null;
      assertSameOrgActive(pinnedOrg);
      const blob = await defaultDownloadSignFile(envelope.sealedFileId);
      assertSameOrgActive(pinnedOrg);
      const safeId = project.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'signed';
      triggerBrowserBlobDownload(blob, `bien-ban-nghiem-thu-da-ky-${safeId}.pdf`);
    },
  });

  const hasLookupError = envelopeError !== undefined && envelopeError !== null;
  const showOpenButton =
    canEdit &&
    !envelopeLoading &&
    !hasLookupError &&
    canStartProjectAcceptanceHandoff(project.status, envelope, unfinishedEnvelopeId);
  const showSealedDownload = canDownloadSealedProjectAcceptance(envelope);
  const showInvoiceLink = canCreateInvoiceFromAcceptance(envelope, financeEnabled, canEdit);
  const statusText = envelope ? t(`status.${envelope.status}`) : null;

  const openButtonLabel =
    unfinishedEnvelopeId !== null && envelope?.envelopeId === unfinishedEnvelopeId
      ? t('resumeBtn')
      : envelope && RETRYABLE_ENVELOPE_STATUSES.has(envelope.status)
        ? t('retryBtn')
        : t('openBtn');

  const invoiceSearch = useMemo(
    () =>
      envelope
        ? buildSalesInvoiceAcceptanceSearch({
            projectName: project.name,
            certificateCode: envelope.certificateCode,
            envelopeId: envelope.envelopeId,
          })
        : null,
    [envelope, project.name],
  );

  if (!envelope && !showOpenButton && !hasLookupError) {
    return null;
  }

  return (
    <>
      {envelope && statusText && (
        <Link
          to="/o/$slug/sign/envelopes/$id"
          params={{ slug, id: envelope.envelopeId }}
          aria-label={t('openEnvelopeLabel', { title: envelope.title, status: statusText })}
          className="inline-flex items-center justify-center rounded-4xl max-md:min-h-11 max-md:min-w-11 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          data-testid="project-acceptance-sign-status"
          data-status={envelope.status}
        >
          <Badge variant={SIGN_STATUS_BADGE_VARIANT[envelope.status]}>{statusText}</Badge>
        </Link>
      )}
      {showSealedDownload && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={downloadSealed.isPending}
          onClick={() => {
            if (!downloadSealed.isPending) downloadSealed.mutate();
          }}
          data-testid="project-acceptance-download-sealed"
        >
          {t('downloadSealed')}
        </Button>
      )}
      {showInvoiceLink && invoiceSearch && (
        <Link
          to="/o/$slug/sales-invoices"
          params={{ slug }}
          search={invoiceSearch}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
          data-testid="project-acceptance-create-invoice"
          data-description={invoiceSearch.description}
          data-reference={invoiceSearch.reference}
        >
          {t('createInvoice')}
        </Link>
      )}
      {showOpenButton && (
        <Button
          type="button"
          variant="outline"
          onClick={() => setDialogOpen(true)}
          data-testid="project-acceptance-open-button"
        >
          {openButtonLabel}
        </Button>
      )}
      {hasLookupError && (
        <div className="inline-flex flex-wrap items-center gap-2" data-testid="project-acceptance-lookup-error">
          <ErrorText>{apiModule.errorMessage(envelopeError)}</ErrorText>
          {onRetryEnvelope && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetryEnvelope}
              data-testid="project-acceptance-retry-status"
            >
              {t('retryLoadStatus')}
            </Button>
          )}
        </div>
      )}
      {downloadSealed.error && <ErrorText>{apiModule.errorMessage(downloadSealed.error)}</ErrorText>}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-xl" closeLabel={tc('close')} data-testid="project-acceptance-dialog">
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogDesc')}</DialogDescription>
          </DialogHeader>
          {dialogOpen && (
            <ProjectAcceptanceDialogBody
              project={project}
              slug={slug}
              completedTasks={completedTasks}
              boardFiltered={boardFiltered}
              loadAllDoneTasks={loadAllDoneTasks}
              providerDefaultName={providerDefaultName ?? null}
              priorEnvelopeId={envelope?.envelopeId ?? null}
              onCancel={() => setDialogOpen(false)}
              {...(onCreated ? { onCreated } : {})}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProjectAcceptanceSignHandoffConnected({
  project,
  completedTasks,
  boardFiltered = false,
  canEdit,
  providerDefaultName,
  unfinishedEnvelopeId,
  financeEnabled,
  onCreated,
}: {
  project: ProjectAcceptanceProjectSource;
  completedTasks: readonly ProjectAcceptanceCompletedTask[];
  boardFiltered?: boolean;
  canEdit: boolean;
  providerDefaultName?: string | null;
  unfinishedEnvelopeId?: string | null;
  financeEnabled: boolean;
  onCreated?: (envelopeId: string) => void;
}) {
  const bySource = useQuery({
    ...apiModule.orpc.sign.envelope.by_source.queryOptions({
      input: { sourceKind: 'project_acceptance', sourceIds: [project.id] },
    }),
    refetchInterval: (query) => projectAcceptancePollMs(query.state.data?.items),
  });
  const orgQuery = useQuery({
    ...apiModule.orpc.org.get.queryOptions(),
    enabled: providerDefaultName === undefined,
    retry: false,
  });

  const latestEnvelope = bySource.data?.items.find((item) => item.sourceId === project.id) ?? null;
  const resolvedProviderName = providerDefaultName ?? orgQuery.data?.name ?? null;

  return (
    <ProjectAcceptanceSignHandoffView
      project={project}
      completedTasks={completedTasks}
      boardFiltered={boardFiltered}
      loadAllDoneTasks={true}
      canEdit={canEdit}
      providerDefaultName={resolvedProviderName}
      envelope={latestEnvelope}
      envelopeLoading={bySource.isPending}
      envelopeError={bySource.isError ? bySource.error : null}
      onRetryEnvelope={() => void bySource.refetch()}
      financeEnabled={financeEnabled}
      {...(unfinishedEnvelopeId !== undefined ? { unfinishedEnvelopeId } : {})}
      {...(onCreated ? { onCreated } : {})}
    />
  );
}

export function ProjectAcceptanceSignHandoff({
  project,
  completedTasks,
  boardFiltered = false,
  canEdit,
  providerDefaultName,
  envelope,
  envelopeLoading = false,
  envelopeError,
  onRetryEnvelope,
  unfinishedEnvelopeId,
  signEnabled,
  financeEnabled,
  onCreated,
}: ProjectAcceptanceSignHandoffProps) {
  const liveSignEnabled = useSignAppEnabled(signEnabled === undefined);
  const effectiveSignEnabled = signEnabled ?? liveSignEnabled;
  const liveFinanceEnabled = useFinanceAppEnabled(effectiveSignEnabled && financeEnabled === undefined);
  const effectiveFinanceEnabled = financeEnabled ?? liveFinanceEnabled;

  if (!effectiveSignEnabled) return null;

  if (envelope !== undefined || envelopeError !== undefined) {
    return (
      <ProjectAcceptanceSignHandoffView
        project={project}
        completedTasks={completedTasks}
        boardFiltered={boardFiltered}
        canEdit={canEdit}
        providerDefaultName={providerDefaultName ?? null}
        envelope={envelope ?? null}
        envelopeLoading={envelopeLoading}
        financeEnabled={effectiveFinanceEnabled}
        {...(envelopeError !== undefined ? { envelopeError } : {})}
        {...(onRetryEnvelope ? { onRetryEnvelope } : {})}
        {...(unfinishedEnvelopeId !== undefined ? { unfinishedEnvelopeId } : {})}
        {...(onCreated ? { onCreated } : {})}
      />
    );
  }

  return (
    <ProjectAcceptanceSignHandoffConnected
      project={project}
      completedTasks={completedTasks}
      boardFiltered={boardFiltered}
      canEdit={canEdit}
      financeEnabled={effectiveFinanceEnabled}
      {...(providerDefaultName !== undefined ? { providerDefaultName } : {})}
      {...(unfinishedEnvelopeId !== undefined ? { unfinishedEnvelopeId } : {})}
      {...(onCreated ? { onCreated } : {})}
    />
  );
}
