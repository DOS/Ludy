// SPDX-License-Identifier: AGPL-3.0-only
// Conversation reply, AI draft, and read-mark action executors with strict live-window, viewer, placeholder, and offline guards (issue #4882).

import { isMfaRequired, isStepUpRequired, type LudyClient } from '@ludy/client';
import {
  evaluateReplyWindow,
  hasNamePlaceholder,
  isAuthBlockingError,
  isConversationMissingError,
  isConversationMovedError,
  isLikelyNetworkError,
  isRateLimitedError,
  isReplyWindowClosedError,
  readErrorCodeAndStatus,
  resolveReplyMax,
  type ConversationDetail,
  type OrgRole,
  type ReplyBlockReason,
} from './model.ts';

export type ConversationActionOutcome<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason:
        | 'offline'
        | 'viewer'
        | 'blocked'
        | 'window-closed'
        | 'empty'
        | 'invalid-char'
        | 'too-long'
        | 'placeholder'
        | 'moved'
        | 'not-found'
        | 'rate-limited'
        | 'ai-off'
        | 'kernel-step-up'
        | 'auth'
        | 'refused';
      blockReason?: ReplyBlockReason;
      max?: number;
      retryAfterSeconds?: number | null;
      code?: string | null;
      message?: string;
    };

interface ConversationActionDeps {
  client: LudyClient;
  isOffline?: boolean;
  now?: () => number;
  onKernelError?: (error: unknown) => void;
}

function mapActionError<T>(
  error: unknown,
  onKernelError?: (error: unknown) => void,
): ConversationActionOutcome<T> {
  if (isStepUpRequired(error) || isMfaRequired(error)) {
    onKernelError?.(error);
    return { ok: false, reason: 'kernel-step-up' };
  }
  if (isAuthBlockingError(error)) {
    onKernelError?.(error);
    return { ok: false, reason: 'auth' };
  }
  if (isConversationMissingError(error)) {
    const { code, message } = readErrorCodeAndStatus(error);
    return { ok: false, reason: 'not-found', code, message };
  }
  if (isConversationMovedError(error)) {
    const { message } = readErrorCodeAndStatus(error);
    return { ok: false, reason: 'moved', code: 'CONVERSATION_MOVED', message };
  }
  if (isReplyWindowClosedError(error)) {
    const { message } = readErrorCodeAndStatus(error);
    return {
      ok: false,
      reason: 'window-closed',
      blockReason: 'window_closed',
      code: 'REPLY_WINDOW_CLOSED',
      message,
    };
  }
  const rate = isRateLimitedError(error);
  if (rate.rateLimited) {
    const { message } = readErrorCodeAndStatus(error);
    return {
      ok: false,
      reason: 'rate-limited',
      retryAfterSeconds: rate.retryAfterSeconds,
      code: 'RATE_LIMITED',
      message,
    };
  }
  if (isLikelyNetworkError(error)) {
    return { ok: false, reason: 'offline' };
  }
  const { code, message } = readErrorCodeAndStatus(error);
  return { ok: false, reason: 'refused', code, message };
}

interface SendConversationReplyInput {
  detail: ConversationDetail;
  body: string;
  lastSeenSeq?: number;
  draftId?: string;
  savedReplyId?: string;
  role: OrgRole;
}

export async function sendConversationReply(
  deps: ConversationActionDeps,
  input: SendConversationReplyInput,
): Promise<ConversationActionOutcome<Awaited<ReturnType<LudyClient['conversations']['reply']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  if (input.role === 'viewer') return { ok: false, reason: 'viewer' };

  const nowFn = deps.now ?? (() => Date.now());
  const windowState = evaluateReplyWindow({
    replyWindowUntil: input.detail.conversation.replyWindowUntil,
    reply: input.detail.reply,
    nowMs: nowFn(),
  });
  if (!windowState.allowed) {
    return {
      ok: false,
      reason: windowState.blockReason === 'window_closed' ? 'window-closed' : 'blocked',
      blockReason: windowState.blockReason ?? 'not_supported',
    };
  }

  if (input.body.includes('\u0000')) {
    return { ok: false, reason: 'invalid-char' };
  }
  const trimmed = input.body.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  const max = resolveReplyMax(input.detail.conversation.channel.provider, input.detail.conversation.kind);
  if (trimmed.length > max) {
    return { ok: false, reason: 'too-long', max };
  }
  if (hasNamePlaceholder(trimmed)) {
    return { ok: false, reason: 'placeholder' };
  }

  try {
    const value = await deps.client.conversations.reply({
      conversationId: input.detail.conversation.id,
      body: trimmed,
      lastSeenSeq: input.lastSeenSeq ?? input.detail.conversation.lastSeq,
      ...(input.draftId ? { draftId: input.draftId } : {}),
      ...(input.savedReplyId ? { savedReplyId: input.savedReplyId } : {}),
    });
    return { ok: true, value };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}

export async function requestConversationDraft(
  deps: ConversationActionDeps,
  input: { conversationId: string; role: OrgRole; aiEnabled: boolean },
): Promise<ConversationActionOutcome<Awaited<ReturnType<LudyClient['conversations']['draftRequest']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  if (input.role === 'viewer') return { ok: false, reason: 'viewer' };
  if (!input.aiEnabled) return { ok: false, reason: 'ai-off' };

  try {
    const value = await deps.client.conversations.draftRequest({
      conversationId: input.conversationId,
    });
    return { ok: true, value };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}

export async function discardConversationDraft(
  deps: ConversationActionDeps,
  input: { draftId: string; role: OrgRole },
): Promise<ConversationActionOutcome<Awaited<ReturnType<LudyClient['conversations']['draftDiscard']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  if (input.role === 'viewer') return { ok: false, reason: 'viewer' };

  try {
    const value = await deps.client.conversations.draftDiscard({
      draftId: input.draftId,
    });
    return { ok: true, value };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}

export async function markConversationRead(
  deps: ConversationActionDeps,
  input: { conversationId: string; seq: number },
): Promise<ConversationActionOutcome<Awaited<ReturnType<LudyClient['conversations']['markRead']>>>> {
  if (deps.isOffline) return { ok: false, reason: 'offline' };
  try {
    const value = await deps.client.conversations.markRead({
      conversationId: input.conversationId,
      seq: input.seq,
    });
    return { ok: true, value };
  } catch (error) {
    return mapActionError(error, deps.onKernelError);
  }
}
