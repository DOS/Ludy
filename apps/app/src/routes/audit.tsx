// The org's audit log for owners and admins (#672): every command's audit row, newest first, filtered by who, what,
// outcome, object and days, a page at a time, and the filtered list as a CSV file (the server builds and audits it).
// Commands show by their label in the screen's language, with the name under it (#1654); the file gets a label column.
// The filters start from the URL (#1445), so a link opens it filtered: a proposal's decision links here by its id, and
// the log then lists the decision and the rows of what it ran.
// It speaks in sentences (#3595): each row says what was done ("Đã duyệt đề xuất"), the system's own rows (notifications, event
// dispatch) stay behind a switch, the object is found by name or number and not by an id, and the command's name, the ids and
// the detail line the system recorded are in the row's detail sheet. The CSV file keeps every raw field.
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useLocale, useMessages, useTranslations } from 'use-intl';
import { AUDIT_OUTCOMES, AUDIT_PAGE_SIZE, type AuditCursor, type AuditEntry, type AuditFilter, type AuditOutcome, type AuditPage } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { AuditDetail } from '../components/audit-detail.tsx';
import { AuditTargetPicker } from '../components/audit-target-picker.tsx';
import { DateInput } from '../components/date-input.tsx';
import { DataTable, Empty, ErrorText, PageHeader, PageSkeleton, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { installedModules } from '../lib/org-modules.ts';
import { type ChipVariant } from '../lib/status.ts';
import { auditFilter, auditForm, commandLabel, isSystemRow, lowerFirst, nextAuditCursor, withCommandLabels, type AuditFilterForm, type AuditSearch, type CommandLabels } from '../lib/audit.ts';

const OUTCOME_BADGE: Record<AuditOutcome, ChipVariant> = {
  ok: 'success',
  // "Chờ duyệt", the same words and chip as a proposal waiting for a person (#2000).
  pending_approval: 'proposal',
  denied: 'warning',
  failed: 'destructive',
};

const EMPTY: AuditFilterForm = { actor: '', command: '', outcome: '', target: '', targetType: '', from: '', to: '' };

// While the system's rows are hidden, a page that is mostly theirs would show a short or empty list with a "Load more" under it, so the
// screen asks for the next pages by itself until it has a half page of rows to show, or this many pages.
const AUTO_PAGES = 20;

// The filters of the URL start the screen's form; another link to the screen starts it again.
export function AuditPage() {
  const search: AuditSearch = useSearch({ strict: false });
  return <AuditLog key={JSON.stringify(search)} search={search} />;
}

function AuditLog({ search }: { search: AuditSearch }) {
  const t = useTranslations('audit');
  const f = useFormat();
  const locale = useLocale();
  const messages = useMessages();
  const labels = messages.commands;
  const done: CommandLabels = messages.audit.done;
  const objects: CommandLabels = messages.audit.objects;
  const org = useQuery(orpc.org.get.queryOptions());
  const canRead = org.data?.role === 'owner' || org.data?.role === 'admin';
  const [form, setForm] = useState<AuditFilterForm>(() => auditForm(search));
  // What the object filter shows for the object it holds: the name the owner picked, else its kind.
  const [targetLabel, setTargetLabel] = useState<string | null>(null);
  const [showSystem, setShowSystem] = useState(search.system === '1');
  const [opened, setOpened] = useState<AuditEntry | null>(null);
  const filter: AuditFilter = auditFilter(form);
  const objectName = (type: string | null | undefined): string | null => (type ? commandLabel(objects, type) : null);
  const searchable = installedModules().includes('finance');
  const commands = useQuery({ ...orpc.org.auditCommands.queryOptions(), enabled: canRead });
  const commandOptions = (commands.data ?? [])
    .map((name) => ({ name, label: commandLabel(labels, name) ?? name }))
    .sort((a, b) => a.label.localeCompare(b.label, locale));
  // A page at a time (the server sends at most AUDIT_PAGE_SIZE); Load more asks for the rows after the last one.
  const log = useInfiniteQuery({
    ...orpc.org.audit.infiniteOptions({
      input: (before: AuditCursor | undefined) => ({ ...filter, ...(before ? { before } : {}) }),
      initialPageParam: undefined as AuditCursor | undefined,
      getNextPageParam: (page: AuditPage) => nextAuditCursor(page),
      placeholderData: keepPreviousData,
    }),
    enabled: canRead,
  });
  const all = log.data?.pages.flatMap((p) => p.items) ?? [];
  // The system's rows stay out of the list unless asked for: by the switch, or by a filter that names them (the system as the
  // actor, a command, an object) since that filter would find nothing else.
  const hideSystem = !showSystem && form.actor !== 'system' && form.command === '' && !filter.targetId;
  const rows = hideSystem ? all.filter((r) => !isSystemRow(r)) : all;
  const hidden = all.length - rows.length;
  const pageCount = log.data?.pages.length ?? 0;
  const { hasNextPage, isFetchingNextPage, fetchNextPage, error: logError } = log;
  useEffect(() => {
    if (hideSystem && rows.length < AUDIT_PAGE_SIZE / 2 && hasNextPage && !isFetchingNextPage && !logError && pageCount < AUTO_PAGES) void fetchNextPage();
  }, [hideSystem, rows.length, hasNextPage, isFetchingNextPage, logError, pageCount, fetchNextPage]);
  const exportCsv = useMutation({
    mutationFn: () => client.org.auditExport(filter),
    onSuccess: (file) => {
      const csv = withCommandLabels(file.csv, (name) => commandLabel(labels, name));
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = file.filename;
      a.click();
      // Some browsers still read the link a moment after the click.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  });
  const set = (key: keyof AuditFilterForm) => (e: { target: { value: string } }) => setForm((prev) => ({ ...prev, [key]: e.target.value }));
  // What one row says it did: the sentence of a command the screen knows, else its label after "Đã"; a row that did not go
  // through says it tried, and the outcome chip next to it says how it ended.
  const sentence = (r: AuditEntry): string => {
    const label = commandLabel(labels, r.command);
    if (r.outcome === 'ok') {
      const known = commandLabel(done, r.command);
      if (known !== null) return known;
      return label === null ? t('unknownDone') : t('genericDone', { action: lowerFirst(label) });
    }
    return label === null ? t('unknownTried') : t('triedTo', { action: lowerFirst(label) });
  };
  // Who did it, as one line (the actor cell and the detail sheet say the same words).
  const actorOf = (r: AuditEntry): string => (r.via ? t('viaMcp', { name: r.via.clientName }) : r.actorType === 'system' ? t('system') : (r.actorName ?? t('former')));
  const narrowed = Object.values(form).some((v) => v !== '');

  if (org.isLoading) return <PageSkeleton columns={5} />;
  if (org.error) return <ErrorText>{errorMessage(org.error)}</ErrorText>;
  if (!canRead) return <Empty title={t('forbidden')} />;

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <Button loading={exportCsv.isPending} size="lg" variant="outline" onClick={() => exportCsv.mutate()}>
            {t('export')}
          </Button>
        }
      />
      {exportCsv.error && (
        <div className="mb-4">
          <ErrorText>{errorMessage(exportCsv.error)}</ErrorText>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('filterActor')}</span>
          <NativeSelect className="mt-1 w-52" value={form.actor} onChange={set('actor')}>
            <NativeSelectOption value="">{t('anyone')}</NativeSelectOption>
            {org.data?.members.map((m) => (
              <NativeSelectOption key={m.userId} value={m.userId}>
                {m.displayName ?? m.email}
              </NativeSelectOption>
            ))}
            <NativeSelectOption value="system">{t('system')}</NativeSelectOption>
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('filterCommand')}</span>
          <NativeSelect className="mt-1 w-64" value={form.command} onChange={set('command')}>
            <NativeSelectOption value="">{t('anyCommand')}</NativeSelectOption>
            {commandOptions.map((c) => (
              <NativeSelectOption key={c.name} value={c.name}>
                {c.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('filterOutcome')}</span>
          <NativeSelect className="mt-1 w-40" value={form.outcome} onChange={set('outcome')}>
            <NativeSelectOption value="">{t('anyOutcome')}</NativeSelectOption>
            {AUDIT_OUTCOMES.map((o) => (
              <NativeSelectOption key={o} value={o}>
                {t(`outcomes.${o}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {!filter.targetId && searchable && (
          <div className="text-xs">
            <span className="text-subtle-foreground">{t('target.label')}</span>
            <AuditTargetPicker
              onPick={({ id, label }) => {
                setForm((prev) => ({ ...prev, target: id, targetType: '' }));
                setTargetLabel(label);
              }}
            />
          </div>
        )}
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('from')}</span>
          <DateInput value={form.from} onChange={(value) => set('from')({ target: { value } })} className="mt-1 w-44" />
        </label>
        <label className="text-xs">
          <span className="text-subtle-foreground">{t('to')}</span>
          <DateInput value={form.to} onChange={(value) => set('to')({ target: { value } })} className="mt-1 w-44" />
        </label>
        {narrowed && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setForm(EMPTY);
              setTargetLabel(null);
            }}
          >
            {t('clear')}
          </Button>
        )}
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox checked={showSystem} onCheckedChange={(on) => setShowSystem(on === true)} />
          {t('showSystem')}
        </label>
        {filter.targetId && (
          <p className="flex items-center gap-2 text-xs text-subtle-foreground">
            {t('target.only', { name: targetLabel ?? objectName(filter.targetType) ?? t('target.some') })}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setForm((prev) => ({ ...prev, target: '', targetType: '' }));
                setTargetLabel(null);
              }}
            >
              {t('target.clear')}
            </Button>
          </p>
        )}
      </div>
      {log.isLoading ? (
        <TableSkeleton columns={5} />
      ) : log.error && all.length === 0 ? (
        <ErrorText>{errorMessage(log.error)}</ErrorText>
      ) : rows.length === 0 && !log.hasNextPage ? (
        <Empty title={hidden > 0 ? t('onlySystem', { count: String(hidden) }) : t('empty')} />
      ) : rows.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-muted-foreground">{log.isFetchingNextPage ? t('searchingMore') : t('noneYet')}</p>
          <Button variant="outline" size="sm" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
            {t('loadMore')}
          </Button>
        </div>
      ) : (
        <>
          <DataTable head={[t('columns.at'), t('columns.actor'), t('columns.what'), t('columns.outcome'), t('columns.target'), t('columns.detail')]}>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="px-4 py-3 whitespace-nowrap text-muted-foreground">{f.dateTime(r.at)}</TableCell>
                <TableCell className="px-4 py-3 text-foreground">
                  {actorOf(r)}
                  {r.via && r.actorType === 'user' && r.actorName && <p className="text-xs text-subtle-foreground">{t('viaMcpOf', { name: r.actorName })}</p>}
                  {r.via && <p className="text-xs text-subtle-foreground">{t('viaMcpNote')}</p>}
                  {r.actorType === 'agent' && <p className="text-xs text-subtle-foreground">{t('agent')}</p>}
                </TableCell>
                <TableCell className="px-4 py-3 text-foreground">{sentence(r)}</TableCell>
                <TableCell className="px-4 py-3">
                  <Badge variant={OUTCOME_BADGE[r.outcome]}>{t(`outcomes.${r.outcome}`)}</Badge>
                </TableCell>
                <TableCell className="px-4 py-3 text-xs text-muted-foreground">
                  {objectName(r.targetType) ?? (r.targetId ? t('target.generic') : null)}
                  {r.targetId && (
                    <button
                      type="button"
                      aria-label={`${t('target.rowsOfThis')}: ${sentence(r)}`}
                      className="block text-link hover:underline"
                      onClick={() => {
                        // The type is not kept: a proposal's rows include what it ran, whose objects are of other types (#1445).
                        setForm((prev) => ({ ...prev, target: r.targetId ?? '', targetType: '' }));
                        setTargetLabel(objectName(r.targetType));
                      }}
                    >
                      {t('target.rowsOfThis')}
                    </button>
                  )}
                </TableCell>
                <TableCell className="px-4 py-3">
                  <Button variant="ghost" size="sm" aria-label={`${t('detail.open')}: ${sentence(r)}`} onClick={() => setOpened(r)}>
                    {t('detail.open')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          {hideSystem && hidden > 0 && <p className="mt-3 text-xs text-muted-foreground">{t('systemHidden', { count: String(hidden) })}</p>}
          {log.error && (
            <div className="mt-3">
              <ErrorText>{errorMessage(log.error)}</ErrorText>
            </div>
          )}
          {log.hasNextPage && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <p className="text-xs text-muted-foreground">{t('more', { count: String(rows.length) })}</p>
              <Button variant="outline" size="sm" disabled={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
                {t('loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
      {opened && <AuditDetail row={opened} sentence={sentence(opened)} actor={actorOf(opened)} objectName={objectName(opened.targetType)} onClose={() => setOpened(null)} />}
    </>
  );
}
