// SPDX-License-Identifier: AGPL-3.0-only
// Retention of the parsed rows of a decided bank statement (#2195), on a real PostgreSQL: a statement a member stages and then imports or skips keeps its rows in the staged extraction
// version; 90 days after the decision the nightly pass (runBankStatementRetention) deletes that version through finance.bank.statement_rows_purge, and keeps the decision's summary,
// the file row, the audit trail and the lines already booked. Nothing is deleted before day 90, a statement still staged or an org with finance off is left alone (and caught up when it is
// turned on again), a second run changes nothing, a failing file never holds the others, the batches walk the whole list, and neither the audit trail nor the log carries a file name,
// an account number or an amount. The database's own refusals (roles, contexts, kinds, holds) are pinned in test/invariant/bank-statement-rows-retention.db.test.ts.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { BANK_STATEMENT_ROWS_RETENTION_DAYS } from '@ludy/kernel-contract';
import { Runtime, fileKey, sha256Hex } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { runBankStatementRetention } from '../src/bank-statement-retention.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// What the staged rows carry about the other side, which must be nowhere once the rows are deleted, in no audit row and in no log line.
const COUNTERPARTY = 'Trần Thị Đối Tác Kín';
const COUNTERPARTY_ACCOUNT = '9704000011223344';
const FILENAME = 'sao-ke-tai-khoan-kin.xlsx';
const OWN_NUMBER = '19880001234';
const WORKER = { type: 'system' as const, component: 'finance.bank_statement' };

