// SPDX-License-Identifier: AGPL-3.0-only
// The tray icons, drawn in code: a filled dot whose colour is the state (grey signed out, green signed in, bright crimson
// ring when actively recording, blue update ready, red problem). No binary asset sits in the repository.
import { crc32, deflateSync } from 'node:zlib';
import type { TrayIcon } from './tray-model.ts';

const COLORS: Readonly<Record<TrayIcon, readonly [number, number, number]>> = {
  'signed-out': [138, 143, 152],
  'signed-in': [31, 163, 91],
  recording: [225, 29, 72],
  update: [47, 111, 237],
  error: [214, 69, 69],
};

function chunk(type: string, data: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

// A square PNG of `size` pixels: a dot with a soft edge on a transparent background (and a distinct bright center dot while recording).
export function trayIconPng(icon: TrayIcon, size: number): Buffer {
  const [r, g, b] = COLORS[icon];
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const centre = (size - 1) / 2;
  const radius = size * 0.42;
  const innerRadius = size * 0.16;
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    rows[row] = 0;
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - centre, y - centre);
      const alpha = Math.max(0, Math.min(1, radius + 0.5 - distance));
      const at = row + 1 + x * 4;
      if (icon === 'recording' && distance < innerRadius) {
        rows[at] = 255;
        rows[at + 1] = 255;
        rows[at + 2] = 255;
      } else {
        rows[at] = r;
        rows[at + 1] = g;
        rows[at + 2] = b;
      }
      rows[at + 3] = Math.round(alpha * 255);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
