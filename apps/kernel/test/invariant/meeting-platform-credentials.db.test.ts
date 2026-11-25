// SPDX-License-Identifier: AGPL-3.0-only
// Why the import state of the meeting platforms lives in crove_kernel and is NOT a way around the meetings-readers rule (meetings integrations C1, issue #3173; Meetings PO, 2026-11-15). The download job must read text (the
// platform's recording id, the provider, the staging key), so the tables are kernel tables and their definers may return text; this file pins that they return ONLY that, and never a title or any other text of a meeting:
// - every definer of crove_kernel named meeting_platform_* returns exactly the columns pinned below (names and types): the worker-facing ones return opaque ids, the provider, the platform's id, enums, sizes, times and
//   the staging key, never the recording's title, a display name or any free text;
// - who may execute each definer is pinned (the worker's, the API login's, or nobody), and the credential table has no grant to any role;
// - the recording's title is a column that only a member's own row-security read can return: no definer of the family selects it;
// - no Crove login reads or writes the sealed credential table directly (the API login and the worker login both get permission denied), and only the worker login can execute the definer that opens a credential.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md). Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import { createDbClient, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// function name -> the result type exactly as pg_get_function_result prints it.
const RETURNS: Readonly<Record<string, string>> = {
  meeting_platform_credential_put: 'void',
  meeting_platform_credential_get: 'TABLE(key_id text, envelope bytea, provider text, external_account text)',
  meeting_platform_credential_drop: 'void',
  meeting_platform_oauth_begin: 'uuid',
  meeting_platform_oauth_consume: 'TABLE(code_verifier text)',
  meeting_platform_sync_due: 'TABLE(org_id uuid, connection_id uuid, provider text)',
  meeting_platform_sync_failed: 'void',
  meeting_platform_system: 'uuid',
  meeting_platform_member: 'uuid',
  meeting_platform_recording_replace: 'integer',
  meeting_platform_recording_begin: 'void',
  meeting_platform_recording_dismiss: 'void',
  meeting_platform_recording_pick: 'void',
  meeting_platform_import_open: 'TABLE(org_id uuid, id uuid, connection_id uuid, provider text, external_id text, has_audio boolean, has_video boolean, size_bytes bigint, staging_key text)',
  meeting_platform_import_staged: 'integer',
  meeting_platform_import_failed: 'integer',
  meeting_platform_import_holds: 'text',
  meeting_platform_import_pick: 'text',
  meeting_platform_recording_claim: 'TABLE(staging_key text, meeting_id uuid, size_bytes bigint)',
  meeting_platform_recording_claim_failed: 'void',
  meeting_platform_recording_imported: 'void',
  meeting_platform_recording_sweep: 'TABLE(staging_key text)',
  meeting_platform_ring: 'integer',
};

// Who may execute each (the roles that hold EXECUTE, and nobody else; the helpers are executable by no login role).
const EXECUTORS: Readonly<Record<string, readonly string[]>> = {
  meeting_platform_credential_put: ['crove_app', 'crove_worker'],
  meeting_platform_credential_get: ['crove_worker'],
  meeting_platform_credential_drop: ['crove_app', 'crove_worker'],
  meeting_platform_oauth_begin: ['crove_app'],
  meeting_platform_oauth_consume: ['crove_app'],
  meeting_platform_sync_due: ['crove_worker'],
  meeting_platform_sync_failed: ['crove_worker'],
  meeting_platform_system: [],
  meeting_platform_member: [],
  meeting_platform_recording_replace: ['crove_worker'],
  meeting_platform_recording_begin: ['crove_app'],
  meeting_platform_recording_dismiss: ['crove_app'],
  meeting_platform_recording_pick: ['crove_app'],
  meeting_platform_import_open: ['crove_worker'],
  meeting_platform_import_staged: ['crove_worker'],
  meeting_platform_import_failed: ['crove_worker'],
  meeting_platform_import_holds: ['crove_worker'],
  meeting_platform_import_pick: ['crove_worker'],
  meeting_platform_recording_claim: ['crove_app'],
  meeting_platform_recording_claim_failed: ['crove_app'],
  meeting_platform_recording_imported: ['crove_app'],
  meeting_platform_recording_sweep: ['crove_worker'],
  meeting_platform_ring: ['crove_app'],
};

// Definers an open PR adds (the two-step landing of the invariant suite: this list first, in a PR of its own, then the PR with the migration moves each one into RETURNS and EXECUTORS above). A name here may be
// absent from the database; when it is there it must return exactly this type and be executable by exactly these roles, and any other function of the family still fails the exact check below.
// meeting_platform_ring (Zoom's webhook doorbell, #3175): clears the last listing of the active connections of one account whose org has Meetings on (it asks org_app_on) so the sweep lists them again, returns only how many; the API login runs it.
// meeting_platform_recording_pick and meeting_platform_import_pick (the Picker route for Google Meet audio, #3174, ADR-0025 amendment of 2026-11-25): the first keeps the Drive file id a member picked on their own row (a Google Meet recording
// that is a video file only, still suggested or failed), the second hands the worker the id of the row that is importing under exactly one staging key; neither returns a title or any text of a meeting (a void and one Drive id).
const PENDING_RETURNS: Readonly<Record<string, string>> = {
  meeting_platform_recording_pick: 'void',
  meeting_platform_import_pick: 'text',
};
const PENDING_EXECUTORS: Readonly<Record<string, readonly string[]>> = {
  meeting_platform_recording_pick: ['crove_app'],
  meeting_platform_import_pick: ['crove_worker'],
};

// A column name that would carry something a person wrote or the platform titled.
const TEXTUAL_NAME = /title|summary|body|text|name|subject|note|transcript|decision|message/i;

