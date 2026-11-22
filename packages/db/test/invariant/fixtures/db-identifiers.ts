// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained catalog resolution helper for packages/db/test/invariant/** (#3969).
// Resolves active PostgreSQL schemas, roles, GUCs, channels, and event triggers across:
//   1) current main (all crove_*),
//   2) intermediate #3970 (ludy_kernel/meta/jobs + ludy_* roles/GUCs while module schemas stay crove_*),
//   3) post-#3971 (all 12 schemas ludy_*),
// while never mutating immutable Category B data-at-rest domain strings or temp fixture names.
import pg from 'pg';

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
    if (isKernelLudy && presentRoles.has(`ludy_${r}`)) {
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
