// SPDX-License-Identifier: AGPL-3.0-only
// "The original invoice is needed" Inbox items (#2286, plan docs/plan/einvoice-lookup.md) on PostgreSQL 17: a mail with no
// invoice attachment whose text holds the seller's lookup link or code raises one item per hint, once per mail; only the
// hint is stored; members read and dismiss them (a viewer, a member limited to some legal entities and another org do
// not); the dead-letter items stay with owners and admins; and the lookup code appears in no audit row, log line or
// error text. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, inboundKey, newInboundBlobId, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import type { ExtractClient } from '@crove/extract-contract';
import { processInboundEmail } from '../src/inbound.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const FIXTURE = readFileSync(new URL('../../extract/test/fixtures/einvoice-basic.xml', import.meta.url));
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

// Invented lookup codes: none of them is a real code.
const CODE_A = '4F7K2M9QXA3';
const CODE_B = 'EZ98YX76WV';

suite('original-needed Inbox items on PostgreSQL (#2286)', () => {
  const dbName = `crove_test_original_needed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
  const users = { owner: '', admin: '', member: '', viewer: '', limited: '', outsider: '' };
  let orgId = '';
  let token = '';
  let otherOrgId = '';
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

  // A mail to the org's address: plain text, and an e-invoice XML attached when asked.
  async function mail(messageId: string, text: string, options: { xml?: boolean } = {}) {
    const header = [`From: ketoan@vendor.example`, `To: ${token}@in.test`, `Subject: Hoa don dien tu`, `Message-ID: <${messageId}@vendor.example>`, 'MIME-Version: 1.0'];
    const lines = options.xml
      ? [
          ...header,
          'Content-Type: multipart/mixed; boundary="b1"',
          '',
          '--b1',
          'Content-Type: text/plain; charset=utf-8',
          '',
          text,
          '--b1',
          `Content-Type: application/xml; name="hd.xml"`,
          `Content-Disposition: attachment; filename="hd.xml"`,
          'Content-Transfer-Encoding: base64',
          '',
          Buffer.from(FIXTURE.toString('utf8').replace('<SHDon>1234</SHDon>', `<SHDon>${Math.floor(Math.random() * 1e6)}</SHDon>`)).toString('base64'),
          '--b1--',
          '',
        ]
      : [...header, 'Content-Type: text/plain; charset=utf-8', '', text, ''];
    const raw = new TextEncoder().encode(lines.join('\r\n'));
    const blobId = newInboundBlobId();
    await store.put(inboundKey(blobId), raw);
    return { blobId, sha256: sha256Hex(raw), sizeBytes: raw.byteLength, recipient: `${token}@in.test` };
  }
  const receive = async (job: Awaited<ReturnType<typeof mail>>) => processInboundEmail({ runtime: worker, store, domain: 'in.test', extract }, job);

  const originals = (userId: string, org = orgId) => rt.query<{ items: Array<{ id: string; provider: string | null; url: string | null; code: string | null }>; total: number }>('kernel.inbox.originals', {}, { actor: asUser(userId), orgId: org });
  const rows = () => admin(async (c) => (await c.query<{ id: string; kind: string; dedupe_key: string; detail: Record<string, unknown>; dismissed_at: Date | null }>(`SELECT id, kind, dedupe_key, detail, dismissed_at FROM crove_kernel.inbox_item WHERE org_id = $1 AND kind = 'finance.invoice.original_needed' ORDER BY raised_at, dedupe_key`, [orgId])).rows);

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
    const registry = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] };
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register(registry);
    const asWorker = new URL(adminUrl);
    asWorker.username = 'crove_worker';
    asWorker.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: asWorker.toString(), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(registry);
    extract = inProcessExtract();
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'test', subject: key, email: `${key}@original-needed.test`, name: null });
    }
    ({ orgId } = await createOrg(rt, asUser(users.owner), 'Công ty có thư chỉ kèm đường dẫn'));
    ({ orgId: otherOrgId } = await createOrg(rt, asUser(users.outsider), 'Công ty khác'));
    await admin(async (c) => {
      token = (await c.query<{ t: string }>('SELECT inbound_token AS t FROM crove_kernel.tenant WHERE org_id = $1', [orgId])).rows[0]?.t ?? '';
      const entity = (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id;
      for (const [user, role] of [
        [users.admin, 'admin'],
        [users.member, 'member'],
        [users.viewer, 'viewer'],
        [users.limited, 'member'],
      ] as const) {
        await c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]);
      }
      // A member limited to one legal entity by an external accountant assignment.
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, users.limited, entity, users.owner]);
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

  const LINK_MAIL = `Kính gửi Quý khách,\nQuý khách có thể tra cứu hóa đơn tại: https://www.meinvoice.vn/tra-cuu/\nMã tra cứu hóa đơn: ${CODE_A}\nXin cảm ơn, kế toán công ty ABC.`;

  it('raises one item for a mail with a lookup link and code, and only once for the same mail', async () => {
    const job = await mail('link-1', LINK_MAIL);
    const logged = [vi.spyOn(console, 'log'), vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    try {
      expect(await receive(job)).toMatchObject({ duplicate: false, fileIds: [] });
      // The same Message-ID again: the receive command stops at a mail it has, so nothing is raised twice.
      expect(await receive(job)).toMatchObject({ duplicate: true });
      const mentioned = logged.flatMap((spy) => spy.mock.calls.flat().map(String)).join('\n');
      expect(mentioned).not.toContain(CODE_A);
      expect(mentioned).not.toContain('meinvoice');
    } finally {
      for (const spy of logged) spy.mockRestore();
    }
    const stored = await rows();
    expect(stored).toHaveLength(1);
    // Exactly the hint: no mail text, no sender, no subject, no Message-ID.
    expect(stored[0]?.detail).toEqual({ provider: 'misa', url: 'https://www.meinvoice.vn/tra-cuu/', code: CODE_A });
    expect(JSON.stringify(stored[0])).not.toMatch(/Quý khách|ketoan@|Hoa don|link-1/);
    expect(await originals(users.owner)).toMatchObject({ total: 1, items: [{ provider: 'misa', url: 'https://www.meinvoice.vn/tra-cuu/', code: CODE_A }] });
  });

  it('raises an item for a code alone, one per hint, and none for a mail without a hint or with an invoice attachment', async () => {
    const before = (await rows()).length;
    await receive(await mail('code-only', `Mã số bí mật: ${CODE_B}`));
    expect((await rows()).length).toBe(before + 1);
    const two = `Hóa đơn 1: https://tracuu.easyinvoice.vn/ Mã tra cứu: ${CODE_B}\n${'x '.repeat(500)}\nHóa đơn 2: https://meinvoice.vn/tra-cuu Mã tra cứu: 9ZZ8YY7XX6`;
    await receive(await mail('two-hints', two));
    expect((await rows()).length).toBe(before + 3);
    // No link or code in the text: nothing to raise.
    await receive(await mail('no-hint', 'Chào anh, em gửi hóa đơn sau nhé, anh xem giúp em.'));
    // An invoice attached: the file is read through the ordinary path, no item.
    expect(await receive(await mail('with-xml', LINK_MAIL, { xml: true }))).toMatchObject({ duplicate: false, fileIds: [expect.any(String)] });
    expect((await rows()).length).toBe(before + 3);
  });

  it('shows the items to owners, admins and members, and to nobody else', async () => {
    for (const user of [users.owner, users.admin, users.member]) expect((await originals(user)).total, user).toBeGreaterThan(0);
    // A viewer, a member limited to one legal entity (a mail is not tied to an entity), and another org's owner.
    expect(await originals(users.viewer)).toEqual({ items: [], total: 0 });
    expect(await originals(users.limited)).toEqual({ items: [], total: 0 });
    await expect(originals(users.outsider)).rejects.toBeTruthy();
    expect(await originals(users.outsider, otherOrgId)).toEqual({ items: [], total: 0 });
  });

  it('keeps the dead-letter items with owners and admins', async () => {
    const deadLetter = randomUUID();
    await admin((c) =>
      c.query(`INSERT INTO crove_kernel.inbox_item (org_id, id, kind, dedupe_key, detail) VALUES ($1, $2, 'kernel.job.dead_lettered', 'queue:finance-portal-list:2026-11-01', $3)`, [
        orgId,
        deadLetter,
        JSON.stringify({ queue: 'finance-portal-list', jobId: randomUUID(), retries: 0, failures: 1 }),
      ]),
    );
    const raised = (userId: string) => rt.query<{ total: number }>('kernel.inbox.raised', {}, { actor: asUser(userId), orgId });
    expect((await raised(users.owner)).total).toBe(1);
    expect((await raised(users.admin)).total).toBe(1);
    expect(await raised(users.member)).toEqual({ items: [], total: 0 });
    // A member cannot dismiss it through the new command either: it is not an original-needed item.
    await expect(rt.execute('kernel.inbox.original_dismiss', { id: deadLetter }, { actor: asUser(users.member), orgId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await raised(users.owner)).total).toBe(1);
  });

  it('lets a member dismiss an item, not a viewer, not a user of another org, and only a user', async () => {
    const [first] = (await originals(users.owner)).items;
    if (!first) throw new Error('no item to dismiss');
    await expect(rt.execute('kernel.inbox.original_dismiss', { id: first.id }, { actor: asUser(users.viewer), orgId })).rejects.toBeTruthy();
    await expect(rt.execute('kernel.inbox.original_dismiss', { id: first.id }, { actor: asUser(users.outsider), orgId })).rejects.toBeTruthy();
    await expect(rt.execute('kernel.inbox.original_dismiss', { id: first.id }, { actor: asUser(users.limited), orgId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const before = (await originals(users.owner)).total;
    await expect(rt.execute('kernel.inbox.original_dismiss', { id: first.id }, { actor: asUser(users.member), orgId })).resolves.toEqual({ ok: true });
    // Again: nothing changes, nothing breaks.
    await expect(rt.execute('kernel.inbox.original_dismiss', { id: first.id }, { actor: asUser(users.member), orgId })).resolves.toEqual({ ok: true });
    expect((await originals(users.owner)).total).toBe(before - 1);
    const dismissed = (await rows()).find((r) => r.id === first.id);
    expect(dismissed?.dismissed_at).not.toBeNull();
    // Only the worker raises them, in a system context.
    await expect(rt.execute('kernel.inbox.original_needed', { mailKey: 'a'.repeat(64), hints: [{ provider: null, url: null, code: CODE_B }] }, { actor: asUser(users.owner), orgId })).rejects.toBeTruthy();
  });

  it('keeps the lookup code and the link out of every audit row of the org', async () => {
    const audit = await admin(async (c) => (await c.query<{ row: string }>('SELECT to_jsonb(a)::text AS row FROM crove_kernel.audit_event a WHERE org_id = $1', [orgId])).rows.map((r) => r.row));
    expect(audit.length).toBeGreaterThan(0);
    const all = audit.join('\n');
    for (const secret of [CODE_A, CODE_B, '9ZZ8YY7XX6', 'meinvoice', 'easyinvoice']) expect(all, secret).not.toContain(secret);
    // The raise is audited by counts.
    expect(audit.some((r) => r.includes('kernel.inbox.original_needed'))).toBe(true);
  });

  it('refuses at the database an item whose detail is not a hint', async () => {
    const insert = (detail: unknown, key = randomUUID()) =>
      admin((c) => c.query(`INSERT INTO crove_kernel.inbox_item (org_id, kind, dedupe_key, detail) VALUES ($1, 'finance.invoice.original_needed', $2, $3)`, [orgId, `check:${key}`, JSON.stringify(detail)]));
    await expect(insert({ provider: 'misa', url: 'https://meinvoice.vn/tra-cuu', code: 'ABC12345' })).resolves.toBeTruthy();
    await expect(insert({ code: 'ABC12345' })).resolves.toBeTruthy();
    for (const bad of [
      { code: 'ABC12345', text: 'Kính gửi Quý khách' },
      { code: 'ABC12345', subject: 'Hoa don' },
      { provider: 'misa' },
      {},
      { url: 'http://meinvoice.vn/tra-cuu' },
      { url: 'https://meinvoice.vn/tra cuu' },
      { url: `https://meinvoice.vn/${'a'.repeat(400)}` },
      { code: 'ABC 12345' },
      { code: 'ABC' },
      { code: 12345678 },
      { provider: 'other', code: 'ABC12345' },
      { provider: ['misa'], code: 'ABC12345' },
    ]) {
      await expect(insert(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '23514' });
    }
    // A dead-letter item has the shape it always had.
    await expect(admin((c) => c.query(`INSERT INTO crove_kernel.inbox_item (org_id, kind, dedupe_key, detail) VALUES ($1, 'kernel.job.dead_lettered', $2, $3)`, [orgId, `check:${randomUUID()}`, JSON.stringify({ queue: 'q', anything: true })]))).resolves.toBeTruthy();
    // And no other kind exists.
    await expect(admin((c) => c.query(`INSERT INTO crove_kernel.inbox_item (org_id, kind, dedupe_key) VALUES ($1, 'finance.invoice.other', 'x')`, [orgId]))).rejects.toMatchObject({ code: '23514' });
  });
});
