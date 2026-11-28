// SPDX-License-Identifier: AGPL-3.0-only
// What a person can act on at the Sàn screen (#2516 slice F, plan docs/plan/stock-and-marketplaces.md section 8.4): the stored settlements to post, the posted settlements waiting for their payout (with the
// bank lines the platform's transfer may be) and the platform's fee invoices that (clearing is retired, so none is listed). Read by code (marketplace.worklist), no model call. Each button only asks for the
// proposal (inbox.request of the finance command) and links to it in the Inbox: nothing posts from here, a second person approves there. While the accountant has not confirmed the account map (#2520) the
// three are disabled under one line that says so, instead of letting a request fail. Nothing is shown when nothing waits.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { MarketplaceFeeAccrual, MarketplaceFeeAccrualReversal, MarketplaceInvoiceToClear, MarketplacePayoutAdjustment, MarketplacePayoutToMatch, MarketplaceReturnToConfirm, MarketplaceSettlementToPost } from '@ludy/kernel-contract';
import { Alert, AlertDescription } from '@ludy/ui/components/alert';
import { Button } from '@ludy/ui/components/button';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { DataTable } from './ui.tsx';

const NUM = 'text-right tabular-nums';

// One request: the key is kept for the life of the row, so a retry returns the same proposal. After it, the row says so and links to the proposal.
function AskButton({ label, disabled, ask, testId, pending }: { label: string; disabled: boolean; ask: (idempotencyKey: string) => Promise<{ proposalId: string }>; testId: string; pending: string | null }) {
  const t = useTranslations('marketplaceActions');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const request = useMutation({ mutationFn: () => ask(idempotencyKey) });
  // A proposal for this item already waits in the Inbox (asked earlier, perhaps by someone else): link to it, never a second request.
  if (pending !== null && !request.data) {
    return (
      <span data-testid={`${testId}-pending`}>
        {t('pending')}{' '}
        <Link to="/o/$slug/inbox/$id" params={{ slug, id: pending }} className="text-link underline">
          {t('view')}
        </Link>
      </span>
    );
  }
  if (request.data) {
    return (
      <span data-testid={`${testId}-done`}>
        {t('asked')}{' '}
        <Link to="/o/$slug/inbox/$id" params={{ slug, id: request.data.proposalId }} className="text-link underline">
          {t('view')}
        </Link>
      </span>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button size="sm" disabled={disabled || request.isPending} onClick={() => request.mutate()} data-testid={testId}>
        {label}
      </Button>
      {request.error && (
        <span className="max-w-72 text-right text-xs text-destructive" data-testid={`${testId}-error`}>
          {errorMessage(request.error)}
        </span>
      )}
    </div>
  );
}

const period = (from: string, to: string) => (from === to ? from : `${from} - ${to}`);

function SettlementRow({ s, open }: { s: MarketplaceSettlementToPost; open: boolean }) {
  const t = useTranslations('marketplaceActions');
  const f = useFormat();
  const { slug } = useParams({ strict: false }) as { slug: string };
  // Its sales have a delivery day but no VAT rate row for it (#4303 S3b): nothing to ask for until the rate is entered in Settings.
  const waitingVat = s.months.length > 0 && s.waitingVatMonths.length > 0;
  // The rate is entered in Settings by an owner or admin: they get the link, everyone else is told whom to ask.
  const org = useQuery(orpc.org.get.queryOptions());
  const canSetRate = org.data?.role === 'owner' || org.data?.role === 'admin';
  return (
    <TableRow data-testid="marketplace-action-settlement">
      <TableCell>{s.platformName}</TableCell>
      <TableCell>{period(s.periodFrom, s.periodTo)}</TableCell>
      <TableCell data-testid="marketplace-settlement-month">{s.months.length === 0 ? t('monthWaiting', { count: String(s.waitingLines) }) : s.months.join(', ')}</TableCell>
      <TableCell className={NUM}>{s.months.length === 0 ? '' : f.money(s.net)}</TableCell>
      <TableCell className="text-right">
        {s.months.length === 0 ? (
          <span className="text-sm text-subtle-foreground" data-testid="marketplace-post-waiting">{t('waitingDelivery')}</span>
        ) : waitingVat ? (
          <span className="text-sm text-subtle-foreground" data-testid="marketplace-post-waiting-vat">
            {t('waitingVatRate', { months: s.waitingVatMonths.join(', ') })}{' '}
            {canSetRate ? (
              <Link to="/o/$slug/settings/accounting" params={{ slug }} className="inline-flex min-h-11 items-center font-medium text-foreground underline">
                {t('setVatRate')}
              </Link>
            ) : (
              <span data-testid="marketplace-vat-ask">{t('askVatRate')}</span>
            )}
          </span>
        ) : (
          <AskButton
            label={t('post')}
            disabled={!open}
            testId="marketplace-post"
            pending={s.proposalId}
            ask={(idempotencyKey) => client.inbox.request({ command: 'finance.marketplace_settlement.record', idempotencyKey, input: { settlementId: s.id } })}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

// The kinds a person may give a line the report does not explain (#4303 S4): money paid beyond the sales is a seller incentive or a compensation for goods the carrier lost; tax withheld from a seller that is no
// household is a mistake of the platform. The server checks each against the stored line again, when asked and when approved; nothing is guessed here, and the request waits until every line has a kind.
const KINDS = { other: ['incentive', 'carrier_compensation'], withheld: ['withheld_in_error'] } as const;
const WHOLE_DONG = /^\d{1,15}$/;
// The cost a person types: whole dong, with thousands separators allowed only where they group three digits ("1.500.000", "1,500,000", "1 500 000"); anything else with a separator is not guessed at (1.5 is not 15).
const GROUPED = /^\d{1,3}([.,\s]\d{3})+$/;
function parseCost(raw: string): string | null {
  const v = raw.trim();
  if (WHOLE_DONG.test(v)) return v;
  if (GROUPED.test(v)) {
    const digits = v.replace(/[.,\s]/g, '');
    return WHOLE_DONG.test(digits) ? digits : null;
  }
  return null;
}

const adjustmentSlot = (a: MarketplacePayoutToMatch['adjustable'][number]) => `${a.lineId}:${a.source}`;

// Computes the classified payout adjustments and whether every adjustable line has a valid classification.
// For `carrier_compensation`, uses the person's entered cost when present (including an explicit empty clear) and falls back to the suggested stock cost until edited (#4337).
export function buildPayoutAdjustments(
  adjustable: MarketplacePayoutToMatch['adjustable'],
  kinds: Readonly<Record<string, string>>,
  costs: Readonly<Record<string, string>>,
): { adjustments: MarketplacePayoutAdjustment[]; ready: boolean } {
  const adjustments: MarketplacePayoutAdjustment[] = [];
  let ready = true;
  for (const a of adjustable) {
    const key = adjustmentSlot(a);
    const kind = kinds[key] ?? '';
    const allowed: readonly string[] = KINDS[a.source];
    if (!allowed.includes(kind)) ready = false;
    else if (kind === 'carrier_compensation') {
      const costAmount = parseCost(costs[key] ?? a.suggestedCostAmount ?? '');
      if (costAmount !== null) adjustments.push({ kind: 'carrier_compensation', lineId: a.lineId, amount: a.amount.replace(/\.0+$/, ''), costAmount });
      else ready = false;
    } else adjustments.push({ kind: kind as 'incentive' | 'withheld_in_error', lineId: a.lineId, amount: a.amount.replace(/\.0+$/, '') });
  }
  return { adjustments, ready };
}

export function PayoutRow({
  p,
  open,
  initialKinds,
  initialCosts,
}: {
  p: MarketplacePayoutToMatch;
  open: boolean;
  initialKinds?: Record<string, string>;
  initialCosts?: Record<string, string>;
}) {
  const t = useTranslations('marketplaceActions');
  const f = useFormat();
  const [chosen, setChosen] = useState('');
  // The kind and, for a compensation, the cost of the goods the person states, by line and source (a line can carry both an `other` amount and a withheld tax).
  const [kinds, setKinds] = useState<Record<string, string>>(() => initialKinds ?? {});
  const [costs, setCosts] = useState<Record<string, string>>(() => initialCosts ?? {});
  const bankLineId = chosen !== '' && p.candidates.some((c) => c.id === chosen) ? chosen : (p.candidates[0]?.id ?? '');
  const { adjustments, ready } = buildPayoutAdjustments(p.adjustable, kinds, costs);
  return (
    <>
      <TableRow data-testid="marketplace-action-payout">
        <TableCell>{p.platformName}</TableCell>
        <TableCell>{period(p.periodFrom, p.periodTo)}</TableCell>
        <TableCell className={NUM}>{f.money(p.received)}</TableCell>
        <TableCell>
          {p.proposalId !== null ? null : p.candidates.length === 0 ? (
            <span className="text-subtle-foreground" data-testid="marketplace-no-candidates">
              {t('noCandidates')}
            </span>
          ) : (
            <NativeSelect value={bankLineId} onChange={(e) => setChosen(e.target.value)} aria-label={t('pickLine')} className="max-md:min-h-11" data-testid="marketplace-line-select">
              {p.candidates.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {[c.date, f.money(c.amount), c.reference].filter((x) => x !== null && x !== '').join(' - ')}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </TableCell>
        <TableCell className="text-right">
          <AskButton
            label={t('record')}
            disabled={!open || bankLineId === '' || !ready}
            testId="marketplace-record"
            pending={p.proposalId}
            ask={(idempotencyKey) =>
              client.inbox.request({
                command: 'finance.marketplace_payout.record',
                idempotencyKey,
                input: { settlementId: p.settlementId, bankLineId, ...(adjustments.length > 0 ? { adjustments } : {}) },
              })
            }
          />
        </TableCell>
      </TableRow>
      {p.proposalId === null && p.adjustable.length > 0 && (
        <TableRow data-testid="marketplace-payout-adjustments">
          <TableCell colSpan={5} className="py-3">
            <p className="mb-2 text-sm text-subtle-foreground">{t('adjustHint')}</p>
            {p.adjustable.some((a) => a.source === 'other') && <p className="mb-2 text-sm text-subtle-foreground" data-testid="marketplace-adjustment-note">{t('adjustIncentiveNote')}</p>}
            {!ready && (
              <p className="mb-2 text-sm text-subtle-foreground" role="status" data-testid="marketplace-adjustment-pending">
                {t('adjustPending')}
              </p>
            )}
            <ul className="flex flex-col gap-2">
              {p.adjustable.map((a) => {
                const key = adjustmentSlot(a);
                const kind = kinds[key] ?? '';
                const rawCost = costs[key] ?? a.suggestedCostAmount ?? '';
                const costInvalid = rawCost.trim() !== '' && parseCost(rawCost) === null;
                const hintId = `${key}-cost-hint`;
                const errorId = `${key}-cost-error`;
                return (
                  <li key={key} className="flex flex-wrap items-center gap-2" data-testid="marketplace-adjustment">
                    <span className="min-w-40 tabular-nums">{t(a.source === 'other' ? 'adjustOther' : 'adjustWithheld', { amount: f.money(a.amount) })}</span>
                    <NativeSelect
                      value={kind}
                      onChange={(e) => setKinds({ ...kinds, [key]: e.target.value })}
                      aria-label={t('adjustKindLabel', { amount: f.money(a.amount) })}
                      className="max-md:min-h-11"
                      data-testid="marketplace-adjustment-kind"
                    >
                      <NativeSelectOption value="">{t('adjustChoose')}</NativeSelectOption>
                      {KINDS[a.source].map((k) => (
                        <NativeSelectOption key={k} value={k}>
                          {t(`adjustKind_${k}`)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    {kind === 'carrier_compensation' && (
                      <>
                        <Input
                          inputMode="numeric"
                          value={rawCost}
                          onChange={(e) => setCosts({ ...costs, [key]: e.target.value })}
                          aria-label={t('adjustCostLabel', { amount: f.money(a.amount) })}
                          aria-invalid={costInvalid}
                          aria-describedby={costInvalid ? `${hintId} ${errorId}` : hintId}
                          placeholder={t('adjustCost')}
                          className="w-48 max-md:min-h-11"
                          data-testid="marketplace-adjustment-cost"
                        />
                        <span
                          id={hintId}
                          className="text-xs text-subtle-foreground"
                          data-testid={a.suggestedCostAmount !== undefined ? 'marketplace-adjustment-cost-suggestion' : 'marketplace-adjustment-cost-no-suggestion'}
                        >
                          {a.suggestedCostAmount !== undefined
                            ? t('adjustCostSuggested', { amount: f.money(a.suggestedCostAmount) })
                            : t('adjustCostNoSuggestion')}
                        </span>
                        {costInvalid && (
                          <span id={errorId} role="alert" className="text-xs text-destructive" data-testid="marketplace-adjustment-cost-error">
                            {t('adjustCostInvalid')}
                          </span>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

// The month-end accrual of the fees without an invoice: an ordinary general journal voucher Dr expense / Cr accrued expense of the amount the books show (slice F of #2516); a person approves the two lines.
function AccrualRow({ a, open }: { a: MarketplaceFeeAccrual; open: boolean }) {
  const t = useTranslations('marketplaceActions');
  const f = useFormat();
  return (
    <TableRow data-testid="marketplace-action-accrual">
      <TableCell>{a.platformName}</TableCell>
      <TableCell>{monthLabel(a.month)}</TableCell>
      <TableCell className={NUM}>{f.money(a.amount)}</TableCell>
      <TableCell className="text-right">
        <AskButton
          label={t('accrue')}
          disabled={!open}
          testId="marketplace-accrue"
          pending={a.proposalId}
          ask={(idempotencyKey) =>
            client.inbox.request({
              command: 'finance.journal_voucher.record',
              idempotencyKey,
              input: {
                date: a.date,
                description: a.description,
                legalEntityId: a.legalEntityId,
                lines: [
                  { account: a.expenseAccount, debit: a.amount, credit: '0' },
                  { account: a.accruedAccount, debit: '0', credit: a.amount },
                ],
              },
            })
          }
        />
      </TableCell>
    </TableRow>
  );
}

// A line that came back (#4355): the platform's status only offers the question, a person says whether the goods are back. `Goods are back` writes the stock-in (priced by the month close), `not back` moves nothing.
// It posts nothing and needs no account map, so the account map's gate does not hold it. The answer is final, and the row leaves the list.
function ReturnRow({ r }: { r: MarketplaceReturnToConfirm }) {
  const t = useTranslations('marketplaceActions');
  const f = useFormat();
  const queryClient = useQueryClient();
  // One key per answer, kept for the life of the row, so a retry of the same answer returns the same result.
  const [keys] = useState(() => ({ back: crypto.randomUUID(), not_back: crypto.randomUUID() }));
  const answer = useMutation({
    mutationFn: (decision: 'back' | 'not_back') => client.marketplace.returns.decide({ orderLineId: r.orderLineId, decision, idempotencyKey: keys[decision] }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.marketplace.worklist.key() }),
  });
  // Each answer is final, so a click only asks; the second click sends it. A viewer is not offered the buttons (the command would refuse them).
  const [asked, setAsked] = useState<'back' | 'not_back' | null>(null);
  const org = useQuery(orpc.org.get.queryOptions());
  const canAnswer = org.data?.role === 'owner' || org.data?.role === 'admin' || org.data?.role === 'member';
  const label = `${r.orderNo} ${r.itemCode}`;
  return (
    <TableRow data-testid="marketplace-action-return">
      <TableCell>{r.platformName}</TableCell>
      <TableCell>{r.orderNo}</TableCell>
      <TableCell>{r.itemCode} {r.itemName}</TableCell>
      <TableCell className={NUM}>{f.number(r.quantity)} {r.unit}</TableCell>
      <TableCell>{t(`returnStage_${r.stage}`)}</TableCell>
      <TableCell className="text-right">
        {!canAnswer ? (
          org.data ? <span className="text-xs text-subtle-foreground" data-testid="marketplace-return-no-right">{t('returnNoRight')}</span> : null
        ) : (
          <div className="flex flex-col items-end gap-1">
            {asked === null ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" className="min-h-11" aria-label={`${t('goodsBack')}: ${label}`} onClick={() => setAsked('back')} data-testid="marketplace-return-back">
                  {t('goodsBack')}
                </Button>
                <Button size="sm" variant="outline" className="min-h-11" aria-label={`${t('goodsNotBack')}: ${label}`} onClick={() => setAsked('not_back')} data-testid="marketplace-return-not-back">
                  {t('goodsNotBack')}
                </Button>
              </div>
            ) : (
              <div className="flex max-w-72 flex-col items-end gap-2">
                <span className="text-right text-xs" id={`return-ask-${r.orderLineId}`} data-testid="marketplace-return-ask">
                  {t(asked === 'back' ? 'returnAskBack' : 'returnAskNotBack', { order: r.orderNo })}
                </span>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    className="min-h-11"
                    aria-label={`${t('returnConfirm')}: ${label}`}
                    loading={answer.isPending}
                    disabled={answer.isPending}
                    onClick={() => answer.mutate(asked)}
                    data-testid="marketplace-return-confirm"
                  >
                    {t('returnConfirm')}
                  </Button>
                  <Button size="sm" variant="outline" className="min-h-11" disabled={answer.isPending} onClick={() => setAsked(null)} data-testid="marketplace-return-cancel">
                    {t('returnCancel')}
                  </Button>
                </div>
              </div>
            )}
            {answer.error && (
              <span role="alert" className="max-w-72 text-right text-xs text-destructive" data-testid="marketplace-return-error">
                {errorMessage(answer.error)}
              </span>
            )}
          </div>
        )}
      </TableCell>
    </TableRow>
  );
}

// The reversal of a standing accrual, from the first day of the next month: the generic reversal of the entry, dated that day.
function AccrualReversalRow({ r, open }: { r: MarketplaceFeeAccrualReversal; open: boolean }) {
  const t = useTranslations('marketplaceActions');
  const f = useFormat();
  return (
    <TableRow data-testid="marketplace-action-accrual-reversal">
      <TableCell>{r.platformName}</TableCell>
      <TableCell>{monthLabel(r.month)}</TableCell>
      <TableCell className={NUM}>{f.money(r.amount)}</TableCell>
      <TableCell className="tabular-nums">{r.reverseOn}</TableCell>
      <TableCell className="text-right">
        <AskButton
          label={t('reverseAccrual')}
          disabled={!open}
          testId="marketplace-reverse-accrual"
          pending={r.proposalId}
          ask={(idempotencyKey) =>
            client.inbox.request({ command: 'finance.journal.reverse', idempotencyKey, input: { entryId: r.entryId, entryDate: r.reverseOn, reason: t('accrualReversalReason', { month: monthLabel(r.month) }) } })
          }
        />
      </TableCell>
    </TableRow>
  );
}

function InvoiceRow({ i, open }: { i: MarketplaceInvoiceToClear; open: boolean }) {
  const t = useTranslations('marketplaceActions');
  const f = useFormat();
  return (
    <TableRow data-testid="marketplace-action-invoice">
      <TableCell>{i.platformName}</TableCell>
      <TableCell>
        {i.invoice} ({i.date})
      </TableCell>
      <TableCell className={NUM}>{f.money(i.clearable)}</TableCell>
      <TableCell className="text-right">
        <AskButton label={t('clear')} disabled={!open} testId="marketplace-clear" pending={i.proposalId} ask={(idempotencyKey) => client.inbox.request({ command: 'finance.marketplace_fee_clearing.record', idempotencyKey, input: { purchaseDocumentId: i.documentId } })} />
      </TableCell>
    </TableRow>
  );
}

export function MarketplaceActions({ legalEntityId, ready }: { legalEntityId: string | undefined; ready: boolean }) {
  const t = useTranslations('marketplaceActions');
  const worklist = useQuery({ ...orpc.marketplace.worklist.queryOptions({ input: legalEntityId === undefined ? {} : { legalEntityId } }), enabled: ready, retry: false });
  const data = worklist.data;
  if (!data) return null;
  if (data.settlements.length === 0 && data.payouts.length === 0 && data.invoices.length === 0 && data.halfReversed.length === 0 && data.accruals.length === 0 && data.accrualReversals.length === 0 && data.returns.length === 0) return null;
  const open = data.postingConfirmed;
  // A settlement entry needs the sales path only (#4303 S3b): its rows follow that, the payout, fee and invoice rows follow `open`.
  const salesOpen = data.salesPostingConfirmed;
  const othersShown = data.payouts.length + data.invoices.length + data.halfReversed.length + data.accruals.length + data.accrualReversals.length > 0;
  return (
    <section className="mb-6 space-y-5" data-testid="marketplace-actions">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      {((!salesOpen && data.settlements.length > 0) || (!open && othersShown)) && (
        <Alert data-testid="marketplace-gate">
          <AlertDescription>{t('gate')}</AlertDescription>
        </Alert>
      )}
      {data.settlements.length > 0 && (
        <div data-testid="marketplace-actions-settlements">
          <h3 className="mb-1 text-sm font-medium">{t('settlementsTitle')}</h3>
          <p className="mb-2 text-sm text-subtle-foreground">{t('settlementsHint')}</p>
          <DataTable head={[t('platform'), t('period'), t('month'), t('net'), '']} numeric={[3]}>
            {data.settlements.map((s) => (
              <SettlementRow key={s.id} s={s} open={salesOpen} />
            ))}
          </DataTable>
        </div>
      )}
      {data.returns.length > 0 && (
        <div data-testid="marketplace-actions-returns">
          <h3 className="mb-1 text-sm font-medium">{t('returnsTitle')}</h3>
          <p className="mb-2 text-sm text-subtle-foreground">{t('returnsHint')}</p>
          <DataTable head={[t('platform'), t('orderNo'), t('returnItem'), t('returnQuantity'), t('returnState'), '']} numeric={[3]}>
            {data.returns.map((r) => (
              <ReturnRow key={r.orderLineId} r={r} />
            ))}
          </DataTable>
        </div>
      )}
      {data.payouts.length > 0 && (
        <div data-testid="marketplace-actions-payouts">
          <h3 className="mb-1 text-sm font-medium">{t('payoutsTitle')}</h3>
          <p className="mb-2 text-sm text-subtle-foreground">{t('payoutsHint')}</p>
          <DataTable head={[t('platform'), t('period'), t('received'), t('pickLine'), '']} numeric={[2]}>
            {data.payouts.map((p) => (
              <PayoutRow key={p.settlementId} p={p} open={open} />
            ))}
          </DataTable>
        </div>
      )}
      {data.halfReversed.length > 0 && (
        <div data-testid="marketplace-actions-half-reversed">
          <h3 className="mb-1 text-sm font-medium">{t('halfReversedTitle')}</h3>
          <p className="mb-2 text-sm text-subtle-foreground">{t('halfReversedHint')}</p>
          <DataTable head={[t('platform'), t('period'), t('state')]}>
            {data.halfReversed.map((h) => (
              <TableRow key={h.settlementId} data-testid="marketplace-action-half-reversed">
                <TableCell>{h.platformName}</TableCell>
                <TableCell>{period(h.periodFrom, h.periodTo)}</TableCell>
                <TableCell data-testid="marketplace-half-reversed-state">{t('halfReversedRow', { standing: String(h.standingMonths), reversed: String(h.reversedMonths) })}</TableCell>
              </TableRow>
            ))}
          </DataTable>
        </div>
      )}
      {data.accrualReversals.length > 0 && (
        <div data-testid="marketplace-actions-accrual-reversals">
          <h3 className="mb-1 text-sm font-medium">{t('accrualReversalsTitle')}</h3>
          <p className="mb-2 text-sm text-subtle-foreground">{t('accrualReversalsHint')}</p>
          <DataTable head={[t('platform'), t('accrualMonth'), t('accrualAmount'), t('reverseOn'), '']} numeric={[2]}>
            {data.accrualReversals.map((r) => (
              <AccrualReversalRow key={r.entryId} r={r} open={open} />
            ))}
          </DataTable>
        </div>
      )}
      {data.accruals.length > 0 && (
        <div data-testid="marketplace-actions-accruals">
          <h3 className="mb-1 text-sm font-medium">{t('accrualsTitle')}</h3>
          <p className="mb-2 text-sm text-subtle-foreground">{t('accrualsHint')}</p>
          <DataTable head={[t('platform'), t('accrualMonth'), t('accrualAmount'), '']} numeric={[2]}>
            {data.accruals.map((a) => (
              <AccrualRow key={`${a.legalEntityId}:${a.platform}:${a.month}`} a={a} open={open} />
            ))}
          </DataTable>
        </div>
      )}
      {data.invoices.length > 0 && (
        <div data-testid="marketplace-actions-invoices">
          <h3 className="mb-1 text-sm font-medium">{t('invoicesTitle')}</h3>
          <p className="mb-2 text-sm text-subtle-foreground">{t('invoicesHint')}</p>
          <DataTable head={[t('platform'), t('invoice'), t('clearable'), '']} numeric={[2]}>
            {data.invoices.map((i) => (
              <InvoiceRow key={i.documentId} i={i} open={open} />
            ))}
          </DataTable>
        </div>
      )}
    </section>
  );
}
