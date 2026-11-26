// SPDX-License-Identifier: AGPL-3.0-only
// CRM reads for member-scoped Vy daily briefings (#5073, ADR-0049 decision 2/6 amendment):
//   - crm.stage.list, crm.deal.get, and crm.deal.list declare memberVy: { reads: [] } with access ALL, zero mcp/stream/sensitive;
//   - inside memberVyRuntime (ludy_worker, kernel.member_vy.run.start_daily for meetings.brief_daily), those 3 queries return org-scoped
//     stages and deals with canDelete: false, decimal-string amounts intact, saved-view filter/sort support (me = null), and nested ctx.query;
//   - cross-org reads, non-opted-in CRM queries, CRM write commands, org-chart agent actors, and viewers/members without vy.use are refused.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { zId, type Deal, type DealPage, type FilterAst, type PipelineStage } from '@ludy/kernel-contract';
import { Runtime, defineQuery, memberVyRuntime, type Lookup } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'meetings.brief_daily' };
const AGENT_SYSTEM = { type: 'system' as const, component: 'kernel.agent' };

const OPTED_IN_CRM_QUERIES = ['crm.deal.get', 'crm.deal.list', 'crm.stage.list'] as const;

const testBriefCrmReads = defineQuery({
  name: 'meetings.test_brief_crm_reads',
  input: z.strictObject({ partyId: zId, dealId: zId }),
  access: ['owner', 'admin', 'member', 'viewer'],
  memberVy: { reads: [...OPTED_IN_CRM_QUERIES] },
  handler: async (
    ctx,
    input,
  ): Promise<{
    stages: Lookup<PipelineStage[]>;
    deal: Lookup<Deal>;
    listed: Lookup<DealPage>;
  }> => {
    const stages = await ctx.query<PipelineStage[]>('crm.stage.list', {});
    const deal = await ctx.query<Deal>('crm.deal.get', { dealId: input.dealId });
    const listed = await ctx.query<DealPage>('crm.deal.list', { partyId: input.partyId, status: 'open', limit: 5 });
    return { stages, deal, listed };
  },
});

const testBriefCrmDeniedRead = defineQuery({
  name: 'meetings.test_brief_crm_denied_read',
  input: z.strictObject({ partyId: zId }),
  access: ['owner', 'admin', 'member', 'viewer'],
  memberVy: { reads: ['crm.party.deals'] },
  handler: async (ctx, input): Promise<Lookup<Deal[]>> => ctx.query<Deal[]>('crm.party.deals', { partyId: input.partyId }),
});

describe('CRM memberVy query registration (#5073)', () => {
  it('registers crmQueries cleanly and opts in only crm.stage.list, crm.deal.get, and crm.deal.list', () => {
    const rt = new Runtime({} as never, { manifests: TEST_MANIFESTS });
    expect(() =>
      rt.register({
        commands: [...crmCommands],
        queries: [...crmQueries],
      }),
    ).not.toThrow();

    expect(crmCommands.filter((c) => c.memberVy !== undefined)).toEqual([]);

    const optedIn = crmQueries.filter((q) => q.memberVy !== undefined);
    expect(optedIn.map((q) => q.name).sort()).toEqual([...OPTED_IN_CRM_QUERIES]);
    for (const q of optedIn) {
      expect(q.memberVy, q.name).toEqual({ reads: [] });
      expect(Array.isArray(q.access), q.name).toBe(true);
      expect(q.access, q.name).toEqual(['owner', 'admin', 'member', 'viewer']);
      expect(q.stream === true, q.name).toBe(false);
      expect(q.sensitive === true, q.name).toBe(false);
      expect(q.mcp, q.name).toBeUndefined();
    }
  });
});

