// SPDX-License-Identifier: AGPL-3.0-only
// The title of a task as it is shown (#4370). A tainted task's title is an AI coworker's text (a person approved the ask, reading the Inbox card, which writes the direction marks, the zero-width and the other
// invisible characters out as <U+202E> and the like): shown the same way here, in the task list, on the task page and in the thread's panel, so a title cannot reorder the line around it or hide part of itself
// where nobody reads a card. A person's own title is shown as typed (the zero-width joiner stays for emoji).
import { visibleBidi } from './ads-change.ts';

export const taskTitleText = (task: { title: string; tainted?: boolean | undefined }): string => (task.tainted ? visibleBidi(task.title) : task.title);
