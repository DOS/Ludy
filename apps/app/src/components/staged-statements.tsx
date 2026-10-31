// SPDX-License-Identifier: AGPL-3.0-only
// Bank statements that arrived as files and wait for a member (#2142): forwarded to the org's inbound address or dropped in
// the Inbox. Nothing of them is stored until a member imports them, so a statement nobody sent in good faith costs nothing:
// the card shows the account, the lines, the period and the totals, and two choices, import and skip.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { FileStatus } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { CardSkeleton, ErrorText } from './ui.tsx';

type Statement = NonNullable<FileStatus['statement']>;

export function StagedStatements({ canDecide, refetchMs }: { canDecide: boolean; refetchMs: number | false }) {
  const t = useTranslations('inbox.staged');
  const f = useFormat();
  // Asked apart from the recent files, which show only the newest: a statement waits however many files came since.
  const listed = useQuery({ ...orpc.files.staged.queryOptions(), refetchInterval: refetchMs });
  const staged = (listed.data ?? []).filter((file): file is FileStatus & { statement: Statement } => file.status === 'staged' && file.statement !== null);
  const settle = () => void queryClient.invalidateQueries();
  const confirm = useMutation(
    orpc.bank.statementConfirm.mutationOptions({
      onSuccess: (result) => {
        settle();
        toast(t('imported', { count: result.counts.new + result.counts.ambiguous }), 'success');
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
        {staged.map((file) => (
          <li key={file.id}>
            <Card className="block p-4 text-sm" data-testid="staged-statement">
              <p className="font-medium text-foreground break-words">{file.filename}</p>
              <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                <div>
                  <dt className="text-subtle-foreground">{t('account')}</dt>
                  <dd className="font-mono text-foreground">{file.statement.bankAccount}</dd>
                </div>
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
              {canDecide ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={() => confirm.mutate({ fileId: file.id, idempotencyKey: crypto.randomUUID() })}>
                    {t('import')}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => reject.mutate({ fileId: file.id, idempotencyKey: crypto.randomUUID() })}>
                    {t('skip')}
                  </Button>
                </div>
              ) : (
                <p className="mt-3 text-xs text-subtle-foreground">{t('needsMember')}</p>
              )}
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
