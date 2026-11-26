// SPDX-License-Identifier: AGPL-3.0-only
// The worker relay of MISA AMIS's callback (#3903, S4 of #3854). The route (misa-amis-callback.ts) stores the signed results of a verified message in a machinery table; this relay takes them with
// ludy_finance.misa_amis_callback_claim (worker only), which finds, by org_refid in SQL, the organisation and the stored push row of each result (never from the envelope), and records through the one
// write path, `finance.misa_amis.push_record`, as the system actor: the system context is the worker's alone, so this is the only place a callback can be recorded.
//
// The HMAC key is one per deployment, so a good signature proves the sender, not the organisation: ludy_finance.misa_amis_callback_claim refuses a refid stored in more than one organisation across ALL holders
// in ludy_finance.misa_amis_push before filtering by active tenant, Finance enabled, or product (and moveFor keeps the multi-row check as defense-in-depth), and the envelope's company code and the signed voucher type
// must equal the located connection's and row's. Moves are forward only: only a row in `sent` or `ambiguous` moves, to `accepted` on success, else `refused` with MISA's text (capped, untrusted, never logged),
// and the command updates only where the state and the attempt still match, so a replay or an old failure after an acceptance changes nothing. A result for a row still `sending` or `queued` waits (MISA can call back before the worker records `sent`) and is taken again after five minutes; for a `failed` one, nothing is recorded.
// The signed `data` carries no attempt, session or time, so a refusal is recorded only for a row never sent again: an old refusal replayed against a second send of the same voucher is ignored (an acceptance is
// recorded for any attempt, the voucher is in AMIS). packages/misa-amis `client.remove()` is unused today, so every result is for a save; a future delete slice must track delete requests separately (never trusting unsigned `data_type`) so a delete success cannot settle a sent/ambiguous save as accepted.
//
// Results older than seven days are purged by ludy_finance.misa_amis_callback_sweep() and logged with one fixed code and the numeric count only. A result is marked done once recorded or once nothing can be recorded for it; one whose recording met an outage is left, and taken again after five minutes (recording is idempotent). A failure logs one
// fixed code: nothing of a result, a refid or MISA's text.
import { sql } from 'kysely';
import { DomainError, type Runtime } from '@ludy/kernel-runtime';
import type { Db } from '@ludy/db';

const SYSTEM = { type: 'system' as const, component: 'finance.misa_amis' };
export const MISA_AMIS_CALLBACK_CLAIM = 100;
const MAX_ROUNDS = 10;

// One claimed result with the row that holds its refid (the m_ columns, null when none does, when inactive/Finance-off, or when held by more than one organisation).
export interface ClaimedCallback {
  seq: string;
  org_refid: string;
  voucher_type: number;
  org_company_code: string;
  success: boolean;
  error_code: string | null;
  error_message: string | null;
  m_org_id: string | null;
  m_connection_id: string | null;
  m_state: string | null;
  m_attempts: number | null;
  m_voucher_type: number | null;
  m_org_company_code: string | null;
}

interface Located {
  org_id: string;
  connection_id: string;
  state: string;
  attempts: number;
  voucher_type: number;
  org_company_code: string;
}

export interface Move {
  orgRefid: string;
  attempts: number;
  from: 'sent' | 'ambiguous';
  to: 'accepted' | 'refused';
  reason: string | null;
}

/** What to record for a claimed result, by the rows that hold its refid, or null when nothing moves: no row, a refid found in two organisations, a company code or voucher type that is not the located one, a row no result may answer, or a refusal for a row that was sent again. */
export function moveFor(
  result: Pick<ClaimedCallback, 'org_refid' | 'voucher_type' | 'org_company_code' | 'success' | 'error_code' | 'error_message'>,
  rows: readonly Located[],
): { orgId: string; connectionId: string; move: Move } | null {
  // A refid stored in more than one organisation cannot be told apart by a deployment-wide key: refused, nothing recorded.
  if (new Set(rows.map((r) => r.org_id)).size !== 1 || rows.length !== 1) return null;
  const row = rows[0] as Located;
  if (row.org_company_code !== result.org_company_code || row.voucher_type !== result.voucher_type) return null;
  // Only a request MISA may still answer: sent, or one whose answer was lost.
  if (row.state !== 'sent' && row.state !== 'ambiguous') return null;
  if (!result.success && row.attempts > 1) return null;
  const reason = result.success ? null : (result.error_message ?? result.error_code ?? 'REFUSED');
  return { orgId: row.org_id, connectionId: row.connection_id, move: { orgRefid: result.org_refid, attempts: row.attempts, from: row.state, to: result.success ? 'accepted' : 'refused', reason } };
}

