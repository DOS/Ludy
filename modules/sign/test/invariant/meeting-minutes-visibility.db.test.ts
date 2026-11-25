// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained PostgreSQL 17 security invariants for @ludy/mod-sign meeting_minutes helpers (#3811, Slice 3a):
//   - Pinned search_path and crove_tenant-only EXECUTE grants on all crove_sign meeting-minutes SECURITY DEFINER functions
//   - Zero existence oracle (404 SIGN_SOURCE_NOT_FOUND) for unknown meeting sources across owner / admin / member
//   - Strict uploader-only confidentiality on unattached sign_document files (even against workspace owners and admins)
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import {
  createOrg,
  kernelCommands,
  kernelManifest,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import { contentGeneration, fileKey, mintContextToken, Runtime, sha256Hex } from '@ludy/kernel-runtime';
import {
  signAiCommands,
  signAiQueries,
  signCommands,
  signManifest,
  signQueries,
} from '../../src/index.ts';
import {
  auditRoleFunctionExecute,
  resolveDbIdentifiers,
  roleUrl,
  setActiveRolePasswords,
  wrapPool,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';

type Pool = ReturnType<typeof createPool>;

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('eSign meeting_minutes module-boundary security invariants (#3811)', () => {
  const dbName = `crove_test_sign_mtg_mod_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: Pool | undefined;
  let appPool: Pool | undefined;
  let workerPool: Pool | undefined;
  let ids!: DbIdentifiers;
  let runtime: Runtime;
  let workerRuntime: Runtime;

  let orgId = '';
  let ownerId = '';
  let adminId = '';
  let memberId = '';
  let viewerId = '';

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asSystem = (component: string) => ({ type: 'system' as const, component });

  async function ingestSignPdf(userId: string, tag: string): Promise<{ fileId: string; sha256: string }> {
    const body = `%PDF-1.4\n% mtg-mod-inv-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`;
    const bytes = Uint8Array.from(Buffer.from(body, 'utf8'));
    const sha256 = sha256Hex(bytes);
    const { fileId } = await runtime.execute<{ fileId: string }>(
      'kernel.file.ingest',
      {
        filename: `${tag}.pdf`,
        contentType: 'application/pdf',
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey: fileKey(orgId, sha256),
        generation: contentGeneration(sha256),
        source: 'sign_document',
      },
      { actor: asUser(userId), orgId },
    );
    return { fileId, sha256 };
  }

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1 });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    ids = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'mtg-mod-app-pw', crove_worker: 'mtg-mod-worker-pw' }, ids);

    adminPool = wrapPool(createPool({ connectionString: adminUrl, max: 2 }), ids);
    appPool = wrapPool(createPool({ connectionString: roleUrl(adminUrl, 'crove_app', 'mtg-mod-app-pw', ids), max: 6 }), ids);
    workerPool = wrapPool(createPool({ connectionString: roleUrl(adminUrl, 'crove_worker', 'mtg-mod-worker-pw', ids), max: 3 }), ids);

    const manifests = [kernelManifest.tables, signManifest.tables];
    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    runtime = new Runtime(appDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: [...signCommands, ...signAiCommands], queries: [...signQueries, ...signAiQueries] });

    workerRuntime = new Runtime(workerDb, { manifests })
      .register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) })
      .register({ commands: [...signCommands, ...signAiCommands], queries: [...signQueries, ...signAiQueries] });

    ownerId = await upsertIdentity(appDb, { issuer: 'mtg-mod', subject: 'owner', email: 'owner@mtg-mod.test', name: 'Owner' });
    adminId = await upsertIdentity(appDb, { issuer: 'mtg-mod', subject: 'admin', email: 'admin@mtg-mod.test', name: 'Admin' });
    memberId = await upsertIdentity(appDb, { issuer: 'mtg-mod', subject: 'member', email: 'member@mtg-mod.test', name: 'Member' });
    viewerId = await upsertIdentity(appDb, { issuer: 'mtg-mod', subject: 'viewer', email: 'viewer@mtg-mod.test', name: 'Viewer' });

    orgId = (await createOrg(runtime, asUser(ownerId), 'Cong ty Bien Ban')).orgId;
    // #4703: once the org setting "Ký biên bản họp" exists it is off by default and the server refuses to create a minutes envelope while it is off. These cases create them, so the org turns it
    // on; before the setting's column exists the update finds no column (42703) and is skipped.
    await adminPool.query('UPDATE crove_kernel.tenant SET meeting_minutes_esign = true WHERE org_id = $1::uuid', [orgId]).catch((error: { code?: string }) => {
      if (error.code !== '42703') throw error;
    });

    await adminPool.query(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES
       ($1::uuid, $2::uuid, 'admin'),
       ($1::uuid, $3::uuid, 'member'),
       ($1::uuid, $4::uuid, 'viewer')`,
      [orgId, adminId, memberId, viewerId],
    );
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = createPool({ connectionString: ADMIN, max: 1 });
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('pins search_path and restricts EXECUTE privileges on all crove_sign meeting-minutes SECURITY DEFINER functions', async () => {
    const fnSignatures = [
      'crove_sign.is_meeting_minutes_reader(uuid,uuid)',
      'crove_sign.is_meeting_minutes_reader_record(uuid,uuid,boolean,uuid[])',
      'crove_sign.has_shared_meeting_minutes(uuid,uuid)',
      'crove_sign.check_meeting_minutes_source(uuid)',
      'crove_sign.can_create_meeting_minutes_envelope(uuid,uuid)',
      'crove_sign.can_access_meeting_minutes_envelope(uuid,uuid,uuid)',
      'crove_sign.can_access_meeting_minutes_envelope_row(uuid,uuid,uuid,text,boolean,uuid[])',
      'crove_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])',
      'crove_sign.is_exportable_envelope(uuid,text,uuid)',
      'crove_sign.is_exportable_envelope_id(uuid,uuid)',
      'crove_sign.is_exportable_sign_file(uuid,uuid,text)',
      'crove_sign.can_attach_confidential_source_file(uuid,uuid,text,uuid,timestamptz,boolean)',
      'crove_sign.can_attach_template_source(uuid,uuid,uuid,text)',
      'crove_sign.can_read_sign_file(uuid)',
      'crove_sign.mint_in_person_signing_token(uuid,uuid,text,timestamptz)',
      'crove_sign.meeting_minutes_revision_raw(uuid,uuid)',
      'crove_sign.meeting_minutes_revision(uuid)',
      'crove_sign.envelope_minutes_revision()',
    ] as const;

    const { rows } = await adminPool!.query<{
      fn: string;
      definer: boolean;
      config: string[];
      public_exec: boolean;
    }>(
      `SELECT p.oid::regprocedure::text AS fn,
              p.prosecdef AS definer,
              p.proconfig AS config,
              pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_catalog.pg_proc p
        WHERE p.oid IN (
          ${fnSignatures.map((sig) => `'${sig}'::regprocedure`).join(',\n          ')}
        )
        ORDER BY 1`,
    );

    const internalOnlyFns = new Set([
      'crove_sign.is_meeting_minutes_reader(uuid,uuid)',
      'crove_sign.is_meeting_minutes_reader_record(uuid,uuid,boolean,uuid[])',
      'crove_sign.has_shared_meeting_minutes(uuid,uuid)',
      'crove_sign.cleanup_meeting_minutes_envelopes(uuid,uuid,boolean,uuid[])',
      'crove_sign.meeting_minutes_revision_raw(uuid,uuid)',
      'crove_sign.envelope_minutes_revision()',
    ]);
    const expectedCallers = ['crove_app', 'crove_definer_tenant', 'crove_tenant', 'crove_worker'] as const;
    const checkedCanonicalRoles = [
      'crove_app',
      'crove_worker',
      'crove_tenant',
      'crove_definer_tenant',
      'crove_auth_reader',
    ] as const;

    expect(rows).toHaveLength(18);
    for (const row of rows) {
      const canonicalFn = ids.toCanonicalTable(row.fn);
      expect(row.definer, canonicalFn).toBe(true);
      expect(row.config, canonicalFn).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(row.public_exec, canonicalFn).toBe(false);
    }

    for (const fn of fnSignatures) {
      const allowedLegacyRoles = internalOnlyFns.has(fn) ? ([] as const) : expectedCallers;
      const { rows: roleRows, activeChecked } = await auditRoleFunctionExecute(
        adminPool!,
        ids,
        fn,
        checkedCanonicalRoles,
        allowedLegacyRoles,
      );
      const presentChecked = new Set(roleRows.map((r) => r.rolname));
      for (const activeRole of activeChecked) {
        expect(presentChecked.has(activeRole), `${fn} resolved ${activeRole}`).toBe(true);
      }
      for (const roleRow of roleRows) {
        expect(roleRow.ok, `${roleRow.rolname} execute ${fn}`).toBe(roleRow.expected);
      }
    }
  });

  it('refuses unknown meeting_minutes sources with 404 and isolates unattached member sign_document files from owners and admins', async () => {
    const { fileId: memberUnattachedFile } = await ingestSignPdf(memberId, `unattached-${randomUUID()}`);

    // Pre-create unattached sign_document uploaded by a member (e.g. an attendees-only meeting recorder)
    // cannot be downloaded or hijacked by a workspace owner or admin before envelope attachment!
    for (const callerId of [ownerId, adminId, viewerId]) {
      await expect(
        runtime.query('kernel.file.get', { id: memberUnattachedFile }, { actor: asUser(callerId), orgId }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    }
    for (const callerId of [ownerId, adminId]) {
      await expect(
        runtime.execute(
          'sign.envelope.create',
          { title: 'Hijack Unattached Member File', sourceKind: 'standalone', sourceFileId: memberUnattachedFile },
          { actor: asUser(callerId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_FILE_NOT_FOUND', status: 404 });
      await expect(
        runtime.execute(
          'sign.template.create',
          { title: 'Hijack Unattached Member File Template', sourceFileId: memberUnattachedFile },
          { actor: asUser(callerId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_FILE_NOT_FOUND', status: 404 });
    }

    // Uploader itself CAN read its own unattached sign_document.
    const ownRead = await runtime.query<{ id: string }>(
      'kernel.file.get',
      { id: memberUnattachedFile },
      { actor: asUser(memberId), orgId },
    );
    expect(ownRead.id).toBe(memberUnattachedFile);

    // Missing sourceId on meeting_minutes -> 422 SIGN_INVALID_SOURCE.
    await expect(
      runtime.execute(
        'sign.envelope.create',
        { title: 'Missing Source ID', sourceKind: 'meeting_minutes', sourceFileId: memberUnattachedFile },
        { actor: asUser(memberId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_INVALID_SOURCE', status: 422 });

    // Unknown meeting sourceId -> identical 404 SIGN_SOURCE_NOT_FOUND for owner, admin, and member!
    const unknownMeetingId = randomUUID();
    const { fileId: ownerFile } = await ingestSignPdf(ownerId, `owner-${randomUUID()}`);
    const { fileId: adminFile } = await ingestSignPdf(adminId, `admin-${randomUUID()}`);

    for (const [callerId, fileId] of [
      [ownerId, ownerFile],
      [adminId, adminFile],
      [memberId, memberUnattachedFile],
    ] as const) {
      await expect(
        runtime.execute(
          'sign.envelope.create',
          {
            title: 'Unknown Meeting Minutes',
            sourceKind: 'meeting_minutes',
            sourceId: unknownMeetingId,
            sourceFileId: fileId,
          },
          { actor: asUser(callerId), orgId },
        ),
      ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });
    }

    // Template instantiate also returns 404 SIGN_SOURCE_NOT_FOUND for unknown meeting_minutes source.
    const { fileId: tplFile } = await ingestSignPdf(ownerId, `tpl-${randomUUID()}`);
    const tpl = await runtime.execute<{ templateId: string }>(
      'sign.template.create',
      { title: 'Minutes Signoff Template', sourceFileId: tplFile },
      { actor: asUser(ownerId), orgId },
    );
    await workerRuntime.execute(
      'sign.template.inspect_complete',
      {
        templateId: tpl.templateId,
        outcome: 'passed',
        pageCount: 1,
        pageDimensions: [{ page: 1, widthPt: 595, heightPt: 842, rotation: 0 }],
      },
      { actor: asSystem('sign-worker'), orgId },
    );
    await runtime.execute(
      'sign.template.roles_set',
      {
        templateId: tpl.templateId,
        roles: [{ roleKey: 'recorder', roleLabel: 'Recorder', signerRole: 'signer', routingOrder: 1, deliveryMode: 'link' }],
      },
      { actor: asUser(ownerId), orgId },
    );
    await runtime.execute(
      'sign.template.fields_set',
      {
        templateId: tpl.templateId,
        fields: [{ roleKey: 'recorder', fieldType: 'signature', pageNumber: 1, xNorm: 0.1, yNorm: 0.7, wNorm: 0.25, hNorm: 0.08 }],
      },
      { actor: asUser(ownerId), orgId },
    );
    await runtime.execute('sign.template.update', { templateId: tpl.templateId, status: 'active' }, { actor: asUser(ownerId), orgId });

    await expect(
      runtime.execute(
        'sign.template.instantiate',
        {
          templateId: tpl.templateId,
          sourceKind: 'meeting_minutes',
          sourceId: unknownMeetingId,
          recipients: [{ roleKey: 'recorder', name: 'Owner', deliveryMode: 'link' }],
        },
        { actor: asUser(ownerId), orgId },
      ),
    ).rejects.toMatchObject({ code: 'SIGN_SOURCE_NOT_FOUND', status: 404 });

    // Table CHECK constraint refuses NULL source_id even for superuser / system writes.
    await expect(
      adminPool!.query(
        `INSERT INTO crove_sign.envelope (
           org_id, title, status, routing_mode, source_kind, source_id,
           source_file_id, source_storage_key, source_generation, source_sha256,
           inspect_status, created_by
         ) VALUES ($1::uuid, 'Null Source', 'draft', 'parallel', 'meeting_minutes', NULL, $2::uuid, 'k', 'content:1', $3, 'pending', $4::uuid)`,
        [orgId, ownerFile, 'a'.repeat(64), ownerId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // Direct SQL check under crove_app: meeting_minutes_insert RLS refuses unshared / unknown meeting sources.
    const client = await appPool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [
        orgId,
        mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
          userId: ownerId,
          orgId,
          sessionId: null,
          aal: 'aal1',
          mfaAt: null,
        }),
      ]);
      await client.query('SAVEPOINT sp_rls_src');
      await expect(
        client.query(
          `INSERT INTO crove_sign.envelope (
             org_id, title, status, routing_mode, source_kind, source_id,
             source_file_id, source_storage_key, source_generation, source_sha256,
             inspect_status, created_by
           ) VALUES ($1::uuid, 'Unshared Source', 'draft', 'parallel', 'meeting_minutes', $2::uuid, $3::uuid, 'k', 'content:1', $4, 'pending', $5::uuid)`,
          [orgId, unknownMeetingId, ownerFile, 'a'.repeat(64), ownerId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT sp_rls_src');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
