// SPDX-License-Identifier: AGPL-3.0-only
// finance.today (#2388), the Accounting line of Home's "Hôm nay cần bạn", on PostgreSQL 17 through the runtime as each
// member: the proposals waiting for the caller's own decision grouped by vendor with exact totals, the flags (failed
// checks, originals), the staged bank statement and the bank lines with no voucher, the VAT deadline only for an org
// that set its filing period, what a viewer and a member limited to one legal entity do not get, another org's
// nothing, and a read of 1,000 pending proposals within a bound. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each
// run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { nextVatDeadline, normalizeStatementAmount, vietnamToday, zTodayItems, type BankStatementRow } from '@ludy/kernel-contract';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { extractAndPropose, financeCommands, financeQueries } from '@ludy/mod-finance';
import type { ExtractClient } from '@ludy/extract-contract';
import type { ParsedInvoice } from '@ludy/l10n-vn';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const PARSED = JSON.parse(readFileSync(new URL('../../../packages/l10n-vn/test/fixtures/einvoice-basic.parsed.json', import.meta.url), 'utf8')) as ParsedInvoice;
// The last day of a VAT period key ("2026-11" or "2026-Q4"), as YYYY-MM-DD.
const periodLastDay = (period: string): string => {
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  const quarter = /^(\d{4})-Q(\d)$/.exec(period);
  const [year, upTo] = month ? [Number(month[1]), Number(month[2])] : [Number(quarter?.[1]), Number(quarter?.[2]) * 3];
  return new Date(Date.UTC(year, upTo, 0)).toISOString().slice(0, 10);
};
const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
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
  const dbName = `ludy_test_fin_today_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  // Every answer is checked against the shared TodayItem schema Home reads (#2394): a field it does not know, a title that is
  // not a key, an href that is not an in-app path or a currency with no amount fails here.
  const today = async (who: string, org = orgId) => zTodayItems.parse(await rt.query('finance.today', {}, { actor: asUser(who), orgId: org }));
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    const db = createDb(pool);
    const registry = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'ludy_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'test', subject: key, email: `${key}@finance-today.test`, name: null });
    }
    ({ orgId } = await createOrg(rt, asUser(users.owner), 'Công ty có việc hôm nay'));
    ({ orgId: otherOrgId } = await createOrg(rt, asUser(users.outsider), 'Công ty khác'));
    await admin(async (c) => {
      defaultEntity = (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string;
      branch = (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, users.owner])).rows[0]?.id as string;
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer')`,
        [orgId, users.admin, users.approver, users.member, users.scoped, users.viewer],
      );
      // The scoped member keeps the default entity's books only.
      await c.query(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, users.scoped, defaultEntity, users.owner]);
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
      expect(alpha).toMatchObject({ app: 'finance', title: { key: 'financeProposalsVendor', params: { count: 2, party: 'Công ty Alpha' } }, count: 2, href: `/inbox?entity=${defaultEntity}` });
      expect(Number(alpha?.amount)).toBe(total * 2);
      expect(alpha?.currency).toBeUndefined();
      // One proposal opens itself.
      expect(beta).toMatchObject({ title: { key: 'financeProposalsVendor', params: { count: 1, party: 'Công ty Beta' } }, count: 1, href: `/inbox/${b1}?entity=${defaultEntity}` });
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
           FROM ludy_kernel.proposal p
           WHERE p.org_id = $1 AND p.status = 'pending' AND p.command LIKE 'finance.%'
             -- Only the proposals waiting for the owner, as the groups count them (#3591): the flags are about those, not about ones another approver decides.
             AND p.eligible_approvers @> ARRAY[$2::uuid] AND NOT p.authors @> jsonb_build_array(jsonb_build_object('type', 'user', 'id', $2::text))`,
          [orgId, users.owner],
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
    // They are the proposals the waiting groups count, so they annotate those and add nothing to the count of what needs the member (#3591).
    for (const f of [failed, warned]) if (f) expect(f.annotates).toBe('proposal');
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
      await c.query(`INSERT INTO ludy_kernel.inbox_item (org_id, kind, dedupe_key, detail) VALUES ($1, 'finance.invoice.original_needed', $2, $3)`, [orgId, `check:${randomUUID()}`, JSON.stringify({ provider: 'misa', url: 'https://meinvoice.vn/tra-cuu', code: 'ABC12345' })]);
      await c.query(
        `INSERT INTO ludy_kernel.notification (org_id, user_id, kind, dedupe_key, subject_type, subject_id, legal_entity_id, detail) VALUES ($1, $2, 'kernel.original_flagged', $3, 'kernel.proposal', $4, $5, '{"differs":"true","signature":"none"}')`,
        [orgId, users.owner, `original_flagged:${subject}:x`, subject, defaultEntity],
      );
    });
    const items = await today(users.owner);
    expect(items.find((i) => i.id === 'originals-needed')).toMatchObject({ kind: 'flag', count: 1, severity: 'info', href: '/inbox' });
    expect(items.find((i) => i.id === 'originals-flagged')).toMatchObject({ kind: 'flag', count: 1, severity: 'warn', href: `/inbox/${subject}` });
    // Only the member the notice is for; and once opened (read) it is gone.
    expect((await today(users.approver)).find((i) => i.id === 'originals-flagged')).toBeUndefined();
    await admin((c) => c.query(`UPDATE ludy_kernel.notification SET read_at = now() WHERE org_id = $1 AND kind = 'kernel.original_flagged'`, [orgId]));
    expect((await today(users.owner)).find((i) => i.id === 'originals-flagged')).toBeUndefined();
    // A viewer gets neither, and the member limited to one entity does not see the org-wide item to fetch.
    expect((await today(users.viewer)).filter((i) => i.kind === 'flag')).toEqual([]);
    expect((await today(users.scoped)).find((i) => i.id === 'originals-needed')).toBeUndefined();
  });

  it('counts every unread kernel.original_flagged notice past 30 notices and obeys caller and entity scope (#2396)', async () => {
    const ownerSubjects = Array.from({ length: 35 }, () => randomUUID());
    const scopedDefaultSubject = randomUUID();
    const scopedBranchSubject = randomUUID();
    try {
      await admin(async (c) => {
        for (let i = 0; i < ownerSubjects.length; i += 1) {
          await c.query(
            `INSERT INTO ludy_kernel.notification (org_id, user_id, kind, dedupe_key, subject_type, subject_id, legal_entity_id, detail, created_at)
             VALUES ($1, $2, 'kernel.original_flagged', $3, 'kernel.proposal', $4, $5, '{"differs":"true","signature":"none"}', now() - interval '2 hours' + ($6::int * interval '1 second'))`,
            [orgId, users.owner, `t2396:flagged:${i}`, ownerSubjects[i], defaultEntity, i],
          );
        }
        // An entity-scoped member sees only unread notices of their assigned legal entity.
        await c.query(
          `INSERT INTO ludy_kernel.notification (org_id, user_id, kind, dedupe_key, subject_type, subject_id, legal_entity_id, detail)
           VALUES ($1, $2, 'kernel.original_flagged', 't2396:scoped:default', 'kernel.proposal', $3, $4, '{"differs":"true","signature":"none"}'),
                  ($1, $2, 'kernel.original_flagged', 't2396:scoped:branch', 'kernel.proposal', $5, $6, '{"differs":"true","signature":"none"}')`,
          [orgId, users.scoped, scopedDefaultSubject, defaultEntity, scopedBranchSubject, branch],
        );
      });

      const list35 = await rt.query<{ items: Array<{ kind: string }> }>('kernel.notification.list', {}, { actor: asUser(users.owner), orgId });
      expect(list35.items).toHaveLength(30);
      expect((await today(users.owner)).find((i) => i.id === 'originals-flagged')).toMatchObject({
        kind: 'flag',
        count: 35,
        severity: 'warn',
        href: '/inbox',
      });
      expect((await today(users.approver)).find((i) => i.id === 'originals-flagged')).toBeUndefined();
      expect((await today(users.scoped)).find((i) => i.id === 'originals-flagged')).toMatchObject({
        kind: 'flag',
        count: 1,
        severity: 'warn',
        href: `/inbox/${scopedDefaultSubject}`,
      });

      // Mark 33 of the 35 read (leaving the 2 oldest unread) and insert 35 newer unread notices of another kind so
      // kernel.notification.list's newest 30 hold zero kernel.original_flagged rows.
      await admin(async (c) => {
        await c.query(
          `UPDATE ludy_kernel.notification SET read_at = now()
           WHERE org_id = $1 AND user_id = $2 AND dedupe_key = ANY($3::text[])`,
          [orgId, users.owner, ownerSubjects.slice(2).map((_, i) => `t2396:flagged:${i + 2}`)],
        );
        for (let i = 0; i < 35; i += 1) {
          await c.query(
            `INSERT INTO ludy_kernel.notification (org_id, user_id, kind, dedupe_key, subject_type, subject_id, legal_entity_id, detail, created_at)
             VALUES ($1, $2, 'kernel.file_unreadable', $3, 'kernel.file', $4, $5, '{}', now() - interval '10 minutes' + ($6::int * interval '1 second'))`,
            [orgId, users.owner, `t2396:other:${i}`, randomUUID(), defaultEntity, i],
          );
        }
      });

      const listOther = await rt.query<{ items: Array<{ kind: string }> }>('kernel.notification.list', {}, { actor: asUser(users.owner), orgId });
      expect(listOther.items).toHaveLength(30);
      expect(listOther.items.filter((i) => i.kind === 'kernel.original_flagged')).toHaveLength(0);
      expect((await today(users.owner)).find((i) => i.id === 'originals-flagged')).toMatchObject({
        kind: 'flag',
        count: 2,
        severity: 'warn',
        href: '/inbox',
      });

      // With 1 older unread kernel.original_flagged left behind the 35 newer notices, the flag links directly to its proposal.
      await admin((c) =>
        c.query(`UPDATE ludy_kernel.notification SET read_at = now() WHERE org_id = $1 AND user_id = $2 AND dedupe_key = 't2396:flagged:1'`, [orgId, users.owner]),
      );
      expect((await today(users.owner)).find((i) => i.id === 'originals-flagged')).toMatchObject({
        kind: 'flag',
        count: 1,
        severity: 'warn',
        href: `/inbox/${ownerSubjects[0]}`,
      });
    } finally {
      await admin((c) => c.query(`DELETE FROM ludy_kernel.notification WHERE org_id = $1 AND dedupe_key LIKE 't2396:%'`, [orgId]));
    }
  });

  it.each(['month', 'quarter'] as const)('shows the next VAT return of a %s filer, only when it is due within the tax calendar window, and none without a filing period', async (kind) => {
    await admin((c) => c.query(`UPDATE ludy_kernel.tenant SET vat_filing_period = NULL WHERE org_id = $1`, [orgId]));
    expect((await today(users.owner)).filter((i) => i.kind === 'deadline')).toEqual([]);
    await rt.execute('kernel.org.set_vat_filing_period', { vatFilingPeriod: kind }, { actor: { ...asUser(users.owner), aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) }, orgId });
    const next = nextVatDeadline(kind, vietnamToday());
    const expected = next.daysLeft <= 30;
    // Which entities owe a period is decided by the day each was created against the period's last day (the default
    // entity always owes). The branch is created when the test runs, so which side of that day it falls on would change
    // with the date (#4193): set it from the period instead, once on each side.
    const lastDay = periodLastDay(next.period);
    const createdOn = (day: string) => admin((c) => c.query(`UPDATE ludy_kernel.legal_entity SET created_at = $2::timestamptz WHERE org_id = $1 AND id = $3`, [orgId, `${day}T12:00:00+07:00`, branch]));
    const original = (await admin((c) => c.query<{ created_at: Date }>(`SELECT created_at FROM ludy_kernel.legal_entity WHERE org_id = $1 AND id = $2`, [orgId, branch]))).rows[0]?.created_at as Date;
    for (const [side, day, entity] of [
      // The branch was added after the period ended, so only the default entity owes the return: the link names it.
      ['after the period', addDays(lastDay, 1), `&entity=${defaultEntity}`],
      // Added on its last day, the branch owes it too: two entities owe, so the link names none.
      ['on its last day', lastDay, ''],
    ] as const) {
      await createdOn(day);
      for (const who of [users.owner, users.viewer]) {
        const deadlines = (await today(who)).filter((i) => i.kind === 'deadline' && i.id.startsWith('vat:'));
        if (!expected) {
          expect(deadlines, `${who} ${side}`).toEqual([]);
          continue;
        }
        expect(deadlines, `${who} ${side}`).toHaveLength(1);
        expect(deadlines[0], `${who} ${side}`).toMatchObject({ id: `vat:${next.period}`, app: 'finance', dueAt: `${next.dueDate}T23:59:59+07:00`, href: `/vat?period=${next.period}${entity}` });
        expect(deadlines[0]?.amount).toBeUndefined();
      }
    }
    await admin((c) => c.query(`UPDATE ludy_kernel.legal_entity SET created_at = $2 WHERE org_id = $1 AND id = $3`, [orgId, original, branch]));
    await admin((c) => c.query(`UPDATE ludy_kernel.tenant SET vat_filing_period = NULL WHERE org_id = $1`, [orgId]));
  });

  // A pending purchase proposal written directly, with the payload fields finance.today reads.
  const insertPending = (parties: { seller: string; direction?: string }, invoice: Record<string, unknown>, eligible: string[], authors: string[]) =>
    admin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, legal_entity_id)
         VALUES ($1, 'finance.purchase', 'finance.purchase.record', 'pending', 'HĐ', $2, 1, $3::uuid[], $4, $5)`,
        [
          orgId,
          JSON.stringify({ seller: { name: parties.seller }, buyer: { name: 'Công ty có việc hôm nay' }, ...(parties.direction ? { direction: parties.direction } : {}), invoice, checks: [] }),
          eligible,
          JSON.stringify(authors.map((id) => ({ type: 'user', id }))),
          defaultEntity,
        ],
      ),
    );

  it('never adds two currencies: a foreign invoice booked in VND counts as VND, one waiting for its rate stays in its own', async () => {
    await insertPending({ seller: 'Foreign Co' }, { total: '24500000', currency: 'USD', foreign: { currency: 'USD', rate: '24500', source: 'entered', subtotal: '900', vatTotal: '100', total: '1000' } }, [users.owner], [users.admin]);
    await insertPending({ seller: 'Foreign Co' }, { total: '2000000', currency: 'VND' }, [users.owner], [users.admin]);
    await insertPending({ seller: 'Foreign Co' }, { total: '500', currency: 'USD' }, [users.owner], [users.admin]);
    await insertPending({ seller: 'Foreign Co' }, { total: '250', currency: 'USD' }, [users.owner], [users.admin]);
    const groups = (await today(users.owner)).filter((i) => i.title.params?.party === 'Foreign Co');
    expect(groups).toHaveLength(2);
    const vnd = groups.find((g) => g.currency === undefined);
    const usd = groups.find((g) => g.currency === 'USD');
    // The booked one and the plain VND one together; the two unrated USD ones apart, in dollars.
    expect(vnd).toMatchObject({ count: 2 });
    expect(Number(vnd?.amount)).toBe(26500000);
    expect(usd).toMatchObject({ count: 2, currency: 'USD' });
    expect(Number(usd?.amount)).toBe(750);
  });

  it('groups a vendor once whatever its letter case, and shows no total for a voucher', async () => {
    await insertPending({ seller: 'ACME Trading' }, { total: '1000000', currency: 'VND' }, [users.owner], [users.admin]);
    await insertPending({ seller: 'Acme Trading' }, { total: '2000000', currency: 'VND' }, [users.owner], [users.admin]);
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, legal_entity_id)
         VALUES ($1, 'finance.cash_voucher', 'finance.voucher.record', 'pending', 'Phiếu chi', '{"total":"500000","type":"cash_payment"}', 1, ARRAY[$2::uuid], $3, $4)`,
        [orgId, users.owner, JSON.stringify([{ type: 'user', id: users.admin }]), defaultEntity],
      ),
    );
    const items = (await today(users.owner)).filter((i) => i.kind === 'proposal');
    const acme = items.filter((i) => (i.title.params?.party as string | undefined)?.toLowerCase() === 'acme trading');
    expect(acme).toHaveLength(1);
    expect(acme[0]).toMatchObject({ count: 2 });
    expect(Number(acme[0]?.amount)).toBe(3000000);
    const voucher = items.find((i) => i.title.key === 'financeProposalsOther');
    expect(voucher).toMatchObject({ count: 1 });
    expect(voucher?.amount).toBeUndefined();
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('lets a writer of every approver decide only as an owner: an admin among the writers is not shown it', async () => {
    await insertPending({ seller: 'Four Eyes Co' }, { total: '100', currency: 'VND' }, [users.owner, users.admin], [users.owner, users.admin]);
    expect((await today(users.owner)).some((i) => i.title.params?.party === 'Four Eyes Co')).toBe(true);
    expect((await today(users.admin)).some((i) => i.title.params?.party === 'Four Eyes Co')).toBe(false);
  });

  it('holds a co-author back while another approver may decide, and shows it to the writers as before (#2736)', async () => {
    // A posting asked for by the admin; the owner approved the pay run (a co-author); a third person may approve too.
    const waiting = async (user: string) => (await today(user)).filter((i) => i.kind === 'proposal').reduce((n, i) => n + (i.count ?? 0), 0);
    const before = { owner: await waiting(users.owner), admin: await waiting(users.admin), approver: await waiting(users.approver) };
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, co_authors, legal_entity_id)
         VALUES ($1, 'finance.journal_voucher', 'finance.payroll_posting.record', 'pending', 'Hạch toán lương', '{}', 1, $2::uuid[], $3, $4::uuid[], $5)`,
        [orgId, [users.owner, users.admin, users.approver], JSON.stringify([{ type: 'user', id: users.admin }]), [users.owner], defaultEntity],
      ),
    );
    // The owner (co-author) and the admin (writer) do not see it as waiting for them; the third approver does.
    expect(await waiting(users.owner)).toBe(before.owner);
    expect(await waiting(users.admin)).toBe(before.admin);
    expect(await waiting(users.approver)).toBe(before.approver + 1);
    // With no one else left who may decide, the co-author sees it.
    await admin((c) => c.query(`UPDATE ludy_kernel.proposal SET eligible_approvers = $2::uuid[] WHERE org_id = $1 AND command = 'finance.payroll_posting.record' AND status = 'pending'`, [orgId, [users.owner, users.admin]]));
    expect(await waiting(users.owner)).toBe(before.owner + 1);
    expect(await waiting(users.admin)).toBe(before.admin);
    await admin((c) => c.query(`DELETE FROM ludy_kernel.proposal WHERE org_id = $1 AND command = 'finance.payroll_posting.record'`, [orgId]));
  });

  it('applies the accountant preset and live roles rather than the snapshot for waiting proposals and flags (#2749)', async () => {
    const chief = await upsertIdentity(createDb(pool), { issuer: 'test', subject: `chief-${randomUUID()}`, email: `chief-${randomUUID().slice(0, 6)}@finance-today.test`, name: null });
    await admin(async (c) => {
      await c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, chief]);
      await c.query(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', NULL, $3)`, [orgId, chief, users.owner]);
    });
    const waiting = async (user: string) => (await today(user)).filter((i) => i.kind === 'proposal').reduce((n, i) => n + (i.count ?? 0), 0);
    const hasFailedFlag = async (user: string) => (await today(user)).some((i) => i.id === `checks-failed:${defaultEntity}`);
    try {
      // Under the founder preset, if the third eligible approver in the snapshot is demoted to member, the co-author sees it from live roles.
      await admin((c) =>
        c.query(
          `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, co_authors, legal_entity_id)
           VALUES ($1, 'finance.journal_voucher', 'finance.payroll_posting.record', 'pending', 'Hạch toán lương', '{"checks":[{"id":"c1","status":"fail","code":"X"}]}', 1, $2::uuid[], $3, $4::uuid[], $5)`,
          [orgId, [users.owner, users.admin, users.approver], JSON.stringify([{ type: 'user', id: users.admin }]), [users.owner], defaultEntity],
        ),
      );
      const beforeDemote = { owner: await waiting(users.owner), approver: await waiting(users.approver) };
      await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgId, users.approver]));
      expect(await waiting(users.owner)).toBe(beforeDemote.owner + 1);
      expect(await waiting(users.approver)).toBe(0);
      await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgId, users.approver]));

      // Under the accountant preset, a co-author chief accountant is always refused, so neither the waiting item nor its flag is shown even when nobody else can decide;
      // the owner without finance.proposal.approve is not shown ledger items either, even when listed in the snapshot.
      await admin((c) => c.query(`DELETE FROM ludy_kernel.proposal WHERE org_id = $1 AND command = 'finance.payroll_posting.record'`, [orgId]));
      await admin((c) => c.query(`UPDATE ludy_kernel.tenant SET approval_preset = 'accountant' WHERE org_id = $1`, [orgId]));
      await admin((c) =>
        c.query(
          `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, co_authors, legal_entity_id)
           VALUES ($1, 'finance.journal_voucher', 'finance.payroll_posting.record', 'pending', 'Hạch toán lương', '{"checks":[{"id":"c1","status":"fail","code":"X"}]}', 1, $2::uuid[], $3, $4::uuid[], $5)`,
          [orgId, [users.owner, users.admin, chief], JSON.stringify([{ type: 'user', id: users.admin }]), [chief], defaultEntity],
        ),
      );
      expect(await waiting(chief)).toBe(0);
      expect(await hasFailedFlag(chief)).toBe(false);
      expect(await waiting(users.owner)).toBe(0);
      expect(await hasFailedFlag(users.owner)).toBe(false);
      // Without co-authors under the accountant preset, the chief accountant sees the ledger proposal, while the owner still does not.
      await admin((c) => c.query(`DELETE FROM ludy_kernel.proposal WHERE org_id = $1 AND command = 'finance.payroll_posting.record'`, [orgId]));
      await admin((c) =>
        c.query(
          `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, co_authors, legal_entity_id)
           VALUES ($1, 'finance.journal_voucher', 'finance.payroll_posting.record', 'pending', 'Hạch toán lương', '{}', 1, $2::uuid[], $3, NULL, $4)`,
          [orgId, [users.owner, users.admin, chief], JSON.stringify([{ type: 'user', id: users.admin }]), defaultEntity],
        ),
      );
      expect(await waiting(chief)).toBe(1);
      expect(await waiting(users.owner)).toBe(0);
      // Non-ledger live finance commands (finance.supplier_payment.record) remain governed by live base roles even under the accountant preset.
      await admin((c) =>
        c.query(
          `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, legal_entity_id)
           VALUES ($1, 'finance.supplier_payment', 'finance.supplier_payment.record', 'pending', 'Chi NCC', '{}', 1, $2::uuid[], $3, $4)`,
          [orgId, [users.admin], JSON.stringify([{ type: 'user', id: users.admin }]), defaultEntity],
        ),
      );
      expect(await waiting(users.owner)).toBe(1);
      expect(await waiting(chief)).toBe(1);
      // A proposal with a malformed authors entry (such as a co_author entry inside authors, which parseAuthors refuses)
      // is excluded from both waiting proposals and flags even for live commands.
      await admin((c) => c.query(`DELETE FROM ludy_kernel.proposal WHERE org_id = $1 AND command IN ('finance.payroll_posting.record', 'finance.supplier_payment.record')`, [orgId]));
      await admin((c) =>
        c.query(
          `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, legal_entity_id)
           VALUES ($1, 'finance.supplier_payment', 'finance.supplier_payment.record', 'pending', 'Chi NCC', '{"checks":[{"id":"c1","status":"fail","code":"X"}]}', 1, $2::uuid[], $3, $4)`,
          [orgId, [users.owner], JSON.stringify([{ type: 'user', id: users.admin }, { type: 'co_author', id: users.owner }]), defaultEntity],
        ),
      );
      expect(await waiting(users.owner)).toBe(0);
      expect(await hasFailedFlag(users.owner)).toBe(false);
    } finally {
      await admin((c) => c.query(`UPDATE ludy_kernel.tenant SET approval_preset = 'founder' WHERE org_id = $1`, [orgId]));
      await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [orgId, users.approver]));
      await admin((c) => c.query(`DELETE FROM ludy_kernel.proposal WHERE org_id = $1 AND command IN ('finance.payroll_posting.record', 'finance.supplier_payment.record')`, [orgId]));
      await admin((c) => c.query(`DELETE FROM ludy_kernel.tenant_member WHERE org_id = $1 AND user_id = $2`, [orgId, chief]));
    }
  });

  // Creates an isolated org with an owner, two admins, two chief accountants (member + finance.chief_accountant) and a member.
  async function createParityOrg(label: string) {
    const db = createDb(pool);
    const makeUser = (role: string) =>
      upsertIdentity(db, { issuer: 'test', subject: `${label}-${role}-${randomUUID()}`, email: `${label}-${role}-${randomUUID().slice(0, 8)}@finance-today.test`, name: null });
    const [owner, admin1, admin2, chief1, chief2, member] = await Promise.all([
      makeUser('owner'),
      makeUser('admin1'),
      makeUser('admin2'),
      makeUser('chief1'),
      makeUser('chief2'),
      makeUser('member'),
    ]);
    const { orgId: isoOrgId } = await createOrg(rt, asUser(owner), `Org ${label}`);
    const entityId = await admin(async (c) => {
      const entity = (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [isoOrgId])).rows[0]?.id as string;
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member')`,
        [isoOrgId, admin1, admin2, chief1, chief2, member],
      );
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'finance.chief_accountant', NULL, $4), ($1, $3, 'finance.chief_accountant', NULL, $4)`,
        [isoOrgId, chief1, chief2, owner],
      );
      return entity;
    });

    const insertProposal = async (opts: {
      kind: string;
      command: string;
      eligible: string[];
      authors: string[];
      coAuthors?: string[] | null;
      failCheck?: boolean;
    }): Promise<string> => {
      const checks = opts.failCheck === false ? [] : [{ id: 'c1', status: 'fail', code: 'X' }];
      const payload =
        opts.kind === 'finance.purchase'
          ? { seller: { name: 'Nhà cung cấp Parity' }, buyer: { name: 'Buyer' }, invoice: { total: '100000', currency: 'VND' }, checks }
          : { checks };
      return admin(async (c) => {
        const res = await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, co_authors, legal_entity_id)
           VALUES ($1, $2, $3, 'pending', 'Parity', $4::jsonb, 1, $5::uuid[], $6::jsonb, $7::uuid[], $8)
           RETURNING id`,
          [
            isoOrgId,
            opts.kind,
            opts.command,
            JSON.stringify(payload),
            opts.eligible,
            JSON.stringify(opts.authors.map((id) => ({ type: 'user', id }))),
            opts.coAuthors ?? null,
            entityId,
          ],
        );
        return res.rows[0]?.id as string;
      });
    };

    const assertParity = async (
      proposalId: string,
      who: string,
      expected: { visible: boolean; canApprove: boolean; approveReason: 'ok' | 'four_eyes' | 'not_eligible' },
      hasFail = true,
    ) => {
      const items = await today(who, isoOrgId);
      const waitingCount = items.filter((i) => i.kind === 'proposal').reduce((n, i) => n + (i.count ?? 0), 0);
      const hasFailedFlag = items.some((i) => i.id === `checks-failed:${entityId}`);
      const inbox = await rt.query<{ canApprove: boolean; approveReason: string }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(who), orgId: isoOrgId });
      expect(waitingCount, `waitingCount for ${who}`).toBe(expected.visible ? 1 : 0);
      expect(hasFailedFlag, `hasFailedFlag for ${who}`).toBe(expected.visible && hasFail);
      expect(inbox.canApprove, `canApprove for ${who}`).toBe(expected.canApprove);
      expect(inbox.approveReason, `approveReason for ${who}`).toBe(expected.approveReason);
    };

    const clearProposals = () => admin((c) => c.query(`DELETE FROM ludy_kernel.proposal WHERE org_id = $1`, [isoOrgId]));
    const setPreset = (preset: 'founder' | 'accountant') => admin((c) => c.query(`UPDATE ludy_kernel.tenant SET approval_preset = $2 WHERE org_id = $1`, [isoOrgId, preset]));

    return { orgId: isoOrgId, entityId, owner, admin1, admin2, chief1, chief2, member, insertProposal, assertParity, clearProposals, setPreset };
  }

  it('refuses direct authors and co-authors on ledger proposals under the accountant preset, matching decideApproval (#2396)', async () => {
    const org = await createParityOrg('acc-preset');

    // 1. Direct author who is the sole eligible approver on a ledger proposal: allowed under founder, refused under accountant.
    const soleChiefPurchase = await org.insertProposal({
      kind: 'finance.purchase',
      command: 'finance.purchase.record',
      eligible: [org.chief1],
      authors: [org.chief1],
    });
    await org.assertParity(soleChiefPurchase, org.chief1, { visible: true, canApprove: true, approveReason: 'ok' });
    await org.setPreset('accountant');
    await org.assertParity(soleChiefPurchase, org.chief1, { visible: false, canApprove: false, approveReason: 'four_eyes' });
    await org.clearProposals();

    // 2. Every eligible approver is a direct author, and the owner also holds finance.chief_accountant:
    // founder allows owner_override; accountant refuses even the owner.
    await org.setPreset('founder');
    await admin((c) =>
      c.query(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'finance.chief_accountant', NULL, $2)`, [org.orgId, org.owner]),
    );
    const allAuthorsPurchase = await org.insertProposal({
      kind: 'finance.purchase',
      command: 'finance.purchase.record',
      eligible: [org.owner, org.chief1],
      authors: [org.owner, org.chief1],
    });
    await org.assertParity(allAuthorsPurchase, org.owner, { visible: true, canApprove: true, approveReason: 'ok' });
    await org.assertParity(allAuthorsPurchase, org.chief1, { visible: false, canApprove: false, approveReason: 'four_eyes' });
    await org.setPreset('accountant');
    await org.assertParity(allAuthorsPurchase, org.owner, { visible: false, canApprove: false, approveReason: 'four_eyes' });
    await org.assertParity(allAuthorsPurchase, org.chief1, { visible: false, canApprove: false, approveReason: 'four_eyes' });
    await org.assertParity(allAuthorsPurchase, org.admin1, { visible: false, canApprove: false, approveReason: 'not_eligible' });
    await org.clearProposals();

    // 3. Co-author chief/owner on a payroll posting under accountant preset: refused even when sole eligible approver;
    // a second non-author chief accountant sees and approves it.
    const coOwnerSole = await org.insertProposal({
      kind: 'finance.journal_voucher',
      command: 'finance.payroll_posting.record',
      eligible: [org.owner],
      authors: [org.admin1],
      coAuthors: [org.owner],
    });
    await org.assertParity(coOwnerSole, org.owner, { visible: false, canApprove: false, approveReason: 'four_eyes' });
    await org.clearProposals();

    const coChiefPair = await org.insertProposal({
      kind: 'finance.journal_voucher',
      command: 'finance.payroll_posting.record',
      eligible: [org.chief1, org.chief2],
      authors: [org.admin1],
      coAuthors: [org.chief1],
    });
    await org.assertParity(coChiefPair, org.chief1, { visible: false, canApprove: false, approveReason: 'four_eyes' });
    await org.assertParity(coChiefPair, org.chief2, { visible: true, canApprove: true, approveReason: 'ok' });
    await org.clearProposals();

    // 4. Non-ledger live command (finance.supplier_payment.record) stays governed by live base roles under accountant preset:
    // when every live base approver (owner, admin1, admin2) wrote it, owner_override still holds; chief (member) is not eligible.
    const livePayment = await org.insertProposal({
      kind: 'finance.supplier_payment',
      command: 'finance.supplier_payment.record',
      eligible: [org.admin1],
      authors: [org.owner, org.admin1, org.admin2],
    });
    await org.assertParity(livePayment, org.owner, { visible: true, canApprove: true, approveReason: 'ok' });
    await org.assertParity(livePayment, org.admin1, { visible: false, canApprove: false, approveReason: 'four_eyes' });
    await org.assertParity(livePayment, org.chief1, { visible: false, canApprove: false, approveReason: 'not_eligible' });
  });

  it('excludes demoted or role-revoked approvers from waiting proposals and flags and updates live four-eyes, matching decideApproval (#2396)', async () => {
    const org = await createParityOrg('demoted');

    // 1. Demoting an eligible admin to member removes their waiting proposal and checks-failed flag, and updates
    // soleApprover / everyApproverWrote for the remaining live eligible approvers under the founder preset.
    const twoAdmins = await org.insertProposal({
      kind: 'finance.purchase',
      command: 'finance.purchase.record',
      eligible: [org.admin1, org.admin2],
      authors: [org.admin1],
    });
    await org.assertParity(twoAdmins, org.admin2, { visible: true, canApprove: true, approveReason: 'ok' });
    await org.assertParity(twoAdmins, org.admin1, { visible: false, canApprove: false, approveReason: 'four_eyes' });

    await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [org.orgId, org.admin2]));
    await org.assertParity(twoAdmins, org.admin2, { visible: false, canApprove: false, approveReason: 'not_eligible' });
    await org.assertParity(twoAdmins, org.admin1, { visible: true, canApprove: true, approveReason: 'ok' });
    await org.clearProposals();

    await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [org.orgId, org.admin2]));
    const ownerOverrideAfterDemote = await org.insertProposal({
      kind: 'finance.purchase',
      command: 'finance.purchase.record',
      eligible: [org.owner, org.admin1, org.admin2],
      authors: [org.owner, org.admin1],
    });
    await org.assertParity(ownerOverrideAfterDemote, org.owner, { visible: false, canApprove: false, approveReason: 'four_eyes' });
    await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [org.orgId, org.admin2]));
    await org.assertParity(ownerOverrideAfterDemote, org.admin2, { visible: false, canApprove: false, approveReason: 'not_eligible' });
    await org.assertParity(ownerOverrideAfterDemote, org.owner, { visible: true, canApprove: true, approveReason: 'ok' });
    await org.clearProposals();

    // Under founder preset, demoting a chief accountant to viewer (keeping role_assignment) drops their permission too.
    const adminAndChief = await org.insertProposal({
      kind: 'finance.purchase',
      command: 'finance.purchase.record',
      eligible: [org.admin1, org.chief2],
      authors: [org.admin1],
    });
    await org.assertParity(adminAndChief, org.chief2, { visible: true, canApprove: true, approveReason: 'ok' });
    await org.assertParity(adminAndChief, org.admin1, { visible: false, canApprove: false, approveReason: 'four_eyes' });
    await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [org.orgId, org.chief2]));
    await org.assertParity(adminAndChief, org.chief2, { visible: false, canApprove: false, approveReason: 'not_eligible' });
    await org.assertParity(adminAndChief, org.admin1, { visible: true, canApprove: true, approveReason: 'ok' });
    await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [org.orgId, org.chief2]));
    await org.clearProposals();

    // 2. Under the accountant preset, demoting a chief accountant to viewer (even while their role_assignment row remains)
    // or revoking their finance.chief_accountant role removes eligibility, while a direct-author chief still cannot self-approve.
    await org.setPreset('accountant');
    const twoChiefs = await org.insertProposal({
      kind: 'finance.purchase',
      command: 'finance.purchase.record',
      eligible: [org.chief1, org.chief2],
      authors: [org.chief1],
    });
    await org.assertParity(twoChiefs, org.chief2, { visible: true, canApprove: true, approveReason: 'ok' });
    await org.assertParity(twoChiefs, org.chief1, { visible: false, canApprove: false, approveReason: 'four_eyes' });

    await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [org.orgId, org.chief2]));
    await org.assertParity(twoChiefs, org.chief2, { visible: false, canApprove: false, approveReason: 'not_eligible' });
    await org.assertParity(twoChiefs, org.chief1, { visible: false, canApprove: false, approveReason: 'four_eyes' });

    await admin(async (c) => {
      await c.query(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [org.orgId, org.chief2]);
      await c.query(`DELETE FROM ludy_kernel.role_assignment WHERE org_id = $1 AND user_id = $2 AND role_key = 'finance.chief_accountant'`, [org.orgId, org.chief2]);
    });
    await org.assertParity(twoChiefs, org.chief2, { visible: false, canApprove: false, approveReason: 'not_eligible' });
    await org.assertParity(twoChiefs, org.chief1, { visible: false, canApprove: false, approveReason: 'four_eyes' });
    await org.clearProposals();

    // 3. Non-ledger live command (finance.supplier_payment.record): demoting admins drops them even when listed in the
    // snapshot, and leaves the author owner as sole live eligible approver.
    await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2`, [org.orgId, org.admin2]));
    const livePayment = await org.insertProposal({
      kind: 'finance.supplier_payment',
      command: 'finance.supplier_payment.record',
      eligible: [org.owner, org.admin1, org.admin2],
      authors: [org.owner, org.admin1],
    });
    await org.assertParity(livePayment, org.admin2, { visible: true, canApprove: true, approveReason: 'ok' });
    await org.assertParity(livePayment, org.owner, { visible: false, canApprove: false, approveReason: 'four_eyes' });

    await admin((c) => c.query(`UPDATE ludy_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = ANY($2::uuid[])`, [org.orgId, [org.admin1, org.admin2]]));
    await org.assertParity(livePayment, org.admin2, { visible: false, canApprove: false, approveReason: 'not_eligible' });
    await org.assertParity(livePayment, org.admin1, { visible: false, canApprove: false, approveReason: 'not_eligible' });
    await org.assertParity(livePayment, org.owner, { visible: true, canApprove: true, approveReason: 'ok' });
  });

  it('reads 1,000 pending proposals in one grouped pass', async () => {
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, legal_entity_id)
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
    // The listed groups are capped at 30 and one more item says how many proposals the rest hold: every proposal waiting
    // for the owner is counted once, in a group or in the rest.
    const rest = groups.find((g) => g.id === 'proposals-more');
    expect(groups.length - 1).toBe(30);
    expect(rest?.count).toBeGreaterThan(0);
    expect(groups.filter((g) => g.title.params?.party?.toString().startsWith('Nhà cung cấp ')).every((g) => g.count === 25)).toBe(true);
    const waiting = await admin(async (c) => Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ludy_kernel.proposal WHERE org_id = $1 AND status = 'pending' AND command LIKE 'finance.%' AND eligible_approvers @> ARRAY[$2::uuid]`, [orgId, users.owner])).rows[0]?.n));
    // The owner wrote none of these (the admin did), so all wait for the owner except those the owner wrote with the others.
    const total = groups.reduce((n, g) => n + (g.count ?? 0), 0);
    expect(total).toBeLessThanOrEqual(waiting);
    expect(total).toBeGreaterThanOrEqual(1000);
    expect(elapsed).toBeLessThan(5000);

    // Repeat with 1,000 payroll_posting co-author proposals: 500 with another independent approver (hidden) and 500 with none (shown).
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_kernel.proposal (org_id, kind, command, status, title, payload, revision, eligible_approvers, authors, co_authors, legal_entity_id)
         SELECT $1, 'finance.journal_voucher', 'finance.payroll_posting.record', 'pending', 'Hạch toán ' || g, '{}', 1,
                CASE WHEN g <= 500 THEN ARRAY[$2::uuid, $3::uuid, $4::uuid] ELSE ARRAY[$2::uuid, $3::uuid] END,
                jsonb_build_array(jsonb_build_object('type', 'user', 'id', $3::text)),
                ARRAY[$2::uuid], $5
         FROM generate_series(1, 1000) g`,
        [orgId, users.owner, users.admin, users.approver, defaultEntity],
      ),
    );
    const coStarted = Date.now();
    const coItems = await today(users.owner);
    const coElapsed = Date.now() - coStarted;
    expect(coItems.filter((i) => i.kind === 'proposal').reduce((n, g) => n + (g.count ?? 0), 0)).toBe(total + 500);
    expect(coElapsed).toBeLessThan(5000);
    await admin((c) => c.query(`DELETE FROM ludy_kernel.proposal WHERE org_id = $1 AND command = 'finance.payroll_posting.record'`, [orgId]));
  });

  it('flags the sales e-invoices that need a person (#2502): failed, sent back with a reason, or unanswered for an hour; not a fresh send nor a plain draft', async () => {
    const entity = (await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [otherOrgId])).rows[0]))?.id as string;
    // Seeded as the database owner with the triggers off: the states and times the job and the clock would make.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      const insert = (state: string, extra: string) =>
        c.query(`INSERT INTO ludy_finance.einvoice_draft (org_id, legal_entity_id, state, invoice_date, buyer_kind, subtotal, vat_amount, total, ${extra.split('|')[0]}) VALUES ($1, $2, $3, current_date, 'consumer', 0, 0, 0, ${extra.split('|')[1]})`, [otherOrgId, entity, state]);
      await insert('failed', "submitted_at, error_code|now() - interval '2 hours', 'PROVIDER_NOT_READY'");
      await insert('draft', "error_code|'REJECTED_BY_TAX_AUTHORITY'");
      await insert('pending', "submitted_at, provider_ref|now() - interval '2 hours', 'sbx-old'");
      await insert('pending', "submitted_at, provider_ref|now() - interval '5 minutes', 'sbx-new'");
      await insert('draft', 'error_code|NULL');
      await c.query('COMMIT');
    });
    const flag = (items: Awaited<ReturnType<typeof today>>) => items.find((i) => i.id === `einvoice-attention:${entity}`);
    const seen = flag(await today(users.outsider, otherOrgId));
    expect(seen).toMatchObject({ kind: 'flag', app: 'finance', count: 3, severity: 'warn', title: { key: 'financeEinvoiceAttention', params: { count: 3 } }, href: '/sales-invoices' });
  });
});
