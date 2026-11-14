// SPDX-License-Identifier: AGPL-3.0-only
// The member's minutes webhook (meetings integrations A6, issue #3164, plan section 4.5), pinned before it exists. Step 1 of the two-step plan: every case here passes
// today and bites the moment the feature lands, so the feature's own PR cannot weaken what it must keep.
//
//   - What a body may carry: always an event id, the type `meeting.result_published` (or `ping`), the org, the meeting's id, publish time, date and length; and, only when the member
//     ticked them, the title, the summary, the decisions and the action items (text, owner as said, due date). NEVER the transcript, the audio, the video or an attendee's contact
//     details, whatever a key is called. The only builder is `packages/kernel-contract/src/meeting-hook-body.ts` (`meetingHookEvent`, `meetingHookBody`): a strict object at every level, so an
//     unknown key is refused, and these cases feed it hostile input.
//   - What the tables may hold: `crove_meetings.member_hook` and `crove_meetings.hook_delivery` have no column that could hold a transcript, audio, video or an attendee's
//     contact detail, in the migration that creates them or in any that adds a column later.
//   - What the send path is: its queue (a name that is not `mcp-wake`, since the wake-up's invariants own that name) declares exactly `tenant_url`; the runner calls the shared
//     signing and sending helper of `apps/kernel/src/mcp-wake.ts` and never signs or reaches the network itself, never reads the receiver's answer, and holds no model call:
//     what leaves is what the person approved.
// A case whose feature does not exist yet passes by finding nothing. Once any source or migration names the feature (the tripwire at the start of "the files"), the agreed files,
// queue and shapes are required, so the feature cannot land half-built or under another name and pass vacuously. Part of the invariant suite; it imports package code under test, never helpers from outside
// test/invariant/. Keep this directory self-contained.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QUEUES, queueEgress } from '../../src/jobs-schema.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const BUILDER = 'packages/kernel-contract/src/meeting-hook-body.ts';
const RUNNER = 'apps/kernel/src/meeting-hook.ts';
const SIGNER = 'apps/kernel/src/mcp-wake.ts';
const JOBS = 'apps/kernel/src/jobs-schema.ts';
const SKIP = new Set(['node_modules', 'dist', 'test', 'tests', '.git', '.turbo', 'coverage']);

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name)) walk(path, accept, out);
    } else if (accept(entry.name)) out.push(relative(ROOT, path).replaceAll('\\', '/'));
  }
  return out;
}
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const SOURCES = ['apps', 'packages', 'modules', 'tools'].filter((d) => existsSync(join(ROOT, d))).flatMap((d) => walk(join(ROOT, d), (n) => /\.(ts|tsx|mts|mjs|js)$/.test(n) && !n.endsWith('.d.ts')));
const KERNEL_SRC = SOURCES.filter((f) => f.startsWith('apps/kernel/src/'));
const MIGRATIONS = existsSync(join(ROOT, 'supabase/migrations')) ? walk(join(ROOT, 'supabase/migrations'), (n) => n.endsWith('.sql')) : [];
// A comment is not code: the scans below read what a file does, not what it says it never does.
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const codeOf = (path: string) => code(read(path));
const naming = (files: readonly string[], mark: string) => files.filter((f) => read(f).includes(mark));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The body.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const ID = '0190a3c4-7b2e-7c11-9d4a-5e6f7a8b9c0d';
const META = '0190a3c4-7b2e-7c11-9d4a-5e6f7a8b9c0e';
const ORG = '0190a3c4-7b2e-7c11-9d4a-5e6f7a8b9c0f';
const AT = '2026-11-14T03:00:00.000Z';
const head = { id: ID, type: 'meeting.result_published', created_at: AT, org: ORG };
const result = { meeting_id: META, published_at: AT, started_at: '2026-11-14T02:00:00.000Z', length_seconds: 1800 };

const VALID: Record<string, unknown> = {
  ping: { id: ID, type: 'ping', created_at: AT, org: ORG, data: {} },
  'the always-sent fields': { ...head, data: result },
  'a meeting with no length yet': { ...head, data: { ...result, length_seconds: null } },
  'every field the member may tick': {
    ...head,
    data: {
      ...result,
      title: 'Họp giao ban tuần',
      summary: 'Chốt kế hoạch tháng 12.',
      decisions: ['Tăng ngân sách quảng cáo 10%'],
      action_items: [{ text: 'Gửi báo giá cho khách', owner: 'Lan', due: '2026-11-20' }, { text: 'Kiểm kho', owner: null, due: null }],
    },
  },
};

