// SPDX-License-Identifier: AGPL-3.0-only
// The writer of Meta ads (ADR-0043 points 3 to 5, plan docs/plan/ads-write.md sections 5.1 and 9, issue #2296, W2), written from Meta's Marketing and
// Graph API docs. It works with the token of a write connection (`metawrite_ads`, ADR-0025: sealed apart from the read token, opened by the worker
// alone) and, for the revoke only, with the token of a read connection that holds a spend permission. Every call carries the token in the
// Authorization header with `appsecret_proof` (the shared Graph client does it), so a token copied out of Ludy is useless without the app secret
// when the Meta app has "Require App Secret" on; every request goes to graph.facebook.com over https and nowhere else (`graphHostOnly`).
//
// Which methods exist is pinned by a test (the class's own methods and every Graph endpoint its source names), and none deletes an ad object. W2-1 gave
// it `verify` (two GETs) and `revokeToken` (the one call that is not about an ad object: it removes the app's permissions for the person at Meta). W2-3
// adds the calls of a launch, and every one of them leaves the object PAUSED:
// - four creates, `POST act_<id>/campaigns`, `adsets`, `adcreatives` and `ads` (one call site, `create`, which sets `status=PAUSED` last, so no input can
//   put another status in; a creative has no such status at Meta and cannot deliver on its own, an ad set or a campaign or an ad created PAUSED does not
//   either);
// - `findByTag`, `GET act_<id>/<edge>` filtered by the tag in the name, so a create whose answer was lost is found and never made twice;
// - `resolveTargeting`, `GET search`, which turns the names of a plan's regions and interests into Meta's ids (a read);
// - `setStatus`, `POST <object id>` with `PAUSED` or `ARCHIVED` and no other value: nothing here un-pauses an object (W2-4 adds that, behind the caps
//   re-check and the stop conditions).
// Budgets go through `metaMinorUnits` (Meta's offset per currency, exact string arithmetic). [U] Meta's exact parameters for the ad set and the creative
// are written from its documentation, for the Traffic objective only; the live check (W2-5) records what Meta really accepts, and Engagement and
// Messenger join when it has passed for them.
//
// What `DELETE /me/permissions` does [C: Graph API, user permissions]: with no permission named it unauthorizes the app for the person, which
// invalidates every token of that person for the app, in every org that uses the app. That is the point (a Meta permission belongs to the pair of
// the app and the person, so one call removes the permission from the write token and from any read token of the same grant), and the cost the ADR
// accepts (the job does not call it while another live connection of the same person needs the grant). A token Meta refuses with error 190 and subcode 458
// (the person removed the app) has nothing left to revoke: `already_invalid`. Any other refusal of the token (463, 467, 460, 102, a 190 with no subcode) leaves
// the grant possibly standing, so it is a `token_expired` error and never reported as revoked.
import type { Fetch } from '@crove/channel';
import { Graph, GraphError, META_DEFAULT_GRAPH_VERSION } from '@crove/channel';
import { AdPlatformError } from './index.ts';
import { ACT_ID, graphHostOnly, metaAdsError } from './meta.ts';
import { META_BUDGET_CURRENCIES, metaMinorUnits } from './meta-currency.ts';
import { META_WRITE_PROVIDER, META_WRITE_SCOPES } from './meta-write-connector.ts';
import type {
  AdCreateAd,
  AdCreateAdSet,
  AdCreateCampaign,
  AdCreateCreative,
  AdFoundObject,
  AdObjectLevel,
  AdTargeting,
  AdTargetingQuery,
  AdTargetingResolution,
  AdWriter,
  AdWriterAccount,
  AdWriterCallToAction,
  AdWriterCapabilities,
  AdWriterRevocation,
  AdWriterVerification,
} from './writer.ts';

// How long one call may take before it is given up on and left to the caller's retry.
const CALL_TIMEOUT_MS = 20_000;

