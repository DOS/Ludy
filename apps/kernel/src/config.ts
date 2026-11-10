import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { EXTRACT_TIMING } from '@crove/extract-contract';
import { zExtensionId } from '@crove/kernel-contract';
import type { UsageLimits } from '@crove/kernel';
import { SIGNUP_POLICIES, parseAllowedDomains } from './auth-signup-policy.ts';
import { WEBHOOK_ENV } from './alert.ts';
import { parseAllowedOrigins } from './cors.ts';
import { exportSealer } from './export-seal.ts';
import { STAGING_MAX_AGE_MS } from './retention.ts';

// The product name when BRAND_NAME is unset (#1040).
export const MEDIA_UPLOAD_REQUEST_TIMEOUT_MAX_S = STAGING_MAX_AGE_MS / 1000 - 300;
export const DEFAULT_BRAND_NAME = 'Ludy';
const BRAND_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} .,&'+_!()-]*$/u;

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

// Modules this build ships (plan Decision 12, ADR-0031). kernel is always on; the others are on unless CROVE_MODULES
// leaves them out.
export const AVAILABLE_MODULES = ['kernel', 'finance', 'social', 'ads', 'crm', 'notes', 'hr', 'meetings'] as const;
export type ModuleId = (typeof AVAILABLE_MODULES)[number];

