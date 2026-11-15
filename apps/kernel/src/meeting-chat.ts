// SPDX-License-Identifier: AGPL-3.0-only
// Approved minutes posted to a Slack or Microsoft Teams channel (Meetings B4, #3168), the API's half. It runs in the recorder's own request, with no worker and no queue:
//   saveMinutesChannel  an owner or admin pastes a webhook address; the route checks it is the service's own (https, its hosts, its path shape), seals it with the credential broker for the binding
//                       (org, 'meeting-chat', the channel's id) and hands the command only the envelope. The address is never read back, shown again or logged.
//   postMinutes         the recorder's "Gửi": (1) the module builds the message from the published result and the key of what the recorder read is checked (STALE_CHAT), (2) meetings.chat.begin
//                       rewrites the message itself, checks it matches, the tick for a repeat and the day's limit, and commits a `started` row BEFORE any call, (3) the sealed address of that post is
//                       fetched (the database answers only the API process, only for this recorder's own post in flight) and opened with the broker, (4) one POST through the egress guard (https only,
//                       public addresses, no redirect followed, a 4 KB answer cap, the host checked again against the adapter's own list), (5) meetings.chat.settle records sent, failed or ambiguous.
// Retry is the recorder's own click. A post that may be in the channel (a timeout, a dropped connection, a server error) is `ambiguous` and needs the recorder's tick to be repeated. The address is
// opened here and nowhere else, never goes through a command input or output, an audit row or a log, and no line below names it.
import { randomUUID } from 'node:crypto';
import { minutesHostAllowed, parseMinutesUrl, postMinutes, type MinutesFetch, type MinutesKind, type MinutesPostResult } from '@crove/channel';
import {
  MEETING_CHAT_PROVIDER,
  chatMessageCanonical,
  type ChatBegun,
  type ChatChannelSaveCall,
  type ChatChannelSaved,
  type ChatPostCall,
  type ChatPosted,
  type ChatPreview,
  type ChatTarget,
} from '@crove/kernel-contract';
import { DomainError, egressFetch, sha256Hex, type CredentialBroker, type EgressOptions, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { RateLimiter } from './rate-limit.ts';

export interface MinutesChatDeps {
  runtime: Runtime;
  broker: Pick<CredentialBroker, 'id' | 'seal' | 'open'>;
  // The web app's address, for the link back in the message (the app route is /o/<slug>/meetings/<id>).
  publicUrl: string;
  // Tests only: the fetch the adapter posts with (the adapter still checks the host), or the guard's options (a local server, a name that resolves).
  send?: MinutesFetch;
  egress?: Partial<EgressOptions>;
  // Saves of an address, per org.
  saves?: MinutesSaveBudget;
}

// A few saves a minute per org: an address form is not a loop.
export class MinutesSaveBudget {
  private readonly limiter: RateLimiter;
  constructor(perMinute = 10, now?: () => number) {
    this.limiter = new RateLimiter({ perMinute, ...(now ? { now } : {}) });
  }
  take(orgId: string) {
    const decision = this.limiter.take(orgId);
    if (!decision.allowed) throw new DomainError('CHAT_SAVE_LIMIT', 429, 'Bạn vừa lưu kênh nhiều lần; hãy đợi một phút rồi thử lại', { retryAfterSeconds: decision.retryAfterSeconds });
  }
}
const defaultSaves = new MinutesSaveBudget();

export interface MinutesChatScope {
  orgId: string;
  orgSlug: string | null;
  actor: UserActor;
}

const NO_KEY = () => new DomainError('BROKER_NOT_CONFIGURED', 503, 'Chưa cấu hình khóa mã hóa thông tin kết nối (CREDENTIAL_KEY)');

const BAD_ADDRESS: Record<MinutesKind, string> = {
  slack: 'Hãy dán địa chỉ Incoming Webhook của Slack, dạng https://hooks.slack.com/services/...',
  teams: 'Hãy dán địa chỉ webhook của quy trình Teams (Workflows), dạng https://...logic.azure.com/workflows/... hoặc https://...api.powerplatform.com/powerautomate/...',
};

// Adds a channel, or pastes a new address into one. The address is checked here, sealed here and dropped here: the command gets the envelope.
export async function saveMinutesChannel(deps: MinutesChatDeps, scope: MinutesChatScope, input: ChatChannelSaveCall): Promise<ChatChannelSaved> {
  if (deps.broker.id === 'none') throw NO_KEY();
  (deps.saves ?? defaultSaves).take(scope.orgId);
  const parsed = parseMinutesUrl(input.kind, input.url);
  if (!parsed) throw new DomainError('CHAT_URL_INVALID', 422, BAD_ADDRESS[input.kind]);
  const id = input.id ?? randomUUID();
  const sealed = deps.broker.seal(parsed.url, { orgId: scope.orgId, provider: MEETING_CHAT_PROVIDER, externalAccountId: id });
  return deps.runtime.execute<ChatChannelSaved>(
    'meetings.chat.channel_save',
    { id, kind: input.kind, label: input.label, host: parsed.host, keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope).toString('base64') },
    { actor: scope.actor, orgId: scope.orgId },
  );
}

