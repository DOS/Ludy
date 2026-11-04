// SPDX-License-Identifier: AGPL-3.0-only
// The issue job of a sales e-invoice (#2502, ADR-0044 points 3 to 5), on PostgreSQL 17 with the offline provider: an approved draft is sent (the call committed to the ledger first),
// issued, its signed XML and PDF stored as evidence naming the draft's entity, and the XML read through the ordinary intake into a sale of that entity; a pending invoice is asked
// about until it answers or the day ends; a rejection sends the draft back with a new key; a lost answer is asked about by the key before anything is sent again; a seller's tax
// code that changed, a draft with no connection and a draft whose figures no longer match stop before any call. Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { EInvoiceProviderError, createSandboxEInvoiceProvider, type EInvoiceProvider } from '@crove/einvoice';
import type { ExtractClient } from '@crove/extract-contract';
import { enterpriseCheckDigit } from '@crove/l10n-vn';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@crove/mod-finance';
import { runEInvoiceIssue } from '../src/einvoice-issue-job.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// The seller's fake tax code (see the MST fixture guard) and the buyer's, made at run time with a valid check digit.
const SELLER_TAX_CODE = '0101234564';
const OTHER_TAX_CODE = '0309876546';
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

suite('the issue job of a sales e-invoice (#2502)', () => {
  const dbName = `crove_test_einvoice_job_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  // A change the guards would refuse, made as the database owner with the triggers off (a test fixture: the time passing, an edit that cannot happen).
  const fixture = (text: string, values: unknown[]) =>
    admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(text, values);
      await c.query('COMMIT');
    });
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
  // A draft asked for and approved the way a person does it: it ends `submitting`.
  async function submitted(o: Org): Promise<string> {
    const draft = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', form(o));
    const { proposalId } = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.einvoice.issue', input: { draftId: draft.id } });
    await execute(o, 'kernel.proposal.approve', { id: proposalId, revision: 1 }, o.admin);
    return draft.id;
  }
  const draftRow = async (o: Org, id: string) =>
    (
      await rows<DraftRow>(
        'SELECT state, provider_ref, issued_number, authority_code, signed_file_id, pdf_file_id, error_code, idempotency_key, next_check_at, check_attempts, submitted_at FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2',
        [o.orgId, id],
      )
    )[0] as DraftRow;
  const calls = (o: Org) => rows<{ key: string; step: string; state: string; calls: number }>("SELECT key, step, state, calls FROM crove_kernel.external_call WHERE org_id = $1 AND key LIKE 'einvoice:%' ORDER BY started_at, key", [o.orgId]);
  const run = (o: Org, draftId: string, provider: EInvoiceProvider) => runEInvoiceIssue({ runtime: worker, broker, store, providers: { sandbox: provider } }, { orgId: o.orgId, draftId });
  const due = (o: Org, draftId: string) => fixture('UPDATE crove_finance.einvoice_draft SET next_check_at = pg_catalog.now() - interval \'1 second\' WHERE org_id = $1 AND id = $2', [o.orgId, draftId]);

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

  it('sends an approved draft, issues it, stores the signed XML as evidence in the draft\'s entity and reads it into a sale', async () => {
    const o = await org();
    const draftId = await submitted(o);
    const key = (await draftRow(o, draftId)).idempotency_key;
    const { provider, control } = createSandboxEInvoiceProvider();
    expect(await run(o, draftId, provider)).toEqual({ action: 'issue', state: 'issued' });
    const row = await draftRow(o, draftId);
    expect(row).toMatchObject({ state: 'issued', provider_ref: expect.any(String), issued_number: expect.any(String), authority_code: expect.any(String), error_code: null });
    expect(row.signed_file_id).toEqual(expect.any(String));
    // The sandbox received the issue once, under the draft's own key.
    expect(control.calls.filter((c) => c.startsWith('issue'))).toHaveLength(1);
    // The ledger: the issue committed and ended, the files call ended; nothing else.
    expect((await calls(o)).map((c) => [c.key, c.step, c.state])).toEqual([
      [`einvoice:issue:${key}`, 'issue', 'succeeded'],
      [`einvoice:files:${key}`, 'files', 'succeeded'],
    ]);
    // The XML is a file of the org filed in the draft's entity, and it is the same bytes the provider holds; the intake reads it into a sale of that entity.
    const file = (await rows<{ upload_entity_id: string | null; content_type: string }>('SELECT upload_entity_id, content_type FROM crove_kernel.file WHERE org_id = $1 AND id = $2', [o.orgId, row.signed_file_id]))[0];
    expect(file).toMatchObject({ upload_entity_id: o.entityId, content_type: 'application/xml' });
    const read = await extractAndPropose({ runtime: worker, store, extractor: null, extract, today: () => today() }, o.orgId, String(row.signed_file_id));
    const proposal = (await rows<{ command: string; legal_entity_id: string; payload: { invoice?: { number?: string } } }>('SELECT command, legal_entity_id, payload FROM crove_kernel.proposal WHERE org_id = $1 AND id = $2', [o.orgId, read.proposalId]))[0];
    expect(proposal).toMatchObject({ command: 'finance.purchase.record', legal_entity_id: o.entityId });
    const approved = await rt.execute<{ documentId: string }>('kernel.proposal.approve', { acceptUnverifiedSignature: true, id: String(read.proposalId), revision: 1 }, { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() });
    const document = (await rows<{ direction: string; legal_entity_id: string; invoice_number: string }>('SELECT direction, legal_entity_id, invoice_number FROM crove_finance.purchase_document WHERE org_id = $1 AND id = $2', [o.orgId, approved.documentId]))[0];
    expect(document).toMatchObject({ direction: 'sale', legal_entity_id: o.entityId });
    // The intake keeps the number as the XML writes it, without the zeros the sandbox pads it with.
    expect(Number(document?.invoice_number)).toBe(Number(row.issued_number));
    // A second run does nothing more: the draft is issued and its evidence stored.
    expect(await run(o, draftId, provider)).toEqual({ action: 'none', state: 'STATE_ISSUED' });
    expect(control.calls.filter((c) => c.startsWith('issue'))).toHaveLength(1);
  });

  it('asks about a pending invoice until it answers, with the ledger holding each question', async () => {
    const o = await org();
    const draftId = await submitted(o);
    const { provider, control } = createSandboxEInvoiceProvider();
    control.script('pending');
    // The answer to the send was the first `pending`; the first question gets the second, the next one the invoice.
    control.pendingPolls = 2;
    expect(await run(o, draftId, provider)).toEqual({ action: 'issue', state: 'pending' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'pending', provider_ref: expect.any(String), check_attempts: 1, next_check_at: expect.any(Date), signed_file_id: null });
    // Not due yet: nothing is asked before the time the last answer set (the sweep may queue a draft twice); the first question is due after its wait.
    expect(await run(o, draftId, provider)).toEqual({ action: 'none', state: 'NOT_DUE' });
    await due(o, draftId);
    expect(await run(o, draftId, provider)).toEqual({ action: 'poll', state: 'pending' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'pending', check_attempts: 2 });
    await due(o, draftId);
    expect(await run(o, draftId, provider)).toEqual({ action: 'poll', state: 'issued' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'issued', signed_file_id: expect.any(String), next_check_at: null });
    expect((await calls(o)).filter((c) => c.step === 'status').map((c) => c.state)).toEqual(['succeeded', 'succeeded']);
  });

  it('gives up on a pending invoice after a day with STATUS_UNKNOWN, shown to a person', async () => {
    const o = await org();
    const draftId = await submitted(o);
    const { provider, control } = createSandboxEInvoiceProvider();
    control.script('pending');
    control.pendingPolls = 10_000;
    await run(o, draftId, provider);
    await fixture("UPDATE crove_finance.einvoice_draft SET submitted_at = pg_catalog.now() - interval '25 hours', next_check_at = pg_catalog.now() - interval '1 second' WHERE org_id = $1 AND id = $2", [o.orgId, draftId]);
    expect(await run(o, draftId, provider)).toEqual({ action: 'poll', state: 'failed' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'failed', error_code: 'STATUS_UNKNOWN', next_check_at: null });
  });

  it('holds a question that keeps failing to the same day: past it the invoice is failed with STATUS_UNKNOWN, not asked about for ever', async () => {
    const o = await org();
    const draftId = await submitted(o);
    const { provider, control } = createSandboxEInvoiceProvider();
    control.script('pending');
    control.pendingPolls = 10_000;
    await run(o, draftId, provider);
    // The provider cannot be reached any more: each question ends ambiguous and is tried again a minute later, until the day is over.
    const down: EInvoiceProvider = {
      ...provider,
      status: async () => {
        throw new EInvoiceProviderError('unreachable');
      },
    };
    await due(o, draftId);
    expect(await run(o, draftId, down)).toEqual({ action: 'poll', state: 'pending' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'pending', check_attempts: 2, next_check_at: expect.any(Date) });
    await fixture("UPDATE crove_finance.einvoice_draft SET submitted_at = pg_catalog.now() - interval '25 hours', next_check_at = pg_catalog.now() - interval '1 second' WHERE org_id = $1 AND id = $2", [o.orgId, draftId]);
    expect(await run(o, draftId, down)).toEqual({ action: 'poll', state: 'failed' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'failed', error_code: 'STATUS_UNKNOWN', next_check_at: null });
  });

  it('sends a rejected draft back to draft with a new key and no reference, and the code on screen', async () => {
    const o = await org();
    const draftId = await submitted(o);
    const before = await draftRow(o, draftId);
    const { provider, control } = createSandboxEInvoiceProvider();
    control.script('reject');
    expect(await run(o, draftId, provider)).toEqual({ action: 'issue', state: 'draft' });
    const after = await draftRow(o, draftId);
    expect(after).toMatchObject({ state: 'draft', provider_ref: null, submitted_at: null, next_check_at: null, check_attempts: 0, error_code: expect.stringMatching(/^REJECTED_/) });
    expect(after.idempotency_key).not.toBe(before.idempotency_key);
    expect((await calls(o)).map((c) => [c.step, c.state])).toEqual([['issue', 'failed']]);
    // The person can edit it again and ask again; the old key is never reused.
    const again = await execute<{ proposalId: string }>(o, 'kernel.proposal.request', { command: 'finance.einvoice.issue', input: { draftId } });
    expect(again.proposalId).toEqual(expect.any(String));
  });

  it('asks the provider by the key after a lost answer and sends nothing twice', async () => {
    const o = await org();
    const draftId = await submitted(o);
    const { provider, control } = createSandboxEInvoiceProvider();
    control.script('lose_answer');
    expect(await run(o, draftId, provider)).toEqual({ action: 'issue', state: 'submitting' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'submitting', next_check_at: expect.any(Date), check_attempts: 1 });
    expect((await calls(o)).map((c) => [c.step, c.state])).toEqual([['issue', 'ambiguous']]);
    // The next run asks by the key first, once its minute is over; the provider has the invoice, so it is issued and nothing is sent again.
    expect(await run(o, draftId, provider)).toEqual({ action: 'none', state: 'NOT_DUE' });
    await due(o, draftId);
    expect(await run(o, draftId, provider)).toEqual({ action: 'ask', state: 'issued' });
    expect(control.calls.filter((c) => c.startsWith('issue'))).toHaveLength(1);
    expect((await calls(o)).map((c) => [c.step, c.state])).toEqual(expect.arrayContaining([['issue', 'succeeded'], ['status', 'succeeded'], ['files', 'succeeded']]));
  });

  it('sends the same request again, as a new call on the same key, when the provider has nothing under it', async () => {
    const o = await org();
    const draftId = await submitted(o);
    const { provider } = createSandboxEInvoiceProvider();
    let failed = false;
    // The first send dies before the provider records anything: a timeout with no invoice made.
    const flaky: EInvoiceProvider = {
      ...provider,
      issue: async (secret, request) => {
        if (!failed) {
          failed = true;
          throw new EInvoiceProviderError('timeout');
        }
        return provider.issue(secret, request);
      },
    };
    expect(await run(o, draftId, flaky)).toEqual({ action: 'issue', state: 'submitting' });
    await due(o, draftId);
    expect(await run(o, draftId, flaky)).toEqual({ action: 'ask', state: 'issued' });
    const ledger = await calls(o);
    expect(ledger.find((c) => c.step === 'issue')).toMatchObject({ state: 'succeeded', calls: 2 });
  });

  it('stops before any call when the seller\'s tax code is no longer the connection\'s, or the stored figures no longer match, or there is no connection', async () => {
    const changed = await org();
    const changedDraft = await submitted(changed);
    await execute(changed, 'kernel.org.set_tax_code', { taxCode: OTHER_TAX_CODE });
    const a = createSandboxEInvoiceProvider();
    expect(await run(changed, changedDraft, a.provider)).toEqual({ action: 'none', state: 'SELLER_TAX_CODE_CHANGED' });
    // Nothing was sent, so the draft is a draft again with the code on screen and a new key.
    expect(await draftRow(changed, changedDraft)).toMatchObject({ state: 'draft', error_code: 'SELLER_TAX_CODE_CHANGED', submitted_at: null });
    expect(a.control.calls).toEqual([]);
    expect(await calls(changed)).toEqual([]);

    const mismatch = await org();
    const mismatchDraft = await submitted(mismatch);
    await fixture('UPDATE crove_finance.einvoice_draft_line SET amount = amount + 1 WHERE org_id = $1 AND draft_id = $2 AND line_no = 1', [mismatch.orgId, mismatchDraft]);
    const b = createSandboxEInvoiceProvider();
    expect(await run(mismatch, mismatchDraft, b.provider)).toEqual({ action: 'none', state: 'DRAFT_MISMATCH' });
    expect(await draftRow(mismatch, mismatchDraft)).toMatchObject({ state: 'draft', error_code: 'DRAFT_MISMATCH' });
    expect(b.control.calls).toEqual([]);

    // The connection was removed between the approval and the job (the request itself is refused without one).
    const bare = await org();
    const bareDraft = await submitted(bare);
    await rows('DELETE FROM crove_finance.einvoice_connection WHERE org_id = $1', [bare.orgId]);
    const c = createSandboxEInvoiceProvider();
    expect(await run(bare, bareDraft, c.provider)).toEqual({ action: 'none', state: 'PROVIDER_NOT_READY' });
    expect(await draftRow(bare, bareDraft)).toMatchObject({ state: 'draft', error_code: 'PROVIDER_NOT_READY' });
    expect(c.control.calls).toEqual([]);
  });

  it('takes no step for an adapter this deployment has off, and refuses the job to every login but the worker\'s', async () => {
    const o = await org();
    const draftId = await submitted(o);
    expect(await runEInvoiceIssue({ runtime: worker, broker, store, providers: {} }, { orgId: o.orgId, draftId })).toMatchObject({ action: 'issue', state: 'provider_off' });
    // The call was committed and none was made: it ended failed, and the draft is a draft again with the code on screen (nothing was sent).
    expect((await calls(o)).map((c) => [c.step, c.state])).toEqual([['issue', 'failed']]);
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'draft', error_code: 'PROVIDER_UNAVAILABLE' });
    // The API login's runtime refuses a system command: only the worker runs the job.
    await expect(runEInvoiceIssue({ runtime: rt, broker, store, providers: { sandbox: createSandboxEInvoiceProvider().provider } }, { orgId: o.orgId, draftId })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('never ends an invoice the provider has or may have over our own problem: a refused credential or a missing connection holds it and it is asked about again', async () => {
    const o = await org();
    const draftId = await submitted(o);
    const { provider, control } = createSandboxEInvoiceProvider();
    control.script('pending');
    control.pendingPolls = 1;
    expect(await run(o, draftId, provider)).toEqual({ action: 'issue', state: 'pending' });
    // The credential is refused when the invoice is asked about: it stays pending with the code on screen, asked about a minute later, not failed.
    const refused: EInvoiceProvider = {
      ...provider,
      status: async () => {
        throw new EInvoiceProviderError('credentials');
      },
    };
    await due(o, draftId);
    expect(await run(o, draftId, refused)).toEqual({ action: 'poll', state: 'pending' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'pending', error_code: 'CREDENTIALS', next_check_at: expect.any(Date), check_attempts: 2 });
    // The connection is gone as well: the same, nothing sent, nothing ended.
    await rows('DELETE FROM crove_finance.einvoice_connection WHERE org_id = $1', [o.orgId]);
    await due(o, draftId);
    expect(await run(o, draftId, provider)).toEqual({ action: 'none', state: 'PROVIDER_NOT_READY' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'pending', error_code: 'PROVIDER_NOT_READY' });
    // Past the day it is for a person to look at, never silently lost or sent again.
    await fixture("UPDATE crove_finance.einvoice_draft SET submitted_at = pg_catalog.now() - interval '25 hours', next_check_at = pg_catalog.now() - interval '1 second' WHERE org_id = $1 AND id = $2", [o.orgId, draftId]);
    expect(await run(o, draftId, provider)).toEqual({ action: 'none', state: 'PROVIDER_NOT_READY' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'failed', error_code: 'STATUS_UNKNOWN' });
    expect(control.calls.filter((c) => c.startsWith('issue'))).toHaveLength(1);
  });

  it('asks about an invoice only through the connection it was sent through, whatever the entity\'s tax code is later, and holds it when that connection is gone', async () => {
    const o = await org();
    const connectionOf = async (draftId: string) => (await rows<{ channel_connection_id: string | null }>('SELECT channel_connection_id FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, draftId]))[0]?.channel_connection_id;
    const first = (await rows<{ channel_connection_id: string }>('SELECT channel_connection_id FROM crove_finance.einvoice_connection WHERE org_id = $1', [o.orgId]))[0]?.channel_connection_id;
    // A second connection of the entity under another seller tax code (the database checks a connection's code against the entity's when it is made).
    await execute(o, 'kernel.org.set_tax_code', { taxCode: OTHER_TAX_CODE });
    const second = randomUUID();
    await admin(async (c) => {
      await c.query('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, second, 'einvoice_sandbox', `acct-${second.slice(0, 8)}`, 'Hóa đơn thử 2', o.owner]);
      await c.query(`INSERT INTO crove_finance.einvoice_connection (org_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, 'einvoice_sandbox', $3)`, [o.orgId, second, OTHER_TAX_CODE]);
    });
    await execute(o, 'kernel.org.set_tax_code', { taxCode: SELLER_TAX_CODE });
    const draftId = await submitted(o);
    const { provider, control } = createSandboxEInvoiceProvider();
    control.script('lose_answer');
    // The first send goes through the connection that matches the entity's tax code, which is written on the draft, with the call.
    expect(await run(o, draftId, provider)).toEqual({ action: 'issue', state: 'submitting' });
    expect(await connectionOf(draftId)).toBe(first);
    const key = (await draftRow(o, draftId)).idempotency_key;
    // The tax code is corrected to the other connection's: asking about the invoice still goes through the connection it was sent through, not the one that matches now.
    await execute(o, 'kernel.org.set_tax_code', { taxCode: OTHER_TAX_CODE });
    await due(o, draftId);
    const begin = () => worker.execute<{ action: string; reason?: string; connectionId?: string }>('finance.einvoice.job_begin', { draftId }, { actor: { type: 'system', component: 'finance.einvoice' }, orgId: o.orgId });
    expect(await begin()).toMatchObject({ action: 'ask', connectionId: first });
    // The connection it was sent through is no longer usable: the draft is held with the code, asked about again later, and neither released with a new key nor sent through the other.
    await rows("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE org_id = $1 AND id = $2", [o.orgId, first]);
    await due(o, draftId);
    expect(await run(o, draftId, provider)).toEqual({ action: 'none', state: 'PROVIDER_NOT_READY' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'submitting', error_code: 'PROVIDER_NOT_READY', idempotency_key: key });
    expect(await connectionOf(draftId)).toBe(first);
    expect(control.calls.filter((c) => c.startsWith('issue'))).toHaveLength(1);
    // Past the day it is for a person to look at, still never released or sent again.
    await fixture("UPDATE crove_finance.einvoice_draft SET submitted_at = pg_catalog.now() - interval '25 hours', next_check_at = pg_catalog.now() - interval '1 second' WHERE org_id = $1 AND id = $2", [o.orgId, draftId]);
    expect(await run(o, draftId, provider)).toEqual({ action: 'none', state: 'PROVIDER_NOT_READY' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'failed', error_code: 'STATUS_UNKNOWN', idempotency_key: key });
    expect(control.calls.filter((c) => c.startsWith('issue'))).toHaveLength(1);
  });

  it('fetches the files of an issued invoice again only after a wait, says why a missing connection stops it, and makes no fetch the ledger has closed', async () => {
    const o = await org();
    const draftId = await submitted(o);
    const { provider } = createSandboxEInvoiceProvider();
    expect(await run(o, draftId, provider)).toEqual({ action: 'issue', state: 'issued' });
    const key = (await draftRow(o, draftId)).idempotency_key;
    const sweep = async () => (await rows<{ draft_id: string }>('SELECT draft_id FROM crove_finance.einvoice_due(NULL, NULL, 100) WHERE org_id = $1', [o.orgId])).map((r) => r.draft_id);
    const files = (step: unknown) => worker.execute<{ ok: boolean; signedFileId: string | null }>('finance.einvoice.job_files', { draftId, step }, { actor: { type: 'system', component: 'finance.einvoice' }, orgId: o.orgId });
    const begin = () => worker.execute<{ action: string; reason?: string }>('finance.einvoice.job_begin', { draftId }, { actor: { type: 'system', component: 'finance.einvoice' }, orgId: o.orgId });
    // The evidence was stored; take it away again, as if the fetch had never succeeded, and age the invoice so the sweep sees it.
    await fixture("UPDATE crove_finance.einvoice_draft SET signed_file_id = NULL, pdf_file_id = NULL, issued_at = pg_catalog.now() - interval '1 hour' WHERE org_id = $1 AND id = $2", [o.orgId, draftId]);
    await fixture("DELETE FROM crove_kernel.external_call WHERE org_id = $1 AND key = $2", [o.orgId, `einvoice:files:${key}`]);
    expect(await sweep()).toContain(draftId);
    // A fetch that failed: the next one waits, and the sweep leaves the draft alone until then.
    expect(await files({ kind: 'begin' })).toMatchObject({ ok: true });
    expect(await files({ kind: 'failed' })).toMatchObject({ ok: false });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'issued', error_code: 'FILES_UNAVAILABLE' });
    expect((await draftRow(o, draftId)).next_check_at).not.toBeNull();
    expect(await sweep()).not.toContain(draftId);
    expect(await begin()).toEqual({ action: 'none', reason: 'NOT_DUE' });
    // Once the wait has passed it is fetched again.
    await due(o, draftId);
    expect(await sweep()).toContain(draftId);
    expect(await begin()).toMatchObject({ action: 'files' });
    // The connection it was sent through stops working: the draft stays issued and says why, instead of showing only that it is saving the original.
    await rows("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE org_id = $1", [o.orgId]);
    await due(o, draftId);
    expect(await begin()).toEqual({ action: 'none', reason: 'PROVIDER_NOT_READY' });
    expect(await draftRow(o, draftId)).toMatchObject({ state: 'issued', error_code: 'PROVIDER_NOT_READY' });
    // A key the ledger has closed (1000 calls) is not fetched: the call has to be on record first.
    await fixture("UPDATE crove_kernel.external_call SET calls = 1000, state = 'ambiguous' WHERE org_id = $1 AND key = $2", [o.orgId, `einvoice:files:${key}`]);
    expect(await files({ kind: 'begin' })).toMatchObject({ ok: false, signedFileId: null });
  });

  it('leaves a send that started a moment ago alone (it is in flight) and asks about it once it is old enough', async () => {
    const o = await org();
    const draftId = await submitted(o);
    const begin = () => worker.execute<{ action: string; reason?: string }>('finance.einvoice.job_begin', { draftId }, { actor: { type: 'system', component: 'finance.einvoice' }, orgId: o.orgId });
    // The first job commits its call and, being cut off, never records an answer; a second job at once finds the call in flight and does nothing.
    expect(await begin()).toMatchObject({ action: 'issue' });
    expect(await begin()).toEqual({ action: 'none', reason: 'IN_FLIGHT' });
    expect((await calls(o)).map((c) => [c.step, c.state])).toEqual([['issue', 'started']]);
    // Minutes later nobody answered: the provider is asked by the key before anything is sent again.
    await fixture("UPDATE crove_kernel.external_call SET updated_at = pg_catalog.now() - interval '10 minutes' WHERE org_id = $1 AND key LIKE 'einvoice:issue:%'", [o.orgId]);
    expect(await begin()).toMatchObject({ action: 'ask' });
  });
});

