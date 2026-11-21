// SPDX-License-Identifier: AGPL-3.0-only
// A note's Markdown (issue #1671, #3559, notes plan §3.6, notes-v2.md V2-4): headings, paragraphs, fenced code blocks,
// lists, interactive checklists, [[Note]] wiki-links, bold, italics, inline code and safe external links, rendered as
// React elements. Nothing is parsed as HTML, so raw HTML in a note shows as its text (trusted-types.test.ts).
import type { ReactNode } from 'react';
import { Button } from '@crove/ui/components/button';
import {
  INLINE_MARKDOWN,
  cleanNoteLineText,
  fenceMarkerOfLine,
  isClosingFenceLine,
  parseWikiLinkToken,
} from './notes.ts';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export interface ResolvedWikiLink {
  href?: string;
  onClick?: () => void;
  label?: string;
  available: boolean;
}

export type WikiLinkResolver = (target: { noteId?: string; title: string }) => ResolvedWikiLink | null;

function renderFormattedSpan(text: string, keyPrefix: string, startIndex: number): { nodes: ReactNode[]; nextIndex: number } {
  const nodes: ReactNode[] = [];
  let last = 0;
  let n = startIndex;
  for (const m of text.matchAll(INLINE_MARKDOWN)) {
    const at = m.index ?? 0;
    if (at > last) nodes.push(text.slice(last, at));
    const key = `${keyPrefix}-${n++}`;
    if (m[1] !== undefined) nodes.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) nodes.push(<code key={key} className="rounded bg-muted px-1 font-mono text-[0.9em]">{m[2]}</code>);
    else if (m[3] !== undefined && m[4] !== undefined) {
      nodes.push(
        SAFE_URL.test(m[4]) ? (
          <a key={key} href={m[4]} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline">
            {m[3]}
          </a>
        ) : (
          m[0]
        ),
      );
    } else nodes.push(<em key={key}>{m[5] ?? m[6]}</em>);
    last = at + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return { nodes, nextIndex: n };
}

export function renderInline(text: string, keyPrefix = 'i', resolveWikiLink?: WikiLinkResolver): ReactNode[] {
  if (!text.includes('[[') && !text.includes('`')) {
    return renderFormattedSpan(text, keyPrefix, 0).nodes;
  }
  const out: ReactNode[] = [];
  let plainStart = 0;
  let i = 0;
  let n = 0;

  const flushPlain = (to: number) => {
    if (to <= plainStart) return;
    const chunk = text.slice(plainStart, to);
    const rendered = renderFormattedSpan(chunk, keyPrefix, n);
    out.push(...rendered.nodes);
    n = rendered.nextIndex;
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === '`') {
      let ticks = 1;
      while (i + ticks < text.length && text[i + ticks] === '`') ticks++;
      const delim = '`'.repeat(ticks);
      const close = text.indexOf(delim, i + ticks);
      if (close !== -1) {
        flushPlain(i);
        const codeText = text.slice(i + ticks, close);
        out.push(
          <code key={`${keyPrefix}-${n++}`} className="rounded bg-muted px-1 font-mono text-[0.9em]">
            {codeText}
          </code>,
        );
        i = close + ticks;
        plainStart = i;
        continue;
      }
      i += ticks;
      continue;
    }
    if (ch === '[' && text[i + 1] === '[') {
      const nl = text.indexOf('\n', i + 2);
      const close = text.indexOf(']]', i + 2);
      if (close !== -1 && (nl === -1 || close < nl) && close - (i + 2) <= 260) {
        const inner = text.slice(i + 2, close);
        const parsed = parseWikiLinkToken(inner);
        if (parsed !== null) {
          flushPlain(i);
          const resolved = resolveWikiLink ? resolveWikiLink(parsed) : null;
          const display = resolved?.label || parsed.title || parsed.noteId || inner;
          const key = `${keyPrefix}-${n++}`;
          if (resolved && resolved.available) {
            out.push(
              <a
                key={key}
                href={resolved.href ?? '#'}
                onClick={(e) => {
                  if (resolved.onClick) {
                    e.preventDefault();
                    resolved.onClick();
                  }
                }}
                data-testid="note-wiki-link"
                className="rounded bg-muted/60 px-1 font-medium text-link underline"
              >
                {display}
              </a>,
            );
          } else {
            out.push(
              <span key={key} data-testid="note-wiki-unresolved" className="rounded bg-muted px-1 text-muted-foreground">
                [[{display}]]
              </span>,
            );
          }
          i = close + 2;
          plainStart = i;
          continue;
        }
      }
    }
    i++;
  }
  flushPlain(text.length);
  return out;
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'code'; code: string; lang: string }
  | { kind: 'list'; ordered: boolean; items: Array<{ text: string; checked: boolean | null; lineIndex: number }> };

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const TASK = /^\[( |x|X)\]\s+(.*)$/;

