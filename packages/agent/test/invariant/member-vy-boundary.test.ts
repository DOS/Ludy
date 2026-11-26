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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SRC = join(ROOT, 'packages/agent/src');
const MEMBER_VY = join(SRC, 'member-vy');
const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
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

export function workspaceNonTestSources(rootDir: string): string[] {
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
  unambiguousRegexSpans: Array<{ start: number; end: number }>;
  commentSpans: Array<{ start: number; end: number }>;
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
  const parenAllowsRegexStack: Array<{ allowRegexAfter: boolean; inForHeader: boolean; semiSeen: boolean; depthInParen: number; savedLtCount: number }> = [];
  const jsxStack: Array<{ mode: 'openTag' | 'elem' | 'expr'; braceDepth: number; angleDepth: number }> = [];
  const suspiciousDivisionStarts = new Set<number>();
  const suspiciousRegexStarts = new Set<number>();
  const unambiguousRegexSpans: Array<{ start: number; end: number }> = [];
  const commentSpans: Array<{ start: number; end: number }> = [];

  let i = 0;
  let line = 1;
  let prevAllowsRegex = true;
  let prevCouldBeDivision = false;
  let prevWasDot = false;
  let prevControlKeyword = '';
  let prevWasLt = false;
  let prevWasGt = false;
  let prevWasRBrace = false;
  let openLtCount = 0;
  let sameLineDivLine = -1;
  let sameLineDivStarts: number[] = [];
  let asTypeActive = false;
  let asTypeExpectAtom = false;
  let asTypeConditionalDepth = 0;
  let asTypeParen = 0;
  let asTypeBracket = 0;
  let asTypeBrace = 0;
  let asTypeAngle = 0;
  let lastTokenWasTypeVoid = false;
  const braceExprStack: boolean[] = [];
  let nextLBraceCanBeExpr = false;
  let expectCaseColon = false;
  let lastRBraceWasExpr = false;

  const AS_TYPE_PREFIX_IDENTS = new Set([
    'keyof',
    'typeof',
    'readonly',
    'infer',
    'unique',
    'abstract',
    'new',
    'asserts',
  ]);
  const BRACE_EXPR_PREV_KEYWORDS = new Set([
    'return',
    'throw',
    'yield',
    'await',
    'typeof',
    'void',
    'delete',
    'in',
    'instanceof',
    'of',
    'new',
    'as',
    'satisfies',
  ]);
  const BRACE_EXPR_PREV_PUNCTS = new Set([
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '**=',
    '<<=',
    '>>=',
    '>>>=',
    '&=',
    '|=',
    '^=',
    '&&=',
    '||=',
    '??=',
    '(',
    '[',
    ',',
    '?',
    ':',
    '+',
    '-',
    '*',
    '/',
    '%',
    '**',
    '&',
    '|',
    '^',
    '<<',
    '>>',
    '>>>',
    '&&',
    '||',
    '??',
    '==',
    '===',
    '!=',
    '!==',
    '<',
    '<=',
    '>',
    '>=',
    '!',
    '~',
    '...',
  ]);

  const trackBraceExprToken = (tok: Token): void => {
    lastRBraceWasExpr = false;
    if (tok.kind === 'punct') {
      if (tok.value === '{') {
        braceExprStack.push(nextLBraceCanBeExpr);
        nextLBraceCanBeExpr = false;
        expectCaseColon = false;
        return;
      }
      if (tok.value === '}') {
        lastRBraceWasExpr = braceExprStack.pop() ?? false;
        nextLBraceCanBeExpr = false;
        expectCaseColon = false;
        return;
      }
      if (tok.value === ':' && expectCaseColon) {
        expectCaseColon = false;
        nextLBraceCanBeExpr = false;
        return;
      }
      expectCaseColon = false;
      nextLBraceCanBeExpr = BRACE_EXPR_PREV_PUNCTS.has(tok.value);
      return;
    }
    if (tok.kind === 'template_head' || tok.kind === 'template_middle') {
      expectCaseColon = false;
      nextLBraceCanBeExpr = true;
      return;
    }
    if (tok.kind === 'ident' && !tok.escaped && !prevWasDot) {
      if (tok.value === 'case' || tok.value === 'default') {
        expectCaseColon = true;
        nextLBraceCanBeExpr = tok.value === 'default';
      } else {
        expectCaseColon = false;
        nextLBraceCanBeExpr = BRACE_EXPR_PREV_KEYWORDS.has(tok.value);
      }
      return;
    }
    expectCaseColon = false;
    nextLBraceCanBeExpr = false;
  };

  const resetAsType = (): void => {
    asTypeActive = false;
    asTypeExpectAtom = false;
    asTypeConditionalDepth = 0;
    asTypeParen = 0;
    asTypeBracket = 0;
    asTypeBrace = 0;
    asTypeAngle = 0;
  };

  const trackAsTypeToken = (tok: Token): void => {
    lastTokenWasTypeVoid = false;
    if (!asTypeActive) {
      if (
        tok.kind === 'ident' &&
        !tok.escaped &&
        !prevWasDot &&
        (!prevAllowsRegex || prevCouldBeDivision) &&
        (tok.value === 'as' || tok.value === 'satisfies')
      ) {
        asTypeActive = true;
        asTypeExpectAtom = true;
      }
      return;
    }
    if (asTypeParen > 0 || asTypeBracket > 0 || asTypeBrace > 0 || asTypeAngle > 0) {
      if (tok.kind === 'punct') {
        if (tok.value === '(') asTypeParen += 1;
        else if (tok.value === '[') asTypeBracket += 1;
        else if (tok.value === '{') asTypeBrace += 1;
        else if (tok.value === '<' && asTypeParen === 0 && asTypeBracket === 0 && asTypeBrace === 0) asTypeAngle += 1;
        else if (tok.value === ')') {
          if (asTypeParen > 0) {
            asTypeParen -= 1;
            if (asTypeParen === 0 && asTypeBracket === 0 && asTypeBrace === 0 && asTypeAngle === 0) asTypeExpectAtom = false;
          } else {
            resetAsType();
          }
        } else if (tok.value === ']') {
          if (asTypeBracket > 0) {
            asTypeBracket -= 1;
            if (asTypeParen === 0 && asTypeBracket === 0 && asTypeBrace === 0 && asTypeAngle === 0) asTypeExpectAtom = false;
          } else {
            resetAsType();
          }
        } else if (tok.value === '}') {
          if (asTypeBrace > 0) {
            asTypeBrace -= 1;
            if (asTypeParen === 0 && asTypeBracket === 0 && asTypeBrace === 0 && asTypeAngle === 0) asTypeExpectAtom = false;
          } else {
            resetAsType();
          }
        } else if (tok.value === '>' && asTypeAngle > 0 && asTypeParen === 0 && asTypeBracket === 0 && asTypeBrace === 0) {
          asTypeAngle -= 1;
          if (asTypeAngle === 0) asTypeExpectAtom = false;
        }
      } else if (
        (tok.kind === 'template' || tok.kind === 'template_middle' || tok.kind === 'template_tail') &&
        asTypeBrace === 0 &&
        asTypeParen === 0 &&
        asTypeBracket === 0
      ) {
        resetAsType();
      }
      return;
    }
    if (tok.kind === 'ident' && !tok.escaped) {
      if (prevWasDot) {
        asTypeExpectAtom = false;
      } else if (asTypeExpectAtom) {
        if (tok.value === 'void') {
          lastTokenWasTypeVoid = true;
          asTypeExpectAtom = false;
        } else if (!AS_TYPE_PREFIX_IDENTS.has(tok.value)) {
          asTypeExpectAtom = false;
        }
      } else if (tok.value === 'extends') {
        asTypeConditionalDepth += 1;
        asTypeExpectAtom = true;
      } else if (tok.value === 'is' || tok.value === 'as' || tok.value === 'satisfies') {
        asTypeExpectAtom = true;
      } else {
        resetAsType();
      }
      return;
    }
    if (tok.kind === 'string' || tok.kind === 'number') {
      if (asTypeExpectAtom) asTypeExpectAtom = false;
      else resetAsType();
      return;
    }
    if (tok.kind === 'template' || tok.kind === 'template_head' || tok.kind === 'template_middle' || tok.kind === 'template_tail') {
      if (asTypeExpectAtom && tok.kind === 'template') asTypeExpectAtom = false;
      else resetAsType();
      return;
    }
    if (tok.kind === 'punct') {
      if (tok.value === '(' && asTypeExpectAtom) {
        asTypeParen += 1;
      } else if (tok.value === '[') {
        asTypeBracket += 1;
      } else if (tok.value === '{' && asTypeExpectAtom) {
        asTypeBrace += 1;
      } else if (tok.value === '<' && !asTypeExpectAtom) {
        asTypeAngle += 1;
      } else if (tok.value === '|' || tok.value === '&' || tok.value === '=>') {
        asTypeExpectAtom = true;
      } else if (tok.value === '.') {
        asTypeExpectAtom = false;
      } else if (tok.value === '?' && asTypeConditionalDepth > 0 && !asTypeExpectAtom) {
        asTypeExpectAtom = true;
      } else if (tok.value === ':' && asTypeConditionalDepth > 0 && !asTypeExpectAtom) {
        asTypeConditionalDepth -= 1;
        asTypeExpectAtom = true;
      } else if (tok.value === '!' && !asTypeExpectAtom) {
        asTypeExpectAtom = false;
      } else {
        resetAsType();
      }
      return;
    }
    resetAsType();
  };

  const markCommentOnCurrentLine = (): void => {
    if (sameLineDivLine === line) {
      for (const pos of sameLineDivStarts) suspiciousDivisionStarts.add(pos);
      sameLineDivStarts.length = 0;
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
    trackAsTypeToken(tok);
    trackBraceExprToken(tok);
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
        prevCouldBeDivision = false;
        prevWasDot = false;
        prevControlKeyword = '';
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
          prevCouldBeDivision = false;
          prevWasDot = false;
          prevControlKeyword = '';
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
        prevCouldBeDivision = false;
        prevWasDot = false;
        prevControlKeyword = '';
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
        prevCouldBeDivision = false;
        prevWasDot = false;
        prevControlKeyword = '';
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
        prevCouldBeDivision = false;
        prevWasDot = false;
        prevControlKeyword = '';
        prevWasLt = true;
        prevWasGt = false;
        prevWasRBrace = false;
        continue;
      }
      if (options.stripCommentsMode) chunks.push('<');
      emit({ kind: 'invalid', raw: '<', value: 'unexpected < in JSX text', escaped: false, start: j, end: j + 1, line });
      i = j + 1;
      prevAllowsRegex = false;
      prevCouldBeDivision = false;
      prevWasDot = false;
      prevControlKeyword = '';
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
      commentSpans.push({ start: i, end: stop });
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
        commentSpans.push({ start: i, end: stop });
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
      prevCouldBeDivision = false;
      prevWasDot = false;
      prevControlKeyword = '';
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
      prevCouldBeDivision = false;
      prevWasDot = false;
      prevControlKeyword = '';
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
      prevCouldBeDivision = false;
      prevWasDot = false;
      prevControlKeyword = '';
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
      if (!forceRegex && prevCouldBeDivision && ((closed && /['"`]/.test(raw)) || (!closed && /['"`;]/.test(raw)))) {
        suspiciousRegexStarts.add(start);
      }
      if (closed && !forceRegex && !prevCouldBeDivision && options.emitTokens && !options.scanRegexAsDivision) {
        unambiguousRegexSpans.push({ start, end: j });
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
      prevCouldBeDivision = false;
      prevWasDot = false;
      prevControlKeyword = '';
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
      prevCouldBeDivision = false;
      prevWasDot = false;
      prevControlKeyword = '';
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
        const topParen = parenAllowsRegexStack[parenAllowsRegexStack.length - 1];
        const isForOfHead =
          !prevWasDot &&
          value === 'of' &&
          Boolean(topParen?.inForHeader && !topParen.semiSeen && topParen.depthInParen === 0);
        prevAllowsRegex = !prevWasDot && !lastTokenWasTypeVoid && REGEX_PREFIX_KEYWORDS.has(value);
        // Unary `void` opens a regex literal, whereas type `void` in `as ...` / `satisfies ...` ends an expression that `/` divides.
        prevCouldBeDivision = !prevWasDot && !lastTokenWasTypeVoid && (value === 'await' || value === 'yield' || (value === 'of' && !isForOfHead));
        prevControlKeyword =
          !prevWasDot && value === 'await' && prevControlKeyword === 'for'
            ? 'for await'
            : !prevWasDot && CONTROL_KEYWORDS.has(value)
              ? value
              : '';
      } else {
        prevAllowsRegex = false;
        prevCouldBeDivision = false;
        prevControlKeyword = '';
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
        prevCouldBeDivision = false;
        prevWasDot = false;
        prevControlKeyword = '';
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
        prevCouldBeDivision = false;
        prevWasDot = false;
        prevControlKeyword = '';
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
      if (parenAllowsRegexStack.length > 0) {
        parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen += 1;
      }
      parenAllowsRegexStack.push({
        allowRegexAfter: prevControlKeyword !== '',
        inForHeader: prevControlKeyword === 'for' || prevControlKeyword === 'for await',
        semiSeen: false,
        depthInParen: 0,
        savedLtCount: openLtCount,
      });
      prevAllowsRegex = true;
      prevCouldBeDivision = false;
      prevWasDot = false;
    } else if (punct === ')') {
      const poppedParen = parenAllowsRegexStack.pop();
      prevAllowsRegex = poppedParen?.allowRegexAfter ?? false;
      if (poppedParen) openLtCount = poppedParen.savedLtCount;
      if (parenAllowsRegexStack.length > 0 && parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen > 0) {
        parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen -= 1;
      }
      prevCouldBeDivision = false;
      prevWasDot = false;
    } else if (punct === '.' || punct === '?.') {
      prevWasDot = true;
      prevAllowsRegex = false;
      prevCouldBeDivision = false;
    } else if (punct === ']' || punct === '++' || punct === '--') {
      if (punct === ']' && parenAllowsRegexStack.length > 0 && parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen > 0) {
        parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen -= 1;
      }
      prevAllowsRegex = false;
      prevCouldBeDivision = false;
      prevWasDot = false;
    } else if (punct === '!') {
      // Prefix `!expr` leaves prevAllowsRegex=true; TypeScript postfix `expr!` preserves prevAllowsRegex and prevCouldBeDivision for `/`.
      prevWasDot = false;
    } else {
      if (punct === '[' || punct === '{') {
        if (parenAllowsRegexStack.length > 0) {
          parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen += 1;
        }
      } else if (punct === '}' && parenAllowsRegexStack.length > 0 && parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen > 0) {
        parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen -= 1;
      } else if ((punct === ';' || punct === '=') && parenAllowsRegexStack.length > 0) {
        const topParen = parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!;
        if (topParen.inForHeader && topParen.depthInParen === 0) topParen.semiSeen = true;
      }
      let closedGenericGt = false;
      if (punct === '<') {
        openLtCount += 1;
      } else if (punct === '>') {
        if (openLtCount > 0) {
          openLtCount -= 1;
          closedGenericGt = true;
        }
      } else if (
        punct === ';' ||
        punct === '=>' ||
        punct === '&&' ||
        punct === '||' ||
        punct === '??' ||
        punct === '==' ||
        punct === '===' ||
        punct === '!=' ||
        punct === '!==' ||
        punct === '<=' ||
        punct === '=' ||
        punct === '+=' ||
        punct === '-=' ||
        punct === '*=' ||
        punct === '/='
      ) {
        openLtCount = 0;
      }
      prevAllowsRegex = true;
      prevCouldBeDivision = (punct === '}' && lastRBraceWasExpr) || closedGenericGt;
      prevWasDot = false;
    }
    prevControlKeyword = '';
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
    unambiguousRegexSpans,
    commentSpans,
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

const isRegexWordCode = (code: number): boolean =>
  code === 95 || (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);

// Precondition: callers must invoke the returned finder with monotonically non-decreasing `fromIdx` within a single pass
// so `cachedSq`/`cachedDq` never skip an earlier quote while avoiding repeated EOF scans in O(N) total time.
function createNextQuoteFinder(text: string): (fromIdx: number) => number {
  let cachedSq = -2;
  let cachedDq = -2;
  return (fromIdx: number): number => {
    if (cachedSq !== -1 && cachedSq < fromIdx) cachedSq = text.indexOf("'", fromIdx);
    if (cachedDq !== -1 && cachedDq < fromIdx) cachedDq = text.indexOf('"', fromIdx);
    if (cachedSq < 0) return cachedDq;
    if (cachedDq < 0) return cachedSq;
    return cachedSq < cachedDq ? cachedSq : cachedDq;
  };
}

function collectRawCallSpecifiers(text: string, keyword: 'import(' | 'require(', out: string[]): void {
  const len = text.length;
  const kwLen = keyword.length;
  const nextQuote = createNextQuoteFinder(text);
  let pos = 0;
  while ((pos = text.indexOf(keyword, pos)) >= 0) {
    const hasWordBefore = pos > 0 && isRegexWordCode(text.charCodeAt(pos - 1));
    let p = pos + kwLen;
    if (hasWordBefore) {
      pos += kwLen;
      continue;
    }
    while (p < len && isWhitespaceCode(text.charCodeAt(p))) p += 1;
    const q1 = text.charCodeAt(p);
    if (q1 !== 39 && q1 !== 34) {
      pos = p;
      continue;
    }
    const q2Pos = nextQuote(p + 1);
    if (q2Pos < 0) break;
    if (q2Pos > p + 1) {
      let r = q2Pos + 1;
      while (r < len && isWhitespaceCode(text.charCodeAt(r))) r += 1;
      if (text.charCodeAt(r) === 41) out.push(text.slice(p + 1, q2Pos));
    }
    pos += kwLen;
  }
}

// O(N) linear superset scanner replacing the quadratic `(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*...` regex.
export function linearRawSpecifiers(text: string): string[] {
  const out: string[] = [];
  const len = text.length;
  const nextQuote = createNextQuoteFinder(text);
  let inClause = false;
  let i = 0;
  while (i < len) {
    if (!inClause) {
      if (i > 0 && text.charCodeAt(i - 1) !== 10) {
        const nl = text.indexOf('\n', i);
        if (nl < 0) break;
        i = nl + 1;
        continue;
      }
      while (i < len && isWhitespaceCode(text.charCodeAt(i))) i += 1;
      if (i >= len) break;
      if (
        (text.startsWith('import', i) || text.startsWith('export', i)) &&
        (i + 6 >= len || !isRegexWordCode(text.charCodeAt(i + 6)))
      ) {
        inClause = true;
        i += 6;
        continue;
      }
      const nl = text.indexOf('\n', i);
      if (nl < 0) break;
      i = nl + 1;
      continue;
    }
    const code = text.charCodeAt(i);
    if (code === 59 /* ; */) {
      inClause = false;
      i += 1;
      continue;
    }
    if (code === 102 /* f */ && (i === 0 || !isRegexWordCode(text.charCodeAt(i - 1))) && text.startsWith('from', i)) {
      let p = i + 4;
      while (p < len && isWhitespaceCode(text.charCodeAt(p))) p += 1;
      const q1 = text.charCodeAt(p);
      if (q1 === 39 || q1 === 34) {
        const q2Pos = nextQuote(p + 1);
        if (q2Pos < 0) break;
        if (q2Pos === p + 1) {
          i = q2Pos + 1;
          continue;
        }
        out.push(text.slice(p + 1, q2Pos));
        inClause = false;
        i = q2Pos + 1;
        continue;
      }
      i = p;
      continue;
    }
    i += 1;
  }
  collectRawCallSpecifiers(text, 'import(', out);
  collectRawCallSpecifiers(text, 'require(', out);
  return out;
}

interface ModuleScanResult {
  specifiers: string[];
  hasComputedDynamic: boolean;
  hasBareRequire: boolean;
  hasInvalidSyntax: boolean;
  importDecls: Array<{
    specifier: string;
    isNamespace: boolean;
    isDefault: boolean;
    isSideEffect: boolean;
    barrelBindings: string[];
  }>;
  exportDecls: Array<{ specifier: string; isStar: boolean }>;
  dynamicCalls: Array<{
    fn: 'import' | 'require';
    specifier: string | null;
    argSnippet: string;
    boundTarget: string | null;
    closeParenIdx: number;
  }>;
  aliasEdges: Map<string, Set<string>>;
}

const isMemberPrev = (tokens: readonly Token[], idx: number): boolean => {
  if (idx <= 0) return false;
  const prev = tokens[idx - 1];
  return prev?.kind === 'punct' && (prev.value === '.' || prev.value === '?.');
};

interface DelimiterPairs {
  paren: Int32Array;
  brace: Int32Array;
  bracket: Int32Array;
}

function pairDelimiters(tokens: readonly Token[]): DelimiterPairs {
  const paren = new Int32Array(tokens.length).fill(-1);
  const brace = new Int32Array(tokens.length).fill(-1);
  const bracket = new Int32Array(tokens.length).fill(-1);
  const parenStack: number[] = [];
  const braceStack: number[] = [];
  const bracketStack: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind !== 'punct') continue;
    if (t.value === '(') parenStack.push(i);
    else if (t.value === ')' && parenStack.length > 0) paren[parenStack.pop()!] = i;
    else if (t.value === '{') braceStack.push(i);
    else if (t.value === '}' && braceStack.length > 0) brace[braceStack.pop()!] = i;
    else if (t.value === '[') bracketStack.push(i);
    else if (t.value === ']' && bracketStack.length > 0) bracket[bracketStack.pop()!] = i;
  }
  return { paren, brace, bracket };
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

const GLOBAL_REQUIRE_HOSTS = new Set(['globalThis', 'window', 'self', 'module']);

function findAssignmentLhsIdent(tokens: readonly Token[], eqIdx: number): string | null {
  const prev = tokens[eqIdx - 1];
  if (prev?.kind === 'punct' && prev.value === '<') return null;

  // Scan backward across optional TS type annotation `: Type` in `const x: Type = ...` without trusting
  // multi-token trailing type identifiers such as `typeof metered` or `NodeRequire | undefined`.
  const direct =
    prev?.kind === 'ident' && !isMemberPrev(tokens, eqIdx - 1) ? prev.value : null;
  let depth = 0;
  let angleDepth = 0;
  let firstColon = -1;
  const limit = Math.max(0, eqIdx - 64);
  for (let p = eqIdx - 1; p >= limit; p -= 1) {
    const tok = tokens[p]!;
    if (tok.kind === 'punct') {
      if (tok.value === ')' || tok.value === ']' || tok.value === '}') depth += 1;
      else if (tok.value === '(' || tok.value === '[' || tok.value === '{') {
        if (depth === 0) {
          if (tok.value === '(' && firstColon > p) {
            const paramTok = tokens[firstColon - 1];
            return paramTok?.kind === 'ident' && !isMemberPrev(tokens, firstColon - 1) ? paramTok.value : null;
          }
          if (tok.value === '{' || tok.value === '[') return direct;
          return null;
        }
        depth -= 1;
      } else if (tok.value === '>') angleDepth += 1;
      else if (tok.value === '<' && angleDepth > 0) angleDepth -= 1;
      else if (depth === 0 && angleDepth === 0) {
        if (tok.value === ':') {
          firstColon = p;
        } else if (tok.value === ';' || tok.value === '=') {
          if (firstColon > 0) {
            const nameTok = tokens[firstColon - 1];
            return nameTok?.kind === 'ident' && !isMemberPrev(tokens, firstColon - 1) ? nameTok.value : null;
          }
          return direct;
        } else if (tok.value === ',' && firstColon < 0) {
          return direct;
        }
      }
    } else if (
      depth === 0 &&
      angleDepth === 0 &&
      tok.kind === 'ident' &&
      (tok.value === 'const' || tok.value === 'let' || tok.value === 'var')
    ) {
      if (firstColon > p) {
        const nameTok = tokens[firstColon - 1];
        return nameTok?.kind === 'ident' && !isMemberPrev(tokens, firstColon - 1) ? nameTok.value : null;
      }
      return direct;
    }
  }
  if (firstColon > 0) {
    const nameTok = tokens[firstColon - 1];
    return nameTok?.kind === 'ident' && !isMemberPrev(tokens, firstColon - 1) ? nameTok.value : null;
  }
  return direct;
}

function addAliasEdge(edges: Map<string, Set<string>>, from: string, to: string): void {
  if (from === to) return;
  let set = edges.get(from);
  if (!set) {
    set = new Set();
    edges.set(from, set);
  }
  set.add(to);
}

function propagateAliases(seeds: Iterable<string>, edges: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const out = new Set<string>(seeds);
  const queue = [...out];
  while (queue.length > 0) {
    const cur = queue.pop()!;
    const nexts = edges.get(cur);
    if (!nexts) continue;
    for (const next of nexts) {
      if (!out.has(next)) {
        out.add(next);
        queue.push(next);
      }
    }
  }
  return out;
}

const SKIP_TYPE_KW = new Set(['=', ';', ',', 'in', 'of']);

const TYPE_BRACE_PREV_PUNCTS = new Set([':', '|', '&', '(', '<', ',', '=>', '?']);
const TYPE_BRACE_PREV_IDENTS = new Set(['readonly', 'keyof', 'infer', 'is', 'extends']);
const POST_TYPE_CONT_PUNCTS = new Set(['=', ',', ')', ';', '|', '&', '[', '.', '?', ':', '<', '{', '=>']);

function skipOptionalTypeForward(tokens: readonly Token[], colonIdx: number, delims: DelimiterPairs, limit = 64): number {
  if (tokens[colonIdx]?.kind !== 'punct' || tokens[colonIdx]?.value !== ':') return colonIdx;
  let pd = 0;
  let bd = 0;
  let cd = 0;
  let ad = 0;
  const max = Math.min(tokens.length, colonIdx + 1 + limit);
  for (let p = colonIdx + 1; p < max; p += 1) {
    const tok = tokens[p]!;
    if (tok.kind === 'punct') {
      if (tok.value === '(') pd += 1;
      else if (tok.value === ')') {
        if (pd === 0 && bd === 0 && cd === 0 && ad === 0) return p;
        pd -= 1;
      } else if (tok.value === '[') bd += 1;
      else if (tok.value === ']' && bd > 0) bd -= 1;
      else if (tok.value === '{') {
        if (pd === 0 && bd === 0 && cd === 0 && ad === 0) {
          const prevTok = tokens[p - 1];
          const isTypeBrace =
            (prevTok?.kind === 'punct' && TYPE_BRACE_PREV_PUNCTS.has(prevTok.value)) ||
            (prevTok?.kind === 'ident' && TYPE_BRACE_PREV_IDENTS.has(prevTok.value));
          if (isTypeBrace) {
            const closeBrace = delims.brace[p] ?? -1;
            if (closeBrace > p) {
              const afterBrace = tokens[closeBrace + 1];
              if (
                (afterBrace?.kind === 'punct' && POST_TYPE_CONT_PUNCTS.has(afterBrace.value)) ||
                (afterBrace?.kind === 'ident' && afterBrace.value === 'extends')
              ) {
                p = closeBrace;
                continue;
              }
              return closeBrace + 1;
            }
          }
          return p;
        }
        cd += 1;
      } else if (tok.value === '}' && cd > 0) cd -= 1;
      else if (tok.value === '<') ad += 1;
      else if (tok.value === '>' && ad > 0) ad -= 1;
      else if (pd === 0 && bd === 0 && cd === 0 && ad === 0 && (tok.value === '=' || tok.value === ';' || tok.value === ',' || tok.value === '=>')) {
        return p;
      }
    } else if (pd === 0 && bd === 0 && cd === 0 && ad === 0 && tok.kind === 'ident' && SKIP_TYPE_KW.has(tok.value)) {
      return p;
    }
  }
  return max;
}

const NON_PARAM_PARENS = new Set(['if', 'while', 'for', 'with', 'switch']);
const DESTRUCTURE_FOLLOW_PUNCTS = new Set(['=', ':', ',', ')', ']', '}']);

function findFnDeclHeadBeforeParen(tokens: readonly Token[], openIdx: number): Token | undefined {
  let fnIdx = openIdx - 1;
  if (tokens[fnIdx]?.kind === 'punct' && tokens[fnIdx]?.value === '>') {
    let ad = 1;
    let q = fnIdx - 1;
    const minQ = Math.max(0, fnIdx - 48);
    while (q >= minQ && ad > 0) {
      const qt = tokens[q]!;
      if (qt.kind === 'punct') {
        if (qt.value === '>') ad += 1;
        else if (qt.value === '<') ad -= 1;
      }
      if (ad > 0) q -= 1;
    }
    fnIdx = ad === 0 ? q - 1 : -1;
  }
  return fnIdx >= 0 ? tokens[fnIdx] : undefined;
}

function isEnclosingPatternContext(
  tokens: readonly Token[],
  startIdx: number,
  endIdx: number,
  delims: DelimiterPairs,
  depth = 0,
): boolean {
  if (depth > 4) return false;
  let pd = 0;
  let bd = 0;
  let cd = 0;
  let sawTopComma = false;
  let openIdx = -1;
  let openKind: '(' | '[' | '{' | null = null;
  const minScan = Math.max(0, startIdx - 64);
  for (let p = startIdx - 1; p >= minScan; p -= 1) {
    const tk = tokens[p]!;
    if (tk.kind === 'punct') {
      if (tk.value === ')') pd += 1;
      else if (tk.value === ']') bd += 1;
      else if (tk.value === '}') cd += 1;
      else if (tk.value === '(') {
        if (pd === 0 && bd === 0 && cd === 0) {
          openIdx = p;
          openKind = '(';
          break;
        }
        if (pd > 0) pd -= 1;
      } else if (tk.value === '[') {
        if (pd === 0 && bd === 0 && cd === 0) {
          openIdx = p;
          openKind = '[';
          break;
        }
        if (bd > 0) bd -= 1;
      } else if (tk.value === '{') {
        if (pd === 0 && bd === 0 && cd === 0) {
          openIdx = p;
          openKind = '{';
          break;
        }
        if (cd > 0) cd -= 1;
      } else if (pd === 0 && bd === 0 && cd === 0) {
        if (tk.value === ',') sawTopComma = true;
        else if (tk.value === ';' || (tk.value === '=' && !sawTopComma)) return false;
      }
    }
  }
  if (openIdx < 0 || !openKind) return false;
  if (openKind === '[') {
    const closeBr = delims.bracket[openIdx] ?? -1;
    if (closeBr <= endIdx) return false;
    const afterBrIdx = tokens[closeBr + 1]?.kind === 'punct' && tokens[closeBr + 1]?.value === ':'
      ? skipOptionalTypeForward(tokens, closeBr + 1, delims)
      : closeBr + 1;
    const afterBr = tokens[afterBrIdx];
    if (afterBr?.kind === 'punct' && afterBr.value === '=') return true;
    if (afterBr?.kind === 'ident' && (afterBr.value === 'in' || afterBr.value === 'of')) return true;
    return isEnclosingPatternContext(tokens, openIdx, closeBr, delims, depth + 1);
  }
  if (openKind === '{') {
    const closeBrace = delims.brace[openIdx] ?? -1;
    if (closeBrace <= endIdx) return false;
    return isDestructuringBraceContext(tokens, openIdx, closeBrace, delims);
  }
  const closeParen = delims.paren[openIdx] ?? -1;
  if (closeParen <= endIdx) return false;
  const beforeOpen = tokens[openIdx - 1];
  if (beforeOpen?.kind === 'ident' && beforeOpen.value === 'catch') return true;
  if (beforeOpen?.kind === 'ident' && NON_PARAM_PARENS.has(beforeOpen.value)) return false;
  const afterParenIdx = tokens[closeParen + 1]?.kind === 'punct' && tokens[closeParen + 1]?.value === ':'
    ? skipOptionalTypeForward(tokens, closeParen + 1, delims)
    : closeParen + 1;
  const afterParen = tokens[afterParenIdx];
  if (afterParen?.kind === 'punct' && afterParen.value === '=>') return true;
  if (afterParen?.kind === 'punct' && afterParen.value === '{' && !isMemberPrev(tokens, openIdx)) {
    const fnBefore = findFnDeclHeadBeforeParen(tokens, openIdx);
    if (
      (fnBefore?.kind === 'ident' && !NON_PARAM_PARENS.has(fnBefore.value) && !CONTROL_KEYWORDS.has(fnBefore.value)) ||
      (fnBefore?.kind === 'punct' && fnBefore.value === '*') ||
      (beforeOpen?.kind === 'ident' && beforeOpen.value === 'function')
    ) {
      return true;
    }
  }
  return false;
}

function isDestructuringBraceContext(
  tokens: readonly Token[],
  braceIdx: number,
  closeBrace: number,
  delims: DelimiterPairs,
): boolean {
  if (closeBrace <= braceIdx) return false;
  const prev = tokens[braceIdx - 1];
  if (prev?.kind === 'punct' && (prev.value === ':' || prev.value === '=>')) return false;
  const follow = tokens[closeBrace + 1];
  if (
    !follow ||
    (follow.kind === 'punct' && !DESTRUCTURE_FOLLOW_PUNCTS.has(follow.value)) ||
    (follow.kind !== 'punct' && !(follow.kind === 'ident' && (follow.value === 'in' || follow.value === 'of')))
  ) {
    return false;
  }

  const afterIdx = follow.kind === 'punct' && follow.value === ':'
    ? skipOptionalTypeForward(tokens, closeBrace + 1, delims)
    : closeBrace + 1;
  const after = tokens[afterIdx];
  if (after?.kind === 'punct' && after.value === '=') return true;
  if (after?.kind === 'ident' && (after.value === 'in' || after.value === 'of')) return true;
  return isEnclosingPatternContext(tokens, braceIdx, closeBrace, delims);
}

function extractDestructuredMatches(
  tokens: readonly Token[],
  braceIdx: number,
  closeBrace: number,
  delims: DelimiterPairs,
  targetKeys: ReadonlySet<string>,
  resolveStaticStr: (start: number, end: number) => string | null,
  templateTail?: Int32Array,
  depth = 0,
): Array<{ key: string; localName: string | null }> {
  const results: Array<{ key: string; localName: string | null }> = [];
  if (depth > 4) return results;
  let entryStart = braceIdx + 1;

  const processEntry = (s: number, e: number): void => {
    if (s >= e) return;
    const first = tokens[s]!;
    let keyName: string | null = null;
    let afterKey = s + 1;
    if (first.kind === 'ident' || first.kind === 'string' || first.kind === 'template') {
      keyName = first.value;
    } else if (first.kind === 'punct' && first.value === '[') {
      const closeBr = delims.bracket[s] ?? -1;
      if (closeBr > s + 1 && closeBr < e) {
        keyName = resolveStaticStr(s + 1, closeBr);
        afterKey = closeBr + 1;
      }
    }
    const nextTok = tokens[afterKey];
    if (nextTok?.kind === 'punct' && nextTok.value === ':' && tokens[afterKey + 1]?.kind === 'punct' && tokens[afterKey + 1]?.value === '{') {
      const nestedClose = delims.brace[afterKey + 1] ?? -1;
      if (nestedClose > afterKey + 1 && nestedClose < e) {
        results.push(...extractDestructuredMatches(tokens, afterKey + 1, nestedClose, delims, targetKeys, resolveStaticStr, templateTail, depth + 1));
      }
    }
    if (!keyName || !targetKeys.has(keyName)) return;
    if (afterKey >= e || (nextTok?.kind === 'punct' && nextTok.value === '=')) {
      results.push({ key: keyName, localName: keyName });
      return;
    }
    if (nextTok?.kind === 'punct' && nextTok.value === ':') {
      const targetTok = tokens[afterKey + 1];
      results.push({ key: keyName, localName: targetTok?.kind === 'ident' ? targetTok.value : null });
    }
  };

  for (let p = braceIdx + 1; p < closeBrace; p += 1) {
    const tk = tokens[p]!;
    if (tk.kind === 'template_head' && templateTail) {
      const tail = templateTail[p] ?? -1;
      if (tail > p && tail < closeBrace) {
        p = tail;
        continue;
      }
    }
    if (tk.kind !== 'punct') continue;
    if (tk.value === '(') {
      const cl = delims.paren[p] ?? -1;
      if (cl > p && cl < closeBrace) p = cl;
    } else if (tk.value === '[') {
      const cl = delims.bracket[p] ?? -1;
      if (cl > p && cl < closeBrace) p = cl;
    } else if (tk.value === '{') {
      const cl = delims.brace[p] ?? -1;
      if (cl > p && cl < closeBrace) p = cl;
    } else if (tk.value === ',') {
      processEntry(entryStart, p);
      entryStart = p + 1;
    }
  }
  processEntry(entryStart, closeBrace);
  return results;
}

const REQUIRE_DESTRUCTURE_KEYS = new Set(['require', 'createRequire']);

function matchNamedMemberSuffix(
  tokens: readonly Token[],
  receiverEnd: number,
  memberNames: readonly string[],
  delims: DelimiterPairs,
  resolveStaticStr: (start: number, end: number) => string | null,
): { endIdx: number; memberName: string } | null {
  const t1 = tokens[receiverEnd + 1];
  const t2 = tokens[receiverEnd + 2];
  if (t1?.kind === 'punct' && (t1.value === '.' || t1.value === '?.')) {
    if (t2?.kind === 'ident' && memberNames.includes(t2.value)) {
      return { endIdx: receiverEnd + 2, memberName: t2.value };
    }
    if (t1.value === '?.' && t2?.kind === 'punct' && t2.value === '[') {
      const closeBr = delims.bracket[receiverEnd + 2] ?? -1;
      if (closeBr > receiverEnd + 3) {
        const resolved = resolveStaticStr(receiverEnd + 3, closeBr);
        if (resolved !== null && memberNames.includes(resolved)) {
          return { endIdx: closeBr, memberName: resolved };
        }
      }
    }
    return null;
  }
  if (t1?.kind === 'punct' && t1.value === '[') {
    const closeBr = delims.bracket[receiverEnd + 1] ?? -1;
    if (closeBr > receiverEnd + 2) {
      const resolved = resolveStaticStr(receiverEnd + 2, closeBr);
      if (resolved !== null && memberNames.includes(resolved)) {
        return { endIdx: closeBr, memberName: resolved };
      }
    }
  }
  return null;
}

function matchTrailingNamedMember(
  tokens: readonly Token[],
  start: number,
  end: number,
  memberNames: readonly string[],
  closeMaps: ClosePairMaps,
  resolveStaticStr: (start: number, end: number) => string | null,
): { baseEnd: number; memberName: string } | null {
  let e = end;
  while (e > start && tokens[e - 1]?.kind === 'punct' && tokens[e - 1]?.value === '!') e -= 1;
  if (e - start < 3) return null;
  const last = tokens[e - 1];
  if (last?.kind === 'ident' && memberNames.includes(last.value) && isMemberPrev(tokens, e - 1)) {
    return e - 2 > start ? { baseEnd: e - 2, memberName: last.value } : null;
  }
  if (last?.kind === 'punct' && last.value === ']') {
    const openBr = closeMaps.bracketOpenFromClose[e - 1] ?? -1;
    if (openBr > start && openBr + 1 < e - 1) {
      const resolved = resolveStaticStr(openBr + 1, e - 1);
      if (resolved !== null && memberNames.includes(resolved)) {
        const optDot = tokens[openBr - 1];
        const baseEnd = optDot?.kind === 'punct' && optDot.value === '?.' ? openBr - 1 : openBr;
        return baseEnd > start ? { baseEnd, memberName: resolved } : null;
      }
    }
  }
  return null;
}

function isGroupingOpenParen(tokens: readonly Token[], openIdx: number): boolean {
  if (openIdx <= 0) return true;
  const prev = tokens[openIdx - 1]!;
  if (prev.kind === 'ident') return REGEX_PREFIX_KEYWORDS.has(prev.value) || CONTROL_KEYWORDS.has(prev.value);
  if (prev.kind === 'punct') return prev.value !== ')' && prev.value !== ']' && prev.value !== '!';
  return false;
}

function matchInlineModuleMemberCall(
  tokens: readonly Token[],
  callIdentIdx: number,
  specPred: (spec: string) => boolean,
  memberName: string,
  delims: DelimiterPairs,
  resolveStaticStr: (start: number, end: number) => string | null,
  minBound = 0,
  maxBound = tokens.length,
): { spec: string; modCloseEnd: number; memberEndIdx: number | null } | null {
  const fnTok = tokens[callIdentIdx];
  if (!fnTok || fnTok.kind !== 'ident' || (fnTok.value !== 'import' && fnTok.value !== 'require') || isMemberPrev(tokens, callIdentIdx)) {
    return null;
  }
  const openParen = tokens[callIdentIdx + 1];
  if (!openParen || openParen.kind !== 'punct' || openParen.value !== '(') return null;
  const call = scanBalancedParenArg(tokens, callIdentIdx + 1, delims.paren);
  const spec = call.singleStringSpec ?? call.foldedStringSpec;
  if (spec === null || !specPred(spec)) return null;
  const closeMod = delims.paren[callIdentIdx + 1] ?? -1;
  if (closeMod <= callIdentIdx + 1) return null;

  let wrapParens = 0;
  for (let b = callIdentIdx - 1; b >= Math.max(minBound, callIdentIdx - 8); b -= 1) {
    const bt = tokens[b]!;
    if (bt.kind === 'ident' && bt.value === 'await') continue;
    if (bt.kind === 'punct' && bt.value === '(' && isGroupingOpenParen(tokens, b)) {
      wrapParens += 1;
      continue;
    }
    break;
  }

  let afterClose = closeMod + 1;
  let steps = 0;
  while (afterClose < maxBound && steps < 12) {
    steps += 1;
    const tk = tokens[afterClose]!;
    if (tk.kind === 'punct' && tk.value === '!') {
      afterClose += 1;
      continue;
    }
    if (tk.kind === 'punct' && tk.value === ')' && wrapParens > 0) {
      wrapParens -= 1;
      afterClose += 1;
      continue;
    }
    break;
  }

  const modCloseEnd = afterClose - 1;
  const memberMatch = matchNamedMemberSuffix(tokens, modCloseEnd, [memberName], delims, resolveStaticStr);
  return {
    spec,
    modCloseEnd,
    memberEndIdx: memberMatch ? memberMatch.endIdx : null,
  };
}

function matchInlineModuleMemberSpan(
  tokens: readonly Token[],
  start: number,
  end: number,
  specPred: (spec: string) => boolean,
  memberName: string,
  delims: DelimiterPairs,
  resolveStaticStr: (start: number, end: number) => string | null,
): { kind: 'namespace' | 'member'; spec: string; memberEndIdx: number } | null {
  let p = start;
  let steps = 0;
  while (p < end && steps < 8) {
    steps += 1;
    const tk = tokens[p]!;
    if ((tk.kind === 'ident' && tk.value === 'await') || (tk.kind === 'punct' && tk.value === '(')) {
      p += 1;
      continue;
    }
    break;
  }
  if (p >= end) return null;
  const matched = matchInlineModuleMemberCall(tokens, p, specPred, memberName, delims, resolveStaticStr, start, end);
  if (!matched) return null;
  if (matched.memberEndIdx !== null && matched.memberEndIdx + 1 === end) {
    return { kind: 'member', spec: matched.spec, memberEndIdx: matched.memberEndIdx };
  }
  if (matched.modCloseEnd + 1 === end) {
    return { kind: 'namespace', spec: matched.spec, memberEndIdx: matched.modCloseEnd };
  }
  return null;
}

function matchHostNamedMember(
  tokens: readonly Token[],
  startIdx: number,
  hosts: ReadonlySet<string>,
  memberName: string,
  delims: DelimiterPairs,
  resolveStaticStr: (start: number, end: number) => string | null,
  getTemplateTail?: () => Int32Array,
): { endIdx: number } | null {
  let hostEnd = startIdx;
  if (tokens[startIdx]?.kind === 'punct' && tokens[startIdx]?.value === '(') {
    const prev = tokens[startIdx - 1];
    if (prev?.kind === 'ident' && !REGEX_PREFIX_KEYWORDS.has(prev.value)) return null;
    if (isMemberPrev(tokens, startIdx)) return null;
    const close = delims.paren[startIdx] ?? -1;
    if (close <= startIdx + 1) return null;
    let afterParen = close + 1;
    while (tokens[afterParen]?.kind === 'punct' && tokens[afterParen]?.value === '!') afterParen += 1;
    const follow = tokens[afterParen];
    if (!follow || follow.kind !== 'punct' || (follow.value !== '.' && follow.value !== '?.' && follow.value !== '[')) {
      return null;
    }
    const inner = normalizeValueExprSpan(tokens, startIdx, close + 1, delims, getTemplateTail?.());
    if (inner.end - inner.start !== 1) return null;
    const innerTok = tokens[inner.start];
    if (!innerTok || innerTok.kind !== 'ident' || !hosts.has(innerTok.value) || isMemberPrev(tokens, inner.start)) {
      return null;
    }
    hostEnd = afterParen - 1;
  } else {
    const host = tokens[startIdx];
    if (!host || host.kind !== 'ident' || !hosts.has(host.value) || isMemberPrev(tokens, startIdx)) {
      return null;
    }
    while (tokens[hostEnd + 1]?.kind === 'punct' && tokens[hostEnd + 1]?.value === '!') hostEnd += 1;
  }
  const suffix = matchNamedMemberSuffix(tokens, hostEnd, [memberName], delims, resolveStaticStr);
  return suffix ? { endIdx: suffix.endIdx } : null;
}

const NODE_MODULE_SPECIFIERS = new Set(['node:module', 'module']);
const isNodeModuleSpecifier = (spec: string): boolean =>
  NODE_MODULE_SPECIFIERS.has(spec) || NODE_MODULE_SPECIFIERS.has(normalizeModuleSpecifier(spec));

function collectNodeModuleImports(
  tokens: readonly Token[],
  delims: DelimiterPairs,
): { nodeModuleNamespaces: Set<string>; createRequireImportAliases: Set<string> } {
  const nodeModuleNamespaces = new Set<string>();
  const createRequireImportAliases = new Set<string>();

  const collectNamedBraces = (braceIdx: number): number => {
    const close = delims.brace[braceIdx] ?? -1;
    if (close < 0 || !isFromKeywordAt(tokens, close + 1)) return -1;
    if (!NODE_MODULE_SPECIFIERS.has(tokens[close + 2]?.value ?? '')) return -1;
    for (let k = braceIdx + 1; k < close; k += 1) {
      const item = tokens[k]!;
      if ((item.kind === 'ident' || item.kind === 'string') && (item.value === 'createRequire' || item.value === 'default')) {
        if (tokens[k + 1]?.kind === 'ident' && tokens[k + 1]?.value === 'as' && tokens[k + 2]?.kind === 'ident') {
          if (item.value === 'default') nodeModuleNamespaces.add(tokens[k + 2]!.value);
          else createRequireImportAliases.add(tokens[k + 2]!.value);
          k += 2;
        } else if (item.kind === 'ident' && item.value === 'createRequire') {
          createRequireImportAliases.add('createRequire');
        }
      }
    }
    return close + 2;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind !== 'ident' || isMemberPrev(tokens, i) || t.value !== 'import') continue;
    let p = i + 1;
    if (tokens[p]?.kind === 'ident' && tokens[p]?.value === 'type') continue;
    if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '*') {
      if (tokens[p + 1]?.kind === 'ident' && tokens[p + 1]?.value === 'as' && tokens[p + 2]?.kind === 'ident') {
        const ns = tokens[p + 2]!.value;
        if (isFromKeywordAt(tokens, p + 3) && NODE_MODULE_SPECIFIERS.has(tokens[p + 4]?.value ?? '')) {
          nodeModuleNamespaces.add(ns);
          i = p + 4;
        }
      }
      continue;
    }
    if (tokens[p]?.kind === 'ident' && !isFromKeywordAt(tokens, p)) {
      const defName = tokens[p]!.value;
      p += 1;
      if (isFromKeywordAt(tokens, p) && NODE_MODULE_SPECIFIERS.has(tokens[p + 1]?.value ?? '')) {
        nodeModuleNamespaces.add(defName);
        i = p + 1;
        continue;
      }
      if (tokens[p]?.kind === 'punct' && tokens[p]?.value === ',') {
        const q = p + 1;
        if (tokens[q]?.kind === 'punct' && tokens[q]?.value === '*') {
          if (
            tokens[q + 1]?.kind === 'ident' &&
            tokens[q + 1]?.value === 'as' &&
            tokens[q + 2]?.kind === 'ident' &&
            isFromKeywordAt(tokens, q + 3) &&
            NODE_MODULE_SPECIFIERS.has(tokens[q + 4]?.value ?? '')
          ) {
            nodeModuleNamespaces.add(defName);
            nodeModuleNamespaces.add(tokens[q + 2]!.value);
            i = q + 4;
          }
          continue;
        }
        if (tokens[q]?.kind === 'punct' && tokens[q]?.value === '{') {
          const endSpec = collectNamedBraces(q);
          if (endSpec >= 0) {
            nodeModuleNamespaces.add(defName);
            i = endSpec;
          }
        }
      }
      continue;
    }
    if (tokens[p]?.kind !== 'punct' || tokens[p]?.value !== '{') continue;
    const endSpec = collectNamedBraces(p);
    if (endSpec >= 0) i = endSpec;
  }
  return { nodeModuleNamespaces, createRequireImportAliases };
}

function analyzeTokenAliases(
  tokens: readonly Token[],
  delims: DelimiterPairs,
  resolveStaticStrArg?: (s: number, e: number) => string | null,
  getTemplateTailArg?: () => Int32Array,
): {
  requireAliases: Set<string>;
  hasBareRequire: boolean;
  aliasEdges: Map<string, Set<string>>;
  callAssignmentTarget: Map<number, string>;
  createRequireAliases: Set<string>;
  nodeModuleNamespaces: Set<string>;
  requireHosts: Set<string>;
} {
  const { nodeModuleNamespaces, createRequireImportAliases } = collectNodeModuleImports(tokens, delims);
  const dynamicNodeModuleNamespaces = new Set<string>();
  const seedRequireAliases = new Set<string>();
  const seedCreateRequireAliases = new Set<string>(['createRequire', ...createRequireImportAliases]);
  const aliasEdges = new Map<string, Set<string>>();
  const callAssignmentTarget = new Map<number, string>();
  let lazyTplMaps: ReturnType<typeof buildTemplateMaps> | null = null;
  let lazyScoped: ReturnType<typeof collectScopedConstBindings> | null = null;
  const ensureTplMaps = () => {
    if (!lazyTplMaps) lazyTplMaps = buildTemplateMaps(tokens);
    return lazyTplMaps;
  };
  const getTplTail = getTemplateTailArg ?? (() => ensureTplMaps().templateTail);
  const resolveStaticStr =
    resolveStaticStrArg ??
    ((s: number, e: number): string | null => {
      const maps = ensureTplMaps();
      return tryResolveConstantStringExpr(
        tokens,
        s,
        e,
        delims,
        maps.templateNext,
        (name, idx) => {
          if (!lazyScoped) lazyScoped = collectScopedConstBindings(tokens, delims, maps.templateNext, maps.templateTail);
          return lookupScopedConst(lazyScoped.scopes, lazyScoped.tokenScope[idx] ?? 0, name);
        },
        0,
        maps.templateTail,
      );
    });
  const skipBangs = (idx: number): number => {
    while (idx < tokens.length && tokens[idx]?.kind === 'punct' && tokens[idx]?.value === '!') idx += 1;
    return idx;
  };
  const extractRhsInfo = (eqIdx: number): { rhsNoAwait: number; rhs: number } => {
    let rhsNoAwait = eqIdx + 1;
    while (rhsNoAwait < tokens.length && tokens[rhsNoAwait]?.kind === 'ident' && tokens[rhsNoAwait]?.value === 'await') {
      rhsNoAwait += 1;
    }
    let rhs = rhsNoAwait;
    while (rhs < tokens.length) {
      const rt = tokens[rhs]!;
      if ((rt.kind === 'punct' && rt.value === '(') || (rt.kind === 'ident' && rt.value === 'await')) {
        rhs += 1;
        continue;
      }
      break;
    }
    return { rhsNoAwait, rhs };
  };
  const recordMemberRhs = (lhs: string, memberEndIdx: number, alsoSeedCreateRequire: boolean): void => {
    const afterIdx = skipBangs(memberEndIdx + 1);
    const afterTok = tokens[afterIdx];
    if (afterTok?.kind === 'punct' && afterTok.value === '(') {
      if (alsoSeedCreateRequire) seedRequireAliases.add(lhs);
      callAssignmentTarget.set(afterIdx, lhs);
    } else if (
      afterTok?.kind === 'punct' &&
      afterTok.value === '?.' &&
      tokens[afterIdx + 1]?.kind === 'punct' &&
      tokens[afterIdx + 1]?.value === '('
    ) {
      if (alsoSeedCreateRequire) seedRequireAliases.add(lhs);
      callAssignmentTarget.set(afterIdx + 1, lhs);
    } else {
      if (alsoSeedCreateRequire) seedCreateRequireAliases.add(lhs);
      seedRequireAliases.add(lhs);
    }
  };
  let hasBareRequire = createRequireImportAliases.size > 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === 'punct' && t.value === '{') {
      const closeBrace = delims.brace[i] ?? -1;
      if (isDestructuringBraceContext(tokens, i, closeBrace, delims)) {
        const matches = extractDestructuredMatches(tokens, i, closeBrace, delims, REQUIRE_DESTRUCTURE_KEYS, resolveStaticStr, getTplTail());
        for (const m of matches) {
          hasBareRequire = true;
          if (m.localName) {
            if (m.key === 'createRequire') seedCreateRequireAliases.add(m.localName);
            else seedRequireAliases.add(m.localName);
          }
        }
      }
    }

    if (
      (t.kind === 'ident' && GLOBAL_REQUIRE_HOSTS.has(t.value) && !isMemberPrev(tokens, i)) ||
      (t.kind === 'punct' && t.value === '(')
    ) {
      if (matchHostNamedMember(tokens, i, GLOBAL_REQUIRE_HOSTS, 'require', delims, resolveStaticStr, getTplTail)) {
        hasBareRequire = true;
      } else if (
        nodeModuleNamespaces.size > 0 &&
        matchHostNamedMember(tokens, i, nodeModuleNamespaces, 'createRequire', delims, resolveStaticStr, getTplTail)
      ) {
        hasBareRequire = true;
      }
    }

    if (t.kind === 'ident' && (t.value === 'import' || t.value === 'require') && !isMemberPrev(tokens, i)) {
      const inlineCr = matchInlineModuleMemberCall(tokens, i, isNodeModuleSpecifier, 'createRequire', delims, resolveStaticStr);
      if (inlineCr && inlineCr.memberEndIdx !== null) {
        hasBareRequire = true;
      }
    }

    if (t.kind === 'ident' && t.value === 'createRequire' && !isMemberPrev(tokens, i)) {
      const prevPunct = tokens[i - 1]?.kind === 'punct' ? tokens[i - 1]!.value : '';
      const nextPunct = tokens[i + 1]?.kind === 'punct' ? tokens[i + 1]!.value : '';
      const isReadonlyProp = tokens[i - 1]?.kind === 'ident' && tokens[i - 1]?.value === 'readonly' && nextPunct === ':';
      if (!isReadonlyProp && !((prevPunct === '{' || prevPunct === ',' || prevPunct === ';') && nextPunct === ':')) {
        hasBareRequire = true;
      }
    }
    if (t.kind === 'ident' && t.value === 'require') {
      const isHostMember =
        isMemberPrev(tokens, i) &&
        tokens[i - 2]?.kind === 'ident' &&
        GLOBAL_REQUIRE_HOSTS.has(tokens[i - 2]!.value);
      const afterIdx = skipBangs(i + 1);
      const next = tokens[afterIdx];
      const isDirectParenCall =
        next?.kind === 'punct' &&
        (next.value === '(' || (next.value === '?.' && tokens[afterIdx + 1]?.kind === 'punct' && tokens[afterIdx + 1]?.value === '('));
      if (isHostMember) {
        hasBareRequire = true;
      } else if (!isMemberPrev(tokens, i) && !isDirectParenCall) {
        const prevTok = tokens[i - 1];
        const prevVal = prevTok?.kind === 'punct' ? prevTok.value : '';
        const isNewlineSepField =
          Boolean(prevTok) &&
          prevTok!.line < t.line &&
          prevVal !== '?' &&
          prevVal !== ':' &&
          !LOGICAL_OR_BRANCH_PUNCTS.has(prevVal);
        const isReadonlyKey = prevTok?.kind === 'ident' && prevTok.value === 'readonly';
        const isKeySep = isReadonlyKey || isNewlineSepField || prevVal === '{' || prevVal === ',' || prevVal === ';';
        const rawNext = tokens[i + 1];
        const nextIsColon =
          rawNext?.kind === 'punct' &&
          (rawNext.value === ':' || (rawNext.value === '?' && tokens[i + 2]?.kind === 'punct' && tokens[i + 2]?.value === ':'));
        if (!(isKeySep && nextIsColon)) {
          hasBareRequire = true;
        }
      }
    }

    if (t.kind !== 'punct' || t.value !== '=') continue;
    const lhsIdent = findAssignmentLhsIdent(tokens, i);
    if (!lhsIdent) continue;
    const { rhsNoAwait, rhs } = extractRhsInfo(i);

    // Check host-qualified `.require` / `['require']` and `nm.createRequire` BEFORE stripping `(` so `(globalThis)['require']` matches.
    const rawHostReq = matchHostNamedMember(tokens, rhsNoAwait, GLOBAL_REQUIRE_HOSTS, 'require', delims, resolveStaticStr, getTplTail);
    if (rawHostReq) {
      recordMemberRhs(lhsIdent, rawHostReq.endIdx, false);
      continue;
    }

    if (nodeModuleNamespaces.size > 0) {
      const modCr = matchHostNamedMember(tokens, rhsNoAwait, nodeModuleNamespaces, 'createRequire', delims, resolveStaticStr, getTplTail);
      if (modCr) {
        recordMemberRhs(lhsIdent, modCr.endIdx, true);
        continue;
      }
    }

    const rhsTok = tokens[rhs];
    if (!rhsTok || rhsTok.kind !== 'ident') continue;

    const hostReq = matchHostNamedMember(tokens, rhs, GLOBAL_REQUIRE_HOSTS, 'require', delims, resolveStaticStr, getTplTail);
    if (hostReq) {
      recordMemberRhs(lhsIdent, hostReq.endIdx, false);
      continue;
    }

    const afterRhsIdx = skipBangs(rhs + 1);
    const afterRhs = tokens[afterRhsIdx];
    const rhsEndLine = tokens[afterRhsIdx - 1]!.line;
    const isSimpleRhsEnd =
      !afterRhs ||
      afterRhs.line > rhsEndLine ||
      (afterRhs.kind === 'punct' && (afterRhs.value === ';' || afterRhs.value === ',' || afterRhs.value === ')' || afterRhs.value === '}')) ||
      (afterRhs.kind === 'ident' && (afterRhs.value === 'as' || afterRhs.value === 'satisfies'));

    if ((rhsTok.value === 'import' || rhsTok.value === 'require') && afterRhs?.kind === 'punct' && afterRhs.value === '(') {
      const inlineMatch = matchInlineModuleMemberCall(tokens, rhs, isNodeModuleSpecifier, 'createRequire', delims, resolveStaticStr);
      if (inlineMatch) {
        if (inlineMatch.memberEndIdx !== null) {
          hasBareRequire = true;
          recordMemberRhs(lhsIdent, inlineMatch.memberEndIdx, true);
        } else {
          dynamicNodeModuleNamespaces.add(lhsIdent);
        }
        continue;
      }
    }

    if (rhsTok.value === 'createRequire' || createRequireImportAliases.has(rhsTok.value)) {
      if (afterRhs?.kind === 'punct' && afterRhs.value === '(') {
        seedRequireAliases.add(lhsIdent);
        callAssignmentTarget.set(afterRhsIdx, lhsIdent);
      } else {
        seedCreateRequireAliases.add(lhsIdent);
        seedRequireAliases.add(lhsIdent);
      }
      continue;
    }

    if (rhsTok.value === 'require') {
      if (afterRhs?.kind === 'punct' && afterRhs.value === '(') {
        callAssignmentTarget.set(afterRhsIdx, lhsIdent);
      } else if (afterRhs?.kind === 'punct' && afterRhs.value === '?.' && tokens[afterRhsIdx + 1]?.kind === 'punct' && tokens[afterRhsIdx + 1]?.value === '(') {
        callAssignmentTarget.set(afterRhsIdx + 1, lhsIdent);
      } else if (afterRhs?.kind === 'punct' && afterRhs.value === '.' && tokens[afterRhsIdx + 1]?.kind === 'ident' && tokens[afterRhsIdx + 1]?.value === 'bind') {
        seedRequireAliases.add(lhsIdent);
      } else if (isSimpleRhsEnd) {
        seedRequireAliases.add(lhsIdent);
      }
      continue;
    }

    if (afterRhs?.kind === 'punct' && afterRhs.value === '(') {
      callAssignmentTarget.set(afterRhsIdx, lhsIdent);
      if (seedCreateRequireAliases.has(rhsTok.value)) seedRequireAliases.add(lhsIdent);
      continue;
    }
    if (afterRhs?.kind === 'punct' && afterRhs.value === '?.' && tokens[afterRhsIdx + 1]?.kind === 'punct' && tokens[afterRhsIdx + 1]?.value === '(') {
      callAssignmentTarget.set(afterRhsIdx + 1, lhsIdent);
      if (seedCreateRequireAliases.has(rhsTok.value)) seedRequireAliases.add(lhsIdent);
      continue;
    }
    if (isSimpleRhsEnd) {
      addAliasEdge(aliasEdges, rhsTok.value, lhsIdent);
    }
  }

  const requireHosts = propagateAliases(GLOBAL_REQUIRE_HOSTS, aliasEdges);
  const effectiveNodeModuleNamespaces = propagateAliases(
    new Set([...nodeModuleNamespaces, ...dynamicNodeModuleNamespaces]),
    aliasEdges,
  );
  const extraRequireHosts = new Set<string>();
  for (const h of requireHosts) {
    if (!GLOBAL_REQUIRE_HOSTS.has(h)) extraRequireHosts.add(h);
  }
  const extraNodeModuleNs = new Set<string>();
  for (const ns of effectiveNodeModuleNamespaces) {
    if (!nodeModuleNamespaces.has(ns)) extraNodeModuleNs.add(ns);
  }
  if (extraRequireHosts.size > 0 || extraNodeModuleNs.size > 0) {
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i]!;
      if (
        (t.kind === 'ident' && !isMemberPrev(tokens, i) && (extraRequireHosts.has(t.value) || extraNodeModuleNs.has(t.value))) ||
        (t.kind === 'punct' && t.value === '(')
      ) {
        if (extraRequireHosts.size > 0 && matchHostNamedMember(tokens, i, extraRequireHosts, 'require', delims, resolveStaticStr, getTplTail)) {
          hasBareRequire = true;
        } else if (
          extraNodeModuleNs.size > 0 &&
          matchHostNamedMember(tokens, i, extraNodeModuleNs, 'createRequire', delims, resolveStaticStr, getTplTail)
        ) {
          hasBareRequire = true;
        }
      }
      if (t.kind !== 'punct' || t.value !== '=') continue;
      const lhsIdent = findAssignmentLhsIdent(tokens, i);
      if (!lhsIdent) continue;
      const { rhsNoAwait, rhs } = extractRhsInfo(i);
      if (extraRequireHosts.size > 0) {
        const m =
          matchHostNamedMember(tokens, rhsNoAwait, extraRequireHosts, 'require', delims, resolveStaticStr, getTplTail) ??
          (rhs !== rhsNoAwait ? matchHostNamedMember(tokens, rhs, extraRequireHosts, 'require', delims, resolveStaticStr, getTplTail) : null);
        if (m) {
          recordMemberRhs(lhsIdent, m.endIdx, false);
          continue;
        }
      }
      if (extraNodeModuleNs.size > 0) {
        const m =
          matchHostNamedMember(tokens, rhsNoAwait, extraNodeModuleNs, 'createRequire', delims, resolveStaticStr, getTplTail) ??
          (rhs !== rhsNoAwait ? matchHostNamedMember(tokens, rhs, extraNodeModuleNs, 'createRequire', delims, resolveStaticStr, getTplTail) : null);
        if (m) {
          recordMemberRhs(lhsIdent, m.endIdx, true);
        }
      }
    }
  }

  const createRequireAliases = propagateAliases(seedCreateRequireAliases, aliasEdges);
  // Any call `mk(...)` where `mk` became a `createRequire` alias through chains produces a `require` alias.
  for (const [openParenIdx, target] of callAssignmentTarget) {
    let calleeIdx = openParenIdx - 1;
    while (calleeIdx > 0 && tokens[calleeIdx]?.kind === 'punct' && tokens[calleeIdx]?.value === '!') calleeIdx -= 1;
    const callee = tokens[calleeIdx];
    if (callee?.kind === 'ident' && createRequireAliases.has(callee.value)) {
      seedRequireAliases.add(target);
    }
  }
  const requireAliases = propagateAliases(seedRequireAliases, aliasEdges);
  return {
    requireAliases,
    hasBareRequire,
    aliasEdges,
    callAssignmentTarget,
    createRequireAliases,
    nodeModuleNamespaces: effectiveNodeModuleNamespaces,
    requireHosts,
  };
}

