// SPDX-License-Identifier: AGPL-3.0-only
// Google Picker for the audio of a Google Meet recording (#3174, ADR-0025 amendment of 2026-11-25): the one place a Google token exists in the browser. These tests pin what the amendment promises: the
// token is for `drive.file` only, goes to the Picker and nowhere else, is never stored, logged, sent to Ludy or revoked, the two scripts load only through the ludy-google policy with their exact URLs, and
// a pick answers the Drive file id alone. Google's libraries are fakes; no Google call is made.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_API_SCRIPT, GOOGLE_IDENTITY_SCRIPT, GOOGLE_PICKER_SCOPE, GOOGLE_POLICY, googleScriptUrl } from '../src/lib/google-picker.ts';

// A fresh module for every test: it remembers which of Google's scripts it already loaded.
let pickDriveFile: typeof import('../src/lib/google-picker.ts').pickDriveFile;
beforeEach(async () => {
  vi.resetModules();
  pickDriveFile = (await import('../src/lib/google-picker.ts')).pickDriveFile;
});

const CONFIG = { apiKey: 'AIzaSyFakeKeyForTestsOnly000000000000', appId: '123456789012', clientId: '123456789012-abcdefghijklmnop.apps.googleusercontent.com' };
const TOKEN = 'ya29.fake-drive-file-token-for-tests';
const FILE = '1AbCdEfGhIjKlMnOpQrStUvWxYz_-0123456789';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;
const KEYS = ['document', 'google', 'gapi', 'trustedTypes', 'localStorage', 'sessionStorage', 'indexedDB'];
afterEach(() => {
  for (const key of KEYS) delete g[key];
});

interface Rig {
  scripts: string[];
  policies: string[];
  tokenRequests: Array<{ client_id: string; scope: string }>;
  built: Array<{ token: string; key: string; appId: string; mime: string }>;
  writes: string[];
}

// A page with Google's two scripts: appending a script installs the library it stands for, then fires onload.
function rig(options: { tokenError?: boolean; action?: 'picked' | 'cancel'; docs?: Array<{ id?: string }>; trustedTypes?: boolean } = {}): Rig {
  const state: Rig = { scripts: [], policies: [], tokenRequests: [], built: [], writes: [] };
  const storage = new Proxy({}, { get: () => () => state.writes.push('storage read'), set: () => { state.writes.push('storage write'); return true; } });
  g.localStorage = storage;
  g.sessionStorage = storage;
  g.indexedDB = new Proxy({}, { get: () => () => state.writes.push('indexedDB') });
  if (options.trustedTypes !== false) {
    g.trustedTypes = {
      createPolicy: (name: string, rules: { createScriptURL: (input: string) => string }) => {
        state.policies.push(name);
        return { createScriptURL: (input: string) => `TRUSTED:${rules.createScriptURL(input)}` };
      },
    };
  }
  const document = {
    cookie: '',
    createElement: () => ({}) as Record<string, unknown>,
    head: {
      appendChild: (script: Record<string, unknown>) => {
        const src = String(script.src);
        state.scripts.push(src);
        if (src.endsWith(GOOGLE_IDENTITY_SCRIPT)) {
          g.google = {
            ...(g.google as G | undefined),
            accounts: {
              oauth2: {
                initTokenClient: (config: { client_id: string; scope: string; callback: (response: { access_token?: string; error?: string }) => void; error_callback?: () => void }) => ({
                  requestAccessToken: () => {
                    state.tokenRequests.push({ client_id: config.client_id, scope: config.scope });
                    if (options.tokenError) config.error_callback?.();
                    else config.callback({ access_token: TOKEN });
                  },
                }),
              },
            },
          };
        } else {
          g.gapi = {
            load: (_api: string, callback: () => void) => {
              g.google = {
                ...(g.google as G | undefined),
                picker: {
                  ViewId: { DOCS: 'docs' },
                  Action: { PICKED: 'picked', CANCEL: 'cancel' },
                  DocsView: class {
                    mime = '';
                    setMimeTypes(types: string) {
                      this.mime = types;
                    }
                    setIncludeFolders() {}
                  },
                  PickerBuilder: class {
                    view: { mime: string } | null = null;
                    token = '';
                    key = '';
                    app = '';
                    callback: ((response: { action: string; docs?: Array<{ id?: string }> }) => void) | null = null;
                    addView(view: { mime: string }) {
                      this.view = view;
                      return this;
                    }
                    setOAuthToken(token: string) {
                      this.token = token;
                      return this;
                    }
                    setDeveloperKey(key: string) {
                      this.key = key;
                      return this;
                    }
                    setAppId(app: string) {
                      this.app = app;
                      return this;
                    }
                    setCallback(callback: NonNullable<typeof this.callback>) {
                      this.callback = callback;
                      return this;
                    }
                    build() {
                      state.built.push({ token: this.token, key: this.key, appId: this.app, mime: this.view?.mime ?? '' });
                      return { setVisible: () => this.callback?.({ action: options.action ?? 'picked', docs: options.docs ?? [{ id: FILE }] }) };
                    }
                  },
                },
              };
              callback();
            },
          };
        }
        queueMicrotask(() => (script.onload as () => void)());
      },
    },
  };
  Object.defineProperty(document, 'cookie', { get: () => '', set: () => void state.writes.push('cookie') });
  g.document = document;
  return state;
}

