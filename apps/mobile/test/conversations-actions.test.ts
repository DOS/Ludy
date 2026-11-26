// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { LudyClient } from '@ludy/client';
import {
  discardConversationDraft,
  markConversationRead,
  requestConversationDraft,
  sendConversationReply,
} from '../src/screens/conversations/actions.ts';
import type { ConversationDetail } from '../src/screens/conversations/model.ts';

function fakeDetail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  const convOverride = overrides.conversation;
  return {
    conversation: {
      id: '00000000-0000-4000-8000-000000000201',
      kind: 'direct',
      status: 'new',
      channel: {
        connectionId: '00000000-0000-4000-8000-000000000010',
        provider: 'zalo_oa',
        displayName: 'Zalo OA Shop',
      },
      postId: null,
      contact: {
        identityId: '00000000-0000-4000-8000-000000000020',
        displayName: 'Thu Hà',
        idTail: '1122',
        partyId: null,
        partyName: null,
        address: null,
      },
      assigneeUserId: null,
      lastSeq: 5,
      lastMessageAt: '2026-11-26T10:00:00.000Z',
      lastInboundAt: '2026-11-26T10:00:00.000Z',
      replyWindowUntil: '2026-11-28T10:00:00.000Z',
      preview: 'Shop còn màu xanh không?',
      unread: true,
      composing: [],
      intent: null,
      ...convOverride,
    },
    messages: [],
    notes: [],
    parentId: null,
    reply: { allowed: true, reason: null },
    gap: null,
    draft: null,
    suggestions: [],
    others: [],
    ...overrides,
  };
}

describe('sendConversationReply guards and kernel error mapping', () => {
  it('enforces offline, viewer, live Zalo 48h window expiry, replyMax, NUL, and {tên} placeholder guards', async () => {
    let called = false;
    const client = {
      conversations: {
        reply: async () => {
          called = true;
          return { messageId: 'm1', seq: 6 };
        },
      },
    } as unknown as LudyClient;

    const detail = fakeDetail();
    const openNow = () => Date.parse('2026-11-27T10:00:00.000Z');
    const expiredNow = () => Date.parse('2026-11-28T10:00:00.000Z');

    expect(
      await sendConversationReply(
        { client, isOffline: true, now: openNow },
        { detail, body: 'Dạ còn ạ', role: 'member' },
      ),
    ).toEqual({ ok: false, reason: 'offline' });

    expect(
      await sendConversationReply(
        { client, now: openNow },
        { detail, body: 'Dạ còn ạ', role: 'viewer' },
      ),
    ).toEqual({ ok: false, reason: 'viewer' });

    // Even when detail.reply.allowed was true on fetch, live clock expiry strictly blocks sending.
    expect(
      await sendConversationReply(
        { client, now: expiredNow },
        { detail, body: 'Dạ còn ạ', role: 'owner' },
      ),
    ).toEqual({ ok: false, reason: 'window-closed', blockReason: 'window_closed' });

    // Server-side non-window block reason (e.g. channel_inactive).
    const inactiveDetail = fakeDetail({ reply: { allowed: false, reason: 'channel_inactive' } });
    expect(
      await sendConversationReply(
        { client, now: openNow },
        { detail: inactiveDetail, body: 'Dạ còn ạ', role: 'owner' },
      ),
    ).toEqual({ ok: false, reason: 'blocked', blockReason: 'channel_inactive' });

    expect(
      await sendConversationReply(
        { client, now: openNow },
        { detail, body: '   ', role: 'member' },
      ),
    ).toEqual({ ok: false, reason: 'empty' });

    expect(
      await sendConversationReply(
        { client, now: openNow },
        { detail, body: 'abc\u0000def', role: 'member' },
      ),
    ).toEqual({ ok: false, reason: 'invalid-char' });

    // Zalo OA max is 2000 characters.
    expect(
      await sendConversationReply(
        { client, now: openNow },
        { detail, body: 'a'.repeat(2001), role: 'member' },
      ),
    ).toEqual({ ok: false, reason: 'too-long', max: 2000 });

    // Unresolved {tên} placeholder is blocked before hitting server.
    expect(
      await sendConversationReply(
        { client, now: openNow },
        { detail, body: 'Dạ chào {tên}, còn hàng ạ', role: 'member' },
      ),
    ).toEqual({ ok: false, reason: 'placeholder' });

    expect(called).toBe(false);
  });

  it('sends trimmed reply with draftId or savedReplyId and handles CONVERSATION_MOVED (409)', async () => {
    const sentPayloads: Array<Record<string, unknown>> = [];
    const client = {
      conversations: {
        reply: async (input: Record<string, unknown>) => {
          sentPayloads.push(input);
          return { messageId: 'm-new', seq: 6 };
        },
      },
    } as unknown as LudyClient;

    const res = await sendConversationReply(
      { client, now: () => Date.parse('2026-11-27T10:00:00.000Z') },
      {
        detail: fakeDetail(),
        body: '  Dạ chào Thu Hà, shop còn màu xanh ạ.  ',
        lastSeenSeq: 5,
        draftId: '00000000-0000-4000-8000-000000000301',
        role: 'member',
      },
    );
    expect(res).toEqual({ ok: true, value: { messageId: 'm-new', seq: 6 } });
    expect(sentPayloads[0]).toEqual({
      conversationId: '00000000-0000-4000-8000-000000000201',
      body: 'Dạ chào Thu Hà, shop còn màu xanh ạ.',
      lastSeenSeq: 5,
      draftId: '00000000-0000-4000-8000-000000000301',
    });

    const movedClient = {
      conversations: {
        reply: async () => {
          throw Object.assign(new Error('Hội thoại vừa có tin mới'), {
            code: 'CONVERSATION_MOVED',
            status: 409,
          });
        },
      },
    } as unknown as LudyClient;

    const movedRes = await sendConversationReply(
      { client: movedClient, now: () => Date.parse('2026-11-27T10:00:00.000Z') },
      { detail: fakeDetail(), body: 'Draft kept safe', role: 'admin' },
    );
    expect(movedRes).toEqual({
      ok: false,
      reason: 'moved',
      code: 'CONVERSATION_MOVED',
      message: 'Hội thoại vừa có tin mới',
    });
  });

  it('forwards auth, MFA, revocation, and step-up errors via onKernelError', async () => {
    const errors = [
      Object.assign(new Error('unauth'), { code: 'UNAUTHENTICATED', status: 401 }),
      Object.assign(new Error('mfa'), { code: 'MFA_REQUIRED', status: 401 }),
      Object.assign(new Error('revoked'), { code: 'SESSION_REVOKED_IN_ORG', status: 403 }),
      Object.assign(new Error('step-up'), { code: 'STEP_UP_REQUIRED', status: 403 }),
    ];

    const forwarded: unknown[] = [];
    for (const err of errors) {
      const client = {
        conversations: {
          reply: async () => {
            throw err;
          },
        },
      } as unknown as LudyClient;

      const out = await sendConversationReply(
        {
          client,
          now: () => Date.parse('2026-11-27T10:00:00.000Z'),
          onKernelError: (e) => forwarded.push(e),
        },
        { detail: fakeDetail(), body: 'Xin chào', role: 'owner' },
      );
      expect(out.ok).toBe(false);
    }
    expect(forwarded).toEqual(errors);
  });
});

