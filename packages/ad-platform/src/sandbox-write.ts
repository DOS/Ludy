// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox of running ads (ADR-0043, issues #2294 and #2296): the write connection of a sandbox ad account, with no network, so
// the connect, launch and wind-down flow runs on a laptop and in tests. Its token is random, sealed like any other, and its own: the secret
// of the write connection is `{ accessToken: 'sbxw_...', accountId, currency }`, never the secret of the read connection (which
// holds a `sbx_` token and the key its account id derives from), so the reader's derivation of figures stays as it is and one
// connection's secret opens nothing of the other's. The kernel never opens either secret on the API side; the writer is called
// by a job or a command that was handed the opened one.
//
// The writer keeps its objects in memory, in the process that runs it (the PO's decision of 2026-11-03): enough for the offline stack to show a
// launch from the first create to a live ad, and for the tests to make it fail where a real platform does. A worker restart in the offline stack
// forgets the objects, which can only make a lookup by name say "missing" (a retry), never produce a duplicate. Faults are injected with
// `injectFault`: a request that fails before it makes anything (`before`), or one that makes the object and loses the answer (`after`), the case
// the ledger records as ambiguous and the launch reconciles by name.
import { randomBytes } from 'node:crypto';
import type { ConnectedAccount } from '@crove/channel';
import { AdPlatformError, SANDBOX_CURRENCIES, type SandboxCurrency } from './index.ts';
import type {
  AdAccountRef,
  AdInput,
  AdLevel,
  AdObjectState,
  AdSetInput,
  AdTagLookup,
  AdWriter,
  AdWriterRevocation,
  AdWriterVerification,
  CampaignInput,
  CreativeInput,
  TargetingResolution,
} from './writer.ts';

export const SANDBOX_WRITE_PROVIDER = 'sandboxwrite_ads' as const;
// The permissions this connection holds, as the real one's do (the read scope and the one that can change campaigns).
export const SANDBOX_WRITE_SCOPES = ['ads_read', 'ads_management'] as const;

const WRITE_TOKEN = /^sbxw_[A-Za-z0-9_-]{43}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface SandboxWriteSecret {
  accessToken: string;
  // The ad account this token can run ads on: the id of the read connection's account.
  accountId: string;
  currency: SandboxCurrency;
}

// A secret that is not this sandbox's write secret (garbled, the reader's, another provider's) is a refused token.
function parseSecret(secret: string): SandboxWriteSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new AdPlatformError('token_expired', 'BAD_SECRET');
  }
  const { accessToken, accountId, currency } = (parsed ?? {}) as { accessToken?: unknown; accountId?: unknown; currency?: unknown };
  if (typeof accessToken !== 'string' || !WRITE_TOKEN.test(accessToken) || typeof accountId !== 'string' || !ACCOUNT_ID.test(accountId) || !(SANDBOX_CURRENCIES as readonly unknown[]).includes(currency)) {
    throw new AdPlatformError('token_expired', 'BAD_SECRET');
  }
  return { accessToken, accountId, currency: currency as SandboxCurrency };
}

export interface SandboxWriteLoginInput {
  // The ad account the read connection linked (its `externalAccountId`): the write connection is keyed by the same id.
  externalAccountId: string;
  // The account's currency as the read connection recorded it (a text from the database): only VND and USD are the sandbox's, any
  // other is refused here.
  currency: string;
  displayName?: string;
}

// What a connect needs for the write connection of a sandbox account: the connected account (provider, id, name, scopes) and the
// secret the caller seals with the credential broker and drops. Every call draws a new token, so connecting again replaces the
// sealed one.
export function sandboxWriteLogin(input: SandboxWriteLoginInput): ConnectedAccount {
  if (!ACCOUNT_ID.test(input.externalAccountId)) throw new Error('sandbox ad writer: invalid account id');
  const currency = (SANDBOX_CURRENCIES as readonly string[]).find((c) => c === input.currency);
  if (currency === undefined) throw new Error('sandbox ad writer: unknown currency');
  const accessToken = `sbxw_${randomBytes(32).toString('base64url')}`;
  const secret = JSON.stringify({ accessToken, accountId: input.externalAccountId, currency: currency as SandboxCurrency } satisfies SandboxWriteSecret);
  return {
    provider: SANDBOX_WRITE_PROVIDER,
    externalAccountId: input.externalAccountId,
    displayName: (input.displayName ?? `Sandbox ads ${input.currency} (running ads)`).slice(0, 200),
    scopes: [...SANDBOX_WRITE_SCOPES],
    expiresAt: null,
    secret,
  };
}

// The calls a fault can be put on.
export type SandboxOperation = 'resolveTargeting' | 'createCampaign' | 'createAdSet' | 'createCreative' | 'createAd' | 'setStatus' | 'readObjects' | 'findByTag' | 'revokeToken';
export interface SandboxFault {
  operation: SandboxOperation;
  // `before`: the request fails and nothing is made. `after`: the object is made (or the status set) and the answer is lost.
  when: 'before' | 'after';
  // The error the caller sees; a network failure by default (a timeout: the outcome is not known).
  error?: AdPlatformError;
  // How many calls it hits (default one).
  times?: number;
}