suite('CRM memberVy reads on PostgreSQL (#5073)', () => {
  const dbName = `ludy_test_crm_member_vy_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;

  let orgA = '';
  let orgB = '';
  let emptyOrg = '';

  const users = {
    ownerA: '',
    alice: '',
    bob: '',
    viewerA: '',
    ownerB: '',
    emptyOwner: '',
  };

  let stagesA: PipelineStage[] = [];
  let stagesB: PipelineStage[] = [];
  let partyA1 = '';
  let partyA2 = '';
  let partyB = '';
  let dealA1!: Deal;
  let dealA2!: Deal;
  let dealA3Won!: Deal;
  let dealA4!: Deal;
  let dealB!: Deal;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  const sqlAdmin = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(text, values)).rows;
    } finally {
      await c.end();
    }
  };

  const startDaily = (orgId: string, userId: string) =>
    worker.execute<{ agentId: string; runId: string; resultId: string; expiresAt: string }>(
      'kernel.member_vy.run.start_daily',
      { userId, feature: 'meetings.brief_daily' },
      { actor: SYSTEM, orgId },
    );

  const finishDaily = (orgId: string, runId: string) =>
    worker
      .execute('kernel.member_vy.run.finish', { runId, errorCode: 'AI_STOPPED' }, { actor: SYSTEM, orgId })
      .catch(() => undefined);

  const expectForbidden = async (promise: Promise<unknown>, rule: 'member_vy_access' | 'agent_access') => {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'FORBIDDEN', status: 403, details: { rule } });
  };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };

    const appPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);

    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);

    app = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...crmCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...crmQueries, ...meetingsQueries],
    });
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...crmCommands, ...meetingsCommands],
      queries: [
        ...kernelQueries({ inboundDomain: 'in.test' }),
        ...crmQueries,
        ...meetingsQueries,
        testBriefCrmReads,
        testBriefCrmDeniedRead,
      ],
    });

    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(appDb, {
        issuer: 'crm-member-vy-test',
        subject: key,
        email: `${key}-${randomUUID().slice(0, 8)}@crm-vy.test`,
        name: null,
      });
    }

    orgA = (await createOrg(app, asUser(users.ownerA), 'Org A CRM Vy')).orgId;
    orgB = (await createOrg(app, asUser(users.ownerB), 'Org B CRM Vy')).orgId;
    emptyOrg = (await createOrg(app, asUser(users.emptyOwner), 'Empty Org CRM Vy')).orgId;

    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
      [orgA, users.alice, users.bob, users.viewerA],
    );

    await app.execute(
      'kernel.member.permission.set',
      { userId: users.bob, permission: 'vy.use', allowed: false },
      { actor: asUser(users.ownerA), orgId: orgA },
    );

    stagesA = await app.execute<PipelineStage[]>('crm.pipeline.setup', {}, { actor: asUser(users.ownerA), orgId: orgA });
    stagesB = await app.execute<PipelineStage[]>('crm.pipeline.setup', {}, { actor: asUser(users.ownerB), orgId: orgB });

    const newParty = async (orgId: string, actorId: string, name: string) =>
      (await app.execute<{ partyId: string }>('kernel.party.create', { kind: 'organization', name }, { actor: asUser(actorId), orgId })).partyId;

    partyA1 = await newParty(orgA, users.ownerA, 'Công ty Minh Anh');
    partyA2 = await newParty(orgA, users.ownerA, 'Công ty Bình Minh');
    partyB = await newParty(orgB, users.ownerB, 'Công ty Ngoài Tổ Chức');

    const quoteStageA = stagesA.find((s) => s.name === 'Báo giá')!;
    const wonStageA = stagesA.find((s) => s.kind === 'won')!;

    dealA1 = await app.execute<Deal>(
      'crm.deal.create',
      {
        partyId: partyA1,
        title: 'Gói tư vấn năm',
        amount: '15000000.5',
        expectedClose: '2026-12-31',
        ownerUserId: users.alice,
      },
      { actor: asUser(users.alice), orgId: orgA },
    );
    dealA2 = await app.execute<Deal>(
      'crm.deal.create',
      {
        partyId: partyA1,
        title: 'Gói bảo trì quý',
        amount: '2500000.25',
        expectedClose: '2026-11-30',
        ownerUserId: users.ownerA,
        stageId: quoteStageA.id,
      },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    const createdA3 = await app.execute<Deal>(
      'crm.deal.create',
      {
        partyId: partyA1,
        title: 'Gói đã chốt',
        amount: '8000000',
        expectedClose: '2026-10-15',
        ownerUserId: users.ownerA,
      },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    dealA3Won = await app.execute<Deal>(
      'crm.deal.move',
      { dealId: createdA3.id, version: createdA3.version, stageId: wonStageA.id },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    dealA4 = await app.execute<Deal>(
      'crm.deal.create',
      {
        partyId: partyA2,
        title: 'Gói mở rộng',
        amount: '4200000',
        expectedClose: null,
        ownerUserId: null,
      },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    dealB = await app.execute<Deal>(
      'crm.deal.create',
      {
        partyId: partyB,
        title: 'Gói bí mật org B',
        amount: '99999999.99',
        expectedClose: '2026-12-31',
        ownerUserId: users.ownerB,
      },
      { actor: asUser(users.ownerB), orgId: orgB },
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

  const byNewestDesc = (a: Deal, b: Deal) => {
    if (a.createdAt !== b.createdAt) return b.createdAt < a.createdAt ? -1 : 1;
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  };

  it('reads org stages and deals inside memberVyRuntime with canDelete false, decimal amounts, saved-view filters, and nested ctx.query', async () => {
    // Control check: as a regular user, Alice can delete the deal she created.
    const asCreator = await app.query<Deal>('crm.deal.get', { dealId: dealA1.id }, { actor: asUser(users.alice), orgId: orgA });
    expect(asCreator.canDelete).toBe(true);

    const aliceDaily = await startDaily(orgA, users.alice);
    try {
      const vy = memberVyRuntime(worker, orgA, { agentId: aliceDaily.agentId, runId: aliceDaily.runId });

      const stages = await vy.query<PipelineStage[]>('crm.stage.list', {});
      expect(stages).toEqual(stagesA);
      expect(stages.map((s) => [s.name, s.kind, s.position])).toEqual([
        ['Mới', 'open', 1],
        ['Đã liên hệ', 'open', 2],
        ['Báo giá', 'open', 3],
        ['Thương lượng', 'open', 4],
        ['Thắng', 'won', 5],
        ['Thua', 'lost', 6],
      ]);

      const got = await vy.query<Deal>('crm.deal.get', { dealId: dealA1.id });
      expect(got).toEqual({ ...dealA1, canDelete: false });
      expect(typeof got.amount).toBe('string');
      expect(got.amount).toBe('15000000.50');

      // Matches how modules/meetings/src/brief.ts calls crm.deal.list for a party's open deals.
      const expectedOpenPartyA1 = [dealA1, dealA2].sort(byNewestDesc);
      const briefListed = await vy.query<DealPage>('crm.deal.list', { partyId: partyA1, status: 'open', limit: 5 });
      expect(briefListed.next).toBeNull();
      expect(briefListed.items.map((d) => d.id)).toEqual(expectedOpenPartyA1.map((d) => d.id));
      for (const item of briefListed.items) {
        expect(item.canDelete).toBe(false);
        expect(typeof item.amount).toBe('string');
      }
      expect(briefListed.items.map((d) => d.amount)).toEqual(expectedOpenPartyA1.map((d) => d.amount));

      // Saved-view filters, sort, and after-cursor pagination inside memberVyRuntime.
      const amountFilter: FilterAst = {
        v: 1,
        all: [
          { field: 'status', op: 'is', value: 'open' },
          { field: 'amount', op: 'gte', value: '3000000' },
        ],
      };
      const page1 = await vy.query<DealPage>('crm.deal.list', {
        filters: amountFilter,
        sort: { field: 'amount', dir: 'desc' },
        limit: 1,
      });
      expect(page1.items.map((d) => d.id)).toEqual([dealA1.id]);
      expect(page1.items[0]?.canDelete).toBe(false);
      expect(page1.items[0]?.amount).toBe('15000000.50');
      expect(page1.next).not.toBeNull();

      const page2 = await vy.query<DealPage>('crm.deal.list', {
        filters: amountFilter,
        sort: { field: 'amount', dir: 'desc' },
        limit: 1,
        after: { id: page1.next!.id, value: page1.next!.value ?? null },
      });
      expect(page2.items.map((d) => d.id)).toEqual([dealA4.id]);
      expect(page2.items[0]?.canDelete).toBe(false);
      expect(page2.items[0]?.amount).toBe('4200000.00');
      expect(page2.next).toBeNull();

      // Search folding works under memberVy context.
      const searched = await vy.query<DealPage>('crm.deal.list', {
        filters: { v: 1, all: [{ field: 'search', op: 'contains', value: 'tu van' }] },
      });
      expect(searched.items.map((d) => d.id)).toEqual([dealA1.id]);
      expect(searched.items[0]?.canDelete).toBe(false);

      // Saved-view "is_me" sees me = null for agent actors and fails closed with no matches.
      const isMe = await vy.query<DealPage>('crm.deal.list', {
        filters: { v: 1, all: [{ field: 'owner', op: 'is_me' }] },
      });
      expect(isMe).toEqual({ items: [], next: null });

      // Nested ctx.query(...) from a query declaring memberVy: { reads: [...] }.
      const nested = await vy.query<{
        stages: Lookup<PipelineStage[]>;
        deal: Lookup<Deal>;
        listed: Lookup<DealPage>;
      }>('meetings.test_brief_crm_reads', { partyId: partyA1, dealId: dealA1.id });
      expect(nested.stages).toEqual({ status: 'ok', value: stagesA });
      expect(nested.deal).toEqual({ status: 'ok', value: { ...dealA1, canDelete: false } });
      expect(nested.listed).toEqual({
        status: 'ok',
        value: {
          items: expectedOpenPartyA1.map((d) => ({ ...d, canDelete: false })),
          next: null,
        },
      });
    } finally {
      await finishDaily(orgA, aliceDaily.runId);
    }

    // Even for an org owner's memberVy run, canDelete remains false on every returned deal.
    const ownerDaily = await startDaily(orgA, users.ownerA);
    try {
      const vyOwner = memberVyRuntime(worker, orgA, { agentId: ownerDaily.agentId, runId: ownerDaily.runId });
      const ownerDeal = await vyOwner.query<Deal>('crm.deal.get', { dealId: dealA2.id });
      expect(ownerDeal.canDelete).toBe(false);
      const expectedPartyA1 = [dealA1, dealA2, dealA3Won].sort(byNewestDesc);
      const ownerList = await vyOwner.query<DealPage>('crm.deal.list', { partyId: partyA1 });
      expect(ownerList.items.map((d) => d.id)).toEqual(expectedPartyA1.map((d) => d.id));
      for (const item of ownerList.items) expect(item.canDelete).toBe(false);
    } finally {
      await finishDaily(orgA, ownerDaily.runId);
    }
  });

  it('isolates cross-org deals and stages strictly under memberVyRuntime', async () => {
    const aliceDaily = await startDaily(orgA, users.alice);
    try {
      const vy = memberVyRuntime(worker, orgA, { agentId: aliceDaily.agentId, runId: aliceDaily.runId });

      await expect(vy.query('crm.deal.get', { dealId: dealB.id })).rejects.toMatchObject({
        code: 'DEAL_NOT_FOUND',
        status: 404,
      });
      expect(await vy.query<DealPage>('crm.deal.list', { partyId: partyB })).toEqual({ items: [], next: null });

      const allVisible = await vy.query<DealPage>('crm.deal.list', {});
      expect(allVisible.items.some((d) => d.id === dealB.id)).toBe(false);

      const visibleStages = await vy.query<PipelineStage[]>('crm.stage.list', {});
      const foreignStageIds = new Set(stagesB.map((s) => s.id));
      expect(visibleStages.some((s) => foreignStageIds.has(s.id))).toBe(false);
    } finally {
      await finishDaily(orgA, aliceDaily.runId);
    }

    // An org with no pipeline setup yet returns empty lists cleanly without reading other orgs.
    const emptyDaily = await startDaily(emptyOrg, users.emptyOwner);
    try {
      const vyEmpty = memberVyRuntime(worker, emptyOrg, { agentId: emptyDaily.agentId, runId: emptyDaily.runId });
      expect(await vyEmpty.query<PipelineStage[]>('crm.stage.list', {})).toEqual([]);
      expect(await vyEmpty.query<DealPage>('crm.deal.list', {})).toEqual({ items: [], next: null });
    } finally {
      await finishDaily(emptyOrg, emptyDaily.runId);
    }
  });

  it('refuses non-opted-in CRM queries and all CRM write commands inside memberVyRuntime, and rejects org-chart agents', async () => {
    const aliceDaily = await startDaily(orgA, users.alice);
    try {
      const vy = memberVyRuntime(worker, orgA, { agentId: aliceDaily.agentId, runId: aliceDaily.runId });

      // Non-opted-in CRM queries are refused with FORBIDDEN (member_vy_access).
      await expectForbidden(vy.query('crm.party.search', { q: 'Minh' }), 'member_vy_access');
      await expectForbidden(vy.query('crm.party.deals', { partyId: partyA1 }), 'member_vy_access');
      await expectForbidden(vy.query('crm.party.conversations', { partyId: partyA1 }), 'member_vy_access');
      await expectForbidden(vy.query('crm.deal.conversations', { dealId: dealA1.id }), 'member_vy_access');
      await expectForbidden(vy.query('crm.deal.board', {}), 'member_vy_access');
      await expectForbidden(vy.query('crm.mcp.deals', {}), 'member_vy_access');
      await expectForbidden(vy.query('crm.mcp.deal', { dealId: dealA1.id }), 'member_vy_access');

      // Even if a caller query declares memberVy.reads, nested ctx.query to a non-opted-in CRM query is refused.
      await expectForbidden(vy.query('meetings.test_brief_crm_denied_read', { partyId: partyA1 }), 'member_vy_access');

      // All CRM write commands remain closed to memberVy.
      await expectForbidden(vy.execute('crm.pipeline.setup', {}), 'member_vy_access');
      await expectForbidden(
        vy.execute('crm.deal.create', { partyId: partyA1, title: 'Blocked deal', amount: '1000', expectedClose: null }),
        'member_vy_access',
      );
      await expectForbidden(
        vy.execute('crm.deal.update', {
          dealId: dealA1.id,
          version: dealA1.version,
          partyId: partyA1,
          title: 'Tampered title',
          amount: '999',
          expectedClose: null,
          ownerUserId: users.alice,
        }),
        'member_vy_access',
      );
      await expectForbidden(
        vy.execute('crm.deal.move', {
          dealId: dealA1.id,
          version: dealA1.version,
          stageId: stagesA.find((s) => s.name === 'Báo giá')!.id,
        }),
        'member_vy_access',
      );
      await expectForbidden(vy.execute('crm.deal.delete', { dealId: dealA1.id }), 'member_vy_access');

      const dealsInOrg = await sqlAdmin<{ id: string; title: string; version: number }>(
        `SELECT id, title, version FROM ludy_crm.deal WHERE org_id = $1 ORDER BY created_at`,
        [orgA],
      );
      expect(dealsInOrg).toHaveLength(4);
      expect(dealsInOrg.find((d) => d.id === dealA1.id)).toEqual({
        id: dealA1.id,
        title: 'Gói tư vấn năm',
        version: 1,
      });
    } finally {
      await finishDaily(orgA, aliceDaily.runId);
    }

    // An org-chart agent does not gain access via memberVy declarations (rejected with agent_access).
    const installed = await app.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'crm.scheduler' },
      { actor: asMfa(users.ownerA), orgId: orgA },
    );
    await app.execute(
      'kernel.task.create',
      { title: 'Wake scheduler for test', assigneePositionId: installed.positionId },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    const orgRun = await worker.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: AGENT_SYSTEM, orgId: orgA },
    );
    expect(orgRun.runId).toMatch(/^[0-9a-f-]{36}$/);
    const orgAgentActor = {
      type: 'agent' as const,
      agentId: installed.agentId,
      runId: orgRun.runId as string,
    };
    await expectForbidden(worker.query('crm.stage.list', {}, { actor: orgAgentActor, orgId: orgA }), 'agent_access');
    await expectForbidden(worker.query('crm.deal.get', { dealId: dealA1.id }, { actor: orgAgentActor, orgId: orgA }), 'agent_access');
    await expectForbidden(worker.query('crm.deal.list', { partyId: partyA1 }, { actor: orgAgentActor, orgId: orgA }), 'agent_access');
  });

  it('refuses to start a member_vy daily run for a viewer or a member without vy.use (VY_NOT_ALLOWED), and respects vy.use override and crm app switch', async () => {
    await expect(startDaily(orgA, users.viewerA)).rejects.toMatchObject({ code: 'VY_NOT_ALLOWED' });
    await expect(startDaily(orgA, users.bob)).rejects.toMatchObject({ code: 'VY_NOT_ALLOWED' });

    // A viewer explicitly granted vy.use can start and read the 3 CRM queries with canDelete: false.
    await app.execute(
      'kernel.member.permission.set',
      { userId: users.viewerA, permission: 'vy.use', allowed: true },
      { actor: asUser(users.ownerA), orgId: orgA },
    );
    try {
      const viewerDaily = await startDaily(orgA, users.viewerA);
      try {
        const vyViewer = memberVyRuntime(worker, orgA, { agentId: viewerDaily.agentId, runId: viewerDaily.runId });
        expect(await vyViewer.query<PipelineStage[]>('crm.stage.list', {})).toEqual(stagesA);
        expect((await vyViewer.query<Deal>('crm.deal.get', { dealId: dealA1.id })).canDelete).toBe(false);
        const viewerList = await vyViewer.query<DealPage>('crm.deal.list', { partyId: partyA1, status: 'open', limit: 5 });
        expect(viewerList.items.every((d) => !d.canDelete)).toBe(true);

        // Switching the crm app off refuses direct memberVy reads with MODULE_OFF and yields not_installed in nested ctx.query.
        await app.execute('kernel.org.set_app', { module: 'crm', enabled: false }, { actor: asUser(users.ownerA), orgId: orgA });
        try {
          await expect(vyViewer.query('crm.deal.list', { partyId: partyA1 })).rejects.toMatchObject({ code: 'MODULE_OFF' });
          const offNested = await vyViewer.query<{
            stages: Lookup<PipelineStage[]>;
            deal: Lookup<Deal>;
            listed: Lookup<DealPage>;
          }>('meetings.test_brief_crm_reads', { partyId: partyA1, dealId: dealA1.id });
          expect(offNested).toEqual({
            stages: { status: 'not_installed', module: 'crm' },
            deal: { status: 'not_installed', module: 'crm' },
            listed: { status: 'not_installed', module: 'crm' },
          });
        } finally {
          await app.execute('kernel.org.set_app', { module: 'crm', enabled: true }, { actor: asUser(users.ownerA), orgId: orgA });
        }
      } finally {
        await finishDaily(orgA, viewerDaily.runId);
      }
    } finally {
      await app.execute(
        'kernel.member.permission.set',
        { userId: users.viewerA, permission: 'vy.use', allowed: null },
        { actor: asUser(users.ownerA), orgId: orgA },
      );
    }
  });
});
