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
    invoice: { text: string } | null;
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

  // The previous invoice as a source (#2721). An invoice is issued as the issue job does it, as a worker login in the org's system context: `submitting` first (with the triggers off, as the
  // draft tests do), then `issued`.
  async function issue(o: Org, draftId: string, minutesAgo = 0) {
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query("UPDATE crove_finance.einvoice_draft SET state = 'submitting', submitted_at = pg_catalog.now() WHERE org_id = $1 AND id = $2 AND state = 'draft'", [o.orgId, draftId]);
      await c.query('COMMIT');
    });
    const c = await workerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
      await c.query(
        "UPDATE crove_finance.einvoice_draft SET state = 'issued', provider_ref = 'sbx-test', issued_number = $3, issued_at = pg_catalog.now() - make_interval(mins => $4::int) WHERE org_id = $1 AND id = $2",
        [o.orgId, draftId, `000${minutesAgo}`, minutesAgo],
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  }
  interface Previous {
    invoice: { draftId: string; date: string; number: string | null; buyer: { kind: string; partyId: string | null; name: string | null; taxCode: string | null; address: string | null }; lines: Array<{ description: string; quantity: string; unitPrice: string; vatRate: string; vatAllowed: boolean }> } | null;
  }
  const previous = (o: Org, buyerPartyId: string, date = today(), user = o.owner, legalEntityId?: string) =>
    query<Previous>(o, 'finance.einvoice_draft.previous_invoice', { buyerPartyId, date, ...(legalEntityId ? { legalEntityId } : {}) }, user);

  it('gives the newest issued invoice to a customer, with the buyer and the lines it held, and not a draft or another customer\'s', async () => {
    const o = await org();
    const hoa = await party(o, 'Công ty Hoa Mai');
    const other = await party(o, 'Cửa hàng Lan Anh');
    expect((await previous(o, hoa)).invoice).toBeNull();
    const older = await saveDraft(o, null, hoa, '10%');
    const newer = await saveDraft(o, null, hoa, '10%');
    const stillDraft = await saveDraft(o, null, hoa, '10%');
    await saveDraft(o, null, other, '10%').then((d) => issue(o, d.id, 1));
    await issue(o, older.id, 60);
    await issue(o, newer.id, 5);
    // The buyer's name comes from the record, and the invoice's own tax code and address stay while the record has none; once it has, the record's win (#2883): an address changed since is not lost.
    expect((await previous(o, hoa)).invoice?.buyer).toMatchObject({ name: 'Công ty Hoa Mai', taxCode: VALID_TAX_CODE, address: '1 Phố Thử, Hà Nội' });
    await admin((c) => c.query("UPDATE crove_kernel.party SET tax_code = $3, address = '7 Phố Mới, Hà Nội' WHERE org_id = $1 AND id = $2", [o.orgId, hoa, VALID_TAX_CODE]));
    // A record value longer than the form's field is not used (the response would not pass its own contract): the invoice's own value stands.
    await admin((c) => c.query('UPDATE crove_kernel.party SET address = $3, email = $4 WHERE org_id = $1 AND id = $2', [o.orgId, hoa, 'x'.repeat(600), 'y'.repeat(300)]));
    expect((await previous(o, hoa)).invoice?.buyer).toMatchObject({ address: '1 Phố Thử, Hà Nội', email: null });
    await admin((c) => c.query("UPDATE crove_kernel.party SET address = '7 Phố Mới, Hà Nội', email = NULL WHERE org_id = $1 AND id = $2", [o.orgId, hoa]));
    const got = (await previous(o, hoa)).invoice;
    expect(got).toMatchObject({ draftId: newer.id, buyer: { kind: 'business', partyId: hoa, name: 'Công ty Hoa Mai', taxCode: VALID_TAX_CODE, address: '7 Phố Mới, Hà Nội' } });
    expect(got?.lines).toEqual([expect.objectContaining({ description: 'Hàng A', quantity: '2', unitPrice: '100000', vatRate: '10%', vatAllowed: true })]);
    expect(got?.draftId).not.toBe(stillDraft.id);
    expect((await previous(o, other)).invoice?.draftId).not.toBe(newer.id);
  });

  it('marks a line whose VAT rate the new invoice\'s date no longer allows, and does not let a viewer or another org read it', async () => {
    const o = await org();
    const hoa = await party(o, 'Công ty Hoa Mai');
    await issue(o, (await saveDraft(o, null, hoa, '8%')).id);
    expect((await previous(o, hoa, '2026-11-05')).invoice?.lines[0]?.vatAllowed).toBe(true);
    expect((await previous(o, hoa, '2027-02-01')).invoice?.lines[0]).toMatchObject({ vatRate: '8%', vatAllowed: false });
    await expect(previous(o, hoa, today(), o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const stranger = await org();
    expect((await previous(stranger, hoa)).invoice).toBeNull();
  });

  it('adds the lines of an issued invoice to the source as text, without a rate the date no longer allows, and refuses a draft, an unknown invoice and another org\'s', async () => {
    const o = await org();
    const hoa = await party(o, 'Công ty Hoa Mai');
    const issued = await saveDraft(o, null, hoa, '8%');
    await issue(o, issued.id);
    const withInvoice = (id: string, date: string, user = o.owner) => query<Source>(o, 'finance.einvoice_draft.suggest_source', { text: 'giống lần trước', date, invoiceDraftId: id, buyerPartyId: hoa }, user);
    const now = await withInvoice(issued.id, '2026-11-05');
    expect(now.invoice?.text).toContain('Hàng A, đơn vị cái, số lượng 2, đơn giá 100000, VAT 8%');
    // The reduced rate is gone by 2027: the text does not state it, so the model cannot carry it over.
    const later = await withInvoice(issued.id, '2027-02-01');
    expect(later.invoice?.text).toContain('số lượng 2, đơn giá 100000');
    expect(later.invoice?.text).not.toContain('VAT');
    await expect(withInvoice((await saveDraft(o, null, hoa, '10%')).id, '2026-11-05')).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_NOT_FOUND' });
    await expect(withInvoice(randomUUID(), '2026-11-05')).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_NOT_FOUND' });
    const stranger = await org();
    await expect(query(stranger, 'finance.einvoice_draft.suggest_source', { text: 'giống lần trước', date: '2026-11-05', invoiceDraftId: issued.id, buyerPartyId: hoa })).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_NOT_FOUND' });
    // Without a picked invoice nothing is added.
    expect((await source(o, 'bán cho anh Nam')).invoice).toBeNull();
  });

  // The source follows the buyer and the legal entity of the form (#2883).
  it('takes an invoice as a source only when it is to the form\'s buyer, and asks for the buyer with it', async () => {
    const o = await org();
    const hoa = await party(o, 'Công ty Hoa Mai');
    const lan = await party(o, 'Cửa hàng Lan Anh');
    const toHoa = await saveDraft(o, null, hoa, '10%');
    await issue(o, toHoa.id);
    const ask = (input: Record<string, unknown>) => query<Source>(o, 'finance.einvoice_draft.suggest_source', { text: 'giống lần trước', date: '2026-11-05', ...input });
    expect((await ask({ invoiceDraftId: toHoa.id, buyerPartyId: hoa })).invoice?.text).toContain('Hàng A');
    await expect(ask({ invoiceDraftId: toHoa.id, buyerPartyId: lan })).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_NOT_FOUND' });
    // An invoice id without the buyer is refused by the input check.
    await expect(ask({ invoiceDraftId: toHoa.id })).rejects.toBeDefined();
  });

  it('follows the legal entity of the form on both queries, and a member scoped to one entity cannot reach the other', async () => {
    const o = await org();
    const hoa = await party(o, 'Công ty Hoa Mai');
    const branch = await admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [o.orgId, o.owner])).rows[0]?.id as string);
    const main = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [o.orgId])).rows[0]?.id as string);
    // A member who keeps the branch's books only.
    const scoped = await identity('scoped');
    await admin(async (c) => {
      await c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [o.orgId, scoped]);
      await c.query("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [o.orgId, scoped, branch, o.owner]);
    });
    const inMain = await saveDraft(o, null, hoa, '10%');
    const inBranch = await execute<Draft>(o, 'finance.einvoice_draft.save', {
      draftId: null,
      legalEntityId: branch,
      date: today(),
      seriesId: null,
      buyer: { kind: 'business', partyId: hoa, taxCode: null, name: 'Công ty Mua Thử', address: null, email: null },
      lines: [{ description: 'Hàng của chi nhánh', unit: 'cái', quantity: '1', unitPrice: '50000', vatRate: '10%' }],
    });
    await issue(o, inMain.id, 10);
    await issue(o, inBranch.id, 1);
    const lines = async (user: string, entity?: string) => (await previous(o, hoa, today(), user, entity)).invoice?.lines[0]?.description;
    // The owner sees both entities: the default one unless the form names the other, whatever the newer invoice is.
    expect(await lines(o.owner)).toBe('Hàng A');
    expect(await lines(o.owner, main)).toBe('Hàng A');
    expect(await lines(o.owner, branch)).toBe('Hàng của chi nhánh');
    // The scoped member sees the branch only: with no entity named theirs is the branch, and the main entity is refused.
    expect(await lines(scoped)).toBe('Hàng của chi nhánh');
    await expect(previous(o, hoa, today(), scoped, main)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    // The same on the source: an invoice of the other entity is none, whoever asks.
    const ask = (user: string, invoiceDraftId: string, entity?: string) =>
      query<Source>(o, 'finance.einvoice_draft.suggest_source', { text: 'giống lần trước', date: today(), invoiceDraftId, buyerPartyId: hoa, ...(entity ? { legalEntityId: entity } : {}) }, user);
    expect((await ask(scoped, inBranch.id)).invoice?.text).toContain('Hàng của chi nhánh');
    await expect(ask(scoped, inMain.id)).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_NOT_FOUND' });
    await expect(ask(scoped, inMain.id, main)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    await expect(ask(o.owner, inBranch.id, main)).rejects.toMatchObject({ code: 'EINVOICE_DRAFT_NOT_FOUND' });
    expect((await ask(o.owner, inBranch.id, branch)).invoice?.text).toContain('Hàng của chi nhánh');
  });
});
