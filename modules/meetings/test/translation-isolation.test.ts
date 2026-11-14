// SPDX-License-Identifier: AGPL-3.0-only
// A machine translation is never a source of anything (meetings integrations E1, #3184): no task, follow-up mail, post, webhook, search hit or export is made from it. The table is
// private to the member who asked and is read by two files of the meetings module only (the member's own query and the sink that keeps it); everything else that names it is the
// schema, the registry or the database's own purge and erasure. A file outside the list that names the table or its commands fails here, so a later change that reads a translation
// for a mail, a task, a post, a hook, the search or an export is a visible change to this list, which only an owner decision moves.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'test' || name === 'tests') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

const SCANNED = [
  ...readdirSync(join(ROOT, 'apps')).map((app) => join(ROOT, 'apps', app, 'src')),
  ...readdirSync(join(ROOT, 'modules')).map((m) => join(ROOT, 'modules', m, 'src')),
  ...readdirSync(join(ROOT, 'packages')).map((p) => join(ROOT, 'packages', p, 'src')),
];
const files = SCANNED.flatMap((dir) => sources(dir)).map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

// The files that may name the table.
const TABLE_READERS = [
  // The member's own query and the sink that keeps a result in the table.
  'modules/meetings/src/translate-run.ts',
  'modules/meetings/src/translate.ts',
  // The manifest, the registry and the database package describe it.
  'modules/meetings/src/manifest.ts',
  'packages/kernel/src/personal-data.ts',
  'packages/db/src/generated/database.ts',
  'packages/db/src/schema.ts',
];
// The files that may name the module's translation commands and queries (the routes and the sink list).
const COMMAND_USERS = [
  'apps/kernel/src/member-vy-ports.ts',
  'apps/kernel/src/rpc.ts',
  'modules/meetings/src/translate-run.ts',
  'modules/meetings/src/translate.ts',
  'packages/kernel/src/member-vy-sinks.ts',
];
const NAMES_TABLE = /crove_meetings\.translation\b|['"`]translation['"`]|\bMeetingsTranslationTable\b/;
const NAMES_COMMAND = /['"`]meetings\.translat(?:e|ion)\./;

describe('a translation is never a source (E1, #3184)', () => {
  it('the scan reads the sources', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.map((f) => f.path)).toEqual(expect.arrayContaining(TABLE_READERS.filter((p) => !p.endsWith('database.ts'))));
  });

  it('no file outside the frozen list names the translation table', () => {
    expect(files.filter((f) => NAMES_TABLE.test(f.text)).map((f) => f.path).filter((p) => !TABLE_READERS.includes(p))).toEqual([]);
  });

  it('no file outside the frozen list runs or reads a translation command or query (no mail, task, post, hook, search or export names one)', () => {
    expect(files.filter((f) => NAMES_COMMAND.test(f.text)).map((f) => f.path).filter((p) => !COMMAND_USERS.includes(p))).toEqual([]);
  });

  it('the follow-up mail, the search, the links, the retention and the result commands do not import the translation files', () => {
    const importers = files.filter((f) => /from\s+['"][^'"]*\/translate(?:-run)?\.ts['"]/.test(f.text)).map((f) => f.path);
    expect(importers.sort()).toEqual(['modules/meetings/src/index.ts', 'modules/meetings/src/meetings.ts', 'modules/meetings/src/translate.ts']);
  });

  // The database side: the follow-up mail's facts, the search across meetings and every definer that reads meeting text name the original rows only. The only migrations that
  // name the table are the one that makes it (with the functions that delete from it) and the org purge's list; a later migration that names it is a visible change here.
  it('no migration but the two that make the table and purge it names it, so no search definer, mail query or export reads it', () => {
    const dir = join(ROOT, 'supabase/migrations');
    const naming = readdirSync(dir)
      .filter((name) => name.endsWith('.sql') && /crove_meetings\.translation\b/.test(readFileSync(join(dir, name), 'utf8')))
      .map((name) => name.replace(/^\d+_/, ''));
    expect(naming).toEqual(['crove_meetings_translation.sql', 'crove_kernel_org_purge_translation.sql']);
  });
});
