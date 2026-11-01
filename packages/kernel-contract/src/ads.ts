// SPDX-License-Identifier: AGPL-3.0-only
// The ads module (issue #2217, plan docs/plan/ads.md, ADR-0040): the ad accounts an org connected and the daily spend and
// results their platforms report, read only. The inputs its commands and queries take and the views they return; the app
// reads the same types. Money is a decimal string, never a number (AGENTS.md); counts are whole numbers.
import { z } from 'zod';
import { zTimeZone } from './calendar.ts';
import { zAccountCode, zId, zLocalDate, zMoney } from './schemas.ts';

// An ad account's connection names its provider as a channel connection does (ADR-0025). The ad platforms' ids end in
// `_ads` (`sandbox_ads`, later `meta_ads`, `google_ads`, `tiktok_ads`), which is how the Social screens leave them out.
const AD_PROVIDER_ID = /^[a-z][a-z0-9]{0,26}_ads$/;
export const isAdProviderId = (provider: string): boolean => AD_PROVIDER_ID.test(provider);

// Months of history a first sync reads and the app keeps (plan section 2, owner answer Q4 of #2214).
export const ADS_BACKFILL_MONTHS = 13;
// The most rows one sync command takes, and so the most a job hands it per call (a month or so of a large account).
export const ADS_MAX_ROWS_PER_RUN = 20_000;
// The most days a summary spans.
export const ADS_SUMMARY_MAX_DAYS = 400;
// The most result keys a row carries.
export const ADS_RESULTS_MAX_KEYS = 50;
// A manual refresh of one account is refused when the last one is younger than this.
export const ADS_REQUEST_MIN_SECONDS = 60;
// Days the sync runs of an account are kept (the daily sweep prunes older ones).
export const ADS_SYNC_RUN_DAYS = 90;
// How a sync fails, as the channel layer types an error.
export const ADS_ERROR_KINDS = ['token_expired', 'permission', 'bad_request', 'rate_limited', 'transient', 'unknown'] as const;
export type AdsErrorKind = (typeof ADS_ERROR_KINDS)[number];
export const ADS_LEVELS = ['account', 'campaign'] as const;
export type AdsLevel = (typeof ADS_LEVELS)[number];
export const ADS_SANDBOX_CURRENCIES = ['VND', 'USD'] as const;

const zCurrency = z.string().regex(/^[A-Z]{3}$/);
// A spend as the platform reports it: a decimal string, at most six decimals.
const zSpend = z.string().regex(/^\d{1,16}(\.\d{1,6})?$/, 'non-negative decimal string');
const zCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
// An action's count as a decimal string.
const zResultCount = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'non-negative decimal string');
const zResults = z
  .record(z.string().min(1).max(100), zResultCount)
  .refine((r) => Object.keys(r).length <= ADS_RESULTS_MAX_KEYS, `at most ${ADS_RESULTS_MAX_KEYS} result keys`);

// One day of one object as an adapter reports it (@crove/ad-platform AdDailyRow); the sync command checks the whole answer
// again, since an adapter's answer is external data.
export const zAdDailyRow = z.strictObject({
  level: z.enum(ADS_LEVELS),
  externalObjectId: z.string().min(1).max(200),
  objectName: z.string().max(300),
  day: zLocalDate,
  spend: zSpend,
  impressions: zCount,
  clicks: zCount,
  reach: zCount.nullable(),
  results: zResults,
});
export type AdDailyRowInput = z.infer<typeof zAdDailyRow>;

// An org owner or admin links a connection's ad account to a legal entity's books (the entity defaults to the org's).
export const zAdsAccountLink = z.strictObject({
  connectionId: zId,
  legalEntityId: zId.optional(),
  expenseAccountCode: zAccountCode.nullable().optional(),
  // A keyed hash of the platform user who granted the connection (@crove/ad-platform platformUserHash), so the platform's data
  // deletion callback can find the accounts that person granted without the id being stored (plan section 9).
  // null: the platform did not name the person this time, so a hash kept from an earlier grant is dropped, not left to name someone
  // who did not grant this one. Left out: a link that says nothing of it (the sandbox, a link made again) keeps what is there.
  grantedByHash: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
});
export type AdsAccountLink = z.infer<typeof zAdsAccountLink>;

