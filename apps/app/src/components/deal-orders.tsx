// SPDX-License-Identifier: AGPL-3.0-only
// The customer's decision on a sent quote and the deal's sales orders (#2696, ADR-0050, docs/plan/crm-quotes.md step Q4). A person records that the customer agreed
// (which makes one sales order from the quote as it was sent) or declined; nothing here invoices or moves stock. A person marks each goods line of an order delivered (#2697,
// Q4b). Kế toán's two commands (#2818) are called on a person's click with the order's facts, read fresh from `crm.salesOrders.handoff`: "Lập hóa đơn" makes a draft
// from the lines without a discount, and the stock move follows the click on "Đã giao" or "Hoàn giao" ("Chưa ghi kho" and a retry when it fails, the same key each time so a
// retry never moves stock twice). Both show only when the finance module runs, and the screen never writes a finance table. The core works with AI off; the sales coworker
// may suggest moving the deal, but never records a decision.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { ORDER_LINE_INVOICE_ORDERS_MAX, QUOTE_ACCEPTED_VIA, SALES_ORDER_REASON_MAX, vietnamToday, type QuoteAcceptedVia, type QuoteSummary, type SalesOrder, type SalesOrderHandoff, type SalesOrderSummary } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { DateInput } from './date-input.tsx';
import { NativeSelect } from '@ludy/ui/components/native-select';
import { refreshQuoteQueries } from './quote-send.tsx';
import { ErrorText, Field } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { keyFor, type KeyHolder } from '../lib/ads.ts';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { ApiError } from '../lib/errors.ts';
import { allDiscounted, invoiceInput, invoicePlan, lineStateOf, nothingLeft } from '../lib/order-handoff.ts';
import { formatDate, formatMoney } from '../lib/format.ts';
import { installedModules } from '../lib/org-modules.ts';

// Kế toán's commands exist only where its module runs; a business without it sees the order screen as before, with no invoice or stock button.
const financeInstalled = () => installedModules().includes('finance');
const errorCode = (e: unknown): string | null => (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : null);

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
      <Field label={t('date')}>{(c) => <DateInput {...c} max={vietnamToday()} required value={date} onChange={setDate} />}</Field>
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

// The panel a sent quote's "Ghi nhận khách đồng ý" or "Ghi nhận khách từ chối" opens (#3645: the buttons are in the quote row, the second in its menu). Owners, admins and members only (the server says the same).
export type QuoteDecisionMode = 'accept' | 'decline';
export const canDecideQuote = (quote: Pick<QuoteSummary, 'status' | 'expired'>, canEdit: boolean): boolean => canEdit && quote.status === 'sent' && !quote.expired;

