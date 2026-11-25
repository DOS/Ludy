// SPDX-License-Identifier: AGPL-3.0-only
// Product flow DB tests for Projects v2 Wave 1 private projects (#2604, ADR-0056 §1):
// 1) Self-lockout prevention on create / create_from_template + non-owner private creation guard (403).
// 2) Toggling org <-> private via projects.project.update (owner/admin/project-owner only; auto-membership on transition).
// 3) Blocking owner removal (PROJECT_OWNER_CANNOT_REMOVE 409) + set_owner auto-membership + dynamic access revocation + notification title omission.
// 4) projects.weekly_status.share_note on a private project creates a private note (author-only).
// 5) Module-off notes.record.panel isolation + org export and purgeOrg on private projects.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  Note,
  NoteRecordPanel,
  ProjectBoard,
  ProjectDetail,
  ProjectListResult,
} from '@ludy/kernel-contract';
import { contentGeneration, fileKey, Runtime, type BlobStore, type UserActor, sha256Hex } from '@ludy/kernel-runtime';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { signCommands, signQueries } from '@ludy/mod-sign';
import { ExportSealer } from '../src/export-seal.ts';
import { runOrgExport } from '../src/org-export.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const SYSTEM = { type: 'system' as const, component: 'kernel.worker' };
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
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

