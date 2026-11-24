// SPDX-License-Identifier: AGPL-3.0-only
// The reading behind the coverage check of offboarding.db.test.ts (#3201), without a database: which tables the export reads, and the messages on planted catalogs.
import { describe, expect, it } from 'vitest';
import { EXPORT_TABLES } from '@ludy/kernel';
import { COVERED_SCHEMAS, exportCoverageProblems, exportedTables, omitProblems } from './org-export-coverage.ts';

describe('the tables the owner export contains (#3201)', () => {
  it('reads the table of each entry, the table inside a subquery, and no function', () => {
    const exported = exportedTables({
      a: { from: 'crove_a.plain' },
      b: { from: "(SELECT f.* FROM crove_a.filtered f WHERE f.source NOT IN ('x'))" },
      c: { from: 'crove_a.counts()' },
    }, {});
    expect([...exported].sort()).toEqual(['crove_a.filtered', 'crove_a.plain']);
  });

  it('counts the owner-run tables as exported too, by their own map', () => {
    const exported = exportedTables({ a: { from: 'crove_a.plain' } }, { b: { from: 'ludy_hr.owner_run' } });
    expect([...exported].sort()).toEqual(['crove_a.plain', 'ludy_hr.owner_run']);
    expect(exportedTables().has('ludy_hr.payroll_employee')).toBe(true);
  });

  it('reads the real list: the household profile and the ledger are in, a machinery table is not', () => {
    const exported = exportedTables();
    expect(exported.has('ludy_finance.household_profile')).toBe(true);
    expect(exported.has('ludy_finance.journal_line')).toBe(true);
    expect(exported.has('ludy_kernel.idempotency_key')).toBe(false);
    expect(Object.keys(EXPORT_TABLES).length).toBeGreaterThan(60);
  });
});

describe('export coverage problems (#3201)', () => {
  const exported = new Set(['ludy_finance.journal_line', 'ludy_finance.household_profile']);

  it('passes when every table is exported or named with a reason', () => {
    expect(exportCoverageProblems(['ludy_finance.journal_line', 'ludy_finance.legacy'], exported, { 'ludy_finance.legacy': 'a reason' })).toEqual([]);
  });

  it('names a planted table nobody listed, and says where to add it', () => {
    const problems = exportCoverageProblems(['ludy_finance.journal_line', 'ludy_finance.planted'], exported, {});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^ludy_finance\.planted has org_id, but the owner export does not contain it: add it to EXPORT_TABLES/);
  });

  it('fails a table on NOT_EXPORTED that is gone from the catalog or is exported after all', () => {
    expect(exportCoverageProblems(['ludy_finance.journal_line'], exported, { 'ludy_finance.gone': 'x' })).toEqual([
      'ludy_finance.gone is on NOT_EXPORTED but is no covered crove_* table with org_id: remove it from NOT_EXPORTED',
    ]);
    expect(exportCoverageProblems(['ludy_finance.journal_line'], exported, { 'ludy_finance.journal_line': 'x' })).toEqual([
      'ludy_finance.journal_line is on NOT_EXPORTED but the export contains it: remove it from NOT_EXPORTED',
    ]);
  });

  it('fails a schema with org_id tables that is not covered, so a new schema cannot be forgotten', () => {
    expect(COVERED_SCHEMAS).toEqual(['ludy_finance', 'ludy_kernel', 'ludy_crm', 'ludy_hr', 'ludy_meetings', 'ludy_notes', 'ludy_social', 'ludy_ads', 'ludy_projects', 'ludy_sign']);
    expect(exportCoverageProblems(['crove_newline.thing', 'ludy_finance.journal_line'], exported, {})).toEqual([
      'crove_newline has tables with org_id, but is not in COVERED_SCHEMAS (apps/kernel/test/org-export-coverage.ts): add it once its tables are in EXPORT_TABLES or on NOT_EXPORTED with a reason',
    ]);
  });
});

describe('omitted columns (#3367)', () => {
  const columns = new Map([['crove_a.t', new Set(['id', 'secret'])]]);

  it('passes when every omitted name is a column, and skips an entry that reads a function', () => {
    expect(omitProblems(columns, { a: { from: 'crove_a.t', omit: ['secret'] }, b: { from: 'crove_a.counts()', omit: ['nothing'] }, c: { from: 'crove_a.t', omit: [] } }, {})).toEqual([]);
    expect(omitProblems(columns, { a: { from: '(SELECT v.* FROM crove_a.t v WHERE v.id IS NOT NULL)', omit: ['id'] } }, {})).toEqual([]);
  });

  it('names a misspelled omit, and a table the catalog does not know', () => {
    expect(omitProblems(columns, { a: { from: 'crove_a.t', omit: ['secrt'] } }, {})).toEqual(['a omits secrt, which is no column of crove_a.t']);
    expect(omitProblems(columns, { a: { from: 'crove_a.gone', omit: ['x'] } }, {})).toEqual(['a reads crove_a.gone, which has no columns in the catalog']);
    expect(omitProblems(columns, {}, { h: { from: 'crove_a.t', omit: ['nope'] } })).toEqual(['h omits nope, which is no column of crove_a.t']);
  });
});
