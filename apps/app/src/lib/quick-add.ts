// SPDX-License-Identifier: AGPL-3.0-only
// Pure Quick Add helpers for personal to-dos (#3556): payload building, dismissed-span tracking,
// recurrence chip labels, and the global Alt+Q capture shortcut guard.
import { TODO_TITLE_MAX, type TodoCreateInput } from '@crove/kernel-contract';
import {
  buildTitleWithoutSpans,
  type TodoQuickAddRecurrence,
  type TodoQuickAddResult,
  type TodoQuickAddToken,
} from '@crove/l10n-vn';

export interface QuickCaptureKeyLike {
  key: string;
  code?: string | undefined;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented?: boolean | undefined;
  isComposing?: boolean | undefined;
  target: EventTarget | null;
}

/** True when `el` is a form input or editable element where single/Alt text keys belong to typing. */
export function isEditableTarget(el: unknown): boolean {
  const node = el as {
    tagName?: unknown;
    isContentEditable?: unknown;
    getAttribute?: (name: string) => string | null;
    closest?: (selector: string) => unknown;
  } | null;
  if (!node || typeof node.tagName !== 'string') return false;
  const tag = node.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (node.isContentEditable === true) return true;
  if (typeof node.getAttribute === 'function') {
    const attr = node.getAttribute('contenteditable');
    if (attr === '' || attr === 'true' || attr === 'plaintext-only') return true;
  }
  if (typeof node.closest === 'function') {
    return node.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]') !== null;
  }
  return false;
}

export const OPEN_MODAL_DIALOG_SELECTOR =
  'dialog[open], [role="dialog"]:not([data-closed]), [role="alertdialog"]:not([data-closed])';

/** True when any native `<dialog open>` or Base UI modal dialog/sheet is currently open in `doc`. */
export function hasOpenModalDialog(
  doc: { querySelector?: ((selector: string) => unknown) | undefined } | null | undefined,
): boolean {
  if (!doc || typeof doc.querySelector !== 'function') return false;
  return doc.querySelector(OPEN_MODAL_DIALOG_SELECTOR) !== null;
}

function isInOpenDialog(el: unknown): boolean {
  const node = el as { closest?: (selector: string) => unknown } | null;
  return Boolean(node && typeof node.closest === 'function' && node.closest(OPEN_MODAL_DIALOG_SELECTOR) !== null);
}

/**
 * True when pressing Alt+Q should open the global Quick Capture dialog:
 * only when the `notes` module is active, the user is authenticated (and can write),
 * no modal dialog is open, and focus/target is not inside an `<input>`, `<textarea>`, `<select>`, or `[contenteditable]`.
 */
export function isQuickCaptureShortcut(
  event: QuickCaptureKeyLike,
  opts: {
    notesEnabled: boolean;
    authenticated: boolean;
    canWrite?: boolean | undefined;
    modalOpen?: boolean | undefined;
    activeElement?: unknown;
  },
): boolean {
  if (!opts.notesEnabled || !opts.authenticated || opts.canWrite === false || opts.modalOpen) return false;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return false;
  if (event.defaultPrevented || event.isComposing) return false;
  const isQ = event.code === 'KeyQ' || event.key.toLowerCase() === 'q';
  if (!isQ) return false;
  if (
    isEditableTarget(opts.activeElement) ||
    isEditableTarget(event.target) ||
    isInOpenDialog(opts.activeElement) ||
    isInOpenDialog(event.target)
  ) {
    return false;
  }
  return true;
}

/**
 * Adjusts previously dismissed token spans when the user edits `prevInput` -> `nextInput`,
 * keeping dismissed spans valid across prefix/suffix edits and clearing any span whose text changed.
 */
