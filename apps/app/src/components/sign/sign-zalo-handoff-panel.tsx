// SPDX-License-Identifier: AGPL-3.0-only
// Zalo OA Engage composer panel on eSign envelope detail (#4720), modeled on meeting-zalo.tsx.
// Strictly hidden when social is off or sourceKind is confidential (hr_contract / meeting_minutes).
// Zero LLM calls, zero paid ZNS templates, and human explicitly reviews and clicks Send inside Inbox.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import type { ConversationDetail } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { useFormat } from '../../i18n/provider.tsx';
import { errorMessage, orpc } from '../../lib/api.ts';
import { installedModules, useModulesVersion } from '../../lib/org-modules.ts';
import { putReplyHandoff } from '../../lib/reply-handoff.ts';
import { signApi, type SignSignerRecord } from '../../lib/sign-api.ts';
import { SIGN_TOKEN_LENGTH, buildSigningUrl } from '../../lib/sign-hash.ts';
import {
  SIGN_ZALO_DRAFT_MAX,
  buildSignZaloDraft,
  buildSignZaloPreviewDraft,
  canOfferSignZaloHandoff,
  getEligibleSignZaloSigners,
  zaloDirectThreadsOf,
} from '../../lib/sign-zalo-handoff.ts';
import { ErrorText } from '../ui.tsx';

const FRESH = { staleTime: 30_000, refetchOnWindowFocus: true } as const;
const WINDOW_POLL_MS = 60_000;

function safeInstalledModules(): string[] {
  try {
    const mods = installedModules();
    return Array.isArray(mods) ? mods : [];
  } catch {
    return [];
  }
}

export interface SignZaloHandoffPanelProps {
  envelope: {
    id: string;
    title: string;
    status: string;
    sourceKind: string;
    sourceId: string | null;
    expiresAt: string | null;
  };
  signers: readonly SignSignerRecord[];
  canManageLinks: boolean;
  mintedLinks: ReadonlyArray<{ signerId: string; url: string }>;
  onMintedLink?: ((signerId: string, url: string) => void) | undefined;
}

export function SignZaloHandoffPanel({
  envelope,
  signers,
  canManageLinks,
  mintedLinks,
  onMintedLink,
}: SignZaloHandoffPanelProps) {
  useModulesVersion();
  const modules = safeInstalledModules();
  const socialOn = modules.includes('social');
  const crmOn = modules.includes('crm');
  const eligible = canOfferSignZaloHandoff({
    sourceKind: envelope.sourceKind,
    status: envelope.status,
    expiresAt: envelope.expiresAt,
    signers,
    canManageLinks,
    socialInstalled: socialOn,
  });

  if (!socialOn || !eligible) {
    return null;
  }

  return (
    <SignZaloHandoffInner
      envelope={envelope}
      signers={signers}
      crmOn={crmOn}
      mintedLinks={mintedLinks}
      onMintedLink={onMintedLink}
    />
  );
}