const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

// The recorder's click. Throws a DomainError for what refuses before anything is sent (not published, the facts changed, a tick missing, the limit); once a call may have left, it answers with the outcome.
export async function postMinutesFromClick(deps: MinutesChatDeps, scope: MinutesChatScope, input: ChatPostCall): Promise<ChatPosted> {
  if (deps.broker.id === 'none') throw NO_KEY();
  const ctx = { actor: scope.actor, orgId: scope.orgId };
  // 1. The message the recorder is about to send, from the published result in their own context.
  const view = await deps.runtime.query<ChatPreview>('meetings.chat.preview', { meetingId: input.meetingId }, ctx);
  if (view.factsKey !== input.factsKey) throw new DomainError('STALE_CHAT', 409, 'Biên bản của cuộc họp đã thay đổi từ lúc bạn mở hộp gửi; hãy mở lại để xem nội dung mới');
  // 2. The click, committed before any call. The command rebuilds the message and agrees only to this one.
  const begun = await deps.runtime.execute<ChatBegun>(
    'meetings.chat.begin',
    { meetingId: input.meetingId, channelId: input.channelId, factsKey: view.factsKey, textHash: sha256Hex(chatMessageCanonical(view.message)), confirmRepeat: input.confirmRepeat },
    ctx,
  );
  const base = deps.publicUrl.replace(/\/$/, '');
  const link = base !== '' && scope.orgSlug ? `${base}/o/${encodeURIComponent(scope.orgSlug)}/meetings/${input.meetingId}` : null;
  let result: MinutesPostResult;
  try {
    // 3. The sealed address of this post, opened with the broker; it lives in this scope only.
    const sealed = await deps.runtime.query<ChatTarget>('meetings.chat.target', { postId: begun.postId }, ctx);
    const address = deps.broker.open({ keyId: sealed.keyId, envelope: Buffer.from(sealed.envelope, 'base64') }, { orgId: scope.orgId, provider: MEETING_CHAT_PROVIDER, externalAccountId: input.channelId });
    // 4. One call.
    const send: MinutesFetch =
      deps.send ?? egressFetch({ timeoutMs: 10_000, maxBytes: 4 * 1024, overLimit: 'truncate', httpsOnly: true, userAgent: 'Ludy-Minutes/1', hostAllowed: (host) => minutesHostAllowed(begun.kind, host), ...deps.egress });
    result = await postMinutes(begun.kind, address, view.message, link, send);
  } catch (error) {
    // A key that no longer opens (a rotated or lost credential key) or an address that is gone: nothing went out. Said by code, never with the cause's text.
    console.warn(`[meeting-chat] ${begun.postId.slice(0, 8)} not posted`, codeOf(error));
    result = { state: 'failed', httpStatus: null, code: 'CHANNEL_ADDRESS_UNREADABLE', retryAfterSeconds: null };
  }
  // 5. The outcome. A record that fails leaves the post `started`, which the screen reads as ambiguous after two minutes; the recorder still gets the answer.
  await deps.runtime.execute('meetings.chat.settle', { postId: begun.postId, state: result.state, httpStatus: result.httpStatus, code: result.code }, ctx).catch((error: unknown) => {
    console.warn(`[meeting-chat] ${begun.postId.slice(0, 8)} outcome not recorded`, codeOf(error));
  });
  return { postId: begun.postId, state: result.state, retryAfterSeconds: result.retryAfterSeconds, code: result.code };
}
