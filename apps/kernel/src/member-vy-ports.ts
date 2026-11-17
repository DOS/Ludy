// SPDX-License-Identifier: AGPL-3.0-only
// The built-in implementation of Vy's memory port (ADR-0049 decision 9, issue #2783): a deployment on `docker compose up` has no outside
// service, so memory is the member's own rows of crove_kernel.member_vy_memory, read and written only through the member's own commands, in the
// member's own user context. Asking about anyone else is refused before a command is run, and the database would refuse it anyway (the
// restrictive policy shows a member their own rows only). Knowledge has no declared queries yet: a feature that asks gets no passages.
import { z } from 'zod';
import { ASK_TIMEOUT_MS, AiBudgetExhaustedError, AiMeterMissingError, AskModelError, BRIEF_TIMEOUT_MS, BriefModelError, generateMeetingBriefText, SUMMARY_TIMEOUT_MS, SummaryModelError, TASKS_FROM_NOTE_TIMEOUT_MS, TasksFromNoteModelError, TranslationModelError, aiCost, generateMeetingAskText, generateMeetingSummaryText, generateMeetingTranslationText, generateNoteSummaryText, generateTasksFromNoteText, generateTasksFromSourceText, generateTodoSuggestText, withAiScope, type AiConfig, type AiMeter } from '@crove/agent';
import { NOTE_AI_LIMITS, NOTE_AI_TIMEOUT_MS, TASKS_FROM_NOTE_LIMITS, AskError, BriefError, writeBrief, NoteAiError, NoteAiModelError, SummaryError, TasksFromNoteError, TasksFromSourceError, TranslationError, askAcrossMeetings, bindPorts, noKnowledge, privateText, proposeTasksFromNote, proposeTasksFromSource, revealPrivateText, enhanceNotes, suggestTodosFromNote, summarizeMeeting, summarizeNote, translateSummary, translateTranscriptChunk, planTranscriptChunks, chunkExpectedUsage, lineHash, type MemberRef, type MemoryEntry, type MemoryPort, type ModelPort, type Ports, type TaskSourceKind } from '@crove/agent/member-vy';
import { ASK_ESTIMATE, ASK_HITS_MAX, BRIEF_ESTIMATE, briefLines, type BriefAnswer, type BriefFacts, type BriefStatus, type BriefTarget, DEFAULT_TIME_ZONE, zNoteTodoSuggestion, zTranscriptTranslationResult, zonedDate, templateSections, type AskAnswer, type AskLines, type AskStatus, type LiveNotesDone, type LiveNotesInput, type MeetingSummaryTemplate, type Note, type NoteSuggestTodosInput, type NoteSuggestTodosResult, type NoteSummarizeInput, type NoteSummarizeResult, type NoteVyResults, type NoteVyStatus, type ProjectSeat, type ProjectTaskSourceType, type ProjectTasksFromNoteInput, type ProjectTasksFromNoteResult, type ProjectTasksFromNoteStatus, type ProjectTasksFromSourceInput, type ProjectTasksFromSourceResult, type ProjectTasksFromSourceStatus, type Summarized, type Transcript, type TranscriptSource, type TranscriptStarted, type TranscriptTranslated, type TranscriptTranslationStatus, type Translated, type TranslationSource, type TranslationStatus } from '@crove/kernel-contract';
import { readTasksFromSourceData, type SourceQueryFn } from '@crove/mod-projects';
import { Decimal } from '@crove/l10n-vn';
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

const NOTE_AI_MAX_SYSTEM_CHARS = 16_000;
// Worst-case JSON.stringify expansion (\uXXXX 6x on 40_000 note chars) plus title and subject envelope.
const NOTE_AI_MAX_PROMPT_CHARS = NOTE_AI_LIMITS.maxNoteChars * 6 + 4_000;

async function invokeNoteAiModel(
  prompt: { readonly system: string; readonly user: string },
  call: (safePrompt: { system: string; user: string }, abortSignal: AbortSignal) => Promise<{
    text: string;
    usage: { inputTokens?: number | undefined; outputTokens?: number | undefined };
  }>,
  timeoutMs: number,
): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
  if (
    prompt === null ||
    typeof prompt !== 'object' ||
    Array.isArray(prompt) ||
    typeof prompt.system !== 'string' ||
    prompt.system.length === 0 ||
    prompt.system.length > NOTE_AI_MAX_SYSTEM_CHARS ||
    typeof prompt.user !== 'string' ||
    prompt.user.length === 0 ||
    prompt.user.length > NOTE_AI_MAX_PROMPT_CHARS ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new NoteAiModelError('failed');
  }
  const safePrompt = { system: prompt.system, user: prompt.user };
  const signal = AbortSignal.timeout(Math.min(timeoutMs, NOTE_AI_TIMEOUT_MS));
  try {
    const result = await call(safePrompt, signal);
    return {
      text: result.text,
      usage: { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 },
    };
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError || error instanceof AiMeterMissingError) throw error;
    console.error('[note-ai-model] model call failed', error instanceof Error ? error.name : typeof error);
    const isTimeout =
      (error instanceof DOMException && error.name === 'TimeoutError') ||
      (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'));
    throw new NoteAiModelError(isTimeout ? 'timeout' : 'failed');
  }
}

// The built-in model port for the summary: the deployment's OpenAI-compatible endpoint, through the member's own meter (the call is metered inside it).
export function summaryModelPort(config: AiConfig, timeoutMs: number = SUMMARY_TIMEOUT_MS): ModelPort {
  // A prompt names its own meter key when it is not the summary's: a translation counts under meetings.translate (#3184) and so never cuts off a summary, a transcription or live notes.
  // A question about meetings counts under meetings.ask (#3161) for the same reason.
  return {
    generate: (_who, prompt) =>
      prompt.feature === 'meetings.brief'
        ? generateMeetingBriefText(config, prompt, Math.min(timeoutMs, BRIEF_TIMEOUT_MS))
        : prompt.feature === 'meetings.translate'
        ? generateMeetingTranslationText(config, prompt, timeoutMs)
        : prompt.feature === 'meetings.ask'
          ? generateMeetingAskText(config, prompt, Math.min(timeoutMs, ASK_TIMEOUT_MS))
          : prompt.feature === 'projects.tasks_from_note'
            ? generateTasksFromNoteText(config, prompt, Math.min(timeoutMs, TASKS_FROM_NOTE_TIMEOUT_MS))
            : prompt.feature === 'projects.tasks_from_source'
              ? generateTasksFromSourceText(config, prompt, Math.min(timeoutMs, TASKS_FROM_NOTE_TIMEOUT_MS))
              : prompt.feature === 'notes.summary'
                ? invokeNoteAiModel(prompt, (safePrompt, signal) => generateNoteSummaryText(config, safePrompt, signal), timeoutMs)
                : prompt.feature === 'notes.todo_suggest'
                  ? invokeNoteAiModel(prompt, (safePrompt, signal) => generateTodoSuggestText(config, safePrompt, signal), timeoutMs)
                  : generateMeetingSummaryText(config, prompt, timeoutMs),
  };
}

