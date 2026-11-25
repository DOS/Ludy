// SPDX-License-Identifier: AGPL-3.0-only
// Resolves the owning org of a Social or CRM public address read-only and gates it on both the org's app switch and
// its billing entitlement (ADR-0053 section 2) before any public read or visitor write runs. Never returns the org id.
import { sql } from 'kysely';
import type { Runtime } from '@ludy/kernel-runtime';

export type SocialPublicPageKind = 'review_link' | 'report_link' | 'short_link' | 'bio' | 'calendar_feed';
export type CrmPublicPageKind = 'booking_page' | 'booking_manage' | 'booking_feed' | 'quote_link';

type PublicPageSpec =
  | { module: 'social'; kind: SocialPublicPageKind }
  | { module: 'crm'; kind: CrmPublicPageKind };

export async function publicPageAllowed(runtime: Runtime, spec: PublicPageSpec, key: string): Promise<boolean> {
  const orgId = await runtime.orgless(async (db) => {
    const { rows } =
      spec.module === 'social'
        ? await sql<{ org_id: string | null }>`SELECT ludy_social.public_page_org(${spec.kind}, ${key}) AS org_id`.execute(db)
        : await sql<{ org_id: string | null }>`SELECT ludy_crm.public_page_org(${spec.kind}, ${key}) AS org_id`.execute(db);
    return rows[0]?.org_id ?? null;
  });
  if (!orgId) return false;
  return runtime.appOn(orgId, spec.module, { fresh: true });
}
