// SPDX-License-Identifier: AGPL-3.0-only
// A receipt photographed on the phone (#2384): when a photo is shrunk, the encodes tried and in which order, that it stays
// readable (never below the smallest side, never a sliver) and is never enlarged, what is uploaded when nothing fits or the
// browser cannot read the photo, and that a multi-selection is decoded one photo at a time.
import { describe, expect, it } from 'vitest';
import { PHOTO_BUDGET_BYTES, PHOTO_MIN_SHORT, PHOTO_MIN_SIDE, PHOTO_SIDES, needsShrink, photoName, photoSteps, preparePhoto, preparePhotos, scaledSize, type PhotoCodec, type PhotoStep } from '../src/lib/photo.ts';

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

  it('leaves out a step that would make a long narrow image unreadable', () => {
    // A stitched screenshot: 1080 x 9000 would be 192 wide at 1600 high, so no step is tried and it goes up as it is.
    expect(photoSteps(1080, 9000)).toEqual([]);
    // 1500 x 3600 would be 667 wide at 1600 high: only the steps that leave the short side readable remain.
    for (const [width, height] of [[1500, 3600], [2000, 5000], [3000, 4000]] as const) {
      for (const step of photoSteps(width, height)) {
        const { width: w, height: h } = scaledSize(width, height, step.side);
        expect(Math.min(w, h), `${width}x${height} at ${step.side}`).toBeGreaterThanOrEqual(Math.min(PHOTO_MIN_SHORT, Math.min(width, height)));
      }
    }
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

// A codec whose photo "encodes" to a size set by the step, so the loop is shown without a canvas.
function codec(
  sizeOf: (step: PhotoStep) => number | null,
  photo: { width: number; height: number } | null = { width: 4000, height: 3000 },
): PhotoCodec & { tried: PhotoStep[]; opened: number; closed: number; open_: number; peak: number } {
  const state = { tried: [] as PhotoStep[], opened: 0, closed: 0, open_: 0, peak: 0 };
  return Object.assign(state, {
    open: async () => {
      if (!photo) return null;
      state.opened++;
      state.open_++;
      state.peak = Math.max(state.peak, state.open_);
      return {
        ...photo,
        encode: async (step: PhotoStep) => {
          state.tried.push(step);
          const bytes = sizeOf(step);
          return bytes === null ? null : new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
        },
        close: () => {
          state.closed++;
          state.open_--;
        },
      };
    },
  });
}

describe('preparePhoto', () => {
  const big = () => file('IMG_1.jpg', 'image/jpeg', 9 * 1024 * 1024);

  it('leaves a photo that fits, and a file that is not a photo, as they are, decoding nothing', async () => {
    const small = file('IMG_2.jpg', 'image/jpeg', 1024 * 1024);
    const pdf = file('hd.pdf', 'application/pdf', 9 * 1024 * 1024);
    const spy = codec(() => 1);
    expect(await preparePhoto(small, spy)).toBe(small);
    expect(await preparePhoto(pdf, spy)).toBe(pdf);
    expect(spy.tried).toEqual([]);
    expect(spy.opened).toBe(0);
  });

  it('takes the first encode that fits the budget, decoding the photo once and releasing it', async () => {
    const spy = codec((step) => (step.side >= 3200 ? 6 * 1024 * 1024 : step.side === 2400 && step.quality === 0.85 ? 4.5 * 1024 * 1024 : 3 * 1024 * 1024));
    const out = await preparePhoto(big(), spy);
    expect(spy.tried.map((s) => `${s.side}@${s.quality}`)).toEqual(['3200@0.85', '3200@0.7', '2400@0.85', '2400@0.7']);
    expect(out.name).toBe('IMG_1.jpg');
    expect(out.type).toBe('image/jpeg');
    expect(out.size).toBe(3 * 1024 * 1024);
    expect(spy.opened).toBe(1);
    expect(spy.closed).toBe(1);
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

  it('sends the original when the browser cannot read or encode it, or the encodes are no smaller, and still releases the photo', async () => {
    const original = big();
    expect(await preparePhoto(original, codec(() => 1, null))).toBe(original);
    const none = codec(() => null);
    expect(await preparePhoto(original, none)).toBe(original);
    expect(none.closed).toBe(1);
    expect(await preparePhoto(original, codec(() => 10 * 1024 * 1024))).toBe(original);
    const throwing: PhotoCodec = { open: async () => Promise.reject(new Error('no decoder')) };
    expect(await preparePhoto(original, throwing)).toBe(original);
  });

  it('sends a long narrow image as it is: no readable step exists', async () => {
    const original = file('ghep.png', 'image/png', 9 * 1024 * 1024);
    const spy = codec(() => 1024, { width: 1080, height: 9000 });
    expect(await preparePhoto(original, spy)).toBe(original);
    expect(spy.tried).toEqual([]);
    expect(spy.closed).toBe(1);
  });
});

describe('preparePhotos', () => {
  it('keeps the order and decodes one photo at a time', async () => {
    const spy = codec(() => 1024);
    const files = [file('a.jpg', 'image/jpeg', 9 * 1024 * 1024), file('b.pdf', 'application/pdf', 9 * 1024 * 1024), file('c.jpg', 'image/jpeg', 9 * 1024 * 1024)];
    const out = await preparePhotos(files, spy);
    expect(out.map((f) => f.name)).toEqual(['a.jpg', 'b.pdf', 'c.jpg']);
    expect(out[1]).toBe(files[1]);
    expect(spy.opened).toBe(2);
    expect(spy.peak).toBe(1);
  });
});
