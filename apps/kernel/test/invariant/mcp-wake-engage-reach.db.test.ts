// SPDX-License-Identifier: AGPL-3.0-only
// Who can reach Engage's wake reads, and what they give back (#3862, E3 of epic #3857; ADR-0051 decisions 11 to 13): `kernel.wake.conversations` and `crm.wake.facts`, the two reads the wake sweep runs as a company
// grant in its sealed context and Home runs as the member.
// - a company grant of an org reads that org's threads and none of another org's (the database's own policies, the sealed context), and the same grant asked in another org is refused;
// - a member-bound grant is refused by both reads, and a plain member by the CRM read, which is the owner's and admin's;
// - the conversation read answers ids, a kind and instants and the CRM read ids, days and an amount, with exactly those keys, and no word a customer, a deal or a guest wrote: the canary strings of the data never come back.
// Part of the invariant suite: its fixtures are its own, and it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { Deal, EngageWakeConversations, EngageWakeCrm } from '@crove/kernel-contract';
import { CredentialVault, Runtime, parseVaultKey, type UserActor } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { makeWakeSecret } from '../../src/mcp-wake-setup.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const CANARY = 'Nguyễn Văn Canary 7777';
const SYSTEM = { type: 'system' as const, component: 'crm.deal_stale' };
const SCOPES = ['ludy.read', 'ludy.engage.write'];

