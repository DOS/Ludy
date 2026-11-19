// SPDX-License-Identifier: AGPL-3.0-only
// The worker relay of MISA AMIS's callback (#3903, S4 of #3854), without a database: what it records for a claimed result (only a row in `sent` or `ambiguous`, only along the graph, only for the organisation
// the stored push row names, only when the envelope's company code and the signed voucher type are the located ones, never for a refid two organisations hold, a refusal only for a row never sent again), that it
// runs the one write path as the system actor, marks a result done once recorded or once nothing can be recorded, leaves one whose recording met an outage, and logs a fixed code only. The claim and the command on a
// real database are tested in misa-amis-callback.db.test.ts.
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type Driver, type QueryResult } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError, type Runtime } from '@crove/kernel-runtime';
import { MISA_AMIS_CALLBACK_CLAIM, moveFor, runMisaAmisCallbacks, type ClaimedCallback } from '../src/misa-amis-callback-relay.ts';

const CODE = `ludy-${'a'.repeat(32)}`;
const OTHER_CODE = `ludy-${'b'.repeat(32)}`;
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const CONN_A = randomUUID();
const CONN_B = randomUUID();
const REF1 = randomUUID();
const REF2 = randomUUID();
const REASON_TEXT = 'LOI-RIENG-CUA-MISA-0042';

let nextSeq = 1;
// One claimed result with the row that holds its refid (the m_ columns).
function claimed(over: Partial<ClaimedCallback> = {}): ClaimedCallback {
  return {
    seq: String(nextSeq++),
    org_refid: REF1,
    voucher_type: 1,
    org_company_code: CODE,
    success: true,
    error_code: null,
    error_message: null,
    m_org_id: ORG_A,
    m_connection_id: CONN_A,
    m_state: 'sent',
    m_attempts: 1,
    m_voucher_type: 1,
    m_org_company_code: CODE,
    ...over,
  };
}

function fixture(claims: ClaimedCallback[][], executeError?: (name: string) => unknown) {
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  const batches = [...claims];
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      queries.push({ sql: query.sql, parameters: query.parameters });
      return { rows: (query.sql.includes('misa_amis_callback_claim') ? (batches.shift() ?? []) : [{ done: 1 }]) as unknown as R[] };
    },
    streamQuery: async function* () {
      yield* [];
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const workerDb = new Kysely<unknown>({ dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => driver, createIntrospector: (k) => new PostgresIntrospector(k), createQueryCompiler: () => new PostgresQueryCompiler() } });
  const executed: Array<{ name: string; input: { connectionId: string; rows: Array<{ orgRefid: string; attempts: number; from: string; to: string; reason: string | null }>; call: null }; options: { actor: unknown; orgId: string } }> = [];
  const runtime = {
    execute: async (name: string, input: never, options: never) => {
      executed.push({ name, input, options });
      const failure = executeError?.(name);
      if (failure) throw failure;
      return { applied: 1, ignored: 0 };
    },
  } as unknown as Runtime;
  const doneSeqs = () => queries.filter((q) => q.sql.includes('misa_amis_callback_done')).flatMap((q) => q.parameters[0] as string[]);
  return { workerDb, runtime, executed, queries, doneSeqs };
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  nextSeq = 1;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
});
afterEach(() => vi.restoreAllMocks());

const located = (over: Partial<{ org_id: string; connection_id: string; state: string; attempts: number; voucher_type: number; org_company_code: string }> = {}) => ({
  org_id: ORG_A,
  connection_id: CONN_A,
  state: 'sent',
  attempts: 1,
  voucher_type: 1,
  org_company_code: CODE,
  ...over,
});
const answer = (over: Partial<ClaimedCallback> = {}) => ({ org_refid: REF1, voucher_type: 1, org_company_code: CODE, success: true, error_code: null, error_message: null, ...over });

describe('what a claimed result records', () => {
  it('moves a sent row to accepted and a row whose answer was lost to refused with MISA\'s text, carrying the attempt it found', () => {
    expect(moveFor(answer(), [located()])).toEqual({ orgId: ORG_A, connectionId: CONN_A, move: { orgRefid: REF1, attempts: 1, from: 'sent', to: 'accepted', reason: null } });
    expect(moveFor(answer({ success: false, error_message: REASON_TEXT, error_code: 'Boom' }), [located({ state: 'ambiguous' })])?.move).toEqual({ orgRefid: REF1, attempts: 1, from: 'ambiguous', to: 'refused', reason: REASON_TEXT });
    // Without MISA's text, its plain code; without either, a fixed word.
    expect(moveFor(answer({ success: false, error_code: 'Boom' }), [located()])?.move.reason).toBe('Boom');
    expect(moveFor(answer({ success: false }), [located()])?.move.reason).toBe('REFUSED');
  });

  it('moves nothing for no row, a refid in two organisations (or twice in one), another company code or voucher type, or a row no result may answer', () => {
    expect(moveFor(answer(), [])).toBeNull();
    expect(moveFor(answer(), [located(), located({ org_id: ORG_B, connection_id: CONN_B })])).toBeNull();
    expect(moveFor(answer(), [located(), located()])).toBeNull();
    expect(moveFor(answer(), [located({ org_company_code: OTHER_CODE })])).toBeNull();
    expect(moveFor(answer({ org_company_code: OTHER_CODE }), [located()])).toBeNull();
    expect(moveFor(answer({ voucher_type: 4 }), [located()])).toBeNull();
    for (const state of ['queued', 'sending', 'accepted', 'refused', 'failed']) expect(moveFor(answer(), [located({ state })]), state).toBeNull();
  });

  it('records no refusal for a row that was sent again, but an acceptance for any attempt', () => {
    expect(moveFor(answer({ success: false, error_message: REASON_TEXT }), [located({ attempts: 2 })])).toBeNull();
    expect(moveFor(answer(), [located({ attempts: 3 })])?.move).toMatchObject({ attempts: 3, to: 'accepted' });
  });
});