export function shiftDismissedTokens(
  prevInput: string,
  nextInput: string,
  dismissed: readonly TodoQuickAddToken[],
): TodoQuickAddToken[] {
  if (dismissed.length === 0 || prevInput === nextInput) return [...dismissed];
  if (nextInput.trim() === '') return [];

  let prefix = 0;
  const minLen = Math.min(prevInput.length, nextInput.length);
  while (prefix < minLen && prevInput[prefix] === nextInput[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    prevInput[prevInput.length - 1 - suffix] === nextInput[nextInput.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const editEndPrev = prevInput.length - suffix;
  const delta = nextInput.length - prevInput.length;

  const nextDismissed: TodoQuickAddToken[] = [];
  for (const tok of dismissed) {
    if (tok.end <= prefix) {
      if (nextInput.slice(tok.start, tok.end) === tok.raw) nextDismissed.push(tok);
    } else if (tok.start >= editEndPrev) {
      const shiftedStart = tok.start + delta;
      const shiftedEnd = tok.end + delta;
      if (shiftedStart >= 0 && nextInput.slice(shiftedStart, shiftedEnd) === tok.raw) {
        nextDismissed.push({ ...tok, start: shiftedStart, end: shiftedEnd });
      }
    }
  }
  return nextDismissed;
}

/**
 * Builds the `notes.todos.create` payload from a parsed Quick Add input.
 *
 * Maps parsed `dueOn`, `dueTime`, `reminder`, and `recurrence` into `zTodoCreate`, stripping
 * `'date'`, `'time'`, and `'recurrence'` spans from `title` while keeping `#3558` tokens
 * (`priority`, `#tag`, `/List`) intact in `title` until those DB columns land.
 */
export function buildTodoCreatePayload(
  input: string,
  parsed: TodoQuickAddResult,
  now: Date = new Date(),
): TodoCreateInput | null {
  const consumedSpans = parsed.tokens.filter((t) => t.kind === 'date' || t.kind === 'time' || t.kind === 'recurrence');
  const title = buildTitleWithoutSpans(input, consumedSpans).slice(0, TODO_TITLE_MAX).trim();
  if (title === '') return null;

  const dueOn = parsed.dueOn;
  const dueTime = dueOn !== null ? parsed.dueTime : null;
  // Require a 15s skew buffer so slight client/server clock drift falls back cleanly to `'auto'` rather than 400 TODO_REMINDER_PAST.
  const reminder: TodoCreateInput['reminder'] =
    dueOn !== null && parsed.remindAt !== null && Date.parse(parsed.remindAt) > now.getTime() + 15_000
      ? { at: parsed.remindAt }
      : 'auto';

  return {
    title,
    dueOn,
    dueTime,
    timeZone: parsed.timeZone,
    reminder,
    ...(parsed.recurrence !== null ? { recurrence: parsed.recurrence } : {}),
  };
}

export const QUICK_ADD_WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type QuickAddRecurrenceTranslator = ((
  key:
    | 'quickAddRecurDaily'
    | 'quickAddRecurWeekly'
    | 'quickAddRecurMonthly'
    | 'quickAddRecurMonthlyLast',
) => string) &
  ((
    key:
      | 'quickAddRecurEveryDays'
      | 'quickAddRecurEveryWeeks'
      | 'quickAddRecurEveryMonths',
    values: { interval: string },
  ) => string) &
  ((key: 'quickAddRecurWeeklyOn', values: { weekday: string }) => string) &
  ((key: 'quickAddRecurMonthlyDay', values: { day: string }) => string) &
  ((key: `weekdays.${(typeof QUICK_ADD_WEEKDAY_KEYS)[number]}`) => string);

/** Formats a parsed recurrence rule into a localized preview chip label. */
export function formatQuickAddRecurrenceLabel(
  rule: TodoQuickAddRecurrence,
  t: QuickAddRecurrenceTranslator,
): string {
  if (rule.freq === 'daily') {
    return rule.interval === 1 ? t('quickAddRecurDaily') : t('quickAddRecurEveryDays', { interval: String(rule.interval) });
  }
  if (rule.freq === 'weekly') {
    if (rule.byWeekday !== undefined) {
      const dayKey = QUICK_ADD_WEEKDAY_KEYS[rule.byWeekday] ?? 'mon';
      return t('quickAddRecurWeeklyOn', { weekday: t(`weekdays.${dayKey}`) });
    }
    return rule.interval === 1 ? t('quickAddRecurWeekly') : t('quickAddRecurEveryWeeks', { interval: String(rule.interval) });
  }
  if (rule.byMonthDay === -1) return t('quickAddRecurMonthlyLast');
  if (rule.byMonthDay !== undefined) return t('quickAddRecurMonthlyDay', { day: String(rule.byMonthDay) });
  return rule.interval === 1 ? t('quickAddRecurMonthly') : t('quickAddRecurEveryMonths', { interval: String(rule.interval) });
}
