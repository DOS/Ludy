// SPDX-License-Identifier: AGPL-3.0-only
// The per-line write scopes of an MCP grant (#3858 slice c; ADR-0051 decision 11, owner decision 2026-11-18/19): `ludy.engage.write` and `ludy.ads.draft`, beside `ludy.social.draft`. A grant may HOLD them;
// nothing yet lets it USE them, and what it holds is bounded:
// - the three lists that must agree do: the contract's scope ids, the runtime's write scopes and the database's CHECK on agent_grant; only `ludy.social.draft` has a sealed write context (a scope with none is
//   refused at run time, rule `mcp_scope`, and never run in the read context or another scope's context);
// - a write scope belongs to a company grant that also holds the read scope: the CHECK refuses a write scope alone, on a member grant, or mixed with the member scope, and the grant definer for a member
//   (mcp_member_grant_approve) cannot make one; a company owner or admin can, and a member cannot;
// - a command that declares a new scope is accepted at register() only in the narrow shape of the first (R1, internal, owners and admins), and an MCP grant that holds the scope is still refused it
//   (FORBIDDEN, rule `mcp_scope`) until the scope's context exists; a grant without the scope, and a member-bound grant, are refused too, and the handler never runs;
// - the tool list is filtered by the grant's role and scopes: a tool that names a write scope is listed only for a company grant that holds it, a member grant never sees one, and a tool that is not read
//   only and names no scope is never listed.
// Part of the invariant suite: its fixtures are its own, and it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { MCP_SCOPE_IDS, MCP_WRITE_SCOPE_IDS } from '@ludy/kernel-contract';
import { DomainError, MCP_SCOPES, MCP_WRITE_CONTEXT_SCOPES, MCP_WRITE_SCOPES, Runtime, type UserActor } from '@ludy/kernel-runtime';
import { holdsWriteScope, visibleTools } from '../../src/mcp-endpoint.ts';
import type { ToolDescriptor } from '../../src/mcp-protocol.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ENGAGE = 'ludy.engage.write';
const ADS = 'ludy.ads.draft';
const DRAFT = 'ludy.social.draft';

describe('the lists of MCP scopes agree (#3858 slice c)', () => {
  it('has the same five scopes in the contract and the runtime, the write ones among them, and one write context', () => {
    expect([...MCP_SCOPE_IDS]).toEqual(['ludy.read', 'ludy.member.read', DRAFT, ENGAGE, ADS]);
    expect([...MCP_WRITE_SCOPE_IDS]).toEqual([DRAFT, ENGAGE, ADS]);
    expect([...MCP_WRITE_SCOPES].sort()).toEqual([...MCP_WRITE_SCOPE_IDS].sort());
    // The runtime's list of a grant's scopes is the read scope and the write scopes (the member scope ships dark: no query declares it).
    expect([...MCP_SCOPES].sort()).toEqual(['ludy.read', DRAFT, ENGAGE, ADS].sort());
    // Only the Social draft has a sealed write context: the two new scopes have none, so no command may run under them yet.
    expect([...MCP_WRITE_CONTEXT_SCOPES]).toEqual([DRAFT]);
  });

  it('accepts at register() a command that declares a new scope in the narrow shape of the first, and refuses it in any other', () => {
    const base = { name: 'kernel.test.line', input: z.strictObject({}), risk: 'R1', sideEffect: 'internal', access: ['owner', 'admin'], handler: async () => ({}) };
    for (const scope of [ENGAGE, ADS]) {
      expect(() => new Runtime({} as never, { manifests: TEST_MANIFESTS }).register({ commands: [{ ...base, mcp: { scope } } as never], queries: [] }), scope).not.toThrow();
      for (const bad of [{ risk: 'R2' }, { access: ['owner', 'member'] }, { access: 'system' }, { sensitive: true }, { permission: 'finance.post' }, { extension: { scope: 'meetings.record' } }]) {
        expect(() => new Runtime({} as never, { manifests: TEST_MANIFESTS }).register({ commands: [{ ...base, ...bad, mcp: { scope } } as never], queries: [] }), `${scope} ${JSON.stringify(bad)}`).toThrow();
      }
    }
    // A scope that is not a write scope, or a made-up one, is refused on a command.
    for (const scope of ['ludy.read', 'ludy.member.read', 'ludy.engage.read', 'ludy.write']) {
      expect(() => new Runtime({} as never, { manifests: TEST_MANIFESTS }).register({ commands: [{ ...base, mcp: { scope } } as never], queries: [] }), scope).toThrow();
    }
  });
});

