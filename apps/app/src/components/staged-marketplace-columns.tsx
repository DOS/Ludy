// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order reports no platform profile fits (#4036, slice 1c of #3850): a spreadsheet that reached the Inbox and was not recognised. A member reads its columns, picks the platform and
// says which column is which field; the worker checks that mapping on the real file and the card shows the parsed lines (line keys included) before anything else. Nothing is saved or imported
// from here (saving a confirmed mapping is #4037's, below).
// The finance coworker (Ly) may suggest a first mapping from the masked sheet (header texts and the shapes of a few values, never a line); it only fills the pickers, the platform stays the person's
// pick, and a buyer's column has no picker at all. With the AI off the pickers are the same, empty. The parsed lines are personal data (a buyer's text can sit in a column mapped by hand): they are
// shown to the member who asked and kept seven days at most.
// Saving (#4037): once the lines of a passed check are on screen and the choices still are the ones checked, an owner or admin can save the mapping; the server saves the mapping of that file's last check (never
// what this screen sends beyond the file, platform and assignments it saw) and the card then says it is saved (it stays in the list until the file is read with the mapping).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { MARKETPLACE_COLUMN_PLATFORMS, type MarketplaceColumnsFile, type MarketplaceColumnsStatus } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { FIELD_ORDER, checkIsStuck, fieldsChosenTwice, isFieldChoice, isPlatform, mappingFrom, selectionFrom, verdictIsCurrent, type ColumnPlatform, type Selection } from '../lib/marketplace-columns.ts';
import { toast } from '../lib/toast.ts';
import { CardSkeleton, ErrorText, Spinner } from './ui.tsx';

// How often a waiting check is read again while the card is open.
const WAIT_POLL_MS = 3000;

type Edits = { platform: ColumnPlatform | ''; selection: Selection };

