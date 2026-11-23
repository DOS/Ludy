// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { FileStatus } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import { useChosenEntity } from './entity-switcher.tsx';
import { LookupOriginalCard } from './lookup-original-card.tsx';
import { StagedMarketplace } from './staged-marketplace.tsx';
import { StagedMarketplaceColumns } from './staged-marketplace-columns.tsx';
import { StagedMarketplaceIncome } from './staged-marketplace-income.tsx';
import { StagedStatements } from './staged-statements.tsx';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { installedModules, useModulesVersion } from '../lib/org-modules.ts';
import type { InboxTab } from '../lib/review.ts';
import { providerName } from '../lib/social.ts';
import { FILE_STATE_VARIANT, fileChipVariant, fileProposal, type FileState } from '../lib/status.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { toast } from '../lib/toast.ts';

export interface ActionStripSummary {
  failedCount: number;
  stagedCount: number;
  bankCount: number;
  originalsCount: number;
  socialCount: number;
  hiddenCount: number;
  totalCount: number;
}

export interface SummarizeActionStripInput {
  failedFilesCount: number;
  failedJobsTotal: number;
  stagedMarketplaceCount: number;
  stagedColumnsCount: number;
  stagedIncomeCount: number;
  stagedStatementsCount: number;
  openBankLinesCount: number;
  originalsTotal: number;
  socialAttentionTotal: number;
  socialMailsCount: number;
  hiddenAppsCount: number;
}

export function summarizeActionStrip(input: SummarizeActionStripInput): ActionStripSummary {
  const failedCount = input.failedFilesCount + input.failedJobsTotal;
  const stagedCount = input.stagedMarketplaceCount + input.stagedColumnsCount + input.stagedIncomeCount + input.stagedStatementsCount;
  const bankCount = input.openBankLinesCount;
  const originalsCount = input.originalsTotal;
  const socialCount = input.socialAttentionTotal + input.socialMailsCount;
  const hiddenCount = input.hiddenAppsCount;
  const totalCount = failedCount + stagedCount + bankCount + originalsCount + socialCount + hiddenCount;
  return { failedCount, stagedCount, bankCount, originalsCount, socialCount, hiddenCount, totalCount };
}

function isFileStatus(status: string): status is FileState {
  return Object.hasOwn(FILE_STATE_VARIANT, status);
}

export function InboxFileChip({
  file,
  onReextract,
  reextractPending,
}: {
  file: FileStatus;
  onReextract?: (fileId: string) => void;
  reextractPending?: boolean;
}) {
  const t = useTranslations('inbox');
  const proposalWords = useTranslations('inboxDetail.status');
  const f = useFormat();
  const proposal = fileProposal(file.status, file.proposalStatus, file.voided);
  const words =
    proposal === 'voided'
      ? t('fileStatus.voided')
      : proposal
        ? proposalWords(proposal)
        : isFileStatus(file.status)
          ? t(`fileStatus.${file.status}`)
          : file.status;

  return (
    <span
      data-testid="recent-file"
      className="inline-flex max-w-full items-center gap-2 rounded-lg border bg-card px-2.5 py-1.5 text-xs"
      title={file.error ?? undefined}
    >
      <span className="max-w-[16rem] truncate text-muted-foreground">{file.filename}</span>
      <Badge variant={isFileStatus(file.status) ? fileChipVariant(file.status, file.proposalStatus, file.voided) : 'secondary'}>
        {words}
      </Badge>
      {file.statement?.decidedBy && (
        <span className="text-subtle-foreground" data-testid="statement-decided-by">
          {t('staged.decidedBy', {
            state: file.statement.state,
            name: file.statement.decidedBy.name ?? t('staged.formerMember'),
            when: f.dateTime(file.statement.decidedBy.at),
          })}
        </span>
      )}
      {onReextract && (file.status === 'failed' || file.voided) && file.canReextract && (
        <Button
          type="button"
          variant="link"
          size="xs"
          loading={Boolean(reextractPending)}
          className="min-h-6 px-1 text-xs"
          onClick={() => onReextract(file.id)}
        >
          {t('reread')}
        </Button>
      )}
    </span>
  );
}

