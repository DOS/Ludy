import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useDeferredValue, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useTranslations } from 'use-intl';
import type { z } from 'zod';
import { UNCLASSIFIED_ACCOUNT_CODE, type zPurchaseDocument } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { cn } from '@ludy/ui/lib/utils';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { RecordNotesPanel, notesInstalled } from '../components/notes-panel.tsx';
import { CoworkerAttribution, ProposalSurface } from '../components/proposal-surface.tsx';
import { DataTable, Empty, ErrorText, PageHeader, PeekSheet, TableSkeleton } from '../components/ui.tsx';
import { errorMessage, fetchFile, orpc } from '../lib/api.ts';
import { isZeroAmount } from '../lib/decimal.ts';
import { useFormat } from '../i18n/provider.tsx';
import { useListPeekNav } from '../lib/list-peek-nav.ts';
import { installedModules } from '../lib/org-modules.ts';
import { proposalSource } from '../lib/proposed-by.ts';
import { documentNumber, matchesDocument } from '../lib/search.ts';
import { InvoiceCorrections } from '../components/invoice-corrections.tsx';

type PurchaseDocument = z.infer<typeof zPurchaseDocument>;

function DocumentStatusBadge({ d }: { d: PurchaseDocument }) {
  const t = useTranslations('documents');
  if (d.voided) {
    return (
      <Badge variant="destructive" title={t('voidReason', { reason: d.voided.reason })}>
        {t('status.voided')}
      </Badge>
    );
  }
  if (d.replacesDocumentId) {
    return <Badge variant="secondary">{t('status.rerecorded')}</Badge>;
  }
  return <Badge variant="success">{t('status.recorded')}</Badge>;
}

