// SPDX-License-Identifier: AGPL-3.0-only
// The HR module's manifest (plan §5.2, #2530; payroll plan docs/plan/payroll.md §6.1 and §6.6): the tables it owns and the class of every column. A migration that adds or
// drops a table or column of crove_hr changes this list in the same PR; apps/kernel/test/manifest.db.test.ts checks it against the catalog. A column is internal unless the
// second argument of columns() classifies it. The identity number and the bank account number are stored sealed under the person's own key (ADR-0017), so their columns are
// classified as what they hold (national_id, payment) and are registered in SEALED_COLUMNS (@crove/kernel), not in the personal-data registry. The wage is sensitive: chosen to
// restrict and audit, not as a legal conclusion (payroll plan 6.6).
import { MODULE_SCREENS, columns, defineModule } from '@crove/kernel-contract';

export const hrManifest = defineModule({
  id: 'hr',
  dependsOn: ['kernel'],
  tables: {
    crove_hr: {
      payroll_dependent: columns(['org_id', 'id', 'legal_entity_id', 'employee_id', 'relation', 'registered_on', 'ended_on', 'created_by', 'created_at'], { display_name: 'pii' }),
      payroll_employee: columns(['org_id', 'id', 'legal_entity_id', 'status', 'ended_on', 'erased_at', 'created_by', 'created_at', 'updated_at'], {
        display_name: 'pii',
        address: 'contact',
        national_id_sealed: 'national_id',
        bank_account_sealed: 'payment',
      }),
      payroll_employment: columns(['org_id', 'id', 'legal_entity_id', 'employee_id', 'effective_from', 'contract_type', 'region', 'created_by', 'created_at'], { base_wage: 'sensitive' }),
    },
  },
  // The one permission a command can name. Declared with no default role: owners and admins pass by their base role, and the database's owner_admin policy enforces the same, so
  // a holder of the permission who is neither would still see no row. Who else may read or run payroll is the owner's open question (#2538), and a read permission waits for
  // a query that can name one (the sensitive queries here are gated by the base role only).
  permissions: [{ key: 'hr.payroll.run', risk: 'R1', defaultRoles: [] }],
  // Its entities (#1656): the records its commands name as their audit target. The employment rows are written by the commands of their employee and are never a target; their
  // table is append-only with the purge-aware guard (a closing org's purge deletes them), not reject_mutation, which is what audit: append_only stands for.
  entities: [
    { type: 'hr.payroll_dependent', table: 'payroll_dependent', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_employee', table: 'payroll_employee', legalEntityScoped: true, audit: 'command' },
  ],
  // Its screens in the app and its menu items (#1652), kept with the other modules' in @crove/kernel-contract.
  ...MODULE_SCREENS.hr,
});
