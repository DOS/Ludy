// SPDX-License-Identifier: AGPL-3.0-only
// The "Sàn" screen (#2516 slice D, plan docs/plan/stock-and-marketplaces.md section 8.4): what each marketplace the business sells on still owes it, read from the ledger (account 131 under the platform's
// party), and the fees waiting for their own invoice (account 1388). Facts only: it posts nothing and asks no model; it shows zeros until the first settlement is posted. Every role that reads the books
// reads it, in the entity chosen in the shell.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Card } from '@crove/ui/components/card';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { CardSkeleton, DataTable, Empty, ErrorText, PageHeader } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { platformLabel } from '../lib/marketplace-balance.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';

export function MarketplaceBalancePage() {
  const t = useTranslations('marketplaceBalance');
  const f = useFormat();
  const entity = useChosenEntity();
  const balance = useQuery({ ...orpc.marketplaceBalance.get.queryOptions({ input: entity.legalEntityId ? { legalEntityId: entity.legalEntityId } : {} }), enabled: entity.ready });
  const data = balance.data;
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {balance.isLoading || !entity.ready ? (
        <CardSkeleton />
      ) : balance.error ? (
        <ErrorText>{errorMessage(balance.error)}</ErrorText>
      ) : data && data.platforms.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : data ? (
        <Card className="block p-4" data-testid="marketplace-balance">
          <p className="mb-3 text-sm text-muted-foreground">{t('asOf', { date: f.date(data.asOf) })}</p>
          <DataTable
            numeric={[1, 2, 3, 4]}
            head={[t('columns.platform'), t('columns.sales'), t('columns.payouts'), t('columns.owed'), t('columns.fees')]}
            foot={
              <TableRow>
                <TableCell className="px-4 py-3 font-medium text-foreground">{t('total')}</TableCell>
                <TableCell className={NUM}>{f.money(data.totals.sales)}</TableCell>
                <TableCell className={NUM}>{f.money(data.totals.payouts)}</TableCell>
                <TableCell className={`${NUM} font-medium`} data-testid="marketplace-owed-total">
                  {f.money(data.totals.owed)}
                </TableCell>
                <TableCell className={NUM}>{f.money(data.totals.feesAwaitingInvoice)}</TableCell>
              </TableRow>
            }
          >
            {data.platforms.map((p) => (
              <TableRow key={p.platform} data-testid={`marketplace-row-${p.platform}`}>
                <TableCell className="px-4 py-3 text-foreground">{platformLabel(p.platform, (key) => t(`platforms.${key}`))}</TableCell>
                <TableCell className={NUM}>{f.money(p.sales)}</TableCell>
                <TableCell className={NUM}>{f.money(p.payouts)}</TableCell>
                <TableCell className={`${NUM} font-medium`}>{f.money(p.owed)}</TableCell>
                <TableCell className={NUM}>{f.money(p.feesAwaitingInvoice)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
          <p className="mt-3 text-xs text-subtle-foreground">{t('note')}</p>
        </Card>
      ) : null}
    </>
  );
}
