// SPDX-License-Identifier: AGPL-3.0-only
// Learned bank-line rules (issue #2402, part 2 of #2385) on a real PostgreSQL 17, through the HTTP API: the voucher of a bank
// line whose party a person chose by hand teaches a rule when it is approved, the next statement's matcher suggests that party
// with the reason `learned`, a suggestion the person took teaches nothing, two parties on one key are never a clean line, the
// rule lives only in its org, is removed by owners and admins, and holds no readable text of the line.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { normalizeStatementAmount, type BankStatementRow } from '@crove/kernel-contract';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-bank-party-rules-2402';
const ISSUER = 'crove-auth';

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

interface Account {
  subject: string;
  email: string;
  session: string;
}

const account = (name: string): Account => ({ subject: randomUUID(), email: `${name}@bank-party-rules-2402.test`, session: randomUUID() });
const suite = ADMIN ? describe : describe.skip;

suite('learned bank line rules (#2402)', () => {
  const dbName = `crove_test_bank_party_rules_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const owner = account('owner');
  const adminUser = account('admin');
  const member = account('member');
  const outsider = account('outsider');
  let org = { slug: '', orgId: '' };
  let other = { slug: '', orgId: '' };
  const alpha = randomUUID();
  const beta = randomUUID();
  const hoaBinh = randomUUID();
  const lineId: Record<string, string> = {};

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, token: string, input: unknown, slug: string | null = org.slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(slug ? { 'x-crove-org': slug } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  let rowNo = 1;
  const row = (date: string, moneyOut: string, reference: string, description: string): BankStatementRow => ({
    rowNo: rowNo++,
    date,
    description,
    moneyIn: normalizeStatementAmount(''),
    moneyOut: normalizeStatementAmount(moneyOut),
    balance: '',
    reference,
  });
  const importLines = async (slug: string, who: Account, rows: BankStatementRow[], filename: string) =>
    rpc('bank/import', await tokenFor(who), { bankAccount: '1121', filename, rows, idempotencyKey: randomUUID() }, slug);
  const refresh = async () => {
    for (const r of await admin(async (c) => (await c.query<{ id: string; bank_ref: string }>('SELECT id, bank_ref FROM crove_finance.bank_line WHERE bank_ref IS NOT NULL')).rows)) lineId[r.bank_ref] = r.id;
  };
  const suggestion = async (ref: string, slug = org.slug, who = member) => (await rpc('bank/lineVoucher', await tokenFor(who), { bankLineId: lineId[ref] }, slug)).body;
  // The voucher of a line, asked for by a member and approved by the admin (four-eyes), with the party chosen as given.
  async function matchByHand(ref: string, date: string, partyId: string, amount: string, matchedBy?: Record<string, unknown>) {
    const asked = await rpc('inbox/request', await tokenFor(member), {
      command: 'finance.voucher.record',
      input: { type: 'bank_debit', date, cashAccount: '1121', partyId, description: 'Trả tiền hàng', lines: [{ account: '331', amount }], bankLineId: lineId[ref], ...(matchedBy ? { matchedBy } : {}) },
      idempotencyKey: randomUUID(),
    });
    expect(asked.status).toBe(200);
    const approved = await rpc('inbox/approve', await tokenFor(adminUser, { mfa: true }), { id: asked.body.proposalId, revision: 1, idempotencyKey: randomUUID() });
    expect(approved.status).toBe(200);
    return approved.body as { voucherId: string; code: string };
  }
  const rules = async () => admin(async (c) => (await c.query('SELECT * FROM crove_finance.bank_party_rule ORDER BY created_at')).rows);
  const listed = async (who = owner, slug = org.slug) => (await rpc('bankPartyRules/list', await tokenFor(who), undefined, slug)).body as any[];

  async function join(who: Account, role: string, slug: string) {
    const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role }, slug);
    expect(invite.status).toBe(200);
    expect((await rpc('invites/accept', await tokenFor(who), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 6 });
    db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });

    for (const who of [owner, adminUser, member, outsider]) expect((await rpc('me/get', await tokenFor(who), undefined, null)).status).toBe(200);
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Quy Tắc Sao Kê', idempotencyKey: randomUUID() }, null);
    org = { slug: String(created.body?.slug), orgId: String(created.body?.orgId) };
    await join(adminUser, 'admin', org.slug);
    await join(member, 'member', org.slug);
    const second = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty Khác Nữa', idempotencyKey: randomUUID() }, null);
    other = { slug: String(second.body?.slug), orgId: String(second.body?.orgId) };
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.party (org_id, id, name, tax_code) VALUES ($1, $2, 'Công ty Alpha Trade', NULL), ($1, $3, 'Công ty Beta Trade', NULL), ($1, $4, 'Công ty TNHH Thương mại Hòa Bình', '0312345670')`,
        [org.orgId, alpha, beta, hoaBinh],
      );
    });
    expect((await importLines(org.slug, member, [row('05/11/2026', '2.000.000', 'RP1', 'CK TU NGUYEN VAN LAN TT TIEN HANG T11 FT26301AAA'), row('12/11/2026', '1.500.000', 'RP4', 'CK NGUYEN VAN LAN TT HOA DON 77'), row('15/11/2026', '300.000', 'RP5', 'CK MST 0312345670 TT CONG NO')], 'sao-ke-11.xlsx')).status).toBe(200);
    await refresh();
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('suggests nobody for a line whose words no rule knows, then learns the party a person chose by hand when the voucher is approved', async () => {
    expect((await suggestion('RP1')).suggested).toBeNull();
    const voucher = await matchByHand('RP1', '2026-11-05', alpha, '2000000', { kind: 'manual' });
    const [rule, ...rest] = await rules();
    expect(rest).toEqual([]);
    expect(rule).toMatchObject({ kind: 'text', party_id: alpha, source_voucher_id: voucher.voucherId });
    // Provenance, and a keyed hash instead of text: nothing of the line is readable in the row.
    expect(rule.key_hash).toMatch(/^k1:[0-9a-f]{64}$/);
    expect(JSON.stringify(rule).toLowerCase()).not.toContain('nguyen');
    const audit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.voucher.record' AND outcome = 'ok'`, [org.orgId])).rows);
    expect(audit.some((a) => a.detail.learned_bank_rule === rule.id)).toBe(true);
    // The same words are another line's key: the next statement's line is suggested to Alpha with its own reason.
    expect((await importLines(org.slug, member, [row('05/12/2026', '2.000.000', 'RP2', 'IBFT NGUYEN VAN LAN THANH TOAN TIEN HANG THANG 12 REF 7788')], 'sao-ke-12.xlsx')).status).toBe(200);
    await refresh();
    expect((await suggestion('RP2')).suggested).toMatchObject({ party: { id: alpha }, reason: 'learned' });
    // Another line of the same payer in the earlier statement is suggested by the rule too.
    expect((await suggestion('RP4')).suggested).toMatchObject({ party: { id: alpha }, reason: 'learned' });
  });

  it('lists the rule with its provenance for every role, and never the words', async () => {
    const [item, ...rest] = await listed(member);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ kind: 'text', party: { partyId: alpha, name: 'Công ty Alpha Trade' }, confirmedBy: adminUser.email, voucher: { code: 'BN00001' } });
    expect(JSON.stringify(item).toLowerCase()).not.toContain('nguyen');
    expect((await rpc('bankPartyRules/list', await tokenFor(outsider), undefined, other.slug)).body).toEqual([]);
  });

  it('keeps the learned rule inside its org: the same words in another org suggest nobody', async () => {
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.party (org_id, id, name) VALUES ($1, $2, 'Công ty Alpha Trade')`, [other.orgId, randomUUID()]);
    });
    expect((await importLines(other.slug, outsider, [row('05/12/2026', '2.000.000', 'XO1', 'IBFT NGUYEN VAN LAN THANH TOAN TIEN HANG THANG 12 REF 7788')], 'sao-ke-khac.xlsx')).status).toBe(200);
    await refresh();
    expect((await suggestion('XO1', other.slug, outsider)).suggested).toBeNull();
  });

  it('teaches nothing when the person took the matcher\'s own suggestion', async () => {
    const before = (await rules()).length;
    // RP5 names a party by its tax code: the matcher suggests it, and a voucher that took that suggestion is not a correction.
    expect((await suggestion('RP5')).suggested).toMatchObject({ party: { id: hoaBinh }, reason: 'tax_code' });
    await matchByHand('RP5', '2026-11-15', hoaBinh, '300000', { kind: 'suggested', reason: 'tax_code' });
    expect((await rules()).length).toBe(before);
  });

  it('puts a line whose words two parties hold in the look-at-it list, never a clean line, and a person may choose between them', async () => {
    // A second person-chosen match of the same words to Beta: the key now points at two parties.
    await matchByHand('RP4', '2026-11-12', beta, '1500000', { kind: 'manual' });
    expect((await rules()).length).toBe(2);
    const line = await suggestion('RP2');
    expect(line.suggested).toBeNull();
    expect((line.candidates as any[]).map((c) => [c.party.id, c.reason]).sort()).toEqual(
      [
        [alpha, 'learned'],
        [beta, 'learned'],
      ].sort(),
    );
    const groups = await rpc('bank/matchGroups', await tokenFor(member), { bankAccount: '1121', period: '2026-12' });
    expect(groups.body.clean).toEqual([]);
    expect((groups.body.look as any[]).find((l) => l.line.reference === 'RP2')).toMatchObject({ group: 'look', why: 'several' });
  });

  it('lets owners and admins remove a rule, never a member, and the line is not suggested by it afterwards', async () => {
    const [alphaRule] = (await listed()).filter((r) => r.party.partyId === alpha);
    expect((await rpc('bankPartyRules/remove', await tokenFor(member), { id: alphaRule.id })).status).toBe(403);
    expect((await rpc('bankPartyRules/remove', await tokenFor(owner, { mfa: true }), { id: alphaRule.id })).status).toBe(200);
    expect((await rpc('bankPartyRules/remove', await tokenFor(owner, { mfa: true }), { id: alphaRule.id })).body).toMatchObject({ code: 'RULE_NOT_FOUND' });
    expect((await suggestion('RP2')).suggested).toMatchObject({ party: { id: beta }, reason: 'learned' });
    const audit = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.bank_party_rule.remove' AND outcome = 'ok'`, [org.orgId])).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.detail).toMatchObject({ ruleId: alphaRule.id, partyId: alpha });
    expect(JSON.stringify(audit[0]?.detail)).not.toMatch(/k1:/);
  });

  it('holds every writer to the table\'s rules: no update by a login role, the key kind, no direct call of the hash function', async () => {
    const [rule] = await rules();
    const asTenant = async (sql: string, params: unknown[] = []) => {
      const client = new pg.Client({ connectionString: new URL(adminUrl).toString().replace(/\/\/[^@]*@/, '//crove_app:test-app-pw@') });
      await client.connect();
      try {
        return await client.query(sql, params);
      } finally {
        await client.end();
      }
    };
    // The login role has no way to read the hash function's key or call the function outside a sealed context.
    await expect(asTenant(`SELECT crove_finance.bank_party_rule_hash('text', 'x')`)).rejects.toThrow();
    expect(rule.key_hash).toMatch(/^k1:[0-9a-f]{64}$/);
    // The login role may not update a rule (made and removed whole).
    await expect(asTenant(`UPDATE crove_finance.bank_party_rule SET key_hash = 'nope' WHERE id = $1`, [rule.id])).rejects.toThrow(/permission denied/);
    await expect(admin((c) => c.query(`INSERT INTO crove_finance.bank_party_rule (org_id, kind, key_hash, party_id, source_voucher_id) VALUES ($1, 'other', $2, $3, $4)`, [org.orgId, rule.key_hash, beta, rule.source_voucher_id]))).rejects.toThrow();
  });
});
