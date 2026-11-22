// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained catalog resolution helper for modules/sign/test/invariant/** (#3969).
// Resolves active PostgreSQL schemas, roles, GUCs, channels, and event triggers across:
//   1) current main (all crove_*),
//   2) intermediate #3970 (ludy_kernel/meta/jobs + ludy_* roles/GUCs while module schemas stay crove_*),
//   3) post-#3971 (all 12 schemas ludy_*),
// while never mutating immutable Category B data-at-rest domain strings or temp fixture names.
import { createPool } from '@ludy/db';

type Pool = ReturnType<typeof createPool>;
type PoolClient = object;
interface QueryClientLike {
  query: <R = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: R[] }>;
}

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
const ALL_KNOWN_ROLES = new Set<string>([
  ...DB_ROLE_NAMES.map((r) => `crove_${r}`),
  ...DB_ROLE_NAMES.map((r) => `ludy_${r}`),
]);
const WRAPPED = new WeakSet<object>();
const RAW_QUERY = new WeakMap<object, (...args: unknown[]) => unknown>();

export interface DbIdentifiers {
  readonly isKernelLudy: boolean;
  readonly presentSchemas: ReadonlySet<string>;
  readonly presentRoles: ReadonlySet<string>;
  readonly streamChannel: string;
  readonly ddlWatch: string;
  readonly lockNamespace: number;
  schema: (domain: DbSchemaDomain) => string;
  role: (name: DbRoleName) => string;
  guc: (name: DbGucName) => string;
  roleName: (name: string) => string;
  table: (qualified: string) => string;
  toCanonicalTable: (qualified: string) => string;
  rewriteSql: (sql: string) => string;
}

