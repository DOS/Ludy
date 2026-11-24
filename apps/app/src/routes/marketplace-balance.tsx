// SPDX-License-Identifier: AGPL-3.0-only
// The "Sàn" screen (#2516 slice D, plan docs/plan/stock-and-marketplaces.md section 8.4, "The payout"): where each platform's money stands in the books. Per platform of the chosen entity:
// the sales posted to 131, what the platform has paid out, what it still owes (the difference) and the fees it kept whose invoice has not come (331). Read only, from the ledger by the
// platform's party; facts only and nothing to press. A platform appears once its first settlement is posted; until then the screen says so. Above the table the finance coworker's one line (slice E):
// the facts read by code (stored settlements waiting to be posted, posted settlements whose payout is not recorded, what the platforms owe, fees awaiting an invoice) always, and one checked sentence when a model is on. A draft the person acts on: it
// posts nothing, and with AI off, busy, out of budget or refused the facts stand alone.
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import type { MarketplaceBalanceRow, MarketplaceFacts } from '@ludy/kernel-contract';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { MarketplaceActions } from '../components/marketplace-actions.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const NUM = 'text-right tabular-nums';

// The coworker's line. The facts are asked first and shown as soon as they arrive, so a slow or failing model never leaves the line blank; the sentence is asked second, only when something is waiting, and
// is display only. With AI off, busy, out of budget or refused, the facts stand alone (the state is named in a few words).
// Zero as the coworker is told it: whole dong, so less than half a dong is nothing (the same rule as packages/agent marketplace-line.ts).
const ZERO = /^-?0*(\.[0-4]\d*)?$/;
const sameFacts = (a: MarketplaceFacts, b: MarketplaceFacts) => a.settlementsToPost === b.settlementsToPost && a.payoutsToMatch === b.payoutsToMatch && a.settlementsHalfReversed === b.settlementsHalfReversed && a.awaitingPayout === b.awaitingPayout && a.feesAwaitingInvoice === b.feesAwaitingInvoice;
function CoworkerLine({ legalEntityId, ready }: { legalEntityId: string | undefined; ready: boolean }) {
  const t = useTranslations('marketplaceBalance');
  const f = useFormat();
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const scope = legalEntityId === undefined ? {} : { legalEntityId };
  const facts = useQuery({ ...orpc.marketplace.facts.queryOptions({ input: scope }), enabled: ready, retry: false });
  const waiting = facts.data ? facts.data.settlementsToPost > 0 || !ZERO.test(facts.data.awaitingPayout) || !ZERO.test(facts.data.feesAwaitingInvoice) : false;
  // Not refetched on window focus: a model call costs, and the answer is kept on the server for a while by its facts.
  const line = useQuery({ ...orpc.marketplace.line.queryOptions({ input: { ...scope, lang } }), enabled: ready && waiting, retry: false, staleTime: 5 * 60_000, refetchOnWindowFocus: false });
  if (!facts.data) {
    if (!ready) return null;
    return facts.error ? (
      <p className="mb-4 text-sm text-subtle-foreground" data-testid="marketplace-line-error">
        {t('lineError')}
      </p>
    ) : (
      <p className="mb-4 text-sm text-subtle-foreground" data-testid="marketplace-line-loading">
        {t('lineLoading')}
      </p>
    );
  }
  const parts: string[] = [];
  if (facts.data.settlementsToPost > 0) parts.push(t('lineSettlements', { count: String(facts.data.settlementsToPost) }));
  // Counted by code beside the others; the coworker's sentence is not told it (the checks that keep the sentence to the facts bind three numbers).
  if (facts.data.payoutsToMatch > 0) parts.push(t('linePayouts', { count: String(facts.data.payoutsToMatch) }));
  // Also counted by code only (#3329): a settlement with some months reversed and some standing, the accountant's to finish.
  if (facts.data.settlementsHalfReversed > 0) parts.push(t('lineHalfReversed', { count: String(facts.data.settlementsHalfReversed) }));
  if (!ZERO.test(facts.data.awaitingPayout)) parts.push(t('lineAwaiting', { amount: f.money(facts.data.awaitingPayout) }));
  if (!ZERO.test(facts.data.feesAwaitingInvoice)) parts.push(t('lineFees', { amount: f.money(facts.data.feesAwaitingInvoice) }));
  // The sentence belongs to the facts it was written from: after the facts change (a settlement posted), an older answer is not shown beside the new figures.
  const answer = line.data && sameFacts(line.data.facts, facts.data) ? line.data : null;
  const ai = answer?.ai;
  return (
    <section className="mb-4 rounded-md border border-border p-3 text-sm" data-testid="marketplace-line">
      <p className="text-foreground" data-testid="marketplace-line-facts">
        {parts.length > 0 ? parts.join(' - ') : t('lineNothing')}
      </p>
      {ai === 'used' && answer?.text && (
        <p className="mt-1 text-muted-foreground" data-testid="marketplace-line-text">
          {answer.text}
        </p>
      )}
      {(ai === 'busy' || ai === 'budget' || ai === 'failed') && (
        <p className="mt-1 text-subtle-foreground" data-testid="marketplace-line-ai-state">
          {t(`lineAi.${ai}`)}
        </p>
      )}
      <p className="mt-1 text-xs text-subtle-foreground">{t('lineNote')}</p>
    </section>
  );
}

