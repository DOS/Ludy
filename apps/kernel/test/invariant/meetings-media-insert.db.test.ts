// SPDX-License-Identifier: AGPL-3.0-only
// A recorder links only the media files they created (#2878, ADR-0047): the insert policies of audio_segment and meeting_video ask that the linked file row has the
// matching source (meeting_audio for a segment, meeting_video for a video) and was created by the caller. Another member's file id, a file of the wrong kind, an
// ordinary upload, an unknown id and a file of another org are refused (42501); the recorder's own file is accepted. Part of the invariant suite; it imports package code under test, never
// helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { contextToken } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('a recorder links only the media files they created (#2878)', () => {
  const dbName = `crove_test_meetings_media_insert_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let otherOrgId = '';
  const users = { owner: '', recorder: '', other: '', stranger: '' };
  const meetingId = randomUUID();
  const files = { ownAudio: randomUUID(), ownVideo: randomUUID(), othersAudio: randomUUID(), othersVideo: randomUUID(), plain: randomUUID(), otherOrgAudio: randomUUID(), otherOrgVideo: randomUUID() };

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // Runs sql as the recorder (a member, on the app login), always rolled back; answers 'ok' or the SQLSTATE.
  async function asRecorder(text: string, values: unknown[]): Promise<string> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users.recorder, orgId)]);
      await c.query(text, values);
      return 'ok';
    } catch (error) {
      return (error as { code?: string }).code ?? 'error';
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const segment = (file: string) =>
    asRecorder(
      `INSERT INTO crove_meetings.audio_segment (org_id, id, meeting_id, file_id, segment_order, start_offset_seconds, length_seconds) VALUES ($1, $2, $3, $4, 0, 0, 60)`,
      [orgId, randomUUID(), meetingId, file],
    );
  const video = (file: string) =>
    asRecorder(`INSERT INTO crove_meetings.meeting_video (org_id, id, meeting_id, file_id, length_seconds, video_retention_date) VALUES ($1, $2, $3, $4, 60, current_date + 7)`, [
      orgId,
      randomUUID(),
      meetingId,
      file,
    ]);

  beforeAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });
    const login = new URL(adminUrl);
    login.username = 'crove_app';
    login.password = 'test-app-pw';
    appUrl = login.toString();
    const pool = createPool({ connectionString: appUrl, max: 3 });
    pools.push(pool);
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'meetings-media-insert', subject: key, email: `${key}@meetings-media-insert.test`, name: null });
    }
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Chèn tệp cuộc họp')).orgId;
    otherOrgId = (await createOrg(runtime, { type: 'user', userId: users.stranger, aal: 'aal1' }, 'Công ty khác')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, users.recorder, users.other]);
      await c.query(
        `INSERT INTO crove_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
         VALUES ($1, $2, 'Họp', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
        [orgId, meetingId, users.recorder],
      );
      const file = async (id: string, source: string, createdBy: string, inOrg: string = orgId) => {
        const sha256 = id.replaceAll('-', '').padEnd(64, '0');
        await c.query(
          `INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source, created_by)
           VALUES ($1, $2, $3, $4, 'f.bin', 'application/octet-stream', 1, $5, $6)`,
          [inOrg, id, sha256, `org/${inOrg}/${sha256}`, source, createdBy],
        );
      };
      await file(files.ownAudio, 'meeting_audio', users.recorder);
      await file(files.ownVideo, 'meeting_video', users.recorder);
      await file(files.othersAudio, 'meeting_audio', users.other);
      await file(files.othersVideo, 'meeting_video', users.other);
      await file(files.plain, 'upload', users.recorder);
      // Files of another org, created by the same user id (a member of both orgs, as a person may be): still no link across orgs.
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [otherOrgId, users.recorder]);
      await file(files.otherOrgAudio, 'meeting_audio', users.recorder, otherOrgId);
      await file(files.otherOrgVideo, 'meeting_video', users.recorder, otherOrgId);
    });
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('accepts a segment of the recorder\'s own audio file and a video row of their own video file', async () => {
    expect(await segment(files.ownAudio)).toBe('ok');
    expect(await video(files.ownVideo)).toBe('ok');
  });

  it("refuses another member's file, a file of the wrong kind, an ordinary upload, an unknown id and another org's file", async () => {
    expect(await segment(files.othersAudio), "another member's audio").toBe('42501');
    expect(await video(files.othersVideo), "another member's video").toBe('42501');
    expect(await segment(files.ownVideo), 'own video file in a segment').toBe('42501');
    expect(await video(files.ownAudio), 'own audio file in a video row').toBe('42501');
    expect(await segment(files.plain), 'an ordinary upload in a segment').toBe('42501');
    expect(await video(files.plain), 'an ordinary upload in a video row').toBe('42501');
    expect(await segment(randomUUID()), 'unknown id').toBe('42501');
    expect(await video(randomUUID()), 'unknown id').toBe('42501');
    expect(await segment(files.otherOrgAudio), "another org's audio file").toBe('42501');
    expect(await video(files.otherOrgVideo), "another org's video file").toBe('42501');
  });
  it('pins the helper\'s grants: the tenant role and its members may execute it, PUBLIC may not', async () => {
    const fn = 'crove_meetings.is_own_meeting_media_file(uuid,uuid,text)';
    const { rows } = await admin(async (c) =>
      c.query<{ role: string; ok: boolean }>(
        `SELECT r AS role, has_function_privilege(r, $1::regprocedure, 'EXECUTE') AS ok FROM unnest(ARRAY['crove_tenant', 'crove_app', 'crove_worker']) AS r`,
        [fn],
      ),
    );
    expect(Object.fromEntries(rows.map((r) => [r.role, r.ok]))).toEqual({ crove_tenant: true, crove_app: true, crove_worker: true });
    const { rows: pub } = await admin(async (c) => c.query<{ ok: boolean }>(`SELECT has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS ok`, [fn]));
    expect(pub[0]?.ok).toBe(false);
    const { rows: def } = await admin(async (c) =>
      c.query<{ definer: boolean; config: string[] }>('SELECT prosecdef AS definer, proconfig AS config FROM pg_proc WHERE oid = $1::regprocedure', [fn]),
    );
    expect(def[0]?.definer).toBe(true);
    expect(def[0]?.config).toContain('search_path=pg_catalog, pg_temp');
  });
});
