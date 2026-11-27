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
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type tsType from 'typescript-api';
import { describe, expect, it } from 'vitest';

const requireTs = createRequire(import.meta.url);
const tsApiPath = process.env.LUDY_INVARIANT_TS_API_PATH;
const ts = (tsApiPath ? requireTs(tsApiPath) : requireTs('typescript-api')) as typeof tsType;

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
  inJsxOpenTag?: boolean;
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
  let prevMaySpeculativelyDivide = false;
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
  // Fail-closed brace classifier (#5035): every `{ ... }` pushes `true` (expression/division-possible on `}`),
  // matching origin/main strictness, UNLESS its `{` unambiguously begins a JS control-flow statement block.
  const braceExprStack: boolean[] = [];
  const controlParenStack: boolean[] = [];
  let controlStage: 'none' | 'for_head' | 'expect_paren' | 'catch_head' | 'expect_block' = 'none';
  let lastRBraceWasExpr = false;

  const trackBraceExprToken = (tok: Token): void => {
    lastRBraceWasExpr = false;
    if (tok.kind === 'punct') {
      if (tok.value === '{') {
        const isControlBlock = controlStage === 'expect_block' || controlStage === 'catch_head';
        braceExprStack.push(!isControlBlock);
        controlStage = 'none';
        return;
      }
      if (tok.value === '}') {
        lastRBraceWasExpr = braceExprStack.pop() ?? true;
        controlStage = 'none';
        return;
      }
      if (tok.value === '(') {
        controlParenStack.push(
          controlStage === 'expect_paren' || controlStage === 'for_head' || controlStage === 'catch_head',
        );
        controlStage = 'none';
        return;
      }
      if (tok.value === ')') {
        const expectBlock = controlParenStack.pop() ?? false;
        controlStage = expectBlock ? 'expect_block' : 'none';
        return;
      }
      controlStage = 'none';
      return;
    }
    if (tok.kind === 'ident' && !tok.escaped && !prevWasDot) {
      if (tok.value === 'if' || tok.value === 'while' || tok.value === 'switch') controlStage = 'expect_paren';
      else if (tok.value === 'for') controlStage = 'for_head';
      else if (tok.value === 'await' && controlStage === 'for_head') controlStage = 'expect_paren';
      else if (tok.value === 'else' || tok.value === 'try' || tok.value === 'finally') controlStage = 'expect_block';
      else if (tok.value === 'catch') controlStage = 'catch_head';
      else controlStage = 'none';
      return;
    }
    controlStage = 'none';
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
        prevMaySpeculativelyDivide = false;
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
          prevMaySpeculativelyDivide = false;
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
        prevMaySpeculativelyDivide = false;
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
        prevMaySpeculativelyDivide = false;
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
        prevMaySpeculativelyDivide = false;
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
      prevMaySpeculativelyDivide = false;
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
      prevMaySpeculativelyDivide = false;
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
      prevMaySpeculativelyDivide = false;
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
      prevMaySpeculativelyDivide = false;
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
      const mayRescanAfterRegex = prevMaySpeculativelyDivide || prevCouldBeDivision;
      const suspiciousJsxOrQuote = /['"`]|\{(?!\d+(?:,\d*)?\})/;
      const suspiciousUnclosed = /['"`;]|\{(?!\d+(?:,\d*)?\})/;
      if (
        !forceRegex &&
        mayRescanAfterRegex &&
        ((closed && suspiciousJsxOrQuote.test(raw)) || (!closed && suspiciousUnclosed.test(raw)))
      ) {
        suspiciousRegexStarts.add(start);
      }
      if (
        closed &&
        !forceRegex &&
        !prevCouldBeDivision &&
        !suspiciousRegexStarts.has(start) &&
        options.emitTokens &&
        !options.scanRegexAsDivision
      ) {
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
      prevMaySpeculativelyDivide = false;
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
      prevMaySpeculativelyDivide = false;
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
      const topJsxOpen = options.jsx ? jsxStack[jsxStack.length - 1] : undefined;
      const inJsxOpenTag = Boolean(valid && topJsxOpen?.mode === 'openTag' && topJsxOpen.angleDepth === 0);
      emit({
        kind: valid ? 'ident' : 'invalid',
        raw,
        value: valid ? value : raw,
        escaped: sawEscape || raw !== value,
        start,
        end: j,
        line,
        ...(inJsxOpenTag ? { inJsxOpenTag: true } : {}),
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
        prevMaySpeculativelyDivide = !prevWasDot && (value === 'await' || value === 'yield' || value === 'of' || value === 'void');
        prevControlKeyword =
          !prevWasDot && value === 'await' && prevControlKeyword === 'for'
            ? 'for await'
            : !prevWasDot && CONTROL_KEYWORDS.has(value)
              ? value
              : '';
      } else {
        prevAllowsRegex = false;
        prevCouldBeDivision = false;
        prevMaySpeculativelyDivide = false;
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
        prevMaySpeculativelyDivide = false;
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
        prevMaySpeculativelyDivide = false;
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
      prevMaySpeculativelyDivide = false;
      prevWasDot = false;
    } else if (punct === ')') {
      const poppedParen = parenAllowsRegexStack.pop();
      prevAllowsRegex = poppedParen?.allowRegexAfter ?? false;
      if (poppedParen) openLtCount = poppedParen.savedLtCount;
      if (parenAllowsRegexStack.length > 0 && parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen > 0) {
        parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen -= 1;
      }
      prevCouldBeDivision = false;
      prevMaySpeculativelyDivide = false;
      prevWasDot = false;
    } else if (punct === '.' || punct === '?.') {
      prevWasDot = true;
      prevAllowsRegex = false;
      prevCouldBeDivision = false;
      prevMaySpeculativelyDivide = false;
    } else if (punct === ']' || punct === '++' || punct === '--') {
      if (punct === ']' && parenAllowsRegexStack.length > 0 && parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen > 0) {
        parenAllowsRegexStack[parenAllowsRegexStack.length - 1]!.depthInParen -= 1;
      }
      prevAllowsRegex = false;
      prevCouldBeDivision = false;
      prevMaySpeculativelyDivide = false;
      prevWasDot = false;
    } else if (punct === '!') {
      // Prefix `!expr` leaves prevAllowsRegex=true; TypeScript postfix `expr!` preserves prevAllowsRegex, prevCouldBeDivision, and prevMaySpeculativelyDivide for `/`.
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
      const inJsxTextElem = Boolean(options.jsx && jsxStack[jsxStack.length - 1]?.mode === 'elem');
      prevCouldBeDivision = (punct === '}' && lastRBraceWasExpr) || closedGenericGt;
      prevMaySpeculativelyDivide = (punct === '}' && (lastRBraceWasExpr || inJsxTextElem)) || punct === '>';
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

function speculativeRescanWithSpans(
  text: string,
  primaryScan: Pick<ScanSourceResult, 'suspiciousDivisionStarts' | 'suspiciousRegexStarts'>,
  jsx = false,
): { tokens: Token[]; unambiguousRegexSpans: Array<{ start: number; end: number }> } | null {
  if (primaryScan.suspiciousDivisionStarts.size === 0 && primaryScan.suspiciousRegexStarts.size === 0) {
    return null;
  }
  const res = scanSource(text, {
    emitTokens: true,
    stripCommentsMode: false,
    stripStrings: false,
    forceRegexStarts: primaryScan.suspiciousDivisionStarts,
    skipRegexStarts: primaryScan.suspiciousRegexStarts,
    ...(jsx ? { jsx: true } : {}),
  });
  return { tokens: res.tokens, unambiguousRegexSpans: res.unambiguousRegexSpans };
}

function speculativeRescan(
  text: string,
  primaryScan: Pick<ScanSourceResult, 'suspiciousDivisionStarts' | 'suspiciousRegexStarts'>,
  jsx = false,
): Token[] | null {
  return speculativeRescanWithSpans(text, primaryScan, jsx)?.tokens ?? null;
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
        const isJsxAttrProp =
          Boolean(t.inJsxOpenTag) &&
          prevVal !== '<' &&
          !isMemberPrev(tokens, i) &&
          rawNext?.kind === 'punct' &&
          (rawNext.value === '=' || rawNext.value === '>' || rawNext.value === '/');
        if (!(isKeySep && nextIsColon) && !isJsxAttrProp) {
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

function blankTextSpans(
  text: string,
  spans: ReadonlyArray<{ start: number; end: number }>,
): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const sp of sorted) {
    if (sp.end <= cursor) continue;
    const start = Math.max(sp.start, cursor);
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(' '.repeat(sp.end - start));
    cursor = sp.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.join('');
}

function specifiers(
  text: string,
  precomputedTokens?: readonly Token[],
  precomputedDelims?: DelimiterPairs,
  skipRawSpans?: ReadonlyArray<{ start: number; end: number }>,
): { specifiers: string[]; scan: ModuleScanResult } {
  const scan = scanModuleTokens(precomputedTokens ?? tokenize(text), precomputedDelims);
  const rawInput = skipRawSpans && skipRawSpans.length > 0 ? blankTextSpans(text, skipRawSpans) : text;
  const rawMain = linearRawSpecifiers(rawInput);
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

// --- Iterative TypeScript AST boundary walker (#5106) ---
const AST_REQUIRE_HOSTS = new Set(['globalThis', 'window', 'self', 'module', 'global']);
const AST_LEXICAL_UNCLOSED_CODES = new Set([1002, 1010, 1160, 1161]);
const AST_JSX_UNCLOSED_CODES = new Set([17008, 17014]);
const AST_MAX_PLUS_NODES = 256;
const AST_MAX_CONST_STRING_LEN = 4096;
const AST_COMMAND_RE =
  /^((?:kernel|notes|meetings|finance|crm|hr|social|projects|calendar|desk)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)$/;
const AST_TABLE_IDENT_RE = /^(?:crove|ludy)_[a-z]+$/;
const AST_TABLE_TEXT_RE = /\b(?:crove|ludy)_[a-z]+\./;
const AST_MEMBER_VY_NAMES = new Set(['memberVy', 'member_vy', 'PrivateText']);
const AST_NETWORK_FETCH_MODULE_RE =
  /^(?:node:)?https?$|^undici(?:\/|$)|^node-fetch(?:\/|$)|^(?:cross|isomorphic|whatwg)-fetch(?:\/|$)|^ofetch(?:\/|$)/;
const AST_DEFAULT_FETCH_MODULE_RE =
  /^(?:node-fetch|cross-fetch|isomorphic-fetch|whatwg-fetch|ofetch)(?:\/|$)/;

type TsSourceFileWithDiagnostics = tsType.SourceFile & {
  readonly parseDiagnostics?: readonly tsType.Diagnostic[];
};

interface AstLexScope {
  readonly id: number;
  readonly parent: AstLexScope | null;
  readonly isFnScope: boolean;
  readonly declaredNames: Set<string>;
  readonly constStrings: Map<string, string | null>;
}

interface AstDynamicCallFact {
  readonly fn: 'import' | 'require';
  readonly literalSpec: string | null;
  readonly inlineConcatSpec: string | null;
  readonly resolvedSpec: string | null;
  readonly boundTarget: string | null;
  readonly isIndirectRequire: boolean;
  readonly node: tsType.CallExpression;
  readonly callChainEnd: tsType.Expression;
}

interface AstImportDeclFact {
  readonly specifier: string;
  readonly isNamespace: boolean;
  readonly isDefault: boolean;
  readonly barrelBindings: string[];
}

interface AstExportDeclFact {
  readonly specifier: string;
  readonly isStar: boolean;
  readonly namespaceAlias: string | null;
  readonly isDirectUnaliased: boolean;
  readonly rawClauseSnippet: string;
}

interface AstMeteredCallRecord {
  readonly openParenPos: number;
  readonly argExpr: tsType.Expression | null;
  readonly isMissingApplyArg: boolean;
  readonly resolvedKeys: string[];
  readonly templateSpans: string[];
  readonly unresolvedSpecs: string[];
}

interface AstCallSiteRecord {
  readonly call: tsType.CallExpression;
  readonly calleeExpr: tsType.Expression;
  readonly firstArgExpr: tsType.Expression | null;
  readonly missingApplyFirstArg: boolean;
  readonly isIndirect: boolean;
  readonly scope: AstLexScope;
  readonly boundTargets: string[];
  readonly outerAccessExpr: tsType.Expression;
}

interface AstParsedResult {
  readonly sources: TsSourceFileWithDiagnostics[];
  readonly hadRangeError: boolean;
  readonly hasLexicalUnclosed: boolean;
  readonly hasJsxUnclosed: boolean;
  readonly hasCleanParse: boolean;
}

interface AstFileFacts {
  readonly specifiers: string[];
  readonly importDecls: AstImportDeclFact[];
  readonly exportDecls: AstExportDeclFact[];
  readonly localExports: Array<{ name: string; propertyName: string | null }>;
  readonly dynamicCalls: AstDynamicCallFact[];
  readonly hasComputedDynamic: boolean;
  readonly hasBareRequire: boolean;
  readonly hasNonDirectAgentComputedAccess: boolean;
  readonly stringAndIdentMatches: Set<string>;
  readonly interpolatedSymbolMatches: Set<string>;
  readonly validDirectReexportIdentNodes: Set<tsType.Node>;
  readonly meteredCalls: AstMeteredCallRecord[];
  readonly notesLiterals: string[];
  readonly callsExecute: boolean;
  readonly callsFetch: boolean;
  readonly callsAgentBindings: Set<string>;
}

function getAstParseDiagnostics(sf: TsSourceFileWithDiagnostics): readonly tsType.Diagnostic[] {
  return sf.parseDiagnostics ?? [];
}

const AST_PARSE_CACHE_MAX = 256;
const astParseCache = new Map<string, AstParsedResult>();

function parseAstCandidates(text: string, filePath?: string | undefined): AstParsedResult {
  const isExplicitJsxPath = Boolean(filePath && /\.[jt]sx$/i.test(filePath));
  const isExplicitNonJsxPath = Boolean(filePath && /\.(?:[cm]?ts|[cm]?js)$/i.test(filePath));
  const cacheMode = isExplicitJsxPath ? 'jsx' : isExplicitNonJsxPath ? 'ts' : 'auto';
  const cacheKey = `${cacheMode}\0${text}`;
  const cached = astParseCache.get(cacheKey);
  if (cached) return cached;

  const candidates: Array<{ name: string; kind: tsType.ScriptKind }> = isExplicitJsxPath
    ? [{ name: filePath ?? 'input.tsx', kind: ts.ScriptKind.TSX }]
    : isExplicitNonJsxPath
      ? [{ name: filePath ?? 'input.ts', kind: ts.ScriptKind.TS }]
      : [
          { name: 'input.tsx', kind: ts.ScriptKind.TSX },
          { name: 'input.ts', kind: ts.ScriptKind.TS },
        ];

  const parsed: Array<{ sf: TsSourceFileWithDiagnostics; diags: readonly tsType.Diagnostic[]; isJsx: boolean }> = [];
  let hadRangeError = false;
  for (const cand of candidates) {
    try {
      const sf = ts.createSourceFile(cand.name, text, ts.ScriptTarget.Latest, true, cand.kind) as TsSourceFileWithDiagnostics;
      const diags = getAstParseDiagnostics(sf);
      parsed.push({ sf, diags, isJsx: cand.kind === ts.ScriptKind.TSX });
    } catch (err) {
      if (err instanceof RangeError) {
        hadRangeError = true;
        if (!text.includes('<')) break;
      } else {
        throw err;
      }
    }
  }

  const clean = parsed.filter((item) => item.diags.length === 0);
  const chosen = clean.length > 0 ? clean : parsed;
  let hasLexicalUnclosed = false;
  let hasJsxUnclosed = false;
  for (const item of chosen) {
    for (const d of item.diags) {
      if (AST_LEXICAL_UNCLOSED_CODES.has(d.code)) hasLexicalUnclosed = true;
      if (isExplicitJsxPath && item.isJsx && AST_JSX_UNCLOSED_CODES.has(d.code)) hasJsxUnclosed = true;
    }
  }
  const result: AstParsedResult = {
    sources: chosen.map((c) => c.sf),
    hadRangeError,
    hasLexicalUnclosed,
    hasJsxUnclosed,
    hasCleanParse: clean.length > 0,
  };
  if (astParseCache.size >= AST_PARSE_CACHE_MAX) {
    const oldest = astParseCache.keys().next();
    if (!oldest.done) astParseCache.delete(oldest.value);
  }
  astParseCache.set(cacheKey, result);
  return result;
}

function astVarKey(scope: AstLexScope, name: string): string {
  let cur: AstLexScope | null = scope;
  while (cur !== null) {
    if (cur.declaredNames.has(name)) return `${cur.id}:${name}`;
    cur = cur.parent;
  }
  return `global:${name}`;
}

function lookupAstConstString(scope: AstLexScope, name: string): string | null {
  let cur: AstLexScope | null = scope;
  while (cur !== null) {
    if (cur.constStrings.has(name)) {
      return cur.constStrings.get(name) ?? null;
    }
    if (cur.declaredNames.has(name)) return null;
    cur = cur.parent;
  }
  return null;
}

function collectAstBindingIdentifiers(pattern: tsType.BindingName): string[] {
  const names: string[] = [];
  const stack: tsType.BindingName[] = [pattern];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (ts.isIdentifier(cur)) {
      names.push(cur.text);
    } else if (ts.isObjectBindingPattern(cur) || ts.isArrayBindingPattern(cur)) {
      for (const el of cur.elements) {
        if (ts.isBindingElement(el)) stack.push(el.name);
      }
    }
  }
  return names;
}

function unwrapAstExpr(node: tsType.Expression, includeComma = false): tsType.Expression {
  let cur = node;
  let steps = 0;
  while (steps < 64) {
    steps += 1;
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isAwaitExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }
    if (includeComma && ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      cur = cur.right;
      continue;
    }
    break;
  }
  return cur;
}

function isAstStringGlobal(expr: tsType.Expression, scope: AstLexScope, depth = 0): boolean {
  if (depth > 32) return false;
  const recv = unwrapAstExpr(expr, true);
  if (ts.isIdentifier(recv)) return recv.text === 'String';
  if (ts.isPropertyAccessExpression(recv)) {
    const h = unwrapAstExpr(recv.expression, true);
    return ts.isIdentifier(h) && AST_REQUIRE_HOSTS.has(h.text) && recv.name.text === 'String';
  }
  if (ts.isElementAccessExpression(recv)) {
    const h = unwrapAstExpr(recv.expression, true);
    if (!ts.isIdentifier(h) || !AST_REQUIRE_HOSTS.has(h.text)) return false;
    const prop = resolveAstConstString(recv.argumentExpression, scope, 'full_const', depth + 1);
    return prop === 'String';
  }
  return false;
}

function resolveAstConstString(
  expr: tsType.Expression,
  scope: AstLexScope,
  mode: 'inline_only' | 'full_const',
  depth = 0,
): string | null {
  if (depth > 32) return null;
  const unwrapped = unwrapAstExpr(expr, false);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text.length <= AST_MAX_CONST_STRING_LEN ? unwrapped.text : null;
  }
  if (mode === 'full_const') {
    if (ts.isIdentifier(unwrapped)) {
      const val = lookupAstConstString(scope, unwrapped.text);
      return val !== null && val.length <= AST_MAX_CONST_STRING_LEN ? val : null;
    }
    if (ts.isTemplateExpression(unwrapped)) {
      if (unwrapped.head.text.length > AST_MAX_CONST_STRING_LEN) return null;
      const parts: string[] = [unwrapped.head.text];
      let totalLen = unwrapped.head.text.length;
      for (const span of unwrapped.templateSpans) {
        const inner = resolveAstConstString(span.expression, scope, mode, depth + 1);
        if (inner === null) return null;
        totalLen += inner.length + span.literal.text.length;
        if (totalLen > AST_MAX_CONST_STRING_LEN) return null;
        parts.push(inner, span.literal.text);
      }
      return parts.join('');
    }
    if (ts.isCallExpression(unwrapped)) {
      const callee = unwrapAstExpr(unwrapped.expression, true);
      let fnMethod: 'fromCharCode' | 'fromCodePoint' | null = null;
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const prop = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : resolveAstConstString(callee.argumentExpression, scope, mode, depth + 1);
        if (isAstStringGlobal(callee.expression, scope, depth + 1) && (prop === 'fromCharCode' || prop === 'fromCodePoint')) {
          fnMethod = prop;
        }
      }
      if (fnMethod !== null && unwrapped.arguments.length <= AST_MAX_CONST_STRING_LEN) {
        const chars: string[] = [];
        let ok = true;
        for (const arg of unwrapped.arguments) {
          const nExpr = unwrapAstExpr(arg, false);
          if (!ts.isNumericLiteral(nExpr)) {
            ok = false;
            break;
          }
          const num = Number(nExpr.text);
          if (!Number.isInteger(num) || num < 0 || (fnMethod === 'fromCodePoint' ? num > 0x10ffff : num > 0xffff)) {
            ok = false;
            break;
          }
          chars.push(fnMethod === 'fromCodePoint' ? String.fromCodePoint(num) : String.fromCharCode(num));
        }
        if (ok) return chars.join('');
      }
    }
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const operands: tsType.Expression[] = [];
    const stack: tsType.Expression[] = [unwrapped];
    let visitedNodes = 0;
    while (stack.length > 0 && operands.length <= AST_MAX_PLUS_NODES && visitedNodes <= AST_MAX_PLUS_NODES * 2) {
      visitedNodes += 1;
      const item = unwrapAstExpr(stack.pop()!, false);
      if (ts.isBinaryExpression(item) && item.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        stack.push(item.right, item.left);
      } else {
        operands.push(item);
      }
    }
    if (stack.length > 0 || operands.length > AST_MAX_PLUS_NODES || visitedNodes > AST_MAX_PLUS_NODES * 2) return null;
    const chunks: string[] = [];
    let totalLen = 0;
    for (const op of operands) {
      const part = resolveAstConstString(op, scope, mode, depth + 1);
      if (part === null) return null;
      totalLen += part.length;
      if (totalLen > AST_MAX_CONST_STRING_LEN) return null;
      chunks.push(part);
    }
    return chunks.join('');
  }
  return null;
}

function astLeadingPrefix(expr: tsType.Expression, scope: AstLexScope, depth = 0): string {
  if (depth > 16) return '';
  const unwrapped = unwrapAstExpr(expr, true);
  if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) {
    return unwrapped.text.slice(0, AST_MAX_CONST_STRING_LEN);
  }
  if (ts.isIdentifier(unwrapped)) {
    return (lookupAstConstString(scope, unwrapped.text) ?? '').slice(0, AST_MAX_CONST_STRING_LEN);
  }
  if (ts.isTemplateExpression(unwrapped)) {
    const parts: string[] = [unwrapped.head.text.slice(0, AST_MAX_CONST_STRING_LEN)];
    let totalLen = parts[0]!.length;
    for (const span of unwrapped.templateSpans) {
      const fullSpan = resolveAstConstString(span.expression, scope, 'full_const', depth + 1);
      if (fullSpan === null) {
        const sub = astLeadingPrefix(span.expression, scope, depth + 1);
        const rem = AST_MAX_CONST_STRING_LEN - totalLen;
        if (rem > 0 && sub) parts.push(sub.slice(0, rem));
        break;
      }
      if (totalLen + fullSpan.length + span.literal.text.length > AST_MAX_CONST_STRING_LEN) {
        const rem = AST_MAX_CONST_STRING_LEN - totalLen;
        if (rem > 0) parts.push((fullSpan + span.literal.text).slice(0, rem));
        break;
      }
      totalLen += fullSpan.length + span.literal.text.length;
      parts.push(fullSpan, span.literal.text);
    }
    return parts.join('');
  }
  if (ts.isBinaryExpression(unwrapped) && unwrapped.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const operands: tsType.Expression[] = [];
    const stack: tsType.Expression[] = [unwrapped];
    let visitedNodes = 0;
    while (stack.length > 0 && operands.length <= AST_MAX_PLUS_NODES && visitedNodes <= AST_MAX_PLUS_NODES * 2) {
      visitedNodes += 1;
      const item = unwrapAstExpr(stack.pop()!, false);
      if (ts.isBinaryExpression(item) && item.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        stack.push(item.right, item.left);
      } else {
        operands.push(item);
      }
    }
    if (stack.length > 0 || operands.length > AST_MAX_PLUS_NODES || visitedNodes > AST_MAX_PLUS_NODES * 2) return '';
    const chunks: string[] = [];
    let totalLen = 0;
    for (const op of operands) {
      const fullOp = resolveAstConstString(op, scope, 'full_const', depth + 1);
      if (fullOp === null) {
        const sub = astLeadingPrefix(op, scope, depth + 1);
        const rem = AST_MAX_CONST_STRING_LEN - totalLen;
        if (rem > 0 && sub) chunks.push(sub.slice(0, rem));
        break;
      }
      if (totalLen + fullOp.length > AST_MAX_CONST_STRING_LEN) {
        const rem = AST_MAX_CONST_STRING_LEN - totalLen;
        if (rem > 0) chunks.push(fullOp.slice(0, rem));
        break;
      }
      totalLen += fullOp.length;
      chunks.push(fullOp);
    }
    return chunks.join('');
  }
  return '';
}

function resolveAstPropertyName(propName: tsType.PropertyName, scope: AstLexScope): {
  readonly name: string | null;
  readonly isComputedBracket: boolean;
} {
  if (ts.isIdentifier(propName) || ts.isStringLiteral(propName) || ts.isNoSubstitutionTemplateLiteral(propName)) {
    return { name: propName.text, isComputedBracket: false };
  }
  if (ts.isComputedPropertyName(propName)) {
    return {
      name: resolveAstConstString(propName.expression, scope, 'full_const'),
      isComputedBracket: true,
    };
  }
  return { name: null, isComputedBracket: false };
}

function extractAstMemberName(
  expr: tsType.PropertyAccessExpression | tsType.ElementAccessExpression,
  scope: AstLexScope,
): { readonly host: tsType.Expression; readonly memberName: string | null; readonly isComputedBracket: boolean } {
  if (ts.isPropertyAccessExpression(expr)) {
    return { host: expr.expression, memberName: expr.name.text, isComputedBracket: false };
  }
  return {
    host: expr.expression,
    memberName: resolveAstConstString(expr.argumentExpression, scope, 'full_const'),
    isComputedBracket: true,
  };
}

function findAstCallOpenParenPos(call: tsType.CallExpression, sf: tsType.SourceFile): number {
  const pos = call.arguments.pos;
  if (pos > 0 && sf.text[pos - 1] === '(') return pos - 1;
  const searchStart = call.typeArguments ? call.typeArguments.end : call.expression.end;
  const idx = sf.text.indexOf('(', searchStart);
  return idx >= 0 && idx < call.end ? idx : Math.max(0, pos - 1);
}

function unwrapAstCall(
  call: tsType.CallExpression,
  scope: AstLexScope,
): {
  readonly calleeExpr: tsType.Expression;
  readonly firstArgExpr: tsType.Expression | null;
  readonly missingApplyFirstArg: boolean;
  readonly isIndirect: boolean;
} {
  let calleeExpr = unwrapAstExpr(call.expression, true);
  let args: readonly tsType.Expression[] = call.arguments;
  let firstArgExpr: tsType.Expression | null = args[0] ?? null;
  let hasExplicitFirstArg = args.length > 0;
  let missingApplyFirstArg = false;
  let isIndirect = calleeExpr !== call.expression;

  const extractArrayArg0 = (arrExpr: tsType.Expression | undefined): { expr: tsType.Expression | null; missing: boolean } => {
    if (!arrExpr) return { expr: null, missing: true };
    const norm = unwrapAstExpr(arrExpr, true);
    if (ts.isArrayLiteralExpression(norm)) {
      const el0 = norm.elements[0];
      if (!el0 || el0.kind === ts.SyntaxKind.OmittedExpression || el0.kind === ts.SyntaxKind.SpreadElement) {
        return { expr: null, missing: true };
      }
      return { expr: el0, missing: false };
    }
    return { expr: null, missing: true };
  };

  for (let loop = 0; loop < 8; loop += 1) {
    calleeExpr = unwrapAstExpr(calleeExpr, true);
    if (ts.isCallExpression(calleeExpr)) {
      const innerTarget = unwrapAstExpr(calleeExpr.expression, true);
      if (ts.isPropertyAccessExpression(innerTarget) || ts.isElementAccessExpression(innerTarget)) {
        const mem = extractAstMemberName(innerTarget, scope);
        if (mem.memberName === 'bind') {
          if (calleeExpr.arguments.length >= 2) {
            args = [...calleeExpr.arguments.slice(1), ...args];
            firstArgExpr = args[0] ?? null;
            hasExplicitFirstArg = args.length > 0;
            missingApplyFirstArg = false;
          }
          calleeExpr = mem.host;
          isIndirect = true;
          continue;
        }
      }
      break;
    }

    if (ts.isPropertyAccessExpression(calleeExpr) || ts.isElementAccessExpression(calleeExpr)) {
      const mem = extractAstMemberName(calleeExpr, scope);
      const hostNorm = unwrapAstExpr(mem.host, true);
      if (mem.memberName === 'apply' && ts.isIdentifier(hostNorm) && hostNorm.text === 'Reflect') {
        const fnArg = args[0];
        if (!fnArg) break;
        const arrInfo = extractArrayArg0(args[2]);
        const nextArr = args[2] ? unwrapAstExpr(args[2], true) : undefined;
        args =
          nextArr && ts.isArrayLiteralExpression(nextArr)
            ? nextArr.elements.filter((el): el is tsType.Expression => el.kind !== ts.SyntaxKind.OmittedExpression)
            : [];
        hasExplicitFirstArg = true;
        calleeExpr = fnArg;
        firstArgExpr = arrInfo.expr;
        missingApplyFirstArg = arrInfo.missing;
        isIndirect = true;
        continue;
      }
      if (mem.memberName === 'call' && !hasExplicitFirstArg) {
        break;
      }
      if (mem.memberName === 'call') {
        calleeExpr = mem.host;
        args = args.slice(1);
        firstArgExpr = args[0] ?? null;
        isIndirect = true;
        continue;
      }
      if (mem.memberName === 'apply') {
        const arrInfo = extractArrayArg0(args[1]);
        const nextArr = args[1] ? unwrapAstExpr(args[1], true) : undefined;
        args =
          nextArr && ts.isArrayLiteralExpression(nextArr)
            ? nextArr.elements.filter((el): el is tsType.Expression => el.kind !== ts.SyntaxKind.OmittedExpression)
            : [];
        calleeExpr = mem.host;
        firstArgExpr = arrInfo.expr;
        missingApplyFirstArg = arrInfo.missing;
        isIndirect = true;
        continue;
      }
    }
    break;
  }

  return {
    calleeExpr: unwrapAstExpr(calleeExpr, true),
    firstArgExpr,
    missingApplyFirstArg,
    isIndirect,
  };
}

function seedBlockShadowIdentifiers(blockNode: tsType.Node, scope: AstLexScope): void {
  const stmts: readonly tsType.Statement[] | undefined = ts.isSourceFile(blockNode) || ts.isBlock(blockNode) || ts.isModuleBlock(blockNode)
    ? blockNode.statements
    : ts.isCaseBlock(blockNode)
      ? blockNode.clauses.flatMap((c) => c.statements)
      : undefined;
  if (!stmts) return;
  let varScope = scope;
  while (varScope.parent && !varScope.isFnScope) varScope = varScope.parent;
  for (const stmt of stmts) {
    if (ts.isVariableStatement(stmt)) {
      const isLexical = Boolean(stmt.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let));
      const targetScope = isLexical ? scope : varScope;
      for (const decl of stmt.declarationList.declarations) {
        for (const name of collectAstBindingIdentifiers(decl.name)) {
          targetScope.declaredNames.add(name);
          targetScope.constStrings.set(name, null);
        }
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      scope.declaredNames.add(stmt.name.text);
      scope.constStrings.set(stmt.name.text, null);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      scope.declaredNames.add(stmt.name.text);
      scope.constStrings.set(stmt.name.text, null);
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      if (stmt.importClause.name) {
        scope.declaredNames.add(stmt.importClause.name.text);
        scope.constStrings.set(stmt.importClause.name.text, null);
      }
      const nb = stmt.importClause.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) {
        scope.declaredNames.add(nb.name.text);
        scope.constStrings.set(nb.name.text, null);
      } else if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          scope.declaredNames.add(el.name.text);
          scope.constStrings.set(el.name.text, null);
        }
      }
    }
  }
}

