// The personal-data registry against the database (issue #923, PDPL), on a real PostgreSQL 17. Every column of the
// tenant schemas whose name looks like personal data (an email, a phone, an address, a tax code, a person's name, a
// recipient) is classified in PERSONAL_DATA_COLUMNS (packages/kernel/src/personal-data.ts), so a new one cannot escape
// an erasure request unclassified, or sealed under its subject's key and listed in SEALED_COLUMNS (ADR-0017: a column named for what it holds,
// national_id_sealed, is checked like any other, never renamed to dodge the pattern); and every classified or sealed column exists, so the lists do not rot. Part of the invariant
// suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md). Set CROVE_TEST_ADMIN_URL to a
// superuser URL; the run creates and drops its own database.
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '@ludy/db/migrate';
import { PERSONAL_DATA_COLUMNS, PERSONAL_DATA_NAME_PATTERN, PERSONAL_DATA_SCHEMAS, SEALED_COLUMNS } from '@ludy/kernel';
import { createDbClient, resolveDbIdentifiers, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));

// Control-plane tables: not tenant data, never read by tenant code (control-plane-reads.test.ts keeps the list).
const CONTROL_PLANE = ['user_account', 'auth_session', 'inbound_address', 'inbound_pending', 'auth_email_send', 'stream_ticket', 'global_kill_switch'];

const SEALED_PREFIXES = ['ludy:s1:', 'crove:s1:'] as const;
const SEALED_BRANDS = new Set(['ludy', 'crove']);
const OP_CHAR_RE = /[~!@#%^&*+=<>|/?-]/;
const IDENT_START_RE = /[A-Za-z_]/;
const IDENT_CONT_RE = /[A-Za-z0-9_$]/;

type SqlToken =
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'comma' }
  | { kind: 'cast' }
  | { kind: 'dot' }
  | { kind: 'lbracket' }
  | { kind: 'rbracket' }
  | { kind: 'ident'; value: string; quoted: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'other'; value: string };

type CheckExpr =
  | { kind: 'is_null' }
  | { kind: 'sealed_check' }
  | { kind: 'or'; items: CheckExpr[] }
  | { kind: 'and'; items: CheckExpr[] }
  | { kind: 'opaque' };

function readQuotedString(input: string, startIdx: number, backslashEscapes: boolean): { value: string; nextIdx: number } | null {
  let value = '';
  for (let i = startIdx + 1; i < input.length; i++) {
    const ch = input[i]!;
    if (backslashEscapes && ch === '\\') {
      if (i + 1 >= input.length) return null;
      const esc = input[i + 1]!;
      // Fail closed on E'...' byte/codepoint escapes we do not decode (for example \x3f could mean '?').
      if (esc === 'x' || esc === 'u' || esc === 'U' || esc === 'b' || esc === 'f' || /[0-7]/.test(esc)) {
        return null;
      }
      if (esc === 'n') value += '\n';
      else if (esc === 'r') value += '\r';
      else if (esc === 't') value += '\t';
      else value += esc;
      i++;
      continue;
    }
    if (ch === "'") {
      if (input[i + 1] === "'") {
        value += "'";
        i++;
        continue;
      }
      return { value, nextIdx: i + 1 };
    }
    value += ch;
  }
  return null;
}

function readDoubleQuotedIdent(input: string, startIdx: number): { value: string; nextIdx: number } | null {
  let value = '';
  for (let i = startIdx + 1; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '"') {
      if (input[i + 1] === '"') {
        value += '"';
        i++;
        continue;
      }
      return value.length > 0 ? { value, nextIdx: i + 1 } : null;
    }
    value += ch;
  }
  return null;
}

function tokenizeSqlCheck(input: string): SqlToken[] | null {
  const tokens: SqlToken[] = [];
  for (let i = 0; i < input.length; ) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma' });
      i++;
      continue;
    }
    if (ch === '.') {
      tokens.push({ kind: 'dot' });
      i++;
      continue;
    }
    if (ch === '[') {
      tokens.push({ kind: 'lbracket' });
      i++;
      continue;
    }
    if (ch === ']') {
      tokens.push({ kind: 'rbracket' });
      i++;
      continue;
    }
    if (ch === ':' && input[i + 1] === ':') {
      tokens.push({ kind: 'cast' });
      i += 2;
      continue;
    }
    if ((ch === 'e' || ch === 'E') && input[i + 1] === "'") {
      const parsed = readQuotedString(input, i + 1, true);
      if (!parsed) return null;
      tokens.push({ kind: 'string', value: parsed.value });
      i = parsed.nextIdx;
      continue;
    }
    if (ch === "'") {
      const parsed = readQuotedString(input, i, false);
      if (!parsed) return null;
      tokens.push({ kind: 'string', value: parsed.value });
      i = parsed.nextIdx;
      continue;
    }
    if (ch === '"') {
      const parsed = readDoubleQuotedIdent(input, i);
      if (!parsed) return null;
      tokens.push({ kind: 'ident', value: parsed.value, quoted: true });
      i = parsed.nextIdx;
      continue;
    }
    if (IDENT_START_RE.test(ch)) {
      let end = i + 1;
      while (end < input.length && IDENT_CONT_RE.test(input[end]!)) end++;
      tokens.push({ kind: 'ident', value: input.slice(i, end), quoted: false });
      i = end;
      continue;
    }
    if (OP_CHAR_RE.test(ch)) {
      let end = i + 1;
      while (end < input.length && OP_CHAR_RE.test(input[end]!)) end++;
      tokens.push({ kind: 'op', value: input.slice(i, end) });
      i = end;
      continue;
    }
    tokens.push({ kind: 'other', value: ch });
    i++;
  }
  return tokens;
}

