// SPDX-License-Identifier: AGPL-3.0-only
// The writer of Meta ads (ADR-0043 points 3 to 5, plan docs/plan/ads-write.md sections 4, 5.1 and 9, issue #2296, W2), written from Meta's Marketing and
// Graph API docs. It works with the token of a write connection (`metawrite_ads`, ADR-0025: sealed apart from the read token, opened by the worker
// alone) and, for the revoke only, with the token of a read connection that holds a spend permission. Every call carries the token in the
// Authorization header with `appsecret_proof` (the shared Graph client does it), so a token copied out of Ludy is useless without the app secret
// when the Meta app has "Require App Secret" on; every request goes to graph.facebook.com over https and nowhere else (`graphHostOnly`).
//
// Which methods exist is pinned by a test (the class's own methods and every Graph endpoint its source names), and none deletes an ad object. Every
// object is created PAUSED, and only `setStatus` makes one deliver. Each Graph call is spelled out where it is made, so the test that pins the endpoint
// list reads the source as it is.
//
// [U] marks what is written from the documentation and not yet seen to work on a live account: the parameters of the ad set and of the creative of each
// objective, the minimum budget per currency, whether the objects edges filter by name, and the review times. Only the objectives in
// `META_LIVE_CHECKED_OBJECTIVES` are accepted: the others are written down but refused until the live check (docs/runbooks/ads-live-check.md) has
// passed for them, one objective at a time (the PO's decision of 2026-11-03).
//
// What `DELETE /me/permissions` does [C: Graph API, user permissions]: with no permission named it unauthorizes the app for the person, which
// invalidates every token of that person for the app, in every org that uses the app. That is the point (a Meta permission belongs to the pair of
// the app and the person, so one call removes the permission from the write token and from any read token of the same grant), and the cost the ADR
// accepts. A token Meta no longer accepts (error 190, 102, or the subcodes that say the session ended) has nothing left to revoke: `already_invalid`.
import type { Fetch } from '@crove/channel';
import { Graph, GraphError, META_DEFAULT_GRAPH_VERSION } from '@crove/channel';
import { AdPlatformError } from './index.ts';
import { ACT_ID, graphHostOnly, metaAdsError } from './meta.ts';
import { META_WRITE_PROVIDER, META_WRITE_SCOPES } from './meta-write-connector.ts';
import type {
  AdAccountRef,
  AdInput,
  AdLevel,
  AdObjectState,
  AdSetInput,
  AdTagLookup,
  AdTargetingSpec,
  AdWriter,
  AdWriterObjective,
  AdWriterRevocation,
  AdWriterVerification,
  CampaignInput,
  CreativeInput,
  TargetingResolution,
} from './writer.ts';

// How long one call may take before it is given up on and left to the caller's retry.
const CALL_TIMEOUT_MS = 20_000;
// The platform's ids are digits; anything else never reaches a URL.
const PLATFORM_ID = /^\d{1,32}$/;
// The longest name an object takes here (the platform's own limit is higher [U]).
const NAME_MAX = 400;
const LIST_LIMIT = '100';
const SEARCH_LIMIT = '25';

// The objectives a Meta launch is accepted for. Traffic is the best understood; each other objective joins after its own live check.
export const META_LIVE_CHECKED_OBJECTIVES: readonly AdWriterObjective[] = ['traffic'];

// How the plan's objectives are built at Meta [U for all of them]: the campaign's objective, the ad set's optimization goal and destination.
const OBJECTIVES = {
  traffic: { campaign: 'OUTCOME_TRAFFIC', optimizationGoal: 'LINK_CLICKS', destinationType: 'WEBSITE' },
  engagement: { campaign: 'OUTCOME_ENGAGEMENT', optimizationGoal: 'POST_ENGAGEMENT', destinationType: 'ON_POST' },
  messenger: { campaign: 'OUTCOME_ENGAGEMENT', optimizationGoal: 'CONVERSATIONS', destinationType: 'MESSENGER' },
} as const satisfies Record<AdWriterObjective, { campaign: string; optimizationGoal: string; destinationType: string }>;

