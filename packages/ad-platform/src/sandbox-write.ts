// SPDX-License-Identifier: AGPL-3.0-only
// The offline sandbox of running ads (ADR-0043, issue #2294, W0b): the write connection of a sandbox ad account, with no network, so
// the connect and verify flow runs on a laptop and in tests. Its token is random, sealed like any other, and its own: the secret
// of the write connection is `{ accessToken: 'sbxw_...', accountId, currency }`, never the secret of the read connection (which
// holds a `sbx_` token and the key its account id derives from), so the reader's derivation of figures stays as it is and one
// connection's secret opens nothing of the other's. The kernel never opens either secret on the API side; the writer is called
// by a job or a command that was handed the opened one.
import { createHash, randomBytes } from 'node:crypto';
import type { ConnectedAccount } from '@crove/channel';
import { AdPlatformError, SANDBOX_CURRENCIES, type SandboxCurrency } from './index.ts';
import {
  AD_WRITER_OBJECTIVES,
  type AdCreateAd,
  type AdCreateAdSet,
  type AdCreateCampaign,
  type AdCreateCreative,
  type AdFoundObject,
  type AdObjectLevel,
  type AdTargetingQuery,
  type AdTargetingResolution,
  type AdWriter,
  type AdWriterAccount,
  type AdWriterCapabilities,
  type AdWriterRevocation,
  type AdWriterVerification,
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

// An object the sandbox "created": what a real platform would hold for the account, in memory.
export interface SandboxWrittenObject {
  id: string;
  level: AdObjectLevel;
  name: string;
  accountId: string;
  status: 'paused' | 'archived';
  // The campaign of an ad set, the ad set of an ad (a creative has none).
  parentId: string | null;
}

// A failure the sandbox can be told to make, so a test can kill a launch between a create and its record: `after` makes the object and loses the answer (the
// case reconcile exists for), `before` fails with nothing made. `times` calls are hit, one by default.
export interface SandboxWriterFault {
  level: AdObjectLevel;
  when: 'before' | 'after';
  error?: AdPlatformError;
  times?: number;
}

export interface SandboxAdWriterOptions {
  // Names (an interest as written, a region as `name (CC)`) that the sandbox's targeting search does not know.
  unknownTargeting?: readonly string[];
}

const BUDGET = /^(?!0+(\.0+)?$)\d{1,13}(\.\d{1,2})?$/;

// Opens nothing remote and keeps what it creates in memory (the worker's offline stack and the tests): it reads the secret, checks that it is for this account,
// and creates, finds and pauses objects the way the platform would, every object PAUSED. A restart of the process loses the objects, which only makes a
// reconcile answer "missing" (a create is made again), never a duplicate.
export class SandboxAdWriter implements AdWriter {
  readonly provider = SANDBOX_WRITE_PROVIDER;
  // The sandbox launches every objective in every currency, and takes a media file.
  readonly capabilities: AdWriterCapabilities = Object.freeze({ objectives: AD_WRITER_OBJECTIVES, currencies: null, media: true });
  // What it holds, by id; a test reads it.
  readonly objects = new Map<string, SandboxWrittenObject>();
  // The create calls it received (the level, whether or not they were failed), in order.
  readonly received: AdObjectLevel[] = [];
  private readonly faults: SandboxWriterFault[] = [];
  private readonly unknown: ReadonlySet<string>;
  // An id is unique across restarts of the process: the objects are in memory and are lost with it, but their ids stay recorded in the database, and a new
  // process must never hand one out again.
  private readonly instance = randomBytes(4).toString('hex');
  private counter = 0;

  constructor(options: SandboxAdWriterOptions = {}) {
    this.unknown = new Set((options.unknownTargeting ?? []).map((n) => n.toLowerCase()));
  }

  // Makes the next calls of a level fail (see SandboxWriterFault).
  inject(fault: SandboxWriterFault): void {
    this.faults.push({ ...fault });
  }

  // Opens nothing remote: it reads the secret, checks that it is for this account, and answers that it can run ads.
  async verify(secret: string, account: { externalAccountId: string }): Promise<AdWriterVerification> {
    const { accountId } = parseSecret(secret);
    // A token that does not reach this account is a missing permission, as the real platform says it.
    if (accountId !== account.externalAccountId) throw new AdPlatformError('permission', 'ACCOUNT_NOT_REACHED');
    return { canRunAds: true, scopes: [...SANDBOX_WRITE_SCOPES] };
  }

  // The sandbox has no platform behind it, so there is no copy of the permission to remove: the secret must still be this sandbox's (a garbled
  // one is refused as it is everywhere), and the answer says there was nothing at a platform. The revoke path of the worker runs the same
  // steps for the sandbox as for Meta, so the offline stack exercises it.
  async revokeToken(secret: string): Promise<AdWriterRevocation> {
    parseSecret(secret);
    return { how: 'sandbox' };
  }

  private reach(secret: string, account: AdWriterAccount): string {
    const { accountId } = parseSecret(secret);
    if (accountId !== account.externalAccountId) throw new AdPlatformError('permission', 'ACCOUNT_NOT_REACHED');
    return accountId;
  }

  // The fault, if one is due for this call: taken off the list as it is used.
  private due(level: AdObjectLevel, when: 'before' | 'after'): SandboxWriterFault | undefined {
    const index = this.faults.findIndex((f) => f.level === level && f.when === when);
    const fault = this.faults[index];
    if (!fault) return undefined;
    fault.times = (fault.times ?? 1) - 1;
    if (fault.times <= 0) this.faults.splice(index, 1);
    return fault;
  }

  private make(secret: string, account: AdWriterAccount, level: AdObjectLevel, name: string, parentId: string | null): { id: string } {
    const accountId = this.reach(secret, account);
    this.received.push(level);
    const before = this.due(level, 'before');
    if (before) throw before.error ?? new AdPlatformError('transient', 'NETWORK');
    if (name.trim() === '') throw new AdPlatformError('bad_request', 'NAME_REQUIRED');
    this.counter += 1;
    const id = `sbx${this.instance}-${level.replace('_', '')}-${this.counter}`;
    this.objects.set(id, { id, level, name, accountId, status: 'paused', parentId });
    const after = this.due(level, 'after');
    if (after) throw after.error ?? new AdPlatformError('transient', 'NETWORK');
    return { id };
  }

  private parent(accountId: string, level: AdObjectLevel, id: string): void {
    const object = this.objects.get(id);
    if (!object || object.level !== level || object.accountId !== accountId) throw new AdPlatformError('bad_request', 'PARENT_NOT_FOUND');
  }

  async createCampaign(secret: string, account: AdWriterAccount, input: AdCreateCampaign): Promise<{ id: string }> {
    return this.make(secret, account, 'campaign', input.name, null);
  }

  async createAdSet(secret: string, account: AdWriterAccount, input: AdCreateAdSet): Promise<{ id: string }> {
    this.parent(this.reach(secret, account), 'campaign', input.campaignId);
    if (!BUDGET.test(input.dailyBudget)) throw new AdPlatformError('bad_request', 'BUDGET_INVALID');
    return this.make(secret, account, 'ad_set', input.name, input.campaignId);
  }

  async createCreative(secret: string, account: AdWriterAccount, input: AdCreateCreative): Promise<{ id: string }> {
    return this.make(secret, account, 'creative', input.name, null);
  }

  async createAd(secret: string, account: AdWriterAccount, input: AdCreateAd): Promise<{ id: string }> {
    const accountId = this.reach(secret, account);
    this.parent(accountId, 'ad_set', input.adSetId);
    this.parent(accountId, 'creative', input.creativeId);
    return this.make(secret, account, 'ad', input.name, input.adSetId);
  }

  async findByTag(secret: string, account: AdWriterAccount, level: AdObjectLevel, tag: string): Promise<AdFoundObject[]> {
    const accountId = this.reach(secret, account);
    return [...this.objects.values()].filter((o) => o.accountId === accountId && o.level === level && o.name.includes(tag)).map((o) => ({ id: o.id, name: o.name }));
  }

  async resolveTargeting(secret: string, query: AdTargetingQuery): Promise<AdTargetingResolution> {
    parseSecret(secret);
    // The ids are a hash of the name, so the same name resolves to the same id every time.
    const idOf = (prefix: string, text: string) => `${prefix}-${createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 10)}`;
    const regions: Array<{ country: string; name: string; key: string }> = [];
    const interests: Array<{ name: string; id: string }> = [];
    const unknown: string[] = [];
    for (const region of query.regions) {
      const shown = `${region.name} (${region.country})`;
      if (this.unknown.has(shown.toLowerCase())) unknown.push(shown);
      else regions.push({ country: region.country, name: region.name, key: idOf('sbxr', `${region.country}:${region.name}`) });
    }
    for (const name of query.interests) {
      if (this.unknown.has(name.toLowerCase())) unknown.push(name);
      else interests.push({ name, id: idOf('sbxi', name) });
    }
    return { regions, interests, unknown };
  }

  async setStatus(secret: string, object: { level: AdObjectLevel; id: string }, status: 'paused' | 'archived'): Promise<void> {
    parseSecret(secret);
    if (status !== 'paused' && status !== 'archived') throw new AdPlatformError('bad_request', 'STATUS_REFUSED');
    const found = this.objects.get(object.id);
    if (!found || found.level !== object.level) throw new AdPlatformError('bad_request', 'OBJECT_NOT_FOUND');
    found.status = status;
  }
}

// The worker's offline writer (one per process); tests make their own.
export const sandboxAdWriter = new SandboxAdWriter();