function scanModuleTokens(tokens: readonly Token[], delimsInput?: DelimiterPairs): ModuleScanResult {
  const delims = delimsInput ?? pairDelimiters(tokens);
  let lazyTplMaps: ReturnType<typeof buildTemplateMaps> | null = null;
  let lazyScoped: ReturnType<typeof collectScopedConstBindings> | null = null;
  const ensureTplMaps = () => {
    if (!lazyTplMaps) lazyTplMaps = buildTemplateMaps(tokens);
    return lazyTplMaps;
  };
  const getTplTail = () => ensureTplMaps().templateTail;
  const resolveStaticStr = (s: number, e: number): string | null => {
    const maps = ensureTplMaps();
    return tryResolveConstantStringExpr(
      tokens,
      s,
      e,
      delims,
      maps.templateNext,
      (name, idx) => {
        if (!lazyScoped) lazyScoped = collectScopedConstBindings(tokens, delims, maps.templateNext, maps.templateTail);
        return lookupScopedConst(lazyScoped.scopes, lazyScoped.tokenScope[idx] ?? 0, name);
      },
      0,
      maps.templateTail,
    );
  };

  const {
    requireAliases,
    hasBareRequire: initialBareRequire,
    aliasEdges,
    callAssignmentTarget,
    createRequireAliases,
    nodeModuleNamespaces,
    requireHosts,
  } = analyzeTokenAliases(tokens, delims, resolveStaticStr, getTplTail);
  const specs: string[] = [];
  const importDecls: ModuleScanResult['importDecls'] = [];
  const exportDecls: ModuleScanResult['exportDecls'] = [];
  const dynamicCalls: ModuleScanResult['dynamicCalls'] = [];
  let hasComputedDynamic = false;
  let hasBareRequire = initialBareRequire;
  let hasInvalidSyntax = false;

  const findCallParenAfter = (startIdx: number): number => {
    let idx = startIdx;
    while (tokens[idx]?.kind === 'punct' && tokens[idx]?.value === '!') idx += 1;
    const tok = tokens[idx];
    if (tok?.kind === 'punct' && tok.value === '(') return idx;
    if (tok?.kind === 'punct' && tok.value === '?.' && tokens[idx + 1]?.kind === 'punct' && tokens[idx + 1]?.value === '(') {
      return idx + 1;
    }
    return -1;
  };

  const recordDynamicCall = (fn: 'import' | 'require', openParenIdx: number): void => {
    const call = scanBalancedParenArg(tokens, openParenIdx, delims.paren);
    const resolved = call.singleStringSpec ?? call.foldedStringSpec;
    dynamicCalls.push({
      fn,
      specifier: resolved,
      argSnippet: call.argSnippet,
      boundTarget: callAssignmentTarget.get(openParenIdx) ?? null,
      closeParenIdx: delims.paren[openParenIdx] ?? -1,
    });
    if (call.singleStringSpec !== null) specs.push(call.singleStringSpec);
    else {
      hasComputedDynamic = true;
      if (call.foldedStringSpec !== null) specs.push(call.foldedStringSpec);
    }
  };

  const recordCreateRequireDirectCall = (openCreateParen: number): void => {
    const close1 = delims.paren[openCreateParen] ?? -1;
    if (close1 <= openCreateParen) return;
    const secondCallParen = findCallParenAfter(close1 + 1);
    if (secondCallParen >= 0) {
      hasBareRequire = true;
      recordDynamicCall('require', secondCallParen);
    }
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === 'invalid') {
      hasInvalidSyntax = true;
      continue;
    }

    if (
      (t.kind === 'ident' && !isMemberPrev(tokens, i) && (requireHosts.has(t.value) || nodeModuleNamespaces.has(t.value))) ||
      (t.kind === 'punct' && t.value === '(')
    ) {
      const hostReq = matchHostNamedMember(tokens, i, requireHosts, 'require', delims, resolveStaticStr, getTplTail);
      if (hostReq) {
        hasBareRequire = true;
        const callParen = findCallParenAfter(hostReq.endIdx + 1);
        if (callParen >= 0) recordDynamicCall('require', callParen);
        continue;
      }
      if (nodeModuleNamespaces.size > 0) {
        const modCr = matchHostNamedMember(tokens, i, nodeModuleNamespaces, 'createRequire', delims, resolveStaticStr, getTplTail);
        if (modCr) {
          hasBareRequire = true;
          const open1 = findCallParenAfter(modCr.endIdx + 1);
          if (open1 >= 0) recordCreateRequireDirectCall(open1);
          continue;
        }
      }
    }

    if (t.kind === 'ident' && !isMemberPrev(tokens, i) && (t.value === 'import' || t.value === 'require')) {
      const inlineModCr = matchInlineModuleMemberCall(tokens, i, isNodeModuleSpecifier, 'createRequire', delims, resolveStaticStr);
      if (inlineModCr && inlineModCr.memberEndIdx !== null) {
        hasBareRequire = true;
        const open1 = findCallParenAfter(inlineModCr.memberEndIdx + 1);
        if (open1 >= 0) recordCreateRequireDirectCall(open1);
      }
    }

    if (t.kind !== 'ident') continue;

    if (isMemberPrev(tokens, i)) continue;

    if (t.value === 'import') {
      const next = tokens[i + 1];
      if (!next) continue;
      if (next.kind === 'punct' && next.value === '(') {
        recordDynamicCall('import', i + 1);
        continue;
      }
      if (next.kind === 'string' || next.kind === 'template') {
        specs.push(next.value);
        importDecls.push({ specifier: next.value, isNamespace: false, isDefault: false, isSideEffect: true, barrelBindings: [] });
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
      const barrelBindings: string[] = [];
      if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '*') {
        isNamespace = true;
        if (tokens[p + 1]?.kind === 'ident' && tokens[p + 1]?.value === 'as' && tokens[p + 2]?.kind === 'ident') {
          barrelBindings.push(tokens[p + 2]!.value);
        }
      } else if (tokens[p]?.kind === 'ident' && !isFromKeywordAt(tokens, p)) {
        isDefault = true;
        barrelBindings.push(tokens[p]!.value);
      }

      while (p < tokens.length) {
        const cur = tokens[p]!;
        if (cur.kind === 'punct') {
          if (cur.value === '{') {
            const close = delims.brace[p] ?? -1;
            if (close < 0) break;
            for (let m = p + 1; m + 2 < close; m += 1) {
              const item = tokens[m]!;
              if (
                (item.kind === 'ident' || item.kind === 'string') &&
                item.value === 'default' &&
                tokens[m + 1]?.kind === 'ident' &&
                tokens[m + 1]?.value === 'as' &&
                tokens[m + 2]?.kind === 'ident'
              ) {
                isDefault = true;
                barrelBindings.push(tokens[m + 2]!.value);
              }
            }
            p = close + 1;
            continue;
          }
          if (cur.value === ';' || cur.value === '=>') break;
          if (cur.value === '*') {
            isNamespace = true;
            if (tokens[p + 1]?.kind === 'ident' && tokens[p + 1]?.value === 'as' && tokens[p + 2]?.kind === 'ident') {
              barrelBindings.push(tokens[p + 2]!.value);
            }
          }
        } else if (cur.kind === 'ident') {
          if (isFromKeywordAt(tokens, p)) {
            const specTok = tokens[p + 1];
            if (specTok && (specTok.kind === 'string' || specTok.kind === 'template')) {
              specs.push(specTok.value);
              importDecls.push({ specifier: specTok.value, isNamespace, isDefault, isSideEffect: false, barrelBindings });
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

    const isFnDecl = tokens[i - 1]?.kind === 'ident' && tokens[i - 1]?.value === 'function';
    if (!isFnDecl && createRequireAliases.has(t.value)) {
      const open1 = findCallParenAfter(i + 1);
      if (open1 >= 0) recordCreateRequireDirectCall(open1);
      continue;
    }

    const isRequireAliasCall = t.value !== 'require' && requireAliases.has(t.value);
    if ((t.value === 'require' || isRequireAliasCall) && !isFnDecl) {
      const openParenIdx = findCallParenAfter(i + 1);
      if (openParenIdx >= 0) {
        if (isRequireAliasCall) hasBareRequire = true;
        recordDynamicCall('require', openParenIdx);
      }
    }
  }

  return { specifiers: specs, hasComputedDynamic, hasBareRequire, hasInvalidSyntax, importDecls, exportDecls, dynamicCalls, aliasEdges };
}

function specifiers(
  text: string,
  precomputedTokens?: readonly Token[],
  precomputedDelims?: DelimiterPairs,
): { specifiers: string[]; scan: ModuleScanResult } {
  const scan = scanModuleTokens(precomputedTokens ?? tokenize(text), precomputedDelims);
  const rawMain = linearRawSpecifiers(text);
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
const BANNED_IMPORT = /^(?:node:(?:https?|http2|net|tls|dgram)$|https?$|undici$|axios$|@ludy\/(?:kernel|kernel-runtime|kernel-contract|db|mod-[a-z-]+)(?:\/|$)|kysely$|pg$|ai$|@ai-sdk\/|openai$|@anthropic-ai\/|mem0|@mem0\/|zep|@getzep\/|langchain|@langchain\/)/;

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
  if (scan.hasBareRequire) out.add('uses require alias or bare require reference');
  if (assertSyntax && scan.hasInvalidSyntax) out.add('contains invalid or unclosed syntax');

  const commandRe = /^((?:kernel|notes|meetings|finance|crm|hr|social|projects|calendar|desk)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)$/;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind === 'string' || tok.kind === 'template') {
      const m = commandRe.exec(tok.value);
      if (m?.[1]) out.add(`names the command or path ${m[1]}`);
      if (/\b(?:crove|ludy)_[a-z]+\./.test(tok.value)) out.add('names a crove_ table');
    } else if (tok.kind === 'ident') {
      if (/^(?:crove|ludy)_[a-z]+$/.test(tok.value)) out.add('names a crove_ table');
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
  if (/\b(?:crove|ludy)_[a-z]+\./.test(text)) out.add('names a crove_ table');
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
  if (scan.hasBareRequire) out.add('uses require alias or bare require reference');
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
const ADAPTER_FUNCTION_NOTES_KEYS = new Map<string, string>([
  ['generateNoteSummaryText', 'notes.summary'],
  ['generateTodoSuggestText', 'notes.todo_suggest'],
  ['generateTodoPlanText', 'notes.todo_plan'],
  ['generateNoteOrganizeText', 'notes.organize'],
]);
const ADAPTER_NOTES_KEYS = new Set(ADAPTER_FUNCTION_NOTES_KEYS.values());
const ADAPTER_NOTE_IMPORT_RE = /(?:^|\/)note-ai-model(?:\.[cm]?[jt]s)?$/;
const isNoteAiModelSpecifier = (spec: string): boolean => ADAPTER_NOTE_IMPORT_RE.test(normalizeModuleSpecifier(spec));
const DEFAULT_ADAPTER_EXPORTS: readonly string[] = [...ADAPTER_FUNCTION_NOTES_KEYS.keys()];

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

function buildTemplateMaps(tokens: readonly Token[]): { templateTail: Int32Array; templateNext: Int32Array } {
  const templateTail = new Int32Array(tokens.length).fill(-1);
  const templateNext = new Int32Array(tokens.length).fill(-1);
  const tailStack: number[] = [];
  const nextStack: number[] = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const tk = tokens[k]!;
    if (tk.kind === 'template_head') {
      tailStack.push(k);
      nextStack.push(k);
    } else if (tk.kind === 'template_middle') {
      if (nextStack.length > 0) templateNext[nextStack.pop()!] = k;
      nextStack.push(k);
    } else if (tk.kind === 'template_tail') {
      if (tailStack.length > 0) templateTail[tailStack.pop()!] = k;
      if (nextStack.length > 0) templateNext[nextStack.pop()!] = k;
    }
  }
  return { templateTail, templateNext };
}

function stripOuterParens(
  tokens: readonly Token[],
  start: number,
  end: number,
  delims: DelimiterPairs,
): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s + 1 < e && tokens[s]?.kind === 'punct' && tokens[s]?.value === '(' && delims.paren[s] === e - 1) {
    s += 1;
    e -= 1;
  }
  return { start: s, end: e };
}

function normalizeValueExprSpan(
  tokens: readonly Token[],
  start: number,
  end: number,
  delims: DelimiterPairs,
  templateTail?: Int32Array,
): { start: number; end: number } {
  let s = start;
  let e = end;
  for (let pass = 0; pass < 8; pass += 1) {
    const parenTrim = stripOuterParens(tokens, s, e, delims);
    s = parenTrim.start;
    e = parenTrim.end;
    if (s >= e) break;
    let changed = false;
    while (e > s && tokens[e - 1]?.kind === 'punct' && tokens[e - 1]?.value === '!') {
      e -= 1;
      changed = true;
    }
    let td = 0;
    for (let idx = s; idx < e; idx += 1) {
      const tk = tokens[idx]!;
      if (tk.kind === 'template_head') {
        if (templateTail) {
          const tl = templateTail[idx] ?? -1;
          if (tl > idx && tl < e) {
            idx = tl;
            continue;
          }
          break;
        }
        td += 1;
      } else if (tk.kind === 'template_tail' && td > 0) {
        td -= 1;
      } else if (td === 0 && tk.kind === 'punct') {
        if (tk.value === '(') {
          const cl = delims.paren[idx] ?? -1;
          if (cl > idx && cl < e) {
            idx = cl;
            continue;
          }
          break;
        }
        if (tk.value === '[') {
          const cl = delims.bracket[idx] ?? -1;
          if (cl > idx && cl < e) {
            idx = cl;
            continue;
          }
          break;
        }
        if (tk.value === '{') {
          const cl = delims.brace[idx] ?? -1;
          if (cl > idx && cl < e) {
            idx = cl;
            continue;
          }
          break;
        }
      } else if (td === 0 && tk.kind === 'ident' && (tk.value === 'as' || tk.value === 'satisfies') && idx > s) {
        e = idx;
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return { start: s, end: e };
}

const LOGICAL_OR_BRANCH_PUNCTS = new Set(['&&', '||', '??']);
const NON_CONCAT_INFIX_PUNCTS = new Set([
  ',',
  '=',
  '&&=',
  '||=',
  '??=',
  '?',
  ':',
  '&&',
  '||',
  '??',
  '|',
  '^',
  '&',
  '==',
  '===',
  '!=',
  '!==',
  '<',
  '<=',
  '>',
  '<<',
  '>>',
  '>>>',
]);
const NON_CONCAT_INFIX_KEYWORDS = new Set(['in', 'instanceof']);

function hasLowPrecedenceInfixAtDepth0(tokens: readonly Token[], start: number, end: number): boolean {
  let pd = 0;
  let bd = 0;
  let cd = 0;
  let td = 0;
  for (let idx = start; idx < end; idx += 1) {
    const tk = tokens[idx]!;
    if (tk.kind === 'template_head') td += 1;
    else if (tk.kind === 'template_tail' && td > 0) td -= 1;
    else if (tk.kind === 'punct') {
      if (tk.value === '(') pd += 1;
      else if (tk.value === ')' && pd > 0) pd -= 1;
      else if (tk.value === '[') bd += 1;
      else if (tk.value === ']' && bd > 0) bd -= 1;
      else if (tk.value === '{') cd += 1;
      else if (tk.value === '}' && cd > 0) cd -= 1;
      else if (pd === 0 && bd === 0 && cd === 0 && td === 0 && NON_CONCAT_INFIX_PUNCTS.has(tk.value)) {
        return true;
      }
    } else if (pd === 0 && bd === 0 && cd === 0 && td === 0 && tk.kind === 'ident' && NON_CONCAT_INFIX_KEYWORDS.has(tk.value)) {
      return true;
    }
  }
  return false;
}

type ConstLookupFn = (name: string, identIdx: number) => string | null;

function tryResolveConstantStringExpr(
  tokens: readonly Token[],
  start: number,
  end: number,
  delims: DelimiterPairs,
  templateNext: Int32Array,
  constLookup: ConstLookupFn,
  depth = 0,
  templateTail?: Int32Array,
): string | null {
  if (depth > 16 || start >= end || end - start > 128) return null;
  const trimmed = normalizeValueExprSpan(tokens, start, end, delims, templateTail);
  const s = trimmed.start;
  const e = trimmed.end;
  if (s >= e) return null;

  const termRanges: Array<{ start: number; end: number }> = [];
  let termStart = s;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let tplDepth = 0;

  for (let idx = s; idx < e; idx += 1) {
    const tok = tokens[idx]!;
    if (tok.kind === 'template_head') tplDepth += 1;
    else if (tok.kind === 'template_tail' && tplDepth > 0) tplDepth -= 1;
    else if (tok.kind === 'punct') {
      if (tok.value === '(') parenDepth += 1;
      else if (tok.value === ')' && parenDepth > 0) parenDepth -= 1;
      else if (tok.value === '[') bracketDepth += 1;
      else if (tok.value === ']' && bracketDepth > 0) bracketDepth -= 1;
      else if (tok.value === '{') braceDepth += 1;
      else if (tok.value === '}' && braceDepth > 0) braceDepth -= 1;
      else if (tok.value === '+' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && tplDepth === 0) {
        if (idx === termStart) return null;
        termRanges.push({ start: termStart, end: idx });
        termStart = idx + 1;
      }
    }
  }
  if (termStart >= e) return null;
  termRanges.push({ start: termStart, end: e });

  if (termRanges.length > 1) {
    const parts: string[] = [];
    for (const r of termRanges) {
      const part = tryResolveConstantStringExpr(tokens, r.start, r.end, delims, templateNext, constLookup, depth + 1, templateTail);
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join('');
  }

  if (e - s === 1) {
    const only = tokens[s]!;
    if (only.kind === 'string' || only.kind === 'template') return only.value;
    if (only.kind === 'ident') return constLookup(only.value, s);
    return null;
  }

  const head = tokens[s]!;
  const tail = tokens[e - 1]!;
  if (head.kind === 'template_head' && tail.kind === 'template_tail') {
    const parts: string[] = [head.value];
    let cur = s;
    let steps = 0;
    while (cur >= 0 && cur < e - 1 && steps < 32) {
      steps += 1;
      const next = templateNext[cur] ?? -1;
      if (next <= cur || next >= e) return null;
      const exprVal = tryResolveConstantStringExpr(tokens, cur + 1, next, delims, templateNext, constLookup, depth + 1, templateTail);
      if (exprVal === null) return null;
      parts.push(exprVal);
      const nextTok = tokens[next]!;
      parts.push(nextTok.value);
      if (nextTok.kind === 'template_tail') {
        return next === e - 1 ? parts.join('') : null;
      }
      cur = next;
    }
  }
  return null;
}

function constantLeadingPrefix(
  tokens: readonly Token[],
  start: number,
  end: number,
  delims: DelimiterPairs,
  templateNext: Int32Array,
  constLookup: ConstLookupFn,
  templateTail?: Int32Array,
): string {
  const { start: s, end: e } = normalizeValueExprSpan(tokens, start, Math.min(end, start + 128), delims, templateTail);
  if (s >= e || hasLowPrecedenceInfixAtDepth0(tokens, s, e)) return '';
  const parts: string[] = [];
  let idx = s;
  let steps = 0;
  while (idx < e && steps < 16) {
    steps += 1;
    let termEnd = idx;
    let pd = 0;
    let bd = 0;
    let cd = 0;
    let td = 0;
    while (termEnd < e) {
      const tk = tokens[termEnd]!;
      if (tk.kind === 'template_head') td += 1;
      else if (tk.kind === 'template_tail' && td > 0) td -= 1;
      else if (tk.kind === 'punct') {
        if (tk.value === '(') pd += 1;
        else if (tk.value === ')' && pd > 0) pd -= 1;
        else if (tk.value === '[') bd += 1;
        else if (tk.value === ']' && bd > 0) bd -= 1;
        else if (tk.value === '{') cd += 1;
        else if (tk.value === '}' && cd > 0) cd -= 1;
        else if (tk.value === '+' && pd === 0 && bd === 0 && cd === 0 && td === 0) break;
      }
      termEnd += 1;
    }
    const resolved = tryResolveConstantStringExpr(tokens, idx, termEnd, delims, templateNext, constLookup, 1, templateTail);
    if (resolved !== null) {
      parts.push(resolved);
      if (termEnd < e && tokens[termEnd]?.kind === 'punct' && tokens[termEnd]?.value === '+') {
        idx = termEnd + 1;
        continue;
      }
      break;
    }
    const first = normalizeValueExprSpan(tokens, idx, termEnd, delims, templateTail);
    const firstTok = tokens[first.start];
    if (firstTok?.kind === 'template_head' && (templateTail?.[first.start] ?? -1) === first.end - 1) {
      parts.push(firstTok.value);
    }
    break;
  }
  return parts.join('');
}

interface LexScope {
  parent: number;
  bindings: Map<string, string | null>;
}

function lookupScopedConst(scopes: readonly LexScope[], scopeIdx: number, name: string): string | null {
  let cur = scopeIdx;
  let hops = 0;
  while (cur >= 0 && hops < 64) {
    hops += 1;
    const scope = scopes[cur]!;
    if (scope.bindings.has(name)) {
      return scope.bindings.get(name) ?? null;
    }
    cur = scope.parent;
  }
  return null;
}

function invalidateScopedBinding(scopes: readonly LexScope[], scopeIdx: number, name: string): void {
  let cur = scopeIdx;
  let hops = 0;
  while (cur >= 0 && hops < 64) {
    hops += 1;
    const scope = scopes[cur]!;
    if (scope.bindings.has(name)) {
      scope.bindings.set(name, null);
      return;
    }
    cur = scope.parent;
  }
  scopes[scopeIdx]!.bindings.set(name, null);
}

const PARAM_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'override']);

function collectPatternIdents(
  tokens: readonly Token[],
  start: number,
  end: number,
  delims: DelimiterPairs,
  out: string[],
  inObject = false,
  templateTail?: Int32Array,
  depth = 0,
): void {
  if (depth > 32) return;
  let p = start;
  while (p < end) {
    const tk = tokens[p]!;
    if (tk.kind === 'template_head') {
      if (templateTail) {
        const tl = templateTail[p] ?? -1;
        if (tl > p && tl < end) {
          p = tl + 1;
          continue;
        }
      }
      break;
    }
    if (tk.kind === 'punct') {
      if (tk.value === '...') {
        p += 1;
        continue;
      }
      if (tk.value === '(') {
        const close = delims.paren[p] ?? -1;
        if (close > p && close < end) {
          p = close + 1;
          continue;
        }
      } else if (tk.value === '{') {
        const close = delims.brace[p] ?? -1;
        if (close > p && close < end) {
          collectPatternIdents(tokens, p + 1, close, delims, out, true, templateTail, depth + 1);
          p = close + 1;
          continue;
        }
      } else if (tk.value === '[') {
        const close = delims.bracket[p] ?? -1;
        if (close > p && close < end) {
          collectPatternIdents(tokens, p + 1, close, delims, out, false, templateTail, depth + 1);
          p = close + 1;
          continue;
        }
      } else if (tk.value === '=' || tk.value === ':') {
        const trackAngles = tk.value === ':';
        // Jump balanced `(...)`, `[...]`, `{...}`, and `` `${...}` `` in O(1) via `delims` / `templateTail` so nested default params stay O(N).
        p += 1;
        let ad = 0;
        while (p < end) {
          const cur = tokens[p]!;
          if (cur.kind === 'template_head') {
            if (templateTail) {
              const tl = templateTail[p] ?? -1;
              if (tl > p && tl < end) {
                p = tl + 1;
                continue;
              }
            }
            break;
          }
          if (cur.kind === 'punct') {
            if (cur.value === '(') {
              const cl = delims.paren[p] ?? -1;
              if (cl > p && cl < end) {
                p = cl + 1;
                continue;
              }
              break;
            }
            if (cur.value === '[') {
              const cl = delims.bracket[p] ?? -1;
              if (cl > p && cl < end) {
                p = cl + 1;
                continue;
              }
              break;
            }
            if (cur.value === '{') {
              const cl = delims.brace[p] ?? -1;
              if (cl > p && cl < end) {
                p = cl + 1;
                continue;
              }
              break;
            }
            if (trackAngles && cur.value === '<') ad += 1;
            else if (trackAngles && cur.value === '>' && ad > 0) ad -= 1;
            else if (ad === 0 && cur.value === ',') break;
          }
          p += 1;
        }
        p += 1;
        continue;
      }
      p += 1;
      continue;
    }
    if (tk.kind === 'ident') {
      if (!inObject && PARAM_MODIFIERS.has(tk.value) && tokens[p + 1]?.kind === 'ident') {
        p += 1;
        continue;
      }
      if (inObject && tokens[p + 1]?.kind === 'punct' && tokens[p + 1]?.value === ':') {
        // Property key `prop: localBinding`
        p += 2;
        if (tokens[p]?.kind === 'ident') {
          out.push(tokens[p]!.value);
          p += 1;
        }
        continue;
      }
      out.push(tk.value);
    }
    p += 1;
  }
}

const SKIP_DECL_STOP_KW = new Set(['const', 'let', 'var', 'function', 'class', 'return', 'if', 'for', 'while', 'export', 'import']);
const LINE_CONT_PUNCTS = new Set(['+', '=', '(', '&&', '||', '??', '?', ':']);

function findTypeDeclStop(tokens: readonly Token[], start: number, maxLookahead = 128): number {
  let p = start;
  let td = 0;
  let ad = 0;
  const limit = Math.min(tokens.length, start + maxLookahead);
  while (p < limit) {
    const cur = tokens[p]!;
    if (cur.kind === 'punct') {
      if (cur.value === '(' || cur.value === '[' || cur.value === '{') td += 1;
      else if ((cur.value === ')' || cur.value === ']' || cur.value === '}') && td > 0) td -= 1;
      else if (cur.value === '<') ad += 1;
      else if (cur.value === '>' && ad > 0) ad -= 1;
      else if (td === 0 && ad === 0 && (cur.value === '=' || cur.value === ';' || cur.value === ',' || cur.value === '}' || cur.value === ')')) {
        return p;
      }
    } else if (td === 0 && ad === 0 && cur.kind === 'ident' && SKIP_DECL_STOP_KW.has(cur.value)) {
      return p;
    }
    p += 1;
  }
  return p;
}

function findDeclInitEnd(tokens: readonly Token[], exprStart: number, maxLookahead = 128): { endIdx: number; truncated: boolean } {
  let q = exprStart;
  let pd = 0;
  let bd = 0;
  let cd = 0;
  let td = 0;
  let lastLine = tokens[exprStart - 1]?.line ?? (tokens[exprStart]?.line ?? 1);
  let prevTok: Token | undefined = tokens[exprStart - 1];
  const limit = Math.min(tokens.length, exprStart + maxLookahead);
  while (q < limit) {
    const cur = tokens[q]!;
    if (pd === 0 && bd === 0 && cd === 0 && td === 0 && cur.line > lastLine) {
      const prevCont = prevTok?.kind === 'punct' && LINE_CONT_PUNCTS.has(prevTok.value);
      const nextCont =
        (cur.kind === 'punct' && (cur.value === '+' || cur.value === '&&' || cur.value === '||' || cur.value === '??')) ||
        (cur.kind === 'ident' && (cur.value === 'as' || cur.value === 'satisfies'));
      if (!prevCont && !nextCont) return { endIdx: q, truncated: false };
    }
    if (cur.kind === 'template_head') td += 1;
    else if (cur.kind === 'template_tail' && td > 0) td -= 1;
    else if (cur.kind === 'punct') {
      if (cur.value === '(') pd += 1;
      else if (cur.value === ')') {
        if (pd === 0 && bd === 0 && cd === 0 && td === 0) return { endIdx: q, truncated: false };
        if (pd > 0) pd -= 1;
      } else if (cur.value === '[') bd += 1;
      else if (cur.value === ']') {
        if (bd === 0 && pd === 0 && cd === 0 && td === 0) return { endIdx: q, truncated: false };
        if (bd > 0) bd -= 1;
      } else if (cur.value === '{') cd += 1;
      else if (cur.value === '}') {
        if (cd === 0 && pd === 0 && bd === 0 && td === 0) return { endIdx: q, truncated: false };
        if (cd > 0) cd -= 1;
      } else if (pd === 0 && bd === 0 && cd === 0 && td === 0 && (cur.value === ',' || cur.value === ';')) {
        return { endIdx: q, truncated: false };
      }
    } else if (
      pd === 0 &&
      bd === 0 &&
      cd === 0 &&
      td === 0 &&
      cur.kind === 'ident' &&
      SKIP_DECL_STOP_KW.has(cur.value) &&
      !(cur.value === 'const' && prevTok?.kind === 'ident' && prevTok.value === 'as')
    ) {
      return { endIdx: q, truncated: false };
    }
    prevTok = cur;
    lastLine = cur.line;
    q += 1;
  }
  return { endIdx: q, truncated: q >= exprStart + maxLookahead && q < tokens.length };
}

function findFnParamBodyTarget(
  tokens: readonly Token[],
  openParen: number,
  closeParen: number,
  delims: DelimiterPairs,
): { targetKind: 'brace' | 'concise'; targetIdx: number } | null {
  const prev = tokens[openParen - 1];
  if (prev?.kind === 'ident' && prev.value === 'catch') {
    return tokens[closeParen + 1]?.kind === 'punct' && tokens[closeParen + 1]?.value === '{'
      ? { targetKind: 'brace', targetIdx: closeParen + 1 }
      : null;
  }
  if (prev?.kind === 'ident' && NON_PARAM_PARENS.has(prev.value)) return null;
  const p = tokens[closeParen + 1]?.kind === 'punct' && tokens[closeParen + 1]?.value === ':'
    ? skipOptionalTypeForward(tokens, closeParen + 1, delims)
    : closeParen + 1;
  const next = tokens[p];
  if (next?.kind === 'punct' && next.value === '=>') {
    const body = tokens[p + 1];
    if (body?.kind === 'punct' && body.value === '{') return { targetKind: 'brace', targetIdx: p + 1 };
    return { targetKind: 'concise', targetIdx: p + 1 };
  }
  if (next?.kind === 'punct' && next.value === '{' && !isMemberPrev(tokens, openParen)) {
    const fnBefore = findFnDeclHeadBeforeParen(tokens, openParen);
    if (
      (fnBefore?.kind === 'ident' && !NON_PARAM_PARENS.has(fnBefore.value) && !CONTROL_KEYWORDS.has(fnBefore.value)) ||
      (fnBefore?.kind === 'punct' && fnBefore.value === '*')
    ) {
      return { targetKind: 'brace', targetIdx: p };
    }
  }
  return null;
}

const STMT_PREV_OPENERS = new Set(['(', '[', ',', '.', '?.', ':', '?', '=', '+', '-', '*', '/', '%', '&&', '||', '??', '=>', '!']);
const STMT_NEXT_CONT = new Set(['.', '?.', '(', '[', ',', '?', ':', '&&', '||', '??', '+', '-', '*', '/', '%', '===', '!==', '==', '!=']);
const STMT_HEADER_KW = new Set(['if', 'else', 'for', 'while', 'do', 'await']);

function findBracelessStatementEnd(
  tokens: readonly Token[],
  startIdx: number,
  delims: DelimiterPairs,
  templateTail?: Int32Array,
): number {
  let pd = 0;
  let bd = 0;
  let cd = 0;
  let td = 0;
  let openIfs = 0;
  let headerEndIdx = -1;
  const limit = Math.min(tokens.length, startIdx + 256);
  for (let p = startIdx; p < limit; p += 1) {
    const tk = tokens[p]!;
    if (pd === 0 && bd === 0 && cd === 0 && td === 0 && p > startIdx) {
      const prev = tokens[p - 1]!;
      const prevContinues =
        p - 1 === headerEndIdx ||
        (prev.kind === 'punct' && STMT_PREV_OPENERS.has(prev.value)) ||
        (prev.kind === 'ident' && STMT_HEADER_KW.has(prev.value));
      const nextContinues = tk.kind === 'punct' && STMT_NEXT_CONT.has(tk.value);
      if (tk.line > prev.line && !prevContinues && !nextContinues && !(tk.kind === 'ident' && tk.value === 'else')) {
        return p;
      }
    }
    if (pd === 0 && bd === 0 && cd === 0 && td === 0 && tk.kind === 'ident' && !isMemberPrev(tokens, p)) {
      if (tk.value === 'if' || tk.value === 'while' || tk.value === 'for') {
        const parenIdx =
          tk.value === 'for' && tokens[p + 1]?.kind === 'ident' && tokens[p + 1]?.value === 'await' ? p + 2 : p + 1;
        const parenTok = tokens[parenIdx];
        if (parenTok?.kind === 'punct' && parenTok.value === '(') {
          const closeParen = delims.paren[parenIdx] ?? -1;
          if (closeParen > parenIdx && closeParen < limit) {
            if (tk.value === 'if') openIfs += 1;
            headerEndIdx = closeParen;
            p = closeParen;
            continue;
          }
        }
      } else if (tk.value === 'else') {
        if (openIfs > 0) openIfs -= 1;
        headerEndIdx = p;
        continue;
      }
    }
    if (tk.kind === 'template_head') {
      const tail = templateTail?.[p] ?? -1;
      if (tail > p && tail < limit) {
        p = tail;
        continue;
      }
      td += 1;
    } else if (tk.kind === 'template_tail' && td > 0) {
      td -= 1;
    } else if (tk.kind === 'punct') {
      if (tk.value === '(') pd += 1;
      else if (tk.value === ')') {
        if (pd === 0 && bd === 0 && cd === 0 && td === 0) return p;
        if (pd > 0) pd -= 1;
      } else if (tk.value === '[') bd += 1;
      else if (tk.value === ']') {
        if (pd === 0 && bd === 0 && cd === 0 && td === 0) return p;
        if (bd > 0) bd -= 1;
      } else if (tk.value === '{') {
        const prevTok = tokens[p - 1];
        const isExprBrace =
          (prevTok?.kind === 'punct' && STMT_PREV_OPENERS.has(prevTok.value) && prevTok.value !== ':') ||
          (prevTok?.kind === 'ident' &&
            (prevTok.value === 'return' ||
              prevTok.value === 'throw' ||
              prevTok.value === 'yield' ||
              prevTok.value === 'await' ||
              prevTok.value === 'default'));
        if (pd === 0 && bd === 0 && cd === 0 && td === 0 && !isExprBrace) {
          const closeBrace = delims.brace[p] ?? -1;
          if (closeBrace > p) {
            const after = tokens[closeBrace + 1];
            if (after?.kind === 'ident' && after.value === 'else') {
              p = closeBrace;
              continue;
            }
            return closeBrace + 1;
          }
        }
        cd += 1;
      } else if (tk.value === '}') {
        if (pd === 0 && bd === 0 && cd === 0 && td === 0) return p;
        if (cd > 0) cd -= 1;
      } else if (tk.value === ';' && pd === 0 && bd === 0 && cd === 0 && td === 0) {
        if (openIfs > 0 && tokens[p + 1]?.kind === 'ident' && tokens[p + 1]?.value === 'else') {
          continue;
        }
        return p;
      }
    }
  }
  return limit;
}

function findConciseArrowEnd(tokens: readonly Token[], bodyStart: number): number {
  let pd = 0;
  let bd = 0;
  let cd = 0;
  let td = 0;
  const limit = Math.min(tokens.length, bodyStart + 256);
  for (let p = bodyStart; p < limit; p += 1) {
    const tk = tokens[p]!;
    if (tk.kind === 'template_head') td += 1;
    else if (tk.kind === 'template_tail' && td > 0) td -= 1;
    else if (tk.kind === 'punct') {
      if (tk.value === '(') pd += 1;
      else if (tk.value === '[') bd += 1;
      else if (tk.value === '{') cd += 1;
      else if (tk.value === ')') {
        if (pd === 0 && bd === 0 && cd === 0 && td === 0) return p;
        pd -= 1;
      } else if (tk.value === ']') {
        if (pd === 0 && bd === 0 && cd === 0 && td === 0) return p;
        bd -= 1;
      } else if (tk.value === '}') {
        if (pd === 0 && bd === 0 && cd === 0 && td === 0) return p;
        cd -= 1;
      } else if ((tk.value === ',' || tk.value === ';') && pd === 0 && bd === 0 && cd === 0 && td === 0) {
        return p;
      }
    }
  }
  return limit;
}

function collectScopedConstBindings(
  tokens: readonly Token[],
  delims: DelimiterPairs,
  templateNext: Int32Array,
  templateTail?: Int32Array,
): { scopes: LexScope[]; tokenScope: Int32Array; constEqIndices: Set<number> } {
  const scopes: LexScope[] = [{ parent: -1, bindings: new Map() }];
  const tokenScope = new Int32Array(tokens.length);
  const constEqIndices = new Set<number>();
  const scopeStack: number[] = [0];
  const braceSeedBindings = new Map<number, string[]>();
  const conciseEnterAt = new Map<number, string[]>();
  const scopePopAt = new Map<number, number>();
  const forParenCloseToScope = new Map<number, number>();
  const braceReuseScope = new Map<number, number>();

  const seedNames = (map: Map<number, string[]>, idx: number, names: readonly string[]): void => {
    if (names.length === 0) return;
    const prev = map.get(idx);
    if (prev) prev.push(...names);
    else map.set(idx, [...names]);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const popCount = scopePopAt.get(i) ?? 0;
    for (let k = 0; k < popCount; k += 1) {
      if (scopeStack.length > 1) scopeStack.pop();
    }

    const conciseNames = conciseEnterAt.get(i);
    if (conciseNames) {
      const parent = scopeStack[scopeStack.length - 1]!;
      const childIdx = scopes.length;
      const bindings = new Map<string, string | null>();
      for (const n of conciseNames) bindings.set(n, null);
      scopes.push({ parent, bindings });
      scopeStack.push(childIdx);
      const endIdx = findConciseArrowEnd(tokens, i);
      scopePopAt.set(endIdx, (scopePopAt.get(endIdx) ?? 0) + 1);
    }

    const t = tokens[i]!;
    if (t.kind === 'punct' && t.value === '{') {
      const closeBrace = delims.brace[i] ?? -1;
      if (closeBrace > i) {
        const reused = braceReuseScope.get(i);
        const childIdx = reused !== undefined ? reused : scopes.length;
        if (reused === undefined) {
          const parent = scopeStack[scopeStack.length - 1]!;
          const bindings = new Map<string, string | null>();
          const seeded = braceSeedBindings.get(i);
          if (seeded) {
            for (const n of seeded) bindings.set(n, null);
          }
          scopes.push({ parent, bindings });
        }
        scopeStack.push(childIdx);
        scopePopAt.set(closeBrace + 1, (scopePopAt.get(closeBrace + 1) ?? 0) + 1);
      }
    }

    if (t.kind === 'punct' && t.value === '(') {
      const closeParen = delims.paren[i] ?? -1;
      if (closeParen > i) {
        const prev = tokens[i - 1];
        if (prev?.kind === 'ident' && (prev.value === 'for' || (prev.value === 'await' && tokens[i - 2]?.value === 'for'))) {
          const parent = scopeStack[scopeStack.length - 1]!;
          const forIdx = scopes.length;
          scopes.push({ parent, bindings: new Map() });
          scopeStack.push(forIdx);
          forParenCloseToScope.set(closeParen, forIdx);
        } else {
          const fnTarget = findFnParamBodyTarget(tokens, i, closeParen, delims);
          if (fnTarget) {
            const paramNames: string[] = [];
            collectPatternIdents(tokens, i + 1, closeParen, delims, paramNames, false, templateTail);
            if (fnTarget.targetKind === 'brace') seedNames(braceSeedBindings, fnTarget.targetIdx, paramNames);
            else seedNames(conciseEnterAt, fnTarget.targetIdx, paramNames);
          }
        }
      }
    }

    if (t.kind === 'punct' && t.value === ')' && forParenCloseToScope.has(i)) {
      const forIdx = forParenCloseToScope.get(i)!;
      if (tokens[i + 1]?.kind === 'punct' && tokens[i + 1]?.value === '{' && (delims.brace[i + 1] ?? -1) > i + 1) {
        braceReuseScope.set(i + 1, forIdx);
        if (scopeStack.length > 1) scopeStack.pop();
      } else if (i + 1 < tokens.length) {
        const endIdx = findBracelessStatementEnd(tokens, i + 1, delims, templateTail);
        scopePopAt.set(endIdx, (scopePopAt.get(endIdx) ?? 0) + 1);
      } else if (scopeStack.length > 1) {
        scopeStack.pop();
      }
    }

    const curScopeIdx = scopeStack[scopeStack.length - 1]!;
    tokenScope[i] = curScopeIdx;
    const curBindings = scopes[curScopeIdx]!.bindings;

    if (t.kind === 'ident' && !isMemberPrev(tokens, i) && tokens[i + 1]?.kind === 'punct' && tokens[i + 1]?.value === '=>') {
      const afterArrow = tokens[i + 2];
      if (afterArrow?.kind === 'punct' && afterArrow.value === '{') {
        seedNames(braceSeedBindings, i + 2, [t.value]);
      } else {
        seedNames(conciseEnterAt, i + 2, [t.value]);
      }
      continue;
    }

    if (t.kind === 'punct' && t.value === '=') {
      if (!constEqIndices.has(i)) {
        const lhsIdent = findAssignmentLhsIdent(tokens, i);
        if (lhsIdent) invalidateScopedBinding(scopes, curScopeIdx, lhsIdent);
      }
      continue;
    }

    if (t.kind !== 'ident' || isMemberPrev(tokens, i)) continue;
    if (t.value === 'let' || t.value === 'var') {
      let p = i + 1;
      let count = 0;
      while (p < tokens.length && count < 16) {
        count += 1;
        const tk = tokens[p]!;
        if (tk.kind === 'ident') {
          curBindings.set(tk.value, null);
          p = findTypeDeclStop(tokens, p + 1);
          if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '=') {
            const initRes = findDeclInitEnd(tokens, p + 1);
            p = initRes.endIdx;
          }
          if (tokens[p]?.kind === 'punct' && tokens[p]?.value === ',') {
            p += 1;
            continue;
          }
          break;
        }
        if (tk.kind === 'punct' && (tk.value === '{' || tk.value === '[')) {
          const closePat = tk.value === '{' ? (delims.brace[p] ?? -1) : (delims.bracket[p] ?? -1);
          if (closePat > p) {
            const names: string[] = [];
            collectPatternIdents(tokens, p + 1, closePat, delims, names, tk.value === '{', templateTail);
            for (const n of names) curBindings.set(n, null);
          }
        }
        break;
      }
      continue;
    }

    const prevTokConst = tokens[i - 1];
    const isTsConstAssertion =
      (prevTokConst?.kind === 'ident' && prevTokConst.value === 'as') ||
      (prevTokConst?.kind === 'punct' &&
        prevTokConst.value === '<' &&
        tokens[i + 1]?.kind === 'punct' &&
        tokens[i + 1]?.value === '>');
    if (t.value !== 'const' || isTsConstAssertion) continue;
    let p = i + 1;
    let declCount = 0;
    while (p < tokens.length && declCount < 16) {
      declCount += 1;
      const nameTok = tokens[p];
      if (!nameTok) break;
      if (nameTok.kind === 'punct' && (nameTok.value === '{' || nameTok.value === '[')) {
        const closePat = nameTok.value === '{' ? (delims.brace[p] ?? -1) : (delims.bracket[p] ?? -1);
        if (closePat <= p) break;
        const patNames: string[] = [];
        collectPatternIdents(tokens, p + 1, closePat, delims, patNames, nameTok.value === '{', templateTail);
        for (const n of patNames) curBindings.set(n, null);
        p = closePat + 1;
        if (tokens[p]?.kind === 'punct' && tokens[p]?.value === ':') {
          p = findTypeDeclStop(tokens, p + 1);
        }
        if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '=') {
          constEqIndices.add(p);
          const initRes = findDeclInitEnd(tokens, p + 1);
          p = initRes.endIdx;
          if (tokens[p]?.kind === 'punct' && tokens[p]?.value === ',') {
            p += 1;
            continue;
          }
        }
        break;
      }

      if (nameTok.kind !== 'ident') break;
      p += 1;
      if (tokens[p]?.kind === 'punct' && tokens[p]?.value === ':') {
        p = findTypeDeclStop(tokens, p + 1);
      }
      if (tokens[p]?.kind !== 'punct' || tokens[p]?.value !== '=') {
        curBindings.set(nameTok.value, null);
        break;
      }
      constEqIndices.add(p);
      const exprStart = p + 1;
      const initRes = findDeclInitEnd(tokens, exprStart);
      const q = initRes.endIdx;
      const val = !initRes.truncated
        ? tryResolveConstantStringExpr(
            tokens,
            exprStart,
            q,
            delims,
            templateNext,
            (n) => lookupScopedConst(scopes, curScopeIdx, n),
            0,
            templateTail,
          )
        : null;
      if (val !== null) {
        if (curBindings.has(nameTok.value)) {
          if (curBindings.get(nameTok.value) !== val) curBindings.set(nameTok.value, null);
        } else {
          curBindings.set(nameTok.value, val);
        }
      } else {
        curBindings.set(nameTok.value, null);
      }
      if (tokens[q]?.kind === 'punct' && tokens[q]?.value === ',') {
        p = q + 1;
        continue;
      }
      break;
    }
  }
  return { scopes, tokenScope, constEqIndices };
}

const isMeterModuleSpecifier = (spec: string): boolean => {
  const specNorm = normalizeModuleSpecifier(spec);
  return (
    /(?:^|\/)meter(?:\.[cm]?[jt]s)?$/.test(specNorm) ||
    /(?:^|\/)index(?:\.[cm]?[jt]s)?$/.test(specNorm) ||
    specNorm === '@ludy/agent' ||
    specNorm === '@crove/agent' ||
    specNorm.includes('packages/agent')
  );
};

const METER_DESTRUCTURE_KEYS = new Set(['metered']);

interface ClosePairMaps {
  parenOpenFromClose: Int32Array;
  bracketOpenFromClose: Int32Array;
  braceOpenFromClose: Int32Array;
  templateHeadFromTail: Int32Array;
}

function invertPairs(forward: Int32Array, len: number): Int32Array {
  const rev = new Int32Array(len).fill(-1);
  for (let p = 0; p < forward.length; p += 1) {
    const cl = forward[p]!;
    if (cl > p) rev[cl] = p;
  }
  return rev;
}

function stripTrailingBindSuffix(
  tokens: readonly Token[],
  start: number,
  end: number,
  delims: DelimiterPairs,
  closeMaps: ClosePairMaps,
  templateNext: Int32Array,
  constLookup: ConstLookupFn,
  templateTail: Int32Array,
): number {
  if (end - start < 4) return end;
  let e = end;
  while (e > start && tokens[e - 1]?.kind === 'punct' && tokens[e - 1]?.value === '!') e -= 1;
  if (tokens[e - 1]?.kind !== 'punct' || tokens[e - 1]?.value !== ')') return end;
  const openParen = closeMaps.parenOpenFromClose[e - 1] ?? -1;
  if (openParen < start + 2) return end;
  const beforeParen = tokens[openParen - 1];
  if (beforeParen?.kind === 'ident' && beforeParen.value === 'bind' && isMemberPrev(tokens, openParen - 1)) {
    const memberPunctIdx = openParen - 2;
    return memberPunctIdx > start ? memberPunctIdx : end;
  }
  if (beforeParen?.kind === 'punct' && beforeParen.value === ']') {
    const openBr = closeMaps.bracketOpenFromClose[openParen - 1] ?? -1;
    if (
      openBr > start &&
      tryResolveConstantStringExpr(tokens, openBr + 1, openParen - 1, delims, templateNext, constLookup, 0, templateTail) === 'bind'
    ) {
      const trim = tokens[openBr - 1]?.kind === 'punct' && tokens[openBr - 1]?.value === '?.' ? openBr - 1 : openBr;
      return trim > start ? trim : end;
    }
  }
  return end;
}

function unwrapCalleeExprSpan(
  tokens: readonly Token[],
  start: number,
  end: number,
  delims: DelimiterPairs,
  closeMaps: ClosePairMaps,
  templateTail: Int32Array,
  templateNext: Int32Array,
  constLookup: ConstLookupFn,
): { start: number; end: number } {
  let s = start;
  let e = end;
  for (let loop = 0; loop < 8 && s < e; loop += 1) {
    const norm = normalizeValueExprSpan(tokens, s, e, delims, templateTail);
    s = norm.start;
    e = norm.end;
    if (s >= e) break;

    const unboundEnd = stripTrailingBindSuffix(tokens, s, e, delims, closeMaps, templateNext, constLookup, templateTail);
    if (unboundEnd < e) {
      e = unboundEnd;
      continue;
    }

    // Scan backward from `e - 1` jumping paired delimiters in O(1) so `(0, ...)` comma chains stay O(1) per call.
    let lastComma = -1;
    for (let k = e - 1; k >= s; k -= 1) {
      const tk = tokens[k]!;
      if (tk.kind === 'template_tail') {
        const hd = closeMaps.templateHeadFromTail[k] ?? -1;
        if (hd >= s) {
          k = hd;
          continue;
        }
        break;
      }
      if (tk.kind !== 'punct') continue;
      if (tk.value === ')') {
        const op = closeMaps.parenOpenFromClose[k] ?? -1;
        if (op >= s) {
          k = op;
          continue;
        }
        break;
      }
      if (tk.value === ']') {
        const op = closeMaps.bracketOpenFromClose[k] ?? -1;
        if (op >= s) {
          k = op;
          continue;
        }
        break;
      }
      if (tk.value === '}') {
        const op = closeMaps.braceOpenFromClose[k] ?? -1;
        if (op >= s) {
          k = op;
          continue;
        }
        break;
      }
      if (tk.value === ',') {
        lastComma = k;
        break;
      }
    }
    if (lastComma >= s) {
      s = lastComma + 1;
      continue;
    }
    break;
  }
  return { start: s, end: e };
}

function collectMeterAliasInfo(
  tokens: readonly Token[],
  delims: DelimiterPairs,
  closeMaps: ClosePairMaps,
  templateTail: Int32Array,
  templateNext: Int32Array,
  scopes: readonly LexScope[],
  tokenScope: Int32Array,
): { meterAliases: Set<string>; meterNamespaces: Set<string> } {
  const seedAliases = new Set(['metered']);
  const seedNamespaces = new Set<string>();
  const aliasEdges = new Map<string, Set<string>>();
  const memberMeterCandidates: Array<{ host: string; target: string }> = [];
  const constLookup: ConstLookupFn = (n, idx) => lookupScopedConst(scopes, tokenScope[idx] ?? 0, n);
  const resolveStaticStr = (s: number, e: number) =>
    tryResolveConstantStringExpr(tokens, s, e, delims, templateNext, constLookup, 0, templateTail);

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === 'punct' && t.value === '{') {
      const closeBrace = delims.brace[i] ?? -1;
      if (isDestructuringBraceContext(tokens, i, closeBrace, delims)) {
        const matches = extractDestructuredMatches(
          tokens,
          i,
          closeBrace,
          delims,
          METER_DESTRUCTURE_KEYS,
          resolveStaticStr,
          templateTail,
        );
        for (const m of matches) {
          if (m.localName) seedAliases.add(m.localName);
        }
      }
      continue;
    }

    if (t.kind === 'punct' && t.value === '=') {
      const lhsIdent = findAssignmentLhsIdent(tokens, i);
      if (!lhsIdent) continue;
      const rhsEndRes = findDeclInitEnd(tokens, i + 1);
      if (rhsEndRes.endIdx <= i + 1) continue;
      let rhsStart = i + 1;
      while (rhsStart < rhsEndRes.endIdx && tokens[rhsStart]?.kind === 'ident' && tokens[rhsStart]?.value === 'await') {
        rhsStart += 1;
      }
      const norm = unwrapCalleeExprSpan(tokens, rhsStart, rhsEndRes.endIdx, delims, closeMaps, templateTail, templateNext, constLookup);
      if (norm.start >= norm.end) continue;

      const ns = norm.start;
      const ne = norm.end;
      const rhsTok = tokens[ns]!;
      if (ne - ns === 1 && rhsTok.kind === 'ident' && !isMemberPrev(tokens, ns)) {
        addAliasEdge(aliasEdges, rhsTok.value, lhsIdent);
        continue;
      }

      const inlineMeterMod = matchInlineModuleMemberSpan(tokens, ns, ne, isMeterModuleSpecifier, 'metered', delims, resolveStaticStr);
      if (inlineMeterMod) {
        if (inlineMeterMod.kind === 'namespace') seedNamespaces.add(lhsIdent);
        else seedAliases.add(lhsIdent);
        continue;
      }

      if (rhsTok.kind === 'ident' && !isMemberPrev(tokens, ns)) {
        const suffix = matchNamedMemberSuffix(tokens, ns, ['metered'], delims, resolveStaticStr);
        if (suffix && suffix.endIdx + 1 === ne) {
          memberMeterCandidates.push({ host: rhsTok.value, target: lhsIdent });
        }
      }
      continue;
    }

    if (t.kind !== 'ident' || isMemberPrev(tokens, i) || t.value !== 'import') continue;
    let p = i + 1;
    if (tokens[p]?.kind === 'ident' && tokens[p]?.value === 'type') continue;
    if (tokens[p]?.kind === 'punct' && tokens[p]?.value === '*') {
      if (tokens[p + 1]?.kind === 'ident' && tokens[p + 1]?.value === 'as' && tokens[p + 2]?.kind === 'ident') {
        const nsName = tokens[p + 2]!.value;
        if (isFromKeywordAt(tokens, p + 3) && isMeterModuleSpecifier(tokens[p + 4]!.value)) {
          seedNamespaces.add(nsName);
          i = p + 4;
        }
      }
      continue;
    }
    if (tokens[p]?.kind !== 'punct' || tokens[p]?.value !== '{') continue;
    const close = delims.brace[p] ?? -1;
    if (close < 0 || !isFromKeywordAt(tokens, close + 1)) continue;
    if (!isMeterModuleSpecifier(tokens[close + 2]!.value)) continue;
    for (let k = p + 1; k + 2 < close; k += 1) {
      const item = tokens[k]!;
      if (
        (item.kind === 'ident' || item.kind === 'string') &&
        item.value === 'metered' &&
        tokens[k + 1]?.kind === 'ident' &&
        tokens[k + 1]?.value === 'as' &&
        tokens[k + 2]?.kind === 'ident'
      ) {
        seedAliases.add(tokens[k + 2]!.value);
      }
    }
    i = close + 2;
  }

  const meterNamespaces = propagateAliases(seedNamespaces, aliasEdges);
  for (const cand of memberMeterCandidates) {
    if (meterNamespaces.has(cand.host)) seedAliases.add(cand.target);
  }
  return {
    meterAliases: propagateAliases(seedAliases, aliasEdges),
    meterNamespaces,
  };
}

