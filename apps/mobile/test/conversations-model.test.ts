// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import type { LudyClient } from '@ludy/client';
import { serverPolicy } from '../src/config.ts';
import { buildWebUrl } from '../src/screens/approvals/format.ts';
import {
  buildConversationWebPath,
  buildInboxWebPath,
  clearDeploymentAiCache,
  CONVERSATION_FB_DIRECT_MAX,
  CONVERSATION_IG_COMMENT_MAX,
  CONVERSATION_IG_DIRECT_MAX,
  CONVERSATION_REPLY_MAX,
  CONVERSATION_SANDBOX_MAX,
  CONVERSATION_TELEGRAM_MAX,
  CONVERSATION_THREADS_MAX,
  CONVERSATION_WHATSAPP_MAX,
  CONVERSATION_ZALO_MAX,
  contactNameOf,
  DEFAULT_SALES_COWORKER,
  evaluateReplyWindow,
  fetchDeploymentAiEnabled,
  fillNamePlaceholder,
  formatChannelProviderLabel,
  formatRelativeTimestamp,
  formatWindowDuration,
  getContactDisplayName,
  getSummaryWindowBadge,
  hasNamePlaceholder,
  isConversationForbiddenOrMissing,
  isValidUuid,
  mergeConversationPages,
  replyTextFor,
  resolveKnownSendErrorCode,
  resolveReplyMax,
  resolveSalesCoworkerName,
  SAVED_REPLY_NAME_PLACEHOLDER,
  type ConversationDetail,
  type ConversationSummary,
} from '../src/screens/conversations/model.ts';
import { jsonResponse, SERVER } from './helpers.ts';

function fakeSummary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    kind: 'direct',
    status: 'new',
    channel: {
      connectionId: '00000000-0000-4000-8000-000000000010',
      provider: 'zalo_oa',
      displayName: 'Zalo OA Demo',
    },
    postId: null,
    contact: {
      identityId: '00000000-0000-4000-8000-000000000020',
      displayName: 'Minh Anh',
      idTail: '9912',
      partyId: null,
      partyName: null,
      address: null,
    },
    assigneeUserId: null,
    lastSeq: 2,
    lastMessageAt: '2026-11-26T10:00:00.000Z',
    lastInboundAt: '2026-11-26T10:00:00.000Z',
    replyWindowUntil: '2026-11-28T10:00:00.000Z',
    preview: 'Em hỏi giá gói tháng này ạ',
    unread: true,
    composing: [],
    intent: null,
    ...overrides,
  };
}

