// SPDX-License-Identifier: AGPL-3.0-only
// Security invariants for kernel.conversation.personal_data_find (#3669) on PostgreSQL 17:
// - Owners and admins alone may run the command; members, viewers, and non-user actors (worker/system) are refused 403.
// - Searches never cross org boundaries even when another org has the same email, WhatsApp number, or CRM contact.
// - Audit rows store only { kind, matches, truncated } and never log the searched value or customer PII.
// Part of the invariant suite: imports only package code under test and ./fixtures/.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { ConversationPersonalDataResult } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('conversation personal-data authorization, tenancy, and zero-PII audit invariants (#3669)', () => {
  const dbName = `ludy_inv_conv_pd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers;
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });

  async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => withAdmin(async (c) => (await c.query<T>(text, params)).rows);

  async function seedOrgWithRoles() {
    const db = createDb(pool);
    const makeUser = async (tag: string) =>
      (await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${tag}-${randomUUID().slice(0, 8)}@inv-conv-pd.test`, name: null })) as string;
    const [owner, adm, member, viewer] = [await makeUser('owner'), await makeUser('admin'), await makeUser('member'), await makeUser('viewer')];
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
        [orgId, adm, member, viewer],
      ),
    );
    return { orgId, owner, admin: adm, member, viewer };
  }

  async function seedEmailAndWa(orgId: string, owner: string, tag: string): Promise<{ emailId: string; waId: string; linkedFbId: string }> {
    const [emCh] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.channel_connection (org_id, provider, external_account_id, display_name, status, connected_by)
       VALUES ($1, 'email', 'inbox', 'Email', 'active', $2) RETURNING id`,
      [orgId, owner],
    );
    const [waCh] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.channel_connection (org_id, provider, external_account_id, display_name, status, connected_by)
       VALUES ($1, 'whatsapp', $2, 'WhatsApp Hỗ Trợ', 'active', $3) RETURNING id`,
      [orgId, `wa-${randomUUID().slice(0, 8)}`, owner],
    );
    const [fbCh] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.channel_connection (org_id, provider, external_account_id, display_name, status, connected_by)
       VALUES ($1, 'facebook_page', $2, 'Trang FB', 'active', $3) RETURNING id`,
      [orgId, `fb-${randomUUID().slice(0, 8)}`, owner],
    );
    const [party] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.party (org_id, kind, name, email, phone) VALUES ($1, 'person', $2, 'shared@example.test', '+84 901 234 567') RETURNING id`,
      [orgId, `Liên hệ ${tag}`],
    );
    if (!emCh || !waCh || !fbCh || !party) throw new Error('failed to seed channels or party');
    const [emIdentity] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.conversation_identity (org_id, provider, external_user_id, display_name)
       VALUES ($1, 'email', 'shared@example.test', $2) RETURNING id`,
      [orgId, `Khách Email ${tag}`],
    );
    const [waIdentity] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.conversation_identity (org_id, provider, external_user_id, display_name)
       VALUES ($1, 'whatsapp', '84901234567', $2) RETURNING id`,
      [orgId, `Khách WA ${tag}`],
    );
    const [fbIdentity] = await rows<{ id: string }>(
      `INSERT INTO ludy_kernel.conversation_identity (org_id, provider, external_user_id, display_name, party_id)
       VALUES ($1, 'facebook_page', 'fb-shared-psid', $2, $3) RETURNING id`,
      [orgId, `Khách FB ${tag}`, party.id],
    );
    if (!emIdentity || !waIdentity || !fbIdentity) throw new Error('failed to seed identities');
    await rows(
      `INSERT INTO ludy_kernel.conversation (org_id, channel_connection_id, kind, external_thread_id, identity_id, status, last_seq, last_message_at, last_inbound_at)
       VALUES ($1, $2, 'email', $3, $4, 'new', 1, now(), now()),
              ($1, $5, 'direct', $6, $7, 'new', 1, now(), now()),
              ($1, $8, 'direct', $9, $10, 'new', 1, now(), now())`,
      [
        orgId,
        emCh.id,
        `em-${randomUUID().slice(0, 8)}`,
        emIdentity.id,
        waCh.id,
        `wa-${randomUUID().slice(0, 8)}`,
        waIdentity.id,
        fbCh.id,
        `fb-${randomUUID().slice(0, 8)}`,
        fbIdentity.id,
      ],
    );
    return { emailId: emIdentity.id, waId: waIdentity.id, linkedFbId: fbIdentity.id };
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' }, dbIds);
    const loginUrl = (role: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = dbIds.roleName(role);
      url.password = password;
      return url.toString();
    };
    pool = createDbPool({ connectionString: loginUrl('ludy_app', 'test-app-pw'), max: 4 }, dbIds);
    workerPool = createDbPool({ connectionString: loginUrl('ludy_worker', 'test-worker-pw'), max: 2 }, dbIds);
    const registry = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register(registry);
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
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

  it('denies members, viewers, and worker system actors, isolates orgs, and audits without PII', async () => {
    const orgA = await seedOrgWithRoles();
    const orgB = await seedOrgWithRoles();
    const aIds = await seedEmailAndWa(orgA.orgId, orgA.owner, 'OrgA');
    const bIds = await seedEmailAndWa(orgB.orgId, orgB.owner, 'OrgB');

    // Member and viewer are refused on user runtime; system actor is refused on worker runtime.
    for (const actor of [asUser(orgA.member), asUser(orgA.viewer)]) {
      await expect(
        rt.execute('kernel.conversation.personal_data_find', { value: 'shared@example.test' }, { actor, orgId: orgA.orgId }),
      ).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      workerRt.execute(
        'kernel.conversation.personal_data_find',
        { value: 'shared@example.test' },
        { actor: { type: 'system', component: 'conversations' }, orgId: orgA.orgId },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Owner and admin in Org A find only Org A email/WhatsApp/linked-party matches, never Org B.
    const emailOwner = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: '  SHARED@Example.TEST ' },
      { actor: asUser(orgA.owner), orgId: orgA.orgId },
    );
    expect(emailOwner.items.map((x) => x.identityId).sort()).toEqual([aIds.emailId, aIds.linkedFbId].sort());
    expect(emailOwner.items.map((x) => x.identityId)).not.toContain(bIds.emailId);
    expect(emailOwner.items.map((x) => x.identityId)).not.toContain(bIds.linkedFbId);

    const phoneAdmin = await rt.execute<ConversationPersonalDataResult>(
      'kernel.conversation.personal_data_find',
      { value: '0901234567' },
      { actor: asUser(orgA.admin), orgId: orgA.orgId },
    );
    expect(phoneAdmin.items.map((x) => x.identityId).sort()).toEqual([aIds.waId, aIds.linkedFbId].sort());
    expect(phoneAdmin.items.map((x) => x.identityId)).not.toContain(bIds.waId);

    // Every audit row holds only kind, matches, truncated and never contains PII.
    const audits = await rows<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.conversation.personal_data_find' AND outcome = 'ok' ORDER BY id DESC`,
      [orgA.orgId],
    );
    expect(audits).toHaveLength(2);
    for (const row of audits) {
      const text = JSON.stringify(row.detail);
      for (const secret of ['shared@example.test', '0901234567', '84901234567', 'Khách Email OrgA', 'Liên hệ OrgA', 'fb-shared-psid']) {
        expect(text).not.toContain(secret);
      }
    }
    expect(audits[0]?.detail).toEqual({ kind: 'digits', matches: 2, truncated: false });
    expect(audits[1]?.detail).toEqual({ kind: 'email', matches: 2, truncated: false });
  });
});
