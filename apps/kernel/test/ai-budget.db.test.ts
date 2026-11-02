// SPDX-License-Identifier: AGPL-3.0-only
// The AI budget meter on PostgreSQL 17 (#2382): one ledger (crove_kernel.org_usage, metric ai_cost) and one set of limits
// (crove_kernel.budget_policy, set by an owner with a fresh second factor). At 100% of a budget that covers a call the
// meter refuses the call; calls in flight finish. The core keeps working: XML e-invoices are read, a proposal is approved
// and posted, the journal is exported, while a photo that needs the model waits in the Inbox and is read after the budget
// is raised. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError, metered, withAiScope, type InvoiceReader } from '@crove/agent';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { WAITING_FOR_AI_BUDGET, createOrg, kernelCommands, kernelQueries, runAgentWake, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { AI_BUDGET_RECHECK_MS, extractAndPropose, financeAgentPrograms, financeCommands, financeQueries } from '@crove/mod-finance';
import type { ExtractClient } from '@crove/extract-contract';
import { memberMeter, systemMeter } from '../src/ai-meter.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url), 'utf8');
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

// One model call of 1000 input and 100 output tokens costs (3 * 1000 + 15 * 100) / 1e6 = 0.0045 at this price.
const PRICE = { inputPerMTok: '3', outputPerMTok: '15' };
const CALL_COST = '0.004500';
const usage = { inputTokens: 1000, outputTokens: 100 };