describe('the tool list is filtered by the grant\'s role and scopes (ADR-0051 decision 11)', () => {
  const actor = (kind: 'company' | 'member', scopes: string[]): UserActor => ({ type: 'user', userId: randomUUID(), aal: 'aal1', mcp: { grantId: randomUUID(), clientId: 'c', clientName: 'C', scopes, kind } });
  const tool = (name: string, writeScope?: string, readOnly = true): ToolDescriptor =>
    ({
      name,
      title: name,
      description: name,
      inputSchema: {},
      outputSchema: {},
      annotations: readOnly ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } : { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      argsSchema: z.strictObject({}),
      ...(writeScope ? { writeScope } : {}),
      read: async () => ({}),
      rows: () => 0,
    }) as unknown as ToolDescriptor;
  const all = [tool('read'), tool('social', DRAFT, false), tool('engage', ENGAGE, false), tool('ads', ADS, false), tool('rogue', undefined, false)];
  const names = (who: UserActor) => visibleTools(all, who).map((t) => t.name);

  it('lists a write tool only for a company grant that holds its scope, and never a tool that is neither read only nor scoped', () => {
    expect(names(actor('company', ['ludy.read']))).toEqual(['read']);
    expect(names(actor('company', ['ludy.read', ENGAGE]))).toEqual(['read', 'engage']);
    expect(names(actor('company', ['ludy.read', ADS]))).toEqual(['read', 'ads']);
    expect(names(actor('company', ['ludy.read', DRAFT, ENGAGE, ADS]))).toEqual(['read', 'social', 'engage', 'ads']);
    // The write scope without the read scope still names only what it holds, and the rogue tool is in no list.
    expect(names(actor('company', [ENGAGE]))).toEqual(['read', 'engage']);
  });

  it('shows a member-bound grant no write tool, whatever scopes its row somehow held, and a person (no grant) no scoped tool', () => {
    expect(names(actor('member', ['ludy.read', DRAFT, ENGAGE, ADS]))).toEqual(['read']);
    expect(holdsWriteScope(actor('member', [ENGAGE]), ENGAGE)).toBe(false);
    expect(holdsWriteScope(actor('company', [ENGAGE]), ENGAGE)).toBe(true);
    expect(holdsWriteScope(actor('company', [ENGAGE]), ADS)).toBe(false);
    const person: UserActor = { type: 'user', userId: randomUUID(), aal: 'aal1' };
    expect(visibleTools(all, person).map((t) => t.name)).toEqual(['read']);
  });
});

