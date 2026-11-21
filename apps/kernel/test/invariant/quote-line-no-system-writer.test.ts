// SPDX-License-Identifier: AGPL-3.0-only
// Invariant suite: no system-context code writes a quote line (#4234 item 2, from the independent review of #4233).
// crove_kernel.mcp_origin_keep_line_taint() (20270128520000) skips the whole system actor when it records the taint key of a deleted tainted quote line, so a replacement line inserted in the same transaction
// with the same text stays tainted. That is safe only while the system context deletes lines and never inserts a replacement: the org purge deletes every line of an org and writes none. The insert policy of
// `crove_crm.quote_line` still lets the system in, so the guarantee rests on the code: this file pins it. It fails when
//   - any source outside modules/crm/src/quotes.ts writes `crove_crm.quote_line` (an insert, update or delete in the query builder or in raw SQL), or any migration inserts into or updates it;
//   - a command of quotes.ts that writes lines declares `access: 'system'` (or an access list naming it).
// A change that needs a system writer must first narrow the exemption of the trigger to the org purge, and says so in the PR. No database needed.
// Keep this file self-contained: it reads sources and migrations from disk and imports nothing from outside test/invariant/.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;
const WRITER = 'modules/crm/src/quotes.ts';

const filesUnder = (dir: string, keep: (name: string) => boolean): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === 'node_modules' ? [] : filesUnder(path, keep)) : keep(name) ? [path] : [];
  });
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const rel = (path: string): string => relative(ROOT, path).split(sep).join('/');

// Production sources: the kernel app and every package and module (tests, fixtures and generated types are not code that runs).
const productionSources = (): Array<{ file: string; text: string }> => {
  const dirs = ['apps/kernel/src'];
  for (const group of ['packages', 'modules']) {
    for (const name of readdirSync(join(ROOT, group))) {
      if (statSync(join(ROOT, group, name, 'src'), { throwIfNoEntry: false })?.isDirectory()) dirs.push(`${group}/${name}/src`);
    }
  }
  return dirs
    .flatMap((dir) => filesUnder(join(ROOT, dir), (name) => SOURCE_FILE.test(name) && !name.endsWith('.d.ts')))
    .map((path) => ({ file: rel(path), text: read(path) }))
    .filter((f) => !f.file.includes('/generated/'));
};

// A write to the lines: the query builder's insertInto, updateTable and deleteFrom naming the table, and raw SQL (any spacing and case, with or without the schema).
const TABLE = String.raw`(?:crove_crm\s*\.\s*)?"?quote_line"?`;
const BUILDER_WRITE = new RegExp(String.raw`\.\s*(?:insertInto|updateTable|deleteFrom)\s*\(\s*['"\x60](?:crove_crm\s*\.\s*)?quote_line['"\x60]`, 'i');
const SQL_WRITE = new RegExp(String.raw`\b(?:insert\s+into|update|delete\s+from)\s+(?:only\s+)?${TABLE}\b`, 'i');
const writes = (text: string): boolean => BUILDER_WRITE.test(text) || SQL_WRITE.test(text);
// Code that reaches the table without naming it in one expression (a table name held in a variable, a generic helper) cannot be read here; the literal name is what the guard pins.

describe('no system-context code writes a quote line (the taint-key exemption of mcp_origin_keep_line_taint rests on it, #4234)', () => {
  it('the only production source that writes the lines is the CRM quote commands', () => {
    const writers = productionSources().filter((f) => writes(f.text)).map((f) => f.file);
    expect(writers).toEqual([WRITER]);
  });

  it('no migration inserts into or updates the lines (a definer would run as the system); deleting them is the org purge', () => {
    const migrations = filesUnder(join(ROOT, 'supabase/migrations'), (name) => name.endsWith('.sql'));
    const stripped = (sql: string): string => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const offenders = migrations
      .filter((path) => {
        const text = stripped(read(path));
        return new RegExp(String.raw`\b(?:insert\s+into|update)\s+(?:only\s+)?${TABLE}\b`, 'i').test(text);
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('every command of the quote writer that writes lines is reachable by people only, never `access: \'system\'`', () => {
    const text = read(join(ROOT, WRITER));
    // A block runs from one top-level declaration to the next, so a helper is not read as part of the command before it.
    const blocks = text.split(/^(?=(?:export )?(?:async )?(?:const|function) )/m).filter((b) => /^export const \w+ = define(?:Command|Query)\(/.test(b));
    const writing = blocks.filter((b) => /\binsertLines\(/.test(b) || writes(b));
    // The save (insert and replace the lines) and the revision (copies them) are the ones that write.
    expect(writing.map((b) => /^export const (\w+)/.exec(b)?.[1]).sort()).toEqual(['quoteRevise', 'quoteSave']);
    for (const block of writing) {
      const name = /^export const (\w+)/.exec(block)?.[1];
      const access = /\baccess:\s*([^,\n]+)/.exec(block)?.[1] ?? '';
      expect(access, `${name} declares an access`).not.toBe('');
      expect(access, `${name} must not be reachable by the system context`).not.toMatch(/system/i);
    }
    // The helper that inserts lines is called only from those commands: it is not exported, so nothing else can reach it.
    expect(/export\s+(?:async\s+)?function\s+insertLines|export\s*\{[^}]*\binsertLines\b/.test(text)).toBe(false);
  });
});
