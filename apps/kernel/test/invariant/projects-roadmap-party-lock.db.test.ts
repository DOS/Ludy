// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite (#5035, #5127): canonical lock ordering between projects.roadmap.signal.create (party FOR SHARE ->
// roadmap_item FOR SHARE -> roadmap_signal) and kernel.personal_data.erase (party FOR NO KEY UPDATE ->
// roadmap_signal UPDATE). Verifies both directions serialize deadlock-free without TOCTOU stale party names.
// Part of the invariant suite: self-contained under apps/kernel/test/invariant/ (imports only packages under test and
// local ./fixtures/*). Set LUDY_TEST_ADMIN_URL or CROVE_TEST_ADMIN_URL to a superuser URL.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  Deal,
  PersonalDataErasure,
  RoadmapAdminItem,
  RoadmapBoardSummary,
  RoadmapSignalCreateResult,
} from '@ludy/kernel-contract';
import { Runtime, type UserActor } from '@ludy/kernel-runtime';
import { crmCommands, crmQueries } from '@ludy/mod-crm';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import {
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ISSUER = 'projects-roadmap-party-lock-inv';
const suite = ADMIN ? describe : describe.skip;

suite('projects.roadmap.signal.create vs kernel.personal_data.erase party lock ordering (#5035, #5127)', () => {
  const dbName = `ludy_inv_party_lock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds!: DbIdentifiers;
  let pool: pg.Pool | undefined;
  let db!: ReturnType<typeof createDb>;
  let rt!: Runtime;

  const asUser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1', sessionId: randomUUID() });
  const asMfa = (userId: string): UserActor => ({
    type: 'user',
    userId,
    aal: 'aal2',
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds, { canonicalizeCatalog: false });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw' }, dbIds);

    const appUrl = new URL(adminUrl);
    appUrl.username = dbIds.roleName('crove_app');
    appUrl.password = 'test-app-pw';

    pool = createDbPool({ connectionString: appUrl.toString(), max: 6 }, dbIds);
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...crmCommands, ...projectsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries, ...projectsQueries],
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

  it('serializes both lock directions on ludy_kernel.party without deadlocking or leaking stale party names', async () => {
    const ownerId = await upsertIdentity(db, {
      issuer: ISSUER,
      subject: `owner-${randomUUID()}`,
      email: `owner-${randomUUID().slice(0, 8)}@inv.test`,
      name: 'Owner Lock Inv',
    });
    const { orgId } = await createOrg(rt, asUser(ownerId), 'Cong ty Khoa Party Inv');
    const exec = <T>(cmd: string, input: unknown, idempotencyKey?: string) =>
      rt.execute<T>(cmd, input, {
        actor: asUser(ownerId),
        orgId,
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });

    const { board } = await exec<{ board: RoadmapBoardSummary }>('projects.roadmap.board.create', {
      title: 'Lo trinh Party Inv',
      slug: 'roadmap-party-inv',
    });
    const { item: item1 } = await exec<{ item: RoadmapAdminItem }>('projects.roadmap.item.create', {
      boardId: board.id,
      publicTitle: 'Muc 1',
      publicSummary: null,
      category: null,
    });
    const { item: item2 } = await exec<{ item: RoadmapAdminItem }>('projects.roadmap.item.create', {
      boardId: board.id,
      publicTitle: 'Muc 2',
      publicSummary: null,
      category: null,
    });
    await exec('crm.pipeline.setup', {});

    const email1 = 'party-inv-1@example.test';
    const name1 = 'Khach Hang Inv 1';
    const party1 = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.party (org_id, name, kind, email) VALUES ($1, $2, 'person', $3) RETURNING id`,
            [orgId, name1, email1],
          )
        ).rows[0]!.id,
    );
    const deal1 = await exec<Deal>('crm.deal.create', {
      partyId: party1,
      title: 'Co hoi Inv 1',
      amount: '1000000',
      expectedClose: null,
    });

    const email2 = 'party-inv-2@example.test';
    const name2 = 'Khach Hang Inv 2';
    const party2 = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.party (org_id, name, kind, email) VALUES ($1, $2, 'person', $3) RETURNING id`,
            [orgId, name2, email2],
          )
        ).rows[0]!.id,
    );
    const deal2 = await exec<Deal>('crm.deal.create', {
      partyId: party2,
      title: 'Co hoi Inv 2',
      amount: '2000000',
      expectedClose: null,
    });
    const existingSig2 = await exec<RoadmapSignalCreateResult>('projects.roadmap.signal.create', {
      boardId: board.id,
      roadmapItemId: item2.id,
      sourceType: 'crm.deal',
      sourceId: deal2.id,
    });
    expect(existingSig2.signal.accountLabel).toBe(name2);

    const track = <T>(promise: Promise<T>, errors: unknown[], all: Array<Promise<unknown>>): Promise<T> => {
      void promise.catch((err) => {
        errors.push(err);
      });
      all.push(promise);
      return promise;
    };

    const waitBlocked = async (blockingPid: number, queryPattern: string, errors: unknown[]): Promise<number> => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (errors.length > 0) throw errors[0];
        const waited = await admin(async (c) =>
          (
            await c.query<{ pid: number }>(
              `SELECT a.pid
                 FROM pg_catalog.pg_stat_activity a
                WHERE a.datname = pg_catalog.current_database()
                  AND a.state = 'active'
                  AND a.wait_event_type = 'Lock'
                  AND a.query ILIKE $2
                  AND $1::int = ANY(pg_catalog.pg_blocking_pids(a.pid))
                LIMIT 1`,
              [blockingPid, queryPattern],
            )
          ).rows[0],
        );
        if (waited) return waited.pid;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for ${queryPattern} to block on pid ${blockingPid}`);
    };

    // Direction 1: signal.create acquires party FOR SHARE first and waits on roadmap_item FOR SHARE;
    // personalDataErase waits on party FOR NO KEY UPDATE until commit, then erases the newly inserted signal.
    const gate1 = createDbClient({ connectionString: adminUrl }, dbIds, { canonicalizeCatalog: false });
    await gate1.connect();
    const d1Errors: unknown[] = [];
    const d1Started: Array<Promise<unknown>> = [];
    try {
      const gate1Pid = (await gate1.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]!.pid;
      await gate1.query('BEGIN');
      await gate1.query('SELECT 1 FROM crove_projects.roadmap_item WHERE org_id = $1 AND id = $2 FOR UPDATE', [orgId, item1.id]);
      const sigPromise1 = track(
        exec<RoadmapSignalCreateResult>(
          'projects.roadmap.signal.create',
          { boardId: board.id, roadmapItemId: item1.id, sourceType: 'crm.deal', sourceId: deal1.id },
          randomUUID(),
        ),
        d1Errors,
        d1Started,
      );
      const sigPid1 = await waitBlocked(gate1Pid, '%roadmap_item%for share%', d1Errors);
      const erasePromise1 = track(
        rt.execute<PersonalDataErasure>(
          'kernel.personal_data.erase',
          { value: email1 },
          { actor: asMfa(ownerId), orgId, idempotencyKey: randomUUID() },
        ),
        d1Errors,
        d1Started,
      );
      await waitBlocked(sigPid1, '%from%.party p%', d1Errors);
      await gate1.query('COMMIT');
      const [sig1, erase1] = await Promise.all([sigPromise1, erasePromise1]);
      expect(sig1.signal.id).toBeTruthy();
      expect(erase1.erased).toContainEqual({ column: 'ludy_kernel.party.name', rows: 1 });
    } finally {
      await gate1.query('ROLLBACK').catch(() => undefined);
      await Promise.allSettled(d1Started);
      await gate1.end().catch(() => undefined);
    }
    const dbSig1 = await admin(
      async (c) =>
        (
          await c.query<{ account_label: string | null; source_party_id: string | null }>(
            `SELECT account_label, source_party_id FROM crove_projects.roadmap_signal
              WHERE org_id = $1 AND roadmap_item_id = $2 AND source_type = 'crm.deal' AND source_id = $3`,
            [orgId, item1.id, deal1.id],
          )
        ).rows[0],
    );
    expect(dbSig1).toEqual({ account_label: null, source_party_id: null });

    // Direction 2: personalDataErase acquires party FOR NO KEY UPDATE first and waits on existingSig2 UPDATE;
    // concurrent signal.create waits on party FOR SHARE instead of reading the stale party name.
    const gate2 = createDbClient({ connectionString: adminUrl }, dbIds, { canonicalizeCatalog: false });
    await gate2.connect();
    const d2Errors: unknown[] = [];
    const d2Started: Array<Promise<unknown>> = [];
    try {
      const gate2Pid = (await gate2.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]!.pid;
      await gate2.query('BEGIN');
      await gate2.query('SELECT 1 FROM crove_projects.roadmap_signal WHERE org_id = $1 AND id = $2 FOR UPDATE', [
        orgId,
        existingSig2.signal.id,
      ]);
      const erasePromise2 = track(
        rt.execute<PersonalDataErasure>(
          'kernel.personal_data.erase',
          { value: email2 },
          { actor: asMfa(ownerId), orgId, idempotencyKey: randomUUID() },
        ),
        d2Errors,
        d2Started,
      );
      const erasePid2 = await waitBlocked(gate2Pid, '%update%roadmap_signal%', d2Errors);
      // Prove behaviorally (before queueing a conflicting FOR SHARE waiter on the tuple lock) that personalDataErase
      // holds FOR NO KEY UPDATE rather than FOR UPDATE: FOR KEY SHARE must succeed immediately without blocking.
      const keyShareProbe = createDbClient({ connectionString: adminUrl }, dbIds, { canonicalizeCatalog: false });
      await keyShareProbe.connect();
      try {
        await keyShareProbe.query('BEGIN');
        await keyShareProbe.query("SET LOCAL lock_timeout = '500ms'");
        const keyShareRes = await keyShareProbe.query<{ id: string }>(
          'SELECT id FROM crove_kernel.party WHERE org_id = $1 AND id = $2 FOR KEY SHARE',
          [orgId, party2],
        );
        expect(keyShareRes.rows).toEqual([{ id: party2 }]);
        await keyShareProbe.query('COMMIT');
      } finally {
        await keyShareProbe.query('ROLLBACK').catch(() => undefined);
        await keyShareProbe.end().catch(() => undefined);
      }
      const sigPromise2 = track(
        exec<RoadmapSignalCreateResult>(
          'projects.roadmap.signal.create',
          { boardId: board.id, roadmapItemId: item1.id, sourceType: 'crm.deal', sourceId: deal2.id },
          randomUUID(),
        ),
        d2Errors,
        d2Started,
      );
      await waitBlocked(erasePid2, '%party%for share%', d2Errors);
      await gate2.query('COMMIT');
      const [erase2, sig2] = await Promise.all([erasePromise2, sigPromise2]);
      expect(erase2.erased).toContainEqual({ column: 'ludy_kernel.party.name', rows: 1 });
      expect(sig2.signal.accountLabel).toBeNull();
    } finally {
      await gate2.query('ROLLBACK').catch(() => undefined);
      await Promise.allSettled(d2Started);
      await gate2.end().catch(() => undefined);
    }
    const dbSig2 = await admin(
      async (c) =>
        (
          await c.query<{ account_label: string | null; source_party_id: string | null }>(
            `SELECT account_label, source_party_id FROM crove_projects.roadmap_signal
              WHERE org_id = $1 AND roadmap_item_id = $2 AND source_type = 'crm.deal' AND source_id = $3`,
            [orgId, item1.id, deal2.id],
          )
        ).rows[0],
    );
    expect(dbSig2).toEqual({ account_label: null, source_party_id: null });
  }, 60_000);
});