describe('conversations reply window countdown and expiry rules', () => {
  it('computes Zalo 48h remaining time, urgent window, and exact expiry transition', () => {
    const startMs = Date.parse('2026-11-26T10:00:00.000Z');
    const until = '2026-11-28T10:00:00.000Z';

    const early = evaluateReplyWindow({
      replyWindowUntil: until,
      reply: { allowed: true, reason: null },
      nowMs: startMs + 60_000,
    });
    expect(early.hasWindow).toBe(true);
    expect(early.allowed).toBe(true);
    expect(early.expired).toBe(false);
    expect(early.urgent).toBe(false);
    expect(early.blockReason).toBeNull();
    expect(formatWindowDuration(early.remainingMs ?? 0, 'vi')).toBe('1 ngày 23 giờ');
    expect(formatWindowDuration(early.remainingMs ?? 0, 'en')).toBe('1d 23h');

    // Within 6 hours remaining: marked urgent.
    const urgent = evaluateReplyWindow({
      replyWindowUntil: until,
      reply: { allowed: true, reason: null },
      nowMs: Date.parse(until) - (3 * 3_600_000 + 15 * 60_000),
    });
    expect(urgent.allowed).toBe(true);
    expect(urgent.urgent).toBe(true);
    expect(formatWindowDuration(urgent.remainingMs ?? 0, 'vi')).toBe('3 giờ 15 phút');
    expect(formatWindowDuration(urgent.remainingMs ?? 0, 'en')).toBe('3h 15m');

    // Under 1 minute left.
    expect(formatWindowDuration(30_000, 'vi')).toBe('dưới 1 phút');
    expect(formatWindowDuration(30_000, 'en')).toBe('under 1m');

    // At exact expiry timestamp (`now >= Date.parse(replyWindowUntil)`): hard blocked.
    const atBoundary = evaluateReplyWindow({
      replyWindowUntil: until,
      reply: { allowed: true, reason: null },
      nowMs: Date.parse(until),
    });
    expect(atBoundary.allowed).toBe(false);
    expect(atBoundary.expired).toBe(true);
    expect(atBoundary.remainingMs).toBe(0);
    expect(atBoundary.blockReason).toBe('window_closed');

    // Server-reported non-window block reasons are preserved even if no replyWindowUntil.
    const inactive = evaluateReplyWindow({
      replyWindowUntil: null,
      reply: { allowed: false, reason: 'channel_inactive' },
      nowMs: startMs,
    });
    expect(inactive.allowed).toBe(false);
    expect(inactive.expired).toBe(false);
    expect(inactive.blockReason).toBe('channel_inactive');
  });

  it('computes list row reply window badges cleanly', () => {
    const summary = fakeSummary({ replyWindowUntil: '2026-11-28T10:00:00.000Z' });
    const openBadge = getSummaryWindowBadge(summary, Date.parse('2026-11-28T08:00:00.000Z'));
    expect(openBadge?.expired).toBe(false);
    expect(openBadge?.urgent).toBe(true);

    const closedBadge = getSummaryWindowBadge(summary, Date.parse('2026-11-28T10:00:00.000Z'));
    expect(closedBadge?.expired).toBe(true);
    expect(closedBadge?.remainingMs).toBe(0);

    expect(getSummaryWindowBadge(fakeSummary({ replyWindowUntil: null }), Date.now())).toBeNull();
  });
});

