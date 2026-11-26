// SPDX-License-Identifier: AGPL-3.0-only
// Rules of the app that a later change could break without any test of behaviour noticing (issue #4880): where a token may be
// kept, what may open the sign-in page, what may be logged. They read the source text.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]));
const sources = ['index.ts', 'app.config.ts', ...files('src')].map((path) => ({ path, text: readFileSync(join(root, path), 'utf8') }));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };

describe('token hygiene', () => {
  it('keeps tokens only in the secure storage: one file imports it, and nothing else stores anything', () => {
    expect(sources.filter((s) => /from 'expo-secure-store'/.test(s.text)).map((s) => s.path)).toEqual([join('src', 'platform', 'secure-store.ts')]);
    for (const s of sources) {
      const code = s.text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
      expect(code, s.path).not.toMatch(/AsyncStorage|async-storage|localStorage|sessionStorage|expo-file-system|expo-sqlite|MMKV/);
    }
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      expect(name).not.toMatch(/async-storage|mmkv|sqlite|file-system|webview|auth-session/);
    }
  });

  it('opens the sign-in page only through the system browser, never a webview', () => {
    for (const s of sources) expect(s.text, s.path).not.toMatch(/WebView|Linking\.openURL|InAppBrowser/);
    expect(sources.find((s) => s.path.endsWith('browser.ts'))?.text).toContain('openAuthSessionAsync');
  });

  it('logs nothing: no console output can carry a token', () => {
    for (const s of sources) expect(s.text, s.path).not.toMatch(/\bconsole\.(log|info|debug|warn|error|trace)\b/);
  });

  it('puts no secret or client id in the bundle: the OAuth client id and endpoints come from the server', () => {
    for (const s of sources) {
      expect(s.text, s.path).not.toMatch(/client_secret|clientSecret|apikey|api_key|sk_live|-----BEGIN/i);
      expect(s.text, s.path).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });

  it('keeps every dependency of the app to an exact, pinned catalog entry', () => {
    for (const [name, spec] of Object.entries(manifest.dependencies)) expect(spec === 'catalog:' || spec === 'workspace:*', name).toBe(true);
  });
});
