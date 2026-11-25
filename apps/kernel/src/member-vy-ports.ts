// SPDX-License-Identifier: AGPL-3.0-only
// The built-in implementation of Vy's memory port (ADR-0049 decision 9, issue #2783): a deployment on `docker compose up` has no outside
// service, so memory is the member's own rows of ludy_kernel.member_vy_memory, read and written only through the member's own commands, in the
// member's own user context. Asking about anyone else is refused before a command is run, and the database would refuse it anyway (the
// restrictive policy shows a member their own rows only). Knowledge has no declared queries yet: a feature that asks gets no passages.
import { z } from 'zod';
import { generateMeetingDealUpdateText, DEAL_UPDATE_TIMEOUT_MS, DealUpdateModelError, ADHERENCE_TIMEOUT_MS, AdherenceModelError, generateMeetingAdherenceText, ASK_TIMEOUT_MS, DIGEST_TIMEOUT_MS, DigestModelError, generateMeetingDigestText, ASSIGNEE_TIMEOUT_MS, AssigneeModelError, generateMeetingAssigneeText, AiBudgetExhaustedError, AiMeterMissingError, AskModelError, BRIEF_TIMEOUT_MS, BriefModelError, CHAPTERS_TIMEOUT_MS, ChaptersModelError, generateMeetingBriefText, generateMeetingChaptersText, SUMMARY_TIMEOUT_MS, SummaryModelError, TASKS_FROM_NOTE_TIMEOUT_MS, TasksFromNoteModelError, TranslationModelError, aiCost, generateMeetingAskText, generateMeetingSummaryText, generateMeetingTranslationText, generateNoteOrganizeText, generateNoteSummaryText, generateTasksFromNoteText, generateTasksFromSourceText, generateTodoPlanText, generateTodoSuggestText, withAiScope, type AiConfig, type AiMeter, generateMeetingTitleText, TITLE_TIMEOUT_MS, TitleModelError, generateMeetingCommitmentsText, COMMITMENTS_TIMEOUT_MS, CommitmentsModelError, generateMeetingFollowupNoteText, FOLLOWUP_NOTE_TIMEOUT_MS, FollowupNoteModelError, OPEN_POINTS_TIMEOUT_MS, OpenPointsModelError, generateMeetingOpenPointsText, SALES_INSIGHT_TIMEOUT_MS, SalesInsightModelError, generateMeetingSalesInsightText, TEMPLATE_SUGGEST_TIMEOUT_MS, TemplateSuggestModelError, generateMeetingTemplateSuggestText } from '@ludy/agent';
import { DealUpdateError, proposeDealUpdate, AdherenceError, checkAgenda, NOTE_AI_LIMITS, NOTE_AI_TIMEOUT_MS, TASKS_FROM_NOTE_LIMITS, AskError, DigestError, writeDigest, AssigneeError, pickAssignee, BriefError, writeBrief, ChaptersError, chapterMeeting, NoteAiError, NoteAiModelError, NoteOrganizeError, TodoPlanError, SummaryError, TasksFromNoteError, TasksFromSourceError, TranslationError, askAcrossMeetings, bindPorts, noKnowledge, organizeUnfiledNotes, planTodosForToday, privateText, proposeTasksFromNote, proposeTasksFromSource, revealPrivateText, enhanceNotes, suggestTodosFromNote, summarizeMeeting, summarizeNote, translateSummary, translateTranscriptChunk, planTranscriptChunks, chunkExpectedUsage, lineHash, type MemberRef, type MemoryEntry, type MemoryPort, type ModelPort, type NoteOrganizeInputNote, type NoteOrganizeInputNotebook, type Ports, type TaskSourceKind, type TodoPlanInputItem, TitleError, suggestMeetingTitles, CommitmentsError, listCommitments, FollowupNoteError, draftFollowupPersonalNote, OpenPointsError, listOpenPoints, SalesInsightError, analyzeSalesInsight, computeCustomerTalkShare, TemplateSuggestError, suggestMeetingTemplate } from '@ludy/agent/member-vy';
import { type DealUpdateAnswer, type DealUpdateAsk, type DealUpdateStatus, ADHERENCE_ESTIMATE, type AdherenceAnswer, type AdherenceAsk, type AdherenceFacts, type AdherenceStatus, ASK_ESTIMATE, ASK_HITS_MAX, DIGEST_ESTIMATE, digestLines, type DigestAnswer, type DigestAsk, type DigestFacts, type DigestStatus, type AssigneeAnswer, type AssigneeAsk, type AssigneeFacts, type AssigneeStatus, BRIEF_ESTIMATE, briefLines, type BriefAnswer, type BriefFacts, type BriefStatus, type BriefTarget, DEFAULT_TIME_ZONE, zNoteTodoSuggestion, zTranscriptTranslationResult, zonedDate, templateSections, type AskAnswer, type AskLines, type AskStatus, type FollowupDraft, type FollowupNoteAnswer, type FollowupNoteAsk, type FollowupNoteStatus, type LiveNotesDone, type LiveNotesInput, type MeetingSummaryTemplate, type MinutesTemplateCopy, type Note, type NoteOrganizeInput, type NoteOrganizeResult, type NoteOrganizeSuggestion, type NoteSuggestTodosInput, type NoteSuggestTodosResult, type NoteSummarizeInput, type NoteSummarizeResult, type NoteVyResults, type NoteVyStatus, type ProjectSeat, type ProjectTaskSourceType, type ProjectTasksFromNoteInput, type ProjectTasksFromNoteResult, type ProjectTasksFromNoteStatus, type ProjectTasksFromSourceInput, type ProjectTasksFromSourceResult, type ProjectTasksFromSourceStatus, type Summarized, type TodoPlanFocusItem, type TodoPlanInput, type TodoPlanRescheduleItem, type TodoPlanResult, type Transcript, type TranscriptSource, type TranscriptStarted, type TranscriptTranslated, type TranscriptTranslationStatus, type Translated, type TranslationSource, type TranslationTarget, type TranslationStatus, type TitleAnswer, type CommitmentsAnswer, type OpenPointsAnswer, type SalesInsightAnswer, type SalesInsightStatus, type TemplateVyAnswer } from '@ludy/kernel-contract';
import { readTasksFromSourceData, type SourceQueryFn } from '@ludy/mod-projects';
import { DomainError, type Runtime, type UserActor } from '@ludy/kernel-runtime';
import type { DraftBudget } from './ai-draft-limit.ts';
import { isPositivePrice } from './price.ts';

// The only file of the API that imports the member-Vy entry of the agent package (member-vy-import-allowlist.test.ts): the rest of the kernel gets what it needs from here.
export type { ModelPort } from '@ludy/agent/member-vy';

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
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new NoteAiModelError('failed');
  }
  // Single-read destructure before validation so getter-backed prompt objects cannot mutate between checks and the call.
  let safePrompt: { system: string; user: string };
  try {
    const { system, user } = prompt;
    if (
      typeof system !== 'string' ||
      system.length === 0 ||
      system.length > NOTE_AI_MAX_SYSTEM_CHARS ||
      typeof user !== 'string' ||
      user.length === 0 ||
      user.length > NOTE_AI_MAX_PROMPT_CHARS
    ) {
      throw new NoteAiModelError('failed');
    }
    safePrompt = { system, user };
  } catch (error: unknown) {
    if (error instanceof NoteAiModelError) throw error;
    throw new NoteAiModelError('failed');
  }
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
      prompt.feature === 'meetings.adherence'
        ? generateMeetingAdherenceText(config, prompt, Math.min(timeoutMs, ADHERENCE_TIMEOUT_MS))
        : prompt.feature === 'meetings.digest'
        ? generateMeetingDigestText(config, prompt, Math.min(timeoutMs, DIGEST_TIMEOUT_MS))
        : prompt.feature === 'meetings.assignee'
        ? generateMeetingAssigneeText(config, prompt, Math.min(timeoutMs, ASSIGNEE_TIMEOUT_MS))
        : prompt.feature === 'meetings.brief'
        ? generateMeetingBriefText(config, prompt, Math.min(timeoutMs, BRIEF_TIMEOUT_MS))
        : prompt.feature === 'meetings.chapters'
        ? generateMeetingChaptersText(config, prompt, Math.min(timeoutMs, CHAPTERS_TIMEOUT_MS))
        : prompt.feature === 'meetings.title'
        ? generateMeetingTitleText(config, prompt, Math.min(timeoutMs, TITLE_TIMEOUT_MS))
        : prompt.feature === 'meetings.commitments'
        ? generateMeetingCommitmentsText(config, prompt, Math.min(timeoutMs, COMMITMENTS_TIMEOUT_MS))
        : prompt.feature === 'meetings.template_suggest'
        ? generateMeetingTemplateSuggestText(config, prompt, Math.min(timeoutMs, TEMPLATE_SUGGEST_TIMEOUT_MS))
        : prompt.feature === 'meetings.open_points'
        ? generateMeetingOpenPointsText(config, prompt, Math.min(timeoutMs, OPEN_POINTS_TIMEOUT_MS))
        : prompt.feature === 'meetings.sales_insight'
        ? generateMeetingSalesInsightText(config, prompt, Math.min(timeoutMs, SALES_INSIGHT_TIMEOUT_MS))
        : prompt.feature === 'meetings.followup_note'
        ? generateMeetingFollowupNoteText(config, prompt, Math.min(timeoutMs, FOLLOWUP_NOTE_TIMEOUT_MS))
        : prompt.feature === 'meetings.deal_update'
        ? generateMeetingDealUpdateText(config, prompt, Math.min(timeoutMs, DEAL_UPDATE_TIMEOUT_MS))
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
                  : prompt.feature === 'notes.todo_plan'
                    ? invokeNoteAiModel(prompt, (safePrompt, signal) => generateTodoPlanText(config, safePrompt, signal), timeoutMs)
                    : prompt.feature === 'notes.organize'
                      ? invokeNoteAiModel(prompt, (safePrompt, signal) => generateNoteOrganizeText(config, safePrompt, signal), timeoutMs)
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
  if (error instanceof ChaptersError) return error.code;
  if (error instanceof ChaptersModelError) return error.kind === 'timeout' ? 'CHAPTERS_TIMEOUT' : 'CHAPTERS_FAILED';
  if (error instanceof TitleError) return error.code;
  if (error instanceof TitleModelError) return error.kind === 'timeout' ? 'TITLE_TIMEOUT' : 'TITLE_FAILED';
  if (error instanceof CommitmentsError) return error.code;
  if (error instanceof CommitmentsModelError) return error.kind === 'timeout' ? 'COMMITMENTS_TIMEOUT' : 'COMMITMENTS_FAILED';
  if (error instanceof TemplateSuggestError) return error.code;
  if (error instanceof TemplateSuggestModelError) return error.kind === 'timeout' ? 'TEMPLATE_SUGGEST_TIMEOUT' : 'TEMPLATE_SUGGEST_FAILED';
  if (error instanceof OpenPointsError) return error.code;
  if (error instanceof OpenPointsModelError) return error.kind === 'timeout' ? 'OPEN_POINTS_TIMEOUT' : 'OPEN_POINTS_FAILED';
  if (error instanceof SalesInsightError) return error.code;
  if (error instanceof SalesInsightModelError) return error.kind === 'timeout' ? 'SALES_INSIGHT_TIMEOUT' : 'SALES_INSIGHT_FAILED';
  if (error instanceof FollowupNoteError) return error.code;
  if (error instanceof FollowupNoteModelError) return error.kind === 'timeout' ? 'FOLLOWUP_NOTE_TIMEOUT' : 'FOLLOWUP_NOTE_FAILED';
  if (error instanceof DealUpdateError) return error.code;
  if (error instanceof DealUpdateModelError) return error.kind === 'timeout' ? 'DEAL_UPDATE_TIMEOUT' : 'DEAL_UPDATE_FAILED';
  if (error instanceof TasksFromNoteError) return error.code;
  if (error instanceof TasksFromSourceError) return error.code;
  if (error instanceof TasksFromNoteModelError) return error.kind === 'timeout' ? 'PROPOSAL_TIMEOUT' : 'PROPOSAL_FAILED';
  if (error instanceof NoteAiError) return error.code;
  if (error instanceof TodoPlanError) return error.code;
  if (error instanceof NoteOrganizeError) return error.code;
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