// CROVE_MODULES: a comma-separated list such as `finance`. Unset or empty enables every available module; kernel is
// added when missing. An unknown name stops the boot, so a typo never silently turns a module off. The prober reads it
// too, as the modules the deployment runs (#1894).
export const modulesSetting = optional.transform((value, ctx): readonly ModuleId[] => {
  if (value === undefined) return AVAILABLE_MODULES;
  const names = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  // Only separators (",", " , ") names no module: the same as empty, so every module.
  if (names.length === 0) return AVAILABLE_MODULES;
  const unknown = names.filter((name) => !(AVAILABLE_MODULES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    ctx.addIssue({ code: 'custom', message: `unknown module(s) ${unknown.join(', ')}; available: ${AVAILABLE_MODULES.join(', ')}` });
    return z.NEVER;
  }
  return AVAILABLE_MODULES.filter((module) => module === 'kernel' || names.includes(module));
});

// The extract jobs a worker runs at once when EXTRACT_WORKER_CONCURRENCY is unset (#2119): the AI call, 10 to 20 s for a PDF
// that needs it, is what the parallelism hides.
export const DEFAULT_EXTRACT_WORKER_CONCURRENCY = 4;

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  // Loopback by default; the Docker image sets 0.0.0.0 and compose publishes the port on loopback.
  HOST: z.string().default('127.0.0.1'),
  // Number of reverse proxies in front of Crove whose X-Forwarded-For entries are trusted (0 = none).
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  // Where the API answers: the auth proxy (`/auth/v1`), webhooks, short links (`/l/<code>`), link-in-bio pages and
  // feeds. With the web app served from the same origin (self-host) it is also where people open the app.
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  // Where people open the web app, when it is served from another origin than the API (a split deployment, #2261: the app
  // at app.<domain>, the API at api.<domain>). Every link that opens a screen of the app (invite, notification and report
  // mail, calendar feed events, chat alerts) and the OAuth return addresses (`/channels/oauth/<provider>/callback`,
  // `/calendar/oauth/<provider>/callback`, pages of the app) are built from it. Unset: PUBLIC_URL, as before. A different
  // origin must also be listed in CORS_ALLOWED_ORIGINS.
  // An origin only (scheme, host, optional port): a path, query or user information is refused, as in CORS_ALLOWED_ORIGINS.
  APP_URL: optional.pipe(
    z
      .url({ protocol: /^https?$/ })
      .refine((v) => URL.canParse(v) && new URL(v).origin === v, 'APP_URL is an origin only (scheme, host, optional port; no path, query, user information or trailing slash)')
      .optional(),
  ),
  // The exact origins whose pages may call this API from a browser (#2261), comma separated: the web app's origin in a
  // split deployment. Never `*`; https only (http for localhost). Unset: no CORS headers at all, which is right when the
  // app is served from this API's own origin.
  CORS_ALLOWED_ORIGINS: optional.transform((v, ctx) => {
    try {
      return parseAllowedOrigins(v);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) });
      return z.NEVER;
    }
  }),
  // Which modules' commands, queries, jobs, routes and menus this deployment registers. Migrations still apply to
  // every schema (one linear ledger); per-org access is entitlements (Decision 10), not this setting.
  CROVE_MODULES: modulesSetting,
  DATABASE_URL: z.string().min(1),
  WORKER_DATABASE_URL: optional,
  // Reset each pooled connection's session before it goes back to the pool (#117, plan §3.3). Keep true for direct
  // connections (self-host); set false only behind a transaction-mode pooler (PgBouncer, Supavisor), where the reset
  // would reach another server connection and the pooler's own reset governs.
  DB_RESET_ON_RELEASE: z.enum(['true', 'false']).default('true'),
  // Connections of the API's pool (DATABASE_URL, the app login) and of the worker's (WORKER_DATABASE_URL), per process
  // (#2175). Both default to the 10 they were fixed at; raise one when the pool's wait shows in the slow queries or the
  // logs, keeping the sum over every process under the database's max_connections (docs/runbooks/observability.md).
  // The worker's floor is 2: the calendar sweep and write-back hold one connection for their lock while their queries need
  // another, so a pool of 1 would hang them (and every other job behind them).
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  WORKER_DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(200).default(10),
  // json: every log line of the API, the worker and the prober is one JSON object with the request or job ids (#2175,
  // apps/kernel/src/log.ts); text: the plain lines, the default for a laptop. `pnpm pilot:check` recommends json on a public URL.
  LOG_FORMAT: z.enum(['json', 'text']).default('text'),
  ADMIN_DATABASE_URL: optional,
  // The database holds other systems' schemas, roles and event triggers beside Ludy's (Ludy Cloud inside DOS's Supabase
  // project, #2284): `migrate` then limits every effect to the `crove_*` roles and schemas (docs/runbooks/shared-database.md).
  // false (the default, and every self-host) keeps every database-wide guard.
  CROVE_SHARED_DATABASE: optional.pipe(z.enum(['true', 'false']).default('false')),
  // The mode is locked to the database once `migrate` has recorded it: a run that asks for the other one is refused unless
  // this is true, for the one run a person decides to switch it in.
  CROVE_SHARED_DATABASE_SWITCH: optional.pipe(z.enum(['true', 'false']).default('false')),
  MIGRATIONS_DIR: z.string().default(here('../../../supabase/migrations')),
  // How long `migrate` waits for another run's migration lock before it fails; unset waits as long as it takes (#1803).
  // Empty (a compose `${VAR:-}`) counts as unset; coerced, it would be 0 and fail every role's config.
  MIGRATE_LOCK_WAIT_SECONDS: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().positive().optional()),
  WEB_DIST: z.string().default(here('../../app/dist')),
  // Blob storage (External-tenant gate T7): local disk under STORAGE_DIR, or any S3-compatible store. The API
  // and the worker must point at the same store; with s3 they need no shared volume.
  STORAGE: z.enum(['local', 's3']).default('local'),
  STORAGE_DIR: z.string().default(here('../../../.data/files')),
  // Unset for AWS S3; the server's URL for MinIO, Cloudflare R2 or GCS interoperability.
  S3_ENDPOINT: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // R2 uses auto.
  S3_REGION: optional.transform((v) => v ?? 'us-east-1'),
  S3_BUCKET: optional.pipe(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/)
      .optional(),
  ),
  // Both or neither: without them the SDK's default chain applies (environment, instance or workload identity).
  S3_ACCESS_KEY_ID: optional,
  S3_SECRET_ACCESS_KEY: optional,
  // Path-style URLs (endpoint/bucket/key), needed by MinIO and most self-hosted servers.
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false'),
  // Evidence integrity (ADR-0013): required (the default) refuses a write the bucket returns without an object
  // version, so the bucket must have versioning enabled; off accepts an unversioned bucket (for example Cloudflare
  // R2) and then relies on the sha256 check alone.
  S3_VERSIONING: z.enum(['required', 'off']).default('required'),
  // Browsers upload to a staging key and download through presigned URLs (plan §7.6). The bucket needs a CORS rule
  // for PUBLIC_URL (POST and GET). false keeps every transfer streaming through the kernel; Cloudflare R2 needs false
  // (it has no POST policy uploads, so Crove refuses to start with true on an R2 endpoint). It does not switch off the
  // signed reads Zalo OA, Instagram and Threads fetch media by (#2192): those need an https endpoint, not this setting.
  S3_PRESIGNED_URLS: z.enum(['true', 'false']).default('true'),
  // The S3 endpoint browsers reach, when it differs from S3_ENDPOINT (presigned URLs are signed for this host). On a
  // public PUBLIC_URL it must be https: it is where browsers send files, and it lands in the CSP connect-src.
  S3_PUBLIC_ENDPOINT: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // The WORM fact stream (plan §4.10, issue #891, worm.ts): where the worker anchors audit events and journal entries.
  // s3: ARCHIVE_S3_BUCKET, a bucket with Object Lock, reached with the S3_ENDPOINT, S3_REGION, credentials and path
  // style above; objects are locked in ARCHIVE_LOCK_MODE for ARCHIVE_RETENTION_DAYS. local: read-only files under
  // ARCHIVE_DIR, which whoever controls the host can still rewrite (docs/runbooks/worm-archive.md).
  ARCHIVE_STORE: z.enum(['local', 's3']).default('local'),
  ARCHIVE_DIR: z.string().default(here('../../../.data/archive')),
  ARCHIVE_S3_BUCKET: optional,
  ARCHIVE_LOCK_MODE: z.enum(['GOVERNANCE', 'COMPLIANCE']).default('GOVERNANCE'),
  ARCHIVE_RETENTION_DAYS: z.coerce.number().int().min(1).max(36_500).default(3650),
  // How long after a row is written it is archived at the earliest, so a transaction still open is not cut off.
  ARCHIVE_LAG_SECONDS: z.coerce.number().int().min(60).max(86_400).default(600),
  // Days the nightly verifier alerts, on every run, about the restore acknowledgement in force after the store wrote it
  // (#2020, docs/runbooks/worm-archive.md).
  ARCHIVE_RESTORE_ALERT_DAYS: z.coerce.number().int().min(1).max(365).default(14),
  // Fiscal year archive packages (issue #922) in the STORAGE=s3 bucket: lock each part in ARCHIVE_LOCK_MODE for this
  // many days (the bucket needs Object Lock). 0: the bucket's default retention, if any. Local disk has no lock.
  S3_ARCHIVE_LOCK_DAYS: z.coerce.number().int().min(0).max(36_500).default(0),
  // Retention holds on evidence files (issue #1009): the original file of every posted invoice is held in the STORAGE=s3
  // bucket for this many days from its posting, in GOVERNANCE mode (the bucket needs Object Lock). 3650 (10 years,
  // Accounting Law 88/2015 Art. 41) until the accountant says otherwise; raising it lengthens existing holds, lowering
  // it never shortens one. 0: no holds. Local disk has no holds.
  EVIDENCE_LOCK_DAYS: z.coerce.number().int().min(0).max(36_500).default(3650),
  // Staged upload completions one API process runs at once (issue #223): each buffers the staged file (up to 25 MB)
  // while it hashes and writes it. Past it, and past half of it for one user, completions answer 503 UPLOAD_BUSY with
  // Retry-After and their grant stays unused. Uploads through POST /api/files (#432) get twice as many slots, on the
  // same terms (bulk intake sends its documents three at a time).
  UPLOAD_COMPLETE_CONCURRENCY: z.coerce.number().int().min(1).max(256).default(4),
  // How long a request may take to arrive whole, in seconds (Node's requestTimeout, #2780). Node's own 300 s cannot carry a 2 GB
  // meeting recording that is uploaded through the kernel (STORAGE=local, or a raw body) over a slow uplink: 2 GB in 300 s needs
  // 6.7 MB/s. The default is 45 minutes (about 1 MB/s). With STORAGE=s3 the app and the extension send media straight to the bucket by a
  // presigned grant, so the kernel receives only a small request and the default matters less; set 300 to keep Node's own limit.
  // A request that stops sending for a minute is cut whatever this is (upload-timeouts.ts). The most is the staging sweep's age
  // (STAGING_MAX_AGE_MS, one hour) less a 5 minute margin (#2843 N5): a raw upload is staged under staging/ while it arrives, and a
  // request that may outlive the sweep could have its staged object deleted under it.
  MEDIA_UPLOAD_REQUEST_TIMEOUT_S: z.coerce.number().int().min(300).max(MEDIA_UPLOAD_REQUEST_TIMEOUT_MAX_S).default(2700),
  // Presigned upload grants (kernel.file.upload.begin) one user may open per org in any rolling minute, counted in the
  // database across API instances (issue #223). Bounds the staging objects an abandoned upload loop leaves behind.
  UPLOAD_BEGIN_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(20),
  // Excel and XML exports of the books (GET /api/export/*) one API process runs at once (#2121): each holds its rows and
  // the finished file in memory and compresses it. Past it, and past two for one user, an export answers 503
  // EXPORT_BUSY with Retry-After. Per process, like UPLOAD_COMPLETE_CONCURRENCY.
  EXPORT_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
  // Org exports (issue #212, plan §7.9): kept EXPORT_RETENTION_DAYS (35 to 90) after they are made, then deleted by the
  // worker's daily retention job.
  EXPORT_RETENTION_DAYS: z.coerce.number().int().min(35).max(90).default(35),
  // The operator's org-purge role (issue #1024) runs only this many days after the org's newest export. The database
  // refuses fewer than 30 whatever this says.
  ORG_PURGE_MIN_DAYS: z.coerce.number().int().min(30).max(3650).default(30),
  // The AES-256-GCM key that seals org exports at rest: 32 random bytes as base64 or hex (openssl rand -base64 32). The
  // API (downloads) and the worker (exports) need the same key. Required on a public PUBLIC_URL; without it (local URLs
  // only) exports are stored unencrypted.
  EXPORT_ENCRYPTION_KEY: optional,
  // Earlier keys, comma separated, kept only to read exports sealed before a rotation, until those expired.
  EXPORT_ENCRYPTION_KEY_PREVIOUS: optional,
  // Supabase Auth (GoTrue). Self-host: the kernel proxies /auth/v1 to AUTH_UPSTREAM_URL.
  AUTH_UPSTREAM_URL: optional,
  PUBLIC_AUTH_URL: optional,
  PUBLIC_AUTH_ANON_KEY: optional,
  AUTH_JWT_SECRET: optional,
  // The context token key (#1822, ADR-0028 section 9): base64 of 32 to 64 random bytes (`node dist/main.js
  // context-token-key` prints one). The same value goes to the migrate step, which installs it in the database, and to
  // the kernel, which signs a token with it for every user context it enters. Unset: today's enter_context.
  CROVE_CONTEXT_TOKEN_KEY: optional,
  AUTH_JWKS_URL: optional,
  // Required (ADR-0028): the `iss` every access token must carry. Bundled Supabase Auth: GOTRUE_JWT_ISSUER.
  AUTH_ISSUER: optional,
  AUTH_AUDIENCE: z.string().default('authenticated'),
  // Session status source (ADR-0028): db reads Supabase Auth's tables in the shared database (self-host); jwt
  // (Crove Cloud, or any remote Supabase Auth) trusts the verified token until its exp, plus Crove's own session
  // records, and confirms every R3 command live with Supabase Auth; off checks only Crove's own records and never
  // calls Auth (local URLs only). Unset: db when AUTH_UPSTREAM_URL is set (bundled Supabase Auth), jwt otherwise.
  AUTH_SESSION_CHECK: z.enum(['db', 'jwt', 'off']).optional(),
  // Policy P11: R3 needs MFA in the last 5 minutes. off is accepted on local URLs only.
  AUTH_STEP_UP: z.enum(['required', 'off']).default('required'),
  // Mirrors GOTRUE_MAILER_AUTOCONFIRM so the kernel can refuse unsafe public deployments.
  AUTH_AUTOCONFIRM: z.enum(['true', 'false']).default('false'),
  // Per-client budget for the emails the bundled Supabase Auth sends (sign-up confirmation, recovery, magic link and
  // OTP codes, resend, email change, reauthentication), enforced by the /auth/v1 proxy in the database across API
  // instances (#190): at most AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR per client address (IPv6: per /64) in any rolling
  // hour, and one per recipient every AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS. AUTH_RATE_LIMIT_EMAIL_SENT is Supabase
  // Auth's deployment-wide budget (GOTRUE_RATE_LIMIT_EMAIL_SENT, per hour); when set, a public deployment refuses to
  // start unless it takes at least EMAIL_BUDGET_MIN_CLIENTS client addresses to use it up.
  // Who may create an account (#350), enforced by the /auth/v1 proxy in front of the bundled Supabase Auth: open (the
  // default; AUTH_DISABLE_SIGNUP still closes sign-up), invite_only (an email with a valid member invite) or allowlist
  // (an email at one of AUTH_SIGNUP_ALLOWED_DOMAINS, comma separated, or with a valid invite). See auth-signup-policy.ts.
  AUTH_SIGNUP_POLICY: optional.pipe(z.enum(SIGNUP_POLICIES).optional()).transform((v) => v ?? 'open'),
  AUTH_SIGNUP_ALLOWED_DOMAINS: optional.transform((value, ctx): readonly string[] => {
    if (value === undefined) return [];
    const { domains, invalid } = parseAllowedDomains(value);
    if (invalid.length > 0) {
      ctx.addIssue({ code: 'custom', message: `not a domain: ${invalid.join(', ')}` });
      return z.NEVER;
    }
    return domains;
  }),
  // Under allowlist, a sign-up at an allowed domain is refused when the address holds an invite and the request lacks
  // its token, so a refusal tells that the address is invited (#564). At most AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR such
  // refusals per client (an IPv4 address or an IPv6 /48) and AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR for the whole
  // deployment (0, the default: no deployment limit, since a member who may invite could fill it) in any rolling hour;
  // past either, those sign-ups get 429. Unset or blank takes the default.
  AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR: optional
    .transform((v) => (v === undefined ? 5 : Number(v)))
    .pipe(z.number().int().min(1).max(100_000)),
  AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR: optional
    .transform((v) => (v === undefined ? 0 : Number(v)))
    .pipe(z.number().int().min(0).max(100_000)),
  AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(5),
  AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  AUTH_RATE_LIMIT_EMAIL_SENT: optional
    .transform((v) => (v === undefined ? undefined : Number(v)))
    .pipe(z.number().int().min(1).max(1_000_000).optional()),
  // Per-user limits on creating orgs (External-tenant gate T4), enforced in the database across API instances:
  // at most ORG_CREATE_LIMIT_PER_DAY in any rolling 24 hours and ORG_CREATE_LIMIT_TOTAL ever (closed orgs count).
  ORG_CREATE_LIMIT_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(5),
  ORG_CREATE_LIMIT_TOTAL: z.coerce.number().int().min(1).max(999_999).default(20),
  // Per-org limits on rotating the inbound email address (#113), enforced in the database across API instances:
  // at most INBOUND_ROTATE_LIMIT_PER_DAY in any rolling 24 hours and INBOUND_ROTATE_LIMIT_TOTAL ever. Every rotation
  // leaves a permanent tombstone, so the total bounds the ledger.
  INBOUND_ROTATE_LIMIT_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(3),
  INBOUND_ROTATE_LIMIT_TOTAL: z.coerce.number().int().min(1).max(999_999).default(50),
  // Member invite mails one address may get in any 24 hours from all orgs together (#185), enforced in the database
  // across API instances, on top of the per-org limits (50 invites per org and 3 per email in any 24 hours). An
  // org's first invite of an address in the window always passes; only repeats are refused.
  INVITE_LIMIT_PER_RECIPIENT_PER_DAY: z.coerce.number().int().min(1).max(1000).default(5),
  // Per-org abuse limits (#675), counted in the database over any 24 hours and enforced by the worker: an inbound
  // message or a document over a limit is kept and handled once the org is back under it, and its owners get a mail.
  // ORG_LIMIT_AI_COST_PER_DAY is in the unit of AI_PRICE_INPUT_PER_MTOK and AI_PRICE_OUTPUT_PER_MTOK (the price of one
  // million input and output tokens, for example USD); with no prices AI cost counts as zero and only pages bound it.
  ORG_LIMIT_INBOUND_EMAILS_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(300),
  ORG_LIMIT_ATTACHMENT_MB_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(1000),
  ORG_LIMIT_EXTRACTION_PAGES_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(1500),
  // Customer mail to the org's conversation address (#2439) has a budget of its own, so spam on a published address never defers an invoice.
  ORG_LIMIT_CONVERSATION_EMAILS_PER_DAY: z.coerce.number().int().min(1).max(999_999).default(300),
  ORG_LIMIT_AI_COST_PER_DAY: z.string().regex(/^\d{1,9}(\.\d{1,6})?$/).default('20'),
  AI_PRICE_INPUT_PER_MTOK: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).default('0'),
  AI_PRICE_OUTPUT_PER_MTOK: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).default('0'),
  // The monthly AI budget (#2382) an org with none of its own gets, in the unit of the AI_PRICE_* prices: at 100% new model
  // calls are refused while the books keep working, and an owner can raise it for their org (an R3 command with a fresh
  // second factor). Unset: no default budget, so an org has none until an owner sets one. It counts only with prices set.
  AI_DEFAULT_MONTHLY_BUDGET: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().regex(/^\d{1,12}(\.\d{1,6})?$/).optional()),
  // Detective security alerts (#996): the worker alerts when one user acts in more than SECURITY_ALERT_ORG_THRESHOLD
  // orgs, or the deployment sees more than SECURITY_ALERT_REFUSAL_THRESHOLD refusals, within
  // SECURITY_ALERT_WINDOW_SECONDS, and on every owner or admin grant; a lasting signal repeats after
  // SECURITY_ALERT_REPEAT_MINUTES. Alerts go to the log, and to ALERT_WEBHOOK_URL when it is set (the prober's chat).
  // The same window holds the operational ALERT lines of each process (a failed export, a stopped sweep: #1993) to one
  // post per kind.
  SECURITY_ALERT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(300),
  SECURITY_ALERT_ORG_THRESHOLD: z.coerce.number().int().min(1).max(1_000_000).default(20),
  SECURITY_ALERT_REFUSAL_THRESHOLD: z.coerce.number().int().min(1).max(1_000_000).default(500),
  SECURITY_ALERT_REPEAT_MINUTES: z.coerce.number().int().min(5).max(10_080).default(60),
  // Back-pressure (#894, plan §4.9): while the oldest unpublished outbox event is older than this, the worker stops
  // fetching agent, bulk mail, archive and retention jobs; interactive work keeps running.
  OUTBOX_LAG_PAUSE_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
  ALERT_WEBHOOK_URL: WEBHOOK_ENV.ALERT_WEBHOOK_URL,
  ALERT_WEBHOOK_FORMAT: WEBHOOK_ENV.ALERT_WEBHOOK_FORMAT,
  ALERT_TELEGRAM_CHAT_ID: WEBHOOK_ENV.ALERT_TELEGRAM_CHAT_ID,
  ALERT_INSTANCE: WEBHOOK_ENV.ALERT_INSTANCE,
  // Bound on denied/failed audit rows (issue #162), counted in the database across API instances: in each fixed
  // window of REFUSAL_AUDIT_WINDOW_SECONDS, an actor's refusals get an audit row until the actor has
  // REFUSAL_AUDIT_LIMIT_PER_ACTOR or the org REFUSAL_AUDIT_LIMIT_PER_ORG refusals in it; later ones are only counted
  // (crove_kernel.refusal_tally). The first refusal of each command and code of an actor in a window is always audited,
  // so are an actor's first REFUSAL_AUDIT_RESERVE_PER_ACTOR refusals whatever the org's count, and security-relevant
  // refusals (FORBIDDEN, STEP_UP_REQUIRED, 404s and the like) up to the actor's own limit. The worker deletes tally
  // windows older than REFUSAL_TALLY_RETENTION_DAYS.
  REFUSAL_AUDIT_LIMIT_PER_ACTOR: z.coerce.number().int().min(1).max(999_999).default(50),
  REFUSAL_AUDIT_LIMIT_PER_ORG: z.coerce.number().int().min(1).max(999_999).default(500),
  REFUSAL_AUDIT_RESERVE_PER_ACTOR: z.coerce.number().int().min(0).max(999_999).default(10),
  REFUSAL_AUDIT_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),
  REFUSAL_TALLY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(7),
  // The credential key seals channel tokens (ADR-0025): 32 bytes as base64 or 64 hex characters. It never goes in the
  // database. CREDENTIAL_KEY wins; else CREDENTIAL_KEY_FILE names a file holding it, created with a fresh key when
  // missing (the all-in-one container). CREDENTIAL_KEY_PREVIOUS still opens tokens sealed before a rotation
  // (docs/runbooks/credential-key.md). Without a key no channel can be connected.
  CREDENTIAL_KEY: optional,
  CREDENTIAL_KEY_FILE: optional,
  CREDENTIAL_KEY_PREVIOUS: optional,
  // The MCP endpoint and its embedded OAuth 2.1 authorization server (ADR-0051 decision 2, ADR-0032, #2975). Off by default. On: OAUTH_JWKS is the
  // private key set (a JSON Web Key Set with at least one ES256 key that has a `kid`) the access tokens are signed with, OAUTH_COOKIE_KEYS signs the
  // authorization server's short-lived cookies (one or more secrets of 32 characters or more, comma separated, the first signs), and APP_URL, when set,
  // is PUBLIC_URL's own origin (the consent page and the interaction cookie share the API's origin in this step). Nothing is generated at boot.
  OAUTH_SERVER: z.enum(['on', 'off']).default('off'),
  OAUTH_JWKS: optional,
  OAUTH_COOKIE_KEYS: optional,
  // Origins a browser-based MCP client may call from (comma separated, each an origin). Unset: none; a client that sends no Origin header (every
  // desktop and server client) is not affected. A request with an Origin outside the list is refused with 403 (the MCP transport rule against DNS rebinding).
  MCP_ALLOWED_ORIGINS: optional,
  // Calls per minute one grant may make before the endpoint answers 429, and the cap of concurrent calls of one grant.
  MCP_GRANT_PER_MINUTE: z.coerce.number().int().min(1).max(6000).default(60),
  MCP_GRANT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  // Dynamic client registrations one address may make per minute, and all addresses together (RFC 7591 is public by protocol).
  OAUTH_REGISTER_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
  OAUTH_REGISTER_GLOBAL_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
  // The offline sandbox channel (Social plan §3.5): connect and publish without any platform account.
  CHANNEL_SANDBOX: z.enum(['true', 'false']).default('true'),
  // The offline sandbox e-invoice provider (ADR-0044, #2500, #2502): series and drafts are made, and invoices issued, without any provider account. Left out, it is on for a
  // local PUBLIC_URL and off for a public one; set to true on a public deployment that runs the finance module it is refused, since what it issues is read into a sale of the books.
  EINVOICE_SANDBOX: optional.pipe(z.enum(['true', 'false']).optional()),
  // The offline sandbox bank feed (ADR-0039, #2044): off unless asked for, so a deployment shows no bank feed until it
  // has one.
  BANK_FEED_SANDBOX: z.enum(['true', 'false']).default('false'),
  // The secret the sandbox bank feed's signed notices are checked with (POST /api/bank-feed/bank_sandbox/webhook); unset:
  // the sandbox takes no notices. At least 32 characters.
  BANK_FEED_SANDBOX_WEBHOOK_SECRET: optional,
  // The offline sandbox ad platform (ADR-0040, #2217): connect a test ad account and read made-up daily figures without any
  // platform account. Left out, it is on for a local PUBLIC_URL and off for a public one (compose passes it through empty). Its figures
  // reach no books: the ads screen only shows them beside the ledger's total.
  ADS_SANDBOX: optional.pipe(z.enum(['true', 'false']).optional()),
  // Whether the worker may create the objects of an approved campaign at Meta (#2296, W2-3: a campaign, an ad set, a creative and an ad, every one PAUSED; nothing
  // un-pauses). Off by default: with it off a launch on a Meta account stays queued, untouched. It is for the owner's own live check on a stack the owner runs;
  // a public deployment refuses it until the activation, the pause on switch-off (W2-4) and the live-check runbook (W2-5) are on main.
  ADS_LIVE_LAUNCH: z.enum(['true', 'false']).default('false'),
  // Bluesky (S9): accounts connect with an app password, no app of the deployment's own is needed. On unless false.
  CHANNEL_BLUESKY: z.enum(['true', 'false']).default('true'),
  // Telegram channels (#747): a bot the shop makes with @BotFather posts to its channel; no app of the deployment's own is
  // needed. On unless false.
  CHANNEL_TELEGRAM: z.enum(['true', 'false']).default('true'),
  // Mastodon (#748): an account on any instance connects with an access token made in its settings; every call to an
  // instance goes through the egress guard. On unless false.
  CHANNEL_MASTODON: z.enum(['true', 'false']).default('true'),
  // Discord channels (#832): a server admin makes a webhook in the channel's settings and pastes its URL; no app of the
  // deployment's own is needed. On by default, like Telegram.
  CHANNEL_DISCORD: z.enum(['true', 'false']).default('true'),
  // WordPress sites (#833): a user of a self-hosted or WordPress.com Business site connects with an application password;
  // every call to a site goes through the egress guard. On unless false.
  CHANNEL_WORDPRESS: z.enum(['true', 'false']).default('true'),
  // The deployment's Meta app (Facebook Pages, Social plan S6). Set both to offer Facebook Pages; neither hides them.
  // The app's valid OAuth redirect URI is APP_URL/channels/oauth/facebook_page/callback.
  CHANNEL_META_APP_ID: optional,
  CHANNEL_META_APP_SECRET: optional,
  // The secret CHANNEL_META_APP_SECRET replaces while Meta may still sign webhook notices with it during a rotation (conversation core CV2, #2307).
  CHANNEL_META_APP_SECRET_PREVIOUS: optional,
  // A separate Meta app for Instagram (#2212), for an operator whose Pages app cannot carry the Instagram use case. Both or neither;
  // unset, Instagram keeps using the Meta app above. Its valid OAuth redirect URI is APP_URL/channels/oauth/instagram/callback.
  CHANNEL_INSTAGRAM_APP_ID: optional,
  CHANNEL_INSTAGRAM_APP_SECRET: optional,
  // The verify token Meta sends on GET /api/channels/facebook/webhook when subscribing the app's Page webhook (conversation core CV2, #2307).
  // Set alongside CHANNEL_META_APP_ID and CHANNEL_META_APP_SECRET, the route /api/channels/facebook/webhook exists and Page comment notices are taken in.
  CHANNEL_META_WEBHOOK_VERIFY_TOKEN: optional,
  // Reconcile recent comments on connected Facebook Pages that granted pages_read_user_content (conversation core CV2, #2307).
  CHANNEL_FACEBOOK_HISTORY: z.enum(['true', 'false']).default('true'),
  CHANNEL_META_GRAPH_VERSION: z.string().regex(/^v\d{1,3}\.\d{1,2}$/).default('v24.0'),
  // The Meta app for ad accounts, read only (ADR-0040, #2218): set both to offer "Connect a Meta ad account" on the Ads
  // screen; neither hides it. It may be the same app as the Pages one above (a classic app holds Facebook Login and the
  // Marketing API together), so the same id and secret can be given twice; but a Meta user token carries every permission
  // the person ever granted that app, so with a shared app the ads token can also hold the Pages ones (the connection
  // records the full set), and a separate app keeps it to ads_read. The app's valid OAuth redirect URI is
  // APP_URL/channels/oauth/meta_ads/callback. The Graph version is CHANNEL_META_GRAPH_VERSION.
  CHANNEL_META_ADS_APP_ID: optional,
  CHANNEL_META_ADS_APP_SECRET: optional,
  // The Meta app for the write connection of an ad account, which can run ads (ADR-0043, #2294, W0b): set both to offer "Connect to run
  // ads" on the Ads screen (it also needs the org's switch on); neither hides it. It may be the read ads app above (the owner's own account:
  // a classic app holds Facebook Login and the Marketing API together) or an app of its own. A Meta permission belongs to the pair of the
  // app and the person, and a token of a shared app holds every permission the person ever granted it, the reading tokens of the same
  // person included: with the one app, switching running ads off closes the Meta reading connections too, and a deployment others reach
  // needs an app of its own (neither the read ads app nor the Pages app), so no reading token can hold the permission (#2366). Either
  // way Meta's data deletion callback verifies a request against this app's secret too, and finds the person's write grant by the hash
  // keyed with it; set the callback address in both apps. The app's valid OAuth redirect URI is APP_URL/channels/oauth/metawrite_ads/callback.
  // The Graph version is CHANNEL_META_GRAPH_VERSION.
  CHANNEL_META_ADS_WRITE_APP_ID: optional,
  CHANNEL_META_ADS_WRITE_APP_SECRET: optional,
  // The Google Cloud OAuth web client for Google Ads, read only (ADR-0040, #2220): set both to offer "Connect a Google Ads
  // account" on the Ads screen; neither hides it. Each deployment brings its own Google Cloud project and OAuth client (no
  // developer token: Google sunset them in 2026-09), and the callback URI is APP_URL/channels/oauth/google_ads/callback.
  CHANNEL_GOOGLE_ADS_CLIENT_ID: optional,
  CHANNEL_GOOGLE_ADS_CLIENT_SECRET: optional,
  // The deployment's Zalo app, linked to the OAs it posts for (Social plan S6.4). Set both to offer Zalo OA. The app's
  // callback URL is APP_URL/channels/oauth/zalo_oa/callback.
  CHANNEL_ZALO_APP_ID: optional,
  CHANNEL_ZALO_APP_SECRET: optional,
  // The Zalo app's OA secret key (not the app secret): the key Zalo signs its webhook notices with (conversation core, #2304). Set, the
  // route POST /api/channels/zalo/webhook exists and customers' messages to the connected OAs are taken in. A credential: it is read from
  // the environment only, never logged, stored or put in an answer; rotate it by changing it in the Zalo app and here together.
  CHANNEL_ZALO_OA_SECRET_KEY: optional,
  // The key CHANNEL_ZALO_OA_SECRET_KEY replaces, kept while Zalo may still sign with it (a rotation in the console, then here).
  CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS: optional,
  // Read the OA's recent chats to fill what the webhook missed (conversation core CV5b, #2329): off until the live check has settled the
  // answers' shapes, the message ids above all (the history must name a message as the webhook does, or it would store it twice).
  CHANNEL_ZALO_HISTORY: z.enum(['true', 'false']).default('false'),
  // The hosts a customer's image on Zalo may be fetched from (conversation core CV5c, #2357): domain suffixes separated by commas, each
  // matching the host itself and its subdomains. Unset: the built-in list (ZALO_MEDIA_HOSTS in @crove/channel), which is [S, U] until the
  // live check settles it (docs/runbooks/zalo-conversations-live-check.md row 18). An image from any other host is never fetched.
  CHANNEL_ZALO_MEDIA_HOSTS: optional,
  // The deployment's Threads app (the Threads use case of a Meta app has its own id), S9. Callback URL:
  // APP_URL/channels/oauth/threads/callback.
  CHANNEL_THREADS_APP_ID: optional,
  CHANNEL_THREADS_APP_SECRET: optional,
  // The deployment's LinkedIn app (Share on LinkedIn, Sign In with OpenID Connect), S9. Callback URL:
  // APP_URL/channels/oauth/linkedin/callback.
  CHANNEL_LINKEDIN_CLIENT_ID: optional,
  CHANNEL_LINKEDIN_CLIENT_SECRET: optional,
  // LinkedIn post counts (#797): true once the LinkedIn app has member post analytics (r_member_postAnalytics).
  CHANNEL_LINKEDIN_ANALYTICS: z.enum(['true', 'false']).default('false'),
  // LinkedIn Company Pages (#1077): true once the LinkedIn app has the Community Management API (w_organization_social,
  // r_organization_admin). Callback URL: APP_URL/channels/oauth/linkedin_page/callback.
  CHANNEL_LINKEDIN_ORGANIZATIONS: z.enum(['true', 'false']).default('false'),
  // A separate LinkedIn app for Company Pages: LinkedIn grants the Community Management API only to an app with no other
  // product, so a deployment that also posts as members sets these; without them pages use the member app above.
  CHANNEL_LINKEDIN_PAGE_CLIENT_ID: optional,
  CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET: optional,
  // The deployment's Google Cloud project for YouTube uploads (YouTube Data API v3, an OAuth web client), S9. Callback
  // URL: APP_URL/channels/oauth/youtube/callback.
  CHANNEL_GOOGLE_CLIENT_ID: optional,
  CHANNEL_GOOGLE_CLIENT_SECRET: optional,
  // Google Business Profile posts (#709), with the same Google project once Google has approved it for the Business
  // Profile APIs (Basic API Access). Off by default: an unapproved project gets no answer from them. Callback URL:
  // APP_URL/channels/oauth/google_business/callback.
  CHANNEL_GOOGLE_BUSINESS: z.enum(['true', 'false']).default('false'),
  // Outside calendars members connect (#2123, #1374): the operator's own Google OAuth web client with the Calendar API
  // enabled (scope calendar.freebusy). Not the project above: it is a different app and consent screen. Callback URL:
  // APP_URL/calendar/oauth/google_calendar/callback. With neither set, the connect button is not offered.
  CALENDAR_GOOGLE_CLIENT_ID: optional,
  CALENDAR_GOOGLE_CLIENT_SECRET: optional,
  // The deployment's TikTok app (Login Kit and Content Posting API, Direct Post), S9. Callback URL:
  // APP_URL/channels/oauth/tiktok/callback.
  CHANNEL_TIKTOK_CLIENT_KEY: optional,
  CHANNEL_TIKTOK_CLIENT_SECRET: optional,
  // The TikTok app also has the Display API: connections ask for video.list, and posts' counts are read (#744).
  CHANNEL_TIKTOK_VIDEO_LIST: z.enum(['true', 'false']).default('false'),
  // The TikTok app is approved for video.upload (#903): connections ask for it, and the editor offers sending a video
  // to the creator's TikTok inbox as a draft. Off by default: TikTok refuses a sign-in that asks for a scope the app lacks.
  CHANNEL_TIKTOK_INBOX: z.enum(['true', 'false']).default('false'),
  // The deployment's X app (OAuth 2.0, a confidential client with PKCE), S9; X bills each post to its account.
  // Callback URL: APP_URL/channels/oauth/x/callback.
  CHANNEL_X_CLIENT_ID: optional,
  CHANNEL_X_CLIENT_SECRET: optional,
  // X post counts (#797): every read is billed by X, so the metrics sweep reads X posts only when this is true.
  CHANNEL_X_METRICS: z.enum(['true', 'false']).default('false'),
  // Pinterest (#798): the deployment's Pinterest app.
  CHANNEL_PINTEREST_APP_ID: optional,
  CHANNEL_PINTEREST_APP_SECRET: optional,
  // Requests per minute per signed-in user on /api (429 RATE_LIMITED with Retry-After past it), per API process; see
  // rate-limit.ts. 0 turns it off, for a deployment whose edge (proxy, CDN or WAF) limits per user instead.
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(999_999).default(600),
  // Realtime invalidation (issue #69, plan §9): GET /api/stream sends ids of changed records over SSE. Each API process
  // LISTENs on one dedicated connection to DATABASE_LISTEN_URL, which must be a direct or session-mode connection
  // (LISTEN does not work through a transaction-mode pooler such as PgBouncer in transaction mode or Supavisor :6543);
  // unset, DATABASE_URL. STREAM_MAX_CONNECTIONS open streams per process (0 turns streams off and the app polls),
  // STREAM_MAX_PER_USER per user and process. Every STREAM_RECHECK_SECONDS, and after every 50 hints, each stream
  // re-runs the session check and membership of its org and closes when either fails. At most
  // STREAM_RECHECK_CONCURRENCY of those re-checks run at once per process (each takes a connection of the API pool of
  // 10); the others wait their turn, holding their hints.
  DATABASE_LISTEN_URL: optional,
  STREAM_MAX_CONNECTIONS: z.coerce.number().int().min(0).max(100_000).default(500),
  STREAM_MAX_PER_USER: z.coerce.number().int().min(1).max(100).default(5),
  STREAM_RECHECK_SECONDS: z.coerce.number().int().min(5).max(60).default(30),
  STREAM_RECHECK_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  // Any OpenAI-compatible endpoint. Without it, e-invoice XML still works; PDF/images do not.
  AI_BASE_URL: optional,
  AI_API_KEY: optional,
  AI_MODEL: optional,
  // The model takes images (#817): the composer may ask it for an image's alt text.
  AI_VISION: z.enum(['true', 'false']).default('false'),
  AI_STRUCTURED_OUTPUTS: z.enum(['true', 'false']).default('true'),
  // crove-extract, the parsing sandbox (plan §7.6, External-tenant gate T12), e.g. http://crove-extract:8090.
  // Required for the worker role: the worker never parses PDF, XML or MIME itself. The API role does not use it.
  EXTRACT_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // crove-media, the media sandbox (Meetings M3, #2985), e.g. http://crove-media:8095. The API measures the length of every meeting
  // recording in it at upload and the worker re-measures an old one before it is transcribed. Unset: meeting uploads are refused
  // (MEDIA_PROBE_UNAVAILABLE), because a recording whose length cannot be known would bypass the AI meter.
  MEDIA_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // Extract jobs the worker runs at once (#2119), each one reading a file and, for a PDF or a photo, calling the AI. Unset:
  // 4, or the sandbox's slots when it has fewer. EXTRACT_CONCURRENCY is the sandbox's own setting of that name (its
  // parser slots, 1 to 8, the sandbox's own default being 1); give the worker the same value, since it cannot ask: docker
  // compose passes 4 to both. The worker never runs more extract jobs than the sandbox has slots, and keeps within the AI
  // provider's rate limit by this setting going down, not up.
  EXTRACT_WORKER_CONCURRENCY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().min(1).max(8).optional()),
  EXTRACT_CONCURRENCY: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().min(1).max(8).default(EXTRACT_TIMING.concurrency)),
  // Times the AI SDK sends an invoice-reading call again after a 429, a 5xx or a network error, before the document's
  // job fails and pg-boss retries it (#2119). The whole call, retries included, stops at the 120 s timeout; this bounds
  // the provider calls one document costs to 1 + AI_MAX_RETRIES (2 by default, the SDK's own default being 3), and so
  // the cost and the rate-limit load of a document that keeps failing. 0 sends each call once.
  AI_MAX_RETRIES: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().min(0).max(5).default(1)),
  // Speech to text for the meetings module (#2578, M4b). Off unless MEETINGS_TRANSCRIBE=on and an OpenAI-compatible transcription endpoint is set
  // (TRANSCRIBE_BASE_URL and TRANSCRIBE_MODEL; the key is optional for a local model). The module works with it off: no run starts and the screen shows
  // no button. AI_PRICE_AUDIO_PER_MIN is the price of one minute of audio in the unit of the other AI_PRICE_* settings (default 0: counted, not priced).
  MEETINGS_TRANSCRIBE: z.enum(['on', 'off']).default('off'),
  // The recorder's Vy summarizing a meeting (#2580, M6): off unless MEETINGS_SUMMARY=on (it also needs the deployment's AI provider and Vy turned on for members).
  // The module works with it off: the recorder types a summary and items by hand, and no button asks Vy.
  MEETINGS_SUMMARY: z.enum(['on', 'off']).default('off'),
  // How many meeting videos this process streams at once, over all members (#2965; each member may have 3, or this many if it is lower). A stream holds a slot until its body ends,
  // so size it from the members who may watch together and the process's memory (a window is 4 MiB); a request over the limit is told to retry (429).
  MEETINGS_VIDEO_STREAMS_MAX: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().min(1).max(4096).default(64)),
  // https by default: the audio and the key travel to it. Plain http is accepted for localhost and 127.0.0.1, and for any host with TRANSCRIBE_ALLOW_INSECURE_HTTP=1
  // (a speech-to-text container on the compose network is http://<service>:<port>); the check is in loadConfig below (#2863).
  TRANSCRIBE_BASE_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  TRANSCRIBE_ALLOW_INSECURE_HTTP: optional.pipe(z.enum(['0', '1']).default('0')),
  TRANSCRIBE_API_KEY: optional,
  TRANSCRIBE_MODEL: optional,
  // How a chunk is sent (#2972): `audio_transcriptions` posts the file to /audio/transcriptions (Whisper-class, the default); `chat_input_audio` posts it to
  // /chat/completions as an input_audio part, for a provider that offers no transcription endpoint (Gemini's OpenAI-compatible one).
  TRANSCRIBE_API_MODE: optional.pipe(z.enum(['audio_transcriptions', 'chat_input_audio']).default('audio_transcriptions')),
  AI_PRICE_AUDIO_PER_MIN: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).default('0'),
  // Outbound mail (invites, issue #129), the same SMTP settings the bundled Supabase Auth uses. Unset SMTP_HOST: mail
  // is off, and the inviter passes the link on. Port 465 is implicit TLS; with SMTP_USER and SMTP_PASS on any other
  // port the server must offer STARTTLS.
  SMTP_HOST: optional,
  // An empty value (SMTP_PORT= in a .env) means the default.
  SMTP_PORT: optional.transform((v) => (v === undefined ? 587 : Number(v))).pipe(z.number().int().min(1).max(65_535)),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  SMTP_FROM: optional,
  // The provider of Crove's own mails (#539, Email plan §3.9): smtp (the settings above; off without SMTP_HOST) or
  // resend (RESEND_API_KEY; SMTP_FROM, on a domain verified at Resend, stays the sender). RESEND_WEBHOOK_SECRET
  // (whsec_...) checks the signature of Resend's delivery webhooks.
  MAIL_PROVIDER: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['smtp', 'resend']).default('smtp')),
  RESEND_API_KEY: optional,
  RESEND_WEBHOOK_SECRET: optional.pipe(z.string().regex(/^whsec_[A-Za-z0-9+/=]{24,}$/, 'RESEND_WEBHOOK_SECRET is the whsec_... signing secret of the webhook').optional()),
  // The build this image was made from (#892): the git SHA the release workflow passes as the image's CROVE_BUILD build
  // argument. GET /version reports it, so the deploy's smoke test can tell the new image from the old one. Unset (a
  // local build): "dev".
  CROVE_BUILD: optional.pipe(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'CROVE_BUILD is a build id: letters, digits, dot, dash, underscore').optional()),
  // When that commit was made (#1952): its committer date, ISO 8601, the image's CROVE_BUILD_TIME build argument. A
  // SHA has no order, so builds are compared by this date: the API's /readyz waits while a live worker runs an older
  // build (plan §3.5, worker build >= API build), and each worker records its own in its heartbeat. Unset (a local
  // build): no comparison.
  CROVE_BUILD_TIME: optional.pipe(z.iso.datetime({ offset: true, error: 'CROVE_BUILD_TIME is an ISO 8601 date and time with its offset' }).optional()),
  // Where the app's "Góp ý / Hỗ trợ" (feedback and support) link goes: an https: page (a chat group, a help desk) or
  // a mailto: address. Unset hides the link. Browsers see it through /api/config, so it must hold nothing secret.
  SUPPORT_URL: optional.pipe(
    z
      .url({ protocol: /^(https|mailto)$/ })
      .refine((value) => !value.toLowerCase().startsWith('mailto:') || new URL(value).pathname.trim() !== '', {
        message: 'a mailto: link needs an address',
      })
      .optional(),
  ),
  // The Ludy browser extension ids that may receive a sign-in code (#2740): the host of the extension's redirect address
  // (https://<id>.chromiumapp.org/), 32 letters a to p, separated by commas or spaces. Unset: the store's id
  // (DEFAULT_EXTENSION_IDS, empty until the store listing exists, which refuses every extension). A self-hosted or development install lists its own unpacked extension's id here. The app and
  // /api/extension/authorize both refuse any other. Browsers read the list from /api/config; it holds nothing secret.
  EXTENSION_IDS: optional.pipe(
    z
      .string()
      .transform((value) => value.split(/[\s,]+/).filter(Boolean))
      .pipe(z.array(zExtensionId, { error: 'EXTENSION_IDS lists extension ids: 32 letters a to p each, separated by commas or spaces' }).min(1).max(20))
      .optional(),
  ),
  // The product name users see (#1040): in the app, the page title and the product's own mails (sender name and texts). Code,
  // schemas, logs and the AGPL source notice keep "Crove". Plain text of 1 to 40 characters (letters, digits, spaces
  // and . , & ' + _ ! ( ) -), so it needs no escaping in HTML, ICU messages or a mail's From header. Browsers read it
  // from /api/config.
  BRAND_NAME: optional.pipe(
    z
      .string()
      .transform((value) => value.normalize('NFC'))
      .pipe(z.string().max(40, 'BRAND_NAME is at most 40 characters').regex(BRAND_NAME_PATTERN, "BRAND_NAME is plain text: letters, digits, spaces and . , & ' + _ ! ( ) -"))
      .default(DEFAULT_BRAND_NAME),
  ),
  // The terms of service and the privacy notice that sign-up and invite acceptance link to (#688, plan M3-6): https:
  // pages the deployment publishes. Unset hides the line. Browsers read them from /api/config.
  TERMS_URL: optional.pipe(z.url({ protocol: /^https$/ }).optional()),
  PRIVACY_URL: optional.pipe(z.url({ protocol: /^https$/ }).optional()),
  // The prober's last result for the public status page PUBLIC_URL/status (#678, status-page.ts): the file the
  // prober writes as PROBER_STATUS_FILE, on a volume both share. Unset: no /status page and no link to it in the app.
  STATUS_FILE: optional.pipe(z.string().refine((p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p), 'STATUS_FILE is an absolute path').optional()),
  // Stock photos from Pexels in the Social media library and the composer (#1106): the API key of a Pexels account
  // (https://www.pexels.com/api/). Unset: nothing is offered and Crove never calls Pexels. The key stays on the server;
  // searches and image downloads go through the API, so browsers never reach Pexels.
  MEDIA_PEXELS_API_KEY: optional.pipe(z.string().regex(/^[A-Za-z0-9]{20,100}$/, 'MEDIA_PEXELS_API_KEY is the key Pexels shows under Your API key: letters and digits').optional()),
  // Browser push for the Social notifications someone must act on (#1238): the deployment's VAPID key pair (RFC 8292),
  // base64url (the `vapid-keys` role prints a new pair), and the contact push services may write to about it (a mailto:
  // address or an https: URL). All three or none: unset, the app offers no push and nothing is sent. Changing the pair
  // ends every subscription; members turn push on again.
  // The all-in-one role puts the HTTP edge on the worker's all-org database login and every secret, so on a public
  // PUBLIC_URL the kernel starts it only with this opt-in (assertSplitRoles); the pilot runs api and worker apart.
  CROVE_ALLOW_ALL_IN_ONE: optional.pipe(z.enum(['true', 'false']).optional()),
  VAPID_PUBLIC_KEY: optional.pipe(z.string().regex(/^[A-Za-z0-9_-]{87}$/, 'VAPID_PUBLIC_KEY is the base64url public key the vapid-keys role prints').optional()),
  VAPID_PRIVATE_KEY: optional.pipe(z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'VAPID_PRIVATE_KEY is the base64url private key the vapid-keys role prints').optional()),
  VAPID_SUBJECT: optional.pipe(z.string().max(200).optional()),
  // The public tax registry lookup that prefills a new org from its tax code (issue #324): an https URL template with
  // {taxCode}, answering in the VietQR business shape (https://api.vietqr.io/v2/business/{taxCode}). Unset turns the
  // lookup off: it sends the tax codes your users type to that provider.
  TAX_CODE_LOOKUP_URL: optional.pipe(
    z
      .string()
      .refine((value) => value.includes('{taxCode}') && URL.canParse(value.replace('{taxCode}', '0100109106')) && new URL(value.replace('{taxCode}', '0100109106')).protocol === 'https:', {
        message: 'an https URL with {taxCode} in it',
      })
      .optional(),
  ),
  // The assisted purchase-invoice sync from the tax portal (issue #325, ADR-0036): the accountant types the client's
  // portal password and solves the portal's CAPTCHA in Crove, and the API fetches the period's purchase list and invoice
  // XML from hoadondientu.gdt.gov.vn. Off unless true: it logs in to a government portal on a client's behalf, which
  // the deployment opts into (docs/integrations/tax-portal-sync.md). Needs the credential key (CREDENTIAL_KEY).
  TAX_PORTAL_SYNC: z.enum(['true', 'false']).default('false'),
  // Where the portal's API is; unset: https://hoadondientu.gdt.gov.vn/api. Only for pointing a test deployment at a
  // fake portal (the end-to-end tests do); the API refuses it unless PUBLIC_URL is local (localhost or a .test name),
  // since any other address would receive the client's portal password.
  // One deadline, in seconds, for each list or XML step of a sync, all its portal requests together; past it the step
  // stops and the screen offers to go on.
  TAX_PORTAL_STEP_SECONDS: z.coerce.number().int().min(30).max(300).default(90),
  TAX_PORTAL_URL: optional.pipe(z.url({ protocol: /^https?$/ }).optional()),
  // Inbound email: <token>@INBOUND_DOMAIN, delivered by a mail worker to POST /api/inbound/email.
  INBOUND_DOMAIN: optional,
  INBOUND_SECRET: optional,
  // The name your receiving mail server writes in the Authentication-Results header it adds to each mail (its authserv-id, RFC 8601, usually its host
  // name). With it, a customer mail whose sender passes DMARC, or DKIM for the From domain, is shown as verified, may join a thread by its References and
  // brings the contact link with it; unset, no sender is verified (#2439). Never a name an earlier hop can write: your server must replace such a header.
  INBOUND_AUTHSERV_ID: optional.pipe(z.string().regex(/^[A-Za-z0-9.-]{1,253}$/, 'INBOUND_AUTHSERV_ID is a host name').optional()),
  // During a rotation of INBOUND_SECRET (#1214): the value the mail worker may still send, accepted as well until the
  // worker sends the new one; then remove it (docs/runbooks/secret-rotation.md, section 2).
  INBOUND_SECRET_PREVIOUS: optional,
  // Cloudflare Turnstile on the public booking form (#1353, CAL-2, plan docs/plan/calendar.md §3.4): both or neither.
  // With them, the page shows the widget and the kernel checks its token with Cloudflare before recording a request.
  TURNSTILE_SITE_KEY: optional.pipe(z.string().regex(/^[0-9A-Za-z_-]{1,100}$/, 'TURNSTILE_SITE_KEY is a Turnstile site key').optional()),
  TURNSTILE_SECRET: optional,
  // Role passwords applied by `migrate` (self-host).
  CROVE_APP_DB_PASSWORD: optional,
  CROVE_WORKER_DB_PASSWORD: optional,
  // The prober's login (crove_prober); it may only execute crove_kernel.health().
  CROVE_PROBER_DB_PASSWORD: optional,
  // The usage report's login (crove_reporter); it may only execute crove_kernel.usage_weekly().
  CROVE_REPORTER_DB_PASSWORD: optional,
  AUTH_DB_PASSWORD: optional,
});