function SignZaloHandoffInner({
  envelope,
  signers,
  crmOn,
  mintedLinks,
  onMintedLink,
}: {
  envelope: SignZaloHandoffPanelProps['envelope'];
  signers: readonly SignSignerRecord[];
  crmOn: boolean;
  mintedLinks: ReadonlyArray<{ signerId: string; url: string }>;
  onMintedLink?: ((signerId: string, url: string) => void) | undefined;
}) {
  const t = useTranslations('sign.zaloHandoff');
  const tc = useTranslations('conversations');
  const f = useFormat();
  const { slug = '' } = useParams({ strict: false }) as { slug?: string };
  const navigate = useNavigate();

  const eligibleSigners = useMemo(() => getEligibleSignZaloSigners(signers), [signers]);
  const [pickedSignerId, setPickedSignerId] = useState<string | null>(null);
  const [pickedThreadId, setPickedThreadId] = useState<string | null>(null);
  const [localMintedUrls, setLocalMintedUrls] = useState<Record<string, string>>({});
  const [storageFailed, setStorageFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const isQuoteSource = crmOn && envelope.sourceKind === 'crm_quote' && Boolean(envelope.sourceId);
  const isOrderSource = crmOn && envelope.sourceKind === 'crm_order' && Boolean(envelope.sourceId);

  const quoteQuery = useQuery({
    ...orpc.crm.quotes.get.queryOptions({ input: { quoteId: envelope.sourceId ?? '' } }),
    enabled: isQuoteSource,
    retry: false,
  });
  const orderQuery = useQuery({
    ...orpc.crm.salesOrders.get.queryOptions({ input: { orderId: envelope.sourceId ?? '' } }),
    enabled: isOrderSource,
    retry: false,
  });

  const linkedPartyId =
    (isQuoteSource ? quoteQuery.data?.partyId : undefined) ??
    (isOrderSource ? orderQuery.data?.partyId : undefined) ??
    null;

  const crmThreadsQuery = useQuery({
    ...orpc.crm.contacts.conversations.queryOptions({ input: { partyId: linkedPartyId ?? '' } }),
    enabled: crmOn && Boolean(linkedPartyId),
    ...FRESH,
    retry: false,
  });

  const directThreadsQuery = useQuery({
    ...orpc.conversations.list.queryOptions({ input: { kind: 'direct', limit: 100 } }),
    ...FRESH,
    retry: false,
  });

  const threads = useMemo(
    () =>
      zaloDirectThreadsOf({
        linkedLists: [crmThreadsQuery.data],
        recentDirectList: directThreadsQuery.data?.conversations,
      }),
    [crmThreadsQuery.data, directThreadsQuery.data?.conversations],
  );

  const selectedSigner =
    eligibleSigners.find((s) => s.id === pickedSignerId) ??
    eligibleSigners.find((s) => s.deliveryMode === 'link') ??
    eligibleSigners[0] ??
    null;

  const selectedThread = threads.find((th) => th.id === pickedThreadId) ?? threads[0] ?? null;

  const detailQuery = useQuery({
    ...orpc.conversations.get.queryOptions({ input: { conversationId: selectedThread?.id ?? '' } }),
    enabled: Boolean(selectedThread),
    ...FRESH,
    refetchInterval: WINDOW_POLL_MS,
    retry: false,
  });

  const detail = detailQuery.data as ConversationDetail | undefined;
  const detailFailed = Boolean(detailQuery.error);

  if (!selectedSigner) return null;

  const existingMintedUrl =
    mintedLinks.find((item) => item.signerId === selectedSigner.id)?.url ??
    (onMintedLink ? null : (localMintedUrls[selectedSigner.id] ?? null));

  const expiresAtText = envelope.expiresAt ? f.dateTime(envelope.expiresAt) : null;
  const worstCaseSigningUrl = buildSigningUrl('X'.repeat(SIGN_TOKEN_LENGTH));
  const previewDraft = buildSignZaloPreviewDraft({
    envelopeTitle: envelope.title,
    signerName: selectedSigner.name,
    mintedUrl: existingMintedUrl,
    placeholderUrl: t('urlPlaceholder'),
    worstCaseUrl: worstCaseSigningUrl,
    requireEmailOtp: selectedSigner.requireEmailOtp,
    expiresAtText,
  });

  const windowEnd = detail?.conversation.replyWindowUntil ?? selectedThread?.replyWindowUntil ?? null;
  const expired = windowEnd !== null && new Date(windowEnd).getTime() <= Date.now();
  const allowed = Boolean(selectedThread) && detail?.reply.allowed === true && !detailFailed && !expired;
  const blockedReason = detailFailed
    ? 'not_supported'
    : detail
      ? !detail.reply.allowed
        ? (detail.reply.reason ?? 'not_supported')
        : expired
          ? 'window_closed'
          : null
      : expired
        ? 'window_closed'
        : null;

  const canOpen = allowed && previewDraft.fits && !opening;

  const handleOpenInbox = async () => {
    if (!canOpen || !selectedThread) return;
    setOpening(true);
    setActionError(null);
    setStorageFailed(false);
    try {
      let signingUrl = existingMintedUrl;
      if (!signingUrl) {
        const minted = await signApi.createSignerLink(envelope.id, selectedSigner.id);
        signingUrl = buildSigningUrl(minted.token);
        if (onMintedLink) {
          onMintedLink(selectedSigner.id, signingUrl);
        } else {
          setLocalMintedUrls((prev) => ({ ...prev, [selectedSigner.id]: signingUrl! }));
        }
      }

      const finalDraft = buildSignZaloDraft({
        envelopeTitle: envelope.title,
        signerName: selectedSigner.name,
        signingUrl,
        requireEmailOtp: selectedSigner.requireEmailOtp,
        expiresAtText,
      });

      if (!finalDraft.fits) {
        setActionError(t('tooLong'));
        setOpening(false);
        return;
      }

      if (!putReplyHandoff(selectedThread.id, finalDraft.text)) {
        setStorageFailed(true);
        setOpening(false);
        return;
      }

      void navigate({ to: '/o/$slug/social/inbox', params: { slug }, search: { c: selectedThread.id } });
    } catch (err) {
      setActionError(errorMessage(err));
      setOpening(false);
    }
  };

  const formatThreadOption = (thread: (typeof threads)[number]): string => {
    const resolvedContact =
      detail && detail.conversation.id === thread.id
        ? (detail.conversation.contact.partyName ?? detail.conversation.contact.displayName ?? thread.contactName)
        : thread.contactName;
    const base = t('threadOption', {
      name: resolvedContact ?? t('noName'),
      channel: thread.channelName,
    });
    return thread.linkedToContact ? `${base} (${t('linkedBadge')})` : base;
  };

  const listLoading =
    (directThreadsQuery.isLoading && threads.length === 0) ||
    ((isQuoteSource && quoteQuery.isLoading) || (isOrderSource && orderQuery.isLoading)) ||
    (Boolean(linkedPartyId) && crmThreadsQuery.isLoading && threads.length === 0);

  return (
    <Card data-testid="sign-zalo-handoff">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t('title')}</CardTitle>
        <CardDescription className="text-xs">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {listLoading ? (
          <p className="text-xs text-muted-foreground" data-testid="sign-zalo-loading-threads">
            {t('loadingThreads')}
          </p>
        ) : threads.length === 0 ? (
          <p className="rounded-md border border-dashed p-2.5 text-xs text-muted-foreground" data-testid="sign-zalo-empty">
            {directThreadsQuery.error ? t('threadsUnavailable') : t('noThreads')}
          </p>
        ) : (
          <>
            <div className="space-y-1">
              <label htmlFor="sign-zalo-signer" className="text-xs font-medium text-muted-foreground">
                {t('signerLabel')}
              </label>
              <NativeSelect
                id="sign-zalo-signer"
                className="min-h-11 w-full"
                value={selectedSigner.id}
                onChange={(e) => {
                  setPickedSignerId(e.target.value);
                  setActionError(null);
                }}
                data-testid="sign-zalo-signer-select"
              >
                {eligibleSigners.map((signer) => (
                  <NativeSelectOption key={signer.id} value={signer.id}>
                    {signer.roleLabel ? `${signer.name} (${signer.roleLabel})` : signer.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1">
              <label htmlFor="sign-zalo-thread" className="text-xs font-medium text-muted-foreground">
                {t('threadLabel')}
              </label>
              <NativeSelect
                id="sign-zalo-thread"
                className="min-h-11 w-full"
                value={selectedThread?.id ?? ''}
                onChange={(e) => {
                  setPickedThreadId(e.target.value);
                  setActionError(null);
                }}
                data-testid="sign-zalo-thread-select"
              >
                {threads.map((th) => (
                  <NativeSelectOption key={th.id} value={th.id}>
                    {formatThreadOption(th)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1">
              <label htmlFor="sign-zalo-preview" className="text-xs font-medium text-muted-foreground">
                {t('previewLabel')}
              </label>
              <Textarea
                id="sign-zalo-preview"
                readOnly
                rows={Math.min(10, Math.max(5, previewDraft.text.split('\n').length))}
                value={previewDraft.text}
                className="text-xs"
                data-testid="sign-zalo-preview"
              />
              <p className={previewDraft.fits ? 'text-[11px] text-muted-foreground' : 'text-[11px] text-destructive'}>
                {t('count', { count: String(previewDraft.length), max: String(SIGN_ZALO_DRAFT_MAX) })}
              </p>
              {!previewDraft.fits ? <ErrorText>{t('tooLong')}</ErrorText> : null}
            </div>

            {!detail && !detailFailed && !expired ? (
              <p className="text-xs text-muted-foreground" data-testid="sign-zalo-checking-window">
                {t('checkingWindow')}
              </p>
            ) : null}

            {blockedReason !== null ? (
              <p className="text-xs text-foreground" role="status" data-testid="sign-zalo-closed">
                {t('closed', { reason: tc(`replyBlocked.${blockedReason}` as never) })}
              </p>
            ) : null}

            {storageFailed ? <ErrorText>{t('storageFailed')}</ErrorText> : null}
            {actionError ? <ErrorText>{actionError}</ErrorText> : null}

            <p className="text-[11px] text-muted-foreground">{t('sendNote')}</p>

            <Button
              type="button"
              size="sm"
              className="min-h-11 w-full"
              disabled={!canOpen}
              loading={opening}
              onClick={() => void handleOpenInbox()}
              data-testid="sign-zalo-open"
            >
              {t('openButton')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
