// SPDX-License-Identifier: AGPL-3.0-only
// Shared test helpers (outside test/invariant/) for upgrade tests starting before the #3970 core cutover migration
// and historical 2026 SQL replay tests running against post-cutover ludy_* databases.
import pg from 'pg';
import { createPool, type PoolOptions } from '@ludy/db';

const CORE_SCHEMAS = 'kernel|meta|jobs';
const CORE_ROLES = 'app|worker|tenant|prober|reporter|auth_reader_select|auth_reader|definer_tenant|definer_einvoice|definer_system';
const CORE_GUCS = 'ctx|ctx_seal|org_id|user_id|org_purge|org_purge_hold|outbox_purge|inbound_rotate_limit_per_day|inbound_rotate_limit_total';

const PRE_SCHEMA_RE = new RegExp(`\\bludy_(${CORE_SCHEMAS})\\b`, 'g');
const PRE_ROLE_RE = new RegExp(`\\bludy_(${CORE_ROLES})\\b`, 'g');
const PRE_GUC_RE = new RegExp(`\\bludy\\.(${CORE_GUCS})(?!\\.)\\b`, 'g');
const PRE_STREAM_RE = /\bludy_stream\b/g;
const PRE_DDL_WATCH_RE = /\bludy_ddl_watch(_drop)?\b/g;
const PRE_TRY_RUN_RE = /\bludy_try_run_/g;

const HIST_SCHEMA_RE = new RegExp(`\\bcrove_(${CORE_SCHEMAS})\\b`, 'g');
const HIST_ROLE_RE = new RegExp(`\\bcrove_(${CORE_ROLES})\\b`, 'g');
const HIST_GUC_RE = new RegExp(`\\bcrove\\.(${CORE_GUCS})(?!\\.)\\b`, 'g');
const HIST_STREAM_RE = /\bcrove_stream\b/g;
const HIST_DDL_WATCH_RE = /\bcrove_ddl_watch(_drop)?\b/g;
const HIST_TRY_RUN_RE = /\bcrove_try_run_/g;

const ROLE_SET = new Set([
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
]);
const SCHEMA_SET = new Set(['kernel', 'meta', 'jobs']);
const GUC_SET = new Set([
  'ctx',
  'ctx_seal',
  'org_id',
  'user_id',
  'org_purge',
  'org_purge_hold',
  'outbox_purge',
  'inbound_rotate_limit_per_day',
  'inbound_rotate_limit_total',
]);
const IS_CATALOG_QUERY_RE =
  /(?:\b(?:pg_catalog|pg_roles|pg_proc|pg_class|pg_namespace|pg_attribute|pg_trigger|pg_policy|pg_policies|set_config|current_setting|to_regprocedure|to_regclass|to_regnamespace)\b|::reg(?:procedure|class)\b)/i;

const WRAPPED = new WeakSet<object>();

/** Rewrites post-#3970 core SQL identifiers (`ludy_kernel`/`meta`/`jobs`, roles, GUCs) back to `crove_*` for pre-cutover DB snapshots. */
export function rewritePreCutoverSql(sql: string): string {
  return sql
    .replace(PRE_SCHEMA_RE, 'crove_$1')
    .replace(PRE_ROLE_RE, 'crove_$1')
    .replace(PRE_GUC_RE, 'crove.$1')
    .replace(PRE_STREAM_RE, 'crove_stream')
    .replace(PRE_DDL_WATCH_RE, (_m, drop: string | undefined) => `crove_ddl_watch${drop ?? ''}`)
    .replace(PRE_TRY_RUN_RE, 'crove_try_run_');
}

/** Rewrites immutable pre-#3970 core identifiers in historical 2026 SQL snippets to `ludy_*` while preserving module schemas. */
export function rewriteHistoricalCoreSql(sql: string): string {
  return sql
    .replace(HIST_SCHEMA_RE, 'ludy_$1')
    .replace(HIST_ROLE_RE, 'ludy_$1')
    .replace(HIST_GUC_RE, 'ludy.$1')
    .replace(HIST_STREAM_RE, 'ludy_stream')
    .replace(HIST_DDL_WATCH_RE, (_m, drop: string | undefined) => `ludy_ddl_watch${drop ?? ''}`)
    .replace(HIST_TRY_RUN_RE, 'ludy_try_run_');
}

