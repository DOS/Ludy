// "Việc của tôi" (My work, issues #1673 and #1674, notes plan docs/plan/notes.md §3.10): the member's own to-dos and
// the open tasks of the positions they hold, grouped by the due day (the kernel works the group out), the to-dos in the
// member's own order. The pure parts of the screen live here: the groups, the keyboard shortcuts, where a move puts a
// to-do and the text a hand-over proposes.
import { DEFAULT_TIME_ZONE, TODO_DUE_GROUPS, isTimeZone, type MyWorkTask, type TodoDueGroup, type TodoListSection, type TodoStep, type TodoSummary } from '@crove/kernel-contract';

export interface TodoGroup {
  id: TodoDueGroup;
  items: TodoSummary[];
  // The team tasks of the group (#1674), after the to-dos, soonest first as the kernel sends them.
  tasks: MyWorkTask[];
}

export interface TodoSectionGroup {
  id: string | null;
  name: string | null;
  items: TodoSummary[];
}

export interface MyWorkProjectOption {
  id: string;
  name: string;
}

/** Distinct projects represented in My work tasks, sorted by project name. */
export function myWorkProjects(tasks: readonly MyWorkTask[]): MyWorkProjectOption[] {
  const byId = new Map<string, string>();
  for (const task of tasks) {
    if (task.project && !byId.has(task.project.id)) byId.set(task.project.id, task.project.name);
  }
  return [...byId.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Filters My work open items by project:
 * - '' (all): keeps all personal to-dos and all team tasks.
 * - 'none': keeps only team tasks not in any project.
 * - <projectId>: keeps only team tasks belonging to that project.
 */
export function filterMyWork(
  todos: readonly TodoSummary[],
  tasks: readonly MyWorkTask[],
  projectFilter: string,
): { todos: TodoSummary[]; tasks: MyWorkTask[] } {
  if (!projectFilter) return { todos: [...todos], tasks: [...tasks] };
  if (projectFilter === 'none') {
    return { todos: [], tasks: tasks.filter((t) => t.project === null) };
  }
  return { todos: [], tasks: tasks.filter((t) => t.project?.id === projectFilter) };
}

/** The open to-dos and tasks in the groups of My work, in group order and, within a group, in the list's own order. */
export function groupTodos(todos: readonly TodoSummary[], tasks: readonly MyWorkTask[] = []): TodoGroup[] {
  return TODO_DUE_GROUPS.map((id) => ({ id, items: todos.filter((t) => (t.group ?? 'none') === id), tasks: tasks.filter((t) => t.group === id) })).filter(
    (g) => g.items.length > 0 || g.tasks.length > 0,
  );
}

/** Groups a personal list's to-dos into its sections in section order, plus unsectioned items (or orphaned sectionIds). */
export function groupTodosBySection(todos: readonly TodoSummary[], sections: readonly TodoListSection[]): TodoSectionGroup[] {
  const validIds = new Set(sections.map((s) => s.id));
  const unsectioned = todos.filter((t) => t.sectionId === null || !validIds.has(t.sectionId));
  const out: TodoSectionGroup[] = [];
  if (unsectioned.length > 0 || sections.length === 0) {
    out.push({ id: null, name: null, items: unsectioned });
  }
  for (const s of sections) {
    out.push({ id: s.id, name: s.name, items: todos.filter((t) => t.sectionId === s.id) });
  }
  return out;
}

/**
 * The description a hand-over proposes (#1674): the to-do's details, then its steps as a list. The member reads and may
 * edit it in the confirm dialog before the team sees it. Cut to the description's limit.
 */
export function handOverDescription(todo: { details: string; checklist: readonly TodoStep[] }, max = 10_000): string {
  const steps = todo.checklist.map((s) => `- [${s.done ? 'x' : ' '}] ${s.text}`).join('\n');
  const text = [todo.details.trim(), steps].filter((part) => part !== '').join('\n\n');
  return text.slice(0, max);
}

/** The browser's time zone, which a new to-do's due day is read in; Vietnam's when the browser names none we know. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Where moving a to-do one place up or down its group puts it: right before the one above it, or right after the one
 * below. Null at the group's top or bottom.
 */
export function moveTarget(group: readonly TodoSummary[], id: string, direction: 'up' | 'down'): { place: 'before' | 'after'; anchorId: string } | null {
  const at = group.findIndex((t) => t.id === id);
  if (at < 0) return null;
  const neighbor = group[direction === 'up' ? at - 1 : at + 1];
  return neighbor ? { place: direction === 'up' ? 'before' : 'after', anchorId: neighbor.id } : null;
}

// The shortcuts of the screen (DESIGN.md §5.2): N a new to-do, J and K the next and previous one, X done, E edit.
export type MyWorkAction = 'new' | 'next' | 'previous' | 'done' | 'edit';
const KEYS: Readonly<Record<string, MyWorkAction>> = { n: 'new', j: 'next', k: 'previous', x: 'done', e: 'edit' };

interface KeyLike {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  target: EventTarget | null;
}

// A field, a list box or anything editable takes its own keys.
function typing(target: EventTarget | null): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown; closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable === true) return true;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true;
  return typeof el.closest === 'function' && el.closest('[role="dialog"], [contenteditable="true"]') !== null;
}

/** The action a key press asks for, or null: none for a key typed in a field, with a modifier or held down. */
export function myWorkShortcut(event: KeyLike): MyWorkAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat || typing(event.target)) return null;
  return KEYS[event.key.toLowerCase()] ?? null;
}

/** The id one step from `current` in `order` (the first or the last when nothing is selected yet). */
export function stepSelection(order: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return step === 1 ? (order[0] as string) : (order[order.length - 1] as string);
  return order[Math.min(order.length - 1, Math.max(0, at + step))] as string;
}