export type SessionCheckMode = 'db' | 'jwt' | 'off';

export type Config = Omit<z.infer<typeof schema>, 'AUTH_ISSUER' | 'AUTH_SESSION_CHECK' | 'EINVOICE_SANDBOX' | 'ADS_SANDBOX'> & {
  AUTH_ISSUER: string;
  AUTH_SESSION_CHECK: SessionCheckMode;
  EINVOICE_SANDBOX: 'true' | 'false';
  ADS_SANDBOX: 'true' | 'false';
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => (i.code === 'custom' ? `${i.path.join('.')} (${i.message})` : i.path.join('.'))).join(', ');
    throw new Error(`invalid configuration: ${fields}`);
  }
  const raw = parsed.data;
  if (!raw.AUTH_ISSUER) {
    throw new Error('set AUTH_ISSUER to the issuer of your Supabase Auth access tokens (bundled: GOTRUE_JWT_ISSUER)');
  }
  const config: Config = {
    ...raw,
    AUTH_ISSUER: raw.AUTH_ISSUER,
    AUTH_SESSION_CHECK: raw.AUTH_SESSION_CHECK ?? (raw.AUTH_UPSTREAM_URL ? 'db' : 'jwt'),
    EINVOICE_SANDBOX: raw.EINVOICE_SANDBOX ?? (isLocalUrl(raw.PUBLIC_URL) ? 'true' : 'false'),
    // Same rule as EINVOICE_SANDBOX: compose passes it through empty, so a public URL never inherits a sandbox default.
    ADS_SANDBOX: raw.ADS_SANDBOX ?? (isLocalUrl(raw.PUBLIC_URL) ? 'true' : 'false'),
  };
  if (!config.AUTH_JWT_SECRET && !config.AUTH_JWKS_URL) {
    throw new Error('set AUTH_JWT_SECRET (self-hosted Supabase Auth) or AUTH_JWKS_URL (hosted Supabase Auth)');
  }
  if (config.AUTH_JWT_SECRET && config.AUTH_JWT_SECRET.length < 32) {
    throw new Error('AUTH_JWT_SECRET must be at least 32 characters');
  }
  if (config.INBOUND_SECRET && config.INBOUND_SECRET.length < 32) {
    throw new Error('INBOUND_SECRET must be at least 32 characters');
  }
  // The previous value follows the current one's rules, and is never the current one or a sample value (#1214). The
  // messages never carry either value.
  if (config.INBOUND_SECRET_PREVIOUS) {
    if (!config.INBOUND_SECRET) throw new Error('INBOUND_SECRET_PREVIOUS is set without INBOUND_SECRET');
    if (config.INBOUND_SECRET_PREVIOUS.length < 32) throw new Error('INBOUND_SECRET_PREVIOUS must be at least 32 characters');
    if (config.INBOUND_SECRET_PREVIOUS === config.INBOUND_SECRET) throw new Error('INBOUND_SECRET_PREVIOUS must differ from INBOUND_SECRET');
    if (/change-?me/i.test(config.INBOUND_SECRET_PREVIOUS)) throw new Error('INBOUND_SECRET_PREVIOUS still has a sample value');
  }
  // A widget without the secret could not be checked, and a secret without the widget would refuse every booking.
  if (Boolean(config.TURNSTILE_SITE_KEY) !== Boolean(config.TURNSTILE_SECRET)) {
    throw new Error('set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET, or neither');
  }
  // A sign-up policy the deployment cannot enforce, or one set only halfway, stops the boot instead of leaving
  // sign-up more open than the operator meant (#350).
  if (config.AUTH_SIGNUP_POLICY === 'allowlist' && config.AUTH_SIGNUP_ALLOWED_DOMAINS.length === 0) {
    throw new Error('AUTH_SIGNUP_POLICY=allowlist needs AUTH_SIGNUP_ALLOWED_DOMAINS, the email domains that may sign up');
  }
  if (config.AUTH_SIGNUP_POLICY !== 'allowlist' && config.AUTH_SIGNUP_ALLOWED_DOMAINS.length > 0) {
    throw new Error(`AUTH_SIGNUP_ALLOWED_DOMAINS applies to AUTH_SIGNUP_POLICY=allowlist only (it is ${config.AUTH_SIGNUP_POLICY}); set the policy or remove the domains`);
  }
  if (config.AUTH_SIGNUP_POLICY !== 'open' && !config.AUTH_UPSTREAM_URL) {
    throw new Error(
      `AUTH_SIGNUP_POLICY=${config.AUTH_SIGNUP_POLICY} is enforced by the /auth/v1 proxy in front of the bundled Supabase Auth (AUTH_UPSTREAM_URL); ` +
        'with a remote Supabase Auth, restrict sign-up there and leave AUTH_SIGNUP_POLICY unset',
    );
  }
  // Only where the sandbox is used (the worker; the API resets EXTRACT_URL), so a stray value never stops another role.
  if (config.EXTRACT_URL && config.EXTRACT_WORKER_CONCURRENCY !== undefined && config.EXTRACT_WORKER_CONCURRENCY > config.EXTRACT_CONCURRENCY) {
    throw new Error('EXTRACT_WORKER_CONCURRENCY must not exceed EXTRACT_CONCURRENCY, the sandbox parser slots: more extract jobs than slots only wait, or are refused as busy');
  }
  if (config.STORAGE === 's3' && !config.S3_BUCKET) throw new Error('STORAGE=s3 needs S3_BUCKET');
  if (config.ARCHIVE_STORE === 's3' && !config.ARCHIVE_S3_BUCKET) throw new Error('ARCHIVE_STORE=s3 needs ARCHIVE_S3_BUCKET');
  // Fails the boot on a malformed key rather than at the first export or download.
  exportSealer(config);
  if (config.REFUSAL_AUDIT_RESERVE_PER_ACTOR > config.REFUSAL_AUDIT_LIMIT_PER_ACTOR) {
    throw new Error('REFUSAL_AUDIT_RESERVE_PER_ACTOR must not exceed REFUSAL_AUDIT_LIMIT_PER_ACTOR');
  }
  if (Boolean(config.S3_ACCESS_KEY_ID) !== Boolean(config.S3_SECRET_ACCESS_KEY)) {
    throw new Error('set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither to use the default credential chain');
  }
  if (config.SMTP_HOST && !config.SMTP_FROM) throw new Error('SMTP_HOST needs SMTP_FROM, the sender address of Crove mails');
  if (config.MAIL_PROVIDER === 'resend' && (!config.RESEND_API_KEY || !config.SMTP_FROM)) {
    throw new Error('MAIL_PROVIDER=resend needs RESEND_API_KEY and SMTP_FROM, the sender address on a domain verified at Resend');
  }
  const presigned = config.STORAGE === 's3' && config.S3_PRESIGNED_URLS === 'true';
  // Cloudflare R2 has no POST policy uploads: with presigned URLs on, every browser upload would fail at the bucket.
  if (presigned && [config.S3_ENDPOINT, config.S3_PUBLIC_ENDPOINT].some(isR2Endpoint)) {
    throw new Error('Cloudflare R2 does not accept presigned POST uploads; set S3_PRESIGNED_URLS=false (transfers then stream through the kernel)');
  }
  if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASS)) throw new Error('set both SMTP_USER and SMTP_PASS, or neither');
  if (Boolean(config.CHANNEL_META_APP_ID) !== Boolean(config.CHANNEL_META_APP_SECRET)) {
    throw new Error('set both CHANNEL_META_APP_ID and CHANNEL_META_APP_SECRET, or neither');
  }
  if (config.CHANNEL_META_APP_ID && !/^\d{1,32}$/.test(config.CHANNEL_META_APP_ID)) throw new Error('CHANNEL_META_APP_ID is the numeric id of the Meta app');
  if (Boolean(config.CHANNEL_INSTAGRAM_APP_ID) !== Boolean(config.CHANNEL_INSTAGRAM_APP_SECRET)) {
    throw new Error('set both CHANNEL_INSTAGRAM_APP_ID and CHANNEL_INSTAGRAM_APP_SECRET, or neither');
  }
  if (config.CHANNEL_INSTAGRAM_APP_ID && !/^\d{1,32}$/.test(config.CHANNEL_INSTAGRAM_APP_ID)) throw new Error('CHANNEL_INSTAGRAM_APP_ID is the numeric id of the Meta app');
  // One Meta app has one secret: the Instagram app with the id of the Pages app is that app (a person's data deletion request is matched
  // by a hash keyed with the secret, and the webhook is signed with it).
  if (config.CHANNEL_INSTAGRAM_APP_ID && config.CHANNEL_INSTAGRAM_APP_ID === config.CHANNEL_META_APP_ID && config.CHANNEL_INSTAGRAM_APP_SECRET !== config.CHANNEL_META_APP_SECRET) {
    throw new Error('CHANNEL_INSTAGRAM_APP_ID is the id of CHANNEL_META_APP_ID but its secret is not CHANNEL_META_APP_SECRET; one Meta app has one secret');
  }
  if (config.CHANNEL_META_APP_SECRET_PREVIOUS !== undefined) {
    // It goes with the primary webhook secret: the Pages app's, or the Instagram app's when that is the only Meta app set (#2212).
    const primary = config.CHANNEL_META_APP_SECRET ?? config.CHANNEL_INSTAGRAM_APP_SECRET;
    if (primary === undefined) throw new Error('CHANNEL_META_APP_SECRET_PREVIOUS is set without CHANNEL_META_APP_SECRET');
    if (!/^\S{8,200}$/.test(config.CHANNEL_META_APP_SECRET_PREVIOUS)) throw new Error('CHANNEL_META_APP_SECRET_PREVIOUS is a Meta app secret: 8 to 200 characters, no whitespace');
    if (config.CHANNEL_META_APP_SECRET_PREVIOUS === primary) throw new Error('CHANNEL_META_APP_SECRET_PREVIOUS is the same as CHANNEL_META_APP_SECRET: remove it');
  }
  if (config.CHANNEL_META_WEBHOOK_VERIFY_TOKEN !== undefined) {
    if (!config.CHANNEL_META_APP_ID && !config.CHANNEL_INSTAGRAM_APP_ID) throw new Error('CHANNEL_META_WEBHOOK_VERIFY_TOKEN needs CHANNEL_META_APP_ID and CHANNEL_META_APP_SECRET, or CHANNEL_INSTAGRAM_APP_ID and CHANNEL_INSTAGRAM_APP_SECRET');
    if (!/^\S{8,200}$/.test(config.CHANNEL_META_WEBHOOK_VERIFY_TOKEN)) throw new Error('CHANNEL_META_WEBHOOK_VERIFY_TOKEN is the verify token for the Meta Page webhook: 8 to 200 characters, no spaces');
  }
  if (Boolean(config.CHANNEL_META_ADS_APP_ID) !== Boolean(config.CHANNEL_META_ADS_APP_SECRET)) {
    throw new Error('set both CHANNEL_META_ADS_APP_ID and CHANNEL_META_ADS_APP_SECRET, or neither');
  }
  if (config.CHANNEL_META_ADS_APP_ID && !/^\d{1,32}$/.test(config.CHANNEL_META_ADS_APP_ID)) throw new Error('CHANNEL_META_ADS_APP_ID is the numeric id of the Meta app');
  if (Boolean(config.CHANNEL_META_ADS_WRITE_APP_ID) !== Boolean(config.CHANNEL_META_ADS_WRITE_APP_SECRET)) {
    throw new Error('set both CHANNEL_META_ADS_WRITE_APP_ID and CHANNEL_META_ADS_WRITE_APP_SECRET, or neither');
  }
  if (config.CHANNEL_META_ADS_WRITE_APP_ID && !/^\d{1,32}$/.test(config.CHANNEL_META_ADS_WRITE_APP_ID)) throw new Error('CHANNEL_META_ADS_WRITE_APP_ID is the numeric id of the Meta app');
  // One Meta app has one secret: a write app that has the id of the read ads app or of the Pages app is that app, and its secret is the
  // same one (a half-done rotation would leave the hash of a person's write grant unmatched by the data deletion callback).
  for (const [name, id, secret] of [
    ['CHANNEL_META_ADS_APP', config.CHANNEL_META_ADS_APP_ID, config.CHANNEL_META_ADS_APP_SECRET],
    ['CHANNEL_META_APP', config.CHANNEL_META_APP_ID, config.CHANNEL_META_APP_SECRET],
    ['CHANNEL_INSTAGRAM_APP', config.CHANNEL_INSTAGRAM_APP_ID, config.CHANNEL_INSTAGRAM_APP_SECRET],
  ] as const) {
    if (config.CHANNEL_META_ADS_WRITE_APP_ID && config.CHANNEL_META_ADS_WRITE_APP_ID === id && config.CHANNEL_META_ADS_WRITE_APP_SECRET !== secret) {
      throw new Error(`CHANNEL_META_ADS_WRITE_APP_ID is the id of ${name}_ID but its secret is not ${name}_SECRET; one Meta app has one secret`);
    }
  }
  // An app that serves the Pages and the writing but not the reads: the person's Pages and Instagram tokens would hold the permission to
  // change campaigns, and the close at the switch-off covers the reading connections only. Use the read ads app, or an app of its own.
  if (config.CHANNEL_META_ADS_WRITE_APP_ID && [config.CHANNEL_META_APP_ID, config.CHANNEL_INSTAGRAM_APP_ID].includes(config.CHANNEL_META_ADS_WRITE_APP_ID) && config.CHANNEL_META_ADS_WRITE_APP_ID !== config.CHANNEL_META_ADS_APP_ID) {
    throw new Error(`CHANNEL_META_ADS_WRITE_APP_ID is the ${config.CHANNEL_META_ADS_WRITE_APP_ID === config.CHANNEL_META_APP_ID ? 'Pages' : 'Instagram'} app but not the read ads app: the Pages and Instagram tokens of the person who grants it could then change campaigns; use the read ads app or a Meta app of its own`);
  }
  if (Boolean(config.CHANNEL_THREADS_APP_ID) !== Boolean(config.CHANNEL_THREADS_APP_SECRET)) throw new Error('set both CHANNEL_THREADS_APP_ID and CHANNEL_THREADS_APP_SECRET, or neither');
  if (config.CHANNEL_THREADS_APP_ID && !/^\d{1,32}$/.test(config.CHANNEL_THREADS_APP_ID)) throw new Error('CHANNEL_THREADS_APP_ID is the numeric id of the Threads app');
  if (Boolean(config.CHANNEL_LINKEDIN_CLIENT_ID) !== Boolean(config.CHANNEL_LINKEDIN_CLIENT_SECRET)) throw new Error('set both CHANNEL_LINKEDIN_CLIENT_ID and CHANNEL_LINKEDIN_CLIENT_SECRET, or neither');
  if (config.CHANNEL_LINKEDIN_CLIENT_ID && !/^[A-Za-z0-9]{8,64}$/.test(config.CHANNEL_LINKEDIN_CLIENT_ID)) throw new Error('CHANNEL_LINKEDIN_CLIENT_ID is the client id of the LinkedIn app');
  if (Boolean(config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID) !== Boolean(config.CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET)) throw new Error('set both CHANNEL_LINKEDIN_PAGE_CLIENT_ID and CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET, or neither');
  if (config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID && !/^[A-Za-z0-9]{8,64}$/.test(config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID)) throw new Error('CHANNEL_LINKEDIN_PAGE_CLIENT_ID is the client id of the LinkedIn Company Pages app');
  if (config.CHANNEL_LINKEDIN_ORGANIZATIONS === 'true' && !config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID && !config.CHANNEL_LINKEDIN_CLIENT_ID) throw new Error('CHANNEL_LINKEDIN_ORGANIZATIONS needs CHANNEL_LINKEDIN_PAGE_CLIENT_ID and CHANNEL_LINKEDIN_PAGE_CLIENT_SECRET, or CHANNEL_LINKEDIN_CLIENT_ID and CHANNEL_LINKEDIN_CLIENT_SECRET');
  if (Boolean(config.CHANNEL_TIKTOK_CLIENT_KEY) !== Boolean(config.CHANNEL_TIKTOK_CLIENT_SECRET)) throw new Error('set both CHANNEL_TIKTOK_CLIENT_KEY and CHANNEL_TIKTOK_CLIENT_SECRET, or neither');
  if (config.CHANNEL_TIKTOK_CLIENT_KEY && !/^[A-Za-z0-9]{8,64}$/.test(config.CHANNEL_TIKTOK_CLIENT_KEY)) throw new Error('CHANNEL_TIKTOK_CLIENT_KEY is the client key of the TikTok app');
  if (Boolean(config.CHANNEL_GOOGLE_CLIENT_ID) !== Boolean(config.CHANNEL_GOOGLE_CLIENT_SECRET)) throw new Error('set both CHANNEL_GOOGLE_CLIENT_ID and CHANNEL_GOOGLE_CLIENT_SECRET, or neither');
  if (Boolean(config.CHANNEL_GOOGLE_ADS_CLIENT_ID) !== Boolean(config.CHANNEL_GOOGLE_ADS_CLIENT_SECRET)) throw new Error('set both CHANNEL_GOOGLE_ADS_CLIENT_ID and CHANNEL_GOOGLE_ADS_CLIENT_SECRET, or neither');
  if (config.CHANNEL_GOOGLE_ADS_CLIENT_ID && !/^[0-9]{6,32}-[A-Za-z0-9_-]{8,64}\.apps\.googleusercontent\.com$/.test(config.CHANNEL_GOOGLE_ADS_CLIENT_ID)) throw new Error('CHANNEL_GOOGLE_ADS_CLIENT_ID is the client id of a Google OAuth web client');
  if (Boolean(config.CALENDAR_GOOGLE_CLIENT_ID) !== Boolean(config.CALENDAR_GOOGLE_CLIENT_SECRET)) throw new Error('set both CALENDAR_GOOGLE_CLIENT_ID and CALENDAR_GOOGLE_CLIENT_SECRET, or neither');
  if (config.CALENDAR_GOOGLE_CLIENT_ID && !/^[0-9]{6,32}-[A-Za-z0-9_-]{8,64}\.apps\.googleusercontent\.com$/.test(config.CALENDAR_GOOGLE_CLIENT_ID)) throw new Error('CALENDAR_GOOGLE_CLIENT_ID is the client id of a Google OAuth web client');
  if (config.CHANNEL_GOOGLE_BUSINESS === 'true' && !config.CHANNEL_GOOGLE_CLIENT_ID) throw new Error('CHANNEL_GOOGLE_BUSINESS needs CHANNEL_GOOGLE_CLIENT_ID and CHANNEL_GOOGLE_CLIENT_SECRET');
  if (config.CHANNEL_GOOGLE_CLIENT_ID && !/^[0-9]{6,32}-[A-Za-z0-9_-]{8,64}\.apps\.googleusercontent\.com$/.test(config.CHANNEL_GOOGLE_CLIENT_ID)) throw new Error('CHANNEL_GOOGLE_CLIENT_ID is the client id of a Google OAuth web client');
  if (Boolean(config.CHANNEL_X_CLIENT_ID) !== Boolean(config.CHANNEL_X_CLIENT_SECRET)) throw new Error('set both CHANNEL_X_CLIENT_ID and CHANNEL_X_CLIENT_SECRET, or neither');
  if (Boolean(config.CHANNEL_PINTEREST_APP_ID) !== Boolean(config.CHANNEL_PINTEREST_APP_SECRET)) throw new Error('set both CHANNEL_PINTEREST_APP_ID and CHANNEL_PINTEREST_APP_SECRET, or neither');
  if (config.CHANNEL_PINTEREST_APP_ID && !/^\d{4,32}$/.test(config.CHANNEL_PINTEREST_APP_ID)) throw new Error('CHANNEL_PINTEREST_APP_ID is the numeric id of the Pinterest app');
  if (config.CHANNEL_X_CLIENT_ID && !/^[A-Za-z0-9_-]{16,64}$/.test(config.CHANNEL_X_CLIENT_ID)) throw new Error('CHANNEL_X_CLIENT_ID is the OAuth 2.0 client id of the X app');
  if (config.TRANSCRIBE_BASE_URL !== undefined) {
    const url = new URL(config.TRANSCRIBE_BASE_URL);
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname) && config.TRANSCRIBE_ALLOW_INSECURE_HTTP !== '1') {
      throw new Error('TRANSCRIBE_BASE_URL must be https (http only for localhost or 127.0.0.1, or any host with TRANSCRIBE_ALLOW_INSECURE_HTTP=1 on a private network)');
    }
  }
  if (config.BANK_FEED_SANDBOX_WEBHOOK_SECRET !== undefined) {
    if (config.BANK_FEED_SANDBOX !== 'true') throw new Error('BANK_FEED_SANDBOX_WEBHOOK_SECRET is set without BANK_FEED_SANDBOX=true');
    if (config.BANK_FEED_SANDBOX_WEBHOOK_SECRET.length < 32) throw new Error('BANK_FEED_SANDBOX_WEBHOOK_SECRET must be at least 32 characters');
  }
  if (Boolean(config.CHANNEL_ZALO_APP_ID) !== Boolean(config.CHANNEL_ZALO_APP_SECRET)) throw new Error('set both CHANNEL_ZALO_APP_ID and CHANNEL_ZALO_APP_SECRET, or neither');
  if (config.CHANNEL_ZALO_APP_ID && !/^\d{1,32}$/.test(config.CHANNEL_ZALO_APP_ID)) throw new Error('CHANNEL_ZALO_APP_ID is the numeric id of the Zalo app');
  if (config.CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS !== undefined) {
    if (config.CHANNEL_ZALO_OA_SECRET_KEY === undefined) throw new Error('CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS is set without CHANNEL_ZALO_OA_SECRET_KEY');
    if (!/^\S{8,200}$/.test(config.CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS)) throw new Error('CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS is an OA secret key: 8 to 200 characters, no whitespace');
    if (config.CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS === config.CHANNEL_ZALO_OA_SECRET_KEY) throw new Error('CHANNEL_ZALO_OA_SECRET_KEY_PREVIOUS is the same as CHANNEL_ZALO_OA_SECRET_KEY: remove it');
  }
  if (config.CHANNEL_ZALO_OA_SECRET_KEY !== undefined) {
    if (!config.CHANNEL_ZALO_APP_ID) throw new Error('CHANNEL_ZALO_OA_SECRET_KEY needs CHANNEL_ZALO_APP_ID and CHANNEL_ZALO_APP_SECRET');
    if (!/^\S{8,200}$/.test(config.CHANNEL_ZALO_OA_SECRET_KEY)) throw new Error('CHANNEL_ZALO_OA_SECRET_KEY is the OA secret key of the Zalo app: 8 to 200 characters, no spaces');
  }
  if (config.CHANNEL_ZALO_MEDIA_HOSTS !== undefined) {
    const hosts = zaloMediaHostsOf(config.CHANNEL_ZALO_MEDIA_HOSTS);
    if (hosts.length === 0 || hosts.length > 20 || hosts.some((h) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(h))) {
      throw new Error('CHANNEL_ZALO_MEDIA_HOSTS is up to 20 domain names (for example zdn.vn) separated by commas, each matching the domain and its subdomains');
    }
  }
  if (config.CROVE_CONTEXT_TOKEN_KEY !== undefined) {
    const bytes = /^[A-Za-z0-9+/_-]+={0,2}$/.test(config.CROVE_CONTEXT_TOKEN_KEY.trim()) ? Buffer.from(config.CROVE_CONTEXT_TOKEN_KEY.trim(), 'base64') : Buffer.alloc(0);
    if (bytes.length < 32 || bytes.length > 64) throw new Error('CROVE_CONTEXT_TOKEN_KEY must be base64 of 32 to 64 random bytes');
  }
  // A web app on another origin than the API calls it cross-origin, which the browser allows only for a listed origin.
  if (config.APP_URL !== undefined && URL.canParse(config.PUBLIC_URL)) {
    const appOrigin = new URL(config.APP_URL).origin;
    if (appOrigin !== new URL(config.PUBLIC_URL).origin && !config.CORS_ALLOWED_ORIGINS.includes(appOrigin)) {
      throw new Error(`APP_URL is another origin than PUBLIC_URL, so the app calls this API cross-origin: list ${appOrigin} in CORS_ALLOWED_ORIGINS`);
    }
  }
  // Temporary objects can exist in a shared database (PUBLIC keeps TEMPORARY), and only the pool's own reset after each
  // checkout (DISCARD TEMP) clears them, which a transaction-mode pooler would send to another backend.
  if (config.CROVE_SHARED_DATABASE === 'true' && config.AUTH_SESSION_CHECK === 'db') {
    throw new Error('CROVE_SHARED_DATABASE=true cannot use AUTH_SESSION_CHECK=db: its auth-grants step is refused in a shared database; use AUTH_SESSION_CHECK=jwt');
  }
  // Supabase's transaction-mode pooler listens on port 6543 (its session mode and the direct connection on 5432): the one
  // URL-level sign of the pooler the reset cannot work behind. Another pooler is the operator's to keep out (runbook).
  if (config.CROVE_SHARED_DATABASE === 'true') {
    for (const [name, url] of [['DATABASE_URL', config.DATABASE_URL], ['WORKER_DATABASE_URL', config.WORKER_DATABASE_URL]] as const) {
      if (url !== undefined && URL.canParse(url) && new URL(url).port === '6543') {
        throw new Error(`${name} points at port 6543, Supabase's transaction-mode pooler: CROVE_SHARED_DATABASE=true needs a direct or session-mode connection (port 5432), so that temporary objects are cleared after each checkout`);
      }
    }
  }
  if (config.CROVE_SHARED_DATABASE === 'true' && config.DB_RESET_ON_RELEASE === 'false') {
    throw new Error('CROVE_SHARED_DATABASE=true needs DB_RESET_ON_RELEASE=true: temporary objects are cleared after each checkout, which a transaction-mode pooler cannot do; use a direct or session-mode connection');
  }
  if (config.OAUTH_SERVER === 'on') {
    if (config.OAUTH_JWKS === undefined) throw new Error('OAUTH_SERVER=on needs OAUTH_JWKS, the private JSON Web Key Set (ES256) the access tokens are signed with');
    let keys: unknown;
    try {
      keys = (JSON.parse(config.OAUTH_JWKS) as { keys?: unknown }).keys;
    } catch {
      throw new Error('OAUTH_JWKS is not valid JSON');
    }
    const usable = Array.isArray(keys) && keys.length > 0 && keys.every((k) => {
      const key = k as { kty?: unknown; crv?: unknown; kid?: unknown; d?: unknown } | null;
      return key !== null && typeof key === 'object' && key.kty === 'EC' && key.crv === 'P-256' && typeof key.kid === 'string' && key.kid.length > 0 && typeof key.d === 'string';
    });
    if (!usable) throw new Error('OAUTH_JWKS must be a JSON Web Key Set of ES256 private keys (kty EC, crv P-256, with kid and d)');
    const cookieKeys = (config.OAUTH_COOKIE_KEYS ?? '').split(',').map((k) => k.trim()).filter((k) => k.length > 0);
    if (cookieKeys.length === 0 || cookieKeys.some((k) => k.length < 32)) throw new Error('OAUTH_SERVER=on needs OAUTH_COOKIE_KEYS: one or more secrets of at least 32 characters, comma separated');
    if (config.APP_URL !== undefined && new URL(config.APP_URL).origin !== new URL(config.PUBLIC_URL).origin) {
      throw new Error('OAUTH_SERVER=on needs APP_URL to be PUBLIC_URL\'s own origin: the consent page and the interaction cookie share the API origin in this step');
    }
  }
  if (config.MCP_ALLOWED_ORIGINS !== undefined) {
    for (const origin of config.MCP_ALLOWED_ORIGINS.split(',').map((o) => o.trim())) {
      if (!URL.canParse(origin) || new URL(origin).origin !== origin) throw new Error('MCP_ALLOWED_ORIGINS lists origins only (scheme, host, optional port), comma separated');
    }
  }
  if (!isLocalUrl(config.PUBLIC_URL)) {
    if (config.CROVE_CONTEXT_TOKEN_KEY !== undefined) {
      // Compared as bytes, so the unpadded or base64url spelling of the test key is the test key too.
      const bytes = Buffer.from(config.CROVE_CONTEXT_TOKEN_KEY.trim(), 'base64');
      if (SAMPLE_CONTEXT_TOKEN_KEYS.some((sample) => sample.equals(bytes))) {
        throw new Error('CROVE_CONTEXT_TOKEN_KEY is the test suite key; generate a random key before exposing Crove');
      }
      // A key that decodes to printable text is a passphrase, not random bytes (one in about 10^14 random keys is).
      if (bytes.every((byte) => byte >= 0x20 && byte <= 0x7e)) {
        throw new Error('CROVE_CONTEXT_TOKEN_KEY decodes to printable text; generate random bytes (openssl rand -base64 32) before exposing Crove');
      }
    }
    if (config.AUTH_JWT_SECRET && SAMPLE_SECRETS.has(config.AUTH_JWT_SECRET)) {
      throw new Error('AUTH_JWT_SECRET is a sample value; generate a random secret before exposing Crove');
    }
    // docker-compose.yml falls back to these passwords when a variable is unset, so a deployment that forgot one would
    // otherwise run its database logins on a value this public repository publishes. Only the setting is named.
    for (const name of ['DATABASE_URL', 'WORKER_DATABASE_URL', 'ADMIN_DATABASE_URL', 'DATABASE_LISTEN_URL'] as const) {
      if (hasSampleDbPassword(config[name])) {
        throw new Error(`${name} carries a database password shipped in .env.example or docker-compose.yml; set a random one (openssl rand -base64 24) before exposing Crove`);
      }
    }
    if ([config.TURNSTILE_SITE_KEY, config.TURNSTILE_SECRET].some((key) => key !== undefined && TURNSTILE_TEST_KEY.test(key))) {
      throw new Error("TURNSTILE_SITE_KEY or TURNSTILE_SECRET is one of Cloudflare's test keys; use the widget's real keys before exposing Crove");
    }
    if (config.AUTH_AUTOCONFIRM === 'true') {
      throw new Error('AUTH_AUTOCONFIRM=true lets anyone claim any email address; set it to false and configure SMTP');
    }
    // ADR-0039 point 3: the sandbox feed writes made-up bank lines, so it stays on development deployments.
    if (config.BANK_FEED_SANDBOX === 'true') {
      throw new Error('BANK_FEED_SANDBOX=true writes made-up bank lines into the books; it is for local development only');
    }
    // ADR-0040: the sandbox ad platform reports made-up spend, which the Ads screen sets beside the real ledger. docker
    // compose falls back to ADS_SANDBOX=true, so a public deployment that runs the ads module must set it to false.
    if (config.ADS_SANDBOX === 'true' && (config.CROVE_MODULES as readonly string[]).includes('ads')) {
      throw new Error('ADS_SANDBOX=true shows made-up ad spend next to the real books; it is for local development only: set ADS_SANDBOX=false');
    }
    // ADR-0044 point 8 (#2502): the offline provider "issues" invoices that the intake reads into sales of the books, so it stays on development deployments. docker compose
    // falls back to EINVOICE_SANDBOX=true, so a public deployment that runs the finance module must set it to false.
    if (config.EINVOICE_SANDBOX === 'true' && (config.CROVE_MODULES as readonly string[]).includes('finance')) {
      throw new Error('EINVOICE_SANDBOX=true issues made-up sales invoices into the books; it is for local development only: set EINVOICE_SANDBOX=false');
    }
    // ADR-0043 (#2296, W2-3): creating the objects of a campaign at Meta is for the owner's own live check, not for a deployment others reach, until the activation,
    // the pause on switch-off (W2-4) and the live-check runbook (W2-5) are built. Turning it on in production is a step the owner approves.
    if (config.ADS_LIVE_LAUNCH === 'true') {
      throw new Error('ADS_LIVE_LAUNCH=true lets the worker create campaign objects at Meta and switch them on, which spends real money; it is for the owner\'s own live check only and a public deployment refuses it until the live-check runbook is done and the owner has approved the production step list: set ADS_LIVE_LAUNCH=false');
    }
    // ADR-0043 point 4 (#2366): with the read ads app or the Pages app as the write app, once the owner connects to run ads, that person's
    // reading tokens can change campaigns too, in every org of the deployment while the switch-off closes them one org at a time. A
    // deployment others reach runs ads with a Meta app of its own.
    if (
      config.CHANNEL_META_ADS_WRITE_APP_ID &&
      ([config.CHANNEL_META_ADS_APP_ID, config.CHANNEL_META_APP_ID, config.CHANNEL_INSTAGRAM_APP_ID].includes(config.CHANNEL_META_ADS_WRITE_APP_ID) || [config.CHANNEL_META_ADS_APP_SECRET, config.CHANNEL_META_APP_SECRET, config.CHANNEL_INSTAGRAM_APP_SECRET].includes(config.CHANNEL_META_ADS_WRITE_APP_SECRET))
    ) {
      throw new Error('CHANNEL_META_ADS_WRITE_APP_ID is the read ads app or the Pages app: a public deployment runs ads with a Meta app of its own, so no reading token can hold the permission to change campaigns');
    }
    if (config.AUTH_SESSION_CHECK === 'off') {
      throw new Error('AUTH_SESSION_CHECK=off keeps signed-out sessions working; use db (bundled Supabase Auth) or jwt');
    }
    if (config.AUTH_SESSION_CHECK === 'jwt' && !liveAuthUrl(config)) {
      throw new Error('AUTH_SESSION_CHECK=jwt confirms R3 actions with Supabase Auth; set PUBLIC_AUTH_URL (or AUTH_UPSTREAM_URL)');
    }
    if (config.AUTH_STEP_UP === 'off') {
      throw new Error('AUTH_STEP_UP=off lets a stolen session approve and change roles without MFA; set it to required');
    }
    // A provider sends the authorization code to APP_URL (else PUBLIC_URL)/channels/oauth/<provider>/callback (#375), a
    // page of the web app.
    const oauthApps = [config.CHANNEL_META_APP_ID, config.CHANNEL_INSTAGRAM_APP_ID, config.CHANNEL_META_ADS_APP_ID, config.CHANNEL_META_ADS_WRITE_APP_ID, config.CHANNEL_GOOGLE_ADS_CLIENT_ID, config.CHANNEL_ZALO_APP_ID, config.CHANNEL_THREADS_APP_ID, config.CHANNEL_LINKEDIN_CLIENT_ID, config.CHANNEL_LINKEDIN_PAGE_CLIENT_ID, config.CHANNEL_GOOGLE_CLIENT_ID, config.CHANNEL_TIKTOK_CLIENT_KEY, config.CHANNEL_X_CLIENT_ID, config.CHANNEL_PINTEREST_APP_ID, config.CALENDAR_GOOGLE_CLIENT_ID];
    if (oauthApps.some(Boolean) && !appUrl(config).startsWith('https://')) {
      throw new Error('channel OAuth sends authorization codes back to the web app (APP_URL, else PUBLIC_URL); on a public deployment it must be https when a CHANNEL_* or CALENDAR_* app is set');
    }
    if (config.APP_URL !== undefined && !config.APP_URL.startsWith('https://')) {
      throw new Error('APP_URL is where people open the app and every link in mail points at it; a public APP_URL must be https');
    }
    // A browser origin on plain http (a laptop's dev server) is no caller of a public API.
    if (config.CORS_ALLOWED_ORIGINS.some((origin) => !origin.startsWith('https://'))) {
      throw new Error('CORS_ALLOWED_ORIGINS lists an http origin on a public deployment; list https origins only');
    }
    // Browsers send files to, and fetch them from, this endpoint, and it is allowed in the app's CSP connect-src.
    const browserEndpoint = config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT;
    if (presigned && browserEndpoint && new URL(browserEndpoint).protocol !== 'https:') {
      throw new Error(
        `presigned transfers would send files over plain http to ${new URL(browserEndpoint).origin}; set S3_PUBLIC_ENDPOINT to the https URL ` +
          'browsers reach the bucket at, or S3_PRESIGNED_URLS=false',
      );
    }
    const budget = config.AUTH_RATE_LIMIT_EMAIL_SENT;
    if (config.AUTH_UPSTREAM_URL && budget !== undefined && config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR * EMAIL_BUDGET_MIN_CLIENTS > budget) {
      throw new Error(
        `AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR=${config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR} lets ${Math.ceil(budget / config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR)} ` +
          `client addresses use up the email budget (AUTH_RATE_LIMIT_EMAIL_SENT=${budget}); keep it at most ` +
          `${Math.floor(budget / EMAIL_BUDGET_MIN_CLIENTS)}, or raise the budget`,
      );
    }
  }
  // Hosted Supabase refuses requests without the project's publishable key, which would turn every R3 into a 401.
  const live = config.AUTH_SESSION_CHECK === 'jwt' ? liveAuthUrl(config) : null;
  if (live && !config.PUBLIC_AUTH_ANON_KEY && isHostedSupabase(live)) {
    throw new Error('hosted Supabase Auth needs PUBLIC_AUTH_ANON_KEY (the publishable key) for the R3 live check');
  }
  return config;
}

