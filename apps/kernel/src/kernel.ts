// The composition root (plan Decision 12, ADR-0030). createKernel takes the configuration and one adapter per port
// and starts the server roles; it builds no adapter itself. main.ts wires the open-source defaults from
// configuration (defaultAdapters); a Ludy Cloud entrypoint wires its own adapters into the same factory.
import { hostname } from 'node:os';
import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { configureUploadTimeouts } from './upload-timeouts.ts';
import { memberMeter } from './ai-meter.ts';
import { createMeetingsBriefWriter, summaryModelPort, type ModelPort } from './member-vy-ports.ts';
import { AdsCampaignWriter, ConversationWriter, InboxReader, InvoiceExtractor, SchedulingReader, SignAiReader, SocialWriter, TodayWriter, WeeklyWriter, type InvoiceReader } from '@ludy/agent';
import {
  BlueskyPublisher,
  TELEGRAM_HOOK_KEY_INFO,
  TelegramConversations,
  TelegramPublisher,
  DiscordPublisher,
  MastodonPublisher,
  WordPressPublisher,
  FacebookPageConnector,
  FacebookPagePublisher,
  InstagramConnector,
  InstagramPublisher,
  SandboxPublisher,
  LinkedInConnector,
  LinkedInPageConnector,
  LinkedInPagePublisher,
  TikTokConnector,
  TikTokPublisher,
  TikTokRefresher,
  YouTubeConnector,
  YouTubePublisher,
  YouTubeRefresher,
  GoogleBusinessConnector,
  GoogleCalendarAdapter,
  MicrosoftCalendarAdapter,
  type CalendarAdapter,
  GoogleBusinessPublisher,
  GoogleBusinessRefresher,
  LinkedInPublisher,
  XConnector,
  XPublisher,
  XRefresher,
  PinterestConnector,
  PinterestPublisher,
  PinterestRefresher,
  ThreadsConnector,
  ThreadsPublisher,
  ThreadsRefresher,
  ZaloOaConnector,
  ZaloOaPublisher,
  ZaloOaRefresher,
  Graph,
  WhatsAppConversations,
  CHANNEL_OPTIONS_CALL_TIMEOUT_MS,
  meetingPlatformAdapters,
  type ConversationAdapter,
  type OAuthConnector,
  type Publisher,
  type Refresher,
} from '@ludy/channel';
import { createExtractClient } from '@ludy/extract-contract';
import { MEETING_PLATFORM_VIDEO_MAX_BYTES, type ModuleManifest } from '@ludy/kernel-contract';
import { assertRlsEnforced, assertSystemContextAccess, createDb, createPool, singleCell, type CellResolver, type Db } from '@ludy/db';
import { buildKernelCommands, kernelManifest, kernelQueries, setMeetingPlatformVideoImport, setMessageIdDomain, type OverviewContribution } from '@ludy/kernel';
import {
  LocalDiskStore,
  egressFetch,
  Runtime,
  SUBJECT_WRAP_INFO,
  SubjectVault,
  type BlobStore,
  readVerified,
  type CommandDef,
  type CredentialBroker,
  type QueryDef,
  type RuntimeOptions,
  type SessionStatusSource,
  mintContextToken,
} from '@ludy/kernel-runtime';
import { financeAgentPrograms, financeCommands, financeManifest, financeQueries } from '@ludy/mod-finance';
import { socialAgentPrograms, socialCommands, socialManifest, socialOverviewContributions, socialQueries } from '@ludy/mod-social';
import { crmAgentPrograms, crmCommands, crmManifest, crmQueries } from '@ludy/mod-crm';
import { hrCommands, hrManifest, hrQueries } from '@ludy/mod-hr';
import { notesCommands, notesManifest, notesQueries } from '@ludy/mod-notes';
import { projectsCommands, projectsManifest, projectsQueries, setProjectsGithubAppInfo, setProjectsGithubBrokerAvailable } from '@ludy/mod-projects';
import { createGithubClient } from '@ludy/github';
import { githubTransport } from './github-transport.ts';
import { adsBusy, adsCommands, adsManifest, adsQueries } from '@ludy/mod-ads';
import { meetingsBusy, meetingsCommands, meetingsManifest, meetingsQueries, setMeetingVideoImport, setSummaryEnabled, setTranscribeBroker, setTranscribeEnabled, setTranslationTargets } from '@ludy/mod-meetings';
import {
  setSignCaBrokerAvailable,
  setSignLiveCaEnabled,
  setSignWebhookBrokerAvailable,
  signAiCommands,
  signAiQueries,
  signCommands,
  signManifest,
  signQueries,
} from '@ludy/mod-sign';
import { GoogleAdsConnector, MetaAdsConnector, MetaWriteConnector, adActivators, adLaunchWriters, adManagers, adPausers, adPlatforms, adRevokers, adStateReaders, type AdActivator, type AdManager, type AdPauser, type AdPlatform, type AdRevoker, type AdStateReader, type LaunchWriter } from '@ludy/ad-platform';
import { createMisaEInvoiceProvider, createSandboxEInvoiceProvider, misaBlockers, type EInvoiceProvider } from '@ludy/einvoice';
import { misaTransport } from './einvoice-transport.ts';
import { createAmisClient, type AmisCallbackKey, type AmisClient, type AmisTransport } from '@ludy/misa-amis';
import { amisTransport } from './misa-amis-transport.ts';
import { createSandboxMarketplaceProvider, isMarketplaceAdapter, type MarketplaceProvider } from '@ludy/mod-finance';
import { LAZADA_HOSTS, lazadaCaller, lazadaMarketplace } from './marketplace-lazada.ts';
import { lazadaFinance } from './marketplace-lazada-finance.ts';
import { withLazadaIncome } from './marketplace-income-leg.ts';
import { withLazadaAuthorize } from './marketplace-lazada-authorize.ts';
import { isMarketplacePushAdapter } from './marketplace-push.ts';
import { createAuthenticator, type Authenticate } from './auth.ts';
import { AVAILABLE_MODULES, appUrl, assertExportKey, assertSplitRoles, extractConcurrency, usageLimits, zaloMediaHostsOf, type Config, type ModuleId } from './config.ts';
import { createCredentialBroker, noCredentialBroker } from './credentials.ts';
import { mediaAudioExtractorFor } from './meetings-extract.ts';
import { mediaMeasurerFor } from './meetings-measure.ts';
import { rebindExports as rebindOrgExports } from './export-rebind.ts';
import { numberReseedCommand, runRestoreReport } from './restore-report.ts';
import { exportSealer } from './export-seal.ts';
import { webhookTarget, type WebhookTarget } from './alert.ts';
import type { SecurityThresholds } from './security-signals.ts';
import { orgPurgeCommand, runOrgPurge } from './org-purge.ts';
import { replayShreds, runMeetingsRetention, sweepMeetingMedia } from './meetings-retention.ts';
import { countTelegramWebhookRekeyLeft, rekeyTelegramWebhooks as runTelegramWebhookRekey } from './conversations-worker.ts';
import { runUserDisable } from './user-disable.ts';
import { ConcurrencyLimiter, Semaphore } from './concurrency.ts';
import { createOauthServer } from './oauth-server.ts';
import { createHttpApp, type StreamDeps } from './http.ts';
import { createLogProvider, createMailer, messageIdDomain, type MailProvider } from './mail.ts';
import { MAIL_TEMPLATES } from './mail-templates.ts';
import { createSessionRevoker, createSessionStatusSource, type SessionRevoker } from './sessions.ts';
import { createArchiveStore, createBlobStore } from './storage.ts';
import type { SocialDrafter } from './rpc.ts';
import { StreamHub, createDbTicketStore, createPgNotificationSource } from './stream.ts';
import { createPexels } from './stock-photos.ts';
import { createMediaUrls } from './media-urls.ts';
import { createTaxCodeLookup } from './tax-lookup.ts';
import { createPortalSync } from './portal-sync.ts';
import { createTaxPortalClient, testPortalAllowed } from './tax-portal.ts';
import { setInboundAuthservId } from './inbound.ts';
import { startWorker, workerApplicationName } from './worker.ts';
import { configureOpsAlerts, flushOpsAlerts } from './ops-alert.ts';

// How long a stop waits for the queued operational alerts to post (#1993).
const STOP_FLUSH_MS = 5_000;
import { createPushSender, loadVapidKeys } from './web-push.ts';
import type { NativePushOutcome, NativePushPayload, NativePushSender, NativePushTarget } from './native-push.ts';
export type { NativePushOutcome, NativePushPayload, NativePushSender, NativePushTarget };
import { WORKER_LAG_EXIT_MS, WORKER_LAG_SUSTAIN_MS, startLagWatchdog } from './back-pressure.ts';
import { bankFeedHostedProviders, bankFeedProviders, type BankFeedProvider } from '@ludy/bank-feed';
import { hostBoundFetch } from './marketplace-adapter-kit.ts';
import { LAZADA_TOKEN_HOSTS, LazadaRefresher } from './marketplace-lazada-token.ts';
import { SHOPEE_TOKEN_HOSTS, ShopeeRefresher } from './marketplace-shopee-token.ts';
import { TIKTOK_TOKEN_HOSTS, TiktokRefresher } from './marketplace-tiktok-token.ts';
import { TIKTOK_HOSTS, tiktokCaller } from './marketplace-tiktok.ts';
import { tiktokMarketplace } from './marketplace-tiktok-orders.ts';
import { withTiktokAuthorize } from './marketplace-tiktok-authorize.ts';

// Identity (ADR-0027, ADR-0028): who the caller is and whether their session still holds. When
// sessions.liveCheckForR3 is true, the authenticator must set confirmLive on each user, or every R3 command fails
// closed with 503.
export interface IdentityPort {
  // Checked in the transaction of every user request; never "no check" in a server.
  readonly sessions: SessionStatusSource;
  // The API's request authenticator, bound to the API role's database.
  authenticator(db: Db): Authenticate;
  // Upstream sign-out after a Ludy-side revoke; null keeps revocation in Ludy only.
  readonly revoker: SessionRevoker | null;
}

export type { CredentialBroker } from '@ludy/kernel-runtime';
export { noCredentialBroker } from './credentials.ts';

// A connector to an outside system (e-invoice issuing, banks). The core ships none; Ludy Cloud adds its own.
export interface Connector {
  readonly id: string;
}

// Which module entitlements an org holds (plan Decision 10). Self-host grants every module.
// The contract the per-org app gate relies on (ADR-0053): answer the keys the org holds, `full` for every app, and [] for an org with no plan,
// which holds no app but kernel. Throw (or time out, 3 seconds) only when the service itself is unavailable: the runtime then fails open to the
// last answer it had for the org, `full` when it has none, so a failing port must never be how an org is told it holds nothing. The runtime
// caches an answer for a minute per org and asks once at a time per org; the function should be cheap and safe to call often.
export interface Billing {
  entitlements(orgId: string): Promise<readonly string[]>;
}

export interface KernelAdapters {
  identity: IdentityPort;
  // The AI invoice reader; null runs without AI (e-invoice XML still works, PDF and images do not).
  ai: InvoiceReader | null;
  // Drafts Social posts (Social plan S7) through the same endpoint; null runs without AI drafting.
  writer?: (Pick<SocialWriter, 'draft' | 'rewrite'> & Partial<Pick<SocialWriter, 'hashtags' | 'describeImage' | 'ideas' | 'summary'>>) | null;
  // Reads the days and times a client's message asks for (#1440) through the same endpoint; null: suggestions give
  // the next free slots only.
  scheduler?: Pick<SchedulingReader, 'read'> | null;
  // Vy's reply drafts for the conversation core (CV8, #2310) through the same endpoint; null: no draft is made and "Vy soạn" says so.
  conversationWriter?: Pick<ConversationWriter, 'draft'> | null;
  // Vy's daily brief on Home (#2383) through the same endpoint; null: Home shows the plain template.
  today?: Pick<TodayWriter, 'brief'> | null;
  // Vy's "Tuần này" on Home (#3257) through the same endpoint; null: Home shows the template built from the figures.
  weekly?: Pick<WeeklyWriter, 'weekly'> | null;
  // The AI coworker's campaign drafts for running ads (W1b, #2295) through the same endpoint; null: no draft is made and a request says so (AI_OFF).
  adsCampaignWriter?: Pick<AdsCampaignWriter, 'draft'> | null;
  // The Inbox's suggested intent and likely contacts (CV3, #2306) through the same endpoint; null: no suggestion, the inbox as it is.
  // The model behind the recorder's Vy summary of a meeting (#2580); the route is on only with MEETINGS_SUMMARY=on as well.
  summaryModel?: ModelPort | null;
  // Vy's eSign field placement, risky clause review, obligation extraction, playbook checks, and signer KYC attachment check (#3351, #3821, #4442, #4443); null runs manual signing without AI.
  signAi?:
    | (Pick<SignAiReader, 'proposeFields' | 'summarizeRiskClauses'> &
        Partial<
          Pick<
            SignAiReader,
            'summarizeVersionDiff'
            | 'proposeContractClauses'
            | 'extractObligations'
            | 'answerVaultQuestion'
            | 'checkPlaybook'
            | 'checkKycAttachment'
          >
        >)
    | null;
  inboxReader?: (Pick<InboxReader, 'intents' | 'rank' | 'rankCompanies'> & Partial<Pick<InboxReader, 'reminderWords' | 'followupWords' | 'overviewSentence' | 'monthCloseNote' | 'expenseVarianceNotes' | 'unusualEntriesNotes' | 'quarterSummaryNotes' | 'cashForecastSentence' | 'vatLateSentence' | 'payrollMatchSentence' | 'signDepositMatchSentence' | 'marketplaceLineSentence' | 'marketplaceFeeNotes' | 'marketplaceProposalNote' | 'marketplaceColumns' | 'supplierPayableLineSentence' | 'bankCandidatesLineSentence' | 'misaCheckLineSentence' | 'misaAmisBlockerNotes' | 'stockSurplusNote' | 'einvoiceRateExplanation' | 'einvoiceReasonSuggestion' | 'stockMatch' | 'reorderText' | 'einvoiceDraft' | 'quoteLines' | 'crmFollowupWords' | 'meetingBrief' | 'projectWeeklyStatus' | 'projectCycleSummary' | 'roadmapDedupe' | 'roadmapChangelogDraft' | 'roadmapSignalMatch' | 'projectTriageAssist' | 'payrollPrepare' | 'payrollFlag' | 'payrollExplain' | 'payrollDiffExplain' | 'laborCheck' | 'recruitingBrief' | 'attendanceAnomalies' | 'cvExtract' | 'hrProbationSummary' | 'hrRequestDraft' | 'hrPolicyQa' | 'hrAddendumCheck' | 'hrOkrCheckinDraft' | 'signAcceptanceDraft'>>) | null;
  storage: BlobStore;
  // Outbound mail (member invites, issue #129); the default logs that nothing was sent.
  mail?: MailProvider;
  broker?: CredentialBroker;
  connectors?: readonly Connector[];
  billing?: Billing;
  // Open mobile native push sender (#4883); unset on self-host so native push stays disabled with no vendor SDKs or secrets.
  nativePush?: NativePushSender | null;
}

