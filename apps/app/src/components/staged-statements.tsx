// SPDX-License-Identifier: AGPL-3.0-only
// Bank statements that arrived as files and wait for a member (#2142): forwarded to the org's inbound address or dropped in
// the Inbox. Nothing of them is stored until a member imports them, so a statement nobody sent in good faith costs nothing.
// The member decides with what the card shows (#2191): how the file came (an email proves nothing about its sender), the
// legal entity and the masked account number it is for, the period and totals, a warning for lines whose reference the
// books already hold with other figures, and the lines themselves, one click away, before Import.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { FileStatus } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { CardSkeleton, DataTable, ErrorText, Spinner } from './ui.tsx';

type Statement = NonNullable<FileStatus['statement']>;

// One staged statement's lines, asked for when the member opens them.
function StatementLines({ fileId, shownConflicts }: { fileId: string; shownConflicts: number }) {
  const t = useTranslations('inbox.staged');
  const f = useFormat();
  const lines = useQuery(orpc.bank.statementLines.queryOptions({ input: { fileId } }));
  if (lines.isPending) return <Spinner />;
  if (lines.isError) return <ErrorText>{errorMessage(lines.error)}</ErrorText>;
  const { lines: rows, total, conflicts } = lines.data;
  return (
    <div className="mt-3 space-y-2" data-testid="staged-statement-lines">
      {/* The lines are checked against the books as they are now: a conflict the card's own count did not know of is said here. */}
      {conflicts > shownConflicts && (
        <Alert className="border-warning/30 bg-warning/10 text-warning" role="note" data-testid="staged-new-conflicts">
          <AlertDescription className="text-warning">{t('conflictsNow', { count: conflicts })}</AlertDescription>
        </Alert>
      )}
      {total > rows.length && <p className="text-xs text-subtle-foreground">{t('linesTruncated', { shown: rows.length, total })}</p>}
      <DataTable numeric={[4]} head={[t('colRow'), t('colDate'), t('colReference'), t('colDescription'), t('colAmount')]}>
        {rows.map((row) => (
          <TableRow key={row.rowNo}>
            <TableCell className="px-3 py-2 text-muted-foreground">{row.rowNo}</TableCell>
            <TableCell className="px-3 py-2">{row.date ? f.date(row.date) : ''}</TableCell>
            <TableCell className="px-3 py-2 font-mono text-xs">{row.reference ?? ''}</TableCell>
            <TableCell className="px-3 py-2 text-foreground">
              {row.description}
              {row.status && row.status !== 'new' && (
                <p className="mt-1">
                  <Badge variant={row.status === 'duplicate' ? 'secondary' : 'warning'}>{t(`lineStatus.${row.status}`)}</Badge>
                </p>
              )}
              {row.clash && <p className="mt-1 text-xs text-subtle-foreground">{t('clash', { date: f.date(row.clash.date), amount: f.money(row.clash.amount) })}</p>}
            </TableCell>
            <TableCell className="px-3 py-2 text-right tabular-nums">{row.amount ? f.money(row.amount) : ''}</TableCell>
          </TableRow>
        ))}
      </DataTable>
    </div>
  );
}

// Who brought the file and how: an email carries no proof of its sender, an upload names the member.
function Source({ file, statement }: { file: FileStatus; statement: Statement }) {
  const t = useTranslations('inbox.staged');
  const f = useFormat();
  const when = f.dateTime(file.createdAt);
  if (statement.origin.channel === 'email') return <>{t('sourceEmail', { when })}</>;
  const by = statement.origin.by;
  return <>{by === null ? t('sourceUploadUnknown', { when }) : t('sourceUpload', { name: by, when })}</>;
}