// The domains CHANNEL_ZALO_MEDIA_HOSTS names, in lower case; none when it is unset.
export function zaloMediaHostsOf(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== '');
}

// The extract jobs this worker runs at once: EXTRACT_WORKER_CONCURRENCY, else 4 or the sandbox's slots if fewer (#2119).
export function extractConcurrency(config: Pick<Config, 'EXTRACT_WORKER_CONCURRENCY' | 'EXTRACT_CONCURRENCY'>): number {
  return config.EXTRACT_WORKER_CONCURRENCY ?? Math.min(DEFAULT_EXTRACT_WORKER_CONCURRENCY, config.EXTRACT_CONCURRENCY);
}

// How many client addresses it must take, at least, to use up Supabase Auth's deployment-wide email budget.
export const EMAIL_BUDGET_MIN_CLIENTS = 10;

// Values shipped in docker-compose.yml and .env.example. Fine on localhost, never on a public URL.
const SAMPLE_SECRETS = new Set(['local-only-jwt-secret-change-me-0123456789', 'change-me-to-a-long-random-string-0123456789']);
// Database passwords shipped in docker-compose.yml (the fallbacks) and .env.example. The rule is checked on a public
// PUBLIC_URL when the kernel loads its settings; pilot-check keeps its own list in step (KNOWN_DEFAULTS).
export const SAMPLE_DB_PASSWORDS: ReadonlySet<string> = new Set([
  'local-postgres-password',
  'local-app-password',
  'local-worker-password',
  'local-prober-password',
  'local-reporter-password',
  'local-auth-password',
  'change-me-postgres',
  'change-me-app',
  'change-me-worker',
  'change-me-prober',
  'change-me-reporter',
  'change-me-auth',
]);