const CALLS_TO_ACTION = {
  learn_more: 'LEARN_MORE',
  shop_now: 'SHOP_NOW',
  sign_up: 'SIGN_UP',
  contact_us: 'CONTACT_US',
  send_message: 'MESSAGE_PAGE',
  no_button: 'NO_BUTTON',
} as const satisfies Record<CreativeInput['callToAction'], string>;

// The edge of an ad account that lists each level, for finding an object again by its name.
export const META_LIST_EDGES = { campaign: 'campaigns', ad_set: 'adsets', creative: 'adcreatives', ad: 'ads' } as const satisfies Record<AdLevel, string>;

// What is read of an object's state, by level: the status asked for, the status in effect and the reasons it is not delivering.
const STATE_FIELDS = {
  campaign: 'configured_status,effective_status,issues_info',
  ad_set: 'configured_status,effective_status,issues_info',
  ad: 'configured_status,effective_status,issues_info,ad_review_feedback',
} as const;

export interface MetaAdWriterOptions {
  // The secret of the Meta app the token belongs to: the write app for a write connection, the read ads app for a read token the revoke closes.
  appSecret: string;
  graphVersion?: string;
  fetch?: Fetch;
  now?: () => Date;
}

// The token inside the sealed secret of a connection (`{ accessToken }`, as the connector seals it).
function tokenOf(secret: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new AdPlatformError('unknown', 'BAD_SECRET');
  }
  const token = (parsed as { accessToken?: unknown } | null)?.accessToken;
  if (typeof token !== 'string' || token === '') throw new AdPlatformError('unknown', 'BAD_SECRET');
  return token;
}

function accountOf(account: AdAccountRef): string {
  if (!ACT_ID.test(account.externalAccountId)) throw new AdPlatformError('bad_request', 'BAD_ACCOUNT');
  return account.externalAccountId;
}

function platformId(value: string, code: string): string {
  if (!PLATFORM_ID.test(value)) throw new AdPlatformError('bad_request', code);
  return value;
}

function nameOf(value: string): string {
  if (value.trim() === '' || [...value].length > NAME_MAX) throw new AdPlatformError('bad_request', 'BAD_NAME');
  return value;
}

function liveChecked(objective: AdWriterObjective): void {
  if (!META_LIVE_CHECKED_OBJECTIVES.includes(objective)) throw new AdPlatformError('bad_request', 'OBJECTIVE_NOT_LIVE_CHECKED');
}

// The id of an object a create answered. A 200 that names none is not a failure the caller can act on: the object may exist, so it is found again by
// name before anything is repeated.
function createdId(answer: { id?: unknown }): { externalId: string } {
  if (typeof answer.id !== 'string' || !PLATFORM_ID.test(answer.id)) throw new AdPlatformError('unknown', 'NO_ID');
  return { externalId: answer.id };
}

// The targeting spec as Meta's ad set takes it [U]: countries and regions by key, the age range, the gender (omitted for all), the interests by
// id, and Advantage+ audience off so the audience is the one the approver saw. Placements are left automatic.
function targetingOf(spec: AdTargetingSpec): Record<string, unknown> {
  return {
    geo_locations: { countries: [...spec.countries], ...(spec.regions.length > 0 ? { regions: spec.regions.map((r) => ({ key: r.key })) } : {}) },
    age_min: spec.ageMin,
    age_max: spec.ageMax,
    ...(spec.gender === 'all' ? {} : { genders: [spec.gender === 'male' ? 1 : 2] }),
    ...(spec.interests.length > 0 ? { flexible_spec: [{ interests: spec.interests.map((i) => ({ id: i.id, name: i.name })) }] } : {}),
    targeting_automation: { advantage_audience: 0 },
  };
}