export type ResolvedAdapters = Required<KernelAdapters>;

export type ServerRole = 'api' | 'worker' | 'all';

export interface Kernel {
  readonly config: Config;
  // The modules this deployment registers (LUDY_MODULES; kernel always).
  readonly modules: readonly ModuleId[];
  readonly adapters: Readonly<ResolvedAdapters>;
  // Starts the role's servers and resolves to a function that stops them in reverse order.
  start(role: ServerRole): Promise<() => Promise<void>>;
  // After a restore into a new bucket: re-records each org's export with the restored object versions, as the worker
  // (issue #351, export-rebind.ts). Resolves to the exit code.
  rebindExports(orgIds: readonly string[]): Promise<number>;
  // The operator blocks (true) or unblocks a user account, as the worker (issue #985, user-disable.ts). Resolves to the
  // exit code.
  setUserStatus(disabled: boolean, argv: readonly string[]): Promise<number>;
  // The operator purges an offboarded org by its deletion map and closes it, as the worker (issue #1024,
  // org-purge.ts). Resolves to the exit code.
  purgeOrg(argv: readonly string[]): Promise<number>;
  // After a restore: what the WORM archive holds that the database lacks, and with --reseed the number series raised
  // above it, as the worker (issue #2007, restore-report.ts). Resolves to the exit code.
  restoreReport(argv: readonly string[]): Promise<number>;
  // After a restore (#2579): deletes again the meetings the shred references name, re-runs the retention and removes the objects that leaves; 0 or 1.
  shredReplay(): Promise<number>;
  // After a CREDENTIAL_KEY rotation (#3150 item 1): re-registers live Telegram webhooks under the current credential key; 0 or 1.
  rekeyTelegramWebhooks(): Promise<number>;
}

// No-op defaults for the optional ports: nothing can be bound, no connector is installed, every module is on.
export const selfHostBilling: Billing = { entitlements: async () => ['full'] };

const REQUIRED = ['identity', 'ai', 'storage'] as const;

export interface ModuleDefinitions {
  commands: CommandDef<any, any>[];
  queries: QueryDef<any, any>[];
}

// The figures each module adds to the multi-client home (#1261); a module without any is left out.
const OVERVIEW_CONTRIBUTIONS: Partial<Record<ModuleId, readonly OverviewContribution[]>> = { social: socialOverviewContributions };

// The overview contributions of the modules LUDY_MODULES enables, which kernel.org.overview runs in each org.
export function overviewContributions(config: Pick<Config, 'LUDY_MODULES'>): OverviewContribution[] {
  return config.LUDY_MODULES.flatMap((module) => OVERVIEW_CONTRIBUTIONS[module] ?? []);
}

// Transcription of meetings is on only with MEETINGS_TRANSCRIBE=on and a provider (#2578, M4b); the module works with it off.
export function transcribeEnabled(config: Pick<Config, 'MEETINGS_TRANSCRIBE' | 'TRANSCRIBE_BASE_URL' | 'TRANSCRIBE_MODEL'>): boolean {
  return config.MEETINGS_TRANSCRIBE === 'on' && Boolean(config.TRANSCRIBE_BASE_URL) && Boolean(config.TRANSCRIBE_MODEL);
}

// The recorder's Vy may summarize a meeting only with MEETINGS_SUMMARY=on (#2580, M6); the module works with it off.
export function summaryEnabled(config: Pick<Config, 'MEETINGS_SUMMARY'>): boolean {
  return config.MEETINGS_SUMMARY === 'on';
}

// The commands and queries of the modules LUDY_MODULES enables (plan Decision 12, ADR-0031). A module left out has
// none registered, so its commands answer COMMAND_NOT_FOUND, a ctx.query into it answers not_installed (with the
// absentModules buildRuntime passes), and the
// routes and jobs that ask Runtime.installed() are not registered either.
// `billing` answers the org's entitlements for kernel.org.apps (ADR-0053); self-host grants every module.
export function moduleDefinitions(config: Config, billing: Billing = selfHostBilling): ModuleDefinitions {
  // Mail a module queues (the scheduled report, #704) gets the deployment's Message-ID domain too.
  setMessageIdDomain(messageIdDomain(config));
  setInboundAuthservId(config.INBOUND_AUTHSERV_ID);
  // Whether the recorder may start a transcription here (#2578, M4b): MEETINGS_TRANSCRIBE=on with a provider.
  setTranscribeEnabled(transcribeEnabled(config));
  // The worker takes a transcription job only with the credential key (a broker); without it the start is refused with its own code instead of queueing a job nobody works (#2863).
  setTranscribeBroker(Boolean(config.CREDENTIAL_KEY ?? config.CREDENTIAL_KEY_FILE));
  setSummaryEnabled(summaryEnabled(config));
  // The translation languages besides vi and en this deployment offers (#3186): none unless MEETINGS_TRANSLATION_LANGUAGES names them.
  setTranslationTargets(config.MEETINGS_TRANSLATION_LANGUAGES);
  // A platform's video-only recording can be imported only where crove-media can take its audio out (C2a, #3306): MEDIA_URL.
  setMeetingVideoImport(Boolean(config.MEDIA_URL));
  setMeetingPlatformVideoImport(config.MEDIA_URL ? Math.min(MEETING_PLATFORM_VIDEO_MAX_BYTES, config.MEDIA_MAX_INPUT_BYTES ?? Number.POSITIVE_INFINITY) : null);
  setSignLiveCaEnabled(config.SIGN_LIVE_CA_ENABLED === 'true');
  const hasCredentialKey = Boolean(config.CREDENTIAL_KEY ?? config.CREDENTIAL_KEY_FILE);
  setSignCaBrokerAvailable(hasCredentialKey);
  setSignWebhookBrokerAvailable(hasCredentialKey);
  setProjectsGithubBrokerAvailable(hasCredentialKey);
  setProjectsGithubAppInfo({
    configured: Boolean(
      config.GITHUB_APP_ID &&
        config.GITHUB_APP_PRIVATE_KEY &&
        config.GITHUB_APP_CLIENT_ID &&
        config.GITHUB_APP_CLIENT_SECRET &&
        config.GITHUB_APP_WEBHOOK_SECRET,
    ),
    slug: config.GITHUB_APP_SLUG ?? null,
  });
  const all: Record<ModuleId, () => ModuleDefinitions> = {
    kernel: () => ({
      commands: buildKernelCommands({
        orgCreateLimits: { perDay: config.ORG_CREATE_LIMIT_PER_DAY, total: config.ORG_CREATE_LIMIT_TOTAL },
        inboundRotateLimits: { perDay: config.INBOUND_ROTATE_LIMIT_PER_DAY, total: config.INBOUND_ROTATE_LIMIT_TOTAL },
        uploadBeginLimits: { perMinute: config.UPLOAD_BEGIN_LIMIT_PER_MINUTE },
        inviteLimits: { perRecipientPerDay: config.INVITE_LIMIT_PER_RECIPIENT_PER_DAY },
        messageIdDomain: messageIdDomain(config),
        shippedModules: AVAILABLE_MODULES,
        appBusy: { meetings: meetingsBusy, ads: adsBusy },
        apps: { deployment: config.LUDY_MODULES, entitlements: (orgId) => billing.entitlements(orgId) },
      }),
      queries: kernelQueries({
        inboundDomain: config.INBOUND_DOMAIN ?? null,
        overview: overviewContributions(config),
        apps: { shipped: AVAILABLE_MODULES, deployment: config.LUDY_MODULES, entitlements: (orgId) => billing.entitlements(orgId) },
      }),
    }),
    finance: () => ({ commands: financeCommands, queries: financeQueries }),
    social: () => ({ commands: socialCommands, queries: socialQueries }),
    ads: () => ({ commands: adsCommands, queries: adsQueries }),
    crm: () => ({ commands: crmCommands, queries: crmQueries }),
    notes: () => ({ commands: notesCommands, queries: notesQueries }),
    meetings: () => ({ commands: meetingsCommands, queries: meetingsQueries }),
    projects: () => ({ commands: projectsCommands, queries: projectsQueries }),
    sign: () => ({ commands: [...signCommands, ...signAiCommands], queries: [...signQueries, ...signAiQueries] }),
    hr: () => ({ commands: hrCommands, queries: hrQueries }),
  };
  const enabled = config.LUDY_MODULES.map((module) => all[module]());
  return { commands: enabled.flatMap((m) => m.commands), queries: enabled.flatMap((m) => m.queries) };
}

// Fails the API's boot when the kernel's context token key is not the one the database holds (#1822): every user
// command would fail otherwise. The database answers only whether a token's signature verifies.
async function assertContextTokenKey(pool: ReturnType<typeof createPool>, key: string): Promise<void> {
  const nil = '00000000-0000-4000-8000-000000000000';
  const token = mintContextToken(key, { userId: nil, sessionId: null, orgId: nil, aal: 'aal1', mfaAt: null });
  const { rows } = await pool.query<{ ok: boolean }>('SELECT ludy_kernel.context_token_valid($1) AS ok', [token]);
  if (rows[0]?.ok !== true) throw new Error('LUDY_CONTEXT_TOKEN_KEY is not the key the database holds: run the migrate step with it first');
}

// The manifests of the modules LUDY_MODULES enables (plan §5.2). The runtime checks every command's declared writes
// against their tables when the command registers (#1710), so P04 rests on the manifests' column classes.
const MODULE_MANIFESTS: Record<ModuleId, ModuleManifest> = {
  kernel: kernelManifest,
  finance: financeManifest,
  social: socialManifest,
  ads: adsManifest,
  crm: crmManifest,
  notes: notesManifest,
  meetings: meetingsManifest,
  projects: projectsManifest,
  sign: signManifest,
  hr: hrManifest,
};

export function moduleManifests(config: Pick<Config, 'LUDY_MODULES'>): ModuleManifest[] {
  return config.LUDY_MODULES.map((module) => MODULE_MANIFESTS[module]);
}

// The runtime of every server role, and the only place the server constructs one: the enabled modules' commands and
// queries, registered on a runtime given their manifests, so every declared write, and any command registered on it
// later (the org purge), is checked against them (P04, #1710). apps/kernel/test/invariant/command-writes.test.ts holds
// the server to both.
// The vault of the per-subject keys: HKDF-derived from the credential key and from CREDENTIAL_KEY_PREVIOUS the same way, so values sealed before a rotation still open.
function subjectVaultOf(config: Config): SubjectVault | null {
  const keys = createCredentialBroker(config).deriveKeys?.(SUBJECT_WRAP_INFO) ?? [];
  if (keys.length === 0) return null;
  const vault = new SubjectVault(keys);
  // The vault keeps its own copies: the derived buffers are wiped.
  for (const k of keys) k.key.fill(0);
  return vault;
}