suite('meeting platform definers return no meeting text (#3173)', () => {
  const dbName = `crove_test_meeting_platform_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
  }, 120_000);

  afterAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const functions = () =>
    admin((c) =>
      c.query<{ proname: string; result: string; owner_exec: boolean }>(
        `SELECT p.proname, pg_get_function_result(p.oid) AS result, false AS owner_exec
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'crove_kernel' AND p.proname LIKE 'meeting\\_platform\\_%' ORDER BY p.proname`,
      ),
    );

  it('has exactly the pinned definers, each returning exactly its pinned columns', async () => {
    const { rows } = await functions();
    const got = Object.fromEntries(rows.map((r) => [r.proname, r.result]));
    // A pending definer may be absent; when present it is pinned like the others.
    const expected = { ...RETURNS, ...Object.fromEntries(Object.entries(PENDING_RETURNS).filter(([name]) => name in got)) };
    expect(got).toEqual(expected);
  });

  it('returns no text-like column from any worker-facing definer except the pinned technical ones (ids, provider, platform id, staging key, key id)', async () => {
    const { rows } = await functions();
    const technical = new Set(['key_id', 'envelope', 'provider', 'external_account', 'external_id', 'staging_key', 'code_verifier']);
    for (const row of rows) {
      const m = /^TABLE\((.*)\)$/.exec(row.result);
      if (!m) continue;
      for (const column of (m[1] as string).split(',').map((c) => c.trim())) {
        const [name = '', type = ''] = column.split(/\s+/);
        if (!/^(text|jsonb|json|text\[\])$/.test(type)) continue;
        expect(technical.has(name) || !TEXTUAL_NAME.test(name), `${row.proname} returns ${column}`).toBe(true);
        expect(technical.has(name), `${row.proname} returns an unpinned text column ${column}`).toBe(true);
      }
    }
  });

  it('pins who may execute each definer, and no other role (PUBLIC included) can', async () => {
    const roles = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
    const { rows } = await admin((c) =>
      c.query<{ proname: string; role: string; ok: boolean }>(
        `SELECT p.proname, r AS role, has_function_privilege(r, p.oid, 'EXECUTE') AS ok
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace, unnest($1::text[]) r
         WHERE n.nspname = 'crove_kernel' AND p.proname LIKE 'meeting\\_platform\\_%'`,
        [roles],
      ),
    );
    const got: Record<string, string[]> = {};
    for (const r of rows) if (r.ok) (got[r.proname] ??= []).push(r.role);
    for (const name of Object.keys(EXECUTORS)) expect([...(got[name] ?? [])].sort(), name).toEqual([...(EXECUTORS[name] ?? [])].sort());
    // A pending definer that exists is held to its own pin; one that does not exist yet has no executor.
    const present = new Set((await functions()).rows.map((r) => r.proname));
    for (const name of Object.keys(PENDING_EXECUTORS)) expect([...(got[name] ?? [])].sort(), name).toEqual(present.has(name) ? [...(PENDING_EXECUTORS[name] ?? [])].sort() : []);
    const publicExec = await admin((c) =>
      c.query<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'crove_kernel' AND p.proname LIKE 'meeting\\_platform\\_%' AND has_function_privilege('public', p.oid, 'EXECUTE')`,
      ),
    );
    expect(publicExec.rows).toEqual([]);
  });

  it('gives no role any grant on the credential table, and no definer of the family selects a recording\'s title', async () => {
    const grants = await admin((c) =>
      c.query<{ grantee: string }>(`SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_schema = 'crove_kernel' AND table_name = 'meeting_platform_credential'`),
    );
    expect(grants.rows.map((r) => r.grantee).filter((g) => g !== 'postgres')).toEqual([]);
    const sources = await admin((c) =>
      c.query<{ proname: string; src: string }>(
        `SELECT p.proname, p.prosrc AS src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'crove_kernel' AND p.proname LIKE 'meeting\\_platform\\_%' AND p.proname <> 'meeting_platform_recording_replace'`,
      ),
    );
    // Only the sweep's writer (recording_replace) names the title column, and only to write it; no other definer's body mentions it.
    expect(sources.rows.filter((r) => /\btitle\b/.test(r.src.replace(/--.*$/gm, ''))).map((r) => r.proname)).toEqual([]);
  });

  it('lets no Crove login touch the sealed credential table: the API login and the worker login both get permission denied', async () => {
    for (const [role, password] of [['crove_app', 'test-app-pw'], ['crove_worker', 'test-worker-pw']] as const) {
      const url = new URL(adminUrl);
      url.username = dbIds ? dbIds.roleName(role) : role;
      url.password = password;
      const client = createDbClient({ connectionString: url.toString() }, dbIds);
      await client.connect();
      try {
        for (const statement of [
          'SELECT * FROM crove_kernel.meeting_platform_credential',
          'INSERT INTO crove_kernel.meeting_platform_credential (org_id, id, key_id, envelope) VALUES (gen_random_uuid(), gen_random_uuid(), \'k\', \'\\x00\')',
          'UPDATE crove_kernel.meeting_platform_credential SET key_id = \'x\'',
          'DELETE FROM crove_kernel.meeting_platform_credential',
        ]) {
          await expect(client.query(statement), `${role}: ${statement}`).rejects.toMatchObject({ code: '42501' });
        }
        // Only the worker login may execute the definer that opens a credential; the API login is refused before any context is read.
        const call = client.query('SELECT * FROM crove_kernel.meeting_platform_credential_get(gen_random_uuid())');
        if (role === 'crove_app') await expect(call).rejects.toMatchObject({ code: '42501' });
        else await expect(call).rejects.toMatchObject({ message: 'NO_CONTEXT' });
      } finally {
        await client.end();
      }
    }
  });
});
