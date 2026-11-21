// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic PDF contract version diff engine for Ludy eSign Slice 4f (#3822).
// Works 100% with AI off: normalizes extracted PDF page text into clause/paragraph segments, aligns revisions via
// bounded LCS, and coalesces adjacent removals/additions into 'modified' hunks with exact v1 and v2 page numbers.
import type { SignDiffHunk, SignVersionDiffResult } from '@ludy/kernel-contract';

export interface SignDiffPageText {
  page: number;
  text: string;
}

interface ClauseUnit {
  page: number;
  text: string;
  norm: string;
  tokens: ReadonlySet<string>;
}

const FORMAT_CONTROL_RE = /\p{Cf}+/gu;
const MAX_DIFF_UNITS = 400;

function sanitizeClauseText(raw: string): string {
  return raw
    .replace(FORMAT_CONTROL_RE, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[ \t\r]+/g, ' ')
    .trim();
}

function normalizeClauseKey(text: string): string {
  return sanitizeClauseText(text)
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeClause(norm: string): Set<string> {
  const out = new Set<string>();
  for (const m of norm.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (m[0]) out.add(m[0]);
  }
  return out;
}

function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function splitPageIntoClauses(rawText: string): string[] {
  const cleaned = rawText
    .replace(FORMAT_CONTROL_RE, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!cleaned) return [];

  // Break explicit newlines AND inline article/clause/sentence boundaries produced by PDF text item extraction.
  const preSplit = cleaned
    .replace(/\s+(?=(?:ĐIỀU|Điều|KHOẢN|Khoản|MỤC|Mục|ARTICLE|Article|SECTION|Section|CLAUSE|Clause)\s+\d+\b)/gu, '\n')
    .replace(/\s+(?=\d+(?:\.\d+)+[.)]?\s+[\p{Lu}])/gu, '\n')
    .replace(/(?<=[.;!?])\s+(?=[\p{Lu}0-9])/gu, '\n');

  const segments: string[] = [];
  for (const rawLine of preSplit.split(/\n+/)) {
    const trimmed = sanitizeClauseText(rawLine);
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
  }
  return segments;
}

function extractBoundedUnits(pages: readonly SignDiffPageText[]): ClauseUnit[] {
  const ordered = [...pages]
    .filter((p) => Number.isInteger(p.page) && p.page >= 1)
    .sort((a, b) => a.page - b.page);

  const rawUnits: Array<{ page: number; text: string }> = [];
  for (const p of ordered) {
    for (const seg of splitPageIntoClauses(p.text)) {
      rawUnits.push({ page: p.page, text: seg });
    }
  }
  if (rawUnits.length <= MAX_DIFF_UNITS) {
    return rawUnits.map((u) => {
      const norm = normalizeClauseKey(u.text);
      return { page: u.page, text: u.text, norm, tokens: tokenizeClause(norm) };
    });
  }

  // Coalesce consecutive clauses on the same page when a document exceeds MAX_DIFF_UNITS so LCS stays fast and bounded.
  const groupSize = Math.ceil(rawUnits.length / MAX_DIFF_UNITS);
  const grouped: ClauseUnit[] = [];
  let i = 0;
  while (i < rawUnits.length) {
    const start = rawUnits[i]!;
    const texts = [start.text];
    let j = i + 1;
    while (j < rawUnits.length && j - i < groupSize && rawUnits[j]!.page === start.page) {
      texts.push(rawUnits[j]!.text);
      j += 1;
    }
    const mergedText = texts.join(' ');
    const norm = normalizeClauseKey(mergedText);
    grouped.push({ page: start.page, text: mergedText, norm, tokens: tokenizeClause(norm) });
    i = j;
  }
  return grouped;
}

type RawOp =
  | { kind: 'unchanged'; a: ClauseUnit; b: ClauseUnit }
  | { kind: 'removed'; a: ClauseUnit }
  | { kind: 'added'; b: ClauseUnit };