function Verdict({ status, current, stuck }: { status: MarketplaceColumnsStatus; current: ReturnType<typeof mappingFrom>; stuck: boolean }) {
  const t = useTranslations('inbox.marketplaceColumns');
  if (status.state === 'requested' && stuck) {
    return (
      <p className="mt-3 text-xs text-warning" role="alert" data-testid="staged-columns-stuck">
        {t('stuck')}
      </p>
    );
  }
  if (status.state === 'requested') {
    return (
      <p className="mt-3 flex items-center gap-2 text-xs text-subtle-foreground" role="status" data-testid="staged-columns-reading">
        <Spinner /> {t('reading')}
      </p>
    );
  }
  if (status.state === 'failed') {
    return (
      <Alert className="mt-3 border-warning/30 bg-warning/10 text-warning" role="alert" data-testid="staged-columns-failure">
        <AlertDescription className="text-warning">{t(`failures.${status.failure ?? 'unavailable'}`)}</AlertDescription>
      </Alert>
    );
  }
  // Only a check of a mapping has a verdict; and it is shown only while the choices on screen are still the ones it was made for.
  if (status.mapping === null || (status.refusal === null && status.preview === null)) return null;
  if (!verdictIsCurrent(status.mapping, current)) {
    return (
      <p className="mt-3 text-xs text-subtle-foreground" role="status" data-testid="staged-columns-stale">
        {t('stale')}
      </p>
    );
  }
  if (status.refusal !== null) {
    return (
      <Alert className="mt-3 border-warning/30 bg-warning/10 text-warning" role="alert" data-testid="staged-columns-refusal" data-refusal={status.refusal}>
        <AlertDescription className="text-warning">{t(`refusals.${status.refusal}`)}</AlertDescription>
      </Alert>
    );
  }
  const preview = status.preview;
  if (preview === null) return null;
  return (
    <div className="mt-3" data-testid="staged-columns-preview">
      <h4 className="text-xs font-semibold text-foreground">{t('previewTitle', { shown: preview.lines.length, total: preview.total })}</h4>
      {preview.skipped > 0 && <p className="mt-1 text-xs text-subtle-foreground">{t('previewSkipped', { count: preview.skipped })}</p>}
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-xs tabular-nums">
          <caption className="sr-only">{t('previewTitle', { shown: preview.lines.length, total: preview.total })}</caption>
          <thead className="text-subtle-foreground">
            <tr>
              {(['rowNo', 'orderNo', 'lineKey', 'sku', 'itemName', 'quantity', 'amount', 'status'] as const).map((key) => (
                <th key={key} scope="col" className="py-1 pr-3 font-medium">
                  {t(`previewColumns.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.lines.map((line) => (
              <tr key={line.rowNo} className="border-t border-border" data-testid="staged-columns-line">
                <td className="py-1 pr-3">{line.rowNo}</td>
                <td className="py-1 pr-3 break-all">{line.orderNo}</td>
                <td className="py-1 pr-3 break-all" data-testid="staged-columns-line-key">
                  {line.lineKey}
                </td>
                <td className="py-1 pr-3 break-all">{line.sku ?? ''}</td>
                <td className="py-1 pr-3 break-words">{line.itemName ?? ''}</td>
                <td className="py-1 pr-3">{line.quantity}</td>
                <td className="py-1 pr-3">{line.amount ?? ''}</td>
                <td className="py-1 pr-3">{line.status ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-subtle-foreground">{t('notSaved')}</p>
      <p className="mt-1 text-xs text-subtle-foreground">{t('retention')}</p>
    </div>
  );
}

function ColumnsCard({ file, canSave }: { file: MarketplaceColumnsFile; canSave: boolean }) {
  const t = useTranslations('inbox.marketplaceColumns');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  // A file whose check was asked before shows what the worker kept without another press.
  const [opened, setOpened] = useState(file.state !== 'none');
  const [edits, setEdits] = useState<Edits | null>(null);
  // Set once the mapping is saved: the check row is gone with it, so the card says so instead of offering the columns again.
  const [savedNow, setSavedNow] = useState(false);
  // Focus goes to the saved note when the Save button it replaces disappears.
  const savedNote = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (savedNow) savedNote.current?.focus();
  }, [savedNow]);
  const status = useQuery({
    ...orpc.marketplace.columns.queryOptions({ input: { fileId: file.fileId } }),
    enabled: opened,
    // A check waiting longer than the server's window is read as lost: polling stops and the person may press again.
    refetchInterval: (query: { state: { data: MarketplaceColumnsStatus | undefined } }) => (query.state.data?.state === 'requested' && !checkIsStuck(query.state.data, Date.now()) ? WAIT_POLL_MS : false),
  });
  const data = status.data;
  const sheet = data?.sheet ?? null;
  // Ly's first mapping is asked once the sheet is known and no mapping has been checked yet; it never costs a press and never blocks the pickers.
  const proposal = useQuery({
    ...orpc.marketplace.columnsProposal.queryOptions({ input: { fileId: file.fileId, lang } }),
    enabled: sheet !== null && data?.mapping === null,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const suggested = proposal.data?.ai === 'used' ? proposal.data.assignments : [];
  // What the pickers show: the person's own choices, else the mapping last checked, else Ly's suggestion (the platform is never suggested).
  const base: Edits = {
    platform: data?.mapping?.platform ?? '',
    selection: sheet === null ? {} : selectionFrom(sheet, data?.mapping?.assignments ?? suggested),
  };
  const shown = edits ?? base;
  const current = mappingFrom(shown.platform, shown.selection);
  const twice = fieldsChosenTwice(shown.selection);

  const ask = useMutation({
    mutationFn: (mapping: NonNullable<typeof current> | undefined) => client.marketplace.columnsCheck({ fileId: file.fileId, ...(mapping ? { mapping } : {}), idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setOpened(true);
      void queryClient.invalidateQueries({ queryKey: orpc.marketplace.columns.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.marketplace.columnsFiles.key() });
    },
    onError: (error) => toast(errorMessage(error), 'error'),
  });
  const stuck = checkIsStuck(data, Date.now());
  const waiting = data?.state === 'requested' && !stuck;
  // The mapping may be saved when its passed check is the one on screen: done, no refusal, lines parsed, the choices unchanged since, and a header digest the worker recorded (an older check has none).
  const passed = data !== undefined && data.state === 'done' && data.refusal === null && data.preview !== null && data.mapping !== null && verdictIsCurrent(data.mapping, current);
  const digestKnown = sheet?.headerDigest !== undefined;
  const save = useMutation({
    mutationFn: (mapping: NonNullable<typeof current>) => client.marketplace.columnsConfirm({ fileId: file.fileId, platform: mapping.platform, assignments: mapping.assignments, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      setSavedNow(true);
      toast(t('saved'), 'success');
      void queryClient.invalidateQueries({ queryKey: orpc.marketplace.columns.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.marketplace.columnsFiles.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.marketplace.columnsProfile.key() });
    },
    onError: (error) => toast(errorMessage(error), 'error'),
  });

  if (savedNow) {
    return (
      <Card className="block p-4 text-sm" data-testid="staged-columns-report">
        <p className="font-medium text-foreground break-words">{file.filename}</p>
        <p ref={savedNote} tabIndex={-1} className="mt-3 text-xs text-subtle-foreground outline-none" role="status" data-testid="staged-columns-saved">
          {t('saved')}
        </p>
      </Card>
    );
  }
  return (
    <Card className="block p-4 text-sm" data-testid="staged-columns-report">
      <p className="font-medium text-foreground break-words">{file.filename}</p>
      {!opened && (
        <div className="mt-3">
          <Button size="sm" className="min-h-11 md:min-h-8" loading={ask.isPending} onClick={() => ask.mutate(undefined)} data-testid="staged-columns-read">
            {t('read')}
          </Button>
        </div>
      )}
      {opened && status.isError && <ErrorText>{errorMessage(status.error)}</ErrorText>}
      {opened && status.isPending && <Spinner />}
      {data !== undefined && sheet === null && (data.state === 'requested' || data.state === 'failed') && <Verdict status={data} current={current} stuck={stuck} />}
      {data !== undefined && sheet === null && (data.state === 'failed' || stuck) && (
        <div className="mt-3">
          <Button size="sm" className="min-h-11 md:min-h-8" loading={ask.isPending} onClick={() => ask.mutate(undefined)} data-testid="staged-columns-read-again">
            {t('readAgain')}
          </Button>
        </div>
      )}
      {data !== undefined && sheet !== null && (
        <>
          <div className="mt-3 space-y-1">
            <Label htmlFor={`columns-platform-${file.fileId}`}>{t('platform')}</Label>
            <NativeSelect
              id={`columns-platform-${file.fileId}`}
              className="w-full max-w-xs [&_select]:h-11 md:[&_select]:h-8"
              value={shown.platform}
              onChange={(e) => setEdits({ platform: isPlatform(e.target.value) ? e.target.value : '', selection: shown.selection })}
              data-testid="staged-columns-platform"
            >
              <NativeSelectOption value="">{t('platformChoose')}</NativeSelectOption>
              {MARKETPLACE_COLUMN_PLATFORMS.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {t(`platforms.${p}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          {proposal.data !== undefined && (
            <p className="mt-3 text-xs text-subtle-foreground" role="note" data-testid="staged-columns-ly" data-ai={proposal.data.ai}>
              {t(`ly.${proposal.data.ai}`)}
            </p>
          )}
          <p className="mt-3 text-xs text-subtle-foreground">{t('columnsHint')}</p>
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border" data-testid="staged-columns-list">
            {sheet.columns.map((column) => {
              const id = `columns-${file.fileId}-${column.index}`;
              const name = column.header === '' ? t('columnNumber', { number: column.index + 1 }) : column.header;
              return (
                <li key={column.index} className="grid gap-2 p-3 sm:grid-cols-[1fr_14rem] sm:items-center" data-testid="staged-columns-column">
                  <div className="min-w-0">
                    {column.buyer ? (
                      <>
                        <p className="font-medium text-foreground">{t('columnNumber', { number: column.index + 1 })}</p>
                        <Badge variant="secondary" data-testid="staged-columns-buyer">
                          {t('buyerColumn')}
                        </Badge>
                      </>
                    ) : (
                      <>
                        <Label htmlFor={id} className="break-words font-medium text-foreground">
                          {name}
                        </Label>
                        {column.samples.length > 0 && (
                          <p className="mt-1 break-all font-mono text-xs text-subtle-foreground" data-testid="staged-columns-samples">
                            {t('samples', { samples: column.samples.join('  |  ') })}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  {!column.buyer && (
                    <NativeSelect
                      id={id}
                      className="w-full [&_select]:h-11 md:[&_select]:h-8"
                      value={shown.selection[column.index] ?? ''}
                      onChange={(e) => setEdits({ platform: shown.platform, selection: { ...shown.selection, [column.index]: isFieldChoice(e.target.value) ? e.target.value : '' } })}
                      data-testid="staged-columns-field"
                    >
                      <NativeSelectOption value="">{t('fieldNone')}</NativeSelectOption>
                      {FIELD_ORDER.map((field) => (
                        <NativeSelectOption key={field} value={field}>
                          {t(`fields.${field}`)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                </li>
              );
            })}
          </ul>
          {twice.length > 0 && (
            <p className="mt-2 text-xs text-warning" role="alert" data-testid="staged-columns-twice">
              {t('twice', { fields: twice.map((f) => t(`fields.${f}`)).join(', ') })}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" className="min-h-11 md:min-h-8" disabled={current === null || waiting} loading={ask.isPending || waiting} onClick={() => current && ask.mutate(current)} data-testid="staged-columns-check">
              {t('check')}
            </Button>
            {current === null && twice.length === 0 && (
              <span className="text-xs text-subtle-foreground" data-testid="staged-columns-need">
                {shown.platform === '' ? t('needPlatform') : t('needColumns')}
              </span>
            )}
          </div>
          <Verdict status={data} current={current} stuck={stuck} />
          {passed && (
            <div className="mt-3" data-testid="staged-columns-save-area">
              {canSave && digestKnown ? (
                <>
                  <p id={`columns-save-hint-${file.fileId}`} className="text-xs text-subtle-foreground">
                    {t('saveHint')}
                  </p>
                  <Button size="sm" className="mt-2 min-h-11 md:min-h-8" loading={save.isPending} aria-describedby={`columns-save-hint-${file.fileId}`} onClick={() => current && save.mutate(current)} data-testid="staged-columns-save">
                    {t('save')}
                  </Button>
                </>
              ) : (
                <p className="text-xs text-subtle-foreground" data-testid="staged-columns-save-note">
                  {!canSave ? t('saveOwnerOnly') : t('saveCheckAgain')}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function StagedMarketplaceColumns({ canDecide, canSave, refetchMs }: { canDecide: boolean; canSave: boolean; refetchMs: number | false }) {
  const t = useTranslations('inbox.marketplaceColumns');
  const listed = useQuery({ ...orpc.marketplace.columnsFiles.queryOptions({ input: {} }), refetchInterval: refetchMs, enabled: canDecide });
  // A viewer neither lists nor decides; a failed list must not look like nothing waiting.
  if (!canDecide) return null;
  if (listed.isError) return <ErrorText>{errorMessage(listed.error)}</ErrorText>;
  if (listed.isPending) return <CardSkeleton className="mt-6" />;
  const files: MarketplaceColumnsFile[] = listed.data;
  if (files.length === 0) return null;
  return (
    <section className="mt-6" aria-labelledby="staged-marketplace-columns" data-testid="staged-marketplace-columns">
      <h2 id="staged-marketplace-columns" className="text-sm font-semibold">
        {t('title')}
      </h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('hint')}</p>
      <ul className="mt-3 space-y-2">
        {files.map((file) => (
          <li key={file.fileId}>
            <ColumnsCard file={file} canSave={canSave} />
          </li>
        ))}
      </ul>
    </section>
  );
}
