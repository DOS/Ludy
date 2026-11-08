// SPDX-License-Identifier: AGPL-3.0-only
// The customer's decision on a sent quote and the deal's sales orders (#2696, ADR-0050, docs/plan/crm-quotes.md step Q4). A person records that the customer agreed
// (which makes one sales order from the quote as it was sent) or declined; nothing here invoices or moves stock. A person marks each goods line of an order delivered (#2697,
// Q4b); the stock move is Kế toán's own command and is shown as "Chưa ghi kho", off, until it exists. "Lập hóa đơn" is Kế toán's command, called on a click
// with the order's facts: it is shown disabled with a note until that command exists, and the screen never writes a finance table. The core works with AI off; the sales
// coworker may suggest moving the deal, but never records a decision.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { QUOTE_ACCEPTED_VIA, SALES_ORDER_REASON_MAX, vietnamToday, type QuoteAcceptedVia, type QuoteSummary, type SalesOrder, type SalesOrderSummary } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { refreshQuoteQueries } from './quote-send.tsx';
import { ErrorText, Field } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { formatDate, formatMoney } from '../lib/format.ts';

const refreshOrderQueries = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.crm.salesOrders.key() });
  refreshQuoteQueries();
};

// "Khách đã đồng ý": the day the customer said yes (today by default, never later) and how it arrived. The server checks both again and refuses an expired quote.
function AcceptPanel({ quote, onDone }: { quote: QuoteSummary; onDone: () => void }) {
  const t = useTranslations('quotes.decision');
  const [via, setVia] = useState<QuoteAcceptedVia | ''>('');
  const [date, setDate] = useState(vietnamToday());
  const accept = useMutation(
    orpc.crm.quotes.accept.mutationOptions({
      onSuccess: () => {
        refreshOrderQueries();
        onDone();
      },
      onError: refreshOrderQueries,
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    accept.mutate({ quoteId: quote.id, version: quote.version, acceptedOn: date, ...(via ? { acceptedVia: via } : {}) });
  };
  return (
    <form onSubmit={submit} className="w-full space-y-2 rounded-md border border-border p-3" aria-label={t('acceptTitle')} data-testid="quote-accept">
      <h4 className="text-sm font-medium text-foreground">{t('acceptTitle')}</h4>
      <p className="text-xs text-muted-foreground">{t('acceptHint')}</p>
      <Field label={t('date')}>{(c) => <Input {...c} type="date" max={vietnamToday()} required value={date} onChange={(e) => setDate(e.target.value)} />}</Field>
      <Field label={t('via')}>
        {(c) => (
          <NativeSelect {...c} className="w-full" value={via} onChange={(e) => setVia(e.target.value as QuoteAcceptedVia | '')}>
            <option value="">{t('viaNone')}</option>
            {QUOTE_ACCEPTED_VIA.map((v) => (
              <option key={v} value={v}>
                {t(`viaOptions.${v}`)}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      {accept.error && <ErrorText>{errorMessage(accept.error)}</ErrorText>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={accept.isPending}>
          {t('acceptYes')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t('back')}
        </Button>
      </div>
    </form>
  );
}

// "Khách từ chối": an optional reason; the quote stays as it was sent and can be revised.
function DeclinePanel({ quote, onDone }: { quote: QuoteSummary; onDone: () => void }) {
  const t = useTranslations('quotes.decision');
  const [reason, setReason] = useState('');
  const decline = useMutation(
    orpc.crm.quotes.decline.mutationOptions({
      onSuccess: () => {
        refreshOrderQueries();
        onDone();
      },
      onError: refreshOrderQueries,
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    decline.mutate({ quoteId: quote.id, version: quote.version, ...(reason.trim() ? { reason: reason.trim() } : {}) });
  };
  return (
    <form onSubmit={submit} className="w-full space-y-2 rounded-md border border-border p-3" aria-label={t('declineTitle')} data-testid="quote-decline">
      <h4 className="text-sm font-medium text-foreground">{t('declineTitle')}</h4>
      <p className="text-xs text-muted-foreground">{t('declineHint')}</p>
      <Field label={t('reason')}>{(c) => <Input {...c} maxLength={SALES_ORDER_REASON_MAX} autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      {decline.error && <ErrorText>{errorMessage(decline.error)}</ErrorText>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="outline" loading={decline.isPending}>
          {t('declineYes')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t('back')}
        </Button>
      </div>
    </form>
  );
}

// The two buttons of a sent quote that has not lapsed, and the panel one of them opens. Owners, admins and members only (the server says the same).
export function QuoteDecision({ quote, canEdit }: { quote: QuoteSummary; canEdit: boolean }) {
  const t = useTranslations('quotes.decision');
  const [mode, setMode] = useState<'accept' | 'decline' | null>(null);
  if (!canEdit || quote.status !== 'sent' || quote.expired) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setMode(mode === 'accept' ? null : 'accept')} aria-expanded={mode === 'accept'} data-testid="quote-accept-open">
        {t('accept')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setMode(mode === 'decline' ? null : 'decline')} aria-expanded={mode === 'decline'} data-testid="quote-decline-open">
        {t('decline')}
      </Button>
      {mode === 'accept' && <AcceptPanel quote={quote} onDone={() => setMode(null)} />}
      {mode === 'decline' && <DeclinePanel quote={quote} onDone={() => setMode(null)} />}
    </>
  );
}

function CancelPanel({ order, onDone }: { order: SalesOrderSummary; onDone: () => void }) {
  const t = useTranslations('quotes.orders');
  const back = useTranslations('quotes.decision')('back');
  const [reason, setReason] = useState('');
  const cancel = useMutation(
    orpc.crm.salesOrders.cancel.mutationOptions({
      onSuccess: () => {
        refreshOrderQueries();
        onDone();
      },
      onError: refreshOrderQueries,
    }),
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    cancel.mutate({ orderId: order.id, version: order.version, reason: reason.trim() });
  };
  return (
    <form onSubmit={submit} className="w-full space-y-2 rounded-md border border-border p-3" aria-label={t('cancelTitle')} data-testid="order-cancel">
      <h4 className="text-sm font-medium text-foreground">{t('cancelTitle')}</h4>
      <p className="text-xs text-muted-foreground">{t('cancelHint')}</p>
      <Field label={t('cancelReason')}>{(c) => <Input {...c} required maxLength={SALES_ORDER_REASON_MAX} autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
      {cancel.error && <ErrorText>{errorMessage(cancel.error)}</ErrorText>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="outline" loading={cancel.isPending} disabled={reason.trim() === ''}>
          {t('cancelYes')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {back}
        </Button>
      </div>
    </form>
  );
}

// The goods lines of one order and whether each was delivered (Q4b, #2697). "Đã giao" records the delivery of a whole line (today, or the day the goods left), "Hoàn giao"
// takes it back; a service line has none. Stock moves only through Kế toán's own command, which does not exist yet: the line says so and the screen never pretends it did.
function DeliveryRow({ order, line, canEdit }: { order: SalesOrder; line: SalesOrder['lines'][number]; canEdit: boolean }) {
  const t = useTranslations('quotes.orders.delivery');
  const { locale } = useLocaleSetting();
  const delivery = order.deliveries.find((d) => d.lineNo === line.lineNo);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.crm.salesOrders.key() });
  };
  const deliver = useMutation(orpc.crm.salesOrders.deliver.mutationOptions({ onSuccess: refresh, onError: refresh }));
  const undeliver = useMutation(orpc.crm.salesOrders.undeliver.mutationOptions({ onSuccess: refresh, onError: refresh }));
  const error = deliver.error ?? undeliver.error;
  const live = delivery !== undefined && !delivery.reversed;
  return (
    <li className="space-y-1 rounded-md border border-border px-3 py-2 text-sm" data-testid="order-delivery-line">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-foreground">{t('line', { no: String(line.lineNo), description: line.description })}</p>
          <p className="text-xs text-muted-foreground">{t('quantity', { quantity: line.quantity ?? '', unit: line.unit ?? '' }).trim()}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {delivery === undefined ? (
            <Badge variant="outline">{t('notDelivered')}</Badge>
          ) : delivery.reversed ? (
            <Badge variant="outline">{t('reversed', { date: formatDate(delivery.deliveredOn, locale) })}</Badge>
          ) : (
            <Badge variant="success">{t('delivered', { date: formatDate(delivery.deliveredOn, locale) })}</Badge>
          )}
          {canEdit && delivery === undefined && (
            <Button size="sm" variant="outline" loading={deliver.isPending} onClick={() => deliver.mutate({ orderId: order.id, lineNo: line.lineNo })} data-testid="order-delivery-mark">
              {t('mark')}
            </Button>
          )}
          {canEdit && live && (
            <Button size="sm" variant="ghost" loading={undeliver.isPending} onClick={() => undeliver.mutate({ orderId: order.id, lineNo: line.lineNo })} data-testid="order-delivery-undo">
              {t('takeBack')}
            </Button>
          )}
        </div>
      </div>
      {live && (
        <p className="text-xs text-muted-foreground" data-testid="order-delivery-stock">
          {t('stockPending')}: {t('stockSoon')}
        </p>
      )}
      {error && <ErrorText>{errorMessage(error)}</ErrorText>}
    </li>
  );
}

export function DeliveryPanel({ orderId, canEdit }: { orderId: string; canEdit: boolean }) {
  const t = useTranslations('quotes.orders.delivery');
  const order = useQuery(orpc.crm.salesOrders.get.queryOptions({ input: { orderId } }));
  const goods = order.data?.lines.filter((l) => l.kind === 'item') ?? [];
  return (
    <section className="w-full space-y-2 rounded-md border border-border p-3" aria-label={t('title')} data-testid="order-delivery">
      <h4 className="text-sm font-medium text-foreground">{t('title')}</h4>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      {order.error ? (
        <ErrorText>{errorMessage(order.error)}</ErrorText>
      ) : order.data && goods.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noGoods')}</p>
      ) : (
        <ul className="space-y-2">
          {order.data &&
            goods.map((l) => (
              <DeliveryRow key={l.lineNo} order={order.data} line={l} canEdit={canEdit} />
            ))}
        </ul>
      )}
    </section>
  );
}

function OrderRow({ order, canEdit }: { order: SalesOrderSummary; canEdit: boolean }) {
  const t = useTranslations('quotes.orders');
  const { locale } = useLocaleSetting();
  const [cancelling, setCancelling] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const confirmed = order.status === 'confirmed';
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm" data-testid="order-row">
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium text-foreground">
          {order.number} <Badge variant={confirmed ? 'success' : 'destructive'}>{t(`status.${order.status}`)}</Badge>
        </p>
        <p className="text-xs text-muted-foreground">{t('meta', { date: formatDate(order.orderDate, locale), count: String(order.lineCount), total: formatMoney(order.total, locale, 'VND') })}</p>
        {order.quoteNumber && <p className="text-xs text-muted-foreground">{t('fromQuote', { quote: order.quoteNumber })}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {confirmed && (
          // Kế toán makes the invoice draft with its own command, called with the order's facts (`crm.sales_order.handoff`). Until that command exists the button
          // is off and says so, so a person never believes an invoice was made.
          <Button size="sm" variant="outline" disabled aria-describedby={`order-invoice-note-${order.id}`} data-testid="order-invoice">
            {t('invoice')}
          </Button>
        )}
        {confirmed && (
          <Button size="sm" variant="outline" onClick={() => setDelivering((v) => !v)} aria-expanded={delivering} data-testid="order-delivery-open">
            {t('delivery.open')}
          </Button>
        )}
        {confirmed && canEdit && (
          <Button size="sm" variant="ghost" onClick={() => setCancelling((v) => !v)} aria-expanded={cancelling} data-testid="order-cancel-open">
            {t('cancelOrder')}
          </Button>
        )}
      </div>
      {confirmed && (
        <p id={`order-invoice-note-${order.id}`} className="w-full text-xs text-muted-foreground">
          {t('invoiceSoon')}
        </p>
      )}
      {delivering && confirmed && <DeliveryPanel orderId={order.id} canEdit={canEdit} />}
      {cancelling && confirmed && canEdit && <CancelPanel order={order} onDone={() => setCancelling(false)} />}
    </li>
  );
}

// The deal's sales orders, newest first, under its quotes.
export function DealOrders({ dealId, canEdit }: { dealId: string; canEdit: boolean }) {
  const t = useTranslations('quotes.orders');
  const orders = useQuery(orpc.crm.salesOrders.byDeal.queryOptions({ input: { dealId } }));
  return (
    <section className="space-y-2" aria-label={t('title')} data-testid="deal-orders">
      <h4 className="text-sm font-medium text-foreground">{t('title')}</h4>
      {orders.error ? (
        <ErrorText>{errorMessage(orders.error)}</ErrorText>
      ) : orders.data?.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="space-y-2">
          {orders.data?.map((o) => (
            <OrderRow key={o.id} order={o} canEdit={canEdit} />
          ))}
        </ul>
      )}
    </section>
  );
}

