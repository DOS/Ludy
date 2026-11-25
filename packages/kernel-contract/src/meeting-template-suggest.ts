// SPDX-License-Identifier: AGPL-3.0-only
// Suggesting the minutes template of a meeting from the meeting itself (#4772, plan docs/plan/meetings.md row L16). Code first: the series, a linked deal, words in the title and the number of people vote for one of the
// four non-general built-in templates, and the answer is a template code with fixed reason codes (the app words them): no model text. Only when code cannot tell does the recorder's own click have Vy read the transcript and
// answer one template code with a one-line reason citing a transcript line; that answer goes to the browser and is stored nowhere. Either way the recorder accepts with one click, which is the existing
// meetings.minutes.set_template: nothing changes without it. The checks that decide what a Vy answer may be are code (packages/agent member-vy/meeting-template-suggest.ts).
import { z } from 'zod';
import { CHAPTER_SECOND_MAX } from './meeting-chapters.ts';
import { MEETING_SUMMARY_TEMPLATES } from './meeting-templates.ts';
import { zId } from './schemas.ts';

// The templates a suggestion may name: every built-in one but the general summary, which is where a meeting starts.
export const SUGGESTABLE_TEMPLATES = ['briefing', 'customer', 'supplier', 'one_on_one'] as const satisfies readonly Exclude<(typeof MEETING_SUMMARY_TEMPLATES)[number], 'general'>[];
export const zSuggestableTemplate = z.enum(SUGGESTABLE_TEMPLATES);
export type SuggestableTemplate = z.infer<typeof zSuggestableTemplate>;

// Why code suggested it: a fixed list the app words. `series` the previous meeting of its series is on that template, `deal` a CRM deal is linked, `title` the title has a word of that kind, `people` exactly two
// people (a corroboration of a one-to-one, never a reason on its own).
export const TEMPLATE_REASONS = ['series', 'deal', 'title', 'people'] as const;
export const zTemplateReason = z.enum(TEMPLATE_REASONS);
export type TemplateReason = z.infer<typeof zTemplateReason>;

// Code's answer. `suggested` code found exactly one template; `unknown` it cannot tell (no signal, or two templates in conflict) and Vy may be asked; `not_applicable` there is nothing to suggest (not the recorder, no transcript
// or a meeting already on a template).
export const TEMPLATE_SUGGEST_STATES = ['suggested', 'unknown', 'not_applicable'] as const;
export const zTemplateSuggestion = z.strictObject({
  meetingId: zId,
  state: z.enum(TEMPLATE_SUGGEST_STATES),
  template: zSuggestableTemplate.nullable(),
  reasons: z.array(zTemplateReason).max(TEMPLATE_REASONS.length),
});
export type TemplateSuggestion = z.infer<typeof zTemplateSuggestion>;

export const TEMPLATE_REASON_CHARS_MIN = 3;
export const TEMPLATE_REASON_CHARS_MAX = 160;
export const TEMPLATE_VY_STATES = ['suggested', 'none', 'failed'] as const;
// Vy's answer: one template, a one-line reason and the whole start second of a transcript line the reason rests on. Stored nowhere.
export const zTemplateVyAnswer = z.strictObject({
  state: z.enum(TEMPLATE_VY_STATES),
  // The fixed code of a failure, a name and never the model's or the provider's words.
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .nullable(),
  template: zSuggestableTemplate.nullable(),
  reason: z.string().min(TEMPLATE_REASON_CHARS_MIN).max(TEMPLATE_REASON_CHARS_MAX).nullable(),
  seconds: z.number().int().min(0).max(CHAPTER_SECOND_MAX).nullable(),
  // How many proposed answers code removed (a count, never the text).
  dropped: z.number().int().min(0).max(10),
});
export type TemplateVyAnswer = z.infer<typeof zTemplateVyAnswer>;
