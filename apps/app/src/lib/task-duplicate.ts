// SPDX-License-Identifier: AGPL-3.0-only
// The duplicate check of the new-task panel (#3606): while a person types a title, the tasks list is asked for the open tasks that
// contain it, and the one with the same title is shown under the field ("Đã có việc này") before anything is saved. The search is
// loose (a part of a word matches), so the answer is checked here against the whole title, ignoring case, spacing and the
// decomposed or composed form of a Vietnamese letter. No browser or API imports, so it is unit tested directly.
import type { FilterAst } from '@crove/kernel-contract';
import { OPEN_TASK_STATUSES, type TaskStatus } from './agents.ts';

// The tasks search takes a value of at most this many characters (the filter's own limit); a longer title is not looked up.
export const TASK_SEARCH_MAX = 100;
// A title of one or two letters would match half the list, so nothing is looked up until it is a little longer.
export const TASK_SEARCH_MIN = 3;

export type DuplicateTaskHit = { id: string; title: string; status: TaskStatus };

// A title in the form two titles are compared in.
export function normalizeTaskTitle(title: string): string {
  return title.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('vi');
}

// The search for the typed title, or null while it is too short or too long to look up.
export function duplicateTaskSearch(typed: string): FilterAst | null {
  const value = typed.trim();
  if (value.length < TASK_SEARCH_MIN || value.length > TASK_SEARCH_MAX) return null;
  return { v: 1, all: [{ field: 'search', op: 'contains', value }] };
}

// The first open task among the search results that has this title, or null.
export function findDuplicateTask(typed: string, hits: readonly DuplicateTaskHit[]): DuplicateTaskHit | null {
  const key = normalizeTaskTitle(typed);
  if (key === '') return null;
  return hits.find((hit) => (OPEN_TASK_STATUSES as readonly string[]).includes(hit.status) && normalizeTaskTitle(hit.title) === key) ?? null;
}
