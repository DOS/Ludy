// SPDX-License-Identifier: AGPL-3.0-only
// What an extension token can reach once it is past the HTTP edge (issue #2582, ADR-0047 point 10, meetings plan M8), on
// PostgreSQL 17, through the runtime that every command and query runs on:
// - a user actor made from a token reaches a command or query only if that definition declares one of the token's scopes
//   (`extension`), and the set of definitions that do is pinned here, so a new one is a change to this protected file;
// - everything else is refused FORBIDDEN (rule extension_scope) and the refusal is audited with the token's id, org-less
//   work is refused outright, and a token cannot list, revoke or mint tokens;
// - the token's standing is read in the transaction of every call, with no session check configured: a revoked or
//   expired token, one whose member was removed, demoted to viewer or disabled, one used for another org or for another
//   member's id is refused 401 on the very next call;
// - the meetings scope reaches only the meetings its own token created, reads a meeting's status and never anything of its
//   content, and its upload grants are for a meeting's audio and video only;
// - every audit row of a token's request names the token.
// Part of the invariant suite; it imports package code under test, never helpers from outside test/invariant/.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, EXTENSION_SCOPES, Runtime, fileKey, type UserActor } from '@crove/kernel-runtime';
import { EXTENSION_SCOPE_IDS } from '@crove/kernel-contract';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { meetingsCommands, meetingsQueries } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// Every command and query an extension token may run, with its scope. Adding one is a security change.
const REACHABLE = [
  'kernel.file.upload.begin:meetings',
  'kernel.file.upload.claim:meetings',
  'kernel.extension.token.exchanged:meetings',
  'meetings.media.record:meetings',
  'meetings.meeting.create:meetings',
  'meetings.meeting.extension_status:meetings',
];

const CREATE = { title: 'Họp tuần', consentMethod: 'told_at_start' as const, visibility: 'attendees' as const, language: 'vi' as const, keepVideo: false };

