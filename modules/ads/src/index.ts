// SPDX-License-Identifier: AGPL-3.0-only
import { accountCommands, accountQueries } from './accounts.ts';
import { flagSettingCommands, flagSettingQueries } from './flag-settings.ts';
import { campaignCommands, campaignQueries } from './campaign-draft.ts';
import { campaignRequestCommands, campaignRequestQueries } from './campaign-request.ts';
import { flagQueries } from './spend-flags.ts';
import { summaryQueries } from './summary.ts';
import { syncCommands, syncQueries } from './sync.ts';
import { todayQueries } from './today.ts';
import { writeCommands, writeQueries } from './write.ts';
import { tokenRevokeCommands } from './token-revoke-commands.ts';
import { writeConnectionCommands, writeConnectionQueries } from './write-connection.ts';

export * from './accounts.ts';
export * from './campaign-draft.ts';
export * from './campaign-plan.ts';
export * from './campaign-request.ts';
export * from './domain.ts';
export * from './flag-settings.ts';
export * from './flags.ts';
export * from './spend-flags.ts';
export * from './summary.ts';
export * from './sync.ts';
export * from './today.ts';
export * from './write.ts';

export const adsCommands = [...accountCommands, ...syncCommands, ...writeConnectionCommands, ...tokenRevokeCommands, ...writeCommands, ...flagSettingCommands, ...campaignCommands, ...campaignRequestCommands];
export const adsQueries = [...accountQueries, ...syncQueries, ...summaryQueries, ...flagQueries, ...flagSettingQueries, ...todayQueries, ...campaignQueries, ...campaignRequestQueries, ...writeConnectionQueries, ...writeQueries];
export { adsManifest } from './manifest.ts';
