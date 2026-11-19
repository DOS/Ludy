// SPDX-License-Identifier: AGPL-3.0-only
// The deals of one customer (K1's crm.party.deals), in a contact's panel on Contacts and in the Inbox's contact panel (#3648): the title, the stage it sits in, the amount and the
// expected close date, a way to the Deals screen, and "Thêm cơ hội", which opens the deal's side sheet with this customer chosen (#3292). A deal's title opens the same sheet. A viewer reads the
// deals and has no button. `openOnly`: the Inbox shows the deals still being worked.
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { Contact } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { DealSheet, type DealSheetTarget } from './deal-sheet.tsx';
import { ErrorText } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { formatDate, formatMoney } from '../lib/format.ts';

export function ContactDeals({ contact, canEdit, openOnly = false }: { contact: Pick<Contact, 'id' | 'name' | 'kind' | 'taxCode'>; canEdit: boolean; openOnly?: boolean }) {
  const partyId = contact.id;
  const t = useTranslations('contacts');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const { locale } = useLocaleSetting();
  const [sheet, setSheet] = useState<DealSheetTarget | null>(null);
  const org = useQuery({ ...orpc.org.get.queryOptions(), enabled: canEdit });
  // `byParty` answers the newest 200 deals of the customer, so the open ones are asked for as such (the list read, filtered by the server) where only they are shown.
  const all = useQuery({ ...orpc.crm.deals.byParty.queryOptions({ input: { partyId } }), enabled: !openOnly });
  const open = useQuery({ ...orpc.crm.deals.list.queryOptions({ input: { partyId, status: 'open' } }), enabled: openOnly });
  const deals = openOnly ? open : all;
  const stages = useQuery(orpc.crm.pipeline.stages.queryOptions({ input: {} }));
  const shown = openOnly ? (open.data?.items ?? []) : (all.data ?? []);
  return (
    <div data-testid="contact-deals">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-muted-foreground">{openOnly ? t('deals.openTitle') : t('deals.title')}</p>
        <div className="flex flex-wrap items-center gap-3">
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => setSheet({ kind: 'new', presetParty: { id: contact.id, name: contact.name, kind: contact.kind, taxCode: contact.taxCode } })} aria-label={t('deals.addOf', { name: contact.name })}>
              {t('deals.add')}
            </Button>
          )}
          <Link to="/o/$slug/deals" params={{ slug }} className="text-sm text-link underline">
            {t('deals.open')}
          </Link>
        </div>
      </div>
      {deals.isLoading ? (
        <p className="text-sm text-subtle-foreground">{t('loading')}</p>
      ) : deals.error ? (
        <ErrorText>{errorMessage(deals.error)}</ErrorText>
      ) : shown.length === 0 ? (
        <p className="text-sm text-subtle-foreground">{openOnly ? t('deals.emptyOpen') : canEdit ? t('deals.empty') : t('deals.emptyRead')}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {shown.map((d) => (
            <li key={d.id} className="flex flex-wrap items-baseline gap-x-3">
              <button type="button" data-testid="contact-deal-open" onClick={() => setSheet({ kind: 'deal', deal: d })} className="rounded-sm text-left font-medium text-foreground outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50">
                {d.title}
              </button>
              <span className="text-xs text-muted-foreground">{stages.data?.find((s) => s.id === d.stageId)?.name ?? t(`deals.kind.${d.stageKind}`)}</span>
              <span className="tabular-nums text-muted-foreground">{formatMoney(d.amount, locale, d.currency)}</span>
              {d.expectedClose && <span className="text-xs text-subtle-foreground">{t('deals.close', { date: formatDate(d.expectedClose, locale) })}</span>}
            </li>
          ))}
        </ul>
      )}
      {sheet && <DealSheet target={sheet} members={org.data?.members ?? []} canEdit={canEdit} onClose={() => setSheet(null)} />}
    </div>
  );
}
