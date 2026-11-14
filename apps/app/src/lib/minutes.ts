// SPDX-License-Identifier: AGPL-3.0-only
// The biên bản page of a meeting (Meetings A4, #3162): what the page says, worked out in code from the meeting row and the PUBLISHED result. Nothing here comes from the model
// except the text of the sections, the conclusions and the action titles the recorder read and shared; the date, the attendees, the owners and the due dates come from the meeting
// (its start, its readers, the attendee code matched, the date code parsed), and the layout is the component's.
import { textToSections, type ActionItemView, type MeetingResults, type MeetingSummaryTemplate } from '@crove/kernel-contract';

// A day and a time as Vietnamese offices write them, in Vietnam time whatever the browser's zone is.
export interface VnMoment {
  day: string;
  month: string;
  year: string;
  time: string;
}
const VN = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
export function vnMoment(iso: string): VnMoment {
  const parts = Object.fromEntries(VN.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return { day: parts.day as string, month: parts.month as string, year: parts.year as string, time: `${parts.hour}:${parts.minute}` };
}

// "2026-11-14" as 14/11/2026; null stays null (the page prints a dotted line to fill by hand).
export function dueText(day: string | null): string | null {
  if (day === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

export interface MinutesSection {
  // The section's key on a template, null for the general summary's one block.
  key: string | null;
  text: string;
}
export interface MinutesAction {
  title: string;
  // The attendee code matched, by name; null when none was matched (a dotted line, never the words the model heard).
  owner: string | null;
  due: string | null;
}
export interface MinutesModel {
  // Something was shared: false shows "Bản nháp" and no content at all.
  published: boolean;
  // The recorder has a newer draft the page does not show.
  newerDraft: boolean;
  from: VnMoment;
  to: VnMoment | null;
  recorder: string;
  attendees: string[];
  sections: MinutesSection[];
  conclusions: string[];
  actions: MinutesAction[];
}

export interface MinutesMeeting {
  startedAt: string | null;
  createdAt: string;
  endedAt: string | null;
  recorderUserId: string;
  readers: readonly string[];
  summaryTemplate: MeetingSummaryTemplate;
}

export function buildMinutes(meeting: MinutesMeeting, results: MeetingResults, nameOf: (userId: string) => string): MinutesModel {
  const published = results.published;
  const people = [meeting.recorderUserId, ...meeting.readers.filter((id) => id !== meeting.recorderUserId)];
  let sections: MinutesSection[] = [];
  if (published) {
    const parsed = textToSections(meeting.summaryTemplate, published.summary);
    // Text not in the template's form (the template changed since it was shared) is shown whole, as it was shared.
    sections = parsed ? parsed.filter((s) => s.text !== '').map((s) => ({ key: s.key, text: s.text })) : published.summary.trim() === '-' ? [] : [{ key: null, text: published.summary }];
  }
  const items = published || results.items.some((i) => i.stage === 'published') ? results.items.filter((i) => i.stage === 'published') : [];
  const owner = (i: ActionItemView): string | null => (i.whoUserId ? nameOf(i.whoUserId) : null);
  return {
    published: published !== null || items.length > 0,
    newerDraft: results.isRecorder && (results.draft !== null || results.items.some((i) => i.stage === 'draft')),
    from: vnMoment(meeting.startedAt ?? meeting.createdAt),
    to: meeting.endedAt ? vnMoment(meeting.endedAt) : null,
    recorder: nameOf(meeting.recorderUserId),
    attendees: people.map(nameOf),
    sections,
    conclusions: published ? [...published.decisions] : [],
    actions: items.map((i) => ({ title: i.title, owner: owner(i), due: dueText(i.whenDate) })),
  };
}
