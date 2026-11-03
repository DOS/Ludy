// SPDX-License-Identifier: AGPL-3.0-only
// The writer of an ad platform (ADR-0043, plan docs/plan/ads-write.md, issues #2294 and #2296): what runs ads for an ad account, apart from the
// readers of index.ts (`AdPlatform`), which only read reports. A writer works with the token of a WRITE connection (provider
// `metawrite_ads`, `sandboxwrite_ads`), never with the reader's token, and it is not in the readers' registry (`adPlatforms()`
// does not know it, and no sync job, queue or event reaches it). W0b gave it one capability that changes nothing: `verify` says
// whether the sealed token could run ads on an account. W2 adds `revokeToken` first (the permission at the platform is removed whenever a
// write connection is closed, so no spend path exists without it) and, in W2-3, the methods that create a campaign: four creates (campaign, ad set,
// creative, ad), every one of them made PAUSED, a find by the launch's tag (so a create whose answer was lost is found, never repeated), and a read
// that resolves the names of a plan's regions and interests to the platform's ids. Nothing in W2-3 un-pauses an object (`setStatus` only pauses or
// archives; activation is W2-4's, behind the caps re-check and the stop conditions).
// There is no method that deletes an ad object, and none will be added: archiving is a status.

// The answer of `verify`: whether the token could change the campaigns of the account, and the permissions it holds (the
// scopes the platform reports, not the ones asked for).
export interface AdWriterVerification {
  canRunAds: boolean;
  scopes: readonly string[];
}

// The answer of `revokeToken`, how the platform's copy of the permission ended.
// - `revoked`: the platform removed every permission the person gave the app (the person's, for the app, across every org that uses the app).
// - `already_invalid`: the person removed the app at the platform (Meta: error 190, subcode 458), perhaps by an earlier revoke made with another token of the
//   same person, so no token of that grant can spend any more. A token the platform refuses for another reason (expired, invalidated, password changed)
//   is not this: the grant may still stand, and the call throws a `token_expired` error instead.
// - `sandbox`: the offline sandbox has no platform copy.
export interface AdWriterRevocation {
  how: 'revoked' | 'already_invalid' | 'sandbox';
}

// The objectives of a campaign plan (the contract's: owner Q4), and the levels of what a launch creates at the platform.
export const AD_WRITER_OBJECTIVES = ['traffic', 'engagement', 'messenger'] as const;
export type AdWriterObjective = (typeof AD_WRITER_OBJECTIVES)[number];
export const AD_OBJECT_LEVELS = ['campaign', 'ad_set', 'creative', 'ad'] as const;
export type AdObjectLevel = (typeof AD_OBJECT_LEVELS)[number];
export const AD_CALLS_TO_ACTION = ['learn_more', 'shop_now', 'sign_up', 'contact_us', 'send_message', 'no_button'] as const;
export type AdWriterCallToAction = (typeof AD_CALLS_TO_ACTION)[number];

// What a writer can launch, so the launch job stops a plan it cannot carry out before any call is made (nothing created, nothing spent).
export interface AdWriterCapabilities {
  // The objectives it can launch. Meta's list is Traffic until the live check has passed for the others (docs/plan/ads-write.md, W2).
  readonly objectives: readonly AdWriterObjective[];
  // The currencies whose daily budget it can convert to the platform's own unit, or null when it takes any (the offline sandbox).
  readonly currencies: readonly string[] | null;
  // Whether it can send a media-library file with an ad (Meta: not yet, a file is not uploaded in W2-3).
  readonly media: boolean;
}

// The ad account a call is for: the platform's id of it and its currency (a budget is sent in the currency's own unit).
export interface AdWriterAccount {
  externalAccountId: string;
  currency: string;
}

// An object found at the platform by the tag of a launch: its id and the name it carries.
export interface AdFoundObject {
  id: string;
  name: string;
}

// Where an ad is shown, as the platform's ids: countries as ISO 3166-1 alpha-2 codes, the regions and interests the names of a plan resolved to
// (`resolveTargeting`).
export interface AdTargeting {
  countries: readonly string[];
  regions: ReadonlyArray<{ key: string; name: string }>;
  ageMin: number;
  ageMax: number;
  gender: 'all' | 'male' | 'female';
  interests: ReadonlyArray<{ id: string; name: string }>;
}