suite('the extension token past the HTTP edge: scope, standing and meetings (#2582, ADR-0047)', () => {
  const dbName = `crove_test_ext_scope_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let runtime: Runtime;
  let orgA = '';
  let orgB = '';
  const users = { ownerA: '', member: '', other: '', viewer: '', ownerB: '', memberB: '' };
  const tokens = { member: randomUUID(), memberTwo: randomUUID(), other: randomUUID(), memberB: randomUUID() };

  const browser = (userId: string): UserActor => ({ type: 'user', userId, aal: 'aal1' });
  const ext = (userId: string, tokenId: string, scopes: readonly string[] = ['meetings']): UserActor => ({ type: 'user', userId, aal: 'aal1', mfaAt: null, extension: { tokenId, scopes } });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function insertToken(orgId: string, userId: string, id: string, extra = '') {
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.extension_token (org_id, id, user_id, token_hash, device_name, scopes, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $4, 'Test device', ARRAY['meetings'], now() ${extra}, now() ${extra} + interval '30 days', $3)`,
        [orgId, id, userId, createHash('sha256').update(randomBytes(32)).digest()],
      ),
    );
  }

  async function refusal(promise: Promise<unknown> | (() => Promise<unknown>)): Promise<DomainError> {
    try {
      await (typeof promise === 'function' ? promise() : promise);
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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    const pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    pools.push(pool);
    const db = createDb(pool);
    // No session source: an extension actor's standing is checked whatever the deployment's session mode.
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries, ...meetingsQueries],
    });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'extension-scope', subject: key, email: `${key}@ext-scope.test`, name: null });
    }
    orgA = (await createOrg(runtime, browser(users.ownerA), 'Org A')).orgId;
    orgB = (await createOrg(runtime, browser(users.ownerB), 'Org B')).orgId;
    await admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer'), ($5, $6, 'member')`,
        [orgA, users.member, users.other, users.viewer, orgB, users.memberB],
      ),
    );
    await insertToken(orgA, users.member, tokens.member);
    await insertToken(orgA, users.member, tokens.memberTwo);
    await insertToken(orgA, users.other, tokens.other);
    await insertToken(orgB, users.memberB, tokens.memberB);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('pins the commands and queries an extension token may reach, and the scopes the runtime and the database know', () => {
    const defs = [...kernelCommands, ...financeCommands, ...meetingsCommands, ...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries, ...meetingsQueries] as Array<{
      name: string;
      extension?: { scope: string };
    }>;
    const reachable = defs.filter((d) => d.extension !== undefined).map((d) => `${d.name}:${d.extension?.scope}`);
    expect(reachable.sort()).toEqual([...REACHABLE].sort());
    expect([...EXTENSION_SCOPES]).toEqual([...EXTENSION_SCOPE_IDS]);
  });

  it('refuses a scope the registry does not know and an extension on a command that no token may run', () => {
    const base = { input: kernelCommands[0]!.input, risk: 'R1' as const, sideEffect: 'internal' as const, handler: async () => null };
    const fresh = () => new Runtime(createDb(pools[0]!), { manifests: TEST_MANIFESTS });
    expect(() => fresh().register({ commands: [{ ...base, name: 'kernel.x.a', access: ['owner'] as never, extension: { scope: 'nope' as never } }] })).toThrow(/scope is one of/);
    expect(() => fresh().register({ commands: [{ ...base, name: 'kernel.x.b', access: 'system' as never, extension: { scope: 'meetings' } }] })).toThrow(/role list/);
    expect(() => fresh().register({ commands: [{ ...base, name: 'kernel.x.c', access: ['owner'] as never, risk: 'R3' as const, sideEffect: 'financial' as const, extension: { scope: 'meetings' } }] })).toThrow(/below R3/);
  });

  it('runs the meetings scope as its member, stamps the meeting with the token and audits with the token', async () => {
    const { meetingId } = await runtime.execute<{ meetingId: string }>('meetings.meeting.create', CREATE, { actor: ext(users.member, tokens.member), orgId: orgA });
    const row = await admin(async (c) => (await c.query<{ recorder_user_id: string; extension_token_id: string }>('SELECT recorder_user_id, extension_token_id FROM crove_meetings.meeting WHERE id = $1', [meetingId])).rows[0]);
    expect(row).toEqual({ recorder_user_id: users.member, extension_token_id: tokens.member });
    const audit = await admin(async (c) =>
      (await c.query<{ actor_id: string; detail: Record<string, unknown> }>(`SELECT actor_id, detail FROM crove_kernel.audit_event WHERE command = 'meetings.meeting.create' AND org_id = $1`, [orgA])).rows,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor_id).toBe(users.member);
    expect(audit[0]?.detail.extensionToken).toBe(tokens.member);
    // The status query reads it, audited as a sensitive read that names the token too.
    const status = await runtime.query<Record<string, unknown>>('meetings.meeting.extension_status', { meetingId }, { actor: ext(users.member, tokens.member), orgId: orgA });
    expect(status).toEqual({ meetingId, status: 'ready', keepVideo: false, hasAudio: false, hasVideo: false, lengthSeconds: null });
    const reads = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'meetings.meeting.extension_status' AND org_id = $1`, [orgA])).rows);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.detail.extensionToken === tokens.member)).toBe(true);
  });

  it('refuses a token every command and query that does not declare its scope, and audits the refusal with the token', async () => {
    const actor = ext(users.member, tokens.member);
    const options = { actor, orgId: orgA };
    const { meetingId } = await runtime.execute<{ meetingId: string }>('meetings.meeting.create', CREATE, options);
    const refused = [
      () => runtime.query('meetings.meeting.list', {}, options),
      () => runtime.query('meetings.meeting.get', { meetingId }, options),
      () => runtime.query('meetings.meeting.audio_read', { meetingId }, options),
      () => runtime.query('meetings.meeting.video_read', { meetingId }, options),
      () => runtime.query('meetings.meeting.media_meta', { meetingId, kind: 'audio' }, options),
      () => runtime.query('meetings.settings.get', {}, options),
      () => runtime.query('kernel.extension.token.list', {}, options),
      () => runtime.query('kernel.sessions.list', { userId: users.member }, options),
      () => runtime.execute('meetings.meeting.delete', { meetingId }, options),
      () => runtime.execute('meetings.reader.add', { meetingId, userId: users.other }, options),
      () => runtime.execute('kernel.extension.token.revoke', { tokenId: tokens.member }, options),
      () => runtime.execute('kernel.extension.code.issue', { codeHash: '0'.repeat(64), codeChallenge: 'A'.repeat(43), scopes: ['meetings'], deviceName: 'x', extensionId: 'a'.repeat(32) }, options),
      () => runtime.execute('kernel.task.create', { title: 'x' }, options),
      () => runtime.execute('kernel.file.ingest', {}, options),
    ];
    for (const attempt of refused) {
      const error = await refusal(attempt());
      // The input's shape is parsed before the scope is checked, so an input a command does not take is a VALIDATION
      // answer; every well-formed call is refused for its scope.
      expect(['FORBIDDEN', 'VALIDATION'], error.message).toContain(error.code);
      if (error.code === 'FORBIDDEN') expect(error.details?.rule).toBe('extension_scope');
    }
    for (const attempt of [
      () => runtime.query('meetings.meeting.get', { meetingId }, options),
      () => runtime.query('meetings.meeting.audio_read', { meetingId }, options),
      () => runtime.execute('meetings.meeting.delete', { meetingId }, options),
      () => runtime.execute('kernel.extension.token.revoke', { tokenId: tokens.member }, options),
      () => runtime.query('kernel.extension.token.list', {}, options),
    ]) {
      const error = await refusal(attempt());
      expect(error.code, error.message).toBe('FORBIDDEN');
      expect(error.details?.rule).toBe('extension_scope');
    }
    // A token with no scope that opens the command is refused the commands it would otherwise run.
    const noScope = await refusal(runtime.execute('meetings.meeting.create', CREATE, { actor: ext(users.member, tokens.member, []), orgId: orgA }));
    expect(noScope.details?.rule).toBe('extension_scope');
    const denied = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE outcome = 'denied' AND detail->>'rule' = 'extension_scope' AND org_id = $1`, [orgA])).rows);
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.every((r) => r.detail.extensionToken === tokens.member)).toBe(true);
    // Org-less work (creating an org, the user's org list, sessions) has no org for a token to be bound to.
    const orgless = await refusal(runtime.forUser(actor, async () => 'reached'));
    expect(orgless.details?.rule).toBe('extension_org');
    const created = await refusal(createOrg(runtime, actor, 'Not by a token'));
    expect(created.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses a token on the next call when it is revoked, expired, or its member was removed, demoted or disabled', async () => {
    const standing = async (userId: string, tokenId: string, orgId = orgA) => {
      const attempt = runtime.execute('meetings.meeting.create', CREATE, { actor: ext(userId, tokenId), orgId });
      return attempt.then(() => 'ok', (error: unknown) => (error instanceof DomainError ? `${error.status} ${error.code}` : String(error)));
    };
    expect(await standing(users.member, tokens.memberTwo)).toBe('ok');
    // Revoked, with the runtime already holding the token: the next call is refused.
    await admin((c) => c.query('UPDATE crove_kernel.extension_token SET revoked_at = now() WHERE id = $1', [tokens.memberTwo]));
    expect(await standing(users.member, tokens.memberTwo)).toBe('401 EXTENSION_TOKEN_INVALID');
    // Expired.
    const expired = randomUUID();
    await insertToken(orgA, users.member, expired, "- interval '40 days'");
    expect(await standing(users.member, expired)).toBe('401 EXTENSION_TOKEN_INVALID');
    // The token of another member, or of another org, or an id the member does not own.
    expect(await standing(users.member, tokens.other)).toBe('401 EXTENSION_TOKEN_INVALID');
    expect(await standing(users.member, tokens.memberB)).toBe('401 EXTENSION_TOKEN_INVALID');
    expect(await standing(users.memberB, tokens.memberB, orgA)).toBe('401 EXTENSION_TOKEN_INVALID');
    expect(await standing(users.memberB, tokens.memberB, orgB)).toBe('ok');
    expect(await standing(users.member, randomUUID())).toBe('401 EXTENSION_TOKEN_INVALID');
    // Demoted to viewer, then restored; disabled, then enabled: each applies at once and, from #2740, for good.
    const revokedAt = async (tokenId: string) => (await admin((c) => c.query('SELECT revoked_at FROM crove_kernel.extension_token WHERE id = $1', [tokenId]))).rows[0]?.revoked_at as Date | null;
    expect(await standing(users.other, tokens.other)).toBe('ok');
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [orgA, users.other]));
    expect(await standing(users.other, tokens.other)).toBe('401 EXTENSION_TOKEN_INVALID');
    expect(await revokedAt(tokens.other), 'a demotion voids the token for good').not.toBeNull();
    await admin((c) => c.query(`UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2`, [orgA, users.other]));
    // Step 2 of #2740: the demotion voided the token for good, so restoring the role does not revive it.
    expect(await standing(users.other, tokens.other)).toBe('401 EXTENSION_TOKEN_INVALID');
    // The disable step needs its own live token: the demotion above already voided the first one.
    const disableToken = randomUUID();
    await insertToken(orgA, users.other, disableToken);
    expect(await standing(users.other, disableToken)).toBe('ok');
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = now() WHERE id = $1', [users.other]));
    expect(await standing(users.other, disableToken)).toBe('401 EXTENSION_TOKEN_INVALID');
    expect(await revokedAt(disableToken), 'disabling the user voids the token for good').not.toBeNull();
    await admin((c) => c.query('UPDATE crove_kernel.user_account SET disabled_at = NULL WHERE id = $1', [users.other]));
    expect(await standing(users.other, disableToken)).toBe('401 EXTENSION_TOKEN_INVALID');
    // Removed from the org: void, and still void when the member is added back (a new membership). A live token is
    // made for this step too, so the removal itself is what the assertions test.
    const removalToken = randomUUID();
    await insertToken(orgA, users.other, removalToken);
    expect(await standing(users.other, removalToken)).toBe('ok');
    await admin((c) => c.query('DELETE FROM crove_kernel.tenant_member WHERE org_id = $1 AND user_id = $2', [orgA, users.other]));
    expect(await standing(users.other, removalToken)).toBe('401 EXTENSION_TOKEN_INVALID');
    expect(await revokedAt(removalToken), 'removing the member voids the token and records it').not.toBeNull();
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgA, users.other]));
    expect(await standing(users.other, removalToken)).toBe('401 EXTENSION_TOKEN_INVALID');
  });

  it('lets a token reach only the meetings it created, and no other member or token reads their status', async () => {
    const mine = ext(users.member, tokens.member);
    const { meetingId } = await runtime.execute<{ meetingId: string }>('meetings.meeting.create', CREATE, { actor: mine, orgId: orgA });
    // The same member in the app makes another meeting: the token does not reach it.
    const { meetingId: inApp } = await runtime.execute<{ meetingId: string }>('meetings.meeting.create', CREATE, { actor: browser(users.member), orgId: orgA });
    const status = (actor: UserActor, id: string) => runtime.query('meetings.meeting.extension_status', { meetingId: id }, { actor, orgId: orgA });
    await expect(status(mine, meetingId)).resolves.toMatchObject({ meetingId });
    expect((await refusal(status(mine, inApp))).code).toBe('MEETING_NOT_FOUND');
    // Another token of the same member, a token of another member, and the owner of the org read nothing of it either.
    const anotherToken = randomUUID();
    await insertToken(orgA, users.member, anotherToken);
    expect((await refusal(status(ext(users.member, anotherToken), meetingId))).code).toBe('MEETING_NOT_FOUND');
    const otherToken = randomUUID();
    await insertToken(orgA, users.other, otherToken);
    expect((await refusal(status(ext(users.other, otherToken), meetingId))).code).toBe('MEETING_NOT_FOUND');
    expect((await refusal(status(browser(users.ownerA), meetingId))).code).toBe('MEETING_NOT_FOUND');
    // Finishing an upload is the same: a meeting the token did not create answers as one that does not exist.
    const media = (id: string, actor: UserActor) =>
      runtime.execute(
        'meetings.media.record',
        { meetingId: id, kind: 'audio', keyId: 'k1', wrappedKeyHex: 'a'.repeat(120), storageKey: fileKey(orgA, 'b'.repeat(64)), sizeBytes: 10, sha256: 'b'.repeat(64), contentType: 'audio/webm', lengthSeconds: 5 },
        { actor, orgId: orgA },
      );
    expect((await refusal(media(inApp, mine))).code).toBe('MEETING_NOT_FOUND');
    expect((await refusal(media(meetingId, ext(users.member, anotherToken)))).code).toBe('MEETING_NOT_FOUND');
    // A non-meeting id is not a meeting either.
    expect((await refusal(status(mine, randomUUID()))).code).toBe('MEETING_NOT_FOUND');
  });

  it('gives a token upload grants for a meeting\'s audio and video only', async () => {
    const mine = ext(users.member, tokens.member);
    const options = { actor: mine, orgId: orgA };
    for (const purpose of [undefined, 'document', 'social', 'import'] as const) {
      const error = await refusal(runtime.execute('kernel.file.upload.begin', purpose === undefined ? {} : { purpose }, options));
      expect(error.code).toBe('FORBIDDEN');
      expect(error.details?.rule).toBe('extension_scope');
    }
    const grant = await runtime.execute<{ uploadId: string }>('kernel.file.upload.begin', { purpose: 'meeting_audio' }, options);
    const claimed = await runtime.execute<{ purpose: string }>('kernel.file.upload.claim', { uploadId: grant.uploadId }, options);
    expect(claimed.purpose).toBe('meeting_audio');
    // A grant the same member made in the app for a document is missing to the token.
    const document = await runtime.execute<{ uploadId: string }>('kernel.file.upload.begin', { purpose: 'document' }, { actor: browser(users.member), orgId: orgA });
    expect((await refusal(runtime.execute('kernel.file.upload.claim', { uploadId: document.uploadId }, options))).code).toBe('NOT_FOUND');
  });

  it('lets a viewer connect no extension, a member with a stale second factor none, and a token none at all', async () => {
    const issue = { codeHash: createHash('sha256').update(randomBytes(8)).digest('hex'), codeChallenge: 'B'.repeat(43), scopes: ['meetings'], deviceName: 'Laptop', extensionId: 'a'.repeat(32) };
    expect((await refusal(runtime.execute('kernel.extension.code.issue', issue, { actor: browser(users.viewer), orgId: orgA }))).code).toBe('FORBIDDEN');
    const stale = { type: 'user' as const, userId: users.member, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) - 3600 };
    expect((await refusal(runtime.execute('kernel.extension.code.issue', issue, { actor: stale, orgId: orgA }))).code).toBe('STEP_UP_REQUIRED');
    const fresh = { ...stale, mfaAt: Math.floor(Date.now() / 1000) };
    const issued = await runtime.execute<{ codeId: string }>('kernel.extension.code.issue', issue, { actor: fresh, orgId: orgA });
    expect(issued.codeId).toBeTruthy();
    // No code is made without the id of the extension it is for (#2850, step 2 #2855): the input without it is refused before anything runs.
    const withoutId = Object.fromEntries(Object.entries(issue).filter(([key]) => key !== 'extensionId'));
    expect((await refusal(runtime.execute('kernel.extension.code.issue', withoutId, { actor: fresh, orgId: orgA }))).code).toBe('VALIDATION');
    // The audit row names the code's id and scopes and carries neither the hash, the challenge nor the device name.
    const row = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE command = 'kernel.extension.code.issue' AND org_id = $1 AND outcome = 'ok'`, [orgA])).rows[0]);
    const text = JSON.stringify(row?.detail);
    expect(text).not.toContain(issue.codeHash);
    expect(text).not.toContain(issue.codeChallenge);
    expect(text).not.toContain(issue.deviceName);
  });

  it('lists and revokes a member\'s own devices only, and a revoke ends the token on its next call', async () => {
    const own = await runtime.query<Array<{ id: string; deviceName: string }>>('kernel.extension.token.list', {}, { actor: browser(users.member), orgId: orgA });
    expect(own.map((t) => t.id)).toContain(tokens.member);
    expect(own.some((t) => t.id === tokens.other || t.id === tokens.memberB)).toBe(false);
    expect(JSON.stringify(own)).not.toMatch(/token_hash|tokenHash/);
    // Another member, the org's owner and a member of another org cannot revoke it: one answer, 404.
    for (const actor of [browser(users.other), browser(users.ownerA)]) {
      expect((await refusal(runtime.execute('kernel.extension.token.revoke', { tokenId: tokens.member }, { actor, orgId: orgA }))).code).toBe('EXTENSION_TOKEN_NOT_FOUND');
    }
    expect((await refusal(runtime.execute('kernel.extension.token.revoke', { tokenId: tokens.member }, { actor: browser(users.memberB), orgId: orgB }))).code).toBe('EXTENSION_TOKEN_NOT_FOUND');
    await expect(runtime.execute('meetings.meeting.create', CREATE, { actor: ext(users.member, tokens.member), orgId: orgA })).resolves.toBeTruthy();
    await runtime.execute('kernel.extension.token.revoke', { tokenId: tokens.member }, { actor: browser(users.member), orgId: orgA });
    expect((await refusal(runtime.execute('meetings.meeting.create', CREATE, { actor: ext(users.member, tokens.member), orgId: orgA }))).code).toBe('EXTENSION_TOKEN_INVALID');
    // Already revoked: the same single answer.
    expect((await refusal(runtime.execute('kernel.extension.token.revoke', { tokenId: tokens.member }, { actor: browser(users.member), orgId: orgA }))).code).toBe('EXTENSION_TOKEN_NOT_FOUND');
  });
});
