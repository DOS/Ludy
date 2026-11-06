// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace orders on the "Hàng hóa" screen (#2515, ADR-0045): the shipped lines of an imported report that named no stock item ("Dòng đơn hàng sàn chưa gán"), assigned here to an
// item (which teaches the SKU for that platform only when asked, so the next report moves it by itself), and the confirmed orders with how far each has got. A marketplace order is not an invoice
// and no buyer value is ever shown: the importer never read one.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { MARKETPLACE_PLATFORM_KEYS, MARKETPLACE_STAGE_KEYS, type MarketplaceUnassignedLine, type StockItem } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { DataTable, ErrorText, TableSkeleton } from './ui.tsx';

const NUM = 'px-4 py-3 text-right tabular-nums';

// An assignment moves stock, so the items and their on-hand figures refresh with the marketplace lists.
const refresh = async () => {
  await Promise.all([queryClient.invalidateQueries({ queryKey: orpc.marketplace.key() }), queryClient.invalidateQueries({ queryKey: orpc.stock.key() })]);
};

function UnassignedRow({ line, items, canWrite }: { line: MarketplaceUnassignedLine; items: StockItem[]; canWrite: boolean }) {
  const t = useTranslations('stock');
  const f = useFormat();
  const [itemId, setItemId] = useState('');
  const [factor, setFactor] = useState('1');
  // Not remembered unless asked: a wrong item or factor cannot be undone yet, and a remembered one would repeat on every later report.
  const [teach, setTeach] = useState(false);
  const assign = useMutation({ mutationFn: () => client.marketplace.assign({ lineId: line.lineId, itemId, factor: factor.trim(), teach, idempotencyKey: crypto.randomUUID() }), onSuccess: refresh });
  const choices = items.filter((i) => i.active && i.legalEntityId === line.legalEntityId);
  const id = `mkt-unassigned-${line.lineId}`;
  return (
    <TableRow data-testid="marketplace-unassigned-line">
      <TableCell className="px-4 py-3">
        <div>{line.orderNo}</div>
        <div className="text-xs text-subtle-foreground">
          {t(`marketplace.platforms.${line.platform}`)}
          {line.orderedAt ? ` · ${f.date(line.orderedAt)}` : ''} · {t(`marketplace.stages.${line.stage}`)}
        </div>
      </TableCell>
      <TableCell className="px-4 py-3">{line.sku ?? line.itemName ?? t('marketplace.noSku')}</TableCell>
      <TableCell className={NUM}>{line.quantity}</TableCell>
      <TableCell className="px-4 py-3">
        {canWrite ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-item`} className="sr-only">
                {t('pickItem')}
              </Label>
              <NativeSelect id={`${id}-item`} value={itemId} onChange={(e) => setItemId(e.target.value)}>
                <NativeSelectOption value="">{t('pickItem')}</NativeSelectOption>
                {choices.map((i) => (
                  <NativeSelectOption key={i.id} value={i.id}>
                    {i.code} {i.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-factor`} className="sr-only">
                {t('factor')}
              </Label>
              <Input id={`${id}-factor`} className="w-20" value={factor} inputMode="decimal" title={t('marketplace.factorHint')} onChange={(e) => setFactor(e.target.value)} />
            </div>
            <label className="flex items-center gap-1 text-xs text-subtle-foreground">
              <input type="checkbox" checked={teach} onChange={(e) => setTeach(e.target.checked)} />
              {t('marketplace.teach')}
            </label>
            <Button size="sm" loading={assign.isPending} disabled={itemId === '' || factor.trim() === ''} onClick={() => assign.mutate()} data-testid="marketplace-assign">
              {t('assign')}
            </Button>
          </div>
        ) : null}
        {assign.error && <ErrorText>{errorMessage(assign.error)}</ErrorText>}
      </TableCell>
    </TableRow>
  );
}

// The shipped lines that name no item. Shown only while there are some; empty when every shipped line has found its item.
export function MarketplaceUnassigned({ legalEntityId, ready, items, canWrite }: { legalEntityId: string | undefined; ready: boolean; items: StockItem[]; canWrite: boolean }) {
  const t = useTranslations('stock');
  const unassigned = useQuery({ ...orpc.marketplace.unassigned.queryOptions({ input: { legalEntityId } }), enabled: ready });
  const lines = unassigned.data ?? [];
  if (unassigned.error) return <ErrorText>{errorMessage(unassigned.error)}</ErrorText>;
  if (lines.length === 0) return null;
  return (
    <section className="mb-8" aria-label={t('marketplace.unassignedTitle')} data-testid="marketplace-unassigned">
      <h2 className="text-base font-medium text-foreground">{t('marketplace.unassignedTitle')}</h2>
      <p className="mb-3 text-sm text-subtle-foreground">{t('marketplace.unassignedHint')}</p>
      {canWrite && items.filter((i) => i.active).length === 0 && <p className="mb-3 text-sm text-foreground">{t('noItemsToAssign')}</p>}
      <DataTable head={[t('marketplace.order'), t('marketplace.sku'), t('quantity'), '']} numeric={[2]}>
        {lines.map((line) => (
          <UnassignedRow key={line.lineId} line={line} items={items} canWrite={canWrite} />
        ))}
      </DataTable>
    </section>
  );
}

