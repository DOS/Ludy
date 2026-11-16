// SPDX-License-Identifier: AGPL-3.0-only
// Browser-carried handoff from an Engage quote to Ludy eSign (#3512, ADR-0050, docs/plan/esign.md Slice 2b).
// Strictly gated on both deployment installation and per-org enablement/entitlement (ADR-0053): when 'sign' is off,
// zero sign.* queries run and no eSign UI controls render. Engage never writes crove_sign tables directly.
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

export function canStartQuoteSignHandoff(
  quote: Pick<QuoteSignSource, 'status' | 'expired'>,
  envelope: Pick<SignEnvelopeBySourceItem, 'status'> | null | undefined,
): boolean {
  if (!HANDOFF_ELIGIBLE_QUOTE_STATUSES.has(quote.status) || quote.expired === true) {
    return false;
  }
  if (!envelope) return true;
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

export interface QuoteSignHandoffDeps {
  quote: QuoteSignSource;
  slug: string;
  envelopeTitle: string;
  signerRoleLabel: string;
  navigate: (opts: { to: '/o/$slug/sign/envelopes/$id'; params: { slug: string; id: string } }) => unknown;
  onCreated?: (envelopeId: string) => void;
}

export async function performQuoteSignHandoff({
  quote,
  slug,
  envelopeTitle,
  signerRoleLabel,
  navigate,
  onCreated,
}: QuoteSignHandoffDeps): Promise<string> {
  const response = await apiFetch(`/api/crm/quotes/${encodeURIComponent(quote.id)}/pdf`);
  const blob = await response.blob();
  const baseLabel = quote.number ? quoteLabel(quote) : `bao-gia-${quote.id.slice(0, 8)}`;
  const filename = `${baseLabel.replace(/[^A-Za-z0-9_.-]+/g, '-')}.pdf`;
  const pdfFile = new File([blob], filename, { type: 'application/pdf' });

  const uploaded = await uploadSignPdf(pdfFile);
  const created = await client.sign.envelope.create({
    title: envelopeTitle.trim().slice(0, 300),
    sourceKind: 'crm_quote',
    sourceId: quote.id,
    sourceFileId: uploaded.fileId,
    idempotencyKey: crypto.randomUUID(),
  });

  try {
    const buyer = await resolveQuoteBuyer(quote);
    if (buyer.name) {
      await client.sign.signer.add({
        envelopeId: created.envelopeId,
        routingOrder: 1,
        signerRole: 'signer',
        roleLabel: signerRoleLabel,
        name: buyer.name,
        ...(buyer.email ? { email: buyer.email } : {}),
        deliveryMode: buyer.email ? 'email' : 'link',
        requireEmailOtp: false,
        idempotencyKey: crypto.randomUUID(),
      });
    }
  } finally {
    await queryClient.invalidateQueries({ queryKey: orpc.sign.envelope.by_source.key() });
    await queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] });
    onCreated?.(created.envelopeId);
  }

  if (slug) {
    await navigate({ to: '/o/$slug/sign/envelopes/$id', params: { slug, id: created.envelopeId } });
  }
  return created.envelopeId;
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

  const handoff = useMutation({
    mutationFn: () => {
      const label = quote.number ? quoteLabel(quote) : quote.dealTitle;
      return performQuoteSignHandoff({
        quote,
        slug,
        envelopeTitle: t('envelopeTitle', { label, party: quote.partyName }),
        signerRoleLabel: t('signerRoleLabel'),
        navigate: (opts) => navigate(opts),
        ...(onCreated ? { onCreated } : {}),
      });
    },
  });

  const showButton = canEdit && !envelopeLoading && canStartQuoteSignHandoff(quote, envelope);
  const statusText = envelope ? t(`status.${envelope.status}`) : null;

  return (
    <>
      {envelope && statusText && (
        <Link
          to="/o/$slug/sign/envelopes/$id"
          params={{ slug, id: envelope.envelopeId }}
          aria-label={t('openLabel', { title: envelope.title, status: statusText })}
          className="inline-flex items-center rounded-4xl focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          data-testid="quote-sign-status"
          data-status={envelope.status}
        >
          <Badge variant={SIGN_STATUS_BADGE_VARIANT[envelope.status]}>{statusText}</Badge>
        </Link>
      )}
      {showButton && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={handoff.isPending}
          onClick={() => handoff.mutate()}
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
  });
  const envelope = ownQuery.data?.items.find((item) => item.sourceId === quote.id) ?? null;
  return (
    <QuoteSignHandoffView
      quote={quote}
      canEdit={canEdit}
      envelope={envelope}
      envelopeLoading={envelopeLoading ?? ownQuery.isPending}
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
