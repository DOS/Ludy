// SPDX-License-Identifier: AGPL-3.0-only
// The "Sàn" screen (#2516 slice D, plan docs/plan/stock-and-marketplaces.md section 8.4, "The payout"): where each platform's money stands in the books. Per platform of the chosen entity:
// the sales posted to 131, what the platform has paid out, what it still owes (the difference) and the fees it kept whose invoice has not come (1388). Read only, from the ledger by the
// platform's party; facts only and nothing to press. A platform appears once its first settlement is posted; until then the screen says so. Above the table the finance coworker's one line (slice E):
// the facts read by code (stored settlements waiting to be posted, what the platforms owe, fees awaiting an invoice) always, and one checked sentence when a model is on. A draft the person acts on: it
// posts nothing, and with AI off, busy, out of budget or refused the facts stand alone.
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import type { MarketplaceFacts } from '@crove/kernel-contract';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useChosenEntity } from '../components/entity-switcher.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const NUM = 'px-4 py-3 text-right tabular-nums';

// The coworker's line. The facts are asked first and shown as soon as they arrive, so a slow or failing model never leaves the line blank; the sentence is asked second, only when something is waiting, and
// is display only. With AI off, busy, out of budget or refused, the facts stand alone (the state is named in a few words).
// Zero as the coworker is told it: whole dong, so less than half a dong is nothing (the same rule as packages/agent marketplace-line.ts).
const ZERO = /^-?0*(\.[0-4]\d*)?$/;
const sameFacts = (a: MarketplaceFacts, b: MarketplaceFacts) => a.settlementsToPost === b.settlementsToPost && a.awaitingPayout === b.awaitingPayout && a.feesAwaitingInvoice === b.feesAwaitingInvoice;
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