// What Meta's objects are called and sent as. Traffic is the one objective whose parameters are written (the others join after the live check): a campaign's
// objective, and the ad set's optimization goal, billing event and destination for it [U].
const META_OBJECTIVES = { traffic: { objective: 'OUTCOME_TRAFFIC', optimizationGoal: 'LINK_CLICKS', billingEvent: 'IMPRESSIONS', destinationType: 'WEBSITE' } } as const;
const CALLS_TO_ACTION: Readonly<Record<AdWriterCallToAction, string>> = {
  learn_more: 'LEARN_MORE',
  shop_now: 'SHOP_NOW',
  sign_up: 'SIGN_UP',
  contact_us: 'CONTACT_US',
  send_message: 'MESSAGE_PAGE',
  no_button: 'NO_BUTTON',
};
// The edge of an ad account that lists each level of object.
const EDGES: Readonly<Record<AdObjectLevel, string>> = { campaign: 'campaigns', ad_set: 'adsets', creative: 'adcreatives', ad: 'ads' };
// Meta's ids are numeric strings; the name tag of a launch is `ludy:` and ten hexadecimal characters.
const OBJECT_ID = /^\d{1,32}$/;
const TAG = /^ludy:[0-9a-f]{10}$/;
const SEARCH_LIMIT = '10';

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

// The targeting of an ad set as Meta takes it (a JSON object in one form field).
function targetingOf(targeting: AdTargeting): string {
  const geo: Record<string, unknown> = {};
  if (targeting.countries.length > 0) geo.countries = [...targeting.countries];
  if (targeting.regions.length > 0) geo.regions = targeting.regions.map((r) => ({ key: r.key }));
  const spec: Record<string, unknown> = { geo_locations: geo, age_min: targeting.ageMin, age_max: targeting.ageMax, targeting_automation: { advantage_audience: 0 } };
  if (targeting.gender === 'male') spec.genders = [1];
  if (targeting.gender === 'female') spec.genders = [2];
  if (targeting.interests.length > 0) spec.flexible_spec = [{ interests: targeting.interests.map((i) => ({ id: i.id, name: i.name })) }];
  return JSON.stringify(spec);
}

// A platform id out of an answer, or an `unknown` error: the call went out and the object may exist, which the caller settles with `findByTag`.
function idOf(answer: { id?: unknown }): { id: string } {
  if (typeof answer.id !== 'string' || !OBJECT_ID.test(answer.id)) throw new AdPlatformError('unknown', 'NO_ID');
  return { id: answer.id };
}

function pageOf(pageId: string): string {
  if (!OBJECT_ID.test(pageId)) throw new AdPlatformError('bad_request', 'BAD_PAGE');
  return pageId;
}

export class MetaAdWriter implements AdWriter {
  readonly provider = META_WRITE_PROVIDER;
  // Traffic only, in the currencies whose offset is verified, and no media file (W2-3).
  readonly capabilities: AdWriterCapabilities = Object.freeze({ objectives: Object.freeze(Object.keys(META_OBJECTIVES)) as AdWriterCapabilities['objectives'], currencies: META_BUDGET_CURRENCIES, media: false });
  private readonly graph: Graph;
  private readonly now: () => Date;

  constructor(options: MetaAdWriterOptions) {
    this.graph = new Graph(options.appSecret, options.graphVersion ?? META_DEFAULT_GRAPH_VERSION, graphHostOnly(options.fetch));
    this.now = options.now ?? (() => new Date());
  }

