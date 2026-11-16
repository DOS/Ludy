// SPDX-License-Identifier: AGPL-3.0-only
// What keeps Meetings from being switched off for an org (ADR-0053 section 4): a recording the extension is making now, or a platform recording on its way in.
// Turning the app off would end that work half done, so kernel.org.set_app refuses (APP_BUSY) until it is over. Read in the same transaction as the switch,
// which holds the tenant row; the commands that open such work take it too (opensBusyWork), so a start and a switch-off never both succeed.
import { sql, type Transaction } from 'kysely';
import type { Database } from '@crove/db';
import { RECORDING_NOW_WINDOW_HOURS } from '@crove/kernel-contract';

/** The reasons Meetings is busy for the org, as short codes (none: it can be switched off). */
export async function meetingsBusy(trx: Transaction<Database>, orgId: string): Promise<string[]> {
  const reasons: string[] = [];
  // The extension's recording: a ready meeting stamped with a token, not ended (the first media record ends it), started within the window a recording can last.
  const recording = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM crove_meetings.meeting
    WHERE org_id = ${orgId}::uuid AND status = 'ready' AND extension_token_id IS NOT NULL AND ended_at IS NULL
      AND started_at > pg_catalog.now() - ${`${RECORDING_NOW_WINDOW_HOURS} hours`}::interval`.execute(trx);
  if ((recording.rows[0]?.n ?? 0) > 0) reasons.push('recording');
  // A recording from a meeting platform that is being fetched or waits to be claimed.
  const importing = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM crove_kernel.meeting_platform_recording
    WHERE org_id = ${orgId}::uuid AND status IN ('importing', 'staged', 'claimed')`.execute(trx);
  if ((importing.rows[0]?.n ?? 0) > 0) reasons.push('import');
  return reasons;
}
