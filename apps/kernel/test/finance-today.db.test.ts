// SPDX-License-Identifier: AGPL-3.0-only
// finance.today (#2388), the Accounting line of Home's "Hôm nay cần bạn", on PostgreSQL 17 through the runtime as each
// member: the proposals waiting for the caller's own decision grouped by vendor with exact totals, the flags (failed
// checks, originals), the staged bank statement and the bank lines with no voucher, the VAT deadline only for an org
// that set its filing period, what a viewer and a member limited to one legal entity do not get, another org's
// nothing, and a read of 1,000 pending proposals within a bound. Set CROVE_TEST_ADMIN_URL to a superuser URL; each
// run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { nextVatDeadline, normalizeStatementAmount, vietnamToday, type BankStatementRow } from '@crove/kernel-contract';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries, type TodayItem } from '@crove/mod-finance';
import type { ExtractClient } from '@crove/extract-contract';
import type { ParsedInvoice } from '@crove/l10n-vn';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const PARSED = JSON.parse(readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;
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

suite('finance.today: what needs the member in Accounting (#2388)', () => {
  const dbName = `crove_test_fin_today_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let worker: Runtime;
  const store = new MemoryStore();
  const users = { owner: '', admin: '', approver: '', member: '', scoped: '', viewer: '', outsider: '' };
  let orgId = '';
  let otherOrgId = '';
  let branch = '';
  let defaultEntity = '';
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const today = (who: string, org = orgId) => rt.query<TodayItem[]>('finance.today', {}, { actor: asUser(who), orgId: org });
  const real = inProcessExtract();
  const extract: ExtractClient = { extract: async (kind, bytes) => (kind === 'pdf_text' ? ({ ok: true, kind: 'pdf_text', text: 'x'.repeat(100), pages: 1 } as never) : real.extract(kind, bytes)) };
  const reader = (number: string, seller: string) => ({
    fromText: async () => ({ ...structuredClone(PARSED), source: 'ai' as const, number, seller: { ...structuredClone(PARSED.seller), name: seller } }),
    fromImage: async () => null,
  });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // Uploads a PDF as `by` (for an entity) and reads it into a pending proposal.
  async function pending(by: string, number: string, seller: string, legalEntityId?: string): Promise<string> {
    const bytes = new TextEncoder().encode(`%PDF-1.4 hoa don ${number} ${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: `hd-${number}.pdf`, contentType: 'application/pdf', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload', ...(legalEntityId ? { legalEntityId } : {}) },
      { actor: asUser(by), orgId },
    );
    const { proposalId } = await extractAndPropose({ runtime: worker, store, extractor: reader(number, seller) as never, extract, today: () => '2026-10-13' }, orgId, fileId);
    return proposalId as string;
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
    const db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'test', subject: key, email: `${key}@finance-today.test`, name: null });
    }
    ({ orgId } = await createOrg(rt, asUser(users.owner), 'Công ty có việc hôm nay'));
    ({ orgId: otherOrgId } = await createOrg(rt, asUser(users.outsider), 'Công ty khác'));
    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, users.owner])).rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer')`,
        [orgId, users.admin, users.approver, users.member, users.scoped, users.viewer],
      );
      // The scoped member keeps the default entity's books only.
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, users.scoped, defaultEntity, users.owner]);
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('says nothing to a member of an org with nothing waiting, and nothing to the member of another org', async () => {
    expect(await today(users.owner)).toEqual([]);
    expect(await today(users.outsider, otherOrgId)).toEqual([]);
    // Not a member of the org: the runtime refuses before the query runs.
    await expect(today(users.outsider)).rejects.toBeTruthy();
  });

  it('groups the proposals waiting for the caller by vendor, with the exact total, and leaves out the ones the caller wrote', async () => {
    // The admin uploads three invoices of two vendors; the owner and the other admin may decide them, the admin who wrote them may not.
    const a1 = await pending(users.admin, '7001', 'Công ty Alpha');
    const a2 = await pending(users.admin, '7002', 'Công ty Alpha');
    const b1 = await pending(users.admin, '7003', 'Công ty Beta');
    const total = Number(PARSED.total);
    for (const who of [users.owner, users.approver]) {
      const items = (await today(who)).filter((i) => i.kind === 'proposal');
      expect(items, who).toHaveLength(2);
      const alpha = items.find((i) => i.title.params?.party === 'Công ty Alpha');
      const beta = items.find((i) => i.title.params?.party === 'Công ty Beta');
      expect(alpha).toMatchObject({ app: 'finance', title: { key: 'financeToday.proposalsVendor', params: { count: 2, party: 'Công ty Alpha' } }, count: 2, href: `/inbox?entity=${defaultEntity}` });
      expect(Number(alpha?.amount)).toBe(total * 2);
      expect(alpha?.currency).toBeUndefined();
      // One proposal opens itself.
      expect(beta).toMatchObject({ title: { key: 'financeToday.proposalsVendor', params: { count: 1, party: 'Công ty Beta' } }, count: 1, href: `/inbox/${b1}?entity=${defaultEntity}` });
      expect(Number(beta?.amount)).toBe(total);
      // The org has two entities: the link carries the entity it is in.
    }
    expect((await today(users.admin)).filter((i) => i.kind === 'proposal')).toEqual([]);
    expect(a1).not.toBe(a2);
  });

  it('flags the pending proposals whose checks failed or warn, and counts them as the database does', async () => {
    const counts = await admin(async (c) =>
      (
        await c.query<{ failed: string; warned: string }>(
          `SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(p.payload -> 'checks') k WHERE k ->> 'status' = 'fail'))::text AS failed,
                  count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p.payload -> 'checks') k WHERE k ->> 'status' = 'fail')
                                    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p.payload -> 'checks') k WHERE k ->> 'status' = 'warn'))::text AS warned
           FROM crove_kernel.proposal p WHERE p.org_id = $1 AND p.status = 'pending'`,
          [orgId],
        )
      ).rows[0],
    );
    const flags = (await today(users.owner)).filter((i) => i.kind === 'flag');
    const failed = flags.find((i) => i.id.startsWith('checks-failed'));
    const warned = flags.find((i) => i.id.startsWith('checks-warn'));
    expect(failed?.count ?? 0).toBe(Number(counts?.failed));
    expect(warned?.count ?? 0).toBe(Number(counts?.warned));
    expect(Number(counts?.failed) + Number(counts?.warned)).toBeGreaterThan(0);
    if (failed) expect(failed).toMatchObject({ severity: 'block', href: expect.stringMatching(/^\/inbox\?entity=/) });
    // A flag shows no money.
    for (const f of flags) expect(f.amount).toBeUndefined();
  });

  it('shows a staged bank statement and the bank lines no voucher settles, by entity', async () => {
    let rowNo = 1;
    const row = (date: string, moneyIn: string, moneyOut: string, reference: string, description: string): BankStatementRow => ({
      rowNo: rowNo++,
      date,
      description,
      moneyIn: normalizeStatementAmount(moneyIn),
      moneyOut: normalizeStatementAmount(moneyOut),
      balance: '',
      reference,
    });
    await rt.execute(
      'finance.bank.import',
      {
        bankAccount: '1121',
        filename: 'sao-ke-10.xlsx',
        rows: [row('01/10/2026', '1.500.000', '', 'FT101', 'Khach tra tien'), row('02/10/2026', '', '11.000', 'FT102', 'Phi SMS')],
        idempotencyKey: randomUUID(),
      },
      { actor: asUser(users.member), orgId },
    );
    const bytes = new TextEncoder().encode(`PK-sao-ke-${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const { fileId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'sao-ke.zip', contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey: fileKey(orgId, sha256), generation: await store.put(fileKey(orgId, sha256), bytes), source: 'upload' },
      { actor: asUser(users.member), orgId },
    );
    await worker.execute(
      'kernel.extraction.record',
      {
        fileId,
        method: 'unsupported',
        status: 'done',
        statement: true,
        checks: [],
        proposal: null,
        error: null,
        summary: 'Sao kê chờ nhập',
        result: {
          kind: 'bank_statement',
          summary: { state: 'staged', bankAccount: '1121', filename: 'sao-ke.xlsx', lines: 1, newLines: 1, duplicateLines: 0, from: '2026-09-01', to: '2026-09-01', totalIn: '100000', totalOut: '0' },
          rows: [row('01/09/2026', '100000', '', 'FT-S-1', 'Khach tra tien')],
        },
      },
      { actor: { type: 'system' as const, component: 'finance.bank_statement' }, orgId },
    );
    const items = await today(users.owner);
    expect(items.find((i) => i.id === 'statements-staged')).toMatchObject({ kind: 'message', count: 1, href: '/inbox' });
    expect(items.find((i) => i.id === `bank-open-lines:${defaultEntity}`)).toMatchObject({ kind: 'message', count: 2, href: `/bank?entity=${defaultEntity}` });
    expect(items.find((i) => i.id.startsWith('bank-open-lines:') && i.id !== `bank-open-lines:${defaultEntity}`)).toBeUndefined();
  });

  it('keeps a member limited to one legal entity to that entity, and a viewer to the deadlines', async () => {
    // A pending proposal in the branch: the owner's flag counts it, the member limited to the default entity does not see it.
    const inBranch = await pending(users.admin, '7101', 'Công ty Gamma', branch);
    const owner = await today(users.owner);
    expect(owner.filter((i) => i.id === `checks-failed:${branch}` || i.id === `checks-warn:${branch}`)).not.toHaveLength(0);
    const scoped = await today(users.scoped);
    expect(scoped.filter((i) => i.id.endsWith(`:${branch}`))).toEqual([]);
    expect(scoped.some((i) => i.title.params?.party === 'Công ty Gamma')).toBe(false);
    expect(inBranch).toBeTruthy();
    // A viewer can act on nothing and sees no money: with no filing period set, nothing at all.
    expect(await today(users.viewer)).toEqual([]);
  });

  it('shows the originals still to fetch and the originals that differ from a posting, the second until it is opened', async () => {
    const subject = await pending(users.admin, '7201', 'Công ty Delta');
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.inbox_item (org_id, kind, dedupe_key, detail) VALUES ($1, 'finance.invoice.original_needed', $2, $3)`, [orgId, `check:${randomUUID()}`, JSON.stringify({ provider: 'misa', url: 'https://meinvoice.vn/tra-cuu', code: 'ABC12345' })]);
      await c.query(
        `INSERT INTO crove_kernel.notification (org_id, user_id, kind, dedupe_key, subject_type, subject_id, legal_entity_id, detail) VALUES ($1, $2, 'kernel.original_flagged', $3, 'kernel.proposal', $4, $5, '{"differs":"true","signature":"none"}')`,
        [orgId, users.owner, `original_flagged:${subject}:x`, subject, defaultEntity],
      );
    });
    const items = await today(users.owner);
    expect(items.find((i) => i.id === 'originals-needed')).toMatchObject({ kind: 'flag', count: 1, severity: 'info', href: '/inbox' });
    expect(items.find((i) => i.id === 'originals-flagged')).toMatchObject({ kind: 'flag', count: 1, severity: 'warn', href: `/inbox/${subject}` });
    // Only the member the notice is for; and once opened (read) it is gone.
    expect((await today(users.approver)).find((i) => i.id === 'originals-flagged')).toBeUndefined();
    await admin((c) => c.query(`UPDATE crove_kernel.notification SET read_at = now() WHERE org_id = $1 AND kind = 'kernel.original_flagged'`, [orgId]));
    expect((await today(users.owner)).find((i) => i.id === 'originals-flagged')).toBeUndefined();
    // A viewer gets neither, and the member limited to one entity does not see the org-wide item to fetch.
    expect((await today(users.viewer)).filter((i) => i.kind === 'flag')).toEqual([]);
    expect((await today(users.scoped)).find((i) => i.id === 'originals-needed')).toBeUndefined();
  });

  it.each(['month', 'quarter'] as const)('shows the next VAT return of a %s filer, only when it is due within the tax calendar window, and none without a filing period', async (kind) => {
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET vat_filing_period = NULL WHERE org_id = $1`, [orgId]));
    expect((await today(users.owner)).filter((i) => i.kind === 'deadline')).toEqual([]);
    await rt.execute('kernel.org.set_vat_filing_period', { vatFilingPeriod: kind }, { actor: { ...asUser(users.owner), aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) }, orgId });
    const next = nextVatDeadline(kind, vietnamToday());
    const expected = next.daysLeft <= 30;
    for (const who of [users.owner, users.viewer]) {
      const deadlines = (await today(who)).filter((i) => i.kind === 'deadline' && i.id.startsWith('vat:'));
      if (!expected) {
        expect(deadlines, who).toEqual([]);
        continue;
      }
      expect(deadlines, who).toHaveLength(1);
      // The branch was added after the period ended, so only the default entity owes the return: the link names it.
      expect(deadlines[0]).toMatchObject({ id: `vat:${next.period}`, app: 'finance', dueAt: `${next.dueDate}T23:59:59+07:00`, href: `/vat?period=${next.period}&entity=${defaultEntity}` });
      expect(deadlines[0]?.amount).toBeUndefined();
    }
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET vat_filing_period = NULL WHERE org_id = $1`, [orgId]));
  });

  it('reads 1,000 pending proposals in one grouped pass', async () => {
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, legal_entity_id)
         SELECT $1, 'finance.purchase', 'finance.purchase.record', 'pending', 'HĐ ' || g,
                jsonb_build_object('seller', jsonb_build_object('name', 'Nhà cung cấp ' || (g % 40)), 'invoice', jsonb_build_object('total', '1000000', 'currency', 'VND'), 'checks', '[]'::jsonb),
                1, ARRAY[$2::uuid], jsonb_build_array(jsonb_build_object('type', 'user', 'id', $3::text)), $4
         FROM generate_series(1, 1000) g`,
        [orgId, users.owner, users.admin, defaultEntity],
      ),
    );
    const started = Date.now();
    const items = await today(users.owner);
    const elapsed = Date.now() - started;
    const groups = items.filter((i) => i.kind === 'proposal');
    // Listed groups are capped; the 40 vendors of the load are among them, and the counts add up to what the groups hold.
    expect(groups.length).toBeLessThanOrEqual(30);
    expect(groups.filter((g) => g.title.params?.party?.toString().startsWith('Nhà cung cấp ')).every((g) => g.count === 25)).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });
});
