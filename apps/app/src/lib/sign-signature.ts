// SPDX-License-Identifier: AGPL-3.0-only
// Client-side PNG signature generation for Draw (smoothed strokes) and Type (Be Vietnam Pro) tabs (#3325).

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