const nothingToRemember: Ports['memory'] = { read: async () => [], write: async () => ({ id: 'none' }), forget: async () => undefined };

function codeOf(error: unknown): string {
  if (error instanceof AiBudgetExhaustedError) return 'AI_BUDGET_EXHAUSTED';
  if (error instanceof SummaryError) return error.code;
  if (error instanceof SummaryModelError) return error.kind === 'timeout' ? 'SUMMARY_TIMEOUT' : 'SUMMARY_FAILED';
  if (error instanceof TranslationError) return error.code;
  if (error instanceof TranslationModelError) return error.kind === 'timeout' ? 'TRANSLATE_TIMEOUT' : 'TRANSLATE_FAILED';
  if (error instanceof AskError) return error.code;
  if (error instanceof AskModelError) return error.kind === 'timeout' ? 'ASK_TIMEOUT' : 'ASK_FAILED';
  if (error instanceof TasksFromNoteError) return error.code;
  if (error instanceof TasksFromSourceError) return error.code;
  if (error instanceof TasksFromNoteModelError) return error.kind === 'timeout' ? 'PROPOSAL_TIMEOUT' : 'PROPOSAL_FAILED';
  if (error instanceof NoteAiError) return error.code;
  if (error instanceof NoteAiModelError) return error.kind === 'timeout' ? 'NOTE_AI_TIMEOUT' : 'NOTE_AI_FAILED';
  return 'SUMMARY_FAILED';
}

// The fixed code of a failure of a question: the codes of the question's own checks, and a general one (never the summary's) for anything unexpected.
function askCodeOf(error: unknown): string {
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' ? 'ASK_FAILED' : code;
}

function briefCodeOf(error: unknown): string {
  if (error instanceof BriefError) return error.code;
  if (error instanceof BriefModelError) return error.kind === 'timeout' ? 'BRIEF_TIMEOUT' : 'BRIEF_FAILED';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'BRIEF_FAILED' : code;
}

