// SPDX-License-Identifier: AGPL-3.0-only
import { hrEmployeeCommands, hrEmployeeQueries } from './employees.ts';
import { hrPayrollCommands, hrPayrollQueries } from './payroll-run.ts';
import { hrPaymentCommands } from './payroll-payment.ts';
import { hrPostingCommands } from './payroll-posting.ts';

export * from './employees.ts';
export * from './payroll-run.ts';
export * from './payroll-posting.ts';
export * from './declarations.ts';

export const hrCommands = [...hrEmployeeCommands, ...hrPayrollCommands, ...hrPostingCommands, ...hrPaymentCommands];
export const hrQueries = [...hrEmployeeQueries, ...hrPayrollQueries];
export { hrManifest } from './manifest.ts';
