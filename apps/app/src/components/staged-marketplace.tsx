// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order reports that arrived as files and wait for a member (#2515): forwarded to the org's inbound address or dropped in the Inbox. Nothing of them is stored as an order
// until a member imports them. The member decides with what the card shows: the platform the headers say (never chosen by the sender), the legal entity the orders would go to, the period,
// how many orders and lines are at each stage, how they stand against the org's orders and stock items now, and a warning that the column mapping is not confirmed against a real file.
// The report's buyer columns are never read, so none is shown.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { MarketplaceStaged } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { CardSkeleton, ErrorText, Spinner } from './ui.tsx';

// How the staged report stands against the org now, asked for each card.
function Preview({ fileId }: { fileId: string }) {
  const t = useTranslations('inbox.marketplace');
  const preview = useQuery(orpc.marketplace.preview.queryOptions({ input: { fileId } }));
  if (preview.isPending) return <Spinner />;
  if (preview.isError) return <ErrorText>{errorMessage(preview.error)}</ErrorText>;
  const p = preview.data;
  return (
    <>
      <div>
        <dt className="text-subtle-foreground">{t('against')}</dt>
        <dd className="text-foreground tabular-nums" data-testid="staged-marketplace-preview">
          {t('againstValue', { news: p.newLines, known: p.knownLines, advanced: p.advancedLines })}
        </dd>
      </div>
      <div>
        <dt className="text-subtle-foreground">{t('stock')}</dt>
        <dd className="text-foreground tabular-nums">{t('stockValue', { matched: p.matchedLines, unmatched: p.unmatchedLines })}</dd>
      </div>
    </>
  );
}

export function StagedMarketplace({ canDecide, refetchMs }: { canDecide: boolean; refetchMs: number | false }) {
  const t = useTranslations('inbox.marketplace');
  const f = useFormat();
  const listed = useQuery({ ...orpc.marketplace.staged.queryOptions({ input: {} }), refetchInterval: refetchMs, enabled: canDecide });
  const settle = () => void queryClient.invalidateQueries();
  const confirm = useMutation({
    mutationFn: (fileId: string) => client.marketplace.confirm({ fileId, idempotencyKey: crypto.randomUUID() }),
    onSuccess: (result) => {
      settle();
      toast(t('imported', { count: result.newLines + result.updatedLines, moves: result.stockMoves }), 'success');
    },
    onError: (error) => {
      settle();
      toast(errorMessage(error), 'error');
    },
  });
  const reject = useMutation({
    mutationFn: (fileId: string) => client.marketplace.reject({ fileId, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      settle();
      toast(t('skipped'), 'success');
    },
    onError: (error) => {
      settle();
      toast(errorMessage(error), 'error');
    },
  });
  // A viewer neither lists nor decides; a failed list must not look like nothing waiting.
  if (!canDecide) return null;
  if (listed.isError) return <ErrorText>{errorMessage(listed.error)}</ErrorText>;
  if (listed.isPending) return <CardSkeleton className="mt-6" />;
  const staged: MarketplaceStaged[] = listed.data;
  if (staged.length === 0) return null;
  const busy = confirm.isPending || reject.isPending;
  return (
    <section className="mt-6" aria-labelledby="staged-marketplace" data-testid="staged-marketplace">
      <h2 id="staged-marketplace" className="text-sm font-semibold">
        {t('title')}
      </h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('hint')}</p>
      <ul className="mt-3 space-y-2">
        {staged.map((file) => {
          const s = file.summary;
          return (
            <li key={file.fileId}>
              <Card className="block p-4 text-sm" data-testid="staged-marketplace-report">
                <p className="font-medium text-foreground break-words">{file.filename}</p>
                <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-subtle-foreground">{t('platform')}</dt>
                    <dd className="text-foreground">
                      {t(`platforms.${s.platform}`)} {!s.profileConfirmed && <Badge variant="secondary">{t('mappingUnconfirmed')}</Badge>}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-subtle-foreground">{t('entity')}</dt>
                    <dd className="text-foreground">{file.entity?.name ?? t('noEntity')}</dd>
                  </div>
                  <div>
                    <dt className="text-subtle-foreground">{t('period')}</dt>
                    <dd className="text-foreground">{s.from && s.to ? t('range', { from: f.date(s.from), to: f.date(s.to) }) : t('noPeriod')}</dd>
                  </div>
                  <div>
                    <dt className="text-subtle-foreground">{t('orders')}</dt>
                    <dd className="text-foreground tabular-nums">{t('ordersValue', { orders: s.orders, lines: s.lines })}</dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-subtle-foreground">{t('stages')}</dt>
                    <dd className="text-foreground tabular-nums">
                      {t('stagesValue', { placed: s.stages.placed, shipped: s.stages.shipped, completed: s.stages.completed, cancelled: s.stages.cancelled, returned: s.stages.returned, unknown: s.stages.unknown })}
                    </dd>
                  </div>
                  <Preview fileId={file.fileId} />
                </dl>
                {s.unknownStatuses.length > 0 && (
                  <Alert className="mt-3 border-warning/30 bg-warning/10 text-warning" role="note" data-testid="staged-marketplace-unknown">
                    <AlertDescription className="text-warning">{t('unknownStatuses', { statuses: s.unknownStatuses.join(', ') })}</AlertDescription>
                  </Alert>
                )}
                {s.ignoredRows > 0 && (
                  <Alert className="mt-3 border-warning/30 bg-warning/10 text-warning" role="note" data-testid="staged-marketplace-ignored">
                    <AlertDescription className="text-warning">{t('ignoredRows', { count: s.ignoredRows })}</AlertDescription>
                  </Alert>
                )}
                {!s.profileConfirmed && <p className="mt-2 text-xs text-subtle-foreground">{t('mappingHint')}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" loading={confirm.isPending && confirm.variables === file.fileId} disabled={busy} onClick={() => confirm.mutate(file.fileId)} data-testid="staged-marketplace-import">
                    {t('import')}
                  </Button>
                  <Button size="sm" variant="ghost" loading={reject.isPending && reject.variables === file.fileId} disabled={busy} onClick={() => reject.mutate(file.fileId)} data-testid="staged-marketplace-skip">
                    {t('skip')}
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
