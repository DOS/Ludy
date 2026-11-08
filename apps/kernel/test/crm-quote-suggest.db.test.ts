// SPDX-License-Identifier: AGPL-3.0-only
// What the sales coworker may see for the lines of a quote (#2698) on PostgreSQL 17: crm.quote.suggest_source reads the deal, its customer's name, the customer's latest inbound messages as the member
// may read them (a private message only for owners, admins and holders of the direct-message permission) and the latest line of each description of earlier quotes to the customer; it reads no
// message while the org's switch for AI on customers' words is off; it is read only (viewers refused, another org's deal not found) and leaves no audit row. Set CROVE_TEST_ADMIN_URL to a superuser
// URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Deal, PipelineStage, Quote } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries, type QuoteSuggestSource } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'crm-quote-suggest-test' };

suite('crm.quote.suggest_source on PostgreSQL (#2698)', () => {
  const dbName = `crove_test_crm_quote_suggest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
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
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@suggest.test`, name: null });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    const viewer = await person('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    const party = async (name: string) => (await rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]))[0]!.id;
    const exec = <T>(user: string, command: string, input: unknown) => rt.execute<T>(command, input, { actor: asUser(user), orgId });
    const query = <T>(user: string, command: string, input: unknown) => rt.query<T>(command, input, { actor: asUser(user), orgId });
    const deal = async (partyId: string, title = 'Đơn bánh Tết') => {
      await exec<PipelineStage[]>(owner, 'crm.pipeline.setup', {});
      return exec<Deal>(member, 'crm.deal.create', { partyId, title, amount: '3600000', expectedClose: '2026-12-31' });
    };
    // A customer's mail in the Inbox, linked to the party as a person links it.
    const mail = async (partyId: string, text: string, id = randomUUID()) => {
      await worker.execute('kernel.conversation.email_ingest', { events: [{ kind: 'email', threadId: `<${id}@mau.test>`, messageId: `<${id}@mau.test>`, direction: 'in', contact: { id: 'khach@mau.test', name: 'Khách' }, text, at: new Date().toISOString(), verified: true }] }, { actor: SYSTEM, orgId });
      await rows('UPDATE crove_kernel.conversation SET party_id = $2 WHERE org_id = $1 AND party_id IS NULL', [orgId, partyId]);
    };
    const source = (user: string, dealId: string) => query<QuoteSuggestSource>(user, 'crm.quote.suggest_source', { dealId });
    return { orgId, owner, member, viewer, party, exec, query, deal, mail, source };
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
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    db = createDb(pool);
    const registered = { commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registered);
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

  it('reads the deal, the customer\'s name, the customer\'s words and the latest line of each description of earlier quotes', async () => {
    const o = await org();
    const party = await o.party('Công ty Hoa Mai');
    const deal = await o.deal(party);
    // Two earlier quotes: the later price of the same description wins.
    for (const price of ['110000', '120000']) {
      const quote = await o.exec<Quote>(o.member, 'crm.quote.save', { dealId: deal.id, lines: [] });
      await o.exec(o.member, 'crm.quote.save', { quoteId: quote.id, version: quote.version, lines: [{ kind: 'item', description: 'Bánh A', unit: 'hộp', quantity: '1', unitPrice: price, vatRate: '8%' }, { kind: 'text', description: 'Ghi chú' }] });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await o.mail(party, 'Chị cần 10 hộp bánh A nhé');
    const got = await o.source(o.owner, deal.id);
    expect(got).toEqual({
      dealTitle: 'Đơn bánh Tết',
      dealAmount: '3600000',
      partyName: 'Công ty Hoa Mai',
      wordsAllowed: true,
      messages: ['Chị cần 10 hộp bánh A nhé'],
      earlier: [{ description: 'Bánh A', unit: 'hộp', unitPrice: '120000', vatRate: '8%' }],
    });
  });

  it('shows a member only what the member may read: a private message is read by owners, admins and holders of the direct-message permission', async () => {
    const o = await org();
    const party = await o.party('Công ty Hoa Mai');
    const deal = await o.deal(party);
    await o.mail(party, 'Tin riêng của khách');
    expect((await o.source(o.owner, deal.id)).messages).toEqual(['Tin riêng của khách']);
    expect((await o.source(o.member, deal.id)).messages).toEqual([]);
  });

  it('reads no message while the org\'s switch for AI on customers\' words is off, and says so', async () => {
    const o = await org();
    const party = await o.party('Công ty Hoa Mai');
    const deal = await o.deal(party);
    await o.mail(party, 'Chị cần 10 hộp bánh A nhé');
    await o.exec(o.owner, 'kernel.conversation.auto_draft_set', { autoDraft: false });
    expect(await o.source(o.owner, deal.id)).toMatchObject({ wordsAllowed: false, messages: [] });
    await o.exec(o.owner, 'kernel.conversation.auto_draft_set', { autoDraft: true });
    expect((await o.source(o.owner, deal.id)).messages).toHaveLength(1);
  });

  it('is read only and for people who write: a viewer is refused, another org\'s deal is not found, nothing is audited', async () => {
    const o = await org();
    const other = await org();
    const deal = await o.deal(await o.party('Công ty Hoa Mai'));
    await expect(o.source(o.viewer, deal.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(other.source(other.owner, deal.id)).rejects.toMatchObject({ code: 'DEAL_NOT_FOUND' });
    await o.source(o.owner, deal.id);
    const audits = await rows("SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'crm.quote.suggest_source'", [o.orgId]);
    expect(audits).toEqual([]);
  });
});
