// A note's Markdown (issue #1671, notes plan §3.6): headings, paragraphs, lists, checklists, bold, italics, inline code
// and links, rendered as React elements. Nothing is parsed as HTML, so raw HTML in a note shows as its text (the app
// has no HTML sink, apps/app/test/trusted-types.test.ts). Links open only http, https and mailto addresses, in a new
// tab with rel="noopener noreferrer nofollow"; images are not rendered (no remote image, so no tracking pixel).
import type { ReactNode } from 'react';
import { Button } from '@crove/ui/components/button';
import { INLINE_MARKDOWN, cleanNoteLineText } from './notes.ts';

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function renderInline(text: string, keyPrefix = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE_MARKDOWN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = `${keyPrefix}-${n++}`;
    if (m[1] !== undefined) out.push(<strong key={key}>{m[1]}</strong>);
    else if (m[2] !== undefined) out.push(<code key={key} className="rounded bg-muted px-1 font-mono text-[0.9em]">{m[2]}</code>);
    else if (m[3] !== undefined && m[4] !== undefined) {
      out.push(
        SAFE_URL.test(m[4]) ? (
          <a key={key} href={m[4]} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline">
            {m[3]}
          </a>
        ) : (
          m[0]
        ),
      );
    } else out.push(<em key={key}>{m[5] ?? m[6]}</em>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: Array<{ text: string; checked: boolean | null }> };

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const TASK = /^\[( |x|X)\]\s+(.*)$/;

export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
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
      const item = { text: task?.[2] ?? raw, checked: task ? task[1] !== ' ' : null };
      if (last?.kind === 'list' && last.ordered === ordered) last.items.push(item);
      else blocks.push({ kind: 'list', ordered, items: [item] });
    } else if (last?.kind === 'paragraph') {
      last.lines.push(line);
    } else {
      blocks.push({ kind: 'paragraph', lines: [line] });
    }
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

export function Markdown({ text, onMakeTodo, makeTodoLabel = '', makeTodoAriaLabel, makeTodoDisabled }: MarkdownProps) {
  return (
    <div className="space-y-3 text-sm leading-relaxed break-words text-foreground">
      {parseBlocks(text).map((block, i) => {
        if (block.kind === 'heading') {
          // Inside a note, below the page's own headings: shown as headings, not outline levels of the page.
          const heading = (
            <p key={onMakeTodo ? undefined : i} className={HEADING_CLASS[block.level]}>
              {renderInline(block.text, `h${i}`)}
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
                renderInline(item.text, `l${i}-${j}`)
              ) : (
                // A labelled, read-only checkbox: a screen reader hears the step and whether it is done.
                <label className="flex items-start gap-2">
                  <input type="checkbox" checked={item.checked} readOnly disabled className="mt-1" />
                  <span className={item.checked ? 'text-muted-foreground line-through' : undefined}>{renderInline(item.text, `l${i}-${j}`)}</span>
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
              {renderInline(block.lines.join('\n'), `p${i}`)}
            </p>
          );
        }
        return (
          <div key={i} className="space-y-1">
            {block.lines.map((line, j) => (
              <div key={j} className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 flex-1">{renderInline(line, `p${i}-${j}`)}</p>
                <MakeTodoButton raw={line} onMakeTodo={onMakeTodo} label={makeTodoLabel} ariaLabel={makeTodoAriaLabel} disabled={makeTodoDisabled} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
