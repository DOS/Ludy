// SPDX-License-Identifier: AGPL-3.0-only
// Engage conversations inbox data model, window countdowns, placeholders, AI config flag and web URL helpers (issue #4882).

import { isMfaRequired, isStepUpRequired, type LudyClient } from '@ludy/client';
import { normalizeServerUrl } from '../../config.ts';
import { formatDateShort, type Locale } from '../approvals/format.ts';
import { isAuthBlockingError, isLikelyNetworkError, readErrorCodeAndStatus } from '../approvals/model.ts';

export type ConversationListed = Awaited<ReturnType<LudyClient['conversations']['list']>>;
export type ConversationSummary = ConversationListed['conversations'][number];
export type ConversationCounts = Awaited<ReturnType<LudyClient['conversations']['counts']>>;
export type ConversationDetail = Awaited<ReturnType<LudyClient['conversations']['get']>>;
export type ConversationMessage = ConversationDetail['messages'][number];
type ConversationKind = ConversationSummary['kind'];
export type ReplyBlockReason = NonNullable<ConversationDetail['reply']['reason']>;
export type OrgDetail = Awaited<ReturnType<LudyClient['org']['get']>>;
export type OrgRole = OrgDetail['role'];
export type OrgMember = OrgDetail['members'][number];

export type ConversationFilterTab = 'new' | 'pending' | 'all';

export const DEFAULT_SALES_COWORKER = 'Dy';
export const SAVED_REPLY_NAME_PLACEHOLDER = '{tên}';

export const CONVERSATION_REPLY_MAX = 8000;
export const CONVERSATION_ZALO_MAX = 2000;
export const CONVERSATION_FB_DIRECT_MAX = 2000;
export const CONVERSATION_IG_DIRECT_MAX = 1000;
export const CONVERSATION_IG_COMMENT_MAX = 2200;
export const CONVERSATION_WHATSAPP_MAX = 4096;
export const CONVERSATION_TELEGRAM_MAX = 4096;
export const CONVERSATION_THREADS_MAX = 500;
export const CONVERSATION_SANDBOX_MAX = 2000;

const URGENT_WINDOW_MS = 6 * 3_600_000;
const FILLED_NAME_MAX = 100;
const NAME_PLACEHOLDER = /\{{1,2}[^\S\n]*t[eê]n[^\S\n]*\}{1,2}/giu;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: string | null | undefined): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isConversationForbiddenOrMissing(error: unknown): boolean {
  if (isStepUpRequired(error) || isMfaRequired(error) || isAuthBlockingError(error)) return false;
  const { code, status } = readErrorCodeAndStatus(error);
  if (code === 'CONVERSATION_NOT_FOUND' || code === 'FORBIDDEN' || code === 'NOT_FOUND' || code === 'UNAUTHORIZED') {
    return true;
  }
  return status === 403 || status === 404;
}

export function isConversationMissingError(error: unknown): boolean {
  if (isStepUpRequired(error) || isMfaRequired(error) || isAuthBlockingError(error)) return false;
  const { code, status } = readErrorCodeAndStatus(error);
  return code === 'CONVERSATION_NOT_FOUND' || code === 'NOT_FOUND' || status === 404;
}

export function isAccessRefusalError(error: unknown): boolean {
  return isAuthBlockingError(error) || isConversationForbiddenOrMissing(error);
}

export function isConversationMovedError(error: unknown): boolean {
  return readErrorCodeAndStatus(error).code === 'CONVERSATION_MOVED';
}

export function isReplyWindowClosedError(error: unknown): boolean {
  return readErrorCodeAndStatus(error).code === 'REPLY_WINDOW_CLOSED';
}

export function isRateLimitedError(error: unknown): { rateLimited: boolean; retryAfterSeconds: number | null } {
  const { code, status } = readErrorCodeAndStatus(error);
  if (code !== 'RATE_LIMITED' && status !== 429) {
    return { rateLimited: false, retryAfterSeconds: null };
  }
  let retryAfterSeconds: number | null = null;
  if (error && typeof error === 'object') {
    const obj = error as { data?: unknown; retryAfterSeconds?: unknown };
    const data = obj.data && typeof obj.data === 'object' ? (obj.data as { retryAfterSeconds?: unknown }) : null;
    const raw = data?.retryAfterSeconds ?? obj.retryAfterSeconds;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      retryAfterSeconds = Math.ceil(raw);
    }
  }
  return { rateLimited: true, retryAfterSeconds };
}

