// SPDX-License-Identifier: AGPL-3.0-only
import { hrEmployeeCommands, hrEmployeeQueries } from './employees.ts';

export * from './employees.ts';

export const hrCommands = [...hrEmployeeCommands];
export const hrQueries = [...hrEmployeeQueries];
export { hrManifest } from './manifest.ts';