function tasksFromNoteCodeOf(error: unknown): string {
  if (error instanceof DomainError) return error.code;
  if (error instanceof SummaryModelError && error.kind === 'timeout') return 'PROPOSAL_TIMEOUT';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' ? 'PROPOSAL_FAILED' : code;
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
      // The people of the meeting, by display name, as the recorder reads them: the summary may suggest which of them a speaker is (#3502). Only the summary asks; the notes run does not.
      const attendees = kind === 'summary' ? (await deps.runtime.query<{ names: string[] }>('meetings.summary.attendees', { meetingId }, as)).names : [];
      // 3. The one call, outside any transaction, in the scope of this run.
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, ports);
      const result = await withDeadline(
        // Both kinds answer one checked body (as private text); the rest of each result is not used here.
        withAiScope({ orgId, memberRunId: runId, meter }, async () => ({
          body: (kind === 'notes' ? await enhanceNotes({ segments, language: meeting.language, template, notes }, bound) : await summarizeMeeting({ segments, language: meeting.language, template, attendees }, bound)).body,
        })),
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
  const priced = price !== undefined && (isPositivePrice(price.inputPerMTok) || isPositivePrice(price.outputPerMTok));
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


// The member's Vy answering a question across the meetings they read (Meetings A3, #3161, ADR-0049 stage A). The member waits for it, so it is one short request, in the member's own session and context:
//   1. meetings.ask.status, as the member: the deployment's switch, the right to work with Vy, a kill switch, a spent budget; a refusal here has made no run and spent nothing;
//   2. meetings.ask.lines: the lines the member's own search finds (at most 40 from at most 8 meetings, row security on every one), a sensitive read whose audit row hashes the question. No line: the
//      answer is "none" with no run and no model call, so a question about nothing costs nothing;
//   3. meetings.ask.start, then the kernel's run.start (vy.use, the kill switches, the budget) makes the member's Vy and the run;
//   4. the one model call, outside any transaction, through the member's own meter under meetings.ask (the scope carries the run), with a hard timeout. The model has no tools: the checks in code
//      (packages/agent member-vy/meeting-ask.ts) decide per sentence what shows;
//   5. the run's result row is stored with COUNTS ONLY (lines, sentences, sources, dropped), never the question or the answer, with kernel.member_vy.result.store in the member's own session.
// The answer goes back to the browser and nowhere else: no result row holds it, no task, mail, post, webhook, search hit or export is made from it. Neither the question, the lines nor the answer is
// ever logged: a failure is named by a fixed code.
export interface MeetingAskDeps extends MeetingSummaryDeps {
  // The deployment's prices (AI_PRICE_*), for the cost shown before the question; unset or zero prices show no figure.
  price?: { inputPerMTok: string; outputPerMTok: string } | undefined;
}

// What one question is expected to use, before the click: a fixed figure (the lines are not read until the member asks). An estimate, not a promise.
export function askEstimate(price: MeetingAskDeps['price']): NonNullable<AskStatus['estimate']> {
  const priced = price !== undefined && (isPositivePrice(price.inputPerMTok) || isPositivePrice(price.outputPerMTok));
  return { ...ASK_ESTIMATE, cost: priced ? aiCost([ASK_ESTIMATE], price) : null };
}

// The box: the module's status plus the expected cost; "off" when the deployment has no model or no meter for this member.
export async function askStatusOf(deps: Pick<MeetingAskDeps, 'runtime' | 'price' | 'model' | 'meter'>, orgId: string, actor: UserActor): Promise<AskStatus> {
  if (!deps.model || !deps.meter(actor)) return { enabled: false, reason: 'off', estimate: null };
  const status = await deps.runtime.query<AskStatus>('meetings.ask.status', {}, { actor, orgId });
  return status.enabled ? { ...status, estimate: askEstimate(deps.price) } : status;
}

export async function runMeetingAsk(deps: MeetingAskDeps, orgId: string, actor: UserActor, question: string): Promise<AskAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('ASK_OFF', 422, 'Asking Vy about meetings is not turned on here');
  // 1. The box's answer first, so a member who may not ask is refused with the precise reason, before a ticket is taken or a line is read.
  const status = await deps.runtime.query<AskStatus>('meetings.ask.status', {}, as);
  if (!status.enabled) {
    if (status.reason === 'off') throw new DomainError('ASK_OFF', 422, 'Asking Vy about meetings is not turned on here');
    if (status.reason === 'forbidden') throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    throw new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Vy đang tạm dừng hoặc đã hết ngân sách tháng này; sổ sách và mọi việc không cần AI vẫn chạy bình thường');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('ASK_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // 2. The lines the member's own search finds.
    const { lines } = await deps.runtime.query<AskLines>('meetings.ask.lines', { question }, as);
    if (lines.length === 0) return { state: 'none', errorCode: null, sentences: [], sources: [], hits: [], dropped: 0 };
    const hits = lines.slice(0, ASK_HITS_MAX);
    // 3. The checks come first: the switch, vy.use, the kill switches (the member's own Vy's included) and the budget. A refusal here has made no run, and the member still has the lines their
    //    search found: the answer is the plain hit list with the fixed code.
    let started: { runId: string };
    try {
      started = await deps.runtime.execute<{ runId: string }>('meetings.ask.start', {}, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'ASK_BUSY' : error.code;
        console.error(`[meetings-ask] run not started: ${errorCode}`);
        return { state: 'failed', errorCode, sentences: [], sources: [], hits, dropped: 0 };
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<AskAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-ask] failed result not stored: ${askCodeOf(storeError)}`);
      }
      console.error(`[meetings-ask] run failed: ${errorCode}`);
      return { state: 'failed', errorCode, sentences: [], sources: [], hits, dropped: 0 };
    };
    // 4. The one call, outside any transaction, in the scope of this run.
    let checked: Awaited<ReturnType<typeof askAcrossMeetings>>['answer'];
    try {
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const input = { question, lines: lines.map((l) => ({ meetingTitle: l.meetingTitle, heldAt: l.heldAt, startSeconds: l.startSeconds, speakerLabel: l.speakerLabel, text: l.text })) };
      const result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () => askAcrossMeetings(input, bindPorts({ orgId, memberUserId: actor.userId }, ports))),
        timeoutMs,
      );
      checked = result.answer;
    } catch (error: unknown) {
      // Any failure before the answer is named by a fixed code and stored as the run's failed result: the run must not stay open.
      return await fail(error instanceof SummaryModelError ? 'ASK_TIMEOUT' : askCodeOf(error));
    }
    // The sentences name the lines they cite by their place among the sources, in the order they are first cited.
    const order: number[] = [];
    const sentences = checked.sentences.map((s) => ({
      text: s.text,
      sources: s.cites.map((n) => {
        let place = order.indexOf(n);
        if (place < 0) {
          order.push(n);
          place = order.length - 1;
        }
        return place;
      }),
    }));
    const sources = order.map((n) => lines[n - 1]).filter((l): l is AskLines['lines'][number] => l !== undefined);
    // 5. Counts only: never the question, a line or a sentence.
    const body = JSON.stringify({ v: 1, lines: lines.length, sentences: sentences.length, sources: sources.length, dropped: checked.dropped });
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body } }, as);
    } catch (error: unknown) {
      // The run ended while the model was answering (the member cancelled it, a switch stopped it): the text is not shown, and the member keeps the plain list.
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return { state: 'failed', errorCode: 'AI_STOPPED', sentences: [], sources: [], hits, dropped: 0 };
      return await fail(askCodeOf(error));
    }
    // The kernel re-checked the switches and the budget at the store and may have stopped the run: its answer is the state, and nothing of the model's text is shown for a stopped run.
    if (stored.status === 'failed') {
      console.error('[meetings-ask] run failed: AI_STOPPED');
      return { state: 'failed', errorCode: 'AI_STOPPED', sentences: [], sources: [], hits, dropped: 0 };
    }
    if (sentences.length === 0) return { state: 'none', errorCode: null, sentences: [], sources: [], hits, dropped: checked.dropped };
    return { state: 'answered', errorCode: null, sentences, sources, hits: [], dropped: checked.dropped };
  } finally {
    ticket.release();
  }
}

// The member's Vy writing the two or three sentences of the brief before a meeting (#3543, ADR-0049 stage A). The facts do not need Vy and work with AI off (meetings.brief.facts); this is the click on top of
// them, in the member's own session and context, and nothing of it is stored:
//   1. meetings.brief.status, as the member: the deployment's switch, the right to work with Vy, a kill switch, a spent budget; a refusal here has made no run and spent nothing;
//   2. meetings.brief.facts: the decisions of the previous meeting (only if the member read it), the series' open items and the linked customer's open deals, all read as the member. No fact: the answer is
//      "none" with no run and no model call, so a meeting with nothing to say costs nothing;
//   3. meetings.brief.start, then the kernel's run.start (vy.use, the kill switches, the budget) makes the member's Vy and the run;
//   4. the one model call, outside any transaction, through the member's own meter under meetings.brief (the scope carries the run), with a hard timeout. The model has no tools: the checks in code
//      (packages/agent member-vy/meetings-brief.ts) decide per sentence what shows, and a sentence whose figure no cited fact writes is refused;
//   5. the run's result row is stored with COUNTS ONLY (facts, sentences, dropped), never a fact or a sentence, with kernel.member_vy.result.store in the member's own session.
// The answer goes back to the browser and nowhere else. Neither the facts nor the sentences are ever logged: a failure is named by a fixed code.
export interface MeetingBriefDeps extends MeetingSummaryDeps {
  // The deployment's prices (AI_PRICE_*), for the cost shown before the click; unset or zero prices show no figure.
  price?: { inputPerMTok: string; outputPerMTok: string } | undefined;
}

// What one brief is expected to use, before the click: a fixed figure (the facts are not read until the member asks). An estimate, not a promise.
export function briefEstimate(price: MeetingBriefDeps['price']): NonNullable<BriefStatus['estimate']> {
  const priced = price !== undefined && (isPositivePrice(price.inputPerMTok) || isPositivePrice(price.outputPerMTok));
  return { ...BRIEF_ESTIMATE, cost: priced ? aiCost([BRIEF_ESTIMATE], price) : null };
}

// The button: the module's status plus the expected cost; "off" when the deployment has no model or no meter for this member.
export async function briefStatusOf(deps: Pick<MeetingBriefDeps, 'runtime' | 'price' | 'model' | 'meter'>, orgId: string, actor: UserActor): Promise<BriefStatus> {
  if (!deps.model || !deps.meter(actor)) return { enabled: false, reason: 'off', estimate: null };
  const status = await deps.runtime.query<BriefStatus>('meetings.brief.status', {}, { actor, orgId });
  return status.enabled ? { ...status, estimate: briefEstimate(deps.price) } : status;
}

export async function runMeetingBrief(deps: MeetingBriefDeps, orgId: string, actor: UserActor, target: BriefTarget): Promise<BriefAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('BRIEF_OFF', 422, 'Vy writing a brief is not turned on here');
  const none = (): BriefAnswer => ({ state: 'none', errorCode: null, sentences: [], dropped: 0 });
  const failed = (errorCode: string): BriefAnswer => ({ state: 'failed', errorCode, sentences: [], dropped: 0 });
  // 1. The button's answer first, so a member who may not ask is refused with the precise reason, before a ticket is taken or a fact is read.
  const status = await deps.runtime.query<BriefStatus>('meetings.brief.status', {}, as);
  if (!status.enabled) {
    if (status.reason === 'off') throw new DomainError('BRIEF_OFF', 422, 'Vy writing a brief is not turned on here');
    if (status.reason === 'forbidden') throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    throw new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Vy đang tạm dừng hoặc đã hết ngân sách tháng này; sổ sách và mọi việc không cần AI vẫn chạy bình thường');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('BRIEF_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // 2. The facts, as the member reads them. Nothing to say: no run and no call.
    const facts = await deps.runtime.query<BriefFacts>('meetings.brief.facts', target, as);
    const lines = briefLines(facts);
    if (facts.empty || lines.length === 0) return none();
    // 3. The checks come first: the switch, vy.use, the kill switches (the member's own Vy's included) and the budget. A refusal here has made no run, and the member still has the facts list.
    let started: { runId: string };
    try {
      started = await deps.runtime.execute<{ runId: string }>('meetings.brief.start', {}, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'BRIEF_BUSY' : error.code;
        console.error(`[meetings-brief] run not started: ${errorCode}`);
        return failed(errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<BriefAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-brief] failed result not stored: ${briefCodeOf(storeError)}`);
      }
      console.error(`[meetings-brief] run failed: ${errorCode}`);
      return failed(errorCode);
    };
    // 4. The one call, outside any transaction, in the scope of this run.
    let checked: Awaited<ReturnType<typeof writeBrief>>['answer'];
    try {
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () => writeBrief({ facts: lines.map((l) => ({ kind: l.kind, text: l.text })) }, bindPorts({ orgId, memberUserId: actor.userId }, ports))),
        timeoutMs,
      );
      checked = result.answer;
    } catch (error: unknown) {
      // Any failure before the answer is named by a fixed code and stored as the run's failed result: the run must not stay open.
      return await fail(error instanceof SummaryModelError ? 'BRIEF_TIMEOUT' : briefCodeOf(error));
    }
    const sentences = checked.sentences.map((s) => ({ text: s.text, facts: s.cites }));
    // 5. Counts only: never a fact or a sentence.
    const body = JSON.stringify({ v: 1, facts: lines.length, sentences: sentences.length, dropped: checked.dropped });
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body } }, as);
    } catch (error: unknown) {
      // The run ended while the model was answering (the member cancelled it, a switch stopped it): the text is not shown, and the member keeps the facts list.
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return failed('AI_STOPPED');
      return await fail(briefCodeOf(error));
    }
    // The kernel re-checked the switches and the budget at the store and may have stopped the run: its answer is the state, and nothing of the model's text is shown for a stopped run.
    if (stored.status === 'failed') {
      console.error('[meetings-brief] run failed: AI_STOPPED');
      return failed('AI_STOPPED');
    }
    if (sentences.length === 0) return { state: 'none', errorCode: null, sentences: [], dropped: checked.dropped };
    return { state: 'written', errorCode: null, sentences, dropped: checked.dropped };
  } finally {
    ticket.release();
  }
}