export function resolveReplyMax(provider: string, kind: ConversationKind): number {
  if (provider === 'zalo_oa') return CONVERSATION_ZALO_MAX;
  if (provider === 'facebook_page') return kind === 'direct' ? CONVERSATION_FB_DIRECT_MAX : CONVERSATION_REPLY_MAX;
  if (provider === 'instagram') return kind === 'direct' ? CONVERSATION_IG_DIRECT_MAX : CONVERSATION_IG_COMMENT_MAX;
  if (provider === 'whatsapp') return CONVERSATION_WHATSAPP_MAX;
  if (provider === 'telegram') return CONVERSATION_TELEGRAM_MAX;
  if (provider === 'threads') return CONVERSATION_THREADS_MAX;
  if (provider === 'sandbox') return CONVERSATION_SANDBOX_MAX;
  return CONVERSATION_REPLY_MAX;
}

export function contactNameOf(contact: {
  partyName: string | null | undefined;
  displayName: string | null | undefined;
}): string | null {
  return contact.partyName?.trim() || contact.displayName?.trim() || null;
}

export function hasNamePlaceholder(text: string): boolean {
  return new RegExp(NAME_PLACEHOLDER.source, NAME_PLACEHOLDER.flags).test(text.normalize('NFC'));
}

function usableName(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = Array.from(
    name
      .normalize('NFC')
      .replace(/[\p{Cc}\p{Cf}{}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  )
    .slice(0, FILLED_NAME_MAX)
    .join('')
    .trim();
  return cleaned === '' ? null : cleaned;
}

/**
 * Resolves `{tên}` placeholder with the contact name, or cleans surrounding spaces/punctuation when missing,
 * matching `packages/kernel-contract/src/conversations.ts`.
 */
export function fillNamePlaceholder(text: string, name: string | null | undefined): string {
  const body = text.normalize('NFC');
  if (!hasNamePlaceholder(body)) return text;
  const filled = usableName(name);
  if (filled !== null) return body.replace(NAME_PLACEHOLDER, () => filled);
  const MARK = '\uE000';
  return body
    .replaceAll(MARK, '')
    .replace(NAME_PLACEHOLDER, MARK)
    .replace(/\uE000(?:[^\S\n]*\uE000)+/gu, MARK)
    .replace(/(^|\n)[^\S\n]*\uE000[^\S\n]*(?:[,;:]+[^\S\n]*)?/gu, '$1')
    .replace(/[,;:][^\S\n]*\uE000(?=[,.!?…])/gu, '')
    .replace(/([([])[^\S\n]*\uE000[^\S\n]*/gu, '$1')
    .replace(/[^\S\n]*\uE000(?=[,.;:!?…)\]])/gu, '')
    .replace(/[^\S\n]*\uE000[^\S\n]*(?=\n|$)/gu, '')
    .replace(/[^\S\n]*\uE000[^\S\n]*/gu, ' ')
    .trim();
}

export function replyTextFor(body: string, detail: Pick<ConversationDetail, 'conversation'>): string {
  return fillNamePlaceholder(body, contactNameOf(detail.conversation.contact));
}

export function getContactDisplayName(
  contact: Pick<ConversationSummary['contact'], 'partyName' | 'displayName' | 'idTail'>,
  anonymousLabel: (tail: string) => string,
): string {
  return contactNameOf(contact) ?? anonymousLabel(contact.idTail);
}

export function formatChannelProviderLabel(provider: string, kind: ConversationKind): string {
  if (provider === 'zalo_oa') return 'Zalo OA';
  if (provider === 'facebook_page') return kind === 'direct' ? 'Messenger' : 'Facebook';
  if (provider === 'instagram') return 'Instagram';
  if (provider === 'whatsapp') return 'WhatsApp';
  if (provider === 'telegram') return 'Telegram';
  if (provider === 'threads') return 'Threads';
  if (provider === 'youtube') return 'YouTube';
  if (provider === 'email') return 'Email';
  if (provider === 'sandbox') return 'Sandbox';
  return provider;
}

function parseReplyWindowUntil(replyWindowUntil: string | null | undefined): number | null {
  if (!replyWindowUntil) return null;
  const ms = Date.parse(replyWindowUntil);
  return Number.isFinite(ms) ? ms : null;
}

interface ReplyWindowState {
  hasWindow: boolean;
  untilMs: number | null;
  remainingMs: number | null;
  expired: boolean;
  urgent: boolean;
  allowed: boolean;
  blockReason: ReplyBlockReason | null;
}

export function evaluateReplyWindow(params: {
  replyWindowUntil: string | null | undefined;
  reply: ConversationDetail['reply'];
  nowMs: number;
}): ReplyWindowState {
  const untilMs = parseReplyWindowUntil(params.replyWindowUntil);
  const expiredByClock = untilMs !== null && params.nowMs >= untilMs;
  const remainingMs = untilMs !== null ? Math.max(0, untilMs - params.nowMs) : null;
  const expired = expiredByClock || (!params.reply.allowed && params.reply.reason === 'window_closed');
  const allowed = params.reply.allowed && !expiredByClock;
  const blockReason: ReplyBlockReason | null = !params.reply.allowed
    ? (params.reply.reason ?? 'not_supported')
    : expiredByClock
      ? 'window_closed'
      : null;
  const urgent = remainingMs !== null && remainingMs > 0 && remainingMs <= URGENT_WINDOW_MS;
  return {
    hasWindow: untilMs !== null || blockReason === 'window_closed',
    untilMs,
    remainingMs,
    expired,
    urgent,
    allowed,
    blockReason,
  };
}

export function getSummaryWindowBadge(
  summary: Pick<ConversationSummary, 'replyWindowUntil' | 'channel'>,
  nowMs: number,
): { expired: boolean; urgent: boolean; remainingMs: number; provider: string } | null {
  const untilMs = parseReplyWindowUntil(summary.replyWindowUntil);
  if (untilMs === null) return null;
  const expired = nowMs >= untilMs;
  const remainingMs = Math.max(0, untilMs - nowMs);
  const urgent = !expired && remainingMs <= URGENT_WINDOW_MS;
  return { expired, urgent, remainingMs, provider: summary.channel.provider };
}

export function formatWindowDuration(remainingMs: number, locale: Locale): string {
  if (remainingMs <= 0) return '';
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) {
    return locale === 'vi' ? 'dưới 1 phút' : 'under 1m';
  }
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    if (locale === 'vi') return hours > 0 ? `${days} ngày ${hours} giờ` : `${days} ngày`;
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    if (locale === 'vi') return minutes > 0 ? `${hours} giờ ${minutes} phút` : `${hours} giờ`;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return locale === 'vi' ? `${minutes} phút` : `${minutes}m`;
}

export function formatRelativeTimestamp(
  isoOrMs: string | number | null | undefined,
  nowMs: number,
  locale: Locale,
): string {
  if (isoOrMs === null || isoOrMs === undefined || isoOrMs === '') return '';
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(ms)) return '';
  const diffMs = nowMs - ms;
  if (diffMs < 60_000 && diffMs >= -60_000) {
    return locale === 'vi' ? 'Vừa xong' : 'Just now';
  }
  if (diffMs >= 60_000) {
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 60) return locale === 'vi' ? `${mins} phút` : `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return locale === 'vi' ? `${hours} giờ` : `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return locale === 'vi' ? `${days} ngày` : `${days}d`;
  }
  return formatDateShort(new Date(ms).toISOString(), locale);
}

