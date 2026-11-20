// SPDX-License-Identifier: AGPL-3.0-only
// Minutes templates an organization writes (Meetings #3578, plan docs/plan/meetings-integrations.md section 4.3, owner direction of 2026-11-17: the core of Meetings first).
// An owner or admin writes a template: a name and 1 to 8 sections, each a title (the heading over the section) and a hint for Vy (what belongs in it). Code makes the section keys;
// a person never types one. The recorder picks the template for a meeting (meetings.minutes.set_template) and the meeting keeps its own copy of the sections, so an edit or archive
// later never changes a published result. The text is the org's layout, not personal data; the settings screen says so.
//
// A title is shown to every reader of the minutes and a hint reaches the instruction of another member's Vy, so both are plain text only: control characters, line and paragraph
// separators and bidirectional controls are stripped, whitespace is collapsed and the caps hold. The same rules are in the database (crove_meetings.minutes_sections_ok).
import { z } from 'zod';
import { INVISIBLE_PATTERN } from './invisible-chars.ts';
import { SECTIONS_MAX, type TemplateSection } from './meeting-templates.ts';
import { zId } from './schemas.ts';

export const TEMPLATE_NAME_MAX = 80;
export const SECTION_TITLE_MAX = 60;
export const SECTION_HINT_MAX = 200;
// Active templates one organization keeps; archived ones do not count.
export const TEMPLATES_ACTIVE_MAX = 50;

// What is stripped from a title, a hint or a name: the invisible-character class of ./invisible-chars.ts (controls, separators, bidirectional controls, zero-width characters, the invisible
// fillers and operators, tag characters; a line break is one of them), and an unpaired surrogate (which PostgreSQL refuses in a jsonb value). Variation selectors stay: emoji need them.
// Whitespace left is collapsed to single spaces. The database refuses the same set (crove_meetings.minutes_sections_ok and the name CHECK of minutes_template).
const STRIP = new RegExp(INVISIBLE_PATTERN, 'gu');
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export function cleanTemplateText(raw: string): string {
  return raw.replace(LONE_SURROGATE, ' ').replace(STRIP, ' ').replace(/\s+/gu, ' ').trim();
}

const zClean = (max: number, min: number) =>
  z
    .string()
    .transform(cleanTemplateText)
    .pipe(z.string().min(min).max(max));

export const zTemplateName = zClean(TEMPLATE_NAME_MAX, 1);

const SECTION_KEY = /^[a-z][a-z0-9_]{0,31}$/;

// A section as the editor sends it: a section that already exists comes back with its key, a new one has none and gets one from code.
export const zTemplateSectionInput = z.strictObject({
  key: z.string().regex(SECTION_KEY).optional(),
  title: zClean(SECTION_TITLE_MAX, 1),
  hint: zClean(SECTION_HINT_MAX, 0),
});
export type TemplateSectionInput = z.infer<typeof zTemplateSectionInput>;

// Titles are headings read back by their text, so two sections of one template may not share a title.
export const zTemplateSections = z
  .array(zTemplateSectionInput)
  .min(1)
  .max(SECTIONS_MAX)
  .refine((list) => new Set(list.map((s) => s.title)).size === list.length, { message: 'Two sections of a template cannot have the same title' });

export const zMinutesTemplateCreate = z.strictObject({ name: zTemplateName, sections: zTemplateSections });
export const zMinutesTemplateUpdate = z.strictObject({ templateId: zId, name: zTemplateName, sections: zTemplateSections });
export const zMinutesTemplateArchive = z.strictObject({ templateId: zId });
export const zMinutesTemplateList = z.strictObject({});

export const zTemplateSectionView = z.strictObject({ key: z.string().regex(SECTION_KEY), title: z.string(), hint: z.string() });
export const zMinutesTemplateView = z.strictObject({
  id: zId,
  name: z.string(),
  sections: z.array(zTemplateSectionView),
  // Only an owner or admin sees an archived template, read only.
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MinutesTemplateView = z.infer<typeof zMinutesTemplateView>;
export const zMinutesTemplates = z.strictObject({ templates: z.array(zMinutesTemplateView) });
export type MinutesTemplates = z.infer<typeof zMinutesTemplates>;
// The sections of a stored row (the template's, or the meeting's own copy). The database check keeps them well formed, so a failure here is a bug, not a user's mistake.
export function parseStoredSections(raw: unknown): TemplateSection[] {
  return z.array(zTemplateSectionView).parse(raw);
}
// The meeting's own copy of the template it was summarized with (#3578): its name, its sections (with the hints Vy was given) and the md5 of the sections as stored.
export const zMinutesTemplateCopy = z.strictObject({ name: z.string(), hash: z.string().regex(/^[0-9a-f]{32}$/), sections: z.array(zTemplateSectionView) });
export type MinutesTemplateCopy = z.infer<typeof zMinutesTemplateCopy>;
export const zMinutesTemplateDone = z.strictObject({ templateId: zId, archived: z.boolean() });

// Keys are code's. A section that exists keeps its key, a new one gets the next `s<n>` after the highest key the template holds now. Within one edit a removed section's key is not handed to a
// new one; after a later edit the highest key may come back if its section was removed (the template keeps no counter), so a key identifies a section only inside one version of a template:
// a meeting keeps its own copy, and a run is tied to the copy's hash, never to the live keys. A key the template does not have, or used twice, is refused (null).
export function assignSectionKeys(existing: readonly TemplateSection[], input: readonly TemplateSectionInput[]): TemplateSection[] | null {
  const known = new Set(existing.map((s) => s.key));
  const used = new Set<string>();
  let next = 1;
  for (const s of existing) {
    const m = /^s(\d+)$/.exec(s.key);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  const out: TemplateSection[] = [];
  for (const s of input) {
    let key = s.key;
    if (key !== undefined) {
      if (!known.has(key) || used.has(key)) return null;
    } else {
      do {
        key = `s${next++}`;
      } while (used.has(key) || known.has(key));
    }
    used.add(key);
    out.push({ key, title: s.title, hint: s.hint });
  }
  return out;
}
