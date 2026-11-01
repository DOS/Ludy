// SPDX-License-Identifier: AGPL-3.0-only
// The crm module's stage editing and the board (#2226, docs/plan/crm.md step K2) on PostgreSQL 17: who edits the
// pipeline, the rules it keeps (at most 12 stages, one open at least, Won and Lost last, no removing a stage that holds
// deals), and the board's columns, counts, sums and order. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes
// its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Board, Deal, PipelineStage } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('crm stages and board on PostgreSQL (#2226)', () => {
  const dbName = `crove_test_crm_board_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@crm.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const other = await person('other');
    const viewer = await person('viewer');
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, member, other, viewer]),
    );
    const party = (name: string) =>
      admin((c) => c.query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => r.rows[0]!.id));
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => rt.query<T>(command, input, { actor: asUser(user), orgId });
    const stages = () => exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
    const stageNamed = async (name: string) => (await stages()).find((s) => s.name === name)!;
    const newDeal = (user: string, partyId: string, over: Record<string, unknown> = {}) =>
      exec<Deal>(user, 'crm.deal.create', { partyId, title: 'Gói kế toán năm', amount: '15000000', expectedClose: '2026-12-31', ...over });
    const board = () => query<Board>(owner, 'crm.deal.board', {});
    return { orgId, owner, member, other, viewer, party, exec, query, stages, stageNamed, newDeal, board };
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
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

  it('lets owners and admins edit the open stages, and keeps Won and Lost last', async () => {
    const o = await org();
    const base = await o.stages();
    await expect(o.exec(o.member, 'crm.stage.add', { name: 'Ký hợp đồng' })).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.viewer, 'crm.stage.rename', { stageId: base[0]!.id, name: 'x' })).rejects.toMatchObject({ status: 403 });

    const added = await o.exec<PipelineStage[]>(o.owner, 'crm.stage.add', { name: '  Ký   hợp đồng ' });
    expect(added.map((s) => [s.name, s.kind, s.position])).toEqual([
      ['Mới', 'open', 1],
      ['Đã liên hệ', 'open', 2],
      ['Báo giá', 'open', 3],
      ['Thương lượng', 'open', 4],
      ['Ký hợp đồng', 'open', 5],
      ['Thắng', 'won', 6],
      ['Thua', 'lost', 7],
    ]);
    const renamed = await o.exec<PipelineStage[]>(o.owner, 'crm.stage.rename', { stageId: added[4]!.id, name: 'Chốt' });
    expect(renamed[4]!.name).toBe('Chốt');
    // Won and Lost may be renamed too, and keep their kind.
    expect((await o.exec<PipelineStage[]>(o.owner, 'crm.stage.rename', { stageId: added[5]!.id, name: 'Đã chốt' }))[5]).toMatchObject({ name: 'Đã chốt', kind: 'won' });
    await expect(o.exec(o.owner, 'crm.stage.rename', { stageId: randomUUID(), name: 'x' })).rejects.toMatchObject({ code: 'STAGE_NOT_FOUND' });
    await expect(o.exec(o.owner, 'crm.stage.add', { name: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });

    const open = renamed.filter((s) => s.kind === 'open').map((s) => s.id);
    const swapped = [open[1]!, open[0]!, ...open.slice(2)];
    const reordered = await o.exec<PipelineStage[]>(o.owner, 'crm.stage.reorder', { stageIds: swapped });
    expect(reordered.map((s) => s.id)).toEqual([...swapped, added[5]!.id, added[6]!.id]);
    expect(reordered.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // Every open stage once, and nothing else.
    await expect(o.exec(o.owner, 'crm.stage.reorder', { stageIds: swapped.slice(1) })).rejects.toMatchObject({ code: 'STAGE_ORDER_INVALID' });
    await expect(o.exec(o.owner, 'crm.stage.reorder', { stageIds: [...swapped.slice(1), swapped[1]!] })).rejects.toMatchObject({ code: 'STAGE_ORDER_INVALID' });
    await expect(o.exec(o.owner, 'crm.stage.reorder', { stageIds: [...swapped.slice(1), added[5]!.id] })).rejects.toMatchObject({ code: 'STAGE_ORDER_INVALID' });
  });

  it('caps the pipeline at 12 stages and keeps one open stage', async () => {
    const o = await org();
    await o.stages();
    for (let i = 0; i < 6; i++) await o.exec(o.owner, 'crm.stage.add', { name: `Thêm ${i}` });
    await expect(o.exec(o.owner, 'crm.stage.add', { name: 'Quá nhiều' })).rejects.toMatchObject({ code: 'PIPELINE_FULL' });
    const stages = await o.stages();
    expect(stages).toHaveLength(12);
    const open = stages.filter((s) => s.kind === 'open');
    for (const s of open.slice(1)) await o.exec(o.owner, 'crm.stage.remove', { stageId: s.id });
    await expect(o.exec(o.owner, 'crm.stage.remove', { stageId: open[0]!.id })).rejects.toMatchObject({ code: 'LAST_OPEN_STAGE' });
    const left = await o.stages();
    expect(left.map((s) => [s.kind, s.position])).toEqual([['open', 1], ['won', 2], ['lost', 3]]);
    await expect(o.exec(o.owner, 'crm.stage.remove', { stageId: left[1]!.id })).rejects.toMatchObject({ code: 'STAGE_CLOSING' });
  });

  it('does not remove a stage that holds deals, and closes the gap when it removes one', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const báoGiá = await o.stageNamed('Báo giá');
    const deal = await o.newDeal(o.owner, party, { stageId: báoGiá.id });
    await expect(o.exec(o.owner, 'crm.stage.remove', { stageId: báoGiá.id })).rejects.toMatchObject({ code: 'STAGE_HAS_DEALS', status: 409 });
    await o.exec(o.owner, 'crm.deal.move', { dealId: deal.id, version: deal.version, stageId: (await o.stageNamed('Mới')).id });
    const after = await o.exec<PipelineStage[]>(o.owner, 'crm.stage.remove', { stageId: báoGiá.id });
    expect(after.map((s) => [s.name, s.position])).toEqual([['Mới', 1], ['Đã liên hệ', 2], ['Thương lượng', 3], ['Thắng', 4], ['Thua', 5]]);
    // Another org's stages are out of reach.
    const p = await org();
    await p.stages();
    await expect(p.exec(p.owner, 'crm.stage.remove', { stageId: after[0]!.id })).rejects.toMatchObject({ code: 'STAGE_NOT_FOUND' });
  });

  it('builds the board: a column per stage with its deals in order, counts and exact sums', async () => {
    const o = await org();
    expect((await o.board()).columns).toEqual([]);
    const party = await o.party('Công ty ABC');
    const mới = (await o.stageNamed('Mới')).id;
    const báoGiá = (await o.stageNamed('Báo giá')).id;
    const thắng = (await o.stageNamed('Thắng')).id;
    const thua = (await o.stageNamed('Thua')).id;
    const a = await o.newDeal(o.member, party, { title: 'A', amount: '10000000.10' });
    const b = await o.newDeal(o.member, party, { title: 'B', amount: '20000000.20' });
    const c = await o.newDeal(o.member, party, { title: 'C', amount: '30000000.30' });
    await o.exec(o.member, 'crm.deal.move', { dealId: c.id, version: c.version, stageId: mới, beforeDealId: a.id });
    await o.exec(o.member, 'crm.deal.move', { dealId: b.id, version: b.version, stageId: báoGiá });
    const won = await o.newDeal(o.member, party, { title: 'Thắng', amount: '5000000' });
    await o.exec(o.member, 'crm.deal.move', { dealId: won.id, version: won.version, stageId: thắng });
    const old = await o.newDeal(o.member, party, { title: 'Thua cũ', amount: '7000000' });
    const lost = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: old.id, version: old.version, stageId: thua });
    // A deal closed more than 30 days ago is left off the lost column and its totals.
    await admin((cl) => cl.query("UPDATE crove_crm.deal SET closed_at = now() - interval '31 days' WHERE org_id = $1 AND id = $2", [o.orgId, lost.id]));

    const columns = (await o.query<Board>(o.viewer, 'crm.deal.board', {})).columns;
    expect(columns.map((col) => col.stage.name)).toEqual(['Mới', 'Đã liên hệ', 'Báo giá', 'Thương lượng', 'Thắng', 'Thua']);
    const col = (name: string) => columns.find((x) => x.stage.name === name)!;
    expect(col('Mới').cards.map((d) => d.title)).toEqual(['C', 'A']);
    expect(col('Mới')).toMatchObject({ count: 2, total: '40000000.40', truncated: false });
    expect(col('Báo giá')).toMatchObject({ count: 1, total: '20000000.20' });
    expect(col('Đã liên hệ')).toMatchObject({ count: 0, total: '0', cards: [] });
    expect(col('Thắng')).toMatchObject({ count: 1, total: '5000000.00' });
    expect(col('Thua')).toMatchObject({ count: 0, total: '0', cards: [] });
    expect(col('Mới').cards[0]).toMatchObject({ partyName: 'Công ty ABC', stageKind: 'open', canDelete: false });
    // Another org sees none of it.
    const p = await org();
    await p.stages();
    expect((await p.board()).columns.every((x) => x.count === 0)).toBe(true);
  });
});