// A price per million tokens is a decimal string: it is compared as one (the money rule), never through a JS number. A value that is not a decimal is no price.
function isPositivePrice(value: string): boolean {
  try {
    return new Decimal(value).gt(0);
  } catch {
    return false;
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
  const priced = deps.price !== undefined && (isPositivePrice(deps.price.inputPerMTok) || isPositivePrice(deps.price.outputPerMTok));
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

async function proposalStatusOf(
  deps: Pick<MeetingSummaryDeps, 'runtime' | 'model' | 'meter'>,
  queryName: string,
  orgId: string,
  actor: UserActor,
): Promise<ProjectTasksFromNoteStatus> {
  const status = await deps.runtime.query<ProjectTasksFromNoteStatus>(queryName, {}, { actor, orgId });
  if (status.available && (!deps.model || !deps.meter(actor))) {
    return { available: false, reason: 'off', resetOn: null };
  }
  return status;
}

export function tasksFromNoteStatusOf(
  deps: Pick<MeetingSummaryDeps, 'runtime' | 'model' | 'meter'>,
  orgId: string,
  actor: UserActor,
): Promise<ProjectTasksFromNoteStatus> {
  return proposalStatusOf(deps, 'projects.tasks_from_note.status', orgId, actor);
}

export function tasksFromSourceStatusOf(
  deps: Pick<MeetingSummaryDeps, 'runtime' | 'model' | 'meter'>,
  orgId: string,
  actor: UserActor,
): Promise<ProjectTasksFromSourceStatus> {
  return proposalStatusOf(deps, 'projects.tasks_from_source.status', orgId, actor);
}

async function assertProposalReady(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
  statusQuery: string,
) {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? TASKS_FROM_NOTE_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);

  const status = await deps.runtime.query<ProjectTasksFromNoteStatus>(statusQuery, {}, as);
  if (!model || !meter || !status.available) {
    if (!model || !meter || status.reason === 'off') {
      throw new DomainError('AI_OFF', 422, 'Tính năng Vy đề xuất việc chưa được bật');
    }
    if (status.reason === 'forbidden') {
      throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    }
    if (status.reason === 'paused') {
      throw new DomainError('AI_PAUSED', 422, 'Vy đang tạm dừng theo lệnh dừng AI; bạn vẫn tạo việc thủ công bình thường');
    }
    throw new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Ngân sách AI của dự án tháng này đã hết; bạn vẫn tạo việc thủ công bình thường');
  }

  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) {
    throw new DomainError('AI_BUSY', 429, 'Vy đang xử lý yêu cầu khác; vui lòng thử lại sau ít phút', {
      retryAfterSeconds: ticket.retryAfterSeconds,
    });
  }

  return { as, timeoutMs, model, meter, ticket };
}

