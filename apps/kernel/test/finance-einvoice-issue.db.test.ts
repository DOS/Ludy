// SPDX-License-Identifier: AGPL-3.0-only
// Issuing a sales e-invoice, the person's half (#2502, ADR-0044 points 3 and 4), on PostgreSQL 17: a draft is asked for approval with the hash of everything it is issued from, an owner
// or an admin approves (never the one who asked when another can), and only that approval moves it to `submitting`, through the definer crove_finance.einvoice_submit, for this draft,
// this content and this total. A direct call, another org's draft, a draft changed after the request, a person's own UPDATE and the job's own move are all refused in SQL.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { enterpriseCheckDigit } from '@crove/l10n-vn';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Series {
  id: string;
}
interface Draft {
  id: string;
  total: string;
  issues: Array<{ field: string; code: string }>;
}

// The seller's fake tax code (see the MST fixture guard).
const SELLER_TAX_CODE = '0101234564';
const PREFIX = '010010910';
const VALID_TAX_CODE = `${PREFIX}${enterpriseCheckDigit(PREFIX)}`;
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
const form = (seriesId: string | null, extra: Record<string, unknown> = {}) => ({
  draftId: null,
  legalEntityId: null,
  date: today(),
  seriesId,
  buyer: { kind: 'business', partyId: null, taxCode: VALID_TAX_CODE, name: 'Công ty Mua Thử', address: '1 Phố Thử, Hà Nội', email: null },
  lines: [
    { description: 'Hàng A', unit: 'cái', quantity: '2', unitPrice: '100000', vatRate: '10%' },
    { description: 'Hàng B', unit: null, quantity: '1.5', unitPrice: '33333', vatRate: '8%' },
  ],
  ...extra,
});

