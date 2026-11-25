// SPDX-License-Identifier: AGPL-3.0-only
// Client-side PNG signature generation for Draw (smoothed strokes) and Type (Be Vietnam Pro) tabs (#3325).
import { SIGN_SIGNATURE_PNG_MAX_HEIGHT, SIGN_SIGNATURE_PNG_MAX_WIDTH } from '@ludy/kernel-contract';

export interface SignaturePoint {
  readonly x: number;
  readonly y: number;
}

export type SignatureStroke = readonly SignaturePoint[];

export const SIGNATURE_CANVAS_WIDTH = 480;
export const SIGNATURE_CANVAS_HEIGHT = 180;
export const SIGNATURE_MAX_BYTES = 256 * 1024;
export const SIGNATURE_PNG_DATA_URL_PATTERN = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return 0;
  const b64 = dataUrl.slice(comma + 1);
  let padding = 0;
  if (b64.endsWith('==')) padding = 2;
  else if (b64.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export function isValidSignaturePngDataUrl(value: string): boolean {
  if (!SIGNATURE_PNG_DATA_URL_PATTERN.test(value)) return false;
  const bytes = estimateDataUrlBytes(value);
  return bytes > 0 && bytes <= SIGNATURE_MAX_BYTES;
}

export function hasSubstantiveSignatureStrokes(strokes: readonly SignatureStroke[]): boolean {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let pointCount = 0;
  for (const stroke of strokes) {
    for (const pt of stroke) {
      pointCount += 1;
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
  }
  if (pointCount < 2) return false;
  return Math.hypot(maxX - minX, maxY - minY) >= 4;
}

// Smooths freehand pointer points with quadratic midpoint segments onto a canvas.
export function renderStrokesToCanvas(
  canvas: HTMLCanvasElement,
  strokes: readonly SignatureStroke[],
  options: { width?: number; height?: number; dpr?: number; lineWidth?: number } = {},
): void {
  const width = options.width ?? SIGNATURE_CANVAS_WIDTH;
  const height = options.height ?? SIGNATURE_CANVAS_HEIGHT;
  const dpr = options.dpr ?? 1;
  const targetWidth = Math.max(1, Math.round(width * dpr));
  const targetHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  // Signature stamps onto white PDF sheets, so ink must always remain dark regardless of UI theme.
  ctx.strokeStyle = 'black';
  ctx.fillStyle = 'black';
  ctx.lineWidth = options.lineWidth ?? 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of strokes) {
    if (stroke.length === 0) continue;
    if (stroke.length === 1) {
      const pt = stroke[0]!;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(stroke[0]!.x, stroke[0]!.y);
    for (let i = 1; i < stroke.length - 1; i += 1) {
      const current = stroke[i]!;
      const next = stroke[i + 1]!;
      const midX = (current.x + next.x) / 2;
      const midY = (current.y + next.y) / 2;
      ctx.quadraticCurveTo(current.x, current.y, midX, midY);
    }
    const last = stroke[stroke.length - 1]!;
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
  ctx.restore();
}

export function strokesToPngDataUrl(
  strokes: readonly SignatureStroke[],
  options: { width?: number; height?: number } = {},
): string | null {
  if (!hasSubstantiveSignatureStrokes(strokes) || typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  renderStrokesToCanvas(canvas, strokes, {
    width: options.width ?? SIGNATURE_CANVAS_WIDTH,
    height: options.height ?? SIGNATURE_CANVAS_HEIGHT,
    dpr: 1,
    lineWidth: 2.8,
  });
  const url = canvas.toDataURL('image/png');
  return isValidSignaturePngDataUrl(url) ? url : null;
}

export function typedTextToPngDataUrl(
  text: string,
  options: { width?: number; height?: number; fontFamily?: string } = {},
): string | null {
  const clean = text.trim();
  if (!clean || typeof document === 'undefined') return null;
  const width = options.width ?? SIGNATURE_CANVAS_WIDTH;
  const height = options.height ?? SIGNATURE_CANVAS_HEIGHT;
  const fontFamily = options.fontFamily ?? '"Be Vietnam Pro", system-ui, sans-serif';

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'black';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  let fontSize = 54;
  const maxWidth = width - 40;
  while (fontSize > 18) {
    ctx.font = `italic 600 ${fontSize}px ${fontFamily}`;
    if (ctx.measureText(clean).width <= maxWidth) break;
    fontSize -= 2;
  }

  ctx.fillText(clean, width / 2, height / 2, maxWidth);
  const url = canvas.toDataURL('image/png');
  return isValidSignaturePngDataUrl(url) ? url : null;
}

export function rawBase64ToPngDataUrl(rawOrDataUrl: string): string {
  const trimmed = rawOrDataUrl.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:image/png;base64,')) return trimmed;
  return `data:image/png;base64,${trimmed}`;
}

export function stripPngDataUrlPrefix(rawOrDataUrl: string): string {
  const trimmed = rawOrDataUrl.trim();
  return trimmed.startsWith('data:image/png;base64,')
    ? trimmed.slice('data:image/png;base64,'.length)
    : trimmed;
}

export const STAMP_CANVAS_WIDTH = 360;
export const STAMP_CANVAS_HEIGHT = 220;

// Generates a crisp transparent-background red corporate or title stamp PNG on canvas (#3817, <= 256 KB, zero SVG/XSS).
export function stampTextToPngDataUrl(
  primaryText: string,
  options: {
    subtitle?: string;
    stampKind?: 'company' | 'title' | 'custom';
    width?: number;
    height?: number;
    fontFamily?: string;
  } = {},
): string | null {
  const title = primaryText.trim();
  if (!title || typeof document === 'undefined') return null;
  const subtitle = (options.subtitle ?? '').trim();
  const stampKind = options.stampKind ?? 'company';
  const width = options.width ?? STAMP_CANVAS_WIDTH;
  const height = options.height ?? STAMP_CANVAS_HEIGHT;
  const fontFamily = options.fontFamily ?? '"Be Vietnam Pro", system-ui, sans-serif';

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, width, height);
  // Corporate and title stamps render in vermilion/crimson seal ink onto white PDF sheets.
  ctx.strokeStyle = 'crimson';
  ctx.fillStyle = 'crimson';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (stampKind === 'company') {
    const cx = width / 2;
    const cy = height / 2;
    const outerRx = Math.min(width / 2 - 12, 152);
    const outerRy = Math.min(height / 2 - 12, 92);

    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(cx, cy, outerRx, outerRy, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(cx, cy, outerRx - 7, outerRy - 7, 0, 0, Math.PI * 2);
    ctx.stroke();

    const maxInnerW = (outerRx - 20) * 2;
    let titleSize = 22;
    while (titleSize > 12) {
      ctx.font = `700 ${titleSize}px ${fontFamily}`;
      if (ctx.measureText(title.toUpperCase()).width <= maxInnerW) break;
      titleSize -= 1;
    }
    ctx.fillText(title.toUpperCase(), cx, subtitle ? cy - 12 : cy, maxInnerW);

    if (subtitle) {
      ctx.font = `600 13px ${fontFamily}`;
      ctx.fillText(subtitle.toUpperCase(), cx, cy + 16, maxInnerW);
    }
  } else {
    const padX = 16;
    const padY = 34;
    const boxW = width - padX * 2;
    const boxH = height - padY * 2;

    ctx.lineWidth = 3.5;
    ctx.strokeRect(padX, padY, boxW, boxH);
    ctx.lineWidth = 1.4;
    ctx.strokeRect(padX + 6, padY + 6, boxW - 12, boxH - 12);

    const maxInnerW = boxW - 28;
    let titleSize = 24;
    while (titleSize > 13) {
      ctx.font = `700 ${titleSize}px ${fontFamily}`;
      if (ctx.measureText(title.toUpperCase()).width <= maxInnerW) break;
      titleSize -= 1;
    }
    ctx.fillText(title.toUpperCase(), width / 2, subtitle ? height / 2 - 12 : height / 2, maxInnerW);

    if (subtitle) {
      ctx.font = `600 14px ${fontFamily}`;
      ctx.fillText(subtitle, width / 2, height / 2 + 18, maxInnerW);
    }
  }

  const url = canvas.toDataURL('image/png');
  return isValidSignaturePngDataUrl(url) ? url : null;
}

export function parsePngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.byteLength < 45 ||
    bytes.byteLength > SIGNATURE_MAX_BYTES ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  ) {
    return null;
  }
  const ihdrLen =
    (((bytes[8] ?? 0) << 24) | ((bytes[9] ?? 0) << 16) | ((bytes[10] ?? 0) << 8) | (bytes[11] ?? 0)) >>> 0;
  if (
    ihdrLen !== 13 ||
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const width =
    (((bytes[16] ?? 0) << 24) | ((bytes[17] ?? 0) << 16) | ((bytes[18] ?? 0) << 8) | (bytes[19] ?? 0)) >>> 0;
  const height =
    (((bytes[20] ?? 0) << 24) | ((bytes[21] ?? 0) << 16) | ((bytes[22] ?? 0) << 8) | (bytes[23] ?? 0)) >>> 0;
  if (
    width < 1 ||
    height < 1 ||
    width > SIGN_SIGNATURE_PNG_MAX_WIDTH ||
    height > SIGN_SIGNATURE_PNG_MAX_HEIGHT
  ) {
    return null;
  }
  return { width, height };
}

export async function readPngFileAsDataUrl(file: File): Promise<string> {
  if (file.type !== 'image/png') {
    throw new Error('SIGN_INVALID_SIGNATURE_PNG');
  }
  if (file.size <= 0 || file.size > SIGNATURE_MAX_BYTES) {
    throw new Error('SIGN_INVALID_SIGNATURE_PNG');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!parsePngDimensions(bytes)) {
    throw new Error('SIGN_INVALID_SIGNATURE_PNG');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const dataUrl = `data:image/png;base64,${btoa(binary)}`;
  if (!isValidSignaturePngDataUrl(dataUrl)) {
    throw new Error('SIGN_INVALID_SIGNATURE_PNG');
  }
  return dataUrl;
}
