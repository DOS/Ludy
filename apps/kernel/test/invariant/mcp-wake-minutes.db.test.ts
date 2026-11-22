// SPDX-License-Identifier: AGPL-3.0-only
// The wake-up that tells an agent the minutes of an org-visible meeting were published (#3803, owner approval 2026-11-18, Meetings PO design review on the issue), pinned before the code:
// - who is woken: every COMPANY grant of the org whose wake-up is on and whose standing holds now (not revoked, expired or disabled, and the grantor still an owner or admin: a grantor demoted
//   after the grant was made wakes nothing); never a member-bound grant (the 2026-11-13 hold: member grants get no signals and no minutes event, and the database refuses the type for one), never
//   another org's grant;
// - when: one event per publish of a RESULT of a meeting whose visibility is 'org'; an attendees-only meeting, a draft, a publish of items alone and a refused publish send nothing, a retry of the
//   same event sends nothing new, a second publish sends one more, an event older than 24 hours when it would be sent is dropped and audited by its id, and nothing is sent while Meetings is off (the
//   relay does not park Meetings' events, so such an event is not released later);
// - what: a body of ids and instants only, exactly the six top-level keys and the two data keys `meeting_id` and `published_at`; a title and a summary seeded with canary strings are in no stored
//   row, not in the outbox event and not in any body;
// - the list of grants to wake is a worker-only definer that returns ids.
// Part of the invariant suite: its fixtures are its own, and it imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run
// makes its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, DomainError, Runtime, parseVaultKey, type UserActor } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { wakeMinutesPublished } from '../../src/mcp-wake-minutes.ts';
import { makeWakeSecret } from '../../src/mcp-wake-setup.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const EVENT = 'meetings.minutes.published';
const TYPE = 'meetings.minutes_published';
const TOP_KEYS = ['created_at', 'data', 'grant', 'id', 'org', 'type'];
const HOUR = 3_600_000;
// Words in the meeting that must reach no stored row.
const CANARY_TITLE = 'BÍ MẬT-3803 họp giá';
const CANARY_SUMMARY = 'BÍ MẬT-3803 tóm tắt';