export function QuoteDecisionPanel({ quote, mode, onDone }: { quote: QuoteSummary; mode: QuoteDecisionMode; onDone: () => void }) {
  return mode === 'accept' ? <AcceptPanel quote={quote} onDone={onDone} /> : <DeclinePanel quote={quote} onDone={onDone} />;
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
// takes it back; a service line has none. Where Kế toán runs, the same click then asks it to move the stock (#2818): "Chưa ghi kho" and a retry say it did not, and a retry keeps
// the key so it cannot move stock twice. A stock failure never undoes the delivery; the two are separate commands.
type StockStep = { action: 'deliver' | 'return'; date: string };

function DeliveryRow({ order, line, canEdit }: { order: SalesOrder; line: SalesOrder['lines'][number]; canEdit: boolean }) {
  const t = useTranslations('quotes.orders.delivery');
  const { locale } = useLocaleSetting();
  const { slug } = useParams({ strict: false }) as { slug: string };
  const withStock = financeInstalled();
  const delivery = order.deliveries.find((d) => d.lineNo === line.lineNo);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.crm.salesOrders.key() });
  };
  const attempt = useRef<KeyHolder | null>(null);
  const stock = useMutation({
    mutationFn: async (step: StockStep) => {
      const handoff = await client.crm.salesOrders.handoff({ orderId: order.id });
      attempt.current = keyFor(attempt.current, JSON.stringify({ orderId: order.id, lineNo: line.lineNo, ...step }));
      return client.stock.moveFromOrderLine({ handoff, lineNo: line.lineNo, date: step.date, action: step.action, idempotencyKey: attempt.current.key });
    },
    onSuccess: () => {
      attempt.current = null;
      void queryClient.invalidateQueries({ queryKey: orpc.stock.key() });
    },
  });
  const deliver = useMutation(
    orpc.crm.salesOrders.deliver.mutationOptions({
      onSuccess: (done) => {
        refresh();
        if (withStock) stock.mutate({ action: 'deliver', date: done.delivery.deliveredOn });
      },
      onError: refresh,
    }),
  );
  const undeliver = useMutation(
    orpc.crm.salesOrders.undeliver.mutationOptions({
      onSuccess: () => {
        refresh();
        if (withStock) stock.mutate({ action: 'return', date: vietnamToday() });
      },
      onError: refresh,
    }),
  );
  const error = deliver.error ?? undeliver.error;
  const live = delivery !== undefined && !delivery.reversed;
  // What the stock command last said, or what to ask when nothing was asked in this session (the order does not remember: asking again is safe, the answer is the same).
  const step: StockStep | null = delivery === undefined ? null : delivery.reversed ? { action: 'return', date: vietnamToday() } : { action: 'deliver', date: delivery.deliveredOn };
  // A stock answer counts only for the step the row is at now (another person may have reversed the delivery since), else the row offers the current step.
  const stockCurrent = stock.variables?.action === step?.action;
  const stockOk = stock.isSuccess && stockCurrent;
  const stockShown = withStock && canEdit && step !== null && !(stockOk && stock.data.status === 'service');
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
            <Button size="sm" variant="ghost" loading={undeliver.isPending} disabled={stock.isPending} onClick={() => undeliver.mutate({ orderId: order.id, lineNo: line.lineNo })} data-testid="order-delivery-undo">
              {t('takeBack')}
            </Button>
          )}
        </div>
      </div>
      {stockShown && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="order-delivery-stock">
          {stock.isPending ? (
            <span>{t('stockWriting')}</span>
          ) : stockOk ? (
            <span>{stock.variables.action === 'return' ? t('stockReturned') : t('stockDone')}</span>
          ) : (
            <span>{stock.isError && stockCurrent ? t('stockPending') : t('stockUnknown')}</span>
          )}
          {canEdit && !stock.isPending && !stockOk && (
            <Button size="sm" variant="outline" onClick={() => stock.mutate(stockCurrent && stock.variables ? stock.variables : step)} data-testid="order-delivery-stock-retry">
              {stock.isError && stockCurrent ? t('stockRetry') : step.action === 'return' ? t('stockRecordReturn') : t('stockRecord')}
            </Button>
          )}
          {stock.isError && errorCode(stock.error) === 'STOCK_ORDER_LINE_NO_ITEM' && (
            <Link to="/o/$slug/stock" params={{ slug }} className="text-link hover:underline" data-testid="order-delivery-stock-teach">
              {t('stockTeach')}
            </Link>
          )}
        </div>
      )}
      {stock.isError && <ErrorText>{errorMessage(stock.error)}</ErrorText>}
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

