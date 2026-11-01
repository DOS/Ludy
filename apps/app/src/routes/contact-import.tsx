// SPDX-License-Identifier: AGPL-3.0-only
// Importing contacts from a CSV (#2229, docs/plan/crm.md step K5), in four steps: choose the file (read here in the browser
// and never stored), map its columns, read the preview of what would be new, duplicate, in conflict or invalid, and import.
// Nothing is written to the contacts before the last button. The file's rows that were not imported can be downloaded again.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { IMPORT_MAX_ROWS, type ImportCommitted, type ImportOnDuplicate, type ImportOutcome, type ImportPreview, type ImportReason } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { NativeSelect } from '@crove/ui/components/native-select';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, ErrorText, Field, PageHeader } from '../components/ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { IMPORT_FIELDS, IMPORT_MAX_BYTES, guessMapping, mappedRows, parseContactCsv, rejectsCsv, sheetToTable, type ImportField, type ParsedCsv } from '../lib/contact-csv.ts';
import { XlsxError, readFirstSheet, writeWorkbook } from '../lib/xlsx.ts';

type Step = 'choose' | 'map' | 'preview' | 'done';
const OUTCOMES: readonly (ImportOutcome | 'all')[] = ['all', 'new', 'duplicate', 'conflict', 'invalid'];