// The coworker's notes under the table (#3711 slice 7): for each platform whose fees still wait on its 331, one checked sentence on what that means and what to do. Asked only when a row has fees waiting and an age,
// after the table is on screen; display only, so with AI off, busy, out of budget or every note dropped the table stands alone. A note is shown beside a platform that has fees waiting in the table on screen.
function FeeNotes({ legalEntityId, rows }: { legalEntityId: string | undefined; rows: readonly MarketplaceBalanceRow[] }) {
  const t = useTranslations('marketplaceBalance');
  const lang = useLocale() === 'en' ? 'en' : 'vi';
  const waiting = rows.filter((r) => !ZERO.test(r.feesAwaitingInvoice) && r.feesAgeDays !== null);
  // Not refetched on window focus: a model call costs, and the answer is kept on the server for a while by its facts.
  const notes = useQuery({
    ...orpc.marketplace.feeNotes.queryOptions({ input: { ...(legalEntityId === undefined ? {} : { legalEntityId }), lang } }),
    enabled: waiting.length > 0,
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const shown = notes.data?.ai === 'used' ? notes.data.notes.flatMap((n) => {
    const row = waiting.find((r) => r.legalEntityId === n.legalEntityId && r.platform === n.platform);
    return row ? [{ key: `${n.legalEntityId}-${n.platform}`, platformName: row.platformName, text: n.text }] : [];
  }) : [];
  const ai = notes.data?.ai;
  if (shown.length === 0 && ai !== 'busy' && ai !== 'budget' && ai !== 'failed') return null;
  return (
    <section className="mt-3 rounded-md border border-border p-3 text-sm" data-testid="marketplace-fee-notes">
      {shown.length > 0 && (
        <>
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t('lineFeeNotesTitle')}</p>
          <ul className="space-y-1">
            {shown.map((n) => (
              <li key={n.key} className="text-muted-foreground" data-testid="marketplace-fee-note">
                <span className="mr-2 font-medium text-foreground">{n.platformName}</span>
                {n.text}
              </li>
            ))}
          </ul>
        </>
      )}
      {(ai === 'busy' || ai === 'budget' || ai === 'failed') && (
        <p className="text-subtle-foreground" data-testid="marketplace-fee-notes-ai-state">
          {t(`lineFeeNotesAi.${ai}`)}
        </p>
      )}
    </section>
  );
}

export function MarketplaceBalancePage() {
  const t = useTranslations('marketplaceBalance');
  const f = useFormat();
  const entity = useChosenEntity();
  const balance = useQuery({ ...orpc.marketplace.balance.queryOptions({ input: { legalEntityId: entity.legalEntityId } }), enabled: entity.ready });
  const rows = balance.data?.rows ?? [];
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <CoworkerLine legalEntityId={entity.legalEntityId} ready={entity.ready} />
      <MarketplaceActions legalEntityId={entity.legalEntityId} ready={entity.ready} />
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
                <TableCell>{r.platformName}</TableCell>
                <TableCell className={NUM}>{f.money(r.salesPosted)}</TableCell>
                <TableCell className={NUM}>{f.money(r.paidOut)}</TableCell>
                <TableCell className={NUM} data-testid="marketplace-balance-awaiting">
                  {f.money(r.awaitingPayout)}
                </TableCell>
                <TableCell className={NUM}>
                  {f.money(r.feesAwaitingInvoice)}
                  {r.feesOverdue && r.feesAgeDays !== null ? (
                    <p className="mt-1 text-xs text-warning" data-testid="marketplace-balance-fees-overdue">
                      {t('feesOverdue', { days: String(r.feesAgeDays) })}
                    </p>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          <FeeNotes legalEntityId={entity.legalEntityId} rows={rows} />
          <p className="mt-3 text-sm text-subtle-foreground" data-testid="marketplace-balance-note">
            {t('note')}
          </p>
        </>
      )}
    </>
  );
}