// `billing` answers the org's entitlements to the per-org app gate (ADR-0053): the runtime is always given its function, so a caller cannot
// leave the gate without one (it would hold every app for every org); self-host's port grants `full`.
export function serverRuntime(cells: CellResolver, config: Config, options: Omit<RuntimeOptions, 'absentModules' | 'manifests' | 'entitlements'> & { billing?: Billing }): Runtime {
  const { billing, ...runtimeOptions } = options;
  // Modules this build ships that LUDY_MODULES leaves out (ADR-0031).
  const absentModules = AVAILABLE_MODULES.filter((module) => !config.LUDY_MODULES.includes(module));
  const runtime = new Runtime(cells, {
    // The key of the sensitive-read audit hash: derived from the credential key (environment or key file, never the database), none without one.
    readAuditKey: createCredentialBroker(config).derive?.('crove.audit.read.v1') ?? null,
    // The roots of ctx.keyedHash (#3113): derived from every credential key this deployment opens (newest first), never from the database; the per-purpose and per-org keys come from them inside
    // the runtime, and the key id lets a stored hash be told from one made after a rotation.
    keyedHashRoots: createCredentialBroker(config).deriveKeys?.('crove.keyed-hash.root.v1') ?? [],
    ...runtimeOptions,
    // ctx.query into one of them answers not_installed; any other unknown query is QUERY_NOT_FOUND.
    absentModules,
    // The per-org app gate asks the billing port which apps the org holds (ADR-0053). After the spread: no caller's option replaces it.
    entitlements: (orgId) => (billing ?? selfHostBilling).entitlements(orgId),
    // The subject keys (ADR-0017): wrap keys derived from every credential key this deployment opens, none without one.
    subjectVault: subjectVaultOf(config),
    // Every declared write must name a manifest table with that manifest's column classes (P04, #1710).
    manifests: moduleManifests(config).map((manifest) => manifest.tables),
  }).register(moduleDefinitions(config, billing));
  // A command registry that does not fit together (a reviser naming no proposal command, two revisers for one
  // command) fails the boot (#216). Revisers of commands in modules this deployment leaves out are not checked.
  runtime.validate({ absentModules });
  return runtime;
}

// OAuth connectors of the providers this deployment has app credentials for (Social plan S6); a provider without
// them is not offered.
type ChannelConfig = Pick<Config, 'CHANNEL_SANDBOX' | 'CHANNEL_BLUESKY' | 'CHANNEL_TELEGRAM' | 'CHANNEL_MASTODON' | 'CHANNEL_DISCORD' | 'CHANNEL_WORDPRESS' | 'CHANNEL_THREADS_APP_ID' | 'CHANNEL_THREADS_APP_SECRET' | 'CHANNEL_LINKEDIN_CLIENT_ID' | 'CHANNEL_LINKEDIN_CLIENT_SECRET' | 'CHANNEL_GOOGLE_CLIENT_ID' | 'CHANNEL_GOOGLE_CLIENT_SECRET' | 'CHANNEL_GOOGLE_BUSINESS' | 'CHANNEL_TIKTOK_CLIENT_KEY' | 'CHANNEL_TIKTOK_CLIENT_SECRET' | 'CHANNEL_TIKTOK_VIDEO_LIST' | 'CHANNEL_TIKTOK_INBOX' | 'CHANNEL_X_CLIENT_ID' | 'CHANNEL_X_CLIENT_SECRET' | 'CHANNEL_PINTEREST_APP_ID' | 'CHANNEL_PINTEREST_APP_SECRET' | 'CHANNEL_META_APP_ID' | 'CHANNEL_META_APP_SECRET' | 'CHANNEL_META_ADS_APP_ID' | 'CHANNEL_META_ADS_APP_SECRET' | 'CHANNEL_META_ADS_WRITE_APP_ID' | 'CHANNEL_META_ADS_WRITE_APP_SECRET' | 'CHANNEL_META_GRAPH_VERSION' | 'CHANNEL_ZALO_APP_ID' | 'CHANNEL_ZALO_APP_SECRET' | 'MARKETPLACE_PROVIDERS'> &
  Partial<Pick<Config, 'MARKETPLACE_INCOME_PROVIDERS' | 'CHANNEL_INSTAGRAM_APP_ID' | 'CHANNEL_INSTAGRAM_APP_SECRET' | 'CHANNEL_GOOGLE_ADS_CLIENT_ID' | 'CHANNEL_GOOGLE_ADS_CLIENT_SECRET' | 'CHANNEL_X_METRICS' | 'CHANNEL_LINKEDIN_ANALYTICS' | 'CHANNEL_LINKEDIN_ORGANIZATIONS' | 'CHANNEL_LINKEDIN_PAGE_CLIENT_ID' | 'CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET' | 'BRAND_NAME'>>;
// The LinkedIn app, for Company Pages too once it has the Community Management API (#1077).
// The Company Pages app: its own when set (LinkedIn grants the Community Management API only to an app with no other
// product), the member app otherwise.
const linkedinPagesApp = (config: Pick<Config, 'CHANNEL_LINKEDIN_CLIENT_ID' | 'CHANNEL_LINKEDIN_CLIENT_SECRET'> & Partial<Pick<Config, 'CHANNEL_LINKEDIN_ORGANIZATIONS' | 'CHANNEL_LINKEDIN_PAGE_CLIENT_ID' | 'CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET'>>) => {
  if (config.CHANNEL_LINKEDIN_ORGANIZATIONS !== 'true') return null;
  if (config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID && config.CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET) return { clientId: config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID, clientSecret: config.CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET };
  return config.CHANNEL_LINKEDIN_CLIENT_ID && config.CHANNEL_LINKEDIN_CLIENT_SECRET ? { clientId: config.CHANNEL_LINKEDIN_CLIENT_ID, clientSecret: config.CHANNEL_LINKEDIN_CLIENT_SECRET } : null;
};
const xApp = (config: Pick<Config, 'CHANNEL_X_CLIENT_ID' | 'CHANNEL_X_CLIENT_SECRET'>) => (config.CHANNEL_X_CLIENT_ID && config.CHANNEL_X_CLIENT_SECRET ? { clientId: config.CHANNEL_X_CLIENT_ID, clientSecret: config.CHANNEL_X_CLIENT_SECRET } : null);
const pinterestApp = (config: Pick<Config, 'CHANNEL_PINTEREST_APP_ID' | 'CHANNEL_PINTEREST_APP_SECRET'>) =>
  config.CHANNEL_PINTEREST_APP_ID && config.CHANNEL_PINTEREST_APP_SECRET ? { appId: config.CHANNEL_PINTEREST_APP_ID, appSecret: config.CHANNEL_PINTEREST_APP_SECRET } : null;
const zaloApp = (config: Pick<Config, 'CHANNEL_ZALO_APP_ID' | 'CHANNEL_ZALO_APP_SECRET'>) => (config.CHANNEL_ZALO_APP_ID && config.CHANNEL_ZALO_APP_SECRET ? { appId: config.CHANNEL_ZALO_APP_ID, appSecret: config.CHANNEL_ZALO_APP_SECRET } : null);
// The Meta app of the WhatsApp product (#3131): its secret proves the Graph calls and checks the webhook. Unset: WhatsApp is not offered. The connect form is
// offered only with the verify token too (the webhook route needs both), so a number is never connected where no customer's message could arrive.
type WhatsAppConfig = Partial<Pick<Config, 'CHANNEL_WHATSAPP_APP_SECRET' | 'CHANNEL_META_GRAPH_VERSION'>>;
export const whatsappApp = (config: WhatsAppConfig) => (config.CHANNEL_WHATSAPP_APP_SECRET ? { appSecret: config.CHANNEL_WHATSAPP_APP_SECRET, graphVersion: config.CHANNEL_META_GRAPH_VERSION } : null);
// The conversation adapters of channels that never publish (so have no Publisher), by provider id: the worker sends their replies and fetches their images.
export function channelConversationAdapters(config: WhatsAppConfig): Record<string, ConversationAdapter> {
  const whatsapp = whatsappApp(config);
  return whatsapp ? { whatsapp: new WhatsAppConversations(new Graph(whatsapp.appSecret, whatsapp.graphVersion)) } : {};
}

// The meeting platforms a deployment has (Meetings C1 to C4): the offline sandbox when the channel sandbox is on, Zoom only when the deployment has its own Zoom OAuth app, Teams only when it has its own
// Microsoft Entra app, and Google Meet only when it has a Google OAuth client for it (all off by default).
export function meetingPlatformsOf(config: Pick<Config, 'CHANNEL_SANDBOX' | 'ZOOM_OAUTH_CLIENT_ID' | 'ZOOM_OAUTH_CLIENT_SECRET' | 'TEAMS_OAUTH_CLIENT_ID' | 'TEAMS_OAUTH_CLIENT_SECRET' | 'MEETINGS_GOOGLE_CLIENT_ID' | 'MEETINGS_GOOGLE_CLIENT_SECRET' | 'MEETINGS_GOOGLE_PICKER_API_KEY' | 'MEETINGS_GOOGLE_PICKER_APP_ID'>) {
  return meetingPlatformAdapters({
    sandbox: config.CHANNEL_SANDBOX === 'true',
    ...(config.MEETINGS_GOOGLE_CLIENT_ID && config.MEETINGS_GOOGLE_CLIENT_SECRET ? { google: { clientId: config.MEETINGS_GOOGLE_CLIENT_ID, clientSecret: config.MEETINGS_GOOGLE_CLIENT_SECRET } } : {}),
    // The Picker route (#3174): the Google adapter also offers and reads a recording of a conference with no transcript, only where the operator set the Picker's key and app id.
    googleRecordings: Boolean(config.MEETINGS_GOOGLE_PICKER_API_KEY && config.MEETINGS_GOOGLE_PICKER_APP_ID && config.MEETINGS_GOOGLE_CLIENT_ID),
    ...(config.ZOOM_OAUTH_CLIENT_ID && config.ZOOM_OAUTH_CLIENT_SECRET ? { zoom: { clientId: config.ZOOM_OAUTH_CLIENT_ID, clientSecret: config.ZOOM_OAUTH_CLIENT_SECRET } } : {}),
    ...(config.TEAMS_OAUTH_CLIENT_ID && config.TEAMS_OAUTH_CLIENT_SECRET ? { teams: { clientId: config.TEAMS_OAUTH_CLIENT_ID, clientSecret: config.TEAMS_OAUTH_CLIENT_SECRET } } : {}),
  });
}

// The outside calendar providers this deployment has an OAuth app for (#2123), by OAuth provider id; one without
// credentials is not offered, and with none the connect buttons are hidden.
export function calendarAdapters(config: Pick<Config, 'CALENDAR_GOOGLE_CLIENT_ID' | 'CALENDAR_GOOGLE_CLIENT_SECRET' | 'CALENDAR_MICROSOFT_CLIENT_ID' | 'CALENDAR_MICROSOFT_CLIENT_SECRET' | 'CALENDAR_MICROSOFT_TENANT'>): Partial<Record<string, CalendarAdapter>> {
  const adapters: Partial<Record<string, CalendarAdapter>> = {};
  if (config.CALENDAR_GOOGLE_CLIENT_ID && config.CALENDAR_GOOGLE_CLIENT_SECRET) adapters.google_calendar = new GoogleCalendarAdapter({ clientId: config.CALENDAR_GOOGLE_CLIENT_ID, clientSecret: config.CALENDAR_GOOGLE_CLIENT_SECRET });
  if (config.CALENDAR_MICROSOFT_CLIENT_ID && config.CALENDAR_MICROSOFT_CLIENT_SECRET) {
    adapters.microsoft_calendar = new MicrosoftCalendarAdapter({ clientId: config.CALENDAR_MICROSOFT_CLIENT_ID, clientSecret: config.CALENDAR_MICROSOFT_CLIENT_SECRET, ...(config.CALENDAR_MICROSOFT_TENANT ? { tenant: config.CALENDAR_MICROSOFT_TENANT } : {}) });
  }
  return adapters;
}

// The ad platforms this deployment offers (ADR-0040): the offline sandbox when ADS_SANDBOX is on, Meta when the deployment
// has its ad app (#2218). Each is bound to its own hosts; the worker reads through them, and the API only asks which exist.
// Whether the deployment's write Meta app is the read ads app or the Pages app (the same id): with one app a person's reading tokens can
// change campaigns once they grant the permission, so switching running ads off closes every Meta reading connection; with an app of its own
// (a public deployment requires one) they cannot, and only the recorded scopes close. No write app means no write connection to make.
export function metaWriteAppShared(config: Pick<Config, 'CHANNEL_META_ADS_WRITE_APP_ID' | 'CHANNEL_META_ADS_APP_ID' | 'CHANNEL_META_APP_ID'> & Partial<Pick<Config, 'CHANNEL_INSTAGRAM_APP_ID'>>): boolean {
  const write = config.CHANNEL_META_ADS_WRITE_APP_ID;
  return Boolean(write) && (write === config.CHANNEL_META_ADS_APP_ID || write === config.CHANNEL_META_APP_ID || write === config.CHANNEL_INSTAGRAM_APP_ID);
}

// The Meta app Instagram connects and publishes through (#2212): its own pair when set, else the Pages app's, so a deployment with one app
// is unchanged. Facebook Pages keep the Pages app either way.
export function instagramMetaApp(config: Pick<Config, 'CHANNEL_META_APP_ID' | 'CHANNEL_META_APP_SECRET'> & Partial<Pick<Config, 'CHANNEL_INSTAGRAM_APP_ID' | 'CHANNEL_INSTAGRAM_APP_SECRET'>>): { appId: string; appSecret: string } | undefined {
  if (config.CHANNEL_INSTAGRAM_APP_ID && config.CHANNEL_INSTAGRAM_APP_SECRET) return { appId: config.CHANNEL_INSTAGRAM_APP_ID, appSecret: config.CHANNEL_INSTAGRAM_APP_SECRET };
  if (config.CHANNEL_META_APP_ID && config.CHANNEL_META_APP_SECRET) return { appId: config.CHANNEL_META_APP_ID, appSecret: config.CHANNEL_META_APP_SECRET };
  return undefined;
}