suite('retention of the staged rows of a decided bank statement (#2195)', () => {
  const dbName = `ludy_test_stmt_rows_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  let ownerId = '';
  let memberId = '';
  let orgId = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const rows = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return (await client.query<T>(text, values)).rows;
    } finally {
      await client.end();
    }
  };
  const quietLog = () => {
    const lines: string[] = [];
    return { lines, log: { log: (...a: unknown[]) => void lines.push(a.join(' ')), error: (...a: unknown[]) => void lines.push(a.join(' ')) } };
  };

  // A statement of this org (or another): staged by the worker as the reading job does, then decided by a member through the kernel command the Inbox's commands run.
  async function statement(state: 'imported' | 'rejected' | 'staged', ageDays: number, org = orgId, who = ownerId): Promise<string> {
    const bytes = new TextEncoder().encode(`PK-sao-ke-${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const { fileId } = await api.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: FILENAME, contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey: fileKey(org, sha256), generation: `content:${sha256}`, source: 'upload' },
      { actor: asUser(who), orgId: org },
    );
    const summary = { state: 'staged', filename: FILENAME, bankAccount: '1121', accountNumber: OWN_NUMBER, lines: 2, newLines: 2, duplicateLines: 0, from: '2026-09-01', to: '2026-09-02', totalIn: '2000000', totalOut: '0' };
    const staged = [
      { rowNo: 2, date: '01/09/2026', description: `Chuyển tiền ${COUNTERPARTY}`, moneyIn: '1000000', moneyOut: '', balance: '', reference: `FT-${randomUUID().slice(0, 6)}`, counterpartyAccount: COUNTERPARTY_ACCOUNT },
      { rowNo: 3, date: '02/09/2026', description: 'Thu tiền hàng', moneyIn: '1000000', moneyOut: '', balance: '', reference: `FT-${randomUUID().slice(0, 6)}`, counterpartyAccount: COUNTERPARTY_ACCOUNT },
    ];
    await worker.execute('kernel.extraction.record', { fileId, method: 'unsupported', checks: [], proposal: null, error: null, status: 'done', statement: true, result: { kind: 'bank_statement', summary, rows: staged }, summary: 'Sao kê chờ nhập' }, { actor: WORKER, orgId: org });
    if (state !== 'staged') await api.execute('kernel.extraction.statement_state', { fileId, state, newLines: 2, duplicateLines: 0 }, { actor: asUser(who), orgId: org, idempotencyKey: randomUUID() });
    await age(fileId, ageDays);
    return fileId;
  }
  // Time passes (the guard on finished versions is switched off for this one session only: the test stands in for the days).
  async function age(fileId: string, days: number) {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('UPDATE ludy_kernel.extraction SET completed_at = now() - make_interval(days => $2) WHERE file_id = $1', [fileId, days]);
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  }
  const versionsOf = (fileId: string) => rows<{ version: number; state: string | null; has_rows: boolean }>("SELECT version, result -> 'summary' ->> 'state' AS state, (result ? 'rows') AS has_rows FROM ludy_kernel.extraction WHERE file_id = $1 ORDER BY version", [fileId]);
  const run = (extra: { batch?: number; runtime?: Runtime } = {}) => {
    const out = quietLog();
    return runBankStatementRetention({ runtime: extra.runtime ?? worker, workerDb, log: out.log, ...(extra.batch !== undefined ? { batch: extra.batch } : {}) }).then((result) => ({ result, lines: out.lines }));
  };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 2 });
    const db = createDb(pool);
    workerDb = createDb(workerPool);
    const register = (target: Db) => new Runtime(target, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    api = register(db);
    worker = register(workerDb);
    ownerId = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@rows.test`, name: null });
    memberId = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `member-${randomUUID().slice(0, 8)}@rows.test`, name: null });
    orgId = (await createOrg(api, asUser(ownerId), 'Công ty giữ dòng sao kê')).orgId;
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, memberId]);
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('deletes the staged rows 90 days after a decision, keeps the summary, and a second run changes nothing', async () => {
    const imported = await statement('imported', BANK_STATEMENT_ROWS_RETENTION_DAYS + 1);
    const rejected = await statement('rejected', BANK_STATEMENT_ROWS_RETENTION_DAYS + 1);
    const before = await versionsOf(imported);
    expect(before.map((v) => [v.state, v.has_rows])).toEqual([['staged', true], ['imported', false]]);
    const decisionAudit = await rows<{ n: string }>("SELECT count(*) AS n FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.extraction.statement_state'", [orgId]);

    const first = await run();
    expect(first.result).toMatchObject({ statements: 2, versions: 2, skipped: 0, failed: 0 });
    // The staged version is gone, the decision's version stays, with the summary it had.
    expect((await versionsOf(imported)).map((v) => [v.state, v.has_rows])).toEqual([['imported', false]]);
    expect((await versionsOf(rejected)).map((v) => [v.state, v.has_rows])).toEqual([['rejected', false]]);
    // The rows of the other side are in no extraction version of the org any more, and the file rows are untouched.
    const left = await rows<{ result: unknown }>('SELECT result FROM ludy_kernel.extraction WHERE file_id = ANY($1::uuid[])', [[imported, rejected]]);
    expect(JSON.stringify(left)).not.toContain(COUNTERPARTY);
    expect(JSON.stringify(left)).not.toContain(COUNTERPARTY_ACCOUNT);
    expect(await rows('SELECT 1 FROM ludy_kernel.file WHERE id = ANY($1::uuid[])', [[imported, rejected]])).toHaveLength(2);
    // The decisions' audit rows are the same, and the purge audited ids and counts only.
    expect((await rows<{ n: string }>("SELECT count(*) AS n FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.extraction.statement_state'", [orgId]))[0]?.n).toBe(decisionAudit[0]?.n);
    const purges = await rows<{ target_id: string; detail: Record<string, unknown> }>("SELECT target_id::text, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.bank.statement_rows_purge' AND outcome = 'ok' ORDER BY occurred_at", [orgId]);
    expect(purges.map((p) => p.target_id).sort()).toEqual([imported, rejected].sort());
    for (const p of purges) expect(p.detail).toMatchObject({ fileId: p.target_id, applied: true, versions: 1 });
    // Ids, a flag and counts, plus what the runtime adds for a system actor: nothing of the statement.
    for (const p of purges) expect(Object.keys(p.detail).sort()).toEqual(['applied', 'component', 'fileId', 'versions', 'workerInstance']);
    expect(JSON.stringify(purges)).not.toContain(COUNTERPARTY);
    expect(JSON.stringify(purges)).not.toContain(FILENAME);
    // The log has ids' prefixes and counts, never a name, an account number or an amount.
    const logged = first.lines.join('\n');
    expect(logged).toContain('statements=2 versions=2 skipped=0 failed=0');
    for (const secret of [COUNTERPARTY, COUNTERPARTY_ACCOUNT, FILENAME, OWN_NUMBER, '1000000']) expect(logged).not.toContain(secret);

    // A second run finds nothing and changes nothing.
    const second = await run();
    expect(second.result).toEqual({ statements: 0, versions: 0, skipped: 0, failed: 0 });
    expect((await versionsOf(imported)).length).toBe(1);
  });

  it('deletes nothing before day 90, and nothing of a statement still waiting for a member', async () => {
    const young = await statement('imported', BANK_STATEMENT_ROWS_RETENTION_DAYS - 1);
    const waiting = await statement('staged', 400);
    expect((await run()).result).toMatchObject({ statements: 0, failed: 0 });
    expect(await versionsOf(young)).toHaveLength(2);
    expect(await versionsOf(waiting)).toHaveLength(1);
    // The day it turns 90 the decided one goes; the one still staged stays whatever its age.
    await age(young, BANK_STATEMENT_ROWS_RETENTION_DAYS + 1);
    expect((await run()).result).toMatchObject({ statements: 1, versions: 1 });
    expect(await versionsOf(young)).toHaveLength(1);
    expect(await versionsOf(waiting)).toHaveLength(1);
  });

  it('leaves an org with finance off alone and catches up when it is turned on again', async () => {
    const owner2 = await upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `owner2-${randomUUID().slice(0, 8)}@rows.test`, name: null });
    const off = (await createOrg(api, asUser(owner2), 'Công ty tắt tài chính')).orgId;
    const f = await statement('imported', 200, off, owner2);
    const setApps = async (apps: string[]) => {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL session_replication_role = replica');
        await client.query('UPDATE ludy_kernel.tenant SET apps_off = $2::text[] WHERE org_id = $1', [off, apps]);
        await client.query('COMMIT');
      } finally {
        await client.end();
      }
    };
    await setApps(['finance']);
    expect((await run()).result).toMatchObject({ statements: 0, failed: 0 });
    expect(await versionsOf(f)).toHaveLength(2);
    await setApps([]);
    expect((await run()).result).toMatchObject({ statements: 1, versions: 1, failed: 0 });
    expect(await versionsOf(f)).toHaveLength(1);
  });

  it('is run by the system alone: a member cannot purge, even a due statement', async () => {
    const f = await statement('imported', 200);
    await expect(api.execute('finance.bank.statement_rows_purge', { fileId: f }, { actor: asUser(ownerId), orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(api.execute('finance.bank.statement_rows_purge', { fileId: f }, { actor: asUser(memberId), orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
    expect(await versionsOf(f)).toHaveLength(2);
    await run();
    expect(await versionsOf(f)).toHaveLength(1);
  });

  it('walks every batch, and a failing file neither stops the others nor leaks anything in the log', async () => {
    const files = [await statement('imported', 200), await statement('rejected', 200), await statement('imported', 200), await statement('imported', 200)];
    const bad = files[0] as string;
    const failing = {
      execute: (name: string, input: { fileId: string }, options: Parameters<Runtime['execute']>[2]) => (input.fileId === bad ? Promise.reject(new Error(`boom ${COUNTERPARTY}`)) : worker.execute(name, input, options)),
    } as unknown as Runtime;
    // Batches of one: the failing file is listed first (the oldest it ties for), and the next batches ask for one more each time, past it.
    const out = await run({ batch: 1, runtime: failing });
    expect(out.result).toMatchObject({ statements: 3, versions: 3, failed: 1, skipped: 0 });
    expect(await versionsOf(bad)).toHaveLength(2);
    for (const f of files.slice(1)) expect(await versionsOf(f)).toHaveLength(1);
    // The log names the file by an id prefix and the error by its name, never by its message.
    const logged = out.lines.join('\n');
    expect(logged).toContain(`file ${bad.slice(0, 8)}`);
    expect(logged).not.toContain(COUNTERPARTY);
    // The next run, with nothing failing, finishes the job.
    expect((await run()).result).toMatchObject({ statements: 1, versions: 1, failed: 0 });
    expect(await versionsOf(bad)).toHaveLength(1);
  });
});
