// SPDX-License-Identifier: AGPL-3.0-only
// What keeps Ads from being switched off for an org (ADR-0053 section 4, and the Platform PO's rule of 2026-11-16): a campaign that is running, and an
// activation or a create that was begun at the platform and not settled. Turning Ads off then would leave spend running, or an object switched on, with the
// screens that show it hidden. The owner stops the campaign first (stopping runs while the app is off), and kernel.org.set_app refuses (APP_BUSY) until then.
// Read in the same transaction as the switch, which holds the tenant row; the begin commands take it too (opensBusyWork).
import { sql, type Transaction } from 'kysely';
import type { Database } from '@crove/db';

/** The reasons Ads is busy for the org, as short codes (none: it can be switched off). */
export async function adsBusy(trx: Transaction<Database>, orgId: string): Promise<string[]> {
  const reasons: string[] = [];
  const running = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM crove_ads.ad_launch
    WHERE org_id = ${orgId}::uuid AND state IN ('launching', 'live', 'needs_attention')`.execute(trx);
  if ((running.rows[0]?.n ?? 0) > 0) reasons.push('campaign_running');
  // A call begun and not settled: the platform may have done it. An activation switches objects on (spend), a create or a pause changes what is there.
  const open = await sql<{ activation: number; other: number }>`
    SELECT count(*) FILTER (WHERE key LIKE 'ads.launch:%:activate\\_%')::int AS activation,
           count(*) FILTER (WHERE key NOT LIKE 'ads.launch:%:activate\\_%')::int AS other
    FROM crove_kernel.external_call
    WHERE org_id = ${orgId}::uuid AND (key LIKE 'ads.launch:%' OR key LIKE 'ads.pause:%') AND state IN ('started', 'ambiguous')`.execute(trx);
  if ((open.rows[0]?.activation ?? 0) > 0) reasons.push('activation_open');
  if ((open.rows[0]?.other ?? 0) > 0) reasons.push('call_open');
  return reasons;
}
