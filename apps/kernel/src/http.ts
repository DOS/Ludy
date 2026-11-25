import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type pg from 'pg';
import { schemaMissing } from '@ludy/db/migrate';
import {
  brandSlug,
  ACCEPTED_ARCHIVE_TYPES,
  ACCEPTED_UPLOAD_TYPES,
  AGREEMENT_TYPES,
  DIRECT_UPLOAD_MAX_BYTES,
  HR_BANK_FILE_COLUMNS,
  HR_DECLARATION_KINDS,
  MAX_IMPORT_BYTES,
  MAX_MEETING_AUDIO_BYTES,
  MAX_MEETING_VIDEO_BYTES,
  MAX_SOCIAL_VIDEO_BYTES,
  MAX_SOCIAL_VIDEO_MS,
  MAX_UPLOAD_BYTES,
  ORG_HEADER,
  ROADMAP_VOTER_HEADER,
  SIGN_DEPOSIT_PROOF_MAX_BYTES,
  SIGN_DIRECT_PAGE_PATH,
  SIGN_PAGE_PATH,
  SIGN_PUBLIC_HUB_PAGE_PREFIX,
  SOCIAL_IMAGE_TYPES,
  DEFAULT_EXTENSION_IDS,
  DESKTOP_CLIENT_ID,
  LIVE_CHUNK_MAX_BYTES,
  LIVE_CHUNK_MAX_COUNT,
  LIVE_CHUNK_MAX_SECONDS,
  MEETING_PLATFORM_TRANSCRIPT_MAX_BYTES,
  RECORDING_STOP_REASONS,
  type RecordingStopReason,
  zExtensionAuthorize,
  XLSX_CONTENT_TYPE,
  accountParents,
  type FixedAsset,
  type HrBankFile,
  type HrDeclarationDocument,
  zHrBankFileQuery,
  zSupplierPaymentBankFileQuery,
  type SupplierPaymentBankFile,
  zHrDeclarationDocument,
  type MisaGoodsCode,
  type HouseholdCnkd,
  type HouseholdS1a,
  type HouseholdS2a,
  type HouseholdS2b,
  type HouseholdS2c,
  type HouseholdS2d,
  type HouseholdS2e,
  type StockCard,
  type StockReportRow,
  type UploadPurpose,
  zMeetingTranscriptImport,
} from '@ludy/kernel-contract';
import {
  BlobConflictError,
  BlobIntegrityError,
  BlobNotFoundError,
  BlobTooLargeError,
  DomainError,
  archiveKey,
  EXTENSION_SCOPES,
  fileKey,
  putFile,
  readVerified,
  sha256Hex,
  decryptBlobChunks,
  generateMediaDataKey,
  hasFreshMfa,
  mapPlaintextRangeToChunks,
  plaintextLengthFromCiphertextLength,
  unwrapMediaKeyWithSubkey,
  wrapMediaKeyWithSubkey,
  type BlobMediaBinding,
  type BlobStore,
  type CredentialBroker,
  type ExtensionScope,
  type MediaKeyBinding,
  type Runtime,
  type UserActor,
} from '@ludy/kernel-runtime';
import { ORG_NOT_OFFBOARDING, OWNER_RUN_EXPORT_TABLES, type OrgExportView, type OwnerRunExportTable } from '@ludy/kernel';
import {
  JOURNAL_EXPORT_LIMIT,
  MISA_SME_BANK_CREDIT,
  MISA_SME_BANK_DEBIT,
  MISA_SME_CASH_PAYMENT,
  MISA_SME_CASH_RECEIPT,
  MISA_SME_PURCHASE_GOODS,
  MISA_SME_PURCHASE_SERVICE,
  MISA_SME_SALES,
  buildJournalWorkbook,
  buildLedgerWorkbook,
  buildStatementsWorkbook,
  buildStatementsHtkkXml,
  buildFixedAssetsWorkbook,
  buildStockWorkbook,
  buildCnkdWorkbook,
  buildS1aWorkbook,
  buildS2aWorkbook,
  buildS2bWorkbook,
  buildS2cWorkbook,
  buildS2dWorkbook,
  buildS2eWorkbook,
  buildMisaWorkbook,
  buildSupplierPaymentBankFileWorkbook,
  buildVat01Xml,
  buildVatWorkbook,
  xmlCarryForward,
  cashRows,
  goodsPurchaseRows,
  salesRows,
  servicePurchaseRows,
  type CashVoucher,
  type JournalEntryView,
  type FinancialStatements,
  type StatementsFiling,
  type LedgerBook,
  type PurchaseVoucher,
  type RecordedArchive,
  type SalesVoucher,
  type VatDeclaration,
  type VatReport,
} from '@ludy/mod-finance';
import { readLogoImage, renderQuotePdf, type QuoteDocumentData } from '@ludy/mod-crm';
import { buildBankFileWorkbook, buildDeclarationWorkbook } from '@ludy/mod-hr';
import { readYearArchiveManifest, verifyYearArchive } from './year-archive.ts';
import { hostedLoginTokenOrigin, hostedLoginView } from './auth-hosted-login.ts';
import { oauthSignInView } from './auth-oauth.ts';
import { clientBucket, createDbEmailLimiter, emailSendRequest, type EmailLimiter } from './auth-email-limit.ts';
import {
  createDbInviteChecks,
  createDbRefusalLimiter,
  emailChangeGate,
  emailChangeRefused,
  INVITE_TOKEN_HEADER,
  limitInviteChecks,
  methodRefused,
  signupAllowed,
  signupGate,
  signupInviteToken,
  SignupRefusalsLimited,
  signupRefusalsLimited,
  signupRefused,
  type InviteChecks,
  type RefusalLimiter,
  type SignupRules,
} from './auth-signup-policy.ts';
import { actorOf, bearerIssuedToOAuthClient, oauthClientRefused, type Authenticate, type AuthUser } from './auth.ts';
import { authorizeExtensionRoute, exchangeClientId, exchangeExtensionCode, newExtensionCode, voidUndeliveredExtensionToken, wellFormedExtensionCode, wellFormedVerifier } from './auth-extension.ts';
import { ConcurrencyLimiter, type Semaphore } from './concurrency.ts';
import { onepiece, sealMedia, sizeText, streamPieces } from './media-seal.ts';
import { assembleLivePieces } from './meetings-live-assemble.ts';
import { extractAudioFromVideo, mediaAudioExtractorFor, type MediaAudioExtractor } from './meetings-extract.ts';
import { decryptedWindows, mediaMeasurerFor, unavailable as mediaProbeUnavailable, type MediaMeasurer } from './meetings-measure.ts';
import { MEDIA_TICKET_KEY_LABEL, MEDIA_TICKET_MAX_TTL_SECONDS, MEDIA_TICKET_PURPOSE, peekMediaTicketKeyId, signMediaTicket, verifyMediaTicket, wellFormedMediaTicket } from './media-ticket.ts';
import { BODY_STALL_TIMEOUT_MS } from './upload-timeouts.ts';
import { logEvent, runWithLogContext, setLogContext } from './log.ts';
import { appUrl, publicAuthUrl, type Config } from './config.ts';
import { corsMiddleware } from './cors.ts';
import { exportAad, exportSealer } from './export-seal.ts';
import { streamedBody } from './owner-run-export.ts';
import { MAX_EMAIL_BYTES, acceptInboundEmail, secretMatches } from './inbound.ts';
import { MAX_MAIL_WEBHOOK_BYTES, acceptMailWebhook } from './mail-events.ts';
import { MAX_BANK_FEED_WEBHOOK_BYTES, acceptBankFeedWebhook } from './bank-feed-webhook.ts';
import { BANK_FEED_HOOKS_PER_MINUTE, MAX_BANK_FEED_HOOK_BYTES, acceptBankFeedHook } from './bank-feed-hook.ts';
import { MARKETPLACE_PUSHES_PER_MINUTE, MARKETPLACE_PUSH_ADDRESS_PER_MINUTE, MAX_MARKETPLACE_PUSH_BYTES, acceptMarketplacePush, isMarketplaceHookKey } from './marketplace-push-hook.ts';
import { MAX_MISA_AMIS_CALLBACK_BYTES, acceptMisaAmisCallback } from './misa-amis-callback.ts';
import type { AmisCallbackKey } from '@ludy/misa-amis';
import { FACEBOOK_MAX_NOTICE_BYTES, TELEGRAM_MAX_NOTICE_BYTES, WHATSAPP_MAX_NOTICE_BYTES, ZALO_MAX_NOTICE_BYTES } from '@ludy/channel';
import { ZALO_SIGNATURE_HEADER, ZALO_WEBHOOK_PATH, ZaloReplayCache, acceptZaloWebhook, type ZaloWebhookConfig } from './zalo-webhook.ts';
import { ZOOM_MAX_NOTICE_BYTES, ZOOM_SIGNATURE_HEADER, ZOOM_TIMESTAMP_HEADER, ZOOM_WEBHOOK_PATH, ZoomReplayCache, acceptZoomWebhook, type ZoomWebhookConfig } from './zoom-webhook.ts';
import { TELEGRAM_SECRET_HEADER, TELEGRAM_WEBHOOK_PATH, TELEGRAM_UNAUTHORIZED, TelegramReplayCache, acceptTelegramWebhook, telegramWebhookAuthorized, type TelegramWebhookConfig } from './telegram-webhook.ts';
import { FACEBOOK_SIGNATURE_HEADER, FACEBOOK_WEBHOOK_PATH, FacebookReplayCache, acceptFacebookWebhook, verifyFacebookWebhookChallenge, type FacebookWebhookConfig } from './facebook-webhook.ts';
import { WHATSAPP_SIGNATURE_HEADER, WHATSAPP_WEBHOOK_PATH, WhatsAppReplayCache, acceptWhatsAppWebhook, verifyWhatsAppWebhookChallenge, type WhatsAppWebhookConfig } from './whatsapp-webhook.ts';
import { ADS_DELETION_PATH, MAX_ADS_DELETION_BYTES } from './ads-deletion.ts';
import { acceptMetaDeletion, metaDeletionStatus, renderMetaDeletionStatus } from './meta-deletion.ts';
import type { BankFeedProvider } from '@ludy/bank-feed';
import { createInviteMailSender } from './invite-mail.ts';
import { createCredentialBroker } from './credentials.ts';
import { pgBossSchemaVersion } from './jobs-schema.ts';
import type { MailProvider } from './mail.ts';
import { RateLimiter } from './rate-limit.ts';
import { DraftBudget } from './ai-draft-limit.ts';
import { mountMcp, mountOauthProvider } from './mcp-endpoint.ts';
import type { OauthServer } from './oauth-server.ts';
import { reviewAnswer, reviewFile, reviewMedia, reviewView, REVIEW_ANSWERS_PER_MINUTE, REVIEW_FILES_PER_MINUTE, REVIEW_VIEWS_PER_MINUTE } from './review-link.ts';
import { minutesView, MINUTES_VIEWS_PER_MINUTE } from './minutes-link.ts';
import { quoteLogo, quoteView, readLogoFile, QUOTE_LOGO_READS_MAX, QUOTE_VIEWS_PER_MINUTE } from './quote-link.ts';
import { reportView, REPORT_VIEWS_PER_MINUTE } from './report-link.ts';
import {
  SIGN_DIRECT_EMAIL_OTP_REQUESTS_PER_MINUTE,
  SIGN_DIRECT_OTP_REQUESTS_PER_MINUTE,
  SIGN_DIRECT_OTP_VERIFIES_PER_MINUTE,
  SIGN_DIRECT_PDFS_PER_MINUTE,
  SIGN_DIRECT_STARTS_PER_MINUTE,
  SIGN_DIRECT_TOKEN_OTP_REQUESTS_PER_MINUTE,
  SIGN_DIRECT_TOKEN_OTP_VERIFIES_PER_MINUTE,
  SIGN_DIRECT_TOKEN_PDFS_PER_MINUTE,
  SIGN_DIRECT_TOKEN_STARTS_PER_MINUTE,
  SIGN_DIRECT_TOKEN_VIEWS_PER_MINUTE,
  SIGN_DIRECT_VIEWS_PER_MINUTE,
  resolvePublicDirectPdf,
  runSignDirectOtpRequest,
  runSignDirectOtpVerify,
  runSignDirectStart,
  runSignDirectView,
} from './sign-direct-link.ts';
import {
  SIGN_PUBLIC_HUB_ACTIONS_PER_MINUTE,
  SIGN_PUBLIC_HUB_EMAIL_OTP_REQUESTS_PER_MINUTE,
  SIGN_PUBLIC_HUB_LISTS_PER_MINUTE,
  SIGN_PUBLIC_HUB_TEMPLATE_ACTIONS_PER_MINUTE,
  resolvePublicHubPdf,
  runSignPublicHubAction,
  runSignPublicHubList,
} from './sign-public-hub.ts';
import {
  SIGN_API_V1_IP_PER_MINUTE,
  SIGN_API_V1_KEY_DRAFT_PER_MINUTE,
  SIGN_API_V1_KEY_READ_PER_MINUTE,
  readSignApiV1ArtifactBytes,
  resolveSignApiV1FileSource,
  runSignApiV1EnvelopeGet,
  runSignApiV1EnvelopesList,
  runSignApiV1FromTemplate,
  runSignApiV1TemplatesList,
  type SignApiV1Outcome,
} from './sign-api-v1.ts';
import {
  ROADMAP_PUBLIC_IDEAS_PER_MINUTE,
  ROADMAP_PUBLIC_OTP_EMAIL_REQUESTS_PER_MINUTE,
  ROADMAP_PUBLIC_OTP_REQUESTS_PER_MINUTE,
  ROADMAP_PUBLIC_OTP_VERIFIES_PER_MINUTE,
  ROADMAP_PUBLIC_VIEWS_PER_MINUTE,
  ROADMAP_PUBLIC_VOTES_PER_MINUTE,
  deriveRoadmapClaimKey,
  matchPublicRoadmapPagePath,
  resolveRoadmapEmbedFrameAncestors,
  runPublicRoadmapOtpRequest,
  runPublicRoadmapOtpVerify,
  runPublicRoadmapSubmitIdea,
  runPublicRoadmapView,
  runPublicRoadmapVote,
  verifyRoadmapVoterClaim,
} from './projects-public-roadmap.ts';
import {
  SIGN_ATTACHMENT_MAX_BYTES,
  SIGN_ATTACHMENT_UPLOADS_MAX,
  SIGN_ATTACHMENTS_PER_MINUTE,
  SIGN_DELEGATES_PER_MINUTE,
  SIGN_DEPOSIT_NOTICE_PER_MINUTE,
  SIGN_DEPOSIT_NOTICE_UPLOADS_MAX,
  SIGN_DEPOSIT_QR_PER_MINUTE,
  SIGN_OTP_REQUESTS_PER_MINUTE,
  SIGN_OTP_VERIFIES_PER_MINUTE,
  SIGN_PDF_READS_MAX,
  SIGN_PDFS_PER_MINUTE,
  SIGN_SUBMITS_PER_MINUTE,
  SIGN_TOKEN_ATTACHMENTS_PER_MINUTE,
  SIGN_TOKEN_DELEGATES_PER_MINUTE,
  SIGN_TOKEN_DEPOSIT_NOTICE_PER_MINUTE,
  SIGN_TOKEN_DEPOSIT_QR_PER_MINUTE,
  SIGN_TOKEN_OTP_REQUESTS_PER_MINUTE,
  SIGN_TOKEN_OTP_VERIFIES_PER_MINUTE,
  SIGN_TOKEN_PDFS_PER_MINUTE,
  SIGN_TOKEN_SUBMITS_PER_MINUTE,
  SIGN_TOKEN_VIEWS_PER_MINUTE,
  SIGN_VERIFY_PER_MINUTE,
  SIGN_VIEWS_PER_MINUTE,
  readPublicDepositQrBytes,
  readPublicPdfBytes,
  resolvePublicDepositQr,
  resolvePublicPdf,
  runSignAttachmentUpload,
  runSignDecline,
  runSignDelegate,
  runSignDepositNotice,
  runSignOtpRequest,
  runSignOtpVerify,
  runSignSubmit,
  runSignVerify,
  runSignView,
  type SignBilling,
} from './sign-link.ts';
import { bookingFeed, renderBookingFeedIcs } from './booking-feed.ts';
import { CALENDAR_FEED_HITS_PER_MINUTE, calendarFeed, renderIcs } from './calendar-feed.ts';
import { BIO_HITS_PER_MINUTE, BIO_PAGE_CSP, bioGo, bioImage, bioView, renderBioPage } from './bio-page.ts';
import { createTurnstileVerifier, type TurnstileVerifier } from './turnstile.ts';
import {
  BOOKING_POLLS_PER_MINUTE,
  BOOKING_REQUESTS_PER_MINUTE,
  BOOKING_VIEWS_PER_MINUTE,
  bookingManageAsk,
  bookingManageView,
  bookingRequest,
  bookingStatus,
  bookingView,
} from './booking-page.ts';
import { STATUS_PAGE_CSP, readStatusFile, renderStatusPage, statusView, type ProbeStatus } from './status-page.ts';
import { AUTH_MAIL_TEMPLATE_CSP, AUTH_MAIL_TEMPLATE_ROUTE, renderAuthMailTemplate } from './auth-mail-templates.ts';
import { WEB_MANIFEST_PATH, brandedManifest } from './web-manifest.ts';
import { opsAlert } from './ops-alert.ts';
import { shortLinkTarget, SHORT_LINK_HITS_PER_MINUTE } from './short-link.ts';
import { ORG_SLUG, attachmentDisposition } from './attachment.ts';
import { withAiScope, type AiMeter } from '@ludy/agent';
import { handleHrCvExtractPoll, handleHrCvExtractUpload } from './hr-cv-http.ts';
import { handleSignDocxConvertPoll, handleSignDocxConvertUpload } from './sign-docx-http.ts';
import type { ModelPort } from './member-vy-ports.ts';
import type { SignAi } from './sign-ai.ts';
import { createRpcHandler, resolveMembership, resolveOrg, type BookingReader, type RpcChannels, type SocialDrafter } from './rpc.ts';
import type { ConversationReader } from './conversations-ai.ts';
import type { TaxCodeLookup } from './tax-lookup.ts';
import type { PortalSync } from './portal-sync.ts';
import { hasVideoTrack, imageSize, sniffVideo, videoDurationMs, type ImageSize } from './media-probe.ts';
import { safeFilename, sniffType } from './sniff.ts';
import { sniffConversationImage } from './conversation-media.ts';
import { handleNoteAttachmentDownload, handleNoteAttachmentUpload } from './note-attachments.ts';
import { handleEnexImportUpload, handleTodoistImportUpload } from './note-imports.ts';
import { directTransferOrigin } from './storage.ts';
import {
  MAX_BUFFERED_BYTES,
  MAX_STREAM_LIFETIME_MS,
  STREAM_CHECK_QUERY,
  STREAM_TICKET_TTL_SECONDS,
  StreamConnection,
  newTicket,
  streamScopeOf,
  STREAM_FILTERED_APPS,
  ticketActor,
  ticketHash,
  wellFormedTicket,
  type StreamHub,
  type StreamScope,
  type TicketBinding,
  type TicketStore,
} from './stream.ts';

// Exchanges of a one-time extension code for a token per minute per client address (#2582): a person signs in a few times.
const EXTENSION_TOKEN_EXCHANGES_PER_MINUTE = 10;
// Requests with an extension token per minute per client address, taken before the token is looked up: a flood of random
// well-formed tokens must not cost a database round trip each. One browser makes a few requests while recording.
const EXTENSION_BEARER_PER_MINUTE = 600;
// Extension bearer write requests per minute per token (#3742): bounds Quick Capture, Web Clipper, and meeting
// capture/upload writes per token independently of the general /api per-user budget.
const EXTENSION_WRITES_PER_MINUTE = 30;

// A uuid in text form, any case.
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HttpDeps {
  config: Config;
  // The MCP endpoint's authorization server (ADR-0051, #2975), made when OAUTH_SERVER=on: its routes and POST /mcp exist only then.
  oauth?: OauthServer;
  // /readyz fails while a live worker runs a build older than this one (#1952, plan §3.5); off for the "all" process.
  workerBuildCheck?: boolean;
  runtime: Runtime;
  store: BlobStore;
  broker?: CredentialBroker;
  // Measures the length of meeting media in crove-media (#2985). Unset: made from config.MEDIA_URL (none when that is unset too).
  mediaMeasurer?: MediaMeasurer;
  // Takes the audio out of a video uploaded as a meeting's audio (#3337); none without MEDIA_URL.
  mediaExtractor?: MediaAudioExtractor;
  authenticate: Authenticate;
  pool: pg.Pool;
  aiEnabled: boolean;
  // Outbound mail for invites (issue #129). Unset: off, and the inviter passes the one-time link on.
  mailer?: MailProvider;
  // Refused requests per minute per client address on POST /webhooks/mail/:provider (counted on 400/401, peeked before bodyLimit).
  mailWebhookLimit?: RateLimiter;
  // The bank feed adapters that take signed notices, by provider id (ADR-0039): POST /api/bank-feed/<id>/webhook exists
  // for these alone, with finance installed.
  bankFeedWebhooks?: Readonly<Record<string, BankFeedProvider>>;
  // Notices per minute per client address; one is checked and queued per call.
  bankFeedWebhookLimit?: RateLimiter;
  // The bank feed adapters whose provider signs notices with each customer's own secret (Tingee, #4203): POST /api/bank-feed/<id>/webhook/<hookKey> exists for these alone, with finance installed. The address carries a key of one
  // connection (only its SHA-256 is stored); the API stores the raw notice and the worker verifies it with the connection's sealed secret.
  bankFeedHooks?: Readonly<Record<string, BankFeedProvider>>;
  // Requests per minute per client address, checked before the body is read, and notices per minute per hook, checked once the hook is found.
  bankFeedHookLimit?: RateLimiter;
  bankFeedHookBudget?: RateLimiter;
  // The marketplaces whose push (webhook) the route takes (TikTok Shop, Shopee, Lazada; #4346, S2 of #4315): POST /api/marketplace/<adapter>/webhook/<hookKey> exists for these alone, with finance installed, and only where
  // the deployment runs the adapter (MARKETPLACE_PROVIDERS) and holds a credential broker (the worker's relay opens the connection's secret). Unset or empty: the route does not exist.
  marketplacePush?: { adapters: readonly string[]; limit?: RateLimiter; budget?: RateLimiter };
  // MISA AMIS's callback with the result of a save (#3903): the route exists only where the deployment holds the ClientID (the HMAC key of the signature); without it the path is not served.
  // The HMAC keys of the callback's signature: one ClientID (MISA AMIS's), or one per product the deployment holds (MISA AMIS and MISA ASP, #4103), tried all, never told apart.
  misaAmisCallback?: { clientId: string } | { keys: readonly AmisCallbackKey[] };
  misaAmisCallbackLimit?: RateLimiter;
  // Zalo OA's webhook for the conversation core (#2304): the app id and the OA secret key that sign its notices. Unset: the route does
  // not exist.
  zaloWebhook?: ZaloWebhookConfig;
  // Notices per minute per client address for that route.
  zaloWebhookLimit?: RateLimiter;
  // The events that route has parked lately (replay guard); unset: its own, one per process.
  zaloReplays?: ZaloReplayCache;
  // Zoom's webhook for the recording import (meetings integrations C3, #3175): the app's secret token that signs its notices. Unset, or the Meetings module off: the route does not exist.
  zoomWebhook?: ZoomWebhookConfig;
  // Refused or unsigned requests per minute per client address for that route.
  zoomWebhookLimit?: RateLimiter;
  // The notices that route has answered lately (replay guard); unset: its own, one per process.
  zoomReplays?: ZoomReplayCache;
  // Telegram's webhook for the conversation core (#3132): the keys the per-connection secret is derived from. Unset: the route does not exist.
  telegramWebhook?: TelegramWebhookConfig;
  // Refused requests per minute per client address for that route.
  telegramWebhookLimit?: RateLimiter;
  // Verified updates per minute per hook (a flood on a public bot).
  telegramHookLimit?: RateLimiter;
  // The messages that route has parked lately (replay guard); unset: its own, one per process.
  telegramReplays?: TelegramReplayCache;
  // Meta Page webhook for the conversation core (CV2, #2307): the app secret and verify token that guard it. Unset: the route does not exist.
  facebookWebhook?: FacebookWebhookConfig;
  // Refused requests per minute per client address for that route.
  facebookWebhookLimit?: RateLimiter;
  // The comment events that route has parked lately (replay guard); unset: its own, one per process.
  facebookReplays?: FacebookReplayCache;
  // WhatsApp Business webhook for the conversation core (#3131): the app secret and verify token of the WhatsApp product's Meta app. Unset: the route does not exist.
  whatsappWebhook?: WhatsAppWebhookConfig;
  // Refused requests per minute per client address for that route.
  whatsappWebhookLimit?: RateLimiter;
  // The events that route has parked lately (replay guard); unset: its own, one per process.
  whatsappReplays?: WhatsAppReplayCache;
  // Meta's data deletion callback for the Ads connection (plan section 9, #2219): the app secret that signs the request. Unset
  // (no Meta ads app configured): the route does not exist. With ads installed only.
  adsDeletion?: { appSecret: string };
  // The app that runs ads (the write connection's), when it is set (#2366): the same callback also verifies a request signed by it, and a
  // person's write grant is found by the hash keyed with its secret. With ads installed only.
  adsWriteDeletion?: { appSecret: string };
  // The Pages app's secret for the conversations of the Facebook Pages and Instagram accounts, answered by the same callback (CV6, #2305).
  conversationsDeletion?: { appSecret: string; instagramAppSecret?: string };
  // Requests per minute per client address for that callback and its status page.
  adsDeletionLimit?: RateLimiter;
  // Per-client budget for Supabase Auth's emails (#190). Unset: the database limiter on `pool`.
  emailLimiter?: EmailLimiter;
  // The member invite checks for AUTH_SIGNUP_POLICY (#350, #563). Unset: the database checks on `pool`.
  signupInviteChecks?: InviteChecks;
  // The cap on sign-up refusals that tell who holds an invite (#564). Unset: the database limiter on `pool`.
  signupRefusalLimiter?: RefusalLimiter;
  // Per-user request limit on /api (issue #162). Default: built from API_RATE_LIMIT_PER_MINUTE; null turns it off.
  rateLimiter?: RateLimiter | null;
  // Per-client budgets of the public review page (#589). Unset: REVIEW_VIEWS_PER_MINUTE and REVIEW_ANSWERS_PER_MINUTE.
  reviewLimits?: { views: RateLimiter; answers: RateLimiter; files?: RateLimiter };
  // The public report page's budget per client (#643). Unset: REPORT_VIEWS_PER_MINUTE.
  reportLimit?: RateLimiter;
  // The public quote page's budget per client (#2694). Unset: QUOTE_VIEWS_PER_MINUTE.
  quoteLimit?: RateLimiter;
  // The public minutes page's budget per client (#4822), apart from the quote page's. Unset: MINUTES_VIEWS_PER_MINUTE.
  minutesLimit?: RateLimiter;
  // The public quote page's logo budget per client (#2814), apart from the page's. Unset: QUOTE_VIEWS_PER_MINUTE.
  quoteLogoLimit?: RateLimiter;
  // How many logo reads (a stored file read whole into memory) run at once in this process, across every client (#2814). Unset: QUOTE_LOGO_READS_MAX.
  quoteLogoReads?: ConcurrencyLimiter;
  // Plan entitlements lookup used to fail closed on disabled or un-entitled modules on public edge routes (#3324).
  billing?: SignBilling;
  // Per-client, per-token-hash, and bounded PDF read concurrency limiters for public eSign routes (#3324).
  signLimits?: Partial<{
    views: RateLimiter;
    tokenViews: RateLimiter;
    pdfs: RateLimiter;
    tokenPdfs: RateLimiter;
    pdfReads: ConcurrencyLimiter;
    otpRequest: RateLimiter;
    tokenOtpRequest: RateLimiter;
    otpVerify: RateLimiter;
    tokenOtpVerify: RateLimiter;
    submit: RateLimiter;
    tokenSubmit: RateLimiter;
    delegate: RateLimiter;
    tokenDelegate: RateLimiter;
    attachment: RateLimiter;
    tokenAttachment: RateLimiter;
    attachmentUploads: ConcurrencyLimiter;
    depositQr: RateLimiter;
    tokenDepositQr: RateLimiter;
    depositNotice: RateLimiter;
    tokenDepositNotice: RateLimiter;
    depositNoticeUploads: ConcurrencyLimiter;
    verify: RateLimiter;
  }>;
  // Per-client and per-token/email rate limiters for public direct signing routes (#3551).
  signDirectLimits?: Partial<{
    views: RateLimiter;
    tokenViews: RateLimiter;
    pdfs: RateLimiter;
    tokenPdfs: RateLimiter;
    otpRequest: RateLimiter;
    tokenOtpRequest: RateLimiter;
    emailOtpRequest: RateLimiter;
    otpVerify: RateLimiter;
    tokenOtpVerify: RateLimiter;
    start: RateLimiter;
    tokenStart: RateLimiter;
  }>;
  // Per-client and per-template/email rate limiters for the public self-service template hub (#3820).
  signPublicHubLimits?: Partial<{
    lists: RateLimiter;
    actions: RateLimiter;
    templateActions: RateLimiter;
    emailOtpRequest: RateLimiter;
  }>;
  // Per-client, per-key-hash, and download concurrency limiters for external /api/v1/sign/* API routes (#4441).
  signApiV1Limits?: Partial<{
    ip: RateLimiter;
    keyRead: RateLimiter;
    keyDraft: RateLimiter;
    pdfReads: ConcurrencyLimiter;
  }>;
  // Per-client and per-email rate limiters for Projects Public Roadmap public routes (#4399).
  roadmapLimits?: Partial<{
    views: RateLimiter;
    otpRequest: RateLimiter;
    emailOtpRequest: RateLimiter;
    otpVerify: RateLimiter;
    ideas: RateLimiter;
    votes: RateLimiter;
  }>;
  // The posting calendar feed's budget per client (#862). Unset: CALENDAR_FEED_HITS_PER_MINUTE.
  calendarFeedLimit?: RateLimiter;
  // The per-client budget of link-in-bio pages, their links and images (#707), replaceable in tests.
  bioLimit?: RateLimiter;
  // The public booking page (#1318): page reads, requests per address, and requests per event type.
  bookingLimits?: { views: RateLimiter; requests: RateLimiter; perType: RateLimiter; polls: RateLimiter };
  // Checks a booking request's Turnstile token (#1353); unset, built from TURNSTILE_SECRET when the deployment sets it.
  turnstile?: TurnstileVerifier | null;
  // The per-client budget of short link redirects (#706), replaceable in tests.
  shortLinkLimit?: RateLimiter;
  // Exchanges of a one-time code for an extension token per minute per client address (#2582), replaceable in tests.
  extensionTokenLimit?: RateLimiter;
  // Requests per minute per client address that carry an extension token, counted before the token is looked up.
  extensionBearerLimit?: RateLimiter;
  // Write requests per minute per extension token (#3742); null turns it off. Default: EXTENSION_WRITES_PER_MINUTE.
  extensionWriteLimit?: RateLimiter | null;
  // Staged upload completions running at once in this process (issue #223). Default: UPLOAD_COMPLETE_CONCURRENCY.
  uploadCompletes?: ConcurrencyLimiter;
  // Uploads that may be larger than MAX_UPLOAD_BYTES (Social videos, #409) running at once. Default: 2 per process.
  largeUploads?: ConcurrencyLimiter;
  // Meeting video uploads (up to 2 GB held in memory): one per process at a time.
  videoUploads?: ConcurrencyLimiter;
  // How long a raw meeting upload may go without receiving a byte before it is cancelled (tests shorten it).
  mediaStallMs?: number;
  // Refused meeting video tickets per client address (#2703). Default: STREAM_REDEEM_FAILURES_PER_MINUTE.
  videoTicketFailures?: RateLimiter;
  // Meeting video responses being read at once, per user (#2703). Default: VIDEO_STREAMS_PER_USER each, MEETINGS_VIDEO_STREAMS_MAX in all.
  videoStreams?: ConcurrencyLimiter;
  // Every other POST /api/files running at once (#432): each holds its body (up to MAX_FILES_PER_UPLOAD files, about
  // 26 MB) in memory. Default: twice UPLOAD_COMPLETE_CONCURRENCY, and half of that for one user.
  directUploads?: ConcurrencyLimiter;
  // Exports of the books (GET /api/export/*) building at once in this process (#2121). Default: EXPORT_CONCURRENCY, and
  // two of them for one user.
  exports?: ConcurrencyLimiter;
  // Channel connections (ADR-0025): the broker that seals tokens, and whether the sandbox channel is on. Unset: no
  // channel can be connected through the API.
  channels?: RpcChannels;
  // The AI budget meter of an API request's model calls, as the member who made it (#2382). Unset (tests with fake
  // writers): a call to the real model is refused, since the agent package sends none unmetered.
  aiMeter?: (actor: UserActor) => AiMeter;
  // Drafts Social posts with the deployment's model (Social plan S7); unset: AI drafting answers 503.
  socialWriter?: SocialDrafter;
  // Reads a client's message for booking suggestions (#1440); unset: suggestions give the next free slots only.
  bookingReader?: BookingReader;
  // The Inbox's suggested intent and likely contacts (CV3, #2306); unset: no suggestion.
  conversationReader?: ConversationReader;
  // The recorder's Vy summarizing a meeting (#2580, M6 part B2); unset: the summary is off.
  summaryModel?: ModelPort | null;
  // Vy's eSign field placement and risky clause review (#3351); unset: manual signing with AI off.
  signAi?: SignAi['reader'];
  // The deployment's AI prices (AI_PRICE_*), for the cost a translation shows before the click (#3184); unset: no figure.
  aiPrice?: { inputPerMTok: string; outputPerMTok: string };
  // The public tax registry lookup for onboarding (issue #324); unset: off (TAX_CODE_LOOKUP_URL).
  taxLookup?: TaxCodeLookup;
  // The assisted purchase-invoice sync from the tax portal (issue #325); unset: off (TAX_PORTAL_SYNC).
  portalSync?: PortalSync;
  // Realtime invalidation (issue #69). Unset: /api/stream answers 404 and the app keeps polling.
  stream?: StreamDeps;
  // Optional wait timeout in ms for worker-side CV PDF/DOCX extraction before returning 202 pending (#4446).
  hrCvWaitMs?: number;
  // Optional wait timeout in ms for worker-side eSign .docx -> PDF conversion before returning 202 pending (#4721).
  signDocxWaitMs?: number;
}

export interface StreamDeps {
  hub: StreamHub;
  tickets: TicketStore;
  // Open streams in this process, and per user (STREAM_MAX_CONNECTIONS, STREAM_MAX_PER_USER).
  slots: ConcurrencyLimiter;
  recheckSeconds: number;
  // Background re-checks running at once in this process (STREAM_RECHECK_CONCURRENCY). Unset: unbounded.
  rechecks?: Semaphore;
  // Failed ticket redeems per client address (issue #281). Default: STREAM_REDEEM_FAILURES_PER_MINUTE.
  redeemFailures?: RateLimiter;
  // Ticket redeems in flight in this process. Default: STREAM_REDEEMS_IN_FLIGHT.
  redeems?: ConcurrencyLimiter;
}

// What a refused stream tells the client to wait before it tries again (it polls meanwhile).
export const STREAM_RETRY_SECONDS = 15;
// GET /api/stream redeems its ticket before any user is known, so the redeem is capped by client address instead
// (issue #281). Only failures count: the SPA redeems each fresh ticket once, so a client that keeps presenting unknown,
// spent or expired tickets is probing, and is refused (429) before the database is asked. Per process, like the
// request rate limit; with TRUSTED_PROXY_HOPS unset behind a reverse proxy every client shares the proxy's address and
// so this budget. The budget is peeked before and spent after the redeem, so one burst of concurrent failures may pass
// it by up to the per-address in-flight cap. The in-flight cap bounds the database work of many addresses at once (503 STREAM_BUSY past it), and
// one address may hold only a quarter of it.
export const STREAM_REDEEM_FAILURES_PER_MINUTE = 20;
// Meeting video responses one user may be reading at once through a ticket (#2703): a player opens a few ranges together.
export const VIDEO_STREAMS_PER_USER = 3;
const VIDEO_STREAMS_RETRY_SECONDS = 2;
export const STREAM_REDEEMS_IN_FLIGHT = 32;
export const STREAM_REDEEMS_IN_FLIGHT_PER_CLIENT = 8;

// Store errors that are not server faults. A blob missing behind a file row, or a key holding other bytes, is
// still logged: either one means storage and database disagree. Other store errors (access, I/O) stay 500.
function storeProblem(error: unknown): DomainError | null {
  if (error instanceof BlobNotFoundError) return new DomainError('NOT_FOUND', 404, 'Không tìm thấy tệp');
  if (error instanceof BlobConflictError) return new DomainError('CONFLICT', 409, 'Tệp đã tồn tại với nội dung khác');
  if (error instanceof BlobTooLargeError) return new DomainError('TOO_LARGE', 413, 'Tệp vượt quá 25 MB');
  // The stored object is not the one the file row recorded (red-team S25). Never served; an operator investigates.
  if (error instanceof BlobIntegrityError) return new DomainError('BLOB_INTEGRITY', 500, 'Tệp lưu trữ không khớp với bản đã ghi nhận; đã chặn tải về');
  return null;
}

function problem(c: Context, error: unknown) {
  const store = storeProblem(error);
  const domain = error instanceof DomainError ? error : (store ?? new DomainError('INTERNAL', 500, 'Lỗi hệ thống'));
  // The file's key holds its content hash: in the log (with the error), never in the posted line.
  if (error instanceof BlobIntegrityError) opsAlert('[http] ALERT evidence integrity: a stored file does not match its recorded sha256', error);
  else if (domain.status === 500 || store) console.error('[http]', error);
  return c.json({ code: domain.code, message: domain.message }, domain.status);
}

// The bytes as a one-chunk stream that calls release once the chunk is taken or the stream is cancelled, and after five
// minutes at the latest, so a connection that neither reads nor closes cannot keep a slot for good.
function held(bytes: Uint8Array, release: () => void): ReadableStream<Uint8Array> {
  setTimeout(release, 5 * 60_000).unref();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes);
      controller.close();
      release();
    },
    cancel() {
      release();
    },
  });
}