suite('who reaches the wake reads of Engage, and what they give back (#3862)', () => {
  const dbName = `crove_test_wake_reach_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let rt: Runtime;
  let worker: Runtime;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const rows = async <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(text, params)).rows;
    } finally {
      await c.end();
    }
  };

  async function org(name: string) {
    const owner = (await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@reach.test`, name: null })) as string;
    const member = (await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'test', subject: randomUUID(), email: `m-${randomUUID().slice(0, 8)}@reach.test`, name: null })) as string;
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${name}`);
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]);
    const channel = randomUUID();
    await rows(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'facebook_page', $3, $4, $5)`, [orgId, channel, `ext-${channel.slice(0, 8)}`, `Trang ${CANARY}`, owner]);
    const thread = async () => {
      const id = randomUUID();
      const identity = randomUUID();
      await rows(`INSERT INTO crove_kernel.conversation_identity (org_id, id, provider, external_user_id, display_name) VALUES ($1, $2, 'facebook', $3, $4)`, [orgId, identity, `u-${id.slice(0, 8)}`, CANARY]);
      await rows(`INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, identity_id, status, last_seq, last_inbound_at, reply_window_until) VALUES ($1, $2, $3, 'direct', $4, $5, 'new', 1, now() - interval '6 hours', now() + interval '90 minutes')`, [orgId, id, channel, `t-${id}`, identity]);
      await rows(`INSERT INTO crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, received_at, author_kind, body, tainted) VALUES ($1, $2, $3, 'direct', 1, 'in', now() - interval '6 hours', now() - interval '6 hours', 'contact', $4, true)`, [orgId, id, channel, `${CANARY} cần báo giá gấp`]);
      return id;
    };
    const grant = async (scopes: string[], kind: 'company' | 'member' = 'company') => {
      const grantId = randomUUID();
      await rows(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $5, 'Dy', 'client.example.com', $6::text[], $4, now(), now() + interval '30 days', $3, $7, $8)`,
        [orgId, grantId, owner, `oauth-${grantId}`, `client-${grantId}`, scopes, kind, kind === 'member' ? owner : null],
      );
      const made = makeWakeSecret(vault, orgId, grantId);
      await rt.execute('kernel.mcp.wake.set', { grantId, url: 'https://hooks.example.com/ludy', credential: made.credential, schedule: 'off', enabled: true }, { actor: asUser(owner), orgId });
      return grantId;
    };
    const actor = (grantId: string, kind?: 'member'): UserActor => ({ type: 'user', userId: owner, aal: 'aal1', mcp: { grantId, clientId: 'wake-up', clientName: 'Wake-up', scopes: SCOPES, ...(kind ? { kind } : {}) } });
    return { orgId, owner, member, thread, grant, actor };
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
      const u = new URL(adminUrl);
      u.username = user;
      u.password = password;
      return u.toString();
    };
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    const registered = { commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] };
    rt = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(registered);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS, mcpEntry: 'worker' }).register(registered);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('gives a company grant its own org\'s threads and none of another org\'s, refuses the same grant in another org, and a member-bound grant, and a plain member on the CRM read', async () => {
    const a = await org('A');
    const b = await org('B');
    const mine = await a.thread();
    const theirs = await b.thread();
    const input = { unansweredHours: 4, replyWindowHours: 3 };
    const company = await a.grant(SCOPES);
    const read = await worker.query<EngageWakeConversations>('kernel.wake.conversations', input, { actor: a.actor(company), orgId: a.orgId });
    expect(read.unanswered.map((r) => r.id)).toEqual([mine]);
    expect(read.replyWindow.map((r) => r.id)).toEqual([mine]);
    expect(JSON.stringify(read)).not.toContain(theirs);
    await expect(worker.query('kernel.wake.conversations', input, { actor: a.actor(company), orgId: b.orgId })).rejects.toBeTruthy();
    await expect(worker.query('crm.wake.facts', {}, { actor: a.actor(company), orgId: b.orgId })).rejects.toBeTruthy();
    const bound = await a.grant(['ludy.read'], 'member');
    for (const [name, args] of [['kernel.wake.conversations', input], ['crm.wake.facts', {}]] as const) {
      await expect(rt.query(name, args, { actor: a.actor(bound, 'member'), orgId: a.orgId })).rejects.toMatchObject({ status: 403 });
    }
    await expect(rt.query('crm.wake.facts', {}, { actor: asUser(a.member), orgId: a.orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('answers ids, a kind, instants, days and an amount with exactly those keys, and none of the words the data holds', async () => {
    const o = await org('C');
    await o.thread();
    const stages = await rt.execute<unknown[]>('crm.pipeline.setup', {}, { actor: asUser(o.owner), orgId: o.orgId });
    void stages;
    const party = (await rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [o.orgId, CANARY]))[0]?.id;
    const deal = await rt.execute<Deal>('crm.deal.create', { partyId: party, title: `Hợp đồng ${CANARY}`, amount: '15000000', expectedClose: null }, { actor: asUser(o.owner), orgId: o.orgId });
    const draft = await rt.execute<{ id: string }>('crm.quote.save', { dealId: deal.id, lines: [{ kind: 'item', description: `Dòng ${CANARY}`, unit: 'cái', quantity: '1', unitPrice: '1000', vatRate: '10%' }] }, { actor: asUser(o.owner), orgId: o.orgId });
    await rows("UPDATE crove_crm.quote SET status = 'sent', number = 'BG-2026-0001', sent_at = now() - interval '8 days', sent_via = 'link', valid_until = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 30 WHERE org_id = $1 AND id = $2", [o.orgId, draft.id]);
    await worker.execute('crm.next_step.raise', {}, { actor: SYSTEM, orgId: o.orgId });
    const grantId = await o.grant(SCOPES);
    const conversations = await worker.query<EngageWakeConversations>('kernel.wake.conversations', { unansweredHours: 4, replyWindowHours: 3 }, { actor: o.actor(grantId), orgId: o.orgId });
    const crm = await worker.query<EngageWakeCrm>('crm.wake.facts', {}, { actor: o.actor(grantId), orgId: o.orgId });
    expect(Object.keys(conversations).sort()).toEqual(['comments', 'newInbound', 'replyWindow', 'unanswered']);
    for (const r of conversations.unanswered) expect(Object.keys(r).sort()).toEqual(['id', 'kind', 'since']);
    for (const r of conversations.replyWindow) expect(Object.keys(r).sort()).toEqual(['closesAt', 'id']);
    expect(crm.quoteSteps).toHaveLength(1);
    for (const r of crm.quoteSteps) expect(Object.keys(r).sort()).toEqual(['currency', 'dealAmount', 'dealId', 'sinceOn', 'stepId']);
    const text = JSON.stringify([conversations, crm]);
    for (const word of [CANARY, 'Canary', 'BG-2026', 'Hợp đồng', 'cần báo giá']) expect(text).not.toContain(word);
  });
});
