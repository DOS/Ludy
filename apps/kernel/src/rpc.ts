// oRPC implementation of @crove/kernel-contract. Handlers only call the runtime (execute/query).
import { randomBytes } from 'node:crypto';
import { implement, ORPCError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { CALENDAR_OAUTH_PROVIDERS, MARKETPLACE_PLATFORM_KEYS, MEETING_PLATFORM_CONNECT_PROVIDERS, canReadEventsWith, meetingPlatformBinding, COWORKER_ROSTER as COWORKERS, OAUTH_MAX_ACCOUNTS_PER_GRANT, calendarBinding, contract, isAdProviderId, isAdWriteProviderId, vietnamToday } from '@crove/kernel-contract';
import { TingeeError, sandboxBankFeed, type BankFeedProvider } from '@crove/bank-feed';
import { RateLimiter } from './rate-limit.ts';
import { sandboxAdPlatform, sandboxWriteLogin, type AdPlatform } from '@crove/ad-platform';
import { EInvoiceProviderError, SANDBOX_EINVOICE_SECRET, type ConnectionState, type EInvoiceProvider } from '@crove/einvoice';
import type { McpWakeView, MeetingHookView, QuoteLinkCreated } from '@crove/kernel-contract';
import { assertWakeHostPublic, makeWakeSecret, type WakeResolve } from './mcp-wake-setup.ts';
import { adLaunchCapable } from './ads-launch-capable.ts';
import { markableDetail, markableListed } from './conversation-sender-mark.ts';
import { makeHookSecret } from './meeting-hook-setup.ts';
import type { BankLineVoucher, MarketplaceColumnsStatus, AdAccountView, AdsChange, AdsChangeRequest, ConversationDetail, ConversationListed, BankPayrollMatch, ConversationEvent, EInvoiceConnection, EInvoiceCorrectionRate, MisaAmisConnection, EInvoiceReasonSource, StockSurplusSource, EInvoiceSeriesTemplate, ChatPreview, FinanceOverview, FollowupDraft, HrPayslip, HrRunSheet, HrRunSummary, MarketplaceBalance, MarketplaceConnection, MarketplaceFacts, SupplierPayableList, PaymentReminderDraft, TodayList, VatLateSource, WeeklyFigures } from '@crove/kernel-contract';
import { briefAnswer } from './today-brief.ts';
import { weeklyAnswer } from './today-weekly.ts';
import { type CalendarAdapter, type MeetingPlatformAdapter, BlueskyError, ConnectorError, MeetingPlatformConsentError, MeetingPlatformError, hasOAuth, blueskyLogin, connectBluesky, connectDiscord, connectMastodon, connectTelegram, connectWhatsApp, connectWordPress, discordLogin, mastodonLogin, telegramLogin, whatsappLogin, wordpressLogin, newOAuthAttempt, oauthStateHash, sandbox, sandboxNoticeBody, type OAuthConnector } from '@crove/channel';
import {
  ALT_TEXT_IMAGE_MAX_BYTES,
  ALT_TEXT_IMAGE_TYPES,
  ProofreadChangedError,
  SummaryFigureError,
  type DraftRequest,
  type DraftResult,
  type ScheduleReading,
  type ScheduleWindow,
  type SchedulingReader,
  type SocialWriter,
  type WriterChannel,
} from '@crove/agent';
import { CAPABILITIES, isProvider as isSocialProvider, strictestAltTextLimit } from '@crove/mod-social/contract';
import { channelNotAllowed, periodSummaryInput, voiceNotes, type BrandVoice, type PeriodSummaryData } from '@crove/mod-social';
import {
  TODAY_WEEKLY_READ,
  clientOverviews,
  createOrg,
  myOrgs,
  previewInvite,
  revokeOwnSessionsWithoutOrg,
  sessionOrgs,
  upstreamAuth,
  type AcceptedInvite,
  type BulkApproveResult,
  type ChannelConnectInput,
  type ContactCandidates,
  type DirectMail,
  type IntentSource,
  type OrgSummary,
} from '@crove/kernel';
import type { z } from 'zod';
import type { CompanyCandidates, ConversationAutoDraft, zAgentBudget, zAgentTemplate, zAiMeter, zAiUsageReport, zSignEnvelopeDetail, zSignTemplateDetail, zTask } from '@crove/kernel-contract';
import type { FollowupSource, MeetingBriefSource, QuoteSuggestSource, SuggestedSlots } from '@crove/mod-crm';
import type { ProjectWeeklyStatusSource } from '@crove/mod-projects';
import { sql } from 'kysely';
import { AiBudgetExhaustedError, withAiScope, type AiMeter, type BriefFacts, type BriefResult, type WeeklyFacts, type WeeklyResult } from '@crove/agent';
import { IntentCache, matchContacts, suggestIntents, type ConversationAi, type ConversationReader } from './conversations-ai.ts';
import { suggestCompanies, type CompanyAi } from './contact-company-ai.ts';
import { wordReminder, type ReminderAi } from './payment-reminder-ai.ts';
import { wordFollowup, type FollowupAi } from './followup-ai.ts';
import { minutesLink, postMinutesFromClick, saveMinutesChannel, type MinutesChatDeps } from './meeting-chat.ts';
import { saveMeetingSummaryAsNote } from './notes-meeting-summary.ts';
import { explainPayslip, flagMonth, prepareMonth, type PayrollAi, type PayrollReads } from './payroll-coworker-ai.ts';
import { checkLaborReadiness, type LaborCheckAi, type LaborCheckPorts } from './labor-coworker-ai.ts';
import { generateRecruitingBrief, type RecruitingBriefAi, type RecruitingBriefPorts } from './recruiting-coworker-ai.ts';
import type { HrLaborCheckSnapshot, HrRecruitingBriefSnapshot } from '@crove/mod-hr';
import { einvoiceAi, suggestEInvoiceDraft } from './einvoice-ai.ts';
import { einvoiceRateAi, explainCorrectionRate } from './einvoice-rate-ai.ts';
import { explainSurplus, stockSurplusAi } from './stock-surplus-ai.ts';
import { einvoiceReasonAi, suggestCorrectionReason } from './einvoice-reason-ai.ts';
import { crmFollowupAi, draftCrmFollowup } from './crm-followup-ai.ts';
import { meetingBriefAi, prepareMeetingBrief } from './crm-meeting-brief-ai.ts';
import { prepareProjectWeeklyStatus, projectWeeklyStatusAi } from './project-weekly-status-ai.ts';
import { quoteAi, suggestQuoteLines } from './quote-ai.ts';
import { proposeEnvelopeAnalysis, proposeEnvelopeObligations, signAi, type SignAi } from './sign-ai.ts';
import { adherenceStatusOf, runMeetingAdherence, assigneeStatusOf, runMeetingAssignee, briefStatusOf, digestStatusOf, runMeetingBrief, runMeetingTitle, runMeetingDigest, askStatusOf, notesVyStatusOf, readNotesVyResults, runLiveNotes, runMeetingAsk, runMeetingChapters, runMeetingSummary, runMeetingTranslation, runNotesEnhance, runNotesSuggestTodos, runNotesSummarize, runProjectsTasksFromNote, runProjectsTasksFromSource, runTranscriptTranslation, tasksFromNoteStatusOf, tasksFromSourceStatusOf, transcriptTranslationStatusOf, translationStatusOf, type ModelPort, runMeetingCommitments } from './member-vy-ports.ts';
import { draftReorder, stockAi, suggestItems, suggestMarketplaceItems } from './stock-ai.ts';
import { MARKETPLACE_AUTHORIZED_ADAPTERS, MARKETPLACE_FEE_CYCLE_DAYS, misaChannelProvider, MarketplaceProviderError, SANDBOX_MARKETPLACE_SECRET, type EInvoiceSuggestSource, type MarketplaceProvider, type MarketplaceTestResult, type MarketplaceSuggestSource, type ReorderSource, type SuggestSource } from '@crove/mod-finance';
import { explainOverview, overviewAi } from './finance-overview-ai.ts';
import { explainVatLate, vatLateAi } from './finance-vat-ai.ts';
import { marketplaceColumnsAi, proposeMarketplaceColumns } from './finance-marketplace-columns-ai.ts';
import { explainMarketplaceFees, marketplaceFeeNoteAi } from './finance-marketplace-fee-note-ai.ts';
import { explainMarketplaceLine, marketplaceLineAi } from './finance-marketplace-line-ai.ts';
import { explainSupplierPayableLine, supplierPayableLineAi } from './finance-supplier-payable-line-ai.ts';
import { misaCheck } from './misa-check.ts';
import { explainMisaAmisBlockers, misaAmisBlockerNotesAi } from './finance-misa-amis-blocker-notes-ai.ts';
import { explainMisaCheckLine, misaCheckLineAi } from './finance-misa-check-line-ai.ts';
import { misaAmisPreview } from './misa-amis-preview.ts';
import { bankCandidatesLineAi, explainBankCandidatesLine } from './finance-bank-candidates-line-ai.ts';
import { explainPayrollMatch, payrollMatchAi } from './finance-payroll-match-ai.ts';
import { DomainError, egressFetch, type CredentialBroker, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { DraftBudget } from './ai-draft-limit.ts';
import { BlueskyLoginBudget } from './bluesky-login-limit.ts';
import { ChatAlertSaveBudget, ChatAlertTestBudget, requestChatAlertTest, saveChatAlert } from './chat-alert-save.ts';
import { actorOf, type AuthUser } from './auth.ts';
import { ConcurrencyLimiter } from './concurrency.ts';
import { setLogContext } from './log.ts';
import type { StockPhotos } from './stock-photos.ts';
import type { MediaUrls } from './media-urls.ts';
import type { InviteRole, SendInviteMail } from './invite-mail.ts';
import type { Delivery, DeliveryResult } from './mail.ts';
import type { TaxCodeLookup } from './tax-lookup.ts';
import type { PortalSync } from './portal-sync.ts';

// What a refused Tingee test call says to the owner (#2045): a fixed sentence per kind, never Tingee's own text, the Client ID or the Secret Token.
function tingeeConnectError(error: unknown): DomainError {
  if (!(error instanceof TingeeError)) return new DomainError('BANK_FEED_UPSTREAM', 503, 'Không gọi được Tingee lúc này; hãy thử lại sau');
  switch (error.kind) {
    case 'credentials':
      return new DomainError('BANK_FEED_CREDENTIALS', 422, 'Tingee không chấp nhận Client ID hoặc Secret Token này; hãy kiểm tra lại trong cổng Tingee');
    case 'clock':
      return new DomainError('BANK_FEED_CLOCK', 422, 'Giờ của máy chủ lệch quá xa so với Tingee; hãy chỉnh lại giờ máy chủ rồi thử lại');
    case 'rate_limited':
      return new DomainError('BANK_FEED_RATE_LIMITED', 429, 'Tingee báo gọi quá nhanh; hãy thử lại sau ít phút');
    default:
      return new DomainError('BANK_FEED_UPSTREAM', 503, 'Không gọi được Tingee lúc này; hãy thử lại sau');
  }
}

export interface RpcContext {
  user: AuthUser;
  orgSlug: string | null;
}

export function toORPCError(error: unknown): ORPCError<string, unknown> {
  if (error instanceof ORPCError) return error;
  if (!(error instanceof DomainError) || error.status >= 500) console.error('[rpc]', error);
  const domain = error instanceof DomainError ? error : new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
  return new ORPCError(domain.code, { status: domain.status, message: domain.message, data: domain.details });
}

export async function resolveMembership(runtime: Runtime, user: AuthUser, slug: string | null): Promise<OrgSummary> {
  // An extension token has one org and no org list to look it up in: the routes it reaches use resolveOrg (below).
  if (user.extension) throw new DomainError('FORBIDDEN', 403, 'Mã của tiện ích Ludy không được dùng cho việc này', { rule: 'extension_scope' });
  if (!slug) throw new DomainError('ORG_REQUIRED', 400, 'Thiếu tổ chức (header x-crove-org)');
  const orgs = await runtime.forUser(actorOf(user), (db) => myOrgs(db, user.userId));
  const org = orgs.find((o) => o.slug === slug);
  if (!org) throw new DomainError('NOT_A_MEMBER', 403, 'Bạn không thuộc tổ chức này');
  // From here on the request's log lines name the org (#2175).
  setLogContext({ orgId: org.orgId });
  return org;
}

export async function resolveOrg(runtime: Runtime, user: AuthUser, slug: string | null): Promise<string> {
  // An extension token names its one org (issue #2582). It is not a claim to trust: the runtime re-checks, in the
  // transaction of every command and query, that this token belongs to this member and this org.
  if (user.extension) {
    setLogContext({ orgId: user.extension.orgId });
    return user.extension.orgId;
  }
  return (await resolveMembership(runtime, user, slug)).orgId;
}

// The error code a mail_message row gets when the invite mail did not go out: no mail server configured, the server
// refused it or the deadline passed, or the template threw.
const DELIVERY_ERROR: Record<Exclude<Delivery, 'sent'> | 'error', string> = { off: 'MAIL_OFF', failed: 'SEND_FAILED', error: 'SEND_ERROR' };

interface CreatedInvite {
  inviteId: string;
  email: string;
  role: InviteRole;
  expiresAt: string;
  acceptPath: string;
}

// Reads the days and times a client's message asks for (SchedulingReader in @crove/agent, #1440).
export type BookingReader = Pick<SchedulingReader, 'read'>;

// Drafts Social posts with the deployment's model (SocialWriter in @crove/agent); unset: AI drafting is off.
export type SocialDrafter = Pick<SocialWriter, 'draft' | 'rewrite'> &
  Partial<Pick<SocialWriter, 'hashtags' | 'ideas' | 'summary'>> & {
    // An image's alt text from its stored bytes (#817), when the deployment's model takes images (AI_VISION), within
    // maxChars when the chosen channels take less than the writer's own limit (#1121). The read stops at the size the
    // file row records (#1126).
    describeStored?: (file: StoredImage, mime: string, language: 'vi' | 'en', maxChars?: number | null) => Promise<string | null>;
    // A draft written from photos of the library (#1191) too, read from their stored bytes like alt text, when the model
    // takes images; each read stops at the size its file row records.
    draftStored?: (request: Omit<DraftRequest, 'images'>, images: readonly { file: StoredImage; mime: string }[]) => Promise<DraftResult | null>;
    // Vy's daily brief on Home (#2383), through the same endpoint and the same budget meter.
    brief?: (facts: BriefFacts) => Promise<BriefResult>;
    // Vy's "Tuần này" on Home (#3257), through the same endpoint and the same budget meter.
    weekly?: (facts: WeeklyFacts) => Promise<WeeklyResult>;
  };

// A stored file as the vision reads take it: the row's reference, hash and recorded size.
export interface StoredImage {
  key: string;
  generation: string | null;
  sha256: string;
  sizeBytes: number;
}

// Deletes the member's cached meetings of a calendar connection (B1, #3165), as the member: row security lets them delete their own rows only. Best effort by design: a deployment without
// the meetings module has no such command, and a failure leaves rows the list already hides (the connection is not active, or its switch is off) and a disconnect's cascade removes.
async function clearAgenda(runtime: Runtime, as: { actor: UserActor; orgId: string }, connectionId: string): Promise<void> {
  try {
    await runtime.execute('meetings.agenda.clear', { connectionId }, as);
  } catch (error: unknown) {
    console.error(`[calendar] cached meetings of connection ${connectionId.slice(0, 8)} not cleared: ${error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error'}`);
  }
}

// A member limited to some channels (#1081) may not have AI write for another one (#1099): refused before the paid model
// call and before that channel's brand voice is read, as social.post.create would refuse the channel afterwards.
async function refuseChannelsOutside(runtime: Runtime, actor: UserActor, orgId: string, connectionIds: readonly string[]): Promise<void> {
  if (connectionIds.length === 0) return;
  const mine = await runtime.query<{ limited: boolean; connectionIds: string[] }>('social.channel_access.mine', {}, { actor, orgId });
  if (!mine.limited) return;
  const allowed = new Set(mine.connectionIds);
  const outside = [...new Set(connectionIds)].filter((id) => !allowed.has(id)).sort();
  if (outside.length > 0) throw channelNotAllowed(outside);
}

// The org's saved brand voices (#741) as notes for the writer: the org's, and each channel's by connection.
async function savedVoices(runtime: Runtime, actor: UserActor, orgId: string): Promise<{ org: string | null; byChannel: Map<string, string> }> {
  const rows = await runtime.query<BrandVoice[]>('social.brand_voice.list', {}, { actor, orgId });
  const org = rows.find((v) => v.connectionId === null);
  return { org: org ? voiceNotes(org) : null, byChannel: new Map(rows.filter((v) => v.connectionId !== null).map((v) => [v.connectionId as string, voiceNotes(v)])) };
}

// What the writer is told about a channel: the limits the channel rules check afterwards.
function writerChannel(c: { id: string; provider: string; displayName: string }): WriterChannel {
  const caps = isSocialProvider(c.provider) ? CAPABILITIES[c.provider] : null;
  return {
    key: c.id,
    provider: c.provider,
    label: `${PROVIDER_LABELS[c.provider] ?? c.provider} (${c.displayName})`,
    maxChars: caps?.body.max ?? null,
    unit: caps?.body.count === 'bytes' ? 'bytes' : 'characters',
    title: caps?.title ? { required: caps.title.required, max: caps.title.max } : null,
  };
}

// Why a Mastodon account did not connect, in words for the connect form; any other failure (the instance did not
// answer, or the egress guard refused its address) is an instance Crove cannot reach.
function mastodonFailure(code: string | undefined): DomainError {
  if (code === 'MASTODON_INSTANCE_INVALID') return new DomainError('MASTODON_INSTANCE_INVALID', 422, 'Hãy nhập địa chỉ máy chủ Mastodon, ví dụ mastodon.social');
  if (code === 'MASTODON_TOKEN_INVALID') return new DomainError('MASTODON_TOKEN_INVALID', 422, 'Đây không phải mã truy cập Mastodon; hãy chép mã trong Cài đặt > Phát triển của máy chủ');
  if (code === 'MASTODON_TOKEN_REFUSED') return new DomainError('MASTODON_TOKEN_REFUSED', 422, 'Máy chủ Mastodon không chấp nhận mã truy cập này');
  if (code === 'MASTODON_NOT_AN_INSTANCE') return new DomainError('MASTODON_NOT_AN_INSTANCE', 422, 'Địa chỉ này không phải một máy chủ Mastodon');
  return new DomainError('MASTODON_INSTANCE_UNREACHABLE', 422, 'Không kết nối được tới máy chủ Mastodon này; hãy kiểm tra địa chỉ rồi thử lại');
}

// Why a WordPress site did not connect, in words for the connect form; any other failure (the site did not answer, or
// the egress guard refused its address) is a site Crove cannot reach.
function wordpressFailure(code: string | undefined): DomainError {
  if (code === 'WORDPRESS_SITE_INVALID') return new DomainError('WORDPRESS_SITE_INVALID', 422, 'Hãy nhập địa chỉ trang WordPress qua https, ví dụ https://tiemcuaban.vn');
  if (code === 'WORDPRESS_LOGIN_INVALID') return new DomainError('WORDPRESS_LOGIN_INVALID', 422, 'Hãy nhập tên người dùng và mật khẩu ứng dụng (24 chữ cái và chữ số) mà WordPress tạo cho bạn');
  if (code === 'WORDPRESS_LOGIN_REFUSED') return new DomainError('WORDPRESS_LOGIN_REFUSED', 422, 'WordPress không chấp nhận tên người dùng hoặc mật khẩu ứng dụng này');
  if (code === 'WORDPRESS_CANNOT_PUBLISH') return new DomainError('WORDPRESS_CANNOT_PUBLISH', 422, 'Tài khoản này chưa có quyền đăng bài; hãy dùng tài khoản Tác giả, Biên tập viên hoặc Quản trị viên');
  if (code === 'WORDPRESS_NO_REST_API') return new DomainError('WORDPRESS_NO_REST_API', 422, 'Trang này chưa bật REST API của WordPress, hoặc đường dẫn tĩnh đang tắt');
  if (code === 'WORDPRESS_SITE_REDIRECTS') return new DomainError('WORDPRESS_SITE_REDIRECTS', 422, 'Địa chỉ này chuyển sang một địa chỉ khác; hãy nhập địa chỉ cuối cùng của trang, bắt đầu bằng https');
  return new DomainError('WORDPRESS_SITE_UNREACHABLE', 422, 'Không kết nối được tới trang WordPress này; hãy kiểm tra địa chỉ rồi thử lại');
}

type LinkPreviewView = { status: 'pending' | 'ready' | 'failed'; title: string | null; description: string | null; siteName: string | null; text: string | null } | null;
const SOURCE_WAIT_MS = 10_000;
// The link preview of a page an AI draft is written from (#769): requested when there is none, then waited for. A page
// that cannot be read, or one still pending, is said in words; nothing is drafted from it.
async function sourcePage(runtime: Runtime, actor: UserActor, orgId: string, url: string) {
  const options = { actor, orgId };
  const read = () => runtime.query<LinkPreviewView>('social.link_preview.get', { url }, options);
  let view = await read();
  if (!view || view.status !== 'ready') {
    if (!view || view.status === 'failed') await runtime.execute('social.link_preview.request', { url }, options);
    const until = Date.now() + SOURCE_WAIT_MS;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      view = await read();
      if (view && view.status !== 'pending') break;
    }
  }
  if (!view || view.status === 'pending') throw new DomainError('SOURCE_NOT_READY', 409, 'Đang đọc trang này, hãy thử lại sau vài giây');
  if (view.status === 'failed' || (!view.title && !view.description && !view.text)) throw new DomainError('SOURCE_UNREADABLE', 422, 'Không đọc được nội dung trang này; hãy mô tả bài bằng lời');
  return { url, title: view.title, description: view.description, siteName: view.siteName, text: view.text };
}

// Why a Telegram channel did not connect, in words for the connect form.
function telegramFailure(code: string | undefined): DomainError | null {
  if (code === 'TELEGRAM_TOKEN_INVALID') return new DomainError('TELEGRAM_TOKEN_INVALID', 422, 'Đây không phải mã bot Telegram; hãy chép mã @BotFather gửi khi tạo bot');
  if (code === 'TELEGRAM_CHANNEL_INVALID') return new DomainError('TELEGRAM_CHANNEL_INVALID', 422, 'Hãy nhập tên kênh dạng @tenkenh, đường dẫn t.me hoặc mã số của kênh');
  if (code === 'TELEGRAM_TOKEN_REFUSED') return new DomainError('TELEGRAM_TOKEN_REFUSED', 422, 'Telegram không chấp nhận mã bot này; có thể mã đã bị đổi trong @BotFather');
  if (code === 'TELEGRAM_CHANNEL_NOT_FOUND') return new DomainError('TELEGRAM_CHANNEL_NOT_FOUND', 422, 'Bot không thấy kênh này; hãy kiểm tra tên kênh và thêm bot vào kênh');
  if (code === 'TELEGRAM_NOT_A_CHANNEL') return new DomainError('TELEGRAM_NOT_A_CHANNEL', 422, 'Đây không phải một kênh Telegram; chỉ đăng được lên kênh, không đăng vào nhóm');
  if (code === 'TELEGRAM_BOT_CANNOT_POST') return new DomainError('TELEGRAM_BOT_CANNOT_POST', 422, 'Bot chưa được đăng bài trong kênh; hãy đặt bot làm quản trị viên có quyền đăng bài');
  return null;
}
// Why a WhatsApp number did not connect, in words for the connect form.
function whatsappFailure(code: string | undefined): DomainError | null {
  if (code === 'WHATSAPP_TOKEN_INVALID') return new DomainError('WHATSAPP_TOKEN_INVALID', 422, 'Đây không phải mã truy cập WhatsApp; hãy chép mã của người dùng hệ thống (system user) trong Meta Business');
  if (code === 'WHATSAPP_PHONE_ID_INVALID') return new DomainError('WHATSAPP_PHONE_ID_INVALID', 422, 'Mã số điện thoại (Phone number ID) chỉ gồm chữ số, lấy ở WhatsApp > API Setup trong ứng dụng Meta');
  if (code === 'WHATSAPP_WABA_ID_INVALID') return new DomainError('WHATSAPP_WABA_ID_INVALID', 422, 'Mã tài khoản WhatsApp Business (WABA ID) chỉ gồm chữ số, lấy ở WhatsApp > API Setup trong ứng dụng Meta');
  if (code === 'WHATSAPP_TOKEN_REFUSED') return new DomainError('WHATSAPP_TOKEN_REFUSED', 422, 'WhatsApp không chấp nhận mã truy cập này; có thể mã đã bị thu hồi hoặc hết hạn');
  if (code === 'WHATSAPP_PERMISSION') return new DomainError('WHATSAPP_PERMISSION', 422, 'Mã truy cập này chưa có quyền với số điện thoại; hãy cấp quyền whatsapp_business_messaging cho người dùng hệ thống');
  if (code === 'WHATSAPP_PHONE_NOT_FOUND') return new DomainError('WHATSAPP_PHONE_NOT_FOUND', 422, 'WhatsApp không thấy mã số điện thoại này với mã truy cập đã nhập; hãy kiểm tra lại cả hai');
  return null;
}
// Why a Discord channel did not connect, in words for the connect form.
function discordFailure(code: string | undefined): DomainError | null {
  if (code === 'DISCORD_WEBHOOK_INVALID') return new DomainError('DISCORD_WEBHOOK_INVALID', 422, 'Hãy dán địa chỉ webhook của kênh Discord, dạng https://discord.com/api/webhooks/...');
  if (code === 'DISCORD_WEBHOOK_REFUSED') return new DomainError('DISCORD_WEBHOOK_REFUSED', 422, 'Discord không nhận webhook này, có thể nó đã bị xóa; hãy tạo webhook mới');
  return null;
}
const PROVIDER_LABELS: Record<string, string> = { sandbox: 'test channel', facebook_page: 'Facebook Page', instagram: 'Instagram', zalo_oa: 'Zalo Official Account (article)', tiktok: 'TikTok', youtube: 'YouTube', threads: 'Threads', linkedin: 'LinkedIn', x: 'X', bluesky: 'Bluesky', google_business: 'Google Business Profile', telegram: 'Telegram', mastodon: 'Mastodon', pinterest: 'Pinterest', discord: 'Discord', wordpress: 'WordPress (blog post)', linkedin_page: 'LinkedIn Page', whatsapp: 'WhatsApp' };

export interface RpcChannels {
  // Seals tokens before kernel.channel.connect stores them; never opens one in the API (a minutes channel's address included, B4: its worker job opens it).
  broker: CredentialBroker;
  // Tests only: the save budget of the minutes channels' addresses.
  minutes?: Pick<MinutesChatDeps, 'saves'>;
  // The offline sandbox channel is enabled (CHANNEL_SANDBOX).
  sandbox: boolean;
  // Tests only: how the wake-up receiver's name is looked up before it is accepted (the system resolver by default; the egress guard checks every send again).
  wakeResolve?: WakeResolve;
  // The offline sandbox bank feed is enabled (BANK_FEED_SANDBOX, ADR-0039).
  bankFeedSandbox?: boolean;
  // The real bank feed adapters this deployment offers, by provider id (BANK_FEED_TINGEE, #2045): the connect call tests a credential once through the adapter, then seals it; the worker alone opens it.
  bankFeedHosted?: Readonly<Record<string, BankFeedProvider>>;
  // The e-invoice providers this deployment offers, by adapter id (ADR-0044): the offline sandbox when EINVOICE_SANDBOX is on, a real adapter when its own switch is.
  einvoiceProviders?: Readonly<Record<string, EInvoiceProvider>>;
  // The marketplace providers this deployment offers, by adapter id (ADR-0045 point 7, #2519): the offline sandbox when MARKETPLACE_PROVIDERS names it.
  marketplaceProviders?: Readonly<Record<string, MarketplaceProvider>>;
  // Whether this deployment holds the integrator's ClientID for MISA AMIS (#3854): only that, never the value.
  misaAmis?: boolean;
  // Whether it holds the ClientID for MISA ASP too (#4111, S2 of #4103): each product is on only with its own.
  misaAsp?: boolean;
  // The push of vouchers to MISA AMIS is switched on too (MISA_AMIS_PUSH=on, after the sandbox check, #3902). Off: the confirm route answers 404 and the screen draws no button.
  misaAmisPush?: boolean;
  // The push to MISA ASP is switched on too (MISA_ASP_PUSH=on, #4113): its own switch, so AMIS's push and ASP's are on or off apart.
  misaAspPush?: boolean;
  // The ad platforms this deployment offers, by provider id (ADR-0040, #2217): the offline sandbox when ADS_SANDBOX is on.
  adsPlatforms?: Readonly<Record<string, AdPlatform>>;
  // The deployment can confirm who sent an email (INBOUND_AUTHSERV_ID, #3636): only then do conversations carry the "sender not confirmed" mark. Left out: it cannot.
  emailSenderCheck?: boolean;
  // The provider ids of the write connections this deployment has a launch writer for (adWritersOf: the sandbox's with ADS_SANDBOX, Meta's only with ADS_LIVE_LAUNCH,
  // #3675): ids only. The approval card says when a plan cannot launch here. Left out, none.
  adsLaunchProviders?: readonly string[];
  // The write Meta app is the read ads app or the Pages app (metaWriteAppShared of the config): switching running ads off then closes every
  // Meta reading connection (ADR-0043 point 4). Left out, it is taken as shared, the safe side.
  adsWriteAppShared?: boolean;
  // Bluesky accounts may connect with an app password (CHANNEL_BLUESKY).
  bluesky?: boolean;
  // Telegram channels may connect with a bot token (CHANNEL_TELEGRAM).
  telegram?: boolean;
  // Mastodon accounts may connect with an access token (CHANNEL_MASTODON).
  mastodon?: boolean;
  // Discord channels may connect with a webhook URL (CHANNEL_DISCORD).
  discord?: boolean;
  // WordPress sites may connect with an application password (CHANNEL_WORDPRESS).
  wordpress?: boolean;
  // WhatsApp numbers may connect by hand with a system user token (CHANNEL_WHATSAPP_APP_SECRET, #3131): the Meta app's secret, which proves the one call that checks the token.
  whatsapp?: { appSecret: string; graphVersion?: string | undefined } | null;
  // Providers connected through an OAuth dialog that this deployment configured (Social plan S6), by provider id.
  connectors?: Readonly<Partial<Record<string, OAuthConnector>>>;
  // Outside calendars members connect (#2123) through an OAuth dialog this deployment configured, by OAuth provider id.
  calendars?: Readonly<Partial<Record<string, CalendarAdapter>>>;
  // The meeting platforms this deployment has an adapter for (Zoom: C3, only with its own OAuth app), by provider; one with a connect dialog is offered to members.
  meetingPlatforms?: Readonly<Partial<Record<string, MeetingPlatformAdapter>>>;
  // The web app's address (kernel.ts hands over APP_URL, else PUBLIC_URL, #2261): the provider sends the browser back to
  // <it>/channels/oauth/:provider/callback, a page of the app that posts the code to the API. Named publicUrl for history.
  publicUrl?: string;
  // Stock photos from Pexels for the media library (#1106, MEDIA_PEXELS_API_KEY); unset: off, and no Pexels call is
  // made. Not a channel: it rides on this object because the HTTP edge hands it to the RPC handler unchanged, so the
  // feature needs no change to http.ts.
  stockPhotos?: StockPhotos;
  // The CSV import's image URLs (#1258), fetched into the library through the egress guard; unset: refused. Rides here
  // for the same reason as stockPhotos.
  mediaUrls?: MediaUrls;
  // Browser push for Social notifications (#1238, VAPID_*): the public key browsers subscribe with; unset: no push is
  // offered. Rides here for the same reason.
  push?: { publicKey: string };
}

// A meeting platform's refusal or failure during the connect step, as the answer the user sees: a fixed text, never the platform's words (the adapter's error carries only a short code).
function meetingPlatformConnectFailure(error: unknown): DomainError {
  // A Microsoft tenant whose administrator must allow the app first (Teams, C4): said plainly, and the code is used up, so nothing is retried.
  if (error instanceof MeetingPlatformConsentError) {
    return new DomainError('OAUTH_MEETINGS_ADMIN_CONSENT_REQUIRED', 422, 'Tổ chức Microsoft của bạn yêu cầu quản trị viên cho phép ứng dụng này trước. Hãy nhờ quản trị viên Microsoft 365 cho phép Ludy, rồi kết nối lại.');
  }
  if (error instanceof MeetingPlatformError && error.code === 'platform_refused') {
    console.warn(`[meeting-platform] connect refused: ${error.message}`);
    return new DomainError('OAUTH_CODE_REJECTED', 400, 'Nền tảng từ chối mã cấp quyền (đã dùng hoặc hết hạn) hoặc không cho đọc địa chỉ tài khoản, hãy kết nối lại và chấp nhận mọi quyền');
  }
  console.error('[meeting-platform] connect failed', error instanceof MeetingPlatformError ? error.code : error instanceof Error ? error.name : typeof error);
  return new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
}

// A provider's refusal or failure during the code exchange, as the answer the user sees. Never the provider's own
// message: it is logged, and the user gets a fixed text.
function connectorFailure(error: unknown): DomainError {
  if (error instanceof ConnectorError) {
    console.warn(`[channels] OAuth exchange failed: ${error.kind}${error.code ? ` (${error.code})` : ''}: ${error.message}`);
    if (error.kind === 'invalid_grant') return new DomainError('OAUTH_CODE_REJECTED', 400, 'Nền tảng từ chối mã cấp quyền (đã dùng hoặc hết hạn), hãy kết nối lại');
    // A token that can change campaigns or the business (ads_management, business_management): the person granted more than
    // reading reports to this app before. Said as it is, since accepting more permissions cannot help.
    if (error.kind === 'denied' && error.code === 'WRITE_PERMISSION_GRANTED') {
      return new DomainError('OAUTH_WRITE_PERMISSION', 422, 'Ứng dụng Meta này đang giữ quyền sửa quảng cáo (ads_management hoặc business_management) do bạn từng cấp. Hãy gỡ ứng dụng Meta này trong Cài đặt Facebook (Tích hợp doanh nghiệp) rồi kết nối lại, hoặc dùng một ứng dụng Meta riêng chỉ có quyền ads_read');
    }
    // A Microsoft tenant whose administrator must allow the app first (B3): said plainly, never retried.
    if (error.kind === 'denied' && error.code === 'ADMIN_CONSENT_REQUIRED') {
      return new DomainError('OAUTH_ADMIN_CONSENT_REQUIRED', 422, 'Tổ chức Microsoft của bạn yêu cầu quản trị viên cho phép ứng dụng này trước. Hãy nhờ quản trị viên Microsoft 365 cho phép Ludy đọc lịch, rồi kết nối lại.');
    }
    if (error.kind === 'denied' && error.code === 'MANAGER_ACCOUNT_UNSUPPORTED') {
      return new DomainError('OAUTH_GOOGLE_MANAGER_ONLY', 422, 'Tài khoản Google này chỉ truy cập được tài khoản quản lý (MCC), không có tài khoản quảng cáo trực tiếp; hãy đăng nhập bằng tài khoản Google truy cập trực tiếp tài khoản quảng cáo');
    }
    if (error.kind === 'denied' && error.code === 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION') {
      return new DomainError('OAUTH_GOOGLE_PROJECT_TEST_ONLY', 422, 'Dự án Google Cloud này đang ở mức Test nên chỉ đọc được tài khoản thử nghiệm; hãy xin cấp mức Explorer trong Google Cloud Console cho tài khoản thực');
    }
    if (error.kind === 'denied') return new DomainError('OAUTH_PERMISSION_MISSING', 422, 'Bạn chưa cấp đủ quyền cần thiết trong hộp thoại của nền tảng, hãy kết nối lại và chấp nhận mọi quyền');
    return new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
  }
  console.error('[channels] OAuth exchange failed', error instanceof Error ? error.name : typeof error);
  return new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
}

// sendInviteMail unset: invite mail is off (tests, or an embedder without mail). channels unset: no channel can be
// connected through the API (the list and disconnect still work).
// taxLookup unset: the public tax registry lookup is off (issue #324, TAX_CODE_LOOKUP_URL).
// portalSync unset: the assisted sync from the tax portal is off (issue #325, TAX_PORTAL_SYNC).
// bookingReader unset: booking suggestions do not read the client's message (issue #1440, AI_BASE_URL and AI_MODEL).
export function createRpcHandler(
  runtime: Runtime,
  sendInviteMail?: SendInviteMail,
  channels?: RpcChannels,
  socialWriter?: SocialDrafter,
  taxLookup?: TaxCodeLookup,
  drafts: DraftBudget = new DraftBudget(),
  blueskyLogins: BlueskyLoginBudget = new BlueskyLoginBudget(),
  portalSync?: PortalSync,
  bookingReader?: BookingReader,
  // The AI budget meter of this request's model calls (#2382) as the member who made it; aiEnabled: the deployment has a model.
  aiMeter?: (actor: UserActor) => AiMeter,
  aiEnabled = false,
  // The Inbox's AI coworker (CV3, #2306): the suggested intent and the likely contacts. Unset: no suggestion, with the inbox as it is.
  conversationReader?: ConversationReader,
  // The recorder's Vy summarizing a meeting (#2580, M6 part B2): the deployment's model behind the member-Vy model port, or unset.
  summaryModel: ModelPort | null = null,
  // The deployment's AI prices (AI_PRICE_*), for the cost a translation shows before the click.
  aiPrice?: { inputPerMTok: string; outputPerMTok: string },
  // Vy's eSign field placement and risky clause review (#3351): unset runs manual signing with AI off.
  signAiReader: SignAi['reader'] = null,
) {
  const os = implement(contract).$context<RpcContext>();
  // Connecting a Tingee account makes one signed read call from this server's address, and Tingee allows 20 calls in 10 seconds per address (#2045): an org may try a few times a minute, and the whole
  // deployment a few more, so a loop of made-up credentials cannot use up the budget the workers' syncs share.
  const tingeeConnectsPerOrg = new RateLimiter({ perMinute: 5 });
  const tingeeConnectsAll = new RateLimiter({ perMinute: 30, maxKeys: 1 });
  // Vy's brief on Home has its own rate limit and one-at-a-time lock, so opening Home never makes a reply or post draft wait.
  const briefs = new DraftBudget();
  // "Tuần này" has a rate limit of its own, apart from the brief's, so the two cards of Home never make each other wait.
  const weeklies = new DraftBudget();
  // Its model calls have a budget of their own (a few a minute for each member and for the org, one at a time for a member), apart from the reply drafts'.
  // A summary is a long call a member waits for: one at a time for a member, a few a minute.
  const summaries = new DraftBudget({ perUserPerMinute: 4, perOrgPerMinute: 20 });
  // A translation is a shorter call than a summary and any reader may ask: its own budget, apart from the summaries'.
  const translations = new DraftBudget({ perUserPerMinute: 6, perOrgPerMinute: 30 });
  // The transcript is translated a chunk a request, the page asking again while it is open: its own, higher rate, so a one-hour transcript is not stopped by the summary's.
  const transcriptTranslations = new DraftBudget({ perUserPerMinute: 20, perOrgPerMinute: 60 });
  // A question across meetings (A3, #3161) is one model call over at most 40 lines and any member may ask: its own budget, apart from the summaries' and the translations'.
  const asks = new DraftBudget({ perUserPerMinute: 6, perOrgPerMinute: 30 });
  const meetingBriefs = new DraftBudget({ perUserPerMinute: 6, perOrgPerMinute: 30 });
  // The weekly digest (#3949) is one call per click: its own budget, so it never makes a brief or a question wait.
  const meetingDigests = new DraftBudget({ perUserPerMinute: 6, perOrgPerMinute: 30 });
  // Naming who an action item belongs to (#3921) is one short call per click: its own budget, so it never makes a brief or a question wait.
  const meetingAssignees = new DraftBudget({ perUserPerMinute: 12, perOrgPerMinute: 60 });
  // Checking a meeting's agenda against its transcript (#3959) reads a whole transcript: its own budget, a few a minute, so it never makes a summary or a question wait.
  const meetingAdherence = new DraftBudget({ perUserPerMinute: 6, perOrgPerMinute: 30 });
  // Proposing project tasks from a note (#2598): one call per click, own budget so it does not contend with meetings.
  const noteTaskProposals = new DraftBudget({ perUserPerMinute: 6, perOrgPerMinute: 30 });
  // Notes N8 (#1677): independent budgets for summarizing notes and suggesting personal to-dos.
  const noteSummaryBudget = new DraftBudget({ perUserPerMinute: 6, perOrgPerMinute: 30 });
  const noteSuggestBudget = new DraftBudget({ perUserPerMinute: 6, perOrgPerMinute: 30 });
  const suggestionBudget = () => new DraftBudget({ perUserPerMinute: 12, perOrgPerMinute: 60 });
  const conversationAi: ConversationAi = { reader: conversationReader ?? null, intentBudget: suggestionBudget(), contactBudget: suggestionBudget(), cache: new IntentCache() };
  // The sales coworker's guess at the company a person works at (#2438) has a budget of its own, and the same reader and model.
  const companyAi: CompanyAi = { reader: conversationReader ?? null, budget: suggestionBudget() };
  // The finance coworker's sentence on the Kế toán overview (#2631): the same reader and model, a budget of its own, and it is told only aggregated figures.
  const financeOverviewAi = overviewAi(conversationReader?.overviewSentence ? { overviewSentence: conversationReader.overviewSentence.bind(conversationReader) } : null, suggestionBudget());
  // The finance coworker's sentence naming the late sales invoices of a VAT working (#3540): the same reader and model, a budget of its own; told invoice numbers and periods only.
  const financeVatLateAi = vatLateAi(conversationReader?.vatLateSentence ? { vatLateSentence: conversationReader.vatLateSentence.bind(conversationReader) } : null, suggestionBudget());
  // The finance coworker's one line on why a bank line may be a payroll payment (#2532): the same reader and model, a budget of its own; told the kind, month, amount and date only.
  const financePayrollMatchAi = payrollMatchAi(conversationReader?.payrollMatchSentence ? { payrollMatchSentence: conversationReader.payrollMatchSentence.bind(conversationReader) } : null, suggestionBudget());
  const financeMarketplaceLineAi = marketplaceLineAi(conversationReader?.marketplaceLineSentence ? { marketplaceLineSentence: conversationReader.marketplaceLineSentence.bind(conversationReader) } : null, suggestionBudget());
  // The finance coworker's notes under the Sàn table (#3711 slice 7): the same reader and model, a budget of its own; told the fees, their age and whether it is past the cycle, per numbered row, and no platform name.
  const financeMarketplaceFeeNoteAi = marketplaceFeeNoteAi(conversationReader?.marketplaceFeeNotes ? { marketplaceFeeNotes: conversationReader.marketplaceFeeNotes.bind(conversationReader) } : null, suggestionBudget());
  // The finance coworker's first mapping for the columns of an unrecognised order report (#4036): told the masked sheet the worker recorded (header texts and the shapes of a few values) and nothing else; a budget of its own.
  const financeMarketplaceColumnsAi = marketplaceColumnsAi(conversationReader?.marketplaceColumns ? { marketplaceColumns: conversationReader.marketplaceColumns.bind(conversationReader) } : null, suggestionBudget());
  const financeBankCandidatesLineAi = bankCandidatesLineAi(conversationReader?.bankCandidatesLineSentence ? { bankCandidatesLineSentence: conversationReader.bankCandidatesLineSentence.bind(conversationReader) } : null, suggestionBudget());
  const financeSupplierPayableLineAi = supplierPayableLineAi(conversationReader?.supplierPayableLineSentence ? { supplierPayableLineSentence: conversationReader.supplierPayableLineSentence.bind(conversationReader) } : null, suggestionBudget());
  const financeMisaCheckLineAi = misaCheckLineAi(conversationReader?.misaCheckLineSentence ? { misaCheckLineSentence: conversationReader.misaCheckLineSentence.bind(conversationReader) } : null, suggestionBudget());
  // The accounting coworker's notes on the kinds of blocker on the AMIS preview (#3904): the same reader and model, a budget of its own; told the kinds on the list and nothing else.
  const financeMisaAmisBlockerNotesAi = misaAmisBlockerNotesAi(conversationReader?.misaAmisBlockerNotes ? { misaAmisBlockerNotes: conversationReader.misaAmisBlockerNotes.bind(conversationReader) } : null, suggestionBudget());
  // The finance coworker on payroll (#2534, #2815): the same reader and model, independent budgets per action so `Promise.all([prepare, flag])` in the UI does not self-contend on `running`.
  const payrollPrepareBudget = suggestionBudget();
  const payrollAi: PayrollAi = {
    reader: conversationReader?.payrollPrepare && conversationReader.payrollFlag && conversationReader.payrollExplain
      ? { payrollPrepare: conversationReader.payrollPrepare.bind(conversationReader), payrollFlag: conversationReader.payrollFlag.bind(conversationReader), payrollExplain: conversationReader.payrollExplain.bind(conversationReader) }
      : null,
    budget: payrollPrepareBudget,
    prepareBudget: payrollPrepareBudget,
    flagBudget: suggestionBudget(),
    explainBudget: suggestionBudget(),
  };
  const laborCheckAi: LaborCheckAi = {
    reader: conversationReader?.laborCheck ? { laborCheck: conversationReader.laborCheck.bind(conversationReader) } : null,
    budget: suggestionBudget(),
  };
  const recruitingBriefAi: RecruitingBriefAi = {
    reader: conversationReader?.recruitingBrief ? { recruitingBrief: conversationReader.recruitingBrief.bind(conversationReader) } : null,
    budget: suggestionBudget(),
  };
  // The finance coworker's wording of a payment reminder (#2488): the same reader and model, a budget of its own. It reads no customer text (the model is told the
  // notice level, the language and the sender's name), so the org's switch for AI on its customers' messages does not apply.
  const reminderAi: ReminderAi = { reader: conversationReader?.reminderWords ? { reminderWords: conversationReader.reminderWords.bind(conversationReader) } : null, budget: suggestionBudget() };
  // The meetings coworker's wording of a follow-up email (L3, #2590): the same reader and model, a budget of its own. The model is told the language and the sender's name only.
  const followupAi: FollowupAi = { reader: conversationReader?.followupWords ? { followupWords: conversationReader.followupWords.bind(conversationReader) } : null, budget: suggestionBudget() };
  // The finance coworker on stock (#2514): which item a goods line is about and the wording of a reorder message. The same reader and model, a budget of its own. It reads a line's
  // description and unit and the item names (no amount, party or document number), and what it answers is a suggestion a person confirms or a draft they edit.
  const stockCoworker = stockAi(
    conversationReader && (conversationReader.stockMatch || conversationReader.reorderText)
      ? {
          ...(conversationReader.stockMatch ? { stockMatch: conversationReader.stockMatch.bind(conversationReader) } : {}),
          ...(conversationReader.reorderText ? { reorderText: conversationReader.reorderText.bind(conversationReader) } : {}),
        }
      : null,
    suggestionBudget(),
  );
  // The finance coworker on a sales e-invoice draft (#2505): lines, the VAT rate the text states and the buyer, from a text a person typed. The same reader and model, a budget of its own. It is
  // told the text and the names of the customers that fit it, never an address, tax code, credential or provider data, and what it answers only fills the form as proposals.
  const einvoiceCoworker = einvoiceAi(conversationReader?.einvoiceDraft ? { einvoiceDraft: conversationReader.einvoiceDraft.bind(conversationReader) } : null, suggestionBudget());

  // The accounting coworker's explanation of the VAT rate a correcting e-invoice proposes (#3709): the same reader and model, a budget of its own. Code decides the rate and the basis (the finance
  // query); the model is told the nature, two dates and the rates only, and what it writes only explains. With AI off the screen shows the code's own reason.
  const einvoiceRateCoworker = einvoiceRateAi(conversationReader?.einvoiceRateExplanation ? { einvoiceRateExplanation: conversationReader.einvoiceRateExplanation.bind(conversationReader) } : null, suggestionBudget());
  // The accounting coworker's proposal of the reason code of an adjusting or replacing e-invoice (#3690): the same reader and model, a budget of its own. It is told the list of codes, the buyer's kind, the
  // original's lines without a price and the person's note (never stored or logged); the code it answers is picked from the list by number and checked in code, and a person confirms it.
  const einvoiceReasonCoworker = einvoiceReasonAi(conversationReader?.einvoiceReasonSuggestion ? { einvoiceReasonSuggestion: conversationReader.einvoiceReasonSuggestion.bind(conversationReader) } : null, suggestionBudget());

  // The accounting coworker's explanation of the surplus of a confirmed count of stock (#3712 slice 2b): the same reader and model, a budget of its own. Code reads the items, the total, the supplier hint and
  // the manual-entry flag (the finance query); the model is told the date, the items, the total and a supplier's name only, and what it writes only explains. A person chooses the account. With AI off the
  // screen shows its own template.
  const stockSurplusCoworker = stockSurplusAi(conversationReader?.stockSurplusNote ? { stockSurplusNote: conversationReader.stockSurplusNote.bind(conversationReader) } : null, suggestionBudget());

  // The sales coworker on the lines of a quote (#2698): the same reader and model, a budget of its own. It is told the deal, the customer's latest words (only while the org's switch for AI on customers'
  // words is on) and the earlier quotes to them, and what it answers only fills the editor as proposals that a person applies or drops.
  const quoteCoworker = quoteAi(conversationReader?.quoteLines ? { quoteLines: conversationReader.quoteLines.bind(conversationReader) } : null, suggestionBudget());

  // The sales coworker's draft of the follow-up message for a "Cần theo dõi" step (#3101): the same reader and model, a budget of its own. It is told only the reason of the step and a hint, never a fact
  // of the deal; the facts and the link are composed by code, and what it answers is a text for the person to read, edit and send. Nothing is stored or sent.
  const followupCoworker = crmFollowupAi(conversationReader?.crmFollowupWords ? { crmFollowupWords: conversationReader.crmFollowupWords.bind(conversationReader) } : null, suggestionBudget());

  // Dy's brief before a booking linked to a deal (#3115): the same reader and model, a budget of its own. It is told the deal's facts and, while the org allows AI on customers' words, the latest messages the
  // member may read; what it answers is a summary and 2 to 3 points that are refused when they hold a figure, a link or a name the facts do not hold. Computed when read; nothing is stored or sent.
  const meetingBriefCoworker = meetingBriefAi(conversationReader?.meetingBrief ? { meetingBrief: conversationReader.meetingBrief.bind(conversationReader) } : null, suggestionBudget());

  // Vy's weekly status of one project (#2597): deterministic counts and task titles/comments in the member's own transaction
  // (never reading notes), then one metered model call outside it; refused when any number outside input appears.
  const projectWeeklyStatusCoworker = projectWeeklyStatusAi(
    conversationReader?.projectWeeklyStatus ? { projectWeeklyStatus: conversationReader.projectWeeklyStatus.bind(conversationReader) } : null,
    suggestionBudget(),
  );
  const signCoworker = signAi(
    signAiReader ?? null,
    new DraftBudget({ perUserPerMinute: 4, perOrgPerMinute: 20 }),
    new DraftBudget({ perUserPerMinute: 4, perOrgPerMinute: 20 }),
  );

  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw toORPCError(error);
    }
  };
  // Demo comments of the offline sandbox, by org, for the per-org cap on the intake they share.
  const sandboxStamps = new Map<string, number[]>();
  // Every model call a handler makes counts against the org's AI budget (@crove/agent's metered(), #2382): the scope names
  // the org and the meter that asks in this member's own authority.
  const inOrg = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) =>
    guard(async () => {
      const orgId = await resolveOrg(runtime, context.user, context.orgSlug);
      const actor = actorOf(context.user);
      return aiMeter ? withAiScope({ orgId, meter: aiMeter(actor) }, () => fn(orgId, actor)) : fn(orgId, actor);
    });
  // A model call refused because the org's AI budget of the month is spent: said as it is, so the Inbox and the panels
  // show "Vy đã hết ngân sách tháng này" and the owner knows what to do. Posting, reading and exports are unaffected.
  const refuseBudget = (error: unknown): void => {
    if (error instanceof AiBudgetExhaustedError) {
      throw new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Vy đã hết ngân sách tháng này; chủ tổ chức có thể nâng ngân sách hoặc đợi sang tháng mới. Sổ sách và mọi việc không cần AI vẫn chạy bình thường', {
        scope: error.scope,
        ...(error.retryAt ? { retryAt: error.retryAt } : {}),
      });
    }
  };
  // A procedure of a module this deployment leaves out (CROVE_MODULES, plan Decision 12) answers like a route that
  // does not exist, before any database work. The contract is shared, so the procedure stays in the router.
  const finance = runtime.installed('finance');
  // A command that takes an idempotency key: the key travels in the options, never in the command's input.
  const keyed = <O, I extends { idempotencyKey: string } = { idempotencyKey: string }>(context: RpcContext, name: string, input: I): Promise<O> =>
    inOrg(context, (orgId, actor) => {
      const { idempotencyKey, ...rest } = input;
      return runtime.execute<O>(name, rest, { actor, orgId, idempotencyKey });
    });
  const inFinance = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!finance) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun tài chính chưa được bật' });
    return inOrg(context, fn);
  };
  // The catalogue check and the name proposals it makes belong to a MISA connection of one product (#4152, #4124): the connector of THAT product must be on in this deployment, or the answer is the same 404 as for a
  // deployment without the connector. The connection is looked up here for its product; an id the org does not hold needs either product on, and the command then answers its own not found. Ids are compared without case.
  const requireMisaConnectorOf = async (actor: UserActor, orgId: string, connectionId: string) => {
    const rows = await runtime.query<MisaAmisConnection[]>('finance.misa_amis_connection.list', {}, { actor, orgId });
    const wanted = connectionId.toLowerCase();
    const product = rows.find((r) => r.id.toLowerCase() === wanted)?.product;
    if (!channels || !(product === 'asp' ? channels.misaAsp : product === 'amis' ? channels.misaAmis : channels.misaAmis || channels.misaAsp)) {
      throw new DomainError('MISA_AMIS_DISABLED', 404, product === 'asp' ? 'Bộ kết nối MISA ASP chưa được bật trên hệ thống này' : 'Bộ kết nối MISA AMIS chưa được bật trên hệ thống này');
    }
  };
  // Whether the seller authorizes this marketplace adapter on the platform's page (it then has an App Key beside its sealed secret).
  const isMarketplaceAuthorized = (id: string): boolean => (MARKETPLACE_AUTHORIZED_ADAPTERS as readonly string[]).includes(id);
  // The e-invoice provider this deployment offers under an adapter id (EINVOICE_SANDBOX and, later, one switch per real adapter), or nothing.
  const marketplaceProviderOf = (id: string): MarketplaceProvider | undefined => (Object.hasOwn(channels?.marketplaceProviders ?? {}, id) ? channels?.marketplaceProviders?.[id] : undefined);
  const einvoiceProviderOf = (id: string): EInvoiceProvider | undefined => (Object.hasOwn(channels?.einvoiceProviders ?? {}, id) ? channels?.einvoiceProviders?.[id] : undefined);
  // The commands check the role again; this answers first, in words, before anything is sealed or called.
  const requireOwnerOrAdmin = async (context: RpcContext, message: string) => {
    const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
    if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, message);
  };
  // The assisted tax portal sync (issue #325): the steps check the member's role again in their commands; the password
  // in login's input goes to the portal and nowhere else.
  const inPortalSync = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor, sync: PortalSync) => Promise<T>) =>
    inFinance(context, (orgId, actor) => {
      if (!portalSync) throw new DomainError('PORTAL_SYNC_DISABLED', 404, 'Chức năng lấy dữ liệu từ cổng thuế chưa được bật trên máy chủ này');
      return fn(orgId, actor, portalSync);
    });

  // The multi-client home screen reads up to four orgs at once, a transaction each, on the API's pool of ten
  // connections (#495): one screen per user at a time and two per process; another is refused at once (OVERLOADED).
  const clientScreens = new ConcurrencyLimiter({ total: 2, perKey: 1 });

  const social = runtime.installed('social');
  const inSocial = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!social) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun mạng xã hội chưa được bật' });
    return inOrg(context, fn);
  };
  // The command or query checks the input again and its answer has the contract's shape (oRPC validates it).
  const socialCommand =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inSocial(context, (orgId, actor) => runtime.execute<O>(name, input, { actor, orgId }));
  const socialQuery =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inSocial(context, (orgId, actor) => runtime.query<O>(name, input, { actor, orgId }));

  // The crm module (#1314): its procedures answer 404 when the deployment leaves it out, as Social's do.
  const crm = runtime.installed('crm');
  const inCrm = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!crm) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun CRM chưa được bật' });
    return inOrg(context, fn);
  };
  const crmCommand =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inCrm(context, (orgId, actor) => runtime.execute<O>(name, input, { actor, orgId }));

  // The notes module (#1671): its procedures answer 404 when the deployment leaves it out, as CRM's do.
  const notes = runtime.installed('notes');
  const inNotes = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!notes) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun Ghi chú chưa được bật' });
    return inOrg(context, fn);
  };
  const notesCommand =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inNotes(context, (orgId, actor) => runtime.execute<O>(name, input, { actor, orgId }));
  const notesQuery =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inNotes(context, (orgId, actor) => runtime.query<O>(name, input, { actor, orgId }));

  // The meetings module (#2576): its procedures answer 404 when the deployment leaves it out.
  const meetings = runtime.installed('meetings');
  const inMeetings = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!meetings) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun Cuộc họp chưa được bật' });
    return inOrg(context, fn);
  };
  // The minutes channels' API half (meeting-chat.ts): the credential broker seals (never opens); the worker job kernel-meeting-chat opens and posts.
  const minutesChat = (): MinutesChatDeps => {
    if (!channels) throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
    return { runtime, broker: channels.broker, publicUrl: channels.publicUrl ?? '', ...channels.minutes };
  };
  const meetingsCommand =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inMeetings(context, (orgId, actor) => runtime.execute<O>(name, input, { actor, orgId }));
  const meetingsQuery =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inMeetings(context, (orgId, actor) => runtime.query<O>(name, input, { actor, orgId }));
  // The HR module (#2530): its procedures answer 404 when the deployment leaves it out, as the notes module's do. Owners and admins only (the database's policy and
  // every command's and query's access); every read is a sensitive query.
  const hr = runtime.installed('hr');
  const inHr = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!hr) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun Nhân sự chưa được bật' });
    return inOrg(context, fn);
  };
  const hrCommand =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inHr(context, (orgId, actor) => runtime.execute<O>(name, input, { actor, orgId }));
  const payrollReads = (orgId: string, actor: UserActor): PayrollReads => ({
    authorize: () => runtime.query('hr.payroll.coworker.access', {}, { actor, orgId }),
    sheet: (runId) => runtime.query<HrRunSheet>('hr.payroll.run.sheet', { runId }, { actor, orgId }),
    runs: (legalEntityId) => runtime.query<HrRunSummary[]>('hr.payroll.run.list', { limit: 120, legalEntityId }, { actor, orgId }),
    payslip: (lineId) => runtime.query<HrPayslip>('hr.payroll.line.payslip', { lineId }, { actor, orgId }),
  });
  const laborCheckPorts = (orgId: string, actor: UserActor): LaborCheckPorts => ({
    read: (input) => runtime.query<HrLaborCheckSnapshot>('hr.payroll.labor_check.read', input, { actor, orgId }),
    record: (kind, checked) => runtime.execute('hr.payroll.labor_check.audit', { kind, checked }, { actor, orgId }),
  });
  const recruitingBriefPorts = (orgId: string, actor: UserActor): RecruitingBriefPorts => ({
    read: (candidateId, lang, includeNotes) =>
      runtime.query<HrRecruitingBriefSnapshot>('hr.recruiting.brief.read', { candidateId, lang, includeNotes }, { actor, orgId }),
    record: (candidateId, aiReason, includeNotes) =>
      runtime.execute('hr.recruiting.brief.audit', { candidateId, aiReason, includeNotes }, { actor, orgId }),
  });
  const hrQuery =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inHr(context, (orgId, actor) => runtime.query<O>(name, input, { actor, orgId }));
  // The projects module (#2591): its procedures answer 404 when the deployment leaves it out.
  const projects = runtime.installed('projects');
  const inProjects = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!projects) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun Dự án chưa được bật' });
    return inOrg(context, fn);
  };
  const projectsCommand =
    (name: string) =>
    <O, I extends { idempotencyKey: string } = { idempotencyKey: string }>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inProjects(context, (orgId, actor) => {
        const { idempotencyKey, ...rest } = input;
        return runtime.execute<O>(name, rest, { actor, orgId, idempotencyKey });
      });
  const projectsQuery =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inProjects(context, (orgId, actor) => runtime.query<O>(name, input, { actor, orgId }));

  // The eSign module (#3323, #3325, #3351): answers 404 when the deployment leaves it out, and send / create_link omit idempotency.
  const sign = runtime.installed('sign');
  const inSign = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!sign) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun Ký kết chưa được bật' });
    return inOrg(context, fn);
  };
  const signCommand =
    (name: string) =>
    <O, I extends { idempotencyKey?: string | undefined } = { idempotencyKey?: string | undefined }>({
      context,
      input,
    }: {
      context: RpcContext;
      input: I;
    }): Promise<O> =>
      inSign(context, (orgId, actor) => {
        const { idempotencyKey, ...rest } = input;
        return runtime.execute<O>(name, rest, { actor, orgId, ...(idempotencyKey ? { idempotencyKey } : {}) });
      });
  const signNoIdempotencyCommand =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inSign(context, (orgId, actor) => runtime.execute<O>(name, input, { actor, orgId }));
  const signQuery =
    (name: string) =>
    <I, O>({ context, input }: { context: RpcContext; input: I }): Promise<O> =>
      inSign(context, (orgId, actor) => runtime.query<O>(name, input, { actor, orgId }));

  // The ads module (#2217): its procedures answer 404 when the deployment leaves it out, as the notes module's do.
  const ads = runtime.installed('ads');
  // The proposal request an ads change makes (kernel.proposal.request): the command it would run once approved, and what that
  // command's preparer takes.
  const adsRequestOf = (change: AdsChangeRequest) => {
    switch (change.change) {
      case 'write_enable':
        return { command: 'ads.write.enable', input: {} };
      case 'account_enable':
        return { command: 'ads.account.enable_write', input: { adAccountId: change.adAccountId } };
      case 'cap_set':
        return {
          command: 'ads.cap.set',
          input: { scope: change.scope, ...(change.adAccountId ? { adAccountId: change.adAccountId } : {}), period: change.period, amount: change.amount, currency: change.currency },
        };
      case 'launches_unblock':
        return { command: 'ads.launches.unblock', input: {} };
      case 'campaign_launch':
        return { command: 'ads.campaign.launch', input: { draftId: change.draftId } };
      // What can start or raise spend on a running ad (#3835, W4): each asks through its own preparer, and the approval runs the command.
      case 'object_resume':
        return { command: 'ads.object.resume', input: { launchId: change.launchId, slot: change.slot } };
      case 'budget_raise':
        return { command: 'ads.budget.raise', input: { launchId: change.launchId, dailyBudget: change.dailyBudget } };
      case 'schedule_extend':
        return { command: 'ads.schedule.extend', input: { launchId: change.launchId, endOn: change.endOn } };
    }
  };
  const inAds = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor) => Promise<T>) => {
    if (!ads) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun Quảng cáo chưa được bật' });
    return inOrg(context, fn);
  };

  // The connector of an OAuth provider this deployment configured, for an owner or admin of the org in the header.
  // The commands check the role again; checking first keeps a member from learning how the deployment is set up.
  const oauthConnector = async (context: RpcContext, provider: string) => {
    const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
    if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
    // An ad platform (ADR-0040) connects only where the Ads module runs: its accounts are linked as the grant is finished.
    if (isAdProviderId(provider) && !runtime.installed('ads')) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Mô-đun Quảng cáo chưa được bật');
    // The write connection of an ad account (ADR-0043, W0b) is the owner's, and only while the org's switch is on: nobody is sent through
    // the platform's dialog for a token the org may not hold. The command that attaches it checks both again.
    if (isAdWriteProviderId(provider)) {
      if (role !== 'owner') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới kết nối được để chạy quảng cáo');
      const state = await runtime.query<{ writeEnabled: boolean }>('ads.write.state', {}, { actor: actorOf(context.user), orgId });
      if (!state.writeEnabled) throw new DomainError('ADS_WRITE_OFF', 409, 'Chủ sở hữu chưa bật việc chạy quảng cáo cho tổ chức này');
    }
    const connector = channels?.connectors?.[provider];
    if (!channels || !connector) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được cấu hình trên máy chủ');
    // Checked before an attempt is written or used up: without a key the tokens could never be sealed, and the user
    // would go through the provider's dialog for nothing.
    if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
    return { orgId, actor: actorOf(context.user), connector, broker: channels.broker };
  };
  const calendarRedirectUri = (provider: string) => `${(channels?.publicUrl ?? '').replace(/\/$/, '')}/calendar/oauth/${provider}/callback`;
  // The adapter of a calendar provider this deployment configured, for a member who edits (a viewer has no calendar of
  // their own to connect). The commands check the role again.
  const calendarAdapter = async (context: RpcContext, provider: string) => {
    const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
    if (role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Người xem không kết nối được lịch');
    const adapter = channels?.calendars?.[provider];
    if (!channels || !adapter) throw new DomainError('CALENDAR_PROVIDER_DISABLED', 404, 'Loại lịch này chưa được cấu hình trên máy chủ');
    // Checked before an attempt is written or used up: without a key the tokens could never be sealed.
    if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
    return { orgId, actor: actorOf(context.user), adapter, broker: channels.broker };
  };
  const meetingPlatformRedirectUri = (platform: string) => `${(channels?.publicUrl ?? '').replace(/\/$/, '')}/meetings/oauth/${platform}/callback`;
  // The adapter of a meeting platform this deployment configured and that has a connect dialog, for a member who edits (a viewer connects nothing). The commands check the role again.
  const meetingPlatformConnector = async (context: RpcContext, platform: string) => {
    const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
    if (role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Người xem không kết nối được nền tảng họp');
    const adapter = channels?.meetingPlatforms?.[platform];
    if (!channels || !hasOAuth(adapter)) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Nền tảng họp này chưa được cấu hình trên máy chủ');
    // Checked before an attempt is written or used up: without a key the tokens could never be sealed.
    if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
    return { orgId, actor: actorOf(context.user), adapter, broker: channels.broker };
  };
  // The org's team chat for Social alerts (#863): the target is checked with the platform and sealed here, then saved by
  // the command. The API never reads it back: a test line is only asked for, and the worker sends it.
  const chatAlertTests = new ChatAlertTestBudget();
  const chatAlertSaves = new ChatAlertSaveBudget();
  const chatAlertScope = async (context: RpcContext) => {
    if (!social) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun mạng xã hội chưa được bật' });
    const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
    return { orgId, actor: actorOf(context.user), role };
  };
  // Stock photos (#1106): members and above, in an org with Social, on a deployment with the key, within the budget;
  // the order makes every refusal happen before any call to Pexels.
  const stockScope = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor, stock: StockPhotos) => Promise<T>) => {
    if (!social) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun mạng xã hội chưa được bật' });
    return guard(async () => {
      const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
      const stock = channels?.stockPhotos;
      if (!stock) throw new DomainError('STOCK_PHOTOS_DISABLED', 404, 'Ảnh từ Pexels chưa được bật trên máy chủ này');
      if (role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Người xem không tìm hoặc lưu được ảnh vào thư viện');
      const actor = actorOf(context.user);
      const ticket = stock.budget.take(orgId, actor.userId);
      if (!ticket.allowed) throw new DomainError('RATE_LIMITED', 429, 'Bạn đã tìm hoặc lưu nhiều ảnh trong phút này, hãy thử lại sau ít phút', { retryAfterSeconds: ticket.retryAfterSeconds });
      return fn(orgId, actor, stock);
    });
  };
  // The CSV import's image URLs (#1258): members and above, in an org with Social; the budget is per URL, so each
  // refused one says so on its row.
  const mediaUrlScope = async <T>(context: RpcContext, fn: (orgId: string, actor: UserActor, urls: MediaUrls) => Promise<T>) => {
    if (!social) throw new ORPCError('NOT_FOUND', { status: 404, message: 'Mô-đun mạng xã hội chưa được bật' });
    return guard(async () => {
      const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
      if (role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Người xem không thêm được ảnh vào thư viện');
      const urls = channels?.mediaUrls;
      if (!urls) throw new DomainError('MEDIA_URLS_DISABLED', 404, 'Máy chủ này chưa tải ảnh từ đường dẫn');
      return fn(orgId, actorOf(context.user), urls);
    });
  };
  const oauthRedirectUri = (provider: string) => `${(channels?.publicUrl ?? '').replace(/\/$/, '')}/channels/oauth/${provider}/callback`;

  const router = os.router({
    me: {
      get: os.me.get.handler(({ context }) =>
        guard(async () => ({
          userId: context.user.userId,
          email: context.user.email,
          displayName: context.user.name,
          orgs: await runtime.forUser(actorOf(context.user), (db) => sessionOrgs(db, context.user.userId, context.user.sessionId ?? null)),
        })),
      ),
      // The multi-client home screen (issue #318): each org's figures are read in that org's own context.
      clients: os.me.clients.handler(({ context, signal }) =>
        guard(async () => {
          const release = clientScreens.tryAcquire(context.user.userId);
          if (!release) throw new DomainError('OVERLOADED', 503, 'Danh sách khách hàng đang được tải, hãy thử lại sau giây lát', { retryAfterSeconds: 2 });
          try {
            return await clientOverviews(runtime, actorOf(context.user), signal ? { signal } : {});
          } finally {
            release();
          }
        }),
      ),
    },
    today: {
      list: os.today.list.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.today', {}, { actor, orgId }))),
      // What each AI coworker prepared over the last day: counts of the member's readable activity rows (#3256), no model.
      sinceYesterday: os.today.sinceYesterday.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.since_yesterday', {}, { actor, orgId }))),
      // Vy's brief (#2383): written from the member's own list only (the same query, in their context), so it can say
      // nothing they could not see. No model, or the per-member AI rate limit: the plain template. The month's AI budget
      // spent: no brief, and Home shows the list alone. Nothing is stored.
      mail: {
        get: os.today.mail.get.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.today_mail.get', {}, { actor, orgId }))),
        set: os.today.mail.set.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.today_mail.set', input, { actor, orgId }))),
      },
      brief: os.today.brief.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          const { items } = await runtime.query<TodayList>('kernel.today', {}, { actor, orgId });
          return briefAnswer(items, input.language, vietnamToday(), socialWriter?.brief, () => briefs.take(orgId, actor.userId));
        }),
      ),
      // "Tuần này" (#3257): the figures of the last 7 days from the lines' reads in the member's own context, then Vy's sentences over them (numbers checked) or the template. Nothing is stored.
      weekly: os.today.weekly.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          const figures = await runtime.query<WeeklyFigures>(TODAY_WEEKLY_READ, {}, { actor, orgId });
          return weeklyAnswer(figures, input.language, socialWriter?.weekly, () => weeklies.take(orgId, actor.userId));
        }),
      ),
    },
    org: {
      create: os.org.create.handler(({ context, input }) =>
        guard(() => createOrg(runtime, actorOf(context.user), input.name, input.idempotencyKey)),
      ),
      get: os.org.get.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.org.get', {}, { actor, orgId }))),
      apps: os.org.apps.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.org.apps', {}, { actor, orgId }))),
      setApp: os.org.setApp.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_app', input, { actor, orgId }))),
      // The org's overview (#1249): the figures the multi-client home screen reads for each org, for this one.
      overview: os.org.overview.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.org.overview', {}, { actor, orgId }))),
      setTaxCode: os.org.setTaxCode.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_tax_code', input, { actor, orgId })),
      ),
      setVatFilingPeriod: os.org.setVatFilingPeriod.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_vat_filing_period', input, { actor, orgId })),
      ),
      setApprovalPreset: os.org.setApprovalPreset.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_approval_preset', input, { actor, orgId })),
      ),
      setAddress: os.org.setAddress.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_address', input, { actor, orgId })),
      ),
      setContactEmail: os.org.setContactEmail.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.org.set_contact_email', input, { actor, orgId })),
      ),
      proposalPolicy: os.org.proposalPolicy.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.proposal_policy.get', {}, { actor, orgId }))),
      setProposalPolicy: os.org.setProposalPolicy.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.proposal_policy.save', input, { actor, orgId })),
      ),
      taxProfile: os.org.taxProfile.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.tax_profile.get', {}, { actor, orgId }))),
      setTaxProfile: os.org.setTaxProfile.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.tax_profile.save', input, { actor, orgId }))),
      // The VAT return's done mark goes through finance when it is on (#1400): finance.vat.return_mark records the
      // return as filed, with Crove's own figures, and writes the same done mark in the same transaction, so the next
      // period's [22] has a [43] to start from.
      markTaxObligation: os.org.markTaxObligation.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          const { done, ...mark } = input;
          if (finance && mark.obligation === 'vat_return' && /^\d{4}-(\d{2}|Q\d)$/.test(mark.period)) {
            // Each legal entity files its own return (#1280 part 2b): the entity named, else the one resolved for the
            // caller, as on the VAT screen.
            await runtime.execute(
              'finance.vat.return_mark',
              { period: mark.period, done, ...(mark.legalEntityId !== undefined ? { legalEntityId: mark.legalEntityId } : {}) },
              { actor, orgId },
            );
            return { ...mark, done };
          }
          return runtime.execute(done ? 'kernel.tax_obligation.done' : 'kernel.tax_obligation.undo', mark, { actor, orgId });
        }),
      ),
      audit: os.org.audit.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.audit.list', input, { actor, orgId }))),
      auditCommands: os.org.auditCommands.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.audit.commands', {}, { actor, orgId }))),
      auditExport: os.org.auditExport.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.audit.export', input, { actor, orgId }))),
      // A command, not a query: every search leaves an audit row (#1678).
      personalData: os.org.personalData.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.personal_data.find', input, { actor, orgId }))),
      personalDataErase: os.org.personalDataErase.handler(({ context, input }) => keyed(context, 'kernel.personal_data.erase', input)),
      personalDataNotify: os.org.personalDataNotify.handler(({ context, input }) => keyed(context, 'kernel.personal_data.notify', input)),
      // No idempotency key: the answer carries the invite token, which must never be stored with a key. The mail
      // goes out after the command has committed (invite-mail.ts says why), unless the org stopped mail to the
      // address (#538); its outcome is recorded on the invite's mail_message row and never changes the answer, which
      // stays the same whether or not the email has an account.
      invite: os.org.invite.handler(({ context, input }) =>
        guard(async () => {
          const org = await resolveMembership(runtime, context.user, context.orgSlug);
          const actor = actorOf(context.user);
          const created = await runtime.execute<CreatedInvite>('kernel.member.invite.create', input, { actor, orgId: org.orgId });
          // The invite's mail row, as the command wrote it: no row, or a read that fails, sends nothing, since an
          // address the org stopped must never get mail; the inviter still has the link.
          const mail = await runtime
            .query<DirectMail | null>('kernel.mail.direct.get', { source: 'kernel.member.invite.create', sourceId: created.inviteId }, { actor, orgId: org.orgId })
            .catch((error: unknown) => {
              console.error(`[mail] invite mail not sent, its record was not read: ${error instanceof Error ? error.name : 'unknown error'}`);
              return null;
            });
          if (mail?.status === 'sending') {
            let delivery: Delivery | 'error' = 'off';
            let sent: DeliveryResult | undefined;
            try {
              sent = await sendInviteMail?.({
                  to: created.email,
                  orgName: org.name,
                  inviterName: context.user.name,
                  inviterEmail: context.user.email,
                  role: created.role,
                  expiresAt: created.expiresAt,
                  acceptPath: created.acceptPath,
                  messageId: mail.messageIdHeader,
                  bounceToken: mail.bounceToken,
                });
              delivery = sent?.status ?? 'off';
            } catch (error) {
              delivery = 'error';
              console.error(`[mail] invite mail not sent: ${error instanceof Error ? error.name : 'unknown error'}`);
            }
            const outcome = delivery === 'sent' ? { outcome: 'sent' as const } : { outcome: 'failed' as const, errorCode: DELIVERY_ERROR[delivery] };
            const provider = sent && delivery !== 'off' ? { provider: sent.provider, ...(sent.providerMessageId ? { providerMessageId: sent.providerMessageId } : {}) } : {};
            await runtime.execute('kernel.mail.record_direct', { messageId: mail.messageId, ...outcome, ...provider }, { actor, orgId: org.orgId }).catch((error: unknown) => {
              console.error(`[mail] invite mail outcome not recorded: ${error instanceof Error ? error.name : 'unknown error'}`);
            });
          }
          return created;
        }),
      ),
      listInvites: os.org.listInvites.handler(({ context }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.member.invites.list', {}, { actor, orgId })),
      ),
      revokeInvite: os.org.revokeInvite.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.member.invite.revoke', input, { actor, orgId })),
      ),
      rotateInbound: os.org.rotateInbound.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          await runtime.execute('kernel.inbound.rotate', {}, { actor, orgId, idempotencyKey: input.idempotencyKey });
          // The current address, not the token stored with the idempotency key: a key replayed after a later
          // rotation must never show a retired address.
          const org = await runtime.query<{ inboundAddress: string | null }>('kernel.org.get', {}, { actor, orgId });
          return { inboundAddress: org.inboundAddress };
        }),
      ),
      issueConversationAddress: os.org.issueConversationAddress.handler(({ context }) =>
        inOrg(context, async (orgId, actor) => {
          await runtime.execute('kernel.conversation.address_issue', {}, { actor, orgId });
          const org = await runtime.query<{ conversationAddress: string | null }>('kernel.org.get', {}, { actor, orgId });
          return { conversationAddress: org.conversationAddress ?? null };
        }),
      ),
      rotateConversationAddress: os.org.rotateConversationAddress.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          await runtime.execute('kernel.conversation.address_rotate', {}, { actor, orgId, idempotencyKey: input.idempotencyKey });
          // The current address, not a stored result: a key replayed after a later rotation must never show a retired address.
          const org = await runtime.query<{ conversationAddress: string | null }>('kernel.org.get', {}, { actor, orgId });
          return { conversationAddress: org.conversationAddress ?? null };
        }),
      ),
      changeMemberRole: os.org.changeMemberRole.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.member.change_role', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      removeMember: os.org.removeMember.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.member.remove', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      memberRoles: os.org.memberRoles.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.member.roles.list', {}, { actor, orgId }))),
      assignRole: os.org.assignRole.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.member.role.assign', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      revokeRole: os.org.revokeRole.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.member.role.revoke', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      offboard: os.org.offboard.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.org.offboard', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      export: os.org.export.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.org.export.get', {}, { actor, orgId }))),
    },
    hr: {
      departments: {
        list: os.hr.departments.list.handler(hrQuery('hr.department.list')),
        add: os.hr.departments.add.handler(hrCommand('hr.department.add')),
        edit: os.hr.departments.edit.handler(hrCommand('hr.department.edit')),
        archive: os.hr.departments.archive.handler(hrCommand('hr.department.archive')),
      },
      employee: {
        contractPdf: os.hr.employee.contractPdf.handler(hrQuery('hr.employee.contract_pdf')),
      },
      payroll: {
        employees: {
          list: os.hr.payroll.employees.list.handler(hrQuery('hr.payroll.employee.list')),
          get: os.hr.payroll.employees.get.handler(hrQuery('hr.payroll.employee.get')),
          add: os.hr.payroll.employees.add.handler(hrCommand('hr.payroll.employee.add')),
          edit: os.hr.payroll.employees.edit.handler(hrCommand('hr.payroll.employee.edit')),
          finalization: os.hr.payroll.employees.finalization.handler(hrCommand('hr.payroll.employee.finalization.set')),
          end: os.hr.payroll.employees.end.handler(hrCommand('hr.payroll.employee.end')),
          erase: os.hr.payroll.employees.erase.handler(hrCommand('hr.payroll.employee.erase')),
          severance: os.hr.payroll.employees.severance.handler(hrQuery('hr.payroll.employee.severance')),
        },
        bankTemplates: {
          list: os.hr.payroll.bankTemplates.list.handler(hrQuery('hr.payroll.bank_template.list')),
          create: os.hr.payroll.bankTemplates.create.handler(hrCommand('hr.payroll.bank_template.create')),
          edit: os.hr.payroll.bankTemplates.edit.handler(hrCommand('hr.payroll.bank_template.edit')),
          delete: os.hr.payroll.bankTemplates.delete.handler(hrCommand('hr.payroll.bank_template.delete')),
        },
        laborCheck: os.hr.payroll.laborCheck.handler(({ context, input }) =>
          inHr(context, (orgId, actor) => checkLaborReadiness(laborCheckAi, laborCheckPorts(orgId, actor), orgId, actor.userId, input)),
        ),
        employments: { add: os.hr.payroll.employments.add.handler(hrCommand('hr.payroll.employment.add')) },
        dependents: {
          add: os.hr.payroll.dependents.add.handler(hrCommand('hr.payroll.dependent.add')),
          end: os.hr.payroll.dependents.end.handler(hrCommand('hr.payroll.dependent.end')),
        },
        runs: {
          list: os.hr.payroll.runs.list.handler(hrQuery('hr.payroll.run.list')),
          sheet: os.hr.payroll.runs.sheet.handler(hrQuery('hr.payroll.run.sheet')),
          open: os.hr.payroll.runs.open.handler(hrCommand('hr.payroll.run.open')),
          recalculate: os.hr.payroll.runs.recalculate.handler(hrCommand('hr.payroll.run.recalculate')),
          importTimekeeping: os.hr.payroll.runs.importTimekeeping.handler(hrCommand('hr.payroll.run.import_timekeeping')),
          thirteenthMonthPreview: os.hr.payroll.runs.thirteenthMonthPreview.handler(hrQuery('hr.payroll.run.thirteenth_month_preview')),
          applyThirteenthMonth: os.hr.payroll.runs.applyThirteenthMonth.handler(hrCommand('hr.payroll.run.apply_thirteenth_month')),
          syncLeave: os.hr.payroll.runs.syncLeave.handler(hrCommand('hr.payroll.run.sync_leave')),
          approve: os.hr.payroll.runs.approve.handler(hrCommand('hr.payroll.run.approve')),
        },
        leave: {
          balance: os.hr.payroll.leave.balance.handler(hrQuery('hr.payroll.leave.balance')),
          set: os.hr.payroll.leave.set.handler(hrCommand('hr.payroll.leave.set')),
          delete: os.hr.payroll.leave.delete.handler(hrCommand('hr.payroll.leave.delete')),
        },
        // Where the posting and the payments of an approved month stand (#2532): finance reads its own books and the open proposals; owners and admins.
        settlement: os.hr.payroll.settlement.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.payroll.settlement', input, { actor, orgId }))),
        lines: {
          setInputs: os.hr.payroll.lines.setInputs.handler(hrCommand('hr.payroll.line.inputs.set')),
          adjust: os.hr.payroll.lines.adjust.handler(hrCommand('hr.payroll.line.adjust')),
          payslip: os.hr.payroll.lines.payslip.handler(hrQuery('hr.payroll.line.payslip')),
        },
        // The coworker's part (#2534): the stored run is read through the audited sensitive queries in the member's own authority, then the model is asked outside any transaction.
        coworker: {
          prepare: os.hr.payroll.coworker.prepare.handler(({ context, input }) => inHr(context, (orgId, actor) => prepareMonth(payrollAi, payrollReads(orgId, actor), orgId, actor.userId, input.runId, input.lang ?? 'vi'))),
          flag: os.hr.payroll.coworker.flag.handler(({ context, input }) => inHr(context, (orgId, actor) => flagMonth(payrollAi, payrollReads(orgId, actor), orgId, actor.userId, input.runId, input.lang ?? 'vi'))),
          explain: os.hr.payroll.coworker.explain.handler(({ context, input }) => inHr(context, (orgId, actor) => explainPayslip(payrollAi, payrollReads(orgId, actor), orgId, actor.userId, input.lineId, input.lang ?? 'vi'))),
        },
      },
      recruiting: {
        openings: {
          list: os.hr.recruiting.openings.list.handler(hrQuery('hr.recruiting.opening.list')),
          add: os.hr.recruiting.openings.add.handler(hrCommand('hr.recruiting.opening.add')),
          edit: os.hr.recruiting.openings.edit.handler(hrCommand('hr.recruiting.opening.edit')),
          close: os.hr.recruiting.openings.close.handler(hrCommand('hr.recruiting.opening.close')),
        },
        candidates: {
          list: os.hr.recruiting.candidates.list.handler(hrQuery('hr.recruiting.candidate.list')),
          get: os.hr.recruiting.candidates.get.handler(hrQuery('hr.recruiting.candidate.get')),
          add: os.hr.recruiting.candidates.add.handler(hrCommand('hr.recruiting.candidate.add')),
          edit: os.hr.recruiting.candidates.edit.handler(hrCommand('hr.recruiting.candidate.edit')),
          moveStage: os.hr.recruiting.candidates.moveStage.handler(hrCommand('hr.recruiting.candidate.move_stage')),
          scheduleInterview: os.hr.recruiting.candidates.scheduleInterview.handler(hrCommand('hr.recruiting.candidate.schedule_interview')),
          hire: os.hr.recruiting.candidates.hire.handler(hrCommand('hr.recruiting.candidate.hire')),
          erase: os.hr.recruiting.candidates.erase.handler(hrCommand('hr.recruiting.candidate.erase')),
        },
        interviewSlots: os.hr.recruiting.interviewSlots.handler(hrQuery('hr.recruiting.interview_slots')),
        brief: os.hr.recruiting.brief.handler(({ context, input }) =>
          inHr(context, (orgId, actor) => generateRecruitingBrief(recruitingBriefAi, recruitingBriefPorts(orgId, actor), orgId, actor.userId, input)),
        ),
      },
    },
    notes: {
      list: os.notes.list.handler(notesQuery('notes.note.list')),
      get: os.notes.get.handler(notesQuery('notes.note.get')),
      backlinks: os.notes.backlinks.handler(notesQuery('notes.note.backlinks')),
      search: os.notes.search.handler(notesQuery('notes.note.search')),
      panel: os.notes.panel.handler(notesQuery('notes.record.panel')),
      create: os.notes.create.handler(notesCommand('notes.note.create')),
      clip: os.notes.clip.handler(notesCommand('notes.note.clip')),
      fromMeetingSummary: os.notes.fromMeetingSummary.handler(({ context, input }) =>
        inNotes(context, (orgId, actor) => saveMeetingSummaryAsNote(runtime, orgId, actor, input)),
      ),
      update: os.notes.update.handler(notesCommand('notes.note.update')),
      versions: os.notes.versions.handler(notesQuery('notes.note.versions')),
      restoreVersion: os.notes.restoreVersion.handler(notesCommand('notes.note.restore_version')),
      setVisibility: os.notes.setVisibility.handler(notesCommand('notes.note.set_visibility')),
      pin: os.notes.pin.handler(notesCommand('notes.note.pin')),
      unpin: os.notes.unpin.handler(notesCommand('notes.note.unpin')),
      archive: os.notes.archive.handler(notesCommand('notes.note.archive')),
      restore: os.notes.restore.handler(notesCommand('notes.note.restore')),
      delete: os.notes.delete.handler(notesCommand('notes.note.delete')),
      linkAdd: os.notes.linkAdd.handler(notesCommand('notes.link.add')),
      linkRemove: os.notes.linkRemove.handler(notesCommand('notes.link.remove')),
      attachments: {
        list: os.notes.attachments.list.handler(notesQuery('notes.attachment.list')),
        delete: os.notes.attachments.delete.handler(notesCommand('notes.attachment.delete')),
      },
      notebooks: {
        list: os.notes.notebooks.list.handler(notesQuery('notes.notebook.list')),
        create: os.notes.notebooks.create.handler(notesCommand('notes.notebook.create')),
        update: os.notes.notebooks.update.handler(notesCommand('notes.notebook.update')),
        delete: os.notes.notebooks.delete.handler(notesCommand('notes.notebook.delete')),
      },
      privateCounts: os.notes.privateCounts.handler(notesQuery('notes.private_counts')),
      exportMine: os.notes.exportMine.handler(notesQuery('notes.mine.export')),
      vyStatus: os.notes.vyStatus.handler(({ context }) =>
        inNotes(context, (orgId, actor) => notesVyStatusOf({ runtime, model: summaryModel, meter: aiMeter ?? (() => null) }, orgId, actor)),
      ),
      summarize: os.notes.summarize.handler(({ context, input }) =>
        inNotes(context, (orgId, actor) =>
          runNotesSummarize({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: noteSummaryBudget }, orgId, actor, input),
        ),
      ),
      suggestTodos: os.notes.suggestTodos.handler(({ context, input }) =>
        inNotes(context, (orgId, actor) =>
          runNotesSuggestTodos({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: noteSuggestBudget }, orgId, actor, input),
        ),
      ),
      vyResults: os.notes.vyResults.handler(({ context, input }) =>
        inNotes(context, (orgId, actor) => readNotesVyResults({ runtime }, orgId, actor, input.noteId)),
      ),
      acceptSummary: os.notes.acceptSummary.handler(notesCommand('notes.note.accept_summary')),
      templates: {
        list: os.notes.templates.list.handler(notesQuery('notes.template.list')),
        create: os.notes.templates.create.handler(notesCommand('notes.template.create')),
        update: os.notes.templates.update.handler(notesCommand('notes.template.update')),
        delete: os.notes.templates.delete.handler(notesCommand('notes.template.delete')),
      },
      // A member's own to-dos (#1673).
      todos: {
        list: os.notes.todos.list.handler(notesQuery('notes.todo.list')),
        get: os.notes.todos.get.handler(notesQuery('notes.todo.get')),
        create: os.notes.todos.create.handler(notesCommand('notes.todo.create')),
        quickCapture: os.notes.todos.quickCapture.handler(notesCommand('notes.todo.quick_capture')),
        acceptSuggestions: os.notes.todos.acceptSuggestions.handler(notesCommand('notes.todo.accept_suggestions')),
        update: os.notes.todos.update.handler(notesCommand('notes.todo.update')),
        complete: os.notes.todos.complete.handler(notesCommand('notes.todo.complete')),
        reopen: os.notes.todos.reopen.handler(notesCommand('notes.todo.reopen')),
        reorder: os.notes.todos.reorder.handler(notesCommand('notes.todo.reorder')),
        reschedule: os.notes.todos.reschedule.handler(notesCommand('notes.todo.reschedule')),
        delete: os.notes.todos.delete.handler(notesCommand('notes.todo.delete')),
        restore: os.notes.todos.restore.handler(notesCommand('notes.todo.restore')),
        linkAdd: os.notes.todos.linkAdd.handler(notesCommand('notes.todo.link_add')),
        linkRemove: os.notes.todos.linkRemove.handler(notesCommand('notes.todo.link_remove')),
        handOver: os.notes.todos.handOver.handler(notesCommand('notes.todo.hand_over')),
        myWork: os.notes.todos.myWork.handler(notesQuery('notes.my_work')),
        counts: os.notes.todos.counts.handler(notesQuery('notes.todo.counts')),
        lists: {
          list: os.notes.todos.lists.list.handler(notesQuery('notes.todo_list.list')),
          create: os.notes.todos.lists.create.handler(notesCommand('notes.todo_list.create')),
          update: os.notes.todos.lists.update.handler(notesCommand('notes.todo_list.update')),
          delete: os.notes.todos.lists.delete.handler(notesCommand('notes.todo_list.delete')),
        },
      },
    },
    meetings: {
      list: os.meetings.list.handler(meetingsQuery('meetings.meeting.list')),
      get: os.meetings.get.handler(meetingsQuery('meetings.meeting.get')),
      extensionStatus: os.meetings.extensionStatus.handler(meetingsQuery('meetings.meeting.extension_status')),
      recordingStopped: os.meetings.recordingStopped.handler(meetingsCommand('meetings.meeting.recording_stopped')),
      recordingNow: os.meetings.recordingNow.handler(meetingsQuery('meetings.meeting.recording_now')),
      create: os.meetings.create.handler(meetingsCommand('meetings.meeting.create')),
      importStart: os.meetings.importStart.handler(meetingsCommand('meetings.import.start')),
      importDiscardEmpty: os.meetings.importDiscardEmpty.handler(meetingsCommand('meetings.import.discard_empty')),
      setTemplate: os.meetings.setTemplate.handler(meetingsCommand('meetings.minutes.set_template')),
      rename: os.meetings.rename.handler(meetingsCommand('meetings.meeting.rename')),
      delete: os.meetings.delete.handler(meetingsCommand('meetings.meeting.delete')),
      ownerDelete: os.meetings.ownerDelete.handler(meetingsCommand('meetings.meeting.owner_delete')),
      ownerList: os.meetings.ownerList.handler(meetingsCommand('meetings.meeting.owner_list')),
      // The recorder's live notes pane (L4a-2, #3110): the poll, the tick that copies a finished window and starts the next, and the two buttons.
      liveStatus: os.meetings.liveStatus.handler(meetingsQuery('meetings.live.status')),
      liveStart: os.meetings.liveStart.handler(meetingsCommand('meetings.live.start')),
      liveTick: os.meetings.liveTick.handler(meetingsCommand('meetings.live.tick')),
      liveStop: os.meetings.liveStop.handler(meetingsCommand('meetings.live.stop')),
      // The running notes, from the new lines and the previous notes only (the same stage A shape as the summary, see member-vy-ports.ts).
      liveNotes: os.meetings.liveNotes.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runLiveNotes({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: summaries }, orgId, actor, input.meetingId)),
      ),
      followup: {
        draft: os.meetings.followup.draft.handler(meetingsQuery('meetings.followup.draft')),
        // The wording is asked of the model outside any transaction, from the language and sender the draft read in the recorder's own one (recorder only, a published summary).
        wording: os.meetings.followup.wording.handler(({ context, input }) =>
          inMeetings(context, async (orgId, actor) => {
            const draft = await runtime.query<FollowupDraft>('meetings.followup.draft', { meetingId: input.meetingId }, { actor, orgId });
            return wordFollowup(followupAi, orgId, actor.userId, { lang: draft.lang, org: draft.org }, input.hint);
          }),
        ),
        // A send runs once per idempotency key: a double click or a retry gets the first answer, never a second mail.
        send: os.meetings.followup.send.handler(({ context, input }) => inMeetings(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('meetings.followup.send', rest, { actor, orgId, idempotencyKey });
        })),
      },
      // Minutes to a Slack or Teams channel (B4, #3168). The API only seals the pasted address and queues the recorder's click; the worker job (kernel-meeting-chat) opens the sealed address and posts (ADR-0025).
      chat: {
        channels: os.meetings.chat.channels.handler(meetingsQuery('meetings.chat.channels')),
        saveChannel: os.meetings.chat.saveChannel.handler(({ context, input }) => inMeetings(context, (orgId, actor) => saveMinutesChannel(minutesChat(), { orgId, orgSlug: context.orgSlug, actor }, input))),
        removeChannel: os.meetings.chat.removeChannel.handler(meetingsCommand('meetings.chat.channel_remove')),
        status: os.meetings.chat.status.handler(meetingsQuery('meetings.chat.status')),
        preview: os.meetings.chat.preview.handler(({ context, input }) =>
          inMeetings(context, async (orgId, actor) => {
            const view = await runtime.query<ChatPreview>('meetings.chat.preview', input, { actor, orgId });
            return { ...view, link: minutesLink(channels?.publicUrl ?? '', context.orgSlug, input.meetingId) };
          }),
        ),
        post: os.meetings.chat.post.handler(({ context, input }) => inMeetings(context, (orgId, actor) => postMinutesFromClick(minutesChat(), { orgId, orgSlug: context.orgSlug, actor }, input))),
      },
      links: {
        add: os.meetings.links.add.handler(meetingsCommand('meetings.link.add')),
        remove: os.meetings.links.remove.handler(meetingsCommand('meetings.link.remove')),
        list: os.meetings.links.list.handler(meetingsQuery('meetings.link.list')),
        byTarget: os.meetings.links.byTarget.handler(meetingsQuery('meetings.link.by_target')),
        suggest: os.meetings.links.suggest.handler(meetingsQuery('meetings.link.suggest')),
      },
      template: {
        list: os.meetings.template.list.handler(meetingsQuery('meetings.template.list')),
        create: os.meetings.template.create.handler(meetingsCommand('meetings.template.create')),
        update: os.meetings.template.update.handler(meetingsCommand('meetings.template.update')),
        archive: os.meetings.template.archive.handler(meetingsCommand('meetings.template.archive')),
      },
      glossary: {
        list: os.meetings.glossary.list.handler(meetingsQuery('meetings.glossary.list')),
        add: os.meetings.glossary.add.handler(meetingsCommand('meetings.glossary.add')),
        update: os.meetings.glossary.update.handler(meetingsCommand('meetings.glossary.update')),
        remove: os.meetings.glossary.remove.handler(meetingsCommand('meetings.glossary.remove')),
      },
      settings: {
        get: os.meetings.settings.get.handler(meetingsQuery('meetings.settings.get')),
        set: os.meetings.settings.set.handler(meetingsCommand('meetings.settings.set')),
      },
      consentPolicy: {
        get: os.meetings.consentPolicy.get.handler(meetingsQuery('meetings.consent_policy.get')),
        set: os.meetings.consentPolicy.set.handler(meetingsCommand('meetings.consent_policy.set')),
      },
      search: os.meetings.search.handler(meetingsQuery('meetings.search')),
      transcript: {
        get: os.meetings.transcript.get.handler(meetingsQuery('meetings.transcript.get')),
        draftStore: os.meetings.transcript.draftStore.handler(meetingsCommand('meetings.transcript.draft_store')),
        correct: os.meetings.transcript.correct.handler(meetingsCommand('meetings.transcript.correct')),
        start: os.meetings.transcript.start.handler(meetingsCommand('meetings.transcript.start')),
        cancel: os.meetings.transcript.cancel.handler(meetingsCommand('meetings.transcript.cancel')),
        status: os.meetings.transcript.status.handler(meetingsQuery('meetings.transcript.status')),
        copyResult: os.meetings.transcript.copyResult.handler(meetingsCommand('meetings.transcript.copy_result')),
      },
      // A member's own webhook for the minutes they publish (A6, #3164): the secret is made and sealed here, and only the person who asked sees it, once.
      hook: {
        get: os.meetings.hook.get.handler(({ context }) =>
          inOrg(context, async (orgId, actor) => {
            const state = await runtime.query<{ switchOn: boolean; hook: MeetingHookView | null }>('meetings.hook.get', {}, { actor, orgId });
            return { ...state, sealing: Boolean(channels?.broker) && channels?.broker.id !== 'none' };
          }),
        ),
        set: os.meetings.hook.set.handler(({ context, input }) =>
          inOrg(context, async (orgId, actor) => {
            const broker = channels?.broker;
            if (!broker || broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
            if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới cài được địa chỉ nhận biên bản');
            // The command checks again; looking the name up first keeps a member from learning how the deployment resolves names for an address that is refused anyway.
            await assertWakeHostPublic(input.url, channels?.wakeResolve);
            const made = makeHookSecret(broker, orgId, actor.userId);
            const done = await runtime.execute<{ created: boolean }>('meetings.hook.set', { ...input, credential: made.credential }, { actor, orgId });
            const state = await runtime.query<{ switchOn: boolean; hook: MeetingHookView | null }>('meetings.hook.get', {}, { actor, orgId });
            if (!state.hook) throw new DomainError('MEETING_HOOK_NOT_FOUND', 404, 'Bạn chưa có địa chỉ nhận biên bản');
            // The secret goes back only when this call made the webhook; a change to an existing one leaves its secret alone and the one made here is dropped.
            return { ...state.hook, secret: done.created ? made.secret : null };
          }),
        ),
        rotateSecret: os.meetings.hook.rotateSecret.handler(({ context }) =>
          inOrg(context, async (orgId, actor) => {
            const broker = channels?.broker;
            if (!broker || broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
            if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới đổi được khóa bí mật');
            const made = makeHookSecret(broker, orgId, actor.userId);
            await runtime.execute('meetings.hook.rotate_secret', { credential: made.credential }, { actor, orgId });
            const state = await runtime.query<{ switchOn: boolean; hook: MeetingHookView | null }>('meetings.hook.get', {}, { actor, orgId });
            if (!state.hook) throw new DomainError('MEETING_HOOK_NOT_FOUND', 404, 'Bạn chưa có địa chỉ nhận biên bản');
            return { ...state.hook, secret: made.secret };
          }),
        ),
        clear: os.meetings.hook.clear.handler(meetingsCommand('meetings.hook.clear')),
        test: os.meetings.hook.test.handler(meetingsCommand('meetings.hook.test')),
        switch: os.meetings.hook.switch.handler(meetingsCommand('meetings.hooks.switch.set')),
      },
      results: {
        get: os.meetings.results.get.handler(meetingsQuery('meetings.result.get')),
        saveSummary: os.meetings.results.saveSummary.handler(meetingsCommand('meetings.summary.save')),
        publish: os.meetings.results.publish.handler(meetingsCommand('meetings.result.publish')),
        copySummary: os.meetings.results.copySummary.handler(meetingsCommand('meetings.summary.copy_result')),
        review: os.meetings.results.review.handler(meetingsCommand('meetings.draft.review')),
        summaryStatus: os.meetings.results.summaryStatus.handler(meetingsQuery('meetings.summary.status')),
        // The recorder's Vy summarizing the meeting (#2580, M6 part B2): the first interactive stage A run; see meetings-summary.ts.
        summarize: os.meetings.results.summarize.handler(({ context, input }) =>
          inOrg(context, (orgId, actor) => runMeetingSummary({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: summaries }, orgId, actor, input.meetingId)),
        ),
        // The recorder's rough notes and Vy's expansion of them (A5, #3163): the same run family, budget and checks as the summary; see member-vy-ports.ts.
        notesGet: os.meetings.results.notesGet.handler(meetingsQuery('meetings.notes.get')),
        notesSave: os.meetings.results.notesSave.handler(meetingsCommand('meetings.notes.save')),
        // The table of contents of a meeting (#3844).
        chaptersGet: os.meetings.results.chaptersGet.handler(meetingsQuery('meetings.chapters.get')),
        chaptersSave: os.meetings.results.chaptersSave.handler(meetingsCommand('meetings.chapters.save')),
        chaptersStatus: os.meetings.results.chaptersStatus.handler(meetingsQuery('meetings.chapters.status')),
        chaptersCopy: os.meetings.results.chaptersCopy.handler(meetingsCommand('meetings.chapters.copy_result')),
        chaptersRun: os.meetings.results.chaptersRun.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => runMeetingChapters({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: summaries }, orgId, actor, input.meetingId)),
        ),
        enhance: os.meetings.results.enhance.handler(({ context, input }) =>
          inOrg(context, (orgId, actor) => runNotesEnhance({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: summaries }, orgId, actor, input.meetingId)),
        ),
        enhancePreview: os.meetings.results.enhancePreview.handler(meetingsQuery('meetings.notes.preview')),
        // Speaker names (#3502): what the recorder's Vy suggested, and the recorder's click that applies one; see modules/meetings/src/summary.ts.
        speakerSuggestions: os.meetings.results.speakerSuggestions.handler(meetingsQuery('meetings.speaker.suggestions')),
        nameSpeaker: os.meetings.results.nameSpeaker.handler(meetingsCommand('meetings.speaker.name')),
      },
      // The machine translation of the summary the member reads (meetings integrations E1, #3184): the member's own Vy, the answer theirs alone; see member-vy-ports.ts.
      translation: {
        status: os.meetings.translation.status.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => translationStatusOf({ runtime, price: aiPrice }, orgId, actor, input.meetingId, input.stage, input.to)),
        ),
        translate: os.meetings.translation.translate.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => runMeetingTranslation({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: translations, price: aiPrice }, orgId, actor, input.meetingId, input.stage, input.to)),
        ),
        get: os.meetings.translation.get.handler(meetingsQuery('meetings.translation.get')),
        // The transcript (E2, #3185): the member's own Vy translates the next batch of the lines they read, in the request; the page asks again while it is open.
        transcriptStatus: os.meetings.translation.transcriptStatus.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => transcriptTranslationStatusOf({ runtime, price: aiPrice, hasModel: summaryModel !== null }, orgId, actor, input.meetingId, input.to)),
        ),
        transcriptTranslate: os.meetings.translation.transcriptTranslate.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => runTranscriptTranslation({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: transcriptTranslations, price: aiPrice }, orgId, actor, input.meetingId, input.to)),
        ),
        transcriptStop: os.meetings.translation.transcriptStop.handler(meetingsCommand('meetings.translation.transcript_stop')),
        transcriptGet: os.meetings.translation.transcriptGet.handler(meetingsQuery('meetings.translation.transcript_get')),
      },
      // Ask across meetings (A3, #3161): the member's own Vy answers from the lines the member's own search finds, each sentence with a citation to a transcript line; nothing is stored or sent;
      // see member-vy-ports.ts.
      ask: {
        status: os.meetings.ask.status.handler(({ context }) => inMeetings(context, (orgId, actor) => askStatusOf({ runtime, price: aiPrice, model: summaryModel, meter: aiMeter ?? (() => null) }, orgId, actor))),
        ask: os.meetings.ask.ask.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => runMeetingAsk({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: asks, price: aiPrice }, orgId, actor, input.question)),
        ),
      },
      // Vy's brief before a meeting (#3543): the facts are read as the member (no model); the click has the member's own Vy write two or three sentences from them, each citing facts, and a sentence whose figure no
      // cited fact writes is refused; nothing is stored or sent. See member-vy-ports.ts.
      brief: {
        facts: os.meetings.brief.facts.handler(meetingsQuery('meetings.brief.facts')),
        status: os.meetings.brief.status.handler(({ context }) => inMeetings(context, (orgId, actor) => briefStatusOf({ runtime, price: aiPrice, model: summaryModel, meter: aiMeter ?? (() => null) }, orgId, actor))),
        write: os.meetings.brief.write.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => runMeetingBrief({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: meetingBriefs, price: aiPrice }, orgId, actor, input)),
        ),
      },
      // The recorder's Vy suggesting a title from the transcript (#3947): `status` feeds the button, `suggest` runs the recorder's own Vy once and returns up to three checked candidates to the browser; nothing
      // is stored. The pick is `rename`. See member-vy-ports.ts.
      title: {
        status: os.meetings.title.status.handler(meetingsQuery('meetings.title.status')),
        suggest: os.meetings.title.suggest.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => runMeetingTitle({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: summaries }, orgId, actor, input.meetingId)),
        ),
      },
      // What each speaker committed to or decided (#3954): `status` feeds the button, `list` runs the recorder's own Vy once and returns the checked lines, grouped by speaker, to the browser; nothing is stored,
      // published or made a task. See member-vy-ports.ts.
      commitments: {
        status: os.meetings.commitments.status.handler(meetingsQuery('meetings.commitments.status')),
        list: os.meetings.commitments.list.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => runMeetingCommitments({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: summaries }, orgId, actor, input.meetingId)),
        ),
      },
      // This week's decisions and what is still open, across the meetings the member reads (#3949): the facts are read as the member (no model); the click has the member's own Vy write two or three sentences from
      // them, each citing facts, and a sentence whose figure no cited fact writes is refused; nothing is stored or sent. See member-vy-ports.ts.
      digest: {
        facts: os.meetings.digest.facts.handler(meetingsQuery('meetings.digest.facts')),
        status: os.meetings.digest.status.handler(({ context }) => inMeetings(context, (orgId, actor) => digestStatusOf({ runtime, price: aiPrice, model: summaryModel, meter: aiMeter ?? (() => null) }, orgId, actor))),
        recap: os.meetings.digest.recap.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => runMeetingDigest({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: meetingDigests, price: aiPrice }, orgId, actor, input)),
        ),
      },
      // Who an action item belongs to, by Vy, when code found nobody (#3921, step 2): the click has the member's own Vy pick one of the people the member may give the work to from the said name, or nobody; the model
      // sees names only and nothing is stored. See member-vy-ports.ts.
      assignee: {
        status: os.meetings.assignee.status.handler(({ context }) => inMeetings(context, (orgId, actor) => assigneeStatusOf({ runtime, model: summaryModel, meter: aiMeter ?? (() => null) }, orgId, actor))),
        suggest: os.meetings.assignee.suggest.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => runMeetingAssignee({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: meetingAssignees, price: aiPrice }, orgId, actor, input)),
        ),
      },
      // The Today view (#3955): the member's own agenda for today with the facts of each event's brief, read as the member in one call (no model, nothing in the background); see modules/meetings/src/today.ts.
      today: {
        facts: os.meetings.today.facts.handler(meetingsQuery('meetings.today.facts')),
      },
      // The opt-in morning notice of the day's meetings (#3955, part B): the member's own setting; see modules/meetings/src/morning.ts.
      morning: {
        get: os.meetings.morning.get.handler(meetingsQuery('meetings.morning.get')),
        set: os.meetings.morning.set.handler(meetingsCommand('meetings.morning.set')),
      },
      // Agenda adherence (#3959): `agenda` is the open-item list the recorder sees before clicking (no model), `status` the button, `check` the click that has the recorder's own Vy compare the agenda with the transcript
      // and answer, per agenda line, covered with the transcript lines it cites, or not heard. Nothing is stored; see member-vy-ports.ts.
      adherence: {
        agenda: os.meetings.adherence.agenda.handler(meetingsQuery('meetings.adherence.agenda')),
        status: os.meetings.adherence.status.handler(({ context, input }) => inMeetings(context, (orgId, actor) => adherenceStatusOf({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), price: aiPrice }, orgId, actor, input.meetingId))),
        check: os.meetings.adherence.check.handler(({ context, input }) =>
          inMeetings(context, (orgId, actor) => runMeetingAdherence({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: meetingAdherence, price: aiPrice }, orgId, actor, input)),
        ),
      },
      // A member's own Google Calendar meetings (B1, #3165): the member's own rows, no model; see modules/meetings/src/agenda.ts.
      agenda: {
        list: os.meetings.agenda.list.handler(meetingsQuery('meetings.agenda.list')),
        // The extension's "Sắp họp" card: the `agenda` token scope opens exactly this procedure (auth-extension.ts lists the route).
        next: os.meetings.agenda.next.handler(meetingsQuery('meetings.agenda.next')),
        suggest: os.meetings.agenda.suggest.handler(meetingsQuery('meetings.agenda.suggest')),
        setReadEvents: os.meetings.agenda.setReadEvents.handler(meetingsCommand('meetings.agenda.set_read_events')),
        link: os.meetings.agenda.link.handler(meetingsCommand('meetings.agenda.link')),
      },
      series: {
        openItems: os.meetings.series.openItems.handler(meetingsQuery('meetings.series.open_items')),
        set: os.meetings.series.set.handler(meetingsCommand('meetings.series.set')),
      },
      actionItems: {
        create: os.meetings.actionItems.create.handler(meetingsCommand('meetings.action_item.create')),
        edit: os.meetings.actionItems.edit.handler(meetingsCommand('meetings.action_item.edit')),
        delete: os.meetings.actionItems.delete.handler(meetingsCommand('meetings.action_item.delete')),
        accept: os.meetings.actionItems.accept.handler(meetingsCommand('meetings.action_item.accept')),
        acceptClean: os.meetings.actionItems.acceptClean.handler(meetingsCommand('meetings.action_item.accept_clean')),
        source: os.meetings.actionItems.source.handler(meetingsQuery('meetings.action_item.source')),
      },
      readers: {
        add: os.meetings.readers.add.handler(meetingsCommand('meetings.reader.add')),
        remove: os.meetings.readers.remove.handler(meetingsCommand('meetings.reader.remove')),
      },
    },
    crm: {
      pipeline: {
        stages: os.crm.pipeline.stages.handler(({ context }) => inCrm(context, (orgId, actor) => runtime.query('crm.stage.list', {}, { actor, orgId }))),
        setup: os.crm.pipeline.setup.handler(crmCommand('crm.pipeline.setup')),
        addStage: os.crm.pipeline.addStage.handler(crmCommand('crm.stage.add')),
        renameStage: os.crm.pipeline.renameStage.handler(crmCommand('crm.stage.rename')),
        reorderStages: os.crm.pipeline.reorderStages.handler(crmCommand('crm.stage.reorder')),
        removeStage: os.crm.pipeline.removeStage.handler(crmCommand('crm.stage.remove')),
      },
      parties: { search: os.crm.parties.search.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.party.search', input, { actor, orgId }))) },
      deals: {
        board: os.crm.deals.board.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.deal.board', input, { actor, orgId }))),
        list: os.crm.deals.list.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.deal.list', input, { actor, orgId }))),
        get: os.crm.deals.get.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.deal.get', input, { actor, orgId }))),
        byParty: os.crm.deals.byParty.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.party.deals', input, { actor, orgId }))),
        bookings: os.crm.deals.bookings.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.deal.bookings', input, { actor, orgId }))),
        conversations: os.crm.deals.conversations.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.deal.conversations', input, { actor, orgId }))),
        create: os.crm.deals.create.handler(crmCommand('crm.deal.create')),
        update: os.crm.deals.update.handler(crmCommand('crm.deal.update')),
        move: os.crm.deals.move.handler(crmCommand('crm.deal.move')),
        delete: os.crm.deals.delete.handler(crmCommand('crm.deal.delete')),
      },
      // The stale-deal rule's next steps (#2381): read them, mark them done or snooze them; the rule itself runs in the worker.
      nextSteps: {
        list: os.crm.nextSteps.list.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.next_step.list', input, { actor, orgId }))),
        done: os.crm.nextSteps.done.handler(crmCommand('crm.next_step.done')),
        snooze: os.crm.nextSteps.snooze.handler(crmCommand('crm.next_step.snooze')),
        draft: os.crm.nextSteps.draft.handler(({ context, input }) =>
          inCrm(context, async (orgId, actor) => {
            const source = await runtime.query<FollowupSource>('crm.followup.source', { nextStepId: input.nextStepId }, { actor, orgId });
            const makeLink = (quoteId: string) => runtime.execute<QuoteLinkCreated>('crm.quote.create_link', { quoteId }, { actor, orgId });
            return draftCrmFollowup({ ai: followupCoworker, publicUrl: channels?.publicUrl ?? '', makeLink }, orgId, actor.userId, source, input.hint);
          }),
        ),
      },
      dealSetting: {
        get: os.crm.dealSetting.get.handler(({ context }) => inCrm(context, (orgId, actor) => runtime.query('crm.deal_setting.get', {}, { actor, orgId }))),
        set: os.crm.dealSetting.set.handler(crmCommand('crm.deal_setting.set')),
      },
      // Quotes of a deal (#2693): reads for every role, writes for the roles that write deals; no command sends anything.
      quotes: {
        list: os.crm.quotes.list.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.quote.list', input, { actor, orgId }))),
        get: os.crm.quotes.get.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.quote.get', input, { actor, orgId }))),
        byDeal: os.crm.quotes.byDeal.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.deal.quotes', input, { actor, orgId }))),
        defaults: os.crm.quotes.defaults.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.quote.defaults', input, { actor, orgId }))),
        report: os.crm.quotes.report.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.quote.report', input, { actor, orgId }))),
        suggest: os.crm.quotes.suggest.handler(({ context, input }) =>
          inCrm(context, async (orgId, actor) => {
            const source = await runtime.query<QuoteSuggestSource>('crm.quote.suggest_source', input, { actor, orgId });
            return suggestQuoteLines(quoteCoworker, orgId, actor.userId, source);
          }),
        ),
        save: os.crm.quotes.save.handler(crmCommand('crm.quote.save')),
        deleteDraft: os.crm.quotes.deleteDraft.handler(crmCommand('crm.quote.delete_draft')),
        revise: os.crm.quotes.revise.handler(crmCommand('crm.quote.revise')),
        accept: os.crm.quotes.accept.handler(crmCommand('crm.quote.accept')),
        decline: os.crm.quotes.decline.handler(crmCommand('crm.quote.decline')),
        setSetting: os.crm.quotes.setSetting.handler(crmCommand('crm.quote_setting.set')),
        setLogo: os.crm.quotes.setLogo.handler(crmCommand('crm.quote_setting.logo_set')),
        removeLogo: os.crm.quotes.removeLogo.handler(crmCommand('crm.quote_setting.logo_remove')),
        send: os.crm.quotes.send.handler(crmCommand('crm.quote.send')),
        createLink: os.crm.quotes.createLink.handler(crmCommand('crm.quote.create_link')),
        revokeLink: os.crm.quotes.revokeLink.handler(crmCommand('crm.quote.revoke_link')),
        setting: os.crm.quotes.setting.handler(({ context }) => inCrm(context, (orgId, actor) => runtime.query('crm.quote_setting.get', {}, { actor, orgId }))),
      },
      salesOrders: {
        list: os.crm.salesOrders.list.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.sales_order.list', input, { actor, orgId }))),
        get: os.crm.salesOrders.get.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.sales_order.get', input, { actor, orgId }))),
        byDeal: os.crm.salesOrders.byDeal.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.deal.sales_orders', input, { actor, orgId }))),
        handoff: os.crm.salesOrders.handoff.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.sales_order.handoff', input, { actor, orgId }))),
        cancel: os.crm.salesOrders.cancel.handler(crmCommand('crm.sales_order.cancel')),
        deliver: os.crm.salesOrders.deliver.handler(crmCommand('crm.sales_order.deliver')),
        undeliver: os.crm.salesOrders.undeliver.handler(crmCommand('crm.sales_order.undeliver')),
      },
      eventTypes: {
        list: os.crm.eventTypes.list.handler(({ context }) => inCrm(context, (orgId, actor) => runtime.query('crm.event_type.list', {}, { actor, orgId }))),
        create: os.crm.eventTypes.create.handler(crmCommand('crm.event_type.create')),
        update: os.crm.eventTypes.update.handler(crmCommand('crm.event_type.update')),
        setActive: os.crm.eventTypes.setActive.handler(crmCommand('crm.event_type.set_active')),
      },
      contacts: {
        list: os.crm.contacts.list.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.contact.list', input, { actor, orgId }))),
        conversations: os.crm.contacts.conversations.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.party.conversations', input, { actor, orgId }))),
        // The company a person may work at (#2438): the three rules read in the member's own transaction, then the model orders the names outside it, through the
        // AI meter. Nothing is stored or linked. The org's switch for AI on its customers' messages covers it too (the names of its contacts reach the model):
        // with it off the companies come in their own order and the answer says `off`.
        companySuggestions: os.crm.contacts.companySuggestions.handler(({ context, input }) =>
          inCrm(context, async (orgId, actor) => {
            const found = await runtime.query<CompanyCandidates>('crm.contact.company_candidates', input, { actor, orgId });
            const { autoDraft } = await runtime.query<ConversationAutoDraft>('kernel.conversation.auto_draft', {}, { actor, orgId });
            return suggestCompanies(autoDraft ? companyAi : { ...companyAi, reader: null }, orgId, actor.userId, found);
          }),
        ),
      },
      contactImport: {
        stage: os.crm.contactImport.stage.handler(crmCommand('crm.import.stage')),
        preview: os.crm.contactImport.preview.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.import.preview', input, { actor, orgId }))),
        commit: os.crm.contactImport.commit.handler(crmCommand('crm.import.commit')),
        cancel: os.crm.contactImport.cancel.handler(crmCommand('crm.import.cancel')),
      },
      bookings: {
        list: os.crm.bookings.list.handler(({ context, input }) => inCrm(context, (orgId, actor) => runtime.query('crm.booking.list', input, { actor, orgId }))),
        cancel: os.crm.bookings.cancel.handler(crmCommand('crm.booking.cancel')),
        move: os.crm.bookings.move.handler(crmCommand('crm.booking.move')),
        // A booking and a deal (#3103): a person links one, or takes the link off; neither mails anyone.
        linkDeal: os.crm.bookings.linkDeal.handler(crmCommand('crm.booking.link_deal')),
        unlinkDeal: os.crm.bookings.unlinkDeal.handler(crmCommand('crm.booking.unlink_deal')),
        // Dy's brief before a booking linked to a deal (#3115): the facts in the member's own transaction (a booking and a conversation they may not read give nothing), then the model outside it.
        meetingBrief: os.crm.bookings.meetingBrief.handler(({ context, input }) =>
          inCrm(context, async (orgId, actor) => {
            const source = await runtime.query<MeetingBriefSource>('crm.booking.meeting_brief_source', { bookingId: input.bookingId }, { actor, orgId });
            return prepareMeetingBrief(meetingBriefCoworker, orgId, actor.userId, source);
          }),
        ),
        // Times to offer a client (#1440): the type's free slots, inside the days and times the client's message asks
        // for when the deployment's model can read it (a paid call, on the drafts' budget), else the next free ones.
        // Read-only: the member sends the reply. A model that fails or is off leaves the next free slots and says so.
        suggest: os.crm.bookings.suggest.handler(({ context, input }) =>
          inCrm(context, async (orgId, actor) => {
            const pick = async (windows: readonly ScheduleWindow[]) => {
              const s = await runtime.query<SuggestedSlots>('crm.booking.suggest_slots', { eventTypeId: input.eventTypeId, windows }, { actor, orgId });
              return { eventType: s.eventType, timeZone: s.timeZone, inWindows: s.inWindows, slots: s.slots, today: s.today, days: s.days };
            };
            const { today, days, ...next } = await pick([]);
            if (!input.message) return { ai: 'skipped' as const, asksForMeeting: null, windows: [], ...next };
            if (!bookingReader) return { ai: 'off' as const, asksForMeeting: null, windows: [], ...next };
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let reading: ScheduleReading;
            try {
              reading = await bookingReader.read({ message: input.message, today, days, timeZone: next.timeZone });
            } catch (error: unknown) {
              // The budget is spent (#2382): the next free slots still come, and the member is told why Vy did not read the message.
              if (error instanceof AiBudgetExhaustedError) return { ai: 'budget' as const, asksForMeeting: null, windows: [], ...next };
              // Neither the message nor the answer is logged.
              console.error('[crm-ai] suggest failed', error instanceof Error ? error.name : typeof error);
              return { ai: 'failed' as const, asksForMeeting: null, windows: [], ...next };
            } finally {
              ticket.release();
            }
            if (reading.windows.length === 0) return { ai: 'used' as const, asksForMeeting: reading.asksForMeeting, windows: [], ...next };
            const { today: _t, days: _d, ...picked } = await pick(reading.windows);
            return { ai: 'used' as const, asksForMeeting: reading.asksForMeeting, windows: reading.windows, ...picked };
          }),
        ),
      },
      bookingFeed: {
        get: os.crm.bookingFeed.get.handler(({ context }) => inCrm(context, (orgId, actor) => runtime.query('crm.booking_feed.get', {}, { actor, orgId }))),
        create: os.crm.bookingFeed.create.handler(crmCommand('crm.booking_feed.create')),
        revoke: os.crm.bookingFeed.revoke.handler(crmCommand('crm.booking_feed.revoke')),
      },
    },
    social: {
      posts: {
        list: os.social.posts.list.handler(socialQuery('social.post.list')),
        get: os.social.posts.get.handler(socialQuery('social.post.get')),
        reviewDiff: os.social.posts.reviewDiff.handler(socialQuery('social.post.review_diff')),
        preReview: os.social.posts.preReview.handler(socialQuery('social.post.pre_review')),
        versions: os.social.posts.versions.handler(socialQuery('social.post.versions')),
        restoreVersion: os.social.posts.restoreVersion.handler(socialCommand('social.post.restore_version')),
        assign: os.social.posts.assign.handler(socialCommand('social.post.assign')),
        create: os.social.posts.create.handler(({ context, input }) =>
          inSocial(context, (orgId, actor) => {
            const { idempotencyKey, ...rest } = input;
            return runtime.execute('social.post.create', rest, { actor, orgId, idempotencyKey });
          }),
        ),
        update: os.social.posts.update.handler(socialCommand('social.post.update')),
        addChannels: os.social.posts.addChannels.handler(socialCommand('social.post.add_channels')),
        submit: os.social.posts.submit.handler(socialCommand('social.post.submit')),
        repost: os.social.posts.repost.handler(socialCommand('social.post.repost')),
        // A retry with the same idempotencyKey returns the first import instead of a second set of posts.
        import: os.social.posts.import.handler(({ context, input }) =>
          inSocial(context, (orgId, actor) => {
            const { idempotencyKey, ...rest } = input;
            return runtime.execute('social.post.import', rest, { actor, orgId, idempotencyKey });
          }),
        ),
        duplicate: os.social.posts.duplicate.handler(socialCommand('social.post.duplicate')),
        setLabels: os.social.posts.setLabels.handler(socialCommand('social.post.set_labels')),
        bulkLabels: os.social.posts.bulkLabels.handler(socialCommand('social.post.bulk_labels')),
        bulkAssign: os.social.posts.bulkAssign.handler(socialCommand('social.post.bulk_assign')),
        bulkReplacePreview: os.social.posts.bulkReplacePreview.handler(socialQuery('social.post.bulk_replace_preview')),
        bulkReplace: os.social.posts.bulkReplace.handler(socialCommand('social.post.bulk_replace')),
        bulkAddChannel: os.social.posts.bulkAddChannel.handler(socialCommand('social.post.bulk_add_channel')),
        archive: os.social.posts.archive.handler(socialCommand('social.post.archive')),
        restore: os.social.posts.restore.handler(socialCommand('social.post.restore')),
        bulkArchive: os.social.posts.bulkArchive.handler(socialCommand('social.post.bulk_archive')),
        bulkRestore: os.social.posts.bulkRestore.handler(socialCommand('social.post.bulk_restore')),
        createFromMedia: os.social.posts.createFromMedia.handler(({ context, input }) =>
          inSocial(context, (orgId, actor) => {
            const { idempotencyKey, ...rest } = input;
            return runtime.execute('social.post.create_from_media', rest, { actor, orgId, idempotencyKey });
          }),
        ),
        comment: os.social.posts.comment.handler(socialCommand('social.post_comment.add')),
        editComment: os.social.posts.editComment.handler(socialCommand('social.post_comment.edit')),
        resolveComment: os.social.posts.resolveComment.handler(socialCommand('social.post_comment.resolve')),
        reopenComment: os.social.posts.reopenComment.handler(socialCommand('social.post_comment.reopen')),
        suggest: os.social.posts.suggest.handler(socialCommand('social.post_comment.suggest')),
        acceptSuggestion: os.social.posts.acceptSuggestion.handler(socialCommand('social.post_comment.accept')),
        skipSuggestion: os.social.posts.skipSuggestion.handler(socialCommand('social.post_comment.skip')),
        activity: os.social.posts.activity.handler(socialQuery('social.post.activity')),
        setEvergreen: os.social.posts.setEvergreen.handler(socialCommand('social.post.set_evergreen')),
        setRecurrence: os.social.posts.setRecurrence.handler(socialCommand('social.post.recurrence_set')),
        clearRecurrence: os.social.posts.clearRecurrence.handler(socialCommand('social.post.recurrence_clear')),
        setTextVariations: os.social.posts.setTextVariations.handler(socialCommand('social.post.set_text_variations')),
        aiPhotos: os.social.posts.aiPhotos.handler(({ context }) => inSocial(context, async () => ({ enabled: Boolean(socialWriter?.draftStored) }))),
        draftWithAi: os.social.posts.draftWithAi.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            // The model costs money: only those who may write posts get to call it, checked before anything else (the
            // create command checks the role again).
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            // Photos (#1191) need a model that takes images, said before anything is read.
            const fileIds = input.fileIds ?? [];
            const draftStored = socialWriter.draftStored;
            if (fileIds.length > 0 && !draftStored) throw new DomainError('AI_VISION_OFF', 422, 'Mô hình AI của máy chủ chưa đọc được ảnh (AI_VISION)');
            if (new Set(input.connectionIds).size !== input.connectionIds.length) throw new DomainError('CHANNEL_ALREADY_IN_POST', 409, 'Mỗi kênh chỉ có một bản trong bài đăng');
            await refuseChannelsOutside(runtime, actor, orgId, input.connectionIds);
            const connections = await runtime.query<{ id: string; provider: string; displayName: string; status: string }[]>('kernel.channel.list', {}, { actor, orgId });
            const chosen = input.connectionIds.map((id) => connections.find((c) => c.id === id && c.status === 'active'));
            if (chosen.some((c) => !c)) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
            const channels = (chosen as { id: string; provider: string; displayName: string }[]).map((c) => writerChannel(c));
            // Each photo: an image of the org's Social library the member may use (for a limited member, not another
            // channel's own media, #1081), of a type and size the model is sent (as for alt text), checked before the
            // source page and the budget.
            const photos =
              fileIds.length > 0
                ? await runtime.query<{ fileId: string; storageKey: string; generation: string | null; sha256: string; contentType: string; sizeBytes: number }[]>('social.media.draft_images', { fileIds }, { actor, orgId })
                : [];
            for (const photo of photos) {
              if (!ALT_TEXT_IMAGE_TYPES.includes(photo.contentType)) throw new DomainError('AI_DRAFT_IMAGE_ONLY', 422, `${COWORKERS.marketing} chỉ soạn bài từ ảnh JPG, PNG hoặc WEBP, không từ video hay tệp PDF`, { fileId: photo.fileId });
              if (photo.sizeBytes > ALT_TEXT_IMAGE_MAX_BYTES) throw new DomainError('AI_DRAFT_IMAGE_TOO_LARGE', 413, `Có ảnh lớn hơn 10 MB nên ${COWORKERS.marketing} không đọc được`, { fileId: photo.fileId });
            }
            // The source page (#769) as its link preview read it (fetched by the worker through the egress guard, parsed in
            // the extract container): asked for if new, and waited for a few seconds. Before the budget: waiting for a page
            // costs no model call, and a page that cannot be read takes no slot.
            const source = input.sourceUrl ? await sourcePage(runtime, actor, orgId, input.sourceUrl) : undefined;
            // A forwarded mail (#779): its subject and text as kept with the inbound message, read in the caller's org
            // only (a mail of another org is not found). Like the page, tainted data the writer takes facts from.
            const mail = input.inboundMessageId ? await runtime.query<{ subject: string | null; text: string | null }>('kernel.inbound.text', { id: input.inboundMessageId }, { actor, orgId }) : undefined;
            if (mail && !mail.text && !mail.subject?.trim()) throw new DomainError('MAIL_EMPTY', 422, 'Thư này không có nội dung để soạn bài; hãy mô tả bài bằng lời');
            // The model call is paid: a member gets a few a minute and one at a time, an org a few more (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang soạn một bài bằng AI, hãy đợi xong rồi soạn tiếp' : 'Đã soạn bằng AI nhiều bài trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let draft: Awaited<ReturnType<SocialDrafter['draft']>>;
            try {
              const voices = input.tone ? null : await savedVoices(runtime, actor, orgId);
              const request: Omit<DraftRequest, 'images'> = {
                brief: input.brief,
                channels,
                language: input.language ?? 'vi',
                ...(input.tone ? { tone: input.tone } : {}),
                ...(voices?.org ? { voice: voices.org } : {}),
                ...(source ? { source } : {}),
                ...(mail ? { mail } : {}),
                ...(voices ? { channelVoices: Object.fromEntries(input.connectionIds.flatMap((id) => (voices.byChannel.has(id) ? [[id, voices.byChannel.get(id) as string]] : []))) } : {}),
              };
              draft =
                photos.length > 0 && draftStored
                  ? await draftStored(
                      request,
                      photos.map((p) => ({ file: { key: p.storageKey, generation: p.generation, sha256: p.sha256, sizeBytes: p.sizeBytes }, mime: p.contentType })),
                    )
                  : await socialWriter.draft(request);
            } catch (error: unknown) {
              refuseBudget(error);
              console.error('[social-ai] draft failed', error instanceof Error ? error.name : typeof error);
              // A photo that could not be read as recorded, or a failed vision call, has its own words (#1126).
              if (photos.length > 0) throw new DomainError('AI_DRAFT_VISION_FAILED', 503, `${COWORKERS.marketing} chưa đọc được ảnh để soạn bài lúc này, hãy thử lại sau`);
              throw new DomainError('AI_DRAFT_FAILED', 503, `${COWORKERS.marketing} không soạn được bài lúc này, hãy thử lại sau`);
            } finally {
              ticket.release();
            }
            if (!draft && photos.length > 0) throw new DomainError('AI_DRAFT_PHOTOS_EMPTY', 422, `${COWORKERS.marketing} không soạn được bài từ những ảnh này, hãy thêm vài dòng mô tả`);
            if (!draft) throw new DomainError('AI_DRAFT_EMPTY', 422, `${COWORKERS.marketing} không soạn được bài từ mô tả này, hãy viết rõ hơn`);
            const own = new Map(draft.variants.map((v) => [v.key, v]));
            const created = await runtime.execute<{ postId: string }>(
              'social.post.create',
              {
                body: draft.body,
                title: draft.title,
                origin: 'ai',
                ...(input.sourceUrl ? { linkUrl: input.sourceUrl } : {}),
                // The photos it was written from, in the order picked, as the post's images.
                ...(photos.length > 0 ? { media: photos.map((p) => ({ fileId: p.fileId })) } : {}),
                channels: input.connectionIds.map((connectionId) => {
                  const v = own.get(connectionId);
                  return { connectionId, ...(v?.body ? { body: v.body } : {}), ...(v?.title ? { title: v.title } : {}) };
                }),
              },
              { actor, orgId },
            );
            return { postId: created.postId };
          }),
        ),
        rewriteWithAi: os.social.posts.rewriteWithAi.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            let channel: WriterChannel | undefined;
            if (input.connectionId) {
              await refuseChannelsOutside(runtime, actor, orgId, [input.connectionId]);
              const connections = await runtime.query<{ id: string; provider: string; displayName: string; status: string }[]>('kernel.channel.list', {}, { actor, orgId });
              const found = connections.find((c) => c.id === input.connectionId && c.status !== 'revoked');
              if (!found) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
              channel = writerChannel(found);
            }
            const proofread = input.action === 'proofread';
            // The same budget as drafts: each rewrite is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let result: Awaited<ReturnType<SocialDrafter['rewrite']>>;
            try {
              // A proofread keeps the member's style: no brand voice is read for it.
              const voices = proofread ? null : await savedVoices(runtime, actor, orgId);
              const voice = voices ? ((input.connectionId ? voices.byChannel.get(input.connectionId) : undefined) ?? voices.org) : null;
              result = await socialWriter.rewrite({ text: input.text, title: input.title ?? null, action: input.action, ...(channel ? { channel } : {}), ...(voice ? { voice } : {}) });
            } catch (error: unknown) {
              refuseBudget(error);
              // The check after a proofread (#1167) found a changed link, hashtag, mention, number or price, or emoji.
              if (error instanceof ProofreadChangedError) {
                throw new DomainError('AI_PROOFREAD_CHANGED', 422, `${COWORKERS.marketing} đã sửa cả liên kết, hashtag, tài khoản được nhắc (@), con số, giá hoặc emoji nên bản sửa bị bỏ; nội dung của bạn vẫn giữ nguyên`, { changed: [...error.kinds] });
              }
              console.error('[social-ai] rewrite failed', error instanceof Error ? error.name : typeof error);
              if (proofread) throw new DomainError('AI_PROOFREAD_FAILED', 503, `${COWORKERS.marketing} chưa soát được chính tả lúc này, hãy thử lại sau`);
              throw new DomainError('AI_DRAFT_FAILED', 503, `${COWORKERS.marketing} không soạn được bài lúc này, hãy thử lại sau`);
            } finally {
              ticket.release();
            }
            if (!result && proofread) throw new DomainError('AI_PROOFREAD_FAILED', 503, `${COWORKERS.marketing} chưa soát được chính tả lúc này, hãy thử lại sau`);
            if (!result) throw new DomainError('AI_REWRITE_EMPTY', 422, `${COWORKERS.marketing} không viết lại được đoạn này, hãy thử cách khác`);
            return result;
          }),
        ),
        // An alt text suggestion for one image (#817, #1121): a proposal the member keeps or edits, never saved here.
        // The image is read only when it is the org's own Social upload, a JPG, PNG or WEBP of at most 10 MB, and goes
        // only to the configured model; neither it nor the prompt is logged.
        describeImage: os.social.posts.describeImage.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            if (!socialWriter.describeStored) throw new DomainError('AI_VISION_OFF', 422, 'Mô hình AI của máy chủ chưa đọc được ảnh (AI_VISION)');
            const file = await runtime.query<{ storageKey: string; generation: string | null; sha256: string; contentType: string; sizeBytes: number }>('social.media.stored', { fileId: input.fileId }, { actor, orgId });
            if (!ALT_TEXT_IMAGE_TYPES.includes(file.contentType)) throw new DomainError('ALT_TEXT_IMAGE_ONLY', 422, 'Chỉ gợi ý mô tả cho ảnh');
            if (file.sizeBytes > ALT_TEXT_IMAGE_MAX_BYTES) throw new DomainError('ALT_TEXT_IMAGE_TOO_LARGE', 413, `Ảnh lớn hơn 10 MB nên ${COWORKERS.marketing} không đọc được`);
            // The post's channels, the org's own (a disconnected one of a saved post included): the suggestion keeps
            // within their strictest alt-text limit. A member limited to some channels (#1081) names only theirs (#1175),
            // checked before the budget and the model call.
            let maxChars: number | null = null;
            if (input.connectionIds && input.connectionIds.length > 0) {
              await refuseChannelsOutside(runtime, actor, orgId, input.connectionIds);
              const connections = await runtime.query<{ id: string; provider: string }[]>('kernel.channel.list', { includeRevoked: true }, { actor, orgId });
              const own = new Map(connections.map((c) => [c.id, c.provider]));
              const providers: string[] = [];
              for (const id of input.connectionIds) {
                const provider = own.get(id);
                if (provider === undefined) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại');
                providers.push(provider);
              }
              maxChars = strictestAltTextLimit(providers);
            }
            // The same budget as drafts: each ask is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let altText: string | null;
            try {
              altText = await socialWriter.describeStored({ key: file.storageKey, generation: file.generation, sha256: file.sha256, sizeBytes: file.sizeBytes }, file.contentType, input.language, maxChars);
            } catch (error: unknown) {
              refuseBudget(error);
              console.error('[social-ai] describe failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_ALT_TEXT_FAILED', 503, `${COWORKERS.marketing} chưa gợi ý được mô tả ảnh lúc này, hãy thử lại sau`);
            } finally {
              ticket.release();
            }
            if (!altText) throw new DomainError('AI_ALT_TEXT_EMPTY', 422, `${COWORKERS.marketing} không mô tả được ảnh này, bạn hãy tự viết mô tả`);
            return { altText };
          }),
        ),
        suggestHashtags: os.social.posts.suggestHashtags.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter?.hashtags) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            let channel: WriterChannel | undefined;
            if (input.connectionId) {
              // A member limited to some channels (#1081) may not have another channel's name and limits go into the
              // prompt (#1175): refused before the budget and the model call.
              await refuseChannelsOutside(runtime, actor, orgId, [input.connectionId]);
              const connections = await runtime.query<{ id: string; provider: string; displayName: string; status: string }[]>('kernel.channel.list', {}, { actor, orgId });
              const found = connections.find((c) => c.id === input.connectionId && c.status !== 'revoked');
              if (!found) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
              channel = writerChannel(found);
            }
            // The same budget as drafts and rewrites: each ask is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            try {
              return { hashtags: await socialWriter.hashtags({ text: input.text, language: input.language, ...(channel ? { channel } : {}), exclude: input.exclude }) };
            } catch (error: unknown) {
              refuseBudget(error);
              console.error('[social-ai] hashtags failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_DRAFT_FAILED', 503, `${COWORKERS.marketing} không soạn được bài lúc này, hãy thử lại sau`);
            } finally {
              ticket.release();
            }
          }),
        ),
      },
      variants: {
        update: os.social.variants.update.handler(socialCommand('social.variant.update')),
        decide: os.social.variants.decide.handler(socialCommand('social.variant.decide')),
        schedule: os.social.variants.schedule.handler(socialCommand('social.variant.schedule')),
        unschedule: os.social.variants.unschedule.handler(socialCommand('social.variant.unschedule')),
        retryComment: os.social.variants.retryComment.handler(socialCommand('social.comment.retry')),
      retryThread: os.social.variants.retryThread.handler(socialCommand('social.thread.retry')),
        reschedule: os.social.variants.reschedule.handler(socialCommand('social.variant.reschedule')),
        cancel: os.social.variants.cancel.handler(socialCommand('social.variant.cancel')),
        retry: os.social.variants.retry.handler(socialCommand('social.variant.retry')),
        resolve: os.social.variants.resolve.handler(socialCommand('social.variant.resolve')),
        remove: os.social.variants.remove.handler(socialCommand('social.variant.remove')),
        editPublished: os.social.variants.editPublished.handler(socialCommand('social.variant.edit_published')),
      },
      metrics: {
        summary: os.social.metrics.summary.handler(socialQuery('social.metrics.summary')),
        totals: os.social.metrics.totals.handler(socialQuery('social.metrics.totals')),
        external: os.social.metrics.external.handler(socialQuery('social.metrics.external')),
        insights: os.social.metrics.insights.handler(socialQuery('social.metrics.insights')),
        export: os.social.metrics.export.handler(socialCommand('social.metrics.export')),
        // An AI summary of a period (#1237): the role gate, AI configured, the channels the member may use (#1081) and
        // the budget (#386) before the one model call, in the org's voice (or the one chosen channel's). The figures are
        // the tab's own totals; a summary citing another number is refused. Nothing is saved.
        writeSummary: os.social.metrics.writeSummary.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không dùng được AI để viết tóm tắt');
            if (!socialWriter?.summary) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            const connectionIds = [...new Set(input.connectionIds ?? [])];
            await refuseChannelsOutside(runtime, actor, orgId, connectionIds);
            const { language, ...period } = input;
            // Reading the figures costs no model call: a period with nothing published takes no slot.
            const data = await runtime.query<PeriodSummaryData>('social.metrics.summary_figures', period, { actor, orgId });
            if (data.current.posts === 0 && data.previous.posts === 0) throw new DomainError('AI_SUMMARY_NO_DATA', 422, 'Kỳ này và kỳ trước chưa có bài nào đã đăng nên chưa có gì để tóm tắt');
            const summaryInput = periodSummaryInput(data);
            // The same budget as drafts: each summary is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let text: string | null;
            try {
              const voices = await savedVoices(runtime, actor, orgId);
              const only = connectionIds.length === 1 ? connectionIds[0] : undefined;
              const voice = (only ? voices.byChannel.get(only) : undefined) ?? voices.org;
              text = await socialWriter.summary({ ...summaryInput, language: language ?? 'vi', ...(voice ? { voice } : {}) });
            } catch (error: unknown) {
              refuseBudget(error);
              // The check after the call found a number that is not one of the period's figures.
              if (error instanceof SummaryFigureError) {
                throw new DomainError('AI_SUMMARY_FIGURE_INVENTED', 422, `${COWORKERS.marketing} đã viết một con số không có trong số liệu của kỳ nên bản tóm tắt bị bỏ; hãy thử lại`, { numbers: error.numbers.length });
              }
              console.error('[social-ai] summary failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_SUMMARY_FAILED', 503, `${COWORKERS.marketing} chưa viết được tóm tắt lúc này, hãy thử lại sau`);
            } finally {
              ticket.release();
            }
            if (!text) throw new DomainError('AI_SUMMARY_EMPTY', 422, `${COWORKERS.marketing} không viết được tóm tắt cho kỳ này, hãy thử lại`);
            return { text };
          }),
        ),
      },
      plan: {
        export: os.social.plan.export.handler(socialCommand('social.plan.export')),
      },
      team: {
        report: os.social.team.report.handler(socialQuery('social.team.report')),
      },
      labels: {
        list: os.social.labels.list.handler(socialQuery('social.label.list')),
        create: os.social.labels.create.handler(socialCommand('social.label.create')),
        update: os.social.labels.update.handler(socialCommand('social.label.update')),
        remove: os.social.labels.remove.handler(socialCommand('social.label.delete')),
      },
      calendarFeed: {
        get: os.social.calendarFeed.get.handler(socialQuery('social.calendar_feed.get')),
        create: os.social.calendarFeed.create.handler(socialCommand('social.calendar_feed.create')),
        revoke: os.social.calendarFeed.revoke.handler(socialCommand('social.calendar_feed.revoke')),
      },
      calendarNotes: {
        list: os.social.calendarNotes.list.handler(socialQuery('social.calendar_note.list')),
        save: os.social.calendarNotes.save.handler(socialCommand('social.calendar_note.save')),
        remove: os.social.calendarNotes.remove.handler(socialCommand('social.calendar_note.remove')),
      },
      ideas: {
        list: os.social.ideas.list.handler(socialQuery('social.idea.list')),
        get: os.social.ideas.get.handler(socialQuery('social.idea.get')),
        create: os.social.ideas.create.handler(socialCommand('social.idea.create')),
        update: os.social.ideas.update.handler(socialCommand('social.idea.update')),
        move: os.social.ideas.move.handler(socialCommand('social.idea.move')),
        // Post ideas from a theme (#1181): the same role gate, budget and brand voice as AI drafting; nothing is saved.
        suggest: os.social.ideas.suggest.handler(({ context, input }) =>
          inSocial(context, async (orgId, actor) => {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role !== 'owner' && role !== 'admin' && role !== 'member') throw new DomainError('FORBIDDEN', 403, 'Vai trò chỉ xem không soạn được bài');
            if (!socialWriter?.ideas) throw new DomainError('AI_NOT_CONFIGURED', 503, 'Máy chủ chưa cấu hình AI (AI_BASE_URL, AI_MODEL)');
            // A channel's voice: only a channel the member may write for (#1081), and one of the org's.
            if (input.connectionId) {
              await refuseChannelsOutside(runtime, actor, orgId, [input.connectionId]);
              const connections = await runtime.query<{ id: string; status: string }[]>('kernel.channel.list', {}, { actor, orgId });
              if (!connections.some((c) => c.id === input.connectionId && c.status !== 'revoked')) throw new DomainError('CHANNEL_NOT_FOUND', 404, 'Có kênh không tồn tại hoặc đã ngắt kết nối');
            }
            // The same budget as drafts: each ask is a paid model call (#386).
            const ticket = drafts.take(orgId, actor.userId);
            if (!ticket.allowed) {
              throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
                retryAfterSeconds: ticket.retryAfterSeconds,
              });
            }
            let ideas: Awaited<ReturnType<NonNullable<SocialDrafter['ideas']>>>;
            try {
              const voices = await savedVoices(runtime, actor, orgId);
              const voice = (input.connectionId ? voices.byChannel.get(input.connectionId) : undefined) ?? voices.org;
              ideas = await socialWriter.ideas({ theme: input.theme, occasion: input.occasion ?? null, count: input.count, language: input.language ?? 'vi', ...(voice ? { voice } : {}) });
            } catch (error: unknown) {
              refuseBudget(error);
              console.error('[social-ai] ideas failed', error instanceof Error ? error.name : typeof error);
              throw new DomainError('AI_IDEAS_FAILED', 503, `${COWORKERS.marketing} chưa gợi ý được ý tưởng lúc này, hãy thử lại sau`);
            } finally {
              ticket.release();
            }
            if (ideas.length === 0) throw new DomainError('AI_IDEAS_EMPTY', 422, `${COWORKERS.marketing} không nghĩ ra ý tưởng nào từ chủ đề này, hãy viết rõ hơn`);
            return { ideas };
          }),
        ),
      },
      bio: {
        get: os.social.bio.get.handler(socialQuery('social.bio.get')),
        save: os.social.bio.save.handler(socialCommand('social.bio.save')),
      },
      feeds: {
        list: os.social.feeds.list.handler(socialQuery('social.feed.list')),
        add: os.social.feeds.add.handler(socialCommand('social.feed.add')),
        update: os.social.feeds.update.handler(socialCommand('social.feed.update')),
        remove: os.social.feeds.remove.handler(socialCommand('social.feed.remove')),
      },
      savedViews: {
        list: os.social.savedViews.list.handler(socialQuery('social.saved_view.list')),
        save: os.social.savedViews.save.handler(socialCommand('social.saved_view.save')),
        remove: os.social.savedViews.remove.handler(socialCommand('social.saved_view.delete')),
      },
      snippets: {
        list: os.social.snippets.list.handler(socialQuery('social.snippet.list')),
        create: os.social.snippets.create.handler(socialCommand('social.snippet.create')),
        update: os.social.snippets.update.handler(socialCommand('social.snippet.update')),
        remove: os.social.snippets.remove.handler(socialCommand('social.snippet.delete')),
      },
      bannedWords: {
        list: os.social.bannedWords.list.handler(socialQuery('social.banned_word.list')),
        add: os.social.bannedWords.add.handler(socialCommand('social.banned_word.add')),
        remove: os.social.bannedWords.remove.handler(socialCommand('social.banned_word.remove')),
      },
      reviewChecklist: {
        list: os.social.reviewChecklist.list.handler(socialQuery('social.review_check.list')),
        set: os.social.reviewChecklist.set.handler(socialCommand('social.review_check.set')),
      },
      channelAccess: {
        list: os.social.channelAccess.list.handler(socialQuery('social.channel_access.list')),
        mine: os.social.channelAccess.mine.handler(socialQuery('social.channel_access.mine')),
        set: os.social.channelAccess.set.handler(socialCommand('social.channel_access.set')),
      },
      goals: {
        progress: os.social.goals.progress.handler(socialQuery('social.goal.progress')),
        set: os.social.goals.set.handler(socialCommand('social.goal.set')),
        remove: os.social.goals.remove.handler(socialCommand('social.goal.remove')),
      },
      reportLinks: {
        list: os.social.reportLinks.list.handler(socialQuery('social.report_link.list')),
        create: os.social.reportLinks.create.handler(socialCommand('social.report_link.create')),
        revoke: os.social.reportLinks.revoke.handler(socialCommand('social.report_link.revoke')),
      },
      channelSets: {
        list: os.social.channelSets.list.handler(socialQuery('social.channel_set.list')),
        save: os.social.channelSets.save.handler(socialCommand('social.channel_set.save')),
        remove: os.social.channelSets.remove.handler(socialCommand('social.channel_set.remove')),
      },
      brandVoices: {
        list: os.social.brandVoices.list.handler(socialQuery('social.brand_voice.list')),
        save: os.social.brandVoices.save.handler(socialCommand('social.brand_voice.save')),
        remove: os.social.brandVoices.remove.handler(socialCommand('social.brand_voice.remove')),
      },
      watermark: {
        get: os.social.watermark.get.handler(socialQuery('social.watermark.get')),
        save: os.social.watermark.save.handler(socialCommand('social.watermark.save')),
        remove: os.social.watermark.remove.handler(socialCommand('social.watermark.remove')),
      },
      reportBranding: {
        get: os.social.reportBranding.get.handler(socialQuery('social.report_branding.get')),
        save: os.social.reportBranding.save.handler(socialCommand('social.report_branding.save')),
        remove: os.social.reportBranding.remove.handler(socialCommand('social.report_branding.remove')),
      },
      publishing: {
        get: os.social.publishing.get.handler(socialQuery('social.publishing.hold_get')),
        hold: os.social.publishing.hold.handler(socialCommand('social.publishing.hold')),
        release: os.social.publishing.release.handler(socialCommand('social.publishing.release')),
      },
      chatAlert: {
        get: os.social.chatAlert.get.handler(socialQuery('social.chat_alert.get')),
        save: os.social.chatAlert.save.handler(({ context, input }) =>
          guard(async () => {
            const scope = await chatAlertScope(context);
            // The role first, as oauthConnector does: a member learns nothing about how the deployment is set up.
            if (scope.role !== 'owner' && scope.role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới đổi được nhóm nhận báo');
            if (!channels) throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
            return saveChatAlert({ runtime, broker: channels.broker, saves: chatAlertSaves }, scope, input);
          }),
        ),
        remove: os.social.chatAlert.remove.handler(socialCommand('social.chat_alert.remove')),
        test: os.social.chatAlert.test.handler(({ context }) =>
          guard(async () => {
            return requestChatAlertTest(runtime, chatAlertTests, await chatAlertScope(context));
          }),
        ),
      },
      reportSchedules: {
        list: os.social.reportSchedules.list.handler(socialQuery('social.report_schedule.list')),
        save: os.social.reportSchedules.save.handler(socialCommand('social.report_schedule.save')),
        remove: os.social.reportSchedules.remove.handler(socialCommand('social.report_schedule.remove')),
        test: os.social.reportSchedules.test.handler(socialCommand('social.report_schedule.test')),
      },
      linkPreviews: {
        request: os.social.linkPreviews.request.handler(socialCommand('social.link_preview.request')),
        get: os.social.linkPreviews.get.handler(socialQuery('social.link_preview.get')),
      },
      channelOptions: {
        request: os.social.channelOptions.request.handler(socialCommand('social.channel_option.request')),
        get: os.social.channelOptions.get.handler(socialQuery('social.channel_option.get')),
      },
      notifications: {
        list: os.social.notifications.list.handler(socialQuery('social.notification.list')),
        read: os.social.notifications.read.handler(socialCommand('social.notification.read')),
        mute: os.social.notifications.mute.handler(socialCommand('social.notification.mute')),
        mail: os.social.notifications.mail.handler(socialCommand('social.notification.mail')),
        push: {
          status: os.social.notifications.push.status.handler(({ context, input }) =>
            inSocial(context, async (orgId, actor) => {
              const push = channels?.push;
              const own = await runtime.query<{ devices: { id: string; label: string | null; createdAt: string; lastUsedAt: string | null; current: boolean }[]; subscribed: boolean }>('social.push.devices', input, { actor, orgId });
              return { enabled: Boolean(push), publicKey: push?.publicKey ?? null, ...own };
            }),
          ),
          // Without VAPID keys nothing could ever be sent: refused before a row is written.
          subscribe: os.social.notifications.push.subscribe.handler(({ context, input }) =>
            inSocial(context, (orgId, actor) => {
              if (!channels?.push) throw new DomainError('PUSH_DISABLED', 404, 'Máy chủ này chưa bật thông báo đẩy');
              return runtime.execute<{ id: string }>('social.push.subscribe', input, { actor, orgId });
            }),
          ),
          // Turning a device off works whatever the keys, so a member can always clean up.
          unsubscribe: os.social.notifications.push.unsubscribe.handler(socialCommand('social.push.unsubscribe')),
        },
      },
      accounts: {
        trends: os.social.accounts.trends.handler(socialQuery('social.account.trends')),
      },
      reviewInbox: os.social.reviewInbox.handler(socialQuery('social.review.inbox')),
      attentionInbox: os.social.attentionInbox.handler(socialQuery('social.attention.inbox')),
      reviewLinks: {
        list: os.social.reviewLinks.list.handler(socialQuery('social.review_link.list')),
        create: os.social.reviewLinks.create.handler(socialCommand('social.review_link.create')),
        createPlan: os.social.reviewLinks.createPlan.handler(socialCommand('social.review_link.create_plan')),
        plans: os.social.reviewLinks.plans.handler(socialQuery('social.review_link.list_plans')),
        revoke: os.social.reviewLinks.revoke.handler(socialCommand('social.review_link.revoke')),
        reply: os.social.reviewLinks.reply.handler(socialCommand('social.review.reply')),
      },
      media: {
        list: os.social.media.list.handler(socialQuery('social.media.list')),
        usage: os.social.media.usage.handler(socialQuery('social.media.usage')),
        tags: os.social.media.tags.handler(socialQuery('social.media.tags')),
        tag: os.social.media.tag.handler(socialCommand('social.media.tag')),
        untag: os.social.media.untag.handler(socialCommand('social.media.untag')),
        archive: os.social.media.archive.handler(socialCommand('social.media.archive')),
        restore: os.social.media.restore.handler(socialCommand('social.media.restore')),
        resolve: os.social.media.resolve.handler(socialQuery('social.media.resolve')),
        fetchUrls: os.social.media.fetchUrls.handler(({ context, input }) => mediaUrlScope(context, (orgId, actor, urls) => urls.fetch(runtime, actor, orgId, input.urls))),
      },
      stockPhotos: {
        status: os.social.stockPhotos.status.handler(({ context }) => inSocial(context, async () => ({ enabled: Boolean(channels?.stockPhotos), provider: 'pexels' as const }))),
        search: os.social.stockPhotos.search.handler(({ context, input }) => stockScope(context, (_orgId, _actor, stock) => stock.search(input))),
        save: os.social.stockPhotos.save.handler(({ context, input }) => stockScope(context, (orgId, actor, stock) => stock.save(runtime, actor, orgId, input))),
      },
      policies: {
        list: os.social.policies.list.handler(socialQuery('social.channel.policies')),
        set: os.social.policies.set.handler(socialCommand('social.channel.set_policy')),
        setReminders: os.social.policies.setReminders.handler(socialCommand('social.channel.set_reminders')),
        setShortLinks: os.social.policies.setShortLinks.handler(socialCommand('social.channel.set_short_links')),
        setSignature: os.social.policies.setSignature.handler(socialCommand('social.channel.set_signature')),
        setFourEyes: os.social.policies.setFourEyes.handler(socialCommand('social.channel.set_four_eyes')),
        setClientApproval: os.social.policies.setClientApproval.handler(socialCommand('social.channel.set_client_approval')),
      },
      channels: {
        waiting: os.social.channels.waiting.handler(socialQuery('social.channel.waiting')),
      },
      queues: {
        get: os.social.queues.get.handler(socialQuery('social.queue.get')),
        openSlots: os.social.queues.openSlots.handler(socialQuery('social.queue.open_slots')),
        set: os.social.queues.set.handler(socialCommand('social.queue.set')),
        shuffle: os.social.queues.shuffle.handler(socialCommand('social.queue.shuffle')),
        moveToFront: os.social.queues.moveToFront.handler(socialCommand('social.queue.move_to_front')),
      },
    },
    channels: {
      list: os.channels.list.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.channel.list', input, { actor, orgId }))),
      // The token is made and sealed here and only the envelope reaches the command. No idempotency key: every seal
      // differs, and connecting the same sandbox key again is already a reconnect of the same account.
      connectSandbox: os.channels.connectSandbox.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          const actor = actorOf(context.user);
          // The command checks the role again; checking first keeps a member from learning how the deployment is set up.
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.sandbox) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh thử nghiệm (sandbox) chưa được bật');
          const account = sandbox.connect({ key: input.key, displayName: input.displayName });
          const sealed = channels.broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
          const command: ChannelConnectInput = {
            provider: account.provider,
            externalAccountId: account.externalAccountId,
            displayName: account.displayName,
            scopes: account.scopes,
            expiresAt: account.expiresAt?.toISOString() ?? null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          return runtime.execute('kernel.channel.connect', command, { actor, orgId });
        }),
      ),
      disconnect: os.channels.disconnect.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.channel.disconnect', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // Telegram bot chats on or off (#3132): the connection holds the bot token already; the webhook call is a job's.
      setTelegramChats: os.channels.setTelegramChats.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          if (!channels?.telegram) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (input.on && channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          return runtime.execute<{ chatState: 'off' | 'enabling' | 'on' | 'disabling' }>('kernel.channel.telegram_chat_set', input, { actor, orgId });
        }),
      ),
      // Allows a Telegram Business account's chats in, or stops them (#3191): the org's owner or admin chooses, nothing of an account is stored before.
      setTelegramBusiness: os.channels.setTelegramBusiness.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute<{ approved: boolean }>('kernel.channel.telegram_business_allow', input, { actor, orgId }))),
      // An app password is checked once by opening a session, then sealed with the account's DID and dropped; it never
      // reaches a log, an audit row or an answer.
      connectBluesky: os.channels.connectBluesky.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.bluesky) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const failure = (error: unknown): DomainError => {
            if (error instanceof BlueskyError) {
              if (error.code === 'NotAnAppPassword') return new DomainError('BLUESKY_APP_PASSWORD', 422, 'Hãy dùng mật khẩu ứng dụng (app password) của Bluesky, không dùng mật khẩu tài khoản');
              if (error.code === 'PrivilegedAppPassword') {
                return new DomainError('BLUESKY_APP_PASSWORD_PRIVILEGED', 422, 'Mật khẩu ứng dụng này được đọc cả tin nhắn riêng; hãy tạo mật khẩu ứng dụng mới không bật quyền tin nhắn');
              }
              if (error.code === 'UnsupportedPds') return new DomainError('BLUESKY_PDS_UNSUPPORTED', 422, 'Không gọi được máy chủ lưu tài khoản Bluesky này (PDS phải là tên miền công khai, qua https)');
              if (error.status === 401 || error.status === 400) return new DomainError('BLUESKY_LOGIN_FAILED', 422, 'Bluesky không chấp nhận tên tài khoản hoặc mật khẩu ứng dụng này');
            }
            return new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
          };
          // The format is checked first, so a typo costs no try; each try is a login on Bluesky, which limits them
          // per account (#399).
          const login = (() => {
            try {
              return blueskyLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const ticket = blueskyLogins.take(orgId, context.user.userId, login.handle);
          if (!ticket.allowed) {
            throw new DomainError('RATE_LIMITED', 429, 'Đã thử kết nối Bluesky nhiều lần trong phút này, hãy đợi một lát rồi thử lại', { retryAfterSeconds: ticket.retryAfterSeconds });
          }
          const account = await connectBluesky(login, undefined, egressFetch({ timeoutMs: 15_000, maxBytes: 200_000, overLimit: 'fail' })).catch((error: unknown) => {
            throw failure(error);
          });
          const sealed = channels.broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
          const command: ChannelConnectInput = {
            provider: account.provider,
            externalAccountId: account.externalAccountId,
            displayName: account.displayName,
            scopes: account.scopes,
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          return runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor: actorOf(context.user), orgId });
        }),
      ),
      // A bot token is checked once (the bot, the channel, the bot's right to post), then sealed with the channel's id
      // and dropped; it never reaches a log, an audit row or an answer.
      // An access token is checked once with the instance, through the egress guard (public addresses only, no
      // redirects), then sealed with the account id and dropped; it never reaches a log, an audit row or an answer.
      connectMastodon: os.channels.connectMastodon.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.mastodon) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const failure = (error: unknown) => mastodonFailure(error instanceof ConnectorError ? error.code : undefined);
          const login = (() => {
            try {
              return mastodonLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const account = await connectMastodon(login, egressFetch({ timeoutMs: 15_000, maxBytes: 200_000, overLimit: 'fail' })).catch((error: unknown) => {
            throw failure(error);
          });
          const sealed = channels.broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
          const command: ChannelConnectInput = {
            provider: account.provider,
            externalAccountId: account.externalAccountId,
            displayName: account.displayName,
            scopes: account.scopes,
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          return runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor: actorOf(context.user), orgId });
        }),
      ),
      // An application password is checked once with the site, through the egress guard (public addresses only, no
      // redirects), then sealed with the site's id and dropped; it never reaches a log, an audit row or an answer.
      connectWordPress: os.channels.connectWordPress.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.wordpress) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const failure = (error: unknown) => wordpressFailure(error instanceof ConnectorError ? error.code : undefined);
          const login = (() => {
            try {
              return wordpressLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const account = await connectWordPress(login, egressFetch({ timeoutMs: 15_000, maxBytes: 200_000, overLimit: 'fail' })).catch((error: unknown) => {
            throw failure(error);
          });
          const sealed = channels.broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
          const command: ChannelConnectInput = {
            provider: account.provider,
            externalAccountId: account.externalAccountId,
            displayName: account.displayName,
            scopes: account.scopes,
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          return runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor: actorOf(context.user), orgId });
        }),
      ),
      connectTelegram: os.channels.connectTelegram.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.telegram) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const failure = (error: unknown): DomainError => {
            const known = error instanceof ConnectorError ? telegramFailure(error.code) : null;
            return known ?? new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
          };
          const login = (() => {
            try {
              return telegramLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const account = await connectTelegram(login).catch((error: unknown) => {
            throw failure(error);
          });
          const sealed = channels.broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
          const command: ChannelConnectInput = {
            provider: account.provider,
            externalAccountId: account.externalAccountId,
            displayName: account.displayName,
            scopes: account.scopes,
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          return runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor: actorOf(context.user), orgId });
        }),
      ),
      // A WhatsApp number (#3131): the system user token is checked once against the phone number (the call is made with the token in a header, never in a URL),
      // then sealed with the phone number id and dropped; it never reaches a log, an audit row or an answer. The connection is the number, so a customer's
      // notice finds the org by the phone number id it names.
      connectWhatsApp: os.channels.connectWhatsApp.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.whatsapp) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const failure = (error: unknown): DomainError => {
            const known = error instanceof ConnectorError ? whatsappFailure(error.code) : null;
            return known ?? new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
          };
          const login = (() => {
            try {
              return whatsappLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const account = await connectWhatsApp(login, channels.whatsapp).catch((error: unknown) => {
            throw failure(error);
          });
          const sealed = channels.broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
          const command: ChannelConnectInput = {
            provider: account.provider,
            externalAccountId: account.externalAccountId,
            displayName: account.displayName,
            scopes: account.scopes,
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          return runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor: actorOf(context.user), orgId });
        }),
      ),
      // A webhook is checked once with Discord (an incoming webhook of a server's channel), then its token is sealed with
      // the webhook's id and dropped; it never reaches a log, an audit row or an answer.
      connectDiscord: os.channels.connectDiscord.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được kênh');
          if (!channels?.discord) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh này chưa được bật trên máy chủ');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const failure = (error: unknown): DomainError => {
            const known = error instanceof ConnectorError ? discordFailure(error.code) : null;
            return known ?? new DomainError('OAUTH_PROVIDER_FAILED', 503, 'Nền tảng không phản hồi đúng, hãy thử lại sau');
          };
          const login = (() => {
            try {
              return discordLogin(input);
            } catch (error) {
              throw failure(error);
            }
          })();
          const account = await connectDiscord(login).catch((error: unknown) => {
            throw failure(error);
          });
          const sealed = channels.broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
          const command: ChannelConnectInput = {
            provider: account.provider,
            externalAccountId: account.externalAccountId,
            displayName: account.displayName,
            scopes: account.scopes,
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          return runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor: actorOf(context.user), orgId });
        }),
      ),
      // The state and the PKCE verifier are made here; only the state's hash and the verifier reach the database.
      oauthStart: os.channels.oauthStart.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, actor, connector } = await oauthConnector(context, input.provider);
          const attempt = newOAuthAttempt(connector.pkce);
          const begun = await runtime.execute<{ attemptId: string; expiresAt: string }>(
            'kernel.channel.oauth_begin',
            { provider: input.provider, stateHash: attempt.stateHash, codeVerifier: attempt.codeVerifier },
            { actor, orgId },
          );
          const authorizeUrl = connector.authorizeUrl({
            state: attempt.state,
            redirectUri: oauthRedirectUri(input.provider),
            codeChallenge: attempt.codeChallenge,
            ...(input.comments ? { comments: true } : {}),
          });
          return { authorizeUrl, state: attempt.state, expiresAt: begun.expiresAt };
        }),
      ),
      // The attempt is consumed before the code is exchanged, so a code and state work once even if the exchange
      // fails. The tokens the provider returns are sealed here and dropped; only envelopes reach the command.
      oauthFinish: os.channels.oauthFinish.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, actor, connector, broker } = await oauthConnector(context, input.provider);
          const { codeVerifier } = await runtime.execute<{ codeVerifier: string | null }>(
            'kernel.channel.oauth_consume',
            { provider: input.provider, stateHash: oauthStateHash(input.state) },
            { actor, orgId },
          );
          if (connector.pkce && !codeVerifier) throw new DomainError('OAUTH_STATE_INVALID', 400, 'Lượt kết nối này không hợp lệ hoặc không phải của bạn, hãy bắt đầu lại');
          // A reading connection of an ad account whose token also holds a permission to change campaigns is accepted only while the org's
          // switch for running ads is on, and only from an owner (ADR-0043, #2294): with the one Meta app that serves reading and writing,
          // the owner's own read login returns every permission they granted it, and refusing it then would stop reading for good; an admin
          // who edits the dialog to ask for more must not seal a token that can spend. The link checks the switch again.
          let spendScopesAllowed = false;
          if (isAdProviderId(input.provider) && !isAdWriteProviderId(input.provider)) {
            const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
            if (role === 'owner') spendScopesAllowed = (await runtime.query<{ writeEnabled: boolean }>('ads.write.state', {}, { actor, orgId })).writeEnabled;
          }
          const accounts = await connector.exchange({ code: input.code, redirectUri: oauthRedirectUri(input.provider), codeVerifier, ...(spendScopesAllowed ? { spendScopesAllowed } : {}) }).catch((error: unknown) => {
            throw connectorFailure(error);
          });
          if (accounts.length === 0) {
            throw new DomainError(
              'CHANNEL_NO_ACCOUNTS',
              422,
              isAdWriteProviderId(input.provider)
                ? 'Tài khoản đăng nhập này không có tài khoản quảng cáo nào để chạy quảng cáo'
                : isAdProviderId(input.provider)
                  ? 'Tài khoản đăng nhập này không có tài khoản quảng cáo nào để đọc báo cáo'
                  : 'Không có tài khoản nào bạn được quyền đăng bài trong lần cấp quyền này',
            );
          }
          // Each account connects in its own command, so one that fails leaves the others connected: the answer says
          // which did and which did not (#375), and only a grant where none connected is an error. A grant covering
          // more accounts than a request should connect one by one is cut, and the answer says how many were left.
          const taken = accounts.slice(0, OAUTH_MAX_ACCOUNTS_PER_GRANT);
          const connections: { connectionId: string; displayName: string; reconnected: boolean }[] = [];
          const failed: { displayName: string; code: string }[] = [];
          let firstError: DomainError | null = null;
          // A write connection is made only for an account linked for reading with a read connection that is not closed: nothing is
          // sealed for the others (an account an owner or admin disconnected stays closed), and when none of them is ready there is
          // nothing to connect. The attaching command checks the same again.
          let writeReady: Set<string> | null = null;
          if (isAdWriteProviderId(input.provider)) {
            const ready = await runtime.query<string[]>('ads.account.write_ready', { provider: input.provider, externalAccountIds: taken.map((a) => a.externalAccountId) }, { actor, orgId });
            writeReady = new Set(ready);
            if (writeReady.size === 0) {
              throw new DomainError('ADS_WRITE_NEEDS_READ', 409, 'Hãy kết nối tài khoản quảng cáo này để đọc số liệu trước, rồi mới kết nối để chạy quảng cáo');
            }
          }
          for (const account of taken) {
            if (writeReady && !writeReady.has(account.externalAccountId)) {
              failed.push({ displayName: account.displayName, code: 'ADS_WRITE_NEEDS_READ' });
              continue;
            }
            const sealed = broker.seal(account.secret, { orgId, provider: account.provider, externalAccountId: account.externalAccountId });
            const command: ChannelConnectInput = {
              provider: account.provider,
              externalAccountId: account.externalAccountId,
              displayName: account.displayName,
              scopes: account.scopes,
              expiresAt: account.expiresAt?.toISOString() ?? null,
              credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
              ...(account.grantedByHash ? { grantedByHash: account.grantedByHash } : {}),
            };
            try {
              const done = await runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor, orgId });
              // An ad account is also linked to the org's books as it connects (the entity the member reads by default), so
              // its first sync starts at once; a link that is refused closes the connection it just made, which no screen would
              // list, and the account is reported as failed. An account connected again keeps its row, history and settings.
              if (isAdWriteProviderId(account.provider)) {
                // A write connection hangs off the account the read connection linked, never an account of its own; one with no read
                // link, or while the switch is off, is refused and the connection it just made is closed.
                try {
                  await runtime.execute(
                    'ads.account.link_write',
                    { connectionId: done.connectionId, grantedByHash: account.grantedByHash ?? null },
                    { actor, orgId, idempotencyKey: `oauth-ads-link-write:${oauthStateHash(input.state)}:${done.connectionId}` },
                  );
                } catch (linkError) {
                  await runtime.execute('kernel.channel.disconnect', { connectionId: done.connectionId }, { actor, orgId }).catch((closeError: unknown) => {
                    console.warn(`[ads] a write connection whose link was refused could not be closed: ${closeError instanceof DomainError ? closeError.code : 'unknown'}`);
                  });
                  throw linkError;
                }
              } else if (isAdProviderId(account.provider)) {
                try {
                  const linked = await runtime.execute<{ refused?: 'spend_scopes' }>(
                    'ads.account.link',
                    { connectionId: done.connectionId, grantedByHash: account.grantedByHash ?? null },
                    { actor, orgId, idempotencyKey: `oauth-ads-link:${oauthStateHash(input.state)}:${done.connectionId}` },
                  );
                  // The link closed the connection (running ads was switched off while the person was signing in, and the token can
                  // change campaigns); the closing is committed, so the person is told here.
                  if (linked.refused === 'spend_scopes') {
                    throw new DomainError('OAUTH_WRITE_PERMISSION', 422, 'Mã truy cập này còn quyền sửa quảng cáo mà việc chạy quảng cáo đã tắt nên chưa dùng để đọc báo cáo được. Hãy gỡ ứng dụng Meta trong Cài đặt Facebook (Tích hợp doanh nghiệp) rồi kết nối lại');
                  }
                } catch (linkError) {
                  if (!done.reconnected) {
                    // A connection that stays with no ad account is listed nowhere: say so in the log, by code only.
                    await runtime.execute('kernel.channel.disconnect', { connectionId: done.connectionId }, { actor, orgId }).catch((closeError: unknown) => {
                      console.warn(`[ads] a connection whose link was refused could not be closed: ${closeError instanceof DomainError ? closeError.code : 'unknown'}`);
                    });
                  }
                  throw linkError;
                }
              }
              connections.push({ connectionId: done.connectionId, displayName: account.displayName, reconnected: done.reconnected });
            } catch (error) {
              // Only a refusal of this one account lets the others go on; a failure of the server (an outage, a bug)
              // ends the request at once, so it is logged and no more transactions pile onto a failing database.
              if (!(error instanceof DomainError) || error.status >= 500) throw error;
              firstError ??= error;
              failed.push({ displayName: account.displayName, code: error.code });
            }
          }
          if (connections.length === 0 && firstError) throw firstError;
          return { connections, failed, skipped: accounts.length - taken.length };
        }),
      ),
    },
    // The org's legal entities (#1278): owners and admins.
    legalEntities: {
      list: os.legalEntities.list.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.legal_entity.list', {}, { actor, orgId }))),
      create: os.legalEntities.create.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.legal_entity.create', input, { actor, orgId }))),
      update: os.legalEntities.update.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.legal_entity.update', input, { actor, orgId }))),
    },
    // The member's own calendar (#1313).
    calendar: {
      get: os.calendar.get.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.calendar.get', input, { actor, orgId }))),
      slots: os.calendar.slots.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.calendar.slots', input, { actor, orgId }))),
      saveHours: os.calendar.saveHours.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.calendar.hours.save', input, { actor, orgId }))),
      addEvent: os.calendar.addEvent.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.calendar.event.add', input, { actor, orgId }))),
      cancelEvent: os.calendar.cancelEvent.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.calendar.event.cancel', input, { actor, orgId }))),
      // Outside calendars (#2123). Providers: only those with app credentials and a credential key, so the screen shows
      // no connect button the server could not finish.
      providers: os.calendar.providers.handler(({ context }) =>
        guard(async () => {
          await resolveMembership(runtime, context.user, context.orgSlug);
          if (!channels || channels.broker.id === 'none') return [];
          return CALENDAR_OAUTH_PROVIDERS.filter((p) => channels.calendars?.[p] !== undefined);
        }),
      ),
      connections: os.calendar.connections.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.calendar.connections', {}, { actor, orgId }))),
      // The state and the PKCE verifier are made here; only the state's hash and the verifier reach the database.
      connectStart: os.calendar.connectStart.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, actor, adapter } = await calendarAdapter(context, input.provider);
          const attempt = newOAuthAttempt(adapter.pkce);
          const begun = await runtime.execute<{ attemptId: string; expiresAt: string }>(
            'kernel.calendar.oauth_begin',
            { provider: input.provider, stateHash: attempt.stateHash, codeVerifier: attempt.codeVerifier },
            { actor, orgId },
          );
          const authorizeUrl = adapter.authorizeUrl({ state: attempt.state, redirectUri: calendarRedirectUri(input.provider), codeChallenge: attempt.codeChallenge, ...(input.writeBack ? { writeBack: true } : {}), ...(input.readEvents ? { readEvents: true } : {}) });
          return { authorizeUrl, state: attempt.state, expiresAt: begun.expiresAt };
        }),
      ),
      // The attempt is consumed before the code is exchanged, so a code and state work once even if the exchange
      // fails. The tokens the provider returns are sealed here and dropped; only the envelope reaches the command.
      connectFinish: os.calendar.connectFinish.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, actor, adapter, broker } = await calendarAdapter(context, input.provider);
          const { codeVerifier } = await runtime.execute<{ codeVerifier: string | null }>(
            'kernel.calendar.oauth_consume',
            { provider: input.provider, stateHash: oauthStateHash(input.state) },
            { actor, orgId },
          );
          if (adapter.pkce && !codeVerifier) throw new DomainError('OAUTH_STATE_INVALID', 400, 'Lượt kết nối này không hợp lệ hoặc không phải của bạn, hãy bắt đầu lại');
          const account = await adapter.exchange({ code: input.code, redirectUri: calendarRedirectUri(input.provider), codeVerifier }).catch((error: unknown) => {
            throw connectorFailure(error);
          });
          const sealed = broker.seal(account.secret, calendarBinding(orgId, adapter.provider, account.externalAccount));
          const done = await runtime.execute<{ connectionId: string; reconnected: boolean }>(
            'kernel.calendar.connect',
            {
              provider: adapter.provider,
              externalAccount: account.externalAccount,
              displayName: account.displayName,
              scopes: account.scopes,
              expiresAt: account.expiresAt?.toISOString() ?? null,
              credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
            },
            { actor, orgId },
          );
          // A grant without the events-read scope (the member connected again for another permission, or refused it on Google's screen) turns the read of their meetings off in the connect
          // command; the meetings it already cached are deleted now, best effort (a deployment without the meetings module has nothing to delete, and the list hides them meanwhile).
          if (!canReadEventsWith(adapter.provider, account.scopes)) await clearAgenda(runtime, { actor, orgId }, done.connectionId);
          return { ...done, displayName: account.displayName };
        }),
      ),
      setWriteBack: os.calendar.setWriteBack.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.calendar.write_back.set', input, { actor, orgId }))),
      // The cached meetings of the connection go at once, not when the worker finishes the revoke (the list hides them meanwhile, as the connection is no longer active).
      disconnect: os.calendar.disconnect.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          const done = await runtime.execute<{ connectionId: string; disconnected: true }>('kernel.calendar.disconnect', input, { actor, orgId });
          await clearAgenda(runtime, { actor, orgId }, input.connectionId);
          return done;
        }),
      ),
    },
    // Meeting platforms a member connects (meetings integrations C1, #3173): the member's own connections and recordings. Only the offline sandbox connects here; the real providers' OAuth
    // steps are C2 to C4. The commands check the role and the owner again.
    meetingPlatform: {
      connections: os.meetingPlatform.connections.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.meeting_platform.connections', {}, { actor, orgId }))),
      recordings: os.meetingPlatform.recordings.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.meeting_platform.recordings', {}, { actor, orgId }))),
      refresh: os.meetingPlatform.refresh.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.meeting_platform.refresh', input, { actor, orgId }))),
      dismiss: os.meetingPlatform.dismiss.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.meeting_platform.recording.dismiss', input, { actor, orgId }))),
      disconnect: os.meetingPlatform.disconnect.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.meeting_platform.disconnect', input, { actor, orgId }))),
      // A throwaway token is sealed for the sandbox account and dropped: the sandbox platform opens nothing, so the credential only has to exist. Connecting again is a reconnect of the same account.
      connectSandbox: os.meetingPlatform.connectSandbox.handler(({ context }) =>
        guard(async () => {
          const { orgId, role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role === 'viewer') throw new DomainError('FORBIDDEN', 403, 'Người xem không kết nối được nền tảng họp');
          if (!channels?.sandbox) throw new DomainError('CHANNEL_PROVIDER_DISABLED', 404, 'Kênh thử nghiệm (sandbox) chưa được bật');
          // The token is sealed in the shape the job and the sweep open: JSON with an accessToken (the sandbox platform checks nothing, but the shape is the real one).
          const sealed = channels.broker.seal(JSON.stringify({ accessToken: randomBytes(24).toString('hex') }), meetingPlatformBinding(orgId, 'sandbox', 'sandbox@local'));
          return runtime.execute<{ connectionId: string; reconnected: boolean }>(
            'kernel.meeting_platform.connect',
            {
              provider: 'sandbox',
              externalAccount: 'sandbox@local',
              displayName: 'Nền tảng họp thử nghiệm',
              scopes: [],
              expiresAt: null,
              credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
            },
            { actor: actorOf(context.user), orgId },
          );
        }),
      ),
      // The platforms a member may connect through the platform's own dialog (Zoom, C3): only those with an adapter that has one and a credential key, so the screen shows no button the server could not finish.
      providers: os.meetingPlatform.providers.handler(({ context }) =>
        guard(async () => {
          await resolveMembership(runtime, context.user, context.orgSlug);
          if (!channels || channels.broker.id === 'none') return [];
          return MEETING_PLATFORM_CONNECT_PROVIDERS.filter((p) => hasOAuth(channels.meetingPlatforms?.[p]));
        }),
      ),
      // The state and the PKCE verifier are made here; only the state's hash and the verifier reach the database. Nothing is fetched and no token exists yet.
      connectStart: os.meetingPlatform.connectStart.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, actor, adapter } = await meetingPlatformConnector(context, input.provider);
          const attempt = newOAuthAttempt(adapter.pkce);
          const begun = await runtime.execute<{ attemptId: string; expiresAt: string }>(
            'kernel.meeting_platform.oauth_begin',
            { provider: input.provider, stateHash: attempt.stateHash, codeVerifier: attempt.codeVerifier },
            { actor, orgId },
          );
          const authorizeUrl = adapter.authorizeUrl({ state: attempt.state, redirectUri: meetingPlatformRedirectUri(input.provider), codeChallenge: attempt.codeChallenge });
          return { authorizeUrl, state: attempt.state, expiresAt: begun.expiresAt };
        }),
      ),
      // The attempt is consumed before the code is exchanged, so a code and state work once even if the exchange fails. The tokens the platform returns are sealed here and dropped: only the envelope
      // reaches the command, and no query ever returns one.
      connectFinish: os.meetingPlatform.connectFinish.handler(({ context, input }) =>
        guard(async () => {
          const { orgId, actor, adapter, broker } = await meetingPlatformConnector(context, input.provider);
          const { codeVerifier } = await runtime.execute<{ codeVerifier: string | null }>(
            'kernel.meeting_platform.oauth_consume',
            { provider: input.provider, stateHash: oauthStateHash(input.state) },
            { actor, orgId },
          );
          if (adapter.pkce && !codeVerifier) throw new DomainError('OAUTH_STATE_INVALID', 400, 'Lượt kết nối này không hợp lệ hoặc không phải của bạn, hãy bắt đầu lại');
          const account = await adapter.exchange({ code: input.code, redirectUri: meetingPlatformRedirectUri(input.provider), codeVerifier }).catch((error: unknown) => {
            throw meetingPlatformConnectFailure(error);
          });
          const sealed = broker.seal(account.secret, meetingPlatformBinding(orgId, adapter.provider, account.externalAccount));
          const done = await runtime.execute<{ connectionId: string; reconnected: boolean }>(
            'kernel.meeting_platform.connect',
            {
              provider: adapter.provider,
              externalAccount: account.externalAccount,
              displayName: account.displayName,
              scopes: account.scopes,
              expiresAt: account.expiresAt?.toISOString() ?? null,
              credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
            },
            { actor, orgId },
          );
          return { ...done, displayName: account.displayName };
        }),
      ),
    },
    // Org-less: any signed-in user may look up a tax code before the org exists. Nothing is written, so no command.
    taxRegistry: {
      lookup: os.taxRegistry.lookup.handler(({ context, input }) =>
        guard(async () => {
          if (!taxLookup) throw new DomainError('TAX_LOOKUP_DISABLED', 404, 'Máy chủ chưa bật tra cứu mã số thuế; hãy nhập tên và địa chỉ');
          return taxLookup.lookup(input.taxCode, context.user.userId);
        }),
      ),
    },
    // Org-less: the invite names the org, so the x-crove-org header is ignored here.
    invites: {
      peek: os.invites.peek.handler(({ context, input }) =>
        guard(() =>
          runtime.forUser(actorOf(context.user), (db) =>
            previewInvite(db, context.user.userId, input.token, { upstream: upstreamAuth(runtime.sessionMode) }),
          ),
        ),
      ),
      accept: os.invites.accept.handler(({ context, input }) =>
        guard(() =>
          runtime.executeOrgless<AcceptedInvite>('kernel.member.invite.accept', { token: input.token }, { actor: actorOf(context.user) }),
        ),
      ),
    },
    sessions: {
      list: os.sessions.list.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.sessions.list', input, { actor, orgId })),
      ),
      revoke: os.sessions.revoke.handler(({ context, input }) =>
        // A user's own revoke needs no org (issue #184: sign-out on the onboarding and invite pages); anyone else's
        // is org-scoped and still answers ORG_REQUIRED without one.
        !context.orgSlug && input.userId === context.user.userId
          ? guard(() => revokeOwnSessionsWithoutOrg(runtime, actorOf(context.user), input))
          : inOrg(context, (orgId, actor) => runtime.execute('kernel.session.revoke', input, { actor, orgId })),
      ),
    },
    mcp: {
      memberGrants: {
        get: os.mcp.memberGrants.get.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.mcp.member_grants.get', {}, { actor, orgId }))),
        set: os.mcp.memberGrants.set.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.mcp.member_grants.set', input, { actor, orgId }))),
      },
      grant: {
        list: os.mcp.grant.list.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.mcp.grant.list', {}, { actor, orgId }))),
        revoke: os.mcp.grant.revoke.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.mcp.grant.revoke', input, { actor, orgId }))),
      },
      // The wake-up webhook of a grant (ADR-0051 decision 4, #3024): the secret is made and sealed here, and only the person who asked sees it, once.
      wake: {
        get: os.mcp.wake.get.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.mcp.wake.get', input, { actor, orgId }))),
        set: os.mcp.wake.set.handler(({ context, input }) =>
          inOrg(context, async (orgId, actor) => {
            const broker = channels?.broker;
            if (!broker || broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
            // The command checks the role again; checking first keeps a member from learning how the deployment resolves names.
            await assertWakeHostPublic(input.url, channels?.wakeResolve);
            const made = makeWakeSecret(broker, orgId, input.grantId);
            const done = await runtime.execute<{ created: boolean }>('kernel.mcp.wake.set', { ...input, credential: made.credential }, { actor, orgId });
            const [view] = await runtime.query<McpWakeView[]>('kernel.mcp.wake.get', { grantId: input.grantId }, { actor, orgId });
            if (!view) throw new DomainError('MCP_WAKE_NOT_FOUND', 404, 'Quyền kết nối này chưa có địa chỉ nhận');
            // The secret goes back only when this call made the wake-up; a change to an existing one leaves its secret alone and the one made here is dropped.
            return { ...view, secret: done.created ? made.secret : null };
          }),
        ),
        rotateSecret: os.mcp.wake.rotateSecret.handler(({ context, input }) =>
          inOrg(context, async (orgId, actor) => {
            const broker = channels?.broker;
            if (!broker || broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
            const made = makeWakeSecret(broker, orgId, input.grantId);
            await runtime.execute('kernel.mcp.wake.rotate_secret', { grantId: input.grantId, credential: made.credential }, { actor, orgId });
            const [view] = await runtime.query<McpWakeView[]>('kernel.mcp.wake.get', { grantId: input.grantId }, { actor, orgId });
            if (!view) throw new DomainError('MCP_WAKE_NOT_FOUND', 404, 'Quyền kết nối này chưa có địa chỉ nhận');
            return { ...view, secret: made.secret };
          }),
        ),
        clear: os.mcp.wake.clear.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.mcp.wake.clear', input, { actor, orgId }))),
        test: os.mcp.wake.test.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.mcp.wake.test', input, { actor, orgId }))),
      },
    },
    extension: {
      tokens: {
        list: os.extension.tokens.list.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.extension.token.list', {}, { actor, orgId }))),
        revoke: os.extension.tokens.revoke.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.extension.token.revoke', input, { actor, orgId }))),
        listOrg: os.extension.tokens.listOrg.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.extension.token.list_org', {}, { actor, orgId }))),
        revokeMember: os.extension.tokens.revokeMember.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.extension.token.revoke_member', input, { actor, orgId }))),
      },
    },
    inbox: {
      list: os.inbox.list.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.inbox.list', input, { actor, orgId })),
      ),
      hidden: os.inbox.hidden.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.inbox.hidden', {}, { actor, orgId }))),
      get: os.inbox.get.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.inbox.get', input, { actor, orgId })),
      ),
      timeline: os.inbox.timeline.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.proposal.timeline', input, { actor, orgId }))),
      raised: os.inbox.raised.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.inbox.raised', {}, { actor, orgId }))),
      dismiss: os.inbox.dismiss.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.inbox.dismiss', input, { actor, orgId }))),
      originals: os.inbox.originals.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.inbox.originals', {}, { actor, orgId }))),
      dismissOriginal: os.inbox.dismissOriginal.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.inbox.original_dismiss', input, { actor, orgId }))),
      approve: os.inbox.approve.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.proposal.approve', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      approveMany: os.inbox.approveMany.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          const { results } = await runtime.execute<{ results: BulkApproveResult[] }>('kernel.proposal.approve_many', rest, { actor, orgId, idempotencyKey });
          return {
            results: results.map((r) => {
              if (r.outcome === 'refused') return r;
              const ids = r.result as { journalEntryId?: string; documentId?: string; reversedEntryId?: string; voidedDocumentId?: string; voucherId?: string };
              return {
                id: r.id,
                outcome: r.outcome,
                ...(ids.journalEntryId ? { journalEntryId: ids.journalEntryId } : {}),
                ...(ids.documentId ? { documentId: ids.documentId } : {}),
                ...(ids.reversedEntryId ? { reversedEntryId: ids.reversedEntryId } : {}),
                ...(ids.voidedDocumentId ? { voidedDocumentId: ids.voidedDocumentId } : {}),
                ...(ids.voucherId ? { voucherId: ids.voucherId } : {}),
              };
            }),
          };
        }),
      ),
      edit: os.inbox.edit.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.proposal.edit', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      reject: os.inbox.reject.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.proposal.reject', input, { actor, orgId })),
      ),
      // Asking again for an expired proposal: a finance one (the books' module is on wherever one exists) or an Ads one (#2294;
      // Ads depends on the kernel alone, so it can run without Finance).
      resubmit: os.inbox.resubmit.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.proposal.resubmit', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // A journal reversal or a cash or bank voucher (#327), both finance commands.
      request: os.inbox.request.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.proposal.request', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    inbound: {
      recent: os.inbound.recent.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.inbound.recent', {}, { actor, orgId }))),
    },
    files: {
      staged: os.files.staged.handler(({ context }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.files.staged', {}, { actor, orgId })),
      ),
      recent: os.files.recent.handler(({ context }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.files.recent', {}, { actor, orgId })),
      ),
      batch: os.files.batch.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.query('kernel.files.batch', input, { actor, orgId })),
      ),
      reextract: os.files.reextract.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('kernel.file.reextract', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    parties: {
      list: os.parties.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.vendors.list', input, { actor, orgId })),
      ),
      setDefaultAccount: os.parties.setDefaultAccount.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.vendor.set_default_account', input, { actor, orgId })),
      ),
      customers: os.parties.customers.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.customers.list', input, { actor, orgId })),
      ),
      timeline: os.parties.timeline.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.party.timeline', input, { actor, orgId }))),
      create: os.parties.create.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.party.create', input, { actor, orgId }))),
      update: os.parties.update.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.party.update', input, { actor, orgId }))),
      markDuplicate: os.parties.markDuplicate.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.party.mark_duplicate', input, { actor, orgId })),
      ),
      unmarkDuplicate: os.parties.unmarkDuplicate.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.party.unmark_duplicate', input, { actor, orgId })),
      ),
      setCompany: os.parties.setCompany.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.party.set_company', input, { actor, orgId }))),
      duplicateHints: os.parties.duplicateHints.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.party.duplicate_hints', {}, { actor, orgId }))),
    },
    documents: {
      list: os.documents.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.documents.list', input, { actor, orgId })),
      ),
      exports: os.documents.exports.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.document.exports', input, { actor, orgId }))),
    },
    notifications: {
      list: os.notifications.list.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.notification.list', {}, { actor, orgId }))),
      read: os.notifications.read.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.notification.read', input, { actor, orgId }))),
      mute: os.notifications.mute.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.notification.mute', input, { actor, orgId }))),
    },
    conversations: {
      list: os.conversations.list.handler(({ context, input }) => inOrg(context, async (orgId, actor) => markableListed((await runtime.query('kernel.conversation.list', input, { actor, orgId })) as ConversationListed, channels?.emailSenderCheck === true))),
      counts: os.conversations.counts.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.conversation.counts', input, { actor, orgId }))),
      postCounts: os.conversations.postCounts.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.conversation.post_counts', input, { actor, orgId }))),
      get: os.conversations.get.handler(({ context, input }) => inOrg(context, async (orgId, actor) => markableDetail((await runtime.query('kernel.conversation.get', input, { actor, orgId })) as ConversationDetail, channels?.emailSenderCheck === true))),
      reply: os.conversations.reply.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.reply', input, { actor, orgId }))),
      replyPrivately: os.conversations.replyPrivately.handler(({ context, input }) =>
        inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.reply_privately', input, { actor, orgId })),
      ),
      settle: os.conversations.settle.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.reply_settle', input, { actor, orgId }))),
      hide: os.conversations.hide.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.hide', input, { actor, orgId }))),
      assign: os.conversations.assign.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.assign', input, { actor, orgId }))),
      resolve: os.conversations.resolve.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.resolve', input, { actor, orgId }))),
      reopen: os.conversations.reopen.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.reopen', input, { actor, orgId }))),
      note: os.conversations.note.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.note', input, { actor, orgId }))),
      linkContact: os.conversations.linkContact.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.link_contact', input, { actor, orgId }))),
      followUp: os.conversations.followUp.handler(({ context, input }) => keyed(context, 'kernel.conversation.follow_up', input)),
      tasks: os.conversations.tasks.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.conversation.tasks', input, { actor, orgId }))),
      setIntent: os.conversations.setIntent.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.set_intent', input, { actor, orgId }))),
      // The Inbox's suggestions (CV3, #2306): the thread's text is read in the member's own transaction, then the model is called outside it, through the
      // AI meter. Nothing is stored; a model that is off, refused or failing leaves no suggestion and no error.
      // The org's switch for AI on its customers' messages (conversation_setting.auto_draft, ADR-0041 section 8) covers these too: with it off no word of a
      // customer or name of a contact reaches the model, and the answer is `off`.
      suggestIntents: os.conversations.suggestIntents.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          const { autoDraft } = await runtime.query<ConversationAutoDraft>('kernel.conversation.auto_draft', {}, { actor, orgId });
          if (!autoDraft) return { ai: 'off' as const, suggestions: [] };
          return suggestIntents(conversationAi, orgId, actor.userId, await runtime.query<IntentSource[]>('kernel.conversation.intent_source', input, { actor, orgId }));
        }),
      ),
      // The contacts by phone come first whatever the switch says (no model reads anything); only the ranking of name matches needs it.
      contactMatches: os.conversations.contactMatches.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          const found = await runtime.query<ContactCandidates>('kernel.conversation.contact_candidates', input, { actor, orgId });
          const { autoDraft } = await runtime.query<ConversationAutoDraft>('kernel.conversation.auto_draft', {}, { actor, orgId });
          return matchContacts(autoDraft ? conversationAi : { ...conversationAi, reader: null }, orgId, actor.userId, found);
        }),
      ),
      markRead: os.conversations.markRead.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.mark_read', input, { actor, orgId }))),
      // The inbox (CV3, #2306): the "you are replying" marker and the availability switch.
      composing: os.conversations.composing.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.composing', input, { actor, orgId }))),
      availability: os.conversations.availability.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.conversation.availability', {}, { actor, orgId }))),
      setAvailability: os.conversations.setAvailability.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.set_availability', input, { actor, orgId }))),
      // The command checks the connection and the role and returns the event; the body then takes the intake's own way, parked
      // for the worker with no tenant context, as a platform's notice does.
      retention: os.conversations.retention.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.conversation.retention', {}, { actor, orgId }))),
      setRetention: os.conversations.setRetention.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.retention_set', input, { actor, orgId }))),
      // Engage's wake rules (#3862): the org's N, read by every member and set by owners and admins in Settings.
      wakeRules: os.conversations.wakeRules.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.conversation.wake_rules', {}, { actor, orgId }))),
      setWakeRules: os.conversations.setWakeRules.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.wake_rules_set', input, { actor, orgId }))),
      eraseContact: os.conversations.eraseContact.handler(({ context, input }) => keyed(context, 'kernel.conversation.erase_contact', input)),
      channelCounts: os.conversations.channelCounts.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.conversation.channel_counts', input, { actor, orgId }))),
      eraseChannel: os.conversations.eraseChannel.handler(({ context, input }) => keyed(context, 'kernel.conversation.erase_channel', input)),
      // The sales coworker's "soạn" button: asking is rationed by the same per-member and per-org budget as the other AI drafts (ai-draft-limit.ts, #386), since each ask leads to a
      // paid model call in the worker; no counter of its own.
      draftRequest: os.conversations.draftRequest.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          const ticket = drafts.take(orgId, actor.type === 'user' ? actor.userId : 'system');
          if (!ticket.allowed) {
            throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
              retryAfterSeconds: ticket.retryAfterSeconds,
            });
          }
          try {
            return await runtime.execute('kernel.conversation.draft_request', input, { actor, orgId });
          } finally {
            ticket.release();
          }
        }),
      ),
      draftDiscard: os.conversations.draftDiscard.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.draft_discard', input, { actor, orgId }))),
      autoDraft: os.conversations.autoDraft.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.conversation.auto_draft', {}, { actor, orgId }))),
      setAutoDraft: os.conversations.setAutoDraft.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.auto_draft_set', input, { actor, orgId }))),
      youtubeComments: os.conversations.youtubeComments.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.conversation.youtube_comments', {}, { actor, orgId }))),
      setYoutubeComments: os.conversations.setYoutubeComments.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.youtube_comments_set', input, { actor, orgId }))),
      savedReplies: os.conversations.savedReplies.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.conversation.saved_reply_list', input, { actor, orgId }))),
      createSavedReply: os.conversations.createSavedReply.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.saved_reply_create', input, { actor, orgId }))),
      updateSavedReply: os.conversations.updateSavedReply.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.saved_reply_update', input, { actor, orgId }))),
      deleteSavedReply: os.conversations.deleteSavedReply.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.conversation.saved_reply_delete', input, { actor, orgId }))),
      sandboxComment: os.conversations.sandboxComment.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => {
          // The intake is shared by every org, so a demo comment is limited per org: thirty a minute.
          const stamp = Date.now();
          const recent = (sandboxStamps.get(orgId) ?? []).filter((t) => stamp - t < 60_000);
          if (recent.length >= 30) throw new ORPCError('TOO_MANY_REQUESTS', { status: 429, message: 'Tạo bình luận thử quá nhanh, hãy thử lại sau một phút' });
          sandboxStamps.set(orgId, [...recent, stamp]);
          const made = await runtime.execute<{ accountId: string; events: ConversationEvent[] }>('kernel.conversation.sandbox_comment', input, { actor, orgId });
          const body = sandboxNoticeBody({ ...made, connectionId: input.connectionId });
          await runtime.orgless(async (db) => {
            await sql`SELECT crove_kernel.conversation_inbound_enqueue('sandbox', ${body})`.execute(db);
          });
          return { queued: true as const };
        }),
      ),
    },
    savedViews: {
      list: os.savedViews.list.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.saved_view.list', input, { actor, orgId }))),
      save: os.savedViews.save.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.saved_view.save', input, { actor, orgId }))),
      rename: os.savedViews.rename.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.saved_view.rename', input, { actor, orgId }))),
      setShared: os.savedViews.setShared.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.saved_view.set_shared', input, { actor, orgId }))),
      remove: os.savedViews.remove.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.execute('kernel.saved_view.delete', input, { actor, orgId }))),
    },
    search: {
      query: os.search.query.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.search', input, { actor, orgId })),
      ),
    },
    journal: {
      list: os.journal.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.journal.list', input, { actor, orgId })),
      ),
      get: os.journal.get.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.journal.get', input, { actor, orgId })),
      ),
    },
    vouchers: {
      list: os.vouchers.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.vouchers.list', input, { actor, orgId })),
      ),
      // What would be sent to MISA AMIS Kế toán (#3901): a read over the same vouchers as the MISA SME export, in the caller's own context. It sends nothing and calls no one.
      misaAmisPreview: os.vouchers.misaAmisPreview.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => misaAmisPreview((name, query) => runtime.query(name, query, { actor, orgId }), input)),
      ),
      // F4 (security review of #4013): with the push switched off the command is not reached at all, so a confirmation made while it is off can never be sent within its seven days once it is turned on.
      // The switch is read before anything else (membership included): with it off the answer is the same 404 for everyone.
      misaAmisPush: os.vouchers.misaAmisPush.handler(({ context, input }) =>
        // `guard` turns the DomainError into its own status (404), as inside inFinance, but nothing of the org is read before the switch is.
        guard(async () => {
          const disabled = () => new DomainError('MISA_AMIS_PUSH_DISABLED', 404, 'Việc gửi chứng từ sang MISA chưa được bật trên hệ thống này');
          const amisOn = channels?.misaAmis === true && channels.misaAmisPush === true;
          const aspOn = channels?.misaAsp === true && channels.misaAspPush === true;
          // With both switches off nothing is read at all (F4): the same 404 for everyone.
          if (!amisOn && !aspOn) throw disabled();
          return inFinance(context, async (orgId, actor) => {
            // Where only one product's push is on, a connection of the other product answers the same 404 as a deployment with that push off (the product is the connection's own, read in the caller's context).
            if (!amisOn || !aspOn) {
              const rows = await runtime.query<MisaAmisConnection[]>('finance.misa_amis_connection.list', {}, { actor, orgId });
              // `zId` accepts a capital letter in a UUID, the database answers lower case: compare without the case, or a connection of the off product would pass the gate.
              const wanted = input.connectionId.toLowerCase();
              const product = rows.find((r) => r.id.toLowerCase() === wanted)?.product;
              if (product !== undefined && !(product === 'asp' ? aspOn : amisOn)) throw disabled();
            }
            return runtime.execute('finance.misa_amis.push', input, { actor, orgId });
          });
        }),
      ),
      // The preview is run again here, so what the model is told comes from the books, never from the caller; the notes are a read and change no voucher, blocker or push.
      misaAmisBlockerNotes: os.vouchers.misaAmisBlockerNotes.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const { lang, ...ask } = input;
          const preview = await misaAmisPreview((name, query) => runtime.query(name, query, { actor, orgId }), ask);
          // The wording follows the product of the connection of the entity the ask names (MISA ASP's catalogue cannot be changed from Ludy, so the fix reads differently, #4114); an ask that names none reads as AMIS.
          const connections = ask.legalEntityId === undefined ? [] : await runtime.query<MisaAmisConnection[]>('finance.misa_amis_connection.list', {}, { actor, orgId });
          const product = connections.find((c) => c.legalEntityId.toLowerCase() === ask.legalEntityId?.toLowerCase())?.product ?? 'amis';
          return explainMisaAmisBlockers(financeMisaAmisBlockerNotesAi, orgId, actor.userId, preview, lang ?? 'vi', product);
        }),
      ),
      // What MISA's import will refuse or cut in one of the seven exports (#3848): a read over the rows the file is built from, in the caller's own context. The export is unchanged and never waits for it.
      misaCheck: os.vouchers.misaCheck.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => misaCheck((name, query) => runtime.query(name, query, { actor, orgId }), input)),
      ),
      // The check is run again here, so what the model is told comes from the books, never from the caller; the sentence is a read and changes no voucher.
      misaCheckLine: os.vouchers.misaCheckLine.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const { lang, ...ask } = input;
          const check = await misaCheck((name, query) => runtime.query(name, query, { actor, orgId }), ask);
          return explainMisaCheckLine(financeMisaCheckLineAi, orgId, actor.userId, check, lang ?? 'vi');
        }),
      ),
    },
    openingBalance: {
      preview: os.openingBalance.preview.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.opening_balance.preview', input, { actor, orgId })),
      ),
      post: os.openingBalance.post.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.opening_balance.post', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    accounts: {
      list: os.accounts.list.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.accounts.list', {}, { actor, orgId })),
      ),
      create: os.accounts.create.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.account.create', input, { actor, orgId })),
      ),
      update: os.accounts.update.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.account.update', input, { actor, orgId })),
      ),
    },
    misaGoodsCodes: {
      list: os.misaGoodsCodes.list.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.misa_goods_codes.list', {}, { actor, orgId })),
      ),
      set: os.misaGoodsCodes.set.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.misa_goods_code.set', input, { actor, orgId })),
      ),
      remove: os.misaGoodsCodes.remove.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.misa_goods_code.remove', input, { actor, orgId })),
      ),
    },
    bankPartyRules: {
      list: os.bankPartyRules.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank_party_rules.list', input ?? {}, { actor, orgId })),
      ),
      remove: os.bankPartyRules.remove.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.bank_party_rule.remove', input, { actor, orgId })),
      ),
    },
    financeOverview: {
      get: os.financeOverview.get.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query<FinanceOverview>('finance.overview', input, { actor, orgId }))),
      // The sentence is asked of the model outside any transaction, from the figures the overview read in the member's own one (their legal entities only).
      explain: os.financeOverview.explain.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const { lang, ...ask } = input;
          const overview = await runtime.query<FinanceOverview>('finance.overview', ask, { actor, orgId });
          return explainOverview(financeOverviewAi, orgId, actor.userId, overview, lang ?? 'vi');
        }),
      ),
    },
    supplierBank: {
      list: os.supplierBank.list.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.supplier_bank_account.list', input, { actor, orgId }))),
      add: os.supplierBank.add.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.supplier_bank_account.add', input, { actor, orgId }))),
      replace: os.supplierBank.replace.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.supplier_bank_account.replace', input, { actor, orgId }))),
      retire: os.supplierBank.retire.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.supplier_bank_account.retire', input, { actor, orgId }))),
      erase: os.supplierBank.erase.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.supplier_bank_account.erase', input, { actor, orgId }))),
    },
    supplierPayment: {
      payable: os.supplierPayment.payable.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.supplier_payment.payable', input, { actor, orgId }))),
      // The facts are summed here from the list read in the caller's own transaction, so what the model is told comes from the books, never from the caller; the sentence is a read and asks for nothing.
      payableLine: os.supplierPayment.payableLine.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const list = await runtime.query<SupplierPayableList>('finance.supplier_payment.payable', {}, { actor, orgId });
          return explainSupplierPayableLine(financeSupplierPayableLineAi, orgId, actor.userId, list, input.lang ?? 'vi');
        }),
      ),
      list: os.supplierPayment.list.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.supplier_payment.list', input, { actor, orgId }))),
      confirmAccount: os.supplierPayment.confirmAccount.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.supplier_payment.confirm_account', input, { actor, orgId }))),
      cancel: os.supplierPayment.cancel.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.supplier_payment.cancel', input, { actor, orgId }))),
    },
    paymentReminders: {
      list: os.paymentReminders.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.payment_reminders.list', input ?? {}, { actor, orgId })),
      ),
      draft: os.paymentReminders.draft.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.payment_reminder.draft', input, { actor, orgId })),
      ),
      send: os.paymentReminders.send.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.payment_reminder.send', input, { actor, orgId })),
      ),
      // The wording is asked of the model outside any transaction, from the facts the draft read in the member's own one (their legal entities only).
      wording: os.paymentReminders.wording.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const draft = await runtime.query<PaymentReminderDraft>('finance.payment_reminder.draft', { partyId: input.partyId, ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}) }, { actor, orgId });
          return wordReminder(reminderAi, orgId, actor.userId, { level: draft.level, lang: draft.lang, org: draft.org }, input.hint);
        }),
      ),
      settings: {
        get: os.paymentReminders.settings.get.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.collection_setting.get', {}, { actor, orgId }))),
        set: os.paymentReminders.settings.set.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.collection_setting.set', input, { actor, orgId }))),
      },
      customer: {
        get: os.paymentReminders.customer.get.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.customer_collection.get', input, { actor, orgId }))),
        set: os.paymentReminders.customer.set.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.customer_collection.set', input, { actor, orgId }))),
      },
    },
    household: {
      profile: os.household.profile.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.household.profile_get', input, { actor, orgId }))),
      profileSet: os.household.profileSet.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.household.profile_set', input, { actor, orgId }))),
      rules: os.household.rules.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.household.rules', input ?? {}, { actor, orgId }))),
      s1a: os.household.s1a.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.household.s1a', input, { actor, orgId }))),
      cnkd: os.household.cnkd.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.household.cnkd', input, { actor, orgId }))),
      s2a: os.household.s2a.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.household.s2a', input, { actor, orgId }))),
      s2b: os.household.s2b.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.household.s2b', input, { actor, orgId }))),
      s2c: os.household.s2c.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.household.s2c', input, { actor, orgId }))),
      s2d: os.household.s2d.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.household.s2d', input, { actor, orgId }))),
      s2e: os.household.s2e.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.household.s2e', input, { actor, orgId }))),
    },
    einvoice: {
      status: os.einvoice.status.handler(async () => ({ sandbox: Boolean(einvoiceProviderOf('sandbox')) })),
      // What the connect form may offer: the providers this deployment enabled, never a credential or a host.
      providers: os.einvoice.providers.handler(({ context }) =>
        inFinance(context, async () => Object.entries(channels?.einvoiceProviders ?? {}).map(([id, provider]) => ({ id, offline: provider.hosts.length === 0, connectFields: [...provider.connectFields] }))),
      ),
      // The org's own account at a provider (ADR-0044 point 2). The fields it types are sealed here, once; the command gets the envelope, never the secret, and only the
      // worker opens it. A provider whose signature needs the seller's own token is refused before anything is sealed.
      connections: {
        list: os.einvoice.connections.list.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.einvoice_connection.list', {}, { actor, orgId }))),
        connect: os.einvoice.connections.connect.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được nhà cung cấp hóa đơn điện tử');
            const provider = einvoiceProviderOf(input.provider);
            if (!provider || !channels) throw new DomainError('EINVOICE_DISABLED', 404, 'Nhà cung cấp hóa đơn điện tử này chưa được bật');
            if (provider.capabilities.signing === 'seller_token') {
              throw new DomainError('EINVOICE_SIGNING_TOKEN', 422, 'Nhà cung cấp này ký hóa đơn bằng chữ ký số nằm trên máy của người bán, Ludy không dùng được cách đó; hãy dùng nhà cung cấp ký trên máy chủ của họ');
            }
            const fields = Object.keys(input.fields);
            if (fields.length !== provider.connectFields.length || !provider.connectFields.every((name) => Object.hasOwn(input.fields, name))) {
              throw new DomainError('EINVOICE_FIELDS', 422, 'Hãy nhập đủ các thông tin mà nhà cung cấp yêu cầu, không thêm thông tin khác');
            }
            const seller = await runtime.query<{ legalEntityId: string; sellerTaxCode: string }>(
              'finance.einvoice_connection.target',
              { legalEntityId: input.legalEntityId, sellerTaxCode: input.sellerTaxCode },
              { actor, orgId },
            );
            const channelProvider = `einvoice_${input.provider}`;
            // The account is the entity's under this provider, so a second connect of it is the same connection. The seller's tax code is not in it, nor in the display name:
            // the channel row stays as history after a disconnect, and a household's tax code is its owner's national ID. Only the finance row holds the code, and it goes with the
            // disconnect.
            const externalAccountId = seller.legalEntityId;
            // The offline provider has no account: it is sealed with its own fixed word, so a credential row exists for the flow and holds nothing of the org's.
            const secret = provider.hosts.length === 0 ? SANDBOX_EINVOICE_SECRET : JSON.stringify(input.fields);
            const sealed = channels.broker.seal(secret, { orgId, provider: channelProvider, externalAccountId });
            const connected = await runtime.execute<{ id: string }>(
              'finance.einvoice_connection.connect',
              {
                provider: input.provider,
                legalEntityId: seller.legalEntityId,
                sellerTaxCode: seller.sellerTaxCode,
                displayName: provider.hosts.length === 0 ? 'Nhà cung cấp hóa đơn thử nghiệm' : input.provider,
                credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
              },
              { actor, orgId },
            );
            return { id: connected.id };
          }),
        ),
        test: os.einvoice.connections.test.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới kiểm tra được kết nối hóa đơn điện tử');
            const rows = await runtime.query<EInvoiceConnection[]>('finance.einvoice_connection.list', {}, { actor, orgId });
            const row = rows.find((r) => r.id === input.id);
            if (!row) throw new DomainError('EINVOICE_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối hóa đơn điện tử này');
            const provider = einvoiceProviderOf(row.provider);
            if (!provider) throw new DomainError('EINVOICE_DISABLED', 404, 'Nhà cung cấp hóa đơn điện tử này chưa được bật');
            // The API never opens a credential: a provider that is reached over the network is tested by the worker (a later build, with its adapter). The offline
            // provider reaches no host and needs no credential, so its test runs here.
            if (provider.hosts.length > 0) throw new DomainError('EINVOICE_PROVIDER_NOT_READY', 503, 'Nhà cung cấp này chưa kiểm tra được từ màn hình, sẽ có khi bộ kết nối của nó hoàn thành');
            let state: ConnectionState;
            let templates: EInvoiceSeriesTemplate[] = [];
            try {
              state = await provider.testConnection(SANDBOX_EINVOICE_SECRET);
              if (state === 'works') templates = await provider.listTemplates(SANDBOX_EINVOICE_SECRET);
            } catch (error) {
              state = error instanceof EInvoiceProviderError && error.kind === 'credentials' ? 'wrong_credentials' : 'unreachable';
            }
            return runtime.execute('finance.einvoice_connection.record_test', { id: row.id, state, templates }, { actor, orgId });
          }),
        ),
        disconnect: os.einvoice.connections.disconnect.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới ngắt được kết nối hóa đơn điện tử');
            const rows = await runtime.query<EInvoiceConnection[]>('finance.einvoice_connection.list', {}, { actor, orgId });
            const row = rows.find((r) => r.id === input.id);
            if (!row) return { removed: false };
            // The credential goes first: a failure after it leaves a row of a closed connection that a second disconnect removes, never a live credential with no row.
            await runtime.execute('kernel.channel.disconnect', { connectionId: row.connectionId }, { actor, orgId });
            return runtime.execute<{ removed: boolean }>('finance.einvoice_connection.unlink', { id: row.id }, { actor, orgId });
          }),
        ),
      },
      series: {
        list: os.einvoice.series.list.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.einvoice_series.list', {}, { actor, orgId }))),
        sync: os.einvoice.series.sync.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            if (!einvoiceProviderOf('sandbox')) throw new DomainError('EINVOICE_DISABLED', 404, 'Nhà cung cấp hóa đơn điện tử thử nghiệm chưa được bật');
            return runtime.execute('finance.einvoice_series.sync', input, { actor, orgId });
          }),
        ),
        setDefault: os.einvoice.series.setDefault.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.einvoice_series.set_default', input, { actor, orgId }))),
      },
      drafts: {
        list: os.einvoice.drafts.list.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.einvoice_draft.list', input ?? {}, { actor, orgId }))),
        get: os.einvoice.drafts.get.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.einvoice_draft.get', input, { actor, orgId }))),
        check: os.einvoice.drafts.check.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.einvoice_draft.check', input, { actor, orgId }))),
        save: os.einvoice.drafts.save.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.einvoice_draft.save', input, { actor, orgId }))),
        fromOrder: os.einvoice.drafts.fromOrder.handler(({ context, input }) =>
          inFinance(context, (orgId, actor) => {
            const { idempotencyKey, ...rest } = input;
            return runtime.execute('finance.einvoice.draft_from_order', rest, { actor, orgId, idempotencyKey });
          }),
        ),
        orderLines: os.einvoice.drafts.orderLines.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.einvoice_draft.order_lines', input, { actor, orgId }))),
        delete: os.einvoice.drafts.delete.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.einvoice_draft.delete', input, { actor, orgId }))),
        startCorrection: os.einvoice.drafts.startCorrection.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.einvoice.start_correction', input, { actor, orgId }))),
        // The VAT rate a correction proposes for the nature picked (#3709): the code's proposal read in the member's own transaction, then the coworker's explanation outside any transaction.
        correctionRate: os.einvoice.drafts.correctionRate.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            const proposal = await runtime.query<EInvoiceCorrectionRate>('finance.einvoice.correction_rate', input, { actor, orgId });
            return explainCorrectionRate(einvoiceRateCoworker, orgId, actor.userId, proposal);
          }),
        ),
        // The coworker's proposal of the reason code (#3690): the source is read in the member's own transaction, the model is asked outside any transaction; the note typed is not stored.
        suggestReason: os.einvoice.drafts.suggestReason.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            const source = await runtime.query<EInvoiceReasonSource>('finance.einvoice.reason_source', { originalDraftId: input.originalDraftId }, { actor, orgId });
            return suggestCorrectionReason(einvoiceReasonCoworker, orgId, actor.userId, source, input);
          }),
        ),
        correctionOptions: os.einvoice.drafts.correctionOptions.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.einvoice.correction_options', input, { actor, orgId }))),
        noticeOpen: os.einvoice.drafts.noticeOpen.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.einvoice.notice_open', input, { actor, orgId }))),
        noticeStep: os.einvoice.drafts.noticeStep.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.einvoice.notice_step', input, { actor, orgId }))),
        noticeList: os.einvoice.drafts.noticeList.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.einvoice.notice_list', input, { actor, orgId }))),
        issueRequest: os.einvoice.drafts.issueRequest.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.einvoice.issue_request', input, { actor, orgId }))),
        // The coworker's proposal for the form (#2505): the model is asked outside any transaction, from what the member's own read said it may see.
        previousInvoice: os.einvoice.drafts.previousInvoice.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.einvoice_draft.previous_invoice', input, { actor, orgId }))),
        suggest: os.einvoice.drafts.suggest.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            const source = await runtime.query<EInvoiceSuggestSource>('finance.einvoice_draft.suggest_source', input, { actor, orgId });
            return suggestEInvoiceDraft(einvoiceCoworker, orgId, actor.userId, source, input);
          }),
        ),
      },
    },
    marketplace: {
      // What the connect card may offer (#2519): the adapters this deployment enabled with the platforms each serves, and every platform with whether an adapter serves it. A platform with
      // none is read from the report file the org brings. Never a credential or a host.
      providers: os.marketplace.providers.handler(({ context }) =>
        inFinance(context, async () => {
          const adapters = Object.entries(channels?.marketplaceProviders ?? {}).map(([id, provider]) => ({
            id,
            offline: provider.hosts.length === 0,
            connectFields: [...provider.connectFields],
            platforms: (Object.keys(provider.capabilities.platforms) as Array<(typeof MARKETPLACE_PLATFORM_KEYS)[number]>).sort(),
          }));
          return {
            adapters,
            platforms: MARKETPLACE_PLATFORM_KEYS.map((platform) => {
              const serving = adapters.filter((a) => a.platforms.includes(platform)).map((a) => a.id);
              return { platform, adapter: serving.length > 0, adapters: serving };
            }),
          };
        }),
      ),
      // The org's own seller account at a marketplace (ADR-0045 point 7). The fields it types are sealed here, once; the command gets the envelope, never the secret, and only the worker opens it.
      connections: {
        list: os.marketplace.connections.list.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace_connection.list', {}, { actor, orgId }))),
        connect: os.marketplace.connections.connect.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được sàn thương mại điện tử');
            const provider = marketplaceProviderOf(input.adapter);
            if (!provider || !channels) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Bộ kết nối sàn này chưa được bật');
            if (!Object.hasOwn(provider.capabilities.platforms, input.platform)) throw new DomainError('MARKETPLACE_PLATFORM', 422, 'Bộ kết nối này chưa đọc được sàn đã chọn; hãy nhập file báo cáo của sàn');
            if (Object.keys(input.fields).length !== provider.connectFields.length || !provider.connectFields.every((name) => Object.hasOwn(input.fields, name))) {
              throw new DomainError('MARKETPLACE_FIELDS', 422, 'Hãy nhập đủ các thông tin mà sàn yêu cầu, không thêm thông tin khác');
            }
            const target = await runtime.query<{ legalEntityId: string }>(
              'finance.marketplace_connection.target',
              { adapter: input.adapter, platform: input.platform, legalEntityId: input.legalEntityId },
              { actor, orgId },
            );
            const channelProvider = `marketplace_${input.adapter}`;
            const externalAccountId = `${target.legalEntityId}:${input.platform}`;
            // The offline provider has no account: it is sealed with its own fixed word, so a credential row exists for the flow and holds nothing of the org's.
            const secret = provider.hosts.length === 0 ? SANDBOX_MARKETPLACE_SECRET : JSON.stringify(input.fields);
            const sealed = channels.broker.seal(secret, { orgId, provider: channelProvider, externalAccountId });
            const connected = await runtime.execute<{ id: string }>(
              'finance.marketplace_connection.connect',
              {
                adapter: input.adapter,
                platform: input.platform,
                legalEntityId: target.legalEntityId,
                displayName: provider.hosts.length === 0 ? `Sàn thử nghiệm (${input.platform})` : `${input.adapter} (${input.platform})`,
                credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
                // The App Key is a public identifier, stored in the clear beside the sealed secret it belongs to (the same handler makes both, so they never disagree).
                ...(isMarketplaceAuthorized(input.adapter) ? { appKey: input.fields.appKey } : {}),
              },
              { actor, orgId },
            );
            // An adapter whose connect fields hold no access token (Lazada: App Key and App Secret) is connected but not authorized: that is known from what was sealed, not from a test, so it is recorded
            // now with the state the card words as "not authorized yet" (the authorize step, S2b, replaces it). The credential is not opened here.
            if (provider.hosts.length > 0 && input.adapter === 'lazada') {
              await runtime.execute('finance.marketplace_connection.record_test', { id: connected.id, state: 'api_not_enabled' }, { actor, orgId });
            }
            return { id: connected.id };
          }),
        ),
        test: os.marketplace.connections.test.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới kiểm tra được kết nối sàn');
            const rows = await runtime.query<MarketplaceConnection[]>('finance.marketplace_connection.list', {}, { actor, orgId });
            const row = rows.find((r) => r.id === input.id);
            if (!row) throw new DomainError('MARKETPLACE_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối sàn này');
            const provider = marketplaceProviderOf(row.provider.slice('marketplace_'.length));
            if (!provider) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Bộ kết nối sàn này chưa được bật');
            // The API never opens a credential: a provider reached over the network is tested by the worker, which records the state (the card shows it on its next read). The offline provider reaches
            // no host and needs no credential, so its test runs here.
            if (provider.hosts.length > 0) {
              await runtime.execute('finance.marketplace_connection.request_test', { id: row.id }, { actor, orgId });
              return { queued: true as const };
            }
            let state: MarketplaceTestResult;
            try {
              state = await provider.testConnection(SANDBOX_MARKETPLACE_SECRET);
            } catch (error) {
              state = error instanceof MarketplaceProviderError && error.kind === 'credentials' ? 'wrong_credentials' : 'unreachable';
            }
            return runtime.execute('finance.marketplace_connection.record_test', { id: row.id, state }, { actor, orgId });
          }),
        ),
        disconnect: os.marketplace.connections.disconnect.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới ngắt được kết nối sàn');
            const rows = await runtime.query<MarketplaceConnection[]>('finance.marketplace_connection.list', {}, { actor, orgId });
            const row = rows.find((r) => r.id === input.id);
            if (!row) return { removed: false };
            // The credential goes first: a failure after it leaves a row of a closed connection that a second disconnect removes, never a live credential with no row.
            await runtime.execute('kernel.channel.disconnect', { connectionId: row.connectionId }, { actor, orgId });
            return runtime.execute<{ removed: boolean }>('finance.marketplace_connection.unlink', { id: row.id }, { actor, orgId });
          }),
        ),
        // The seller's authorization on the platform's own page (#4238). The API makes the state (random; only its hash is stored, with the member and the connection) and builds the address from the App Key kept in
        // the clear; it opens no credential. The return is checked by the finance command (single use, this member, this org, 10 minutes) and the code is sealed here and traded by the worker alone.
        authorizeStart: os.marketplace.connections.authorizeStart.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới cấp quyền được cho kết nối sàn');
            const rows = await runtime.query<MarketplaceConnection[]>('finance.marketplace_connection.list', {}, { actor, orgId });
            const row = rows.find((r) => r.id === input.id);
            if (!row) throw new DomainError('MARKETPLACE_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối sàn này');
            const provider = marketplaceProviderOf(row.provider.slice('marketplace_'.length));
            if (!provider) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Bộ kết nối sàn này chưa được bật');
            if (!provider.authorizeUrl) throw new DomainError('MARKETPLACE_AUTHORIZE_UNSUPPORTED', 422, 'Kết nối này không cần cấp quyền trên sàn');
            // Without the public address the return address would be a relative one that the platform refuses.
            if (!channels?.publicUrl) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Bộ kết nối sàn này chưa được bật');
            const attempt = newOAuthAttempt(false);
            const begun = await runtime.execute<{ appKey: string; expiresAt: string }>('finance.marketplace_connection.authorize_begin', { id: row.id, stateHash: attempt.stateHash }, { actor, orgId });
            const redirectUri = `${(channels?.publicUrl ?? '').replace(/\/$/, '')}/marketplace/oauth/${row.provider.slice('marketplace_'.length)}/callback`;
            return { authorizeUrl: provider.authorizeUrl({ appKey: begun.appKey, redirectUri, state: attempt.state }), expiresAt: begun.expiresAt };
          }),
        ),
        authorizeFinish: os.marketplace.connections.authorizeFinish.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới cấp quyền được cho kết nối sàn');
            if (!channels) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Bộ kết nối sàn này chưa được bật');
            const stateHash = oauthStateHash(input.state);
            const found = await runtime.query<{ id: string; provider: string; externalAccountId: string }>('finance.marketplace_connection.authorize_lookup', { stateHash }, { actor, orgId });
            if (!marketplaceProviderOf(found.provider.slice('marketplace_'.length))?.authorizeUrl) throw new DomainError('MARKETPLACE_AUTHORIZE_UNSUPPORTED', 422, 'Kết nối này không cần cấp quyền trên sàn');
            // The code is sealed under a binding of its own and never opened here; the worker opens it.
            const sealed = channels.broker.seal(input.code, { orgId, provider: found.provider, externalAccountId: found.externalAccountId });
            return runtime.execute<{ id: string }>('finance.marketplace_connection.authorize_finish', { stateHash, codeKeyId: sealed.keyId, codeEnvelope: sealed.envelope.toString('base64') }, { actor, orgId });
          }),
        ),
        pollNow: os.marketplace.connections.pollNow.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới lấy đơn từ sàn được');
            const rows = await runtime.query<MarketplaceConnection[]>('finance.marketplace_connection.list', {}, { actor, orgId });
            const row = rows.find((r) => r.id === input.id);
            if (!row) throw new DomainError('MARKETPLACE_CONNECTION_NOT_FOUND', 404, 'Không tìm thấy kết nối sàn này');
            const provider = marketplaceProviderOf(row.provider.slice('marketplace_'.length));
            if (!provider) throw new DomainError('MARKETPLACE_DISABLED', 404, 'Bộ kết nối sàn này chưa được bật');
            // Only the offline provider is pulled from a button: a real adapter is polled by the worker on its own schedule, once it is built and reviewed.
            if (provider.hosts.length > 0) throw new DomainError('MARKETPLACE_PROVIDER_NOT_READY', 503, 'Bộ kết nối này chưa lấy đơn được từ màn hình, sẽ có khi bộ kết nối của nó hoàn thành');
            return runtime.execute<{ queued: boolean }>('finance.marketplace_connection.request_poll', { id: row.id }, { actor, orgId });
          }),
        ),
      },
      staged: os.marketplace.staged.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace.staged', {}, { actor, orgId }))),
      balance: os.marketplace.balance.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace.balance', input ?? {}, { actor, orgId }))),
      facts: os.marketplace.facts.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace.facts', input ?? {}, { actor, orgId }))),
      // What the screen lets a person act on (#2516 slice F): a read; the actions are inbox.request of the finance commands.
      worklist: os.marketplace.worklist.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace.worklist', input ?? {}, { actor, orgId }))),
      // The facts are read again here in the caller's own transaction, so what the model is told comes from the books, never from the caller; the sentence is a read and posts nothing.
      line: os.marketplace.line.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const { lang, legalEntityId } = input;
          const facts = await runtime.query<MarketplaceFacts>('finance.marketplace.facts', legalEntityId === undefined ? {} : { legalEntityId }, { actor, orgId });
          return explainMarketplaceLine(financeMarketplaceLineAi, orgId, actor.userId, facts, lang ?? 'vi');
        }),
      ),
      // The balance is loaded again here in the caller's own transaction, so what the model is told comes from the books, never from the caller; the notes are a read and post nothing.
      feeNotes: os.marketplace.feeNotes.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const { lang, legalEntityId } = input;
          const balance = await runtime.query<MarketplaceBalance>('finance.marketplace.balance', legalEntityId === undefined ? {} : { legalEntityId }, { actor, orgId });
          return explainMarketplaceFees(financeMarketplaceFeeNoteAi, orgId, actor.userId, balance, MARKETPLACE_FEE_CYCLE_DAYS, lang ?? 'vi');
        }),
      ),
      // The columns of a report no platform profile fits (#4036, slice 1c of #3850). The file is read by the worker through the extract sandbox, which the API cannot reach: a check is a request row and a job.
      columnsCheck: os.marketplace.columnsCheck.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.marketplace.columns_check', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      columnsFiles: os.marketplace.columnsFiles.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace.columns_files', {}, { actor, orgId }))),
      columns: os.marketplace.columns.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace.columns', input, { actor, orgId }))),
      // Ly's first mapping, from the masked sheet the worker recorded (read again here in the caller's own context, so the model is told what the file shows, never what the caller says); a read that stores nothing.
      columnsProposal: os.marketplace.columnsProposal.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const status = await runtime.query<MarketplaceColumnsStatus>('finance.marketplace.columns', { fileId: input.fileId }, { actor, orgId });
          return proposeMarketplaceColumns(financeMarketplaceColumnsAi, orgId, actor.userId, status.sheet, input.lang ?? 'vi');
        }),
      ),
      // Saves the mapping of a passed check (#4037): the command re-reads the file's check in its own transaction and refuses anything that is not the same file, platform and mapping the person saw checked.
      columnsConfirm: os.marketplace.columnsConfirm.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.marketplace.columns_confirm', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      columnsProfile: os.marketplace.columnsProfile.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace.columns_profile', input, { actor, orgId }))),
      preview: os.marketplace.preview.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace.preview', input, { actor, orgId }))),
      confirm: os.marketplace.confirm.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.marketplace.confirm', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      reject: os.marketplace.reject.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.marketplace.reject', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      orders: os.marketplace.orders.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace.orders', input ?? {}, { actor, orgId }))),
      unassigned: os.marketplace.unassigned.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace.unassigned', input ?? {}, { actor, orgId }))),
      assign: os.marketplace.assign.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.marketplace.assign', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // The coworker's proposal of the item of unassigned lines (#2686): the source (product name and SKU text, the entity's items) is read in the member's own transaction, the model is asked outside any
      // transaction through the same stock coworker, budget and cache. Nothing is written; the person assigns.
      suggest: os.marketplace.suggest.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const source = await runtime.query<MarketplaceSuggestSource>('finance.marketplace.suggest_source', input, { actor, orgId });
          return suggestMarketplaceItems(stockCoworker, orgId, actor.userId, source, input.lang ?? 'vi');
        }),
      ),
      unassign: os.marketplace.unassign.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.marketplace.unassign', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      incomeStaged: os.marketplace.incomeStaged.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace_income.staged', {}, { actor, orgId }))),
      incomePreview: os.marketplace.incomePreview.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.marketplace_income.preview', input, { actor, orgId }))),
      incomeConfirm: os.marketplace.incomeConfirm.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.marketplace_income.confirm', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      incomeReject: os.marketplace.incomeReject.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.marketplace_income.reject', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    // An entity's connection to MISA AMIS Kế toán (#3875, S2 of #3854). The access code the customer made in AMIS is sealed here, once; the command gets the envelope, never the code, and only a
    // worker may open it. The connector is on only when this deployment holds the integrator's ClientID: without it no connect is possible and the card says the connector is off.
    misaAmis: {
      status: os.misaAmis.status.handler(({ context }) => inFinance(context, async () => ({ offered: channels?.misaAmis === true, pushOffered: channels?.misaAmis === true && channels?.misaAmisPush === true, aspOffered: channels?.misaAsp === true, aspPushOffered: channels?.misaAsp === true && channels?.misaAspPush === true }))),
      connections: {
        list: os.misaAmis.connections.list.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.misa_amis_connection.list', {}, { actor, orgId }))),
        connect: os.misaAmis.connections.connect.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được MISA AMIS');
            // Each product is on only with its own ClientID (#4111): a deployment that holds AMIS's offers no ASP connection, and the other way round.
            if (!channels || !(input.product === 'asp' ? channels.misaAsp : channels.misaAmis)) throw new DomainError('MISA_AMIS_DISABLED', 404, input.product === 'asp' ? 'Bộ kết nối MISA ASP chưa được bật trên hệ thống này' : 'Bộ kết nối MISA AMIS chưa được bật trên hệ thống này');
            const target = await runtime.query<{ legalEntityId: string }>('finance.misa_amis_connection.target', { legalEntityId: input.legalEntityId }, { actor, orgId });
            // The account is the entity's, so a second connect of it is the same connection. The access code is not in the display name or the account id: the channel row stays as history after a disconnect.
            const sealed = channels.broker.seal(input.accessCode, { orgId, provider: misaChannelProvider(input.product), externalAccountId: target.legalEntityId });
            const connected = await runtime.execute<{ id: string }>(
              'finance.misa_amis_connection.connect',
              { legalEntityId: target.legalEntityId, product: input.product, displayName: input.product === 'asp' ? 'MISA ASP' : 'MISA AMIS Kế toán', credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
              { actor, orgId },
            );
            return { id: connected.id };
          }),
        ),
        disconnect: os.misaAmis.connections.disconnect.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới ngắt được kết nối MISA AMIS');
            const rows = await runtime.query<MisaAmisConnection[]>('finance.misa_amis_connection.list', {}, { actor, orgId });
            const row = rows.find((r) => r.id === input.id);
            if (!row) return { removed: false };
            // Vouchers still awaiting MISA's answer refuse the disconnect before anything is revoked: the access code stays, so their results can still be read.
            await runtime.query('finance.misa_amis_connection.can_disconnect', { id: row.id }, { actor, orgId });
            // The credential goes first: a failure after it leaves a row of a closed connection that a second disconnect removes, never a live access code with no row.
            await runtime.execute('kernel.channel.disconnect', { connectionId: row.connectionId }, { actor, orgId });
            return runtime.execute<{ removed: boolean }>('finance.misa_amis_connection.unlink', { id: row.id }, { actor, orgId });
          }),
        ),
        // The test is the worker's (S2b, #3885): the command queues it and the worker opens the access code and asks AMIS. The answer here is only "queued"; the list shows the state when it lands.
        test: os.misaAmis.connections.test.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới kiểm tra được kết nối MISA AMIS');
            // The product of the connection decides which ClientID must be held; a connection that is not found falls through to the command's own 404.
            const rows = await runtime.query<MisaAmisConnection[]>('finance.misa_amis_connection.list', {}, { actor, orgId });
            const wanted = input.id.toLowerCase();
            const product = rows.find((r) => r.id.toLowerCase() === wanted)?.product;
            if (product !== undefined && !(product === 'asp' ? channels?.misaAsp : channels?.misaAmis)) throw new DomainError('MISA_AMIS_DISABLED', 404, product === 'asp' ? 'Bộ kết nối MISA ASP chưa được bật trên hệ thống này' : 'Bộ kết nối MISA AMIS chưa được bật trên hệ thống này');
            return runtime.execute<{ queued: boolean }>('finance.misa_amis_connection.request_test', { id: input.id }, { actor, orgId });
          }),
        ),
        // The MISA name of a unit of Ludy on a MISA ASP connection (#4125): typed as the catalogue spells it, or cleared; the next check validates it. Owner or admin; nothing is sent by it.
        setUnitAlias: os.misaAmis.connections.setUnitAlias.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới đặt được tên đơn vị tính của kết nối MISA');
            return runtime.execute<{ saved: boolean }>('finance.misa_amis_connection.set_unit_alias', input, { actor, orgId });
          }),
        ),
        // The default item of a connection for service lines or sales lines (S3b, #4124): kept as typed, or cleared; the next check validates it against the catalogue. Owner or admin; no switch gates it (nothing is sent).
        setDefaultItem: os.misaAmis.connections.setDefaultItem.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới đặt được mặt hàng mặc định của kết nối MISA');
            return runtime.execute<{ saved: boolean }>('finance.misa_amis_connection.set_default_item', input, { actor, orgId });
          }),
        ),
      },
      // The check of a connection's vouchers against the firm's own catalogue is the worker's too (S3a, #4112): the command files the request and queues the job; the preview shows the result when it lands.
      matches: {
        check: os.misaAmis.matches.check.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới kiểm tra được chứng từ với danh mục MISA');
            // The check job reads the catalogue with the client of the connection's product and opens only an access code sealed for that product (misa-amis-match-job.ts, #4152): the check is never queued to fail.
            await requireMisaConnectorOf(actor, orgId, input.id);
            return runtime.execute<{ queued: boolean; running: boolean }>('finance.misa_amis_match.request_check', input, { actor, orgId });
          }),
        ),
        // The name proposals of the last check and a person's decision on one (S3b, #4124). Owner or admin; nothing is gated by the push switch (nothing is sent by a decision), only by the connector of the connection's product being there.
        proposals: os.misaAmis.matches.proposals.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới xem được các đề xuất khớp theo tên');
            await requireMisaConnectorOf(actor, orgId, input.connectionId);
            return runtime.query('finance.misa_amis_match.proposals', input, { actor, orgId });
          }),
        ),
        units: os.misaAmis.matches.units.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới xem được các đơn vị tính chưa khớp');
            await requireMisaConnectorOf(actor, orgId, input.connectionId);
            return runtime.query('finance.misa_amis_match.units', input, { actor, orgId });
          }),
        ),
        confirmName: os.misaAmis.matches.confirmName.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới xác nhận được đề xuất khớp theo tên');
            await requireMisaConnectorOf(actor, orgId, input.connectionId);
            return runtime.execute<{ decided: boolean }>('finance.misa_amis_match.confirm_name', input, { actor, orgId });
          }),
        ),
        rejectName: os.misaAmis.matches.rejectName.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            await requireOwnerOrAdmin(context, 'Chỉ chủ sở hữu hoặc quản trị viên mới từ chối được đề xuất khớp theo tên');
            await requireMisaConnectorOf(actor, orgId, input.connectionId);
            return runtime.execute<{ decided: boolean }>('finance.misa_amis_match.reject_name', input, { actor, orgId });
          }),
        ),
      },
      // The vouchers pushed through a connection (#3902, S3b-2): every role reads the rows; an owner or admin settles one MISA never answered for. Neither is gated by the push switch: rows pushed earlier stay readable
      // and settleable while it is off (nothing is sent by either).
      pushes: {
        list: os.misaAmis.pushes.list.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.misa_amis.push_list', input, { actor, orgId }))),
        // An `ambiguous` row settled "in AMIS" while the push is off becomes `sent` and waits: the worker that reads its result is not running, so the row is settled again after the 24 hours (an edge: ambiguous rows exist only where the push was on).
        resolve: os.misaAmis.pushes.resolve.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.misa_amis.push_resolve', input, { actor, orgId }))),
      },
    },
    stock: {
      items: {
        list: os.stock.items.list.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.stock_item.list', input ?? {}, { actor, orgId }))),
        save: os.stock.items.save.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.stock_item.save', input, { actor, orgId }))),
        setActive: os.stock.items.setActive.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.stock_item.set_active', input, { actor, orgId }))),
      },
      aliases: {
        teach: os.stock.aliases.teach.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.stock_alias.teach', input, { actor, orgId }))),
        forget: os.stock.aliases.forget.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.stock_alias.forget', input, { actor, orgId }))),
      },
      moves: {
        list: os.stock.moves.list.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.stock_move.list', input, { actor, orgId }))),
        reverse: os.stock.moves.reverse.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.stock_move.reverse', input, { actor, orgId }))),
        return: os.stock.moves.return.handler(({ context, input }) =>
          inFinance(context, (orgId, actor) => {
            const { idempotencyKey, ...rest } = input;
            return runtime.execute('finance.stock_move.return', rest, { actor, orgId, idempotencyKey });
          }),
        ),
      },
      unassigned: os.stock.unassigned.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.stock.unassigned', input ?? {}, { actor, orgId }))),
      moveFromOrderLine: os.stock.moveFromOrderLine.handler(({ context, input }) =>
          inFinance(context, (orgId, actor) => {
            const { idempotencyKey, ...rest } = input;
            return runtime.execute('finance.stock.move_from_order_line', rest, { actor, orgId, idempotencyKey });
          }),
        ),
      assign: os.stock.assign.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.stock.assign', input, { actor, orgId }))),
      report: os.stock.report.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.stock.report', input, { actor, orgId }))),
      card: os.stock.card.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.stock.card', input, { actor, orgId }))),
      periods: os.stock.periods.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.stock.periods', input, { actor, orgId }))),
      closeCheck: os.stock.closeCheck.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.stock.close_check', input, { actor, orgId }))),
      closeEmpty: os.stock.closeEmpty.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.stock.close_empty', input, { actor, orgId }))),
      // The coworker's reads (#2514): the model is asked outside any transaction, from what the member's own read said it may see.
      suggest: os.stock.suggest.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const source = await runtime.query<SuggestSource>('finance.stock.suggest_source', input, { actor, orgId });
          return suggestItems(stockCoworker, orgId, actor.userId, source, input.lang ?? 'vi');
        }),
      ),
      low: os.stock.low.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.stock.low', input ?? {}, { actor, orgId }))),
      reorderDraft: os.stock.reorderDraft.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const source = await runtime.query<ReorderSource>('finance.stock.reorder_source', input, { actor, orgId });
          return draftReorder(stockCoworker, orgId, actor.userId, source, input.lang ?? 'vi', input.hint);
        }),
      ),
      counts: {
        list: os.stock.counts.list.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.stock_count.list', input ?? {}, { actor, orgId }))),
        // Where the surplus of a confirmed count stands (#3712 slice 2b): the books' facts read in the member's own transaction, then the coworker's words outside any transaction.
        surplusNote: os.stock.counts.surplusNote.handler(({ context, input }) =>
          inFinance(context, async (orgId, actor) => {
            const source = await runtime.query<StockSurplusSource>('finance.stock_count.surplus_source', { countId: input.countId }, { actor, orgId });
            return explainSurplus(stockSurplusCoworker, orgId, actor.userId, source, input.lang ?? 'vi');
          }),
        ),
        preview: os.stock.counts.preview.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.stock_count.preview', input, { actor, orgId }))),
        create: os.stock.counts.create.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.stock_count.create', input, { actor, orgId }))),
        cancel: os.stock.counts.cancel.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.stock_count.cancel', input, { actor, orgId }))),
        confirmEmpty: os.stock.counts.confirmEmpty.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.stock_count.confirm_empty', input, { actor, orgId }))),
      },
    },
    accountRules: {
      list: os.accountRules.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.categorization_rules.list', input ?? {}, { actor, orgId })),
      ),
      create: os.accountRules.create.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.categorization_rule.create', input, { actor, orgId })),
      ),
      remove: os.accountRules.remove.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.categorization_rule.remove', input, { actor, orgId })),
      ),
    },
    vat: {
      period: os.vat.period.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.vat.period', input, { actor, orgId })),
      ),
      // The sentence is asked of the model outside any transaction, from the lists the working read in the member's own one (their legal entities only).
      explain: os.vat.explain.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const { lang, ...ask } = input;
          const report = await runtime.query<VatLateSource>('finance.vat.period', ask, { actor, orgId });
          return explainVatLate(financeVatLateAi, orgId, actor.userId, report, lang ?? 'vi');
        }),
      ),
      salesNumberGaps: os.vat.salesNumberGaps.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.vat.sales_number_gaps', input, { actor, orgId })),
      ),
      markPayment: os.vat.markPayment.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.vat.payment_mark', input, { actor, orgId })),
      ),
      markReturn: os.vat.markReturn.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.vat.return_mark', input, { actor, orgId })),
      ),
    },
    portalList: {
      reconcile: os.portalList.reconcile.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.portal_list.reconcile', input, { actor, orgId })),
      ),
      import: os.portalList.import.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.portal_list.import', input, { actor, orgId })),
      ),
      remove: os.portalList.remove.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.portal_list.remove', input, { actor, orgId })),
      ),
    },
    portalSync: {
      captcha: os.portalSync.captcha.handler(({ context, input }) => inPortalSync(context, (orgId, actor, sync) => sync.captcha(orgId, actor, input.period))),
      login: os.portalSync.login.handler(({ context, input }) => inPortalSync(context, (orgId, actor, sync) => sync.login(orgId, actor, input))),
      // The request's signal: a browser that went away stops the step before its next portal request.
      fetchList: os.portalSync.fetchList.handler(({ context, input, signal }) => inPortalSync(context, (orgId, actor, sync) => sync.fetchList(orgId, actor, input, signal ? { signal } : {}))),
      fetchXml: os.portalSync.fetchXml.handler(({ context, input, signal }) => inPortalSync(context, (orgId, actor, sync) => sync.fetchXml(orgId, actor, input, signal ? { signal } : {}))),
    },
    missingInvoices: {
      status: os.missingInvoices.status.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.missing_invoices.status', {}, { actor, orgId })),
      ),
      request: os.missingInvoices.request.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.missing_invoices.request', input, { actor, orgId })),
      ),
      setReminder: os.missingInvoices.setReminder.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.execute('finance.missing_invoices.reminder.set', input, { actor, orgId })),
      ),
    },
    ledger: {
      period: os.ledger.period.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.ledger.period', input, { actor, orgId })),
      ),
      account: os.ledger.account.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.ledger.account', input, { actor, orgId })),
      ),
      statements: os.ledger.statements.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.statements.period', input, { actor, orgId })),
      ),
      statementsHtkkCheck: os.ledger.statementsHtkkCheck.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.statements.htkk_check', input, { actor, orgId })),
      ),
    },
    yearArchive: {
      list: os.yearArchive.list.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.archive.list', {}, { actor, orgId })),
      ),
      build: os.yearArchive.build.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.archive.build', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    fixedAssets: {
      list: os.fixedAssets.list.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.fixed_assets.list', input ?? {}, { actor, orgId })),
      ),
      create: os.fixedAssets.create.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.fixed_asset.create', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      end: os.fixedAssets.end.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.fixed_asset.end', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    bookEntities: {
      list: os.bookEntities.list.handler(({ context }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.legal_entities.list', {}, { actor, orgId })),
      ),
    },
    periodLock: {
      state: os.periodLock.state.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.period.lock_state', input ?? {}, { actor, orgId })),
      ),
      lock: os.periodLock.lock.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.period.lock', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      unlock: os.periodLock.unlock.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.period.unlock', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    bank: {
      preview: os.bank.preview.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.preview', input, { actor, orgId })),
      ),
      statementLines: os.bank.statementLines.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.statement_lines', input, { actor, orgId })),
      ),
      statementConfirm: os.bank.statementConfirm.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.bank.statement_confirm', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      statementReject: os.bank.statementReject.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.bank.statement_reject', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      import: os.bank.import.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.bank.import', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      lines: os.bank.lines.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.lines', input, { actor, orgId })),
      ),
      platformLines: os.bank.platformLines.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.platform_lines', input, { actor, orgId })),
      ),
      lineVoucher: os.bank.lineVoucher.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.line_voucher', input, { actor, orgId })),
      ),
      payrollMatch: os.bank.payrollMatch.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.payroll_match', input, { actor, orgId })),
      ),
      supplierMatch: os.bank.supplierMatch.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.supplier_match', input, { actor, orgId })),
      ),
      // The candidates are read again here in the owner's or admin's own transaction, so the facts the model is told come from the books and the line, never from the caller.
      payrollExplain: os.bank.payrollExplain.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const { lang, runId, kind, bankLineId } = input;
          const match = await runtime.query<BankPayrollMatch>('finance.bank.payroll_match', { bankLineId }, { actor, orgId });
          const candidate = match.candidates.find((c) => c.runId.toLowerCase() === runId.toLowerCase() && c.kind === kind) ?? null;
          return explainPayrollMatch(financePayrollMatchAi, orgId, actor.userId, candidate, match.date, lang ?? 'vi');
        }),
      ),
      // The line and its candidates are read again here in the caller's own transaction, so the facts the model is told come from the matcher and the books, never from the caller; the sentence is a read and picks nothing.
      candidatesLine: os.bank.candidatesLine.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const { lang, bankLineId } = input;
          const read = await runtime.query<BankLineVoucher>('finance.bank.line_voucher', { bankLineId }, { actor, orgId });
          return explainBankCandidatesLine(financeBankCandidatesLineAi, orgId, actor.userId, read, lang ?? 'vi');
        }),
      ),
      suggestions: os.bank.suggestions.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.suggestions', input, { actor, orgId })),
      ),
      matchGroups: os.bank.matchGroups.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.match_groups', input, { actor, orgId })),
      ),
      matched: os.bank.matched.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.matched', input, { actor, orgId })),
      ),
      openLines: os.bank.openLines.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => runtime.query('finance.bank.open_lines', input ?? {}, { actor, orgId })),
      ),
    },
    // Bank feeds (ADR-0039, #2044). The sandbox's secret is made and sealed here; the worker opens it and lists the
    // accounts the login reaches (part 2b), so the API never uses a credential. The commands check the role again.
    bankFeeds: {
      accounts: os.bankFeeds.accounts.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.bank_feed.accounts', {}, { actor, orgId }))),
      connections: os.bankFeeds.connections.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.bank_feed.connections', {}, { actor, orgId }))),
      listed: os.bankFeeds.listed.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.bank_feed.listed', input, { actor, orgId }))),
      connectSandbox: os.bankFeeds.connectSandbox.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được nguồn giao dịch ngân hàng');
          if (!channels?.bankFeedSandbox) throw new DomainError('BANK_FEED_DISABLED', 404, 'Nguồn giao dịch ngân hàng thử nghiệm chưa được bật');
          const login = sandboxBankFeed().connect(input.displayName);
          const sealed = channels.broker.seal(login.secret, { orgId, provider: login.provider, externalAccountId: login.externalAccountId });
          const command: ChannelConnectInput = {
            provider: login.provider,
            externalAccountId: login.externalAccountId,
            displayName: login.displayName,
            scopes: [],
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          const { connectionId } = await runtime.execute<{ connectionId: string }>('kernel.channel.connect', command, { actor, orgId });
          return { connectionId };
        }),
      ),
      connectTingee: os.bankFeeds.connectTingee.handler(({ context, input }) =>
        inFinance(context, async (orgId, actor) => {
          const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được nguồn giao dịch ngân hàng');
          const hosted = channels?.bankFeedHosted;
          if (!channels || !hosted || !Object.hasOwn(hosted, 'bank_tingee')) throw new DomainError('BANK_FEED_TINGEE_DISABLED', 404, 'Nguồn giao dịch Tingee chưa được bật trên máy chủ này');
          if (channels.broker.id === 'none') throw new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');
          const provider = hosted.bank_tingee as BankFeedProvider;
          // The org's own credential, as the one value the worker opens (the adapter reads it back). One read call tests it before anything is sealed; its answer is dropped, the worker lists the accounts.
          const secret = JSON.stringify({ clientId: input.clientId, secretToken: input.secretToken });
          // The org's ticket first: a refused org must not spend the deployment's. Both limits are per process (a deployment with several API instances allows up to that many times each).
          const own = tingeeConnectsPerOrg.take(orgId);
          const ticket = own.allowed ? [tingeeConnectsAll.take('all')].find((t) => !t.allowed) : own;
          if (ticket) throw new DomainError('RATE_LIMITED', 429, 'Đã thử kết nối Tingee nhiều lần trong phút này, hãy đợi một lát rồi thử lại', { retryAfterSeconds: ticket.retryAfterSeconds });
          try {
            // One cheap read call (a page of one account) when the adapter has one, else its account list.
            await (provider.check ? provider.check(secret) : provider.accounts(secret));
          } catch (error) {
            throw tingeeConnectError(error);
          }
          const sealed = channels.broker.seal(secret, { orgId, provider: provider.id, externalAccountId: input.clientId });
          const command: ChannelConnectInput = {
            provider: provider.id,
            externalAccountId: input.clientId,
            displayName: input.displayName ?? 'Tingee',
            scopes: [],
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          const { connectionId } = await runtime.execute<{ connectionId: string }>('kernel.channel.connect', command, { actor, orgId });
          return { connectionId };
        }),
      ),
      // The webhook hook key (#4203): no idempotency key, so a replay never hands the secret out again; the answer is the key, shown once.
      hookSet: os.bankFeeds.hookSet.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.execute('finance.bank_feed.hook_set', input, { actor, orgId }))),
      hook: os.bankFeeds.hook.handler(({ context, input }) => inFinance(context, (orgId, actor) => runtime.query('finance.bank_feed.hook', input, { actor, orgId }))),
      map: os.bankFeeds.map.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.bank_feed.map', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      unmap: os.bankFeeds.unmap.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.bank_feed.unmap', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    bankAccountNumbers: {
      list: os.bankAccountNumbers.list.handler(({ context }) => inFinance(context, (orgId, actor) => runtime.query('finance.bank_account_number.list', {}, { actor, orgId }))),
      set: os.bankAccountNumbers.set.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.bank_account_number.set', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      clear: os.bankAccountNumbers.clear.handler(({ context, input }) =>
        inFinance(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('finance.bank_account_number.clear', rest, { actor, orgId, idempotencyKey });
        }),
      ),
    },
    // Ads (ADR-0040, #2217). The sandbox's secret is made and sealed here, and the account linked at once; the API never
    // opens a credential, and the first sync (the worker's) reads the platform. The commands check the role again.
    ads: {
      accounts: os.ads.accounts.handler(({ context }) =>
        inAds(context, async (orgId, actor) => {
          const rows = await runtime.query<Array<Omit<AdAccountView, 'resultKinds'>>>('ads.account.list', {}, { actor, orgId });
          // The result keys an owner may pick come from the platform's adapter, which the module does not have.
          return rows.map((row) => ({ ...row, resultKinds: [...(channels?.adsPlatforms?.[row.provider]?.capabilities.resultKinds ?? [])] }));
        }),
      ),
      connectSandbox: os.ads.connectSandbox.handler(({ context, input }) =>
        inAds(context, async (orgId, actor) => {
          const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner' && role !== 'admin') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới kết nối được tài khoản quảng cáo');
          if (!channels || !Object.hasOwn(channels.adsPlatforms ?? {}, 'sandbox_ads')) throw new DomainError('ADS_SANDBOX_DISABLED', 404, 'Nền tảng quảng cáo thử nghiệm chưa được bật');
          // The account derives from the request's key, so a retry of this call is the same account (the same connection, the same link).
          const login = sandboxAdPlatform().connect({ displayName: input.displayName, key: input.idempotencyKey, ...(input.currency ? { currency: input.currency } : {}) });
          const sealed = channels.broker.seal(login.secret, { orgId, provider: login.provider, externalAccountId: login.externalAccountId });
          const command: ChannelConnectInput = {
            provider: login.provider,
            externalAccountId: login.externalAccountId,
            displayName: login.displayName,
            scopes: [],
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          const { connectionId, reconnected } = await runtime.execute<{ connectionId: string; reconnected: boolean }>('kernel.channel.connect', command, { actor, orgId });
          try {
            const { adAccountId } = await runtime.execute<{ adAccountId: string }>(
              'ads.account.link',
              { connectionId, ...(input.legalEntityId ? { legalEntityId: input.legalEntityId } : {}) },
              { actor, orgId, idempotencyKey: input.idempotencyKey },
            );
            return { connectionId, adAccountId };
          } catch (error) {
            // The link was refused (an entity to choose, one the caller may not use): no connection is left behind that no screen
            // lists, with its sealed credential. A connection this call only reconnected (a retry of a call whose answer was
            // lost) is the account's own, with its history: it stays.
            if (!reconnected) await runtime.execute('kernel.channel.disconnect', { connectionId }, { actor, orgId }).catch(() => undefined);
            throw error;
          }
        }),
      ),
      // The offline write connection of a sandbox account (W0b): its own sealed token with the permission that can change campaigns,
      // attached to the account the read connection linked. The owner's, and only while the org's switch is on (the command checks it).
      connectSandboxWrite: os.ads.connectSandboxWrite.handler(({ context, input }) =>
        inAds(context, async (orgId, actor) => {
          const { role } = await resolveMembership(runtime, context.user, context.orgSlug);
          if (role !== 'owner') throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu mới kết nối được để chạy quảng cáo');
          if (!channels || !Object.hasOwn(channels.adsPlatforms ?? {}, 'sandbox_ads')) throw new DomainError('ADS_SANDBOX_DISABLED', 404, 'Nền tảng quảng cáo thử nghiệm chưa được bật');
          const target = await runtime.query<{ provider: string; externalAccountId: string; currency: string | null; name: string }>('ads.account.write_target', { adAccountId: input.adAccountId }, { actor, orgId });
          if (target.provider !== 'sandbox_ads') throw new DomainError('ADS_ACCOUNT_NOT_FOUND', 404, 'Không tìm thấy tài khoản quảng cáo thử nghiệm này');
          // The sandbox account's currency is known after its first sync; the writer's secret only carries it for show, so an account that has
          // not synced yet takes the sandbox's default.
          const login = sandboxWriteLogin({ externalAccountId: target.externalAccountId, currency: target.currency ?? 'VND' });
          const sealed = channels.broker.seal(login.secret, { orgId, provider: login.provider, externalAccountId: login.externalAccountId });
          const command: ChannelConnectInput = {
            provider: login.provider,
            externalAccountId: login.externalAccountId,
            displayName: target.name,
            scopes: [...login.scopes],
            expiresAt: null,
            credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
          };
          const { connectionId } = await runtime.execute<{ connectionId: string }>('kernel.channel.connect', command, { actor, orgId });
          try {
            const { adAccountId } = await runtime.execute<{ adAccountId: string }>('ads.account.link_write', { connectionId }, { actor, orgId, idempotencyKey: input.idempotencyKey });
            return { connectionId, adAccountId };
          } catch (error) {
            // Refused (the switch is off, the account has no read connection any more): no write connection is left behind with its
            // sealed token, one this call only reconnected included. A close that fails is still found by the switch-off, which closes
            // every write connection of the org whether or not an account refers to it.
            await runtime.execute('kernel.channel.disconnect', { connectionId }, { actor, orgId }).catch((closeError: unknown) => {
              console.warn(`[ads] a write connection whose link was refused could not be closed: ${closeError instanceof DomainError ? closeError.code : 'unknown'}`);
            });
            throw error;
          }
        }),
      ),
      // Closes an account's read connection and its write connection, dropping both sealed tokens (owners and admins).
      disconnectAccount: os.ads.disconnectAccount.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => runtime.execute('ads.account.disconnect', { adAccountId: input.adAccountId }, { actor, orgId, idempotencyKey: input.idempotencyKey })),
      ),
      configure: os.ads.configure.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.account.configure', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      requestSync: os.ads.requestSync.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.sync.request', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // Running ads (ADR-0043, #2294, W0a-1): the state of the switches and the caps, and the stops.
      // The deterministic spend-pace and cost-per-result flags (#2378): owners and admins.
      flags: os.ads.flags.handler(({ context }) => inAds(context, (orgId, actor) => runtime.query('ads.flags', {}, { actor, orgId }))),
      // The deterministic 7-day side-by-side comparison note across connected platforms (#2220): every member who reads Ads.
      weeklyNote: os.ads.weeklyNote.handler(({ context }) => inAds(context, (orgId, actor) => runtime.query('ads.weekly_note', {}, { actor, orgId }))),
      // The thresholds of those flags (#2378): owners and admins read and set them.
      flagSettings: os.ads.flagSettings.handler(({ context }) => inAds(context, (orgId, actor) => runtime.query('ads.flag_settings', {}, { actor, orgId }))),
      setFlagSettings: os.ads.setFlagSettings.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.flag_settings_set', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // Campaign drafts (W1, #2295): built and checked here, nothing leaves Ludy; asking for approval is requestChange (campaign_launch).
      campaignDrafts: os.ads.campaignDrafts.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.query('ads.campaign.drafts', input, { actor, orgId }))),
      campaignDraft: os.ads.campaignDraft.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.query('ads.campaign.draft', input, { actor, orgId }))),
      saveCampaignDraft: os.ads.saveCampaignDraft.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.campaign.draft_save', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // Boost a published Social post (W3, #3834): the options, the newest boost of each of some posts, and drafting one (the same draft the builder makes; asking for
      // approval is requestChange, the same approval and launch as any plan).
      boostOptions: os.ads.boostOptions.handler(({ context }) => inAds(context, (orgId, actor) => runtime.query('ads.boost.options', {}, { actor, orgId }))),
      boostStates: os.ads.boostStates.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.query('ads.boost.states', input, { actor, orgId }))),
      draftBoost: os.ads.draftBoost.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.boost.draft', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      discardCampaignDraft: os.ads.discardCampaignDraft.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.campaign.draft_discard', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // Cancelling a launch that has not started (W2-2): owners and admins; the approved plan's commitment against the caps is released.
      cancelLaunch: os.ads.cancelLaunch.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.launch.cancel', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // Stopping a launch that has started (W2-4a): owners and admins; its commitment against the caps stays to at least today and its objects at the platform are paused
      // afterwards, from the queue (never in this request).
      stopLaunch: os.ads.stopLaunch.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.launch.stop', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // Managing a running ad (W4, #3835): owners and admins. A pause, an archive, a lower budget and a shorter schedule only reduce spend: each is written here and queued, and the
      // platform is called by the manage job afterwards (never in this request). A resume, a raise and an extension are proposals (requestChange).
      pauseObject: os.ads.pauseObject.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.object.pause', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      archiveObject: os.ads.archiveObject.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.object.archive', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      lowerBudget: os.ads.lowerBudget.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.budget.lower', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      shortenSchedule: os.ads.shortenSchedule.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.schedule.shorten', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      cancelChange: os.ads.cancelChange.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.manage.cancel', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      manageState: os.ads.manageState.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.query('ads.manage.state', input, { actor, orgId }))),
      manageSuggestions: os.ads.manageSuggestions.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.query('ads.manage.suggestions', input, { actor, orgId }))),
      // Running a launch that needs attention again (W2-4b): owners and admins; the request is stamped here and the launch job takes it (never a platform call in this request).
      retryLaunch: os.ads.retryLaunch.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.launch.retry', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      // Asking the AI coworker for a draft (W1b): rationed by the same per-member and per-org budget as the other AI drafts (ai-draft-limit.ts, #386), since
      // each ask leads to a paid model call in the worker; no counter of its own. The answer, or why there is none, comes back through campaignRequests.
      campaignRequests: os.ads.campaignRequests.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.query('ads.campaign.requests', input, { actor, orgId }))),
      requestCampaignDraft: os.ads.requestCampaignDraft.handler(({ context, input }) =>
        inAds(context, async (orgId, actor) => {
          const ticket = drafts.take(orgId, actor.type === 'user' ? actor.userId : 'system');
          if (!ticket.allowed) {
            throw new DomainError('RATE_LIMITED', 429, ticket.reason === 'busy' ? 'Đang chờ AI trả lời, hãy đợi xong rồi thử tiếp' : 'Đã dùng AI nhiều lần trong phút này, hãy thử lại sau ít phút', {
              retryAfterSeconds: ticket.retryAfterSeconds,
            });
          }
          try {
            const { idempotencyKey, ...rest } = input;
            return await runtime.execute('ads.campaign.draft_request', rest, { actor, orgId, idempotencyKey });
          } finally {
            ticket.release();
          }
        }),
      ),
      committed: os.ads.committed.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.query('ads.committed', input, { actor, orgId }))),
      writeState: os.ads.writeState.handler(({ context }) => inAds(context, (orgId, actor) => runtime.query('ads.write.state', {}, { actor, orgId }))),
      // Asking for a change that opens the way to spend: a proposal in the Inbox, approved there (kernel.proposal.request).
      requestChange: os.ads.requestChange.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => runtime.execute('kernel.proposal.request', adsRequestOf(input), { actor, orgId, idempotencyKey: input.idempotencyKey })),
      ),
      proposal: os.ads.proposal.handler(({ context, input }) =>
        inAds(context, async (orgId, actor) => {
          const read = (await runtime.query('ads.proposal.change', input, { actor, orgId })) as { change: AdsChange | null; provider: string | null };
          // Only a plan to launch asks whether this server can: null for every other request, which launches nothing (#3675).
          return { change: read.change, canLaunch: read.change?.change === 'campaign_launch' ? adLaunchCapable(channels?.adsLaunchProviders ?? [], read.provider) : null };
        }),
      ),
      lowerCap: os.ads.lowerCap.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.cap.lower', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      writeDisable: os.ads.writeDisable.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.execute('ads.write.disable', { sharedApp: channels?.adsWriteAppShared ?? true }, { actor, orgId, idempotencyKey: input.idempotencyKey }))),
      disableAccountWrite: os.ads.disableAccountWrite.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => runtime.execute('ads.account.disable_write', { adAccountId: input.adAccountId }, { actor, orgId, idempotencyKey: input.idempotencyKey })),
      ),
      pauseAll: os.ads.pauseAll.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.execute('ads.pause_all', {}, { actor, orgId, idempotencyKey: input.idempotencyKey }))),
      // An owner's or admin's deletion of an account's stored figures and sync log (#2219).
      deleteHistory: os.ads.deleteHistory.handler(({ context, input }) =>
        inAds(context, (orgId, actor) => {
          const { idempotencyKey, ...rest } = input;
          return runtime.execute('ads.account.delete_history', rest, { actor, orgId, idempotencyKey });
        }),
      ),
      summary: os.ads.summary.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.query('ads.spend.summary', input, { actor, orgId }))),
      syncRuns: os.ads.syncRuns.handler(({ context, input }) => inAds(context, (orgId, actor) => runtime.query('ads.sync.runs', input, { actor, orgId }))),
    },
    // AI agents (ADR-0029). The kernel module owns them; a template of a module that is off answers MODULE_DISABLED.
    chart: {
      get: os.chart.get.handler(({ context }) => inOrg(context, (orgId, actor) => runtime.query('kernel.chart.get', {}, { actor, orgId }))),
      createPosition: os.chart.createPosition.handler(({ context, input }) => keyed(context, 'kernel.position.create', input)),
      updatePosition: os.chart.updatePosition.handler(({ context, input }) => keyed(context, 'kernel.position.update', input)),
      assign: os.chart.assign.handler(({ context, input }) => keyed(context, 'kernel.position.assign', input)),
      templates: os.chart.templates.handler(({ context }) =>
        inOrg(context, async (orgId, actor) => (await runtime.query<{ templates: z.infer<typeof zAgentTemplate>[] }>('kernel.agent.templates.list', {}, { actor, orgId })).templates),
      ),
      installTemplate: os.chart.installTemplate.handler(({ context, input }) => keyed(context, 'kernel.agent.template.install', input)),
    },
    agents: {
      update: os.agents.update.handler(({ context, input }) => keyed(context, 'kernel.agent.update', input)),
      budgets: os.agents.budgets.handler(({ context }) =>
        inOrg(context, async (orgId, actor) => (await runtime.query<{ budgets: z.infer<typeof zAgentBudget>[] }>('kernel.agent.budgets.list', {}, { actor, orgId })).budgets),
      ),
      setBudget: os.agents.setBudget.handler(({ context, input }) => keyed(context, 'kernel.agent.budget.set', input)),
      stop: os.agents.stop.handler(({ context, input }) => keyed(context, 'kernel.agent.kill_switch.engage', input)),
      release: os.agents.release.handler(({ context, input }) => keyed(context, 'kernel.agent.kill_switch.release', input)),
    },
    ai: {
      meter: os.ai.meter.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => ({ aiOn: aiEnabled, ...(await runtime.query<Omit<z.infer<typeof zAiMeter>, 'aiOn'>>('kernel.ai.meter.status', input, { actor, orgId })) })),
      ),
      usage: os.ai.usage.handler(({ context }) =>
        inOrg(context, async (orgId, actor) => ({ aiOn: aiEnabled, ...(await runtime.query<Omit<z.infer<typeof zAiUsageReport>, 'aiOn'>>('kernel.ai.usage.report', {}, { actor, orgId })) })),
      ),
    },
    tasks: {
      list: os.tasks.list.handler(({ context, input }) =>
        inOrg(context, async (orgId, actor) => (await runtime.query<{ tasks: z.infer<typeof zTask>[] }>('kernel.task.list', input, { actor, orgId })).tasks),
      ),
      get: os.tasks.get.handler(({ context, input }) => inOrg(context, (orgId, actor) => runtime.query('kernel.task.get', input, { actor, orgId }))),
      create: os.tasks.create.handler(({ context, input }) => keyed(context, 'kernel.task.create', input)),
      update: os.tasks.update.handler(({ context, input }) => keyed(context, 'kernel.task.update', input)),
      comment: os.tasks.comment.handler(({ context, input }) => keyed(context, 'kernel.task.comment', input)),
      setStatus: os.tasks.setStatus.handler(({ context, input }) => keyed(context, 'kernel.task.set_status', input)),
    },
    projects: {
      list: os.projects.list.handler(projectsQuery('projects.project.list')),
      get: os.projects.get.handler(projectsQuery('projects.project.get')),
      board: os.projects.board.handler(projectsQuery('projects.board')),
      weeklyStatus: os.projects.weeklyStatus.handler(({ context, input }) =>
        inProjects(context, async (orgId, actor) => {
          const source = await runtime.query<ProjectWeeklyStatusSource>('projects.weekly_status_source', { projectId: input.projectId }, { actor, orgId });
          return prepareProjectWeeklyStatus(projectWeeklyStatusCoworker, orgId, actor.userId, source, input.language ?? 'vi');
        }),
      ),
      weeklyStatusShareNote: os.projects.weeklyStatusShareNote.handler(projectsCommand('projects.weekly_status.share_note')),
      weeklyStatusSendMail: os.projects.weeklyStatusSendMail.handler(projectsCommand('projects.weekly_status.send_mail')),
      unassignedTasks: os.projects.unassignedTasks.handler(projectsQuery('projects.unassigned_tasks')),
      taskProjects: os.projects.taskProjects.handler(projectsQuery('projects.task_projects')),
      create: os.projects.create.handler(projectsCommand('projects.project.create')),
      update: os.projects.update.handler(projectsCommand('projects.project.update')),
      setStatus: os.projects.setStatus.handler(projectsCommand('projects.project.set_status')),
      archive: os.projects.archive.handler(projectsCommand('projects.project.archive')),
      setOwner: os.projects.setOwner.handler(projectsCommand('projects.project.set_owner')),
      addMember: os.projects.addMember.handler(projectsCommand('projects.member.add')),
      removeMember: os.projects.removeMember.handler(projectsCommand('projects.member.remove')),
      addTask: os.projects.addTask.handler(projectsCommand('projects.task.add')),
      removeTask: os.projects.removeTask.handler(projectsCommand('projects.task.remove')),
      reorderTask: os.projects.reorderTask.handler(projectsCommand('projects.task.reorder')),
      createTask: os.projects.createTask.handler(projectsCommand('projects.task.create')),
      tasksFromNoteStatus: os.projects.tasksFromNoteStatus.handler(({ context }) =>
        inProjects(context, (orgId, actor) => tasksFromNoteStatusOf({ runtime, model: summaryModel, meter: aiMeter ?? (() => null) }, orgId, actor)),
      ),
      proposeTasksFromNote: os.projects.proposeTasksFromNote.handler(({ context, input }) =>
        inProjects(context, (orgId, actor) =>
          runProjectsTasksFromNote({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: noteTaskProposals }, orgId, actor, input),
        ),
      ),
      confirmTasksFromNote: os.projects.confirmTasksFromNote.handler(projectsCommand('projects.tasks_from_note.confirm')),
      tasksFromSourceStatus: os.projects.tasksFromSourceStatus.handler(({ context }) =>
        inProjects(context, (orgId, actor) => tasksFromSourceStatusOf({ runtime, model: summaryModel, meter: aiMeter ?? (() => null) }, orgId, actor)),
      ),
      proposeTasksFromSource: os.projects.proposeTasksFromSource.handler(({ context, input }) =>
        inProjects(context, (orgId, actor) =>
          runProjectsTasksFromSource({ runtime, model: summaryModel, meter: aiMeter ?? (() => null), budget: noteTaskProposals }, orgId, actor, input),
        ),
      ),
      confirmTasksFromSource: os.projects.confirmTasksFromSource.handler(projectsCommand('projects.tasks_from_source.confirm')),
      listTemplates: os.projects.listTemplates.handler(projectsQuery('projects.template.list')),
      createTemplate: os.projects.createTemplate.handler(projectsCommand('projects.template.create')),
      archiveTemplate: os.projects.archiveTemplate.handler(projectsCommand('projects.template.archive')),
      createFromTemplate: os.projects.createFromTemplate.handler(projectsCommand('projects.project.create_from_template')),
      getTaskRecurrence: os.projects.getTaskRecurrence.handler(projectsQuery('projects.task.recurrence.get')),
      setTaskRecurrence: os.projects.setTaskRecurrence.handler(projectsCommand('projects.task.recurrence.set')),
      clearTaskRecurrence: os.projects.clearTaskRecurrence.handler(projectsCommand('projects.task.recurrence.clear')),
    },
    sign: {
      envelope: {
        list: os.sign.envelope.list.handler(signQuery('sign.envelope.list')),
        get: os.sign.envelope.get.handler(({ context, input }) =>
          inSign(context, async (orgId, actor) => {
            type SignEnvelopeDetail = z.infer<typeof zSignEnvelopeDetail>;
            const detail = await runtime.query<SignEnvelopeDetail>('sign.envelope.get', input, { actor, orgId });
            return {
              ...detail,
              envelope: {
                ...detail.envelope,
                pageDimensions: Array.isArray(detail.envelope.pageDimensions) ? detail.envelope.pageDimensions : null,
              },
            };
          }),
        ),
        events: os.sign.envelope.events.handler(signQuery('sign.envelope.events')),
        by_source: os.sign.envelope.by_source.handler(signQuery('sign.envelope.by_source')),
        verify: os.sign.envelope.verify.handler(signQuery('sign.envelope.verify')),
        create: os.sign.envelope.create.handler(signCommand('sign.envelope.create')),
        update: os.sign.envelope.update.handler(signCommand('sign.envelope.update')),
        send: os.sign.envelope.send.handler(signNoIdempotencyCommand('sign.envelope.send')),
        remind: os.sign.envelope.remind.handler(signCommand('sign.envelope.remind')),
        void: os.sign.envelope.void.handler(signCommand('sign.envelope.void')),
      },
      signer: {
        add: os.sign.signer.add.handler(signCommand('sign.signer.add')),
        remove: os.sign.signer.remove.handler(signCommand('sign.signer.remove')),
        reorder: os.sign.signer.reorder.handler(signCommand('sign.signer.reorder')),
        create_link: os.sign.signer.create_link.handler(signNoIdempotencyCommand('sign.signer.create_link')),
      },
      field: {
        set: os.sign.field.set.handler(signCommand('sign.field.set')),
      },
      ai: {
        analyze: os.sign.ai.analyze.handler(({ context, input }) =>
          inSign(context, (orgId, actor) =>
            proposeEnvelopeAnalysis({
              ai: signCoworker,
              runtime,
              orgId,
              actor,
              envelopeId: input.envelopeId,
              ...(input.pages ? { pages: input.pages } : {}),
              meter: 'runtime',
              ...(aiPrice ? { meterOptions: { price: aiPrice } } : {}),
            }),
          ),
        ),
        get: os.sign.ai.get.handler(signQuery('sign.ai_analysis.get')),
      },
      template: {
        list: os.sign.template.list.handler(signQuery('sign.template.list')),
        get: os.sign.template.get.handler(({ context, input }) =>
          inSign(context, async (orgId, actor) => {
            type SignTemplateDetail = z.infer<typeof zSignTemplateDetail>;
            const detail = await runtime.query<SignTemplateDetail>('sign.template.get', input, { actor, orgId });
            return {
              ...detail,
              template: {
                ...detail.template,
                pageDimensions: Array.isArray(detail.template.pageDimensions) ? detail.template.pageDimensions : null,
              },
            };
          }),
        ),
        create: os.sign.template.create.handler(signCommand('sign.template.create')),
        update: os.sign.template.update.handler(signCommand('sign.template.update')),
        roles_set: os.sign.template.roles_set.handler(signCommand('sign.template.roles_set')),
        fields_set: os.sign.template.fields_set.handler(signCommand('sign.template.fields_set')),
        archive: os.sign.template.archive.handler(signCommand('sign.template.archive')),
        instantiate: os.sign.template.instantiate.handler(signNoIdempotencyCommand('sign.template.instantiate')),
        direct_link_set: os.sign.template.direct_link_set.handler(signNoIdempotencyCommand('sign.template.direct_link_set')),
        direct_link_rotate: os.sign.template.direct_link_rotate.handler(signNoIdempotencyCommand('sign.template.direct_link_rotate')),
      },
      obligation: {
        get: os.sign.obligation.get.handler(signQuery('sign.obligation.get')),
        renewals_list: os.sign.obligation.renewals_list.handler(signQuery('sign.obligation.renewals_list')),
        extract: os.sign.obligation.extract.handler(({ context, input }) =>
          inSign(context, (orgId, actor) =>
            proposeEnvelopeObligations({
              ai: signCoworker,
              runtime,
              orgId,
              actor,
              envelopeId: input.envelopeId,
              ...(input.pages ? { pages: input.pages } : {}),
              meter: 'runtime',
              ...(aiPrice ? { meterOptions: { price: aiPrice } } : {}),
            }),
          ),
        ),
        upsert: os.sign.obligation.upsert.handler(signCommand('sign.obligation.upsert')),
        dismiss_proposal: os.sign.obligation.dismiss_proposal.handler(signCommand('sign.obligation.dismiss_proposal')),
        complete_item: os.sign.obligation.complete_item.handler(signCommand('sign.obligation.complete_item')),
      },
    },
  });

  return new RPCHandler(router);
}
