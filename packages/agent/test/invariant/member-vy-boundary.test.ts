// SPDX-License-Identifier: AGPL-3.0-only
// The stage A write boundary of Vy working for one member (ADR-0049, "The write boundary of stage A", decision 4 layer 3
// and decision 9; issue #2754). In stage A a member-Vy run is the member's whole user context, so the line is held in
// code and pinned here, in the pattern of meter-coverage.test.ts:
//   - a member-Vy feature module (packages/agent/src/member-vy/**) is pure: it imports no runtime, no database client and
//     no vendor SDK, names no command and no table, and never calls execute();
//   - features reach the model, memory and knowledge through the provider ports, never a vendor client (decision 9);
//   - the org-level features outside that directory take plain strings: none imports a member-Vy module or the branded
//     PrivateText type (decision 4 layer 3).
// The directory may not exist yet: the scan then has nothing to read, the scanner's own cases below keep it honest, and
// one case fails once the store command exists in the kernel while the directory is still empty. The file sits under
// test/invariant/, so the base branch's copy runs against a feature PR (a feature PR cannot edit the rules it must meet).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SRC = join(ROOT, 'packages/agent/src');
const MEMBER_VY = join(SRC, 'member-vy');
const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const WORKSPACE_ROOTS = ['apps', 'packages', 'modules', 'e2e', 'tools'] as const;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'generated', 'coverage']);

function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (SOURCE_EXT_RE.test(name)) out.push(path);
  }
  return out;
}

function workspaceNonTestSources(rootDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(path);
        continue;
      }
      if (!SOURCE_EXT_RE.test(name)) continue;
      const rel = relative(rootDir, path).replace(/\\/g, '/');
      if (/(^|\/)test\//.test(rel)) continue;
      out.push(path);
    }
  };
  for (const top of WORKSPACE_ROOTS) walk(join(rootDir, top));
  return out;
}

export type TokenKind =
  | 'ident'
  | 'string'
  | 'template'
  | 'template_head'
  | 'template_middle'
  | 'template_tail'
  | 'number'
  | 'punct'
  | 'regex'
  | 'invalid';

export interface Token {
  kind: TokenKind;
  raw: string;
  value: string;
  escaped: boolean;
  start: number;
  end: number;
  line: number;
}

const REGEX_PREFIX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'void',
  'await',
  'throw',
  'yield',
  'else',
  'do',
  'in',
  'of',
  'new',
  'delete',
  'instanceof',
  'export',
  'default',
  'extends',
  'debugger',
  'break',
  'continue',
]);

const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
const ID_START_UNICODE_RE = /^[\p{ID_Start}$_]$/u;
const ID_PART_UNICODE_RE = /^[\p{ID_Continue}$\u200C\u200D]$/u;
const HEX_RE = /^[0-9a-fA-F]$/;

const isAsciiIdentStart = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 36 || code === 95;

const isAsciiIdentPart = (code: number): boolean =>
  isAsciiIdentStart(code) || (code >= 48 && code <= 57);

function isIdentStartChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if (code <= 127) return isAsciiIdentStart(code);
  return ID_START_UNICODE_RE.test(ch);
}

function isIdentPartChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  if (code <= 127) return isAsciiIdentPart(code);
  return ID_PART_UNICODE_RE.test(ch);
}

function isLineTerminatorCode(code: number): boolean {
  return code === 10 || code === 13 || code === 0x2028 || code === 0x2029;
}

