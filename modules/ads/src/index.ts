// SPDX-License-Identifier: AGPL-3.0-only
import { accountCommands, accountQueries } from './accounts.ts';
import { flagSettingCommands, flagSettingQueries } from './flag-settings.ts';
import { campaignCommands, campaignQueries } from './campaign-draft.ts';
import { campaignRequestCommands, campaignRequestQueries } from './campaign-request.ts';
import { launchActivateCommands } from './launch-activate.ts';
import { launchRunCommands } from './launch-run.ts';
import { launchPauseCommands, launchPauseQueries } from './launch-pause.ts';
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
export * from './launch-activate.ts';
export * from './launch-activation.ts';
export * from './launch-pause.ts';
export * from './launch-pause-policy.ts';
export * from './launch-run.ts';
export * from './launch-steps.ts';
export * from './spend-flags.ts';
export * from './summary.ts';
export * from './sync.ts';
export * from './today.ts';
export * from './write.ts';

export const adsCommands = [...accountCommands, ...syncCommands, ...writeConnectionCommands, ...tokenRevokeCommands, ...writeCommands, ...flagSettingCommands, ...campaignCommands, ...campaignRequestCommands, ...launchRunCommands, ...launchPauseCommands, ...launchActivateCommands];
export const adsQueries = [...accountQueries, ...syncQueries, ...summaryQueries, ...flagQueries, ...flagSettingQueries, ...todayQueries, ...campaignQueries, ...campaignRequestQueries, ...writeConnectionQueries, ...writeQueries, ...launchPauseQueries];
export { adsManifest } from './manifest.ts';
