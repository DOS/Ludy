// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace income reports that arrived as files and wait for a member (#2516, ADR-0045): the platform's own statement of what it paid for the orders of a period, forwarded to the org's
// inbound address or dropped in the Inbox. Nothing is stored until a member confirms, and then one settlement with its lines. The member decides with what the card shows: the platform the
// headers say (never chosen by the sender), the legal entity, the period of the payments, the totals of every amount column, what no column explains, the net the file states (or plainly that it
// states none), and why the report cannot be confirmed when it cannot. Nothing here is automatic and no model is called: code decides every number and a person decides the report. The reader
// has no field for the buyer, so none is shown.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { MarketplaceIncomePreview, MarketplaceIncomeStaged } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { toast } from '../lib/toast.ts';
import { CardSkeleton, ErrorText, Spinner } from './ui.tsx';

// The staged list the kernel returns holds at most this many reports (the newest); the card says so when it is full.
export const INCOME_STAGED_CAP = 20;

// The amount columns of a report in the order a seller reads them: what was sold, what came off, and the net the platform paid.
const TOTALS = ['sales', 'sellerDiscount', 'commission', 'serviceFee', 'paymentFee', 'shipping', 'taxWithheld', 'refund', 'other', 'net'] as const;

const isZero = (value: string) => /^-?0+(\.0+)?$/.test(value);