// Deterministic O(n) toggle of a single task-list line in Markdown source, ignoring fenced code blocks.
export function toggleMarkdownTaskLine(body: string, lineIndex: number, nextChecked: boolean): string | null {
  if (!Number.isInteger(lineIndex) || lineIndex < 0) return null;
  const lines = body.split('\n');
  if (lineIndex >= lines.length) return null;

  let activeFence: { char: '`' | '~'; len: number } | null = null;
  for (let idx = 0; idx < lineIndex; idx++) {
    const raw = lines[idx]!;
    const clean = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (activeFence !== null) {
      if (isClosingFenceLine(clean, activeFence)) activeFence = null;
    } else {
      activeFence = fenceMarkerOfLine(clean);
    }
  }
  if (activeFence !== null) return null;

  const targetRaw = lines[lineIndex]!;
  const hasCr = targetRaw.endsWith('\r');
  const line = hasCr ? targetRaw.slice(0, -1) : targetRaw;
  if (fenceMarkerOfLine(line) !== null) return null;

  let p = 0;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) p++;
  const bullet = line[p];
  if (bullet !== '-' && bullet !== '*' && bullet !== '+') return null;
  p++;
  const spaceStart = p;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) p++;
  if (p === spaceStart) return null;
  if (line[p] !== '[' || line[p + 2] !== ']') return null;
  const mark = line[p + 1];
  if (mark !== ' ' && mark !== 'x' && mark !== 'X') return null;
  if (line[p + 3] !== ' ' && line[p + 3] !== '\t') return null;

  const updated = `${line.slice(0, p)}[${nextChecked ? 'x' : ' '}]${line.slice(p + 3)}${hasCr ? '\r' : ''}`;
  const nextLines = [...lines];
  nextLines[lineIndex] = updated;
  return nextLines.join('\n');
}

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let activeFence: { char: '`' | '~'; len: number; lang: string; codeLines: string[] } | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex]!;
    if (activeFence !== null) {
      if (isClosingFenceLine(line, activeFence)) {
        blocks.push({ kind: 'code', code: activeFence.codeLines.join('\n'), lang: activeFence.lang });
        activeFence = null;
      } else {
        activeFence.codeLines.push(line);
      }
      continue;
    }
    const opened = fenceMarkerOfLine(line);
    if (opened !== null) {
      const lang = line.trim().slice(opened.len).trim();
      activeFence = { ...opened, lang, codeLines: [] };
      continue;
    }

    const last = blocks.at(-1);
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (line.trim() === '') {
      blocks.push({ kind: 'paragraph', lines: [] });
    } else if (heading?.[1] && heading[2] !== undefined) {
      blocks.push({ kind: 'heading', level: heading[1].length as 1 | 2 | 3, text: heading[2] });
    } else if (bullet || numbered) {
      const ordered = numbered !== null;
      const raw = (bullet ?? numbered)?.[1] ?? '';
      const task = ordered ? null : TASK.exec(raw);
      const item = { text: task?.[2] ?? raw, checked: task ? task[1] !== ' ' : null, lineIndex };
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: 'list', ordered, items: [item] });
    } else if (last?.kind === 'paragraph') {
      last.lines.push(line);
    } else {
      blocks.push({ kind: 'paragraph', lines: [line] });
    }
  }
  if (activeFence !== null) {
    blocks.push({ kind: 'code', code: activeFence.codeLines.join('\n'), lang: activeFence.lang });
  }
  return blocks.filter((b) => b.kind !== 'paragraph' || b.lines.length > 0);
}

const HEADING_CLASS = { 1: 'text-lg font-semibold', 2: 'text-base font-semibold', 3: 'text-sm font-semibold' } as const;

interface MarkdownProps {
  text: string;
  onMakeTodo?: ((title: string) => void) | undefined;
  makeTodoLabel?: string | undefined;
  makeTodoAriaLabel?: ((title: string) => string) | undefined;
  makeTodoDisabled?: boolean | undefined;
  onToggleTask?: ((lineIndex: number, nextChecked: boolean) => void) | undefined;
  toggleTaskDisabled?: boolean | undefined;
  resolveWikiLink?: WikiLinkResolver | undefined;
}