suite('projects v2 private project workflows on PostgreSQL (#2604)', () => {
  const dbName = `ludy_test_proj_flows_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let rtNoProjects: Runtime;
  let workerRt: Runtime;
  const store = new MemoryStore();
  const exportKeyBytes = randomBytes(32);
  const sealer = new ExportSealer(exportKeyBytes);

  const asUser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1', sessionId: randomUUID() });
  const asMfa = (userId: string): UserActor => ({
    type: 'user',
    userId,
    aal: 'aal2',
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  const newPerson = async (tag: string) => {
    const email = `${tag}-${randomUUID().slice(0, 8)}@proj-flows.test`;
    const userId = await upsertIdentity(db, { issuer: 'proj-flows', subject: email, email, name: tag });
    return { userId, email };
  };

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const exec = <T>(userId: string, orgId: string, command: string, input: unknown) =>
    rt.execute<T>(command, input, { actor: asUser(userId), orgId, idempotencyKey: randomUUID() });

  const query = <T>(userId: string, orgId: string, name: string, input: unknown = {}) =>
    rt.query<T>(name, input, { actor: asUser(userId), orgId });

  async function setupTeamOrg() {
    const owner = await newPerson('owner');
    const admin = await newPerson('admin');
    const creator = await newPerson('creator');
    const invited = await newPerson('invited');
    const bystander = await newPerson('bystander');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Tư Vấn');
    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES
           ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member')`,
        [org.orgId, admin.userId, creator.userId, invited.userId, bystander.userId],
      );
    });
    return { orgId: org.orgId, slug: org.slug, owner, admin, creator, invited, bystander };
  }

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

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';

    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    db = createDb(pool);

    const rtOpts = { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const };
    rt = new Runtime(db, rtOpts).register({
      commands: [...kernelCommands, ...notesCommands, ...projectsCommands, ...signCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries, ...projectsQueries, ...signQueries],
    });
    rtNoProjects = new Runtime(db, { ...rtOpts, absentModules: ['projects'] }).register({
      commands: [...kernelCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...notesCommands, ...projectsCommands, ...signCommands, orgPurgeCommand({ store })],
      queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries, ...projectsQueries, ...signQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('prevents self-lockout and unauthorized owner delegation on private project create and create_from_template', async () => {
    const o = await setupTeamOrg();

    // Even when memberUserIds: [] is supplied explicitly, creating a private project ensures creator and owner are added.
    const { projectId } = await exec<{ projectId: string }>(o.creator.userId, o.orgId, 'projects.project.create', {
      name: 'Kế hoạch nội bộ',
      visibility: 'private',
      memberUserIds: [],
    });
    const detail = await query<ProjectDetail>(o.creator.userId, o.orgId, 'projects.project.get', { id: projectId });
    expect(detail.visibility).toBe('private');
    const board = await query<ProjectBoard>(o.creator.userId, o.orgId, 'projects.board', { projectId });
    expect(board.members.filter((m) => m.onProject).map((m) => m.userId)).toEqual([o.creator.userId]);
    await expect(query(o.bystander.userId, o.orgId, 'projects.project.get', { id: projectId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });

    // Plain member cannot create a private project for another owner (403), while org admin can (and both creator + owner become members).
    await expect(
      exec(o.creator.userId, o.orgId, 'projects.project.create', {
        name: 'Ủy thác trái phép',
        visibility: 'private',
        ownerUserId: o.invited.userId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      exec(o.creator.userId, o.orgId, 'projects.project.create_from_template', {
        builtinKey: 'monthly-close',
        visibility: 'private',
        ownerUserId: o.invited.userId,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const { projectId: tplProjectId, taskIds } = await exec<{ projectId: string; taskIds: string[] }>(
      o.admin.userId,
      o.orgId,
      'projects.project.create_from_template',
      {
        builtinKey: 'monthly-close',
        name: 'Khóa sổ bí mật',
        visibility: 'private',
        ownerUserId: o.invited.userId,
        memberUserIds: [],
      },
    );
    expect(taskIds.length).toBeGreaterThan(0);
    const tplBoard = await query<ProjectBoard>(o.admin.userId, o.orgId, 'projects.board', { projectId: tplProjectId });
    expect(tplBoard.project.visibility).toBe('private');
    expect(tplBoard.members.filter((m) => m.onProject).map((m) => m.userId).sort()).toEqual(
      [o.admin.userId, o.invited.userId].sort(),
    );
    await expect(query(o.bystander.userId, o.orgId, 'projects.project.get', { id: tplProjectId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    await expect(query(o.bystander.userId, o.orgId, 'kernel.task.get', { id: taskIds[0] })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      status: 404,
    });
  });

  it('toggles org <-> private safely, protects project owner removal, revokes dynamically, and hides notifications', async () => {
    const o = await setupTeamOrg();

    // Create an org project with explicit empty memberUserIds so we test org -> private self-lockout backfill.
    const { projectId } = await exec<{ projectId: string }>(o.creator.userId, o.orgId, 'projects.project.create', {
      name: 'Dự án Chuyển Đổi',
      visibility: 'org',
      memberUserIds: [],
    });
    const { taskId } = await exec<{ taskId: string }>(o.creator.userId, o.orgId, 'projects.task.create', {
      projectId,
      title: 'Tài liệu nhạy cảm',
      assigneePositionId: null,
    });

    // Bystander can see it while org-wide.
    expect((await query<ProjectListResult>(o.bystander.userId, o.orgId, 'projects.project.list')).projects.map((p) => p.id)).toContain(projectId);

    // Creator invites an org member, then tries toggling as invited non-owner member (403).
    await exec(o.creator.userId, o.orgId, 'projects.member.add', { projectId, userId: o.invited.userId });
    await expect(
      exec(o.invited.userId, o.orgId, 'projects.project.update', { projectId, visibility: 'private' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Owner (creator) switches org -> private: creator is auto-added to project_member so no lockout occurs!
    await exec(o.creator.userId, o.orgId, 'projects.project.update', { projectId, visibility: 'private' });
    const afterPrivate = await query<ProjectBoard>(o.creator.userId, o.orgId, 'projects.board', { projectId });
    expect(afterPrivate.project.visibility).toBe('private');
    expect(afterPrivate.members.filter((m) => m.onProject).map((m) => m.userId).sort()).toEqual(
      [o.creator.userId, o.invited.userId].sort(),
    );

    // Bystander immediately loses access to both project and task.
    await expect(query(o.bystander.userId, o.orgId, 'projects.project.get', { id: projectId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    await expect(query(o.bystander.userId, o.orgId, 'kernel.task.get', { id: taskId })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      status: 404,
    });

    // Cannot remove project.owner_user_id while they own the project.
    await expect(
      exec(o.owner.userId, o.orgId, 'projects.member.remove', { projectId, userId: o.creator.userId }),
    ).rejects.toMatchObject({ code: 'PROJECT_OWNER_CANNOT_REMOVE', status: 409 });

    // Transfer ownership to org admin (who wasn't yet in project_member): admin is auto-added, then former owner can be removed!
    await exec(o.owner.userId, o.orgId, 'projects.project.set_owner', { projectId, ownerUserId: o.admin.userId });
    const afterSetOwner = await query<ProjectBoard>(o.admin.userId, o.orgId, 'projects.board', { projectId });
    expect(afterSetOwner.members.filter((m) => m.onProject).map((m) => m.userId)).toContain(o.admin.userId);
    await exec(o.admin.userId, o.orgId, 'projects.member.remove', { projectId, userId: o.creator.userId });

    // Removed creator loses access immediately; org owner/admin retain access.
    await expect(query(o.creator.userId, o.orgId, 'projects.project.get', { id: projectId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    expect((await query<ProjectDetail>(o.admin.userId, o.orgId, 'projects.project.get', { id: projectId })).id).toBe(projectId);

    // Seed notifications pointing to the private project and task for the removed user and confirm notification.list omits titles.
    const outboxId = randomUUID();
    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.outbox_event (org_id, id, type, payload, actor_type, actor_id, created_at)
         VALUES ($1, $2, 'projects.weekly_status.sent', $3::jsonb, 'user', $4, now())`,
        [o.orgId, outboxId, JSON.stringify({ projectId, userIds: [o.creator.userId, o.invited.userId] }), o.admin.userId],
      );
    });
    await workerRt.execute('kernel.notification.dispatch', { eventId: outboxId }, { actor: SYSTEM, orgId: o.orgId });
    const removedNotifs = await query<{ items: Array<{ subjectId: string | null; detail: Record<string, string> }> }>(
      o.creator.userId,
      o.orgId,
      'kernel.notification.list',
      {},
    );
    const privNotif = removedNotifs.items.find((n) => n.subjectId === projectId);
    expect(privNotif).toBeDefined();
    expect(privNotif?.detail.title).toBeUndefined();

    const invitedNotifs = await query<{ items: Array<{ subjectId: string | null; detail: Record<string, string> }> }>(
      o.invited.userId,
      o.orgId,
      'kernel.notification.list',
      {},
    );
    expect(invitedNotifs.items.find((n) => n.subjectId === projectId)?.detail.title).toBe('Dự án Chuyển Đổi');

    // Switching back private -> org restores bystander access cleanly.
    await exec(o.admin.userId, o.orgId, 'projects.project.update', { projectId, visibility: 'org' });
    expect((await query<ProjectDetail>(o.bystander.userId, o.orgId, 'projects.project.get', { id: projectId })).visibility).toBe('org');
  });

  it('does not retain acting non-owner admin in project_member on private update or owner transfer (#2604)', async () => {
    const o = await setupTeamOrg();
    const { projectId } = await exec<{ projectId: string }>(o.creator.userId, o.orgId, 'projects.project.create', {
      name: 'Dự án Không Phải Của Admin',
      visibility: 'org',
      memberUserIds: [],
    });

    // Org admin toggles someone else's org project -> private: only project owner is auto-added, not acting admin.
    await exec(o.admin.userId, o.orgId, 'projects.project.update', { projectId, visibility: 'private' });
    const afterUpdate = await query<ProjectBoard>(o.admin.userId, o.orgId, 'projects.board', { projectId });
    expect(afterUpdate.members.filter((m) => m.onProject).map((m) => m.userId)).toEqual([o.creator.userId]);

    // Org admin transfers ownership to invited: incoming + prior owner keep membership, acting admin is not added.
    await exec(o.admin.userId, o.orgId, 'projects.project.set_owner', { projectId, ownerUserId: o.invited.userId });
    const afterTransfer = await query<ProjectBoard>(o.admin.userId, o.orgId, 'projects.board', { projectId });
    expect(afterTransfer.members.filter((m) => m.onProject).map((m) => m.userId).sort()).toEqual(
      [o.creator.userId, o.invited.userId].sort(),
    );

    // Demoting admin to member immediately revokes access cleanly (404).
    await withAdmin((c) =>
      c.query(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [
        o.orgId,
        o.admin.userId,
      ]),
    );
    await expect(query(o.admin.userId, o.orgId, 'projects.project.get', { id: projectId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
  });

  it('blocks switching an org project with an existing project_acceptance eSign envelope to private (#2604)', async () => {
    const o = await setupTeamOrg();
    const { projectId } = await exec<{ projectId: string }>(o.owner.userId, o.orgId, 'projects.project.create', {
      name: 'Dự án Đã Nghiệm Thu',
      visibility: 'org',
    });

    const pdfBytes = Uint8Array.from(Buffer.from('%PDF-1.4\n% acceptance\n%%EOF\n', 'utf8'));
    const sha = sha256Hex(pdfBytes);
    const { fileId } = await exec<{ fileId: string }>(o.owner.userId, o.orgId, 'kernel.file.ingest', {
      filename: 'acceptance.pdf',
      contentType: 'application/pdf',
      sizeBytes: pdfBytes.byteLength,
      sha256: sha,
      storageKey: fileKey(o.orgId, sha),
      generation: contentGeneration(sha),
      source: 'sign_document',
    });
    await exec(o.owner.userId, o.orgId, 'sign.envelope.create', {
      title: 'Biên bản nghiệm thu - Dự án Đã Nghiệm Thu',
      sourceKind: 'project_acceptance',
      sourceId: projectId,
      sourceFileId: fileId,
    });

    await expect(
      exec(o.owner.userId, o.orgId, 'projects.project.update', { projectId, visibility: 'private' }),
    ).rejects.toMatchObject({ code: 'PROJECT_PRIVATE_ACCEPTANCE_EXISTS', status: 409 });

    await expect(
      withAdmin((c) =>
        c.query(`UPDATE ludy_projects.project SET visibility = 'private' WHERE org_id = $1 AND id = $2`, [
          o.orgId,
          projectId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // Companion acceptance guards (#4689): non-'org' visibility fails closed across
    // project_no_private_with_acceptance, check_project_acceptance_source, and project_acceptance_org_only.
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`ALTER TABLE ludy_projects.project DROP CONSTRAINT project_visibility_check`);
        await c.query('SAVEPOINT sp_proj_acc_upd');
        await expect(
          c.query(`UPDATE ludy_projects.project SET visibility = 'restricted' WHERE org_id = $1 AND id = $2`, [
            o.orgId,
            projectId,
          ]),
        ).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('PROJECT_PRIVATE_ACCEPTANCE_EXISTS'),
        });
        await c.query('ROLLBACK TO SAVEPOINT sp_proj_acc_upd');

        const restrProj = await c.query<{ id: string }>(
          `INSERT INTO ludy_projects.project (org_id, name, visibility, owner_user_id, created_by)
           VALUES ($1, 'Restricted Acceptance Guard', 'restricted', $2, $2) RETURNING id`,
          [o.orgId, o.owner.userId],
        );
        const restrProjId = restrProj.rows[0]!.id;

        await c.query('SAVEPOINT sp_env_insert');
        await expect(
          c.query(
            `INSERT INTO ludy_sign.envelope (org_id, title, status, routing_mode, source_kind, source_id, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, created_by)
             VALUES ($1, 'Restricted Acceptance', 'draft', 'parallel', 'project_acceptance', $2, $3, $4, $5, $6, 'pending', $7)`,
            [o.orgId, restrProjId, fileId, fileKey(o.orgId, sha), contentGeneration(sha), sha, o.owner.userId],
          ),
        ).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('SIGN_PRIVATE_PROJECT_ACCEPTANCE_FORBIDDEN'),
        });
        await c.query('ROLLBACK TO SAVEPOINT sp_env_insert');

        await enterUser(c, o.owner.userId, o.orgId);
        await c.query('SET LOCAL ROLE ludy_tenant');
        const checkRes = await c.query<{ state: number; org_only: boolean }>(
          `SELECT ludy_sign.check_project_acceptance_source($1::uuid, $2::uuid) AS state,
                  ludy_projects.project_acceptance_org_only($1::uuid, $2::uuid) AS org_only`,
          [o.orgId, restrProjId],
        );
        expect(checkRes.rows[0]).toEqual({ state: 1, org_only: false });
      } finally {
        await c.query('ROLLBACK').catch(() => {});
      }
    });
  });

  it('serializes concurrent READ COMMITTED org -> private transitions against project_acceptance envelope creation (#2604)', async () => {
    const o = await setupTeamOrg();
    const ingestPdf = async (userId: string, tag: string) => {
      const pdfBytes = Uint8Array.from(Buffer.from(`%PDF-1.4\n% ${tag}\n%%EOF\n`, 'utf8'));
      const sha = sha256Hex(pdfBytes);
      const { fileId } = await exec<{ fileId: string }>(userId, o.orgId, 'kernel.file.ingest', {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: pdfBytes.byteLength,
        sha256: sha,
        storageKey: fileKey(o.orgId, sha),
        generation: contentGeneration(sha),
        source: 'sign_document',
      });
      return { fileId, sha };
    };
    const waitForLock = async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const locked = await withAdmin(async (c) => {
          const { rows } = await c.query<{ cnt: number }>(
            `SELECT count(*)::int AS cnt
               FROM pg_catalog.pg_stat_activity
              WHERE datname = pg_catalog.current_database()
                AND wait_event_type = 'Lock'
                AND pid <> pg_catalog.pg_backend_pid()`,
          );
          return (rows[0]?.cnt ?? 0) > 0;
        });
        if (locked) return true;
        await new Promise((r) => setTimeout(r, 15));
      }
      return false;
    };

    // Direction 1: Tx A locks project row FOR UPDATE and sets visibility = 'private' (uncommitted).
    // Concurrent sign.envelope.create (Tx B) blocks on FOR SHARE, sees 'private' after Tx A commits, and rejects cleanly.
    const { projectId: proj1 } = await exec<{ projectId: string }>(o.owner.userId, o.orgId, 'projects.project.create', {
      name: 'Dự án Đua 1',
      visibility: 'org',
    });
    const file1 = await ingestPdf(o.owner.userId, 'race-1');

    const c1 = await pool.connect();
    let envOutcome: Promise<{ ok: true; value: unknown } | { ok: false; err: unknown }> | undefined;
    try {
      await c1.query('BEGIN');
      await enterUser(c1, o.owner.userId, o.orgId);
      await c1.query('SET LOCAL ROLE ludy_tenant');
      await c1.query(`UPDATE ludy_projects.project SET visibility = 'private' WHERE org_id = $1 AND id = $2`, [
        o.orgId,
        proj1,
      ]);

      envOutcome = exec(o.owner.userId, o.orgId, 'sign.envelope.create', {
        title: 'Biên bản đua 1',
        sourceKind: 'project_acceptance',
        sourceId: proj1,
        sourceFileId: file1.fileId,
      }).then(
        (value) => ({ ok: true as const, value }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      expect(await waitForLock()).toBe(true);
      await c1.query('COMMIT');
    } catch (err) {
      await c1.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c1.release();
    }
    expect(await envOutcome).toMatchObject({
      ok: false,
      err: { code: 'SIGN_PRIVATE_PROJECT_ACCEPTANCE_FORBIDDEN', status: 422 },
    });
    await expect(
      rt.execute(
        'sign.template.instantiate',
        {
          templateId: randomUUID(),
          recipients: [],
          sourceKind: 'project_acceptance',
          sourceId: proj1,
        },
        { actor: asUser(o.owner.userId), orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_PRIVATE_PROJECT_ACCEPTANCE_FORBIDDEN', status: 422 });
    await expect(
      rt.execute(
        'sign.template.instantiate',
        {
          templateId: randomUUID(),
          recipients: [],
          sourceKind: 'project_acceptance',
          sourceId: proj1,
        },
        { actor: asUser(o.bystander.userId), orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });

    // Even direct trigger check (bypassing check_project_acceptance_source) blocks inserting project_acceptance for private proj1.
    await expect(
      withAdmin((c) =>
        c.query(
          `INSERT INTO ludy_sign.envelope (org_id, title, status, routing_mode, source_kind, source_id, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, created_by)
           VALUES ($1, 'Bypass trigger check', 'draft', 'parallel', 'project_acceptance', $2, $3, $4, $5, $6, 'pending', $7)`,
          [o.orgId, proj1, file1.fileId, fileKey(o.orgId, file1.sha), contentGeneration(file1.sha), file1.sha, o.owner.userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const dir1State = await withAdmin(async (c) => {
      const p = await c.query<{ visibility: string }>(
        `SELECT visibility FROM ludy_projects.project WHERE org_id = $1 AND id = $2`,
        [o.orgId, proj1],
      );
      const e = await c.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM ludy_sign.envelope WHERE org_id = $1 AND source_kind = 'project_acceptance' AND source_id = $2`,
        [o.orgId, proj1],
      );
      return { visibility: p.rows[0]?.visibility, envelopes: e.rows[0]?.cnt };
    });
    expect(dir1State).toEqual({ visibility: 'private', envelopes: 0 });

    // Direction 2: Tx A acquires FOR SHARE via check_project_acceptance_source and inserts envelope (uncommitted).
    // Concurrent projects.project.update (Tx B) blocks on FOR UPDATE until Tx A commits, then rejects with 409.
    const { projectId: proj2 } = await exec<{ projectId: string }>(o.owner.userId, o.orgId, 'projects.project.create', {
      name: 'Dự án Đua 2',
      visibility: 'org',
    });
    const file2 = await ingestPdf(o.owner.userId, 'race-2');

    const c2 = await pool.connect();
    let updateOutcome: Promise<{ ok: true; value: unknown } | { ok: false; err: unknown }> | undefined;
    try {
      await c2.query('BEGIN');
      await enterUser(c2, o.owner.userId, o.orgId);
      await c2.query('SET LOCAL ROLE ludy_tenant');
      const chk = await c2.query<{ state: number }>(
        `SELECT ludy_sign.check_project_acceptance_source($1::uuid, $2::uuid) AS state`,
        [o.orgId, proj2],
      );
      expect(chk.rows[0]?.state).toBe(2);
      await c2.query(
        `INSERT INTO ludy_sign.envelope (org_id, title, status, routing_mode, source_kind, source_id, source_file_id, source_storage_key, source_generation, source_sha256, inspect_status, created_by)
         VALUES ($1, 'Biên bản đua 2', 'draft', 'parallel', 'project_acceptance', $2, $3, $4, $5, $6, 'pending', $7)`,
        [o.orgId, proj2, file2.fileId, fileKey(o.orgId, file2.sha), contentGeneration(file2.sha), file2.sha, o.owner.userId],
      );

      updateOutcome = exec(o.owner.userId, o.orgId, 'projects.project.update', {
        projectId: proj2,
        visibility: 'private',
      }).then(
        (value) => ({ ok: true as const, value }),
        (err: unknown) => ({ ok: false as const, err }),
      );
      expect(await waitForLock()).toBe(true);
      await c2.query('COMMIT');
    } catch (err) {
      await c2.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c2.release();
    }
    expect(await updateOutcome).toMatchObject({
      ok: false,
      err: { code: 'PROJECT_PRIVATE_ACCEPTANCE_EXISTS', status: 409 },
    });

    const dir2State = await withAdmin(async (c) => {
      const p = await c.query<{ visibility: string }>(
        `SELECT visibility FROM ludy_projects.project WHERE org_id = $1 AND id = $2`,
        [o.orgId, proj2],
      );
      const e = await c.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM ludy_sign.envelope WHERE org_id = $1 AND source_kind = 'project_acceptance' AND source_id = $2`,
        [o.orgId, proj2],
      );
      return { visibility: p.rows[0]?.visibility, envelopes: e.rows[0]?.cnt };
    });
    expect(dir2State).toEqual({ visibility: 'org', envelopes: 1 });
  });

  it('saves private project weekly status share_note as private note and guards module-off notes panel + org_purge', async () => {
    const o = await setupTeamOrg();
    const { projectId } = await exec<{ projectId: string }>(o.owner.userId, o.orgId, 'projects.project.create', {
      name: 'Dự án Mật Q4',
      visibility: 'private',
      memberUserIds: [o.invited.userId],
    });
    await exec(o.owner.userId, o.orgId, 'projects.task.create', {
      projectId,
      title: 'Chốt hợp đồng mật',
      assigneePositionId: null,
    });

    // Weekly status share_note on a private project MUST create a private note (author-only), never org-visible!
    const { noteId } = await exec<{ noteId: string }>(o.owner.userId, o.orgId, 'projects.weekly_status.share_note', {
      projectId,
      title: 'Báo cáo tuần dự án mật',
      body: 'Tiến độ bảo mật tuần 1',
      tainted: false,
    });
    const authorNote = await query<Note>(o.owner.userId, o.orgId, 'notes.note.get', { noteId });
    expect(authorNote.visibility).toBe('private');
    await expect(query(o.bystander.userId, o.orgId, 'notes.note.get', { noteId })).rejects.toMatchObject({
      code: 'NOTE_NOT_FOUND',
      status: 404,
    });
    await expect(query(o.invited.userId, o.orgId, 'notes.note.get', { noteId })).rejects.toMatchObject({
      code: 'NOTE_NOT_FOUND',
      status: 404,
    });
    await expect(
      exec(o.invited.userId, o.orgId, 'projects.template.create', {
        name: 'Sao chép trái phép',
        sourceProjectId: projectId,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_PRIVATE_TEMPLATE_FORBIDDEN', status: 422 });

    // Shared org note linked to the private project MUST stay hidden in notes.record.panel even when projects module is OFF!
    await exec(o.invited.userId, o.orgId, 'notes.note.create', {
      title: 'Ghi chú chung gắn dự án mật',
      visibility: 'org',
      link: { targetType: 'projects.project', targetId: projectId },
    });
    const bystanderPanelOff = await rtNoProjects.query<NoteRecordPanel>(
      'notes.record.panel',
      { targetType: 'projects.project', targetId: projectId },
      { actor: asUser(o.bystander.userId), orgId: o.orgId },
    );
    expect(bystanderPanelOff).toEqual({ pinned: [], latest: [], todos: [] });

    // Switching an org project linked to a public roadmap board to private fails cleanly with 422.
    const { projectId: roadmapLinkedProjId } = await exec<{ projectId: string }>(
      o.owner.userId,
      o.orgId,
      'projects.project.create',
      { name: 'Dự án gắn lộ trình công khai', visibility: 'org' },
    );
    await exec(o.owner.userId, o.orgId, 'projects.roadmap.board.create', {
      title: 'Bảng lộ trình công khai',
      slug: 'priv-flow-roadmap',
      projectId: roadmapLinkedProjId,
    });
    await expect(
      exec(o.owner.userId, o.orgId, 'projects.project.update', {
        projectId: roadmapLinkedProjId,
        visibility: 'private',
      }),
    ).rejects.toMatchObject({ code: 'ROADMAP_PRIVATE_PROJECT_FORBIDDEN', status: 422 });

    // Org export and purgeOrg cleanly complete on an org holding private projects and linked tasks.
    const generatedAt = new Date(Date.now() - 35 * DAY);
    const exported = await runOrgExport({ runtime: workerRt, store, sealer, retentionDays: 40 }, o.orgId, { now: () => generatedAt });
    expect(exported.parts.some((p) => p.table === 'projects.project')).toBe(true);

    await rt.execute('kernel.org.offboard', { confirmSlug: o.slug }, { actor: asMfa(o.owner.userId), orgId: o.orgId });
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_kernel.audit_event
            SET occurred_at = $1
          WHERE org_id = $2 AND command IN ('kernel.org.offboard', 'kernel.org.export.record')`,
        [new Date(Date.now() - 32 * DAY), o.orgId],
      );
      await c.query('COMMIT');
    });

    const purged = await purgeOrg(workerRt, 30, { ref: o.orgId, reason: 'projects-private-test' });
    expect(purged).toMatchObject({ kind: 'purged', orgId: o.orgId });
  });
});
