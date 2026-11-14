// SPDX-License-Identifier: AGPL-3.0-only
// The "Sàn" screen (#2516 slice D, plan docs/plan/stock-and-marketplaces.md section 8.4, "The payout"): where each platform's money stands in the books. Per platform of the chosen entity:
// the sales posted to 131, what the platform has paid out, what it still owes (the difference) and the fees it kept whose invoice has not come (1388). Read only, from the ledger by the
// platform's party; facts only, no model call and nothing to press. A platform appears once its first settlement is posted; until then the screen says so.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';

export function MarketplaceBalancePage() {
  const t = useTranslations('marketplaceBalance');
  const f = useFormat();
  const entity = useChosenEntity();
  const balance = useQuery({ ...orpc.marketplace.balance.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const rows = balance.data?.rows ?? [];
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {balance.isPending ? (
        <TableSkeleton columns={5} />
      ) : balance.error ? (
        <ErrorText>{errorMessage(balance.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <>
          <DataTable head={[t('platform'), t('salesPosted'), t('paidOut'), t('awaitingPayout'), t('feesAwaitingInvoice')]} numeric={[1, 2, 3, 4]}>
            {rows.map((r) => (
              <TableRow key={`${r.legalEntityId}-${r.platform}`} data-testid="marketplace-balance-row">
                <TableCell className="px-4 py-3">{r.platformName}</TableCell>
                <TableCell className={NUM}>{f.money(r.salesPosted)}</TableCell>
                <TableCell className={NUM}>{f.money(r.paidOut)}</TableCell>
                <TableCell className={NUM} data-testid="marketplace-balance-awaiting">
                  {f.money(r.awaitingPayout)}
                </TableCell>
                <TableCell className={NUM}>{f.money(r.feesAwaitingInvoice)}</TableCell>
              </TableRow>
            ))}
          </DataTable>
          <p className="mt-3 text-sm text-subtle-foreground" data-testid="marketplace-balance-note">
            {t('note')}
          </p>
        </>
      )}
    </>
  );
}