function splitCallArgsBounded(
  tokens: readonly Token[],
  openIdx: number,
  maxArgs = 3,
): { args: Array<{ start: number; end: number }>; truncated: boolean } {
  const args: Array<{ start: number; end: number }> = [];
  const isBracket = tokens[openIdx]?.kind === 'punct' && tokens[openIdx]?.value === '[';
  const limit = Math.min(tokens.length, openIdx + 193);
  let argStart = openIdx + 1;
  let pd = 0;
  let bd = 0;
  let cd = 0;
  let td = 0;
  for (let k = openIdx + 1; k < limit; k += 1) {
    const cur = tokens[k]!;
    if (cur.kind === 'template_head') td += 1;
    else if (cur.kind === 'template_tail' && td > 0) td -= 1;
    else if (cur.kind === 'punct') {
      if (cur.value === '(') pd += 1;
      else if (cur.value === ')') {
        if (!isBracket && pd === 0 && bd === 0 && cd === 0 && td === 0) {
          if (k > argStart) args.push({ start: argStart, end: k });
          return { args, truncated: false };
        }
        if (pd > 0) pd -= 1;
      } else if (cur.value === '[') bd += 1;
      else if (cur.value === ']') {
        if (isBracket && pd === 0 && bd === 0 && cd === 0 && td === 0) {
          if (k > argStart) args.push({ start: argStart, end: k });
          return { args, truncated: false };
        }
        if (bd > 0) bd -= 1;
      } else if (cur.value === '{') cd += 1;
      else if (cur.value === '}' && cd > 0) cd -= 1;
      else if (cur.value === ',' && pd === 0 && bd === 0 && cd === 0 && td === 0) {
        args.push({ start: argStart, end: k });
        if (args.length >= maxArgs) return { args, truncated: false };
        argStart = k + 1;
      }
    }
  }
  return { args, truncated: true };
}

