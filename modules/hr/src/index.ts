// SPDX-License-Identifier: AGPL-3.0-only
import { hrEmployeeCommands, hrEmployeeQueries } from './employees.ts';
import { hrPayrollCommands, hrPayrollQueries } from './payroll-run.ts';

export * from './employees.ts';
export * from './payroll-run.ts';

export const hrCommands = [...hrEmployeeCommands, ...hrPayrollCommands];
export const hrQueries = [...hrEmployeeQueries, ...hrPayrollQueries];
export { hrManifest } from './manifest.ts';
