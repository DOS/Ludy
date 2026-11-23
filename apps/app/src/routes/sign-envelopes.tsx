// SPDX-License-Identifier: AGPL-3.0-only
// eSign envelopes list route (/o/$slug/sign/envelopes): upload PDF, filter status tabs, copy Zalo link, remind, download (#3325).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { MAX_UPLOAD_BYTES } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { Tabs, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { ContractDrafterDialog } from '../components/sign/contract-drafter-dialog.tsx';
import { ContractVaultBar } from '../components/sign/contract-vault-bar.tsx';
import { VersionDiffDialog } from '../components/sign/version-diff-dialog.tsx';
import { FormDialog } from '../components/form-dialog.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import {
  downloadSignFile,
  signApi,
  uploadSignPdf,
  type SignEnvelopeSummary,
  type SignObligationRenewalListItem,
} from '../lib/sign-api.ts';
import type { SignEnvelopeStatus } from '../lib/sign-fields.ts';
import { buildSigningUrl, copyTextToClipboard } from '../lib/sign-hash.ts';
import { looksLikePdfBytes } from '../lib/sign-pdf.ts';
import { toast } from '../lib/toast.ts';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';

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

export function CreateEnvelopeDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (envelopeId: string) => Promise<void> | void;
}) {
  const t = useTranslations('sign');
  const [title, setTitle] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: async (input: { title: string; file: File }) => {
      const uploaded = await uploadSignPdf(input.file);
      return signApi.createEnvelope({
        title: input.title,
        routingMode: 'parallel',
        sourceFileId: uploaded.fileId,
      });
    },
    onSuccess: async (created) => {
      toast(t('createdToast'));
      await onCreated(created.envelopeId);
    },
    onError: (error) => {
      setFormError(errorMessage(error));
    },
  });

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    setFormError(null);
    const file = event.target.files?.[0] ?? null;
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.type && file.type !== 'application/pdf') {
      setFormError(t('pdfInvalidType'));
      setSelectedFile(null);
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setFormError(t('pdfTooLarge'));
      setSelectedFile(null);
      return;
    }
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (!looksLikePdfBytes(head)) {
      setFormError(t('pdfInvalidType'));
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
    const fallbackTitle = file.name.replace(/\.pdf$/i, '');
    setTitle((prev) => (prev.trim() ? prev : fallbackTitle));
  };

  const handleCreateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createMutation.isPending) return;
    setFormError(null);
    if (!selectedFile) {
      setFormError(t('pdfRequired'));
      return;
    }
    const cleanTitle = title.trim() || selectedFile.name.replace(/\.pdf$/i, '') || selectedFile.name;
    createMutation.mutate({ title: cleanTitle, file: selectedFile });
  };

  return (
    <FormDialog
      testId="sign-create-dialog"
      title={t('createTitle')}
      description={t('createHint')}
      busy={createMutation.isPending}
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
          accept="application/pdf,.pdf"
          autoFocus
          onChange={(e) => void handleFileChange(e)}
          data-testid="sign-upload-pdf-input"
        />
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

export function SignEnvelopesPage() {
  const t = useTranslations('sign');
  const common = useTranslations('common');
  const f = useFormat();
  const navigate = useNavigate();
  const { slug = '' } = useParams({ strict: false }) as { slug?: string };

  const [tab, setTab] = useState<EnvelopeFilterTab>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [drafterOpen, setDrafterOpen] = useState(false);
  const [sharedLinkDialog, setSharedLinkDialog] = useState<{ title: string; url: string } | null>(null);

  const hasMeQuery = Boolean((orpc as { me?: { get?: { queryOptions?: () => unknown } } }).me?.get?.queryOptions);
  const meQuery = useQuery(
    hasMeQuery
      ? orpc.me.get.queryOptions()
      : { queryKey: ['me', 'get', 'noop'], queryFn: async () => null, enabled: false },
  );
  const currentOrgInfo = meQuery.data?.orgs.find((o) => o.slug === slug);
  const defaultPartyAName = currentOrgInfo?.name ?? '';
  const canAskVy = !meQuery.data || Boolean(currentOrgInfo?.role && currentOrgInfo.role !== 'viewer');
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
  ) => {
    const minted = await signApi.createSignerLink(item.id, signerId);
    const url = buildSigningUrl(minted.token);
    if (await copyTextToClipboard(url)) {
      toast(copiedToast);
    } else {
      setSharedLinkDialog({ title: item.title, url });
    }
  };

  const handleCopyZaloLink = async (item: SignEnvelopeSummary) => {
    try {
      const detail = await signApi.getEnvelope(item.id);
      const activeSigners = getDueSigners(detail.signers);
      const dueSigner =
        activeSigners.find((s) => s.deliveryMode === 'link') ?? activeSigners[0];
      if (!dueSigner) {
        toast(t('actions.noActiveSignerToast'));
        return;
      }
      await copyOrShowSignerLink(item, dueSigner.id, t('actions.linkCopiedToast'));
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const handleRemind = async (item: SignEnvelopeSummary) => {
    try {
      const detail = await signApi.getEnvelope(item.id);
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
            await signApi.remindEnvelope(item.id, signer.id);
          }
        }
        toast(t('actions.remindedToast'));
        return;
      }
      const target = dueSigners.find((s) => s.deliveryMode === 'link') ?? dueSigners[0];
      if (!target) {
        toast(t('actions.noActiveSignerToast'));
        return;
      }
      await copyOrShowSignerLink(item, target.id, t('actions.remindUseLinkToast'));
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const handleDownloadSealed = async (item: SignEnvelopeSummary) => {
    try {
      const detail = await signApi.getEnvelope(item.id);
      const fileId = detail.envelope.sealedFileId;
      if (!fileId) return;
      const blob = await downloadSignFile(fileId);
      triggerBlobDownload(blob, `${item.certificateCode ?? item.id}-sealed.pdf`);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  };

  const items = envelopesQuery.data?.items ?? [];
  const filtered = filterEnvelopesByTab(items, tab);
  const renewalItems: readonly SignObligationRenewalListItem[] = renewalsQuery.data?.items ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
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
        }
      />

      <ContractVaultBar key={slug} slug={slug} canAskVy={canAskVy} />

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
                    <TableRow key={item.id}>
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
                          {isSealed ? (
                            <Button type="button" size="sm" variant="outline" onClick={() => void handleDownloadSealed(item)}>
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
                <Button type="button" onClick={() => setCreateOpen(true)}>
                  {t('createButton')}
                </Button>
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
                  return (
                    <TableRow key={item.id}>
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
                          {isActive ? (
                            <>
                              <Button type="button" size="sm" variant="outline" onClick={() => void handleCopyZaloLink(item)}>
                                {t('actions.copyZalo')}
                              </Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => void handleRemind(item)}>
                                {t('actions.remind')}
                              </Button>
                            </>
                          ) : null}
                          {isSealed ? (
                            <Button type="button" size="sm" variant="outline" onClick={() => void handleDownloadSealed(item)}>
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

      {createOpen ? (
        <CreateEnvelopeDialog
          onClose={() => setCreateOpen(false)}
          onCreated={async (envelopeId) => {
            setCreateOpen(false);
            await queryClient.invalidateQueries({ queryKey: ['sign', 'envelopes'] });
            if (slug) {
              await navigate({ to: '/o/$slug/sign/envelopes/$id', params: { slug, id: envelopeId } });
            }
          }}
        />
      ) : null}

      <Dialog open={sharedLinkDialog !== null} onOpenChange={(next) => !next && setSharedLinkDialog(null)}>
        <DialogContent className="sm:max-w-lg" closeLabel={common('close')}>
          <DialogHeader>
            <DialogTitle>{sharedLinkDialog?.title}</DialogTitle>
            <DialogDescription>{t('actions.linkCopiedToast')}</DialogDescription>
          </DialogHeader>
          {sharedLinkDialog ? (
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
            <Button type="button" onClick={() => setSharedLinkDialog(null)}>
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