// Keys and values that must never ride, and the places they are tried: at the top, in `data`, in an action item, and as a value that is no field.
const FORBIDDEN_KEYS = [
  'transcript',
  'transcript_text',
  'segments',
  'audio',
  'audio_url',
  'video',
  'video_url',
  'recording',
  'translation',
  'notes',
  'attendees',
  'attendee_emails',
  'participants',
  'email',
  'phone',
  'contact',
  'recorder_email',
  'user_id',
  'grant',
];
const ITEM_KEYS = ['email', 'phone', 'assignee_email', 'user_id', 'contact', 'transcript_seconds', 'transcript'];

const HOSTILE: Record<string, unknown> = {};
for (const key of FORBIDDEN_KEYS) {
  HOSTILE[`${key} at the top`] = { ...head, [key]: 'x', data: result };
  HOSTILE[`${key} in data`] = { ...head, data: { ...result, [key]: 'someone@example.com' } };
}
for (const key of ITEM_KEYS) HOSTILE[`${key} in an action item`] = { ...head, data: { ...result, action_items: [{ text: 'Việc', owner: null, due: null, [key]: 'x' }] } };
Object.assign(HOSTILE, {
  'an unknown type': { ...head, type: 'meeting.transcript_ready', data: result },
  'the ping with data': { id: ID, type: 'ping', created_at: AT, org: ORG, data: { meeting_id: META } },
  'the result with no meeting id': { ...head, data: { published_at: AT, started_at: result.started_at, length_seconds: 1800 } },
  'an id that is no id': { ...head, id: 'evt_1', data: result },
  'a meeting id that is no id': { ...head, data: { ...result, meeting_id: 'meeting-1' } },
  'a negative length': { ...head, data: { ...result, length_seconds: -1 } },
  'a length as text': { ...head, data: { ...result, length_seconds: '1800' } },
  'an instant that is no instant': { ...head, created_at: 'yesterday', data: result },
  'a summary that is no text': { ...head, data: { ...result, summary: { text: 'x' } } },
  'decisions that are objects': { ...head, data: { ...result, decisions: [{ text: 'x' }] } },
  'an action item that is a bare string': { ...head, data: { ...result, action_items: ['Việc'] } },
  'a due date that is no date': { ...head, data: { ...result, action_items: [{ text: 'Việc', owner: null, due: 'tuần sau' }] } },
  'a title over its limit': { ...head, data: { ...result, title: 'a'.repeat(301) } },
  'a summary over its limit': { ...head, data: { ...result, summary: 'a'.repeat(8001) } },
  'too many decisions': { ...head, data: { ...result, decisions: Array.from({ length: 51 }, () => 'Chốt') } },
  'a decision over its limit': { ...head, data: { ...result, decisions: ['a'.repeat(1001)] } },
  'too many action items': { ...head, data: { ...result, action_items: Array.from({ length: 101 }, () => ({ text: 'Việc', owner: null, due: null })) } },
  'an action item text over its limit': { ...head, data: { ...result, action_items: [{ text: 'a'.repeat(301), owner: null, due: null }] } },
  'an owner over its limit': { ...head, data: { ...result, action_items: [{ text: 'Việc', owner: 'a'.repeat(201), due: null }] } },
  'no data': { ...head },
  'nothing': {},
  'a string': 'meeting.result_published',
  'null': null,
});

