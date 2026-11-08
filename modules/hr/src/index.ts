// SPDX-License-Identifier: AGPL-3.0-only
import { hrEmployeeCommands, hrEmployeeQueries } from './employees.ts';
import { hrPayrollCommands, hrPayrollQueries } from './payroll-run.ts';
import { hrPaymentCommands } from './payroll-payment.ts';
import { hrPostingCommands } from './payroll-posting.ts';
import { hrBankFileCommands, hrBankFileQueries } from './bank-file.ts';
import { hrDeclarationCommands, hrDeclarationQueries } from './declaration-export.ts';

export * from './employees.ts';
export * from './payroll-run.ts';
export * from './payroll-posting.ts';
export * from './declarations.ts';
export { declarationMonths } from './declaration-export.ts';
export { buildDeclarationWorkbook, amountCell } from './declaration-xlsx.ts';
export { buildBankFileWorkbook } from './bank-file-xlsx.ts';

export const hrCommands = [...hrEmployeeCommands, ...hrPayrollCommands, ...hrPostingCommands, ...hrPaymentCommands, ...hrBankFileCommands, ...hrDeclarationCommands];
export const hrQueries = [...hrEmployeeQueries, ...hrPayrollQueries, ...hrBankFileQueries, ...hrDeclarationQueries];
export { hrManifest } from './manifest.ts';