suite('the AI budget meter on PostgreSQL (#2382)', () => {
  const dbName = `crove_test_ai_budget_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
  const system = { type: 'system' as const, component: 'test' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // A statement read as the worker login role, the one the sweeps' functions are open to.
  async function asWorker<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const url = new URL(adminUrl);
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      return (await client.query<T>(text, values)).rows;
    } finally {
      await client.end();
    }
  }

  async function org(): Promise<{ orgId: string; owner: string }> {
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@meter.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }

  const setBudget = (o: { orgId: string; owner: string }, monthlyLimit: string, scope = 'org', target = '*') =>
    rt.execute('kernel.agent.budget.set', { scope, target, monthlyLimit }, { actor: asMfa(o.owner), orgId: o.orgId });
  // A model call as the worker makes one: through the door of @crove/agent, as the system, for one feature.
  const call = (orgId: string, feature: 'social.draft' | 'finance.invoice_extract' = 'social.draft', agentId?: string) =>
    withAiScope({ orgId, agentId, meter: systemMeter(worker, { price: PRICE }) }, () => metered(feature, async () => ({ usage })));
  const status = (o: { orgId: string; owner: string }, module?: string) => rt.query<{ state: string; percent: number | null; scope: string | null }>('kernel.ai.meter.status', module ? { module } : {}, { actor: asUser(o.owner), orgId: o.orgId });
  const ledger = (orgId: string) =>
    admin(async (c) => (await c.query<{ feature: string | null; module: string | null; agent_id: string | null; amount: string; input_tokens: number | null; output_tokens: number | null }>("SELECT feature, module, agent_id, amount::text, input_tokens, output_tokens FROM crove_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost' ORDER BY created_at, id", [orgId])).rows);

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
    const registry = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorkerUrl = new URL(adminUrl);
    asWorkerUrl.username = 'crove_worker';
    asWorkerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorkerUrl.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    extract = inProcessExtract();
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('counts a call with its feature, module and tokens, and stores nothing a call read or wrote', async () => {
    const o = await org();
    await call(o.orgId);
    expect(await ledger(o.orgId)).toEqual([{ feature: 'social.draft', module: 'social', agent_id: null, amount: CALL_COST, input_tokens: 1000, output_tokens: 100 }]);
    // The usage rows have no column that could hold a prompt, a document's text or a model's answer.
    const columns = await admin(async (c) => (await c.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'crove_kernel' AND table_name = 'org_usage' ORDER BY column_name")).rows.map((r) => r.column_name));
    expect(columns).toEqual(['agent_id', 'amount', 'created_at', 'feature', 'id', 'input_tokens', 'metric', 'module', 'org_id', 'output_tokens']);
    // Nor does a row's audit trail: ids, the feature and the numbers only (besides who ran it).
    const audit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.ai.usage.record'", [o.orgId])).rows);
    expect(audit.map((a) => Object.keys(a.detail).filter((k) => !['component', 'workerInstance'].includes(k)).sort())).toEqual([['agent', 'cost', 'feature', 'inputTokens', 'module', 'outputTokens']]);
  });

  it('refuses a new call at 100% of the org budget, lets a call in flight finish, and takes calls again once an owner raises it', async () => {
    const o = await org();
    // Not an owner with a fresh second factor, not an agent or the system: nobody else can set or raise it.
    await expect(rt.execute('kernel.agent.budget.set', { scope: 'org', target: '*', monthlyLimit: '0.009' }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    await expect(worker.execute('kernel.agent.budget.set', { scope: 'org', target: '*', monthlyLimit: '99' }, { actor: system, orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await status(o)).toMatchObject({ state: 'none', percent: null });
    await setBudget(o, '0.009');

    await call(o.orgId);
    expect(await status(o)).toMatchObject({ state: 'ok', percent: 50, scope: 'org' });
    // Admitted at 50%, still running when another call takes the budget to 100%: it finishes, and is counted.
    await withAiScope({ orgId: o.orgId, meter: systemMeter(worker, { price: PRICE }) }, () =>
      metered('social.draft', async () => {
        await call(o.orgId);
        return { usage };
      }),
    );
    expect((await ledger(o.orgId)).map((r) => r.amount)).toEqual([CALL_COST, CALL_COST, CALL_COST]);
    expect(await status(o)).toMatchObject({ state: 'stop', percent: 100, scope: 'org' });

    const refused = await call(o.orgId).then(
      () => null,
      (e: unknown) => e,
    );
    expect(refused).toBeInstanceOf(AiBudgetExhaustedError);
    const { scope, retryAt } = refused as AiBudgetExhaustedError;
    expect(scope).toBe('org');
    // The next month starts at midnight in Vietnam on the 1st.
    expect(Date.parse(retryAt as string)).toBeGreaterThan(Date.now());
    expect(Date.parse(retryAt as string)).toBeLessThan(Date.now() + 32 * 24 * 3600_000);
    expect(new Date(Date.parse(retryAt as string) + 7 * 3600_000).toISOString()).toMatch(/-01T00:00:00\.000Z$/);
    expect(await ledger(o.orgId)).toHaveLength(3);

    // The budgets list shows what the meter counted, as the run gate reads it.
    const { budgets } = await rt.query<{ budgets: Array<{ scope: string; monthlyLimit: string; spent: string }> }>('kernel.agent.budgets.list', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(budgets).toEqual([expect.objectContaining({ scope: 'org', monthlyLimit: '0.009000', spent: '0.013500' })]);

    await setBudget(o, '1');
    await expect(call(o.orgId)).resolves.toBeDefined();
    expect(await status(o)).toMatchObject({ state: 'ok', percent: 1 });
  });

  it('keeps a module budget to its module and an agent budget to its agent, and a spent agent budget keeps its runs out', async () => {
    const o = await org();
    await setBudget(o, '0.0045', 'module', 'social');
    await call(o.orgId, 'social.draft');
    await expect(call(o.orgId, 'social.draft')).rejects.toMatchObject({ name: 'AiBudgetExhaustedError', scope: 'module' });
    // Another module's call, and the books, are not covered by it.
    await expect(call(o.orgId, 'finance.invoice_extract')).resolves.toBeDefined();
    expect(await status(o, 'social')).toMatchObject({ state: 'stop', scope: 'module' });
    expect(await status(o, 'finance')).toMatchObject({ state: 'none' });

    const { agentId, positionId } = await rt.execute<{ agentId: string; positionId: string }>('kernel.agent.template.install', { templateKey: 'finance.chief_accountant' }, { actor: asMfa(o.owner), orgId: o.orgId });
    await setBudget(o, '0.0045', 'agent', agentId);
    await call(o.orgId, 'finance.invoice_extract', agentId);
    await expect(call(o.orgId, 'finance.invoice_extract', agentId)).rejects.toMatchObject({ name: 'AiBudgetExhaustedError', scope: 'agent' });
    // The same org's calls with no agent are not covered by the agent's budget.
    await expect(call(o.orgId, 'finance.invoice_extract')).resolves.toBeDefined();
    expect((await ledger(o.orgId)).filter((r) => r.agent_id === agentId)).toHaveLength(1);
    // The agent's run is refused at its gate, and its wake-up stays pending.
    await rt.execute('kernel.task.create', { title: 'Chờ ngân sách', assigneePositionId: positionId }, { actor: asUser(o.owner), orgId: o.orgId });
    await expect(runAgentWake({ runtime: worker, programs: financeAgentPrograms }, o.orgId, agentId)).resolves.toEqual({ runId: null, reason: 'budget' });
    // The owner raises it, and the next run is not refused for the budget.
    await setBudget(o, '10', 'agent', agentId);
    await expect(runAgentWake({ runtime: worker, programs: financeAgentPrograms }, o.orgId, agentId)).resolves.not.toMatchObject({ reason: 'budget' });
  });

  it('tells the owners once per budget, month and level, from the sweep', async () => {
    const o = await org();
    await setBudget(o, '1');
    const record = (cost: string) =>
      rt.execute('kernel.ai.usage.record_member', { feature: 'social.draft', module: 'social', agentId: null, inputTokens: 10, outputTokens: 1, cost }, { actor: asUser(o.owner), orgId: o.orgId });
    const crossings = async () => (await asWorker<{ org_id: string; scope: string; level: string }>('SELECT org_id, scope, level FROM crove_kernel.ai_budget_crossings(100)')).filter((r) => r.org_id === o.orgId);
    const notices = () =>
      admin(async (c) => (await c.query<{ dedupe_key: string; detail: Record<string, string> }>("SELECT dedupe_key, detail FROM crove_kernel.notification WHERE org_id = $1 AND kind = 'kernel.ai_budget' ORDER BY dedupe_key", [o.orgId])).rows);
    const notify = (level: string) => worker.execute<{ told: number }>('kernel.ai.budget.notify', { scope: 'org', target: '*', level }, { actor: system, orgId: o.orgId });

    await record('0.5');
    expect(await crossings()).toEqual([]);
    await record('0.35');
    expect(await crossings()).toEqual([{ org_id: o.orgId, scope: 'org', level: 'warn' }]);
    // The input names a level, never a number: a level not reached tells nobody.
    expect(await notify('stop')).toEqual({ told: 0 });
    expect(await notify('warn')).toEqual({ told: 1 });
    expect(await notify('warn')).toEqual({ told: 0 });
    expect(await crossings()).toEqual([]);

    await record('0.2');
    expect(await crossings()).toEqual([{ org_id: o.orgId, scope: 'org', level: 'stop' }]);
    expect(await notify('stop')).toEqual({ told: 1 });
    expect(await crossings()).toEqual([]);
    const month = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
    expect(await notices()).toEqual([
      { dedupe_key: `ai_budget:org:*:${month}:stop`, detail: { level: 'stop', scope: 'org', target: '*', percent: '105' } },
      { dedupe_key: `ai_budget:org:*:${month}:warn`, detail: { level: 'warn', scope: 'org', target: '*', percent: '85' } },
    ]);
  });

  it('keeps the core working at 100%: XML is read, a proposal is approved and posted, the journal is exported, and a photo waits and is read once the budget is raised', async () => {
    const o = await org();
    await setBudget(o, '0.0045');
    await call(o.orgId);
    await expect(call(o.orgId)).rejects.toBeInstanceOf(AiBudgetExhaustedError);

    const ingest = async (bytes: Uint8Array, filename: string, contentType: string) => {
      const sha256 = sha256Hex(bytes);
      const storageKey = fileKey(o.orgId, sha256);
      const generation = await store.put(storageKey, bytes);
      const { fileId } = await rt.execute<{ fileId: string }>(
        'kernel.file.ingest',
        { filename, contentType, sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
        { actor: asUser(o.owner), orgId: o.orgId },
      );
      return fileId;
    };
    // A fake model on the real door: it is metered like the endpoint's client, so a spent budget refuses it.
    let modelCalls = 0;
    const reader: InvoiceReader = {
      fromText: async () => null,
      fromImage: async () => {
        await metered('finance.invoice_extract', async () => {
          modelCalls += 1;
          return { usage };
        });
        return null;
      },
    };
    const meter = systemMeter(worker, { price: PRICE });
    const deps = { runtime: worker, store, extractor: reader, extract, today: () => '2026-10-13', meter };

    // 1. An e-invoice XML needs no model: read, proposed, approved with a fresh second factor and posted.
    const xml = await ingest(new TextEncoder().encode(FIXTURE.replace('<SHDon>1234</SHDon>', '<SHDon>9101</SHDon>')), 'hd-9101.xml', 'application/xml');
    const read = await extractAndPropose(deps, o.orgId, xml);
    expect(read.proposalId).toEqual(expect.any(String));
    const posted = await rt.execute<{ journalEntryId: string }>(
      'kernel.proposal.approve',
      { acceptUnverifiedSignature: true, id: String(read.proposalId), revision: 1 },
      { actor: asMfa(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    expect(posted.journalEntryId).toEqual(expect.any(String));
    // 2. The books are exported as before.
    await expect(rt.execute('finance.journal.export', { entries: 1 }, { actor: asUser(o.owner), orgId: o.orgId })).resolves.toBeDefined();
    expect(modelCalls).toBe(0);

    // 3. A photo needs the model: kept, shown as waiting with the budget's words, nothing lost, nothing spent.
    const photo = await ingest(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]), 'hd-anh.png', 'image/png');
    const spentBefore = (await ledger(o.orgId)).length;
    const kept = await extractAndPropose(deps, o.orgId, photo);
    expect(kept).toEqual({ proposalId: null, deferred: expect.any(String) });
    expect(Date.parse(kept.deferred as string)).toBeGreaterThan(Date.now());
    expect(modelCalls).toBe(0);
    expect(await ledger(o.orgId)).toHaveLength(spentBefore);
    const deferrals = await admin(async (c) => (await c.query<{ metric: string; subject_id: string; notified: boolean }>('SELECT metric, subject_id, notified FROM crove_kernel.usage_deferral WHERE org_id = $1', [o.orgId])).rows);
    expect(deferrals).toEqual([{ metric: 'ai_budget', subject_id: photo, notified: false }]);
    const mails = await admin(async (c) => (await c.query("SELECT 1 FROM crove_kernel.mail_message WHERE org_id = $1 AND source = 'kernel.usage.defer'", [o.orgId])).rowCount);
    expect(mails).toBe(0);
    const files = await rt.query<Array<{ id: string; status: string; error: string | null }>>('kernel.files.recent', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(files.find((f) => f.id === photo)).toMatchObject({ status: 'waiting', error: WAITING_FOR_AI_BUDGET });
    expect(files.find((f) => f.id === photo)?.error).toContain('Vy đã hết ngân sách tháng này');
    const runs = () => admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2', [o.orgId, photo])).rowCount);
    expect(await runs()).toBe(0);

    // 4. Asked again while the budget is still spent, it waits again and adds nothing to its history; once an owner raises
    // the budget the same job reads it.
    const again = await extractAndPropose(deps, o.orgId, photo);
    expect(again).toEqual({ proposalId: null, deferred: expect.any(String) });
    expect(Date.parse(again.deferred as string)).toBeLessThanOrEqual(Date.now() + AI_BUDGET_RECHECK_MS);
    expect(await admin(async (c) => (await c.query('SELECT 1 FROM crove_kernel.usage_deferral WHERE org_id = $1', [o.orgId])).rowCount)).toBe(1);
    expect(modelCalls).toBe(0);
    // The raise itself sends the waiting document to be read again: the event a re-uploaded file raises, queued by the relay.
    const queued = () => admin(async (c) => (await c.query("SELECT 1 FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'kernel.file.ingested' AND payload->>'fileId' = $2", [o.orgId, photo])).rowCount);
    const before = (await queued()) ?? 0;
    await setBudget(o, '0.0045');
    expect(await queued()).toBe(before);
    await setBudget(o, '1');
    expect(await queued()).toBe(before + 1);
    const resumed = await extractAndPropose(deps, o.orgId, photo);
    expect(resumed.deferred).toBeUndefined();
    expect(modelCalls).toBe(1);
    expect(await runs()).toBe(1);
    expect(await ledger(o.orgId)).toHaveLength(spentBefore + 1);
    const after = await rt.query<Array<{ id: string; status: string }>>('kernel.files.recent', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(after.find((f) => f.id === photo)?.status).not.toBe('waiting');
  });

  it('gives an org with no budget of its own the deployment default, never over an owner\'s', async () => {
    const o = await org();
    const mine = await org();
    await setBudget(mine, '5');
    const meter = systemMeter(worker, { price: PRICE, defaultMonthlyBudget: '0.009' });
    const through = (orgId: string) => withAiScope({ orgId, meter }, () => metered('social.draft', async () => ({ usage })));
    expect((await asWorker<{ org_id: string }>('SELECT org_id FROM crove_kernel.ai_budget_seed_due(1000)')).map((r) => r.org_id)).toContain(o.orgId);
    await through(o.orgId);
    await through(o.orgId);
    await expect(through(o.orgId)).rejects.toMatchObject({ name: 'AiBudgetExhaustedError', scope: 'org' });
    const policy = await admin(async (c) => (await c.query<{ monthly_limit: string; updated_by: string; hard_stop: boolean }>("SELECT monthly_limit::text, updated_by, hard_stop FROM crove_kernel.budget_policy WHERE org_id = $1", [o.orgId])).rows);
    expect(policy).toEqual([{ monthly_limit: '0.009000', updated_by: '00000000-0000-0000-0000-000000000000', hard_stop: true }]);
    expect((await asWorker<{ org_id: string }>('SELECT org_id FROM crove_kernel.ai_budget_seed_due(1000)')).map((r) => r.org_id)).not.toContain(o.orgId);
    // The owner's own budget stands, and so does the owner's raise of the default.
    for (let i = 0; i < 3; i++) await through(mine.orgId);
    expect(await status(mine)).toMatchObject({ state: 'ok' });
    await setBudget(o, '2');
    await expect(through(o.orgId)).resolves.toBeDefined();
  });

  it('meters the API\'s calls as the member who made them, and shows the owner this month by feature and by agent', async () => {
    const o = await org();
    await setBudget(o, '0.0045');
    const asMember = () => withAiScope({ orgId: o.orgId, meter: memberMeter(rt, asUser(o.owner), { price: PRICE }) }, () => metered('social.rewrite', async () => ({ usage })));
    await asMember();
    await expect(asMember()).rejects.toMatchObject({ name: 'AiBudgetExhaustedError', scope: 'org' });
    // The commands the meter records with are for the meter: nobody calls one for itself, and no user calls the system's.
    await expect(rt.execute('kernel.ai.usage.record', { feature: 'social.draft', module: 'social', agentId: null, inputTokens: 1, outputTokens: 1, cost: '0' }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(rt.query('kernel.ai.budget.check', { module: 'social', agentId: null }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(worker.execute('kernel.ai.budget.ensure_default', { monthlyLimit: '9' }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const report = await rt.query<{ spent: string; calls: number; byFeature: Array<{ feature: string; module: string; calls: number; inputTokens: number; outputTokens: number; cost: string }>; byAgent: unknown[] }>('kernel.ai.usage.report', {}, { actor: asUser(o.owner), orgId: o.orgId });
    expect(report).toMatchObject({ spent: CALL_COST, calls: 1, byAgent: [] });
    expect(report.byFeature).toEqual([{ feature: 'social.rewrite', module: 'social', calls: 1, inputTokens: 1000, outputTokens: 100, cost: CALL_COST }]);
  });
});