suite('issuing a sales e-invoice (#2502)', () => {
  const dbName = `crove_test_einvoice_issue_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
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
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows);
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@issue.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string | null; member: string; viewer: string };
  // A one-person org has only its owner (the one-person path of the four-eyes rule); the other has an admin too.
  async function org(options: { team: boolean; taxCode?: boolean; connection?: boolean }): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Phát Hành ${randomUUID().slice(0, 6)}`);
    const member = await identity('member');
    const viewer = await identity('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    // The org's tax code is its default entity's, and the entity has a connection to the offline provider under it: what the issue needs before it asks anyone.
    if (options.taxCode !== false) await execute({ orgId, owner }, 'kernel.org.set_tax_code', { taxCode: SELLER_TAX_CODE });
    if (options.connection !== false) {
      const channel = randomUUID();
      await admin(async (c) => {
        await c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, channel, 'einvoice_sandbox', `acct-${channel.slice(0, 8)}`, 'Hóa đơn thử', owner]);
        await c.query(`INSERT INTO crove_finance.einvoice_connection (org_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, 'einvoice_sandbox', $3)`, [orgId, channel, SELLER_TAX_CODE]);
      });
    }
    let adminUser: string | null = null;
    if (options.team) {
      adminUser = await identity('admin');
      await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser]));
    }
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Pick<Org, 'orgId' | 'owner'>, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const sync = async (o: Org) => (await execute<{ series: Series[] }>(o, 'finance.einvoice_series.sync', { legalEntityId: null, provider: 'sandbox' })).series[0]?.id ?? null;
  const save = (o: Org, seriesId: string | null, extra: Record<string, unknown> = {}, user = o.owner) => execute<Draft>(o, 'finance.einvoice_draft.save', form(seriesId, extra), user);
  const request = (o: Org, draftId: string, user = o.owner) => execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.einvoice.issue', input: { draftId } }, user);
  const approve = (o: Org, proposalId: string, user = o.owner) => execute<{ draftId: string; state: string }>(o, 'kernel.proposal.approve', { id: proposalId, revision: 1 }, user);
  const draftRow = async (o: Org, id: string) =>
    (await rows<{ state: string; submitted_at: Date | null; error_code: string | null; idempotency_key: string }>('SELECT state, submitted_at, error_code, idempotency_key FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, id]))[0];
  async function inContext<T>(o: Org, who: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, who, o.orgId);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  }
  async function asJob(o: Org, sqlText: string, params: unknown[] = []) {
    const c = await workerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
      const result = await c.query(sqlText, params);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
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
    const worker = new URL(adminUrl);
    worker.username = 'crove_worker';
    worker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: worker.toString(), max: 2 });
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('in a one-person org the owner asks and approves their own request, and the draft goes to submitting with its submit time', async () => {
    const o = await org({ team: false });
    const series = await sync(o);
    const draft = await save(o, series);
    const before = await draftRow(o, draft.id);
    expect(before).toMatchObject({ state: 'draft', submitted_at: null });
    const { proposalId } = await request(o, draft.id);
    const proposal = (await rows<{ command: string; kind: string; status: string; payload: Record<string, unknown>; legal_entity_id: string }>('SELECT command, kind, status, payload, legal_entity_id FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, proposalId]))[0];
    expect(proposal).toMatchObject({ command: 'finance.einvoice.issue', kind: 'finance.einvoice_issue', status: 'pending' });
    // The payload names the draft, the hash of what it is issued from, the total and the currency, and carries no buyer data and no entity.
    expect(proposal?.payload).toEqual({ draftId: draft.id, contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), amount: '274000', currency: 'VND', lineCount: 2 });
    expect(JSON.stringify(proposal?.payload)).not.toContain('Công ty Mua Thử');
    expect(await approve(o, proposalId)).toMatchObject({ draftId: draft.id, state: 'submitting' });
    const after = await draftRow(o, draft.id);
    expect(after).toMatchObject({ state: 'submitting', error_code: null, idempotency_key: before?.idempotency_key });
    expect(after?.submitted_at).toBeInstanceOf(Date);
    // Audited with ids and the total, never the buyer.
    const audit = await rows<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.einvoice.issue' AND outcome = 'ok'`, [o.orgId]);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ draftId: draft.id, total: '274000', currency: 'VND' });
    expect(JSON.stringify(audit[0]?.detail)).not.toContain('Công ty Mua Thử');
    // A draft that has left `draft` cannot be asked for again.
    await expect(request(o, draft.id)).rejects.toMatchObject({ code: 'EINVOICE_NOT_DRAFT' });
  });

  it('in a team the asker does not approve their own request: another owner or admin does, and a member or a viewer cannot', async () => {
    const o = await org({ team: true });
    const series = await sync(o);
    const draft = await save(o, series, {}, o.member);
    // A member asks (the preparer is for owners, admins and members); a viewer cannot.
    await expect(request(o, draft.id, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { proposalId } = await request(o, draft.id, o.member);
    await expect(approve(o, proposalId, o.member)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_ELIGIBLE/) });
    await expect(approve(o, proposalId, o.viewer)).rejects.toMatchObject({ code: expect.stringMatching(/FORBIDDEN|NOT_ELIGIBLE/) });
    expect((await draftRow(o, draft.id))?.state).toBe('draft');
    // An owner who asked cannot approve when an admin can.
    const second = await save(o, series);
    const asked = await request(o, second.id, o.owner);
    await expect(approve(o, asked.proposalId, o.owner)).rejects.toMatchObject({ code: 'FOUR_EYES_REQUIRED' });
    expect((await draftRow(o, second.id))?.state).toBe('draft');
    expect(await approve(o, asked.proposalId, o.admin ?? '')).toMatchObject({ state: 'submitting' });
    expect(await approve(o, proposalId, o.admin ?? '')).toMatchObject({ state: 'submitting' });
  });

  it('refuses to ask for a draft with no series, with issues, or already asked for, and says so before an approver is bothered', async () => {
    const o = await org({ team: false });
    const series = await sync(o);
    const noSeries = await save(o, null);
    await expect(request(o, noSeries.id)).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_INVALID' });
    const invalid = await save(o, series, { buyer: { kind: 'business', partyId: null, taxCode: '123', name: 'X', address: null, email: null } });
    expect(invalid.issues.length).toBeGreaterThan(0);
    await expect(request(o, invalid.id)).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_INVALID' });
    const ok = await save(o, series);
    const first = await request(o, ok.id);
    await expect(request(o, ok.id)).rejects.toMatchObject({ code: 'EINVOICE_ISSUE_PENDING', details: { proposalId: first.proposalId } });
  });

  it('refuses to ask before an approver is bothered when the entity has no tax code or no working connection', async () => {
    const noCode = await org({ team: false, taxCode: false, connection: false });
    const noCodeSeries = await sync(noCode);
    const draftA = await save(noCode, noCodeSeries);
    await expect(request(noCode, draftA.id)).rejects.toMatchObject({ code: 'EINVOICE_PROVIDER_NOT_READY' });
    const bare = await org({ team: false, connection: false });
    const bareDraft = await save(bare, await sync(bare));
    await expect(request(bare, bareDraft.id)).rejects.toMatchObject({ code: 'EINVOICE_PROVIDER_NOT_READY' });
    // A connection under a tax code the entity has not (a connection made with a typed code before the org had one).
    const typed = await org({ team: false, taxCode: false });
    const typedDraft = await save(typed, await sync(typed));
    await expect(request(typed, typedDraft.id)).rejects.toMatchObject({ code: 'EINVOICE_TAX_CODE_NEEDED' });
    // The entity's code changed since the connection was made.
    const changed = await org({ team: false });
    const changedDraft = await save(changed, await sync(changed));
    await execute(changed, 'kernel.org.set_tax_code', { taxCode: '0309876546' });
    await expect(request(changed, changedDraft.id)).rejects.toMatchObject({ code: 'EINVOICE_TAX_CODE_MISMATCH' });
    expect((await draftRow(changed, changedDraft.id))?.state).toBe('draft');
  });

  it('refuses a draft that was changed after the request, and nothing moves', async () => {
    const o = await org({ team: false });
    const series = await sync(o);
    const draft = await save(o, series);
    const { proposalId } = await request(o, draft.id);
    // The same draft, one more item: a new total and a new hash.
    await save(o, series, { draftId: draft.id, lines: [{ description: 'Hàng A', unit: 'cái', quantity: '3', unitPrice: '100000', vatRate: '10%' }] });
    await expect(approve(o, proposalId)).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_CHANGED' });
    expect((await draftRow(o, draft.id))?.state).toBe('draft');
    // A fresh request for the changed draft goes through.
    const again = await request(o, draft.id);
    expect(await approve(o, again.proposalId)).toMatchObject({ state: 'submitting' });
  });

  it('shows the Inbox card the draft as it stands, and says when it is no longer the one asked for', async () => {
    const o = await org({ team: true });
    const series = await sync(o);
    const draft = await save(o, series);
    const { proposalId } = await request(o, draft.id, o.member);
    const view = (user: string) => rt.query<Record<string, unknown>>('finance.einvoice.issue_request', { proposalId }, { actor: asUser(user), orgId: o.orgId });
    expect(await view(o.admin ?? '')).toMatchObject({ draftId: draft.id, state: 'draft', total: '274000', currency: 'VND', lineCount: 2, buyerKind: 'business', buyerName: 'Công ty Mua Thử', current: true });
    // The card shows what the approval sends besides the total: the buyer's tax code, every line with its VAT rate, the subtotal and the VAT.
    expect(await view(o.admin ?? '')).toMatchObject({
      buyerTaxCode: expect.any(String),
      subtotal: '250000',
      vatAmount: '24000',
      lines: [expect.objectContaining({ lineNo: 1, description: 'Hàng A', vatRate: '10%', amount: '200000', vatAmount: '20000' }), expect.objectContaining({ lineNo: 2, description: 'Hàng B', vatRate: '8%' })],
    });
    // Edited after the request: the card says the request is stale; an approval would be refused the same way.
    await save(o, series, { draftId: draft.id, lines: [{ description: 'Hàng A', unit: 'cái', quantity: '3', unitPrice: '100000', vatRate: '10%' }] });
    expect(await view(o.admin ?? '')).toMatchObject({ total: '330000', lineCount: 1, current: false });
    await expect(view(o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(rt.query('finance.einvoice.issue_request', { proposalId: randomUUID() }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_NOT_FOUND' });
  });

  it('hashes the content so that no text moves a boundary between two fields without changing the hash', async () => {
    const o = await org({ team: true });
    const series = await sync(o);
    const draft = await save(o, series);
    const hashWith = async (name: string, address: string) => {
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query('UPDATE crove_finance.einvoice_draft SET buyer_name = $3, buyer_address = $4 WHERE org_id = $1 AND id = $2', [o.orgId, draft.id, name, address]);
        await c.query('COMMIT');
      });
      return String((await rows<{ h: string }>('SELECT crove_finance.einvoice_content_hash($1, $2) AS h', [o.orgId, draft.id]))[0]?.h);
    };
    // The old separator inside a field, and the same characters split across the two fields, are two contents.
    const joined = await hashWith('Công ty A\u001fPhố B', 'Hà Nội');
    const split = await hashWith('Công ty A', 'Phố B\u001fHà Nội');
    expect(joined).toMatch(/^[0-9a-f]{64}$/);
    expect(joined).not.toBe(split);
    // And the same content is the same hash.
    expect(await hashWith('Công ty A', 'Phố B\u001fHà Nội')).toBe(split);
  });

  it('keeps the definer and the guard shut to everything but the approved execution', async () => {
    const o = await org({ team: true });
    const series = await sync(o);
    const draft = await save(o, series);
    const hash = String((await rows<{ h: string }>('SELECT crove_finance.einvoice_content_hash($1, $2) AS h', [o.orgId, draft.id]))[0]?.h);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const submit = (who: string, org_: Org, id: string, h: string) => inContext(org_, who, (c) => c.query('SELECT crove_finance.einvoice_submit($1, $2)', [id, h]));
    // A direct call by an owner, with the right hash, outside any approval.
    await expect(submit(o.owner, o, draft.id, hash)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('EINVOICE_ISSUE_FORBIDDEN') });
    // Another org's draft, even by that org's owner.
    const other = await org({ team: false });
    await expect(submit(other.owner, other, draft.id, hash)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('EINVOICE_ISSUE_FORBIDDEN') });
    // A member and a viewer, who are no approvers.
    await expect(submit(o.member, o, draft.id, hash)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('EINVOICE_ISSUE_FORBIDDEN') });
    // The function is the API login's alone: the tenant role, the worker login and PUBLIC cannot run it, and nor can they run the approval test it asks.
    const grants = await rows<{ app: boolean; worker: boolean; tenant: boolean; approved_app: boolean; approved_definer: boolean; owner: string }>(
      `SELECT has_function_privilege('crove_app', 'crove_finance.einvoice_submit(uuid, text)', 'EXECUTE') AS app,
              has_function_privilege('crove_worker', 'crove_finance.einvoice_submit(uuid, text)', 'EXECUTE') AS worker,
              has_function_privilege('public', 'crove_finance.einvoice_submit(uuid, text)', 'EXECUTE') AS tenant,
              has_function_privilege('crove_app', 'crove_finance.approved_execution(text, jsonb, numeric)', 'EXECUTE') AS approved_app,
              has_function_privilege('crove_definer_einvoice', 'crove_finance.approved_execution(text, jsonb, numeric)', 'EXECUTE') AS approved_definer,
              (SELECT proowner::regrole::text FROM pg_proc WHERE oid = 'crove_finance.einvoice_submit(uuid, text)'::regprocedure) AS owner`,
    );
    expect(grants[0]).toEqual({ app: true, worker: false, tenant: false, approved_app: false, approved_definer: true, owner: 'crove_definer_einvoice' });
    const shape = await rows<{ definer: boolean; config: string[]; login: boolean }>(
      `SELECT p.prosecdef AS definer, p.proconfig AS config, (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'crove_definer_einvoice') AS login
       FROM pg_proc p WHERE p.oid = 'crove_finance.einvoice_submit(uuid, text)'::regprocedure`,
    );
    expect(shape[0]).toEqual({ definer: true, config: ['search_path=pg_catalog, pg_temp'], login: false });
    // A person's own UPDATE: not the state, not the submit time, not any column of the issue, even as an owner.
    for (const sets of ["state = 'submitting'", "state = 'submitting', submitted_at = now()", 'submitted_at = now()', "error_code = 'X_Y'", "issued_number = '1'", 'check_attempts = 1', 'next_check_at = now()']) {
      await expect(inContext(o, o.owner, (c) => c.query(`UPDATE crove_finance.einvoice_draft SET ${sets} WHERE org_id = $1 AND id = $2`, [o.orgId, draft.id])), sets).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/EINVOICE_(FIELD_LOCKED|STATE)/) });
    }
    // The job's own move out of `draft` is refused too: the first step is a person's approved issue.
    await expect(asJob(o, "UPDATE crove_finance.einvoice_draft SET state = 'submitting', submitted_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, draft.id])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('EINVOICE_STATE') });
    expect((await draftRow(o, draft.id))?.state).toBe('draft');
  });

  it('writes no line to a draft once it is submitting, and an approved issue waits for a line being written', async () => {
    const o = await org({ team: false });
    const series = await sync(o);
    const draft = await save(o, series);
    const { proposalId } = await request(o, draft.id);
    await approve(o, proposalId);
    await expect(save(o, series, { draftId: draft.id })).rejects.toMatchObject({ code: expect.stringMatching(/EINVOICE_NOT_DRAFT|NOT_DRAFT/) });
    await expect(asJob(o, "UPDATE crove_finance.einvoice_draft_line SET description = 'x' WHERE org_id = $1 AND draft_id = $2", [o.orgId, draft.id])).rejects.toMatchObject({ message: expect.stringContaining('EINVOICE_NOT_DRAFT') });
    // The job's moves from `submitting` carry the new columns: the number, the time and the files come with the state, once; the submit time stays as it was.
    await asJob(o, "UPDATE crove_finance.einvoice_draft SET state = 'pending', provider_ref = 'sbx-1', next_check_at = now() + interval '1 minute', check_attempts = 1 WHERE org_id = $1 AND id = $2", [o.orgId, draft.id]);
    await expect(asJob(o, "UPDATE crove_finance.einvoice_draft SET state = 'issued', issued_number = 'C26TAA/7', issued_at = now(), submitted_at = now() + interval '1 hour' WHERE org_id = $1 AND id = $2", [o.orgId, draft.id])).rejects.toMatchObject({ message: expect.stringContaining('EINVOICE_STATE') });
    await asJob(o, "UPDATE crove_finance.einvoice_draft SET state = 'issued', issued_number = 'C26TAA/7', issued_at = now(), authority_code = 'SBX-AUTH', next_check_at = NULL WHERE org_id = $1 AND id = $2", [o.orgId, draft.id]);
    await expect(asJob(o, "UPDATE crove_finance.einvoice_draft SET issued_number = 'C26TAA/8' WHERE org_id = $1 AND id = $2", [o.orgId, draft.id])).rejects.toMatchObject({ message: expect.stringContaining('EINVOICE_STATE') });
    expect(await draftRow(o, draft.id)).toMatchObject({ state: 'issued' });
  });
});
