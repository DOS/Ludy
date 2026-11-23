import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Menu, MenuChevron, MenuContent, MenuItem, MenuTrigger } from '@ludy/ui/components/menu';
import { DateInput } from '../components/date-input.tsx';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { RecordNotesPanel, notesInstalled } from '../components/notes-panel.tsx';
import { MisaCheckPanel } from '../components/misa-check-panel.tsx';
import { Empty, ErrorText, ListSkeleton, PageHeader } from '../components/ui.tsx';
import { apiFetch, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { useFormat } from '../i18n/provider.tsx';
import { isZeroAmount } from '../lib/decimal.ts';
import { exportQuery } from '../lib/legal-entity-choice.ts';
import { OPENING_BALANCE_SOURCE, canImportOpeningBalance } from '../lib/opening-balance.ts';
import { MAX_REASON_LENGTH, canAskReversal, defaultReversalDate, reversalErrorMessage, reversalFormError } from '../lib/reversal.ts';
import { canEnterVoucher } from '../lib/vouchers.ts';
import { InvoiceCorrections } from '../components/invoice-corrections.tsx';
import { JournalVoucherFormPanel } from './journal-voucher.tsx';
import { YearClosingFormCard } from './year-closing.tsx';

interface Entry {
  id: string;
  entryDate: string;
  sourceType: string;
  document?: { direction: 'purchase' | 'sale'; series: string; number: string; partyName: string } | undefined;
}

// Asks for a reversal (#165): a proposal that an owner or admin approves like any posting (R3, four-eyes, fresh MFA).
function ReversalForm({ entry, slug, onClose }: { entry: Entry; slug: string; onClose: () => void }) {
  const root = useTranslations();
  const locale = useLocale();
  const t = useTranslations('reversal');
  const f = useFormat();
  // An opening entry (#320) is reversed on its own date only; the kernel refuses any other.
  const opening = entry.sourceType === OPENING_BALANCE_SOURCE;
  const [entryDate, setEntryDate] = useState(() => (opening ? entry.entryDate : defaultReversalDate(entry.entryDate)));
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  // One key per form: a retry of the same request returns the same proposal.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  // Refreshes after a refusal too: one for a request already pending (REVERSAL_PENDING) makes the journal show it.
  const request = useMutation(orpc.inbox.request.mutationOptions({ onSettled: () => void queryClient.invalidateQueries() }));
  const problem = reversalFormError({ entryDate, reason }, entry.entryDate, root, f.date);
  // Refused because another request for the entry is pending: its proposal, one click away.
  const refusal = request.error as { code?: unknown; data?: { proposalId?: unknown } } | null;
  const pendingId = refusal?.code === 'REVERSAL_PENDING' && typeof refusal.data?.proposalId === 'string' ? refusal.data.proposalId : null;

  if (request.data) {
    return (
      <Alert className="mt-3">
        <AlertDescription>
          {t('created')}{' '}
          <Link to="/o/$slug/inbox/$id" params={{ slug, id: request.data.proposalId }} className="text-link underline">
            {t('viewProposal')}
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form
      className="mt-3 space-y-3 rounded-lg border bg-muted/40 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (problem) return;
        request.mutate({ command: 'finance.journal.reverse', input: { entryId: entry.id, entryDate, reason: reason.trim() }, idempotencyKey });
      }}
    >
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      {entry.document && (
        <p className="text-sm text-warning">
          {entry.document.direction === 'sale'
            ? t('saleDocumentNote', {
                document: `${entry.document.series ? `${entry.document.series}-` : ''}${entry.document.number}`,
                customer: entry.document.partyName,
              })
            : t('documentNote', {
                document: `${entry.document.series ? `${entry.document.series}-` : ''}${entry.document.number}`,
                vendor: entry.document.partyName,
              })}
        </p>
      )}
      {opening && <p className="text-sm text-muted-foreground">{t('openingNote', { date: f.date(entry.entryDate) })}</p>}
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('date')}</span>
        <DateInput
          required
          min={entry.entryDate}
          {...(opening ? { max: entry.entryDate, readOnly: true } : {})}
          value={entryDate}
          onChange={setEntryDate}
          className="mt-1 w-44"
        />
      </label>
      <label className="block text-xs">
        <span className="text-subtle-foreground">{t('reason')}</span>
        <Input
          required
          maxLength={MAX_REASON_LENGTH}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1"
          placeholder={t('reasonPlaceholder')}
        />
      </label>
      {touched && problem && <ErrorText>{problem}</ErrorText>}
      {request.error && <ErrorText>{reversalErrorMessage(request.error, root, locale)}</ErrorText>}
      {pendingId && (
        <Link to="/o/$slug/inbox/$id" params={{ slug, id: pendingId }} className="block text-sm text-link hover:underline">
          {t('viewProposal')}
        </Link>
      )}
      <div className="flex gap-2">
        <Button loading={request.isPending} type="submit">
          {t('submit')}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose} disabled={request.isPending}>
          {root('common.cancel')}
        </Button>
      </div>
    </form>
  );
}

