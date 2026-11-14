// SPDX-License-Identifier: AGPL-3.0-only
// The built-in implementation of Vy's memory port (ADR-0049 decision 9, issue #2783): a deployment on `docker compose up` has no outside
// service, so memory is the member's own rows of crove_kernel.member_vy_memory, read and written only through the member's own commands, in the
// member's own user context. Asking about anyone else is refused before a command is run, and the database would refuse it anyway (the
// restrictive policy shows a member their own rows only). Knowledge has no declared queries yet: a feature that asks gets no passages.
import { AiBudgetExhaustedError, SUMMARY_TIMEOUT_MS, SummaryModelError, TranslationModelError, aiCost, generateMeetingSummaryText, generateMeetingTranslationText, withAiScope, type AiCall, type AiConfig, type AiMeter, type AiUsage } from '@crove/agent';
import { SummaryError, TranslationError, bindPorts, noKnowledge, planTranscriptChunks, privateText, revealPrivateText, summarizeMeeting, translateSummary, translateTranscriptChunk, type MemberRef, type MemoryEntry, type MemoryPort, type ModelPort, type Ports } from '@crove/agent/member-vy';
import { zTranscriptTranslationResult, type LiveNotesDone, type LiveNotesInput, type Summarized, type Transcript, type TranscriptTranslationStatus, type Translated, type TranslationSource, type TranslationStatus } from '@crove/kernel-contract';
import { DomainError, memberVyRuntime, type MemberVyRuntime, type Runtime, type SystemActor, type UserActor } from '@crove/kernel-runtime';
import type { DraftBudget } from './ai-draft-limit.ts';
import { failureCode } from './meetings-transcribe.ts';
import type { MeetingsTranslateJob } from './meetings-translate-job.ts';

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
  // A prompt names its own meter key when it is not the summary's: a translation counts under meetings.translate (#3184) and so never cuts off a summary, a transcription or live notes.
  return { generate: (_who, prompt) => (prompt.feature === 'meetings.translate' ? generateMeetingTranslationText(config, prompt, timeoutMs) : generateMeetingSummaryText(config, prompt, timeoutMs)) };
}

const nothingToRemember: Ports['memory'] = { read: async () => [], write: async () => ({ id: 'none' }), forget: async () => undefined };

function codeOf(error: unknown): string {
  if (error instanceof AiBudgetExhaustedError) return 'AI_BUDGET_EXHAUSTED';
  if (error instanceof SummaryError) return error.code;
  if (error instanceof SummaryModelError) return error.kind === 'timeout' ? 'SUMMARY_TIMEOUT' : 'SUMMARY_FAILED';
  if (error instanceof TranslationError) return error.code;
  if (error instanceof TranslationModelError) return error.kind === 'timeout' ? 'TRANSLATE_TIMEOUT' : 'TRANSLATE_FAILED';
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


// The running notes of a meeting being recorded (#3110, L4a-2, ADR-0052): the same stage A shape as the summary above, over the NEW preview lines and the previous notes only,
// so the model call does not grow with the meeting. As the recorder, in their own session:
//   1. meetings.live.notes_start: the checks (the recorder, the opt-in, the deployment's switch), nothing new to read means no run and no spend, then the kernel's run.start
//      (vy.use, the kill switches, the budget) for the feature meetings.live_summary;
//   2. meetings.live.notes_input: the previous notes and the lines written since, read as the recorder;
//   3. the one model call, outside any transaction, in the scope of this run, with the checks of plan section 5.3 in code: the previous notes go in as the first lines of
//      the text it may quote, so a figure they hold passes and a figure nothing holds is removed;
//   4. kernel.member_vy.result.store, then meetings.live.notes_copy, the recorder's own command, copies the checked notes into the live draft (tainted, "Đề xuất").
// Neither the lines nor the answer are logged: a failure is named by a fixed code. A spent budget or a kill switch comes back as the failed state with its code, and the
// recording is not touched.
export async function runLiveNotes(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<LiveNotesDone> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('SUMMARY_OFF', 422, 'Notes by Vy are not turned on here');
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('SUMMARY_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    const started = await deps.runtime.execute<{ meetingId: string; runId: string | null }>('meetings.live.notes_start', { meetingId }, as);
    const runId = started.runId;
    // Nothing new since the notes were last made: nothing was started and nothing is spent.
    if (runId === null) return { meetingId, state: 'nothing', runId: null, errorCode: null, decisions: 0, items: 0 };
    const fail = async (errorCode: string): Promise<LiveNotesDone> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        console.error(`[meetings-live-notes] failed result not stored: ${codeOf(storeError)}`);
      }
      console.error(`[meetings-live-notes] notes run failed: ${errorCode}`);
      return { meetingId, state: 'failed', runId, errorCode, decisions: 0, items: 0 };
    };
    let body: string;
    try {
      const input = await deps.runtime.query<LiveNotesInput>('meetings.live.notes_input', { meetingId }, as);
      const previous = input.previous;
      const earlier = previous ? [previous.summary, ...previous.decisions, ...previous.items].filter((t) => t.trim() !== '').join(' ') : '';
      const reach = input.lines.reduce((n, l) => Math.max(n, l.endSeconds), 0);
      // The previous notes are the first "line" the model may quote and the checks may match a figure against; the new lines follow.
      const segments = [
        ...(earlier === '' ? [] : [{ startSeconds: 0, endSeconds: reach, speakerLabel: 'Ghi chú trước', text: earlier }]),
        ...input.lines.map((l) => ({ startSeconds: l.startSeconds, endSeconds: l.endSeconds, speakerLabel: 'Người nói', text: l.text })),
      ];
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () => summarizeMeeting({ segments, language: input.language }, bindPorts({ orgId, memberUserId: actor.userId }, ports))),
        timeoutMs,
      );
      body = revealPrivateText(result.body);
    } catch (error: unknown) {
      return await fail(codeOf(error));
    }
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body } }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') throw error;
      return await fail(codeOf(error));
    }
    if (stored.status === 'failed') {
      console.error('[meetings-live-notes] notes run failed: AI_STOPPED');
      return { meetingId, state: 'failed', runId, errorCode: 'AI_STOPPED', decisions: 0, items: 0 };
    }
    // The recorder's own copy into the live draft: the checked notes, tainted, the model's words for the recorder to read.
    return await deps.runtime.execute<LiveNotesDone>('meetings.live.notes_copy', { meetingId, runId }, as);
  } finally {
    ticket.release();
  }
}