// An owner or admin deletes an account's stored figures and sync log (owner answer Q4 of #2214). A connected account reads its
// 13 months again; one whose connection is closed also loses its row.
export const zAdsAccountDeleteHistory = z.strictObject({ adAccountId: zId });
export type AdsAccountDeleteHistory = z.infer<typeof zAdsAccountDeleteHistory>;

export const zAdsAccountConfigure = z.strictObject({
  adAccountId: zId,
  legalEntityId: zId.optional(),
  // null clears it.
  expenseAccountCode: zAccountCode.nullable().optional(),
  resultKind: z.string().trim().min(1).max(100).nullable().optional(),
});
export type AdsAccountConfigure = z.infer<typeof zAdsAccountConfigure>;

// What a sync hands the command after it read a window: the account's own details (its currency and time zone, the
// platform's; the name stays the one the owner connected it under), the window it read, the day before which every day is final, and the rows. Every figure in the window that
// is not in the rows is removed (the platform no longer reports it).
export const zAdsSyncRecord = z.strictObject({
  adAccountId: zId,
  details: z.strictObject({ currency: zCurrency, timeZone: zTimeZone }),
  window: z.strictObject({ from: zLocalDate, to: zLocalDate }),
  // Days strictly before this are final; null: none is (a platform with no revision window reports none settled).
  settleBefore: zLocalDate.nullable(),
  rows: z.array(zAdDailyRow).max(ADS_MAX_ROWS_PER_RUN),
});
export type AdsSyncRecord = z.infer<typeof zAdsSyncRecord>;

export const zAdsSyncFailure = z.strictObject({
  adAccountId: zId,
  errorKind: z.enum(ADS_ERROR_KINDS),
  // The platform's error code, never its message (a message may carry a token or a name).
  errorCode: z.string().max(100).optional(),
  retryAt: z.iso.datetime({ offset: true }).optional(),
  window: z.strictObject({ from: zLocalDate, to: zLocalDate }).optional(),
});
export type AdsSyncFailure = z.infer<typeof zAdsSyncFailure>;

// Running ads (ADR-0043, #2294): the spend caps, in the currency's own units as a decimal string above zero, never a number. A
// cap is set or raised by a proposal and lowered directly.
export const ADS_CAP_SCOPES = ['org', 'account'] as const;
export const ADS_CAP_PERIODS = ['daily', 'monthly'] as const;
const zCapAmount = z.string().regex(/^(?!0+(\.0+)?$)\d{1,15}(\.\d{1,2})?$/, 'a decimal above zero');
// A currency code of ISO 4217, from the platform's own list (a typo such as VDN is refused before it is a cap).
const ISO_CURRENCIES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));
const zCapCurrency = zCurrency.refine((code) => ISO_CURRENCIES.has(code), 'an ISO 4217 currency code');
// An org cap names no account, an account cap names one.
const capNamesAccount = (c: { scope: 'org' | 'account'; adAccountId?: string | undefined }) => (c.scope === 'org') === (c.adAccountId === undefined);
const capNamesAccountIssue = { message: 'an org cap names no account, an account cap names one', path: ['adAccountId'] };
// What a person asks for when setting or raising a cap (the proposal's request) ...
export const zAdsCapRequest = z
  .strictObject({ scope: z.enum(ADS_CAP_SCOPES), adAccountId: zId.optional(), period: z.enum(ADS_CAP_PERIODS), amount: zCapAmount, currency: zCapCurrency })
  .refine(capNamesAccount, capNamesAccountIssue);
export type AdsCapRequest = z.infer<typeof zAdsCapRequest>;
// ... and what lowering one takes: the currency is the cap's own.
export const zAdsCapLower = z
  .strictObject({ scope: z.enum(ADS_CAP_SCOPES), adAccountId: zId.optional(), period: z.enum(ADS_CAP_PERIODS), amount: zCapAmount })
  .refine(capNamesAccount, capNamesAccountIssue);
export type AdsCapLower = z.infer<typeof zAdsCapLower>;
// The same with the idempotency key of the API call.
export const zAdsCapLowerCall = z
  .strictObject({ scope: z.enum(ADS_CAP_SCOPES), adAccountId: zId.optional(), period: z.enum(ADS_CAP_PERIODS), amount: zCapAmount, idempotencyKey: zId })
  .refine(capNamesAccount, capNamesAccountIssue);

