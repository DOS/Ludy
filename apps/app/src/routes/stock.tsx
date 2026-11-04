// SPDX-License-Identifier: AGPL-3.0-only
// Stock, the "Hàng hóa" screen (#2512, ADR-0045): the items of goods with what is on hand (the sum of their moves, a negative one shown as a warning), the goods lines of posted
// invoices that matched no item and moved nothing yet ("Chưa gán hàng"), assigned here to an item (which also teaches the item that name), and each item's moves, which are
// never edited: a correction is a reversing move. Stock only mirrors the books; nothing here changes an entry. The imported marketplace orders (#2515) list below the report, and
// their shipped lines that named no item wait next to the invoice ones, assigned the same way.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { STOCK_TRADES, vietnamToday, type StockItem, type StockTradeKey, type StockUnassignedLine } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { MarketplaceOrders, MarketplaceUnassigned } from '../components/marketplace-orders.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';

const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.stock.key() });

interface ItemFormState {
  itemId: string | null;
  code: string;
  name: string;
  unit: string;
  stockAccount: string;
  trade: StockTradeKey;
}
const blankItem = (): ItemFormState => ({ itemId: null, code: '', name: '', unit: '', stockAccount: '156', trade: 'goods' });
const fromItem = (i: StockItem): ItemFormState => ({ itemId: i.id, code: i.code, name: i.name, unit: i.unit, stockAccount: i.stockAccount, trade: i.trade });

