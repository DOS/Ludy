// SPDX-License-Identifier: AGPL-3.0-only
import {
  EXTRACT_LIMITS,
  type PdfDetectedTag,
  type PdfDetectedTagFieldType,
} from '@crove/extract-contract';
import type { PageRotation } from './fonts.ts';

const NORM_MICRO_SCALE = 1_000_000;
const MIN_FIELD_W_MICRO = 20_000; // 0.020000
const MIN_FIELD_H_MICRO = 15_000; // 0.015000
const MAX_TAG_INNER_CHARS = 160;
const MAX_LINE_SCAN_CHARS = 8_192;
const MAX_PAGE_TAG_SCAN_CHARS = 250_000;

export interface PdfTagVisualBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PdfRawTextItem {
  readonly str: string;
  readonly width?: number;
  readonly height?: number;
  readonly transform?: readonly number[];
  readonly fontName?: string;
  readonly hasEOL?: boolean;
}

export interface PdfFontStyleHint {
  readonly fontFamily?: string | undefined;
}

export interface ParsedTagSpec {
  readonly fieldType: PdfDetectedTagFieldType;
  readonly roleOrder: number;
  readonly roleKey: string;
  readonly required: boolean;
  readonly label: string | null;
}

interface Vec2 {
  readonly x: number;
  readonly y: number;
}

interface LineCharRun {
  readonly charStart: number;
  readonly charEnd: number;
  readonly cumWeights: Float64Array;
  readonly origin: Vec2;
  readonly inlineUnit: Vec2;
  readonly upUnit: Vec2;
  readonly advance: number;
  readonly fontHeight: number;
}

type FontMetricKind = 'sans' | 'serif' | 'mono';

// Standard Helvetica (sans) and Times-Roman (serif) AFM character widths (in 1/1000 em) for ASCII 0x20..0x7E.
const SANS_ASCII_WIDTHS: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const SERIF_ASCII_WIDTHS: readonly number[] = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];

function classifyFontMetricKind(fontFamily: string | undefined): FontMetricKind {
  if (!fontFamily) return 'sans';
  const lower = fontFamily.toLowerCase();
  if (lower.includes('mono') || lower.includes('courier')) return 'mono';
  if (lower.includes('serif') && !lower.includes('sans')) return 'serif';
  return 'sans';
}

function isZeroWidthOrCombiningMark(cp: number): boolean {
  return (
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff ||
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

function glyphAdvanceWeight(cp: number, kind: FontMetricKind): number {
  if (isZeroWidthOrCombiningMark(cp)) return 0;
  if (kind === 'mono') return 600;
  const table = kind === 'serif' ? SERIF_ASCII_WIDTHS : SANS_ASCII_WIDTHS;
  if (cp >= 0x20 && cp <= 0x7e) {
    return table[cp - 0x20] ?? 556;
  }
  if (cp === 0x00a0) {
    return table[0] ?? 278;
  }
  if (cp === 0x0110) return table[0x44 - 0x20] ?? 722; // Đ -> D
  if (cp === 0x0111) return table[0x64 - 0x20] ?? 556; // đ -> d
  if ((cp >= 0x00c0 && cp <= 0x024f) || (cp >= 0x1e00 && cp <= 0x1eff)) {
    const baseCp = String.fromCodePoint(cp).normalize('NFD').codePointAt(0);
    if (baseCp !== undefined && baseCp >= 0x20 && baseCp <= 0x7e) {
      return table[baseCp - 0x20] ?? 556;
    }
  }
  if (
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xff01 && cp <= 0xff60)
  ) {
    return 1000;
  }
  return kind === 'serif' ? 500 : 556;
}

function buildRunCumWeights(str: string, kind: FontMetricKind): Float64Array {
  const cum = new Float64Array(str.length + 1);
  let acc = 0;
  for (let i = 0; i < str.length; ) {
    const cp = str.codePointAt(i) ?? 0x20;
    const step = cp > 0xffff ? 2 : 1;
    const w = glyphAdvanceWeight(cp, kind);
    if (step === 2) {
      cum[i + 1] = acc + w * 0.5;
      acc += w;
      cum[i + 2] = acc;
    } else {
      acc += w;
      cum[i + 1] = acc;
    }
    i += step;
  }
  return cum;
}

function normalizeTagType(raw: string): PdfDetectedTagFieldType | null {
  switch (raw.trim().toLowerCase()) {
    case 'signature':
    case 'sig':
      return 'signature';
    case 'initial':
    case 'initials':
      return 'initials';
    case 'date':
      return 'date';
    case 'text':
      return 'text';
    case 'checkbox':
    case 'check':
      return 'checkbox';
    default:
      return null;
  }
}

function sanitizeTagLabel(raw: string): string | null {
  let cleaned = '';
  for (const ch of raw.normalize('NFC')) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return null;
    cleaned += ch;
  }
  const collapsed = cleaned.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0 || collapsed.length > EXTRACT_LIMITS.maxPdfDetectedTagLabelChars) {
    return null;
  }
  return collapsed;
}