// The member's Vy translating the summary they read (meetings integrations E1, #3184, ADR-0049 stage A): the same interactive shape as the summary above, for any member who reads
// the stage (the recorder for their draft), and the answer stays theirs alone. The member waits for it, so it is one short request:
//   1. meetings.translate.start, as the member: the deployment's switch, a stage they read with text to translate; then the kernel's run.start (vy.use, the kill switches, the budget)
//      makes the member's Vy and the run, whose subject is bound to this meeting. Nothing is read or sent before it succeeds;
//   2. meetings.translation.source: the text the member reads, in their own context (a sensitive read, audited), with the hash that names it;
//   3. the one model call, outside any transaction, through the member's own meter under meetings.translate (the scope carries the run), with a hard timeout; a text over its cap is refused
//      before any call, never cut. The model has no tools: the checks in code (packages/agent member-vy/meeting-translation.ts) decide per segment what shows;
//   4. the checked body, or a fixed error code, stored with kernel.member_vy.result.store in the member's own session, then meetings.translation.copy_result, the member's own command,
//      keeps it in their private translation row (tainted, named after the run), held to the same hash.
// Neither the text nor the answer is ever logged: a failure is named by a fixed code. A translation creates no task, mail, post, webhook, search hit or export.
export interface MeetingTranslationDeps extends MeetingSummaryDeps {
  // The deployment's prices (AI_PRICE_*), for the cost shown before the click; unset or zero prices show no figure.
  price?: { inputPerMTok: string; outputPerMTok: string } | undefined;
}

// What a translation is expected to use, before the click: the text sent (UTF-8 bytes over a rough 2.5 per token, Vietnamese text weighs more than English) plus the fixed instruction, and
// an answer about as long as the text (the JSON around it adds a little). An estimate, not a promise: the meter records what the provider reports.
export function translationEstimate(bytes: number, price: MeetingTranslationDeps['price']): NonNullable<TranslationStatus['estimate']> {
  const inputTokens = Math.ceil(bytes / 2.5) + 250;
  const outputTokens = Math.ceil(bytes / 2.5) + 50;
  const priced = price !== undefined && (Number(price.inputPerMTok) > 0 || Number(price.outputPerMTok) > 0);
  return { inputTokens, outputTokens, cost: priced ? aiCost([{ inputTokens, outputTokens }], price) : null };
}

// The button of a stage: the module's status (switch, text to translate, language pair, the size of the text) plus the expected cost. The text itself is not read here: the module says its size.
export async function translationStatusOf(deps: Pick<MeetingTranslationDeps, 'runtime' | 'price'>, orgId: string, actor: UserActor, meetingId: string, stage: 'draft' | 'published'): Promise<TranslationStatus> {
  const { bytes, ...status } = await deps.runtime.query<TranslationStatus & { bytes: number }>('meetings.translation.status', { meetingId, stage }, { actor, orgId });
  return status.enabled ? { ...status, estimate: translationEstimate(bytes, deps.price) } : status;
}

