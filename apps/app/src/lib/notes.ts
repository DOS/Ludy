// SPDX-License-Identifier: AGPL-3.0-only
// The notes screens' small rules (issue #1671, #3559, plan docs/plan/notes.md §3.9 and §3.10, docs/plan/notes-v2.md V2-4).
import {
  NOTE_LIST_VIEWS,
  NOTE_TAGS_MAX,
  NOTE_TAG_MAX,
  NOTE_TITLE_MAX,
  NOTEBOOK_STACK_MAX,
  TODO_TITLE_MAX,
  type NoteListView,
} from '@crove/kernel-contract';

// Tags as typed, separated by commas: trimmed, lower case, each once, as many as a note keeps.
export function parseTags(input: string): string[] {
  const tags = input
    .split(',')
    .map((t) => t.trim().toLowerCase().slice(0, NOTE_TAG_MAX))
    .filter((t) => t !== '');
  return [...new Set(tags)].slice(0, NOTE_TAGS_MAX);
}

// A line that looks like it holds a password ("mật khẩu:", "password:", "pass:"): a note is not a password store, so
// the editor warns (notes.md §3.9). Marks are folded first, so "mat khau:" warns too.
export function looksLikePassword(text: string): boolean {
  // It runs on every keystroke, on up to 100,000 characters: a cheap look for "pass" or "kh..u" (marks composed or
  // not) first, and the fold only when one is there.
  if (!/pass|kh\S{0,3}u/i.test(text)) return false;
  const folded = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();
  return /(^|\s)(mat khau|password|pass)\s*[:=]/m.test(folded);
}

// ?note= opens a note and ?list= a list on the notes screen, ?tag= keeps the notes with that tag (#1739);
// ?notebook=unfiled|<uuid> and ?stack=<stack> filter by notebook or 2-level stack (#3559); ?q= searches.
export interface NotesSearch {
  note?: string;
  list?: NoteListView;
  notebook?: string;
  stack?: string;
  tag?: string;
  q?: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isNoteUuid(value: string): boolean {
  return ID.test(value);
}

export function normalizeWikiTitle(value: string): string {
  let out = '';
  let inSpace = false;
  const trimmed = value.trim();
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      if (!inSpace) {
        out += ' ';
        inSpace = true;
      }
    } else {
      out += ch;
      inSpace = false;
    }
  }
  return out.toLowerCase();
}

export function parseWikiLinkToken(inner: string): { noteId?: string; title: string } | null {
  if (inner.length === 0 || inner.length > 260 || inner.includes('[') || inner.includes('\n')) return null;
  const pipeIdx = inner.indexOf('|');
  if (pipeIdx !== -1) {
    const left = inner.slice(0, pipeIdx).trim();
    const right = inner.slice(pipeIdx + 1).trim();
    if (isNoteUuid(left)) {
      return { noteId: left.toLowerCase(), title: right.slice(0, NOTE_TITLE_MAX) };
    }
    if (left.length > 0 && left.length <= NOTE_TITLE_MAX) {
      return { title: left };
    }
    return null;
  }
  const trimmed = inner.trim();
  if (isNoteUuid(trimmed)) {
    return { noteId: trimmed.toLowerCase(), title: '' };
  }
  if (trimmed.length > 0 && trimmed.length <= NOTE_TITLE_MAX) {
    return { title: trimmed };
  }
  return null;
}