// Why the report cannot be confirmed now, in words a member can act on (the same words as the refusal the confirm would answer with).
function Blockers({ summary, preview }: { summary: MarketplaceIncomeStaged['summary']; preview: MarketplaceIncomePreview }) {
  const t = useTranslations('inbox.marketplaceIncome');
  const f = useFormat();
  if (preview.blockers.length === 0) return null;
  const platform = t(`platforms.${summary.platform}`);
  return (
    <Alert className="mt-3 border-destructive/30 bg-destructive/10 text-destructive" role="alert" data-testid="staged-income-blockers">
      <AlertDescription className="text-destructive">
        <ul className="list-disc space-y-1 pl-4">
          {preview.blockers.map((code) => (
            <li key={code} data-testid={`staged-income-blocker-${code}`}>
              {code === 'PERIOD_UNKNOWN' && t('blockers.PERIOD_UNKNOWN', { platform })}
              {code === 'TOTAL_MISMATCH' && t('blockers.TOTAL_MISMATCH', { platform, lines: f.money(preview.linesNet), stated: f.money(summary.statedNet ?? '') })}
              {code === 'UNKNOWN_ORDERS' &&
                t('blockers.UNKNOWN_ORDERS', {
                  platform,
                  count: preview.unknownOrders,
                  named: preview.unknownOrderNos.join(', '),
                  more: Math.max(0, preview.unknownOrders - preview.unknownOrderNos.length),
                })}
              {code === 'OVERLAP' && t('blockers.OVERLAP', { platform, from: preview.overlap ? f.date(preview.overlap.periodStart) : '', to: preview.overlap ? f.date(preview.overlap.periodEnd) : '' })}
              {code === 'REPEATED_LINES' && t('blockers.REPEATED_LINES', { platform, count: preview.repeatedLines })}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function IncomeCard({
  file,
  busy,
  confirming,
  rejecting,
  onConfirm,
  onReject,
}: {
  file: MarketplaceIncomeStaged;
  busy: boolean;
  confirming: boolean;
  rejecting: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const t = useTranslations('inbox.marketplaceIncome');
  const f = useFormat();
  const s = file.summary;
  const preview = useQuery(orpc.marketplace.incomePreview.queryOptions({ input: { fileId: file.fileId } }));
  const blocked = preview.isSuccess && preview.data.blockers.length > 0;
  return (
    <Card className="block p-4 text-sm" data-testid="staged-income-report">
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
          <dd className="text-foreground">{s.periodStart && s.periodEnd ? t('range', { from: f.date(s.periodStart), to: f.date(s.periodEnd) }) : t('noPeriod')}</dd>
        </div>
        <div>
          <dt className="text-subtle-foreground">{t('orders')}</dt>
          <dd className="text-foreground tabular-nums">{t('ordersValue', { orders: s.orders, lines: s.lines })}</dd>
        </div>
      </dl>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2" aria-label={t('totals')} data-testid="staged-income-totals">
        {TOTALS.map((key) => (
          <div key={key} className="flex justify-between gap-2" data-testid={`staged-income-total-${key}`}>
            <dt className="text-subtle-foreground">{t(`totalsLabels.${key}`)}</dt>
            <dd className={key === 'other' && !isZero(s.totals.other) ? 'font-medium text-warning tabular-nums' : 'text-foreground tabular-nums'}>{f.money(s.totals[key])}</dd>
          </div>
        ))}
      </dl>
      {!isZero(s.totals.other) && <p className="mt-2 text-xs text-warning">{t('otherHint')}</p>}
      <p className="mt-3 text-xs text-foreground" data-testid="staged-income-net">
        {preview.isPending ? <Spinner /> : null}
        {preview.isSuccess && preview.data.fileStatesNet && t('netStated', { net: f.money(preview.data.reportNet) })}
        {preview.isSuccess && !preview.data.fileStatesNet && t('netNotStated', { net: f.money(preview.data.reportNet) })}
      </p>
      {preview.isError && <ErrorText>{errorMessage(preview.error)}</ErrorText>}
      {preview.isSuccess && <Blockers summary={s} preview={preview.data} />}
      {s.ignoredRows > 0 && (
        <Alert className="mt-3 border-warning/30 bg-warning/10 text-warning" role="note" data-testid="staged-income-ignored">
          <AlertDescription className="text-warning">{t('ignoredRows', { count: s.ignoredRows })}</AlertDescription>
        </Alert>
      )}
      {!s.profileConfirmed && <p className="mt-2 text-xs text-subtle-foreground">{t('mappingHint')}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" loading={confirming} disabled={busy || blocked || !preview.isSuccess} onClick={onConfirm} data-testid="staged-income-confirm">
          {t('confirm')}
        </Button>
        <Button size="sm" variant="ghost" loading={rejecting} disabled={busy} onClick={onReject} data-testid="staged-income-reject">
          {t('reject')}
        </Button>
      </div>
    </Card>
  );
}

export function StagedMarketplaceIncome({ canDecide, refetchMs }: { canDecide: boolean; refetchMs: number | false }) {
  const t = useTranslations('inbox.marketplaceIncome');
  const f = useFormat();
  const listed = useQuery({ ...orpc.marketplace.incomeStaged.queryOptions({ input: {} }), refetchInterval: refetchMs, enabled: canDecide });
  const settle = () => void queryClient.invalidateQueries();
  const confirm = useMutation({
    mutationFn: (fileId: string) => client.marketplace.incomeConfirm({ fileId, idempotencyKey: crypto.randomUUID() }),
    onSuccess: (result) => {
      settle();
      toast(t('confirmed', { count: result.lines, net: f.money(result.reportNet) }), 'success');
    },
    // A refusal arrives in Vietnamese or English from the kernel's error catalog; the list is refreshed so a report decided meanwhile leaves it.
    onError: (error) => {
      settle();
      toast(errorMessage(error), 'error');
    },
  });
  const reject = useMutation({
    mutationFn: (fileId: string) => client.marketplace.incomeReject({ fileId, idempotencyKey: crypto.randomUUID() }),
    onSuccess: () => {
      settle();
      toast(t('rejected'), 'success');
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
  const staged: MarketplaceIncomeStaged[] = listed.data;
  if (staged.length === 0) return null;
  const busy = confirm.isPending || reject.isPending;
  return (
    <section className="mt-6" aria-labelledby="staged-income" data-testid="staged-income">
      <h2 id="staged-income" className="text-sm font-semibold">
        {t('title')}
      </h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('hint')}</p>
      {staged.length >= INCOME_STAGED_CAP && (
        <p className="mt-1 text-xs text-warning" data-testid="staged-income-cap">
          {t('cap', { count: INCOME_STAGED_CAP })}
        </p>
      )}
      <ul className="mt-3 space-y-2">
        {staged.map((file) => (
          <li key={file.fileId}>
            <IncomeCard
              file={file}
              busy={busy}
              confirming={confirm.isPending && confirm.variables === file.fileId}
              rejecting={reject.isPending && reject.variables === file.fileId}
              onConfirm={() => confirm.mutate(file.fileId)}
              onReject={() => reject.mutate(file.fileId)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
