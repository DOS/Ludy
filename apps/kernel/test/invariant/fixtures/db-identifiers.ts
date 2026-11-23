// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained catalog resolution helper for apps/kernel/test/invariant/** (#3969).
// Resolves active PostgreSQL schemas, roles, GUCs, channels, and event triggers across:
//   1) current main (all crove_*),
//   2) intermediate #3970 (ludy_kernel/meta/jobs + ludy_* roles/GUCs while module schemas stay crove_*),
//   3) post-#3971 (all 12 schemas ludy_*),
// while never mutating immutable Category B data-at-rest domain strings or temp fixture names.
import pg from 'pg';
import { createPool, type PoolOptions } from '@ludy/db';

export const DB_SCHEMA_DOMAINS = [
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
export type DbSchemaDomain = (typeof DB_SCHEMA_DOMAINS)[number];

export const DB_ROLE_NAMES = [
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
export type DbRoleName = (typeof DB_ROLE_NAMES)[number];

export const DB_GUC_NAMES = [
  'ctx',
  'ctx_seal',
  'org_id',
  'user_id',
  'org_purge',
  'org_purge_hold',
  'outbox_purge',
  'inbound_rotate_limit_per_day',
  'inbound_rotate_limit_total',
] as const;
export type DbGucName = (typeof DB_GUC_NAMES)[number];

const SCHEMA_SET = new Set<string>(DB_SCHEMA_DOMAINS);
const ROLE_SET = new Set<string>(DB_ROLE_NAMES);
const GUC_SET = new Set<string>(DB_GUC_NAMES);
const ALL_KNOWN_ROLES = new Set<string>([
  ...DB_ROLE_NAMES.map((r) => `crove_${r}`),
  ...DB_ROLE_NAMES.map((r) => `ludy_${r}`),
]);
const IS_CATALOG_QUERY_RE =
  /(?:\b(?:pg_catalog|pg_roles|pg_proc|pg_class|pg_namespace|pg_attribute|pg_trigger|pg_policy|pg_policies|pg_indexes|pg_tables|pg_event_trigger|pg_constraint|pg_auth_members|pg_get_functiondef|pg_get_userbyid|pg_get_expr|information_schema|has_function_privilege|has_table_privilege|has_schema_privilege|has_column_privilege|pg_has_role|to_regprocedure|to_regclass|to_regnamespace|current_user|session_user|set_config|current_setting)\b|::reg(?:procedure|class)\b|^\s*EXPLAIN\b)/i;
const WRAPPED = new WeakSet<object>();
const RAW_QUERY = new WeakMap<object, (...args: unknown[]) => unknown>();

export interface WrapOptions {
  readonly canonicalizeCatalog?: boolean;
}

export interface DbIdentifiers {
  readonly isKernelLudy: boolean;
  readonly hasTransitions: boolean;
  readonly presentSchemas: ReadonlySet<string>;
  readonly presentRoles: ReadonlySet<string>;
  readonly streamChannel: string;
  readonly ddlWatch: string;
  readonly lockNamespace: number;
  schema: (domain: DbSchemaDomain) => string;
  role: (name: DbRoleName) => string;
  guc: (name: DbGucName) => string;
  roleName: (name: string) => string;
  toCanonicalRole: (role: string) => string;
  table: (qualified: string) => string;
  toCanonicalTable: (qualified: string) => string;
  toCanonicalRegprocedure: (sig: string) => string;
  toCanonicalCatalogText: (text: string) => string;
  rewriteSql: (sql: string) => string;
}

export function buildDbIdentifiers(presentSchemasIterable: Iterable<string>, presentRolesIterable: Iterable<string>): DbIdentifiers {
  const presentSchemas = new Set<string>(presentSchemasIterable);
  const presentRoles = new Set<string>(presentRolesIterable);
  const isKernelLudy = presentSchemas.has('ludy_kernel');

  const activeSchemas = new Map<DbSchemaDomain, string>();
  const transitionedDomains: string[] = [];
  const untransitionedDomains: string[] = [];
  for (const domain of DB_SCHEMA_DOMAINS) {
    if (presentSchemas.has(`ludy_${domain}`)) {
      activeSchemas.set(domain, `ludy_${domain}`);
      transitionedDomains.push(domain);
    } else {
      activeSchemas.set(domain, `crove_${domain}`);
      untransitionedDomains.push(domain);
    }
  }

  const activeRoles = new Map<DbRoleName, string>();
  const transitionedRoles: string[] = [];
  const untransitionedRoles: string[] = [];
  for (const r of DB_ROLE_NAMES) {
    // auth_reader_select is an RLS policy name on auth.*, not a role in pg_roles, so it transitions with ludy_kernel.
    if (isKernelLudy && (r === 'auth_reader_select' || presentRoles.has(`ludy_${r}`))) {
      activeRoles.set(r, `ludy_${r}`);
      transitionedRoles.push(r);
    } else {
      activeRoles.set(r, `crove_${r}`);
      untransitionedRoles.push(r);
    }
  }

  const schema = (domain: DbSchemaDomain): string => activeSchemas.get(domain) ?? `crove_${domain}`;
  const role = (name: DbRoleName): string => activeRoles.get(name) ?? `crove_${name}`;
  const guc = (name: DbGucName): string => `${isKernelLudy ? 'ludy' : 'crove'}.${name}`;

  const roleName = (name: string): string => {
    if (name.startsWith('crove_')) {
      const suffix = name.slice('crove_'.length);
      if (ROLE_SET.has(suffix)) return role(suffix as DbRoleName);
    } else if (name.startsWith('ludy_')) {
      const suffix = name.slice('ludy_'.length);
      if (ROLE_SET.has(suffix)) return role(suffix as DbRoleName);
    }
    return name;
  };

  const toCanonicalRole = (name: string): string => {
    if (name.startsWith('ludy_')) {
      const suffix = name.slice('ludy_'.length);
      if (ROLE_SET.has(suffix)) return `crove_${suffix}`;
    }
    return name;
  };

  const table = (qualified: string): string => {
    const dot = qualified.indexOf('.');
    if (dot === -1) return qualified;
    const rawSchema = qualified.slice(0, dot);
    const rest = qualified.slice(dot + 1);
    const domain = rawSchema.startsWith('crove_')
      ? rawSchema.slice('crove_'.length)
      : rawSchema.startsWith('ludy_')
        ? rawSchema.slice('ludy_'.length)
        : '';
    return SCHEMA_SET.has(domain) ? `${schema(domain as DbSchemaDomain)}.${rest}` : qualified;
  };

  const toCanonicalTable = (qualified: string): string => {
    const dot = qualified.indexOf('.');
    if (dot === -1) return qualified;
    const rawSchema = qualified.slice(0, dot);
    const rest = qualified.slice(dot + 1);
    if (rawSchema.startsWith('ludy_')) {
      const domain = rawSchema.slice('ludy_'.length);
      if (SCHEMA_SET.has(domain)) return `crove_${domain}.${rest}`;
    }
    return qualified;
  };

  const toCanonicalRegprocedure = (sig: string): string => toCanonicalTable(sig);

  const hasTransitions = transitionedDomains.length > 0 || transitionedRoles.length > 0 || isKernelLudy;

  const schemaRe = transitionedDomains.length > 0 ? new RegExp(`\\bcrove_(${transitionedDomains.join('|')})\\b`, 'g') : null;
  const roleRe = transitionedRoles.length > 0 ? new RegExp(`\\bcrove_(${transitionedRoles.join('|')})\\b`, 'g') : null;
  const gucRe = isKernelLudy ? new RegExp(`\\bcrove\\.(${DB_GUC_NAMES.join('|')})(?!\\.)\\b`, 'g') : null;
  const streamRe = isKernelLudy ? /\bcrove_stream\b/g : null;
  const ddlWatchRe = isKernelLudy ? /\bcrove_ddl_watch(_drop)?\b/g : null;
  const tryRunRe = isKernelLudy ? /\bcrove_try_run_/g : null;

  const toCroveSchemaRe = untransitionedDomains.length > 0 ? new RegExp(`\\bludy_(${untransitionedDomains.join('|')})\\b`, 'g') : null;
  const toCroveRoleRe = !isKernelLudy && untransitionedRoles.length > 0 ? new RegExp(`\\bludy_(${untransitionedRoles.join('|')})\\b`, 'g') : null;
  const toCroveGucRe = !isKernelLudy ? new RegExp(`\\bludy\\.(${DB_GUC_NAMES.join('|')})(?!\\.)\\b`, 'g') : null;
  const toCroveStreamRe = !isKernelLudy ? /\bludy_stream\b/g : null;
  const toCroveDdlWatchRe = !isKernelLudy ? /\bludy_ddl_watch(_drop)?\b/g : null;
  const toCroveTryRunRe = !isKernelLudy ? /\bludy_try_run_/g : null;

  const revSchemaRe = transitionedDomains.length > 0 ? new RegExp(`\\bludy_(${transitionedDomains.join('|')})\\b`, 'g') : null;
  const revRoleRe = transitionedRoles.length > 0 ? new RegExp(`\\bludy_(${transitionedRoles.join('|')})\\b`, 'g') : null;
  const revGucRe = isKernelLudy ? new RegExp(`\\bludy\\.(${DB_GUC_NAMES.join('|')})(?!\\.)\\b`, 'g') : null;
  const revStreamRe = isKernelLudy ? /\bludy_stream\b/g : null;
  const revDdlWatchRe = isKernelLudy ? /\bludy_ddl_watch(_drop)?\b/g : null;
  const revOwnerRe = isKernelLudy ? /\bludy_owner\b/g : null;

  const toCanonicalCatalogText = (text: string): string => {
    if (!hasTransitions) return text;
    let out = text;
    if (revSchemaRe) out = out.replace(revSchemaRe, 'crove_$1');
    if (revRoleRe) out = out.replace(revRoleRe, 'crove_$1');
    if (revGucRe) out = out.replace(revGucRe, 'crove.$1');
    if (revStreamRe) out = out.replace(revStreamRe, 'crove_stream');
    if (revDdlWatchRe) out = out.replace(revDdlWatchRe, (_m, drop: string | undefined) => `crove_ddl_watch${drop ?? ''}`);
    if (revOwnerRe) out = out.replace(revOwnerRe, 'crove_owner');
    return out;
  };

  const rewriteSql = (sql: string): string => {
    let out = sql;
    if (schemaRe) out = out.replace(schemaRe, 'ludy_$1');
    if (roleRe) out = out.replace(roleRe, 'ludy_$1');
    if (gucRe) out = out.replace(gucRe, 'ludy.$1');
    if (streamRe) out = out.replace(streamRe, 'ludy_stream');
    if (ddlWatchRe) out = out.replace(ddlWatchRe, (_m, drop: string | undefined) => `ludy_ddl_watch${drop ?? ''}`);
    if (tryRunRe) out = out.replace(tryRunRe, 'ludy_try_run_');
    if (toCroveSchemaRe) out = out.replace(toCroveSchemaRe, 'crove_$1');
    if (toCroveRoleRe) out = out.replace(toCroveRoleRe, 'crove_$1');
    if (toCroveGucRe) out = out.replace(toCroveGucRe, 'crove.$1');
    if (toCroveStreamRe) out = out.replace(toCroveStreamRe, 'crove_stream');
    if (toCroveDdlWatchRe) out = out.replace(toCroveDdlWatchRe, (_m, drop: string | undefined) => `crove_ddl_watch${drop ?? ''}`);
    if (toCroveTryRunRe) out = out.replace(toCroveTryRunRe, 'crove_try_run_');
    return out;
  };

  return {
    isKernelLudy,
    hasTransitions,
    presentSchemas,
    presentRoles,
    streamChannel: isKernelLudy ? 'ludy_stream' : 'crove_stream',
    ddlWatch: isKernelLudy ? 'ludy_ddl_watch' : 'crove_ddl_watch',
    lockNamespace: isKernelLudy ? 1280656473 : 1129467734,
    schema,
    role,
    guc,
    roleName,
    toCanonicalRole,
    table,
    toCanonicalTable,
    toCanonicalRegprocedure,
    toCanonicalCatalogText,
    rewriteSql,
  };
}

export async function resolveDbIdentifiers(adminOrUrl: string | pg.ClientBase): Promise<DbIdentifiers> {
  const queryCatalog = async (client: pg.ClientBase): Promise<DbIdentifiers> => {
    const schemas = await client.query<{ nspname: string }>(
      `SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname LIKE 'crove\\_%' OR nspname LIKE 'ludy\\_%'`,
    );
    const roles = await client.query<{ rolname: string }>(
      `SELECT rolname FROM pg_catalog.pg_roles WHERE rolname LIKE 'crove\\_%' OR rolname LIKE 'ludy\\_%'`,
    );
    return buildDbIdentifiers(
      schemas.rows.map((r) => r.nspname),
      roles.rows.map((r) => r.rolname),
    );
  };
  if (typeof adminOrUrl !== 'string') return queryCatalog(adminOrUrl);
  const client = new pg.Client({ connectionString: adminOrUrl });
  await client.connect();
  try {
    return await queryCatalog(client);
  } finally {
    await client.end();
  }
}

export async function setActiveRolePasswords(
  adminUrl: string,
  passwords: Record<string, string | undefined>,
  ids: DbIdentifiers,
  options: { sharedDatabase?: boolean } = {},
): Promise<void> {
  const shared = options.sharedDatabase ?? (process.env['LUDY_SHARED_DATABASE'] ?? process.env['CROVE_SHARED_DATABASE']) === 'true';
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [rawRole, password] of Object.entries(passwords)) {
      if (!password) continue;
      const targetRole = ids.roleName(rawRole);
      if (shared && !ALL_KNOWN_ROLES.has(targetRole)) {
        throw new Error(`shared database: refusing to set the password of ${targetRole}, which is not a Ludy role`);
      }
      const { rows } = await client.query<{ sql: string }>('SELECT format($$ALTER ROLE %I PASSWORD %L$$, $1::text, $2::text) AS sql', [
        targetRole,
        password,
      ]);
      const stmt = rows[0]?.sql;
      if (stmt) await client.query(stmt);
    }
  } finally {
    await client.end();
  }
}