export function parseDeterministicTagToken(rawInner: string): ParsedTagSpec | null {
  if (rawInner.length === 0 || rawInner.length > MAX_TAG_INNER_CHARS) return null;
  if (/[\r\n{}]/.test(rawInner)) return null;

  const commaIdx = rawInner.indexOf(',');
  if (commaIdx <= 0) return null;

  const fieldType = normalizeTagType(rawInner.slice(0, commaIdx));
  if (!fieldType) return null;

  const rest = rawInner.slice(commaIdx + 1).trim();
  const roleMatch = /^[rR]([1-9]|[1-4]\d|50)(?:\s*([:,][\s\S]*))?$/.exec(rest);
  if (!roleMatch || !roleMatch[1]) return null;

  const roleOrder = Number.parseInt(roleMatch[1], 10);
  if (!Number.isInteger(roleOrder) || roleOrder < 1 || roleOrder > EXTRACT_LIMITS.maxPdfDetectedTagRoles) {
    return null;
  }
  const roleKey = `r${roleOrder}`;

  const rawTail = roleMatch[2];
  if (!rawTail) {
    return { fieldType, roleOrder, roleKey, required: true, label: null };
  }

  const sep = rawTail[0];
  if (sep !== ':' && sep !== ',') return null;
  const segments = rawTail.slice(1).split(sep);
  if (segments.length === 0 || segments.length > 2) return null;

  let seenRequiredFlag: boolean | null = null;
  let label: string | null = null;

  for (const rawSeg of segments) {
    const trimmed = rawSeg.trim();
    if (trimmed.length === 0) return null;
    const lower = trimmed.toLowerCase();
    if (lower === 'optional') {
      if (seenRequiredFlag !== null && seenRequiredFlag !== false) return null;
      seenRequiredFlag = false;
    } else if (lower === 'required') {
      if (seenRequiredFlag !== null && seenRequiredFlag !== true) return null;
      seenRequiredFlag = true;
    } else {
      if (label !== null) return null;
      const cleanLabel = sanitizeTagLabel(trimmed);
      if (cleanLabel === null) return null;
      label = cleanLabel;
    }
  }

  return {
    fieldType,
    roleOrder,
    roleKey,
    required: seenRequiredFlag ?? true,
    label,
  };
}

export function pdfPointToVisual(box: PdfTagVisualBox, rot: PageRotation, px: number, py: number): Vec2 {
  switch (rot) {
    case 0:
      return { x: px - box.x, y: box.y + box.height - py };
    case 90:
      return { x: py - box.y, y: px - box.x };
    case 180:
      return { x: box.x + box.width - px, y: py - box.y };
    case 270:
      return { x: box.y + box.height - py, y: box.x + box.width - px };
  }
}

function clampMicroInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function computeTargetTagBox(
  fieldType: PdfDetectedTagFieldType,
  tagXNorm: number,
  tagYNorm: number,
  tagWNorm: number,
  tagHNorm: number,
  pageWidthPt: number,
  pageHeightPt: number,
): { readonly xNorm: number; readonly yNorm: number; readonly wNorm: number; readonly hNorm: number } {
  const safePageW = Math.max(1, pageWidthPt);
  const safePageH = Math.max(1, pageHeightPt);
  let rawW: number;
  let rawH: number;

  switch (fieldType) {
    case 'signature': {
      rawW = Math.max(tagWNorm, Math.min(0.45, Math.max(0.18, 128 / safePageW)));
      rawH = Math.max(tagHNorm, Math.min(0.18, Math.max(0.045, 36 / safePageH)));
      break;
    }
    case 'initials': {
      rawW = Math.max(tagWNorm, Math.min(0.3, Math.max(0.1, 68 / safePageW)));
      rawH = Math.max(tagHNorm, Math.min(0.14, Math.max(0.036, 28 / safePageH)));
      break;
    }
    case 'date': {
      rawW = Math.max(tagWNorm, Math.min(0.35, Math.max(0.14, 92 / safePageW)));
      rawH = Math.max(tagHNorm, Math.min(0.1, Math.max(0.025, 20 / safePageH)));
      break;
    }
    case 'text': {
      rawW = Math.max(tagWNorm, Math.min(0.45, Math.max(0.18, 120 / safePageW)));
      rawH = Math.max(tagHNorm, Math.min(0.1, Math.max(0.025, 20 / safePageH)));
      break;
    }
    case 'checkbox': {
      rawW = Math.min(0.12, Math.max(0.024, 16 / safePageW));
      rawH = Math.min(0.12, Math.max(0.022, 16 / safePageH));
      break;
    }
  }

  const wMicro = clampMicroInt(rawW * NORM_MICRO_SCALE, MIN_FIELD_W_MICRO, NORM_MICRO_SCALE);
  const hMicro = clampMicroInt(rawH * NORM_MICRO_SCALE, MIN_FIELD_H_MICRO, NORM_MICRO_SCALE);
  const maxXMicro = Math.min(NORM_MICRO_SCALE - 1, Math.max(0, NORM_MICRO_SCALE - wMicro));
  const maxYMicro = Math.min(NORM_MICRO_SCALE - 1, Math.max(0, NORM_MICRO_SCALE - hMicro));

  const rawX = tagXNorm;
  const rawY = tagYNorm + tagHNorm * 0.5 - (hMicro / NORM_MICRO_SCALE) * 0.5;
  const xMicro = clampMicroInt(rawX * NORM_MICRO_SCALE, 0, maxXMicro);
  const yMicro = clampMicroInt(rawY * NORM_MICRO_SCALE, 0, maxYMicro);

  return {
    xNorm: xMicro / NORM_MICRO_SCALE,
    yNorm: yMicro / NORM_MICRO_SCALE,
    wNorm: wMicro / NORM_MICRO_SCALE,
    hNorm: hMicro / NORM_MICRO_SCALE,
  };
}

function itemGeometry(item: PdfRawTextItem): {
  readonly origin: Vec2;
  readonly inlineUnit: Vec2;
  readonly upUnit: Vec2;
  readonly advance: number;
  readonly fontHeight: number;
} {
  const tf = item.transform;
  const a = Number.isFinite(tf?.[0]) ? (tf![0] as number) : 12;
  const b = Number.isFinite(tf?.[1]) ? (tf![1] as number) : 0;
  const c = Number.isFinite(tf?.[2]) ? (tf![2] as number) : 0;
  const d = Number.isFinite(tf?.[3]) ? (tf![3] as number) : 12;
  const tx = Number.isFinite(tf?.[4]) ? (tf![4] as number) : 0;
  const ty = Number.isFinite(tf?.[5]) ? (tf![5] as number) : 0;

  const inlineMag = Math.hypot(a, b);
  const inlineUnit: Vec2 =
    inlineMag > 1e-6 ? { x: a / inlineMag, y: b / inlineMag } : { x: 1, y: 0 };
  const upMag = Math.hypot(c, d);
  const upUnit: Vec2 =
    upMag > 1e-6 ? { x: c / upMag, y: d / upMag } : { x: -inlineUnit.y, y: inlineUnit.x };

  const fallbackFontH = upMag > 1e-6 ? upMag : inlineMag > 1e-6 ? inlineMag : 12;
  const fontHeight =
    typeof item.height === 'number' && Number.isFinite(item.height) && item.height > 0
      ? item.height
      : fallbackFontH;
  const advance =
    typeof item.width === 'number' && Number.isFinite(item.width) && item.width >= 0
      ? item.width
      : item.str.length * fontHeight * 0.5;

  return {
    origin: { x: tx, y: ty },
    inlineUnit,
    upUnit,
    advance,
    fontHeight,
  };
}

