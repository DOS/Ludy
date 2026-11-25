// SPDX-License-Identifier: AGPL-3.0-only
// Labels on a meeting (#4955, plan docs/plan/meetings.md L28): the recorder puts up to five short plain-text labels on a meeting ("Khách Hoa Sen", "Dự án website", "Họp tuần"), and the meetings list
// filters by them. A label is not a place for a person's address, phone number or ID: the text is checked by code on both sides, and the page says to keep names of people out. A reader of the meeting
// sees the labels; an owner or admin who is not a reader sees none (ADR-0047).
//
// This file holds the shapes, the limits and the text rule both sides use. No database or network access here.
import { z } from 'zod';
import { zId } from './schemas.ts';

// How many labels one meeting may have, and how long a label may be.
export const MEETING_LABELS_MAX = 5;
export const MEETING_LABEL_LENGTH_MAX = 40;
// The most distinct labels and meetings the list of labels answers with.
export const LABEL_INDEX_LABELS_MAX = 200;
export const LABEL_INDEX_MEETINGS_MAX = 500;

/** Collapses every run of spaces and tabs to one space and trims the ends; a line break is kept so the check below can refuse it. */
export function cleanLabelText(text: string): string {
  return text.normalize('NFC').replace(/[ \t ]+/g, ' ').trim();
}

export type LabelProblem = 'empty' | 'too_long' | 'control' | 'address' | 'digits';

/**
 * Why a label cannot be used, or null when it can. A label is plain text for grouping meetings, so a line break or other control character, an "@" (an e-mail address) and a run of seven digits or more
 * (a phone number, an ID, a tax code) are refused, which keeps most personal data out of a label. It is a first line only: a label is personal data like a meeting title (#4964), so the finder lists it and the
 * erasure redacts it whatever these checks let through (a name, for one).
 */
export function labelProblem(text: string): LabelProblem | null {
  const clean = cleanLabelText(text);
  if (clean === '') return 'empty';
  if ([...clean].length > MEETING_LABEL_LENGTH_MAX) return 'too_long';
  for (const ch of clean) {
    const code = ch.codePointAt(0) ?? 0;
    // Control characters, line and paragraph separators, zero-width, soft-hyphen and bidi marks and isolates, the Arabic letter mark, the Mongolian vowel separator, the interlinear annotation marks and the
    // tag characters (a label made of them would be invisible, or would flip or hide the text around it).
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x00ad ||
      code === 0x061c ||
      code === 0x180e ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2069) ||
      code === 0xfeff ||
      (code >= 0xfff9 && code <= 0xfffb) ||
      (code >= 0xe0000 && code <= 0xe007f)
    ) {
      return 'control';
    }
  }
  if (clean.includes('@')) return 'address';
  if (/\d(?:[\s.\-/()+]?\d){6,}/.test(clean)) return 'digits';
  return null;
}

/** The key two labels are the same by: the text lower-cased (the database's unique index is on lower(label)). */
export function labelKey(text: string): string {
  return cleanLabelText(text).toLowerCase();
}

export const zLabelText = z.string().max(400);

export const zLabelAdd = z.strictObject({ meetingId: zId, label: zLabelText });
export type LabelAdd = z.infer<typeof zLabelAdd>;

// `created` is false when the meeting already had the label (one label, not two).
export const zLabelAdded = z.strictObject({ meetingId: zId, labelId: zId, label: z.string(), created: z.boolean() });
export type LabelAdded = z.infer<typeof zLabelAdded>;

export const zLabelRemove = z.strictObject({ meetingId: zId, labelId: zId });
export type LabelRemove = z.infer<typeof zLabelRemove>;

export const zLabelRemoved = z.strictObject({ meetingId: zId, labelId: zId });
export type LabelRemoved = z.infer<typeof zLabelRemoved>;

export const zMeetingLabel = z.strictObject({ id: zId, label: z.string() });
export type MeetingLabel = z.infer<typeof zMeetingLabel>;

// The labels of one meeting the caller may read, in the order they were added.
export const zMeetingLabels = z.strictObject({ meetingId: zId, labels: z.array(zMeetingLabel) });
export type MeetingLabels = z.infer<typeof zMeetingLabels>;

export const zLabelIndexInput = z.strictObject({});
export type LabelIndexInput = z.infer<typeof zLabelIndexInput>;

// The labels across the meetings the caller may read (past their text date and unreadable ones left out): each distinct label (the first spelling met) with the number of meetings that carry it, the most used first,
// and the labels of each meeting, so the list can show them and filter by them without a read per meeting.
export const zLabelIndex = z.strictObject({
  labels: z.array(z.strictObject({ label: z.string(), count: z.number().int().min(1) })).max(LABEL_INDEX_LABELS_MAX),
  meetings: z.array(z.strictObject({ meetingId: zId, labels: z.array(z.string()).min(1).max(MEETING_LABELS_MAX) })).max(LABEL_INDEX_MEETINGS_MAX),
});
export type LabelIndex = z.infer<typeof zLabelIndex>;