export function rewriteConnectionString(connectionString: string, ids: DbIdentifiers): string {
  try {
    const url = new URL(connectionString);
    const next = ids.roleName(url.username);
    if (next === url.username) return connectionString;
    url.username = next;
    return url.toString();
  } catch {
    return connectionString;
  }
}

export function rewriteCatalogParam(val: unknown, ids: DbIdentifiers): unknown {
  if (typeof val === 'string') {
    if (val.startsWith('crove_') || val.startsWith('ludy_')) {
      const suffix = val.slice(val.indexOf('_') + 1);
      if (SCHEMA_SET.has(suffix)) return ids.schema(suffix as DbSchemaDomain);
      if (ROLE_SET.has(suffix)) return ids.role(suffix as DbRoleName);
    } else if (val.startsWith('crove.') || val.startsWith('ludy.')) {
      const gucSuffix = val.slice(val.indexOf('.') + 1);
      if (GUC_SET.has(gucSuffix)) return ids.guc(gucSuffix as DbGucName);
    }
    const dot = val.indexOf('.');
    if (dot > 0) {
      const head = val.slice(0, dot);
      if (head.startsWith('crove_') || head.startsWith('ludy_')) {
        const domain = head.slice(head.indexOf('_') + 1);
        if (SCHEMA_SET.has(domain)) return `${ids.schema(domain as DbSchemaDomain)}.${val.slice(dot + 1)}`;
      }
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.map((item) => rewriteCatalogParam(item, ids));
  }
  return val;
}

export function canonicalizeCatalogRows(result: unknown, ids: DbIdentifiers): unknown {
  if (!ids.hasTransitions || !result || typeof result !== 'object' || !('rows' in result)) return result;
  const rows = (result as { rows: unknown }).rows;
  if (!Array.isArray(rows)) return result;
  const mappedRows = rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (typeof value === 'string') {
        next[key] = ids.toCanonicalCatalogText(value);
      } else if (Array.isArray(value)) {
        next[key] = value.map((item) => (typeof item === 'string' ? ids.toCanonicalCatalogText(item) : item));
      } else {
        next[key] = value;
      }
    }
    return next;
  });
  return { ...(result as Record<string, unknown>), rows: mappedRows };
}