describe('the relay', () => {
  it('records through finance.misa_amis.push_record as the system actor, one call per organisation and connection, and marks the results done', async () => {
    const first = claimed();
    const second = claimed({ org_refid: REF2, success: false, error_message: REASON_TEXT, m_org_id: ORG_B, m_connection_id: CONN_B });
    const t = fixture([[first, second]]);
    expect(await runMisaAmisCallbacks({ runtime: t.runtime, workerDb: t.workerDb as never })).toBe(2);
    expect(t.executed).toEqual([
      {
        name: 'finance.misa_amis.push_record',
        input: { connectionId: CONN_A, rows: [{ orgRefid: REF1, attempts: 1, from: 'sent', to: 'accepted', reason: null }], call: null },
        options: { actor: { type: 'system', component: 'finance.misa_amis' }, orgId: ORG_A },
      },
      {
        name: 'finance.misa_amis.push_record',
        input: { connectionId: CONN_B, rows: [{ orgRefid: REF2, attempts: 1, from: 'sent', to: 'refused', reason: REASON_TEXT }], call: null },
        options: { actor: { type: 'system', component: 'finance.misa_amis' }, orgId: ORG_B },
      },
    ]);
    expect(t.doneSeqs().sort()).toEqual([first.seq, second.seq].sort());
  });

  it('marks done, and runs nothing for, a result nothing can be recorded for: no row, two organisations, another code, a row not yet answerable', async () => {
    const none = claimed({ m_org_id: null, m_connection_id: null, m_state: null, m_attempts: null, m_voucher_type: null, m_org_company_code: null });
    const twoA = claimed({ org_refid: REF2 });
    const twoB = { ...twoA, m_org_id: ORG_B, m_connection_id: CONN_B };
    const otherCode = claimed({ m_org_company_code: OTHER_CODE });
    const sending = claimed({ m_state: 'sending' });
    const t = fixture([[none, twoA, twoB, otherCode, sending]]);
    expect(await runMisaAmisCallbacks({ runtime: t.runtime, workerDb: t.workerDb as never })).toBe(4);
    expect(t.executed).toEqual([]);
    expect(t.doneSeqs().sort()).toEqual([none.seq, twoA.seq, otherCode.seq, sending.seq].sort());
  });

  it('drops a result the command refuses, and leaves one that met an outage to be taken again, logging a fixed code only', async () => {
    const refused = claimed({ error_message: REASON_TEXT });
    const refusedRun = fixture([[refused]], () => new DomainError('MODULE_OFF', 403, 'x'));
    await runMisaAmisCallbacks({ runtime: refusedRun.runtime, workerDb: refusedRun.workerDb as never });
    expect(refusedRun.doneSeqs()).toEqual([refused.seq]);

    for (const outage of [new DomainError('INTERNAL', 500, `x ${REASON_TEXT}`), new DomainError('OVERLOADED', 503, 'x'), new DomainError('RETRY', 409, 'x'), new Error(`reset ${REASON_TEXT}`)]) {
      const left = claimed();
      const run = fixture([[left]], () => outage);
      await runMisaAmisCallbacks({ runtime: run.runtime, workerDb: run.workerDb as never });
      expect(run.doneSeqs(), String(outage)).toEqual([]);
    }
    expect(logs.join('\n')).toContain('RELAY_FAILED');
    for (const secret of [REASON_TEXT, REF1, CODE]) expect(logs.join('\n'), secret).not.toContain(secret);
  });

  it('takes the next batch while a full one comes back, and stops on a short one or an empty table', async () => {
    const full = Array.from({ length: MISA_AMIS_CALLBACK_CLAIM }, () => claimed({ org_refid: randomUUID() }));
    const t = fixture([full, [claimed({ org_refid: randomUUID() })]]);
    expect(await runMisaAmisCallbacks({ runtime: t.runtime, workerDb: t.workerDb as never })).toBe(MISA_AMIS_CALLBACK_CLAIM + 1);
    expect(t.queries.filter((q) => q.sql.includes('misa_amis_callback_claim'))).toHaveLength(2);
    const empty = fixture([]);
    expect(await runMisaAmisCallbacks({ runtime: empty.runtime, workerDb: empty.workerDb as never })).toBe(0);
    expect(empty.queries.filter((q) => q.sql.includes('misa_amis_callback_done'))).toEqual([]);
  });
});