function isKeyword(token: SqlToken | undefined, keyword: string): boolean {
  return token?.kind === 'ident' && !token.quoted && token.value.toUpperCase() === keyword;
}

function isUnquotedIdent(token: SqlToken | undefined, name: string): boolean {
  return token?.kind === 'ident' && !token.quoted && token.value.toLowerCase() === name;
}

function isColumnIdent(token: SqlToken | undefined, column: string): boolean {
  if (!token || token.kind !== 'ident') return false;
  return token.quoted ? token.value === column : token.value.toLowerCase() === column;
}

function stepAreEscape(pattern: string, backslashIdx: number): number {
  if (backslashIdx + 1 >= pattern.length) return -1;
  const next = pattern[backslashIdx + 1]!;
  // Reject PG ARE control escapes (\cX / \CX), which consume two characters after `\`.
  if (next === 'c' || next === 'C') return -1;
  return backslashIdx + 1;
}

function findClosingBracket(pattern: string, openIdx: number): number {
  for (let i = openIdx + 1; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = stepAreEscape(pattern, i);
      if (next === -1) return -1;
      i = next;
      continue;
    }
    if (ch === '[' && (pattern[i + 1] === ':' || pattern[i + 1] === '.' || pattern[i + 1] === '=')) {
      const closeIdx = pattern.indexOf(`${pattern[i + 1]!}]`, i + 2);
      if (closeIdx === -1) return -1;
      i = closeIdx + 1;
      continue;
    }
    if (ch === ']') {
      const afterOpen = i === openIdx + 1 || (i === openIdx + 2 && pattern[openIdx + 1] === '^');
      if (!afterOpen) return i;
    }
  }
  return -1;
}

function findMatchingParen(pattern: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = stepAreEscape(pattern, i);
      if (next === -1) return -1;
      i = next;
      continue;
    }
    if (ch === '[') {
      const closeBracket = findClosingBracket(pattern, i);
      if (closeBracket === -1) return -1;
      i = closeBracket;
      continue;
    }
    if (ch === '(') {
      if (pattern.startsWith('(?#', i)) return -1;
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelRegexAlternation(pattern: string): string[] | null {
  const branches: string[] = [];
  let start = 0;
  let parenDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = stepAreEscape(pattern, i);
      if (next === -1) return null;
      i = next;
      continue;
    }
    if (ch === '[') {
      const closeBracket = findClosingBracket(pattern, i);
      if (closeBracket === -1) return null;
      i = closeBracket;
      continue;
    }
    if (ch === '(') {
      if (pattern.startsWith('(?#', i)) return null;
      parenDepth++;
    } else if (ch === ')') {
      if (parenDepth === 0) return null;
      parenDepth--;
    } else if (ch === '|' && parenDepth === 0) {
      branches.push(pattern.slice(start, i));
      start = i + 1;
    }
  }
  if (parenDepth !== 0) return null;
  branches.push(pattern.slice(start));
  return branches;
}

// Fail closed on unescaped PG ARE comments `(?#...)` outside `[...]` and control escapes `\cX`/`\CX` anywhere.
function hasSafeAreSyntax(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = stepAreEscape(pattern, i);
      if (next === -1) return false;
      i = next;
      continue;
    }
    if (ch === '[') {
      const closeBracket = findClosingBracket(pattern, i);
      if (closeBracket === -1) return false;
      i = closeBracket;
      continue;
    }
    if (ch === '(' && pattern.startsWith('(?#', i)) {
      return false;
    }
  }
  return true;
}

function startsWithZeroMinQuantifier(rest: string): boolean {
  return rest.startsWith('?') || rest.startsWith('*') || rest.startsWith('{0') || rest.startsWith('{,');
}