function isWhitespaceCode(code: number): boolean {
  return (
    code === 32 ||
    code === 9 ||
    code === 11 ||
    code === 12 ||
    code === 0xa0 ||
    code === 0xfeff ||
    code === 10 ||
    code === 13 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

const lineDeltaAt = (text: string, pos: number): number => {
  const code = text.charCodeAt(pos);
  if (code === 10 || code === 0x2028 || code === 0x2029) return 1;
  if (code === 13) return text.charCodeAt(pos + 1) === 10 ? 0 : 1;
  return 0;
};

function parseFixedHex(text: string, start: number, len: number): number {
  if (start + len > text.length) return -1;
  let value = 0;
  for (let k = 0; k < len; k += 1) {
    const ch = text[start + k] ?? '';
    if (!HEX_RE.test(ch)) return -1;
    const code = ch.charCodeAt(0);
    const digit = code <= 57 ? code - 48 : code <= 70 ? code - 55 : code - 87;
    value = value * 16 + digit;
  }
  return value;
}

function decodeIdentUnicodeEscape(text: string, slashIndex: number): { ok: boolean; char: string; next: number } {
  if (text[slashIndex] !== '\\' || text[slashIndex + 1] !== 'u') {
    return { ok: false, char: '', next: slashIndex + 1 };
  }
  if (text[slashIndex + 2] === '{') {
    let j = slashIndex + 3;
    let cp = 0;
    let count = 0;
    while (j < text.length && HEX_RE.test(text[j] ?? '')) {
      const code = text.charCodeAt(j);
      const digit = code <= 57 ? code - 48 : code <= 70 ? code - 55 : code - 87;
      cp = cp * 16 + digit;
      if (cp > 0x10ffff) return { ok: false, char: '', next: j + 1 };
      count += 1;
      j += 1;
    }
    if (count === 0 || text[j] !== '}') return { ok: false, char: '', next: Math.min(j + 1, text.length) };
    return { ok: true, char: String.fromCodePoint(cp), next: j + 1 };
  }
  const code = parseFixedHex(text, slashIndex + 2, 4);
  if (code < 0) return { ok: false, char: '', next: Math.min(slashIndex + 2, text.length) };
  return { ok: true, char: String.fromCharCode(code), next: slashIndex + 6 };
}

function decodeStringEscape(text: string, slashIndex: number, allowLegacyZero = true): { ok: boolean; value: string; next: number; newlines: number } {
  if (slashIndex + 1 >= text.length) return { ok: false, value: '', next: text.length, newlines: 0 };
  const nextChar = text[slashIndex + 1] ?? '';
  const nextCode = nextChar.charCodeAt(0);
  if (nextCode === 13) {
    // Backslash line continuation (\r\n or \r)
    const advance = text.charCodeAt(slashIndex + 2) === 10 ? 3 : 2;
    return { ok: true, value: '', next: slashIndex + advance, newlines: 1 };
  }
  if (nextCode === 10 || nextCode === 0x2028 || nextCode === 0x2029) {
    return { ok: true, value: '', next: slashIndex + 2, newlines: 1 };
  }
  switch (nextChar) {
    case 'n':
      return { ok: true, value: '\n', next: slashIndex + 2, newlines: 0 };
    case 'r':
      return { ok: true, value: '\r', next: slashIndex + 2, newlines: 0 };
    case 't':
      return { ok: true, value: '\t', next: slashIndex + 2, newlines: 0 };
    case 'b':
      return { ok: true, value: '\b', next: slashIndex + 2, newlines: 0 };
    case 'f':
      return { ok: true, value: '\f', next: slashIndex + 2, newlines: 0 };
    case 'v':
      return { ok: true, value: '\v', next: slashIndex + 2, newlines: 0 };
    case "'":
      return { ok: true, value: "'", next: slashIndex + 2, newlines: 0 };
    case '"':
      return { ok: true, value: '"', next: slashIndex + 2, newlines: 0 };
    case '\\':
      return { ok: true, value: '\\', next: slashIndex + 2, newlines: 0 };
    case '0': {
      const after = text.charCodeAt(slashIndex + 2);
      if (!allowLegacyZero || (after >= 48 && after <= 57)) {
        return { ok: false, value: '', next: slashIndex + 2, newlines: 0 };
      }
      return { ok: true, value: '\0', next: slashIndex + 2, newlines: 0 };
    }
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7':
    case '8':
    case '9':
      return { ok: false, value: '', next: slashIndex + 2, newlines: 0 };
    case 'x': {
      const code = parseFixedHex(text, slashIndex + 2, 2);
      if (code < 0) return { ok: false, value: '', next: Math.min(slashIndex + 2, text.length), newlines: 0 };
      return { ok: true, value: String.fromCharCode(code), next: slashIndex + 4, newlines: 0 };
    }
    case 'u': {
      const dec = decodeIdentUnicodeEscape(text, slashIndex);
      return { ok: dec.ok, value: dec.char, next: dec.next, newlines: 0 };
    }
    default:
      return { ok: true, value: nextChar, next: slashIndex + 2, newlines: 0 };
  }
}

function decodeRawStringContent(inner: string): string | null {
  const chunks: string[] = [];
  let i = 0;
  let plainStart = 0;
  while (i < inner.length) {
    if (inner[i] === '\\') {
      if (i > plainStart) chunks.push(inner.slice(plainStart, i));
      const dec = decodeStringEscape(inner, i);
      if (!dec.ok) return null;
      if (dec.value.length > 0) chunks.push(dec.value);
      i = dec.next;
      plainStart = i;
      continue;
    }
    i += 1;
  }
  if (plainStart < inner.length) chunks.push(inner.slice(plainStart));
  return chunks.join('');
}

const MULTI_CHAR_PUNCTS = ['...', '===', '!==', '=>', '==', '!=', '<=', '++', '--', '&&', '||', '??', '?.', '+=', '-=', '*=', '/=', '**'] as const;

const isJsxTagNameChar = (code: number): boolean =>
  isAsciiIdentPart(code) || code === 45 /* - */ || code === 46 /* . */ || code === 58 /* : */;

function isJsxOpenTagHead(text: string, ltIdx: number): boolean {
  const firstCode = text.charCodeAt(ltIdx + 1);
  if (!isAsciiIdentStart(firstCode)) return false;
  let k = ltIdx + 2;
  while (k < text.length && isJsxTagNameChar(text.charCodeAt(k))) k += 1;
  const tagName = text.slice(ltIdx + 1, k);
  while (k < text.length && isWhitespaceCode(text.charCodeAt(k))) k += 1;
  const ch = text[k];
  if (tagName === 'const' && ch && isAsciiIdentStart(text.charCodeAt(k))) return false;
  if (ch === ',' || ch === '=') return false;
  if (text.startsWith('extends', k) && !isAsciiIdentPart(text.charCodeAt(k + 7))) {
    let m = k + 7;
    while (m < text.length && isWhitespaceCode(text.charCodeAt(m))) m += 1;
    const afterExt = text[m];
    if (afterExt !== '=' && afterExt !== '/' && afterExt !== '>') return false;
  }
  return true;
}

interface ScanSourceResult {
  tokens: Token[];
  stripped: string;
  suspiciousDivisionStarts: Set<number>;
  suspiciousRegexStarts: Set<number>;
}

function scanSource(
  text: string,
  options: {
    emitTokens: boolean;
    stripCommentsMode: boolean;
    stripStrings: boolean;
    scanRegexAsDivision?: boolean;
    skipAmbiguousJsxRegex?: boolean;
    skipRegexStarts?: ReadonlySet<number>;
    forceRegexStarts?: ReadonlySet<number>;
    jsx?: boolean;
  },
): ScanSourceResult {
  const tokens: Token[] = [];
  const chunks: string[] = [];
  const templates: number[] = [];
  const parenAllowsRegexStack: boolean[] = [];
  const jsxStack: Array<{ mode: 'openTag' | 'elem' | 'expr'; braceDepth: number; angleDepth: number }> = [];
  const suspiciousDivisionStarts = new Set<number>();
  const suspiciousRegexStarts = new Set<number>();

  let i = 0;
  let line = 1;
  let prevAllowsRegex = true;
  let prevWasDot = false;
  let prevWasControlKeyword = false;
  let prevWasLt = false;
  let prevWasGt = false;
  let prevWasRBrace = false;
  let sameLineDivLine = -1;
  let sameLineDivStarts: number[] = [];

  const markCommentOnCurrentLine = (): void => {
    if (sameLineDivLine === line) {
      for (const pos of sameLineDivStarts) suspiciousDivisionStarts.add(pos);
    }
  };

  const pushBlankedComments = (raw: string): void => {
    if (!options.stripCommentsMode) return;
    if (!/[\n\r\u2028\u2029]/.test(raw)) {
      chunks.push(' '.repeat(raw.length));
      return;
    }
    chunks.push(raw.replace(/[^\n\r\u2028\u2029]/g, ' '));
  };

  const pushBlankedStringBody = (rawInner: string): void => {
    if (!options.stripCommentsMode) return;
    if (!options.stripStrings) {
      chunks.push(rawInner);
      return;
    }
    if (!/[\n\r\u2028\u2029]/.test(rawInner)) {
      chunks.push(' '.repeat(rawInner.length));
      return;
    }
    chunks.push(rawInner.replace(/[^\n\r\u2028\u2029]/g, ' '));
  };

  const emit = (tok: Token): void => {
    if (options.emitTokens) tokens.push(tok);
  };

  const countNewlines = (s: string): number => {
    let n = 0;
    for (let k = 0; k < s.length; k += 1) {
      n += lineDeltaAt(s, k);
    }
    return n;
  };

  while (i < text.length) {
    if (options.jsx && jsxStack[jsxStack.length - 1]?.mode === 'elem') {
      const textStart = i;
      let j = i;
      while (j < text.length && text[j] !== '<' && text[j] !== '{') {
        line += lineDeltaAt(text, j);
        j += 1;
      }
      if (j > textStart && options.stripCommentsMode) chunks.push(text.slice(textStart, j));
      if (j >= text.length) {
        i = j;
        break;
      }
      if (text[j] === '{') {
        if (options.stripCommentsMode) chunks.push('{');
        emit({ kind: 'punct', raw: '{', value: '{', escaped: false, start: j, end: j + 1, line });
        jsxStack.push({ mode: 'expr', braceDepth: 1, angleDepth: 0 });
        i = j + 1;
        prevAllowsRegex = true;
        prevWasDot = false;
        prevWasControlKeyword = false;
        prevWasLt = false;
        prevWasGt = false;
        prevWasRBrace = false;
        continue;
      }
      // text[j] === '<' inside JSX children
      const afterLt = text[j + 1] ?? '';
      if (afterLt === '/') {
        let k = j + 2;
        while (k < text.length && isJsxTagNameChar(text.charCodeAt(k))) k += 1;
        while (k < text.length && isWhitespaceCode(text.charCodeAt(k))) {
          line += lineDeltaAt(text, k);
          k += 1;
        }
        if (text[k] === '>') {
          if (options.stripCommentsMode) chunks.push(text.slice(j, k + 1));
          emit({ kind: 'punct', raw: '<', value: '<', escaped: false, start: j, end: j + 1, line });
          emit({ kind: 'punct', raw: '/', value: '/', escaped: false, start: j + 1, end: j + 2, line });
          emit({ kind: 'punct', raw: '>', value: '>', escaped: false, start: k, end: k + 1, line });
          jsxStack.pop();
          i = k + 1;
          prevAllowsRegex = false;
          prevWasDot = false;
          prevWasControlKeyword = false;
          prevWasLt = false;
          prevWasGt = true;
          prevWasRBrace = false;
          continue;
        }
        const raw = text.slice(j, Math.min(k + 1, text.length));
        if (options.stripCommentsMode) chunks.push(raw);
        emit({ kind: 'invalid', raw, value: 'unclosed JSX closing tag', escaped: false, start: j, end: Math.min(k + 1, text.length), line });
        jsxStack.pop();
        i = Math.min(k + 1, text.length);
        prevAllowsRegex = false;
        prevWasDot = false;
        prevWasControlKeyword = false;
        prevWasLt = false;
        prevWasGt = false;
        prevWasRBrace = false;
        continue;
      }
      if (afterLt === '>') {
        if (options.stripCommentsMode) chunks.push('<>');
        emit({ kind: 'punct', raw: '<', value: '<', escaped: false, start: j, end: j + 1, line });
        emit({ kind: 'punct', raw: '>', value: '>', escaped: false, start: j + 1, end: j + 2, line });
        jsxStack.push({ mode: 'elem', braceDepth: 0, angleDepth: 0 });
        i = j + 2;
        prevAllowsRegex = false;
        prevWasDot = false;
        prevWasControlKeyword = false;
        prevWasLt = false;
        prevWasGt = true;
        prevWasRBrace = false;
        continue;
      }
      if (isAsciiIdentStart(text.charCodeAt(j + 1))) {
        if (options.stripCommentsMode) chunks.push('<');
        emit({ kind: 'punct', raw: '<', value: '<', escaped: false, start: j, end: j + 1, line });
        jsxStack.push({ mode: 'openTag', braceDepth: 0, angleDepth: 0 });
        i = j + 1;
        prevAllowsRegex = false;
        prevWasDot = false;
        prevWasControlKeyword = false;
        prevWasLt = true;
        prevWasGt = false;
        prevWasRBrace = false;
        continue;
      }
      if (options.stripCommentsMode) chunks.push('<');
      emit({ kind: 'invalid', raw: '<', value: 'unexpected < in JSX text', escaped: false, start: j, end: j + 1, line });
      i = j + 1;
      prevAllowsRegex = false;
      prevWasDot = false;
      prevWasControlKeyword = false;
      prevWasLt = false;
      prevWasGt = false;
      prevWasRBrace = false;
      continue;
    }

    const ch = text[i] ?? '';
    const code = ch.charCodeAt(0);
    const next = text[i + 1] ?? '';

    if (isWhitespaceCode(code)) {
      let j = i;
      while (j < text.length && isWhitespaceCode(text.charCodeAt(j))) {
        line += lineDeltaAt(text, j);
        j += 1;
      }
      if (options.stripCommentsMode) chunks.push(text.slice(i, j));
      i = j;
      continue;
    }

    if (ch === '/' && next === '/') {
      markCommentOnCurrentLine();
      let stop = i + 2;
      while (stop < text.length && !isLineTerminatorCode(text.charCodeAt(stop))) {
        stop += 1;
      }
      pushBlankedComments(text.slice(i, stop));
      i = stop;
      continue;
    }

    if (ch === '/' && next === '*') {
      markCommentOnCurrentLine();
      const startLine = line;
      const close = text.indexOf('*/', i + 2);
      if (close < 0) {
        const raw = text.slice(i);
        line += countNewlines(raw);
        pushBlankedComments(raw);
        emit({ kind: 'invalid', raw, value: 'unclosed block comment', escaped: false, start: i, end: text.length, line: startLine });
        i = text.length;
      } else {
        const stop = close + 2;
        const raw = text.slice(i, stop);
        line += countNewlines(raw);
        pushBlankedComments(raw);
        i = stop;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      const start = i;
      const startLine = line;
      const topJsxOpen = options.jsx ? jsxStack[jsxStack.length - 1] : undefined;
      const isJsxAttrString = Boolean(topJsxOpen?.mode === 'openTag' && topJsxOpen.angleDepth === 0);
      const valueChunks: string[] = [];
      let j = i + 1;
      let plainStart = j;
      let valid = true;
      let sawEscape = false;
      let closed = false;

      while (j < text.length) {
        const cur = text[j] ?? '';
        const curCode = cur.charCodeAt(0);
        if (cur === ch) {
          if (j > plainStart) valueChunks.push(text.slice(plainStart, j));
          j += 1;
          closed = true;
          break;
        }
        if (isJsxAttrString) {
          // JSX attribute string literals allow raw newlines and treat backslashes literally.
          line += lineDeltaAt(text, j);
          j += 1;
          continue;
        }
        if (curCode === 10 || curCode === 13) {
          valid = false;
          break;
        }
        if (cur === '\\') {
          sawEscape = true;
          if (j > plainStart) valueChunks.push(text.slice(plainStart, j));
          const dec = decodeStringEscape(text, j);
          if (!dec.ok) valid = false;
          else if (dec.value.length > 0) valueChunks.push(dec.value);
          line += dec.newlines;
          j = dec.next;
          plainStart = j;
          continue;
        }
        if (curCode === 0x2028 || curCode === 0x2029) line += 1;
        j += 1;
      }

      if (!closed) valid = false;
      const raw = text.slice(start, j);
      if (options.stripCommentsMode) {
        if (options.stripStrings) {
          const inner = closed ? raw.slice(1, -1) : raw.slice(1);
          chunks.push(ch);
          pushBlankedStringBody(inner);
          if (closed) chunks.push(ch);
        } else {
          chunks.push(raw);
        }
      }
      emit({
        kind: valid ? 'string' : 'invalid',
        raw,
        value: valid ? valueChunks.join('') : 'invalid or unclosed string literal',
        escaped: sawEscape,
        start,
        end: j,
        line: startLine,
      });
      i = j;
      prevAllowsRegex = false;
      prevWasDot = false;
      prevWasControlKeyword = false;
      prevWasLt = false;
      prevWasGt = false;
      prevWasRBrace = false;
      continue;
    }

    const resumingTemplate = ch === '}' && templates.length > 0 && templates[templates.length - 1] === 0;
    if (ch === '`' || resumingTemplate) {
      if (resumingTemplate) templates.pop();
      const start = i;
      const startLine = line;
      const valueChunks: string[] = [];
      let j = i + 1;
      let plainStart = j;
      let valid = true;
      let sawEscape = false;
      let hitInterpolation = false;
      let hitBacktick = false;

      while (j < text.length) {
        const cur = text[j] ?? '';
        const curCode = cur.charCodeAt(0);
        if (cur === '`') {
          if (j > plainStart) valueChunks.push(text.slice(plainStart, j));
          j += 1;
          hitBacktick = true;
          break;
        }
        if (cur === '$' && text[j + 1] === '{') {
          if (j > plainStart) valueChunks.push(text.slice(plainStart, j));
          j += 2;
          hitInterpolation = true;
          templates.push(0);
          break;
        }
        if (cur === '\\') {
          sawEscape = true;
          if (j > plainStart) valueChunks.push(text.slice(plainStart, j));
          const dec = decodeStringEscape(text, j);
          if (!dec.ok) valid = false;
          else if (dec.value.length > 0) valueChunks.push(dec.value);
          line += dec.newlines;
          j = dec.next;
          plainStart = j;
          continue;
        }
        if (curCode === 13) {
          if (j > plainStart) valueChunks.push(text.slice(plainStart, j));
          valueChunks.push('\n');
          line += 1;
          j += text.charCodeAt(j + 1) === 10 ? 2 : 1;
          plainStart = j;
          continue;
        }
        if (curCode === 10 || curCode === 0x2028 || curCode === 0x2029) line += 1;
        j += 1;
      }

      if (!hitBacktick && !hitInterpolation) valid = false;
      const raw = text.slice(start, j);
      if (options.stripCommentsMode) {
        if (options.stripStrings) {
          const openCh = ch;
          const inner = hitInterpolation ? raw.slice(1, -2) : hitBacktick ? raw.slice(1, -1) : raw.slice(1);
          chunks.push(openCh);
          pushBlankedStringBody(inner);
          if (hitInterpolation) chunks.push('${');
          else if (hitBacktick) chunks.push('`');
        } else {
          chunks.push(raw);
        }
      }
      const kind: TokenKind = !valid
        ? 'invalid'
        : resumingTemplate
          ? hitInterpolation
            ? 'template_middle'
            : 'template_tail'
          : hitInterpolation
            ? 'template_head'
            : 'template';
      emit({
        kind,
        raw,
        value: valid ? valueChunks.join('') : 'invalid or unclosed template literal',
        escaped: sawEscape,
        start,
        end: j,
        line: startLine,
      });
      i = j;
      prevAllowsRegex = hitInterpolation;
      prevWasDot = false;
      prevWasControlKeyword = false;
      prevWasLt = false;
      prevWasGt = false;
      prevWasRBrace = false;
      continue;
    }

    const topJsx = options.jsx ? jsxStack[jsxStack.length - 1] : undefined;
    if (ch === '/' && next === '>' && topJsx?.mode === 'openTag' && topJsx.angleDepth === 0) {
      if (options.stripCommentsMode) chunks.push('/>');
      emit({ kind: 'punct', raw: '/', value: '/', escaped: false, start: i, end: i + 1, line });
      emit({ kind: 'punct', raw: '>', value: '>', escaped: false, start: i + 1, end: i + 2, line });
      jsxStack.pop();
      i += 2;
      prevAllowsRegex = false;
      prevWasDot = false;
      prevWasControlKeyword = false;
      prevWasLt = false;
      prevWasGt = true;
      prevWasRBrace = false;
      continue;
    }

    const forceRegex = Boolean(options.forceRegexStarts?.has(i));
    const skipJsxAmbiguous =
      !forceRegex && Boolean(options.skipAmbiguousJsxRegex) && (prevWasGt || (prevWasRBrace && next === '>'));
    const skipListedStart = Boolean(options.skipRegexStarts?.has(i));
    if (
      ch === '/' &&
      !options.scanRegexAsDivision &&
      !skipListedStart &&
      (forceRegex || (!skipJsxAmbiguous && prevAllowsRegex && !(prevWasLt && text[i - 1] === '<')))
    ) {
      const start = i;
      const startLine = line;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < text.length) {
        const cur = text[j] ?? '';
        const curCode = cur.charCodeAt(0);
        if (isLineTerminatorCode(curCode)) break;
        if (cur === '\\') {
          j += 1;
          if (j < text.length && !isLineTerminatorCode(text.charCodeAt(j))) j += 1;
          continue;
        }
        if (cur === '[') inClass = true;
        else if (cur === ']') inClass = false;
        else if (cur === '/' && !inClass) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j < text.length && isAsciiIdentStart(text.charCodeAt(j))) j += 1;
      }
      const raw = text.slice(start, j);
      if ((closed && /['"`]/.test(raw)) || (!closed && /['"`;]/.test(raw))) {
        suspiciousRegexStarts.add(start);
      }
      if (options.stripCommentsMode) chunks.push(raw);
      emit({
        kind: closed ? 'regex' : 'invalid',
        raw,
        value: closed ? raw : 'unclosed regex literal',
        escaped: false,
        start,
        end: j,
        line: startLine,
      });
      i = j;
      prevAllowsRegex = false;
      prevWasDot = false;
      prevWasControlKeyword = false;
      prevWasLt = false;
      prevWasGt = false;
      prevWasRBrace = false;
      continue;
    }

    // Numeric literal (including .5 decimal form, 0x..., 0b..., 0o..., _ separators, bigint n)
    if ((code >= 48 && code <= 57) || (ch === '.' && next.charCodeAt(0) >= 48 && next.charCodeAt(0) <= 57)) {
      const start = i;
      let j = i;
      if (text[j] === '0' && (text[j + 1] === 'x' || text[j + 1] === 'X' || text[j + 1] === 'b' || text[j + 1] === 'B' || text[j + 1] === 'o' || text[j + 1] === 'O')) {
        j += 2;
        while (j < text.length && (isAsciiIdentPart(text.charCodeAt(j)) || text[j] === '_')) j += 1;
      } else {
        while (j < text.length && ((text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) || text[j] === '_')) j += 1;
        if (text[j] === '.' && text[j + 1] !== '.') {
          j += 1;
          while (j < text.length && ((text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) || text[j] === '_')) j += 1;
        }
        if ((text[j] === 'e' || text[j] === 'E') && j < text.length) {
          let exp = j + 1;
          if (text[exp] === '+' || text[exp] === '-') exp += 1;
          if (text.charCodeAt(exp) >= 48 && text.charCodeAt(exp) <= 57) {
            j = exp + 1;
            while (j < text.length && ((text.charCodeAt(j) >= 48 && text.charCodeAt(j) <= 57) || text[j] === '_')) j += 1;
          }
        }
        if (text[j] === 'n') j += 1;
      }
      const raw = text.slice(start, j);
      if (options.stripCommentsMode) chunks.push(raw);
      emit({ kind: 'number', raw, value: raw, escaped: false, start, end: j, line });
      i = j;
      prevAllowsRegex = false;
      prevWasDot = false;
      prevWasControlKeyword = false;
      prevWasLt = false;
      prevWasGt = false;
      prevWasRBrace = false;
      continue;
    }

    // Identifiers and unicode-escaped identifiers
    const startCp = text.codePointAt(i) ?? 0;
    const startChar = String.fromCodePoint(startCp);
    if (isIdentStartChar(startChar) || (ch === '\\' && next === 'u')) {
      const start = i;
      const valChunks: string[] = [];
      let j = i;
      let valid = true;
      let sawEscape = false;

      if (ch === '\\') {
        sawEscape = true;
        const dec = decodeIdentUnicodeEscape(text, j);
        if (!dec.ok || !isIdentStartChar(dec.char)) {
          valid = false;
        } else {
          valChunks.push(dec.char);
        }
        j = dec.next;
      } else {
        valChunks.push(startChar);
        j += startChar.length;
      }

      while (j < text.length && valid) {
        const c = text[j] ?? '';
        if (c === '\\') {
          if (text[j + 1] !== 'u') {
            valid = false;
            j += 1;
            break;
          }
          sawEscape = true;
          const dec = decodeIdentUnicodeEscape(text, j);
          if (!dec.ok || !isIdentPartChar(dec.char)) {
            valid = false;
            j = dec.next;
            break;
          }
          valChunks.push(dec.char);
          j = dec.next;
          continue;
        }
        const cp = text.codePointAt(j) ?? 0;
        const unit = String.fromCodePoint(cp);
        if (!isIdentPartChar(unit)) break;
        valChunks.push(unit);
        j += unit.length;
      }

      const raw = text.slice(start, j);
      const value = valChunks.join('');
      if (options.stripCommentsMode) chunks.push(raw);
      emit({
        kind: valid ? 'ident' : 'invalid',
        raw,
        value: valid ? value : raw,
        escaped: sawEscape || raw !== value,
        start,
        end: j,
        line,
      });
      if (valid) {
        prevAllowsRegex = !prevWasDot && REGEX_PREFIX_KEYWORDS.has(value);
        prevWasControlKeyword = !prevWasDot && CONTROL_KEYWORDS.has(value);
      } else {
        prevAllowsRegex = false;
        prevWasControlKeyword = false;
      }
      prevWasDot = false;
      prevWasLt = false;
      prevWasGt = false;
      prevWasRBrace = false;
      i = j;
      continue;
    }

    // Track braces inside template interpolations before emitting punctuator
    if (templates.length > 0 && ch === '{') {
      templates[templates.length - 1] = (templates[templates.length - 1] ?? 0) + 1;
    } else if (templates.length > 0 && ch === '}') {
      templates[templates.length - 1] = (templates[templates.length - 1] ?? 0) - 1;
    }

    if (options.jsx && ch === '<' && next !== '=' && prevAllowsRegex && jsxStack[jsxStack.length - 1]?.mode !== 'openTag') {
      if (next === '>') {
        if (options.stripCommentsMode) chunks.push('<>');
        emit({ kind: 'punct', raw: '<', value: '<', escaped: false, start: i, end: i + 1, line });
        emit({ kind: 'punct', raw: '>', value: '>', escaped: false, start: i + 1, end: i + 2, line });
        jsxStack.push({ mode: 'elem', braceDepth: 0, angleDepth: 0 });
        i += 2;
        prevAllowsRegex = false;
        prevWasDot = false;
        prevWasControlKeyword = false;
        prevWasLt = false;
        prevWasGt = true;
        prevWasRBrace = false;
        continue;
      }
      if (isJsxOpenTagHead(text, i)) {
        if (options.stripCommentsMode) chunks.push('<');
        emit({ kind: 'punct', raw: '<', value: '<', escaped: false, start: i, end: i + 1, line });
        jsxStack.push({ mode: 'openTag', braceDepth: 0, angleDepth: 0 });
        i += 1;
        prevAllowsRegex = false;
        prevWasDot = false;
        prevWasControlKeyword = false;
        prevWasLt = true;
        prevWasGt = false;
        prevWasRBrace = false;
        continue;
      }
    }

    let punct = ch;
    for (const multi of MULTI_CHAR_PUNCTS) {
      if (text.startsWith(multi, i)) {
        punct = multi;
        break;
      }
    }
    if (options.stripCommentsMode) chunks.push(punct);
    emit({ kind: 'punct', raw: punct, value: punct, escaped: false, start: i, end: i + punct.length, line });
    if (punct === '/') {
      if (sameLineDivLine !== line) {
        sameLineDivLine = line;
        sameLineDivStarts = [i];
      } else {
        sameLineDivStarts.push(i);
      }
    }

    const topJsxAfterPunct = options.jsx ? jsxStack[jsxStack.length - 1] : undefined;
    if (topJsxAfterPunct?.mode === 'openTag') {
      if (punct === '<') topJsxAfterPunct.angleDepth += 1;
      else if (punct === '>') {
        if (topJsxAfterPunct.angleDepth > 0) topJsxAfterPunct.angleDepth -= 1;
        else topJsxAfterPunct.mode = 'elem';
      } else if (punct === '{') {
        jsxStack.push({ mode: 'expr', braceDepth: 1, angleDepth: 0 });
      }
    } else if (topJsxAfterPunct?.mode === 'expr') {
      if (punct === '{') topJsxAfterPunct.braceDepth += 1;
      else if (punct === '}') {
        topJsxAfterPunct.braceDepth -= 1;
        if (topJsxAfterPunct.braceDepth === 0) jsxStack.pop();
      }
    }

    if (punct === '(') {
      parenAllowsRegexStack.push(prevWasControlKeyword);
      prevAllowsRegex = true;
      prevWasDot = false;
    } else if (punct === ')') {
      prevAllowsRegex = parenAllowsRegexStack.pop() ?? false;
      prevWasDot = false;
    } else if (punct === '.' || punct === '?.') {
      prevWasDot = true;
      prevAllowsRegex = false;
    } else if (punct === ']' || punct === '++' || punct === '--') {
      prevAllowsRegex = false;
      prevWasDot = false;
    } else if (punct === '!') {
      // Prefix `!expr` leaves prevAllowsRegex=true; TypeScript postfix `expr!` preserves prevAllowsRegex=false for `/`.
      prevWasDot = false;
    } else {
      prevAllowsRegex = true;
      prevWasDot = false;
    }
    prevWasControlKeyword = false;
    prevWasLt = punct === '<';
    prevWasGt = punct === '>';
    prevWasRBrace = punct === '}';
    i += punct.length;
  }

  if (options.jsx && jsxStack.length > 0) {
    emit({ kind: 'invalid', raw: '', value: 'unclosed JSX element', escaped: false, start: text.length, end: text.length, line });
  }

  return {
    tokens,
    stripped: options.stripCommentsMode ? chunks.join('') : '',
    suspiciousDivisionStarts,
    suspiciousRegexStarts,
  };
}

function speculativeRescan(
  text: string,
  primaryScan: Pick<ScanSourceResult, 'suspiciousDivisionStarts' | 'suspiciousRegexStarts'>,
  jsx = false,
): Token[] | null {
  if (primaryScan.suspiciousDivisionStarts.size === 0 && primaryScan.suspiciousRegexStarts.size === 0) {
    return null;
  }
  return scanSource(text, {
    emitTokens: true,
    stripCommentsMode: false,
    stripStrings: false,
    forceRegexStarts: primaryScan.suspiciousDivisionStarts,
    skipRegexStarts: primaryScan.suspiciousRegexStarts,
    ...(jsx ? { jsx: true } : {}),
  }).tokens;
}

export function tokenize(text: string, opts?: { scanRegexAsDivision?: boolean; jsx?: boolean }): Token[] {
  return scanSource(text, {
    emitTokens: true,
    stripCommentsMode: false,
    stripStrings: false,
    ...(opts?.scanRegexAsDivision ? { scanRegexAsDivision: true } : {}),
    ...(opts?.jsx ? { jsx: true } : {}),
  }).tokens;
}

// Linear O(N) comment stripper with O(1) regex-prefix tracking and chunked output.
export function stripComments(text: string, stripStrings = false): string {
  return scanSource(text, { emitTokens: false, stripCommentsMode: true, stripStrings }).stripped;
}

function mainSpecifiers(text: string): string[] {
  return [
    ...text.matchAll(
      /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    ),
  ].map((m) => (m[1] ?? m[2] ?? m[3]) as string);
}

interface ModuleScanResult {
  specifiers: string[];
  hasComputedDynamic: boolean;
  hasInvalidSyntax: boolean;
  importDecls: Array<{ specifier: string; isNamespace: boolean; isDefault: boolean; isSideEffect: boolean }>;
  exportDecls: Array<{ specifier: string; isStar: boolean }>;
  dynamicCalls: Array<{ fn: 'import' | 'require'; specifier: string | null; argSnippet: string }>;
}

const isMemberPrev = (tokens: readonly Token[], idx: number): boolean => {
  if (idx <= 0) return false;
  const prev = tokens[idx - 1];
  return prev?.kind === 'punct' && (prev.value === '.' || prev.value === '?.');
};

function pairDelimiters(tokens: readonly Token[]): { paren: Int32Array; brace: Int32Array } {
  const paren = new Int32Array(tokens.length).fill(-1);
  const brace = new Int32Array(tokens.length).fill(-1);
  const parenStack: number[] = [];
  const braceStack: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind !== 'punct') continue;
    if (t.value === '(') parenStack.push(i);
    else if (t.value === ')' && parenStack.length > 0) paren[parenStack.pop()!] = i;
    else if (t.value === '{') braceStack.push(i);
    else if (t.value === '}' && braceStack.length > 0) brace[braceStack.pop()!] = i;
  }
  return { paren, brace };
}

function scanBalancedParenArg(
  tokens: readonly Token[],
  openParenIndex: number,
  matchingParen: Int32Array,
): { singleStringSpec: string | null; foldedStringSpec: string | null; argSnippet: string } {
  const closeParen = matchingParen[openParenIndex] ?? -1;
  if (closeParen < 0) return { singleStringSpec: null, foldedStringSpec: null, argSnippet: '' };

  let argSnippet = '';
  const argCount = closeParen - (openParenIndex + 1);
  if (argCount > 0 && argCount <= 20) {
    const rawParts: string[] = [];
    for (let idx = openParenIndex + 1; idx < closeParen; idx += 1) {
      rawParts.push(tokens[idx]!.raw);
    }
    argSnippet = rawParts.join('');
  }

  const t1 = tokens[openParenIndex + 1];
  if (!t1 || (t1.kind !== 'string' && t1.kind !== 'template')) {
    return { singleStringSpec: null, foldedStringSpec: null, argSnippet };
  }
  const t2 = tokens[openParenIndex + 2];
  if (openParenIndex + 2 === closeParen || (openParenIndex + 2 < closeParen && t2?.kind === 'punct' && t2.value === ',')) {
    return { singleStringSpec: t1.value, foldedStringSpec: null, argSnippet };
  }

  // Only inspect flat string/no-subst-template '+' concatenation chains for first argument; bail immediately on anything else.
  const parts: string[] = [t1.value];
  let k = openParenIndex + 2;
  let expectOp = true;
  while (k < closeParen) {
    const cur = tokens[k]!;
    if (expectOp) {
      if (cur.kind === 'punct' && cur.value === ',') break;
      if (cur.kind !== 'punct' || cur.value !== '+') return { singleStringSpec: null, foldedStringSpec: null, argSnippet };
      expectOp = false;
    } else {
      if (cur.kind !== 'string' && cur.kind !== 'template') return { singleStringSpec: null, foldedStringSpec: null, argSnippet };
      parts.push(cur.value);
      expectOp = true;
    }
    k += 1;
  }
  return expectOp && parts.length >= 2
    ? { singleStringSpec: null, foldedStringSpec: parts.join(''), argSnippet }
    : { singleStringSpec: null, foldedStringSpec: null, argSnippet };
}

const isFromKeywordAt = (tokens: readonly Token[], idx: number): boolean =>
  tokens[idx]?.kind === 'ident' &&
  tokens[idx]?.value === 'from' &&
  (tokens[idx + 1]?.kind === 'string' || tokens[idx + 1]?.kind === 'template');

function scanModuleTokens(tokens: readonly Token[]): ModuleScanResult {
  const delims = pairDelimiters(tokens);
  const specs: string[] = [];
  const importDecls: ModuleScanResult['importDecls'] = [];
  const exportDecls: ModuleScanResult['exportDecls'] = [];
  const dynamicCalls: ModuleScanResult['dynamicCalls'] = [];
  let hasComputedDynamic = false;
  let hasInvalidSyntax = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === 'invalid') {
      hasInvalidSyntax = true;
      continue;
    }
    if (t.kind !== 'ident' || isMemberPrev(tokens, i)) continue;

    if (t.value === 'import') {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.kind === 'punct' && next.value === '(') {
        const call = scanBalancedParenArg(tokens, i + 1, delims.paren);
        const resolved = call.singleStringSpec ?? call.foldedStringSpec;
        dynamicCalls.push({ fn: 'import', specifier: resolved, argSnippet: call.argSnippet });
        if (call.singleStringSpec !== null) specs.push(call.singleStringSpec);
        else {
          hasComputedDynamic = true;
          if (call.foldedStringSpec !== null) specs.push(call.foldedStringSpec);
        }
        continue;
      }
      if (next.kind === 'string' || next.kind === 'template') {
        specs.push(next.value);
        importDecls.push({ specifier: next.value, isNamespace: false, isDefault: false, isSideEffect: true });
        continue;
      }

      // Inspect import clause in O(1) using precomputed brace pairing
      let p = i + 1;
      if (tokens[p]?.kind === 'ident' && tokens[p]?.value === 'type') {
        const afterType = tokens[p + 1];
        if (afterType && ((afterType.kind === 'punct' && (afterType.value === '{' || afterType.value === '*')) || (afterType.kind === 'ident' && !isFromKeywordAt(tokens, p + 1)))) {
          p += 1;
        }
      }
      let isNamespace = false;
      let isDefault = false;
      if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '*') isNamespace = true;
      else if (tokens[p]?.kind === 'ident' && !isFromKeywordAt(tokens, p)) isDefault = true;

      while (p < tokens.length) {
        const cur = tokens[p]!;
        if (cur.kind === 'punct') {
          if (cur.value === '{') {
            const close = delims.brace[p] ?? -1;
            if (close < 0) break;
            p = close + 1;
            continue;
          }
          if (cur.value === ';' || cur.value === '=>') break;
          if (cur.value === '*') isNamespace = true;
        } else if (cur.kind === 'ident') {
          if (isFromKeywordAt(tokens, p)) {
            const specTok = tokens[p + 1];
            if (specTok && (specTok.kind === 'string' || specTok.kind === 'template')) {
              specs.push(specTok.value);
              importDecls.push({ specifier: specTok.value, isNamespace, isDefault, isSideEffect: false });
            }
            break;
          }
          if (cur.value === 'import' || cur.value === 'export' || cur.value === 'function' || cur.value === 'class') break;
        }
        p += 1;
      }
      continue;
    }

    if (t.value === 'export') {
      let p = i + 1;
      if (tokens[p]?.kind === 'ident' && tokens[p]?.value === 'type') p += 1;
      let isStar = false;
      if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '*') {
        isStar = true;
        p += 1;
        if (tokens[p]?.kind === 'ident' && tokens[p]?.value === 'as') p += 2;
      } else if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '{') {
        const close = delims.brace[p] ?? -1;
        if (close < 0) continue;
        p = close + 1;
      } else {
        continue;
      }
      if (isFromKeywordAt(tokens, p)) {
        const specTok = tokens[p + 1];
        if (specTok && (specTok.kind === 'string' || specTok.kind === 'template')) {
          specs.push(specTok.value);
          exportDecls.push({ specifier: specTok.value, isStar });
        }
      }
      continue;
    }

    if (t.value === 'require' && tokens[i + 1]?.kind === 'punct' && tokens[i + 1]?.value === '(') {
      const call = scanBalancedParenArg(tokens, i + 1, delims.paren);
      const resolved = call.singleStringSpec ?? call.foldedStringSpec;
      dynamicCalls.push({ fn: 'require', specifier: resolved, argSnippet: call.argSnippet });
      if (call.singleStringSpec !== null) specs.push(call.singleStringSpec);
      else {
        hasComputedDynamic = true;
        if (call.foldedStringSpec !== null) specs.push(call.foldedStringSpec);
      }
    }
  }

  return { specifiers: specs, hasComputedDynamic, hasInvalidSyntax, importDecls, exportDecls, dynamicCalls };
}

