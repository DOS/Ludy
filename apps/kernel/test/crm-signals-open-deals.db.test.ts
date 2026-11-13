// SPDX-License-Identifier: AGPL-3.0-only
// `crm.signals.open_deals`, the CRM's side of rule 2 (Vy V5, #2969), on PostgreSQL 17: the deals still in play (a stage that is neither won nor lost) as a deal id and a party id,
// for every role the CRM lists, with no text a person typed and no amount; won and lost deals are not listed; the answer is the contract's and nothing else.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { zCrmOpenDealSignals, type CrmOpenDealSignal, type Deal, type PipelineStage } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
// A title and a party name that name a person: neither may reach the answer.
const SECRET_TITLE = 'Hợp đồng bí mật của anh Bình 4242';
const SECRET_PARTY = 'Công ty bí mật của chị Lan';

suite('crm.signals.open_deals on PostgreSQL (#2969)', () => {
  const dbName = `crove_test_crm_open_signals_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const signals = (user: string) => rt.query<CrmOpenDealSignal[]>('crm.signals.open_deals', {}, { actor: asUser(user), orgId });
    const party = (name: string) => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    const stageNamed = async (name: string) => ((await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {})).find((s) => s.name === name) as PipelineStage);
    const newDeal = (partyId: string, amount = '15000000') => exec<Deal>(owner, 'crm.deal.create', { partyId, title: SECRET_TITLE, amount, expectedClose: null });
    const moveTo = async (deal: Deal, stage: string, lostReason?: string) =>
      exec<Deal>(owner, 'crm.deal.move', { dealId: deal.id, version: deal.version, stageId: (await stageNamed(stage)).id, ...(lostReason ? { lostReason } : {}) });
    return { orgId, owner, member, viewer, exec, signals, party, stageNamed, newDeal, moveTo };
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

  it('lists the open deals as a deal id and a party id, in every open stage, and not a won or a lost one', async () => {
    const o = await org();
    const p = await o.party(SECRET_PARTY);
    const q = await o.party('Công ty B');
    const first = await o.newDeal(p);
    const moved = await o.moveTo(await o.newDeal(q), 'Đã liên hệ');
    await o.moveTo(await o.newDeal(p), 'Thắng');
    await o.moveTo(await o.newDeal(p), 'Thua', 'Giá cao');
    const list = await o.signals(o.member);
    expect(list.map((r) => r.dealId).sort()).toEqual([first.id, moved.id].sort());
    expect(list.find((r) => r.dealId === moved.id)).toEqual({ dealId: moved.id, partyId: q });
    expect(zCrmOpenDealSignals.safeParse(list).success).toBe(true);
  });

  it('answers the same to every role the CRM lists and to nobody who is not a user', async () => {
    const o = await org();
    const deal = await o.newDeal(await o.party('A'));
    for (const user of [o.owner, o.member, o.viewer]) expect((await o.signals(user)).map((r) => r.dealId), user).toEqual([deal.id]);
    await expect(rt.query('crm.signals.open_deals', {}, { actor: { type: 'system', component: 'test' }, orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('answers an empty list when no deal is open, and a deal moved back to open is listed again', async () => {
    const o = await org();
    const p = await o.party('A');
    expect(await o.signals(o.owner)).toEqual([]);
    const won = await o.moveTo(await o.newDeal(p), 'Thắng');
    expect(await o.signals(o.owner)).toEqual([]);
    await o.moveTo(won, 'Mới');
    expect((await o.signals(o.owner)).map((r) => r.dealId)).toEqual([won.id]);
  });

  it('carries no text a person typed, no amount, and no key outside the contract', async () => {
    const o = await org();
    await o.newDeal(await o.party(SECRET_PARTY), '987654321');
    const list = await o.signals(o.owner);
    const text = JSON.stringify(list);
    expect(text).not.toContain('bí mật');
    expect(text).not.toContain('4242');
    expect(text).not.toContain('987654321');
    for (const row of list) expect(Object.keys(row).sort()).toEqual(['dealId', 'partyId']);
  });

  it('lists at most 500 deals', async () => {
    const o = await org();
    const p = await o.party('A');
    const stage = await o.stageNamed('Mới');
    await rows(
      `INSERT INTO crove_crm.deal (org_id, id, party_id, title, amount, stage_id, sort_key, created_by, updated_by)
       SELECT $1, gen_random_uuid(), $2, 't', 1, $3, 'a' || lpad(g::text, 6, '0'), $4, $4 FROM generate_series(1, 502) g`,
      [o.orgId, p, stage.id, o.owner],
    );
    expect(await o.signals(o.owner)).toHaveLength(500);
  });

  it('shows one org only its own deals', async () => {
    const a = await org();
    const b = await org();
    const mine = await a.newDeal(await a.party('A'));
    await b.newDeal(await b.party('B'));
    expect((await a.signals(a.owner)).map((r) => r.dealId)).toEqual([mine.id]);
    expect(await b.signals(b.owner)).toHaveLength(1);
  });
});