export function parseNotesSearch(search: Record<string, unknown>): NotesSearch {
  const out: NotesSearch = {};
  if (typeof search.note === 'string' && ID.test(search.note)) out.note = search.note.toLowerCase();
  if (typeof search.list === 'string' && (NOTE_LIST_VIEWS as readonly string[]).includes(search.list)) out.list = search.list as NoteListView;
  if (typeof search.notebook === 'string') {
    if (search.notebook === 'unfiled') out.notebook = 'unfiled';
    else if (ID.test(search.notebook)) out.notebook = search.notebook.toLowerCase();
  }
  if (!out.notebook && typeof search.stack === 'string') {
    const stack = search.stack.trim().slice(0, NOTEBOOK_STACK_MAX);
    if (stack !== '') out.stack = stack;
  }
  // One tag, as the server keeps it: trimmed and lower case. A comma belongs to the tag (one made through the API may
  // hold one), so it is not split as the tags field is.
  if (typeof search.tag === 'string') {
    const tag = search.tag.trim().toLowerCase().slice(0, NOTE_TAG_MAX);
    if (tag !== '') out.tag = tag;
  }
  if (typeof search.q === 'string' && search.q.trim() !== '') out.q = search.q.trim().slice(0, 200);
  return out;
}

// The list a note's tag chip shows: the one open when it holds the note, otherwise the one that does (the trash, the
// archive, the caller's own, or the shared notes), so the chip never opens a list without the note in it.
export function listOfNote(
  note: { mine: boolean; visibility: 'private' | 'org'; pinned: boolean; archivedAt: string | null; deletedAt: string | null },
  current: NoteListView | undefined,
): NoteListView {
  const holds = (list: NoteListView): boolean => {
    if (list === 'trash') return note.deletedAt !== null;
    if (note.deletedAt !== null) return false;
    if (list === 'archived') return note.archivedAt !== null;
    if (note.archivedAt !== null) return false;
    if (list === 'mine') return note.mine;
    if (list === 'shared') return note.visibility === 'org';
    return note.pinned;
  };
  if (current && holds(current)) return current;
  return (['trash', 'archived', 'mine', 'shared'] as const).find(holds) ?? 'mine';
}

// The tags of a list, most used first (then by name), for the filter's chips.
export function tagCounts(notes: ReadonlyArray<{ tags: readonly string[] }>, limit = 12): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const n of notes) for (const tag of n.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'vi'))
    .slice(0, limit);
}

// Same inline Markdown syntax as lib/markdown.tsx, stripped cleanly when turning a note line into a private to-do (#1676).
export const INLINE_MARKDOWN =
  /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|(?<![\p{L}\p{N}])_([^_]+)_(?![\p{L}\p{N}])|\*(\S(?:[^*]*\S)?)\*/gu;
const BLOCK_PREFIX = /^\s*(?:#{1,3}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;

function stripWikiLinksLinear(line: string): string {
  if (!line.includes('[[')) return line;
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '[' && line[i + 1] === '[') {
      const close = line.indexOf(']]', i + 2);
      if (close !== -1) {
        const parsed = parseWikiLinkToken(line.slice(i + 2, close));
        if (parsed) {
          out += parsed.title || parsed.noteId || '';
          i = close + 2;
          continue;
        }
      }
    }
    out += line[i]!;
    i++;
  }
  return out;
}

/** Turns a note line or selection into plain to-do title text, trimmed and clamped to TODO_TITLE_MAX. */
export function cleanNoteLineText(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) =>
      stripWikiLinksLinear(line.replace(BLOCK_PREFIX, ''))
        .replace(INLINE_MARKDOWN, (_, bold, code, link, _url, under, star) => String(bold ?? code ?? link ?? under ?? star ?? ''))
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((line) => line !== '');
  return lines.join(' ').trim().slice(0, TODO_TITLE_MAX).trim();
}

/** Extracts a to-do title from the active selection in a note editor, or the line at the cursor when collapsed. */
export function extractNoteTodoTitle(body: string, start: number, end: number): string {
  const len = body.length;
  const a = Math.max(0, Math.min(start, len));
  const b = Math.max(0, Math.min(end, len));
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo !== hi) return cleanNoteLineText(body.slice(lo, hi));
  const from = lo === 0 ? 0 : body.lastIndexOf('\n', lo - 1) + 1;
  const next = body.indexOf('\n', lo);
  return cleanNoteLineText(body.slice(from, next === -1 ? len : next));
}

