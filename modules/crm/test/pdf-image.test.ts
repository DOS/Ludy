// SPDX-License-Identifier: AGPL-3.0-only
// The reader of the letterhead's logo (#2814, modules/crm/src/pdf/image.ts): what it takes (a JPEG's frame header, an 8-bit PNG of any of the five colour types with all five
// filters), what it leaves out without a word (16-bit and interlaced PNGs, odd JPEG frames, too large a picture, a stream that grows beyond what its header says, anything damaged),
// and that it never throws or runs away on bytes that are not a picture.
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { MAX_PIXELS, MAX_SIDE, readLogoImage } from '../src/pdf/image.ts';
import { gradient, jpeg, png, pngWithIdat } from './png-fixture.ts';

const FILTERS = [0, 1, 2, 3, 4];

describe('the logo as a PNG', () => {
  it('reads gray, RGB, gray with alpha and RGBA, whatever the filter of each row', () => {
    for (const [colorType, channels, space] of [[0, 1, 'DeviceGray'], [2, 3, 'DeviceRGB']] as const) {
      const samples = gradient(7, 6, channels);
      const image = readLogoImage(png({ width: 7, height: 6, colorType, samples, filters: FILTERS }), 'image/png');
      expect(image).toMatchObject({ width: 7, height: 6, space, alpha: null });
      expect(image?.colour.kind).toBe('raw');
      expect([...(image?.colour.data ?? [])]).toEqual([...samples]);
    }
    for (const [colorType, channels, space] of [[4, 2, 'DeviceGray'], [6, 4, 'DeviceRGB']] as const) {
      const samples = gradient(5, 4, channels);
      const image = readLogoImage(png({ width: 5, height: 4, colorType, samples, filters: FILTERS }), 'image/png');
      expect(image).toMatchObject({ width: 5, height: 4, space });
      const colourChannels = channels - 1;
      const colour: number[] = [];
      const alpha: number[] = [];
      for (let i = 0; i < 20; i++) {
        for (let c = 0; c < colourChannels; c++) colour.push(samples[i * channels + c] as number);
        alpha.push(samples[i * channels + colourChannels] as number);
      }
      expect([...(image?.colour.data ?? [])]).toEqual(colour);
      expect([...(image?.alpha ?? [])]).toEqual(alpha);
    }
  });

  it('drops an alpha plane that is opaque everywhere, and keeps one that is not', () => {
    const opaque = new Uint8Array(3 * 3 * 4).map((_, i) => (i % 4 === 3 ? 255 : i));
    expect(readLogoImage(png({ width: 3, height: 3, colorType: 6, samples: opaque }), 'image/png')?.alpha).toBeNull();
    opaque[3] = 0;
    expect(readLogoImage(png({ width: 3, height: 3, colorType: 6, samples: opaque }), 'image/png')?.alpha).not.toBeNull();
  });

  it('expands a palette with its transparency, and refuses an index the palette does not have', () => {
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]);
    const samples = new Uint8Array([0, 1, 2, 2]);
    const image = readLogoImage(png({ width: 2, height: 2, colorType: 3, samples, palette, transparency: new Uint8Array([255, 128]), filters: FILTERS }), 'image/png');
    expect([...(image?.colour.data ?? [])]).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255]);
    expect([...(image?.alpha ?? [])]).toEqual([255, 128, 255, 255]);
    expect(readLogoImage(png({ width: 2, height: 2, colorType: 3, samples: new Uint8Array([0, 1, 2, 3]), palette }), 'image/png')).toBeNull();
    expect(readLogoImage(png({ width: 2, height: 2, colorType: 3, samples, palette: new Uint8Array([1, 2]) }), 'image/png')).toBeNull();
    expect(readLogoImage(png({ width: 2, height: 2, colorType: 3, samples }), 'image/png')).toBeNull();
  });

  it('leaves out what it does not take: 16-bit, interlaced, too large, damaged', () => {
    const samples = gradient(4, 4, 3);
    expect(readLogoImage(png({ width: 4, height: 4, colorType: 2, samples, depth: 16 }), 'image/png')).toBeNull();
    expect(readLogoImage(png({ width: 4, height: 4, colorType: 2, samples, interlace: 1 }), 'image/png')).toBeNull();
    expect(readLogoImage(png({ width: MAX_SIDE + 1, height: 1, colorType: 0, samples: new Uint8Array(MAX_SIDE + 1) }), 'image/png')).toBeNull();
    const base = png({ width: 4, height: 4, colorType: 2, samples });
    expect(readLogoImage(base.subarray(0, base.length - 20), 'image/png')).toBeNull();
    const tampered = Buffer.from(base);
    tampered[1] = 0;
    expect(readLogoImage(tampered, 'image/png')).toBeNull();
    // A row whose filter byte is not one of the five.
    const row = Buffer.alloc(4 * 3 + 1);
    row[0] = 9;
    expect(readLogoImage(pngWithIdat({ width: 4, height: 1, colorType: 2 }, deflateSync(row)), 'image/png')).toBeNull();
  });

  it('refuses a stream that inflates to more than the header says, and one that is too short', () => {
    // The header says 4 by 4; the stream holds a megabyte of zeros.
    expect(readLogoImage(pngWithIdat({ width: 4, height: 4, colorType: 2 }, deflateSync(Buffer.alloc(1024 * 1024))), 'image/png')).toBeNull();
    expect(readLogoImage(pngWithIdat({ width: 4, height: 4, colorType: 2 }, deflateSync(Buffer.alloc(10))), 'image/png')).toBeNull();
    expect(readLogoImage(pngWithIdat({ width: 4, height: 4, colorType: 2 }, Buffer.from('not zlib at all')), 'image/png')).toBeNull();
  });

  it('allows the largest picture it takes and no more, by a side and by pixels', () => {
    expect([MAX_SIDE, MAX_PIXELS]).toEqual([1024, 1024 * 1024]);
    // 1024 by 1024 gray, all one value: small as a file, the most it takes as a picture.
    const big = readLogoImage(png({ width: 1024, height: 1024, colorType: 0, samples: new Uint8Array(1024 * 1024) }), 'image/png');
    expect(big).toMatchObject({ width: 1024, height: 1024 });
    expect(readLogoImage(png({ width: 1025, height: 1, colorType: 0, samples: new Uint8Array(1025) }), 'image/png')).toBeNull();
    expect(readLogoImage(png({ width: 1, height: 1025, colorType: 0, samples: new Uint8Array(1025) }), 'image/png')).toBeNull();
    // Within a side and the megapixel: taken.
    expect(readLogoImage(png({ width: 1024, height: 1023, colorType: 0, samples: new Uint8Array(1024 * 1023) }), 'image/png')).toMatchObject({ width: 1024, height: 1023 });
  });
});