type ProposalRunOutcome = {
  state: 'ready' | 'failed';
  runId: string;
  proposals: Awaited<ReturnType<typeof proposeTasksFromNote>>['proposals'];
  dropped: number;
  errorCode: string | null;
};

async function executeAndStoreProposalRun(params: {
  runtime: Runtime;
  as: { actor: UserActor; orgId: string };
  runId: string;
  timeoutMs: number;
  meter: AiMeter;
  logPrefix: string;
  auditMeta: Record<string, unknown>;
  sourceRevision: number;
  runModel: () => Promise<Awaited<ReturnType<typeof proposeTasksFromNote>>>;
  verifyBeforeReturn?: () => Promise<void>;
}): Promise<ProposalRunOutcome> {
  const fail = async (errorCode: string): Promise<ProposalRunOutcome> => {
    try {
      await params.runtime.execute(
        'kernel.member_vy.result.store',
        { runId: params.runId, outcome: { status: 'failed', errorCode } },
        params.as,
      );
    } catch (storeError: unknown) {
      console.error(`${params.logPrefix} failed result not stored: ${tasksFromNoteCodeOf(storeError)}`);
    }
    console.error(`${params.logPrefix} run failed: ${errorCode}`);
    return { state: 'failed', runId: params.runId, proposals: [], dropped: 0, errorCode };
  };

  let result: Awaited<ReturnType<typeof proposeTasksFromNote>>;
  try {
    result = await withDeadline(
      withAiScope({ orgId: params.as.orgId, memberRunId: params.runId, meter: params.meter }, params.runModel),
      params.timeoutMs,
    );
    // Re-verify caller access and source liveness before storing/returning any proposal in case the source was deleted or revoked mid-run.
    if (params.verifyBeforeReturn) {
      await params.verifyBeforeReturn();
    }
  } catch (error: unknown) {
    return await fail(tasksFromNoteCodeOf(error));
  }

  // Store counts and identifiers only (never source text or proposed titles) in member_vy_result.
  const body = JSON.stringify({
    v: 1,
    ...params.auditMeta,
    proposals: result.proposals.length,
    dropped: result.dropped,
  });
  let stored: { stored: boolean; status: 'ready' | 'failed' };
  try {
    stored = await params.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>(
      'kernel.member_vy.result.store',
      { runId: params.runId, outcome: { status: 'ready', body, sourceRevision: params.sourceRevision } },
      params.as,
    );
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') {
      return { state: 'failed', runId: params.runId, proposals: [], dropped: 0, errorCode: 'AI_STOPPED' };
    }
    return await fail(tasksFromNoteCodeOf(error));
  }

  if (stored.status === 'failed') {
    console.error(`${params.logPrefix} run failed: AI_STOPPED`);
    return { state: 'failed', runId: params.runId, proposals: [], dropped: 0, errorCode: 'AI_STOPPED' };
  }

  return { state: 'ready', runId: params.runId, proposals: result.proposals, dropped: result.dropped, errorCode: null };
}

function runtimeQueryFn(runtime: Runtime, as: { actor: UserActor; orgId: string }): SourceQueryFn {
  return async <T>(name: string, input: Record<string, unknown>) => {
    // Check deployment-level module registration (CROVE_MODULES) before Runtime.query to avoid QUERY_NOT_FOUND.
    if (name.startsWith('notes.') && !runtime.installed('notes')) return { status: 'not_installed' as const };
    if (name.startsWith('meetings.') && !runtime.installed('meetings')) return { status: 'not_installed' as const };
    try {
      return { status: 'ok' as const, value: await runtime.query<T>(name, input, as) };
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'MODULE_OFF') {
        return { status: 'not_installed' as const };
      }
      throw error;
    }
  };
}

function seatOptionsOf(seats: readonly ProjectSeat[]) {
  return seats.map((s) => ({
    positionId: s.id,
    positionTitle: s.title,
    holderName: s.holder?.type === 'user' ? (s.holder.displayName ?? s.holder.email) : null,
  }));
}

const SOURCE_KIND_MAP: Record<ProjectTaskSourceType, TaskSourceKind> = {
  'notes.note': 'note',
  'meetings.meeting': 'meeting',
  'kernel.conversation': 'conversation',
};

// Member-scoped Vy task proposal from a readable note into a writable project (#2598, ADR-0048, ADR-0049):
// checks status (vy.use, kill switches, budget), starts a run via projects.tasks_from_note.start, calls model once
// outside any transaction with nonce-tagged subject and allowed project-member seats only, stores sealed result in
// member_vy_result (private_read = true), and returns sanitized proposals to the asking member only.
export async function runProjectsTasksFromNote(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
  input: ProjectTasksFromNoteInput,
): Promise<ProjectTasksFromNoteResult> {
  const { as, timeoutMs, model, meter, ticket } = await assertProposalReady(
    deps,
    orgId,
    actor,
    'projects.tasks_from_note.status',
  );

  try {
    // Pre-read project seats and readable note before starting a run so missing/in-trash/oversized inputs fail cleanly
    // without stranding a 'running' ai_run or member_vy_result row.
    const seatInfo = await deps.runtime.query<{ projectId: string; projectName: string; seats: ProjectSeat[] }>(
      'projects.tasks_from_note.seats',
      { projectId: input.projectId },
      as,
    );
    const note = await deps.runtime.query<Note>('notes.note.get', { noteId: input.noteId }, as);
    if (note.deletedAt !== null) {
      throw new DomainError('NOTE_IN_TRASH', 409, 'Ghi chú đang ở thùng rác; hãy khôi phục trước');
    }
    if (`${note.title}\n${note.body}`.trim().length === 0) {
      throw new DomainError('NOTE_EMPTY', 422, 'Ghi chú chưa có nội dung để đề xuất việc');
    }
    const sourceBytes = Buffer.byteLength(note.title, 'utf8') + Buffer.byteLength(note.body, 'utf8');
    if (sourceBytes > TASKS_FROM_NOTE_LIMITS.sourceBytes) {
      return {
        state: 'failed',
        runId: null,
        projectId: input.projectId,
        projectName: seatInfo.projectName,
        seats: seatInfo.seats,
        proposals: [],
        dropped: 0,
        errorCode: 'NOTE_TOO_LONG',
        noteCanLink: note.mine && note.deletedAt === null,
      };
    }

    let started: { runId: string; noteRevision: number; noteCanLink: boolean };
    try {
      started = await deps.runtime.execute<{ runId: string; noteRevision: number; noteCanLink: boolean }>(
        'projects.tasks_from_note.start',
        { noteId: input.noteId, projectId: input.projectId },
        as,
      );
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'AI_BUSY' : error.code;
        console.error(`[projects-tasks-from-note] run not started: ${errorCode}`);
        return {
          state: 'failed',
          runId: null,
          projectId: input.projectId,
          projectName: seatInfo.projectName,
          seats: seatInfo.seats,
          proposals: [],
          dropped: 0,
          errorCode,
          noteCanLink: note.mine && note.deletedAt === null,
        };
      }
      throw error;
    }

    const today = input.today ?? zonedDate(input.timeZone ?? DEFAULT_TIME_ZONE, Date.now());
    const language = input.language ?? 'vi';
    const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };

    const outcome = await executeAndStoreProposalRun({
      runtime: deps.runtime,
      as,
      runId: started.runId,
      timeoutMs,
      meter,
      logPrefix: '[projects-tasks-from-note]',
      auditMeta: { projectId: input.projectId },
      sourceRevision: note.revision,
      runModel: () =>
        proposeTasksFromNote(
          {
            projectName: seatInfo.projectName,
            noteTitle: note.title,
            noteBody: note.body,
            today,
            language,
            seats: seatOptionsOf(seatInfo.seats),
          },
          bindPorts({ orgId, memberUserId: actor.userId }, ports),
        ),
      verifyBeforeReturn: async () => {
        await deps.runtime.query('projects.tasks_from_note.seats', { projectId: input.projectId }, as);
        const currentNote = await deps.runtime.query<Note>('notes.note.get', { noteId: input.noteId }, as);
        if (currentNote.deletedAt !== null) {
          throw new DomainError('NOTE_IN_TRASH', 409, 'Ghi chú đang ở thùng rác; hãy khôi phục trước');
        }
      },
    });

    return {
      ...outcome,
      projectId: input.projectId,
      projectName: seatInfo.projectName,
      seats: seatInfo.seats,
      noteCanLink: started.noteCanLink,
    };
  } finally {
    ticket.release();
  }
}