// Whether a database URL carries one of those passwords, or any `change-me` placeholder (broader than the shipped
// values on purpose: it is a sample whatever its tail). The password may sit in the userinfo or in a `?password=` query
// parameter, which node-postgres reads too. A value that is not a URL has no password to read here (the connection
// itself fails later). The prober's and the reporter's URLs are read by their own roles; pilot-check fails their
// sample *_PASSWORD settings.
export function hasSampleDbPassword(url: string | undefined): boolean {
  if (url === undefined || !URL.canParse(url)) return false;
  const parsed = new URL(url);
  return [parsed.password, parsed.searchParams.get('password') ?? ''].some((raw) => {
    let password = raw;
    try {
      password = decodeURIComponent(raw);
    } catch {
      // Keep the raw spelling.
    }
    return SAMPLE_DB_PASSWORDS.has(password) || /change-?me/i.test(password);
  });
}

// The context token key the test suites use (vitest.config.ts, vitest.invariant.config.ts): public, so never a
// deployment's.
const SAMPLE_CONTEXT_TOKEN_KEYS = [Buffer.from('test-only-context-token-key-0123456789')];

// Cloudflare's published Turnstile test site keys and secrets (1x00000000000000000000AA, 1x0000000000000000000000000000000AA
// and their 2x and 3x siblings): siteverify passes any token for the always-pass pair, so they are refused on a public URL.
const TURNSTILE_TEST_KEY = /^[123]x0+[A-F]{2}$/;