function rewriteQueryArgs(args: unknown[], ids: DbIdentifiers, canonicalizeCatalog: boolean): { isCatalog: boolean } {
  const first = args[0];
  let rawSql = '';
  let matchesCatalog = false;
  if (typeof first === 'string') {
    rawSql = first;
    matchesCatalog = canonicalizeCatalog && IS_CATALOG_QUERY_RE.test(rawSql);
    args[0] = ids.rewriteSql(rawSql);
    if (matchesCatalog && Array.isArray(args[1])) {
      args[1] = args[1].map((v) => rewriteCatalogParam(v, ids));
    }
  } else if (first && typeof first === 'object' && 'text' in first && typeof (first as { text: unknown }).text === 'string') {
    const cfg = first as { text: string; values?: unknown[] };
    rawSql = cfg.text;
    matchesCatalog = canonicalizeCatalog && IS_CATALOG_QUERY_RE.test(rawSql);
    args[0] = {
      ...cfg,
      text: ids.rewriteSql(rawSql),
      ...(matchesCatalog && Array.isArray(cfg.values) ? { values: cfg.values.map((v) => rewriteCatalogParam(v, ids)) } : {}),
    };
    if (matchesCatalog && Array.isArray(args[1])) {
      args[1] = args[1].map((v) => rewriteCatalogParam(v, ids));
    }
  }
  return { isCatalog: matchesCatalog && ids.hasTransitions };
}