export function mergeConversationPages(pages: readonly ConversationListed[]): ConversationSummary[] {
  const seen = new Set<string>();
  const merged: ConversationSummary[] = [];
  for (const page of pages) {
    for (const c of page.conversations) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      merged.push(c);
    }
  }
  return merged;
}

export function buildInboxWebPath(): string {
  return '/social/inbox';
}

export function buildConversationWebPath(conversationId: string | null | undefined): string | null {
  if (!isValidUuid(conversationId)) return null;
  return `/social/inbox?c=${encodeURIComponent(conversationId)}`;
}

const AI_CONFIG_TTL_MS = 60_000;
const aiConfigCache = new Map<string, { enabled: boolean; fetchedAt: number }>();

export function clearDeploymentAiCache(): void {
  aiConfigCache.clear();
}

/**
 * Reads `GET ${serverUrl}/api/config` (`aiEnabled === true`), with a 60s TTL cache per origin and failing closed to `false` on error.
 */
export async function fetchDeploymentAiEnabled(
  serverUrl: string,
  deps?: { fetchFn?: typeof fetch; forceRefresh?: boolean; now?: () => number },
): Promise<boolean> {
  const origin = normalizeServerUrl(serverUrl);
  if (!origin) return false;
  const nowMs = (deps?.now ?? (() => Date.now()))();
  const cached = aiConfigCache.get(origin);
  if (!deps?.forceRefresh && cached && nowMs - cached.fetchedAt < AI_CONFIG_TTL_MS) {
    return cached.enabled;
  }
  const fetchFn: typeof fetch = deps?.fetchFn ?? ((input, init) => fetch(input, init));
  try {
    const response = await fetchFn(`${origin}/api/config`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) return false;
    const raw: unknown = await response.json();
    const enabled = Boolean(
      raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as { aiEnabled?: unknown }).aiEnabled === true,
    );
    aiConfigCache.set(origin, { enabled, fetchedAt: nowMs });
    return enabled;
  } catch {
    return false;
  }
}