// The button and the progress of the transcript translation: the module's status plus the cost expected for the lines still to translate (their size, priced; one call a chunk, each with the
// fixed instruction around it). The text itself is not read here. With no model in the deployment the button says why (the same as the module's own switch being off).
export async function transcriptTranslationStatusOf(
  deps: Pick<MeetingTranslationDeps, 'runtime' | 'price'> & { hasModel: boolean },
  orgId: string,
  actor: UserActor,
  meetingId: string,
): Promise<TranscriptTranslationStatus> {
  const { bytes, ...status } = await deps.runtime.query<TranscriptTranslationStatus & { bytes: number }>('meetings.translation.transcript_status', { meetingId }, { actor, orgId });
  if (!deps.hasModel && status.enabled) return { ...status, enabled: false, reason: 'off', estimate: null };
  if (!status.enabled || status.remaining === 0) return status;
  const calls = status.chunksTotal - status.chunksDone;
  const estimate = translationEstimate(bytes, deps.price);
  // translationEstimate counts one instruction for the whole text; each chunk is a call of its own, so the fixed part is paid once a call.
  const inputTokens = estimate.inputTokens + 300 * Math.max(0, calls - 1);
  const outputTokens = estimate.outputTokens + 50 * Math.max(0, calls - 1);
  const priced = deps.price !== undefined && (Number(deps.price.inputPerMTok) > 0 || Number(deps.price.outputPerMTok) > 0);
  return { ...status, estimate: { calls, inputTokens, outputTokens, cost: priced ? aiCost([{ inputTokens, outputTokens }], deps.price) : null } };
}