function invokeWrappedQuery(
  target: object,
  origQuery: (...args: unknown[]) => unknown,
  args: unknown[],
  ids: DbIdentifiers,
  canonicalizeCatalog: boolean,
): unknown {
  const hasCallback = args.length > 0 && typeof args[args.length - 1] === 'function';
  const { isCatalog } = rewriteQueryArgs(args, ids, canonicalizeCatalog);
  const res = origQuery.apply(target, args);
  if (isCatalog && !hasCallback && res && typeof (res as PromiseLike<unknown>).then === 'function') {
    return (res as PromiseLike<unknown>).then((r) => canonicalizeCatalogRows(r, ids));
  }
  return res;
}

export function rawQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  client: pg.ClientBase,
  text: string,
  values?: unknown[],
): Promise<pg.QueryResult<R>> {
  const orig = RAW_QUERY.get(client) ?? (client.query.bind(client) as (...args: unknown[]) => unknown);
  return (values !== undefined ? orig(text, values) : orig(text)) as Promise<pg.QueryResult<R>>;
}

function roleFilterSql(scope: 'brand' | 'non_system'): string {
  return scope === 'brand'
    ? "((r.rolname LIKE 'crove\\_%' OR r.rolname LIKE 'ludy\\_%') AND r.rolname NOT LIKE '%\\_test\\_%' AND r.rolname NOT LIKE 'crove\\_test%' AND r.rolname NOT LIKE 'ludy\\_test%' AND r.rolname <> 'ludy_migrate_test') AND NOT r.rolsuper"
    : "r.rolname !~ '^pg_' AND NOT r.rolsuper";
}

