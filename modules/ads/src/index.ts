// SPDX-License-Identifier: AGPL-3.0-only
import { accountCommands, accountQueries } from './accounts.ts';
import { flagQueries } from './spend-flags.ts';
import { summaryQueries } from './summary.ts';
import { syncCommands, syncQueries } from './sync.ts';
import { writeCommands, writeQueries } from './write.ts';
import { writeConnectionCommands, writeConnectionQueries } from './write-connection.ts';

export * from './accounts.ts';
export * from './domain.ts';
export * from './flags.ts';
export * from './spend-flags.ts';
export * from './summary.ts';
export * from './sync.ts';
export * from './write.ts';

export const adsCommands = [...accountCommands, ...syncCommands, ...writeConnectionCommands, ...writeCommands];
export const adsQueries = [...accountQueries, ...syncQueries, ...summaryQueries, ...flagQueries, ...writeConnectionQueries, ...writeQueries];
export { adsManifest } from './manifest.ts';