function scanLineBufferForTags(
  lineText: string,
  runs: readonly LineCharRun[],
  pageNumber: number,
  box: PdfTagVisualBox,
  rotation: PageRotation,
  userUnit: number,
  maxCount: number,
  out: PdfDetectedTag[],
): void {
  if (out.length >= maxCount || !lineText.includes('{{')) return;

  const visW = rotation === 90 || rotation === 270 ? box.height : box.width;
  const visH = rotation === 90 || rotation === 270 ? box.width : box.height;
  if (!(visW > 0) || !(visH > 0)) return;

  const pageWidthPt = visW * userUnit;
  const pageHeightPt = visH * userUnit;

  let pos = 0;
  while (pos < lineText.length && out.length < maxCount) {
    let openIdx = lineText.indexOf('{{', pos);
    if (openIdx === -1) break;
    const closeIdx = lineText.indexOf('}}', openIdx + 2);
    if (closeIdx === -1) break;

    const innerOpen = lineText.lastIndexOf('{{', closeIdx - 1);
    if (innerOpen > openIdx) {
      openIdx = innerOpen;
    }

    const matchStart = openIdx;
    const matchEnd = closeIdx + 2;
    const inner = lineText.slice(openIdx + 2, closeIdx);
    pos = matchEnd;

    const spec = parseDeterministicTagToken(inner);
    if (!spec) continue;

    let minVx = Number.POSITIVE_INFINITY;
    let maxVx = Number.NEGATIVE_INFINITY;
    let minVy = Number.POSITIVE_INFINITY;
    let maxVy = Number.NEGATIVE_INFINITY;

    for (const run of runs) {
      if (run.charEnd <= matchStart || run.charStart >= matchEnd) continue;
      const runLen = Math.max(1, run.charEnd - run.charStart);
      const localStart = Math.max(0, matchStart - run.charStart);
      const localEnd = Math.min(runLen, matchEnd - run.charStart);
      const totalWeight = run.cumWeights[runLen] ?? 0;
      const frac0 = totalWeight > 0 ? (run.cumWeights[localStart] ?? 0) / totalWeight : localStart / runLen;
      const frac1 = totalWeight > 0 ? (run.cumWeights[localEnd] ?? 0) / totalWeight : localEnd / runLen;
      const adv0 = frac0 * run.advance;
      const adv1 = frac1 * run.advance;

      const descent = 0.2 * run.fontHeight;
      const ascent = 0.85 * run.fontHeight;
      const corners: readonly Vec2[] = [
        {
          x: run.origin.x + adv0 * run.inlineUnit.x - descent * run.upUnit.x,
          y: run.origin.y + adv0 * run.inlineUnit.y - descent * run.upUnit.y,
        },
        {
          x: run.origin.x + adv1 * run.inlineUnit.x - descent * run.upUnit.x,
          y: run.origin.y + adv1 * run.inlineUnit.y - descent * run.upUnit.y,
        },
        {
          x: run.origin.x + adv0 * run.inlineUnit.x + ascent * run.upUnit.x,
          y: run.origin.y + adv0 * run.inlineUnit.y + ascent * run.upUnit.y,
        },
        {
          x: run.origin.x + adv1 * run.inlineUnit.x + ascent * run.upUnit.x,
          y: run.origin.y + adv1 * run.inlineUnit.y + ascent * run.upUnit.y,
        },
      ];
      for (const corner of corners) {
        const vp = pdfPointToVisual(box, rotation, corner.x, corner.y);
        if (vp.x < minVx) minVx = vp.x;
        if (vp.x > maxVx) maxVx = vp.x;
        if (vp.y < minVy) minVy = vp.y;
        if (vp.y > maxVy) maxVy = vp.y;
      }
    }

    if (!Number.isFinite(minVx) || !Number.isFinite(minVy)) continue;

    const tagXNorm = Math.min(1, Math.max(0, minVx / visW));
    const tagYNorm = Math.min(1, Math.max(0, minVy / visH));
    const tagWNorm = Math.min(1, Math.max(0, (maxVx - minVx) / visW));
    const tagHNorm = Math.min(1, Math.max(0, (maxVy - minVy) / visH));

    const coords = computeTargetTagBox(
      spec.fieldType,
      tagXNorm,
      tagYNorm,
      tagWNorm,
      tagHNorm,
      pageWidthPt,
      pageHeightPt,
    );

    out.push({
      pageNumber,
      fieldType: spec.fieldType,
      roleOrder: spec.roleOrder,
      roleKey: spec.roleKey,
      required: spec.required,
      label: spec.label,
      ...coords,
    });
  }
}