export async function auditRoleFunctionExecute(
  client: pg.ClientBase,
  ids: DbIdentifiers | undefined,
  fn: string,
  allowedLegacyRoles: readonly string[],
  scope: 'brand' | 'non_system' = 'brand',
): Promise<{ rows: Array<{ rolname: string; ok: boolean; expected: boolean }>; activeAllowed: string[] }> {
  const activeFn = ids ? ids.rewriteSql(fn) : fn;
  const activeAllowed = allowedLegacyRoles.map((r) => (ids ? ids.roleName(r) : r));
  const res = await rawQuery<{ rolname: string; ok: boolean; expected: boolean }>(
    client,
    `SELECT r.rolname,
            pg_catalog.has_function_privilege(r.oid, $1::regprocedure, 'EXECUTE') AS ok,
            (
              r.rolname = ANY($2::text[])
              OR EXISTS (
                SELECT 1
                FROM pg_catalog.generate_subscripts($2::text[], 1) AS i
                WHERE r.rolname = ($3::text[])[i]
                  AND pg_catalog.pg_has_role(r.oid, ($2::text[])[i], 'MEMBER')
              )
            ) AS expected
     FROM pg_catalog.pg_roles r
     WHERE ${roleFilterSql(scope)}
     ORDER BY r.rolname`,
    [activeFn, activeAllowed, [...allowedLegacyRoles]],
  );
  return { rows: res.rows, activeAllowed };
}

