// SPDX-License-Identifier: AGPL-3.0-only
// Adjusting and replacing an issued sales e-invoice (#2504, plan einvoice-issue.md section 8), on PostgreSQL 17 with the offline provider: a correcting draft points at the issued invoice
// and goes through the same approval and job, the job calling `adjust` or `replace` with the original's reference read from its stored row; the intake links the new invoice (#916), an
// adjustment leaves the original in force and posts the difference, a replacement voids it in the transaction that posts the new one, a rejected replacement leaves it untouched. Refused:
// a correction of an invoice not issued, of one already replaced, of a second method after the first, a second open correction, no reason code, a business buyer with no signed agreement.
// Set CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { createSandboxEInvoiceProvider, type EInvoiceProvider } from '@crove/einvoice';
import type { ExtractClient } from '@crove/extract-contract';
import { enterpriseCheckDigit } from '@crove/l10n-vn';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, useCorrectionReasonCodes } from '@crove/mod-finance';
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

suite('adjusting and replacing an issued sales e-invoice (#2504)', () => {
  const dbName = `crove_test_einvoice_correct_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const agreementFile = async (o: Org): Promise<string> => {
    const id = randomUUID();
    const sha = randomUUID().replaceAll('-', '').repeat(2);
    await rows('INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, $5, $6, 100, $7)', [
      o.orgId, id, sha, `org/${o.orgId}/${sha}`, 'bien-ban-thoa-thuan.pdf', 'application/pdf', 'upload',
    ]);
    return id;
  };
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
  type Corrected = { id: string; state: string; correction: { kind: string; originalDraftId: string; reasonCode: string; agreementFileId: string | null } | null; lines: Array<{ unitPrice: string }>; total: string; issues: Array<{ code: string }> };
  const start = (o: Org, originalDraftId: string, kind: 'adjustment' | 'replacement', extra: { reasonCode?: string; agreementFileId?: string | null } = {}) =>
    execute<Corrected>(o, 'finance.einvoice.start_correction', { originalDraftId, kind, reasonCode: '1', agreementFileId: null, ...extra });
  // The correcting draft with the lines the person typed: the buyer and the series are the copy's.
  async function fill(o: Org, corrected: Corrected & { buyer: Record<string, unknown>; seriesId: string }, lines: Array<{ description: string; unit: string | null; quantity: string; unitPrice: string; vatRate: string }>) {
    return execute<Corrected>(o, 'finance.einvoice_draft.save', { draftId: corrected.id, legalEntityId: null, date: today(), seriesId: corrected.seriesId, buyer: corrected.buyer, lines });
  }
  const refusal = async (promise: Promise<unknown>) => promise.then(() => 'accepted', (error: { code?: string }) => error.code);
  const document = async (o: Org, id: string) =>
    (
      await rows<{ correction_kind: string | null; corrects_document_id: string | null; corrected_number: string | null; total: string; voided: boolean }>(
        `SELECT d.correction_kind, d.corrects_document_id, d.corrected_number, d.total::text AS total,
                EXISTS (SELECT 1 FROM crove_finance.purchase_document_void v WHERE v.org_id = d.org_id AND v.document_id = d.id) AS voided
           FROM crove_finance.purchase_document d WHERE d.org_id = $1 AND d.id = $2`,
        [o.orgId, id],
      )
    )[0];

  it('refuses a correction of an invoice that is not issued, with no reason code, with no agreement of a business buyer, or with a file that is not the org\'s', async () => {
    const o = await org();
    const draft = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', form(o));
    expect(await refusal(start(o, draft.id, 'adjustment'))).toBe('EINVOICE_ORIGINAL_NOT_ISSUED');
    await approve(o, draft.id);
    expect(await refusal(start(o, draft.id, 'adjustment'))).toBe('EINVOICE_ORIGINAL_NOT_ISSUED');
    await run(o, draft.id, sandbox().provider);
    expect(await refusal(start(o, draft.id, 'adjustment', { reasonCode: '99' }))).toBe('EINVOICE_REASON_CODE_INVALID');
    expect(await refusal(start(o, draft.id, 'adjustment'))).toBe('EINVOICE_AGREEMENT_REQUIRED');
    expect(await refusal(start(o, draft.id, 'adjustment', { agreementFileId: randomUUID() }))).toBe('EINVOICE_AGREEMENT_FILE_NOT_FOUND');
    // With the list empty (as it is until Appendix XVII is read) nothing is accepted, whatever the code.
    useCorrectionReasonCodes([]);
    try {
      expect(await refusal(start(o, draft.id, 'adjustment', { agreementFileId: await agreementFile(o) }))).toBe('EINVOICE_REASON_CODE_INVALID');
    } finally {
      useCorrectionReasonCodes(REASONS);
    }
    expect(await rows('SELECT 1 FROM crove_finance.einvoice_draft WHERE org_id = $1 AND original_draft_id IS NOT NULL', [o.orgId])).toHaveLength(0);
  });

  it('asks an individual buyer for no agreement, and a business buyer for the signed file linked to the correction', async () => {
    const o = await org();
    const p = sandbox();
    const person = await issued(o, p, 'individual');
    const a = await start(o, person.draftId, 'adjustment');
    expect(a.correction).toEqual({ kind: 'adjustment', originalDraftId: person.draftId, reasonCode: '1', agreementFileId: null });
    const company = await issued(o, p);
    const file = await agreementFile(o);
    const b = await start(o, company.draftId, 'replacement', { agreementFileId: file });
    expect(b.correction).toEqual({ kind: 'replacement', originalDraftId: company.draftId, reasonCode: '1', agreementFileId: file });
  });

  it('adjusts up and down: the original stays in force, each adjusting invoice is linked to it and posts only the difference, and the same method is kept', async () => {
    const o = await org();
    const { provider, control } = sandbox();
    const original = await issued(o, { provider, control });
    const file = await agreementFile(o);
    const up = (await start(o, original.draftId, 'adjustment', { agreementFileId: file })) as Corrected & { buyer: Record<string, unknown>; seriesId: string };
    // A copy to edit would be a replacement: an adjustment starts empty and the difference is typed with its sign.
    expect(up.lines).toEqual([]);
    expect(await refusal(start(o, original.draftId, 'adjustment', { agreementFileId: file }))).toBe('EINVOICE_CORRECTION_OPEN');
    const upFilled = await fill(o, up, [{ description: 'Hàng A (tăng giá)', unit: 'cái', quantity: '1', unitPrice: '50000', vatRate: '10%' }]);
    expect(upFilled.issues).toEqual([]);
    expect(upFilled.total).toBe('55000');
    await approve(o, up.id);
    expect(await run(o, up.id, provider)).toMatchObject({ state: 'issued' });
    expect(control.calls.filter((c) => c.startsWith('adjust:'))).toHaveLength(1);
    // The only `issue` is the original's own.
    expect(control.calls.filter((c) => c.startsWith('issue:'))).toHaveLength(1);
    expect(control.calls.filter((c) => c.startsWith('replace:'))).toHaveLength(0);
    const upDoc = await post(o, up.id);
    expect(await document(o, upDoc)).toMatchObject({ correction_kind: 'adjustment', corrects_document_id: original.documentId, total: '55000.0000' });
    expect(await document(o, original.documentId)).toMatchObject({ voided: false });

    // A decrease: the same method, the difference negative; the original is still in force.
    expect(await refusal(start(o, original.draftId, 'replacement', { agreementFileId: file }))).toBe('EINVOICE_CORRECTION_METHOD');
    const down = (await start(o, original.draftId, 'adjustment', { agreementFileId: file })) as Corrected & { buyer: Record<string, unknown>; seriesId: string };
    const downFilled = await fill(o, down, [{ description: 'Hàng B (giảm giá)', unit: null, quantity: '1', unitPrice: '-20000', vatRate: '10%' }]);
    expect(downFilled.issues).toEqual([]);
    expect(downFilled.total).toBe('-22000');
    await approve(o, down.id);
    expect(await run(o, down.id, provider)).toMatchObject({ state: 'issued' });
    const downDoc = await post(o, down.id);
    expect(await document(o, downDoc)).toMatchObject({ correction_kind: 'adjustment', corrects_document_id: original.documentId, total: '-22000.0000' });
    expect(await document(o, original.documentId)).toMatchObject({ voided: false });
  });

  it('checks a negative price on an adjusting draft only, and never a zero difference', async () => {
    const o = await org();
    const original = await issued(o, sandbox(), 'individual');
    const ordinary = await execute<Corrected>(o, 'finance.einvoice_draft.save', { ...form(o), lines: [{ description: 'Hàng', unit: null, quantity: '1', unitPrice: '-5', vatRate: '10%' }] });
    expect(ordinary.issues.map((i) => i.code)).toContain('LINE_PRICE_INVALID');
    const adjusting = (await start(o, original.draftId, 'adjustment')) as Corrected & { buyer: Record<string, unknown>; seriesId: string };
    expect((await fill(o, adjusting, [{ description: 'Hàng', unit: null, quantity: '1', unitPrice: '0', vatRate: '10%' }])).issues.map((i) => i.code)).toContain('LINE_PRICE_INVALID');
    expect((await fill(o, adjusting, [{ description: 'Hàng', unit: null, quantity: '1', unitPrice: '-5', vatRate: '10%' }])).issues).toEqual([]);
  });

  it('replaces: the new invoice is issued through `replace`, linked to the original, and voids it in the transaction that posts the new one', async () => {
    const o = await org();
    const { provider, control } = sandbox();
    const original = await issued(o, { provider, control });
    const file = await agreementFile(o);
    const copy = (await start(o, original.draftId, 'replacement', { agreementFileId: file })) as Corrected & { buyer: Record<string, unknown>; seriesId: string };
    // The edited copy starts as the original's lines and totals.
    expect(copy.lines.map((l) => l.unitPrice)).toEqual(['100000', '33333']);
    expect(copy.total).toBe('274000');
    const edited = await fill(o, copy, [
      { description: 'Hàng A', unit: 'cái', quantity: '2', unitPrice: '90000', vatRate: '10%' },
      { description: 'Hàng B', unit: null, quantity: '1.5', unitPrice: '33333', vatRate: '8%' },
    ]);
    expect(edited.issues).toEqual([]);
    await approve(o, copy.id);
    // Nothing happens to the original before the replacement is issued and posted.
    expect(await document(o, original.documentId)).toMatchObject({ voided: false });
    expect(await run(o, copy.id, provider)).toMatchObject({ state: 'issued' });
    expect(control.calls.filter((c) => c.startsWith('replace:'))).toHaveLength(1);
    expect(await document(o, original.documentId)).toMatchObject({ voided: false });
    const newDoc = await post(o, copy.id);
    expect(await document(o, newDoc)).toMatchObject({ correction_kind: 'replacement', corrects_document_id: original.documentId, voided: false });
    expect(await document(o, original.documentId)).toMatchObject({ voided: true });
    // The replaced invoice is not corrected again; the replacement is the invoice in force.
    expect(await refusal(start(o, original.draftId, 'adjustment', { agreementFileId: file }))).toBe('EINVOICE_ORIGINAL_REPLACED');
    expect(await refusal(start(o, original.draftId, 'replacement', { agreementFileId: file }))).toBe('EINVOICE_ORIGINAL_REPLACED');
    expect((await start(o, copy.id, 'adjustment', { agreementFileId: file })).correction).toMatchObject({ kind: 'adjustment', originalDraftId: copy.id });
  });

  it('leaves the original untouched when the replacement is rejected, and the corrected draft goes back to a draft with a new key', async () => {
    const o = await org();
    const { provider, control } = sandbox();
    const original = await issued(o, { provider, control });
    const file = await agreementFile(o);
    const copy = await start(o, original.draftId, 'replacement', { agreementFileId: file });
    await approve(o, copy.id);
    const before = await draftRow(o, copy.id);
    control.script('reject');
    expect(await run(o, copy.id, provider)).toEqual({ action: 'issue', state: 'draft' });
    const after = await draftRow(o, copy.id);
    expect(after).toMatchObject({ state: 'draft', provider_ref: null, error_code: expect.stringMatching(/^REJECTED_/) });
    expect(after.idempotency_key).not.toBe(before.idempotency_key);
    expect(await document(o, original.documentId)).toMatchObject({ voided: false });
    expect((await draftRow(o, original.draftId)).state).toBe('issued');
    // Still a correction of the same invoice, and still the only one open.
    const kept = await rows<{ correction_kind: string; original_draft_id: string }>('SELECT correction_kind, original_draft_id FROM crove_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, copy.id]);
    expect(kept).toEqual([{ correction_kind: 'replacement', original_draft_id: original.draftId }]);
    expect(await refusal(start(o, original.draftId, 'replacement', { agreementFileId: file }))).toBe('EINVOICE_CORRECTION_OPEN');
  });

  it('freezes the correction in the database once it is sent', async () => {
    const o = await org();
    const original = await issued(o, sandbox());
    const file = await agreementFile(o);
    const copy = await start(o, original.draftId, 'replacement', { agreementFileId: file });
    await approve(o, copy.id);
    // Once sent, the kind, the original, the reason and the agreement cannot move, even for the database owner's ordinary statement.
    await expect(rows('UPDATE crove_finance.einvoice_draft SET reason_code = $3 WHERE org_id = $1 AND id = $2', [o.orgId, copy.id, '2'])).rejects.toThrow();
    await expect(rows("UPDATE crove_finance.einvoice_draft SET correction_kind = NULL, original_draft_id = NULL, reason_code = NULL WHERE org_id = $1 AND id = $2", [o.orgId, copy.id])).rejects.toThrow();
  });
  it('puts the correction and the buyer identity in the content hash only when set, so an ordinary draft keeps the hash it had', async () => {
    const o = await org();
    const p = sandbox();
    const hash = async (id: string) => (await rows<{ h: string }>('SELECT crove_finance.einvoice_content_hash($1, $2) AS h', [o.orgId, id]))[0]?.h;
    // An ordinary draft with no sale date, no identity and no correction hashes as its base terms alone: the formula of 20261123050000, computed here from the stored rows.
    const ordinary = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', form(o));
    const base = (
      await rows<{ h: string }>(
        `SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((pg_catalog.jsonb_build_array(
            d.legal_entity_id::text, COALESCE(d.series_id::text, ''), d.invoice_date::text, d.currency, d.buyer_kind,
            COALESCE(d.buyer_tax_code, ''), COALESCE(d.buyer_name, ''), COALESCE(d.buyer_address, ''), COALESCE(d.buyer_email, ''),
            d.subtotal::text, d.vat_amount::text, d.total::text,
            COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(l.line_no::text, l.description, COALESCE(l.unit, ''), l.quantity::text, l.unit_price::text, l.amount::text, l.vat_rate, l.vat_amount::text) ORDER BY l.line_no)
                      FROM crove_finance.einvoice_draft_line l WHERE l.org_id = d.org_id AND l.draft_id = d.id), '[]'::pg_catalog.jsonb)))::text, 'UTF8')), 'hex') AS h
           FROM crove_finance.einvoice_draft d WHERE d.org_id = $1 AND d.id = $2`,
        [o.orgId, ordinary.id],
      )
    )[0]?.h;
    expect(await hash(ordinary.id)).toBe(base);

    // A correcting draft of an individual buyer: the identity the person gives changes the hash, and so does each term of the correction.
    const original = await issued(o, p, 'individual');
    const corr = (await start(o, original.draftId, 'adjustment')) as Corrected & { buyer: { identity: unknown } & Record<string, unknown>; seriesId: string };
    const lines = [{ description: 'Hàng A', unit: null, quantity: '1', unitPrice: '50000', vatRate: '10%' }];
    const withIdentity = (identity: { kind: string; value: string } | null) =>
      execute<Corrected>(o, 'finance.einvoice_draft.save', { draftId: corr.id, legalEntityId: null, date: today(), seriesId: corr.seriesId, buyer: { ...corr.buyer, identity }, lines });
    await withIdentity(null);
    const none = await hash(corr.id);
    expect(none).not.toBe(base);
    await withIdentity({ kind: 'cccd', value: '012345678901' });
    const cccd = await hash(corr.id);
    expect(cccd).not.toBe(none);
    await withIdentity({ kind: 'cccd', value: '012345678902' });
    expect(await hash(corr.id)).not.toBe(cccd);
    await withIdentity({ kind: 'passport', value: '012345678901' });
    expect(await hash(corr.id)).not.toBe(cccd);
    // Back to no identity: the hash is the one it was.
    await withIdentity(null);
    expect(await hash(corr.id)).toBe(none);
    // The same draft made a replacement instead (another original) hashes differently from this adjustment.
    const other = await issued(o, p, 'individual');
    const replacement = await start(o, other.draftId, 'replacement');
    expect(await hash(replacement.id)).not.toBe(none);
  });
});
