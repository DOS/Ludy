// SPDX-License-Identifier: AGPL-3.0-only
// What keeps Meetings from being switched off for an org (ADR-0053 section 4): a recording being made now, by any member, or a platform recording on its way in.
// Turning the app off would end that work half done, so kernel.org.set_app refuses (APP_BUSY) until it is over. Read in the same transaction as the switch,
// which holds the tenant row; the commands that open such work take it too (opensBusyWork), so a start and a switch-off never both succeed. The rows are read by a
// definer (crove_meetings.org_busy_reasons): a meeting is visible only to its recorder and readers, so the switcher's own context would miss another member's.
import { sql, type Transaction } from 'kysely';
import type { Database } from '@crove/db';
import { RECORDING_NOW_WINDOW_HOURS } from '@crove/kernel-contract';

/** The reasons Meetings is busy for the org, as short codes (none: it can be switched off). */
export async function meetingsBusy(trx: Transaction<Database>, orgId: string): Promise<string[]> {
  const { rows } = await sql<{ recording: boolean; import: boolean }>`SELECT recording, import FROM crove_meetings.org_busy_reasons(${orgId}::uuid, ${RECORDING_NOW_WINDOW_HOURS}::int)`.execute(trx);
  const busy = rows[0];
  return [...(busy?.recording ? ['recording'] : []), ...(busy?.import ? ['import'] : [])];
}
