// SPDX-License-Identifier: AGPL-3.0-only
// The campaign plan of running ads (W1, issue #2295, plan docs/plan/ads-write.md section 10, ADR-0043): what a person or the AI coworker drafts, what
// local validation judges, and what an approver is shown and signs. The first slice is lean on purpose: one campaign, one ad set and one ad with up
// to three text variants; objectives Traffic, Engagement and Messenger; targeting by location, age range and gender with an optional list of
// interests; automatic placements only; a daily budget and an end date. Nothing here calls a platform: the plan is local until W2 launches it.
// Money is a decimal string in the account's currency, never a number.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

// The objectives of the first slice (owner Q4): none needs a pixel, a customer list or a lead form.
export const ADS_OBJECTIVES = ['traffic', 'engagement', 'messenger'] as const;
export type AdsObjective = (typeof ADS_OBJECTIVES)[number];
export const ADS_GENDERS = ['all', 'male', 'female'] as const;
export const ADS_CALLS_TO_ACTION = ['learn_more', 'shop_now', 'sign_up', 'contact_us', 'send_message', 'no_button'] as const;
export type AdsCallToAction = (typeof ADS_CALLS_TO_ACTION)[number];

// The limits local validation enforces. The platform's own limits are checked again when a plan is launched (W2); [U] marks a number to confirm
// in Meta's console before W2 relies on it, so the soft ones only warn.
export const ADS_PLAN_LIMITS = {
  nameMax: 200,
  variantsMax: 3,
  // Above the soft numbers the platform truncates the text on some placements: a warning, not a refusal.
  headlineMax: 100,
  headlineSoft: 40,
  primaryTextMax: 2000,
  primaryTextSoft: 125,
  locationsMax: 25,
  interestsMax: 20,
  interestMax: 100,
  ageLowest: 18,
  ageHighest: 65,
  // The longest flight of the first slice, in days (start and end day included).
  daysMax: 90,
} as const;

// A budget as a person types it: above zero, at most two decimals (the units the Ads screen shows).
export const zAdsBudget = z.string().regex(/^(?!0+(\.0+)?$)\d{1,13}(\.\d{1,2})?$/, 'a decimal above zero, at most 13 digits before the point');
const zCurrency = z.string().regex(/^[A-Z]{3}$/);

export const zAdsLocation = z.strictObject({ country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2'), region: z.string().trim().min(1).max(100).optional() });
export const zAdsTargeting = z.strictObject({
  locations: z.array(zAdsLocation).min(1).max(ADS_PLAN_LIMITS.locationsMax),
  ageMin: z.number().int().min(ADS_PLAN_LIMITS.ageLowest).max(ADS_PLAN_LIMITS.ageHighest),
  ageMax: z.number().int().min(ADS_PLAN_LIMITS.ageLowest).max(ADS_PLAN_LIMITS.ageHighest),
  gender: z.enum(ADS_GENDERS),
  interests: z.array(z.string().trim().min(1).max(ADS_PLAN_LIMITS.interestMax)).max(ADS_PLAN_LIMITS.interestsMax),
});
export type AdsTargeting = z.infer<typeof zAdsTargeting>;

export const zAdsAdVariant = z.strictObject({
  headline: z.string().trim().min(1).max(ADS_PLAN_LIMITS.headlineMax),
  primaryText: z.string().trim().min(1).max(ADS_PLAN_LIMITS.primaryTextMax),
  callToAction: z.enum(ADS_CALLS_TO_ACTION),
});
export type AdsAdVariant = z.infer<typeof zAdsAdVariant>;

// The whole plan, as submitted for approval and shown on the approval card. Placements are automatic: no field.
export const zAdsCampaignPlan = z.strictObject({
  name: z.string().trim().min(1).max(ADS_PLAN_LIMITS.nameMax),
  objective: z.enum(ADS_OBJECTIVES),
  dailyBudget: zAdsBudget,
  startOn: zLocalDate,
  endOn: zLocalDate,
  targeting: zAdsTargeting,
  // Traffic and Engagement send people to a page; Messenger opens a conversation with the Page instead.
  linkUrl: z.url({ protocol: /^https$/ }).max(2000).nullable(),
  // The Facebook Page of a Messenger ad, a channel connection of the org.
  pageConnectionId: zId.nullable(),
  // Where the creative comes from: a Social post of the org (its id is kept, never its text) and/or a file of the media library.
  sourcePostId: zId.nullable(),
  mediaFileId: zId.nullable(),
  variants: z.array(zAdsAdVariant).min(1).max(ADS_PLAN_LIMITS.variantsMax),
});
export type AdsCampaignPlan = z.infer<typeof zAdsCampaignPlan>;

// A draft in progress: the name and the objective are all it needs to exist; every other field is filled in as the plan is built, and local
// validation says what is still missing. `null` clears a field.
export const zAdsCampaignPlanDraft = z.strictObject({
  name: zAdsCampaignPlan.shape.name,
  objective: zAdsCampaignPlan.shape.objective,
  dailyBudget: zAdsBudget.nullable().optional(),
  startOn: zLocalDate.nullable().optional(),
  endOn: zLocalDate.nullable().optional(),
  targeting: zAdsTargeting.nullable().optional(),
  linkUrl: zAdsCampaignPlan.shape.linkUrl.optional(),
  pageConnectionId: zId.nullable().optional(),
  sourcePostId: zId.nullable().optional(),
  mediaFileId: zId.nullable().optional(),
  variants: z.array(zAdsAdVariant).max(ADS_PLAN_LIMITS.variantsMax).optional(),
});
export type AdsCampaignPlanDraft = z.infer<typeof zAdsCampaignPlanDraft>;

// Saving a draft: every save names its ad account (the account never changes: an edit names the draft too, and the account must be the draft's own).
// An edit may carry the revision it was made from: a draft someone saved since is refused (ADS_DRAFT_STALE) instead of overwritten.
export const zAdsCampaignDraftSave = z.strictObject({ draftId: zId.optional(), adAccountId: zId, plan: zAdsCampaignPlanDraft, expectedRevision: z.number().int().positive().optional() });
export type AdsCampaignDraftSave = z.infer<typeof zAdsCampaignDraftSave>;
export const zAdsCampaignDraftSaveCall = zAdsCampaignDraftSave.extend({ idempotencyKey: zId });
export const zAdsCampaignDraftDiscardCall = z.strictObject({ draftId: zId, idempotencyKey: zId });

// What local validation says: a machine code (the screen words it in the reader's language), the field it is about, and the numbers it is based
// on. An error stops a submission; a warning only tells.
export const zAdsPlanIssue = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  severity: z.enum(['error', 'warning']),
  field: z.string().max(64).nullable(),
  params: z.record(z.string().max(64), z.union([z.string().max(200), z.number()])),
});
export type AdsPlanIssue = z.infer<typeof zAdsPlanIssue>;

