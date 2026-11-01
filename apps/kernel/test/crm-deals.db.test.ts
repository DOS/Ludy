// SPDX-License-Identifier: AGPL-3.0-only
// The crm module's deals and pipeline (#2225, docs/plan/crm.md step K1) on PostgreSQL 17: the default stages, who
// creates, edits, moves and deletes a deal, the amount as a decimal string, the order inside a stage, closing and
// reopening, cross-org isolation, and that audit rows and the timeline never hold a title or an amount. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Deal, DealPage, PipelineStage } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('crm deals on PostgreSQL (#2225)', () => {
  const dbName = `crove_test_crm_deals_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const board = async (stageId: string) => (await query<DealPage>(owner, 'crm.deal.list', { stageId })).items;
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

  it('creates the default stages once, in order, with Won and Lost last', async () => {
    const o = await org();
    expect(await o.query<PipelineStage[]>(o.owner, 'crm.stage.list', {})).toEqual([]);
    const [a, b] = await Promise.all([o.stages(), o.exec<PipelineStage[]>(o.member, 'crm.pipeline.setup', {})]);
    expect(a.map((s) => [s.name, s.kind, s.position])).toEqual([
      ['Mới', 'open', 1],
      ['Đã liên hệ', 'open', 2],
      ['Báo giá', 'open', 3],
      ['Thương lượng', 'open', 4],
      ['Thắng', 'won', 5],
      ['Thua', 'lost', 6],
    ]);
    expect(b).toEqual(a);
    expect(await o.query<PipelineStage[]>(o.viewer, 'crm.stage.list', {})).toEqual(a);
    await expect(o.exec(o.viewer, 'crm.pipeline.setup', {})).rejects.toMatchObject({ status: 403 });
  });

  it('creates a deal in the first open stage for a party, with the amount as a decimal string', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(o.member, party, { title: '  Gói   kế toán năm ', amount: '15000000.5' });
    expect(deal).toMatchObject({ partyId: party, partyName: 'Công ty ABC', title: 'Gói kế toán năm', amount: '15000000.50', currency: 'VND', stageKind: 'open', expectedClose: '2026-12-31', ownerUserId: o.member, lostReason: null, closedAt: null, version: 1 });
    expect((await o.stageNamed('Mới')).id).toBe(deal.stageId);
    expect((await o.query<Deal[]>(o.viewer, 'crm.party.deals', { partyId: party })).map((d) => d.id)).toEqual([deal.id]);
    expect(await o.query<Deal>(o.viewer, 'crm.deal.get', { dealId: deal.id })).toEqual({ ...deal, canDelete: false });

    await expect(o.newDeal(o.member, party, { amount: '-5' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.newDeal(o.member, party, { amount: '1.234' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.newDeal(o.member, party, { amount: 15000000 })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.newDeal(o.member, party, { title: '   ' })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(o.newDeal(o.member, randomUUID())).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
    await expect(o.newDeal(o.member, party, { ownerUserId: randomUUID() })).rejects.toMatchObject({ code: 'DEAL_OWNER_INVALID' });
    await expect(o.newDeal(o.member, party, { stageId: (await o.stageNamed('Thắng')).id })).rejects.toMatchObject({ code: 'DEAL_STAGE_CLOSED' });
    await expect(o.newDeal(o.viewer, party)).rejects.toMatchObject({ status: 403 });
  });

  it('edits a deal, refuses a stale version, and keeps the audit row free of the title and the amount', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const other = await o.party('Công ty XYZ');
    const deal = await o.newDeal(o.member, party);
    const edit = { dealId: deal.id, version: deal.version, partyId: other, title: 'Gói kế toán 2 năm', amount: '30000000', expectedClose: null, ownerUserId: o.other };
    const updated = await o.exec<Deal>(o.member, 'crm.deal.update', edit);
    expect(updated).toMatchObject({ partyId: other, partyName: 'Công ty XYZ', title: 'Gói kế toán 2 năm', amount: '30000000.00', expectedClose: null, ownerUserId: o.other, version: 2 });
    await expect(o.exec(o.owner, 'crm.deal.update', edit)).rejects.toMatchObject({ code: 'STALE_VERSION', status: 409 });
    await expect(o.exec(o.viewer, 'crm.deal.update', { ...edit, version: 2 })).rejects.toMatchObject({ status: 403 });

    const { rows } = await admin((c) => c.query("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'crm.deal.update' AND outcome = 'ok' AND target_id = $2", [o.orgId, deal.id]));
    expect(rows).toHaveLength(1);
    const text = JSON.stringify(rows[0].detail);
    expect(text).toContain('title');
    expect(text).not.toContain('Gói kế toán');
    expect(text).not.toContain('30000000');
  });

  it('moves deals between stages and inside one, closing and reopening them', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const mới = (await o.stageNamed('Mới')).id;
    const báoGiá = (await o.stageNamed('Báo giá')).id;
    const thắng = (await o.stageNamed('Thắng')).id;
    const thua = (await o.stageNamed('Thua')).id;
    const d1 = await o.newDeal(o.member, party, { title: 'Một' });
    const d2 = await o.newDeal(o.member, party, { title: 'Hai' });
    const d3 = await o.newDeal(o.member, party, { title: 'Ba' });
    expect((await o.board(mới)).map((d) => d.title).sort()).toEqual(['Ba', 'Hai', 'Một']);
    const order = async (stage: string) => {
      const keys = await admin((c) => c.query<{ title: string }>('SELECT title FROM crove_crm.deal WHERE org_id = $1 AND stage_id = $2 ORDER BY sort_key, id', [o.orgId, stage]));
      return keys.rows.map((r) => r.title);
    };
    expect(await order(mới)).toEqual(['Một', 'Hai', 'Ba']);

    // Inside a stage: d3 before d1, then d1 after d2.
    await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: d3.id, version: d3.version, stageId: mới, beforeDealId: d1.id });
    expect(await order(mới)).toEqual(['Ba', 'Một', 'Hai']);
    const m = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: d1.id, version: d1.version, stageId: mới, afterDealId: d2.id });
    expect(await order(mới)).toEqual(['Ba', 'Hai', 'Một']);
    expect(m.version).toBe(2);

    // To another stage, at the end; then closed as won, which sets closed_at.
    const toQuote = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: d2.id, version: d2.version, stageId: báoGiá });
    expect(toQuote).toMatchObject({ stageId: báoGiá, stageKind: 'open', closedAt: null });
    const won = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: d2.id, version: toQuote.version, stageId: thắng });
    expect(won).toMatchObject({ stageKind: 'won', lostReason: null });
    expect(won.closedAt).not.toBeNull();
    // Lost takes a reason; any other stage refuses one.
    await expect(o.exec(o.member, 'crm.deal.move', { dealId: d1.id, version: m.version, stageId: báoGiá, lostReason: 'giá cao' })).rejects.toMatchObject({ code: 'DEAL_LOST_REASON_INVALID' });
    const lost = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: d1.id, version: m.version, stageId: thua, lostReason: '  Giá   cao ' });
    expect(lost).toMatchObject({ stageKind: 'lost', lostReason: 'Giá cao' });
    expect(lost.closedAt).not.toBeNull();
    // Moving back out reopens it and clears the reason and the close time.
    const reopened = await o.exec<Deal>(o.owner, 'crm.deal.move', { dealId: d1.id, version: lost.version, stageId: mới });
    expect(reopened).toMatchObject({ stageKind: 'open', lostReason: null, closedAt: null });

    // A stale version, an unknown stage and a neighbour that is not in the stage refuse.
    await expect(o.exec(o.owner, 'crm.deal.move', { dealId: d1.id, version: 1, stageId: mới })).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await expect(o.exec(o.owner, 'crm.deal.move', { dealId: d1.id, version: reopened.version, stageId: randomUUID() })).rejects.toMatchObject({ code: 'STAGE_NOT_FOUND' });
    await expect(o.exec(o.owner, 'crm.deal.move', { dealId: d1.id, version: reopened.version, stageId: báoGiá, afterDealId: d3.id })).rejects.toMatchObject({ code: 'DEAL_NEIGHBOUR_INVALID' });
    await expect(o.exec(o.owner, 'crm.deal.move', { dealId: d1.id, version: reopened.version, stageId: mới, beforeDealId: d2.id, afterDealId: d3.id })).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('keeps the close time and the reason when a closed deal is reordered inside its stage', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const thua = (await o.stageNamed('Thua')).id;
    const a = await o.newDeal(o.member, party, { title: 'A' });
    const b = await o.newDeal(o.member, party, { title: 'B' });
    const la = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: a.id, version: a.version, stageId: thua, lostReason: 'Giá cao' });
    const lb = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: b.id, version: b.version, stageId: thua });
    const again = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: lb.id, version: lb.version, stageId: thua, beforeDealId: la.id });
    expect(again).toMatchObject({ closedAt: lb.closedAt, lostReason: null });
    const reordered = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: la.id, version: la.version, stageId: thua, afterDealId: again.id });
    expect(reordered).toMatchObject({ closedAt: la.closedAt, lostReason: 'Giá cao' });
    // A new reason with the same move replaces the old one and keeps the close time.
    const reworded = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: la.id, version: reordered.version, stageId: thua, lostReason: 'Chọn bên khác' });
    expect(reworded).toMatchObject({ closedAt: la.closedAt, lostReason: 'Chọn bên khác' });
  });

  it('tells each caller whether they may delete a deal', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const mine = await o.newDeal(o.member, party, { title: 'Của member' });
    const theirs = await o.newDeal(o.other, party, { title: 'Của other' });
    const flags = async (user: string) => Object.fromEntries((await o.query<Deal[]>(user, 'crm.party.deals', { partyId: party })).map((d) => [d.title, d.canDelete]));
    expect(await flags(o.member)).toEqual({ 'Của member': true, 'Của other': false });
    expect(await flags(o.owner)).toEqual({ 'Của member': true, 'Của other': true });
    expect(await flags(o.viewer)).toEqual({ 'Của member': false, 'Của other': false });
    expect(mine.canDelete).toBe(true);
    // The answer to the creator: it names what the caller may do.
    expect(theirs.canDelete).toBe(true);
  });

  it('keeps the order when many deals are placed at the same spot', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const mới = (await o.stageNamed('Mới')).id;
    const first = await o.newDeal(o.member, party, { title: 'Đầu' });
    // Each goes right after the first: the keys between the same two neighbours grow until the stage is rebalanced.
    const titles: string[] = [];
    for (let i = 0; i < 70; i++) {
      const d = await o.newDeal(o.member, party, { title: `Thêm ${i}` });
      const moved = await o.exec<Deal>(o.member, 'crm.deal.move', { dealId: d.id, version: d.version, stageId: mới, afterDealId: first.id });
      expect(moved.version).toBe(2);
      titles.unshift(`Thêm ${i}`);
    }
    const rows = await admin((c) => c.query<{ title: string; sort_key: string }>('SELECT title, sort_key FROM crove_crm.deal WHERE org_id = $1 AND stage_id = $2 ORDER BY sort_key, id', [o.orgId, mới]));
    expect(rows.rows.map((r) => r.title)).toEqual(['Đầu', ...titles]);
    expect(Math.max(...rows.rows.map((r) => r.sort_key.length))).toBeLessThanOrEqual(60);
    expect(new Set(rows.rows.map((r) => r.sort_key)).size).toBe(rows.rows.length);
  });

  it('deletes a deal: a member only their own, an owner any, and writes a timeline row without values', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const theirs = await o.newDeal(o.other, party, { title: 'Bí mật Nguyễn Văn A', amount: '777000' });
    const mine = await o.newDeal(o.member, party);
    await expect(o.exec(o.member, 'crm.deal.delete', { dealId: theirs.id })).rejects.toMatchObject({ code: 'DEAL_DELETE_FORBIDDEN', status: 403 });
    await expect(o.exec(o.viewer, 'crm.deal.delete', { dealId: mine.id })).rejects.toMatchObject({ status: 403 });
    expect(await o.exec(o.member, 'crm.deal.delete', { dealId: mine.id })).toEqual({ dealId: mine.id, deleted: true });
    expect(await o.exec(o.owner, 'crm.deal.delete', { dealId: theirs.id })).toEqual({ dealId: theirs.id, deleted: true });
    await expect(o.query(o.owner, 'crm.deal.get', { dealId: theirs.id })).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND', status: 404 });
    expect((await o.query<Deal[]>(o.owner, 'crm.party.deals', { partyId: party }))).toEqual([]);

    const timeline = await admin((c) => c.query<{ kind: string; summary: string }>("SELECT kind, summary FROM crove_kernel.activity WHERE org_id = $1 AND record_type = 'kernel.party' AND record_id = $2 ORDER BY occurred_at, id", [o.orgId, party]));
    expect(timeline.rows.map((r) => r.kind)).toEqual(['deal.created', 'deal.created', 'deal.deleted', 'deal.deleted']);
    const text = JSON.stringify(timeline.rows) + JSON.stringify((await admin((c) => c.query('SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE $2', [o.orgId, 'crm.deal.%']))).rows);
    expect(text).not.toContain('Bí mật');
    expect(text).not.toContain('777000');
  });

  it('pages the deal list newest first and filters it', async () => {
    const o = await org();
    const a = await o.party('Công ty A');
    const b = await o.party('Công ty B');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.unshift((await o.newDeal(o.member, i % 2 ? a : b, { title: `Cơ hội ${i}` })).id);
    const first = await o.query<DealPage>(o.viewer, 'crm.deal.list', { limit: 2 });
    expect(first.items.map((d) => d.id)).toEqual(ids.slice(0, 2));
    const second = await o.query<DealPage>(o.viewer, 'crm.deal.list', { limit: 2, cursor: first.next });
    expect(second.items.map((d) => d.id)).toEqual(ids.slice(2, 4));
    const third = await o.query<DealPage>(o.viewer, 'crm.deal.list', { limit: 2, cursor: second.next });
    expect(third.items.map((d) => d.id)).toEqual(ids.slice(4));
    expect(third.next).toBeNull();
    expect((await o.query<DealPage>(o.owner, 'crm.deal.list', { partyId: a })).items).toHaveLength(2);
    expect((await o.query<DealPage>(o.owner, 'crm.deal.list', { status: 'won' })).items).toEqual([]);
    expect((await o.query<DealPage>(o.owner, 'crm.deal.list', { ownerUserId: o.owner })).items).toEqual([]);
  });

  it('searches the org parties by name or tax code, treating LIKE characters as text', async () => {
    const o = await org();
    const p = await org();
    const abc = await o.party('Công ty ABC');
    await o.party('Cửa hàng 100%_vàng');
    await p.party('Công ty ABC của org khác');
    await admin((c) => c.query("UPDATE crove_kernel.party SET tax_code = '0123456780' WHERE org_id = $1 AND id = $2", [o.orgId, abc]));
    const find = (q: string) => o.query<{ id: string; name: string; taxCode: string | null }[]>(o.viewer, 'crm.party.search', { q });
    expect((await find('abc')).map((r) => r.id)).toEqual([abc]);
    expect((await find('0123456')).map((r) => r.name)).toEqual(['Công ty ABC']);
    expect((await find('100%_')).map((r) => r.name)).toEqual(['Cửa hàng 100%_vàng']);
    expect(await find('%')).toHaveLength(1);
    expect(await find('')).toHaveLength(2);
    expect(await find('khác')).toEqual([]);
  });

  it('never shows or touches another org', async () => {
    const o = await org();
    const p = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(o.member, party);
    const foreignParty = await p.party('Công ty lạ');
    // The other org sees nothing, and cannot read, change, move or delete the deal, nor attach one to the party.
    expect((await p.query<DealPage>(p.owner, 'crm.deal.list', {})).items).toEqual([]);
    await expect(p.query(p.owner, 'crm.deal.get', { dealId: deal.id })).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND' });
    await expect(p.exec(p.owner, 'crm.deal.delete', { dealId: deal.id })).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND' });
    await expect(p.exec(p.owner, 'crm.deal.move', { dealId: deal.id, version: 1, stageId: (await p.stageNamed('Mới')).id })).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND' });
    await expect(p.newDeal(p.owner, party)).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
    await expect(o.newDeal(o.owner, foreignParty)).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
    // And the database refuses a deal that mixes the orgs, whatever the command checks.
    const stage = await o.stageNamed('Mới');
    await expect(
      admin((c) => c.query("INSERT INTO crove_crm.deal (org_id, party_id, title, stage_id, sort_key, created_by) VALUES ($1, $2, 'x', $3, 'V', $4)", [o.orgId, foreignParty, stage.id, o.owner])),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('leaves the deal without an owner when the member is removed, and keeps it when its party has one', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    const deal = await o.newDeal(o.other, party);
    expect(deal.ownerUserId).toBe(o.other);
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, o.other]));
    expect(await o.query<Deal>(o.owner, 'crm.deal.get', { dealId: deal.id })).toMatchObject({ ownerUserId: null });
    // A party that has a deal cannot be deleted from under it.
    await expect(admin((c) => c.query('DELETE FROM crove_kernel.party WHERE org_id = $1 AND id = $2', [o.orgId, party]))).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses a caller that is not a person', async () => {
    const o = await org();
    const party = await o.party('Công ty ABC');
    await expect(rt.execute('crm.deal.create', { partyId: party, title: 'x', amount: '1', expectedClose: null }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId })).rejects.toBeDefined();
  });
});