// Member-scoped Vy task proposal from a readable note, meeting, or conversation (#2608, ADR-0048, ADR-0049).
export async function runProjectsTasksFromSource(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
  input: ProjectTasksFromSourceInput,
): Promise<ProjectTasksFromSourceResult> {
  const { as, timeoutMs, model, meter, ticket } = await assertProposalReady(
    deps,
    orgId,
    actor,
    'projects.tasks_from_source.status',
  );

  try {
    const seatInfo = await deps.runtime.query<{ projectId: string; projectName: string; seats: ProjectSeat[] }>(
      'projects.tasks_from_source.seats',
      { projectId: input.projectId },
      as,
    );
    const source = await readTasksFromSourceData(runtimeQueryFn(deps.runtime, as), {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      includeContent: true,
    });

    const sourceBytes = Buffer.byteLength(source.sourceTitle, 'utf8') + Buffer.byteLength(source.sourceBody, 'utf8');
    if (sourceBytes > TASKS_FROM_NOTE_LIMITS.sourceBytes) {
      return {
        state: 'failed',
        runId: null,
        projectId: input.projectId,
        projectName: seatInfo.projectName,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceTitle: source.sourceTitle,
        seats: seatInfo.seats,
        proposals: [],
        dropped: 0,
        errorCode: 'SOURCE_TOO_LONG',
        sourceCanLink: source.sourceCanLink,
      };
    }

    let started: { runId: string; sourceRevision: number; sourceCanLink: boolean };
    try {
      started = await deps.runtime.execute<{ runId: string; sourceRevision: number; sourceCanLink: boolean }>(
        'projects.tasks_from_source.start',
        { projectId: input.projectId, sourceType: input.sourceType, sourceId: input.sourceId },
        as,
      );
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'AI_BUSY' : error.code;
        console.error(`[projects-tasks-from-source] run not started: ${errorCode}`);
        return {
          state: 'failed',
          runId: null,
          projectId: input.projectId,
          projectName: seatInfo.projectName,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          sourceTitle: source.sourceTitle,
          seats: seatInfo.seats,
          proposals: [],
          dropped: 0,
          errorCode,
          sourceCanLink: source.sourceCanLink,
        };
      }
      throw error;
    }

    const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
    const anchorMs = source.anchorAt ? Date.parse(source.anchorAt) : Number.NaN;
    const today = input.today ?? zonedDate(timeZone, Number.isNaN(anchorMs) ? Date.now() : anchorMs);
    const segments = source.segments.map((seg) => {
      if (input.today !== undefined) {
        return { text: seg.text, today: input.today };
      }
      const segMs = seg.anchorAt ? Date.parse(seg.anchorAt) : Number.NaN;
      return {
        text: seg.text,
        today: Number.isNaN(segMs) ? today : zonedDate(timeZone, segMs),
      };
    });
    const language = input.language ?? 'vi';
    const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };

    const outcome = await executeAndStoreProposalRun({
      runtime: deps.runtime,
      as,
      runId: started.runId,
      timeoutMs,
      meter,
      logPrefix: '[projects-tasks-from-source]',
      auditMeta: { projectId: input.projectId, sourceType: input.sourceType, sourceId: input.sourceId },
      sourceRevision: started.sourceRevision,
      runModel: () =>
        proposeTasksFromSource(
          {
            sourceKind: SOURCE_KIND_MAP[input.sourceType],
            projectName: seatInfo.projectName,
            sourceTitle: source.sourceTitle,
            sourceBody: source.sourceBody,
            today,
            segments,
            language,
            seats: seatOptionsOf(seatInfo.seats),
          },
          bindPorts({ orgId, memberUserId: actor.userId }, ports),
        ),
      verifyBeforeReturn: async () => {
        await deps.runtime.query('projects.tasks_from_source.seats', { projectId: input.projectId }, as);
        await readTasksFromSourceData(runtimeQueryFn(deps.runtime, as), {
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          includeContent: false,
        });
      },
    });

    return {
      ...outcome,
      projectId: input.projectId,
      projectName: seatInfo.projectName,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceTitle: source.sourceTitle,
      seats: seatInfo.seats,
      sourceCanLink: started.sourceCanLink,
    };
  } finally {
    ticket.release();
  }
}

const zStoredNoteSummary = z.object({
  summary: z.string(),
  bullets: z.array(z.string()),
  dropped: z.number().int(),
});

const zStoredTodoSuggest = z.object({
  suggestions: z.array(zNoteTodoSuggestion),
  dropped: z.number().int(),
});

function notesAiCodeOf(error: unknown): string {
  if (error instanceof SummaryModelError && error.kind === 'timeout') return 'NOTE_AI_TIMEOUT';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' ? 'NOTE_AI_FAILED' : code;
}

