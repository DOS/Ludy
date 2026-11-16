// SPDX-License-Identifier: AGPL-3.0-only
// Stream hints of the CRM (issue #3293, crm.md section 5), on PostgreSQL 17: a deal or a contact's details that change
// send `<org> crm_deal <id>` or `<org> crm_party <id>` on crove_stream, the id only (never a title, an amount or a
// name), to the streams of that org alone. A bulk delete of deals sends one hint per org. Set CROVE_TEST_ADMIN_URL to
// a superuser URL; the run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { StreamHint } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
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

    // A rewrite of the same values, a version bump and a verification are not what a contact screen shows.
    const quiet = await hintsOf(async (c) => {
      await c.query(`UPDATE crove_kernel.party SET name = 'Tên mới', email = 'moi@khach.test', version = version + 1 WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
      await c.query(`UPDATE crove_kernel.party SET verified_at = now() WHERE org_id = $1 AND id = $2`, [orgId, partyId]);
    });
    expect(quiet).toEqual([]);
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