export function buildDbIdentifiers(presentSchemasIterable: Iterable<string>, presentRolesIterable: Iterable<string>): DbIdentifiers {
  const presentSchemas = new Set<string>(presentSchemasIterable);
  const presentRoles = new Set<string>(presentRolesIterable);
  const isKernelLudy = presentSchemas.has('ludy_kernel');

  const activeSchemas = new Map<DbSchemaDomain, string>();
  const transitionedDomains: string[] = [];
  for (const domain of DB_SCHEMA_DOMAINS) {
    if (presentSchemas.has(`ludy_${domain}`)) {
      activeSchemas.set(domain, `ludy_${domain}`);
      transitionedDomains.push(domain);
    } else {
      activeSchemas.set(domain, `crove_${domain}`);
    }
  }

  const activeRoles = new Map<DbRoleName, string>();
  const transitionedRoles: string[] = [];
  for (const r of DB_ROLE_NAMES) {
    if (presentRoles.has(`ludy_${r}`)) {
      activeRoles.set(r, `ludy_${r}`);
      transitionedRoles.push(r);
    } else {
      activeRoles.set(r, `crove_${r}`);
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

  const schemaRe = transitionedDomains.length > 0 ? new RegExp(`\\bcrove_(${transitionedDomains.join('|')})\\b`, 'g') : null;
  const roleRe = transitionedRoles.length > 0 ? new RegExp(`\\bcrove_(${transitionedRoles.join('|')})\\b`, 'g') : null;
  const gucRe = isKernelLudy ? new RegExp(`\\bcrove\\.(${DB_GUC_NAMES.join('|')})(?!\\.)\\b`, 'g') : null;
  const streamRe = isKernelLudy ? /\bcrove_stream\b/g : null;
  const ddlWatchRe = isKernelLudy ? /\bcrove_ddl_watch(_drop)?\b/g : null;
  const tryRunRe = isKernelLudy ? /\bcrove_try_run_/g : null;

  const rewriteSql = (sql: string): string => {
    if (!schemaRe && !roleRe && !gucRe) return sql;
    let out = sql;
    if (schemaRe) out = out.replace(schemaRe, 'ludy_$1');
    if (roleRe) out = out.replace(roleRe, 'ludy_$1');
    if (gucRe) out = out.replace(gucRe, 'ludy.$1');
    if (streamRe) out = out.replace(streamRe, 'ludy_stream');
    if (ddlWatchRe) out = out.replace(ddlWatchRe, (_m, drop: string | undefined) => `ludy_ddl_watch${drop ?? ''}`);
    if (tryRunRe) out = out.replace(tryRunRe, 'ludy_try_run_');
    return out;
  };

  return {
    isKernelLudy,
    presentSchemas,
    presentRoles,
    streamChannel: isKernelLudy ? 'ludy_stream' : 'crove_stream',
    ddlWatch: isKernelLudy ? 'ludy_ddl_watch' : 'crove_ddl_watch',
    lockNamespace: isKernelLudy ? 1280656473 : 1129467734,
    schema,
    role,
    guc,
    roleName,
    table,
    toCanonicalTable,
    rewriteSql,
  };
}

export async function resolveDbIdentifiers(adminOrUrl: string | QueryClientLike): Promise<DbIdentifiers> {
  const queryCatalog = async (client: QueryClientLike): Promise<DbIdentifiers> => {
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
  const pool = createPool({ connectionString: adminOrUrl, max: 1 });
  try {
    return await queryCatalog(pool);
  } finally {
    await pool.end();
  }
}

export async function setActiveRolePasswords(
  adminUrl: string,
  passwords: Record<string, string | undefined>,
  ids: DbIdentifiers,
  options: { sharedDatabase?: boolean } = {},
): Promise<void> {
  const shared = options.sharedDatabase ?? (process.env['LUDY_SHARED_DATABASE'] ?? process.env['CROVE_SHARED_DATABASE']) === 'true';
  const pool = createPool({ connectionString: adminUrl, max: 1 });
  try {
    for (const [rawRole, password] of Object.entries(passwords)) {
      if (!password) continue;
      const targetRole = ids.roleName(rawRole);
      if (shared && !ALL_KNOWN_ROLES.has(targetRole)) {
        throw new Error(`shared database: refusing to set the password of ${targetRole}, which is not a Ludy role`);
      }
      const { rows } = await pool.query<{ sql: string }>('SELECT format($$ALTER ROLE %I PASSWORD %L$$, $1::text, $2::text) AS sql', [
        targetRole,
        password,
      ]);
      const stmt = rows[0]?.sql;
      if (stmt) await pool.query(stmt);
    }
  } finally {
    await pool.end();
  }
}

export function roleUrl(adminUrl: string, legacyRole: string, password: string, ids: DbIdentifiers): string {
  const url = new URL(adminUrl);
  url.username = ids.roleName(legacyRole);
  url.password = password;
  return url.toString();
}

function rewriteQueryArgs(args: unknown[], ids: DbIdentifiers): void {
  const first = args[0];
  if (typeof first === 'string') {
    args[0] = ids.rewriteSql(first);
  } else if (first && typeof first === 'object' && 'text' in first && typeof (first as { text: unknown }).text === 'string') {
    const cfg = first as { text: string };
    args[0] = { ...cfg, text: ids.rewriteSql(cfg.text) };
  }
}

function rawQuery<R = Record<string, unknown>>(
  client: QueryClientLike,
  text: string,
  values?: unknown[],
): Promise<{ rows: R[] }> {
  const orig = RAW_QUERY.get(client) ?? (client.query.bind(client) as (...args: unknown[]) => unknown);
  return (values !== undefined ? orig(text, values) : orig(text)) as Promise<{ rows: R[] }>;
}

export async function auditRoleFunctionExecute(
  client: QueryClientLike,
  ids: DbIdentifiers | undefined,
  fn: string,
  checkedLegacyRoles: readonly string[],
): Promise<Array<{ rolname: string; canonicalRole: string; canExecute: boolean }>> {
  const activeFn = ids ? ids.rewriteSql(fn) : fn;
  const canonicalRoles = [...checkedLegacyRoles];
  const ludyTwinRoles = canonicalRoles.map((r) => (r.startsWith('crove_') ? `ludy_${r.slice('crove_'.length)}` : r));
  const res = await rawQuery<{ rolname: string; canonical_role: string; can_execute: boolean }>(
    client,
    `SELECT r.rolname,
            ($2::text[])[i] AS canonical_role,
            pg_catalog.has_function_privilege(r.oid, $1::regprocedure, 'EXECUTE') AS can_execute
     FROM pg_catalog.generate_subscripts($2::text[], 1) AS i
     JOIN pg_catalog.pg_roles r
       ON r.rolname IN (($2::text[])[i], ($3::text[])[i])
     ORDER BY i, r.rolname`,
    [activeFn, canonicalRoles, ludyTwinRoles],
  );
  return res.rows.map((row) => ({
    rolname: row.rolname,
    canonicalRole: row.canonical_role,
    canExecute: row.can_execute,
  }));
}

export function wrapClient<T extends object>(client: T, ids: DbIdentifiers): T {
  if (WRAPPED.has(client)) return client;
  WRAPPED.add(client);
  const raw = client as { query: (...args: unknown[]) => unknown };
  const origQuery = raw.query.bind(client);
  RAW_QUERY.set(client, origQuery);
  raw.query = (...args: unknown[]) => {
    rewriteQueryArgs(args, ids);
    return origQuery(...args);
  };
  return client;
}

export function wrapPool(pool: Pool, ids: DbIdentifiers): Pool {
  if (WRAPPED.has(pool)) return pool;
  WRAPPED.add(pool);
  const raw = pool as unknown as {
    query: (...args: unknown[]) => unknown;
    connect: (...args: unknown[]) => unknown;
  };
  const origQuery = raw.query.bind(pool);
  RAW_QUERY.set(pool, origQuery);
  raw.query = (...args: unknown[]) => {
    rewriteQueryArgs(args, ids);
    return origQuery(...args);
  };
  const origConnect = raw.connect.bind(pool);
  raw.connect = (...args: unknown[]) => {
    if (typeof args[0] === 'function') {
      const cb = args[0] as (err: Error, client: PoolClient, done: (release?: unknown) => void) => void;
      return origConnect((err: Error, client: PoolClient, done: (release?: unknown) => void) => {
        if (client) wrapClient(client, ids);
        cb(err, client, done);
      });
    }
    const p = origConnect(...args) as Promise<PoolClient>;
    return p.then((client) => wrapClient(client, ids));
  };
  return pool;
}
