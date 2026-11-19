// SPDX-License-Identifier: AGPL-3.0-only
// Managing a running ad (ads W4, issue #3835, ADR-0043, plan docs/plan/ads-write.md sections 3.1 and 10): pause, resume and archive the campaign, the ad set or an ad of a live
// launch, lower or raise its daily budget, shorten or extend its schedule (the budget and the end date are the ad set's). A resume, a raise and an extension can start or
// raise spend, so each is an R3 proposal approved like a launch (its payload below is what the approver signs); a pause, an archive, a lower budget and a shorter schedule only
// reduce spend and are an owner's or an admin's own R2 commands. Money is a decimal string in the account's own units, never a number.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

// A budget as a person types it (the same rule as the plan's, ads-campaign.ts: this file cannot import it, since that file imports this one).
const zAdsBudget = z.string().regex(/^(?!0+(\.0+)?$)\d{1,13}(\.\d{1,2})?$/, 'a decimal above zero, at most 13 digits before the point');
const zCurrency = z.string().regex(/^[A-Z]{3}$/);
const zAmount = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/);

// The objects of a launch that have a status of their own: the campaign, the ad set and an ad per text variant (a creative has none).
export const ADS_MANAGE_SLOTS = ['campaign', 'ad_set', 'ad_1', 'ad_2', 'ad_3'] as const;
export type AdsManageSlot = (typeof ADS_MANAGE_SLOTS)[number];
export const zAdsManageSlot = z.enum(ADS_MANAGE_SLOTS);

export const ADS_MANAGE_KINDS = ['pause', 'resume', 'archive', 'budget_lower', 'budget_raise', 'schedule_shorten', 'schedule_extend'] as const;
export type AdsManageKind = (typeof ADS_MANAGE_KINDS)[number];
// What can start or raise spend: approved like a launch.
export const ADS_MANAGE_APPROVED_KINDS = ['resume', 'budget_raise', 'schedule_extend'] as const;
// queued: asked, the platform has not confirmed it; applied: confirmed; failed: refused or never reached; cancelled: never begun; unclear: the answer could not be told in the
// time Ludy waits, so it may have applied (the amount a raise or an extension would add stays held against the caps).
export const ADS_MANAGE_STATES = ['queued', 'applied', 'failed', 'cancelled', 'unclear'] as const;
export type AdsManageState = (typeof ADS_MANAGE_STATES)[number];

export const ADS_OBJECT_PAUSE_COMMAND = 'ads.object.pause';
export const ADS_OBJECT_ARCHIVE_COMMAND = 'ads.object.archive';
export const ADS_OBJECT_RESUME_COMMAND = 'ads.object.resume';
export const ADS_BUDGET_LOWER_COMMAND = 'ads.budget.lower';
export const ADS_BUDGET_RAISE_COMMAND = 'ads.budget.raise';
export const ADS_SCHEDULE_SHORTEN_COMMAND = 'ads.schedule.shorten';
export const ADS_SCHEDULE_EXTEND_COMMAND = 'ads.schedule.extend';
export const ADS_OBJECT_RESUME_KIND = 'ads.object_resume';
export const ADS_BUDGET_RAISE_KIND = 'ads.budget_raise';
export const ADS_SCHEDULE_EXTEND_KIND = 'ads.schedule_extend';

// One requested change, as the screen lists it.
export const zAdsManageChangeView = z.object({
  id: zId,
  kind: z.enum(ADS_MANAGE_KINDS),
  slot: zAdsManageSlot,
  state: z.enum(ADS_MANAGE_STATES),
  fromBudget: z.string().nullable(),
  toBudget: z.string().nullable(),
  fromEndOn: z.string().nullable(),
  toEndOn: z.string().nullable(),
  // Why it did not apply (a short code), null otherwise.
  code: z.string().nullable(),
  requestedAt: z.string(),
  settledAt: z.string().nullable(),
});
export type AdsManageChangeView = z.infer<typeof zAdsManageChangeView>;

// What a person can do to one object now, from the changes the platform confirmed. `status` is what Ludy last set it to (a launch's objects are on once it is live);
// `pending` is the change of its status that waits for the platform.
export const ADS_MANAGE_OBJECT_STATUSES = ['active', 'paused', 'archived'] as const;
export const zAdsManageObjectView = z.object({
  slot: zAdsManageSlot,
  level: z.enum(['campaign', 'ad_set', 'ad']),
  name: z.string(),
  status: z.enum(ADS_MANAGE_OBJECT_STATUSES),
  pending: z.enum(ADS_MANAGE_KINDS).nullable(),
});
export type AdsManageObjectView = z.infer<typeof zAdsManageObjectView>;

