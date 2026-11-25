// SPDX-License-Identifier: AGPL-3.0-only
// The second-language version of a meeting's published minutes (#4777) on a real database: only the recorder publishes it, with the text they reviewed, held to the published original it was
// made from (its hash, its segments, no figure or contact the original lacks); every reader of the meeting reads it and a member who is not a reader does not; a republish replaces it; and it
// never outlives the original (a new publish, an edit of the text, an unpublish, the meeting's delete) so redaction and retention apply to both versions. No word of either text reaches the audit trail.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { MinutesVersions, TranslationSource } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries, versionTextProblem } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SUMMARY = 'Chốt báo giá 1.250.000 cho khách A trong tuần này.';
const DECISION = 'Giữ giá cũ cho khách A';
const ITEM = 'Gửi báo giá cho khách A';
const EN_SUMMARY = 'Quote of 1,250,000 agreed for customer A this week.';
const EN_DECISION = 'Keep the old price for customer A';

suite('the second-language version of the published minutes (#4777)', () => {
  const dbName = `ludy_test_minutes_version_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users: Record<string, string> = {};
  const asUser = (who: string) => ({ type: 'user' as const, userId: users[who] as string, aal: 'aal1' as const });
  const exec = <O = unknown>(who: string, name: string, input: unknown) => runtime.execute<O>(name, input, { actor: asUser(who), orgId });
  const query = <O = unknown>(who: string, name: string, input: unknown = {}) => runtime.query<O>(name, input, { actor: asUser(who), orgId });
  const refuses = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as { code?: string }).code ?? 'ERR');
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
  const stored = async (meetingId: string) => (await sqlAdmin<{ language: string }>('SELECT language FROM ludy_meetings.minutes_version WHERE org_id = $1 AND meeting_id = $2 ORDER BY language', [orgId, meetingId])).rows.map((r) => r.language);

  // A Vietnamese meeting of the recorder with the attendee as a reader (the outsider is a member who is not), its summary, one decision and one item published.
  async function seedPublished(): Promise<string> {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Họp tuần', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.recorder],
    );
    await sqlAdmin('INSERT INTO ludy_meetings.meeting_reader (org_id, id, meeting_id, user_id) VALUES ($1, $2, $3, $4)', [orgId, randomUUID(), meetingId, users.attendee]);
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: SUMMARY, decisions: [DECISION] });
    await exec('recorder', 'meetings.action_item.create', { meetingId, title: ITEM, who: 'Hà', whoUserId: null, when: '', whenDate: null, transcriptSeconds: 5 });
    await exec('recorder', 'meetings.result.publish', { meetingId, confirmed: true });
    return meetingId;
  }
  const source = (meetingId: string) => query<TranslationSource>('recorder', 'meetings.translation.source', { meetingId, stage: 'published', to: 'en' });
  const publish = async (meetingId: string, over: { hash?: string; segments?: Array<{ key: string; text: string }>; who?: string } = {}) => {
    const src = await source(meetingId);
    const summary = src.segments.find((s) => s.key === 'summary') as { key: string };
    const decision = src.segments.find((s) => s.key.startsWith('decision:')) as { key: string };
    return exec(over.who ?? 'recorder', 'meetings.minutes_version.publish', {
      meetingId,
      language: 'en',
      hash: over.hash ?? src.hash,
      segments: over.segments ?? [
        { key: summary.key, text: EN_SUMMARY },
        { key: decision.key, text: EN_DECISION },
      ],
    });
  };

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    runtime = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...meetingsCommands], queries: [...kernelQueries({ inboundDomain: null }), ...meetingsQueries] });
    for (const key of ['owner', 'recorder', 'attendee', 'outsider']) users[key] = await upsertIdentity(createDb(pool), { issuer: 'minutes-version', subject: key, email: `${key}@minutes-version.test`, name: key });
    orgId = (await createOrg(runtime, asUser('owner'), 'Công ty Song ngữ')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.recorder, users.attendee, users.outsider]);
  }, 300_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('the recorder publishes the reviewed text; a reader reads it beside the original and a member who is not a reader finds nothing', async () => {
    const meetingId = await seedPublished();
    expect(await publish(meetingId)).toEqual({ meetingId, language: 'en', segments: 2 });
    expect(await stored(meetingId)).toEqual(['en']);
    const read = await query<MinutesVersions>('attendee', 'meetings.minutes_version.get', { meetingId });
    expect(read).toMatchObject({ meetingId, from: 'vi' });
    expect(read.versions).toHaveLength(1);
    expect(read.versions[0]?.segments.map((s) => s.text)).toEqual([EN_SUMMARY, EN_DECISION]);
    expect((await query<MinutesVersions>('recorder', 'meetings.minutes_version.get', { meetingId })).versions).toHaveLength(1);
    expect(await refuses(query('outsider', 'meetings.minutes_version.get', { meetingId }))).not.toBeNull();
  });

  it('only the recorder publishes or takes down; a reader is refused', async () => {
    const meetingId = await seedPublished();
    expect(await refuses(publish(meetingId, { who: 'attendee' }))).toBe('FORBIDDEN');
    expect(await refuses(publish(meetingId, { who: 'outsider' }))).not.toBeNull();
    expect(await stored(meetingId)).toEqual([]);
    await publish(meetingId);
    expect(await refuses(exec('attendee', 'meetings.minutes_version.unpublish', { meetingId, language: 'en' }))).toBe('FORBIDDEN');
    expect(await stored(meetingId)).toEqual(['en']);
    expect(await exec('recorder', 'meetings.minutes_version.unpublish', { meetingId, language: 'en' })).toEqual({ meetingId, language: 'en', removed: true });
    expect(await exec('recorder', 'meetings.minutes_version.unpublish', { meetingId, language: 'en' })).toMatchObject({ removed: false });
    expect(await stored(meetingId)).toEqual([]);
  });

  it('holds the text to the published original: a stale hash, a foreign or repeated segment, an invented figure or a contact are refused', async () => {
    const meetingId = await seedPublished();
    const src = await source(meetingId);
    const key = (src.segments.find((s) => s.key === 'summary') as { key: string }).key;
    expect(await refuses(publish(meetingId, { hash: 'a'.repeat(64) }))).toBe('MINUTES_VERSION_STALE');
    expect(await refuses(publish(meetingId, { segments: [{ key: `item:${randomUUID()}`, text: 'Send the quote' }] }))).toBe('MINUTES_VERSION_SEGMENTS_INVALID');
    expect(await refuses(publish(meetingId, { segments: [{ key, text: EN_SUMMARY }, { key, text: EN_SUMMARY }] }))).toBe('MINUTES_VERSION_SEGMENTS_INVALID');
    expect(await refuses(publish(meetingId, { segments: [{ key, text: 'Quote of 9,990,000 agreed for customer A.' }] }))).toBe('MINUTES_VERSION_TEXT_REJECTED');
    expect(await refuses(publish(meetingId, { segments: [{ key, text: `${EN_SUMMARY} Write to a@evil.example` }] }))).toBe('MINUTES_VERSION_TEXT_REJECTED');
    expect(await refuses(publish(meetingId, { segments: [{ key, text: `${EN_SUMMARY} See https://evil.example` }] }))).toBe('MINUTES_VERSION_TEXT_REJECTED');
    expect(await refuses(publish(meetingId, { segments: [] }))).not.toBeNull();
    expect(await stored(meetingId)).toEqual([]);
  });

  it('refuses a meeting whose minutes are not published, and a draft is never what a version sits beside', async () => {
    const meetingId = randomUUID();
    await sqlAdmin(
      `INSERT INTO ludy_meetings.meeting (org_id, id, title, language, started_at, ended_at, length_seconds, recorder_user_id, visibility, status, consent_method, consent_confirmed_by, consent_confirmed_at, consent_notice_version, audio_retention_date, text_retention_date)
       VALUES ($1, $2, 'Chưa chia sẻ', 'vi', now(), now() + interval '30 minutes', 1800, $3, 'attendees', 'ready', 'told_at_start', $3, now(), '1.0', current_date + 30, current_date + 365)`,
      [orgId, meetingId, users.recorder],
    );
    await exec('recorder', 'meetings.summary.save', { meetingId, summary: SUMMARY, decisions: [] });
    expect(await refuses(exec('recorder', 'meetings.minutes_version.publish', { meetingId, language: 'en', hash: 'b'.repeat(64), segments: [{ key: 'summary', text: EN_SUMMARY }] }))).toBe('MINUTES_NOT_PUBLISHED');
  });

  it('a second publish of a language replaces the first', async () => {
    const meetingId = await seedPublished();
    await publish(meetingId);
    const src = await source(meetingId);
    const key = (src.segments.find((s) => s.key === 'summary') as { key: string }).key;
    await publish(meetingId, { segments: [{ key, text: 'Quote of 1,250,000 confirmed for customer A.' }] });
    const read = await query<MinutesVersions>('attendee', 'meetings.minutes_version.get', { meetingId });
    expect(read.versions).toHaveLength(1);
    expect(read.versions[0]?.segments.map((s) => s.text)).toEqual(['Quote of 1,250,000 confirmed for customer A.']);
  });

  it('never outlives the original: a new publish, an edit of the text, a changed item title and the meeting\'s delete drop it', async () => {
    // A new draft published over the shared summary.
    const replaced = await seedPublished();
    await publish(replaced);
    await exec('recorder', 'meetings.summary.save', { meetingId: replaced, summary: 'Bản mới: báo giá 1.300.000.', decisions: [] });
    expect(await stored(replaced)).toEqual(['en']);
    await exec('recorder', 'meetings.result.publish', { meetingId: replaced, confirmed: true });
    expect(await stored(replaced)).toEqual([]);
    // A redaction in place (what the erasure of a person's data does) changes the summary text of the published row.
    const edited = await seedPublished();
    await publish(edited);
    await sqlAdmin(`UPDATE ludy_meetings.meeting_result SET summary = 'Đã xóa theo yêu cầu' WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, edited]);
    expect(await stored(edited)).toEqual([]);
    // The title of a shared item.
    const titled = await seedPublished();
    await publish(titled);
    await sqlAdmin(`UPDATE ludy_meetings.action_item SET title = 'Đã xóa theo yêu cầu' WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, titled]);
    expect(await stored(titled)).toEqual([]);
    // Something that is not text (the taint) says nothing of the translated words and drops nothing.
    const kept = await seedPublished();
    await publish(kept);
    await sqlAdmin(`UPDATE ludy_meetings.meeting_result SET updated_at = now() WHERE org_id = $1 AND meeting_id = $2 AND stage = 'published'`, [orgId, kept]);
    expect(await stored(kept)).toEqual(['en']);
    // The meeting's own delete reaches it by the foreign key.
    await sqlAdmin('DELETE FROM ludy_meetings.meeting WHERE org_id = $1 AND id = $2', [orgId, kept]);
    expect(await stored(kept)).toEqual([]);
  });

  // The erasure finds a person in the original's rows only (a version is dropped with the original's redaction, never read): so a text may be accepted as a version only if every value the database's own
  // matching (ludy_kernel.text_mentions, the finder's and the erasure's one) finds in it is found in the original too. The code check (versionTextProblem) is held to that here, on the real function.
  // One deliberate exception, not in the table: a large amount the original writes with commas (1,250,000,000) and the version with dots or spaces (1.250.000.000). The database reads dots and spaces as the separators of
  // a number and commas not, so it finds those digits only in the version; but they are the original's own digits, so the version holds nothing the original does not, and refusing it would refuse every
  // English amount of 100 million or more that a Vietnamese reader writes with dots.
  it('what the personal-data matching finds in an accepted version it finds in the original; what it finds only in the version is refused', async () => {
    type Probe = { kind: 'digits' | 'email'; value: string };
    const cases: Array<{ original: string; version: string; probes: Probe[]; accepted: boolean }> = [
      { original: 'Gọi (028) 3829 1234', version: 'Call 028 3829 1234', probes: [{ kind: 'digits', value: '38291234' }, { kind: 'digits', value: '02838291234' }], accepted: true },
      // Brackets around the area code make a sub-number (3829-1234) that a single space after a bracket does not glue to the digits before.
      { original: 'Gọi 028 3829 1234', version: 'Call (028) 3829-1234', probes: [{ kind: 'digits', value: '38291234' }], accepted: false },
      // A longer number written beside a shorter one: two separators, a line break or a tab part them for the pattern.
      { original: 'Ref 09123456789. Items 912, 345, 678, 9.', version: 'Ref 0912 345 678  9.', probes: [{ kind: 'digits', value: '0912345678' }], accepted: false },
      { original: 'Ref 09123456789. Items 912, 345, 678, 9.', version: 'Ref 0912 345 678\n9.', probes: [{ kind: 'digits', value: '0912345678' }], accepted: false },
      { original: 'Gửi tới alice@example.com', version: 'Send to <Alice@Example.com>, please', probes: [{ kind: 'email', value: 'alice@example.com' }], accepted: true },
      { original: 'Mã 028, 382 và 9123', version: 'Call (028) 382-9123', probes: [{ kind: 'digits', value: '0283829123' }], accepted: false },
      { original: 'Mã 0912, 345 và 678', version: 'Call 0912 345 678', probes: [{ kind: 'digits', value: '0912345678' }], accepted: false },
      { original: 'Mã 0912, 345 và 678', version: 'Call 0912\r\n345\r\n678', probes: [{ kind: 'digits', value: '0912345678' }], accepted: false },
      { original: 'Số 1234567', version: 'Account 01234567', probes: [{ kind: 'digits', value: '01234567' }], accepted: false },
      { original: 'Gửi tới alice@example.com', version: 'Send to _alice@example.com', probes: [{ kind: 'email', value: '_alice@example.com' }, { kind: 'email', value: 'alice@example.com' }], accepted: false },
      { original: 'Gửi tới alice@example.com', version: "Send to o'alice@example.com", probes: [{ kind: 'email', value: "o'alice@example.com" }], accepted: false },
    ];
    for (const { original, version, probes, accepted } of cases) {
      const problem = versionTextProblem(original, version);
      let onlyInVersion = false;
      for (const probe of probes) {
        const { rows } = await sqlAdmin<{ inVersion: boolean; inOriginal: boolean }>(
          'SELECT ludy_kernel.text_mentions($1, $3, $4) AS "inVersion", ludy_kernel.text_mentions($2, $3, $4) AS "inOriginal"',
          [version, original, probe.kind, probe.value],
        );
        if (rows[0]?.inVersion === true && rows[0].inOriginal === false) onlyInVersion = true;
      }
      // Accepted: nothing is found only in the version. Refused: the case is one where the database finds a value only in the version, and the code refuses it.
      if (accepted) {
        expect(problem, `${original} | ${version}`).toBeNull();
        expect(onlyInVersion, `${original} | ${version}`).toBe(false);
      } else {
        expect(problem, `${original} | ${version}`).not.toBeNull();
        expect(onlyInVersion, `${original} | ${version}`).toBe(true);
      }
    }
  });

  it('the table has no UPDATE for the tenant role (a replacement is a delete and an insert)', async () => {
    const privilege = await sqlAdmin<{ ok: boolean }>(`SELECT pg_catalog.has_table_privilege('ludy_tenant', 'ludy_meetings.minutes_version', 'UPDATE') AS ok`);
    expect(privilege.rows[0]?.ok).toBe(false);
  });

  it('leaves no word of either text in the audit trail', async () => {
    const meetingId = await seedPublished();
    await publish(meetingId);
    await exec('recorder', 'meetings.minutes_version.unpublish', { meetingId, language: 'en' });
    await query('attendee', 'meetings.minutes_version.get', { meetingId }).catch(() => undefined);
    const audit = await sqlAdmin<{ detail: unknown }>(`SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command LIKE 'meetings.minutes_version.%'`, [orgId]);
    expect(audit.rows.length).toBeGreaterThan(0);
    const all = JSON.stringify(audit.rows);
    for (const text of [EN_SUMMARY, EN_DECISION, SUMMARY, DECISION, ITEM]) expect(all).not.toContain(text);
  });
});