suite('the wake-up for published minutes of an org-visible meeting (#3803, invariants first)', () => {
  const dbName = `crove_test_mcp_wake_minutes_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let worker: Runtime;
  let orgA = '';
  let orgB = '';
  const users = { ownerA: '', adminA: '', demotedA: '', recorderA: '', ownerB: '' };
  const ids: Record<string, string> = {};
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const exec = (who: keyof typeof users, name: string, input: unknown, org = orgA) => runtime.execute(name, input, { actor: browser(users[who]), orgId: org });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const sqlAdmin = <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []) => admin((c) => c.query<R>(text, params));

  // A grant row of a company or a member-bound kind, with its wake-up set the way an owner or admin sets it (a company grant) or the member sets it (a member-bound one).
  async function wakeGrant(org: string, userId: string, kind: 'company' | 'member' = 'company', setWake = true): Promise<string> {
    const id = randomUUID();
    await sqlAdmin(
      `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
       VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, clock_timestamp(), now() + interval '30 days', $3, $6, ${kind === 'member' ? '$3' : 'NULL'})`,
      [org, id, userId, `oauth-${id}`, `client-${id}`, kind],
    );
    if (setWake) {
      const made = makeWakeSecret(vault, org, id);
      await runtime.execute('kernel.mcp.wake.set', { grantId: id, url: 'https://hooks.example.com/ludy', credential: made.credential }, { actor: browser(userId), orgId: org });
    }
    return id;
  }

  async function seedMeeting(key: string, visibility: 'org' | 'attendees', publish: boolean): Promise<string> {
    const meetingId = randomUUID();
    ids[key] = meetingId;
    await sqlAdmin(
      `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, $5, 'vi', now(), now() + interval '30 minutes', 1800, $3, $4, 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgA, meetingId, users.recorderA, visibility, `${CANARY_TITLE} ${key}`],
    );
    await exec('recorderA', 'meetings.summary.save', { meetingId, summary: `${CANARY_SUMMARY} ${key}`, decisions: [`${CANARY_SUMMARY} quyết định`] });
    await exec('recorderA', 'meetings.action_item.create', { meetingId, title: `${CANARY_SUMMARY} việc`, who: 'An', whoUserId: null, when: 'thứ sáu', whenDate: null, transcriptSeconds: 5 });
    if (publish) await exec('recorderA', 'meetings.result.publish', { meetingId, confirmed: true });
    return meetingId;
  }

  const events = (meetingId?: string) =>
    sqlAdmin<{ id: string; payload: Record<string, unknown>; created_at: Date }>(`SELECT id, payload, created_at FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2 ORDER BY created_at, id`, [orgA, EVENT]).then((r) =>
      r.rows.filter((e) => meetingId === undefined || e.payload.meetingId === meetingId),
    );
  const deliveries = (where = '') =>
    sqlAdmin<{ id: string; grant_id: string; type: string; body: Record<string, unknown>; status: string }>(
      `SELECT id, grant_id, type, body, status FROM crove_kernel.agent_wake_delivery WHERE org_id = $1 AND type = $2 ${where} ORDER BY created_at, id`,
      [orgA, TYPE],
    ).then((r) => r.rows);
  const sent: Array<{ orgId: string; id: string }> = [];
  const wake = (eventId: string, options: { now?: () => Date; org?: string } = {}) =>
    wakeMinutesPublished({ runtime: worker, send: async (job) => void sent.push(job), ...(options.now ? { now: options.now } : {}) }, { orgId: options.org ?? orgA, eventId });
  const reset = async () => {
    await sqlAdmin(`DELETE FROM crove_kernel.agent_wake_delivery WHERE org_id = $1`, [orgA]);
    sent.length = 0;
  };
  async function refusal(promise: Promise<unknown>): Promise<DomainError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      return error as DomainError;
    }
    throw new Error('expected a refusal');
  }

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN);
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
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 6 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    const defs = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...meetingsQueries] };
    runtime = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(defs);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register(defs);
    const db = createDb(appPool);
    for (const key of Object.keys(users) as Array<keyof typeof users>) users[key] = await upsertIdentity(db, { issuer: 'mcp-wake-minutes', subject: key, email: `${key}@mcp-wake-minutes.test`, name: null });
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    orgB = (await createOrg(runtime, browser(users.ownerB), 'Org B')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'admin'), ($1, $4, 'member')`, [orgA, users.adminA, users.demotedA, users.recorderA]);
    await sqlAdmin(`UPDATE crove_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1`, [orgA]);
    // The grants of org A: two company grants that stand, a member-bound grant, a company grant with no wake-up set, one revoked, one whose grantor is demoted to member after the grant was made;
    // and a company grant of org B (another org's wake-up).
    ids.gOwner = await wakeGrant(orgA, users.ownerA);
    ids.gAdmin = await wakeGrant(orgA, users.adminA);
    ids.gMember = await wakeGrant(orgA, users.adminA, 'member');
    ids.gNoWake = await wakeGrant(orgA, users.ownerA, 'company', false);
    ids.gRevoked = await wakeGrant(orgA, users.ownerA);
    await sqlAdmin(`UPDATE crove_kernel.agent_grant SET revoked_at = now() WHERE org_id = $1 AND id = $2`, [orgA, ids.gRevoked]);
    ids.gDemoted = await wakeGrant(orgA, users.demotedA);
    await sqlAdmin(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgA, users.demotedA]);
    // A demotion normally revokes the person's grants (a trigger); the grant is put back as live here, as if that revocation had been missed, so that only the live role keeps it from being woken.
    await sqlAdmin(`UPDATE crove_kernel.agent_grant SET revoked_at = NULL WHERE org_id = $1 AND id = $2`, [orgA, ids.gDemoted]);
    ids.gOtherOrg = await wakeGrant(orgB, users.ownerB);
  }, 180_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }, 60_000);

  it('wakes the company grants whose wake-up stands, once each, and no other: not a member-bound grant, a grant with no wake-up, a revoked one, a demoted grantor\'s, or another org\'s', async () => {
    await reset();
    const meetingId = await seedMeeting('published', 'org', true);
    const [event] = await events(meetingId);
    expect(event, 'the publish stored one event').toBeDefined();
    const result = await wake((event as { id: string }).id);
    expect(result).toMatchObject({ off: false, dropped: false, stored: 2, handedOver: 2 });
    const rows = await deliveries();
    expect(rows.map((r) => r.grant_id).sort()).toEqual([ids.gOwner, ids.gAdmin].sort());
    for (const none of ['gMember', 'gNoWake', 'gRevoked', 'gDemoted', 'gOtherOrg']) expect(rows.map((r) => r.grant_id), none).not.toContain(ids[none]);
    expect(sent.map((s) => s.id).sort()).toEqual(rows.map((r) => r.id).sort());
    // Nothing for another org's grant: org B stored no delivery of any kind (the list of grants is scoped to the org of the event, pinned again on the definer below).
    expect((await sqlAdmin(`SELECT 1 FROM crove_kernel.agent_wake_delivery WHERE org_id = $1`, [orgB])).rowCount).toBe(0);
  });

  it('stores a body of ids and instants only: the six top-level keys and the two data keys, the grant\'s own ids, the instant the list shows, and no word of the title or the summary anywhere', async () => {
    const rows = await deliveries();
    expect(rows.length).toBeGreaterThan(0);
    const [event] = await events(ids.published);
    const resultAt = (await sqlAdmin<{ at: Date }>(`SELECT updated_at AS at FROM crove_meetings.meeting_result WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgA, ids.published])).rows[0]?.at;
    for (const row of rows) {
      expect(row.type).toBe(TYPE);
      expect(Object.keys(row.body).sort()).toEqual(TOP_KEYS);
      expect(row.body).toMatchObject({ id: row.id, type: TYPE, org: orgA, grant: row.grant_id });
      expect(Object.keys(row.body.data as Record<string, unknown>).sort()).toEqual(['meeting_id', 'published_at']);
      expect(row.body.data).toEqual({ meeting_id: ids.published, published_at: (resultAt as Date).toISOString() });
      expect(row.body.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
    }
    // The canaries are in no stored row of the feature: not a body, not the outbox event (ids and an instant), not an audit row.
    const everything = JSON.stringify([
      rows,
      (await sqlAdmin(`SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = $2`, [orgA, EVENT])).rows,
      (await sqlAdmin(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'kernel.mcp.wake.%'`, [orgA])).rows,
    ]);
    expect(everything).not.toContain('BÍ MẬT');
    expect(everything).not.toContain('họp giá');
    expect(Object.keys((event as { payload: Record<string, unknown> }).payload).sort()).toEqual(['meetingId', 'publishedAt']);
  });

  it('sends nothing new for a retry of the same event, and one more for the next publish of the meeting', async () => {
    const before = await deliveries();
    sent.length = 0;
    const [event] = await events(ids.published);
    const again = await wake((event as { id: string }).id);
    expect(again).toMatchObject({ stored: 0, handedOver: 0, dropped: false, off: false });
    expect((await deliveries()).map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(sent).toEqual([]);
    // A second publish of the same meeting (a new draft, read and published again) is a second event, so it wakes each grant once more.
    await exec('recorderA', 'meetings.summary.save', { meetingId: ids.published, summary: `${CANARY_SUMMARY} 2`, decisions: [] });
    await exec('recorderA', 'meetings.result.publish', { meetingId: ids.published, confirmed: true });
    const after = await events(ids.published);
    expect(after).toHaveLength(2);
    expect((await wake((after[1] as { id: string }).id)).stored).toBe(2);
    expect(await deliveries()).toHaveLength(before.length + 2);
  });

  it('emits no event for an attendees-only meeting, a draft that is not published, a publish of items alone, or a refused publish, so nothing is sent for them', async () => {
    const count = (await events()).length;
    await seedMeeting('attendees', 'attendees', true);
    await seedMeeting('draftOnly', 'org', false);
    expect(await events(ids.attendees)).toEqual([]);
    expect(await events(ids.draftOnly)).toEqual([]);
    // Items alone: the meeting's result is already published; a new action item is drafted and published without a new summary draft.
    await exec('recorderA', 'meetings.action_item.create', { meetingId: ids.published, title: `${CANARY_SUMMARY} việc 2`, who: 'An', whoUserId: null, when: 'thứ sáu', whenDate: null, transcriptSeconds: 9 });
    expect((await events()).length).toBe(count);
    await exec('recorderA', 'meetings.result.publish', { meetingId: ids.published, confirmed: true });
    expect((await events()).length, 'a publish of items alone emits nothing').toBe(count);
    // A refused publish (nothing left to publish) emits nothing.
    await refusal(exec('recorderA', 'meetings.result.publish', { meetingId: ids.published, confirmed: true }));
    expect((await events()).length).toBe(count);
  });

  it('drops an event older than 24 hours when it would be sent, audits the drop by its id, and still sends one that is 23 hours old', async () => {
    await reset();
    const meetingId = await seedMeeting('stale', 'org', true);
    const [event] = await events(meetingId);
    const at = (event as { created_at: Date }).created_at.getTime();
    const dropped = await wake((event as { id: string }).id, { now: () => new Date(at + 25 * HOUR) });
    expect(dropped).toMatchObject({ dropped: true, stored: 0, handedOver: 0 });
    expect(await deliveries()).toEqual([]);
    expect(sent).toEqual([]);
    const audit = (await sqlAdmin<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.mcp.wake.minutes_targets' ORDER BY occurred_at DESC LIMIT 1`, [orgA])).rows[0];
    expect(audit?.detail).toMatchObject({ eventId: (event as { id: string }).id, dropped: true });
    expect(JSON.stringify(audit)).not.toContain('BÍ MẬT');
    // The bound is "older than 24 hours": at exactly 24 hours the event is still sent.
    const edge = await wake((event as { id: string }).id, { now: () => new Date(at + 24 * HOUR) });
    expect(edge).toMatchObject({ dropped: false, stored: 2, handedOver: 2 });
    await reset();
    const fresh = await wake((event as { id: string }).id, { now: () => new Date(at + 23 * HOUR) });
    expect(fresh).toMatchObject({ dropped: false, stored: 2, handedOver: 2 });
  });

  it('keeps a delivery whose hand-over to the queue failed, stores nothing new when the job runs again, and leaves it to the existing sweep to hand over', async () => {
    await reset();
    const meetingId = await seedMeeting('handOver', 'org', true);
    const [event] = await events(meetingId);
    const failed = await wakeMinutesPublished({ runtime: worker, send: async () => Promise.reject(new Error('queue down')) }, { orgId: orgA, eventId: (event as { id: string }).id });
    expect(failed).toMatchObject({ stored: 2, handedOver: 0 });
    const stored = await deliveries();
    expect(stored.map((r) => r.status)).toEqual(['queued', 'queued']);
    expect(await wake((event as { id: string }).id)).toMatchObject({ stored: 0, handedOver: 0 });
    expect(sent).toEqual([]);
    // The sweep's own list (mcp_wake_open: never handed over for three minutes) picks both up, as the worker's login sees it.
    await sqlAdmin(`UPDATE crove_kernel.agent_wake_delivery SET queued_at = now() - interval '4 minutes' WHERE org_id = $1 AND type = $2`, [orgA, TYPE]);
    const url = new URL(adminUrl);
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    const asWorker = new pg.Client({ connectionString: url.toString() });
    await asWorker.connect();
    try {
      const open = await asWorker.query<{ id: string; kind: string }>(`SELECT id, kind FROM crove_kernel.mcp_wake_open(100)`);
      expect(open.rows.filter((r) => stored.some((s) => s.id === r.id)).map((r) => r.kind)).toEqual(['send', 'send']);
    } finally {
      await asWorker.end();
    }
  });

  it('sends nothing while Meetings is off for the org (the event is not parked: running the same job again once it is on is what sends it)', async () => {
    await reset();
    const meetingId = await seedMeeting('offApp', 'org', true);
    const [event] = await events(meetingId);
    const owner: UserActor = { type: 'user', userId: users.ownerA, aal: 'aal2', sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const setApp = (enabled: boolean) => runtime.execute('kernel.org.set_app', { module: 'meetings', enabled }, { actor: owner, orgId: orgA, idempotencyKey: randomUUID() });
    await setApp(false);
    try {
      expect(await wake((event as { id: string }).id)).toMatchObject({ off: true, stored: 0, handedOver: 0 });
      expect(await deliveries()).toEqual([]);
    } finally {
      await setApp(true);
    }
    expect(await wake((event as { id: string }).id)).toMatchObject({ off: false, stored: 2 });
  });

  it('wakes nobody for a grantor demoted after the grant was made, and nobody once a grant is revoked or its owner is disabled, however the wake-up row stands', async () => {
    await reset();
    const meetingId = await seedMeeting('standing', 'org', true);
    const [event] = await events(meetingId);
    // The grant of the demoted grantor still has an enabled wake-up row and is neither revoked nor expired: only the live role says no.
    const stored = await sqlAdmin<{ enabled: boolean; revoked_at: Date | null }>(
      `SELECT w.enabled, g.revoked_at FROM crove_kernel.agent_grant_wake w JOIN crove_kernel.agent_grant g ON g.org_id = w.org_id AND g.id = w.grant_id WHERE w.grant_id = $1`,
      [ids.gDemoted],
    );
    expect(stored.rows[0]).toMatchObject({ enabled: true, revoked_at: null });
    await sqlAdmin(`UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1`, [users.adminA]);
    try {
      const result = await wake((event as { id: string }).id);
      expect(result.stored).toBe(1);
      expect((await deliveries()).map((r) => r.grant_id)).toEqual([ids.gOwner]);
    } finally {
      // Disabling a person revokes their grants (a trigger); the person and their grants are put back for the cases after this one.
      await sqlAdmin(`UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1`, [users.adminA]);
      await sqlAdmin(`UPDATE crove_kernel.agent_grant SET revoked_at = NULL WHERE org_id = $1 AND id = ANY($2::uuid[])`, [orgA, [ids.gAdmin, ids.gMember]]);
    }
  });

  it('refuses the type for a member-bound grant in the database whoever asks, and stores nothing for it', async () => {
    const id = randomUUID();
    const body = { id, type: TYPE, created_at: '2026-11-18T03:00:00.000Z', org: orgA, grant: ids.gMember, data: { meeting_id: randomUUID(), published_at: '2026-11-18T02:59:58.123Z' } };
    const error = await refusal(worker.execute('kernel.mcp.wake.enqueue', { id, grantId: ids.gMember, type: TYPE, body }, { actor: { type: 'system', component: 'kernel.mcp.wake' }, orgId: orgA }));
    // The kind is what refuses: INVALID (422), not the grant failing to stand (MCP_WAKE_GRANT_NOT_FOUND, 404), which this grant does not (it is live with a wake-up).
    expect([error.code, error.status]).toEqual(['INVALID', 422]);
    expect((await sqlAdmin(`SELECT 1 FROM crove_kernel.agent_wake_delivery WHERE org_id = $1 AND grant_id = $2 AND type = $3`, [orgA, ids.gMember, TYPE])).rowCount).toBe(0);
    // The same body for a company grant is stored, which shows the refusal is the grant's kind and not the body.
    const companyId = randomUUID();
    const stored = await worker.execute<{ stored: boolean }>(
      'kernel.mcp.wake.enqueue',
      { id: companyId, grantId: ids.gOwner, type: TYPE, body: { ...body, id: companyId, grant: ids.gOwner } },
      { actor: { type: 'system', component: 'kernel.mcp.wake' }, orgId: orgA },
    );
    expect(stored.stored).toBe(true);
  });

  it('lists the grants to wake through a definer of the worker\'s login alone, which returns ids and nothing else and pins its search path', async () => {
    const fn = 'crove_kernel.mcp_wake_company_targets(uuid, integer)';
    await admin(async (c) => {
      const roles = (await c.query(`SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\\_%'`)).rows.map((r: { rolname: string }) => r.rolname);
      for (const role of roles) expect((await c.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, fn])).rows[0].ok, `${role} execute ${fn}`).toBe(role === 'crove_worker');
      expect((await c.query(`SELECT has_function_privilege('public', $1, 'EXECUTE') AS ok`, [fn])).rows[0].ok).toBe(false);
      const meta = (await c.query(`SELECT proconfig, prosecdef FROM pg_catalog.pg_proc WHERE oid = $1::regprocedure`, [fn])).rows[0];
      expect(meta.prosecdef).toBe(true);
      expect(JSON.stringify(meta.proconfig)).toContain('search_path=pg_catalog, pg_temp');
      const def = (await c.query(`SELECT pg_get_functiondef($1::regprocedure) AS def`, [fn])).rows[0].def as string;
      expect(def, 'it names no sealed kind').not.toMatch(/mcp_company|mcp_member/);
    });
    const asWorker = new pg.Client({ connectionString: (() => { const url = new URL(adminUrl); url.username = 'crove_worker'; url.password = 'test-worker-pw'; return url.toString(); })() });
    await asWorker.connect();
    try {
      const listed = await asWorker.query(`SELECT * FROM crove_kernel.mcp_wake_company_targets($1::uuid, 100)`, [orgA]);
      expect(listed.fields.map((f) => f.name)).toEqual(['grant_id']);
      expect(listed.rows.map((r: { grant_id: string }) => r.grant_id).sort()).toEqual([ids.gOwner, ids.gAdmin].sort());
    } finally {
      await asWorker.end();
    }
  });
});
