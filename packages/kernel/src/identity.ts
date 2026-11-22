// Org-less identity operations: sign-in bookkeeping, listing orgs, creating an org.
import { sql } from 'kysely';
import { z } from 'zod';
import type { Db, MemberRole } from '@ludy/db';
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
export async function resolveIdentity(db: Db, identity: VerifiedIdentity & { sessionId: string; upstream: boolean }): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    SELECT ludy_kernel.identity_resolve(${identity.issuer}, ${identity.subject}, ${identity.email}, ${identity.name},
      ${identity.sessionId}::uuid, ${identity.upstream}) AS id`.execute(db);
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
export function orgCreateCommand(limits: OrgCreateLimits = DEFAULT_ORG_CREATE_LIMITS) {
  assertLimit('perDay', limits.perDay);
  assertLimit('total', limits.total);
  return defineCommand({
    name: 'kernel.org.create',
    input: z.object({ name: z.string().trim().min(1).max(200) }),
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
    handler: async (ctx): Promise<OrgSummary> => {
      const tenant = await ctx.trx
        .selectFrom('ludy_kernel.tenant')
        .select(['org_id', 'slug', 'name'])
        .where('org_id', '=', ctx.orgId)
        .executeTakeFirstOrThrow();
      ctx.audit({ slug: tenant.slug });
      return { orgId: tenant.org_id, slug: tenant.slug, name: tenant.name, role: 'owner' };
    },
  });
}

export const createOrgCommand = orgCreateCommand();

export function createOrg(runtime: Runtime, actor: UserActor, name: string, idempotencyKey?: string): Promise<OrgSummary> {
  return runtime.executeOrgless<OrgSummary>('kernel.org.create', { name }, { actor, ...(idempotencyKey ? { idempotencyKey } : {}) });
}