function alignUnitsLcs(unitsA: readonly ClauseUnit[], unitsB: readonly ClauseUnit[]): RawOp[] {
  const n = unitsA.length;
  const m = unitsB.length;
  const cols = m + 1;
  const dp = new Int32Array((n + 1) * cols);

  for (let i = n - 1; i >= 0; i -= 1) {
    const normA = unitsA[i]!.norm;
    for (let j = m - 1; j >= 0; j -= 1) {
      const idx = i * cols + j;
      if (normA === unitsB[j]!.norm) {
        dp[idx] = dp[(i + 1) * cols + (j + 1)]! + 1;
      } else {
        const down = dp[(i + 1) * cols + j]!;
        const right = dp[i * cols + (j + 1)]!;
        dp[idx] = down >= right ? down : right;
      }
    }
  }

  const ops: RawOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (unitsA[i]!.norm === unitsB[j]!.norm) {
      ops.push({ kind: 'unchanged', a: unitsA[i]!, b: unitsB[j]! });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + (j + 1)]!) {
      ops.push({ kind: 'removed', a: unitsA[i]! });
      i += 1;
    } else {
      ops.push({ kind: 'added', b: unitsB[j]! });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: 'removed', a: unitsA[i]! });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: 'added', b: unitsB[j]! });
    j += 1;
  }
  return ops;
}

export function computeSignVersionDiff(
  pagesV1: readonly SignDiffPageText[],
  pagesV2: readonly SignDiffPageText[],
): SignVersionDiffResult {
  const maxPageV1 = pagesV1.reduce((acc, p) => (Number.isInteger(p.page) && p.page > acc ? p.page : acc), 0);
  const maxPageV2 = pagesV2.reduce((acc, p) => (Number.isInteger(p.page) && p.page > acc ? p.page : acc), 0);
  const unitsA = extractBoundedUnits(pagesV1);
  const unitsB = extractBoundedUnits(pagesV2);
  const rawOps = alignUnitsLcs(unitsA, unitsB);

  const hunks: SignDiffHunk[] = [];
  let pos = 0;
  while (pos < rawOps.length) {
    const cur = rawOps[pos]!;
    if (cur.kind === 'unchanged') {
      hunks.push({
        index: hunks.length,
        kind: 'unchanged',
        pageV1: cur.a.page,
        pageV2: cur.b.page,
        beforeText: cur.a.text,
        afterText: cur.b.text,
      });
      pos += 1;
      continue;
    }

    const removedRun: ClauseUnit[] = [];
    const addedRun: ClauseUnit[] = [];
    while (pos < rawOps.length && rawOps[pos]!.kind !== 'unchanged') {
      const step = rawOps[pos]!;
      if (step.kind === 'removed') removedRun.push(step.a);
      else if (step.kind === 'added') addedRun.push(step.b);
      pos += 1;
    }

    let rIdx = 0;
    let aIdx = 0;
    while (rIdx < removedRun.length && aIdx < addedRun.length) {
      const rem = removedRun[rIdx]!;
      const add = addedRun[aIdx]!;
      const sim = jaccardSimilarity(rem.tokens, add.tokens);
      const isOneToOneBlock = removedRun.length === 1 && addedRun.length === 1;
      if (sim >= 0.22 || isOneToOneBlock) {
        hunks.push({
          index: hunks.length,
          kind: 'modified',
          pageV1: rem.page,
          pageV2: add.page,
          beforeText: rem.text,
          afterText: add.text,
        });
        rIdx += 1;
        aIdx += 1;
      } else {
        hunks.push({
          index: hunks.length,
          kind: 'removed',
          pageV1: rem.page,
          pageV2: null,
          beforeText: rem.text,
          afterText: null,
        });
        rIdx += 1;
      }
    }
    while (rIdx < removedRun.length) {
      const rem = removedRun[rIdx]!;
      hunks.push({
        index: hunks.length,
        kind: 'removed',
        pageV1: rem.page,
        pageV2: null,
        beforeText: rem.text,
        afterText: null,
      });
      rIdx += 1;
    }
    while (aIdx < addedRun.length) {
      const add = addedRun[aIdx]!;
      hunks.push({
        index: hunks.length,
        kind: 'added',
        pageV1: null,
        pageV2: add.page,
        beforeText: null,
        afterText: add.text,
      });
      aIdx += 1;
    }
  }

  let addedCount = 0;
  let removedCount = 0;
  let modifiedCount = 0;
  let unchangedCount = 0;
  for (const h of hunks) {
    if (h.kind === 'added') addedCount += 1;
    else if (h.kind === 'removed') removedCount += 1;
    else if (h.kind === 'modified') modifiedCount += 1;
    else unchangedCount += 1;
  }

  return {
    pageCountV1: maxPageV1,
    pageCountV2: maxPageV2,
    stats: {
      totalHunks: hunks.length,
      addedCount,
      removedCount,
      modifiedCount,
      unchangedCount,
      identical: addedCount === 0 && removedCount === 0 && modifiedCount === 0,
    },
    hunks,
  };
}
