// SPDX-License-Identifier: AGPL-3.0-only
// Browser-carried handoff from an Engage quote to Ludy eSign (#3512, ADR-0050, docs/plan/esign.md Slice 2b).
// Strictly gated on both deployment installation and per-org enablement/entitlement (ADR-0053): when 'sign' is off,
// zero sign.* queries run and no eSign UI controls render. Engage never writes crove_sign tables directly.
import { useRef } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { z } from 'zod';
import type { Quote, QuoteStatus, SignEnvelopeBySourceItem } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { quoteLabel } from './quote-send.tsx';
import { ErrorText } from './ui.tsx';
import { apiFetch, client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { uploadSignPdf } from '../lib/sign-api.ts';
import type { SignEnvelopeStatus } from '../lib/sign-fields.ts';

const HANDOFF_ELIGIBLE_QUOTE_STATUSES = new Set<QuoteStatus>(['draft', 'sent', 'accepted']);
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

export interface QuoteSignSource {
  id: string;
  number: string | null;
  revision: number;
  status: QuoteStatus;
  expired: boolean;
  dealTitle: string;
  partyName: string;
  updatedAt?: string;
  buyerName?: string | null;
  buyerEmail?: string | null;
}

export interface QuoteSignHandoffProps {
  quote: QuoteSignSource;
  canEdit: boolean;
  envelope?: SignEnvelopeBySourceItem | null;
  envelopeLoading?: boolean;
  signEnabled?: boolean;
  onCreated?: (envelopeId: string) => void;
}

export function signModuleDeployed(): boolean {
  try {
    return getConfig().modules.includes('sign');
  } catch {
    return false;
  }
}

export function useSignAppEnabled(active = true): boolean {
  const deployed = active && signModuleDeployed();
  const orgApps = useQuery({
    ...orpc.org.apps.queryOptions(),
    enabled: deployed,
    retry: false,
  });
  if (!deployed) return false;
  return orgApps.data?.apps.find((app) => app.id === 'sign')?.effective === true;
}

const ACTIVE_ENVELOPE_POLL_MS = 15_000;
const SEALING_ENVELOPE_POLL_MS = 5_000;

export function signEnvelopePollMs(items: readonly SignEnvelopeBySourceItem[] | undefined): number | false {
  if (!items || items.length === 0) return false;
  if (items.some((e) => e.status === 'completed' && (e.sealStatus === null || e.sealStatus === 'pending'))) {
    return SEALING_ENVELOPE_POLL_MS;
  }
  if (items.some((e) => e.status === 'draft' || e.status === 'sent' || e.status === 'in_progress')) {
    return ACTIVE_ENVELOPE_POLL_MS;
  }
  return false;
}

// Draft quotes remain editable via crm.quotes.save under the same quote ID, so a draft modified
// after an eSign envelope's creation timestamp can no longer be treated as matching that envelope.
export function isDraftSignEnvelopeStale(
  quote: Pick<QuoteSignSource, 'status' | 'updatedAt'>,
  envelope: Pick<SignEnvelopeBySourceItem, 'status' | 'createdAt'> | null | undefined,
): boolean {
  if (!envelope || RETRYABLE_ENVELOPE_STATUSES.has(envelope.status)) return false;
  if (quote.status !== 'draft' || !quote.updatedAt) return false;
  const quoteUpdatedMs = Date.parse(quote.updatedAt);
  const envelopeCreatedMs = Date.parse(envelope.createdAt);
  return Number.isFinite(quoteUpdatedMs) && Number.isFinite(envelopeCreatedMs) && quoteUpdatedMs > envelopeCreatedMs;
}

export function canStartQuoteSignHandoff(
  quote: Pick<QuoteSignSource, 'status' | 'expired' | 'updatedAt'>,
  envelope: Pick<SignEnvelopeBySourceItem, 'status' | 'createdAt'> | null | undefined,
): boolean {
  if (!HANDOFF_ELIGIBLE_QUOTE_STATUSES.has(quote.status) || quote.expired === true) {
    return false;
  }
  if (!envelope) return true;
  if (isDraftSignEnvelopeStale(quote, envelope)) return true;
  return RETRYABLE_ENVELOPE_STATUSES.has(envelope.status);
}

async function resolveQuoteBuyer(quote: QuoteSignSource): Promise<{ name: string; email: string | null }> {
  let buyerName = quote.buyerName ?? null;
  let buyerEmail = quote.buyerEmail ?? null;

  if (buyerName === null && buyerEmail === null) {
    const quoteQueryKey = orpc.crm?.quotes?.get?.queryOptions?.({ input: { quoteId: quote.id } })?.queryKey;
    const cached = quoteQueryKey ? queryClient.getQueryData<Quote>(quoteQueryKey) : undefined;
    if (cached?.buyer) {
      buyerName = cached.buyer.name;
      buyerEmail = cached.buyer.email;
    } else if (quote.status !== 'draft') {
      const getQuote = client.crm?.quotes?.get;
      if (typeof getQuote === 'function') {
        const detail = await getQuote({ quoteId: quote.id }).catch(() => null);
        if (detail?.buyer) {
          buyerName = detail.buyer.name;
          buyerEmail = detail.buyer.email;
        }
      }
    }
  }

  const name = (buyerName ?? quote.partyName ?? '').trim().slice(0, 200);
  const rawEmail = buyerEmail?.trim() ?? '';
  const email = rawEmail && zValidEmail.safeParse(rawEmail).success ? rawEmail : null;
  return { name, email };
}

export interface QuoteSignHandoffAttempt {
  envelopeTitle?: string;
  sourceFileId?: string;
  envelopeCreateKey: string;
  envelopeId?: string;
  signerAddKey: string;
  signerAdded?: boolean;
}

export function createQuoteSignHandoffAttempt(): QuoteSignHandoffAttempt {
  return {
    envelopeCreateKey: crypto.randomUUID(),
    signerAddKey: crypto.randomUUID(),
  };
}

export interface QuoteSignHandoffDeps {
  quote: QuoteSignSource;
  slug: string;
  envelopeTitle: string;
  signerRoleLabel: string;
  navigate: (opts: { to: '/o/$slug/sign/envelopes/$id'; params: { slug: string; id: string } }) => unknown;
  attempt?: QuoteSignHandoffAttempt;
  onCreated?: (envelopeId: string) => void;
}

export async function performQuoteSignHandoff({
  quote,
  slug,
  envelopeTitle,
  signerRoleLabel,
  navigate,
  attempt: givenAttempt,
  onCreated,
}: QuoteSignHandoffDeps): Promise<string> {
  const attempt = givenAttempt ?? createQuoteSignHandoffAttempt();
  attempt.envelopeTitle ??= envelopeTitle.trim().slice(0, 300);

  if (!attempt.sourceFileId) {
    const response = await apiFetch(`/api/crm/quotes/${encodeURIComponent(quote.id)}/pdf`);
    const blob = await response.blob();
    const baseLabel = quote.number ? quoteLabel(quote) : `bao-gia-${quote.id.slice(0, 8)}`;
    const filename = `${baseLabel.replace(/[^A-Za-z0-9_.-]+/g, '-')}.pdf`;
    const pdfFile = new File([blob], filename, { type: 'application/pdf' });
    const uploaded = await uploadSignPdf(pdfFile);
    attempt.sourceFileId = uploaded.fileId;
  }

  let attemptedCreateOrSigner = false;
  try {
    if (!attempt.envelopeId) {
      attemptedCreateOrSigner = true;
      const created = await client.sign.envelope.create({
        title: attempt.envelopeTitle,
        sourceKind: 'crm_quote',
        sourceId: quote.id,
        sourceFileId: attempt.sourceFileId,
        idempotencyKey: attempt.envelopeCreateKey,
      });
      attempt.envelopeId = created.envelopeId;
    }

    if (!attempt.signerAdded) {
      attemptedCreateOrSigner = true;
      const buyer = await resolveQuoteBuyer(quote);
      if (buyer.name) {
        await client.sign.signer.add({
          envelopeId: attempt.envelopeId,
          routingOrder: 1,
          signerRole: 'signer',
          roleLabel: signerRoleLabel,
          name: buyer.name,
          ...(buyer.email ? { email: buyer.email } : {}),
          deliveryMode: buyer.email ? 'email' : 'link',
          requireEmailOtp: false,
          idempotencyKey: attempt.signerAddKey,
        });
      }
      attempt.signerAdded = true;
    }
  } finally {
    if (attemptedCreateOrSigner) {
      await queryClient.invalidateQueries({ queryKey: orpc.sign.envelope.by_source.key() });
      await queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] });
      if (attempt.envelopeId) {
        onCreated?.(attempt.envelopeId);
      }
    }
  }

  const envelopeId = attempt.envelopeId;
  if (slug) {
    await navigate({ to: '/o/$slug/sign/envelopes/$id', params: { slug, id: envelopeId } });
  }
  return envelopeId;
}

