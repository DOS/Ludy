// SPDX-License-Identifier: AGPL-3.0-only
// The glossary an organization keeps (#4043, step 2). The contract is packages/kernel-contract/src/meeting-glossary.ts.
//
// meetings.glossary.add      an owner or admin adds a term (at most 60 terms an org, one row per term whatever the case)
// meetings.glossary.update   rewrites a term (same rules); the identity and the author stay
// meetings.glossary.remove   deletes a term (nothing copies a term into a meeting, so a removed term changes no published result)
// meetings.glossary.list     the terms, for an owner or admin only; a member gets 403 (the database policy says the same: nobody else reads the table)
//
// The audit row of a command carries the term's id and the number of terms, never the text (a term can be a customer's or a product's name). Step 3 reads the terms for the recorder's
// own run through a definer; nothing here is exposed through MCP.
import { sql } from 'kysely';
import {
  GLOSSARY_TERMS_MAX,
  zGlossaryAdd,
  zGlossaryDone,
  zGlossaryList,
  zGlossaryRemove,
  zGlossaryTerms,
  zGlossaryUpdate,
  type GlossaryTerms,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { userOf } from './transcript.ts';

type Trx = QueryContext['trx'];

const notFound = () => new DomainError('GLOSSARY_TERM_NOT_FOUND', 404, 'Term not found');
const taken = () => new DomainError('GLOSSARY_TERM_TAKEN', 409, 'The glossary already has this term');

// An owner or admin of the org, as the caller. The database policy says the same; the command answers 403 first.
async function requireOwnerOrAdmin(trx: Trx, orgId: string, userId: string): Promise<void> {
  const row = await trx.selectFrom('crove_kernel.tenant_member').select('role').where('org_id', '=', orgId).where('user_id', '=', userId).executeTakeFirst();
  if (row?.role !== 'owner' && row?.role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Only an owner or admin keeps the glossary');
}

// A write that loses the race for a term is the unique index's refusal (23505), told to the person as the term being taken.
function termTaken(error: unknown): never {
  if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') throw taken();
  throw error;
}

async function termInUse(trx: Trx, orgId: string, term: string, exceptId: string | null): Promise<boolean> {
  let q = trx.selectFrom('crove_meetings.glossary_term').select('id').where('org_id', '=', orgId).where(sql<boolean>`pg_catalog.lower(term) = pg_catalog.lower(${term})`);
  if (exceptId !== null) q = q.where('id', '<>', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

async function countTerms(trx: Trx, orgId: string): Promise<number> {
  const row = await trx.selectFrom('crove_meetings.glossary_term').select(sql<string>`count(*)::text`.as('n')).where('org_id', '=', orgId).executeTakeFirstOrThrow();
  return Number(row.n);
}

export const glossaryAdd = defineCommand({
  name: 'meetings.glossary.add',
  input: zGlossaryAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await requireOwnerOrAdmin(ctx.trx, ctx.orgId, userId);
    // Two adds at 59 terms would both pass the count: one add at a time per org keeps the cap at 60.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${`crove.meetings.glossary:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    const count = await countTerms(ctx.trx, ctx.orgId);
    if (count >= GLOSSARY_TERMS_MAX) throw new DomainError('GLOSSARY_MAX', 422, `An organization keeps at most ${GLOSSARY_TERMS_MAX} terms; remove one first`);
    if (await termInUse(ctx.trx, ctx.orgId, input.term, null)) throw taken();
    const row = await ctx.trx
      .insertInto('crove_meetings.glossary_term')
      .values({ org_id: ctx.orgId, term: input.term, created_by: userId, created_at: ctx.now, updated_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(termTaken);
    ctx.audit({ termId: row.id, termCount: count + 1 });
    return zGlossaryDone.parse({ termId: row.id });
  },
});

export const glossaryUpdate = defineCommand({
  name: 'meetings.glossary.update',
  input: zGlossaryUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  target: (input) => ({ type: 'meetings.glossary_term', id: input.termId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await requireOwnerOrAdmin(ctx.trx, ctx.orgId, userId);
    const row = await ctx.trx.selectFrom('crove_meetings.glossary_term').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.termId).forUpdate().executeTakeFirst();
    if (!row) throw notFound();
    if (await termInUse(ctx.trx, ctx.orgId, input.term, input.termId)) throw taken();
    await ctx.trx
      .updateTable('crove_meetings.glossary_term')
      .set({ term: input.term, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.termId)
      .execute()
      .catch(termTaken);
    ctx.audit({ termId: input.termId, termCount: await countTerms(ctx.trx, ctx.orgId) });
    return zGlossaryDone.parse({ termId: input.termId });
  },
});

export const glossaryRemove = defineCommand({
  name: 'meetings.glossary.remove',
  input: zGlossaryRemove,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  target: (input) => ({ type: 'meetings.glossary_term', id: input.termId }),
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    await requireOwnerOrAdmin(ctx.trx, ctx.orgId, userId);
    const gone = await ctx.trx.deleteFrom('crove_meetings.glossary_term').where('org_id', '=', ctx.orgId).where('id', '=', input.termId).returning('id').executeTakeFirst();
    if (!gone) throw notFound();
    ctx.audit({ termId: input.termId, termCount: await countTerms(ctx.trx, ctx.orgId) });
    return zGlossaryDone.parse({ termId: input.termId });
  },
});

export const glossaryList = defineQuery({
  name: 'meetings.glossary.list',
  input: zGlossaryList,
  access: ['owner', 'admin'],
  handler: async (ctx): Promise<GlossaryTerms> => {
    const userId = userOf(ctx.actor);
    await requireOwnerOrAdmin(ctx.trx, ctx.orgId, userId);
    const rows = await ctx.trx
      .selectFrom('crove_meetings.glossary_term')
      .select(['id', 'term', 'created_at', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .orderBy(sql`pg_catalog.lower(term)`)
      .orderBy('id')
      .limit(GLOSSARY_TERMS_MAX)
      .execute();
    return zGlossaryTerms.parse({ terms: rows.map((r) => ({ id: r.id, term: r.term, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() })) });
  },
});

export const glossaryCommands = [glossaryAdd, glossaryUpdate, glossaryRemove];
export const glossaryQueries = [glossaryList];