// The test-side oracle: the EXACT key set at every level, and the shape of every value (the way mcp-wake.test.ts does with `bodyProblems`). A builder is not trusted to be strict
// about the right things: its output, for any input at all, must pass this, so a builder that whitelists one more key (images, an excerpt, people with a mail, speakers in an item)
// fails here whatever else it refuses. The lists below are the contract; changing one is a new two-step.
const TOP_KEYS = ['id', 'type', 'created_at', 'org', 'data'];
const TYPES = ['meeting.result_published', 'ping'];
const DATA_KEYS = ['meeting_id', 'published_at', 'started_at', 'length_seconds', 'title', 'summary', 'decisions', 'action_items'];
const DATA_REQUIRED = ['meeting_id', 'published_at', 'started_at', 'length_seconds'];
const ITEM_FIELDS = ['text', 'owner', 'due'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textOk = (v: unknown, min: number, max: number) => typeof v === 'string' && v.length >= min && v.length <= max;

function bodyProblems(body: unknown): string[] {
  if (!isObject(body)) return ['not an object'];
  const out: string[] = [];
  for (const k of Object.keys(body)) if (!TOP_KEYS.includes(k)) out.push(`unknown key ${k}`);
  for (const k of TOP_KEYS) if (!(k in body)) out.push(`missing key ${k}`);
  if (typeof body.id !== 'string' || !UUID.test(body.id)) out.push('id');
  if (typeof body.type !== 'string' || !TYPES.includes(body.type)) out.push('type');
  if (typeof body.created_at !== 'string' || !INSTANT.test(body.created_at)) out.push('created_at');
  if (typeof body.org !== 'string' || !UUID.test(body.org)) out.push('org');
  const data = body.data;
  if (!isObject(data)) return [...out, 'data'];
  if (body.type === 'ping') {
    for (const k of Object.keys(data)) out.push(`ping data key ${k}`);
    return out;
  }
  for (const k of Object.keys(data)) if (!DATA_KEYS.includes(k)) out.push(`unknown data key ${k}`);
  for (const k of DATA_REQUIRED) if (!(k in data)) out.push(`missing data key ${k}`);
  if (typeof data.meeting_id !== 'string' || !UUID.test(data.meeting_id)) out.push('meeting_id');
  if (typeof data.published_at !== 'string' || !INSTANT.test(data.published_at)) out.push('published_at');
  if (typeof data.started_at !== 'string' || !INSTANT.test(data.started_at)) out.push('started_at');
  const length = data.length_seconds;
  if (length !== null && !(typeof length === 'number' && Number.isInteger(length) && length >= 0 && length <= 86400)) out.push('length_seconds');
  if ('title' in data && !textOk(data.title, 1, 300)) out.push('title');
  if ('summary' in data && !textOk(data.summary, 1, 8000)) out.push('summary');
  if ('decisions' in data) {
    const d = data.decisions;
    if (!Array.isArray(d) || d.length > 50 || d.some((x) => !textOk(x, 1, 1000))) out.push('decisions');
  }
  if ('action_items' in data) {
    const items = data.action_items;
    if (!Array.isArray(items) || items.length > 100) out.push('action_items');
    else {
      items.forEach((item, i) => {
        if (!isObject(item)) return void out.push(`item ${i}`);
        for (const k of Object.keys(item)) if (!ITEM_FIELDS.includes(k)) out.push(`item ${i}: unknown key ${k}`);
        for (const k of ITEM_FIELDS) if (!(k in item)) out.push(`item ${i}: missing key ${k}`);
        if (!textOk(item.text, 1, 300)) out.push(`item ${i}: text`);
        if (item.owner !== null && !textOk(item.owner, 0, 200)) out.push(`item ${i}: owner`);
        if (item.due !== null && !(typeof item.due === 'string' && DATE.test(item.due))) out.push(`item ${i}: due`);
      });
    }
  }
  return out;
}

// What a builder is tried with besides the cases above: keys a body could carry an image, an attachment, a file, an excerpt of the transcript or a person's contact under, at every level,
// each with a canary value. Whatever the builder does with them, no canary may come out of it and what comes out must pass the oracle.
const CANARY = 'CANARY-7f3a91c2';
const EXTRA_KEYS = [
  'images', 'image', 'image_url', 'attachments', 'attachment', 'files', 'file', 'file_name', 'filename', 'media', 'media_key', 'media_url', 'screenshots', 'thumbnail', 'avatar',
  'excerpt', 'quote', 'quotes', 'highlights', 'snippet', 'speakers', 'speaker', 'people', 'participants', 'mentions', 'owner_email', 'mail', 'emails', 'links', 'url', 'html', 'markdown', 'raw', 'extra', 'meta', 'metadata',
];
const EXTRA: Record<string, unknown> = {};
for (const key of EXTRA_KEYS) {
  EXTRA[`${key} at the top`] = { ...head, [key]: CANARY, data: result };
  EXTRA[`${key} in data`] = { ...head, data: { ...result, [key]: CANARY } };
  EXTRA[`${key} in an action item`] = { ...head, data: { ...result, action_items: [{ text: 'Việc', owner: null, due: null, [key]: CANARY }] } };
  EXTRA[`${key} in the ping data`] = { id: ID, type: 'ping', created_at: AT, org: ORG, data: { [key]: CANARY } };
}
Object.assign(EXTRA, {
  'people with a mail in data': { ...head, data: { ...result, people: [{ name: CANARY, mail: 'someone@example.com' }] } },
  'an image as a base64 value in data': { ...head, data: { ...result, images: [`data:image/png;base64,${CANARY}`] } },
  'speakers in an action item': { ...head, data: { ...result, action_items: [{ text: 'Việc', owner: null, due: null, speakers: [CANARY] }] } },
  'a transcript excerpt as an extra field': { ...head, data: { ...result, excerpt: `${CANARY} lời nói trong cuộc họp` } },
});

// Runs a builder against every input and returns what is wrong with it; empty when it is the builder the invariant wants. A throw is a refusal and always fine for a hostile input;
// an output must pass the oracle, and for the extra-key inputs must carry no canary.
function builderProblems(build: (input: unknown) => string): string[] {
  const out: string[] = [];
  for (const [name, input] of Object.entries(VALID)) {
    let text = '';
    try {
      text = build(input);
    } catch {
      out.push(`${name} is refused`);
      continue;
    }
    if (bodyProblems(JSON.parse(text)).length > 0) out.push(`${name} fails the oracle`);
    if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(input)) out.push(`${name} is not sent as given`);
  }
  for (const [name, input] of [...Object.entries(HOSTILE), ...Object.entries(EXTRA)]) {
    let text: string;
    try {
      text = build(input);
    } catch {
      continue;
    }
    const problems = bodyProblems(JSON.parse(text));
    if (problems.length > 0) out.push(`${name} gets through as a body that fails the oracle (${problems.join(', ')})`);
    if (text.includes(CANARY)) out.push(`${name} carries the canary`);
  }
  return out;
}