// An object of the sandbox, as the tests and the screens of the offline stack see it.
export interface SandboxObject {
  externalId: string;
  level: AdLevel;
  accountId: string;
  name: string;
  // The object it belongs to (an ad set's campaign, an ad's ad set), for the status it shows while its parent is paused.
  parentId: string | null;
  configured: 'ACTIVE' | 'PAUSED';
  activatedAt: Date | null;
  // An ad whose text carries this marker is rejected in review, so the screens meet a rejection offline.
  rejected: boolean;
}

export const SANDBOX_REJECT_MARKER = '[reject]';
// A name carrying one of these is not a targeting entry the sandbox can pin down, so the launch's stop for it can be seen offline.
export const SANDBOX_UNKNOWN_MARKER = '(unknown)';
export const SANDBOX_AMBIGUOUS_MARKER = '(ambiguous)';

export interface SandboxAdWriterOptions {
  now?: () => Date;
  // How long an ad that was activated stays in review before it is active.
  reviewSeconds?: number;
}

function digitsOf(text: string): string {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0)!, 16777619) >>> 0;
  return String(7_000_000_000 + h);
}

export class SandboxAdWriter implements AdWriter {
  readonly provider = SANDBOX_WRITE_PROVIDER;
  private readonly now: () => Date;
  private readonly reviewMs: number;
  private readonly store = new Map<string, SandboxObject>();
  private readonly faults: SandboxFault[] = [];
  private counter = 0;

  constructor(options: SandboxAdWriterOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.reviewMs = (options.reviewSeconds ?? 20) * 1000;
  }

  // The next calls of an operation fail as asked (see `SandboxFault`).
  injectFault(fault: SandboxFault): void {
    this.faults.push({ ...fault, times: fault.times ?? 1 });
  }

  // Every object made so far, in the order they were made.
  objects(): readonly SandboxObject[] {
    return [...this.store.values()];
  }

  private fault(operation: SandboxOperation, when: SandboxFault['when']): void {
    const found = this.faults.find((f) => f.operation === operation && f.when === when && (f.times ?? 1) > 0);
    if (!found) return;
    found.times = (found.times ?? 1) - 1;
    throw found.error ?? new AdPlatformError('transient', 'NETWORK');
  }

  private account(secret: string, ref: AdAccountRef): string {
    const { accountId } = parseSecret(secret);
    // A token that does not reach this account is a missing permission, as the real platform says it.
    if (accountId !== ref.externalAccountId) throw new AdPlatformError('permission', 'ACCOUNT_NOT_REACHED');
    return accountId;
  }

  private make(operation: SandboxOperation, level: AdLevel, accountId: string, name: string, parentId: string | null, rejected = false): { externalId: string } {
    if (name.trim() === '') throw new AdPlatformError('bad_request', 'BAD_NAME');
    this.fault(operation, 'before');
    this.counter += 1;
    const externalId = String(900_000_000_000 + this.counter);
    this.store.set(externalId, { externalId, level, accountId, name, parentId, configured: 'PAUSED', activatedAt: null, rejected });
    this.fault(operation, 'after');
    return { externalId };
  }

  private known(id: string, level: AdLevel, accountId: string): SandboxObject {
    const parent = this.store.get(id);
    if (!parent || parent.level !== level || parent.accountId !== accountId) throw new AdPlatformError('bad_request', '100');
    return parent;
  }

  // Opens nothing remote: it reads the secret, checks that it is for this account, and answers that it can run ads.
  async verify(secret: string, account: AdAccountRef): Promise<AdWriterVerification> {
    this.account(secret, account);
    return { canRunAds: true, scopes: [...SANDBOX_WRITE_SCOPES] };
  }

  // The sandbox has no platform behind it, so there is no copy of the permission to remove: the secret must still be this sandbox's (a garbled
  // one is refused as it is everywhere), and the answer says there was nothing at a platform. The revoke path of the worker runs the same
  // steps for the sandbox as for Meta, so the offline stack exercises it.
  async revokeToken(secret: string): Promise<AdWriterRevocation> {
    parseSecret(secret);
    this.fault('revokeToken', 'before');
    this.fault('revokeToken', 'after');
    return { how: 'sandbox' };
  }

  async resolveTargeting(secret: string, names: { interests: readonly string[]; regions: ReadonlyArray<{ country: string; region: string }> }): Promise<TargetingResolution> {
    parseSecret(secret);
    this.fault('resolveTargeting', 'before');
    const out: TargetingResolution = { interests: { resolved: [], unknown: [], ambiguous: [] }, regions: { resolved: [], unknown: [], ambiguous: [] } };
    for (const name of names.interests) {
      if (name.includes(SANDBOX_UNKNOWN_MARKER)) out.interests.unknown.push(name);
      else if (name.includes(SANDBOX_AMBIGUOUS_MARKER)) out.interests.ambiguous.push(name);
      else out.interests.resolved.push({ name, id: digitsOf(`interest:${name.toLowerCase()}`) });
    }
    for (const { country, region } of names.regions) {
      if (region.includes(SANDBOX_UNKNOWN_MARKER)) out.regions.unknown.push(`${country}:${region}`);
      else if (region.includes(SANDBOX_AMBIGUOUS_MARKER)) out.regions.ambiguous.push(`${country}:${region}`);
      else out.regions.resolved.push({ country, name: region, key: digitsOf(`region:${country}:${region.toLowerCase()}`) });
    }
    this.fault('resolveTargeting', 'after');
    return out;
  }