export function extractPageDeterministicTags(input: {
  readonly pageNumber: number;
  readonly box: PdfTagVisualBox;
  readonly rotation: PageRotation;
  readonly userUnit: number;
  readonly items: readonly PdfRawTextItem[];
  readonly styles?: Readonly<Record<string, PdfFontStyleHint>> | undefined;
  readonly maxTags?: number | undefined;
}): PdfDetectedTag[] {
  const maxTags = Math.min(
    EXTRACT_LIMITS.maxPdfDetectedTags,
    Math.max(0, input.maxTags ?? EXTRACT_LIMITS.maxPdfDetectedTags),
  );
  if (maxTags === 0 || input.items.length === 0) return [];

  const out: PdfDetectedTag[] = [];
  let lineText = '';
  let lineRuns: LineCharRun[] = [];
  let prevHasEOL = false;
  let scannedPageChars = 0;
  const singleSpaceCumWeights = Float64Array.of(0, 1);

  const flushLine = (): void => {
    if (lineText.length > 0 && lineRuns.length > 0) {
      scanLineBufferForTags(
        lineText,
        lineRuns,
        input.pageNumber,
        input.box,
        input.rotation,
        input.userUnit,
        maxTags,
        out,
      );
    }
    lineText = '';
    lineRuns = [];
    prevHasEOL = false;
  };

  for (const rawItem of input.items) {
    if (out.length >= maxTags || scannedPageChars >= MAX_PAGE_TAG_SCAN_CHARS) break;
    if (typeof rawItem.str !== 'string' || rawItem.str.length === 0) {
      if (rawItem.hasEOL) flushLine();
      continue;
    }

    const fontKind = classifyFontMetricKind(
      rawItem.fontName ? input.styles?.[rawItem.fontName]?.fontFamily : undefined,
    );
    const remainingPageBudget = MAX_PAGE_TAG_SCAN_CHARS - scannedPageChars;
    let str = rawItem.str;
    let effectiveItem: PdfRawTextItem = rawItem;
    if (rawItem.str.length > remainingPageBudget) {
      str = rawItem.str.slice(0, remainingPageBudget);
      if (typeof rawItem.width === 'number' && Number.isFinite(rawItem.width) && rawItem.width >= 0) {
        const fullWeights = buildRunCumWeights(rawItem.str, fontKind);
        const fullTotal = fullWeights[rawItem.str.length] ?? 0;
        const sliceRatio =
          fullTotal > 0
            ? (fullWeights[str.length] ?? 0) / fullTotal
            : str.length / rawItem.str.length;
        effectiveItem = { ...rawItem, str, width: rawItem.width * sliceRatio };
      } else {
        effectiveItem = { ...rawItem, str };
      }
    }
    scannedPageChars += str.length;

    const geom = itemGeometry(effectiveItem);
    const prevRun = lineRuns[lineRuns.length - 1];

    let sameLine = false;
    let inlineGap = 0;
    if (prevRun && !prevHasEOL && lineText.length + str.length + 1 <= MAX_LINE_SCAN_CHARS) {
      const dirDot =
        prevRun.inlineUnit.x * geom.inlineUnit.x + prevRun.inlineUnit.y * geom.inlineUnit.y;
      if (dirDot > 0.98) {
        const dx = geom.origin.x - prevRun.origin.x;
        const dy = geom.origin.y - prevRun.origin.y;
        const perpDist = Math.abs(dx * prevRun.upUnit.x + dy * prevRun.upUnit.y);
        const maxFontH = Math.max(prevRun.fontHeight, geom.fontHeight);
        const prevEndX = prevRun.origin.x + prevRun.advance * prevRun.inlineUnit.x;
        const prevEndY = prevRun.origin.y + prevRun.advance * prevRun.inlineUnit.y;
        inlineGap =
          (geom.origin.x - prevEndX) * prevRun.inlineUnit.x +
          (geom.origin.y - prevEndY) * prevRun.inlineUnit.y;
        if (perpDist <= maxFontH * 0.35 && inlineGap >= -maxFontH * 0.5 && inlineGap <= maxFontH * 3.0) {
          sameLine = true;
        }
      }
    }

    if (!sameLine) {
      flushLine();
    } else if (prevRun) {
      const maxFontH = Math.max(prevRun.fontHeight, geom.fontHeight);
      const prevChar = lineText[lineText.length - 1] ?? '';
      const nextChar = str[0] ?? '';
      if (inlineGap > maxFontH * 0.22 && !/\s/.test(prevChar) && !/\s/.test(nextChar)) {
        const spaceStart = lineText.length;
        lineText += ' ';
        lineRuns.push({
          charStart: spaceStart,
          charEnd: spaceStart + 1,
          cumWeights: singleSpaceCumWeights,
          origin: {
            x: prevRun.origin.x + prevRun.advance * prevRun.inlineUnit.x,
            y: prevRun.origin.y + prevRun.advance * prevRun.inlineUnit.y,
          },
          inlineUnit: prevRun.inlineUnit,
          upUnit: prevRun.upUnit,
          advance: Math.max(0, inlineGap),
          fontHeight: maxFontH,
        });
      }
    }

    const startOffset = lineText.length;
    lineText += str;
    lineRuns.push({
      charStart: startOffset,
      charEnd: startOffset + str.length,
      cumWeights: buildRunCumWeights(str, fontKind),
      origin: geom.origin,
      inlineUnit: geom.inlineUnit,
      upUnit: geom.upUnit,
      advance: geom.advance,
      fontHeight: geom.fontHeight,
    });
    prevHasEOL = Boolean(rawItem.hasEOL);
    if (prevHasEOL) {
      flushLine();
    }
  }

  flushLine();
  return out;
}
