// SPDX-License-Identifier: AGPL-3.0-only
// Conversations on a channel (issue #2303, plan docs/plan/conversations.md sections 6 and 7): what a platform's notice says
// in the core's own words, and how a reply or a hide goes out. A provider's adapter parses its signed notice into events
// and answers a reply with accepted, rejected (typed) or unknown. No platform send call has an idempotency key, so a reply
// is never retried by the caller after an unknown answer.
import { randomBytes } from 'node:crypto';

export type ConversationKindId = 'comment_thread' | 'direct';

// One thing a notice told us. `contact` is the customer of the thread; `direction` out is the org's own message seen from
// the platform's inbox (an echo).
export interface InboundConversationEvent {
  kind: ConversationKindId;
  threadId: string;
  postId?: string | undefined;
  messageId: string;
  direction: 'in' | 'out';
  contact: { id: string; name?: string | undefined };
  text: string;
  at: string;
  removed?: boolean | undefined;
}

// A verified notice: the platform's own account id (a Page, an Instagram account, an OA), from which the worker finds the
// connections, and the events. The org never comes from a notice.
export interface ConversationNotice {
  accountId: string;
  events: InboundConversationEvent[];
  // The sandbox only: the one connection its notice is for. Its account id is a key a member chose, so two orgs may pick the
  // same one, and a demo comment must reach only the connection it was made on. A platform's notice never has it.
  connectionId?: string | undefined;
}

export class ConversationNoticeError extends Error {
  readonly reason: 'malformed' | 'signature';
  constructor(reason: 'malformed' | 'signature') {
    super(reason);
    this.name = 'ConversationNoticeError';
    this.reason = reason;
  }
}

export type ConversationErrorKind = 'token_expired' | 'permission' | 'bad_request' | 'rate_limited' | 'transient';

export type ConversationCallResult =
  | { kind: 'accepted'; externalId: string }
  | { kind: 'rejected'; error: ConversationErrorKind; code?: string; retryAt?: Date }
  | { kind: 'unknown'; code?: string };

export interface ConversationReplyInput {
  externalAccountId: string;
  // The opened credential (the provider's own JSON); never logged or stored by the adapter.
  secret: string;
  kind: ConversationKindId;
  // The thread's platform id, the post it is under (comment threads) and the person it is with.
  threadId: string;
  postId: string | null;
  contactId: string;
  text: string;
  // The deterministic key of the call, for the platform's own record and the tests.
  callKey: string;
}

export interface ConversationHideInput {
  externalAccountId: string;
  secret: string;
  // The comment's platform id.
  externalMessageId: string;
  hidden: boolean;
  callKey: string;
}

export type ConversationHideResult =
  | { kind: 'done' }
  | { kind: 'rejected'; error: ConversationErrorKind; code?: string; retryAt?: Date }
  | { kind: 'unknown'; code?: string };

// What a provider can do with a conversation. Hide is idempotent on the platforms that have it, so it may be repeated.
export interface ConversationAdapter {
  readonly provider: string;
  reply(input: ConversationReplyInput): Promise<ConversationCallResult>;
  hide?(input: ConversationHideInput): Promise<ConversationHideResult>;
}

const MAX_NOTICE_BYTES = 262_144;

// The sandbox's notice: `{"v":1,"accountId":"sandbox-x","events":[...]}`. It is unsigned (it never leaves the deployment: the
// API makes it for a demo comment a member asked for), and the events are checked again by the kernel command.
export function parseSandboxNotice(body: Uint8Array): ConversationNotice {
  if (body.byteLength === 0 || body.byteLength > MAX_NOTICE_BYTES) throw new ConversationNoticeError('malformed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new ConversationNoticeError('malformed');
  }
  const notice = parsed as { v?: unknown; accountId?: unknown; connectionId?: unknown; events?: unknown };
  if (notice.v !== 1 || typeof notice.accountId !== 'string' || notice.accountId.length === 0 || !Array.isArray(notice.events)) {
    throw new ConversationNoticeError('malformed');
  }
  return { accountId: notice.accountId, events: notice.events as InboundConversationEvent[], ...(typeof notice.connectionId === 'string' ? { connectionId: notice.connectionId } : {}) };
}

export function sandboxNoticeBody(notice: ConversationNotice): Buffer {
  return Buffer.from(JSON.stringify({ v: 1, accountId: notice.accountId, ...(notice.connectionId ? { connectionId: notice.connectionId } : {}), events: notice.events }), 'utf8');
}

function sandboxToken(secret: string): boolean {
  try {
    const accessToken = (JSON.parse(secret) as { accessToken?: unknown }).accessToken;
    return typeof accessToken === 'string' && accessToken.startsWith('sbx_');
  } catch {
    return false;
  }
}

export interface SandboxReply {
  callKey: string;
  externalAccountId: string;
  threadId: string;
  text: string;
  id: string;
}

// The sandbox platform for conversations: replies and hides live in this process's memory, so the whole flow runs on a laptop
// and in tests. A reply to a comment thread or a private chat is accepted for any thread of an account with a sandbox token.
export class SandboxConversations implements ConversationAdapter {
  readonly provider = 'sandbox' as const;
  readonly replies: SandboxReply[] = [];
  readonly hidden = new Set<string>();

  async reply(input: ConversationReplyInput): Promise<ConversationCallResult> {
    if (!sandboxToken(input.secret)) return { kind: 'rejected', error: 'token_expired', code: 'SANDBOX_TOKEN' };
    if (input.text.length === 0) return { kind: 'rejected', error: 'bad_request', code: 'EMPTY' };
    const id = `sbx_reply_${randomBytes(9).toString('base64url')}`;
    this.replies.push({ callKey: input.callKey, externalAccountId: input.externalAccountId, threadId: input.threadId, text: input.text, id });
    // A sandbox that runs for weeks keeps only the latest thousand.
    if (this.replies.length > 1000) this.replies.splice(0, this.replies.length - 1000);
    return { kind: 'accepted', externalId: id };
  }

  async hide(input: ConversationHideInput): Promise<ConversationHideResult> {
    if (!sandboxToken(input.secret)) return { kind: 'rejected', error: 'token_expired', code: 'SANDBOX_TOKEN' };
    if (input.hidden) this.hidden.add(input.externalMessageId);
    else this.hidden.delete(input.externalMessageId);
    return { kind: 'done' };
  }
}