function download(name: string, content: BlobPart, type = 'text/csv;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// A sample workbook: the columns the import knows and one made-up row, phone and tax code as text so they keep their zero.
function templateBook(label: (field: ImportField) => string, example: string): Uint8Array {
  const sample: Record<ImportField, string> = { name: example, kind: '', taxCode: '', email: 'mau@example.com', phone: '0900 000 000', address: '1 Đường Mẫu, Quận 1' };
  return writeWorkbook([
    {
      name: 'Liên hệ',
      widths: [28, 22, 18, 28, 18, 36],
      headerRows: 1,
      textColumns: [IMPORT_FIELDS.indexOf('taxCode'), IMPORT_FIELDS.indexOf('phone')],
      rows: [IMPORT_FIELDS.map(label), IMPORT_FIELDS.map((f) => sample[f])],
    },
  ]);
}

export function ContactImportPage() {
  const t = useTranslations('contactImport');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const input = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('choose');
  const [filename, setFilename] = useState('');
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<(ImportField | null)[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [staged, setStaged] = useState<ImportPreview | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | 'all'>('all');
  const [onDuplicate, setOnDuplicate] = useState<ImportOnDuplicate>('skip');
  const [done, setDone] = useState<ImportCommitted | null>(null);
  const reasonText = (reason: ImportReason | null) => (reason ? t(`reason.${reason}`) : '');

  const stage = useMutation(
    orpc.crm.contactImport.stage.mutationOptions({
      onSuccess: (preview) => {
        setStaged(preview);
        setMore([]);
        setMoreHas(null);
        setOutcome('all');
        setStep('preview');
      },
    }),
  );
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
  const [more, setMore] = useState<ImportPreview['rows']>([]);
  // Whether the pages loaded after the first one left rows unread; null until one is loaded.
  const [moreHas, setMoreHas] = useState<boolean | null>(null);
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
    setFilename('');
    setReadError(null);
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
      // A workbook is a zip (PK); anything else is read as UTF-8 text.
      parsed = /\.xlsx$/i.test(file.name) || (bytes[0] === 0x50 && bytes[1] === 0x4b) ? sheetToTable(await readFirstSheet(bytes, { refuseMacros: true, refuseFormulas: true })) : parseContactCsv(new TextDecoder('utf-8').decode(bytes));
    } catch (error) {
      if (mine !== selection.current) return;
      return setReadError(error instanceof XlsxError ? t(error.reason === 'too_large' ? 'errors.tooBig' : error.reason === 'unsupported' ? 'errors.unsupported' : error.reason === 'macro' ? 'errors.macro' : error.reason === 'formula' ? 'errors.formula' : 'errors.notXlsx') : t('errors.unreadable'));
    }
    if (mine !== selection.current) return;
    if (parsed.unterminated) return setReadError(t('errors.unterminated'));
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

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Link to="/o/$slug/contacts" params={{ slug }} className="text-link underline">
            {t('back')}
          </Link>
        }
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
            {(c) => <input {...c} ref={input} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="text-sm" onChange={(e) => void choose(e.target.files?.[0])} />}
          </Field>
          <Button type="button" variant="outline" size="sm" onClick={() => download('mau-lien-he.xlsx', templateBook((f) => t(`field.${f}`), t('choose.example')).slice(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')}>
            {t('choose.template')}
          </Button>
          {readError && <ErrorText>{readError}</ErrorText>}
        </div>
      )}

      {step === 'map' && csv && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('map.hint', { file: filename, rows: String(csv.rows.length) })}</p>
          <DataTable head={[t('map.column'), t('map.field'), t('map.sample')]}>
            {csv.header.map((h, i) => (
              <TableRow key={`${h}-${i}`}>
                <TableCell className="px-4 text-sm font-medium">{h || t('map.unnamed', { n: String(i + 1) })}</TableCell>
                <TableCell className="px-4">
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
                <TableCell className="px-4 text-sm text-muted-foreground">{csv.rows.slice(0, 3).map((r) => r[i] ?? '').filter(Boolean).join(' | ')}</TableCell>
              </TableRow>
            ))}
          </DataTable>
          {!nameMapped && <ErrorText>{t('map.nameRequired')}</ErrorText>}
          {stage.error && <ErrorText>{errorMessage(stage.error)}</ErrorText>}
          <div className="flex gap-2">
            <Button disabled={!nameMapped} loading={stage.isPending} onClick={() => stage.mutate({ filename, rows: mappedRows(csv.rows, mapping, csv.numeric) })}>
              {t('map.next')}
            </Button>
            <Button variant="ghost" disabled={stage.isPending} onClick={reset}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {step === 'preview' && staged && counts && (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t('preview.hint')}</p>
          <ul className="flex flex-wrap gap-2 text-sm" aria-label={t('preview.counts')}>
            <li><Badge variant="success">{t('preview.new', { count: String(counts.newRows) })}</Badge></li>
            <li><Badge variant="outline">{t('preview.duplicate', { count: String(counts.duplicateRows) })}</Badge></li>
            <li><Badge variant="outline">{t('preview.conflict', { count: String(counts.conflictRows) })}</Badge></li>
            <li><Badge variant="outline">{t('preview.invalid', { count: String(counts.invalidRows) })}</Badge></li>
          </ul>
          <Tabs value={outcome} onValueChange={(v) => { setOutcome(v as ImportOutcome | 'all'); setMore([]); setMoreHas(null); }}>
            <TabsList aria-label={t('preview.filter')}>
              {OUTCOMES.map((o) => (
                <TabsTrigger key={o} value={o}>
                  {t(`outcome.${o}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <DataTable head={[t('preview.row'), t('field.name'), t('field.taxCode'), t('field.email'), t('field.phone'), t('preview.result')]}>
            {rows.map((r) => (
              <TableRow key={r.rowNo} data-testid="import-row">
                <TableCell className="px-4 text-sm tabular-nums">{r.rowNo}</TableCell>
                <TableCell className="px-4 text-sm">{r.name}</TableCell>
                <TableCell className="px-4 text-sm">{r.taxCode}</TableCell>
                <TableCell className="px-4 text-sm">{r.email}</TableCell>
                <TableCell className="px-4 text-sm">{r.phone}</TableCell>
                <TableCell className="px-4 text-sm">
                  <Badge variant={r.outcome === 'new' ? 'success' : 'outline'}>{t(`outcome.${r.outcome}`)}</Badge>
                  {r.reason && <p className="text-xs text-muted-foreground">{reasonText(r.reason)}</p>}
                  {r.match && <p className="text-xs text-muted-foreground">{t('preview.matches', { name: r.match.name })}</p>}
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          {hasMore && (
            <Button variant="outline" size="sm" loading={loadMore.isPending} onClick={() => loadMore.mutate()}>
              {t('preview.more')}
            </Button>
          )}
          {counts.duplicateRows > 0 && (
            <fieldset className="space-y-1 text-sm">
              <legend className="font-medium">{t('preview.duplicates')}</legend>
              {(['skip', 'fill_empty'] as const).map((choice) => (
                <label key={choice} className="flex items-center gap-2">
                  <input type="radio" name="on-duplicate" checked={onDuplicate === choice} onChange={() => setOnDuplicate(choice)} />
                  {t(`choice.${choice}`)}
                </label>
              ))}
            </fieldset>
          )}
          {(commit.error || cancel.error) && <ErrorText>{errorMessage(commit.error ?? cancel.error)}</ErrorText>}
          <div className="flex gap-2">
            <Button disabled={counts.newRows === 0 && !(onDuplicate === 'fill_empty' && counts.duplicateRows > 0)} loading={commit.isPending} onClick={() => commit.mutate({ batchId: counts.id, onDuplicate })}>
              {t('preview.import', { count: String(counts.newRows) })}
            </Button>
            <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate({ batchId: counts.id })}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}

      {step === 'done' && done && csv && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          {done.batch.status === 'committed' ? (
            <>
              <p className="text-sm font-medium" role="status">
                {t('done.result', { created: String(done.batch.createdRows), updated: String(done.batch.updatedRows), skipped: String(done.skipped.length) })}
              </p>
              {done.skipped.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() =>
                    download(
                      `${filename.replace(/\.csv$/i, '')}-chua-nhap.csv`,
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
            <Link to="/o/$slug/contacts" params={{ slug }} className="text-link underline">
              {t('done.toContacts')}
            </Link>
            <Button variant="ghost" size="sm" onClick={reset}>
              {t('done.again')}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