function QuoteSignHandoffView({
  quote,
  canEdit,
  envelope,
  envelopeLoading,
  onCreated,
}: {
  quote: QuoteSignSource;
  canEdit: boolean;
  envelope: SignEnvelopeBySourceItem | null;
  envelopeLoading: boolean;
  onCreated?: (envelopeId: string) => void;
}) {
  const t = useTranslations('quotes.sign');
  const { slug = '' } = useParams({ strict: false }) as { slug?: string };
  const navigate = useNavigate();
  const stale = isDraftSignEnvelopeStale(quote, envelope);
  const attemptKey = `${quote.id}:${envelope?.envelopeId ?? 'none'}:${quote.updatedAt ?? ''}`;
  const attemptRef = useRef<{ key: string; attempt: QuoteSignHandoffAttempt } | null>(null);

  const handoff = useMutation({
    mutationFn: () => {
      if (attemptRef.current?.key !== attemptKey) {
        attemptRef.current = { key: attemptKey, attempt: createQuoteSignHandoffAttempt() };
      }
      const label = quote.number ? quoteLabel(quote) : quote.dealTitle;
      return performQuoteSignHandoff({
        quote,
        slug,
        envelopeTitle: t('envelopeTitle', { label, party: quote.partyName }),
        signerRoleLabel: t('signerRoleLabel'),
        navigate: (opts) => navigate(opts),
        attempt: attemptRef.current.attempt,
        ...(onCreated ? { onCreated } : {}),
      });
    },
    onSuccess: () => {
      attemptRef.current = null;
    },
  });

  const showButton = canEdit && !envelopeLoading && canStartQuoteSignHandoff(quote, envelope);
  const statusText = envelope ? t(stale ? 'status.stale' : `status.${envelope.status}`) : null;

  return (
    <>
      {envelope && statusText && (
        <Link
          to="/o/$slug/sign/envelopes/$id"
          params={{ slug, id: envelope.envelopeId }}
          aria-label={t('openLabel', { title: envelope.title, status: statusText })}
          className="inline-flex items-center rounded-4xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          data-testid="quote-sign-status"
          data-status={stale ? 'stale' : envelope.status}
        >
          <Badge variant={stale ? 'warning' : SIGN_STATUS_BADGE_VARIANT[envelope.status]}>{statusText}</Badge>
        </Link>
      )}
      {showButton && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={handoff.isPending}
          onClick={() => {
            if (!handoff.isPending) handoff.mutate();
          }}
          data-testid="quote-send-esign"
        >
          {t('send')}
        </Button>
      )}
      {handoff.error && (
        <div className="w-full" data-testid="quote-sign-error">
          <ErrorText>{errorMessage(handoff.error)}</ErrorText>
        </div>
      )}
    </>
  );
}