function isAstKnownSafeFetchKillRhs(expr: tsType.Expression): boolean {
  return (
    ts.isFunctionLike(expr) ||
    ts.isLiteralExpression(expr) ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    expr.kind === ts.SyntaxKind.UndefinedKeyword ||
    ts.isNoSubstitutionTemplateLiteral(expr)
  );
}

function isAstIdentNonValueRequireOrImportKey(ident: tsType.Identifier, parent: tsType.Node, inTypePos: boolean): boolean {
  if (inTypePos) {
    if (
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isTypeParameterDeclaration(parent)
    ) {
      return true;
    }
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === ident) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === ident) return true;
  if (ts.isJsxAttribute(parent) && parent.name === ident) return true;
  if (
    (ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === ident
  ) {
    return true;
  }
  if (ts.isQualifiedName(parent) && parent.right === ident) return true;
  if (ts.isLabeledStatement(parent) && parent.label === ident) return true;
  if (ts.isBreakOrContinueStatement(parent) && parent.label === ident) return true;
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return true;
  if (ts.isExportSpecifier(parent)) {
    const decl = parent.parent?.parent;
    const hasModSpec = Boolean(decl && ts.isExportDeclaration(decl) && decl.moduleSpecifier !== undefined);
    if (parent.propertyName === ident) return hasModSpec;
    if (parent.propertyName !== undefined && parent.name === ident) return true;
  }
  if (ts.isBindingElement(parent) && (parent.name === ident || parent.propertyName === ident)) return true;
  return false;
}

function formatAstTemplateSpan(sf: TsSourceFileWithDiagnostics, tpl: tsType.TemplateExpression): string {
  const start = tpl.getStart(sf);
  const fullLen = tpl.end - 1 - (start + 1);
  if (fullLen <= 256) return sf.text.slice(start + 1, tpl.end - 1);
  return `${tpl.head.text.slice(0, 64)}\${...}`;
}

function analyzeAstMeteredKeyExpr(
  sf: TsSourceFileWithDiagnostics,
  expr: tsType.Expression,
  scope: AstLexScope,
  includeUnresolved: boolean,
  resolvedOut: string[],
  templateSpanOut: string[],
  unresolvedOut: string[],
  depth = 0,
): void {
  if (depth > 8) {
    if (includeUnresolved) {
      const s = expr.getStart(sf);
      const snippet = sf.text.slice(s, Math.min(expr.end, s + 64)).replace(/\s+/g, ' ').trim().slice(0, 64);
      unresolvedOut.push(`unresolved metered key (${snippet})`);
    }
    return;
  }
  const cur = unwrapAstExpr(expr, false);
  if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    analyzeAstMeteredKeyExpr(sf, cur.right, scope, includeUnresolved, resolvedOut, templateSpanOut, unresolvedOut, depth + 1);
    return;
  }
  if (ts.isConditionalExpression(cur)) {
    analyzeAstMeteredKeyExpr(sf, cur.whenTrue, scope, includeUnresolved, resolvedOut, templateSpanOut, unresolvedOut, depth + 1);
    analyzeAstMeteredKeyExpr(sf, cur.whenFalse, scope, includeUnresolved, resolvedOut, templateSpanOut, unresolvedOut, depth + 1);
    return;
  }
  if (
    ts.isBinaryExpression(cur) &&
    (cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      cur.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      cur.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  ) {
    analyzeAstMeteredKeyExpr(sf, cur.left, scope, includeUnresolved, resolvedOut, templateSpanOut, unresolvedOut, depth + 1);
    analyzeAstMeteredKeyExpr(sf, cur.right, scope, includeUnresolved, resolvedOut, templateSpanOut, unresolvedOut, depth + 1);
    return;
  }
  const resolved = resolveAstConstString(cur, scope, 'full_const');
  if (resolved !== null) {
    if (resolved.startsWith('notes.')) resolvedOut.push(resolved);
    return;
  }
  if (ts.isTemplateExpression(cur) && cur.head.text.startsWith('notes.')) {
    templateSpanOut.push(formatAstTemplateSpan(sf, cur));
    return;
  }
  if (includeUnresolved) {
    const prefix = astLeadingPrefix(cur, scope);
    if (prefix.startsWith('notes.') || 'notes.'.startsWith(prefix)) {
      const s = cur.getStart(sf);
      const snippet = sf.text.slice(s, Math.min(cur.end, s + 64)).replace(/\s+/g, ' ').trim().slice(0, 64);
      unresolvedOut.push(`unresolved metered key (${snippet})`);
    }
  }
}

function collectDestructuringTargetsAndRefs(
  lhsExpr: tsType.ObjectLiteralExpression,
  scope: AstLexScope,
): {
  entries: Array<{ key: string | null; isComputedBracket: boolean; isTopLevel: boolean; targets: string[] }>;
} {
  const entries: Array<{ key: string | null; isComputedBracket: boolean; isTopLevel: boolean; targets: string[] }> = [];
  const stack: Array<{ obj: tsType.ObjectLiteralExpression; isTopLevel: boolean }> = [{ obj: lhsExpr, isTopLevel: true }];
  while (stack.length > 0) {
    const { obj, isTopLevel } = stack.pop()!;
    for (const prop of obj.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        entries.push({ key: prop.name.text, isComputedBracket: false, isTopLevel, targets: [prop.name.text] });
      } else if (ts.isPropertyAssignment(prop)) {
        const keyInfo = resolveAstPropertyName(prop.name, scope);
        const init = unwrapAstExpr(prop.initializer, false);
        if (ts.isIdentifier(init)) {
          entries.push({ key: keyInfo.name, isComputedBracket: keyInfo.isComputedBracket, isTopLevel, targets: [init.text] });
        } else if (ts.isObjectLiteralExpression(init)) {
          stack.push({ obj: init, isTopLevel: false });
        } else if (ts.isArrayLiteralExpression(init)) {
          const arrIds: string[] = [];
          const aStack: tsType.Expression[] = [init];
          while (aStack.length > 0) {
            const ac = unwrapAstExpr(aStack.pop()!, false);
            if (ts.isIdentifier(ac)) arrIds.push(ac.text);
            else if (ts.isObjectLiteralExpression(ac)) stack.push({ obj: ac, isTopLevel: false });
            else if (ts.isArrayLiteralExpression(ac)) {
              for (const el of ac.elements) {
                if (ts.isSpreadElement(el)) aStack.push(el.expression);
                else if (!ts.isOmittedExpression(el)) aStack.push(el);
              }
            } else if (ts.isBinaryExpression(ac) && ac.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
              aStack.push(ac.left);
            }
          }
          if (arrIds.length > 0) {
            entries.push({ key: keyInfo.name, isComputedBracket: keyInfo.isComputedBracket, isTopLevel, targets: arrIds });
          }
        } else if (ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const leftTarget = unwrapAstExpr(init.left, false);
          if (ts.isIdentifier(leftTarget)) {
            entries.push({ key: keyInfo.name, isComputedBracket: keyInfo.isComputedBracket, isTopLevel, targets: [leftTarget.text] });
          } else if (ts.isObjectLiteralExpression(leftTarget)) {
            stack.push({ obj: leftTarget, isTopLevel: false });
          }
        } else {
          entries.push({ key: keyInfo.name, isComputedBracket: keyInfo.isComputedBracket, isTopLevel, targets: [] });
        }
      } else if (ts.isSpreadAssignment(prop)) {
        const inner = unwrapAstExpr(prop.expression, false);
        if (ts.isIdentifier(inner)) {
          entries.push({ key: null, isComputedBracket: true, isTopLevel, targets: [inner.text] });
        }
      }
    }
  }
  return { entries };
}

function getAstEnclosingFnNode(node: tsType.Node): tsType.Node {
  let cur: tsType.Node = node;
  while (cur.parent) {
    cur = cur.parent;
    if (ts.isFunctionLike(cur) || ts.isSourceFile(cur)) return cur;
  }
  return cur;
}

function isAstAncestorNode(ancestor: tsType.Node, desc: tsType.Node): boolean {
  let cur: tsType.Node | undefined = desc;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

function upperBoundLessThan(sorted: readonly number[], limit: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < limit) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 ? sorted[lo - 1]! : -1;
}

function hasSortedNumberInRange(sorted: readonly number[], minVal: number, maxVal: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < minVal) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo]! <= maxVal;
}

function blockHasBreakOrContinue(block: tsType.Block): boolean {
  const bStack: tsType.Node[] = [...block.statements];
  while (bStack.length > 0) {
    const cur = bStack.pop()!;
    if (ts.isBreakStatement(cur) || ts.isContinueStatement(cur)) return true;
    if (ts.isFunctionLike(cur)) continue;
    ts.forEachChild(cur, (ch) => {
      bStack.push(ch);
    });
  }
  return false;
}

function resolveUnconditionalKillBlock(directBlock: tsType.Node): tsType.Node {
  let cur = directBlock;
  while (
    ts.isBlock(cur) &&
    cur.parent &&
    (ts.isBlock(cur.parent) || ts.isSourceFile(cur.parent) || ts.isModuleBlock(cur.parent)) &&
    !blockHasBreakOrContinue(cur)
  ) {
    cur = cur.parent;
  }
  return cur;
}

function getAstEnclosingLoopInFn(node: tsType.Node, targetFnNode: tsType.Node): tsType.Node | null {
  let outermostLoop: tsType.Node | null = null;
  let cur: tsType.Node | undefined = node;
  while (cur && cur !== targetFnNode) {
    if (
      ts.isForStatement(cur) ||
      ts.isForInStatement(cur) ||
      ts.isForOfStatement(cur) ||
      ts.isWhileStatement(cur) ||
      ts.isDoStatement(cur)
    ) {
      outermostLoop = cur;
    }
    cur = cur.parent;
  }
  return outermostLoop;
}

