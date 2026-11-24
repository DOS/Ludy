// SPDX-License-Identifier: AGPL-3.0-only
// Strict local UI origin & allowlisted bundle path resolver for Ludy Desktop capture windows (B2, NB1, NB3).
import { extname, isAbsolute, relative, resolve } from 'node:path';

export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export const UI_BUNDLE_MIME: Readonly<Record<string, string>> = {
  'consent.html': 'text/html; charset=utf-8',
  'consent-ui.js': 'application/javascript; charset=utf-8',
  'pill.html': 'text/html; charset=utf-8',
  'pill-ui.js': 'application/javascript; charset=utf-8',
  'worker.html': 'text/html; charset=utf-8',
  'worker.js': 'application/javascript; charset=utf-8',
  'pcm-worklet.js': 'application/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
};

const MIME_BY_LOWER_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function isExpectedUiOrigin(urlStr: string | undefined, expectedOrigin = 'ludy-desktop://ui'): boolean {
  if (!urlStr) return false;
  try {
    const parsed = new URL(urlStr);
    const expected = new URL(expectedOrigin);
    if (parsed.protocol !== expected.protocol || parsed.hostname !== expected.hostname || parsed.port !== expected.port) {
      return false;
    }
    if (parsed.username !== '' || parsed.password !== '') return false;
    if (parsed.origin !== 'null' && expected.origin !== 'null' && parsed.origin !== expected.origin) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveUiBundleFile(uiRoot: string, requestUrl: string): { path: string; mimeType: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (!isExpectedUiOrigin(parsed.toString())) return null;
  if (parsed.search !== '' || parsed.hash !== '') return null;

  const rawPath = parsed.pathname.replace(/^\/+/, '');
  if (!rawPath || rawPath.includes('/') || rawPath.includes('\\') || rawPath.includes('..')) {
    return null;
  }
  if (!Object.hasOwn(UI_BUNDLE_MIME, rawPath)) {
    return null;
  }

  const rootResolved = resolve(uiRoot);
  const fullPath = resolve(rootResolved, rawPath);
  const rel = relative(rootResolved, fullPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return null;
  }

  const lowerExt = extname(fullPath).toLowerCase();
  const mimeType = MIME_BY_LOWER_EXT[lowerExt] ?? UI_BUNDLE_MIME[rawPath];
  if (!mimeType) return null;
  return { path: fullPath, mimeType };
}
