// SPDX-License-Identifier: AGPL-3.0-only
// Vy's brief before a meeting (#3543, plan docs/plan/meetings.md row L7, builds on the series of #3542). One short page for a meeting of a series that is coming up (a calendar event of the
// member's own agenda) or that the member is looking at: what was decided at the last meeting, what is still open, and where the customer stands.
//
// The FACTS are read by code, as the member (row security on every one): the decisions of the previous meeting of the series, only when the member read it; the series' open items of #3542;
// the customer linked to the meeting (or, for a meeting not yet recorded, to the previous one) and that customer's open deals with their stage, read through the CRM module's own queries. They work
// with AI off. Vy's two or three sentences are an extra on top, written from the numbered facts only, every sentence citing facts, and code refuses a sentence whose figure no cited fact writes.
//
// This file holds the shapes and the pure numbering both sides use (the model call is in packages/agent, the page in apps/app). No model call, database or network access here.
import { z } from 'zod';
import { zAskStatus } from './meeting-ask.ts';
import { zSeriesOpenItem } from './meetings.ts';
import { zId } from './schemas.ts';

export const BRIEF_DECISIONS_MAX = 8;
export const BRIEF_ITEMS_MAX = 10;
export const BRIEF_DEALS_MAX = 5;
// What goes to the model, and what it may write: two to three sentences ("Vy's two- or three-line summary").
export const BRIEF_LINES_MAX = BRIEF_DECISIONS_MAX + BRIEF_ITEMS_MAX + BRIEF_DEALS_MAX;
export const BRIEF_SENTENCES_MAX = 3;
export const BRIEF_SENTENCE_CHARS_MAX = 400;
// What one brief is expected to use (one short call over at most 23 short facts), for the cost shown before the member asks. An estimate, not a promise: the meter records what the provider reports.
export const BRIEF_ESTIMATE = { inputTokens: 1_800, outputTokens: 300 } as const;

// The page is for a meeting the member reads, or for a calendar event of their own agenda (a meeting not recorded yet): exactly one of the two.
export const zBriefTarget = z
  .strictObject({ meetingId: zId.nullable().default(null), agendaId: zId.nullable().default(null) })
  .refine((v) => (v.meetingId === null) !== (v.agendaId === null), { message: 'Give a meeting or a calendar event, not both and not neither' });
export type BriefTarget = z.infer<typeof zBriefTarget>;

// The status and the start take nothing but the deployment's switches: the same answer as for asking across meetings (whether Vy may be used now, and why not).
export const zBriefEmpty = z.strictObject({});
export const zBriefStatus = zAskStatus;
export type BriefStatus = z.infer<typeof zBriefStatus>;

export const zBriefDeal = z.strictObject({
  id: zId,
  title: z.string(),
  // The pipeline stage's name as the CRM module gives it.
  stage: z.string(),
  // A decimal string (never a JS number); null for a deal with no amount yet.
  amount: z.string().regex(/^\d+(?:\.\d+)?$/).nullable(),
  expectedClose: z.string().nullable(),
});
export type BriefDeal = z.infer<typeof zBriefDeal>;

export const zBriefFacts = z.strictObject({
  // The latest earlier meeting of the series that the caller reads, or null (no series, nothing earlier, or one the caller did not read: nothing of it, not even that it exists, is told).
  previous: z.strictObject({ meetingId: zId, title: z.string(), startedAt: z.string() }).nullable(),
  // The published decisions of that meeting.
  decisions: z.array(z.string()).max(BRIEF_DECISIONS_MAX),
  // The open items of the series (#3542): accepted ones with a task still open, and the ones nobody accepted as "chưa giao".
  items: z.array(zSeriesOpenItem).max(BRIEF_ITEMS_MAX),
  // The customer linked to the meeting, else to the previous meeting of the series, and their open deals (none when the deployment has no CRM module).
  customer: z.strictObject({ partyId: zId, name: z.string() }).nullable(),
  deals: z.array(zBriefDeal).max(BRIEF_DEALS_MAX),
  // Nothing to say: no decision, no open item and no open deal. The page then shows no brief at all.
  empty: z.boolean(),
});
export type BriefFacts = z.infer<typeof zBriefFacts>;