function isMeteredFnDeclaration(tokens: readonly Token[], meteredIdentIdx: number): boolean {
  const prev = tokens[meteredIdentIdx - 1];
  if (prev?.kind === 'ident' && prev.value === 'function') return true;
  if (prev?.kind === 'punct' && prev.value === '*' && tokens[meteredIdentIdx - 2]?.kind === 'ident' && tokens[meteredIdentIdx - 2]?.value === 'function') {
    return true;
  }
  return false;
}

function matchesMeteredCalleeSpan(
  tokens: readonly Token[],
  start: number,
  end: number,
  delims: DelimiterPairs,
  closeMaps: ClosePairMaps,
  templateTail: Int32Array,
  templateNext: Int32Array,
  constLookup: ConstLookupFn,
  meterAliases: ReadonlySet<string>,
  meterNamespaces: ReadonlySet<string>,
): boolean {
  const { start: s, end: e } = unwrapCalleeExprSpan(tokens, start, end, delims, closeMaps, templateTail, templateNext, constLookup);
  if (s >= e) return false;
  if (e - s === 1) {
    const tk = tokens[s]!;
    return tk.kind === 'ident' && meterAliases.has(tk.value) && !isMemberPrev(tokens, s) && !isMeteredFnDeclaration(tokens, s);
  }
  const resolveStaticStr = (a: number, b: number) =>
    tryResolveConstantStringExpr(tokens, a, b, delims, templateNext, constLookup, 0, templateTail);
  const inlineMod = matchInlineModuleMemberSpan(tokens, s, e, isMeterModuleSpecifier, 'metered', delims, resolveStaticStr);
  if (inlineMod?.kind === 'member') return true;
  const host = tokens[s]!;
  if (host.kind === 'ident' && !isMemberPrev(tokens, s) && meterNamespaces.has(host.value)) {
    const suffix = matchNamedMemberSuffix(tokens, s, ['metered'], delims, resolveStaticStr);
    if (suffix && suffix.endIdx + 1 === e) return true;
  }
  return false;
}

