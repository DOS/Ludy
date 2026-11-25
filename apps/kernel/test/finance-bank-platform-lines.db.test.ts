// SPDX-License-Identifier: AGPL-3.0-only
// The bank and card lines that name an ad platform (finance.bank.platform_lines, Ads slice D2, #3417) on a real PostgreSQL 17:
// the lines of the entity asked for, in the range, whose description holds a name as whole words with marks and case set aside;
// a line of another legal entity the caller cannot see, or of another org, never appears. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { BankPlatformLines, BankStatementRow } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the bank lines that name an ad platform (#3417)', () => {
  const dbName = `ludy_test_platform_lines_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@platform-lines.test`, name: null }) as Promise<string>;
  const line = (rowNo: number, date: string, description: string, moneyOut: string, reference: string): BankStatementRow => ({ rowNo, date, description, moneyIn: '', moneyOut, balance: '', reference });

  async function org(label: string) {
    const owner = await identity(`owner-${label}`);
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${label} ${randomUUID().slice(0, 6)}`);
    const branchMember = await identity(`branch-${label}`);
    const entity = (await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    const branch = (await rows<{ id: string }>("INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]?.id as string;
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, branchMember]);
    await rows("INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, branchMember, branch, owner]);
    const importLines = (statement: BankStatementRow[], legalEntityId?: string) =>
      rt.execute('finance.bank.import', { bankAccount: '1121', filename: `sao-ke-${randomUUID().slice(0, 6)}.xlsx`, rows: statement, ...(legalEntityId ? { legalEntityId } : {}) }, { actor: asUser(owner), orgId, idempotencyKey: randomUUID() });
    const platformLines = (user: string, input: { from: string; to: string; terms: string[]; legalEntityId?: string }) => rt.query<BankPlatformLines>('finance.bank.platform_lines', input, { actor: asUser(user), orgId });
    return { owner, orgId, branchMember, entity, branch, importLines, platformLines };
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
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const RANGE = { from: '2026-11-01', to: '2026-11-30' };

  it('finds the lines that hold a name as whole words, marks and case set aside, in the range, and nothing else', async () => {
    const o = await org('a');
    await o.importLines([
      line(1, '05/11/2026', 'GOOGLE ADS 4567 SINGAPORE', '500000', 'FT1'),
      line(2, '06/11/2026', 'Thanh toán facebook ads', '300000', 'FT2'),
      line(3, '07/11/2026', 'Googlers Cafe', '45000', 'FT3'),
      line(4, '08/11/2026', 'Tien dien thang 11', '900000', 'FT4'),
      line(5, '10/10/2026', 'Google Ads October', '400000', 'FT5'),
    ]);
    const google = await o.platformLines(o.owner, { ...RANGE, terms: ['Google'] });
    expect(google.truncated).toBe(false);
    expect(google.from).toBe(RANGE.from);
    expect(google.lines.map((l) => l.description)).toEqual(['GOOGLE ADS 4567 SINGAPORE']);
    expect(google.lines[0]).toMatchObject({ bankAccount: '1121', date: '2026-11-05', amount: '-500000', state: { status: 'open' } });
    const meta = await o.platformLines(o.owner, { ...RANGE, terms: ['Meta Platforms', 'Facebook'] });
    expect(meta.lines.map((l) => l.description)).toEqual(['Thanh toán facebook ads']);
    // The range decides: October's line is in October's range, and another name finds none.
    expect((await o.platformLines(o.owner, { from: '2026-10-01', to: '2026-10-31', terms: ['Google'] })).lines.map((l) => l.description)).toEqual(['Google Ads October']);
    expect((await o.platformLines(o.owner, { ...RANGE, terms: ['TikTok'] })).lines).toEqual([]);
  });

  it('lists the lines of the entity asked for, and a member who sees one entity sees only its lines', async () => {
    const o = await org('b');
    await o.importLines([line(1, '05/11/2026', 'Google Ads head office', '500000', 'FT1')]);
    await o.importLines([line(1, '06/11/2026', 'Google Ads branch', '100000', 'FT2')], o.branch);
    const names = async (user: string, legalEntityId?: string) => (await o.platformLines(user, { ...RANGE, terms: ['Google'], ...(legalEntityId ? { legalEntityId } : {}) })).lines.map((l) => l.description);
    expect(await names(o.owner)).toEqual(['Google Ads head office']);
    expect(await names(o.owner, o.entity)).toEqual(['Google Ads head office']);
    expect(await names(o.owner, o.branch)).toEqual(['Google Ads branch']);
    // The member limited to the branch sees its lines, by default and by name; the head office's are not theirs to see.
    expect(await names(o.branchMember)).toEqual(['Google Ads branch']);
    expect(await names(o.branchMember, o.branch)).toEqual(['Google Ads branch']);
    const head = await names(o.branchMember, o.entity).catch(() => [] as string[]);
    expect(head).toEqual([]);
  });

  it('never shows a line of another org', async () => {
    const [a, b] = [await org('c'), await org('d')];
    await a.importLines([line(1, '05/11/2026', 'Google Ads org C', '500000', 'FT1')]);
    await b.importLines([line(1, '05/11/2026', 'Google Ads org D', '700000', 'FT9')]);
    expect((await a.platformLines(a.owner, { ...RANGE, terms: ['Google'] })).lines.map((l) => l.description)).toEqual(['Google Ads org C']);
    expect((await b.platformLines(b.owner, { ...RANGE, terms: ['Google'] })).lines.map((l) => l.description)).toEqual(['Google Ads org D']);
    // Asking org B's books as org A's owner finds no member there.
    await expect(rt.query('finance.bank.platform_lines', { ...RANGE, terms: ['Google'] }, { actor: asUser(a.owner), orgId: b.orgId })).rejects.toBeDefined();
  });

  it('refuses a request without a usable name', async () => {
    const o = await org('e');
    await expect(o.platformLines(o.owner, { ...RANGE, terms: [] })).rejects.toBeDefined();
    await expect(o.platformLines(o.owner, { ...RANGE, terms: ['G'] })).rejects.toBeDefined();
    // A name that folds to nothing (only punctuation) finds nothing, never every line.
    await o.importLines([line(1, '05/11/2026', 'Google Ads', '500000', 'FT1')]);
    expect((await o.platformLines(o.owner, { ...RANGE, terms: ['--'] })).lines).toEqual([]);
  });
});