export async function notesVyStatusOf(
  deps: Pick<MeetingSummaryDeps, 'runtime' | 'model' | 'meter'>,
  orgId: string,
  actor: UserActor,
): Promise<NoteVyStatus> {
  const status = await deps.runtime.query<NoteVyStatus>('notes.vy.status', {}, { actor, orgId });
  if (status.available && (!deps.model || !deps.meter(actor))) {
    return { available: false, reason: 'off', resetOn: null };
  }
  return status;
}

async function preflightNotesVy(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
  noteId: string,
): Promise<{
  as: { actor: UserActor; orgId: string };
  model: ModelPort;
  meter: AiMeter;
  note: Note;
  release: () => void;
}> {
  const as = { actor, orgId };
  const model = deps.model;
  const meter = deps.meter(actor);
  const status = await notesVyStatusOf(deps, orgId, actor);
  if (!model || !meter || !status.available) {
    if (!model || !meter || status.reason === 'off') {
      throw new DomainError('AI_OFF', 422, 'Tính năng Vy hỗ trợ ghi chú chưa được bật');
    }
    if (status.reason === 'forbidden') {
      throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    }
    if (status.reason === 'paused') {
      throw new DomainError('AI_PAUSED', 422, 'Vy đang tạm dừng theo lệnh dừng AI; ghi chú và việc vẫn dùng bình thường');
    }
    throw new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Ngân sách AI của Ghi chú tháng này đã hết');
  }

  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) {
    throw new DomainError('AI_BUSY', 429, 'Vy đang xử lý yêu cầu khác; vui lòng thử lại sau ít phút', {
      retryAfterSeconds: ticket.retryAfterSeconds,
    });
  }

  try {
    const note = await deps.runtime.query<Note>('notes.note.get', { noteId }, as);
    if (note.deletedAt !== null) {
      throw new DomainError('NOTE_IN_TRASH', 409, 'Ghi chú đang ở thùng rác; hãy khôi phục trước');
    }
    const text = `${note.title}\n${note.body}`;
    if (text.trim().length === 0) {
      throw new DomainError('NOTE_EMPTY', 422, 'Ghi chú chưa có nội dung để Vy đọc');
    }
    if (text.length > NOTE_AI_LIMITS.maxNoteChars) {
      throw new DomainError('NOTE_TOO_LONG', 422, 'Ghi chú quá dài cho một lượt chạy của Vy');
    }
    return { as, model, meter, note, release: ticket.release };
  } catch (error) {
    ticket.release();
    throw error;
  }
}

async function verifyNoteReadableForRun(
  deps: Pick<MeetingSummaryDeps, 'runtime'>,
  as: { actor: UserActor; orgId: string },
  logPrefix: string,
  runId: string,
  noteId: string,
): Promise<void> {
  try {
    const current = await deps.runtime.query<Note>('notes.note.get', { noteId }, as);
    if (current.deletedAt !== null) {
      throw new DomainError('NOTE_IN_TRASH', 409, 'Ghi chú đang ở thùng rác; hãy khôi phục trước');
    }
  } catch (error: unknown) {
    const errorCode = error instanceof DomainError ? error.code : notesAiCodeOf(error);
    try {
      await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
    } catch (storeError: unknown) {
      console.error(`[${logPrefix}] failed result not stored: ${notesAiCodeOf(storeError)}`);
    }
    throw error;
  }
}

async function storeNotesVyReady(
  deps: Pick<MeetingSummaryDeps, 'runtime'>,
  as: { actor: UserActor; orgId: string },
  logPrefix: string,
  runId: string,
  bodyJson: string,
  sourceRevision: number,
): Promise<string | null> {
  let stored: { stored: boolean; status: 'ready' | 'failed' };
  try {
    stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>(
      'kernel.member_vy.result.store',
      { runId, outcome: { status: 'ready', body: bodyJson, sourceRevision } },
      as,
    );
  } catch (error: unknown) {
    if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') {
      return 'AI_STOPPED';
    }
    throw error;
  }
  if (!stored.stored || stored.status === 'failed') {
    console.error(`[${logPrefix}] run failed: AI_STOPPED`);
    return 'AI_STOPPED';
  }
  return null;
}

export async function runNotesSummarize(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
  input: NoteSummarizeInput,
): Promise<NoteSummarizeResult> {
  const timeoutMs = deps.timeoutMs ?? NOTE_AI_TIMEOUT_MS;
  const ctx = await preflightNotesVy(deps, orgId, actor, input.noteId);
  try {
    const started = await deps.runtime.execute<{ runId: string }>(
      'kernel.member_vy.run.start',
      { feature: 'notes.summary', subjectType: 'notes.note', subjectId: input.noteId },
      ctx.as,
    );
    const runId = started.runId;
    const ports = bindPorts(
      { orgId, memberUserId: actor.userId },
      { model: ctx.model, memory: nothingToRemember, knowledge: noKnowledge },
    );
    let bodyJson = '';
    let parsed: { summary: string; bullets: string[]; dropped: number };
    try {
      const out = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter: ctx.meter }, () =>
          summarizeNote(
            {
              noteTitle: ctx.note.title,
              noteBody: ctx.note.body,
              language: input.language ?? 'vi',
            },
            ports,
          ),
        ),
        timeoutMs,
      );
      bodyJson = revealPrivateText(out.body);
      parsed = out.parsed;
    } catch (error: unknown) {
      const errorCode = notesAiCodeOf(error);
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, ctx.as);
      } catch (storeError: unknown) {
        console.error(`[notes-summary] failed result not stored: ${notesAiCodeOf(storeError)}`);
      }
      console.error(`[notes-summary] run failed: ${errorCode}`);
      return {
        state: 'failed',
        runId,
        noteId: input.noteId,
        noteRevision: ctx.note.revision,
        stale: false,
        summary: '',
        bullets: [],
        dropped: 0,
        errorCode,
      };
    }

    await verifyNoteReadableForRun(deps, ctx.as, 'notes-summary', runId, input.noteId);

    const stoppedCode = await storeNotesVyReady(deps, ctx.as, 'notes-summary', runId, bodyJson, ctx.note.revision);
    if (stoppedCode !== null) {
      return {
        state: 'failed',
        runId,
        noteId: input.noteId,
        noteRevision: ctx.note.revision,
        stale: false,
        summary: '',
        bullets: [],
        dropped: 0,
        errorCode: stoppedCode,
      };
    }

    return {
      state: 'ready',
      runId,
      noteId: input.noteId,
      noteRevision: ctx.note.revision,
      stale: false,
      summary: parsed.summary,
      bullets: parsed.bullets,
      dropped: parsed.dropped,
      errorCode: null,
    };
  } finally {
    ctx.release();
  }
}