function extractFirstArrayArgSpan(
  tokens: readonly Token[],
  arrArg: { start: number; end: number },
  delims: DelimiterPairs,
  templateTail: Int32Array,
  parentTruncated: boolean,
): { start: number; end: number; truncated: boolean } {
  const normArr = normalizeValueExprSpan(tokens, arrArg.start, arrArg.end, delims, templateTail);
  if (tokens[normArr.start]?.kind === 'punct' && tokens[normArr.start]?.value === '[') {
    const inner = splitCallArgsBounded(tokens, normArr.start, 1);
    const k0 = inner.args[0];
    if (k0) return { start: k0.start, end: k0.end, truncated: inner.truncated };
  }
  return { start: normArr.start, end: normArr.end, truncated: parentTruncated };
}

function unwrapMeteredCallKeySpan(
  tokens: readonly Token[],
  openParenIdx: number,
  delims: DelimiterPairs,
  closeMaps: ClosePairMaps,
  gtToLt: Int32Array,
  templateTail: Int32Array,
  templateNext: Int32Array,
  constLookup: ConstLookupFn,
  meterAliases: ReadonlySet<string>,
  meterNamespaces: ReadonlySet<string>,
): { start: number; end: number; truncated: boolean } | null {
  let calleeEnd = openParenIdx;
  if (tokens[calleeEnd - 1]?.kind === 'punct' && tokens[calleeEnd - 1]?.value === '?.') {
    calleeEnd -= 1;
  }
  if (tokens[calleeEnd - 1]?.kind === 'punct' && tokens[calleeEnd - 1]?.value === '>') {
    const ltIdx = gtToLt[calleeEnd - 1] ?? -1;
    if (ltIdx < 0) return null;
    calleeEnd = ltIdx;
  }
  if (tokens[calleeEnd - 1]?.kind === 'punct' && tokens[calleeEnd - 1]?.value === '?.') {
    calleeEnd -= 1;
  }
  while (calleeEnd > 0 && tokens[calleeEnd - 1]?.kind === 'punct' && tokens[calleeEnd - 1]?.value === '!') {
    calleeEnd -= 1;
  }
  if (calleeEnd <= 0) return null;

  // Locate start of callee expression ending at `calleeEnd`
  const findReceiverStart = (end: number): number => {
    let cur = end - 1;
    let steps = 0;
    while (cur >= 0 && steps < 12) {
      steps += 1;
      const tk = tokens[cur]!;
      if (tk.kind === 'punct' && tk.value === ')') {
        const op = closeMaps.parenOpenFromClose[cur] ?? -1;
        if (op < 0) return -1;
        const prevBeforeOp = tokens[op - 1];
        const isChainCall =
          op > 0 &&
          (prevBeforeOp?.kind === 'punct'
            ? prevBeforeOp.value === '.' || prevBeforeOp.value === '?.'
            : prevBeforeOp?.kind === 'ident' &&
              !REGEX_PREFIX_KEYWORDS.has(prevBeforeOp.value) &&
              !CONTROL_KEYWORDS.has(prevBeforeOp.value));
        if (isChainCall) {
          cur = op - 1;
          continue;
        }
        return op;
      }
      if (tk.kind === 'punct' && tk.value === ']') {
        const openBr = closeMaps.bracketOpenFromClose[cur] ?? -1;
        if (openBr < 1) return -1;
        cur = openBr - 1;
        if (tokens[cur]?.kind === 'punct' && tokens[cur]?.value === '?.') cur -= 1;
        while (cur >= 0 && tokens[cur]?.kind === 'punct' && tokens[cur]?.value === '!') cur -= 1;
        continue;
      }
      if (tk.kind === 'ident') {
        if (isMemberPrev(tokens, cur)) {
          cur -= 2;
          while (cur >= 0 && tokens[cur]?.kind === 'punct' && tokens[cur]?.value === '!') cur -= 1;
          continue;
        }
        return cur;
      }
      return -1;
    }
    return -1;
  };

  const resolveStaticStr = (a: number, b: number) =>
    tryResolveConstantStringExpr(tokens, a, b, delims, templateNext, constLookup, 0, templateTail);

  // Detect Reflect.apply / Reflect['apply'] / Reflect?.['apply'](m, thisArg, [key, ...])
  const reflectMatch = matchTrailingNamedMember(tokens, 0, calleeEnd, ['apply'], closeMaps, resolveStaticStr);
  if (reflectMatch) {
    let rEnd = reflectMatch.baseEnd;
    while (rEnd > 0 && tokens[rEnd - 1]?.kind === 'punct' && tokens[rEnd - 1]?.value === '!') rEnd -= 1;
    const rStart = findReceiverStart(rEnd);
    if (rStart >= 0) {
      const normReflect = normalizeValueExprSpan(tokens, rStart, rEnd, delims, templateTail);
      if (
        normReflect.end - normReflect.start === 1 &&
        tokens[normReflect.start]?.kind === 'ident' &&
        tokens[normReflect.start]?.value === 'Reflect' &&
        !isMemberPrev(tokens, normReflect.start)
      ) {
        const parsed = splitCallArgsBounded(tokens, openParenIdx, 3);
        const fnArg = parsed.args[0];
        if (fnArg && matchesMeteredCalleeSpan(tokens, fnArg.start, fnArg.end, delims, closeMaps, templateTail, templateNext, constLookup, meterAliases, meterNamespaces)) {
          const arrArg = parsed.args[2];
          if (!arrArg) return null;
          return extractFirstArrayArgSpan(tokens, arrArg, delims, templateTail, parsed.truncated);
        }
        return null;
      }
    }
  }

  // Detect `.call(...)`, `['call'](...)`, `.apply(...)`, `['apply'](...)`, or `.bind(...)()` suffix
  let targetArgIdx = 0;
  let isApplyArr = false;
  let baseEnd = calleeEnd;
  const callMatch = matchTrailingNamedMember(tokens, 0, baseEnd, ['call', 'apply'], closeMaps, resolveStaticStr);
  if (callMatch) {
    targetArgIdx = 1;
    isApplyArr = callMatch.memberName === 'apply';
    baseEnd = callMatch.baseEnd;
  } else {
    const unboundEnd = stripTrailingBindSuffix(tokens, 0, baseEnd, delims, closeMaps, templateNext, constLookup, templateTail);
    if (unboundEnd < baseEnd) baseEnd = unboundEnd;
  }
  while (baseEnd > 0 && tokens[baseEnd - 1]?.kind === 'punct' && tokens[baseEnd - 1]?.value === '!') {
    baseEnd -= 1;
  }

  const baseStart = findReceiverStart(baseEnd);
  if (baseStart < 0) return null;
  if (!matchesMeteredCalleeSpan(tokens, baseStart, baseEnd, delims, closeMaps, templateTail, templateNext, constLookup, meterAliases, meterNamespaces)) {
    return null;
  }

  const parsed = splitCallArgsBounded(tokens, openParenIdx, targetArgIdx + 1);
  const arg = parsed.args[targetArgIdx];
  if (!arg) return null;
  if (isApplyArr) {
    return extractFirstArrayArgSpan(tokens, arg, delims, templateTail, parsed.truncated);
  }
  return { start: arg.start, end: arg.end, truncated: parsed.truncated };
}

function analyzeMeteredKeyExpr(
  tokens: readonly Token[],
  start: number,
  end: number,
  delims: DelimiterPairs,
  templateTail: Int32Array,
  templateNext: Int32Array,
  text: string,
  constLookup: ConstLookupFn,
  includeUnresolved: boolean,
  out: string[],
  depth = 0,
): boolean {
  if (depth > 8 || start >= end) {
    if (includeUnresolved && start < end) {
      const snippet = tokens.slice(start, Math.min(end, start + 16)).map((tk) => tk.raw).join('').slice(0, 64);
      out.push(`unresolved metered key (${snippet})`);
    }
    return false;
  }
  const { start: s, end: e } = normalizeValueExprSpan(tokens, start, end, delims, templateTail);
  if (s >= e) return false;

  // Split lowest-precedence comma `,` first, then ternary `? :` at depth 0 (never return the condition).
  let lastComma = -1;
  let qMarkIdx = -1;
  let colonIdx = -1;
  let ternaryDepth = 0;
  let pd = 0;
  let bd = 0;
  let cd = 0;
  let td = 0;
  for (let idx = s; idx < e; idx += 1) {
    const tk = tokens[idx]!;
    if (tk.kind === 'template_head') td += 1;
    else if (tk.kind === 'template_tail' && td > 0) td -= 1;
    else if (tk.kind === 'punct') {
      if (tk.value === '(') pd += 1;
      else if (tk.value === ')' && pd > 0) pd -= 1;
      else if (tk.value === '[') bd += 1;
      else if (tk.value === ']' && bd > 0) bd -= 1;
      else if (tk.value === '{') cd += 1;
      else if (tk.value === '}' && cd > 0) cd -= 1;
      else if (pd === 0 && bd === 0 && cd === 0 && td === 0) {
        if (tk.value === ',') {
          lastComma = idx;
        } else if (tk.value === '?') {
          if (qMarkIdx < 0) qMarkIdx = idx;
          ternaryDepth += 1;
        } else if (tk.value === ':' && ternaryDepth > 0) {
          ternaryDepth -= 1;
          if (ternaryDepth === 0 && qMarkIdx >= 0 && colonIdx < 0) {
            colonIdx = idx;
          }
        }
      }
    }
  }
  if (lastComma >= s) {
    if (lastComma + 1 < e) {
      return analyzeMeteredKeyExpr(tokens, lastComma + 1, e, delims, templateTail, templateNext, text, constLookup, includeUnresolved, out, depth + 1);
    }
    if (includeUnresolved) {
      const snippet = tokens.slice(s, Math.min(e, s + 16)).map((tk) => tk.raw).join('').slice(0, 64);
      out.push(`unresolved metered key (${snippet})`);
    }
    return false;
  }
  if (qMarkIdx > s && colonIdx > qMarkIdx) {
    const leftOk = analyzeMeteredKeyExpr(tokens, qMarkIdx + 1, colonIdx, delims, templateTail, templateNext, text, constLookup, includeUnresolved, out, depth + 1);
    const rightOk = analyzeMeteredKeyExpr(tokens, colonIdx + 1, e, delims, templateTail, templateNext, text, constLookup, includeUnresolved, out, depth + 1);
    return leftOk && rightOk;
  }

  // Split logical short-circuit operators `&&`, `||`, `??` at depth 0.
  const logicalSpans: Array<{ start: number; end: number }> = [];
  let spanStart = s;
  pd = 0;
  bd = 0;
  cd = 0;
  td = 0;
  for (let idx = s; idx < e; idx += 1) {
    const tk = tokens[idx]!;
    if (tk.kind === 'template_head') td += 1;
    else if (tk.kind === 'template_tail' && td > 0) td -= 1;
    else if (tk.kind === 'punct') {
      if (tk.value === '(') pd += 1;
      else if (tk.value === ')' && pd > 0) pd -= 1;
      else if (tk.value === '[') bd += 1;
      else if (tk.value === ']' && bd > 0) bd -= 1;
      else if (tk.value === '{') cd += 1;
      else if (tk.value === '}' && cd > 0) cd -= 1;
      else if (pd === 0 && bd === 0 && cd === 0 && td === 0 && LOGICAL_OR_BRANCH_PUNCTS.has(tk.value)) {
        if (idx > spanStart) logicalSpans.push({ start: spanStart, end: idx });
        spanStart = idx + 1;
      }
    }
  }
  if (logicalSpans.length > 0 && logicalSpans.length < 16) {
    if (spanStart < e) logicalSpans.push({ start: spanStart, end: e });
    let allOk = true;
    for (const sp of logicalSpans) {
      if (!analyzeMeteredKeyExpr(tokens, sp.start, sp.end, delims, templateTail, templateNext, text, constLookup, includeUnresolved, out, depth + 1)) {
        allOk = false;
      }
    }
    return allOk;
  }

  const headTok = tokens[s]!;
  if (headTok.kind === 'template_head' && headTok.value.startsWith('notes.') && (templateTail[s] ?? -1) === e - 1) {
    const tailIdx = templateTail[s]!;
    const resolvedTpl = tryResolveConstantStringExpr(tokens, s, tailIdx + 1, delims, templateNext, constLookup, 0, templateTail);
    if (resolvedTpl !== null) {
      if (resolvedTpl.startsWith('notes.')) out.push(resolvedTpl);
      return true;
    }
    out.push(formatNotesTemplateSpan(text, headTok, tokens[tailIdx]!));
    return false;
  }

  const resolved = e - s <= 128 ? tryResolveConstantStringExpr(tokens, s, e, delims, templateNext, constLookup, 0, templateTail) : null;
  if (resolved !== null) {
    if (resolved.startsWith('notes.')) out.push(resolved);
    return true;
  }

  if (includeUnresolved) {
    const prefix = constantLeadingPrefix(tokens, s, e, delims, templateNext, constLookup, templateTail);
    if (prefix.startsWith('notes.') || 'notes.'.startsWith(prefix)) {
      const snippetEnd = Math.min(e, s + 16);
      const snippet = tokens.slice(s, snippetEnd).map((tk) => tk.raw).join('').slice(0, 64);
      out.push(`unresolved metered key (${snippet})`);
    }
  }
  return false;
}

function collectMeteredNotesFromTokens(
  tokens: readonly Token[],
  text: string,
  options?: {
    includeUnresolved?: boolean;
    ignoreUnresolvedInRanges?: ReadonlyArray<{ start: number; end: number }>;
    resolvedParenStarts?: Set<number>;
  },
): string[] {
  const out: string[] = [];
  const delims = pairDelimiters(tokens);
  const { templateTail, templateNext } = buildTemplateMaps(tokens);
  const { scopes, tokenScope } = collectScopedConstBindings(tokens, delims, templateNext, templateTail);
  const closeMaps: ClosePairMaps = {
    parenOpenFromClose: invertPairs(delims.paren, tokens.length),
    bracketOpenFromClose: invertPairs(delims.bracket, tokens.length),
    braceOpenFromClose: invertPairs(delims.brace, tokens.length),
    templateHeadFromTail: invertPairs(templateTail, tokens.length),
  };
  const { meterAliases, meterNamespaces } = collectMeterAliasInfo(tokens, delims, closeMaps, templateTail, templateNext, scopes, tokenScope);
  const constLookup: ConstLookupFn = (name, idx) => lookupScopedConst(scopes, tokenScope[idx] ?? 0, name);

  const gtToLt = new Int32Array(tokens.length).fill(-1);
  const ltIdxStack: number[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind === 'punct') {
      if (t.value === '<') ltIdxStack.push(i);
      else if (t.value === '>' && ltIdxStack.length > 0) gtToLt[i] = ltIdxStack.pop()!;
      else if (t.value === ';' || t.value === '{' || t.value === '}') ltIdxStack.length = 0;
    }
  }

  const ignoreRanges = options?.ignoreUnresolvedInRanges ?? [];
  let ignoreCursor = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.kind !== 'punct' || t.value !== '(' || i === 0) continue;
    const callArg = unwrapMeteredCallKeySpan(
      tokens,
      i,
      delims,
      closeMaps,
      gtToLt,
      templateTail,
      templateNext,
      constLookup,
      meterAliases,
      meterNamespaces,
    );
    if (!callArg) continue;
    while (ignoreCursor < ignoreRanges.length && ignoreRanges[ignoreCursor]!.end <= t.start) {
      ignoreCursor += 1;
    }
    const curRange = ignoreRanges[ignoreCursor];
    const insideUnambiguousRegex = Boolean(curRange && t.start >= curRange.start && t.end <= curRange.end);
    const includeUnresolvedHere = Boolean(options?.includeUnresolved) && !insideUnambiguousRegex;
    if (callArg.truncated) {
      if (includeUnresolvedHere) {
        const snippet = tokens.slice(callArg.start, Math.min(callArg.end, callArg.start + 16)).map((tk) => tk.raw).join('').slice(0, 64);
        out.push(`unresolved metered key (${snippet})`);
      } else if (tokens[callArg.start]?.kind === 'template_head' && tokens[callArg.start]!.value.startsWith('notes.')) {
        out.push(`${tokens[callArg.start]!.value.slice(0, 64)}\${...}`);
      }
      continue;
    }
    const resolvedHere = analyzeMeteredKeyExpr(
      tokens,
      callArg.start,
      callArg.end,
      delims,
      templateTail,
      templateNext,
      text,
      constLookup,
      includeUnresolvedHere,
      out,
    );
    if (resolvedHere && options?.resolvedParenStarts) {
      options.resolvedParenStarts.add(t.start);
    }
  }
  return out;
}

function skipRawWsAndComments(text: string, startIdx: number, maxChars = 256): number {
  const limit = Math.min(text.length, startIdx + maxChars);
  let p = startIdx;
  while (p < limit) {
    if (isWhitespaceCode(text.charCodeAt(p))) {
      p += 1;
      continue;
    }
    if (text[p] === '/' && text[p + 1] === '/') {
      p += 2;
      while (p < limit && text[p] !== '\n' && text[p] !== '\r') p += 1;
      continue;
    }
    if (text[p] === '/' && text[p + 1] === '*') {
      let end = -1;
      for (let k = p + 2; k + 1 < limit; k += 1) {
        if (text[k] === '*' && text[k + 1] === '/') {
          end = k;
          break;
        }
      }
      if (end < 0) return limit;
      p = end + 2;
      continue;
    }
    break;
  }
  return p;
}

