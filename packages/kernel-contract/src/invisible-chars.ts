// SPDX-License-Identifier: AGPL-3.0-only
// The one class of characters that never reach a title, a hint, a name or a model as text (Meetings #4137, point 2): what a person cannot see but a reader, a screen or a model can act on.
// cleanTemplateText (the minutes templates' title, hint and name) and chapterTitleProblem (the chapters' title) are built from it, so a widening is made here and nowhere else in the contract.
// Two copies stay outside this package, because the agent package does not depend on the contract: cleanChapterTitle (packages/agent/src/member-vy/meeting-chapters.ts) and orgText
// (packages/agent/src/member-vy/meeting-summary.ts). apps/kernel/test/chapter-title-class.test.ts and meetings-template-clean.test.ts hold them to this class. The database spells the same class in
// crove_meetings.minutes_sections_ok and in the CHECKs of minutes_template.name and meeting_chapter.title (the latest forward migration that restates them is named in the test above).
//
// The class: C0 and C1 controls (a newline and a tab included), the soft hyphen, the Arabic letter mark, the Hangul fillers (U+115F, U+1160, U+3164 and the halfwidth U+FFA0), the Mongolian free
// variation selectors and vowel separator (U+180B to U+180E), the zero-width and directional marks (U+200B to U+200F), the line and paragraph separators and bidirectional embeddings and overrides
// (U+2028 to U+202E), the word joiner, the invisible operators, the bidi isolates and the deprecated format controls (U+2060 to U+206F), the braille blank, the byte order mark, the interlinear
// annotation marks, the musical symbol beam and slur format controls (U+1D173 to U+1D17A) and the tag characters (which can carry a hidden message). The combining grapheme joiner (U+034F) is a
// separate alternative inside a non-capturing group, so the pattern can be placed in a longer one: a combining mark inside a character class is a lint warning (no-misleading-character-class). Variation selectors U+FE00 to U+FE0F stay: emoji need them.
export const INVISIBLE_PATTERN =
  '(?:[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u115f\\u1160\\u180b-\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\u2800\\u3164\\uffa0\\ufeff\\ufff9-\\ufffb\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e007f}]|\\u034f)';
