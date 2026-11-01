// SPDX-License-Identifier: AGPL-3.0-only
// Ad platforms (ADR-0040 point 3, plan docs/plan/ads.md section 5): the adapters behind the ads module. A connection and
// its sealed credential live in the kernel's channel layer (ADR-0025), one connection per ad account; a platform knows
// how to say which account a credential reaches and how to read an account's daily spend and results over a window.
// Read-only by design: the interface has no capability that creates or changes anything on the platform, and an
// adapter for a platform that also offers writes implements none of them. Each adapter declares the hosts its fetch is
// bound to (the offline sandbox reaches none); a real adapter builds its fetch with `allowlistedFetch` of
// @crove/channel, which this package does not copy.
import { createHash, randomBytes } from 'node:crypto';

// The provider ids a channel connection of an ad account names. `sandbox_ads` is the offline sandbox; the real ones
// (`meta_ads`, `google_ads`, `tiktok_ads`) join when their adapters do (plan slices A2, B and C).
export const AD_PLATFORM_PROVIDERS = ['sandbox_ads'] as const;
export type AdPlatformId = (typeof AD_PLATFORM_PROVIDERS)[number];

export function isAdPlatformProvider(value: string): value is AdPlatformId {
  return (AD_PLATFORM_PROVIDERS as readonly string[]).includes(value);
}

// What a platform declares about itself, as static data: the days after which a figure no longer changes (Meta's
// Insights stop changing after 28 days, plan section 5.2), and the action types an owner may pick as "a result".
export interface AdPlatformCapabilities {
  // A day is settled once it is more than this many days before today in the account's time zone.
  revisionDays: number;
  // The keys of a row's `results` the screens offer as a result.
  resultKinds: readonly string[];
}

// The ad account a credential reaches, as the platform names it: its currency (ISO 4217) and the IANA time zone whose
// midnight bounds its days.
export interface AdPlatformAccount {
  externalAccountId: string;
  displayName: string;
  currency: string;
  timeZone: string;
}

// One day of one object (the account, or a campaign) as the platform reports it, in the account's currency and time
// zone. Money is a decimal string, counts are whole numbers. `reach` is the platform's count of people for that day and
// is not additive: absent when the platform gives none. `results` maps an action type to its count as a decimal string.
export interface AdDailyRow {
  level: 'account' | 'campaign';
  externalObjectId: string;
  objectName: string;
  day: string;
  spend: string;
  impressions: number;
  clicks: number;
  reach: number | null;
  results: Readonly<Record<string, string>>;
}

// Why a read failed, as the channel layer types an error (ADR-0025): a refused token, a missing permission, a request the
// platform rejects, a rate limit (with the time to try again), a passing failure, or one nobody classified. The code is the
// platform's own code, never its message (a message may carry a token or a name).
export type AdPlatformErrorKind = 'token_expired' | 'permission' | 'bad_request' | 'rate_limited' | 'transient' | 'unknown';
export class AdPlatformError extends Error {
  readonly kind: AdPlatformErrorKind;
  readonly code: string | undefined;
  readonly retryAt: Date | undefined;
  constructor(kind: AdPlatformErrorKind, code?: string, retryAt?: Date) {
    super(`ad platform error: ${kind}${code ? ` ${code}` : ''}`);
    this.name = 'AdPlatformError';
    this.kind = kind;
    this.code = code;
    this.retryAt = retryAt;
  }
}

// A connected login: the account id the channel connection is keyed by, its name, and the secret the kernel seals.
// `secret` never leaves the server: the caller seals it with the credential broker and drops it.
export interface AdPlatformLogin {
  provider: AdPlatformId;
  externalAccountId: string;
  displayName: string;
  secret: string;
}

export interface AdPlatform {
  readonly id: AdPlatformId;
  // The hosts this adapter's fetch is bound to.
  readonly hosts: readonly string[];
  readonly capabilities: AdPlatformCapabilities;
  // The ad accounts the credential reaches (one, for a connection made per account).
  accounts(secret: string): Promise<AdPlatformAccount[]>;
  // The daily rows of an account for the days from `from` to `to`, both included (YYYY-MM-DD, in the account's time
  // zone). Days after today are never reported. Account rows and campaign rows come together.
  readDaily(secret: string, externalAccountId: string, range: { from: string; to: string }): Promise<AdDailyRow[]>;
}

