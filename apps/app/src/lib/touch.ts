// SPDX-License-Identifier: AGPL-3.0-only
// A control that is at least 44 px high on a narrow screen or a touch pointer and keeps its compact size with a mouse on a wide one (#3641, Engage audit AD-10; the Inbox's
// own constants are the same rule). A whole string so the stylesheet scanner finds the classes.
export const TOUCH_BUTTON = 'max-sm:min-h-11 pointer-coarse:min-h-11';
