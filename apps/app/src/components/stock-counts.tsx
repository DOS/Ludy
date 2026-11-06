// SPDX-License-Identifier: AGPL-3.0-only
// The counts of stock (kiểm kê, #2513 part b) on the "Hàng hóa" screen: a member counts the goods on a day and types what was counted per item; the books' quantity of the day is shown beside
// it, and the difference is worked out and priced by the server. A draft with differences is sent for approval (an owner or an admin approves the entry in the Inbox, and approving writes the
// adjustments); one that differs nowhere is confirmed at once. A confirmed count is final: a count that was wrong is put right by a new one.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { vietnamToday, type StockCount } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { DataTable, ErrorText, TableSkeleton } from './ui.tsx';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';
const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.stock.key() });
const isZero = (value: string) => /^-?0+(?:\.0+)?$/.test(value);
// A number as typed, in the way of the language of the screen: Vietnamese groups thousands with dots and writes decimals with a comma (1.500,5), English the other way round (1,500.5). The server
// gets plain digits with a dot.
const decimalOf = (value: string, locale: string) => (locale.startsWith('vi') ? value.trim().replace(/\./g, '').replace(',', '.') : value.trim().replace(/,/g, ''));

const STATUS_VARIANT = { draft: 'secondary', confirmed: 'success', cancelled: 'outline' } as const;