// A title run's failure: its own checks and model errors, the meter's codes, and "failed" or "timeout" (never the summary's words) for anything else, the deadline's included.
function titleCodeOf(error: unknown): string {
  if (error instanceof TitleError || error instanceof TitleModelError) return codeOf(error);
  if (error instanceof SummaryModelError && error.kind === 'timeout') return 'TITLE_TIMEOUT';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'TITLE_FAILED' : code;
}

// A commitments run's failure: its own checks and model errors, the meter's codes, and "failed" or "timeout" (never the summary's words) for anything else, the deadline's included.
function commitmentsCodeOf(error: unknown): string {
  if (error instanceof CommitmentsError || error instanceof CommitmentsModelError) return codeOf(error);
  if (error instanceof SummaryModelError && error.kind === 'timeout') return 'COMMITMENTS_TIMEOUT';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'COMMITMENTS_FAILED' : code;
}

// A template-suggestion run's failure: its own checks and model errors, the meter's codes, and "failed" or "timeout" (never the summary's words) for anything else, the deadline's included.
function templateSuggestCodeOf(error: unknown): string {
  if (error instanceof TemplateSuggestError || error instanceof TemplateSuggestModelError) return codeOf(error);
  if (error instanceof SummaryModelError && error.kind === 'timeout') return 'TEMPLATE_SUGGEST_TIMEOUT';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'TEMPLATE_SUGGEST_FAILED' : code;
}

// An open-points run's failure: its own checks and model errors, the meter's codes, and "failed" or "timeout" (never the summary's words) for anything else, the deadline's included.
function openPointsCodeOf(error: unknown): string {
  if (error instanceof OpenPointsError || error instanceof OpenPointsModelError) return codeOf(error);
  if (error instanceof SummaryModelError && error.kind === 'timeout') return 'OPEN_POINTS_TIMEOUT';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'OPEN_POINTS_FAILED' : code;
}

function salesInsightCodeOf(error: unknown): string {
  if (error instanceof SalesInsightError || error instanceof SalesInsightModelError) return codeOf(error);
  if (error instanceof SummaryModelError && error.kind === 'timeout') return 'SALES_INSIGHT_TIMEOUT';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'SALES_INSIGHT_FAILED' : code;
}

// A personal-note follow-up run's failure: its own checks and model errors, the meter's codes, and "failed" or "timeout" for anything else.
function followupNoteCodeOf(error: unknown): string {
  if (error instanceof FollowupNoteError || error instanceof FollowupNoteModelError) return codeOf(error);
  if (error instanceof SummaryModelError && error.kind === 'timeout') return 'FOLLOWUP_NOTE_TIMEOUT';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'FOLLOWUP_NOTE_FAILED' : code;
}

// A deal-update run's failure: its own checks and model errors, the meter's codes, and "failed" or "timeout" for anything else.
function dealUpdateCodeOf(error: unknown): string {
  if (error instanceof DealUpdateError || error instanceof DealUpdateModelError) return codeOf(error);
  if (error instanceof SummaryModelError && error.kind === 'timeout') return 'DEAL_UPDATE_TIMEOUT';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'DEAL_UPDATE_FAILED' : code;
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
      const meeting = await deps.runtime.query<{ language: 'vi' | 'en'; summaryTemplate: MeetingSummaryTemplate; minutesTemplate: MinutesTemplateCopy | null }>('meetings.meeting.get', { meetingId }, as);
      // The minutes template the recorder picked (A4, #3162): the same run fills its sections; the templates are code, the model only writes the text. On a template the org wrote (#3578) the
      // sections are the meeting's own copy, and the run carries the copy's hash so the save can tell it from a run made for another layout.
      const copy = meeting.minutesTemplate;
      // A custom meeting without its copy cannot be (the database refuses it), and a run for it must never go as a general one labelled custom: it fails closed.
      if (meeting.summaryTemplate === 'custom' && !copy) throw new Error('MINUTES_TEMPLATE_COPY_MISSING');
      const template = copy
        ? { code: meeting.summaryTemplate, sections: templateSections(meeting.summaryTemplate, copy.sections), hash: copy.hash }
        : { code: meeting.summaryTemplate, sections: templateSections(meeting.summaryTemplate) };
      const segments = transcript.segments.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, speakerLabel: s.speakerLabel, text: s.text }));
      // The people of the meeting, by display name, as the recorder reads them: the summary may suggest which of them a speaker is (#3502). Only the summary asks; the notes run does not.
      const attendees = kind === 'summary' ? (await deps.runtime.query<{ names: string[] }>('meetings.summary.attendees', { meetingId }, as)).names : [];
      // The organization's glossary (#4043): recorder-only read for summary runs (notes enhance does not take a glossary).
      const glossary = kind === 'summary' ? (await deps.runtime.query<{ terms: string[] }>('meetings.glossary.for_meeting', { meetingId }, as)).terms : [];
      // 3. The one call, outside any transaction, in the scope of this run.
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, ports);
      const result = await withDeadline(
        // Both kinds answer one checked body (as private text); the rest of each result is not used here.
        withAiScope({ orgId, memberRunId: runId, meter }, async () => ({
          body: (kind === 'notes' ? await enhanceNotes({ segments, language: meeting.language, template, notes }, bound) : await summarizeMeeting({ segments, language: meeting.language, template, attendees, glossary }, bound)).body,
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
    // The recorder's notice that the draft is waiting (#3730): only for a summary (not the notes run), only once the result is stored as ready, and best effort: a notice that could not be
    // queued never fails the run, and a failed run (every path above) sends nothing. The event holds ids and the language, no text of the summary or the meeting.
    if (kind === 'summary') await notifySummaryReady(deps.runtime, as, { meetingId, runId });
    return { meetingId, runId, state: 'ready', errorCode: null };
  } finally {
    ticket.release();
  }
}

// The recorder's Vy writing the table of contents of one meeting (#3844, ADR-0049 stage A): the summary's run in a smaller form. The checks come first (meetings.chapters.status: the deployment's switch,
// the recorder; then a draft-budget ticket; then meetings.chapters.start, which makes the member's Vy run under the kernel's vy.use, kill-switch and budget checks), the transcript is read as the
// recorder, the one model call runs outside any transaction through the member's own meter under meetings.chapters, and the checked chapters are stored as the recorder's private, tainted result.
// The recorder then copies the result into their draft (meetings.chapters.copy_result). A failure at any step is a fixed code stored as the run's failed result.
export function runMeetingChapters(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<Summarized> {
  return runChapters(deps, orgId, actor, meetingId);
}

// The fixed code of a failure of a chapters run: the codes of its own checks, and its own words (never the summary's) for a timeout and for anything unexpected.
function chaptersCodeOf(error: unknown): string {
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' ? 'CHAPTERS_FAILED' : code === 'SUMMARY_TIMEOUT' ? 'CHAPTERS_TIMEOUT' : code;
}

async function runChapters(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<Summarized> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here; type the chapters by hand');
  const allowed = await deps.runtime.query<{ enabled: boolean; reason: 'off' | 'not_recorder' | null }>('meetings.chapters.status', { meetingId }, as);
  if (!allowed.enabled) {
    if (allowed.reason === 'not_recorder') throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy for its chapters');
    throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here; type the chapters by hand');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('SUMMARY_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    const started = await deps.runtime.execute<{ meetingId: string; runId: string }>('meetings.chapters.start', { meetingId }, as);
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<Summarized> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        console.error(`[meetings-chapters] failed result not stored: ${chaptersCodeOf(storeError)}`);
      }
      console.error(`[meetings-chapters] run failed: ${errorCode}`);
      return { meetingId, runId, state: 'failed', errorCode };
    };
    let body: string;
    try {
      const transcript = await deps.runtime.query<Transcript>('meetings.transcript.get', { meetingId }, as);
      const meeting = await deps.runtime.query<{ language: 'vi' | 'en' }>('meetings.meeting.get', { meetingId }, as);
      const { terms: glossary } = await deps.runtime.query<{ terms: string[] }>('meetings.glossary.for_meeting', { meetingId }, as);
      const segments = transcript.segments.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, speakerLabel: s.speakerLabel, text: s.text }));
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, { model, memory: nothingToRemember, knowledge: noKnowledge });
      const result = await withDeadline(withAiScope({ orgId, memberRunId: runId, meter }, async () => ({ body: (await chapterMeeting({ segments, language: meeting.language, glossary }, bound)).body })), timeoutMs);
      body = revealPrivateText(result.body);
    } catch (error: unknown) {
      return await fail(chaptersCodeOf(error));
    }
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body } }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') throw error;
      return await fail(chaptersCodeOf(error));
    }
    if (stored.status === 'failed') {
      console.error('[meetings-chapters] run failed: AI_STOPPED');
      return { meetingId, runId, state: 'failed', errorCode: 'AI_STOPPED' };
    }
    return { meetingId, runId, state: 'ready', errorCode: null };
  } finally {
    ticket.release();
  }
}

