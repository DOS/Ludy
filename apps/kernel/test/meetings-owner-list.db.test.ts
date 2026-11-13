// SPDX-License-Identifier: AGPL-3.0-only
// The owner's compliance list of meetings (#2703, ADR-0047): meetings.meeting.owner_list answers an owner every meeting of the org, the
// attendees-only ones the owner is no reader of included, as metadata only (no title, no text), a page at a time, with one audit row
// per call that holds counts only; an admin, a member and a viewer are refused, and the definer itself refuses anyone but a user-context
// owner of the context org. The owner then deletes such a meeting through meetings.meeting.owner_delete.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, type BlobStore, type CredentialBroker } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { contextToken } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-meetings-owner-list-secret-0123456789';
const ISSUER = 'crove-auth-meetings-owner-list';
const TITLE = 'Họp riêng về lương của anh Tuấn';

const suite = ADMIN ? describe : describe.skip;

const ITEM_KEYS = ['audioRetentionDate', 'id', 'recorderUserId', 'startedAt', 'status', 'textRetentionDate', 'videoRetentionDate', 'visibility'];

interface ListItem {
  id: string;
  recorderUserId: string;
  startedAt: string;
  visibility: string;
  status: string;
  audioRetentionDate: string;
  videoRetentionDate: string | null;
  textRetentionDate: string | null;
}
interface ListAnswer {
  items: ListItem[];
  next: { afterStartedAt: string; afterId: string } | null;
}

