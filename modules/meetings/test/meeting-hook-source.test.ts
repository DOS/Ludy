// SPDX-License-Identifier: AGPL-3.0-only
// What composes a minutes-webhook body reads nothing of the transcript (meetings integrations A6, #3164): the composer (`enqueueMinutesHook` in hook.ts), the builder, the delivery job and the
// migration that makes the tables name no transcript, audio, video, reader, attendee, translation or notes table or column. The composer reads one table, the meeting row (title, start, length);
// the summary, decisions and action items it is handed are what `meetings.result.publish` just published. The invariant pins the body's shape and the tables' columns; this pins the source side,
// so a later change that reads `crove_meetings.transcript_segment` (or a reader list, for attendee contact) for a body is a visible change here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const NAMES = /transcript|audio|video|meeting_reader|attendee|translation|meeting_note|segment/i;
// Code, not commentary: comments and import lines (hook.ts imports a role list from transcript.ts for its own checks) are left out.
const ts = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/\s.*$/gm, '')
    .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
const sql = (text: string) => text.replace(/--.*$/gm, '');

const SOURCES = [
  'modules/meetings/src/hook.ts',
  'packages/kernel-contract/src/meeting-hook-body.ts',
  'packages/kernel-contract/src/meeting-hook.ts',
  'apps/kernel/src/meeting-hook.ts',
  'apps/kernel/src/meeting-hook-sweep.ts',
  'apps/kernel/src/meeting-hook-setup.ts',
];
const MIGRATION = 'supabase/migrations/20261231120000_crove_meetings_member_hook.sql';

describe('the minutes webhook composer reads nothing of the transcript', () => {
  it('names no transcript, audio, video, reader, attendee, translation or notes table or column in its sources or its migration', () => {
    for (const file of SOURCES) expect(ts(read(file)).match(NAMES)?.[0] ?? null, file).toBeNull();
    expect(sql(read(MIGRATION)).match(NAMES)?.[0] ?? null, MIGRATION).toBeNull();
  });

  it('reads one table, the meeting row, and no other tenant table', () => {
    const whole = ts(read('modules/meetings/src/hook.ts'));
    const start = whole.indexOf('export async function enqueueMinutesHook');
    expect(start, 'the composer is in hook.ts').toBeGreaterThan(-1);
    // The composer alone: from its start to the next top-level declaration after it.
    const rest = whole.slice(start + 10);
    const next = rest.search(/\n(?:export |const |function |async function )/);
    const code = next === -1 ? rest : rest.slice(0, next);
    const tables = [...code.matchAll(/(?:selectFrom|innerJoin|leftJoin)\(\s*['"]([a-z_.]+)['"]/g), ...code.matchAll(/\bFROM\s+(crove_[a-z_]+\.[a-z_]+)\s*(?=[\s\n;)`])/gi)].map((m) => m[1] as string);
    // The meeting row (title, start, length) and the hook's own definer functions (named with a call, never a table).
    expect([...new Set(tables)].sort()).toEqual(['crove_meetings.meeting']);
  });

  it('the scan bites: a read of the transcript, a reader list or an attendee contact is found', () => {
    for (const line of ["selectFrom('crove_meetings.transcript_segment')", "FROM crove_meetings.meeting_reader", 'attendee_email', 'audio_key', "selectFrom('crove_meetings.meeting_note')"]) expect(NAMES.test(line), line).toBe(true);
    expect(ts("// reads the transcript\nconst a = 1;")).not.toMatch(NAMES);
    expect(ts("import { ROLES } from './transcript.ts';\nconst a = 1;")).not.toMatch(NAMES);
    expect(ts("const x = await ctx.trx.selectFrom('crove_meetings.transcript_segment').selectAll().execute();")).toMatch(NAMES);
  });
});