describe('AI draft request/discard and markRead executors', () => {
  it('enforces offline, viewer, aiEnabled=false guards and handles 429 RATE_LIMITED cleanly', async () => {
    let asked = false;
    const client = {
      conversations: {
        draftRequest: async () => {
          asked = true;
          return { draftId: 'd-1', queued: true };
        },
        draftDiscard: async () => ({ discarded: true }),
        markRead: async () => ({ conversationId: 'c-1' }),
      },
    } as unknown as LudyClient;

    expect(
      await requestConversationDraft(
        { client, isOffline: true },
        { conversationId: 'c-1', role: 'member', aiEnabled: true },
      ),
    ).toEqual({ ok: false, reason: 'offline' });

    expect(
      await requestConversationDraft(
        { client },
        { conversationId: 'c-1', role: 'viewer', aiEnabled: true },
      ),
    ).toEqual({ ok: false, reason: 'viewer' });

    expect(
      await requestConversationDraft(
        { client },
        { conversationId: 'c-1', role: 'member', aiEnabled: false },
      ),
    ).toEqual({ ok: false, reason: 'ai-off' });

    expect(asked).toBe(false);

    expect(
      await requestConversationDraft(
        { client },
        { conversationId: 'c-1', role: 'member', aiEnabled: true },
      ),
    ).toEqual({ ok: true, value: { draftId: 'd-1', queued: true } });

    const rateLimitedClient = {
      conversations: {
        draftRequest: async () => {
          throw Object.assign(new Error('Too many draft asks'), {
            code: 'RATE_LIMITED',
            status: 429,
            data: { retryAfterSeconds: 18 },
          });
        },
      },
    } as unknown as LudyClient;

    expect(
      await requestConversationDraft(
        { client: rateLimitedClient },
        { conversationId: 'c-1', role: 'member', aiEnabled: true },
      ),
    ).toEqual({
      ok: false,
      reason: 'rate-limited',
      retryAfterSeconds: 18,
      code: 'RATE_LIMITED',
      message: 'Too many draft asks',
    });

    expect(
      await discardConversationDraft({ client, isOffline: true }, { draftId: 'd-1', role: 'member' }),
    ).toEqual({ ok: false, reason: 'offline' });
    expect(
      await discardConversationDraft({ client }, { draftId: 'd-1', role: 'viewer' }),
    ).toEqual({ ok: false, reason: 'viewer' });
    expect(
      await discardConversationDraft({ client }, { draftId: 'd-1', role: 'member' }),
    ).toEqual({ ok: true, value: { discarded: true } });

    expect(
      await markConversationRead({ client, isOffline: true }, { conversationId: 'c-1', seq: 5 }),
    ).toEqual({ ok: false, reason: 'offline' });
    expect(
      await markConversationRead({ client }, { conversationId: 'c-1', seq: 5 }),
    ).toEqual({ ok: true, value: { conversationId: 'c-1' } });

    const missingClient = {
      conversations: {
        markRead: async () => {
          throw Object.assign(new Error('Gone'), { code: 'CONVERSATION_NOT_FOUND', status: 404 });
        },
        reply: async () => {
          throw Object.assign(new Error('Write forbidden'), { code: 'FORBIDDEN', status: 403 });
        },
      },
    } as unknown as LudyClient;

    expect(
      await markConversationRead({ client: missingClient }, { conversationId: 'c-1', seq: 5 }),
    ).toEqual({
      ok: false,
      reason: 'not-found',
      code: 'CONVERSATION_NOT_FOUND',
      message: 'Gone',
    });

    // Write permission denial (403 FORBIDDEN) stays 'refused' rather than falsely evicting read access.
    expect(
      await sendConversationReply(
        { client: missingClient, now: () => Date.parse('2026-11-26T10:00:00.000Z') },
        {
          detail: makeDetail(),
          body: 'Xin chào',
          lastSeenSeq: 1,
          role: 'member',
        },
      ),
    ).toEqual({
      ok: false,
      reason: 'refused',
      code: 'FORBIDDEN',
      message: 'Write forbidden',
    });
  });
});