// The recorder's Vy suggesting a title for one meeting from its transcript (#3947, ADR-0049 stage A): the chapters' run for one meeting with the brief's answer, which goes to the browser and nowhere else:
//   1. meetings.title.status, as the recorder: the deployment's switch and the recorder; a refusal here has made no run and spent nothing;
//   2. a draft-budget ticket, then meetings.title.start, whose run.start checks vy.use, the kill switches and the budget before any call (a spent budget is refused here, with no call made);
//   3. the transcript, read as the recorder, and the one model call outside any transaction under the member's own meter (meetings.title), with a hard timeout. The model has no tools: the checks in code
//      (packages/agent member-vy/meeting-title.ts) decide what shows, and an empty or unusable answer is "no suggestion";
//   4. the run's result row is stored with COUNTS ONLY (candidates, dropped), never a title, with kernel.member_vy.result.store in the member's own session.
// The candidates go back to the browser and nowhere else: no result row, task, mail, search hit or export holds one, and neither the transcript nor a candidate is ever logged (a failure is named by a
// fixed code). The recorder's pick is the rename command, a click of its own.
export async function runMeetingTitle(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<TitleAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here; type the title by hand');
  const none = (dropped = 0): TitleAnswer => ({ state: 'none', errorCode: null, titles: [], dropped });
  const failed = (errorCode: string): TitleAnswer => ({ state: 'failed', errorCode, titles: [], dropped: 0 });
  const allowed = await deps.runtime.query<{ enabled: boolean; reason: 'off' | 'not_recorder' | null }>('meetings.title.status', { meetingId }, as);
  if (!allowed.enabled) {
    if (allowed.reason === 'not_recorder') throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy for a title');
    throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here; type the title by hand');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('TITLE_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // The checks come first: the switch, vy.use, the kill switches (the member's own Vy's included) and the budget. A refusal here has made no run and no call.
    let started: { meetingId: string; runId: string };
    try {
      started = await deps.runtime.execute<{ meetingId: string; runId: string }>('meetings.title.start', { meetingId }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'TITLE_BUSY' : error.code;
        console.error(`[meetings-title] run not started: ${errorCode}`);
        return failed(errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<TitleAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-title] failed result not stored: ${titleCodeOf(storeError)}`);
      }
      console.error(`[meetings-title] run failed: ${errorCode}`);
      return failed(errorCode);
    };
    let answer: { titles: string[]; dropped: number };
    try {
      const transcript = await deps.runtime.query<Transcript>('meetings.transcript.get', { meetingId }, as);
      const meeting = await deps.runtime.query<{ language: 'vi' | 'en' }>('meetings.meeting.get', { meetingId }, as);
      const { terms: glossary } = await deps.runtime.query<{ terms: string[] }>('meetings.glossary.for_meeting', { meetingId }, as);
      const segments = transcript.segments.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, speakerLabel: s.speakerLabel, text: s.text }));
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, { model, memory: nothingToRemember, knowledge: noKnowledge });
      answer = (await withDeadline(withAiScope({ orgId, memberRunId: runId, meter }, () => suggestMeetingTitles({ segments, language: meeting.language, glossary }, bound)), timeoutMs)).answer;
    } catch (error: unknown) {
      // An answer with no candidate left, or none that could be read, is "no suggestion", not a failure of the service; the run's result still says which.
      if (error instanceof TitleError && error.code === 'TITLE_UNPARSABLE') {
        await fail('TITLE_UNPARSABLE');
        return none();
      }
      if (error instanceof TitleError && error.code === 'TITLE_EMPTY') {
        try {
          await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, titles: 0, dropped: 0 }) } }, as);
        } catch (storeError: unknown) {
          console.error(`[meetings-title] result not stored: ${titleCodeOf(storeError)}`);
        }
        return none();
      }
      return await fail(titleCodeOf(error));
    }
    // Counts only: never a candidate.
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, titles: answer.titles.length, dropped: answer.dropped }) } }, as);
    } catch (error: unknown) {
      // The run ended while the model was answering (the member cancelled it, a switch stopped it): the text is not shown.
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return failed('AI_STOPPED');
      return await fail(titleCodeOf(error));
    }
    // The kernel re-checked the switches and the budget at the store and may have stopped the run: its answer is the state, and nothing of the model's text is shown for a stopped run.
    if (stored.status === 'failed') {
      console.error('[meetings-title] run failed: AI_STOPPED');
      return failed('AI_STOPPED');
    }
    return { state: 'suggested', errorCode: null, titles: answer.titles, dropped: answer.dropped };
  } finally {
    ticket.release();
  }
}

// The recorder's Vy listing what each speaker of one meeting committed to or decided (#3954, ADR-0049 stage A): the title's run, with an answer that goes to the browser and nowhere else:
//   1. meetings.commitments.status, as the recorder: the deployment's switch and the recorder; a refusal here has made no run and spent nothing;
//   2. a draft-budget ticket, then meetings.commitments.start, whose run.start checks vy.use, the kill switches and the budget before any call (a spent budget is refused here, with no call made);
//   3. the transcript, read as the recorder, and the one model call outside any transaction under the member's own meter (meetings.commitments), with a hard timeout. The model has no tools: the checks in code
//      (packages/agent member-vy/meeting-commitments.ts) decide what shows, and an empty or unusable answer is "no suggestion";
//   4. the run's result row is stored with COUNTS ONLY (speakers, lines, dropped), never a line, with kernel.member_vy.result.store in the member's own session.
// The lines go back to the browser and nowhere else: no result row, task, mail, search hit or export holds one, and neither the transcript nor a line is ever logged (a failure is named by a
// fixed code). Nothing is published and no task is made from here.
export async function runMeetingCommitments(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<CommitmentsAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
  const none = (dropped = 0): CommitmentsAnswer => ({ state: 'none', errorCode: null, speakers: [], dropped });
  const failed = (errorCode: string): CommitmentsAnswer => ({ state: 'failed', errorCode, speakers: [], dropped: 0 });
  const allowed = await deps.runtime.query<{ enabled: boolean; reason: 'off' | 'not_recorder' | null }>('meetings.commitments.status', { meetingId }, as);
  if (!allowed.enabled) {
    if (allowed.reason === 'not_recorder') throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy what each speaker committed to');
    throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('COMMITMENTS_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // The checks come first: the switch, vy.use, the kill switches (the member's own Vy's included) and the budget. A refusal here has made no run and no call.
    let started: { meetingId: string; runId: string };
    try {
      started = await deps.runtime.execute<{ meetingId: string; runId: string }>('meetings.commitments.start', { meetingId }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'COMMITMENTS_BUSY' : error.code;
        console.error(`[meetings-commitments] run not started: ${errorCode}`);
        return failed(errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<CommitmentsAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-commitments] failed result not stored: ${commitmentsCodeOf(storeError)}`);
      }
      console.error(`[meetings-commitments] run failed: ${errorCode}`);
      return failed(errorCode);
    };
    let answer: { speakers: CommitmentsAnswer['speakers']; dropped: number };
    try {
      const transcript = await deps.runtime.query<Transcript>('meetings.transcript.get', { meetingId }, as);
      const meeting = await deps.runtime.query<{ language: 'vi' | 'en' }>('meetings.meeting.get', { meetingId }, as);
      const segments = transcript.segments.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, speakerLabel: s.speakerLabel, text: s.text }));
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, { model, memory: nothingToRemember, knowledge: noKnowledge });
      answer = (await withDeadline(withAiScope({ orgId, memberRunId: runId, meter }, () => listCommitments({ segments, language: meeting.language }, bound)), timeoutMs)).answer;
    } catch (error: unknown) {
      // An answer with no line left, or none that could be read, is "no suggestion", not a failure of the service; the run's result still says which.
      if (error instanceof CommitmentsError && error.code === 'COMMITMENTS_UNPARSABLE') {
        await fail('COMMITMENTS_UNPARSABLE');
        return none();
      }
      if (error instanceof CommitmentsError && error.code === 'COMMITMENTS_EMPTY') {
        try {
          await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, speakers: 0, lines: 0, dropped: 0 }) } }, as);
        } catch (storeError: unknown) {
          console.error(`[meetings-commitments] result not stored: ${commitmentsCodeOf(storeError)}`);
        }
        return none();
      }
      return await fail(commitmentsCodeOf(error));
    }
    // Counts only: never a speaker or a line.
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, speakers: answer.speakers.length, lines: answer.speakers.reduce((n, s) => n + s.lines.length, 0), dropped: answer.dropped }) } }, as);
    } catch (error: unknown) {
      // The run ended while the model was answering (the member cancelled it, a switch stopped it): the text is not shown.
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return failed('AI_STOPPED');
      return await fail(commitmentsCodeOf(error));
    }
    // The kernel re-checked the switches and the budget at the store and may have stopped the run: its answer is the state, and nothing of the model's text is shown for a stopped run.
    if (stored.status === 'failed') {
      console.error('[meetings-commitments] run failed: AI_STOPPED');
      return failed('AI_STOPPED');
    }
    return { state: 'listed', errorCode: null, speakers: answer.speakers, dropped: answer.dropped };
  } finally {
    ticket.release();
  }
}

