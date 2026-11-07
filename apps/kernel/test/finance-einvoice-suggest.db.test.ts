// SPDX-License-Identifier: AGPL-3.0-only
// The finance coworker on a sales e-invoice draft (#2505) on PostgreSQL 17: finance.einvoice_draft.suggest_source offers the model only the customers whose names share a word with the
// text (the best match first), with the VAT rates of the earlier drafts to each and of the org, to owners, admins and members, and never another org's; a viewer is refused. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
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
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Series {
  id: string;
  legalEntityId: string;
  templateNo: string;
  symbol: string;
  isDefault: boolean;
}
interface Draft {
  id: string;
  legalEntityId: string;
  state: string;
  seriesId: string | null;
  subtotal: string;
  vatAmount: string;
  total: string;
  lines: Array<{ lineNo: number; amount: string; vatAmount: string; vatRate: string }>;
  issues: Array<{ field: string; code: string }>;
}

// A synthetic tax code made at run time (the repository holds no checksum-valid one): a nine digit prefix and its check digit.
const PREFIX = '010010910';
const VALID_TAX_CODE = `${PREFIX}${enterpriseCheckDigit(PREFIX)}`;

const today = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

suite('the coworker on a sales e-invoice draft (#2505)', () => {
  const dbName = `crove_test_einvoice_suggest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@company.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Hóa Đơn ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]),
    );
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const auditOf = (o: Org, command: string) =>
    admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 AND outcome = 'ok' ORDER BY occurred_at`, [o.orgId, command])).rows);

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

  const sync = async (o: Org) => execute<{ series: Series[] }>(o, 'finance.einvoice_series.sync', { legalEntityId: null, provider: 'sandbox' });
  const party = (o: Org, name: string, extra: { taxCode?: string; address?: string; kind?: string } = {}) =>
    admin(async (c) => (await c.query<{ id: string }>('INSERT INTO crove_kernel.party (org_id, name, tax_code, address, kind) VALUES ($1, $2, $3, $4, $5) RETURNING id', [o.orgId, name, extra.taxCode ?? null, extra.address ?? null, extra.kind ?? 'organization'])).rows[0]?.id as string);
  const saveDraft = (o: Org, seriesId: string | null, partyId: string | null, vatRate: string) =>
    execute<Draft>(o, 'finance.einvoice_draft.save', {
      draftId: null,
      legalEntityId: null,
      date: today(),
      seriesId,
      buyer: { kind: 'business', partyId, taxCode: VALID_TAX_CODE, name: 'Công ty Mua Thử', address: '1 Phố Thử, Hà Nội', email: null },
      lines: [{ description: 'Hàng A', unit: 'cái', quantity: '2', unitPrice: '100000', vatRate }],
    });
  interface Source {
    parties: Array<{ id: string; name: string; kind: string; taxCode: string | null; address: string | null; email: string | null; rates: Array<{ vatRate: string; n: number }> }>;
    orgRates: Array<{ vatRate: string; n: number }>;
  }
  const source = (o: Org, text: string, user = o.owner) => query<Source>(o, 'finance.einvoice_draft.suggest_source', { text, date: today() }, user);

  it('offers the customers whose names share a word with the text, the best match first, with their record', async () => {
    const o = await org();
    const nam = await party(o, 'Nguyễn Văn Nam', { kind: 'person', address: '5 Phố Nam, Huế' });
    const maiHoa = await party(o, 'Công ty Hoa Mai', { taxCode: VALID_TAX_CODE, address: '9 Phố Mai, Hà Nội' });
    const lan = await party(o, 'Cửa hàng Lan Anh');
    await party(o, 'Quán Cà Phê Sáng');
    const result = await source(o, 'bán 10 hộp bánh A giá 120k cho anh Nam, công ty Hoa Mai nhận hộ');
    // "công", "hoa" and "mai" fit one name, "anh" is part of another ("Lan Anh") and "nam" of a third: the name that holds more of the words comes first, ties by name, and a name that
    // holds none of the words is not offered.
    expect(result.parties.map((p) => p.id)).toEqual([maiHoa, lan, nam]);
    expect(result.parties[0]).toMatchObject({ name: 'Công ty Hoa Mai', kind: 'organization', taxCode: VALID_TAX_CODE, address: '9 Phố Mai, Hà Nội', rates: [] });
    expect(result.parties[2]).toMatchObject({ name: 'Nguyễn Văn Nam', kind: 'person', taxCode: null });
    // A text with no word of three letters, or none a name holds, offers no customer at all.
    expect((await source(o, '10 x 5')).parties).toEqual([]);
    expect((await source(o, 'bán xyz linh tinh')).parties).toEqual([]);
  });

  it('does not offer a customer that was merged into another', async () => {
    const o = await org();
    const keep = await party(o, 'Nguyễn Văn Nam', { kind: 'person' });
    const merged = await party(o, 'Nguyễn Văn Nam cũ', { kind: 'person' });
    await admin((c) => c.query('UPDATE crove_kernel.party SET duplicate_of = $3 WHERE org_id = $1 AND id = $2', [o.orgId, merged, keep]));
    expect((await source(o, 'bán cho anh Nam')).parties.map((p) => p.id)).toEqual([keep]);
  });

  it('gives the VAT rates of the earlier drafts to a customer and of the whole org, and offers nothing of another org', async () => {
    const o = await org();
    const [series] = (await sync(o)).series;
    const nam = await party(o, 'Nguyễn Văn Nam', { kind: 'person' });
    const other = await party(o, 'Trần Thị Bé', { kind: 'person' });
    await saveDraft(o, series?.id ?? null, nam, '8%');
    await saveDraft(o, series?.id ?? null, nam, '8%');
    await saveDraft(o, series?.id ?? null, nam, '10%');
    await saveDraft(o, series?.id ?? null, other, '5%');
    await saveDraft(o, series?.id ?? null, null, '10%');
    const result = await source(o, 'bán cho anh Nam');
    const rates = (rows: Array<{ vatRate: string; n: number }>) => Object.fromEntries(rows.map((r) => [r.vatRate, r.n]));
    expect(rates(result.parties[0]?.rates ?? [])).toEqual({ '8%': 2, '10%': 1 });
    expect(rates(result.orgRates)).toEqual({ '8%': 2, '10%': 2, '5%': 1 });
    const stranger = await org();
    const none = await source(stranger, 'bán cho anh Nam');
    expect(none.parties).toEqual([]);
    expect(none.orgRates).toEqual([]);
  });

  it('is read by owners, admins and members and refused to a viewer, and it writes nothing', async () => {
    const o = await org();
    await party(o, 'Nguyễn Văn Nam', { kind: 'person' });
    for (const who of [o.owner, o.admin, o.member]) expect((await source(o, 'bán cho anh Nam', who)).parties).toHaveLength(1);
    await expect(source(o, 'bán cho anh Nam', o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await auditOf(o, 'finance.einvoice_draft.suggest_source')).toEqual([]);
    expect(await query<unknown[]>(o, 'finance.einvoice_draft.list', {})).toEqual([]);
  });

  it('refuses a text that is empty or longer than the form takes, and a date that is not a date', async () => {
    const o = await org();
    for (const input of [{ text: '   ', date: today() }, { text: 'x'.repeat(2001), date: today() }, { text: 'bán hàng', date: 'hôm nay' }]) {
      await expect(query(o, 'finance.einvoice_draft.suggest_source', input)).rejects.toBeDefined();
    }
  });
});