describe('channel replyMax, placeholders, formatting, and error helpers', () => {
  it('matches kernel channel reply length limits', () => {
    expect(resolveReplyMax('zalo_oa', 'direct')).toBe(CONVERSATION_ZALO_MAX);
    expect(resolveReplyMax('facebook_page', 'direct')).toBe(CONVERSATION_FB_DIRECT_MAX);
    expect(resolveReplyMax('facebook_page', 'comment_thread')).toBe(CONVERSATION_REPLY_MAX);
    expect(resolveReplyMax('instagram', 'direct')).toBe(CONVERSATION_IG_DIRECT_MAX);
    expect(resolveReplyMax('instagram', 'comment_thread')).toBe(CONVERSATION_IG_COMMENT_MAX);
    expect(resolveReplyMax('whatsapp', 'direct')).toBe(CONVERSATION_WHATSAPP_MAX);
    expect(resolveReplyMax('telegram', 'direct')).toBe(CONVERSATION_TELEGRAM_MAX);
    expect(resolveReplyMax('threads', 'comment_thread')).toBe(CONVERSATION_THREADS_MAX);
    expect(resolveReplyMax('sandbox', 'direct')).toBe(CONVERSATION_SANDBOX_MAX);
    expect(resolveReplyMax('youtube', 'comment_thread')).toBe(CONVERSATION_REPLY_MAX);
    expect(resolveReplyMax('email', 'email')).toBe(CONVERSATION_REPLY_MAX);
  });

  it('fills {tên} placeholder with parity and tidies missing contact names', () => {
    expect(SAVED_REPLY_NAME_PLACEHOLDER).toBe('{tên}');
    expect(hasNamePlaceholder('Chào {tên}, shop gửi bạn báo giá')).toBe(true);
    expect(hasNamePlaceholder('Hi {Ten}, here are the details')).toBe(true);
    expect(hasNamePlaceholder('Chào {{ tên }}, cảm ơn bạn')).toBe(true);
    expect(hasNamePlaceholder('Chào {' + 'te\u0302n' + '}')).toBe(true);
    expect(hasNamePlaceholder('Không có chỗ trống')).toBe(false);

    expect(fillNamePlaceholder('Chào {tên}, bên mình còn hàng ạ.', 'Lan Anh')).toBe(
      'Chào Lan Anh, bên mình còn hàng ạ.',
    );
    expect(fillNamePlaceholder('Chào {tên}, bên mình còn hàng ạ.', null)).toBe(
      'Chào, bên mình còn hàng ạ.',
    );
    expect(fillNamePlaceholder('{Tên}, cảm ơn bạn đã nhắn!', undefined)).toBe(
      'cảm ơn bạn đã nhắn!',
    );
    expect(fillNamePlaceholder('Cảm ơn {ten}!', '')).toBe('Cảm ơn!');

    // Strips braces/control chars from untrusted contact names so placeholder injection cannot survive.
    expect(fillNamePlaceholder('Chào {tên}', 'An\u0007 {tên}')).toBe('Chào An tên');

    const detail = {
      conversation: fakeSummary({
        contact: {
          identityId: 'id-1',
          displayName: 'Platform Nick',
          idTail: '4321',
          partyId: 'p-1',
          partyName: 'Công ty An Khang',
        },
      }),
    } as Pick<ConversationDetail, 'conversation'>;
    expect(contactNameOf(detail.conversation.contact)).toBe('Công ty An Khang');
    expect(replyTextFor('Dạ chào {tên} ạ', detail)).toBe('Dạ chào Công ty An Khang ạ');
  });

  it('formats contact names, channel badges, relative timestamps, and send error codes', () => {
    expect(
      getContactDisplayName(
        { partyName: null, displayName: '  ', idTail: '8899' },
        (tail) => `Người dùng ...${tail}`,
      ),
    ).toBe('Người dùng ...8899');
    expect(formatChannelProviderLabel('zalo_oa', 'direct')).toBe('Zalo OA');
    expect(formatChannelProviderLabel('facebook_page', 'direct')).toBe('Messenger');
    expect(formatChannelProviderLabel('facebook_page', 'comment_thread')).toBe('Facebook');
    expect(formatChannelProviderLabel('instagram', 'direct')).toBe('Instagram');

    const base = Date.parse('2026-11-26T12:00:00.000Z');
    expect(formatRelativeTimestamp('2026-11-26T11:59:45.000Z', base, 'vi')).toBe('Vừa xong');
    expect(formatRelativeTimestamp('2026-11-26T11:50:00.000Z', base, 'en')).toBe('10m');
    expect(formatRelativeTimestamp('2026-11-26T09:00:00.000Z', base, 'vi')).toBe('3 giờ');
    expect(formatRelativeTimestamp('2026-11-24T12:00:00.000Z', base, 'en')).toBe('2d');

    expect(resolveKnownSendErrorCode('ZALO_NO_TOKEN')).toBe('ZALO_TOKEN');
    expect(resolveKnownSendErrorCode('WA_131047')).toBe('WA_WINDOW_CLOSED');
    expect(resolveKnownSendErrorCode('UNKNOWN_VENDOR_ERR')).toBeNull();

    expect(isConversationForbiddenOrMissing({ code: 'CONVERSATION_NOT_FOUND', status: 404 })).toBe(true);
    expect(isConversationForbiddenOrMissing({ code: 'MFA_REQUIRED', status: 401 })).toBe(false);
    expect(isConversationForbiddenOrMissing({ code: 'UNAUTHENTICATED', status: 401 })).toBe(false);
  });

  it('deduplicates overlapping conversation pages and validates web hand-off URLs', () => {
    const a = fakeSummary({ id: '00000000-0000-4000-8000-000000000101' });
    const b = fakeSummary({ id: '00000000-0000-4000-8000-000000000102' });
    const c = fakeSummary({ id: '00000000-0000-4000-8000-000000000103' });
    const merged = mergeConversationPages([
      { conversations: [a, b], more: true },
      { conversations: [b, c], more: false },
    ]);
    expect(merged.map((x) => x.id)).toEqual([a.id, b.id, c.id]);

    const policy = serverPolicy(SERVER, undefined);
    expect(buildInboxWebPath()).toBe('/social/inbox');
    expect(buildWebUrl(SERVER, 'acme', buildInboxWebPath(), policy)).toBe(`${SERVER}/o/acme/social/inbox`);

    const validId = '00000000-0000-4000-8000-000000000101';
    expect(isValidUuid(validId)).toBe(true);
    expect(isValidUuid('../other')).toBe(false);
    expect(buildConversationWebPath('../other')).toBeNull();
    const convPath = buildConversationWebPath(validId);
    expect(convPath).toBe(`/social/inbox?c=${validId}`);
    expect(buildWebUrl(SERVER, 'acme', convPath as string, policy)).toBe(
      `${SERVER}/o/acme/social/inbox?c=${validId}`,
    );
  });
});

