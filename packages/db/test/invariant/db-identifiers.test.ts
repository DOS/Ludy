// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildDbIdentifiers, DB_GUC_NAMES, DB_ROLE_NAMES, DB_SCHEMA_DOMAINS } from './fixtures/db-identifiers.ts';

describe('db-identifiers resolution helper (#3969)', () => {
  it('resolves all three rollout states (crove_*, mixed #3970, all ludy_*) cleanly', () => {
    const pre = buildDbIdentifiers(
      DB_SCHEMA_DOMAINS.map((d) => `crove_${d}`),
      DB_ROLE_NAMES.map((r) => `crove_${r}`),
    );
    expect(pre.isKernelLudy).toBe(false);
    expect(pre.schema('kernel')).toBe('crove_kernel');
    expect(pre.schema('finance')).toBe('crove_finance');
    expect(pre.role('app')).toBe('crove_app');
    expect(pre.guc('ctx')).toBe('crove.ctx');
    expect(pre.streamChannel).toBe('crove_stream');
    expect(pre.ddlWatch).toBe('crove_ddl_watch');
    expect(pre.table('crove_finance.journal_entry')).toBe('crove_finance.journal_entry');
    expect(pre.rewriteSql('SELECT crove_kernel.ctx_org_id(), crove_finance.amount FROM crove_kernel.tenant')).toBe(
      'SELECT crove_kernel.ctx_org_id(), crove_finance.amount FROM crove_kernel.tenant',
    );

    // State 2 (#3970): core schemas and roles switched to ludy_*, module schemas still crove_*.
    const mixed = buildDbIdentifiers(
      ['ludy_kernel', 'ludy_meta', 'ludy_jobs', 'crove_finance', 'crove_hr', 'crove_meetings', 'crove_sign'],
      DB_ROLE_NAMES.map((r) => `ludy_${r}`),
    );
    expect(mixed.isKernelLudy).toBe(true);
    expect(mixed.schema('kernel')).toBe('ludy_kernel');
    expect(mixed.schema('meta')).toBe('ludy_meta');
    expect(mixed.schema('jobs')).toBe('ludy_jobs');
    expect(mixed.schema('finance')).toBe('crove_finance');
    expect(mixed.roleName('crove_app')).toBe('ludy_app');
    expect(mixed.roleName('crove_definer_einvoice')).toBe('ludy_definer_einvoice');
    expect(mixed.guc('ctx')).toBe('ludy.ctx');
    expect(mixed.guc('org_purge')).toBe('ludy.org_purge');
    expect(mixed.streamChannel).toBe('ludy_stream');
    expect(mixed.ddlWatch).toBe('ludy_ddl_watch');
    expect(mixed.lockNamespace).toBe(1280656473);
    expect(mixed.table('crove_kernel.party')).toBe('ludy_kernel.party');
    expect(mixed.table('crove_finance.journal_entry')).toBe('crove_finance.journal_entry');
    expect(
      mixed.rewriteSql(
        `SET LOCAL ROLE crove_app; SELECT crove_kernel.ctx_org_id(), current_setting('crove.ctx', true) FROM crove_finance.journal_entry JOIN crove_jobs.job ON true WHERE crove_meta.deployment IS NOT NULL`,
      ),
    ).toBe(
      `SET LOCAL ROLE ludy_app; SELECT ludy_kernel.ctx_org_id(), current_setting('ludy.ctx', true) FROM crove_finance.journal_entry JOIN ludy_jobs.job ON true WHERE ludy_meta.deployment IS NOT NULL`,
    );

    // State 3 (post-#3971): all 12 schemas are ludy_*.
    const post = buildDbIdentifiers(
      DB_SCHEMA_DOMAINS.map((d) => `ludy_${d}`),
      DB_ROLE_NAMES.map((r) => `ludy_${r}`),
    );
    expect(post.schema('finance')).toBe('ludy_finance');
    expect(post.schema('meetings')).toBe('ludy_meetings');
    expect(post.toCanonicalTable('ludy_meetings.member_hook')).toBe('crove_meetings.member_hook');
    expect(post.rewriteSql('NOTIFY crove_stream; ALTER EVENT TRIGGER crove_ddl_watch_drop DISABLE; SELECT pg_advisory_lock(crove_try_run_1);')).toBe(
      'NOTIFY ludy_stream; ALTER EVENT TRIGGER ludy_ddl_watch_drop DISABLE; SELECT pg_advisory_lock(ludy_try_run_1);',
    );
    for (const g of DB_GUC_NAMES) {
      expect(post.rewriteSql(`current_setting('crove.${g}', true)`)).toBe(`current_setting('ludy.${g}', true)`);
    }
  });

  it('never mutates immutable Category B domain strings, filenames, or temp test names', () => {
    const post = buildDbIdentifiers(
      DB_SCHEMA_DOMAINS.map((d) => `ludy_${d}`),
      DB_ROLE_NAMES.map((r) => `ludy_${r}`),
    );
    const unchanged = [
      "INSERT INTO t VALUES ('crove:s1:abc', 'crove-archive', 'crove.org-export.v2', 'crove.input.v1', 'crove.ctx.v1', 'crx_123')",
      'CREATE SCHEMA crove_t17; CREATE SCHEMA crove_t100; CREATE DATABASE crove_test_runner_1; CREATE ROLE ludy_migrate_test;',
      "SELECT '20261015120000_crove_kernel_revoke_temp.sql'",
    ];
    for (const sql of unchanged) {
      expect(post.rewriteSql(sql)).toBe(sql);
    }
  });
});
