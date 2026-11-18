// SPDX-License-Identifier: AGPL-3.0-only
// Tap targets of the Inbox (#3638, Engage audit IN-8): owners use the Inbox on phones, so every control of the thread, the reply box, the contact panel and the filters
// is at least 44 px high on a narrow screen or a touch pointer, and keeps its compact size with a mouse on a wide one. The classes are whole strings so the stylesheet
// scanner finds them. A NativeSelect puts its className on the wrapper, so the select inside is reached through a descendant selector.
export const TOUCH_BUTTON = 'max-sm:min-h-11 pointer-coarse:min-h-11';
export const TOUCH_SELECT = 'max-sm:[&_select]:min-h-11 pointer-coarse:[&_select]:min-h-11';
export const TOUCH_MIN_PX = 44;