export function StagedStatements({ canDecide, refetchMs }: { canDecide: boolean; refetchMs: number | false }) {
  const t = useTranslations('inbox.staged');
  const f = useFormat();
  // The statement whose lines are open (one at a time keeps the page short).
  const [open, setOpen] = useState<string | null>(null);
  // Asked apart from the recent files, which show only the newest: a statement waits however many files came since.
  const listed = useQuery({ ...orpc.files.staged.queryOptions(), refetchInterval: refetchMs });
  const staged = (listed.data ?? []).filter((file): file is FileStatus & { statement: Statement } => file.status === 'staged' && file.statement !== null);
  const settle = () => void queryClient.invalidateQueries();
  const confirm = useMutation(
    orpc.bank.statementConfirm.mutationOptions({
      onSuccess: (result) => {
        settle();
        toast(t('imported', { count: result.counts.new + result.counts.ambiguous + result.counts.conflict }), 'success');
      },
      onError: (error) => {
        settle();
        toast(errorMessage(error), 'error');
      },
    }),
  );
  const reject = useMutation(
    orpc.bank.statementReject.mutationOptions({
      onSuccess: () => {
        settle();
        toast(t('skipped'), 'success');
      },
      onError: (error) => {
        settle();
        toast(errorMessage(error), 'error');
      },
    }),
  );
  // The file is read again, against the books as they are now (a re-read stages it afresh, with its conflicts counted anew).
  const reread = useMutation(
    orpc.files.reextract.mutationOptions({
      onSuccess: settle,
      onError: (error) => {
        settle();
        toast(errorMessage(error), 'error');
      },
    }),
  );
  // A failed list must not look like no statement waiting, and a list on its way shows the shape of a card.
  if (listed.isError) return <ErrorText>{errorMessage(listed.error)}</ErrorText>;
  if (listed.isPending) return <CardSkeleton className="mt-6" />;
  if (staged.length === 0) return null;
  const busy = confirm.isPending || reject.isPending;
  return (
    <section className="mt-6" aria-labelledby="staged-statements" data-testid="staged-statements">
      <h2 id="staged-statements" className="text-sm font-semibold">
        {t('title')}
      </h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('hint')}</p>
      <ul className="mt-3 space-y-2">
        {staged.map((file) => {
          const shown = open === file.id;
          return (
            <li key={file.id}>
              <Card className="block p-4 text-sm" data-testid="staged-statement">
                <p className="font-medium text-foreground break-words">{file.filename}</p>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <dt className="text-subtle-foreground">{t('source')}</dt>
                    <dd className="text-foreground">
                      <Source file={file} statement={file.statement} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-subtle-foreground">{t('entity')}</dt>
                    <dd className="text-foreground">{file.statement.entity?.name ?? t('noEntity')}</dd>
                  </div>
                  <div>
                    <dt className="text-subtle-foreground">{t('account')}</dt>
                    <dd className="font-mono text-foreground">{file.statement.bankAccount}</dd>
                  </div>
                  {file.statement.accountMask && (
                    <div>
                      <dt className="text-subtle-foreground">{t('accountNumber')}</dt>
                      <dd className="font-mono text-foreground" data-testid="staged-account-mask">
                        {file.statement.accountMask}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="text-subtle-foreground">{t('period')}</dt>
                    <dd className="text-foreground">{file.statement.from && file.statement.to ? t('range', { from: f.date(file.statement.from), to: f.date(file.statement.to) }) : t('noPeriod')}</dd>
                  </div>
                  <div>
                    <dt className="text-subtle-foreground">{t('lines')}</dt>
                    <dd className="text-foreground tabular-nums">{t('linesValue', { lines: f.number(file.statement.lines), news: f.number(file.statement.newLines), duplicates: f.number(file.statement.duplicateLines) })}</dd>
                  </div>
                  <div>
                    <dt className="text-subtle-foreground">{t('totals')}</dt>
                    <dd className="text-foreground tabular-nums">{t('totalsValue', { moneyIn: f.money(file.statement.totalIn), moneyOut: f.money(file.statement.totalOut) })}</dd>
                  </div>
                </dl>
                {file.statement.conflictLines > 0 && (
                  <Alert className="mt-3 border-warning/30 bg-warning/10 text-warning" role="note" data-testid="staged-conflicts">
                    <AlertDescription className="text-warning">{t('conflicts', { count: file.statement.conflictLines })}</AlertDescription>
                  </Alert>
                )}
                {/* Only those who may decide may read the lines (the query is theirs). */}
                {canDecide && (
                  <div className="mt-3">
                    <Button size="sm" variant="ghost" aria-expanded={shown} onClick={() => setOpen(shown ? null : file.id)}>
                      {shown ? t('hideLines') : t('showLines', { lines: file.statement.lines })}
                    </Button>
                    {shown && <StatementLines fileId={file.id} shownConflicts={file.statement.conflictLines} />}
                  </div>
                )}
                {canDecide ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy} onClick={() => confirm.mutate({ fileId: file.id, idempotencyKey: crypto.randomUUID() })}>
                      {t('import')}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate({ fileId: file.id, idempotencyKey: crypto.randomUUID() })}>
                      {t('skip')}
                    </Button>
                    {file.canReextract && (
                      <Button size="sm" variant="ghost" disabled={busy || reread.isPending} onClick={() => reread.mutate({ fileId: file.id, idempotencyKey: crypto.randomUUID() })}>
                        {t('reread')}
                      </Button>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-subtle-foreground">{t('needsMember')}</p>
                )}
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
