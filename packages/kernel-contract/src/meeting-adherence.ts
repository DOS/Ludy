// SPDX-License-Identifier: AGPL-3.0-only
// Agenda adherence, "did the meeting cover what it was meant to" (#3959, candidate 5 of #932). After a meeting with a transcript the recorder may click once and have their own Vy compare the agenda with the
// transcript. The agenda is the open items of the series as of the previous meeting (the same list the brief shows) plus up to eight lines the recorder types in the dialog.
//
// The FACTS are read by code, as the recorder: the agenda lines and the transcript lines, both numbered. The model answers, per agenda line, covered or not, and for a covered one the numbers of the transcript
// lines that show it. Code decides what shows: a "covered" claim with no valid line is dropped to "not heard", and the page shows the agenda line as it was given and the transcript lines it cites (the words
// and the time), never a sentence the model wrote. There is no score, no percentage and nothing about a person. Nothing is stored: the answer is page state, and the run's result row holds counts only.
// This file holds the shapes and the limits both sides use. No model call, database or network access here.
import { z } from 'zod';
import { zId } from './schemas.ts';

// The lines the recorder may type, and the whole agenda: the typed lines first (they are what the recorder meant), then the open items, cut at the total.
export const ADHERENCE_TYPED_MAX = 8;
export const ADHERENCE_AGENDA_MAX = 12;
export const ADHERENCE_LINE_CHARS = 200;
// What the model reads of the transcript: a longer one is refused before any call, never cut (a cut transcript would make "not heard" false).
export const ADHERENCE_TRANSCRIPT_LINES_MAX = 700;
export const ADHERENCE_TRANSCRIPT_BYTES_MAX = 120_000;
export const ADHERENCE_TRANSCRIPT_LINE_CHARS = 400;
// The most transcript lines one agenda line may cite.
export const ADHERENCE_CITES_MAX = 3;
// What one check is expected to use (the instruction, up to 12 short agenda lines and up to 120 KB of transcript, a short JSON answer), for the cost shown before the click. An estimate, not a promise.
export const ADHERENCE_ESTIMATE = { inputTokens: 30_000, outputTokens: 400 } as const;

export const zAdherenceRef = z.strictObject({ meetingId: zId });
// One typed agenda line: trimmed, one to 200 characters.
export const zAdherenceTyped = z.string().trim().min(1).max(ADHERENCE_LINE_CHARS);
export const zAdherenceAsk = z.strictObject({ meetingId: zId, typed: z.array(zAdherenceTyped).max(ADHERENCE_TYPED_MAX).default([]) });
export type AdherenceAsk = z.infer<typeof zAdherenceAsk>;

export const ADHERENCE_SOURCES = ['typed', 'open_item'] as const;
export const zAdherenceAgendaLine = z.strictObject({ n: z.number().int().min(1).max(ADHERENCE_AGENDA_MAX), text: z.string().min(1).max(ADHERENCE_LINE_CHARS), source: z.enum(ADHERENCE_SOURCES) });
export type AdherenceAgendaLine = z.infer<typeof zAdherenceAgendaLine>;

// What the recorder sees before clicking: the open items of the series that would be the agenda (the previous meeting's, as the brief reads them) and whether there is a transcript to check against. It works
// with AI off. `previous` is the previous meeting of the series when the recorder reads it, else null.
export const zAdherenceAgenda = z.strictObject({
  meetingId: zId,
  previous: z.strictObject({ meetingId: zId, title: z.string(), startedAt: z.string() }).nullable(),
  items: z.array(z.strictObject({ text: z.string().min(1).max(ADHERENCE_LINE_CHARS) })).max(ADHERENCE_AGENDA_MAX),
  // The number of transcript lines the recorder reads, and whether the check can run on them (some, and not more than the model is given).
  transcriptLines: z.number().int().min(0),
  transcriptFits: z.boolean(),
});
export type AdherenceAgenda = z.infer<typeof zAdherenceAgenda>;

export const zAdherenceTranscriptLine = z.strictObject({ n: z.number().int().min(1).max(ADHERENCE_TRANSCRIPT_LINES_MAX), startSeconds: z.number().min(0), text: z.string().max(ADHERENCE_TRANSCRIPT_LINE_CHARS) });
export type AdherenceTranscriptLine = z.infer<typeof zAdherenceTranscriptLine>;

// What the kernel reads, as the recorder, for one check. `eligible` is false when there is nothing to ask: no agenda line, no transcript, or too long a transcript (`reason` says which).
export const ADHERENCE_REASONS = ['no_agenda', 'no_transcript', 'too_long'] as const;
export const zAdherenceFacts = z.strictObject({
  eligible: z.boolean(),
  reason: z.enum(ADHERENCE_REASONS).nullable(),
  agenda: z.array(zAdherenceAgendaLine).max(ADHERENCE_AGENDA_MAX),
  transcript: z.array(zAdherenceTranscriptLine).max(ADHERENCE_TRANSCRIPT_LINES_MAX),
});
export type AdherenceFacts = z.infer<typeof zAdherenceFacts>;

// The button: may Vy be used now for this meeting (the switches of asking across meetings, and the recorder only), the cost expected, and the reason when not.
export const zAdherenceStatus = z.strictObject({
  meetingId: zId,
  enabled: z.boolean(),
  reason: z.enum(['off', 'forbidden', 'paused', 'budget', 'not_recorder']).nullable(),
  estimate: z.strictObject({ inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), cost: z.string().regex(/^\d+(?:\.\d+)?$/).nullable() }).nullable(),
});
export type AdherenceStatus = z.infer<typeof zAdherenceStatus>;

// One agenda line with what the check found: `covered` with the transcript lines it cites (one to three, each with its time and words as the recorder reads them), or not covered with none. Every cited line is
// one the recorder read; the words are the transcript's, never the model's.
export const zAdherenceCite = z.strictObject({ n: z.number().int().min(1).max(ADHERENCE_TRANSCRIPT_LINES_MAX), startSeconds: z.number().min(0), text: z.string().max(ADHERENCE_TRANSCRIPT_LINE_CHARS) });
export type AdherenceCite = z.infer<typeof zAdherenceCite>;
export const zAdherenceItem = z
  .strictObject({
    n: z.number().int().min(1).max(ADHERENCE_AGENDA_MAX),
    text: z.string().min(1).max(ADHERENCE_LINE_CHARS),
    source: z.enum(ADHERENCE_SOURCES),
    covered: z.boolean(),
    cites: z.array(zAdherenceCite).max(ADHERENCE_CITES_MAX),
  })
  .refine((item) => item.covered === (item.cites.length > 0), { message: 'a covered line cites at least one transcript line, an uncovered one cites none' });
export type AdherenceItem = z.infer<typeof zAdherenceItem>;

// `checked`: the model answered and code kept what held up. `none`: nothing to check (no agenda line, no transcript or too long a transcript, see `reason` of the facts), no run and no call. `failed`: the call
// could not be used (a fixed code). `dropped`: how many "covered" claims code turned into "not heard" for want of a valid cited line. There is deliberately no total, score or percentage here.
export const zAdherenceAnswer = z.strictObject({
  state: z.enum(['checked', 'none', 'failed']),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  reason: z.enum(ADHERENCE_REASONS).nullable(),
  items: z.array(zAdherenceItem).max(ADHERENCE_AGENDA_MAX),
  dropped: z.number().int().min(0).max(ADHERENCE_AGENDA_MAX),
});
export type AdherenceAnswer = z.infer<typeof zAdherenceAnswer>;