function isSingleAnchoredSealedBranch(branch: string, depth = 0): boolean {
  if (depth > 4) return false;
  let body: string;
  if (branch.startsWith('^')) {
    body = branch.slice(1);
  } else if (branch.startsWith('\\A')) {
    body = branch.slice(2);
  } else {
    return false;
  }

  for (const prefix of SEALED_PREFIXES) {
    if (body.startsWith(prefix)) {
      return !startsWithZeroMinQuantifier(body.slice(prefix.length));
    }
  }

  if (!body.startsWith('(')) return false;
  const isNonCapturing = body.startsWith('(?:');
  // Reject lookarounds, inline flags like (?i), and comments at the anchor position.
  if (body.startsWith('(?') && !isNonCapturing) return false;
  const closeIdx = findMatchingParen(body, 0);
  if (closeIdx === -1) return false;

  const afterGroup = body.slice(closeIdx + 1);
  if (startsWithZeroMinQuantifier(afterGroup)) return false;

  const inner = body.slice(isNonCapturing ? 3 : 1, closeIdx);
  const alts = splitTopLevelRegexAlternation(inner);
  if (!alts || alts.length === 0) return false;

  if (afterGroup.startsWith(':s1:')) {
    if (startsWithZeroMinQuantifier(afterGroup.slice(':s1:'.length))) return false;
    return alts.every((alt) => SEALED_BRANDS.has(alt));
  }
  return alts.every((alt) => isSingleAnchoredSealedBranch(`^${alt}`, depth + 1));
}

function isAnchoredSealedRegex(pattern: string): boolean {
  if (!hasSafeAreSyntax(pattern)) return false;
  const branches = splitTopLevelRegexAlternation(pattern);
  if (!branches || branches.length === 0) return false;
  return branches.every((branch) => isSingleAnchoredSealedBranch(branch));
}

function isAnchoredSealedLikePattern(pattern: string): boolean {
  // Neither `ludy:s1:` nor `crove:s1:` contains LIKE wildcards (`%`, `_`) or default escape (`\`).
  return SEALED_PREFIXES.some((prefix) => pattern.startsWith(prefix));
}

function readStringWithOptionalTextCast(slice: SqlToken[], strIdx: number): string | null {
  const tok = slice[strIdx];
  if (!tok || tok.kind !== 'string') return null;
  if (strIdx + 1 === slice.length) return tok.value;
  if (slice[strIdx + 1]?.kind !== 'cast') return null;
  if (strIdx + 3 === slice.length && isUnquotedIdent(slice[strIdx + 2], 'text')) {
    return tok.value;
  }
  if (
    strIdx + 5 === slice.length &&
    isUnquotedIdent(slice[strIdx + 2], 'pg_catalog') &&
    slice[strIdx + 3]?.kind === 'dot' &&
    isUnquotedIdent(slice[strIdx + 4], 'text')
  ) {
    return tok.value;
  }
  return null;
}

function classifyLeaf(slice: SqlToken[], column: string): CheckExpr {
  if (slice.length === 3 && isColumnIdent(slice[0], column) && isKeyword(slice[1], 'IS') && isKeyword(slice[2], 'NULL')) {
    return { kind: 'is_null' };
  }

  // PostgreSQL pg_get_constraintdef() decompiles LIKE into `~~`, NOT LIKE into `!~~`,
  // ILIKE into `~~*`, and LIKE ... ESCAPE into `~~ like_escape(...)`. Require positive `~~` / `LIKE`
  // with a plain literal pattern (no `like_escape`, no `ESCAPE` clause).
  if (
    isColumnIdent(slice[0], column) &&
    ((slice[1]?.kind === 'op' && slice[1].value === '~~') || isKeyword(slice[1], 'LIKE'))
  ) {
    const pattern = readStringWithOptionalTextCast(slice, 2);
    if (pattern !== null && isAnchoredSealedLikePattern(pattern)) {
      return { kind: 'sealed_check' };
    }
    return { kind: 'opaque' };
  }

  // Require case-sensitive regex match `~` (never `!~`, `~*`, or `!~*`) with a plain literal pattern
  // (never `similar_to_escape(...)`).
  if (isColumnIdent(slice[0], column) && slice[1]?.kind === 'op' && slice[1].value === '~') {
    const pattern = readStringWithOptionalTextCast(slice, 2);
    if (pattern !== null && isAnchoredSealedRegex(pattern)) {
      return { kind: 'sealed_check' };
    }
    return { kind: 'opaque' };
  }

  // Also support positive `starts_with(col, 'ludy:s1:' | 'crove:s1:')` (or `pg_catalog.starts_with(...)`).
  const fnOffset =
    isUnquotedIdent(slice[0], 'pg_catalog') && slice[1]?.kind === 'dot' ? 2 : 0;
  if (
    isUnquotedIdent(slice[fnOffset], 'starts_with') &&
    slice[fnOffset + 1]?.kind === 'lparen' &&
    slice[slice.length - 1]?.kind === 'rparen' &&
    isColumnIdent(slice[fnOffset + 2], column) &&
    slice[fnOffset + 3]?.kind === 'comma'
  ) {
    const prefix = readStringWithOptionalTextCast(slice.slice(0, -1), fnOffset + 4);
    if (prefix !== null && isAnchoredSealedLikePattern(prefix)) {
      return { kind: 'sealed_check' };
    }
  }

  return { kind: 'opaque' };
}