// The secrets Meta may sign a Page or Instagram webhook notice or a data deletion request with: the Pages app's and, when it is another
// app, the Instagram app's. The first is the primary one; none means neither app is configured.
export function metaConversationSecrets(config: Pick<Config, 'CHANNEL_META_APP_ID' | 'CHANNEL_META_APP_SECRET'> & Partial<Pick<Config, 'CHANNEL_INSTAGRAM_APP_ID' | 'CHANNEL_INSTAGRAM_APP_SECRET'>>): { primary: string; instagram?: string } | undefined {
  const pages = config.CHANNEL_META_APP_ID && config.CHANNEL_META_APP_SECRET ? config.CHANNEL_META_APP_SECRET : undefined;
  const instagram = config.CHANNEL_INSTAGRAM_APP_ID && config.CHANNEL_INSTAGRAM_APP_SECRET ? config.CHANNEL_INSTAGRAM_APP_SECRET : undefined;
  if (pages) return instagram && instagram !== pages ? { primary: pages, instagram } : { primary: pages };
  return instagram ? { primary: instagram } : undefined;
}

// The e-invoice providers this deployment offers, by adapter id (ADR-0044 point 7): the offline sandbox when EINVOICE_SANDBOX is on, and each real adapter EINVOICE_PROVIDERS names.
// `misa` (#2503) is built but off: naming it is refused until the issues in MISA_GATES are done and written in the issue (misaBlockers), here and in loadConfig. An id this build
// does not know is left out, so a typo offers nothing.
// The real bank feed adapters this deployment offers (ADR-0039, #2045): Tingee when BANK_FEED_TINGEE is on, at its UAT host for the UAT run. The sandbox is not here (bankFeedProviders).
export function bankFeedHostedOf(config: Pick<Config, 'BANK_FEED_TINGEE' | 'BANK_FEED_TINGEE_UAT'>): Readonly<Record<string, BankFeedProvider>> {
  return bankFeedHostedProviders({ tingee: config.BANK_FEED_TINGEE === 'true', uat: config.BANK_FEED_TINGEE_UAT === 'true' });
}

