// SPDX-License-Identifier: AGPL-3.0-only
// The member's Vy naming who an action item belongs to (#3921, step 2). Step 1 finds the person by code (assignee-match in modules/meetings, `suggestion` on an action item). When code finds nobody, the member
// may click once and have their own Vy read the said name next to the names of the people they may give the work to, and pick one or nobody.
//
// The FACTS are read by code, as the member: the said name of the item and the people (the attendees first, then the other members, each with the seats they hold now). Only the names go to the model, never an id,
// a title or an email address; the answer is a number, which the route maps to the person it numbered. Nothing is stored: the answer is a suggestion on the page, and a task is still made by a person who
// picks the seat and clicks. This file holds the shapes both sides use. No model call, database or network access here.
import { z } from 'zod';
import { zId } from './schemas.ts';
import { zAskStatus } from './meeting-ask.ts';

// The most people offered to the model. More than this and only the attendees are offered; with more attendees than this, nobody is (a cut list would hide the right person).
export const ASSIGNEE_PEOPLE_MAX = 100;

export const zAssigneeAsk = z.strictObject({ itemId: zId });
export type AssigneeAsk = z.infer<typeof zAssigneeAsk>;

// The button's answer: the same switches as asking across meetings (whether Vy may be used now, and why not).
export const zAssigneeStatus = zAskStatus;
export type AssigneeStatus = z.infer<typeof zAssigneeStatus>;

const zSeat = z.strictObject({ id: zId, title: z.string() });
export const zAssigneePerson = z.strictObject({ userId: zId, name: z.string(), source: z.enum(['attendee', 'member']), positions: z.array(zSeat) });
export type AssigneePerson = z.infer<typeof zAssigneePerson>;

// `eligible` is false when there is nothing to ask: the item already has a person or a task, code found a person, the said text is empty or is not a name, or there is nobody to pick from.
export const zAssigneeFacts = z.strictObject({ eligible: z.boolean(), said: z.string(), people: z.array(zAssigneePerson).max(ASSIGNEE_PEOPLE_MAX) });
export type AssigneeFacts = z.infer<typeof zAssigneeFacts>;

// `suggested`: a person the said name supports. `none`: Vy found nobody, said so, or nothing was asked. `failed`: the call could not be used (a fixed code). A suggestion is one of the people the facts listed,
// with the seats they hold now.
export const zAssigneeAnswer = z.strictObject({
  state: z.enum(['suggested', 'none', 'failed']),
  errorCode: z.string().nullable(),
  suggestion: zAssigneePerson.nullable(),
});
export type AssigneeAnswer = z.infer<typeof zAssigneeAnswer>;