describe('the ludy-google Trusted Types policy', () => {
  it('passes the two Google scripts exactly and refuses anything else', () => {
    expect(GOOGLE_POLICY).toBe('ludy-google');
    expect(googleScriptUrl(GOOGLE_IDENTITY_SCRIPT)).toBe('https://accounts.google.com/gsi/client');
    expect(googleScriptUrl(GOOGLE_API_SCRIPT)).toBe('https://apis.google.com/js/api.js');
    for (const url of ['https://accounts.google.com/gsi/client?x=1', 'https://apis.google.com/js/other.js', 'https://evil.example/api.js', '/assets/x.js', '']) {
      expect(() => googleScriptUrl(url), url).toThrow(/only allows the two Google scripts/);
    }
  });
});

describe('pickDriveFile', () => {
  it('asks Google Identity Services for the one scope drive.file, gives the token to the Picker alone and answers the file id', async () => {
    const page = rig();
    const result = await pickDriveFile(CONFIG);
    expect(result).toEqual({ status: 'picked', fileId: FILE });
    expect(page.tokenRequests).toEqual([{ client_id: CONFIG.clientId, scope: 'https://www.googleapis.com/auth/drive.file' }]);
    expect(GOOGLE_PICKER_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
    expect(page.built).toEqual([{ token: TOKEN, key: CONFIG.apiKey, appId: CONFIG.appId, mime: 'video/mp4' }]);
    // Both scripts, through the policy, with their exact URLs, once each.
    expect(page.policies).toEqual(['ludy-google']);
    expect([...page.scripts].sort()).toEqual([`TRUSTED:${GOOGLE_IDENTITY_SCRIPT}`, `TRUSTED:${GOOGLE_API_SCRIPT}`].sort());
    // The answer carries the file id and nothing else: no token anywhere in it.
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('stores the token nowhere: no cookie, localStorage, sessionStorage or IndexedDB write', async () => {
    const page = rig();
    await pickDriveFile(CONFIG);
    expect(page.writes).toEqual([]);
  });

  it('answers cancelled when the member closes the Picker, or picks a file with no id', async () => {
    rig({ action: 'cancel' });
    expect(await pickDriveFile(CONFIG)).toEqual({ status: 'cancelled' });
  });

  it('answers cancelled for a pick that holds no id', async () => {
    rig({ docs: [{}] });
    expect(await pickDriveFile(CONFIG)).toEqual({ status: 'cancelled' });
  });

  it('answers denied when Google gives no token, and builds no Picker', async () => {
    const denied = rig({ tokenError: true });
    expect(await pickDriveFile(CONFIG)).toEqual({ status: 'denied' });
    expect(denied.built).toEqual([]);
  });
});

// The amendment's promises as a scan of the source: the token never leaves this file, and this file does nothing with it but hand it to the Picker.
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}

describe('where a Google token may exist (the ADR-0025 amendment)', () => {
  const src = new URL('../src', import.meta.url).pathname;
  const own = join(src, 'lib/google-picker.ts');
  // Code only: the comments of the file explain what it never does, in the very words a scan looks for.
  const code = readFileSync(own, 'utf8').split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');

  it('keeps the token out of storage, the network, the console and a revoke', () => {
    for (const forbidden of [/localStorage/u, /sessionStorage/u, /indexedDB/u, /document\.cookie/u, /\bfetch\(/u, /XMLHttpRequest/u, /sendBeacon/u, /console\./u, /\.revoke\(/u, /queryClient/u, /orpc/u]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    // One scope, spelled once.
    expect(code.match(/googleapis\.com\/auth\//gu)).toHaveLength(1);
  });

  it('is the only file of the app that touches Google Identity Services\' token client or the Picker\'s token setter', () => {
    for (const file of sources(src)) {
      if (file === own) continue;
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/initTokenClient|setOAuthToken|requestAccessToken|google\.accounts/u);
    }
  });
});