export function einvoiceProvidersOf(config: Pick<Config, 'EINVOICE_SANDBOX' | 'EINVOICE_PROVIDERS'>, transport = misaTransport()): Readonly<Record<string, EInvoiceProvider>> {
  const out: Record<string, EInvoiceProvider> = {};
  if (config.EINVOICE_SANDBOX === 'true') out.sandbox = createSandboxEInvoiceProvider().provider;
  for (const raw of config.EINVOICE_PROVIDERS.split(',')) {
    if (raw.trim() !== 'misa') continue;
    const blockers = misaBlockers();
    if (blockers.length > 0) throw new Error(`EINVOICE_PROVIDERS=misa is refused until ${blockers.map((b) => `#${b.issue}`).join(' and ')} are done and written in issue #2503`);
    out.misa = createMisaEInvoiceProvider({ transport });
  }
  return out;
}

// The MISA AMIS Kế toán client (#3854, S2b): there only where the deployment holds the integrator's ClientID, over the transport the egress guard binds to developer.misa.vn. The ClientID stays in the
// client's closure (it is also the callback's HMAC key); no answer, log or audit row carries it.
export function misaAmisClientOf(config: Pick<Config, 'MISA_AMIS_CLIENT_ID'>, transport: AmisTransport = amisTransport()): AmisClient | undefined {
  return config.MISA_AMIS_CLIENT_ID ? createAmisClient({ clientId: config.MISA_AMIS_CLIENT_ID, transport }) : undefined;
}

// The MISA ASP client (#4111, S2 of #4103): the same adapter on ASP's paths, there only where the deployment holds the ClientID for that product; the same transport, so the same egress guard and host.
// It answers `unsupported` for what ASP does not have, before any token or send. The connection test, the catalogue check (#4152) and the push job (#4113) use it.
// The ClientIDs this deployment holds, one per product, for the callback route (#4113): MISA AMIS and MISA ASP post to one address, each signing with its own.
export function misaCallbackKeys(config: Pick<Config, 'MISA_AMIS_CLIENT_ID' | 'MISA_ASP_CLIENT_ID'>): AmisCallbackKey[] {
  return [...(config.MISA_AMIS_CLIENT_ID ? [{ product: 'amis' as const, clientId: config.MISA_AMIS_CLIENT_ID }] : []), ...(config.MISA_ASP_CLIENT_ID ? [{ product: 'asp' as const, clientId: config.MISA_ASP_CLIENT_ID }] : [])];
}

export function misaAspClientOf(config: Pick<Config, 'MISA_ASP_CLIENT_ID'>, transport: AmisTransport = amisTransport()): AmisClient | undefined {
  return config.MISA_ASP_CLIENT_ID ? createAmisClient({ clientId: config.MISA_ASP_CLIENT_ID, product: 'asp', transport }) : undefined;
}

// The marketplace providers this deployment offers, by adapter id (ADR-0045 point 7, #2519): the ones MARKETPLACE_PROVIDERS names. `sandbox` is the offline provider. A real adapter is
// added here with its own entry when it is built; an id this build does not know is left out, so a typo offers nothing.
export function marketplaceProvidersOf(
  config: Pick<Config, 'MARKETPLACE_PROVIDERS'> & Partial<Pick<Config, 'MARKETPLACE_INCOME_PROVIDERS'>>,
): Readonly<Record<string, MarketplaceProvider>> {
  const incomeEnabled = new Set(
    (config.MARKETPLACE_INCOME_PROVIDERS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
  const out: Record<string, MarketplaceProvider> = {};
  for (const raw of config.MARKETPLACE_PROVIDERS.split(',')) {
    const id = raw.trim();
    if (id === 'sandbox' && isMarketplaceAdapter(id)) out[id] = createSandboxMarketplaceProvider();
    // TikTok Shop (#2524, S2 = #4269): named by the deployment, never on its own. The provider and the shop-list call share one signed caller bound to the API host; the token calls go through a fetch bound to
    // the token host, inside the wrapper (the token URL carries the app secret and never leaves the token module).
    if (id === 'tiktok_shop' && isMarketplaceAdapter(id)) {
      const options = { fetch: hostBoundFetch(TIKTOK_HOSTS) };
      const caller = tiktokCaller(options);
      out[id] = withTiktokAuthorize(tiktokMarketplace(options, caller), { tokenFetch: hostBoundFetch(TIKTOK_TOKEN_HOSTS), caller });
    }
    // Lazada (#2524, S2 = #4238): named by the deployment, never on its own. Its calls are bound to the hosts the adapter names; the seller's own App Key and Secret are sealed per connection.
    // The income leg (#4302, #4306) is gated behind MARKETPLACE_INCOME_PROVIDERS until the live settlement check passes on a real Lazada shop (#2522).
    if (id === 'lazada' && isMarketplaceAdapter(id)) {
      const options = { fetch: hostBoundFetch(LAZADA_HOSTS) };
      const caller = lazadaCaller(options);
      const base = lazadaMarketplace(options, caller);
      const provider = incomeEnabled.has(id) ? withLazadaIncome(base, options, lazadaFinance(options, caller)) : base;
      out[id] = withLazadaAuthorize(provider, { tokenFetch: hostBoundFetch(LAZADA_TOKEN_HOSTS) });
    }
  }
  return out;
}

export function adPlatformsOf(
  config: Pick<Config, 'ADS_SANDBOX' | 'CHANNEL_META_ADS_APP_ID' | 'CHANNEL_META_ADS_APP_SECRET' | 'CHANNEL_META_GRAPH_VERSION'> &
    Partial<Pick<Config, 'CHANNEL_GOOGLE_ADS_CLIENT_ID' | 'CHANNEL_GOOGLE_ADS_CLIENT_SECRET'>>,
): Readonly<Record<string, AdPlatform>> {
  return adPlatforms({
    sandbox: config.ADS_SANDBOX === 'true',
    ...(config.CHANNEL_META_ADS_APP_ID && config.CHANNEL_META_ADS_APP_SECRET ? { meta: { appSecret: config.CHANNEL_META_ADS_APP_SECRET, graphVersion: config.CHANNEL_META_GRAPH_VERSION } } : {}),
    ...(config.CHANNEL_GOOGLE_ADS_CLIENT_ID && config.CHANNEL_GOOGLE_ADS_CLIENT_SECRET ? { google: { clientId: config.CHANNEL_GOOGLE_ADS_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_ADS_CLIENT_SECRET } } : {}),
  });
}

// The one call of an ad platform's writer that removes the app's permissions at the platform, by the provider id of the connection whose token is held (#2296,
// W2-1, ADR-0043 point 4): the narrowed view the revoke sweep is given, never the writer. A write token is proved with the secret of the write app and a read
// token that holds a spend permission with the secret of the read ads app, each the app that issued it.
export function adRevokersOf(config: Pick<Config, 'ADS_SANDBOX' | 'CHANNEL_META_ADS_APP_SECRET' | 'CHANNEL_META_ADS_WRITE_APP_SECRET' | 'CHANNEL_META_GRAPH_VERSION'>): Readonly<Record<string, AdRevoker>> {
  return adRevokers({
    sandbox: config.ADS_SANDBOX === 'true',
    meta: {
      ...(config.CHANNEL_META_ADS_WRITE_APP_SECRET ? { writeAppSecret: config.CHANNEL_META_ADS_WRITE_APP_SECRET } : {}),
      ...(config.CHANNEL_META_ADS_APP_SECRET ? { readAppSecret: config.CHANNEL_META_ADS_APP_SECRET } : {}),
      ...(config.CHANNEL_META_GRAPH_VERSION ? { graphVersion: config.CHANNEL_META_GRAPH_VERSION } : {}),
    },
  });
}

// The calls of a launch of an ad platform's writer, by the provider id of the write connection (#2296, W2-3, ADR-0043 points 2 to 5): the narrowed view the launch
// job is given, never the writer. The offline sandbox's when ADS_SANDBOX is on; Meta's only when the deployment has its write app AND ADS_LIVE_LAUNCH is on
// (default off, refused on a public deployment): with it off a launch on a Meta account stays queued, untouched. Every object the job creates is paused.
export function adWritersOf(config: Pick<Config, 'ADS_SANDBOX' | 'ADS_LIVE_LAUNCH' | 'CHANNEL_META_ADS_WRITE_APP_SECRET' | 'CHANNEL_META_GRAPH_VERSION'>): Readonly<Record<string, LaunchWriter>> {
  return adLaunchWriters({
    sandbox: config.ADS_SANDBOX === 'true',
    ...(config.ADS_LIVE_LAUNCH === 'true' && config.CHANNEL_META_ADS_WRITE_APP_SECRET
      ? { meta: { writeAppSecret: config.CHANNEL_META_ADS_WRITE_APP_SECRET, ...(config.CHANNEL_META_GRAPH_VERSION ? { graphVersion: config.CHANNEL_META_GRAPH_VERSION } : {}) } }
      : {}),
  });
}

// The pause of what a stopped launch made, by the provider id of the write connection (#2296, W2-4a, ADR-0043 points 4 and 7a): the narrowed view the pause job is
// given, never the writer. The same providers as the launch writers (the offline sandbox's when ADS_SANDBOX is on; Meta's only where ADS_LIVE_LAUNCH is on, since
// without it nothing was ever launched there), and it can do one thing: find the objects that carry a launch's tag and set them PAUSED.
export function adPausersOf(config: Pick<Config, 'ADS_SANDBOX' | 'ADS_LIVE_LAUNCH' | 'CHANNEL_META_ADS_WRITE_APP_SECRET' | 'CHANNEL_META_GRAPH_VERSION'>): Readonly<Record<string, AdPauser>> {
  return adPausers({
    sandbox: config.ADS_SANDBOX === 'true',
    ...(config.ADS_LIVE_LAUNCH === 'true' && config.CHANNEL_META_ADS_WRITE_APP_SECRET
      ? { meta: { writeAppSecret: config.CHANNEL_META_ADS_WRITE_APP_SECRET, ...(config.CHANNEL_META_GRAPH_VERSION ? { graphVersion: config.CHANNEL_META_GRAPH_VERSION } : {}) } }
      : {}),
  });
}

// The activators the worker is given (W2-4b), by provider: the frozen view of `activate` and `readStatus`, apart from the writers. The same providers and the same switch
// as the launch writers (the offline sandbox's when ADS_SANDBOX is on; Meta's only where ADS_LIVE_LAUNCH is on, which a public deployment refuses).
export function adActivatorsOf(config: Pick<Config, 'ADS_SANDBOX' | 'ADS_LIVE_LAUNCH' | 'CHANNEL_META_ADS_WRITE_APP_SECRET' | 'CHANNEL_META_GRAPH_VERSION'>): Readonly<Record<string, AdActivator>> {
  return adActivators({
    sandbox: config.ADS_SANDBOX === 'true',
    ...(config.ADS_LIVE_LAUNCH === 'true' && config.CHANNEL_META_ADS_WRITE_APP_SECRET
      ? { meta: { writeAppSecret: config.CHANNEL_META_ADS_WRITE_APP_SECRET, ...(config.CHANNEL_META_GRAPH_VERSION ? { graphVersion: config.CHANNEL_META_GRAPH_VERSION } : {}) } }
      : {}),
  });
}

// The managers the worker is given (#3835, W4), by provider: the frozen view that changes a live launch's objects (a status, the ad set's budget and end time) and reads them back,
// apart from the writers, the pausers and the activators. The same providers and the same switch as the launch writers (the offline sandbox's when ADS_SANDBOX is on; Meta's only
// where ADS_LIVE_LAUNCH is on, which a public deployment refuses).
export function adManagersOf(config: Pick<Config, 'ADS_SANDBOX' | 'ADS_LIVE_LAUNCH' | 'CHANNEL_META_ADS_WRITE_APP_SECRET' | 'CHANNEL_META_GRAPH_VERSION'>): Readonly<Record<string, AdManager>> {
  return adManagers({
    sandbox: config.ADS_SANDBOX === 'true',
    ...(config.ADS_LIVE_LAUNCH === 'true' && config.CHANNEL_META_ADS_WRITE_APP_SECRET
      ? { meta: { writeAppSecret: config.CHANNEL_META_ADS_WRITE_APP_SECRET, ...(config.CHANNEL_META_GRAPH_VERSION ? { graphVersion: config.CHANNEL_META_GRAPH_VERSION } : {}) } }
      : {}),
  });
}

// The state readers the worker is given (#3301), by provider: the frozen view of `readStates` and nothing else, apart from the writers, built with the same providers and the same
// switch as them (the offline sandbox's when ADS_SANDBOX is on; Meta's only where ADS_LIVE_LAUNCH is on, since without it nothing was ever launched there).
export function adStateReadersOf(config: Pick<Config, 'ADS_SANDBOX' | 'ADS_LIVE_LAUNCH' | 'CHANNEL_META_ADS_WRITE_APP_SECRET' | 'CHANNEL_META_GRAPH_VERSION'>): Readonly<Record<string, AdStateReader>> {
  return adStateReaders({
    sandbox: config.ADS_SANDBOX === 'true',
    ...(config.ADS_LIVE_LAUNCH === 'true' && config.CHANNEL_META_ADS_WRITE_APP_SECRET
      ? { meta: { writeAppSecret: config.CHANNEL_META_ADS_WRITE_APP_SECRET, ...(config.CHANNEL_META_GRAPH_VERSION ? { graphVersion: config.CHANNEL_META_GRAPH_VERSION } : {}) } }
      : {}),
  });
}

export function channelConnectors(config: Omit<ChannelConfig, 'CHANNEL_SANDBOX'>): Partial<Record<string, OAuthConnector>> {
  const connectors: Partial<Record<string, OAuthConnector>> = {};
  if (config.CHANNEL_META_APP_ID && config.CHANNEL_META_APP_SECRET) {
    const app = { appId: config.CHANNEL_META_APP_ID, appSecret: config.CHANNEL_META_APP_SECRET, graphVersion: config.CHANNEL_META_GRAPH_VERSION };
    connectors.facebook_page = new FacebookPageConnector(app);
  }
  // Instagram professional accounts linked to the user's Pages (S6.3): through the Pages app, or the Instagram app of its own when set (#2212).
  const instagram = instagramMetaApp(config);
  if (instagram) connectors.instagram = new InstagramConnector({ ...instagram, graphVersion: config.CHANNEL_META_GRAPH_VERSION });
  // Meta ad accounts, read only (ADR-0040, #2218): its own app credentials, which may be the same app as the Pages one.
  if (config.CHANNEL_META_ADS_APP_ID && config.CHANNEL_META_ADS_APP_SECRET) {
    connectors.meta_ads = new MetaAdsConnector({ appId: config.CHANNEL_META_ADS_APP_ID, appSecret: config.CHANNEL_META_ADS_APP_SECRET, graphVersion: config.CHANNEL_META_GRAPH_VERSION });
  }
  // Google Ads accounts, read only (ADR-0040, #2220): OAuth web client in the deployment's Google Cloud project.
  if (config.CHANNEL_GOOGLE_ADS_CLIENT_ID && config.CHANNEL_GOOGLE_ADS_CLIENT_SECRET) {
    connectors.google_ads = new GoogleAdsConnector({ clientId: config.CHANNEL_GOOGLE_ADS_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_ADS_CLIENT_SECRET });
  }
  // Meta ad accounts, the connection that can run ads (ADR-0043, #2294, W0b): its own app credentials, which may be the same app as the
  // read one or the Pages one. It only logs in and lists accounts; no job or queue reaches it, and the readers' registry
  // (adPlatformsOf) never sees its provider.
  if (config.CHANNEL_META_ADS_WRITE_APP_ID && config.CHANNEL_META_ADS_WRITE_APP_SECRET) {
    connectors.metawrite_ads = new MetaWriteConnector({ appId: config.CHANNEL_META_ADS_WRITE_APP_ID, appSecret: config.CHANNEL_META_ADS_WRITE_APP_SECRET, graphVersion: config.CHANNEL_META_GRAPH_VERSION });
  }
  const zalo = zaloApp(config);
  if (zalo) connectors.zalo_oa = new ZaloOaConnector(zalo);
  if (config.CHANNEL_THREADS_APP_ID && config.CHANNEL_THREADS_APP_SECRET) connectors.threads = new ThreadsConnector({ appId: config.CHANNEL_THREADS_APP_ID, appSecret: config.CHANNEL_THREADS_APP_SECRET });
  if (config.CHANNEL_LINKEDIN_CLIENT_ID && config.CHANNEL_LINKEDIN_CLIENT_SECRET) connectors.linkedin = new LinkedInConnector({ clientId: config.CHANNEL_LINKEDIN_CLIENT_ID, clientSecret: config.CHANNEL_LINKEDIN_CLIENT_SECRET, analytics: config.CHANNEL_LINKEDIN_ANALYTICS === 'true' });
  const linkedinPages = linkedinPagesApp(config);
  if (linkedinPages) connectors.linkedin_page = new LinkedInPageConnector(linkedinPages);
  if (config.CHANNEL_TIKTOK_CLIENT_KEY && config.CHANNEL_TIKTOK_CLIENT_SECRET) connectors.tiktok = new TikTokConnector({ clientKey: config.CHANNEL_TIKTOK_CLIENT_KEY, clientSecret: config.CHANNEL_TIKTOK_CLIENT_SECRET, videoList: config.CHANNEL_TIKTOK_VIDEO_LIST === 'true', inbox: config.CHANNEL_TIKTOK_INBOX === 'true' });
  if (config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) connectors.youtube = new YouTubeConnector({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  if (config.CHANNEL_GOOGLE_BUSINESS === 'true' && config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) connectors.google_business = new GoogleBusinessConnector({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  const x = xApp(config);
  if (x) connectors.x = new XConnector(x);
  const pinterest = pinterestApp(config);
  if (pinterest) connectors.pinterest = new PinterestConnector(pinterest);
  return connectors;
}

// The providers the worker publishes to: the sandbox when it is on, and each platform with app credentials.
export function channelPublishers(config: ChannelConfig): Record<string, Publisher> {
  const publishers: Record<string, Publisher> = {};
  if (config.CHANNEL_SANDBOX === 'true') publishers.sandbox = new SandboxPublisher();
  // An account on its own PDS (#792) is called through the egress guard; images go up to 1 MB each.
  if (config.CHANNEL_BLUESKY === 'true') publishers.bluesky = new BlueskyPublisher(undefined, egressFetch({ timeoutMs: 30_000, maxBytes: 2_000_000, overLimit: 'fail' }));
  if (config.CHANNEL_TELEGRAM === 'true') publishers.telegram = new TelegramPublisher(undefined, new TelegramConversations());
  if (config.CHANNEL_DISCORD === 'true') publishers.discord = new DiscordPublisher();
  // An instance is the tenant's to name: its calls go through the egress guard, never a plain fetch.
  if (config.CHANNEL_MASTODON === 'true') publishers.mastodon = new MastodonPublisher(egressFetch({ timeoutMs: 300_000, maxBytes: 2_000_000, overLimit: 'fail' }));
  // A WordPress site is the tenant's to name too (#833); each call, an image upload among them, gets two minutes. A page
  // of the composer's list of its categories and tags (#1131) gets CHANNEL_OPTIONS_CALL_TIMEOUT_MS, so a slow site cannot
  // hold the option queue every org shares.
  if (config.CHANNEL_WORDPRESS === 'true') {
    publishers.wordpress = new WordPressPublisher(egressFetch({ timeoutMs: 120_000, maxBytes: 2_000_000, overLimit: 'fail' }), egressFetch({ timeoutMs: CHANNEL_OPTIONS_CALL_TIMEOUT_MS, maxBytes: 2_000_000, overLimit: 'fail' }));
  }
  if (config.CHANNEL_META_APP_ID && config.CHANNEL_META_APP_SECRET) {
    publishers.facebook_page = new FacebookPagePublisher({ appSecret: config.CHANNEL_META_APP_SECRET, graphVersion: config.CHANNEL_META_GRAPH_VERSION });
  }
  // Calls on an Instagram token are signed with the secret of the app that issued it (appsecret_proof).
  const instagramApp = instagramMetaApp(config);
  if (instagramApp) publishers.instagram = new InstagramPublisher({ appSecret: instagramApp.appSecret, graphVersion: config.CHANNEL_META_GRAPH_VERSION });
  const zalo = zaloApp(config);
  if (zalo) publishers.zalo_oa = new ZaloOaPublisher({ ...zalo, ...(config.BRAND_NAME ? { defaultAuthor: config.BRAND_NAME } : {}) });
  if (config.CHANNEL_THREADS_APP_ID && config.CHANNEL_THREADS_APP_SECRET) publishers.threads = new ThreadsPublisher();
  if (config.CHANNEL_LINKEDIN_CLIENT_ID && config.CHANNEL_LINKEDIN_CLIENT_SECRET) publishers.linkedin = new LinkedInPublisher({ analytics: config.CHANNEL_LINKEDIN_ANALYTICS === 'true' });
  if (linkedinPagesApp(config)) publishers.linkedin_page = new LinkedInPagePublisher();
  if (config.CHANNEL_TIKTOK_CLIENT_KEY && config.CHANNEL_TIKTOK_CLIENT_SECRET) publishers.tiktok = new TikTokPublisher({ clientKey: config.CHANNEL_TIKTOK_CLIENT_KEY, clientSecret: config.CHANNEL_TIKTOK_CLIENT_SECRET, videoList: config.CHANNEL_TIKTOK_VIDEO_LIST === 'true', inbox: config.CHANNEL_TIKTOK_INBOX === 'true' });
  if (config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) publishers.youtube = new YouTubePublisher({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  if (config.CHANNEL_GOOGLE_BUSINESS === 'true' && config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) publishers.google_business = new GoogleBusinessPublisher({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  const x = xApp(config);
  if (x) publishers.x = new XPublisher(x, undefined, {}, { metrics: config.CHANNEL_X_METRICS === 'true' });
  const pinterest = pinterestApp(config);
  if (pinterest) publishers.pinterest = new PinterestPublisher(pinterest);
  return publishers;
}

// Providers whose tokens the worker renews ahead of expiry (S6.4).
export function channelRefreshers(config: ChannelConfig): Record<string, Refresher> {
  const zalo = zaloApp(config);
  const refreshers: Record<string, Refresher> = {};
  if (zalo) refreshers.zalo_oa = new ZaloOaRefresher(zalo);
  if (config.CHANNEL_THREADS_APP_ID && config.CHANNEL_THREADS_APP_SECRET) refreshers.threads = new ThreadsRefresher();
  if (config.CHANNEL_TIKTOK_CLIENT_KEY && config.CHANNEL_TIKTOK_CLIENT_SECRET) refreshers.tiktok = new TikTokRefresher({ clientKey: config.CHANNEL_TIKTOK_CLIENT_KEY, clientSecret: config.CHANNEL_TIKTOK_CLIENT_SECRET });
  if (config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) refreshers.youtube = new YouTubeRefresher({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  if (config.CHANNEL_GOOGLE_BUSINESS === 'true' && config.CHANNEL_GOOGLE_CLIENT_ID && config.CHANNEL_GOOGLE_CLIENT_SECRET) refreshers.google_business = new GoogleBusinessRefresher({ clientId: config.CHANNEL_GOOGLE_CLIENT_ID, clientSecret: config.CHANNEL_GOOGLE_CLIENT_SECRET });
  const x = xApp(config);
  if (x) refreshers.x = new XRefresher(x);
  const pinterest = pinterestApp(config);
  if (pinterest) refreshers.pinterest = new PinterestRefresher(pinterest);
  // A Lazada connection's tokens (#2524, S3a): the refresher acts only on `marketplace_lazada` connections, which exist only where MARKETPLACE_PROVIDERS names the adapter. It holds no app
  // credential of its own (the seller's App Key and Secret are in each connection's sealed secret) and reaches only the one host its fetch is bound to.
  if (config.MARKETPLACE_PROVIDERS.split(',').some((id) => id.trim() === 'lazada')) refreshers.marketplace_lazada = new LazadaRefresher({ fetch: hostBoundFetch(LAZADA_TOKEN_HOSTS) });
  // A TikTok Shop connection's tokens (#2524, T1 = #4256): the same, for `marketplace_tiktok_shop`. The seller's own app key and secret are in each connection's sealed secret; the fetch reaches only
  // the token host, and the token URL (which carries the app secret) never leaves the token module.
  if (config.MARKETPLACE_PROVIDERS.split(',').some((id) => id.trim() === 'tiktok_shop')) refreshers.marketplace_tiktok_shop = new TiktokRefresher({ fetch: hostBoundFetch(TIKTOK_TOKEN_HOSTS) });
  // A Shopee connection's tokens (#2524, S1 = #4274): the same, for `marketplace_shopee`. The partner id and key are in each connection's sealed secret; the fetch reaches only the one API host, and the refresh
  // token rotates and works once, so the sweep's `ifVersion` re-seal is what keeps the pair.
  if (config.MARKETPLACE_PROVIDERS.split(',').some((id) => id.trim() === 'shopee')) refreshers.marketplace_shopee = new ShopeeRefresher({ fetch: hostBoundFetch(SHOPEE_TOKEN_HOSTS) });
  return refreshers;
}

export function createKernel(config: Config, adapters: KernelAdapters): Kernel {
  // Typed callers cannot omit a port, but an entrypoint assembled at runtime can: fail at boot, not on first use.
  // ai may be null (explicitly no AI), never undefined.
  const given = adapters as Partial<KernelAdapters>;
  const missing: string[] = REQUIRED.filter((port) => given[port] === undefined);
  // A Runtime without a session source skips the ADR-0028 check, so the identity port must carry all three parts.
  const identity = given.identity as Partial<IdentityPort> | undefined;
  if (identity) {
    if (typeof identity.sessions?.check !== 'function') missing.push('identity.sessions');
    if (typeof identity.authenticator !== 'function') missing.push('identity.authenticator');
    if (identity.revoker === undefined) missing.push('identity.revoker');
  }
  if (missing.length > 0) throw new Error(`createKernel: missing adapter(s) ${missing.join(', ')}`);
  const resolved: ResolvedAdapters = {
    identity: adapters.identity,
    ai: adapters.ai,
    writer: adapters.writer ?? null,
    scheduler: adapters.scheduler ?? null,
    conversationWriter: adapters.conversationWriter ?? null,
    today: adapters.today ?? null,
    weekly: adapters.weekly ?? null,
    adsCampaignWriter: adapters.adsCampaignWriter ?? null,
    inboxReader: adapters.inboxReader ?? null,
    summaryModel: adapters.summaryModel ?? null,
    signAi: adapters.signAi ?? null,
    storage: adapters.storage,
    mail: adapters.mail ?? createLogProvider(),
    broker: adapters.broker ?? noCredentialBroker,
    connectors: adapters.connectors ?? [],
    billing: adapters.billing ?? selfHostBilling,
    nativePush: adapters.nativePush ?? null,
  };

  function buildRuntime(connectionString: string, applicationName: string, max: number, mcpEntry?: 'worker') {
    const pool = createPool({ connectionString, applicationName, max, resetOnRelease: config.DB_RESET_ON_RELEASE === 'true', discardTemp: config.LUDY_SHARED_DATABASE === 'true' });
    const db = createDb(pool);
    // One database is the control plane and the only cell (Decision 14, plan §3.6).
    const runtime = serverRuntime(singleCell(db), config, {
      // The org's entitlements, for kernel.org.apps (ADR-0053).
      billing: resolved.billing,
      // Approval audit rows name the build their policy ran under (plan §4.7, #1402).
      build: config.LUDY_BUILD ?? 'dev',
      // Audit and idempotency rows hash a command's input under the deployment's key (#1732), so an exported or
      // archived row never confirms a guessed input.
      inputHash: 'keyed',
      // User contexts entered with a token signed by the deployment's key (#1822), once one is configured.
      contextTokenKey: config.LUDY_CONTEXT_TOKEN_KEY ?? null,
      // Every user request is checked against its session (ADR-0028); the identity port never resolves to "no check".
      sessions: resolved.identity.sessions,
      stepUp: config.AUTH_STEP_UP,
      // The worker's own runtime enters a company grant's context through the worker's entry (signal wake-ups, S5); every other runtime uses the API's.
      ...(mcpEntry ? { mcpEntry } : {}),
      refusalAudit: {
        perActor: config.REFUSAL_AUDIT_LIMIT_PER_ACTOR,
        perOrg: config.REFUSAL_AUDIT_LIMIT_PER_ORG,
        reserve: config.REFUSAL_AUDIT_RESERVE_PER_ACTOR,
        windowSeconds: config.REFUSAL_AUDIT_WINDOW_SECONDS,
      },
    });
    return { pool, db, runtime };
  }

  async function start(role: ServerRole): Promise<() => Promise<void>> {
    const api = role === 'api' || role === 'all';
    const worker = role === 'worker' || role === 'all';
    // Both roles handle org exports (the worker seals them, the API opens them for download).
    assertExportKey(config);
    assertSplitRoles(config, role);
    // Browser push (#1238): both roles or neither; a partial or mismatched key set stops the start.
    const vapid = loadVapidKeys(config);
    // The alert webhook of this process: the worker's security alerts, and the operational ALERT lines of both roles
    // (#1993), once a window per kind.
    const alerts = securityAlerts(config);
    configureOpsAlerts({ target: alerts.target, repeatSeconds: alerts.thresholds.repeatSeconds });
    // The worker alone enters system context, so it never shares the API's login role (External-tenant gate T5).
    const workerUrl = config.WORKER_DATABASE_URL;
    if (worker && !workerUrl) throw new Error('WORKER_DATABASE_URL is required for the worker; connect it as ludy_worker');
    // Files and emails are parsed only in the sandbox (External-tenant gate T12); the worker always passes this client.
    const extractUrl = config.EXTRACT_URL;
    if (worker && !extractUrl) throw new Error('EXTRACT_URL is required for the worker; point it at the crove-extract service');

    const store = resolved.storage;
    if (store instanceof LocalDiskStore) {
      // Temporary files a crashed write left behind; a fresh one may belong to a write in another process.
      const removed = await store.sweepTempFiles();
      if (removed > 0) console.log(`[storage] removed ${removed} stale temporary file(s)`);
    }
    const stops: Array<() => Promise<void>> = [];
    // Run last (stops run in reverse): the alerts the other stops raised are posted before the process ends, within 5 s
    // in all, so the container's stop grace period holds.
    stops.push(async () => {
      await flushOpsAlerts(STOP_FLUSH_MS);
      configureOpsAlerts(null);
    });
    // Safe to call twice (SIGTERM then SIGINT): the second call finds nothing left to stop.
    const stopAll = async () => {
      const pending = stops.splice(0).reverse();
      for (const stop of pending) await stop().catch((e) => console.error(e));
    };

    try {
      if (api) {
        const { pool, db, runtime } = buildRuntime(config.DATABASE_URL, 'crove-api', config.DATABASE_POOL_MAX);
        stops.push(() => pool.end());
        await assertRlsEnforced(pool);
        await assertSystemContextAccess(pool, 'denied');
        if (config.LUDY_CONTEXT_TOKEN_KEY) await assertContextTokenKey(pool, config.LUDY_CONTEXT_TOKEN_KEY);
        const authenticate = resolved.identity.authenticator(db);
        // Realtime invalidation (issue #69): one LISTEN connection per process; STREAM_MAX_CONNECTIONS=0 turns it off.
        let stream: StreamDeps | undefined;
        if (config.STREAM_MAX_CONNECTIONS > 0) {
          const listenUrl = config.DATABASE_LISTEN_URL ?? config.DATABASE_URL;
          const hub = new StreamHub(createPgNotificationSource({ connectionString: listenUrl }));
          stream = {
            hub,
            tickets: createDbTicketStore(pool),
            slots: new ConcurrencyLimiter({ total: config.STREAM_MAX_CONNECTIONS, perKey: config.STREAM_MAX_PER_USER }),
            recheckSeconds: config.STREAM_RECHECK_SECONDS,
            rechecks: new Semaphore(config.STREAM_RECHECK_CONCURRENCY),
          };
        }
        // The tax portal sync seals the portal's session for the browser; without the credential key it cannot run.
        if (config.TAX_PORTAL_SYNC === 'true' && resolved.broker.id === 'none') throw new Error('TAX_PORTAL_SYNC=true needs the credential key (CREDENTIAL_KEY or CREDENTIAL_KEY_FILE)');
        if (config.TAX_PORTAL_SYNC === 'true' && config.TAX_PORTAL_URL && !testPortalAllowed(config.TAX_PORTAL_URL, config.PUBLIC_URL)) {
          throw new Error('TAX_PORTAL_URL points the tax portal sync away from https://hoadondientu.gdt.gov.vn: allowed only for a test deployment on localhost or a .test name');
        }
        if (config.TAX_PORTAL_SYNC === 'true' && config.TAX_PORTAL_URL) console.warn(`[api] TAX_PORTAL_URL points the tax portal sync at ${new URL(config.TAX_PORTAL_URL).origin}, not the real portal`);
        const conversationSecrets = metaConversationSecrets(config);
        const threadsWebhookSecret = config.CHANNEL_THREADS_APP_ID && config.CHANNEL_THREADS_APP_SECRET ? config.CHANNEL_THREADS_APP_SECRET : undefined;
        // The MCP endpoint's authorization server (ADR-0051 decision 2, #2975), only when the deployment turned it on (OAUTH_SERVER=on, keys and cookie secrets checked at load).
        const oauth = config.OAUTH_SERVER === 'on' ? await createOauthServer(config, (fn) => runtime.orgless(fn)) : null;
        const app = createHttpApp({
          config,
          ...(oauth ? { oauth } : {}),
          runtime,
          store,
          authenticate,
          pool,
          billing: resolved.billing,
          // The meetings media route seals and opens with the same broker as the worker's reseal pass. The 'none' broker
          // is left out so the route keeps its own fallback (createCredentialBroker(config)).
          ...(resolved.broker.id !== 'none' ? { broker: resolved.broker } : {}),
          aiEnabled: resolved.ai !== null,
          aiMeter: (actor) => memberMeter(runtime, actor, { price: { inputPerMTok: config.AI_PRICE_INPUT_PER_MTOK, outputPerMTok: config.AI_PRICE_OUTPUT_PER_MTOK } }),
          ...(resolved.writer ? { socialWriter: { ...socialDrafter(resolved.writer, config.AI_VISION === 'true' ? store : null), ...(resolved.today ? { brief: resolved.today.brief.bind(resolved.today) } : {}), ...(resolved.weekly ? { weekly: resolved.weekly.weekly.bind(resolved.weekly) } : {}) } } : {}),
          ...(resolved.scheduler ? { bookingReader: resolved.scheduler } : {}),
          ...(resolved.inboxReader ? { conversationReader: resolved.inboxReader } : {}),
          ...(resolved.summaryModel ? { summaryModel: resolved.summaryModel } : {}),
          ...(resolved.signAi ? { signAi: resolved.signAi } : {}),
          aiPrice: { inputPerMTok: config.AI_PRICE_INPUT_PER_MTOK, outputPerMTok: config.AI_PRICE_OUTPUT_PER_MTOK },
          ...(config.TAX_CODE_LOOKUP_URL ? { taxLookup: createTaxCodeLookup(config.TAX_CODE_LOOKUP_URL) } : {}),
          ...(config.TAX_PORTAL_SYNC === 'true' ? { portalSync: createPortalSync({ runtime, store, broker: resolved.broker, stepMs: config.TAX_PORTAL_STEP_SECONDS * 1000, client: createTaxPortalClient(config.TAX_PORTAL_URL ? { baseUrl: config.TAX_PORTAL_URL } : {}) }) } : {}),
          mailer: resolved.mail,
          // Meta's data deletion callback for the Ads connection (plan section 9): with the Meta ads app configured.
          ...(config.CHANNEL_META_ADS_APP_ID && config.CHANNEL_META_ADS_APP_SECRET ? { adsDeletion: { appSecret: config.CHANNEL_META_ADS_APP_SECRET } } : {}),
          ...(config.CHANNEL_META_ADS_WRITE_APP_ID && config.CHANNEL_META_ADS_WRITE_APP_SECRET ? { adsWriteDeletion: { appSecret: config.CHANNEL_META_ADS_WRITE_APP_SECRET } } : {}),
          ...(conversationSecrets ? { conversationsDeletion: { appSecret: conversationSecrets.primary, ...(conversationSecrets.instagram ? { instagramAppSecret: conversationSecrets.instagram } : {}) } } : {}),
          // Zoom's webhook of finished cloud recordings (Meetings C3, #3175): with the Zoom app's secret token.
          ...(config.ZOOM_WEBHOOK_SECRET_TOKEN ? { zoomWebhook: { secretToken: config.ZOOM_WEBHOOK_SECRET_TOKEN, secretTokenPrevious: config.ZOOM_WEBHOOK_SECRET_TOKEN_PREVIOUS } } : {}),
          // Zalo OA's webhook for customers' messages (conversation core, #2304): with the Zalo app and its OA secret key configured.
          ...(config.CHANNEL_ZALO_APP_ID && config.CHANNEL_ZALO_OA_SECRET_KEY ? { zaloWebhook: { appId: config.CHANNEL_ZALO_APP_ID, oaSecretKey: config.CHANNEL_ZALO_OA_SECRET_KEY, oaSecretKeyPrevious: config.CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS } } : {}),
          // Meta Page webhook for Page comments (conversation core CV2, #2307): with the Meta app and its webhook verify token configured.
          // Telegram bot chats (#3132): the route exists where Telegram is on and the credential key can derive the webhook secret.
          ...(config.CHANNEL_TELEGRAM === 'true' && resolved.broker.deriveKeys ? { telegramWebhook: { keys: () => (resolved.broker.deriveKeys?.(TELEGRAM_HOOK_KEY_INFO) ?? []).map((k) => k.key) } } : {}),
          // The same route takes the Threads app's reply notices (#3133), signed with the Threads app's secret: a deployment with only the Threads app has an empty
          // Pages secret, which verifies nothing.
          ...((conversationSecrets || threadsWebhookSecret) && config.CHANNEL_META_WEBHOOK_VERIFY_TOKEN ? { facebookWebhook: { appSecret: conversationSecrets?.primary ?? '', ...(conversationSecrets?.instagram ? { instagramAppSecret: conversationSecrets.instagram } : {}), ...(threadsWebhookSecret ? { threadsAppSecret: threadsWebhookSecret } : {}), appSecretPrevious: config.CHANNEL_META_APP_SECRET_PREVIOUS, verifyToken: config.CHANNEL_META_WEBHOOK_VERIFY_TOKEN } } : {}),
          // WhatsApp Business webhook for customers' messages (conversation core, #3131): with the WhatsApp app secret and its verify token configured.
          ...(config.CHANNEL_WHATSAPP_APP_SECRET && config.CHANNEL_WHATSAPP_VERIFY_TOKEN ? { whatsappWebhook: { appSecret: config.CHANNEL_WHATSAPP_APP_SECRET, appSecretPrevious: config.CHANNEL_WHATSAPP_APP_SECRET_PREVIOUS, verifyToken: config.CHANNEL_WHATSAPP_VERIFY_TOKEN } } : {}),
          // MISA AMIS's callback (#3903): the route exists only where the ClientID, the HMAC key of its signature, is set.
          // The one address takes MISA ASP's results too (#4113), signed with ASP's own ClientID: each product's key that the deployment holds is tried, and the product of the key that verified the message goes with the result.
          ...(config.MISA_AMIS_CLIENT_ID || config.MISA_ASP_CLIENT_ID ? { misaAmisCallback: { keys: misaCallbackKeys(config) } } : {}),
          // The bank feed adapters that take signed notices (ADR-0039): the route exists only for these.
          bankFeedWebhooks: Object.fromEntries(
            Object.entries(bankFeedProviders({ sandbox: config.BANK_FEED_SANDBOX === 'true', sandboxWebhookSecret: config.BANK_FEED_SANDBOX_WEBHOOK_SECRET })).filter(([, p]) => p.verifyWebhook),
          ),
          // The adapters whose notices are signed with each customer's own secret (Tingee, #4203): the hook route exists only for these.
          // Only with a credential broker, as the worker's drain and nightly sweep of the stored notices need one (#4203): without it the route is not registered and no raw notice can be stored.
          bankFeedHooks: resolved.broker.id !== 'none' ? Object.fromEntries(Object.entries(bankFeedHostedOf(config)).filter(([, p]) => p.verifyHook && p.hookTimestampFresh)) : {},
          // The marketplaces whose signed push the API stores for the worker (#4346, S2 of #4315): only the adapters this deployment runs (MARKETPLACE_PROVIDERS), and only with a credential broker, as the worker's relay needs one
          // to open the connection's secret: without it the route is not registered and no raw push can be stored.
          ...(resolved.broker.id !== 'none' ? { marketplacePush: { adapters: Object.keys(marketplaceProvidersOf(config)).filter(isMarketplacePushAdapter) } } : {}),
          ...(config.GITHUB_APP_WEBHOOK_SECRET ? { githubWebhook: { appWebhookSecret: config.GITHUB_APP_WEBHOOK_SECRET, appWebhookSecretPrevious: config.GITHUB_APP_WEBHOOK_SECRET_PREVIOUS } } : {}),
          channels: { broker: resolved.broker, sandbox: config.CHANNEL_SANDBOX === 'true', bankFeedSandbox: config.BANK_FEED_SANDBOX === 'true', bankFeedHosted: bankFeedHostedOf(config), einvoiceProviders: einvoiceProvidersOf(config), marketplaceProviders: marketplaceProvidersOf(config), misaAmis: Boolean(config.MISA_AMIS_CLIENT_ID), misaAsp: Boolean(config.MISA_ASP_CLIENT_ID), misaAmisPush: Boolean(config.MISA_AMIS_CLIENT_ID) && config.MISA_AMIS_PUSH === 'on', misaAspPush: Boolean(config.MISA_ASP_CLIENT_ID) && config.MISA_ASP_PUSH === 'on', emailSenderCheck: Boolean(config.INBOUND_AUTHSERV_ID), adsLaunchProviders: Object.keys(adWritersOf(config)), adsPlatforms: adPlatformsOf(config), adsWriteAppShared: metaWriteAppShared(config), bluesky: config.CHANNEL_BLUESKY === 'true', telegram: config.CHANNEL_TELEGRAM === 'true', mastodon: config.CHANNEL_MASTODON === 'true', discord: config.CHANNEL_DISCORD === 'true', wordpress: config.CHANNEL_WORDPRESS === 'true', ...(whatsappApp(config) && config.CHANNEL_WHATSAPP_VERIFY_TOKEN ? { whatsapp: whatsappApp(config) } : {}), connectors: channelConnectors(config), calendars: calendarAdapters(config), meetingPlatforms: meetingPlatformsOf(config), github: createGithubClient({ transport: githubTransport(), ...(config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY ? { app: { appId: config.GITHUB_APP_ID, privateKeyPem: config.GITHUB_APP_PRIVATE_KEY } } : {}), ...(config.GITHUB_APP_CLIENT_ID && config.GITHUB_APP_CLIENT_SECRET ? { appOAuth: { clientId: config.GITHUB_APP_CLIENT_ID, clientSecret: config.GITHUB_APP_CLIENT_SECRET } } : {}) }), publicUrl: appUrl(config), apiUrl: config.PUBLIC_URL, ...(config.MEDIA_PEXELS_API_KEY ? { stockPhotos: createPexels({ apiKey: config.MEDIA_PEXELS_API_KEY, store }) } : {}), mediaUrls: createMediaUrls({ store }), ...(vapid ? { push: { publicKey: vapid.publicKey } } : {}), ...(resolved.nativePush ? { nativePush: true } : {}) },
          ...(stream ? { stream } : {}),
          // An API process of its own waits in /readyz for its workers' build (#1952); the single "all" process is its
          // own worker, so it has none to wait for.
          workerBuildCheck: role === 'api',
        });
        const server = serve({ fetch: app.fetch, port: config.PORT, hostname: config.HOST });
        // A 2 GB meeting upload needs more than Node's default 300 s to arrive (#2780); every request body is guarded against a stall.
        configureUploadTimeouts(server as unknown as Server, { requestTimeoutSeconds: config.MEDIA_UPLOAD_REQUEST_TIMEOUT_S });
        console.log(`[api] listening on ${config.HOST}:${config.PORT}`);
        stops.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
        // Stopped before the server (stops run in reverse): open streams would keep server.close() waiting.
        const hub = stream?.hub;
        if (hub) {
          stops.push(() => hub.stop());
          hub.start();
        }
      }

      if (worker && workerUrl && extractUrl) {
        console.log(`[extract] parsing in crove-extract at ${new URL(extractUrl).host}`);
        // The instance the heartbeat names is in every system audit row this worker writes (#1951), cut to what fits in
        // the connections' application_name, so both name it alike.
        const instance = hostname().slice(0, 50);
        const { pool, db, runtime } = buildRuntime(workerUrl, workerApplicationName(instance), config.WORKER_DATABASE_POOL_MAX, 'worker');
        stops.push(() => pool.end());
        await assertRlsEnforced(pool);
        await assertSystemContextAccess(pool, 'granted');
        // The WORM archive (#891): an S3 archive without Object Lock stops the worker before it writes anything.
        const archiveStore = createArchiveStore(config);
        await archiveStore.assertObjectLock?.();
        console.log(`[archive] ${archiveStore.describe()}`);
        stops.push(
          await startWorker({
            connectionString: workerUrl,
            workerDb: db,
            runtime,
            instance,
            store,
            extractor: resolved.ai,
            conversationWriter: resolved.conversationWriter,
            adsCampaignWriter: resolved.adsCampaignWriter,
            meetingsBriefWriter: resolved.summaryModel ? createMeetingsBriefWriter(resolved.summaryModel) : null,
            extract: createExtractClient({ url: extractUrl, concurrency: extractConcurrency(config) }),
            inboundDomain: config.INBOUND_DOMAIN ?? null,
            revoker: resolved.identity.revoker,
            refusalTallyRetentionDays: config.REFUSAL_TALLY_RETENTION_DAYS,
            build: { id: config.LUDY_BUILD ?? null, time: config.LUDY_BUILD_TIME ?? null },
            agentPrograms: { ...financeAgentPrograms, ...socialAgentPrograms, ...crmAgentPrograms },
            exportSealer: exportSealer(config),
            exportRetentionDays: config.EXPORT_RETENTION_DAYS,
            evidenceLockDays: config.EVIDENCE_LOCK_DAYS,
            // The audio of a video-only platform recording (C2a, #3306): crove-media extracts it; without MEDIA_URL the extractor is not configured and such a recording fails `no_audio`.
            meetingsImportExtractor: mediaAudioExtractorFor(config.MEDIA_URL, config.MEDIA_CALL_TIMEOUT_MS),
            ...(config.MEDIA_MAX_INPUT_BYTES ? { meetingsImportMediaInputBytes: config.MEDIA_MAX_INPUT_BYTES } : {}),
            channels: { broker: resolved.broker, einvoiceProviders: einvoiceProvidersOf(config), marketplaceProviders: marketplaceProvidersOf(config), ...(config.MISA_AMIS_CLIENT_ID ? { misaAmis: misaAmisClientOf(config) as AmisClient, ...(config.MISA_AMIS_PUSH === 'on' ? { misaAmisPush: true } : {}) } : {}), ...(config.MISA_ASP_CLIENT_ID ? { misaAsp: misaAspClientOf(config) as AmisClient, ...(config.MISA_ASP_PUSH === 'on' ? { misaAspPush: true } : {}) } : {}), conversationHistory: config.CHANNEL_ZALO_HISTORY === 'true', facebookHistory: config.CHANNEL_FACEBOOK_HISTORY === 'true', threadsHistory: config.CHANNEL_THREADS_HISTORY === 'true', youtubeHistory: config.CHANNEL_YOUTUBE_HISTORY === 'true', conversationMediaHosts: zaloMediaHostsOf(config.CHANNEL_ZALO_MEDIA_HOSTS), conversationMediaHostsBy: { whatsapp: zaloMediaHostsOf(config.CHANNEL_WHATSAPP_MEDIA_HOSTS) }, conversationAdapters: channelConversationAdapters(config), publishers: channelPublishers(config), refreshers: channelRefreshers(config), calendars: calendarAdapters(config), meetingPlatforms: meetingPlatformsOf(config), github: createGithubClient({ transport: githubTransport(), ...(config.GITHUB_APP_ID && config.GITHUB_APP_PRIVATE_KEY ? { app: { appId: config.GITHUB_APP_ID, privateKeyPem: config.GITHUB_APP_PRIVATE_KEY } } : {}) }), bankFeeds: bankFeedProviders({ sandbox: config.BANK_FEED_SANDBOX === 'true', sandboxWebhookSecret: config.BANK_FEED_SANDBOX_WEBHOOK_SECRET }), bankFeedHosted: bankFeedHostedOf(config), adPlatforms: adPlatformsOf(config), adRevokers: adRevokersOf(config), adWriters: adWritersOf(config), adPausers: adPausersOf(config), adActivators: adActivatorsOf(config), adManagers: adManagersOf(config), adStateReaders: adStateReadersOf(config) },
            publicUrl: config.PUBLIC_URL,
            appUrl: appUrl(config),
            brand: config.BRAND_NAME,
            // Bounce reports reach this deployment only with both inbound settings (as for the invite mail).
            mail: { mailer: resolved.mail, templates: MAIL_TEMPLATES, brand: config.BRAND_NAME, bounceDomain: config.INBOUND_DOMAIN && config.INBOUND_SECRET ? config.INBOUND_DOMAIN : null },
            archive: { store: archiveStore, lagSeconds: config.ARCHIVE_LAG_SECONDS, restoreAlertDays: config.ARCHIVE_RESTORE_ALERT_DAYS },
            usageLimits: usageLimits(config),
            securityAlerts: alerts,
            aiPrice: { inputPerMTok: config.AI_PRICE_INPUT_PER_MTOK, outputPerMTok: config.AI_PRICE_OUTPUT_PER_MTOK, audioPerMinute: config.AI_PRICE_AUDIO_PER_MIN, defaultMonthlyBudget: config.AI_DEFAULT_MONTHLY_BUDGET ?? null },
            ...(transcribeEnabled(config) ? { meetingsTranscribe: { provider: { baseURL: config.TRANSCRIBE_BASE_URL as string, apiKey: config.TRANSCRIBE_API_KEY ?? null, model: config.TRANSCRIBE_MODEL as string, mode: config.TRANSCRIBE_API_MODE }, measurer: mediaMeasurerFor(config.MEDIA_URL, config.MEDIA_CALL_TIMEOUT_MS) } } : {}),
            outboxLagPauseSeconds: config.OUTBOX_LAG_PAUSE_SECONDS,
            ...(vapid ? { push: { sender: createPushSender(vapid), brand: config.BRAND_NAME } } : {}),
            ...(resolved.nativePush ? { nativePush: resolved.nativePush } : {}),
          }),
        );
        // The worker watchdog (#894, plan §4.9): a loop blocked over 5 s for 30 s exits the process, which restarts.
        const stopWatchdog = startLagWatchdog({ thresholdMs: WORKER_LAG_EXIT_MS, sustainMs: WORKER_LAG_SUSTAIN_MS, exit: (code) => process.exit(code) });
        stops.push(async () => stopWatchdog());
      }
    } catch (error) {
      await stopAll();
      throw error;
    }
    return stopAll;
  }

  async function rebindExports(orgIds: readonly string[]): Promise<number> {
    // System commands need system context, which only the worker's login role may enter (External-tenant gate T5).
    const workerUrl = config.WORKER_DATABASE_URL;
    if (!workerUrl) throw new Error('WORKER_DATABASE_URL is required for exports-rebind; run it in the worker container');
    const { pool, runtime } = buildRuntime(workerUrl, 'crove-restore', config.WORKER_DATABASE_POOL_MAX);
    try {
      await assertRlsEnforced(pool);
      await assertSystemContextAccess(pool, 'granted');
      return await rebindOrgExports({ runtime, store: resolved.storage }, orgIds);
    } finally {
      await pool.end();
    }
  }

  // The operator's user-disable and user-enable roles (#985): the worker login is the only role that may execute
  // ludy_kernel.user_set_disabled and enter the system context the audit notes run in.
  async function setUserStatus(disabled: boolean, argv: readonly string[]): Promise<number> {
    const workerUrl = config.WORKER_DATABASE_URL;
    if (!workerUrl) throw new Error(`WORKER_DATABASE_URL is required for ${disabled ? 'user-disable' : 'user-enable'}; run it in the worker container`);
    const { pool, runtime } = buildRuntime(workerUrl, 'crove-operator', config.WORKER_DATABASE_POOL_MAX);
    try {
      await assertRlsEnforced(pool);
      await assertSystemContextAccess(pool, 'granted');
      return await runUserDisable({ runtime }, disabled, argv);
    } finally {
      // Best effort: a failure to close never hides the run's own outcome.
      await pool.end().catch((error: unknown) => console.error('[user-status] could not close the pool', error));
    }
  }

  // The operator's org-purge role (#1024): the worker login is the only role that may execute ludy_kernel.org_purge
  // and enter the system context the purge runs in. Its command deletes blobs, so only this runtime registers it.
  async function purgeOrg(argv: readonly string[]): Promise<number> {
    const workerUrl = config.WORKER_DATABASE_URL;
    if (!workerUrl) throw new Error('WORKER_DATABASE_URL is required for org-purge; run it in the worker container');
    const { pool, runtime } = buildRuntime(workerUrl, 'crove-operator', config.WORKER_DATABASE_POOL_MAX);
    runtime.register({ commands: [orgPurgeCommand({ store: resolved.storage })] });
    try {
      await assertRlsEnforced(pool);
      await assertSystemContextAccess(pool, 'granted');
      return await runOrgPurge({ runtime, minDays: config.ORG_PURGE_MIN_DAYS }, argv);
    } finally {
      // Best effort: a failure to close never hides the run's own outcome.
      await pool.end().catch((error: unknown) => console.error('[org-purge] could not close the pool', error));
    }
  }

  // The restore-report role (#2007): the worker login is the only role that may read the archive hashes and execute
  // ludy_kernel.number_series_reseed, in the system context its command runs in. Only this runtime registers it.
  async function restoreReport(argv: readonly string[]): Promise<number> {
    const workerUrl = config.WORKER_DATABASE_URL;
    if (!workerUrl) throw new Error('WORKER_DATABASE_URL is required for restore-report; run it in the worker container');
    const { pool, db, runtime } = buildRuntime(workerUrl, 'crove-restore', config.WORKER_DATABASE_POOL_MAX);
    runtime.register({ commands: [numberReseedCommand()] });
    try {
      await assertRlsEnforced(pool);
      await assertSystemContextAccess(pool, 'granted');
      return await runRestoreReport({ db, store: createArchiveStore(config), runtime }, argv);
    } finally {
      // Best effort: a failure to close never hides the run's own outcome.
      await pool.end().catch((error: unknown) => console.error('[restore-report] could not close the pool', error));
    }
  }

  // The shred replay role (#2579, ADR-0017 section 8): after a restore, every meeting a shred reference of the archive store names is deleted again, and the
  // objects and file rows that leaves are removed. The worker does the same at start; this runs it on demand from the restore runbook.
  async function shredReplay(): Promise<number> {
    const workerUrl = config.WORKER_DATABASE_URL;
    if (!workerUrl) throw new Error('WORKER_DATABASE_URL is required for shred-replay; run it in the worker container');
    if (!config.LUDY_MODULES.includes('meetings')) {
      console.log('[shred-replay] the meetings module is not enabled here; nothing to replay');
      return 0;
    }
    const { pool, db, runtime } = buildRuntime(workerUrl, 'crove-restore', config.WORKER_DATABASE_POOL_MAX);
    try {
      await assertRlsEnforced(pool);
      await assertSystemContextAccess(pool, 'granted');
      const replay = await replayShreds({ runtime, workerDb: db, store: createArchiveStore(config) });
      // What the retention shredded since the restore point came back too: shred it again before anything else opens.
      const due = await runMeetingsRetention({ runtime, workerDb: db });
      const sweep = await sweepMeetingMedia({ runtime, workerDb: db, store: resolved.storage });
      return replay.failed > 0 || due.failed > 0 || sweep.failed > 0 ? 1 : 0;
    } finally {
      // Best effort: a failure to close never hides the run's own outcome.
      await pool.end().catch((error: unknown) => console.error('[shred-replay] could not close the pool', error));
    }
  }

  // Re-registers live Telegram webhooks under the current CREDENTIAL_KEY (#3150 item 1). Also runs automatically in the worker's reseal sweep.
  async function rekeyTelegramWebhooks(): Promise<number> {
    const workerUrl = config.WORKER_DATABASE_URL;
    if (!workerUrl) throw new Error('WORKER_DATABASE_URL is required for telegram-webhook-rekey; run it in the worker container');
    if (config.CHANNEL_TELEGRAM === 'true' && !config.PUBLIC_URL?.startsWith('https://')) {
      console.error('[telegram-webhook-rekey] skipped (PUBLIC_URL is not https); cannot verify Telegram webhooks');
      return 1;
    }
    const { pool, db, runtime } = buildRuntime(workerUrl, 'ludy-telegram-rekey', config.WORKER_DATABASE_POOL_MAX, 'worker');
    try {
      await assertRlsEnforced(pool);
      await assertSystemContextAccess(pool, 'granted');
      if (config.CHANNEL_TELEGRAM !== 'true') {
        const currentKeyId = (resolved.broker as { keyId?: string }).keyId;
        const left = await countTelegramWebhookRekeyLeft(db, currentKeyId);
        if (left.leftActive > 0) {
          console.error(`[telegram-webhook-rekey] skipped (Telegram channel disabled) while ${left.leftActive} active webhook(s) remain under an older key`);
          return 1;
        }
        console.log('[telegram-webhook-rekey] skipped (Telegram channel disabled; 0 active webhooks under older keys)');
        return 0;
      }
      const publishers = channelPublishers(config);
      const outcome = await runTelegramWebhookRekey({
        runtime,
        broker: resolved.broker,
        workerDb: db,
        adapter: (provider: string) => (Object.hasOwn(publishers, provider) ? publishers[provider]?.conversations : undefined),
        baseUrl: config.PUBLIC_URL,
        maxPages: 500,
      });
      if (outcome.skipped) {
        console.error(
          `[telegram-webhook-rekey] skipped (${outcome.skipReason ?? 'locked or unconfigured'}); did not verify remaining webhooks`,
        );
        return 1;
      }
      console.log(
        `[telegram-webhook-rekey] rekeyed ${outcome.rekeyed}, failed ${outcome.failed}; left under an older key: ${outcome.leftActive} active, ${outcome.leftInactive} to reconnect`,
      );
      if (outcome.failed > 0 || outcome.leftActive > 0) {
        console.error('[telegram-webhook-rekey] incomplete: keep CREDENTIAL_KEY_PREVIOUS until failed = 0 and leftActive = 0');
        return 1;
      }
      return 0;
    } finally {
      await pool.end().catch((error: unknown) => console.error('[telegram-webhook-rekey] could not close the pool', error));
    }
  }

  return { config, modules: config.LUDY_MODULES, adapters: resolved, start, rebindExports, setUserStatus, purgeOrg, restoreReport, shredReplay, rekeyTelegramWebhooks };
}

// The Social writer as the API uses it: drafts, rewrites, hashtags, post ideas (#1181) and period summaries (#1237) as
// they are, and with an image-capable model (AI_VISION) an image's alt text from its stored bytes, read and checked
// like a download (#817), never more of them than the file row records (#1126), and a draft from the post's photos
// (#1191), each read the same way, one after another, before the one model call.
export function socialDrafter(writer: NonNullable<KernelAdapters['writer']>, store: BlobStore | null): SocialDrafter {
  const describe = writer.describeImage?.bind(writer);
  return {
    draft: (request) => writer.draft(request),
    rewrite: (request) => writer.rewrite(request),
    ...(writer.hashtags ? { hashtags: writer.hashtags.bind(writer) } : {}),
    ...(writer.ideas ? { ideas: writer.ideas.bind(writer) } : {}),
    ...(writer.summary ? { summary: writer.summary.bind(writer) } : {}),
    ...(store && describe
      ? { describeStored: async (file, mime, language, maxChars) => describe({ image: await readVerified(store, file, file.sizeBytes), mime, language, maxChars: maxChars ?? null }) }
      : {}),
    ...(store
      ? {
          draftStored: async (request, images) => {
            const read: { image: Uint8Array; mime: string }[] = [];
            for (const i of images) read.push({ image: await readVerified(store, i.file, i.file.sizeBytes), mime: i.mime });
            return writer.draft({ ...request, images: read });
          },
        }
      : {}),
  };
}

// The open-source defaults, built from configuration: Supabase Auth identity (ADR-0028), any OpenAI-compatible
// endpoint for AI, local disk or S3-compatible storage, SMTP for mail. No DOS service.
export function defaultAdapters(config: Config): KernelAdapters {
  const aiConfig =
    config.AI_BASE_URL && config.AI_MODEL
      ? { baseURL: config.AI_BASE_URL, apiKey: config.AI_API_KEY ?? null, model: config.AI_MODEL, supportsStructuredOutputs: config.AI_STRUCTURED_OUTPUTS === 'true', maxRetries: config.AI_MAX_RETRIES }
      : null;
  return {
    identity: {
      sessions: createSessionStatusSource(config.AUTH_SESSION_CHECK, config.AUTH_OAUTH_CLIENT_ID ?? null),
      authenticator: (db) => createAuthenticator(config, db),
      revoker: createSessionRevoker(config),
    },
    ai: aiConfig ? new InvoiceExtractor(aiConfig) : null,
    writer: aiConfig ? new SocialWriter(aiConfig) : null,
    scheduler: aiConfig ? new SchedulingReader(aiConfig) : null,
    conversationWriter: aiConfig ? new ConversationWriter(aiConfig) : null,
    today: aiConfig ? new TodayWriter(aiConfig) : null,
    weekly: aiConfig ? new WeeklyWriter(aiConfig) : null,
    adsCampaignWriter: aiConfig ? new AdsCampaignWriter(aiConfig) : null,
    inboxReader: aiConfig ? new InboxReader(aiConfig) : null,
    summaryModel: aiConfig ? summaryModelPort(aiConfig) : null,
    signAi: aiConfig ? new SignAiReader(aiConfig) : null,
    // API and worker build the same store from config; with STORAGE=s3 they share no volume (T7).
    storage: createBlobStore(config),
    // SMTP from SMTP_*; without SMTP_HOST, the log fallback.
    mail: createMailer(config),
    // crove-local: the vault keyed by CREDENTIAL_KEY or CREDENTIAL_KEY_FILE; none without a key (ADR-0025).
    broker: createCredentialBroker(config),
  };
}

// The worker's detective security alerts (#996): the thresholds, and the prober's webhook when it is set. A webhook the
// prober would refuse (a Telegram one without its chat id) is reported once and the alerts stay in the log.
function securityAlerts(config: Config): { target: WebhookTarget | null; thresholds: SecurityThresholds } {
  const thresholds: SecurityThresholds = {
    windowSeconds: config.SECURITY_ALERT_WINDOW_SECONDS,
    orgThreshold: config.SECURITY_ALERT_ORG_THRESHOLD,
    refusalThreshold: config.SECURITY_ALERT_REFUSAL_THRESHOLD,
    repeatSeconds: config.SECURITY_ALERT_REPEAT_MINUTES * 60,
  };
  try {
    const target = webhookTarget(
      {
        ALERT_WEBHOOK_URL: config.ALERT_WEBHOOK_URL,
        ALERT_WEBHOOK_FORMAT: config.ALERT_WEBHOOK_FORMAT,
        ALERT_TELEGRAM_CHAT_ID: config.ALERT_TELEGRAM_CHAT_ID,
        ALERT_INSTANCE: config.ALERT_INSTANCE,
        PUBLIC_URL: config.PUBLIC_URL,
      },
      'security alerts',
    );
    return { target, thresholds };
  } catch (error) {
    console.error(`[security] ALERT ${error instanceof Error ? error.message : String(error)}; security and operational alerts go to the log only`);
    return { target: null, thresholds };
  }
}
