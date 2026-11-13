// SPDX-License-Identifier: AGPL-3.0-only
// The member-bound MCP grant, pinned before it exists (ADR-0051 decision 2, last bullet; design note on #2975, slice 3, step 3a). Every case holds now and must
// keep holding when the member-bound grant lands, so this file passes today and bites the moment the migration does:
// - a company grant (one an owner or admin consented to for the company) carries no member, and nobody but an owner or admin can make one;
// - a member or a viewer cannot consent to any grant while the org has not turned member grants on (the switch is off by default and, today, absent);
// - when the grant carries a `kind` (the step that follows), the database holds the rules itself: a company grant has no member, a member grant's member is
//   its consenting user, and the private scope belongs to a member grant alone. Until then the column is absent and these checks have nothing to say.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, type UserActor } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the member-bound MCP grant, before and after it exists (#2975, slice 3)', () => {
  const dbName = `crove_test_mcp_member_grant_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  const users = { ownerA: '', adminA: '', memberA: '', viewerA: '' };

  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  const consent = (userId: string, scopes: string[] = ['ludy.read']) =>
    runtime.execute<{ grantId: string }>(
      'kernel.mcp.grant.approve',
      { clientId: `client-${randomUUID()}`, clientName: 'Test client', clientHost: 'client.example.com', scopes, oauthGrantId: `oauth-${randomUUID()}` },
      { actor: browser(userId), orgId: orgA },
    );

  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }

  // The `kind` column the member-bound grant adds; absent until that migration.
  const hasKind = () =>
    admin((c) => c.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'crove_kernel' AND table_name = 'agent_grant' AND column_name = 'kind'`).then((r) => r.rowCount === 1));

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-member-grant', subject: key, email: `${key}@mcp-member-grant.test`, name: null });
    }
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgA, users.adminA, users.memberA, users.viewerA]),
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets an owner and an admin consent to a company grant, which carries no member', async () => {
    for (const userId of [users.ownerA, users.adminA]) {
      const { grantId } = await consent(userId);
      const row = await admin((c) => c.query(`SELECT member_id, user_id FROM crove_kernel.agent_grant WHERE org_id = $1 AND id = $2`, [orgA, grantId]).then((r) => r.rows[0]));
      expect(row.member_id).toBeNull();
      expect(row.user_id).toBe(userId);
      if (await hasKind()) {
        const kind = await admin((c) => c.query(`SELECT kind FROM crove_kernel.agent_grant WHERE org_id = $1 AND id = $2`, [orgA, grantId]).then((r) => r.rows[0].kind));
        expect(kind).toBe('company');
      }
    }
  });

  it('refuses a member and a viewer any consent while the org has not turned member grants on (off by default)', async () => {
    for (const userId of [users.memberA, users.viewerA]) {
      expect((await refusal(consent(userId))).code).toBe('FORBIDDEN');
      // Not even the private scope, which is not a scope yet (VALIDATION) or belongs to a member grant alone.
      expect((await refusal(consent(userId, ['ludy.read', 'ludy.member.read']))).code).toMatch(/^(FORBIDDEN|INVALID|VALIDATION)$/);
    }
    const stored = await admin((c) => c.query(`SELECT count(*)::int AS n FROM crove_kernel.agent_grant WHERE org_id = $1 AND user_id IN ($2, $3)`, [orgA, users.memberA, users.viewerA]));
    expect(stored.rows[0].n).toBe(0);
  });

  it('keeps the grant\'s own rules in the database once it has a kind: a company grant has no member, a member grant\'s member is its user, the private scope is a member grant\'s', async () => {
    if (!(await hasKind())) {
      // Before the member-bound grant: the member column can hold nothing but NULL.
      await expect(
        admin((c) =>
          c.query(
            `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, expires_at, created_by, member_id)
             VALUES ($1, $2, $3, 'c-1', 'c', 'c.example.com', ARRAY['ludy.read'], 'o-1', now() + interval '1 day', $3, $3)`,
            [orgA, randomUUID(), users.memberA],
          ),
        ),
      ).rejects.toThrow(/check/i);
      return;
    }
    const insert = (kind: string, member: string | null, user: string, scopes: string) =>
      admin((c) =>
        c.query(
          `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, expires_at, created_by, kind, member_id)
           VALUES ($1, $2, $3, $4, 'c', 'c.example.com', ${scopes}, $5, now() + interval '1 day', $3, $6, $7)`,
          [orgA, randomUUID(), user, `c-${randomUUID()}`, `o-${randomUUID()}`, kind, member],
        ),
      );
    const read = "ARRAY['ludy.read']";
    const priv = "ARRAY['ludy.read','ludy.member.read']";
    // A company grant has no member.
    await expect(insert('company', users.memberA, users.memberA, read)).rejects.toThrow(/check/i);
    // A member grant has a member, and it is the consenting user, nobody else.
    await expect(insert('member', null, users.memberA, read)).rejects.toThrow(/check/i);
    await expect(insert('member', users.viewerA, users.memberA, read)).rejects.toThrow(/check/i);
    await expect(insert('member', users.memberA, users.memberA, read)).resolves.toBeDefined();
    // The private scope is a member grant's alone.
    await expect(insert('company', null, users.ownerA, priv)).rejects.toThrow(/check/i);
    await expect(insert('member', users.adminA, users.adminA, priv)).resolves.toBeDefined();
    // Any other kind is refused.
    await expect(insert('guest', null, users.ownerA, read)).rejects.toThrow(/check/i);
  });
});