// The adapters this deployment offers, by provider id: the sandbox when it is on (ADS_SANDBOX). A real adapter is built
// here with its own fetch; none exists yet.
export function adPlatforms(options: { sandbox: boolean; now?: () => Date }): Readonly<Record<string, AdPlatform>> {
  return options.sandbox ? { sandbox_ads: sandboxAdPlatform(options.now) } : {};
}

// ---------------------------------------------------------------------------------------------------------------------
// The offline sandbox. No network, so the connect and sync flow runs on a laptop and in tests. Its secret is random and
// sealed like any other, so the credential path is exercised end to end. Each login is one ad account in VND (time zone
// of Ho Chi Minh City) or USD (Los Angeles), so the screens meet both a whole-dong figure and cents, and two time zones.
// For a day it reports the same figures every time it is asked, except inside the revision window, where the figure
// drifts with the minute of the hour, as a real platform's recent days change (plan section 5.2).
export const SANDBOX_CURRENCIES = ['VND', 'USD'] as const;
export type SandboxCurrency = (typeof SANDBOX_CURRENCIES)[number];
const SANDBOX_TIME_ZONES: Readonly<Record<SandboxCurrency, string>> = { VND: 'Asia/Ho_Chi_Minh', USD: 'America/Los_Angeles' };
const SANDBOX_CAPABILITIES: AdPlatformCapabilities = { revisionDays: 3, resultKinds: ['purchase', 'lead'] };
const SANDBOX_CAMPAIGNS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'sbx-camp-1', name: 'Khuyến mãi mùa hè' },
  { id: 'sbx-camp-2', name: 'Nhận diện thương hiệu' },
  { id: 'sbx-camp-3', name: 'Tin nhắn Messenger' },
];
// The most days one read covers, and the first day a sandbox account has any figure.
const SANDBOX_MAX_DAYS = 93;
const SANDBOX_FIRST_DAY = '2025-01-01';
const SECRET = /^sbx_[A-Za-z0-9_-]{43}$/;
const KEY = /^[A-Za-z0-9-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Today in a time zone, as YYYY-MM-DD.
function todayIn(timeZone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

interface SandboxSecret {
  accessToken: string;
  currency: SandboxCurrency;
  // What the account id derives from: a caller's key (a retry of one connect is the same account) or a random one.
  key: string;
}

function parseSecret(secret: string): SandboxSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error('sandbox ad platform: invalid secret');
  }
  const { accessToken, currency, key } = (parsed ?? {}) as { accessToken?: unknown; currency?: unknown; key?: unknown };
  if (typeof accessToken !== 'string' || !SECRET.test(accessToken) || !(SANDBOX_CURRENCIES as readonly unknown[]).includes(currency) || typeof key !== 'string' || !KEY.test(key)) {
    throw new Error('sandbox ad platform: invalid secret');
  }
  return { accessToken, currency: currency as SandboxCurrency, key };
}