  // Whether the token holds the permissions that let it run ads and reaches the account: the permissions it holds now (a person can remove one in
  // Facebook's settings after granting it) and a read of the account itself. Changes nothing.
  async verify(secret: string, account: { externalAccountId: string; currency?: string }): Promise<AdWriterVerification> {
    const token = tokenOf(secret);
    if (!ACT_ID.test(account.externalAccountId)) throw new AdPlatformError('bad_request', 'BAD_ACCOUNT');
    try {
      const answer = await this.graph.call<{ data?: Array<{ permission?: unknown; status?: unknown }> }>('GET', 'me/permissions', { token, timeoutMs: CALL_TIMEOUT_MS });
      const scopes = (answer.data ?? []).filter((p) => p.status === 'granted' && typeof p.permission === 'string').map((p) => p.permission as string).sort();
      const canRunAds = META_WRITE_SCOPES.every((scope) => scopes.includes(scope));
      // The account the token reaches: a token that holds the permissions but not this account is refused here, not at the first create.
      if (canRunAds) {
        const read = await this.graph.call<{ id?: unknown; currency?: unknown }>('GET', account.externalAccountId, { token, params: { fields: 'id,currency' }, timeoutMs: CALL_TIMEOUT_MS });
        // A budget goes to Meta in the minor unit of the account's currency, so an account whose currency is not the one the plan was approved in (it changed since
        // the last sync) must not be given one: a budget in dong read as dollars would be a hundred times off.
        if (account.currency !== undefined && typeof read.currency === 'string' && read.currency !== account.currency) throw new AdPlatformError('bad_request', 'CURRENCY_MISMATCH');
      }
      return { canRunAds, scopes };
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }

  // Removes the app's permissions for the person at Meta, so no token of the grant can change a campaign any more. A second call after the person removed the
  // app answers 190 with subcode 458, which is the outcome wanted (`already_invalid`); any other refusal of the token is an error (see below).
  async revokeToken(secret: string): Promise<AdWriterRevocation> {
    const token = tokenOf(secret);
    try {
      const answer = await this.graph.call<{ success?: unknown }>('DELETE', 'me/permissions', { token, timeoutMs: CALL_TIMEOUT_MS });
      // A 200 that does not say success is not a revoke: it is tried again, never recorded as done.
      if (answer.success !== true) throw new AdPlatformError('unknown', 'NOT_REVOKED');
      return { how: 'revoked' };
    } catch (error) {
      // Error 190 says Meta does not accept the token, and its subcode says why. Only 458 (the person removed the app) means the permissions are already
      // gone, so only it is `already_invalid`. The others (463 expired, 467 invalid, 460 password changed, a 190 with no subcode, 102) mean the token cannot
      // revoke anything while the grant may still stand: a `token_expired` error, which the revoke job ends as "revoke by hand", never as revoked. An error
      // of the deployment (a wrong app secret or proof: code 100, or 200) is none of these and is never read as a 190.
      if (error instanceof GraphError && error.code === 190 && error.subcode === 458) return { how: 'already_invalid' };
      if (error instanceof GraphError && error.code === 190) throw new AdPlatformError('token_expired', `190_${error.subcode ?? 0}`);
      const mapped = metaAdsError(error, this.now);
      // The shared mapper reads the session subcodes (458 to 467) as an expired token whatever the code; here only a 190 or a 102 says so, and an error of
      // the deployment that happens to carry such a subcode (code 100 or 200) stays a counted failure of its own kind.
      if (mapped.kind === 'token_expired' && error instanceof GraphError && error.code !== 102) {
        throw new AdPlatformError(error.code === 100 ? 'bad_request' : error.code !== undefined && error.code >= 200 && error.code <= 299 ? 'permission' : 'unknown', error.code === undefined ? undefined : String(error.code));
      }
      throw mapped;
    }
  }

  // The one call site of every create. The fields are the caller's; the status is set last, so an input can never put another one in: whatever is created here
  // is PAUSED. (A creative has no status of its own to set: it does not deliver until an ad that uses it is active, and nothing here activates anything.)
  private async create(secret: string, account: AdWriterAccount, level: AdObjectLevel, fields: Record<string, string>): Promise<{ id: string }> {
    const token = tokenOf(secret);
    if (!ACT_ID.test(account.externalAccountId)) throw new AdPlatformError('bad_request', 'BAD_ACCOUNT');
    const form = level === 'creative' ? { ...fields } : { ...fields, status: 'PAUSED' };
    try {
      return idOf(await this.graph.call<{ id?: unknown }>('POST', `${account.externalAccountId}/${EDGES[level]}`, { token, form, timeoutMs: CALL_TIMEOUT_MS }));
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }

  async createCampaign(secret: string, account: AdWriterAccount, input: AdCreateCampaign): Promise<{ id: string }> {
    const meta = Object.hasOwn(META_OBJECTIVES, input.objective) ? META_OBJECTIVES[input.objective as keyof typeof META_OBJECTIVES] : undefined;
    if (!meta) throw new AdPlatformError('bad_request', 'OBJECTIVE_UNSUPPORTED');
    return this.create(secret, account, 'campaign', { name: input.name, objective: meta.objective, special_ad_categories: '[]', buying_type: 'AUCTION' });
  }

  async createAdSet(secret: string, account: AdWriterAccount, input: AdCreateAdSet): Promise<{ id: string }> {
    const meta = Object.hasOwn(META_OBJECTIVES, input.objective) ? META_OBJECTIVES[input.objective as keyof typeof META_OBJECTIVES] : undefined;
    if (!meta) throw new AdPlatformError('bad_request', 'OBJECTIVE_UNSUPPORTED');
    if (!OBJECT_ID.test(input.campaignId)) throw new AdPlatformError('bad_request', 'BAD_CAMPAIGN');
    return this.create(secret, account, 'ad_set', {
      name: input.name,
      campaign_id: input.campaignId,
      // The daily budget in Meta's minor unit of the account's currency: the ledger's decimal, converted with Meta's own offset (a refusal, never a rounding).
      daily_budget: metaMinorUnits(input.dailyBudget, account.currency),
      billing_event: meta.billingEvent,
      optimization_goal: meta.optimizationGoal,
      destination_type: meta.destinationType,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      start_time: input.startTime,
      end_time: input.endTime,
      targeting: targetingOf(input.targeting),
      promoted_object: JSON.stringify({ page_id: pageOf(input.pageId) }),
    });
  }

  async createCreative(secret: string, account: AdWriterAccount, input: AdCreateCreative): Promise<{ id: string }> {
    let link: URL;
    try {
      link = new URL(input.linkUrl);
    } catch {
      throw new AdPlatformError('bad_request', 'BAD_LINK');
    }
    if (link.protocol !== 'https:') throw new AdPlatformError('bad_request', 'BAD_LINK');
    const story = {
      page_id: pageOf(input.pageId),
      link_data: { link: link.toString(), message: input.primaryText, name: input.headline, call_to_action: { type: CALLS_TO_ACTION[input.callToAction], value: { link: link.toString() } } },
    };
    return this.create(secret, account, 'creative', { name: input.name, object_story_spec: JSON.stringify(story) });
  }

  async createAd(secret: string, account: AdWriterAccount, input: AdCreateAd): Promise<{ id: string }> {
    if (!OBJECT_ID.test(input.adSetId) || !OBJECT_ID.test(input.creativeId)) throw new AdPlatformError('bad_request', 'BAD_OBJECT');
    return this.create(secret, account, 'ad', { name: input.name, adset_id: input.adSetId, creative: JSON.stringify({ creative_id: input.creativeId }) });
  }

  // The objects of a level whose name carries the launch's tag. Only the first page is read (a launch makes a handful of objects, and the tag is its own), so an
  // answer that says there is more (`paging.next`) is not the whole answer: it is unknowable (`PAGED_ANSWER`), never "these are all of them", because a caller
  // that took a partial list for a full one would call an object missing and make it again, or leave one unpaused.
  async findByTag(secret: string, account: AdWriterAccount, level: AdObjectLevel, tag: string): Promise<AdFoundObject[]> {
    const token = tokenOf(secret);
    if (!ACT_ID.test(account.externalAccountId)) throw new AdPlatformError('bad_request', 'BAD_ACCOUNT');
    if (!TAG.test(tag)) throw new AdPlatformError('bad_request', 'BAD_TAG');
    let answer: { data?: Array<{ id?: unknown; name?: unknown }>; paging?: { next?: unknown } };
    try {
      answer = await this.graph.call<typeof answer>('GET', `${account.externalAccountId}/${EDGES[level]}`, {
        token,
        params: { fields: 'id,name', filtering: JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: tag }]), limit: '100' },
        timeoutMs: CALL_TIMEOUT_MS,
      });
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
    if (answer.paging?.next !== undefined && answer.paging.next !== null && answer.paging.next !== false) throw new AdPlatformError('unknown', 'PAGED_ANSWER');
    const found: AdFoundObject[] = [];
    for (const item of answer.data ?? []) if (typeof item.id === 'string' && OBJECT_ID.test(item.id) && typeof item.name === 'string' && item.name.includes(tag)) found.push({ id: item.id, name: item.name });
    return found;
  }

