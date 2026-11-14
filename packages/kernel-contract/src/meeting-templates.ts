// SPDX-License-Identifier: AGPL-3.0-only
// The minutes templates of a meeting (Meetings A4, #3162, plan docs/plan/meetings-integrations.md section 4.3). Five templates, shipped in code: no editor and no
// templates made by an org. A template is a list of sections, each with a stable key, the heading Vietnamese offices write over it, and a hint for Vy (the same
// `meetings.summary` run fills the sections, no new feature key). The meeting stores only the template's code (crove_meetings.meeting.summary_template).
//
// The text of the sections is stored in the existing `summary` column of the meeting's result, as headings and paragraphs (sectionsToText), and read back by
// the headings (textToSections). Nothing but code decides the headings, so the summary column stays plain text for everything that reads it (the translation, the
// follow-up mail, the search, the personal-data finders and the erasure) and no new free-text column exists.
import { z } from 'zod';

export const MEETING_SUMMARY_TEMPLATES = ['general', 'briefing', 'customer', 'supplier', 'one_on_one'] as const;
export type MeetingSummaryTemplate = (typeof MEETING_SUMMARY_TEMPLATES)[number];
export const DEFAULT_SUMMARY_TEMPLATE: MeetingSummaryTemplate = 'general';
export const zMeetingSummaryTemplate = z.enum(MEETING_SUMMARY_TEMPLATES);

export interface TemplateSection {
  // Stable, snake_case, unique inside its template. The model and the screens name a section by it; the heading may change wording, the key never does.
  key: string;
  // The heading written over the section, in Vietnamese (the layout is the one Vietnamese offices use).
  title: string;
  // What belongs in the section, for Vy (English instruction text; the model writes in the meeting's language).
  hint: string;
}

// 'general' (Tóm tắt chung) has no sections: it is today's summary and decisions, unchanged. The others fill their sections and the decisions.
export const SUMMARY_TEMPLATE_SECTIONS: Readonly<Record<MeetingSummaryTemplate, readonly TemplateSection[]>> = {
  general: [],
  briefing: [
    { key: 'progress', title: 'Kết quả công việc kỳ trước', hint: 'What was reported as done or moved forward since the last meeting.' },
    { key: 'issues', title: 'Vướng mắc, tồn tại', hint: 'Problems, delays and blockers that were raised.' },
    { key: 'plan', title: 'Kế hoạch kỳ tới', hint: 'What each person or team said they plan to do next.' },
    { key: 'requests', title: 'Đề xuất, kiến nghị', hint: 'Requests and proposals made to the manager or to other teams.' },
  ],
  customer: [
    { key: 'needs', title: 'Nhu cầu của khách hàng', hint: 'What the customer said they need or want.' },
    { key: 'discussed', title: 'Nội dung trao đổi', hint: 'What was offered, explained or shown to the customer. Prices, quantities and dates only as said.' },
    { key: 'feedback', title: 'Ý kiến, băn khoăn của khách hàng', hint: 'Concerns, objections and feedback the customer gave.' },
    { key: 'next_steps', title: 'Bước tiếp theo đã thống nhất', hint: 'What both sides agreed to do next, without inventing owners or dates.' },
  ],
  supplier: [
    { key: 'supply', title: 'Tình hình cung ứng', hint: 'Goods or services, quantities, delivery progress and dates, only as said.' },
    { key: 'terms', title: 'Giá và điều khoản', hint: 'Prices, payment terms and conditions that were discussed, only as said.' },
    { key: 'issues', title: 'Vấn đề, khiếu nại', hint: 'Quality problems, delays and complaints that were raised.' },
    { key: 'commitments', title: 'Cam kết của nhà cung cấp', hint: 'What the supplier promised to do or to change.' },
  ],
  one_on_one: [
    { key: 'updates', title: 'Cập nhật công việc', hint: 'What the person reported about their work.' },
    { key: 'feedback', title: 'Trao đổi, góp ý', hint: 'Feedback given in either direction.' },
    { key: 'support', title: 'Khó khăn và hỗ trợ cần thiết', hint: 'Difficulties and the help the person asked for.' },
    { key: 'goals', title: 'Mục tiêu tiếp theo', hint: 'Goals or priorities agreed for the coming period.' },
  ],
};

export const SECTION_TEXT_MAX = 1200;
export const SECTIONS_MAX = 8;

export const zSectionEntry = z.strictObject({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  text: z.string().trim().max(SECTION_TEXT_MAX),
});
export type SectionEntry = z.infer<typeof zSectionEntry>;

export function templateSections(template: MeetingSummaryTemplate): readonly TemplateSection[] {
  return SUMMARY_TEMPLATE_SECTIONS[template];
}

// A line of a section's text that equals a heading of the template would read back as a new section: it is marked so it stays text.
const ESCAPE = '· ';
function escapeLines(text: string, titles: ReadonlySet<string>): string {
  return text
    .split('\n')
    .map((line) => (titles.has(line.trim()) ? `${ESCAPE}${line.trim()}` : line.trimEnd()))
    .join('\n')
    .trim();
}

/**
 * The text a meeting's result keeps for the filled sections: each non-empty section as its heading on one line and its text below, in the template's order,
 * separated by a blank line. A key the template does not have is left out, a repeated key keeps the first. 'general' has no sections: the empty string.
 */
export function sectionsToText(template: MeetingSummaryTemplate, entries: readonly SectionEntry[]): string {
  const defs = templateSections(template);
  const titles = new Set(defs.map((d) => d.title));
  const byKey = new Map<string, string>();
  for (const e of entries) if (!byKey.has(e.key)) byKey.set(e.key, e.text);
  const blocks: string[] = [];
  for (const def of defs) {
    const text = escapeLines(byKey.get(def.key) ?? '', titles);
    if (text !== '') blocks.push(`${def.title}\n${text}`);
  }
  return blocks.join('\n\n');
}

/**
 * Reads the sections back from a result's text, by the template's headings in the template's order. Every section of the template comes back (an empty text when
 * it was not filled). Null when the text is not in this template's form (the template changed since, or the text was typed for another one): the caller then shows
 * the whole text as it is.
 */
export function textToSections(template: MeetingSummaryTemplate, text: string): SectionEntry[] | null {
  const defs = templateSections(template);
  if (defs.length === 0) return null;
  const lines = text.split('\n');
  const found = new Map<string, string[]>();
  let current: string[] | null = null;
  let next = 0;
  for (const line of lines) {
    // A heading is the exact title line of a section that comes after the one before it, at the start or after a blank line.
    const at = defs.findIndex((d, i) => i >= next && d.title === line.trim());
    const after = current === null || current.length === 0 || current[current.length - 1] === '';
    if (at >= 0 && after) {
      current = [];
      found.set((defs[at] as TemplateSection).key, current);
      next = at + 1;
      continue;
    }
    if (current === null) {
      if (line.trim() !== '') return null;
      continue;
    }
    current.push(line.startsWith(ESCAPE) && defs.some((d) => d.title === line.slice(ESCAPE.length).trim()) ? line.slice(ESCAPE.length) : line);
  }
  if (found.size === 0) return null;
  return defs.map((d) => ({ key: d.key, text: (found.get(d.key) ?? []).join('\n').trim() }));
}
