// SPDX-License-Identifier: AGPL-3.0-only
// What a person can act on at the Sàn screen (#2516 slice F, plan docs/plan/stock-and-marketplaces.md section 8.4): the stored settlements to post, the posted settlements waiting for their payout (with the
// bank lines the platform's transfer may be) and the platform's fee invoices that (clearing is retired, so none is listed). Read by code (marketplace.worklist), no model call. Each button only asks for the
// proposal (inbox.request of the finance command) and links to it in the Inbox: nothing posts from here, a second person approves there. While the accountant has not confirmed the account map (#2520) the
// three are disabled under one line that says so, instead of letting a request fail. Nothing is shown when nothing waits.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { MarketplaceFeeAccrual, MarketplaceFeeAccrualReversal, MarketplaceInvoiceToClear, MarketplacePayoutToMatch, MarketplaceSettlementToPost } from '@crove/kernel-contract';
import { Alert, AlertDescription } from '@crove/ui/components/alert';
import { Button } from '@crove/ui/components/button';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { DataTable } from './ui.tsx';

const NUM = 'px-4 py-3 text-right tabular-nums';

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
  return (
    <TableRow data-testid="marketplace-action-settlement">
      <TableCell className="px-4 py-3">{s.platformName}</TableCell>
      <TableCell className="px-4 py-3">{period(s.periodFrom, s.periodTo)}</TableCell>
      <TableCell className="px-4 py-3" data-testid="marketplace-settlement-month">{s.months.length === 0 ? t('monthWaiting', { count: String(s.waitingLines) }) : s.months.join(', ')}</TableCell>
      <TableCell className={NUM}>{s.months.length === 0 ? '' : f.money(s.net)}</TableCell>
      <TableCell className="px-4 py-3 text-right">
        {s.months.length === 0 ? (
          <span className="text-sm text-subtle-foreground" data-testid="marketplace-post-waiting">{t('waitingDelivery')}</span>
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

function PayoutRow({ p, open }: { p: MarketplacePayoutToMatch; open: boolean }) {
  const t = useTranslations('marketplaceActions');
  const f = useFormat();
  const [chosen, setChosen] = useState('');
  const bankLineId = chosen !== '' && p.candidates.some((c) => c.id === chosen) ? chosen : (p.candidates[0]?.id ?? '');
  return (
    <TableRow data-testid="marketplace-action-payout">
      <TableCell className="px-4 py-3">{p.platformName}</TableCell>
      <TableCell className="px-4 py-3">{period(p.periodFrom, p.periodTo)}</TableCell>
      <TableCell className={NUM}>{f.money(p.received)}</TableCell>
      <TableCell className="px-4 py-3">
        {p.proposalId !== null ? null : p.candidates.length === 0 ? (
          <span className="text-subtle-foreground" data-testid="marketplace-no-candidates">
            {t('noCandidates')}
          </span>
        ) : (
          <NativeSelect value={bankLineId} onChange={(e) => setChosen(e.target.value)} aria-label={t('pickLine')} data-testid="marketplace-line-select">
            {p.candidates.map((c) => (
              <NativeSelectOption key={c.id} value={c.id}>
                {[c.date, f.money(c.amount), c.reference].filter((x) => x !== null && x !== '').join(' - ')}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </TableCell>
      <TableCell className="px-4 py-3 text-right">
        <AskButton
          label={t('record')}
          disabled={!open || bankLineId === ''}
          testId="marketplace-record"
          pending={p.proposalId}
          ask={(idempotencyKey) => client.inbox.request({ command: 'finance.marketplace_payout.record', idempotencyKey, input: { settlementId: p.settlementId, bankLineId } })}
        />
      </TableCell>
    </TableRow>
  );
}

const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

// The month-end accrual of the fees without an invoice: an ordinary general journal voucher Dr expense / Cr accrued expense of the amount the books show (slice F of #2516); a person approves the two lines.
function AccrualRow({ a, open }: { a: MarketplaceFeeAccrual; open: boolean }) {
  const t = useTranslations('marketplaceActions');
  const f = useFormat();
  return (
    <TableRow data-testid="marketplace-action-accrual">
      <TableCell className="px-4 py-3">{a.platformName}</TableCell>
      <TableCell className="px-4 py-3">{monthLabel(a.month)}</TableCell>
      <TableCell className={NUM}>{f.money(a.amount)}</TableCell>
      <TableCell className="px-4 py-3 text-right">
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

// The reversal of a standing accrual, from the first day of the next month: the generic reversal of the entry, dated that day.
function AccrualReversalRow({ r, open }: { r: MarketplaceFeeAccrualReversal; open: boolean }) {
  const t = useTranslations('marketplaceActions');
  const f = useFormat();
  return (
    <TableRow data-testid="marketplace-action-accrual-reversal">
      <TableCell className="px-4 py-3">{r.platformName}</TableCell>
      <TableCell className="px-4 py-3">{monthLabel(r.month)}</TableCell>
      <TableCell className={NUM}>{f.money(r.amount)}</TableCell>
      <TableCell className="px-4 py-3">{r.reverseOn}</TableCell>
      <TableCell className="px-4 py-3 text-right">
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
      <TableCell className="px-4 py-3">{i.platformName}</TableCell>
      <TableCell className="px-4 py-3">
        {i.invoice} ({i.date})
      </TableCell>
      <TableCell className={NUM}>{f.money(i.clearable)}</TableCell>
      <TableCell className="px-4 py-3 text-right">
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
  if (data.settlements.length === 0 && data.payouts.length === 0 && data.invoices.length === 0 && data.halfReversed.length === 0 && data.accruals.length === 0 && data.accrualReversals.length === 0) return null;
  const open = data.postingConfirmed;
  return (
    <section className="mb-6 space-y-5" data-testid="marketplace-actions">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      {!open && (
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
              <SettlementRow key={s.id} s={s} open={open} />
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
                <TableCell className="px-4 py-3">{h.platformName}</TableCell>
                <TableCell className="px-4 py-3">{period(h.periodFrom, h.periodTo)}</TableCell>
                <TableCell className="px-4 py-3" data-testid="marketplace-half-reversed-state">{t('halfReversedRow', { standing: String(h.standingMonths), reversed: String(h.reversedMonths) })}</TableCell>
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