function ItemForm({ initial, legalEntityId, locked, onClose }: { initial: ItemFormState; legalEntityId: string | undefined; locked: boolean; onClose: () => void }) {
  const t = useTranslations('stock');
  const [form, setForm] = useState(initial);
  const save = useMutation({
    mutationFn: () =>
      client.stock.items.save({ itemId: form.itemId, legalEntityId: legalEntityId ?? null, code: form.code.trim(), name: form.name.trim(), unit: form.unit.trim(), stockAccount: form.stockAccount.trim(), trade: form.trade }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  const set = (patch: Partial<ItemFormState>) => setForm((s) => ({ ...s, ...patch }));
  const id = 'stock-item';
  const ready = form.code.trim() !== '' && form.name.trim() !== '' && form.unit.trim() !== '' && form.stockAccount.trim() !== '';
  return (
    <Card className="mb-6 block p-4" aria-label={form.itemId ? t('editTitle') : t('newTitle')} data-testid="stock-item-form">
      <h2 className="text-base font-medium text-foreground">{form.itemId ? t('editTitle') : t('newTitle')}</h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor={`${id}-code`}>{t('code')}</Label>
          <Input id={`${id}-code`} value={form.code} maxLength={40} disabled={form.itemId !== null} onChange={(e) => set({ code: e.target.value })} />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor={`${id}-name`}>{t('name')}</Label>
          <Input id={`${id}-name`} value={form.name} maxLength={300} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-unit`}>{t('unit')}</Label>
          <Input id={`${id}-unit`} value={form.unit} maxLength={30} disabled={locked} onChange={(e) => set({ unit: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-account`}>{t('account')}</Label>
          <Input id={`${id}-account`} value={form.stockAccount} maxLength={35} inputMode="numeric" disabled={locked} onChange={(e) => set({ stockAccount: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-trade`}>{t('trade')}</Label>
          <NativeSelect id={`${id}-trade`} value={form.trade} onChange={(e) => set({ trade: e.target.value as StockTradeKey })}>
            {STOCK_TRADES.map((k) => (
              <NativeSelectOption key={k} value={k}>
                {t(`trades.${k}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      {locked && <p className="mt-2 text-xs text-subtle-foreground">{t('lockedHint')}</p>}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button loading={save.isPending} disabled={!ready} onClick={() => save.mutate()} data-testid="stock-item-save">
          {t('save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('cancel')}
        </Button>
      </div>
    </Card>
  );
}

function MovesPanel({ item, canWrite, onClose }: { item: StockItem; canWrite: boolean; onClose: () => void }) {
  const t = useTranslations('stock');
  const f = useFormat();
  const moves = useQuery(orpc.stock.moves.list.queryOptions({ input: { itemId: item.id } }));
  const reverse = useMutation({ mutationFn: (moveId: string) => client.stock.moves.reverse({ moveId }), onSuccess: refresh });
  // A reversal cannot be taken back, so the button asks once.
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <Card className="mb-6 block p-4" data-testid="stock-moves">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-medium text-foreground">{t('movesTitle', { name: item.name })}</h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      {moves.isPending ? (
        <TableSkeleton columns={4} />
      ) : moves.error ? (
        <ErrorText>{errorMessage(moves.error)}</ErrorText>
      ) : moves.data.length === 0 ? (
        <p className="mt-3 text-sm text-subtle-foreground">{t('movesEmpty')}</p>
      ) : (
        <DataTable head={[t('moveDate'), t('moveQuantity'), t('moveSource'), '']} numeric={[1]}>
          {moves.data.map((m) => (
            <TableRow key={m.id} data-testid="stock-move">
              <TableCell className="px-4 py-3">{f.date(m.date)}</TableCell>
              <TableCell className={NUM}>{m.quantity}</TableCell>
              <TableCell className="px-4 py-3">{t(`sources.${m.source}`)}</TableCell>
              <TableCell className="px-4 py-3 text-right">
                {m.reversed ? (
                  <Badge variant="secondary">{t('reversed')}</Badge>
                ) : (
                  canWrite &&
                  m.source !== 'reversal' &&
                  (confirming === m.id ? (
                    <span className="inline-flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={reverse.isPending && reverse.variables === m.id}
                        onClick={() => reverse.mutate(m.id, { onSettled: () => setConfirming(null) })}
                        data-testid="stock-move-reverse-confirm"
                      >
                        {t('reverseConfirm')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                        {t('cancel')}
                      </Button>
                    </span>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(m.id)} data-testid="stock-move-reverse">
                      {t('reverse')}
                    </Button>
                  ))
                )}
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
      {reverse.error && <ErrorText>{errorMessage(reverse.error)}</ErrorText>}
    </Card>
  );
}

// The stock card of an item for a month: its moves in order with the balance after each.
function CardPanel({ item, month, onClose }: { item: { id: string; name: string; unit: string }; month: string; onClose: () => void }) {
  const t = useTranslations('stock');
  const f = useFormat();
  const card = useQuery(orpc.stock.card.queryOptions({ input: { itemId: item.id, month } }));
  return (
    <Card className="mb-6 block p-4" data-testid="stock-card">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-medium text-foreground">{t('cardTitle', { name: item.name, month })}</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      {card.isPending ? (
        <TableSkeleton columns={5} />
      ) : card.error ? (
        <ErrorText>{errorMessage(card.error)}</ErrorText>
      ) : (
        <>
          <p className="mt-2 text-sm text-subtle-foreground">
            {t('cardOpening')}: {card.data.openingQuantity} {item.unit} · {t('cardClosing')}: {card.data.closingQuantity} {item.unit}
          </p>
          {card.data.moves.length === 0 ? (
            <p className="mt-3 text-sm text-subtle-foreground">{t('movesEmpty')}</p>
          ) : (
            <DataTable head={[t('moveDate'), t('moveSource'), t('moveQuantity'), t('cardValue'), t('balance')]} numeric={[2, 3, 4]}>
              {card.data.moves.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="px-4 py-3">{f.date(m.date)}</TableCell>
                  <TableCell className="px-4 py-3">{t(`sources.${m.source}`)}</TableCell>
                  <TableCell className={NUM}>{m.quantity}</TableCell>
                  <TableCell className={NUM}>{m.value === null ? '' : f.money(m.value, 'VND')}</TableCell>
                  <TableCell className={NUM}>{m.balance}</TableCell>
                </TableRow>
              ))}
            </DataTable>
          )}
        </>
      )}
    </Card>
  );
}

// Nhập xuất tồn for one month (the weighted average way, provisional): what each item opened, took in, sent out and closed with, in quantity and value.
function ReportSection({ legalEntityId, ready }: { legalEntityId: string | undefined; ready: boolean }) {
  const t = useTranslations('stock');
  const f = useFormat();
  const [month, setMonth] = useState(() => vietnamToday().slice(0, 7));
  // The item whose card is open, taken from its row of the report: the report lists an item that is no longer in use when it has moves, and the item list above does not.
  const [cardOf, setCardOf] = useState<{ id: string; name: string; unit: string } | null>(null);
  const valid = /^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(month);
  const report = useQuery({ ...orpc.stock.report.queryOptions({ input: { month, legalEntityId } }), enabled: ready && valid });
  return (
    <section className="mt-10" aria-label={t('reportTitle')} data-testid="stock-report">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">
            {t('reportTitle')} <Badge variant="secondary">{t('provisional')}</Badge>
          </h2>
          <p className="max-w-3xl text-sm text-subtle-foreground">{t('reportHint')}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="stock-month">{t('month')}</Label>
          <Input id="stock-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
        </div>
      </div>
      {cardOf && valid && <CardPanel key={`${cardOf.id}-${month}`} item={cardOf} month={month} onClose={() => setCardOf(null)} />}
      {!valid ? null : report.isPending ? (
        <TableSkeleton columns={8} />
      ) : report.error ? (
        <ErrorText>{errorMessage(report.error)}</ErrorText>
      ) : report.data.length === 0 ? (
        <p className="text-sm text-subtle-foreground">{t('reportEmpty')}</p>
      ) : (
        <DataTable head={[t('code'), t('name'), t('openingQty'), t('inQty'), t('outQty'), t('closingQty'), t('closingVal'), t('unitCost'), '']} numeric={[2, 3, 4, 5, 6, 7]}>
          {report.data.map((r) => (
            <TableRow key={r.itemId} data-testid="stock-report-row">
              <TableCell className="px-4 py-3">{r.code}</TableCell>
              <TableCell className="px-4 py-3">{r.name}</TableCell>
              <TableCell className={NUM}>{r.openingQuantity}</TableCell>
              <TableCell className={NUM}>{r.inQuantity}</TableCell>
              <TableCell className={NUM}>{r.outQuantity}</TableCell>
              <TableCell className={NUM}>{r.closingQuantity}</TableCell>
              <TableCell className={NUM}>{f.money(r.closingValue, 'VND')}</TableCell>
              <TableCell className={NUM}>{r.unitCost === null ? '' : f.decimal(r.unitCost, 4)}</TableCell>
              <TableCell className="px-4 py-3 text-right">
                <Button variant="ghost" size="sm" onClick={() => setCardOf({ id: r.itemId, name: r.name, unit: r.unit })} data-testid="stock-report-card">
                  {t('card')}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
    </section>
  );
}

function UnassignedRow({ line, items, canWrite }: { line: StockUnassignedLine; items: StockItem[]; canWrite: boolean }) {
  const t = useTranslations('stock');
  const f = useFormat();
  const [itemId, setItemId] = useState('');
  const [factor, setFactor] = useState('1');
  const [teach, setTeach] = useState(true);
  const assign = useMutation({ mutationFn: () => client.stock.assign({ documentId: line.documentId, lineNo: line.lineNo, itemId, factor: factor.trim(), teach }), onSuccess: refresh });
  const choices = items.filter((i) => i.active && i.legalEntityId === line.legalEntityId);
  const id = `unassigned-${line.documentId}-${line.lineNo}`;
  return (
    <TableRow data-testid="stock-unassigned-line">
      <TableCell className="px-4 py-3">
        <div>{line.invoiceSeries}/{line.invoiceNumber}</div>
        <div className="text-xs text-subtle-foreground">{f.date(line.invoiceDate)} · {t(`directions.${line.direction}`)}</div>
      </TableCell>
      <TableCell className="px-4 py-3">{line.description}</TableCell>
      <TableCell className={NUM}>
        {line.quantity} {line.unit ?? ''}
      </TableCell>
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
              <Input id={`${id}-factor`} className="w-20" value={factor} inputMode="decimal" title={t('factorHint')} onChange={(e) => setFactor(e.target.value)} />
            </div>
            <label className="flex items-center gap-1 text-xs text-subtle-foreground">
              <input type="checkbox" checked={teach} onChange={(e) => setTeach(e.target.checked)} />
              {t('teach')}
            </label>
            <Button size="sm" loading={assign.isPending} disabled={itemId === '' || factor.trim() === ''} onClick={() => assign.mutate()} data-testid="stock-assign">
              {t('assign')}
            </Button>
          </div>
        ) : null}
        {assign.error && <ErrorText>{errorMessage(assign.error)}</ErrorText>}
      </TableCell>
    </TableRow>
  );
}

export function StockPage() {
  const t = useTranslations('stock');
  const entity = useChosenEntity();
  const org = useQuery(orpc.org.get.queryOptions());
  const canWrite = org.data?.role === 'owner' || org.data?.role === 'admin' || org.data?.role === 'member';
  const [showInactive, setShowInactive] = useState(false);
  const items = useQuery({ ...orpc.stock.items.list.queryOptions({ input: { legalEntityId: entity.legalEntityId, includeInactive: showInactive } }), enabled: entity.ready });
  const unassigned = useQuery({ ...orpc.stock.unassigned.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const [editing, setEditing] = useState<ItemFormState | null>(null);
  const [viewing, setViewing] = useState<StockItem | null>(null);
  const setActive = useMutation({ mutationFn: (v: { itemId: string; active: boolean }) => client.stock.items.setActive(v), onSuccess: refresh });
  const list = items.data ?? [];
  const negative = list.filter((i) => i.onHand.startsWith('-'));
  const lines = unassigned.data ?? [];

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          canWrite ? (
            <Button disabled={editing !== null} onClick={() => setEditing(blankItem())} data-testid="stock-new">
              {t('new')}
            </Button>
          ) : undefined
        }
      />
      {negative.length > 0 && (
        <Alert className="mb-4" data-testid="stock-negative">
          <AlertDescription>
            <strong>{t('negative')}:</strong> {negative.map((i) => `${i.code} (${i.onHand})`).join(', ')}. {t('negativeHint')}
          </AlertDescription>
        </Alert>
      )}
      {editing && (
        <ItemForm
          key={editing.itemId ?? 'new'}
          initial={editing}
          legalEntityId={entity.legalEntityId}
          locked={editing.itemId !== null && (list.find((i) => i.id === editing.itemId)?.moves ?? 0) > 0}
          onClose={() => setEditing(null)}
        />
      )}
      {viewing && <MovesPanel key={viewing.id} item={viewing} canWrite={canWrite} onClose={() => setViewing(null)} />}

      {lines.length > 0 && (
        <section className="mb-8" aria-label={t('unassignedTitle')} data-testid="stock-unassigned">
          <h2 className="text-base font-medium text-foreground">{t('unassignedTitle')}</h2>
          <p className="mb-3 text-sm text-subtle-foreground">{t('unassignedHint')}</p>
          {canWrite && list.filter((i) => i.active).length === 0 && <p className="mb-3 text-sm text-foreground">{t('noItemsToAssign')}</p>}
          <DataTable head={[t('invoice'), t('description'), t('quantity'), '']} numeric={[2]}>
            {lines.map((line) => (
              <UnassignedRow key={`${line.documentId}-${line.lineNo}`} line={line} items={list} canWrite={canWrite} />
            ))}
          </DataTable>
        </section>
      )}
      {unassigned.error && <ErrorText>{errorMessage(unassigned.error)}</ErrorText>}
      <MarketplaceUnassigned legalEntityId={entity.legalEntityId} ready={entity.ready} items={list} canWrite={canWrite} />

      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-base font-medium text-foreground">{t('items')}</h2>
        <label className="flex items-center gap-1 text-xs text-subtle-foreground">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {t('showInactive')}
        </label>
      </div>
      {items.isPending ? (
        <TableSkeleton columns={5} />
      ) : items.error ? (
        <ErrorText>{errorMessage(items.error)}</ErrorText>
      ) : list.length === 0 ? (
        <Empty title={t('empty')} hint={t('emptyHint')} />
      ) : (
        <DataTable head={[t('code'), t('name'), t('unit'), t('onHand'), '']} numeric={[3]}>
          {list.map((i) => (
            <TableRow key={i.id} data-testid="stock-item">
              <TableCell className="px-4 py-3">{i.code}</TableCell>
              <TableCell className="px-4 py-3">
                {i.name}
                {!i.active && (
                  <Badge className="ml-2" variant="secondary">
                    {t('inactive')}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="px-4 py-3">{i.unit}</TableCell>
              <TableCell className={NUM}>
                {i.onHand}
                {i.onHand.startsWith('-') && (
                  <Badge className="ml-2" variant="destructive">
                    {t('negative')}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="px-4 py-3 text-right">
                <span className="flex justify-end gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setViewing(i)} data-testid="stock-item-moves">
                    {t('moves')}
                  </Button>
                  {canWrite && (
                    <>
                      <Button variant="ghost" size="sm" disabled={editing !== null} onClick={() => setEditing(fromItem(i))} data-testid="stock-item-edit">
                        {t('edit')}
                      </Button>
                      <Button variant="ghost" size="sm" loading={setActive.isPending && setActive.variables?.itemId === i.id} onClick={() => setActive.mutate({ itemId: i.id, active: !i.active })}>
                        {i.active ? t('deactivate') : t('activate')}
                      </Button>
                    </>
                  )}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </DataTable>
      )}
      {setActive.error && <ErrorText>{errorMessage(setActive.error)}</ErrorText>}
      <ReportSection legalEntityId={entity.legalEntityId} ready={entity.ready} />
      <MarketplaceOrders legalEntityId={entity.legalEntityId} ready={entity.ready} />
    </>
  );
}
