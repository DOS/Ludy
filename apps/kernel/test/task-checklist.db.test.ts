// SPDX-License-Identifier: AGPL-3.0-only
// Task checklist product-flow PostgreSQL 17 integration tests (#2606):
// 1) task_checklist_valid / task_checklist_shape constraint checks (including missing keys).
// 2) kernel.task.create/update/get/list, projects.task.create/projects.board, notes.my_work,
//    audit PII markers (never leaking raw text), taint preservation, TASK_CHECKED_OUT lock, and org export.
// 3) PDPL find + erase + short-number guard on ludy_kernel.task.checklist.
// Security tests (AGENT_TASK_FIELD, task_before_insert, cross-org RLS, viewer, le_scope) live in test/invariant/task-checklist.db.test.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  ACTIVITY_SHORT_NUMBER_REASON,
  REDACTED_MARK,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import {
  zTask,
  zTaskDetail,
  type MyWork,
  type PersonalDataErasure,
  type PersonalDataResult,
  type ProjectBoard,
} from '@ludy/kernel-contract';
import { Runtime, sha256Hex, type AgentActor, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { ExportSealer, exportAad } from '../src/export-seal.ts';
import { runOrgExport } from '../src/org-export.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
type Task = z.infer<typeof zTask>;
type TaskDetail = z.infer<typeof zTaskDetail>;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ISSUER = 'crove-auth';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const DAY = 24 * 60 * 60 * 1000;
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array) {
    this.blobs.set(key, body);
    return `content:${sha256Hex(body)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error(`missing blob ${key}`);
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

suite('projects (#2606): task checklist flows on PostgreSQL 17', () => {
  const dbName = `crove_test_checklist_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let appRt: Runtime;
  let workerRt: Runtime;
  const store = new MemoryStore();
  const exportKeyBytes = randomBytes(32);
  const sealer = new ExportSealer(exportKeyBytes);

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const newPerson = async (tag: string) => {
    const email = `${tag}-${randomUUID().slice(0, 8)}@checklist.test`;
    const userId = await upsertIdentity(db, { issuer: ISSUER, subject: randomUUID(), email, name: `User ${tag}` });
    return { userId, email };
  };

  const exec = <T>(userId: string, orgId: string, command: string, input: unknown) =>
    appRt.execute<T>(command, input, { actor: asUser(userId), orgId, idempotencyKey: randomUUID() });

  const query = <T>(userId: string, orgId: string, name: string, input: unknown = {}) =>
    appRt.query<T>(name, input, { actor: asUser(userId), orgId });

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

    const uApp = new URL(adminUrl);
    uApp.username = 'ludy_app';
    uApp.password = 'test-app-pw';

    const uWorker = new URL(adminUrl);
    uWorker.username = 'ludy_worker';
    uWorker.password = 'test-worker-pw';

    const appPool = createPool({ connectionString: uApp.toString(), max: 4 });
    const workerPool = createPool({ connectionString: uWorker.toString(), max: 4 });
    pools.push(appPool, workerPool);
    db = createDb(appPool);

    const opts = {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required' as const,
      entitlements: async () => ['full'],
    };
    const commands = [...kernelCommands, ...financeCommands, ...projectsCommands, ...notesCommands];
    const queries = [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...projectsQueries, ...notesQueries];
    appRt = new Runtime(db, opts).register({ commands, queries });
    workerRt = new Runtime(createDb(workerPool), opts).register({ commands, queries });
  }, 600_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('enforces task_checklist_shape check constraint in SQL and full CRUD across kernel, projects, notes and export', async () => {
    const owner = await newPerson('owner');
    const org = await createOrg(appRt, asUser(owner.userId), 'Checklist Co');

    // Direct SQL check constraint validation via ludy_kernel.task_checklist_valid (including missing keys & Unicode whitespace)
    const invalidJsonPayloads = [
      'null',
      '{}',
      '[{}]',
      JSON.stringify([{ text: '   ', done: false }]),
      JSON.stringify([{ text: '\t', done: false }]),
      JSON.stringify([{ text: '\n\r\v\f', done: false }]),
      JSON.stringify([{ text: '\u00A0', done: false }]),
      JSON.stringify([{ text: '\u1680\u2000\u2003\u200A', done: false }]),
      JSON.stringify([{ text: '\u2028\u2029\u202F\u205F\u3000\uFEFF', done: false }]),
      JSON.stringify([{ text: '\t\u00A0\u2003\u3000\uFEFF', done: false }]),
      JSON.stringify([{ text: 'a'.repeat(301), done: false }]),
      JSON.stringify([{ text: 'thiếu done' }]),
      JSON.stringify([{ done: false }]),
      JSON.stringify([{ text: 'sai kiểu done', done: 'yes' }]),
      JSON.stringify([{ text: 'khóa dư', done: false, extra: 1 }]),
      JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ text: `Bước ${i + 1}`, done: false }))),
    ];
    for (const bad of invalidJsonPayloads) {
      await expect(
        withAdmin((c) =>
          c.query(
            `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, checklist)
             VALUES ($1, 'Bad', 'human', 'user', $2::jsonb)`,
            [org.orgId, bad],
          ),
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }

    // Verify SQL function security/volatility/search_path/ACL parity and validated task_revision_positive constraint
    const fnParity = await withAdmin(async (c) => {
      const fn = await c.query<{
        prosecdef: boolean;
        provolatile: string;
        proconfig: string[] | null;
        direct_grantees: string[] | null;
        tenant_exec: boolean;
        public_exec: boolean;
        prober_exec: boolean;
        reporter_exec: boolean;
        auth_reader_exec: boolean;
      }>(
        `SELECT p.prosecdef, p.provolatile::text, p.proconfig,
                (SELECT pg_catalog.array_agg(gr.rolname::text ORDER BY gr.rolname)
                   FROM pg_catalog.aclexplode(p.proacl) a
                   JOIN pg_catalog.pg_roles gr ON gr.oid = a.grantee
                  WHERE a.grantee <> p.proowner) AS direct_grantees,
                has_function_privilege('ludy_tenant', p.oid, 'EXECUTE') AS tenant_exec,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                has_function_privilege('ludy_prober', p.oid, 'EXECUTE') AS prober_exec,
                has_function_privilege('ludy_reporter', p.oid, 'EXECUTE') AS reporter_exec,
                has_function_privilege('ludy_auth_reader', p.oid, 'EXECUTE') AS auth_reader_exec
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'ludy_kernel' AND p.proname = 'task_checklist_valid'`,
      );
      const con = await c.query<{ convalidated: boolean }>(
        `SELECT c.convalidated
           FROM pg_catalog.pg_constraint c
           JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'ludy_kernel' AND t.relname = 'task' AND c.conname = 'task_revision_positive'`,
      );
      return { fn: fn.rows[0], con: con.rows[0] };
    });
    expect(fnParity.fn).toMatchObject({
      prosecdef: false,
      provolatile: 'i',
      proconfig: ['search_path=pg_catalog, pg_temp'],
      direct_grantees: ['ludy_tenant'],
      tenant_exec: true,
      public_exec: false,
      prober_exec: false,
      reporter_exec: false,
      auth_reader_exec: false,
    });
    expect(fnParity.con?.convalidated).toBe(true);

    // Leading/trailing Unicode whitespace around real text passes SQL CHECK and is trimmed by Zod on command write
    const sqlTrimCheck = await withAdmin((c) =>
      c.query<{ ok: boolean }>(`SELECT ludy_kernel.task_checklist_valid($1::jsonb) AS ok`, [
        JSON.stringify([{ text: '\u00A0Bước hợp lệ\t', done: false }]),
      ]),
    );
    expect(sqlTrimCheck.rows[0]?.ok).toBe(true);

    // Create task with checklist via projects.task.create
    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Kỳ khai thuế quý 4',
    });
    const createdProjTask = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Tổng hợp chứng từ đầu vào',
      assigneePositionId: null,
      checklist: [
        { text: '  Thu thập hóa đơn XML  ', done: false },
        { text: 'Đối chiếu bảng kê ngân hàng', done: true },
      ],
    });

    const board = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    const card = board.tasks.find((t) => t.id === createdProjTask.taskId);
    expect(card?.checklist).toEqual([
      { text: 'Thu thập hóa đơn XML', done: false },
      { text: 'Đối chiếu bảng kê ngân hàng', done: true },
    ]);

    const work = await query<MyWork>(owner.userId, org.orgId, 'notes.my_work', { timeZone: 'Asia/Ho_Chi_Minh' });
    expect(work.tasks.find((t) => t.id === createdProjTask.taskId)?.steps).toEqual({ done: 1, total: 2 });

    // Create + update via kernel.task.* commands, preserving tainted flag and redacting audit facts
    const { taskId: kernelTaskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Rà soát hợp đồng đối tác',
      assigneePositionId: null,
      checklist: [{ text: 'Kiểm tra mã số thuế', done: false }],
    });
    await withAdmin((c) => c.query(`UPDATE ludy_kernel.task SET tainted = true WHERE org_id = $1 AND id = $2`, [org.orgId, kernelTaskId]));

    await exec<{ taskId: string }>(owner.userId, org.orgId, 'kernel.task.update', {
      id: kernelTaskId,
      checklist: [
        { text: 'Kiểm tra mã số thuế', done: true },
        { text: 'Lưu bản scan có dấu', done: false },
      ],
    });
    const detail = await query<TaskDetail>(owner.userId, org.orgId, 'kernel.task.get', { id: kernelTaskId });
    expect(detail.task.tainted).toBe(true);
    expect(detail.task.checklist).toEqual([
      { text: 'Kiểm tra mã số thuế', done: true },
      { text: 'Lưu bản scan có dấu', done: false },
    ]);

    const listed = await query<{ tasks: Task[] }>(owner.userId, org.orgId, 'kernel.task.list', {});
    expect(listed.tasks.find((t) => t.id === kernelTaskId)?.checklist).toEqual(detail.task.checklist);

    // Update title only: checklist stays untouched
    await exec(owner.userId, org.orgId, 'kernel.task.update', { id: kernelTaskId, title: 'Rà soát hợp đồng mới' });
    const afterTitleOnly = await query<TaskDetail>(owner.userId, org.orgId, 'kernel.task.get', { id: kernelTaskId });
    expect(afterTitleOnly.task.checklist).toEqual(detail.task.checklist);

    // Audit facts mark checklist as redacted pii, never storing raw text in audit_event
    const auditRows = await withAdmin((c) =>
      c.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.task.update' AND outcome = 'ok' ORDER BY id ASC`,
        [org.orgId],
      ),
    );
    expect(auditRows.rows[0]?.detail.changed).toEqual(['checklist']);
    expect(auditRows.rows[0]?.detail.checklist).toEqual({ redacted: 'pii' });
    const serializedAudit = JSON.stringify(auditRows.rows);
    expect(serializedAudit).not.toContain('Lưu bản scan có dấu');
    expect(serializedAudit).not.toContain('Kiểm tra mã số thuế');

    // Org export includes ludy_kernel.task rows with checklist intact
    const generatedAt = new Date(Date.now() - 35 * DAY);
    const exportRecord = await runOrgExport({ runtime: workerRt, store, sealer, retentionDays: 40 }, org.orgId, { now: () => generatedAt });
    const taskPart = exportRecord.parts.find((p) => p.table === 'kernel.task');
    expect(taskPart).toBeDefined();
    const rawPart = await store.get(taskPart!.key);
    const exportedTasks = new TextDecoder()
      .decode(sealer.open(rawPart, exportAad(org.orgId, taskPart!), 'aes-256-gcm'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const exportedKernelTask = exportedTasks.find((r) => r.id === kernelTaskId);
    expect(exportedKernelTask?.checklist).toEqual(detail.task.checklist);
  });

  it('blocks human checklist edits with TASK_CHECKED_OUT while an AI agent run holds the lease', async () => {
    const owner = await newPerson('lease-owner');
    const org = await createOrg(appRt, asUser(owner.userId), 'Checklist Lease Co');

    const installed = await appRt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán trưởng AI' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const { taskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Kiểm tra chứng từ khóa bởi tác tử',
      assigneePositionId: installed.positionId,
      checklist: [{ text: 'Bước ban đầu', done: false }],
    });

    const started = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: SYSTEM, orgId: org.orgId },
    );
    expect(started.runId).toBeTruthy();
    const actor: AgentActor = { type: 'agent', agentId: installed.agentId, runId: started.runId as string };

    await workerRt.execute('kernel.task.checkout', { id: taskId }, { actor, orgId: org.orgId, idempotencyKey: randomUUID() });
    const lockedDetail = await query<TaskDetail>(owner.userId, org.orgId, 'kernel.task.get', { id: taskId });
    expect(lockedDetail.task.checkedOut).toBe(true);

    await expect(
      exec(owner.userId, org.orgId, 'kernel.task.update', {
        id: taskId,
        checklist: [{ text: 'Sửa khi đang khóa', done: true }],
      }),
    ).rejects.toMatchObject({ code: 'TASK_CHECKED_OUT', status: 409 });
  });

  it('finds and erases PDPL PII inside task checklist steps while preserving step done flags and enforcing short-number guard', async () => {
    const owner = await newPerson('pdpl-owner');
    const org = await createOrg(appRt, asUser(owner.userId), 'PDPL Checklist Co');

    const { taskId: piiTaskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Liên hệ khách hàng ký biên bản',
      assigneePositionId: null,
      checklist: [
        { text: 'Gửi email tới alice@checklist.test trước 17h', done: true },
        { text: 'Gọi điện xác nhận 0901234567', done: false },
        { text: 'Lưu bản cứng vào tủ hồ sơ', done: true },
      ],
    });
    const { taskId: splitDigitsTaskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Mã tách qua hai bước',
      assigneePositionId: null,
      checklist: [
        { text: 'Kiểm tra mã 12345', done: false },
        { text: '67890 đối chiếu lại', done: false },
        { text: 'Số chứng từ ngắn 87654321 cần giữ', done: false },
      ],
    });

    // Cross-step digits ('12345' | '67890') must not falsely match '1234567890'
    const splitFind = await appRt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: '1234567890' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    expect(splitFind.matches.some((m) => m.column === 'ludy_kernel.task.checklist')).toBe(false);

    // Email match + redaction
    const emailFind = await appRt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: 'alice@checklist.test' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    expect(emailFind.matches.some((m) => m.column === 'ludy_kernel.task.checklist')).toBe(true);

    const emailErase = await appRt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: 'alice@checklist.test' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(emailErase.erased).toEqual(expect.arrayContaining([{ column: 'ludy_kernel.task.checklist', rows: 1 }]));

    // Phone (10 digits) match + redaction
    const phoneErase = await appRt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: '0901234567' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(phoneErase.erased).toEqual(expect.arrayContaining([{ column: 'ludy_kernel.task.checklist', rows: 1 }]));

    const afterErase = await query<TaskDetail>(owner.userId, org.orgId, 'kernel.task.get', { id: piiTaskId });
    expect(afterErase.task.checklist).toEqual([
      { text: `Gửi email tới ${REDACTED_MARK} trước 17h`, done: true },
      { text: `Gọi điện xác nhận ${REDACTED_MARK}`, done: false },
      { text: 'Lưu bản cứng vào tủ hồ sơ', done: true },
    ]);

    // Short 8-digit number stays untouched with ACTIVITY_SHORT_NUMBER_REASON
    const shortErase = await appRt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: '87654321' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(shortErase.kept).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: 'ludy_kernel.task.checklist', reason: ACTIVITY_SHORT_NUMBER_REASON }),
      ]),
    );
    const shortTaskAfter = await query<TaskDetail>(owner.userId, org.orgId, 'kernel.task.get', { id: splitDigitsTaskId });
    expect(shortTaskAfter.task.checklist[2]).toEqual({ text: 'Số chứng từ ngắn 87654321 cần giữ', done: false });
  });

  it('enforces backwards-compatible expectedRevision optimistic concurrency across concurrent checklist edits', async () => {
    const owner = await newPerson('rev-owner');
    const editorA = await newPerson('rev-editor-a');
    const editorB = await newPerson('rev-editor-b');
    const org = await createOrg(appRt, asUser(owner.userId), 'Checklist Revision Co');

    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
        [org.orgId, editorA.userId, editorB.userId],
      ),
    );

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án kiểm tra revision',
    });
    const { taskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Kiểm soát xung đột checklist',
      assigneePositionId: null,
      checklist: [
        { text: 'Bước 1', done: false },
        { text: 'Bước 2', done: false },
      ],
    });

    // Newly created task starts at revision 1 across get, list, and projects.board.
    const initialDetail = await query<TaskDetail>(editorA.userId, org.orgId, 'kernel.task.get', { id: taskId });
    expect(initialDetail.task.revision).toBe(1);
    const listed = await query<{ tasks: Task[] }>(editorA.userId, org.orgId, 'kernel.task.list', {});
    expect(listed.tasks.find((t) => t.id === taskId)?.revision).toBe(1);
    const board = await query<ProjectBoard>(editorA.userId, org.orgId, 'projects.board', { projectId });
    expect(board.tasks.find((t) => t.id === taskId)?.revision).toBe(1);

    // No-op update with matching expectedRevision preserves revision = 1.
    const noopRes = await exec<{ taskId: string; revision: number }>(editorA.userId, org.orgId, 'kernel.task.update', {
      id: taskId,
      expectedRevision: 1,
      checklist: [
        { text: 'Bước 1', done: false },
        { text: 'Bước 2', done: false },
      ],
    });
    expect(noopRes).toEqual({ taskId, revision: 1 });

    // Backwards-compatible edit omitting expectedRevision succeeds and increments revision to 2.
    const legacyRes = await exec<{ taskId: string; revision: number }>(editorA.userId, org.orgId, 'kernel.task.update', {
      id: taskId,
      checklist: [
        { text: 'Bước 1', done: true },
        { text: 'Bước 2', done: false },
      ],
    });
    expect(legacyRes).toEqual({ taskId, revision: 2 });

    // Stale expectedRevision (1) is rejected with 409 TASK_STALE_REVISION even if checklist matches or differs.
    await expect(
      exec(editorB.userId, org.orgId, 'kernel.task.update', {
        id: taskId,
        expectedRevision: 1,
        checklist: [
          { text: 'Bước 1', done: false },
          { text: 'Bước 2', done: true },
        ],
      }),
    ).rejects.toMatchObject({ code: 'TASK_STALE_REVISION', status: 409 });

    await expect(
      exec(editorB.userId, org.orgId, 'kernel.task.update', {
        id: taskId,
        expectedRevision: 1,
        checklist: [
          { text: 'Bước 1', done: true },
          { text: 'Bước 2', done: false },
        ],
      }),
    ).rejects.toMatchObject({ code: 'TASK_STALE_REVISION', status: 409 });

    // Concurrent race with same expectedRevision = 2: FOR UPDATE guarantees strictly one wins and one gets 409.
    const raceResults = await Promise.allSettled([
      exec<{ taskId: string; revision: number }>(editorA.userId, org.orgId, 'kernel.task.update', {
        id: taskId,
        expectedRevision: 2,
        checklist: [
          { text: 'Bước 1', done: true },
          { text: 'Bước 2', done: false },
          { text: 'Bước 3 từ A', done: false },
        ],
      }),
      exec<{ taskId: string; revision: number }>(editorB.userId, org.orgId, 'kernel.task.update', {
        id: taskId,
        expectedRevision: 2,
        checklist: [
          { text: 'Bước 1', done: true },
          { text: 'Bước 2', done: true },
        ],
      }),
    ]);
    const fulfilled = raceResults.filter((r): r is PromiseFulfilledResult<{ taskId: string; revision: number }> => r.status === 'fulfilled');
    const rejected = raceResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toEqual({ taskId, revision: 3 });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: 'TASK_STALE_REVISION', status: 409 });

    // Status change also bumps revision so stale checklist editors must reload first.
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', { id: taskId, status: 'in_progress' });
    await expect(
      exec(editorA.userId, org.orgId, 'kernel.task.update', {
        id: taskId,
        expectedRevision: 3,
        checklist: [{ text: 'Cũ', done: false }],
      }),
    ).rejects.toMatchObject({ code: 'TASK_STALE_REVISION', status: 409 });

    const current = await query<TaskDetail>(editorB.userId, org.orgId, 'kernel.task.get', { id: taskId });
    expect(current.task.revision).toBe(4);
    const retryRes = await exec<{ taskId: string; revision: number }>(editorB.userId, org.orgId, 'kernel.task.update', {
      id: taskId,
      expectedRevision: current.task.revision,
      checklist: [...current.task.checklist, { text: 'Bước sau khi tải lại', done: false }],
    });
    expect(retryRes).toEqual({ taskId, revision: 5 });
  });
});