export async function resolveSalesCoworkerName(
  client: LudyClient,
  orgDetail?: OrgDetail | null,
): Promise<string> {
  const orgCandidate = (orgDetail as { coworkers?: { sales?: unknown } } | null | undefined)?.coworkers?.sales;
  if (typeof orgCandidate === 'string' && orgCandidate.trim()) {
    return orgCandidate.trim();
  }
  const chartApi = (
    client as {
      chart?: {
        get?: () => Promise<{ agents: ReadonlyArray<{ templateKey: string; displayName: string; status: string }> }>;
        templates?: () => Promise<ReadonlyArray<{ key: string; module: string }>>;
      };
    }
  ).chart;
  if (typeof chartApi?.get === 'function' && typeof chartApi?.templates === 'function') {
    try {
      const [chart, templates] = await Promise.all([chartApi.get(), chartApi.templates()]);
      const moduleByKey = new Map(templates.map((tpl) => [tpl.key, tpl.module]));
      for (const agent of chart.agents) {
        if (agent.status === 'retired') continue;
        const mod = moduleByKey.get(agent.templateKey);
        if (mod === 'crm' || mod === 'conversations') {
          const name = agent.displayName.trim();
          if (name) return name;
        }
      }
      return DEFAULT_SALES_COWORKER;
    } catch (error) {
      if (isAuthBlockingError(error) || isMfaRequired(error) || isStepUpRequired(error)) {
        throw error;
      }
      return DEFAULT_SALES_COWORKER;
    }
  }
  const todayApi = (client as { today?: { list?: () => Promise<{ coworkers?: { sales?: string } }> } }).today;
  if (typeof todayApi?.list !== 'function') {
    return DEFAULT_SALES_COWORKER;
  }
  try {
    const today = await todayApi.list();
    const sales = today?.coworkers?.sales?.trim();
    return sales || DEFAULT_SALES_COWORKER;
  } catch (error) {
    if (isAuthBlockingError(error) || isMfaRequired(error) || isStepUpRequired(error)) {
      throw error;
    }
    return DEFAULT_SALES_COWORKER;
  }
}

type KnownSendErrorCode =
  | 'ZALO_QUOTA'
  | 'ZALO_RATE_LIMIT'
  | 'ZALO_NOT_FOLLOWER'
  | 'ZALO_BLOCKED'
  | 'ZALO_TOKEN'
  | 'ZALO_OA_ACCESS'
  | 'FB_WINDOW_CLOSED'
  | 'WA_WINDOW_CLOSED'
  | 'TELEGRAM_BOT_BLOCKED'
  | 'CHANNEL_NOT_ACTIVE';

const SEND_ERROR_ALIAS: Readonly<Record<string, KnownSendErrorCode>> = {
  ZALO_QUOTA: 'ZALO_QUOTA',
  ZALO_RATE_LIMIT: 'ZALO_RATE_LIMIT',
  ZALO_NOT_FOLLOWER: 'ZALO_NOT_FOLLOWER',
  ZALO_BLOCKED: 'ZALO_BLOCKED',
  ZALO_TOKEN: 'ZALO_TOKEN',
  ZALO_NO_TOKEN: 'ZALO_TOKEN',
  ZALO_OA_ACCESS: 'ZALO_OA_ACCESS',
  FB_WINDOW_CLOSED: 'FB_WINDOW_CLOSED',
  WA_WINDOW_CLOSED: 'WA_WINDOW_CLOSED',
  WA_131047: 'WA_WINDOW_CLOSED',
  TELEGRAM_BOT_BLOCKED: 'TELEGRAM_BOT_BLOCKED',
  CHANNEL_NOT_ACTIVE: 'CHANNEL_NOT_ACTIVE',
  CHANNEL_OWNER_LEFT: 'CHANNEL_NOT_ACTIVE',
};

export function resolveKnownSendErrorCode(code: string | null | undefined): KnownSendErrorCode | null {
  if (!code) return null;
  return Object.hasOwn(SEND_ERROR_ALIAS, code) ? (SEND_ERROR_ALIAS[code] ?? null) : null;
}

export { isAuthBlockingError, isLikelyNetworkError, readErrorCodeAndStatus };