// The recorder's Vy suggesting the minutes template of one meeting when code could not tell (#4772, ADR-0049 stage A): the title's run, with an answer that goes to the browser and nowhere else:
//   1. meetings.template_suggest.status, as the recorder: the deployment's switch and the recorder; a refusal here has made no run and spent nothing;
//   2. a draft-budget ticket, then meetings.template_suggest.start, whose run.start checks vy.use, the kill switches and the budget before any call (a spent budget is refused here, with no call made);
//   3. the transcript, read as the recorder, and the one model call outside any transaction under the member's own meter (meetings.template_suggest), with a hard timeout. The model has no tools: the checks in code
//      (packages/agent member-vy/meeting-template-suggest.ts) decide what shows, and an empty or unusable answer is "no suggestion";
//   4. the run's result row is stored with COUNTS ONLY (suggested, dropped), never a line, with kernel.member_vy.result.store in the member's own session.
// The lines go back to the browser and nowhere else: no result row, task, mail, search hit or export holds one, and neither the transcript nor a line is ever logged (a failure is named by a
// fixed code). Nothing is published and no task is made from here.
export async function runMeetingTemplateSuggest(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<TemplateVyAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
  const none = (dropped = 0): TemplateVyAnswer => ({ state: 'none', errorCode: null, template: null, reason: null, seconds: null, dropped });
  const failed = (errorCode: string): TemplateVyAnswer => ({ state: 'failed', errorCode, template: null, reason: null, seconds: null, dropped: 0 });
  const allowed = await deps.runtime.query<{ enabled: boolean; reason: 'off' | 'not_recorder' | null }>('meetings.template_suggest.status', { meetingId }, as);
  if (!allowed.enabled) {
    if (allowed.reason === 'not_recorder') throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy which minutes template fits');
    throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('TEMPLATE_SUGGEST_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // The checks come first: the switch, vy.use, the kill switches (the member's own Vy's included) and the budget. A refusal here has made no run and no call.
    let started: { meetingId: string; runId: string };
    try {
      started = await deps.runtime.execute<{ meetingId: string; runId: string }>('meetings.template_suggest.start', { meetingId }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'TEMPLATE_SUGGEST_BUSY' : error.code;
        console.error(`[meetings-template-suggest] run not started: ${errorCode}`);
        return failed(errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<TemplateVyAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-template-suggest] failed result not stored: ${templateSuggestCodeOf(storeError)}`);
      }
      console.error(`[meetings-template-suggest] run failed: ${errorCode}`);
      return failed(errorCode);
    };
    let suggestion: { template: NonNullable<TemplateVyAnswer['template']>; reason: string; seconds: number };
    try {
      const transcript = await deps.runtime.query<Transcript>('meetings.transcript.get', { meetingId }, as);
      const meeting = await deps.runtime.query<{ language: 'vi' | 'en' }>('meetings.meeting.get', { meetingId }, as);
      const segments = transcript.segments.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, speakerLabel: s.speakerLabel, text: s.text }));
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, { model, memory: nothingToRemember, knowledge: noKnowledge });
      suggestion = (await withDeadline(withAiScope({ orgId, memberRunId: runId, meter }, () => suggestMeetingTemplate({ segments, language: meeting.language }, bound)), timeoutMs)).suggestion;
    } catch (error: unknown) {
      // An answer with no line left, or none that could be read, is "no suggestion", not a failure of the service; the run's result still says which.
      if (error instanceof TemplateSuggestError && error.code === 'TEMPLATE_SUGGEST_UNPARSABLE') {
        await fail('TEMPLATE_SUGGEST_UNPARSABLE');
        return none();
      }
      if (error instanceof TemplateSuggestError && error.code === 'TEMPLATE_SUGGEST_EMPTY') {
        try {
          await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, suggested: 0, dropped: 1 }) } }, as);
        } catch (storeError: unknown) {
          console.error(`[meetings-template-suggest] result not stored: ${templateSuggestCodeOf(storeError)}`);
        }
        return none();
      }
      return await fail(templateSuggestCodeOf(error));
    }
    // Counts only: never a reason.
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, suggested: 1, dropped: 0 }) } }, as);
    } catch (error: unknown) {
      // The run ended while the model was answering (the member cancelled it, a switch stopped it): the text is not shown.
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return failed('AI_STOPPED');
      return await fail(templateSuggestCodeOf(error));
    }
    // The kernel re-checked the switches and the budget at the store and may have stopped the run: its answer is the state, and nothing of the model's text is shown for a stopped run.
    if (stored.status === 'failed') {
      console.error('[meetings-template-suggest] run failed: AI_STOPPED');
      return failed('AI_STOPPED');
    }
    return { state: 'suggested', errorCode: null, template: suggestion.template, reason: suggestion.reason, seconds: suggestion.seconds, dropped: 0 };
  } finally {
    ticket.release();
  }
}

interface SalesInsightFacts {
  meetingId: string;
  language: 'vi' | 'en';
  deal: { id: string; title: string; stage: string };
  segments: Array<{ id: string; startSeconds: number; endSeconds: number; speakerLabel: string; text: string }>;
  speakerMapping: { internalNames: string[]; customerNames: string[] };
}

export async function salesInsightStatusOf(
  deps: Pick<MeetingSummaryDeps, 'runtime' | 'model' | 'meter'>,
  orgId: string,
  actor: UserActor,
  meetingId: string,
): Promise<SalesInsightStatus> {
  const status = await deps.runtime.query<SalesInsightStatus>('meetings.sales_insight.status', { meetingId }, { actor, orgId });
  if (status.enabled && (!deps.model || !deps.meter(actor))) return { ...status, enabled: false, reason: 'off' };
  return status;
}

// Sales call insights for a meeting linked to an open deal (#4920, L26, ADR-0049 stage A):
//   1. meetings.sales_insight.status as the recorder (non-recorders receive 404);
//   2. returns a clear non-executing state when AI is off, paused by kill switch, or over budget (zero model calls);
//   3. otherwise runs the recorder's own Vy once under meetings.sales_insight (projected-cost admitted), verifies citations + #4789 contact leaks + talk share in code,
//      stores COUNTS ONLY on member_vy_result, and returns the tainted insights exclusively to the recorder. Never touches the deal.
export async function runMeetingSalesInsight(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<SalesInsightAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SALES_INSIGHT_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  const status = await salesInsightStatusOf(deps, orgId, actor, meetingId);
  const empty = (state: SalesInsightAnswer['state'], errorCode: string | null = null, dropped = 0): SalesInsightAnswer => ({
    state,
    errorCode,
    deal: status.deal,
    customerTalkShare: null,
    concerns: [],
    buyingSignals: [],
    nextSteps: [],
    dropped,
  });

  if (!status.available) {
    if (status.reason === 'deal_closed') throw new DomainError('DEAL_CLOSED', 409, 'Cơ hội này đã đóng');
    if (status.reason === 'transcribe_running') throw new DomainError('TRANSCRIBE_RUNNING', 409, 'This meeting is still being transcribed; wait for it to finish');
    if (status.reason === 'no_transcript') throw new DomainError('TRANSCRIPT_EMPTY', 422, 'There is no transcript to read yet');
    throw new DomainError('MEETING_NO_DEAL', 409, 'Cuộc họp này chưa liên kết với cơ hội nào');
  }
  if (!model || !meter || status.reason === 'off') return empty('off', 'SUMMARY_OFF');
  if (status.reason === 'forbidden') throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
  if (status.reason === 'paused') return empty('paused', 'AI_STOPPED');
  if (status.reason === 'budget') return empty('budget', 'AI_BUDGET_EXHAUSTED');

  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) {
    throw new DomainError('SALES_INSIGHT_BUSY', 429, 'Vy đang bận phân tích cuộc gọi; thử lại sau ít phút', { retryAfterSeconds: ticket.retryAfterSeconds });
  }
  try {
    let started: { meetingId: string; runId: string };
    try {
      started = await deps.runtime.execute<{ meetingId: string; runId: string }>('meetings.sales_insight.start', { meetingId }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'SALES_INSIGHT_BUSY' : error.code;
        console.error(`[meetings-sales-insight] run not started: ${errorCode}`);
        return empty(error.code === 'AI_BUDGET_EXHAUSTED' ? 'budget' : 'failed', errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<SalesInsightAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        console.error(`[meetings-sales-insight] failed result not stored: ${salesInsightCodeOf(storeError)}`);
      }
      console.error(`[meetings-sales-insight] run failed: ${errorCode}`);
      return empty(errorCode === 'AI_BUDGET_EXHAUSTED' ? 'budget' : 'failed', errorCode);
    };

    let result: Awaited<ReturnType<typeof analyzeSalesInsight>>;
    let dealMeta = status.deal;
    let talkShareFallback: SalesInsightAnswer['customerTalkShare'] = null;
    try {
      const facts = await deps.runtime.query<SalesInsightFacts>('meetings.sales_insight.facts', { meetingId }, as);
      dealMeta = facts.deal;
      talkShareFallback = computeCustomerTalkShare(facts.segments, facts.speakerMapping);
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, { model, memory: nothingToRemember, knowledge: noKnowledge });
      result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () =>
          analyzeSalesInsight(
            {
              segments: facts.segments,
              language: facts.language,
              deal: { title: facts.deal.title, stage: facts.deal.stage },
              speakerMapping: facts.speakerMapping,
            },
            bound,
          ),
        ),
        timeoutMs,
      );
    } catch (error: unknown) {
      if (error instanceof SalesInsightError && error.code === 'SALES_INSIGHT_UNPARSABLE') {
        await fail('SALES_INSIGHT_UNPARSABLE');
        return { ...empty('none', null, 0), deal: dealMeta, customerTalkShare: talkShareFallback };
      }
      return await fail(salesInsightCodeOf(error));
    }

    const { answer, customerTalkShare } = result;
    const totalItems = answer.concerns.length + answer.buyingSignals.length + answer.nextSteps.length;
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>(
        'kernel.member_vy.result.store',
        {
          runId,
          outcome: {
            status: 'ready',
            body: JSON.stringify({
              v: 1,
              concerns: answer.concerns.length,
              buyingSignals: answer.buyingSignals.length,
              nextSteps: answer.nextSteps.length,
              dropped: answer.dropped,
            }),
          },
        },
        as,
      );
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return empty('paused', 'AI_STOPPED');
      return await fail(salesInsightCodeOf(error));
    }
    if (stored.status === 'failed') {
      console.error('[meetings-sales-insight] run failed: AI_STOPPED');
      return empty('paused', 'AI_STOPPED');
    }
    return {
      state: totalItems > 0 ? 'ready' : 'none',
      errorCode: null,
      deal: dealMeta,
      customerTalkShare,
      concerns: answer.concerns,
      buyingSignals: answer.buyingSignals,
      nextSteps: answer.nextSteps,
      dropped: answer.dropped,
    };
  } finally {
    ticket.release();
  }
}

// The recorder's Vy listing what one meeting left open, the questions asked and not answered and the decisions raised and not taken (#4768, ADR-0049 stage A): the title's run, with an answer that goes to the browser and nowhere else:
//   1. meetings.open_points.status, as the recorder: the deployment's switch and the recorder; a refusal here has made no run and spent nothing;
//   2. a draft-budget ticket, then meetings.open_points.start, whose run.start checks vy.use, the kill switches and the budget before any call (a spent budget is refused here, with no call made);
//   3. the transcript, read as the recorder, and the one model call outside any transaction under the member's own meter (meetings.open_points), with a hard timeout. The model has no tools: the checks in code
//      (packages/agent member-vy/meeting-open-points.ts) decide what shows, and an empty or unusable answer is "no suggestion";
//   4. the run's result row is stored with COUNTS ONLY (questions, decisions, dropped), never a line, with kernel.member_vy.result.store in the member's own session.
// The lines go back to the browser and nowhere else: no result row, task, mail, search hit or export holds one, and neither the transcript nor a line is ever logged (a failure is named by a
// fixed code). Nothing is published and no task is made from here.
export async function runMeetingOpenPoints(deps: MeetingSummaryDeps, orgId: string, actor: UserActor, meetingId: string): Promise<OpenPointsAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
  const none = (dropped = 0): OpenPointsAnswer => ({ state: 'none', errorCode: null, questions: [], decisions: [], dropped });
  const failed = (errorCode: string): OpenPointsAnswer => ({ state: 'failed', errorCode, questions: [], decisions: [], dropped: 0 });
  const allowed = await deps.runtime.query<{ enabled: boolean; reason: 'off' | 'not_recorder' | null }>('meetings.open_points.status', { meetingId }, as);
  if (!allowed.enabled) {
    if (allowed.reason === 'not_recorder') throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy what the meeting left open');
    throw new DomainError('SUMMARY_OFF', 422, 'Vy is not turned on here');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('OPEN_POINTS_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // The checks come first: the switch, vy.use, the kill switches (the member's own Vy's included) and the budget. A refusal here has made no run and no call.
    let started: { meetingId: string; runId: string };
    try {
      started = await deps.runtime.execute<{ meetingId: string; runId: string }>('meetings.open_points.start', { meetingId }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'OPEN_POINTS_BUSY' : error.code;
        console.error(`[meetings-open-points] run not started: ${errorCode}`);
        return failed(errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<OpenPointsAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-open-points] failed result not stored: ${openPointsCodeOf(storeError)}`);
      }
      console.error(`[meetings-open-points] run failed: ${errorCode}`);
      return failed(errorCode);
    };
    let answer: { questions: OpenPointsAnswer['questions']; decisions: OpenPointsAnswer['decisions']; dropped: number };
    try {
      const transcript = await deps.runtime.query<Transcript>('meetings.transcript.get', { meetingId }, as);
      const meeting = await deps.runtime.query<{ language: 'vi' | 'en' }>('meetings.meeting.get', { meetingId }, as);
      const segments = transcript.segments.map((s) => ({ startSeconds: s.startSeconds, endSeconds: s.endSeconds, speakerLabel: s.speakerLabel, text: s.text }));
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, { model, memory: nothingToRemember, knowledge: noKnowledge });
      answer = (await withDeadline(withAiScope({ orgId, memberRunId: runId, meter }, () => listOpenPoints({ segments, language: meeting.language }, bound)), timeoutMs)).answer;
    } catch (error: unknown) {
      // An answer with no line left, or none that could be read, is "no suggestion", not a failure of the service; the run's result still says which.
      if (error instanceof OpenPointsError && error.code === 'OPEN_POINTS_UNPARSABLE') {
        await fail('OPEN_POINTS_UNPARSABLE');
        return none();
      }
      if (error instanceof OpenPointsError && error.code === 'OPEN_POINTS_EMPTY') {
        try {
          await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, questions: 0, decisions: 0, dropped: 0 }) } }, as);
        } catch (storeError: unknown) {
          console.error(`[meetings-open-points] result not stored: ${openPointsCodeOf(storeError)}`);
        }
        return none();
      }
      return await fail(openPointsCodeOf(error));
    }
    // Counts only: never a line.
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, questions: answer.questions.length, decisions: answer.decisions.length, dropped: answer.dropped }) } }, as);
    } catch (error: unknown) {
      // The run ended while the model was answering (the member cancelled it, a switch stopped it): the text is not shown.
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return failed('AI_STOPPED');
      return await fail(openPointsCodeOf(error));
    }
    // The kernel re-checked the switches and the budget at the store and may have stopped the run: its answer is the state, and nothing of the model's text is shown for a stopped run.
    if (stored.status === 'failed') {
      console.error('[meetings-open-points] run failed: AI_STOPPED');
      return failed('AI_STOPPED');
    }
    return { state: 'listed', errorCode: null, questions: answer.questions, decisions: answer.decisions, dropped: answer.dropped };
  } finally {
    ticket.release();
  }
}

export async function followupNoteStatusOf(
  deps: Pick<MeetingSummaryDeps, 'runtime' | 'model' | 'meter'>,
  orgId: string,
  actor: UserActor,
  meetingId: string,
): Promise<FollowupNoteStatus> {
  const status = await deps.runtime.query<FollowupNoteStatus>('meetings.followup.note_status', { meetingId }, { actor, orgId });
  if (status.enabled && (!deps.model || !deps.meter(actor))) {
    return { meetingId, enabled: false, reason: 'off' };
  }
  return status;
}

