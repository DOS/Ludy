// SPDX-License-Identifier: AGPL-3.0-only
// Minutes templates an organization writes (#3578, owner direction of 2026-11-17: the core of Meetings first). The contract is packages/kernel-contract/src/meeting-minutes-templates.ts.
//
// meetings.template.create    an owner or admin writes a template: a name and 1 to 8 sections (title and hint for Vy). Code makes the keys.
// meetings.template.update    renames it and replaces its sections; a section that exists keeps its key, a new one gets the next one. An archived template cannot be edited.
// meetings.template.archive   takes it off the recorder's list. No restore, no delete. Meetings already on it keep their own copy of its sections (set_template, results.ts).
// meetings.template.list      every member reads the active templates (layout, not personal data); an owner or admin also sees the archived ones, read only.
//
// The database holds the same rules: a restrictive row policy lets only an owner or admin of the org, in a user context, write the table, and crove_meetings.minutes_sections_ok
// pins the shape of the sections. The audit row of a command carries the template's id and the number of sections, never a name or a hint (the audit scan keeps every column called name out).
import { sql } from 'kysely';
import {
  TEMPLATES_ACTIVE_MAX,
  assignSectionKeys,
  parseStoredSections,
  zMinutesTemplateArchive,
  zMinutesTemplateCreate,
  zMinutesTemplateDone,
  zMinutesTemplateList,
  zMinutesTemplateUpdate,
  zMinutesTemplates,
  type MinutesTemplateView,
  type MinutesTemplates,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { ROLES, userOf } from './transcript.ts';

type Trx = QueryContext['trx'];

const notFound = () => new DomainError('MINUTES_TEMPLATE_NOT_FOUND', 404, 'Template not found');
const invalidSections = () => new DomainError('MINUTES_TEMPLATE_SECTIONS_INVALID', 422, 'A section is not one of this template\'s, or is listed twice');

// An owner or admin of the org, as the caller. The database policy says the same; the command answers 403 first.
async function isOwnerOrAdmin(trx: Trx, orgId: string, userId: string): Promise<boolean> {
  const row = await trx.selectFrom('crove_kernel.tenant_member').select('role').where('org_id', '=', orgId).where('user_id', '=', userId).executeTakeFirst();
  return row?.role === 'owner' || row?.role === 'admin';
}

const nameTakenError = () => new DomainError('MINUTES_TEMPLATE_NAME_TAKEN', 409, 'Another template of this organization has this name');

// A write that loses the race for a name is the unique index's refusal (23505), told to the person as the name being taken.
function nameTaken(error: unknown): never {
  if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') throw nameTakenError();
  throw error;
}

async function nameInUse(trx: Trx, orgId: string, name: string, exceptId: string | null): Promise<boolean> {
  let q = trx
    .selectFrom('crove_meetings.minutes_template')
    .select('id')
    .where('org_id', '=', orgId)
    .where('archived_at', 'is', null)
    .where(sql<boolean>`pg_catalog.lower(name) = pg_catalog.lower(${name})`);
  if (exceptId !== null) q = q.where('id', '<>', exceptId);
  return (await q.executeTakeFirst()) !== undefined;
}

export const minutesTemplateCreate = defineCommand({
  name: 'meetings.template.create',
  input: zMinutesTemplateCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  handler: async (ctx, input) => {
    const userId = userOf(ctx.actor);
    const sections = assignSectionKeys([], input.sections);
    // A new template has no keys to keep: one sent with a key is a request for a section that does not exist.
    if (sections === null) throw invalidSections();
    const active = await ctx.trx
      .selectFrom('crove_meetings.minutes_template')
      .select(sql<string>`count(*)::text`.as('n'))
      .where('org_id', '=', ctx.orgId)
      .where('archived_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(active.n) >= TEMPLATES_ACTIVE_MAX) throw new DomainError('MINUTES_TEMPLATES_MAX', 422, `An organization keeps at most ${TEMPLATES_ACTIVE_MAX} templates; archive one first`);
    if (await nameInUse(ctx.trx, ctx.orgId, input.name, null)) throw nameTakenError();
    const row = await ctx.trx
      .insertInto('crove_meetings.minutes_template')
      .values({ org_id: ctx.orgId, name: input.name, sections: JSON.stringify(sections), created_by: userId, created_at: ctx.now, updated_at: ctx.now })
      .returning('id')
      .executeTakeFirstOrThrow()
      .catch(nameTaken);
    ctx.audit({ templateId: row.id, sectionCount: sections.length });
    return zMinutesTemplateDone.parse({ templateId: row.id, archived: false });
  },
});

export const minutesTemplateUpdate = defineCommand({
  name: 'meetings.template.update',
  input: zMinutesTemplateUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  target: (input) => ({ type: 'meetings.minutes_template', id: input.templateId }),
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    const row = await ctx.trx
      .selectFrom('crove_meetings.minutes_template')
      .select(['sections', 'archived_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.templateId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.archived_at !== null) throw new DomainError('MINUTES_TEMPLATE_ARCHIVED', 409, 'An archived template cannot be edited');
    const sections = assignSectionKeys(parseStoredSections(row.sections), input.sections);
    if (sections === null) throw invalidSections();
    if (await nameInUse(ctx.trx, ctx.orgId, input.name, input.templateId)) throw nameTakenError();
    await ctx.trx
      .updateTable('crove_meetings.minutes_template')
      .set({ name: input.name, sections: JSON.stringify(sections), updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.templateId)
      .execute()
      .catch(nameTaken);
    ctx.audit({ templateId: input.templateId, sectionCount: sections.length });
    return zMinutesTemplateDone.parse({ templateId: input.templateId, archived: false });
  },
});

export const minutesTemplateArchive = defineCommand({
  name: 'meetings.template.archive',
  input: zMinutesTemplateArchive,
  risk: 'R1',
  sideEffect: 'internal',
  access: ['owner', 'admin'],
  target: (input) => ({ type: 'meetings.minutes_template', id: input.templateId }),
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    const row = await ctx.trx
      .selectFrom('crove_meetings.minutes_template')
      .select(['archived_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.templateId)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw notFound();
    if (row.archived_at === null) {
      await ctx.trx.updateTable('crove_meetings.minutes_template').set({ archived_at: ctx.now, updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', input.templateId).execute();
    }
    ctx.audit({ templateId: input.templateId, alreadyArchived: row.archived_at !== null });
    return zMinutesTemplateDone.parse({ templateId: input.templateId, archived: true });
  },
});

export const minutesTemplateList = defineQuery({
  name: 'meetings.template.list',
  input: zMinutesTemplateList,
  access: ROLES,
  handler: async (ctx): Promise<MinutesTemplates> => {
    const userId = userOf(ctx.actor);
    const admin = await isOwnerOrAdmin(ctx.trx, ctx.orgId, userId);
    let q = ctx.trx
      .selectFrom('crove_meetings.minutes_template')
      .select(['id', 'name', 'sections', 'archived_at', 'created_at', 'updated_at'])
      .where('org_id', '=', ctx.orgId);
    // A member sees the active templates; an owner or admin also sees the archived ones, which they cannot edit.
    if (!admin) q = q.where('archived_at', 'is', null);
    const rows = await q.orderBy('archived_at', sql`asc nulls first`).orderBy(sql`pg_catalog.lower(name)`).orderBy('id').execute();
    const templates: MinutesTemplateView[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      sections: parseStoredSections(r.sections),
      archived: r.archived_at !== null,
      createdAt: r.created_at.toISOString(),
      updatedAt: r.updated_at.toISOString(),
    }));
    return zMinutesTemplates.parse({ templates });
  },
});

export const minutesTemplateCommands = [minutesTemplateCreate, minutesTemplateUpdate, minutesTemplateArchive];
export const minutesTemplateQueries = [minutesTemplateList];
