// SPDX-License-Identifier: AGPL-3.0-only
// A receipt photographed with the phone's camera (#2384): the Inbox's "Chụp hóa đơn" hands the photo to the normal
// upload path, after shrinking it on the device when it is larger than the direct upload limit, so a stack of receipts
// does not wait on a slow mobile connection. The photo stays readable: the long side is never made shorter than
// PHOTO_MIN_SIDE, which keeps the small print of a receipt legible for the reading (Vy reads it; the checks decide).
// This module holds the decisions (when to shrink, which encodes to try, in which order) and the loop that tries them;
// the drawing runs in the browser (shrinkPhotoInBrowser) and is passed in, so the rest is unit tested.
import { DIRECT_UPLOAD_MAX_BYTES } from '@crove/kernel-contract';

// The photo stays under this size: files up to it go through the kernel in one request even when the store takes
// presigned uploads, which is the quick path on a phone.
export const PHOTO_BUDGET_BYTES = DIRECT_UPLOAD_MAX_BYTES;
// The long sides to try, longest first, and never beyond the photo's own; the smallest keeps a receipt's print legible.
export const PHOTO_SIDES = [3200, 2400, 1800, 1600] as const;
export const PHOTO_MIN_SIDE = 1600;
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
// smallest side is tried at its own size, so it is never enlarged.
export function photoSteps(width: number, height: number): PhotoStep[] {
  const long = Math.max(width, height);
  if (!(long > 0)) return [];
  const sides = [...new Set(PHOTO_SIDES.map((side) => Math.min(side, long)))];
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

export interface PhotoCodec {
  // The photo's pixel size, or null when the browser cannot read it (the file then goes as it is).
  size: (file: File) => Promise<{ width: number; height: number } | null>;
  // One encode of the photo at a step, or null when the browser could not make it.
  encode: (file: File, step: PhotoStep) => Promise<Blob | null>;
}

// The file to upload: the photo itself when it fits, is not a photo, or cannot be read here; else the first encode that
// fits the budget; else the smallest encode made, when it is smaller than the original (the upload's own limit then
// decides), else the original.
export async function preparePhoto(file: File, codec: PhotoCodec): Promise<File> {
  if (!needsShrink(file)) return file;
  const size = await codec.size(file).catch(() => null);
  if (!size) return file;
  let smallest: Blob | null = null;
  for (const step of photoSteps(size.width, size.height)) {
    const blob = await codec.encode(file, step).catch(() => null);
    if (!blob) continue;
    if (smallest === null || blob.size < smallest.size) smallest = blob;
    if (blob.size <= PHOTO_BUDGET_BYTES) return new File([blob], photoName(file.name), { type: PHOTO_TYPE, lastModified: file.lastModified });
  }
  return smallest !== null && smallest.size < file.size ? new File([smallest], photoName(file.name), { type: PHOTO_TYPE, lastModified: file.lastModified }) : file;
}

// The browser's codec: the photo decoded with its camera orientation applied, drawn on a canvas at the step's size and
// written as a JPEG. Drawn on white first, so a PNG's transparency does not become black.
export const browserCodec: PhotoCodec = {
  size: async (file) => {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  },
  encode: async (file, step) => {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const { width, height } = scaledSize(bitmap.width, bitmap.height, step.side);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.fillStyle = 'white';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, PHOTO_TYPE, step.quality));
    } finally {
      bitmap.close();
    }
  },
};
