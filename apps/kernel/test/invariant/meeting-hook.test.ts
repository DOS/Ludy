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

// The columns a migration gives one of the tables: the lines of its CREATE TABLE, every ADD COLUMN and every RENAME COLUMN.
function columnsOf(table: string): { column: string; file: string }[] {
  const found: { column: string; file: string }[] = [];
  const create = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? crove_meetings\\.${table}\\s*\\(([\\s\\S]*?)\\n\\s*\\)\\s*;`, 'gi');
  const alter = new RegExp(`ALTER TABLE(?: ONLY)?(?: IF EXISTS)? crove_meetings\\.${table}\\b([\\s\\S]*?);`, 'gi');
  for (const file of MIGRATIONS) {
    const sql = read(file).replace(/--.*$/gm, '');
    for (const match of sql.matchAll(create)) {
      for (const line of (match[1] ?? '').split('\n')) {
        const column = /^\s*([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(line)?.[1];
        if (column && !/^(constraint|primary|unique|check|foreign|exclude)$/i.test(column)) found.push({ column, file });
      }
    }
    for (const match of sql.matchAll(alter)) {
      for (const clause of (match[1] ?? '').matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) if (clause[1]) found.push({ column: clause[1], file });
      for (const clause of (match[1] ?? '').matchAll(/RENAME COLUMN\s+[a-z_][a-z0-9_]*\s+TO\s+([a-z_][a-z0-9_]*)/gi)) if (clause[1]) found.push({ column: clause[1], file });
    }
  }
  return found;
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

  it('the filter itself bites (a planted column is found)', () => {
    for (const name of ['transcript_text', 'audio_key', 'video_file_id', 'attendee_email', 'attendees', 'contact_phone']) expect(NEVER_A_COLUMN.test(name), name).toBe(true);
    for (const name of ['id', 'org_id', 'user_id', 'hook_id', 'meeting_id', 'body', 'url', 'secret_sealed', 'status', 'fields']) expect(NEVER_A_COLUMN.test(name), name).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The files and the send path.
// ---------------------------------------------------------------------------------------------------------------------------------------------

// The feature exists once any source or migration names one of its marks (the builder's own file names meetingHookBody, so it counts).
const MARKS = ['member_hook', 'hook_delivery', 'kernel-meeting-hook', 'meetingHookBody'];
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
