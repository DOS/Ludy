// SPDX-License-Identifier: AGPL-3.0-only
// The one class of characters that never reach a title, a hint, a name or a model as text (Meetings #4137, point 2): what a person cannot see but a reader, a screen or a model can act on.
// cleanTemplateText (the minutes templates' title, hint and name, and the glossary's term transform), glossaryTermProblem (direct glossary validation) and chapterTitleProblem (the
// chapters' title) are built from it, so a widening is made here and nowhere else in the contract.
// Two copies stay outside this package, because the agent package does not depend on the contract: cleanChapterTitle (meeting-chapters.ts in the agent package, in its member-vy folder) and orgText
// (meeting-summary.ts in the same folder). apps/kernel/test/chapter-title-class.test.ts, glossary-term-class.test.ts and meetings-template-clean.test.ts hold them to this class. The database
// spells the same class in crove_meetings.minutes_sections_ok, crove_meetings.glossary_term_ok and the CHECKs of minutes_template.name and meeting_chapter.title (the latest forward migrations that
// restate them are named in those tests).
//
// The class: C0 and C1 controls (a newline and a tab included), the soft hyphen, the Arabic letter mark, the Hangul fillers (U+115F, U+1160, U+3164 and the halfwidth U+FFA0), the Mongolian free
// variation selectors and vowel separator (U+180B to U+180E), the zero-width and directional marks (U+200B to U+200F), the line and paragraph separators and bidirectional embeddings and overrides
// (U+2028 to U+202E), the word joiner, the invisible operators, the bidi isolates and the deprecated format controls (U+2060 to U+206F), the braille blank, the byte order mark, the interlinear
// annotation marks, the musical symbol beam and slur format controls (U+1D173 to U+1D17A) and the tag characters (which can carry a hidden message). The combining grapheme joiner (U+034F) is a
// separate alternative inside a non-capturing group, so the pattern can be placed in a longer one: a combining mark inside a character class is a lint warning (no-misleading-character-class). Variation selectors U+FE00 to U+FE0F stay: emoji need them.
export const INVISIBLE_PATTERN =
  '(?:[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u115f\\u1160\\u180b-\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u2800\\u3164\\uffa0\\ufeff\\ufff9-\\ufffb\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e007f}]|\\u034f)';

// The same class as the one place that WRITES hidden characters out where a reader sees them (#4423): an AI coworker's text shown or sent where nobody reads a card is shown with `<U+202E>` and the like in place of
// each character of the class, so it cannot reorder the line around it or hide part of itself (the Inbox card of an Engage ask, a tainted task's title in the screens and notices). A newline and a tab stay (a long text keeps its lines); `keepJoiners` also keeps the zero-width joiner and non-joiner (U+200D and U+200C), which emoji and some scripts need, as a one-line title does.
const HIDDEN_RE = new RegExp(`^${INVISIBLE_PATTERN}$`, 'u');
export function hiddenTextCode(code: number, keepJoiners = false): boolean {
  if (code === 0x09 || code === 0x0a) return false;
  if (keepJoiners && (code === 0x200c || code === 0x200d)) return false;
  return HIDDEN_RE.test(String.fromCodePoint(code));
}
export function markHiddenText(text: string, options: { keepJoiners?: boolean; open?: string; close?: string } = {}): string {
  const { keepJoiners = false, open = '<', close = '>' } = options;
  return Array.from(text)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return hiddenTextCode(code, keepJoiners) ? `${open}U+${code.toString(16).toUpperCase().padStart(4, '0')}${close}` : ch;
    })
    .join('');
}
