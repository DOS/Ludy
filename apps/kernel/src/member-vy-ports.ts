// SPDX-License-Identifier: AGPL-3.0-only
// The built-in implementation of Vy's memory port (ADR-0049 decision 9, issue #2783): a deployment on `docker compose up` has no outside
// service, so memory is the member's own rows of crove_kernel.member_vy_memory, read and written only through the member's own commands, in the
// member's own user context. Asking about anyone else is refused before a command is run, and the database would refuse it anyway (the
// restrictive policy shows a member their own rows only). Knowledge has no declared queries yet: a feature that asks gets no passages.
import { AiBudgetExhaustedError, SUMMARY_TIMEOUT_MS, SummaryModelError, generateMeetingSummaryText, withAiScope, type AiConfig, type AiMeter } from '@crove/agent';
import { SummaryError, bindPorts, noKnowledge, privateText, revealPrivateText, summarizeMeeting, type MemberRef, type MemoryEntry, type MemoryPort, type ModelPort, type Ports } from '@crove/agent/member-vy';
import type { Summarized, Transcript } from '@crove/kernel-contract';
import { DomainError, type Runtime, type UserActor } from '@crove/kernel-runtime';
import type { DraftBudget } from './ai-draft-limit.ts';

// The only file of the API that imports the member-Vy entry of the agent package (member-vy-import-allowlist.test.ts): the rest of the kernel gets what it needs from here.
export type { ModelPort } from '@crove/agent/member-vy';

export function builtInMemory(runtime: Runtime, actor: UserActor, orgId: string): MemoryPort {
  const mine = (who: MemberRef) => {
    if (who.orgId !== orgId || who.memberUserId !== actor.userId) throw new Error('built-in memory answers only about the member it was made for');
  };
  return {
    async read(who) {
      mine(who);
      const { entries } = await runtime.query<{ entries: Array<{ id: string; body: string }> }>('kernel.member_vy.memory.list', {}, { actor, orgId });
      return entries.map((e): MemoryEntry => ({ id: e.id, text: privateText(e.body) }));
    },
    async write(who, text) {
      mine(who);
      return runtime.execute<{ id: string }>('kernel.member_vy.memory.save', { body: text }, { actor, orgId });
    },
    async forget(target) {
      // A source has nothing in the member's own memory (entries are typed by the member, never derived from a note or a meeting).
      if (!('member' in target)) return;
      mine(target.member);
      const { entries } = await runtime.query<{ entries: Array<{ id: string }> }>('kernel.member_vy.memory.list', {}, { actor, orgId });
      for (const entry of entries) await runtime.execute('kernel.member_vy.memory.delete', { id: entry.id }, { actor, orgId });
    },
  };
}

// The recorder's Vy summarizing a meeting, on the API side (#2580, M6 part B2, ADR-0049 stage A, the first interactive caller of the member-Vy kernel pieces). The member waits
// for it, so it is one short request:
//   1. meetings.summary.start, as the recorder: the recorder only, the deployment's switch, a transcript to read; then the kernel's run.start (vy.use, the kill switches, the budget)
//      makes the member's Vy and the run, whose subject is bound to this meeting. Nothing is read or sent before it succeeds.
//   2. the transcript, through the recorder's own read (meetings.transcript.get: the normal user-context query, no new door, audited like any read of it);
//   3. the one model call, outside any transaction, through the member's own meter (the scope carries the run), with a hard timeout and a cap on the transcript (a longer one is
//      refused before any call, never cut). The model has no tools and no schema; its answer is text that the checks in code (packages/agent member-vy/meeting-summary.ts) parse and prune;
//   4. the checked body, or a fixed error code, stored with kernel.member_vy.result.store in the recorder's own session: the row is sealed to the member, nothing is shared.
// Neither the transcript nor the answer is ever logged: a failure is named by a fixed code. The recorder then copies the result into their draft with their own click
// (meetings.summary.copy_result), reads it, and shares it.
export interface MeetingSummaryDeps {
  runtime: Runtime;
  // The deployment's model (AI_BASE_URL and friends) behind the member-Vy model port, or null when there is none: the summary is then off.
  model: ModelPort | null;
  // The meter that asks the database in this member's own authority (AI budget, kill switches, per-member caps).
  meter: (actor: UserActor) => AiMeter | null;
  // The per-member and per-org rate of AI drafts, shared with the other coworkers.
  budget: DraftBudget;
  timeoutMs?: number;
}