  // The names of a plan's regions and interests as Meta's ids, with Meta's targeting search (GETs). A name resolves only when exactly one result carries it
  // (case and spaces aside): anything else is unknown and the launch stops with the names listed.
  async resolveTargeting(secret: string, query: AdTargetingQuery): Promise<AdTargetingResolution> {
    const token = tokenOf(secret);
    const same = (a: unknown, b: string) => typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
    const regions: Array<{ country: string; name: string; key: string }> = [];
    const interests: Array<{ name: string; id: string }> = [];
    const unknown: string[] = [];
    try {
      for (const region of query.regions) {
        const answer = await this.graph.call<{ data?: Array<{ key?: unknown; name?: unknown; country_code?: unknown }> }>('GET', 'search', {
          token,
          params: { type: 'adgeolocation', location_types: '["region"]', q: region.name, country_code: region.country, limit: SEARCH_LIMIT },
          timeoutMs: CALL_TIMEOUT_MS,
        });
        const keys = new Set((answer.data ?? []).filter((r) => same(r.name, region.name) && r.country_code === region.country && typeof r.key === 'string' && OBJECT_ID.test(r.key)).map((r) => r.key as string));
        if (keys.size === 1) regions.push({ country: region.country, name: region.name, key: [...keys][0] as string });
        else unknown.push(`${region.name} (${region.country})`);
      }
      for (const name of query.interests) {
        const answer = await this.graph.call<{ data?: Array<{ id?: unknown; name?: unknown }> }>('GET', 'search', { token, params: { type: 'adinterest', q: name, limit: SEARCH_LIMIT }, timeoutMs: CALL_TIMEOUT_MS });
        const ids = new Set((answer.data ?? []).filter((i) => same(i.name, name) && typeof i.id === 'string' && OBJECT_ID.test(i.id)).map((i) => i.id as string));
        if (ids.size === 1) interests.push({ name, id: [...ids][0] as string });
        else unknown.push(name);
      }
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
    return { regions, interests, unknown };
  }

  // Pauses or archives an object: the two statuses this slice may set, and no other (an `active` that gets past the types is refused here, before a request).
  async setStatus(secret: string, object: { level: AdObjectLevel; id: string }, status: 'paused' | 'archived'): Promise<void> {
    const token = tokenOf(secret);
    if (!OBJECT_ID.test(object.id)) throw new AdPlatformError('bad_request', 'BAD_OBJECT');
    const meta = status === 'paused' ? 'PAUSED' : status === 'archived' ? 'ARCHIVED' : null;
    if (meta === null) throw new AdPlatformError('bad_request', 'STATUS_REFUSED');
    try {
      const answer = await this.graph.call<{ success?: unknown }>('POST', object.id, { token, form: { status: meta }, timeoutMs: CALL_TIMEOUT_MS });
      if (answer.success !== true) throw new AdPlatformError('unknown', 'NOT_CHANGED');
    } catch (error) {
      throw metaAdsError(error, this.now);
    }
  }
}
