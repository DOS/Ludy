// SPDX-License-Identifier: AGPL-3.0-only
// Meeting media file rows as a member's Vy sees them (#2874, ADR-0047, ADR-0049): the file policy shows a member-Vy run the segment files of the meeting its own live
// run names, when its member is that meeting's recorder, and nothing else: not another member's meeting, not a video file, not a file no segment names.
// Part of the invariant suite; it imports code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes
// its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { meetingsCommands, meetingsQueries, setTranscribeEnabled } from '@crove/mod-meetings';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('a member Vy run sees only its own meeting segment files (#2874)', () => {
  const dbName = `crove_test_inv_media_vy_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let orgId = '';
  const users: Record<string, string> = {};
  const meetings: Record<string, string> = {};
  const runs: Record<string, { agentId: string; runId: string }> = {};
  const audioFile: Record<string, string> = {};
  const videoFile: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function seedMeeting(recorder: string): Promise<string> {
    const id = randomUUID();
    await admin(async (c) => {
      await c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, 'Họp', 'vi', now(), now() + interval '10 minutes', 600, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, id, users[recorder]],
      );
      const sha = randomUUID().replaceAll('-', '').padEnd(64, '0');
      const file = randomUUID();
      await c.query(`INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, 'a.opus', 'audio/ogg', 100, 'meeting_audio')`, [orgId, file, sha, `org/${orgId}/${sha}`]);
      await c.query(`INSERT INTO crove_meetings.audio_segment (org_id, id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES ($1, $2, $3, $4, 0, 0, 600)`, [orgId, randomUUID(), id, file]);
      audioFile[id] = file;
      const vsha = randomUUID().replaceAll('-', '').padEnd(64, '1');
      const video = randomUUID();
      await c.query(`INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, 'v.webm', 'video/webm', 100, 'meeting_video')`, [orgId, video, vsha, `org/${orgId}/${vsha}`]);
      await c.query(`INSERT INTO crove_meetings.meeting_video (org_id, id, meeting_id, file_id, length_seconds, video_retention_date) VALUES ($1, $2, $3, $4, 600, current_date + 7)`, [orgId, randomUUID(), id, video]);
      videoFile[id] = video;
      await c.query(`INSERT INTO crove_meetings.media_key (org_id, id, meeting_id, key_id, kind, wrapped_key) VALUES ($1, $2, $3, 'k1', 'audio', $4)`, [orgId, randomUUID(), id, Buffer.alloc(60, 7)]);
    });
    return id;
  }

  // A run of `who`'s Vy for `meeting`, started by the member's own command as the app does.
  async function startRun(who: string, meeting: string): Promise<{ agentId: string; runId: string }> {
    const started = await app.execute<{ runId: string }>('kernel.member_vy.run.start', { feature: 'meetings.transcribe', subjectType: 'meeting', subjectId: meeting }, { actor: asUser(who), orgId });
    const agent = await admin((c) => c.query<{ id: string }>(`SELECT id FROM crove_kernel.agent WHERE org_id = $1 AND member_user_id = $2 AND kind = 'member_vy'`, [orgId, users[who]]));
    return { agentId: agent.rows[0]?.id as string, runId: started.runId };
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
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const appPool = createPool({ connectionString: appUrl, max: 3 });
    const workerPool = createPool({ connectionString: workerUrl, max: 4 });
    pools.push(appPool, workerPool);
    setTranscribeEnabled(true);
    const register = { commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] };
    app = new Runtime(createDb(appPool), { manifests: TEST_MANIFESTS }).register(register);
    for (const key of ['owner', 'recorder', 'other']) {
      users[key] = await upsertIdentity(createDb(appPool), { issuer: 'inv-media-vy', subject: key, email: `${key}@inv-media-vy.test`, name: null });
    }
    orgId = (await createOrg(app, { type: 'user', userId: users.owner as string, aal: 'aal1' }, 'Invariant media vy')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, users.recorder, users.other]));
    meetings.mine = await seedMeeting('recorder');
    meetings.theirs = await seedMeeting('other');
    runs.recorder = await startRun('recorder', meetings.mine as string);
    runs.other = await startRun('other', meetings.theirs as string);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // The file ids this run's member-scoped context reads of the four test files (every file row of the org is asked for by id).
  async function seenBy(who: string): Promise<string[]> {
    const run = runs[who] as { agentId: string; runId: string };
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, run.agentId, run.runId]);
      return (await c.query<{ id: string }>('SELECT id FROM crove_kernel.file WHERE org_id = $1', [orgId])).rows.map((r) => r.id);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  it("the recorder's own live run sees the segment file of its own meeting, and no video file", async () => {
    const seen = await seenBy('recorder');
    expect(seen).toContain(audioFile[meetings.mine as string]);
    expect(seen).not.toContain(videoFile[meetings.mine as string]);
  });

  it("another member's Vy run sees none of the recorder's files, and its own meeting's segment file only", async () => {
    const seen = await seenBy('other');
    expect(seen).toContain(audioFile[meetings.theirs as string]);
    expect(seen).not.toContain(audioFile[meetings.mine as string]);
    expect(seen).not.toContain(videoFile[meetings.mine as string]);
    expect(seen).not.toContain(videoFile[meetings.theirs as string]);
  });

  it("the recorder's run does not see another member's meeting files", async () => {
    const seen = await seenBy('recorder');
    expect(seen).not.toContain(audioFile[meetings.theirs as string]);
    expect(seen).not.toContain(videoFile[meetings.theirs as string]);
  });
});
