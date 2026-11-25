// Org-less identity operations: sign-in bookkeeping, listing orgs, creating an org.
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db, MemberRole } from '@ludy/db';
import { ORG_KINDS, ORG_KIND_APPS_OFF, type OrgKind } from '@ludy/kernel-contract';
import { DomainError, defineCommand, type Runtime, type UserActor } from '@ludy/kernel-runtime';

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string;
  name: string | null;
}

export async function upsertIdentity(db: Db, identity: VerifiedIdentity): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT ludy_kernel.identity_upsert(${identity.issuer}, ${identity.subject}, ${identity.email}, ${identity.name}) AS id`.execute(db);
  const id = rows[0]?.id;
  if (!id) throw new DomainError('INTERNAL', 500, 'Không tạo được tài khoản');
  return id;
}

// Maps a verified token to its user only after the session checks pass (ludy_kernel.identity_resolve), so a
// revoked or disabled session never creates or updates the account. upstream: the self-host db adapter.
// acceptedOauthClient (AUTH_OAUTH_CLIENT_ID, issue #4704): the one OAuth client whose bound sessions the db check lets
// through; null or absent: every bound session is refused, as before.
export async function resolveIdentity(
  db: Db,
  identity: VerifiedIdentity & { sessionId: string; upstream: boolean; acceptedOauthClient?: string | null },
): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT ludy_kernel.identity_resolve(${identity.issuer}, ${identity.subject}, ${identity.email}, ${identity.name},
      ${identity.sessionId}::uuid, ${identity.upstream}, ${identity.acceptedOauthClient ?? null}::text) AS id`.execute(db);
  const id = rows[0]?.id;
  if (!id) throw new DomainError('INTERNAL', 500, 'Không tạo được tài khoản');
  return id;
}

export interface OrgSummary {
  orgId: string;
  slug: string;
  name: string;
  role: MemberRole;
}

export async function myOrgs(db: Db, userId: string): Promise<OrgSummary[]> {
  const { rows } = await sql<{ org_id: string; slug: string; name: string; role: MemberRole }>`
    SELECT org_id, slug, name, role FROM ludy_kernel.my_orgs(${userId}::uuid)`.execute(db);
  return rows.map((r) => ({ orgId: r.org_id, slug: r.slug, name: r.name, role: r.role }));
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 45) end -= 1;
  return value.slice(start, end);
}

export function slugify(name: string): string {
  const base = trimDashes(
    trimDashes(
      name
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/gi, 'd')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-'),
    ).slice(0, 40),
  );
  return base.length >= 3 ? base : `org-${Math.random().toString(36).slice(2, 8)}`;
}

// How many orgs one user may create (External-tenant gate T4): perDay in any rolling 24 hours, total ever,
// counting closed orgs too. Enforced by ludy_kernel.create_or_replay_org under a per-user lock, so the limit holds
// across API instances; a replay of an existing idempotency key does not count.
export interface OrgCreateLimits {
  perDay: number;
  total: number;
}

// The definer uses the same defaults when the API sets no limits.
export const DEFAULT_ORG_CREATE_LIMITS: OrgCreateLimits = { perDay: 5, total: 20 };

// Matches the range the definer accepts.
const MAX_ORG_CREATE_LIMIT = 999_999;

function assertLimit(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ORG_CREATE_LIMIT) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_ORG_CREATE_LIMIT}`);
  }
}

// Creates an org with the caller as owner (External-tenant gate T4). The definer creates the tenant and the
// owner membership, or returns the org an earlier request with the same idempotency key created; the runtime
// then enters it as the caller and writes the audit row and the idempotency key in the same transaction.
// Over the limits the definer refuses with ORG_CREATE_RATE_LIMITED (429 RATE_LIMITED) before writing anything.
//
// The org's type (ADR-0053 amendment, #4802): `kind` 'solo' starts the org with the modules a one-person company does not use switched off (ORG_KIND_APPS_OFF),
// 'team' or no kind with every module on, as before. The switches are set here, in the same transaction, by running the audited kernel.org.set_app once per module
// as the new org's owner: no new write path, and the tenant_apps_guard and tenant_apps_requires_audit triggers stay as they are (an INSERT carries only the defaults;
// each switch is an owner's UPDATE with its own audit row). `shipped` is the module list of the build (as for set_app): a module the build does not ship is skipped.
// Absent `shipped` (a test that registers the kernel alone) every listed module is switched.
export function orgCreateCommand(limits: OrgCreateLimits = DEFAULT_ORG_CREATE_LIMITS, options: { shipped?: readonly string[] } = {}) {
  assertLimit('perDay', limits.perDay);
  assertLimit('total', limits.total);
  return defineCommand({
    name: 'kernel.org.create',
    input: z.object({ name: z.string().trim().min(1).max(200), kind: z.enum(ORG_KINDS).optional() }),
    risk: 'R1',
    sideEffect: 'internal',
    access: ['owner'],
    bootstrap: async (trx, actor, input, idempotencyKey) => {
      // Transaction-local, read by the definer right below.
      await sql`SELECT set_config('ludy.org_create_limit_per_day', ${String(limits.perDay)}, true),
                       set_config('ludy.org_create_limit_total', ${String(limits.total)}, true)`.execute(trx);
      const { rows } = await sql<{ org_id: string | null }>`
        SELECT ludy_kernel.create_or_replay_org(${actor.userId}::uuid, ${slugify(input.name)}, ${input.name}, ${idempotencyKey}) AS org_id`.execute(trx);
      const orgId = rows[0]?.org_id;
      if (!orgId) throw new DomainError('INTERNAL', 500, 'Không tạo được tổ chức');
      return orgId;
    },
    handler: async (ctx, input): Promise<OrgSummary> => {
      const tenant = await ctx.trx
        .selectFrom('ludy_kernel.tenant')
        .select(['org_id', 'slug', 'name'])
        .where('org_id', '=', ctx.orgId)
        .executeTakeFirstOrThrow();
      // The modules this type switches off that the build ships. With no type, or a type that switches nothing (team), nothing more is read: the old query only.
      const wanted = (input.kind ? ORG_KIND_APPS_OFF[input.kind] : []).filter((module) => !options.shipped || options.shipped.includes(module));
      // Only an org whose apps nobody has ever changed (version 1, as the INSERT leaves it): a replay that reached an org already changed by its owner switches nothing.
      let off: readonly string[] = [];
      if (wanted.length > 0) {
        const apps = await ctx.trx.selectFrom('ludy_kernel.tenant').select('apps_version').where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
        if (apps.apps_version === 1) off = wanted;
      }
      for (const module of off) await ctx.run('kernel.org.set_app', { module, enabled: false });
      ctx.audit({ slug: tenant.slug, ...(input.kind ? { kind: input.kind, appsOff: off } : {}) });
      return { orgId: tenant.org_id, slug: tenant.slug, name: tenant.name, role: 'owner' };
    },
  });
}

export const createOrgCommand = orgCreateCommand();

export function createOrg(runtime: Runtime, actor: UserActor, name: string, idempotencyKey?: string, kind?: OrgKind): Promise<OrgSummary> {
  return runtime.executeOrgless<OrgSummary>('kernel.org.create', { name, ...(kind ? { kind } : {}) }, { actor, ...(idempotencyKey ? { idempotencyKey } : {}) });
}
