// SPDX-License-Identifier: AGPL-3.0-only
// What keeps Ads from being switched off for an org (ADR-0053 section 4, and the Platform PO's rule of 2026-11-16): a campaign that is running, a stopped one whose
// objects are not yet paused at the platform, and a call begun at the platform for such a launch and not settled. Turning Ads off then would leave spend running, or
// an object switched on, with the screens that show it hidden. The owner stops the campaign first (stopping runs while the app is off) and waits for the pause, and
// kernel.org.set_app refuses (APP_BUSY) until then. A call row of a launch that is over (wound down, failed, cancelled) is history, not work: some paths leave one
// unsettled for good, and it must not keep the app on. Read in the same transaction as the switch, which holds the tenant row; the begin commands take it too.
import { sql, type Transaction } from 'kysely';
import type { Database } from '@ludy/db';

/** The reasons Ads is busy for the org, as short codes (none: it can be switched off). */
export async function adsBusy(trx: Transaction<Database>, orgId: string): Promise<string[]> {
  const reasons: string[] = [];
  // The launches that are not wound down, as hasOpenLaunch counts them: started and going, or stopped and not yet paused at the platform (and not given up on).
  const { rows } = await sql<{ running: number; winding: number; activation: number; other: number }>`
    WITH open AS (
      SELECT l.id, l.state FROM crove_ads.ad_launch l
      WHERE l.org_id = ${orgId}::uuid
        AND (l.state IN ('launching', 'needs_attention', 'live')
             OR (l.state = 'stopped' AND l.started_at IS NOT NULL AND l.wound_down_at IS NULL AND l.wind_down_code IS NULL))
    ), calls AS (
      SELECT c.key LIKE 'ads.launch:%:activate\\_%' AS activation
      FROM ludy_kernel.external_call c
      JOIN open o ON o.id::text = pg_catalog.split_part(c.key, ':', 2)
      WHERE c.org_id = ${orgId}::uuid AND (c.key LIKE 'ads.launch:%' OR c.key LIKE 'ads.pause:%') AND c.state IN ('started', 'ambiguous')
    )
    SELECT (SELECT count(*)::int FROM open WHERE state <> 'stopped') AS running,
           (SELECT count(*)::int FROM open WHERE state = 'stopped') AS winding,
           (SELECT count(*)::int FROM calls WHERE activation) AS activation,
           (SELECT count(*)::int FROM calls WHERE NOT activation) AS other`.execute(trx);
  const row = rows[0];
  if ((row?.running ?? 0) > 0) reasons.push('campaign_running');
  if ((row?.winding ?? 0) > 0) reasons.push('wind_down_open');
  if ((row?.activation ?? 0) > 0) reasons.push('activation_open');
  if ((row?.other ?? 0) > 0) reasons.push('call_open');
  return reasons;
}
