// SPDX-License-Identifier: AGPL-3.0-only
// The sweep of the minutes posted to Slack and Teams (meetings integrations B4, issue #3168), every minute in the worker. It reaches no URL: it reads the posts waiting in the database and hands them to
// the queue (meeting-chat-job.ts sends them), through commands of the system actor.
//   A post stored at the click and never handed over, or handed over but never taken up for three minutes, goes to the queue ('send'); one still waiting after eight hours, longer than the retries
//   last, is failed ('expire'); one whose attempt began and never concluded for three minutes is settled ambiguous ('lost'). So a post is stored once and tried at least once, and never sent again once it may have gone.
// A failure for one post never stops the others, and a failure of the queue leaves the post stored, to be handed over again.
import { sql } from 'kysely';
import type { Db } from '@crove/db';
import { DomainError, type Runtime } from '@crove/kernel-runtime';
import type { ChatJob } from './meeting-chat-job.ts';

export const MEETING_CHAT_SWEEP_CRON = '* * * * *';
export const MEETING_CHAT_SWEEP_EXPIRE_SECONDS = 120;
// Posts one pass handles at most; the rest wait for the next minute.
const PER_PASS = 200;

const ACTOR = { type: 'system' as const, component: 'meetings.chat' };
const codeOf = (error: unknown) => (error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');

export interface ChatSweepDeps {
  runtime: Runtime;
  workerDb: Db;
  // Hands one post to the kernel-meeting-chat queue (a singleton job per post).
  send: (job: ChatJob) => Promise<unknown>;
}

// One pass. Returns what it did, for the log and the tests.
export async function runMeetingChatSweep(deps: ChatSweepDeps): Promise<{ handedOver: number; expired: number; lost: number; failures: number }> {
  const done = { handedOver: 0, expired: 0, lost: 0, failures: 0 };
  const open = await sql<{ org_id: string; id: string; kind: 'send' | 'expire' | 'lost' }>`SELECT org_id, id, kind FROM crove_meetings.chat_open(${PER_PASS}::int)`.execute(deps.workerDb);
  for (const row of open.rows) {
    const ctx = { actor: ACTOR, orgId: row.org_id };
    try {
      if (row.kind === 'lost') {
        // An attempt began and never concluded (the worker died, or the outcome could not be recorded): the request may be in the channel, so it is settled ambiguous and never sent again.
        await deps.runtime.execute('meetings.chat.record', { id: row.id, outcome: 'ambiguous', httpStatus: null, code: 'CHANNEL_NO_ANSWER' }, ctx);
        done.lost += 1;
      } else if (row.kind === 'expire') {
        await deps.runtime.execute('meetings.chat.record', { id: row.id, outcome: 'expired', httpStatus: null, code: null }, ctx);
        done.expired += 1;
      } else {
        await deps.send({ orgId: row.org_id, id: row.id });
        await deps.runtime.execute('meetings.chat.queued', { id: row.id }, ctx);
        done.handedOver += 1;
      }
    } catch (error) {
      done.failures += 1;
      console.warn(`[meeting-chat-sweep] post ${row.id.slice(0, 8)}`, codeOf(error));
    }
  }
  return done;
}
