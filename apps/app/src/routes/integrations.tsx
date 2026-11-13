// SPDX-License-Identifier: AGPL-3.0-only
// The "Tích hợp" (Integrations) section of Settings, with the finance module: where an org connects the company to the outside services its books work with. Today
// that is the bank feed (ADR-0039), the e-invoice provider (ADR-0044) and the marketplaces (ADR-0045, #2519). Each card draws itself only where the deployment
// offers something to connect or the org already has a connection, and the section's heading shows only while one of them does.
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { useTranslations } from 'use-intl';
import { orpc } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { showsBankFeeds } from '../lib/bank-feeds.ts';
import { einvoiceCardShown } from '../lib/einvoice-connections.ts';
import { marketplaceCardShown } from '../lib/marketplace-connections.ts';
import type { Role } from '../lib/members.ts';
import { BankFeedsCard } from './bank-feeds.tsx';
import { EInvoiceConnectionsCard } from './einvoice-connections.tsx';
import { MarketplaceConnectionsCard } from './marketplace-connections.tsx';

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
  if (!bank && !einvoice && !marketplace) return null;
  return (
    <section aria-labelledby={headingId} className="lg:col-span-2">
      <h2 id={headingId} className="text-base font-semibold text-foreground">
        {t('title')}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('lead')}</p>
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        {bank && <BankFeedsCard key={`bank-feeds:${orgSlug}`} role={role} />}
        {einvoice && <EInvoiceConnectionsCard key={`einvoice-connections:${orgSlug}`} role={role} />}
        {marketplace && <MarketplaceConnectionsCard key={`marketplace-connections:${orgSlug}`} role={role} />}
      </div>
    </section>
  );
}
