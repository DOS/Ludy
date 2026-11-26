// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (#5035, #5127): privilege, search_path, and owner-only runtime refusal guarantees for
// ludy_notes.private_pending_attachment_count() and ludy_notes.private_failed_attachment_count().
// Ensures:
//   - Both helpers are STABLE SECURITY DEFINER with pinned search_path = pg_catalog, pg_temp and return bigint scalar counts only.
//   - EXECUTE is granted ONLY to ludy_tenant (never PUBLIC, anon, authenticated, service_role, or non-tenant roles).
//   - Unauthenticated, system, org-agent, Member Vy, admin, author, member, viewer, entity-limited member, and cross-org
//     calls all fail with SQLSTATE 42501; only the org owner reads exact org-scoped private pending/failed counts with zero
//     disclosure of private attachment filenames, note IDs, or authors.
// Part of the invariant suite: self-contained under apps/kernel/test/invariant/ (imports only packages under test and
// local ./fixtures/*). Set LUDY_TEST_ADMIN_URL or CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import {
  FAILED_NOTE_ATTACHMENT_REASON,
  FAILED_PRIVATE_NOTE_ATTACHMENT_REASON,
  PENDING_NOTE_ATTACHMENT_REASON,
  PENDING_PRIVATE_NOTE_ATTACHMENT_REASON,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import type { PersonalDataErasure, PersonalDataResult } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { aiRunFeature } from './fixtures/ai-run-feature.ts';
