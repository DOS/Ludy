// SPDX-License-Identifier: AGPL-3.0-only
// Page capture and 1-click Web Clipper (Notes v2 E4, #3560): nothing touches a page or runs content scripts in the
// background. Active tab DOM reading runs only inside an explicit popup click after the user turns Web Clipper on
// (optional permissions: activeTab, scripting). All extracted HTML is sanitized into bounded, safe Markdown.

export const NOTES_SCOPE = 'notes';
export const WEB_CLIPPER_PERMISSIONS = ['activeTab', 'scripting'] as const;
export const CLIP_TITLE_MAX = 200;
export const CLIP_BODY_MAX = 97_000;
export const CLIP_URL_MAX = 2048;
export const CLIP_TAG_MAX = 40;
export const CLIP_TAGS_MAX = 20;

export interface PageCapture {
  // What the click read: nothing else leaves the page.
  page: { url: string; title: string; selectedText: string };
}

export interface PageCaptureFeature {
  id: string;
  // The extension scope and the kernel command this feature's captures go to: exactly one.
  scope: string;
  command: string;
  // Builds the command's input from the captured page. The result is untrusted text (tainted) on the server.
  toInput(capture: PageCapture): Record<string, unknown>;
}

// A feature may only act on a click: the caller passes the evidence of one, and nothing is read without it.
export function capturePage(feature: PageCaptureFeature, clicked: boolean, read: () => PageCapture['page']): { command: string; input: Record<string, unknown> } | null {
  if (!clicked) return null;
  return { command: feature.command, input: feature.toInput({ page: read() }) };
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Validates an http/https tab or link URL, rejecting browser internal, file, data, and javascript URLs. */
export function validateClipUrl(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > CLIP_URL_MAX) return null;
  if (hasControlChar(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname.length === 0) return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  return parsed.toString();
}

/** Parses comma-separated tags from user input into lowercase deduplicated tags within server limits. */
export function parseTagsInput(raw: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const clean = part.trim().replace(/^#+/, '').trim().toLowerCase();
    if (!clean || clean.length > CLIP_TAG_MAX || seen.has(clean)) continue;
    seen.add(clean);
    tags.push(clean);
    if (tags.length >= CLIP_TAGS_MAX) break;
  }
  return tags;
}

export const NOTES_CLIP_FEATURE: PageCaptureFeature = {
  id: 'notes',
  scope: NOTES_SCOPE,
  command: 'notes.note.clip',
  toInput: ({ page }) => {
    const sourceUrl = validateClipUrl(page.url);
    return {
      title: page.title.replace(/\s+/g, ' ').trim().slice(0, CLIP_TITLE_MAX) || (sourceUrl ?? 'Untitled page'),
      body: page.selectedText.trim().slice(0, CLIP_BODY_MAX),
      ...(sourceUrl ? { sourceUrl } : {}),
    };
  },
};

export interface DomClipSnapshot {
  url: string;
  title: string;
  selectedHtml: string;
  selectedText: string;
  contentHtml: string;
  textFallback: string;
}

export interface ClippedPagePayload {
  title: string;
  body: string;
  sourceUrl: string;
}

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'nav',
  'aside',
  'footer',
  'header',
  'form',
  'input',
  'textarea',
  'select',
  'button',
]);

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };
const BLOCK_BREAK_TAGS = new Set(['p', 'div', 'section', 'article', 'main', 'figure', 'figcaption', 'table', 'tr', 'dt', 'dd']);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  hellip: '...',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : full;
    }
    return Object.hasOwn(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower]! : full;
  });
}

function readAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\\\`]+))`, 'i');
  const match = re.exec(attrs);
  const raw = match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
  return raw === null ? null : decodeEntities(raw).trim();
}

function resolveSafeHref(rawHref: string | null, baseUrl: string | null): string | null {
  if (!rawHref) return null;
  const trimmed = rawHref.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (baseUrl) {
    try {
      return validateClipUrl(new URL(trimmed, baseUrl).toString());
    } catch {
      return null;
    }
  }
  return validateClipUrl(trimmed);
}