// The recorder's Vy drafting a personal-note follow-up email from the meeting's summary, decisions and action items (#4292, ADR-0049 stage A):
//   1. meetings.followup.note_status, as the recorder: checks recorder, deployment switch, vy.use, kill switches and budget;
//   2. a draft-budget ticket, then meetings.followup.note_start, whose run.start re-checks vy.use, kill switches and budget before any call;
//   3. the meeting's facts read as the recorder via meetings.followup.draft (audited), and one model call under meetings.followup_note with deterministic grounding/contact checks;
//   4. the run's result row stores COUNTS ONLY ({ v: 1, style: 'personal_note', paragraphs, bullets, dropped }), never prose, facts or hint.
export async function runMeetingFollowupNote(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
  input: FollowupNoteAsk,
): Promise<FollowupNoteAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  const out = (
    ai: FollowupNoteAnswer['ai'],
    errorCode: string | null = null,
    note: string | null = null,
    dropped = 0,
  ): FollowupNoteAnswer => ({ ai, errorCode, note, dropped });

  const allowed = await deps.runtime.query<FollowupNoteStatus>('meetings.followup.note_status', { meetingId: input.meetingId }, as);
  if (allowed.reason === 'not_recorder') {
    throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy for a follow-up note');
  }
  if (!model || !meter || allowed.reason === 'off') {
    return out('off', 'SUMMARY_OFF');
  }
  if (allowed.reason === 'forbidden') {
    throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
  }
  if (allowed.reason === 'paused' || allowed.reason === 'budget') {
    return out('budget', 'AI_BUDGET_EXHAUSTED');
  }

  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) {
    return out('busy', 'FOLLOWUP_NOTE_BUSY');
  }
  try {
    let started: { meetingId: string; runId: string; stage: 'published' | 'draft' };
    try {
      started = await deps.runtime.execute<{ meetingId: string; runId: string; stage: 'published' | 'draft' }>(
        'meetings.followup.note_start',
        { meetingId: input.meetingId, ...(input.stage ? { stage: input.stage } : {}) },
        as,
      );
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'FOLLOWUP_NOTE_BUSY' : error.code;
        console.error(`[meetings-followup-note] run not started: ${errorCode}`);
        return out(error.code === 'VY_RUN_BUSY' ? 'busy' : 'budget', errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<FollowupNoteAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        console.error(`[meetings-followup-note] failed result not stored: ${followupNoteCodeOf(storeError)}`);
      }
      console.error(`[meetings-followup-note] run failed: ${errorCode}`);
      return out(errorCode === 'AI_BUDGET_EXHAUSTED' ? 'budget' : 'failed', errorCode);
    };

    let answer: { body: string; paragraphs: number; bullets: number; dropped: number };
    try {
      const draft = await deps.runtime.query<FollowupDraft>(
        'meetings.followup.draft',
        { meetingId: input.meetingId, stage: started.stage },
        as,
      );
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, { model, memory: nothingToRemember, knowledge: noKnowledge });
      answer = (
        await withDeadline(
          withAiScope({ orgId, memberRunId: runId, meter }, () =>
            draftFollowupPersonalNote(
              { language: draft.lang, orgName: draft.org, facts: draft.facts, ...(input.hint ? { hint: input.hint } : {}) },
              bound,
            ),
          ),
          timeoutMs,
        )
      ).answer;
    } catch (error: unknown) {
      if (error instanceof FollowupNoteError && error.code === 'FOLLOWUP_NOTE_UNPARSABLE') {
        await fail('FOLLOWUP_NOTE_UNPARSABLE');
        return out('none', null, null, 1);
      }
      if (error instanceof FollowupNoteError && (error.code === 'FOLLOWUP_NOTE_EMPTY' || error.code === 'FOLLOWUP_NOTE_REFUSED')) {
        try {
          await deps.runtime.execute(
            'kernel.member_vy.result.store',
            { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, style: 'personal_note', paragraphs: 0, bullets: 0, dropped: 1 }) } },
            as,
          );
        } catch (storeError: unknown) {
          console.error(`[meetings-followup-note] result not stored: ${followupNoteCodeOf(storeError)}`);
        }
        return out('none', null, null, 1);
      }
      return await fail(followupNoteCodeOf(error));
    }

    // Counts only: never the prose or any meeting text.
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>(
        'kernel.member_vy.result.store',
        {
          runId,
          outcome: {
            status: 'ready',
            body: JSON.stringify({ v: 1, style: 'personal_note', paragraphs: answer.paragraphs, bullets: answer.bullets, dropped: answer.dropped }),
          },
        },
        as,
      );
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return out('failed', 'AI_STOPPED');
      return await fail(followupNoteCodeOf(error));
    }
    if (stored.status === 'failed') {
      console.error('[meetings-followup-note] run failed: AI_STOPPED');
      return out('failed', 'AI_STOPPED');
    }
    return out('used', null, answer.body, answer.dropped);
  } finally {
    ticket.release();
  }
}

// Whether the card of "update the deal" shows and Vy may be asked now (#4766): the module's own status, plus whether this deployment has a model and a meter.
export async function dealUpdateStatusOf(
  deps: Pick<MeetingSummaryDeps, 'runtime' | 'model' | 'meter'>,
  orgId: string,
  actor: UserActor,
  meetingId: string,
): Promise<DealUpdateStatus> {
  const status = await deps.runtime.query<DealUpdateStatus>('meetings.deal_update.status', { meetingId }, { actor, orgId });
  if (status.enabled && (!deps.model || !deps.meter(actor))) return { ...status, enabled: false, reason: 'off' };
  return status;
}

// What the module's facts query answers (modules/meetings/src/deal-update.ts); the route reads it as the recorder.
interface DealUpdateFactsRead {
  language: 'vi' | 'en';
  deal: { id: string; title: string; stage: string };
  minutesKey: string;
  facts: { summary: string; decisions: string[]; items: Array<{ title: string; who: string; when: string; whenDate: string | null }> };
}

// The recorder's Vy proposing the next step and a note for the deal their meeting is linked to (#4766, ADR-0049 stage A):
//   1. meetings.deal_update.status, as the recorder: recorder, a linked open deal, published minutes, deployment switch, vy.use, kill switches and budget;
//   2. a draft-budget ticket, then meetings.deal_update.start, whose run.start re-checks vy.use, kill switches and budget before any call;
//   3. the published minutes read as the recorder (audited), and one model call under meetings.deal_update; code checks the answer (the day is the action item's, never the model's);
//   4. the run's result row stores COUNTS ONLY ({ v: 1, nextStep, note, dropped }), never the proposal. Nothing is written to the deal: the recorder's confirm does that.
export async function runMeetingDealUpdate(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
  input: DealUpdateAsk,
): Promise<DealUpdateAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  const out = (
    ai: DealUpdateAnswer['ai'],
    errorCode: string | null = null,
    extra: Partial<Pick<DealUpdateAnswer, 'dealId' | 'minutesKey' | 'nextStep' | 'note' | 'dropped'>> = {},
  ): DealUpdateAnswer => ({ ai, errorCode, dealId: null, minutesKey: null, nextStep: null, note: null, dropped: 0, ...extra });

  const allowed = await deps.runtime.query<DealUpdateStatus>('meetings.deal_update.status', { meetingId: input.meetingId }, as);
  if (allowed.reason === 'not_recorder') throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy to update the deal');
  if (!allowed.available) return out('none', 'DEAL_UPDATE_UNAVAILABLE');
  if (!model || !meter || allowed.reason === 'off') return out('off', 'SUMMARY_OFF');
  if (allowed.reason === 'forbidden') throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
  if (allowed.reason === 'paused' || allowed.reason === 'budget') return out('budget', 'AI_BUDGET_EXHAUSTED');

  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) return out('busy', 'DEAL_UPDATE_BUSY');
  try {
    let started: { meetingId: string; runId: string };
    try {
      started = await deps.runtime.execute<{ meetingId: string; runId: string }>('meetings.deal_update.start', { meetingId: input.meetingId }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'DEAL_UPDATE_BUSY' : error.code;
        console.error(`[meetings-deal-update] run not started: ${errorCode}`);
        return out(error.code === 'VY_RUN_BUSY' ? 'busy' : 'budget', errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<DealUpdateAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        console.error(`[meetings-deal-update] failed result not stored: ${dealUpdateCodeOf(storeError)}`);
      }
      console.error(`[meetings-deal-update] run failed: ${errorCode}`);
      return out(errorCode === 'AI_BUDGET_EXHAUSTED' ? 'budget' : 'failed', errorCode);
    };
    const storeCounts = async (counts: { nextStep: boolean; note: boolean; dropped: number }): Promise<{ stored: boolean; status: 'ready' | 'failed' }> =>
      deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>(
        'kernel.member_vy.result.store',
        { runId, outcome: { status: 'ready', body: JSON.stringify({ v: 1, ...counts }) } },
        as,
      );

    let read: DealUpdateFactsRead & { dealId: string };
    let proposal: Awaited<ReturnType<typeof proposeDealUpdate>>['answer'];
    try {
      const facts = await deps.runtime.query<DealUpdateFactsRead>('meetings.deal_update.facts', { meetingId: input.meetingId }, as);
      read = { ...facts, dealId: facts.deal.id };
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, { model, memory: nothingToRemember, knowledge: noKnowledge });
      proposal = (
        await withDeadline(
          withAiScope({ orgId, memberRunId: runId, meter }, () =>
            proposeDealUpdate({ language: facts.language, dealTitle: facts.deal.title, stageName: facts.deal.stage, facts: facts.facts }, bound),
          ),
          timeoutMs,
        )
      ).answer;
    } catch (error: unknown) {
      if (error instanceof DealUpdateError && error.code === 'DEAL_UPDATE_UNPARSABLE') {
        await fail('DEAL_UPDATE_UNPARSABLE');
        return out('none', null, { dropped: 1 });
      }
      if (error instanceof DealUpdateError && error.code === 'DEAL_UPDATE_NO_FACTS') {
        try {
          await storeCounts({ nextStep: false, note: false, dropped: 0 });
        } catch (storeError: unknown) {
          console.error(`[meetings-deal-update] result not stored: ${dealUpdateCodeOf(storeError)}`);
        }
        return out('none');
      }
      return await fail(dealUpdateCodeOf(error));
    }

    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await storeCounts({ nextStep: proposal.nextStep !== null, note: proposal.note !== null, dropped: proposal.dropped });
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return out('failed', 'AI_STOPPED');
      return await fail(dealUpdateCodeOf(error));
    }
    if (stored.status === 'failed') {
      console.error('[meetings-deal-update] run failed: AI_STOPPED');
      return out('failed', 'AI_STOPPED');
    }
    if (proposal.nextStep === null && proposal.note === null) return out('none', null, { dropped: proposal.dropped });
    return out('used', null, {
      dealId: read.dealId,
      minutesKey: read.minutesKey,
      nextStep: proposal.nextStep === null ? null : { text: proposal.nextStep.text, dueOn: proposal.nextStep.dueOn },
      note: proposal.note,
      dropped: proposal.dropped,
    });
  } finally {
    ticket.release();
  }
}

