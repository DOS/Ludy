// SPDX-License-Identifier: AGPL-3.0-only
// Approved minutes posted to a Slack or Microsoft Teams channel (Meetings B4, #3168), the API's half. The API SEALS the address and never opens it (ADR-0025); the worker's job posts it
// (meeting-chat-job.ts).
//   saveMinutesChannel  an owner or admin pastes a webhook address; the route checks it is the service's own (https, its hosts, its path shape), seals it with the credential broker for the binding
//                       (org, 'meeting-chat', the channel's id) and hands the command only the envelope. The address is never read back, shown again or logged.
//   postMinutesFromClick the recorder's "Gửi": the key of what they read is checked against the message the module builds from the published result (STALE_CHAT), and the command meetings.chat.post queues
//                       the post (its row and its message, in the recorder's own transaction). Nothing leaves in this request: the sweep hands the post to the queue and the job sends it.
import { randomUUID } from 'node:crypto';
import { parseMinutesUrl } from '@crove/channel';
import { MEETING_CHAT_PROVIDER, type ChatChannelSaveCall, type ChatChannelSaved, type ChatPostCall, type ChatPosted, type ChatPreview } from '@crove/kernel-contract';
import { DomainError, type CredentialBroker, type Runtime, type UserActor } from '@crove/kernel-runtime';
import { RateLimiter } from './rate-limit.ts';

export interface MinutesChatDeps {
  runtime: Runtime;
  // Seals the address; never opens one here.
  broker: Pick<CredentialBroker, 'id' | 'seal'>;
  // The web app's address, for the link back in the message (the app route is /o/<slug>/meetings/<id>).
  publicUrl: string;
  // Saves of an address, per org.
  saves?: MinutesSaveBudget;
}

// A few saves a minute per org: an address form is not a loop.
export class MinutesSaveBudget {
  private readonly limiter: RateLimiter;
  constructor(perMinute = 10, now?: () => number) {
    this.limiter = new RateLimiter({ perMinute, ...(now ? { now } : {}) });
  }
  take(key: string) {
    const decision = this.limiter.take(key);
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

const BAD_ADDRESS = {
  slack: 'Hãy dán địa chỉ Incoming Webhook của Slack, dạng https://hooks.slack.com/services/...',
  teams: 'Hãy dán địa chỉ webhook của quy trình Teams (Workflows), dạng https://...logic.azure.com/workflows/... hoặc https://...api.powerplatform.com/powerautomate/...',
} as const;

// Adds a channel, or pastes a new address into one. The address is checked here, sealed here and dropped here: the command gets the envelope.
export async function saveMinutesChannel(deps: MinutesChatDeps, scope: MinutesChatScope, input: ChatChannelSaveCall): Promise<ChatChannelSaved> {
  if (deps.broker.id === 'none') throw NO_KEY();
  // The budget is per org and member, so a member who is refused later cannot use up the owner's saves.
  (deps.saves ?? defaultSaves).take(`${scope.orgId}:${scope.actor.userId}`);
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

// The address a post carries back to the meeting: the app's address, the org and the meeting. null without an app address or an org slug. The dialog shows this very value (the preview returns it).
export function minutesLink(publicUrl: string, orgSlug: string | null, meetingId: string): string | null {
  const base = publicUrl.replace(/\/$/, '');
  // Only an https address: a link the channel's readers open must not be plain http (a local dev address carries no link).
  return base.startsWith('https://') && orgSlug ? `${base}/o/${encodeURIComponent(orgSlug)}/meetings/${meetingId}` : null;
}

// The recorder's click. Throws a DomainError for what refuses before anything is queued (not published, the facts changed, a tick missing, a post already waiting, the limit); otherwise the post is
// queued and this answers with its id: the job sends it and the dialog asks `meetings.chat.status` how it stands.
export async function postMinutesFromClick(deps: MinutesChatDeps, scope: MinutesChatScope, input: ChatPostCall): Promise<ChatPosted> {
  // Without a credential key no worker opens an address, so a post would wait with its message: refuse it here.
  if (deps.broker.id === 'none') throw NO_KEY();
  const ctx = { actor: scope.actor, orgId: scope.orgId };
  // The message the recorder is about to send, from the published result in their own context: only to compare its key, the module rebuilds it again in the command.
  const view = await deps.runtime.query<ChatPreview>('meetings.chat.preview', { meetingId: input.meetingId }, ctx);
  if (view.factsKey !== input.factsKey) throw new DomainError('STALE_CHAT', 409, 'Biên bản của cuộc họp đã thay đổi từ lúc bạn mở hộp gửi; hãy mở lại để xem nội dung mới');
  return deps.runtime.execute<ChatPosted>(
    'meetings.chat.post',
    { meetingId: input.meetingId, channelId: input.channelId, factsKey: view.factsKey, confirmRepeat: input.confirmRepeat, link: minutesLink(deps.publicUrl, scope.orgSlug, input.meetingId) },
    ctx,
  );
}
