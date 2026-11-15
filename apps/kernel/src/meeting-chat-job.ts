// SPDX-License-Identifier: AGPL-3.0-only
// The delivery of one post of approved minutes to a Slack or Teams channel (meetings integrations B4, issue #3168, plan docs/plan/meetings-integrations.md section 5.2). One job per post: it loads the
// queued post and its message, fetches the sealed address of its channel (only while the channel stands: the member who saved it is still an owner or admin and not disabled, the org active), opens it
// with the credential broker (ADR-0025: the worker opens, the API never does), posts once through the egress guard and records what happened. The message is deleted by the database the moment the post
// settles.
//
// - The request is packages/channel's postMinutes: https only, the service's own host (checked again here), no redirect followed, a 4 KB answer cap that is never parsed, at most 10 s an attempt.
// - Retried only when it is safe: a failure that proves nothing arrived (the guard refused the address, the name did not resolve, the service said to wait) is tried again, a few times with a delay; an
//   answer that may have been delivered (a timeout, a dropped connection, a server error) is `ambiguous` and is NEVER sent again by the job. A repeat is the recorder's own click, with their tick.
// - No model is called anywhere on this path: what leaves is what the recorder read and approved.
// - A failure never touches the meeting or its minutes: it changes this post's row, nothing else. A channel that no longer stands drops the post.
import { postMinutes, minutesHostAllowed, type MinutesFetch, type MinutesPostResult } from '@crove/channel';
import { MEETING_CHAT_PROVIDER, zChatBody, type ChatBody, type ChatDeliveryRow, type ChatTarget } from '@crove/kernel-contract';
import { DomainError, egressFetch, type CredentialBroker, type EgressOptions, type Runtime } from '@crove/kernel-runtime';

