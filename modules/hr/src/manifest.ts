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
      // Lightweight recruiting candidates (#3425): readable by owners and admins only, with applicant PII and wage notes classified.
      candidate: columns(
        ['org_id', 'id', 'legal_entity_id', 'opening_id', 'stage', 'years_experience', 'matched_skills', 'planned_start_on', 'interview_event_id', 'interview_starts_at', 'interview_ends_at', 'hired_employee_id', 'erased_at', 'created_by', 'created_at', 'updated_at'],
        { display_name: 'pii', email: 'contact', phone: 'contact', notes: 'pii', expected_wage: 'sensitive', agreed_wage: 'sensitive' },
      ),
      // Departments per legal entity (#3412, #4300): optional team structure with default pay_function and optional L1 leave manager. Org master data: internal.
      department: columns(['org_id', 'id', 'legal_entity_id', 'name', 'code', 'pay_function', 'manager_user_id', 'archived_at', 'created_by', 'created_at', 'updated_at']),
      // Lightweight recruiting job openings (#3425): role requirements and pay bands per legal entity, readable by owners and admins only.
      job_opening: columns(['org_id', 'id', 'legal_entity_id', 'department_id', 'title', 'department_name', 'contract_type', 'region', 'pay_function', 'budget_min_wage', 'budget_max_wage', 'required_skills', 'status', 'closed_at', 'created_by', 'created_at', 'updated_at']),
      // Employee leave requests with L1 -> final approval state machine (#4300): reason and decision_note hold user-written PII/text.
      leave_request: columns(
        ['org_id', 'id', 'legal_entity_id', 'employee_id', 'department_id', 'month', 'start_on', 'end_on', 'kind', 'days', 'status', 'l1_approver_user_id', 'l1_acted_at', 'final_acted_by', 'final_acted_at', 'payroll_leave_entry_id', 'created_by', 'created_at', 'updated_at'],
        { reason: 'pii', decision_note: 'pii' },
      ),
      // The layout of one bank's bulk-salary file (#2532): the columns, their headers and the content text. Configuration, no person's data: internal.
      payroll_bank_template: columns(['org_id', 'id', 'legal_entity_id', 'name', 'layout', 'created_by', 'created_at', 'updated_at']),
      payroll_dependent: columns(['org_id', 'id', 'legal_entity_id', 'employee_id', 'relation', 'registered_on', 'ended_on', 'created_by', 'created_at'], { display_name: 'pii' }),
      payroll_employee: columns(['org_id', 'id', 'legal_entity_id', 'department_id', 'job_title', 'user_id', 'status', 'ended_on', 'erased_at', 'finalization_authorized_years', 'created_by', 'created_at', 'updated_at'], {
        display_name: 'pii',
        // The code of the bank the person is paid at (#2897): a plain column (a bank's code alone identifies no one), read only by the audited sensitive paths, cleared by the erasure.
        bank_code: 'payment',
        birth_date: 'pii',
        // The tax code and the social insurance number are in most cases the identity number (since 2025-07-01): sealed and classified like it (#2533).
        tax_code_sealed: 'national_id',
        insurance_number_sealed: 'national_id',
        address: 'contact',
        national_id_sealed: 'national_id',
        bank_account_sealed: 'payment',
      }),
      payroll_employment: columns(
        ['org_id', 'id', 'legal_entity_id', 'employee_id', 'effective_from', 'contract_type', 'contract_form', 'term_months', 'contract_end_on', 'fixed_term_sequence', 'probation_role_tier', 'probation_end_on', 'region', 'pay_function', 'created_by', 'created_at'],
        { base_wage: 'sensitive', probation_wage: 'sensitive' },
      ),
      // Monthly employee leave ledger (#3394, #3411, #2540 slice 1c-2): opening balance, annual leave, personal paid leave and unpaid leave.
      // Kept `internal` (unlike `payroll_line.inputs`, which holds VND pay amounts): `days` holds plain day counts (0..366) with no money, PII or free text,
      // `leaveSet` and `leaveDelete` omit raw day counts from `ctx.audit` facts so they never enter WORM `audit_event`, database RLS (`owner_admin`, `le_scope`)
      // and `sensitive: true` read queries (`hr.payroll.leave.balance`, `hr.payroll.run.sheet`) restrict access to owners and admins, offboarding uses
      // `OWNER_RUN_EXPORT_TABLES`, and under Accounting Law 88/2015 Art. 41 (`HR_RETENTION_YEARS = 10`) rows stay as anonymized day counts once
      // `hr.payroll.employee.erase` clears employee PII and shreds `subject_key` (and `org_purge` deletes them on org closure).
      payroll_leave_entry: columns(['org_id', 'id', 'legal_entity_id', 'employee_id', 'month', 'kind', 'days', 'approved', 'created_by', 'created_at', 'updated_at']),
      // The pay run (#2531): one month of one legal entity, and a line per person. The wage figures, the month's inputs, the breakdown and an adjustment line's free-text note are
      // sensitive like the wage they come from (on an approved run a frozen line's note survives employee erasure under Accounting Law 88/2015 Art. 41 10-year retention until org_purge, #2720);
      // the approval record holds the totals, so it is too. The ids, the status and the dates are internal.
      payroll_line: columns(['org_id', 'id', 'legal_entity_id', 'run_id', 'employee_id', 'employment_id', 'kind', 'status', 'checks', 'rules_used', 'refusal', 'adjusts_run_id', 'created_by', 'created_at', 'updated_at'], {
        inputs: 'sensitive',
        gross: 'sensitive',
        employee_insurance: 'sensitive',
        employer_insurance: 'sensitive',
        union_fee: 'sensitive',
        taxable_income: 'sensitive',
        pit: 'sensitive',
        net: 'sensitive',
        employer_cost: 'sensitive',
        breakdown: 'sensitive',
        note: 'sensitive',
      }),
      payroll_run: columns(['org_id', 'id', 'legal_entity_id', 'month', 'status', 'working_days', 'approved_by', 'approved_at', 'created_by', 'created_at', 'updated_at'], { approval: 'sensitive' }),
    },
  },
  // The one permission a command can name. Its risk is that of the highest command that names it: approving a month is R3. Declared with no default role: owners and admins pass by their base role, and the database's owner_admin policy enforces the same, so
  // a holder of the permission who is neither would still see no row. Who else may read or run payroll is the owner's open question (#2538), and a read permission waits for
  // a query that can name one (the sensitive queries here are gated by the base role only).
  permissions: [{ key: 'hr.payroll.run', risk: 'R3', defaultRoles: [] }],
  // Its entities (#1656): the records its commands name as their audit target. The employment rows are written by the commands of their employee and are never a target; their
  // table is append-only with the purge-aware guard (a closing org's purge deletes them), not reject_mutation, which is what audit: append_only stands for.
  entities: [
    // Lightweight recruiting candidates and job openings (#3425): edited by owners and admins, audited as commands.
    { type: 'hr.candidate', table: 'candidate', legalEntityScoped: true, audit: 'command' },
    // Departments per legal entity (#3412): edited and archived by commands, so it is their audit target.
    { type: 'hr.department', table: 'department', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.job_opening', table: 'job_opening', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.leave_request', table: 'leave_request', legalEntityScoped: true, audit: 'command' },
    // The saved layout of a bank's bulk-salary file (#2893): edited and deleted by commands, so it is their audit target.
    { type: 'hr.payroll_bank_template', table: 'payroll_bank_template', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_dependent', table: 'payroll_dependent', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_employee', table: 'payroll_employee', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_leave_entry', table: 'payroll_leave_entry', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_line', table: 'payroll_line', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_run', table: 'payroll_run', legalEntityScoped: true, audit: 'command' },
  ],
  // Its screens in the app and its menu items (#1652), kept with the other modules' in @crove/kernel-contract.
  ...MODULE_SCREENS.hr,
});
