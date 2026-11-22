// SPDX-License-Identifier: AGPL-3.0-only
// Browser-carried handoff from a Ludy Nhan su labor contract (employment terms row) to Ludy eSign (#3553, ADR-0050, ADR-0053).
// Mirrors QuoteSignHandoff (#3512): zero cross-schema SQL foreign keys, strict instance + per-org 'sign' app gating,
// prefilled employee signer contact + contract title, live envelope status badge, and direct sealed PDF download.
import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { z } from 'zod';
import type { HrCandidateView, HrEmploymentView, SignEnvelopeBySourceItem } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { resolveUnfinishedEnvelopeId, signEnvelopePollMs, useSignAppEnabled } from './quote-sign-handoff.tsx';
import { ErrorText } from './ui.tsx';
import { client, clientForOrg, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { buildHrContractPdfBytes } from '../lib/hr-contract-pdf.ts';
import { downloadSignFile, uploadSignPdf } from '../lib/sign-api.ts';
import type { SignEnvelopeStatus } from '../lib/sign-fields.ts';

const RETRYABLE_ENVELOPE_STATUSES = new Set<SignEnvelopeStatus>(['voided', 'expired', 'declined']);
const zValidEmail = z.email().max(254);

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

export interface HrContractSignSource {
  employment: HrEmploymentView;
  employee: {
    id: string;
    displayName: string;
    legalEntityId?: string;
    departmentName?: string | null;
    jobTitle?: string | null;
    address?: string | null;
    birthDate?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  employer?: {
    name: string;
    taxCode?: string | null;
    address?: string | null;
  } | null;
}

export interface HrContractSignHandoffProps {
  source: HrContractSignSource;
  canEdit: boolean;
  envelope?: SignEnvelopeBySourceItem | null;
  envelopeLoading?: boolean;
  unfinishedEnvelopeId?: string | null;
  signEnabled?: boolean;
  onCreated?: (envelopeId: string) => void;
}

export function canStartHrContractSignHandoff(
  employment: Pick<HrEmploymentView, 'contractType'>,
  envelope: Pick<SignEnvelopeBySourceItem, 'envelopeId' | 'status'> | null | undefined,
  unfinishedEnvelopeId: string | null = null,
): boolean {
  if (employment.contractType === 'none') return false;
  if (!envelope) return true;
  if (unfinishedEnvelopeId !== null && envelope.envelopeId === unfinishedEnvelopeId && envelope.status === 'draft') {
    return true;
  }
  return RETRYABLE_ENVELOPE_STATUSES.has(envelope.status);
}

export function canDownloadSealedHrContract(
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

interface ServerContractPdfPayload {
  filename?: string;
  pdfBase64: string;
  title?: string;
  employeeName?: string;
  employeeEmail?: string | null;
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function tryFetchServerContractPdf(
  source: HrContractSignSource,
  rpc: unknown,
): Promise<ServerContractPdfPayload | null> {
  const hrNamespace = (rpc as { hr?: Record<string, unknown> } | null)?.hr;
  if (!hrNamespace) return null;
  const employeeNs = hrNamespace.employee as { contractPdf?: (input: { employeeId: string; termsId: string }) => Promise<unknown> } | undefined;
  const fn = employeeNs?.contractPdf;
  if (typeof fn !== 'function') return null;
  const raw = await fn({ employeeId: source.employee.id, termsId: source.employment.id }).catch(() => null);
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.pdfBase64 !== 'string' || obj.pdfBase64.length === 0) return null;
  return {
    ...(typeof obj.filename === 'string' ? { filename: obj.filename } : {}),
    pdfBase64: obj.pdfBase64,
    ...(typeof obj.title === 'string' ? { title: obj.title } : {}),
    ...(typeof obj.employeeName === 'string' ? { employeeName: obj.employeeName } : {}),
    ...(typeof obj.employeeEmail === 'string' || obj.employeeEmail === null
      ? { employeeEmail: obj.employeeEmail as string | null }
      : {}),
  };
}

export async function resolveHrEmployeeContact(
  source: HrContractSignSource,
  rpc: Pick<typeof client, 'hr'> = client,
): Promise<{ name: string; email: string | null; phone: string | null }> {
  let rawEmail = source.employee.email ?? null;
  let rawPhone = source.employee.phone ?? null;

  if (rawEmail === null && rawPhone === null) {
    const hiredQueryKey = orpc.hr?.recruiting?.candidates?.list?.queryOptions?.({
      input: { stage: 'hired', limit: 200 },
    })?.queryKey;
    let candidates = hiredQueryKey ? queryClient.getQueryData<readonly HrCandidateView[]>(hiredQueryKey) : undefined;
    if (!candidates) {
      const listCandidates = rpc.hr?.recruiting?.candidates?.list;
      if (typeof listCandidates === 'function') {
        candidates = (await listCandidates({ stage: 'hired', limit: 200 }).catch(() => undefined)) ?? undefined;
      }
    }
    if (Array.isArray(candidates)) {
      const matched = candidates.find(
        (c) => c.hiredEmployeeId === source.employee.id && c.erasedAt === null,
      );
      if (matched) {
        rawEmail = matched.email;
        rawPhone = matched.phone;
      }
    }
  }

  const name = source.employee.displayName.trim().slice(0, 200);
  const trimmedEmail = rawEmail?.trim().toLowerCase() ?? '';
  const email = trimmedEmail && zValidEmail.safeParse(trimmedEmail).success ? trimmedEmail : null;
  const trimmedPhone = rawPhone?.trim() ?? '';
  const phone = trimmedPhone.length >= 6 && trimmedPhone.length <= 32 ? trimmedPhone : null;
  return { name, email, phone };
}

export interface HrContractSignHandoffAttempt {
  orgSlug?: string | null;
  envelopeTitle?: string;
  sourceFileId?: string;
  prefilledEmail?: string | null;
  envelopeCreateKey: string;
  pendingCreate?: boolean;
  priorEnvelopeId?: string | null;
  envelopeId?: string;
  signerAddKey: string;
  signerAdded?: boolean;
}

export function createHrContractSignHandoffAttempt(
  priorEnvelopeId: string | null = null,
): HrContractSignHandoffAttempt {
  return {
    envelopeCreateKey: crypto.randomUUID(),
    signerAddKey: crypto.randomUUID(),
    priorEnvelopeId,
  };
}

export interface HrContractSignHandoffDeps {
  source: HrContractSignSource;
  slug: string;
  envelopeTitle: string;
  signerRoleLabel: string;
  navigate: (opts: { to: '/o/$slug/sign/envelopes/$id'; params: { slug: string; id: string } }) => unknown;
  attempt?: HrContractSignHandoffAttempt;
  onCreated?: (envelopeId: string) => void;
}

function currentActiveOrg(): string | null {
  return typeof getCurrentOrg === 'function' ? getCurrentOrg() : null;
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

export function buildHrContractFilename(effectiveFrom: string, employeeId: string): string {
  const safeDate = effectiveFrom.replace(/[^0-9-]/g, '') || 'contract';
  const suffix = employeeId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'emp';
  return `hop-dong-lao-dong-${safeDate}-${suffix}.pdf`;
}

export async function performHrContractSignHandoff({
  source,
  slug,
  envelopeTitle,
  signerRoleLabel,
  navigate,
  attempt: givenAttempt,
  onCreated,
}: HrContractSignHandoffDeps): Promise<string> {
  const pinnedOrg = slug || currentActiveOrg() || null;
  assertSameOrgActive(pinnedOrg);
  const attempt = givenAttempt ?? createHrContractSignHandoffAttempt();
  if (attempt.orgSlug && pinnedOrg && attempt.orgSlug !== pinnedOrg) {
    throw new Error('Organization changed while preparing eSign envelope');
  }
  attempt.orgSlug ??= pinnedOrg;
  const orgClient = pinnedOrg && typeof clientForOrg === 'function' ? clientForOrg(pinnedOrg) : client;

  if (!attempt.sourceFileId) {
    const serverPdf = await tryFetchServerContractPdf(source, orgClient);
    assertSameOrgActive(pinnedOrg);
    if (serverPdf?.employeeEmail !== undefined) {
      attempt.prefilledEmail = serverPdf.employeeEmail;
    }
    const resolvedTitle = (serverPdf?.title ?? envelopeTitle).trim().slice(0, 300);
    attempt.envelopeTitle ??= resolvedTitle;

    const pdfBytes = serverPdf
      ? decodeBase64Bytes(serverPdf.pdfBase64)
      : buildHrContractPdfBytes({
          employerName: source.employer?.name ?? '',
          employerTaxCode: source.employer?.taxCode ?? null,
          employerAddress: source.employer?.address ?? null,
          employeeName: source.employee.displayName,
          employeeDepartment: source.employee.departmentName ?? null,
          employeeJobTitle: source.employee.jobTitle ?? null,
          employeeAddress: source.employee.address ?? null,
          employeeBirthDate: source.employee.birthDate ?? null,
          effectiveFrom: source.employment.effectiveFrom,
          contractType: source.employment.contractType,
          contractForm: source.employment.contractForm,
          termMonths: source.employment.termMonths,
          contractEndOn: source.employment.contractEndOn,
          fixedTermSequence: source.employment.fixedTermSequence,
          region: source.employment.region,
          baseWage: source.employment.baseWage,
          payBasis: source.employment.payBasis,
          hourlyRate: source.employment.hourlyRate,
          pieceRate: source.employment.pieceRate,
          probationRoleTier: source.employment.probationRoleTier,
          probationEndOn: source.employment.probationEndOn,
          probationWage: source.employment.probationWage,
        });

    const filename = serverPdf?.filename
      ? serverPdf.filename.replace(/[^A-Za-z0-9_.-]+/g, '-')
      : buildHrContractFilename(source.employment.effectiveFrom, source.employee.id);
    const pdfBuffer = pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength) as ArrayBuffer;
    const pdfFile = new File([pdfBuffer], filename, { type: 'application/pdf' });
    const uploaded = await uploadSignPdf(pdfFile, pinnedOrg ?? undefined);
    assertSameOrgActive(pinnedOrg);
    attempt.sourceFileId = uploaded.fileId;
  }

  attempt.envelopeTitle ??= envelopeTitle.trim().slice(0, 300);

  let attemptedCreateOrSigner = false;
  try {
    if (!attempt.envelopeId) {
      assertSameOrgActive(pinnedOrg);
      attemptedCreateOrSigner = true;
      attempt.pendingCreate = true;
      const created = await orgClient.sign.envelope.create({
        title: attempt.envelopeTitle,
        sourceKind: 'hr_contract',
        sourceId: source.employment.id,
        sourceFileId: attempt.sourceFileId,
        idempotencyKey: attempt.envelopeCreateKey,
      });
      attempt.envelopeId = created.envelopeId;
      attempt.pendingCreate = false;
    }

    if (!attempt.signerAdded) {
      assertSameOrgActive(pinnedOrg);
      attemptedCreateOrSigner = true;
      const enrichedSource: HrContractSignSource =
        attempt.prefilledEmail !== undefined && source.employee.email === undefined
          ? { ...source, employee: { ...source.employee, email: attempt.prefilledEmail } }
          : source;
      const contact = await resolveHrEmployeeContact(enrichedSource, orgClient);
      assertSameOrgActive(pinnedOrg);
      if (contact.name) {
        await orgClient.sign.signer.add({
          envelopeId: attempt.envelopeId,
          routingOrder: 1,
          signerRole: 'signer',
          roleLabel: signerRoleLabel,
          name: contact.name,
          ...(contact.email ? { email: contact.email } : {}),
          ...(contact.phone ? { phone: contact.phone } : {}),
          deliveryMode: contact.email ? 'email' : 'link',
          requireEmailOtp: false,
          idempotencyKey: attempt.signerAddKey,
        });
      }
      attempt.signerAdded = true;
    }
  } finally {
    if (attemptedCreateOrSigner && isSameOrgActive(pinnedOrg)) {
      await queryClient.invalidateQueries({ queryKey: orpc.sign.envelope.by_source.key() });
      await queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] });
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

function HrContractSignHandoffView({
  source,
  canEdit,
  envelope,
  envelopeLoading,
  unfinishedEnvelopeId: externalUnfinishedId,
  onCreated,
}: {
  source: HrContractSignSource;
  canEdit: boolean;
  envelope: SignEnvelopeBySourceItem | null;
  envelopeLoading: boolean;
  unfinishedEnvelopeId?: string | null;
  onCreated?: (envelopeId: string) => void;
}) {
  const t = useTranslations('hrEmployees');
  const { slug = '' } = useParams({ strict: false }) as { slug?: string };
  const navigate = useNavigate();
  const attemptKey = source.employment.id;
  const attemptRef = useRef<{ key: string; attempt: HrContractSignHandoffAttempt } | null>(null);
  const [unfinished, setUnfinished] = useState<{
    key: string;
    envelopeId: string | null;
    pendingCreate: boolean;
    priorEnvelopeId: string | null;
  } | null>(null);

  const handoff = useMutation({
    mutationFn: () => {
      const staleCachedAttempt =
        attemptRef.current?.key !== attemptKey ||
        (envelope !== null &&
          RETRYABLE_ENVELOPE_STATUSES.has(envelope.status) &&
          attemptRef.current.attempt.envelopeId === envelope.envelopeId);
      if (staleCachedAttempt || !attemptRef.current) {
        attemptRef.current = {
          key: attemptKey,
          attempt: createHrContractSignHandoffAttempt(envelope?.envelopeId ?? null),
        };
      }
      return performHrContractSignHandoff({
        source,
        slug,
        envelopeTitle: t('sign.envelopeTitle', {
          name: source.employee.displayName,
          date: source.employment.effectiveFrom,
        }),
        signerRoleLabel: t('sign.signerRoleLabel'),
        navigate: (opts) => navigate(opts),
        attempt: attemptRef.current.attempt,
        ...(onCreated ? { onCreated } : {}),
      });
    },
    onSuccess: () => {
      attemptRef.current = null;
      setUnfinished(null);
    },
    onError: () => {
      const cur = attemptRef.current?.attempt;
      if (cur && !cur.signerAdded && (cur.envelopeId || cur.pendingCreate)) {
        setUnfinished({
          key: attemptKey,
          envelopeId: cur.envelopeId ?? null,
          pendingCreate: Boolean(cur.pendingCreate),
          priorEnvelopeId: cur.priorEnvelopeId ?? null,
        });
      }
    },
  });

  const downloadSealed = useMutation({
    mutationFn: async () => {
      if (!canDownloadSealedHrContract(envelope)) return;
      const blob = await downloadSignFile(envelope.sealedFileId);
      const safeDate = source.employment.effectiveFrom.replace(/[^0-9-]/g, '') || 'signed';
      triggerBrowserBlobDownload(blob, `hop-dong-lao-dong-da-ky-${safeDate}.pdf`);
    },
  });

  const unfinishedEnvelopeId =
    externalUnfinishedId ?? resolveUnfinishedEnvelopeId(unfinished, attemptKey, envelope);
  const showSendButton =
    canEdit && !envelopeLoading && canStartHrContractSignHandoff(source.employment, envelope, unfinishedEnvelopeId);
  const showSealedDownload = canDownloadSealedHrContract(envelope);
  const statusText = envelope ? t(`sign.status.${envelope.status}`) : null;
  const activeError = handoff.error ?? downloadSealed.error;

  return (
    <>
      {envelope && statusText && (
        <Link
          to="/o/$slug/sign/envelopes/$id"
          params={{ slug, id: envelope.envelopeId }}
          aria-label={t('sign.openLabel', { title: envelope.title, status: statusText })}
          className="inline-flex items-center rounded-4xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          data-testid="hr-contract-sign-status"
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
          data-testid="hr-contract-download-sealed"
        >
          {t('sign.downloadSealed')}
        </Button>
      )}
      {showSendButton && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={handoff.isPending}
          onClick={() => {
            if (!handoff.isPending) handoff.mutate();
          }}
          data-testid="hr-contract-send-esign"
        >
          {t('sign.send')}
        </Button>
      )}
      {activeError && (
        <div className="w-full" data-testid="hr-contract-sign-error">
          <ErrorText>{errorMessage(activeError)}</ErrorText>
        </div>
      )}
    </>
  );
}

function HrContractSignHandoffOwn({
  source,
  canEdit,
  envelopeLoading,
  unfinishedEnvelopeId,
  onCreated,
}: {
  source: HrContractSignSource;
  canEdit: boolean;
  envelopeLoading?: boolean;
  unfinishedEnvelopeId?: string | null;
  onCreated?: (envelopeId: string) => void;
}) {
  const ownQuery = useQuery({
    ...orpc.sign.envelope.by_source.queryOptions({
      input: { sourceKind: 'hr_contract', sourceIds: [source.employment.id] },
    }),
    retry: false,
    refetchInterval: (query) => signEnvelopePollMs(query.state.data?.items),
  });
  const envelope = ownQuery.data?.items.find((item) => item.sourceId === source.employment.id) ?? null;
  return (
    <HrContractSignHandoffView
      source={source}
      canEdit={canEdit}
      envelope={envelope}
      envelopeLoading={envelopeLoading ?? (ownQuery.isPending || ownQuery.isError)}
      {...(unfinishedEnvelopeId !== undefined ? { unfinishedEnvelopeId } : {})}
      {...(onCreated ? { onCreated } : {})}
    />
  );
}

export function HrContractSignHandoff(props: HrContractSignHandoffProps) {
  const orgSignEnabled = useSignAppEnabled(props.signEnabled === undefined);
  const signEnabled = props.signEnabled ?? orgSignEnabled;
  if (!signEnabled) return null;
  if (props.envelope !== undefined) {
    return (
      <HrContractSignHandoffView
        source={props.source}
        canEdit={props.canEdit}
        envelope={props.envelope}
        envelopeLoading={props.envelopeLoading ?? false}
        {...(props.unfinishedEnvelopeId !== undefined ? { unfinishedEnvelopeId: props.unfinishedEnvelopeId } : {})}
        {...(props.onCreated ? { onCreated: props.onCreated } : {})}
      />
    );
  }
  return (
    <HrContractSignHandoffOwn
      source={props.source}
      canEdit={props.canEdit}
      {...(props.envelopeLoading !== undefined ? { envelopeLoading: props.envelopeLoading } : {})}
      {...(props.unfinishedEnvelopeId !== undefined ? { unfinishedEnvelopeId: props.unfinishedEnvelopeId } : {})}
      {...(props.onCreated ? { onCreated: props.onCreated } : {})}
    />
  );
}