// "Lập hóa đơn" (#2818): Kế toán makes a draft from the order's lines. A line with a discount is not invoiced yet (the draft takes a price after the discount), so those
// lines are left out and named; the click sends the rest, read fresh from the order, and a retry of the same call keeps its key. The draft is Kế toán's: a link opens its list.
// `held` is what Kế toán says each line is on (#3477): a hint that names the lines still open and hides the button when none is; the server still refuses a line twice.
function useInvoiceDraft(order: SalesOrderSummary, enabled: boolean, held: ReadonlyMap<number, 'draft' | 'issued'> | undefined) {
  const read = useQuery({ ...orpc.crm.salesOrders.handoff.queryOptions({ input: { orderId: order.id } }), enabled });
  const attempt = useRef<KeyHolder | null>(null);
  // What the last call sent while its answer is unknown (the connection dropped): a click again sends exactly that with the same key, so the server replays the draft it made instead of
  // the screen counting the lines that draft now holds as taken and refusing. A definite refusal from the server drops it, and the next click reads everything fresh.
  const sent = useRef<{ handoff: SalesOrderHandoff; lineNos?: number[] } | null>(null);
  const plan = invoicePlan(read.data?.lines ?? [], new Set(held?.keys()));
  const skipped = plan.skipped;
  const allSkipped = allDiscounted(plan);
  const hidden = nothingLeft(plan);
  const invoice = useMutation({
    mutationFn: async () => {
      if (sent.current !== null && attempt.current !== null) {
        const again = sent.current;
        const draft = await client.einvoice.drafts.fromOrder({ ...again, idempotencyKey: attempt.current.key });
        return { draft, skipped: invoicePlan(again.handoff.lines).skipped };
      }
      const handoff = await client.crm.salesOrders.handoff({ orderId: order.id });
      // The lines a draft holds, read fresh at the click; if the read fails the click goes on and the server decides.
      const fresh = await client.einvoice.drafts.orderLines({ orderIds: [order.id] }).catch(() => null);
      const heldNow = new Set((fresh?.orders.find((o) => o.orderId === order.id)?.lines ?? []).map((l) => l.lineNo));
      const input = invoiceInput(handoff, heldNow);
      if (input === null) throw new ApiError(heldNow.size > 0 ? 'ORDER_NOTHING_TO_INVOICE' : 'ORDER_LINE_DISCOUNTED', 409, null);
      attempt.current = keyFor(attempt.current, JSON.stringify(input));
      sent.current = input;
      const draft = await client.einvoice.drafts.fromOrder({ ...input, idempotencyKey: attempt.current.key });
      // The lines left out are those of this handoff, not of the preview, which may be old or not loaded.
      return { draft, skipped: invoicePlan(handoff.lines, heldNow).skipped };
    },
    onSuccess: () => {
      attempt.current = null;
      sent.current = null;
      void queryClient.invalidateQueries({ queryKey: orpc.einvoice.drafts.key() });
    },
    // A refusal (the order changed, a line was already invoiced) leaves both readings stale: read the order and what Kế toán holds on it again. Only a refusal from the server ends the
    // attempt; a dropped connection keeps it, so the next click replays it.
    onError: (error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        attempt.current = null;
        sent.current = null;
      }
      void queryClient.invalidateQueries({ queryKey: orpc.crm.salesOrders.key() });
      void queryClient.invalidateQueries({ queryKey: orpc.einvoice.drafts.key() });
    },
  });
  return { invoice, skipped, allSkipped, hidden, open: plan.open, partial: plan.claimed.length > 0 || plan.skipped.length > 0 };
}

function InvoiceNote({ orderId, draft }: { orderId: string; draft: ReturnType<typeof useInvoiceDraft> }) {
  const t = useTranslations('quotes.orders');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { invoice, skipped, allSkipped, open, partial } = draft;
  return (
    <p id={`order-invoice-note-${orderId}`} className="w-full space-y-1 text-xs text-muted-foreground">
      <span className="block">{t('invoiceHint')}</span>
      {partial && open.length > 0 && (
        <span className="block" data-testid="order-invoice-open-lines">
          {t('invoiceOpenLines', { lines: open.join(', ') })}
        </span>
      )}
      {allSkipped ? <span className="block">{t('invoiceAllDiscounted')}</span> : skipped.length > 0 ? <span className="block">{t('invoiceDiscounted', { lines: skipped.join(', ') })}</span> : null}
      {invoice.isSuccess && (
        <span className="block" data-testid="order-invoice-done">
          {t('invoiceDone')} {invoice.data.skipped.length > 0 ? `${t('invoiceDiscounted', { lines: invoice.data.skipped.join(', ') })} ` : ''}
          <Link to="/o/$slug/sales-invoices" params={{ slug }} className="text-link hover:underline">
            {t('invoiceOpen')}
          </Link>
        </span>
      )}
      {invoice.error && <ErrorText>{errorMessage(invoice.error)}</ErrorText>}
    </p>
  );
}

// The goods lines of a confirmed order and what Kế toán holds on each: "Chưa lập hóa đơn", "Đã lập nháp" or "Đã phát hành" (#3477, plan crm-quotes.md 6.2). Read from the drafts
// that name the order, never stored on it; shown only where the finance module runs. A line with no draft reads "none".
function InvoiceLines({ orderId, held }: { orderId: string; held: ReadonlyMap<number, 'draft' | 'issued'> | undefined }) {
  const t = useTranslations('quotes.orders');
  const order = useQuery(orpc.crm.salesOrders.get.queryOptions({ input: { orderId } }));
  const goods = order.data?.lines.filter((l) => l.kind === 'item') ?? [];
  if (goods.length === 0) return null;
  return (
    <ul className="w-full space-y-1" aria-label={t('invoiceLines')} data-testid="order-invoice-lines">
      {goods.map((l) => {
        const state = lineStateOf(held, l.lineNo);
        return (
          <li key={l.lineNo} className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground" data-testid="order-invoice-line" data-state={state}>
            <span className="min-w-0">{t('invoiceLine', { no: String(l.lineNo), description: l.description })}</span>
            <Badge variant={state === 'issued' ? 'success' : state === 'draft' ? 'warning' : 'outline'}>{t(`invoiceState.${state}`)}</Badge>
          </li>
        );
      })}
    </ul>
  );
}