// An entry's notes (#1672), opened under it: the notes linked to this voucher and "Thêm ghi chú".
function EntryNotes({ entry, slug }: { entry: { id: string; entryDate: string; description: string; voucher?: { code: string } | null | undefined }; slug: string }) {
  const tn = useTranslations('notes');
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const name = entry.voucher?.code ?? `${entry.description} (${f.date(entry.entryDate)})`;
  return (
    <div className="mt-2">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" className="border border-transparent hover:border-border focus-visible:border-ring" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={tn('panel.toggleOf', { name })}>
          {tn('panel.title')}
        </Button>
      </div>
      {open && (
        <RecordNotesPanel
          slug={slug}
          target={{ targetType: 'finance.journal_entry', targetId: entry.id }}
          headingId={`notes-${entry.id}`}
          label={tn('panel.toggleOf', { name })}
          empty={tn('panel.emptyRecord')}
        />
      )}
    </div>
  );
}

export function JournalPage() {
  const t = useTranslations('journal');
  const ob = useTranslations('openingBalance');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  // The range a link opened the journal with (an entry found by the command palette, #673).
  const search: { from?: string; to?: string } = useSearch({ strict: false });
  const [from, setFrom] = useState(search.from ?? '');
  const [to, setTo] = useState(search.to ?? '');
  // A link followed while the journal is open keeps this page: take its range too.
  useEffect(() => {
    if (search.from !== undefined || search.to !== undefined) {
      setFrom(search.from ?? '');
      setTo(search.to ?? '');
    }
  }, [search.from, search.to]);
  const [reversing, setReversing] = useState<string | null>(null);
  // The general journal voucher form (NVK, #888), for owners, admins and members.
  const [entering, setEntering] = useState(false);
  const [closing, setClosing] = useState(false);
  const range = { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  // The journal of the entity chosen in the shell (#1280); the exports follow it.
  const entity = useChosenEntity();
  const journal = useQuery({ ...orpc.journal.list.queryOptions({ input: { ...range, legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const org = useQuery(orpc.org.get.queryOptions());
  const notes = notesInstalled();

  const download = async (path: string, filename: string) => {
    const response = await apiFetch(`${path}?${exportQuery(range, entity.legalEntityId)}`);
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  const exportXlsx = useMutation({
    mutationFn: () => download('/api/export/journal.xlsx', t('exportFile', { org: getCurrentOrg() ?? 'org' })),
  });
  // Purchase vouchers in the MISA SME import template, for firms that keep MISA as their books (#317).
  const exportMisa = useMutation({
    mutationFn: () => download('/api/export/misa/purchases.xlsx', t('exportMisaFile', { org: getCurrentOrg() ?? 'org' })),
  });
  // Purchases of stock (152, 153, 156) in MISA's goods purchase template (#1398); the button above exports the rest.
  const exportMisaGoods = useMutation({
    mutationFn: () => download('/api/export/misa/goods-purchases.xlsx', t('exportMisaGoodsFile', { org: getCurrentOrg() ?? 'org' })),
  });
  // Sales vouchers in MISA's sales template (#313).
  const exportMisaSales = useMutation({
    mutationFn: () => download('/api/export/misa/sales.xlsx', t('exportMisaSalesFile', { org: getCurrentOrg() ?? 'org' })),
  });
  // One error line for the four exports: starting one clears the others' errors, so the line is always about the
  // export just tried.
  const exports = [exportXlsx, exportMisa, exportMisaGoods, exportMisaSales];
  const startExport = (chosen: (typeof exports)[number]) => {
    for (const other of exports) if (other !== chosen) other.reset();
    chosen.mutate();
  };
  const nothingToExport = (journal.data?.length ?? 0) === 0;
  // A link to one entry (#entry-<id>) can arrive before the entries do: scroll once they are shown.
  useEffect(() => {
    const hash = window.location.hash;
    if (journal.data && hash.startsWith('#entry-')) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [journal.data]);

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            {/* One primary action; the exports and the year-end and opening-balance actions sit in two menus (#3601). The exports are hidden once the journal is known to be empty: the empty journal says what fills it, and a range being read again keeps the menu in place. */}
            {!(journal.isSuccess && nothingToExport) && (
              <Menu>
                <MenuTrigger render={<Button size="lg" variant="outline" loading={exports.some((e) => e.isPending)} aria-label={t('exportGroup')} />}>
                  {t('exportMenu')}
                  <MenuChevron />
                </MenuTrigger>
                <MenuContent>
                  <MenuItem onClick={() => startExport(exportXlsx)}>{t('export')}</MenuItem>
                  <MenuItem onClick={() => startExport(exportMisa)}>{t('exportMisa')}</MenuItem>
                  <MenuItem onClick={() => startExport(exportMisaGoods)}>{t('exportMisaGoods')}</MenuItem>
                  <MenuItem onClick={() => startExport(exportMisaSales)}>{t('exportMisaSales')}</MenuItem>
                </MenuContent>
              </Menu>
            )}
            {(canEnterVoucher(org.data?.role) || canImportOpeningBalance(org.data?.role)) && (
              <Menu>
                <MenuTrigger render={<Button size="lg" variant="outline" />}>
                  {t('moreMenu')}
                  <MenuChevron />
                </MenuTrigger>
                <MenuContent>
                  {canEnterVoucher(org.data?.role) && (
                    <MenuItem disabled={closing} onClick={() => setClosing(true)}>
                      {t('yearClosing')}
                    </MenuItem>
                  )}
                  {canImportOpeningBalance(org.data?.role) && (
                    <MenuItem render={<Link to="/o/$slug/journal/opening-balances" params={{ slug }} />}>{ob('open')}</MenuItem>
                  )}
                </MenuContent>
              </Menu>
            )}
            {canEnterVoucher(org.data?.role) && (
              <Button size="lg" onClick={() => setEntering(true)}>
                {t('newJournalVoucher')}
              </Button>
            )}
          </div>
        }
      />
      {entering && <JournalVoucherFormPanel slug={slug} onClose={() => setEntering(false)} />}
      {closing && <YearClosingFormCard slug={slug} onClose={() => setClosing(false)} />}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs">
            <span className="text-subtle-foreground">{t('from')}</span>
            <DateInput value={from} onChange={setFrom} className="mt-1 w-44" />
          </label>
          <label className="text-xs">
            <span className="text-subtle-foreground">{t('to')}</span>
            <DateInput value={to} onChange={setTo} className="mt-1 w-44" />
          </label>
        </div>
      </div>
      <MisaCheckPanel formats={['misa_sme_purchases', 'misa_sme_goods_purchases', 'misa_sme_sales']} from={from} to={to} legalEntityId={entity.legalEntityId} />
      {(exportXlsx.error || exportMisa.error || exportMisaGoods.error || exportMisaSales.error) && (
        <div className="mb-4">
          <ErrorText>{errorMessage(exportXlsx.error ?? exportMisa.error ?? exportMisaGoods.error ?? exportMisaSales.error)}</ErrorText>
        </div>
      )}
      {journal.isPending ? (
        <ListSkeleton />
      ) : journal.error ? (
        <ErrorText>{errorMessage(journal.error)}</ErrorText>
      ) : (journal.data?.length ?? 0) === 0 ? (
        // A date range that matches nothing says so; an empty journal says what fills it (#1256).
        from || to ? (
          <Empty title={t('emptyFiltered')} hint={t('emptyFilteredHint')} />
        ) : (
          <Empty
            title={t('empty')}
            hint={t('emptyHint')}
            action={
              <Link to="/o/$slug/inbox" params={{ slug }} className={buttonVariants({ variant: 'outline' })}>
                {t('openInbox')}
              </Link>
            }
          />
        )
      ) : (
        <div className="space-y-3">
          {journal.data?.map((entry) => (
            <Card key={entry.id} className="block p-4">
              <div id={`entry-${entry.id}`} className="flex scroll-mt-4 flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium text-foreground">{entry.description}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {entry.sourceType === OPENING_BALANCE_SOURCE && <Badge variant="secondary">{ob('badge')}</Badge>}
                  {entry.voucher && <Badge variant="secondary">{entry.voucher.code}</Badge>}
                  {entry.document?.direction === 'sale' && <Badge variant="secondary">{t('saleBadge')}</Badge>}
                  {entry.reverses && <Badge variant="secondary">{t('reversalBadge')}</Badge>}
                  {entry.reversedBy && <Badge variant="warning">{t('reversedBadge')}</Badge>}
                  {entry.pendingReversalId && !entry.reversedBy && <Badge variant="secondary">{t('reversalPendingBadge')}</Badge>}
                  {entry.document?.voided && <Badge variant="destructive">{t('documentVoided')}</Badge>}
                  <p className="text-xs text-subtle-foreground">{f.date(entry.entryDate)}</p>
                </div>
              </div>
              {/* A replacement or an adjustment invoice and the one it corrects (#916). */}
              {entry.document && <InvoiceCorrections corrects={entry.document.corrects} correctedBy={entry.document.correctedBy} />}
              {/* The reversal link both ways (#138); it scrolls to the other entry when it is in the range shown. */}
              {(entry.reverses || entry.reversedBy) && (
                <p className="mt-1 text-xs">
                  {entry.reverses && (
                    <a href={`#entry-${entry.reverses.id}`} className="text-link hover:underline">
                      {t('reversesLink', { date: f.date(entry.reverses.entryDate) })}
                    </a>
                  )}
                  {entry.reversedBy && (
                    <a href={`#entry-${entry.reversedBy.id}`} className="text-link hover:underline">
                      {t('reversedByLink', { date: f.date(entry.reversedBy.entryDate) })}
                    </a>
                  )}
                </p>
              )}
              {/* The lines (#3601): the account on its own line and the Nợ and Có amounts under it on a phone, all three in a row from md up, under a Nợ / Có header. */}
              <div className="mt-2" role="table" aria-label={t('linesOf', { name: entry.description })}>
                <div role="row" className="grid grid-cols-2 gap-x-4 border-b border-border pb-1 text-xs text-subtle-foreground md:grid-cols-[1fr_9rem_9rem]">
                  <span role="columnheader" className="sr-only md:not-sr-only">
                    {t('account')}
                  </span>
                  <span role="columnheader" className="text-right">
                    {t('debit')}
                  </span>
                  <span role="columnheader" className="text-right">
                    {t('credit')}
                  </span>
                </div>
                {entry.lines.map((l) => (
                  <div key={l.lineNo} role="row" className="py-0.5 md:grid md:grid-cols-[1fr_9rem_9rem] md:items-baseline md:gap-x-4">
                    <p role="cell" className="text-sm text-muted-foreground">
                      <span className="font-mono text-foreground">{l.accountCode}</span> {l.accountName}
                    </p>
                    <div className="grid grid-cols-2 gap-x-4 md:contents">
                      <span role="cell" className="text-right text-sm text-foreground tabular-nums">
                        {isZeroAmount(l.debit) ? '' : f.money(l.debit)}
                      </span>
                      <span role="cell" className="text-right text-sm text-foreground tabular-nums">
                        {isZeroAmount(l.credit) ? '' : f.money(l.credit)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              {/* The open form stays until it is closed, so its confirmation (with the proposal link) is still shown once
                  the entry reports the request as pending. */}
              {reversing === entry.id ? (
                <ReversalForm entry={entry} slug={slug} onClose={() => setReversing(null)} />
              ) : (
                <>
                  {/* A reversal waiting for approval (#204, #254): the server refuses another request, so none is
                      offered; the proposal is one click away. */}
                  {entry.pendingReversalId && !entry.reversedBy && (
                    <p className="mt-2 text-right text-xs">
                      <Link to="/o/$slug/inbox/$id" params={{ slug, id: entry.pendingReversalId }} className="text-link hover:underline">
                        {t('reversalPendingLink')}
                      </Link>
                    </p>
                  )}
                  {canAskReversal(entry, org.data?.role) && (
                    <div className="mt-2 flex justify-end">
                      <Button variant="ghost" size="sm" className="border border-transparent hover:border-border focus-visible:border-ring" onClick={() => setReversing(entry.id)}>
                        {t('reverse')}
                      </Button>
                    </div>
                  )}
                </>
              )}
              {notes && <EntryNotes entry={entry} slug={slug} />}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