// One outbox event for a finished run, written by the recorder's own command; the worker turns it into the notice (the API's role cannot write a notification). Only the code of a failure is logged.
async function notifySummaryReady(runtime: Runtime, as: { actor: UserActor; orgId: string }, input: { meetingId: string; runId: string }): Promise<void> {
  try {
    await runtime.execute('meetings.summary.ready', input, as);
  } catch (error: unknown) {
    console.error(`[meetings-summary] ready notice not written: ${codeOf(error)}`);
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
export function translationEstimate(bytes: number, price: MeetingTranslationDeps['price'], to?: TranslationTarget): NonNullable<TranslationStatus['estimate']> {
  const inputTokens = Math.ceil(bytes / 2.5) + 250;
  // Chinese, Japanese and Korean weigh about half as much again in tokens for the same meaning (#3186).
  const outputTokens = Math.ceil((bytes / 2.5) * (to === 'zh' || to === 'ja' || to === 'ko' ? 1.5 : 1)) + 50;
  const priced = price !== undefined && (isPositivePrice(price.inputPerMTok) || isPositivePrice(price.outputPerMTok));
  return { inputTokens, outputTokens, cost: priced ? aiCost([{ inputTokens, outputTokens }], price) : null };
}

// The button of a stage: the module's status (switch, text to translate, language pair, the size of the text) plus the expected cost. The text itself is not read here: the module says its size.
export async function translationStatusOf(deps: Pick<MeetingTranslationDeps, 'runtime' | 'price'>, orgId: string, actor: UserActor, meetingId: string, stage: 'draft' | 'published', to?: TranslationTarget): Promise<TranslationStatus> {
  const { bytes, ...status } = await deps.runtime.query<TranslationStatus & { bytes: number }>('meetings.translation.status', { meetingId, stage, ...(to ? { to } : {}) }, { actor, orgId });
  return status.enabled ? { ...status, estimate: translationEstimate(bytes, deps.price, status.to) } : status;
}

export async function runMeetingTranslation(deps: MeetingTranslationDeps, orgId: string, actor: UserActor, meetingId: string, stage: 'draft' | 'published', to?: TranslationTarget): Promise<Translated> {
  // The language asked for goes with every step below; absent, the module takes the other language of the pair (a target the deployment has not switched on is refused by the module's own status read).
  const target = to ? { to } : {};
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
  // A member who cannot translate this (the switch is off, no text, a stage they do not read) is refused here with the precise answer, before a ticket is taken (so a member cannot use up the org's
  // few translations a minute by asking about meetings they do not read).
  const allowed = await deps.runtime.query<TranslationStatus>('meetings.translation.status', { meetingId, stage, ...target }, as);
  if (!allowed.enabled) {
    if (allowed.reason === 'nothing') throw new DomainError('TRANSLATION_NOTHING', 422, 'There is no summary to translate');
    throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('SUMMARY_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // 1. The checks come first: the switch, a stage the member reads, vy.use, the kill switches and the budget. A refusal here has made no run.
    const started = await deps.runtime.execute<{ meetingId: string; runId: string }>('meetings.translate.start', { meetingId, stage, ...target }, as);
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
      // 2. The text the member reads, in their own context. Only the meeting's recorder receives the organization's glossary; non-recorder attendees stay strictly free of glossary terms.
      const source = await deps.runtime.query<TranslationSource>('meetings.translation.source', { meetingId, stage, ...target }, as);
      const meeting = await deps.runtime.query<{ isRecorder: boolean }>('meetings.meeting.get', { meetingId }, as);
      const glossary = meeting.isRecorder ? (await deps.runtime.query<{ terms: string[] }>('meetings.glossary.for_meeting', { meetingId }, as)).terms : undefined;
      // 3. The one call, outside any transaction, in the scope of this run.
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () =>
          translateSummary({ segments: source.segments, from: source.from, to: source.to, stage: source.stage, hash: source.hash, ...(glossary ? { glossary } : {}) }, bindPorts({ orgId, memberUserId: actor.userId }, ports)),
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

export async function runMeetingAsk(deps: MeetingAskDeps, orgId: string, actor: UserActor, question: string, meetingId?: string): Promise<AskAnswer> {
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
    const { lines } = await deps.runtime.query<AskLines>('meetings.ask.lines', { question, ...(meetingId ? { meetingId } : {}) }, as);
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


// The member's Vy naming who an action item belongs to, when code found nobody (#3921, step 2, ADR-0049 stage A). Step 1 works with AI off; this is the member's click on one item. In order:
//   1. meetings.assignee.status, as the member: the deployment's switch, the right to work with Vy, a kill switch, a spent budget; a refusal here has made no run and spent nothing;
//   2. meetings.assignee.facts: the said name and the people the member may give the work to, read as the member (row security), with their seats. Not eligible (the item has a person or a task, code finds a
//      person, the text is not a name, nobody to pick): no run and no call;
//   3. meetings.assignee.start, then the kernel's run.start (vy.use, the kill switches, the budget) makes the member's Vy and the run;
//   4. the one model call, outside any transaction, through the member's own meter under meetings.assignee (the scope carries the run), with a hard timeout. The model is given the said name and the numbered
//      names, no id, no title and no address, and has no tools; the answer is {"n": number} or {"n": null}, checked by code (a number off the list or a pick the said text does not support is dropped);
//   5. the result row holds counts only; the answer is the person the number named, with the seats they hold now. Nothing is stored: a person picks the seat and makes the task.
// The answer goes back to the browser and nowhere else. A name is never logged: a failure is named by a fixed code.
export async function assigneeStatusOf(deps: Pick<MeetingBriefDeps, 'runtime' | 'model' | 'meter'>, orgId: string, actor: UserActor): Promise<AssigneeStatus> {
  if (!deps.model || !deps.meter(actor)) return { enabled: false, reason: 'off', estimate: null };
  return deps.runtime.query<AssigneeStatus>('meetings.assignee.status', {}, { actor, orgId });
}

function assigneeCodeOf(error: unknown): string {
  if (error instanceof AssigneeError) return error.code;
  if (error instanceof AssigneeModelError) return error.kind === 'timeout' ? 'ASSIGNEE_TIMEOUT' : 'ASSIGNEE_FAILED';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'ASSIGNEE_FAILED' : code;
}

export async function runMeetingAssignee(deps: MeetingBriefDeps, orgId: string, actor: UserActor, ask: AssigneeAsk): Promise<AssigneeAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('ASSIGNEE_OFF', 422, 'Vy naming who an action item belongs to is not turned on here');
  const none = (): AssigneeAnswer => ({ state: 'none', errorCode: null, suggestion: null });
  const failed = (errorCode: string): AssigneeAnswer => ({ state: 'failed', errorCode, suggestion: null });
  const status = await deps.runtime.query<AssigneeStatus>('meetings.assignee.status', {}, as);
  if (!status.enabled) {
    if (status.reason === 'off') throw new DomainError('ASSIGNEE_OFF', 422, 'Vy naming who an action item belongs to is not turned on here');
    if (status.reason === 'forbidden') throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    throw new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Vy đang tạm dừng hoặc đã hết ngân sách tháng này; sổ sách và mọi việc không cần AI vẫn chạy bình thường');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('ASSIGNEE_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    const facts = await deps.runtime.query<AssigneeFacts>('meetings.assignee.facts', ask, as);
    if (!facts.eligible || facts.people.length === 0) return none();
    let started: { runId: string };
    try {
      started = await deps.runtime.execute<{ runId: string }>('meetings.assignee.start', {}, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'ASSIGNEE_BUSY' : error.code;
        console.error(`[meetings-assignee] run not started: ${errorCode}`);
        return failed(errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<AssigneeAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-assignee] failed result not stored: ${assigneeCodeOf(storeError)}`);
      }
      console.error(`[meetings-assignee] run failed: ${errorCode}`);
      return failed(errorCode);
    };
    let checked: Awaited<ReturnType<typeof pickAssignee>>['answer'];
    try {
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () => pickAssignee({ said: facts.said, people: facts.people.map((p) => p.name) }, bindPorts({ orgId, memberUserId: actor.userId }, ports))),
        timeoutMs,
      );
      checked = result.answer;
    } catch (error: unknown) {
      return await fail(error instanceof SummaryModelError ? 'ASSIGNEE_TIMEOUT' : assigneeCodeOf(error));
    }
    // Counts only: never a name.
    const body = JSON.stringify({ v: 1, people: facts.people.length, picked: checked.pick === null ? 0 : 1, dropped: checked.dropped ? 1 : 0 });
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body } }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return failed('AI_STOPPED');
      return await fail(assigneeCodeOf(error));
    }
    // The kernel re-checked the switches and the budget at the store and may have stopped the run: nothing of the model's answer is shown for a stopped run.
    if (stored.status === 'failed') {
      console.error('[meetings-assignee] run failed: AI_STOPPED');
      return failed('AI_STOPPED');
    }
    const person = checked.pick === null ? undefined : facts.people[checked.pick - 1];
    return person ? { state: 'suggested', errorCode: null, suggestion: person } : none();
  } finally {
    ticket.release();
  }
}

// The member's Vy writing the few sentences of the weekly digest across meetings (#3949, ADR-0049 stage A). The facts do not need Vy and work with AI off (meetings.digest.facts); this is the member's click. In order:
//   1. meetings.digest.status, as the member: the deployment's switch, the right to work with Vy, a kill switch, a spent budget; a refusal here has made no run and spent nothing;
//   2. meetings.digest.facts: the published decisions and open action items of the meetings the member reads in the window, all read as the member (row security). Nothing to say: no run and no call;
//   3. meetings.digest.start, then the kernel's run.start (vy.use, the kill switches, the budget) makes the member's Vy and the run;
//   4. the one model call, outside any transaction, through the member's own meter under meetings.digest (the scope carries the run), with a hard timeout. The model is given only the numbered facts and has no
//      tools; the answer is checked by code (cited facts, quotes, figures and dates written in a cited fact, no link or address);
//   5. the result row holds counts only; the answer goes back to the browser and nowhere else.
// Neither the facts nor the sentences are ever logged: a failure is named by a fixed code.
export function digestEstimate(price: MeetingBriefDeps['price']): NonNullable<DigestStatus['estimate']> {
  const priced = price !== undefined && (isPositivePrice(price.inputPerMTok) || isPositivePrice(price.outputPerMTok));
  return { ...DIGEST_ESTIMATE, cost: priced ? aiCost([DIGEST_ESTIMATE], price) : null };
}

export async function digestStatusOf(deps: Pick<MeetingBriefDeps, 'runtime' | 'price' | 'model' | 'meter'>, orgId: string, actor: UserActor): Promise<DigestStatus> {
  if (!deps.model || !deps.meter(actor)) return { enabled: false, reason: 'off', estimate: null };
  const status = await deps.runtime.query<DigestStatus>('meetings.digest.status', {}, { actor, orgId });
  return status.enabled ? { ...status, estimate: digestEstimate(deps.price) } : status;
}

function digestCodeOf(error: unknown): string {
  if (error instanceof DigestError) return error.code;
  if (error instanceof DigestModelError) return error.kind === 'timeout' ? 'DIGEST_TIMEOUT' : 'DIGEST_FAILED';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'DIGEST_FAILED' : code;
}

export async function runMeetingDigest(deps: MeetingBriefDeps, orgId: string, actor: UserActor, ask: DigestAsk): Promise<DigestAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('DIGEST_OFF', 422, 'Vy writing the weekly recap is not turned on here');
  // `count` is how many numbered facts the answer rests on, so the card can tell when its own numbering has gone stale.
  let count = 0;
  const none = (dropped = 0): DigestAnswer => ({ state: 'none', errorCode: null, sentences: [], dropped, lines: count });
  const failed = (errorCode: string): DigestAnswer => ({ state: 'failed', errorCode, sentences: [], dropped: 0, lines: count });
  const status = await deps.runtime.query<DigestStatus>('meetings.digest.status', {}, as);
  if (!status.enabled) {
    if (status.reason === 'off') throw new DomainError('DIGEST_OFF', 422, 'Vy writing the weekly recap is not turned on here');
    if (status.reason === 'forbidden') throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    throw new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Vy đang tạm dừng hoặc đã hết ngân sách tháng này; sổ sách và mọi việc không cần AI vẫn chạy bình thường');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('DIGEST_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    const facts = await deps.runtime.query<DigestFacts>('meetings.digest.facts', ask, as);
    const lines = digestLines(facts);
    count = lines.length;
    if (facts.empty || lines.length === 0) return none();
    let started: { runId: string };
    try {
      started = await deps.runtime.execute<{ runId: string }>('meetings.digest.start', {}, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'DIGEST_BUSY' : error.code;
        console.error(`[meetings-digest] run not started: ${errorCode}`);
        return failed(errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<DigestAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-digest] failed result not stored: ${digestCodeOf(storeError)}`);
      }
      console.error(`[meetings-digest] run failed: ${errorCode}`);
      return failed(errorCode);
    };
    let checked: Awaited<ReturnType<typeof writeDigest>>['answer'];
    try {
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () => writeDigest({ facts: lines.map((l) => ({ kind: l.kind, text: l.text, meeting: l.meeting, date: l.date })) }, bindPorts({ orgId, memberUserId: actor.userId }, ports))),
        timeoutMs,
      );
      checked = result.answer;
    } catch (error: unknown) {
      return await fail(error instanceof SummaryModelError ? 'DIGEST_TIMEOUT' : digestCodeOf(error));
    }
    const sentences = checked.sentences.map((s) => ({ text: s.text, facts: s.cites }));
    // Counts only: never a fact or a sentence.
    const body = JSON.stringify({ v: 1, facts: lines.length, sentences: sentences.length, dropped: checked.dropped });
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body } }, as);
    } catch (error: unknown) {
      // The run ended while the model was answering (the member cancelled it, a switch stopped it): the text is not shown, and the member keeps the facts lists.
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return failed('AI_STOPPED');
      return await fail(digestCodeOf(error));
    }
    // The kernel re-checked the switches and the budget at the store and may have stopped the run: nothing of the model's text is shown for a stopped run.
    if (stored.status === 'failed') {
      console.error('[meetings-digest] run failed: AI_STOPPED');
      return failed('AI_STOPPED');
    }
    return sentences.length === 0 ? none(checked.dropped) : { state: 'written', errorCode: null, sentences, dropped: checked.dropped, lines: count };
  } finally {
    ticket.release();
  }
}

