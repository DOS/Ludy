// SPDX-License-Identifier: AGPL-3.0-only
// A member's own notes and to-dos as a file for their download (#1678, #3559, notes.md section 5 "Tải về"): Markdown to read,
// JSON to move them elsewhere. Built in the browser from notes.mine.export; no React imports, so it is unit tested.
import type { NotesExport } from '@crove/kernel-contract';

export interface NotesExportWords {
  heading: string;
  exportedAt: string;
  notes: string;
  notebooks?: string;
  notebook?: string;
  stack?: string;
  todos: string;
  todoLists: string;
  private: string;
  shared: string;
  tags: string;
  priority: string;
  list: string;
  sections: string;
  pinned: string;
  archived: string;
  trashed: string;
  created: string;
  updated: string;
  links: string;
  status: Record<NotesExport['todos'][number]['status'], string>;
  due: string;
  remind: string;
  done: string;
  truncated: string;
}

const line = (label: string, value: string) => `- ${label}: ${value}`;
const formatLinks = (label: string, links: { targetType: string; targetId: string }[]) =>
  line(label, links.map((l) => `${l.targetType} ${l.targetId}`).join(', '));
// A title or a step on one line, so a line break in it never starts a heading or an item of its own.
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

/** The Markdown file: each note under its title with its facts, then its body as written; each to-do with its steps. */
export function notesMarkdown(data: NotesExport, w: NotesExportWords): string {
  const listById = new Map(data.todoLists.map((l) => [l.id, l]));
  const notebookById = new Map((data.notebooks ?? []).map((b) => [b.id, b]));
  const out: string[] = [`# ${w.heading}`, '', line(w.exportedAt, data.exportedAt)];
  if (data.truncated) out.push('', `> ${w.truncated}`);
  out.push('', `## ${w.notes} (${data.notes.length})`);
  for (const n of data.notes) {
    out.push('', `### ${flat(n.title)}`, '', line(n.visibility === 'org' ? w.shared : w.private, n.id));
    if (n.notebookId && w.notebook) {
      const nb = notebookById.get(n.notebookId);
      const nbLabel = nb ? (nb.stackName ? `${flat(nb.stackName)} / ${flat(nb.name)}` : flat(nb.name)) : n.notebookId;
      out.push(line(w.notebook, nbLabel));
    }
    if (n.tags.length > 0) out.push(line(w.tags, n.tags.join(', ')));
    if (n.pinned) out.push(`- ${w.pinned}`);
    if (n.archivedAt) out.push(line(w.archived, n.archivedAt));
    if (n.deletedAt) out.push(line(w.trashed, n.deletedAt));
    out.push(line(w.created, n.createdAt), line(w.updated, n.updatedAt));
    if (n.links.length > 0) out.push(formatLinks(w.links, n.links));
    if (n.body.trim()) out.push('', n.body.trimEnd());
  }
  if (data.notebooks && data.notebooks.length > 0 && w.notebooks) {
    out.push('', `## ${w.notebooks} (${data.notebooks.length})`);
    for (const b of data.notebooks) {
      out.push('', `### ${flat(b.name)}`, '', line(b.visibility === 'org' ? w.shared : w.private, b.id));
      if (b.stackName && w.stack) out.push(line(w.stack, flat(b.stackName)));
      if (b.pinned) out.push(`- ${w.pinned}`);
      out.push(line(w.created, b.createdAt), line(w.updated, b.updatedAt));
    }
  }
  out.push('', `## ${w.todos} (${data.todos.length})`);
  for (const t of data.todos) {
    out.push('', `### [${t.status === 'done' ? 'x' : ' '}] ${flat(t.title)}`, '', line(w.status[t.status], t.id));
    if (t.priority < 4) out.push(line(w.priority, `P${t.priority}`));
    if (t.listId) {
      const list = listById.get(t.listId);
      const section = list && t.sectionId ? list.sections.find((s) => s.id === t.sectionId) : undefined;
      const listLabel = list ? (section ? `${flat(list.name)} / ${flat(section.name)}` : flat(list.name)) : t.listId;
      out.push(line(w.list, listLabel));
    }
    if (t.tags.length > 0) out.push(line(w.tags, t.tags.join(', ')));
    if (t.dueAt) out.push(line(w.due, `${t.dueAt} (${t.timeZone})`));
    else if (t.dueOn) out.push(line(w.due, t.dueOn));
    if (t.remindAt) out.push(line(w.remind, t.remindAt));
    if (t.doneAt) out.push(line(w.done, t.doneAt));
    if (t.deletedAt) out.push(line(w.trashed, t.deletedAt));
    out.push(line(w.created, t.createdAt), line(w.updated, t.updatedAt));
    if (t.links.length > 0) out.push(formatLinks(w.links, t.links));
    if (t.details.trim()) out.push('', t.details.trimEnd());
    if (t.checklist.length > 0) out.push('', ...t.checklist.map((s) => `- [${s.done ? 'x' : ' '}] ${flat(s.text)}`));
  }
  if (data.todoLists.length > 0) {
    out.push('', `## ${w.todoLists} (${data.todoLists.length})`);
    for (const l of data.todoLists) {
      out.push('', `### ${flat(l.name)}`, '', line(w.list, l.id));
      if (l.sections.length > 0) out.push(line(w.sections, l.sections.map((s) => flat(s.name)).join(', ')));
      if (l.deletedAt) out.push(line(w.trashed, l.deletedAt));
      out.push(line(w.created, l.createdAt), line(w.updated, l.updatedAt));
    }
  }
  return `${out.join('\n')}\n`;
}

/** Saves text as a file through a link the browser clicks. */
export function saveText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Some browsers still read the link a moment after the click.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
