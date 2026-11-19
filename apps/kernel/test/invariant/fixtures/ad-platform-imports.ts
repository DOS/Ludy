// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strips JS/TS line and block comments while preserving string, template, and regex literals. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let prevNonWs = '';
  let prevWord = '';
  while (i < src.length) {
    const ch = src[i] ?? '';
    const next = src[i + 1] ?? '';
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < src.length) {
        const c = src[i] ?? '';
        out += c;
        i += 1;
        if (c === '\\' && i < src.length) {
          out += src[i] ?? '';
          i += 1;
        } else if (c === quote) {
          break;
        }
      }
      prevNonWs = quote;
      prevWord = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < src.length && src[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      out += ' ';
      continue;
    }
    if (
      ch === '/' &&
      (prevNonWs === '' ||
        '=([,!&|?:;{<>+-*%^~'.includes(prevNonWs) ||
        ['return', 'case', 'throw', 'typeof', 'void', 'delete', 'in', 'of'].includes(prevWord))
    ) {
      let inClass = false;
      out += ch;
      i += 1;
      while (i < src.length) {
        const c = src[i] ?? '';
        out += c;
        i += 1;
        if (c === '\\' && i < src.length) {
          out += src[i] ?? '';
          i += 1;
        } else if (c === '[' && !inClass) {
          inClass = true;
        } else if (c === ']' && inClass) {
          inClass = false;
        } else if ((c === '/' && !inClass) || c === '\n') {
          break;
        }
      }
      prevNonWs = '/';
      prevWord = '';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) {
      prevNonWs = ch;
      if (/[A-Za-z0-9_$]/.test(ch)) {
        let j = i;
        while (j > 0 && /[A-Za-z0-9_$]/.test(src[j - 1] ?? '')) j -= 1;
        prevWord = src.slice(j, i + 1);
      } else {
        prevWord = '';
      }
    }
    i += 1;
  }
  return out;
}

/** Resolves the active `@crove/ad-platform` or `@ludy/ad-platform` package name from the workspace manifest. */
export function resolveAdPlatformPackages(root: string): { activePkg: string; inactivePkg: string } {
  const pkg = (JSON.parse(readFileSync(join(root, 'packages/ad-platform/package.json'), 'utf8')) as { name: string }).name;
  if (pkg !== '@crove/ad-platform' && pkg !== '@ludy/ad-platform') {
    throw new Error(`Unexpected ad-platform package name: ${pkg}`);
  }
  return {
    activePkg: pkg,
    inactivePkg: pkg === '@crove/ad-platform' ? '@ludy/ad-platform' : '@crove/ad-platform',
  };
}

/** Returns comment-free module specifier matches (`from`, `import(...)`, side-effect `import`, `require(...)`) for a package. */
export function pkgImportMatches(src: string, pkgName: string): string[] {
  const re = new RegExp(`\\b(?:from\\s*|import\\s*(?:\\(\\s*)?|require\\s*\\(\\s*)['"]${escapeRe(pkgName)}(?:/[^'"]*)?['"]`, 'g');
  return [...stripComments(src).matchAll(re)].map((m) => m[0]);
}

/** Extracts named imports from the active ad-platform package after rejecting any inactive-scope import. */
export function activeAdPlatformNamedImports(src: string, activePkg: string, inactivePkg: string): string[] {
  const cleaned = stripComments(src);
  if (pkgImportMatches(cleaned, inactivePkg).length > 0) {
    throw new Error(`Unexpected mixed ad-platform import from ${inactivePkg}`);
  }
  return [...cleaned.matchAll(new RegExp(`import (?:type )?\\{([^}]*)\\} from ['"]${escapeRe(activePkg)}['"]`, 'g'))].flatMap((m) =>
    (m[1] ?? '')
      .split(',')
      .map((s) => s.replace(/\btype\b/, '').trim())
      .filter(Boolean),
  );
}
