// SPDX-License-Identifier: AGPL-3.0-only
// Stream hints of the CRM (issue #3293, crm.md section 5), on PostgreSQL 17: a deal or a contact's details that change
// send `<org> crm_deal <id>` or `<org> crm_party <id>` on ludy_stream, the id only (never a title, an amount or a
// name), to the streams of that org alone. A bulk delete of deals sends one hint per org. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to
// a superuser URL; the run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { STREAM_HINT_MANY_ID, type StreamHint } from '@ludy/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, type BlobStore } from '@ludy/kernel-runtime';
import { orgPurgeCommand } from '../src/org-purge.ts';
import { StreamHub, parseHint, type HubSubscriber, type NotificationSource } from '../src/stream.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DONE = 'crm-stream-hints:done';
const suite = ADMIN ? describe : describe.skip;

suite('stream hints of deals and contacts (#3293)', () => {
  const dbName = `ludy_test_crm_stream_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let app: Runtime;
  let workerApp: Runtime;
  const noopStore: BlobStore = {
    put: async () => '',
    get: async () => new Uint8Array(),
    delete: async () => undefined,
  };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function orgWithOwner(): Promise<{ orgId: string; owner: string }> {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'crm-stream', subject: `owner-${tag}`, email: `owner-${tag}@crm-stream.test`, name: null });
    const orgId = (await createOrg(app, { type: 'user', userId: owner, aal: 'aal1' }, `CRM ${tag}`)).orgId;
    return { orgId, owner };
  }

  async function org(): Promise<string> {
    return (await orgWithOwner()).orgId;
  }

  async function party(orgId: string, name = 'Nguyễn Văn Bí Mật'): Promise<string> {
    return admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name, email, phone) VALUES ($1, 'person', $2, 'bimat@khach.test', '0912345678') RETURNING id`, [orgId, name])).rows[0]!.id);
  }

  async function stage(orgId: string): Promise<string> {
    return admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO ludy_crm.pipeline_stage (org_id, name, kind, position) VALUES ($1, 'Mới', 'open', 1) RETURNING id`, [orgId])).rows[0]!.id);
  }

  async function deal(orgId: string, partyId: string, stageId: string, n = 1): Promise<string[]> {
    return admin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_crm.deal (org_id, party_id, title, amount, stage_id, sort_key, created_by)
           SELECT $1::uuid, $2::uuid, 'Hợp đồng bí mật ' || i, 987654321, $3::uuid, 'V' || i, $4::uuid FROM generate_series(1, $5::integer) i RETURNING id`,
          [orgId, partyId, stageId, randomUUID(), n],
        )
      ).rows.map((r) => r.id),
    );
  }

  // The ludy_stream payloads the statements send, in the order they come, up to a marker sent after them.
  async function hintsOf(statements: (c: pg.Client) => Promise<unknown>): Promise<string[]> {
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    const payloads: string[] = [];
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    listener.on('notification', (m) => {
      if (m.channel !== 'ludy_stream' || !m.payload) return;
      if (m.payload === DONE) done();
      else payloads.push(m.payload);
    });
    await listener.query('LISTEN ludy_stream');
    try {
      await admin(statements);
      await admin((c) => c.query(`SELECT pg_catalog.pg_notify('ludy_stream', $1)`, [DONE]));
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([finished, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out; ${payloads.length} payloads`)), 10_000)))]).finally(() => clearTimeout(timer));
      return payloads;
    } finally {
      await listener.end();
    }
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
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 4 });
    app = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands],
      queries: [...kernelQueries({ inboundDomain: null })],
    });
    workerApp = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [orgPurgeCommand({ store: noopStore })],
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

  it('sends the id of a deal that is created, changed or deleted, and nothing else about it', async () => {
    const orgId = await org();
    const [partyId, stageId] = [await party(orgId), await stage(orgId)];
    let dealId = '';
    const created = await hintsOf(async () => {
      dealId = (await deal(orgId, partyId, stageId))[0]!;
    });
    expect(created).toEqual([`${orgId} crm_deal ${dealId}`]);
    // A move: the stage's sort key and the amount change; the hint is the same one, carrying no title or amount.
    const moved = await hintsOf((c) => c.query(`UPDATE ludy_crm.deal SET sort_key = 'W', amount = 5, version = version + 1 WHERE org_id = $1 AND id = $2`, [orgId, dealId]));
    expect(moved).toEqual([`${orgId} crm_deal ${dealId}`]);
    const removed = await hintsOf((c) => c.query('DELETE FROM ludy_crm.deal WHERE org_id = $1 AND id = $2', [orgId, dealId]));
    expect(removed).toEqual([`${orgId} crm_deal ${dealId}`]);
    for (const payload of [...created, ...moved, ...removed]) {
      expect(payload).not.toMatch(/bí mật|987654321|Hợp đồng/i);
      expect(parseHint(payload)).toEqual({ orgId, hint: { type: 'crm_deal', id: dealId } });
    }
  });

  it('sends one hint per org for a delete of many deals, naming one of the deleted ids', async () => {
    const [first, second] = [await org(), await org()];
    const ids = new Map<string, string[]>();
    for (const orgId of [first, second]) ids.set(orgId, await deal(orgId, await party(orgId), await stage(orgId), 40));
    const payloads = await hintsOf((c) => c.query('DELETE FROM ludy_crm.deal WHERE org_id = ANY($1)', [[first, second]]));
    expect(payloads).toHaveLength(2);
    for (const orgId of [first, second]) {
      const mine = payloads.map((p) => parseHint(p)).filter((h) => h?.orgId === orgId);
      expect(mine).toHaveLength(1);
      expect(ids.get(orgId)).toContain(mine[0]?.hint.id);
      expect(mine[0]?.hint.type).toBe('crm_deal');
    }
  });

  it('sends the id of a party that is created or whose contact details change, and nothing for a change no screen shows', async () => {
    const orgId = await org();
    let partyId = '';
    const created = await hintsOf(async () => {
      partyId = await party(orgId);
    });
    expect(created).toEqual([`${orgId} crm_party ${partyId}`]);
    expect(created[0]).not.toMatch(/bí mật|bimat|0912345678/i);

    const changed = await hintsOf(async (c) => {
      await c.query(`UPDATE ludy_kernel.party SET kind = 'organization' WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
      await c.query(`UPDATE ludy_kernel.party SET tax_code = '0101234567' WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
      await c.query(`UPDATE ludy_kernel.party SET name = 'Tên mới' WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
      await c.query(`UPDATE ludy_kernel.party SET email = 'moi@khach.test' WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
      await c.query(`UPDATE ludy_kernel.party SET phone = NULL WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
    });
    expect(changed).toEqual(Array(5).fill(`${orgId} crm_party ${partyId}`));

    // A new version is one (a screen sends it back with an edit).
    const bumped = await hintsOf((c) => c.query(`UPDATE ludy_kernel.party SET version = version + 1 WHERE org_id = $1 AND id = $2`, [orgId, partyId]));
    expect(bumped).toEqual([`${orgId} crm_party ${partyId}`]);

    // A rewrite of the same values and a verification are not what a contact screen shows.
    const quiet = await hintsOf(async (c) => {
      await c.query(`UPDATE ludy_kernel.party SET name = 'Tên mới', email = 'moi@khach.test' WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
      await c.query(`UPDATE ludy_kernel.party SET verified_at = now() WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
    });
    expect(quiet).toEqual([]);

    // Updating the primary key id along with contact details still notifies the new party id (LEFT JOIN old_rows).
    const replacementId = randomUUID();
    const renamedWithId = await hintsOf((c) =>
      c.query(`UPDATE ludy_kernel.party SET id = $3, name = 'Đổi mã' WHERE org_id = $1 AND id = $2`, [orgId, partyId, replacementId]),
    );
    expect(renamedWithId).toEqual([`${orgId} crm_party ${replacementId}`]);
  });

  const top20InTriggerOrder = (ids: readonly string[]): string[] =>
    [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 20);

  // #3423: a transaction that writes >20 distinct contacts or deals from a fresh budget sends 21 hints (20 distinct row ids + 1 nil id sentinel), not one NOTIFY per row.
  const bounded = (
    payloads: string[],
    orgId: string,
    type: 'crm_party' | 'crm_deal',
    expected?: { exactOrder?: readonly string[]; memberOf?: ReadonlySet<string> },
  ) => {
    expect(payloads).toHaveLength(21);
    expect(payloads.every((p) => p.startsWith(`${orgId} ${type} `))).toBe(true);
    expect(payloads.filter((p) => p.endsWith(` ${STREAM_HINT_MANY_ID}`))).toHaveLength(1);
    expect(payloads[20]).toBe(`${orgId} ${type} ${STREAM_HINT_MANY_ID}`);
    const namedIds = payloads.slice(0, 20).map((p) => {
      const parsed = parseHint(p);
      expect(parsed).toMatchObject({ orgId, hint: { type } });
      expect(parsed?.hint.id).not.toBe(STREAM_HINT_MANY_ID);
      return parsed!.hint.id;
    });
    expect(new Set(namedIds).size).toBe(20);
    if (expected?.exactOrder) expect(namedIds).toEqual(expected.exactOrder);
    if (expected?.memberOf) {
      for (const id of namedIds) expect(expected.memberOf.has(id)).toBe(true);
    }
    expect(parseHint(payloads[20]!)).toMatchObject({ orgId, hint: { type, id: STREAM_HINT_MANY_ID } });
  };

  it('counts distinct changed rows so importing 11 contacts linked to an existing company keeps every row id exact (#3423)', async () => {
    const orgId = await org();
    const company = await admin(
      async (c) => (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) VALUES ($1, 'organization', 'Công ty sẵn') RETURNING id`, [orgId])).rows[0]!.id,
    );
    const createdIds: string[] = [];
    const payloads = await hintsOf(async (c) => {
      await c.query('BEGIN');
      for (let i = 0; i < 11; i++) {
        const id = (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'person', $2, $3) RETURNING id`, [orgId, `Khách ${i}`, `c${i}@nhap.test`])).rows[0]!.id;
        createdIds.push(id);
        await c.query('UPDATE ludy_kernel.party SET company_id = $3 WHERE org_id = $1 AND id = $2', [orgId, id, company]);
      }
      await c.query('COMMIT');
    });
    // 11 inserts + 11 company_id updates = 22 writes for 11 distinct contacts: no nil sentinel is sent.
    expect(payloads).toEqual(createdIds.map((id) => `${orgId} crm_party ${id}`));
    expect(payloads).not.toContain(`${orgId} crm_party ${STREAM_HINT_MANY_ID}`);
  });

  it('bounds the hints of a large contact import: 2000 parties one by one, each with a company link, send at most 21 (#3423)', async () => {
    const orgId = await org();
    const expectedFirst20: string[] = [];
    const payloads = await hintsOf(async (c) => {
      await c.query('BEGIN');
      const company = (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) VALUES ($1, 'organization', 'Công ty nhập') RETURNING id`, [orgId])).rows[0]!.id;
      expectedFirst20.push(company);
      for (let i = 0; i < 2000; i++) {
        const id = (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name, email) VALUES ($1, 'person', $2, $3) RETURNING id`, [orgId, `Khách ${i}`, `k${i}@nhap.test`])).rows[0]!.id;
        if (expectedFirst20.length < 20) expectedFirst20.push(id);
        await c.query('UPDATE ludy_kernel.party SET company_id = $3 WHERE org_id = $1 AND id = $2', [orgId, id, company]);
      }
      await c.query('COMMIT');
    });
    bounded(payloads, orgId, 'crm_party', { exactOrder: expectedFirst20 });
    // The first 20 distinct parties name themselves (the insert and link update of one party count once); the 21st sends the one nil hint. No name, email or phone anywhere.
    expect(payloads).toHaveLength(21);
    expect(new Set(payloads).size).toBe(payloads.length);
    for (const p of payloads) expect(p).not.toMatch(/Khách|nhap\.test|Công ty/);
  });

  it('bounds one statement that writes 2000 parties, and bulk purge updates while skipping unwatched columns (#3423)', async () => {
    const orgId = await org();
    let insertedIds: string[] = [];
    const inserted = await hintsOf(async (c) => {
      insertedIds = (
        await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Khách ' || i FROM generate_series(1, 2000) i RETURNING id`, [orgId])
      ).rows.map((r) => r.id);
    });
    expect(insertedIds).toHaveLength(2000);
    bounded(inserted, orgId, 'crm_party', { exactOrder: top20InTriggerOrder(insertedIds) });
    // Bulk contact-field erase and duplicate_of reset.
    let erasedIds: string[] = [];
    const erased = await hintsOf(async (c) => {
      erasedIds = (
        await c.query<{ id: string }>(`UPDATE ludy_kernel.party SET email = NULL, phone = NULL, address = NULL, name = 'Đã xóa' WHERE org_id = $1 RETURNING id`, [orgId])
      ).rows.map((r) => r.id);
    });
    expect(erasedIds).toHaveLength(2000);
    bounded(erased, orgId, 'crm_party', { exactOrder: top20InTriggerOrder(erasedIds) });
    // A statement that changes nothing a screen shows sends nothing, however many rows it touches.
    expect(await hintsOf((c) => c.query(`UPDATE ludy_kernel.party SET verified_at = now() WHERE org_id = $1`, [orgId]))).toEqual([]);
  });

  it('bounds crm_party hints of ludy_kernel.org_purge across duplicate_of reset, contact erase, and company_id SET NULL (#3423)', async () => {
    const orgId = await org();
    const defaultEntity = await admin(
      async (c) => (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]!.id,
    );
    const keptPartyIds: string[] = [];
    await admin(async (c) => {
      const bookPartyDoc = async (partyId: string, invoiceNo: string) => {
        const docId = (
          await c.query<{ id: string }>(
            `INSERT INTO ludy_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id)
             VALUES ($1, $2, '1C26TAA', $3, '2026-10-01', 100, 0, 100, 'sale', $4) RETURNING id`,
            [orgId, partyId, invoiceNo, defaultEntity],
          )
        ).rows[0]!.id;
        const entryId = (
          await c.query<{ id: string }>(
            `INSERT INTO ludy_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id)
             VALUES ($1, '2026-10-01', 'bán', 'finance.purchase_document', $2, $3) RETURNING id`,
            [orgId, docId, defaultEntity],
          )
        ).rows[0]!.id;
        await c.query(
          `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit)
           VALUES ($1, $2, 1, '131', 100, 0), ($1, $2, 2, '5111', 0, 100)`,
          [orgId, entryId],
        );
      };
      await c.query('BEGIN');
      const company = (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) VALUES ($1, 'organization', 'Công ty bị xóa') RETURNING id`, [orgId])).rows[0]!.id;
      const primary = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.party (org_id, kind, name, email, phone, address, company_id) VALUES ($1, 'person', 'Khách chính', 'chinh@purge.test', '0900000001', 'Hà Nội', $2) RETURNING id`,
          [orgId, company],
        )
      ).rows[0]!.id;
      keptPartyIds.push(primary);
      await bookPartyDoc(primary, '00000001');
      for (let i = 2; i <= 30; i++) {
        const kept = (
          await c.query<{ id: string }>(
            `INSERT INTO ludy_kernel.party (org_id, kind, name, email, phone, address, company_id, duplicate_of)
             VALUES ($1, 'person', $2, $3, '+84-900-000-002', 'TP HCM', $4, $5) RETURNING id`,
            [orgId, `Khách giữ ${i}`, `giu${i}@purge.test`, company, primary],
          )
        ).rows[0]!.id;
        keptPartyIds.push(kept);
        await bookPartyDoc(kept, String(i).padStart(8, '0'));
      }
      await c.query('COMMIT');
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [orgId]);
      await c.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, now() - interval '31 days', 'system', NULL, 'kernel.org.export.record', $2, 'ok', $3, $4)`,
        [orgId, randomUUID(), '0'.repeat(64), JSON.stringify({ format: 'crove.org-export.v2', file_count: 1 })],
      );
      await c.query('COMMIT');
    });

    const payloads = await hintsOf(() =>
      workerApp.execute('kernel.org.purge', { minDays: 30, reason: 'test bounded stream hints' }, { actor: { type: 'system', component: 'operator' }, orgId }),
    );
    bounded(payloads, orgId, 'crm_party', { memberOf: new Set(keptPartyIds) });
    expect(payloads).toHaveLength(21);
    for (const p of payloads) expect(p).not.toMatch(/Khách|purge\.test|Công ty/);
    const keptAfter = await admin(
      async (c) =>
        (
          await c.query<{ n: string; erased: string }>(
            `SELECT count(*) AS n,
                    count(*) FILTER (WHERE email IS NULL AND phone IS NULL AND address IS NULL AND company_id IS NULL AND duplicate_of IS NULL) AS erased
             FROM ludy_kernel.party WHERE org_id = $1`,
            [orgId],
          )
        ).rows[0],
    );
    expect(keptAfter).toEqual({ n: '30', erased: '30' });
  });

  it('keeps a small change exact and starts each transaction at zero: a few rows name themselves, and the count does not carry over (#3423)', async () => {
    const orgId = await org();
    let ids: string[] = [];
    const few = await hintsOf(async (c) => {
      ids = (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Khách ' || i FROM generate_series(1, 5) i RETURNING id`, [orgId])).rows.map((r) => r.id);
    });
    expect([...few].sort()).toEqual(ids.map((id) => `${orgId} crm_party ${id}`).sort());
    // 30 rows use up the budget of their transaction; the next transaction names its own party again.
    await hintsOf((c) => c.query(`INSERT INTO ludy_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Đợt ' || i FROM generate_series(1, 30) i`, [orgId]));
    const later = await hintsOf(async (c) => {
      ids = [(await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) VALUES ($1, 'person', 'Sau đó') RETURNING id`, [orgId])).rows[0]!.id];
    });
    expect(later).toEqual([`${orgId} crm_party ${ids[0]}`]);
  });

  it('rolls back both notifications and the single-GUC counter on a savepoint rollback (#3423)', async () => {
    const orgId = await org();
    let keptIds: string[] = [];
    let rolledBackIds: string[] = [];
    let tailIds: string[] = [];
    const payloads = await hintsOf(async (c) => {
      await c.query('BEGIN');
      keptIds = (
        await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Giữ ' || i FROM generate_series(1, 15) i RETURNING id`, [orgId])
      ).rows.map((r) => r.id);
      await c.query('SAVEPOINT sp_party');
      rolledBackIds = (
        await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Hoàn ' || i FROM generate_series(1, 10) i RETURNING id`, [orgId])
      ).rows.map((r) => r.id);
      await c.query('ROLLBACK TO SAVEPOINT sp_party');
      tailIds = (
        await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Sau ' || i FROM generate_series(1, 3) i RETURNING id`, [orgId])
      ).rows.map((r) => r.id);
      await c.query('COMMIT');
    });
    // 15 + 3 = 18 exact row ids, no nil id (since the 10-row batch that crossed 20 was rolled back with its counter), and no rolled-back id.
    expect(payloads).toHaveLength(18);
    expect([...payloads].sort()).toEqual([...keptIds, ...tailIds].map((id) => `${orgId} crm_party ${id}`).sort());
    for (const goneId of rolledBackIds) expect(payloads).not.toContain(`${orgId} crm_party ${goneId}`);
    expect(payloads).not.toContain(`${orgId} crm_party ${STREAM_HINT_MANY_ID}`);
  });

  it('bounds the budget per org and type in one static GUC without creating per-org GUC entries (#3423)', async () => {
    const [first, second] = [await org(), await org()];
    const [partyA, stageA] = [await party(first), await stage(first)];
    const [partyB, stageB] = [await party(second), await stage(second)];
    let gucDuringTx: string | null = null;
    let perOrgValues: (string | null)[] = [];
    let gucAfterTx: string | null = null;
    const partyIdsByOrg = new Map<string, string[]>();
    let dealIdsA: string[] = [];
    let dealIdsB: string[] = [];

    const payloads = await hintsOf(async (c) => {
      await c.query('BEGIN');
      for (const o of [first, second]) {
        const ids = (
          await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Khách ' || i FROM generate_series(1, 100) i RETURNING id`, [o])
        ).rows.map((r) => r.id);
        partyIdsByOrg.set(o, ids);
      }
      dealIdsA = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_crm.deal (org_id, party_id, title, amount, stage_id, sort_key, created_by)
           SELECT $1::uuid, $2::uuid, 'Hợp đồng A ' || i, 1000, $3::uuid, 'A' || i, $4::uuid FROM generate_series(1, 60) i RETURNING id`,
          [first, partyA, stageA, randomUUID()],
        )
      ).rows.map((r) => r.id);
      dealIdsB = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_crm.deal (org_id, party_id, title, amount, stage_id, sort_key, created_by)
           SELECT $1::uuid, $2::uuid, 'Hợp đồng B ' || i, 1000, $3::uuid, 'B' || i, $4::uuid FROM generate_series(1, 60) i RETURNING id`,
          [second, partyB, stageB, randomUUID()],
        )
      ).rows.map((r) => r.id);
      gucDuringTx = (await c.query<{ val: string | null }>(`SELECT pg_catalog.current_setting('ludy.stream_hint_counts', true) AS val`)).rows[0]?.val ?? null;
      const legacyNames = [first, second].flatMap((o) => {
        const hex = o.replaceAll('-', '');
        return [`ludy.hint_crm_party_${hex}`, `ludy.hint_crm_deal_${hex}`, `crove.hint_crm_party_${hex}`, `crove.hint_crm_deal_${hex}`];
      });
      perOrgValues = (
        await c.query<{ val: string | null }>(`SELECT pg_catalog.current_setting(name, true) AS val FROM unnest($1::text[]) AS name`, [legacyNames])
      ).rows.map((r) => r.val);
      await c.query('COMMIT');
      gucAfterTx = (await c.query<{ val: string | null }>(`SELECT pg_catalog.current_setting('ludy.stream_hint_counts', true) AS val`)).rows[0]?.val ?? null;
    });

    bounded(payloads.filter((p) => p.startsWith(`${first} crm_party `)), first, 'crm_party', { exactOrder: top20InTriggerOrder(partyIdsByOrg.get(first)!) });
    bounded(payloads.filter((p) => p.startsWith(`${second} crm_party `)), second, 'crm_party', { exactOrder: top20InTriggerOrder(partyIdsByOrg.get(second)!) });
    bounded(payloads.filter((p) => p.startsWith(`${first} crm_deal `)), first, 'crm_deal', { exactOrder: top20InTriggerOrder(dealIdsA) });
    bounded(payloads.filter((p) => p.startsWith(`${second} crm_deal `)), second, 'crm_deal', { exactOrder: top20InTriggerOrder(dealIdsB) });
    expect(payloads).toHaveLength(84);
    expect(perOrgValues.every((v) => v === null || v === '')).toBe(true);
    expect(JSON.parse(gucDuringTx!)).toEqual({
      tx: expect.stringMatching(/^[0-9]+$/),
      counts: {
        [`crm_party:${first}`]: 'many',
        [`crm_party:${second}`]: 'many',
        [`crm_deal:${first}`]: 'many',
        [`crm_deal:${second}`]: 'many',
      },
    });
    expect(gucAfterTx === null || gucAfterTx === '').toBe(true);
  });

  it('fails closed on malformed, non-object, stale-tx, or out-of-range values in ludy.stream_hint_counts (#3423)', async () => {
    const orgId = await org();
    const uuidList = (n: number) => Array.from({ length: n }, () => randomUUID());
    const dupId = randomUUID();
    const badRaw: Array<{ label: string; make: (tx: string) => string }> = [
      { label: 'not-json', make: () => '{not-json' },
      { label: 'null', make: () => 'null' },
      { label: 'array', make: () => '[]' },
      { label: 'number', make: () => '123' },
      { label: 'legacy-map', make: () => JSON.stringify({ [`crm_party:${orgId}`]: 'many' }) },
      { label: 'stale-tx', make: () => JSON.stringify({ tx: '0', counts: { [`crm_party:${orgId}`]: 'many' } }) },
      { label: 'numeric-tx', make: (tx) => `{"tx":${tx},"counts":{"crm_party:${orgId}":"many"}}` },
      { label: 'non-object-counts', make: (tx) => JSON.stringify({ tx, counts: [] }) },
      { label: 'string-entry', make: (tx) => JSON.stringify({ tx, counts: { [`crm_party:${orgId}`]: 'oops' } }) },
      { label: 'numeric-string-entry', make: (tx) => JSON.stringify({ tx, counts: { [`crm_party:${orgId}`]: '5' } }) },
      { label: 'int-entry', make: (tx) => JSON.stringify({ tx, counts: { [`crm_party:${orgId}`]: 22 } }) },
      { label: 'neg-entry', make: (tx) => JSON.stringify({ tx, counts: { [`crm_party:${orgId}`]: -5 } }) },
      { label: 'bad-uuid-entry', make: (tx) => JSON.stringify({ tx, counts: { [`crm_party:${orgId}`]: ['not-a-uuid'] } }) },
      { label: 'null-elem-entry', make: (tx) => JSON.stringify({ tx, counts: { [`crm_party:${orgId}`]: [null] } }) },
      { label: 'dup-uuids-20', make: (tx) => JSON.stringify({ tx, counts: { [`crm_party:${orgId}`]: Array.from({ length: 20 }, () => dupId) } }) },
      { label: 'over-20-uuids-21', make: (tx) => JSON.stringify({ tx, counts: { [`crm_party:${orgId}`]: uuidList(21) } }) },
      { label: 'over-20-uuids-22', make: (tx) => JSON.stringify({ tx, counts: { [`crm_party:${orgId}`]: uuidList(22) } }) },
    ];
    for (const item of badRaw) {
      let id = '';
      const payloads = await hintsOf(async (c) => {
        await c.query('BEGIN');
        const tx = (await c.query<{ tx: string }>('SELECT pg_catalog.pg_current_xact_id()::text AS tx')).rows[0]!.tx;
        await c.query(`SELECT pg_catalog.set_config('ludy.stream_hint_counts', $1, true)`, [item.make(tx)]);
        id = (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) VALUES ($1, 'person', 'Khách lỗi JSON') RETURNING id`, [orgId])).rows[0]!.id;
        await c.query('COMMIT');
      });
      expect(payloads, `bad GUC (${item.label})`).toEqual([`${orgId} crm_party ${id}`]);
    }
    // A session-level set_config(..., false) left behind from an earlier transaction does not silence a new transaction.
    let nextId = '';
    const afterSessionLeak = await hintsOf(async (c) => {
      await c.query('BEGIN');
      const oldTx = (await c.query<{ tx: string }>('SELECT pg_catalog.pg_current_xact_id()::text AS tx')).rows[0]!.tx;
      await c.query(`SELECT pg_catalog.set_config('ludy.stream_hint_counts', $1, false)`, [JSON.stringify({ tx: oldTx, counts: { [`crm_party:${orgId}`]: 'many' } })]);
      await c.query('COMMIT');
      await c.query('BEGIN');
      nextId = (await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) VALUES ($1, 'person', 'Sau phiên') RETURNING id`, [orgId])).rows[0]!.id;
      await c.query('COMMIT');
    });
    expect(afterSessionLeak).toEqual([`${orgId} crm_party ${nextId}`]);

    // Pre-seeded valid 20-UUID list in current tx: touching one of the already-seen ids does not trigger nil; a new 21st distinct id emits nil and flips to 'many'.
    const seen = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Sẵn ' || i FROM generate_series(1, 20) i RETURNING id`, [orgId])
        ).rows.map((r) => r.id),
    );
    let seededTx = '';
    let gucAfterUpdate: string | null = null;
    let gucAfterInsert: string | null = null;
    let newIds: string[] = [];
    const seeded = await hintsOf(async (c) => {
      await c.query('BEGIN');
      seededTx = (await c.query<{ tx: string }>('SELECT pg_catalog.pg_current_xact_id()::text AS tx')).rows[0]!.tx;
      await c.query(`SELECT pg_catalog.set_config('ludy.stream_hint_counts', $1, true)`, [JSON.stringify({ tx: seededTx, counts: { [`crm_party:${orgId}`]: seen } })]);
      await c.query(`UPDATE ludy_kernel.party SET name = 'Sửa lại' WHERE org_id = $1 AND id = $2`, [orgId, seen[0]]);
      gucAfterUpdate = (await c.query<{ val: string | null }>(`SELECT pg_catalog.current_setting('ludy.stream_hint_counts', true) AS val`)).rows[0]?.val ?? null;
      newIds = (
        await c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Mới ' || i FROM generate_series(1, 5) i RETURNING id`, [orgId])
      ).rows.map((r) => r.id);
      gucAfterInsert = (await c.query<{ val: string | null }>(`SELECT pg_catalog.current_setting('ludy.stream_hint_counts', true) AS val`)).rows[0]?.val ?? null;
      await c.query('COMMIT');
    });
    expect(JSON.parse(gucAfterUpdate!)).toEqual({ tx: seededTx, counts: { [`crm_party:${orgId}`]: seen } });
    expect(JSON.parse(gucAfterInsert!)).toEqual({ tx: seededTx, counts: { [`crm_party:${orgId}`]: 'many' } });
    expect(newIds).toHaveLength(5);
    expect(seeded).toEqual([`${orgId} crm_party ${STREAM_HINT_MANY_ID}`]);
  });

  it('bounds multi-org single-statement writes cleanly in one GUC pass (#3423)', async () => {
    const orgs = await Promise.all(Array.from({ length: 30 }, () => org()));
    let singleRowPayloads: Array<{ org_id: string; id: string }> = [];
    let gucMapRaw = '';
    const multiPayloads = await hintsOf(async (c) => {
      await c.query('BEGIN');
      singleRowPayloads = (
        await c.query<{ org_id: string; id: string }>(
          `INSERT INTO ludy_kernel.party (org_id, kind, name)
           SELECT o, 'person', 'Đa công ty ' || i
           FROM unnest($1::uuid[]) WITH ORDINALITY AS t(o, i)
           RETURNING org_id, id`,
          [orgs],
        )
      ).rows;
      gucMapRaw = (await c.query<{ val: string }>(`SELECT pg_catalog.current_setting('ludy.stream_hint_counts', true) AS val`)).rows[0]!.val;
      await c.query('COMMIT');
    });

    const gucEnvelope = JSON.parse(gucMapRaw) as { tx: string; counts: Record<string, unknown> };
    expect(gucEnvelope.tx).toMatch(/^[0-9]+$/);
    expect(Object.keys(gucEnvelope.counts)).toHaveLength(30);
    for (const row of singleRowPayloads) {
      expect(multiPayloads).toContain(`${row.org_id} crm_party ${row.id}`);
      expect(gucEnvelope.counts[`crm_party:${row.org_id}`]).toEqual([row.id]);
    }

    const three = orgs.slice(0, 3);
    let bulkRows: Array<{ org_id: string; id: string }> = [];
    const bulkMulti = await hintsOf(async (c) => {
      bulkRows = (
        await c.query<{ org_id: string; id: string }>(
          `INSERT INTO ludy_kernel.party (org_id, kind, name)
           SELECT o, 'person', 'Lô ' || i
           FROM unnest($1::uuid[]) AS o, generate_series(1, 25) AS i
           RETURNING org_id, id`,
          [three],
        )
      ).rows;
    });
    expect(bulkMulti).toHaveLength(63);
    for (const o of three) {
      const expected = top20InTriggerOrder(bulkRows.filter((r) => r.org_id === o).map((r) => r.id));
      bounded(bulkMulti.filter((p) => p.startsWith(`${o} crm_party `)), o, 'crm_party', { exactOrder: expected });
    }
  });

  it('bounds crm_deal hints on member removal (owner_user_id SET NULL) and bulk deal updates, while keeping single deal edits exact (#3423)', async () => {
    const { orgId, owner } = await orgWithOwner();
    const tag = randomUUID().slice(0, 8);
    const memberEmail = `member-${tag}@crm-stream.test`;
    const member = await upsertIdentity(createDb(pool), { issuer: 'crm-stream', subject: `member-${tag}`, email: memberEmail, name: null });
    const asMfa = { type: 'user' as const, userId: owner, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const { acceptPath } = await app.execute<{ acceptPath: string }>('kernel.member.invite.create', { email: memberEmail, role: 'member' }, { actor: asMfa, orgId });
    await app.executeOrgless('kernel.member.invite.accept', { token: acceptPath.split('#')[1] }, { actor: { type: 'user', userId: member, aal: 'aal1' } });

    const [partyId, stageId] = [await party(orgId), await stage(orgId)];
    let createdDealIds: string[] = [];
    const created = await hintsOf(async (c) => {
      createdDealIds = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_crm.deal (org_id, party_id, title, amount, stage_id, sort_key, owner_user_id, created_by)
           SELECT $1::uuid, $2::uuid, 'Hợp đồng bí mật ' || i, 987654321, $3::uuid, 'V' || i, $4::uuid, $5::uuid
           FROM generate_series(1, 60) i
           RETURNING id`,
          [orgId, partyId, stageId, member, owner],
        )
      ).rows.map((r) => r.id);
    });
    expect(createdDealIds).toHaveLength(60);
    bounded(created, orgId, 'crm_deal', { exactOrder: top20InTriggerOrder(createdDealIds) });

    // Removing the member clears owner_user_id on all 60 deals via deal_owner_fk ON DELETE SET NULL.
    const onRemoval = await hintsOf(() => app.execute('kernel.member.remove', { userId: member }, { actor: asMfa, orgId }));
    bounded(onRemoval, orgId, 'crm_deal', { memberOf: new Set(createdDealIds) });
    expect(onRemoval).toHaveLength(21);

    let updatedDealIds: string[] = [];
    const updated = await hintsOf(async (c) => {
      updatedDealIds = (
        await c.query<{ id: string }>(`UPDATE ludy_crm.deal SET sort_key = sort_key || 'x' WHERE org_id = $1 RETURNING id`, [orgId])
      ).rows.map((r) => r.id);
    });
    expect(updatedDealIds).toHaveLength(60);
    bounded(updated, orgId, 'crm_deal', { exactOrder: top20InTriggerOrder(updatedDealIds) });
    const [one] = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM ludy_crm.deal WHERE org_id = $1 LIMIT 1', [orgId])).rows);
    const single = await hintsOf((c) => c.query(`UPDATE ludy_crm.deal SET amount = 7 WHERE org_id = $1 AND id = $2`, [orgId, one!.id]));
    expect(single).toEqual([`${orgId} crm_deal ${one!.id}`]);
    for (const p of [...created, ...onRemoval, ...updated, ...single]) expect(p).not.toMatch(/bí mật|987654321|Hợp đồng/i);
  });

  it('lets nobody but the triggers send a bounded hint and keeps trigger shapes as expected (#3423)', async () => {
    const callers = await admin(
      async (c) =>
        (
          await c.query<{ fn: string; role: string }>(
            `SELECT f.fn, r.rolname AS role
               FROM unnest(ARRAY['ludy_kernel.stream_hint_bounded_batch(text, uuid[], uuid[])', 'ludy_kernel.stream_hint_bounded(text, uuid, uuid)', 'ludy_kernel.party_stream_hint_insert()', 'ludy_kernel.party_stream_hint_update()', 'ludy_crm.deal_stream_hint()']) AS f(fn),
                    pg_catalog.pg_roles r
              WHERE r.rolname = ANY (ARRAY['ludy_tenant', 'ludy_app', 'ludy_worker', 'ludy_definer_tenant', 'ludy_definer_einvoice', 'ludy_auth_reader', 'ludy_prober', 'ludy_reporter', 'crove_tenant', 'crove_app', 'crove_worker', 'crove_definer_tenant', 'crove_prober'])
                AND pg_catalog.has_function_privilege(r.oid, f.fn, 'EXECUTE')`,
          )
        ).rows,
    );
    expect(callers).toEqual([]);
    const pubCallers = await admin(
      async (c) =>
        (
          await c.query<{ fn: string }>(
            `SELECT f.fn FROM unnest(ARRAY['ludy_kernel.stream_hint_bounded_batch(text, uuid[], uuid[])', 'ludy_kernel.stream_hint_bounded(text, uuid, uuid)', 'ludy_kernel.party_stream_hint_insert()', 'ludy_kernel.party_stream_hint_update()', 'ludy_crm.deal_stream_hint()']) AS f(fn)
             WHERE pg_catalog.has_function_privilege('public', f.fn, 'EXECUTE')`,
          )
        ).rows,
    );
    expect(pubCallers).toEqual([]);

    const triggers = await admin(
      async (c) =>
        (
          await c.query<{ tbl: string; name: string; statement: boolean; on_insert: boolean; on_update: boolean; on_delete: boolean }>(
            `SELECT t.tgrelid::regclass::text AS tbl, t.tgname AS name, (t.tgtype & 1) = 0 AS statement,
                    (t.tgtype & 4) <> 0 AS on_insert, (t.tgtype & 16) <> 0 AS on_update, (t.tgtype & 8) <> 0 AS on_delete
             FROM pg_catalog.pg_trigger t
             WHERE t.tgrelid IN ('ludy_kernel.party'::regclass, 'ludy_crm.deal'::regclass) AND t.tgname LIKE 'stream\\_hint%'
             ORDER BY 1, 2`,
          )
        ).rows,
    );
    expect(triggers).toEqual([
      { tbl: 'ludy_crm.deal', name: 'stream_hint_delete', statement: true, on_insert: false, on_update: false, on_delete: true },
      { tbl: 'ludy_crm.deal', name: 'stream_hint_insert', statement: true, on_insert: true, on_update: false, on_delete: false },
      { tbl: 'ludy_crm.deal', name: 'stream_hint_update', statement: true, on_insert: false, on_update: true, on_delete: false },
      { tbl: 'ludy_kernel.party', name: 'stream_hint', statement: true, on_insert: true, on_update: false, on_delete: false },
      { tbl: 'ludy_kernel.party', name: 'stream_hint_update', statement: true, on_insert: false, on_update: true, on_delete: false },
    ]);

    // A tenant login cannot name an org and send it a hint of its own; an unknown hint type fails closed with 22023.
    const orgId = await org();
    await expect(
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SET LOCAL ROLE ludy_tenant');
          await c.query(`SELECT ludy_kernel.stream_hint_bounded('crm_party', $1::uuid, $1::uuid)`, [orgId]);
        } finally {
          await c.query('ROLLBACK');
        }
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SET LOCAL ROLE ludy_tenant');
          await c.query(`SELECT ludy_kernel.stream_hint_bounded_batch('crm_party', ARRAY[$1::uuid], ARRAY[$1::uuid])`, [orgId]);
        } finally {
          await c.query('ROLLBACK');
        }
      }),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(admin((c) => c.query(`SELECT ludy_kernel.stream_hint_bounded('unknown', $1::uuid, $1::uuid)`, [orgId]))).rejects.toMatchObject({ code: '22023' });
    await expect(
      admin((c) => c.query(`SELECT ludy_kernel.stream_hint_bounded_batch('crm_party', ARRAY[$1::uuid, $1::uuid], ARRAY[$1::uuid])`, [orgId])),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      admin((c) => c.query(`SELECT ludy_kernel.stream_hint_bounded_batch('crm_party', ARRAY[ARRAY[$1::uuid]], ARRAY[ARRAY[$1::uuid]])`, [orgId])),
    ).rejects.toMatchObject({ code: '22023' });
    await admin((c) => c.query(`SELECT ludy_kernel.stream_hint_bounded_batch('crm_party', ARRAY[]::uuid[], ARRAY[]::uuid[])`));
    await admin((c) => c.query(`SELECT ludy_kernel.stream_hint_bounded_batch('crm_party', NULL, NULL)`));
  });

  it('reaches only the streams of the org the row belongs to (including nil bulk sentinel)', async () => {
    const [mine, other] = [await org(), await org()];
    const [partyId, stageId] = [await party(mine), await stage(mine)];
    const heard = { mine: [] as StreamHint[], other: [] as StreamHint[] };
    const subscriber = (orgId: string, into: StreamHint[]): HubSubscriber => ({ orgId, hint: (hint) => void into.push(hint), close: () => undefined });
    // A hub fed by a source that forwards what ludy_stream carries, as the kernel's does.
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    const source: NotificationSource = {
      start: (handlers) => {
        listener.on('notification', (m) => {
          if (m.channel === 'ludy_stream' && m.payload) handlers.notify(m.payload);
        });
        void listener.query('LISTEN ludy_stream').then(() => handlers.ready());
      },
      stop: async () => {
        await listener.end();
      },
    };
    const hub = new StreamHub(source);
    hub.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hub.ready).toBe(true);
    hub.subscribe(subscriber(mine, heard.mine));
    hub.subscribe(subscriber(other, heard.other));
    const dealId = (await deal(mine, partyId, stageId))[0]!;
    await admin((c) => c.query(`UPDATE ludy_kernel.party SET name = 'Tên khác' WHERE org_id = $1 AND id = $2`, [mine, partyId]));
    await admin((c) => c.query(`INSERT INTO ludy_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Nhiều ' || i FROM generate_series(1, 25) i`, [mine]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(heard.mine.slice(0, 2)).toEqual([
      { type: 'crm_deal', id: dealId },
      { type: 'crm_party', id: partyId },
    ]);
    expect(heard.mine.filter((h) => h.type === 'crm_party' && h.id === STREAM_HINT_MANY_ID)).toHaveLength(1);
    expect(heard.other).toEqual([]);
    await hub.stop();
  });
});