suite('the owner compliance list of meetings (#2703)', () => {
  const dbName = `crove_test_meetings_owner_list_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  const accounts = new Map<string, { subject: string; email: string; session: string }>();
  const userIds = new Map<string, string>();
  let orgId = '';
  let slug = '';
  let otherOrgId = '';
  let otherSlug = '';
  // Meetings of the org, newest first once their starts are set.
  const meetingIds: string[] = [];
  let hiddenId = '';
  let otherOrgMeetingId = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function token(name: string, mfa = false) {
    let who = accounts.get(name);
    if (!who) {
      who = { subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@owner-list.test`, session: randomUUID() };
      accounts.set(name, who);
    }
    const now = Math.floor(Date.now() / 1000);
    const extra = mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : { aal: 'aal1' };
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, is_anonymous: false, ...extra })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(path: string, name: string, input: unknown, org: string | null = slug, mfa = false) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token(name, mfa)}`,
        'content-type': 'application/json',
        ...(org ? { 'x-crove-org': org } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json()) as { json?: Record<string, unknown> };
    return { status: response.status, body: (body.json ?? body) as Record<string, unknown> };
  }

  async function userIdOf(name: string): Promise<string> {
    const email = accounts.get(name)?.email;
    return admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.user_account WHERE email = $1', [email])).rows[0]!.id);
  }

  async function join(name: string, role: 'admin' | 'member' | 'viewer') {
    await token(name);
    const invited = await rpc('org/invite', 'owner', { email: accounts.get(name)?.email, role }, slug, true);
    expect(invited.status).toBe(200);
    const accepted = await rpc('invites/accept', name, { token: String(invited.body.acceptPath).split('#')[1] }, null);
    expect(accepted.status).toBe(200);
    userIds.set(name, await userIdOf(name));
  }

  async function createMeeting(name: string, visibility: 'attendees' | 'org', org = slug): Promise<string> {
    const created = await rpc('meetings/create', name, { title: TITLE, visibility, consentMethod: 'told_at_start' }, org);
    expect(created.status).toBe(200);
    return String(created.body.meetingId);
  }

  const list = (name: string, input: Record<string, unknown> = {}) => rpc('meetings/ownerList', name, input);
  const okAudits = async () =>
    admin(async (c) =>
      (
        await c.query<{ detail: Record<string, unknown> }>(
          `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'meetings.meeting.owner_list' AND outcome = 'ok' ORDER BY occurred_at, id`,
          [orgId],
        )
      ).rows.map((r) => r.detail),
    );

  // Calls the definer directly as a login role in a user context of `org`, always rolled back.
  async function asUserContext<T>(userId: string, org: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org, contextToken(userId, org)]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const outcome = <T>(p: Promise<T>) =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }),
    );

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
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 6 });
    const db = createDb(pool);
    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries],
    });
    // No media is stored or played here: the store and the broker are never reached.
    app = createHttpApp({
      config,
      runtime,
      store: {} as unknown as BlobStore,
      broker: { id: 'none' } as unknown as CredentialBroker,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
    });

    const created = await rpc('org/create', 'owner', { name: `Owner List Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    slug = String(created.body.slug);
    orgId = String(created.body.orgId);
    userIds.set('owner', await userIdOf('owner'));
    await join('admin', 'admin');
    await join('recorder', 'member');
    await join('member', 'member');
    await join('viewer', 'viewer');

    const other = await rpc('org/create', 'otherOwner', { name: `Other Org ${randomUUID().slice(0, 6)}`, idempotencyKey: randomUUID() }, null);
    expect(other.status).toBe(200);
    otherSlug = String(other.body.slug);
    otherOrgId = String(other.body.orgId);
    userIds.set('otherOwner', await userIdOf('otherOwner'));

    // Five meetings: the recorder's attendees-only one (the owner reads nothing of it), and four more. Their starts are set apart by a
    // minute each so the order is known: meetingIds[0] is the newest.
    hiddenId = await createMeeting('recorder', 'attendees');
    const rest = [await createMeeting('recorder', 'org'), await createMeeting('member', 'attendees'), await createMeeting('owner', 'org'), await createMeeting('member', 'org')];
    meetingIds.push(hiddenId, ...rest);
    await admin(async (c) => {
      for (const [i, id] of meetingIds.entries()) {
        await c.query(`UPDATE crove_meetings.meeting SET started_at = TIMESTAMPTZ '2026-11-01 09:00:00+07' - make_interval(mins => $2::int) WHERE id = $1`, [id, i]);
      }
    });
    otherOrgMeetingId = await createMeeting('otherOwner', 'org', otherSlug);
    // The other org's meeting is the newest of all: if any row of another org leaked, it would be the first.
    await admin((c) => c.query(`UPDATE crove_meetings.meeting SET started_at = TIMESTAMPTZ '2026-11-02 09:00:00+07' WHERE id = $1`, [otherOrgMeetingId]));
  });

  afterAll(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses an admin, a member and a viewer with FORBIDDEN, and writes no ok audit row for them', async () => {
    for (const name of ['admin', 'member', 'viewer', 'recorder']) {
      const refused = await list(name);
      expect(refused.status, name).toBe(403);
      expect(refused.body.code, name).toBe('FORBIDDEN');
    }
    expect(await okAudits()).toEqual([]);
  });

  it('answers the owner every meeting of the org, newest first, with exactly the metadata keys and no title', async () => {
    // The owner cannot read the attendees-only meeting of the recorder through the ordinary path.
    expect((await rpc('meetings/get', 'owner', { meetingId: hiddenId })).status).toBe(404);

    const answer = await list('owner');
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual(['items', 'next']);
    const { items, next } = answer.body as unknown as ListAnswer;
    expect(items.map((m) => m.id)).toEqual(meetingIds);
    expect(next).toBeNull();
    for (const item of items) expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    expect(JSON.stringify(answer.body)).not.toContain(TITLE);

    const hidden = items.find((m) => m.id === hiddenId)!;
    expect(hidden).toMatchObject({ recorderUserId: userIds.get('recorder'), visibility: 'attendees', status: 'ready', videoRetentionDate: null });
    expect(hidden.audioRetentionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Date(hidden.startedAt).toISOString()).toBe('2026-11-01T02:00:00.000Z');
    expect(items.find((m) => m.id === meetingIds[1])?.visibility).toBe('org');
    // Nothing of the other org.
    expect(items.some((m) => m.id === otherOrgMeetingId)).toBe(false);
  });

  it('pages with the keyset cursor: two pages of two and a last of one, with no row twice', async () => {
    const first = (await list('owner', { limit: 2 })).body as unknown as ListAnswer;
    expect(first.items.map((m) => m.id)).toEqual(meetingIds.slice(0, 2));
    expect(first.next).toEqual({ afterStartedAt: first.items[1]!.startedAt, afterId: meetingIds[1] });
    const second = (await list('owner', { limit: 2, ...first.next })).body as unknown as ListAnswer;
    expect(second.items.map((m) => m.id)).toEqual(meetingIds.slice(2, 4));
    expect(second.next).not.toBeNull();
    const third = (await list('owner', { limit: 2, ...second.next })).body as unknown as ListAnswer;
    expect(third.items.map((m) => m.id)).toEqual(meetingIds.slice(4));
    expect(third.next).toBeNull();
    // A page that ends exactly on the last meeting says there is no next one.
    const exact = (await list('owner', { limit: 5 })).body as unknown as ListAnswer;
    expect(exact.items).toHaveLength(5);
    expect(exact.next).toBeNull();
    // Half a cursor is refused before the command runs.
    expect((await list('owner', { afterId: meetingIds[0] })).status).toBe(400);
    expect((await list('owner', { limit: 201 })).status).toBe(400);
  });

  it('writes one audit row per call, whose detail holds counts and no id, title or text', async () => {
    const before = (await okAudits()).length;
    await list('owner', { limit: 2 });
    await list('owner');
    const rows = await okAudits();
    expect(rows.length).toBe(before + 2);
    const [paged, full] = rows.slice(-2);
    expect(paged).toMatchObject({ count: 2, limit: 2, paged: false, more: true });
    expect(full).toMatchObject({ count: 5, limit: 200, paged: false, more: false });
    // The runtime adds the session facts of a user; the command adds counts and flags only.
    for (const detail of [paged, full]) {
      expect(Object.keys(detail!).filter((k) => !['aal', 'sessionId', 'mfaAt'].includes(k)).sort()).toEqual(['count', 'limit', 'more', 'paged']);
      const text = JSON.stringify(detail);
      expect(text).not.toContain(TITLE);
      for (const id of meetingIds) expect(text).not.toContain(id);
    }
  });

  it('the definer answers a user-context owner of the context org only, and no text column', async () => {
    const call = (org: string) => (c: pg.Client) => c.query(`SELECT * FROM crove_meetings.meeting_owner_list_page($1::uuid, 200, NULL, NULL)`, [org]);
    for (const name of ['admin', 'member', 'viewer']) {
      expect(await outcome(asUserContext(userIds.get(name)!, orgId, call(orgId))), name).toMatchObject({ ok: false, code: '42501' });
    }
    // An owner of one org cannot name another: the org argument must be the context's.
    expect(await outcome(asUserContext(userIds.get('owner')!, orgId, call(otherOrgId)))).toMatchObject({ ok: false, code: '42501' });
    // The owner of the other org sees its own meeting only.
    const theirs = await asUserContext(userIds.get('otherOwner')!, otherOrgId, call(otherOrgId));
    expect(theirs.rows.map((r: { id: string }) => r.id)).toEqual([otherOrgMeetingId]);
    const mine = await asUserContext(userIds.get('owner')!, orgId, call(orgId));
    expect(mine.rows.map((r: { id: string }) => r.id)).toEqual(meetingIds);
    expect(mine.fields.map((f) => f.name)).toEqual([
      'id',
      'started_at',
      'recorder_user_id',
      'org_wide',
      'status_code',
      'audio_retention_date',
      'video_retention_date',
      'text_retention_date',
    ]);
    // text (25), varchar (1043), json (114) and jsonb (3802) are the types a line of meeting text would travel in.
    for (const field of mine.fields) expect([25, 1043, 114, 3802], field.name).not.toContain(field.dataTypeID);
    // Half a cursor is refused by the definer too.
    expect(
      await outcome(asUserContext(userIds.get('owner')!, orgId, (c) => c.query(`SELECT * FROM crove_meetings.meeting_owner_list_page($1::uuid, 200, now(), NULL)`, [orgId]))),
    ).toMatchObject({ ok: false, code: '22023' });
    // EXECUTE is granted to crove_tenant alone (not PUBLIC, not the worker role directly), as for meeting_owner_delete.
    const grantees = await admin(async (c) =>
      (
        await c.query<{ grantee: string }>(
          `SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee
             FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
            WHERE p.oid = 'crove_meetings.meeting_owner_list_page(uuid, integer, timestamptz, uuid)'::regprocedure
              AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner`,
        )
      ).rows.map((r) => r.grantee),
    );
    expect(grantees).toEqual(['crove_tenant']);
    // The older, narrower list it replaces is gone: one owner-list definer.
    const lists = await admin(async (c) =>
      (await c.query<{ name: string }>(`SELECT p.proname AS name FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'crove_meetings' AND p.proname LIKE 'meeting\\_owner\\_list%' ORDER BY 1`)).rows.map((r) => r.name),
    );
    expect(lists).toEqual(['meeting_owner_list_page']);
  });

  it('the owner deletes an attendees-only meeting they cannot read, found through the list, and it leaves the list', async () => {
    const before = (await list('owner')).body as unknown as ListAnswer;
    expect(before.items.some((m) => m.id === hiddenId)).toBe(true);
    // R3: a fresh second factor.
    expect((await rpc('meetings/ownerDelete', 'owner', { meetingId: hiddenId })).body.code).toBe('STEP_UP_REQUIRED');
    // An admin cannot use the compliance delete.
    expect((await rpc('meetings/ownerDelete', 'admin', { meetingId: hiddenId }, slug, true)).status).toBe(403);
    const deleted = await rpc('meetings/ownerDelete', 'owner', { meetingId: hiddenId }, slug, true);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ meetingId: hiddenId, shredded: true });
    expect(Number(await admin(async (c) => (await c.query('SELECT count(*) FROM crove_meetings.meeting WHERE id = $1', [hiddenId])).rows[0].count))).toBe(0);
    const after = (await list('owner')).body as unknown as ListAnswer;
    expect(after.items.map((m) => m.id)).toEqual(meetingIds.filter((id) => id !== hiddenId));
    // The other org's meeting is untouched.
    expect(Number(await admin(async (c) => (await c.query('SELECT count(*) FROM crove_meetings.meeting WHERE id = $1', [otherOrgMeetingId])).rows[0].count))).toBe(1);
  });
});
