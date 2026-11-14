// SPDX-License-Identifier: AGPL-3.0-only
// The built-in implementation of Vy's memory port (ADR-0049 decision 9, issue #2783): a deployment on `docker compose up` has no outside
// service, so memory is the member's own rows of crove_kernel.member_vy_memory, read and written only through the member's own commands, in the
// member's own user context. Asking about anyone else is refused before a command is run, and the database would refuse it anyway (the
// restrictive policy shows a member their own rows only). Knowledge has no declared queries yet: a feature that asks gets no passages.
import { AiBudgetExhaustedError, SUMMARY_TIMEOUT_MS, SummaryModelError, TranslationModelError, aiCost, generateMeetingSummaryText, generateMeetingTranslationText, withAiScope, type AiConfig, type AiMeter } from '@crove/agent';
import { SummaryError, TranslationError, bindPorts, noKnowledge, privateText, revealPrivateText, enhanceNotes, summarizeMeeting, translateSummary, translateTranscriptChunk, planTranscriptChunks, chunkExpectedUsage, lineHash, type MemberRef, type MemoryEntry, type MemoryPort, type ModelPort, type Ports } from '@crove/agent/member-vy';
import { zTranscriptTranslationResult, templateSections, type LiveNotesDone, type LiveNotesInput, type MeetingSummaryTemplate, type Summarized, type Transcript, type TranscriptSource, type TranscriptStarted, type TranscriptTranslated, type TranscriptTranslationStatus, type Translated, type TranslationSource, type TranslationStatus } from '@crove/kernel-contract';
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

export function runMeetingSummary(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<Summarized> {
  return runRecorderVy(deps, orgId, actor, meetingId, 'summary');
}

// "Viết lại đầy đủ" (Meetings A5, #3163): the same run as the summary, in the same family, with the same feature key, meter, budget line, checks of the recorder and the switch, and private
// result, over the recorder's own rough notes and the transcript. The notes are read as the recorder before anything is spent (none: NOTES_EMPTY); the answer's checks are the agent's
// (the recorder's own lines verbatim, every added line on a real second of the transcript). The recorder then reads the result (meetings.notes.preview) and copies it into their draft
// with meetings.summary.copy_result, as for a summary.
export function runNotesEnhance(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<Summarized> {
  return runRecorderVy(deps, orgId, actor, meetingId, 'notes');
}

async function runRecorderVy(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string, kind: 'summary' | 'notes'): Promise<Summarized> {
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
  // The notes are the recorder's own, read as the recorder: an empty box is refused here, before a ticket is taken or a run made.
  let notes = '';
  if (kind === 'notes') {
    notes = (await deps.runtime.query<{ body: string }>('meetings.notes.get', { meetingId }, as)).body;
    if (notes.trim() === '') throw new DomainError('NOTES_EMPTY', 422, 'Write some notes first');
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
      const meeting = await deps.runtime.query<{ language: 'vi' | 'en'; summaryTemplate: MeetingSummaryTemplate }>('meetings.meeting.get', { meetingId }, as);
      // The minutes template the recorder picked (A4, #3162): the same run fills its sections; the templates are code, the model only writes the text.
      const template = { code: meeting.summaryTemplate, sections: templateSections(meeting.summaryTemplate) };
      const segments = transcript.segments.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, speakerLabel: s.speakerLabel, text: s.text }));
      // 3. The one call, outside any transaction, in the scope of this run.
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, ports);
      const result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () =>
          kind === 'notes' ? enhanceNotes({ segments, language: meeting.language, template, notes }, bound) : summarizeMeeting({ segments, language: meeting.language, template }, bound),
        ),
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

// The button and the progress of the transcript translation (E2, #3185): the module's status plus the cost expected for the lines still to translate (their size, priced; one call a
// chunk, each with the fixed instruction around it). The text itself is not read here. With no model in the deployment the button says why (as when the module's own switch is off).
export async function transcriptTranslationStatusOf(
  deps: Pick<MeetingTranslationDeps, 'runtime' | 'price'> & { hasModel: boolean },
  orgId: string,
  actor: UserActor,
  meetingId: string,
): Promise<TranscriptTranslationStatus> {
  const { bytes, ...status } = await deps.runtime.query<TranscriptTranslationStatus & { bytes: number }>('meetings.translation.transcript_status', { meetingId }, { actor, orgId });
  if (!deps.hasModel && status.enabled) return { ...status, enabled: false, reason: 'off', estimate: null };
  if (!status.enabled || status.remaining === 0) return status;
  const calls = Math.max(1, status.chunksTotal - status.chunksDone);
  // The same figure a chunk is admitted on before its call, for as many chunks as are left (each is a call of its own, with the fixed instruction around it).
  const perChunk = chunkExpectedUsage(Math.ceil(bytes / calls));
  const inputTokens = perChunk.inputTokens * calls;
  const outputTokens = perChunk.outputTokens * calls;
  const priced = deps.price !== undefined && (Number(deps.price.inputPerMTok) > 0 || Number(deps.price.outputPerMTok) > 0);
  return { ...status, estimate: { calls, inputTokens, outputTokens, cost: priced ? aiCost([{ inputTokens, outputTokens }], deps.price) : null } };
}

