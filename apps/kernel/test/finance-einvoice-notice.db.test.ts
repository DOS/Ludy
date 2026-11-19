// SPDX-License-Identifier: AGPL-3.0-only
// The notice of an error only in the non-core content of an issued sales e-invoice (#2504, plan einvoice-issue.md section 8): the buyer's name or address, or the amount in words. No new
// invoice is made. The error is recorded with the text that is right and two steps the seller does outside Ludy (tell the buyer; file the form 04/SS-HĐĐT, a working answer of #2506), each
// ticked once by a person. Nothing is sent. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { createSandboxEInvoiceProvider, type EInvoiceProvider } from '@ludy/einvoice';
import type { ExtractClient } from '@ludy/extract-contract';
import { enterpriseCheckDigit } from '@ludy/l10n-vn';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@ludy/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, useCorrectionReasonCodes } from '@ludy/mod-finance';
import { runEInvoiceIssue } from '../src/einvoice-issue-job.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// The seller's fake tax code (see the MST fixture guard) and the buyer's, made at run time with a valid check digit.
const SELLER_TAX_CODE = '0101234564';
const PREFIX = '010010910';
const BUYER_TAX_CODE = `${PREFIX}${enterpriseCheckDigit(PREFIX)}`;
const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

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

interface DraftRow {
  state: string;
  provider_ref: string | null;
  issued_number: string | null;
  authority_code: string | null;
  signed_file_id: string | null;
  pdf_file_id: string | null;
  error_code: string | null;
  idempotency_key: string;
  next_check_at: Date | null;
  check_attempts: number;
  submitted_at: Date | null;
}

