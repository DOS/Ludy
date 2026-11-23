// SPDX-License-Identifier: AGPL-3.0-only
// Tests for client-side PNG signature generation and strict PNG/size/XSS validation (#3325).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SIGNATURE_MAX_BYTES,
  estimateDataUrlBytes,
  hasSubstantiveSignatureStrokes,
  isValidSignaturePngDataUrl,
  strokesToPngDataUrl,
  typedTextToPngDataUrl,
} from '../src/lib/sign-signature.ts';

const TINY_VALID_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('signature stroke and PNG validation', () => {
  it('requires real drawing motion before accepting freehand strokes', () => {
    expect(hasSubstantiveSignatureStrokes([])).toBe(false);
    expect(hasSubstantiveSignatureStrokes([[{ x: 10, y: 10 }]])).toBe(false);
    expect(
      hasSubstantiveSignatureStrokes([
        [
          { x: 10, y: 10 },
          { x: 11, y: 11 },
        ],
      ]),
    ).toBe(false);
    expect(
      hasSubstantiveSignatureStrokes([
        [
          { x: 10, y: 10 },
          { x: 50, y: 30 },
        ],
      ]),
    ).toBe(true);
  });

  it('accepts valid data:image/png;base64 payloads within 256 KB and rejects SVG/oversized data URLs', () => {
    const valid = `data:image/png;base64,${TINY_VALID_PNG_B64}`;
    expect(isValidSignaturePngDataUrl(valid)).toBe(true);
    expect(estimateDataUrlBytes(valid)).toBeGreaterThan(0);

    expect(isValidSignaturePngDataUrl('data:image/svg+xml;base64,PHN2Zy8+')).toBe(false);
    expect(isValidSignaturePngDataUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isValidSignaturePngDataUrl('data:image/png;base64,not*valid*b64')).toBe(false);

    const overBytes = SIGNATURE_MAX_BYTES + 12;
    const hugeB64 = Buffer.alloc(overBytes, 0x41).toString('base64');
    expect(isValidSignaturePngDataUrl(`data:image/png;base64,${hugeB64}`)).toBe(false);
  });

  it('renders drawn strokes and typed Be Vietnam Pro text cleanly via 2D canvas into PNG data URLs', () => {
    const fillText = vi.fn();
    const quadraticCurveTo = vi.fn();
    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo,
      stroke: vi.fn(),
      measureText: vi.fn((text: string) => ({ width: text.length * 14 })),
      fillText,
      strokeStyle: '',
      fillStyle: '',
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      textBaseline: 'alphabetic',
      textAlign: 'start',
      font: '',
    };

    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toDataURL: (mime: string) => {
        expect(mime).toBe('image/png');
        return `data:image/png;base64,${TINY_VALID_PNG_B64}`;
      },
    };

    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        expect(tag).toBe('canvas');
        return fakeCanvas;
      },
    });

    const drawnUrl = strokesToPngDataUrl([
      [
        { x: 10, y: 20 },
        { x: 40, y: 60 },
        { x: 90, y: 40 },
      ],
    ]);
    expect(drawnUrl).toBe(`data:image/png;base64,${TINY_VALID_PNG_B64}`);
    expect(quadraticCurveTo).toHaveBeenCalledTimes(1);

    const typedUrl = typedTextToPngDataUrl('Nguyễn Văn An');
    expect(typedUrl).toBe(`data:image/png;base64,${TINY_VALID_PNG_B64}`);
    expect(ctx.font).toContain('Be Vietnam Pro');
    expect(fillText).toHaveBeenCalledWith('Nguyễn Văn An', 240, 90, 440);
    expect(typedTextToPngDataUrl('   ')).toBeNull();
  });
});
