// SPDX-License-Identifier: AGPL-3.0-only
// A receipt photographed on the phone (#2384): when a photo is shrunk, the encodes tried and in which order, that it stays
// readable (never below the smallest side) and is never enlarged, and what is uploaded when nothing fits or the browser
// cannot read the photo.
import { describe, expect, it } from 'vitest';
import { PHOTO_BUDGET_BYTES, PHOTO_MIN_SIDE, PHOTO_SIDES, needsShrink, photoName, photoSteps, preparePhoto, scaledSize, type PhotoCodec, type PhotoStep } from '../src/lib/photo.ts';

const file = (name: string, type: string, size: number) => new File([new Uint8Array(size)], name, { type });

describe('needsShrink', () => {
  it('shrinks only an image the upload takes that is larger than the direct upload limit', () => {
    expect(needsShrink({ type: 'image/jpeg', size: PHOTO_BUDGET_BYTES + 1 })).toBe(true);
    expect(needsShrink({ type: 'image/png', size: PHOTO_BUDGET_BYTES + 1 })).toBe(true);
    expect(needsShrink({ type: 'image/webp', size: PHOTO_BUDGET_BYTES + 1 })).toBe(true);
    expect(needsShrink({ type: 'image/jpeg', size: PHOTO_BUDGET_BYTES })).toBe(false);
    expect(needsShrink({ type: 'application/pdf', size: PHOTO_BUDGET_BYTES * 3 })).toBe(false);
    expect(needsShrink({ type: 'application/xml', size: PHOTO_BUDGET_BYTES * 3 })).toBe(false);
    expect(needsShrink({ type: 'image/gif', size: PHOTO_BUDGET_BYTES * 3 })).toBe(false);
  });
});

describe('photoSteps', () => {
  it('goes from the longest side down, two qualities at each, and stops at the readable side', () => {
    const steps = photoSteps(4000, 3000);
    expect(steps.map((s) => s.side)).toEqual([3200, 3200, 2400, 2400, 1800, 1800, 1600, 1600]);
    expect(steps.map((s) => s.quality)).toEqual([0.85, 0.7, 0.85, 0.7, 0.85, 0.7, 0.85, 0.7]);
    expect(Math.min(...steps.map((s) => s.side))).toBe(PHOTO_MIN_SIDE);
    expect(PHOTO_SIDES.at(-1)).toBe(PHOTO_MIN_SIDE);
  });

  it('never enlarges: a photo shorter than a step is tried at its own size', () => {
    expect(photoSteps(2000, 1500).map((s) => s.side)).toEqual([2000, 2000, 1800, 1800, 1600, 1600]);
    expect(photoSteps(1200, 900).map((s) => s.side)).toEqual([1200, 1200]);
    expect(photoSteps(0, 0)).toEqual([]);
  });
});

describe('scaledSize', () => {
  it('keeps the proportions of a portrait or landscape photo and never scales up', () => {
    expect(scaledSize(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
    expect(scaledSize(3000, 4000, 2000)).toEqual({ width: 1500, height: 2000 });
    expect(scaledSize(1000, 800, 3200)).toEqual({ width: 1000, height: 800 });
    expect(scaledSize(10000, 1, 1600)).toEqual({ width: 1600, height: 1 });
  });
});

describe('photoName', () => {
  it('writes a .jpg under the original name', () => {
    expect(photoName('IMG_2041.HEIC')).toBe('IMG_2041.jpg');
    expect(photoName('hoa-don.png')).toBe('hoa-don.jpg');
    expect(photoName('.png')).toBe('hoa-don.jpg');
  });
});

// A codec that "encodes" to a size set by the step, so the loop is shown without a canvas.
function codec(sizeOf: (step: PhotoStep) => number | null, photo = { width: 4000, height: 3000 } as { width: number; height: number } | null): PhotoCodec & { tried: PhotoStep[] } {
  const tried: PhotoStep[] = [];
  return {
    tried,
    size: async () => photo,
    encode: async (_file, step) => {
      tried.push(step);
      const bytes = sizeOf(step);
      return bytes === null ? null : new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
    },
  };
}

describe('preparePhoto', () => {
  const big = () => file('IMG_1.jpg', 'image/jpeg', 9 * 1024 * 1024);

  it('leaves a photo that fits, and a file that is not a photo, as they are', async () => {
    const small = file('IMG_2.jpg', 'image/jpeg', 1024 * 1024);
    const pdf = file('hd.pdf', 'application/pdf', 9 * 1024 * 1024);
    const spy = codec(() => 1);
    expect(await preparePhoto(small, spy)).toBe(small);
    expect(await preparePhoto(pdf, spy)).toBe(pdf);
    expect(spy.tried).toEqual([]);
  });

  it('takes the first encode that fits the budget, the largest and best quality that does', async () => {
    const spy = codec((step) => (step.side >= 3200 ? 6 * 1024 * 1024 : step.side === 2400 && step.quality === 0.85 ? 4.5 * 1024 * 1024 : 3 * 1024 * 1024));
    const out = await preparePhoto(big(), spy);
    expect(spy.tried.map((s) => `${s.side}@${s.quality}`)).toEqual(['3200@0.85', '3200@0.7', '2400@0.85', '2400@0.7']);
    expect(out.name).toBe('IMG_1.jpg');
    expect(out.type).toBe('image/jpeg');
    expect(out.size).toBe(3 * 1024 * 1024);
  });

  it('names a shrunk PNG as a JPEG', async () => {
    const out = await preparePhoto(file('chup.png', 'image/png', 9 * 1024 * 1024), codec(() => 1024));
    expect(out.name).toBe('chup.jpg');
    expect(out.type).toBe('image/jpeg');
  });

  it('sends the smallest encode when none fits, as long as it is smaller than the photo', async () => {
    const out = await preparePhoto(big(), codec((step) => (step.side === 1600 && step.quality === 0.7 ? 5 * 1024 * 1024 : 8 * 1024 * 1024)));
    expect(out.size).toBe(5 * 1024 * 1024);
  });

  it('sends the original when the browser cannot read or encode it, or the encodes are no smaller', async () => {
    const original = big();
    expect(await preparePhoto(original, codec(() => 1, null))).toBe(original);
    expect(await preparePhoto(original, codec(() => null))).toBe(original);
    expect(await preparePhoto(original, codec(() => 10 * 1024 * 1024))).toBe(original);
    const throwing: PhotoCodec = { size: async () => Promise.reject(new Error('no decoder')), encode: async () => null };
    expect(await preparePhoto(original, throwing)).toBe(original);
  });
});
