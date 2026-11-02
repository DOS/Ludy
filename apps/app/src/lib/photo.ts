// SPDX-License-Identifier: AGPL-3.0-only
// A receipt photographed with the phone's camera (#2384): the Inbox's "Chụp hóa đơn" hands the photo to the normal
// upload path, after shrinking it on the device when it is larger than the direct upload limit, so a stack of receipts
// does not wait on a slow mobile connection. The photo stays readable: the long side is never made shorter than
// PHOTO_MIN_SIDE and the short side never shorter than PHOTO_MIN_SHORT, which keeps the small print of a receipt legible
// for the reading (Ly reads it; the checks decide). This module holds the decisions (when to shrink, which encodes to try,
// in which order) and the loop that tries them; the drawing runs in the browser (browserCodec) and is passed in, so the
// rest is unit tested.
import { DIRECT_UPLOAD_MAX_BYTES } from '@crove/kernel-contract';

// The photo stays under this size: files up to it go through the kernel in one request even when the store takes
// presigned uploads, which is the quick path on a phone.
export const PHOTO_BUDGET_BYTES = DIRECT_UPLOAD_MAX_BYTES;
// The long sides to try, longest first, and never beyond the photo's own; the smallest keeps a receipt's print legible.
export const PHOTO_SIDES = [3200, 2400, 1800, 1600] as const;
export const PHOTO_MIN_SIDE = 1600;
// A step that would leave the short side below this is not tried: a long narrow image (a stitched screenshot) made small
// is unreadable, so it goes up as it is, the upload limit being 25 MB.
export const PHOTO_MIN_SHORT = 900;
// At each side the first encode, then a lower quality, before the next smaller side.
export const PHOTO_QUALITIES = [0.85, 0.7] as const;
// The type a shrunk photo is written as: JPEG, which the reading takes and a receipt photo compresses well in.
export const PHOTO_TYPE = 'image/jpeg';

const SHRINKABLE = ['image/jpeg', 'image/png', 'image/webp'];

export interface PhotoStep {
  side: number;
  quality: number;
}

// Whether a chosen file is a photo to shrink: an image the upload takes, larger than the budget. A PDF, an XML or a
// small photo goes as it is.
export function needsShrink(file: { type: string; size: number }): boolean {
  return SHRINKABLE.includes(file.type.toLowerCase()) && file.size > PHOTO_BUDGET_BYTES;
}

// The encodes to try for a photo of this size, in order: each side from the longest the photo allows (its own long side,
// when that is within the first step) down to PHOTO_MIN_SIDE, each at both qualities. A photo already shorter than the
// smallest side is tried at its own size, so it is never enlarged; a step that would make the short side smaller than
// PHOTO_MIN_SHORT is left out.
export function photoSteps(width: number, height: number): PhotoStep[] {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  if (!(long > 0) || !(short > 0)) return [];
  const sides = [...new Set(PHOTO_SIDES.map((side) => Math.min(side, long)))].filter((side) => side === long || (short * side) / long >= PHOTO_MIN_SHORT);
  return sides.flatMap((side) => PHOTO_QUALITIES.map((quality) => ({ side, quality })));
}

// The drawn size for a long side: the photo's proportions, at least one pixel each way, never larger than the photo.
export function scaledSize(width: number, height: number, side: number): { width: number; height: number } {
  const long = Math.max(width, height);
  const scale = Math.min(1, side / long);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// The shrunk photo's name: the original's, as a .jpg.
export function photoName(original: string): string {
  const base = original.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'hoa-don';
  return `${base}.jpg`;
}

// A photo decoded once: its pixel size, one encode per step, and the release of what it holds (a decoded 12 to 48 MP
// photo is tens of megabytes, and the encodes of the steps all draw from it).
export interface PhotoImage {
  width: number;
  height: number;
  encode: (step: PhotoStep) => Promise<Blob | null>;
  close: () => void;
}

export interface PhotoCodec {
  // The decoded photo, or null when the browser cannot read it (the file then goes as it is).
  open: (file: File) => Promise<PhotoImage | null>;
}

// The file to upload: the photo itself when it fits, is not a photo, or cannot be read here; else the first encode that
// fits the budget; else the smallest encode made, when it is smaller than the original (the upload's own limit then
// decides), else the original. Never rejects.
export async function preparePhoto(file: File, codec: PhotoCodec): Promise<File> {
  if (!needsShrink(file)) return file;
  const image = await codec.open(file).catch(() => null);
  if (!image) return file;
  try {
    let smallest: Blob | null = null;
    for (const step of photoSteps(image.width, image.height)) {
      const blob = await image.encode(step).catch(() => null);
      if (!blob) continue;
      if (smallest === null || blob.size < smallest.size) smallest = blob;
      if (blob.size <= PHOTO_BUDGET_BYTES) return new File([blob], photoName(file.name), { type: PHOTO_TYPE, lastModified: file.lastModified });
    }
    return smallest !== null && smallest.size < file.size ? new File([smallest], photoName(file.name), { type: PHOTO_TYPE, lastModified: file.lastModified }) : file;
  } finally {
    image.close();
  }
}

// The photos, one after another: a phone holds one decoded photo at a time, not all of a multi-selection.
export async function preparePhotos(files: readonly File[], codec: PhotoCodec): Promise<File[]> {
  const out: File[] = [];
  for (const file of files) out.push(await preparePhoto(file, codec));
  return out;
}

// The decode with the camera's orientation applied; a browser that does not take the option decodes as it does by default.
async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(file);
  }
}

// The browser's codec: the photo decoded once, each step drawn on one canvas at the step's size and written as a JPEG.
// Drawn on white first, so a PNG's transparency does not become black. The canvas is emptied when the photo is closed, so
// its memory goes back at once (a phone's browser caps the total of its canvases).
export const browserCodec: PhotoCodec = {
  open: async (file) => {
    const bitmap = await decode(file);
    const canvas = document.createElement('canvas');
    return {
      width: bitmap.width,
      height: bitmap.height,
      encode: async (step) => {
        const { width, height } = scaledSize(bitmap.width, bitmap.height, step.side);
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) return null;
        context.fillStyle = 'white';
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);
        return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, PHOTO_TYPE, step.quality));
      },
      close: () => {
        canvas.width = 0;
        canvas.height = 0;
        bitmap.close();
      },
    };
  },
};