  async createCampaign(secret: string, account: AdAccountRef, input: CampaignInput): Promise<{ externalId: string }> {
    return this.make('createCampaign', 'campaign', this.account(secret, account), input.name, null);
  }

  async createAdSet(secret: string, account: AdAccountRef, input: AdSetInput): Promise<{ externalId: string }> {
    const accountId = this.account(secret, account);
    this.known(input.campaignId, 'campaign', accountId);
    if (!/^[1-9]\d{0,15}$/.test(input.dailyBudgetMinor)) throw new AdPlatformError('bad_request', 'BAD_BUDGET');
    return this.make('createAdSet', 'ad_set', accountId, input.name, input.campaignId);
  }

  async createCreative(secret: string, account: AdAccountRef, input: CreativeInput): Promise<{ externalId: string }> {
    const accountId = this.account(secret, account);
    // The marker travels with the creative: the ad that shows it is the one rejected in review.
    return this.make('createCreative', 'creative', accountId, input.name, null, input.message.includes(SANDBOX_REJECT_MARKER) || input.headline.includes(SANDBOX_REJECT_MARKER));
  }

  async createAd(secret: string, account: AdAccountRef, input: AdInput): Promise<{ externalId: string }> {
    const accountId = this.account(secret, account);
    this.known(input.adSetId, 'ad_set', accountId);
    const creative = this.known(input.creativeId, 'creative', accountId);
    return this.make('createAd', 'ad', accountId, input.name, input.adSetId, creative.rejected);
  }

  // The account of a token and the objects it may touch: an object of another account is "not found", as on the real platform.
  async setStatus(secret: string, objectId: string, status: 'ACTIVE' | 'PAUSED'): Promise<void> {
    const { accountId } = parseSecret(secret);
    const object = this.store.get(objectId);
    if (!object || object.accountId !== accountId || object.level === 'creative') throw new AdPlatformError('bad_request', '100');
    this.fault('setStatus', 'before');
    if (object.configured !== status) {
      object.configured = status;
      object.activatedAt = status === 'ACTIVE' ? this.now() : object.activatedAt;
    }
    this.fault('setStatus', 'after');
  }

  async readObjects(secret: string, objects: ReadonlyArray<{ level: Exclude<AdLevel, 'creative'>; externalId: string }>): Promise<AdObjectState[]> {
    const { accountId } = parseSecret(secret);
    this.fault('readObjects', 'before');
    const states: AdObjectState[] = [];
    for (const { level, externalId } of objects) {
      const object = this.store.get(externalId);
      if (!object || object.accountId !== accountId || object.level !== level) continue;
      const adSet = object.level === 'ad' && object.parentId ? this.store.get(object.parentId) : object.level === 'ad_set' ? object : undefined;
      const campaign = adSet?.parentId ? this.store.get(adSet.parentId) : object.level === 'campaign' ? object : undefined;
      let effective: string = object.configured;
      let reasons: string[] = [];
      if (object.configured === 'ACTIVE') {
        if (campaign && campaign.configured === 'PAUSED' && object.level !== 'campaign') effective = 'CAMPAIGN_PAUSED';
        else if (object.level === 'ad' && adSet && adSet.configured === 'PAUSED') effective = 'ADSET_PAUSED';
        else if (object.level === 'ad' && object.rejected) {
          effective = 'DISAPPROVED';
          reasons = ['sandbox_policy'];
        } else if (object.level === 'ad' && object.activatedAt && this.now().getTime() - object.activatedAt.getTime() < this.reviewMs) effective = 'PENDING_REVIEW';
      }
      states.push({ externalId, configuredStatus: object.configured, effectiveStatus: effective, reasons });
    }
    this.fault('readObjects', 'after');
    return states;
  }

  async findByTag(secret: string, account: AdAccountRef, level: AdLevel, name: string): Promise<AdTagLookup> {
    const accountId = this.account(secret, account);
    this.fault('findByTag', 'before');
    const same = [...this.store.values()].filter((o) => o.accountId === accountId && o.level === level && o.name === name);
    this.fault('findByTag', 'after');
    const [only] = same;
    if (same.length === 1 && only) return { kind: 'found', externalId: only.externalId };
    return same.length > 1 ? { kind: 'unknowable', reason: 'duplicates' } : { kind: 'missing' };
  }
}

// The writer the offline stack's worker uses: one per process.
export const sandboxAdWriter = new SandboxAdWriter();
