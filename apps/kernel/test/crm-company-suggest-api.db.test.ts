// SPDX-License-Identifier: AGPL-3.0-only
// The sales coworker's company suggestion through the API (#2438, PR 3) on PostgreSQL 17, with a recorded model: the deterministic companies come first whatever the
// model does, the model orders only the names that carry the word of the person's domain and is shown only the person's name, that word and those names, the org's
// switch for AI on its customers' words keeps every name from the model while it is off (and the answer says so), a deployment with no model answers off, a viewer is
// refused, and a flood of calls is answered busy, never as an error. Nothing is stored. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import type { CompanySuggested } from '@crove/kernel-contract';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { Runtime, type BlobStore } from '@crove/kernel-runtime';
import { InboxReader, type CompanyRankGenerator } from '@crove/agent';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-company-suggest-0123456';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}
const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@suggest.test`, session: randomUUID(), userId: '' });

suite('the company a person may work at, through the API (#2438, PR 3)', () => {
  const dbName = `crove_test_company_suggest_api_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let apps: Record<'on' | 'noAi', ReturnType<typeof createHttpApp>>;
  // The recorded model: what it was asked, and the order it answers next (the default: the order it was given).
  const asked: Parameters<CompanyRankGenerator>[0][] = [];
  const answers: number[][] = [];
  const companyRank: CompanyRankGenerator = async (args) => {
    asked.push(args);
    return { output: { order: answers.shift() ?? [1, 2, 3, 4, 5, 6, 7, 8] }, usage: { inputTokens: 10, outputTokens: 4 } };
  };
  const owner = account('owner');
  const viewer = account('viewer');
  let org = { slug: '', orgId: '' };
  const urlFor = (user: string, password: string) => {
    const u = new URL(adminUrl);
    u.username = user;
    u.password = password;
    return u.toString();
  };
  async function rows<T extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(text, params)).rows;
    } finally {
      await c.end();
    }
  }
  async function tokenFor(who: Account) {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }
  async function rpc(path: string, who: Account, input: unknown, options: { slug?: string | null; app?: keyof typeof apps } = {}) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const response = await apps[options.app ?? 'on'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }
  const party = async (kind: 'person' | 'organization', name: string, email: string | null = null) =>
    (await rows<{ id: string }>('INSERT INTO crove_kernel.party (org_id, kind, name, email) VALUES ($1, $2, $3, $4) RETURNING id', [org.orgId, kind, name, email]))[0]?.id as string;
  const suggest = (who: Account, partyId: string, app: keyof typeof apps = 'on') => rpc('crm/contacts/companySuggestions', who, { partyId }, { app });
  const names = (body: CompanySuggested) => body.candidates.map((c) => [c.name, c.reason]);
  let nam = '';

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = urlFor('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...crmCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries],
    });
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const reader = new InboxReader({ baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' }, { companyRank });
    const make = (conversationReader?: InboxReader) =>
      createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: createAuthenticator(config, db), pool, aiEnabled: true, ...(conversationReader ? { conversationReader } : {}) });
    apps = { on: make(reader), noAi: make() };
    for (const who of [owner, viewer]) {
      const me = await rpc('me/get', who, undefined, { slug: null });
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', owner, { name: 'Cửa hàng Gợi Ý', idempotencyKey: randomUUID() }, { slug: null });
    expect(created.status).toBe(200);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [org.orgId, viewer.userId]);
    await party('organization', 'Công ty Acme Domain', 'lienhe@acme.vn');
    await party('organization', 'Acme Logistics');
    await party('organization', 'Công ty Acme Foods');
    await party('organization', 'Công ty Không Liên Quan', 'info@khac.vn');
    nam = await party('person', 'Nam Trần', 'nam.tran@acme.vn');
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('shows the domain company first and the model’s order of the names after it, asking the model for the names only', async () => {
    answers.push([2, 1]);
    const before = asked.length;
    const answer = await suggest(owner, nam);
    expect(answer.status).toBe(200);
    // "Acme Logistics" (1) and "Công ty Acme Foods" (2), by name: the model puts the second first.
    expect(names(answer.body)).toEqual([
      ['Công ty Acme Domain', 'email_domain'],
      ['Công ty Acme Foods', 'name'],
      ['Acme Logistics', 'name'],
    ]);
    expect(answer.body.ai).toBe('used');
    expect(asked.length).toBe(before + 1);
    // What the model was shown: the person's name, the word, and the two names; nothing of the domain company, the addresses or the org.
    const prompt = asked.at(-1)?.prompt ?? '';
    expect(prompt).toContain('Nam Trần');
    expect(prompt).toContain('acme');
    expect(prompt).toContain('1. Acme Logistics\n2. Công ty Acme Foods');
    for (const secret of ['Công ty Acme Domain', 'lienhe@acme.vn', 'nam.tran@acme.vn', 'Không Liên Quan', 'Cửa hàng Gợi Ý']) expect(prompt).not.toContain(secret);
    // Nothing is stored or linked by asking.
    expect((await rows<{ company_id: string | null }>('SELECT company_id FROM crove_kernel.party WHERE id = $1', [nam]))[0]?.company_id).toBeNull();
  });

  it('keeps every name from the model while the org’s switch for AI on its customers’ words is off, answers off, and still shows the companies', async () => {
    expect((await rpc('conversations/setAutoDraft', viewer, { autoDraft: false })).status).toBe(403);
    expect((await rpc('conversations/setAutoDraft', owner, { autoDraft: false })).status).toBe(200);
    const before = asked.length;
    const off = await suggest(owner, nam);
    expect(off.status).toBe(200);
    expect(off.body.ai).toBe('off');
    expect(names(off.body)).toEqual([
      ['Công ty Acme Domain', 'email_domain'],
      ['Acme Logistics', 'name'],
      ['Công ty Acme Foods', 'name'],
    ]);
    // The model was asked nothing and shown nothing.
    expect(asked.length).toBe(before);
    expect((await rpc('conversations/setAutoDraft', owner, { autoDraft: true })).status).toBe(200);
  });

  it('answers off when the deployment has no model, refuses a viewer, and finds no person of another org', async () => {
    const quiet = await suggest(owner, nam, 'noAi');
    expect(quiet.body.ai).toBe('off');
    expect(quiet.body.candidates).toHaveLength(3);
    expect((await suggest(viewer, nam)).status).toBe(403);
    expect((await suggest(owner, randomUUID())).status).toBe(404);
  });

  it('answers busy, never an error, when a member asks more than the budget allows', async () => {
    const states = new Set<string>();
    const before = asked.length;
    for (let i = 0; i < 20; i += 1) {
      const answer = await suggest(owner, nam);
      expect(answer.status).toBe(200);
      states.add(answer.body.ai);
      // Every answer, busy or not, holds the companies.
      expect(answer.body.candidates.length).toBe(3);
    }
    expect([...states].sort()).toEqual(['busy', 'used']);
    // At most the budget's twelve a minute reached the model (this test and the first one are the only callers in the minute).
    expect(asked.length - before).toBeLessThanOrEqual(12);
  });
});