function preCutoverRole(name: string): string {
  if (name.startsWith('ludy_')) {
    const suffix = name.slice('ludy_'.length);
    if (ROLE_SET.has(suffix)) return `crove_${suffix}`;
  }
  return name;
}

/** Rewrites a `ludy_<role>` PostgreSQL connection string username to `crove_<role>`. */
export function preCutoverUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const next = preCutoverRole(url.username);
    if (next === url.username) return connectionString;
    url.username = next;
    return url.toString();
  } catch {
    return connectionString;
  }
}

function rewritePreCutoverParam(val: unknown): unknown {
  if (typeof val === 'string') {
    if (val.startsWith('ludy_')) {
      const suffix = val.slice('ludy_'.length);
      if (SCHEMA_SET.has(suffix) || ROLE_SET.has(suffix)) return `crove_${suffix}`;
    } else if (val.startsWith('ludy.')) {
      const suffix = val.slice('ludy.'.length);
      if (GUC_SET.has(suffix)) return `crove.${suffix}`;
    }
    const dot = val.indexOf('.');
    if (dot > 0 && val.startsWith('ludy_')) {
      const domain = val.slice('ludy_'.length, dot);
      if (SCHEMA_SET.has(domain)) return `crove_${domain}.${val.slice(dot + 1)}`;
    }
    return val;
  }
  if (Array.isArray(val)) return val.map(rewritePreCutoverParam);
  return val;
}

function rewriteQueryArgs(args: unknown[]): void {
  const first = args[0];
  if (typeof first === 'string') {
    const isCat = IS_CATALOG_QUERY_RE.test(first);
    args[0] = rewritePreCutoverSql(first);
    if (isCat && Array.isArray(args[1])) args[1] = args[1].map(rewritePreCutoverParam);
  } else if (first && typeof first === 'object' && 'text' in first && typeof (first as { text: unknown }).text === 'string') {
    const cfg = first as { text: string; values?: unknown[] };
    const isCat = IS_CATALOG_QUERY_RE.test(cfg.text);
    args[0] = {
      ...cfg,
      text: rewritePreCutoverSql(cfg.text),
      ...(isCat && Array.isArray(cfg.values) ? { values: cfg.values.map(rewritePreCutoverParam) } : {}),
    };
    if (isCat && Array.isArray(args[1])) args[1] = args[1].map(rewritePreCutoverParam);
  }
}

function wrapQueryTarget<T extends object & { query: (...args: unknown[]) => unknown }>(target: T): T {
  if (WRAPPED.has(target)) return target;
  WRAPPED.add(target);
  const origQuery = target.query.bind(target) as (...args: unknown[]) => unknown;
  target.query = (...args: unknown[]) => {
    rewriteQueryArgs(args);
    return origQuery(...args);
  };
  return target;
}

/** Creates a `pg.Client` connected to a pre-cutover database that rewrites outbound `ludy_*` core SQL to `crove_*`. */
export function createPreCutoverClient(config: string | pg.ClientConfig): pg.Client {
  if (typeof config === 'string') {
    return wrapQueryTarget(new pg.Client(preCutoverUrl(config)));
  }
  const next: pg.ClientConfig = {
    ...config,
    ...(typeof config.connectionString === 'string' ? { connectionString: preCutoverUrl(config.connectionString) } : {}),
    ...(typeof config.user === 'string' ? { user: preCutoverRole(config.user) } : {}),
  };
  return wrapQueryTarget(new pg.Client(next));
}

/** Creates a pooled `@ludy/db` client connected to a pre-cutover database that rewrites outbound `ludy_*` core SQL to `crove_*`. */
export function createPreCutoverPool(opts: PoolOptions): pg.Pool {
  const pool = wrapQueryTarget(createPool({ ...opts, connectionString: preCutoverUrl(opts.connectionString) }));
  const origConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      const cb = args[0] as (err: Error, client: pg.PoolClient, done: (release?: unknown) => void) => void;
      return origConnect((err: Error, client: pg.PoolClient, done: (release?: unknown) => void) => {
        if (client) wrapQueryTarget(client);
        cb(err, client, done);
      });
    }
    const p = origConnect(...args) as Promise<pg.PoolClient>;
    return p.then((client) => wrapQueryTarget(client));
  };
  return pool;
}