describe('deployment aiEnabled flag and sales coworker resolution', () => {
  afterEach(() => {
    clearDeploymentAiCache();
  });

  it('reads and caches aiEnabled per origin with TTL and fails closed to false on errors', async () => {
    let fetchCount = 0;
    let clockMs = 1_000_000;
    const okFetch = (async () => {
      fetchCount += 1;
      return jsonResponse(200, { aiEnabled: true });
    }) as unknown as typeof fetch;

    expect(
      await fetchDeploymentAiEnabled(`${SERVER}/`, { fetchFn: okFetch, now: () => clockMs }),
    ).toBe(true);
    expect(
      await fetchDeploymentAiEnabled(SERVER, { fetchFn: okFetch, now: () => clockMs + 10_000 }),
    ).toBe(true);
    expect(fetchCount).toBe(1);

    // Expires after 60s TTL so server AI toggles take effect.
    const offFetch = (async () => {
      fetchCount += 1;
      return jsonResponse(200, { aiEnabled: false });
    }) as unknown as typeof fetch;
    expect(
      await fetchDeploymentAiEnabled(SERVER, { fetchFn: offFetch, now: () => clockMs + 61_000 }),
    ).toBe(false);
    expect(fetchCount).toBe(2);

    clearDeploymentAiCache();
    expect(
      await fetchDeploymentAiEnabled(SERVER, {
        fetchFn: (async () => {
          throw new Error('offline');
        }) as unknown as typeof fetch,
      }),
    ).toBe(false);

    expect(
      await fetchDeploymentAiEnabled(SERVER, {
        fetchFn: (async () => jsonResponse(503, { error: 'down' })) as unknown as typeof fetch,
      }),
    ).toBe(false);

    expect(await fetchDeploymentAiEnabled('http://evil.example')).toBe(false);
  });

  it('resolves Engage sales coworker name from chart agents, falls back cleanly, and rethrows auth errors', async () => {
    const chartClient = {
      chart: {
        get: async () => ({
          agents: [
            { id: 'a0', templateKey: 'sales-old', displayName: 'Old Sales', status: 'retired', maxRisk: 'R1', dailyRunCap: 10 },
            { id: 'a1', templateKey: 'fin-1', displayName: 'Ly Kế toán', status: 'active', maxRisk: 'R1', dailyRunCap: 10 },
            { id: 'a2', templateKey: 'sales-1', displayName: 'Dy Tư vấn', status: 'active', maxRisk: 'R1', dailyRunCap: 10 },
          ],
        }),
        templates: async () => [
          { key: 'sales-old', module: 'conversations' },
          { key: 'fin-1', module: 'finance' },
          { key: 'sales-1', module: 'crm' },
        ],
      },
    } as unknown as LudyClient;
    expect(await resolveSalesCoworkerName(chartClient)).toBe('Dy Tư vấn');

    const todayFallbackClient = {
      today: {
        list: async () => ({ coworkers: { gm: 'Vy', finance: 'Ly', sales: 'Vy Sales', marketing: 'Uy' } }),
      },
    } as unknown as LudyClient;
    expect(await resolveSalesCoworkerName(todayFallbackClient)).toBe('Vy Sales');

    const failingClient = {
      chart: {
        get: async () => {
          throw new Error('network down');
        },
        templates: async () => [],
      },
    } as unknown as LudyClient;
    expect(await resolveSalesCoworkerName(failingClient)).toBe(DEFAULT_SALES_COWORKER);

    const authClient = {
      chart: {
        get: async () => {
          throw Object.assign(new Error('MFA'), { code: 'MFA_REQUIRED', status: 401 });
        },
        templates: async () => [],
      },
    } as unknown as LudyClient;
    await expect(resolveSalesCoworkerName(authClient)).rejects.toMatchObject({ code: 'MFA_REQUIRED' });
  });
});