export async function auditRoleTablePrivileges(
  client: pg.ClientBase,
  ids: DbIdentifiers | undefined,
  table: string,
  rights: readonly string[],
  scope: 'brand' | 'non_system' = 'brand',
): Promise<Array<{ rolname: string; privilege: string; ok: boolean }>> {
  const activeTable = ids ? ids.table(table) : table;
  const res = await rawQuery<{ rolname: string; privilege: string; ok: boolean }>(
    client,
    `SELECT r.rolname,
            p AS privilege,
            pg_catalog.has_table_privilege(r.oid, $1::regclass, p) AS ok
     FROM pg_catalog.pg_roles r
     CROSS JOIN pg_catalog.unnest($2::text[]) AS p
     WHERE ${roleFilterSql(scope)}
     ORDER BY r.rolname, p`,
    [activeTable, [...rights]],
  );
  return res.rows;
}

export function wrapClient<T extends pg.ClientBase>(client: T, ids: DbIdentifiers, options?: WrapOptions): T {
  if (WRAPPED.has(client)) return client;
  WRAPPED.add(client);
  const canonicalizeCatalog = options?.canonicalizeCatalog ?? true;
  const origQuery = client.query.bind(client) as (...args: unknown[]) => unknown;
  RAW_QUERY.set(client, origQuery);
  (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) =>
    invokeWrappedQuery(client, origQuery, args, ids, canonicalizeCatalog);
  return client;
}

export function wrapPool(pool: pg.Pool, ids: DbIdentifiers, options?: WrapOptions): pg.Pool {
  if (WRAPPED.has(pool)) return pool;
  WRAPPED.add(pool);
  const canonicalizeCatalog = options?.canonicalizeCatalog ?? true;
  const origQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  RAW_QUERY.set(pool, origQuery);
  (pool as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) =>
    invokeWrappedQuery(pool, origQuery, args, ids, canonicalizeCatalog);
  const origConnect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      const cb = args[0] as (err: Error, client: pg.PoolClient, done: (release?: unknown) => void) => void;
      return origConnect((err: Error, client: pg.PoolClient, done: (release?: unknown) => void) => {
        if (client) wrapClient(client, ids, options);
        cb(err, client, done);
      });
    }
    const p = origConnect(...args) as Promise<pg.PoolClient>;
    return p.then((client) => wrapClient(client, ids, options));
  };
  return pool;
}

export function createDbClient(config: string | pg.ClientConfig, ids?: DbIdentifiers, options?: WrapOptions): pg.Client {
  if (!ids) return new pg.Client(config);
  if (typeof config === 'string') {
    return wrapClient(new pg.Client(rewriteConnectionString(config, ids)), ids, options);
  }
  const next: pg.ClientConfig = {
    ...config,
    ...(typeof config.connectionString === 'string' ? { connectionString: rewriteConnectionString(config.connectionString, ids) } : {}),
    ...(typeof config.user === 'string' ? { user: ids.roleName(config.user) } : {}),
  };
  return wrapClient(new pg.Client(next), ids, options);
}

export function createDbPool(opts: PoolOptions, ids?: DbIdentifiers, options?: WrapOptions): pg.Pool {
  if (!ids) return createPool(opts);
  return wrapPool(
    createPool({
      ...opts,
      connectionString: rewriteConnectionString(opts.connectionString, ids),
    }),
    ids,
    options,
  );
}

export function createRawPool(config: pg.PoolConfig, ids?: DbIdentifiers, options?: WrapOptions): pg.Pool {
  if (!ids) return new pg.Pool(config);
  const next: pg.PoolConfig = {
    ...config,
    ...(typeof config.connectionString === 'string' ? { connectionString: rewriteConnectionString(config.connectionString, ids) } : {}),
    ...(typeof config.user === 'string' ? { user: ids.roleName(config.user) } : {}),
  };
  return wrapPool(new pg.Pool(next), ids, options);
}