// The built-in model port for the summary: the deployment's OpenAI-compatible endpoint, through the member's own meter (the call is metered inside it).
export function summaryModelPort(config: AiConfig, timeoutMs: number = SUMMARY_TIMEOUT_MS): ModelPort {
  return { generate: (_who, prompt) => generateMeetingSummaryText(config, prompt, timeoutMs) };
}

const nothingToRemember: Ports['memory'] = { read: async () => [], write: async () => ({ id: 'none' }), forget: async () => undefined };

function codeOf(error: unknown): string {
  if (error instanceof AiBudgetExhaustedError) return 'AI_BUDGET_EXHAUSTED';
  if (error instanceof SummaryError) return error.code;
  if (error instanceof SummaryModelError) return error.kind === 'timeout' ? 'SUMMARY_TIMEOUT' : 'SUMMARY_FAILED';
  return 'SUMMARY_FAILED';
}

// A hard wall clock over the whole work, whatever the model port does: the member never waits longer.
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SummaryModelError('timeout')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export async function runMeetingSummary(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<Summarized> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('SUMMARY_OFF', 422, 'Summaries by Vy are not turned on here; type the summary by hand');
  // Only the recorder with the switch on spends the member's and the org's rate: anyone else is refused here with the precise answer, before a ticket is taken
  // (so a member cannot use up the org's few summaries a minute by asking about meetings they did not record).
  const allowed = await deps.runtime.query<{ enabled: boolean; reason: 'off' | 'not_recorder' | null }>('meetings.summary.status', { meetingId }, as);
  if (!allowed.enabled) {
    // The refusal is the status's own answer: no command runs, so a refused member can never leave a run behind.
    if (allowed.reason === 'not_recorder') throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy to summarize it');
    throw new DomainError('SUMMARY_OFF', 422, 'Summaries by Vy are not turned on here; type the summary by hand');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('SUMMARY_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // 1. The checks come first: the recorder, the switch, a transcript, vy.use, the kill switches and the budget. A refusal here has made no run.
    const started = await deps.runtime.execute<{ meetingId: string; runId: string }>('meetings.summary.start', { meetingId }, as);
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<Summarized> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-summary] failed result not stored: ${codeOf(storeError)}`);
      }
      console.error(`[meetings-summary] run failed: ${errorCode}`);
      return { meetingId, runId, state: 'failed', errorCode };
    };
    let body: string;
    try {
      // 2. The recorder's own read of the transcript, and of the meeting's language.
      const transcript = await deps.runtime.query<Transcript>('meetings.transcript.get', { meetingId }, as);
      const meeting = await deps.runtime.query<{ language: 'vi' | 'en' }>('meetings.meeting.get', { meetingId }, as);
      const segments = transcript.segments.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, speakerLabel: s.speakerLabel, text: s.text }));
      // 3. The one call, outside any transaction, in the scope of this run.
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () => summarizeMeeting({ segments, language: meeting.language }, bindPorts({ orgId, memberUserId: actor.userId }, ports))),
        timeoutMs,
      );
      body = revealPrivateText(result.body);
    } catch (error: unknown) {
      // Any failure before the answer is named by a fixed code and stored as the run's failed result (a refusal of a read included: the run must not stay open).
      return await fail(codeOf(error));
    }
    // 4. Stored in the recorder's own Vy result, bound to this run. The kernel re-checks the switches and the budget here and may keep the text out: its answer is the state.
    // A run that is no longer live is the caller's to see (VY_RUN_NOT_LIVE); another refusal of the store is named and stored like any failure.
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body } }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') throw error;
      return await fail(codeOf(error));
    }
    if (stored.status === 'failed') {
      console.error('[meetings-summary] run failed: AI_STOPPED');
      return { meetingId, runId, state: 'failed', errorCode: 'AI_STOPPED' };
    }
    return { meetingId, runId, state: 'ready', errorCode: null };
  } finally {
    ticket.release();
  }
}

