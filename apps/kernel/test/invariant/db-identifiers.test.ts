// SPDX-License-Identifier: AGPL-3.0-only
// Unit tests for the self-contained catalog resolver and query wrapper in apps/kernel/test/invariant/fixtures/db-identifiers.ts (#3969).
import { describe, expect, it } from 'vitest';
import {
  auditRoleFunctionExecute,
  auditRoleTablePrivileges,
  buildDbIdentifiers,
  canonicalizeCatalogRows,
  rawQuery,
  rewriteCatalogParam,
  wrapClient,
} from './fixtures/db-identifiers.ts';

const ALL_SCHEMAS = [
  'kernel',
  'meta',
  'jobs',
  'finance',
  'hr',
  'crm',
  'social',
  'ads',
  'notes',
  'projects',
  'meetings',
  'sign',
] as const;

const ALL_ROLES = [
  'app',
  'worker',
  'tenant',
  'prober',
  'reporter',
  'auth_reader',
  'auth_reader_select',
  'definer_tenant',
  'definer_einvoice',
  'definer_system',
] as const;

const KERNEL_ONLY = new Set(['kernel', 'meta', 'jobs']);

const MAIN_IDS = buildDbIdentifiers(
  ALL_SCHEMAS.map((s) => `crove_${s}`),
  ALL_ROLES.map((r) => `crove_${r}`),
);

const INTERMEDIATE_IDS = buildDbIdentifiers(
  ALL_SCHEMAS.map((s) => (KERNEL_ONLY.has(s) ? `ludy_${s}` : `crove_${s}`)),
  ALL_ROLES.map((r) => `ludy_${r}`),
);

const FULL_LUDY_IDS = buildDbIdentifiers(
  ALL_SCHEMAS.map((s) => `ludy_${s}`),
  ALL_ROLES.map((r) => `ludy_${r}`),
);

function makeFakeClient(recorder: Array<{ text: string; values?: unknown[] }>, responseRows: Array<Record<string, unknown>>) {
  return {
    async query(arg0: string | { text: string; values?: unknown[] }, arg1?: unknown[]) {
      const vals = typeof arg0 === 'string' ? arg1 : (arg0.values ?? arg1);
      recorder.push({
        text: typeof arg0 === 'string' ? arg0 : arg0.text,
        ...(vals !== undefined ? { values: vals } : {}),
      });
      return { rows: responseRows };
    },
  } as never;
}