// The recorder's Vy checking whether a meeting covered its agenda (#3959, ADR-0049 stage A). The agenda is the series' open items plus up to eight lines the recorder typed; the transcript is the one the recorder
// reads. In order:
//   1. meetings.adherence.status, as the recorder: the deployment's switch, the right to work with Vy, a kill switch, a spent budget; a refusal here has made no run and spent nothing;
//   2. meetings.adherence.facts: the agenda lines and the numbered transcript lines, read as the recorder (row security). Nothing to ask (no agenda line, no transcript, a transcript longer than the model is
//      given): no run and no call, and the answer says why;
//   3. meetings.adherence.start, then the kernel's run.start (vy.use, the kill switches, the budget) makes the member's Vy and the run;
//   4. the one model call, outside any transaction, through the member's own meter under meetings.adherence (the scope carries the run), with a hard timeout. The model has no tools and answers numbers only;
//      code keeps a "covered" claim only when it cites one to three transcript lines that were given (see member-vy/meetings-adherence.ts);
//   5. the result row holds counts only; the answer is the agenda lines as given and, for a covered one, the transcript lines it cites, as the recorder reads them. Nothing is stored and nothing of the model's words
//      is shown.
// The answer goes back to the browser and nowhere else. An agenda or transcript line is never logged: a failure is named by a fixed code.
function adherenceEstimate(price: MeetingBriefDeps['price']): NonNullable<AdherenceStatus['estimate']> {
  const priced = price !== undefined && (isPositivePrice(price.inputPerMTok) || isPositivePrice(price.outputPerMTok));
  return { ...ADHERENCE_ESTIMATE, cost: priced ? aiCost([ADHERENCE_ESTIMATE], price) : null };
}

export async function adherenceStatusOf(deps: Pick<MeetingBriefDeps, 'runtime' | 'price' | 'model' | 'meter'>, orgId: string, actor: UserActor, meetingId: string): Promise<AdherenceStatus> {
  if (!deps.model || !deps.meter(actor)) return { meetingId, enabled: false, reason: 'off', estimate: null };
  const status = await deps.runtime.query<AdherenceStatus>('meetings.adherence.status', { meetingId }, { actor, orgId });
  return status.enabled ? { ...status, estimate: adherenceEstimate(deps.price) } : status;
}

function adherenceCodeOf(error: unknown): string {
  if (error instanceof AdherenceError) return error.code;
  if (error instanceof AdherenceModelError) return error.kind === 'timeout' ? 'ADHERENCE_TIMEOUT' : 'ADHERENCE_FAILED';
  const code = codeOf(error);
  return code === 'SUMMARY_FAILED' || code === 'SUMMARY_TIMEOUT' ? 'ADHERENCE_FAILED' : code;
}

export async function runMeetingAdherence(deps: MeetingBriefDeps, orgId: string, actor: UserActor, ask: AdherenceAsk): Promise<AdherenceAnswer> {
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('ADHERENCE_OFF', 422, 'Vy checking an agenda is not turned on here');
  const failed = (errorCode: string): AdherenceAnswer => ({ state: 'failed', errorCode, reason: null, items: [], dropped: 0 });
  const status = await deps.runtime.query<AdherenceStatus>('meetings.adherence.status', { meetingId: ask.meetingId }, as);
  if (!status.enabled) {
    if (status.reason === 'off') throw new DomainError('ADHERENCE_OFF', 422, 'Vy checking an agenda is not turned on here');
    if (status.reason === 'not_recorder') throw new DomainError('FORBIDDEN', 403, 'Only the meeting recorder can ask Vy to check its agenda');
    if (status.reason === 'forbidden') throw new DomainError('VY_NOT_ALLOWED', 403, 'Bạn chưa được phép làm việc với Vy');
    throw new DomainError('AI_BUDGET_EXHAUSTED', 422, 'Vy đang tạm dừng hoặc đã hết ngân sách tháng này; sổ sách và mọi việc không cần AI vẫn chạy bình thường');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('ADHERENCE_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    const facts = await deps.runtime.query<AdherenceFacts>('meetings.adherence.facts', ask, as);
    if (!facts.eligible) return { state: 'none', errorCode: null, reason: facts.reason, items: [], dropped: 0 };
    let started: { runId: string };
    try {
      started = await deps.runtime.execute<{ runId: string }>('meetings.adherence.start', { meetingId: ask.meetingId }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'ADHERENCE_BUSY' : error.code;
        console.error(`[meetings-adherence] run not started: ${errorCode}`);
        return failed(errorCode);
      }
      throw error;
    }
    const runId = started.runId;
    const fail = async (errorCode: string): Promise<AdherenceAnswer> => {
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, as);
      } catch (storeError: unknown) {
        // The run stays open until it expires; the caller still gets the failure, and only the codes are logged.
        console.error(`[meetings-adherence] failed result not stored: ${adherenceCodeOf(storeError)}`);
      }
      console.error(`[meetings-adherence] run failed: ${errorCode}`);
      return failed(errorCode);
    };
    let checked: Awaited<ReturnType<typeof checkAgenda>>['answer'];
    try {
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const result = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter }, () =>
          checkAgenda({ agenda: facts.agenda.map((a) => a.text), transcript: facts.transcript.map((l) => ({ startSeconds: l.startSeconds, text: l.text })) }, bindPorts({ orgId, memberUserId: actor.userId }, ports)),
        ),
        timeoutMs,
      );
      checked = result.answer;
    } catch (error: unknown) {
      return await fail(error instanceof SummaryModelError ? 'ADHERENCE_TIMEOUT' : adherenceCodeOf(error));
    }
    // Counts only: never an agenda line or a transcript line.
    const body = JSON.stringify({ v: 1, agenda: facts.agenda.length, transcript: facts.transcript.length, covered: checked.items.filter((i) => i.covered).length, dropped: checked.dropped });
    let stored: { stored: boolean; status: 'ready' | 'failed' };
    try {
      stored = await deps.runtime.execute<{ stored: boolean; status: 'ready' | 'failed' }>('kernel.member_vy.result.store', { runId, outcome: { status: 'ready', body } }, as);
    } catch (error: unknown) {
      if (error instanceof DomainError && error.code === 'VY_RUN_NOT_LIVE') return failed('AI_STOPPED');
      return await fail(adherenceCodeOf(error));
    }
    // The kernel re-checked the switches and the budget at the store and may have stopped the run: nothing of the model's answer is shown for a stopped run.
    if (stored.status === 'failed') {
      console.error('[meetings-adherence] run failed: AI_STOPPED');
      return failed('AI_STOPPED');
    }
    const items: AdherenceAnswer['items'] = facts.agenda.map((line) => {
      const found = checked.items[line.n - 1];
      const cites = (found?.covered ? found.lines : []).flatMap((n) => {
        const cited = facts.transcript[n - 1];
        return cited ? [{ n, startSeconds: cited.startSeconds, text: cited.text }] : [];
      });
      return { n: line.n, text: line.text, source: line.source, covered: cites.length > 0, cites };
    });
    return { state: 'checked', errorCode: null, reason: null, items, dropped: checked.dropped };
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
  to?: TranslationTarget,
): Promise<TranscriptTranslationStatus> {
  const { bytes, ...status } = await deps.runtime.query<TranscriptTranslationStatus & { bytes: number }>('meetings.translation.transcript_status', { meetingId, ...(to ? { to } : {}) }, { actor, orgId });
  if (!deps.hasModel && status.enabled) return { ...status, enabled: false, reason: 'off', estimate: null };
  if (!status.enabled || status.remaining === 0) return status;
  const calls = Math.max(1, status.chunksTotal - status.chunksDone);
  // The same figure a chunk is admitted on before its call, for as many chunks as are left (each is a call of its own, with the fixed instruction around it).
  const perChunk = chunkExpectedUsage(Math.ceil(bytes / calls), status.to);
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

export async function runTranscriptTranslation(deps: TranscriptTranslationDeps, orgId: string, actor: UserActor, meetingId: string, to?: TranslationTarget): Promise<TranscriptTranslated> {
  const target = to ? { to } : {};
  const as = { actor, orgId };
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  const model = deps.model;
  const meter = deps.meter(actor);
  if (!model || !meter) throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
  // A member who cannot translate this (the switch is off, no transcript they read) is refused with the precise answer before a ticket is taken (so a member cannot use up the org's few
  // requests a minute by asking about meetings they do not read).
  const allowed = await deps.runtime.query<TranscriptTranslationStatus & { bytes: number }>('meetings.translation.transcript_status', { meetingId, ...target }, as);
  if (!allowed.enabled) {
    if (allowed.reason === 'nothing') throw new DomainError('TRANSLATION_NOTHING', 422, 'There is no transcript to translate');
    throw new DomainError('TRANSLATE_OFF', 422, 'Translation by Vy is not turned on here');
  }
  const ticket = deps.budget.take(orgId, actor.userId);
  if (!ticket.allowed) throw new DomainError('SUMMARY_BUSY', 429, 'Vy is busy; try again in a few minutes', { retryAfterSeconds: ticket.retryAfterSeconds });
  try {
    // 1. The checks come first. A refusal here has made no run.
    const started = await deps.runtime.execute<TranscriptStarted>('meetings.translation.transcript_start', { meetingId, ...target }, as);
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
      // 2. The text the member reads, in their own context. Only the meeting's recorder receives the organization's glossary; non-recorder attendees stay strictly free of glossary terms.
      const source = await deps.runtime.query<TranscriptSource>('meetings.translation.transcript_source', { meetingId, lineIds: started.lineIds }, as);
      if (source.lines.length === 0) return await fail('TRANSLATION_STALE');
      const meeting = await deps.runtime.query<{ isRecorder: boolean }>('meetings.meeting.get', { meetingId }, as);
      const glossary = meeting.isRecorder ? (await deps.runtime.query<{ terms: string[] }>('meetings.glossary.for_meeting', { meetingId }, as)).terms : undefined;
      // 3. Each chunk behind the meter, in the scope of this run; a refused or failed chunk after the first keeps the ones finished.
      const ports: Ports = { model, memory: nothingToRemember, knowledge: noKnowledge };
      const bound = bindPorts({ orgId, memberUserId: actor.userId }, ports);
      for (const lines of planTranscriptChunks(source.lines)) {
        try {
          const done = await withDeadline(
            withAiScope({ orgId, memberRunId: runId, meter }, () => translateTranscriptChunk({ lines, from: started.from, to: started.to, ...(glossary ? { glossary } : {}) }, bound)),
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
    const after = await deps.runtime.query<TranscriptTranslationStatus & { bytes: number }>('meetings.translation.transcript_status', { meetingId, ...target }, as);
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
    // Check deployment-level module registration (LUDY_MODULES) before Runtime.query to avoid QUERY_NOT_FOUND.
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

async function preflightNotesVyGate(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
): Promise<{
  as: { actor: UserActor; orgId: string };
  model: ModelPort;
  meter: AiMeter;
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

  return { as, model, meter, release: ticket.release };
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
  const gate = await preflightNotesVyGate(deps, orgId, actor);
  try {
    const note = await deps.runtime.query<Note>('notes.note.get', { noteId }, gate.as);
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
    return { ...gate, note };
  } catch (error) {
    gate.release();
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

// Member-scoped Vy daily focus planner & overdue reschedule proposals for My Work (Notes v2 T4b, #3563, ADR-0049):
// reads only caller's own open to-dos via notes.vy.plan_inputs, runs pure model outside transaction, stores counts
// only in member_vy_result, re-verifies items before returning, and never mutates personal to-do rows during generation.
export async function runNotesTodoPlan(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
  input: TodoPlanInput,
): Promise<TodoPlanResult> {
  const timeoutMs = deps.timeoutMs ?? NOTE_AI_TIMEOUT_MS;
  const ctx = await preflightNotesVyGate(deps, orgId, actor);
  try {
    const planQuery = input.timeZone ? { timeZone: input.timeZone } : {};
    const initial = await deps.runtime.query<{ today: string; todos: TodoPlanInputItem[] }>('notes.vy.plan_inputs', planQuery, ctx.as);
    const failed = (runId: string | null, errorCode: string): TodoPlanResult => ({
      state: 'failed',
      runId,
      today: initial.today,
      focus: [],
      reschedules: [],
      dropped: 0,
      errorCode,
    });
    if (initial.todos.length === 0) {
      return {
        state: 'ready',
        runId: null,
        today: initial.today,
        focus: [],
        reschedules: [],
        dropped: 0,
        errorCode: null,
      };
    }

    let runId: string;
    try {
      const started = await deps.runtime.execute<{ runId: string }>(
        'kernel.member_vy.run.start',
        { feature: 'notes.todo_plan', subjectType: 'member', subjectId: actor.userId },
        ctx.as,
      );
      runId = started.runId;
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'AI_BUSY' : error.code;
        console.error(`[notes-todo-plan] run not started: ${errorCode}`);
        return failed(null, errorCode);
      }
      throw error;
    }

    const ports = bindPorts(
      { orgId, memberUserId: actor.userId },
      { model: ctx.model, memory: nothingToRemember, knowledge: noKnowledge },
    );
    let plan: Awaited<ReturnType<typeof planTodosForToday>>;
    try {
      plan = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter: ctx.meter }, () =>
          planTodosForToday(
            { todos: initial.todos, today: initial.today, language: input.language ?? 'vi' },
            ports,
          ),
        ),
        timeoutMs,
      );
    } catch (error: unknown) {
      const errorCode = notesAiCodeOf(error);
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, ctx.as);
      } catch (storeError: unknown) {
        console.error(`[notes-todo-plan] failed result not stored: ${notesAiCodeOf(storeError)}`);
      }
      console.error(`[notes-todo-plan] run failed: ${errorCode}`);
      return failed(runId, errorCode);
    }

    // Re-verify caller's open to-dos and revisions before returning (guards TOCTOU deletes/completions mid-run).
    let latest: { today: string; todos: TodoPlanInputItem[] };
    try {
      latest = await deps.runtime.query<{ today: string; todos: TodoPlanInputItem[] }>('notes.vy.plan_inputs', planQuery, ctx.as);
    } catch (error: unknown) {
      const errorCode = error instanceof DomainError ? error.code : notesAiCodeOf(error);
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, ctx.as);
      } catch (storeError: unknown) {
        console.error(`[notes-todo-plan] failed result not stored: ${notesAiCodeOf(storeError)}`);
      }
      throw error;
    }
    const latestById = new Map(latest.todos.map((t) => [t.id, t]));
    let extraDropped = 0;

    const focus: TodoPlanFocusItem[] = [];
    for (const item of plan.focus) {
      const live = latestById.get(item.todoId);
      if (!live) {
        extraDropped += 1;
        continue;
      }
      focus.push({
        todoId: live.id,
        title: live.title,
        priority: live.priority,
        dueOn: live.dueOn,
        dueTime: live.dueTime,
        overdue: live.overdue,
        reason: item.reason,
        revision: live.revision,
      });
    }

    const reschedules: TodoPlanRescheduleItem[] = [];
    for (const item of plan.reschedules) {
      const live = latestById.get(item.todoId);
      if (!live || (!live.overdue && live.group !== 'overdue' && (live.dueOn === null || live.dueOn >= latest.today)) || item.dueOn < latest.today || item.dueOn === live.dueOn) {
        extraDropped += 1;
        continue;
      }
      reschedules.push({
        todoId: live.id,
        title: live.title,
        currentDueOn: live.dueOn,
        dueOn: item.dueOn,
        reason: item.reason,
        revision: live.revision,
      });
    }

    const totalDropped = plan.dropped + extraDropped;
    // Store counts only in member_vy_result (never plaintext titles or details).
    const bodyJson = JSON.stringify({
      v: 1,
      inputTodos: initial.todos.length,
      focus: focus.length,
      reschedules: reschedules.length,
      dropped: totalDropped,
    });
    const stoppedCode = await storeNotesVyReady(deps, ctx.as, 'notes-todo-plan', runId, bodyJson, 1);
    if (stoppedCode !== null) return failed(runId, stoppedCode);

    return {
      state: 'ready',
      runId,
      today: latest.today,
      focus,
      reschedules,
      dropped: totalDropped,
      errorCode: null,
    };
  } finally {
    ctx.release();
  }
}