function collectRawMeteredNotes(
  text: string,
  skipParenStarts?: ReadonlySet<number>,
  skipTextSpans: ReadonlyArray<{ start: number; end: number }> = [],
): string[] {
  const out: string[] = [];
  let pos = 0;
  let spanCursor = 0;
  while ((pos = text.indexOf('metered', pos)) >= 0) {
    while (spanCursor < skipTextSpans.length && skipTextSpans[spanCursor]!.end <= pos) {
      spanCursor += 1;
    }
    const activeSpan = skipTextSpans[spanCursor];
    if (activeSpan && pos >= activeSpan.start && pos < activeSpan.end) {
      pos = activeSpan.end;
      continue;
    }
    const before = pos > 0 ? text[pos - 1]! : '';
    let j = pos + 'metered'.length;
    pos = j;
    if (/[\w$]/.test(before) || /[\w$]/.test(text[j] ?? '')) continue;
    j = skipRawWsAndComments(text, j, 256);
    if (text[j] !== '(' || skipParenStarts?.has(j)) continue;
    j += 1;

    let acc = '';
    let parts = 0;
    let hadTrailingDynamic = false;
    let handledTruncated = false;

    while (parts < 16) {
      j = skipRawWsAndComments(text, j, 256);
      const q = text[j];
      if (q !== "'" && q !== '"' && q !== '`') {
        if (parts > 0) hadTrailingDynamic = true;
        break;
      }
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
      if (!valid) {
        if (parts > 0) hadTrailingDynamic = true;
        break;
      }
      if (text[end] !== q) {
        // Bound raw literal inspection to 256 chars so O(N) scaling holds on huge or nested literals.
        const headRaw = text.slice(bodyStart, Math.min(bodyStart + 64, text.length));
        const headDecoded = decodeRawStringContent(headRaw) ?? headRaw;
        const combined = acc + headDecoded;
        if (combined.startsWith('notes.')) out.push(`${combined.slice(0, 64)}...`);
        handledTruncated = true;
        break;
      }
      const rawInner = text.slice(bodyStart, end);
      if (q === '`' && rawInner.includes('${')) {
        if (parts > 0) hadTrailingDynamic = true;
        break;
      }
      acc += decodeRawStringContent(rawInner) ?? rawInner;
      parts += 1;
      if (acc.length > 256) {
        if (acc.startsWith('notes.')) out.push(`${acc.slice(0, 64)}...`);
        handledTruncated = true;
        break;
      }
      const afterQ = skipRawWsAndComments(text, end + 1, 256);
      if (text[afterQ] === '+') {
        j = afterQ + 1;
        continue;
      }
      break;
    }

    if (!handledTruncated && parts > 0 && acc.startsWith('notes.')) {
      out.push(hadTrailingDynamic ? `${acc}...` : acc);
    }
  }
  return out;
}

export function meteredNotes(text: string, options?: { includeUnresolved?: boolean }): string[] {
  const primary = scanSource(text, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  const extraTokens = speculativeRescan(text, primary);
  const resolvedOpts = { includeUnresolved: Boolean(options?.includeUnresolved) };
  const resolvedParenStarts = new Set<number>();
  const ignoreUnresolvedInRanges = resolvedOpts.includeUnresolved ? primary.unambiguousRegexSpans : [];
  const validSkipSpans = [
    ...primary.tokens
      .filter(
        (tk) =>
          tk.kind === 'string' ||
          tk.kind === 'template' ||
          tk.kind === 'template_head' ||
          tk.kind === 'template_middle' ||
          tk.kind === 'template_tail',
      )
      .map((tk) => ({ start: tk.start, end: tk.end })),
    ...primary.commentSpans,
  ].sort((a, b) => a.start - b.start);
  const found = new Set<string>([
    ...collectMeteredNotesFromTokens(primary.tokens, text, { ...resolvedOpts, resolvedParenStarts }),
    ...collectMeteredNotesFromTokens(tokenize(text, { scanRegexAsDivision: true }), text, {
      ...resolvedOpts,
      ignoreUnresolvedInRanges,
    }),
    ...(extraTokens ? collectMeteredNotesFromTokens(extraTokens, text, { ...resolvedOpts, resolvedParenStarts }) : []),
    ...collectRawMeteredNotes(text, resolvedParenStarts, validSkipSpans),
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
    const delims = pairDelimiters(tokens);
    const { templateTail, templateNext } = buildTemplateMaps(tokens);
    const { scopes, tokenScope } = collectScopedConstBindings(tokens, delims, templateNext, templateTail);
    const constLookup: ConstLookupFn = (name, idx) => lookupScopedConst(scopes, tokenScope[idx] ?? 0, name);

    const advanceConcatOperand = (idx: number, maxEnd: number): number => {
      if (idx >= maxEnd) return -1;
      const tk = tokens[idx]!;
      if (tk.kind === 'punct' && tk.value === '(') {
        const close = delims.paren[idx] ?? -1;
        return close > idx && close < maxEnd ? close + 1 : -1;
      }
      if (tk.kind === 'template_head') {
        const tailIdx = templateTail[idx] ?? -1;
        return tailIdx > idx && tailIdx < maxEnd ? tailIdx + 1 : -1;
      }
      if (tk.kind === 'string' || tk.kind === 'template' || (tk.kind === 'ident' && constLookup(tk.value, idx) !== null)) {
        return idx + 1;
      }
      return -1;
    };

    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i]!;
      const maxChainEnd = Math.min(tokens.length, i + 128);
      const firstEnd = advanceConcatOperand(i, maxChainEnd);
      if (firstEnd > i) {
        let cursor = firstEnd;
        while (cursor < maxChainEnd && tokens[cursor]?.kind === 'punct' && tokens[cursor]?.value === '+') {
          const nextEnd = advanceConcatOperand(cursor + 1, maxChainEnd);
          if (nextEnd < 0) break;
          cursor = nextEnd;
        }
        if (cursor > firstEnd || (t.kind === 'punct' && t.value === '(')) {
          const resolvedChain = tryResolveConstantStringExpr(tokens, i, cursor, delims, templateNext, constLookup, 0, templateTail);
          if (resolvedChain !== null && resolvedChain.startsWith('notes.')) {
            found.add(resolvedChain);
            i = cursor - 1;
            continue;
          }
        }
      }

      if ((t.kind === 'string' || t.kind === 'template') && t.value.startsWith('notes.')) {
        found.add(t.value);
      } else if (t.kind === 'template_head') {
        const tailIdx = templateTail[i] ?? -1;
        if (tailIdx >= 0) {
          const resolvedTpl = tryResolveConstantStringExpr(tokens, i, tailIdx + 1, delims, templateNext, constLookup, 0, templateTail);
          if (resolvedTpl !== null) {
            if (resolvedTpl.startsWith('notes.')) found.add(resolvedTpl);
          } else if (t.value.startsWith('notes.')) {
            found.add(formatNotesTemplateSpan(text, t, tokens[tailIdx]!));
          }
        }
      }
    }
  }
  return [...found];
}

