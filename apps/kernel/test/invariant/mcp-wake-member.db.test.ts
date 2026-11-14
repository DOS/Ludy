// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up of an MCP grant and the member-bound grant (ADR-0051 decisions 2 and 4, issue #2975, slice 3, step 3c-1). Pinned before a member may set a wake-up
// for their own grant, so each case holds today and must keep holding when that lands:
// - the body of a schedule or a ping for a member-bound grant carries no id of business data, no amount and no text: a date, or nothing, however the row is written;
// - a member who is not an owner or admin never reads, sets, rotates, clears or tests the wake-up of a company grant, nor of another member's grant, and what a read
//   hands back never holds a receiver's address that is not theirs.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes
// its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, DomainError, Runtime, parseVaultKey, type UserActor } from '@crove/kernel-runtime';
import { makeWakeSecret } from '../../src/mcp-wake-setup.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the wake-up of an MCP grant and the member-bound grant (#2975, slice 3, step 3c-1)', () => {
  const dbName = `crove_test_mcp_wake_member_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  const users = { ownerA: '', adminA: '', memberA: '' };
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const TOKEN = `tok_${randomBytes(9).toString('hex')}`;
  const URL_OK = `https://hooks.example.com/ludy/${TOKEN}`;
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
  // A grant row: a company grant, or a member-bound one when `member` is set (the kind and member columns exist since the member-bound grant landed).
  async function insertGrant(userId: string, member = false): Promise<string> {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, clock_timestamp(), now() + interval '30 days', $3, $6, ${member ? '$3' : 'NULL'})`,
        [orgA, id, userId, `oauth-${id}`, `client-${id}`, member ? 'member' : 'company'],
      ),
    );
    return id;
  }
  // The wake-up of a grant, set the way an owner sets it (an owner may set one for a grant of their own, company or member-bound).
  async function setWake(userId: string, grantId: string): Promise<{ secret: string; hint: string }> {
    const made = makeWakeSecret(vault, orgA, grantId);
    await runtime.execute('kernel.mcp.wake.set', { grantId, url: URL_OK, credential: made.credential }, { actor: browser(userId), orgId: orgA });
    return { secret: made.secret, hint: made.credential.hint };
  }
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }

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
    const pool = createPool({ connectionString: url.toString(), max: 6 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: 'in.test' }) });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'mcp-wake-member', subject: key, email: `${key}@mcp-wake-member.test`, name: null });
    }
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgA, users.adminA, users.memberA]);
      await c.query(`UPDATE crove_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1`, [orgA]);
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('accepts for a member-bound grant a schedule with a date and a ping with nothing, and no id of business data, amount or text however the row is written', async () => {
    const grant = await insertGrant(users.adminA, true);
    await setWake(users.adminA, grant);
    const id = randomUUID();
    const head = { id, created_at: '2026-11-12T03:00:00.000Z', org: orgA, grant };
    const bodies: Array<[string, string, unknown, boolean]> = [
      ['a schedule with its date', 'schedule.due', { ...head, type: 'schedule.due', data: { date: '2026-11-12' } }, true],
      ['a ping with nothing', 'ping', { ...head, type: 'ping', data: {} }, true],
      ['a schedule with a party id', 'schedule.due', { ...head, type: 'schedule.due', data: { date: '2026-11-12', party_id: randomUUID() } }, false],
      ['a schedule with a deal id', 'schedule.due', { ...head, type: 'schedule.due', data: { date: '2026-11-12', deal_id: randomUUID() } }, false],
      ['a schedule with an invoice id', 'schedule.due', { ...head, type: 'schedule.due', data: { date: '2026-11-12', invoice_id: randomUUID() } }, false],
      ['a schedule with an amount', 'schedule.due', { ...head, type: 'schedule.due', data: { date: '2026-11-12', amount: '1250000' } }, false],
      ['a schedule with items', 'schedule.due', { ...head, type: 'schedule.due', data: { date: '2026-11-12', items: [] } }, false],
      ['a schedule with text', 'schedule.due', { ...head, type: 'schedule.due', data: { date: '2026-11-12', note: 'gọi lại khách' } }, false],
      ['a schedule with text for the date', 'schedule.due', { ...head, type: 'schedule.due', data: { date: 'thứ hai' } }, false],
      ['a ping with an id', 'ping', { ...head, type: 'ping', data: { party_id: randomUUID() } }, false],
      ['a ping with text', 'ping', { ...head, type: 'ping', data: { note: 'x' } }, false],
    ];
    for (const [name, type, body, ok] of bodies) {
      const row = admin((c) => c.query(`INSERT INTO crove_kernel.agent_wake_delivery (org_id, id, grant_id, type, body) VALUES ($1, $2, $3, $4, $5::jsonb)`, [orgA, id, grant, type, JSON.stringify(body)]));
      if (ok) {
        await row;
        await admin((c) => c.query(`DELETE FROM crove_kernel.agent_wake_delivery WHERE id = $1`, [id]));
      } else {
        await expect(row, name).rejects.toThrow();
      }
    }
  });

  it('keeps a member who is not an owner or admin out of the wake-up of a company grant and of another member\'s grant: no read of its address, no set, rotate, clear or test', async () => {
    const company = await insertGrant(users.ownerA);
    const others = await insertGrant(users.adminA, true);
    const mine = [company, others];
    const secrets: Record<string, string> = {};
    for (const [grant, owner] of [[company, users.ownerA], [others, users.adminA]] as const) secrets[grant] = (await setWake(owner, grant)).secret;
    const asMember = { actor: browser(users.memberA), orgId: orgA };
    for (const grant of mine) {
      const made = makeWakeSecret(vault, orgA, grant);
      const calls: Array<[string, () => Promise<unknown>]> = [
        ['set', () => runtime.execute('kernel.mcp.wake.set', { grantId: grant, url: URL_OK, credential: made.credential }, asMember)],
        ['rotate', () => runtime.execute('kernel.mcp.wake.rotate_secret', { grantId: grant, credential: made.credential }, asMember)],
        ['clear', () => runtime.execute('kernel.mcp.wake.clear', { grantId: grant }, asMember)],
        ['test', () => runtime.execute('kernel.mcp.wake.test', { grantId: grant }, asMember)],
      ];
      for (const [name, call] of calls) {
        const error = await refusal(call());
        expect(error.status, `${name} ${grant}`).toBeGreaterThanOrEqual(401);
        expect(error.status, `${name} ${grant}`).toBeLessThanOrEqual(404);
      }
    }
    // A read answers a refusal or nothing; it never holds the address or a secret of a grant that is not the member's.
    for (const input of [{}, { grantId: company }, { grantId: others }]) {
      const answer = await runtime.query<unknown[]>('kernel.mcp.wake.get', input, asMember).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if ('error' in answer) {
        expect(answer.error).toBeInstanceOf(DomainError);
        expect((answer.error as DomainError).status).toBeLessThanOrEqual(404);
      } else {
        expect(answer.value).toEqual([]);
      }
      expect(JSON.stringify(answer)).not.toContain(TOKEN);
    }
    // And nothing of the member's attempts changed the two wake-ups.
    const rows = await admin((c) => c.query(`SELECT grant_id, enabled FROM crove_kernel.agent_grant_wake WHERE org_id = $1 AND grant_id = ANY($2::uuid[])`, [orgA, mine]));
    expect(rows.rows.map((r: { enabled: boolean }) => r.enabled)).toEqual([true, true]);
    for (const secret of Object.values(secrets)) expect(secret.length).toBeGreaterThan(0);
  });
});
