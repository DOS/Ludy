// SPDX-License-Identifier: AGPL-3.0-only
// `crm.signals.won_deals`, the CRM's side of the first cross-app rule (Vy V4, #2967), on PostgreSQL 17: the deals in the won stage as ids, the Vietnam day they were won and
// their amount, for every role the CRM lists, with no text a person typed; open and lost deals are not listed; the answer is the contract's and nothing else.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { zCrmWonDealSignals, type CrmWonDealSignal, type Deal, type PipelineStage } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
// A title and a party name that name a person: neither may reach the answer.
const SECRET_TITLE = 'Hợp đồng bí mật của anh Bình 4242';
const SECRET_PARTY = 'Công ty bí mật của chị Lan';

suite('crm.signals.won_deals on PostgreSQL (#2967)', () => {
  const dbName = `crove_test_crm_won_signals_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@won.test`, name: null }) as Promise<string>;

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [member, viewer] = [await person('member'), await person('viewer')];
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]);
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const signals = (user: string) => rt.query<CrmWonDealSignal[]>('crm.signals.won_deals', {}, { actor: asUser(user), orgId });
    const party = (name: string) => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    const stageNamed = async (name: string) => ((await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {})).find((s) => s.name === name) as PipelineStage);
    const newDeal = (partyId: string, amount = '15000000') => exec<Deal>(owner, 'crm.deal.create', { partyId, title: SECRET_TITLE, amount, expectedClose: null });
    const moveTo = async (deal: Deal, stage: string, lostReason?: string) =>
      exec<Deal>(owner, 'crm.deal.move', { dealId: deal.id, version: deal.version, stageId: (await stageNamed(stage)).id, ...(lostReason ? { lostReason } : {}) });
    // Sets the instant the deal was won (a superuser's statement: the command stamps now).
    const wonAt = (dealId: string, at: string) => rows('UPDATE crove_crm.deal SET closed_at = $3::timestamptz WHERE org_id = $1 AND id = $2', [orgId, dealId, at]);
    return { orgId, owner, member, viewer, exec, signals, party, stageNamed, newDeal, moveTo, wonAt };
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists the won deals as id, party, Vietnam day and amount, and not an open or a lost one', async () => {
    const o = await org();
    const p = await o.party(SECRET_PARTY);
    const won = await o.moveTo(await o.newDeal(p, '2500000.50'), 'Thắng');
    await o.newDeal(p);
    await o.moveTo(await o.newDeal(p), 'Thua', 'Giá cao');
    // Won at 18:30 UTC on the 10th: half past one in the morning of the 11th in Vietnam.
    await o.wonAt(won.id, '2026-11-10T18:30:00Z');
    const list = await o.signals(o.member);
    expect(list).toEqual([{ dealId: won.id, partyId: p, wonOn: '2026-11-11', amount: '2500000.50' }]);
    expect(zCrmWonDealSignals.safeParse(list).success).toBe(true);
  });

  it('answers the same to every role the CRM lists and to nobody who is not a user', async () => {
    const o = await org();
    const won = await o.moveTo(await o.newDeal(await o.party('A')), 'Thắng');
    for (const user of [o.owner, o.member, o.viewer]) expect((await o.signals(user)).map((r) => r.dealId), user).toEqual([won.id]);
    await expect(rt.query('crm.signals.won_deals', {}, { actor: { type: 'system', component: 'test' }, orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('answers an empty list when no deal is won, and lists the latest wins first', async () => {
    const o = await org();
    const p = await o.party('A');
    expect(await o.signals(o.owner)).toEqual([]);
    const older = await o.moveTo(await o.newDeal(p), 'Thắng');
    const newer = await o.moveTo(await o.newDeal(p), 'Thắng');
    await o.wonAt(older.id, '2026-10-01T05:00:00Z');
    await o.wonAt(newer.id, '2026-11-01T05:00:00Z');
    expect((await o.signals(o.owner)).map((r) => r.dealId)).toEqual([newer.id, older.id]);
  });

  it('carries no text a person typed, and no key outside the contract', async () => {
    const o = await org();
    await o.moveTo(await o.newDeal(await o.party(SECRET_PARTY)), 'Thắng');
    const list = await o.signals(o.owner);
    const text = JSON.stringify(list);
    expect(text).not.toContain('bí mật');
    expect(text).not.toContain('4242');
    for (const row of list) expect(Object.keys(row).sort()).toEqual(['amount', 'dealId', 'partyId', 'wonOn']);
  });

  it('lists at most 500 deals, the most recently won', async () => {
    const o = await org();
    const p = await o.party('A');
    const stage = await o.stageNamed('Thắng');
    await rows(
      `INSERT INTO crove_crm.deal (org_id, id, party_id, title, amount, stage_id, sort_key, created_by, updated_by, closed_at)
       SELECT $1, gen_random_uuid(), $2, 't', 1, $3, 'a' || lpad(g::text, 6, '0'), $4, $4, now() - make_interval(mins => g) FROM generate_series(1, 502) g`,
      [o.orgId, p, stage.id, o.owner],
    );
    const list = await o.signals(o.owner);
    expect(list).toHaveLength(500);
  });

  it('shows one org only its own deals', async () => {
    const a = await org();
    const b = await org();
    const mine = await a.moveTo(await a.newDeal(await a.party('A')), 'Thắng');
    await b.moveTo(await b.newDeal(await b.party('B')), 'Thắng');
    expect((await a.signals(a.owner)).map((r) => r.dealId)).toEqual([mine.id]);
    expect(await b.signals(b.owner)).toHaveLength(1);
  });
});