// The state of Vy's words: `written` (at least one sentence kept), `none` (nothing to write from, or no sentence held up), `failed` (the call could not be used, a fixed code).
export const BRIEF_STATES = ['written', 'none', 'failed'] as const;
export const zBriefSentence = z.strictObject({
  text: z.string().min(1).max(BRIEF_SENTENCE_CHARS_MAX),
  // The numbers (from 1) of the facts the sentence cites, as `briefLines` numbers them.
  facts: z.array(z.number().int().min(1).max(BRIEF_LINES_MAX)).min(1).max(6),
});
export type BriefSentence = z.infer<typeof zBriefSentence>;
export const zBriefAnswer = z.strictObject({
  state: z.enum(BRIEF_STATES),
  errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
  sentences: z.array(zBriefSentence).max(BRIEF_SENTENCES_MAX),
  // How many sentences code removed for want of a valid citation, a quoted phrase or a figure the cited facts hold.
  dropped: z.number().int().min(0).max(100),
});
export type BriefAnswer = z.infer<typeof zBriefAnswer>;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// The numbered facts
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

// Where a fact comes from, so the page can link to it: the previous meeting (a decision or an item) or a deal.
export type BriefSource = { type: 'meeting'; id: string } | { type: 'deal'; id: string };
export interface BriefLine {
  // Counting from 1: the number a sentence cites.
  n: number;
  kind: 'decision' | 'item' | 'deal';
  // The fact as the model is given it (English words around the data, which stays as people wrote it).
  text: string;
  source: BriefSource;
}

const TEXT_CHARS = 300;
const oneLine = (value: string, max: number): string => Array.from(value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, ' ').trim()).slice(0, max).join('');
// A decimal string with the integer part grouped by dots, the way amounts are written here ("15.000.000"); a fraction of zeros is dropped and any other fraction kept as it is. No arithmetic.
export function groupedAmount(amount: string): string {
  const [whole = '0', fraction = ''] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return /^0*$/.test(fraction) ? grouped : `${grouped},${fraction}`;
}
const STATUS_TEXT: Record<string, string> = { todo: 'to do', in_progress: 'in progress', waiting: 'waiting', in_review: 'in review' };

/**
 * The facts of a brief as numbered lines, in a fixed order (decisions, open items, open deals), each with its source. The model is given exactly these lines, a sentence cites their numbers, and
 * the page lists the same lines: so a citation can only name a fact the member can see. Pure.
 */
export function briefLines(facts: BriefFacts): BriefLine[] {
  const lines: Omit<BriefLine, 'n'>[] = [];
  if (facts.previous) {
    const source: BriefSource = { type: 'meeting', id: facts.previous.meetingId };
    for (const decision of facts.decisions) lines.push({ kind: 'decision', text: `Decision of the last meeting: ${oneLine(decision, TEXT_CHARS)}`, source });
    for (const item of facts.items) {
      const owner = item.whoUserId !== null || item.who !== '' ? oneLine(item.who, 100) : '';
      const parts = [
        item.assigned ? 'accepted as a task' : 'not given to anyone yet',
        ...(owner !== '' ? [`owner: ${owner}`] : []),
        ...(item.whenDate !== null ? [`due: ${item.whenDate}`] : item.due !== null ? [`due: ${item.due.slice(0, 10)}`] : []),
        ...(item.taskStatus !== null ? [`status: ${STATUS_TEXT[item.taskStatus] ?? item.taskStatus}`] : []),
      ];
      lines.push({ kind: 'item', text: `Open item: ${oneLine(item.title, TEXT_CHARS)} (${parts.join('; ')})`, source });
    }
  }
  for (const deal of facts.deals) {
    const parts = [`stage: ${oneLine(deal.stage, 100)}`, ...(deal.amount !== null ? [`amount: ${groupedAmount(deal.amount)} VND`] : []), ...(deal.expectedClose !== null ? [`expected close: ${deal.expectedClose}`] : [])];
    const who = facts.customer ? ` for ${oneLine(facts.customer.name, 100)}` : '';
    lines.push({ kind: 'deal', text: `Open deal${who}: ${oneLine(deal.title, TEXT_CHARS)} (${parts.join('; ')})`, source: { type: 'deal', id: deal.id } });
  }
  return lines.slice(0, BRIEF_LINES_MAX).map((line, index) => ({ ...line, n: index + 1 }));
}
