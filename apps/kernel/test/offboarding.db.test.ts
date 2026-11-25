// Org offboarding with export (issue #38, plan §7.9) on a real PostgreSQL 17: the product flow. Access, status and
// audit invariants live in test/invariant/offboarding.db.test.ts. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser
// URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { EXPORT_TABLE_NAMES, OWNER_RUN_EXPORT_TABLE_NAMES, createOrg, kernelCommands, kernelQueries, myOrgs, upsertIdentity, type ExportRecord, type OrgExportView } from '@ludy/kernel';
import { BlobNotFoundError, Runtime, defineQuery, exportKey, fileKey, readVerified, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { rebindExport, rebindExports } from '../src/export-rebind.ts';
import { ExportSealer, exportAad } from '../src/export-seal.ts';
import { runOrgExport, type OrgExportManifest } from '../src/org-export.ts';
import { exportCoverageProblems, exportedTables, omitProblems } from './org-export-coverage.ts';
import { readPurgeCatalog } from './org-purge-coverage.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';
import { auditRoleFunctionExecute, resolveDbIdentifiers } from './invariant/fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  // Memory has no object versions: the generation is the content address (ADR-0013).
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

const suite = ADMIN ? describe : describe.skip;

suite('org offboarding on PostgreSQL (#38)', () => {
  const dbName = `ludy_test_offboard_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let workerRuntime: Runtime;
  const store = new MemoryStore();
  const exportKeyBytes = randomBytes(32);
  const sealer = new ExportSealer(exportKeyBytes);

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function newUser(label: string) {
    const tag = `${label}-${randomUUID().slice(0, 8)}`;
    const email = `${tag}@example.com`;
    return { id: await upsertIdentity(db, { issuer: 'test', subject: tag, email, name: label }), email };
  }

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // An org with an owner and a member who joined through an invite, and a file.
  async function orgWithMember(name: string) {
    const owner = await newUser('owner');
    const member = await newUser('member');
    const org = await createOrg(runtime, asUser(owner.id), name);
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: member.email, role: 'member' },
      { actor: asMfa(owner.id), orgId: org.orgId },
    );
    await runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(member.id) });
    const bytes = new TextEncoder().encode(`<xml>${name}</xml>`);
    const sha256 = sha256Hex(bytes);
    const generation = await store.put(fileKey(org.orgId, sha256), bytes);
    await runtime.execute(
      'kernel.file.ingest',
      { filename: 'hd.xml', contentType: 'application/xml', sizeBytes: bytes.byteLength, sha256, storageKey: fileKey(org.orgId, sha256), generation, source: 'upload' },
      { actor: asUser(member.id), orgId: org.orgId },
    );
    return { org, owner, member };
  }

  const status = (orgId: string) =>
    withAdmin(async (admin) => (await admin.query<{ status: string }>('SELECT status FROM ludy_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.status);

  beforeAll(async () => {
    const base = new URL(ADMIN as string);
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const loginUrl = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    appUrl = loginUrl('ludy_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: loginUrl('ludy_worker', 'test-worker-pw'), max: 4 });
    db = createDb(pool);
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries],
      });
    runtime = register(db);
    workerRuntime = register(createDb(workerPool));
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const admin = new pg.Client({ connectionString: ADMIN });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  });

  // Every crove_* table with an org_id is in the owner export or on NOT_EXPORTED with a reason (#3201): a table a migration adds and EXPORT_TABLES
  // forgets fails here with its name. The reading and its messages are org-export-coverage.ts and org-export-coverage.test.ts.
  it('has a rule for every table with an org_id', async () => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const catalog = await readPurgeCatalog(client);
      expect(catalog.tables).toContain('ludy_finance.household_profile');
      expect(exportCoverageProblems(catalog.tables, exportedTables())).toEqual([]);
      // Every name an entry omits is a real column of its table: `jsonb - text[]` ignores an unknown key, so a typo would export the secret.
      const found = await client.query<{ tbl: string; col: string }>(
        "SELECT table_schema || '.' || table_name AS tbl, column_name AS col FROM information_schema.columns WHERE table_schema LIKE 'ludy\\_%' OR table_schema LIKE 'crove\\_%'",
      );
      const columns = new Map<string, Set<string>>();
      for (const r of found.rows) columns.set(r.tbl, (columns.get(r.tbl) ?? new Set<string>()).add(r.col));
      expect(omitProblems(columns)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('is owner-only R3 with a typed slug, and refusals change nothing', async () => {
    const { org, owner, member } = await orgWithMember('Công ty Từ chối');
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(member.id), orgId: org.orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asUser(owner.id), orgId: org.orgId })).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
    });
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: 'khac' }, { actor: asMfa(owner.id), orgId: org.orgId })).rejects.toMatchObject({
      code: 'SLUG_MISMATCH',
      status: 422,
    });
    expect(await status(org.orgId)).toBe('active');
    const refusals = await withAdmin(async (admin) =>
      (
        await admin.query<{ outcome: string }>(
          `SELECT outcome FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.offboard' ORDER BY occurred_at, id`,
          [org.orgId],
        )
      ).rows.map((r) => r.outcome),
    );
    expect(refusals).toEqual(['denied', 'denied', 'failed']);
  });

  it('moves the org to offboarding, audited, and from then on only owners get in', async () => {
    const { org, owner, member } = await orgWithMember('Công ty Đóng');
    const result = await runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId });
    expect(result).toEqual({ status: 'offboarding', exportRequested: true });
    expect(await status(org.orgId)).toBe('offboarding');
    const audit = await withAdmin(async (admin) =>
      (
        await admin.query<{ actor_id: string; outcome: string; detail: Record<string, unknown> }>(
          `SELECT actor_id, outcome, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.offboard'`,
          [org.orgId],
        )
      ).rows,
    );
    expect(audit).toEqual([
      { actor_id: owner.id, outcome: 'ok', detail: expect.objectContaining({ previous_status: 'active', status: 'offboarding', aal: 'aal2' }) },
    ]);
    const events = await withAdmin(async (admin) =>
      (await admin.query<{ type: string }>(`SELECT type FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type LIKE 'kernel.org.%'`, [org.orgId])).rows,
    );
    expect(events).toEqual([{ type: 'kernel.org.export_requested' }]);

    // The member is refused like a non-member, and the org leaves the member's list; the owner keeps both.
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(member.id), orgId: org.orgId })).rejects.toMatchObject({ status: 403 });
    expect((await myOrgs(db, member.id)).map((o) => o.orgId)).not.toContain(org.orgId);
    expect((await myOrgs(db, owner.id)).map((o) => o.orgId)).toContain(org.orgId);
    await expect(runtime.query('kernel.org.get', {}, { actor: asUser(owner.id), orgId: org.orgId })).resolves.toMatchObject({ orgId: org.orgId });

    // New members cannot join: an invite created now cannot be accepted.
    const late = await newUser('late');
    const { acceptPath } = await runtime.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: late.email, role: 'viewer' },
      { actor: asMfa(owner.id), orgId: org.orgId },
    );
    await expect(
      runtime.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: asUser(late.id) }),
    ).rejects.toMatchObject({ code: 'INVITE_NOT_FOUND' });

    // Asking again while the export has not finished is refused; status and events stay as they are.
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId })).rejects.toMatchObject({
      code: 'EXPORT_PENDING',
      status: 409,
    });
    expect(await status(org.orgId)).toBe('offboarding');
  });

  it('exports every table of the org and the stored files list, records it and serves it to owners only', async () => {
    const other = await orgWithMember('Công ty Khác');
    const { org, owner, member } = await orgWithMember('Công ty Xuất');
    await runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId });

    // A system audit row, which names the worker process that wrote it (#1951): the org's copy leaves the name out.
    const systemCommand = randomUUID();
    const worker = await workerPool.connect();
    try {
      await worker.query('BEGIN');
      await worker.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [org.orgId]);
      await worker.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, actor_type, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, 'system', 'test.system', $2, 'ok', repeat('0', 64), '{"rows": 1}')`,
        [org.orgId, systemCommand],
      );
      await worker.query('COMMIT');
    } finally {
      worker.release();
    }
    const reader = new pg.Client({ connectionString: adminUrl });
    await reader.connect();
    const stamped = await reader
      .query<{ detail: Record<string, unknown> }>('SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command_id = $2', [org.orgId, systemCommand])
      .finally(() => reader.end());
    expect(stamped.rows[0]?.detail).toMatchObject({ rows: 1, workerInstance: expect.any(String) });

    // A household business and its profile (#3201): the tax group, PIT method and the representative's name belong to the owner's copy of the books.
    const householdId = randomUUID();
    const seeder = new pg.Client({ connectionString: adminUrl });
    await seeder.connect();
    try {
      // A member's private and shared saved views (#3367): the snapshot reads as the system actor, which sees every member's rows, so the export itself keeps the private one out.
      await seeder.query(
        "INSERT INTO ludy_kernel.saved_view (org_id, user_id, scope, name, filters, shared) VALUES ($1, $2, 'finance.bills', 'Chờ duyệt', '{\"status\":\"pending\"}'::jsonb, false), ($1, $2, 'finance.bills', 'Cả nhóm', '{}'::jsonb, true)",
        [org.orgId, member.id],
      );
      await seeder.query(
        "INSERT INTO ludy_social.saved_view (org_id, user_id, name, filters, shared) VALUES ($1, $2, 'Riêng', '{}'::jsonb, false), ($1, $2, 'Chung', '{}'::jsonb, true)",
        [org.orgId, member.id],
      );
      // A member's own notification and daily mail setting stay private to them: the export must not carry them.
      await seeder.query("INSERT INTO ludy_kernel.notification_mute (org_id, user_id, kind) VALUES ($1, $2, 'finance.invoice')", [org.orgId, member.id]);
      await seeder.query("INSERT INTO ludy_crm.pipeline_stage (org_id, name, kind, position) VALUES ($1, 'Đàm phán', 'open', 1)", [org.orgId]);
      await seeder.query("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Hộ kinh doanh Nguyễn Văn A', 'household', $3)", [org.orgId, householdId, owner.id]);
      await seeder.query(
        "INSERT INTO ludy_finance.household_profile (org_id, legal_entity_id, effective_from, tax_group, pit_method, trades, einvoice_registered, representative_name, created_by) VALUES ($1, $2, '2026-01-01', 2, 'percentage', ARRAY['goods'], false, 'Nguyễn Văn A', $3)",
        [org.orgId, householdId, owner.id],
      );
    } finally {
      await seeder.end();
    }

    const generatedAt = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 10 * 86_400_000);
    const expectedExpiresAt = new Date(generatedAt.getTime() + 40 * 86_400_000).toISOString();
    const record = await runOrgExport({ runtime: workerRuntime, store, sealer, retentionDays: 40 }, org.orgId, { now: () => generatedAt });
    // The tax portal's purchase lists are kept records (#465): an export carries them.
    expect(EXPORT_TABLE_NAMES).toEqual(expect.arrayContaining(['finance.portal_invoice_list', 'finance.portal_invoice_row']));
    // One chunk per table here, in table order; everything sealed under the org's export prefix.
    expect(record.parts.map((p) => [p.table, p.chunk])).toEqual(EXPORT_TABLE_NAMES.map((t) => [t, 0]));
    expect(record).toMatchObject({ format: 'crove.org-export.v2', encryption: 'aes-256-gcm', fileCount: 1, expiresAt: expectedExpiresAt });
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const lines = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const part of record.parts) {
      expect(part.key).toBe(exportKey(org.orgId, part.sha256));
      const stored = await store.get(part.key);
      expect(sha256Hex(stored)).toBe(part.sha256);
      // Sealed at rest: the stored bytes are not the NDJSON, and only this part's AAD opens them.
      expect(decode(stored)).not.toContain(org.orgId);
      const rows = lines(decode(sealer.open(stored, exportAad(org.orgId, part), 'aes-256-gcm')));
      expect(rows).toHaveLength(part.rows);
      // Only this org's rows, whatever the table.
      expect(rows.every((r) => r.org_id === org.orgId)).toBe(true);
    }
    expect(() => sealer.open(store.blobs.get(record.parts[0]!.key)!, exportAad(other.org.orgId, record.parts[0]!), 'aes-256-gcm')).toThrow(/authentication/);
    const part = (table: string) => record.parts.find((p) => p.table === table)!;
    const rowsOf = async (table: string) => lines(decode(sealer.open(await store.get(part(table).key), exportAad(org.orgId, part(table)), 'aes-256-gcm')));
    // Only the shared view is in the owner's copy: a member's private view and mutes are readable by that member alone.
    expect(await rowsOf('kernel.saved_view')).toEqual([expect.objectContaining({ name: 'Cả nhóm', shared: true })]);
    expect(EXPORT_TABLE_NAMES).not.toContain('kernel.notification_mute');
    expect((await rowsOf('social.saved_view')).map((r) => r.name)).toEqual(['Chung']);
    expect(await rowsOf('crm.pipeline_stage')).toEqual([expect.objectContaining({ name: 'Đàm phán', kind: 'open' })]);
    // The household's profile is in the owner's copy, the representative's name included, and no other org's is.
    expect(await rowsOf('finance.household_profile')).toEqual([
      expect.objectContaining({ legal_entity_id: householdId, effective_from: '2026-01-01', tax_group: 2, pit_method: 'percentage', representative_name: 'Nguyễn Văn A' }),
    ]);
    // Secrets stay out.
    expect(await rowsOf('kernel.tenant')).toEqual([expect.not.objectContaining({ inbound_token: expect.anything() })]);
    expect((await rowsOf('kernel.member_invite')).every((r) => !('token_sha256' in r))).toBe(true);
    expect((await rowsOf('kernel.tenant_member')).map((r) => r.user_id).sort()).toEqual([owner.id, member.id].sort());
    // The export cursor has no ORDER BY, so the two entities are compared without their order.
    expect((await rowsOf('kernel.legal_entity')).map((r) => [r.name, r.is_default])).toEqual(expect.arrayContaining([[expect.any(String), true], ['Hộ kinh doanh Nguyễn Văn A', false]]));
    expect(await rowsOf('kernel.legal_entity')).toHaveLength(2);
    expect((await rowsOf('kernel.audit_event')).some((r) => r.command === 'kernel.org.offboard')).toBe(true);
    expect((await rowsOf('kernel.audit_event')).find((r) => r.command_id === systemCommand)).toMatchObject({ actor_type: 'system', detail: { rows: 1 } });
    expect((await rowsOf('kernel.audit_event')).every((r) => !(r.detail && typeof r.detail === 'object' && 'workerInstance' in r.detail))).toBe(true);
    const manifest = JSON.parse(decode(sealer.open(await store.get(record.manifestKey), exportAad(org.orgId, 'manifest'), 'aes-256-gcm'))) as OrgExportManifest;
    expect(manifest).toMatchObject({ orgId: org.orgId, generatedAt: generatedAt.toISOString(), snapshot: 'repeatable read', fileCount: 1, parts: record.parts });
    // The stored files are the kernel.file rows: key, generation and sha256 of each blob, which stays under org/.
    expect(await rowsOf('kernel.file')).toEqual([
      expect.objectContaining({ filename: 'hd.xml', content_type: 'application/xml', storage_key: expect.stringMatching(`^org/${org.orgId}/`), generation: expect.stringMatching(/^content:/) }),
    ]);

    // Recorded and visible to owners.
    const view = await runtime.query<OrgExportView>('kernel.org.export.get', {}, { actor: asUser(owner.id), orgId: org.orgId });
    expect(view).toMatchObject({
      status: 'offboarding',
      requestedAt: expect.any(String),
      export: { manifestKey: record.manifestKey, fileCount: 1, encryption: 'aes-256-gcm', expiresAt: record.expiresAt, expired: false },
    });
    expect(view.export?.tables.find((t) => t.table === 'kernel.tenant_member')).toEqual({ table: 'kernel.tenant_member', rows: 2, bytes: part('kernel.tenant_member').bytes, chunks: 1 });
    // Once it finished, the owner may ask for a new export (the worker then exports again).
    await expect(runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId })).resolves.toEqual({
      status: 'offboarding',
      exportRequested: true,
    });
    // The other org has no export and is untouched.
    const otherView = await runtime.query<OrgExportView>('kernel.org.export.get', {}, { actor: asUser(other.owner.id), orgId: other.org.orgId });
    expect(otherView).toEqual({ status: 'active', requestedAt: null, ownerRunTables: [...OWNER_RUN_EXPORT_TABLE_NAMES], export: null });
    await expect(runtime.query('kernel.org.export.get', {}, { actor: asUser(other.member.id), orgId: other.org.orgId })).rejects.toMatchObject({
      status: 403,
    });

    // The system command refuses keys outside the org's prefix.
    await expect(
      workerRuntime.execute(
        'kernel.org.export.record',
        { ...record, manifestKey: exportKey(other.org.orgId, record.manifestSha256) },
        { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
    // Nor a file key of the org itself: exports live under export/ only.
    await expect(
      workerRuntime.execute(
        'kernel.org.export.record',
        { ...record, manifestKey: fileKey(org.orgId, record.manifestSha256) },
        { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_STORAGE_KEY' });
    // Parts must cover every table with chunks in order.
    await expect(
      workerRuntime.execute('kernel.org.export.record', { ...record, parts: record.parts.slice(1) }, { actor: { type: 'system', component: 'test' }, orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    // Users cannot run the export query or record an export, and it never answers outside a stream.
    await expect(runtime.query('kernel.org.export.snapshot', { table: 'kernel.party' }, { actor: asUser(owner.id), orgId: org.orgId })).rejects.toMatchObject({
      status: 403,
    });
    await expect(runtime.stream('kernel.org.export.snapshot', {}, { actor: asUser(owner.id), orgId: org.orgId }, async () => {})).rejects.toMatchObject({
      status: 403,
    });
    await expect(workerRuntime.query('kernel.org.export.snapshot', {}, { actor: { type: 'system', component: 'test' }, orgId: org.orgId })).rejects.toMatchObject({
      code: 'STREAM_ONLY',
    });

    // Download through the API: owners only, parts named by the recorded export.
    const users = new Map<string, AuthUser>(
      [owner.id, other.owner.id].map((id) => [id, { userId: id, email: '', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null }]),
    );
    const app = createHttpApp({
      config: loadConfig({
        DATABASE_URL: appUrl,
        AUTH_JWT_SECRET: 'test-only-jwt-secret-for-export-0123456789',
        AUTH_ISSUER: 'test-auth',
        WEB_DIST: '/nonexistent',
        EXPORT_ENCRYPTION_KEY: exportKeyBytes.toString('base64'),
      }),
      runtime,
      store,
      authenticate: async (header) => users.get(String(header).replace('Bearer ', ''))!,
      pool,
      aiEnabled: false,
    });
    const get = (path: string, userId: string, slug: string) =>
      app.request(path, { headers: { authorization: `Bearer ${userId}`, 'x-ludy-org': slug } });
    const manifestResponse = await get('/api/org-export/manifest', owner.id, org.slug);
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get('content-disposition')).toContain('attachment');
    expect(JSON.parse(await manifestResponse.text())).toEqual(manifest);
    const memberResponse = await get('/api/org-export/kernel.tenant_member', owner.id, org.slug);
    expect(memberResponse.headers.get('content-type')).toContain('application/x-ndjson');
    expect(lines(await memberResponse.text()).map((r) => r.user_id).sort()).toEqual([owner.id, member.id].sort());
    expect((await get('/api/org-export/kernel.nope', owner.id, org.slug)).status).toBe(404);
    // Another org's owner gets nothing from this org, and nothing of their own yet.
    expect((await get('/api/org-export/manifest', other.owner.id, org.slug)).status).toBe(403);
    expect((await get('/api/org-export/manifest', other.owner.id, other.org.slug)).status).toBe(404);

    // A stored part replaced behind the record's back is never served.
    const victim = part('kernel.party');
    const original = store.blobs.get(victim.key)!;
    store.blobs.set(victim.key, sealer.seal(new TextEncoder().encode('{"forged":true}\n'), exportAad(org.orgId, victim)));
    expect((await get('/api/org-export/kernel.party', owner.id, org.slug)).status).toBe(500);
    store.blobs.set(victim.key, original);
    expect((await get('/api/org-export/kernel.party', owner.id, org.slug)).status).toBe(200);

    // An export past its expiry is refused even before the retention job deletes its blobs.
    await runOrgExport({ runtime: workerRuntime, store, sealer }, org.orgId, { now: () => new Date('2020-01-01T00:00:00Z') });
    const stale = await get('/api/org-export/manifest', owner.id, org.slug);
    expect(stale.status).toBe(404);
    expect(await stale.json()).toMatchObject({ code: 'EXPORT_EXPIRED' });

    // The retention job keeps exactly the blobs of records that have not expired: the first export's, not the stale one's.
    const system = { actor: { type: 'system' as const, component: 'test' }, orgId: org.orgId };
    const live = new Set(await workerRuntime.query<string[]>('kernel.org.export.live_keys', {}, system));
    expect(live).toEqual(new Set([record.manifestKey, ...record.parts.map((p) => p.key)]));
    await expect(runtime.query('kernel.org.export.live_keys', {}, { actor: asUser(owner.id), orgId: org.orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('re-records an export with the object versions of a restored bucket, and it downloads again (#351)', async () => {
    // A bucket with object versions: every write is a new version, as on S3; a restore copies the bytes into a new
    // bucket, where each object gets a new version id.
    class VersionedStore implements BlobStore {
      readonly versions = new Map<string, Array<{ id: string; bytes: Uint8Array }>>();
      readonly name: string;
      constructor(name: string) {
        this.name = name;
      }
      async put(key: string, bytes: Uint8Array) {
        const list = this.versions.get(key) ?? [];
        const latest = list.at(-1);
        if (latest && sha256Hex(latest.bytes) === sha256Hex(bytes)) return `s3:${latest.id}`;
        const id = `${this.name}-${randomUUID()}`;
        this.versions.set(key, [...list, { id, bytes }]);
        return `s3:${id}`;
      }
      async get(key: string, generation?: string | null) {
        const list = this.versions.get(key) ?? [];
        const found = generation?.startsWith('s3:') ? list.find((v) => `s3:${v.id}` === generation) : list.at(-1);
        if (!found) throw new BlobNotFoundError(key);
        return found.bytes;
      }
      async delete(key: string) {
        this.versions.delete(key);
      }
      restoredCopy(name: string) {
        const copy = new VersionedStore(name);
        for (const [key, list] of this.versions) copy.versions.set(key, [{ id: `${name}-${randomUUID()}`, bytes: list.at(-1)!.bytes }]);
        return copy;
      }
    }
    const { org, owner } = await orgWithMember('Công ty Khôi phục');
    await runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId });
    const original = new VersionedStore('before');
    const record = await runOrgExport({ runtime: workerRuntime, store: original, sealer }, org.orgId);
    expect(record.manifestGeneration).toMatch(/^s3:before-/);
    const system = { actor: { type: 'system' as const, component: 'test' }, orgId: org.orgId };
    expect(await workerRuntime.query('kernel.org.export.current', {}, system)).toEqual(record);
    await expect(runtime.query('kernel.org.export.current', {}, { actor: asUser(owner.id), orgId: org.orgId })).rejects.toMatchObject({ status: 403 });

    // The same bucket still reads: nothing to do.
    expect(await rebindExport({ runtime: workerRuntime, store: original }, org.orgId)).toBe('readable');

    // A restored bucket: the recorded versions are gone, so the export is re-recorded with the new ones.
    const restored = original.restoredCopy('after');
    await expect(readVerified(restored, { key: record.manifestKey, sha256: record.manifestSha256, generation: record.manifestGeneration })).rejects.toThrow(BlobNotFoundError);
    expect(await rebindExport({ runtime: workerRuntime, store: restored }, org.orgId)).toBe('rebound');
    const rebound = await workerRuntime.query<ExportRecord>('kernel.org.export.current', {}, system);
    expect(rebound).toEqual({
      ...record,
      manifestGeneration: expect.stringMatching(/^s3:after-/),
      parts: record.parts.map((p) => ({ ...p, generation: expect.stringMatching(/^s3:after-/) })),
    });
    for (const ref of [{ key: rebound.manifestKey, sha256: rebound.manifestSha256, generation: rebound.manifestGeneration }, ...rebound.parts]) {
      expect(sha256Hex(await readVerified(restored, ref))).toBe(ref.sha256);
    }
    // A new audit row by the restore, the old one untouched; a second run finds nothing to do.
    const audits = await withAdmin(async (admin) =>
      (await admin.query<{ actor_type: string; generation: string }>(
        `SELECT actor_type, detail->>'manifest_generation' AS generation FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.export.record' ORDER BY occurred_at, id`,
        [org.orgId],
      )).rows,
    );
    expect(audits).toEqual([
      { actor_type: 'system', generation: record.manifestGeneration },
      { actor_type: 'system', generation: rebound.manifestGeneration },
    ]);
    expect(await rebindExport({ runtime: workerRuntime, store: restored }, org.orgId)).toBe('readable');

    // Bytes that differ from the recorded sha256 are never vouched for.
    const tampered = original.restoredCopy('tampered');
    tampered.versions.set(record.parts[0]!.key, [{ id: 'tampered-x', bytes: new TextEncoder().encode('forged') }]);
    const lines: string[] = [];
    // The export now names the 'after' versions, which this bucket lacks too.
    expect(await rebindExports({ runtime: workerRuntime, store: tampered, log: (l) => lines.push(l) }, [org.orgId, 'not-an-org'])).toBe(1);
    expect(lines).toEqual([
      expect.stringMatching(new RegExp(`org ${org.orgId}: FAILED, the owner must ask for a new export: stored blob does not match its recorded sha256`)),
      '[exports-rebind] not-an-org: not an org id',
    ]);
    // An org without an export.
    const quiet = await orgWithMember('Công ty Chưa xuất');
    expect(await rebindExport({ runtime: workerRuntime, store: restored }, quiet.org.orgId)).toBe('none');

    // An export made before a table was added to EXPORT_TABLES (#1726): its record lacks that table. A new record that
    // lacks a table is refused, but the restore re-records the older export as it was, with the restored versions.
    const added = EXPORT_TABLE_NAMES.at(-1)!;
    const older = { ...record, parts: record.parts.filter((p) => p.table !== added) };
    await expect(workerRuntime.execute('kernel.org.export.record', older, system)).rejects.toMatchObject({ code: 'VALIDATION' });
    await withAdmin((admin) =>
      admin.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, actor_type, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, 'system', 'kernel.org.export.record', gen_random_uuid(), 'ok', repeat('0', 64), $2::jsonb)`,
        [
          org.orgId,
          JSON.stringify({
            format: older.format,
            manifest_key: older.manifestKey,
            manifest_sha256: older.manifestSha256,
            manifest_generation: older.manifestGeneration,
            file_count: older.fileCount,
            encryption: older.encryption,
            expires_at: older.expiresAt,
            parts: older.parts,
          }),
        ],
      ),
    );
    expect(await workerRuntime.query('kernel.org.export.current', {}, system)).toEqual(older);
    expect(await rebindExport({ runtime: workerRuntime, store: original.restoredCopy('older') }, org.orgId)).toBe('rebound');
    expect(await workerRuntime.query<ExportRecord>('kernel.org.export.current', {}, system)).toEqual({
      ...older,
      manifestGeneration: expect.stringMatching(/^s3:older-/),
      parts: older.parts.map((p) => ({ ...p, generation: expect.stringMatching(/^s3:older-/) })),
    });
    // The owner's view lists the tables that export holds, not the one added since.
    const view = await runtime.query<OrgExportView>('kernel.org.export.get', {}, { actor: asUser(owner.id), orgId: org.orgId });
    expect(view.export?.tables.map((t) => t.table)).toEqual(EXPORT_TABLE_NAMES.filter((t) => t !== added));
    // A rebind is that export, but for its versions: other rows, another part or no export at all are refused.
    const current = (await workerRuntime.query<ExportRecord>('kernel.org.export.current', {}, system))!;
    const changed = { ...current, rebind: true as const, parts: current.parts.map((p, i) => (i === 0 ? { ...p, rows: p.rows + 1 } : p)) };
    await expect(workerRuntime.execute('kernel.org.export.record', changed, system)).rejects.toMatchObject({ code: 'EXPORT_REBIND_MISMATCH' });
    await expect(workerRuntime.execute('kernel.org.export.record', { ...record, rebind: true }, system)).rejects.toMatchObject({ code: 'EXPORT_REBIND_MISMATCH' });
    const elsewhere = {
      ...record,
      rebind: true as const,
      manifestKey: exportKey(quiet.org.orgId, record.manifestSha256),
      parts: record.parts.map((p) => ({ ...p, key: exportKey(quiet.org.orgId, p.sha256) })),
    };
    await expect(workerRuntime.execute('kernel.org.export.record', elsewhere, { ...system, orgId: quiet.org.orgId })).rejects.toMatchObject({
      code: 'EXPORT_REBIND_MISMATCH',
    });

    // The purge takes an export's own record as its date, never a restore's re-record (#1726, review of #1864): the
    // owner asks for a fresh export, a restore then re-records the old one, and the fresh export never comes. The purge
    // still waits for it.
    const purgeState = () =>
      withAdmin(async (admin) => {
        const refusal = (await admin.query<{ r: string | null }>('SELECT ludy_kernel.org_purge_refusal($1, 30) AS r', [org.orgId])).rows[0]?.r;
        const check = (await admin.query<{ exported_at: Date }>('SELECT exported_at FROM ludy_kernel.org_purge_check($1)', [org.orgId])).rows[0];
        const own = (
          await admin.query<{ at: Date }>(
            `SELECT max(occurred_at) AS at FROM ludy_kernel.audit_event
             WHERE org_id = $1 AND command = 'kernel.org.export.record' AND outcome = 'ok' AND NOT detail ? 'rebind'`,
            [org.orgId],
          )
        ).rows[0]?.at;
        return { refusal, exportedAt: check?.exported_at.toISOString(), own: own?.toISOString() };
      });
    await runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId });
    expect(await rebindExport({ runtime: workerRuntime, store: original.restoredCopy('again') }, org.orgId)).toBe('rebound');
    const state = await purgeState();
    expect(state.refusal).toBe('export_pending');
    expect(state.exportedAt).toBe(state.own);

    // A rebind waits for an export record in flight and then sees it (#1867): it never re-records the older export over
    // one committed while it read. The database owner stands in for the export job: it takes the org's export lock,
    // records a newer export, and commits only once the rebind is waiting.
    const before = (await workerRuntime.query<ExportRecord>('kernel.org.export.current', {}, system))!;
    const job = new pg.Client({ connectionString: adminUrl });
    await job.connect();
    try {
      await job.query('BEGIN');
      await job.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ludy_kernel.org_export:' || $1, 0))`, [org.orgId]);
      await job.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, actor_type, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, 'system', 'kernel.org.export.record', gen_random_uuid(), 'ok', repeat('0', 64), $2::jsonb)`,
        [
          org.orgId,
          JSON.stringify({
            format: before.format,
            manifest_key: before.manifestKey,
            manifest_sha256: before.manifestSha256,
            manifest_generation: before.manifestGeneration,
            file_count: before.fileCount,
            encryption: before.encryption,
            expires_at: new Date(Date.parse(before.expiresAt) + 86_400_000).toISOString(),
            parts: before.parts,
          }),
        ],
      );
      const rebinding = workerRuntime.execute('kernel.org.export.record', { ...before, rebind: true }, system).then(
        () => 'recorded',
        (error: { code?: string }) => error.code,
      );
      // The rebind is waiting on the lock.
      for (let tries = 0; ; tries++) {
        const waiting = await withAdmin(
          async (admin) => (
            await admin.query<{ n: string }>(
              `SELECT count(*) AS n FROM pg_catalog.pg_locks
               WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())`,
            )
          ).rows[0]?.n,
        );
        if (Number(waiting) > 0) break;
        if (tries > 100) throw new Error('the rebind never waited for the export lock');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await job.query('COMMIT');
      expect(await rebinding).toBe('EXPORT_REBIND_MISMATCH');
    } finally {
      await job.end();
    }

    // A record whose transaction began before another of the org's records that took the lock first would sort under
    // it (occurred_at is its transaction's start): it is refused, and recording in a new transaction comes after it.
    // A row dated after this transaction's start stands for that other record. Only the rows that stand for an export
    // count, those the purge check reads (system, crove.org-export.v2; #1883): a future-dated row of another format or
    // none refuses nothing and hides nothing. These rows stay in this case's own org, which no later case uses (each makes its own).
    const latest = (await workerRuntime.query<ExportRecord>('kernel.org.export.current', {}, system))!;
    const plant = (detail: Record<string, unknown>) =>
      withAdmin((admin) =>
        admin.query(
          `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, command, command_id, outcome, input_sha256, detail)
           VALUES ($1, now() + interval '1 hour', 'system', 'kernel.org.export.record', gen_random_uuid(), 'ok', repeat('0', 64), $2::jsonb)`,
          [org.orgId, JSON.stringify(detail)],
        ),
      );
    await plant({});
    await plant({ format: 'crove.org-export.v1' });
    await expect(workerRuntime.execute('kernel.org.export.record', record, system)).resolves.toEqual({ ok: true });
    // Nor do they hide the export: the current export and the owner's view read the same rows.
    expect(await workerRuntime.query('kernel.org.export.current', {}, system)).toEqual(record);
    const shown = await runtime.query<OrgExportView>('kernel.org.export.get', {}, { actor: asUser(owner.id), orgId: org.orgId });
    expect(shown.export?.manifestGeneration).toBe(record.manifestGeneration);
    await plant({ format: 'crove.org-export.v2' });
    await expect(workerRuntime.execute('kernel.org.export.record', record, system)).rejects.toMatchObject({ code: 'EXPORT_RECORD_STALE' });
    await expect(workerRuntime.execute('kernel.org.export.record', { ...latest, rebind: true }, system)).rejects.toMatchObject({ code: 'EXPORT_RECORD_STALE' });
  });

  it('runs a streamed query in one REPEATABLE READ, READ ONLY transaction that may idle while the sink works', async () => {
    const { org } = await orgWithMember('Công ty Luồng');
    const probe = defineQuery({
      name: 'kernel.test.stream_probe',
      input: z.object({}),
      access: 'system',
      stream: true,
      handler: async (ctx, _input, sink) => {
        const { rows } = await sql<Record<string, string>>`
          SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only,
                 current_setting('idle_in_transaction_session_timeout') AS idle`.execute(ctx.trx);
        await sink?.(rows[0]);
        return 'done';
      },
    });
    const probing = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ queries: [probe] });
    const seen: unknown[] = [];
    await expect(probing.stream('kernel.test.stream_probe', {}, { actor: { type: 'system', component: 'test' }, orgId: org.orgId }, async (b) => {
      seen.push(b);
    })).resolves.toBe('done');
    expect(seen).toEqual([{ isolation: 'repeatable read', read_only: 'on', idle: '10min' }]);
    // A plain query refuses it, and stream() refuses a query that does not stream.
    await expect(probing.query('kernel.test.stream_probe', {}, { actor: { type: 'system', component: 'test' }, orgId: org.orgId })).rejects.toMatchObject({ code: 'STREAM_ONLY' });
    await expect(workerRuntime.stream('kernel.org.export.live_keys', {}, { actor: { type: 'system', component: 'test' }, orgId: org.orgId }, async () => {})).rejects.toMatchObject({
      code: 'NOT_STREAMED',
    });
  });

  it('streams a large table in bounded chunks from one snapshot, and expires the download', async () => {
    const { org, owner } = await orgWithMember('Công ty Lớn');
    await runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId });
    const ROWS = 250_000;
    // Synthetic parties, written as the database owner (test data only).
    await withAdmin((admin) =>
      admin.query(`INSERT INTO ludy_kernel.party (org_id, name, tax_code) SELECT $1, 'Nhà cung cấp ' || g, lpad(g::text, 10, '0') FROM generate_series(1, $2) g`, [org.orgId, ROWS]),
    );
    // Wraps the export's stream to watch the batches and to write while it reads: a party added after the snapshot
    // began must not appear in the export.
    let maxBatch = 0;
    let sneaked = false;
    // The export uses the runtime's stream and execute only; the runtime itself is frozen, so they are wrapped here
    // (#1766).
    const watching = {
      execute: workerRuntime.execute.bind(workerRuntime),
      stream: undefined as unknown as Runtime['stream'],
    } as unknown as Runtime & { stream: Runtime['stream'] };
    watching.stream = (name, input, options, sink) =>
      workerRuntime.stream(name, input, options, async (batch) => {
        const b = batch as { table: string; lines: string[] };
        maxBatch = Math.max(maxBatch, b.lines.length);
        if (!sneaked && b.table === 'kernel.tenant') {
          sneaked = true;
          await withAdmin((admin) => admin.query(`INSERT INTO ludy_kernel.party (org_id, name) VALUES ($1, 'Sau ảnh chụp')`, [org.orgId]));
        }
        await sink(batch);
      });
    const chunkBytes = 4 * 1024 * 1024;
    const started = Date.now();
    const record = await runOrgExport({ runtime: watching, store, sealer }, org.orgId, { chunkBytes });
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(maxBatch).toBeLessThanOrEqual(1000);
    const parties = record.parts.filter((p) => p.table === 'kernel.party');
    expect(parties.length).toBeGreaterThan(1);
    expect(parties.map((p) => p.chunk)).toEqual(parties.map((_, i) => i));
    expect(parties.every((p) => p.bytes <= chunkBytes)).toBe(true);
    expect(parties.reduce((n, p) => n + p.rows, 0)).toBe(ROWS);

    const users = new Map<string, AuthUser>([[owner.id, { userId: owner.id, email: '', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null }]]);
    const app = createHttpApp({
      config: loadConfig({
        DATABASE_URL: appUrl,
        AUTH_JWT_SECRET: 'test-only-jwt-secret-for-export-0123456789',
        AUTH_ISSUER: 'test-auth',
        WEB_DIST: '/nonexistent',
        EXPORT_ENCRYPTION_KEY: exportKeyBytes.toString('base64'),
      }),
      runtime,
      store,
      authenticate: async (header) => users.get(String(header).replace('Bearer ', ''))!,
      pool,
      aiEnabled: false,
    });
    const response = await app.request('/api/org-export/kernel.party', { headers: { authorization: `Bearer ${owner.id}`, 'x-ludy-org': org.slug } });
    expect(response.status).toBe(200);
    expect(Number(response.headers.get('content-length'))).toBe(parties.reduce((n, p) => n + p.bytes, 0));
    const text = await response.text();
    const names = new Set<string>();
    let count = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const row = JSON.parse(line) as { name: string };
      names.add(row.name);
      count++;
    }
    expect(count).toBe(ROWS);
    expect(names.size).toBe(ROWS);
    expect(names.has('Sau ảnh chụp')).toBe(false);

  }, 120_000);

  it('exports published transcript segments, results, action items, and readers for shared unexpired meetings only, and enforces worker-only SQL guards (#3388)', async () => {
    const other = await orgWithMember('Công ty Họp Khác');
    const { org, owner, member } = await orgWithMember('Công ty Họp Xuất');
    const adminUser = await newUser('meeting-admin');
    await withAdmin((c) =>
      c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [org.orgId, adminUser.id]),
    );
    await runtime.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.id), orgId: org.orgId });

    const orgSharedId = randomUUID();
    const orgKeepForeverId = randomUUID();
    const orgExpiredTodayId = randomUUID();
    const orgExpiredYesterdayId = randomUUID();
    const attendeesOnlyId = randomUUID();
    const foreignOrgMeetingId = randomUUID();

    const ids = {
      sharedSeg1: randomUUID(),
      sharedSeg2: randomUUID(),
      sharedSegDraft: randomUUID(),
      foreverSeg: randomUUID(),
      expiredTodaySeg: randomUUID(),
      expiredYesterdaySeg: randomUUID(),
      attendeesSeg: randomUUID(),
      foreignSeg: randomUUID(),
      sharedResultPub: randomUUID(),
      sharedResultDraft: randomUUID(),
      foreverResultPub: randomUUID(),
      expiredTodayResult: randomUUID(),
      expiredYesterdayResult: randomUUID(),
      attendeesResult: randomUUID(),
      foreignResult: randomUUID(),
      sharedItemSuggested: randomUUID(),
      sharedItemAccepted: randomUUID(),
      sharedItemDraftSuggested: randomUUID(),
      sharedItemDraftAccepted: randomUUID(),
      foreverItemPub: randomUUID(),
      expiredTodayItem: randomUUID(),
      expiredYesterdayItem: randomUUID(),
      attendeesItem: randomUUID(),
      foreignItem: randomUUID(),
      sharedReaderMember: randomUUID(),
      sharedReaderAdmin: randomUUID(),
      foreverReader: randomUUID(),
      expiredTodayReader: randomUUID(),
      expiredYesterdayReader: randomUUID(),
      attendeesReader: randomUUID(),
      foreignReader: randomUUID(),
      acceptedTaskId: randomUUID(),
      audioFileId: randomUUID(),
      videoFileId: randomUUID(),
    };

    const canaries = [
      'CANARY_DRAFT_SEG_ORG',
      'CANARY_DRAFT_SUMMARY_ORG',
      'CANARY_DRAFT_DECISION_ORG',
      'CANARY_DRAFT_ITEM_SUGGESTED',
      'CANARY_DRAFT_ITEM_ACCEPTED',
      'CANARY_EXPIRED_TODAY_SEG',
      'CANARY_EXPIRED_TODAY_RES',
      'CANARY_EXPIRED_TODAY_ITEM',
      'CANARY_EXPIRED_YESTERDAY_SEG',
      'CANARY_EXPIRED_YESTERDAY_RES',
      'CANARY_EXPIRED_YESTERDAY_ITEM',
      'CANARY_ATTENDEES_ONLY',
      'CANARY_FOREIGN_ORG',
    ];

    await withAdmin(async (c) => {
      const vnToday = (await c.query<{ d: string }>("SELECT (pg_catalog.timezone('Asia/Ho_Chi_Minh', pg_catalog.now()))::date::text AS d")).rows[0]!.d;
      const shiftDay = async (days: number) =>
        (await c.query<{ d: string }>('SELECT ($1::date + $2::int)::text AS d', [vnToday, days])).rows[0]!.d;
      const openDay = await shiftDay(30);
      const yesterdayDay = await shiftDay(-1);

      const insertMeeting = async (
        targetOrgId: string,
        meetingId: string,
        recorderId: string,
        visibility: 'org' | 'attendees',
        title: string,
        textRetentionDate: string | null,
      ) => {
        await c.query(
          `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
           VALUES ($1, $2, $3, 'vi', now() - interval '2 hours', now() - interval '1 hour', 3600, $4, $5, 'completed', 'told_at_start', $4, now(), '1.0', $6::date, $7::date)`,
          [targetOrgId, meetingId, title, recorderId, visibility, openDay, textRetentionDate],
        );
      };

      await insertMeeting(org.orgId, orgSharedId, owner.id, 'org', 'Họp công khai toàn công ty', openDay);
      await insertMeeting(org.orgId, orgKeepForeverId, owner.id, 'org', 'Họp lưu lâu dài', null);
      await insertMeeting(org.orgId, orgExpiredTodayId, owner.id, 'org', 'Họp hết hạn hôm nay', vnToday);
      await insertMeeting(org.orgId, orgExpiredYesterdayId, owner.id, 'org', 'Họp hết hạn hôm qua', yesterdayDay);
      await insertMeeting(org.orgId, attendeesOnlyId, member.id, 'attendees', 'CANARY_ATTENDEES_ONLY_TITLE', openDay);
      await insertMeeting(other.org.orgId, foreignOrgMeetingId, other.owner.id, 'org', 'CANARY_FOREIGN_ORG_TITLE', openDay);

      // Readers across org-shared, keep-forever, expired, attendees-only, and foreign meetings.
      await c.query(
        `INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES
         ($1, $2, $3, $4),
         ($1, $5, $3, $6),
         ($1, $7, $8, $4),
         ($1, $9, $10, $4),
         ($1, $11, $12, $4),
         ($1, $13, $14, $15)`,
        [
          org.orgId,
          ids.sharedReaderMember, orgSharedId, member.id,
          ids.sharedReaderAdmin, adminUser.id,
          ids.foreverReader, orgKeepForeverId,
          ids.expiredTodayReader, orgExpiredTodayId,
          ids.expiredYesterdayReader, orgExpiredYesterdayId,
          ids.attendeesReader, attendeesOnlyId, owner.id,
        ],
      );
      await c.query(
        'INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)',
        [other.org.orgId, ids.foreignReader, foreignOrgMeetingId, other.member.id],
      );

      // Transcript segments: published + drafts, open + null + expired + attendees-only + foreign.
      await c.query(
        `INSERT INTO ludy_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage, corrected, tainted, source) VALUES
         ($1, $2, $3, 0, 5, 'Chủ tọa', 'Mở đầu cuộc họp công khai.', 'published', false, false, 'ludy'),
         ($1, $4, $3, 5, 12, 'Thành viên', 'Thống nhất kế hoạch quý tới.', 'published', true, false, 'ludy'),
         ($1, $5, $3, 12, 20, 'Chủ tọa', 'CANARY_DRAFT_SEG_ORG', 'draft', false, true, 'ludy'),
         ($1, $6, $7, 0, 4, 'Chủ tọa', 'Nội dung lưu vô thời hạn.', 'published', false, false, 'ludy'),
         ($1, $8, $9, 0, 4, 'Chủ tọa', 'CANARY_EXPIRED_TODAY_SEG', 'published', false, false, 'ludy'),
         ($1, $10, $11, 0, 4, 'Chủ tọa', 'CANARY_EXPIRED_YESTERDAY_SEG', 'published', false, false, 'ludy'),
         ($1, $12, $13, 0, 4, 'Thành viên', 'CANARY_ATTENDEES_ONLY_SEG', 'published', false, false, 'ludy')`,
        [
          org.orgId,
          ids.sharedSeg1, orgSharedId,
          ids.sharedSeg2,
          ids.sharedSegDraft,
          ids.foreverSeg, orgKeepForeverId,
          ids.expiredTodaySeg, orgExpiredTodayId,
          ids.expiredYesterdaySeg, orgExpiredYesterdayId,
          ids.attendeesSeg, attendeesOnlyId,
        ],
      );
      await c.query(
        `INSERT INTO ludy_meetings.transcript_segment (org_id, id, meeting_id, start_seconds, end_seconds, speaker_label, text, stage, tainted, source)
         VALUES ($1, $2, $3, 0, 4, 'Khác', 'CANARY_FOREIGN_ORG_SEG', 'published', false, 'ludy')`,
        [other.org.orgId, ids.foreignSeg, foreignOrgMeetingId],
      );

      // Results: published + draft.
      await c.query(
        `INSERT INTO ludy_meetings.meeting_result (org_id, id, meeting_id, summary, decisions, feature, stage, tainted) VALUES
         ($1, $2, $3, 'Tóm tắt công khai đã duyệt', '["Chốt ngân sách"]'::jsonb, 'manual', 'published', false),
         ($1, $4, $3, 'CANARY_DRAFT_SUMMARY_ORG', '["CANARY_DRAFT_DECISION_ORG"]'::jsonb, 'meetings.summary', 'draft', true),
         ($1, $5, $6, 'Tóm tắt lưu lâu dài', '["Lưu trữ"]'::jsonb, 'manual', 'published', false),
         ($1, $7, $8, 'CANARY_EXPIRED_TODAY_RES', '[]'::jsonb, 'manual', 'published', false),
         ($1, $9, $10, 'CANARY_EXPIRED_YESTERDAY_RES', '[]'::jsonb, 'manual', 'published', false),
         ($1, $11, $12, 'CANARY_ATTENDEES_ONLY_RES', '[]'::jsonb, 'manual', 'published', false)`,
        [
          org.orgId,
          ids.sharedResultPub, orgSharedId,
          ids.sharedResultDraft,
          ids.foreverResultPub, orgKeepForeverId,
          ids.expiredTodayResult, orgExpiredTodayId,
          ids.expiredYesterdayResult, orgExpiredYesterdayId,
          ids.attendeesResult, attendeesOnlyId,
        ],
      );
      await c.query(
        `INSERT INTO ludy_meetings.meeting_result (org_id, id, meeting_id, summary, decisions, feature, stage, tainted)
         VALUES ($1, $2, $3, 'CANARY_FOREIGN_ORG_RES', '[]'::jsonb, 'manual', 'published', false)`,
        [other.org.orgId, ids.foreignResult, foreignOrgMeetingId],
      );

      // Action items: published suggested, published accepted, draft suggested, draft accepted.
      await c.query(
        `INSERT INTO ludy_meetings.action_item (org_id, id, meeting_id, title, who_drafted, who_parsed, when_drafted, when_parsed, transcript_seconds, stage, status, flags, tainted, task_id, accepted_by, accepted_at) VALUES
         ($1, $2, $3, 'Gửi báo cáo tuần', 'Thành viên', $4, 'Tuần sau', $5::date, 6, 'published', 'suggested', '[]'::jsonb, false, NULL, NULL, NULL),
         ($1, $6, $3, 'Chốt hợp đồng', 'Chủ sở hữu', $7, 'Hôm nay', $5::date, 10, 'published', 'accepted', '["asked_aloud"]'::jsonb, false, $8, $7, now()),
         ($1, $9, $3, 'CANARY_DRAFT_ITEM_SUGGESTED', 'Thành viên', $4, 'Mai', $5::date, 13, 'draft', 'suggested', '[]'::jsonb, true, NULL, NULL, NULL),
         ($1, $10, $3, 'CANARY_DRAFT_ITEM_ACCEPTED', 'Chủ sở hữu', $7, 'Mai', $5::date, 14, 'draft', 'accepted', '[]'::jsonb, false, $8, $7, now()),
         ($1, $11, $12, 'Việc lưu lâu dài', 'Thành viên', $4, 'Tháng sau', $5::date, 2, 'published', 'suggested', '[]'::jsonb, false, NULL, NULL, NULL),
         ($1, $13, $14, 'CANARY_EXPIRED_TODAY_ITEM', 'Thành viên', $4, 'Mai', $5::date, 1, 'published', 'suggested', '[]'::jsonb, false, NULL, NULL, NULL),
         ($1, $15, $16, 'CANARY_EXPIRED_YESTERDAY_ITEM', 'Thành viên', $4, 'Mai', $5::date, 1, 'published', 'suggested', '[]'::jsonb, false, NULL, NULL, NULL),
         ($1, $17, $18, 'CANARY_ATTENDEES_ONLY_ITEM', 'Thành viên', $7, 'Mai', $5::date, 1, 'published', 'suggested', '[]'::jsonb, false, NULL, NULL, NULL)`,
        [
          org.orgId,
          ids.sharedItemSuggested, orgSharedId, member.id, openDay,
          ids.sharedItemAccepted, owner.id, ids.acceptedTaskId,
          ids.sharedItemDraftSuggested,
          ids.sharedItemDraftAccepted,
          ids.foreverItemPub, orgKeepForeverId,
          ids.expiredTodayItem, orgExpiredTodayId,
          ids.expiredYesterdayItem, orgExpiredYesterdayId,
          ids.attendeesItem, attendeesOnlyId,
        ],
      );
      await c.query(
        `INSERT INTO ludy_meetings.action_item (org_id, id, meeting_id, title, stage, status, flags, tainted)
         VALUES ($1, $2, $3, 'CANARY_FOREIGN_ORG_ITEM', 'published', 'suggested', '[]'::jsonb, false)`,
        [other.org.orgId, ids.foreignItem, foreignOrgMeetingId],
      );

      // Audio and video files/segments on the shared meeting: never exported.
      await c.query(
        `INSERT INTO ludy_kernel.file (org_id, id, filename, content_type, size_bytes, sha256, storage_key, source, created_by) VALUES
         ($1, $2, 'meeting-audio.ogg', 'audio/ogg', 100, repeat('a', 64), $3, 'meeting_audio', $4),
         ($1, $5, 'meeting-video.mp4', 'video/mp4', 200, repeat('b', 64), $6, 'meeting_video', $4)`,
        [org.orgId, ids.audioFileId, `org/${org.orgId}/${'a'.repeat(64)}`, owner.id, ids.videoFileId, `org/${org.orgId}/${'b'.repeat(64)}`],
      );
      await c.query(
        'INSERT INTO ludy_meetings.audio_segment (org_id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES ($1, $2, $3, 0, 0, 60)',
        [org.orgId, orgSharedId, ids.audioFileId],
      );
      await c.query(
        'INSERT INTO ludy_meetings.meeting_video (org_id, meeting_id, file_id, length_seconds, video_retention_date) VALUES ($1, $2, $3, 60, $4::date)',
        [org.orgId, orgSharedId, ids.videoFileId, openDay],
      );
    });

    const record = await runOrgExport({ runtime: workerRuntime, store, sealer }, org.orgId);
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const parseLines = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const rowsOf = async (table: string) => {
      const found = record.parts.find((p) => p.table === table)!;
      return parseLines(decode(sealer.open(await store.get(found.key), exportAad(org.orgId, found), 'aes-256-gcm')));
    };

    const transcriptRows = await rowsOf('meetings.transcript_segment');
    expect(transcriptRows.map((r) => r.id).sort()).toEqual([ids.sharedSeg1, ids.sharedSeg2, ids.foreverSeg].sort());
    expect(transcriptRows.filter((r) => r.meeting_id === orgSharedId).map((r) => r.id)).toEqual([ids.sharedSeg1, ids.sharedSeg2]);
    for (const seg of transcriptRows) {
      expect(seg).not.toHaveProperty('search');
    }
    expect(transcriptRows.every((r) => r.stage === 'published')).toBe(true);

    const resultRows = await rowsOf('meetings.result');
    expect(resultRows.map((r) => r.id).sort()).toEqual([ids.sharedResultPub, ids.foreverResultPub].sort());
    expect(resultRows.find((r) => r.id === ids.sharedResultPub)).toMatchObject({
      summary: 'Tóm tắt công khai đã duyệt',
      decisions: ['Chốt ngân sách'],
      stage: 'published',
    });

    const actionItemRows = await rowsOf('meetings.action_item');
    expect(actionItemRows.map((r) => r.id).sort()).toEqual([ids.sharedItemSuggested, ids.sharedItemAccepted, ids.foreverItemPub].sort());
    expect(actionItemRows.find((r) => r.id === ids.sharedItemAccepted)).toMatchObject({ status: 'accepted', stage: 'published' });

    const readerRows = await rowsOf('meetings.reader');
    expect(readerRows.map((r) => r.id).sort()).toEqual([ids.sharedReaderMember, ids.sharedReaderAdmin, ids.foreverReader].sort());

    expect(await rowsOf('meetings.private_count')).toEqual([{ org_id: org.orgId, recorder_user_id: member.id, meetings: 1 }]);
    expect((await rowsOf('kernel.file')).filter((f) => String(f.source).startsWith('meeting_'))).toEqual([]);
    expect(EXPORT_TABLE_NAMES).not.toContain('meetings.audio_segment');
    expect(EXPORT_TABLE_NAMES).not.toContain('meetings.meeting_video');

    // No draft, expired, attendees-only, or foreign-org content leaks into any exported part.
    for (const part of record.parts) {
      const body = decode(sealer.open(await store.get(part.key), exportAad(org.orgId, part), 'aes-256-gcm'));
      for (const canary of canaries) {
        expect(body, `${part.table} leaked ${canary}`).not.toContain(canary);
      }
    }

    // Security & caller guards on all 4 new definer functions:
    // 1) search_path pinned, SECURITY DEFINER, zero PUBLIC execute, strict worker-only EXECUTE ACL.
    const fnNames = [
      'ludy_kernel.meeting_transcript_export_rows()',
      'ludy_kernel.meeting_result_export_rows()',
      'ludy_kernel.meeting_action_item_export_rows()',
      'ludy_kernel.meeting_reader_export_rows()',
    ] as const;
    await withAdmin(async (c) => {
      const dbIds = await resolveDbIdentifiers(adminUrl);
      for (const sig of fnNames) {
        const meta = (
          await c.query<{ prosecdef: boolean; proconfig: string[] | null; pub: boolean }>(
            `SELECT p.prosecdef, p.proconfig, pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS pub
             FROM pg_catalog.pg_proc p WHERE p.oid = $1::regprocedure`,
            [sig],
          )
        ).rows[0]!;
        expect(meta, sig).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], pub: false });

        const { rows: roleRows, activeAllowed } = await auditRoleFunctionExecute(c, dbIds, sig, ['crove_worker'], 'brand');
        expect(roleRows.length, sig).toBeGreaterThan(0);
        for (const allowedRole of activeAllowed) {
          expect(roleRows.some((r) => r.rolname === allowedRole && r.ok), `${allowedRole} on ${sig}`).toBe(true);
        }
        for (const deniedRole of ['ludy_tenant', 'ludy_app', 'ludy_definer_tenant', 'ludy_definer_einvoice']) {
          expect(roleRows.find((r) => r.rolname === deniedRole)?.ok, `${deniedRole} on ${sig}`).toBe(false);
        }
        for (const { rolname, ok, expected } of roleRows) {
          expect(ok, `${rolname} on ${sig}`).toBe(expected);
        }
      }
    });

    // 2) Non-worker SQL callers (ludy_app with/without context) hit PostgreSQL ACL denial (permission denied), and worker outside system context (no context, or agent context) is refused with MEETINGS_WORKER_ONLY (42501).
    const probeAgent = await withAdmin(async (c) => {
      const a = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.agent (org_id, template_key, display_name, created_by)
         VALUES ($1::uuid, 'finance.chief_accountant', 'Export Guard Probe Agent', $2::uuid)
         RETURNING id`,
        [other.org.orgId, other.owner.id],
      );
      const agentId = a.rows[0]!.id;
      const le = await c.query<{ id: string }>(
        'SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1::uuid AND is_default LIMIT 1',
        [other.org.orgId],
      );
      await c.query(
        `INSERT INTO ludy_kernel.position (org_id, title, module, role_key, holder_agent_id, le_scope)
         VALUES ($1::uuid, 'Export Guard Seat', 'finance', 'finance.chief_accountant', $2::uuid, ARRAY[$3::text])`,
        [other.org.orgId, agentId, le.rows[0]!.id],
      );
      const run = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.ai_run (org_id, agent_id, module, status, expires_at)
         VALUES ($1::uuid, $2::uuid, 'finance', 'running', now() + interval '10 minutes')
         RETURNING id`,
        [other.org.orgId, agentId],
      );
      return { agentId, runId: run.rows[0]!.id };
    });

    const callRefused = async (
      connectionString: string,
      setup: ((c: pg.Client) => Promise<void>) | null,
      fn: string,
      messagePattern: RegExp,
    ) => {
      const c = new pg.Client({ connectionString });
      await c.connect();
      try {
        await c.query('BEGIN');
        if (setup) await setup(c);
        await expect(c.query(`SELECT * FROM ${fn}`)).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(messagePattern) });
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    };
    const workerConn = (() => {
      const url = new URL(adminUrl);
      url.username = 'ludy_worker';
      url.password = 'test-worker-pw';
      return url.toString();
    })();
    for (const fn of fnNames) {
      await callRefused(appUrl, null, fn, /permission denied/i);
      await callRefused(
        appUrl,
        (c) => c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [org.orgId, contextToken(owner.id, org.orgId)]).then(() => undefined),
        fn,
        /permission denied/i,
      );
      await callRefused(workerConn, null, fn, /MEETINGS_WORKER_ONLY/);
      await callRefused(
        workerConn,
        (c) => c.query('SELECT ludy_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [other.org.orgId, probeAgent.agentId, probeAgent.runId]).then(() => undefined),
        fn,
        /MEETINGS_WORKER_ONLY/,
      );
    }
  });
});