// The member's Vy translating the next batch of the transcript they read, in the member's own request (E2, #3185, ADR-0049 stage A: the same interactive shape as the summary, a few
// chunks at a time, and the page asks again while it is open):
//   1. meetings.translation.transcript_start, as the member: the deployment's switch, a transcript they read with lines left, one run at a time; then the kernel's run.start (vy.use, the
//      kill switches, the budget) makes the member's Vy and this run. Nothing is read or sent before it succeeds;
//   2. meetings.translation.transcript_source: the text of the batch's lines in the member's own context (a sensitive read, audited), so only what the member reads;
//   3. the chunk (a request takes one) to the model, outside any transaction, through the member's own meter under meetings.translate, which admits it on its projected cost before the call (a chunk that would
//      reach a hard-stop budget is refused before the call, and the parts earlier requests kept stay); the answer is checked line by line in code (packages/agent member-vy/meeting-translation.ts);
//   4. the checked parts stored with kernel.member_vy.result.store in the member's own session, then meetings.translation.copy_result, the member's own command, merges them into their
//      private row (tainted, named after the run), held to the lines and their text as they are now.
// Neither the text nor the answer is ever logged: a failure is named by a fixed code. A translation creates no task, mail, post, webhook, search hit or export.
export type TranscriptTranslationDeps = MeetingTranslationDeps;

export async function runTranscriptTranslation(deps: TranscriptTranslationDeps, orgId: string, actor: UserActor, meetingId: string): Promise<TranscriptTranslated> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
  // A member who cannot translate this (the switch is off, no transcript they read) is refused with the precise answer before a ticket is taken (so a member cannot use up the org's few
  // requests a minute by asking about meetings they do not read).
  const allowed = await deps.runtime.query<TranscriptTranslationStatus & { bytes: number }>('meetings.translation.transcript_status', { meetingId }, as);
  if (!allowed.enabled) {
    if (allowed.reason === 'nothing') throw new DomainError('TRANSLATION_NOTHING', 422, 'There is no transcript to translate');
    throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('SUMMARY_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // 1. The checks come first. A refusal here has made no run.
    const started = await deps.runtime.execute<TranscriptStarted>('meetings.translation.transcript_start', { meetingId }, as);
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<TranscriptTranslated> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-translate-transcript] failed result not stored: ${codeOf(storeError)}`);
      }
      console.error(`[meetings-translate-transcript] run failed: ${errorCode}`);
      return { meetingId, runId, state: 'failed', errorCode, translated: 0, remaining: started.remaining };
    };
    const parts: Array<{ k: string; h: string; t: string; s: 'ok' | 'warn' | 'refused'; c: Array<'MISSING' | 'EMPTY' | 'TOO_LONG' | 'UNCHANGED' | 'INVENTED_NUMBER' | 'CONTACT_ADDED' | 'NUMBER_DROPPED' | 'NAME_ADDED'> }> = [];
    try {
      // 2. The text the member reads, in their own context.
      const source = await deps.runtime.query<TranscriptSource>('meetings.translation.transcript_source', { meetingId, lineIds: started.lineIds }, as);
      if (source.lines.length === 0) return await fail('TRANSLATION_STALE');
      // 3. Each chunk behind the meter, in the scope of this run; a refused or failed chunk after the first keeps the ones finished.
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, ports);
      for (const lines of planTranscriptChunks(source.lines)) {
        try {
          const done = await withDeadline(
            withAiScope({ orgId, memberRunId: runId, meter }, () => translateTranscriptChunk({ lines, from: started.from, to: started.to }, bound)),
            timeoutMs,
          );
          parts.push(...done.parts);
        } catch (error: unknown) {
          // An answer that cannot be used at all (not the JSON asked for, no line that survived the checks, a line too long) is final for these lines, as a line the checks refused is: they are
          // kept as lines that could not be translated, so one odd line cannot hold the rest of the transcript back by being asked again for ever. A failure of the call itself (a timeout,
          // the provider, the budget) keeps nothing and is retried by the next click.
          if (error instanceof TranslationError) {
            parts.push(...lines.map((l) => ({ k: l.id, h: lineHash(l.text), t: '', s: 'refused' as const, c: ['EMPTY' as const] })));
            break;
          }
          if (parts.length === 0) throw error;
          console.log(`[meetings-translate-transcript] stopped after ${parts.length} lines: ${codeOf(error)}`);
          break;
        }
      }
    } catch (error: unknown) {
      // Any failure before a part exists is named by a fixed code and stored as the run's failed result (a refusal of a read included: the run must not stay open).
      return await fail(error instanceof SummaryModelError ? 'TRANSLATE_TIMEOUT' : codeOf(error));
    }
    // 4. Stored in the member's own Vy result, bound to this run. The kernel re-checks the switches and the budget here and may keep the text out: its answer is the state.
    const body = JSON.stringify({ v: 1, kind: 'transcript', from: started.from, to: started.to, stage: started.stage, parts });
    zTranscriptTranslationResult.parse(JSON.parse(body));
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body } }, as);
    } catch (error: unknown) {
      // The member stopped the run while the model worked: the batch is lost, nothing else.
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return { meetingId, runId, state: 'failed', errorCode: 'RUN_CANCELLED', translated: 0, remaining: started.remaining };
      return await fail(codeOf(error));
    }
    if (stored.status === 'failed') {
      console.error('[meetings-translate-transcript] run failed: AI_STOPPED');
      return { meetingId, runId, state: 'failed', errorCode: 'AI_STOPPED', translated: 0, remaining: started.remaining };
    }
    // The member's own copy into their private row: held to the lines as they are now, tainted. A line corrected meanwhile is a stale part, said in fixed words.
    let kept = 0;
    try {
      kept = (await deps.runtime.execute<{ segments: number }>('meetings.translation.copy_result', { meetingId, runId }, as)).segments;
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'TRANSLATION_STALE') return { meetingId, runId, state: 'failed', errorCode: 'TRANSLATION_STALE', translated: 0, remaining: started.remaining };
      throw error;
    }
    const after = await deps.runtime.query<TranscriptTranslationStatus & { bytes: number }>('meetings.translation.transcript_status', { meetingId }, as);
    return { meetingId, runId, state: 'ready', errorCode: null, translated: kept, remaining: after.remaining };
  } finally {
    ticket.release();
  }
}
