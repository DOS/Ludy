// SPDX-License-Identifier: AGPL-3.0-only
// The title of a task as it is shown (#4370). A tainted task's title is an AI coworker's text (a person approved the ask, reading the Inbox card, which writes the direction marks, the zero-width and the other
// invisible characters out as <U+202E> and the like): shown the same way here (the set of characters is the card's own, see packages/kernel/src/engage-view.ts, but for the zero-width joiner and non-joiner,
// which emoji and some scripts need), in the task list, the task page, the task panel, My work, the project board and the thread's task list, so a title cannot reorder the line around it or hide part of itself
// where nobody reads a card. A person's own title is shown as typed. Not covered yet: the notifications (their read has no taint flag), the project's weekly status and the pickers (#4370 follow-up).
const hidden = (code: number): boolean =>
  code <= 0x08 ||
  (code >= 0x0b && code <= 0x1f) ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x00ad ||
  code === 0x061c ||
  code === 0x180e ||
  code === 0x200b ||
  (code >= 0x200e && code <= 0x200f) ||
  code === 0x2028 ||
  code === 0x2029 ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2060 && code <= 0x206f) ||
  code === 0xfeff ||
  (code >= 0xfff9 && code <= 0xfffb) ||
  (code >= 0xe0000 && code <= 0xe007f);

const visibleCode = (text: string): string =>
  Array.from(text)
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return hidden(code) ? `\u27e8U+${code.toString(16).toUpperCase().padStart(4, '0')}\u27e9` : ch;
    })
    .join('');

export const taskTitleText = (task: { title: string; tainted?: boolean | undefined }): string => (task.tainted ? visibleCode(task.title) : task.title);
