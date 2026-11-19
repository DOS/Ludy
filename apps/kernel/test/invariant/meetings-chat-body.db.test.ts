// SPDX-License-Identifier: AGPL-3.0-only
// What the database lets a queued post to a Slack or Teams channel carry (meetings integrations B4, #3168, owner decision of 2026-11-15 in the Meetings PO's chat): the body the worker reads out
// through chat_post_get is the one thing of `crove_meetings` that returns meeting text besides the minutes webhook's, so its shape is pinned in the database. chat_body_ok accepts the title, the day,
// the summary, the decisions, the action items (title, owner as said, date) and the link back, with exact keys at every level and the limits of the message, and nothing else: no transcript, audio,
// video, image, attachment, excerpt or attendee contact detail has a key to ride in, in the body, in an action item or beside it. Both objects must exist: the first test fails when `crove_meetings.chat_post_body` or `crove_meetings.chat_body_ok(jsonb)` is missing (dropped or renamed), so a later migration cannot make this file pass with zero checks running (#3285; before B4 landed the file tolerated their absence).
// Part of the invariant suite: self-contained, imports nothing
// from outside this directory but the code under test.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const GOOD = {
  v: 1,
  lang: 'vi',
  title: 'Họp giao ban',
  day: '2026-11-13',
  summary: 'Chốt báo giá.',
  decisions: ['Giữ giá cũ'],
  items: [{ title: 'Gửi báo giá', who: 'An', when: 'thứ sáu' }],
  link: 'https://app.example.test/o/acme/meetings/1',
};
// Every key a transcript, audio, video, image, attachment, excerpt or attendee contact detail could ride under.
const SMUGGLERS = ['transcript', 'audio', 'video', 'image', 'images', 'attachment', 'attachments', 'file', 'files', 'excerpt', 'excerpts', 'attendees', 'attendee', 'email', 'emails', 'phone', 'contact', 'contacts', 'lines', 'segments', 'text', 'notes', 'media'];

