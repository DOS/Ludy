// SPDX-License-Identifier: AGPL-3.0-only
// The only builder of the minutes text that "Gửi qua Zalo" puts into a customer's Zalo thread (meetings integrations B5, issue #3169, plan docs/plan/meetings-integrations.md 5.3).
// It is pure code: no model takes part, and nothing is sent from here. The text lands in the reply box of Hộp thư, where the recorder reads it, edits it and presses Hộp thư's own
// Send button. Only what the recorder ticked from the PUBLISHED result goes in: a title line, the summary (only when ticked, off by default), the ticked decisions and the ticked
// action items with their dates. An action item's owner is never included (the owners are the business's own staff), and neither is a transcript, audio or any attendee detail:
// the input type has no field for them, so no caller can pass one.
import { hasNamePlaceholder } from './conversations.ts';

// What the Zalo reply may hold at most (the `zalo_oa` rule of the conversation core, CONVERSATION_PROVIDER_RULES), counted as the send command counts it: on the trimmed text.
export const MEETING_ZALO_DRAFT_MAX = 2000;

// The fixed words around the ticked lines, supplied by the screen's own translation so the draft speaks the language of the business.
export interface MeetingZaloLabels {
  // The first line, with the meeting's title put in by the builder: `heading(title)`.
  heading: (title: string) => string;
  summary: string;
  decisions: string;
  items: string;
  // "(hạn 31/12/2026)": `due(date)` with the date already written day/month/year; the builder puts one space before it.
  due: (date: string) => string;
}

export interface MeetingZaloInput {
  title: string;
  // The published summary and the recorder's choice to put it in (off by default).
  summary: string | null;
  includeSummary: boolean;
  // The published decisions and action items; `ticked*` are the indexes the recorder ticked.
  decisions: readonly string[];
  tickedDecisions: readonly number[];
  items: readonly { title: string; whenDate: string | null }[];
  tickedItems: readonly number[];
  labels: MeetingZaloLabels;
  // The channel's limit; the Zalo one when absent.
  max?: number;
}

export interface MeetingZaloDraft {
  text: string;
  // Whether anything was ticked at all (a title alone is not a message).
  hasLines: boolean;
  // The length the send command will count, and whether it is within the limit. A text over the limit is never cut: the screen tells the recorder to untick a line.
  length: number;
  fits: boolean;
}

// One line of someone else's words: control and invisible characters and braces gone (a brace could write the contact-name placeholder that the send command refuses), one
// line, single spaces. NFC first, so the text is the one the checks read.
function oneLine(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}{}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

// The summary keeps its paragraphs: at most one blank line between two, no control or invisible character, no brace.
function paragraphs(text: string): string {
  return text
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}{}]/gu, (c) => (c === '\n' ? c : ' '))
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

// "2026-12-31" as "31/12/2026", or null for anything that is not a day.
function dayText(date: string | null): string | null {
  const m = date === null ? null : /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

const valid = (ticked: readonly number[], length: number): number[] => [...new Set(ticked)].filter((i) => Number.isInteger(i) && i >= 0 && i < length).sort((a, b) => a - b);

export function buildMeetingZaloDraft(input: MeetingZaloInput): MeetingZaloDraft {
  const max = input.max ?? MEETING_ZALO_DRAFT_MAX;
  const blocks: string[] = [];
  const title = oneLine(input.title);
  const heading = oneLine(input.labels.heading(title));
  if (heading !== '') blocks.push(heading);

  let hasLines = false;
  const summary = input.includeSummary && input.summary !== null ? paragraphs(input.summary) : '';
  if (summary !== '') {
    hasLines = true;
    blocks.push(`${oneLine(input.labels.summary)}\n${summary}`);
  }
  const decisions = valid(input.tickedDecisions, input.decisions.length)
    .map((i) => oneLine(input.decisions[i] ?? ''))
    .filter((d) => d !== '');
  if (decisions.length > 0) {
    hasLines = true;
    blocks.push([oneLine(input.labels.decisions), ...decisions.map((d) => `- ${d}`)].join('\n'));
  }
  const items = valid(input.tickedItems, input.items.length).flatMap((i) => {
    const item = input.items[i];
    const text = item ? oneLine(item.title) : '';
    if (text === '') return [];
    const day = dayText(item?.whenDate ?? null);
    return [`- ${text}${day === null ? '' : ` ${oneLine(input.labels.due(day))}`}`];
  });
  if (items.length > 0) {
    hasLines = true;
    blocks.push([oneLine(input.labels.items), ...items].join('\n'));
  }
  // A title with nothing under it is not a message: the screen leaves the box alone.
  const text = hasLines ? blocks.join('\n\n').trim() : '';
  // The send command refuses a reply that still holds the name placeholder; the braces are gone, so this holds, and the check keeps it that way if a label ever changes.
  if (hasNamePlaceholder(text)) return { text: '', hasLines: false, length: 0, fits: true };
  return { text, hasLines, length: text.length, fits: text.length <= max };
}