// Makes a draft count: the day, the norm for a shortage, and what was counted of each item (an item left empty is not counted).
function CountForm({ legalEntityId, onDone, onCancel }: { legalEntityId: string | undefined; onDone: () => void; onCancel: () => void }) {
  const t = useTranslations('stock.counts');
  const f = useFormat();
  const { locale } = useLocaleSetting();
  const [date, setDate] = useState(() => vietnamToday());
  const [norm, setNorm] = useState('0');
  const [note, setNote] = useState('');
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [costs, setCosts] = useState<Record<string, string>>({});
  const validDate = /^20[0-9]{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/.test(date);
  const preview = useQuery({ ...orpc.stock.counts.preview.queryOptions({ input: { countDate: date, legalEntityId } }), enabled: validDate });
  const lines = (preview.data ?? []).filter((r) => (counted[r.itemId] ?? '').trim() !== '');
  const create = useMutation({
    mutationFn: () =>
      client.stock.counts.create({
        countDate: date,
        lossNormPercent: decimalOf(norm, locale),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(legalEntityId ? { legalEntityId } : {}),
        lines: lines.map((r) => ({
          itemId: r.itemId,
          countedQuantity: decimalOf(counted[r.itemId] ?? '', locale),
          ...((costs[r.itemId] ?? '').trim() ? { unitCost: decimalOf(costs[r.itemId] ?? '', locale) } : {}),
        })),
      }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  return (
    <Card className="mb-6 block p-4" data-testid="stock-count-form">
      <form
        className="space-y-4"
        aria-label={t('new')}
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <h3 className="text-base font-medium text-foreground">{t('new')}</h3>
        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="stock-count-date">{t('date')}</Label>
            <Input id="stock-count-date" type="date" max={vietnamToday()} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="stock-count-norm">{t('norm')}</Label>
            <Input id="stock-count-norm" inputMode="decimal" className="w-28" value={norm} onChange={(e) => setNorm(e.target.value)} />
          </div>
          <div className="min-w-48 flex-1 space-y-1">
            <Label htmlFor="stock-count-note">{t('note')}</Label>
            <Input id="stock-count-note" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>
        <p className="max-w-3xl text-xs text-subtle-foreground">{t('normHint')}</p>
        {preview.isPending && validDate ? (
          <TableSkeleton columns={5} />
        ) : preview.error ? (
          <ErrorText>{errorMessage(preview.error)}</ErrorText>
        ) : (
          <DataTable head={[t('code'), t('name'), t('book'), t('counted'), t('unitCost')]} numeric={[2, 3, 4]}>
            {(preview.data ?? []).map((r) => (
              <TableRow key={r.itemId} data-testid="stock-count-item">
                <TableCell className="px-4 py-3">{r.code}</TableCell>
                <TableCell className="px-4 py-3">{r.name}</TableCell>
                <TableCell className={NUM}>
                  {r.bookQuantity} {r.unit}
                </TableCell>
                <TableCell className="px-4 py-3 text-right">
                  <Input
                    aria-label={`${t('counted')} ${r.code}`}
                    inputMode="decimal"
                    className="ml-auto w-28 text-right"
                    value={counted[r.itemId] ?? ''}
                    onChange={(e) => setCounted({ ...counted, [r.itemId]: e.target.value })}
                  />
                </TableCell>
                <TableCell className="px-4 py-3 text-right">
                  <Input
                    aria-label={`${t('unitCost')} ${r.code}`}
                    title={t('unitCostHint')}
                    placeholder={r.averageCost === null ? '' : f.money(r.averageCost, 'VND')}
                    inputMode="decimal"
                    className="ml-auto w-28 text-right"
                    value={costs[r.itemId] ?? ''}
                    onChange={(e) => setCosts({ ...costs, [r.itemId]: e.target.value })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
        )}
        {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
        <div className="flex gap-2">
          <Button type="submit" loading={create.isPending} disabled={create.isPending || lines.length === 0 || !validDate} data-testid="stock-count-save">
            {t('save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={create.isPending}>
            {t('cancel')}
          </Button>
        </div>
        {lines.length === 0 && <p className="text-xs text-subtle-foreground">{t('noLines')}</p>}
      </form>
    </Card>
  );
}

function CountCard({ count, canWrite, slug }: { count: StockCount; canWrite: boolean; slug: string }) {
  const t = useTranslations('stock.counts');
  const f = useFormat();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const differs = count.lines.some((l) => !isZero(l.difference));
  const unpriced = count.lines.filter((l) => !isZero(l.difference) && l.unitCost === null);
  const request = useMutation({
    mutationFn: () => client.inbox.request({ command: 'finance.stock.count_confirm', idempotencyKey, input: { countId: count.id } }),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  const confirmPlain = useMutation({ mutationFn: () => client.stock.counts.confirmEmpty({ countId: count.id }), onSettled: () => void refresh() });
  const cancel = useMutation({ mutationFn: () => client.stock.counts.cancel({ countId: count.id }), onSettled: () => void refresh() });
  const error = request.error ?? confirmPlain.error ?? cancel.error;
  return (
    <Card className="mb-4 block p-4" data-testid="stock-count">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium text-foreground">
          {t('countOf', { date: f.date(count.countDate) })}{' '}
          <Badge variant={STATUS_VARIANT[count.status]} data-testid="stock-count-status">
            {t(`statuses.${count.status}`)}
          </Badge>
        </h3>
        <p className="text-xs text-subtle-foreground">{t('normShort', { norm: count.lossNormPercent })}</p>
      </div>
      {count.note && <p className="mt-1 text-sm text-subtle-foreground">{count.note}</p>}
      <DataTable head={[t('code'), t('name'), t('book'), t('counted'), t('difference'), t('value')]} numeric={[2, 3, 4, 5]}>
        {count.lines.map((l) => (
          <TableRow key={l.itemId} data-testid="stock-count-line">
            <TableCell className="px-4 py-3">{l.code}</TableCell>
            <TableCell className="px-4 py-3">{l.name}</TableCell>
            <TableCell className={NUM}>{l.bookQuantity}</TableCell>
            <TableCell className={NUM}>{l.countedQuantity}</TableCell>
            <TableCell className={NUM}>{isZero(l.difference) ? '' : l.difference}</TableCell>
            <TableCell className={NUM}>{isZero(l.value) ? '' : f.money(l.value, 'VND')}</TableCell>
          </TableRow>
        ))}
      </DataTable>
      {unpriced.length > 0 && count.status === 'draft' && (
        <p className="mt-2 text-xs text-warning" data-testid="stock-count-unpriced">
          {t('unpricedWarn', { codes: unpriced.map((l) => l.code).join(', ') })}
        </p>
      )}
      {request.data && count.status === 'draft' ? (
        <Alert className="mt-3">
          <AlertDescription>
            {t('requested', { date: f.date(count.countDate) })}{' '}
            <Link to="/o/$slug/inbox/$id" params={{ slug, id: request.data.proposalId }} className="text-link underline">
              {t('viewProposal')}
            </Link>{' '}
            {/* A proposal that was rejected leaves the count a draft: it can be sent again, under a new key. */}
            <button
              type="button"
              className="text-link underline"
              onClick={() => {
                request.reset();
                setIdempotencyKey(crypto.randomUUID());
              }}
            >
              {t('requestAgain')}
            </button>
          </AlertDescription>
        </Alert>
      ) : (
        count.status === 'draft' &&
        canWrite && (
          <div className="mt-3 flex flex-wrap gap-2">
            {differs ? (
              <Button loading={request.isPending} disabled={unpriced.length > 0} onClick={() => request.mutate()} data-testid="stock-count-request">
                {t('request')}
              </Button>
            ) : (
              <Button loading={confirmPlain.isPending} onClick={() => confirmPlain.mutate()} data-testid="stock-count-confirm">
                {t('confirmPlain')}
              </Button>
            )}
            <Button variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate()} data-testid="stock-count-cancel">
              {t('cancelDraft')}
            </Button>
          </div>
        )
      )}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </Card>
  );
}

export function StockCounts({ legalEntityId, ready, canWrite }: { legalEntityId: string | undefined; ready: boolean; canWrite: boolean }) {
  const t = useTranslations('stock.counts');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [making, setMaking] = useState(false);
  const counts = useQuery({ ...orpc.stock.counts.list.queryOptions({ input: { legalEntityId } }), enabled: ready });
  return (
    <section className="mt-10" aria-label={t('title')} data-testid="stock-counts">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
          <p className="max-w-3xl text-sm text-subtle-foreground">{t('hint')}</p>
        </div>
        {canWrite && !making && (
          <Button variant="outline" onClick={() => setMaking(true)} data-testid="stock-count-new">
            {t('new')}
          </Button>
        )}
      </div>
      {making && <CountForm legalEntityId={legalEntityId} onDone={() => setMaking(false)} onCancel={() => setMaking(false)} />}
      {counts.isPending ? (
        <TableSkeleton columns={6} />
      ) : counts.error ? (
        <ErrorText>{errorMessage(counts.error)}</ErrorText>
      ) : counts.data.length === 0 ? (
        <p className="text-sm text-subtle-foreground">{t('empty')}</p>
      ) : (
        counts.data.map((c) => <CountCard key={c.id} count={c} canWrite={canWrite} slug={slug} />)
      )}
    </section>
  );
}