export const ADS_DRAFT_STATUSES = ['draft', 'approved', 'discarded'] as const;
export type AdsDraftStatus = (typeof ADS_DRAFT_STATUSES)[number];
export const ADS_DRAFT_ORIGINS = ['human', 'ai'] as const;

// A draft as the builder shows it.
export const zAdsCampaignDraftView = z.object({
  id: zId,
  adAccountId: zId,
  adAccountName: z.string(),
  // The account's own currency; null before its first sync (a plan needs it).
  currency: zCurrency.nullable(),
  status: z.enum(ADS_DRAFT_STATUSES),
  revision: z.number().int(),
  plan: zAdsCampaignPlanDraft,
  origin: z.enum(ADS_DRAFT_ORIGINS),
  // The fields the AI coworker drafted and a person has not changed since (each is marked as drafted and stays editable).
  aiFields: z.array(z.string().max(64)),
  // The largest amount the plan can spend: daily budget times the days of the flight, in the account's currency; null while it cannot be told.
  maxSpend: z.string().nullable(),
  days: z.number().int().nullable(),
  issues: z.array(zAdsPlanIssue),
  // The request for approval waiting in the Inbox, if one is (the draft is frozen while it is).
  pendingProposalId: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdsCampaignDraftView = z.infer<typeof zAdsCampaignDraftView>;

// ---- The proposal: what is stored when a plan is submitted, and what the approval card shows ----

export const ADS_CAMPAIGN_LAUNCH_COMMAND = 'ads.campaign.launch';
export const ADS_CAMPAIGN_LAUNCH_KIND = 'ads.campaign_launch';
// The payload the target command reads back on approval. `amount` is the largest amount the plan can spend, in `currency`: the database's guard
// compares it with the draft's own. `planHash` binds the exact plan (a change after the request is a new request); the plan is stored whole so the
// card shows what is signed even if the draft is gone.
export const zAdsCampaignLaunchPayload = z.strictObject({
  draftId: zId,
  revision: z.number().int().positive(),
  adAccountId: zId,
  adAccountName: z.string().max(200),
  amount: z.string().regex(/^\d{1,16}(\.\d{1,2})?$/),
  currency: zCurrency,
  days: z.number().int().positive(),
  planHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  plan: zAdsCampaignPlan,
});
export type AdsCampaignLaunchPayload = z.infer<typeof zAdsCampaignLaunchPayload>;