// The proposals that open the way to spend (ADR-0043 point 1): their kinds (the Inbox item's kind) and the payload each stores,
// which the target command reads back on approval. The names are display copies; the ids and amounts are the change.
export const ADS_WRITE_ENABLE_COMMAND = 'ads.write.enable';
export const ADS_ACCOUNT_ENABLE_COMMAND = 'ads.account.enable_write';
export const ADS_CAP_SET_COMMAND = 'ads.cap.set';
export const ADS_LAUNCHES_UNBLOCK_COMMAND = 'ads.launches.unblock';
export const ADS_PROPOSAL_KIND_PREFIX = 'ads.';
export const ADS_WRITE_ENABLE_KIND = 'ads.write_enable';
export const ADS_ACCOUNT_ENABLE_KIND = 'ads.account_enable';
export const ADS_CAP_SET_KIND = 'ads.cap_set';
export const ADS_LAUNCHES_UNBLOCK_KIND = 'ads.launches_unblock';
export const zAdsWriteEnablePayload = z.strictObject({});
export const zAdsAccountEnablePayload = z.strictObject({ adAccountId: zId, adAccountName: z.string().max(200) });
export const zAdsCapSetPayload = z
  .strictObject({
    scope: z.enum(ADS_CAP_SCOPES),
    adAccountId: zId.optional(),
    adAccountName: z.string().max(200).optional(),
    period: z.enum(ADS_CAP_PERIODS),
    amount: zCapAmount,
    currency: zCapCurrency,
    // The cap in force when it was asked for, for the approver to compare with; null when there was none.
    previous: z.string().nullable(),
    previousCurrency: z.string().nullable(),
  })
  .refine(capNamesAccount, capNamesAccountIssue);
export const zAdsLaunchesUnblockPayload = z.strictObject({});

// A pending or decided proposal of this kind as the screens show it: what it changes, in one shape.
export const zAdsChange = z.discriminatedUnion('change', [
  z.object({ change: z.literal('write_enable') }),
  z.object({ change: z.literal('account_enable'), adAccountId: zId, adAccountName: z.string() }),
  z.object({
    change: z.literal('cap_set'),
    scope: z.enum(ADS_CAP_SCOPES),
    adAccountId: zId.nullable(),
    adAccountName: z.string().nullable(),
    period: z.enum(ADS_CAP_PERIODS),
    amount: z.string(),
    currency: zCurrency,
    previous: z.string().nullable(),
    previousCurrency: z.string().nullable(),
  }),
  z.object({ change: z.literal('launches_unblock') }),
]);
export type AdsChange = z.infer<typeof zAdsChange>;
export const zAdsProposalView = z.object({ change: zAdsChange.nullable() });

// Asking for one of those changes (the API call: owners and admins; it makes a proposal in the Inbox, never the change).
export const zAdsChangeRequest = z.discriminatedUnion('change', [
  z.strictObject({ change: z.literal('write_enable'), idempotencyKey: zId }),
  z.strictObject({ change: z.literal('account_enable'), adAccountId: zId, idempotencyKey: zId }),
  z
    .strictObject({
      change: z.literal('cap_set'),
      scope: z.enum(ADS_CAP_SCOPES),
      adAccountId: zId.optional(),
      period: z.enum(ADS_CAP_PERIODS),
      amount: zCapAmount,
      currency: zCapCurrency,
      idempotencyKey: zId,
    })
    .refine(capNamesAccount, capNamesAccountIssue),
  z.strictObject({ change: z.literal('launches_unblock'), idempotencyKey: zId }),
]);
export type AdsChangeRequest = z.infer<typeof zAdsChangeRequest>;

export const zAdsCapView = z.object({
  scope: z.enum(ADS_CAP_SCOPES),
  adAccountId: zId.nullable(),
  period: z.enum(ADS_CAP_PERIODS),
  amount: z.string(),
  currency: zCurrency,
  setBy: zId,
  setAt: z.string(),
});
export type AdsCapView = z.infer<typeof zAdsCapView>;

