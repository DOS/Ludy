// SPDX-License-Identifier: AGPL-3.0-only
// The icons the manifest names (#3007): each file exists, is a PNG of the size its name and key say, and is one the build copies into the package, so the store
// and the browser never find a manifest naming a file the package does not hold.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8')) as { icons?: Record<string, string>; action?: { default_icon?: Record<string, string> } };
const build = readFileSync(new URL('scripts/build.mjs', root), 'utf8');
const copied = [...(/const ICONS = \[([^\]]*)\]/.exec(build)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

const pngSize = (file: Buffer): { width: number; height: number } => {
  expect(file.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
};

describe('extension icons', () => {
  it('the manifest names the four sizes for the extension and for the toolbar button', () => {
    expect(Object.keys(manifest.icons ?? {}).sort()).toEqual(['128', '16', '32', '48']);
    expect(manifest.action?.default_icon).toEqual(manifest.icons);
  });

  it.each(['16', '32', '48', '128'])('the %s pixel icon is a PNG of that size and is copied by the build', (size) => {
    const path = manifest.icons?.[size] ?? '';
    expect(path).toBe(`icons/icon-${size}.png`);
    expect(copied).toContain(path.replace('icons/', ''));
    expect(pngSize(readFileSync(new URL(path, root)))).toEqual({ width: Number(size), height: Number(size) });
  });
});