describe('the logo as a JPEG', () => {
  it('takes baseline, extended and progressive frames of one or three components, and keeps the file as it is', () => {
    for (const marker of [0xc0, 0xc1, 0xc2]) {
      const file = jpeg({ marker, width: 300, height: 120 });
      const image = readLogoImage(file, 'image/jpeg');
      expect(image).toMatchObject({ width: 300, height: 120, space: 'DeviceRGB', alpha: null, colour: { kind: 'jpeg' } });
      expect(Buffer.from(image?.colour.data ?? []).equals(file)).toBe(true);
    }
    expect(readLogoImage(jpeg({ width: 10, height: 10, components: 1 }), 'image/jpeg')).toMatchObject({ space: 'DeviceGray' });
  });

  it('leaves out CMYK, lossless, arithmetic-coded, 12-bit, empty and oversized frames, and a file with no frame header', () => {
    expect(readLogoImage(jpeg({ width: 10, height: 10, components: 4 }), 'image/jpeg')).toBeNull();
    for (const marker of [0xc3, 0xc5, 0xc9, 0xca, 0xcf]) expect(readLogoImage(jpeg({ marker, width: 10, height: 10 }), 'image/jpeg'), String(marker)).toBeNull();
    expect(readLogoImage(jpeg({ width: 10, height: 10, precision: 12 }), 'image/jpeg')).toBeNull();
    expect(readLogoImage(jpeg({ width: 0, height: 10 }), 'image/jpeg')).toBeNull();
    expect(readLogoImage(jpeg({ width: MAX_SIDE + 1, height: 10 }), 'image/jpeg')).toBeNull();
    expect(readLogoImage(jpeg({ width: 3000, height: 3000 }), 'image/jpeg')).toBeNull();
    expect(readLogoImage(jpeg({ width: 1024, height: 1024 }), 'image/jpeg')).not.toBeNull();
    expect(readLogoImage(jpeg({ width: 1025, height: 100 }), 'image/jpeg')).toBeNull();
    const file = jpeg({ width: 10, height: 10 });
    expect(readLogoImage(file.subarray(0, 12), 'image/jpeg')).toBeNull();
    expect(readLogoImage(file.subarray(2), 'image/jpeg')).toBeNull();
    // A scan before any frame header.
    expect(readLogoImage(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]), 'image/jpeg')).toBeNull();
  });
});

describe('what is not a logo', () => {
  it('goes by the type the file row says: a PNG called a JPEG, a WebP, a GIF, an SVG are all left out', () => {
    const file = png({ width: 2, height: 2, colorType: 0, samples: new Uint8Array(4) });
    expect(readLogoImage(file, 'image/jpeg')).toBeNull();
    expect(readLogoImage(jpeg({ width: 2, height: 2 }), 'image/png')).toBeNull();
    for (const type of ['image/webp', 'image/gif', 'image/svg+xml', 'application/pdf', '']) expect(readLogoImage(file, type), type).toBeNull();
  });

  it('never throws on bytes that are not a picture, nor on a picture cut anywhere', () => {
    for (let i = 0; i < 300; i++) {
      const junk = randomBytes(1 + (i % 200));
      for (const type of ['image/png', 'image/jpeg']) expect(() => readLogoImage(junk, type)).not.toThrow();
      const headed = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), junk]);
      expect(() => readLogoImage(headed, 'image/png')).not.toThrow();
      expect(() => readLogoImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), junk]), 'image/jpeg')).not.toThrow();
    }
    const file = png({ width: 6, height: 6, colorType: 6, samples: gradient(6, 6, 4), filters: FILTERS });
    for (let cut = 0; cut < file.length; cut++) expect(() => readLogoImage(file.subarray(0, cut), 'image/png')).not.toThrow();
    const jfile = jpeg({ width: 60, height: 40 });
    for (let cut = 0; cut < jfile.length; cut++) expect(() => readLogoImage(jfile.subarray(0, cut), 'image/jpeg')).not.toThrow();
    expect(readLogoImage(new Uint8Array(0), 'image/png')).toBeNull();
    expect(readLogoImage(new Uint8Array(0), 'image/jpeg')).toBeNull();
  });
});