// The switches of running ads and the current caps (owners and admins read them).
export const zAdsWriteState = z.object({
  writeEnabled: z.boolean(),
  launchesBlocked: z.boolean(),
  updatedAt: z.string().nullable(),
  caps: z.array(zAdsCapView),
  // The requests waiting in the Inbox for approval, newest first (the card says so and links to them).
  pending: z.array(z.object({ proposalId: zId, change: zAdsChange, requestedAt: z.string() })),
});
export type AdsWriteState = z.infer<typeof zAdsWriteState>;

export const zAdsSummaryInput =z.strictObject({ adAccountId: zId, from: zLocalDate, to: zLocalDate });
export type AdsSummaryInput = z.infer<typeof zAdsSummaryInput>;

export const zAdAccountView = z.object({
  id: zId,
  connectionId: zId,
  connectionStatus: z.enum(['active', 'expired', 'revoked', 'error']),
  // When the connection stopped being active, and why in one word: a paused account's screen says so and offers to connect it
  // again (null while the connection is active). The platform refused the token, or the member who connected it left, or an
  // owner or admin disconnected it, or the platform asked for its data to be deleted.
  pausedSince: z.string().nullable(),
  pausedReason: z.enum(['token_expired', 'owner_left', 'disconnected', 'platform_deletion', 'other']).nullable(),
  // An owner enabled this account for running ads (ADR-0043). It does not yet mean ads can run: the org switch and a token that
  // can change campaigns (W0b) are needed too.
  writeEnabled: z.boolean(),
  // The permissions the connection's token holds beyond reading ad reports (empty for the sandbox and for a token that holds
  // only ads_read): the screen says when it can do more than read.
  extraScopes: z.array(z.string()),
  provider: z.string(),
  name: z.string(),
  // The platform's, from the first sync: null before it.
  currency: z.string().nullable(),
  timeZone: z.string().nullable(),
  legalEntityId: zId,
  expenseAccountCode: z.string().nullable(),
  resultKind: z.string().nullable(),
  // The result keys the platform's adapter offers; empty when this deployment has none for the provider.
  resultKinds: z.array(z.string()),
  backfillFrom: zLocalDate,
  settledThrough: zLocalDate.nullable(),
  syncedThrough: zLocalDate.nullable(),
  lastRunAt: z.string().nullable(),
  lastErrorKind: z.enum(ADS_ERROR_KINDS).nullable(),
  nextRunAt: z.string().nullable(),
});
export type AdAccountView = z.infer<typeof zAdAccountView>;

// What a stretch of days adds up to: spend in the account's currency, whole counts, the count of the chosen result and the
// cost per result (spend over results, null when there is no result). Reach is not here: it is not additive.
export const zAdsMetric = z.object({
  spend: zMoney,
  impressions: z.number(),
  clicks: z.number(),
  results: z.string().nullable(),
  costPerResult: z.string().nullable(),
});
export type AdsMetric = z.infer<typeof zAdsMetric>;

export const zAdsSummary = z.object({
  adAccountId: zId,
  currency: z.string().nullable(),
  timeZone: z.string().nullable(),
  resultKind: z.string().nullable(),
  from: zLocalDate,
  to: zLocalDate,
  total: zAdsMetric,
  months: z.array(zAdsMetric.extend({ month: z.string().regex(/^\d{4}-\d{2}$/) })),
  campaigns: z.array(zAdsMetric.extend({ externalObjectId: z.string(), name: z.string() })),
  days: z.array(zAdsMetric.extend({ day: zLocalDate, reach: z.number().nullable(), settled: z.boolean() })),
  settledThrough: zLocalDate.nullable(),
  syncedThrough: zLocalDate.nullable(),
});
export type AdsSummary = z.infer<typeof zAdsSummary>;

export const zAdsSyncRunView = z.object({
  id: zId,
  status: z.enum(['ok', 'failed']),
  windowFrom: zLocalDate.nullable(),
  windowTo: zLocalDate.nullable(),
  rowsWritten: z.number(),
  errorKind: z.enum(ADS_ERROR_KINDS).nullable(),
  errorCode: z.string().nullable(),
  retryAt: z.string().nullable(),
  startedAt: z.string(),
});
export type AdsSyncRunView = z.infer<typeof zAdsSyncRunView>;