// Bank statement lines with no voucher yet, per bank account (#326, stage 2b).
function OpenBankLines({ slug }: { slug: string }) {
  const t = useTranslations('inbox');
  const f = useFormat();
  const entity = useChosenEntity();
  const open = useQuery({ ...orpc.bank.openLines.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const accounts = (open.data?.accounts ?? []).filter((a) => a.open > 0);
  if (accounts.length === 0) return null;
  return (
    <Card className="block p-4">
      <p className="text-sm font-medium text-foreground">{t('bankLines.title')}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {accounts.map((a) => (
          <li key={a.bankAccount}>
            <Link to="/o/$slug/bank" params={{ slug }} search={{ account: a.bankAccount, month: a.oldest.slice(0, 7) }} className="text-link underline">
              {t('bankLines.account', { account: a.bankAccount, count: a.open, ambiguous: a.ambiguous, date: f.date(a.oldest) })}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

type FailedWork = 'extract' | 'portalList' | 'yearArchive' | 'mail' | 'socialPublish' | 'social' | 'notify' | 'booking' | 'agent' | 'other';
function failedWork(queue: string): FailedWork {
  if (queue === 'finance-file-extract') return 'extract';
  if (queue === 'finance-portal-list') return 'portalList';
  if (queue === 'finance-year-archive') return 'yearArchive';
  if (queue.startsWith('kernel-mail-')) return 'mail';
  if (queue.startsWith('social-publish-')) return 'socialPublish';
  if (queue === 'kernel-notify' || queue === 'kernel-push' || queue === 'social-notify' || queue === 'social-push') return 'notify';
  if (queue.startsWith('social-')) return 'social';
  if (queue.startsWith('crm-booking')) return 'booking';
  if (queue.startsWith('kernel-agent-')) return 'agent';
  return 'other';
}

function HiddenByApps() {
  const t = useTranslations('inbox');
  const live = useStreamLive();
  const hidden = useQuery({ ...orpc.inbox.hidden.queryOptions({ input: {} }), refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
  const count = hidden.data?.count ?? 0;
  if (count === 0) return null;
  return (
    <p data-hidden-apps className="text-sm text-muted-foreground">
      {t('hiddenApps', { count: String(count) })}
    </p>
  );
}

function FailedJobs() {
  const t = useTranslations('inbox.failedJobs');
  const f = useFormat();
  const live = useStreamLive();
  const raised = useQuery({ ...orpc.inbox.raised.queryOptions({ input: {} }), refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
  const dismiss = useMutation(
    orpc.inbox.dismiss.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.inbox.raised.key() }),
      onError: (error) => toast(errorMessage(error), 'error'),
    }),
  );
  const data = raised.data;
  if (!data || data.total === 0) return null;
  return (
    <Card className="block p-4">
      <p className="text-sm font-medium text-foreground">{t('title', { count: data.total })}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t('hint')}</p>
      <ul className="mt-2 divide-y text-sm">
        {data.items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="text-foreground">
                {item.failures > 1
                  ? t('itemRepeated', { work: t(`work.${failedWork(item.queue)}`, { queue: item.queue }), failures: item.failures, count: item.retries + 1 })
                  : t('item', { work: t(`work.${failedWork(item.queue)}`, { queue: item.queue }), count: item.retries + 1 })}
              </p>
              <p className="text-xs text-subtle-foreground">{t('meta', { when: f.dateTime(item.lastAt), job: item.jobId.slice(0, 8) })}</p>
            </div>
            <Button variant="outline" size="sm" loading={dismiss.isPending} onClick={() => dismiss.mutate({ id: item.id })}>
              {t('dismiss')}
            </Button>
          </li>
        ))}
      </ul>
      {data.total > data.items.length && <p className="mt-2 text-xs text-muted-foreground">{t('more', { count: data.total - data.items.length })}</p>}
    </Card>
  );
}

function OriginalsNeeded() {
  const t = useTranslations('inbox.originalNeeded');
  const live = useStreamLive();
  const list = useQuery({ ...orpc.inbox.originals.queryOptions({ input: {} }), refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
  const dismiss = useMutation(
    orpc.inbox.dismissOriginal.mutationOptions({
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: orpc.inbox.originals.key() }),
      onError: (error) => toast(errorMessage(error), 'error'),
    }),
  );
  const data = list.data;
  if (!data || data.total === 0) return null;
  return (
    <section data-testid="originals-needed">
      <h3 className="text-sm font-medium text-foreground">{t('title', { count: data.total })}</h3>
      <p className="mt-1 mb-3 text-xs text-muted-foreground">{t('hint')}</p>
      {data.items.map((item) => (
        <LookupOriginalCard
          key={item.id}
          hints={[{ provider: item.provider, url: item.url, code: item.code }]}
          sellerTaxCode={null}
          onDismiss={() => dismiss.mutate({ id: item.id })}
          dismissing={dismiss.isPending}
        />
      ))}
      {data.total > data.items.length && <p className="text-xs text-muted-foreground">{t('more', { count: data.total - data.items.length })}</p>}
    </section>
  );
}

function SocialAttention({ slug }: { slug: string }) {
  const t = useTranslations('inbox.socialAttention');
  const live = useStreamLive();
  const attention = useQuery({ ...orpc.social.attentionInbox.queryOptions({ input: {} }), refetchInterval: pollEvery(live, 30_000, SAFETY_POLL_MS) });
  const data = attention.data;
  if (!data || data.total === 0) return null;
  const status = (s: string) => (s === 'failed' || s === 'needs_attention' || s === 'paused' ? t(`post.${s}`) : s);
  return (
    <Card className="block p-4">
      <p className="text-sm font-medium text-foreground">{t('title', { count: data.total })}</p>
      <ul className="mt-2 divide-y text-sm">
        {data.channels.map((c) => (
          <li key={c.connectionId} className="py-2">
            <Link to="/o/$slug/social/channels" params={{ slug }} className="block text-foreground hover:underline">
              {t(`channel.${c.status}`, { channel: `${providerName(c.provider)} · ${c.displayName}` })}
            </Link>
          </li>
        ))}
        {data.posts.map((p) => (
          <li key={p.postId} className="py-2">
            <Link to="/o/$slug/social/$id" params={{ slug, id: p.postId }} className="block text-foreground hover:underline">
              {p.excerpt || t('noText')}
            </Link>
            <p className="text-xs text-warning">{p.channels.map((c) => `${providerName(c.provider)} · ${c.displayName}: ${status(c.status)}`).join(', ')}</p>
          </li>
        ))}
      </ul>
      {data.total > data.channels.length + data.posts.length && (
        <Link to="/o/$slug/social" params={{ slug }} className="mt-2 inline-block text-sm text-link underline">
          {t('more', { count: data.total - data.channels.length - data.posts.length })}
        </Link>
      )}
    </Card>
  );
}

function SocialMails({ slug }: { slug: string }) {
  const t = useTranslations('inbox.socialMails');
  const f = useFormat();
  const mails = useQuery(orpc.inbound.recent.queryOptions());
  const items = (mails.data ?? []).filter((m) => m.hasText || m.subject?.trim()).slice(0, 5);
  if (items.length === 0) return null;
  return (
    <Card className="block p-4">
      <p className="text-sm font-medium text-foreground">{t('title')}</p>
      <p className="text-xs text-subtle-foreground">{t('hint')}</p>
      <ul className="mt-2 divide-y text-sm">
        {items.map((m) => (
          <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="truncate text-foreground">{m.subject?.trim() || t('noSubject')}</p>
              <p className="truncate text-xs text-subtle-foreground">{[m.from, f.dateTime(m.receivedAt)].filter(Boolean).join(' · ')}</p>
            </div>
            <Link to="/o/$slug/social/new" params={{ slug }} search={{ mail: m.id }} className="shrink-0 text-sm text-link underline">
              {t('draft')}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export interface InboxActionStripProps {
  slug: string;
  tab: InboxTab;
  role: string | undefined;
  failedFiles: readonly FileStatus[];
  onReextract: (fileId: string) => void;
  reextractPending: boolean;
  reextractError: unknown;
  defaultExpanded?: boolean;
}

// Secondary intake, staged imports, failed jobs, open bank lines, originals needed, and social alerts consolidated
// into one compact collapsible strip so the pending review queue appears immediately above the fold (#4520).
export function InboxActionStrip({
  slug,
  tab,
  role,
  failedFiles,
  onReextract,
  reextractPending,
  reextractError,
  defaultExpanded = false,
}: InboxActionStripProps) {
  const t = useTranslations('inbox');
  const live = useStreamLive();
  useModulesVersion();
  const modules = installedModules();
  const finance = modules.includes('finance');
  const social = modules.includes('social');
  const canAdmin = role === 'owner' || role === 'admin';
  const canDecide = role === 'owner' || role === 'admin' || role === 'member';
  const refetch30 = pollEvery(live, 30_000, SAFETY_POLL_MS);
  const refetch60 = pollEvery(live, 60_000, SAFETY_POLL_MS);
  const entity = useChosenEntity();

  const hidden = useQuery({ ...orpc.inbox.hidden.queryOptions({ input: {} }), enabled: tab === 'pending', refetchInterval: refetch60 });
  const stagedMarketplace = useQuery({ ...orpc.marketplace.staged.queryOptions({ input: {} }), enabled: finance && canDecide, refetchInterval: refetch30 });
  const stagedColumns = useQuery({ ...orpc.marketplace.columnsFiles.queryOptions({ input: {} }), enabled: finance && canDecide, refetchInterval: refetch30 });
  const stagedIncome = useQuery({ ...orpc.marketplace.incomeStaged.queryOptions({ input: {} }), enabled: finance && canDecide, refetchInterval: refetch30 });
  const stagedStatements = useQuery({ ...orpc.files.staged.queryOptions(), enabled: finance, refetchInterval: refetch30 });
  const raised = useQuery({ ...orpc.inbox.raised.queryOptions({ input: {} }), enabled: canAdmin, refetchInterval: refetch60 });
  const originals = useQuery({ ...orpc.inbox.originals.queryOptions({ input: {} }), enabled: finance && canDecide, refetchInterval: refetch60 });
  const bankOpen = useQuery({ ...orpc.bank.openLines.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: finance && entity.ready });
  const socialAttention = useQuery({ ...orpc.social.attentionInbox.queryOptions({ input: {} }), enabled: social, refetchInterval: refetch30 });
  const inboundMails = useQuery({ ...orpc.inbound.recent.queryOptions(), enabled: social && canDecide });

  const stagedStatementsCount = (stagedStatements.data ?? []).filter((file) => file.status === 'staged' && file.statement !== null).length;
  const bankOpenCount = (bankOpen.data?.accounts ?? []).filter((a) => a.open > 0).reduce((sum, a) => sum + a.open, 0);
  const socialMailsCount = (inboundMails.data ?? []).filter((m) => m.hasText || m.subject?.trim()).length;

  const summary = summarizeActionStrip({
    failedFilesCount: failedFiles.length,
    failedJobsTotal: canAdmin ? (raised.data?.total ?? 0) : 0,
    stagedMarketplaceCount: finance && canDecide ? (stagedMarketplace.data?.length ?? 0) : 0,
    stagedColumnsCount: finance && canDecide ? (stagedColumns.data?.length ?? 0) : 0,
    stagedIncomeCount: finance && canDecide ? (stagedIncome.data?.length ?? 0) : 0,
    stagedStatementsCount: finance ? stagedStatementsCount : 0,
    openBankLinesCount: finance ? bankOpenCount : 0,
    originalsTotal: finance && canDecide ? (originals.data?.total ?? 0) : 0,
    socialAttentionTotal: social ? (socialAttention.data?.total ?? 0) : 0,
    socialMailsCount: social && canDecide ? socialMailsCount : 0,
    hiddenAppsCount: tab === 'pending' ? (hidden.data?.count ?? 0) : 0,
  });

  const firstError =
    (tab === 'pending' ? hidden.error : null) ??
    (finance && canDecide ? (stagedMarketplace.error ?? stagedColumns.error ?? stagedIncome.error ?? originals.error) : null) ??
    (finance ? (stagedStatements.error ?? bankOpen.error) : null) ??
    (canAdmin ? raised.error : null) ??
    (social ? socialAttention.error : null) ??
    (social && canDecide ? inboundMails.error : null) ??
    null;

  const [expanded, setExpanded] = useState(defaultExpanded);
  const panelId = useId();

  useEffect(() => {
    if (summary.totalCount === 0 && !firstError) {
      setExpanded(false);
    }
  }, [summary.totalCount, firstError]);

  if (summary.totalCount === 0 && !firstError) return null;

  if (summary.totalCount === 0 && firstError) {
    return (
      <section aria-label={t('actionStrip.region')} className="mt-4" data-testid="inbox-action-strip">
        <ErrorText>{errorMessage(firstError) || t('actionStrip.errorFallback')}</ErrorText>
      </section>
    );
  }

  const failedFileErrors = Array.from(
    new Set(failedFiles.map((file) => file.error).filter((msg): msg is string => Boolean(msg))),
  );

  return (
    <section aria-label={t('actionStrip.region')} className="mt-4" data-testid="inbox-action-strip">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-muted/40 px-3.5 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h2 className="text-sm font-medium text-foreground">{t('actionStrip.title')}</h2>
          <span className="text-xs text-muted-foreground">{t('actionStrip.summary', { count: summary.totalCount })}</span>
          {summary.failedCount > 0 && <Badge variant="destructive">{t('actionStrip.failedBadge', { count: summary.failedCount })}</Badge>}
          {summary.stagedCount > 0 && <Badge variant="warning">{t('actionStrip.stagedBadge', { count: summary.stagedCount })}</Badge>}
          {summary.bankCount > 0 && <Badge variant="secondary">{t('actionStrip.bankBadge', { count: summary.bankCount })}</Badge>}
          {summary.originalsCount > 0 && <Badge variant="secondary">{t('actionStrip.originalsBadge', { count: summary.originalsCount })}</Badge>}
          {summary.socialCount > 0 && <Badge variant="secondary">{t('actionStrip.socialBadge', { count: summary.socialCount })}</Badge>}
          {summary.hiddenCount > 0 && <Badge variant="outline">{t('actionStrip.hiddenBadge', { count: summary.hiddenCount })}</Badge>}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={expanded}
          aria-controls={panelId}
          data-testid="inbox-action-strip-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          <span>{expanded ? t('actionStrip.collapse') : t('actionStrip.expand')}</span>
          <NavIcon name="expand" className={cn('transition-transform', expanded && 'rotate-180')} />
        </Button>
      </div>
      {firstError && (
        <div className="mt-2">
          <ErrorText>{errorMessage(firstError) || t('actionStrip.errorFallback')}</ErrorText>
        </div>
      )}
      {!expanded && failedFileErrors.length > 0 && (
        <p className="mt-2 truncate px-1 text-xs text-destructive" role="status">
          {failedFileErrors[0]}
          {failedFileErrors.length > 1 ? ` (+${failedFileErrors.length - 1})` : ''}
        </p>
      )}
      {expanded && (
        <div id={panelId} data-testid="inbox-action-strip-content" className="mt-3 space-y-4 [&>*]:!mt-0">
          {tab === 'pending' && <HiddenByApps />}
          {failedFiles.length > 0 && (
            <Card className="block p-4" data-testid="failed-files-card">
              <p className="mb-2 text-sm font-medium text-foreground">{t('actionStrip.failedFilesTitle')}</p>
              <div className="flex flex-wrap gap-2">
                {failedFiles.slice(0, 8).map((file) => (
                  <InboxFileChip
                    key={file.id}
                    file={file}
                    onReextract={onReextract}
                    reextractPending={reextractPending}
                  />
                ))}
              </div>
              {reextractError ? <p className="mt-2 text-xs text-destructive">{errorMessage(reextractError)}</p> : null}
              {failedFileErrors.map((msg) => (
                <p key={msg} className="mt-2 text-xs text-destructive">
                  {msg}
                </p>
              ))}
            </Card>
          )}
          {finance && <StagedMarketplace canDecide={canDecide} refetchMs={refetch30} />}
          {finance && <StagedMarketplaceColumns canDecide={canDecide} canSave={canAdmin} refetchMs={refetch30} />}
          {finance && <StagedMarketplaceIncome canDecide={canDecide} refetchMs={refetch30} />}
          {finance && <StagedStatements canDecide={canDecide} refetchMs={refetch30} />}
          {canAdmin && <FailedJobs />}
          {finance && canDecide && <OriginalsNeeded />}
          {finance && <OpenBankLines slug={slug} />}
          {social && <SocialAttention slug={slug} />}
          {social && canDecide && <SocialMails slug={slug} />}
        </div>
      )}
    </section>
  );
}