/** Whether a result will be answerable soon: the one row that holds its refid is the located one (its company code and voucher type match) and has not been sent yet, or is being sent (MISA can call back before the worker records `sent`). Such a result is left, and taken again after five minutes; the seven day purge bounds it. */
export function answerableLater(
  result: Pick<ClaimedCallback, 'voucher_type' | 'org_company_code'>,
  rows: readonly Located[],
): boolean {
  if (rows.length !== 1) return false;
  const row = rows[0] as Located;
  return row.org_company_code === result.org_company_code && row.voucher_type === result.voucher_type && (row.state === 'queued' || row.state === 'sending');
}

/** Takes the waiting results and records them. Returns how many results it took. */
export async function runMisaAmisCallbacks(deps: { runtime: Runtime; workerDb: Db }): Promise<number> {
  const { rows: swept } = await sql<{ purged: number }>`SELECT ludy_finance.misa_amis_callback_sweep() AS purged`.execute(deps.workerDb);
  const purged = Number(swept[0]?.purged ?? 0);
  if (purged > 0) console.warn(`[misa-amis-callback] expired: CALLBACK_EXPIRED count=${purged}`);
  let taken = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const { rows } = await sql<ClaimedCallback>`SELECT * FROM ludy_finance.misa_amis_callback_claim(${MISA_AMIS_CALLBACK_CLAIM}::int)`.execute(deps.workerDb);
    if (rows.length === 0) break;
    const bySeq = new Map<string, { result: ClaimedCallback; located: Located[] }>();
    for (const row of rows) {
      const entry = bySeq.get(row.seq) ?? { result: row, located: [] };
      if (row.m_org_id && row.m_connection_id && row.m_state && row.m_attempts !== null && row.m_voucher_type !== null && row.m_org_company_code) {
        entry.located.push({ org_id: row.m_org_id, connection_id: row.m_connection_id, state: row.m_state, attempts: row.m_attempts, voucher_type: row.m_voucher_type, org_company_code: row.m_org_company_code });
      }
      bySeq.set(row.seq, entry);
    }
    const done: string[] = [];
    const groups = new Map<string, { orgId: string; connectionId: string; moves: Move[]; seqs: string[] }>();
    for (const [seq, { result, located }] of bySeq) {
      const found = moveFor(result, located);
      if (!found) {
        // A row not sent yet may still be answered: the result waits for the next take instead of being dropped.
        if (!answerableLater(result, located)) done.push(seq);
        continue;
      }
      const key = `${found.orgId}:${found.connectionId}`;
      const group = groups.get(key) ?? { orgId: found.orgId, connectionId: found.connectionId, moves: [], seqs: [] };
      group.moves.push(found.move);
      group.seqs.push(seq);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      try {
        await deps.runtime.execute('finance.misa_amis.push_record', { connectionId: group.connectionId, rows: group.moves, call: null }, { actor: SYSTEM, orgId: group.orgId });
        done.push(...group.seqs);
      } catch (error) {
        // A refusal of the command (an organisation whose Finance went off meanwhile, a state the graph does not allow) is final: nothing to retry. An outage (status 500 and over, or RETRY) is left, and taken again.
        if (error instanceof DomainError && error.status < 500 && error.code !== 'RETRY') done.push(...group.seqs);
        else console.error('[misa-amis-callback] not recorded: RELAY_FAILED');
      }
    }
    if (done.length > 0) await sql`SELECT ludy_finance.misa_amis_callback_done(${done}::bigint[])`.execute(deps.workerDb);
    taken += bySeq.size;
    if (bySeq.size < MISA_AMIS_CALLBACK_CLAIM) break;
  }
  return taken;
}
