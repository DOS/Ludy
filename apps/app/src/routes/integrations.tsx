// SPDX-License-Identifier: AGPL-3.0-only
// The "Tích hợp" (Integrations) section of Settings, with the finance module: where an org connects the company to the outside services its books work with. Today
// that is the bank feed (ADR-0039), the e-invoice provider (ADR-0044), the marketplaces (ADR-0045, #2519) and MISA AMIS Kế toán (#3875). Each card draws itself only where the deployment
// offers something to connect or the org already has a connection, and the section's heading shows only while one of them does.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId } from 'react';
import { useTranslations } from 'use-intl';
import { orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { showsBankFeeds } from '../lib/bank-feeds.ts';
import { einvoiceCardShown } from '../lib/einvoice-connections.ts';
import { marketplaceCardShown } from '../lib/marketplace-connections.ts';
import { misaAmisCardShown } from '../lib/misa-amis-connections.ts';
import type { Role } from '../lib/members.ts';
import { BankFeedsCard } from './bank-feeds.tsx';
import { EInvoiceConnectionsCard } from './einvoice-connections.tsx';
import { MarketplaceConnectionsCard } from './marketplace-connections.tsx';
import { MisaAmisConnectionsCard } from './misa-amis-connections.tsx';

export function IntegrationsSection({ role, orgSlug }: { role: Role; orgSlug: string }) {
  const t = useTranslations('integrations');
  const headingId = useId();
  const bank = showsBankFeeds(getConfig());
  // The same queries as the card's, so the answers are shared and nothing is asked twice.
  const providers = useQuery(orpc.einvoice.providers.queryOptions());
  const connections = useQuery(orpc.einvoice.connections.list.queryOptions());
  const einvoice = einvoiceCardShown(providers.data, connections.data);
  const marketplaceProviders = useQuery(orpc.marketplace.providers.queryOptions());
  const marketplaceConnections = useQuery(orpc.marketplace.connections.list.queryOptions());
  const marketplace = marketplaceCardShown(marketplaceProviders.data?.adapters, marketplaceConnections.data);
  const misaAmisStatus = useQuery(orpc.misaAmis.status.queryOptions());
  const misaAmisConnections = useQuery(orpc.misaAmis.connections.list.queryOptions());
  const misaAmis = misaAmisCardShown(misaAmisStatus.data?.offered === true || misaAmisStatus.data?.aspOffered === true, misaAmisConnections.data);
  const shown = bank || einvoice || marketplace || misaAmis;
  // A link to #integrations (the sales invoices screen sends owners here to connect a provider, #3602) scrolls here once the section is drawn.
  useEffect(() => {
    if (shown && window.location.hash === '#integrations') document.getElementById('integrations')?.scrollIntoView({ block: 'start' });
  }, [shown]);
  if (!shown) return null;
  return (
    <section id="integrations" aria-labelledby={headingId} className="scroll-mt-4 lg:col-span-2">
      <h2 id={headingId} className="text-base font-semibold text-foreground">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('lead')}</p>
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        {bank && <BankFeedsCard key={`bank-feeds:${orgSlug}`} role={role} offers={{ sandbox: Boolean(getConfig().bankFeeds?.sandbox), tingee: Boolean(getConfig().bankFeeds?.tingee) }} />}
        {einvoice && <EInvoiceConnectionsCard key={`einvoice-connections:${orgSlug}`} role={role} />}
        {marketplace && <MarketplaceConnectionsCard key={`marketplace-connections:${orgSlug}`} role={role} />}
        {misaAmis && <MisaAmisConnectionsCard key={`misa-amis-connections:${orgSlug}`} role={role} />}
      </div>
    </section>
  );
}
