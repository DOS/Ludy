// SPDX-License-Identifier: AGPL-3.0-only
// The company a person may work at (#2438, PR 3) on PostgreSQL 17: the three rules of crm.contact.company_candidates (a tax code the person wrote in their
// conversations, the same email domain, a name that carries the word at the heart of the domain), each read as the member and each company once, under the first
// rule that found it; no suggestion for a person who has a company, for a company, for a merged party, across orgs or for a viewer. Nothing is written. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { CompanyCandidates } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Checksum-invalid tax codes on purpose (#157).
const ACME_TAX = '0123456780';

suite('the company a person may work at (#2438, PR 3)', () => {
  const dbName = `crove_test_company_suggest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@company.test`, name: null });
  type Org = { orgId: string; owner: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const member = await identity('member');
    const viewer = await identity('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    return { orgId, owner, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const create = (o: Org, input: Record<string, unknown>) => execute<{ partyId: string; version: number }>(o, 'kernel.party.create', input);
  const found = (o: Org, partyId: string, user = o.member) => rt.query<CompanyCandidates>('crm.contact.company_candidates', { partyId }, { actor: asUser(user), orgId: o.orgId });
  const names = (list: Array<{ name: string }>) => list.map((c) => c.name);
  // A thread the person is linked to, with the messages of the customer (and, if asked, ours). A private message is read by owners and admins only (the
  // database's rule); a comment thread by every member who may use its channel.
  async function thread(o: Org, partyId: string, messages: Array<{ body: string; direction?: 'in' | 'out' }>, kind: 'direct' | 'comment_thread' = 'direct') {
    const connection = randomUUID();
    const conversation = randomUUID();
    await admin(async (c) => {
      await c.query("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'sandbox', $3, 'Kênh thử', $4)", [o.orgId, connection, `acct-${randomUUID().slice(0, 8)}`, o.owner]);
      await c.query("INSERT INTO crove_kernel.conversation (org_id, id, channel_connection_id, kind, external_thread_id, party_id) VALUES ($1, $2, $3, $4, $5, $6)", [o.orgId, conversation, connection, kind, `t-${randomUUID().slice(0, 8)}`, partyId]);
      let seq = 0;
      for (const m of messages) {
        seq += 1;
        const out = m.direction === 'out';
        await c.query(
          'INSERT INTO crove_kernel.conversation_message (org_id, conversation_id, channel_connection_id, kind, seq, direction, sent_at, author_kind, author_user_id, send_state, body) VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10)',
          [o.orgId, conversation, connection, kind, seq, out ? 'out' : 'in', out ? 'member' : 'contact', out ? o.owner : null, out ? 'sent' : null, m.body],
        );
      }
    });
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

  it('finds the company that writes from the same domain, and none for a free mail address or no address', async () => {
    const o = await org();
    await create(o, { kind: 'organization', name: 'Công ty Acme', email: 'lienhe@acme.test' });
    await create(o, { kind: 'organization', name: 'Công ty Khác', email: 'info@khac.test' });
    const nam = await create(o, { kind: 'person', name: 'Nam Trần', email: 'Nam.Tran@ACME.test' });
    const free = await create(o, { kind: 'person', name: 'Bình Lê', email: ['binh', 'gmail.com'].join('@') });
    const none = await create(o, { kind: 'person', name: 'Chi Võ' });
    const result = await found(o, nam.partyId);
    expect(names(result.emailDomain)).toEqual(['Công ty Acme']);
    expect(result).toMatchObject({ personName: 'Nam Trần', label: 'acme', taxCode: [] });
    for (const quiet of [free, none]) expect(await found(o, quiet.partyId)).toMatchObject({ label: null, taxCode: [], emailDomain: [], names: [] });
  });

  it('finds the companies whose name carries the word of the domain, each once, and not one already found by the domain', async () => {
    const o = await org();
    await create(o, { kind: 'organization', name: 'Công ty TNHH Acme Việt Nam' });
    await create(o, { kind: 'organization', name: 'Acme Logistics' });
    await create(o, { kind: 'organization', name: 'Acmeron Foods' });
    await create(o, { kind: 'organization', name: 'Công ty Không Liên Quan' });
    await create(o, { kind: 'organization', name: 'ACME Domain', email: 'info@acme.test' });
    const hr = await create(o, { kind: 'person', name: 'Hà Phạm', email: 'ha@mail.acme.test' });
    const result = await found(o, hr.partyId);
    // The word is a whole word of the name ("Acmeron" is not "acme"), and a company the domain found is not offered again by its name.
    expect(names(result.emailDomain)).toEqual([]);
    expect(names(result.names)).toEqual(['ACME Domain', 'Acme Logistics', 'Công ty TNHH Acme Việt Nam']);
    const same = await create(o, { kind: 'person', name: 'Hùng Đỗ', email: 'hung@acme.test' });
    const second = await found(o, same.partyId);
    expect(names(second.emailDomain)).toEqual(['ACME Domain']);
    expect(names(second.names)).toEqual(['Acme Logistics', 'Công ty TNHH Acme Việt Nam']);
  });

  it('finds the company whose tax code the person wrote in their own messages, as the first rule, and not one in a message of ours or of someone else', async () => {
    const o = await org();
    const acme = await create(o, { kind: 'organization', name: 'Công ty Acme', taxCode: ACME_TAX, email: 'lienhe@acme.test' });
    await create(o, { kind: 'organization', name: 'Công ty Beta', taxCode: '0305551110' });
    const nam = await create(o, { kind: 'person', name: 'Nam Trần', email: 'nam@acme.test' });
    const other = await create(o, { kind: 'person', name: 'Người Khác' });
    await thread(o, nam.partyId, [{ body: `Cho em xuất hóa đơn, MST ${ACME_TAX} nhé` }, { body: 'Beta là công ty bên em, MST 0305551110 của đối tác', direction: 'out' }]);
    await thread(o, other.partyId, [{ body: 'MST 0305551110' }]);
    // A private message is read by owners and admins only: a member, whose database role cannot read it, gets no company from it.
    expect((await found(o, nam.partyId, o.member)).taxCode).toEqual([]);
    const result = await found(o, nam.partyId, o.owner);
    expect(result.taxCode).toEqual([{ partyId: acme.partyId, name: 'Công ty Acme' }]);
    // Under the first rule that found it: the same company is not offered again by its domain.
    expect(result.emailDomain).toEqual([]);
    expect(result.names).toEqual([]);
    // A comment thread is read by every member of the channel: the member finds the company from it.
    const comment = await create(o, { kind: 'person', name: 'Quân Hồ' });
    await thread(o, comment.partyId, [{ body: 'Xuất cho công ty Beta MST 0305551110' }], 'comment_thread');
    expect(names((await found(o, comment.partyId, o.member)).taxCode)).toEqual(['Công ty Beta']);
  });

  it('finds the company of a tax code written with its branch suffix, and one only a merged party holds is not offered', async () => {
    const o = await org();
    const acme = await create(o, { kind: 'organization', name: 'Công ty Acme', taxCode: ACME_TAX });
    const copy = await create(o, { kind: 'organization', name: 'Acme (bản sao)', email: 'info@acme.test' });
    const nam = await create(o, { kind: 'person', name: 'Nam Trần', email: 'nam@acme.test' });
    await thread(o, nam.partyId, [{ body: `Chi nhánh MST ${ACME_TAX}-001` }]);
    expect(names((await found(o, nam.partyId, o.owner)).taxCode)).toEqual(['Công ty Acme']);
    await execute(o, 'kernel.party.mark_duplicate', { partyId: copy.partyId, keepId: acme.partyId });
    const after = await found(o, nam.partyId, o.owner);
    expect(after.emailDomain).toEqual([]);
    expect(names(after.names)).toEqual([]);
  });

  it('has no suggestion for a person who has a company, a company, or a party that is not in the org, and none across orgs', async () => {
    const o = await org();
    const other = await org();
    const acme = await create(o, { kind: 'organization', name: 'Công ty Acme', email: 'lienhe@acme.test' });
    await create(other, { kind: 'organization', name: 'Acme của org khác', email: 'info@acme.test' });
    const linked = await create(o, { kind: 'person', name: 'Nam Trần', email: 'nam@acme.test' });
    const lone = await create(other, { kind: 'person', name: 'Lan Tô', email: 'lan@acme.test' });
    // The other org's company never reaches this org's person, whatever the domain.
    expect(names((await found(o, linked.partyId)).emailDomain)).toEqual(['Công ty Acme']);
    expect(names((await found(other, lone.partyId)).emailDomain)).toEqual(['Acme của org khác']);
    await execute(o, 'kernel.party.set_company', { partyId: linked.partyId, companyId: acme.partyId, version: linked.version });
    expect(await found(o, linked.partyId)).toMatchObject({ taxCode: [], emailDomain: [], names: [] });
    expect(await found(o, acme.partyId)).toMatchObject({ taxCode: [], emailDomain: [], names: [] });
    // A party of another org is not found at all.
    await expect(found(o, lone.partyId)).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND', status: 404 });
  });

  it('refuses a viewer, writes nothing, and lets a member read it', async () => {
    const o = await org();
    await create(o, { kind: 'organization', name: 'Công ty Acme', email: 'lienhe@acme.test' });
    const nam = await create(o, { kind: 'person', name: 'Nam Trần', email: 'nam@acme.test' });
    const before = Number((await admin((c) => c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1', [o.orgId]))).rows[0]?.n);
    await expect(found(o, nam.partyId, o.viewer)).rejects.toMatchObject({ status: 403 });
    expect((await found(o, nam.partyId, o.member)).emailDomain).toHaveLength(1);
    const after = Number((await admin((c) => c.query<{ n: number }>('SELECT count(*)::int AS n FROM crove_kernel.audit_event WHERE org_id = $1', [o.orgId]))).rows[0]?.n);
    expect(after).toBe(before);
    expect((await admin((c) => c.query<{ company_id: string | null }>('SELECT company_id FROM crove_kernel.party WHERE id = $1', [nam.partyId]))).rows[0]?.company_id).toBeNull();
  });
});