describe('a minutes-webhook body', () => {
  it('is built only by the strict builder: it accepts the pinned shapes and refuses everything else', async () => {
    if (!existsSync(join(ROOT, BUILDER))) return;
    const builder = (await import(pathToFileURL(join(ROOT, BUILDER)).href)) as { meetingHookEvent?: (input: unknown) => unknown; meetingHookBody?: (input: unknown) => string };
    expect(typeof builder.meetingHookEvent, `${BUILDER} exports meetingHookEvent`).toBe('function');
    expect(typeof builder.meetingHookBody, `${BUILDER} exports meetingHookBody`).toBe('function');
    for (const [name, input] of Object.entries(VALID)) {
      expect(() => builder.meetingHookEvent?.(input), `${name} is accepted`).not.toThrow();
      const text = builder.meetingHookBody?.(input) ?? '';
      expect(JSON.parse(text), `${name} is sent as it was given`).toEqual(input);
    }
    for (const [name, input] of Object.entries(HOSTILE)) expect(() => builder.meetingHookBody?.(input), `${name} is refused`).toThrow();
    // The exact key set: whatever the builder does with any input, its output passes the oracle's exact lists, and no extra key (an image, an attachment, a file, an excerpt, a person's
    // contact) comes out with its canary. A builder that whitelists one more key fails here even though it refuses every key named above.
    expect(builderProblems((input) => builder.meetingHookBody?.(input) ?? ''), 'the builder is held to the oracle').toEqual([]);
  });

  it('the oracle bites: a builder that lets one more key through, at any level, is found; the strict one is not', () => {
    // A leaky builder: accepts and returns anything.
    expect(builderProblems((input) => JSON.stringify(input)).length, 'an open builder').toBeGreaterThan(0);
    // A builder that is strict except for one key it also lets through, wherever it appears (the oracle's problems for that key alone are ignored).
    const allowing = (key: string) => (input: unknown): string => {
      const others = bodyProblems(input).filter((p) => !new RegExp(`(unknown|ping data|item \\d+: unknown) (data )?key ${key}$`).test(p));
      if (others.length > 0) throw new Error('refused');
      return JSON.stringify(input);
    };
    for (const key of ['images', 'speakers', 'people', 'excerpt', 'attachments', 'mail']) expect(builderProblems(allowing(key)).length, `a builder that also allows ${key}`).toBeGreaterThan(0);
    // A strict builder (the oracle itself) is accepted: it refuses every input with a problem and sends the rest as given.
    const strict = (input: unknown): string => {
      if (bodyProblems(input).length > 0) throw new Error('refused');
      return JSON.stringify(input);
    };
    expect(builderProblems(strict)).toEqual([]);
    // The oracle itself: each exact list refuses one more key and accepts the pinned bodies.
    for (const body of Object.values(VALID)) expect(bodyProblems(body)).toEqual([]);
    expect(bodyProblems({ ...head, images: [], data: result })).not.toEqual([]);
    expect(bodyProblems({ ...head, data: { ...result, people: [] } })).not.toEqual([]);
    expect(bodyProblems({ ...head, data: { ...result, action_items: [{ text: 'a', owner: null, due: null, speakers: [] }] } })).not.toEqual([]);
    expect(bodyProblems({ id: ID, type: 'ping', created_at: AT, org: ORG, data: { images: [] } })).not.toEqual([]);
    expect(bodyProblems({ ...head, type: 'meeting.transcript_ready', data: result })).not.toEqual([]);
  });

  it('is closed by construction: a strict object at every level, nothing open to extra keys', () => {
    if (!existsSync(join(ROOT, BUILDER))) return;
    const text = code(read(BUILDER));
    expect(text, `${BUILDER} builds strict objects`).toMatch(/z\.strictObject\(/);
    expect(text, 'no object lets an extra key through').not.toMatch(/\.passthrough\(|\.catchall\(|\.loose\(|z\.looseObject\(|z\.object\(|z\.record\(|z\.any\(|z\.unknown\(|z\.custom\(/);
    // The builder knows no source of a transcript, audio, video or attendee contact: it takes the fields named above and nothing it could read them from.
    expect(text, 'the builder reads no transcript or attendee table').not.toMatch(/transcript_segment|audio_segment|meeting_video|meeting_reader|attendee/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The tables.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const TABLES = ['member_hook', 'hook_delivery'];
const NEVER_A_COLUMN = /transcript|audio|video|attendee|segment|translation|recording|caption|email|phone|contact|participant/i;

// The columns a piece of SQL gives one of the tables: the lines of its CREATE TABLE, every ADD [COLUMN] and every RENAME [COLUMN] of an ALTER TABLE in any of its spellings (IF EXISTS and ONLY in
// either order, the word COLUMN left out, several clauses in one statement).
const NOT_A_COLUMN = /^(constraint|primary|unique|check|foreign|exclude|column|if)$/i;
function columnsIn(sql: string, table: string): string[] {
  const found: string[] = [];
  const text = sql.replace(/--.*$/gm, '');
  const create = new RegExp(`CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+crove_meetings\\.${table}\\s*\\(([\\s\\S]*?)\\n\\s*\\)\\s*;`, 'gi');
  const alter = new RegExp(`ALTER TABLE(?:\\s+(?:IF EXISTS|ONLY))*\\s+crove_meetings\\.${table}\\b([\\s\\S]*?);`, 'gi');
  for (const match of text.matchAll(create)) {
    for (const line of (match[1] ?? '').split('\n')) {
      const column = /^\s*([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(line)?.[1];
      if (column && !NOT_A_COLUMN.test(column)) found.push(column);
    }
  }
  for (const match of text.matchAll(alter)) {
    const clauses = match[1] ?? '';
    for (const clause of clauses.matchAll(/\bADD\s+(?:COLUMN\s+)?(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) if (clause[1] && !NOT_A_COLUMN.test(clause[1])) found.push(clause[1]);
    for (const clause of clauses.matchAll(/\bRENAME\s+(?:COLUMN\s+)?(?!TO\b)[a-z_][a-z0-9_]*\s+TO\s+([a-z_][a-z0-9_]*)/gi)) if (clause[1]) found.push(clause[1]);
  }
  return found;
}
function columnsOf(table: string): { column: string; file: string }[] {
  return MIGRATIONS.flatMap((file) => columnsIn(read(file), table).map((column) => ({ column, file })));
}

describe('the minutes webhook tables', () => {
  it('have no column that could hold a transcript, audio, video or an attendee contact detail', () => {
    for (const table of TABLES) {
      const columns = columnsOf(table);
      // A migration that names the table must be read as a table: a statement this scan cannot parse (dynamic SQL, an unusual closing) is a failure, never a pass.
      if (naming(MIGRATIONS, `crove_meetings.${table}`).length > 0) expect(columns.map((c) => c.column), `the columns of crove_meetings.${table} are read`).toContain('org_id');
      const bad = columns.filter((c) => NEVER_A_COLUMN.test(c.column));
      expect(bad, `crove_meetings.${table} must not hold such a column`).toEqual([]);
    }
  });

  it('the delivery table checks the body in the database, as the wake-up does: a CHECK that calls a body check function', () => {
    const files = naming(MIGRATIONS, 'crove_meetings.hook_delivery');
    if (files.length === 0) return;
    const sql = files.map((f) => read(f).replace(/--.*$/gm, '')).join('\n');
    expect(sql, 'crove_meetings.hook_delivery carries a CHECK on the body').toMatch(/CHECK\s*\(\s*(crove_meetings\.)?[a-z_]*body_ok\(/i);
  });

  it('the column scan reads every spelling of a planted column', () => {
    const t = 'hook_delivery';
    const cases: Array<[string, string[]]> = [
      ['CREATE TABLE IF NOT EXISTS crove_meetings.hook_delivery (\n  org_id uuid NOT NULL,\n  transcript_text text,\n  PRIMARY KEY (org_id, id)\n);', ['org_id', 'transcript_text']],
      ['ALTER TABLE crove_meetings.hook_delivery ADD COLUMN audio_key text;', ['audio_key']],
      ['ALTER TABLE crove_meetings.hook_delivery ADD audio_key text;', ['audio_key']],
      ['ALTER TABLE crove_meetings.hook_delivery ADD COLUMN IF NOT EXISTS audio_key text;', ['audio_key']],
      ['ALTER TABLE IF EXISTS ONLY crove_meetings.hook_delivery ADD attendee_email text;', ['attendee_email']],
      ['ALTER TABLE ONLY IF EXISTS crove_meetings.hook_delivery ADD attendee_email text;', ['attendee_email']],
      ['ALTER TABLE IF EXISTS crove_meetings.hook_delivery ADD COLUMN a int, ADD b int, ADD COLUMN IF NOT EXISTS c int;', ['a', 'b', 'c']],
      ['ALTER TABLE crove_meetings.hook_delivery RENAME status TO video_state;', ['video_state']],
      ['ALTER TABLE crove_meetings.hook_delivery RENAME COLUMN status TO video_state;', ['video_state']],
      ['ALTER TABLE crove_meetings.hook_delivery ADD CONSTRAINT x CHECK (true);', []],
      ['ALTER TABLE crove_meetings.hook_delivery ADD PRIMARY KEY (org_id, id);', []],
      ['ALTER TABLE crove_meetings.hook_delivery RENAME TO other;', []],
      ['ALTER TABLE crove_meetings.member_hook ADD COLUMN audio_key text;', []],
    ];
    for (const [sql, want] of cases) expect(columnsIn(sql, t), sql).toEqual(want);
  });

  it('the filter itself bites (a planted column is found)', () => {
    for (const name of ['transcript_text', 'audio_key', 'video_file_id', 'attendee_email', 'attendees', 'contact_phone']) expect(NEVER_A_COLUMN.test(name), name).toBe(true);
    for (const name of ['id', 'org_id', 'user_id', 'hook_id', 'meeting_id', 'body', 'url', 'secret_sealed', 'status', 'fields']) expect(NEVER_A_COLUMN.test(name), name).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The files and the send path.
// ---------------------------------------------------------------------------------------------------------------------------------------------

// The feature exists once any source or migration names one of its marks, with the schema in front of a table so an unrelated table of the same name elsewhere is not taken for it (the
// builder's own file names meetingHookBody, so it counts).
const MARKS = ['crove_meetings.member_hook', 'crove_meetings.hook_delivery', 'kernel-meeting-hook', 'meetingHookBody'];
const featureFiles = [...new Set([...MARKS.flatMap((m) => naming(SOURCES, m)), ...MARKS.flatMap((m) => naming(MIGRATIONS, m))])].sort();
const hookQueues: Array<[string, string]> = Object.entries(QUEUES).filter(([, name]) => /meeting-hook/.test(name));
const RUNNERS = KERNEL_SRC.filter((f) => /(^|\/)meeting-hook[^/]*\.ts$/.test(f));

describe('the files of the minutes webhook (#3164)', () => {
  it('has its builder, its runner and its delivery queue at the agreed places once anything names the feature (the tripwire)', () => {
    if (featureFiles.length === 0) return;
    expect(existsSync(join(ROOT, BUILDER)), `${BUILDER} is the only builder of the body (named by ${featureFiles.join(', ')})`).toBe(true);
    expect(existsSync(join(ROOT, RUNNER)), `${RUNNER} is where the delivery runs (named by ${featureFiles.join(', ')})`).toBe(true);
    expect(hookQueues.filter(([, name]) => name === 'kernel-meeting-hook').length, 'a queue named kernel-meeting-hook carries the deliveries').toBe(1);
    if (existsSync(join(ROOT, RUNNER))) {
      const runner = codeOf(RUNNER);
      expect(runner, `${RUNNER} sends through the shared helper of ${SIGNER}`).toMatch(/from\s+['"]\.\/mcp-wake\.ts['"]/);
      expect(runner, `${RUNNER} passes the stored body through the builder before it is sent`).toMatch(/\bmeetingHookBody\(/);
    }
    expect(naming(SOURCES, 'Ludy-Signature').filter((f) => f !== SIGNER), 'the signature header is set by the wake-up delivery file alone').toEqual([]);
  });

  it('declares exactly the tenant URL egress on the delivery queue, and no egress on the sweep queue, and names the queue once', () => {
    for (const [key, name] of hookQueues) {
      expect(name, `${key} is not an mcp-wake queue`).not.toMatch(/mcp-wake/);
      expect(queueEgress(name), key).toEqual(name === 'kernel-meeting-hook' ? ['tenant_url'] : 'none');
    }
    expect(naming(SOURCES, "'kernel-meeting-hook'").filter((f) => f !== JOBS), 'the delivery queue is named in jobs-schema.ts alone').toEqual([]);
  });

  it('never signs, resolves or reaches the network itself, never reads the answer, never logs a body, address or secret, and never calls a model', () => {
    for (const file of RUNNERS) {
      const text = codeOf(file);
      expect(text, `${file} signs and sends only through mcp-wake.ts`).not.toMatch(/createHmac|Ludy-Signature|egressFetch|guardedRequest|guardedFetch|node:https?|node:net|node:dns|\bfetch\(/);
      // The stored body is read once, as `const { body: stored } = delivery;`, the way the wake-up does; it is the receiver's answer that is never looked at.
      expect(text, `${file} reads nothing of the receiver's answer`).not.toMatch(/JSON\.parse|\.json\(|\.text\(|\b(answer|response|res|reply)\.body\b/);
      expect(text, `${file} logs no body, address, payload or secret`).not.toMatch(/console\.[a-z]+\([^;]*\b(body|url|payload|secret|sealed|signature)\b/);
      expect(text, `${file} makes no model call`).not.toMatch(/@crove\/agent|from ['"]ai['"]|@ai-sdk|generateText|generateObject|streamText|member-vy|runAgent/);
      expect(text, `${file} has no test-only hook around the guard`).not.toMatch(/anyPort|hostAllowed|allowPrivate|skipGuard/);
    }
  });

  it('the filters bite (hostile source is found)', () => {
    const signs = /createHmac|Ludy-Signature|egressFetch|guardedRequest|guardedFetch|node:https?|node:net|node:dns|\bfetch\(/;
    for (const line of ["createHmac('sha256', s)", "'Ludy-Signature': x", 'await fetch(url)', "import https from 'node:https'", 'egressFetch({})']) expect(signs.test(line), line).toBe(true);
    const model = /@crove\/agent|from ['"]ai['"]|@ai-sdk|generateText|generateObject|streamText|member-vy|runAgent/;
    for (const line of ["import { x } from '@crove/agent'", `import { generateText } from '${'a'}i'`, 'runAgent(x)']) expect(model.test(line), line).toBe(true);
    const logs = /console\.[a-z]+\([^;]*\b(body|url|payload|secret|sealed|signature)\b/;
    for (const line of ['console.warn(`failed ${url}`)', "console.log('x', delivery.body)"]) expect(logs.test(line), line).toBe(true);
    expect(logs.test("console.warn('[meeting-hook] not delivered', codeOf(error));"), 'a code is not a body').toBe(false);
    // A comment saying what the file never does is not code.
    expect(code("// never createHmac here\nconst a = 1;")).not.toMatch(/createHmac/);
  });
});