function body(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const PDF_STREAM_LEASE_MS = 60_000;

interface OutgoingResponseTarget {
  readonly writableFinished?: boolean;
  readonly closed?: boolean;
  readonly destroyed?: boolean;
  on?: (event: string, listener: () => void) => unknown;
  once?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
  addEventListener?: (event: string, listener: () => void) => unknown;
  removeEventListener?: (event: string, listener: () => void) => unknown;
}

// Keep PDF read pool slots held until Node finishes flushing or closes the socket (or until the in-memory Web
// stream finishes/cancels when no Node outgoing response is attached), bounded by a 60-second lease timer (#4682).
export function releaseOnResponseClose(bytes: Uint8Array, release: () => void, c?: Context): ReadableStream<Uint8Array> {
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let detachListeners: (() => void) | undefined;

  const finish = () => {
    if (released) return;
    released = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    detachListeners?.();
    detachListeners = undefined;
    release();
  };

  const outgoing = (c?.env as { outgoing?: OutgoingResponseTarget } | undefined)?.outgoing;
  const signal = c?.req?.raw?.signal;
  let hasOutgoing = false;

  if (signal?.aborted || outgoing?.writableFinished || outgoing?.closed || outgoing?.destroyed) {
    finish();
  } else {
    const cleanups: Array<() => void> = [];
    detachListeners = () => {
      for (const cleanup of cleanups) cleanup();
    };

    if (outgoing && typeof outgoing === 'object') {
      const attach =
        typeof outgoing.on === 'function'
          ? (evt: 'finish' | 'close') => outgoing.on!(evt, finish)
          : typeof outgoing.once === 'function'
            ? (evt: 'finish' | 'close') => outgoing.once!(evt, finish)
            : typeof outgoing.addEventListener === 'function'
              ? (evt: 'finish' | 'close') => outgoing.addEventListener!(evt, finish)
              : null;
      if (attach) {
        hasOutgoing = true;
        cleanups.push(() => {
          const detach =
            typeof outgoing.off === 'function'
              ? (evt: 'finish' | 'close') => outgoing.off!(evt, finish)
              : typeof outgoing.removeListener === 'function'
                ? (evt: 'finish' | 'close') => outgoing.removeListener!(evt, finish)
                : typeof outgoing.removeEventListener === 'function'
                  ? (evt: 'finish' | 'close') => outgoing.removeEventListener!(evt, finish)
                  : null;
          if (detach) {
            detach('finish');
            detach('close');
          }
        });
        attach('finish');
        if (!released) attach('close');
      }
    }

    if (signal && !released) {
      cleanups.push(() => {
        signal.removeEventListener('abort', finish);
      });
      signal.addEventListener('abort', finish, { once: true });
    }

    if (!released) {
      timer = setTimeout(finish, PDF_STREAM_LEASE_MS);
      timer.unref?.();
    }
  }

  let sent = false;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(bytes);
          return;
        }
        controller.close();
        if (!hasOutgoing) {
          finish();
        }
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: 0 },
  );
}

// The shape Supabase Auth uses for its own email limit, so the SPA (auth-js) reads the same error code.
function emailRateLimited(retryAfterSeconds: number): Response {
  const error = { code: 429, error_code: 'over_email_send_rate_limit', msg: 'Đã gửi quá nhiều email; vui lòng thử lại sau' };
  return new Response(JSON.stringify(error), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
  });
}

// A token Supabase Auth issued to an OAuth client, refused before it reaches Supabase Auth (issue #277). Same code as
// the kernel's verifier, in Supabase Auth's error shape like `emailRateLimited`, so auth-js reads it as `error.code`.
function oauthClientTokenRefused(): Response {
  const refused = oauthClientRefused();
  const error = { code: refused.status, error_code: refused.code, msg: refused.message };
  return new Response(JSON.stringify(error), { status: refused.status, headers: { 'content-type': 'application/json' } });
}

// With TRUSTED_PROXY_HOPS=0 behind a reverse proxy, every client shares the proxy's address and so one email budget,
// one budget of sign-up refusals and one budget of failed stream ticket redeems.
let proxyWarned = false;
function warnIfUntrustedProxy(c: Context, trustedHops: number): void {
  if (proxyWarned || trustedHops > 0 || !c.req.header('x-forwarded-for')) return;
  proxyWarned = true;
  console.warn(
    '[http] requests carry X-Forwarded-For but TRUSTED_PROXY_HOPS=0: behind a reverse proxy every client shares its address, and so one email budget, one budget of sign-up refusals and one budget of failed stream ticket redeems; set TRUSTED_PROXY_HOPS',
  );
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
]);

