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
// A case whose feature does not exist yet passes by finding nothing. Part of the invariant suite; it imports package code under test, never helpers from outside
// test/invariant/. Keep this directory self-contained.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QUEUES, queueEgress } from '../../src/jobs-schema.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const BUILDER = 'packages/kernel-contract/src/meeting-hook-body.ts';
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
const KERNEL_SRC = walk(join(ROOT, 'apps/kernel/src'), (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'));
const MIGRATIONS = existsSync(join(ROOT, 'supabase/migrations')) ? walk(join(ROOT, 'supabase/migrations'), (n) => n.endsWith('.sql')) : [];
// A comment is not code: the scans below read what a file does, not what it says it never does.
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

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

// The columns a migration gives one of the tables: the lines of its CREATE TABLE and every ADD COLUMN.
function columnsOf(table: string): { column: string; file: string }[] {
  const found: { column: string; file: string }[] = [];
  const create = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? crove_meetings\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, 'gi');
  const add = new RegExp(`ALTER TABLE(?: ONLY)?(?: IF EXISTS)? crove_meetings\\.${table}\\b([\\s\\S]*?);`, 'gi');
  for (const file of MIGRATIONS) {
    const sql = read(file).replace(/--.*$/gm, '');
    for (const match of sql.matchAll(create)) {
      for (const line of (match[1] ?? '').split('\n')) {
        const column = /^\s*([a-z_][a-z0-9_]*)\s+[a-z]/i.exec(line)?.[1];
        if (column && !/^(constraint|primary|unique|check|foreign|exclude)$/i.test(column)) found.push({ column, file });
      }
    }
    for (const match of sql.matchAll(add)) for (const clause of (match[1] ?? '').matchAll(/ADD COLUMN(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi)) if (clause[1]) found.push({ column: clause[1], file });
  }
  return found;
}

describe('the minutes webhook tables', () => {
  it('have no column that could hold a transcript, audio, video or an attendee contact detail', () => {
    for (const table of TABLES) {
      const bad = columnsOf(table).filter((c) => NEVER_A_COLUMN.test(c.column));
      expect(bad, `crove_meetings.${table} must not hold such a column`).toEqual([]);
    }
  });

  it('the filter itself bites (a planted column is found)', () => {
    for (const name of ['transcript_text', 'audio_key', 'video_file_id', 'attendee_email', 'attendees', 'contact_phone']) expect(NEVER_A_COLUMN.test(name), name).toBe(true);
    for (const name of ['id', 'org_id', 'user_id', 'hook_id', 'meeting_id', 'body', 'url', 'secret_sealed', 'status', 'fields']) expect(NEVER_A_COLUMN.test(name), name).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The send path.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const RUNNERS = KERNEL_SRC.filter((f) => /(^|\/)meeting-hook[^/]*\.ts$/.test(f));

describe('the minutes webhook send path', () => {
  it('has its own queue that declares exactly tenant_url, and a name the wake-up invariants do not own', () => {
    const names = Object.values(QUEUES).filter((q) => /meeting-hook/.test(q));
    for (const queue of names) {
      expect(queue, 'a minutes-webhook queue is not an mcp-wake queue').not.toMatch(/mcp-wake/);
      expect([...queueEgress(queue)], `${queue} reaches only the receiver the member set`).toEqual(['tenant_url']);
    }
  });

  it('never signs, resolves or reaches the network itself, never reads the answer, and never calls a model', () => {
    for (const file of RUNNERS) {
      const text = code(read(file));
      expect(text, `${file} signs and sends only through mcp-wake.ts`).not.toMatch(/createHmac|Ludy-Signature|egressFetch|guardedRequest|guardedFetch|node:https?|node:net|node:dns|\bfetch\(/);
      expect(text, `${file} reads nothing of the receiver's answer`).not.toMatch(/JSON\.parse|\.json\(|\.text\(|\.body\b/);
      expect(text, `${file} makes no model call`).not.toMatch(/@crove\/agent|from 'ai'|from "ai"|@ai-sdk|generateText|generateObject|streamText|member-vy|runAgent/);
      expect(text, `${file} has no test-only hook around the guard`).not.toMatch(/anyPort|hostAllowed|allowPrivate|skipGuard/);
    }
  });

  it('the filters bite (hostile source is found)', () => {
    const signs = /createHmac|Ludy-Signature|egressFetch|guardedRequest|guardedFetch|node:https?|node:net|node:dns|\bfetch\(/;
    for (const line of ["createHmac('sha256', s)", "'Ludy-Signature': x", 'await fetch(url)', "import https from 'node:https'", 'egressFetch({})']) expect(signs.test(line), line).toBe(true);
    const model = /@crove\/agent|from 'ai'|from "ai"|@ai-sdk|generateText|generateObject|streamText|member-vy|runAgent/;
    for (const line of ["import { x } from '@crove/agent'", "import { generateText } from 'ai'", 'runAgent(x)']) expect(model.test(line), line).toBe(true);
    // A comment saying what the file never does is not code.
    expect(code("// never createHmac here\nconst a = 1;")).not.toMatch(/createHmac/);
  });
});
