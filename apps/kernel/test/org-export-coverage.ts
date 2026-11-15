// SPDX-License-Identifier: AGPL-3.0-only
// Every table of a covered schema (the finance line's, COVERED_SCHEMAS) with an org_id column is in the owner export (EXPORT_TABLES, packages/kernel/src/offboarding.ts)
// or on NOT_EXPORTED with the reason (#3201). EXPORT_TABLES is a hand-kept list, so a table a migration adds would
// otherwise be left out of the owner's copy of their data without anyone noticing. offboarding.db.test.ts reads the catalog of its
// migrated database and fails on such a table; org-export-coverage.test.ts checks the reading and the messages on planted catalogs.
import { EXPORT_TABLES } from '@crove/kernel';

// The schemas the check covers. Each line adds its own once it has decided, table by table, what its owners' copy holds; a table of another
// schema the export does not read is not a failure here (the follow-up issue lists them).
export const COVERED_SCHEMAS: readonly string[] = ['crove_finance'];

// The tables the export leaves out, with why (docs/runbooks/org-offboarding.md says the same in its export list).
export const NOT_EXPORTED: Readonly<Record<string, string>> = {};

const TABLE = /crove_[a-z0-9_]+\.[a-z0-9_]+(?!\w|\()/g;

// Another line adding its schema to COVERED_SCHEMAS also checks how PEOPLE_EXPORT_TABLES (the hr tables an owner reads live) count: they are not in EXPORT_TABLES.
// A table named only inside a subquery's WHERE would count as exported here; none does today.
// The tables the export reads rows of: the tables named in each `from`, without the functions (`crove_notes.private_counts()`),
// which answer counts or filtered rows and are not a table of their own.
export function exportedTables(tables: Readonly<Record<string, { from: string }>> = EXPORT_TABLES): Set<string> {
  const out = new Set<string>();
  for (const { from } of Object.values(tables)) for (const m of from.matchAll(TABLE)) out.add(m[0]);
  return out;
}

export function exportCoverageProblems(catalogTables: readonly string[], exported: ReadonlySet<string>, notExported: Readonly<Record<string, string>> = NOT_EXPORTED): string[] {
  const problems: string[] = [];
  const catalog = new Set(catalogTables.filter((t) => COVERED_SCHEMAS.includes(t.slice(0, t.indexOf('.')))));
  for (const table of [...catalog].sort()) {
    if (exported.has(table) || table in notExported) continue;
    problems.push(
      `${table} has org_id, but the owner export does not contain it: add it to EXPORT_TABLES in packages/kernel/src/offboarding.ts (with the columns to omit) ` +
        'and to the export list of docs/runbooks/org-offboarding.md, or, if it must stay out, add it to NOT_EXPORTED in apps/kernel/test/org-export-coverage.ts with the reason',
    );
  }
  for (const table of Object.keys(notExported).sort()) {
    if (!catalog.has(table)) problems.push(`${table} is on NOT_EXPORTED but is no covered crove_* table with org_id: remove it from NOT_EXPORTED`);
    else if (exported.has(table)) problems.push(`${table} is on NOT_EXPORTED but the export contains it: remove it from NOT_EXPORTED`);
  }
  return problems;
}