function parseCheckExpr(def: string, column: string): CheckExpr | null {
  const tokenized = tokenizeSqlCheck(def);
  if (!tokenized) return null;
  const tokens: readonly SqlToken[] = tokenized;
  let pos = 0;

  const peek = (): SqlToken | undefined => tokens[pos];
  const consume = (): SqlToken | undefined => tokens[pos++];

  function parseLeafTerm(): CheckExpr | null {
    const slice: SqlToken[] = [];
    let parenDepth = 0;
    let bracketDepth = 0;
    let caseDepth = 0;
    let pendingBetweenAnd = 0;

    while (pos < tokens.length) {
      const tok = tokens[pos]!;
      if (parenDepth === 0 && bracketDepth === 0 && caseDepth === 0) {
        if (tok.kind === 'rparen') break;
        if (isKeyword(tok, 'OR')) break;
        if (isKeyword(tok, 'AND')) {
          if (pendingBetweenAnd > 0) {
            pendingBetweenAnd--;
          } else {
            break;
          }
        }
        if (isKeyword(tok, 'BETWEEN')) pendingBetweenAnd++;
      }
      if (tok.kind === 'lparen') {
        parenDepth++;
      } else if (tok.kind === 'rparen') {
        if (parenDepth === 0) break;
        parenDepth--;
      } else if (tok.kind === 'lbracket') {
        bracketDepth++;
      } else if (tok.kind === 'rbracket') {
        if (bracketDepth === 0) return null;
        bracketDepth--;
      } else if (isKeyword(tok, 'CASE')) {
        caseDepth++;
      } else if (isKeyword(tok, 'END')) {
        if (caseDepth === 0) return null;
        caseDepth--;
      }
      slice.push(tok);
      pos++;
    }
    if (parenDepth !== 0 || bracketDepth !== 0 || caseDepth !== 0 || slice.length === 0) {
      return null;
    }
    return classifyLeaf(slice, column);
  }

  function parseTerm(): CheckExpr | null {
    if (peek()?.kind === 'lparen') {
      const savedPos = pos;
      consume();
      const inner = parseOr();
      if (inner && peek()?.kind === 'rparen') {
        consume();
        const after = peek();
        if (!after || after.kind === 'rparen' || isKeyword(after, 'AND') || isKeyword(after, 'OR')) {
          return inner;
        }
      }
      pos = savedPos;
    }
    return parseLeafTerm();
  }

  function parseAnd(): CheckExpr | null {
    const first = parseTerm();
    if (!first) return null;
    const items: CheckExpr[] = [first];
    while (isKeyword(peek(), 'AND')) {
      consume();
      const next = parseTerm();
      if (!next) return null;
      items.push(next);
    }
    return items.length === 1 ? first : { kind: 'and', items };
  }

  function parseOr(): CheckExpr | null {
    const first = parseAnd();
    if (!first) return null;
    const items: CheckExpr[] = [first];
    while (isKeyword(peek(), 'OR')) {
      consume();
      const next = parseAnd();
      if (!next) return null;
      items.push(next);
    }
    return items.length === 1 ? first : { kind: 'or', items };
  }

  if (!isKeyword(consume(), 'CHECK')) return null;
  if (consume()?.kind !== 'lparen') return null;
  const expr = parseOr();
  if (!expr) return null;
  if (consume()?.kind !== 'rparen') return null;
  // Trailing clauses such as `NOT VALID` or `NO INHERIT` are rejected here.
  if (pos !== tokens.length) return null;
  return expr;
}

// SQL 3-valued logic: CHECK rejects rows only when its expression evaluates to FALSE.
// - `A AND B` is FALSE whenever either A or B is FALSE (even if the other is NULL), so either branch proves the prefix.
// - `A OR B` is NOT FALSE whenever either A or B is TRUE or NULL, so every branch must either be `<col> IS NULL`
//   or independently require the sealed prefix, and at least one branch must require the sealed prefix.
function requiresSealedPrefix(expr: CheckExpr): boolean {
  switch (expr.kind) {
    case 'sealed_check':
      return true;
    case 'is_null':
    case 'opaque':
      return false;
    case 'and':
      return expr.items.some((item) => requiresSealedPrefix(item));
    case 'or':
      return (
        expr.items.some((item) => requiresSealedPrefix(item)) &&
        expr.items.every((item) => item.kind === 'is_null' || requiresSealedPrefix(item))
      );
  }
}

function isPositiveAnchoredSealedCheck(def: string, column: string): boolean {
  const parsed = parseCheckExpr(def, column);
  return parsed !== null && requiresSealedPrefix(parsed);
}

async function hasPositiveAnchoredSealedCheck(admin: pg.Client, relid: number, attnum: number, column: string): Promise<boolean> {
  const { rows } = await admin.query<{ def: string }>(
    `SELECT pg_catalog.pg_get_constraintdef(k.oid) AS def
       FROM pg_catalog.pg_constraint k
      WHERE k.contype = 'c'
        AND k.conrelid = $1
        AND k.convalidated
        AND NOT k.connoinherit
        AND $2 = ANY (k.conkey)
        AND pg_catalog.cardinality(k.conkey) = 1`,
    [relid, attnum],
  );
  return rows.some((row) => isPositiveAnchoredSealedCheck(row.def, column));
}

