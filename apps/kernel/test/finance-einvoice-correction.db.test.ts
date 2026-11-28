// SPDX-License-Identifier: AGPL-3.0-only
// Adjusting and replacing an issued sales e-invoice (#2504, plan einvoice-issue.md section 8), on PostgreSQL 17 with the offline provider: a correcting draft points at the issued invoice
// and goes through the same approval and job, the job calling `adjust` or `replace` with the original's reference read from its stored row; the intake links the new invoice (#916), an
// adjustment leaves the original in force and posts the difference, a replacement voids it in the transaction that posts the new one, a rejected replacement leaves it untouched. Refused:
// a correction of an invoice not issued, of one already replaced, of a second method after the first, a second open correction, no reason code, a business buyer with no signed agreement.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { SANDBOX_EINVOICE_SECRET, createSandboxEInvoiceProvider, type EInvoiceProvider } from '@ludy/einvoice';
import type { ExtractClient } from '@ludy/extract-contract';
import { enterpriseCheckDigit } from '@ludy/l10n-vn';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, sha256Hex, type BlobStore, type CredentialBroker } from '@ludy/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, useCorrectionReasonCodes } from '@ludy/mod-finance';
import { runEInvoiceIssue } from '../src/einvoice-issue-job.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
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
  const dbName = `ludy_test_einvoice_correct_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    await admin((c) => c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin')", [orgId, adminUser]));
    // The org's tax code is its default entity's (kernel.org.set_tax_code keeps the two the same).
    await execute({ orgId, owner }, 'kernel.org.set_tax_code', { taxCode: SELLER_TAX_CODE });
    const entity = (await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id ?? '';
    if (options.connection) {
      const channel = randomUUID();
      await admin(async (c) => {
        await c.query('INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, channel, 'einvoice_sandbox', `acct-${channel.slice(0, 8)}`, 'Hóa đơn thử', owner]);
        await c.query(`INSERT INTO ludy_finance.einvoice_connection (org_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, 'einvoice_sandbox', $3)`, [orgId, channel, SELLER_TAX_CODE]);
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
        'SELECT state, provider_ref, issued_number, authority_code, signed_file_id, pdf_file_id, error_code, idempotency_key, next_check_at, check_attempts, submitted_at FROM ludy_finance.einvoice_draft WHERE org_id = $1 AND id = $2',
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 2 });
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
    await rows('INSERT INTO ludy_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, $5, $6, 100, $7)', [
      o.orgId, id, sha, `org/${o.orgId}/${sha}`, 'bien-ban-thoa-thuan.pdf', 'application/pdf', 'agreement',
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
  async function issued(o: Org, p: ReturnType<typeof sandbox>, buyer: 'business' | 'individual' | 'individual_taxed' = 'business'): Promise<{ draftId: string; documentId: string }> {
    const base = form(o);
    // An individual with a tax code (a made-up 12-digit one, the shape of a personal code) may be a business household or a sole trader (#5266).
    const input =
      buyer === 'business'
        ? base
        : { ...base, buyer: { kind: 'individual', partyId: null, taxCode: buyer === 'individual_taxed' ? '012345678901' : null, name: 'Anh Nam', address: null, email: null } };
    const draft = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', input);
    await approve(o, draft.id);
    expect(await run(o, draft.id, p.provider)).toMatchObject({ state: 'issued' });
    return { draftId: draft.id, documentId: await post(o, draft.id) };
  }
  type Corrected = {
    id: string;
    state: string;
    correction: { kind: string; originalDraftId: string; reasonCode: string; agreementFileId: string | null; rateBasis: string | null } | null;
    lines: Array<{ unitPrice: string; vatRate: string; amount: string; vatAmount: string }>;
    subtotal: string;
    vatAmount: string;
    total: string;
    issues: Array<{ code: string }>;
  };
  // A correction says what it is about and confirms the basis that goes with it (#3709): by default one that changes no amount, on the original's rate.
  const start = (
    o: Org,
    originalDraftId: string,
    kind: 'adjustment' | 'replacement',
    extra: { reasonCode?: string; agreementFileId?: string | null; buyerIsBusiness?: boolean | null; platformSale?: boolean; rateNature?: string; rateBasis?: string } = {},
  ) => execute<Corrected>(o, 'finance.einvoice.start_correction', { originalDraftId, kind, reasonCode: '1', agreementFileId: null, rateNature: 'no_amount_change', rateBasis: 'original', ...extra });
  // The correcting draft with the lines the person typed: the buyer and the series are the copy's.
  async function fill(o: Org, corrected: Corrected & { buyer: Record<string, unknown>; seriesId: string }, lines: Array<{ description: string; unit: string | null; quantity: string; unitPrice: string; vatRate: string }>) {
    return execute<Corrected>(o, 'finance.einvoice_draft.save', { draftId: corrected.id, legalEntityId: null, date: today(), seriesId: corrected.seriesId, buyer: corrected.buyer, lines });
  }
  const refusal = async (promise: Promise<unknown>) => promise.then(() => 'accepted', (error: { code?: string }) => error.code);
  const document = async (o: Org, id: string) =>
    (
      await rows<{ correction_kind: string | null; corrects_document_id: string | null; corrected_number: string | null; total: string; voided: boolean }>(
        `SELECT d.correction_kind, d.corrects_document_id, d.corrected_number, d.total::text AS total,
                EXISTS (SELECT 1 FROM ludy_finance.purchase_document_void v WHERE v.org_id = d.org_id AND v.document_id = d.id) AS voided
           FROM ludy_finance.purchase_document d WHERE d.org_id = $1 AND d.id = $2`,
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
    expect(await rows('SELECT 1 FROM ludy_finance.einvoice_draft WHERE org_id = $1 AND original_draft_id IS NOT NULL', [o.orgId])).toHaveLength(0);
  });

  it('asks an individual buyer for no agreement, and a business buyer for the signed file linked to the correction', async () => {
    const o = await org();
    const p = sandbox();
    const person = await issued(o, p, 'individual');
    const a = await start(o, person.draftId, 'adjustment');
    expect(a.correction).toEqual({ kind: 'adjustment', originalDraftId: person.draftId, reasonCode: '1', agreementFileId: null, rateBasis: 'original' });
    const company = await issued(o, p);
    const file = await agreementFile(o);
    const b = await start(o, company.draftId, 'replacement', { agreementFileId: file });
    expect(b.correction).toEqual({ kind: 'replacement', originalDraftId: company.draftId, reasonCode: '1', agreementFileId: file, rateBasis: 'original' });
  });

  it('fails safe for an individual with a tax code, takes the person\'s answer, and waives the agreement for an attested platform sale, recording codes only (#5266)', async () => {
    const o = await org();
    const p = sandbox();
    const taxed = await issued(o, p, 'individual_taxed');
    // No answer, or "a business household or sole trader": the agreement is required, and a refused start makes no draft.
    expect(await refusal(start(o, taxed.draftId, 'adjustment'))).toBe('EINVOICE_AGREEMENT_REQUIRED');
    expect(await refusal(start(o, taxed.draftId, 'adjustment', { buyerIsBusiness: true }))).toBe('EINVOICE_AGREEMENT_REQUIRED');
    expect(await rows('SELECT 1 FROM ludy_finance.einvoice_draft WHERE org_id = $1 AND original_draft_id IS NOT NULL', [o.orgId])).toHaveLength(0);
    // The person says the buyer is not a business: no file is asked.
    const notBusiness = await start(o, taxed.draftId, 'adjustment', { buyerIsBusiness: false });
    expect(notBusiness.correction).toMatchObject({ kind: 'adjustment', originalDraftId: taxed.draftId, agreementFileId: null });
    // A business buyer is waived only by the attestation of a platform sale; an attached file is still linked when there is one.
    const company = await issued(o, p);
    expect(await refusal(start(o, company.draftId, 'adjustment', { buyerIsBusiness: false }))).toBe('EINVOICE_AGREEMENT_REQUIRED');
    const platform = await start(o, company.draftId, 'adjustment', { platformSale: true });
    expect(platform.correction).toMatchObject({ originalDraftId: company.draftId, agreementFileId: null });
    const taxedPlatform = await issued(o, p, 'individual_taxed');
    expect((await start(o, taxedPlatform.draftId, 'replacement', { platformSale: true })).correction).toMatchObject({ kind: 'replacement', agreementFileId: null });
    // The audit names the basis and the two answers, and nothing of the buyer.
    const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.einvoice.start_correction' AND outcome = 'ok' ORDER BY occurred_at", [o.orgId]);
    expect(audit.map((a) => [a.detail.agreementBasis, a.detail.buyerIsBusiness ?? null, a.detail.platformSale])).toEqual([
      ['individual_not_business', false, false],
      ['platform_sale_attested', null, true],
      ['platform_sale_attested', null, true],
    ]);
    const text = JSON.stringify(audit);
    for (const secret of ['012345678901', 'Anh Nam', 'Công ty Mua Thử', BUYER_TAX_CODE]) expect(text).not.toContain(secret);
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
    const kept = await rows<{ correction_kind: string; original_draft_id: string }>('SELECT correction_kind, original_draft_id FROM ludy_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, copy.id]);
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
    await expect(rows('UPDATE ludy_finance.einvoice_draft SET reason_code = $3 WHERE org_id = $1 AND id = $2', [o.orgId, copy.id, '2'])).rejects.toThrow();
    await expect(rows("UPDATE ludy_finance.einvoice_draft SET correction_kind = NULL, original_draft_id = NULL, reason_code = NULL WHERE org_id = $1 AND id = $2", [o.orgId, copy.id])).rejects.toThrow();
  });
  it('puts the correction and the buyer identity in the content hash only when set, so an ordinary draft keeps the hash it had', async () => {
    const o = await org();
    const p = sandbox();
    const hash = async (id: string) => (await rows<{ h: string }>('SELECT ludy_finance.einvoice_content_hash($1, $2) AS h', [o.orgId, id]))[0]?.h;
    // An ordinary draft with no sale date, no identity and no correction hashes as its base terms alone: the formula of 20261123050000, computed here from the stored rows.
    const ordinary = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', form(o));
    const base = (
      await rows<{ h: string }>(
        `SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((pg_catalog.jsonb_build_array(
            d.legal_entity_id::text, COALESCE(d.series_id::text, ''), d.invoice_date::text, d.currency, d.buyer_kind,
            COALESCE(d.buyer_tax_code, ''), COALESCE(d.buyer_name, ''), COALESCE(d.buyer_address, ''), COALESCE(d.buyer_email, ''),
            d.subtotal::text, d.vat_amount::text, d.total::text,
            COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(l.line_no::text, l.description, COALESCE(l.unit, ''), l.quantity::text, l.unit_price::text, l.amount::text, l.vat_rate, l.vat_amount::text) ORDER BY l.line_no)
                      FROM ludy_finance.einvoice_draft_line l WHERE l.org_id = d.org_id AND l.draft_id = d.id), '[]'::pg_catalog.jsonb)))::text, 'UTF8')), 'hex') AS h
           FROM ludy_finance.einvoice_draft d WHERE d.org_id = $1 AND d.id = $2`,
        [o.orgId, ordinary.id],
      )
    )[0]?.h;
    expect(await hash(ordinary.id)).toBe(base);

    // A correcting draft of an individual buyer: the identity the person gives changes the hash, and so does each term of the correction.
    const original = await issued(o, p, 'individual');
    const corr = (await start(o, original.draftId, 'adjustment')) as Corrected & { buyer: { identity: unknown } & Record<string, unknown>; seriesId: string };
    const lines = [{ description: 'Hàng A', unit: null, quantity: '1', unitPrice: '50000', vatRate: '10%' }];
    const withIdentity = (identity: { kind: string; value: string; nationality?: string | null } | null) =>
      execute<Corrected>(o, 'finance.einvoice_draft.save', { draftId: corr.id, legalEntityId: null, date: today(), seriesId: corr.seriesId, buyer: { ...corr.buyer, identity }, lines });
    await withIdentity(null);
    const none = await hash(corr.id);
    expect(none).not.toBe(base);
    await withIdentity({ kind: 'cccd', value: '012345678901' });
    const cccd = await hash(corr.id);
    expect(cccd).not.toBe(none);
    await withIdentity({ kind: 'cccd', value: '012345678902' });
    expect(await hash(corr.id)).not.toBe(cccd);
    // A passport's nationality is in the hash only when set: the passport with one differs from the CCCD and from the same passport with another.
    await withIdentity({ kind: 'passport', value: '012345678901', nationality: 'US' });
    const us = await hash(corr.id);
    expect(us).not.toBe(cccd);
    await withIdentity({ kind: 'passport', value: '012345678901', nationality: 'KR' });
    expect(await hash(corr.id)).not.toBe(us);
    // Back to no identity: the hash is the one it was.
    await withIdentity(null);
    expect(await hash(corr.id)).toBe(none);
    // The confirmed rate basis joins the hash when set (#3709), and a correction made before the column existed (null) hashes as the formula of 20270110100000 did.
    const setBasis = (basis: string | null) => rows('UPDATE ludy_finance.einvoice_draft SET correction_rate_basis = $3 WHERE org_id = $1 AND id = $2', [o.orgId, corr.id, basis]);
    const legacy = async () =>
      (
        await rows<{ h: string }>(
          `SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((pg_catalog.jsonb_build_array(
              d.legal_entity_id::text, COALESCE(d.series_id::text, ''), d.invoice_date::text, d.currency, d.buyer_kind,
              COALESCE(d.buyer_tax_code, ''), COALESCE(d.buyer_name, ''), COALESCE(d.buyer_address, ''), COALESCE(d.buyer_email, ''),
              d.subtotal::text, d.vat_amount::text, d.total::text,
              COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(l.line_no::text, l.description, COALESCE(l.unit, ''), l.quantity::text, l.unit_price::text, l.amount::text, l.vat_rate, l.vat_amount::text) ORDER BY l.line_no)
                        FROM ludy_finance.einvoice_draft_line l WHERE l.org_id = d.org_id AND l.draft_id = d.id), '[]'::pg_catalog.jsonb))
             || CASE WHEN d.sale_date IS NULL THEN '[]'::pg_catalog.jsonb ELSE pg_catalog.jsonb_build_array(d.sale_date::text, COALESCE(d.late_reason, '')) END
             || CASE WHEN d.buyer_identity IS NULL THEN '[]'::pg_catalog.jsonb ELSE pg_catalog.jsonb_build_array(d.buyer_identity_kind, d.buyer_identity) END
             || CASE WHEN d.correction_kind IS NULL THEN '[]'::pg_catalog.jsonb
                     ELSE pg_catalog.jsonb_build_array(d.correction_kind, d.original_draft_id::text, d.reason_code, COALESCE(d.agreement_file_id::text, '')) END)::text, 'UTF8')), 'hex') AS h
             FROM ludy_finance.einvoice_draft d WHERE d.org_id = $1 AND d.id = $2`,
          [o.orgId, corr.id],
        )
      )[0]?.h;
    await setBasis(null);
    const legacyHash = await hash(corr.id);
    expect(legacyHash).toBe(await legacy());
    await setBasis('original');
    expect(await hash(corr.id)).not.toBe(legacyHash);
    expect(await hash(corr.id)).toBe(none);
    await setBasis('correction_date');
    expect(await hash(corr.id)).not.toBe(none);
    expect(await hash(corr.id)).not.toBe(legacyHash);
    // The database keeps the basis to a correction and to the two values.
    await expect(rows('UPDATE ludy_finance.einvoice_draft SET correction_rate_basis = $3 WHERE org_id = $1 AND id = $2', [o.orgId, corr.id, 'someday'])).rejects.toMatchObject({ code: '23514' });
    // A draft that is no correction cannot carry one (a draft row: an issued invoice would meet the state guard first).
    const plainDraft = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', form(o));
    await expect(rows("UPDATE ludy_finance.einvoice_draft SET correction_rate_basis = 'original' WHERE org_id = $1 AND id = $2", [o.orgId, plainDraft.id])).rejects.toMatchObject({ code: '23514' });
    await setBasis('original');
    // The same draft made a replacement instead (another original) hashes differently from this adjustment.
    const other = await issued(o, p, 'individual');
    const replacement = await start(o, other.draftId, 'replacement');
    expect(await hash(replacement.id)).not.toBe(none);
  });
  it('stores the signed agreement as a file of source agreement that is never read as an invoice, and keeps it apart from a document of the same bytes (#2504)', async () => {
    const o = await org();
    const original = await issued(o, sandbox(), 'individual');
    const bytes = new TextEncoder().encode(`%PDF-1.4 agreement ${randomUUID()}`);
    const sha = sha256Hex(bytes);
    const ingest = (source: 'agreement' | 'upload') =>
      rt.execute<{ fileId: string; duplicate: boolean }>(
        'kernel.file.ingest',
        { filename: 'bien-ban.pdf', contentType: 'application/pdf', sizeBytes: bytes.byteLength, sha256: sha, storageKey: `org/${o.orgId}/${sha}`, generation: `content:${sha}`, source },
        { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
      );
    const stored = await ingest('agreement');
    expect(await rows('SELECT source FROM ludy_kernel.file WHERE org_id = $1 AND id = $2', [o.orgId, stored.fileId])).toEqual([{ source: 'agreement' }]);
    // Nothing reads it: no extraction is queued, so it never reaches the Inbox.
    expect(await rows('SELECT 1 FROM ludy_kernel.extraction WHERE org_id = $1 AND file_id = $2', [o.orgId, stored.fileId])).toHaveLength(0);
    // The same bytes as a document are refused, so an agreement never becomes an invoice and an invoice never an agreement.
    expect(await refusal(ingest('upload'))).toBe('FILE_SOURCE_CONFLICT');
    // The file is accepted as the agreement of a correction.
    const corrected = await start(o, original.draftId, 'adjustment', { agreementFileId: stored.fileId });
    expect(corrected.correction).toMatchObject({ kind: 'adjustment', agreementFileId: stored.fileId });
  });

  it('accepts only a file stored as an agreement as the agreement of a correction, and refuses the other way round too (#2504)', async () => {
    const o = await org();
    const original = await issued(o, sandbox());
    // A document of the org (an Inbox file) is no agreement, even though it is a file of the org.
    const document = await rows<{ id: string }>("SELECT id FROM ludy_kernel.file WHERE org_id = $1 AND source = 'upload' LIMIT 1", [o.orgId]);
    const documentId = document[0]?.id ?? (await (async () => {
      const sha = sha256Hex(new TextEncoder().encode(`document ${randomUUID()}`));
      const id = randomUUID();
      await rows('INSERT INTO ludy_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, $5, $6, 10, $7)', [o.orgId, id, sha, `org/${o.orgId}/${sha}`, 'hd.pdf', 'application/pdf', 'upload']);
      return id;
    })());
    expect(await refusal(start(o, original.draftId, 'adjustment', { agreementFileId: documentId }))).toBe('EINVOICE_AGREEMENT_FILE_NOT_FOUND');
    // The reverse: bytes stored as a document are refused as an agreement, and an emailed copy of an agreement stays a duplicate.
    const bytes = new TextEncoder().encode(`%PDF-1.4 reverse ${randomUUID()}`);
    const sha = sha256Hex(bytes);
    const ingest = (source: 'agreement' | 'upload' | 'email') =>
      rt.execute<{ fileId: string; duplicate: boolean }>(
        'kernel.file.ingest',
        { filename: 'x.pdf', contentType: 'application/pdf', sizeBytes: bytes.byteLength, sha256: sha, storageKey: `org/${o.orgId}/${sha}`, generation: `content:${sha}`, source },
        { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
      );
    await ingest('upload');
    expect(await refusal(ingest('agreement'))).toBe('FILE_SOURCE_CONFLICT');
    const other = new TextEncoder().encode(`%PDF-1.4 email ${randomUUID()}`);
    const otherSha = sha256Hex(other);
    const store = (source: 'agreement' | 'email') =>
      rt.execute<{ fileId: string; duplicate: boolean }>(
        'kernel.file.ingest',
        { filename: 'y.pdf', contentType: 'application/pdf', sizeBytes: other.byteLength, sha256: otherSha, storageKey: `org/${o.orgId}/${otherSha}`, generation: `content:${otherSha}`, source },
        { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() },
      );
    const agreement = await store('agreement');
    const emailed = await store('email');
    expect(emailed).toEqual({ fileId: agreement.fileId, duplicate: true });
    expect(await rows('SELECT source FROM ludy_kernel.file WHERE org_id = $1 AND id = $2', [o.orgId, agreement.fileId])).toEqual([{ source: 'agreement' }]);
  });
  it('proposes the VAT rate of a correction by the nature picked, stores the basis the person confirmed and refuses one that does not match (#3709)', async () => {
    const o = await org();
    const p = sandbox();
    const original = await issued(o, p, 'individual');
    const query = <T>(name: string, input: unknown) => rt.query<T>(name, input, { actor: asUser(o.owner), orgId: o.orgId });
    type Rate = { nature: string; basis: string; originalDate: string; correctionDate: string; reasonCode: string; changes: Array<{ from: string; to: string }>; kept: string[]; reducedUntil: string; reason: string; precedentNote: string | null };
    const rateOf = (nature: string) => query<Rate>('finance.einvoice.correction_rate', { originalDraftId: original.draftId, nature });
    // What the amount-changing nature gives depends on the day the suite runs (the database's day), as the rule does.
    const reduced = today() <= '2026-12-31';

    // A correction that changes no amount, a return and a trade discount keep the rates of the original, whatever the day.
    for (const nature of ['no_amount_change', 'return', 'trade_discount']) {
      const rate = await rateOf(nature);
      expect(rate).toMatchObject({ nature, basis: 'original', changes: [], kept: ['10%', '8%'], reducedUntil: '2026-12-31', correctionDate: today() });
      expect(rate.reason).toContain('giữ thuế suất của hóa đơn gốc');
      expect(rate.precedentNote).toContain('2121/TCT-CS');
    }
    const amount = await rateOf('amount_change');
    expect(amount).toMatchObject({ nature: 'amount_change', basis: 'correction_date', reducedUntil: '2026-12-31' });
    expect(amount.changes).toEqual(reduced ? [] : [{ from: '8%', to: '10%' }]);
    expect(amount.reasonCode).toBe(reduced ? 'amount_change_still_reduced' : 'amount_change_standard');
    expect(amount.precedentNote).toContain('2121/TCT-CS');
    // Read only, and only of an invoice that was issued here.
    expect(await refusal(query('finance.einvoice.correction_rate', { originalDraftId: randomUUID(), nature: 'return' }))).toBe('EINVOICE_DRAFT_NOT_FOUND');
    const notIssued = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', form(o));
    expect(await refusal(query('finance.einvoice.correction_rate', { originalDraftId: notIssued.id, nature: 'return' }))).toBe('EINVOICE_ORIGINAL_NOT_ISSUED');

    // The command works the basis out from the nature and refuses a different one (a stale or forged screen), and an unknown nature or none.
    expect(await refusal(start(o, original.draftId, 'adjustment', { rateNature: 'amount_change', rateBasis: 'original' }))).toBe('EINVOICE_RATE_BASIS_MISMATCH');
    expect(await refusal(start(o, original.draftId, 'adjustment', { rateNature: 'return', rateBasis: 'correction_date' }))).toBe('EINVOICE_RATE_BASIS_MISMATCH');
    expect(await refusal(start(o, original.draftId, 'adjustment', { rateNature: 'whatever', rateBasis: 'original' }))).not.toBe('accepted');
    expect(await rows('SELECT 1 FROM ludy_finance.einvoice_draft WHERE org_id = $1 AND original_draft_id = $2', [o.orgId, original.draftId])).toHaveLength(0);

    // The confirmed basis is stored with the correction and returned with it, and the audit says the nature and the basis and nothing of the buyer.
    const adjusting = await start(o, original.draftId, 'adjustment', { rateNature: 'amount_change', rateBasis: 'correction_date' });
    expect(adjusting.correction).toMatchObject({ kind: 'adjustment', rateBasis: 'correction_date' });
    expect((await rows<{ correction_rate_basis: string | null }>('SELECT correction_rate_basis FROM ludy_finance.einvoice_draft WHERE org_id = $1 AND id = $2', [o.orgId, adjusting.id]))[0]?.correction_rate_basis).toBe('correction_date');
    const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.einvoice.start_correction' AND outcome = 'ok' ORDER BY occurred_at", [o.orgId]);
    expect(audit[0]?.detail).toMatchObject({ rateNature: 'amount_change', rateBasis: 'correction_date' });

    // The 8% of the correcting draft is judged on the confirmed basis: a draft dated 2027 and left at 8% is refused on the correction date basis, kept on the original's, and judged on the original's
    // for a correction made before the basis existed (no basis sent).
    const live = (rateBasis: string | null) =>
      query<{ issues: Array<{ code: string }> }>('finance.einvoice_draft.check', {
        date: '2027-01-10', saleDate: null, lateReason: null, seriesId: o.seriesId, buyer: (adjusting as unknown as { buyer: Record<string, unknown> }).buyer,
        correction: { kind: 'adjustment', originalDraftId: original.draftId, ...(rateBasis ? { rateBasis } : {}) },
        lines: [{ description: 'Hàng', unit: null, quantity: '1', unitPrice: '-5000', vatRate: '8%' }],
      });
    expect((await live('correction_date')).issues.map((i) => i.code)).toContain('LINE_VAT_RATE_REDUCED_OUTSIDE_PERIOD');
    expect((await live('original')).issues.map((i) => i.code)).not.toContain('LINE_VAT_RATE_REDUCED_OUTSIDE_PERIOD');
    expect((await live(null)).issues.map((i) => i.code)).not.toContain('LINE_VAT_RATE_REDUCED_OUTSIDE_PERIOD');

    // A replacement that follows the correction's date carries the rate that date gives each line, its amounts worked again by code and the totals the sum of its lines.
    const other = await issued(o, p, 'individual');
    const replacement = await start(o, other.draftId, 'replacement', { rateNature: 'amount_change', rateBasis: 'correction_date' });
    expect(replacement.correction).toMatchObject({ kind: 'replacement', rateBasis: 'correction_date' });
    expect(replacement.lines.map((l) => l.vatRate)).toEqual(reduced ? ['10%', '8%'] : ['10%', '10%']);
    const sum = (key: 'amount' | 'vatAmount') => replacement.lines.reduce((acc, l) => acc + Number(l[key]), 0);
    expect(Number(replacement.subtotal)).toBe(sum('amount'));
    expect(Number(replacement.vatAmount)).toBe(sum('vatAmount'));
    expect(Number(replacement.total)).toBe(sum('amount') + sum('vatAmount'));
    if (!reduced) expect(replacement.lines[1]).toMatchObject({ amount: '50000', vatAmount: '5000' });
    // On the original basis the copy keeps every rate as it was.
    const third = await issued(o, p, 'individual');
    const kept = await start(o, third.draftId, 'replacement', { rateNature: 'return', rateBasis: 'original' });
    expect(kept.lines.map((l) => l.vatRate)).toEqual(['10%', '8%']);
  });

  it('reads for the coworker only the list, the buyer kind and the lines without a price, and only of an invoice that was issued here (#3690)', async () => {
    const o = await org();
    const original = await issued(o, sandbox());
    const query = <T>(name: string, input: unknown) => rt.query<T>(name, input, { actor: asUser(o.owner), orgId: o.orgId });
    type Source = { codes: Array<{ code: string; label: string }>; buyerKind: string; originalDate: string; lines: Array<Record<string, unknown>> };
    const source = await query<Source>('finance.einvoice.reason_source', { originalDraftId: original.draftId });
    expect(source).toEqual({
      codes: REASONS,
      buyerKind: 'business',
      originalDate: today(),
      lines: [
        { description: 'Hàng A', unit: 'cái', quantity: '2', vatRate: '10%' },
        { description: 'Hàng B', unit: null, quantity: '1.5', vatRate: '8%' },
      ],
    });
    // Nothing of the buyer but its kind, no amount and no price, no number of the invoice.
    const text = JSON.stringify(source);
    for (const secret of ['Công ty Mua Thử', BUYER_TAX_CODE, '1 Phố Thử', '100000', '33333', '200000']) expect(text).not.toContain(secret);
    expect(Object.keys(source).sort()).toEqual(['buyerKind', 'codes', 'lines', 'originalDate']);
    // With no list entered the source says so (the API then asks no model).
    useCorrectionReasonCodes([]);
    try {
      expect((await query<Source>('finance.einvoice.reason_source', { originalDraftId: original.draftId })).codes).toEqual([]);
    } finally {
      useCorrectionReasonCodes(REASONS);
    }
    // An invoice that was not issued, and one that is not here, are the answers of start_correction.
    const notIssued = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', form(o));
    expect(await refusal(query('finance.einvoice.reason_source', { originalDraftId: notIssued.id }))).toBe('EINVOICE_ORIGINAL_NOT_ISSUED');
    expect(await refusal(query('finance.einvoice.reason_source', { originalDraftId: randomUUID() }))).toBe('EINVOICE_DRAFT_NOT_FOUND');
    // An issued invoice of ANOTHER org is the same not-found: its lines are never read through this query.
    const other = await issued(await org(), sandbox());
    expect(await refusal(query('finance.einvoice.reason_source', { originalDraftId: other.draftId }))).toBe('EINVOICE_DRAFT_NOT_FOUND');
  });

  it('sends the consumer label and a passport\'s nationality in the provider\'s document (#3709)', async () => {
    const o = await org();
    const { provider, control } = sandbox();
    const xmlOf = async (draftId: string): Promise<string> => {
      await approve(o, draftId);
      expect(await run(o, draftId, provider)).toMatchObject({ state: 'issued' });
      const ref = (await draftRow(o, draftId)).provider_ref ?? '';
      return new TextDecoder().decode((await provider.files(SANDBOX_EINVOICE_SECRET, ref)).xml);
    };
    const consumer = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', { ...form(o), buyer: { kind: 'consumer', partyId: null, taxCode: null, name: null, address: null, email: null, identity: null } });
    expect(await xmlOf(consumer.id)).toContain('<NMua><Ten>Bán cho người tiêu dùng</Ten>');
    const passport = await execute<{ id: string }>(o, 'finance.einvoice_draft.save', {
      ...form(o),
      buyer: { kind: 'individual', partyId: null, taxCode: null, name: 'John Smith', address: null, email: null, identity: { kind: 'passport', value: 'B1234567', nationality: 'US' } },
    });
    expect(await xmlOf(passport.id)).toContain('<DDanh Loai="passport" QTich="US">B1234567</DDanh>');
    expect(control.calls.length).toBeGreaterThan(0);
  });

  it('tells the screen the reason codes, which invoice was corrected by which method and whether it was replaced, and checks a correction as it will be stored', async () => {
    const o = await org();
    const { provider, control } = sandbox();
    const query = <T>(name: string, input: unknown) => rt.query<T>(name, input, { actor: asUser(o.owner), orgId: o.orgId });
    expect(await query('finance.einvoice.correction_options', {})).toEqual({ reasonCodes: REASONS });
    type Row = { id: string; state: string; buyerKind: string; correction: { kind: string; originalDraftId: string } | null; correctedBy: string | null; replaced: boolean };
    const list = async () => await query<Row[]>('finance.einvoice_draft.list', {});
    const row = async (id: string) => (await list()).find((r) => r.id === id) as Row;

    const original = await issued(o, { provider, control });
    expect(await row(original.draftId)).toMatchObject({ buyerKind: 'business', correction: null, correctedBy: null, replaced: false });

    // An adjustment that was issued: the invoice is corrected by adjustment, the correcting invoice names it, and it is not replaced.
    const file = await agreementFile(o);
    const adjusting = (await start(o, original.draftId, 'adjustment', { agreementFileId: file })) as Corrected & { buyer: Record<string, unknown>; seriesId: string };
    // The live check of the form: a negative price is a difference on an adjusting form, a wrong price on any other.
    const live = (correction: { kind: 'adjustment' | 'replacement'; originalDraftId: string } | null) =>
      query<{ issues: Array<{ code: string }> }>('finance.einvoice_draft.check', {
        date: today(), saleDate: null, lateReason: null, seriesId: adjusting.seriesId, buyer: adjusting.buyer, correction,
        lines: [{ description: 'Hàng', unit: null, quantity: '1', unitPrice: '-5000', vatRate: '10%' }],
      });
    expect((await live({ kind: 'adjustment', originalDraftId: original.draftId })).issues.map((i) => i.code)).not.toContain('LINE_PRICE_INVALID');
    expect((await live(null)).issues.map((i) => i.code)).toContain('LINE_PRICE_INVALID');
    await fill(o, adjusting, [{ description: 'Hàng A', unit: null, quantity: '1', unitPrice: '1000', vatRate: '10%' }]);
    await approve(o, adjusting.id);
    await run(o, adjusting.id, provider);
    expect(await row(adjusting.id)).toMatchObject({ correction: { kind: 'adjustment', originalDraftId: original.draftId } });
    expect(await row(original.draftId)).toMatchObject({ correctedBy: 'adjustment', replaced: false });

    // A replacement that was issued: the original is replaced.
    const other = await issued(o, { provider, control }, 'individual');
    const copy = await start(o, other.draftId, 'replacement');
    await approve(o, copy.id);
    await run(o, copy.id, provider);
    expect(await row(other.draftId)).toMatchObject({ correctedBy: 'replacement', replaced: true });
  });
});