function specifiers(text: string, precomputedTokens?: readonly Token[]): { specifiers: string[]; scan: ModuleScanResult } {
  const scan = scanModuleTokens(precomputedTokens ?? tokenize(text));
  const rawMain = mainSpecifiers(text);
  const all = new Set<string>();
  for (const s of rawMain) {
    all.add(s);
    const decoded = decodeRawStringContent(s);
    if (decoded !== null) all.add(decoded);
  }
  for (const s of scan.specifiers) all.add(s);
  return { specifiers: [...all], scan };
}

const decodeUriSegment = (seg: string): string => {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg.replace(/%([2-7][0-9a-fA-F])/g, (_m, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
};

const normalizeModuleSpecifier = (spec: string): string => {
  let s = spec.trim().replace(/[?#].*$/, '').replace(/\\/g, '/').replace(/^file:\/\/(?:localhost)?/i, '');
  if (s === '') return '';
  const isRel = s.startsWith('./') || s.startsWith('../') || s === '.' || s === '..';
  s = posix.normalize(s);
  s = s.split('/').map(decodeUriSegment).join('/');
  const norm = posix.normalize(s);
  return isRel && !norm.startsWith('.') && !norm.startsWith('/') ? `./${norm}` : norm;
};

const decodeRawModulePreCollapse = (spec: string): string => {
  const s = spec.trim().replace(/[?#].*$/, '').replace(/\\/g, '/').replace(/^file:\/\/(?:localhost)?/i, '');
  return s === '' ? '' : s.split('/').map(decodeUriSegment).join('/');
};

const findMatchingSpecifier = (spec: string, re: RegExp): string | null => {
  const norm = normalizeModuleSpecifier(spec);
  if (norm && re.test(norm)) return norm;
  const preCollapse = decodeRawModulePreCollapse(spec);
  if (preCollapse && re.test(preCollapse)) return preCollapse;
  if (re.test(spec)) return spec;
  return null;
};

// What a member-Vy feature module must never import: the command runtime and the kernel, the database, and the vendors behind the ports.
const BANNED_IMPORT = /^(?:node:(?:https?|http2|net|tls|dgram)$|https?$|undici$|axios$|@crove\/(?:kernel|kernel-runtime|kernel-contract|db|mod-[a-z-]+)(?:\/|$)|kysely$|pg$|ai$|@ai-sdk\/|openai$|@anthropic-ai\/|mem0|@mem0\/|zep|@getzep\/|langchain|@langchain\/)/;

function collectMemberVyTokenPass(
  text: string,
  tokens: readonly Token[],
  out: Set<string>,
  assertSyntax: boolean,
): void {
  const { specifiers: specs, scan } = specifiers(text, tokens);
  for (const spec of specs) {
    const matched = findMatchingSpecifier(spec, BANNED_IMPORT);
    if (matched !== null) out.add(`imports ${matched}`);
  }
  if (scan.hasComputedDynamic) out.add('uses computed dynamic import or require');
  if (assertSyntax && scan.hasInvalidSyntax) out.add('contains invalid or unclosed syntax');

  const commandRe = /^((?:kernel|notes|meetings|finance|crm|hr|social|projects|calendar|desk)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)$/;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind === 'string' || tok.kind === 'template') {
      const m = commandRe.exec(tok.value);
      if (m?.[1]) out.add(`names the command or path ${m[1]}`);
      if (/\bcrove_[a-z]+\./.test(tok.value)) out.add('names a crove_ table');
    } else if (tok.kind === 'ident') {
      if (/^crove_[a-z]+$/.test(tok.value)) out.add('names a crove_ table');
      if (tok.value === 'XMLHttpRequest' || tok.value === 'WebSocket') out.add('calls the network directly');
      if (tok.value === 'execute' && tokens[i + 1]?.kind === 'punct' && tokens[i + 1]?.value === '(') {
        out.add('calls execute()');
      }
      if (tok.value === 'fetch' && tokens[i + 1]?.kind === 'punct' && tokens[i + 1]?.value === '(') {
        out.add('calls the network directly');
      }
    }
  }
}

// The violations of one member-Vy feature module's source, as short reasons.
export function memberVyViolations(text: string): string[] {
  const out = new Set<string>();
  const primary = scanSource(text, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  collectMemberVyTokenPass(text, primary.tokens, out, true);
  const extraTokens = speculativeRescan(text, primary);
  if (extraTokens !== null) {
    collectMemberVyTokenPass(text, extraTokens, out, false);
  }
  // A command name: a module namespace and two or more further segments in a string (kernel.member_vy.result.store, notes.todo.create).
  for (const m of text.matchAll(/['"`]((?:kernel|notes|meetings|finance|crm|hr|social|projects|calendar|desk)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)['"`]/g)) {
    out.add(`names the command or path ${m[1]}`);
  }
  if (/\bcrove_[a-z]+\./.test(text)) out.add('names a crove_ table');
  if (/\bexecute\s*\(/.test(text)) out.add('calls execute()');
  if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/.test(text)) out.add('calls the network directly');
  return [...out];
}

function collectOrgFeatureTokenPass(
  text: string,
  tokens: readonly Token[],
  out: Set<string>,
  assertSyntax: boolean,
): void {
  const { specifiers: specs, scan } = specifiers(text, tokens);
  for (const spec of specs) {
    const matched = findMatchingSpecifier(spec, /(^|\/)member-vy(\/|$)|(^|\/)private-text(?:\.[cm]?[jt]s)?$/);
    if (matched !== null) out.add(`imports ${matched}`);
  }
  if (scan.hasComputedDynamic) out.add('uses computed dynamic import or require');
  if (assertSyntax && scan.hasInvalidSyntax) out.add('contains invalid or unclosed syntax');
  if (tokens.some((t) => t.kind === 'ident' && t.value === 'PrivateText')) {
    out.add('names PrivateText');
  }
}

// What org-level features outside member-vy/ must never reach for: a member-Vy module, or the private-text brand.
export function orgFeatureViolations(text: string): string[] {
  const primary = scanSource(text, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  const body = stripComments(text);
  const out = new Set<string>();
  collectOrgFeatureTokenPass(text, primary.tokens, out, true);
  const extraTokens = speculativeRescan(text, primary);
  if (extraTokens !== null) {
    collectOrgFeatureTokenPass(text, extraTokens, out, false);
  }
  if (/\bPrivateText\b/.test(text) || /\bPrivateText\b/.test(body)) {
    out.add('names PrivateText');
  }
  return [...out];
}

// The member-Vy names a file outside member-vy/ must not carry, and the notes feature keys (N8) it must not meter
// outside the dedicated Stage A ModelPort adapter (note-ai-model.ts).
export const MODEL_ADAPTERS = new Set(['note-ai-model.ts']);
const ADAPTER_NOTES_KEYS = new Set(['notes.summary', 'notes.todo_suggest', 'notes.todo_plan', 'notes.organize']);
const ADAPTER_NOTE_IMPORT_RE = /(?:^|\/)note-ai-model(?:\.[cm]?[jt]s)?$/;
const isNoteAiModelSpecifier = (spec: string): boolean => ADAPTER_NOTE_IMPORT_RE.test(normalizeModuleSpecifier(spec));
const DEFAULT_ADAPTER_EXPORTS = ['generateNoteSummaryText', 'generateTodoSuggestText'] as const;

export function memberVyNames(text: string): string[] {
  const names = new Set(['memberVy', 'member_vy', 'PrivateText']);
  const found = new Set<string>();
  for (const name of names) {
    if (new RegExp(`\\b${name}\\b`).test(text)) found.add(name);
  }
  for (const tok of tokenize(text)) {
    if ((tok.kind === 'ident' || tok.kind === 'string' || tok.kind === 'template') && names.has(tok.value)) {
      found.add(tok.value);
    }
  }
  return [...found];
}

function formatNotesTemplateSpan(text: string, head: Token, tail: Token): string {
  const innerLen = tail.end - 1 - (head.start + 1);
  if (innerLen <= 256) return text.slice(head.start + 1, tail.end - 1);
  return `${head.value.slice(0, 64)}\${...}`;
}

function collectMeteredNotesFromTokens(tokens: readonly Token[], text: string): string[] {
  const out: string[] = [];
  // Precompute matching template_head -> template_tail in O(T) so deeply nested metered(`notes.${metered(...)}`) stays O(N).
  const templateTail = new Int32Array(tokens.length).fill(-1);
  const tplStack: number[] = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const tk = tokens[k]!;
    if (tk.kind === 'template_head') tplStack.push(k);
    else if (tk.kind === 'template_tail' && tplStack.length > 0) templateTail[tplStack.pop()!] = k;
  }
  // Stack-based O(T) matching for generic type arguments `<...>` between `metered` and `(`.
  const ltStack: boolean[] = [];
  const closedMeteredGt = new Set<number>();

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === 'punct' && t.value === '<') {
      const prev = tokens[i - 1];
      ltStack.push(Boolean(prev?.kind === 'ident' && prev.value === 'metered' && !isMemberPrev(tokens, i - 1)));
      continue;
    }
    if (t.kind === 'punct' && t.value === '>') {
      if (ltStack.length > 0 && ltStack.pop()) closedMeteredGt.add(i);
      continue;
    }
    if (t.kind === 'punct' && (t.value === ';' || t.value === '{' || t.value === '}')) {
      ltStack.length = 0;
      continue;
    }
    if (t.kind === 'punct' && t.value === '(' && i > 0) {
      const prev = tokens[i - 1]!;
      const isDirectMetered = prev.kind === 'ident' && prev.value === 'metered' && !isMemberPrev(tokens, i - 1);
      const isGenericMetered = prev.kind === 'punct' && prev.value === '>' && closedMeteredGt.has(i - 1);
      if (!isDirectMetered && !isGenericMetered) continue;
      const arg = tokens[i + 1];
      if (!arg) continue;
      if ((arg.kind === 'string' || arg.kind === 'template') && arg.value.startsWith('notes.')) {
        out.push(arg.value);
      } else if (arg.kind === 'template_head' && arg.value.startsWith('notes.')) {
        const tailIdx = templateTail[i + 1] ?? -1;
        if (tailIdx >= 0) {
          out.push(formatNotesTemplateSpan(text, arg, tokens[tailIdx]!));
        } else {
          out.push(`${arg.value.slice(0, 64)}\${...}`);
        }
      }
    }
  }
  return out;
}

function collectRawMeteredNotes(text: string): string[] {
  const out: string[] = [];
  let pos = 0;
  while ((pos = text.indexOf('metered', pos)) >= 0) {
    const before = pos > 0 ? text[pos - 1]! : '';
    let j = pos + 'metered'.length;
    pos = j;
    if (/[\w$]/.test(before) || /[\w$]/.test(text[j] ?? '')) continue;
    while (j < text.length && isWhitespaceCode(text.charCodeAt(j))) j += 1;
    if (text[j] !== '(') continue;
    j += 1;
    while (j < text.length && isWhitespaceCode(text.charCodeAt(j))) j += 1;
    const q = text[j];
    if (q !== "'" && q !== '"' && q !== '`') continue;
    const bodyStart = j + 1;
    const scanLimit = Math.min(text.length, bodyStart + 256);
    let end = bodyStart;
    let valid = true;
    while (end < scanLimit && text[end] !== q) {
      if (q !== '`' && (text[end] === '\n' || text[end] === '\r')) {
        valid = false;
        break;
      }
      end += text[end] === '\\' ? 2 : 1;
    }
    if (!valid) continue;
    if (text[end] !== q) {
      // Bound raw literal inspection to 256 chars so O(N) scaling holds on huge or nested literals.
      const headRaw = text.slice(bodyStart, Math.min(bodyStart + 64, text.length));
      const headDecoded = decodeRawStringContent(headRaw) ?? headRaw;
      if (headDecoded.startsWith('notes.')) out.push(`${headDecoded}...`);
      continue;
    }
    const rawInner = text.slice(bodyStart, end);
    const decoded = decodeRawStringContent(rawInner) ?? rawInner;
    if (decoded.startsWith('notes.')) out.push(decoded);
  }
  return out;
}

export function meteredNotes(text: string): string[] {
  const primary = scanSource(text, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  const extraTokens = speculativeRescan(text, primary);
  const found = new Set<string>([
    ...collectMeteredNotesFromTokens(primary.tokens, text),
    ...collectMeteredNotesFromTokens(tokenize(text, { scanRegexAsDivision: true }), text),
    ...(extraTokens ? collectMeteredNotesFromTokens(extraTokens, text) : []),
    ...collectRawMeteredNotes(text),
    ...[...text.matchAll(/\bmetered\(\s*['"`](notes\.[a-z0-9_]+)['"`]/g)].map((m) => m[1]!),
  ]);
  return [...found];
}

export function notesKeyLiterals(text: string): string[] {
  const found = new Set<string>();
  const primary = scanSource(text, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  const extraTokens = speculativeRescan(text, primary);
  const tokenPasses: ReadonlyArray<readonly Token[]> = [
    primary.tokens,
    tokenize(text, { scanRegexAsDivision: true }),
    ...(extraTokens ? [extraTokens] : []),
  ];
  for (const tokens of tokenPasses) {
    const headStack: number[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i]!;
      if ((t.kind === 'string' || t.kind === 'template') && t.value.startsWith('notes.')) {
        found.add(t.value);
      } else if (t.kind === 'template_head') {
        headStack.push(i);
      } else if (t.kind === 'template_tail' && headStack.length > 0) {
        const headIdx = headStack.pop()!;
        const head = tokens[headIdx]!;
        if (head.value.startsWith('notes.')) {
          found.add(formatNotesTemplateSpan(text, head, t));
        }
      }
    }
  }
  return [...found];
}

export function disallowedMeteredNotes(relFromSrc: string, text: string): string[] {
  const calls = meteredNotes(text);
  const literals = notesKeyLiterals(text);
  const all = [...new Set([...calls, ...literals])];
  if (MODEL_ADAPTERS.has(relFromSrc)) return all.filter((key) => !ADAPTER_NOTES_KEYS.has(key));
  if (relFromSrc === 'meter.ts') {
    return [...new Set([...calls, ...literals.filter((key) => !ADAPTER_NOTES_KEYS.has(key))])];
  }
  return all;
}

const ADAPTER_BANNED_TYPE_IDENTS = new Set(['import', 'require', 'eval', 'Function', 'globalThis', 'Reflect']);
const ADAPTER_RESERVED_BINDINGS = new Set([
  'generateText',
  'chatModel',
  'metered',
  'AiConfig',
  'eval',
  'Function',
  'arguments',
  'globalThis',
  'Reflect',
  'import',
  'require',
]);
const ADAPTER_ALLOWED_OPTION_KEYS = new Set(['model', 'system', 'prompt', 'maxOutputTokens', 'maxRetries', 'abortSignal']);
const ADAPTER_REQUIRED_OPTION_KEYS = ['model', 'system', 'prompt', 'maxOutputTokens'] as const;

// Recursive-descent structural allowlist parser for note-ai-model.ts.
// Fails closed on any lexical escape, invalid token, disallowed import, unexpected declaration, dynamic call, or option shape.
export function modelAdapterViolations(text: string): string[] {
  const tokens = tokenize(text);
  const { specifiers: rawSpecs, scan } = specifiers(text);
  const out = new Set<string>();

  for (const spec of rawSpecs) {
    if (spec !== 'ai' && spec !== './index.ts' && spec !== './meter.ts') out.add(`imports ${spec}`);
  }
  if (scan.hasComputedDynamic) out.add('uses dynamic import or require');
  for (const call of scan.dynamicCalls) {
    out.add('uses dynamic import or require');
    if (call.specifier && call.specifier !== 'ai' && call.specifier !== './index.ts' && call.specifier !== './meter.ts') {
      out.add(`imports ${call.specifier}`);
    }
  }

  if (tokens.some((t) => t.kind === 'invalid')) {
    out.add('contains invalid or unclosed syntax');
    return [...out];
  }
  if (tokens.length === 0) {
    out.add('requires at least one exported function declaration');
    return [...out];
  }

  let idx = 0;
  const peek = (offset = 0): Token | undefined => tokens[idx + offset];
  const consume = (): Token | undefined => {
    const t = tokens[idx];
    if (t) idx += 1;
    return t;
  };
  const isUnescapedIdent = (t: Token | undefined, name?: string): boolean =>
    Boolean(t && t.kind === 'ident' && !t.escaped && (name === undefined || t.value === name));
  const isUnescapedString = (t: Token | undefined): boolean =>
    Boolean(t && t.kind === 'string' && !t.escaped && t.raw.slice(1, -1) === t.value);
  const isPunct = (t: Token | undefined, sym?: string): boolean =>
    Boolean(t && t.kind === 'punct' && (sym === undefined || t.value === sym));

  const consumeStmtSeparator = (prevEndLine: number): boolean => {
    if (isPunct(peek(), ';')) {
      consume();
      return true;
    }
    const nextTok = peek();
    return !nextTok || nextTok.line > prevEndLine;
  };

  const importedValues = new Set<string>();

  const parseImportDecl = (): boolean => {
    consume(); // 'import'
    let wholeTypeOnly = false;
    if (isUnescapedIdent(peek(), 'type') && isPunct(peek(1), '{')) {
      wholeTypeOnly = true;
      consume();
    }
    if (!isPunct(peek(), '{')) {
      out.add('uses disallowed import form');
      return false;
    }
    consume(); // '{'
    const specifiersParsed: Array<{ name: string; isType: boolean }> = [];
    while (idx < tokens.length && !isPunct(peek(), '}')) {
      let specType = wholeTypeOnly;
      if (!wholeTypeOnly && isUnescapedIdent(peek(), 'type') && peek(1)?.kind === 'ident') {
        specType = true;
        consume();
      }
      const nameTok = consume();
      if (!nameTok || !isUnescapedIdent(nameTok)) {
        out.add('uses non-identifier or escaped import specifier');
        return false;
      }
      if (isUnescapedIdent(peek(), 'as')) {
        out.add('uses aliased import specifier');
        return false;
      }
      specifiersParsed.push({ name: nameTok.value, isType: specType });
      if (isPunct(peek(), ',')) {
        consume();
        continue;
      }
      if (!isPunct(peek(), '}')) {
        out.add('uses malformed import specifier list');
        return false;
      }
    }
    if (!isPunct(peek(), '}') || specifiersParsed.length === 0) {
      out.add('uses empty or unclosed import block');
      return false;
    }
    consume(); // '}'
    if (!isUnescapedIdent(peek(), 'from')) {
      out.add('missing from in import declaration');
      return false;
    }
    consume(); // 'from'
    const srcTok = consume();
    if (!srcTok || !isUnescapedString(srcTok)) {
      out.add('uses escaped or invalid import source');
      return false;
    }
    if (!consumeStmtSeparator(srcTok.line)) {
      out.add('missing statement separator after import declaration');
      return false;
    }

    if (srcTok.value === 'ai') {
      if (wholeTypeOnly) {
        out.add('imports disallowed symbol from ai');
        return false;
      }
      for (const s of specifiersParsed) {
        if (s.isType || s.name !== 'generateText') {
          out.add('imports disallowed symbol from ai');
          return false;
        }
        importedValues.add('generateText');
      }
      return true;
    }
    if (srcTok.value === './index.ts') {
      for (const s of specifiersParsed) {
        if (s.name === 'chatModel' && !s.isType) {
          importedValues.add('chatModel');
        } else if (s.name === 'AiConfig' && s.isType) {
          // type-only AiConfig allowed
        } else {
          out.add('imports disallowed symbol from ./index.ts');
          return false;
        }
      }
      return true;
    }
    if (srcTok.value === './meter.ts') {
      if (wholeTypeOnly) {
        out.add('imports disallowed symbol from ./meter.ts');
        return false;
      }
      for (const s of specifiersParsed) {
        if (s.isType || s.name !== 'metered') {
          out.add('imports disallowed symbol from ./meter.ts');
          return false;
        }
        importedValues.add('metered');
      }
      return true;
    }
    out.add(`imports ${srcTok.value}`);
    return false;
  };

  const parseTypeExpr = (): boolean => {
    const parsePrimaryType = (): boolean => {
      if (isPunct(peek(), '{')) {
        consume(); // '{'
        while (idx < tokens.length && !isPunct(peek(), '}')) {
          const keyTok = consume();
          if (!keyTok || !isUnescapedIdent(keyTok) || ADAPTER_BANNED_TYPE_IDENTS.has(keyTok.value)) return false;
          if (isPunct(peek(), '?')) consume();
          if (!isPunct(peek(), ':')) return false;
          consume();
          if (!parseTypeExpr()) return false;
          if (isPunct(peek(), ';') || isPunct(peek(), ',')) consume();
          else if (!isPunct(peek(), '}')) return false;
        }
        if (!isPunct(peek(), '}')) return false;
        consume();
      } else {
        const idTok = consume();
        if (!idTok || !isUnescapedIdent(idTok) || ADAPTER_BANNED_TYPE_IDENTS.has(idTok.value)) return false;
        while (isPunct(peek(), '.')) {
          consume();
          const memTok = consume();
          if (!memTok || !isUnescapedIdent(memTok) || ADAPTER_BANNED_TYPE_IDENTS.has(memTok.value)) return false;
        }
        if (isPunct(peek(), '<')) {
          consume();
          let first = true;
          while (idx < tokens.length && !isPunct(peek(), '>')) {
            if (!first) {
              if (!isPunct(peek(), ',')) return false;
              consume();
            }
            first = false;
            if (!parseTypeExpr()) return false;
          }
          if (!isPunct(peek(), '>') || first) return false;
          consume();
        }
      }
      while (isPunct(peek(), '[') && isPunct(peek(1), ']')) {
        consume();
        consume();
      }
      return true;
    };

    if (!parsePrimaryType()) return false;
    while (isPunct(peek(), '|') || isPunct(peek(), '&')) {
      consume();
      if (!parsePrimaryType()) return false;
    }
    return true;
  };

  const parseGenerateTextCall = (paramNames: ReadonlySet<string>): boolean => {
    const fnTok = consume();
    if (!isUnescapedIdent(fnTok, 'generateText') || !importedValues.has('generateText')) {
      out.add('passes opaque options or aliases generateText');
      return false;
    }
    if (!isPunct(peek(), '(')) {
      out.add('passes opaque options or aliases generateText');
      return false;
    }
    consume(); // '('
    if (!isPunct(peek(), '{')) {
      out.add('passes opaque options or aliases generateText');
      return false;
    }
    consume(); // '{'

    const seenKeys = new Set<string>();
    while (idx < tokens.length && !isPunct(peek(), '}')) {
      const keyTok = consume();
      if (!keyTok || !isUnescapedIdent(keyTok)) {
        out.add('uses non-identifier or escaped option key in generateText');
        return false;
      }
      const key = keyTok.value;
      if (!ADAPTER_ALLOWED_OPTION_KEYS.has(key)) {
        if (key === 'tools' || key === 'toolChoice' || key === 'stopWhen' || key === 'maxSteps' || key === 'prepareStep' || key === 'activeTools') {
          out.add('uses model tools');
        } else {
          out.add(`uses disallowed generateText option ${key}`);
        }
        return false;
      }
      if (seenKeys.has(key)) {
        out.add(`uses duplicate generateText option ${key}`);
        return false;
      }
      seenKeys.add(key);

      if (key === 'abortSignal' && (isPunct(peek(), ',') || isPunct(peek(), '}'))) {
        if (!paramNames.has('abortSignal')) {
          out.add('uses non-parameter abortSignal');
          return false;
        }
      } else {
        if (!isPunct(peek(), ':')) {
          out.add('uses disallowed property syntax in generateText');
          return false;
        }
        consume(); // ':'
        if (key === 'model') {
          const cmTok = consume();
          const lp = consume();
          const argTok = consume();
          const rp = consume();
          if (
            !cmTok ||
            !isUnescapedIdent(cmTok, 'chatModel') ||
            !importedValues.has('chatModel') ||
            !isPunct(lp, '(') ||
            !argTok ||
            !isUnescapedIdent(argTok) ||
            !paramNames.has(argTok.value) ||
            !isPunct(rp, ')')
          ) {
            out.add('uses disallowed model option in generateText');
            return false;
          }
        } else if (key === 'system') {
          const pTok = consume();
          if (!pTok || !isUnescapedIdent(pTok) || !paramNames.has(pTok.value)) {
            out.add('uses disallowed system option in generateText');
            return false;
          }
          if (isPunct(peek(), '.')) {
            consume();
            const propTok = consume();
            if (!propTok || !isUnescapedIdent(propTok, 'system')) {
              out.add('uses disallowed system option in generateText');
              return false;
            }
          }
        } else if (key === 'prompt') {
          const pTok = consume();
          if (!pTok || !isUnescapedIdent(pTok) || !paramNames.has(pTok.value)) {
            out.add('uses disallowed prompt option in generateText');
            return false;
          }
          if (isPunct(peek(), '.')) {
            consume();
            const propTok = consume();
            if (!propTok || !isUnescapedIdent(propTok) || (propTok.value !== 'user' && propTok.value !== 'prompt')) {
              out.add('uses disallowed prompt option in generateText');
              return false;
            }
          }
        } else if (key === 'maxOutputTokens') {
          const valTok = consume();
          if (valTok && isUnescapedIdent(valTok)) {
            if (!paramNames.has(valTok.value)) {
              out.add('uses disallowed maxOutputTokens option in generateText');
              return false;
            }
          } else if (valTok?.kind === 'number' && /^[1-9](?:_?[0-9])*$/.test(valTok.raw)) {
            const parsedNum = Number(valTok.raw.replace(/_/g, ''));
            if (!Number.isSafeInteger(parsedNum) || parsedNum < 1 || parsedNum > 16_000) {
              out.add('uses out-of-range maxOutputTokens option in generateText');
              return false;
            }
          } else {
            out.add('uses disallowed maxOutputTokens option in generateText');
            return false;
          }
        } else if (key === 'maxRetries') {
          const valTok = consume();
          if (valTok?.kind !== 'number' || valTok.raw !== '0') {
            out.add('uses disallowed maxRetries option in generateText');
            return false;
          }
        } else if (key === 'abortSignal') {
          const argTok = consume();
          if (!argTok || !isUnescapedIdent(argTok) || !paramNames.has(argTok.value)) {
            out.add('uses non-parameter abortSignal');
            return false;
          }
        }
      }

      if (isPunct(peek(), ',')) {
        consume();
        continue;
      }
      if (!isPunct(peek(), '}')) {
        out.add('uses malformed options object in generateText');
        return false;
      }
    }

    if (!isPunct(peek(), '}')) {
      out.add('uses unclosed options object in generateText');
      return false;
    }
    consume(); // '}'
    if (isPunct(peek(), ',')) consume(); // optional trailing comma
    if (!isPunct(peek(), ')')) {
      out.add('uses extra arguments in generateText call');
      return false;
    }
    consume(); // ')'

    for (const reqKey of ADAPTER_REQUIRED_OPTION_KEYS) {
      if (!seenKeys.has(reqKey)) {
        out.add(`missing required generateText option ${reqKey}`);
        return false;
      }
    }
    return true;
  };

  const parseExportedFunction = (): boolean => {
    consume(); // 'export'
    const isAsyncFn = isUnescapedIdent(peek(), 'async');
    if (isAsyncFn) consume();
    if (!isUnescapedIdent(peek(), 'function')) {
      out.add('uses disallowed top-level export declaration');
      return false;
    }
    consume(); // 'function'
    if (isPunct(peek(), '*')) {
      out.add('uses generator in adapter');
      return false;
    }
    const fnName = consume();
    if (!fnName || !isUnescapedIdent(fnName) || ADAPTER_RESERVED_BINDINGS.has(fnName.value)) {
      out.add('uses invalid exported function name');
      return false;
    }
    if (!isPunct(peek(), '(')) {
      out.add('uses malformed parameter list');
      return false;
    }
    consume(); // '('

    const paramNames = new Set<string>();
    while (idx < tokens.length && !isPunct(peek(), ')')) {
      const paramTok = consume();
      if (!paramTok || !isUnescapedIdent(paramTok) || ADAPTER_RESERVED_BINDINGS.has(paramTok.value)) {
        out.add('uses non-identifier parameter in adapter function');
        return false;
      }
      if (paramNames.has(paramTok.value)) {
        out.add('uses duplicate parameter name');
        return false;
      }
      paramNames.add(paramTok.value);
      if (isPunct(peek(), '?')) consume();
      if (isPunct(peek(), ':')) {
        consume();
        if (!parseTypeExpr()) {
          out.add('uses disallowed parameter type annotation');
          return false;
        }
      }
      if (isPunct(peek(), ',')) {
        consume();
        continue;
      }
      if (!isPunct(peek(), ')')) {
        out.add('uses default value or invalid parameter syntax');
        return false;
      }
    }
    if (!isPunct(peek(), ')')) {
      out.add('uses unclosed parameter list');
      return false;
    }
    consume(); // ')'

    if (isPunct(peek(), ':')) {
      consume();
      if (!parseTypeExpr()) {
        out.add('uses disallowed return type annotation');
        return false;
      }
    }

    if (!isPunct(peek(), '{')) {
      out.add('missing function body block');
      return false;
    }
    consume(); // '{'

    if (!isUnescapedIdent(peek(), 'return')) {
      out.add('adapter function body must be a single return metered(...) statement');
      return false;
    }
    consume(); // 'return'
    if (isUnescapedIdent(peek(), 'await')) {
      if (!isAsyncFn) {
        out.add('uses await in synchronous adapter function');
        return false;
      }
      consume();
    }

    const meterTok = consume();
    if (!meterTok || !isUnescapedIdent(meterTok, 'metered') || !importedValues.has('metered') || !isPunct(peek(), '(')) {
      out.add('adapter function body must return metered(...) directly');
      return false;
    }
    consume(); // '('

    const keyTok = consume();
    if (!keyTok || !isUnescapedString(keyTok) || !ADAPTER_NOTES_KEYS.has(keyTok.value)) {
      out.add('metered() call must use an allowed notes adapter literal key');
      return false;
    }
    if (!isPunct(peek(), ',')) {
      out.add('uses malformed metered() arguments');
      return false;
    }
    consume(); // ','

    if (!isPunct(peek(), '(') || !isPunct(peek(1), ')') || !isPunct(peek(2), '=>')) {
      out.add('metered() callback must be a zero-arg arrow () => generateText(...)');
      return false;
    }
    consume(); // '('
    consume(); // ')'
    consume(); // '=>'

    if (isPunct(peek(), '{')) {
      consume(); // '{'
      if (!isUnescapedIdent(peek(), 'return')) {
        out.add('metered() arrow block must only return generateText(...)');
        return false;
      }
      consume(); // 'return'
      if (!parseGenerateTextCall(paramNames)) return false;
      if (isPunct(peek(), ';')) consume();
      if (!isPunct(peek(), '}')) {
        out.add('metered() arrow block contains extra statements');
        return false;
      }
      consume(); // '}'
    } else if (!parseGenerateTextCall(paramNames)) {
      return false;
    }

    if (isPunct(peek(), ',')) consume(); // optional trailing comma
    if (!isPunct(peek(), ')')) {
      out.add('uses extra arguments in metered() call');
      return false;
    }
    consume(); // ')'

    if (isPunct(peek(), ';')) consume();
    if (!isPunct(peek(), '}')) {
      out.add('adapter function contains extra statements outside return metered(...)');
      return false;
    }
    const closeBrace = consume()!;
    if (!consumeStmtSeparator(closeBrace.line)) {
      out.add('missing statement separator after exported function');
      return false;
    }
    return true;
  };

  let parsedCleanly = true;
  while (idx < tokens.length && isUnescapedIdent(peek(), 'import')) {
    if (!parseImportDecl()) {
      parsedCleanly = false;
      break;
    }
  }

  let functionCount = 0;
  while (parsedCleanly && idx < tokens.length) {
    if (!isUnescapedIdent(peek(), 'export')) {
      out.add('uses disallowed top-level statement');
      parsedCleanly = false;
      break;
    }
    if (!parseExportedFunction()) {
      parsedCleanly = false;
      break;
    }
    functionCount += 1;
  }

  if (parsedCleanly && functionCount === 0) out.add('requires at least one exported function declaration');
  if (!parsedCleanly && out.size === 0) out.add('fails structural adapter allowlist');
  return [...out];
}

export function adapterExports(text: string): string[] {
  const tokens = tokenize(text);
  const found = new Set<string>();
  let depth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === 'punct') {
      if (t.value === '{' || t.value === '(' || t.value === '[') depth += 1;
      else if ((t.value === '}' || t.value === ')' || t.value === ']') && depth > 0) depth -= 1;
      continue;
    }
    if (depth !== 0 || t.kind !== 'ident' || t.value !== 'export') continue;

    let p = i + 1;
    if (tokens[p]?.kind === 'ident' && tokens[p]?.value === 'async') p += 1;
    if (tokens[p]?.kind === 'ident' && (tokens[p]?.value === 'function' || tokens[p]?.value === 'class')) {
      p += 1;
      if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '*') p += 1;
      if (tokens[p]?.kind === 'ident') found.add(tokens[p]!.value);
      continue;
    }

    if (tokens[p]?.kind === 'ident' && (tokens[p]?.value === 'const' || tokens[p]?.value === 'let' || tokens[p]?.value === 'var')) {
      p += 1;
      let d = 0;
      let angleDepth = 0;
      let inType = false;
      let inInit = false;
      let expectName = true;
      let lastEndLine = tokens[p - 1]!.line;
      let prevTok: Token = tokens[p - 1]!;

      while (p < tokens.length) {
        const cur = tokens[p]!;
        if (d === 0 && angleDepth === 0 && cur.line > lastEndLine && inInit) {
          const prevContinues =
            prevTok.kind === 'punct' && '=,+*/%&|^~?:<>!.-\\'.includes(prevTok.value[prevTok.value.length - 1] ?? '');
          const nextContinues =
            cur.kind === 'punct' && ',.[(?+*/%&|^~?:<>!-'.includes(cur.value[0] ?? '');
          if (!prevContinues && !nextContinues) break;
        }
        if (expectName && cur.kind === 'ident') {
          found.add(cur.value);
          expectName = false;
          prevTok = cur;
          lastEndLine = cur.line;
          p += 1;
          continue;
        }
        expectName = false;
        if (cur.kind === 'punct') {
          if (cur.value === '(' || cur.value === '[' || cur.value === '{') d += 1;
          else if ((cur.value === ')' || cur.value === ']' || cur.value === '}') && d > 0) d -= 1;
          else if (d === 0) {
            if (cur.value === ';') break;
            if (inType && cur.value === '<') angleDepth += 1;
            else if (inType && cur.value === '>' && angleDepth > 0) angleDepth -= 1;
            else if (cur.value === ':' && !inInit && angleDepth === 0) inType = true;
            else if (cur.value === '=' && angleDepth === 0) {
              inType = false;
              inInit = true;
            } else if (cur.value === ',' && !inType && angleDepth === 0) {
              inInit = false;
              expectName = true;
            }
          }
        }
        prevTok = cur;
        lastEndLine = cur.line;
        p += 1;
      }
    }
  }
  return [...found];
}

function collectSymbolTokenMatches(
  tokens: readonly Token[],
  symbolSet: ReadonlySet<string>,
  found: Set<string>,
): void {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if ((t.kind === 'ident' || t.kind === 'string' || t.kind === 'template') && symbolSet.has(t.value)) {
      found.add(t.value);
    }
    // Check adjacent constant string/no-subst-template '+' concatenation chains.
    if (t.kind === 'string' || t.kind === 'template') {
      let acc = t.value;
      let j = i;
      let chained = false;
      while (j + 2 < tokens.length) {
        const op = tokens[j + 1]!;
        const rhs = tokens[j + 2]!;
        if (op.kind === 'punct' && op.value === '+' && (rhs.kind === 'string' || rhs.kind === 'template')) {
          acc += rhs.value;
          chained = true;
          if (symbolSet.has(acc)) found.add(acc);
          j += 2;
        } else {
          break;
        }
      }
      if (chained && symbolSet.has(acc)) found.add(acc);
      i = j;
    }
  }
}

export function adapterSymbolReferences(
  symbols: readonly string[],
  fileText: string,
  precomputedTokens?: readonly Token[],
): string[] {
  if (symbols.length === 0) return [];
  const symbolSet = new Set(symbols);
  const found = new Set<string>();
  collectSymbolTokenMatches(precomputedTokens ?? tokenize(fileText), symbolSet, found);
  for (const sym of symbols) {
    if (found.has(sym)) continue;
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^\\w$])${escaped}(?![\\w$])`);
    if (re.test(fileText)) found.add(sym);
  }
  return symbols.filter((sym) => found.has(sym));
}

export function importsNoteAiModel(fileText: string): boolean {
  const primary = scanSource(fileText, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  if (specifiers(fileText, primary.tokens).specifiers.some((spec) => isNoteAiModelSpecifier(spec))) return true;
  const extra = speculativeRescan(fileText, primary);
  return extra !== null && specifiers(fileText, extra).specifiers.some((spec) => isNoteAiModelSpecifier(spec));
}

function isDirectUnaliasedExportList(items: readonly Token[]): boolean {
  let idx = 0;
  let count = 0;
  while (idx < items.length) {
    if (items[idx]?.kind === 'ident' && !items[idx]!.escaped && items[idx]!.value === 'type' && items[idx + 1]?.kind === 'ident') {
      idx += 1;
    }
    const symTok = items[idx];
    if (!symTok || symTok.kind !== 'ident' || symTok.escaped || symTok.value === 'default' || symTok.value === 'as') {
      return false;
    }
    count += 1;
    idx += 1;
    if (idx < items.length) {
      const sep = items[idx]!;
      if (sep.kind !== 'punct' || sep.value !== ',') return false;
      idx += 1;
    }
  }
  return count > 0;
}

function collectIndexViolationsFromTokens(
  indexText: string,
  tokens: readonly Token[],
  symbols: readonly string[],
  assertSyntax: boolean,
): string[] {
  const delims = pairDelimiters(tokens);
  const symbolSet = new Set(symbols);
  const violations = new Set<string>();
  const { specifiers: allSpecs, scan } = specifiers(indexText, tokens);

  if (assertSyntax && scan.hasInvalidSyntax) violations.add('contains invalid or unclosed syntax');
  if (scan.hasComputedDynamic) {
    // Package barrel index.ts must never use computed dynamic imports (e.g., import(`./note-ai-${x}`)).
    violations.add('uses computed dynamic import or require inside index.ts');
  }
  if (allSpecs.some((spec) => isAgentBarrel(spec, 'packages/agent/src/index.ts'))) {
    // Reject self-imports / barrel re-imports (e.g., import * as a from './index.ts') that could wrap adapter exports.
    violations.add('imports self inside index.ts instead of direct re-export');
  }

  let directValidReexports = 0;
  let totalAdapterSpecOccurrences = 0;
  let flaggedAdapter = false;
  const validNamedReexportSpans: Array<{ openBrace: number; closeBrace: number }> = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind !== 'ident' || isMemberPrev(tokens, i)) continue;

    if (t.value === 'import') {
      const next = tokens[i + 1];
      if (next?.kind === 'punct' && next.value === '(') {
        const call = scanBalancedParenArg(tokens, i + 1, delims.paren);
        const resolved = call.singleStringSpec ?? call.foldedStringSpec;
        if (resolved !== null && isNoteAiModelSpecifier(resolved)) {
          totalAdapterSpecOccurrences += 1;
          violations.add('imports note-ai-model inside index.ts instead of direct re-export');
          flaggedAdapter = true;
        }
        continue;
      }
      if ((next?.kind === 'string' || next?.kind === 'template') && isNoteAiModelSpecifier(next.value)) {
        totalAdapterSpecOccurrences += 1;
        violations.add('imports note-ai-model inside index.ts instead of direct re-export');
        flaggedAdapter = true;
        continue;
      }
      let p = i + 1;
      while (p < tokens.length) {
        const cur = tokens[p]!;
        if (cur.kind === 'punct') {
          if (cur.value === '{') {
            const close = delims.brace[p] ?? -1;
            if (close < 0) break;
            p = close + 1;
            continue;
          }
          if (cur.value === ';' || cur.value === '=>') break;
        } else if (cur.kind === 'ident') {
          if (isFromKeywordAt(tokens, p)) {
            const specTok = tokens[p + 1];
            if (specTok && (specTok.kind === 'string' || specTok.kind === 'template') && isNoteAiModelSpecifier(specTok.value)) {
              totalAdapterSpecOccurrences += 1;
              violations.add('imports note-ai-model inside index.ts instead of direct re-export');
              flaggedAdapter = true;
            }
            break;
          }
          if (cur.value === 'import' || cur.value === 'export') break;
        }
        p += 1;
      }
      continue;
    }

    if (t.value === 'export') {
      let p = i + 1;
      const isType = tokens[p]?.kind === 'ident' && tokens[p]?.value === 'type';
      if (isType) p += 1;
      if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '*') {
        p += 1;
        let hasAlias = false;
        let aliasName = '';
        if (tokens[p]?.kind === 'ident' && tokens[p]?.value === 'as') {
          hasAlias = true;
          aliasName = tokens[p + 1]?.value ?? '';
          p += 2;
        }
        if (isFromKeywordAt(tokens, p)) {
          const specTok = tokens[p + 1];
          if (specTok && (specTok.kind === 'string' || specTok.kind === 'template') && isNoteAiModelSpecifier(specTok.value)) {
            totalAdapterSpecOccurrences += 1;
            if (hasAlias) {
              violations.add(`re-exports note-ai-model under an alias (* as ${aliasName})`);
              flaggedAdapter = true;
            } else {
              directValidReexports += 1;
            }
          }
        }
        continue;
      }
      if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '{') {
        const openBrace = p;
        const closeBrace = delims.brace[p] ?? -1;
        if (closeBrace < 0) continue;
        const innerItems = tokens.slice(p + 1, closeBrace);
        p = closeBrace + 1;
        if (isFromKeywordAt(tokens, p)) {
          const specTok = tokens[p + 1];
          if (specTok && (specTok.kind === 'string' || specTok.kind === 'template') && isNoteAiModelSpecifier(specTok.value)) {
            totalAdapterSpecOccurrences += 1;
            if (isDirectUnaliasedExportList(innerItems)) {
              directValidReexports += 1;
              validNamedReexportSpans.push({ openBrace, closeBrace });
            } else {
              const snippet = indexText.slice(tokens[i + 1]!.start, tokens[closeBrace]!.end).replace(/\s+/g, ' ').trim();
              violations.add(`re-exports note-ai-model under an alias (${snippet})`);
              flaggedAdapter = true;
            }
          }
        } else {
          // Local export { sym ... } (no `from`): flag any adapter symbol
          let itemIdx = 0;
          while (itemIdx < innerItems.length) {
            if (innerItems[itemIdx]?.kind === 'ident' && innerItems[itemIdx]?.value === 'type') itemIdx += 1;
            const symTok = innerItems[itemIdx];
            if (symTok && (symTok.kind === 'ident' || symTok.kind === 'string') && symbolSet.has(symTok.value)) {
              violations.add(`indirectly re-exports ${symTok.value} from index.ts`);
            }
            while (itemIdx < innerItems.length && !(innerItems[itemIdx]?.kind === 'punct' && innerItems[itemIdx]?.value === ',')) {
              itemIdx += 1;
            }
            itemIdx += 1;
          }
        }
      }
      continue;
    }

    if (t.value === 'require' && tokens[i + 1]?.kind === 'punct' && tokens[i + 1]?.value === '(') {
      const call = scanBalancedParenArg(tokens, i + 1, delims.paren);
      const resolved = call.singleStringSpec ?? call.foldedStringSpec;
      if (resolved !== null && isNoteAiModelSpecifier(resolved)) {
        totalAdapterSpecOccurrences += 1;
        violations.add('imports note-ai-model inside index.ts instead of direct re-export');
        flaggedAdapter = true;
      }
    }
  }

  const mainAdapterSpecs = mainSpecifiers(indexText)
    .map((s) => decodeRawStringContent(s) ?? s)
    .filter((spec) => isNoteAiModelSpecifier(spec)).length;
  if (!flaggedAdapter && Math.max(totalAdapterSpecOccurrences, mainAdapterSpecs) > directValidReexports) {
    violations.add('imports note-ai-model inside index.ts instead of direct re-export');
  }

  const out = [...violations];
  if (out.length === 0) {
    let checkText = indexText;
    let checkTokens = tokens;
    if (validNamedReexportSpans.length > 0) {
      const skipTokenIndices = new Set<number>();
      const blankRanges: Array<{ start: number; end: number }> = [];
      for (const span of validNamedReexportSpans) {
        for (let k = span.openBrace + 1; k < span.closeBrace; k += 1) {
          skipTokenIndices.add(k);
        }
        const firstInner = tokens[span.openBrace + 1];
        const lastInner = tokens[span.closeBrace - 1];
        if (firstInner && lastInner) {
          blankRanges.push({ start: firstInner.start, end: lastInner.end });
        }
      }
      checkTokens = tokens.filter((_tok, idx) => !skipTokenIndices.has(idx));
      if (blankRanges.length > 0) {
        const parts: string[] = [];
        let cursor = 0;
        for (const r of blankRanges) {
          if (r.start > cursor) parts.push(indexText.slice(cursor, r.start));
          parts.push(' '.repeat(r.end - r.start));
          cursor = r.end;
        }
        if (cursor < indexText.length) parts.push(indexText.slice(cursor));
        checkText = parts.join('');
      }
    }
    for (const sym of adapterSymbolReferences(symbols, checkText, checkTokens)) {
      out.push(`references ${sym} inside index.ts instead of direct re-export`);
    }
  }
  return out;
}

export function indexReexportViolations(indexText: string, symbols: readonly string[]): string[] {
  const primary = scanSource(indexText, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  const out = new Set(collectIndexViolationsFromTokens(indexText, primary.tokens, symbols, true));
  const extraTokens = speculativeRescan(indexText, primary);
  if (extraTokens !== null) {
    for (const v of collectIndexViolationsFromTokens(indexText, extraTokens, symbols, false)) {
      out.add(v);
    }
  }
  return [...out];
}

const isAgentBarrel = (spec: string, fromRelPath?: string): boolean => {
  const normalizedSpec = normalizeModuleSpecifier(spec).replace(/\.[cm]?js$|\.[cm]ts$/, '.ts');
  if (
    normalizedSpec === '@crove/agent' ||
    normalizedSpec === '@crove/agent/index.ts' ||
    normalizedSpec === '@crove/agent/src/index.ts' ||
    normalizedSpec === '@crove/agent/src/index' ||
    normalizedSpec === 'packages/agent/src/index.ts' ||
    normalizedSpec === 'packages/agent/src/index'
  ) {
    return true;
  }
  if (/(?:^|\/)packages\/agent\/src\/index(?:\.ts)?$/.test(normalizedSpec)) return true;
  if (normalizedSpec.startsWith('.') && fromRelPath) {
    const baseDir = posix.dirname(fromRelPath.replace(/\\/g, '/'));
    const resolved = posix.normalize(posix.join(baseDir, normalizedSpec));
    if (resolved === 'packages/agent/src/index.ts' || resolved === 'packages/agent/src/index') return true;
  }
  return false;
};

const isAllowedWorkspaceComputedImport = (
  fromRelPath: string | undefined,
  call: { fn: 'import' | 'require'; specifier: string | null; argSnippet: string },
): boolean =>
  fromRelPath === 'apps/extension/e2e/extension.spec.ts' &&
  call.fn === 'import' &&
  call.argSnippet === '`${base}capture-run.js`';

function scanWorkspaceMode(fileText: string, jsx: boolean): { primary: Token[]; speculative: Token[][] } {
  const firstPass = scanSource(fileText, {
    emitTokens: true,
    stripCommentsMode: false,
    stripStrings: false,
    ...(jsx ? { jsx: true } : {}),
  });
  const tokens = firstPass.tokens;
  // Preserve unambiguous regexes (e.g., /import(foo)/); only re-scan JSX-ambiguous or unclosed regex regions.
  const ambiguousStarts = new Set<number>();
  let needsJsxFallback = false;
  for (let idx = 0; idx < tokens.length; idx += 1) {
    const tok = tokens[idx]!;
    if (tok.kind === 'invalid' && tok.value === 'unclosed regex literal') {
      ambiguousStarts.add(tok.start);
      needsJsxFallback = true;
    } else if (jsx && tok.kind === 'regex') {
      const prevTok = tokens[idx - 1];
      if (
        prevTok?.kind === 'punct' &&
        (prevTok.value === '>' || (prevTok.value === '}' && tok.raw.startsWith('/>')))
      ) {
        needsJsxFallback = true;
      }
    }
  }
  const fallback = needsJsxFallback
    ? scanSource(fileText, {
        emitTokens: true,
        stripCommentsMode: false,
        stripStrings: false,
        skipAmbiguousJsxRegex: true,
        skipRegexStarts: ambiguousStarts,
        ...(jsx ? { jsx: true } : {}),
      })
    : null;
  const primary = fallback ? fallback.tokens : tokens;
  const speculative: Token[][] = [];
  if (fallback && !tokens.some((t) => t.kind === 'invalid')) {
    speculative.push(tokens);
  }
  const firstSpec = speculativeRescan(fileText, firstPass, jsx);
  if (firstSpec) speculative.push(firstSpec);
  if (fallback) {
    const fallbackSpec = speculativeRescan(fileText, fallback, jsx);
    if (fallbackSpec) speculative.push(fallbackSpec);
  }
  return { primary, speculative };
}

function collectWorkspacePass(
  fileText: string,
  toks: readonly Token[],
  symbolSet: ReadonlySet<string>,
  fromRelPath: string | undefined,
  assertSyntax: boolean,
  out: Set<string>,
): void {
  const { specifiers: specs, scan } = specifiers(fileText, toks);
  if (assertSyntax && scan.hasInvalidSyntax) out.add('contains invalid or unclosed syntax');
  if (specs.some((spec) => isNoteAiModelSpecifier(spec))) {
    out.add('imports note-ai-model');
  }
  for (const decl of scan.importDecls) {
    if (!isAgentBarrel(decl.specifier, fromRelPath)) continue;
    if (decl.isNamespace) out.add('namespace import from @crove/agent');
    if (decl.isDefault) out.add('default import from @crove/agent');
  }
  for (const decl of scan.exportDecls) {
    if (isAgentBarrel(decl.specifier, fromRelPath) && decl.isStar) out.add('export * from @crove/agent');
  }
  for (const call of scan.dynamicCalls) {
    if (call.specifier !== null) {
      if (isAgentBarrel(call.specifier, fromRelPath)) out.add(`dynamic ${call.fn} from @crove/agent`);
    } else if (!isAllowedWorkspaceComputedImport(fromRelPath, call)) {
      out.add('uses computed dynamic import or require');
    }
  }
  collectSymbolTokenMatches(toks, symbolSet, out);
}

export function workspaceAdapterLeakViolations(
  fileText: string,
  symbols: readonly string[],
  fromRelPath?: string,
): string[] {
  const isKnownJsxPath = Boolean(fromRelPath && /\.[jt]sx$/i.test(fromRelPath));
  const isKnownNonJsxPath = Boolean(fromRelPath && /\.(?:[cm]?ts|[cm]?js)$/i.test(fromRelPath));
  const primaryLists: Token[][] = [];
  const speculativeLists: Token[][] = [];

  if (isKnownJsxPath) {
    const res = scanWorkspaceMode(fileText, true);
    primaryLists.push(res.primary);
    speculativeLists.push(...res.speculative);
  } else if (isKnownNonJsxPath) {
    const res = scanWorkspaceMode(fileText, false);
    primaryLists.push(res.primary);
    speculativeLists.push(...res.speculative);
  } else {
    const nonJsx = scanWorkspaceMode(fileText, false);
    const jsx = scanWorkspaceMode(fileText, true);
    const nonJsxInvalid = nonJsx.primary.some((t) => t.kind === 'invalid');
    const jsxInvalid = jsx.primary.some((t) => t.kind === 'invalid');
    if (!nonJsxInvalid) primaryLists.push(nonJsx.primary);
    if (!jsxInvalid) primaryLists.push(jsx.primary);
    if (nonJsxInvalid && jsxInvalid) primaryLists.push(nonJsx.primary, jsx.primary);
    speculativeLists.push(...nonJsx.speculative, ...jsx.speculative);
  }

  const symbolSet = new Set(symbols);
  const out = new Set<string>();
  for (const toks of primaryLists) {
    collectWorkspacePass(fileText, toks, symbolSet, fromRelPath, true, out);
  }
  for (const toks of speculativeLists) {
    collectWorkspacePass(fileText, toks, symbolSet, fromRelPath, false, out);
  }
  return [...out];
}

describe('member-Vy feature modules are pure (ADR-0049, stage A write boundary)', () => {
  it('flags what a pure feature must not do (the scanner is not vacuous)', () => {
    expect(memberVyViolations(`import { Runtime } from '@crove/kernel-runtime';`)).toEqual(['imports @crove/kernel-runtime']);
    expect(memberVyViolations(`import { generateText } from 'ai';\nimport z from 'zod';`)).toEqual(['imports ai']);
    expect(memberVyViolations(`import mem from 'mem0ai';`)).toEqual(['imports mem0ai']);
    expect(memberVyViolations(`import { 'Runtime' as R } from '@crove/kernel-runtime';`)).toEqual([
      'imports @crove/kernel-runtime',
    ]);
    expect(memberVyViolations(`import { 'a(b' as x } from 'pg';`)).toEqual(['imports pg']);
    expect(memberVyViolations(`import café from 'pg';`)).toEqual(['imports pg']);
    expect(memberVyViolations(`import * as π from 'pg';`)).toEqual(['imports pg']);
    expect(memberVyViolations(`void /[/*]/;\nimport pg from 'pg';\n// */`)).toEqual(['imports pg']);
    expect(memberVyViolations("import { createOpenAICompatible } from '@ai-sdk/\\\nopenai-compatible';")).toContain(
      'imports @ai-sdk/openai-compatible',
    );
    expect(memberVyViolations("import { db } from '@crove/\\\ndb';")).toContain('imports @crove/db');
    expect(memberVyViolations("const db = require('@crove/db/\\\nclient');")).toContain('imports @crove/db/client');
    expect(memberVyViolations("const mod = await import('@crove/' + 'db');")).toContain(
      'uses computed dynamic import or require',
    );
    expect(memberVyViolations("const mod = require('./' + x);")).toContain('uses computed dynamic import or require');
    expect(memberVyViolations(`const c = 'notes.todo.create';`)).toEqual(['names the command or path notes.todo.create']);
    expect(memberVyViolations('await runtime.execute(cmd, input, ctx);')).toEqual(['calls execute()']);
    expect(memberVyViolations(`const t = 'crove_kernel.member_vy_result';`)).toContain('names a crove_ table');
    expect(memberVyViolations('const q = `\nINSERT INTO crove_kernel.member_vy_memory\n`;')).toContain('names a crove_ table');
    expect(memberVyViolations('const { execute } = rt; await execute(c);')).toContain('calls execute()');
    expect(memberVyViolations(`await fetch('https://x.test');`)).toEqual(['calls the network directly']);
    expect(memberVyViolations(`import https from 'node:https';`)).toEqual(['imports node:https']);
    // What is allowed: zod, a relative module, a two-segment feature key, plain text.
    expect(memberVyViolations(`import { z } from 'zod';\nimport { metered } from '../meter.ts';\nconst f = 'notes.summary';`)).toEqual([]);
    expect(orgFeatureViolations(`import { x } from './member-vy/summary.ts';`)).toEqual(['imports ./member-vy/summary.ts']);
    expect(orgFeatureViolations("import { x } from './member-vy/\\\nsummary.ts';")).toContain(
      'imports ./member-vy/summary.ts',
    );
    expect(orgFeatureViolations("const m = await import('./member-vy/' + name);")).toEqual([
      'uses computed dynamic import or require',
    ]);
    expect(orgFeatureViolations(`import type { PrivateText } from './private-text.ts';`)).toEqual(['imports ./private-text.ts', 'names PrivateText']);
    expect(orgFeatureViolations(`import type { PrivateText } from './private-text.mjs';`)).toEqual([
      'imports ./private-text.mjs',
      'names PrivateText',
    ]);
    expect(orgFeatureViolations(`void /[/*]/;\nimport type { PrivateText } from './private-text.ts';\n// */`)).toEqual([
      'imports ./private-text.ts',
      'names PrivateText',
    ]);
    expect(memberVyViolations(`import z from 'mem0ai/../zod';`)).toEqual(['imports mem0ai/../zod']);
    expect(memberVyViolations(`import z from '@ai-sdk/../zod';`)).toEqual(['imports @ai-sdk/../zod']);
    expect(memberVyViolations(`import x from '@crove/db/../../x';`)).toEqual(['imports @crove/db/../../x']);
    expect(memberVyViolations(`import x from 'langchain/..';`)).toEqual(['imports langchain/..']);
    expect(memberVyViolations(`require('@crove/kernel/../../../packages/kernel/src/index.ts')`)).toContain(
      'imports @crove/kernel/../../../packages/kernel/src/index.ts',
    );
    expect(memberVyViolations(`import x from '%6dem0ai/../zod';`)).toEqual(['imports mem0ai/../zod']);
    expect(memberVyViolations(`import p from 'pg";`)).toContain('imports pg');
    expect(orgFeatureViolations(`import { x } from './member-vy/../x.ts';`)).toEqual(['imports ./member-vy/../x.ts']);
    expect(orgFeatureViolations(`import { x } from './member-vy/%2e%2e/x.ts';`)).toEqual(['imports ./member-vy/../x.ts']);
    expect(orgFeatureViolations(`import { x } from './%6dember-vy/../x.ts';`)).toEqual(['imports ./member-vy/../x.ts']);
    expect(orgFeatureViolations(`import { x } from './member-vy/x.ts";`)).toContain('imports ./member-vy/x.ts');
    expect(orgFeatureViolations(`import { z } from 'zod';`)).toEqual([]);
  });

  it('keeps every module under packages/agent/src/member-vy pure', () => {
    const bad = sources(MEMBER_VY).flatMap((file) => memberVyViolations(readFileSync(file, 'utf8')).map((v) => `${relative(ROOT, file)}: ${v}`));
    expect(bad).toEqual([]);
  });

  it('keeps every org-level feature to plain strings: none imports a member-Vy module or the PrivateText brand', () => {
    const bad = sources(SRC)
      .filter((file) => !file.startsWith(`${MEMBER_VY}/`) && !file.endsWith('/private-text.ts'))
      .flatMap((file) => orgFeatureViolations(readFileSync(file, 'utf8')).map((v) => `${relative(ROOT, file)}: ${v}`));
    expect(bad).toEqual([]);
  });

  // Tripwires: the boundary cannot be dodged by putting the feature where the scan does not look.
  it('flags a member-Vy name or a notes feature key outside member-vy/ (the tripwire is not vacuous)', () => {
    expect(memberVyNames('const x: PrivateText = y;')).toEqual(['PrivateText']);
    expect(memberVyNames('const f = memberVy.run;')).toEqual(['memberVy']);
    expect(memberVyNames("const t = 'member_vy';")).toEqual(['member_vy']);
    expect(memberVyNames('const x: \\u0050rivateText = y;')).toEqual(['PrivateText']);
    expect(meteredNotes("await metered('notes.summary', () => call())")).toEqual(['notes.summary']);
    expect(meteredNotes('await metered (`notes.todo_suggest`, fn)')).toEqual(['notes.todo_suggest']);
    expect(meteredNotes("await metered<Out>('notes.summary', fn)")).toEqual(['notes.summary']);
    expect(meteredNotes("await metered<Map<string, Array<number>>>('notes.summary', fn)")).toEqual(['notes.summary']);
    expect(meteredNotes('await metered(`notes.${x}`, fn)')).toEqual(['notes.${x}']);
    expect(meteredNotes("await metered('notes.foo.bar', fn)")).toEqual(['notes.foo.bar']);
    expect(meteredNotes("await metered('conversation.draft', fn)")).toEqual([]);
    expect(meteredNotes("$metered('notes.summary', fn)")).toEqual(['notes.summary']);
    expect(meteredNotes("x.$metered('notes.summary', fn)")).toEqual(['notes.summary']);
    expect(meteredNotes(`metered('notes.summary", fn)`)).toContain('notes.summary');
    expect(disallowedMeteredNotes('meter.ts', "$metered('notes.summary', fn)")).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('meter.ts', "x.$metered('notes.summary', fn)")).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('meter.ts', `metered('notes.summary", fn)`)).toContain('notes.summary');
    expect(memberVyNames('const role = "member";')).toEqual([]);

    // meteredNotes + notesKeyLiterals + meter.ts exemption bounds (including template/multiline keys).
    expect(disallowedMeteredNotes('note-ai-model.ts', "await metered('notes.summary', () => generateText(cfg))")).toEqual([]);
    expect(disallowedMeteredNotes('note-ai-model.ts', 'await metered(`notes.todo_suggest`, () => generateText(cfg))')).toEqual([]);
    expect(disallowedMeteredNotes('note-ai-model.ts', "await metered('notes.todo_plan', () => generateText(cfg))")).toEqual([]);
    expect(disallowedMeteredNotes('note-ai-model.ts', "await metered('notes.organize', () => generateText(cfg))")).toEqual([]);
    expect(disallowedMeteredNotes('note-ai-model.ts', "await metered('notes.other', () => generateText(cfg))")).toEqual([
      'notes.other',
    ]);
    expect(disallowedMeteredNotes('note-ai-model.ts', 'const k = `notes.summary${x}`; m(k, fn)')).toEqual([
      'notes.summary${x}',
    ]);
    expect(disallowedMeteredNotes('note-ai-model.ts', 'const k = `notes.summary\nextra`; m(k, fn)')).toEqual([
      'notes.summary\nextra',
    ]);
    expect(
      disallowedMeteredNotes(
        'meter.ts',
        `export const AI_FEATURES = { 'notes.summary': 'notes', 'notes.todo_suggest': 'notes' } as const;`,
      ),
    ).toEqual([]);
    expect(disallowedMeteredNotes('meter.ts', "await metered('notes.summary', fn);")).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('meter.ts', `const x = { 'notes.other': 'notes' };`)).toEqual(['notes.other']);
    expect(disallowedMeteredNotes('meter.ts', `const x = { 'notes.summary-v2': 'notes' };`)).toEqual(['notes.summary-v2']);
    for (const file of ['index.ts', 'private-text.ts', 'summary-model.ts', 'other.ts', 'nested/note-ai-model.ts']) {
      expect(disallowedMeteredNotes(file, "await metered('notes.summary', fn); await metered('notes.todo_suggest', fn)")).toEqual([
        'notes.summary',
        'notes.todo_suggest',
      ]);
      expect(disallowedMeteredNotes(file, "await metered('notes.todo_plan', fn); await metered('notes.organize', fn)")).toEqual([
        'notes.todo_plan',
        'notes.organize',
      ]);
      expect(disallowedMeteredNotes(file, "const k = 'notes.summary'; m(k, fn); m('notes.todo_suggest', fn);")).toEqual([
        'notes.summary',
        'notes.todo_suggest',
      ]);
      expect(disallowedMeteredNotes(file, "await metered<Out>('notes.summary', fn);")).toEqual(['notes.summary']);
      expect(disallowedMeteredNotes(file, 'await metered(`notes.${x}`, fn);')).toEqual(['notes.${x}']);
      expect(disallowedMeteredNotes(file, "void /[/*]/;\nawait metered('notes.summary', fn);\n// */")).toEqual([
        'notes.summary',
      ]);
    }

    // Linear comment stripping preserving strings, templates, regexes.
    const maskSample = stripComments(`const s = "// keep /* inside string */";\n// broken /* in line comment\n/** block * comment */\nconst x = 1;tools//inline comment\n`);
    expect(maskSample).toContain('"// keep /* inside string */"');
    expect(maskSample).toContain('const x = 1;tools');
    expect(maskSample).not.toContain('block * comment');
    expect(maskSample).not.toContain('inline comment');

    // Structural allowlist for note-ai-model.ts (valid shapes pass, every evasion fails closed).
    const validAdapter = [
      `import { generateText } from 'ai';`,
      `import { chatModel, type AiConfig } from './index.ts';`,
      `import { metered } from './meter.ts';`,
      `export function generateNoteSummaryText(`,
      `  config: AiConfig,`,
      `  prompt: { system: string; user: string },`,
      `  abortSignal: AbortSignal,`,
      `): Promise<{ text: string; usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } }> {`,
      `  return metered('notes.summary', () =>`,
      `    generateText({`,
      `      model: chatModel(config),`,
      `      system: prompt.system,`,
      `      prompt: prompt.user,`,
      `      maxOutputTokens: 2000,`,
      `      maxRetries: 0,`,
      `      abortSignal,`,
      `    }),`,
      `  );`,
      `}`,
    ].join('\n');
    expect(modelAdapterViolations(validAdapter)).toEqual([]);

    const wrapAdapterBody = (optionsSnippet: string): string =>
      [
        `import { generateText } from 'ai';`,
        `import { chatModel, type AiConfig } from './index.ts';`,
        `import { metered } from './meter.ts';`,
        `export function run(config: AiConfig, prompt: { system: string; user: string }, opts: Record<string, unknown>) {`,
        `  return metered('notes.summary', () => generateText({ ${optionsSnippet} }));`,
        `}`,
      ].join('\n');

    // Platform PO probes (BL1, BL2, BL3) and fail-closed structural evasions:
    expect(
      modelAdapterViolations(wrapAdapterBody(`model: chatModel(config), system: prompt.system, prompt: prompt.user, maxOutputTokens: 2000, __proto__: opts`)),
    ).not.toEqual([]);
    expect(
      modelAdapterViolations(wrapAdapterBody(`model: chatModel(config), system: prompt.system, prompt: prompt.user, maxOutputTokens: 2000, "\\x74ools": opts`)),
    ).not.toEqual([]);
    expect(
      modelAdapterViolations(wrapAdapterBody(`model: chatModel(config), system: prompt.system, prompt: prompt.user, maxOutputTokens: 2000, get "tools"() { return {}; }`)),
    ).not.toEqual([]);
    expect(
      modelAdapterViolations(wrapAdapterBody(`model: chatModel(config), system: prompt.system, prompt: prompt.user, maxOutputTokens: 2000, tools: {}`)),
    ).toEqual(['uses model tools']);
    expect(
      modelAdapterViolations(wrapAdapterBody(`model: chatModel(config), system: prompt.system, prompt: prompt.user, maxOutputTokens: 2000, ...opts`)),
    ).not.toEqual([]);
    expect(
      modelAdapterViolations(wrapAdapterBody(`model: chatModel(config), system: prompt.system, prompt: prompt.user, maxOutputTokens: 2000, ['tools']: opts`)),
    ).not.toEqual([]);
    expect(
      modelAdapterViolations(wrapAdapterBody(`model: chatModel(config), system: prompt.system, prompt: prompt.user`)),
    ).toEqual(['missing required generateText option maxOutputTokens']);
    expect(
      modelAdapterViolations(`import { chatModel, extraHelper } from './index.ts';\n${validAdapter}`),
    ).toContain('imports disallowed symbol from ./index.ts');
    expect(
      modelAdapterViolations(`import { createOpenAICompatible } from '@ai-sdk/\\\nopenai-compatible';\n${validAdapter}`),
    ).toContain('imports @ai-sdk/openai-compatible');
    expect(
      modelAdapterViolations(`import { db } from '@crove/\\\ndb';\n${validAdapter}`),
    ).toContain('imports @crove/db');
    expect(
      modelAdapterViolations(`import { Output } from 'ai';\n${validAdapter}`),
    ).toContain('imports disallowed symbol from ai');
    expect(modelAdapterViolations(`import * as ai from 'ai';\nconst x = ai;`)).not.toEqual([]);
    expect(modelAdapterViolations(`import ai from 'ai';\nconst x = ai;`)).not.toEqual([]);
    expect(modelAdapterViolations(`const f = fetch; process['env']; rt['exe'+'cute']('ads.campaign.publish');`)).not.toEqual([]);
    expect(modelAdapterViolations(`const system = 'Use no tools, just return plain text.';`)).not.toEqual([]);
    expect(modelAdapterViolations(`export const helper = 1;`)).not.toEqual([]);
    expect(modelAdapterViolations(`export * from './meter.ts';`)).not.toEqual([]);
    expect(modelAdapterViolations(`export default async function () {}`)).not.toEqual([]);
    expect(modelAdapterViolations(`await import('node:fs');`)).toContain('uses dynamic import or require');
    expect(modelAdapterViolations(`const r = require('./db.ts');`)).toContain('uses dynamic import or require');
    expect(modelAdapterViolations('')).toEqual(['requires at least one exported function declaration']);
    expect(
      modelAdapterViolations(
        `import { generateText } from 'ai';\nimport { chatModel, type AiConfig } from './index.ts';\nimport { metered } from './meter.ts';\nexport function run(config: typeof import('@crove/db'), prompt: { system: string; user: string }) { return metered('notes.summary', () => generateText({ model: chatModel(config), system: prompt.system, prompt: prompt.user, maxOutputTokens: 2000 })); }`,
      ),
    ).not.toEqual([]);

    // Direct re-export & export symbol scanning
    expect(importsNoteAiModel(`import { z } from 'zod'; import { fn } from './note-ai-model.js';`)).toBe(true);
    expect(importsNoteAiModel(`import{fn}from'./note-ai-model.js';`)).toBe(true);
    expect(importsNoteAiModel(`import './note-ai-model.ts';`)).toBe(true);
    expect(importsNoteAiModel('await import(`./note-ai-model.ts`);')).toBe(true);
    expect(importsNoteAiModel("import { fn } from './note-ai-\\\nmodel.ts';")).toBe(true);
    const sampleAdapter = [
      `export const NOTE_AI_TIMEOUT_MS = 45_000, $helper = () => 1;`,
      `export async function generateNoteSummaryText() {}`,
      `export async function* streamHelper() {}`,
    ].join('\n');
    const sampleSyms = adapterExports(sampleAdapter);
    expect(sampleSyms).toEqual(['NOTE_AI_TIMEOUT_MS', '$helper', 'generateNoteSummaryText', 'streamHelper']);
    expect(
      adapterSymbolReferences(sampleSyms, `import { generateNoteSummaryText, $helper } from './index.ts'; $helper();`),
    ).toEqual(['$helper', 'generateNoteSummaryText']);
    expect(adapterSymbolReferences(sampleSyms, `// generateNoteSummaryText in comment only`)).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(adapterSymbolReferences(sampleSyms, `if (1) /[/*]/;\ngenerateNoteSummaryText();\n// */`)).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(
      adapterExports(`export const pattern = /;/, hidden = () => 1;`),
    ).toEqual(['pattern', 'hidden']);
    expect(
      adapterExports(`export const defaults: Record<string, string> = {}, extra = 1; export function noteText() {}`),
    ).toEqual(['defaults', 'extra', 'noteText']);
    expect(
      adapterExports(`export const NOTE_AI_TIMEOUT_MS = 40_000 +\n 5_000, hidden = async () => null;`),
    ).toEqual(['NOTE_AI_TIMEOUT_MS', 'hidden']);
    expect(
      adapterExports(`export const NOTE_AI_TIMEOUT_MS = 40_000\n// comment\n+ 5_000, hidden2 = 1;`),
    ).toEqual(['NOTE_AI_TIMEOUT_MS', 'hidden2']);
    expect(adapterExports(`if (1) /[/*]/;\nexport async function hiddenAdapter() {}\n// */`)).toContain(
      'hiddenAdapter',
    );
    expect(
      indexReexportViolations(`if (1) /[/*]/;\nexport { generateNoteSummaryText as evil };\n// */`, sampleSyms),
    ).toEqual(['indirectly re-exports generateNoteSummaryText from index.ts']);
    expect(
      indexReexportViolations(
        `export async function orgSummary() { const m = await import('./note-ai-model.ts'); return m.generateNoteSummaryText(); }`,
        sampleSyms,
      ),
    ).toEqual(['imports note-ai-model inside index.ts instead of direct re-export']);
    expect(
      indexReexportViolations(
        `export * from './note-ai-model.ts'; import { generateNoteSummaryText } from './index.ts'; export async function orgSummary() { return generateNoteSummaryText(); }`,
        sampleSyms,
      ),
    ).toEqual(['imports self inside index.ts instead of direct re-export']);
    expect(indexReexportViolations(`export * from './note-ai-model.ts';`, sampleSyms)).toEqual([]);
    expect(indexReexportViolations(`export type * from './note-ai-model.ts';`, sampleSyms)).toEqual([]);
    expect(indexReexportViolations(`export { generateNoteSummaryText } from './note-ai-model.ts';`, sampleSyms)).toEqual([]);
    expect(
      indexReexportViolations(
        `export { generateNoteSummaryText } from './note-ai-model.ts'; const copy = generateNoteSummaryText;`,
        sampleSyms,
      ),
    ).toEqual(['references generateNoteSummaryText inside index.ts instead of direct re-export']);
    expect(
      indexReexportViolations(`export { generateNoteSummaryText as orgSummary } from './note-ai-model.ts';`, sampleSyms),
    ).toEqual(['re-exports note-ai-model under an alias ({ generateNoteSummaryText as orgSummary })']);
    expect(indexReexportViolations(`export * as nm from './note-ai-model.ts';`, sampleSyms)).toEqual([
      're-exports note-ai-model under an alias (* as nm)',
    ]);
    expect(
      indexReexportViolations(
        `import { generateNoteSummaryText } from './note-ai-model.ts'; export { generateNoteSummaryText as s };`,
        sampleSyms,
      ),
    ).toEqual([
      'imports note-ai-model inside index.ts instead of direct re-export',
      'indirectly re-exports generateNoteSummaryText from index.ts',
    ]);

    // Workspace leak detection (covers aliases, escapes, string concatenation, namespace/default imports, dynamic import/require)
    expect(workspaceAdapterLeakViolations(`import { generateNoteSummaryText as g } from '@crove/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(workspaceAdapterLeakViolations(`import { "generateNote\\x53ummaryText" as g } from '@crove/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(workspaceAdapterLeakViolations(`import { generateNote\\u0053ummaryText as g } from '@crove/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(workspaceAdapterLeakViolations(`const fn = agent['generateNote' + 'SummaryText'];`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(workspaceAdapterLeakViolations(`import * as agent from '@crove/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'namespace import from @crove/agent',
    ]);
    expect(workspaceAdapterLeakViolations(`import agent from '@crove/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'default import from @crove/agent',
    ]);
    expect(workspaceAdapterLeakViolations(`export * from '@crove/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'export * from @crove/agent',
    ]);
    expect(workspaceAdapterLeakViolations(`const a = await import('@crove/agent');`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'dynamic import from @crove/agent',
    ]);
    expect(workspaceAdapterLeakViolations(`const a = await import('@crove/' + 'agent');`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'dynamic import from @crove/agent',
    ]);
    expect(workspaceAdapterLeakViolations(`const a = require('@crove/agent');`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'dynamic require from @crove/agent',
    ]);
    expect(
      workspaceAdapterLeakViolations(`export * as notesAI from '../../../packages/agent/src/index.ts';`, DEFAULT_ADAPTER_EXPORTS),
    ).toEqual(['export * from @crove/agent']);
    expect(
      workspaceAdapterLeakViolations(
        `import * as notesAI from '../index.ts';`,
        DEFAULT_ADAPTER_EXPORTS,
        'packages/agent/src/member-vy/note-ai.ts',
      ),
    ).toEqual(['namespace import from @crove/agent']);
    expect(
      workspaceAdapterLeakViolations(
        `const mod = await import('../../../../packages/agent/src/index.ts');`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toEqual(['dynamic import from @crove/agent']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div></div>; import { generateNoteSummaryText as summarize } from '@crove/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <Comp a={1}/>; const D = () => <Other b={2}/>; import { generateNoteSummaryText } from '@crove/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        "const entry = '@crove/agent'; const a = await import(entry); const fn = a[`generateNote${'SummaryText'}`];",
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        `const mod = await import(entry);`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/extension/e2e/extension.spec.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        'const mod = await import(`${base}capture-run.js`);',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/extension/e2e/extension.spec.ts',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <Comp a={1}/>; import { AiBudgetExhaustedError } from '@crove/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual([]);
    expect(workspaceAdapterLeakViolations(`const r = /import(foo)/;`, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const r = /import(foo)/; const C = () => <Comp a={1}/>;`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const r = /import(foo)/; const C = () => <Comp a={1}/>; import { generateNoteSummaryText } from '@crove/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <Comp>/{generateNoteSummaryText()}/</Comp>;`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div>don't</div>; import { generateNoteSummaryText } from "@crove/agent";`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div>don't</div>; import { generateNoteSummaryText } from "@crove/agent";`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/components/example.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div>don't <span>can't</span></div>; import { generateNoteSummaryText } from '@crove/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/components/example.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div>don't <span>can't</span></div>;`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/components/example.tsx',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div>don't</div>;`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div title="Line 1\nLine 2" />;`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/components/example.tsx',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div title="\\u is literal in JSX" />;`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/components/example.tsx',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div title="Line 1\nLine 2">don't</div>; import { generateNoteSummaryText } from '@crove/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/components/example.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const f = <T>(x: T) => x; import { generateNoteSummaryText } from '@crove/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const bad = 'unclosed; import { generateNoteSummaryText } from '@crove/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toContain('contains invalid or unclosed syntax');
    expect(
      workspaceAdapterLeakViolations(
        `const x = foo + 'generateNote' + 'SummaryText';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `import * as m from '../../../packages/agent/src/note-ai-model.ts#x'; export const f = Object.values(m);`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.mjs',
      ),
    ).toEqual(['imports note-ai-model']);
    expect(
      workspaceAdapterLeakViolations(
        `import * as m from '../sub/../note-ai-%6dodel.ts?v=1#frag';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['imports note-ai-model']);
    expect(
      workspaceAdapterLeakViolations(
        `import * as m from 'file:///repo/packages/agent/src/note-ai-model.ts#x';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['imports note-ai-model']);
    expect(
      workspaceAdapterLeakViolations(
        `import * as a from '../../../packages/agent/src/index.ts#x';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['namespace import from @crove/agent']);
    expect(
      indexReexportViolations(
        `export { generateNoteSummaryText as g } from './note-ai-model.ts#x';`,
        sampleSyms,
      ),
    ).toEqual(['re-exports note-ai-model under an alias ({ generateNoteSummaryText as g })']);
    expect(
      indexReexportViolations(
        `export * from './note-ai-model.ts'; import * as a from './index.ts?v=1#x';`,
        sampleSyms,
      ),
    ).toContain('imports self inside index.ts instead of direct re-export');
    expect(memberVyViolations(`import { generateText } from 'ai#x';`)).toEqual(['imports ai']);
    expect(orgFeatureViolations(`import { x } from './member-vy/summary.ts?v=1#x';`)).toEqual([
      'imports ./member-vy/summary.ts',
    ]);
    // F1: malformed UTF-8 + `..` collapse before percent-decoding + .mts/.cts + file:// index.ts
    expect(
      workspaceAdapterLeakViolations(
        `import * as m from './%E0%A4%A/../note-ai-%6dodel.ts'; export const f = Object.values(m);`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.mjs',
      ),
    ).toEqual(['imports note-ai-model']);
    expect(
      workspaceAdapterLeakViolations(
        `import * as m from 'file:///repo/packages/agent/src/index.ts';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['namespace import from @crove/agent']);
    expect(
      workspaceAdapterLeakViolations(
        `import * as m from '../../../packages/agent/src/index.mts';`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toEqual(['namespace import from @crove/agent']);
    expect(
      indexReexportViolations(`export { generateNoteSummaryText as g } from './%E0%A4%A/../note-ai-%6dodel.ts';`, sampleSyms),
    ).toEqual(['re-exports note-ai-model under an alias ({ generateNoteSummaryText as g })']);
    // F2: contextual keyword `from` as binding identifier
    expect(memberVyViolations(`const x = 1; import from from 'pg';`)).toEqual(['imports pg']);
    expect(workspaceAdapterLeakViolations(`import from from '@crove/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'default import from @crove/agent',
    ]);
    expect(
      workspaceAdapterLeakViolations(`import type from from '@crove/agent';`, DEFAULT_ADAPTER_EXPORTS),
    ).toEqual(['default import from @crove/agent']);
    expect(indexReexportViolations(`import from from './note-ai-model.ts';`, sampleSyms)).toEqual([
      'imports note-ai-model inside index.ts instead of direct re-export',
    ]);
    // F3: ASI regex-prefix keywords and speculative division/regex rescan
    expect(memberVyViolations(`debugger\n/[/*]/;\nimport { Runtime } from '@crove/kernel-runtime';\n// */`)).toEqual([
      'imports @crove/kernel-runtime',
    ]);
    expect(memberVyViolations(`break\n/[/*]/;\nfetch('https://x.test');\n// */`)).toEqual(['calls the network directly']);
    expect(memberVyViolations(`continue\n/[/*]/;\nawait execute(c);\n// */`)).toEqual(['calls execute()']);
    expect(
      memberVyViolations(`type T = number\n/[/*]/;\nimport { Runtime } from '@crove/kernel-runtime';\n// */`),
    ).toEqual(['imports @crove/kernel-runtime']);
    expect(
      memberVyViolations(`const w = n as number & { a: number } / 2 + "/g/*";\nimport { Runtime } from '@crove/kernel-runtime';\n// */`),
    ).toEqual(['imports @crove/kernel-runtime']);
    expect(
      orgFeatureViolations(`type T = number\n/[/*]/;\nimport { x } from './member-vy/summary.ts';\n// */`),
    ).toEqual(['imports ./member-vy/summary.ts']);
    expect(
      workspaceAdapterLeakViolations(
        `type T = number\n/[/*]/;\nimport { generateNoteSummaryText } from '@crove/agent';\n// */`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const w = n as number & { a: number } / 2 + "/g/*";\nimport { generateNoteSummaryText } from '@crove/agent';\n// */`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const ratio = n / 2; // safe trailing comment`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toEqual([]);
    expect(
      indexReexportViolations(
        `export * from './note-ai-model.ts';\ntype T = number\n/[/*]/;\nimport { generateNoteSummaryText } from './note-ai-model.ts';\n// */`,
        sampleSyms,
      ),
    ).toContain('imports note-ai-model inside index.ts instead of direct re-export');
    expect(
      indexReexportViolations(`export * from './note-ai-model.ts';\nconst ratio = n / 2; // safe comment`, sampleSyms),
    ).toEqual([]);
    const f3JsxFallbackProbe =
      'type G<T> = Array<T>\n/[/*]/;\nimport * as agent from "@crove/\\\nagent";\nexport const leaked = agent["generateNote" + "SummaryText"];\n// */';
    expect(
      workspaceAdapterLeakViolations(f3JsxFallbackProbe, ['generateNoteSummaryText'], 'apps/kernel/src/other.ts'),
    ).not.toEqual([]);
    expect(
      workspaceAdapterLeakViolations(f3JsxFallbackProbe, ['generateNoteSummaryText'], 'apps/app/src/other.tsx'),
    ).not.toEqual([]);
    expect(workspaceAdapterLeakViolations(f3JsxFallbackProbe, ['generateNoteSummaryText'])).not.toEqual([]);
    expect(workspaceAdapterLeakViolations('const el = <div/> / 2;', ['generateNoteSummaryText'], 'apps/app/src/other.tsx')).toEqual([]);
    expect(workspaceAdapterLeakViolations('const el = <div/> / 2;', ['generateNoteSummaryText'])).toEqual([]);
    expect(workspaceAdapterLeakViolations('const el = <div>a</div> / 2; // safe comment', ['generateNoteSummaryText'], 'apps/app/src/other.tsx')).toEqual([]);
    expect(workspaceAdapterLeakViolations('const el = <div>a</div> / 2; // safe comment', ['generateNoteSummaryText'])).toEqual([]);
    expect(workspaceAdapterLeakViolations(`import { AiBudgetExhaustedError } from '@crove/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);

    expect(
      modelAdapterViolations(
        wrapAdapterBody(`model: chatModel(config), system: prompt.system, prompt: prompt.user, maxOutputTokens: 2000, \\u0074ools: {}`),
      ),
    ).not.toEqual([]);
    expect(
      modelAdapterViolations(`${validAdapter.replace(');', ').then((x) => x);')}`),
    ).not.toEqual([]);

    expect(
      modelAdapterViolations(`${validAdapter} fetch('https://x.test');`),
    ).toContain('missing statement separator after exported function');
    for (const sep of ['\r', '\n', '\u2028', '\u2029']) {
      expect(
        modelAdapterViolations(`${validAdapter}\n// comment${sep}fetch('https://x.test');`),
      ).toContain('uses disallowed top-level statement');
      expect(
        memberVyViolations(`// comment${sep}fetch('https://x.test');`),
      ).toEqual(['calls the network directly']);
      expect(stripComments(`// comment${sep}fetch('https://x.test');`)).toContain(`fetch('https://x.test');`);
    }
    expect(
      indexReexportViolations(
        `export * from './note-ai-model.ts'; export async function orgSummary() { return import('./' + 'note-ai-model.ts'); }`,
        sampleSyms,
      ),
    ).toContain('imports note-ai-model inside index.ts instead of direct re-export');
    expect(
      indexReexportViolations(
        `export * from './note-ai-model.ts'; export async function orgSummary() { return import(\`./note-ai-\${name}\`); }`,
        sampleSyms,
      ),
    ).toContain('uses computed dynamic import or require inside index.ts');
    expect(
      indexReexportViolations(
        `export * from './note-ai-model.ts'; import * as a from './index.ts'; export const wrap = () => Reflect.get(a, 'generateNote' + 'SummaryText');`,
        sampleSyms,
      ),
    ).toContain('imports self inside index.ts instead of direct re-export');
    expect(
      indexReexportViolations(
        `export * from './note-ai-model.ts'; export const wrap = (a: Record<string, unknown>) => Reflect.get(a, 'generateNote' + 'SummaryText');`,
        sampleSyms,
      ),
    ).toEqual(['references generateNoteSummaryText inside index.ts instead of direct re-export']);

    expect(memberVyViolations(`const ratio = n! / 2; const r2 = fn()! / 2;`)).toEqual([]);
    expect(orgFeatureViolations(`const ratio = n! / 2; const r2 = arr[0]! / 2;`)).toEqual([]);
    expect(memberVyViolations(`const ok = !/foo/.test(x);`)).toEqual([]);
    expect(memberVyViolations(`if (1) !/[/]/.test(x);`)).toEqual([]);

    // 500 KB linear-scaling tests (must finish well below 15_000 ms without quadratic backtracking)
    const halfMbDiv = 'a / '.repeat(125_000);
    const halfMbMetered = 'metered<'.repeat(62_500);
    const balancedMetered = `${'metered<'.repeat(30_000)}${'>'.repeat(30_000)}`;
    const nestedTemplateMetered = `${'metered(`notes.${'.repeat(24_000)}x${'}`)'.repeat(24_000)}`;
    const nestedImports = `${'import('.repeat(20_000)}x${')'.repeat(20_000)}`;
    const nestedImportBraces = 'import { '.repeat(20_000);
    const t0 = performance.now();
    expect(stripComments(halfMbDiv)).toHaveLength(halfMbDiv.length);
    expect(meteredNotes(halfMbDiv)).toEqual([]);
    expect(meteredNotes(halfMbMetered)).toEqual([]);
    expect(meteredNotes(balancedMetered)).toEqual([]);
    expect(meteredNotes(nestedTemplateMetered).some((k) => k.startsWith('notes.'))).toBe(true);
    expect(notesKeyLiterals(halfMbDiv)).toEqual([]);
    expect(notesKeyLiterals(nestedTemplateMetered).some((k) => k.startsWith('notes.'))).toBe(true);
    expect(specifiers(halfMbDiv).specifiers).toEqual([]);
    expect(specifiers(nestedImports).scan.hasComputedDynamic).toBe(true);
    expect(specifiers(nestedImportBraces).specifiers).toEqual([]);
    expect(modelAdapterViolations(halfMbDiv)).not.toEqual([]);
    expect(workspaceAdapterLeakViolations(halfMbDiv, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);
    expect(indexReexportViolations(halfMbDiv, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(15_000);
  }, 30_000);

  it('keeps the member-Vy names inside packages/agent/src/member-vy (and the three files that join it to the rest)', () => {
    const JOINTS = new Set(['meter.ts', 'index.ts', 'private-text.ts']);
    const relFromSrc = (file: string): string => relative(SRC, file).replace(/\\/g, '/');
    const srcFiles = sources(SRC);
    const fileTextCache = new Map<string, string>();
    const readText = (file: string): string => {
      let text = fileTextCache.get(file);
      if (text === undefined) {
        text = readFileSync(file, 'utf8');
        fileTextCache.set(file, text);
      }
      return text;
    };
    const outside = srcFiles.filter((file) => !file.startsWith(`${MEMBER_VY}/`));
    const names = outside
      .filter((file) => !JOINTS.has(relFromSrc(file)))
      .flatMap((file) => memberVyNames(readText(file)).map((n) => `${relative(ROOT, file)}: ${n}`));
    expect(names, 'a member-Vy feature or its private type outside member-vy/').toEqual([]);
    // The notes feature keys of N8 are metered only from member-vy/ or the Stage A ModelPort adapter (note-ai-model.ts).
    const keys = outside.flatMap((file) =>
      disallowedMeteredNotes(relFromSrc(file), readText(file)).map((n) => `${relative(ROOT, file)}: metered('${n}')`),
    );
    expect(keys, 'a notes feature (N8) metered outside member-vy/ or note-ai-model.ts').toEqual([]);
    // Every notes ModelPort adapter stays thin (allowed imports only, no tools, no DB/commands/direct fetch) and is exported only via index.ts.
    const adapterBad = [...MODEL_ADAPTERS]
      .map((rel) => join(SRC, rel))
      .filter((file) => existsSync(file))
      .flatMap((file) => modelAdapterViolations(readText(file)).map((v) => `${relative(ROOT, file)}: ${v}`));
    expect(adapterBad, 'notes ModelPort adapter violates thin-adapter rules').toEqual([]);
    const adapterImporters = srcFiles
      .filter((file) => relFromSrc(file) !== 'index.ts' && relFromSrc(file) !== 'note-ai-model.ts')
      .filter((file) => importsNoteAiModel(readText(file)))
      .map((file) => relative(ROOT, file));
    expect(adapterImporters, 'only packages/agent/src/index.ts may import note-ai-model').toEqual([]);

    const adapterPath = join(SRC, 'note-ai-model.ts');
    const adapterDeclaredExports = existsSync(adapterPath) ? adapterExports(readText(adapterPath)) : [];
    if (existsSync(adapterPath)) {
      expect(adapterDeclaredExports.length, 'note-ai-model.ts must export its runtime helpers directly').toBeGreaterThan(0);
    }
    const seededExports = [...new Set([...DEFAULT_ADAPTER_EXPORTS, ...adapterDeclaredExports])];

    const indexPath = join(SRC, 'index.ts');
    if (existsSync(indexPath)) {
      expect(
        indexReexportViolations(readText(indexPath), seededExports),
        'packages/agent/src/index.ts must only export note-ai-model directly without aliases',
      ).toEqual([]);
    }

    const intraPkgRefs = srcFiles
      .filter((file) => relFromSrc(file) !== 'index.ts' && relFromSrc(file) !== 'note-ai-model.ts')
      .flatMap((file) =>
        adapterSymbolReferences(seededExports, readText(file)).map((sym) => `${relative(ROOT, file)}: ${sym}`),
      );
    expect(intraPkgRefs, 'intra-package files must not re-import note-ai-model exports via index.ts').toEqual([]);

    const ALLOWED_WORKSPACE_USERS = new Set([
      'packages/agent/src/note-ai-model.ts',
      'packages/agent/src/index.ts',
      'apps/kernel/src/member-vy-ports.ts',
    ]);
    const workspaceLeaks = workspaceNonTestSources(ROOT)
      .filter((file) => !ALLOWED_WORKSPACE_USERS.has(relative(ROOT, file).replace(/\\/g, '/')))
      .flatMap((file) => {
        const rel = relative(ROOT, file).replace(/\\/g, '/');
        return workspaceAdapterLeakViolations(readText(file), seededExports, rel).map((v) => `${rel}: ${v}`);
      });
    expect(
      workspaceLeaks,
      'only packages/agent/src/index.ts and apps/kernel/src/member-vy-ports.ts may touch note-ai-model exports',
    ).toEqual([]);
  }, 30_000);

  it('has member-vy source files once the store command exists in the kernel', () => {
    const kernelSrc = join(ROOT, 'packages/kernel/src');
    const stores = sources(kernelSrc).some((file) => readFileSync(file, 'utf8').includes('kernel.member_vy.result.store'));
    if (stores) expect(sources(MEMBER_VY).length, 'the store command exists but no feature module is under packages/agent/src/member-vy').toBeGreaterThan(0);
    else expect(sources(MEMBER_VY).length, 'member-vy modules before the store command exists').toBe(0);
  });
});