// Takes a line back from its item (#2633): asks once, and offers to forget the SKU when it was remembered for the wrong item. The stock comes back and the line is unassigned again.
function UnassignButton({ lineId, hasSku }: { lineId: string; hasSku: boolean }) {
  const t = useTranslations('stock');
  const [confirming, setConfirming] = useState(false);
  const [forget, setForget] = useState(false);
  const unassign = useMutation({ mutationFn: () => client.marketplace.unassign({ lineId, forget, idempotencyKey: crypto.randomUUID() }), onSuccess: refresh, onSettled: () => setConfirming(false) });
  return confirming ? (
    <span className="ml-2 inline-flex flex-wrap items-center gap-2">
      {hasSku && (
        <label className="flex items-center gap-1 text-xs text-subtle-foreground">
          <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} />
          {t('marketplace.unassignForget')}
        </label>
      )}
      <Button variant="ghost" size="sm" loading={unassign.isPending} onClick={() => unassign.mutate()} data-testid="marketplace-unassign-confirm">
        {t('marketplace.unassignConfirm')}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        {t('cancel')}
      </Button>
      {unassign.error && <ErrorText>{errorMessage(unassign.error)}</ErrorText>}
    </span>
  ) : (
    <Button variant="ghost" size="sm" className="ml-2" title={t('marketplace.unassignHint')} onClick={() => setConfirming(true)} data-testid="marketplace-unassign">
      {t('marketplace.unassign')}
    </Button>
  );
}

// The confirmed orders, newest first, with the item each shipped line moved. Hidden until a first report has been imported.
export function MarketplaceOrders({ legalEntityId, ready, canWrite }: { legalEntityId: string | undefined; ready: boolean; canWrite: boolean }) {
  const t = useTranslations('stock');
  const f = useFormat();
  const [platform, setPlatform] = useState('');
  const [stage, setStage] = useState('');
  const orders = useQuery({
    ...orpc.marketplace.orders.queryOptions({
      input: {
        legalEntityId,
        ...(platform === '' ? {} : { platform: platform as (typeof MARKETPLACE_PLATFORM_KEYS)[number] }),
        ...(stage === '' ? {} : { stage: stage as (typeof MARKETPLACE_STAGE_KEYS)[number] }),
        limit: 50,
      },
    }),
    enabled: ready,
  });
  const list = orders.data ?? [];
  const filtered = platform !== '' || stage !== '';
  // Nothing imported yet and nothing filtered out: the section stays out of the way.
  if (!orders.isPending && !orders.error && list.length === 0 && !filtered) return null;
  return (
    <section className="mt-8" aria-label={t('marketplace.ordersTitle')} data-testid="marketplace-orders">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-base font-medium text-foreground">{t('marketplace.ordersTitle')}</h2>
          <p className="text-sm text-subtle-foreground">{t('marketplace.ordersHint')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="space-y-1">
            <Label htmlFor="mkt-orders-platform" className="sr-only">
              {t('marketplace.platform')}
            </Label>
            <NativeSelect id="mkt-orders-platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <NativeSelectOption value="">{t('marketplace.allPlatforms')}</NativeSelectOption>
              {MARKETPLACE_PLATFORM_KEYS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`marketplace.platforms.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="mkt-orders-stage" className="sr-only">
              {t('marketplace.stage')}
            </Label>
            <NativeSelect id="mkt-orders-stage" value={stage} onChange={(e) => setStage(e.target.value)}>
              <NativeSelectOption value="">{t('marketplace.allStages')}</NativeSelectOption>
              {MARKETPLACE_STAGE_KEYS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`marketplace.stages.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        </div>
      </div>
      {orders.isPending ? (
        <TableSkeleton columns={4} />
      ) : orders.error ? (
        <ErrorText>{errorMessage(orders.error)}</ErrorText>
      ) : list.length === 0 ? (
        <p className="text-sm text-subtle-foreground">{t('marketplace.ordersNone')}</p>
      ) : (
        <DataTable head={[t('marketplace.order'), t('marketplace.platform'), t('marketplace.stage'), t('marketplace.lines')]}>
          {list.map((o) => (
            <TableRow key={o.id} data-testid="marketplace-order">
              <TableCell className="px-4 py-3">
                <div>{o.orderNo}</div>
                {o.orderedAt && <div className="text-xs text-subtle-foreground">{f.date(o.orderedAt)}</div>}
              </TableCell>
              <TableCell className="px-4 py-3">{t(`marketplace.platforms.${o.platform}`)}</TableCell>
              <TableCell className="px-4 py-3">
                <Badge variant={o.stage === 'cancelled' || o.stage === 'returned' ? 'secondary' : 'default'}>{t(`marketplace.stages.${o.stage}`)}</Badge>
              </TableCell>
              <TableCell className="px-4 py-3">
                <ul className="space-y-0.5 text-sm">
                  {o.lines.map((l) => (
                    <li key={l.id}>
                      {l.sku ?? l.itemName ?? t('marketplace.noSku')} × {l.quantity}
                      {l.itemCode ? <span className="text-subtle-foreground"> → {l.itemCode}</span> : null}
                      {l.itemCode && canWrite ? <UnassignButton lineId={l.id} hasSku={l.sku !== null} /> : null}
                    </li>
                  ))}
                </ul>
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </section>
  );
}