const exactly = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export class MetaAdWriter implements AdWriter {
  readonly provider = META_WRITE_PROVIDER;
  private readonly graph: Graph;
  private readonly now: () => Date;

  constructor(options: MetaAdWriterOptions) {
    this.graph = new Graph(options.appSecret, options.graphVersion ?? META_DEFAULT_GRAPH_VERSION, graphHostOnly(options.fetch));
    this.now = options.now ?? (() => new Date());
  }

  // A Graph failure as the channel layer types it (only Meta's code is kept, never its text).
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }

  // Whether the token holds the permissions that let it run ads and reaches the account: the permissions it holds now (a person can remove one in
  // Facebook's settings after granting it) and a read of the account itself. Changes nothing.
  async verify(secret: string, account: AdAccountRef): Promise<AdWriterVerification> {
    const token = tokenOf(secret);
    const accountId = accountOf(account);
    return this.guard(async () => {
      const answer = await this.graph.call<{ data?: Array<{ permission?: unknown; status?: unknown }> }>('GET', 'me/permissions', { token, timeoutMs: CALL_TIMEOUT_MS });
      const scopes = (answer.data ?? []).filter((p) => p.status === 'granted' && typeof p.permission === 'string').map((p) => p.permission as string).sort();
      const canRunAds = META_WRITE_SCOPES.every((scope) => scopes.includes(scope));
      // The account the token reaches: a token that holds the permissions but not this account is refused here, not at the first create.
      if (canRunAds) await this.graph.call<{ id?: unknown }>('GET', accountId, { token, params: { fields: 'id' }, timeoutMs: CALL_TIMEOUT_MS });
      return { canRunAds, scopes };
    });
  }

  // Removes the app's permissions for the person at Meta, so no token of the grant can change a campaign any more. Idempotent at Meta: a second
  // call with a token it no longer accepts answers 190, which is the outcome wanted.
  async revokeToken(secret: string): Promise<AdWriterRevocation> {
    const token = tokenOf(secret);
    try {
      const answer = await this.graph.call<{ success?: unknown }>('DELETE', 'me/permissions', { token, timeoutMs: CALL_TIMEOUT_MS });
      // A 200 that does not say success is not a revoke: it is tried again, never recorded as done.
      if (answer.success !== true) throw new AdPlatformError('unknown', 'NOT_REVOKED');
      return { how: 'revoked' };
    } catch (error) {
      const mapped = metaAdsError(error, this.now);
      if (mapped.kind === 'token_expired') return { how: 'already_invalid' };
      throw mapped;
    }
  }

  // Finds the ids of the interests and regions a plan names by searching Meta's targeting options (reading only). A name has to match exactly one
  // entry (compared without case): none is `unknown`, more than one is `ambiguous`, and the launch stops for either, with nothing created.
  async resolveTargeting(secret: string, names: { interests: readonly string[]; regions: ReadonlyArray<{ country: string; region: string }> }): Promise<TargetingResolution> {
    const token = tokenOf(secret);
    const out: TargetingResolution = { interests: { resolved: [], unknown: [], ambiguous: [] }, regions: { resolved: [], unknown: [], ambiguous: [] } };
    return this.guard(async () => {
      for (const name of names.interests) {
        const answer = await this.graph.call<{ data?: Array<{ id?: unknown; name?: unknown }> }>('GET', 'search', { token, params: { type: 'adinterest', q: name, limit: SEARCH_LIMIT }, timeoutMs: CALL_TIMEOUT_MS });
        const ids = new Set((answer.data ?? []).filter((e) => typeof e.id === 'string' && PLATFORM_ID.test(e.id) && typeof e.name === 'string' && exactly(e.name, name)).map((e) => e.id as string));
        const [only] = [...ids];
        if (ids.size === 1 && only) out.interests.resolved.push({ name, id: only });
        else if (ids.size === 0) out.interests.unknown.push(name);
        else out.interests.ambiguous.push(name);
      }
      for (const { country, region } of names.regions) {
        const answer = await this.graph.call<{ data?: Array<{ key?: unknown; name?: unknown }> }>('GET', 'search', {
          token,
          params: { type: 'adgeolocation', location_types: '["region"]', country_code: country, q: region, limit: SEARCH_LIMIT },
          timeoutMs: CALL_TIMEOUT_MS,
        });
        const keys = new Set((answer.data ?? []).filter((e) => typeof e.key === 'string' && /^\d{1,16}$/.test(e.key) && typeof e.name === 'string' && exactly(e.name, region)).map((e) => e.key as string));
        const [only] = [...keys];
        if (keys.size === 1 && only) out.regions.resolved.push({ country, name: region, key: only });
        else if (keys.size === 0) out.regions.unknown.push(`${country}:${region}`);
        else out.regions.ambiguous.push(`${country}:${region}`);
      }
      return out;
    });
  }

  // The campaign: PAUSED, the objective of the plan, and no special ad category (a plan declares none: ADR-0043 point 6) [U on how the empty list is sent].
  async createCampaign(secret: string, account: AdAccountRef, input: CampaignInput): Promise<{ externalId: string }> {
    const token = tokenOf(secret);
    const accountId = accountOf(account);
    liveChecked(input.objective);
    const form = { name: nameOf(input.name), objective: OBJECTIVES[input.objective].campaign, status: 'PAUSED', special_ad_categories: '[]' };
    return this.guard(async () => createdId(await this.graph.call<{ id?: unknown }>('POST', `${accountId}/campaigns`, { token, form, timeoutMs: CALL_TIMEOUT_MS })));
  }

  // The ad set: PAUSED, a daily budget, the flight, the audience, automatic placements, the goal the objective needs [U].
  async createAdSet(secret: string, account: AdAccountRef, input: AdSetInput): Promise<{ externalId: string }> {
    const token = tokenOf(secret);
    const accountId = accountOf(account);
    liveChecked(input.objective);
    const goal = OBJECTIVES[input.objective];
    if (!/^[1-9]\d{0,15}$/.test(input.dailyBudgetMinor)) throw new AdPlatformError('bad_request', 'BAD_BUDGET');
    const form: Record<string, string> = {
      name: nameOf(input.name),
      campaign_id: platformId(input.campaignId, 'BAD_CAMPAIGN'),
      status: 'PAUSED',
      daily_budget: input.dailyBudgetMinor,
      start_time: input.startTime,
      end_time: input.endTime,
      billing_event: 'IMPRESSIONS',
      optimization_goal: goal.optimizationGoal,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      destination_type: goal.destinationType,
      targeting: JSON.stringify(targetingOf(input.targeting)),
      ...(input.objective === 'traffic' ? {} : { promoted_object: JSON.stringify({ page_id: platformId(input.pageId, 'BAD_PAGE') }) }),
    };
    return this.guard(async () => createdId(await this.graph.call<{ id?: unknown }>('POST', `${accountId}/adsets`, { token, form, timeoutMs: CALL_TIMEOUT_MS })));
  }

  // The creative: the Page the ad runs as, the text, the headline, the link and the button [U on the Messenger link and welcome message].
  async createCreative(secret: string, account: AdAccountRef, input: CreativeInput): Promise<{ externalId: string }> {
    const token = tokenOf(secret);
    const accountId = accountOf(account);
    const pageId = platformId(input.pageId, 'BAD_PAGE');
    const link = input.linkUrl ?? `https://www.facebook.com/${pageId}`;
    const form = {
      name: nameOf(input.name),
      object_story_spec: JSON.stringify({
        page_id: pageId,
        link_data: { message: input.message, link, name: input.headline, call_to_action: { type: CALLS_TO_ACTION[input.callToAction], value: { link } } },
      }),
    };
    return this.guard(async () => createdId(await this.graph.call<{ id?: unknown }>('POST', `${accountId}/adcreatives`, { token, form, timeoutMs: CALL_TIMEOUT_MS })));
  }

  // The ad: PAUSED, in the ad set, showing the creative.
  async createAd(secret: string, account: AdAccountRef, input: AdInput): Promise<{ externalId: string }> {
    const token = tokenOf(secret);
    const accountId = accountOf(account);
    const form = {
      name: nameOf(input.name),
      adset_id: platformId(input.adSetId, 'BAD_AD_SET'),
      creative: JSON.stringify({ creative_id: platformId(input.creativeId, 'BAD_CREATIVE') }),
      status: 'PAUSED',
    };
    return this.guard(async () => createdId(await this.graph.call<{ id?: unknown }>('POST', `${accountId}/ads`, { token, form, timeoutMs: CALL_TIMEOUT_MS })));
  }

  // ACTIVE starts an object delivering, PAUSED stops it: the one call that changes an existing object, and it changes its status alone. The same
  // status again changes nothing, so a repeated call is harmless.
  async setStatus(secret: string, objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> {
    const token = tokenOf(secret);
    const id = platformId(objectId, 'BAD_OBJECT');
    await this.guard(async () => {
      const answer = await this.graph.call<{ success?: unknown }>('POST', id, { token, form: { status }, timeoutMs: CALL_TIMEOUT_MS });
      // A 200 that does not say success may or may not have changed the object: the caller reads it back before it believes either.
      if (answer.success !== true) throw new AdPlatformError('unknown', 'NOT_SET');
    });
  }

  // What Meta says of each object now: the status asked for, the status in effect and the codes of the reasons it is not delivering (the screen words
  // them). An id Meta says does not exist (or is not the token's to see) is left out of the answer.
  async readObjects(secret: string, objects: ReadonlyArray<{ level: Exclude<AdLevel, 'creative'>; externalId: string }>): Promise<AdObjectState[]> {
    const token = tokenOf(secret);
    const states: AdObjectState[] = [];
    for (const object of objects) {
      const id = platformId(object.externalId, 'BAD_OBJECT');
      try {
        const answer = await this.graph.call<{
          configured_status?: unknown;
          effective_status?: unknown;
          issues_info?: Array<{ error_code?: unknown }>;
          ad_review_feedback?: { global?: Record<string, unknown> };
        }>('GET', id, { token, params: { fields: STATE_FIELDS[object.level] }, timeoutMs: CALL_TIMEOUT_MS });
        const reasons = [
          ...(answer.issues_info ?? []).map((i) => String(i.error_code ?? '')).filter((c) => c !== ''),
          ...Object.keys(answer.ad_review_feedback?.global ?? {}),
        ];
        states.push({
          externalId: id,
          configuredStatus: typeof answer.configured_status === 'string' ? answer.configured_status : 'UNKNOWN',
          effectiveStatus: typeof answer.effective_status === 'string' ? answer.effective_status : 'UNKNOWN',
          reasons: [...new Set(reasons)],
        });
      } catch (error) {
        // "Object does not exist or you lack permission" (code 100, subcode 33): not an answer, not an error.
        if (error instanceof GraphError && error.code === 100 && error.subcode === 33) continue;
        throw metaAdsError(error, this.now);
      }
    }
    return states;
  }

  // Whether an object of this level with exactly this name is on the account, from the account's list of that level (filtered by name where the
  // edge allows it [U], and compared exactly here). A name found twice, or a list too long to read whole when none was found, is `unknowable`.
  async findByTag(secret: string, account: AdAccountRef, level: AdLevel, name: string): Promise<AdTagLookup> {
    const token = tokenOf(secret);
    const accountId = accountOf(account);
    const wanted = nameOf(name);
    return this.guard(async () => {
      const filtering = level === 'creative' ? {} : { filtering: JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: wanted }]) };
      const answer = await this.graph.call<{ data?: Array<{ id?: unknown; name?: unknown }>; paging?: { next?: unknown } }>('GET', `${accountId}/${META_LIST_EDGES[level]}`, {
        token,
        params: { fields: 'id,name', limit: LIST_LIMIT, ...filtering },
        timeoutMs: CALL_TIMEOUT_MS,
      });
      const same = (answer.data ?? []).filter((o) => o.name === wanted && typeof o.id === 'string' && PLATFORM_ID.test(o.id));
      const [only] = same;
      if (same.length === 1 && only) return { kind: 'found', externalId: only.id as string } as const;
      if (same.length > 1) return { kind: 'unknowable', reason: 'duplicates' } as const;
      return answer.paging?.next ? ({ kind: 'unknowable', reason: 'truncated' } as const) : ({ kind: 'missing' } as const);
    });
  }
}
