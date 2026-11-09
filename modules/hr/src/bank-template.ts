// SPDX-License-Identifier: AGPL-3.0-only
// The saved layouts of the banks' bulk-salary files (issue #2893; payroll plan docs/plan/payroll.md 6.4 and 10 row 4, ADR-0046), on crove_hr.payroll_bank_template: an owner or admin
// creates, edits and deletes a template of a legal entity, and lists them. A template holds the six columns in the bank's order with their headers and the payment's content text; it holds
// no person's data (the account numbers stay sealed on the employee rows). The table's own policies refuse everyone but owners and admins, and its check refuses a layout that is not
// valid, so these commands are not the only guard. The audit rows hold ids and the names of the changed fields, never a layout.
import type { MemberRole } from '@crove/db';
import {
  tableWrite,
  zHrBankTemplateCreate,
  zHrBankTemplateEdit,
  zHrBankTemplateList,
  zHrBankTemplateRef,
  type HrBankLayout,
  type HrBankTemplate,
  type HrBankTemplateWritten,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@crove/kernel-runtime';
import { resolveEntity } from './employees.ts';
import { hrManifest } from './manifest.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const COLUMNS = ['id', 'legal_entity_id', 'name', 'layout', 'updated_at'] as const;

const notFound = () => new DomainError('HR_BANK_TEMPLATE_NOT_FOUND', 404, 'Không tìm thấy mẫu file này');
const nameTaken = () => new DomainError('HR_BANK_TEMPLATE_NAME_TAKEN', 409, 'Pháp nhân này đã có một mẫu với tên đó');
const isNameTaken = (error: unknown): boolean => {
  const pg = error as { code?: string; constraint?: string };
  return pg.code === '23505' && pg.constraint === 'payroll_bank_template_name_uq';
};
const targetOf = (input: { templateId: string }) => ({ type: 'hr.payroll_bank_template', id: input.templateId });

export const bankTemplateCreate = defineCommand({
  name: 'hr.payroll.bank_template.create',
  input: zHrBankTemplateCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_bank_template', [...COLUMNS, 'org_id', 'created_by', 'created_at'])],
  handler: async (ctx, input): Promise<HrBankTemplateWritten> => {
    if (ctx.actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
    const legalEntityId = await resolveEntity(ctx, input.legalEntityId);
    try {
      const row = await ctx.trx
        .insertInto('crove_hr.payroll_bank_template')
        .values({ org_id: ctx.orgId, legal_entity_id: legalEntityId, name: input.name, layout: JSON.stringify(input.layout), created_by: ctx.actor.userId, created_at: ctx.now, updated_at: ctx.now })
        .returning('id')
        .executeTakeFirstOrThrow();
      ctx.audit({ templateId: row.id, legalEntityId });
      return { templateId: row.id };
    } catch (error) {
      if (isNameTaken(error)) throw nameTaken();
      throw error;
    }
  },
});

export const bankTemplateEdit = defineCommand({
  name: 'hr.payroll.bank_template.edit',
  input: zHrBankTemplateEdit,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: targetOf,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_bank_template', ['name', 'layout', 'updated_at'])],
  handler: async (ctx, input): Promise<HrBankTemplateWritten> => {
    // The row policies hide a template of an entity outside the caller's scope: it is not found, like another org's.
    const found = await ctx.trx.selectFrom('crove_hr.payroll_bank_template').select('id').where('org_id', '=', ctx.orgId).where('id', '=', input.templateId).forUpdate().executeTakeFirst();
    if (!found) throw notFound();
    try {
      await ctx.trx
        .updateTable('crove_hr.payroll_bank_template')
        .set({ ...(input.name === undefined ? {} : { name: input.name }), ...(input.layout === undefined ? {} : { layout: JSON.stringify(input.layout) }), updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.templateId)
        .execute();
    } catch (error) {
      if (isNameTaken(error)) throw nameTaken();
      throw error;
    }
    // The names of the fields the call carried, never their values.
    ctx.audit({ templateId: input.templateId, changed: Object.keys(input).filter((field) => field !== 'templateId') });
    return { templateId: input.templateId };
  },
});

export const bankTemplateDelete = defineCommand({
  name: 'hr.payroll.bank_template.delete',
  input: zHrBankTemplateRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: targetOf,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_bank_template', ['id'])],
  handler: async (ctx, input): Promise<HrBankTemplateWritten> => {
    const removed = await ctx.trx.deleteFrom('crove_hr.payroll_bank_template').where('org_id', '=', ctx.orgId).where('id', '=', input.templateId).returning('id').executeTakeFirst();
    if (!removed) throw notFound();
    ctx.audit({ templateId: input.templateId });
    return { templateId: input.templateId };
  },
});

export const bankTemplateList = defineQuery({
  name: 'hr.payroll.bank_template.list',
  input: zHrBankTemplateList,
  access: MANAGERS,
  handler: async (ctx, input): Promise<HrBankTemplate[]> => {
    const legalEntityId = await resolveEntity(ctx, input.legalEntityId);
    const rows = await ctx.trx
      .selectFrom('crove_hr.payroll_bank_template')
      .select(['id', 'legal_entity_id', 'name', 'layout', 'updated_at'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .orderBy('name')
      .orderBy('id')
      .execute();
    return rows.map((r) => ({ id: r.id, legalEntityId: r.legal_entity_id, name: r.name, layout: r.layout as unknown as HrBankLayout, updatedAt: new Date(r.updated_at).toISOString() }));
  },
});

export const hrBankTemplateCommands = [bankTemplateCreate, bankTemplateEdit, bankTemplateDelete];
export const hrBankTemplateQueries = [bankTemplateList];