// Cloudflare R2's S3 API: https://<account>.r2.cloudflarestorage.com (and jurisdiction hosts such as <account>.eu.).
export function isR2Endpoint(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.replace(/\.$/, '').endsWith('.r2.cloudflarestorage.com');
  } catch {
    return false;
  }
}

export function isHostedSupabase(url: string): boolean {
  try {
    // The DNS root's trailing dot names the same host.
    return new URL(url).hostname.replace(/\.$/, '').endsWith('.supabase.co');
  } catch {
    return false;
  }
}

// The api, worker and all roles refuse to start on a public PUBLIC_URL without an export key (issue #212): an org
// export is the whole org in one place and is sealed at rest. Checked when a role starts (createKernel), not in loadConfig, so
// tools and tests that load a public configuration without serving exports keep working.
export function assertExportKey(config: Pick<Config, 'PUBLIC_URL' | 'EXPORT_ENCRYPTION_KEY'>): void {
  if (!isLocalUrl(config.PUBLIC_URL) && !config.EXPORT_ENCRYPTION_KEY) {
    throw new Error('set EXPORT_ENCRYPTION_KEY (32 random bytes, openssl rand -base64 32): org exports hold the whole org and are sealed at rest');
  }
}

// The all role refuses to start on a public PUBLIC_URL unless CROVE_ALLOW_ALL_IN_ONE=true (#2118): the API would run on
// the worker's database login, which enters the system context of every org, and on every secret. A missing
// compose.pilot.yml, or a stray profile, would otherwise do that silently. Run api and worker as two processes
// (docs/runbooks/deploy.md, "The pilot layout"). Checked when a role starts, like the export key above.
//
// The api role holds no worker login at all on a public PUBLIC_URL (#2133): it refuses to start when WORKER_DATABASE_URL is
// set. The pilot layout keeps it out with `!reset` under `extends`, which needs compose 2.24 or newer, and a host file or
// an `env_file` can put it back; the API is the process the internet reaches, and the worker's login enters the system
// context of every org, so the kernel checks it itself and does not rely on how the container was composed.
export function assertSplitRoles(config: Pick<Config, 'PUBLIC_URL' | 'CROVE_ALLOW_ALL_IN_ONE' | 'WORKER_DATABASE_URL'>, role: 'api' | 'worker' | 'all'): void {
  if (role === 'all' && !isLocalUrl(config.PUBLIC_URL) && config.CROVE_ALLOW_ALL_IN_ONE !== 'true') {
    throw new Error(
      'the all role runs the API on the worker database login and every secret; on a public PUBLIC_URL run api and worker as separate processes ' +
        '(docs/runbooks/deploy.md, "The pilot layout"), or set CROVE_ALLOW_ALL_IN_ONE=true to accept that',
    );
  }
  if (role === 'api' && !isLocalUrl(config.PUBLIC_URL) && config.WORKER_DATABASE_URL !== undefined) {
    throw new Error(
      'the api role must not hold WORKER_DATABASE_URL on a public PUBLIC_URL: that login enters the system context of every org, and only the worker needs it; ' +
        'remove it from the api container (docs/runbooks/deploy.md, "The pilot layout")',
    );
  }
}

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return false;
  }
}

