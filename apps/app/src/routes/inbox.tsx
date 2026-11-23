import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import { JOURNAL_VOUCHER_KIND } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Label } from '@ludy/ui/components/label';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@ludy/ui/components/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { cn } from '@ludy/ui/lib/utils';
import { UploadEntityPicker, useChosenEntity, useLegalEntity } from '../components/entity-switcher.tsx';
import { AiMeter } from '../components/ai-meter.tsx';
import { InboxActionStrip, InboxFileChip } from '../components/inbox-action-strip.tsx';
import { IntakePanel, useIntake } from '../components/intake.tsx';
import { ProposalBadges } from '../components/proposal-badges.tsx';
import { ProposalDetail } from '../components/proposal-detail.tsx';
import { ProposalGroups } from '../components/proposal-groups.tsx';
import { StepUpPrompt, TwoFactorOffer } from '../components/two-factor.tsx';
import { DataTable, Empty, ErrorText, PageHeader, Spinner, TableSkeleton } from '../components/ui.tsx';
import { client, errorMessage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { listedEntity } from '../lib/legal-entity-choice.ts';
import { cleanGroups } from '../lib/proposal-groups.ts';
import { INBOX_SPLIT_UP, SM_UP, useMediaQuery } from '../lib/media.ts';
import { browserCodec, needsShrink, preparePhotos } from '../lib/photo.ts';
import { useReviewShortcuts } from '../lib/review-shortcuts.ts';
import { getConfig } from '../lib/auth.ts';
import { useFormat } from '../i18n/provider.tsx';
import { REVERSAL_KIND } from '../lib/reversal.ts';
import { toast } from '../lib/toast.ts';
import { VOUCHER_KIND } from '../lib/vouchers.ts';
import {
  INBOX_TABS,
  allSignaturesUnverified,
  bulkExclusion,
  bulkSelectable,
  filesNeedingAttention,
  countUnclassified,
  hasUnclassifiedLines,
  canApproveProposals,
  planBatches,
  proposalName,
  sendBatches,
  steppedIndex,
  type BulkBatch,
  type BulkProgress,
  type InboxSearch,
  type InboxTab,
} from '../lib/review.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { installedModules, useModulesVersion } from '../lib/org-modules.ts';

// What the upload takes, and what a photo of a receipt is taken as.
const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';
const UPLOAD_ACCEPT = `.xml,.pdf,.zip,.xlsx,.csv,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,${PHOTO_ACCEPT}`;

// One bulk approval (issue #315): the batches planned when it started, how far it got, and the names to report.
interface BulkRun {
  batches: BulkBatch[];
  progress: BulkProgress;
  names: Readonly<Record<string, string>>;
  total: number;
  sending: boolean;
  // The approver closed the step-up prompt or the error: the batches not sent stay pending.
  stopped: boolean;
  // The run is a clean group's (#2379): the checkboxes' selection is not the run's and stays as it is.
  group: boolean;
}

// One proposal as the Inbox lists it.
type InboxItem = Awaited<ReturnType<typeof client.inbox.list>>[number];

export function InboxPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const t = useTranslations('inbox');
  const f = useFormat();
  // The tab lives in the address (#1513), left out for the pending proposals.
  const search: InboxSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const tab: InboxTab = search.status ?? 'pending';
  const setTab = (next: InboxTab) => void navigate({ to: '/o/$slug/inbox', params: { slug }, search: next === 'pending' ? {} : { status: next } });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Where focus goes once the two-factor offer is gone (#3599).
  const uploadRef = useRef<HTMLButtonElement>(null);
  // The upload button, unless an upload or a photo is being prepared and it is disabled; then the page's main area, which the shell makes focusable.
  const focusAfterOffer = () => (uploadRef.current && !uploadRef.current.disabled ? uploadRef.current : document.getElementById('main-content'));
  const [preparing, setPreparing] = useState(false);
  const config = getConfig();

  const org = useQuery(orpc.org.get.queryOptions());
  // Polled only while the invalidation stream is down; with it, hints refresh them and a slow poll is the safety net.
  const live = useStreamLive();
  const files = useQuery({
    ...orpc.files.recent.queryOptions(),
    refetchInterval: (query) => pollEvery(live, (query.state.data ?? []).some((f) => f.status === 'processing') ? 2000 : 30_000, SAFETY_POLL_MS),
  });
  const items = useQuery({ ...orpc.inbox.list.queryOptions({ input: { status: tab } }), refetchInterval: pollEvery(live, 5000, SAFETY_POLL_MS) });

  // The "Chưa phân loại" filter (#2091): only the pending proposals with a line no rule matched, with how many there are.
  const [unclassifiedOnly, setUnclassifiedOnly] = useState(false);
  const unclassifiedCount = countUnclassified(items.data ?? []);
  // The filter is Finance's: with Finance off its buttons are gone, so it must not go on hiding the proposals of the other apps.
  const unclassifiedFilter = tab === 'pending' && unclassifiedOnly && installedModules().includes('finance');
  const listed = useMemo(
    () => (unclassifiedFilter ? (items.data ?? []).filter(hasUnclassifiedLines) : (items.data ?? [])),
    [unclassifiedFilter, items.data],
  );

  // Many documents or ZIP archives at once, each file uploaded and followed on its own (#314).
  const intake = useIntake();
  // Reads a file that could not be read again (for example after AI was configured).
  const reextract = useMutation(orpc.files.reextract.mutationOptions({ onSuccess: () => void queryClient.invalidateQueries() }));

  // Opens the one file input as the file picker, or as the phone's rear camera for a receipt (#2384): `capture` is set for
  // the photo and removed for the picker, so the same input, and the same upload below, serve both. A photo is one file
  // at a time; a desktop browser ignores `capture` and opens the picker either way.
  function openPicker(camera: boolean) {
    const input = inputRef.current;
    if (!input) return;
    if (camera) {
      input.setAttribute('capture', 'environment');
      input.accept = PHOTO_ACCEPT;
      input.multiple = false;
    } else {
      input.removeAttribute('capture');
      input.accept = UPLOAD_ACCEPT;
      input.multiple = true;
    }
    input.click();
  }

  // Hands the chosen files to the intake. A photo larger than the direct upload limit is shrunk on the device first, still
  // readable (lib/photo.ts); anything else goes as it is, at once.
  function startFiles(chosen: File[]) {
    if (chosen.length === 0) return;
    if (!chosen.some(needsShrink)) {
      intake.start(chosen);
      return;
    }
    setPreparing(true);
    void preparePhotos(chosen, browserCodec)
      .then((prepared) => intake.start(prepared))
      .finally(() => setPreparing(false));
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    startFiles([...event.dataTransfer.files]);
  }

  const attention = filesNeedingAttention(files.data ?? []);
  const processingFiles = attention.filter((f) => f.status === 'processing');
  const failedFiles = attention.filter((f) => f.status !== 'processing');

  // Bulk approval (issue #315): owners and admins pick pending purchases and approve them under one step-up. The
  // kernel decides each item as if approved alone and reports the ones it refused.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [bulk, setBulk] = useState<BulkRun | null>(null);
  const bulkEnabled = tab === 'pending' && canApproveProposals(org.data?.role, org.data?.permissions);
  const selectable = bulkEnabled ? listed.filter((item) => bulkSelectable(item, REVERSAL_KIND)) : [];
  // Clean purchases grouped by vendor and learned rule (#2379), with the rules behind them of the entity chosen in the shell.
  const shellEntity = useChosenEntity();
  useModulesVersion(); // the apps of the org can change while this screen is open
  const groupsOn = bulkEnabled && installedModules().includes('finance');
  const groups = groupsOn ? cleanGroups(listed, REVERSAL_KIND) : [];
  const groupRules = useQuery({ ...orpc.accountRules.list.queryOptions({ input: { legalEntityId: shellEntity.legalEntityId } }), enabled: groupsOn && groups.length > 0 && shellEntity.ready, staleTime: 30_000 });
  const chosen = selectable.filter((item) => selected.has(item.id));
  const sending = bulk?.sending ?? false;
  // Invoices whose digital signature is unverified (#674): approving them, in bulk as one by one, asks the approver to
  // confirm they checked the original invoice.
  // The confirmation names each unverified invoice and the revision it was given for, so a proposal selected (or read
  // again) after the box was ticked is not covered by it; only the confirmed ones are sent with the confirmation.
  const confirmKey = (item: { id: string; revision: number }) => `${item.id}:${item.revision}`;
  const unverifiedItems = chosen.filter((item) => item.signatureStatus === 'unverified');
  const unverifiedChosen = unverifiedItems.length;
  const [confirmedUnverified, setConfirmedUnverified] = useState<ReadonlySet<string>>(() => new Set());
  const confirmUnverified = unverifiedItems.every((item) => confirmedUnverified.has(confirmKey(item)));

  async function sendBulk(run: BulkRun) {
    setBulk({ ...run, sending: true, stopped: false, progress: { ...run.progress, error: null } });
    const progress = await sendBatches(
      run.batches,
      run.progress,
      (batch) => client.inbox.approveMany({ items: batch.items, idempotencyKey: batch.idempotencyKey }),
      (step) => setBulk((current) => (current ? { ...current, progress: step } : current)),
    );
    setBulk((current) => (current ? { ...current, progress, sending: false } : current));
    if (!progress.error && !run.group) setSelected(new Set());
    await queryClient.invalidateQueries();
  }

  // Approves the chosen proposals, or one clean group (#2379): its proposals have no unverified signature, so there is
  // nothing to confirm, and it runs as any bulk approval does, under one step-up.
  function startBulk(group?: InboxItem[]) {
    const picked = group ?? chosen;
    if (picked.length === 0 || sending || (group === undefined && !confirmUnverified)) return;
    const confirmed = group === undefined ? confirmedUnverified : new Set<string>();
    if (group === undefined) setConfirmedUnverified(new Set());
    void sendBulk({
      batches: planBatches(
        picked.map((item) => ({
          id: item.id,
          revision: item.revision,
          ...(item.signatureStatus === 'unverified' && confirmed.has(confirmKey(item)) ? { acceptUnverifiedSignature: true } : {}),
        })),
      ),
      progress: { results: [], next: 0, error: null },
      names: Object.fromEntries(picked.map((item) => [item.id, proposalName(item)])),
      total: picked.length,
      sending: false,
      stopped: false,
      group: group !== undefined,
    });
  }

  const stopBulk = () => setBulk((current) => (current ? { ...current, stopped: true, progress: { ...current.progress, error: null } } : current));
  const bulkError = bulk && !bulk.sending && !bulk.stopped ? bulk.progress.error : null;
  const bulkFinished = bulk && !bulk.sending && (bulk.stopped || bulk.progress.next === bulk.batches.length);
  const bulkApproved = bulk?.progress.results.filter((r) => r.outcome === 'approved').length ?? 0;
  const bulkRefused = bulk?.progress.results.flatMap((r) => (r.outcome === 'refused' ? [r] : [])) ?? [];
  const bulkNotSent = bulk ? bulk.total - bulk.progress.results.length : 0;

  const wide = useMediaQuery(SM_UP);
  const split = useMediaQuery(INBOX_SPLIT_UP);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const activePreviewId = useMemo(() => {
    if (!split || listed.length === 0) return null;
    if (selectedPreviewId && listed.some((item) => item.id === selectedPreviewId)) {
      return selectedPreviewId;
    }
    return listed[0]?.id ?? null;
  }, [split, listed, selectedPreviewId]);

  // Whose books each proposal goes to (#1543), when the caller sees several entities.
  const books = useLegalEntity(slug);
  const showEntity = books.entities.length > 1;
  const entityOf = (item: InboxItem) =>
    listedEntity(books.entities, item.legalEntityId, item.direction !== null || item.kind === VOUCHER_KIND || item.kind === JOURNAL_VOUCHER_KIND)?.name ?? '';
  // J and K (or N and P) move the focus through the list's proposals; Enter opens the focused one as any link does
  // (DESIGN.md §5.2, #1405). On xl screens, stepping also updates the inline split preview selection (#4520).
  const moveFocus = (step: 1 | -1) => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[data-proposal-link]')];
    const focusedIndex = links.indexOf(document.activeElement as HTMLAnchorElement);
    const currentIndex =
      focusedIndex >= 0
        ? focusedIndex
        : split && activePreviewId
          ? links.findIndex((link) => link.dataset.proposalId === activePreviewId)
          : -1;
    const at = steppedIndex(currentIndex, links.length, step);
    if (at === null) return;
    const link = links[at];
    link?.focus();
    link?.scrollIntoView({ block: 'nearest' });
    const nextId = link?.dataset.proposalId;
    if (split && nextId) setSelectedPreviewId(nextId);
  };
  useReviewShortcuts({ next: () => moveFocus(1), previous: () => moveFocus(-1) });
  // The bulk checkbox of one proposal, for the table and the phone's blocks alike (#1270); its badges are ProposalBadges.
  const selectBox = (item: InboxItem) =>
    bulkSelectable(item, REVERSAL_KIND) ? (
      <Checkbox
        checked={selected.has(item.id)}
        disabled={sending}
        aria-label={t('bulk.select', { name: proposalName(item) })}
        onCheckedChange={(checked) =>
          setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(item.id);
            else next.delete(item.id);
            return next;
          })
        }
      />
    ) : (
      <Checkbox checked={false} disabled aria-label={excludedReason(item) ?? undefined} title={excludedReason(item) ?? undefined} />
    );
  // Why a pending row is left out of the bulk approval (#3598), on the row and in the count above the list.
  function excludedReason(item: InboxItem): string | null {
    if (!bulkEnabled || item.status !== 'pending') return null;
    const why = bulkExclusion(item, REVERSAL_KIND);
    return why === null ? null : t(`bulk.excluded.${why}`);
  }
  const excludedCount = bulkEnabled ? listed.filter((item) => excludedReason(item) !== null).length : 0;
  const allUnverified = allSignaturesUnverified(listed);

  // The browser may refuse the clipboard: say so, and the address stays on screen to select (#1384).
  const copyAddress = (address: string) =>
    void navigator.clipboard.writeText(address).then(
      () => toast(t('addressCopied')),
      () => toast(t('copyRefused'), 'error'),
    );
  const dropTarget = {
    onDragOver: (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop,
  };

  // Show the large 2-card welcome only when the org truly has no files or pending proposals yet; keep it a single
  // compact bar otherwise (including while loading) so the review queue stays above the fold (#4520).
  const showWelcome =
    !files.isPending &&
    !items.isPending &&
    (files.data?.length ?? 0) === 0 &&
    (items.data?.length ?? 0) === 0 &&
    tab === 'pending';

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <UploadEntityPicker slug={slug} />
            <Button ref={uploadRef} loading={intake.uploading || preparing} size="lg" onClick={() => openPicker(false)}>
              {t('upload')}
            </Button>
            {/* On a phone this opens the rear camera; a desktop browser ignores `capture` and opens the file picker. A stack
                of receipts is one photo after another: each is its own file, read and proposed on its own (#2384). */}
            <Button variant="outline" size="lg" loading={preparing} data-testid="capture-button" onClick={() => openPicker(true)}>
              {t('capture')}
            </Button>
          </div>
        }
      />
      <AiMeter module="finance" className="mb-3" />
      {/* Two-factor is offered here, before the first approval needs it, to those who may approve (#3599). */}
      <TwoFactorOffer show={canApproveProposals(org.data?.role, org.data?.permissions)} returnFocus={focusAfterOffer} />
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        accept={UPLOAD_ACCEPT}
        onChange={(e) => {
          startFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />

      {showWelcome ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div
            {...dropTarget}
            className={cn(
              'flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors lg:col-span-2',
              dragging ? 'border-ring bg-primary/10' : 'bg-card',
            )}
          >
            <p className="text-sm font-medium text-foreground">{t('dropHere')}</p>
            <p className="mt-1 text-xs text-subtle-foreground">{config.aiEnabled ? t('formatsAll') : t('formatsXml')}</p>
            <p className="mt-1 text-xs text-subtle-foreground">{t('formatsZip')}</p>
          </div>
          <Card className="block p-4">
            <p className="text-sm font-medium text-muted-foreground">{t('forwardTitle')}</p>
            {org.isLoading ? (
              <div className="mt-3">
                <Spinner />
              </div>
            ) : org.data?.inboundAddress ? (
              <>
                <p className="mt-2 font-mono text-sm break-all text-foreground">{org.data.inboundAddress}</p>
                <Button variant="outline" size="lg" className="mt-3" onClick={() => copyAddress(org.data?.inboundAddress ?? '')}>
                  {t('copyAddress')}
                </Button>
              </>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">{t('noInbound')}</p>
            )}
          </Card>
        </div>
      ) : (
        <div
          {...dropTarget}
          className={cn(
            'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed px-4 py-2.5 transition-colors',
            dragging ? 'border-ring bg-primary/10' : 'bg-card',
          )}
        >
          <div className="min-w-0">
            {/* A phone has nothing to drag from: it keeps the formats and the header's upload button. */}
            <p className="hidden text-sm text-foreground sm:block">{t('dropHereCompact')}</p>
            <p className="text-xs text-subtle-foreground">{config.aiEnabled ? t('formatsAll') : t('formatsXml')}</p>
          </div>
          {org.data?.inboundAddress && (
            <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto">
              <span className="text-xs text-subtle-foreground">{t('forwardTo')}</span>
              <span className="min-w-0 font-mono text-xs break-all text-foreground">{org.data.inboundAddress}</span>
              <Button variant="outline" size="sm" onClick={() => copyAddress(org.data?.inboundAddress ?? '')}>
                {t('copyAddress')}
              </Button>
            </div>
          )}
        </div>
      )}

      <IntakePanel intake={intake} />

      {/* Transient live feedback for files currently being read in background; clears once settled into proposals. */}
      {processingFiles.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-sm font-medium text-muted-foreground">
            {t('recentFiles')}{' '}
            <span className="ml-1 text-link normal-case">· {t('readingCount', { count: processingFiles.length })}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            {processingFiles.slice(0, 8).map((file) => (
              <InboxFileChip key={file.id} file={file} />
            ))}
          </div>
        </div>
      )}

      <InboxActionStrip
        slug={slug}
        tab={tab}
        role={org.data?.role}
        failedFiles={failedFiles}
        onReextract={(fileId) => reextract.mutate({ fileId, idempotencyKey: crypto.randomUUID() })}
        reextractPending={reextract.isPending}
        reextractError={reextract.error}
      />

      <Tabs
        className="mt-4 gap-4"
        value={tab}
        onValueChange={(value) => {
          setTab(value as InboxTab);
          setSelected(new Set());
        }}
      >
        {/* On a narrow screen the tabs scroll inside their row (#1270), as the ledger's do (#615). */}
        <div className="-mb-1 overflow-x-auto pb-1">
          <TabsList variant="line" className="w-max min-w-full justify-start border-b">
            {INBOX_TABS.map((id) => (
              <TabsTrigger key={id} value={id} className="flex-none px-3">
                {t(`tabs.${id}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value={tab}>
          {bulk && isStepUpRequired(bulkError) && (
            <div className="mb-4">
              <StepUpPrompt action={t('bulk.stepUp', { count: bulkNotSent })} onVerified={() => void sendBulk(bulk)} onCancel={stopBulk} />
            </div>
          )}
          {bulk && bulkError !== null && !isStepUpRequired(bulkError) && (
            <div className="mb-4 space-y-2">
              <ErrorText>{errorMessage(bulkError)}</ErrorText>
              <div className="flex gap-2">
                <Button size="lg" onClick={() => void sendBulk(bulk)}>
                  {t('bulk.retry')}
                </Button>
                <Button variant="ghost" size="lg" onClick={stopBulk}>
                  {t('bulk.dismiss')}
                </Button>
              </div>
            </div>
          )}
          {bulk && bulkFinished && (
            <Card className="mb-4 block space-y-2 p-4" role="status">
              {bulkApproved > 0 && <p className="text-sm text-foreground">{t('bulk.approved', { count: bulkApproved })}</p>}
              {bulkRefused.length > 0 && (
                <>
                  <p className="text-sm text-foreground">{t('bulk.refused', { count: bulkRefused.length })}</p>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {bulkRefused.map((r) => (
                      <li key={r.id}>
                        <Link to="/o/$slug/inbox/$id" params={{ slug, id: r.id }} className="text-link hover:underline">
                          {bulk.names[r.id] ?? r.id}
                        </Link>
                        {': '}
                        {errorMessage({ code: r.code, data: r.rule ? { rule: r.rule } : undefined })}
                        {/* A purchase dated in a locked month (#478) is posted in an open month one by one, never in bulk. */}
                        {r.code === 'PERIOD_LOCKED' && ` ${t('bulk.periodLockedHint')}`}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {bulkNotSent > 0 && <p className="text-sm text-warning">{t('bulk.notSent', { count: bulkNotSent })}</p>}
              <Button variant="ghost" size="lg" onClick={() => setBulk(null)}>
                {t('bulk.dismiss')}
              </Button>
            </Card>
          )}
          {groups.length > 0 && !bulk && <ProposalGroups groups={groups} rules={groupRules.data ?? []} slug={slug} sending={sending} onApprove={startBulk} />}
          {bulkEnabled && selectable.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <Label className="font-normal text-muted-foreground">
                <Checkbox
                  checked={chosen.length === selectable.length}
                  indeterminate={chosen.length > 0 && chosen.length < selectable.length}
                  disabled={sending}
                  onCheckedChange={(checked) => setSelected(checked ? new Set(selectable.map((item) => item.id)) : new Set())}
                />
                {t('bulk.selectAll', { count: selectable.length })}
              </Label>
              {chosen.length > 0 && <span className="text-sm text-subtle-foreground">{t('bulk.selected', { count: chosen.length })}</span>}
              {/* The button keeps its label and width while it works, so the batch it is on is said beside it. */}
              {sending && bulk && (
                <span role="status" className="text-sm text-muted-foreground">
                  {t('bulk.sending', { done: Math.min(bulk.progress.next + 1, bulk.batches.length), total: bulk.batches.length })}
                </span>
              )}
              <div className="ml-auto flex gap-2">
                {chosen.length > 0 && !sending && (
                  <Button variant="ghost" size="lg" onClick={() => setSelected(new Set())}>
                    {t('bulk.clear')}
                  </Button>
                )}
                <Button loading={sending} size="lg" disabled={chosen.length === 0 || sending || !confirmUnverified} onClick={() => startBulk()}>
                  {t('bulk.approve', { count: chosen.length })}
                </Button>
              </div>
              {unverifiedChosen > 0 && (
                <Label className="w-full font-normal text-warning">
                  <Checkbox checked={confirmUnverified} disabled={sending} onCheckedChange={(checked) => setConfirmedUnverified(checked === true ? new Set(unverifiedItems.map(confirmKey)) : new Set())} />
                  {t('bulk.confirmUnverified', { count: unverifiedChosen })}
                </Label>
              )}
              <p className="w-full text-xs text-subtle-foreground">{t('bulk.hint')}</p>
            </div>
          )}
          {excludedCount > 0 && <p className="mb-3 text-xs text-subtle-foreground">{t('bulk.excludedSummary', { count: excludedCount })}</p>}
          {allUnverified && (
            <p role="status" className="mb-3 text-sm text-warning">
              {t('signatureAll', { count: listed.length })}
            </p>
          )}
          {tab === 'pending' && installedModules().includes('finance') && (
            <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label={t('filter.label')}>
              <Button variant={unclassifiedOnly ? 'outline' : 'secondary'} size="sm" aria-pressed={!unclassifiedOnly} onClick={() => setUnclassifiedOnly(false)}>
                {t('filter.all', { count: items.data?.length ?? 0 })}
              </Button>
              <Button
                variant={unclassifiedOnly ? 'secondary' : 'outline'}
                size="sm"
                aria-pressed={unclassifiedOnly}
                data-testid="filter-unclassified"
                onClick={() => setUnclassifiedOnly(true)}
              >
                {t('filter.unclassified', { count: unclassifiedCount })}
              </Button>
              {unclassifiedOnly && <span className="text-xs text-subtle-foreground">{t('filter.unclassifiedHint')}</span>}
            </div>
          )}
          {items.isLoading ? (
            <TableSkeleton columns={split ? 2 : 5} />
          ) : listed.length === 0 ? (
            <Empty
              title={unclassifiedFilter ? t('filter.unclassifiedEmpty') : tab === 'pending' ? t('emptyPending') : t('emptyOther')}
              hint={tab === 'pending' && !unclassifiedFilter ? t('emptyPendingHint') : undefined}
              action={
                tab === 'pending' && installedModules().includes('finance') ? (
                  <Link to="/o/$slug/guide" params={{ slug }} className="text-sm text-link hover:underline">
                    {t('guideLink')}
                  </Link>
                ) : undefined
              }
            />
          ) : split ? (
            <div className="grid grid-cols-[minmax(19rem,0.75fr)_minmax(0,1.25fr)] items-start gap-6" data-testid="inbox-split-layout">
              <section
                aria-label={t('queueRegion')}
                data-testid="inbox-split-queue"
                className="sticky top-6 max-h-[calc(100dvh-3rem)] overflow-y-auto"
              >
                <div className="overflow-hidden rounded-xl border bg-card">
                  <Table className="w-full [&_td]:whitespace-normal [&_th]:whitespace-normal">
                    <TableHeader>
                      <TableRow>
                        {bulkEnabled && <TableHead className="w-9 px-3" />}
                        <TableHead className="px-3">{t('columns.document')}</TableHead>
                        <TableHead className="px-3 text-right">{t('columns.total')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {listed.map((item) => {
                        const isSelected = item.id === activePreviewId;
                        return (
                          <TableRow
                            key={item.id}
                            data-selected={isSelected ? 'true' : 'false'}
                            className={cn(isSelected && 'bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]')}
                            onClick={(event) => {
                              if ((event.target as HTMLElement).closest('a, button, input, select, textarea, label, [role="checkbox"]')) {
                                return;
                              }
                              setSelectedPreviewId(item.id);
                            }}
                          >
                            {bulkEnabled && <TableCell className="w-9 px-3 py-3 align-top">{selectBox(item)}</TableCell>}
                            <TableCell className="px-3 py-3 align-top">
                              <Link
                                data-proposal-link
                                data-proposal-id={item.id}
                                to="/o/$slug/inbox/$id"
                                params={{ slug, id: item.id }}
                                className="font-medium text-foreground hover:text-link focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              >
                                {proposalName(item)}
                              </Link>
                              <p className="mt-0.5 text-xs text-subtle-foreground">{item.title}</p>
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {f.date(item.issueDate)}
                                {showEntity && entityOf(item) ? ` · ${entityOf(item)}` : ''}
                              </p>
                              {excludedReason(item) && <p className="mt-0.5 text-xs text-subtle-foreground">{excludedReason(item)}</p>}
                              {item.status === 'expired' && item.expiredAfterDays !== null && (
                                <p className="mt-0.5 text-xs text-warning">{t('expiredReason', { days: item.expiredAfterDays })}</p>
                              )}
                              <div className="mt-1.5">
                                <ProposalBadges item={item} hideSignature={allUnverified} />
                              </div>
                            </TableCell>
                            <TableCell className="px-3 py-3 text-right align-top">
                              <p className="font-medium text-foreground tabular-nums whitespace-nowrap">{f.money(item.total)}</p>
                              <div className="mt-1.5 flex justify-end">
                                <Button
                                  type="button"
                                  variant={isSelected ? 'secondary' : 'ghost'}
                                  size="xs"
                                  data-testid="inbox-preview-select"
                                  aria-pressed={isSelected}
                                  aria-label={t('preview.selectItem', { name: proposalName(item) })}
                                  onClick={() => setSelectedPreviewId(item.id)}
                                >
                                  <NavIcon name="expand" className="size-3.5 -rotate-90" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </section>
              <section aria-label={t('preview.region')} data-testid="inbox-split-preview" className="min-w-0">
                {activePreviewId ? (
                  <ProposalDetail
                    key={activePreviewId}
                    slug={slug}
                    id={activePreviewId}
                    mode="embedded"
                    onDone={(nextId) => setSelectedPreviewId(nextId)}
                    onResubmitted={(proposalId) => {
                      setSelectedPreviewId(proposalId);
                      setTab('pending');
                    }}
                  />
                ) : (
                  <Empty title={t('preview.emptyTitle')} hint={t('preview.emptyBody')} />
                )}
              </section>
            </div>
          ) : wide ? (
            <DataTable
              numeric={[bulkEnabled ? 3 : 2]}
              head={[
                ...(bulkEnabled ? [''] : []),
                t('columns.document'),
                t('columns.issueDate'),
                t('columns.total'),
                ...(showEntity ? [t('columns.entity')] : []),
                t('columns.checks'),
                t('columns.received'),
              ]}
            >
              {listed.map((item) => (
                <TableRow key={item.id}>
                  {bulkEnabled && <TableCell className="w-10 px-4 py-3">{selectBox(item)}</TableCell>}
                  <TableCell className="px-4 py-3">
                    <Link
                      data-proposal-link
                      data-proposal-id={item.id}
                      to="/o/$slug/inbox/$id"
                      params={{ slug, id: item.id }}
                      className="font-medium text-foreground hover:text-link"
                    >
                      {proposalName(item)}
                    </Link>
                    <p className="text-xs text-subtle-foreground">{item.title}</p>
                    {excludedReason(item) && <p className="text-xs text-subtle-foreground">{excludedReason(item)}</p>}
                    {item.status === 'expired' && item.expiredAfterDays !== null && (
                      <p className="text-xs text-warning">{t('expiredReason', { days: item.expiredAfterDays })}</p>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-muted-foreground">{f.date(item.issueDate)}</TableCell>
                  <TableCell className="px-4 py-3 text-right text-foreground tabular-nums">{f.money(item.total)}</TableCell>
                  {showEntity && <TableCell className="px-4 py-3 text-muted-foreground">{entityOf(item)}</TableCell>}
                  <TableCell className="px-4 py-3">
                    <ProposalBadges item={item} hideSignature={allUnverified} />
                  </TableCell>
                  <TableCell className="px-4 py-3 text-xs text-subtle-foreground">{f.dateTime(item.createdAt)}</TableCell>
                </TableRow>
              ))}
            </DataTable>
          ) : (
            <ul className="space-y-2">
              {listed.map((item) => (
                <li key={item.id} className="flex gap-3 rounded-xl border bg-card p-3">
                  {bulkEnabled && <div className="pt-0.5">{selectBox(item)}</div>}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-start justify-between gap-3">
                      <Link
                        data-proposal-link
                        data-proposal-id={item.id}
                        to="/o/$slug/inbox/$id"
                        params={{ slug, id: item.id }}
                        className="min-w-0 font-medium text-foreground hover:text-link"
                      >
                        {proposalName(item)}
                      </Link>
                      <span className="shrink-0 text-right text-foreground tabular-nums">{f.money(item.total)}</span>
                    </div>
                    <p className="text-xs text-subtle-foreground">{item.title}</p>
                    <p className="text-xs text-muted-foreground">{f.date(item.issueDate)}</p>
                    {showEntity && entityOf(item) && <p className="text-xs text-muted-foreground">{entityOf(item)}</p>}
                    {item.status === 'expired' && item.expiredAfterDays !== null && (
                      <p className="text-xs text-warning">{t('expiredReason', { days: item.expiredAfterDays })}</p>
                    )}
                    {excludedReason(item) && <p className="text-xs text-subtle-foreground">{excludedReason(item)}</p>}
                    <ProposalBadges item={item} hideSignature={allUnverified} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {listed.length > 0 && <p className="mt-3 text-xs text-subtle-foreground">{t('listShortcuts')}</p>}
        </TabsContent>
      </Tabs>
    </>
  );
}