describe('isPositiveAnchoredSealedCheck (#4619)', () => {
  it('accepts positive anchored CHECK constraints for crove:s1: and ludy:s1:', () => {
    const validCases: Array<[string, string]> = [
      // Real PostgreSQL 17 outputs for SEALED_COLUMNS (HR regex + Finance LIKE forms)
      [
        'national_id_sealed',
        "CHECK (((national_id_sealed IS NULL) OR ((length(national_id_sealed) <= 1000) AND (national_id_sealed ~ '^(?:ludy|crove):s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$'::text))))",
      ],
      [
        'account_holder_sealed',
        "CHECK (((length(account_holder_sealed) <= 2000) AND ((account_holder_sealed ~~ 'ludy:s1:%'::text) OR (account_holder_sealed ~~ 'crove:s1:%'::text))))",
      ],
      // Single-prefix and alternative positive forms
      ['col', "CHECK ((col ~~ 'crove:s1:%'::text))"],
      ['col', "CHECK ((col ~~ 'ludy:s1:%'::text))"],
      ['col', "CHECK (((col IS NULL) OR (col ~~ 'ludy:s1:%'::text) OR (col ~~ 'crove:s1:%'::text)))"],
      ['col', "CHECK (((col ~~ 'ludy:s1:%'::text) OR (col IS NULL)))"],
      ['col', "CHECK ((col ~ '^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$'::text))"],
      ['col', "CHECK ((col ~ '^ludy:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$'::text))"],
      ['col', "CHECK ((col ~ '^(ludy|crove):s1:[A-Za-z0-9+/=_-]+$'::text))"],
      ['col', "CHECK ((col ~ '^(crove|ludy):s1:[A-Za-z0-9+/=_-]+$'::text))"],
      ['col', "CHECK ((col ~ '^(?:crove|ludy):s1:[A-Za-z0-9+/=_-]+$'::text))"],
      ['col', "CHECK (((col ~ '^ludy:s1:[A-Za-z0-9_-]+$'::text) OR (col ~ '^crove:s1:[A-Za-z0-9_-]+$'::text)))"],
      ['col', "CHECK ((col ~ '^(?:ludy:s1:[A-Za-z0-9_-]+|crove:s1:[A-Za-z0-9_-]+)$'::text))"],
      ['col', "CHECK ((col ~ '^ludy:s1:|^crove:s1:'::text))"],
      ['col', "CHECK (((col IS NOT NULL) AND (col ~~ 'ludy:s1:%'::text)))"],
      ['col', "CHECK (starts_with(col, 'ludy:s1:'::text))"],
      ['col', "CHECK (pg_catalog.starts_with(col, 'crove:s1:'::text))"],
      // Escaped literal backslash followed by 'c' (not \cX control escape)
      ['col', "CHECK ((col ~ '^ludy:s1:\\\\c.*$'::text))"],
      ['col', "CHECK ((col ~ '^ludy:s1:[\\\\c]+$'::text))"],
      // Unnormalized SQL LIKE and quoted identifiers
      ['col', "CHECK (col LIKE 'ludy:s1:%')"],
      ['CamelCol', 'CHECK (("CamelCol" ~~ \'ludy:s1:%\'::text))'],
      ['select', 'CHECK (("select" ~ \'^crove:s1:\'::text))'],
      ['a"b', 'CHECK (("a""b" ~~ \'ludy:s1:%\'::text))'],
    ];

    for (const [column, def] of validCases) {
      expect(isPositiveAnchoredSealedCheck(def, column), `${column}: ${def}`).toBe(true);
    }
  });

  it('rejects negated predicates, unanchored patterns, boolean bypasses, and wrong columns', () => {
    const invalidCases: Array<[string, string]> = [
      // Negated comparisons and pattern operators
      ['col', "CHECK ((col <> 'ludy:s1:'::text))"],
      ['col', "CHECK (col <> 'ludy:s1:')"],
      ['col', "CHECK (col != 'crove:s1:')"],
      ['col', "CHECK ((col !~ '^ludy:s1:'::text))"],
      ['col', "CHECK ((col !~* '^ludy:s1:'::text))"],
      ['col', "CHECK ((col !~~ 'ludy:s1:%'::text))"],
      ['col', "CHECK (col NOT LIKE 'ludy:s1:%')"],
      ['col', "CHECK ((col !~~* 'ludy:s1:%'::text))"],
      ['col', "CHECK ((col !~ similar_to_escape('ludy:s1:%'::text)))"],
      ['col', "CHECK (col NOT SIMILAR TO 'ludy:s1:%')"],
      ['col', "CHECK ((col IS DISTINCT FROM 'ludy:s1:'::text))"],
      ['col', "CHECK ((NOT (col ~~ 'ludy:s1:%'::text)))"],
      ['col', "CHECK (((col ~ '^ludy:s1:'::text) IS FALSE))"],
      ['col', "CHECK (((col ~ '^ludy:s1:'::text) IS NOT TRUE))"],
      ['col', "CHECK (((col ~ '^ludy:s1:'::text) = false))"],
      ['col', "CHECK (col ~ '^ludy:s1:' IS FALSE)"],

      // Unanchored, wildcard-leading, ESCAPE, case-insensitive, or optional regex tricks
      ['col', "CHECK ((col ~~ '%ludy:s1:%'::text))"],
      ['col', "CHECK (col LIKE '%ludy:s1:%')"],
      ['col', "CHECK ((col ~~ '%crove:s1:%'::text))"],
      ['col', "CHECK ((col ~~ '_ludy:s1:%'::text))"],
      ['col', "CHECK ((col ~~ like_escape('ludy:s1:%'::text, 'l'::text)))"],
      ['col', "CHECK (col LIKE 'ludy:s1:%' ESCAPE 'l')"],
      ['col', "CHECK ((col ~~* 'ludy:s1:%'::text))"],
      ['col', "CHECK ((col ~* '^ludy:s1:'::text))"],
      ['col', "CHECK ((col ~ '(?i)^ludy:s1:'::text))"],
      ['col', "CHECK ((col ~ similar_to_escape('ludy:s1:%'::text)))"],
      ['col', "CHECK ((col ~ 'ludy:s1:'::text))"],
      ['col', "CHECK ((col ~ '^.*ludy:s1:'::text))"],
      ['col', "CHECK ((col ~ '^.?ludy:s1:'::text))"],
      ['col', "CHECK ((col ~ '^ludy:s1:?'::text))"],
      ['col', "CHECK ((col ~ '^ludy:s1:*'::text))"],
      ['col', "CHECK ((col ~ '^ludy:s1:{0,1}'::text))"],
      ['col', "CHECK ((col ~ '^(ludy|crove)?:s1:'::text))"],
      ['col', "CHECK ((col ~ '^(ludy|crove|other):s1:'::text))"],
      ['col', "CHECK ((col ~ '^ludy:s1:.*|plaintext'::text))"],
      ['col', "CHECK ((col ~ '^(?:ludy:s1:.*|plaintext)$'::text))"],
      ['col', "CHECK ((col ~ '^(?:ludy|crove):s1:|^other'::text))"],
      ['col', "CHECK (col ~ E'^ludy:s1:\\x3f')"],
      // PG 17 ARE regex comments (?#...) and control escapes (\cX / \CX)
      ['col', "CHECK ((col ~ '^ludy:s1:(?#[)|(]?)'::text))"],
      ['col', "CHECK ((col ~ '^(?:ludy|crove):s1:(?#[)|(]?)'::text))"],
      ['col', "CHECK ((col ~ '^(?:ludy:s1:)(?#)?'::text))"],
      ['col', "CHECK ((col ~ '^ludy:s1:(?#)?'::text))"],
      ['col', "CHECK ((col ~ '^(ludy|crove):s1:(?#)?'::text))"],
      ['col', "CHECK ((col ~ E'^ludy:s1:\\\\c[|.*]?'::text))"],
      ['col', "CHECK ((col ~ E'^ludy:s1:\\\\c(|.*\\\\c)?'::text))"],
      ['col', "CHECK ((col ~ E'^ludy:s1:\\\\c\\\\|.*'::text))"],
      ['col', "CHECK ((col ~ E'^ludy:s1:[\\\\c\\\\]|.*]?'::text))"],
      ['col', "CHECK ((col ~ '^ludy:s1:\\C[|.*]?'::text))"],
      // Invalid or reversed starts_with forms
      ['col', "CHECK (starts_with('ludy:s1:', col))"],
      ['col', "CHECK (starts_with(col, 'ludy:s1'))"],
      ['col', "CHECK ((col ~~ 'ludy:s1'::text))"],
      ['col', "CHECK ((col ~~ 'ludy:s2:%'::text))"],

      // Boolean bypasses and SQL 3-valued logic holes
      ['col', "CHECK (((col IS NULL) OR (col ~~ 'ludy:s1:%'::text) OR true))"],
      ['col', "CHECK (((col ~~ 'ludy:s1:%'::text) OR (col IS NOT NULL)))"],
      ['col', "CHECK (((col ~~ 'ludy:s1:%'::text) OR (col <> ''::text)))"],
      ['col', "CHECK (((col ~~ 'ludy:s1:%'::text) OR NULL::boolean))"],
      ['col', 'CHECK ((col IS NULL))'],
      ['col', 'CHECK (((col IS NULL) OR (col IS NULL)))'],
      ['col', "CHECK (CASE WHEN col IS NULL THEN true WHEN false AND (col ~ '^ludy:s1:'::text) THEN false ELSE true END)"],

      // Wrong column, non-column LHS, and unvalidated / non-inherited constraints
      ['col', "CHECK ((other_col ~~ 'ludy:s1:%'::text))"],
      ['col', 'CHECK (("COL" ~~ \'ludy:s1:%\'::text))'],
      ['CamelCol', "CHECK ((CamelCol ~~ 'ludy:s1:%'::text))"],
      ['col', "CHECK (('ludy:s1:fake' ~~ 'ludy:s1:%'::text))"],
      ['col', "CHECK ((COALESCE(col, 'ludy:s1:x') ~~ 'ludy:s1:%'::text))"],
      ['col', "CHECK ((col ~~ 'ludy:s1:%'::text)) NOT VALID"],
      ['col', "CHECK ((col ~~ 'ludy:s1:%'::text)) NO INHERIT"],
    ];

    for (const [column, def] of invalidCases) {
      expect(isPositiveAnchoredSealedCheck(def, column), `${column}: ${def}`).toBe(false);
    }
  });
});