function extractAstFacts(
  sf: TsSourceFileWithDiagnostics,
  symbolSet: ReadonlySet<string>,
  fromRelPath?: string | undefined,
): AstFileFacts {
  const specifiersOut: string[] = [];
  const importDecls: AstImportDeclFact[] = [];
  const exportDecls: AstExportDeclFact[] = [];
  const localExports: Array<{ name: string; propertyName: string | null }> = [];
  const stringAndIdentMatches = new Set<string>();
  const interpolatedSymbolMatches = new Set<string>();
  const validDirectReexportIdentNodes = new Set<tsType.Node>();
  const notesLiterals: string[] = [];

  const aliasEdges = new Map<string, Set<string>>();
  interface FetchTaintEvent {
    readonly fnNode: tsType.Node | null;
    readonly rawStart: number;
    readonly effStart: number;
    readonly loopNode: tsType.Node | null;
  }
  interface FetchKillCandidate {
    readonly varKey: string;
    readonly blockNode: tsType.Node;
    readonly pos: number;
    readonly rhsExpr: tsType.Expression;
    readonly fnNode: tsType.Node;
    readonly evalScope: AstLexScope;
  }
  interface PositionalAliasEdge {
    readonly from: string;
    readonly to: string;
    readonly rawPos: number;
    readonly effPos: number;
    readonly fnNode: tsType.Node;
    readonly loopNode: tsType.Node | null;
    readonly rhsNode: tsType.Node;
  }
  const positionalEdgesBySource = new Map<string, PositionalAliasEdge[]>();
  interface FnFetchTaintIndex {
    readonly nonLoopRawStarts: number[];
    nonLoopDirty: boolean;
    readonly nonLoopSeen: Set<number>;
    readonly loops: Map<tsType.Node, { loopNode: tsType.Node; minEffStart: number; maxRawStart: number }>;
  }
  const fetchGlobalVars = new Set<string>();
  const fetchTaintsByVarAndFn = new Map<string, Map<tsType.Node, FnFetchTaintIndex>>();
  const fetchKillCandidates: FetchKillCandidate[] = [];
  const fetchKillsByVarAndBlock = new Map<string, Map<tsType.Node, number[]>>();
  const fetchDirtyKillArrays: number[][] = [];
  const seedNodeModuleNs = new Set<string>();
  const seedCreateRequire = new Set<string>(['global:createRequire']);
  const seedRequire = new Set<string>(['global:require']);
  const seedRequireHosts = new Set<string>([...AST_REQUIRE_HOSTS].map((h) => `global:${h}`));
  const seedNonSafeKillBases = new Set<string>();
  const seedNonSafeKillValues = new Set<string>();
  const localWrapperBindTargets: Array<{ hostExpr: tsType.Expression; targets: string[]; scope: AstLexScope }> = [];
  const seedMeterAliases = new Set<string>(['global:metered']);
  const seedMeterNs = new Set<string>();
  const seedAgentBindings = new Set<string>();
  const seedExecuteAliases = new Set<string>(['global:execute']);

  const expandAstBranchExprs = (expr: tsType.Expression): tsType.Expression[] => {
    const out: tsType.Expression[] = [];
    const bStack: tsType.Expression[] = [expr];
    let count = 0;
    while (bStack.length > 0 && count < 64) {
      count += 1;
      const cur = unwrapAstExpr(bStack.pop()!, true);
      if (ts.isConditionalExpression(cur)) {
        bStack.push(cur.whenFalse, cur.whenTrue);
        continue;
      }
      if (
        ts.isBinaryExpression(cur) &&
        (cur.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          cur.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      ) {
        if (cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          bStack.push(cur.right);
        } else {
          bStack.push(cur.left, cur.right);
        }
        continue;
      }
      out.push(cur);
    }
    return out;
  };

  const anyAstBranchMatchesSet = (
    expr: tsType.Expression,
    scope: AstLexScope,
    set: ReadonlySet<string>,
  ): boolean => {
    for (const br of expandAstBranchExprs(expr)) {
      if (ts.isIdentifier(br) && set.has(astVarKey(scope, br.text))) return true;
    }
    return false;
  };

  const extractReflectGetTargetAndKey = (
    expr: tsType.Expression,
    scope: AstLexScope,
  ): { host: tsType.Expression; propName: string | null; isComputedBracket: boolean } | null => {
    const direct = unwrapAstExpr(expr, true);
    if (!ts.isCallExpression(direct)) return null;
    const fnExpr = unwrapAstExpr(direct.expression, true);
    if (!ts.isPropertyAccessExpression(fnExpr) && !ts.isElementAccessExpression(fnExpr)) return null;
    const mem = extractAstMemberName(fnExpr, scope);
    if (mem.memberName !== 'get') return null;
    const recv = unwrapAstExpr(mem.host, true);
    let isReflectRecv = ts.isIdentifier(recv) && recv.text === 'Reflect';
    if (!isReflectRecv && (ts.isPropertyAccessExpression(recv) || ts.isElementAccessExpression(recv))) {
      const recvMem = extractAstMemberName(recv, scope);
      const recvHost = unwrapAstExpr(recvMem.host, true);
      isReflectRecv = recvMem.memberName === 'Reflect' && ts.isIdentifier(recvHost) && AST_REQUIRE_HOSTS.has(recvHost.text);
    }
    if (!isReflectRecv) return null;
    const tgt = direct.arguments[0] ? unwrapAstExpr(direct.arguments[0], false) : null;
    if (!tgt) return null;
    const key = direct.arguments[1] ? unwrapAstExpr(direct.arguments[1], false) : null;
    const propName = key ? resolveAstConstString(key, scope, 'full_const') : null;
    return { host: unwrapAstExpr(tgt, true), propName, isComputedBracket: true };
  };

  const addFetchTaintEvent = (varKey: string, ev: FetchTaintEvent): boolean => {
    if (ev.fnNode === null) {
      if (fetchGlobalVars.has(varKey)) return false;
      fetchGlobalVars.add(varKey);
      return true;
    }
    if (fetchGlobalVars.has(varKey)) return false;
    let fnMap = fetchTaintsByVarAndFn.get(varKey);
    if (!fnMap) {
      fnMap = new Map<tsType.Node, FnFetchTaintIndex>();
      fetchTaintsByVarAndFn.set(varKey, fnMap);
    }
    let idx = fnMap.get(ev.fnNode);
    if (!idx) {
      idx = {
        nonLoopRawStarts: [],
        nonLoopDirty: false,
        nonLoopSeen: new Set<number>(),
        loops: new Map<tsType.Node, { loopNode: tsType.Node; minEffStart: number; maxRawStart: number }>(),
      };
      fnMap.set(ev.fnNode, idx);
    }
    if (ev.loopNode === null) {
      if (idx.nonLoopSeen.has(ev.rawStart)) return false;
      idx.nonLoopSeen.add(ev.rawStart);
      const len = idx.nonLoopRawStarts.length;
      if (len > 0 && ev.rawStart < idx.nonLoopRawStarts[len - 1]!) {
        idx.nonLoopDirty = true;
      }
      idx.nonLoopRawStarts.push(ev.rawStart);
      return true;
    }
    const prevLoop = idx.loops.get(ev.loopNode);
    if (!prevLoop) {
      idx.loops.set(ev.loopNode, {
        loopNode: ev.loopNode,
        minEffStart: ev.effStart,
        maxRawStart: ev.rawStart,
      });
      return true;
    }
    if (ev.effStart < prevLoop.minEffStart || ev.rawStart > prevLoop.maxRawStart) {
      if (ev.effStart < prevLoop.minEffStart) prevLoop.minEffStart = ev.effStart;
      if (ev.rawStart > prevLoop.maxRawStart) prevLoop.maxRawStart = ev.rawStart;
      return true;
    }
    return false;
  };

  const seedFetchGlobal = (varKey: string): void => {
    addFetchTaintEvent(varKey, { fnNode: null, rawStart: 0, effStart: 0, loopNode: null });
  };
  const seedFetchAtNode = (varKey: string, assignNode: tsType.Node, assignEndPos?: number): void => {
    const fnNode = getAstEnclosingFnNode(assignNode);
    const loopNode = getAstEnclosingLoopInFn(assignNode, fnNode);
    const rawPos = assignEndPos ?? assignNode.getStart(sf);
    addFetchTaintEvent(varKey, {
      fnNode,
      rawStart: rawPos,
      effStart: loopNode ? loopNode.getStart(sf) : rawPos,
      loopNode,
    });
  };
  const isFnIdxTaintedAtQuery = (
    varKey: string,
    ownerFn: tsType.Node,
    idx: FnFetchTaintIndex,
    anchorNode: tsType.Node,
    anchorPos: number,
    maxAllowedPos: number,
  ): boolean => {
    const blockKills = fetchKillsByVarAndBlock.get(varKey);
    let maxKillPos = -1;
    let killInLoops: Map<tsType.Node, number> | null = null;
    if (blockKills) {
      let cur: tsType.Node | undefined = anchorNode;
      while (cur) {
        const arr = blockKills.get(cur);
        if (arr) {
          const kPos = upperBoundLessThan(arr, anchorPos);
          if (kPos > maxKillPos) maxKillPos = kPos;
          if (kPos !== -1 && idx.loops.size > 0) {
            for (const loopEntry of idx.loops.values()) {
              if (isAstAncestorNode(loopEntry.loopNode, anchorNode) && isAstAncestorNode(loopEntry.loopNode, cur)) {
                if (!killInLoops) killInLoops = new Map<tsType.Node, number>();
                const prev = killInLoops.get(loopEntry.loopNode) ?? -1;
                if (kPos > prev) killInLoops.set(loopEntry.loopNode, kPos);
              }
            }
          }
        }
        if (cur === ownerFn) break;
        cur = cur.parent;
      }
    }
    if (idx.nonLoopRawStarts.length > 0) {
      if (idx.nonLoopDirty) {
        idx.nonLoopRawStarts.sort((a, b) => a - b);
        idx.nonLoopDirty = false;
      }
      const minAllowed = maxKillPos === -1 ? 0 : maxKillPos;
      if (hasSortedNumberInRange(idx.nonLoopRawStarts, minAllowed, maxAllowedPos)) {
        return true;
      }
    }
    for (const loopEntry of idx.loops.values()) {
      if (maxAllowedPos < loopEntry.minEffStart) continue;
      if (isAstAncestorNode(loopEntry.loopNode, anchorNode)) {
        const maxKillInLoop = killInLoops?.get(loopEntry.loopNode) ?? -1;
        if (maxKillInLoop === -1 || loopEntry.maxRawStart >= maxKillInLoop) {
          return true;
        }
      } else if (maxKillPos === -1 || loopEntry.loopNode.end > maxKillPos) {
        return true;
      }
    }
    return false;
  };
  const isFetchTaintedAtCall = (varKey: string, queryNode: tsType.Node): boolean => {
    if (fetchGlobalVars.has(varKey)) return true;
    const fnMap = fetchTaintsByVarAndFn.get(varKey);
    if (!fnMap || fnMap.size === 0) return false;
    const callFnNode = getAstEnclosingFnNode(queryNode);
    for (const [fnNode, idx] of fnMap) {
      if (fnNode === callFnNode) continue;
      if (idx.nonLoopRawStarts.length === 0 && idx.loops.size === 0) continue;
      if (!isAstAncestorNode(fnNode, queryNode)) return true;
      let closureRoot: tsType.Node | null = null;
      let hasHoistedClosure = false;
      let curFnWalk: tsType.Node | undefined = queryNode;
      while (curFnWalk && curFnWalk !== fnNode) {
        if (ts.isFunctionLike(curFnWalk)) {
          closureRoot = curFnWalk;
          if (ts.isFunctionDeclaration(curFnWalk)) hasHoistedClosure = true;
        }
        curFnWalk = curFnWalk.parent;
      }
      if (hasHoistedClosure || closureRoot === null) return true;
      if (isFnIdxTaintedAtQuery(varKey, fnNode, idx, closureRoot, closureRoot.getStart(sf), Number.POSITIVE_INFINITY)) {
        return true;
      }
    }
    const sameIdx = fnMap.get(callFnNode);
    if (!sameIdx) return false;
    const callPos = queryNode.getStart(sf);
    return isFnIdxTaintedAtQuery(varKey, callFnNode, sameIdx, queryNode, callPos, callPos);
  };
  seedFetchGlobal('global:fetch');
  const memberBindCandidates: Array<{
    host: tsType.Expression;
    propName: string | null;
    isComputedBracket: boolean;
    targets: string[];
    scope: AstLexScope;
    rhsExpr: tsType.Expression;
  }> = [];
  const callSites: AstCallSiteRecord[] = [];
  const elementAccessNodes: Array<{ node: tsType.ElementAccessExpression; scope: AstLexScope }> = [];
  const reflectGetCallNodes: Array<{ call: tsType.CallExpression; scope: AstLexScope }> = [];
  const hostMemberAccesses: Array<{ hostExpr: tsType.Expression; memberName: string | null; scope: AstLexScope }> = [];

  let hasComputedDynamic = false;
  let hasBareRequire = false;
  let hasNonDirectAgentComputedAccess = false;
  let callsExecute = false;
  let callsFetch = false;

  let nextScopeId = 1;
  const createAstChildScope = (parent: AstLexScope, isFnScope: boolean): AstLexScope => ({
    id: nextScopeId++,
    parent,
    isFnScope,
    declaredNames: new Set<string>(),
    constStrings: new Map<string, string | null>(),
  });
  const rootScope: AstLexScope = {
    id: 0,
    parent: null,
    isFnScope: true,
    declaredNames: new Set<string>(),
    constStrings: new Map<string, string | null>(),
  };
  seedBlockShadowIdentifiers(sf, rootScope);

  const checkStringOrIdentValue = (val: string, skipSymMatch: boolean, isValidDirectNode = false): void => {
    if (AST_MEMBER_VY_NAMES.has(val)) stringAndIdentMatches.add(val);
    if (symbolSet.has(val)) {
      if (!skipSymMatch) stringAndIdentMatches.add(val);
      else if (!isValidDirectNode) interpolatedSymbolMatches.add(val);
    }
    const cmdM = AST_COMMAND_RE.exec(val);
    if (cmdM?.[1]) stringAndIdentMatches.add(`cmd:${cmdM[1]}`);
    if (AST_TABLE_TEXT_RE.test(val)) stringAndIdentMatches.add('table:crove_');
  };

  const addPositionalEdge = (
    fromKey: string,
    toKey: string,
    rawPos: number,
    rhsNode: tsType.Node,
  ): void => {
    const edgeFnNode = getAstEnclosingFnNode(rhsNode);
    const loopNode = getAstEnclosingLoopInFn(rhsNode, edgeFnNode);
    const edge: PositionalAliasEdge = {
      from: fromKey,
      to: toKey,
      rawPos,
      effPos: loopNode ? loopNode.getStart(sf) : rawPos,
      fnNode: edgeFnNode,
      loopNode,
      rhsNode,
    };
    const outEdges = positionalEdgesBySource.get(fromKey);
    if (outEdges) outEdges.push(edge);
    else positionalEdgesBySource.set(fromKey, [edge]);
  };

  const forwardObjectLiteralTargets = (
    objLit: tsType.ObjectLiteralExpression,
    propName: string | null,
    targetKeys: string[],
    evalScope: AstLexScope,
    assignEndPos: number | undefined,
    objDepth: number,
  ): void => {
    if (objDepth >= 4 || targetKeys.length === 0) return;
    for (const prop of objLit.properties) {
      if (ts.isPropertyAssignment(prop)) {
        if (propName === null || resolveAstPropertyName(prop.name, evalScope).name === propName) {
          recordBindAndMemberTarget(targetKeys, prop.initializer, evalScope, assignEndPos, objDepth + 1);
        }
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        if (propName === null || prop.name.text === propName) {
          recordBindAndMemberTarget(targetKeys, prop.name, evalScope, assignEndPos, objDepth + 1);
        }
      } else if (ts.isSpreadAssignment(prop)) {
        recordBindAndMemberTarget(targetKeys, prop.expression, evalScope, assignEndPos, objDepth + 1);
      }
    }
  };

  const forwardArrayLiteralTargets = (
    arrLit: tsType.ArrayLiteralExpression,
    numIdx: number | null,
    targetKeys: string[],
    evalScope: AstLexScope,
    assignEndPos: number | undefined,
    objDepth: number,
  ): void => {
    if (objDepth >= 4 || targetKeys.length === 0) return;
    let sawSpreadBefore = false;
    if (numIdx !== null && Number.isInteger(numIdx) && numIdx >= 0 && numIdx < arrLit.elements.length) {
      for (let i = 0; i <= numIdx; i += 1) {
        if (ts.isSpreadElement(arrLit.elements[i]!)) {
          sawSpreadBefore = true;
          break;
        }
      }
      if (!sawSpreadBefore) {
        const picked = arrLit.elements[numIdx]!;
        if (!ts.isOmittedExpression(picked)) {
          recordBindAndMemberTarget(targetKeys, picked, evalScope, assignEndPos, objDepth + 1);
        }
        return;
      }
    }
    for (const el of arrLit.elements) {
      if (ts.isOmittedExpression(el)) continue;
      const valExpr = ts.isSpreadElement(el) ? el.expression : el;
      recordBindAndMemberTarget(targetKeys, valExpr, evalScope, assignEndPos, objDepth + 1);
    }
  };

  const recordBindAndMemberTarget = (
    targetKeys: string[],
    rhsExpr: tsType.Expression,
    evalScope: AstLexScope,
    assignEndPos?: number,
    objDepth = 0,
  ): tsType.Expression => {
    const branchStack: tsType.Expression[] = [rhsExpr];
    let firstUnwrapped: tsType.Expression | null = null;
    let branchCount = 0;
    while (branchStack.length > 0 && branchCount < 64) {
      branchCount += 1;
      let cur = unwrapAstExpr(branchStack.pop()!, true);
      while (ts.isCallExpression(cur)) {
        const innerTarget = unwrapAstExpr(cur.expression, true);
        if (ts.isPropertyAccessExpression(innerTarget) || ts.isElementAccessExpression(innerTarget)) {
          const bMem = extractAstMemberName(innerTarget, evalScope);
          if (bMem.memberName === 'bind') {
            cur = unwrapAstExpr(bMem.host, true);
            continue;
          }
        }
        break;
      }
      if (firstUnwrapped === null) firstUnwrapped = cur;
      if (ts.isConditionalExpression(cur)) {
        branchStack.push(cur.whenTrue, cur.whenFalse);
        continue;
      }
      if (
        ts.isBinaryExpression(cur) &&
        (cur.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          cur.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
      ) {
        if (cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
          branchStack.push(cur.right);
        } else {
          branchStack.push(cur.left, cur.right);
        }
        continue;
      }
      if (!ts.isIdentifier(cur)) {
        const isSafeRhs = isAstKnownSafeFetchKillRhs(cur);
        for (const tk of targetKeys) {
          if (!tk.startsWith('prop:')) seedNonSafeKillBases.add(tk);
          if (!isSafeRhs && !ts.isPropertyAccessExpression(cur)) {
            seedNonSafeKillValues.add(tk);
          }
        }
      }
      const memberAccess =
        targetKeys.length > 0 && (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur))
          ? (() => {
              const mem = extractAstMemberName(cur, evalScope);
              return { host: unwrapAstExpr(mem.host, true), propName: mem.memberName, isComputedBracket: mem.isComputedBracket };
            })()
          : targetKeys.length > 0
            ? extractReflectGetTargetAndKey(cur, evalScope)
            : null;
      if (targetKeys.length === 1 && ts.isIdentifier(cur)) {
        const fromKey = astVarKey(evalScope, cur.text);
        const toKey = targetKeys[0]!;
        addAliasEdge(aliasEdges, fromKey, toKey);
        addPositionalEdge(fromKey, toKey, assignEndPos ?? cur.getStart(sf), cur);
      } else if (memberAccess) {
        memberBindCandidates.push({
          host: memberAccess.host,
          propName: memberAccess.propName,
          isComputedBracket: memberAccess.isComputedBracket,
          targets: targetKeys,
          scope: evalScope,
          rhsExpr: cur,
        });
        const rawPos = assignEndPos ?? cur.getStart(sf);
        const elemIdxArg = ts.isElementAccessExpression(cur) ? unwrapAstExpr(cur.argumentExpression, false) : null;
        const elemNumIdx = elemIdxArg && ts.isNumericLiteral(elemIdxArg) ? Number(elemIdxArg.text) : null;
        for (const br of expandAstBranchExprs(memberAccess.host)) {
          if (ts.isIdentifier(br)) {
            if (targetKeys.length === 1) {
              const effectiveProp =
                memberAccess.propName !== null
                  ? memberAccess.propName
                  : elemNumIdx !== null && Number.isInteger(elemNumIdx)
                    ? String(elemNumIdx)
                    : null;
              if (effectiveProp !== null) {
                const propKey = `prop:${astVarKey(evalScope, br.text)}\0${effectiveProp}`;
                const toKey = targetKeys[0]!;
                addAliasEdge(aliasEdges, propKey, toKey);
                addPositionalEdge(propKey, toKey, rawPos, cur);
              }
            }
          } else if (ts.isObjectLiteralExpression(br)) {
            forwardObjectLiteralTargets(br, memberAccess.propName, targetKeys, evalScope, assignEndPos, objDepth);
          } else if (ts.isArrayLiteralExpression(br)) {
            forwardArrayLiteralTargets(br, elemNumIdx, targetKeys, evalScope, assignEndPos, objDepth);
          }
        }
      } else if (targetKeys.length === 1 && ts.isObjectLiteralExpression(cur) && objDepth < 4) {
        const baseKey = targetKeys[0]!;
        for (const prop of cur.properties) {
          if (ts.isPropertyAssignment(prop)) {
            const keyInfo = resolveAstPropertyName(prop.name, evalScope);
            if (keyInfo.name !== null) {
              recordBindAndMemberTarget(
                [`prop:${baseKey}\0${keyInfo.name}`],
                prop.initializer,
                evalScope,
                assignEndPos,
                objDepth + 1,
              );
            }
          } else if (ts.isShorthandPropertyAssignment(prop)) {
            recordBindAndMemberTarget(
              [`prop:${baseKey}\0${prop.name.text}`],
              prop.name,
              evalScope,
              assignEndPos,
              objDepth + 1,
            );
          }
        }
      } else if (targetKeys.length === 1 && ts.isArrayLiteralExpression(cur) && objDepth < 4) {
        const baseKey = targetKeys[0]!;
        for (let idx = 0; idx < cur.elements.length; idx += 1) {
          const el = cur.elements[idx]!;
          if (ts.isOmittedExpression(el)) continue;
          const valExpr = ts.isSpreadElement(el) ? el.expression : el;
          recordBindAndMemberTarget([`prop:${baseKey}\0${idx}`], valExpr, evalScope, assignEndPos, objDepth + 1);
        }
      }
    }
    return firstUnwrapped ?? unwrapAstExpr(rhsExpr, true);
  };

  const recordDestructuredEntries = (
    entries: ReadonlyArray<{ key: string | null; isComputedBracket: boolean; isTopLevel: boolean; targets: string[] }>,
    rhsExpr: tsType.Expression,
    evalScope: AstLexScope,
    scopeForTargets: AstLexScope | null,
  ): void => {
    for (const entry of entries) {
      const scopedTargets = scopeForTargets
        ? entry.targets.map((n) => astVarKey(scopeForTargets, n))
        : entry.targets;
      if (entry.isTopLevel) {
        if (entry.key === 'require' || entry.key === 'createRequire') {
          hasBareRequire = true;
          for (const t of scopedTargets) {
            if (entry.key === 'createRequire') seedCreateRequire.add(t);
            else seedRequire.add(t);
          }
        } else if (entry.key === 'metered') {
          for (const t of scopedTargets) seedMeterAliases.add(t);
        } else if (entry.key === 'execute') {
          for (const t of scopedTargets) seedExecuteAliases.add(t);
        }
      }
      if ((entry.isTopLevel && scopedTargets.length > 0) || entry.isComputedBracket) {
        memberBindCandidates.push({
          host: rhsExpr,
          propName: entry.isTopLevel ? entry.key : null,
          isComputedBracket: entry.isComputedBracket,
          targets: entry.isTopLevel ? scopedTargets : [],
          scope: evalScope,
          rhsExpr,
        });
      }
      if (scopedTargets.length > 0 && !entry.isTopLevel) {
        localWrapperBindTargets.push({ hostExpr: rhsExpr, targets: scopedTargets, scope: evalScope });
      }
    }
  };

  function forwardRhsValueToTarget(
    targetNode: tsType.BindingName | tsType.Expression,
    targetScope: AstLexScope,
    rhsVal: tsType.Expression,
    evalScope: AstLexScope,
    assignEndPos: number | undefined,
    depth: number,
  ): void {
    if (ts.isIdentifier(targetNode)) {
      recordBindAndMemberTarget([astVarKey(targetScope, targetNode.text)], rhsVal, evalScope, assignEndPos, depth);
    } else if (ts.isObjectBindingPattern(targetNode)) {
      recordDestructuredEntries(extractObjectBindingDestructurePairs(targetNode, targetScope), rhsVal, evalScope, null);
      forwardObjectPatternToRhs(targetNode, rhsVal, evalScope, targetScope, assignEndPos, depth);
    } else if (ts.isObjectLiteralExpression(targetNode)) {
      recordDestructuredEntries(collectDestructuringTargetsAndRefs(targetNode, targetScope).entries, rhsVal, evalScope, targetScope);
      forwardObjectPatternToRhs(targetNode, rhsVal, evalScope, targetScope, assignEndPos, depth);
    } else if (ts.isArrayBindingPattern(targetNode) || ts.isArrayLiteralExpression(targetNode)) {
      recordArrayDestructure(targetNode, rhsVal, evalScope, targetScope, assignEndPos, depth);
    }
  }

  function forwardObjectPatternToRhs(
    objPatOrLit: tsType.ObjectBindingPattern | tsType.ObjectLiteralExpression,
    rhsExpr: tsType.Expression,
    evalScope: AstLexScope,
    targetScope: AstLexScope,
    assignEndPos: number | undefined,
    depth = 0,
  ): void {
    if (depth >= 4) return;
    const rhsObjs = expandAstBranchExprs(rhsExpr).filter((br): br is tsType.ObjectLiteralExpression =>
      ts.isObjectLiteralExpression(br),
    );
    if (rhsObjs.length === 0) return;
    const slots: Array<{ key: string | null; targetNode: tsType.BindingName | tsType.Expression }> = [];
    if (ts.isObjectBindingPattern(objPatOrLit)) {
      for (const el of objPatOrLit.elements) {
        if (el.dotDotDotToken) continue;
        const key = el.propertyName
          ? resolveAstPropertyName(el.propertyName, evalScope).name
          : ts.isIdentifier(el.name)
            ? el.name.text
            : null;
        slots.push({ key, targetNode: el.name });
      }
    } else {
      for (const prop of objPatOrLit.properties) {
        if (ts.isShorthandPropertyAssignment(prop)) {
          slots.push({ key: prop.name.text, targetNode: prop.name });
        } else if (ts.isPropertyAssignment(prop)) {
          const key = resolveAstPropertyName(prop.name, evalScope).name;
          const init = unwrapAstExpr(prop.initializer, false);
          const targetNode =
            ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.EqualsToken
              ? unwrapAstExpr(init.left, false)
              : init;
          slots.push({ key, targetNode });
        }
      }
    }
    for (const slot of slots) {
      for (const objLit of rhsObjs) {
        for (const prop of objLit.properties) {
          if (ts.isPropertyAssignment(prop)) {
            if (slot.key === null || resolveAstPropertyName(prop.name, evalScope).name === slot.key) {
              forwardRhsValueToTarget(slot.targetNode, targetScope, prop.initializer, evalScope, assignEndPos, depth + 1);
            }
          } else if (ts.isShorthandPropertyAssignment(prop)) {
            if (slot.key === null || prop.name.text === slot.key) {
              forwardRhsValueToTarget(slot.targetNode, targetScope, prop.name, evalScope, assignEndPos, depth + 1);
            }
          } else if (ts.isSpreadAssignment(prop)) {
            forwardRhsValueToTarget(slot.targetNode, targetScope, prop.expression, evalScope, assignEndPos, depth + 1);
          }
        }
      }
    }
  }

  const collectAssignTargetIdentifiers = (
    target: tsType.BindingName | tsType.Expression,
    targetScope: AstLexScope,
  ): string[] => {
    if (ts.isIdentifier(target)) return [astVarKey(targetScope, target.text)];
    if (ts.isObjectBindingPattern(target) || ts.isArrayBindingPattern(target)) {
      return collectAstBindingIdentifiers(target).map((n) => astVarKey(targetScope, n));
    }
    const out: string[] = [];
    const stack: tsType.Expression[] = [target];
    while (stack.length > 0) {
      const cur = unwrapAstExpr(stack.pop()!, false);
      if (ts.isIdentifier(cur)) out.push(astVarKey(targetScope, cur.text));
      else if (ts.isObjectLiteralExpression(cur)) {
        for (const e of collectDestructuringTargetsAndRefs(cur, targetScope).entries) {
          for (const n of e.targets) out.push(astVarKey(targetScope, n));
        }
      } else if (ts.isArrayLiteralExpression(cur)) {
        for (const el of cur.elements) {
          if (ts.isSpreadElement(el)) stack.push(el.expression);
          else if (!ts.isOmittedExpression(el)) stack.push(el);
        }
      } else if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        stack.push(cur.left);
      }
    }
    return out;
  };

  const recordArrayDestructure = (
    pattern: tsType.ArrayBindingPattern | tsType.ArrayLiteralExpression,
    rhsExpr: tsType.Expression,
    evalScope: AstLexScope,
    targetScope: AstLexScope,
    assignEndPos: number | undefined,
    depth = 0,
  ): void => {
    const allTargets = collectAssignTargetIdentifiers(pattern, targetScope);
    if (allTargets.length > 0) {
      localWrapperBindTargets.push({ hostExpr: rhsExpr, targets: allTargets, scope: evalScope });
    }
    if (depth >= 4) return;
    const elements: Array<{ isRest: boolean; node: tsType.BindingName | tsType.Expression } | null> = [];
    if (ts.isArrayBindingPattern(pattern)) {
      for (const el of pattern.elements) {
        if (ts.isOmittedExpression(el)) elements.push(null);
        else elements.push({ isRest: Boolean(el.dotDotDotToken), node: el.name });
      }
    } else {
      for (const el of pattern.elements) {
        if (ts.isOmittedExpression(el)) elements.push(null);
        else if (ts.isSpreadElement(el)) elements.push({ isRest: true, node: unwrapAstExpr(el.expression, false) });
        else {
          const u = unwrapAstExpr(el, false);
          const lhsTarget = ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.EqualsToken ? unwrapAstExpr(u.left, false) : u;
          elements.push({ isRest: false, node: lhsTarget });
        }
      }
    }
    for (const br of expandAstBranchExprs(rhsExpr)) {
      if (!ts.isArrayLiteralExpression(br)) continue;
      let sawLhsRest = false;
      for (let idx = 0; idx < elements.length; idx += 1) {
        const item = elements[idx];
        if (!item) continue;
        if (item.isRest) sawLhsRest = true;
        let sawRhsSpread = false;
        const limit = Math.min(idx + 1, br.elements.length);
        for (let j = 0; j < limit; j += 1) {
          if (ts.isSpreadElement(br.elements[j]!)) {
            sawRhsSpread = true;
            break;
          }
        }
        const rhsItems: tsType.Expression[] = [];
        if (!sawLhsRest && !sawRhsSpread) {
          if (idx < br.elements.length && !ts.isOmittedExpression(br.elements[idx]!)) {
            rhsItems.push(br.elements[idx]!);
          }
        } else {
          for (let j = sawRhsSpread ? 0 : idx; j < br.elements.length; j += 1) {
            const rawEl = br.elements[j]!;
            if (ts.isOmittedExpression(rawEl)) continue;
            rhsItems.push(ts.isSpreadElement(rawEl) ? rawEl.expression : rawEl);
          }
        }
        for (const rhsItem of rhsItems) {
          forwardRhsValueToTarget(item.node, targetScope, rhsItem, evalScope, assignEndPos, depth + 1);
        }
      }
    }
  };

  const getScopedAssignmentTargets = (exprNode: tsType.Node, scope: AstLexScope): string[] => {
    let cur: tsType.Node = exprNode;
    const parentStack: tsType.Node[] = [];
    while (cur.parent) {
      const p = cur.parent;
      if (
        ts.isParenthesizedExpression(p) ||
        ts.isAsExpression(p) ||
        ts.isTypeAssertionExpression(p) ||
        ts.isSatisfiesExpression(p) ||
        ts.isNonNullExpression(p) ||
        ts.isAwaitExpression(p)
      ) {
        cur = p;
        continue;
      }
      parentStack.push(p);
      break;
    }
    const p = parentStack[0];
    if (!p) return [];
    if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.initializer === cur) {
      return collectAstBindingIdentifiers(p.name).map((n) => astVarKey(scope, n));
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === cur) {
      const lhs = unwrapAstExpr(p.left, false);
      if (ts.isIdentifier(lhs)) return [astVarKey(scope, lhs.text)];
    }
    return [];
  };

  const extractObjectBindingDestructurePairs = (
    pattern: tsType.ObjectBindingPattern,
    scope: AstLexScope,
  ): Array<{ key: string | null; isComputedBracket: boolean; isTopLevel: boolean; targets: string[] }> => {
    const out: Array<{ key: string | null; isComputedBracket: boolean; isTopLevel: boolean; targets: string[] }> = [];
    const bStack: Array<{ bp: tsType.ObjectBindingPattern; isTopLevel: boolean }> = [{ bp: pattern, isTopLevel: true }];
    while (bStack.length > 0) {
      const { bp, isTopLevel } = bStack.pop()!;
      for (const el of bp.elements) {
        if (el.dotDotDotToken) {
          out.push({
            key: null,
            isComputedBracket: true,
            isTopLevel,
            targets: collectAstBindingIdentifiers(el.name).map((n) => astVarKey(scope, n)),
          });
          continue;
        }
        const keyInfo = el.propertyName
          ? resolveAstPropertyName(el.propertyName, scope)
          : ts.isIdentifier(el.name)
            ? { name: el.name.text, isComputedBracket: false }
            : { name: null, isComputedBracket: false };
        if (ts.isObjectBindingPattern(el.name)) {
          bStack.push({ bp: el.name, isTopLevel: false });
          if (keyInfo.isComputedBracket || keyInfo.name === 'WebSocket' || keyInfo.name === 'XMLHttpRequest') {
            out.push({ key: keyInfo.name, isComputedBracket: keyInfo.isComputedBracket, isTopLevel, targets: [] });
          }
          continue;
        }
        out.push({
          key: keyInfo.name,
          isComputedBracket: keyInfo.isComputedBracket,
          isTopLevel,
          targets: collectAstBindingIdentifiers(el.name).map((n) => astVarKey(scope, n)),
        });
      }
    }
    return out;
  };

  const getDestructurePairsForRhs = (
    exprNode: tsType.Node,
    scope: AstLexScope,
  ): Array<{ key: string | null; isComputedBracket: boolean; isTopLevel: boolean; targets: string[] }> => {
    let cur: tsType.Node = exprNode;
    while (
      cur.parent &&
      (ts.isParenthesizedExpression(cur.parent) ||
        ts.isAsExpression(cur.parent) ||
        ts.isTypeAssertionExpression(cur.parent) ||
        ts.isSatisfiesExpression(cur.parent) ||
        ts.isNonNullExpression(cur.parent) ||
        ts.isAwaitExpression(cur.parent))
    ) {
      cur = cur.parent;
    }
    const p = cur.parent;
    if (!p) return [];
    if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.initializer === cur && ts.isObjectBindingPattern(p.name)) {
      return extractObjectBindingDestructurePairs(p.name, scope);
    }
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === cur) {
      const lhs = unwrapAstExpr(p.left, false);
      if (ts.isObjectLiteralExpression(lhs)) {
        return collectDestructuringTargetsAndRefs(lhs, scope).entries.map((e) => ({
          key: e.key,
          isComputedBracket: e.isComputedBracket,
          isTopLevel: e.isTopLevel,
          targets: e.targets.map((n) => astVarKey(scope, n)),
        }));
      }
    }
    return [];
  };

  interface WalkFrame {
    readonly node: tsType.Node;
    readonly scope: AstLexScope;
    readonly inTypePos: boolean;
    readonly suppressNotesLit: boolean;
  }

  const stack: WalkFrame[] = [{ node: sf, scope: rootScope, inTypePos: false, suppressNotesLit: false }];
  while (stack.length > 0) {
    const { node, scope, inTypePos, suppressNotesLit } = stack.pop()!;
    let nextScope = scope;
    let nextInTypePos = inTypePos;
    let nextSuppressNotesLit = suppressNotesLit;

    if (node !== sf) {
      if (ts.isBlock(node) || ts.isCaseBlock(node) || ts.isModuleBlock(node)) {
        nextScope = createAstChildScope(scope, false);
        seedBlockShadowIdentifiers(node, nextScope);
      } else if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        nextScope = createAstChildScope(scope, false);
        if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
          const isLexicalLoop = Boolean(node.initializer.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let));
          let targetLoopScope = nextScope;
          if (!isLexicalLoop) {
            while (targetLoopScope.parent && !targetLoopScope.isFnScope) targetLoopScope = targetLoopScope.parent;
          }
          for (const decl of node.initializer.declarations) {
            for (const name of collectAstBindingIdentifiers(decl.name)) {
              targetLoopScope.declaredNames.add(name);
              targetLoopScope.constStrings.set(name, null);
            }
          }
        }
      } else if (ts.isCatchClause(node)) {
        nextScope = createAstChildScope(scope, false);
        if (node.variableDeclaration) {
          for (const name of collectAstBindingIdentifiers(node.variableDeclaration.name)) {
            nextScope.declaredNames.add(name);
            nextScope.constStrings.set(name, null);
          }
        }
      } else if (ts.isFunctionLike(node)) {
        if (ts.isFunctionDeclaration(node) && node.name) {
          scope.declaredNames.add(node.name.text);
          scope.constStrings.set(node.name.text, null);
        }
        nextScope = createAstChildScope(scope, true);
        if (ts.isFunctionExpression(node) && node.name) {
          nextScope.declaredNames.add(node.name.text);
          nextScope.constStrings.set(node.name.text, null);
        }
        for (const param of node.parameters) {
          for (const name of collectAstBindingIdentifiers(param.name)) {
            nextScope.declaredNames.add(name);
            nextScope.constStrings.set(name, null);
          }
        }
      }
      if (
        ts.isTypeNode(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isTypeParameterDeclaration(node)
      ) {
        nextInTypePos = true;
      }
    }

    if (ts.isElementAccessExpression(node) && !nextInTypePos) {
      elementAccessNodes.push({ node, scope: nextScope });
    }

    // 1. Static import declarations
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      specifiersOut.push(spec);
      const ic = node.importClause;
      const isNamespace = Boolean(ic?.namedBindings && ts.isNamespaceImport(ic.namedBindings));
      let isDefault = Boolean(ic?.name);
      const barrelBindings: string[] = [];
      if (ic?.name) barrelBindings.push(astVarKey(nextScope, ic.name.text));
      if (ic?.namedBindings && ts.isNamespaceImport(ic.namedBindings)) {
        barrelBindings.push(astVarKey(nextScope, ic.namedBindings.name.text));
      } else if (ic?.namedBindings && ts.isNamedImports(ic.namedBindings)) {
        for (const el of ic.namedBindings.elements) {
          const importedName = (el.propertyName ?? el.name).text;
          if (importedName === 'default') {
            isDefault = true;
            barrelBindings.push(astVarKey(nextScope, el.name.text));
          }
        }
      }
      importDecls.push({ specifier: spec, isNamespace, isDefault, barrelBindings });

      if (!ic?.isTypeOnly) {
        const isFetchNetworkModule =
          findMatchingSpecifier(spec, BANNED_IMPORT) !== null ||
          findMatchingSpecifier(spec, AST_NETWORK_FETCH_MODULE_RE) !== null;
        const isDefaultFetchModule = findMatchingSpecifier(spec, AST_DEFAULT_FETCH_MODULE_RE) !== null;
        if (isDefaultFetchModule && ic?.name) {
          seedFetchGlobal(astVarKey(nextScope, ic.name.text));
        }
        if (ic?.namedBindings && ts.isNamedImports(ic.namedBindings)) {
          for (const el of ic.namedBindings.elements) {
            const importedName = (el.propertyName ?? el.name).text;
            if (importedName === 'execute') seedExecuteAliases.add(astVarKey(nextScope, el.name.text));
            if (
              (importedName === 'fetch' && isFetchNetworkModule) ||
              (importedName === 'default' && isDefaultFetchModule)
            ) {
              seedFetchGlobal(astVarKey(nextScope, el.name.text));
            }
          }
        }
        if (isNodeModuleSpecifier(spec)) {
          if (ic?.name) seedNodeModuleNs.add(astVarKey(nextScope, ic.name.text));
          if (ic?.namedBindings && ts.isNamespaceImport(ic.namedBindings)) {
            seedNodeModuleNs.add(astVarKey(nextScope, ic.namedBindings.name.text));
          } else if (ic?.namedBindings && ts.isNamedImports(ic.namedBindings)) {
            for (const el of ic.namedBindings.elements) {
              const importedName = (el.propertyName ?? el.name).text;
              if (importedName === 'createRequire') {
                seedCreateRequire.add(astVarKey(nextScope, el.name.text));
                hasBareRequire = true;
              } else if (importedName === 'default') {
                seedNodeModuleNs.add(astVarKey(nextScope, el.name.text));
              }
            }
          }
        }
        if (isMeterModuleSpecifier(spec)) {
          if (ic?.namedBindings && ts.isNamespaceImport(ic.namedBindings)) {
            seedMeterNs.add(astVarKey(nextScope, ic.namedBindings.name.text));
          } else if (ic?.namedBindings && ts.isNamedImports(ic.namedBindings)) {
            for (const el of ic.namedBindings.elements) {
              const importedName = (el.propertyName ?? el.name).text;
              if (importedName === 'metered') seedMeterAliases.add(astVarKey(nextScope, el.name.text));
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const modSpec = node.moduleSpecifier;
      if (modSpec && ts.isStringLiteral(modSpec)) {
        const spec = modSpec.text;
        specifiersOut.push(spec);
        const clause = node.exportClause;
        const isStar = !clause || ts.isNamespaceExport(clause);
        const namespaceAlias = clause && ts.isNamespaceExport(clause) ? clause.name.text : null;
        let isDirectUnaliased = !clause;
        let rawClauseSnippet = '';
        if (clause && ts.isNamedExports(clause)) {
          rawClauseSnippet = sf.text.slice(clause.getStart(sf), clause.end).replace(/\s+/g, ' ').trim();
          isDirectUnaliased =
            clause.elements.length > 0 &&
            clause.elements.every(
              (el) => !el.propertyName && ts.isIdentifier(el.name) && el.name.text !== 'default',
            );
          if (isDirectUnaliased && isNoteAiModelSpecifier(spec)) {
            for (const el of clause.elements) {
              validDirectReexportIdentNodes.add(el.name);
            }
          }
        }
        exportDecls.push({ specifier: spec, isStar, namespaceAlias, isDirectUnaliased, rawClauseSnippet });
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          localExports.push({ name: el.name.text, propertyName: el.propertyName?.text ?? null });
        }
      }
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const refExpr = node.moduleReference.expression;
      const spec = resolveAstConstString(refExpr, nextScope, 'full_const');
      const eqTarget = astVarKey(nextScope, node.name.text);
      if (spec !== null) {
        specifiersOut.push(spec);
        importDecls.push({ specifier: spec, isNamespace: true, isDefault: true, barrelBindings: [eqTarget] });
        if (isNodeModuleSpecifier(spec)) seedNodeModuleNs.add(eqTarget);
        if (isMeterModuleSpecifier(spec)) seedMeterNs.add(eqTarget);
      } else {
        hasComputedDynamic = true;
      }
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && (ts.isStringLiteral(node.argument.literal) || ts.isNoSubstitutionTemplateLiteral(node.argument.literal))) {
        specifiersOut.push(node.argument.literal.text);
      } else {
        hasComputedDynamic = true;
      }
    }

    // 2. Scoped const strings & variable/assignment alias propagation
    if (ts.isVariableDeclaration(node) && node.parent && ts.isVariableDeclarationList(node.parent)) {
      const isConst = Boolean(node.parent.flags & ts.NodeFlags.Const);
      const isLexical = Boolean(node.parent.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let));
      let varDeclScope = nextScope;
      if (!isLexical) {
        while (varDeclScope.parent && !varDeclScope.isFnScope) varDeclScope = varDeclScope.parent;
      }
      const inLoopHeader = ts.isForInStatement(node.parent.parent) || ts.isForOfStatement(node.parent.parent);
      if (isConst && !inLoopHeader && ts.isIdentifier(node.name) && node.initializer) {
        varDeclScope.declaredNames.add(node.name.text);
        varDeclScope.constStrings.set(node.name.text, resolveAstConstString(node.initializer, nextScope, 'full_const'));
      } else {
        for (const idName of collectAstBindingIdentifiers(node.name)) {
          varDeclScope.declaredNames.add(idName);
          varDeclScope.constStrings.set(idName, null);
        }
      }

      if (node.initializer) {
        const rhsTarget = ts.isIdentifier(node.name) ? [astVarKey(varDeclScope, node.name.text)] : [];
        const rhsExpr = recordBindAndMemberTarget(rhsTarget, node.initializer, nextScope, node.end);
        if (
          !isLexical &&
          ts.isIdentifier(node.name) &&
          node.parent.parent &&
          ts.isVariableStatement(node.parent.parent) &&
          node.parent.parent.parent &&
          (ts.isBlock(node.parent.parent.parent) ||
            ts.isSourceFile(node.parent.parent.parent) ||
            ts.isModuleBlock(node.parent.parent.parent))
        ) {
          fetchKillCandidates.push({
            varKey: astVarKey(varDeclScope, node.name.text),
            blockNode: resolveUnconditionalKillBlock(node.parent.parent.parent),
            pos: node.end,
            rhsExpr,
            fnNode: getAstEnclosingFnNode(node.parent.parent),
            evalScope: nextScope,
          });
        }
        if (ts.isObjectBindingPattern(node.name)) {
          recordDestructuredEntries(getDestructurePairsForRhs(node.initializer, nextScope), rhsExpr, nextScope, null);
          forwardObjectPatternToRhs(node.name, rhsExpr, nextScope, varDeclScope, node.end);
        } else if (ts.isArrayBindingPattern(node.name)) {
          recordArrayDestructure(node.name, rhsExpr, nextScope, varDeclScope, node.end);
        }
      }
    }

    if ((ts.isParameter(node) || ts.isBindingElement(node)) && node.initializer) {
      const rhsTarget = ts.isIdentifier(node.name) ? [astVarKey(nextScope, node.name.text)] : [];
      const rhsExpr = recordBindAndMemberTarget(rhsTarget, node.initializer, nextScope, node.end);
      if (ts.isObjectBindingPattern(node.name)) {
        recordDestructuredEntries(getDestructurePairsForRhs(node.initializer, nextScope), rhsExpr, nextScope, null);
        forwardObjectPatternToRhs(node.name, rhsExpr, nextScope, nextScope, node.end);
      } else if (ts.isArrayBindingPattern(node.name)) {
        recordArrayDestructure(node.name, rhsExpr, nextScope, nextScope, node.end);
      }
    }

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhsExpr = unwrapAstExpr(node.left, false);
      let lhsTarget: string[] = ts.isIdentifier(lhsExpr) ? [astVarKey(nextScope, lhsExpr.text)] : [];
      if (ts.isPropertyAccessExpression(lhsExpr) || ts.isElementAccessExpression(lhsExpr)) {
        const lhsMem = extractAstMemberName(lhsExpr, nextScope);
        const lhsHost = unwrapAstExpr(lhsMem.host, true);
        if (ts.isIdentifier(lhsHost) && lhsMem.memberName !== null) {
          const hostKey = astVarKey(nextScope, lhsHost.text);
          seedNonSafeKillBases.add(hostKey);
          lhsTarget = [`prop:${hostKey}\0${lhsMem.memberName}`];
        }
      }
      const rhsExpr = recordBindAndMemberTarget(lhsTarget, node.right, nextScope, node.end);
      if (ts.isIdentifier(lhsExpr) && node.parent) {
        let stmtCur: tsType.Node = node.parent;
        while (ts.isParenthesizedExpression(stmtCur)) stmtCur = stmtCur.parent;
        if (
          ts.isExpressionStatement(stmtCur) &&
          stmtCur.parent &&
          (ts.isBlock(stmtCur.parent) || ts.isSourceFile(stmtCur.parent) || ts.isModuleBlock(stmtCur.parent))
        ) {
          fetchKillCandidates.push({
            varKey: astVarKey(nextScope, lhsExpr.text),
            blockNode: resolveUnconditionalKillBlock(stmtCur.parent),
            pos: node.end,
            rhsExpr,
            fnNode: getAstEnclosingFnNode(stmtCur),
            evalScope: nextScope,
          });
        }
      }
      if (ts.isObjectLiteralExpression(lhsExpr)) {
        recordDestructuredEntries(
          collectDestructuringTargetsAndRefs(lhsExpr, nextScope).entries,
          rhsExpr,
          nextScope,
          nextScope,
        );
        forwardObjectPatternToRhs(lhsExpr, rhsExpr, nextScope, nextScope, node.end);
      } else if (ts.isArrayLiteralExpression(lhsExpr)) {
        recordArrayDestructure(lhsExpr, rhsExpr, nextScope, nextScope, node.end);
      }
    }

    // 3. Collect all CallExpressions (with outermost wrapper info for bound assignment/member access)
    if (ts.isCallExpression(node)) {
      const unwrapped = unwrapAstCall(node, nextScope);
      let outerAccessExpr: tsType.Expression = node;
      while (
        outerAccessExpr.parent &&
        (ts.isParenthesizedExpression(outerAccessExpr.parent) ||
          ts.isNonNullExpression(outerAccessExpr.parent))
      ) {
        outerAccessExpr = outerAccessExpr.parent;
      }
      callSites.push({
        call: node,
        calleeExpr: unwrapped.calleeExpr,
        firstArgExpr: unwrapped.firstArgExpr,
        missingApplyFirstArg: unwrapped.missingApplyFirstArg,
        isIndirect: unwrapped.isIndirect,
        scope: nextScope,
        boundTargets: getScopedAssignmentTargets(node, nextScope),
        outerAccessExpr,
      });
      const directCallee = unwrapAstExpr(node.expression, true);
      if (ts.isPropertyAccessExpression(directCallee) || ts.isElementAccessExpression(directCallee)) {
        const mem = extractAstMemberName(directCallee, nextScope);
        const recv = unwrapAstExpr(mem.host, true);
        if (mem.memberName === 'get' && ts.isIdentifier(recv) && recv.text === 'Reflect') {
          reflectGetCallNodes.push({ call: node, scope: nextScope });
        }
      }
    }

    // 4. Member accesses on hosts & computed destructured require/createRequire/agent
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && !nextInTypePos) {
      const mem = extractAstMemberName(node, nextScope);
      const hostNorm = unwrapAstExpr(mem.host, true);
      if (
        mem.memberName === 'require' ||
        mem.memberName === 'createRequire' ||
        mem.memberName === 'WebSocket' ||
        mem.memberName === 'XMLHttpRequest'
      ) {
        hostMemberAccesses.push({ hostExpr: hostNorm, memberName: mem.memberName, scope: nextScope });
      }
      if (ts.isCallExpression(hostNorm) && hostNorm.expression.kind === ts.SyntaxKind.ImportKeyword && mem.memberName === 'createRequire') {
        hasBareRequire = true;
      }
    }

    // 5. Identifiers, strings, templates, shorthand object props, root '+' concatenations
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isValidDirectExportIdent = validDirectReexportIdentNodes.has(node);
      if (!isValidDirectExportIdent) {
        checkStringOrIdentValue(node.text, false);
        if (!nextInTypePos && AST_TABLE_IDENT_RE.test(node.text) && !(parent && ts.isPropertyAssignment(parent) && parent.name === node)) {
          stringAndIdentMatches.add('table:crove_');
        }
      }
      if ((node.text === 'XMLHttpRequest' || node.text === 'WebSocket') && !nextInTypePos) {
        if (!parent || !isAstIdentNonValueRequireOrImportKey(node, parent, nextInTypePos)) {
          stringAndIdentMatches.add(node.text);
        }
      }
      if (node.text === 'createRequire' && parent && !isAstIdentNonValueRequireOrImportKey(node, parent, nextInTypePos)) {
        hasBareRequire = true;
      }
      if (node.text === 'require' && parent && !isAstIdentNonValueRequireOrImportKey(node, parent, nextInTypePos)) {
        const isDirectCall = ts.isCallExpression(parent) && parent.expression === node;
        if (!isDirectCall) hasBareRequire = true;
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const isValidDirectIdent = validDirectReexportIdentNodes.has(node);
      checkStringOrIdentValue(node.text, isValidDirectIdent, isValidDirectIdent);
      if (!nextSuppressNotesLit && node.text.startsWith('notes.')) {
        notesLiterals.push(node.text);
      }
    } else if (ts.isTemplateExpression(node)) {
      const resolved = resolveAstConstString(node, nextScope, 'full_const');
      if (resolved !== null) {
        checkStringOrIdentValue(resolved, true);
        if (!nextSuppressNotesLit && resolved.startsWith('notes.')) {
          notesLiterals.push(resolved);
          nextSuppressNotesLit = true;
        }
      } else if (!nextSuppressNotesLit && node.head.text.startsWith('notes.')) {
        notesLiterals.push(formatAstTemplateSpan(sf, node));
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(
        node.parent &&
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      )
    ) {
      const inlineOnly = resolveAstConstString(node, nextScope, 'inline_only');
      const resolved = inlineOnly ?? resolveAstConstString(node, nextScope, 'full_const');
      if (resolved !== null) {
        checkStringOrIdentValue(resolved, inlineOnly === null);
        if (!nextSuppressNotesLit && resolved.startsWith('notes.')) {
          notesLiterals.push(resolved);
          nextSuppressNotesLit = true;
        }
      }
    } else if (ts.isCallExpression(node)) {
      const strCallee = unwrapAstExpr(node.expression, true);
      if (
        (ts.isPropertyAccessExpression(strCallee) || ts.isElementAccessExpression(strCallee)) &&
        isAstStringGlobal(strCallee.expression, nextScope)
      ) {
        const resolved = resolveAstConstString(node, nextScope, 'full_const');
        if (resolved !== null) {
          checkStringOrIdentValue(resolved, true);
          if (!nextSuppressNotesLit && resolved.startsWith('notes.')) {
            notesLiterals.push(resolved);
            nextSuppressNotesLit = true;
          }
        }
      }
    }

    // Push children in reverse source order so pre-order statement scoping stays sequential.
    const children: tsType.Node[] = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let idx = children.length - 1; idx >= 0; idx -= 1) {
      stack.push({
        node: children[idx]!,
        scope: nextScope,
        inTypePos: nextInTypePos,
        suppressNotesLit: nextSuppressNotesLit,
      });
    }
  }

  // Stage 2: Propagate aliases and classify call sites
  for (const decl of importDecls) {
    if (isAgentBarrel(decl.specifier, fromRelPath) || isNoteAiModelSpecifier(decl.specifier)) {
      for (const b of decl.barrelBindings) seedAgentBindings.add(b);
    }
  }

  const resolveCallArgSpecs = (
    site: AstCallSiteRecord,
  ): { literalSpec: string | null; inlineConcatSpec: string | null; resolvedSpec: string | null } => {
    if (!site.firstArgExpr) return { literalSpec: null, inlineConcatSpec: null, resolvedSpec: null };
    const norm = unwrapAstExpr(site.firstArgExpr, false);
    const literalSpec =
      ts.isStringLiteral(norm) || ts.isNoSubstitutionTemplateLiteral(norm) ? norm.text : null;
    const inlineConcatSpec =
      literalSpec ?? resolveAstConstString(site.firstArgExpr, site.scope, 'inline_only');
    const resolvedSpec =
      inlineConcatSpec ?? resolveAstConstString(site.firstArgExpr, site.scope, 'full_const');
    return { literalSpec, inlineConcatSpec, resolvedSpec };
  };

  const seedModuleBindingsFromCallSite = (site: AstCallSiteRecord): void => {
    const { inlineConcatSpec, resolvedSpec } = resolveCallArgSpecs(site);
    const spec = inlineConcatSpec ?? resolvedSpec;
    if (spec === null) return;
    if (isNodeModuleSpecifier(spec)) {
      for (const t of site.boundTargets) seedNodeModuleNs.add(t);
      for (const d of getDestructurePairsForRhs(site.call, site.scope)) {
        if (d.key === 'createRequire') {
          hasBareRequire = true;
          for (const t of d.targets) seedCreateRequire.add(t);
        }
      }
    }
    if (isMeterModuleSpecifier(spec)) {
      for (const t of site.boundTargets) seedMeterNs.add(t);
      for (const d of getDestructurePairsForRhs(site.call, site.scope)) {
        if (d.key === 'metered') {
          for (const t of d.targets) seedMeterAliases.add(t);
        }
      }
    }
    const wsSpec = inlineConcatSpec;
    if (wsSpec !== null && (isAgentBarrel(wsSpec, fromRelPath) || isNoteAiModelSpecifier(wsSpec))) {
      for (const t of site.boundTargets) seedAgentBindings.add(t);
    }
  };

  for (const site of callSites) {
    if (site.calleeExpr.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(site.calleeExpr) && site.calleeExpr.text === 'require')) {
      seedModuleBindingsFromCallSite(site);
    }
  }

  const anyBranchMatchesModuleSpec = (
    expr: tsType.Expression,
    scope: AstLexScope,
    specPred: (s: string) => boolean,
  ): boolean => {
    for (const br of expandAstBranchExprs(expr)) {
      if (
        ts.isCallExpression(br) &&
        (br.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(br.expression) && br.expression.text === 'require'))
      ) {
        const arg0 = br.arguments[0];
        const mSpec = arg0 ? resolveAstConstString(arg0, scope, 'full_const') : null;
        if (mSpec !== null && specPred(mSpec)) return true;
      }
    }
    return false;
  };

  const requireHosts = propagateAliases(seedRequireHosts, aliasEdges);
  let nodeModuleNamespaces = propagateAliases(seedNodeModuleNs, aliasEdges);
  for (const access of hostMemberAccesses) {
    if (anyAstBranchMatchesSet(access.hostExpr, access.scope, requireHosts)) {
      if (access.memberName === 'require' || access.memberName === 'createRequire') {
        hasBareRequire = true;
      } else if (access.memberName === 'WebSocket' || access.memberName === 'XMLHttpRequest') {
        stringAndIdentMatches.add(access.memberName);
      }
    }
  }
  for (const cand of memberBindCandidates) {
    if (anyAstBranchMatchesSet(cand.host, cand.scope, nodeModuleNamespaces) && cand.propName === 'createRequire') {
      hasBareRequire = true;
      for (const t of cand.targets) seedCreateRequire.add(t);
    }
    if (anyAstBranchMatchesSet(cand.host, cand.scope, requireHosts)) {
      if (cand.propName === 'require') {
        hasBareRequire = true;
        for (const t of cand.targets) seedRequire.add(t);
      } else if (cand.propName === 'fetch') {
        for (const t of cand.targets) seedFetchAtNode(t, cand.rhsExpr);
      } else if (cand.propName === 'WebSocket' || cand.propName === 'XMLHttpRequest') {
        stringAndIdentMatches.add(cand.propName);
      }
    }
    if (cand.propName === 'execute') {
      for (const t of cand.targets) seedExecuteAliases.add(t);
    }
  }

  const prePropagatedMeterNs = propagateAliases(seedMeterNs, aliasEdges);
  for (const { call: rgCall, scope: rgScope } of reflectGetCallNodes) {
    const tgt = rgCall.arguments[0] ? unwrapAstExpr(rgCall.arguments[0], false) : null;
    const key = rgCall.arguments[1] ? unwrapAstExpr(rgCall.arguments[1], false) : null;
    const resolvedKey = key ? resolveAstConstString(key, rgScope, 'full_const') : null;
    const isReqHostTgt = Boolean(tgt && anyAstBranchMatchesSet(tgt, rgScope, requireHosts));
    if (isReqHostTgt) {
      if (resolvedKey === 'require') {
        hasBareRequire = true;
        for (const t of getScopedAssignmentTargets(rgCall, rgScope)) seedRequire.add(t);
      } else if (resolvedKey === 'createRequire') {
        hasBareRequire = true;
        for (const t of getScopedAssignmentTargets(rgCall, rgScope)) seedCreateRequire.add(t);
      } else if (resolvedKey === 'fetch') {
        for (const t of getScopedAssignmentTargets(rgCall, rgScope)) seedFetchAtNode(t, rgCall);
      } else if (resolvedKey === 'WebSocket' || resolvedKey === 'XMLHttpRequest') {
        stringAndIdentMatches.add(resolvedKey);
      }
    }
    if (tgt && anyAstBranchMatchesSet(tgt, rgScope, nodeModuleNamespaces) && resolvedKey === 'createRequire') {
      hasBareRequire = true;
      for (const t of getScopedAssignmentTargets(rgCall, rgScope)) seedCreateRequire.add(t);
    }
    if (tgt && anyAstBranchMatchesSet(tgt, rgScope, prePropagatedMeterNs) && resolvedKey === 'metered') {
      for (const t of getScopedAssignmentTargets(rgCall, rgScope)) seedMeterAliases.add(t);
    }
    if (resolvedKey === 'execute') {
      for (const t of getScopedAssignmentTargets(rgCall, rgScope)) seedExecuteAliases.add(t);
    }
  }

  // Handle `cr(...)` results feeding requireAliases (e.g. `const cr = m.createRequire; const r = cr(url);`).
  const createRequireAliases = propagateAliases(seedCreateRequire, aliasEdges);
  for (const site of callSites) {
    const isDirectCreateRequire =
      ts.isIdentifier(site.calleeExpr) && createRequireAliases.has(astVarKey(site.scope, site.calleeExpr.text));
    let isMemberCreateRequire = false;
    if (ts.isPropertyAccessExpression(site.calleeExpr) || ts.isElementAccessExpression(site.calleeExpr)) {
      const mem = extractAstMemberName(site.calleeExpr, site.scope);
      const h = unwrapAstExpr(mem.host, true);
      if (mem.memberName === 'createRequire') {
        if (anyAstBranchMatchesSet(h, site.scope, nodeModuleNamespaces) || anyBranchMatchesModuleSpec(h, site.scope, isNodeModuleSpecifier)) {
          isMemberCreateRequire = true;
        }
      }
    }
    if (isDirectCreateRequire || isMemberCreateRequire) {
      hasBareRequire = true;
      for (const t of site.boundTargets) seedRequire.add(t);
    }
  }

  const requireAliases = propagateAliases(seedRequire, aliasEdges);
  for (const site of callSites) {
    if (ts.isIdentifier(site.calleeExpr) && requireAliases.has(astVarKey(site.scope, site.calleeExpr.text))) {
      seedModuleBindingsFromCallSite(site);
    } else if (ts.isPropertyAccessExpression(site.calleeExpr) || ts.isElementAccessExpression(site.calleeExpr)) {
      const mem = extractAstMemberName(site.calleeExpr, site.scope);
      const h = unwrapAstExpr(mem.host, true);
      if (mem.memberName === 'require' && anyAstBranchMatchesSet(h, site.scope, requireHosts)) {
        seedModuleBindingsFromCallSite(site);
      }
    }
  }
  nodeModuleNamespaces = propagateAliases(seedNodeModuleNs, aliasEdges);
  const meterNamespaces = propagateAliases(seedMeterNs, aliasEdges);
  for (const cand of memberBindCandidates) {
    if (anyAstBranchMatchesSet(cand.host, cand.scope, meterNamespaces) && cand.propName === 'metered') {
      for (const t of cand.targets) seedMeterAliases.add(t);
    }
  }
  const meterAliases = propagateAliases(seedMeterAliases, aliasEdges);
  const agentBindings = propagateAliases(seedAgentBindings, aliasEdges);
  const executeAliases = propagateAliases(seedExecuteAliases, aliasEdges);
  let nonSafeKillBases = propagateAliases(seedNonSafeKillBases, aliasEdges);
  const isExprNonSafeKillSource = (expr: tsType.Expression, scope: AstLexScope): boolean => {
    for (const br of expandAstBranchExprs(expr)) {
      if (!ts.isIdentifier(br)) return true;
      const k = astVarKey(scope, br.text);
      if (requireHosts.has(k) || nonSafeKillBases.has(k)) return true;
    }
    return false;
  };
  let changedNonSafe = true;
  let nsPass = 0;
  while (changedNonSafe && nsPass < 8) {
    changedNonSafe = false;
    nsPass += 1;
    for (const cand of memberBindCandidates) {
      if (!isExprNonSafeKillSource(cand.host, cand.scope)) continue;
      for (const t of cand.targets) {
        if (!seedNonSafeKillBases.has(t)) {
          seedNonSafeKillBases.add(t);
          changedNonSafe = true;
        }
        seedNonSafeKillValues.add(t);
      }
    }
    for (const wrapCand of localWrapperBindTargets) {
      if (!isExprNonSafeKillSource(wrapCand.hostExpr, wrapCand.scope)) continue;
      for (const t of wrapCand.targets) {
        if (!seedNonSafeKillBases.has(t)) {
          seedNonSafeKillBases.add(t);
          changedNonSafe = true;
        }
        seedNonSafeKillValues.add(t);
      }
    }
    if (changedNonSafe) nonSafeKillBases = propagateAliases(seedNonSafeKillBases, aliasEdges);
  }
  const nonSafeKillValues = propagateAliases(seedNonSafeKillValues, aliasEdges);
  for (const k of fetchKillCandidates) {
    let isKnownSafeKill = false;
    if (ts.isIdentifier(k.rhsExpr)) {
      const rhsKey = astVarKey(k.evalScope, k.rhsExpr.text);
      isKnownSafeKill = !requireHosts.has(rhsKey) && !nonSafeKillValues.has(rhsKey);
    } else if (ts.isPropertyAccessExpression(k.rhsExpr)) {
      const base = unwrapAstExpr(k.rhsExpr.expression, true);
      if (ts.isIdentifier(base)) {
        const baseKey = astVarKey(k.evalScope, base.text);
        isKnownSafeKill = !requireHosts.has(baseKey) && !nonSafeKillBases.has(baseKey);
      }
    } else if (isAstKnownSafeFetchKillRhs(k.rhsExpr)) {
      isKnownSafeKill = true;
    }
    if (isKnownSafeKill) {
      let blockMap = fetchKillsByVarAndBlock.get(k.varKey);
      if (!blockMap) {
        blockMap = new Map<tsType.Node, number[]>();
        fetchKillsByVarAndBlock.set(k.varKey, blockMap);
      }
      let posArr = blockMap.get(k.blockNode);
      if (!posArr) {
        posArr = [];
        blockMap.set(k.blockNode, posArr);
        fetchDirtyKillArrays.push(posArr);
      }
      posArr.push(k.pos);
    }
  }
  for (const posArr of fetchDirtyKillArrays) {
    if (posArr.length > 1) posArr.sort((a, b) => a - b);
  }
  const fetchQueue: string[] = [...fetchGlobalVars, ...fetchTaintsByVarAndFn.keys()];
  const fetchInQueue = new Set<string>(fetchQueue);
  for (let head = 0; head < fetchQueue.length; head += 1) {
    const srcKey = fetchQueue[head]!;
    fetchInQueue.delete(srcKey);
    const outEdges = positionalEdgesBySource.get(srcKey);
    if (!outEdges) continue;
    for (const edge of outEdges) {
      if (!isFetchTaintedAtCall(edge.from, edge.rhsNode)) continue;
      if (
        addFetchTaintEvent(edge.to, {
          fnNode: edge.fnNode,
          rawStart: edge.rawPos,
          effStart: edge.effPos,
          loopNode: edge.loopNode,
        }) &&
        !fetchInQueue.has(edge.to)
      ) {
        fetchInQueue.add(edge.to);
        fetchQueue.push(edge.to);
      }
    }
  }

  // Check computed property access / Reflect.get / computed destructure on agent bindings
  for (const cand of memberBindCandidates) {
    if (anyAstBranchMatchesSet(cand.host, cand.scope, agentBindings)) {
      if (cand.isComputedBracket && cand.propName === null) {
        hasNonDirectAgentComputedAccess = true;
      }
      if (ts.isElementAccessExpression(cand.rhsExpr) && cand.propName === null) {
        hasNonDirectAgentComputedAccess = true;
      }
    }
  }
  for (const { node: elNode, scope: elScope } of elementAccessNodes) {
    const h = unwrapAstExpr(elNode.expression, false);
    const arg = unwrapAstExpr(elNode.argumentExpression, false);
    const isDirectLit = ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg);
    if (!isDirectLit && anyAstBranchMatchesSet(h, elScope, agentBindings)) {
      hasNonDirectAgentComputedAccess = true;
    }
  }
  for (const { call: rgCall, scope: rgScope } of reflectGetCallNodes) {
    const tgt = rgCall.arguments[0] ? unwrapAstExpr(rgCall.arguments[0], false) : null;
    const key = rgCall.arguments[1] ? unwrapAstExpr(rgCall.arguments[1], false) : null;
    const resolvedKey = key ? resolveAstConstString(key, rgScope, 'full_const') : null;
    const isDirectLit = Boolean(key && (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)));
    if (!isDirectLit && tgt && anyAstBranchMatchesSet(tgt, rgScope, agentBindings)) {
      hasNonDirectAgentComputedAccess = true;
    }
    if (tgt && anyAstBranchMatchesSet(tgt, rgScope, requireHosts) && (resolvedKey === 'require' || resolvedKey === 'createRequire')) {
      hasBareRequire = true;
    }
    if (tgt && anyAstBranchMatchesSet(tgt, rgScope, nodeModuleNamespaces) && resolvedKey === 'createRequire') {
      hasBareRequire = true;
    }
  }

  const dynamicCalls: AstDynamicCallFact[] = [];
  const meteredCalls: AstMeteredCallRecord[] = [];

  for (const site of callSites) {
    const callee = site.calleeExpr;
    let dynKind: 'import' | 'require' | null = null;
    let isIndirectRequire = false;
    let isMeterCall = false;

    const calleeBranches = expandAstBranchExprs(callee);
    for (const brCallee of calleeBranches) {
      if (brCallee.kind === ts.SyntaxKind.ImportKeyword) {
        dynKind = 'import';
      } else if (ts.isIdentifier(brCallee)) {
        const calleeKey = astVarKey(site.scope, brCallee.text);
        if (brCallee.text === 'require' && calleeKey === 'global:require') {
          dynKind = 'require';
          isIndirectRequire = site.isIndirect || calleeBranches.length > 1;
        } else if (requireAliases.has(calleeKey)) {
          dynKind = 'require';
          isIndirectRequire = true;
        }
        if (executeAliases.has(calleeKey)) callsExecute = true;
        if (isFetchTaintedAtCall(calleeKey, brCallee)) callsFetch = true;
        if (meterAliases.has(calleeKey)) isMeterCall = true;
      } else if (ts.isPropertyAccessExpression(brCallee) || ts.isElementAccessExpression(brCallee)) {
        const mem = extractAstMemberName(brCallee, site.scope);
        const h = unwrapAstExpr(mem.host, true);
        if (mem.memberName === 'require' && anyAstBranchMatchesSet(h, site.scope, requireHosts)) {
          dynKind = 'require';
          isIndirectRequire = true;
        } else if (mem.memberName === 'execute') {
          callsExecute = true;
        } else if (mem.memberName === 'fetch') {
          if (anyAstBranchMatchesSet(h, site.scope, requireHosts)) {
            callsFetch = true;
          } else {
            for (const br of expandAstBranchExprs(h)) {
              if (ts.isIdentifier(br) && isFetchTaintedAtCall(`prop:${astVarKey(site.scope, br.text)}\0fetch`, brCallee)) {
                callsFetch = true;
              }
            }
          }
        } else if (mem.memberName === 'metered') {
          if (
            anyAstBranchMatchesSet(h, site.scope, meterNamespaces) ||
            anyBranchMatchesModuleSpec(h, site.scope, isMeterModuleSpecifier)
          ) {
            isMeterCall = true;
          }
        } else if (mem.memberName !== null) {
          for (const br of expandAstBranchExprs(h)) {
            if (ts.isIdentifier(br) && isFetchTaintedAtCall(`prop:${astVarKey(site.scope, br.text)}\0${mem.memberName}`, brCallee)) {
              callsFetch = true;
            }
          }
          if (mem.memberName === 'get' && ts.isIdentifier(h) && h.text === 'Reflect') {
            const tgt = site.call.arguments[0] ? unwrapAstExpr(site.call.arguments[0], false) : null;
            const key = site.call.arguments[1] ? unwrapAstExpr(site.call.arguments[1], false) : null;
            const keyStr = key ? resolveAstConstString(key, site.scope, 'full_const') : null;
            if (tgt && anyAstBranchMatchesSet(tgt, site.scope, requireHosts) && keyStr === 'require') {
              hasBareRequire = true;
            }
          }
        }
      } else if (ts.isCallExpression(brCallee)) {
        const innerUnwrapped = unwrapAstCall(brCallee, site.scope);
        let isCrCallee = false;
        if (ts.isIdentifier(innerUnwrapped.calleeExpr) && createRequireAliases.has(astVarKey(site.scope, innerUnwrapped.calleeExpr.text))) {
          isCrCallee = true;
        } else if (ts.isPropertyAccessExpression(innerUnwrapped.calleeExpr) || ts.isElementAccessExpression(innerUnwrapped.calleeExpr)) {
          const mem = extractAstMemberName(innerUnwrapped.calleeExpr, site.scope);
          const h = unwrapAstExpr(mem.host, true);
          if (mem.memberName === 'createRequire') {
            if (anyAstBranchMatchesSet(h, site.scope, nodeModuleNamespaces) || anyBranchMatchesModuleSpec(h, site.scope, isNodeModuleSpecifier)) {
              isCrCallee = true;
            }
          }
        } else {
          const innerRg = extractReflectGetTargetAndKey(innerUnwrapped.calleeExpr, site.scope);
          if (
            innerRg &&
            innerRg.propName === 'createRequire' &&
            (anyAstBranchMatchesSet(innerRg.host, site.scope, nodeModuleNamespaces) ||
              anyAstBranchMatchesSet(innerRg.host, site.scope, requireHosts) ||
              anyBranchMatchesModuleSpec(innerRg.host, site.scope, isNodeModuleSpecifier))
          ) {
            isCrCallee = true;
          }
        }
        if (isCrCallee) {
          dynKind = 'require';
          isIndirectRequire = true;
        } else {
          const rg = extractReflectGetTargetAndKey(brCallee, site.scope);
          if (rg) {
            if (anyAstBranchMatchesSet(rg.host, site.scope, requireHosts)) {
              if (rg.propName === 'require') {
                dynKind = 'require';
                isIndirectRequire = true;
              } else if (rg.propName === 'fetch') {
                callsFetch = true;
              }
            }
            if (rg.propName === 'execute') {
              callsExecute = true;
            }
            if (
              rg.propName === 'metered' &&
              (anyAstBranchMatchesSet(rg.host, site.scope, meterNamespaces) ||
                anyBranchMatchesModuleSpec(rg.host, site.scope, isMeterModuleSpecifier))
            ) {
              isMeterCall = true;
            }
          }
        }
      }
    }

    if (dynKind !== null) {
      if (isIndirectRequire) hasBareRequire = true;
      const { literalSpec, inlineConcatSpec, resolvedSpec } = resolveCallArgSpecs(site);
      if (literalSpec === null) hasComputedDynamic = true;
      const specForOuter = inlineConcatSpec ?? resolvedSpec;
      if (specForOuter !== null) {
        if (literalSpec !== null) specifiersOut.push(literalSpec);
        else specifiersOut.push(specForOuter);
        if (
          inlineConcatSpec !== null &&
          (isAgentBarrel(inlineConcatSpec, fromRelPath) || isNoteAiModelSpecifier(inlineConcatSpec)) &&
          ts.isElementAccessExpression(site.outerAccessExpr.parent)
        ) {
          const elArg = unwrapAstExpr(site.outerAccessExpr.parent.argumentExpression, false);
          if (!(ts.isStringLiteral(elArg) || ts.isNoSubstitutionTemplateLiteral(elArg))) {
            hasNonDirectAgentComputedAccess = true;
          }
        }
      }
      dynamicCalls.push({
        fn: dynKind,
        literalSpec,
        inlineConcatSpec,
        resolvedSpec,
        boundTarget: site.boundTargets[0] ?? null,
        isIndirectRequire,
        node: site.call,
        callChainEnd: site.outerAccessExpr,
      });
    }

    if (isMeterCall && (site.firstArgExpr !== null || site.missingApplyFirstArg)) {
      const resolvedKeys: string[] = [];
      const templateSpans: string[] = [];
      const unresolvedSpecs: string[] = [];
      if (site.firstArgExpr) {
        analyzeAstMeteredKeyExpr(sf, site.firstArgExpr, site.scope, true, resolvedKeys, templateSpans, unresolvedSpecs);
      } else if (site.missingApplyFirstArg) {
        const s = site.call.getStart(sf);
        const snippet = sf.text.slice(s, Math.min(site.call.end, s + 64)).replace(/\s+/g, ' ').trim().slice(0, 64);
        unresolvedSpecs.push(`unresolved metered key (${snippet})`);
      }
      meteredCalls.push({
        openParenPos: findAstCallOpenParenPos(site.call, sf),
        argExpr: site.firstArgExpr,
        isMissingApplyArg: site.missingApplyFirstArg,
        resolvedKeys,
        templateSpans,
        unresolvedSpecs,
      });
    }
  }

  return {
    specifiers: specifiersOut,
    importDecls,
    exportDecls,
    localExports,
    dynamicCalls,
    hasComputedDynamic,
    hasBareRequire,
    hasNonDirectAgentComputedAccess,
    stringAndIdentMatches,
    interpolatedSymbolMatches,
    validDirectReexportIdentNodes,
    meteredCalls,
    notesLiterals,
    callsExecute,
    callsFetch,
    callsAgentBindings: agentBindings,
  };
}

