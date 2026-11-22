// SPDX-License-Identifier: AGPL-3.0-only
// The title of a task as it is shown (#4370). A tainted task's title is an AI coworker's text (a person approved the ask, reading the Inbox card, which writes the direction marks, the zero-width and the other
// invisible characters out as <U+202E> and the like): shown the same way here, with the set of characters the card uses (the one class of the contract, markHiddenText, #4423) but for the zero-width joiner and non-joiner,
// which emoji and some scripts need, in the task list, the task page, the task panel, My work, the project board, the thread's task list, the task_assigned and task_rerouted notices, the project's weekly status, the project
// task picker, the duplicate hint, the note-links picker and the acceptance handover copy (#4421), so a title cannot reorder the line around it or hide part of itself where nobody reads a card. A person's own
// title is shown as typed.
import { markHiddenText } from '@ludy/kernel-contract';

const marked = (title: string): string => markHiddenText(title, { keepJoiners: true, open: '\u27e8', close: '\u27e9' });

export const taskTitleText = (task: { title: string; tainted?: boolean | undefined }): string => (task.tainted ? marked(task.title) : task.title);

// What the field of a title being edited says beside the raw value: the marked form of a tainted title that holds characters a person cannot see (null when there is nothing to say), so the person who edits it
// can see what it holds before they keep it (#4423).
export const taskTitleHidden = (task: { title: string; tainted?: boolean | undefined }): string | null => {
  if (!task.tainted) return null;
  const text = marked(task.title);
  return text === task.title ? null : text;
};