export function disallowedMeteredNotes(relFromSrc: string, text: string): string[] {
  const calls = meteredNotes(text, { includeUnresolved: true });
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
  const seenFunctions = new Set<string>();
  const seenMeteredKeys = new Set<string>();

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
    const expectedNotesKey = ADAPTER_FUNCTION_NOTES_KEYS.get(fnName.value);
    if (expectedNotesKey === undefined) {
      out.add(`uses unmapped exported adapter function ${fnName.value}`);
      return false;
    }
    if (seenFunctions.has(fnName.value)) {
      out.add(`exports duplicate adapter function ${fnName.value}`);
      return false;
    }
    seenFunctions.add(fnName.value);
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
    if (keyTok.value !== expectedNotesKey || seenMeteredKeys.has(keyTok.value)) {
      out.add(`metered() call in ${fnName.value} must use ${expectedNotesKey}`);
      return false;
    }
    seenMeteredKeys.add(keyTok.value);
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
  const { specifiers: allSpecs, scan } = specifiers(indexText, tokens, delims);

  if (assertSyntax && scan.hasInvalidSyntax) violations.add('contains invalid or unclosed syntax');
  if (scan.hasComputedDynamic) {
    // Package barrel index.ts must never use computed dynamic imports (e.g., import(`./note-ai-${x}`)).
    violations.add('uses computed dynamic import or require inside index.ts');
  }
  if (scan.hasBareRequire) {
    violations.add('uses require alias or bare require reference inside index.ts');
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
  }

  for (const call of scan.dynamicCalls) {
    if (call.fn === 'require' && call.specifier !== null && isNoteAiModelSpecifier(call.specifier)) {
      totalAdapterSpecOccurrences += 1;
      violations.add('imports note-ai-model inside index.ts instead of direct re-export');
      flaggedAdapter = true;
    }
  }

  const mainAdapterSpecs = linearRawSpecifiers(indexText)
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
    normalizedSpec === '@ludy/agent' ||
    normalizedSpec === '@ludy/agent/index.ts' ||
    normalizedSpec === '@ludy/agent/src/index.ts' ||
    normalizedSpec === '@ludy/agent/src/index' ||
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

function decodeRawForScopeCheck(text: string): string {
  const noContinuations = text.replace(/\\(?:\r\n|[\r\n\u2028\u2029])/g, '');
  const unescaped = noContinuations.replace(
    /\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]+)\}|([0-7]{1,3})|([^\r\n\u2028\u2029]))/g,
    (m, x, u4, uVar, oct, single) => {
      if (x || u4 || uVar) {
        const hex = (x ?? u4 ?? uVar) as string;
        const cp = Number.parseInt(hex, 16);
        if (!Number.isFinite(cp) || cp > 0x10ffff) return m;
        return String.fromCodePoint(cp);
      }
      if (oct) {
        return String.fromCharCode(Number.parseInt(oct as string, 8) & 0xff);
      }
      switch (single) {
        case 'n':
          return '\n';
        case 'r':
          return '\r';
        case 't':
          return '\t';
        case 'b':
          return '\b';
        case 'f':
          return '\f';
        case 'v':
          return '\v';
        default:
          return single as string;
      }
    },
  );
  return unescaped.replace(/%([2-7][0-9a-fA-F])/g, (_m, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

const COMPACT_AGENT_OR_ADAPTER_RE = /@(?:ludy|crove)\/?agent|note-?ai-?model|packages\/?agent/;
const RELATIVE_SEGMENT_RE = /(?<![.\w$])\.\.?(?=$|[\s'"`),;:+/])(?:\/[^\s'"`)]*)?/g;
const AGENT_PATH_SEGMENT_RE = /(?:^|\/)agent(?:$|\/)/;
const PACKAGES_DIR_RE = /(?:^|\/)packages\/?$/;

function compactSplitConcatForLeakCheck(raw: string): { compact: string; quotedJoined: string } {
  const chunks: string[] = [];
  const quotePieces: string[] = [];
  let flushStart = 0;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      const gap = skipRawWsAndComments(raw, i + 1, 256);
      if (raw[gap] === '+') {
        const rhsStart = skipRawWsAndComments(raw, gap + 1, 256);
        const rhsCh = raw[rhsStart];
        if (rhsCh === "'" || rhsCh === '"' || rhsCh === '`') {
          chunks.push(raw.slice(flushStart, i));
          i = rhsStart + 1;
          flushStart = i;
          continue;
        }
      }
      // Capture bounded raw short literals separated across statements after syntax errors.
      const scanEnd = Math.min(raw.length, i + 1 + 128);
      let j = i + 1;
      while (j < scanEnd && raw[j] !== ch && raw[j] !== '\n' && raw[j] !== '\r') {
        j += raw[j] === '\\' ? 2 : 1;
      }
      if (j < scanEnd && raw[j] === ch && j > i + 1) {
        quotePieces.push(raw.slice(i + 1, j));
      }
    }
    i += 1;
  }
  if (flushStart < raw.length) chunks.push(raw.slice(flushStart));
  return { compact: chunks.join(''), quotedJoined: quotePieces.join('') };
}

const isAgentOrAdapterTextValue = (val: string, fromRelPath?: string): boolean => {
  const candidates = [val, decodeRawModulePreCollapse(val), normalizeModuleSpecifier(val)];
  for (const cand of candidates) {
    if (!cand) continue;
    if (
      cand.includes('@ludy/agent') ||
      cand.includes('@crove/agent') ||
      cand.includes('note-ai-model') ||
      cand.includes('packages/agent/src/index') ||
      cand.includes('packages/agent/src/note-ai-model') ||
      isAgentBarrel(cand, fromRelPath) ||
      isNoteAiModelSpecifier(cand)
    ) {
      return true;
    }
    if (fromRelPath && cand.startsWith('.')) {
      const baseDir = posix.dirname(fromRelPath.replace(/\\/g, '/'));
      const resolved = posix.normalize(posix.join(baseDir, cand));
      if (resolved === 'packages/agent' || resolved.startsWith('packages/agent/')) return true;
    }
  }
  return false;
};

// Narrows file-wide strict gates (`hasInvalidSyntax`, unresolved `hasComputedDynamic`, `hasBareRequire`, computed
// member access) to workspace non-test files that import or reference `@ludy/agent` (or legacy `@crove/agent`),
// `note-ai-model`, `packages/agent/`, or adapter exports. Direct/escaped/concatenated symbol and specifier checks still
// run on every file, and any escape/continuation/percent-encoded/split reference keeps the strict gates engaged so
// zero bypass coverage is weakened.
function isWorkspaceAdapterLeakRelevant(
  fileText: string,
  toks: readonly Token[],
  specs: readonly string[],
  scan: ModuleScanResult,
  symbolSet: ReadonlySet<string>,
  fromRelPath: string | undefined,
  out: ReadonlySet<string>,
): boolean {
  if (out.size > 0) return true;
  const relFromRoot = fromRelPath?.replace(/\\/g, '/');
  if (relFromRoot && relFromRoot.startsWith('packages/agent/')) return true;
  if (specs.some((spec) => isAgentOrAdapterTextValue(spec, fromRelPath))) return true;

  const relBaseDir = relFromRoot ? posix.dirname(relFromRoot) : null;
  const resolvesUnderPackages = (frag: string): boolean => {
    if (!relBaseDir) return false;
    for (const cand of [frag, decodeRawModulePreCollapse(frag), normalizeModuleSpecifier(frag)]) {
      if (!cand.startsWith('.')) continue;
      const resolved = posix.normalize(posix.join(relBaseDir, cand));
      if (resolved === 'packages' || resolved.startsWith('packages/')) return true;
    }
    return false;
  };

  const literalPieces: string[] = [];
  let sawLudyAt = false;
  let sawCroveAt = false;
  let sawAgentWord = false;
  let sawPackagesPath = false;
  let sawNote = false;
  let sawAi = false;
  let sawNoteAi = false;
  let sawModel = false;

  const recordFragmentFlags = (frag: string): boolean => {
    if (isAgentOrAdapterTextValue(frag, fromRelPath)) return true;
    if (frag.includes('packages/agent')) return true;
    if (frag.startsWith('@ludy/') && '@ludy/agent'.startsWith(frag)) return true;
    if (frag.startsWith('@crove/') && '@crove/agent'.startsWith(frag)) return true;
    if (frag.startsWith('note-ai') && 'note-ai-model'.startsWith(frag)) return true;

    if (frag === '@ludy' || (frag.length >= 2 && '@ludy/'.startsWith(frag))) sawLudyAt = true;
    if (frag === '@crove' || (frag.length >= 3 && '@crove/'.startsWith(frag))) sawCroveAt = true;
    if (AGENT_PATH_SEGMENT_RE.test(frag)) sawAgentWord = true;
    if (PACKAGES_DIR_RE.test(frag) || resolvesUnderPackages(frag)) sawPackagesPath = true;
    if (frag === 'note') sawNote = true;
    else if (frag === 'ai') sawAi = true;
    else if (frag === 'note-ai') sawNoteAi = true;
    else if (frag === 'model') sawModel = true;

    return (
      (sawLudyAt && sawAgentWord) ||
      (sawCroveAt && sawAgentWord) ||
      (sawPackagesPath && sawAgentWord) ||
      (sawNoteAi && sawModel) ||
      (sawNote && sawAi && sawModel)
    );
  };

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (
      t.kind !== 'string' &&
      t.kind !== 'template' &&
      t.kind !== 'template_head' &&
      t.kind !== 'template_middle' &&
      t.kind !== 'template_tail'
    ) {
      continue;
    }
    const v = t.value;
    if (v.length > 0) literalPieces.push(decodeRawModulePreCollapse(v));
    if (recordFragmentFlags(v)) return true;

    if (t.kind === 'string' || t.kind === 'template') {
      let acc = v;
      let j = i;
      while (j + 2 < toks.length && j - i < 32) {
        const op = toks[j + 1]!;
        const rhs = toks[j + 2]!;
        if (op.kind === 'punct' && op.value === '+' && (rhs.kind === 'string' || rhs.kind === 'template')) {
          acc += rhs.value;
          if (recordFragmentFlags(acc)) return true;
          j += 2;
        } else {
          break;
        }
      }
    }
  }

  if (literalPieces.length > 0) {
    const joinedNoSep = literalPieces.join('');
    if (COMPACT_AGENT_OR_ADAPTER_RE.test(joinedNoSep)) return true;
    if (fromRelPath) {
      for (const m of joinedNoSep.matchAll(RELATIVE_SEGMENT_RE)) {
        if (isAgentOrAdapterTextValue(m[0], fromRelPath)) return true;
      }
    }
    for (const sym of symbolSet) {
      if (joinedNoSep.includes(sym)) return true;
    }
  }

  if (scan.hasInvalidSyntax) {
    const decodedRaw = decodeRawForScopeCheck(fileText);
    const { compact: decodedCompact, quotedJoined: rawQuotedJoined } = compactSplitConcatForLeakCheck(decodedRaw);
    const decodedCandidates = [decodedRaw, decodedCompact, rawQuotedJoined].filter(Boolean);
    const matchesDecoded = (candidate: string): boolean =>
      candidate.includes('@ludy/agent') ||
      candidate.includes('@crove/agent') ||
      candidate.includes('note-ai-model') ||
      candidate.includes('packages/agent/src/index') ||
      candidate.includes('packages/agent/src/note-ai-model') ||
      COMPACT_AGENT_OR_ADAPTER_RE.test(candidate) ||
      ((candidate.includes('@ludy') || candidate.includes('@crove') || candidate.includes('packages')) && /\bagent\b/.test(candidate)) ||
      ((candidate.includes('note-ai') || (/\bnote\b/.test(candidate) && /\bai\b/.test(candidate))) && /\bmodel\b/.test(candidate));
    if (decodedCandidates.some(matchesDecoded)) {
      return true;
    }
    for (const rawStr of decodedCandidates) {
      if (fromRelPath) {
        const hasAgentWordInRaw = /\bagent\b/.test(rawStr);
        for (const m of rawStr.matchAll(RELATIVE_SEGMENT_RE)) {
          if (isAgentOrAdapterTextValue(m[0], fromRelPath)) return true;
          if (hasAgentWordInRaw && resolvesUnderPackages(m[0])) return true;
        }
      }
      for (const sym of symbolSet) {
        if (rawStr.includes(sym)) return true;
      }
    }
  }
  return false;
}

function collectComputedBindingAccess(
  toks: readonly Token[],
  delims: DelimiterPairs,
  scan: ModuleScanResult,
  fromRelPath: string | undefined,
  out: Set<string>,
): void {
  const seedBindings = new Set<string>();
  const resolvedCallByOpenParen = new Set<number>();

  for (const decl of scan.importDecls) {
    if (isAgentBarrel(decl.specifier, fromRelPath) || isNoteAiModelSpecifier(decl.specifier)) {
      for (const b of decl.barrelBindings) seedBindings.add(b);
    }
  }
  for (const call of scan.dynamicCalls) {
    if (call.specifier !== null && (isAgentBarrel(call.specifier, fromRelPath) || isNoteAiModelSpecifier(call.specifier))) {
      if (call.boundTarget) seedBindings.add(call.boundTarget);
      if (call.closeParenIdx >= 0) resolvedCallByOpenParen.add(call.closeParenIdx);
    }
  }

  const agentBindings = propagateAliases(seedBindings, scan.aliasEdges);

  const isComputedBracketSpan = (openBracket: number): boolean => {
    const closeBracket = delims.bracket[openBracket] ?? -1;
    if (closeBracket <= openBracket + 1) return false;
    if (closeBracket === openBracket + 2) {
      const inner = toks[openBracket + 1]!;
      if (inner.kind === 'string' || inner.kind === 'template') return false;
    }
    return true;
  };

  for (const closeParen of resolvedCallByOpenParen) {
    let p = closeParen + 1;
    while (p < toks.length && toks[p]?.kind === 'punct' && toks[p]?.value === ')') p += 1;
    const openBracket =
      toks[p]?.kind === 'punct' && toks[p]?.value === '['
        ? p
        : toks[p]?.kind === 'punct' && toks[p]?.value === '?.' && toks[p + 1]?.kind === 'punct' && toks[p + 1]?.value === '['
          ? p + 1
          : -1;
    if (openBracket >= 0 && isComputedBracketSpan(openBracket)) {
      out.add('uses computed property access on @ludy/agent binding');
    }
  }

  if (agentBindings.size === 0 && resolvedCallByOpenParen.size === 0) return;

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i]!;
    if (t.kind === 'ident' && !isMemberPrev(toks, i) && agentBindings.has(t.value)) {
      const openBracket =
        toks[i + 1]?.kind === 'punct' && toks[i + 1]?.value === '['
          ? i + 1
          : toks[i + 1]?.kind === 'punct' && toks[i + 1]?.value === '?.' && toks[i + 2]?.kind === 'punct' && toks[i + 2]?.value === '['
            ? i + 2
            : -1;
      if (openBracket >= 0 && isComputedBracketSpan(openBracket)) {
        out.add('uses computed property access on @ludy/agent binding');
      }
      continue;
    }

    if (
      t.kind === 'ident' &&
      !isMemberPrev(toks, i) &&
      t.value === 'Reflect' &&
      toks[i + 1]?.kind === 'punct' &&
      toks[i + 1]?.value === '.' &&
      toks[i + 2]?.kind === 'ident' &&
      toks[i + 2]?.value === 'get' &&
      toks[i + 3]?.kind === 'punct' &&
      toks[i + 3]?.value === '('
    ) {
      const closeParen = delims.paren[i + 3] ?? -1;
      const target = toks[i + 4];
      if (closeParen > i + 5 && target?.kind === 'ident' && agentBindings.has(target.value) && toks[i + 5]?.value === ',') {
        const keyLen = closeParen - (i + 6);
        const keyTok = toks[i + 6];
        if (!(keyLen === 1 && keyTok && (keyTok.kind === 'string' || keyTok.kind === 'template'))) {
          out.add('uses computed property access on @ludy/agent binding');
        }
      }
      continue;
    }

    if (t.kind === 'punct' && t.value === '{') {
      const closeBrace = delims.brace[i] ?? -1;
      if (closeBrace > i + 2 && toks[closeBrace + 1]?.kind === 'punct' && toks[closeBrace + 1]?.value === '=') {
        let rhs = closeBrace + 2;
        while (rhs < toks.length && ((toks[rhs]?.kind === 'punct' && toks[rhs]?.value === '(') || (toks[rhs]?.kind === 'ident' && toks[rhs]?.value === 'await'))) {
          rhs += 1;
        }
        const rhsTok = toks[rhs];
        let rhsIsBarrel = Boolean(rhsTok?.kind === 'ident' && agentBindings.has(rhsTok.value));
        if (!rhsIsBarrel && rhsTok?.kind === 'ident' && toks[rhs + 1]?.kind === 'punct' && toks[rhs + 1]?.value === '(') {
          const closeCall = delims.paren[rhs + 1] ?? -1;
          if (closeCall >= 0 && resolvedCallByOpenParen.has(closeCall)) rhsIsBarrel = true;
        }
        if (rhsIsBarrel) {
          for (let k = i + 1; k < closeBrace; k += 1) {
            if (toks[k]?.kind === 'punct' && toks[k]?.value === '[') {
              out.add('uses computed property access on @ludy/agent binding');
              break;
            }
          }
        }
      }
    }
  }
}

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
  const delims = pairDelimiters(toks);
  const { specifiers: specs, scan } = specifiers(fileText, toks, delims);
  if (specs.some((spec) => isNoteAiModelSpecifier(spec))) {
    out.add('imports note-ai-model');
  }
  for (const decl of scan.importDecls) {
    if (!isAgentBarrel(decl.specifier, fromRelPath)) continue;
    if (decl.isNamespace) out.add('namespace import from @ludy/agent');
    if (decl.isDefault) out.add('default import from @ludy/agent');
  }
  for (const decl of scan.exportDecls) {
    if (isAgentBarrel(decl.specifier, fromRelPath) && decl.isStar) out.add('export * from @ludy/agent');
  }
  let hasUnresolvedDynamic = false;
  for (const call of scan.dynamicCalls) {
    if (call.specifier !== null) {
      if (isAgentBarrel(call.specifier, fromRelPath)) out.add(`dynamic ${call.fn} from @ludy/agent`);
    } else {
      hasUnresolvedDynamic = true;
    }
  }
  collectSymbolTokenMatches(toks, symbolSet, out);

  if (!isWorkspaceAdapterLeakRelevant(fileText, toks, specs, scan, symbolSet, fromRelPath, out)) {
    return;
  }

  if (assertSyntax && scan.hasInvalidSyntax) out.add('contains invalid or unclosed syntax');
  if (hasUnresolvedDynamic) out.add('uses computed dynamic import or require');
  if (scan.hasBareRequire) out.add('uses require alias or bare require reference');
  collectComputedBindingAccess(toks, delims, scan, fromRelPath, out);
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
    expect(memberVyViolations(`import { Runtime } from '@ludy/kernel-runtime';`)).toEqual(['imports @ludy/kernel-runtime']);
    expect(memberVyViolations(`import { generateText } from 'ai';\nimport z from 'zod';`)).toEqual(['imports ai']);
    expect(memberVyViolations(`import mem from 'mem0ai';`)).toEqual(['imports mem0ai']);
    expect(memberVyViolations(`import { 'Runtime' as R } from '@ludy/kernel-runtime';`)).toEqual([
      'imports @ludy/kernel-runtime',
    ]);
    expect(memberVyViolations(`import { 'a(b' as x } from 'pg';`)).toEqual(['imports pg']);
    expect(memberVyViolations(`import café from 'pg';`)).toEqual(['imports pg']);
    expect(memberVyViolations(`import * as π from 'pg';`)).toEqual(['imports pg']);
    expect(memberVyViolations(`void /[/*]/;\nimport pg from 'pg';\n// */`)).toEqual(['imports pg']);
    expect(memberVyViolations("import { createOpenAICompatible } from '@ai-sdk/\\\nopenai-compatible';")).toContain(
      'imports @ai-sdk/openai-compatible',
    );
    expect(memberVyViolations("import { db } from '@ludy/\\\ndb';")).toContain('imports @ludy/db');
    expect(memberVyViolations("const db = require('@ludy/db/\\\nclient');")).toContain('imports @ludy/db/client');
    expect(memberVyViolations("const mod = await import('@ludy/' + 'db');")).toContain(
      'uses computed dynamic import or require',
    );
    expect(memberVyViolations("const mod = require('./' + x);")).toContain('uses computed dynamic import or require');
    expect(memberVyViolations(`const c = 'notes.todo.create';`)).toEqual(['names the command or path notes.todo.create']);
    expect(memberVyViolations('await runtime.execute(cmd, input, ctx);')).toEqual(['calls execute()']);
    expect(memberVyViolations(`const t = 'crove_kernel.member_vy_result';`)).toContain('names a crove_ table');
    expect(memberVyViolations('const q = `\nINSERT INTO crove_kernel.member_vy_memory\n`;')).toContain('names a crove_ table');
    expect(memberVyViolations(`const t = 'ludy_kernel.member_vy_result';`)).toContain('names a crove_ table');
    expect(memberVyViolations('const q = `\nINSERT INTO ludy_kernel.member_vy_memory\n`;')).toContain('names a crove_ table');
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
    expect(memberVyViolations(`import x from '@ludy/db/../../x';`)).toEqual(['imports @ludy/db/../../x']);
    expect(memberVyViolations(`import x from 'langchain/..';`)).toEqual(['imports langchain/..']);
    expect(memberVyViolations(`require('@ludy/kernel/../../../packages/kernel/src/index.ts')`)).toContain(
      'imports @ludy/kernel/../../../packages/kernel/src/index.ts',
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
        `export function generateNoteSummaryText(config: AiConfig, prompt: { system: string; user: string }, opts: Record<string, unknown>) {`,
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
      modelAdapterViolations(`import { db } from '@ludy/\\\ndb';\n${validAdapter}`),
    ).toContain('imports @ludy/db');
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
        `import { generateText } from 'ai';\nimport { chatModel, type AiConfig } from './index.ts';\nimport { metered } from './meter.ts';\nexport function generateNoteSummaryText(config: typeof import('@ludy/db'), prompt: { system: string; user: string }) { return metered('notes.summary', () => generateText({ model: chatModel(config), system: prompt.system, prompt: prompt.user, maxOutputTokens: 2000 })); }`,
      ),
    ).not.toEqual([]);

    // 1:1 per-function metered('notes.*') binding enforcement (#3581).
    expect(ADAPTER_NOTES_KEYS.size).toBe(ADAPTER_FUNCTION_NOTES_KEYS.size);
    const makeAdapterFn = (fnName: string, key: string): string =>
      [
        `export function ${fnName}(`,
        `  config: AiConfig,`,
        `  prompt: { system: string; user: string },`,
        `  abortSignal: AbortSignal,`,
        `): Promise<{ text: string; usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } }> {`,
        `  return metered('${key}', () =>`,
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
    const adapterImports = [
      `import { generateText } from 'ai';`,
      `import { chatModel, type AiConfig } from './index.ts';`,
      `import { metered } from './meter.ts';`,
    ].join('\n');
    const fullValidAdapter = [
      adapterImports,
      ...[...ADAPTER_FUNCTION_NOTES_KEYS.entries()].map(([fn, key]) => makeAdapterFn(fn, key)),
    ].join('\n');
    expect(modelAdapterViolations(fullValidAdapter)).toEqual([]);
    expect(modelAdapterViolations(`${adapterImports}\n${makeAdapterFn('generateNoteSummaryText', 'notes.todo_suggest')}`)).toEqual([
      'metered() call in generateNoteSummaryText must use notes.summary',
    ]);
    expect(modelAdapterViolations(`${adapterImports}\n${makeAdapterFn('generateTodoSuggestText', 'notes.summary')}`)).toEqual([
      'metered() call in generateTodoSuggestText must use notes.todo_suggest',
    ]);
    expect(modelAdapterViolations(`${adapterImports}\n${makeAdapterFn('generateTodoPlanText', 'notes.summary')}`)).toEqual([
      'metered() call in generateTodoPlanText must use notes.todo_plan',
    ]);
    expect(modelAdapterViolations(`${adapterImports}\n${makeAdapterFn('generateNoteOrganizeText', 'notes.todo_plan')}`)).toEqual([
      'metered() call in generateNoteOrganizeText must use notes.organize',
    ]);
    expect(modelAdapterViolations(`${adapterImports}\n${makeAdapterFn('generateExtraText', 'notes.summary')}`)).toEqual([
      'uses unmapped exported adapter function generateExtraText',
    ]);
    expect(
      modelAdapterViolations(
        `${adapterImports}\n${makeAdapterFn('generateNoteSummaryText', 'notes.summary')}\n${makeAdapterFn('generateNoteSummaryText', 'notes.summary')}`,
      ),
    ).toEqual(['exports duplicate adapter function generateNoteSummaryText']);

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
    expect(workspaceAdapterLeakViolations(`import { generateNoteSummaryText as g } from '@ludy/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(workspaceAdapterLeakViolations(`import { "generateNote\\x53ummaryText" as g } from '@ludy/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(workspaceAdapterLeakViolations(`import { generateNote\\u0053ummaryText as g } from '@ludy/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(workspaceAdapterLeakViolations(`const fn = agent['generateNote' + 'SummaryText'];`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(workspaceAdapterLeakViolations(`import * as agent from '@ludy/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'namespace import from @ludy/agent',
    ]);
    expect(workspaceAdapterLeakViolations(`import agent from '@ludy/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'default import from @ludy/agent',
    ]);
    expect(workspaceAdapterLeakViolations(`export * from '@ludy/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'export * from @ludy/agent',
    ]);
    expect(workspaceAdapterLeakViolations(`const a = await import('@ludy/agent');`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'dynamic import from @ludy/agent',
    ]);
    expect(workspaceAdapterLeakViolations(`const a = await import('@ludy/' + 'agent');`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'dynamic import from @ludy/agent',
    ]);
    expect(workspaceAdapterLeakViolations(`const a = require('@ludy/agent');`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'dynamic require from @ludy/agent',
    ]);
    expect(
      workspaceAdapterLeakViolations(`export * as notesAI from '../../../packages/agent/src/index.ts';`, DEFAULT_ADAPTER_EXPORTS),
    ).toEqual(['export * from @ludy/agent']);
    expect(
      workspaceAdapterLeakViolations(
        `import * as notesAI from '../index.ts';`,
        DEFAULT_ADAPTER_EXPORTS,
        'packages/agent/src/member-vy/note-ai.ts',
      ),
    ).toEqual(['namespace import from @ludy/agent']);
    expect(
      workspaceAdapterLeakViolations(
        `const mod = await import('../../../../packages/agent/src/index.ts');`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toEqual(['dynamic import from @ludy/agent']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div></div>; import { generateNoteSummaryText as summarize } from '@ludy/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <Comp a={1}/>; const D = () => <Other b={2}/>; import { generateNoteSummaryText } from '@ludy/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        "const entry = '@ludy/agent'; const a = await import(entry); const fn = a[`generateNote${'SummaryText'}`];",
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['uses computed dynamic import or require']);
    // Unrelated non-test files with computed dynamic import, unparseable syntax, or require aliases are skipped unless they reference @ludy/agent, note-ai-model, or adapter symbols.
    expect(
      workspaceAdapterLeakViolations(
        `const mod = await import(entry);`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/extension/e2e/extension.spec.ts',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        'const mod = await import(`${base}capture-run.js`);',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/extension/e2e/extension.spec.ts',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const bad = 'unclosed; import { z } from 'zod';`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/unrelated.ts',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const load = require; const x = load('./other');`,
        DEFAULT_ADAPTER_EXPORTS,
        'tools/some-tool.mjs',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <Comp a={1}/>; import { AiBudgetExhaustedError } from '@ludy/agent';`,
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
        `const r = /import(foo)/; const C = () => <Comp a={1}/>; import { generateNoteSummaryText } from '@ludy/agent';`,
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
        `const C = () => <div>don't</div>; import { generateNoteSummaryText } from "@ludy/agent";`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div>don't</div>; import { generateNoteSummaryText } from "@ludy/agent";`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/components/example.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div>don't <span>can't</span></div>; import { generateNoteSummaryText } from '@ludy/agent';`,
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
        `const C = () => <div title="Line 1\nLine 2">don't</div>; import { generateNoteSummaryText } from '@ludy/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/components/example.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const f = <T>(x: T) => x; import { generateNoteSummaryText } from '@ludy/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const bad = 'unclosed; import { generateNoteSummaryText } from '@ludy/agent';`,
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
    ).toEqual(['namespace import from @ludy/agent']);
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
    ).toEqual(['namespace import from @ludy/agent']);
    expect(
      workspaceAdapterLeakViolations(
        `import * as m from '../../../packages/agent/src/index.mts';`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toEqual(['namespace import from @ludy/agent']);
    expect(
      indexReexportViolations(`export { generateNoteSummaryText as g } from './%E0%A4%A/../note-ai-%6dodel.ts';`, sampleSyms),
    ).toEqual(['re-exports note-ai-model under an alias ({ generateNoteSummaryText as g })']);
    // F2: contextual keyword `from` as binding identifier
    expect(memberVyViolations(`const x = 1; import from from 'pg';`)).toEqual(['imports pg']);
    expect(workspaceAdapterLeakViolations(`import from from '@ludy/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([
      'default import from @ludy/agent',
    ]);
    expect(
      workspaceAdapterLeakViolations(`import type from from '@ludy/agent';`, DEFAULT_ADAPTER_EXPORTS),
    ).toEqual(['default import from @ludy/agent']);
    expect(indexReexportViolations(`import from from './note-ai-model.ts';`, sampleSyms)).toEqual([
      'imports note-ai-model inside index.ts instead of direct re-export',
    ]);
    // F3: ASI regex-prefix keywords and speculative division/regex rescan
    expect(memberVyViolations(`debugger\n/[/*]/;\nimport { Runtime } from '@ludy/kernel-runtime';\n// */`)).toEqual([
      'imports @ludy/kernel-runtime',
    ]);
    expect(memberVyViolations(`break\n/[/*]/;\nfetch('https://x.test');\n// */`)).toEqual(['calls the network directly']);
    expect(memberVyViolations(`continue\n/[/*]/;\nawait execute(c);\n// */`)).toEqual(['calls execute()']);
    expect(
      memberVyViolations(`type T = number\n/[/*]/;\nimport { Runtime } from '@ludy/kernel-runtime';\n// */`),
    ).toEqual(['imports @ludy/kernel-runtime']);
    expect(
      memberVyViolations(`const w = n as number & { a: number } / 2 + "/g/*";\nimport { Runtime } from '@ludy/kernel-runtime';\n// */`),
    ).toEqual(['imports @ludy/kernel-runtime']);
    expect(
      orgFeatureViolations(`type T = number\n/[/*]/;\nimport { x } from './member-vy/summary.ts';\n// */`),
    ).toEqual(['imports ./member-vy/summary.ts']);
    expect(
      workspaceAdapterLeakViolations(
        `type T = number\n/[/*]/;\nimport { generateNoteSummaryText } from '@ludy/agent';\n// */`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const w = n as number & { a: number } / 2 + "/g/*";\nimport { generateNoteSummaryText } from '@ludy/agent';\n// */`,
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
      'type G<T> = Array<T>\n/[/*]/;\nimport * as agent from "@ludy/\\\nagent";\nexport const leaked = agent["generateNote" + "SummaryText"];\n// */';
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
    expect(workspaceAdapterLeakViolations(`import { AiBudgetExhaustedError } from '@ludy/agent';`, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);

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

    // CodeRabbit (a): workspaceNonTestSources includes .jsx and exercises workspaceAdapterLeakViolations JSX mode.
    const jsxTmpRoot = mkdtempSync(join(tmpdir(), 'ludy-jsx-scan-'));
    try {
      mkdirSync(join(jsxTmpRoot, 'apps/app/src'), { recursive: true });
      mkdirSync(join(jsxTmpRoot, 'apps/app/test'), { recursive: true });
      const jsxSrcFile = join(jsxTmpRoot, 'apps/app/src/Panel.jsx');
      const jsxTestFile = join(jsxTmpRoot, 'apps/app/test/Panel.jsx');
      writeFileSync(jsxSrcFile, `export const Panel = () => <div>don't</div>;\n`);
      writeFileSync(jsxTestFile, `export const PanelTest = () => <div>test</div>;\n`);
      const discovered = workspaceNonTestSources(jsxTmpRoot).map((f) => relative(jsxTmpRoot, f).replace(/\\/g, '/'));
      expect(discovered).toEqual(['apps/app/src/Panel.jsx']);
    } finally {
      rmSync(jsxTmpRoot, { recursive: true, force: true });
    }
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div>don't</div>; import { generateNoteSummaryText } from '@ludy/agent';`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/Panel.jsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `const C = () => <div>don't</div>;`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/Panel.jsx',
      ),
    ).toEqual([]);

    // CodeRabbit (b) + workspace narrowing: require aliases, bare require, createRequire, and computed/interpolated property access on @ludy/agent bindings.
    const aliasInterpViolations = workspaceAdapterLeakViolations(
      "const load = require; const mod = load('@ludy/agent'); const fn = mod[`generateNote${'SummaryText'}`];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(aliasInterpViolations).toContain('dynamic require from @ludy/agent');
    expect(aliasInterpViolations).toContain('uses require alias or bare require reference');
    expect(aliasInterpViolations).toContain('uses computed property access on @ludy/agent binding');

    const nsInterpViolations = workspaceAdapterLeakViolations(
      "import * as agent from '@ludy/agent'; const fn = agent[`generateNote${suffix}`];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(nsInterpViolations).toContain('namespace import from @ludy/agent');
    expect(nsInterpViolations).toContain('uses computed property access on @ludy/agent binding');

    const defComputedViolations = workspaceAdapterLeakViolations(
      "import agent from '@ludy/agent'; const alias = agent; const fn = alias[propName];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(defComputedViolations).toContain('default import from @ludy/agent');
    expect(defComputedViolations).toContain('uses computed property access on @ludy/agent binding');

    const destructureComputedViolations = workspaceAdapterLeakViolations(
      "import * as agent from '@ludy/agent'; const { [key]: fn } = agent;",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(destructureComputedViolations).toContain('namespace import from @ludy/agent');
    expect(destructureComputedViolations).toContain('uses computed property access on @ludy/agent binding');

    expect(
      workspaceAdapterLeakViolations(
        "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); const m = load('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toContain('uses require alias or bare require reference');
    expect(
      workspaceAdapterLeakViolations(
        "const r = globalThis.require; r('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toContain('uses require alias or bare require reference');
    expect(
      workspaceAdapterLeakViolations(
        "import { AiBudgetExhaustedError, type MisaAmisBlockerKind } from '@ludy/agent'; const arr: MisaAmisBlockerKind[] = []; const cfg = { require: true }; type T = { readonly require: boolean };",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/safe.ts',
      ),
    ).toEqual([]);
    expect(
      memberVyViolations("const load = require; const db = load('@ludy/db');"),
    ).toContain('uses require alias or bare require reference');
    expect(
      indexReexportViolations("export * from './note-ai-model.ts'; const load = require; load('./note-ai-model.ts');", sampleSyms),
    ).toContain('uses require alias or bare require reference inside index.ts');

    // Review fixes B1 & NB2: destructured require/createRequire, globalThis['require'], and import { default as agent }
    const destructuredRequireViolations = workspaceAdapterLeakViolations(
      "const { require: load } = globalThis; const mod = load('@ludy/agent'); const fn = mod[propName];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(destructuredRequireViolations).toContain('uses require alias or bare require reference');
    expect(destructuredRequireViolations).toContain('dynamic require from @ludy/agent');
    expect(destructuredRequireViolations).toContain('uses computed property access on @ludy/agent binding');

    const bracketGlobalRequireViolations = workspaceAdapterLeakViolations(
      "const load = globalThis['require']; const mod = load('@ludy/agent'); const fn = mod[propName];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(bracketGlobalRequireViolations).toContain('uses require alias or bare require reference');
    expect(bracketGlobalRequireViolations).toContain('dynamic require from @ludy/agent');
    expect(bracketGlobalRequireViolations).toContain('uses computed property access on @ludy/agent binding');

    expect(memberVyViolations("const { require: load } = globalThis; const db = load('@ludy/db');")).toContain(
      'uses require alias or bare require reference',
    );
    expect(
      indexReexportViolations(
        "export * from './note-ai-model.ts'; const { require: load } = globalThis; const m = load('./note-ai-model.ts');",
        sampleSyms,
      ),
    ).toContain('uses require alias or bare require reference inside index.ts');
    expect(
      workspaceAdapterLeakViolations(
        "import { default as agent } from '@ludy/agent'; export const f = agent.x;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toContain('default import from @ludy/agent');
    expect(
      workspaceAdapterLeakViolations(
        "import { AiBudgetExhaustedError } from '@ludy/agent'; interface T {\n a: string\n require: boolean\n}",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/safe.ts',
      ),
    ).toEqual([]);
    const typedModAliasViolations = workspaceAdapterLeakViolations(
      "const mod = await import('@ludy/agent'); const m: typeof mod = mod; const fn = m[propName];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(typedModAliasViolations).toContain('uses computed property access on @ludy/agent binding');
    const typedGlobalRequireViolations = workspaceAdapterLeakViolations(
      "const load: NodeRequire | undefined = globalThis['require']; const mod = load('@ludy/agent'); const fn = mod[propName];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(typedGlobalRequireViolations).toContain('uses require alias or bare require reference');
    expect(typedGlobalRequireViolations).toContain('dynamic require from @ludy/agent');
    expect(typedGlobalRequireViolations).toContain('uses computed property access on @ludy/agent binding');
    expect(memberVyViolations("const load = (globalThis)['require']; const db = load('@ludy/db');")).toContain(
      'uses require alias or bare require reference',
    );
    expect(memberVyViolations("const load = (globalThis).require; const db = load('@ludy/db');")).toContain(
      'uses require alias or bare require reference',
    );
    expect(memberVyViolations("const [{ require: load }] = [globalThis]; const db = load('@ludy/db');")).toContain(
      'uses require alias or bare require reference',
    );
    expect(
      indexReexportViolations(
        "export * from './note-ai-model.ts'; const [{ ['require']: load }] = [globalThis]; load('./note-ai-model.ts');",
        sampleSyms,
      ),
    ).toContain('uses require alias or bare require reference inside index.ts');
    expect(
      memberVyViolations("import * as nm from 'node:module'; const load = nm.createRequire(import.meta.url); const db = load('@ludy/db');"),
    ).toContain('uses require alias or bare require reference');
    expect(
      memberVyViolations("import { \"createRequire\" as mk } from 'node:module'; const load = mk(import.meta.url); const db = load('@ludy/db');"),
    ).toContain('uses require alias or bare require reference');
    expect(
      workspaceAdapterLeakViolations(
        "function f(a = [{ require: true }]) { return a; }\nconst g = ({ a = [{ require: true }] }) => a;\nconst h = (a = { require: 1, createRequire: 2 }) => a;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/safe.ts',
      ),
    ).toEqual([]);
    const castBracketRequireViolations = workspaceAdapterLeakViolations(
      "const load = (globalThis as any)['require']; const mod = load('@ludy/agent'); const fn = mod[propName];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(castBracketRequireViolations).toContain('uses require alias or bare require reference');
    expect(castBracketRequireViolations).toContain('dynamic require from @ludy/agent');
    expect(castBracketRequireViolations).toContain('uses computed property access on @ludy/agent binding');
    expect(
      workspaceAdapterLeakViolations(
        "const load = (globalThis as any).require; load('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toContain('dynamic require from @ludy/agent');
    expect(
      workspaceAdapterLeakViolations(
        "const load = (globalThis as any)!.require; load('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toContain('dynamic require from @ludy/agent');
    const hostAliasRequireViolations = workspaceAdapterLeakViolations(
      "const g = globalThis; const a = g.require('@ludy/agent'); const fn = a[propName];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(hostAliasRequireViolations).toContain('uses require alias or bare require reference');
    expect(hostAliasRequireViolations).toContain('dynamic require from @ludy/agent');
    expect(hostAliasRequireViolations).toContain('uses computed property access on @ludy/agent binding');
    expect(memberVyViolations("const g = globalThis; const db = g.require('@ludy/db');")).toContain('imports @ludy/db');
    const modAliasViolations = workspaceAdapterLeakViolations(
      "import mod from 'node:module'; const m2 = mod; const load = m2.createRequire(import.meta.url); const a = load('@ludy/agent'); const fn = a[propName];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/kernel/src/routes/notes.ts',
    );
    expect(modAliasViolations).toContain('uses require alias or bare require reference');
    expect(modAliasViolations).toContain('dynamic require from @ludy/agent');
    expect(modAliasViolations).toContain('uses computed property access on @ludy/agent binding');
    expect(
      memberVyViolations("import mod from 'node:module'; const m2 = mod; const load = m2.createRequire(import.meta.url); const db = load('@ludy/db');"),
    ).toContain('imports @ludy/db');
    expect(
      memberVyViolations("const nm = await import('node:module'); const load = nm.createRequire(import.meta.url); const db = load('@ludy/db');"),
    ).toContain('imports @ludy/db');
    expect(
      memberVyViolations("const nm = require('node:module'); const load = nm.createRequire(import.meta.url); const db = load('@ludy/db');"),
    ).toContain('imports @ludy/db');
    expect(
      memberVyViolations("const load = (await import('node:module')).createRequire(import.meta.url); const db = load('@ludy/db');"),
    ).toContain('imports @ludy/db');
    expect(
      workspaceAdapterLeakViolations(
        "import mod from 'node:module'; const load = mod.createRequire(import.meta.url); load('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toContain('dynamic require from @ludy/agent');
    expect(
      workspaceAdapterLeakViolations(
        "import mod, { createRequire as cr } from 'module'; mod.createRequire(import.meta.url)('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toContain('dynamic require from @ludy/agent');
    expect(
      workspaceAdapterLeakViolations(
        "import { default as mod } from 'node:module'; const load = mod.createRequire(import.meta.url); load('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toContain('dynamic require from @ludy/agent');
    expect(
      workspaceAdapterLeakViolations(
        "const load = require!; load('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toContain('dynamic require from @ludy/agent');
    expect(
      workspaceAdapterLeakViolations(
        "const load = createRequire!(import.meta.url); load('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toContain('dynamic require from @ludy/agent');
    expect(
      workspaceAdapterLeakViolations(
        "const mk = createRequire; const load = mk!(import.meta.url); load('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toContain('dynamic require from @ludy/agent');
    expect(
      workspaceAdapterLeakViolations(
        "require!('@ludy/agent');",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/kernel/src/routes/notes.ts',
      ),
    ).toContain('dynamic require from @ludy/agent');

    // Narrowed workspace scan retains zero relaxation for escaped/split/concatenated/relative @ludy/agent and note-ai-model references (including B2 & NB5 .jsx matrix).
    expect(
      workspaceAdapterLeakViolations(
        "const scope = '@ludy'; const sep = 'x'; const sub = '/agent'; const a = await import(`${scope}${sub}`);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "const a = '@lu'; const sep = 'x'; const b = 'dy/agent'; const m = await import(`${a}${b}`);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "const base = '../../../packages/'; const sep = 'x'; const tail = 'agent/src/index.ts'; const m = await import(`${base}${tail}`);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "const m = await import(['../../../packages', 'x', '../agent/src/index.ts'].join('/'));",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "const entry = '@ludy/' + 'agent'; const a = await import(entry);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "const pkg = ['@ludy', 'agent'].join('/'); const a = await import(pkg);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "const prefix = '@ludy/'; const a = await import(`${prefix}agent`);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "const scope = '@ludy'; const a = await import(`${scope}/agen${'t'}`);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "const pkg = ['@lu', 'dy/ag', 'ent'].join(''); const a = await import(pkg);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    const splitLoadArrayViolations = workspaceAdapterLeakViolations(
      "const load = require; const mod = load(['@lu' + 'dy', 'agent'].join('/')); const fn = mod[k];",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/app/src/sneaky.ts',
    );
    expect(splitLoadArrayViolations).toContain('uses require alias or bare require reference');
    expect(splitLoadArrayViolations).toContain('uses computed dynamic import or require');
    expect(
      workspaceAdapterLeakViolations(
        "const mod = await import(`../../../pack${'ages'}/agent/src/index.ts`);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "const up = '../..'; await import(`${up}/agent/src/index.ts`);",
        DEFAULT_ADAPTER_EXPORTS,
        'packages/kernel/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "import { util } from '../..';",
        DEFAULT_ADAPTER_EXPORTS,
        'packages/kernel/src/ok.ts',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        `const x = \`unclosed\nconst m = await import("@ludy/" + "agent");`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toEqual(['contains invalid or unclosed syntax']);
    expect(memberVyViolations('of! / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(memberVyViolations('({}) && {}! / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(orgFeatureViolations('of! / Number(import("./member-vy/" + "x.ts")) / 2;').length).toBeGreaterThan(0);
    expect(orgFeatureViolations('({}) && {}! / Number(import("./member-vy/" + "x.ts")) / 2;').length).toBeGreaterThan(0);
    expect(
      indexReexportViolations('export * from "./ok.ts"; of! / Number(import("./note-ai-model." + "ts")) / 2;', sampleSyms).length,
    ).toBeGreaterThan(0);
    expect(
      indexReexportViolations('export * from "./ok.ts"; ({}) && {}! / Number(import("./note-ai-model." + "ts")) / 2;', sampleSyms).length,
    ).toBeGreaterThan(0);
    expect(importsNoteAiModel('of! / Number(import("./note-ai-model." + "ts")) / 2;')).toBe(true);
    expect(importsNoteAiModel('({}) && {}! / Number(import("./note-ai-model." + "ts")) / 2;')).toBe(true);
    expect(
      workspaceAdapterLeakViolations(
        'of! / Number(import("@ludy/" + "agent")) / 2;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        '({}) && {}! / Number(import("@ludy/" + "agent")) / 2;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(disallowedMeteredNotes('other.ts', 'of! / Number(metered("notes." + "a", fn)) / 2;')).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.ts', '({}) && {}! / Number(metered("notes." + "a", fn)) / 2;')).toEqual(['notes.a']);
    expect(memberVyViolations('const x = 1 as any | void / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(memberVyViolations('(1 as any) satisfies any | void / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(orgFeatureViolations('const x = 1 as any | void / Number(import("./member-vy/" + "x.ts")) / 2;').length).toBeGreaterThan(0);
    expect(orgFeatureViolations('(1 as any) satisfies any | void / Number(import("./member-vy/" + "x.ts")) / 2;').length).toBeGreaterThan(0);
    expect(
      indexReexportViolations('export * from "./ok.ts"; const x = 1 as any | void / Number(import("./note-ai-model." + "ts")) / 2;', sampleSyms).length,
    ).toBeGreaterThan(0);
    expect(
      indexReexportViolations('export * from "./ok.ts"; (1 as any) satisfies any | void / Number(import("./note-ai-model." + "ts")) / 2;', sampleSyms).length,
    ).toBeGreaterThan(0);
    expect(importsNoteAiModel('const x = 1 as any | void / Number(import("./note-ai-model." + "ts")) / 2;')).toBe(true);
    expect(importsNoteAiModel('(1 as any) satisfies any | void / Number(import("./note-ai-model." + "ts")) / 2;')).toBe(true);
    expect(
      workspaceAdapterLeakViolations(
        'const x = 1 as any | void / Number(import("@ludy/" + "agent")) / 2;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        '(1 as any) satisfies any | void / Number(import("@ludy/" + "agent")) / 2;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(disallowedMeteredNotes('other.ts', 'const x = 1 as any | void / Number(metered("notes." + "a", fn)) / 2;')).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.ts', '(1 as any) satisfies any | void / Number(metered(`no${part}`, fn)) / 2;')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(
      workspaceAdapterLeakViolations(
        `const bad = 'unclosed; import { x } from "@ludy/\\agent";`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toContain('contains invalid or unclosed syntax');
    expect(
      workspaceAdapterLeakViolations(
        `const bad = 'unclosed; import { x } from "@ludy/\\x61gent";`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ),
    ).toContain('contains invalid or unclosed syntax');
    expect(
      workspaceAdapterLeakViolations(
        "const mod = await import('../' + part);",
        DEFAULT_ADAPTER_EXPORTS,
        'packages/agent/src/member-vy/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    expect(
      workspaceAdapterLeakViolations(
        "const mod = await import('../../agent/src/' + part);",
        DEFAULT_ADAPTER_EXPORTS,
        'packages/other/src/sneaky.ts',
      ),
    ).toEqual(['uses computed dynamic import or require']);
    const jsxMatrixViolations = workspaceAdapterLeakViolations(
      "export function Panel() { const load = require; const m = load('@ludy/agent'); const f = m[propName]; return <div>{f}</div>; }",
      DEFAULT_ADAPTER_EXPORTS,
      'apps/app/src/Panel.jsx',
    );
    expect(jsxMatrixViolations).toContain('uses require alias or bare require reference');
    expect(jsxMatrixViolations).toContain('dynamic require from @ludy/agent');
    expect(jsxMatrixViolations).toContain('uses computed property access on @ludy/agent binding');

    // CodeRabbit (c) & B3: constant/concatenated/template resolution, aliased/sequence/Reflect calls, precedence, lexical scopes, parens, TS casts
    expect(disallowedMeteredNotes('other.ts', "await metered('notes.' + 'summary', fn)")).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('other.ts', "await metered('no' + 'tes.todo_suggest', fn)")).toEqual(['notes.todo_suggest']);
    expect(disallowedMeteredNotes('other.ts', 'await metered(`notes.${"todo_plan"}`, fn)')).toEqual(['notes.todo_plan']);
    expect(disallowedMeteredNotes('other.ts', 'await metered(`no${"tes"}.organize`, fn)')).toEqual(['notes.organize']);
    expect(
      disallowedMeteredNotes('other.ts', "const p = 'no'; const q = 'tes.'; await metered(p + q + 'summary', fn)"),
    ).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('other.ts', "const k = 'no' + 'tes.summary'; m(k, fn)")).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('other.ts', 'await metered(dynamicKey, fn)')).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'await metered(`no${part}`, fn)')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'const m = metered; m(dynamicKey, fn);')).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'const m = metered; m(`no${part}`, fn);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', "import { metered as m } from './index.ts'; m(dynamicKey, fn);")).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', "import * as m from './meter.ts'; m.metered(dynamicKey, fn);")).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', '(metered)(dynamicKey, fn);')).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', '(0, metered)(dynamicKey, fn);')).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'metered?.<Out>(dynamicKey, fn);')).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'metered.call(null, dynamicKey, fn);')).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'metered.apply(null, [dynamicKey, fn]);')).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'Reflect.apply(metered, null, [dynamicKey, fn]);')).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', "await metered('finance.' + '' && `no${y}`, fn)")).toEqual([
      'unresolved metered key (`no${y}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', "await metered('finance.' + '' ? `no${y}` : 'other', fn)")).toEqual([
      'unresolved metered key (`no${y}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', "await metered(flag ? 'finance.a' : 'finance.b', fn)")).toEqual([]);
    expect(
      disallowedMeteredNotes(
        'other.ts',
        "function h() { const k = 'finance.overview_explain'; return k; } export function run(k: AiFeature) { return metered(k, fn); }",
      ),
    ).toEqual(['unresolved metered key (k)']);
    expect(
      disallowedMeteredNotes('other.ts', "import { metered as m } from './meter.ts'; const a = 'no', b = 'tes.summary'; m(a + b, fn);"),
    ).toEqual(['notes.summary']);
    expect(notesKeyLiterals("const k = ('no' + 'tes.summary').trim();")).toEqual(['notes.summary']);
    expect(notesKeyLiterals("const k = ('no' + 'tes.summary');")).toEqual(['notes.summary']);
    expect(notesKeyLiterals("const k = 'no' + ('tes.' + 'summary');")).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('other.ts', "await metered('finance.overview_explain' as AiFeature, fn)")).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', "await metered('finance.overview_explain' satisfies AiFeature, fn)")).toEqual([]);
    expect(disallowedMeteredNotes('note-ai-model.ts', "await metered('notes.summary' as AiFeature, fn)")).toEqual([]);
    expect(disallowedMeteredNotes('note-ai-model.ts', "await metered('notes.' + 'summary', fn)")).toEqual([]);
    expect(disallowedMeteredNotes('note-ai-model.ts', 'await metered(`notes.${"todo_suggest"}`, fn)')).toEqual([]);
    expect(disallowedMeteredNotes('note-ai-model.ts', "await metered('notes.' + 'other', fn)")).toEqual(['notes.other']);
    expect(disallowedMeteredNotes('note-ai-model.ts', 'await metered(dynamicKey, fn)')).toEqual([
      'unresolved metered key (dynamicKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', "await metered('finance.' + suffix, fn)")).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'await metered(`meetings.${kind}`, fn)')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', "const m: typeof metered = metered; m(`no${part}`, fn);")).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(
      disallowedMeteredNotes('other.ts', "import * as m from './meter.ts'; const f = m.metered.bind(null); f(`no${part}`, fn);"),
    ).toEqual(['unresolved metered key (`no${part}`)']);
    expect(disallowedMeteredNotes('other.ts', 'await (metered)(`no${part}`, fn);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'return (0, metered)(`no${part}`, fn);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', '(metered as any)(`no${part}`, fn);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', '(metered!)(`no${part}`, fn);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'Reflect.apply(metered as any, null, [`no${part}`, fn]);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', "Reflect.apply(metered, null, ['finance.a'])")).toEqual([]);
    expect(meteredNotes("Reflect.apply(metered, null, ['notes.summary'])")).toEqual(['notes.summary']);
    expect(meteredNotes("Reflect.apply(metered.bind(null), null, ['notes.summary'])")).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('other.ts', 'Reflect.apply(metered.bind(null), null, [`no${part}`, fn]);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', '(metered.bind(null))(`no${part}`, fn);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(meteredNotes("(metered.bind(null))('notes.summary')")).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('other.ts', 'const f = (0, metered); f(`no${part}`, fn);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(
      disallowedMeteredNotes(
        'other.ts',
        "import * as m from './meter.ts'; const f = (0, m.metered.bind(null)); f(`no${part}`, fn);",
      ),
    ).toEqual(['unresolved metered key (`no${part}`)']);
    expect(disallowedMeteredNotes('other.ts', 'metered!(`no${part}`, fn);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(
      disallowedMeteredNotes('other.ts', "import * as m from './meter.ts'; m.metered!(`no${part}`, fn);"),
    ).toEqual(['unresolved metered key (`no${part}`)']);
    expect(disallowedMeteredNotes('other.ts', 'metered!<Out>(`no${part}`, fn);')).toEqual([
      'unresolved metered key (`no${part}`)',
    ]);
    expect(
      disallowedMeteredNotes('other.ts', "import * as m from './meter.ts'; m.metered!.bind(null)(`no${part}`, fn);"),
    ).toEqual(['unresolved metered key (`no${part}`)']);
    expect(meteredNotes("const a = 'x' as const\nk = 'notes.summary'; metered(k, fn);")).toEqual([]);
    expect(meteredNotes("const a = 'notes.' as const\nconst k = a + 'summary'; metered(k, fn);")).toEqual(['notes.summary']);
    expect(
      disallowedMeteredNotes('other.ts', "export function run(key: AiFeature) { return metered(('finance.' + '', key), fn); }"),
    ).toEqual(['unresolved metered key (key)']);
    expect(disallowedMeteredNotes('other.ts', "metered(('finance.' + '', `no${y}`), fn);")).toEqual([
      'unresolved metered key (`no${y}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', "metered((k = 'finance.' + '', `no${y}`), fn);")).toEqual([
      'unresolved metered key (`no${y}`)',
    ]);
    expect(disallowedMeteredNotes('other.ts', "metered(('finance.' | 0, key), fn);")).toEqual([
      'unresolved metered key (key)',
    ]);
    expect(disallowedMeteredNotes('other.ts', "metered(('finance.' + '', 'finance.a'), fn);")).toEqual([]);
    expect(
      disallowedMeteredNotes('other.ts', "const b = 'finance.a'; const f = (a = x < y, b: AiFeature) => metered(b, fn);"),
    ).toEqual(['unresolved metered key (b)']);
    expect(
      disallowedMeteredNotes('other.ts', "let a = 1; const x = 'finance.a', k = 'finance.b'; metered(k, fn);"),
    ).toEqual([]);
    expect(
      disallowedMeteredNotes('other.ts', "const unused = 'x' as const, k = 'finance.a'; metered(k, fn);"),
    ).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', "{ const k = 'finance.a'; metered(k, fn) }")).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', "const k = 'finance.a'; metered(k, fn)")).toEqual([]);
    expect(notesKeyLiterals("const k = x + ('no' + 'tes.summary');")).toEqual(['notes.summary']);
    expect(notesKeyLiterals("const k = 1 + 'no' + 'tes.summary';")).toEqual(['notes.summary']);
    expect(notesKeyLiterals("export const KEY = ('x' + 'notes.secret').slice(1);")).toEqual(['notes.secret']);
    expect(notesKeyLiterals('export const x = "prefix:" + "notes.secret";')).toEqual(['notes.secret']);
    expect(notesKeyLiterals('export const KEY = (`x${"notes.secret"}`).slice(1);')).toEqual(['notes.secret']);
    expect(notesKeyLiterals('const a = ("x" + "notes.summary");')).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('other.ts', "export const KEY = ('x' + 'notes.secret').slice(1);")).toEqual(['notes.secret']);
    expect(disallowedMeteredNotes('other.ts', 'metered(`finance.${k}`.slice(8), fn)')).toEqual([
      'unresolved metered key (`finance.${k}`.slice(8))',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'metered(`x${k}`.slice(1), fn)')).toEqual([
      'unresolved metered key (`x${k}`.slice(1))',
    ]);
    const slicedTplNotes = disallowedMeteredNotes('other.ts', 'metered(`x${("a" + "notes.secret").slice(1)}`.slice(1), fn)');
    expect(slicedTplNotes).toContain('notes.secret');
    expect(slicedTplNotes.some((v) => v.startsWith('unresolved metered key'))).toBe(true);
    expect(disallowedMeteredNotes('meter.ts', readFileSync(join(SRC, 'meter.ts'), 'utf8'))).toEqual([]);

    // 500 KB linear-scaling tests (must finish well below 15_000 ms without quadratic backtracking)
    const halfMbDiv = 'a / '.repeat(125_000);
    const halfMbSlashComments = `${'a/'.repeat(50_000)}${'/**/'.repeat(50_000)}`;
    const halfMbMetered = 'metered<'.repeat(62_500);
    const halfMbMeteredParens = 'metered('.repeat(62_500);
    const nestedBareParens = `${'('.repeat(125_000)}x${')'.repeat(125_000)}`;
    const balancedMetered = `${'metered<'.repeat(30_000)}${'>'.repeat(30_000)}`;
    const nestedMeteredParens = `${'metered('.repeat(20_000)}x${')'.repeat(20_000)}`;
    const nestedTemplateMetered = `${'metered(`notes.${'.repeat(24_000)}x${'}`)'.repeat(24_000)}`;
    const nestedTemplateCallee = `${'(`a${'.repeat(15_000)}metered${'}`)(x)'.repeat(15_000)}`;
    const nestedArrowTemplateDefaults = `${'((a = `${1, '.repeat(7_500)}1${'}`) => 1)'.repeat(7_500)}`;
    const nestedImports = `${'import('.repeat(20_000)}x${')'.repeat(20_000)}`;
    const nestedImportBraces = 'import { '.repeat(20_000);
    const halfMbImportX = '\nimport x'.repeat(62_500);
    const halfMbFromQuote = "import from '".repeat(38_500);
    const halfMbNewlineFromQuote = "\nimport from '".repeat(35_700);
    const halfMbFromWs = 'import from '.repeat(41_666);
    const halfMbSingleQuoteImports = "import('a');".repeat(41_000);
    const halfMbSingleQuoteFroms = "import x from 'a';\n".repeat(26_000);
    const halfMbTypedConst = 'const x: '.repeat(55_000);
    const halfMbGenericConst = 'const x: Foo<'.repeat(38_000);
    const halfMbFanoutAlias = Array.from({ length: 50_000 }, (_, idx) => `v${idx}=x;`).join('');
    const nestedArrowParams = `${'(a = '.repeat(15_000)}1${') => 1'.repeat(15_000)}`;
    const nestedCommaSeqCall = `${'(0, '.repeat(15_000)}metered${')(x)'.repeat(15_000)}`;
    const nestedCommaSeqNoCall = `${'(0, '.repeat(15_000)}otherFn${')(x)'.repeat(15_000)}`;
    const nestedDestructDefault = `${'({ a = '.repeat(15_000)}1${' } = x)'.repeat(15_000)}`;
    const t0 = performance.now();
    expect(stripComments(halfMbDiv)).toHaveLength(halfMbDiv.length);
    expect(stripComments(halfMbSlashComments)).toHaveLength(halfMbSlashComments.length);
    expect(meteredNotes(halfMbDiv)).toEqual([]);
    expect(meteredNotes(halfMbSlashComments)).toEqual([]);
    expect(meteredNotes(halfMbMetered)).toEqual([]);
    expect(meteredNotes(halfMbMeteredParens)).toEqual([]);
    expect(meteredNotes(balancedMetered)).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', halfMbTypedConst)).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', halfMbGenericConst)).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', nestedArrowParams)).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', nestedArrowTemplateDefaults)).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', nestedCommaSeqCall)).toEqual(['unresolved metered key (x)']);
    expect(disallowedMeteredNotes('other.ts', nestedCommaSeqNoCall)).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', nestedDestructDefault)).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', nestedMeteredParens).length).toBeGreaterThan(0);
    expect(disallowedMeteredNotes('other.ts', nestedTemplateCallee)).toEqual([]);
    expect(meteredNotes(nestedTemplateCallee)).toEqual([]);
    expect(notesKeyLiterals(nestedTemplateCallee)).toEqual([]);
    expect(meteredNotes(nestedTemplateMetered).some((k) => k.startsWith('notes.'))).toBe(true);
    expect(notesKeyLiterals(halfMbDiv)).toEqual([]);
    expect(notesKeyLiterals(nestedTemplateMetered).some((k) => k.startsWith('notes.'))).toBe(true);
    expect(specifiers(halfMbDiv).specifiers).toEqual([]);
    expect(specifiers(nestedBareParens).specifiers).toEqual([]);
    expect(specifiers(halfMbImportX).specifiers).toEqual([]);
    expect(linearRawSpecifiers(halfMbFromQuote)).toHaveLength(1);
    expect(new Set(linearRawSpecifiers(halfMbNewlineFromQuote))).toEqual(new Set(['\nimport from ']));
    expect(linearRawSpecifiers(halfMbFromWs)).toEqual([]);
    expect(linearRawSpecifiers(halfMbSingleQuoteImports)).toHaveLength(41_000);
    expect(linearRawSpecifiers(halfMbSingleQuoteFroms)).toHaveLength(26_000);
    expect(specifiers(nestedImports).scan.hasComputedDynamic).toBe(true);
    expect(specifiers(nestedImportBraces).specifiers).toEqual([]);
    expect(modelAdapterViolations(halfMbDiv)).not.toEqual([]);
    expect(workspaceAdapterLeakViolations(halfMbDiv, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);
    expect(workspaceAdapterLeakViolations(nestedBareParens, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);
    expect(workspaceAdapterLeakViolations(nestedArrowTemplateDefaults, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);
    expect(workspaceAdapterLeakViolations(halfMbFanoutAlias, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);
    expect(workspaceAdapterLeakViolations(nestedDestructDefault, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);
    expect(indexReexportViolations(halfMbDiv, DEFAULT_ADAPTER_EXPORTS)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(15_000);
  }, 30_000);

  it('verifies linearRawSpecifiers supersedes main regex across normal, escaped, malformed, and fuzz inputs', () => {
    const LEGACY_MAIN_SPECIFIER_RE =
      /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
    const legacyMainSpecifiers = (text: string): string[] =>
      [...text.matchAll(LEGACY_MAIN_SPECIFIER_RE)].map((m) => (m[1] ?? m[2] ?? m[3]) as string);

    const curatedCases = [
      `import { a } from 'zod';\n// from 'ai'`,
      `import { a } from 'zod'\n// comment mentioning from 'ai'`,
      `import café from 'pg';\nexport * from '@ludy/db';`,
      `import { 'a(b' as x } from '@ai-sdk/\\\nopenai-compatible';`,
      `import p from 'pg";`,
      `import x from '' from 'pg';`,
      `import x from ''' from 'pg';`,
      `import x from 'a;b';`,
      `import x\nimport y from '@ludy/kernel';`,
      `$import('ai'); $require('pg');`,
      `import('a\nimport x from "pg")');`,
      `const f = import('a\nexport x from "pg")');`,
      `import x from '\n\u2028from 'pg';`,
      `import x\r\nfrom "mem0ai";`,
      `import x from '%6dem0ai/../zod';`,
      `import a from 'one'; import b from 'two';`,
      `import { a, import('ai') } from 'zod';`,
      `import x from '\\x70g';`,
    ];
    for (const sample of curatedCases) {
      const expected = legacyMainSpecifiers(sample);
      const actual = new Set(linearRawSpecifiers(sample));
      for (const item of expected) {
        expect(actual.has(item), `missing "${item}" on curated sample: ${JSON.stringify(sample)}`).toBe(true);
      }
    }
    expect(linearRawSpecifiers(`import { a } from 'zod'\n// comment mentioning from 'ai'`)).toEqual(['zod']);

    let seed = 0x517cc1b7;
    const nextRand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const corpusTokens = [
      'import',
      'export',
      'from',
      'import(',
      'require(',
      ';',
      '\n',
      '\r',
      ' ',
      '\t',
      '\u2028',
      "'",
      '"',
      '(',
      ')',
      'x',
      '$',
      '_',
      '\\',
      'pg',
      'ai',
      '@ludy/db',
      'note-ai-model',
    ];
    for (let iter = 0; iter < 2_500; iter += 1) {
      const count = 1 + (nextRand() % 28);
      let s = '';
      for (let k = 0; k < count; k += 1) {
        s += corpusTokens[nextRand() % corpusTokens.length]!;
      }
      const expected = legacyMainSpecifiers(s);
      const actual = new Set(linearRawSpecifiers(s));
      for (const item of expected) {
        expect(actual.has(item), `fuzz iter ${iter} missing "${item}" on ${JSON.stringify(s)}`).toBe(true);
      }
    }
  });

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
    const adapterBad = [...MODEL_ADAPTERS].flatMap((rel) => {
      const file = join(SRC, rel);
      if (!existsSync(file)) return [`${relative(ROOT, file)}: missing required adapter file`];
      return modelAdapterViolations(readText(file)).map((v) => `${relative(ROOT, file)}: ${v}`);
    });
    expect(adapterBad, 'notes ModelPort adapter violates thin-adapter rules').toEqual([]);
    const adapterImporters = srcFiles
      .filter((file) => relFromSrc(file) !== 'index.ts' && relFromSrc(file) !== 'note-ai-model.ts')
      .filter((file) => importsNoteAiModel(readText(file)))
      .map((file) => relative(ROOT, file));
    expect(adapterImporters, 'only packages/agent/src/index.ts may import note-ai-model').toEqual([]);

    const adapterPath = join(SRC, 'note-ai-model.ts');
    expect(existsSync(adapterPath), 'packages/agent/src/note-ai-model.ts must exist').toBe(true);
    const adapterDeclaredExports = adapterExports(readText(adapterPath));
    expect(adapterDeclaredExports.length, 'note-ai-model.ts must export its runtime helpers directly').toBeGreaterThan(0);
    expect(ADAPTER_NOTES_KEYS.size, 'ADAPTER_FUNCTION_NOTES_KEYS must remain 1:1').toBe(ADAPTER_FUNCTION_NOTES_KEYS.size);
    expect([...adapterDeclaredExports].sort(), 'note-ai-model.ts exports must match ADAPTER_FUNCTION_NOTES_KEYS 1:1').toEqual(
      [...ADAPTER_FUNCTION_NOTES_KEYS.keys()].sort(),
    );
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

  it('closes parser P3 gaps without relaxing rules or degrading O(N) scaling (#3518, #5035)', () => {
    // 1. scanRegexAsDivision preserves includeUnresolved consistency.
    expect(meteredNotes('x / metered(dynKey, fn) / 2', { includeUnresolved: true })).toEqual([
      'unresolved metered key (dynKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'x / metered(dynKey, fn) / 2')).toEqual([
      'unresolved metered key (dynKey)',
    ]);

    // 2. Unassigned inline (await import('node:module')).createRequire(...) and require('node:module').createRequire(...) are caught.
    for (const inlineCreateReq of [
      "(await import('node:module')).createRequire(import.meta.url)('@ludy/db');",
      "require('node:module').createRequire(import.meta.url)('@ludy/db');",
      "(await import('module'))?.['createRequire'](import.meta.url)('@ludy/db');",
    ]) {
      const violations = memberVyViolations(inlineCreateReq);
      expect(violations, inlineCreateReq).toContain('imports @ludy/db');
      expect(violations, inlineCreateReq).toContain('uses require alias or bare require reference');
    }

    // 3. collectScopedConstBindings handles generic block fns, inline object-union/conditional return types, and braceless for + if/else loops.
    expect(
      disallowedMeteredNotes('other.ts', "const k = 'finance.a'; function run<T>(k: T) { metered(k, fn); }"),
    ).toEqual(['unresolved metered key (k)']);
    expect(
      disallowedMeteredNotes(
        'other.ts',
        "const k = 'finance.a'; function run(k: string): { a: number } | { b: string } { metered(k, fn); return { a: 1 }; }",
      ),
    ).toEqual(['unresolved metered key (k)']);
    expect(
      disallowedMeteredNotes(
        'other.ts',
        "const k = 'finance.a'; function run<T>(k: T): T extends string ? { ok: true } : { ok: false } { metered(k, fn); return { ok: false }; }",
      ),
    ).toEqual(['unresolved metered key (k)']);
    expect(
      disallowedMeteredNotes(
        'other.ts',
        "const k = 'finance.a'; for (const k of items) metered(k, fn); metered(k, fn);",
      ),
    ).toEqual(['unresolved metered key (k)']);
    expect(
      meteredNotes(
        "const k = 'notes.secret'; for (const k of items)\n  if (cond)\n    other(k);\n  else\n    metered(k, fn);",
        { includeUnresolved: true },
      ),
    ).toEqual(['unresolved metered key (k)']);
    expect(
      meteredNotes(
        "const k = 'notes.secret'; for (const k of items)\n  if (cond) x = { a: 1 };\n  else metered(k, fn);\nmetered(k, fn);",
        { includeUnresolved: true },
      ).sort(),
    ).toEqual(['notes.secret', 'unresolved metered key (k)']);

    // 4. Indirect require/import('./meter.ts').metered and bracketed call/apply/Reflect['apply'] extract note keys directly via meteredNotes.
    expect(meteredNotes("require('./meter.ts').metered('notes.secret', fn);")).toContain('notes.secret');
    expect(meteredNotes("const f = (await import('./meter.ts')).metered; f('notes.secret', fn);")).toContain(
      'notes.secret',
    );
    expect(
      meteredNotes("const f = (0, (await import('./meter.ts')).metered); f('notes.secret', fn);"),
    ).toContain('notes.secret');
    expect(
      meteredNotes("const secretKey = 'notes.secret'; const m = require('./meter.ts'); m.metered(secretKey, fn);"),
    ).toContain('notes.secret');
    expect(meteredNotes("const secretKey = 'notes.secret'; metered['call'](null, secretKey, fn);")).toContain(
      'notes.secret',
    );
    expect(meteredNotes("const secretKey = 'notes.secret'; metered?.['apply'](null, [secretKey, fn]);")).toContain(
      'notes.secret',
    );
    expect(meteredNotes("const secretKey = 'notes.secret'; Reflect['apply'](metered, null, [secretKey, fn]);")).toContain(
      'notes.secret',
    );
    expect(meteredNotes("const secretKey = 'notes.secret'; Reflect?.['apply'](metered, null, [secretKey, fn]);")).toContain(
      'notes.secret',
    );

    // 5. isEnclosingPatternContext + skipOptionalTypeForward handle default params, generics, type predicates/assertions/conditionals, and benign if(fn({ require: true })).
    expect(memberVyViolations('if (fn({ require: true })) { return 1; }')).toEqual([]);
    expect(
      memberVyViolations('function run<T>(a = 1, { require: req }: T): { ok: boolean } { return req; }'),
    ).toContain('uses require alias or bare require reference');
    expect(memberVyViolations('const [a = 1, { require: req }] = items;')).toContain(
      'uses require alias or bare require reference',
    );
    expect(
      memberVyViolations("export const f = (x: unknown, { require: r }: any): x is { a: 1 } => r('pg')"),
    ).toContain('uses require alias or bare require reference');
    expect(
      memberVyViolations("(x, { require: r }: any): asserts x is { a: 1 } => { r('pg'); }"),
    ).toContain('uses require alias or bare require reference');
    expect(
      memberVyViolations("<T,>({ require: r }: any): T extends { a: 1 } ? 1 : 2 => r('pg')"),
    ).toContain('uses require alias or bare require reference');

    // 6. collectRawMeteredNotes folds comments before '(' / quotes / '+' outside valid string/template/comment literals; leak check handles unclosed backticks + comments + 3-way splits.
    expect(meteredNotes("metered /* c */ ( /* q */ 'no' /* c1 */ + 't' + 'es.summary', fn)")).toContain(
      'notes.summary',
    );
    expect(meteredNotes('const msg = "metered(\'no\' + \'tes.summary\', fn)";')).toEqual([]);
    expect(meteredNotes("const tpl = `prefix ${x} metered('no' + 'tes.summary', fn)`;")).toEqual([]);
    expect(meteredNotes("// metered('no' + 'tes.summary', fn)")).toEqual([]);
    expect(meteredNotes("/* metered('no' + 'tes.summary', fn) */")).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        "const bad = `unclosed;\nrequire('@lu' /* c */ + 'dy/' /* c2 */ + 'agent');",
        ['summarize'],
        'apps/kernel/src/foo.ts',
      ).length,
    ).toBeGreaterThan(0);

    // 7. RELATIVE_SEGMENT_RE catches bare '.' and '..' (including unclosed backtick context) without matching spread '...'.
    expect(
      workspaceAdapterLeakViolations(
        "const bad = `unclosed;\n// agent\nrequire('..');",
        ['summarize'],
        'packages/other/leak.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(workspaceAdapterLeakViolations('const spread = { ...x };', ['summarize'], 'packages/other/ok.ts')).toEqual([]);

    // Regex literals inside code (including after comparison ops like ===, unary void, and for..of headers) must not trigger false-positive unresolved metered calls while ambiguous division/regex spots still do.
    expect(disallowedMeteredNotes('other.ts', 'const pattern = /metered(name)/;')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'enabled === /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', '2 > /metered(name)/.source.length;')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'a < b && c > /metered(name)/.test(s);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'if (a < b) { c > /metered(name)/.test(s); }')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'void /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'const x = 1 as number\nvoid /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'const x = 1 as any ? void /metered(name)/ : 0;')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'const x = { as: void /metered(name)/.test(text) };')).toEqual([]);
    expect(
      disallowedMeteredNotes('other.ts', 'const x = 1 as any | void / Number(metered(dynKey, fn)) / 2;'),
    ).toEqual(['unresolved metered key (dynKey)']);
    expect(
      disallowedMeteredNotes('other.ts', 'const x = 1 as T extends U ? A : void / Number(metered("notes." + "a", fn)) / 2;'),
    ).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.ts', 'const x = obj.void / metered(dynKey) / 2;')).toEqual([
      'unresolved metered key (dynKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'if (enabled) {} /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'if (enabled) { doWork(); } /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'function f() {} /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'try {} catch {} /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', '{ const a = 1; } /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'const f = () => {} /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'const x = { a: 1 } / Number(metered("notes." + "a", fn)) / 2;')).toEqual([
      'notes.a',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'const x = { a: { b: 1 } } / Number(metered(dynKey, fn)) / 2;')).toEqual([
      'unresolved metered key (dynKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'a as Foo<Record<string, number>> / metered(dynKey) / 2')).toEqual([
      'unresolved metered key (dynKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'for (const part of /metered(name)/.exec(text) ?? []) {}')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'for await (const part of /metered(name)/.exec(text) ?? []) {}')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'const x = of / metered(dynKey) / 2;')).toEqual([
      'unresolved metered key (dynKey)',
    ]);
    expect(
      disallowedMeteredNotes('other.ts', "const suffix = 'summary'; metered('notes.' + suffix, fn);"),
    ).toEqual(['notes.summary']);
    expect(disallowedMeteredNotes('other.ts', '(a as Foo<number>) / metered(dynKey) / 2')).toEqual([
      'unresolved metered key (dynKey)',
    ]);
    expect(disallowedMeteredNotes('other.ts', 'a as Foo<number> / metered(dynKey) / 2')).toEqual([
      'unresolved metered key (dynKey)',
    ]);
    expect(
      meteredNotes("const broken = `unclosed;\nmetered('notes.' + dynVar, fn);"),
    ).toContain('notes....');

    // Worst-case 500 KB unclosed-backtick / unclosed '/*' comment+quote input stays strictly O(N).
    const tStart = performance.now();
    const largeRaw = `\`unclosed; ${"'x' /* c */ + ".repeat(40_000)}'y'`;
    expect(workspaceAdapterLeakViolations(largeRaw, ['summarize'], 'packages/other/ok.ts')).toEqual([]);
    expect(workspaceAdapterLeakViolations(`\`unclosed; ${"'/*".repeat(100_000)}`, ['summarize'], 'packages/other/ok.ts')).toEqual([]);
    expect(meteredNotes("metered(/* ".repeat(40_000))).toEqual([]);
    expect(meteredNotes("metered(/* c */ ".repeat(30_000))).toEqual([]);
    expect(performance.now() - tStart).toBeLessThan(10_000);
  });
});