// Member-scoped Vy inbox organizer proposing notebooks & #tags for unfiled notes (Notes v2 E5b, #3563, ADR-0049):
// reads only caller-editable unfiled notes & readable notebooks, checks org-note/private-notebook constraint,
// stores counts only in member_vy_result, re-verifies items before returning, and never mutates notes during generation.
export async function runNotesOrganize(
  deps: MeetingSummaryDeps,
  orgId: string,
  actor: UserActor,
  input: NoteOrganizeInput,
): Promise<NoteOrganizeResult> {
  const timeoutMs = deps.timeoutMs ?? NOTE_AI_TIMEOUT_MS;
  const ctx = await preflightNotesVyGate(deps, orgId, actor);
  try {
    const initial = await deps.runtime.query<{
      notes: NoteOrganizeInputNote[];
      notebooks: NoteOrganizeInputNotebook[];
    }>('notes.vy.organize_inputs', {}, ctx.as);
    const failed = (runId: string | null, errorCode: string): NoteOrganizeResult => ({
      state: 'failed',
      runId,
      suggestions: [],
      dropped: 0,
      errorCode,
    });
    if (initial.notes.length === 0) {
      return { state: 'ready', runId: null, suggestions: [], dropped: 0, errorCode: null };
    }

    let runId: string;
    try {
      const started = await deps.runtime.execute<{ runId: string }>(
        'kernel.member_vy.run.start',
        { feature: 'notes.organize', subjectType: 'member', subjectId: actor.userId },
        ctx.as,
      );
      runId = started.runId;
    } catch (error: unknown) {
      if (error instanceof DomainError && (error.code === 'AI_BUDGET_EXHAUSTED' || error.code === 'VY_RUN_BUSY')) {
        const errorCode = error.code === 'VY_RUN_BUSY' ? 'AI_BUSY' : error.code;
        console.error(`[notes-organize] run not started: ${errorCode}`);
        return failed(null, errorCode);
      }
      throw error;
    }

    const ports = bindPorts(
      { orgId, memberUserId: actor.userId },
      { model: ctx.model, memory: nothingToRemember, knowledge: noKnowledge },
    );
    let organized: Awaited<ReturnType<typeof organizeUnfiledNotes>>;
    try {
      organized = await withDeadline(
        withAiScope({ orgId, memberRunId: runId, meter: ctx.meter }, () =>
          organizeUnfiledNotes(
            { notes: initial.notes, notebooks: initial.notebooks, language: input.language ?? 'vi' },
            ports,
          ),
        ),
        timeoutMs,
      );
    } catch (error: unknown) {
      const errorCode = notesAiCodeOf(error);
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, ctx.as);
      } catch (storeError: unknown) {
        console.error(`[notes-organize] failed result not stored: ${notesAiCodeOf(storeError)}`);
      }
      console.error(`[notes-organize] run failed: ${errorCode}`);
      return failed(runId, errorCode);
    }

    let latest: { notes: NoteOrganizeInputNote[]; notebooks: NoteOrganizeInputNotebook[] };
    try {
      latest = await deps.runtime.query<{
        notes: NoteOrganizeInputNote[];
        notebooks: NoteOrganizeInputNotebook[];
      }>('notes.vy.organize_inputs', {}, ctx.as);
    } catch (error: unknown) {
      const errorCode = error instanceof DomainError ? error.code : notesAiCodeOf(error);
      try {
        await deps.runtime.execute('kernel.member_vy.result.store', { runId, outcome: { status: 'failed', errorCode } }, ctx.as);
      } catch (storeError: unknown) {
        console.error(`[notes-organize] failed result not stored: ${notesAiCodeOf(storeError)}`);
      }
      throw error;
    }

    const noteById = new Map(latest.notes.map((n) => [n.id, n]));
    const notebookById = new Map(latest.notebooks.map((b) => [b.id, b]));
    let extraDropped = 0;

    const suggestions: NoteOrganizeSuggestion[] = [];
    for (const item of organized.suggestions) {
      const liveNote = noteById.get(item.noteId);
      if (!liveNote) {
        extraDropped += 1;
        continue;
      }
      const liveNb = item.notebookId ? notebookById.get(item.notebookId) : undefined;
      const validNotebook =
        liveNb && !(liveNote.visibility === 'org' && liveNb.visibility !== 'org') ? liveNb : null;
      if (item.notebookId && !validNotebook) extraDropped += 1;

      const existingSet = new Set(liveNote.tags.map((t) => t.trim().toLowerCase()));
      const tags = liveNote.canEditTags
        ? item.tags.filter((tag) => !existingSet.has(tag.trim().toLowerCase())).slice(0, Math.max(0, 20 - existingSet.size))
        : [];
      if (item.tags.length > tags.length) extraDropped += item.tags.length - tags.length;

      if (!validNotebook && tags.length === 0) {
        extraDropped += 1;
        continue;
      }

      suggestions.push({
        noteId: liveNote.id,
        title: liveNote.title,
        visibility: liveNote.visibility,
        revision: liveNote.revision,
        existingTags: [...liveNote.tags],
        notebookId: validNotebook?.id ?? null,
        notebookName: validNotebook?.name ?? null,
        tags,
        reason: item.reason,
        canEditTags: liveNote.canEditTags,
      });
    }

    const totalDropped = organized.dropped + extraDropped;
    // Store counts only in member_vy_result (never note titles, bodies, or tags).
    const bodyJson = JSON.stringify({
      v: 1,
      inputNotes: initial.notes.length,
      suggestions: suggestions.length,
      dropped: totalDropped,
    });
    const stoppedCode = await storeNotesVyReady(deps, ctx.as, 'notes-organize', runId, bodyJson, 1);
    if (stoppedCode !== null) return failed(runId, stoppedCode);

    return {
      state: 'ready',
      runId,
      suggestions,
      dropped: totalDropped,
      errorCode: null,
    };
  } finally {
    ctx.release();
  }
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
