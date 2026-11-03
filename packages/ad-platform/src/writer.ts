// SPDX-License-Identifier: AGPL-3.0-only
// The writer of an ad platform (ADR-0043, plan docs/plan/ads-write.md, issues #2294 and #2296): what runs ads for an ad account, apart from the
// readers of index.ts (`AdPlatform`), which only read reports. A writer works with the token of a WRITE connection (provider
// `metawrite_ads`, `sandboxwrite_ads`), never with the reader's token, and it is not in the readers' registry (`adPlatforms()`
// does not know it, and no sync job, queue or event reaches it). W0b gave it one capability that changes nothing: `verify` says
// whether the sealed token could run ads on an account. W2 adds `revokeToken` first (the permission at the platform is removed whenever a
// write connection is closed, so no spend path exists without it) and then the methods that create and change a campaign.
// There is no method that deletes an ad object, and none will be added: archiving is a status.
//
// Everything money here is a decimal string in the account currency's smallest unit (the caller converts with decimal.js; no arithmetic and no
// number happens in an adapter), and every object the writer creates is created PAUSED: only `setStatus` can make one deliver, and the launch
// does that last (ADR-0043 point 5).

// The answer of `verify`: whether the token could change the campaigns of the account, and the permissions it holds (the
// scopes the platform reports, not the ones asked for).
export interface AdWriterVerification {
  canRunAds: boolean;
  scopes: readonly string[];
}

// The answer of `revokeToken`, how the platform's copy of the permission ended.
// - `revoked`: the platform removed every permission the person gave the app (the person's, for the app, across every org that uses the app).
// - `already_invalid`: the platform no longer accepts the token (it expired, or the person's permissions were removed before, perhaps by
//   an earlier revoke made with another token of the same person), so no token of that grant can spend any more.
// - `sandbox`: the offline sandbox has no platform copy.
export interface AdWriterRevocation {
  how: 'revoked' | 'already_invalid' | 'sandbox';
}

// What a plan's objective is called here: the three the first slice launches (ADR-0043 Q4), as the kernel contract names them.
export const AD_WRITER_OBJECTIVES = ['traffic', 'engagement', 'messenger'] as const;
export type AdWriterObjective = (typeof AD_WRITER_OBJECTIVES)[number];

// The four kinds of object a launch makes, in the order it makes them.
export const AD_LEVELS = ['campaign', 'ad_set', 'creative', 'ad'] as const;
export type AdLevel = (typeof AD_LEVELS)[number];

export interface AdAccountRef {
  // The platform's id of the ad account (Meta: `act_<digits>`).
  externalAccountId: string;
}

// The audience as the platform takes it: interests and regions by the platform's own ids, found by `resolveTargeting` (a plan keeps names).
export interface AdTargetingSpec {
  countries: readonly string[];
  regions: ReadonlyArray<{ key: string; name: string; country: string }>;
  ageMin: number;
  ageMax: number;
  gender: 'all' | 'male' | 'female';
  interests: ReadonlyArray<{ id: string; name: string }>;
}

// What `resolveTargeting` found for the names of a plan. A name that matches no entry exactly is `unknown`; one that matches more than one is
// `ambiguous`. A launch goes on only when both lists are empty: nothing is guessed and nothing is created for a name the platform does not pin down.
export interface TargetingResolution {
  interests: { resolved: Array<{ name: string; id: string }>; unknown: string[]; ambiguous: string[] };
  regions: { resolved: Array<{ country: string; name: string; key: string }>; unknown: string[]; ambiguous: string[] };
}

export interface CampaignInput {
  name: string;
  objective: AdWriterObjective;
}
export interface AdSetInput {
  name: string;
  campaignId: string;
  objective: AdWriterObjective;
  // The Facebook Page the ad runs as (and, for a Messenger ad, the Page that is messaged): its platform id.
  pageId: string;
  // The daily budget in the account currency's smallest unit, a whole-number string.
  dailyBudgetMinor: string;
  // ISO 8601 with the account's offset: the start of the first day and the start of the day after the last.
  startTime: string;
  endTime: string;
  targeting: AdTargetingSpec;
}
export interface CreativeInput {
  name: string;
  pageId: string;
  message: string;
  headline: string;
  // The https page the ad opens; null for a Messenger ad.
  linkUrl: string | null;
  callToAction: 'learn_more' | 'shop_now' | 'sign_up' | 'contact_us' | 'send_message' | 'no_button';
}
export interface AdInput {
  name: string;
  adSetId: string;
  creativeId: string;
}

// An object as the platform reports it now: what was asked for (`configured`), what it is doing (`effective`: in review, active, rejected) and
// the reasons it is not delivering, as the platform's codes (the screen words them; a rejected ad is never re-submitted).
export interface AdObjectState {
  externalId: string;
  configuredStatus: string;
  effectiveStatus: string;
  reasons: readonly string[];
}

// Whether an object of a level with this name exists on the account: `found` with its id, `missing` (none, and the list was complete), or
// `unknowable` (more than one of that name, or a list too long to read whole): a person looks, nothing is guessed.
export type AdTagLookup = { kind: 'found'; externalId: string } | { kind: 'missing' } | { kind: 'unknowable'; reason: 'duplicates' | 'truncated' };

export interface AdWriter {
  // The provider id of the write connections this writer works with.
  readonly provider: string;
  // Whether the sealed token (`secret`, opened by the caller, never stored or logged here) could run ads on the account, checked
  // without changing anything. A failure is an `AdPlatformError` as for the readers (a refused token, a missing permission, an
  // account the token does not reach).
  verify(secret: string, account: AdAccountRef): Promise<AdWriterVerification>;
  // Removes at the platform the permissions the token's person gave the app, so no token of that grant can change a campaign any more
  // (ADR-0043 point 4). Called by the worker from the queue, after the closing of the connection committed, never inside a command. A
  // failure is an `AdPlatformError` (`rate_limited` carries the time to wait; `transient` is worth another try).
  revokeToken(secret: string): Promise<AdWriterRevocation>;
  // Finds the platform's ids for the interests and regions a plan names, by reading (nothing is created). See `TargetingResolution`.
  resolveTargeting(secret: string, names: { interests: readonly string[]; regions: ReadonlyArray<{ country: string; region: string }> }): Promise<TargetingResolution>;
  // The creating calls. Each makes one object, PAUSED, and answers its platform id. The platform offers no idempotency key for them, so a call
  // that may or may not have made its object is found again by name (`findByTag`) before it is ever repeated.
  createCampaign(secret: string, account: AdAccountRef, input: CampaignInput): Promise<{ externalId: string }>;
  createAdSet(secret: string, account: AdAccountRef, input: AdSetInput): Promise<{ externalId: string }>;
  createCreative(secret: string, account: AdAccountRef, input: CreativeInput): Promise<{ externalId: string }>;
  createAd(secret: string, account: AdAccountRef, input: AdInput): Promise<{ externalId: string }>;
  // Changes the status of an object: ACTIVE starts it delivering (spending), PAUSED stops it. Setting the status an object has is a no-op, so
  // a repeated call changes nothing. There is no archive and no delete.
  setStatus(secret: string, objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void>;
  // What the platform says of campaigns, ad sets and ads now (reading only). An id it does not know is left out of the answer.
  readObjects(secret: string, objects: ReadonlyArray<{ level: Exclude<AdLevel, 'creative'>; externalId: string }>): Promise<AdObjectState[]>;
  // Whether an object of the level with exactly this name exists on the account.
  findByTag(secret: string, account: AdAccountRef, level: AdLevel, name: string): Promise<AdTagLookup>;
}