// Where people open the web app (#2261): APP_URL in a split deployment, else PUBLIC_URL, which then serves both.
export function appUrl(config: Pick<Config, 'APP_URL' | 'PUBLIC_URL'>): string {
  return config.APP_URL ?? config.PUBLIC_URL;
}

export function publicAuthUrl(config: Config): string {
  return config.PUBLIC_AUTH_URL ?? `${config.PUBLIC_URL.replace(/\/$/, '')}/auth/v1`;
}

// Where the kernel confirms a session live with Supabase Auth (GET /user, ADR-0028 section 5): the bundled Auth
// directly when it is proxied, otherwise the Auth URL the SPA signs in with. null: not configured.
export function liveAuthUrl(config: Config): string | null {
  return config.AUTH_UPSTREAM_URL ?? config.PUBLIC_AUTH_URL ?? null;
}

// The per-org abuse limits (#675) the worker checks, from ORG_LIMIT_*: attachment MB as bytes.
export function usageLimits(config: Config): UsageLimits {
  return {
    inbound_emails: String(config.ORG_LIMIT_INBOUND_EMAILS_PER_DAY),
    attachment_bytes: String(config.ORG_LIMIT_ATTACHMENT_MB_PER_DAY * 1024 * 1024),
    extraction_pages: String(config.ORG_LIMIT_EXTRACTION_PAGES_PER_DAY),
    ai_cost: config.ORG_LIMIT_AI_COST_PER_DAY,
    conversation_emails: String(config.ORG_LIMIT_CONVERSATION_EMAILS_PER_DAY),
  };
}