suite('the notice of an error in the non-core content of an issued sales e-invoice (#2504)', () => {
  const dbName = `crove_test_einvoice_notice_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
  const broker = {} as CredentialBroker;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@job.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; entityId: string; seriesId: string };
  async function org(options: { connection: boolean } = { connection: true }): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Hóa Đơn ${randomUUID().slice(0, 6)}`);
    const adminUser = await identity('admin');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser]));
    // The org's tax code is its default entity's (kernel.org.set_tax_code keeps the two the same).
    await execute({ orgId, owner }, 'kernel.org.set_tax_code', { taxCode: SELLER_TAX_CODE });
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id ?? '';
    if (options.connection) {
      const channel = randomUUID();
      await admin(async (c) => {
        await c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, channel, 'einvoice_sandbox', `acct-${channel.slice(0, 8)}`, 'Hóa đơn thử', owner]);
        await c.query(`INSERT INTO crove_finance.einvoice_connection (org_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, 'einvoice_sandbox', $3)`, [orgId, channel, SELLER_TAX_CODE]);
      });
    }
    const o = { orgId, owner, admin: adminUser, entityId: entity, seriesId: '' };
    const synced = await execute<{ series: Array<{ id: string }> }>(o, 'finance.einvoice_series.sync', { legalEntityId: null, provider: 'sandbox' });
    o.seriesId = synced.series[0]?.id ?? '';
    return o;
  }
  const execute = <T>(o: { orgId: string; owner: string }, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const form = (o: Org) => ({
    draftId: null,
    legalEntityId: null,
    date: today(),
    seriesId: o.seriesId,
    buyer: { kind: 'business', partyId: null, taxCode: BUYER_TAX_CODE, name: 'Công ty Mua Thử', address: '1 Phố Thử, Hà Nội', email: null },
    lines: [
      { description: 'Hàng A', unit: 'cái', quantity: '2', unitPrice: '100000', vatRate: '10%' },
      { description: 'Hàng B', unit: null, quantity: '1.5', unitPrice: '33333', vatRate: '8%' },
    ],
  });
  const draftRow = async (o: Org, id: string) =>
    (
      await rows<DraftRow>(
        'SELECT state, provider_ref, issued_number, authority_code, signed_file_id, pdf_file_id, error_code, idempotency_key, next_check_at, check_attempts, submitted_at FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2',
        [o.orgId, id],
      )
    )[0] as DraftRow;
  const run = (o: Org, draftId: string, provider: EInvoiceProvider) => runEInvoiceIssue({ runtime: worker, broker, store, providers: { sandbox: provider } }, { orgId: o.orgId, draftId });

  beforeAll(async () => {
    extract = inProcessExtract();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const register = (target: Db) =>
      new Runtime(target, { manifests: TEST_MANIFESTS }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    rt = register(db);
    worker = register(createDb(workerPool));
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


  const REASONS = [{ code: '1', label: 'Sai thông tin người mua' }];
  beforeAll(() => useCorrectionReasonCodes(REASONS));
  afterAll(() => useCorrectionReasonCodes(null));

  const sandbox = () => createSandboxEInvoiceProvider({ reasonCodes: REASONS });
  const approve = async (o: Org, draftId: string) => {
    const { proposalId } = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.einvoice.issue', input: { draftId } });
    await execute(o, 'kernel.proposal.approve', { id: proposalId, revision: 1 }, o.admin);
  };
  // Reads the signed XML of an issued draft through the intake and approves the sale it proposes: the posted document.
  async function post(o: Org, draftId: string): Promise<string> {
    const fileId = (await draftRow(o, draftId)).signed_file_id;
    const read = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => today() }, o.orgId, String(fileId));
    const approved = await rt.execute<{ documentId: string }>('kernel.proposal.approve', { acceptUnverifiedSignature: true, acceptFailedChecks: true, id: String(read.proposalId), revision: 1 }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    return approved.documentId;
  }
  // An invoice issued and posted the ordinary way: the draft, and the document in the ledger.
  async function issued(o: Org, p: ReturnType<typeof sandbox>, buyer: 'business' | 'individual' = 'business'): Promise<{ draftId: string; documentId: string }> {
    const base = form(o);
    const input = buyer === 'business' ? base : { ...base, buyer: { kind: 'individual', partyId: null, taxCode: null, name: 'Anh Nam', address: null, email: null } };
    const draft = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', input);
    await approve(o, draft.id);
    expect(await run(o, draft.id, p.provider)).toMatchObject({ state: 'issued' });
    return { draftId: draft.id, documentId: await post(o, draft.id) };
  }
  const refusal = async (promise: Promise<unknown>) => promise.then(() => 'accepted', (error: { code?: string }) => error.code);
  type Notice = { id: string; draftId: string; field: string; correctText: string; buyerNoticeState: string; buyerNotifiedAt: string | null; formState: string; formFiledAt: string | null };
  const open = (o: Org, draftId: string, field = 'buyer_name', correctText = 'Công ty Mua Thử Mới', user = o.owner) => execute<Notice>(o, 'finance.einvoice.notice_open', { draftId, field, correctText }, user);

  it('records an error on an issued invoice with the right text and two steps to do, ticks each once, and makes no new invoice', async () => {
    const o = await org();
    const original = await issued(o, sandbox());
    const before = (await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_finance.einvoice_draft WHERE org_id = $1', [o.orgId]))[0]?.n;
    const notice = await open(o, original.draftId, 'buyer_address', '2 Phố Thử, Hà Nội');
    expect(notice).toMatchObject({ draftId: original.draftId, field: 'buyer_address', correctText: '2 Phố Thử, Hà Nội', buyerNoticeState: 'todo', buyerNotifiedAt: null, formState: 'todo', formFiledAt: null });
    // No invoice was made and the original is untouched.
    expect((await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_finance.einvoice_draft WHERE org_id = $1', [o.orgId]))[0]?.n).toBe(before);
    expect((await draftRow(o, original.draftId)).state).toBe('issued');

    const sent = await execute<Notice>(o, 'finance.einvoice.notice_step', { noticeId: notice.id, step: 'buyer_notice' });
    expect(sent).toMatchObject({ buyerNoticeState: 'sent', buyerNotifiedAt: expect.any(String), formState: 'todo' });
    // Ticking again changes nothing, the time included.
    const again = await execute<Notice>(o, 'finance.einvoice.notice_step', { noticeId: notice.id, step: 'buyer_notice' });
    expect(again.buyerNotifiedAt).toBe(sent.buyerNotifiedAt);
    const filed = await execute<Notice>(o, 'finance.einvoice.notice_step', { noticeId: notice.id, step: 'tax_form' });
    expect(filed).toMatchObject({ buyerNoticeState: 'sent', formState: 'filed', formFiledAt: expect.any(String) });

    const list = await rt.query<{ reference: { number: string; templateNo: string | null; symbol: string | null; buyerName: string | null }; notices: Notice[] }>('finance.einvoice.notice_list', { draftId: original.draftId }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(list.notices.map((n) => n.id)).toEqual([notice.id]);
    expect(list.reference).toMatchObject({ number: expect.any(String), templateNo: expect.any(String), symbol: expect.any(String), buyerName: 'Công ty Mua Thử' });
  });

  it('refuses an invoice that is not issued, an unknown notice and a viewer, and keeps the text that is right out of the audit', async () => {
    const o = await org();
    const draft = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', form(o));
    expect(await refusal(open(o, draft.id))).toBe('EINVOICE_ORIGINAL_NOT_ISSUED');
    expect(await refusal(open(o, randomUUID()))).toBe('EINVOICE_DRAFT_NOT_FOUND');
    expect(await refusal(execute(o, 'finance.einvoice.notice_step', { noticeId: randomUUID(), step: 'tax_form' }))).toBe('EINVOICE_NOTICE_NOT_FOUND');
    const original = await issued(o, sandbox());
    const viewer = await identity('viewer');
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [o.orgId, viewer]);
    expect(await refusal(open(o, original.draftId, 'buyer_name', 'Tên khác', viewer))).toBe('FORBIDDEN');
    const notice = await open(o, original.draftId, 'buyer_name', 'Tên Riêng Rất Đặc Biệt');
    const audit = JSON.stringify(await rows("SELECT (detail::text || coalesce(target_id::text, '') || coalesce(input_sha256, '')) AS blob FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'finance.einvoice.notice%'", [o.orgId]));
    expect(audit).toContain(notice.id);
    expect(audit).not.toContain('Tên Riêng Rất Đặc Biệt');
  });

  it('is held by the database too: only a step moves, once, and nothing is deleted', async () => {
    const o = await org();
    const original = await issued(o, sandbox());
    const notice = await open(o, original.draftId);
    // The field, the text and the invoice are fixed; a step is never taken back.
    await expect(rows("UPDATE crove_finance.einvoice_notice SET correct_text = 'x' WHERE org_id = $1 AND id = $2", [o.orgId, notice.id])).rejects.toThrow();
    await execute(o, 'finance.einvoice.notice_step', { noticeId: notice.id, step: 'tax_form' });
    await expect(rows("UPDATE crove_finance.einvoice_notice SET form_state = 'todo', form_filed_at = NULL WHERE org_id = $1 AND id = $2", [o.orgId, notice.id])).rejects.toThrow();
  });

  it('keeps a notice when its author leaves the org: created_by is cleared and nothing else moves', async () => {
    const o = await org();
    const original = await issued(o, sandbox());
    const author = await identity('author');
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, author]);
    const notice = await open(o, original.draftId, 'buyer_name', 'Tên Mới', author);
    await rows('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [o.orgId, author]);
    const [row] = await rows<{ created_by: string | null; correct_text: string }>('SELECT created_by, correct_text FROM crove_finance.einvoice_notice WHERE org_id = $1 AND id = $2', [o.orgId, notice.id]);
    expect(row).toEqual({ created_by: null, correct_text: 'Tên Mới' });
  });
});
