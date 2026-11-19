// SPDX-License-Identifier: AGPL-3.0-only
// The callback MISA AMIS posts the result of a save to (#3903, S4 of #3854). The route is public: the only thing that tells a message from MISA is the HMAC of its `data` with the
// ClientID, one key for the whole deployment, so a good signature proves the sender and not the organisation. The organisation therefore comes only from our own stored push row by
// org_refid (crove_finance.misa_amis_push_locate, orgless, read-only), and the unsigned envelope's company code must equal the located connection's own.
//
// Order of work, which is the point: the body is capped and the client address limited before the body is read (http.ts); readCallback parses only the signature and `data`, compares in
// constant time and only then reads the rest; only a verified message reaches the database. A refusal is a fixed code and nothing else: the body, the signature, MISA's text and the
// ClientID are never logged, stored or echoed. A verified message is always answered 200 whatever happened to each result, so the answer never tells a caller whether an org_refid exists.
//
// Recording goes through the one write path, `finance.misa_amis.push_record` (system actor, from = the located state, to = accepted or refused). The command updates only where the state
// and the attempt still match, so a replay changes nothing, and the graph only moves forward: an old failure replayed after an acceptance finds the row in `accepted` and is ignored.
// The signed `data` has no time or nonce, so arrival order is never trusted. A result for a row still `sending` (or `queued`, `failed`) is ignored: polling (S3b) reads it. `batchError`
// is unsigned and moves nothing.
import { sql } from 'kysely';
import { readCallback, type AmisCallbackResult } from '@crove/misa-amis';
import { DomainError, type Runtime } from '@crove/kernel-runtime';

// 1000 results of about 300 bytes each, with the envelope and MISA's error texts (each cut at 500 characters): well inside this.
export const MAX_MISA_AMIS_CALLBACK_BYTES = 1024 * 1024;

const SYSTEM = { type: 'system' as const, component: 'finance.misa_amis' };

export type MisaAmisCallbackOutcome =
  | { status: 200 }
  | { status: 401; code: 'WEBHOOK_SIGNATURE' }
  | { status: 400; code: 'WEBHOOK_MALFORMED' };

interface Located {
  org_refid: string;
  org_id: string;
  connection_id: string;
  state: string;
  attempts: number;
  voucher_type: number;
  org_company_code: string;
}

interface Move {
  orgRefid: string;
  attempts: number;
  from: 'sent' | 'ambiguous';
  to: 'accepted' | 'refused';
  reason: string | null;
}

/** What to record for a result, by the row we stored for it, or null when nothing moves: no row, a refid found in two organisations, a company code or voucher type that is not the located one, or a row no result may answer. */
export function moveFor(result: AmisCallbackResult, rows: readonly Located[], orgCompanyCode: string): { orgId: string; connectionId: string; move: Move } | null {
  // A refid stored in more than one organisation cannot be told apart by a deployment-wide key: refused, nothing recorded.
  if (new Set(rows.map((r) => r.org_id)).size !== 1) return null;
  const row = rows[0];
  if (!row || rows.length !== 1) return null;
  if (row.org_company_code !== orgCompanyCode || row.voucher_type !== result.voucherType) return null;
  // Only a request MISA may still answer: sent, or one whose answer was lost.
  if (row.state !== 'sent' && row.state !== 'ambiguous') return null;
  const reason = result.success ? null : (result.errorMessage ?? result.errorCode ?? 'REFUSED');
  return { orgId: row.org_id, connectionId: row.connection_id, move: { orgRefid: row.org_refid, attempts: row.attempts, from: row.state, to: result.success ? 'accepted' : 'refused', reason } };
}

export async function acceptMisaAmisCallback(runtime: Runtime, clientId: string, rawBody: string): Promise<MisaAmisCallbackOutcome> {
  const read = readCallback(rawBody, clientId);
  if (!read.ok) return read.reason === 'signature' || read.reason === 'app_id' ? { status: 401, code: 'WEBHOOK_SIGNATURE' } : { status: 400, code: 'WEBHOOK_MALFORMED' };
  const { callback } = read;
  // The first result of a refid decides (a message that repeats one is MISA's own noise, and the second would find the row moved anyway).
  const results = [...new Map(callback.results.map((r) => [r.orgRefId, r] as const)).values()];
  if (results.length === 0) return { status: 200 };

  const located = await runtime.orgless(async (db) => {
    const { rows } = await sql<Located>`SELECT org_refid, org_id, connection_id, state, attempts, voucher_type, org_company_code FROM crove_finance.misa_amis_push_locate(${results.map((r) => r.orgRefId)}::uuid[])`.execute(db);
    return rows;
  });
  const byRefid = new Map<string, Located[]>();
  for (const row of located) byRefid.set(row.org_refid, [...(byRefid.get(row.org_refid) ?? []), row]);

  // One command per organisation and connection, with its rows.
  const groups = new Map<string, { orgId: string; connectionId: string; moves: Move[] }>();
  for (const result of results) {
    const found = moveFor(result, byRefid.get(result.orgRefId) ?? [], callback.orgCompanyCode);
    if (!found) continue;
    const key = `${found.orgId}:${found.connectionId}`;
    const group = groups.get(key) ?? { orgId: found.orgId, connectionId: found.connectionId, moves: [] };
    group.moves.push(found.move);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    try {
      await runtime.execute('finance.misa_amis.push_record', { connectionId: group.connectionId, rows: group.moves, call: null }, { actor: SYSTEM, orgId: group.orgId });
    } catch (error) {
      // A refusal of the command (an organisation whose Finance went off meanwhile, a state the graph does not allow) is not a reason to make MISA retry; an outage is, and propagates.
      if (!(error instanceof DomainError)) throw error;
    }
  }
  return { status: 200 };
}
