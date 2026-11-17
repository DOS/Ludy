// SPDX-License-Identifier: AGPL-3.0-only
// Invariant for #1679 (Notes N10): DB trigger b_taint (crove_notes.note_taint_guard) enforces that tainted
// notes can only clear tainted = false by their own author and only alongside a real change to title or body.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { notesCommands, notesQueries } from '@crove/mod-notes';
import { contextToken } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('Notes DB taint guard invariant (crove_notes.note_taint_guard, #1679)', () => {
  const dbName = `crove_test_notes_taint_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let authorId = '';
  let otherId = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function asTenant<T>(userId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const res = await fn(c);
      await c.query('COMMIT');
      return res;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await c.end();
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });

    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);

    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...notesQueries],
    });

    const ownerId = await upsertIdentity(db, { issuer: 'taint-inv', subject: 'owner', email: 'owner@taint.test', name: null });
    authorId = await upsertIdentity(db, { issuer: 'taint-inv', subject: 'author', email: 'author@taint.test', name: null });
    otherId = await upsertIdentity(db, { issuer: 'taint-inv', subject: 'other', email: 'other@taint.test', name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId: ownerId, aal: 'aal1' }, 'Taint Invariant Org')).orgId;
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, authorId, otherId]),
    );
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('rejects clearing taint without editing title/body, rejects non-author taint updates, and allows clearing on author content edit', async () => {
    const noteId = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_notes.note (org_id, id, author_user_id, visibility, title, body, tags, tainted)
         VALUES ($1, $2, $3, 'org', 'Tóm tắt ban đầu', 'Nội dung ban đầu', ARRAY[]::text[], true)`,
        [orgId, noteId, authorId],
      ),
    );

    // Author updating tainted = false without editing title/body (including metadata-only updates) fails with NOTES_TAINT_EDIT_REQUIRED.
    await expect(
      asTenant(authorId, (c) => c.query(`UPDATE crove_notes.note SET tainted = false WHERE org_id = $1 AND id = $2`, [orgId, noteId])),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('NOTES_TAINT_EDIT_REQUIRED') });

    await expect(
      asTenant(authorId, (c) =>
        c.query(`UPDATE crove_notes.note SET tags = ARRAY['pilot'], pinned = true, tainted = false WHERE org_id = $1 AND id = $2`, [orgId, noteId]),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('NOTES_TAINT_EDIT_REQUIRED') });

    // Non-author tenant update affects 0 rows (RLS), while an out-of-author-context update to tainted is blocked by NOTES_TAINT_AUTHOR_ONLY.
    const nonAuthorRes = await asTenant(otherId, (c) =>
      c.query(`UPDATE crove_notes.note SET title = 'Sửa ngoài tác giả', tainted = false WHERE org_id = $1 AND id = $2`, [orgId, noteId]),
    );
    expect(nonAuthorRes.rowCount).toBe(0);

    await expect(
      admin((c) =>
        c.query(`UPDATE crove_notes.note SET title = 'Sửa ngoài ngữ cảnh tác giả', tainted = false WHERE org_id = $1 AND id = $2`, [orgId, noteId]),
      ),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('NOTES_TAINT_AUTHOR_ONLY') });

    // Author editing body (or title) in the same UPDATE cleanly clears tainted = false.
    const cleared = await asTenant(authorId, (c) =>
      c.query<{ tainted: boolean }>(
        `UPDATE crove_notes.note SET body = 'Nội dung đã rà soát', tainted = false WHERE org_id = $1 AND id = $2 RETURNING tainted`,
        [orgId, noteId],
      ),
    );
    expect(cleared.rows[0]?.tainted).toBe(false);
  });
});
