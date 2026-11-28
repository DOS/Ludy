// SPDX-License-Identifier: AGPL-3.0-only
// Importing contacts from a CSV (#2229, docs/plan/crm.md step K5), in four steps: choose the file (read here in the browser
// and never stored), map its columns, read the preview of what would be new, duplicate, in conflict or invalid, and import.
// Nothing is written to the contacts before the last button. The file's rows that were not imported can be downloaded again.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams, useRouter } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  IMPORT_MAX_ROWS,
  IMPORT_PREVIEW_PAGE,
  IMPORT_TAX_LOOKUP_MAX_ROWS,
  type ImportCommitted,
  type ImportCompanyState,
  type ImportOnDuplicate,
  type ImportOutcome,
  type ImportPreview,
  type ImportReason,
  type ImportTaxLookupItem,
  type ImportTaxLookupResult,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { NativeSelect } from '@ludy/ui/components/native-select';
import { Tabs, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { DataTable, ErrorText, Field, PageHeader, Spinner } from '../components/ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { IMPORT_FIELDS, IMPORT_MAX_BYTES, guessMapping, mappedRows, parseContactCsv, rejectsCsv, sheetToTable, type ImportField, type ParsedCsv } from '../lib/contact-csv.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';
import { XlsxError, readFirstSheet, writeWorkbook } from '../lib/xlsx.ts';

type Step = 'choose' | 'map' | 'preview' | 'done';
const OUTCOMES: readonly (ImportOutcome | 'all')[] = ['all', 'new', 'duplicate', 'conflict', 'invalid'];

interface FillSuggestionRowInput {
  rowNo: number;
  name?: string | null;
  address?: string | null;
}

function errorCodeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

function download(name: string, content: BlobPart, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// A sample workbook: the columns the import knows and one made-up row, phone and tax code as text so they keep their zero.
function templateBook(label: (field: ImportField) => string, sample: { sheet: string; example: string; email: string; phone: string; address: string }): Uint8Array {
  const row: Record<ImportField, string> = { name: sample.example, kind: '', taxCode: '', email: sample.email, phone: sample.phone, address: sample.address, company: '' };
  return writeWorkbook([
    {
      name: sample.sheet,
      widths: [28, 22, 18, 28, 18, 36, 28],
      headerRows: 1,
      textColumns: [IMPORT_FIELDS.indexOf('taxCode'), IMPORT_FIELDS.indexOf('phone')],
      rows: [IMPORT_FIELDS.map(label), IMPORT_FIELDS.map((f) => row[f])],
    },
  ]);
}

// Back to the screen the import was opened from, People or Companies (#3650); the People list when the page was opened with no screen behind it (a link, a new tab).
function BackLink({ slug, label }: { slug: string; label: string }) {
  const router = useRouter();
  const cameFromApp = typeof window !== 'undefined' && ((window.history.state as { __TSR_index?: number } | null)?.__TSR_index ?? 0) > 0;
  if (!cameFromApp) {
    return (
      <Link to="/o/$slug/contacts" params={{ slug }} className={`text-link underline ${PHONE_TARGET}`}>
        {label}
      </Link>
    );
  }
  return (
    <Button type="button" variant="link" className="h-auto p-0 max-md:min-h-11" onClick={() => router.history.back()}>
      {label}
    </Button>
  );
}

export interface ContactImportPreviewProps {
  staged: ImportPreview;
  rows: ImportPreview['rows'];
  outcome: ImportOutcome | 'all';
  onOutcomeChange: (next: ImportOutcome | 'all') => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onDuplicate: ImportOnDuplicate;
  onDuplicateChange: (next: ImportOnDuplicate) => void;
  createCompanies: boolean;
  onCreateCompaniesChange: (next: boolean) => void;
  newCompanyNames: readonly string[];
  onCommit: () => void;
  commitPending: boolean;
  onCancel: () => void;
  cancelPending: boolean;
  actionError: unknown;
  deploymentTaxLookup: boolean;
  taxLookupState: {
    isPending: boolean;
    data: ImportTaxLookupResult | undefined;
    error: unknown;
    onRetry: () => void;
  };
  acceptedRowNos: ReadonlySet<number>;
  fillPendingRowNo: number | 'batch' | null;
  fillError: unknown;
  onAcceptRow: (item: FillSuggestionRowInput) => void;
  onAcceptAll: (items: FillSuggestionRowInput[]) => void;
}

export function ContactImportPreview({
  staged,
  rows,
  outcome,
  onOutcomeChange,
  hasMore,
  loadingMore,
  onLoadMore,
  onDuplicate,
  onDuplicateChange,
  createCompanies,
  onCreateCompaniesChange,
  newCompanyNames,
  onCommit,
  commitPending,
  onCancel,
  cancelPending,
  actionError,
  deploymentTaxLookup,
  taxLookupState,
  acceptedRowNos,
  fillPendingRowNo,
  fillError,
  onAcceptRow,
  onAcceptAll,
}: ContactImportPreviewProps) {
  const t = useTranslations('contactImport');
  const counts = staged.batch;
  const reasonText = (reason: ImportReason | null) => (reason ? t(`reason.${reason}`) : '');
  // What the preview promises about a row's company: only a new row is imported by default, a duplicate takes a company only when the person chooses to
  // fill in what it lacks, and a conflict or an invalid row takes none.
  const companyText = (r: ImportPreview['rows'][number]): string | null => {
    const company = r.company;
    if (!company || r.outcome === 'invalid' || r.outcome === 'conflict') return null;
    if (r.outcome === 'duplicate') return company.state === 'matched' && company.match ? t('company.duplicateMatched', { name: company.match.name }) : null;
    if (r.kind === 'organization') return t('company.ofCompany');
    if (company.state === 'matched') return company.match ? t('company.matched', { name: company.match.name }) : t('company.gone');
    return t(`company.${company.state as Exclude<ImportCompanyState, 'matched'>}`);
  };

  const taxErrorCode = errorCodeOf(taxLookupState.error);
  const lookupOffForDeployment = !deploymentTaxLookup || taxErrorCode === 'TAX_LOOKUP_DISABLED';
  const lookupOrgDisabled = deploymentTaxLookup && taxErrorCode === 'TAX_LOOKUP_ORG_DISABLED';
  const lookupUnavailable = deploymentTaxLookup && Boolean(taxLookupState.error) && !lookupOffForDeployment && !lookupOrgDisabled;
  const lookupItems: readonly ImportTaxLookupItem[] = lookupOffForDeployment || lookupOrgDisabled ? [] : (taxLookupState.data?.items ?? []);
  const showTaxLookupColumn = !lookupOffForDeployment && !lookupOrgDisabled && lookupItems.length > 0;

  const lookupByRow = new Map<number, ImportTaxLookupItem>(lookupItems.map((item) => [item.rowNo, item]));
  const loadedByRow = new Map(rows.map((r) => [r.rowNo, r]));

  const actionableBatch: FillSuggestionRowInput[] = [];
  for (const item of lookupItems) {
    if (item.status !== 'suggested' || acceptedRowNos.has(item.rowNo)) continue;
    const loaded = loadedByRow.get(item.rowNo);
    const fillName = loaded ? (loaded.name.trim() === '' ? item.suggestedName : null) : item.suggestedName;
    const fillAddress = loaded ? ((loaded.address ?? '').trim() === '' ? item.suggestedAddress : null) : item.suggestedAddress;
    if (fillName || fillAddress) {
      actionableBatch.push({
        rowNo: item.rowNo,
        ...(fillName ? { name: fillName } : {}),
        ...(fillAddress ? { address: fillAddress } : {}),
      });
    }
    if (actionableBatch.length >= IMPORT_TAX_LOOKUP_MAX_ROWS) break;
  }

  const notLookedUpCount = lookupItems.filter((item) => item.status === 'not_looked_up').length;
  const stopReason = taxLookupState.data?.stopReason ?? null;

  const head = showTaxLookupColumn
    ? [t('preview.row'), t('field.name'), t('field.company'), t('field.taxCode'), t('field.address'), t('field.email'), t('field.phone'), t('preview.result'), t('preview.taxLookup.column')]
    : [t('preview.row'), t('field.name'), t('field.company'), t('field.taxCode'), t('field.email'), t('field.phone'), t('preview.result')];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('preview.hint')}</p>
      <ul className="flex flex-wrap gap-2 text-sm" aria-label={t('preview.counts')}>
        <li><Badge variant="success">{t('preview.new', { count: String(counts.newRows) })}</Badge></li>
        <li><Badge variant="outline">{t('preview.duplicate', { count: String(counts.duplicateRows) })}</Badge></li>
        <li><Badge variant="outline">{t('preview.conflict', { count: String(counts.conflictRows) })}</Badge></li>
        <li><Badge variant="outline">{t('preview.invalid', { count: String(counts.invalidRows) })}</Badge></li>
      </ul>

      {!lookupOffForDeployment && taxLookupState.isPending && (
        <div role="status" className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <Spinner className="size-4 shrink-0" />
          <span>{t('preview.taxLookup.loading')}</span>
        </div>
      )}

      {lookupOrgDisabled && (
        <div role="status" className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {t('preview.taxLookup.orgDisabled')}
        </div>
      )}

      {lookupUnavailable && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          <span>{t('preview.taxLookup.unavailable')}</span>
          <Button type="button" size="sm" variant="outline" className="max-md:min-h-11" onClick={taxLookupState.onRetry}>
            {t('preview.taxLookup.retry')}
          </Button>
        </div>
      )}

      {showTaxLookupColumn && (actionableBatch.length > 0 || notLookedUpCount > 0 || taxLookupState.data?.quotaWarning) && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm" data-testid="tax-lookup-summary">
          <div className="min-w-0 space-y-1">
            {actionableBatch.length > 0 && (
              <p className="font-medium text-foreground">{t('preview.taxLookup.summary', { count: String(actionableBatch.length) })}</p>
            )}
            {notLookedUpCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {stopReason === 'rate_limit'
                  ? t('preview.taxLookup.rateLimitSummary', { count: String(notLookedUpCount) })
                  : stopReason === 'unavailable'
                    ? t('preview.taxLookup.unavailableSummary', { count: String(notLookedUpCount) })
                    : t('preview.taxLookup.waitingSummary', { count: String(notLookedUpCount), max: String(IMPORT_TAX_LOOKUP_MAX_ROWS) })}
              </p>
            )}
            {taxLookupState.data?.quotaWarning && (
              <p className="text-xs text-muted-foreground">{t('preview.taxLookup.quotaWarning')}</p>
            )}
          </div>
          {actionableBatch.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="shrink-0 max-md:min-h-11"
              loading={fillPendingRowNo === 'batch'}
              disabled={fillPendingRowNo !== null}
              onClick={() => onAcceptAll(actionableBatch)}
            >
              {t('preview.taxLookup.fillAll')}
            </Button>
          )}
        </div>
      )}

      <Tabs value={outcome} onValueChange={(v) => onOutcomeChange(v as ImportOutcome | 'all')}>
        <TabsList aria-label={t('preview.filter')} className="max-w-full flex-wrap">
          {OUTCOMES.map((o) => (
            <TabsTrigger key={o} value={o}>
              {t(`outcome.${o}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <DataTable head={head} stacked>
        {rows.map((r) => {
          const lookupItem = showTaxLookupColumn ? lookupByRow.get(r.rowNo) : undefined;
          const isAccepted = acceptedRowNos.has(r.rowNo);
          const fillName =
            lookupItem && lookupItem.status === 'suggested' && !isAccepted && r.name.trim() === ''
              ? lookupItem.suggestedName
              : null;
          const fillAddress =
            lookupItem && lookupItem.status === 'suggested' && !isAccepted && (r.address ?? '').trim() === ''
              ? lookupItem.suggestedAddress
              : null;
          const canAcceptRow = Boolean(fillName || fillAddress);

          return (
            <TableRow key={r.rowNo} data-testid="import-row">
              <TableCell data-label={t('preview.row')} className="text-sm tabular-nums">{r.rowNo}</TableCell>
              <TableCell data-label={t('field.name')} className="text-sm">
                {r.name}
                <p className="text-xs text-muted-foreground">{t(`preview.kindOf.${r.kind}`)}</p>
              </TableCell>
              <TableCell data-label={t('field.company')} className="text-sm" data-testid="import-company">
                {r.company && (
                  <>
                    {r.company.name}
                    {companyText(r) && <p className="text-xs text-muted-foreground">{companyText(r)}</p>}
                  </>
                )}
              </TableCell>
              <TableCell data-label={t('field.taxCode')} className="text-sm">{r.taxCode}</TableCell>
              {showTaxLookupColumn && (
                <TableCell data-label={t('field.address')} className="text-sm">{r.address}</TableCell>
              )}
              <TableCell data-label={t('field.email')} className="text-sm">{r.email}</TableCell>
              <TableCell data-label={t('field.phone')} className="text-sm">{r.phone}</TableCell>
              <TableCell data-label={t('preview.result')} className="text-sm">
                <Badge variant={r.outcome === 'new' ? 'success' : 'outline'}>{t(`outcome.${r.outcome}`)}</Badge>
                {r.reason && <p className="text-xs text-muted-foreground">{reasonText(r.reason)}</p>}
                {r.match && <p className="text-xs text-muted-foreground">{t('preview.matches', { name: r.match.name })}</p>}
              </TableCell>
              {showTaxLookupColumn && (
                <TableCell data-label={t('preview.taxLookup.column')} className="text-sm" data-testid="import-tax-suggestion">
                  {lookupItem ? (
                    lookupItem.status === 'not_looked_up' ? (
                      <Badge variant="outline">{t('preview.taxLookup.notLookedUp')}</Badge>
                    ) : lookupItem.status === 'not_found' ? (
                      <span className="text-xs text-muted-foreground">{t('preview.taxLookup.notFound')}</span>
                    ) : lookupItem.status === 'no_fill' ? (
                      <span className="text-xs text-muted-foreground">{t('preview.taxLookup.noFill')}</span>
                    ) : canAcceptRow ? (
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-foreground">{t('preview.taxLookup.suggestionTitle')}</p>
                        {fillName && (
                          <p className="text-xs text-muted-foreground">
                            <span>{`${t('field.name')}: `}</span>
                            <span className="text-foreground">{fillName}</span>
                          </p>
                        )}
                        {fillAddress && (
                          <p className="text-xs text-muted-foreground">
                            <span>{`${t('field.address')}: `}</span>
                            <span className="text-foreground">{fillAddress}</span>
                          </p>
                        )}
                        {lookupItem.statusText && (
                          <p className="text-xs text-subtle-foreground">{lookupItem.statusText}</p>
                        )}
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          className="mt-1 max-md:min-h-11"
                          aria-label={t('preview.taxLookup.acceptRowAria', { row: String(r.rowNo), code: lookupItem.taxCode })}
                          loading={fillPendingRowNo === r.rowNo}
                          disabled={fillPendingRowNo !== null}
                          onClick={() =>
                            onAcceptRow({
                              rowNo: r.rowNo,
                              ...(fillName ? { name: fillName } : {}),
                              ...(fillAddress ? { address: fillAddress } : {}),
                            })
                          }
                        >
                          {t('preview.taxLookup.acceptRow')}
                        </Button>
                      </div>
                    ) : isAccepted ? (
                      <Badge variant="success">{t('preview.taxLookup.filled')}</Badge>
                    ) : null
                  ) : null}
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </DataTable>

      {hasMore && (
        <Button type="button" variant="outline" size="sm" className="max-md:min-h-11" loading={loadingMore} onClick={onLoadMore}>
          {t('preview.more')}
        </Button>
      )}
      {counts.duplicateRows > 0 && (
        <fieldset className="space-y-1 text-sm">
          <legend className="font-medium">{t('preview.duplicates')}</legend>
          {(['skip', 'fill_empty'] as const).map((choice) => (
            <label key={choice} className="flex items-center gap-2 max-md:min-h-11">
              <input type="radio" name="on-duplicate" checked={onDuplicate === choice} onChange={() => onDuplicateChange(choice)} />
              {t(`choice.${choice}`)}
            </label>
          ))}
        </fieldset>
      )}
      {counts.newCompanies > 0 && (
        <label className="flex items-start gap-2 text-sm max-md:min-h-11">
          <input type="checkbox" className="mt-1" checked={createCompanies} onChange={(e) => onCreateCompaniesChange(e.target.checked)} />
          <span>
            {t('preview.createCompanies', { count: String(counts.newCompanies) })}
            {newCompanyNames.length > 0 && (
              <span className="block text-xs text-muted-foreground">
                {newCompanyNames.join(', ')}
                {counts.newCompanies > newCompanyNames.length ? ', …' : ''}
              </span>
            )}
          </span>
        </label>
      )}
      {Boolean(actionError || fillError) && <ErrorText>{errorMessage(actionError ?? fillError)}</ErrorText>}
      {counts.newRows === 0 && !(onDuplicate === 'fill_empty' && counts.duplicateRows > 0) && (
        <p className="text-xs text-muted-foreground" role="status">
          {t(counts.duplicateRows > 0 ? 'preview.nothingNewDuplicates' : 'preview.nothingNew')}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="max-md:min-h-11"
          disabled={counts.newRows === 0 && !(onDuplicate === 'fill_empty' && counts.duplicateRows > 0)}
          loading={commitPending}
          onClick={onCommit}
        >
          {t('preview.import', { count: String(counts.newRows) })}
        </Button>
        <Button type="button" variant="ghost" className="max-md:min-h-11" loading={cancelPending} onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}

export function ContactImportPage() {
  const t = useTranslations('contactImport');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const deploymentTaxLookup = getConfig().partyTaxLookup === true;
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('choose');
  const [filename, setFilename] = useState('');
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<(ImportField | null)[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [staged, setStaged] = useState<ImportPreview | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | 'all'>('all');
  const [onDuplicate, setOnDuplicate] = useState<ImportOnDuplicate>('skip');
  // Off until the person ticks it: a company the file names and the org does not have is not made by an import that never said so (#2438).
  const [createCompanies, setCreateCompanies] = useState(false);
  const [done, setDone] = useState<ImportCommitted | null>(null);
  const [acceptedRowNos, setAcceptedRowNos] = useState<Set<number>>(() => new Set());
  const [fillPendingRowNo, setFillPendingRowNo] = useState<number | 'batch' | null>(null);
  const reasonText = (reason: ImportReason | null) => (reason ? t(`reason.${reason}`) : '');

  const [more, setMore] = useState<ImportPreview['rows']>([]);
  // Whether the pages loaded after the first one left rows unread; null until one is loaded.
  const [moreHas, setMoreHas] = useState<boolean | null>(null);

  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const outcomeRef = useRef(outcome);
  outcomeRef.current = outcome;
  const moreRef = useRef(more);
  moreRef.current = more;

  const taxLookup = useMutation({
    mutationFn: (batchId: string) => client.crm.contactImport.taxLookup({ batchId }),
    onSuccess: (result, batchId) => {
      const current = stagedRef.current;
      if (!current || current.batch.id !== batchId) return;
      if (result.expired) {
        setDone({ batch: { ...current.batch, status: 'expired' }, skipped: [] });
        setStep('done');
      }
    },
  });

  const stage = useMutation(
    orpc.crm.contactImport.stage.mutationOptions({
      onSuccess: (preview) => {
        setStaged(preview);
        setMore([]);
        setMoreHas(null);
        setOutcome('all');
        setCreateCompanies(false);
        setAcceptedRowNos(new Set());
        setFillPendingRowNo(null);
        taxLookup.reset();
        setStep('preview');
        if (deploymentTaxLookup) taxLookup.mutate(preview.batch.id);
      },
    }),
  );

  const fillSuggestions = useMutation({
    mutationFn: async (vars: { batchId: string; rows: FillSuggestionRowInput[]; scope: number | 'batch' }) =>
      client.crm.contactImport.fillTaxSuggestions({ batchId: vars.batchId, rows: vars.rows }),
    onMutate: (vars) => {
      setFillPendingRowNo(vars.scope);
    },
    onSettled: (_data, _error, vars) => {
      if (stagedRef.current?.batch.id === vars.batchId) setFillPendingRowNo(null);
    },
    onSuccess: async (result, vars) => {
      if (stagedRef.current?.batch.id !== vars.batchId) return;
      setAcceptedRowNos((prev) => {
        const next = new Set(prev);
        for (const r of vars.rows) next.add(r.rowNo);
        return next;
      });
      if (result.batch.status !== 'staged') {
        setDone({ batch: result.batch, skipped: [] });
        setStep('done');
        return;
      }
      // Refresh staged first page and any loaded extra pages so row outcomes and batch counts match the server.
      const liveOutcome = outcomeRef.current;
      const totalLoadedAll = (stagedRef.current?.rows.length ?? 0) + (liveOutcome === 'all' ? moreRef.current.length : 0);
      const firstPage = await client.crm.contactImport.preview({ batchId: vars.batchId, after: 0, limit: IMPORT_PREVIEW_PAGE });
      const extraRows: ImportPreview['rows'] = [];
      let extraHas: boolean | null = null;
      if (liveOutcome === 'all' && totalLoadedAll > IMPORT_PREVIEW_PAGE && firstPage.more) {
        let cursor = firstPage.rows.at(-1)?.rowNo ?? 0;
        let hasNext: boolean = firstPage.more;
        while (hasNext && firstPage.rows.length + extraRows.length < totalLoadedAll) {
          const nextPage = await client.crm.contactImport.preview({ batchId: vars.batchId, after: cursor, limit: IMPORT_PREVIEW_PAGE });
          extraRows.push(...nextPage.rows);
          hasNext = nextPage.more;
          extraHas = nextPage.more;
          if (nextPage.rows.length === 0) break;
          cursor = nextPage.rows.at(-1)?.rowNo ?? cursor;
        }
      }
      if (stagedRef.current?.batch.id !== vars.batchId) return;
      setStaged(firstPage);
      if (outcomeRef.current === 'all') {
        setMore(extraRows);
        setMoreHas(extraHas);
      } else {
        setMore([]);
        setMoreHas(null);
      }
      void queryClient.invalidateQueries({ queryKey: orpc.crm.contactImport.preview.key() });
    },
  });

  const commit = useMutation(
    orpc.crm.contactImport.commit.mutationOptions({
      onSuccess: (result) => {
        // The contacts list may already hold an older answer.
        void queryClient.invalidateQueries({ queryKey: orpc.crm.contacts.list.key() });
        setDone(result);
        setStep('done');
      },
    }),
  );
  const cancel = useMutation(orpc.crm.contactImport.cancel.mutationOptions({ onSuccess: () => reset() }));
  const batchId = staged?.batch.id;
  // The rows of the preview, a page at a time: the first page came with the stage, the filter and the paging ask again.
  const page = useQuery({
    ...orpc.crm.contactImport.preview.queryOptions({ input: { batchId: batchId ?? '00000000-0000-4000-8000-000000000000', ...(outcome === 'all' ? {} : { outcome }), after: 0, limit: 100 } }),
    enabled: step === 'preview' && batchId !== undefined && outcome !== 'all',
  });
  // The batch and filter the screen shows now: an answer that comes back after either changed belongs to a list no longer there.
  const viewKey = `${batchId ?? ''}|${outcome}`;
  const shown = useRef(viewKey);
  shown.current = viewKey;
  const loadMore = useMutation({
    mutationFn: async () => {
      const key = viewKey;
      const last = (outcome === 'all' ? [...(staged?.rows ?? []), ...more] : [...(page.data?.rows ?? []), ...more]).at(-1)?.rowNo ?? 0;
      const next = await client.crm.contactImport.preview({ batchId: batchId as string, ...(outcome === 'all' ? {} : { outcome }), after: last, limit: 100 });
      return { key, next };
    },
    onSuccess: ({ key, next }) => {
      if (key !== shown.current) return;
      setMore((m) => [...m, ...next.rows]);
      setMoreHas(next.more);
    },
  });

  // Which file selection is current: a read that finishes after a newer selection, or after Cancel, is dropped.
  const selection = useRef(0);
  const reset = () => {
    selection.current += 1;
    setStep('choose');
    setCsv(null);
    setStaged(null);
    setDone(null);
    setMore([]);
    setMoreHas(null);
    setOnDuplicate('skip');
    setCreateCompanies(false);
    setFilename('');
    setReadError(null);
    setAcceptedRowNos(new Set());
    setFillPendingRowNo(null);
    taxLookup.reset();
    fillSuggestions.reset();
    if (input.current) input.current.value = '';
  };

  const choose = async (file: File | undefined) => {
    setReadError(null);
    const mine = (selection.current += 1);
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) return setReadError(t('errors.tooBig'));
    let parsed: ParsedCsv;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // A workbook is an .xlsx name or a zip (PK). A name that says CSV wins over the bytes: a CSV whose first cell starts with
      // "PK" is text; only a real workbook renamed to .csv falls through to the workbook reader (and a failure of that reads text).
      const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
      const csvName = /\.(csv|tsv|txt)$/i.test(file.name);
      const readSheet = async () => sheetToTable(await readFirstSheet(bytes, { refuseMacros: true, refuseFormulas: true }));
      const readText = () => parseContactCsv(new TextDecoder('utf-8').decode(bytes));
      if (/\.xlsx$/i.test(file.name) || (zip && !csvName)) parsed = await readSheet();
      else if (zip) parsed = await readSheet().catch((error: unknown) => (error instanceof XlsxError && error.reason === 'not_xlsx' ? readText() : Promise.reject(error)));
      else parsed = readText();
    } catch (error) {
      if (mine !== selection.current) return;
      return setReadError(error instanceof XlsxError ? t(error.reason === 'too_large' ? 'errors.tooBig' : error.reason === 'unsupported' ? 'errors.unsupported' : error.reason === 'macro' ? 'errors.macro' : error.reason === 'formula' ? 'errors.formula' : 'errors.notXlsx') : t('errors.unreadable'));
    }
    if (mine !== selection.current) return;
    if (parsed.unterminated) return setReadError(t('errors.unterminated'));
    if (parsed.tooWide) return setReadError(t('errors.tooWide'));
    if (parsed.header.length === 0 || parsed.rows.length === 0) return setReadError(t('errors.empty'));
    if (parsed.rows.length > IMPORT_MAX_ROWS) return setReadError(t('errors.tooMany', { max: String(IMPORT_MAX_ROWS) }));
    setFilename(file.name);
    setCsv(parsed);
    setMapping(guessMapping(parsed.header));
    setStep('map');
  };
  const nameMapped = mapping.includes('name');
  const rows = outcome === 'all' ? [...(staged?.rows ?? []), ...more] : [...(page.data?.rows ?? []), ...more];
  const hasMore = moreHas ?? (outcome === 'all' ? staged?.more : page.data?.more) ?? false;
  const counts = staged?.batch;
  // The first few companies the file would make, from the rows on the screen, so the person ticks the box knowing which.
  const newCompanyNames = [...new Set(rows.flatMap((r) => (r.outcome === 'new' && r.kind === 'person' && r.company?.state === 'new' ? [r.company.name] : [])))].slice(0, 5);

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={<BackLink slug={slug} label={t('back')} />}
      />
      <ol className="mb-4 flex flex-wrap gap-2 text-sm" aria-label={t('steps.label')}>
        {(['choose', 'map', 'preview', 'done'] as const).map((s, i) => (
          <li key={s} aria-current={step === s ? 'step' : undefined}>
            <Badge variant={step === s ? 'default' : 'outline'}>{`${i + 1}. ${t(`steps.${s}`)}`}</Badge>
          </li>
        ))}
      </ol>

      {step === 'choose' && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">{t('choose.hint', { max: String(IMPORT_MAX_ROWS) })}</p>
          <Field label={t('choose.file')}>
            {(c) => <input {...c} ref={input} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="block w-full text-sm text-muted-foreground file:mr-3 file:min-h-9 file:cursor-pointer file:rounded-lg file:border file:border-input file:bg-background file:px-3 file:text-sm file:font-medium file:text-foreground hover:file:bg-muted" onChange={(e) => void choose(e.target.files?.[0])} />}
          </Field>
          <Button type="button" variant="outline" size="sm" onClick={() => download(t('templateFile'), templateBook((f) => t(`field.${f}`), { sheet: t('templateSheet'), example: t('choose.example'), email: t('templateEmail'), phone: t('templatePhone'), address: t('templateAddress') }).slice(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}>
            {t('choose.template')}
          </Button>
          {readError && <ErrorText>{readError}</ErrorText>}
        </div>
      )}

      {step === 'map' && csv && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('map.hint', { file: filename, rows: String(csv.rows.length) })}</p>
          <DataTable head={[t('map.column'), t('map.field'), t('map.sample')]} stacked>
            {csv.header.map((h, i) => (
              <TableRow key={`${h}-${i}`}>
                <TableCell data-label={t('map.column')} className="text-sm font-medium">{h || t('map.unnamed', { n: String(i + 1) })}</TableCell>
                <TableCell data-label={t('map.field')}>
                  <NativeSelect
                    size="sm"
                    aria-label={t('map.fieldOf', { column: h || String(i + 1) })}
                    value={mapping[i] ?? ''}
                    onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? ((e.target.value || null) as ImportField | null) : x === e.target.value ? null : x)))}
                  >
                    <option value="">{t('map.skip')}</option>
                    {IMPORT_FIELDS.map((f) => (
                      <option key={f} value={f}>
                        {t(`field.${f}`)}
                      </option>
                    ))}
                  </NativeSelect>
                </TableCell>
                <TableCell data-label={t('map.sample')} className="text-sm text-muted-foreground">{csv.rows.slice(0, 3).map((r) => r[i] ?? '').filter(Boolean).join(' | ')}</TableCell>
              </TableRow>
            ))}
          </DataTable>
          {!nameMapped && <ErrorText>{t('map.nameRequired')}</ErrorText>}
          {stage.error && <ErrorText>{errorMessage(stage.error)}</ErrorText>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" className="max-md:min-h-11" disabled={!nameMapped} loading={stage.isPending} onClick={() => stage.mutate({ filename, rows: mappedRows(csv.rows, mapping, csv.numeric) })}>
              {t('map.next')}
            </Button>
            <Button type="button" variant="ghost" className="max-md:min-h-11" disabled={stage.isPending} onClick={reset}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {step === 'preview' && staged && counts && (
        <ContactImportPreview
          staged={staged}
          rows={rows}
          outcome={outcome}
          onOutcomeChange={(next) => {
            setOutcome(next);
            setMore([]);
            setMoreHas(null);
          }}
          hasMore={hasMore}
          loadingMore={loadMore.isPending}
          onLoadMore={() => loadMore.mutate()}
          onDuplicate={onDuplicate}
          onDuplicateChange={setOnDuplicate}
          createCompanies={createCompanies}
          onCreateCompaniesChange={setCreateCompanies}
          newCompanyNames={newCompanyNames}
          onCommit={() => commit.mutate({ batchId: counts.id, onDuplicate, createCompanies })}
          commitPending={commit.isPending}
          onCancel={() => cancel.mutate({ batchId: counts.id })}
          cancelPending={cancel.isPending}
          actionError={commit.error ?? cancel.error}
          deploymentTaxLookup={deploymentTaxLookup}
          taxLookupState={{
            isPending: taxLookup.variables === counts.id && taxLookup.isPending,
            data: taxLookup.variables === counts.id ? taxLookup.data : undefined,
            error: taxLookup.variables === counts.id ? taxLookup.error : null,
            onRetry: () => taxLookup.mutate(counts.id),
          }}
          acceptedRowNos={acceptedRowNos}
          fillPendingRowNo={fillPendingRowNo}
          fillError={fillSuggestions.variables?.batchId === counts.id ? fillSuggestions.error : null}
          onAcceptRow={(item) => fillSuggestions.mutate({ batchId: counts.id, rows: [item], scope: item.rowNo })}
          onAcceptAll={(items) => fillSuggestions.mutate({ batchId: counts.id, rows: items, scope: 'batch' })}
        />
      )}

      {step === 'done' && done && csv && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          {done.batch.status === 'committed' ? (
            <>
              <p className="text-sm font-medium" role="status">
                {t('done.result', { created: String(done.batch.createdRows), updated: String(done.batch.updatedRows), skipped: String(done.skipped.length) })}
                {(done.batch.linkedRows > 0 || done.batch.createdCompanies > 0) && ` ${t('done.companies', { linked: String(done.batch.linkedRows), made: String(done.batch.createdCompanies) })}`}
              </p>
              {done.skipped.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() =>
                    download(
                      `${filename.replace(/\.csv$/i, '')}-${t('rejectsFile')}.csv`,
                      rejectsCsv(
                        csv.header,
                        done.skipped.map((s) => csv.rows[s.rowNo - 1] ?? []),
                        done.skipped.map((s) => reasonText(s.reason)),
                        t('done.reasonColumn'),
                      ),
                    )
                  }
                >
                  {t('done.download', { count: String(done.skipped.length) })}
                </Button>
              )}
            </>
          ) : (
            <ErrorText>{t('done.expired')}</ErrorText>
          )}
          <div className="flex gap-3 text-sm">
            <BackLink slug={slug} label={t('done.toContacts')} />
            <Button variant="ghost" size="sm" onClick={reset}>
              {t('done.again')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