// Copies headers except hop-by-hop ones, including any the Connection header names.
function forwardable(source: Headers, extraDrop: ReadonlySet<string> = new Set()): Headers {
  const named = new Set(
    (source.get('connection') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
  const out = new Headers();
  source.forEach((value, key) => {
    const name = key.toLowerCase();
    if (!HOP_BY_HOP.has(name) && !named.has(name) && !extraDrop.has(name)) out.set(key, value);
  });
  return out;
}
// Client-supplied forwarding headers are dropped; the proxy sets X-Real-IP from the socket instead. Supabase Auth keys
// its rate limits on X-Real-IP, or on Sb-Forwarded-For when GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED is on (#34).
const SPOOFABLE = new Set([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-client-ip',
  'sb-forwarded-for',
]);
// Dropped from every request the auth proxy forwards: the forwarding headers above, and the invite token a sign-up
// carries for the sign-up policy (#563), which is the proxy's to read and none of Supabase Auth's business.
const RECIPIENT_HEADER = 'x-ludy-recipient';
const RETIRED_RECIPIENT_HEADER = 'x-crove-recipient';
const RETIRED_INVITE_HEADER = 'x-crove-invite';

function normalizeHeaderValue(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function readOrgHeader(c: Context): string | null {
  return normalizeHeaderValue(c.req.header(ORG_HEADER));
}

function readInviteHeader(c: Context): string | undefined {
  return normalizeHeaderValue(c.req.header(INVITE_TOKEN_HEADER)) ?? undefined;
}

function readRecipientHeader(c: Context): string | null {
  const primary = normalizeHeaderValue(c.req.header(RECIPIENT_HEADER));
  if (primary !== null) return primary;
  if (normalizeHeaderValue(c.req.header(RETIRED_RECIPIENT_HEADER)) !== null) {
    throw new DomainError('LEGACY_RECIPIENT_HEADER', 400, 'Header x-crove-recipient has been retired; send x-ludy-recipient instead');
  }
  return null;
}

// Keep retired x-crove-invite scrubbed at proxy egress so dual-header requests never leak it upstream while only x-ludy-invite authorizes signup.
const PROXY_DROPPED = new Set([...SPOOFABLE, INVITE_TOKEN_HEADER, RETIRED_INVITE_HEADER]);
// Public Supabase Auth endpoints the web app needs. Everything else (notably /admin) is not reachable.
const AUTH_PUBLIC_PATHS =
  /^\/(?:token|signup|verify|recover|user|logout|otp|resend|settings|health|authorize|callback|reauthenticate|factors(?:\/[\w-]+(?:\/(?:challenge|verify))?)?|\.well-known\/jwks\.json)$/;
// The status page re-reads the prober's file at most this often (#678).
const STATUS_CACHE_MS = 5_000;
// Signed notices one client address may post a minute: a provider posts a few per bank event, from a handful of addresses.
const BANK_FEED_WEBHOOKS_PER_MINUTE = 120;
// Refused mail webhook requests per minute per client address (verified deliveries are not counted).
const MAIL_WEBHOOKS_PER_MINUTE = 120;
// Refused requests (a bad signature, a body that is no notice) one address may send a minute; verified notices are not counted.
const ZALO_WEBHOOKS_PER_MINUTE = 120;
const ZOOM_WEBHOOKS_PER_MINUTE = 120;
const FACEBOOK_WEBHOOKS_PER_MINUTE = 120;
const WHATSAPP_WEBHOOKS_PER_MINUTE = 120;
const TELEGRAM_WEBHOOKS_PER_MINUTE = 120;
// Verified updates one hook takes a minute: ten a second, far above what a shop's customers write, so only a flood hits it.
const TELEGRAM_VERIFIED_PER_HOOK_PER_MINUTE = 600;
// Meta posts one request per person who removes the app: a few a minute is plenty, and a status page is read by one person.
const ADS_DELETION_PER_MINUTE = 60;
// Quote PDFs one member may take a minute (#2695).
const QUOTE_PDFS_PER_MINUTE = 30;
const MAX_FILES_PER_UPLOAD = 5;
// A Social video (#409) is one file of up to 100 MB; a batch of documents stays under 60 MB.
const UPLOAD_BODY_LIMIT = MAX_SOCIAL_VIDEO_BYTES + 2 * 1024 * 1024;
// What a completion refused for lack of a slot tells the client to wait; the grant stays unused for 5 minutes.
export const UPLOAD_BUSY_RETRY_SECONDS = 3;
export const EXPORT_BUSY_RETRY_SECONDS = 5;
// Cloudflare Turnstile's origin (#1353): its script and the iframe of its widget, on deployments that set the keys.
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
// Google Picker and Google Identity Services (#3174, ADR-0025 amendment of 2026-11-25), on deployments that set MEETINGS_GOOGLE_PICKER_API_KEY and its app id: the member picks a Meet recording in Google's Picker,
// which needs Google's loader and its iframe, and a short-lived `drive.file` token minted by Google Identity Services. The lists follow Google's own documentation for the two products; the names of the Trusted Types
// policies Google's scripts create are [unverified] until a real browser run (the owner's Google project, #3177), so a name may be added then. Off, nothing of Google's is allowed: the policy is exactly what it was.
export const GOOGLE_PICKER_SCRIPT_SRC = ['https://apis.google.com', 'https://accounts.google.com/gsi/client'] as const;
export const GOOGLE_PICKER_FRAME_SRC = ['https://docs.google.com', 'https://accounts.google.com/gsi/'] as const;
export const GOOGLE_PICKER_CONNECT_SRC = ['https://accounts.google.com/gsi/'] as const;
export const GOOGLE_PICKER_STYLE_SRC = ['https://accounts.google.com/gsi/style'] as const;
// ludy-google is ours (apps/app/src/lib/google-picker.ts: the two script URLs, exactly); the other two are the policies Google's loaders are known to create.
export const GOOGLE_PICKER_TRUSTED_TYPES = ['ludy-google', 'goog#html', 'gapi#gapi'] as const;
// apiOrigin is the API's origin when the app is served apart from it (a split deployment), so its media (a meeting's video by
// ticket) may be played; null when the kernel serves the app itself and 'self' is the API.
// connectOrigin: one more origin the app calls (the hosted login's token endpoint, #2704), or null.
export function contentSecurityPolicy(
  authUrl: string,
  storageOrigin: string | null,
  turnstile = false,
  apiOrigin: string | null = null,
  connectOrigin: string | null = null,
  frameAncestors: readonly string[] | null = null,
  googlePicker = false,
): string {
  // Hosted Supabase Auth lives on another origin; the bundled one is proxied under /auth/v1. With presigned
  // transfers the app also posts uploads to, and fetches downloads from, the bucket's origin.
  const authOrigin = new URL(authUrl, 'http://localhost').origin;
  // Trusted Types (#681, plan Decision 6): the DOM's HTML and script sinks (innerHTML, document.write, a script's src,
  // eval) refuse plain strings, and no policy may be created that would turn one into trusted HTML. The SPA needs
  // none: it renders through React and never sets raw HTML (apps/app/test/trusted-types.test.ts). A sink reached
  // with a string throws instead of running markup an attacker smuggled into the page. One named policy may be created,
  // once (no 'allow-duplicates'): ludy-sw, whose only method gives the service worker's fixed URL to
  // navigator.serviceWorker.register() for browser push (#1238, apps/app/src/lib/push.ts). It has no createHTML or
  // createScript, so the HTML and script sinks still refuse every string. With Turnstile keys set (#1353), the booking
  // page loads Turnstile's script from its origin through a second fixed-URL policy, ludy-turnstile, and the widget
  // runs in an iframe of that origin; without them, nothing of Cloudflare's is allowed.
  return [
    "default-src 'self'",
    `script-src 'self'${turnstile ? ` ${TURNSTILE_ORIGIN}` : ''}${googlePicker ? ` ${GOOGLE_PICKER_SCRIPT_SRC.join(' ')}` : ''}`,
    googlePicker ? `style-src 'self' ${GOOGLE_PICKER_STYLE_SRC.join(' ')}` : "style-src 'self'",
    "img-src 'self' blob: data:",
    // A meeting's audio plays from a blob URL the app makes, and its video from the stream route by ticket (#2703): media-src
    // would otherwise fall back to default-src, which refuses blob: and, apart from the API, the API's origin.
    `media-src 'self' blob:${apiOrigin ? ` ${apiOrigin}` : ''}`,
    `connect-src 'self' ${[...new Set([authOrigin, ...(storageOrigin ? [storageOrigin] : []), ...(connectOrigin ? [connectOrigin] : []), ...(googlePicker ? GOOGLE_PICKER_CONNECT_SRC : [])])].join(' ')}`,
    ...(turnstile || googlePicker ? [`frame-src ${[...(turnstile ? [TURNSTILE_ORIGIN] : []), ...(googlePicker ? GOOGLE_PICKER_FRAME_SRC : [])].join(' ')}`] : []),
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    frameAncestors && frameAncestors.length > 0 ? `frame-ancestors ${frameAncestors.join(' ')}` : "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
    `trusted-types ludy-sw${turnstile ? ' ludy-turnstile' : ''}${googlePicker ? ` ${GOOGLE_PICKER_TRUSTED_TYPES.join(' ')}` : ''}`,
  ].join('; ');
}

// The socket address, or with trusted reverse proxies the X-Forwarded-For entry they appended.
function clientIp(c: Context, trustedHops: number): string | null {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  const socket = incoming?.socket?.remoteAddress ?? null;
  if (trustedHops === 0) return socket;
  const chain = (c.req.header('x-forwarded-for') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return chain[chain.length - trustedHops] ?? socket;
}

export function createHttpApp(deps: HttpDeps) {
  const { config, runtime, store, authenticate } = deps;
  const app = new Hono<{ Variables: { user: AuthUser } }>();
  // One drafts budget (#386) for the API: a person's own drafts and the MCP draft tool of an AI app take their turns from the same counters and the same one-at-a-time rule.
  const drafts = new DraftBudget();
  const rpc = createRpcHandler(runtime, deps.mailer ? createInviteMailSender(deps.mailer, appUrl(config), {}, config.INBOUND_DOMAIN && config.INBOUND_SECRET ? config.INBOUND_DOMAIN : null, config.BRAND_NAME) : undefined, deps.channels, deps.socialWriter, deps.taxLookup, drafts, undefined, deps.portalSync, deps.bookingReader, deps.aiMeter, deps.aiEnabled, deps.conversationReader, deps.summaryModel ?? null, deps.aiPrice, deps.signAi ?? null, store);
  const perMinute = config.API_RATE_LIMIT_PER_MINUTE;
  const limiter = deps.rateLimiter !== undefined ? deps.rateLimiter : perMinute > 0 ? new RateLimiter({ perMinute }) : null;

  // The authorization server's own routes (ADR-0032, #2975), before the global middleware below: the provider writes its answer on the Node response itself.
  if (deps.oauth) {
    mountOauthProvider(app, {
      oauth: deps.oauth,
      runtime,
      clientKey: (c) => clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)),
      registerPerMinute: config.OAUTH_REGISTER_PER_MINUTE,
      registerGlobalPerMinute: config.OAUTH_REGISTER_GLOBAL_PER_MINUTE,
      allowedOrigins: (config.MCP_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter((o) => o.length > 0),
    });
  }

  // A request id per request (#2175): in every log line the request makes (JSON logs), and in the `x-request-id` answer
  // header, so a report ("the upload failed at 10:42") can be matched to its lines. Always generated here: an id a caller
  // sent is never trusted or logged. The access line carries the method, the matched route pattern (never the path, which
  // can hold a token), the status and the time, and nothing of the request's headers, cookies, query or body; it is printed
  // only with LOG_FORMAT=json, and not for the health probes that run every few seconds.
  app.use('*', async (c, next) => {
    const requestId = randomUUID();
    const started = Date.now();
    await runWithLogContext({ requestId }, async () => {
      try {
        await next();
      } finally {
        const status = c.res.status;
        // Hono copies a finished response whose headers are fixed, so this reaches every answer.
        c.header('x-request-id', requestId);
        const route = c.req.routePath;
        if (route !== '/healthz' && route !== '/readyz') {
          logEvent(status >= 500 ? 'error' : 'info', 'request', { method: c.req.method, route, status, durationMs: Date.now() - started });
        }
      }
    });
  });
  // Google Identity Services opens its consent window with window.open and reads the answer through window.opener, which Hono's default Cross-Origin-Opener-Policy `same-origin` cuts (#3174). Only a deployment that
  // set the Picker's keys relaxes it, to `same-origin-allow-popups` (the page still cannot be reached by a window that opened it). secureHeaders writes its headers after the handler, so it has to be set here, not per page.
  const googlePickerOn = Boolean(config.MEETINGS_GOOGLE_PICKER_API_KEY && config.MEETINGS_GOOGLE_PICKER_APP_ID);
  app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-site', ...(googlePickerOn ? { crossOriginOpenerPolicy: 'same-origin-allow-popups' } : {}) }));
  // A web app on another origin (APP_URL, #2261) calls this API cross-origin: the allowlisted origins get CORS headers and
  // their preflights are answered here, before the rate limit and the session check (a preflight carries no token).
  app.use('*', corsMiddleware(config.CORS_ALLOWED_ORIGINS));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    const client = await deps.pool.connect().catch(() => null);
    if (!client) return c.json({ ready: false, reason: 'database' }, 503);
    try {
      const missing = await schemaMissing(client, config.MIGRATIONS_DIR);
      if (missing.length > 0) return c.json({ ready: false, reason: 'schema' }, 503);
      // The vendored ludy_jobs schema must be the version this pg-boss release expects (External-tenant gate T6).
      const jobs = await client.query<{ version: number | null }>('SELECT ludy_kernel.jobs_schema_version() AS version');
      if (jobs.rows[0]?.version !== pgBossSchemaVersion()) return c.json({ ready: false, reason: 'jobs_schema' }, 503);
      // The session check fails closed until it can read Supabase Auth's tables (ADR-0028).
      if (config.AUTH_SESSION_CHECK === 'db') {
        const { rows } = await client.query<{ ok: boolean }>('SELECT ludy_kernel.auth_grants_ready() AS ok');
        if (!rows[0]?.ok) return c.json({ ready: false, reason: 'auth_grants' }, 503);
      }
      // Worker build >= API build (#1952, plan §3.5): the deploy rolls the workers out first and back last, and this API
      // takes no traffic while a live worker (a beat in the last 90 seconds) runs an older build, or one of unknown
      // build time (a release before #1952). Builds are ordered by CROVE_BUILD_TIME, the commit's date; without one
      // (a local build) nothing is compared. No live worker is not a reason: the prober alerts on a missing heartbeat,
      // and readiness must not flap on a worker's restart.
      if (deps.workerBuildCheck && config.LUDY_BUILD_TIME) {
        const { rows } = await client.query<{ older: number }>('SELECT older FROM ludy_kernel.worker_build_lag($1::timestamptz)', [config.LUDY_BUILD_TIME]);
        if ((rows[0]?.older ?? 0) > 0) return c.json({ ready: false, reason: 'worker_build' }, 503);
      }
      return c.json({ ready: true });
    } catch {
      return c.json({ ready: false, reason: 'database' }, 503);
    } finally {
      client.release();
    }
  });

  // The build and the committed migrations missing from the ledger (#892, plan §4.11), for the deploy's smoke test.
  // Public like /readyz: migration names are in the source; nothing about an org.
  app.get('/version', async (c) => {
    const build = config.LUDY_BUILD ?? 'dev';
    const client = await deps.pool.connect().catch(() => null);
    if (!client) return c.json({ build, migrationsMissing: null }, 503);
    try {
      return c.json({ build, migrationsMissing: await schemaMissing(client, config.MIGRATIONS_DIR) });
    } catch {
      return c.json({ build, migrationsMissing: null }, 503);
    } finally {
      client.release();
    }
  });

  // The MCP endpoint and its authorization server (ADR-0051 decision 2, #2975): POST /mcp, the metadata, the /oauth routes and the consent page's two calls.
  // They sit outside /api: they take no browser session (an access token of the embedded authorization server, or the signed-in user's own bearer on the consent calls).
  if (deps.oauth) {
    mountMcp(app, {
      config,
      runtime,
      oauth: deps.oauth,
      authenticate,
      clientKey: (c) => clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)),
      serverVersion: config.LUDY_BUILD ?? 'dev',
      draftBudget: drafts,
    });
  }

  const allowedExtensionIds = config.EXTENSION_IDS ?? [...DEFAULT_EXTENSION_IDS];
  app.get('/api/config', (c) =>
    c.json({
      authUrl: publicAuthUrl(config),
      authAnonKey: config.PUBLIC_AUTH_ANON_KEY ?? null,
      // Sign-in buttons besides email and password (AUTH_OAUTH_PROVIDERS, #2704): provider ids of the identity provider.
      authProviders: config.AUTH_OAUTH_PROVIDERS,
      // The identity provider's hosted login page and its token endpoint (AUTH_HOSTED_LOGIN_*, #2704); null: none.
      hostedLogin: hostedLoginView(config),
      // How people sign in (AUTH_SIGN_IN, #4704) and, in `oauth` mode, the identity provider's OAuth App; null otherwise.
      signIn: config.AUTH_SIGN_IN,
      oauthSignIn: oauthSignInView(config),
      aiEnabled: deps.aiEnabled,
      // The MCP endpoint and its authorization server are on (OAUTH_SERVER=on, #2975): Settings then lists the connected AI apps.
      mcpEnabled: deps.oauth !== undefined,
      // presigned: the app uploads to a staging key and downloads from the bucket (plan §7.6); direct: through the kernel.
      uploads: store.direct ? 'presigned' : 'direct',
      // The store can sign a short-lived URL for a platform that fetches media (Zalo OA, Instagram, Threads), also when
      // uploads are direct (R2, #2192): the composer then lets those channels take images.
      platformMediaUrls: Boolean(store.fetchUrls),
      inboundEnabled: Boolean(config.INBOUND_DOMAIN && config.INBOUND_SECRET),
      mailEnabled: deps.mailer?.enabled ?? false,
      // The shell's feedback and support link (SUPPORT_URL, issue #310); null hides it.
      supportUrl: config.SUPPORT_URL ?? null,
      // The booking page shows Cloudflare Turnstile with this site key (#1353); null shows none.
      turnstileSiteKey: config.TURNSTILE_SITE_KEY ?? null,
      // Google Picker for the audio of a Meet recording (#3174): the browser's API key, the Google project number and the OAuth client id, public values; null when the operator set none.
      googlePicker:
        config.MEETINGS_GOOGLE_PICKER_API_KEY && config.MEETINGS_GOOGLE_PICKER_APP_ID && config.MEETINGS_GOOGLE_CLIENT_ID
          ? { apiKey: config.MEETINGS_GOOGLE_PICKER_API_KEY, appId: config.MEETINGS_GOOGLE_PICKER_APP_ID, clientId: config.MEETINGS_GOOGLE_CLIENT_ID }
          : null,
      // The product name users see (BRAND_NAME, #1040); the app fills its messages and the page title with it.
      brandName: config.BRAND_NAME,
      // The Ludy extension ids that may sign in (EXTENSION_IDS, #2740); the connect page refuses any other.
      extensionIds: allowedExtensionIds,
      // Ludy Desktop recording (ADR-0055 slice 3, #4516): off until #2585 legal answers are recorded.
      meetingsDesktopCapture: config.MEETINGS_DESKTOP_CAPTURE === 'on',
      // The terms and privacy notice linked at sign-up and invite acceptance (#688); null hides each link.
      termsUrl: config.TERMS_URL ?? null,
      privacyUrl: config.PRIVACY_URL ?? null,
      // The shell links to /status only when the deployment serves it (STATUS_FILE, #678).
      statusPage: Boolean(config.STATUS_FILE),
      // Onboarding offers "look up" next to the tax code only when the server has a registry to ask (issue #324).
      taxCodeLookup: Boolean(deps.taxLookup),
      // The reconciliation screen offers "Lấy danh sách từ cổng thuế" only when the deployment turned it on (issue #325).
      taxPortalSync: Boolean(deps.portalSync),
      // The SPA shows the menus of these modules only (plan Decision 12).
      modules: runtime.modules(),
      // The app subscribes to /api/stream and polls only while it is down (issue #69).
      stream: Boolean(deps.stream),
      // Who may create an account (#350): open, invite_only or allowlist. The allowed domains stay on the server.
      signupPolicy: config.AUTH_SIGNUP_POLICY,
      // Channels the app may offer to connect without a platform account (ADR-0025).
      // OAuth providers only with a credential key: their tokens could not be sealed otherwise.
      // Bank feeds (ADR-0039): which providers this deployment offers; none hides the feature.
      bankFeeds: { sandbox: Boolean(deps.channels?.bankFeedSandbox), tingee: Boolean(deps.channels?.bankFeedHosted && Object.hasOwn(deps.channels.bankFeedHosted, 'bank_tingee')) },
      // Ad platforms (ADR-0040): which this deployment offers; none leaves the Ads screen with nothing to connect.
      ads: { sandbox: Object.hasOwn(deps.channels?.adsPlatforms ?? {}, 'sandbox_ads') },
      channels: { sandbox: Boolean(deps.channels?.sandbox), bluesky: Boolean(deps.channels?.bluesky), telegram: Boolean(deps.channels?.telegram), mastodon: Boolean(deps.channels?.mastodon), discord: Boolean(deps.channels?.discord), wordpress: Boolean(deps.channels?.wordpress), ...(deps.channels?.whatsapp ? { whatsapp: true } : {}), oauth: deps.channels && deps.channels.broker.id !== 'none' ? Object.keys(deps.channels.connectors ?? {}).sort() : [] },
    }),
  );

  // The public status page (#678): drawn from the prober's last result, no account needed and nothing about an org on
  // it. The file is read at most every few seconds, whatever the traffic.
  if (config.STATUS_FILE) {
    const statusFile = config.STATUS_FILE;
    let cached: { readAt: number; status: ProbeStatus | null } | null = null;
    app.get('/status', async (c) => {
      const now = Date.now();
      if (!cached || now - cached.readAt > STATUS_CACHE_MS) cached = { readAt: now, status: await readStatusFile(statusFile) };
      const page = renderStatusPage(statusView(cached.status, new Date(now)), config.BRAND_NAME);
      return c.html(page, 200, { 'content-security-policy': STATUS_PAGE_CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    });
  }

  // Ludy-branded Supabase Auth email templates (#3577): served over HTTP inside the Compose network to the bundled
  // auth service (GOTRUE_MAILER_TEMPLATES_* -> http://ludy:8080/auth-templates/<kind>.html). Strict 5-file allowlist,
  // zero dynamic filesystem reads and zero tenant data.
  app.get(AUTH_MAIL_TEMPLATE_ROUTE, (c) => {
    const html = renderAuthMailTemplate(c.req.param('name'), config.BRAND_NAME);
    if (html === null) return c.json({ code: 'NOT_FOUND' }, 404);
    return c.html(html, 200, {
      'content-security-policy': AUTH_MAIL_TEMPLATE_CSP,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
  });

  // Self-hosted Supabase Auth behind the same origin.
  if (config.AUTH_UPSTREAM_URL) {
    const upstream = config.AUTH_UPSTREAM_URL.replace(/\/$/, '');
    const emailLimiter =
      deps.emailLimiter ??
      createDbEmailLimiter(deps.pool, {
        perClientPerHour: config.AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR,
        addressIntervalSeconds: config.AUTH_EMAIL_ADDRESS_INTERVAL_SECONDS,
      });
    const autoconfirm = config.AUTH_AUTOCONFIRM === 'true';
    const signupRules: SignupRules = { policy: config.AUTH_SIGNUP_POLICY, domains: new Set(config.AUTH_SIGNUP_ALLOWED_DOMAINS) };
    const inviteChecks = deps.signupInviteChecks ?? createDbInviteChecks(deps.pool);
    const refusalLimiter =
      deps.signupRefusalLimiter ??
      createDbRefusalLimiter(deps.pool, {
        perClientPerHour: config.AUTH_SIGNUP_REFUSAL_LIMIT_PER_HOUR,
        globalPerHour: config.AUTH_SIGNUP_REFUSAL_GLOBAL_LIMIT_PER_HOUR,
      });
    app.all('/auth/v1/*', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
      const url = new URL(c.req.url);
      const path = url.pathname.replace(/^\/auth\/v1/, '');
      if (!AUTH_PUBLIC_PATHS.test(path)) return c.json({ code: 'NOT_FOUND' }, 404);
      const headers = forwardable(c.req.raw.headers, PROXY_DROPPED);
      // Supabase Auth accepts the access tokens its OAuth server issues to third-party clients wherever it accepts a
      // browser's (ADR-0028 fact 11). Of the paths above, it authenticates /user, /logout, /reauthenticate and every
      // /factors path with that token (`requireAuthentication`, v2.197.0), so an OAuth client could change the
      // user's email or password, enroll or remove factors, or sign every session out. A browser never holds such a
      // token, so it is refused on every forwarded path, before the email budget and without reaching Supabase Auth.
      // The header checked is the one forwarded; the token is decoded, never verified (Supabase Auth does that).
      if (bearerIssuedToOAuthClient(headers.get('authorization'), config.AUTH_OAUTH_CLIENT_ID)) return oauthClientTokenRefused();
      const ip = clientIp(c, config.TRUSTED_PROXY_HOPS);
      if (ip) headers.set('x-real-ip', ip);
      const method = c.req.method;
      const payload = method === 'GET' || method === 'HEAD' ? null : new Uint8Array(await c.req.arrayBuffer());
      // A request that could create an account under a restricted sign-up policy (#350): one the proxy cannot check
      // is refused here; one with a readable email is checked below, after it took its email slot.
      const gate = signupGate(signupRules, { path, search: url.searchParams, contentType: headers.get('content-type'), body: payload });
      if (gate.kind === 'refuse') return signupRefused();
      if (gate.kind === 'method') return methodRefused();
      // Under allowlist an account may not move to an address outside it either (#564 item 4).
      if (emailChangeGate(signupRules, { method, path, body: payload }) === 'refuse') return emailChangeRefused();
      // A request that makes Supabase Auth send an email takes a slot of its client's budget first (#190).
      const sends = emailSendRequest(method, path, payload, autoconfirm);
      const client = clientBucket(ip);
      let reservation: string | null = null;
      if (sends) {
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        const verdict = await emailLimiter.reserve({ client, target: sends.target }).catch((error: unknown) => {
          console.error('[auth-proxy] email limiter unavailable:', error instanceof Error ? error.message : error);
          return null;
        });
        if (!verdict) return c.json({ code: 'AUTH_UNAVAILABLE', message: 'Dịch vụ đăng nhập không phản hồi' }, 503);
        if (!verdict.allowed) return emailRateLimited(verdict.retryAfterSeconds);
        reservation = verdict.reservation;
      }
      if (gate.kind === 'check') {
        // The invite token the web app sends with a sign-up from an accept link (#563); the header is never forwarded.
        const token = signupInviteToken(readInviteHeader(c));
        // Each lookup of whether the address holds an invite takes a refusal slot of the client's IPv4 address or IPv6
        // /48 and of the deployment, given back when the sign-up is admitted (#564 item 1).
        // The refusal cap counts per client address too, so warn about a reverse proxy without TRUSTED_PROXY_HOPS
        // here as well (with AUTH_AUTOCONFIRM a sign-up takes no email slot, so the warning above never ran).
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        const checks = limitInviteChecks(inviteChecks, refusalLimiter, clientBucket(ip, 48));
        const allowed = await signupAllowed(signupRules, gate.email, token, checks).catch((error: unknown) => {
          if (error instanceof SignupRefusalsLimited) return error;
          console.error('[auth-proxy] sign-up policy check unavailable:', error instanceof Error ? error.message : error);
          return null;
        });
        if (allowed === null || allowed instanceof SignupRefusalsLimited) {
          if (reservation) {
            await emailLimiter.release(reservation, client).catch((error: unknown) => {
              console.error('[auth-proxy] email reservation not released:', error instanceof Error ? error.message : error);
            });
          }
          if (allowed) return signupRefusalsLimited(allowed.retryAfterSeconds);
          return c.json({ code: 'AUTH_UNAVAILABLE', message: 'Dịch vụ đăng nhập không phản hồi' }, 503);
        }
        // A refused sign-up keeps its email slot: the per-client budget (AUTH_EMAIL_CLIENT_LIMIT_PER_HOUR) also bounds
        // how many addresses one client can try, which caps probing for who holds an invite.
        if (!allowed) return signupRefused();
      }
      const response = await fetch(`${upstream}${path}${url.search}`, {
        method,
        headers,
        body: payload ? body(payload) : null,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      // A refused request sent no email, so it gives its slot back. One left unanswered (timeout, dropped connection)
      // keeps it: Supabase Auth may still have sent the email.
      if (reservation && response && response.status >= 400) {
        await emailLimiter.release(reservation, client).catch((error: unknown) => {
          console.error('[auth-proxy] email reservation not released:', error instanceof Error ? error.message : error);
        });
      }
      if (!response) return c.json({ code: 'AUTH_UNAVAILABLE', message: 'Dịch vụ đăng nhập không phản hồi' }, 503);
      // fetch() already decoded the body, so the upstream content-encoding no longer applies.
      const out = forwardable(response.headers, new Set(['content-encoding']));
      return new Response(response.body, { status: response.status, headers: out });
    });
  }

  // Delivery events from the mail provider (#539, #4960), when it has signed webhooks (Resend with RESEND_WEBHOOK_SECRET, Amazon SES with SES_SNS_TOPIC_ARN).
  // Outside /api: the provider authenticates with its signature, not a session. Unknown providers and throttled probes are refused before bodyLimit;
  // reserve atomically with take() ahead of bodyLimit and refund on verified 200/202 deliveries or transient 503 capacity so concurrent invalid bursts cannot bypass peek().
  const mailer = deps.mailer;
  if (mailer?.parseWebhook) {
    const mailLimit = deps.mailWebhookLimit ?? new RateLimiter({ perMinute: MAIL_WEBHOOKS_PER_MINUTE });
    app.post(
      '/webhooks/mail/:provider',
      async (c, next) => {
        if (c.req.param('provider') !== mailer.name) return c.json({ code: 'NOT_FOUND' }, 404);
        const decision = mailLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
        if (!decision.allowed) {
          warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
          c.header('retry-after', String(decision.retryAfterSeconds));
          return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds }, 429);
        }
        await next();
      },
      bodyLimit({ maxSize: MAX_MAIL_WEBHOOK_BYTES }),
      async (c) => {
        const bucket = clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS));
        try {
          const headers: Record<string, string | undefined> = {};
          c.req.raw.headers.forEach((value, name) => {
            headers[name.toLowerCase()] = value;
          });
          const outcome = await acceptMailWebhook(runtime, mailer, { headers, body: await c.req.text() });
          if (outcome.status === 503) {
            mailLimit.refund(bucket);
            c.header('retry-after', String(outcome.retryAfterSeconds));
            return c.json({ code: outcome.code }, 503);
          }
          if (outcome.status === 401 || outcome.status === 400) {
            return c.json({ code: outcome.code }, outcome.status);
          }
          mailLimit.refund(bucket);
          return c.json({ queued: outcome.queued }, outcome.status);
        } catch (error) {
          return problem(c, error);
        }
      },
    );
  }

  // A bank feed provider's signed notice (ADR-0039, #2044): public like the mail provider's, checked by the adapter's
  // signature before anything else, rate limited per client address, and only queued: it asks the worker for a pull of a
  // connection that lists the account it names. A provider name no adapter here takes notices for is a 404; with no
  // adapter taking any, the route does not exist.
  const bankFeedWebhooks = deps.bankFeedWebhooks;
  if (bankFeedWebhooks && Object.keys(bankFeedWebhooks).length > 0 && runtime.installed('finance')) {
    const noticeLimit = deps.bankFeedWebhookLimit ?? new RateLimiter({ perMinute: BANK_FEED_WEBHOOKS_PER_MINUTE });
    // The per-address limit is its own middleware ahead of the cap: bodyLimit reads a body sent without a Content-Length (a chunked one) up to the cap before it calls the next handler,
    // so a limiter inside the handler would refuse an address only after its body was read (#4047).
    app.post(
      '/api/bank-feed/:provider/webhook',
      async (c, next) => {
        if (!Object.hasOwn(bankFeedWebhooks, c.req.param('provider'))) return c.json({ code: 'NOT_FOUND' }, 404);
        const decision = noticeLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
        if (!decision.allowed) {
          warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
          c.header('retry-after', String(decision.retryAfterSeconds));
          return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds }, 429);
        }
        await next();
      },
      bodyLimit({ maxSize: MAX_BANK_FEED_WEBHOOK_BYTES }),
      async (c) => {
        const name = c.req.param('provider');
        try {
          const headers: Record<string, string | undefined> = {};
          c.req.raw.headers.forEach((value, header) => {
            headers[header.toLowerCase()] = value;
          });
          const outcome = await acceptBankFeedWebhook(runtime, bankFeedWebhooks[name] as BankFeedProvider, { headers, body: await c.req.text() });
          if (outcome.status === 401 || outcome.status === 400) return c.json({ code: outcome.code }, outcome.status);
          return c.json({ queued: outcome.queued }, outcome.status);
        } catch (error) {
          return problem(c, error);
        }
      },
    );
  }

  // A bank feed provider's signed notice at the address of one connection (Tingee, #4203, ADR-0039 as amended): public like the route above, but the provider signs with each customer's own secret, which only the worker can open,
  // so the address carries a hook key of the connection. In order: the per-address limit (its own middleware, ahead of the body cap for the reason given above), the 16 KB cap, then acceptBankFeedHook: the headers and the
  // timestamp window, the lookup of the key's SHA-256 (the org and the connection come from our own row, never from the body; an unknown key is a 404 and nothing is stored), a budget per hook, and the raw notice
  // stored for the worker, which verifies the signature. Nothing of the key, the signature or the body is logged or answered.
  const bankFeedHooks = deps.bankFeedHooks;
  if (bankFeedHooks && Object.keys(bankFeedHooks).length > 0 && runtime.installed('finance')) {
    const hookAddressLimit = deps.bankFeedHookLimit ?? new RateLimiter({ perMinute: BANK_FEED_WEBHOOKS_PER_MINUTE });
    const hookBudget = deps.bankFeedHookBudget ?? new RateLimiter({ perMinute: BANK_FEED_HOOKS_PER_MINUTE });
    app.post(
      '/api/bank-feed/:provider/webhook/:hookKey',
      async (c, next) => {
        if (!Object.hasOwn(bankFeedHooks, c.req.param('provider'))) return c.json({ code: 'NOT_FOUND' }, 404);
        const decision = hookAddressLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
        if (!decision.allowed) {
          warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
          c.header('retry-after', String(decision.retryAfterSeconds));
          return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds }, 429);
        }
        await next();
      },
      bodyLimit({ maxSize: MAX_BANK_FEED_HOOK_BYTES }),
      async (c) => {
        try {
          const headers: Record<string, string | undefined> = {};
          c.req.raw.headers.forEach((value, header) => {
            headers[header.toLowerCase()] = value;
          });
          const outcome = await acceptBankFeedHook(runtime, bankFeedHooks[c.req.param('provider')] as BankFeedProvider, { key: c.req.param('hookKey'), headers, body: await c.req.text() }, hookBudget);
          if (outcome.status === 200) return c.json({ code: '00', message: 'Success' }, 200);
          if (outcome.status === 404) return c.json({ code: 'NOT_FOUND' }, 404);
          if (outcome.status === 429) {
            c.header('retry-after', String(outcome.retryAfterSeconds));
            return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: outcome.retryAfterSeconds }, 429);
          }
          return c.json({ code: outcome.code }, outcome.status);
        } catch (error) {
          // Nothing of the error is logged: a database error's DETAIL can quote the notice's body, which is personal data. The line carries the error's name only.
          console.error('[bank-feed-hook] request failed:', error instanceof Error ? error.name : 'error');
          return c.json({ code: 'INTERNAL', message: 'Lỗi hệ thống' }, 500);
        }
      },
    );
  }

  // A marketplace's signed push at the address of one connection (#4346, S2 of #4315; the verifiers and the worker relay are #4344): public like the routes above, and signed with each seller's own app secret that only the worker
  // can open, so the address carries a hook key of the connection. In order: the adapter must be one the deployment runs (else a 404 and nothing is stored), the per-address limit (ahead of the body cap), the 16 KB cap, then
  // acceptMarketplacePush: the key's SHA-256 is looked up (the org and the connection come from our own row, never from the body), and the RAW bytes are stored for the worker. Every answer is an empty 2xx or a bare 404, never a 429
  // (Shopee disables a subscription below 30% success), and nothing of the key, the header, the body or a secret is logged or answered. Shopee's signed address is built from PUBLIC_URL, never from Host or X-Forwarded-*.
  const marketplacePush = deps.marketplacePush;
  if (marketplacePush && marketplacePush.adapters.length > 0 && runtime.installed('finance')) {
    const pushAddressLimit = marketplacePush.limit ?? new RateLimiter({ perMinute: MARKETPLACE_PUSH_ADDRESS_PER_MINUTE });
    const pushBudget = marketplacePush.budget ?? new RateLimiter({ perMinute: MARKETPLACE_PUSHES_PER_MINUTE });
    app.post(
      '/api/marketplace/:adapter/webhook/:hookKey',
      async (c, next) => {
        // An adapter this deployment does not run, or a key of the wrong shape, is a 404 before any body is read.
        if (!marketplacePush.adapters.includes(c.req.param('adapter')) || !isMarketplaceHookKey(c.req.param('hookKey'))) return c.json({ code: 'NOT_FOUND' }, 404);
        // Over the address limit the push is dropped with an empty success: the periodic poll makes up what it would have said. The proxy warning is the one the other public routes give: behind a proxy that is not counted in
        // TRUSTED_PROXY_HOPS every platform shares one bucket, and this is where that shows.
        if (!pushAddressLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS))).allowed) {
          warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
          return c.body(null, 200);
        }
        await next();
      },
      bodyLimit({ maxSize: MAX_MARKETPLACE_PUSH_BYTES, onError: (c) => c.body(null, 200) }),
      async (c) => {
        try {
          const outcome = await acceptMarketplacePush(
            runtime,
            c.req.param('adapter'),
            { key: c.req.param('hookKey'), authorization: c.req.header('authorization'), body: new Uint8Array(await c.req.arrayBuffer()) },
            pushBudget,
            config.PUBLIC_URL,
          );
          return outcome.status === 404 ? c.json({ code: 'NOT_FOUND' }, 404) : c.body(null, 200);
        } catch (error) {
          // Nothing of the error is logged: a database error's DETAIL can quote the push's body. The line carries the error's name only.
          console.error('[marketplace-push] request failed:', error instanceof Error ? error.name : 'error');
          return c.json({ code: 'INTERNAL' }, 500);
        }
      },
    );
  }

  // MISA AMIS's callback with the result of a save (#3903, S4 of #3854; MISA ASP posts to it too, #4103): public, checked by the HMAC of its signed `data` before anything else is read, capped in size and rate limited per client
  // address before the body is read. The signature proves MISA sent it, not for which organisation (one key per product the deployment holds): the organisation is found from our own stored push row, never from the
  // envelope (misa-amis-callback.ts). A verified message is always answered 200, so the answer says nothing about an org_refid; a refusal is a fixed code, and nothing of the body, the signature,
  // MISA's text or the ClientID is logged or kept. Without the ClientID the route is not registered: a POST to the path falls through to the session check of /api/* (401) and reaches nothing.
  const misaAmisCallback = deps.misaAmisCallback;
  if (misaAmisCallback && runtime.installed('finance')) {
    const callbackLimit = deps.misaAmisCallbackLimit ?? new RateLimiter({ perMinute: BANK_FEED_WEBHOOKS_PER_MINUTE });
    // The limit is its own middleware, ahead of the body cap: a chunked body (no Content-Length) is read up to the cap before the cap's own check passes, and that read must not be free for a flooder.
    app.post(
      '/api/webhooks/misa-amis',
      async (c, next) => {
        const decision = callbackLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
        if (!decision.allowed) {
          warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
          c.header('retry-after', String(decision.retryAfterSeconds));
          return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds }, 429);
        }
        await next();
      },
      bodyLimit({ maxSize: MAX_MISA_AMIS_CALLBACK_BYTES }),
      async (c) => {
        try {
          const outcome = await acceptMisaAmisCallback(runtime, 'keys' in misaAmisCallback ? misaAmisCallback.keys : [{ product: 'amis' as const, clientId: misaAmisCallback.clientId }], await c.req.text());
          if (outcome.status === 401 || outcome.status === 400) return c.json({ code: outcome.code }, outcome.status);
          return c.json({ ok: true }, 200);
        } catch {
          // Not problem(): it logs the error's message, and a database error can quote the row it refused, which holds MISA's own text. This route logs a short code only (the runtime logs its own internal errors, which the enqueue keeps free of MISA's text: it filters before it inserts); MISA retries a 503.
          console.error('[misa-amis-callback] not recorded: CALLBACK_UNAVAILABLE');
          return c.json({ code: 'CALLBACK_UNAVAILABLE' }, 503);
        }
      },
    );
  }

  // Zalo OA's webhook of customers' messages (conversation core, #2304): the signature is checked before the body is read or kept, the
  // body is capped before it is read, and a verified message is only parked for the worker (the org comes from the stored connection).
  // The body is capped (a chunked one is cut at the cap) and the signature checked, which is one SHA-256 over at most 64 KiB. Every
  // refusal of the signature is the same 401. Zalo does not retry on an error status [S], so a verified notice is never refused for
  // rate: the per-address limit is charged only to REFUSED requests (a bad signature or a body that is no notice), so a flood of forged
  // ones from the address Zalo also posts from cannot cost a real notice, whatever TRUSTED_PROXY_HOPS says. That limit only shapes the
  // answers (a 429 in place of a 401, for an address that sends many refused requests): it does not save the work of checking, so the
  // CPU bound is the 64 KiB body cap above, one SHA-256 over at most that much per request. What a verified flood can do is bounded by
  // the backlog cap of the provider (conversation_inbound_enqueue).
  const zaloWebhook = deps.zaloWebhook;
  if (zaloWebhook) {
    const zaloLimit = deps.zaloWebhookLimit ?? new RateLimiter({ perMinute: ZALO_WEBHOOKS_PER_MINUTE });
    const zaloReplays = deps.zaloReplays ?? new ZaloReplayCache();
    app.post(ZALO_WEBHOOK_PATH, bodyLimit({ maxSize: ZALO_MAX_NOTICE_BYTES }), async (c) => {
      try {
        const outcome = await acceptZaloWebhook(runtime, zaloWebhook, { signature: c.req.header(ZALO_SIGNATURE_HEADER), body: new Uint8Array(await c.req.arrayBuffer()) }, zaloReplays);
        if (outcome.status === 200) return c.json({ ok: true }, 200);
        if (outcome.status === 401 || outcome.status === 400) {
          const decision = zaloLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
          if (!decision.allowed) {
            warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
            c.header('retry-after', String(decision.retryAfterSeconds));
            return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds }, 429);
          }
        }
        return c.json({ code: outcome.code }, outcome.status);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // Zoom's webhook of finished cloud recordings (meetings integrations C3, #3175), a doorbell and never data: the body is capped before it is read, the signature (x-zm-signature over
  // `v0:<timestamp>:<body>`, constant time, 5 minute window) is checked before the event is looked at, and a verified notice only asks the sweep to list the host's connections again (a definer clears
  // their last listing time). The answer is the same whether or not a connection matched. The per-address limit is charged to refused requests and to a URL validation challenge that came unsigned, so
  // a flood of forged ones only turns into 429s and costs one HMAC each. Nothing of a body is logged.
  const zoomWebhook = deps.zoomWebhook;
  if (zoomWebhook && runtime.installed('meetings')) {
    const zoomLimit = deps.zoomWebhookLimit ?? new RateLimiter({ perMinute: ZOOM_WEBHOOKS_PER_MINUTE });
    const zoomReplays = deps.zoomReplays ?? new ZoomReplayCache();
    app.post(ZOOM_WEBHOOK_PATH, bodyLimit({ maxSize: ZOOM_MAX_NOTICE_BYTES }), async (c) => {
      try {
        const outcome = await acceptZoomWebhook(
          runtime,
          zoomWebhook,
          { signature: c.req.header(ZOOM_SIGNATURE_HEADER), timestamp: c.req.header(ZOOM_TIMESTAMP_HEADER), body: new Uint8Array(await c.req.arrayBuffer()) },
          zoomReplays,
        );
        const charged = outcome.status !== 200 || outcome.unsigned === true;
        if (charged) {
          const decision = zoomLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
          if (!decision.allowed) {
            warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
            c.header('retry-after', String(decision.retryAfterSeconds));
            return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds }, 429);
          }
        }
        if (outcome.status === 200) return c.json(outcome.body, 200);
        return c.json({ code: outcome.code }, outcome.status);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // Telegram's webhook of customers' private-chat messages (#3132): the secret derived from the hook in the path is checked first of all, before the
  // body is read or the database asked, so an unauthenticated request costs one HMAC; the body is then capped before it is read, and a verified
  // message is only parked for the worker (the org comes from the stored connection). Every refusal is the same 401. The per-address limit is charged
  // to refused requests only, as Zalo's is, so a flood of forged ones cannot cost a real update. A verified flood (anyone may write to a public bot)
  // is held to a rate per hook, so one bot cannot fill the backlog every org shares (429, which Telegram retries later); what is left is bounded by
  // the provider's backlog cap (conversation_inbound_enqueue).
  const telegramWebhook = deps.telegramWebhook;
  if (telegramWebhook) {
    const telegramLimit = deps.telegramWebhookLimit ?? new RateLimiter({ perMinute: TELEGRAM_WEBHOOKS_PER_MINUTE });
    const telegramHookLimit = deps.telegramHookLimit ?? new RateLimiter({ perMinute: TELEGRAM_VERIFIED_PER_HOOK_PER_MINUTE });
    const telegramReplays = deps.telegramReplays ?? new TelegramReplayCache();
    const limited = (c: Context, limiter: RateLimiter, key: string): Response | null => {
      const decision = limiter.take(key);
      if (decision.allowed) return null;
      warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
      c.header('retry-after', String(decision.retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds }, 429);
    };
    app.post(
      TELEGRAM_WEBHOOK_PATH,
      async (c, next) => {
        const hook = c.req.param('hook');
        if (!telegramWebhookAuthorized(telegramWebhook, { hook, secret: c.req.header(TELEGRAM_SECRET_HEADER) })) {
          return limited(c, telegramLimit, clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS))) ?? c.json({ code: TELEGRAM_UNAUTHORIZED.code }, TELEGRAM_UNAUTHORIZED.status);
        }
        const over = limited(c, telegramHookLimit, hook);
        if (over) return over;
        await next();
      },
      bodyLimit({ maxSize: TELEGRAM_MAX_NOTICE_BYTES }),
      async (c) => {
        try {
          const outcome = await acceptTelegramWebhook(runtime, telegramWebhook, { hook: c.req.param('hook'), secret: c.req.header(TELEGRAM_SECRET_HEADER), body: async () => new Uint8Array(await c.req.arrayBuffer()) }, telegramReplays);
          if (outcome.status === 200) return c.json({ ok: true }, 200);
          if (outcome.status === 401 || outcome.status === 400) {
            const refused = limited(c, telegramLimit, clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
            if (refused) return refused;
          }
          return c.json({ code: outcome.code }, outcome.status);
        } catch (error) {
          return problem(c, error);
        }
      },
    );
  }

  const facebookWebhook = deps.facebookWebhook;
  if (facebookWebhook) {
    const facebookLimit = deps.facebookWebhookLimit ?? new RateLimiter({ perMinute: FACEBOOK_WEBHOOKS_PER_MINUTE });
    const facebookReplays = deps.facebookReplays ?? new FacebookReplayCache();
    const chargeRefusal = (c: Context): Response | null => {
      const decision = facebookLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (decision.allowed) return null;
      warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
      c.header('retry-after', String(decision.retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds }, 429);
    };
    app.get(FACEBOOK_WEBHOOK_PATH, (c) => {
      const outcome = verifyFacebookWebhookChallenge(facebookWebhook, {
        mode: c.req.query('hub.mode'),
        verifyToken: c.req.query('hub.verify_token'),
        challenge: c.req.query('hub.challenge'),
      });
      if (outcome.status === 200) return c.text(outcome.challenge, 200);
      const limited = chargeRefusal(c);
      if (limited) return limited;
      return c.json({ code: outcome.code }, outcome.status);
    });
    app.post(FACEBOOK_WEBHOOK_PATH, bodyLimit({ maxSize: FACEBOOK_MAX_NOTICE_BYTES }), async (c) => {
      try {
        const outcome = await acceptFacebookWebhook(runtime, facebookWebhook, { signature: c.req.header(FACEBOOK_SIGNATURE_HEADER), body: new Uint8Array(await c.req.arrayBuffer()) }, facebookReplays);
        if (outcome.status === 200) return c.json({ ok: true }, 200);
        if (outcome.status === 401 || outcome.status === 400) {
          const limited = chargeRefusal(c);
          if (limited) return limited;
        }
        return c.json({ code: outcome.code }, outcome.status);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // WhatsApp Business (Cloud API) webhook of customers' messages (conversation core, #3131): the same shape as Meta's Page webhook above. GET answers the
  // verify-token handshake in constant time; POST checks X-Hub-Signature-256 over the raw bytes before anything else, caps the body before reading it, charges
  // the per-address limit only to REFUSED requests (a verified notice is never refused for rate), and only parks the signed body for the worker, which finds the
  // org from the stored connection by the phone number id. The route names no org, writes no tenant row and logs nothing of the body.
  const whatsappWebhook = deps.whatsappWebhook;
  if (whatsappWebhook) {
    const whatsappLimit = deps.whatsappWebhookLimit ?? new RateLimiter({ perMinute: WHATSAPP_WEBHOOKS_PER_MINUTE });
    const whatsappReplays = deps.whatsappReplays ?? new WhatsAppReplayCache();
    const chargeWhatsAppRefusal = (c: Context): Response | null => {
      const decision = whatsappLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (decision.allowed) return null;
      warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
      c.header('retry-after', String(decision.retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds }, 429);
    };
    app.get(WHATSAPP_WEBHOOK_PATH, (c) => {
      const outcome = verifyWhatsAppWebhookChallenge(whatsappWebhook, {
        mode: c.req.query('hub.mode'),
        verifyToken: c.req.query('hub.verify_token'),
        challenge: c.req.query('hub.challenge'),
      });
      if (outcome.status === 200) return c.text(outcome.challenge, 200);
      const limited = chargeWhatsAppRefusal(c);
      if (limited) return limited;
      return c.json({ code: outcome.code }, outcome.status);
    });
    app.post(WHATSAPP_WEBHOOK_PATH, bodyLimit({ maxSize: WHATSAPP_MAX_NOTICE_BYTES }), async (c) => {
      try {
        const outcome = await acceptWhatsAppWebhook(runtime, whatsappWebhook, { signature: c.req.header(WHATSAPP_SIGNATURE_HEADER), body: new Uint8Array(await c.req.arrayBuffer()) }, whatsappReplays);
        if (outcome.status === 200) return c.json({ ok: true }, 200);
        if (outcome.status === 401 || outcome.status === 400) {
          const limited = chargeWhatsAppRefusal(c);
          if (limited) return limited;
        }
        return c.json({ code: outcome.code }, outcome.status);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // Meta's data deletion callback, the one URL of the deployment's Meta apps (ads plan section 9 #2219, conversations plan CV6
  // #2305). POST is Meta's signed request, checked against every app secret held before anything else, rate limited per client
  // address, stored nowhere and only queued for the worker, which erases the Ads accounts and the conversations of the connections
  // that person granted; GET is the status page Meta shows the person, answered by the confirmation code.
  const adsInstalled = runtime.installed('ads');
  const adsDeletion = adsInstalled ? deps.adsDeletion : undefined;
  const adsWriteDeletion = adsInstalled ? deps.adsWriteDeletion : undefined;
  const conversationsDeletion = deps.conversationsDeletion;
  if (adsDeletion || adsWriteDeletion || conversationsDeletion) {
    const deletionLimit = deps.adsDeletionLimit ?? new RateLimiter({ perMinute: ADS_DELETION_PER_MINUTE });
    const take = (c: Context): Response | null => {
      const decision = deletionLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (decision.allowed) return null;
      warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
      c.header('retry-after', String(decision.retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', retryAfterSeconds: decision.retryAfterSeconds }, 429);
    };
    app.post(ADS_DELETION_PATH, bodyLimit({ maxSize: MAX_ADS_DELETION_BYTES }), async (c) => {
      const limited = take(c);
      if (limited) return limited;
      try {
        const outcome = await acceptMetaDeletion(runtime, { ads: adsDeletion?.appSecret, adsWrite: adsWriteDeletion?.appSecret, conversations: conversationsDeletion?.appSecret, instagram: conversationsDeletion?.instagramAppSecret }, await c.req.text());
        if (outcome.status !== 200) return c.json({ code: outcome.code }, outcome.status);
        // What Meta asks for: where the person can see the request's status, and the code that names it.
        return c.json({ url: `${config.PUBLIC_URL}${ADS_DELETION_PATH}?code=${outcome.code}`, confirmation_code: outcome.code });
      } catch (error) {
        return problem(c, error);
      }
    });
    app.get(ADS_DELETION_PATH, async (c) => {
      const limited = take(c);
      if (limited) return limited;
      try {
        const status = await metaDeletionStatus(runtime, c.req.query('code') ?? '');
        c.header('cache-control', 'no-store');
        c.header('x-robots-tag', 'noindex');
        return c.html(renderMetaDeletionStatus(status), status ? 200 : 404);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  if (config.INBOUND_DOMAIN && config.INBOUND_SECRET) {
    const domain = config.INBOUND_DOMAIN;
    // The previous value too while a rotation is under way (#1214): the mail worker and the kernel switch apart.
    const secrets = config.INBOUND_SECRET_PREVIOUS ? [config.INBOUND_SECRET, config.INBOUND_SECRET_PREVIOUS] : [config.INBOUND_SECRET];
    app.post('/api/inbound/email', bodyLimit({ maxSize: MAX_EMAIL_BYTES }), async (c) => {
      if (!secretMatches(c.req.header('authorization'), secrets)) return c.json({ code: 'UNAUTHENTICATED' }, 401);
      try {
        const raw = new Uint8Array(await c.req.arrayBuffer());
        // Stored and queued only; the worker parses it and files the attachments (External-tenant gate T5).
        const result = await acceptInboundEmail({ runtime, store, domain }, raw, readRecipientHeader(c));
        return c.json(result, 202);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // The public booking page (#1318), with the crm module: no account. GET reads an event type's free slots; POST either
  // asks for a slot (a body with the visitor's details, answered 202 with a request token), follows a request (a body
  // with only that token, which stays out of the URL and so out of access logs), or reads, cancels or moves a booking
  // with the manage token of its mails (#1319). Each address has budgets, and each
  // event type one for requests whatever the address; the request definer caps requests per type per hour too.
  if (runtime.installed('crm')) {
    const limits = deps.bookingLimits ?? {
      views: new RateLimiter({ perMinute: BOOKING_VIEWS_PER_MINUTE }),
      requests: new RateLimiter({ perMinute: BOOKING_REQUESTS_PER_MINUTE }),
      perType: new RateLimiter({ perMinute: 20 }),
      polls: new RateLimiter({ perMinute: BOOKING_POLLS_PER_MINUTE }),
    };
    const refused = (c: Context, retryAfterSeconds: number) => {
      warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
      c.header('retry-after', String(retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds }, 429);
    };
    const budget = (c: Context, bucket: RateLimiter, key = clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS))) => {
      const decision = bucket.take(key);
      return decision.allowed ? null : refused(c, decision.retryAfterSeconds);
    };
    const notFound = (c: Context) => c.json({ code: 'BOOKING_PAGE_NOT_FOUND', message: 'Không tìm thấy trang đặt lịch này' }, 404);
    const turnstile = deps.turnstile !== undefined ? deps.turnstile : config.TURNSTILE_SECRET ? createTurnstileVerifier(config.TURNSTILE_SECRET) : null;
    app.get('/api/booking/:org/:type', async (c) => {
      const limited = budget(c, limits.views);
      if (limited) return limited;
      c.header('cache-control', 'no-store');
      try {
        const page = await bookingView(runtime, c.req.param('org'), c.req.param('type'), { from: c.req.query('from'), to: c.req.query('to') });
        return page ? c.json(page) : notFound(c);
      } catch (error) {
        return problem(c, error);
      }
    });
    app.post('/api/booking/:org/:type', bodyLimit({ maxSize: 4096 }), async (c) => {
      c.header('cache-control', 'no-store');
      const body: unknown = await c.req.json().catch(() => null);
      const org = c.req.param('org');
      const type = c.req.param('type');
      try {
        // A manage link (#1319): its token alone reads the booking; with an action it asks for a cancel or a move.
        if (body && typeof body === 'object' && 'manage' in body) {
          if (Object.keys(body).length === 1) {
            const limited = budget(c, limits.polls);
            if (limited) return limited;
            const view = await bookingManageView(runtime, org, type, body);
            return view ? c.json(view) : c.json({ code: 'BOOKING_LINK_NOT_FOUND', message: 'Liên kết này không còn dùng được' }, 404);
          }
          const limited = budget(c, limits.requests);
          if (limited) return limited;
          const ask = await bookingManageAsk(runtime, org, type, body);
          return ask ? c.json(ask, 202) : c.json({ code: 'BOOKING_LINK_NOT_FOUND', message: 'Liên kết này không còn dùng được' }, 404);
        }
        // Following a request: the token alone.
        if (body && typeof body === 'object' && Object.keys(body).length === 1 && 'token' in body) {
          const limited = budget(c, limits.polls);
          if (limited) return limited;
          const status = await bookingStatus(runtime, org, type, body);
          return status ? c.json(status) : c.json({ code: 'BOOKING_REQUEST_NOT_FOUND', message: 'Không tìm thấy yêu cầu đặt lịch này' }, 404);
        }
        const limited = budget(c, limits.requests) ?? budget(c, limits.perType, `${org}/${type}`);
        if (limited) return limited;
        // With Turnstile keys set (#1353), a request carries the widget's token, checked with Cloudflare before
        // anything is recorded; the token is not part of the request itself.
        let requestBody = body;
        if (body && typeof body === 'object' && 'turnstile' in body) {
          const { turnstile: _token, ...rest } = body as Record<string, unknown>;
          requestBody = rest;
        }
        if (turnstile) {
          const token = body && typeof body === 'object' ? (body as { turnstile?: unknown }).turnstile : undefined;
          if (typeof token !== 'string' || !(await turnstile(token, clientIp(c, config.TRUSTED_PROXY_HOPS)))) {
            return c.json({ code: 'BOOKING_CHECK_FAILED', message: 'Chưa xác minh được bạn không phải máy, hãy thử lại' }, 403);
          }
        }
        const request = await bookingRequest(runtime, org, type, requestBody);
        return request ? c.json(request, 202) : notFound(c);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // Calendar feeds for Google Calendar or Outlook, which can only fetch a URL: the token is in the path. The posting
  // calendar (#862), with the social module, and a member's bookings (#1382), with the crm module, share the route; a
  // token is looked up as one, then the other (each a 43-character random token, so neither can name the other's
  // feed). Nothing in the kernel logs request paths (and the deploy's Caddyfile keeps no access log), and a failed
  // lookup logs the database error, never the request. An unknown, malformed or revoked token is a plain 404.
  const socialFeeds = runtime.installed('social');
  const bookingFeeds = runtime.installed('crm');
  if (socialFeeds || bookingFeeds) {
    const calendarFeedLimit = deps.calendarFeedLimit ?? new RateLimiter({ perMinute: CALENDAR_FEED_HITS_PER_MINUTE });
    app.get('/cal/:file', async (c) => {
      const decision = calendarFeedLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (!decision.allowed) {
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        c.header('retry-after', String(decision.retryAfterSeconds));
        return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds: decision.retryAfterSeconds }, 429);
      }
      const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
      try {
        const file = c.req.param('file');
        const token = file.endsWith('.ics') ? file.slice(0, -4) : null;
        const now = new Date();
        let ics: string | null = null;
        if (token && socialFeeds) {
          const feed = await calendarFeed(runtime, token);
          if (feed) ics = renderIcs(feed, appUrl(config), now, config.BRAND_NAME);
        }
        if (token && ics === null && bookingFeeds) {
          const feed = await bookingFeed(runtime, token);
          if (feed) ics = renderBookingFeedIcs(feed, appUrl(config), now, config.BRAND_NAME);
        }
        if (ics === null) return c.text('Không tìm thấy lịch này', 404, headers);
        return c.body(ics, 200, { ...headers, 'content-type': 'text/calendar; charset=utf-8' });
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // A sent quote's page (#2694, crm module): the same edge as the report page, with its own budget per client. The link's token is the only credential; it comes in the
  // body, never the URL, and a bad, revoked or expired one gets the one refusal.
  if (runtime.installed('crm')) {
    const quoteLimit = deps.quoteLimit ?? new RateLimiter({ perMinute: QUOTE_VIEWS_PER_MINUTE });
    app.post('/api/quote/view', bodyLimit({ maxSize: 1024 }), async (c) => {
      const decision = quoteLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (!decision.allowed) {
        // Behind a proxy that is not trusted, every client shares one budget: say so, as the other public pages do.
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        c.header('retry-after', String(decision.retryAfterSeconds));
        return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds: decision.retryAfterSeconds }, 429);
      }
      c.header('cache-control', 'no-store');
      c.header('referrer-policy', 'no-referrer');
      try {
        const view = await quoteView(runtime, await c.req.json().catch(() => null));
        return view ? c.json(view) : c.json({ code: 'QUOTE_LINK_INVALID', message: 'Liên kết báo giá không hợp lệ, đã bị thu hồi hoặc đã hết hạn' }, 404);
      } catch (error) {
        return problem(c, error);
      }
    });
    // The logo of that quote's letterhead (#2814), for the page to show: the token in the body again, the one refusal for a bad link or a quote with no logo, never cached.
    const quoteLogoLimit = deps.quoteLogoLimit ?? new RateLimiter({ perMinute: QUOTE_VIEWS_PER_MINUTE });
    // Each client has a budget, but the route needs no account, so the reads in flight are also capped for the whole process: a slow store cannot pile up buffers across clients.
    const quoteLogoReads = deps.quoteLogoReads ?? new ConcurrencyLimiter({ total: QUOTE_LOGO_READS_MAX, perKey: QUOTE_LOGO_READS_MAX });
    app.post('/api/quote/logo', bodyLimit({ maxSize: 1024 }), async (c) => {
      const decision = quoteLogoLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (!decision.allowed) {
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        c.header('retry-after', String(decision.retryAfterSeconds));
        return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds: decision.retryAfterSeconds }, 429);
      }
      c.header('cache-control', 'no-store');
      c.header('referrer-policy', 'no-referrer');
      const release = quoteLogoReads.tryAcquire('quote-logo');
      if (!release) {
        c.header('retry-after', '2');
        return c.json({ code: 'QUOTE_LOGO_BUSY', message: 'Máy chủ đang bận, hãy thử lại sau vài giây' }, 503);
      }
      try {
        const image = await quoteLogo(runtime, store, await c.req.json().catch(() => null));
        if (!image) return c.json({ code: 'QUOTE_LINK_INVALID', message: 'Liên kết báo giá không hợp lệ, đã bị thu hồi hoặc đã hết hạn' }, 404);
        return new Response(body(image.bytes), {
          headers: { 'content-type': image.contentType, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" },
        });
      } catch (error) {
        return problem(c, error);
      } finally {
        release();
      }
    });
  }

  // The published minutes a link shares with a person outside the org (#4822, meetings module): the same edge as the quote page, with its own budget per client. The link's token is the only
  // credential; it comes in the body, never the URL. A bad, revoked or expired token, a switch or an app that is off and minutes that are not published all get the one refusal. The answer is
  // never cached, never sends a referrer and tells search engines to keep it out of their index.
  if (runtime.installed('meetings')) {
    const minutesLimit = deps.minutesLimit ?? new RateLimiter({ perMinute: MINUTES_VIEWS_PER_MINUTE });
    app.post('/api/minutes/view', bodyLimit({ maxSize: 1024 }), async (c) => {
      const decision = minutesLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      c.header('cache-control', 'no-store');
      c.header('referrer-policy', 'no-referrer');
      c.header('x-robots-tag', 'noindex, nofollow');
      if (!decision.allowed) {
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        c.header('retry-after', String(decision.retryAfterSeconds));
        return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds: decision.retryAfterSeconds }, 429);
      }
      try {
        const view = await minutesView(runtime, await c.req.json().catch(() => null));
        return view ? c.json(view) : c.json({ code: 'MINUTES_LINK_INVALID', message: 'Liên kết biên bản không hợp lệ, đã bị thu hồi hoặc đã hết hạn' }, 404);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // Orgless public eSign link endpoints (#3324, docs/plan/esign.md): credentials stay out of query strings,
  // every answer sets Referrer-Policy: no-referrer and Cache-Control: no-store, disabled/expired/waiting states
  // return one opaque 404, and rate/concurrency caps apply without any CAPTCHA gate (#203).
  if (runtime.installed('sign')) {
    const signBilling: SignBilling = deps.billing ?? { entitlements: async () => ['full'] };
    const signViewLimit = deps.signLimits?.views ?? new RateLimiter({ perMinute: SIGN_VIEWS_PER_MINUTE });
    const signTokenViewLimit = deps.signLimits?.tokenViews ?? new RateLimiter({ perMinute: SIGN_TOKEN_VIEWS_PER_MINUTE });
    const signPdfLimit = deps.signLimits?.pdfs ?? new RateLimiter({ perMinute: SIGN_PDFS_PER_MINUTE });
    const signTokenPdfLimit = deps.signLimits?.tokenPdfs ?? new RateLimiter({ perMinute: SIGN_TOKEN_PDFS_PER_MINUTE });
    // Cap combined in-process buffered PDF memory at SIGN_PDF_READS_MAX (8 slots * 25 MiB = 200 MiB) while
    // limiting public PDF/QR routes to half (4 slots, max 2 per IP / IPv6 /64) so anonymous slow readers
    // never starve the remaining 4 slots reserved for authenticated /api/v1/sign/* downloads (#4682).
    const publicPdfSlots = Math.max(2, Math.floor(SIGN_PDF_READS_MAX / 2));
    const signProcessPdfPool = new ConcurrencyLimiter({ total: SIGN_PDF_READS_MAX, perKey: SIGN_PDF_READS_MAX });
    const signPdfReads = deps.signLimits?.pdfReads ?? new ConcurrencyLimiter({ total: publicPdfSlots, perKey: publicPdfSlots });
    const signPublicPdfPool = new ConcurrencyLimiter({ total: publicPdfSlots, perKey: publicPdfSlots });
    const signPublicPdfPerIp = new ConcurrencyLimiter({ total: publicPdfSlots, perKey: 2 });
    const usePublicSignPdfPool = !deps.signLimits?.pdfReads;
    const useApiV1PdfPool = !deps.signApiV1Limits?.pdfReads;
    const tryAcquirePublicSignPdfSlot = (
      c: Context,
      routeKey: 'sign-pdf' | 'sign-deposit-qr',
    ): (() => void) | null => {
      const releaseLimiter = signPdfReads.tryAcquire(routeKey);
      if (!releaseLimiter) return null;
      if (!usePublicSignPdfPool) return releaseLimiter;
      const releaseIp = signPublicPdfPerIp.tryAcquire(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (!releaseIp) {
        releaseLimiter();
        return null;
      }
      const releasePublicPool = signPublicPdfPool.tryAcquire('public-pdf-pool');
      if (!releasePublicPool) {
        releaseIp();
        releaseLimiter();
        return null;
      }
      const releaseProcessPool = signProcessPdfPool.tryAcquire('pdf-pool');
      if (!releaseProcessPool) {
        releasePublicPool();
        releaseIp();
        releaseLimiter();
        return null;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseProcessPool();
        releasePublicPool();
        releaseIp();
        releaseLimiter();
      };
    };
    const signOtpReqLimit = deps.signLimits?.otpRequest ?? new RateLimiter({ perMinute: SIGN_OTP_REQUESTS_PER_MINUTE });
    const signTokenOtpReqLimit = deps.signLimits?.tokenOtpRequest ?? new RateLimiter({ perMinute: SIGN_TOKEN_OTP_REQUESTS_PER_MINUTE });
    const signOtpVerifyLimit = deps.signLimits?.otpVerify ?? new RateLimiter({ perMinute: SIGN_OTP_VERIFIES_PER_MINUTE });
    const signTokenOtpVerifyLimit = deps.signLimits?.tokenOtpVerify ?? new RateLimiter({ perMinute: SIGN_TOKEN_OTP_VERIFIES_PER_MINUTE });
    const signSubmitLimit = deps.signLimits?.submit ?? new RateLimiter({ perMinute: SIGN_SUBMITS_PER_MINUTE });
    const signTokenSubmitLimit = deps.signLimits?.tokenSubmit ?? new RateLimiter({ perMinute: SIGN_TOKEN_SUBMITS_PER_MINUTE });
    const signDelegateLimit = deps.signLimits?.delegate ?? new RateLimiter({ perMinute: SIGN_DELEGATES_PER_MINUTE });
    const signTokenDelegateLimit = deps.signLimits?.tokenDelegate ?? new RateLimiter({ perMinute: SIGN_TOKEN_DELEGATES_PER_MINUTE });
    const signAttachmentLimit = deps.signLimits?.attachment ?? new RateLimiter({ perMinute: SIGN_ATTACHMENTS_PER_MINUTE });
    const signTokenAttachmentLimit = deps.signLimits?.tokenAttachment ?? new RateLimiter({ perMinute: SIGN_TOKEN_ATTACHMENTS_PER_MINUTE });
    const signAttachmentUploads = deps.signLimits?.attachmentUploads ?? new ConcurrencyLimiter({ total: SIGN_ATTACHMENT_UPLOADS_MAX, perKey: SIGN_ATTACHMENT_UPLOADS_MAX });
    const signDepositQrLimit = deps.signLimits?.depositQr ?? new RateLimiter({ perMinute: SIGN_DEPOSIT_QR_PER_MINUTE });
    const signTokenDepositQrLimit = deps.signLimits?.tokenDepositQr ?? new RateLimiter({ perMinute: SIGN_TOKEN_DEPOSIT_QR_PER_MINUTE });
    const signDepositNoticeLimit = deps.signLimits?.depositNotice ?? new RateLimiter({ perMinute: SIGN_DEPOSIT_NOTICE_PER_MINUTE });
    const signTokenDepositNoticeLimit = deps.signLimits?.tokenDepositNotice ?? new RateLimiter({ perMinute: SIGN_TOKEN_DEPOSIT_NOTICE_PER_MINUTE });
    const signDepositNoticeUploads = deps.signLimits?.depositNoticeUploads ?? new ConcurrencyLimiter({ total: SIGN_DEPOSIT_NOTICE_UPLOADS_MAX, perKey: SIGN_DEPOSIT_NOTICE_UPLOADS_MAX });
    const signVerifyLimit = deps.signLimits?.verify ?? new RateLimiter({ perMinute: SIGN_VERIFY_PER_MINUTE });

    const setSignSecurityHeaders = (c: Context) => {
      c.header('referrer-policy', 'no-referrer');
      c.header('cache-control', 'no-store');
      c.header('x-content-type-options', 'nosniff');
    };

    const signBodyLimit = (maxSize: number) =>
      bodyLimit({
        maxSize,
        onError: (c) => {
          setSignSecurityHeaders(c);
          return c.text('Payload Too Large', 413);
        },
      });

    const signEdgeGuard = (ipLimit: RateLimiter): MiddlewareHandler => async (c, next) => {
      setSignSecurityHeaders(c);
      if (c.req.query('token') !== undefined) {
        return c.json({ code: 'SIGN_QUERY_TOKEN_FORBIDDEN', message: 'Signing tokens must be submitted in the request body' }, 400);
      }
      const decision = ipLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (!decision.allowed) {
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        c.header('retry-after', String(decision.retryAfterSeconds));
        return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds: decision.retryAfterSeconds }, 429);
      }
      await next();
    };

    const signRateLimited = (c: Context, retryAfterSeconds: number) => {
      c.header('retry-after', String(retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds }, 429);
    };

    const signOpaqueNotFound = (c: Context) => c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
    const signMeta = (c: Context) => ({ ip: clientIp(c, config.TRUSTED_PROXY_HOPS), userAgent: c.req.header('user-agent') ?? null });

    app.post('/api/sign/view', signEdgeGuard(signViewLimit), signBodyLimit(2048), async (c) => {
      try {
        const res = await runSignView(runtime, signBilling, await c.req.json().catch(() => null), signMeta(c), (hash) => signTokenViewLimit.take(hash));
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        return c.json(res.view);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/pdf', signEdgeGuard(signPdfLimit), signBodyLimit(2048), async (c) => {
      try {
        const lookup = await resolvePublicPdf(runtime, signBilling, await c.req.json().catch(() => null), (hash) => signTokenPdfLimit.take(hash));
        if (lookup.status === 'not_found') return signOpaqueNotFound(c);
        if (lookup.status === 'rate_limited') return signRateLimited(c, lookup.retryAfterSeconds);
        if (lookup.status === 'otp_required') {
          return c.json({ code: 'OTP_REQUIRED', message: 'Email OTP verification is required before viewing document' }, 403);
        }
        const release = tryAcquirePublicSignPdfSlot(c, 'sign-pdf');
        if (!release) {
          c.header('retry-after', '2');
          return c.json({ code: 'SIGN_PDF_BUSY', message: 'Máy chủ đang bận, hãy thử lại sau vài giây' }, 503);
        }
        let passedToStream = false;
        try {
          const bytes = await readPublicPdfBytes(store, lookup.source);
          const stream = releaseOnResponseClose(bytes, release, c);
          passedToStream = true;
          return new Response(stream, {
            headers: {
              'content-type': 'application/pdf',
              'content-length': String(bytes.byteLength),
              'content-disposition': 'inline; filename="document.pdf"',
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'none'; sandbox",
            },
          });
        } finally {
          if (!passedToStream) release();
        }
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/otp/request', signEdgeGuard(signOtpReqLimit), signBodyLimit(2048), async (c) => {
      try {
        const res = await runSignOtpRequest(runtime, signBilling, await c.req.json().catch(() => null), (hash) => signTokenOtpReqLimit.take(hash));
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        return c.json(res.result);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/otp/verify', signEdgeGuard(signOtpVerifyLimit), signBodyLimit(2048), async (c) => {
      try {
        const res = await runSignOtpVerify(runtime, signBilling, await c.req.json().catch(() => null), signMeta(c), (hash) => signTokenOtpVerifyLimit.take(hash));
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        if (res.result.ok) return c.json(res.result, 200);
        if (res.result.locked) return c.json(res.result, 423);
        return c.json(res.result, 401);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/submit', signEdgeGuard(signSubmitLimit), signBodyLimit(4 * 1024 * 1024), async (c) => {
      try {
        const res = await runSignSubmit(runtime, signBilling, await c.req.json().catch(() => null), signMeta(c), (hash) => signTokenSubmitLimit.take(hash));
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'already_used') return c.json({ code: 'SIGN_ALREADY_SUBMITTED', message: 'This signing link has already been used' }, 409);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        return c.json(res.result);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/decline', signEdgeGuard(signSubmitLimit), signBodyLimit(8 * 1024), async (c) => {
      try {
        const res = await runSignDecline(runtime, signBilling, await c.req.json().catch(() => null), signMeta(c), (hash) => signTokenSubmitLimit.take(hash));
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'already_used') return c.json({ code: 'SIGN_ALREADY_SUBMITTED', message: 'This signing link has already been used' }, 409);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        return c.json(res.result);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/delegate', signEdgeGuard(signDelegateLimit), signBodyLimit(4096), async (c) => {
      try {
        const res = await runSignDelegate(runtime, signBilling, await c.req.json().catch(() => null), signMeta(c), (hash) => signTokenDelegateLimit.take(hash));
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'already_used') return c.json({ code: 'SIGN_ALREADY_SUBMITTED', message: 'This signing link has already been used' }, 409);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        return c.json(res.result);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/attachment', signEdgeGuard(signAttachmentLimit), signBodyLimit(SIGN_ATTACHMENT_MAX_BYTES + 4 * 1024 * 1024), async (c) => {
      const release = signAttachmentUploads.tryAcquire('sign-attachment');
      if (!release) {
        c.header('retry-after', '2');
        return c.json({ code: 'SIGN_ATTACHMENT_BUSY', message: 'Máy chủ đang xử lý nhiều tệp đính kèm, hãy thử lại sau vài giây' }, 503);
      }
      try {
        const ct = (c.req.header('content-type') ?? '').toLowerCase();
        let token: unknown = null;
        let fieldId: unknown = null;
        let filename: unknown = null;
        let bytes: Uint8Array | null = null;
        let oversize = false;
        let invalidEncoding = false;
        if (ct.includes('multipart/form-data')) {
          const form = await c.req.parseBody().catch(() => null);
          if (!form) return signOpaqueNotFound(c);
          token = form.token;
          fieldId = form.fieldId;
          const file = form.file;
          if (file instanceof File) {
            filename = file.name;
            if (file.size > SIGN_ATTACHMENT_MAX_BYTES) {
              oversize = true;
            } else {
              bytes = new Uint8Array(await file.arrayBuffer());
            }
          }
        } else {
          const json = await c.req.json().catch(() => null);
          if (!json || typeof json !== 'object') return signOpaqueNotFound(c);
          const payload = json as Record<string, unknown>;
          token = payload.token;
          fieldId = payload.fieldId;
          filename = payload.filename;
          if (typeof payload.contentBase64 === 'string') {
            const cleanBase64 = payload.contentBase64.replace(/\s+/g, '');
            const maxBase64Chars = Math.ceil((SIGN_ATTACHMENT_MAX_BYTES * 4) / 3) + 16;
            if (cleanBase64.length > maxBase64Chars) {
              oversize = true;
            } else if (cleanBase64.length > 0) {
              if (cleanBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
                invalidEncoding = true;
              } else {
                bytes = new Uint8Array(Buffer.from(cleanBase64, 'base64'));
              }
            }
          }
        }
        const res = await runSignAttachmentUpload(
          runtime,
          store,
          signBilling,
          { token, fieldId, filename, bytes, oversize, invalidEncoding },
          signMeta(c),
          (hash) => signTokenAttachmentLimit.take(hash),
        );
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'already_used') return c.json({ code: 'SIGN_ALREADY_SUBMITTED', message: 'This signing link has already been used' }, 409);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        return c.json(res.result);
      } catch (error) {
        return problem(c, error);
      } finally {
        release();
      }
    });

    app.post('/api/sign/verify', signEdgeGuard(signVerifyLimit), signBodyLimit(2048), async (c) => {
      try {
        const verified = await runSignVerify(runtime, signBilling, await c.req.json().catch(() => null));
        return verified ? c.json(verified) : signOpaqueNotFound(c);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/deposit-qr', signEdgeGuard(signDepositQrLimit), signBodyLimit(2048), async (c) => {
      try {
        const lookup = await resolvePublicDepositQr(
          runtime,
          signBilling,
          await c.req.json().catch(() => null),
          (hash) => signTokenDepositQrLimit.take(hash),
        );
        if (lookup.status === 'not_found') return signOpaqueNotFound(c);
        if (lookup.status === 'rate_limited') return signRateLimited(c, lookup.retryAfterSeconds);
        if (lookup.status === 'otp_required') {
          return c.json({ code: 'OTP_REQUIRED', message: 'Email OTP verification is required before viewing deposit QR' }, 403);
        }
        const release = tryAcquirePublicSignPdfSlot(c, 'sign-deposit-qr');
        if (!release) {
          c.header('retry-after', '2');
          return c.json({ code: 'SIGN_PDF_BUSY', message: 'Máy chủ đang bận, hãy thử lại sau vài giây' }, 503);
        }
        let passedToStream = false;
        try {
          const bytes = await readPublicDepositQrBytes(store, lookup.source);
          if (!bytes) return signOpaqueNotFound(c);
          const stream = releaseOnResponseClose(bytes, release, c);
          passedToStream = true;
          return new Response(stream, {
            headers: {
              'content-type': 'image/png',
              'content-length': String(bytes.byteLength),
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'none'; sandbox",
            },
          });
        } finally {
          if (!passedToStream) release();
        }
      } catch (error) {
        return problem(c, error);
      }
    });

    const signDepositNoticeSlot: MiddlewareHandler = async (c, next) => {
      const release = signDepositNoticeUploads.tryAcquire('sign-deposit-notice');
      if (!release) {
        c.header('retry-after', '2');
        return c.json({ code: 'SIGN_ATTACHMENT_BUSY', message: 'Máy chủ đang xử lý nhiều yêu cầu, hãy thử lại sau vài giây' }, 503);
      }
      try {
        await next();
      } finally {
        release();
      }
    };

    app.post('/api/sign/deposit-notice', signEdgeGuard(signDepositNoticeLimit), signDepositNoticeSlot, signBodyLimit(SIGN_DEPOSIT_PROOF_MAX_BYTES + 1024 * 1024), async (c) => {
      try {
        const ct = (c.req.header('content-type') ?? '').toLowerCase();
        let token: unknown = null;
        let note: unknown = null;
        let filename: unknown = null;
        let bytes: Uint8Array | null = null;
        let oversize = false;
        let invalidEncoding = false;
        let emptyFile = false;
        if (ct.includes('multipart/form-data')) {
          const form = await c.req.parseBody().catch(() => null);
          if (!form) return signOpaqueNotFound(c);
          token = form.token;
          note = form.note ?? null;
          const file = form.file;
          if (file instanceof File) {
            filename = file.name;
            if (file.size === 0) {
              emptyFile = true;
            } else if (file.size > SIGN_DEPOSIT_PROOF_MAX_BYTES) {
              oversize = true;
            } else {
              bytes = new Uint8Array(await file.arrayBuffer());
            }
          } else if (file !== undefined && file !== null && file !== '') {
            invalidEncoding = true;
          }
        } else {
          const json = await c.req.json().catch(() => null);
          if (!json || typeof json !== 'object') return signOpaqueNotFound(c);
          const payload = json as Record<string, unknown>;
          token = payload.token;
          note = payload.note ?? null;
          filename = payload.filename;
          if (typeof payload.contentBase64 === 'string') {
            const cleanBase64 = payload.contentBase64.replace(/\s+/g, '');
            const maxBase64Chars = Math.ceil((SIGN_DEPOSIT_PROOF_MAX_BYTES * 4) / 3) + 16;
            if (cleanBase64.length === 0) {
              emptyFile = true;
            } else if (cleanBase64.length > maxBase64Chars) {
              oversize = true;
            } else if (cleanBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleanBase64)) {
              invalidEncoding = true;
            } else {
              bytes = new Uint8Array(Buffer.from(cleanBase64, 'base64'));
            }
          } else if (payload.contentBase64 !== undefined && payload.contentBase64 !== null) {
            invalidEncoding = true;
          }
        }
        const res = await runSignDepositNotice(
          runtime,
          store,
          signBilling,
          { token, note, filename, bytes, oversize, invalidEncoding, emptyFile },
          signMeta(c),
          (hash) => signTokenDepositNoticeLimit.take(hash),
        );
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        return c.json(res.result);
      } catch (error) {
        return problem(c, error);
      }
    });

    const signDirectViewLimit = deps.signDirectLimits?.views ?? new RateLimiter({ perMinute: SIGN_DIRECT_VIEWS_PER_MINUTE });
    const signDirectTokenViewLimit = deps.signDirectLimits?.tokenViews ?? new RateLimiter({ perMinute: SIGN_DIRECT_TOKEN_VIEWS_PER_MINUTE });
    const signDirectPdfLimit = deps.signDirectLimits?.pdfs ?? new RateLimiter({ perMinute: SIGN_DIRECT_PDFS_PER_MINUTE });
    const signDirectTokenPdfLimit = deps.signDirectLimits?.tokenPdfs ?? new RateLimiter({ perMinute: SIGN_DIRECT_TOKEN_PDFS_PER_MINUTE });
    const signDirectOtpReqLimit = deps.signDirectLimits?.otpRequest ?? new RateLimiter({ perMinute: SIGN_DIRECT_OTP_REQUESTS_PER_MINUTE });
    const signDirectTokenOtpReqLimit = deps.signDirectLimits?.tokenOtpRequest ?? new RateLimiter({ perMinute: SIGN_DIRECT_TOKEN_OTP_REQUESTS_PER_MINUTE });
    const signDirectEmailOtpReqLimit = deps.signDirectLimits?.emailOtpRequest ?? new RateLimiter({ perMinute: SIGN_DIRECT_EMAIL_OTP_REQUESTS_PER_MINUTE });
    const signDirectOtpVerifyLimit = deps.signDirectLimits?.otpVerify ?? new RateLimiter({ perMinute: SIGN_DIRECT_OTP_VERIFIES_PER_MINUTE });
    const signDirectTokenOtpVerifyLimit = deps.signDirectLimits?.tokenOtpVerify ?? new RateLimiter({ perMinute: SIGN_DIRECT_TOKEN_OTP_VERIFIES_PER_MINUTE });
    const signDirectStartLimit = deps.signDirectLimits?.start ?? new RateLimiter({ perMinute: SIGN_DIRECT_STARTS_PER_MINUTE });
    const signDirectTokenStartLimit = deps.signDirectLimits?.tokenStart ?? new RateLimiter({ perMinute: SIGN_DIRECT_TOKEN_STARTS_PER_MINUTE });

    app.post('/api/sign/direct/view', signEdgeGuard(signDirectViewLimit), signBodyLimit(2048), async (c) => {
      try {
        const res = await runSignDirectView(runtime, signBilling, await c.req.json().catch(() => null), (hash) => signDirectTokenViewLimit.take(hash));
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        return c.json(res.view);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/direct/pdf', signEdgeGuard(signDirectPdfLimit), signBodyLimit(2048), async (c) => {
      try {
        const lookup = await resolvePublicDirectPdf(runtime, signBilling, await c.req.json().catch(() => null), (hash) => signDirectTokenPdfLimit.take(hash));
        if (lookup.status === 'not_found') return signOpaqueNotFound(c);
        if (lookup.status === 'rate_limited') return signRateLimited(c, lookup.retryAfterSeconds);
        if (lookup.status === 'otp_required') {
          return c.json({ code: 'OTP_REQUIRED', message: 'Email OTP verification is required before viewing document' }, 403);
        }
        const release = tryAcquirePublicSignPdfSlot(c, 'sign-pdf');
        if (!release) {
          c.header('retry-after', '2');
          return c.json({ code: 'SIGN_PDF_BUSY', message: 'Máy chủ đang bận, hãy thử lại sau vài giây' }, 503);
        }
        let passedToStream = false;
        try {
          const bytes = await readPublicPdfBytes(store, lookup.source);
          const stream = releaseOnResponseClose(bytes, release, c);
          passedToStream = true;
          return new Response(stream, {
            headers: {
              'content-type': 'application/pdf',
              'content-length': String(bytes.byteLength),
              'content-disposition': 'inline; filename="document.pdf"',
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'none'; sandbox",
            },
          });
        } finally {
          if (!passedToStream) release();
        }
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/direct/otp/request', signEdgeGuard(signDirectOtpReqLimit), signBodyLimit(2048), async (c) => {
      try {
        const res = await runSignDirectOtpRequest(
          runtime,
          signBilling,
          await c.req.json().catch(() => null),
          (hash) => signDirectTokenOtpReqLimit.take(hash),
          (bucket) => signDirectEmailOtpReqLimit.take(bucket),
        );
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        return c.json(res.result);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/direct/otp/verify', signEdgeGuard(signDirectOtpVerifyLimit), signBodyLimit(2048), async (c) => {
      try {
        const res = await runSignDirectOtpVerify(runtime, signBilling, await c.req.json().catch(() => null), (hash) => signDirectTokenOtpVerifyLimit.take(hash));
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        if (res.result.ok) return c.json(res.result, 200);
        if (res.result.locked) return c.json(res.result, 423);
        return c.json(res.result, 401);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/direct/start', signEdgeGuard(signDirectStartLimit), signBodyLimit(4096), async (c) => {
      try {
        const res = await runSignDirectStart(runtime, signBilling, await c.req.json().catch(() => null), signMeta(c), (hash) => signDirectTokenStartLimit.take(hash));
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        return c.json(res.result);
      } catch (error) {
        return problem(c, error);
      }
    });

    const signPublicHubListLimit = deps.signPublicHubLimits?.lists ?? new RateLimiter({ perMinute: SIGN_PUBLIC_HUB_LISTS_PER_MINUTE });
    const signPublicHubActionLimit = deps.signPublicHubLimits?.actions ?? new RateLimiter({ perMinute: SIGN_PUBLIC_HUB_ACTIONS_PER_MINUTE });
    const signPublicHubTemplateLimit = deps.signPublicHubLimits?.templateActions ?? new RateLimiter({ perMinute: SIGN_PUBLIC_HUB_TEMPLATE_ACTIONS_PER_MINUTE });
    const signPublicHubEmailOtpLimit = deps.signPublicHubLimits?.emailOtpRequest ?? new RateLimiter({ perMinute: SIGN_PUBLIC_HUB_EMAIL_OTP_REQUESTS_PER_MINUTE });

    app.get('/api/sign/public-hub/:orgSlug', signEdgeGuard(signPublicHubListLimit), async (c) => {
      try {
        const res = await runSignPublicHubList(runtime, signBilling, c.req.param('orgSlug'));
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        return c.json(res.hub);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/sign/public-hub/:orgSlug', signEdgeGuard(signPublicHubActionLimit), signBodyLimit(4096), async (c) => {
      try {
        const orgSlug = c.req.param('orgSlug');
        const rawBody = await c.req.json().catch(() => null);
        if (rawBody && typeof rawBody === 'object' && (rawBody as Record<string, unknown>).action === 'pdf') {
          const lookup = await resolvePublicHubPdf(runtime, signBilling, orgSlug, rawBody, (bucket) => signPublicHubTemplateLimit.take(bucket), signMeta(c));
          if (lookup.status === 'not_found') return signOpaqueNotFound(c);
          if (lookup.status === 'rate_limited') return signRateLimited(c, lookup.retryAfterSeconds);
          if (lookup.status === 'otp_required') {
            return c.json({ code: 'OTP_REQUIRED', message: 'Email OTP verification is required before viewing document' }, 403);
          }
          const release = tryAcquirePublicSignPdfSlot(c, 'sign-pdf');
          if (!release) {
            c.header('retry-after', '2');
            return c.json({ code: 'SIGN_PDF_BUSY', message: 'Máy chủ đang bận, hãy thử lại sau vài giây' }, 503);
          }
          let passedToStream = false;
          try {
            const bytes = await readPublicPdfBytes(store, lookup.source);
            const stream = releaseOnResponseClose(bytes, release, c);
            passedToStream = true;
            return new Response(stream, {
              headers: {
                'content-type': 'application/pdf',
                'content-length': String(bytes.byteLength),
                'content-disposition': 'inline; filename="document.pdf"',
                'cache-control': 'no-store',
                'referrer-policy': 'no-referrer',
                'x-content-type-options': 'nosniff',
                'content-security-policy': "default-src 'none'; sandbox",
              },
            });
          } finally {
            if (!passedToStream) release();
          }
        }

        const res = await runSignPublicHubAction(runtime, signBilling, orgSlug, rawBody, signMeta(c), {
          limitTemplate: (bucket) => signPublicHubTemplateLimit.take(bucket),
          limitEmail: (bucket) => signPublicHubEmailOtpLimit.take(bucket),
        });
        if (res.status === 'not_found') return signOpaqueNotFound(c);
        if (res.status === 'rate_limited') return signRateLimited(c, res.retryAfterSeconds);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        if (res.status === 'otp_verify_result') {
          if (res.result.ok) return c.json(res.result, 200);
          if (res.result.locked) return c.json(res.result, 423);
          return c.json(res.result, 401);
        }
        return c.json(res.data);
      } catch (error) {
        return problem(c, error);
      }
    });

    // Scoped external REST API (/api/v1/sign/*, #4441, eSign Slice 5c):
    // Bearer ludy_sk_... API key hashed via SHA-256, org_app_on + entitlement opaque 404,
    // sign:read vs sign:draft scope checks, per-IP + per-key rate limits, Cache-Control: no-store,
    // strict exclusion of hr_contract and meeting_minutes envelopes, and draft-only template creation.
    const signApiV1IpLimit = deps.signApiV1Limits?.ip ?? new RateLimiter({ perMinute: SIGN_API_V1_IP_PER_MINUTE });
    const signApiV1KeyReadLimit = deps.signApiV1Limits?.keyRead ?? new RateLimiter({ perMinute: SIGN_API_V1_KEY_READ_PER_MINUTE });
    const signApiV1KeyDraftLimit = deps.signApiV1Limits?.keyDraft ?? new RateLimiter({ perMinute: SIGN_API_V1_KEY_DRAFT_PER_MINUTE });
    const signApiV1PdfReads = deps.signApiV1Limits?.pdfReads ?? new ConcurrencyLimiter({ total: SIGN_PDF_READS_MAX });
    const tryAcquireApiV1SignPdfSlot = (orgId: string): (() => void) | null => {
      const releaseLimiter = signApiV1PdfReads.tryAcquire(orgId);
      if (!releaseLimiter) return null;
      if (!useApiV1PdfPool) return releaseLimiter;
      const releaseProcessPool = signProcessPdfPool.tryAcquire('pdf-pool');
      if (!releaseProcessPool) {
        releaseLimiter();
        return null;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseProcessPool();
        releaseLimiter();
      };
    };

    const signApiV1Guard: MiddlewareHandler = async (c, next) => {
      setSignSecurityHeaders(c);
      if (
        c.req.query('token') !== undefined ||
        c.req.query('api_key') !== undefined ||
        c.req.query('apiKey') !== undefined ||
        c.req.query('access_token') !== undefined ||
        c.req.query('key') !== undefined
      ) {
        return c.json({ code: 'SIGN_QUERY_TOKEN_FORBIDDEN', message: 'API keys must be sent in the Authorization: Bearer header' }, 400);
      }
      const decision = signApiV1IpLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (!decision.allowed) {
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        c.header('retry-after', String(decision.retryAfterSeconds));
        return c.json({ code: 'RATE_LIMITED', message: 'Too many requests, please retry later', retryAfterSeconds: decision.retryAfterSeconds }, 429);
      }
      await next();
    };

    const replySignApiV1NonOk = (c: Context, res: Exclude<SignApiV1Outcome<unknown>, { status: 'ok' }>) => {
      if (res.status === 'unauthorized') {
        c.header('www-authenticate', 'Bearer');
        return c.json({ code: 'UNAUTHENTICATED', message: 'Invalid or expired API key' }, 401);
      }
      if (res.status === 'not_found') return signOpaqueNotFound(c);
      if (res.status === 'forbidden') {
        return c.json({ code: 'FORBIDDEN', message: `API key requires scope ${res.requiredScope}` }, 403);
      }
      c.header('retry-after', String(res.retryAfterSeconds));
      return c.json(
        { code: 'RATE_LIMITED', message: 'Too many requests, please retry later', retryAfterSeconds: res.retryAfterSeconds },
        429,
      );
    };

    app.get('/api/v1/sign/envelopes', signApiV1Guard, async (c) => {
      try {
        const res = await runSignApiV1EnvelopesList(
          runtime,
          signBilling,
          c.req.header('authorization'),
          { status: c.req.query('status'), limit: c.req.query('limit') },
          (hash) => signApiV1KeyReadLimit.take(hash),
          (hash) => signApiV1KeyReadLimit.peek(hash),
        );
        if (res.status !== 'ok') return replySignApiV1NonOk(c, res);
        return c.json(res.data);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.get('/api/v1/sign/envelopes/:id', signApiV1Guard, async (c) => {
      try {
        const res = await runSignApiV1EnvelopeGet(
          runtime,
          signBilling,
          c.req.header('authorization'),
          c.req.param('id'),
          (hash) => signApiV1KeyReadLimit.take(hash),
          (hash) => signApiV1KeyReadLimit.peek(hash),
        );
        if (res.status !== 'ok') return replySignApiV1NonOk(c, res);
        return c.json(res.data);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.get('/api/v1/sign/envelopes/:id/sealed', signApiV1Guard, async (c) => {
      try {
        const lookup = await resolveSignApiV1FileSource(
          runtime,
          signBilling,
          c.req.header('authorization'),
          c.req.param('id'),
          'sealed',
          (hash) => signApiV1KeyReadLimit.take(hash),
          (hash) => signApiV1KeyReadLimit.peek(hash),
        );
        if (lookup.status !== 'ok') return replySignApiV1NonOk(c, lookup);
        const release = tryAcquireApiV1SignPdfSlot(lookup.data.orgId);
        if (!release) {
          c.header('retry-after', '2');
          return c.json({ code: 'SIGN_PDF_BUSY', message: 'Server is busy, please retry shortly' }, 503);
        }
        let passedToStream = false;
        try {
          const bytes = await readSignApiV1ArtifactBytes(store, lookup.data);
          // Hono turns HEAD into GET with null response body without pulling/canceling stream, so only wrap GET (#4682).
          const stream = c.req.method === 'HEAD' ? null : releaseOnResponseClose(bytes, release, c);
          if (stream) passedToStream = true;
          return new Response(stream, {
            headers: {
              'content-type': 'application/pdf',
              'content-length': String(bytes.byteLength),
              'content-disposition': `attachment; filename="sealed-${lookup.data.envelopeId}.pdf"`,
              'x-content-sha256': lookup.data.sha256,
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'none'; sandbox",
            },
          });
        } finally {
          if (!passedToStream) release();
        }
      } catch (error) {
        return problem(c, error);
      }
    });

    app.get('/api/v1/sign/envelopes/:id/certificate', signApiV1Guard, async (c) => {
      try {
        const lookup = await resolveSignApiV1FileSource(
          runtime,
          signBilling,
          c.req.header('authorization'),
          c.req.param('id'),
          'certificate',
          (hash) => signApiV1KeyReadLimit.take(hash),
          (hash) => signApiV1KeyReadLimit.peek(hash),
        );
        if (lookup.status !== 'ok') return replySignApiV1NonOk(c, lookup);
        const release = tryAcquireApiV1SignPdfSlot(lookup.data.orgId);
        if (!release) {
          c.header('retry-after', '2');
          return c.json({ code: 'SIGN_PDF_BUSY', message: 'Server is busy, please retry shortly' }, 503);
        }
        let passedToStream = false;
        try {
          const bytes = await readSignApiV1ArtifactBytes(store, lookup.data);
          const stream = c.req.method === 'HEAD' ? null : releaseOnResponseClose(bytes, release, c);
          if (stream) passedToStream = true;
          return new Response(stream, {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'content-length': String(bytes.byteLength),
              'content-disposition': `attachment; filename="certificate-${lookup.data.envelopeId}.json"`,
              'x-content-sha256': lookup.data.sha256,
              'cache-control': 'no-store',
              'referrer-policy': 'no-referrer',
              'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'none'; sandbox",
            },
          });
        } finally {
          if (!passedToStream) release();
        }
      } catch (error) {
        return problem(c, error);
      }
    });

    app.get('/api/v1/sign/templates', signApiV1Guard, async (c) => {
      try {
        const res = await runSignApiV1TemplatesList(
          runtime,
          signBilling,
          c.req.header('authorization'),
          { limit: c.req.query('limit') },
          (hash) => signApiV1KeyReadLimit.take(hash),
          (hash) => signApiV1KeyReadLimit.peek(hash),
        );
        if (res.status !== 'ok') return replySignApiV1NonOk(c, res);
        return c.json(res.data);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/v1/sign/envelopes/from-template', signApiV1Guard, signBodyLimit(32 * 1024), async (c) => {
      try {
        const rawBody = await c.req.json().catch(() => null);
        const res = await runSignApiV1FromTemplate(
          runtime,
          signBilling,
          c.req.header('authorization'),
          rawBody,
          appUrl(config),
          signMeta(c),
          (hash) => signApiV1KeyDraftLimit.take(hash),
          (hash) => signApiV1KeyDraftLimit.peek(hash),
        );
        if (res.status !== 'ok') return replySignApiV1NonOk(c, res);
        return c.json(res.data, 201);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // Orgless public Projects Roadmap routes (#4399, ADR-0057, ADR-0053, #203):
  // free browsing with no login, 6-digit email OTP verification without CAPTCHA (#203), HMAC voter claim,
  // opaque 404 across missing/disabled/unentitled orgs and boards, and no-store/no-referrer headers.
  const roadmapBilling: SignBilling = deps.billing ?? { entitlements: async () => ['full'] };
  if (runtime.installed('projects')) {
    const roadmapBroker = deps.broker ?? createCredentialBroker(config);
    const roadmapClaimKey = deriveRoadmapClaimKey(roadmapBroker, config.AUTH_JWT_SECRET);
    const roadmapViewLimit = deps.roadmapLimits?.views ?? new RateLimiter({ perMinute: ROADMAP_PUBLIC_VIEWS_PER_MINUTE });
    const roadmapOtpReqLimit = deps.roadmapLimits?.otpRequest ?? new RateLimiter({ perMinute: ROADMAP_PUBLIC_OTP_REQUESTS_PER_MINUTE });
    const roadmapOtpEmailLimit = deps.roadmapLimits?.emailOtpRequest ?? new RateLimiter({ perMinute: ROADMAP_PUBLIC_OTP_EMAIL_REQUESTS_PER_MINUTE });
    const roadmapOtpVerifyLimit = deps.roadmapLimits?.otpVerify ?? new RateLimiter({ perMinute: ROADMAP_PUBLIC_OTP_VERIFIES_PER_MINUTE });
    const roadmapIdeaLimit = deps.roadmapLimits?.ideas ?? new RateLimiter({ perMinute: ROADMAP_PUBLIC_IDEAS_PER_MINUTE });
    const roadmapVoteLimit = deps.roadmapLimits?.votes ?? new RateLimiter({ perMinute: ROADMAP_PUBLIC_VOTES_PER_MINUTE });

    const setRoadmapSecurityHeaders = (c: Context) => {
      c.header('referrer-policy', 'no-referrer');
      c.header('cache-control', 'no-store');
      c.header('x-content-type-options', 'nosniff');
    };

    const roadmapBodyLimit = (maxSize: number) =>
      bodyLimit({
        maxSize,
        onError: (c) => {
          setRoadmapSecurityHeaders(c);
          return c.text('Payload Too Large', 413);
        },
      });

    const roadmapEdgeGuard = (ipLimit: RateLimiter): MiddlewareHandler => async (c, next) => {
      setRoadmapSecurityHeaders(c);
      if (c.req.query('token') !== undefined || c.req.query('voterToken') !== undefined || c.req.query('unsubscribe') !== undefined) {
        return c.json({ code: 'ROADMAP_QUERY_TOKEN_FORBIDDEN', message: 'Credentials must not be passed in URL query parameters' }, 400);
      }
      const decision = ipLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (!decision.allowed) {
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        c.header('retry-after', String(decision.retryAfterSeconds));
        return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds: decision.retryAfterSeconds }, 429);
      }
      await next();
    };

    const roadmapOpaqueNotFound = (c: Context) => c.json({ code: 'NOT_FOUND', message: 'Not found' }, 404);
    const roadmapRateLimited = (c: Context, retryAfterSeconds: number) => {
      c.header('retry-after', String(retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds }, 429);
    };

    const resolveRoadmapCaller = async (
      c: Context,
      orgSlug: string,
      boardSlug: string,
    ): Promise<{ claimSha256: string | null; voterEmail: string | null; actorUserId: string | null }> => {
      const voterToken = c.req.header(ROADMAP_VOTER_HEADER);
      const claim = verifyRoadmapVoterClaim(voterToken, roadmapClaimKey, orgSlug, boardSlug);
      if (claim) {
        return { claimSha256: claim.claimSha256, voterEmail: null, actorUserId: null };
      }
      const authHeader = c.req.header('authorization');
      if (authHeader && /^Bearer\s+/i.test(authHeader)) {
        try {
          const user = await authenticate(authHeader);
          if (!user.extension && user.email) {
            return { claimSha256: null, voterEmail: user.email, actorUserId: user.userId };
          }
        } catch {
          // Invalid/expired bearer stays anonymous on public roadmap routes.
        }
      }
      return { claimSha256: null, voterEmail: null, actorUserId: null };
    };

    app.get('/api/projects/public-roadmap/:orgSlug/:boardSlug', roadmapEdgeGuard(roadmapViewLimit), async (c) => {
      try {
        const orgSlug = c.req.param('orgSlug');
        const boardSlug = c.req.param('boardSlug');
        const caller = await resolveRoadmapCaller(c, orgSlug, boardSlug);
        const res = await runPublicRoadmapView(runtime, roadmapBilling, orgSlug, boardSlug, caller);
        if (res.status === 'not_found') return roadmapOpaqueNotFound(c);
        return c.json(res.view);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/projects/public-roadmap/:orgSlug/:boardSlug/otp/request', roadmapEdgeGuard(roadmapOtpReqLimit), roadmapBodyLimit(2048), async (c) => {
      try {
        const orgSlug = c.req.param('orgSlug');
        const boardSlug = c.req.param('boardSlug');
        const res = await runPublicRoadmapOtpRequest(
          runtime,
          roadmapBilling,
          orgSlug,
          boardSlug,
          await c.req.json().catch(() => null),
          clientIp(c, config.TRUSTED_PROXY_HOPS),
          (bucket) => roadmapOtpEmailLimit.take(bucket),
        );
        if (res.status === 'not_found') return roadmapOpaqueNotFound(c);
        if (res.status === 'rate_limited') return roadmapRateLimited(c, res.retryAfterSeconds);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        return c.json(res.result);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/projects/public-roadmap/:orgSlug/:boardSlug/otp/verify', roadmapEdgeGuard(roadmapOtpVerifyLimit), roadmapBodyLimit(2048), async (c) => {
      try {
        const orgSlug = c.req.param('orgSlug');
        const boardSlug = c.req.param('boardSlug');
        const res = await runPublicRoadmapOtpVerify(
          runtime,
          roadmapBilling,
          roadmapClaimKey,
          orgSlug,
          boardSlug,
          await c.req.json().catch(() => null),
        );
        if (res.status === 'not_found') return roadmapOpaqueNotFound(c);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        if (res.result.ok) return c.json(res.result, 200);
        if (res.result.locked) return c.json(res.result, 423);
        return c.json(res.result, 401);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/projects/public-roadmap/:orgSlug/:boardSlug/ideas', roadmapEdgeGuard(roadmapIdeaLimit), roadmapBodyLimit(16_384), async (c) => {
      try {
        const orgSlug = c.req.param('orgSlug');
        const boardSlug = c.req.param('boardSlug');
        const caller = await resolveRoadmapCaller(c, orgSlug, boardSlug);
        const res = await runPublicRoadmapSubmitIdea(
          runtime,
          roadmapBilling,
          orgSlug,
          boardSlug,
          await c.req.json().catch(() => null),
          caller,
        );
        if (res.status === 'not_found') return roadmapOpaqueNotFound(c);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        return c.json(res.result, 201);
      } catch (error) {
        return problem(c, error);
      }
    });

    app.post('/api/projects/public-roadmap/:orgSlug/:boardSlug/votes', roadmapEdgeGuard(roadmapVoteLimit), roadmapBodyLimit(2048), async (c) => {
      try {
        const orgSlug = c.req.param('orgSlug');
        const boardSlug = c.req.param('boardSlug');
        const caller = await resolveRoadmapCaller(c, orgSlug, boardSlug);
        const res = await runPublicRoadmapVote(
          runtime,
          roadmapBilling,
          roadmapBroker,
          orgSlug,
          boardSlug,
          await c.req.json().catch(() => null),
          caller,
        );
        if (res.status === 'not_found') return roadmapOpaqueNotFound(c);
        if (res.status === 'validation_error') return c.json({ code: 'VALIDATION', message: res.message }, 422);
        return c.json(res.result);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // The client review page (#589): no account, the link's token is the only credential. It comes in the body, never the
  // URL, so it stays out of access logs; each client address has a small budget, and an unknown, revoked or expired
  // link answers like a malformed one.
  if (runtime.installed('social')) {
    const reviewLimits = deps.reviewLimits ?? { views: new RateLimiter({ perMinute: REVIEW_VIEWS_PER_MINUTE }), answers: new RateLimiter({ perMinute: REVIEW_ANSWERS_PER_MINUTE }) };
    const reviewBudget = (c: Context, bucket: RateLimiter) => {
      const decision = bucket.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
      if (decision.allowed) return null;
      // Behind a proxy that is not trusted, every client shares one budget: say so, as the auth and stream routes do.
      warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
      c.header('retry-after', String(decision.retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds: decision.retryAfterSeconds }, 429);
    };
    app.post('/api/review/view', bodyLimit({ maxSize: 1024 }), async (c) => {
      const limited = reviewBudget(c, reviewLimits.views);
      if (limited) return limited;
      c.header('cache-control', 'no-store');
      try {
        const view = await reviewView(runtime, await c.req.json().catch(() => null));
        return view ? c.json(view) : c.json({ code: 'REVIEW_LINK_INVALID', message: 'Liên kết duyệt không hợp lệ, đã bị thu hồi hoặc đã hết hạn' }, 404);
      } catch (error) {
        return problem(c, error);
      }
    });
    // A client report link (#643): the same edge as the review page, with its own budget.
    const reportLimit = deps.reportLimit ?? new RateLimiter({ perMinute: REPORT_VIEWS_PER_MINUTE });
    app.post('/api/report/view', bodyLimit({ maxSize: 1024 }), async (c) => {
      const limited = reviewBudget(c, reportLimit);
      if (limited) return limited;
      c.header('cache-control', 'no-store');
      try {
        const view = await reportView(runtime, await c.req.json().catch(() => null));
        return view ? c.json(view) : c.json({ code: 'REPORT_LINK_INVALID', message: 'Liên kết báo cáo không hợp lệ, đã bị thu hồi hoặc đã hết hạn' }, 404);
      } catch (error) {
        return problem(c, error);
      }
    });
    // A Social short link (#706): a redirect to the link the post went out with, counted. The same per-client budget as
    // the public pages; an unknown code is a plain 404.
    const shortLinkLimit = deps.shortLinkLimit ?? new RateLimiter({ perMinute: SHORT_LINK_HITS_PER_MINUTE });
    app.get('/l/:code', async (c) => {
      const limited = reviewBudget(c, shortLinkLimit);
      if (limited) return limited;
      c.header('cache-control', 'no-store');
      c.header('referrer-policy', 'no-referrer');
      try {
        const target = await shortLinkTarget(runtime, c.req.param('code'), c.req.header('user-agent'));
        return target ? c.redirect(target, 302) : c.text('Liên kết không tồn tại hoặc đã bị gỡ', 404);
      } catch (error) {
        return problem(c, error);
      }
    });
    // An org's link-in-bio page (#707): the page, its counted links and its images, under one per-client budget. An
    // unpublished or unknown page is a plain 404 for all three.
    const bioLimit = deps.bioLimit ?? new RateLimiter({ perMinute: BIO_HITS_PER_MINUTE });
    const notFound = (c: Context) => c.text('Không tìm thấy trang này', 404);
    app.get('/b/:slug', async (c) => {
      const limited = reviewBudget(c, bioLimit);
      if (limited) return limited;
      try {
        const slug = c.req.param('slug');
        const view = await bioView(runtime, slug);
        if (!view) return notFound(c);
        return c.html(renderBioPage(slug, view, config.BRAND_NAME), 200, { 'content-security-policy': BIO_PAGE_CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      } catch (error) {
        return problem(c, error);
      }
    });
    app.get('/b/:slug/go/:target', async (c) => {
      const limited = reviewBudget(c, bioLimit);
      if (limited) return limited;
      c.header('cache-control', 'no-store');
      c.header('referrer-policy', 'no-referrer');
      try {
        const url = await bioGo(runtime, c.req.param('slug'), c.req.param('target'), c.req.header('user-agent'));
        return url ? c.redirect(url, 302) : notFound(c);
      } catch (error) {
        return problem(c, error);
      }
    });
    app.get('/b/:slug/img/:file', async (c) => {
      const limited = reviewBudget(c, bioLimit);
      if (limited) return limited;
      try {
        const image = await bioImage(runtime, store, c.req.param('slug'), c.req.param('file'));
        if (!image) return notFound(c);
        return new Response(body(image.bytes), {
          headers: { 'content-type': image.contentType, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" },
        });
      } catch (error) {
        return problem(c, error);
      }
    });
    // The post's images and video (#624): ids per channel, then each file by id, both for the link's token only.
    const reviewFiles = deps.reviewLimits?.files ?? new RateLimiter({ perMinute: REVIEW_FILES_PER_MINUTE });
    // Files read whole into memory (no download URL to hand out) at most this many at once, across every client: the
    // route needs no account, so its memory is capped here, not only per request.
    let reviewStreams = 0;
    const REVIEW_STREAMS_MAX = 4;
    app.post('/api/review/media', bodyLimit({ maxSize: 1024 }), async (c) => {
      const limited = reviewBudget(c, reviewLimits.views);
      if (limited) return limited;
      c.header('cache-control', 'no-store');
      try {
        const media = await reviewMedia(runtime, await c.req.json().catch(() => null));
        return media ? c.json({ channels: media }) : c.json({ code: 'REVIEW_LINK_INVALID', message: 'Liên kết duyệt không hợp lệ, đã bị thu hồi hoặc đã hết hạn' }, 404);
      } catch (error) {
        return problem(c, error);
      }
    });
    app.post('/api/review/file', bodyLimit({ maxSize: 1024 }), async (c) => {
      const limited = reviewBudget(c, reviewFiles);
      if (limited) return limited;
      try {
        if (reviewStreams >= REVIEW_STREAMS_MAX) return c.json({ code: 'RATE_LIMITED', message: 'Máy chủ đang bận, hãy thử lại sau ít giây', retryAfterSeconds: 2 }, 429);
        reviewStreams += 1;
        let file: Awaited<ReturnType<typeof reviewFile>>;
        try {
          file = await reviewFile(runtime, deps.store, await c.req.json().catch(() => null));
        } finally {
          reviewStreams -= 1;
        }
        if (!file) {
          c.header('cache-control', 'no-store');
          return c.json({ code: 'REVIEW_LINK_INVALID', message: 'Liên kết duyệt không hợp lệ, đã bị thu hồi hoặc đã hết hạn' }, 404);
        }
        // A presigned GET of the exact version: the page fetches it itself, without this request's headers.
        if ('url' in file) {
          c.header('cache-control', 'no-store');
          return c.json({ url: file.url });
        }
        return new Response(body(file.bytes), {
          headers: {
            'content-type': file.type,
            'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            'content-security-policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });
    app.post('/api/review/answer', bodyLimit({ maxSize: 8 * 1024 }), async (c) => {
      const limited = reviewBudget(c, reviewLimits.answers);
      if (limited) return limited;
      c.header('cache-control', 'no-store');
      try {
        const done = await reviewAnswer(runtime, await c.req.json().catch(() => null));
        return done ? c.json(done) : c.json({ code: 'REVIEW_LINK_INVALID', message: 'Liên kết duyệt không hợp lệ, đã bị thu hồi hoặc đã hết hạn' }, 404);
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // The invalidation stream (issue #69). EventSource sends no Authorization header, so this route runs before the
  // bearer middleware below and authenticates with a one-time ticket instead (POST /api/stream/tickets, which does go
  // through it): the ticket is redeemed once (capped per client address and per process, issue #281), then come the
  // same per-user request limit, a connection slot, and the session check and membership of the ticket's org, all
  // before the stream opens.
  const stream = deps.stream;
  if (stream) {
    const redeemFailures = stream.redeemFailures ?? new RateLimiter({ perMinute: STREAM_REDEEM_FAILURES_PER_MINUTE });
    const redeems = stream.redeems ?? new ConcurrencyLimiter({ total: STREAM_REDEEMS_IN_FLIGHT, perKey: STREAM_REDEEMS_IN_FLIGHT_PER_CLIENT });
    const unavailable = (c: Context) => {
      c.header('retry-after', String(STREAM_RETRY_SECONDS));
      return c.json({ code: 'STREAM_UNAVAILABLE', message: 'Kênh cập nhật tạm thời không hoạt động' }, 503);
    };
    const rateLimited = (c: Context, retryAfterSeconds: number) => {
      c.header('retry-after', String(retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds }, 429);
    };
    app.get('/api/stream', async (c) => {
      // Hono answers HEAD with this route and drops the body: a stream nobody reads would hold a slot.
      if (c.req.method !== 'GET') return c.json({ code: 'METHOD_NOT_ALLOWED' }, 405);
      const ticket = c.req.query('ticket');
      const refused = () => c.json({ code: 'STREAM_TICKET_INVALID', message: 'Vé kết nối không hợp lệ hoặc đã hết hạn' }, 401);
      if (!wellFormedTicket(ticket)) return refused();
      // Checked before the redeem: a stream this process cannot feed is refused without using the ticket.
      if (!stream.hub.ready) return unavailable(c);
      // The address the email budget uses too (the socket, or the entry the trusted proxies appended; IPv6 by /64).
      const client = clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS));
      const budget = redeemFailures.peek(client);
      if (!budget.allowed) return rateLimited(c, budget.retryAfterSeconds);
      const inFlight = redeems.tryAcquire(client);
      if (!inFlight) {
        c.header('retry-after', String(STREAM_RETRY_SECONDS));
        return c.json({ code: 'STREAM_BUSY', message: 'Quá nhiều kết nối cập nhật đang mở' }, 503);
      }
      let binding: TicketBinding | null;
      try {
        binding = await stream.tickets.redeem(ticketHash(ticket));
      } catch (error) {
        console.error('[stream] ticket not redeemed:', error instanceof Error ? error.message : error);
        return unavailable(c);
      } finally {
        inFlight();
      }
      if (!binding) {
        warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
        redeemFailures.take(client);
        return refused();
      }
      const decision = limiter?.take(binding.userId);
      if (decision && !decision.allowed) return rateLimited(c, decision.retryAfterSeconds);
      const release = stream.slots.tryAcquire(binding.userId);
      if (!release) {
        c.header('retry-after', String(STREAM_RETRY_SECONDS));
        return c.json({ code: 'STREAM_BUSY', message: 'Quá nhiều kết nối cập nhật đang mở' }, 503);
      }
      const actor = ticketActor(binding);
      const orgId = binding.orgId;
      // The stream's access line names the org the ticket was issued for (#2175).
      setLogContext({ orgId });
      // The check also answers the legal-entity scope the stream's hints are filtered by (#1692).
      // And the apps the org has off now (ADR-0053): a stream does not push the hints of an app that is off, and re-reads this on every check. A check that cannot
      // tell leaves the filter out, as the app's own calls into an off app are refused by the runtime anyway.
      // The apps off at the last check that could read them: a read that fails keeps that filter in force (it never widens a stream), and logs the error's class.
      let lastAppsOff: ReadonlySet<string> | null = null;
      const check = async () => {
        const scope = streamScopeOf(await runtime.query(STREAM_CHECK_QUERY, {}, { actor, orgId }));
        const on = await runtime.effectiveModules(orgId).catch((error: unknown) => {
          console.warn(`[stream] the apps of org ${orgId.slice(0, 8)} could not be read: ${error instanceof Error ? error.name : typeof error}`);
          return null;
        });
        if (on === null) return lastAppsOff && lastAppsOff.size > 0 ? { ...scope, appsOff: lastAppsOff } : scope;
        // An app this deployment does not run is not "off": nothing writes its rows, and a runtime without it (a kernel-only one) is not filtering.
        const appsOff = new Set(STREAM_FILTERED_APPS.filter((app) => runtime.installed(app) && !on.includes(app)));
        lastAppsOff = appsOff;
        return appsOff.size === 0 ? scope : { ...scope, appsOff };
      };
      let scope: StreamScope;
      try {
        scope = await check();
      } catch (error) {
        release();
        return problem(c, error);
      }
      // The listener may have dropped, or the process begun to stop, while the checks ran.
      if (!stream.hub.ready) {
        release();
        return unavailable(c);
      }
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let unsubscribe = () => {};
      const connection = new StreamConnection({
        orgId,
        // Hints about a member's own rows (a notification) go only to that member's streams (#1702).
        userId: binding.userId,
        scope,
        check,
        ...(stream.rechecks ? { gate: stream.rechecks } : {}),
        recheckMs: stream.recheckSeconds * 1000,
        endsAt: Math.min(binding.tokenExp * 1000, Date.now() + MAX_STREAM_LIFETIME_MS),
        write: (chunk) => {
          if (!controller) return false;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            return false;
          }
          // Negative once more than the queue's high-water mark (0) is unread.
          return (controller.desiredSize ?? 0) > -MAX_BUFFERED_BYTES;
        },
        end: () => {
          try {
            controller?.close();
          } catch {
            // Already closed, or cancelled by the client.
          }
        },
        onClosed: () => {
          unsubscribe();
          release();
        },
      });
      const body = new ReadableStream<Uint8Array>(
        {
          start(ctrl) {
            controller = ctrl;
          },
          // The client went away.
          cancel() {
            connection.finish();
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
      );
      c.req.raw.signal.addEventListener('abort', () => connection.finish(), { once: true });
      unsubscribe = stream.hub.subscribe(connection);
      connection.open(stream.recheckSeconds);
      // A client that left during the checks above never fires abort again, and its body is never cancelled.
      if (c.req.raw.signal.aborted) connection.finish();
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
        },
      });
    });
  }

  // Playback of one meeting's video by a short-lived signed ticket (#2703). A `<video>` cannot send the bearer header, so this
  // route runs before the bearer middleware below and the credential is the ticket POST /api/meetings/:id/video/ticket
  // issued (stateless: an HMAC under a key the credential broker derives for this one purpose). The ticket only says who
  // asked, for which meeting, video file and key, until when. EVERY request, each range included, then checks again that
  // the session is live (kernel.stream.check) and runs the reader-checked media query as the ticket's user, so a revoked
  // session or a removed reader loses access on the next request. One answer, 401 VIDEO_TICKET_INVALID, for every
  // refusal; each one counts against a per-client budget. GET and HEAD only. The ticket is read from the query and goes to
  // no log (the access line names the route pattern); no CORS headers (a media element makes a no-cors request).
  const videoTicketFailures = deps.videoTicketFailures ?? new RateLimiter({ perMinute: STREAM_REDEEM_FAILURES_PER_MINUTE });
  const videoStreams = deps.videoStreams ?? new ConcurrencyLimiter({ total: config.MEETINGS_VIDEO_STREAMS_MAX, perKey: VIDEO_STREAMS_PER_USER });
  const videoTicketKey = (keyId: string): Buffer | null => {
    try {
      const broker = deps.broker ?? createCredentialBroker(config);
      if (broker.deriveKey) return broker.deriveKey(keyId, MEDIA_TICKET_KEY_LABEL);
      return broker.derive && broker.keyId === keyId ? broker.derive(MEDIA_TICKET_KEY_LABEL) : null;
    } catch {
      // An unknown key id (a rotated-out key) is no key.
      return null;
    }
  };
  const VIDEO_TICKET_RESPONSE_HEADERS = {
    'referrer-policy': 'no-referrer',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-disposition': 'inline',
  } as const;
  app.get('/api/meetings/:id/video/stream', async (c) => {
    for (const [name, value] of Object.entries(VIDEO_TICKET_RESPONSE_HEADERS)) c.header(name, value);
    const client = clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS));
    // A refusal costs the client one token of the failure budget, and its check awaits the database. So the token is reserved here, before
    // anything is awaited, and given back when the request is not refused: parallel requests cannot all pass a peek before the first
    // refusal is charged (#2965), and a valid request costs nothing in the end.
    const budget = videoTicketFailures.take(client);
    if (!budget.allowed) {
      c.header('retry-after', String(budget.retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds: budget.retryAfterSeconds }, 429);
    }
    const outcome = { refused: false };
    try {
      return await streamByTicket(c, outcome);
    } finally {
      if (!outcome.refused) videoTicketFailures.refund(client);
    }
  });

  // The checks of a ticket request and, once they pass, the answer. A refusal marks the outcome, so its reserved token stays spent.
  async function streamByTicket(c: Context, outcome: { refused: boolean }): Promise<Response> {
    // The same answer for every refusal, and a failure against the client's budget.
    const refused = () => {
      warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
      outcome.refused = true;
      return c.json({ code: 'VIDEO_TICKET_INVALID' }, 401);
    };
    const ticket = c.req.query('ticket');
    if (!wellFormedMediaTicket(ticket)) return refused();
    const keyId = peekMediaTicketKeyId(ticket);
    const key = keyId === null ? null : videoTicketKey(keyId);
    if (!key) return refused();
    const payload = verifyMediaTicket(ticket, key, Math.floor(Date.now() / 1000));
    key.fill(0);
    const meetingId = c.req.param('id') ?? '';
    if (!payload || payload.purpose !== MEDIA_TICKET_PURPOSE || payload.meetingId !== meetingId.toLowerCase()) return refused();
    // The request limit of the user the ticket proves, as the bearer routes have.
    const decision = limiter?.take(payload.userId);
    if (decision && !decision.allowed) {
      c.header('retry-after', String(decision.retryAfterSeconds));
      return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds: decision.retryAfterSeconds }, 429);
    }
    setLogContext({ orgId: payload.orgId });
    const actor: UserActor = { type: 'user', userId: payload.userId, aal: payload.aal, sessionId: payload.sessionId, mfaAt: payload.mfaAt };
    // A refusal of the database (session gone, member gone, reader removed, retention over, key shredded) is the same 401;
    // anything else (the database down) is an error of ours.
    const fail = (error: unknown) => (error instanceof DomainError && error.status >= 400 && error.status < 500 ? refused() : problem(c, error));
    try {
      await runtime.query(STREAM_CHECK_QUERY, {}, { actor, orgId: payload.orgId });
    } catch (error) {
      return fail(error);
    }
    const release = videoStreams.tryAcquire(payload.userId);
    if (!release) {
      c.header('retry-after', String(VIDEO_STREAMS_RETRY_SECONDS));
      return c.json({ code: 'RATE_LIMITED', message: 'Quá nhiều luồng video đang mở, hãy thử lại sau', retryAfterSeconds: VIDEO_STREAMS_RETRY_SECONDS }, 429);
    }
    return serveMeetingMedia(c, {
      kind: 'video',
      actor,
      orgId: payload.orgId,
      meetingId: payload.meetingId,
      headOnly: c.req.method === 'HEAD',
      headers: { ...VIDEO_TICKET_RESPONSE_HEADERS },
      expect: { fileId: payload.fileId, keyId: payload.keyId },
      // A player sends several overlapping ranges: the per-user cap above bounds it, not the one-slot large-transfer limiter.
      ownLimit: true,
      recheck: async () => {
        if (Math.floor(Date.now() / 1000) >= payload.exp) throw new DomainError('VIDEO_TICKET_INVALID', 401, 'The video ticket expired');
        await runtime.query(STREAM_CHECK_QUERY, {}, { actor, orgId: payload.orgId });
      },
      onFinished: release,
      fail,
    });
  }

  const rateLimited = (c: Context, retryAfterSeconds: number) => {
    c.header('retry-after', String(retryAfterSeconds));
    return c.json({ code: 'RATE_LIMITED', message: 'Bạn gửi quá nhiều yêu cầu, hãy thử lại sau', retryAfterSeconds }, 429);
  };

  // Fails closed at the HTTP edge when app enablement lookup errors transiently (#3742).
  const requireAppOn = async (orgId: string, module: string): Promise<boolean> => {
    try {
      return await runtime.appOn(orgId, module, { fresh: true });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('SERVICE_UNAVAILABLE', 503, 'Không kiểm tra được trạng thái ứng dụng lúc này');
    }
  };

  // The Ludy extension trades the one-time code the signed-in member approved in the app for its token (issue #2582,
  // ADR-0047 point 10). Public by necessity: the extension holds no session, and the credential is the code, 256 random
  // bits that live five minutes, work once and are bound by PKCE (S256) to the verifier only the extension holds. A
  // body of at most 1 KB; a budget per client address; the code and the verifier checked for shape before the database
  // is asked; one answer, 400, for every refusal (unknown, used, expired or wrong code or verifier, a member who left),
  // which says nothing of any org. Only hashes reach SQL. The answer is never cached.
  const extensionTokenLimit = deps.extensionTokenLimit ?? new RateLimiter({ perMinute: EXTENSION_TOKEN_EXCHANGES_PER_MINUTE });
  app.post('/api/extension/token', bodyLimit({ maxSize: 1024 }), async (c) => {
    c.header('cache-control', 'no-store');
    const decision = extensionTokenLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
    if (!decision.allowed) {
      warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
      return rateLimited(c, decision.retryAfterSeconds);
    }
    const refused = () => c.json({ code: 'EXTENSION_CODE_INVALID', message: 'Mã đăng nhập tiện ích không hợp lệ hoặc đã hết hạn, hãy đăng nhập lại' }, 400);
    try {
      const input = (await c.req.json().catch(() => null)) as { code?: unknown; codeVerifier?: unknown; client?: unknown } | null;
      if (!input || typeof input !== 'object' || !wellFormedExtensionCode(input.code) || !wellFormedVerifier(input.codeVerifier)) return refused();
      const code = input.code;
      const verifier = input.codeVerifier;
      // The code is bound to the extension it was issued for (#2850): the exchange must come from that extension, which the browser
      // states in the Origin header (chrome-extension://<id>). A missing, malformed, unlisted or different origin gets the same
      // answer as a wrong code, and the code is not spent. Defence in depth only: a client outside the browser can set any Origin, so PKCE
      // and the allow-list stay the primary protection.
      // Ludy Desktop (#4515) sends no Origin and says client "desktop": the code must then be the one made for the reserved desktop id.
      const extensionId = exchangeClientId(c.req.header('origin'), input.client);
      if (extensionId === null || (extensionId !== DESKTOP_CLIENT_ID && !allowedExtensionIds.includes(extensionId))) return refused();
      const done = await runtime.orgless((db) => exchangeExtensionCode(db, code, verifier, extensionId));
      if (!done) return refused();
      // The audit row of the exchange (the definer has no member context to write one): as the member, with the new token.
      const scopes = done.exchange.scopes.filter((s): s is ExtensionScope => (EXTENSION_SCOPES as readonly string[]).includes(s));
      // The client gets the token only once this row is written. When it fails, the token row already exists and nobody
      // holds it: void it (its own system audit row follows) before answering, so no usable row is left behind (#2740).
      // Notes-only tokens audit through notes.extension.exchanged because kernel.extension.token.exchanged requires 'meetings' (#3560).
      // A desktop exchange is audited in the same transaction by the exchange definer (kernel.extension.desktop.exchanged, #4515; even when it holds the meetings capture scope, #4516).
      const exchangeAuditCommand = scopes.includes('meetings') ? 'kernel.extension.token.exchanged' : 'notes.extension.exchanged';
      try {
        if (extensionId !== DESKTOP_CLIENT_ID) {
          await runtime.execute(
            exchangeAuditCommand,
            { codeId: done.exchange.codeId },
            { actor: { type: 'user', userId: done.exchange.userId, aal: 'aal1', mfaAt: null, extension: { tokenId: done.exchange.tokenId, scopes, client: 'extension' } }, orgId: done.exchange.orgId },
          );
        }
      } catch (error) {
        const voided = await runtime.orgless((db) => voidUndeliveredExtensionToken(db, done.token)).catch(() => false);
        // The clean-up did not void the row: it was already revoked (a demotion raced the exchange) or the clean-up itself failed, in which
        // case a live row nobody holds is left behind and expires on its own. Ids only.
        if (!voided) logEvent('error', 'extension exchange failed and its clean-up did not void the token row', { tokenId: done.exchange.tokenId, orgId: done.exchange.orgId });
        throw error;
      }
      const returnedScopes = extensionId === DESKTOP_CLIENT_ID && config.MEETINGS_DESKTOP_CAPTURE !== 'on' ? [] : done.exchange.scopes;
      return c.json({ token: done.token, tokenId: done.exchange.tokenId, orgId: done.exchange.orgId, scopes: returnedScopes, expiresAt: done.exchange.expiresAt });
    } catch (error) {
      return problem(c, error);
    }
  });

  // Everything below requires a signed-in user, and is limited per user (plan §4.4 step 0) before any command or
  // query runs. The token is verified first, so the key is a user the token proves; authenticate() writes to the
  // database only when its identity cache misses (once per user and process every few minutes), never per request.
  const extensionBearerLimit = deps.extensionBearerLimit ?? new RateLimiter({ perMinute: EXTENSION_BEARER_PER_MINUTE });
  const extensionWriteLimit = deps.extensionWriteLimit !== undefined ? deps.extensionWriteLimit : new RateLimiter({ perMinute: EXTENSION_WRITES_PER_MINUTE });
  app.use('/api/*', async (c, next) => {
    let user: AuthUser;
    try {
      const authHeader = c.req.header('authorization');
      // Read as authenticate() reads it (a scheme, then the token trimmed), so extra spaces do not skip the count.
      if (authHeader?.startsWith('Bearer ') && authHeader.slice(7).trim().startsWith('crx_')) {
        const decision = extensionBearerLimit.take(clientBucket(clientIp(c, config.TRUSTED_PROXY_HOPS)));
        if (!decision.allowed) {
          warnIfUntrustedProxy(c, config.TRUSTED_PROXY_HOPS);
          return rateLimited(c, decision.retryAfterSeconds);
        }
      }
      user = await authenticate(authHeader);
    } catch (error) {
      return problem(c, error);
    }
    // A Ludy extension token (issue #2582) reaches only the routes its scopes open, listed in auth-extension.ts: refused
    // here, before any handler, body read or database call, on every other route. The raw path is the one checked, so
    // nothing a router decodes later can name a route the list does not. When MEETINGS_DESKTOP_CAPTURE is off, desktop tokens stay at [].
    if (user.extension) {
      const extension =
        user.extension.client === 'desktop' && config.MEETINGS_DESKTOP_CAPTURE !== 'on' && user.extension.scopes.length > 0
          ? { ...user.extension, scopes: [] as const }
          : user.extension;
      if (extension !== user.extension) user = { ...user, extension };
      const checked = authorizeExtensionRoute(extension.scopes, c.req.method, new URL(c.req.url).pathname, extension.client ?? 'extension');
      if (!checked.ok) return problem(c, checked.error);
      if (checked.route.write && extensionWriteLimit) {
        const writeDecision = extensionWriteLimit.take(`extension:${extension.tokenId}`);
        if (!writeDecision.allowed) return rateLimited(c, writeDecision.retryAfterSeconds);
      }
    }
    // A token's requests count against its own budget, so a stolen token cannot use up its member's.
    const decision = limiter?.take(user.extension ? `extension:${user.extension.tokenId}` : user.userId);
    if (decision && !decision.allowed) {
      return rateLimited(c, decision.retryAfterSeconds);
    }
    c.set('user', user);
    await next();
  });

  // A one-time ticket for GET /api/stream (issue #69), bound to this token's user, session, assurance and expiry and to
  // the org of the request, issued after that org's session check and membership. No body is read.
  if (stream) {
    app.post('/api/stream/tickets', bodyLimit({ maxSize: 1024 }), async (c) => {
      try {
        const user = c.get('user');
        // Fail closed: without the token's exp a stream could outlive the token (jwt mode trusts it until then).
        const tokenExp = user.tokenExp;
        if (tokenExp === undefined) throw new DomainError('STREAM_UNAVAILABLE', 503, 'Kênh cập nhật tạm thời không hoạt động');
        const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
        await runtime.query(STREAM_CHECK_QUERY, {}, { actor: actorOf(user), orgId });
        const { ticket, hash } = newTicket();
        const issued = await stream.tickets.issue(hash, {
          userId: user.userId,
          orgId,
          sessionId: user.sessionId,
          aal: user.aal,
          mfaAt: user.mfaAt,
          tokenExp,
        });
        // The token expired between its check above and the database's: sign in again (401), not wait (429).
        if (issued === 'expired') throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
        if (issued === 'limit') {
          c.header('retry-after', String(STREAM_TICKET_TTL_SECONDS));
          throw new DomainError('RATE_LIMITED', 429, 'Quá nhiều yêu cầu mở kênh cập nhật, hãy thử lại sau');
        }
        c.header('cache-control', 'no-store');
        return c.json({ ticket, expiresInSeconds: STREAM_TICKET_TTL_SECONDS });
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // A short-lived ticket for GET /api/meetings/:id/video/stream (#2703), behind the bearer check above (so the per-user
  // request limit applies, and an extension token never gets here: the route is in no extension scope). It is issued only to a
  // current reader of a meeting that keeps video (the same reader-checked query the playback runs), bound to the org, the
  // user, the session, the meeting, the video file and its key, for at most ten minutes and never past the bearer token's own
  // expiry. No body is read.
  app.post('/api/meetings/:id/video/ticket', async (c) => {
    c.header('cache-control', 'no-store');
    try {
      if (!runtime.installed('meetings')) return c.notFound();
      const user = c.get('user');
      const nowSeconds = Math.floor(Date.now() / 1000);
      // Fail closed: without the token's exp a ticket could outlive the token (jwt mode trusts it until then).
      const tokenExp = user.tokenExp;
      if (tokenExp === undefined) throw new DomainError('VIDEO_TICKET_UNAVAILABLE', 503, 'Không thể cấp vé xem video lúc này');
      if (tokenExp <= nowSeconds) throw new DomainError('UNAUTHENTICATED', 401, 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      const meetingId = c.req.param('id');
      const media = await runtime.query<{ fileId: string; keyId: string }>('meetings.meeting.media_meta', { meetingId, kind: 'video' }, { actor: actorOf(user), orgId });
      const key = videoTicketKey(media.keyId);
      if (!key) throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media decryption key unavailable');
      const exp = Math.min(nowSeconds + MEDIA_TICKET_MAX_TTL_SECONDS, tokenExp);
      const ticket = signMediaTicket(key, {
        keyId: media.keyId,
        orgId,
        userId: user.userId,
        sessionId: user.sessionId,
        aal: user.aal,
        mfaAt: user.mfaAt,
        meetingId: meetingId.toLowerCase(),
        fileId: media.fileId,
        purpose: MEDIA_TICKET_PURPOSE,
        iat: nowSeconds,
        exp,
      });
      key.fill(0);
      return c.json({ ticket, expiresInSeconds: exp - nowSeconds });
    } catch (error) {
      return problem(c, error);
    }
  });

  // The member approves the Ludy extension for the org of the request (issue #2582): the sign-in page of the app calls this
  // with the member's own session after they chose the org and pressed "Cho phép". The code is made here and returned
  // here only; the command gets its hash, the PKCE challenge, the scopes and a device name. Never with an extension token.
  app.post('/api/extension/authorize', bodyLimit({ maxSize: 2 * 1024 }), async (c) => {
    c.header('cache-control', 'no-store');
    try {
      const user = c.get('user');
      if (user.extension) throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
      const parsed = zExtensionAuthorize.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) throw new DomainError('INVALID', 422, 'Yêu cầu kết nối tiện ích không hợp lệ');
      const input = parsed.data;
      // Only an extension this deployment lists may receive a code (EXTENSION_IDS, #2740); the app checks the same list. Ludy Desktop (#4515/#4516)
      // is the one client that is not an extension: DESKTOP_CLIENT_ID is always allowed, and non-empty scopes require MEETINGS_DESKTOP_CAPTURE=on.
      if (input.extensionId !== DESKTOP_CLIENT_ID && !allowedExtensionIds.includes(input.extensionId)) throw new DomainError('FORBIDDEN', 403, 'Tiện ích này không được phép kết nối với Ludy', { rule: 'extension_id' });
      if (input.extensionId === DESKTOP_CLIENT_ID && input.scopes.length > 0 && config.MEETINGS_DESKTOP_CAPTURE !== 'on') {
        throw new DomainError('FORBIDDEN', 403, 'Ghi âm cuộc họp từ Ludy Desktop chưa được bật trên máy chủ này', { rule: 'desktop_capture_off' });
      }
      // Only features this deployment runs: a scope of a module that is left out is not offered.
      if (input.scopes.includes('meetings') && !runtime.installed('meetings')) throw new DomainError('NOT_FOUND', 404, 'Mô-đun Cuộc họp chưa được bật');
      if (input.scopes.includes('notes') && !runtime.installed('notes')) throw new DomainError('NOT_FOUND', 404, 'Mô-đun Ghi chú chưa được bật');
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      // An org that switched Meetings or Notes off, or does not hold it, is not offered that scope either (ADR-0053).
      if (input.scopes.includes('meetings') && !(await requireAppOn(orgId, 'meetings'))) throw new DomainError('NOT_FOUND', 404, 'Mô-đun Cuộc họp chưa được bật');
      if (input.scopes.includes('notes') && !(await requireAppOn(orgId, 'notes'))) throw new DomainError('NOT_FOUND', 404, 'Mô-đun Ghi chú chưa được bật');
      const code = newExtensionCode();
      const issued = await runtime.execute<{ expiresInSeconds: number }>(
        'kernel.extension.code.issue',
        { codeHash: code.hash.toString('hex'), codeChallenge: input.codeChallenge, scopes: input.scopes, deviceName: input.deviceName, extensionId: input.extensionId },
        { actor: actorOf(user), orgId },
      );
      return c.json({ code: code.value, expiresInSeconds: issued.expiresInSeconds });
    } catch (error) {
      return problem(c, error);
    }
  });

  // What the extension shell asks right after sign-in: whose token this is and which features this deployment runs.
  // Answered from the verified token and the org's app switch, with no tenant data: Meetings is a feature of the extension only while the org has it on
  // (ADR-0053). A browser session has no use for it.
  app.get('/api/extension/me', async (c) => {
    c.header('cache-control', 'no-store');
    try {
      const { extension } = c.get('user');
      if (!extension) throw new DomainError('FORBIDDEN', 403, 'Đường này chỉ dành cho tiện ích Ludy', { rule: 'extension_only' });
      const desktopCaptureOn = extension.client !== 'desktop' || config.MEETINGS_DESKTOP_CAPTURE === 'on';
      const needsMeetings = desktopCaptureOn && runtime.installed('meetings') && (extension.scopes.includes('meetings') || extension.scopes.includes('agenda'));
      const needsNotes = extension.client !== 'desktop' && runtime.installed('notes') && extension.scopes.includes('notes');
      const meetingsOn = needsMeetings ? await requireAppOn(extension.orgId, 'meetings') : false;
      const notesOn = needsNotes ? await requireAppOn(extension.orgId, 'notes') : false;
      return c.json({
        tokenId: extension.tokenId,
        orgId: extension.orgId,
        scopes: desktopCaptureOn ? extension.scopes : [],
        client: extension.client ?? 'extension',
        expiresAt: extension.expiresAt,
        features: {
          meetings: desktopCaptureOn && extension.scopes.includes('meetings') && meetingsOn,
          agenda: desktopCaptureOn && extension.scopes.includes('agenda') && meetingsOn,
          notes: extension.client !== 'desktop' && extension.scopes.includes('notes') && notesOn,
        },
      });
    } catch (error) {
      return problem(c, error);
    }
  });

  app.all('/api/rpc/*', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    try {
      const { matched, response } = await rpc.handle(c.req.raw, {
        prefix: '/api/rpc',
        context: { user: c.get('user'), orgSlug: readOrgHeader(c) },
      });
      return matched ? response : c.json({ code: 'NOT_FOUND' }, 404);
    } catch (error) {
      return problem(c, error);
    }
  });

  // Files are written and recorded the same way on every path: the server computes the sha256 of the bytes it
  // holds, writes them create-only to org/<org_id>/<sha256> and records the triple with the generation the store
  // returned (plan §7.6, ADR-0013).
  // purpose social: an image or a video for a Social post (#372, #409), recorded with source 'social' so it never goes
  // to extraction. A video's duration is read from the file and recorded with it.
  // purpose import: an .xlsx workbook for a module's import (the tax portal's purchase list, #465), recorded with source
  // 'import' so it never goes to extraction either; the module has it read in the parsing sandbox. Only its container
  // is checked here (a ZIP of at most MAX_IMPORT_BYTES); the sandbox decides whether it is a workbook.
  async function ingest(
    user: AuthUser,
    orgId: string,
    name: string,
    bytes: Uint8Array,
    sha256 = sha256Hex(bytes),
    purpose: UploadPurpose = 'document',
    legalEntityId: string | undefined = undefined,
  ) {
    // The content decides the type; the browser's MIME type and the extension are only hints.
    const video = purpose === 'social' ? sniffVideo(bytes) : null;
    let type = video ?? sniffType(bytes);
    let durationMs: number | undefined;
    let size: ImageSize | null = null;
    if (purpose === 'import') {
      if (type !== 'application/zip') throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: chỉ nhận tệp Excel dạng .xlsx`);
      if (bytes.byteLength > MAX_IMPORT_BYTES) throw new DomainError('TOO_LARGE', 413, `${name} vượt quá 10 MB`);
      type = XLSX_CONTENT_TYPE;
    } else if (purpose === 'agreement') {
      // The signed agreement of an invoice correction (#2504): a PDF, or the photo or scan of the signed paper.
      if (!type || !AGREEMENT_TYPES.includes(type)) throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: biên bản thỏa thuận chỉ nhận tệp PDF, JPG, PNG hoặc WEBP`);
      if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new DomainError('TOO_LARGE', 413, `${name} vượt quá 25 MB`);
    } else if (purpose === 'sign_document') {
      if (type !== 'application/pdf') {
        throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: tài liệu ký điện tử chỉ nhận tệp PDF`);
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new DomainError('TOO_LARGE', 413, `${name} vượt quá 25 MB`);
    } else if (video) {
      if (bytes.byteLength > MAX_SOCIAL_VIDEO_BYTES) throw new DomainError('TOO_LARGE', 413, `${name} vượt quá 100 MB`);
      const ms = videoDurationMs(bytes);
      if (ms === null || ms === 0) throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: không đọc được thời lượng video`);
      if (!hasVideoTrack(bytes)) throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: tệp không có hình, chỉ có âm thanh`);
      if (ms > MAX_SOCIAL_VIDEO_MS) throw new DomainError('VIDEO_TOO_LONG', 422, `${name}: video dài quá 3 giờ`);
      durationMs = ms;
    } else {
      if (purpose === 'social' && (!type || !SOCIAL_IMAGE_TYPES.includes(type))) {
        throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: bài đăng chỉ nhận ảnh JPG, PNG, WEBP và video MP4, MOV`);
      }
      // A ZIP of documents (#314) is stored like one; the worker opens it in the sandbox and files every entry.
      if (!type || !(ACCEPTED_UPLOAD_TYPES.includes(type) || ACCEPTED_ARCHIVE_TYPES.includes(type))) {
        throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: chỉ nhận XML, PDF, JPG, PNG, WEBP hoặc ZIP`);
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new DomainError('TOO_LARGE', 413, `${name} vượt quá 25 MB`);
      // An image for a post: its size as shown, from its header (#636); unreadable, it is stored without one.
      if (purpose === 'social' && type) size = imageSize(bytes, type);
    }
    if (!type) throw new DomainError('UNSUPPORTED_TYPE', 415, `${name}: không nhận dạng được tệp`);
    const storageKey = fileKey(orgId, sha256);
    const generation = await putFile(store, storageKey, bytes, type, sha256);
    return runtime.execute<{ fileId: string; duplicate: boolean }>(
      'kernel.file.ingest',
      {
        filename: safeFilename(name, type),
        contentType: type,
        sizeBytes: bytes.byteLength,
        sha256,
        storageKey,
        generation,
        source: purpose === 'social' ? 'social' : purpose === 'import' ? 'import' : purpose === 'sign_document' ? 'sign_document' : purpose === 'agreement' ? 'agreement' : 'upload',
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(size ? { imageWidth: size.width, imageHeight: size.height } : {}),
        // A document only: the entity it is booked in (#1764), which the command checks the uploader sees.
        ...(purpose === 'document' && legalEntityId !== undefined ? { legalEntityId } : {}),
      },
      { actor: actorOf(user), orgId },
    );
  }

  // A body larger than a document may be (a Social video) is held whole in memory while it is hashed and stored, so
  // this process takes at most two of them at once, one per user (#409).
  const large = deps.largeUploads ?? new ConcurrencyLimiter({ total: 2, perKey: 1 });
  // A meeting video upload is held whole in memory several times over (body, copy, ciphertext), so the process takes one at a time.
  const videoTransfers = deps.videoUploads ?? new ConcurrencyLimiter({ total: 1, perKey: 1 });
  const mediaStallMs = deps.mediaStallMs ?? BODY_STALL_TIMEOUT_MS;
  const busy = (c: Context) => {
    c.header('retry-after', String(UPLOAD_BUSY_RETRY_SECONDS));
    return new DomainError('UPLOAD_BUSY', 503, 'Máy chủ đang xử lý nhiều tệp; hãy thử lại sau vài giây');
  };

  // What an upload is for: a document (the default) or an image for a Social post. Anything else is refused.
  // The legal entity a document upload names (#1764): a form field or JSON property, omitted or empty for none. Its
  // shape is checked here; whether the uploader sees it, by kernel.file.ingest.
  function uploadEntity(value: unknown): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || !UUID_TEXT.test(value)) throw new DomainError('INVALID', 400, 'Pháp nhân không hợp lệ');
    return value.toLowerCase();
  }

  function uploadPurpose(value: unknown): UploadPurpose {
    if (value === undefined || value === null || value === '' || value === 'document') return 'document';
    if (value === 'social') return 'social';
    if (value === 'import') return 'import';
    if (value === 'agreement') return 'agreement';
    if (value === 'meeting_audio' || value === 'meeting_video') {
      if (!runtime.installed('meetings')) throw new DomainError('NOT_FOUND', 404, 'Mục đích tải lên không hợp lệ');
      return value;
    }
    if (value === 'sign_document') {
      if (!runtime.installed('sign')) throw new DomainError('NOT_FOUND', 404, 'Mục đích tải lên không hợp lệ');
      return value;
    }
    throw new DomainError('INVALID', 400, 'Mục đích tải lên không hợp lệ');
  }

  // The purpose of an upload, for the org it is for: Meetings and eSign upload purposes belong to their apps, so an org that switched that app off, or does not hold it,
  // gets the answer of a purpose that is not installed (404, as when the deployment leaves the app out; ADR-0053). The grant an upload needs is a kernel command, which the app gate does not cover.
  async function uploadPurposeFor(value: unknown, orgId: string): Promise<UploadPurpose> {
    const purpose = uploadPurpose(value);
    if ((purpose === 'meeting_audio' || purpose === 'meeting_video') && !(await requireAppOn(orgId, 'meetings'))) {
      throw new DomainError('NOT_FOUND', 404, 'Mục đích tải lên không hợp lệ');
    }
    if (purpose === 'sign_document' && !(await requireAppOn(orgId, 'sign'))) {
      throw new DomainError('NOT_FOUND', 404, 'Mục đích tải lên không hợp lệ');
    }
    return purpose;
  }

  async function uploader(c: Context<{ Variables: { user: AuthUser } }>) {
    const user = c.get('user');
    // An extension token's one org is its own; its member's role is checked by the command that records the file, and by
    // the token's standing, which the database reads on every request (a viewer's token is void).
    if (user.extension) return { user, orgId: await resolveOrg(runtime, user, null) };
    const membership = await resolveMembership(runtime, user, readOrgHeader(c));
    if (membership.role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không tải được chứng từ');
    return { user, orgId: membership.orgId };
  }

  // Every body this route reads holds a slot from before its first byte until the answer (#432): a large slot when it
  // may be larger than a batch of documents (no length, or more than 25 MB), otherwise a direct-upload slot. The slot
  // is taken in front of bodyLimit, which reads a body without a length whole before the handler runs, and after the
  // membership check, so only a member who may upload can hold one.
  const directUploads = deps.directUploads ?? new ConcurrencyLimiter({ total: 2 * config.UPLOAD_COMPLETE_CONCURRENCY });
  const uploaders = new WeakMap<Context, { user: AuthUser; orgId: string }>();
  const uploadSlot: MiddlewareHandler<{ Variables: { user: AuthUser } }> = async (c, next) => {
    let who: { user: AuthUser; orgId: string };
    try {
      who = await uploader(c);
    } catch (error) {
      return problem(c, error);
    }
    // Like bodyLimit, a length counts only without Transfer-Encoding.
    const length = c.req.header('transfer-encoding') === undefined ? Number(c.req.header('content-length')) : Number.NaN;
    const slots = !Number.isFinite(length) || length > MAX_UPLOAD_BYTES + 1024 * 1024 ? large : directUploads;
    const release = slots.tryAcquire(who.user.userId);
    if (!release) return problem(c, busy(c));
    uploaders.set(c, who);
    try {
      await next();
    } finally {
      release();
    }
  };
  // Bytes through the kernel: always on local disk, and still accepted with S3 (the server hashes them either way).
  app.post('/api/files', uploadSlot, bodyLimit({ maxSize: UPLOAD_BODY_LIMIT }), async (c) => {
    try {
      const who = uploaders.get(c);
      if (!who) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      const { user, orgId } = who;
      const body = await c.req.parseBody({ all: true });
      const files = ([] as unknown[]).concat(body.file ?? []).filter((f): f is File => f instanceof File);
      const purpose = await uploadPurposeFor(body.purpose, orgId);
      if (purpose === 'meeting_audio' || purpose === 'meeting_video') {
        throw new DomainError('STAGED_UPLOAD_REQUIRED', 400, 'Tệp phương tiện cuộc họp phải tải lên qua cơ chế phân đoạn (POST /api/files/uploads)');
      }
      const legalEntityId = uploadEntity(body.legalEntityId);
      if (files.length === 0) throw new DomainError('NO_FILE', 400, 'Chưa chọn tệp');
      if (files.length > MAX_FILES_PER_UPLOAD) throw new DomainError('TOO_MANY_FILES', 413, `Tối đa ${MAX_FILES_PER_UPLOAD} tệp mỗi lần`);
      const results = [];
      for (const file of files) {
        // With presigned uploads a document comes this way only up to DIRECT_UPLOAD_MAX_BYTES (#432); the SPA sends a
        // larger one as a staged upload. Social images and videos and import spreadsheets keep their own limits.
        if (purpose === 'document' && store.direct && file.size > DIRECT_UPLOAD_MAX_BYTES) {
          throw new DomainError('TOO_LARGE', 413, `${file.name} lớn hơn ${DIRECT_UPLOAD_MAX_BYTES / (1024 * 1024)} MB; máy chủ này nhận tệp lớn qua kho lưu trữ (POST /api/files/uploads)`);
        }
        // A Social video may be up to 100 MB; ingest checks the size against the type it reads from the bytes.
        if (file.size > (purpose === 'social' ? MAX_SOCIAL_VIDEO_BYTES : MAX_UPLOAD_BYTES)) throw new DomainError('TOO_LARGE', 413, `${file.name} vượt quá ${purpose === 'social' ? 100 : 25} MB`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        results.push(await ingest(user, orgId, file.name, bytes, sha256Hex(bytes), purpose, legalEntityId));
      }
      return c.json({ files: results });
    } catch (error) {
      return problem(c, error);
    }
  });

  // Staged presigned uploads (plan §7.6 steps 1 to 3), when the store supports them (STORAGE=s3).
  const direct = store.direct;
  const noDirect = () => new DomainError('NOT_FOUND', 404, 'Máy chủ nhận tệp trực tiếp; hãy dùng POST /api/files');
  // Each completion buffers the staged object (up to 25 MB) while it hashes and writes it, so this process runs at
  // most UPLOAD_COMPLETE_CONCURRENCY of them at once, and one user at most half of them (issue #223).
  const completes = deps.uploadCompletes ?? new ConcurrencyLimiter({ total: config.UPLOAD_COMPLETE_CONCURRENCY });

  // Step 1: a single-use grant and a presigned POST form for a random staging key, 5 minutes, 1 byte to 25 MB.
  app.post('/api/files/uploads', bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    try {
      if (!direct) throw noDirect();
      const { user, orgId } = await uploader(c);
      const input = (await c.req.json().catch(() => null)) as { purpose?: unknown } | null;
      const purpose = await uploadPurposeFor(input?.purpose, orgId);
      const grant = await runtime.execute<{ uploadId: string; stagingKey: string; maxBytes: number }>('kernel.file.upload.begin', { purpose }, {
        actor: actorOf(user),
        orgId,
      });
      // A meeting's media grant is no larger than crove-media takes (#2989): a recording over it is refused here, before the browser sends it to the bucket.
      const grantBytes = purpose === 'meeting_audio' || purpose === 'meeting_video' ? Math.min(grant.maxBytes, meetingMediaCap(purpose === 'meeting_video' ? 'video' : 'audio')) : grant.maxBytes;
      const form = await direct.presignUpload(grant.stagingKey, grantBytes);
      c.header('cache-control', 'private, no-store');
      return c.json({ uploadId: grant.uploadId, url: form.url, fields: form.fields, expiresAt: form.expiresAt.toISOString(), maxBytes: form.maxBytes });
    } catch (error) {
      return problem(c, error);
    }
  });

  // Steps 2 and 3: claim the grant (once), stream the staged object through sha256 with the size cap, write those
  // exact bytes create-only to the org key, record the triple, and delete the staging object. The staging object is
  // never itself a file, and a write to the staging key after the claim is never read.
  //
  // The slot is taken after the (4 KB) body is read, so a slow body holds none, and before the claim: a completion
  // refused with 503 UPLOAD_BUSY leaves its grant unused, so the client retries the same upload after Retry-After.
  app.post('/api/files/uploads/:id/complete', bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    try {
      if (!direct) throw noDirect();
      const { user, orgId } = await uploader(c);
      const input = (await c.req.json().catch(() => null)) as { filename?: unknown; purpose?: unknown; legalEntityId?: unknown } | null;
      const purpose = await uploadPurposeFor(input?.purpose, orgId);
      const legalEntityId = uploadEntity(input?.legalEntityId);
      const filename = typeof input?.filename === 'string' && input.filename.trim() ? input.filename.slice(0, 255) : 'chung-tu';
      const release = completes.tryAcquire(user.userId);
      if (!release) {
        c.header('retry-after', String(UPLOAD_BUSY_RETRY_SECONDS));
        throw new DomainError('UPLOAD_BUSY', 503, 'Máy chủ đang xử lý nhiều tệp; hãy thử lại sau vài giây');
      }
      if (purpose === 'meeting_audio' || purpose === 'meeting_video') {
        release();
        throw new DomainError('INVALID_PURPOSE', 400, 'Tệp phương tiện cuộc họp phải được ghi nhận qua kênh meetings để mã hóa đầu-cuối');
      }
      // A Social upload may be a video of up to 100 MB: it also takes a large slot, before the grant is used.
      const releaseLarge = purpose === 'social' ? large.tryAcquire(user.userId) : () => undefined;
      if (!releaseLarge) {
        release();
        throw busy(c);
      }
      try {
        const claim = await runtime.execute<{ stagingKey: string; maxBytes: number; purpose?: string }>(
          'kernel.file.upload.claim',
          { uploadId: c.req.param('id') },
          { actor: actorOf(user), orgId },
        );
        try {
          // Staged meeting media is sealed only by POST /api/meetings/:id/media: completing it here would store plaintext.
          // (Other purposes keep their old, lenient pairing of begin and complete.) The grant is used up by the claim, so
          // the refusal drops the staged object with the other refusals below (#2780).
          if (claim.purpose === 'meeting_audio' || claim.purpose === 'meeting_video') {
            throw new DomainError('INVALID_PURPOSE', 400, 'Mục đích tệp không khớp với lượt đăng ký tải lên');
          }
          // A document is read up to 25 MB whatever its grant allowed.
          const staged = await direct.readStaged(claim.stagingKey, Math.min(claim.maxBytes, purpose === 'social' ? MAX_SOCIAL_VIDEO_BYTES : MAX_UPLOAD_BYTES)).catch((error: unknown) => {
            if (error instanceof BlobNotFoundError) throw new DomainError('UPLOAD_MISSING', 409, 'Chưa nhận được tệp cho lượt tải lên này');
            throw error;
          });
          if (staged.bytes.byteLength === 0) throw new DomainError('NO_FILE', 400, 'Tệp rỗng');
          return c.json(await ingest(user, orgId, filename, staged.bytes, staged.sha256, purpose, legalEntityId));
        } finally {
          await store.delete(claim.stagingKey).catch((error: unknown) => console.error('[http] staging object not deleted', error));
        }
      } finally {
        releaseLarge();
        release();
      }
    } catch (error) {
      return problem(c, error);
    }
  });

  app.get('/api/files/:id', async (c) => {
    try {
      const user = c.get('user');
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      const file = await runtime.query<{ filename: string; content_type: string; storage_key: string; generation: string | null; sha256: string; size_bytes: string; source: string }>(
        'kernel.file.get',
        { id: c.req.param('id') },
        { actor: actorOf(user), orgId },
      );
      if (file.source === 'meeting_audio' || file.source === 'meeting_video') {
        throw new DomainError('FORBIDDEN', 403, 'Tệp phương tiện cuộc họp không tải trực tiếp được; hãy nghe/xem qua giao diện cuộc họp');
      }
      const ref = { key: file.storage_key, generation: file.generation, sha256: file.sha256 };
      // With S3, a presigned GET of the exact version the row recorded (60 seconds, as an attachment), after the
      // same authorization as a streamed download. A generation that cannot be pinned streams, checked by sha256.
      const presigned = direct ? await direct.presignDownload(ref, { filename: file.filename, contentType: file.content_type }) : null;
      // ?link=1 answers with the URL instead of a redirect, so the app can fetch it without its Authorization and
      // org headers (a redirect would carry the custom header to the bucket and need a CORS preflight there).
      // url null: stream from this endpoint.
      if (c.req.query('link') === '1') {
        c.header('cache-control', 'private, no-store');
        return c.json({ url: presigned });
      }
      if (presigned) {
        return new Response(null, { status: 302, headers: { location: presigned, 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer' } });
      }
      // A file larger than a document (a Social video) is read whole to check its hash: it takes a large slot.
      let releaseLarge: (() => void) | null = null;
      if (Number(file.size_bytes) > MAX_UPLOAD_BYTES) {
        releaseLarge = large.tryAcquire(user.userId);
        if (!releaseLarge) throw busy(c);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readVerified(store, ref);
      } catch (error) {
        releaseLarge?.();
        throw error;
      }
      // A large body keeps its slot until it is handed to the connection (or the client goes away).
      const payload = releaseLarge ? held(bytes, releaseLarge) : body(bytes);
      const isSignAttachment = file.source === 'sign_attachment';
      return new Response(payload, {
        headers: {
          'content-type': file.content_type,
          'content-disposition': isSignAttachment
            ? `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`
            : `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
          'content-security-policy': isSignAttachment
            ? "default-src 'none'; sandbox"
            : "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        },
      });
    } catch (error) {
      return problem(c, error);
    }
  });

  // Isolated note attachments (#3561, docs/plan/notes-v2.md V2-5, owner decision A3, ADR-0037):
  // never touches ludy_kernel.file, refuses extension tokens (403), checks Origin on POST, streams <= 25 MiB,
  // and serves downloads with strict sandbox CSP, X-Content-Type-Options: nosniff, and safe Content-Disposition.
  const assertNoteUploadOrigin = (c: Context) => {
    const origin = c.req.header('origin');
    if (origin === undefined) return;
    const reqOrigin = new URL(c.req.url).origin;
    const publicOrigin = URL.canParse(config.PUBLIC_URL) ? new URL(config.PUBLIC_URL).origin : null;
    const appOrigin = config.APP_URL !== undefined && URL.canParse(config.APP_URL) ? new URL(config.APP_URL).origin : null;
    const permitted =
      origin === reqOrigin ||
      origin === publicOrigin ||
      origin === appOrigin ||
      config.CORS_ALLOWED_ORIGINS.includes(origin);
    if (!permitted) {
      throw new DomainError('FORBIDDEN', 403, 'Nguồn gốc yêu cầu tải lên không hợp lệ');
    }
  };

  app.post('/api/notes/:noteId/attachments', uploadSlot, async (c) => {
    try {
      const who = uploaders.get(c);
      if (!who) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      const { user, orgId } = who;
      if (user.extension) {
        throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
      }
      assertNoteUploadOrigin(c);
      if (!runtime.installed('notes') || !(await requireAppOn(orgId, 'notes'))) {
        throw new DomainError('NOT_FOUND', 404, 'Mô-đun Ghi chú chưa được bật');
      }
      const attachment = await handleNoteAttachmentUpload({
        runtime,
        store,
        user,
        orgId,
        noteId: c.req.param('noteId'),
        req: c.req.raw,
      });
      c.header('cache-control', 'private, no-store');
      return c.json({ attachment }, 201);
    } catch (error) {
      return problem(c, error);
    }
  });

  app.get('/api/notes/attachments/:id', async (c) => {
    c.header('cache-control', 'private, no-store');
    try {
      const user = c.get('user');
      if (user.extension) {
        throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
      }
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      if (!runtime.installed('notes') || !(await requireAppOn(orgId, 'notes'))) {
        throw new DomainError('NOTE_ATTACHMENT_NOT_FOUND', 404, 'Không tìm thấy tệp đính kèm này');
      }
      return await handleNoteAttachmentDownload({
        runtime,
        store,
        user,
        orgId,
        attachmentId: c.req.param('id'),
      });
    } catch (error) {
      return problem(c, error);
    }
  });

  // 1-step Evernote (.enex) and Todoist (.csv) importers (#3564, docs/plan/notes-v2.md V2-9, ADR-0037):
  // refuses extension tokens (403), enforces Origin check, notes app gate, bounded streaming, and BlobStore rollback.
  app.post('/api/notes/import/enex', uploadSlot, async (c) => {
    try {
      const who = uploaders.get(c);
      if (!who) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      const { user, orgId } = who;
      if (user.extension) {
        throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
      }
      assertNoteUploadOrigin(c);
      if (!runtime.installed('notes') || !(await requireAppOn(orgId, 'notes'))) {
        throw new DomainError('NOT_FOUND', 404, 'Mô-đun Ghi chú chưa được bật');
      }
      const result = await handleEnexImportUpload({
        runtime,
        store,
        user,
        orgId,
        req: c.req.raw,
      });
      c.header('cache-control', 'private, no-store');
      return c.json(result, 201);
    } catch (error) {
      return problem(c, error);
    }
  });

  app.post('/api/notes/import/todoist', uploadSlot, async (c) => {
    try {
      const who = uploaders.get(c);
      if (!who) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      const { user, orgId } = who;
      if (user.extension) {
        throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
      }
      assertNoteUploadOrigin(c);
      if (!runtime.installed('notes') || !(await requireAppOn(orgId, 'notes'))) {
        throw new DomainError('NOT_FOUND', 404, 'Mô-đun Ghi chú chưa được bật');
      }
      const result = await handleTodoistImportUpload({
        runtime,
        user,
        orgId,
        req: c.req.raw,
      });
      c.header('cache-control', 'private, no-store');
      return c.json(result, 201);
    } catch (error) {
      return problem(c, error);
    }
  });

  // Sandboxed HR CV PDF/DOCX extraction (#4446 Stage 5D, gate T12):
  // never parses raw bytes in the API process; stages to tmp/<orgId>/<sha256>, relays via outbox to crove-extract in worker,
  // and optionally passes extracted plain text to metered Ly draft proposal inside withAiScope.
  const hrCvAi = {
    reader: deps.conversationReader?.cvExtract ? { cvExtract: deps.conversationReader.cvExtract.bind(deps.conversationReader) } : null,
    budget: drafts,
    aiEnabled: deps.aiEnabled,
  };

  app.post('/api/hr/recruiting/cv-extract', uploadSlot, async (c) => {
    c.header('cache-control', 'private, no-store');
    try {
      const who = uploaders.get(c);
      if (!who) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      const { user, orgId } = who;
      if (user.extension) {
        throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
      }
      assertNoteUploadOrigin(c);
      if (!runtime.installed('hr') || !(await requireAppOn(orgId, 'hr'))) {
        throw new DomainError('NOT_FOUND', 404, 'Mô-đun Nhân sự chưa được bật');
      }
      const actor = actorOf(user);
      const res = await handleHrCvExtractUpload({
        runtime,
        store,
        user,
        orgId,
        req: c.req.raw,
        cvAi: hrCvAi,
        ...(deps.hrCvWaitMs !== undefined ? { waitMs: deps.hrCvWaitMs } : {}),
        runInAiScope: (fn) => (deps.aiMeter ? withAiScope({ orgId, meter: deps.aiMeter(actor) }, fn) : fn()),
      });
      return c.json(res, res.status === 'ready' ? 200 : 202);
    } catch (error) {
      return problem(c, error);
    }
  });

  app.get('/api/hr/recruiting/cv-extract/:jobId', async (c) => {
    c.header('cache-control', 'private, no-store');
    try {
      const user = c.get('user');
      if (user.extension) {
        throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
      }
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      if (!runtime.installed('hr') || !(await requireAppOn(orgId, 'hr'))) {
        throw new DomainError('NOT_FOUND', 404, 'Mô-đun Nhân sự chưa được bật');
      }
      const actor = actorOf(user);
      const openingId = c.req.query('openingId') || undefined;
      const legalEntityId = c.req.query('legalEntityId') || undefined;
      const lang = c.req.query('lang') === 'en' ? 'en' : 'vi';
      const useAi = c.req.query('useAi') !== 'false';
      const res = await handleHrCvExtractPoll({
        runtime,
        store,
        user,
        orgId,
        jobId: c.req.param('jobId'),
        ...(openingId ? { openingId } : {}),
        ...(legalEntityId ? { legalEntityId } : {}),
        lang,
        useAi,
        cvAi: hrCvAi,
        runInAiScope: (fn) => (deps.aiMeter ? withAiScope({ orgId, meter: deps.aiMeter(actor) }, fn) : fn()),
      });
      return c.json(res, res.status === 'ready' ? 200 : 202);
    } catch (error) {
      return problem(c, error);
    }
  });

  // Sandboxed eSign .docx -> tagged A4 PDF relay (#4721, gate T12):
  // never parses .docx bytes in the API process; relays via outbox + worker crove-extract and ingests PDF strictly as actorOf(user).
  app.post('/api/sign/convert-docx', uploadSlot, async (c) => {
    c.header('cache-control', 'private, no-store');
    try {
      const who = uploaders.get(c);
      if (!who) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
      const { user, orgId } = who;
      if (user.extension) {
        throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
      }
      assertNoteUploadOrigin(c);
      if (!runtime.installed('sign') || !(await requireAppOn(orgId, 'sign'))) {
        throw new DomainError('NOT_FOUND', 404, 'Mô-đun Ký số chưa được bật');
      }
      const res = await handleSignDocxConvertUpload({
        runtime,
        store,
        user,
        orgId,
        req: c.req.raw,
        ...(deps.signDocxWaitMs !== undefined ? { waitMs: deps.signDocxWaitMs } : {}),
        onRateLimited: (seconds) => c.header('retry-after', String(seconds)),
      });
      return c.json(res, res.status === 'completed' ? 200 : 202);
    } catch (error) {
      return problem(c, error);
    }
  });

  app.get('/api/sign/convert-docx/:jobId', async (c) => {
    c.header('cache-control', 'private, no-store');
    try {
      const user = c.get('user');
      if (user.extension) {
        throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
      }
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      if (!runtime.installed('sign') || !(await requireAppOn(orgId, 'sign'))) {
        throw new DomainError('NOT_FOUND', 404, 'Mô-đun Ký số chưa được bật');
      }
      const res = await handleSignDocxConvertPoll({
        runtime,
        store,
        user,
        orgId,
        jobId: c.req.param('jobId'),
        ...(c.req.query('filename') ? { filename: c.req.query('filename') } : {}),
      });
      return c.json(res, res.status === 'completed' ? 200 : 202);
    } catch (error) {
      return problem(c, error);
    }
  });

  // Sensitive-audited playback routes for encrypted meeting audio and video (#2576).
  const MEETING_STREAM_WINDOW_BYTES = 4 * 1024 * 1024;
  const mediaMeasurer = deps.mediaMeasurer ?? mediaMeasurerFor(config.MEDIA_URL, config.MEDIA_CALL_TIMEOUT_MS);
  const mediaExtractor = deps.mediaExtractor ?? mediaAudioExtractorFor(config.MEDIA_URL, config.MEDIA_CALL_TIMEOUT_MS);
  // The most bytes one meeting recording may have: the plan's limit, or the lower cap of this deployment's crove-media (#2989).
  const meetingMediaCap = (kind: 'audio' | 'video') => Math.min(kind === 'video' ? MAX_MEETING_VIDEO_BYTES : MAX_MEETING_AUDIO_BYTES, config.MEDIA_MAX_INPUT_BYTES ?? Number.POSITIVE_INFINITY);
  const PLAYBACK_AUDIT_WINDOW_MS = 10 * 60_000;
  const playbackAudited = new Map<string, number>();
  // What the two playback routes share (the bearer route and the ticket route, #2703): the range handling, the audit window,
  // the decryption and the response headers, so a ticket plays exactly what the bearer route plays. The caller has already
  // proved who the actor is; this runs the reader-checked media query as that actor on every request, ranges included.
  interface MeetingMediaServe {
    kind: 'audio' | 'video';
    actor: UserActor;
    orgId: string;
    meetingId: string;
    // Answer the headers a GET would, without reading or decrypting the body.
    headOnly?: boolean;
    // Added to every success answer.
    headers?: Record<string, string>;
    // The video file and key id a ticket was issued for: the media now named must be the same.
    expect?: { fileId: string; keyId: string };
    // Called once when the response is finished or was never started (a body read to the end, cancelled, or an error).
    onFinished?: () => void;
    // The caller holds its own concurrency limit, so the shared large-transfer slot is not taken.
    ownLimit?: boolean;
    // Run before every window after the first of a stream read without a Range: it throws to end the stream (a ticket past its
    // expiry, a revoked session), so a long answer does not outlive what let it start.
    recheck?: () => Promise<void>;
    // The answer for any error thrown on the way.
    fail: (error: unknown) => Response;
  }
  async function serveMeetingMedia(c: Context, p: MeetingMediaServe): Promise<Response> {
    const { kind, actor, orgId, meetingId } = p;
    if (!runtime.installed('meetings')) {
      p.onFinished?.();
      return c.notFound();
    }

    const slot = large && !p.ownLimit ? large.tryAcquire(actor.userId) : () => undefined;
    if (!slot) {
      p.onFinished?.();
      return p.fail(busy(c));
    }
    let finished = false;
    const releaseLarge = () => {
      if (finished) return;
      finished = true;
      slot();
      p.onFinished?.();
    };

    let dataKey: Buffer | null = null;
    let wrapSubkey: Buffer | null = null;
    let heldReturned = false;

    try {
      const rangeHeader = c.req.header('range');

      // The first request of a (member, meeting, kind) in a window is the audited sensitive read, whatever its Range; the
      // continuation ranges of the same playback then use the unaudited metadata read, so scrubbing writes one audit row.
      const auditKey = `${orgId}:${actor.userId}:${meetingId}:${kind}`;
      const now = Date.now();
      const auditedUntil = playbackAudited.get(auditKey);
      const continuation = auditedUntil !== undefined && auditedUntil > now;
      const queryName = continuation
        ? 'meetings.meeting.media_meta'
        : kind === 'audio'
          ? 'meetings.meeting.audio_read'
          : 'meetings.meeting.video_read';
      const queryInput = continuation ? { meetingId, kind } : { meetingId };
      const media = await runtime.query<{
        meetingId: string;
        fileId: string;
        storageKey: string;
        generation: string | null;
        sizeBytes: number;
        sha256: string;
        contentType: string;
        keyId: string;
        wrappedKey: Buffer;
      }>(queryName, queryInput, { actor, orgId });
      if (p.expect && (media.fileId !== p.expect.fileId || media.keyId !== p.expect.keyId)) {
        throw new DomainError('VIDEO_TICKET_INVALID', 401, 'The ticket is for another video');
      }
      // Marked only after the audited read succeeded, so a failed audit write cannot let the retry skip it.
      if (!continuation) {
        if (playbackAudited.size >= 10_000) for (const [k, until] of playbackAudited) if (until <= now) playbackAudited.delete(k);
        if (playbackAudited.size >= 10_000) playbackAudited.clear();
        playbackAudited.set(auditKey, now + PLAYBACK_AUDIT_WINDOW_MS);
      }

      const broker = deps.broker ?? createCredentialBroker(config);
      wrapSubkey = broker.deriveKey
        ? broker.deriveKey(media.keyId, 'crove.meetings.v1|wrap')
        : broker.derive && broker.keyId === media.keyId
          ? broker.derive('crove.meetings.v1|wrap')
          : null;
      if (!wrapSubkey) {
        throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media decryption key unavailable');
      }

      const binding: MediaKeyBinding = {
        orgId,
        meetingId: media.meetingId,
        kind,
        keyId: media.keyId,
      };
      dataKey = unwrapMediaKeyWithSubkey(media.wrappedKey, binding, wrapSubkey);

      const totalPlaintextLength = plaintextLengthFromCiphertextLength(media.sizeBytes);
      const maxCiphertextCap = (kind === 'video' ? MAX_MEETING_VIDEO_BYTES : MAX_MEETING_AUDIO_BYTES) + 2 * 1024 * 1024;
      const readCiphertextSlice = async (ctStart: number, ctEnd: number): Promise<Uint8Array> => {
        const sliceLen = ctEnd - ctStart + 1;
        return store.getRange
          ? store.getRange(media.storageKey, ctStart, ctEnd, media.generation, sliceLen)
          : (await store.get(media.storageKey, media.generation, Math.min(media.sizeBytes, maxCiphertextCap))).subarray(ctStart, ctEnd + 1);
      };

      const mediaHeaders: Record<string, string> = {
        'content-type': media.contentType,
        'accept-ranges': 'bytes',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-site',
        'cache-control': 'private, no-store',
        ...p.headers,
      };

      if (p.headOnly) {
        return new Response(null, { status: 200, headers: { ...mediaHeaders, 'content-length': String(totalPlaintextLength) } });
      }

      if (rangeHeader && rangeHeader.startsWith('bytes=')) {
        const spec = rangeHeader.slice(6).trim();
        let start: number;
        let end: number;

        if (spec.startsWith('-')) {
          const suffix = parseInt(spec.slice(1), 10);
          if (isNaN(suffix) || suffix <= 0 || totalPlaintextLength === 0) {
            return new Response(null, {
              status: 416,
              headers: { ...p.headers, 'content-range': `bytes */${totalPlaintextLength}`, 'x-content-type-options': 'nosniff' },
            });
          }
          start = Math.max(0, totalPlaintextLength - suffix);
          end = totalPlaintextLength - 1;
        } else {
          const parts = spec.split('-');
          start = parseInt(parts[0] ?? '', 10);
          end = parts[1] && parts[1].length > 0 ? parseInt(parts[1], 10) : totalPlaintextLength - 1;
          if (isNaN(start) || isNaN(end) || start < 0 || start > end || start >= totalPlaintextLength) {
            return new Response(null, {
              status: 416,
              headers: { ...p.headers, 'content-range': `bytes */${totalPlaintextLength}`, 'x-content-type-options': 'nosniff' },
            });
          }
          end = Math.min(end, totalPlaintextLength - 1);
        }

        end = Math.min(end, start + MEETING_STREAM_WINDOW_BYTES - 1);

        const map = mapPlaintextRangeToChunks(start, end, media.sizeBytes);
        const ctSlice = await readCiphertextSlice(map.ctStart, map.ctEnd);
        const decryptedChunks = decryptBlobChunks(
          Buffer.from(ctSlice),
          dataKey,
          { orgId, meetingId: media.meetingId, kind },
          map.firstChunk,
          map.lastChunk,
          map.totalChunks,
        );
        const chunk = decryptedChunks.subarray(map.offsetInFirstChunk, map.offsetInFirstChunk + map.requestedLength);

        heldReturned = true;
        return new Response(held(new Uint8Array(chunk), releaseLarge), {
          status: 206,
          headers: {
            ...mediaHeaders,
            'content-range': `bytes ${start}-${end}/${totalPlaintextLength}`,
            'content-length': String(chunk.length),
          },
        });
      }

      if (totalPlaintextLength === 0) {
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: {
            ...mediaHeaders,
            'content-length': '0',
          },
        });
      }

      if (totalPlaintextLength <= MEETING_STREAM_WINDOW_BYTES) {
        const map = mapPlaintextRangeToChunks(0, totalPlaintextLength - 1, media.sizeBytes);
        const ctSlice = await readCiphertextSlice(map.ctStart, map.ctEnd);
        const decrypted = decryptBlobChunks(
          Buffer.from(ctSlice),
          dataKey,
          { orgId, meetingId: media.meetingId, kind },
          map.firstChunk,
          map.lastChunk,
          map.totalChunks,
        );

        heldReturned = true;
        return new Response(held(new Uint8Array(decrypted), releaseLarge), {
          status: 200,
          headers: {
            ...mediaHeaders,
            'content-length': String(decrypted.length),
          },
        });
      }

      // Stream unranged large files in bounded 4 MiB chunk windows so heap stays O(1).
      const streamDataKey = Buffer.from(dataKey);
      let streamOffset = 0;
      let streamReleased = false;
      // An idle stream (a client that stopped reading) is closed after 5 minutes; every pull restarts the clock, so a slow
      // link on a 2 GiB video is not cut off while it is still being read.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanupStream = () => {
        if (streamReleased) return;
        streamReleased = true;
        if (idleTimer) clearTimeout(idleTimer);
        streamDataKey.fill(0);
        releaseLarge();
      };
      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(cleanupStream, 5 * 60_000);
        idleTimer.unref();
      };
      armIdleTimer();

      const streamBody = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            armIdleTimer();
            // Each window first asks again whether the meeting and its key still exist: the query fails once the meeting or its
            // key is deleted, so the stream stops and the key copy is cleared. A reseal changes only the wrapping key id, not
            // the media key this stream holds, so the id is not compared. The file is compared: retention deletes the media
            // rows (#2579), so the segment or video the meeting names now may not be the object this stream reads.
            if (streamOffset > 0) {
              await p.recheck?.();
              const current = await runtime.query<{ fileId: string }>('meetings.meeting.media_meta', { meetingId, kind }, { actor, orgId });
              if (current.fileId !== media.fileId) throw new DomainError('MEDIA_REPLACED', 409, 'The meeting media changed while it was playing');
            }
            if (streamOffset >= totalPlaintextLength) {
              controller.close();
              cleanupStream();
              return;
            }
            const windowEnd = Math.min(totalPlaintextLength - 1, streamOffset + MEETING_STREAM_WINDOW_BYTES - 1);
            const map = mapPlaintextRangeToChunks(streamOffset, windowEnd, media.sizeBytes);
            const ctSlice = await readCiphertextSlice(map.ctStart, map.ctEnd);
            const decryptedWindow = decryptBlobChunks(
              Buffer.from(ctSlice),
              streamDataKey,
              { orgId, meetingId: media.meetingId, kind },
              map.firstChunk,
              map.lastChunk,
              map.totalChunks,
            );
            const slice = decryptedWindow.subarray(map.offsetInFirstChunk, map.offsetInFirstChunk + map.requestedLength);
            streamOffset = windowEnd + 1;
            controller.enqueue(new Uint8Array(slice));
            if (streamOffset >= totalPlaintextLength) {
              controller.close();
              cleanupStream();
            }
          } catch (err) {
            cleanupStream();
            controller.error(err);
          }
        },
        cancel() {
          cleanupStream();
        },
      });

      heldReturned = true;
      return new Response(streamBody, {
        status: 200,
        headers: {
          ...mediaHeaders,
          'content-length': String(totalPlaintextLength),
        },
      });
    } catch (error) {
      return p.fail(error);
    } finally {
      dataKey?.fill(0);
      wrapSubkey?.fill(0);
      if (!heldReturned) {
        releaseLarge();
      }
    }
  }

  async function streamMeetingMedia(c: Context, kind: 'audio' | 'video'): Promise<Response> {
    if (!runtime.installed('meetings')) return c.notFound();
    const user = c.get('user');
    let orgId: string;
    try {
      orgId = await resolveOrg(runtime, user, readOrgHeader(c));
    } catch (error) {
      return problem(c, error);
    }
    return serveMeetingMedia(c, { kind, actor: actorOf(user), orgId, meetingId: c.req.param('id') ?? '', fail: (error) => problem(c, error) });
  }

  app.get('/api/meetings/:id/audio', (c) => streamMeetingMedia(c, 'audio'));
  app.get('/api/meetings/:id/video', (c) => streamMeetingMedia(c, 'video'));

  // Everything that must hold before one byte of the body is read into memory: the module is on, the caller is the meeting's
  // recorder, a large-transfer slot is held (kept until the response is done) and the declared size is within the cap. A JSON
  // body (a staged upload's id) is tiny; a file larger than its cap is refused from the declared Content-Length, and the body
  // limit below stops a chunked one at the same cap, with at most two such transfers in the process at once.
  const META_BODY_MAX_BYTES = 16 * 1024;
  // What the media routes need of a meeting: whether the caller recorded it and whether it keeps video. An extension
  // token (#2582) reads it through the status query, which answers 404 for any meeting the token did not create and
  // returns no title, reader or content; the token's member is then the recorder, as the query checks.
  const meetingFacts = async (user: AuthUser, orgId: string, meetingId: string): Promise<{ isRecorder: boolean; keepVideo: boolean; liveNotes: boolean }> => {
    if (user.extension) {
      const status = await runtime.query<{ keepVideo: boolean; liveNotes: boolean }>('meetings.meeting.extension_status', { meetingId }, { actor: actorOf(user), orgId });
      return { isRecorder: true, keepVideo: status.keepVideo, liveNotes: status.liveNotes };
    }
    return runtime.query<{ isRecorder: boolean; keepVideo: boolean; liveNotes: boolean }>('meetings.meeting.get', { meetingId }, { actor: actorOf(user), orgId });
  };
  const mediaGate: MiddlewareHandler<{ Variables: { user: AuthUser; mediaBodyCap: number; videoSlotHeld: boolean } }> = async (c, next) => {
    let release: (() => void) | null = null;
    let releaseVideo: (() => void) | null = null;
    try {
      if (!runtime.installed('meetings')) throw new DomainError('NOT_FOUND', 404, 'Mô-đun Cuộc họp chưa được bật');
      const user = c.get('user');
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      const meeting = await meetingFacts(user, orgId, c.req.param('id') ?? '');
      if (!meeting.isRecorder) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder may upload media');
      const json = (c.req.header('content-type') ?? '').includes('application/json');
      // The body cap comes from the declared kind (the `kind` query parameter) before one byte is read: audio is capped at 300 MB.
      // Without the parameter a meeting that keeps video is assumed to send video, and one that does not can only send audio.
      const hint = c.req.query('kind');
      if (hint !== undefined && hint !== 'audio' && hint !== 'video') throw new DomainError('BAD_REQUEST', 400, 'kind must be audio or video');
      const videoSize = !json && meeting.keepVideo && hint !== 'audio';
      // `extract=audio` (#3337): the file is a video whose audio alone is kept. It is sized and counted as a video (the video cap, the video transfer slot),
      // and refused before one byte is read when crove-media is not configured. The JSON shape (a staged upload) is capped by its own grant and takes the slot in the route.
      const extractFlag = c.req.query('extract');
      if (extractFlag !== undefined && extractFlag !== 'audio') throw new DomainError('BAD_REQUEST', 400, 'extract must be audio');
      const extract = extractFlag === 'audio';
      if (extract && hint === 'video') throw new DomainError('BAD_REQUEST', 400, 'extract=audio is only for kind audio');
      if (extract && !mediaExtractor.configured) throw mediaProbeUnavailable();
      const cap = json ? META_BODY_MAX_BYTES : meetingMediaCap(videoSize || extract ? 'video' : 'audio') + 1024 * 1024;
      // The raw body of the file (#2780) is sealed as it streams, so its size is declared up front: a body without a
      // Content-Length, or sent chunked, is refused before it is read (the body limit below would hold a chunked body whole to
      // count it, which is what streaming is for). Browsers send the length of a File they upload.
      const rawFile = /^(?:audio\/|video\/|application\/octet-stream)/i.test(c.req.header('content-type') ?? '');
      if (rawFile && (c.req.header('transfer-encoding') !== undefined || !/^\d+$/.test(c.req.header('content-length') ?? ''))) {
        throw new DomainError('BAD_REQUEST', 400, 'Tệp phải được gửi kèm Content-Length hợp lệ');
      }
      const declared = Number(c.req.header('content-length') ?? '0');
      if (!Number.isFinite(declared) || declared < 0) throw new DomainError('BAD_REQUEST', 400, 'Content-Length is not valid');
      if (declared > cap) {
        throw new DomainError('FILE_TOO_LARGE', 413, 'Tệp vượt quá giới hạn tối đa');
      }
      c.set('mediaBodyCap', cap);
      release = large.tryAcquire(user.userId);
      if (!release) throw busy(c);
      const takeVideoSlot = videoSize || (extract && !json);
      if (takeVideoSlot) {
        releaseVideo = videoTransfers.tryAcquire(user.userId);
        if (!releaseVideo) throw busy(c);
      }
      c.set('videoSlotHeld', takeVideoSlot);
    } catch (error) {
      release?.();
      return problem(c, error);
    }
    try {
      await next();
    } finally {
      release?.();
      releaseVideo?.();
    }
  };
  const mediaBodyLimit: MiddlewareHandler<{ Variables: { user: AuthUser; mediaBodyCap: number; videoSlotHeld: boolean } }> = (c, next) =>
    bodyLimit({ maxSize: c.get('mediaBodyCap') })(c, next);
  // Which import route a platform recording belongs to (C2, #3174 follow-up #3923): one with neither an audio nor a video file is the transcript's (POST /api/meetings/:id/transcript-import), every other is the
  // media route's. A request that names the wrong route is refused BEFORE the claim moves the row, so the row stays staged with its bytes for the right request (the app routes by the same rule). A row that is
  // not in the member's own list is left to the claim, which answers "not found".
  const refuseWrongImportRoute = async (user: AuthUser, orgId: string, recordingId: string, route: 'media' | 'transcript'): Promise<void> => {
    // The row by its id, whatever its age (the list holds only the newest 50, so a scan of it would miss an older row and let the wrong route claim it).
    const rows = await runtime.query<Array<{ id: string; hasAudio: boolean; hasVideo: boolean }>>('kernel.meeting_platform.recordings', { recordingId }, { actor: actorOf(user), orgId });
    const row = rows.find((r) => r.id === recordingId);
    if (!row) return;
    const transcriptOnly = !row.hasAudio && !row.hasVideo;
    if (route === 'media' && transcriptOnly) throw new DomainError('BAD_REQUEST', 400, 'Bản ghi này chỉ có bản chép lời, hãy nhập nó bằng bản chép lời');
    if (route === 'transcript' && !transcriptOnly) throw new DomainError('BAD_REQUEST', 400, 'Bản ghi này có âm thanh hoặc video, không nhập được bằng bản chép lời');
  };
  app.post('/api/meetings/:id/media', mediaGate, mediaBodyLimit, async (c) => {
    try {
      if (!runtime.installed('meetings')) {
        throw new DomainError('NOT_FOUND', 404, 'Mô-đun Cuộc họp chưa được bật');
      }
      const user = c.get('user');
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      const meetingId = c.req.param('id');
      const release = completes.tryAcquire(user.userId);
      if (!release) throw busy(c);
      // `extract=audio` (#3337): the file is a video and only its audio is kept. The gate has checked the flag in the query; a multipart form may carry it as a field.
      let extract = c.req.query('extract') === 'audio';

      // Set by prepareKeys inside the try (a closure, so the compiler cannot see it): typed as what they may hold.
      let dataKey = null as Buffer | null;
      let wrapSubkey = null as Buffer | null;
      let stagingKeyToDelete: string | null = null;
      let releaseJsonVideo: (() => void) | null = null;
      // The platform recording this request claimed (C1, #3173): any failure after the claim fails that row with a short code.
      let claimedImportId: string | null = null;

      try {
        // The length of the recording is measured in crove-media after sealing, so without it nothing is read or stored (#2985).
        if (!mediaMeasurer.configured) throw mediaProbeUnavailable();
        if (extract && !mediaExtractor.configured) throw mediaProbeUnavailable();
        const contentTypeHeader = c.req.header('content-type') ?? '';
        let kind: 'audio' | 'video';
        // The plaintext as it arrives, sealed piece by piece below (#2780): never held whole, and its declared length is checked.
        let source: AsyncIterable<Uint8Array>;
        let declaredLength: number;
        // Why the recording stopped without the recorder's click, when the client says so (A1, #3159): a code from a fixed list in the
        // JSON body, the form or the query, whichever carries the file. Anything else is refused; absent means the recorder stopped it.
        let stopReason: RecordingStopReason | undefined;
        const readStopReason = (value: unknown): RecordingStopReason | undefined => {
          if (value === undefined || value === null || value === '') return undefined;
          if (typeof value === 'string' && (RECORDING_STOP_REASONS as readonly string[]).includes(value)) return value as RecordingStopReason;
          throw new DomainError('BAD_REQUEST', 400, 'stopReason is not a known code');
        };

        const verifyRecorderAndKind = async (mediaKind: 'audio' | 'video') => {
          const meeting = await meetingFacts(user, orgId, meetingId);
          if (!meeting.isRecorder) {
            throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder may upload media');
          }
          if (mediaKind === 'video' && !meeting.keepVideo) {
            throw new DomainError('VIDEO_NOT_ENABLED', 400, 'Video retention is disabled for this meeting');
          }
        };

        // The key is checked before anything is opened or stored, so a 503 leaves no orphaned blob and no open staged read.
        let keys = undefined as { keyId: string; wrappedKey: Buffer; binding: BlobMediaBinding } | undefined;
        const prepareKeys = (mediaKind: 'audio' | 'video') => {
          dataKey = generateMediaDataKey();
          const binding: BlobMediaBinding = { orgId, meetingId, kind: mediaKind };
          const broker = deps.broker ?? createCredentialBroker(config);
          const keyId = broker.keyId;
          if (!keyId || (!broker.derive && !broker.deriveKey)) {
            throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media encryption key unavailable');
          }
          wrapSubkey = broker.deriveKey
            ? broker.deriveKey(keyId, 'crove.meetings.v1|wrap')
            : broker.derive && broker.keyId === keyId
              ? broker.derive('crove.meetings.v1|wrap')
              : null;
          if (!wrapSubkey) {
            throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media encryption key derivation failed');
          }
          const keyBinding: MediaKeyBinding = { ...binding, keyId };
          keys = { keyId, binding, wrappedKey: wrapMediaKeyWithSubkey(dataKey, keyBinding, wrapSubkey) };
        };

        if (contentTypeHeader.includes('application/json')) {
          const body = (await c.req.json().catch(() => null)) as {
            uploadId?: unknown;
            importId?: unknown;
            kind?: unknown;
            lengthSeconds?: unknown;
            stopReason?: unknown;
          } | null;
          // Exactly one of uploadId (a presigned upload) and importId (a recording a meeting platform finished, C1 #3173; audio only).
          if (!body || (typeof body.uploadId === 'string') === (typeof body.importId === 'string') || (body.kind !== 'audio' && body.kind !== 'video')) {
            throw new DomainError('BAD_REQUEST', 400, 'Exactly one of uploadId and importId, and kind (audio|video), required');
          }
          if (typeof body.importId === 'string' && (body.kind !== 'audio' || !UUID_TEXT.test(body.importId))) {
            throw new DomainError('BAD_REQUEST', 400, 'importId must be a uuid and kind must be audio');
          }
          kind = body.kind;
          stopReason = readStopReason(body.stopReason);
          if (extract && (kind !== 'audio' || typeof body.importId === 'string')) {
            throw new DomainError('BAD_REQUEST', 400, 'extract=audio is only for an uploaded file of kind audio, not a platform import');
          }
          if (kind === 'video' || extract) {
            // The staged bytes are read whole into memory: one video transfer per process (a multipart one took its slot in the gate).
            releaseJsonVideo = videoTransfers.tryAcquire(user.userId);
            if (!releaseJsonVideo) throw busy(c);
          }
          // The client's lengthSeconds is a hint at most and never stored: the sandbox measures the length (#2985).
          if (body.lengthSeconds !== undefined) {
            if (typeof body.lengthSeconds !== 'number' || !Number.isInteger(body.lengthSeconds) || body.lengthSeconds <= 0) {
              throw new DomainError('BAD_REQUEST', 400, 'lengthSeconds must be a positive integer');
            }
          }

          await verifyRecorderAndKind(kind);

          let claim: { stagingKey: string; cap: number };
          if (typeof body.importId === 'string') {
            await refuseWrongImportRoute(user, orgId, body.importId, 'media');
            // The worker staged the bytes; this request takes them, then seals and records them like an upload (the row is the member's own: another's is answered as absent).
            // The claim names this route's meeting, so a recording begun for another meeting is refused before the row moves (it never ends up claimed by a request it cannot serve).
            const imported = await runtime.execute<{ stagingKey: string; meetingId: string }>(
              'kernel.meeting_platform.import.claim',
              { recordingId: body.importId, meetingId },
              { actor: actorOf(user), orgId },
            );
            claimedImportId = body.importId;
            stagingKeyToDelete = imported.stagingKey;
            if (imported.meetingId !== meetingId) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy bản ghi này');
            // The job already held the file to the same audio cap (MEETING_PLATFORM_IMPORT_MAX_BYTES); a later extraction of audio from a video can change its size, so the cap is the upload's own.
            claim = { stagingKey: imported.stagingKey, cap: meetingMediaCap('audio') };
          } else {
            const uploaded = await runtime.execute<{ stagingKey: string; maxBytes: number; purpose?: string }>(
              'kernel.file.upload.claim',
              { uploadId: body.uploadId },
              { actor: actorOf(user), orgId },
            );
            stagingKeyToDelete = uploaded.stagingKey;

            // A video whose audio is extracted (#3337) is staged for video (the grant of meeting_audio is capped at the audio size, which a video exceeds): either purpose fits there.
            const purposeFits = extract ? uploaded.purpose === 'meeting_video' || uploaded.purpose === 'meeting_audio' : uploaded.purpose === (kind === 'audio' ? 'meeting_audio' : 'meeting_video');
            if (!purposeFits) {
              throw new DomainError('INVALID_PURPOSE', 400, 'Mục đích tệp không khớp với lượt đăng ký tải lên');
            }
            claim = { stagingKey: uploaded.stagingKey, cap: Math.min(uploaded.maxBytes, meetingMediaCap(extract ? 'video' : kind)) };
          }

          prepareKeys(kind);
          const missing = (error: unknown): never => {
            if (error instanceof BlobNotFoundError) throw new DomainError('UPLOAD_MISSING', 409, 'Chưa nhận được tệp cho lượt tải lên này');
            throw error;
          };
          const cap = claim.cap;
          if (direct?.openStaged) {
            // Streamed from the bucket: the declared size is checked against the cap before a byte is read.
            const opened = await direct.openStaged(claim.stagingKey, cap).catch(missing);
            source = opened.chunks;
            declaredLength = opened.size;
          } else {
            const bytes = direct ? (await direct.readStaged(claim.stagingKey, cap).catch(missing)).bytes : await store.get(claim.stagingKey, null, cap).catch(missing);
            source = onepiece(bytes);
            declaredLength = bytes.byteLength;
          }
        } else if (contentTypeHeader.includes('multipart/form-data')) {
          const formData = await c.req.formData().catch(() => null);
          if (!formData) throw new DomainError('BAD_REQUEST', 400, 'Invalid form data');
          const kindVal = formData.get('kind');
          if (kindVal !== 'audio' && kindVal !== 'video') {
            throw new DomainError('BAD_REQUEST', 400, 'kind must be audio or video');
          }
          kind = kindVal;
          stopReason = readStopReason(formData.get('stopReason'));
          const extractField = formData.get('extract');
          if (extractField !== null && extractField !== '') {
            if (extractField !== 'audio') throw new DomainError('BAD_REQUEST', 400, 'extract must be audio');
            extract = true;
          }
          if (extract) {
            if (kind !== 'audio') throw new DomainError('BAD_REQUEST', 400, 'extract=audio is only for kind audio');
            // A form field is read with the form, so only now: a deployment without crove-media refuses here (the query flag is refused before the body).
            if (!mediaExtractor.configured) throw mediaProbeUnavailable();
            // The gate took the slot when the query said so; a form field alone takes it here. A form is held whole by its parser: a large video goes as the raw body.
            if (!c.get('videoSlotHeld')) {
              releaseJsonVideo = videoTransfers.tryAcquire(user.userId);
              if (!releaseJsonVideo) throw busy(c);
            }
          }
          const kindHint = c.req.query('kind');
          if (kindHint !== undefined && kindHint !== kind) throw new DomainError('BAD_REQUEST', 400, 'kind does not match the declared kind');
          await verifyRecorderAndKind(kind);

          const fileVal = formData.get('file');
          if (!fileVal || !(fileVal instanceof Blob)) {
            throw new DomainError('NO_FILE', 400, 'Tệp tải lên không hợp lệ');
          }
          const maxBytes = meetingMediaCap(extract ? 'video' : kind);
          if (fileVal.size > maxBytes) {
            throw new DomainError('FILE_TOO_LARGE', 413, `Tệp vượt quá giới hạn tối đa (${sizeText(maxBytes)})`);
          }
          const lengthVal = formData.get('lengthSeconds');
          if (typeof lengthVal === 'string' && lengthVal.trim().length > 0) {
            const parsedLen = Number(lengthVal.trim());
            if (!Number.isInteger(parsedLen) || parsedLen <= 0) {
              throw new DomainError('BAD_REQUEST', 400, 'lengthSeconds must be a positive integer');
            }
          }
          prepareKeys(kind);
          // The form was parsed whole by the body reader (use the raw body below for a large file); the sealing still streams.
          source = streamPieces(fileVal.stream() as ReadableStream<Uint8Array>);
          declaredLength = fileVal.size;
        } else if (/^(?:audio\/|video\/|application\/octet-stream)/i.test(contentTypeHeader)) {
          // The raw body of the file (#2780): sealed as it arrives, so a large recording is never held. The kind and the
          // length come in the query, because the body is the file and nothing else; the gate capped it by the same kind.
          const kindVal = c.req.query('kind');
          if (kindVal !== 'audio' && kindVal !== 'video') throw new DomainError('BAD_REQUEST', 400, 'kind must be audio or video');
          kind = kindVal;
          if (extract && kind !== 'audio') throw new DomainError('BAD_REQUEST', 400, 'extract=audio is only for kind audio');
          stopReason = readStopReason(c.req.query('stopReason'));
          await verifyRecorderAndKind(kind);
          const lengthVal = c.req.query('lengthSeconds');
          if (lengthVal !== undefined) {
            const parsedLen = Number(lengthVal.trim());
            if (lengthVal.trim() === '' || !Number.isInteger(parsedLen) || parsedLen <= 0) {
              throw new DomainError('BAD_REQUEST', 400, 'lengthSeconds must be a positive integer');
            }
          }
          const rawBody = c.req.raw.body;
          if (!rawBody) throw new DomainError('NO_FILE', 400, 'Tệp rỗng');
          prepareKeys(kind);
          // A body that stops arriving for mediaStallMs is cancelled and refused, which frees the video slot: a large upload may
          // take long, but never silently.
          source = streamPieces(rawBody as ReadableStream<Uint8Array>, mediaStallMs);
          // The gate required a Content-Length; the sealing refuses a body that ends short of it or runs past it.
          declaredLength = Number(c.req.header('content-length'));
        } else {
          throw new DomainError('BAD_REQUEST', 400, 'Content-Type must be application/json, multipart/form-data or the file itself (audio/*, video/*, application/octet-stream)');
        }

        if (!keys || !dataKey) throw new Error('media keys were not prepared');
        const { keyId, wrappedKey, binding } = keys;

        // The video of an `extract=audio` upload is sealed under a throwaway key, streamed to crove-media and deleted; what is sealed below, and recorded,
        // is only the Opus audio it returned (audio cap, audio container, measured like any audio): the video is never stored (#3337).
        if (extract) {
          const extracted = await extractAudioFromVideo({
            source,
            expectedLength: declaredLength,
            maxBytes: meetingMediaCap('video'),
            store,
            orgId,
            meetingId,
            extractor: mediaExtractor,
          });
          source = onepiece(extracted.audio);
          declaredLength = extracted.audio.length;
        }

        // Sealed as it streams: the container is sniffed from the first bytes, the cap is counted as the bytes arrive, and the
        // ciphertext goes to the store's streamed write, which hashes it and stores it under its content address.
        const sealed = await sealMedia({
          source,
          expectedLength: declaredLength,
          kind,
          dataKey,
          binding,
          maxBytes: meetingMediaCap(kind),
          store,
          orgId,
        });
        const { key: storageKey, generation, sha256, contentType: sniffedContentType } = sealed;

        // The sandbox measures the sealed media (read back and decrypted a window at a time, never held whole or written out). It
        // refuses a file it cannot read, one that is too long, or when it is down; the sealed bytes then have no row, so drop them.
        let measuredSeconds: number;
        try {
          measuredSeconds = await mediaMeasurer.measure(
            kind,
            decryptedWindows(store, { storageKey, generation, sizeBytes: sealed.size }, dataKey, binding),
          );
        } catch (error) {
          if (sealed.created) await store.delete(storageKey).catch((err) => console.error('[http] meeting media cleanup failed', err));
          throw error;
        }

        let result: { fileId: string };
        try {
          result = await runtime.execute<{ fileId: string }>(
            'meetings.media.record',
            {
              meetingId,
              kind,
              keyId,
              wrappedKeyHex: wrappedKey.toString('hex'),
              storageKey,
              generation,
              sizeBytes: sealed.size,
              sha256,
              contentType: sniffedContentType,
              lengthSeconds: measuredSeconds,
              ...(stopReason !== undefined ? { stopReason } : {}),
            },
            { actor: actorOf(user), orgId },
          );
        } catch (error) {
          // The record was refused (a second upload of the kind, a lost race): the sealed bytes have no row, so drop them.
          if (sealed.created) await store.delete(storageKey).catch((err) => console.error('[http] meeting media cleanup failed', err));
          throw error;
        }

        return c.json(result);
      } catch (error) {
        // A claimed platform recording that did not become the meeting's media fails with a short code the member can read (never the error's own text), best effort.
        if (claimedImportId) {
          const code = (error as { code?: unknown } | null)?.code;
          const failure = code === 'FILE_TOO_LARGE' ? 'too_large' : code === 'MEDIA_TOO_LONG' ? 'too_long' : code === 'INVALID_MEDIA_CONTAINER' || code === 'MEDIA_PROBE_FAILED' || code === 'NO_FILE' ? 'invalid_media' : 'claim_failed';
          await runtime
            .execute('kernel.meeting_platform.import.claim_failed', { recordingId: claimedImportId, code: failure }, { actor: actorOf(user), orgId })
            .catch((err) => console.error('[http] meeting import failure not recorded', err));
        }
        throw error;
      } finally {
        if (stagingKeyToDelete) {
          await store.delete(stagingKeyToDelete).catch((err) => console.error('[http] meeting staging deletion failed', err));
        }
        releaseJsonVideo?.();
        dataKey?.fill(0);
        wrapSubkey?.fill(0);
        release();
      }
    } catch (error) {
      return problem(c, error);
    }
  });

  // The member's request that finishes a TRANSCRIPT-ONLY import (C2, #3174). The worker's job staged the platform's own transcript as JSON under the recording's staging key (meetings-import.ts); this request, like
  // the media route does for audio, claims the row (the member's own, begun for THIS meeting), reads the staged lines back under a size cap, bounds them again with the command's own schema (the bytes are tainted
  // input, whoever wrote them) and runs meetings.import.take_transcript as the recorder, which writes them as the recorder's tainted draft labelled with the platform and ends the meeting. The staged bytes are deleted
  // in every outcome; a failure after the claim fails the row with a short code. No audio is made, no model is called, and only the recorder may do this (as for media).
  app.post('/api/meetings/:id/transcript-import', bodyLimit({ maxSize: 1024 }), async (c) => {
    try {
      if (!runtime.installed('meetings')) throw new DomainError('NOT_FOUND', 404, 'Mô-đun Cuộc họp chưa được bật');
      const user = c.get('user');
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      const meetingId = c.req.param('id') ?? '';
      const body = (await c.req.json().catch(() => null)) as { importId?: unknown } | null;
      if (!UUID_TEXT.test(meetingId) || !body || typeof body.importId !== 'string' || !UUID_TEXT.test(body.importId)) {
        throw new DomainError('BAD_REQUEST', 400, 'importId must be a uuid');
      }
      const importId = body.importId;
      const release = completes.tryAcquire(user.userId);
      if (!release) throw busy(c);
      let claimedImportId: string | null = null;
      let stagingKeyToDelete: string | null = null;
      try {
        const meeting = await meetingFacts(user, orgId, meetingId);
        if (!meeting.isRecorder) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder may import a transcript');
        await refuseWrongImportRoute(user, orgId, importId, 'transcript');
        // The claim names this route's meeting, so a recording begun for another meeting is refused before the row moves.
        const imported = await runtime.execute<{ stagingKey: string; meetingId: string }>(
          'kernel.meeting_platform.import.claim',
          { recordingId: importId, meetingId },
          { actor: actorOf(user), orgId },
        );
        claimedImportId = importId;
        stagingKeyToDelete = imported.stagingKey;
        if (imported.meetingId !== meetingId) throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy bản ghi này');
        const missing = (error: unknown): never => {
          if (error instanceof BlobNotFoundError) throw new DomainError('UPLOAD_MISSING', 409, 'Chưa nhận được tệp cho lượt tải lên này');
          throw error;
        };
        const bytes = direct
          ? (await direct.readStaged(imported.stagingKey, MEETING_PLATFORM_TRANSCRIPT_MAX_BYTES).catch(missing)).bytes
          : await store.get(imported.stagingKey, null, MEETING_PLATFORM_TRANSCRIPT_MAX_BYTES).catch(missing);
        let staged: unknown;
        try {
          staged = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new DomainError('BAD_REQUEST', 400, 'Bản chép lời đã lưu không đọc được');
        }
        const lines = typeof staged === 'object' && staged !== null ? (staged as { segments?: unknown }).segments : undefined;
        // The worker's job marks a transcript it had to cut (#3922); only a literal true counts, anything else is a whole transcript.
        const cut = typeof staged === 'object' && staged !== null && (staged as { truncated?: unknown }).truncated === true;
        const input = zMeetingTranscriptImport.safeParse({ meetingId, segments: lines, platformCut: cut });
        if (!input.success) throw new DomainError('BAD_REQUEST', 400, 'Bản chép lời đã lưu không hợp lệ');
        const result = await runtime.execute('meetings.import.take_transcript', input.data, { actor: actorOf(user), orgId });
        return c.json(result);
      } catch (error) {
        // A claimed recording whose transcript was not taken fails with a short code the member can read (never the error's own text), best effort.
        if (claimedImportId) {
          await runtime
            .execute('kernel.meeting_platform.import.claim_failed', { recordingId: claimedImportId, code: 'claim_failed' }, { actor: actorOf(user), orgId })
            .catch((err) => console.error('[http] meeting import failure not recorded', err));
        }
        throw error;
      } finally {
        if (stagingKeyToDelete) await store.delete(stagingKeyToDelete).catch((err) => console.error('[http] meeting staging deletion failed', err));
        release();
      }
    } catch (error) {
      return problem(c, error);
    }
  });

  // A piece of about 15 seconds of the recording, sent while a live-notes meeting runs (ADR-0052 L4a, #3109). The route does what meetings.media.record's upload
  // does for a whole file: it seals the bytes under a data key of their own (bound to the meeting and to the piece's place, live:<seq>) and stores the ciphertext;
  // meetings.live.chunk then records it, as the recorder and only for a meeting that opted in. Nothing of the audio is kept in clear, and the final upload of the
  // recording is the authoritative audio: a piece that fails (here or in the command) is dropped and never touches it. The whole body (at most one MiB) is read
  // after the gate has said the meeting takes live pieces, so a meeting that did not opt in costs no bytes.
  const liveChunks = new ConcurrencyLimiter({ total: 8, perKey: 2 });
  app.post('/api/meetings/:id/live-chunk', async (c) => {
    let release: (() => void) | null = null;
    try {
      if (!runtime.installed('meetings')) throw new DomainError('NOT_FOUND', 404, 'Mô-đun Cuộc họp chưa được bật');
      const user = c.get('user');
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      const meetingId = c.req.param('id') ?? '';
      const meeting = await meetingFacts(user, orgId, meetingId);
      if (!meeting.isRecorder) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder may send live notes audio');
      if (!meeting.liveNotes) throw new DomainError('LIVE_NOTES_NOT_ENABLED', 409, 'Live notes were not turned on for this meeting');
      const seqText = c.req.query('seq') ?? '';
      const lengthText = c.req.query('lengthSeconds') ?? '';
      if (!/^\d{1,3}$/.test(seqText) || !/^\d{1,3}$/.test(lengthText)) throw new DomainError('BAD_REQUEST', 400, 'seq and lengthSeconds must be whole numbers');
      const seq = Number(seqText);
      const lengthSeconds = Number(lengthText);
      if (seq >= LIVE_CHUNK_MAX_COUNT || lengthSeconds < 1 || lengthSeconds > LIVE_CHUNK_MAX_SECONDS) throw new DomainError('BAD_REQUEST', 400, 'seq or lengthSeconds is out of range');
      if (!/^(?:audio\/|application\/octet-stream)/i.test(c.req.header('content-type') ?? '')) {
        throw new DomainError('BAD_REQUEST', 400, 'Content-Type must be audio/* or application/octet-stream');
      }
      // The declared size is checked before one byte is read, and the body limit stops a body that lies about it.
      const declared = c.req.header('content-length') ?? '';
      if (c.req.header('transfer-encoding') !== undefined || !/^\d+$/.test(declared)) throw new DomainError('BAD_REQUEST', 400, 'Tệp phải được gửi kèm Content-Length hợp lệ');
      if (Number(declared) < 1) throw new DomainError('NO_FILE', 400, 'Tệp rỗng');
      if (Number(declared) > LIVE_CHUNK_MAX_BYTES) throw new DomainError('FILE_TOO_LARGE', 413, 'Tệp vượt quá giới hạn tối đa');
      release = liveChunks.tryAcquire(user.userId);
      if (!release) throw busy(c);
      // Read with a count and a stall timeout, so a body that is longer than it said, or stops arriving, is refused and never held.
      const rawBody = c.req.raw.body;
      if (!rawBody) throw new DomainError('NO_FILE', 400, 'Tệp rỗng');
      const pieces: Uint8Array[] = [];
      let received = 0;
      for await (const piece of streamPieces(rawBody as ReadableStream<Uint8Array>, mediaStallMs)) {
        received += piece.byteLength;
        if (received > LIVE_CHUNK_MAX_BYTES) throw new DomainError('FILE_TOO_LARGE', 413, 'Tệp vượt quá giới hạn tối đa');
        pieces.push(piece);
      }
      if (received !== Number(declared)) throw new DomainError('BAD_REQUEST', 400, 'Tệp có kích thước không khớp với Content-Length');
      const bytes = Buffer.concat(pieces);

      const broker = deps.broker ?? createCredentialBroker(config);
      const keyId = broker.keyId;
      if (!keyId || (!broker.derive && !broker.deriveKey)) throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media encryption key unavailable');
      const wrapSubkey = broker.deriveKey
        ? broker.deriveKey(keyId, 'crove.meetings.v1|wrap')
        : broker.derive && broker.keyId === keyId
          ? broker.derive('crove.meetings.v1|wrap')
          : null;
      if (!wrapSubkey) throw new DomainError('MEDIA_KEY_UNAVAILABLE', 503, 'Media encryption key derivation failed');
      const dataKey = generateMediaDataKey();
      try {
        const binding: BlobMediaBinding = { orgId, meetingId, kind: `live:${seq}` };
        const wrappedKey = wrapMediaKeyWithSubkey(dataKey, { ...binding, keyId }, wrapSubkey);
        const sealed = await sealMedia({ source: onepiece(bytes), expectedLength: bytes.byteLength, kind: 'audio', dataKey, binding, maxBytes: LIVE_CHUNK_MAX_BYTES, store, orgId, opaque: seq > 0 });
        let recorded: { duplicate: boolean };
        try {
          recorded = await runtime.execute<{ duplicate: boolean }>(
            'meetings.live.chunk',
            {
              meetingId,
              seq,
              keyId,
              wrappedKeyHex: wrappedKey.toString('hex'),
              storageKey: sealed.key,
              generation: sealed.generation,
              sizeBytes: sealed.size,
              sha256: sealed.sha256,
              contentType: sealed.contentType,
              lengthSeconds,
            },
            { actor: actorOf(user), orgId },
          );
        } catch (error) {
          // Refused (a closed recording, no opt-in, a limit): the sealed bytes have no row, so drop them.
          if (sealed.created) await store.delete(sealed.key).catch((err) => console.error('[http] live chunk cleanup failed', err));
          throw error;
        }
        // A retry of a piece already kept: the first one stands, and the object this retry just stored has no row.
        if (recorded.duplicate && sealed.created) await store.delete(sealed.key).catch((err) => console.error('[http] live chunk cleanup failed', err));
        return c.json({ meetingId, seq, duplicate: recorded.duplicate });
      } finally {
        dataKey.fill(0);
        wrapSubkey.fill(0);
      }
    } catch (error) {
      return problem(c, error);
    } finally {
      release?.();
    }
  });

  // Join the live pieces of a recording that never finished into its audio (ADR-0052 L4a, #3126): the recorder's own click, after the window of the pieces has passed with no
  // final upload. The pieces are the recorder's own and are read in their own session (the plan is a query as the recorder; the route decrypts one piece at a time, seals the
  // join under a fresh audio key, has crove-media measure it, and meetings.live.assemble_record records it and discards the pieces). Not in the extension's routes: the click is the app's.
  const liveAssembles = new ConcurrencyLimiter({ total: 2, perKey: 1 });
  app.post('/api/meetings/:id/live-assemble', async (c) => {
    let release: (() => void) | null = null;
    try {
      if (!runtime.installed('meetings')) throw new DomainError('NOT_FOUND', 404, 'Mô-đun Cuộc họp chưa được bật');
      const user = c.get('user');
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      const meetingId = c.req.param('id') ?? '';
      const meeting = await meetingFacts(user, orgId, meetingId);
      if (!meeting.isRecorder) throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can join its live pieces');
      release = liveAssembles.tryAcquire(user.userId);
      if (!release) throw busy(c);
      const result = await assembleLivePieces(
        { runtime, store, broker: deps.broker ?? createCredentialBroker(config), measurer: mediaMeasurer, maxBytes: meetingMediaCap('audio') },
        { actor: actorOf(user), orgId, meetingId },
      );
      return c.json(result);
    } catch (error) {
      return problem(c, error);
    } finally {
      release?.();
    }
  });

  // A customer's image of a conversation message (CV5c, #2357): the bytes of one stored image, to the member who may read its message. The
  // authorization is the database's (kernel.conversation.attachment_get reads under the row policy of the thread, so a member limited to
  // other channels, one without the direct-message permission, and an agent get the same 404 as an id that does not exist). Only an image is
  // ever served: the type is read from the bytes again here (never the stored label alone), anything else is 404, and the answer can neither
  // be rendered as a page nor run a script (nosniff, a CSP that allows nothing, sandbox, no store in any cache).
  app.get('/api/conversations/attachments/:id', async (c) => {
    try {
      const user = c.get('user');
      const orgId = await resolveOrg(runtime, user, readOrgHeader(c));
      const file = await runtime.query<{ contentType: string; sizeBytes: number; sha256: string; generation: string; storageKey: string }>(
        'kernel.conversation.attachment_get',
        { attachmentId: c.req.param('id') },
        { actor: actorOf(user), orgId },
      );
      const bytes = await readVerified(store, { key: file.storageKey, generation: file.generation, sha256: file.sha256 }, file.sizeBytes);
      const type = sniffConversationImage(bytes);
      if (!type) throw new DomainError('ATTACHMENT_NOT_FOUND', 404, 'Không tìm thấy ảnh này');
      return new Response(body(bytes), {
        headers: {
          'content-type': type,
          'content-disposition': `inline; filename="image.${type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length)}"`,
          'content-security-policy': "default-src 'none'; sandbox",
          'x-content-type-options': 'nosniff',
          'cross-origin-resource-policy': 'same-site',
          'cache-control': 'private, no-store',
        },
      });
    } catch (error) {
      return problem(c, error);
    }
  });

  // A bounded number of exports at once in this process (#2121): each holds up to 50,000 rows and its finished file. A
  // full limiter refuses at once (nothing queues up in memory) with 503 and Retry-After, and the person clicks again.
  // One user may hold two slots, so the buttons of one page (the journal has four) do not refuse each other. The slot
  // is held until the handler is done, the audit row included.
  const exportSlots = deps.exports ?? new ConcurrencyLimiter({ total: config.EXPORT_CONCURRENCY, perKey: Math.min(2, config.EXPORT_CONCURRENCY) });
  // The org export's owner-run tables (#2676) take a slot too, held until their response has ended.

  // A quote as a PDF (issue #2695, plan docs/plan/crm-quotes.md step Q3): the same quote a member reads on screen, in the org's own words and the
  // seller's and buyer's own records, for anyone who may read quotes. It is read only (no row is audited, as for `crm.quote.get`), and the bytes are the
  // same every time for the same quote on the same day (an expired quote says so). A bad or another org's id answers as a missing quote. Each member may take 30 a minute: the writer is
  // quick, but it runs on the API's own thread.
  if (runtime.installed('crm')) {
    const quotePdfLimit = new RateLimiter({ perMinute: QUOTE_PDFS_PER_MINUTE });
    app.get('/api/crm/quotes/:id/pdf', async (c) => {
      try {
        const user = c.get('user');
        const decision = quotePdfLimit.take(user.userId);
        if (!decision.allowed) {
          c.header('retry-after', String(decision.retryAfterSeconds));
          throw new DomainError('RATE_LIMITED', 429, 'Bạn tải quá nhiều bản PDF; hãy thử lại sau ít phút');
        }
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const { logoFile, ...document } = await runtime.query<QuoteDocumentData>('crm.quote.document', { quoteId: c.req.param('id') }, { actor: actorOf(user), orgId });
        // The letterhead's logo (#2814): read from the store and checked, then by the writer's own reader; a logo that cannot be read leaves it out and never fails the document.
        let logo = null;
        if (logoFile) {
          try {
            const file = await readLogoFile(store, logoFile);
            logo = file ? readLogoImage(file.bytes, file.contentType) : null;
          } catch (error) {
            if (error instanceof BlobIntegrityError) opsAlert('[http] ALERT evidence integrity: a stored file does not match its recorded sha256', error);
            else console.warn('[quote-pdf] logo left out:', error instanceof Error ? error.message : error);
          }
        }
        const bytes = renderQuotePdf({ ...document, logo });
        // The number is the org's own text: only what a filename can safely hold goes into it.
        const named = (document.quote.number ?? '').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'bao-gia', named || 'nhap', ORG_SLUG], 'pdf'),
            'cache-control': 'private, no-store',
            'x-content-type-options': 'nosniff',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // Finance routes exist only when the finance module is installed (CROVE_MODULES); otherwise they are 404 below.
  if (runtime.installed('finance')) {
    // The legal entity whose books an export is of (#1280): ?legalEntityId=<uuid>, as in zLegalEntityChoice; omitted,
    // the entity resolved for the caller. The queries check it (a malformed id is refused by their input schema, an
    // entity the caller may not see answers LEGAL_ENTITY_NOT_ALLOWED), and the export's audit row records it.
    const entityQuery = (c: { req: { query: (name: string) => string | undefined } }): { legalEntityId?: string } => {
      const id = c.req.query('legalEntityId');
      return id ? { legalEntityId: id } : {};
    };
    app.use('/api/export/*', async (c, next) => {
      const release = exportSlots.tryAcquire(c.get('user').userId);
      if (!release) {
        c.header('retry-after', String(EXPORT_BUSY_RETRY_SECONDS));
        return problem(c, new DomainError('EXPORT_BUSY', 503, 'Đang có nhiều lượt xuất sổ sách; hãy thử lại sau vài giây'));
      }
      try {
        await next();
      } finally {
        release();
      }
    });
    app.get('/api/export/journal.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const range = { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined, limit: JOURNAL_EXPORT_LIMIT, ...entityQuery(c) };
        const entries = await runtime.query<JournalEntryView[]>('finance.journal.list', range, {
          actor: actorOf(user),
          orgId,
        });
        if (entries.length >= JOURNAL_EXPORT_LIMIT) {
          throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều bút toán để xuất một lần; hãy chọn khoảng ngày ngắn hơn');
        }
        const bytes = await buildJournalWorkbook([...entries].reverse(), orgSlug ?? '', config.BRAND_NAME);
        // The export's audit row (counts only), for the weekly usage report (issue #311). No row, no download.
        await runtime.execute('finance.journal.export', { from: range.from, to: range.to, entries: entries.length, ...entityQuery(c) }, { actor: actorOf(user), orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'but-toan', ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // Purchase vouchers in the MISA SME import template (issue #317), same roles, range and audit as the journal
    // export above. Lines on a stock account (152, 153, 156) are left out: they go to the goods purchase file below
    // (#1398), and the audit row says so. `entries` counts the vouchers with a line in the file.
    app.get('/api/export/misa/purchases.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const range = { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined, limit: JOURNAL_EXPORT_LIMIT, ...entityQuery(c) };
        const vouchers = await runtime.query<PurchaseVoucher[]>('finance.vouchers.purchases', range, { actor: actorOf(user), orgId });
        if (vouchers.length >= JOURNAL_EXPORT_LIMIT) {
          throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều chứng từ để xuất một lần; hãy chọn khoảng ngày ngắn hơn');
        }
        const perVoucher = vouchers.map(servicePurchaseRows).filter((rows) => rows.length > 0);
        const bytes = await buildMisaWorkbook(MISA_SME_PURCHASE_SERVICE, perVoucher.flat(), config.BRAND_NAME);
        await runtime.execute(
          'finance.journal.export',
          { from: range.from, to: range.to, ...entityQuery(c), entries: perVoucher.length, format: 'misa_sme_purchases', stockLines: 'excluded' },
          { actor: actorOf(user), orgId },
        );
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'misa-mua-dich-vu', ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // Purchase lines on a stock account (152, 153, 156) in MISA SME's goods purchase template (#1398), with the org's
    // MISA item and warehouse codes (Settings), same roles, range and audit as the purchase export. An invoice that
    // also has other lines has those in the services file above, under another voucher number.
    app.get('/api/export/misa/goods-purchases.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const range = { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined, limit: JOURNAL_EXPORT_LIMIT, ...entityQuery(c) };
        const vouchers = await runtime.query<PurchaseVoucher[]>('finance.vouchers.purchases', range, { actor: actorOf(user), orgId });
        if (vouchers.length >= JOURNAL_EXPORT_LIMIT) {
          throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều chứng từ để xuất một lần; hãy chọn khoảng ngày ngắn hơn');
        }
        const codes = await runtime.query<MisaGoodsCode[]>('finance.misa_goods_codes.list', {}, { actor: actorOf(user), orgId });
        // The chart's parent chain, along which a sub-account without codes takes its parent's.
        const chart = await runtime.query<Array<{ code: string; parentCode: string | null }>>('finance.accounts.list', {}, { actor: actorOf(user), orgId });
        const parents = accountParents(chart);
        const perVoucher = vouchers.map((v) => goodsPurchaseRows(v, codes, parents)).filter((rows) => rows.length > 0);
        const bytes = await buildMisaWorkbook(MISA_SME_PURCHASE_GOODS, perVoucher.flat(), config.BRAND_NAME);
        await runtime.execute(
          'finance.journal.export',
          { from: range.from, to: range.to, ...entityQuery(c), entries: perVoucher.length, format: 'misa_sme_goods_purchases' },
          { actor: actorOf(user), orgId },
        );
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'misa-mua-hang-nhap-kho', ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // Sales vouchers in the MISA SME import template (issue #313), same roles, range and audit as the purchase export.
    app.get('/api/export/misa/sales.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const range = { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined, limit: JOURNAL_EXPORT_LIMIT, ...entityQuery(c) };
        const vouchers = await runtime.query<SalesVoucher[]>('finance.vouchers.sales', range, { actor: actorOf(user), orgId });
        if (vouchers.length >= JOURNAL_EXPORT_LIMIT) {
          throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều chứng từ để xuất một lần; hãy chọn khoảng ngày ngắn hơn');
        }
        const bytes = await buildMisaWorkbook(MISA_SME_SALES, vouchers.flatMap(salesRows), config.BRAND_NAME);
        await runtime.execute(
          'finance.journal.export',
          { from: range.from, to: range.to, ...entityQuery(c), entries: vouchers.length, format: 'misa_sme_sales' },
          { actor: actorOf(user), orgId },
        );
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'misa-ban-hang', ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // Cash and bank receipts and payments in MISA SME's "Phiếu thu", "Phiếu chi", "Chứng từ thu tiền" (giấy báo Có) and
    // "Chứng từ Chi tiền gửi" (giấy báo Nợ) templates (#657), one file per voucher type (MISA imports one type per file),
    // same roles, range and audit as the purchase export.
    const cashExports = [
      { path: '/api/export/misa/receipts.xlsx', type: 'cash_receipt', template: MISA_SME_CASH_RECEIPT, format: 'misa_sme_cash_receipts', name: 'misa-phieu-thu' },
      { path: '/api/export/misa/payments.xlsx', type: 'cash_payment', template: MISA_SME_CASH_PAYMENT, format: 'misa_sme_cash_payments', name: 'misa-phieu-chi' },
      { path: '/api/export/misa/bank-receipts.xlsx', type: 'bank_credit', template: MISA_SME_BANK_CREDIT, format: 'misa_sme_bank_credits', name: 'misa-bao-co' },
      { path: '/api/export/misa/bank-payments.xlsx', type: 'bank_debit', template: MISA_SME_BANK_DEBIT, format: 'misa_sme_bank_debits', name: 'misa-bao-no' },
    ] as const;
    for (const cash of cashExports) {
      app.get(cash.path, async (c) => {
        try {
          const user = c.get('user');
          const orgSlug = readOrgHeader(c);
          const orgId = await resolveOrg(runtime, user, orgSlug);
          const range = { from: c.req.query('from') || undefined, to: c.req.query('to') || undefined, limit: JOURNAL_EXPORT_LIMIT, ...entityQuery(c) };
          const vouchers = await runtime.query<CashVoucher[]>('finance.vouchers.cash', { ...range, type: cash.type }, { actor: actorOf(user), orgId });
          if (vouchers.length >= JOURNAL_EXPORT_LIMIT) {
            throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều chứng từ để xuất một lần; hãy chọn khoảng ngày ngắn hơn');
          }
          const bytes = await buildMisaWorkbook(cash.template, vouchers.flatMap(cashRows), config.BRAND_NAME);
          await runtime.execute(
            'finance.journal.export',
            { from: range.from, to: range.to, ...entityQuery(c), entries: vouchers.length, format: cash.format },
            { actor: actorOf(user), orgId },
          );
          return new Response(body(bytes), {
            headers: {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), cash.name, ORG_SLUG], 'xlsx'),
              'cache-control': 'private, no-store',
            },
          });
        } catch (error) {
          return problem(c, error);
        }
      });
    }

    // VAT working of one month or quarter (issue #316), ?period=2026-09 or ?period=2026-Q3. The query checks the
    // period (422 otherwise) and the roles, so the file name below only ever holds a valid period.
    app.get('/api/export/vat.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const period = c.req.query('period') ?? '';
        const report = await runtime.query<VatReport>('finance.vat.period', { period, ...entityQuery(c) }, { actor: actorOf(user), orgId });
        const bytes = await buildVatWorkbook(report, orgSlug ?? '', config.BRAND_NAME);
        // The export's audit row (period and invoice count only). No row, no download.
        const documents = report.input.documents.length + report.output.documents.length;
        await runtime.execute('finance.vat.export', { period: report.period.period, documents, ...entityQuery(c) }, { actor: actorOf(user), orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'gtgt', report.period.period, ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // The VAT return of one month or quarter as the XML of form 01/GTGT that HTKK imports (issue #332), same period,
    // roles and audit as the Excel working above. The declaration query refuses an org without a tax code (422
    // TAX_CODE_REQUIRED) and checks the period, so the file name below only ever holds a valid period.
    app.get('/api/export/vat-01gtgt.xml', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const period = c.req.query('period') ?? '';
        // ?deductInput=1 puts [24] in [25] (#692); ?deduct=suggested puts the working's suggestion, [24] minus the VAT
        // marked not deductible for want of a non-cash payment (#917); anything else keeps [25] at 0, the default.
        const deductSuggested = c.req.query('deduct') === 'suggested';
        const deductInput = !deductSuggested && c.req.query('deductInput') === '1';
        const declaration = await runtime.query<VatDeclaration>('finance.vat.declaration', { period, ...entityQuery(c) }, { actor: actorOf(user), orgId });
        // [22] (#1400): the [43] of the return filed for the period before, or ?carried=<whole dong> as the accountant
        // edited it on the VAT screen (422 unless a whole number of at most 14 digits).
        const carried = xmlCarryForward(declaration.report, c.req.query('carried'));
        const xml = buildVat01Xml(declaration, undefined, {
          carriedForward: carried.amount,
          ...(deductSuggested ? { deductible: declaration.report.paymentChecks.suggested25 } : { deductInput }),
        });
        // The export's audit row (period, invoice count, format, the [25] choice and where [22] came from; no amount).
        // No row, no download.
        const documents = declaration.report.input.documents.length + declaration.report.output.documents.length;
        await runtime.execute(
          'finance.vat.export',
          {
            period: declaration.report.period.period,
            ...entityQuery(c),
            documents,
            format: 'htkk_01gtgt_xml',
            ...(deductInput ? { deductInput } : {}),
            ...(deductSuggested ? { deductSuggested } : {}),
            carryForward: carried.source,
          },
          { actor: actorOf(user), orgId },
        );
        return new Response(body(new TextEncoder().encode(xml)), {
          headers: {
            'content-type': 'application/xml; charset=utf-8',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), '01gtgt', declaration.report.period.period, ORG_SLUG], 'xml'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // Ledger reports of one month, quarter or year (issue #321), ?period=2026-09, 2026-Q3 or 2026. The query checks
    // the period (422 otherwise) and the roles, so the file name below only ever holds a valid period.
    app.get('/api/export/ledger.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const period = c.req.query('period') ?? '';
        const book = await runtime.query<LedgerBook>('finance.ledger.book', { period, ...entityQuery(c) }, { actor: actorOf(user), orgId });
        const bytes = await buildLedgerWorkbook(book, orgSlug ?? '', config.BRAND_NAME);
        // The export's audit row (period and journal line count only). No row, no download.
        await runtime.execute('finance.ledger.export', { period: book.period.period, lines: book.lines, ...entityQuery(c) }, { actor: actorOf(user), orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'so-sach', book.period.period, ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // The DRAFT financial statements of one month, quarter or year (issue #154), ?period= as for the ledger reports.
    // The query checks the period (422 otherwise) and the roles, so the file name below only ever holds a valid period.
    app.get('/api/export/statements.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const period = c.req.query('period') ?? '';
        const statements = await runtime.query<FinancialStatements>('finance.statements.period', { period, ...entityQuery(c) }, { actor: actorOf(user), orgId });
        const bytes = await buildStatementsWorkbook(statements, orgSlug ?? '', config.BRAND_NAME);
        // The export's audit row (the period). No row, no download.
        await runtime.execute('finance.statements.export', { period: statements.period.period, ...entityQuery(c) }, { actor: actorOf(user), orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="${brandSlug(config.BRAND_NAME)}-bao-cao-tai-chinh-${statements.period.period}-${orgSlug}.xlsx"`,
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // The register of fixed assets and prepaid costs (#919), every entry with what it posted and what is left.
    app.get('/api/export/fixed-assets.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const assets = await runtime.query<FixedAsset[]>('finance.fixed_assets.list', entityQuery(c), { actor: actorOf(user), orgId });
        const bytes = await buildFixedAssetsWorkbook(assets, orgSlug ?? '', config.BRAND_NAME);
        // The export's audit row (the number of entries). No row, no download.
        await runtime.execute('finance.fixed_asset.export', { assets: assets.length, ...entityQuery(c) }, { actor: actorOf(user), orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'so-tai-san', ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // The most rows one stock workbook holds (items in the report, moves in a card): the file is built in memory.
    const STOCK_EXPORT_LIMIT = 20_000;
    // The stock reports of one month (#2513), ?month=2026-09: Nhập xuất tồn and, with &itemId=<id>, the stock card of that item. The queries check the month and the roles (422 and 403
    // otherwise), so the file name only holds a valid month.
    app.get('/api/export/stock.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const actor = actorOf(user);
        const month = c.req.query('month') ?? '';
        const itemId = c.req.query('itemId') || undefined;
        const report = await runtime.query<StockReportRow[]>('finance.stock.report', { month, ...entityQuery(c) }, { actor, orgId });
        const card = itemId ? await runtime.query<StockCard>('finance.stock.card', { itemId, month }, { actor, orgId }) : null;
        // The card is of an item of the entity asked for (the audit row names that entity), and the workbook is built in memory, so a catalog or a card too large for one file is refused.
        const entity = entityQuery(c).legalEntityId;
        if (card && entity && card.item.legalEntityId !== entity) throw new DomainError('STOCK_ITEM_ENTITY_MISMATCH', 422, 'Mặt hàng và pháp nhân đã chọn không khớp nhau');
        if (report.length > STOCK_EXPORT_LIMIT || (card?.moves.length ?? 0) > STOCK_EXPORT_LIMIT) {
          throw new DomainError('EXPORT_TOO_LARGE', 422, 'Quá nhiều dòng để xuất một lần; hãy chọn một pháp nhân hoặc một mặt hàng');
        }
        const bytes = await buildStockWorkbook(month, report, card, orgSlug ?? '', config.BRAND_NAME);
        // The export's audit row (the month, the number of items, whether a card is in it). No row, no download.
        await runtime.execute('finance.stock.export', { month, items: report.length, card: card !== null, ...(entity ? { legalEntityId: entity } : card ? { legalEntityId: card.item.legalEntityId } : {}) }, { actor, orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'nhap-xuat-ton', month, ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // S1a-HKD, the sales listing of a household business (#2517), ?legalEntityId=<household>&period=2026-09 (a month, a quarter 2026-Q3 or a year). The query checks the period, the roles and that the
    // entity's profile requires S1a (422 and 403 otherwise), so the file name only holds a valid period. The audit row is recorded before the file is sent.
    app.get('/api/export/household-s1a.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const actor = actorOf(user);
        const period = c.req.query('period') ?? '';
        const legalEntityId = c.req.query('legalEntityId') ?? '';
        const book = await runtime.query<HouseholdS1a>('finance.household.s1a', { legalEntityId, period }, { actor, orgId });
        const bytes = await buildS1aWorkbook(book, config.BRAND_NAME);
        // The export's audit row (the entity, the book, the period and the number of rows). No row, no download.
        await runtime.execute('finance.household.export', { legalEntityId, book: 'S1a', period, rows: book.rows.length }, { actor, orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'so-s1a-hkd', period, ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // S2a-HKD, the revenue book of a household business on the percentage method (#2517 slice 2a), ?legalEntityId=<household>&period=2026-09 (a month, a quarter 2026-Q3 or a year). The query checks the period,
    // the roles and that the entity's profile requires S2a (422 and 403 otherwise), so the file name only holds a valid period. The book is given while its rows are `commentary` (the file and the screen
    // say so, and label every figure that depends on them); part of the revenue with no business line yet shows in its own column and holds the tax total back. The audit row is recorded before the file is sent.
    app.get('/api/export/household-s2a.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const actor = actorOf(user);
        const period = c.req.query('period') ?? '';
        const legalEntityId = c.req.query('legalEntityId') ?? '';
        // A household with several trades picks the trade that takes the yearly threshold deduction (#3710 slice 3): &deductionTrade=services. The query checks the value.
        const deductionTrade = c.req.query('deductionTrade');
        const book = await runtime.query<HouseholdS2a>('finance.household.s2a', { legalEntityId, period, ...(deductionTrade ? { deductionTrade } : {}) }, { actor, orgId });
        const bytes = await buildS2aWorkbook(book, config.BRAND_NAME);
        await runtime.execute('finance.household.export', { legalEntityId, book: 'S2a', period, rows: book.rows.length }, { actor, orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'so-s2a-hkd', period, ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // S2b-HKD, the revenue book of a household business on the income method (#2517 slice 2c), ?legalEntityId=<household>&period=2026-09 (a month, a quarter 2026-Q3 or a year). The query checks the period, the
    // roles and that the entity's profile requires S2b (422 and 403 otherwise), so the file name only holds a valid period. The book is given while its rows are `commentary` (the file and the screen label
    // every figure that depends on them); part of the revenue with no business line yet shows in its own column and holds the VAT total back. The audit row is recorded before the file is sent.
    app.get('/api/export/household-s2b.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const actor = actorOf(user);
        const period = c.req.query('period') ?? '';
        const legalEntityId = c.req.query('legalEntityId') ?? '';
        const book = await runtime.query<HouseholdS2b>('finance.household.s2b', { legalEntityId, period }, { actor, orgId });
        const bytes = await buildS2bWorkbook(book, config.BRAND_NAME);
        // The file name is built before the audit row: a request that cannot be given a name (no organization slug) fails here, so no audit row is written for a file that is never sent.
        const disposition = attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'so-s2b-hkd', period, ORG_SLUG], 'xlsx');
        await runtime.execute('finance.household.export', { legalEntityId, book: 'S2b', period, rows: book.rows.length }, { actor, orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': disposition,
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // S2c-HKD, the revenue and expense detail of a household business on the income method (#2517 slice 2b), ?legalEntityId=<household>&period=2026-09 (a month, a quarter 2026-Q3 or a year). The query checks the
    // period, the roles and that the entity's profile requires S2c (422 and 403 otherwise), so the file name only holds a valid period. The book is given while its rows are `commentary` (the file and the screen
    // label the expense and income figures); an expense account with no group shows apart and leaves the income blank. The audit row is recorded before the file is sent.
    app.get('/api/export/household-s2c.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const actor = actorOf(user);
        const period = c.req.query('period') ?? '';
        const legalEntityId = c.req.query('legalEntityId') ?? '';
        const book = await runtime.query<HouseholdS2c>('finance.household.s2c', { legalEntityId, period }, { actor, orgId });
        const bytes = await buildS2cWorkbook(book, config.BRAND_NAME);
        await runtime.execute('finance.household.export', { legalEntityId, book: 'S2c', period, rows: book.revenueRows.length + book.expenseRows.length }, { actor, orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'so-s2c-hkd', period, ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // S2d-HKD, the goods book of a household business on the income method (#2517 slice 2d), ?legalEntityId=<household>&month=2026-09 (one month: the stock cost is a monthly average). The query checks the month, the roles
    // and that the entity's profile requires S2d (422 and 403 otherwise). The book is given while the month is open or the layout row is `commentary` (the file and the screen say so). The audit row is recorded before the file is sent.
    app.get('/api/export/household-s2d.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const actor = actorOf(user);
        const month = c.req.query('month') ?? '';
        const legalEntityId = c.req.query('legalEntityId') ?? '';
        const book = await runtime.query<HouseholdS2d>('finance.household.s2d', { legalEntityId, month }, { actor, orgId });
        const bytes = await buildS2dWorkbook(book, config.BRAND_NAME);
        await runtime.execute('finance.household.export', { legalEntityId, book: 'S2d', period: month, rows: book.items.reduce((n, i) => n + i.rows.length, 0) }, { actor, orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'so-s2d-hkd', month, ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // S2e-HKD, the cash and bank book of a household business on the income method (#2517 slice 2e), ?legalEntityId=<household>&period=2026-09 (a month, a quarter 2026-Q3 or a year). The query checks the period, the
    // roles and that the entity's profile requires S2e (422 and 403 otherwise). The book is given while its layout row is `commentary` (the file and the screen carry the provisional label). The audit row is recorded before the file is sent.
    app.get('/api/export/household-s2e.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const actor = actorOf(user);
        const period = c.req.query('period') ?? '';
        const legalEntityId = c.req.query('legalEntityId') ?? '';
        const book = await runtime.query<HouseholdS2e>('finance.household.s2e', { legalEntityId, period }, { actor, orgId });
        const bytes = await buildS2eWorkbook(book, config.BRAND_NAME);
        await runtime.execute('finance.household.export', { legalEntityId, book: 'S2e', period, rows: book.accounts.reduce((n, a) => n + a.rows.length, 0) }, { actor, orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'so-s2e-hkd', period, ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // The 01/CNKD quarterly return worksheet of a household business (#2518), ?legalEntityId=<household>&year=2026&quarter=3 and, for a household with several trades, &split=goods:1000000,services:600000 (and, from the yearly rule, &splitBefore=... and &deductionTrade=...).
    // The query checks the year and quarter, the roles, the profile and the split, and refuses (422) while revenue is unassigned (forExport), so the file only ever holds whole figures. While a row
    // behind the figures is still unconfirmed the file is given and every figure in it carries the provisional label (#2518). The audit row is recorded before the file is sent. A worksheet: Ludy files nothing.
    app.get('/api/export/household-cnkd.xlsx', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const actor = actorOf(user);
        const legalEntityId = c.req.query('legalEntityId') ?? '';
        const year = Number(c.req.query('year') ?? '');
        const quarter = Number(c.req.query('quarter') ?? '');
        const tradeSplit = (text: string) =>
          text
            .split(',')
            .filter((part) => part !== '')
            .map((part) => {
              // Everything after the first colon is the amount, so "goods:1:2" fails the amount check instead of being read as 1.
              const at = part.indexOf(':');
              return { trade: at < 0 ? part : part.slice(0, at), revenue: at < 0 ? '' : part.slice(at + 1) };
            });
        const split = tradeSplit(c.req.query('split') ?? '');
        // The yearly rule (#3710 slice 3): &splitBefore=goods:600000 is the split of the year's revenue before the quarter, &deductionTrade=services the trade that takes the threshold deduction.
        const splitBefore = tradeSplit(c.req.query('splitBefore') ?? '');
        const deductionTrade = c.req.query('deductionTrade');
        const sheetData = await runtime.query<HouseholdCnkd>(
          'finance.household.cnkd',
          { legalEntityId, year, quarter, ...(split.length > 0 ? { split } : {}), ...(splitBefore.length > 0 ? { splitBefore } : {}), ...(deductionTrade ? { deductionTrade } : {}), forExport: true },
          { actor, orgId },
        );
        const bytes = await buildCnkdWorkbook(sheetData, config.BRAND_NAME);
        await runtime.execute('finance.household.export', { legalEntityId, book: '01/CNKD', period: `${year}-Q${quarter}`, rows: sheetData.lines.length }, { actor, orgId });
        return new Response(body(bytes), {
          headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'to-khai-01-cnkd', `${year}-Q${quarter}`, ORG_SLUG], 'xlsx'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // The year-end financial statements as HTKK XML (issue #920), ?year=2026: B01a-DNN, B02-DNN and F01-DNN, form 683.
    // The query checks the year (422 otherwise), the roles and the tax code, so the file name only holds a valid year.
    app.get('/api/export/statements-htkk.xml', async (c) => {
      try {
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        const yearText = c.req.query('year') ?? '';
        const year = /^\d{4}$/.test(yearText) ? Number(yearText) : Number.NaN;
        const filing = await runtime.query<StatementsFiling>('finance.statements.htkk', { year, ...entityQuery(c) }, { actor: actorOf(user), orgId });
        const xml = buildStatementsHtkkXml(filing);
        // The export's audit row (the year, the format and the warnings only). No row, no download.
        await runtime.execute(
          'finance.statements.export',
          { period: String(filing.input.year), ...entityQuery(c), format: 'htkk_bctc_xml', ...(filing.warnings.length > 0 ? { warnings: filing.warnings } : {}) },
          { actor: actorOf(user), orgId },
        );
        return new Response(body(new TextEncoder().encode(xml)), {
          headers: {
            'content-type': 'application/xml; charset=utf-8',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'bctc', String(filing.input.year), ORG_SLUG], 'xml'),
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });

    // A fiscal year's archive package (issue #922), owners only (finance.archive.get): /verify reads every part and
    // original at its recorded version and reports what is missing or changed; /manifest is the manifest (JSON), and
    // /<sha256> one part of it. The manifest's key, version and sha256 come from the build's audit row, and a part is
    // served only when the manifest lists it under the package's own prefix, so the request names nothing but a year.
    const recordedArchive = async (c: Context<{ Variables: { user: AuthUser } }>) => {
      const user = c.get('user');
      const orgSlug = readOrgHeader(c);
      const orgId = await resolveOrg(runtime, user, orgSlug);
      const year = Number(c.req.param('year'));
      if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new DomainError('NOT_FOUND', 404, 'Không có gói lưu trữ của năm này');
      const archive = await runtime.query<RecordedArchive | null>('finance.archive.get', { year }, { actor: actorOf(user), orgId });
      if (!archive) throw new DomainError('NOT_FOUND', 404, 'Năm này chưa được đóng gói lưu trữ');
      return { orgId, orgSlug, archive };
    };
    app.get('/api/finance-archive/:year/verify', async (c) => {
      try {
        const { orgId, archive } = await recordedArchive(c);
        return c.json(await verifyYearArchive(store, orgId, archive), 200, { 'cache-control': 'private, no-store' });
      } catch (error) {
        return problem(c, error);
      }
    });
    app.get('/api/finance-archive/:year/:part', async (c) => {
      try {
        const { orgId, orgSlug, archive } = await recordedArchive(c);
        const manifest = await readYearArchiveManifest(store, archive);
        const part = c.req.param('part');
        if (part === 'manifest') {
          return c.json(manifest, 200, {
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'luu-tru', String(archive.year), ORG_SLUG, 'manifest'], 'json'),
            'cache-control': 'private, no-store',
          });
        }
        const ref = manifest.parts.find((p) => p.sha256 === part && p.key === archiveKey(orgId, archive.year, p.sha256));
        if (!ref) throw new DomainError('NOT_FOUND', 404, 'Gói lưu trữ không có phần này');
        const bytes = await readVerified(store, { key: ref.key, generation: ref.generation, sha256: ref.sha256 });
        const xml = ref.kind === 'vat_xml';
        return new Response(body(bytes), {
          headers: {
            'content-type': xml ? 'application/xml; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'content-disposition': `attachment; filename="${ref.name.replace(/[^A-Za-z0-9._-]/g, '-')}"`,
            'cache-control': 'private, no-store',
          },
        });
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // The payroll declaration exports (#2533, payroll plan 6.5): GET /api/payroll-export/<kind>.xlsx (or .json for the screen's view and print)?period=...&legalEntityId=..., kind d02lt (period 2026-09), kk (2026-Q3), qtt or certificate (2026).
  // Built only in the requesting owner's or admin's own context: the sensitive query hr.payroll.declaration.get (its audit row is committed before the sealed identity numbers, tax codes and
  // insurance numbers are opened; nothing decrypted reaches an audit fact or a log), never a worker, a stored job or a stored blob, and no email. Figures come only from approved runs. It takes a
  // slot of the export limiter, like the books' exports; a document is bounded (more people than the cap is refused, never cut short) and is built whole, then the audit row of the download is
  // written before the bytes are sent: no row, no download. The slot is held until the bytes are taken. Opening the sealed numbers needs a second factor used in the last 5 minutes (STEP_UP_REQUIRED). `private, no-store`: the file holds identity numbers and tax codes. Nothing is sent to any agency.
  if (runtime.installed('hr')) {
    app.get('/api/payroll-export/:file', async (c) => {
      // A HEAD request would run the whole audited read and build the file only to throw the body away, leaving a download row for bytes nobody got.
      if (c.req.method === 'HEAD') return c.body(null, 405, { allow: 'GET' });
      try {
        const file = c.req.param('file');
        // .xlsx is the file; .json is the same document for the screen's view and print, recorded by the same audit row (so no print leaves the server unrecorded).
        const asView = file.endsWith('.json');
        const kind = file.endsWith('.xlsx') ? file.slice(0, -'.xlsx'.length) : asView ? file.slice(0, -'.json'.length) : '';
        if (!(HR_DECLARATION_KINDS as readonly string[]).includes(kind)) throw new DomainError('NOT_FOUND', 404, 'Không có bảng kê này');
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        // Refused before a slot or an audit row: the query checks it again for every caller.
        if (!hasFreshMfa(actorOf(user))) throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để thực hiện việc này');
        const release = exportSlots.tryAcquire(user.userId);
        if (!release) {
          c.header('retry-after', String(EXPORT_BUSY_RETRY_SECONDS));
          throw new DomainError('EXPORT_BUSY', 503, 'Đang có nhiều lượt xuất; hãy thử lại sau vài giây');
        }
        // The slot is held until the bytes are taken (held below); any failure before that lets it go.
        try {
          const period = c.req.query('period') ?? '';
          const legalEntityId = c.req.query('legalEntityId') || undefined;
          const query = { kind, period, ...(legalEntityId ? { legalEntityId } : {}) };
          const document = await runtime.query<HrDeclarationDocument>('hr.payroll.declaration.get', query, { actor: actorOf(user), orgId });
          const bytes = asView ? null : await buildDeclarationWorkbook(document, config.BRAND_NAME);
          const rows = document.sheets.reduce((n, sheet) => n + sheet.rows.length, 0);
          await runtime.execute('hr.payroll.declaration.export', { ...query, rows, via: asView ? 'view' : 'xlsx', months: document.used.months, ...document.used.authorizedYear === undefined ? {} : { authorizedYear: document.used.authorizedYear, authorizedPeople: document.used.authorizedPeople } }, { actor: actorOf(user), orgId });
          if (bytes === null) {
            release();
            return c.json(zHrDeclarationDocument.parse(document), 200, { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
          }
          return new Response(held(new Uint8Array(bytes), release), {
            headers: {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), `bang-ke-${kind}`, period, ORG_SLUG], 'xlsx'),
              'x-content-type-options': 'nosniff',
              'cache-control': 'private, no-store',
            },
          });
        } catch (error) {
          release();
          throw error;
        }
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // The bank bulk-salary file of an approved pay run (#2532, payroll plan 6.4): GET /api/payroll-bank-file/<runId>.xlsx?bank=<a bank code of the bank list>&columns=seq,name,account,bank,amount,content (columns optional, in the
  // order wanted; or template=<id> of a saved template of the run's legal entity, #2893, which decides the columns, their headers and the remark; one file is for one bank, #2897). Ludy never initiates a payment: the file is for the accountant to upload to the bank. Built only in the requesting owner's or admin's own context by the sensitive query
  // hr.payroll.bank_file.get (its audit row is committed before the sealed account numbers are opened; nothing decrypted reaches an audit fact or a log), never a worker, a stored job or a stored blob,
  // and no email. No account number is ever in the URL or the query string: only the run, the bank's code, the template's id and the column choice are. It needs a second factor used in the last 5 minutes
  // (STEP_UP_REQUIRED), takes a slot of the export limiter like the other exports, is bounded (a run with more people than the cap, or a person with no account number, is refused, never cut short)
  // and is built whole; the audit row of the download (a count only) is written before the bytes are sent: no row, no download. The slot is held until the bytes are taken. `private, no-store`: the file
  // holds names and account numbers. Nothing is sent to any bank.
  if (runtime.installed('hr')) {
    app.get('/api/payroll-bank-file/:file', async (c) => {
      // A HEAD request would run the whole audited read and build the file only to throw the body away, leaving a download row for bytes nobody got.
      if (c.req.method === 'HEAD') return c.body(null, 405, { allow: 'GET' });
      try {
        const file = c.req.param('file');
        if (!file.endsWith('.xlsx')) throw new DomainError('NOT_FOUND', 404, 'Không có file này');
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        // Refused before a slot or an audit row: the query checks it again for every caller.
        if (!hasFreshMfa(actorOf(user))) throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để thực hiện việc này');
        const columnsParam = c.req.query('columns');
        const templateParam = c.req.query('template');
        const parsed = zHrBankFileQuery.safeParse({
          runId: file.slice(0, -'.xlsx'.length),
          bankName: c.req.query('bank') ?? '',
          ...(columnsParam ? { columns: columnsParam.split(',') } : {}),
          ...(templateParam ? { templateId: templateParam } : {}),
        });
        if (!parsed.success) throw new DomainError('BAD_REQUEST', 400, `Yêu cầu không hợp lệ: cần số hiệu bảng lương, mã ngân hàng và các cột trong ${HR_BANK_FILE_COLUMNS.join(', ')} (hoặc một mẫu, không kèm cột)`);
        const release = exportSlots.tryAcquire(user.userId);
        if (!release) {
          c.header('retry-after', String(EXPORT_BUSY_RETRY_SECONDS));
          throw new DomainError('EXPORT_BUSY', 503, 'Đang có nhiều lượt xuất; hãy thử lại sau vài giây');
        }
        // The slot is held until the bytes are taken (held below); any failure before that lets it go.
        try {
          const document = await runtime.query<HrBankFile>('hr.payroll.bank_file.get', parsed.data, { actor: actorOf(user), orgId });
          const bytes = await buildBankFileWorkbook(document, config.BRAND_NAME);
          await runtime.execute('hr.payroll.bank_file.export', { runId: document.runId, rows: document.rows.length, columns: document.columns.length }, { actor: actorOf(user), orgId });
          return new Response(held(new Uint8Array(bytes), release), {
            headers: {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'chuyen-luong', document.month, document.bankCode.toLowerCase(), ORG_SLUG], 'xlsx'),
              'x-content-type-options': 'nosniff',
              'cache-control': 'private, no-store',
            },
          });
        } catch (error) {
          release();
          throw error;
        }
      } catch (error) {
        return problem(c, error);
      }
    });
  }

  // The bank file of approved supplier payments (#3113 S3b-2, #3700): GET /api/supplier-payment-bank-file/payments.xlsx?ids=<payment ids, comma separated>[&reexport=1]. Ludy never initiates a payment: the file is for
  // the accountant to upload to the bank. The same rules as the salary file above: built only in the requesting owner's or admin's own context by the sensitive query finance.supplier_payment.bank_file.get (its audit row is
  // committed before the sealed holder and number are opened), a second factor used in the last 5 minutes, a slot of the export limiter, built whole, `private, no-store`, no HEAD, and no account number in the URL
  // (only payment ids). Before the bytes are sent the command finance.supplier_payment.bank_file.export writes its audit row and marks each payment (exported_at, exported_by, export_count) in one transaction: no row and no
  // marker, no download; a payment already marked is refused unless reexport=1 confirms a second file, which the row says. A refusal that belongs to one payment carries its paymentId (and, for a file handed over before, the
  // time) so the page can say which payment and why; never a holder, a number or an amount.
  if (runtime.installed('finance')) {
    app.get('/api/supplier-payment-bank-file/:file', async (c) => {
      if (c.req.method === 'HEAD') return c.body(null, 405, { allow: 'GET' });
      try {
        if (c.req.param('file') !== 'payments.xlsx') throw new DomainError('NOT_FOUND', 404, 'Không có file này');
        const user = c.get('user');
        const orgSlug = readOrgHeader(c);
        const orgId = await resolveOrg(runtime, user, orgSlug);
        if (!hasFreshMfa(actorOf(user))) throw new DomainError('STEP_UP_REQUIRED', 403, 'Cần xác thực hai lớp (MFA) trong 5 phút gần nhất để thực hiện việc này');
        const reexport = c.req.query('reexport') === '1';
        const parsed = zSupplierPaymentBankFileQuery.safeParse({ paymentIds: (c.req.query('ids') ?? '').split(',').filter((id) => id !== ''), ...(reexport ? { reexport: true } : {}) });
        if (!parsed.success) throw new DomainError('BAD_REQUEST', 400, 'Yêu cầu không hợp lệ: cần danh sách số hiệu khoản chi (ids), tối đa 200');
        const release = exportSlots.tryAcquire(user.userId);
        if (!release) {
          c.header('retry-after', String(EXPORT_BUSY_RETRY_SECONDS));
          throw new DomainError('EXPORT_BUSY', 503, 'Đang có nhiều lượt xuất; hãy thử lại sau vài giây');
        }
        try {
          const document = await runtime.query<SupplierPaymentBankFile>('finance.supplier_payment.bank_file.get', parsed.data, { actor: actorOf(user), orgId });
          const bytes = await buildSupplierPaymentBankFileWorkbook(document, config.BRAND_NAME);
          await runtime.execute(
            'finance.supplier_payment.bank_file.export',
            { paymentIds: parsed.data.paymentIds, rows: document.rows.length, currency: document.currency, ...(reexport ? { reexport: true } : {}) },
            { actor: actorOf(user), orgId },
          );
          return new Response(held(new Uint8Array(bytes), release), {
            headers: {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), 'chuyen-khoan-ncc', document.currency.toLowerCase(), ORG_SLUG], 'xlsx'),
              'x-content-type-options': 'nosniff',
              'cache-control': 'private, no-store',
            },
          });
        } catch (error) {
          release();
          throw error;
        }
      } catch (error) {
        if (error instanceof DomainError && typeof error.details?.paymentId === 'string') {
          const at = error.details.exportedAt;
          return c.json({ code: error.code, message: error.message, paymentId: error.details.paymentId, ...(typeof at === 'string' ? { exportedAt: at } : {}) }, error.status);
        }
        return problem(c, error);
      }
    });
  }

  // The org export (issue #38, streamed since #212), owners only: GET /api/org-export/manifest (JSON) or
  // /api/org-export/<table> (NDJSON, one row per line), from the newest export kernel.org.export.get reports. Every key,
  // version and sha256 comes from that export's audit row, never from the request; each blob is read at its recorded
  // version, checked against its sha256 and opened with the export key. A table streams chunk by chunk, so the kernel
  // holds one chunk at a time.
  const sealer = exportSealer(config);
  app.get('/api/org-export/:part', async (c) => {
    try {
      const user = c.get('user');
      const orgSlug = readOrgHeader(c);
      const orgId = await resolveOrg(runtime, user, orgSlug);
      const part = c.req.param('part');
      // The tables of the owner-run path (#2676, payroll people and pay runs) are read live by the owner's own session, never by the export job: a
      // sensitive stream, audited before it reads (it names the table), served only while the org is closing, which carries the fresh second factor
      // of kernel.org.offboard. The sealed identity and account numbers are not in it. The response streams, under a slot of the export limiter.
      if (Object.hasOwn(OWNER_RUN_EXPORT_TABLES, part)) {
        // A HEAD request would run the whole audited read and throw the body away.
        if (c.req.method === 'HEAD') return c.body(null, 405, { allow: 'GET' });
        const table = part as OwnerRunExportTable;
        const state = await runtime.query<OrgExportView>('kernel.org.export.get', {}, { actor: actorOf(user), orgId });
        if (state.status !== 'offboarding') throw new DomainError(ORG_NOT_OFFBOARDING, 409, 'Chỉ tải được các tệp này khi tổ chức đang được đóng');
        const release = exportSlots.tryAcquire(user.userId);
        if (!release) {
          c.header('retry-after', String(EXPORT_BUSY_RETRY_SECONDS));
          throw new DomainError('EXPORT_BUSY', 503, 'Đang có nhiều lượt xuất dữ liệu; hãy thử lại sau vài giây');
        }
        // streamedBody lets go of the slot on every path (the query settling, a pre-aborted request), so no catch releases it here.
        const body = await streamedBody((sink) => runtime.stream('kernel.org.export.people', { table }, { actor: actorOf(user), orgId }, sink), release, c.req.raw.signal);
        return new Response(body, {
          headers: {
            'content-type': 'application/x-ndjson; charset=utf-8',
            'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), ORG_SLUG, part], 'ndjson'),
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, no-store',
          },
        });
      }
      const view = await runtime.query<OrgExportView>('kernel.org.export.get', {}, { actor: actorOf(user), orgId });
      const exported = view.export;
      const missing = () => new DomainError('NOT_FOUND', 404, 'Chưa có bản xuất dữ liệu này');
      if (!exported) throw missing();
      if (exported.expired) throw new DomainError('EXPORT_EXPIRED', 404, 'Bản xuất dữ liệu đã hết hạn; hãy yêu cầu xuất lại');
      const read = async (ref: { key: string; generation: string; sha256: string }, aad: Buffer) => {
        // Under this org's export prefix whatever wrote the audit row (kernel.org.export.record checks it too).
        if (!ref.key.startsWith(`export/${orgId}/`)) throw missing();
        return sealer.open(await readVerified(store, ref), aad, exported.encryption);
      };
      const headers = (type: string, extension: string, length: number) => ({
        'content-type': type,
        'content-length': String(length),
        'content-disposition': attachmentDisposition(orgSlug, [brandSlug(config.BRAND_NAME), ORG_SLUG, part], extension),
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      });
      if (part === 'manifest') {
        const ref = { key: exported.manifestKey, generation: exported.manifestGeneration, sha256: exported.manifestSha256 };
        const bytes = await read(ref, exportAad(orgId, 'manifest'));
        return new Response(body(bytes), { headers: headers('application/json; charset=utf-8', 'json', bytes.byteLength) });
      }
      const chunks = exported.parts.filter((p) => p.table === part).sort((a, b) => a.chunk - b.chunk);
      if (chunks.length === 0) throw missing();
      const readChunk = (p: (typeof chunks)[number]) => read(p, exportAad(orgId, { table: p.table, chunk: p.chunk }));
      // The first chunk is read before the response starts, so a missing or altered blob answers with an error status.
      const first = await readChunk(chunks[0] as (typeof chunks)[number]);
      let next = 1;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(first);
          },
          async pull(controller) {
            const chunk = chunks[next++];
            if (!chunk) return controller.close();
            try {
              controller.enqueue(await readChunk(chunk));
            } catch (error) {
              // The status is already sent; the client sees a cut download (content-length tells it so).
              console.error(`[org-export] download of ${part} chunk ${chunk.chunk} failed`, error);
              controller.error(error);
            }
          },
        },
        { highWaterMark: 0 },
      );
      const length = chunks.reduce((n, p) => n + p.bytes, 0);
      return new Response(stream, { headers: headers('application/x-ndjson; charset=utf-8', 'ndjson', length) });
    } catch (error) {
      return problem(c, error);
    }
  });

  app.all('/api/*', (c) => c.json({ code: 'NOT_FOUND' }, 404));

  // The SPA, served on the same origin.
  if (existsSync(config.WEB_DIST)) {
    const root = relative(process.cwd(), config.WEB_DIST) || '.';
    // The install manifest names the app after the deployment's brand (#1691), read and rendered once like index.html.
    // On the static files' own route, so it stays one of the SPA's public files; revalidated on every fetch, so a
    // renamed deployment is installed under its new name. Without the file, or with one that is not JSON, the static
    // route answers as before.
    const manifestPath = join(config.WEB_DIST, ...WEB_MANIFEST_PATH.split('/').filter(Boolean));
    let manifest: string | null = null;
    app.use('/assets/*', async (c, next) => {
      if (c.req.path !== WEB_MANIFEST_PATH || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) return next();
      if (manifest === null) {
        const source = await readFile(manifestPath, 'utf8').catch(() => null);
        if (source === null) return next();
        try {
          manifest = brandedManifest(source, config.BRAND_NAME);
        } catch {
          return next();
        }
      }
      return c.body(manifest, 200, { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    });
    app.use('/assets/*', serveStatic({ root }));
    app.use('/favicon.svg', serveStatic({ root }));
    const indexPath = join(config.WEB_DIST, 'index.html');
    const authOriginUrl = publicAuthUrl(config);
    const directOrigin = store.direct ? directTransferOrigin(config) : null;
    const hostedOrigin = hostedLoginTokenOrigin(config);
    const csp = contentSecurityPolicy(authOriginUrl, directOrigin, Boolean(config.TURNSTILE_SITE_KEY), null, hostedOrigin, null, googlePickerOn);
    const signCsp = contentSecurityPolicy(authOriginUrl, directOrigin, false, null, hostedOrigin);
    let indexHtml: string | null = null;
    app.get('*', async (c) => {
      const isSignPage =
        c.req.path === SIGN_PAGE_PATH ||
        c.req.path.startsWith(`${SIGN_PAGE_PATH}/`) ||
        c.req.path === SIGN_DIRECT_PAGE_PATH ||
        c.req.path.startsWith(`${SIGN_DIRECT_PAGE_PATH}/`) ||
        c.req.path.startsWith(`${SIGN_PUBLIC_HUB_PAGE_PREFIX}/`);
      const roadmapRoute = matchPublicRoadmapPagePath(c.req.path);
      let pageCsp = isSignPage ? signCsp : csp;
      if (roadmapRoute) {
        const frameAncestors =
          c.req.query('embed') === '1'
            ? await resolveRoadmapEmbedFrameAncestors(runtime, roadmapBilling, roadmapRoute.orgSlug, roadmapRoute.boardSlug)
            : null;
        pageCsp = contentSecurityPolicy(authOriginUrl, directOrigin, false, null, hostedOrigin, frameAncestors);
      }
      c.header('content-security-policy', pageCsp);
      if (isSignPage || roadmapRoute) {
        c.header('referrer-policy', 'no-referrer');
        c.header('cache-control', 'no-store');
        c.header('x-content-type-options', 'nosniff');
      }
      indexHtml ??= await readFile(indexPath, 'utf8');
      return c.html(indexHtml);
    });
  } else {
    app.get('/', (c) => c.text('Ludy API is running. Build apps/app to serve the web UI from this port.'));
  }
  return app;
}