// What a member-Vy feature module must never import: the command runtime and the kernel, the database, and the vendors behind the ports.
const BANNED_IMPORT = /^(?:node:(?:https?|http2|net|tls|dgram)$|https?$|undici$|axios$|@ludy\/(?:kernel|kernel-runtime|kernel-contract|db|mod-[a-z-]+)(?:\/|$)|kysely$|pg$|ai$|@ai-sdk\/|openai$|@anthropic-ai\/|mem0|@mem0\/|zep|@getzep\/|langchain|@langchain\/)/;

function collectMemberVyTokenPass(
  text: string,
  tokens: readonly Token[],
  out: Set<string>,
  assertSyntax: boolean,
  unambiguousRegexSpans?: ReadonlyArray<{ start: number; end: number }>,
): void {
  const { specifiers: specs, scan } = specifiers(text, tokens, undefined, unambiguousRegexSpans);
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

function collectAstModuleBoundaryHits(
  text: string,
  bannedRe: RegExp,
  out: Set<string>,
  filePath?: string,
  preParsed?: AstParsedResult,
): AstFileFacts[] {
  const parsed = preParsed ?? parseAstCandidates(text, filePath);
  if (parsed.hadRangeError || parsed.hasLexicalUnclosed || parsed.hasJsxUnclosed) {
    out.add('contains invalid or unclosed syntax');
  }
  const factsList: AstFileFacts[] = [];
  const emptySyms = new Set<string>();
  for (const sf of parsed.sources) {
    const facts = extractAstFacts(sf, emptySyms, filePath);
    factsList.push(facts);
    for (const spec of facts.specifiers) {
      const matched = findMatchingSpecifier(spec, bannedRe);
      if (matched !== null) out.add(`imports ${matched}`);
    }
    for (const call of facts.dynamicCalls) {
      const spec = call.resolvedSpec ?? call.inlineConcatSpec ?? call.literalSpec;
      if (spec !== null) {
        const matched = findMatchingSpecifier(spec, bannedRe);
        if (matched !== null) out.add(`imports ${matched}`);
      }
      if (call.literalSpec === null) {
        out.add('uses computed dynamic import or require');
      }
    }
    if (facts.hasComputedDynamic) out.add('uses computed dynamic import or require');
    if (facts.hasBareRequire) out.add('uses require alias or bare require reference');
  }
  return factsList;
}

// The violations of one member-Vy feature module's source, as short reasons.
export function memberVyViolations(text: string, filePath?: string): string[] {
  const out = new Set<string>();
  const parsed = parseAstCandidates(text, filePath);
  const assertTokenSyntax = parsed.hadRangeError || !parsed.hasCleanParse;
  const { primaryPasses, speculativePasses } = scanDualJsxAndTsPasses(text, filePath);
  for (const pass of primaryPasses) {
    collectMemberVyTokenPass(text, pass.tokens, out, assertTokenSyntax, pass.unambiguousRegexSpans);
  }
  for (const pass of speculativePasses) {
    collectMemberVyTokenPass(text, pass.tokens, out, false, pass.unambiguousRegexSpans);
  }
  for (const facts of collectAstModuleBoundaryHits(text, BANNED_IMPORT, out, filePath, parsed)) {
    for (const match of facts.stringAndIdentMatches) {
      if (match.startsWith('cmd:')) out.add(`names the command or path ${match.slice(4)}`);
      else if (match === 'table:crove_') out.add('names a crove_ table');
      else if (match === 'XMLHttpRequest' || match === 'WebSocket') out.add('calls the network directly');
    }
    if (facts.callsExecute) out.add('calls execute()');
    if (facts.callsFetch) out.add('calls the network directly');
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
  unambiguousRegexSpans?: ReadonlyArray<{ start: number; end: number }>,
): void {
  const { specifiers: specs, scan } = specifiers(text, tokens, undefined, unambiguousRegexSpans);
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

const ORG_FEATURE_BANNED_IMPORT = /(^|\/)member-vy(\/|$)|(^|\/)private-text(?:\.[cm]?[jt]s)?$/;

// What org-level features outside member-vy/ must never reach for: a member-Vy module, or the private-text brand.
export function orgFeatureViolations(text: string, filePath?: string): string[] {
  const body = stripComments(text);
  const out = new Set<string>();
  const parsed = parseAstCandidates(text, filePath);
  const assertTokenSyntax = parsed.hadRangeError || !parsed.hasCleanParse;
  const { primaryPasses, speculativePasses } = scanDualJsxAndTsPasses(text, filePath);
  for (const pass of primaryPasses) {
    collectOrgFeatureTokenPass(text, pass.tokens, out, assertTokenSyntax, pass.unambiguousRegexSpans);
  }
  for (const pass of speculativePasses) {
    collectOrgFeatureTokenPass(text, pass.tokens, out, false, pass.unambiguousRegexSpans);
  }
  for (const facts of collectAstModuleBoundaryHits(text, ORG_FEATURE_BANNED_IMPORT, out, filePath, parsed)) {
    if (facts.stringAndIdentMatches.has('PrivateText')) {
      out.add('names PrivateText');
    }
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

export function memberVyNames(text: string, filePath?: string): string[] {
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
  const parsed = parseAstCandidates(text, filePath);
  for (const sf of parsed.sources) {
    const facts = extractAstFacts(sf, names, filePath);
    for (const name of names) {
      if (facts.stringAndIdentMatches.has(name)) found.add(name);
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
  for (let pass = 0; pass < 16; pass += 1) {
    const parenTrim = stripOuterParens(tokens, s, e, delims);
    s = parenTrim.start;
    e = parenTrim.end;
    if (s >= e) break;
    let changed = false;
    if (
      tokens[s]?.kind === 'ident' &&
      !tokens[s]!.escaped &&
      tokens[s]?.value === 'await' &&
      s + 1 < e
    ) {
      s += 1;
      changed = true;
    } else if (
      tokens[s]?.kind === 'punct' &&
      tokens[s]?.value === '<' &&
      s + 2 < e &&
      !(tokens[s + 1]?.kind === 'punct' && tokens[s + 1]?.value === '/')
    ) {
      let ad = 1;
      let pd = 0;
      let bd = 0;
      let cd = 0;
      let td = 0;
      let aborted = false;
      let closeIdx = -1;
      const maxTypeIdx = Math.min(e, s + 64);
      for (let idx = s + 1; idx < maxTypeIdx; idx += 1) {
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
          else if (tk.value === ';') {
            aborted = true;
            break;
          } else if (pd === 0 && bd === 0 && cd === 0 && td === 0) {
            if (tk.value === '<') ad += 1;
            else if (tk.value === '>') ad -= 1;
            else if (tk.value === '>>' && ad >= 2) ad -= 2;
            else if (tk.value === '>>>' && ad >= 3) ad -= 3;
            if (ad === 0) {
              closeIdx = idx;
              break;
            }
          }
        }
      }
      if (!aborted && closeIdx > s + 1 && closeIdx + 1 < e) {
        s = closeIdx + 1;
        changed = true;
      }
    }
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
    handledUnresolvedParenStarts?: Set<number>;
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
        options?.handledUnresolvedParenStarts?.add(t.start);
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
    if (includeUnresolvedHere && !resolvedHere && options?.handledUnresolvedParenStarts) {
      options.handledUnresolvedParenStarts.add(t.start);
    }
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

interface PrecomputedNotesAst {
  readonly factsList: readonly AstFileFacts[];
  readonly hadRangeError: boolean;
}

const NOTES_METER_AST_TRIGGER_RE =
  /['"`]|import|require|Reflect|eval|Function|globalThis|window|self|\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})|\\x[0-9a-fA-F]{2}|from(?:CharCode|CodePoint)|\bString(?:\s*\))*(?:\s*\?\.)?\s*\[|\b(?:globalThis|window|self|module|global)\s*(?:\?\.)?\s*\[/;
const NOTES_LITERAL_AST_TRIGGER_RE =
  /['"`]|from(?:CharCode|CodePoint)|\bString(?:\s*\))*(?:\s*\?\.)?\s*\[|\b(?:globalThis|window|self|module|global)\s*(?:\?\.)?\s*\[|\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})|\\x[0-9a-fA-F]{2}/;
const EMPTY_PRECOMPUTED_NOTES_AST: PrecomputedNotesAst = { factsList: [], hadRangeError: false };

function hasNotesMeterTrigger(text: string): boolean {
  return (/\bmetered\b/.test(text) && /[(["'`[]/.test(text)) || NOTES_METER_AST_TRIGGER_RE.test(text);
}

function buildPrecomputedNotesAst(text: string, filePath?: string): PrecomputedNotesAst {
  if (!hasNotesMeterTrigger(text)) return EMPTY_PRECOMPUTED_NOTES_AST;
  const parsed = parseAstCandidates(text, filePath);
  const emptySyms = new Set<string>();
  return {
    factsList: parsed.sources.map((sf) => extractAstFacts(sf, emptySyms, filePath)),
    hadRangeError: parsed.hadRangeError,
  };
}

function collectMeteredNotes(
  text: string,
  options?: { includeUnresolved?: boolean },
  precomputedAst?: PrecomputedNotesAst,
): string[] {
  const primary = scanSource(text, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  const extraTokens = speculativeRescan(text, primary);
  const resolvedOpts = { includeUnresolved: Boolean(options?.includeUnresolved) };
  const resolvedParenStarts = new Set<number>();
  const handledUnresolvedParenStarts = new Set<number>();
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
    ...primary.unambiguousRegexSpans,
  ].sort((a, b) => a.start - b.start);
  const textWithoutUnambiguousRegex =
    primary.unambiguousRegexSpans.length > 0
      ? blankTextSpans(text, primary.unambiguousRegexSpans)
      : text;
  const found = new Set<string>([
    ...collectMeteredNotesFromTokens(primary.tokens, text, {
      ...resolvedOpts,
      resolvedParenStarts,
      handledUnresolvedParenStarts,
    }),
    ...collectMeteredNotesFromTokens(tokenize(textWithoutUnambiguousRegex, { scanRegexAsDivision: true }), text, {
      ...resolvedOpts,
      ignoreUnresolvedInRanges,
      handledUnresolvedParenStarts,
    }),
    ...(extraTokens
      ? collectMeteredNotesFromTokens(extraTokens, text, {
          ...resolvedOpts,
          resolvedParenStarts,
          handledUnresolvedParenStarts,
        })
      : []),
    ...collectRawMeteredNotes(text, resolvedParenStarts, validSkipSpans),
    ...[...textWithoutUnambiguousRegex.matchAll(/\bmetered\(\s*['"`](notes\.[a-z0-9_]+)['"`]/g)].map((m) => m[1]!),
  ]);

  const astData = precomputedAst ?? buildPrecomputedNotesAst(text);
  for (const facts of astData.factsList) {
    for (const mc of facts.meteredCalls) {
      for (const k of mc.resolvedKeys) found.add(k);
      for (const tsSpan of mc.templateSpans) found.add(tsSpan);
      if (resolvedOpts.includeUnresolved && !handledUnresolvedParenStarts.has(mc.openParenPos)) {
        for (const u of mc.unresolvedSpecs) found.add(u);
      }
    }
  }
  if (
    astData.hadRangeError &&
    resolvedOpts.includeUnresolved &&
    /\bmetered\b/.test(text) &&
    /<[A-Za-z>]/.test(text)
  ) {
    found.add('unresolved metered key (excessive nesting)');
  }
  return [...found];
}

export function meteredNotes(text: string, options?: { includeUnresolved?: boolean }): string[] {
  return collectMeteredNotes(text, options);
}

function collectNotesKeyLiterals(text: string, precomputedAst?: PrecomputedNotesAst): string[] {
  const found = new Set<string>();
  const primary = scanSource(text, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  const extraTokens = speculativeRescan(text, primary);
  const textWithoutUnambiguousRegex =
    primary.unambiguousRegexSpans.length > 0
      ? blankTextSpans(text, primary.unambiguousRegexSpans)
      : text;
  const tokenPasses: ReadonlyArray<readonly Token[]> = [
    primary.tokens,
    tokenize(textWithoutUnambiguousRegex, { scanRegexAsDivision: true }),
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
  const astData =
    precomputedAst ??
    (NOTES_LITERAL_AST_TRIGGER_RE.test(text) ? buildPrecomputedNotesAst(text) : EMPTY_PRECOMPUTED_NOTES_AST);
  for (const facts of astData.factsList) {
    for (const lit of facts.notesLiterals) found.add(lit);
  }
  return [...found];
}

export function notesKeyLiterals(text: string): string[] {
  return collectNotesKeyLiterals(text);
}

export function disallowedMeteredNotes(relFromSrc: string, text: string): string[] {
  const precomputedAst = buildPrecomputedNotesAst(text, relFromSrc);
  const calls = collectMeteredNotes(text, { includeUnresolved: true }, precomputedAst);
  const literals = collectNotesKeyLiterals(text, precomputedAst);
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
  filePath?: string,
): string[] {
  if (symbols.length === 0) return [];
  const symbolSet = new Set(symbols);
  const found = new Set<string>();
  collectSymbolTokenMatches(precomputedTokens ?? tokenize(fileText), symbolSet, found);
  const parsed = parseAstCandidates(fileText, filePath);
  for (const sf of parsed.sources) {
    const facts = extractAstFacts(sf, symbolSet, filePath);
    for (const sym of symbols) {
      if (facts.stringAndIdentMatches.has(sym) || facts.interpolatedSymbolMatches.has(sym)) found.add(sym);
    }
  }
  for (const sym of symbols) {
    if (found.has(sym)) continue;
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^\\w$])${escaped}(?![\\w$])`);
    if (re.test(fileText)) found.add(sym);
  }
  return symbols.filter((sym) => found.has(sym));
}

export function importsNoteAiModel(fileText: string, filePath?: string): boolean {
  const primary = scanSource(fileText, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  if (
    specifiers(fileText, primary.tokens, undefined, primary.unambiguousRegexSpans).specifiers.some((spec) =>
      isNoteAiModelSpecifier(spec),
    )
  ) {
    return true;
  }
  const extra = speculativeRescanWithSpans(fileText, primary);
  if (
    extra !== null &&
    specifiers(fileText, extra.tokens, undefined, primary.unambiguousRegexSpans).specifiers.some((spec) =>
      isNoteAiModelSpecifier(spec),
    )
  ) {
    return true;
  }
  const parsed = parseAstCandidates(fileText, filePath);
  const emptySyms = new Set<string>();
  for (const sf of parsed.sources) {
    const facts = extractAstFacts(sf, emptySyms, filePath);
    if (facts.specifiers.some((spec) => isNoteAiModelSpecifier(spec))) return true;
    for (const call of facts.dynamicCalls) {
      const s = call.resolvedSpec ?? call.inlineConcatSpec ?? call.literalSpec;
      if (s !== null && isNoteAiModelSpecifier(s)) return true;
    }
  }
  return false;
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
  unambiguousRegexSpans?: ReadonlyArray<{ start: number; end: number }>,
): string[] {
  const delims = pairDelimiters(tokens);
  const symbolSet = new Set(symbols);
  const violations = new Set<string>();
  const { specifiers: allSpecs, scan } = specifiers(indexText, tokens, delims, unambiguousRegexSpans);

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

  const mainAdapterSpecs = linearRawSpecifiers(
    unambiguousRegexSpans && unambiguousRegexSpans.length > 0 ? blankTextSpans(indexText, unambiguousRegexSpans) : indexText,
  )
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
    for (const sym of adapterSymbolReferences(symbols, checkText, checkTokens, 'packages/agent/src/index.ts')) {
      out.push(`references ${sym} inside index.ts instead of direct re-export`);
    }
  }
  return out;
}

export function indexReexportViolations(indexText: string, symbols: readonly string[]): string[] {
  const primary = scanSource(indexText, { emitTokens: true, stripCommentsMode: false, stripStrings: false });
  const out = new Set(
    collectIndexViolationsFromTokens(indexText, primary.tokens, symbols, true, primary.unambiguousRegexSpans),
  );
  const extraTokens = speculativeRescan(indexText, primary);
  if (extraTokens !== null) {
    for (const v of collectIndexViolationsFromTokens(indexText, extraTokens, symbols, false, primary.unambiguousRegexSpans)) {
      out.add(v);
    }
  }
  const symbolSet = new Set(symbols);
  const astOut = new Set<string>();
  const needsIndexAst =
    primary.tokens.some((t) => t.kind === 'invalid') ||
    /\b(?:import|export|require|createRequire|eval|Function|Reflect|globalThis|window|self)\b|['"`\\]|from(?:CharCode|CodePoint)|\bString(?:\s*\))*(?:\s*\?\.)?\s*\[|\b(?:globalThis|window|self|module|global)\s*(?:\?\.)?\s*\[|\\u(?:[0-9a-fA-F]{4}|\{[0-9a-fA-F]+\})|\\x[0-9a-fA-F]{2}/.test(
      indexText,
    ) ||
    symbols.some((s) => indexText.includes(s));
  const parsed = needsIndexAst ? parseAstCandidates(indexText, 'packages/agent/src/index.ts') : null;
  if (parsed && (parsed.hadRangeError || parsed.hasLexicalUnclosed)) {
    astOut.add('contains invalid or unclosed syntax');
  }
  for (const sf of parsed?.sources ?? []) {
    const facts = extractAstFacts(sf, symbolSet, 'packages/agent/src/index.ts');
    if (facts.hasComputedDynamic) astOut.add('uses computed dynamic import or require inside index.ts');
    if (facts.hasBareRequire) astOut.add('uses require alias or bare require reference inside index.ts');
    for (const spec of facts.specifiers) {
      if (isAgentBarrel(spec, 'packages/agent/src/index.ts')) {
        astOut.add('imports self inside index.ts instead of direct re-export');
      }
    }
    for (const imp of facts.importDecls) {
      if (isNoteAiModelSpecifier(imp.specifier)) {
        astOut.add('imports note-ai-model inside index.ts instead of direct re-export');
      }
    }
    for (const exp of facts.exportDecls) {
      if (isNoteAiModelSpecifier(exp.specifier)) {
        if (exp.isStar && exp.namespaceAlias !== null) {
          astOut.add(`re-exports note-ai-model under an alias (* as ${exp.namespaceAlias})`);
        } else if (!exp.isStar && !exp.isDirectUnaliased) {
          astOut.add(`re-exports note-ai-model under an alias (${exp.rawClauseSnippet})`);
        }
      }
    }
    for (const call of facts.dynamicCalls) {
      const spec = call.resolvedSpec ?? call.inlineConcatSpec ?? call.literalSpec;
      if (spec !== null) {
        if (isAgentBarrel(spec, 'packages/agent/src/index.ts')) {
          astOut.add('imports self inside index.ts instead of direct re-export');
        }
        if (isNoteAiModelSpecifier(spec)) {
          astOut.add('imports note-ai-model inside index.ts instead of direct re-export');
        }
      }
      if (call.literalSpec === null) {
        astOut.add('uses computed dynamic import or require inside index.ts');
      }
    }
    for (const locExp of facts.localExports) {
      if (symbolSet.has(locExp.name)) {
        astOut.add(`indirectly re-exports ${locExp.name} from index.ts`);
      } else if (locExp.propertyName !== null && symbolSet.has(locExp.propertyName)) {
        astOut.add(`indirectly re-exports ${locExp.propertyName} from index.ts`);
      }
    }
    if (astOut.size === 0 && out.size === 0) {
      for (const sym of symbols) {
        if (facts.stringAndIdentMatches.has(sym) || facts.interpolatedSymbolMatches.has(sym)) {
          astOut.add(`references ${sym} inside index.ts instead of direct re-export`);
        }
      }
    }
  }
  for (const v of astOut) out.add(v);
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

function scanWorkspaceMode(fileText: string, jsx: boolean): {
  primary: Token[];
  speculative: Array<{ tokens: Token[]; unambiguousRegexSpans: Array<{ start: number; end: number }> }>;
  unambiguousRegexSpans: Array<{ start: number; end: number }>;
} {
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
  const unambiguousRegexSpans = (fallback ?? firstPass).unambiguousRegexSpans;
  const speculative: Array<{ tokens: Token[]; unambiguousRegexSpans: Array<{ start: number; end: number }> }> = [];
  if (fallback && !tokens.some((t) => t.kind === 'invalid')) {
    speculative.push({ tokens, unambiguousRegexSpans: firstPass.unambiguousRegexSpans });
  }
  const firstSpec = speculativeRescan(fileText, firstPass, jsx);
  if (firstSpec) speculative.push({ tokens: firstSpec, unambiguousRegexSpans: firstPass.unambiguousRegexSpans });
  if (fallback) {
    const fallbackSpec = speculativeRescan(fileText, fallback, jsx);
    if (fallbackSpec) speculative.push({ tokens: fallbackSpec, unambiguousRegexSpans: fallback.unambiguousRegexSpans });
  }
  return { primary, speculative, unambiguousRegexSpans };
}

function scanDualJsxAndTsPasses(
  fileText: string,
  knownPath?: string,
): {
  primaryPasses: Array<{ tokens: Token[]; unambiguousRegexSpans: Array<{ start: number; end: number }> }>;
  speculativePasses: Array<{ tokens: Token[]; unambiguousRegexSpans: Array<{ start: number; end: number }> }>;
  isKnownJsxPath: boolean;
} {
  const isKnownJsxPath = Boolean(knownPath && /\.[jt]sx$/i.test(knownPath));
  const isKnownNonJsxPath = Boolean(knownPath && /\.(?:[cm]?ts|[cm]?js)$/i.test(knownPath));
  const primaryPasses: Array<{ tokens: Token[]; unambiguousRegexSpans: Array<{ start: number; end: number }> }> = [];
  const speculativePasses: Array<{ tokens: Token[]; unambiguousRegexSpans: Array<{ start: number; end: number }> }> = [];

  if (isKnownJsxPath) {
    const res = scanWorkspaceMode(fileText, true);
    primaryPasses.push({ tokens: res.primary, unambiguousRegexSpans: res.unambiguousRegexSpans });
    speculativePasses.push(...res.speculative);
  } else if (isKnownNonJsxPath) {
    const res = scanWorkspaceMode(fileText, false);
    primaryPasses.push({ tokens: res.primary, unambiguousRegexSpans: res.unambiguousRegexSpans });
    speculativePasses.push(...res.speculative);
  } else {
    const nonJsx = scanWorkspaceMode(fileText, false);
    const jsx = scanWorkspaceMode(fileText, true);
    const nonJsxInvalid = nonJsx.primary.some((t) => t.kind === 'invalid');
    const jsxInvalid = jsx.primary.some((t) => t.kind === 'invalid');
    if (!nonJsxInvalid) primaryPasses.push({ tokens: nonJsx.primary, unambiguousRegexSpans: nonJsx.unambiguousRegexSpans });
    if (!jsxInvalid) primaryPasses.push({ tokens: jsx.primary, unambiguousRegexSpans: jsx.unambiguousRegexSpans });
    if (nonJsxInvalid && jsxInvalid) {
      primaryPasses.push(
        { tokens: nonJsx.primary, unambiguousRegexSpans: nonJsx.unambiguousRegexSpans },
        { tokens: jsx.primary, unambiguousRegexSpans: jsx.unambiguousRegexSpans },
      );
    }
    speculativePasses.push(...nonJsx.speculative, ...jsx.speculative);
  }

  return { primaryPasses, speculativePasses, isKnownJsxPath };
}

function collectWorkspacePass(
  fileText: string,
  toks: readonly Token[],
  symbolSet: ReadonlySet<string>,
  fromRelPath: string | undefined,
  assertSyntax: boolean,
  out: Set<string>,
  unambiguousRegexSpans?: ReadonlyArray<{ start: number; end: number }>,
  deferredSyntaxState?: { hasInvalidSyntax: boolean },
  delimsOut?: DelimiterPairs[],
): boolean {
  const delims = pairDelimiters(toks);
  if (delimsOut) delimsOut.push(delims);
  const { specifiers: specs, scan } = specifiers(fileText, toks, delims, unambiguousRegexSpans);
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
    return false;
  }

  if (assertSyntax && scan.hasInvalidSyntax) {
    if (deferredSyntaxState) deferredSyntaxState.hasInvalidSyntax = true;
    else out.add('contains invalid or unclosed syntax');
  }
  if (hasUnresolvedDynamic) out.add('uses computed dynamic import or require');
  if (scan.hasBareRequire) out.add('uses require alias or bare require reference');
  collectComputedBindingAccess(toks, delims, scan, fromRelPath, out);
  return true;
}

function hasTokenResolvedWorkspaceTarget(
  primaryLists: ReadonlyArray<readonly Token[]>,
  symbols: readonly string[],
  fromRelPath: string | undefined,
  precomputedDelims?: readonly DelimiterPairs[],
): boolean {
  const symbolSet = new Set(symbols);
  for (let pIdx = 0; pIdx < primaryLists.length; pIdx += 1) {
    const tokens = primaryLists[pIdx]!;
    let hasConcatOp = false;
    let hasPlusOp = false;
    let hasStrOrTpl = false;
    for (let i = 0; i < tokens.length; i += 1) {
      const tk = tokens[i]!;
      if (tk.kind === 'template_head') hasConcatOp = true;
      else if (tk.kind === 'punct' && tk.value === '+') {
        hasConcatOp = true;
        hasPlusOp = true;
      } else if (tk.kind === 'string' || tk.kind === 'template') hasStrOrTpl = true;
      if (hasConcatOp && hasPlusOp && hasStrOrTpl) break;
    }
    if (!hasConcatOp || !hasStrOrTpl) continue;
    const delims = precomputedDelims?.[pIdx] ?? pairDelimiters(tokens);
    const { templateTail, templateNext } = buildTemplateMaps(tokens);
    const { scopes, tokenScope } = collectScopedConstBindings(tokens, delims, templateNext, templateTail);
    const constLookup: ConstLookupFn = (name, idx) => lookupScopedConst(scopes, tokenScope[idx] ?? 0, name);
    for (const sc of scopes) {
      for (const v of sc.bindings.values()) {
        if (v !== null && (symbolSet.has(v) || isAgentOrAdapterTextValue(v, fromRelPath))) return true;
      }
    }
    const advanceOp = (idx: number, maxEnd: number): number => {
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
      if (t.kind === 'template_head') {
        const tailIdx = templateTail[i] ?? -1;
        if (tailIdx >= 0) {
          const val = tryResolveConstantStringExpr(tokens, i, tailIdx + 1, delims, templateNext, constLookup, 0, templateTail);
          if (val !== null && (symbolSet.has(val) || isAgentOrAdapterTextValue(val, fromRelPath))) return true;
        }
      }
      if (!hasPlusOp) continue;
      if (t.kind !== 'template_head' && !(t.kind === 'punct' && t.value === '(')) {
        const nextTok = tokens[i + 1];
        if (!nextTok || nextTok.kind !== 'punct' || nextTok.value !== '+') continue;
      }
      const maxEnd = Math.min(tokens.length, i + 128);
      const firstEnd = advanceOp(i, maxEnd);
      if (firstEnd > i) {
        let cursor = firstEnd;
        while (cursor < maxEnd && tokens[cursor]?.kind === 'punct' && tokens[cursor]?.value === '+') {
          const nextEnd = advanceOp(cursor + 1, maxEnd);
          if (nextEnd < 0) break;
          cursor = nextEnd;
        }
        let hasPlusChain = cursor > firstEnd;
        if (!hasPlusChain && t.kind === 'punct' && t.value === '(') {
          for (let k = i + 1; k < cursor - 1; k += 1) {
            if (tokens[k]?.kind === 'punct' && tokens[k]?.value === '+') {
              hasPlusChain = true;
              break;
            }
          }
        }
        if (hasPlusChain) {
          const val = tryResolveConstantStringExpr(tokens, i, cursor, delims, templateNext, constLookup, 0, templateTail);
          if (val !== null && (symbolSet.has(val) || isAgentOrAdapterTextValue(val, fromRelPath))) return true;
        }
      }
    }
  }
  return false;
}

const WORKSPACE_AST_DIRECT_IDENTS = new Set([
  'fromCharCode',
  'fromCodePoint',
  'require',
  'createRequire',
  'eval',
  'Function',
  'Reflect',
]);

const WORKSPACE_HOST_DOT_MEMBERS = new Set([
  'fromCharCode',
  'fromCodePoint',
  'String',
  'require',
]);

const WORKSPACE_TS_TYPE_PREFIX_IDENTS = new Set([
  'typeof',
  'keyof',
  'readonly',
  'unique',
  'infer',
  'is',
  'asserts',
]);

function skipWorkspaceTypeAssertion(toks: readonly Token[], typeStart: number, limit: number): number {
  let j = typeStart;
  let td = 0;
  let expectTypeOperand = true;
  while (j < limit) {
    const tk = toks[j]!;
    if (td > 0) {
      if (tk.kind === 'template_head') {
        td += 1;
      } else if (tk.kind === 'template_tail') {
        td -= 1;
        if (td === 0) expectTypeOperand = false;
      } else if (tk.kind === 'punct') {
        if (tk.value === '(' || tk.value === '[' || tk.value === '{' || tk.value === '<') {
          td += 1;
        } else if (tk.value === ')' || tk.value === ']' || tk.value === '}' || tk.value === '>') {
          td -= 1;
          if (td === 0) expectTypeOperand = false;
        } else if (tk.value === '>>' || tk.value === '>>>') {
          td = Math.max(0, td - tk.value.length);
          if (td === 0) expectTypeOperand = false;
        }
      }
      j += 1;
      continue;
    }
    if (expectTypeOperand) {
      if (
        tk.kind === 'template_head' ||
        (tk.kind === 'punct' && (tk.value === '(' || tk.value === '[' || tk.value === '{' || tk.value === '<'))
      ) {
        td = 1;
        j += 1;
        continue;
      }
      if (tk.kind === 'ident' && WORKSPACE_TS_TYPE_PREFIX_IDENTS.has(tk.value)) {
        j += 1;
        continue;
      }
      if (
        tk.kind === 'ident' ||
        tk.kind === 'string' ||
        tk.kind === 'number' ||
        tk.kind === 'template' ||
        tk.kind === 'regex'
      ) {
        expectTypeOperand = false;
        j += 1;
        continue;
      }
      return j;
    }
    if (tk.kind === 'punct') {
      if (tk.value === '<' || tk.value === '[') {
        td = 1;
        j += 1;
        continue;
      }
      if (
        tk.value === '.' ||
        tk.value === '&' ||
        tk.value === '|' ||
        tk.value === '=>' ||
        tk.value === '?' ||
        tk.value === ':'
      ) {
        expectTypeOperand = true;
        j += 1;
        continue;
      }
    } else if (tk.kind === 'ident' && (tk.value === 'extends' || tk.value === 'is')) {
      expectTypeOperand = true;
      j += 1;
      continue;
    }
    return j;
  }
  return j;
}

function hasWorkspaceHostBracketOrMember(toks: readonly Token[], startIdx: number): boolean {
  let j = startIdx + 1;
  let steps = 0;
  const maxSteps = 20;
  while (j < toks.length && steps < maxSteps) {
    steps += 1;
    const tk = toks[j]!;
    if (tk.kind === 'punct') {
      if (tk.value === '[') return true;
      if (tk.value === '.') {
        const next = toks[j + 1];
        return Boolean(next?.kind === 'ident' && WORKSPACE_HOST_DOT_MEMBERS.has(next.value));
      }
      if (tk.value === '?.') {
        const next = toks[j + 1];
        return Boolean(
          (next?.kind === 'punct' && next.value === '[') ||
            (next?.kind === 'ident' && WORKSPACE_HOST_DOT_MEMBERS.has(next.value)),
        );
      }
      if (tk.value === ')' || tk.value === '!') {
        j += 1;
        continue;
      }
      return false;
    }
    if (tk.kind === 'ident' && (tk.value === 'as' || tk.value === 'satisfies')) {
      const nextIdx = skipWorkspaceTypeAssertion(toks, j + 1, Math.min(toks.length, j + 96));
      if (nextIdx <= j + 1) return false;
      j = nextIdx;
      continue;
    }
    return false;
  }
  return false;
}

function hasWorkspaceAstTokenTrigger(
  primaryLists: ReadonlyArray<readonly Token[]>,
  fromRelPath: string | undefined,
  hasRelevantKeywordHint: boolean,
): boolean {
  for (const toks of primaryLists) {
    for (let i = 0; i < toks.length; i += 1) {
      const t = toks[i]!;
      if (t.kind === 'invalid' && (fromRelPath !== undefined || hasRelevantKeywordHint)) {
        return true;
      }
      if (t.kind === 'regex') {
        if (
          /\b(?:import|require|createRequire|eval|Function|Reflect|String|globalThis|window|self|module|global|fromCharCode|fromCodePoint|agent|note-ai|generate|Todo|Summary|Note)|@ludy|@crove|packages\/agent|\\u(?:00[2-7][0-9a-fA-F]|\{0*[2-7][0-9a-fA-F]\})|\\x[2-7][0-9a-fA-F]/.test(
            t.raw,
          ) ||
          (/\{/.test(t.raw) && /['"`]/.test(t.raw))
        ) {
          return true;
        }
        continue;
      }
      if (t.kind !== 'ident') continue;
      if (t.value === 'import') {
        const next = toks[i + 1];
        if (next?.kind === 'punct' && next.value === '(') return true;
        continue;
      }
      if (WORKSPACE_AST_DIRECT_IDENTS.has(t.value)) return true;
      if ((t.value === 'String' || AST_REQUIRE_HOSTS.has(t.value)) && hasWorkspaceHostBracketOrMember(toks, i)) {
        return true;
      }
    }
  }
  return false;
}

function shouldParseWorkspaceAst(
  fileText: string,
  symbols: readonly string[],
  fromRelPath: string | undefined,
  isKnownJsxPath: boolean,
  primaryLists: ReadonlyArray<readonly Token[]>,
  outSize: number,
  tokenRelevant: boolean,
  primaryDelims?: readonly DelimiterPairs[],
): boolean {
  if (tokenRelevant || outSize > 0) return true;
  const relFromRoot = fromRelPath?.replace(/\\/g, '/');
  if (relFromRoot && relFromRoot.startsWith('packages/agent/')) return true;
  if (fromRelPath === undefined && fileText.length < 30_000) return true;
  const hasRelevantKeywordHint =
    /@(?:ludy|crove)|agent|note-ai|packages|\b(?:import|export|require|createRequire|eval|Function|Reflect|String|globalThis|window|self|module|global)\b|generate|Summary|Todo|from(?:CharCode|CodePoint)|\\u(?:00[2-7][0-9a-fA-F]|\{0*[2-7][0-9a-fA-F]\})|\\x[2-7][0-9a-fA-F]|await\s+(?:\(\s*)?['"`]/.test(
      fileText,
    );
  if (hasWorkspaceAstTokenTrigger(primaryLists, fromRelPath, hasRelevantKeywordHint)) {
    return true;
  }
  if (
    /(?:@(?:ludy|crove)(?:$|[^a-zA-Z0-9_/]|\/(?:$|[^a-zA-Z0-9_]|a(?:$|g|[^a-zA-Z0-9_-])))|note-ai|packages\/agent|generate(?:Note|Todo)|SummaryText|TodoSuggest|TodoPlan|NoteOrganize|\\u(?:00[2-7][0-9a-fA-F]|\{0*[2-7][0-9a-fA-F]\})|\\x[2-7][0-9a-fA-F]|globalThis)/.test(
      fileText,
    )
  ) {
    return true;
  }
  if (hasTokenResolvedWorkspaceTarget(primaryLists, symbols, fromRelPath, primaryDelims)) {
    return true;
  }
  if (symbols.some((sym) => fileText.includes(sym))) return true;
  if (
    isKnownJsxPath &&
    /(?<![/*])\/(?![/*])\s*\{(?![ \t]*[a-zA-Z0-9_$.]+[ \t]*\})/.test(fileText)
  ) {
    return true;
  }
  if (
    Boolean(relFromRoot && relFromRoot.startsWith('packages/')) &&
    fileText.length < 30_000 &&
    /\b(?:import|export|require)\b/.test(fileText) &&
    /(?:^|\W)\.\.?(?:\/|['"`])/.test(fileText) &&
    /(?:agent|note-ai|packages|\\u(?:00[2-7][0-9a-fA-F]|\{0*[2-7][0-9a-fA-F]\})|\\x[2-7][0-9a-fA-F]|\\\r?\n)/i.test(
      fileText,
    )
  ) {
    return true;
  }
  return false;
}

export function workspaceAdapterLeakViolations(
  fileText: string,
  symbols: readonly string[],
  fromRelPath?: string,
): string[] {
  const { primaryPasses, speculativePasses, isKnownJsxPath } = scanDualJsxAndTsPasses(fileText, fromRelPath);
  const primaryLists = primaryPasses.map((p) => p.tokens);
  const primaryDelims: DelimiterPairs[] = [];

  const symbolSet = new Set(symbols);
  const out = new Set<string>();
  let tokenRelevant = false;
  const syntaxState = { hasInvalidSyntax: false };
  for (const pass of primaryPasses) {
    if (
      collectWorkspacePass(
        fileText,
        pass.tokens,
        symbolSet,
        fromRelPath,
        true,
        out,
        pass.unambiguousRegexSpans,
        syntaxState,
        primaryDelims,
      )
    ) {
      tokenRelevant = true;
    }
  }
  for (const pass of speculativePasses) {
    if (collectWorkspacePass(fileText, pass.tokens, symbolSet, fromRelPath, false, out, pass.unambiguousRegexSpans)) {
      tokenRelevant = true;
    }
  }

  if (
    shouldParseWorkspaceAst(
      fileText,
      symbols,
      fromRelPath,
      isKnownJsxPath,
      primaryLists,
      out.size,
      tokenRelevant,
      primaryDelims,
    )
  ) {
    const parsed = parseAstCandidates(fileText, fromRelPath);
    const astFailedParse = parsed.hadRangeError || !parsed.hasCleanParse;
    let astRelevant = tokenRelevant || out.size > 0 || Boolean(fromRelPath && fromRelPath.replace(/\\/g, '/').startsWith('packages/agent/'));
    let astHasUnresolvedDynamic = false;
    let astHasBareRequire = false;
    let astHasComputedAccess = false;
    const astInterpolatedSymbols = new Set<string>();
    for (const sf of parsed.sources) {
      const facts = extractAstFacts(sf, symbolSet, fromRelPath);
      if (facts.specifiers.some((spec) => isNoteAiModelSpecifier(spec))) {
        out.add('imports note-ai-model');
        astRelevant = true;
      }
      for (const decl of facts.importDecls) {
        if (!isAgentBarrel(decl.specifier, fromRelPath)) continue;
        astRelevant = true;
        if (decl.isNamespace) out.add('namespace import from @ludy/agent');
        if (decl.isDefault) out.add('default import from @ludy/agent');
      }
      for (const decl of facts.exportDecls) {
        if (isAgentBarrel(decl.specifier, fromRelPath)) {
          astRelevant = true;
          if (decl.isStar) out.add('export * from @ludy/agent');
        }
      }
      for (const call of facts.dynamicCalls) {
        const wsSpec = call.inlineConcatSpec;
        if (wsSpec !== null) {
          if (isAgentBarrel(wsSpec, fromRelPath)) {
            out.add(`dynamic ${call.fn} from @ludy/agent`);
            astRelevant = true;
          }
          if (isNoteAiModelSpecifier(wsSpec)) {
            out.add('imports note-ai-model');
            astRelevant = true;
          }
        } else {
          astHasUnresolvedDynamic = true;
        }
        const deepSpec = call.resolvedSpec ?? call.inlineConcatSpec ?? call.literalSpec;
        if (deepSpec !== null && isAgentOrAdapterTextValue(deepSpec, fromRelPath)) {
          astRelevant = true;
        }
      }
      for (const sym of symbols) {
        if (facts.stringAndIdentMatches.has(sym)) {
          out.add(sym);
          astRelevant = true;
        } else if (facts.interpolatedSymbolMatches.has(sym)) {
          astInterpolatedSymbols.add(sym);
        }
      }
      if (facts.callsAgentBindings.size > 0 || facts.specifiers.some((s) => isAgentOrAdapterTextValue(s, fromRelPath))) {
        astRelevant = true;
      }
      if (facts.hasBareRequire) astHasBareRequire = true;
      if (facts.hasNonDirectAgentComputedAccess) astHasComputedAccess = true;
    }
    if (astInterpolatedSymbols.size > 0) {
      astRelevant = true;
      if (!out.has('uses computed dynamic import or require') && !astHasUnresolvedDynamic) {
        for (const sym of astInterpolatedSymbols) out.add(sym);
      }
    }
    if (astRelevant) {
      if (parsed.hadRangeError || parsed.hasLexicalUnclosed || parsed.hasJsxUnclosed || (syntaxState.hasInvalidSyntax && astFailedParse)) {
        out.add('contains invalid or unclosed syntax');
      }
      if (astHasUnresolvedDynamic) out.add('uses computed dynamic import or require');
      if (astHasBareRequire) out.add('uses require alias or bare require reference');
      if (astHasComputedAccess) out.add('uses computed property access on @ludy/agent binding');
    }
  } else if (syntaxState.hasInvalidSyntax) {
    out.add('contains invalid or unclosed syntax');
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
    const bad = sources(MEMBER_VY).flatMap((file) => {
      const rel = relative(ROOT, file);
      return memberVyViolations(readFileSync(file, 'utf8'), rel).map((v) => `${rel}: ${v}`);
    });
    expect(bad).toEqual([]);
  });

  it('keeps every org-level feature to plain strings: none imports a member-Vy module or the PrivateText brand', () => {
    const bad = sources(SRC)
      .filter((file) => !file.startsWith(`${MEMBER_VY}/`) && !file.endsWith('/private-text.ts'))
      .flatMap((file) => {
        const rel = relative(ROOT, file);
        return orgFeatureViolations(readFileSync(file, 'utf8'), rel).map((v) => `${rel}: ${v}`);
      });
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
    expect(memberVyViolations('const f = function () {} / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(memberVyViolations(`const f = function () {} / (import('pg'), "'") / 2;`).length).toBeGreaterThan(0);
    expect(memberVyViolations('const f = async function* foo(a = {}): { ok: number } { return { ok: 1 }; } / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(memberVyViolations('const f = () => function () {} / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(memberVyViolations('const c = class extends Base { m() {} } / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(memberVyViolations(`const c = class {} / (import('pg'), "'") / 2;`).length).toBeGreaterThan(0);
    expect(orgFeatureViolations('const f = function () {} / Number(import("./member-vy/" + "x.ts")) / 2;').length).toBeGreaterThan(0);
    expect(orgFeatureViolations('const c = class {} / Number(import("./member-vy/" + "x.ts")) / 2;').length).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        'const c = class {} / Number(import("@ludy/" + "agent")) / 2;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(disallowedMeteredNotes('other.ts', 'const f = function () {} / Number(metered("notes." + "a", fn)) / 2;')).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.ts', 'const c = class {} / Number(metered("notes." + "a", fn)) / 2;')).toEqual(['notes.a']);
    expect(memberVyViolations('const f = function (): (string) {} / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(memberVyViolations('const f = function (): ({ a: number }) {} / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(memberVyViolations('const f = function (): A & (B) {} / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(memberVyViolations('const f = function (): T extends X ? Y : (Z) {} / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(memberVyViolations('const f = function (): [string] {} / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(orgFeatureViolations('const f = function (): (string) {} / Number(import("./member-vy/" + "x.ts")) / 2;').length).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        'const f = function (): (string) {} / Number(import("@ludy/" + "agent")) / 2;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(disallowedMeteredNotes('other.ts', 'const f = function (): (string) {} / Number(metered("notes." + "a", fn)) / 2;')).toEqual(['notes.a']);
    expect(memberVyViolations('const x = { default: {} / Number(import("p" + "g")) / 2 };').length).toBeGreaterThan(0);
    expect(memberVyViolations('const x = { case: {} / Number(import("p" + "g")) / 2 };').length).toBeGreaterThan(0);
    expect(memberVyViolations('const x = { a: 1, default: {} / Number(import("p" + "g")) / 2 };').length).toBeGreaterThan(0);
    expect(memberVyViolations('const x = { [k]: 1, default: {} / Number(import("p" + "g")) / 2 };').length).toBeGreaterThan(0);
    expect(memberVyViolations('switch (x) { case 1: return { default: {} / Number(import("p" + "g")) / 2 }; }').length).toBeGreaterThan(0);
    expect(memberVyViolations('export default { a: 1 } / Number(import("p" + "g")) / 2;').length).toBeGreaterThan(0);
    expect(orgFeatureViolations('const x = { default: {} / Number(import("./member-vy/" + "x.ts")) / 2 };')).toContain('imports ./member-vy/x.ts');
    expect(orgFeatureViolations('const x = { case: {} / Number(import("./member-vy/" + "x.ts")) / 2 };')).toContain('imports ./member-vy/x.ts');
    expect(orgFeatureViolations('const x = { a: 1, default: {} / Number(import("./member-vy/" + "x.ts")) / 2 };')).toContain('imports ./member-vy/x.ts');
    expect(orgFeatureViolations('const x = { [k]: 1, default: {} / Number(import("./member-vy/" + "x.ts")) / 2 };')).toContain('imports ./member-vy/x.ts');
    expect(orgFeatureViolations('switch (x) { case 1: return { default: {} / Number(import("./member-vy/" + "x.ts")) / 2 }; }')).toContain('imports ./member-vy/x.ts');
    expect(orgFeatureViolations('export default { a: 1 } / Number(import("./member-vy/" + "x.ts")) / 2;')).toContain('imports ./member-vy/x.ts');
    expect(
      workspaceAdapterLeakViolations(
        'const x = { default: {} / Number(import("@ludy/" + "agent")) / 2 };',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        'const x = { [k]: 1, default: {} / Number(import("@ludy/" + "agent")) / 2 };',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        'switch (x) { case 1: return { default: {} / Number(import("@ludy/" + "agent")) / 2 }; }',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        'export default { a: 1 } / Number(import("@ludy/" + "agent")) / 2;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.ts',
      ).length,
    ).toBeGreaterThan(0);
    expect(disallowedMeteredNotes('other.ts', 'const x = { case: {} / Number(metered("notes." + "a", fn)) / 2 };')).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.ts', 'const x = { a: 1, default: {} / Number(metered("notes." + "a", fn)) / 2 };')).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.ts', 'const x = { [k]: 1, default: {} / Number(metered("notes." + "a", fn)) / 2 };')).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.ts', 'switch (x) { case 1: return { default: {} / Number(metered("notes." + "a", fn)) / 2 }; }')).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.ts', 'export default { a: 1 } / Number(metered("notes." + "a", fn)) / 2;')).toEqual(['notes.a']);

    // JSX expression containers (.tsx / .jsx) must remain fail-closed when `{ ... } / ...` encloses disallowed code (#5035).
    expect(memberVyViolations('const j = <a>{ {} / Number(import("p" + "g")) / 2 }</a>;')).toContain('imports pg');
    expect(
      memberVyViolations("export function C() { return <div>{ {} / ((r) => r('pg'))(module.require) / 2 }</div>; }").length,
    ).toBeGreaterThan(0);
    expect(memberVyViolations('const j = <a>x{ function () {} / Number(import("p" + "g")) / 2 }</a>;')).toContain('imports pg');
    expect(memberVyViolations('const j = <><b/>{ class {} / Number(import("p" + "g")) / 2 }</>;')).toContain('imports pg');
    expect(memberVyViolations('const j = <div>{ { default: 1 } / Number(import("p" + "g")) / 2 }</div>;')).toContain('imports pg');
    expect(orgFeatureViolations('const j = <a>{ {} / Number(import("./member-vy/" + "x.ts")) / 2 }</a>;')).toContain('imports ./member-vy/x.ts');
    expect(
      orgFeatureViolations("export function C() { return <div>{ {} / ((r) => r('./member-vy/' + 'x.ts'))(module.require) / 2 }</div>; }"),
    ).toContain('uses require alias or bare require reference');
    expect(orgFeatureViolations('const j = <a>x{ function () {} / Number(import("./member-vy/" + "x.ts")) / 2 }</a>;')).toContain(
      'imports ./member-vy/x.ts',
    );
    expect(orgFeatureViolations('const j = <><b/>{ class {} / Number(import("./member-vy/" + "x.ts")) / 2 }</>;')).toContain(
      'imports ./member-vy/x.ts',
    );
    expect(orgFeatureViolations('const j = <div>{ { default: 1 } / Number(import("./member-vy/" + "x.ts")) / 2 }</div>;')).toContain(
      'imports ./member-vy/x.ts',
    );
    expect(
      workspaceAdapterLeakViolations(
        'const j = <a>{ {} / Number(import("@ludy/" + "agent")) / 2 }</a>;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.tsx',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        "export function C() { return <div>{ {} / ((r) => r('@ludy/agent'))(module.require) / 2 }</div>; }",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.jsx',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        'const j = <a>x{ function () {} / Number(import("@ludy/" + "agent")) / 2 }</a>;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.tsx',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        'const j = <><b/>{ class {} / Number(import("@ludy/" + "agent")) / 2 }</>;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.tsx',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      workspaceAdapterLeakViolations(
        'const j = <div>{ { default: 1 } / Number(import("@ludy/" + "agent")) / 2 }</div>;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/app/src/sneaky.tsx',
      ).length,
    ).toBeGreaterThan(0);
    expect(disallowedMeteredNotes('other.tsx', 'const j = <a>{ {} / Number(metered("notes." + "a", fn)) / 2 }</a>;')).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.tsx', 'const j = <a>x{ function () {} / Number(metered("notes." + "a", fn)) / 2 }</a>;')).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.tsx', 'const j = <><b/>{ class {} / Number(metered("notes." + "a", fn)) / 2 }</>;')).toEqual(['notes.a']);
    expect(disallowedMeteredNotes('other.tsx', 'const j = <div>{ { default: 1 } / Number(metered("notes." + "a", fn)) / 2 }</div>;')).toEqual(['notes.a']);

    // Control-flow keywords in JSX text and JSX `>` followed by `/{expr}/` must speculatively rescan and expose disallowed payloads (#5035).
    const elseJsxImport = memberVyViolations("export function C() { return <p>else{}/{Number(import('p' + 'g'))}/</p>; }");
    expect(elseJsxImport).toContain('imports pg');
    expect(elseJsxImport).toContain('uses computed dynamic import or require');
    for (const kwPrefix of ['try{0}', 'if(x){0}', 'while(x){0}', 'for(;;){0}', 'catch{0}', 'catch(e){0}', 'finally{0}']) {
      expect(memberVyViolations(`export function C() { return <p>${kwPrefix}/{Number(import('p' + 'g'))}/</p>; }`), kwPrefix).toContain('imports pg');
    }
    expect(memberVyViolations("export function C() { return <p>else{}/{module.require('pg')}/</p>; }")).toContain(
      'uses require alias or bare require reference',
    );
    const quoteFreeElseJsx = memberVyViolations('export function C(x: string) { return <p>else{}/{module.require(x)}/</p>; }');
    expect(quoteFreeElseJsx).toContain('uses require alias or bare require reference');
    expect(quoteFreeElseJsx).toContain('uses computed dynamic import or require');
    expect(memberVyViolations('export function C() { return <Foo a="1">/{Number(import(\'p\' + \'g\'))}/</Foo>; }')).toContain('imports pg');
    expect(memberVyViolations('export function C() { return <div x={1 > 0}>/{Number(import(\'p\' + \'g\'))}/</div>; }')).toContain('imports pg');
    const quoteFreeGtJsx = memberVyViolations('export function C(x: string) { return <p>a>/{module.require(x)}/</p>; }');
    expect(quoteFreeGtJsx).toContain('uses require alias or bare require reference');
    expect(quoteFreeGtJsx).toContain('uses computed dynamic import or require');
    expect(orgFeatureViolations("export function C() { return <p>else{}/{Number(import('./member-vy/' + 'x.ts'))}/</p>; }")).toContain(
      'imports ./member-vy/x.ts',
    );
    expect(orgFeatureViolations('export function C() { return <Foo a="1">/{Number(import(\'./member-vy/\' + \'x.ts\'))}/</Foo>; }')).toContain(
      'imports ./member-vy/x.ts',
    );
    expect(disallowedMeteredNotes('other.tsx', 'export function C() { return <p>else{}/{metered(name)}/</p>; }').length).toBeGreaterThan(0);
    expect(disallowedMeteredNotes('other.tsx', 'export function C() { return <Foo a="1">/{metered(name)}/</Foo>; }').length).toBeGreaterThan(0);
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
      .flatMap((file) => memberVyNames(readText(file), file).map((n) => `${relative(ROOT, file)}: ${n}`));
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
      .filter((file) => importsNoteAiModel(readText(file), file))
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
        adapterSymbolReferences(seededExports, readText(file), undefined, file).map((sym) => `${relative(ROOT, file)}: ${sym}`),
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
    expect(disallowedMeteredNotes('other.ts', 'if (enabled) { doWork(); } else {} /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'while (enabled) {} /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'for (const item of items) {} /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'for await (const item of items) {} /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'try {} catch {} /metered(name)/.test(text);')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'try {} catch (err) {} finally {} /metered(name)/.test(text);')).toEqual([]);
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

  it('closes #5106 JSX-text, self-closing tag, quote-free expression, switch, and generated JSX probe matrix bypasses via TypeScript AST walk', () => {
    // 1. Named #5106 JSX-text keyword bypasses inside <p>...</p>, <div><b/>...</div>, and <><b/>...</>
    for (const kw of [
      'return',
      'typeof',
      'case',
      'in',
      'new',
      'delete',
      'throw',
      'instanceof',
      'export',
      'do{}while(0)',
    ]) {
      for (const sample of [
        `<p>${kw}/{Number(import('p' + 'g'))}/</p>`,
        `<div><b/>${kw}/{Number(import('p' + 'g'))}/</div>`,
        `<><b/>${kw}/{Number(import('p' + 'g'))}/</>`,
      ]) {
        const mv = memberVyViolations(sample);
        expect(mv, sample).toContain('imports pg');
        expect(mv, sample).toContain('uses computed dynamic import or require');
      }
    }

    // 2. Quote-free `{} / module.require(x) / 2` across expression, JSX, arrow, class, and switch contexts
    const quoteFreeExprContexts = [
      '({} / module.require(x) / 2)',
      'const a = {} / module.require(x) / 2',
      'export default {} / module.require(x) / 2',
      'function f() { return {} / module.require(x) / 2; }',
      'const f = () => ({} / module.require(x) / 2)',
      'class C { p = {} / module.require(x) / 2 }',
      'switch ({} / module.require(x) / 2) {}',
      'switch (a) { case {} / module.require(x) / 2: break; }',
      '<p>{ {} / module.require(x) / 2 }</p>',
      'const C = () => <p>return/{ {} / module.require(x) / 2 }/</p>',
    ];
    for (const expr of quoteFreeExprContexts) {
      const mv = memberVyViolations(expr);
      expect(mv, `memberVy: ${expr}`).toContain('uses require alias or bare require reference');
      expect(mv, `memberVy: ${expr}`).toContain('uses computed dynamic import or require');

      const ov = orgFeatureViolations(expr);
      expect(ov, `orgFeature: ${expr}`).toContain('uses require alias or bare require reference');
      expect(ov, `orgFeature: ${expr}`).toContain('uses computed dynamic import or require');

      const wvPkgPath = expr.includes('<p>') ? 'packages/agent/src/sneaky.tsx' : 'packages/agent/src/sneaky.ts';
      const wvPkg = workspaceAdapterLeakViolations(expr, DEFAULT_ADAPTER_EXPORTS, wvPkgPath);
      expect(wvPkg, `workspace(agent): ${expr}`).toContain('uses require alias or bare require reference');
      expect(wvPkg, `workspace(agent): ${expr}`).toContain('uses computed dynamic import or require');

      const wvExt = workspaceAdapterLeakViolations(
        `import { AiBudgetExhaustedError } from '@ludy/agent';\n${expr}`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/sneaky.tsx',
      );
      expect(wvExt, `workspace(imported): ${expr}`).toContain('uses require alias or bare require reference');
      expect(wvExt, `workspace(imported): ${expr}`).toContain('uses computed dynamic import or require');
    }

    // Quote-free regex after `switch (x) {}` stays clean, while JSX text `switch(x){}/{...}/` still flags.
    expect(disallowedMeteredNotes('other.ts', 'switch (x) {} /metered(name)/.test(y)')).toEqual([]);
    expect(disallowedMeteredNotes('other.ts', 'switch (x) {} /metered("notes.summary", fn)/.test(y)')).toEqual([]);
    expect(memberVyViolations('switch (x) {} /import(foo)/.test(y)')).toEqual([]);
    expect(memberVyViolations('switch (x) {} /import("pg")/.test(y)')).toEqual([]);
    expect(memberVyViolations('switch (x) {} /require(foo)/.test(y)')).toEqual([]);
    expect(memberVyViolations('switch (x) {} /require("pg")/.test(y)')).toEqual([]);
    expect(orgFeatureViolations('switch (x) {} /import("\\.\\/member-vy\\/x\\.ts")/.test(y)')).toEqual([]);
    expect(
      workspaceAdapterLeakViolations('switch (x) {} /import("@ludy\\/agent")/.test(y)', DEFAULT_ADAPTER_EXPORTS, 'apps/web/src/ok.ts'),
    ).toEqual([]);
    expect(memberVyViolations('export const Panel = () => <div>don\'t</div>;')).toEqual([]);
    expect(
      memberVyViolations(
        "function a() { const f = globalThis.fetch; } function b(f: () => void) { f(); }",
      ),
    ).toEqual([]);
    expect(disallowedMeteredNotes('other.tsx', '<p>switch(x){}/{Number(metered(dynKey, fn))}/</p>')).toEqual([
      'unresolved metered key (dynKey)',
    ]);
    expect(disallowedMeteredNotes('other.tsx', '<p>switch(x){}/{Number(metered("no" + "tes.summary", fn))}/</p>')).toEqual([
      'notes.summary',
    ]);

    // 3. Replicated Platform PO generated JSX keyword x tag x expression probe matrix (0 bypasses across all 4 scanners)
    const jsxKeywords = [
      'return',
      'typeof',
      'void',
      'delete',
      'await',
      'yield',
      'throw',
      'new',
      'case',
      'default',
      'in',
      'of',
      'instanceof',
      'extends',
      'implements',
      'export',
      'import',
      'if',
      'else',
      'while',
      'for',
      'do',
      'switch',
      'try',
      'catch',
      'finally',
      'break',
      'continue',
      'debugger',
      'with',
      'as',
      'satisfies',
      'is',
      'keyof',
      'infer',
      'readonly',
      'asserts',
      'abstract',
      'declare',
      'enum',
      'interface',
      'module',
      'namespace',
      'package',
      'private',
      'protected',
      'public',
      'static',
      'type',
      'using',
      'let',
      'const',
      'var',
      'function',
      'class',
      'async',
      'from',
      'get',
      'set',
      'accessor',
      'true',
      'false',
      'null',
      'undefined',
      'this',
      'super',
      'do{}while(0)',
      'if(x){}',
      'switch(x){}',
      'while(x){}',
      'for(;;){}',
      'try{}catch{}',
      'a!',
      'a as T',
      '{}',
      '() => {}',
      'x &&',
    ];
    const jsxWrappers: Array<(kw: string, expr: string) => string> = [
      (kw, expr) => `<p>${kw}/{${expr}}/</p>`,
      (kw, expr) => `<div><b/>${kw}/{${expr}}/</div>`,
      (kw, expr) => `<><b/>${kw}/{${expr}}/</>`,
      (kw, expr) => `<Comp a="1" b={x > 0}>${kw}/{${expr}}/</Comp>`,
      (kw, expr) => `<p>{cond ? <span>${kw}/{${expr}}/</span> : null}</p>`,
      (kw, expr) => `<div><a>${kw}</a>/{${expr}}/</div>`,
    ];
    let probeCount = 0;
    for (const kw of jsxKeywords) {
      for (const wrap of jsxWrappers) {
        const mvProbe = wrap(kw, "Number(import('p' + 'g'))");
        expect(memberVyViolations(mvProbe), `mv bypass: ${mvProbe}`).toContain('imports pg');
        probeCount += 1;

        const orgProbe = wrap(kw, "Number(import('./member-' + 'vy/x.ts'))");
        expect(orgFeatureViolations(orgProbe), `org bypass: ${orgProbe}`).toContain('imports ./member-vy/x.ts');
        probeCount += 1;

        const wsProbe = wrap(kw, "Number(import('@ludy/' + 'agent'))");
        expect(workspaceAdapterLeakViolations(wsProbe, DEFAULT_ADAPTER_EXPORTS, 'apps/web/src/C.tsx'), `ws bypass: ${wsProbe}`).toContain(
          'dynamic import from @ludy/agent',
        );
        probeCount += 1;

        const meterProbe = wrap(kw, 'Number(metered(dynKey, fn))');
        expect(disallowedMeteredNotes('other.tsx', meterProbe), `meter bypass: ${meterProbe}`).toContain(
          'unresolved metered key (dynKey)',
        );
        probeCount += 1;
      }
    }
    expect(probeCount).toBe(1848);
    expect(probeCount).toBeGreaterThanOrEqual(1740);

    // #5084 review edge cases: <br/>, </a>/, regex-vs-division around keywords/postfix ops, size invariance, and scoped fetch isolation
    expect(memberVyViolations("<div><br/>return/{Number(import('p' + 'g'))}/</div>")).toContain('imports pg');
    expect(memberVyViolations('if (x) /import(foo)/.test(s);')).toEqual([]);
    expect(memberVyViolations("const y = obj.if / Number(import('p' + 'g')) / 2;")).toContain('imports pg');
    expect(memberVyViolations("const y = obj.while / Number(import('p' + 'g')) / 2;")).toContain('imports pg');
    expect(memberVyViolations('function f() { return\n/import(foo)/.test(s); }')).toEqual([]);
    expect(memberVyViolations("const y = x++ / Number(import('p' + 'g')) / 2;")).toContain('imports pg');
    expect(memberVyViolations("const y = x-- / Number(import('p' + 'g')) / 2;")).toContain('imports pg');
    expect(memberVyViolations('const read = cache.fetch; read("k");')).toEqual([]);
    expect(memberVyViolations('const { fetch: read } = cache; read("k");')).toEqual([]);
    expect(memberVyViolations('const read = globalThis.fetch; read("https://x.test");')).toContain('calls the network directly');
    expect(
      memberVyViolations(
        'function outer() { const read = globalThis.fetch; void read; }\nconst fn = function read(n: number): number { return n > 0 ? read(n - 1) : 0; };',
      ),
    ).toEqual([]);
    const largeTsxPad = ' '.repeat(30_000);
    expect(
      disallowedMeteredNotes(
        'other.tsx',
        `export const C = () => <p>${largeTsxPad}return/{Number(metered('no' + 'tes.summary', fn))}/</p>;`,
      ),
    ).toEqual(['notes.summary']);
    expect(
      notesKeyLiterals(`export const C = () => <p>${largeTsxPad}return/{'no' + 'tes.summary'}/</p>;`),
    ).toEqual(['notes.summary']);

    // Additional AST alias/attr/barrel/non-regression coverage
    expect(importsNoteAiModel("export const C = () => <p>return/{Number(import('./note-ai-' + 'model.ts'))}/</p>;")).toBe(true);
    expect(
      indexReexportViolations("export * from './note-ai-model.ts'; export const C = () => <p>return/{Number(import('./note-ai-' + 'model.ts'))}/</p>;", DEFAULT_ADAPTER_EXPORTS).length,
    ).toBeGreaterThan(0);
    expect(memberVyNames("export const C = () => <p>return/{'Private' + 'Text'}/</p>;")).toContain('PrivateText');
    expect(memberVyViolations("const g = globalThis; g['req' + 'uire']('pg');")).toContain('imports pg');
    expect(memberVyViolations("Reflect.get(globalThis, 'require')('pg');")).toContain('uses require alias or bare require reference');
    expect(memberVyViolations("const { ['exec' + 'ute']: ex } = rt; ex(cmd);")).toContain('calls execute()');
    expect(memberVyViolations('export interface Props { require?: boolean; execute?: () => void }')).toEqual([]);
    expect(memberVyViolations('const opts = { require: true };')).toEqual([]);
    expect(orgFeatureViolations('export const Panel = () => <div>don\'t</div>;')).toEqual([]);
    expect(
      disallowedMeteredNotes('other.tsx', "export const C = () => <Comp keyProp={Reflect.apply(metered.bind(null), null, ['notes.' + 'summary', fn])} />;"),
    ).toContain('notes.summary');
    expect(
      memberVyViolations("<p>return/{(() => { const load = require; return load('pg'); })()}/</p>"),
    ).toContain('imports pg');
    expect(
      workspaceAdapterLeakViolations(
        "<p>return/{(() => { const r = globalThis.require; const a = r('@ludy/agent'); return a[k]; })()}/</p>",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toContain('uses computed property access on @ludy/agent binding');
    expect(
      workspaceAdapterLeakViolations(
        "import { AiBudgetExhaustedError } from '@ludy/agent';\nexport const C = () => <Field require={true} />;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual([]);
    expect(
      disallowedMeteredNotes('other.tsx', "export const C = () => <p>return/{metered.bind(null, 'notes.summary')(fn)}/</p>;"),
    ).toEqual(['notes.summary']);

    // Codex review P2 regressions: file-extension strictness, block FunctionDeclaration scope, benign fetch import, interpolated symbol refs
    expect(memberVyViolations("export const Panel = () => <div>don't</div>;", 'packages/agent/src/member-vy/panel.ts')).toContain(
      'contains invalid or unclosed syntax',
    );
    expect(memberVyViolations("export const Panel = () => <div>don't</div>;", 'packages/agent/src/member-vy/panel.tsx')).toEqual([]);
    expect(orgFeatureViolations("export const Panel = () => <div>don't</div>;", 'packages/agent/src/panel.ts')).toContain(
      'contains invalid or unclosed syntax',
    );
    expect(orgFeatureViolations("export const Panel = () => <div>don't</div>;", 'packages/agent/src/panel.tsx')).toEqual([]);
    expect(
      memberVyViolations(
        "function outer(flag: boolean) {\n  const read = globalThis.fetch;\n  if (flag) {\n    function read() {}\n    void read;\n  }\n  read('https://evil.test');\n}",
      ),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("function outer() {\n  const read = globalThis.fetch;\n  void read;\n  {\n    function read(k: string) { return k; }\n    read('ok');\n  }\n}"),
    ).toEqual([]);
    expect(memberVyViolations("import { fetch as read } from './cache.ts'; read(key);")).toEqual([]);
    expect(memberVyViolations("import { fetch as read } from 'node-fetch'; read('https://evil.test');")).toContain('calls the network directly');
    expect(adapterSymbolReferences(['generateNoteSummaryText'], "const fn = `generateNote${'SummaryText'}`;")).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(adapterSymbolReferences(['generateNoteSummaryText'], "const suffix = 'SummaryText'; const fn = 'generateNote' + suffix;")).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(
      indexReexportViolations(
        "export { generateNoteSummaryText } from './note-ai-model.ts';\nconst ref = `generateNote${'SummaryText'}`;",
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toContain('references generateNoteSummaryText inside index.ts instead of direct re-export');

    // Second Codex review regressions: workspace interpolated symbol leaks, >100KB invariance, default node-fetch import, valid TSX comment generics
    const largeCommentPad = `// ${'x'.repeat(100_050)}\n`;
    expect(
      workspaceAdapterLeakViolations(
        "const fn = `generateNote${'SummaryText'}`;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        `${largeCommentPad}const suffix = 'SummaryText'; const fn = 'generateNote' + suffix;`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      adapterSymbolReferences(
        ['generateNoteSummaryText'],
        `${largeCommentPad}const fn = \`generateNote\${'SummaryText'}\`;`,
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(memberVyViolations("import request from 'node-fetch'; request('https://evil.test');")).toContain(
      'calls the network directly',
    );
    expect(memberVyViolations("import { default as request } from 'node-fetch'; request('https://evil.test');")).toContain(
      'calls the network directly',
    );
    expect(memberVyViolations("import read from './cache.ts'; read(key);")).toEqual([]);
    expect(memberVyViolations("import { default as read } from './cache.ts'; read(key);")).toEqual([]);
    expect(
      memberVyViolations('const id = <T /* type */,>(x: T) => x;', 'packages/agent/src/member-vy/c.tsx'),
    ).toEqual([]);
    expect(
      memberVyViolations("const id = <T /* type */,>(x: T) => x;\nimport pg from 'pg';", 'packages/agent/src/member-vy/c.tsx'),
    ).toEqual(['imports pg']);
    expect(
      orgFeatureViolations('const id = <T /* type */,>(x: T) => x;', 'packages/agent/src/c.tsx'),
    ).toEqual([]);
    expect(
      orgFeatureViolations(
        "const id = <T /* type */,>(x: T) => x;\nimport { x } from './member-vy/secret.ts';",
        'packages/agent/src/c.tsx',
      ),
    ).toEqual(['imports ./member-vy/secret.ts']);

    // Third Codex review regressions: out-of-order const concat under apps/, workspace valid TSX comment generics, speculative regex spans, flow-sensitive fetch
    expect(
      workspaceAdapterLeakViolations(
        "const d = 'Text';\nconst c = 'Summary';\nconst b = 'Note';\nconst a = 'generate';\nexport const fn = a + b + c + d;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        "const s1 = 'Summary';\nconst s2 = 'generate';\nexport const fn = `${s2}Note${s1}Text`;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        'const id = <T /* type */,>(x: T) => x;',
        DEFAULT_ADAPTER_EXPORTS,
        'packages/agent/src/c.tsx',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        "const id = <T /* type */,>(x: T) => x;\nimport { generateNoteSummaryText } from '@ludy/agent';",
        DEFAULT_ADAPTER_EXPORTS,
        'packages/agent/src/c.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(memberVyViolations('const r = /import("pg")/;\nconst ratio = a / b; // ratio')).toEqual([]);
    expect(orgFeatureViolations('const r = /import("\\.\\/member-vy\\/x\\.ts")/;\nconst ratio = a / b; // ratio')).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        'const r = /import("@ludy\\/agent")/;\nconst ratio = a / b; // ratio',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual([]);
    expect(importsNoteAiModel('const r = /import("\\.\\/note-ai-model\\.ts")/;\nconst ratio = a / b; // ratio')).toBe(false);
    expect(
      indexReexportViolations(
        "export * from './note-ai-model.ts';\nconst r = /import(\"\\.\\/note-ai-model\\.ts\")/;\nconst ratio = a / b; // ratio",
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toEqual([]);
    expect(memberVyViolations('let read = cache.fetch;\nread(key);\nread = globalThis.fetch;')).toEqual([]);
    expect(
      memberVyViolations('let read = cache.fetch;\nconst copy = read;\ncopy(key);\nread = globalThis.fetch;'),
    ).toEqual([]);
    expect(memberVyViolations('let read = cache.fetch;\nread = globalThis.fetch;\nread(key);')).toContain(
      'calls the network directly',
    );
    expect(
      memberVyViolations(
        'let read = cache.fetch;\nfor (let i = 0; i < 2; i += 1) {\n  read(key);\n  read = globalThis.fetch;\n}',
      ),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations('let read = cache.fetch;\nfunction go() { read(key); }\nread = globalThis.fetch;\ngo();'),
    ).toContain('calls the network directly');

    // Fourth Codex review regressions: split Summary+out-of-order const under apps/, safe fetch reassignment kills, O(V+E) reverse chain
    expect(
      workspaceAdapterLeakViolations(
        "const p1 = 'Text';\nconst p2 = 'ary';\nconst p3 = 'Summ';\nconst p4 = 'Note';\nconst p5 = 'generate';\nexport const fn = `${p5}${p4}${p3}${p2}${p1}`;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        "const a = 'Te' + 'xt';\nconst b = 'Sum' + 'mary';\nconst c = 'No' + 'te';\nconst d = 'gen' + 'erate';\nexport const fn = d + c + b + a;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(memberVyViolations('let read = globalThis.fetch;\nread = cache.fetch;\nread(key);')).toEqual([]);
    expect(
      memberVyViolations('let read = globalThis.fetch;\nconst safe = cache.fetch;\nread = safe;\nread(key);'),
    ).toEqual([]);
    expect(
      memberVyViolations('let read = globalThis.fetch;\nif (flag) { read = cache.fetch; }\nread(key);'),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations('let read = globalThis.fetch;\nread = cache.fetch;\nread = globalThis.fetch;\nread(key);'),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations('let read = globalThis.fetch;\nconst stealth = globalThis.fetch;\nread = stealth;\nread(key);'),
    ).toContain('calls the network directly');
    const reverseChain = [
      'let v0 = cache.fetch;',
      ...Array.from({ length: 200 }, (_, i) => `let v${i + 1} = cache.fetch;`),
      'for (let k = 0; k < 2; k += 1) {',
      ...Array.from({ length: 200 }, (_, i) => `  v${200 - i} = v${199 - i};`),
      '  v0 = globalThis.fetch;',
      '}',
      'v200(key);',
    ].join('\n');
    expect(memberVyViolations(reverseChain)).toContain('calls the network directly');

    // Fifth Codex review regressions: default fetch params, read = read.bind(...), named vs barrel @ludy/agent lookup, 500-step single-var kill chain
    expect(memberVyViolations('function run(fetchFn: typeof fetch = fetch) { return fetchFn("https://x.test"); }')).toContain(
      'calls the network directly',
    );
    expect(memberVyViolations('function run(fetchFn: typeof fetch = cache.fetch) { return fetchFn(key); }')).toEqual([]);
    expect(
      memberVyViolations('function run({ fetchFn = globalThis.fetch }: { fetchFn?: typeof fetch }) { return fetchFn("https://x.test"); }'),
    ).toContain('calls the network directly');
    expect(memberVyViolations('let read = globalThis.fetch;\nread = read.bind(globalThis);\nread(key);')).toContain(
      'calls the network directly',
    );
    expect(
      workspaceAdapterLeakViolations(
        "import { AI_FEATURES } from '@ludy/agent';\nexport const label = AI_FEATURES[feature];",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        "import { default as agent } from '@ludy/agent';\nexport const fn = agent[feature];",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toContain('uses computed property access on @ludy/agent binding');
    const altBase = Array.from({ length: 500 }, () => 'read = globalThis.fetch;\nread = cache.fetch;');
    expect(memberVyViolations(['let read = cache.fetch;', ...altBase, 'read(key);'].join('\n'))).toEqual([]);
    expect(
      memberVyViolations(['let read = cache.fetch;', ...altBase, 'read = globalThis.fetch;', 'read(key);'].join('\n')),
    ).toContain('calls the network directly');

    // Sixth Codex review regressions: closure after safe kill, nested destructuring path, 500x read.bind chain
    expect(memberVyViolations('let read = globalThis.fetch;\nread = cache.fetch;\nconst go = () => read(key);\ngo();')).toEqual([]);
    expect(
      memberVyViolations(
        'let read = globalThis.fetch;\nread = cache.fetch;\nconst go = () => read(key);\nread = globalThis.fetch;\ngo();',
      ),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations('let read = globalThis.fetch;\nconst go = () => read(key);\nread = cache.fetch;\ngo();'),
    ).toContain('calls the network directly');
    expect(memberVyViolations('const { cache: { fetch: read } } = globalThis;\nread(key);')).toEqual([]);
    expect(memberVyViolations('let read;\n({ cache: { fetch: read } } = globalThis);\nread(key);')).toEqual([]);
    expect(memberVyViolations('const { fetch: read } = globalThis;\nread("https://x.test");')).toContain(
      'calls the network directly',
    );
    const bindChain = [
      'let read = globalThis.fetch;',
      ...Array.from({ length: 500 }, () => 'read = read.bind(ctx);'),
      'read(key);',
    ].join('\n');
    expect(memberVyViolations(bindChain)).toContain('calls the network directly');

    // Seventh Codex review regressions: nullish/conditional fetch fallbacks & unconditional block kills
    expect(memberVyViolations('const fn = provided ?? globalThis.fetch;\nfn("https://x.test");')).toContain(
      'calls the network directly',
    );
    expect(memberVyViolations('const fn = provided || window.fetch;\nfn("https://x.test");')).toContain(
      'calls the network directly',
    );
    expect(memberVyViolations('const fn = cond ? cache.fetch : globalThis.fetch;\nfn("https://x.test");')).toContain(
      'calls the network directly',
    );
    expect(memberVyViolations('const fn = provided ?? cache.fetch;\nfn(key);')).toEqual([]);
    expect(memberVyViolations('let read = globalThis.fetch;\n{\n  read = cache.fetch;\n}\nread(key);')).toEqual([]);
    expect(memberVyViolations('let read = globalThis.fetch;\n{\n  read = cache.fetch;\n  read = globalThis.fetch;\n}\nread(key);')).toContain(
      'calls the network directly',
    );
    expect(memberVyViolations('let read = globalThis.fetch;\n{\n  if (flag) read = cache.fetch;\n}\nread(key);')).toContain(
      'calls the network directly',
    );
    expect(
      memberVyViolations('let read = globalThis.fetch;\nfor (let i = 0; i < 2; i += 1) {\n  { if (i === 0) break; read = cache.fetch; }\n  read(key);\n}'),
    ).toContain('calls the network directly');
    expect(
      workspaceAdapterLeakViolations(
        "import { AiBudgetExhaustedError } from '@ludy/agent';\nexport const C = () => <Field a={1} require={true} />;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        "import { AiBudgetExhaustedError } from '@ludy/agent';\nexport const C = () => <Field a={1} require />;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual([]);
    expect(
      workspaceAdapterLeakViolations(
        "import { AiBudgetExhaustedError } from '@ludy/agent';\nexport const C = () => <Field a={require} />;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toContain('uses require alias or bare require reference');

    // Platform PO + Line PO blocking review regressions (B1, B2, B3a, B3b, B3c, B3d, N4)
    // B1: TS/TSX <T>...</T> / + 1 polyglots across all scanners
    expect(
      disallowedMeteredNotes('other.ts', 'import * as m from "./meter.ts"; const a = <T>Reflect.get(m, "metered")(dynKey, fn) </T> / + 1;'),
    ).toEqual(['unresolved metered key (dynKey)']);
    expect(
      disallowedMeteredNotes('other', 'import * as m from "./meter.ts"; const a = <T>Reflect.get(m, "metered")(dynKey, fn) </T> / + 1;'),
    ).toEqual(['unresolved metered key (dynKey)']);
    expect(
      disallowedMeteredNotes('other.ts', "import * as m from './meter.ts'; (cond ? Reflect.get(m, 'metered') : other)('notes.summary', fn);"),
    ).toEqual(['notes.summary']);
    expect(
      disallowedMeteredNotes('other.ts', "const m = require('./meter.ts'); const fn = Reflect.get(m, 'metered'); fn(dynKey, cb);"),
    ).toEqual(['unresolved metered key (dynKey)']);
    expect(
      indexReexportViolations(
        "export * from './note-ai-model.ts'; const a = <T>Reflect.get(globalThis, 'require')('./note-ai-' + 'model.ts') </T> / + 1;",
        DEFAULT_ADAPTER_EXPORTS,
      ),
    ).toContain('imports note-ai-model inside index.ts instead of direct re-export');
    expect(
      importsNoteAiModel("const a = <T>Reflect.get(globalThis, 'require')('./note-ai-' + 'model.ts') </T> / + 1;"),
    ).toBe(true);
    expect(memberVyNames("const a = <T>('Private' + 'Text') </T> / + 1;")).toEqual(['PrivateText']);
    expect(adapterSymbolReferences(DEFAULT_ADAPTER_EXPORTS, "const a = <T>('generateNote' + 'SummaryText') </T> / + 1;")).toEqual([
      'generateNoteSummaryText',
    ]);
    expect(memberVyViolations("const a = <T>Reflect.get(globalThis, 'require')('p' + 'g') </T> / + 1;")).toContain('imports pg');
    expect(orgFeatureViolations("const a = <T>Reflect.get(globalThis, 'require')('./member-' + 'vy/x.ts') </T> / + 1;")).toContain(
      'imports ./member-vy/x.ts',
    );

    // B2: BindingElement.initializer & local ExportSpecifier.propertyName in JSX / TS context
    const b2Require = memberVyViolations("<b/>return/{(() => { const { load = require } = {}; return load('pg'); })()}/");
    expect(b2Require).toContain('uses require alias or bare require reference');
    expect(b2Require).toContain('imports pg');
    expect(memberVyViolations('<b/>return/{(() => { const { c = createRequire } = {}; return c; })()}/')).toContain(
      'uses require alias or bare require reference',
    );
    expect(
      memberVyViolations('type A = string\n<div>return/{(() => { const { W = \\u0057ebSocket } = {}; return W; })()}/</div>'),
    ).toContain('calls the network directly');
    expect(memberVyViolations('<b/>return/{(() => { const { X = XMLHttpRequest } = {}; return X; })()}/')).toContain(
      'calls the network directly',
    );
    expect(memberVyViolations('const load = null; export { require as load };')).toContain(
      'uses require alias or bare require reference',
    );
    expect(memberVyViolations('export { WebSocket as WS };')).toContain('calls the network directly');

    // B3a: Conditional / fallback hosts across hostMemberAccesses, memberBindCandidates, reflectGetCallNodes, callSites
    const b3aBracket = memberVyViolations("(cond ? globalThis : window)['req' + 'uire']('pg');");
    expect(b3aBracket).toContain('imports pg');
    expect(b3aBracket).toContain('uses require alias or bare require reference');
    const b3aProp = memberVyViolations("(cond ? globalThis : window).require('pg');");
    expect(b3aProp).toContain('imports pg');
    expect(b3aProp).toContain('uses require alias or bare require reference');
    expect(memberVyViolations("const f = (cond ? globalThis : window)['fet' + 'ch']; f('https://x.test');")).toContain(
      'calls the network directly',
    );
    expect(memberVyViolations("(cond ?? globalThis)['fet' + 'ch']('https://x.test');")).toContain('calls the network directly');
    const b3aReflect = memberVyViolations("Reflect.get(cond ? globalThis : window, 'req' + 'uire')('pg');");
    expect(b3aReflect).toContain('imports pg');
    expect(b3aReflect).toContain('uses require alias or bare require reference');
    expect(
      disallowedMeteredNotes('other.ts', "import * as m from './meter.ts'; (cond ? m : m)['met' + 'ered']('notes.summary', fn);"),
    ).toEqual(['notes.summary']);

    // B3b: Local object-wrapper fetch reassignment cannot kill taint
    expect(
      memberVyViolations("let read = globalThis.fetch;\nconst wrap = { go: read };\nread = wrap.go;\nread('https://x.test');"),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("let read = globalThis.fetch;\nconst wrap = { fetch: globalThis.fetch };\nread = wrap.fetch;\nread('https://x.test');"),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("let read = cache.fetch;\nconst wrap = { fetch: globalThis.fetch };\nread = wrap.fetch;\nread('https://x.test');"),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("let read = globalThis.fetch;\nconst { go: fn } = { go: read };\nread = fn;\nread('https://x.test');"),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("let read = globalThis.fetch;\nconst fn = { go: read }.go;\nread = fn;\nread('https://x.test');"),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("let read = globalThis.fetch;\nconst [fn] = [read];\nread = fn;\nread('https://x.test');"),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("let read = globalThis.fetch;\nlet fn;\n[fn] = [read];\nread = fn;\nread('https://x.test');"),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("let read = globalThis.fetch;\nconst fn = { ['g' + 'o']: read }['go'];\nread = fn;\nread('https://x.test');"),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("const [fn] = [globalThis.fetch];\nfn('https://x.test');"),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("const { a: [fn] } = { a: [globalThis.fetch] };\nfn('https://x.test');"),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations("let fn;\n({ a: [fn] } = { a: [globalThis.fetch] });\nfn('https://x.test');"),
    ).toContain('calls the network directly');
    // Platform PO Round 2 B2: opaque CallExpression intermediates must not kill fetch taint while cache.fetch safe kills remain allowed
    expect(
      memberVyViolations(
        "let read = globalThis.fetch;\nconst fn = [read].pop()!;\nread = fn;\nread('https://x.test');",
      ),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations(
        "let read = globalThis.fetch;\nconst fn = (() => read)();\nread = fn;\nread('https://x.test');",
      ),
    ).toContain('calls the network directly');
    expect(
      memberVyViolations('let read = globalThis.fetch;\nconst safe = cache.fetch;\nread = safe;\nread(key);'),
    ).toEqual([]);

    // B3c: Reflect.get and computed destructuring of WebSocket / XMLHttpRequest
    expect(memberVyViolations("const W = Reflect.get(globalThis, 'Web' + 'Socket'); void W;")).toContain('calls the network directly');
    expect(memberVyViolations("const X = Reflect.get(globalThis, 'XML' + 'HttpRequest'); void X;")).toContain('calls the network directly');
    expect(memberVyViolations("const { ['Web' + 'Socket']: W } = globalThis; void W;")).toContain('calls the network directly');
    expect(memberVyViolations("const { ['XML' + 'HttpRequest']: X } = globalThis; void X;")).toContain('calls the network directly');

    // B3d & N4: import(...), \u{72}equire, uppercase \x53, quote-free JSX fromCharCode, and RangeError fallback with non-empty found
    expect(
      workspaceAdapterLeakViolations(
        "export const C = () => <div>/{Number(import('@ludy/' + 'agent'))}/</div>;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toContain('dynamic import from @ludy/agent');
    expect(
      workspaceAdapterLeakViolations(
        "export const C = () => <div>/{\\u{72}equire('@ludy/agent')}/</div>;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toContain('dynamic require from @ludy/agent');
    expect(
      workspaceAdapterLeakViolations(
        "export const C = () => <div>/{((r) => r('@ludy/agent'))(\\u{72}equire)}/</div>;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toContain('uses require alias or bare require reference');
    expect(
      workspaceAdapterLeakViolations(
        "const fn = '\\x67enerate\\x4eote\\x53ummary\\x54ext'; void fn;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        'export const C = () => <p>return/{import(String.fromCharCode(64,108,117,100,121,47,97,103,101,110,116))}/</p>;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toContain('uses computed dynamic import or require');
    // Platform PO Round 2 B1: token-based workspace AST pre-filters and await/<Type> unwrapping in normalizeValueExprSpan
    const genNoteCharCodes = '103,101,110,101,114,97,116,101,78,111,116,101,83,117,109,109,97,114,121,84,101,120,116';
    expect(
      workspaceAdapterLeakViolations(
        `export const fn = String/*c*/['from' + 'CharCode'](${genNoteCharCodes});`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/leak.ts',
      ),
    ).toContain('generateNoteSummaryText');
    expect(
      workspaceAdapterLeakViolations(
        `export const fn = (String as any)['from' + 'CharCode'](${genNoteCharCodes});`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/leak.ts',
      ),
    ).toContain('generateNoteSummaryText');
    expect(
      workspaceAdapterLeakViolations(
        `export const fn = (window)['String']['from' + 'CharCode'](${genNoteCharCodes});`,
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/leak.ts',
      ),
    ).toContain('generateNoteSummaryText');
    expect(
      workspaceAdapterLeakViolations(
        "const m = String/*c*/['from' + 'CharCode'](64,108,117,100,121,47,97,103,101,110,116); export const run = () => import // c\n  (m);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/leak.ts',
      ),
    ).toContain('uses computed dynamic import or require');
    expect(
      workspaceAdapterLeakViolations(
        "const a='gen',x1='Z',b='erate',x2='Z',c='Note',x3='Z',d='Summary',x4='Z',e='Text'; export const run = async () => (await a) + b + c + d + e;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/leak.ts',
      ),
    ).toContain('generateNoteSummaryText');
    expect(
      workspaceAdapterLeakViolations(
        "const a='gen',x1='Z',b='erate',x2='Z',c='Note',x3='Z',d='Summary',x4='Z',e='Text'; export const fn = (<string>a) + b + c + d + e;",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/leak.ts',
      ),
    ).toContain('generateNoteSummaryText');
    expect(
      workspaceAdapterLeakViolations(
        "const p0=await('@'),x0='Z',p1='lu',x1='Z',p2='dy/',x2='Z',p3='ag',x3='Z',p4='ent'; export const run = () => import // c\n  (p0+p1+p2+p3+p4);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/leak.ts',
      ),
    ).toContain('uses computed dynamic import or require');
    expect(
      workspaceAdapterLeakViolations(
        'export const C = () => <p>return/\n{import(String.fromCharCode(64,108,117,100,121,47,97,103,101,110,116))}/</p>;',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toContain('uses computed dynamic import or require');
    expect(
      workspaceAdapterLeakViolations(
        'const p = String.fromCharCode(64,108,117,100,121,47,97,103,101,110,116); import(p);',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toContain('uses computed dynamic import or require');
    expect(memberVyViolations('import(String.fromCharCode(112, 103));')).toContain('imports pg');
    expect(
      notesKeyLiterals('export const k = String.fromCodePoint(110,111,116,101,115,46,115,117,109,109,97,114,121);'),
    ).toEqual(['notes.summary']);
    expect(
      disallowedMeteredNotes('other.ts', 'export const k = String.fromCodePoint(110,111,116,101,115,46,115,117,109,109,97,114,121);'),
    ).toEqual(['notes.summary']);
    expect(
      workspaceAdapterLeakViolations(
        'export const fn = String.fromCodePoint(103,101,110,101,114,97,116,101,78,111,116,101,83,117,109,109,97,114,121,84,101,120,116);',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        'export const C = () => { const k = String.fromCodePoint(103,101,110,101,114,97,116,101,78,111,116,101,83,117,109,109,97,114,121,84,101,120,116); return <p>return/{k}/</p>; };',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        "export const fn = String['from' + 'CharCode'](103,101,110,101,114,97,116,101,78,111,116,101,83,117,109,109,97,114,121,84,101,120,116);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        'export const fn = globalThis.String.fromCodePoint(103,101,110,101,114,97,116,101,78,111,116,101,83,117,109,109,97,114,121,84,101,120,116);',
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        "export const fn = (String)['from' + 'CodePoint'](103,101,110,101,114,97,116,101,78,111,116,101,83,117,109,109,97,114,121,84,101,120,116);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(
      workspaceAdapterLeakViolations(
        "export const fn = window['String']['from' + 'CharCode'](103,101,110,101,114,97,116,101,78,111,116,101,83,117,109,109,97,114,121,84,101,120,116);",
        DEFAULT_ADAPTER_EXPORTS,
        'apps/web/src/C.tsx',
      ),
    ).toEqual(['generateNoteSummaryText']);
    expect(importsNoteAiModel("const m = import('./\\u006eote-ai-model.ts'); void m;")).toBe(true);
    const n4Mixed = `metered('notes.summary', fn);\n${'<p>'.repeat(15_000)}return/{Number(metered(dynKey, fn))}/${'</p>'.repeat(15_000)}`;
    const n4Out = disallowedMeteredNotes('other.tsx', n4Mixed);
    expect(n4Out).toContain('notes.summary');
    expect(n4Out).toContain('unresolved metered key (excessive nesting)');
  }, 30_000);
});