export async function runNotesSuggestTodos(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
  input: NoteSuggestTodosInput,
): Promise<NoteSuggestTodosResult> {
  const timeoutMs = deps.timeoutMs ?? NOTE_AI_TIMEOUT_MS;
  const ctx = await preflightNotesVy(deps, orgId, actor, input.noteId);
  try {
    const started = await deps.runtime.execute<{ runId: string }>(
      'kernel.member_vy.run.start',
      { feature: 'notes.todo_suggest', subjectType: 'notes.note', subjectId: input.noteId },
      ctx.as,
    );
    const runId = started.runId;
    const ports = bindPorts(
      { orgId, memberUserId: actor.userId },
      { model: ctx.model, memory: nothingToRemember, knowledge: noKnowledge },
    );
    const today = zonedDate(input.timeZone ?? DEFAULT_TIME_ZONE, Date.now());
    let bodyJson = '';
    let parsed: { suggestions: Array<{ title: string; details: string; dueOn: string | null }>; dropped: number };
    try {
      const out = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter: ctx.meter }, () =>
          suggestTodosFromNote(
            {
              noteTitle: ctx.note.title,
              noteBody: ctx.note.body,
              today,
              language: input.language ?? 'vi',
            },
            ports,
          ),
        ),
        timeoutMs,
      );
      bodyJson = revealPrivateText(out.body);
      parsed = out.parsed;
    } catch (error: unknown) {
      const errorCode = notesAiCodeOf(error);
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, ctx.as);
      } catch (storeError: unknown) {
        console.error(`[notes-todo-suggest] failed result not stored: ${notesAiCodeOf(storeError)}`);
      }
      console.error(`[notes-todo-suggest] run failed: ${errorCode}`);
      return {
        state: 'failed',
        runId,
        noteId: input.noteId,
        noteRevision: ctx.note.revision,
        stale: false,
        suggestions: [],
        dropped: 0,
        errorCode,
      };
    }

    await verifyNoteReadableForRun(deps, ctx.as, 'notes-todo-suggest', runId, input.noteId);

    const stoppedCode = await storeNotesVyReady(deps, ctx.as, 'notes-todo-suggest', runId, bodyJson, ctx.note.revision);
    if (stoppedCode !== null) {
      return {
        state: 'failed',
        runId,
        noteId: input.noteId,
        noteRevision: ctx.note.revision,
        stale: false,
        suggestions: [],
        dropped: 0,
        errorCode: stoppedCode,
      };
    }

    return {
      state: 'ready',
      runId,
      noteId: input.noteId,
      noteRevision: ctx.note.revision,
      stale: false,
      suggestions: parsed.suggestions,
      dropped: parsed.dropped,
      errorCode: null,
    };
  } finally {
    ctx.release();
  }
}

export async function readNotesVyResults(
  deps: Pick<MeetingSummaryDeps, 'runtime'>,
  orgId: string,
  actor: UserActor,
  noteId: string,
): Promise<NoteVyResults> {
  const as = { actor, orgId };
  // Enforce caller readability via RLS BEFORE reading any stored member_vy_result (ADR-0049):
  // if visibility/share was revoked or role demoted, notes.note.get throws NOTE_NOT_FOUND immediately.
  const note = await deps.runtime.query<Note>('notes.note.get', { noteId }, as);
  if (note.deletedAt !== null) {
    return { noteId, summary: null, todoSuggest: null };
  }

  const readLatestReady = async (feature: 'notes.summary' | 'notes.todo_suggest') => {
    const latest = await deps.runtime.query<{
      runId: string;
      state: 'running' | 'ready' | 'failed';
      errorCode: string | null;
      expiresAt: string;
    } | null>('kernel.member_vy.run.latest', { feature, subjectType: 'notes.note', subjectId: noteId }, as);
    if (!latest || latest.state !== 'ready' || Date.parse(latest.expiresAt) <= Date.now()) {
      return null;
    }
    const stored = await deps.runtime.query<{
      runId: string;
      status: string;
      sourceRevision: number | null;
      body: string | null;
      expiresAt: string;
    }>('kernel.member_vy.result.get', { runId: latest.runId }, as);
    if (stored.status !== 'ready' || stored.body === null || Date.parse(stored.expiresAt) <= Date.now()) {
      return null;
    }
    return stored;
  };

  const summaryRow = await readLatestReady('notes.summary');
  const todoRow = await readLatestReady('notes.todo_suggest');
  let accepted = { summaryAccepted: false, todosAccepted: false };
  if (summaryRow || todoRow) {
    accepted = await deps.runtime.query<{ summaryAccepted: boolean; todosAccepted: boolean }>(
      'notes.vy.accepted',
      {
        noteId,
        ...(summaryRow ? { summaryRunId: summaryRow.runId } : {}),
        ...(todoRow ? { todoRunId: todoRow.runId } : {}),
      },
      as,
    );
  }

  let summary: NoteSummarizeResult | null = null;
  if (summaryRow?.body && !accepted.summaryAccepted) {
    try {
      const parsed = zStoredNoteSummary.safeParse(JSON.parse(summaryRow.body) as unknown);
      if (parsed.success) {
        summary = {
          state: 'ready',
          runId: summaryRow.runId,
          noteId,
          noteRevision: summaryRow.sourceRevision ?? note.revision,
          stale: summaryRow.sourceRevision !== null && summaryRow.sourceRevision !== note.revision,
          summary: parsed.data.summary,
          bullets: parsed.data.bullets,
          dropped: parsed.data.dropped,
          errorCode: null,
        };
      }
    } catch {
      summary = null;
    }
  }

  let todoSuggest: NoteSuggestTodosResult | null = null;
  if (todoRow?.body && !accepted.todosAccepted) {
    try {
      const parsed = zStoredTodoSuggest.safeParse(JSON.parse(todoRow.body) as unknown);
      if (parsed.success) {
        todoSuggest = {
          state: 'ready',
          runId: todoRow.runId,
          noteId,
          noteRevision: todoRow.sourceRevision ?? note.revision,
          stale: todoRow.sourceRevision !== null && todoRow.sourceRevision !== note.revision,
          suggestions: parsed.data.suggestions,
          dropped: parsed.data.dropped,
          errorCode: null,
        };
      }
    } catch {
      todoSuggest = null;
    }
  }

  return { noteId, summary, todoSuggest };
}
