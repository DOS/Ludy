// SPDX-License-Identifier: AGPL-3.0-only
// Browser-carried handoff from shared Ludy Notes meeting minutes to Ludy eSign (#3811, ADR-0047, ADR-0050, ADR-0053).
// Renders ONLY when the meeting has explicitly shared minutes (published summary or published action items) AND
// the 'sign' module is deployed and enabled for the organization. When 'sign' is MODULE_OFF or minutes are unshared,
// zero sign.* queries run and no eSign UI controls render. Works identically whether AI is enabled or off.
import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { z } from 'zod';
import {
  SIGN_MAX_SIGNERS,
  type FollowupDraft,
  type MeetingResults,
  type MeetingSummaryTemplate,
  type MinutesTemplateCopy,
  type SignEnvelopeBySourceItem,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { resolveUnfinishedEnvelopeId, signEnvelopePollMs, useSignAppEnabled } from './quote-sign-handoff.tsx';
import { ErrorText } from './ui.tsx';
import { client, clientForOrg, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { buildMeetingMinutesFilename, buildMeetingMinutesPdfBytes } from '../lib/meeting-minutes-pdf.ts';
import { buildMinutes, vnMoment } from '../lib/minutes.ts';
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

export interface MeetingSignMemberInfo {
  userId: string;
  displayName: string | null;
  email: string;
}

export interface MeetingExternalParticipant {
  name: string;
  email?: string | null;
  phone?: string | null;
  roleLabel?: string;
  signerRole?: 'signer' | 'approver';
}

export interface MeetingMinutesSignSource {
  meeting: {
    id: string;
    title: string;
    startedAt: string | null;
    createdAt: string;
    endedAt: string | null;
    recorderUserId: string;
    readers: readonly string[];
    summaryTemplate: MeetingSummaryTemplate;
    minutesTemplate: MinutesTemplateCopy | null;
    isRecorder?: boolean;
  };
  results: MeetingResults;
  companyName: string;
  place?: string | null;
  orgMembers: readonly MeetingSignMemberInfo[];
  externalParticipants?: readonly MeetingExternalParticipant[];
}

export interface MeetingMinutesSignHandoffProps {
  source: MeetingMinutesSignSource;
  canEdit?: boolean;
  envelope?: SignEnvelopeBySourceItem | null;
  envelopeLoading?: boolean;
  unfinishedEnvelopeId?: string | null;
  signEnabled?: boolean;
  onCreated?: (envelopeId: string) => void;
}

export interface ResolvedMeetingSigner {
  name: string;
  email: string | null;
  phone: string | null;
  roleLabel: string;
  signerRole: 'signer' | 'approver';
}

export function hasSharedMeetingMinutes(
  results: Pick<MeetingResults, 'published' | 'items'> | null | undefined,
): boolean {
  if (!results) return false;
  return results.published !== null || results.items.some((item) => item.stage === 'published');
}

export function computeSharedMinutesRevision(
  results: Pick<MeetingResults, 'published' | 'items'> | null | undefined,
): string {
  if (!results || !hasSharedMeetingMinutes(results)) return '00000000';
  const payload = JSON.stringify([
    results.published?.id ?? null,
    results.published?.summary ?? null,
    results.published?.decisions ?? [],
    results.items
      .filter((item) => item.stage === 'published')
      .map((item) => [item.id, item.title, item.whoUserId, item.whenDate]),
  ]);
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function parseEnvelopeRevision(title: string | null | undefined): string | null {
  if (!title) return null;
  return /\[#([0-9a-f]{8})\]\s*$/i.exec(title)?.[1]?.toLowerCase() ?? null;
}

export function isMeetingMinutesEnvelopeStale(
  results: Pick<MeetingResults, 'published' | 'items'> | null | undefined,
  envelope: Pick<SignEnvelopeBySourceItem, 'title'> | null | undefined,
): boolean {
  if (!envelope || !hasSharedMeetingMinutes(results)) return false;
  const envRev = parseEnvelopeRevision(envelope.title);
  if (!envRev) return false;
  return envRev !== computeSharedMinutesRevision(results);
}

export function canStartMeetingMinutesSignHandoff(
  results: Pick<MeetingResults, 'published' | 'items'> | null | undefined,
  envelope: (Pick<SignEnvelopeBySourceItem, 'envelopeId' | 'status'> & { title?: string }) | null | undefined,
  unfinishedEnvelopeId: string | null = null,
): boolean {
  if (!hasSharedMeetingMinutes(results)) return false;
  if (!envelope) return true;
  if (isMeetingMinutesEnvelopeStale(results, { title: envelope.title ?? '' })) return true;
  if (unfinishedEnvelopeId !== null && envelope.envelopeId === unfinishedEnvelopeId && envelope.status === 'draft') {
    return true;
  }
  return RETRYABLE_ENVELOPE_STATUSES.has(envelope.status);
}

export function canDownloadSealedMeetingMinutes(
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

function normalizeEmail(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().toLowerCase() ?? '';
  return trimmed && zValidEmail.safeParse(trimmed).success ? trimmed : null;
}

function normalizePhone(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? '';
  return trimmed.length >= 6 && trimmed.length <= 32 ? trimmed : null;
}

export async function resolveMeetingMinutesSigners(
  source: MeetingMinutesSignSource,
  labels: {
    recorderRoleLabel: string;
    attendeeRoleLabel: string;
    externalRoleLabel: string;
    unknownMemberLabel: string;
  },
  rpc: unknown = client,
): Promise<ResolvedMeetingSigner[]> {
  const out: ResolvedMeetingSigner[] = [];
  const seenEmails = new Set<string>();
  const seenUsers = new Set<string>();

  const orderedUserIds = [
    source.meeting.recorderUserId,
    ...source.meeting.readers.filter((id) => id !== source.meeting.recorderUserId),
  ];

  for (const userId of orderedUserIds) {
    if (!userId || seenUsers.has(userId) || out.length >= SIGN_MAX_SIGNERS) continue;
    seenUsers.add(userId);
    const member = source.orgMembers.find((m) => m.userId === userId);
    const email = normalizeEmail(member?.email ?? null);
    if (email && seenEmails.has(email)) continue;
    if (email) seenEmails.add(email);
    const rawName = member ? member.displayName?.trim() || member.email.trim() : '';
    const name = (rawName || labels.unknownMemberLabel).slice(0, 200);
    if (!name) continue;
    out.push({
      name,
      email,
      phone: null,
      roleLabel: userId === source.meeting.recorderUserId ? labels.recorderRoleLabel : labels.attendeeRoleLabel,
      signerRole: 'signer',
    });
  }

  const pushExternal = (ext: MeetingExternalParticipant) => {
    if (out.length >= SIGN_MAX_SIGNERS) return;
    const name = ext.name.trim().slice(0, 200);
    if (!name) return;
    const email = normalizeEmail(ext.email ?? null);
    if (email && seenEmails.has(email)) return;
    if (email) seenEmails.add(email);
    out.push({
      name,
      email,
      phone: normalizePhone(ext.phone ?? null),
      roleLabel: (ext.roleLabel?.trim() || labels.externalRoleLabel).slice(0, 120),
      signerRole: ext.signerRole ?? 'signer',
    });
  };

  if (source.externalParticipants && source.externalParticipants.length > 0) {
    for (const ext of source.externalParticipants) {
      pushExternal(ext);
    }
  } else if (source.meeting.isRecorder) {
    const meetingsNs = (rpc as { meetings?: { followup?: { draft?: (input: { meetingId: string }) => Promise<FollowupDraft> } } } | null)
      ?.meetings;
    const fetchDraft = meetingsNs?.followup?.draft;
    if (typeof fetchDraft === 'function') {
      const draft = await fetchDraft({ meetingId: source.meeting.id }).catch(() => null);
      if (draft && Array.isArray(draft.recipients)) {
        for (const rec of draft.recipients) {
          if (rec.kind === 'party') {
            pushExternal({ name: rec.name, email: rec.email });
          }
        }
      }
    }
  }

  return out;
}

export interface MeetingMinutesSignHandoffAttempt {
  orgSlug?: string | null;
  envelopeTitle?: string;
  sourceFileId?: string;
  resolvedSigners?: ResolvedMeetingSigner[];
  envelopeCreateKey: string;
  pendingCreate?: boolean;
  priorEnvelopeId?: string | null;
  envelopeId?: string;
  signerAddKeys: string[];
  signersAddedCount: number;
  signersComplete?: boolean;
}

export function createMeetingMinutesSignHandoffAttempt(
  priorEnvelopeId: string | null = null,
): MeetingMinutesSignHandoffAttempt {
  return {
    envelopeCreateKey: crypto.randomUUID(),
    priorEnvelopeId,
    signerAddKeys: [],
    signersAddedCount: 0,
  };
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

export interface MeetingMinutesSignHandoffDeps {
  source: MeetingMinutesSignSource;
  slug: string;
  envelopeTitle: string;
  labels: {
    recorderRoleLabel: string;
    attendeeRoleLabel: string;
    externalRoleLabel: string;
    unknownMemberLabel: string;
  };
  resolveSectionTitle?: (key: string) => string;
  navigate: (opts: { to: '/o/$slug/sign/envelopes/$id'; params: { slug: string; id: string } }) => unknown;
  attempt?: MeetingMinutesSignHandoffAttempt;
  onCreated?: (envelopeId: string) => void;
}

export async function performMeetingMinutesSignHandoff({
  source,
  slug,
  envelopeTitle,
  labels,
  resolveSectionTitle,
  navigate,
  attempt: givenAttempt,
  onCreated,
}: MeetingMinutesSignHandoffDeps): Promise<string> {
  if (!hasSharedMeetingMinutes(source.results)) {
    throw new Error('Meeting minutes must be shared before creating an eSign envelope');
  }

  const pinnedOrg = slug || currentActiveOrg() || null;
  assertSameOrgActive(pinnedOrg);
  const attempt = givenAttempt ?? createMeetingMinutesSignHandoffAttempt();
  if (attempt.orgSlug && pinnedOrg && attempt.orgSlug !== pinnedOrg) {
    throw new Error('Organization changed while preparing eSign envelope');
  }
  attempt.orgSlug ??= pinnedOrg;
  const orgClient = pinnedOrg && typeof clientForOrg === 'function' ? clientForOrg(pinnedOrg) : client;

  if (!attempt.resolvedSigners) {
    attempt.resolvedSigners = await resolveMeetingMinutesSigners(source, labels, orgClient);
    assertSameOrgActive(pinnedOrg);
    attempt.signerAddKeys = attempt.resolvedSigners.map(() => crypto.randomUUID());
  }

  if (!attempt.sourceFileId) {
    const nameOf = (userId: string): string => {
      const m = source.orgMembers.find((x) => x.userId === userId);
      return m ? m.displayName?.trim() || m.email || labels.unknownMemberLabel : labels.unknownMemberLabel;
    };
    const model = buildMinutes(source.meeting, source.results, nameOf);
    const pdfBytes = buildMeetingMinutesPdfBytes({
      companyName: source.companyName,
      title: source.meeting.title,
      startedAt: source.meeting.startedAt,
      createdAt: source.meeting.createdAt,
      endedAt: source.meeting.endedAt,
      place: source.place ?? null,
      recorderName: model.recorder,
      attendees: model.attendees,
      sections: model.sections.map((s) => ({
        title: s.title ?? (s.key && resolveSectionTitle ? resolveSectionTitle(s.key) : null),
        text: s.text,
      })),
      conclusions: model.conclusions,
      actions: model.actions,
      signers: attempt.resolvedSigners.map((s) => ({ name: s.name, roleLabel: s.roleLabel })),
    });

    const filename = buildMeetingMinutesFilename(
      source.meeting.startedAt ?? source.meeting.createdAt,
      source.meeting.id,
    );
    const pdfBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength,
    ) as ArrayBuffer;
    const pdfFile = new File([pdfBuffer], filename, { type: 'application/pdf' });
    const uploaded = await uploadSignPdf(pdfFile, pinnedOrg ?? undefined);
    assertSameOrgActive(pinnedOrg);
    attempt.sourceFileId = uploaded.fileId;
  }

  const rev = computeSharedMinutesRevision(source.results);
  const revSuffix = ` [#${rev}]`;
  const trimmedTitle = envelopeTitle.trim();
  const stampedTitle = parseEnvelopeRevision(trimmedTitle)
    ? trimmedTitle.slice(0, 300)
    : `${trimmedTitle.slice(0, Math.max(1, 300 - revSuffix.length))}${revSuffix}`;
  attempt.envelopeTitle ??= stampedTitle;

  let attemptedCreateOrSigner = false;
  try {
    if (!attempt.envelopeId) {
      assertSameOrgActive(pinnedOrg);
      attemptedCreateOrSigner = true;
      attempt.pendingCreate = true;
      const created = await orgClient.sign.envelope.create({
        title: attempt.envelopeTitle,
        sourceKind: 'meeting_minutes',
        sourceId: source.meeting.id,
        sourceFileId: attempt.sourceFileId,
        idempotencyKey: attempt.envelopeCreateKey,
      });
      attempt.envelopeId = created.envelopeId;
      attempt.pendingCreate = false;
    }

    if (!attempt.signersComplete) {
      const signers = attempt.resolvedSigners;
      for (let i = attempt.signersAddedCount; i < signers.length; i += 1) {
        assertSameOrgActive(pinnedOrg);
        attemptedCreateOrSigner = true;
        const signer = signers[i]!;
        const addKey = attempt.signerAddKeys[i] ?? crypto.randomUUID();
        attempt.signerAddKeys[i] = addKey;
        await orgClient.sign.signer.add({
          envelopeId: attempt.envelopeId,
          routingOrder: i + 1,
          signerRole: signer.signerRole,
          roleLabel: signer.roleLabel,
          name: signer.name,
          ...(signer.email ? { email: signer.email } : {}),
          ...(signer.phone ? { phone: signer.phone } : {}),
          deliveryMode: signer.email ? 'email' : 'link',
          requireEmailOtp: false,
          idempotencyKey: addKey,
        });
        attempt.signersAddedCount = i + 1;
      }
      attempt.signersComplete = true;
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

function MeetingMinutesSignHandoffView({
  source,
  canEdit,
  envelope,
  envelopeLoading,
  unfinishedEnvelopeId: externalUnfinishedId,
  onCreated,
}: {
  source: MeetingMinutesSignSource;
  canEdit: boolean;
  envelope: SignEnvelopeBySourceItem | null;
  envelopeLoading: boolean;
  unfinishedEnvelopeId?: string | null;
  onCreated?: (envelopeId: string) => void;
}) {
  const t = useTranslations('meetings');
  const { slug = '' } = useParams({ strict: false }) as { slug?: string };
  const navigate = useNavigate();
  const currentRevision = computeSharedMinutesRevision(source.results);
  const attemptKey = `${source.meeting.id}:${currentRevision}`;
  const attemptRef = useRef<{ key: string; attempt: MeetingMinutesSignHandoffAttempt } | null>(null);
  const [unfinished, setUnfinished] = useState<{
    key: string;
    envelopeId: string | null;
    pendingCreate: boolean;
    priorEnvelopeId: string | null;
  } | null>(null);

  const moment = vnMoment(source.meeting.startedAt ?? source.meeting.createdAt);
  const formattedDate = `${moment.day}/${moment.month}/${moment.year}`;

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
          attempt: createMeetingMinutesSignHandoffAttempt(envelope?.envelopeId ?? null),
        };
      }
      return performMeetingMinutesSignHandoff({
        source,
        slug,
        envelopeTitle: t('sign.envelopeTitle', {
          title: source.meeting.title,
          date: formattedDate,
        }),
        labels: {
          recorderRoleLabel: t('sign.recorderRoleLabel'),
          attendeeRoleLabel: t('sign.attendeeRoleLabel'),
          externalRoleLabel: t('sign.externalRoleLabel'),
          unknownMemberLabel: t('results.unknownMember'),
        },
        resolveSectionTitle: (key: string) =>
          source.meeting.summaryTemplate === 'custom'
            ? (source.meeting.minutesTemplate?.sections.find((s) => s.key === key)?.title ?? key)
            : t(`templates.sections.${source.meeting.summaryTemplate}.${key}` as never),
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
      if (cur && !cur.signersComplete && (cur.envelopeId || cur.pendingCreate)) {
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
      if (!canDownloadSealedMeetingMinutes(envelope)) return;
      const blob = await downloadSignFile(envelope.sealedFileId);
      const safeDate = `${moment.year}-${moment.month}-${moment.day}`;
      triggerBrowserBlobDownload(blob, `bien-ban-cuoc-hop-da-ky-${safeDate}.pdf`);
    },
  });

  const stale = isMeetingMinutesEnvelopeStale(source.results, envelope);
  const unfinishedEnvelopeId =
    externalUnfinishedId ?? resolveUnfinishedEnvelopeId(unfinished, attemptKey, envelope);
  const showSendButton =
    canEdit && !envelopeLoading && canStartMeetingMinutesSignHandoff(source.results, envelope, unfinishedEnvelopeId);
  const showSealedDownload = !stale && canDownloadSealedMeetingMinutes(envelope);
  const statusText = envelope ? t(`sign.status.${envelope.status}`) : null;
  const activeError = handoff.error ?? downloadSealed.error;

  if (!envelope && !showSealedDownload && !showSendButton && !activeError) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="meeting-minutes-sign-handoff">
      {envelope && statusText && (
        <Link
          to="/o/$slug/sign/envelopes/$id"
          params={{ slug, id: envelope.envelopeId }}
          aria-label={t('sign.openLabel', { title: envelope.title, status: statusText })}
          className="inline-flex items-center justify-center rounded-4xl max-md:min-h-11 max-md:min-w-11 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          data-testid="meeting-minutes-sign-status"
          data-status={envelope.status}
          data-stale={stale ? 'true' : undefined}
        >
          <Badge variant={stale ? 'outline' : SIGN_STATUS_BADGE_VARIANT[envelope.status]}>{statusText}</Badge>
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
          data-testid="meeting-minutes-download-sealed"
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
          data-testid="meeting-minutes-send-esign"
        >
          {t('sign.send')}
        </Button>
      )}
      {activeError && (
        <div className="w-full" data-testid="meeting-minutes-sign-error">
          <ErrorText>{errorMessage(activeError)}</ErrorText>
        </div>
      )}
    </div>
  );
}

function MeetingMinutesSignHandoffOwn({
  source,
  canEdit,
  envelopeLoading,
  unfinishedEnvelopeId,
  onCreated,
}: {
  source: MeetingMinutesSignSource;
  canEdit: boolean;
  envelopeLoading?: boolean;
  unfinishedEnvelopeId?: string | null;
  onCreated?: (envelopeId: string) => void;
}) {
  const ownQuery = useQuery({
    ...orpc.sign.envelope.by_source.queryOptions({
      input: { sourceKind: 'meeting_minutes', sourceIds: [source.meeting.id] },
    }),
    retry: false,
    refetchInterval: (query) => signEnvelopePollMs(query.state.data?.items),
  });
  const envelope = ownQuery.data?.items.find((item) => item.sourceId === source.meeting.id) ?? null;
  return (
    <MeetingMinutesSignHandoffView
      source={source}
      canEdit={canEdit}
      envelope={envelope}
      envelopeLoading={envelopeLoading ?? (ownQuery.isPending || ownQuery.isError)}
      {...(unfinishedEnvelopeId !== undefined ? { unfinishedEnvelopeId } : {})}
      {...(onCreated ? { onCreated } : {})}
    />
  );
}

export function MeetingMinutesSignHandoff(props: MeetingMinutesSignHandoffProps) {
  const shared = hasSharedMeetingMinutes(props.source.results);
  const orgSignEnabled = useSignAppEnabled(shared && props.signEnabled === undefined);
  const signEnabled = props.signEnabled ?? orgSignEnabled;
  if (!shared || !signEnabled) return null;
  const canEdit = props.canEdit ?? true;
  if (props.envelope !== undefined) {
    return (
      <MeetingMinutesSignHandoffView
        source={props.source}
        canEdit={canEdit}
        envelope={props.envelope}
        envelopeLoading={props.envelopeLoading ?? false}
        {...(props.unfinishedEnvelopeId !== undefined ? { unfinishedEnvelopeId: props.unfinishedEnvelopeId } : {})}
        {...(props.onCreated ? { onCreated: props.onCreated } : {})}
      />
    );
  }
  return (
    <MeetingMinutesSignHandoffOwn
      source={props.source}
      canEdit={canEdit}
      {...(props.envelopeLoading !== undefined ? { envelopeLoading: props.envelopeLoading } : {})}
      {...(props.unfinishedEnvelopeId !== undefined ? { unfinishedEnvelopeId: props.unfinishedEnvelopeId } : {})}
      {...(props.onCreated ? { onCreated: props.onCreated } : {})}
    />
  );
}
