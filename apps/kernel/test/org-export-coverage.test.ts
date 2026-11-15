// SPDX-License-Identifier: AGPL-3.0-only
// The reading behind the coverage check of offboarding.db.test.ts (#3201), without a database: which tables the export reads, and the messages on planted catalogs.
import { describe, expect, it } from 'vitest';
import { EXPORT_TABLES } from '@crove/kernel';
import { COVERED_SCHEMAS, exportCoverageProblems, exportedTables } from './org-export-coverage.ts';

describe('the tables the owner export contains (#3201)', () => {
  it('reads the table of each entry, the table inside a subquery, and no function', () => {
    const exported = exportedTables({
      a: { from: 'crove_a.plain' },
      b: { from: "(SELECT f.* FROM crove_a.filtered f WHERE f.source NOT IN ('x'))" },
      c: { from: 'crove_a.counts()' },
    });
    expect([...exported].sort()).toEqual(['crove_a.filtered', 'crove_a.plain']);
  });

  it('reads the real list: the household profile and the ledger are in, a machinery table is not', () => {
    const exported = exportedTables();
    expect(exported.has('crove_finance.household_profile')).toBe(true);
    expect(exported.has('crove_finance.journal_line')).toBe(true);
    expect(exported.has('crove_kernel.idempotency_key')).toBe(false);
    expect(Object.keys(EXPORT_TABLES).length).toBeGreaterThan(60);
  });
});

describe('export coverage problems (#3201)', () => {
  const exported = new Set(['crove_finance.journal_line', 'crove_finance.household_profile']);

  it('passes when every table is exported or named with a reason', () => {
    expect(exportCoverageProblems(['crove_finance.journal_line', 'crove_finance.legacy'], exported, { 'crove_finance.legacy': 'a reason' })).toEqual([]);
  });

  it('names a planted table nobody listed, and says where to add it', () => {
    const problems = exportCoverageProblems(['crove_finance.journal_line', 'crove_finance.planted'], exported, {});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^crove_finance\.planted has org_id, but the owner export does not contain it: add it to EXPORT_TABLES/);
  });

  it('fails a table on NOT_EXPORTED that is gone from the catalog or is exported after all', () => {
    expect(exportCoverageProblems(['crove_finance.journal_line'], exported, { 'crove_finance.gone': 'x' })).toEqual([
      'crove_finance.gone is on NOT_EXPORTED but is no covered crove_* table with org_id: remove it from NOT_EXPORTED',
    ]);
    expect(exportCoverageProblems(['crove_finance.journal_line'], exported, { 'crove_finance.journal_line': 'x' })).toEqual([
      'crove_finance.journal_line is on NOT_EXPORTED but the export contains it: remove it from NOT_EXPORTED',
    ]);
  });

  it('checks the finance schema only, so another line decides its own tables', () => {
    expect(COVERED_SCHEMAS).toEqual(['crove_finance']);
    expect(exportCoverageProblems(['crove_social.post', 'crove_finance.journal_line'], exported, {})).toEqual([]);
  });
});