suite('the body of a queued post to a channel (B4, #3168)', () => {
  const dbName = `crove_test_chat_body_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const ok = async (body: unknown) => (await admin((c) => c.query<{ ok: boolean }>('SELECT crove_meetings.chat_body_ok($1::jsonb) AS ok', [JSON.stringify(body)]))).rows[0]?.ok === true;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
  }, 300_000);

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('has both the body table and its check function, so no later migration can drop one and leave this file running nothing', async () => {
    const found = (await admin((c) => c.query<{ fn: boolean; tbl: boolean }>(`SELECT to_regprocedure('crove_meetings.chat_body_ok(jsonb)') IS NOT NULL AS fn, EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = to_regclass('crove_meetings.chat_post_body') AND relkind = 'r') AS tbl`))).rows[0];
    expect(found, 'crove_meetings.chat_body_ok(jsonb) and crove_meetings.chat_post_body must both exist').toEqual({ fn: true, tbl: true });
  });

  it('accepts exactly the message: title, day, summary, decisions, items and link, and a null link', async () => {
    expect(await ok(GOOD)).toBe(true);
    expect(await ok({ ...GOOD, link: null })).toBe(true);
    expect(await ok({ ...GOOD, lang: 'en', summary: '', decisions: [], items: [] })).toBe(true);
  });

  it('refuses a body with any other key, at the top and in an action item, whatever it is called or holds', async () => {
    for (const key of SMUGGLERS) {
      expect(await ok({ ...GOOD, [key]: 'CANARY' }), `top-level ${key}`).toBe(false);
      expect(await ok({ ...GOOD, [key]: ['CANARY'] }), `top-level ${key} array`).toBe(false);
      expect(await ok({ ...GOOD, items: [{ ...GOOD.items[0], [key]: 'CANARY' }] }), `item ${key}`).toBe(false);
    }
    expect(await ok({ ...GOOD, items: [{ title: 'x', who: 'y' }] }), 'an item without a key').toBe(false);
    const { v: _v, ...noVersion } = GOOD;
    expect(await ok(noVersion), 'a body without a key').toBe(false);
    expect(await ok(null)).toBe(false);
    expect(await ok([GOOD])).toBe(false);
    expect(await ok('text')).toBe(false);
  });

  it('refuses a value of the wrong shape or past a limit', async () => {
    const bad: Array<[string, unknown]> = [
      ['version', { ...GOOD, v: 2 }],
      ['language', { ...GOOD, lang: 'fr' }],
      ['empty title', { ...GOOD, title: '' }],
      ['long title', { ...GOOD, title: 'x'.repeat(201) }],
      ['day', { ...GOOD, day: '13/11/2026' }],
      ['long summary', { ...GOOD, summary: 'x'.repeat(8001) }],
      ['summary not text', { ...GOOD, summary: ['x'] }],
      ['too many decisions', { ...GOOD, decisions: Array.from({ length: 51 }, () => 'x') }],
      ['long decision', { ...GOOD, decisions: ['x'.repeat(501)] }],
      ['decision not text', { ...GOOD, decisions: [{ text: 'x' }] }],
      ['too many items', { ...GOOD, items: Array.from({ length: 101 }, () => GOOD.items[0]) }],
      ['long item title', { ...GOOD, items: [{ ...GOOD.items[0], title: 'x'.repeat(301) }] }],
      ['long owner', { ...GOOD, items: [{ ...GOOD.items[0], who: 'x'.repeat(201) }] }],
      ['long date', { ...GOOD, items: [{ ...GOOD.items[0], when: 'x'.repeat(101) }] }],
      ['item title an object', { ...GOOD, items: [{ ...GOOD.items[0], title: { text: 'x' } }] }],
      ['item title an array', { ...GOOD, items: [{ ...GOOD.items[0], title: ['x'] }] }],
      ['item owner an object', { ...GOOD, items: [{ ...GOOD.items[0], who: { name: 'An' } }] }],
      ['item owner an array', { ...GOOD, items: [{ ...GOOD.items[0], who: ['An'] }] }],
      ['item date an object', { ...GOOD, items: [{ ...GOOD.items[0], when: { text: 'x' } }] }],
      ['item date an array', { ...GOOD, items: [{ ...GOOD.items[0], when: ['x'] }] }],
      ['item not an object', { ...GOOD, items: ['x'] }],
      ['http link', { ...GOOD, link: 'http://app.example.test/x' }],
      ['link with a space', { ...GOOD, link: 'https://app.example.test/x y' }],
      ['long link', { ...GOOD, link: `https://app.example.test/${'x'.repeat(500)}` }],
      ['link not text', { ...GOOD, link: 5 }],
    ];
    for (const [name, body] of bad) expect(await ok(body), name).toBe(false);
  });

  it('is the check of the body table, and the table has a column for nothing else of the meeting', async () => {
    const { rows } = await admin((c) => c.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'crove_meetings' AND table_name = 'chat_post_body' ORDER BY ordinal_position`));
    expect(rows.map((r) => r.column_name)).toEqual(['org_id', 'id', 'post_id', 'body', 'created_at']);
    const checks = await admin((c) =>
      c.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'crove_meetings.chat_post_body'::regclass AND contype = 'c'`),
    );
    expect(checks.rows.map((r) => r.def).join('\n')).toContain('chat_body_ok(body)');
    // The log of a click holds ids, a state, a status, a code and two hashes: no column that could hold the text.
    const post = await admin((c) => c.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'crove_meetings' AND table_name = 'chat_post' ORDER BY ordinal_position`));
    expect(post.rows.map((r) => r.column_name)).toEqual(['org_id', 'id', 'meeting_id', 'channel_id', 'user_id', 'facts_key', 'text_hash', 'state', 'attempts', 'http_status', 'code', 'created_at', 'handed_at', 'sending_at', 'settled_at']);
    // The type of every column, so a column cannot be widened into something that holds text (a jsonb or a long text) without this test saying so; the three text columns that carry words are bounded by a CHECK.
    const types = await admin((c) =>
      c.query<{ column_name: string; data_type: string }>(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'crove_meetings' AND table_name = 'chat_post' ORDER BY ordinal_position`),
    );
    expect(Object.fromEntries(types.rows.map((r) => [r.column_name, r.data_type]))).toEqual({
      org_id: 'uuid',
      id: 'uuid',
      meeting_id: 'uuid',
      channel_id: 'uuid',
      user_id: 'uuid',
      facts_key: 'text',
      text_hash: 'text',
      state: 'text',
      attempts: 'integer',
      http_status: 'smallint',
      code: 'text',
      created_at: 'timestamp with time zone',
      handed_at: 'timestamp with time zone',
      sending_at: 'timestamp with time zone',
      settled_at: 'timestamp with time zone',
    });
    const postChecks = (await admin((c) => c.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'crove_meetings.chat_post'::regclass AND contype = 'c'`))).rows.map((r) => r.def).join('\n');
    expect(postChecks).toContain("facts_key ~ '^[0-9a-f]{64}$'");
    expect(postChecks).toContain("text_hash ~ '^[0-9a-f]{64}$'");
    expect(postChecks).toContain("code ~ '^[A-Z0-9_]{1,64}$'");
  });
});