function DocumentPeekContent({
  doc,
  slug,
  notes,
  fileMeta,
  fileLoading,
  fileQueryError,
  proposal,
  journal,
  exportsList,
  fileError,
}: {
  doc: PurchaseDocument;
  slug: string;
  notes: boolean;
  fileMeta: { id: string; filename: string; contentType: string; version: number | null; createdAt: string; proposalId: string | null } | null;
  fileLoading: boolean;
  fileQueryError?: string | null;
  proposal: {
    id: string;
    requestedByAgent: { name: string } | null;
    requestedByMcp?: { client: string; host: string } | null;
    extraction: { version: number; status: string } | null;
    payload: { lines: Array<{ debitAccount: string; accountRule?: { source: string } | null | undefined }> } | null;
  } | null;
  journal: { id: string; entryDate: string; description: string; lines: Array<{ lineNo: number; accountCode: string; accountName: string; debit: string; credit: string }> } | null;
  exportsList: ReadonlyArray<{ id: string; format: string; at: string; actorName: string | null }>;
  fileError: string | null;
}) {
  const t = useTranslations('documents');
  const ti = useTranslations('inboxDetail');
  const tn = useTranslations('notes');
  const f = useFormat();
  const name = documentNumber(doc);
  const ruleSource = proposal?.payload ? proposalSource(proposal.payload.lines, UNCLASSIFIED_ACCOUNT_CODE) : null;
  const extractionVersion = fileMeta?.version ?? proposal?.extraction?.version ?? null;
  const attributionSource = [
    ruleSource ? `${t('peek.provenanceRule')}: ${ti(`proposedBySource.${ruleSource}`)}` : null,
    extractionVersion !== null ? `${t('peek.extractionVersion')} #${extractionVersion}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="space-y-4">
      {fileError ? <ErrorText>{fileError}</ErrorText> : null}
      <dl className="grid gap-3 rounded-lg border border-border bg-card p-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-subtle-foreground">{t('columns.party')}</dt>
          <dd className="font-medium text-foreground">{doc.partyName}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle-foreground">{t('columns.issueDate')}</dt>
          <dd className="tabular-nums text-foreground">{f.date(doc.issueDate)}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle-foreground">{t('columns.subtotal')}</dt>
          <dd className="tabular-nums text-foreground">{f.money(doc.subtotal)}</dd>
        </div>
        <div>
          <dt className="text-xs text-subtle-foreground">{t('columns.vat')}</dt>
          <dd className="tabular-nums text-foreground">{f.money(doc.vatAmount)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-subtle-foreground">{t('columns.total')}</dt>
          <dd className="font-semibold tabular-nums text-foreground">
            {f.money(doc.total)}
            {doc.foreign && (
              <span className="block text-xs font-normal text-subtle-foreground">
                {t('foreign', { total: f.money(doc.foreign.total, doc.foreign.currency), rate: f.number(doc.foreign.rate) })}
              </span>
            )}
          </dd>
        </div>
      </dl>

      {doc.voided && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t('voidReason', { reason: doc.voided.reason })}
        </p>
      )}

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-muted-foreground">{t('peek.fileSection')}</h3>
        {doc.sourceFileId === null ? (
          <p className="text-xs text-subtle-foreground">{t('peek.noSourceFile')}</p>
        ) : fileLoading ? (
          <TableSkeleton columns={2} rows={2} />
        ) : fileMeta ? (
          <dl className="grid gap-2 rounded-lg border border-border bg-card p-3 text-xs sm:grid-cols-2">
            <div className="sm:col-span-2">
              <dt className="text-subtle-foreground">{t('peek.fileName')}</dt>
              <dd className="font-mono break-all text-foreground">{fileMeta.filename}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">{t('peek.fileType')}</dt>
              <dd className="font-mono text-muted-foreground">{fileMeta.contentType}</dd>
            </div>
            <div>
              <dt className="text-subtle-foreground">{t('peek.uploadedAt')}</dt>
              <dd className="tabular-nums text-muted-foreground">{f.dateTime(fileMeta.createdAt)}</dd>
            </div>
          </dl>
        ) : fileQueryError ? (
          <ErrorText>{fileQueryError}</ErrorText>
        ) : (
          <p className="font-mono text-xs text-subtle-foreground">{doc.sourceFileId}</p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold text-muted-foreground">{t('peek.provenanceSection')}</h3>
        <ProposalSurface proposed={false} className="p-3" data-testid="document-peek-provenance">
          {proposal?.requestedByAgent ? (
            <CoworkerAttribution
              name={proposal.requestedByAgent.name}
              source={attributionSource || t('peek.provenanceAuto')}
            />
          ) : proposal?.requestedByMcp ? (
            <CoworkerAttribution
              name={proposal.requestedByMcp.client}
              role={proposal.requestedByMcp.host}
              source={attributionSource || t('peek.provenanceAuto')}
            />
          ) : fileMeta ? (
            <CoworkerAttribution
              coworker="finance"
              source={attributionSource || t('peek.provenanceAuto')}
            />
          ) : (
            <p className="text-xs text-subtle-foreground">{t('peek.provenanceManual')}</p>
          )}
        </ProposalSurface>
      </section>

      {journal && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">{t('peek.journalSection')}</h3>
          <div className="rounded-lg border border-border bg-card p-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-foreground">{journal.description}</span>
              <span className="tabular-nums text-subtle-foreground">{f.date(journal.entryDate)}</span>
            </div>
            {journal.lines.length > 0 && (
              <ul className="mt-2 space-y-1 border-t pt-2">
                {journal.lines.slice(0, 4).map((line) => (
                  <li key={line.lineNo} className="flex items-center justify-between gap-2 tabular-nums">
                    <span className="truncate text-muted-foreground">
                      <span className="font-mono">{line.accountCode}</span> {line.accountName}
                    </span>
                    <span className="shrink-0 font-mono text-foreground">
                      {!isZeroAmount(line.debit) ? f.money(line.debit) : f.money(line.credit)}
                    </span>
                  </li>
                ))}
                {journal.lines.length > 4 && (
                  <li className="text-subtle-foreground tabular-nums">+{journal.lines.length - 4}</li>
                )}
              </ul>
            )}
          </div>
        </section>
      )}

      {exportsList.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold text-muted-foreground">{t('peek.exportsSection')}</h3>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {exportsList.slice(0, 5).map((exp) => (
              <li key={exp.id} className="flex items-center justify-between gap-2 rounded border border-border px-2.5 py-1.5">
                <span className="font-mono text-foreground">{exp.format}</span>
                <span className="tabular-nums text-subtle-foreground">{f.dateTime(exp.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {notes && (
        <RecordNotesPanel
          slug={slug}
          target={{ targetType: 'finance.purchase_document', targetId: doc.id }}
          headingId={`peek-notes-${doc.id}`}
          label={tn('panel.toggleOf', { name })}
          empty={tn('panel.emptyRecord')}
        />
      )}
    </div>
  );
}

// A document's row and, when opened, its notes below it (#1672): the notes linked to this document and "Thêm ghi chú".
function DocumentRow({
  d,
  slug,
  notes,
  selected,
  onInspect,
  onRowClick,
}: {
  d: PurchaseDocument;
  slug: string;
  notes: boolean;
  selected: boolean;
  onInspect: (id: string, trigger: HTMLElement) => void;
  onRowClick: (id: string, event: MouseEvent<HTMLTableRowElement>) => void;
}) {
  const t = useTranslations('documents');
  const tn = useTranslations('notes');
  const f = useFormat();
  const [notesOpen, setNotesOpen] = useState(false);
  const name = documentNumber(d);
  return (
    <>
      <TableRow
        data-testid="document-row"
        data-peek-row={d.id}
        data-selected={selected ? 'true' : undefined}
        onClick={(event) => onRowClick(d.id, event)}
        className={cn(
          'cursor-pointer',
          d.voided && 'opacity-60',
          selected && 'bg-primary/5 shadow-[inset_2px_0_0_var(--primary)]',
        )}
      >
        <TableCell data-label={t('columns.issueDate')} className="text-muted-foreground tabular-nums">{f.date(d.issueDate)}</TableCell>
        <TableCell data-label={t('columns.number')} className="font-mono text-xs text-foreground">{name}</TableCell>
        <TableCell data-label={t('columns.direction')}>
          <Badge variant={d.direction === 'sale' ? 'secondary' : 'outline'}>{t(d.direction === 'sale' ? 'direction.sale' : 'direction.purchase')}</Badge>
        </TableCell>
        <TableCell data-label={t('columns.party')} className="text-foreground">{d.partyName}</TableCell>
        <TableCell data-label={t('columns.subtotal')} className="text-right text-muted-foreground tabular-nums">{f.money(d.subtotal)}</TableCell>
        <TableCell data-label={t('columns.vat')} className="text-right text-muted-foreground tabular-nums">{f.money(d.vatAmount)}</TableCell>
        <TableCell data-label={t('columns.total')} className="text-right font-medium text-foreground tabular-nums">
          {f.money(d.total)}
          {d.foreign && (
            <span className="block text-xs font-normal text-subtle-foreground">
              {t('foreign', { total: f.money(d.foreign.total, d.foreign.currency), rate: f.number(d.foreign.rate) })}
            </span>
          )}
        </TableCell>
        <TableCell data-label={t('columns.status')}>
          {/* Voided by reversing its entry (#165): Ludy no longer counts it; the supplier's invoice is unchanged. */}
          <DocumentStatusBadge d={d} />
          <InvoiceCorrections corrects={d.corrects} correctedBy={d.correctedBy} />
        </TableCell>
        <TableCell className="text-right">
          <div className="flex flex-wrap justify-end gap-1.5 max-sm:justify-start">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-peek-trigger={d.id}
              data-testid="document-peek-btn"
              aria-label={t('peek.inspectOf', { name })}
              onClick={(event) => onInspect(d.id, event.currentTarget)}
            >
              {t('peek.inspect')}
            </Button>
            {notes && (
              <Button variant="ghost" size="sm" onClick={() => setNotesOpen((o) => !o)} aria-expanded={notesOpen} aria-label={tn('panel.toggleOf', { name })}>
                {tn('panel.title')}
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
      {notesOpen && (
        <TableRow>
          <TableCell colSpan={9} className="py-3">
            <RecordNotesPanel
              slug={slug}
              target={{ targetType: 'finance.purchase_document', targetId: d.id }}
              headingId={`notes-${d.id}`}
              label={tn('panel.toggleOf', { name })}
              empty={tn('panel.emptyRecord')}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function DocumentsPage() {
  const t = useTranslations('documents');
  const common = useTranslations('common');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  // The documents of the entity chosen in the shell (#1280).
  const entity = useChosenEntity();
  const docs = useQuery({ ...orpc.documents.list.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  // A filter over the documents shown, started by ?q= from a link (a document found by the command palette, #673).
  const search: { q?: string } = useSearch({ strict: false });
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => {
    if (search.q !== undefined) setQ(search.q);
  }, [search.q]);
  const term = useDeferredValue(q.trim());
  const shown = term ? docs.data?.filter((d) => matchesDocument(d, term)) : docs.data;
  const visibleDocs = shown ?? [];
  const notes = notesInstalled();
  const tableRef = useRef<HTMLDivElement>(null);
  const peek = useListPeekNav({
    items: visibleDocs,
    getId: (d) => d.id,
    containerRef: tableRef,
    enabled: !docs.isPending && !docs.error && visibleDocs.length > 0,
    resetKey: `${slug}:${entity.legalEntityId ?? ''}`,
  });

  const activeDoc = peek.activeItem;
  const filesBatchSupported = Boolean((orpc as { files?: { batch?: { queryOptions?: unknown } } }).files?.batch?.queryOptions);
  const fileQuery = useQuery({
    ...(filesBatchSupported && activeDoc?.sourceFileId
      ? orpc.files.batch.queryOptions({ input: { ids: [activeDoc.sourceFileId] } })
      : { queryKey: ['files', 'batch', 'noop'], queryFn: async () => [] }),
    enabled: Boolean(peek.open && activeDoc?.sourceFileId && filesBatchSupported),
  });
  const fileMeta = fileQuery.data?.[0] ?? null;

  const inboxGetSupported = Boolean((orpc as { inbox?: { get?: { queryOptions?: unknown } } }).inbox?.get?.queryOptions);
  const proposalQuery = useQuery({
    ...(inboxGetSupported && fileMeta?.proposalId
      ? orpc.inbox.get.queryOptions({ input: { id: fileMeta.proposalId } })
      : { queryKey: ['inbox', 'get', 'noop'], queryFn: async () => null }),
    enabled: Boolean(peek.open && fileMeta?.proposalId && inboxGetSupported),
  });

  const journalGetSupported = Boolean((orpc as { journal?: { get?: { queryOptions?: unknown } } }).journal?.get?.queryOptions);
  const journalQuery = useQuery({
    ...(journalGetSupported && activeDoc?.journalEntryId
      ? orpc.journal.get.queryOptions({ input: { id: activeDoc.journalEntryId } })
      : { queryKey: ['journal', 'get', 'noop'], queryFn: async () => null }),
    enabled: Boolean(peek.open && activeDoc?.journalEntryId && journalGetSupported),
  });

  const exportsSupported = Boolean((orpc as { documents?: { exports?: { queryOptions?: unknown } } }).documents?.exports?.queryOptions);
  const exportsQuery = useQuery({
    ...(exportsSupported && activeDoc
      ? orpc.documents.exports.queryOptions({ input: { documentId: activeDoc.id } })
      : { queryKey: ['documents', 'exports', 'noop'], queryFn: async () => [] }),
    enabled: Boolean(peek.open && activeDoc && exportsSupported && installedModules().includes('finance')),
  });

  const [fileAction, setFileAction] = useState<'open' | 'download' | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileActionReqRef = useRef(0);
  useEffect(() => {
    fileActionReqRef.current += 1;
    setFileAction(null);
    setFileError(null);
  }, [activeDoc?.id, slug, entity.legalEntityId]);

  useEffect(() => {
    return () => {
      fileActionReqRef.current += 1;
    };
  }, []);

  const handleFileAction = async (mode: 'open' | 'download') => {
    const sourceFileId = activeDoc?.sourceFileId;
    if (!sourceFileId || fileAction !== null) return;
    const reqId = fileActionReqRef.current + 1;
    fileActionReqRef.current = reqId;
    const filenameSnap = fileMeta?.filename ?? (documentNumber(activeDoc) || sourceFileId);
    setFileAction(mode);
    setFileError(null);
    try {
      const blob = await fetchFile(sourceFileId);
      if (fileActionReqRef.current !== reqId) return;
      const url = URL.createObjectURL(blob);
      if (mode === 'open') {
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        if (!opened) {
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = filenameSnap;
          document.body.append(anchor);
          anchor.click();
          anchor.remove();
        }
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filenameSnap;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (err) {
      if (fileActionReqRef.current === reqId) setFileError(errorMessage(err));
    } finally {
      if (fileActionReqRef.current === reqId) setFileAction(null);
    }
  };

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {(docs.data?.length ?? 0) > 0 && (
        <div className="mb-4 max-w-sm">
          <Input placeholder={t('search')} aria-label={t('search')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      )}
      {docs.isPending ? (
        <TableSkeleton columns={6} />
      ) : docs.error ? (
        <ErrorText>{errorMessage(docs.error)}</ErrorText>
      ) : (docs.data?.length ?? 0) === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (shown?.length ?? 0) === 0 ? (
        <Empty title={t('noMatch')} />
      ) : (
        <div ref={tableRef} data-testid="documents-list">
          <DataTable
            stacked
            numeric={[4, 5, 6]}
            head={[
              t('columns.issueDate'),
              t('columns.number'),
              t('columns.direction'),
              t('columns.party'),
              t('columns.subtotal'),
              t('columns.vat'),
              t('columns.total'),
              t('columns.status'),
              '',
            ]}
          >
            {visibleDocs.map((d) => (
              <DocumentRow
                key={d.id}
                d={d}
                slug={slug}
                notes={notes}
                selected={peek.selectedId === d.id}
                onInspect={peek.openPeek}
                onRowClick={peek.onRowClick}
              />
            ))}
          </DataTable>
        </div>
      )}

      {activeDoc && (
        <PeekSheet
          open={peek.open}
          onClose={peek.closePeek}
          peekId={peek.peekId}
          data-testid="document-peek-sheet"
          title={documentNumber(activeDoc)}
          description={`${t(activeDoc.direction === 'sale' ? 'direction.sale' : 'direction.purchase')} · ${activeDoc.partyName} · ${f.date(activeDoc.issueDate)}`}
          badges={<DocumentStatusBadge d={activeDoc} />}
          positionLabel={common('peek.position', { index: String(peek.activeIndex + 1), total: String(peek.total) })}
          canPrevious={peek.canPrevious}
          canNext={peek.canNext}
          onPrevious={() => peek.step(-1)}
          onNext={() => peek.step(1)}
          actions={
            <>
              {activeDoc.sourceFileId ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={fileAction === 'open'}
                    disabled={fileAction !== null}
                    onClick={() => void handleFileAction('open')}
                    data-testid="document-peek-open-file"
                  >
                    {t('peek.openFile')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={fileAction === 'download'}
                    disabled={fileAction !== null}
                    onClick={() => void handleFileAction('download')}
                    data-testid="document-peek-download-file"
                  >
                    {t('peek.downloadFile')}
                  </Button>
                </>
              ) : null}
              {fileMeta?.proposalId ? (
                <Link
                  to="/o/$slug/inbox/$id"
                  params={{ slug, id: fileMeta.proposalId }}
                  className={buttonVariants({ size: 'sm', variant: activeDoc.journalEntryId ? 'outline' : 'default' })}
                  data-testid="document-peek-proposal-link"
                >
                  {t('peek.viewProposal')}
                </Link>
              ) : null}
              {activeDoc.journalEntryId ? (
                <Link
                  to="/o/$slug/journal"
                  params={{ slug }}
                  hash={`entry-${activeDoc.journalEntryId}`}
                  className={buttonVariants({ size: 'sm', variant: 'default' })}
                  data-testid="document-peek-journal-link"
                >
                  {t('peek.viewJournal')}
                </Link>
              ) : null}
            </>
          }
        >
          <DocumentPeekContent
            doc={activeDoc}
            slug={slug}
            notes={notes}
            fileMeta={fileMeta}
            fileLoading={fileQuery.isLoading}
            fileQueryError={fileQuery.isError ? errorMessage(fileQuery.error) : null}
            proposal={proposalQuery.data ?? null}
            journal={journalQuery.data ?? null}
            exportsList={exportsQuery.data ?? []}
            fileError={fileError}
          />
        </PeekSheet>
      )}
    </>
  );
}