export interface AdCreateCampaign {
  name: string;
  objective: AdWriterObjective;
}
export interface AdCreateAdSet {
  name: string;
  campaignId: string;
  objective: AdWriterObjective;
  // The daily budget in the account currency's own units (dong, or dollars with cents): a decimal string, never a number. The writer converts it
  // to the platform's minor unit with the platform's own offset for the currency.
  dailyBudget: string;
  // The first moment of the first day and the first moment after the last day, in the account's own time zone, ISO 8601 with its offset.
  startTime: string;
  endTime: string;
  targeting: AdTargeting;
  // The Facebook Page the ad runs as (the platform needs one for every ad).
  pageId: string;
}
export interface AdCreateCreative {
  name: string;
  pageId: string;
  linkUrl: string;
  headline: string;
  primaryText: string;
  callToAction: AdWriterCallToAction;
}
export interface AdCreateAd {
  name: string;
  adSetId: string;
  creativeId: string;
}
// What to look up: the regions of a plan (a country and the region's name) and its interests (names).
export interface AdTargetingQuery {
  regions: ReadonlyArray<{ country: string; name: string }>;
  interests: readonly string[];
}
// What was found: each name that resolved to exactly one platform id, and the names that did not (listed to the person, nothing is guessed).
export interface AdTargetingResolution {
  regions: ReadonlyArray<{ country: string; name: string; key: string }>;
  interests: ReadonlyArray<{ name: string; id: string }>;
  unknown: readonly string[];
}

export interface AdWriter {
  // The provider id of the write connections this writer works with.
  readonly provider: string;
  readonly capabilities: AdWriterCapabilities;
  // Whether the sealed token (`secret`, opened by the caller, never stored or logged here) could run ads on the account, checked
  // without changing anything. A failure is an `AdPlatformError` as for the readers (a refused token, a missing permission, an
  // account the token does not reach).
  verify(secret: string, account: { externalAccountId: string; currency?: string }): Promise<AdWriterVerification>;
  // Removes at the platform the permissions the token's person gave the app, so no token of that grant can change a campaign any more
  // (ADR-0043 point 4). Called by the worker from the queue, after the closing of the connection committed, never inside a command. A
  // failure is an `AdPlatformError` (`rate_limited` carries the time to wait; `transient` is worth another try).
  revokeToken(secret: string): Promise<AdWriterRevocation>;
  // Resolves the names of a plan's regions and interests to the platform's ids, with a read (changes nothing). A name that does not resolve to exactly one
  // id is returned in `unknown`, so the launch stops with the names listed instead of guessing.
  resolveTargeting(secret: string, query: AdTargetingQuery): Promise<AdTargetingResolution>;
  // The four creates of a launch. Every object is created PAUSED (no create can carry another status: the type has no field for it), so a launch that stops half
  // way has spent nothing. Each returns the platform's id of the new object. A failure is an `AdPlatformError`: `bad_request` and `permission` mean the platform
  // refused the call; `transient`, `rate_limited` and `unknown` (a timeout, a lost answer, an answer with no id) mean the object may or may not exist, which the
  // caller settles with `findByTag` before anything is created again.
  createCampaign(secret: string, account: AdWriterAccount, input: AdCreateCampaign): Promise<{ id: string }>;
  createAdSet(secret: string, account: AdWriterAccount, input: AdCreateAdSet): Promise<{ id: string }>;
  createCreative(secret: string, account: AdWriterAccount, input: AdCreateCreative): Promise<{ id: string }>;
  createAd(secret: string, account: AdWriterAccount, input: AdCreateAd): Promise<{ id: string }>;
  // The objects of a level whose name carries the tag of a launch (`ludy:` and ten characters), for the reconcile of a create that has no recorded answer.
  findByTag(secret: string, account: AdWriterAccount, level: AdObjectLevel, tag: string): Promise<AdFoundObject[]>;
  // Pauses or archives an object the writer created: the only changes of an object's status this slice can make. There is no way to activate one here.
  setStatus(secret: string, object: { level: AdObjectLevel; id: string }, status: 'paused' | 'archived'): Promise<void>;
}