const ACTOR = { type: 'system' as const, component: 'meetings.chat' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

// One attempt takes at most 10 seconds, and reads at most 4 KB of the answer.
const ATTEMPT_MS = 10_000;
const MAX_ANSWER = 4 * 1024;
// The queue's retries, for the failures that are safe to try again: three more tries, from a minute on and doubling. A post still waiting after eight hours is failed by the sweep.
export const CHAT_RETRY_LIMIT = 3;
export const CHAT_RETRY_DELAY_SECONDS = 60;
// A job that runs longer than this is expired (an attempt's own deadline is shorter).
export const CHAT_JOB_EXPIRE_SECONDS = 60;
// The failures that proved nothing arrived, which a later attempt may get past.
const RETRYABLE = new Set(['CHANNEL_UNREACHABLE', 'CHANNEL_RATE_LIMITED']);

export interface ChatJob {
  orgId: string;
  id: string;
}

export interface ChatDeps {
  runtime: Runtime;
  broker: Pick<CredentialBroker, 'open'>;
  // Tests only: the fetch the adapter posts with (the adapter still checks the host), or the guard's options (a local server, a name that resolves).
  send?: MinutesFetch;
  egress?: Partial<EgressOptions>;
}

export type ChatResult = 'sent' | 'retry' | 'failed' | 'ambiguous' | 'dropped' | 'skipped';

// One attempt for one post. Throws, so the queue retries, only when the attempt failed in a way that is safe to try again and tries remain; every other outcome is recorded as final and returned.
export async function runMeetingChat(deps: ChatDeps, job: ChatJob, attempt: { retryCount: number; retryLimit: number }): Promise<ChatResult> {
  const ctx = { actor: ACTOR, orgId: job.orgId };
  const post = await deps.runtime.query<ChatDeliveryRow | null>('meetings.chat.delivery', { id: job.id }, ctx);
  // A post that is gone or already settled (a second job for it, a replay) is not sent again.
  if (!post || post.status !== 'queued') return 'skipped';
  const drop = async (code: string): Promise<ChatResult> => {
    await deps.runtime.execute('meetings.chat.record', { id: job.id, outcome: 'dropped', httpStatus: null, code }, ctx);
    return 'dropped';
  };
  const body = zChatBody.safeParse(post.body);
  // A message that is gone or no longer fits (the database deletes it when the published text changes): nothing is sent.
  if (!body.success) return drop('POST_DROPPED');
  const target = await deps.runtime.query<ChatTarget | null>('meetings.chat.target', { channelId: post.channelId }, ctx);
  // The channel was removed, the member who saved it left or was demoted, or the org was stopped: nothing is sent, and the message is deleted.
  if (!target) return drop('CHANNEL_NOT_STANDING');
  let address: string | null = null;
  try {
    address = deps.broker.open({ keyId: target.keyId, envelope: Buffer.from(target.envelope, 'base64') }, { orgId: job.orgId, provider: MEETING_CHAT_PROVIDER, externalAccountId: post.channelId });
  } catch (error) {
    // A key that no longer opens (a rotated or lost credential key): nothing went out. Said by code, never with the cause's text, never with the address.
    console.warn(`[meeting-chat] ${job.id.slice(0, 8)} not posted`, codeOf(error));
  }
  let result: MinutesPostResult;
  if (address === null) {
    result = { state: 'failed', httpStatus: null, code: 'CHANNEL_ADDRESS_UNREADABLE', retryAfterSeconds: null };
  } else {
    // The attempt is made durable BEFORE the request leaves: the database lets one job begin, once. A job that finds an attempt already begun (a second job, a replay, a retry after a lost
    // answer) does nothing; a post whose attempt never concluded is settled ambiguous by the sweep, never sent again. A throw here sends nothing, so the queue's retry is safe.
    const begun = await deps.runtime.execute<{ recorded: boolean }>('meetings.chat.record', { id: job.id, outcome: 'begin', httpStatus: null, code: null }, ctx);
    if (!begun.recorded) return 'skipped';
    result = await attemptPost(deps, post.kind, address, body.data, job.orgId);
  }
  return conclude(deps, job, ctx, result, attempt);
}

async function attemptPost(deps: ChatDeps, kind: ChatDeliveryRow['kind'], address: string, data: ChatBody, orgId: string): Promise<MinutesPostResult> {
  try {
    const { link, ...message } = data;
    const send: MinutesFetch =
      deps.send ?? egressFetch({ timeoutMs: ATTEMPT_MS, maxBytes: MAX_ANSWER, overLimit: 'truncate', httpsOnly: true, userAgent: 'Ludy-Minutes/1', hostAllowed: (host) => minutesHostAllowed(kind, host), ...deps.egress });
    return await postMinutes(kind, address, message, link, send);
  } catch (error) {
    // The adapter answers every outcome itself; a throw it did not expect might have come after the request left, so it is ambiguous, never retried.
    console.warn(`[meeting-chat] ${orgId.slice(0, 8)} unexpected`, codeOf(error));
    return { state: 'ambiguous', httpStatus: null, code: 'CHANNEL_NO_ANSWER', retryAfterSeconds: null };
  }
}

type RecordCtx = { actor: typeof ACTOR; orgId: string };

// Records the outcome of an attempt that began. The record is retried in place (a request may already be out, so the queue must not run the attempt again); one that still fails is left to the
// sweep, which settles a post whose attempt never concluded as ambiguous.
async function conclude(deps: ChatDeps, job: ChatJob, ctx: RecordCtx, result: MinutesPostResult, attempt: { retryCount: number; retryLimit: number }): Promise<ChatResult> {
  const again = result.state === 'failed' && result.code !== null && RETRYABLE.has(result.code) && attempt.retryCount < attempt.retryLimit;
  const outcome = result.state === 'sent' ? 'sent' : result.state === 'ambiguous' ? 'ambiguous' : again ? 'retry' : 'failed';
  const recorded = await recordInPlace(deps, ctx, { id: job.id, outcome, httpStatus: result.httpStatus, code: outcome === 'sent' ? null : result.code });
  if (outcome === 'retry' && recorded) throw new Error(`minutes post ${job.id.slice(0, 8)} not posted (attempt ${attempt.retryCount + 1})`);
  return outcome === 'retry' ? 'failed' : outcome;
}

async function recordInPlace(deps: ChatDeps, ctx: RecordCtx, input: { id: string; outcome: string; httpStatus: number | null; code: string | null }): Promise<boolean> {
  for (let tries = 1; tries <= 3; tries += 1) {
    try {
      await deps.runtime.execute('meetings.chat.record', input, ctx);
      return true;
    } catch (error) {
      console.warn(`[meeting-chat] ${input.id.slice(0, 8)} outcome not recorded (try ${tries})`, codeOf(error));
    }
  }
  return false;
}
