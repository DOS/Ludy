// SPDX-License-Identifier: AGPL-3.0-only
// The `feature` column of crove_kernel.ai_run (#3029, ADR-0049 decision 2 amended 2026-11-12: one live Vy run per member per feature). The raw seeds of this suite insert an
// ai_run row of a member's Vy and its member_vy_result row by hand; once the column exists, a member_vy run needs a feature equal to its result's. This helper answers the
// extra column and value of such an insert, and nothing on a database that has no such column, so a seed passes before and after the migration that adds it.
import type pg from 'pg';

export type AiRunFeature = { cols: string; vals: string };

/** `{ cols: ', feature', vals: ", 'notes.summary'" }` when ai_run has the column, else both empty. Append `cols` to the column list and `vals` to the VALUES list. */
export async function aiRunFeature(client: pg.Client, feature = 'notes.summary'): Promise<AiRunFeature> {
  if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(feature)) throw new Error(`not a feature key: ${feature}`);
  const { rows } = await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'crove_kernel' AND table_name = 'ai_run' AND column_name = 'feature'");
  return rows.length > 0 ? { cols: ', feature', vals: `, '${feature}'` } : { cols: '', vals: '' };
}