function OrderRow({ order, canEdit, held }: { order: SalesOrderSummary; canEdit: boolean; held: ReadonlyMap<number, 'draft' | 'issued'> | undefined }) {
  const t = useTranslations('quotes.orders');
  const { locale } = useLocaleSetting();
  const [cancelling, setCancelling] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const confirmed = order.status === 'confirmed';
  const withFinance = financeInstalled();
  const draft = useInvoiceDraft(order, confirmed && withFinance && canEdit, held);
  // A hint, not the rule: an order with a line on a draft or issued invoice does not offer to cancel from here (A7 of ADR-0050 stays open: the server does not refuse it).
  const cancelBlocked = withFinance && held !== undefined && held.size > 0;
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
        {confirmed && withFinance && canEdit && !draft.hidden && (
          <Button size="sm" variant="outline" loading={draft.invoice.isPending} disabled={draft.allSkipped} aria-describedby={`order-invoice-note-${order.id}`} onClick={() => draft.invoice.mutate()} data-testid="order-invoice">
            {t('invoice')}
          </Button>
        )}
        {confirmed && (
          <Button size="sm" variant="outline" onClick={() => setDelivering((v) => !v)} aria-expanded={delivering} data-testid="order-delivery-open">
            {t('delivery.open')}
          </Button>
        )}
        {confirmed && canEdit && (
          <Button
            size="sm"
            variant="ghost"
            disabled={cancelBlocked}
            aria-describedby={cancelBlocked ? `order-cancel-blocked-${order.id}` : undefined}
            onClick={() => setCancelling((v) => !v)}
            aria-expanded={cancelling && !cancelBlocked}
            data-testid="order-cancel-open"
          >
            {t('cancelOrder')}
          </Button>
        )}
      </div>
      {/* Not shown while Kế toán's answer is not known (or failed): "Chưa lập hóa đơn" must not be said on a guess. */}
      {confirmed && withFinance && held !== undefined && <InvoiceLines orderId={order.id} held={held} />}
      {confirmed && withFinance && canEdit && <InvoiceNote orderId={order.id} draft={draft} />}
      {confirmed && canEdit && cancelBlocked && (
        <p id={`order-cancel-blocked-${order.id}`} className="w-full text-xs text-muted-foreground" data-testid="order-cancel-blocked">
          {t('cancelBlocked')}
        </p>
      )}
      {delivering && confirmed && <DeliveryPanel orderId={order.id} canEdit={canEdit} />}
      {cancelling && confirmed && canEdit && !cancelBlocked && <CancelPanel order={order} onDone={() => setCancelling(false)} />}
    </li>
  );
}

// The deal's sales orders, newest first, under its quotes.
export function DealOrders({ dealId, canEdit }: { dealId: string; canEdit: boolean }) {
  const t = useTranslations('quotes.orders');
  const orders = useQuery(orpc.crm.salesOrders.byDeal.queryOptions({ input: { dealId } }));
  // What Kế toán holds on the lines of the deal's confirmed orders: one read for all of them, only where its module runs. A failed read leaves the screen as it was.
  const confirmedIds = (orders.data ?? []).filter((o) => o.status === 'confirmed').map((o) => o.id).slice(0, ORDER_LINE_INVOICE_ORDERS_MAX);
  const states = useQuery({
    ...orpc.einvoice.drafts.orderLines.queryOptions({ input: { orderIds: confirmedIds } }),
    enabled: confirmedIds.length > 0 && financeInstalled(),
    retry: false,
  });
  const asked = new Set(confirmedIds);
  const heldOf = (orderId: string): ReadonlyMap<number, 'draft' | 'issued'> | undefined => {
    // An order that was not asked (beyond the read's 50) is unknown, never "no draft".
    if (!states.data || !asked.has(orderId)) return undefined;
    return new Map((states.data.orders.find((x) => x.orderId === orderId)?.lines ?? []).map((l) => [l.lineNo, l.state] as const));
  };
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
            <OrderRow key={o.id} order={o} canEdit={canEdit} held={heldOf(o.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