// The management state of one launch, for the Campaigns screen: the daily budget and the last day the platform confirmed, the same as the launch holds against the caps (the
// higher of that and a raise or an extension that is still waiting), the objects and the recent changes. Members read it; only owners and admins get the controls.
export const zAdsManageStateView = z.object({
  launchId: zId,
  currency: zCurrency,
  dailyBudget: z.string(),
  endOn: z.string(),
  heldDailyBudget: z.string(),
  heldEndOn: z.string(),
  // Whether the controls can act now: the launch is live, running ads is on for the org and the account, and launches are not blocked (a pause needs none of it).
  canChange: z.boolean(),
  objects: z.array(zAdsManageObjectView),
  changes: z.array(zAdsManageChangeView),
});
export type AdsManageStateView = z.infer<typeof zAdsManageStateView>;

// The API calls of the R2 commands (owners and admins), with the idempotency key.
export const zAdsObjectCall = z.strictObject({ launchId: zId, slot: zAdsManageSlot, idempotencyKey: zId });
export const zAdsBudgetLowerCall = z.strictObject({ launchId: zId, dailyBudget: zAdsBudget, idempotencyKey: zId });
export const zAdsScheduleShortenCall = z.strictObject({ launchId: zId, endOn: zLocalDate, idempotencyKey: zId });
export const zAdsManageCancelCall = z.strictObject({ changeId: zId, idempotencyKey: zId });
export const zAdsManageChanged = z.object({ changeId: zId, launchId: zId, kind: z.enum(ADS_MANAGE_KINDS), state: z.enum(ADS_MANAGE_STATES) });
export type AdsManageChanged = z.infer<typeof zAdsManageChanged>;

// The three proposals. `amount` is the largest amount the launch can spend with the change (the budget times the days of the flight), the one number the approver signs and the
// database's guard compares; the names are display copies, the ids, values and amounts are the change.
const zManageBase = {
  launchId: zId,
  adAccountId: zId,
  adAccountName: z.string().max(200),
  campaignName: z.string().max(200),
  slot: zAdsManageSlot,
  currency: zCurrency,
  startOn: zLocalDate,
  amount: zAmount,
  // The largest amount the launch could spend before the change, for the approver to compare with.
  previousAmount: zAmount,
};
export const zAdsObjectResumePayload = z.strictObject({
  ...zManageBase,
  objectName: z.string().max(400),
  dailyBudget: zAdsBudget,
  endOn: zLocalDate,
});
export const zAdsBudgetRaisePayload = z.strictObject({ ...zManageBase, fromBudget: zAdsBudget, toBudget: zAdsBudget, endOn: zLocalDate });
export const zAdsScheduleExtendPayload = z.strictObject({ ...zManageBase, dailyBudget: zAdsBudget, fromEndOn: zLocalDate, toEndOn: zLocalDate });
export type AdsObjectResumePayload = z.infer<typeof zAdsObjectResumePayload>;
export type AdsBudgetRaisePayload = z.infer<typeof zAdsBudgetRaisePayload>;
export type AdsScheduleExtendPayload = z.infer<typeof zAdsScheduleExtendPayload>;

// What Uy suggests for a campaign that spends with poor results (deterministic, from the cost-per-result flag the sync's figures already raise, no model call): a person applies it
// with the ordinary command, which is the person's own; Uy never applies a change and never suggests a raise.
export const ADS_MANAGE_SUGGESTION_KINDS = ['pause', 'budget_lower'] as const;
export const zAdsManageSuggestion = z.object({
  launchId: zId,
  adAccountId: zId,
  campaignName: z.string(),
  kind: z.enum(ADS_MANAGE_SUGGESTION_KINDS),
  // The object a pause is for (the campaign), and for a lower budget the figure suggested, always below the one the launch holds.
  slot: zAdsManageSlot,
  toBudget: z.string().nullable(),
  currency: zCurrency,
  // The figures the suggestion rests on, decimal strings in the account's currency: the cost per result of the last days against the median of the days before, and by how many
  // times it is over.
  recentCost: z.string(),
  medianCost: z.string(),
  ratio: z.string(),
  recentResults: z.string(),
  day: zLocalDate,
});
export type AdsManageSuggestion = z.infer<typeof zAdsManageSuggestion>;
