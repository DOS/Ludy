// SPDX-License-Identifier: AGPL-3.0-only
import { accountCommands, accountQueries } from './accounts.ts';
import { summaryQueries } from './summary.ts';
import { syncCommands, syncQueries } from './sync.ts';

export * from './accounts.ts';
export * from './domain.ts';
export * from './summary.ts';
export * from './sync.ts';

export const adsCommands = [...accountCommands, ...syncCommands];
export const adsQueries = [...accountQueries, ...syncQueries, ...summaryQueries];
export { adsManifest } from './manifest.ts';