suite('what the database and the runtime do with a grant that holds a new write scope (#3858 slice c)', () => {
  const dbName = `crove_test_mcp_write_scopes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  const users: Record<string, string> = {};
  const ran: string[] = [];
  const browser = (who: string): UserActor => ({ type: 'user', userId: users[who] as string, aal: 'aal1' });
  const grantActor = (who: string, grantId: string, scopes: readonly string[], kind?: 'company' | 'member'): UserActor => ({
    type: 'user',
    userId: users[who] as string,
    aal: 'aal1',
    mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes, ...(kind ? { kind } : {}) },
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  async function insert(scopes: string[], kind: 'company' | 'member' = 'company', who = 'owner'): Promise<string> {
    const id = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $4, 'Test client', 'client.example.com', $5::text[], $6, now(), now() + interval '30 days', $3, $7, $8)`,
        [orgA, id, users[who], `client-${id}`, scopes, `oauth-${id}`, kind, kind === 'member' ? users[who] : null],
      ),
    );
    return id;
  }
  const refused = (scopes: string[], kind: 'company' | 'member' = 'company') => insert(scopes, kind).then(() => 'accepted', (error: Error) => (/agent_grant_scopes_ck/.test(error.message) ? 'check' : error.message));
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
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    // One command of a line that declares each new scope, in the narrow shape: it must never run while the scope has no sealed write context.
    const line = (name: string, scope: string) => ({
      name,
      input: z.strictObject({}),
      risk: 'R1' as const,
      sideEffect: 'internal' as const,
      access: ['owner', 'admin'] as never,
      mcp: { scope },
      handler: async () => {
        ran.push(name);
        return {};
      },
    });
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, line('kernel.test.engage_write', ENGAGE) as never, line('kernel.test.ads_draft', ADS) as never],
      queries: kernelQueries({ inboundDomain: null }),
    });
    for (const key of ['owner', 'member']) users[key] = await upsertIdentity(db, { issuer: 'mcp-write-scopes', subject: key, email: `${key}@mcp-write-scopes.test`, name: key });
    orgA = (await createOrg(runtime, browser('owner'), 'Org A')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgA, users.member]));
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lets the CHECK hold a write scope on a company grant that also holds the read scope, any mix of the three, and nothing else', async () => {
    for (const scopes of [['ludy.read', ENGAGE], ['ludy.read', ADS], ['ludy.read', DRAFT, ENGAGE, ADS], ['ludy.read', DRAFT, ENGAGE]]) expect(await refused(scopes), scopes.join()).toBe('accepted');
    // A write scope alone, a member grant with one, the member scope on a company grant, a made-up scope, an empty list and a duplicate-laden six all fail.
    for (const scopes of [[ENGAGE], [ADS], [ENGAGE, ADS], [DRAFT, ADS]]) expect(await refused(scopes), scopes.join()).toBe('check');
    for (const scopes of [['ludy.read', ENGAGE], ['ludy.read', ADS], ['ludy.member.read', ENGAGE], ['ludy.read', DRAFT]]) expect(await refused(scopes, 'member'), `member ${scopes.join()}`).toBe('check');
    for (const scopes of [['ludy.read', 'ludy.member.read', ENGAGE], ['ludy.read', 'ludy.engage.read'], ['ludy.read', 'ludy.write'], [], ['ludy.read', ENGAGE, ADS, DRAFT, 'ludy.member.read', 'ludy.read']]) {
      expect(await refused(scopes), scopes.join()).toBe('check');
    }
    // A member grant still holds the read scopes only.
    expect(await refused(['ludy.member.read'], 'member')).toBe('accepted');
    expect(await refused(['ludy.read', 'ludy.member.read'], 'member')).toBe('accepted');
  });

  it('lets an owner approve a company grant with the new scopes through the command, and nobody else, and no member grant', async () => {
    const approve = (who: string, scopes: string[], kind: 'company' | 'member' = 'company', client = `c-${randomUUID()}`) =>
      runtime.execute<{ grantId: string }>('kernel.mcp.grant.approve', { clientId: client, clientName: 'Client', clientHost: 'client.example.com', scopes, oauthGrantId: `og-${randomUUID()}`, kind }, { actor: browser(who), orgId: orgA });
    const made = await approve('owner', ['ludy.read', ENGAGE, ADS]);
    expect((await admin((c) => c.query(`SELECT scopes, kind FROM crove_kernel.agent_grant WHERE id = $1`, [made.grantId]))).rows[0]).toEqual({ scopes: ['ludy.ads.draft', 'ludy.engage.write', 'ludy.read'], kind: 'company' });
    // Write scope without the read scope: invalid. A member: forbidden for the company, and a member grant never carries a write scope.
    expect((await refusal(approve('owner', [ENGAGE]))).status).toBe(422);
    expect((await refusal(approve('member', ['ludy.read', ENGAGE]))).status).toBe(403);
    expect([403, 422]).toContain((await refusal(approve('owner', ['ludy.read', ENGAGE], 'member'))).status);
    expect([403, 422]).toContain((await refusal(approve('member', ['ludy.read', ADS], 'member'))).status);
  });

  it('has no sealed write context for a new scope: the draft entry refuses a grant that holds only the new ones, in the database', async () => {
    const grantId = await insert(['ludy.read', ENGAGE, ADS]);
    const c = new pg.Client({ connectionString: (() => { const u = new URL(adminUrl); u.username = 'crove_app'; u.password = 'test-app-pw'; return u.toString(); })() });
    await c.connect();
    try {
      await c.query('BEGIN');
      await expect(c.query(`SELECT crove_kernel.enter_mcp_company_draft_context($1::uuid, $2::uuid)`, [orgA, grantId])).rejects.toThrow(/MCP_GRANT_SCOPE/);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });

  it('refuses a command that declares a new scope to a grant that holds it, in no context, and never runs the handler; a grant without it and a member grant are refused too', async () => {
    const commands: Array<[string, string]> = [['kernel.test.engage_write', ENGAGE], ['kernel.test.ads_draft', ADS]];
    for (const [name, scope] of commands) {
      const holds = await insert(['ludy.read', scope]);
      const err = await refusal(runtime.execute(name, {}, { actor: grantActor('owner', holds, ['ludy.read', scope], 'company'), orgId: orgA }));
      expect([err.code, err.status, (err as { rule?: unknown }).rule ?? (err.details as { rule?: unknown } | undefined)?.rule], `${name} with its scope`).toEqual(['FORBIDDEN', 403, 'mcp_scope']);
      const without = await insert(['ludy.read']);
      expect((await refusal(runtime.execute(name, {}, { actor: grantActor('owner', without, ['ludy.read'], 'company'), orgId: orgA }))).status, `${name} without it`).toBe(403);
      const memberGrant = await insert(['ludy.member.read'], 'member');
      expect((await refusal(runtime.execute(name, {}, { actor: grantActor('owner', memberGrant, [scope], 'member'), orgId: orgA }))).status, `${name} member grant`).toBe(403);
    }
    expect(ran).toEqual([]);
    // The person's own click on the same commands still runs them (the refusal is the grant's).
    await runtime.execute('kernel.test.engage_write', {}, { actor: browser('owner'), orgId: orgA });
    expect(ran).toEqual(['kernel.test.engage_write']);
  });
});
