// SPDX-License-Identifier: AGPL-3.0-only
import { hrEmployeeCommands, hrEmployeeQueries } from './employees.ts';
import { hrPayrollCommands, hrPayrollQueries } from './payroll-run.ts';
import { hrPaymentCommands, hrPaymentQueries } from './payroll-payment.ts';
import { hrPostingCommands } from './payroll-posting.ts';
import { hrBankFileCommands, hrBankFileQueries } from './bank-file.ts';
import { hrDeclarationCommands, hrDeclarationQueries } from './declaration-export.ts';
import { hrBankTemplateCommands, hrBankTemplateQueries } from './bank-template.ts';
import { hrDepartmentCommands, hrDepartmentQueries } from './departments.ts';
import { hrLeaveCommands, hrLeaveQueries } from './leave.ts';
import { hrRecruitingCommands, hrRecruitingQueries } from './recruiting.ts';

export * from './departments.ts';
export * from './employees.ts';
export * from './leave.ts';
export * from './recruiting.ts';
export * from './payroll-run.ts';
export * from './payroll-posting.ts';
export * from './declarations.ts';
export * from './labor-register.ts';
export * from './bank-template.ts';
export { declarationMonths, type HrLaborCheckFact, type HrLaborCheckSnapshot } from './declaration-export.ts';
export { buildDeclarationWorkbook, amountCell } from './declaration-xlsx.ts';
export { buildBankFileWorkbook } from './bank-file-xlsx.ts';

export const hrCommands = [...hrDepartmentCommands, ...hrEmployeeCommands, ...hrPayrollCommands, ...hrPostingCommands, ...hrPaymentCommands, ...hrBankFileCommands, ...hrDeclarationCommands, ...hrBankTemplateCommands, ...hrLeaveCommands, ...hrRecruitingCommands];
export const hrQueries = [...hrDepartmentQueries, ...hrEmployeeQueries, ...hrPayrollQueries, ...hrPaymentQueries, ...hrBankFileQueries, ...hrDeclarationQueries, ...hrBankTemplateQueries, ...hrLeaveQueries, ...hrRecruitingQueries];
export { hrManifest } from './manifest.ts';