import { enterUser } from './fixtures/context-token.ts';
import {
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const SEARCH_PATH = 'search_path=pg_catalog, pg_temp';
const HELPERS = [
  'crove_notes.private_pending_attachment_count()',
  'crove_notes.private_failed_attachment_count()',
] as const;
const canonical = (role: string): string => role.replace(/^(crove|ludy)_/, 'crove_');
const suite = ADMIN ? describe : describe.skip;

interface Actor {
  name: string;
  url: () => string;
  enter: (c: pg.Client) => Promise<unknown>;
}

suite('ludy_notes private attachment count definers (#5035, #5127)', () => {
  const dbName = `ludy_inv_priv_att_cnt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds!: DbIdentifiers;
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let appRt!: Runtime;
  let orgId = '';
  let otherOrgId = '';
  const users = {
    owner: '',
    admin: '',
    author: '',
    member: '',
    viewer: '',
    limited: '',
    otherOwner: '',
    otherAdmin: '',
  };
  let privNoteId = '';
  let otherPrivNoteId = '';
  const privPendingAttIds: string[] = [];
  let otherPrivPendingAttId = '';
  let agent = { agentId: '', runId: '' };
  let vyAgent = { agentId: '', runId: '' };

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds, { canonicalizeCatalog: false });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: url }, dbIds, { canonicalizeCatalog: false });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  }

  const run = <T>(actor: Actor, fn: (c: pg.Client) => Promise<T>) => inContext(actor.url(), actor.enter, fn);
  const outcome = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }),
    );

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds.roleName(username);
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');

    const runtimeFor = (url: string) => {
      // Runtime executes schema-aware queries returning column keys such as ludy_notes.attachment.filename; keep
      // catalog strings unrewritten on returned rows so pg_catalog queries inside SQL do not rename col_key.
      const pool = createDbPool({ connectionString: url, max: 4 }, dbIds, { canonicalizeCatalog: false });
      pools.push(pool);
      const db = createDb(pool);
      return {
        db,
        runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({
          commands: [...kernelCommands, ...financeCommands],
          queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
        }),
      };
    };

    const api = runtimeFor(appUrl);
    appRt = api.runtime;
    const worker = runtimeFor(workerUrl).runtime;
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, {
        issuer: 'notes-priv-att-counts',
        subject: key,
        email: `${key}-${randomUUID().slice(0, 8)}@inv.test`,
        name: null,
      });
    }
    orgId = (await createOrg(api.runtime, asUser(users.owner), 'Cong ty Dinh Kem Rieng')).orgId;
    otherOrgId = (await createOrg(api.runtime, asUser(users.otherOwner), 'Cong ty Khac Dinh Kem')).orgId;

    privNoteId = randomUUID();
    const sharedNoteId = randomUUID();
    otherPrivNoteId = randomUUID();
    await admin(async (c) => {
      const branch = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhanh', 'branch', $2) RETURNING id`,
          [orgId, users.owner],
        )
      ).rows[0]!.id;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer'), ($1, $6, 'member'),
                ($7, $8, 'admin')`,
        [orgId, users.admin, users.author, users.member, users.viewer, users.limited, otherOrgId, users.otherAdmin],
      );
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [orgId, users.limited, branch, users.owner],
      );

      await c.query(
        `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body)
         VALUES ($1, $2, $5, 'private', 'Ghi chu rieng', ''),
                ($1, $3, $5, 'org', 'Ghi chu chung', ''),
                ($4, $6, $7, 'private', 'Ghi chu rieng org khac', '')`,
        [orgId, privNoteId, sharedNoteId, otherOrgId, users.author, otherPrivNoteId, users.otherOwner],
      );

      const insertAtt = async (
        targetOrgId: string,
        noteId: string,
        authorId: string,
        status: 'pending' | 'failed' | 'done' | 'skipped',
        filename: string,
      ) => {
        const id = randomUUID();
        await c.query(
          `INSERT INTO crove_notes.attachment (org_id, id, note_id, author_user_id, filename, content_type, size_bytes, sha256, storage_key, extract_status)
           VALUES ($1, $2, $3, $4, $5, 'application/pdf', 128, $6, $7, $8)`,
          [targetOrgId, id, noteId, authorId, filename, 'a'.repeat(64), `notes/${targetOrgId}/${id}`, status],
        );
        return id;
      };
      // orgId private note: 2 pending, 1 failed, 1 done, 1 skipped
      privPendingAttIds.push(await insertAtt(orgId, privNoteId, users.author, 'pending', 'mat-pending-1.pdf'));
      privPendingAttIds.push(await insertAtt(orgId, privNoteId, users.author, 'pending', 'mat-pending-2.pdf'));
      await insertAtt(orgId, privNoteId, users.author, 'failed', 'mat-failed-1.pdf');
      await insertAtt(orgId, privNoteId, users.author, 'done', 'mat-done-1.pdf');
      await insertAtt(orgId, privNoteId, users.author, 'skipped', 'mat-skipped-1.png');
      // orgId shared note: 1 pending, 1 failed (must NOT be counted by private_*_attachment_count)
      await insertAtt(orgId, sharedNoteId, users.author, 'pending', 'chung-pending-1.pdf');
      await insertAtt(orgId, sharedNoteId, users.author, 'failed', 'chung-failed-1.pdf');
      // otherOrgId private note: 1 pending, 1 failed, 0 shared (must remain isolated to otherOrgId)
      otherPrivPendingAttId = await insertAtt(otherOrgId, otherPrivNoteId, users.otherOwner, 'pending', 'org2-pending.pdf');
      await insertAtt(otherOrgId, otherPrivNoteId, users.otherOwner, 'failed', 'org2-failed.pdf');
    });

    const installed = await api.runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );
    await api.runtime.execute('kernel.task.create', { title: 'Viec thu', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: SYSTEM, orgId });
    agent = { agentId: installed.agentId, runId: started.runId! };

    const vyAgentId = randomUUID();
    const vyRunId = randomUUID();
    await admin(async (c) => {
      const feat = await aiRunFeature(c);
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by)
         VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
        [orgId, vyAgentId, users.author],
      );
      await c.query(
        `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, started_at, expires_at${feat.cols})
         VALUES ($1, $2, $3, 'notes', 'running', now(), now() + interval '2 hours'${feat.vals})`,
        [orgId, vyRunId, vyAgentId],
      );
      await c.query('COMMIT');
    });
    vyAgent = { agentId: vyAgentId, runId: vyRunId };
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('pins STABLE SECURITY DEFINER, search_path, scalar bigint return, and ludy_tenant-only EXECUTE grants', async () => {
    await admin(async (c) => {
      const tenantRole = dbIds.role('tenant');
      for (const signature of HELPERS) {
        const activeSig = dbIds.rewriteSql(signature);
        const proc = await c.query<{
          secdef: boolean;
          volatile: string;
          nargs: number;
          retset: boolean;
          rettype: string;
          config: string[] | null;
        }>(
          `SELECT p.prosecdef AS secdef,
                  p.provolatile::text AS volatile,
                  p.pronargs::int AS nargs,
                  p.proretset AS retset,
                  pg_catalog.format_type(p.prorettype, null) AS rettype,
                  p.proconfig AS config
             FROM pg_catalog.pg_proc p
            WHERE p.oid = pg_catalog.to_regprocedure($1::text)::oid`,
          [activeSig],
        );
        expect(proc.rows, `${signature} exists`).toHaveLength(1);
        expect(proc.rows[0]).toMatchObject({
          secdef: true,
          volatile: 's',
          nargs: 0,
          retset: false,
          rettype: 'bigint',
        });
        expect(proc.rows[0]?.config ?? [], `${signature} search_path`).toEqual([SEARCH_PATH]);

        // Direct ACL grantees: only ludy_tenant (never PUBLIC, anon, authenticated, service_role, or other roles).
        const acl = await c.query<{ grantee: string; grantable: boolean }>(
          `SELECT COALESCE(r.rolname, 'PUBLIC') AS grantee, a.is_grantable AS grantable
             FROM pg_catalog.pg_proc p
             CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
             LEFT JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
            WHERE p.oid = pg_catalog.to_regprocedure($1::text)::oid
              AND a.privilege_type = 'EXECUTE'
              AND a.grantee <> p.proowner
            ORDER BY 1`,
          [activeSig],
        );
        expect(acl.rows.map((r) => [canonical(r.grantee), r.grantable]), signature).toEqual([['crove_tenant', false]]);

        // Public and every non-superuser role outside ludy_tenant membership cannot execute the helper.
        const publicExec = await c.query<{ ok: boolean }>(
          `SELECT pg_catalog.has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS ok`,
          [activeSig],
        );
        expect(publicExec.rows[0]?.ok, `${signature} PUBLIC execute`).toBe(false);

        const nonTenantExec = await c.query<{ rolname: string }>(
          `SELECT r.rolname
             FROM pg_catalog.pg_roles r
            WHERE NOT r.rolsuper
              AND r.rolname !~ '^pg_'
              AND NOT pg_catalog.pg_has_role(r.oid, $2::name, 'MEMBER')
              AND pg_catalog.has_function_privilege(r.oid, $1::regprocedure, 'EXECUTE')`,
          [activeSig, tenantRole],
        );
        expect(nonTenantExec.rows, `${signature} unexpected non-tenant EXECUTE`).toEqual([]);
      }
    });
  });

  it('refuses unauthenticated, system, agent, Member Vy, and non-owner calls with 42501 and returns scalar counts to owner alone', async () => {
    const userActor = (name: string, targetOrg: string, userId: string): Actor => ({
      name,
      url: () => appUrl,
      enter: (c) => enterUser(c, userId, targetOrg),
    });
    const noCtxApp: Actor = { name: 'app without context', url: () => appUrl, enter: async () => undefined };
    const noCtxWorker: Actor = { name: 'worker without context', url: () => workerUrl, enter: async () => undefined };
    const systemActor: Actor = {
      name: 'system context',
      url: () => workerUrl,
      enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]),
    };
    const orgAgentActor: Actor = {
      name: 'agent context',
      url: () => workerUrl,
      enter: (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]),
    };
    const vyActor: Actor = {
      name: 'Member Vy context',
      url: () => workerUrl,
      enter: (c) => c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, vyAgent.agentId, vyAgent.runId]),
    };

    const validRefusedActors: Actor[] = [
      noCtxApp,
      noCtxWorker,
      systemActor,
      orgAgentActor,
      vyActor,
      userActor('admin', orgId, users.admin),
      userActor('note author (member)', orgId, users.author),
      userActor('another member', orgId, users.member),
      userActor('viewer', orgId, users.viewer),
      userActor('entity-limited member', orgId, users.limited),
    ];

    // Establish each valid context first (must succeed), then assert the helper SELECT itself raises 42501 NOTES_FORBIDDEN.
    for (const signature of HELPERS) {
      const fnCall = dbIds.rewriteSql(`SELECT ${signature}::text AS n`);
      for (const actor of validRefusedActors) {
        const res = await run(actor, (c) => outcome(c.query(fnCall)));
        expect(res, `${actor.name} -> ${signature}`).toMatchObject({
          ok: false,
          code: '42501',
          message: 'NOTES_FORBIDDEN',
        });
      }
    }

    // Cross-org entry itself is also refused with 42501 before any helper call can run.
    expect(
      await outcome(run(userActor('other org owner claiming orgId', orgId, users.otherOwner), async () => undefined)),
      'cross-org enterUser refused',
    ).toMatchObject({ ok: false, code: '42501' });

    const ownerActor = userActor('org owner', orgId, users.owner);
    const otherOwnerActor = userActor('other org owner', otherOrgId, users.otherOwner);

    const ownerPending = await run(ownerActor, (c) =>
      c.query<{ n: string }>(dbIds.rewriteSql('SELECT crove_notes.private_pending_attachment_count()::text AS n')),
    );
    expect(ownerPending.fields.map((f) => f.name)).toEqual(['n']);
    expect(ownerPending.rows).toEqual([{ n: '2' }]);

    const ownerFailed = await run(ownerActor, (c) =>
      c.query<{ n: string }>(dbIds.rewriteSql('SELECT crove_notes.private_failed_attachment_count()::text AS n')),
    );
    expect(ownerFailed.fields.map((f) => f.name)).toEqual(['n']);
    expect(ownerFailed.rows).toEqual([{ n: '1' }]);

    // Cross-org isolation: otherOwner only sees otherOrgId's counts (1 pending, 1 failed).
    const otherPending = await run(otherOwnerActor, (c) =>
      c.query<{ n: string }>(dbIds.rewriteSql('SELECT crove_notes.private_pending_attachment_count()::text AS n')),
    );
    const otherFailed = await run(otherOwnerActor, (c) =>
      c.query<{ n: string }>(dbIds.rewriteSql('SELECT crove_notes.private_failed_attachment_count()::text AS n')),
    );
    expect(otherPending.rows).toEqual([{ n: '1' }]);
    expect(otherFailed.rows).toEqual([{ n: '1' }]);

    // Underlying attachment RLS stays strict: owner still reads zero private attachments directly.
    const ownerVisibleAttachments = await run(ownerActor, (c) =>
      c.query<{ filename: string }>(dbIds.rewriteSql('SELECT filename FROM crove_notes.attachment ORDER BY filename')),
    );
    expect(ownerVisibleAttachments.rows.map((r) => r.filename)).toEqual(['chung-failed-1.pdf', 'chung-pending-1.pdf']);
  });

  it('enforces command-level privacy on kernel.personal_data.find and audit_event (zero private oracle for admins or metadata leaks)', async () => {
    const probe = 'inv-privacy-find@example.test';
    const sharedMatchNoteId = randomUUID();
    const ownerPrivNoteId = randomUUID();
    const sharedMatchAttId = randomUUID();
    const ownerPrivMatchAttId = randomUUID();

    // Plant same email in a shared done attachment authored by users.member (not users.author, who owns the private
    // pending/failed rows) and in an owner-owned private done attachment: only the shared row may appear in matches.
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body)
         VALUES ($1, $2, $3, 'org', 'Ghi chu chung match', ''),
                ($1, $4, $5, 'private', 'Ghi chu rieng owner', '')`,
        [orgId, sharedMatchNoteId, users.member, ownerPrivNoteId, users.owner],
      );
      await c.query(
        `INSERT INTO crove_notes.attachment (org_id, id, note_id, author_user_id, filename, content_type, size_bytes, sha256, storage_key, extract_status)
         VALUES ($1, $2, $3, $4, $5, 'application/pdf', 128, $6, $7, 'done'),
                ($1, $8, $9, $10, $11, 'application/pdf', 128, $6, $12, 'done')`,
        [
          orgId,
          sharedMatchAttId,
          sharedMatchNoteId,
          users.member,
          `${probe} chung.pdf`,
          'c'.repeat(64),
          `notes/${orgId}/${sharedMatchAttId}`,
          ownerPrivMatchAttId,
          ownerPrivNoteId,
          users.owner,
          `${probe} owner-rieng.pdf`,
          `notes/${orgId}/${ownerPrivMatchAttId}`,
        ],
      );
    });

    // In otherOrgId (0 shared pending, 1 private pending): owner sees { shared: 0, private: 1 }, admin sees undefined (no existence oracle).
    const otherOwnerFind = await appRt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: probe },
      { actor: asUser(users.otherOwner), orgId: otherOrgId },
    );
    const otherAdminFind = await appRt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: probe },
      { actor: asUser(users.otherAdmin), orgId: otherOrgId },
    );
    expect(otherOwnerFind.pendingNoteAttachments).toEqual({ shared: 0, private: 1 });
    expect(otherAdminFind.pendingNoteAttachments).toBeUndefined();
    const otherOwnerJson = JSON.stringify(otherOwnerFind);
    expect(otherOwnerJson).not.toContain('org2-pending');
    expect(otherOwnerJson).not.toContain(otherPrivNoteId);
    expect(otherOwnerJson).not.toContain(otherPrivPendingAttId);

    // In orgId (1 shared pending, 2 private pending): owner sees { shared: 1, private: 2 }, admin sees { shared: 1, private: null }.
    const ownerFind = await appRt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: probe },
      { actor: asUser(users.owner), orgId },
    );
    const adminFind = await appRt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: probe },
      { actor: asUser(users.admin), orgId },
    );
    expect(ownerFind.pendingNoteAttachments).toEqual({ shared: 1, private: 2 });
    expect(adminFind.pendingNoteAttachments).toEqual({ shared: 1, private: null });
    for (const found of [ownerFind, adminFind]) {
      expect(found.matches).toHaveLength(1);
      expect(found.matches[0]).toMatchObject({
        column: 'ludy_notes.attachment.filename',
        rowId: sharedMatchAttId,
      });
    }
    expect(ownerFind.privateItems).toEqual([{ authorUserId: users.owner, notes: 1, todos: 0 }]);
    expect(adminFind.privateItems).toBeNull();
    for (const json of [JSON.stringify(ownerFind), JSON.stringify(adminFind)]) {
      expect(json).not.toContain('mat-pending');
      expect(json).not.toContain('mat-failed');
      expect(json).not.toContain('owner-rieng');
      expect(json).not.toContain(privNoteId);
      expect(json).not.toContain(ownerPrivNoteId);
      expect(json).not.toContain(ownerPrivMatchAttId);
      for (const attId of privPendingAttIds) expect(json).not.toContain(attId);
      expect(json).not.toContain(users.author);
    }

    // Non-admins (member, viewer) are refused 403 on kernel.personal_data.find.
    for (const userId of [users.author, users.member, users.viewer]) {
      await expect(
        appRt.execute('kernel.personal_data.find', { value: probe }, { actor: asUser(userId), orgId }),
      ).rejects.toMatchObject({ status: 403 });
    }

    // Audit rows written by kernel.personal_data.find never disclose private pending attachment counts or existence to admins.
    const auditRows = await admin(async (c) =>
      (
        await c.query<{ org_id: string; detail: Record<string, unknown> }>(
          `SELECT org_id, detail
             FROM crove_kernel.audit_event
            WHERE org_id = ANY($1::uuid[])
              AND command = 'kernel.personal_data.find'
              AND outcome = 'ok'`,
          [[orgId, otherOrgId]],
        )
      ).rows,
    );
    expect(auditRows).toHaveLength(4);
    for (const row of auditRows) {
      expect(row.detail).not.toHaveProperty('pending_note_attachments');
      if (row.org_id === otherOrgId) {
        expect(row.detail).not.toHaveProperty('pending_shared_note_attachments');
      } else {
        expect(row.detail).toMatchObject({ pending_shared_note_attachments: 1 });
      }
    }
  });

  it('enforces command-level privacy on kernel.personal_data.erase and audit_event (zero private attachment leak to admins)', async () => {
    const probe = 'inv-privacy-erase@example.test';

    // 1. Mixed org (1 shared pending, 1 shared failed, 2 private pending, 1 private failed): owner sees kept[] entries
    //    without private metadata, while audit_event.detail.kept records only shared count (= 2) and never ludy_notes.attachment.
    const mixedErase = await appRt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: probe },
      { actor: asMfa(users.owner), orgId, idempotencyKey: randomUUID() },
    );
    expect(mixedErase.kept).toEqual(
      expect.arrayContaining([
        { column: 'ludy_notes.attachment.extracted_text', rows: 1, reason: PENDING_NOTE_ATTACHMENT_REASON },
        { column: 'ludy_notes.attachment.extracted_text', rows: 1, reason: FAILED_NOTE_ATTACHMENT_REASON },
        { column: 'ludy_notes.attachment', rows: 2, reason: PENDING_PRIVATE_NOTE_ATTACHMENT_REASON },
        { column: 'ludy_notes.attachment', rows: 1, reason: FAILED_PRIVATE_NOTE_ATTACHMENT_REASON },
      ]),
    );
    const mixedJson = JSON.stringify(mixedErase);
    expect(mixedJson).not.toContain('mat-pending');
    expect(mixedJson).not.toContain('mat-failed');
    expect(mixedJson).not.toContain(privNoteId);
    for (const attId of privPendingAttIds) expect(mixedJson).not.toContain(attId);
    expect(mixedJson).not.toContain(users.author);

    const [mixedAudit] = await admin(async (c) =>
      (
        await c.query<{ detail: { kept?: Record<string, number> } }>(
          `SELECT detail
             FROM crove_kernel.audit_event
            WHERE org_id = $1
              AND command = 'kernel.personal_data.erase'
              AND outcome = 'ok'
            ORDER BY id DESC
            LIMIT 1`,
          [orgId],
        )
      ).rows,
    );
    expect(mixedAudit?.detail.kept?.['ludy_notes.attachment.extracted_text']).toBe(2);
    expect(mixedAudit?.detail.kept).not.toHaveProperty('ludy_notes.attachment');

    // 2. Org with ONLY a private failed attachment (0 shared, 0 pending): owner sees kept[], audit_event omits ludy_notes.attachment.
    const failedOnlyOrgId = (await createOrg(appRt, asUser(users.otherOwner), 'Cong ty Chi Co Tep Loi')).orgId;
    const failedOnlyNoteId = randomUUID();
    const failedOnlyAttId = randomUUID();
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body)
         VALUES ($1, $2, $3, 'private', 'Ghi chu rieng loi', '')`,
        [failedOnlyOrgId, failedOnlyNoteId, users.otherOwner],
      );
      await c.query(
        `INSERT INTO crove_notes.attachment (org_id, id, note_id, author_user_id, filename, content_type, size_bytes, sha256, storage_key, extract_status)
         VALUES ($1, $2, $3, $4, 'inv-only-fail.pdf', 'application/pdf', 128, $5, $6, 'failed')`,
        [failedOnlyOrgId, failedOnlyAttId, failedOnlyNoteId, users.otherOwner, 'b'.repeat(64), `notes/${failedOnlyOrgId}/${failedOnlyAttId}`],
      );
    });
    const failedOnlyErase = await appRt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: probe },
      { actor: asMfa(users.otherOwner), orgId: failedOnlyOrgId, idempotencyKey: randomUUID() },
    );
    expect(failedOnlyErase.kept).toEqual([
      { column: 'ludy_notes.attachment', rows: 1, reason: FAILED_PRIVATE_NOTE_ATTACHMENT_REASON },
    ]);
    const failedOnlyJson = JSON.stringify(failedOnlyErase);
    expect(failedOnlyJson).not.toContain('inv-only-fail');
    expect(failedOnlyJson).not.toContain(failedOnlyNoteId);
    expect(failedOnlyJson).not.toContain(failedOnlyAttId);
    expect(failedOnlyJson).not.toContain(users.otherOwner);

    const [failedOnlyAudit] = await admin(async (c) =>
      (
        await c.query<{ detail: { kept?: Record<string, number> } }>(
          `SELECT detail
             FROM crove_kernel.audit_event
            WHERE org_id = $1
              AND command = 'kernel.personal_data.erase'
              AND outcome = 'ok'
            ORDER BY id DESC
            LIMIT 1`,
          [failedOnlyOrgId],
        )
      ).rows,
    );
    expect(failedOnlyAudit?.detail.kept).not.toHaveProperty('ludy_notes.attachment');
    expect(failedOnlyAudit?.detail.kept).not.toHaveProperty('ludy_notes.attachment.extracted_text');
  });
});