const suite = ADMIN ? describe : describe.skip;

suite('personal-data registry (#923)', () => {
  const dbName = `crove_test_pdpl_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
  });

  afterAll(async () => {
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  async function columns(where: string, params: unknown[]): Promise<string[]> {
    const admin = createDbClient({ connectionString: adminUrl }, dbIds, { canonicalizeCatalog: false });
    await admin.connect();
    try {
      const { rows } = await admin.query<{ key: string }>(
        `SELECT n.nspname || '.' || c.relname || '.' || a.attname AS key
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
           JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND ${where}
          ORDER BY 1`,
        params,
      );
      return rows.map((r) => r.key);
    } finally {
      await admin.end();
    }
  }

  it('classifies every column of the tenant schemas whose name looks like personal data', async () => {
    const found = await columns(`n.nspname = ANY($1::text[]) AND a.attname ~ $2 AND NOT (n.nspname = 'crove_kernel' AND c.relname = ANY($3::text[]))`, [
      [...PERSONAL_DATA_SCHEMAS],
      PERSONAL_DATA_NAME_PATTERN,
      CONTROL_PLANE,
    ]);
    expect(found.length).toBeGreaterThan(15);
    const unclassified = found.filter((key) => !(key in PERSONAL_DATA_COLUMNS) && !(key in SEALED_COLUMNS));
    expect(unclassified, 'classify these in packages/kernel/src/personal-data.ts (PERSONAL_DATA_COLUMNS, or SEALED_COLUMNS for a column sealed under its subject key)').toEqual([]);
  });

  // A sealed column holds sealed text, never a plain value: its type is text, and a validated single-column CHECK of its table,
  // bound to the column by its attribute number, positively requires an anchored `crove:s1:` or `ludy:s1:` prefix, so listing a
  // plain column as sealed (or writing a negated/unanchored CHECK) fails here.
  it('lists a column as sealed only when it is text and a CHECK on that column alone requires the sealed prefix', async () => {
    const sealedKeys = Object.keys(SEALED_COLUMNS);
    expect(sealedKeys.length).toBeGreaterThan(0);
    const problems: string[] = [];
    const admin = createDbClient({ connectionString: adminUrl }, dbIds, { canonicalizeCatalog: false });
    await admin.connect();
    try {
      for (const place of sealedKeys) {
        const [schema, table, column] = place.split('.') as [string, string, string];
        const { rows: foundColumns } = await admin.query<{ type: string; attnum: number; relid: number }>(
          `SELECT format_type(a.atttypid, a.atttypmod) AS type, a.attnum, c.oid AS relid
             FROM pg_catalog.pg_attribute a
             JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attname = $3 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`,
          [schema, table, column],
        );
        const found = foundColumns[0];
        if (!found) {
          problems.push(`${place} does not exist`);
          continue;
        }
        if (found.type !== 'text') problems.push(`${place} is ${found.type}, not text`);
        const ok = await hasPositiveAnchoredSealedCheck(admin, found.relid, found.attnum, column);
        if (!ok) problems.push(`${place} has no validated single-column CHECK requiring an anchored crove:s1: or ludy:s1: prefix`);
      }
    } finally {
      await admin.end();
    }
    expect(problems).toEqual([]);
  });

  it('rejects real PostgreSQL 17 negated, unanchored, unvalidated, and multi-column bypass CHECK constraints while accepting positive ones', async () => {
    const admin = createDbClient({ connectionString: adminUrl }, dbIds, { canonicalizeCatalog: false });
    await admin.connect();
    try {
      await admin.query(`
        CREATE TEMP TABLE sealed_check_probe (
          ok_like text CHECK (ok_like LIKE 'ludy:s1:%'),
          ok_or text CHECK (ok_or IS NULL OR ok_or LIKE 'ludy:s1:%' OR ok_or LIKE 'crove:s1:%'),
          ok_regex text CHECK (ok_regex IS NULL OR (pg_catalog.length(ok_regex) <= 1000 AND ok_regex ~ '^(?:ludy|crove):s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$')),
          ok_starts_with text CHECK (starts_with(ok_starts_with, 'ludy:s1:')),
          ok_backslash_c text CHECK (ok_backslash_c ~ E'^ludy:s1:\\\\\\\\c.*$'),
          bad_neq text CHECK (bad_neq <> 'ludy:s1:'),
          bad_not_regex text CHECK (bad_not_regex !~ '^ludy:s1:'),
          bad_not_like text CHECK (bad_not_like NOT LIKE 'ludy:s1:%'),
          bad_unanchored_like text CHECK (bad_unanchored_like LIKE '%ludy:s1:%'),
          bad_unanchored_regex text CHECK (bad_unanchored_regex ~ 'ludy:s1:'),
          bad_escape text CHECK (bad_escape LIKE 'ludy:s1:%' ESCAPE 'l'),
          bad_not_similar text CHECK (bad_not_similar NOT SIMILAR TO 'ludy:s1:%'),
          bad_ilike text CHECK (bad_ilike ILIKE 'ludy:s1:%'),
          bad_or_true text CHECK (bad_or_true IS NULL OR bad_or_true LIKE 'ludy:s1:%' OR true),
          bad_not_wrap text CHECK (NOT (bad_not_wrap LIKE 'ludy:s1:%')),
          bad_comment_bracket text CHECK (bad_comment_bracket ~ '^ludy:s1:(?#[)|(]?)'),
          bad_comment_alt_group text CHECK (bad_comment_alt_group ~ '^(?:ludy|crove):s1:(?#[)|(]?)'),
          bad_comment_opt_group text CHECK (bad_comment_opt_group ~ '^(?:ludy:s1:)(?#)?'),
          bad_comment_opt_colon text CHECK (bad_comment_opt_colon ~ '^ludy:s1:(?#)?'),
          bad_comment_opt_brand text CHECK (bad_comment_opt_brand ~ '^(ludy|crove):s1:(?#)?'),
          bad_ctrl_bracket text CHECK (bad_ctrl_bracket ~ E'^ludy:s1:\\\\c[|.*]?'),
          bad_ctrl_paren text CHECK (bad_ctrl_paren ~ E'^ludy:s1:\\\\c(|.*\\\\c)?'),
          bad_ctrl_pipe text CHECK (bad_ctrl_pipe ~ E'^ludy:s1:\\\\c\\\\|.*'),
          bad_ctrl_class text CHECK (bad_ctrl_class ~ E'^ludy:s1:[\\\\c\\\\]|.*]?'),
          bad_no_inherit text CHECK (bad_no_inherit LIKE 'ludy:s1:%') NO INHERIT,
          bad_not_valid text,
          bad_multi_col text,
          other_col text,
          CONSTRAINT sealed_check_probe_multi_ck CHECK (bad_multi_col LIKE 'ludy:s1:%' OR other_col = 'bypass')
        )`);
      await admin.query(`ALTER TABLE sealed_check_probe ADD CONSTRAINT sealed_check_probe_nv_ck CHECK (bad_not_valid LIKE 'ludy:s1:%') NOT VALID`);

      const { rows: cols } = await admin.query<{ attname: string; attnum: number; relid: number }>(
        `SELECT a.attname, a.attnum, c.oid AS relid
           FROM pg_catalog.pg_attribute a
           JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
          WHERE c.oid = 'sealed_check_probe'::regclass AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attnum`,
      );
      const results = new Map<string, boolean>();
      for (const col of cols) {
        results.set(col.attname, await hasPositiveAnchoredSealedCheck(admin, col.relid, col.attnum, col.attname));
      }

      expect(results.get('ok_like')).toBe(true);
      expect(results.get('ok_or')).toBe(true);
      expect(results.get('ok_regex')).toBe(true);
      expect(results.get('ok_starts_with')).toBe(true);
      expect(results.get('ok_backslash_c')).toBe(true);
      for (const bad of [
        'bad_neq',
        'bad_not_regex',
        'bad_not_like',
        'bad_unanchored_like',
        'bad_unanchored_regex',
        'bad_escape',
        'bad_not_similar',
        'bad_ilike',
        'bad_or_true',
        'bad_not_wrap',
        'bad_comment_bracket',
        'bad_comment_alt_group',
        'bad_comment_opt_group',
        'bad_comment_opt_colon',
        'bad_comment_opt_brand',
        'bad_ctrl_bracket',
        'bad_ctrl_paren',
        'bad_ctrl_pipe',
        'bad_ctrl_class',
        'bad_no_inherit',
        'bad_not_valid',
        'bad_multi_col',
      ]) {
        expect(results.get(bad), bad).toBe(false);
      }
    } finally {
      await admin.end();
    }
  });

  it('lists only columns that exist', async () => {
    const keys = [...Object.keys(PERSONAL_DATA_COLUMNS), ...Object.keys(SEALED_COLUMNS)];
    const existing = new Set(await columns(`n.nspname || '.' || c.relname || '.' || a.attname = ANY($1::text[])`, [keys]));
    expect(keys.filter((key) => !existing.has(key))).toEqual([]);
  });
});
