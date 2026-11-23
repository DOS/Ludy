// SPDX-License-Identifier: AGPL-3.0-only
// Pure-React safe Markdown renderer for Public Roadmap Changelog entries (#4400, ADR-0057).
// Never injects raw HTML strings; renders headings, lists, paragraphs, bold, inline code, and strictly https:// links via React elements.
import { Fragment, type ReactNode } from 'react';

const INLINE_TOKEN_RE = /(\[[^\]]+\]\(https:\/\/[^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g;
const LINK_RE = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/;
const BOLD_RE = /^\*\*([^*]+)\*\*$/;
const CODE_RE = /^`([^`]+)`$/;

function safeHttpsHref(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function stripUnsafeControls(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code > 0x1f && code !== 0x7f) || code === 0x09 || code === 0x0a || code === 0x0d) out += text[i];
  }
  return out;
}

function renderInline(line: string): ReactNode[] {
  const cleaned = stripUnsafeControls(line);
  const parts = cleaned.split(INLINE_TOKEN_RE);
  return parts.map((part, idx) => {
    const linkMatch = LINK_RE.exec(part);
    if (linkMatch) {
      const href = safeHttpsHref(linkMatch[2]!);
      if (href) {
        return (
          <a
            key={idx}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline underline-offset-4 hover:opacity-80"
          >
            {linkMatch[1]!}
          </a>
        );
      }
      return <Fragment key={idx}>{linkMatch[1]!}</Fragment>;
    }
    const boldMatch = BOLD_RE.exec(part);
    if (boldMatch) {
      return (
        <strong key={idx} className="font-semibold text-foreground">
          {boldMatch[1]!}
        </strong>
      );
    }
    const codeMatch = CODE_RE.exec(part);
    if (codeMatch) {
      return (
        <code key={idx} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
          {codeMatch[1]!}
        </code>
      );
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

export function SafeRoadmapMarkdown({ markdown }: { markdown: string }) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let ulItems: string[] = [];
  let olItems: string[] = [];
  let keyIdx = 0;

  const flushLists = () => {
    if (ulItems.length > 0) {
      blocks.push(
        <ul key={`ul-${keyIdx++}`} className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
          {ulItems.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      ulItems = [];
    }
    if (olItems.length > 0) {
      blocks.push(
        <ol key={`ol-${keyIdx++}`} className="list-decimal space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
          {olItems.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ol>,
      );
      olItems = [];
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushLists();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushLists();
      const level = heading[1]!.length;
      const className =
        level === 1
          ? 'text-base font-semibold text-foreground'
          : level === 2
            ? 'text-sm font-semibold text-foreground'
            : 'text-sm font-medium text-foreground';
      blocks.push(
        <h3 key={`h-${keyIdx++}`} className={className}>
          {renderInline(heading[2]!)}
        </h3>,
      );
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    if (bullet) {
      if (olItems.length > 0) flushLists();
      ulItems.push(bullet[1]!);
      continue;
    }
    const ordered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (ordered) {
      if (ulItems.length > 0) flushLists();
      olItems.push(ordered[1]!);
      continue;
    }
    flushLists();
    blocks.push(
      <p key={`p-${keyIdx++}`} className="text-sm leading-relaxed text-muted-foreground">
        {renderInline(trimmed)}
      </p>,
    );
  }
  flushLists();

  return <div className="space-y-2.5 break-words">{blocks}</div>;
}