export async function runMeetingTranslation(deps: MeetingTranslationDeps, orgId: string, actor: UserActor, meetingId: string, stage: 'draft' | 'published'): Promise<Translated> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
  // A member who cannot translate this (the switch is off, no text, a stage they do not read) is refused here with the precise answer, before a ticket is taken (so a member cannot use up the org's
  // few translations a minute by asking about meetings they do not read).
  const allowed = await deps.runtime.query<TranslationStatus>('meetings.translation.status', { meetingId, stage }, as);
  if (!allowed.enabled) {
    if (allowed.reason === 'nothing') throw new DomainError('TRANSLATION_NOTHING', 422, 'There is no summary to translate');
    throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('SUMMARY_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // 1. The checks come first: the switch, a stage the member reads, vy.use, the kill switches and the budget. A refusal here has made no run.
    const started = await deps.runtime.execute<{ meetingId: string; runId: string }>('meetings.translate.start', { meetingId, stage }, as);
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<Translated> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-translate] failed result not stored: ${codeOf(storeError)}`);
      }
      console.error(`[meetings-translate] run failed: ${errorCode}`);
      return { meetingId, stage, runId, state: 'failed', errorCode };
    };
    let body: string;
    try {
      // 2. The text the member reads, in their own context.
      const source = await deps.runtime.query<TranslationSource>('meetings.translation.source', { meetingId, stage }, as);
      // 3. The one call, outside any transaction, in the scope of this run.
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () =>
          translateSummary({ segments: source.segments, from: source.from, to: source.to, stage: source.stage, hash: source.hash }, bindPorts({ orgId, memberUserId: actor.userId }, ports)),
        ),
        timeoutMs,
      );
      body = revealPrivateText(result.body);
    } catch (error: unknown) {
      // Any failure before the answer is named by a fixed code and stored as the run's failed result (a refusal of a read included: the run must not stay open).
      return await fail(error instanceof SummaryModelError ? 'TRANSLATE_TIMEOUT' : codeOf(error));
    }
    // 4. Stored in the member's own Vy result, bound to this run. The kernel re-checks the switches and the budget here and may keep the text out: its answer is the state.
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body } }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') throw error;
      return await fail(codeOf(error));
    }
    if (stored.status === 'failed') {
      console.error('[meetings-translate] run failed: AI_STOPPED');
      return { meetingId, stage, runId, state: 'failed', errorCode: 'AI_STOPPED' };
    }
    // The member's own copy into their private translation row: held to the text they read now, tainted. A summary that changed meanwhile is a stale answer, said in fixed words.
    try {
      await deps.runtime.execute('meetings.translation.copy_result', { meetingId, runId }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'TRANSLATION_STALE') return { meetingId, stage, runId, state: 'failed', errorCode: 'TRANSLATION_STALE' };
      throw error;
    }
    return { meetingId, stage, runId, state: 'ready', errorCode: null };
  } finally {
    ticket.release();
  }
}


// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The member's Vy translating the transcript, the worker's side (meetings integrations E2, #3185, ADR-0049 stage B). One job per run the member started, a batch of lines:
//   1. the run is the member's member-scoped agent context (memberVyRuntime): each call below enters it afresh, so the member being active, vy.use, the org, module and agent kill
//      switches, the global `ai` switch, a spent hard-stop budget and the run being live are re-checked at every step (a member removed mid-run ends it at the next call);
//   2. kernel.member_vy.meeting_audio.open, in its text mode, answers the lines of the stage the member reads (the database function behind it is the gate), and it is called again
//      before EACH chunk, so a meeting deleted or a member who stopped reading it ends the run before the next chunk is sent;
//   3. each chunk goes to the model behind the meter, whose admit enters the member's context again with the call's projected cost: a chunk that would reach a hard-stop budget is
//      refused before the call, and the run keeps the chunks it finished; the answer is checked line by line in code (packages/agent member-vy/meeting-translation.ts);
//   4. kernel.member_vy.result.store writes the checked parts as the run's own result, the only thing a member-scoped context writes; 5. kernel.member_vy.run.finish closes the run.
// The job writes no meeting table: the member's own copy (meetings.translation.copy_result) keeps the parts in their private row. A failed run stores a fixed code, never a message, and
// logs carry ids and codes. A job is never retried by the queue: another try would send the text again; the member starts it again if they want to.
export interface MeetingsTranslateDeps {
  runtime: Runtime;
  // The deployment's model behind the member-Vy model port (the same as the summary's).
  model: ModelPort;
  // The deployment's prices (AI_PRICE_*), for the projected cost of a chunk.
  price: { inputPerMTok: string; outputPerMTok: string };
  timeoutMs?: number;
}

const TRANSLATE_SYSTEM: SystemActor = { type: 'system', component: 'meetings.translate' };
// One result row holds at most this many characters (member_vy_result.body, a database check): a run that has more keeps what fits and the next run goes on.
const TRANSLATE_RESULT_MAX = 100_000;

// The meter of one run: admission enters the member's context again (it refuses on a switch or a spent budget, and on the projected cost of the chunk about to be sent); the record is the
// system's row for the run's agent (ids, the feature, tokens and the cost; never text).
class TranslateMeter implements AiMeter {
  private readonly deps: MeetingsTranslateDeps;
  private readonly vy: MemberVyRuntime;
  private readonly job: MeetingsTranslateJob;

  constructor(deps: MeetingsTranslateDeps, vy: MemberVyRuntime, job: MeetingsTranslateJob) {
    this.deps = deps;
    this.vy = vy;
    this.job = job;
  }

  async admit(call: AiCall): Promise<void> {
    const projected = call.expected ? aiCost([call.expected], this.deps.price) : '0';
    try {
      await this.vy.query('kernel.member_vy.run.check', /^0+(?:\.0+)?$/.test(projected) ? {} : { projectedCost: projected });
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'BUDGET_EXHAUSTED') throw new AiBudgetExhaustedError('module', null);
      throw error;
    }
  }

  async record(call: AiCall, usage: AiUsage): Promise<void> {
    await this.deps.runtime.execute(
      'kernel.ai.usage.record',
      { feature: call.feature, module: call.module, agentId: this.job.agentId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: aiCost([usage], this.deps.price) },
      { actor: TRANSLATE_SYSTEM, orgId: this.job.orgId },
    );
  }
}

// The fixed word a failure is stored under: a word of the kernel's list (the database checks the same one), never the error's text. The list has no word of its own for a translation, so a
// failure of the model or of its answer takes the nearest existing word and the screen of a translation reads it as a translation's (a new word is a change of the database's list).
function translateFailureCode(error: unknown): ReturnType<typeof failureCode> {
  if (error instanceof TranslationModelError) return error.kind === 'timeout' ? 'TRANSCRIBE_TIMEOUT' : 'TRANSCRIBE_FAILED';
  if (error instanceof TranslationError) return 'TRANSCRIBE_INVALID_RESPONSE';
  return failureCode(error);
}

interface TextLines {
  language: string;
  lines: Array<{ id: string; text: string }>;
}

// One run, start to end. Returns the state it left the run in; never throws for a failed run (the failure is stored), only for a lost database.
export async function runMeetingsTranslate(deps: MeetingsTranslateDeps, job: MeetingsTranslateJob): Promise<'succeeded' | 'failed'> {
  const vy = memberVyRuntime(deps.runtime, job.orgId, { agentId: job.agentId, runId: job.runId });
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  let code: string | null = null;
  try {
    const open = () => vy.execute<TextLines>('kernel.member_vy.meeting_audio.open', { meetingId: job.meetingId, text: { stage: job.stage } });
    const first = await open();
    const from: 'vi' | 'en' = first.language === 'en' ? 'en' : 'vi';
    const to: 'vi' | 'en' = from === 'vi' ? 'en' : 'vi';
    // The lines this run was asked for, in the order of the transcript, cut into chunks by the rule the estimate before the click uses.
    const wanted = new Set(job.lineIds);
    const chunks = planTranscriptChunks(first.lines.filter((l) => wanted.has(l.id)));
    if (chunks.length === 0) throw new DomainError('TRANSCRIPT_EMPTY', 422, 'There is nothing left to translate');
    const scope = { orgId: job.orgId, agentId: job.agentId, memberRunId: job.runId, meter: new TranslateMeter(deps, vy, job) };
    const ports: Ports = { model: deps.model, memory: nothingToRemember, knowledge: noKnowledge };
    const bound = bindPorts({ orgId: job.orgId, memberUserId: job.memberUserId }, ports);
    const parts: Array<{ k: string; h: string; t: string; s: 'ok' | 'warn' | 'refused'; c: Array<'MISSING' | 'EMPTY' | 'TOO_LONG' | 'UNCHANGED' | 'INVENTED_NUMBER' | 'CONTACT_ADDED' | 'NUMBER_DROPPED' | 'NAME_ADDED'> }> = [];
    for (const [index, chunk] of chunks.entries()) {
      // The door again for every chunk: the whole gate is re-checked, and the text is the text as it is now (a line corrected meanwhile is translated as corrected, or gone).
      const fresh = index === 0 ? first : await open();
      const byId = new Map(fresh.lines.map((l) => [l.id, l.text]));
      const lines = chunk.flatMap((l) => (byId.has(l.id) ? [{ id: l.id, text: byId.get(l.id) as string }] : []));
      if (lines.length === 0) continue;
      try {
        const done = await withDeadline(
          withAiScope(scope, () => translateTranscriptChunk({ lines, from, to }, bound)),
          timeoutMs,
        );
        parts.push(...done.parts);
      } catch (error: unknown) {
        // A refused chunk (a hard-stop budget the next call would reach) or a failed one stops the run; the chunks finished before it are kept, and with none there is nothing to keep.
        if (parts.length === 0) throw error;
        console.log(`[meetings-translate] org ${job.orgId.slice(0, 8)} run ${job.runId.slice(0, 8)} stopped after ${parts.length} lines: ${translateFailureCode(error)}`);
        break;
      }
    }
    // What fits one result row: the parts in order up to its limit; the rest is for the next run (the parts kept are never asked for twice).
    let body = '';
    while (parts.length > 0) {
      body = JSON.stringify({ v: 1, kind: 'transcript', from, to, stage: job.stage, parts });
      if (body.length <= TRANSLATE_RESULT_MAX) break;
      parts.pop();
    }
    if (parts.length === 0) throw new DomainError('TRANSCRIPT_TOO_LONG', 422, 'A part is longer than a result holds');
    // What is stored is exactly what the member's copy accepts: a result that would fail the copy fails the run here, with a fixed code.
    zTranscriptTranslationResult.parse(JSON.parse(body));
    const stored = await vy.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId: job.runId, outcome: { status: 'ready', body } });
    // A kill switch or a spent budget that appeared since the last admit makes the store keep a failed result, not the text: the run is failed too.
    if (!stored.stored) code = 'AI_STOPPED';
  } catch (error: unknown) {
    code = translateFailureCode(error);
    // Best effort: when the context itself is refused (the member left, a switch is on) there is nothing to write and the finish below fails the result.
    await vy.execute('kernel.member_vy.result.store', { runId: job.runId, outcome: { status: 'failed', errorCode: code } }).catch(() => undefined);
  }
  await deps.runtime.execute('kernel.member_vy.run.finish', { runId: job.runId, errorCode: code }, { actor: TRANSLATE_SYSTEM, orgId: job.orgId }).catch((error: unknown) => {
    console.error(`[meetings-translate] org ${job.orgId.slice(0, 8)} could not close run ${job.runId.slice(0, 8)}`, error instanceof DomainError ? error.code : error instanceof Error ? error.name : 'error');
  });
  console.log(`[meetings-translate] org ${job.orgId.slice(0, 8)} run ${job.runId.slice(0, 8)} ${code === null ? 'succeeded' : `failed ${code}`}`);
  return code === null ? 'succeeded' : 'failed';
}