export function fenceMarkerOfLine(line: string): { char: '`' | '~'; len: number } | null {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  const ch = line[i];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (i + len < line.length && line[i + len] === ch) len++;
  if (len < 3) return null;
  if (ch === '`') {
    for (let k = i + len; k < line.length; k++) {
      if (line[k] === '`') return null;
    }
  }
  return { char: ch, len };
}

export function isClosingFenceLine(line: string, fence: { char: '`' | '~'; len: number }): boolean {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  let len = 0;
  while (i + len < line.length && line[i + len] === fence.char) len++;
  if (len < fence.len) return false;
  for (let k = i + len; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

/** Finds an open `[[query` token before `cursor` on the current line when outside fenced or inline code. */
export function findActiveWikiAutocomplete(body: string, cursor: number): { from: number; query: string } | null {
  const pos = Math.max(0, Math.min(cursor, body.length));
  const lineStart = pos === 0 ? 0 : body.lastIndexOf('\n', pos - 1) + 1;
  const prefix = body.slice(0, lineStart);
  if (prefix.includes('```') || prefix.includes('~~~')) {
    const prevLines = prefix.split('\n');
    let fence: { char: '`' | '~'; len: number } | null = null;
    for (let idx = 0; idx < prevLines.length - 1; idx++) {
      const l = prevLines[idx]!.endsWith('\r') ? prevLines[idx]!.slice(0, -1) : prevLines[idx]!;
      if (fence !== null) {
        if (isClosingFenceLine(l, fence)) fence = null;
      } else {
        fence = fenceMarkerOfLine(l);
      }
    }
    if (fence !== null) return null;
  }

  const lineBeforeCursor = body.slice(lineStart, pos);
  if (fenceMarkerOfLine(lineBeforeCursor) !== null) return null;

  // Walk left-to-right on lineBeforeCursor skipping closed inline backtick spans and closed [[...]] tokens.
  let openAt = -1;
  let i = 0;
  while (i < lineBeforeCursor.length) {
    const ch = lineBeforeCursor[i];
    if (ch === '`') {
      let ticks = 1;
      while (i + ticks < lineBeforeCursor.length && lineBeforeCursor[i + ticks] === '`') ticks++;
      const delim = '`'.repeat(ticks);
      const close = lineBeforeCursor.indexOf(delim, i + ticks);
      if (close === -1) return null; // cursor is inside an unclosed inline code span
      i = close + ticks;
      continue;
    }
    if (ch === '[' && lineBeforeCursor[i + 1] === '[') {
      const close = lineBeforeCursor.indexOf(']]', i + 2);
      if (close !== -1) {
        i = close + 2;
        continue;
      }
      openAt = i;
      i += 2;
      continue;
    }
    if (openAt !== -1 && ch === '[') {
      openAt = -1;
    }
    i++;
  }
  if (openAt === -1) return null;
  const query = lineBeforeCursor.slice(openAt + 2);
  if (query.length > NOTE_TITLE_MAX || query.includes(']')) return null;
  return { from: lineStart + openAt, query };
}

/** Inserts a wiki-link at `[from, cursor]`, disambiguating with `[[id|Title]]` when multiple readable notes share a title. */
export function insertWikiLinkAt(
  body: string,
  from: number,
  cursor: number,
  target: { id: string; title: string },
  duplicateTitle = false,
): { value: string; caret: number } {
  const safeTitle = target.title.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
  // A title that had to change to fit in [[...]] no longer names its note, so the link keeps the id.
  const needsId = duplicateTitle || normalizeWikiTitle(safeTitle) !== normalizeWikiTitle(target.title);
  const token = safeTitle === '' ? `[[${target.id}]]` : needsId ? `[[${target.id}|${safeTitle}]]` : `[[${safeTitle}]]`;
  const after = body.slice(cursor);
  // Consume an immediately following `]]` if the user had typed a closing bracket pair already.
  const skipClose = after.startsWith(']]') ? 2 : 0;
  const nextValue = `${body.slice(0, from)}${token}${body.slice(cursor + skipClose)}`;
  return { value: nextValue, caret: from + token.length };
}
