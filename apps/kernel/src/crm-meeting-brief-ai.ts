// SPDX-License-Identifier: AGPL-3.0-only
// Dy's brief before a booking linked to a deal, on the API side (#3115, docs/plan/calendar.md "Deal links as built"). crm.booking.meeting_brief_source runs in the member's own transaction and gives the
// facts (the deal, its open next steps, its latest sent quote, the customer's latest words as far as the member may read them: a conversation they may not read gives no message); the model call then runs
// here, outside any transaction, through the AI budget meter (feature crm.meeting_brief, one call per brief). The model writes a short summary and 2 to 3 points from those facts; they are refused when
// they hold a figure, a link or a name that the facts do not hold, or are empty, too long or the wrong count (packages/agent meeting-brief.ts), and then the answer is the facts alone.
//
// It is computed when it is read and never written: nothing here stores the brief, sends a message or moves the deal. The customer's words reach the model only while the org's switch for AI on customers'
// words (conversation_setting.auto_draft) is on; the facts list still shows the member the messages they may read. When the model is off, the AI budget is spent, the member's calls are too frequent,
// the call fails or its words are refused, the answer names the state (`ai`) and carries no prose. A failure is named, never quoted: neither the facts nor the model's answer is logged.
import { AiBudgetExhaustedError, type InboxReader, type MeetingBriefFacts } from '@crove/agent';
import type { MeetingBrief, MeetingBriefState } from '@crove/kernel-contract';
import type { MeetingBriefSource } from '@crove/mod-crm';
import type { DraftBudget } from './ai-draft-limit.ts';

export interface MeetingBriefAi {
  reader: Pick<InboxReader, 'meetingBrief'> | null;
  budget: DraftBudget;
}

export function meetingBriefAi(reader: MeetingBriefAi['reader'], budget: DraftBudget): MeetingBriefAi {
  return { reader, budget };
}

async function wordMeetingBrief(ai: MeetingBriefAi, orgId: string, userId: string, facts: MeetingBriefFacts): Promise<{ state: MeetingBriefState; brief: { summary: string; points: string[] } | null }> {
  const answer = (state: MeetingBriefState, brief: { summary: string; points: string[] } | null = null) => ({ state, brief });
  // Off: no model is configured, so no call is made and none is counted.
  if (!ai.reader) return answer('off');
  const ticket = ai.budget.take(orgId, userId);
  if (!ticket.allowed) return answer('busy');
  try {
    const result = await ai.reader.meetingBrief(facts);
    if (result.kind === 'none') {
      console.error(`[crm-meeting-brief-ai] brief refused: ${result.code}`);
      return answer('failed');
    }
    return answer('used', result.brief);
  } catch (error: unknown) {
    if (error instanceof AiBudgetExhaustedError) return answer('budget');
    console.error('[crm-meeting-brief-ai] brief failed', error instanceof Error ? error.name : typeof error);
    return answer('failed');
  } finally {
    ticket.release();
  }
}

export async function prepareMeetingBrief(ai: MeetingBriefAi, orgId: string, userId: string, source: MeetingBriefSource): Promise<MeetingBrief> {
  // The model is given no customer message while the org keeps customers' words from it; the member's facts list keeps the messages they may read.
  const facts: MeetingBriefFacts = { meeting: source.meeting, deal: source.deal, nextSteps: source.nextSteps, quote: source.quote, messages: source.wordsAllowed ? source.messages : [] };
  const worded = await wordMeetingBrief(ai, orgId, userId, facts);
  return {
    ai: worded.state,
    bookingId: source.bookingId,
    dealId: source.dealId,
    meeting: source.meeting,
    deal: source.deal,
    nextSteps: source.nextSteps,
    quote: source.quote,
    messages: source.messages,
    summary: worded.brief?.summary ?? null,
    points: worded.brief?.points ?? [],
  };
}
