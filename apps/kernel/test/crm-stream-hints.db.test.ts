// SPDX-License-Identifier: AGPL-3.0-only
// Stream hints of the CRM (issue #3293, crm.md section 5), on PostgreSQL 17: a deal or a contact's details that change
// send `<org> crm_deal <id>` or `<org> crm_party <id>` on crove_stream, the id only (never a title, an amount or a
// name), to the streams of that org alone. A bulk delete of deals sends one hint per org. Set CROVE_TEST_ADMIN_URL to
// a superuser URL; the run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import type { StreamHint } from '@ludy/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { StreamHub, parseHint, type HubSubscriber, type NotificationSource } from '../src/stream.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DONE = 'crm-stream-hints:done';
const suite = ADMIN ? describe : describe.skip;

suite('stream hints of deals and contacts (#3293)', () => {
  const dbName = `crove_test_crm_stream_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let app: Runtime;

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function org(): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pool), { issuer: 'crm-stream', subject: `owner-${tag}`, email: `owner-${tag}@crm-stream.test`, name: null });
    return (await createOrg(app, { type: 'user', userId: owner, aal: 'aal1' }, `CRM ${tag}`)).orgId;
  }

  async function party(orgId: string, name = 'Nguyễn Văn Bí Mật'): Promise<string> {
    return admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, kind, name, email, phone) VALUES ($1, 'person', $2, 'bimat@khach.test', '0912345678') RETURNING id`, [orgId, name])).rows[0]!.id);
  }

  async function stage(orgId: string): Promise<string> {
    return admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_crm.pipeline_stage (org_id, name, kind, position) VALUES ($1, 'Mới', 'open', 1) RETURNING id`, [orgId])).rows[0]!.id);
  }

  async function deal(orgId: string, partyId: string, stageId: string, n = 1): Promise<string[]> {
    return admin(async (c) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO crove_crm.deal (org_id, party_id, title, amount, stage_id, sort_key, created_by)
           SELECT $1::uuid, $2::uuid, 'Hợp đồng bí mật ' || i, 987654321, $3::uuid, 'V' || i, $4::uuid FROM generate_series(1, $5::integer) i RETURNING id`,
          [orgId, partyId, stageId, randomUUID(), n],
        )
      ).rows.map((r) => r.id),
    );
  }

  // The crove_stream payloads the statements send, in the order they come, up to a marker sent after them.
  async function hintsOf(statements: (c: pg.Client) => Promise<unknown>): Promise<string[]> {
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    const payloads: string[] = [];
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    listener.on('notification', (m) => {
      if (m.channel !== 'crove_stream' || !m.payload) return;
      if (m.payload === DONE) done();
      else payloads.push(m.payload);
    });
    await listener.query('LISTEN crove_stream');
    try {
      await admin(statements);
      await admin((c) => c.query(`SELECT pg_catalog.pg_notify('crove_stream', $1)`, [DONE]));
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    app = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands],
      queries: [...kernelQueries({ inboundDomain: null })],
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
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
    const moved = await hintsOf((c) => c.query(`UPDATE crove_crm.deal SET sort_key = 'W', amount = 5, version = version + 1 WHERE org_id = $1 AND id = $2`, [orgId, dealId]));
    expect(moved).toEqual([`${orgId} crm_deal ${dealId}`]);
    const removed = await hintsOf((c) => c.query('DELETE FROM crove_crm.deal WHERE org_id = $1 AND id = $2', [orgId, dealId]));
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
    const payloads = await hintsOf((c) => c.query('DELETE FROM crove_crm.deal WHERE org_id = ANY($1)', [[first, second]]));
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
      await c.query(`UPDATE crove_kernel.party SET name = 'Tên mới' WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
      await c.query(`UPDATE crove_kernel.party SET email = 'moi@khach.test' WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
      await c.query(`UPDATE crove_kernel.party SET phone = NULL WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
    });
    expect(changed).toEqual(Array(3).fill(`${orgId} crm_party ${partyId}`));

    // A new version is one (a screen sends it back with an edit).
    const bumped = await hintsOf((c) => c.query(`UPDATE crove_kernel.party SET version = version + 1 WHERE org_id = $1 AND id = $2`, [orgId, partyId]));
    expect(bumped).toEqual([`${orgId} crm_party ${partyId}`]);

    // A rewrite of the same values and a verification are not what a contact screen shows.
    const quiet = await hintsOf(async (c) => {
      await c.query(`UPDATE crove_kernel.party SET name = 'Tên mới', email = 'moi@khach.test' WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
      await c.query(`UPDATE crove_kernel.party SET verified_at = now() WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
    });
    expect(quiet).toEqual([]);
  });

  // #3423: a transaction that writes many contacts or deals sends a bounded number of hints (the first 20 name their row, the 21st the nil id), not one NOTIFY per row.
  const MANY = '00000000-0000-0000-0000-000000000000';
  const bounded = (payloads: string[], orgId: string, type: 'crm_party' | 'crm_deal') => {
    expect(payloads.length).toBeLessThanOrEqual(21);
    expect(payloads.every((p) => p.startsWith(`${orgId} ${type} `))).toBe(true);
    expect(payloads.filter((p) => p.endsWith(` ${MANY}`))).toHaveLength(1);
    expect(payloads[payloads.length - 1]).toBe(`${orgId} ${type} ${MANY}`);
    for (const p of payloads) expect(parseHint(p)).toMatchObject({ orgId, hint: { type } });
  };

  it('bounds the hints of a large contact import: 2000 parties one by one, each with a company link, send at most 21 (#3423)', async () => {
    const orgId = await org();
    const payloads = await hintsOf(async (c) => {
      await c.query('BEGIN');
      const company = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, kind, name) VALUES ($1, 'organization', 'Công ty nhập') RETURNING id`, [orgId])).rows[0]!.id;
      for (let i = 0; i < 2000; i++) {
        const id = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, kind, name, email) VALUES ($1, 'person', $2, $3) RETURNING id`, [orgId, `Khách ${i}`, `k${i}@nhap.test`])).rows[0]!.id;
        await c.query('UPDATE crove_kernel.party SET company_id = $3 WHERE org_id = $1 AND id = $2', [orgId, id, company]);
      }
      await c.query('COMMIT');
    });
    bounded(payloads, orgId, 'crm_party');
    // The first hints name a party each, as a single change does (PostgreSQL folds the same payload sent twice in one transaction, so the insert and the link update of one party are one notification); the
    // rest is the one nil hint. No name, email or phone anywhere.
    expect(payloads.length).toBeGreaterThanOrEqual(11);
    expect(new Set(payloads).size).toBe(payloads.length);
    for (const p of payloads) expect(p).not.toMatch(/Khách|nhap\.test|Công ty/);
  });

  it('bounds one statement that writes 2000 parties, and the org purge\'s bulk updates (#3423)', async () => {
    const orgId = await org();
    const inserted = await hintsOf((c) => c.query(`INSERT INTO crove_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Khách ' || i FROM generate_series(1, 2000) i`, [orgId]));
    bounded(inserted, orgId, 'crm_party');
    // The purge's updates: the contact fields erased, the duplicate mark reset, in bulk.
    const erased = await hintsOf((c) => c.query(`UPDATE crove_kernel.party SET email = NULL, phone = NULL, address = NULL, name = 'Đã xóa' WHERE org_id = $1`, [orgId]));
    bounded(erased, orgId, 'crm_party');
    // A statement that changes nothing a screen shows sends nothing, however many rows it touches.
    expect(await hintsOf((c) => c.query(`UPDATE crove_kernel.party SET verified_at = now() WHERE org_id = $1`, [orgId]))).toEqual([]);
  });

  it('keeps a small change exact and starts each transaction at zero: a few rows name themselves, and the count does not carry over (#3423)', async () => {
    const orgId = await org();
    let ids: string[] = [];
    const few = await hintsOf(async (c) => {
      ids = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Khách ' || i FROM generate_series(1, 5) i RETURNING id`, [orgId])).rows.map((r) => r.id);
    });
    expect([...few].sort()).toEqual(ids.map((id) => `${orgId} crm_party ${id}`).sort());
    // 30 rows use up the budget of their transaction; the next transaction names its own party again.
    await hintsOf((c) => c.query(`INSERT INTO crove_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Đợt ' || i FROM generate_series(1, 30) i`, [orgId]));
    const later = await hintsOf(async (c) => {
      ids = [(await c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, kind, name) VALUES ($1, 'person', 'Sau đó') RETURNING id`, [orgId])).rows[0]!.id];
    });
    expect(later).toEqual([`${orgId} crm_party ${ids[0]}`]);
  });

  it('bounds the budget per org: two orgs in one transaction each get their own 21 (#3423)', async () => {
    const [first, second] = [await org(), await org()];
    const payloads = await hintsOf(async (c) => {
      await c.query('BEGIN');
      for (const o of [first, second]) await c.query(`INSERT INTO crove_kernel.party (org_id, kind, name) SELECT $1::uuid, 'person', 'Khách ' || i FROM generate_series(1, 100) i`, [o]);
      await c.query('COMMIT');
    });
    bounded(payloads.filter((p) => p.startsWith(first)), first, 'crm_party');
    bounded(payloads.filter((p) => p.startsWith(second)), second, 'crm_party');
    expect(payloads).toHaveLength(42);
  });

  it('bounds the hints of many deals written by one statement (a member\'s removal clears the owner of each deal), and one deal stays exact (#3423)', async () => {
    const orgId = await org();
    const [partyId, stageId] = [await party(orgId), await stage(orgId)];
    const created = await hintsOf(async () => {
      await deal(orgId, partyId, stageId, 60);
    });
    bounded(created, orgId, 'crm_deal');
    const updated = await hintsOf((c) => c.query(`UPDATE crove_crm.deal SET sort_key = sort_key || 'x' WHERE org_id = $1`, [orgId]));
    bounded(updated, orgId, 'crm_deal');
    const [one] = await admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_crm.deal WHERE org_id = $1 LIMIT 1', [orgId])).rows);
    const single = await hintsOf((c) => c.query(`UPDATE crove_crm.deal SET amount = 7 WHERE org_id = $1 AND id = $2`, [orgId, one!.id]));
    expect(single).toEqual([`${orgId} crm_deal ${one!.id}`]);
    for (const p of [...created, ...updated, ...single]) expect(p).not.toMatch(/bí mật|987654321|Hợp đồng/i);
  });

  it('lets nobody but the triggers send a bounded hint: the helper and the statement functions have no caller among the app roles (#3423)', async () => {
    const callers = await admin(
      async (c) =>
        (
          await c.query<{ fn: string; role: string }>(
            `SELECT f.fn, r.rolname AS role
               FROM unnest(ARRAY['crove_kernel.stream_hint_bounded(text, uuid, uuid)', 'crove_kernel.party_stream_hint_insert()', 'crove_kernel.party_stream_hint_update()', 'crove_crm.deal_stream_hint()']) AS f(fn),
                    pg_catalog.pg_roles r
              WHERE r.rolname = ANY (ARRAY['crove_tenant', 'crove_app', 'crove_worker', 'crove_definer_tenant', 'crove_prober'])
                AND pg_catalog.has_function_privilege(r.oid, f.fn, 'EXECUTE')`,
          )
        ).rows,
    );
    expect(callers).toEqual([]);
    // A tenant login cannot name an org and send it a hint of its own.
    const orgId = await org();
    await expect(
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SET LOCAL ROLE crove_tenant');
          await c.query(`SELECT crove_kernel.stream_hint_bounded('crm_party', $1::uuid, $1::uuid)`, [orgId]);
        } finally {
          await c.query('ROLLBACK');
        }
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('reaches only the streams of the org the row belongs to', async () => {
    const [mine, other] = [await org(), await org()];
    const [partyId, stageId] = [await party(mine), await stage(mine)];
    const heard = { mine: [] as StreamHint[], other: [] as StreamHint[] };
    const subscriber = (orgId: string, into: StreamHint[]): HubSubscriber => ({ orgId, hint: (hint) => void into.push(hint), close: () => undefined });
    // A hub fed by a source that forwards what crove_stream carries, as the kernel's does.
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    const source: NotificationSource = {
      start: (handlers) => {
        listener.on('notification', (m) => {
          if (m.channel === 'crove_stream' && m.payload) handlers.notify(m.payload);
        });
        void listener.query('LISTEN crove_stream').then(() => handlers.ready());
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
    await admin((c) => c.query(`UPDATE crove_kernel.party SET name = 'Tên khác' WHERE org_id = $1 AND id = $2`, [mine, partyId]));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(heard.mine).toEqual([
      { type: 'crm_deal', id: dealId },
      { type: 'crm_party', id: partyId },
    ]);
    expect(heard.other).toEqual([]);
    await hub.stop();
  });
});