function QuoteSignHandoffOwn({
  quote,
  canEdit,
  envelopeLoading,
  onCreated,
}: {
  quote: QuoteSignSource;
  canEdit: boolean;
  envelopeLoading?: boolean;
  onCreated?: (envelopeId: string) => void;
}) {
  const ownQuery = useQuery({
    ...orpc.sign.envelope.by_source.queryOptions({
      input: { sourceKind: 'crm_quote', sourceIds: [quote.id] },
    }),
    retry: false,
    refetchInterval: (query) => signEnvelopePollMs(query.state.data?.items),
  });
  const envelope = ownQuery.data?.items.find((item) => item.sourceId === quote.id) ?? null;
  return (
    <QuoteSignHandoffView
      quote={quote}
      canEdit={canEdit}
      envelope={envelope}
      envelopeLoading={envelopeLoading ?? (ownQuery.isPending || ownQuery.isError)}
      {...(onCreated ? { onCreated } : {})}
    />
  );
}

export function QuoteSignHandoff(props: QuoteSignHandoffProps) {
  const orgSignEnabled = useSignAppEnabled(props.signEnabled === undefined);
  const signEnabled = props.signEnabled ?? orgSignEnabled;
  if (!signEnabled) return null;
  if (props.envelope !== undefined) {
    return (
      <QuoteSignHandoffView
        quote={props.quote}
        canEdit={props.canEdit}
        envelope={props.envelope}
        envelopeLoading={props.envelopeLoading ?? false}
        {...(props.onCreated ? { onCreated: props.onCreated } : {})}
      />
    );
  }
  return (
    <QuoteSignHandoffOwn
      quote={props.quote}
      canEdit={props.canEdit}
      {...(props.envelopeLoading !== undefined ? { envelopeLoading: props.envelopeLoading } : {})}
      {...(props.onCreated ? { onCreated: props.onCreated } : {})}
    />
  );
}