const accountIdOf = (key: string) => `sbxads-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

// A whole amount of the currency's smallest unit as a decimal string: dong, or cents with two decimals.
function money(units: number, currency: SandboxCurrency): string {
  if (currency === 'VND') return String(units);
  return `${Math.floor(units / 100)}.${String(units % 100).padStart(2, '0')}`;
}

export function sandboxAdPlatform(now: () => Date = () => new Date()): AdPlatform & { connect(input: { displayName: string; currency?: SandboxCurrency; key?: string }): AdPlatformLogin } {
  return {
    id: 'sandbox_ads',
    hosts: [],
    capabilities: SANDBOX_CAPABILITIES,
    connect({ displayName, currency = 'VND', key = randomBytes(16).toString('hex') }): AdPlatformLogin {
      if (!(SANDBOX_CURRENCIES as readonly string[]).includes(currency)) throw new Error('sandbox ad platform: unknown currency');
      if (!KEY.test(key)) throw new Error('sandbox ad platform: invalid key');
      const accessToken = `sbx_${randomBytes(32).toString('base64url')}`;
      const secret = JSON.stringify({ accessToken, currency, key } satisfies SandboxSecret);
      // Keyed by a key of the caller's, or a random one: a retry of one connect is the same account, any other is a new one.
      return { provider: 'sandbox_ads', externalAccountId: accountIdOf(key), displayName, secret };
    },
    async accounts(secret: string): Promise<AdPlatformAccount[]> {
      const { currency, key } = parseSecret(secret);
      return [{ externalAccountId: accountIdOf(key), displayName: `Sandbox ads ${currency}`, currency, timeZone: SANDBOX_TIME_ZONES[currency] }];
    },
    async readDaily(secret: string, externalAccountId: string, range: { from: string; to: string }): Promise<AdDailyRow[]> {
      const { accessToken, currency, key } = parseSecret(secret);
      if (externalAccountId !== accountIdOf(key)) throw new Error('sandbox ad platform: unknown account');
      if (!DAY.test(range.from) || !DAY.test(range.to) || Number.isNaN(dayMs(range.from)) || Number.isNaN(dayMs(range.to)) || range.from > range.to) {
        throw new Error('sandbox ad platform: invalid range');
      }
      if ((dayMs(range.to) - dayMs(range.from)) / DAY_MS >= SANDBOX_MAX_DAYS) throw new Error('sandbox ad platform: range too long');
      const at = now();
      const today = todayIn(SANDBOX_TIME_ZONES[currency], at);
      // Inside the revision window a figure drifts with the minute, up to four small steps, so it is read again.
      const drift = (at.getUTCMinutes() % 5) * (currency === 'VND' ? 1000 : 10);
      const unsettledFrom = isoDay(dayMs(today) - SANDBOX_CAPABILITIES.revisionDays * DAY_MS);
      const last = range.to < today ? range.to : today;
      const first = range.from > SANDBOX_FIRST_DAY ? range.from : SANDBOX_FIRST_DAY;
      const rows: AdDailyRow[] = [];
      for (let ms = dayMs(first); ms <= dayMs(last); ms += DAY_MS) {
        const day = isoDay(ms);
        let spend = 0;
        let impressions = 0;
        let clicks = 0;
        let reach = 0;
        let purchases = 0;
        let leads = 0;
        const campaigns: AdDailyRow[] = [];
        for (const campaign of SANDBOX_CAMPAIGNS) {
          const seed = createHash('sha256').update(`${accessToken}|${campaign.id}|${day}`).digest();
          // A campaign that did not run that day has no row, as a platform reports none.
          if ((seed[0] as number) % 7 === 0) continue;
          const base = currency === 'VND' ? 50_000 + (seed[1] as number) * 2_000 : 500 + (seed[1] as number) * 20;
          const units = base + (day >= unsettledFrom ? drift : 0);
          const shown = 800 + (seed[2] as number) * 40 + Math.floor(units / (currency === 'VND' ? 100 : 1));
          const clicked = Math.floor(shown / 30) + ((seed[3] as number) % 9);
          const people = Math.floor(shown * 0.6);
          const bought = (seed[4] as number) % 4;
          const generated = (seed[5] as number) % 6;
          campaigns.push({
            level: 'campaign',
            externalObjectId: campaign.id,
            objectName: campaign.name,
            day,
            spend: money(units, currency),
            impressions: shown,
            clicks: clicked,
            reach: people,
            results: { purchase: String(bought), lead: String(generated) },
          });
          spend += units;
          impressions += shown;
          clicks += clicked;
          // The people reached in a day overlap between campaigns, so the account's count is less than their sum.
          reach += Math.floor(people * 0.85);
          purchases += bought;
          leads += generated;
        }
        if (campaigns.length === 0) continue;
        rows.push({
          level: 'account',
          externalObjectId: externalAccountId,
          objectName: `Sandbox ads ${currency}`,
          day,
          spend: money(spend, currency),
          impressions,
          clicks,
          reach,
          results: { purchase: String(purchases), lead: String(leads) },
        });
        rows.push(...campaigns);
      }
      return rows;
    },
  };
}