function escapeLinkLabel(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function escapeLinkHref(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function stripDelimited(input: string, open: string, close: string): string {
  let out = input;
  let searchFrom = 0;
  let start = out.indexOf(open, searchFrom);
  while (start !== -1) {
    const end = out.indexOf(close, start + open.length);
    if (end === -1) {
      out = out.slice(0, start);
      break;
    }
    out = out.slice(0, start) + out.slice(end + close.length);
    searchFrom = Math.max(0, start - (open.length - 1));
    start = out.indexOf(open, searchFrom);
  }
  return out;
}

/** Converts untrusted HTML into bounded, readable Markdown with only http/https links retained. */
export function htmlToMarkdown(html: string, baseUrl: string | null = null): string {
  if (typeof html !== 'string' || html.trim() === '') return '';
  let cleaned = html;
  let prev: string;
  do {
    prev = cleaned;
    cleaned = stripDelimited(stripDelimited(cleaned, '<!--', '-->'), '<![CDATA[', ']]>');
  } while (cleaned !== prev);
  const parts: string[] = [];
  const skipStack: string[] = [];
  const listStack: Array<{ kind: 'ul' | 'ol'; index: number }> = [];
  const linkStack: Array<{ href: string | null; buf: string[]; lastChar: string }> = [];
  let inPre = false;
  let inCode = false;
  let inBlockquote = false;
  let lastIndex = 0;
  let lastChar = '';
  let trailingNewlines = 0;

  const emitOut = (text: string) => {
    if (text === '') return;
    parts.push(text);
    lastChar = text[text.length - 1]!;
    let nl = 0;
    for (let i = text.length - 1; i >= 0 && text[i] === '\n'; i -= 1) nl += 1;
    trailingNewlines = nl === text.length ? trailingNewlines + nl : nl;
  };

  const pushText = (text: string) => {
    if (text === '') return;
    if (linkStack.length > 0) {
      const top = linkStack[linkStack.length - 1]!;
      top.buf.push(text);
      top.lastChar = text[text.length - 1]!;
    } else {
      emitOut(text);
    }
  };

  const ensureLineBreak = (count: number) => {
    if (linkStack.length > 0) {
      const top = linkStack[linkStack.length - 1]!;
      if (top.lastChar !== '' && top.lastChar !== ' ') {
        top.buf.push(' ');
        top.lastChar = ' ';
      }
      return;
    }
    if (lastChar === '') return;
    if (trailingNewlines < count) emitOut('\n'.repeat(count - trailingNewlines));
  };

  const tagPattern = /<\/?([a-z][a-z0-9:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/gi;
  for (const match of cleaned.matchAll(tagPattern)) {
    const idx = match.index ?? 0;
    if (idx > lastIndex && skipStack.length === 0) {
      const rawText = decodeEntities(cleaned.slice(lastIndex, idx)).replaceAll('\u0000', '');
      if (inPre) {
        pushText(rawText.replace(/\r\n?/g, '\n'));
      } else {
        const collapsed = rawText.replace(/\s+/g, ' ');
        if (collapsed !== '') {
          const prevLastChar = linkStack.length > 0 ? linkStack[linkStack.length - 1]!.lastChar : lastChar;
          const atStart = prevLastChar === '' || prevLastChar === '\n' || prevLastChar === ' ';
          pushText(atStart ? collapsed.replace(/^ /, '') : collapsed);
        }
      }
    }
    lastIndex = idx + match[0].length;

    const fullTag = match[0];
    const closing = fullTag.startsWith('</');
    const tag = match[1]!.toLowerCase();
    const attrs = match[2] ?? '';
    const selfClosing = match[3] === '/';

    if (skipStack.length > 0) {
      if (!closing && !selfClosing && SKIP_TAGS.has(tag)) skipStack.push(tag);
      else if (closing && skipStack[skipStack.length - 1] === tag) skipStack.pop();
      continue;
    }

    if (!closing && SKIP_TAGS.has(tag)) {
      if (!selfClosing) skipStack.push(tag);
      continue;
    }

    if (tag === 'br') {
      ensureLineBreak(1);
      continue;
    }
    if (tag === 'hr') {
      ensureLineBreak(2);
      pushText('---');
      ensureLineBreak(2);
      continue;
    }

    const heading = HEADING_LEVEL[tag];
    if (heading !== undefined) {
      if (!closing) {
        ensureLineBreak(2);
        pushText(`${'#'.repeat(heading)} `);
      } else {
        ensureLineBreak(2);
      }
      continue;
    }

    if (tag === 'pre') {
      if (!closing) {
        ensureLineBreak(2);
        pushText('```\n');
        inPre = true;
      } else {
        if (inPre) {
          ensureLineBreak(1);
          pushText('```');
          ensureLineBreak(2);
        }
        inPre = false;
      }
      continue;
    }

    if (tag === 'code' && !inPre) {
      if (!closing && !inCode) {
        pushText('`');
        inCode = true;
      } else if (closing && inCode) {
        pushText('`');
        inCode = false;
      }
      continue;
    }

    if (tag === 'strong' || tag === 'b') {
      pushText('**');
      continue;
    }
    if (tag === 'em' || tag === 'i') {
      pushText('*');
      continue;
    }

    if (tag === 'blockquote') {
      if (!closing) {
        ensureLineBreak(2);
        pushText('> ');
        inBlockquote = true;
      } else {
        inBlockquote = false;
        ensureLineBreak(2);
      }
      continue;
    }

    if (tag === 'ul' || tag === 'ol') {
      if (!closing) {
        ensureLineBreak(listStack.length === 0 ? 2 : 1);
        listStack.push({ kind: tag, index: 0 });
      } else {
        if (listStack.length > 0 && listStack[listStack.length - 1]!.kind === tag) listStack.pop();
        ensureLineBreak(listStack.length === 0 ? 2 : 1);
      }
      continue;
    }

    if (tag === 'li') {
      if (!closing) {
        ensureLineBreak(1);
        const top = listStack[listStack.length - 1];
        const indent = '  '.repeat(Math.max(0, listStack.length - 1));
        if (top && top.kind === 'ol') {
          top.index += 1;
          pushText(`${indent}${top.index}. `);
        } else {
          pushText(`${indent}- `);
        }
      } else {
        ensureLineBreak(1);
      }
      continue;
    }

    if (tag === 'a') {
      if (!closing && !selfClosing) {
        const href = resolveSafeHref(readAttr(attrs, 'href'), baseUrl);
        linkStack.push({ href, buf: [], lastChar: '' });
      } else if (closing && linkStack.length > 0) {
        const popped = linkStack.pop()!;
        const label = popped.buf.join('').replace(/\s+/g, ' ').trim();
        if (label) {
          pushText(popped.href ? `[${escapeLinkLabel(label)}](${escapeLinkHref(popped.href)})` : label);
        }
      }
      continue;
    }

    if (tag === 'td' || tag === 'th') {
      if (closing) {
        const prevChar = linkStack.length > 0 ? linkStack[linkStack.length - 1]!.lastChar : lastChar;
        if (prevChar !== '' && prevChar !== ' ' && prevChar !== '\n') pushText(' ');
      }
      continue;
    }

    if (tag === 'tr') {
      ensureLineBreak(1);
      continue;
    }

    if (BLOCK_BREAK_TAGS.has(tag)) {
      ensureLineBreak(closing ? 2 : 1);
      if (!closing && inBlockquote) pushText('> ');
    }
  }

  if (lastIndex < cleaned.length && skipStack.length === 0) {
    const tail = decodeEntities(cleaned.slice(lastIndex)).replaceAll('\u0000', '').replace(/\s+/g, ' ');
    if (tail.trim()) pushText(tail);
  }
  while (linkStack.length > 0) {
    const popped = linkStack.pop()!;
    const label = popped.buf.join('').replace(/\s+/g, ' ').trim();
    if (label) pushText(popped.href ? `[${escapeLinkLabel(label)}](${escapeLinkHref(popped.href)})` : label);
  }

  const normalized = parts
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (normalized.length <= CLIP_BODY_MAX) return normalized;
  return `${normalized.slice(0, CLIP_BODY_MAX - 3).trimEnd()}...`;
}

/**
 * Self-contained DOM reader injected via `chrome.scripting.executeScript` ONLY when the user clicks Clip.
 * Never imports outer symbols (serialized with `func.toString()`), never modifies the live DOM, and strips all form
 * inputs, scripts, styles, navigation, and hidden nodes.
 */
export function snapshotDomPage(): DomClipSnapshot {
  const MAX_HTML = 300_000;
  const MAX_TEXT = 120_000;
  const NOISE_SELECTOR =
    'script, style, noscript, template, iframe, object, embed, svg, canvas, nav, aside, footer, header, form, input, textarea, select, button, [role="navigation"], [role="banner"], [role="contentinfo"], [hidden], [aria-hidden="true"], [style*="display:none"], [style*="display: none"]';
  const SELECTION_NOISE =
    'script, style, noscript, template, iframe, object, embed, svg, canvas, input, textarea, select, [hidden], [aria-hidden="true"], [style*="display:none"], [style*="display: none"]';

  const sanitizeClone = (node: Node, selector: string): { html: string; text: string } => {
    const box = document.createElement('div');
    box.append(node.cloneNode(true));
    for (const el of box.querySelectorAll(selector)) el.remove();
    return {
      html: box.innerHTML.slice(0, MAX_HTML),
      text: (box.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT),
    };
  };

  let selectedHtml = '';
  let selectedText = '';
  const sel = window.getSelection();
  const activeTag = document.activeElement?.tagName;
  const inFormField = activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT';
  if (sel && !sel.isCollapsed && !inFormField) {
    const anchorEl = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
    if (!anchorEl?.closest('input, textarea, select')) {
      const wrap = document.createElement('div');
      for (let i = 0; i < sel.rangeCount; i += 1) {
        wrap.append(sel.getRangeAt(i).cloneContents());
      }
      for (const el of wrap.querySelectorAll(SELECTION_NOISE)) el.remove();
      const sanitizedSelectionText = (wrap.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (sanitizedSelectionText) {
        selectedText = sanitizedSelectionText.slice(0, MAX_TEXT);
        selectedHtml = wrap.innerHTML.slice(0, MAX_HTML);
      }
    }
  }

  let best: Element | null = null;
  let bestLen = 0;
  for (const el of document.querySelectorAll('article, [role="main"], main')) {
    const len = (el.textContent ?? '').trim().length;
    if (len >= 120 && len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  const sourceEl = best ?? document.body ?? document.documentElement;
  const sanitized = sourceEl ? sanitizeClone(sourceEl, NOISE_SELECTOR) : { html: '', text: '' };

  return {
    url: window.location.href,
    title: document.title ?? '',
    selectedHtml,
    selectedText,
    contentHtml: sanitized.html,
    textFallback: sanitized.text,
  };
}

/** Converts a DOM capture snapshot into bounded title + Markdown + validated sourceUrl payload. */
export function snapshotToClip(snapshot: DomClipSnapshot): ClippedPagePayload | null {
  const sourceUrl = validateClipUrl(snapshot.url);
  if (!sourceUrl) return null;
  const cleanTitle = snapshot.title.replace(/\s+/g, ' ').trim().slice(0, CLIP_TITLE_MAX);
  const title = cleanTitle || new URL(sourceUrl).hostname.slice(0, CLIP_TITLE_MAX);

  const hasSelection = snapshot.selectedText.trim().length > 0;
  const rawHtml = hasSelection ? snapshot.selectedHtml : snapshot.contentHtml;
  let body = htmlToMarkdown(rawHtml, sourceUrl);
  if (body === '') {
    const fallback = (hasSelection ? snapshot.selectedText : snapshot.textFallback).replace(/\r\n?/g, '\n').replaceAll('\u0000', '').trim();
    body = fallback.length > CLIP_BODY_MAX ? `${fallback.slice(0, CLIP_BODY_MAX - 3).trimEnd()}...` : fallback;
  }
  return { title, body, sourceUrl };
}

export type ActiveTabCaptureResult =
  | { ok: true; clip: ClippedPagePayload }
  | { ok: false; reason: 'notClicked' | 'permission' | 'unsupportedUrl' | 'failed' };

export interface ActiveTabCaptureApis {
  permissions: Pick<typeof chrome.permissions, 'contains'>;
  tabs: Pick<typeof chrome.tabs, 'query'>;
  scripting: Pick<typeof chrome.scripting, 'executeScript'>;
  clicked: boolean;
}

/**
 * Captures the active browser tab on explicit click only, verifying opt-in permissions (`activeTab`, `scripting`) and
 * `http`/`https` URL safety before calling `chrome.scripting.executeScript`.
 */
export async function captureActiveTab(apis: ActiveTabCaptureApis): Promise<ActiveTabCaptureResult> {
  if (!apis.clicked) return { ok: false, reason: 'notClicked' };
  const granted = await apis.permissions.contains({ permissions: [...WEB_CLIPPER_PERMISSIONS] }).catch(() => false);
  if (!granted) return { ok: false, reason: 'permission' };
  const tabs = await apis.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  const tab = tabs[0];
  if (tab?.id === undefined) return { ok: false, reason: 'failed' };
  if (typeof tab.url === 'string' && tab.url.length > 0 && !validateClipUrl(tab.url)) {
    return { ok: false, reason: 'unsupportedUrl' };
  }
  try {
    const results = await apis.scripting.executeScript({ target: { tabId: tab.id }, func: snapshotDomPage });
    const snapshot = results[0]?.result;
    if (!snapshot) return { ok: false, reason: 'failed' };
    const clip = snapshotToClip(snapshot);
    return clip ? { ok: true, clip } : { ok: false, reason: 'unsupportedUrl' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