describe('apps/kernel invariant db-identifiers helper (#3969)', () => {
  it('resolves schemas, roles, channels, event triggers, GUCs, and transitions across all three states', () => {
    expect(MAIN_IDS.isKernelLudy).toBe(false);
    expect(MAIN_IDS.hasTransitions).toBe(false);
    expect(MAIN_IDS.schema('kernel')).toBe('crove_kernel');
    expect(MAIN_IDS.schema('finance')).toBe('crove_finance');
    expect(MAIN_IDS.role('app')).toBe('crove_app');
    expect(MAIN_IDS.guc('ctx')).toBe('crove.ctx');
    expect(MAIN_IDS.streamChannel).toBe('crove_stream');
    expect(MAIN_IDS.ddlWatch).toBe('crove_ddl_watch');

    expect(INTERMEDIATE_IDS.isKernelLudy).toBe(true);
    expect(INTERMEDIATE_IDS.hasTransitions).toBe(true);
    expect(INTERMEDIATE_IDS.schema('kernel')).toBe('ludy_kernel');
    expect(INTERMEDIATE_IDS.schema('meta')).toBe('ludy_meta');
    expect(INTERMEDIATE_IDS.schema('jobs')).toBe('ludy_jobs');
    expect(INTERMEDIATE_IDS.schema('finance')).toBe('crove_finance');
    expect(INTERMEDIATE_IDS.schema('sign')).toBe('crove_sign');
    expect(INTERMEDIATE_IDS.role('app')).toBe('ludy_app');
    expect(INTERMEDIATE_IDS.guc('ctx_seal')).toBe('ludy.ctx_seal');
    expect(INTERMEDIATE_IDS.streamChannel).toBe('ludy_stream');
    expect(INTERMEDIATE_IDS.ddlWatch).toBe('ludy_ddl_watch');

    expect(FULL_LUDY_IDS.isKernelLudy).toBe(true);
    expect(FULL_LUDY_IDS.hasTransitions).toBe(true);
    expect(FULL_LUDY_IDS.schema('finance')).toBe('ludy_finance');
    expect(FULL_LUDY_IDS.schema('sign')).toBe('ludy_sign');
    expect(FULL_LUDY_IDS.toCanonicalRole('ludy_worker')).toBe('crove_worker');
    expect(FULL_LUDY_IDS.toCanonicalRegprocedure('ludy_ads.token_hold()')).toBe('crove_ads.token_hold()');
  });

  it('rewrites catalog parameters across schemas, roles, GUCs, regprocedures, and arrays while leaving Category B untouched', () => {
    expect(rewriteCatalogParam('crove_kernel', INTERMEDIATE_IDS)).toBe('ludy_kernel');
    expect(rewriteCatalogParam('crove_finance', INTERMEDIATE_IDS)).toBe('crove_finance');
    expect(rewriteCatalogParam('crove_finance', FULL_LUDY_IDS)).toBe('ludy_finance');
    expect(rewriteCatalogParam('crove_worker', INTERMEDIATE_IDS)).toBe('ludy_worker');
    expect(rewriteCatalogParam('crove.ctx', INTERMEDIATE_IDS)).toBe('ludy.ctx');
    expect(rewriteCatalogParam('crove_kernel.org_purge(integer)', INTERMEDIATE_IDS)).toBe('ludy_kernel.org_purge(integer)');
    expect(rewriteCatalogParam('crove_ads.token_hold()', FULL_LUDY_IDS)).toBe('ludy_ads.token_hold()');
    expect(rewriteCatalogParam(['crove_app', 'crove_worker', 'postgres'], INTERMEDIATE_IDS)).toEqual([
      'ludy_app',
      'ludy_worker',
      'postgres',
    ]);
    // Immutable Category B domains and test names stay untouched.
    expect(rewriteCatalogParam('crove:s1:secret', FULL_LUDY_IDS)).toBe('crove:s1:secret');
    expect(rewriteCatalogParam('crove-extract', FULL_LUDY_IDS)).toBe('crove-extract');
    expect(rewriteCatalogParam('crove_test_123', FULL_LUDY_IDS)).toBe('crove_test_123');
  });

  it('canonicalizes catalog rows back to canonical names while preserving non-strings and test/Category B names', () => {
    const dt = new Date('2026-11-22T00:00:00.000Z');
    const buf = Buffer.from([1, 2, 3]);
    const res = canonicalizeCatalogRows(
      {
        rows: [
          {
            role: 'ludy_worker',
            nspname: 'ludy_kernel',
            fn: 'ludy_kernel.org_purge(integer)',
            def: "CREATE FUNCTION ludy_kernel.x() RETURNS void AS $$ SELECT current_setting('ludy.ctx'); PERFORM pg_notify('ludy_stream', '1'); $$",
            acl: '{=X/ludy_owner,ludy_tenant=X/ludy_owner}',
            plan: 'Output: ludy_kernel.ctx_org_id()',
            proconfig: ['search_path=pg_catalog, pg_temp', 'ludy.org_id'],
            untouchedTest: 'ludy_migrate_test',
            catB: 'crove:s1:abc',
            count: 42,
            ok: true,
            nothing: null,
            createdAt: dt,
            raw: buf,
          },
        ],
      },
      FULL_LUDY_IDS,
    ) as { rows: Array<Record<string, unknown>> };

    expect(res.rows[0]).toEqual({
      role: 'crove_worker',
      nspname: 'crove_kernel',
      fn: 'crove_kernel.org_purge(integer)',
      def: "CREATE FUNCTION crove_kernel.x() RETURNS void AS $$ SELECT current_setting('crove.ctx'); PERFORM pg_notify('crove_stream', '1'); $$",
      acl: '{=X/crove_owner,crove_tenant=X/crove_owner}',
      plan: 'Output: crove_kernel.ctx_org_id()',
      proconfig: ['search_path=pg_catalog, pg_temp', 'crove.org_id'],
      untouchedTest: 'ludy_migrate_test',
      catB: 'crove:s1:abc',
      count: 42,
      ok: true,
      nothing: null,
      createdAt: dt,
      raw: buf,
    });

    // Under intermediate state, transitioned ludy_kernel canonicalizes while un-transitioned crove_ads stays canonical.
    expect(INTERMEDIATE_IDS.toCanonicalCatalogText('ludy_ddl_watch_drop')).toBe('crove_ddl_watch_drop');
    expect(INTERMEDIATE_IDS.toCanonicalCatalogText('crove_ads.token_hold()')).toBe('crove_ads.token_hold()');
    expect(MAIN_IDS.toCanonicalCatalogText('crove_kernel.party')).toBe('crove_kernel.party');
  });

  it('intercepts catalog queries for param/row canonicalization, leaves non-catalog queries untouched, and respects canonicalizeCatalog: false', async () => {
    const recordedCatalog: Array<{ text: string; values?: unknown[] }> = [];
    const catalogClient = wrapClient(
      makeFakeClient(recordedCatalog, [{ nspname: 'ludy_kernel', roles: ['ludy_app', 'ludy_worker'] }]),
      INTERMEDIATE_IDS,
    ) as unknown as {
      query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    };

    const catRes = await catalogClient.query(
      'SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = $1 AND has_function_privilege($2, $3::regprocedure, $4)',
      ['crove_kernel', ['crove_app', 'crove_finance'], 'crove_kernel.enter_context(uuid,uuid)', 'EXECUTE'],
    );
    expect(recordedCatalog[0]).toEqual({
      text: 'SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = $1 AND has_function_privilege($2, $3::regprocedure, $4)',
      values: ['ludy_kernel', ['ludy_app', 'crove_finance'], 'ludy_kernel.enter_context(uuid,uuid)', 'EXECUTE'],
    });
    expect(catRes.rows[0]).toEqual({ nspname: 'crove_kernel', roles: ['crove_app', 'crove_worker'] });

    // Non-catalog SQL rewrites outbound SQL only; $1 params and result rows remain verbatim.
    const recordedData: Array<{ text: string; values?: unknown[] }> = [];
    const dataClient = wrapClient(
      makeFakeClient(recordedData, [{ note: 'ludy_kernel text returned by app' }]),
      INTERMEDIATE_IDS,
    ) as unknown as {
      query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    };
    const dataRes = await dataClient.query(
      'SELECT note FROM crove_kernel.party WHERE label = $1',
      ['crove_kernel'],
    );
    expect(recordedData[0]).toEqual({
      text: 'SELECT note FROM ludy_kernel.party WHERE label = $1',
      values: ['crove_kernel'],
    });
    expect(dataRes.rows[0]).toEqual({ note: 'ludy_kernel text returned by app' });

    // Opting out of catalog canonicalization returns active DB identifiers.
    const recordedRaw: Array<{ text: string; values?: unknown[] }> = [];
    const rawCatalogClient = wrapClient(
      makeFakeClient(recordedRaw, [{ nspname: 'ludy_kernel' }]),
      INTERMEDIATE_IDS,
      { canonicalizeCatalog: false },
    ) as unknown as {
      query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
    };
    const rawRes = await rawCatalogClient.query('SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = $1', ['crove_kernel']);
    expect(recordedRaw[0]?.values).toEqual(['crove_kernel']);
    expect(rawRes.rows[0]).toEqual({ nspname: 'ludy_kernel' });
  });

  it('bypasses wrapping in rawQuery and evaluates un-rewritten active + legacy roles in role privilege audit helpers', async () => {
    const fnRecorded: Array<{ text: string; values?: unknown[] }> = [];
    const fnWrapped = wrapClient(
      makeFakeClient(fnRecorded, [
        { rolname: 'crove_app', ok: true, expected: true },
        { rolname: 'ludy_app', ok: true, expected: true },
        { rolname: 'crove_worker', ok: false, expected: false },
      ]),
      INTERMEDIATE_IDS,
    );

    const directRes = await rawQuery(fnWrapped, 'SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = $1', ['crove_kernel']);
    expect(fnRecorded[0]).toEqual({
      text: 'SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname = $1',
      values: ['crove_kernel'],
    });
    expect(directRes.rows[0]).toEqual({ rolname: 'crove_app', ok: true, expected: true });

    const fnAudit = await auditRoleFunctionExecute(fnWrapped, INTERMEDIATE_IDS, 'crove_kernel.enter_mcp_member_context(uuid, uuid)', ['crove_app']);
    expect(fnAudit.activeAllowed).toEqual(['ludy_app']);
    expect(fnRecorded[1]?.values).toEqual(['ludy_kernel.enter_mcp_member_context(uuid, uuid)', ['ludy_app'], ['crove_app']]);
    expect(fnAudit.rows.map((r) => r.rolname)).toEqual(['crove_app', 'ludy_app', 'crove_worker']);

    const tblRecorded: Array<{ text: string; values?: unknown[] }> = [];
    const tblWrapped = wrapClient(
      makeFakeClient(tblRecorded, [{ rolname: 'crove_worker', privilege: 'INSERT', ok: false }]),
      INTERMEDIATE_IDS,
    );
    const tblAudit = await auditRoleTablePrivileges(tblWrapped, INTERMEDIATE_IDS, 'crove_kernel.mcp_member_table', ['INSERT', 'UPDATE'], 'non_system');
    expect(tblRecorded[0]?.values).toEqual(['ludy_kernel.mcp_member_table', ['INSERT', 'UPDATE']]);
    expect(tblRecorded[0]?.text).toContain("r.rolname !~ '^pg_'");
    expect(tblAudit).toEqual([{ rolname: 'crove_worker', privilege: 'INSERT', ok: false }]);
  });
});