function MakeTodoButton({
  raw,
  onMakeTodo,
  label,
  ariaLabel,
  disabled,
}: {
  raw: string;
  onMakeTodo: (title: string) => void;
  label: string;
  ariaLabel?: ((title: string) => string) | undefined;
  disabled?: boolean | undefined;
}) {
  const title = cleanNoteLineText(raw);
  if (!title) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={disabled}
      onClick={() => onMakeTodo(title)}
      aria-label={ariaLabel ? ariaLabel(title) : label}
      data-testid="note-line-make-todo"
      className="shrink-0 text-subtle-foreground hover:text-foreground"
    >
      {label}
    </Button>
  );
}

export function Markdown({
  text,
  onMakeTodo,
  makeTodoLabel = '',
  makeTodoAriaLabel,
  makeTodoDisabled,
  onToggleTask,
  toggleTaskDisabled,
  resolveWikiLink,
}: MarkdownProps) {
  return (
    <div className="space-y-3 text-sm leading-relaxed break-words text-foreground">
      {parseBlocks(text).map((block, i) => {
        if (block.kind === 'code') {
          return (
            <pre key={i} data-testid="note-code-block" className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs text-foreground">
              <code>{block.code}</code>
            </pre>
          );
        }
        if (block.kind === 'heading') {
          // Inside a note, below the page's own headings: shown as headings, not outline levels of the page.
          const heading = (
            <p key={onMakeTodo ? undefined : i} className={HEADING_CLASS[block.level]}>
              {renderInline(block.text, `h${i}`, resolveWikiLink)}
            </p>
          );
          if (!onMakeTodo) return heading;
          return (
            <div key={i} className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">{heading}</div>
              <MakeTodoButton raw={block.text} onMakeTodo={onMakeTodo} label={makeTodoLabel} ariaLabel={makeTodoAriaLabel} disabled={makeTodoDisabled} />
            </div>
          );
        }
        if (block.kind === 'list') {
          const items = block.items.map((item, j) => {
            const content =
              item.checked === null ? (
                renderInline(item.text, `l${i}-${j}`, resolveWikiLink)
              ) : onToggleTask ? (
                <label className="flex cursor-pointer items-start gap-2 max-md:min-h-11 max-md:items-center">
                  <input
                    type="checkbox"
                    checked={item.checked}
                    disabled={toggleTaskDisabled}
                    onChange={(e) => onToggleTask(item.lineIndex, e.target.checked)}
                    data-testid="note-task-checkbox"
                    data-line-index={item.lineIndex}
                    className="mt-1 accent-primary max-md:mt-0 max-md:size-5"
                  />
                  <span className={item.checked ? 'text-muted-foreground line-through' : undefined}>
                    {renderInline(item.text, `l${i}-${j}`, resolveWikiLink)}
                  </span>
                </label>
              ) : (
                // A labelled, read-only checkbox: a screen reader hears the step and whether it is done.
                <label className="flex items-start gap-2 max-md:min-h-11 max-md:items-center">
                  <input type="checkbox" checked={item.checked} readOnly disabled className="mt-1 max-md:mt-0" />
                  <span className={item.checked ? 'text-muted-foreground line-through' : undefined}>
                    {renderInline(item.text, `l${i}-${j}`, resolveWikiLink)}
                  </span>
                </label>
              );
            return (
              <li key={j} className={item.checked === null ? undefined : 'list-none'}>
                {onMakeTodo ? (
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">{content}</div>
                    <MakeTodoButton raw={item.text} onMakeTodo={onMakeTodo} label={makeTodoLabel} ariaLabel={makeTodoAriaLabel} disabled={makeTodoDisabled} />
                  </div>
                ) : (
                  content
                )}
              </li>
            );
          });
          return block.ordered ? (
            <ol key={i} className="list-decimal space-y-1 pl-5">
              {items}
            </ol>
          ) : (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {items}
            </ul>
          );
        }
        if (!onMakeTodo) {
          return (
            <p key={i} className="whitespace-pre-line">
              {renderInline(block.lines.join('\n'), `p${i}`, resolveWikiLink)}
            </p>
          );
        }
        return (
          <div key={i} className="space-y-1">
            {block.lines.map((line, j) => (
              <div key={j} className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 flex-1">{renderInline(line, `p${i}-${j}`, resolveWikiLink)}</p>
                <MakeTodoButton raw={line} onMakeTodo={onMakeTodo} label={makeTodoLabel} ariaLabel={makeTodoAriaLabel} disabled={makeTodoDisabled} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
