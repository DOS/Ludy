// SPDX-License-Identifier: AGPL-3.0-only
// The HR module's manifest (plan §5.2, #2530; payroll plan docs/plan/payroll.md §6.1 and §6.6): the tables it owns and the class of every column. A migration that adds or
// drops a table or column of ludy_hr changes this list in the same PR; apps/kernel/test/manifest.db.test.ts checks it against the catalog. A column is internal unless the
// second argument of columns() classifies it. The identity number and the bank account number are stored sealed under the person's own key (ADR-0017), so their columns are
// classified as what they hold (national_id, payment) and are registered in SEALED_COLUMNS (@ludy/kernel), not in the personal-data registry. The wage is sensitive: chosen to
// restrict and audit, not as a legal conclusion (payroll plan 6.6).
import { MODULE_SCREENS, columns, defineModule } from '@ludy/kernel-contract';

export const hrManifest = defineModule({
  id: 'hr',
  dependsOn: ['kernel'],
  tables: {
    ludy_hr: {
      // Daily attendance check-in/out logs (#4447 Stage 5C): note is optional free-text cleared on employee erasure.
      attendance_log: columns(
        ['org_id', 'id', 'legal_entity_id', 'employee_id', 'work_date', 'checked_in_at', 'checked_out_at', 'check_in_method', 'worked_minutes', 'status', 'created_by', 'created_at', 'updated_at'],
        { note: 'pii' },
      ),
      // Office attendance QR secret hashes per legal entity (#4447 Stage 5C): SHA-256 secret hashes, owner/admin only.
      attendance_qr_config: columns(['org_id', 'id', 'legal_entity_id', 'active', 'created_by', 'created_at', 'updated_at'], { qr_secret_hash: 'sensitive' }),
      // Employee business trip requests with 2-level approval (#4527 Stage 6B).
      business_trip_request: columns(
        ['org_id', 'id', 'legal_entity_id', 'employee_id', 'department_id', 'start_on', 'end_on', 'status', 'l1_approver_user_id', 'l1_acted_at', 'final_acted_by', 'final_acted_at', 'created_by', 'created_at', 'updated_at'],
        { estimated_allowance: 'sensitive', destination: 'pii', purpose: 'pii', decision_note: 'pii' },
      ),
      // Lightweight recruiting candidates (#3425): readable by owners and admins only, with applicant PII and wage notes classified.
      candidate: columns(
        ['org_id', 'id', 'legal_entity_id', 'opening_id', 'stage', 'source', 'years_experience', 'matched_skills', 'planned_start_on', 'interview_event_id', 'interview_starts_at', 'interview_ends_at', 'hired_employee_id', 'hired_at', 'erased_at', 'created_by', 'created_at', 'updated_at'],
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
      // Employee self-service onboarding checklist and HR-reviewed PII updates (#4448 Stage 5B).
      onboarding_submission: columns(
        ['org_id', 'id', 'legal_entity_id', 'employee_id', 'status', 'contact_confirmed', 'id_confirmed', 'bank_confirmed', 'handbook_confirmed', 'reviewed_by', 'reviewed_at', 'created_by', 'created_at', 'updated_at'],
        {
          address: 'contact',
          birth_date: 'pii',
          national_id_sealed: 'national_id',
          bank_code: 'payment',
          bank_account_sealed: 'payment',
          tax_code_sealed: 'national_id',
          insurance_number_sealed: 'national_id',
          note: 'pii',
          decision_note: 'pii',
        },
      ),
      // 2-level overtime requests feeding draft payroll runs (#4448 Stage 5B).
      overtime_request: columns(
        ['org_id', 'id', 'legal_entity_id', 'employee_id', 'department_id', 'month', 'work_date', 'hours', 'day_type', 'is_night', 'status', 'l1_approver_user_id', 'l1_acted_at', 'final_acted_by', 'final_acted_at', 'created_by', 'created_at', 'updated_at'],
        { reason: 'pii', decision_note: 'pii' },
      ),
      // Retro pay and offset deduction items reviewed by owner/admin before rolling into draft payroll (#4527 Stage 6B).
      // `amount` stays `internal` in the global bare-column map (`audit-facts.test.ts`): HR Stage 6B commands omit raw `amount` from `ctx.audit` so employee monetary figures never enter WORM `audit_event`, while DB RLS (`owner_admin`, `le_scope`), `sensitive: true` read queries, and `OWNER_RUN_EXPORT_TABLES` restrict access.
      payroll_adjustment_item: columns(
        ['org_id', 'id', 'legal_entity_id', 'employee_id', 'month', 'kind', 'amount', 'status', 'reviewed_by', 'reviewed_at', 'payroll_run_id', 'created_by', 'created_at', 'updated_at'],
        { reason: 'pii', decision_note: 'pii' },
      ),
      // The layout of one bank's bulk-salary file (#2532): the columns, their headers and the content text. Configuration, no person's data: internal.
      payroll_bank_template: columns(['org_id', 'id', 'legal_entity_id', 'name', 'layout', 'created_by', 'created_at', 'updated_at']),
      payroll_dependent: columns(['org_id', 'id', 'legal_entity_id', 'employee_id', 'relation', 'registered_on', 'ended_on', 'created_by', 'created_at'], { display_name: 'pii' }),
      payroll_employee: columns(['org_id', 'id', 'legal_entity_id', 'department_id', 'job_title', 'user_id', 'status', 'ended_on', 'erased_at', 'finalization_authorized_years', 'is_foreign', 'work_permit_exempt', 'created_by', 'created_at', 'updated_at'], {
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
        work_permit_expires_on: 'pii',
        work_permit_number_sealed: 'national_id',
      }),
      payroll_employment: columns(
        ['org_id', 'id', 'legal_entity_id', 'employee_id', 'effective_from', 'contract_type', 'contract_form', 'term_months', 'contract_end_on', 'fixed_term_sequence', 'probation_role_tier', 'probation_end_on', 'region', 'pay_function', 'pay_basis', 'tax_resident', 'created_by', 'created_at'],
        { base_wage: 'sensitive', probation_wage: 'sensitive', hourly_rate: 'sensitive', piece_rate: 'sensitive' },
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
      // End-of-probation reviews with Projects/attendance evidence snapshot and optional editable Ly draft (#4448 Stage 5B).
      probation_review: columns(
        ['org_id', 'id', 'legal_entity_id', 'employee_id', 'reviewer_user_id', 'probation_end_on', 'period_start', 'period_end', 'completed_tasks_count', 'projects_available', 'decision', 'extended_until', 'decided_at', 'created_by', 'created_at', 'updated_at'],
        { completed_tasks_snapshot: 'pii', attendance_snapshot: 'pii', review_note: 'pii', ai_draft_note: 'pii' },
      ),
      // Employee salary advance requests with 2-level approval feeding monthly draft payroll deduction Cr 141 (#4527 Stage 6B).
      // `amount` stays `internal` in the global bare-column map (`audit-facts.test.ts`): HR Stage 6B commands omit raw `amount` from `ctx.audit` so employee monetary figures never enter WORM `audit_event`, while DB RLS, `sensitive: true` read queries, and `OWNER_RUN_EXPORT_TABLES` restrict access.
      salary_advance_request: columns(
        ['org_id', 'id', 'legal_entity_id', 'employee_id', 'department_id', 'month', 'amount', 'status', 'l1_approver_user_id', 'l1_acted_at', 'final_acted_by', 'final_acted_at', 'payroll_run_id', 'created_by', 'created_at', 'updated_at'],
        { reason: 'pii', decision_note: 'pii' },
      ),
    },
  },
  // The one permission a command can name. Its risk is that of the highest command that names it: approving a month is R3. Declared with no default role: owners and admins pass by their base role, and the database's owner_admin policy enforces the same, so
  // a holder of the permission who is neither would still see no row. Who else may read or run payroll is the owner's open question (#2538), and a read permission waits for
  // a query that can name one (the sensitive queries here are gated by the base role only).
  permissions: [{ key: 'hr.payroll.run', risk: 'R3', defaultRoles: [] }],
  // Its entities (#1656): the records its commands name as their audit target. The employment rows are written by the commands of their employee and are never a target; their
  // table is append-only with the purge-aware guard (a closing org's purge deletes them), not reject_mutation, which is what audit: append_only stands for.
  entities: [
    // Daily attendance logs and office QR config (#4447 Stage 5C).
    { type: 'hr.attendance_log', table: 'attendance_log', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.attendance_qr_config', table: 'attendance_qr_config', legalEntityScoped: true, audit: 'command' },
    // Employee business trip requests (#4527 Stage 6B).
    { type: 'hr.business_trip_request', table: 'business_trip_request', legalEntityScoped: true, audit: 'command' },
    // Lightweight recruiting candidates and job openings (#3425): edited by owners and admins, audited as commands.
    { type: 'hr.candidate', table: 'candidate', legalEntityScoped: true, audit: 'command' },
    // Departments per legal entity (#3412): edited and archived by commands, so it is their audit target.
    { type: 'hr.department', table: 'department', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.job_opening', table: 'job_opening', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.leave_request', table: 'leave_request', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.onboarding_submission', table: 'onboarding_submission', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.overtime_request', table: 'overtime_request', legalEntityScoped: true, audit: 'command' },
    // Retro pay and offset deduction payroll adjustment items (#4527 Stage 6B).
    { type: 'hr.payroll_adjustment_item', table: 'payroll_adjustment_item', legalEntityScoped: true, audit: 'command' },
    // The saved layout of a bank's bulk-salary file (#2893): edited and deleted by commands, so it is their audit target.
    { type: 'hr.payroll_bank_template', table: 'payroll_bank_template', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_dependent', table: 'payroll_dependent', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_employee', table: 'payroll_employee', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_leave_entry', table: 'payroll_leave_entry', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_line', table: 'payroll_line', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.payroll_run', table: 'payroll_run', legalEntityScoped: true, audit: 'command' },
    { type: 'hr.probation_review', table: 'probation_review', legalEntityScoped: true, audit: 'command' },
    // Employee salary advance requests (#4527 Stage 6B).
    { type: 'hr.salary_advance_request', table: 'salary_advance_request', legalEntityScoped: true, audit: 'command' },
  ],
  // Its screens in the app and its menu items (#1652), kept with the other modules' in @ludy/kernel-contract.
  ...MODULE_SCREENS.hr,
});
