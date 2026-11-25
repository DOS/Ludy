// SPDX-License-Identifier: AGPL-3.0-only
// Google Picker for the audio of a Google Meet recording (meetings C2, #3174, ADR-0025 amendment of 2026-11-25). The member picks the recording file in their own Drive, and only the Drive file id goes to the
// API. This file is the ONE place a Google token exists in the browser, and it is the narrow exception the amendment names:
//   - the token is minted in the browser by Google Identity Services (the token client), for the single scope `drive.file`, valid about an hour; it is a different token from the one Ludy seals on the server;
//   - it lives in a local variable for the length of one pick and is handed to the Picker; it is never sent to Ludy's API, never put in a cookie, `localStorage`, `sessionStorage`, IndexedDB or the query
//     cache, never logged, and not revoked either (revoking would end the member's `drive.file` grant for the app, which the server's own read needs); it is simply dropped when the Picker closes;
//   - no other scope, provider or picker is covered (apps/app/test/google-picker.test.ts pins the scope and that nothing is stored).
// Google's two scripts are loaded through a Trusted Types policy of ours, ludy-google, whose createScriptURL gives back exactly those two fixed URLs and throws for anything else (like ludy-turnstile, turnstile.ts);
// it has no createHTML or createScript. The kernel's CSP names this policy and the Google hosts only on a deployment that set the Picker's keys (apps/kernel/src/http.ts, apps/app/vite-csp.ts).

export const GOOGLE_PICKER_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GOOGLE_IDENTITY_SCRIPT = 'https://accounts.google.com/gsi/client';
export const GOOGLE_API_SCRIPT = 'https://apis.google.com/js/api.js';
export const GOOGLE_POLICY = 'ludy-google';
// The Drive file types a Meet recording can be: a Meet recording is an MP4.
export const GOOGLE_PICKER_MIME_TYPES = 'video/mp4';

// The policy's only rule: Google's two script URLs, exactly.
export function googleScriptUrl(input: string): string {
  if (input !== GOOGLE_IDENTITY_SCRIPT && input !== GOOGLE_API_SCRIPT) throw new TypeError('ludy-google only allows the two Google scripts');
  return input;
}

export interface GooglePickerConfig {
  apiKey: string;
  appId: string;
  clientId: string;
}

interface ScriptUrlPolicy {
  createScriptURL(input: string): unknown;
}
interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL: (input: string) => string }): ScriptUrlPolicy;
}

// What this file uses of Google's browser libraries (Google Identity Services and the Picker API).
interface TokenResponse {
  access_token?: string;
  error?: string;
  // The scopes the token carries, space separated.
  scope?: string;
}
interface TokenClient {
  requestAccessToken(options?: { prompt?: string }): void;
}
interface PickerDoc {
  id?: string;
}
interface PickerResponse {
  action: string;
  docs?: PickerDoc[];
}
interface PickerBuilderLike {
  addView(view: unknown): PickerBuilderLike;
  setOAuthToken(token: string): PickerBuilderLike;
  setDeveloperKey(key: string): PickerBuilderLike;
  setAppId(appId: string): PickerBuilderLike;
  setCallback(callback: (response: PickerResponse) => void): PickerBuilderLike;
  build(): { setVisible(visible: boolean): void; dispose?(): void };
}
interface GoogleGlobals {
  accounts?: {
    oauth2?: {
      initTokenClient(config: { client_id: string; scope: string; include_granted_scopes: boolean; callback: (response: TokenResponse) => void; error_callback?: (error: unknown) => void }): TokenClient;
    };
  };
  picker?: {
    PickerBuilder: new () => PickerBuilderLike;
    DocsView: new (viewId?: string) => { setMimeTypes(types: string): unknown; setIncludeFolders(on: boolean): unknown };
    ViewId: { DOCS: string };
    Action: { PICKED: string; CANCEL: string };
  };
}
interface GapiLike {
  load(api: string, config: { callback: () => void; onerror: () => void; timeout: number; ontimeout: () => void }): void;
}

let policy: ScriptUrlPolicy | null = null;
const loading = new Map<string, Promise<void>>();

// Loads one of Google's two scripts once, through ludy-google where the browser has Trusted Types.
function loadScript(url: string, ready: () => boolean): Promise<void> {
  let pending = loading.get(url);
  if (pending === undefined) {
    pending = new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      const tt = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes;
      if (tt) policy ??= tt.createPolicy(GOOGLE_POLICY, { createScriptURL: googleScriptUrl });
      // A TrustedScriptURL where the browser has Trusted Types; the src setter accepts it where it accepts the string.
      script.src = (policy ? policy.createScriptURL(url) : googleScriptUrl(url)) as string;
      script.async = true;
      script.onload = () => (ready() ? resolve() : reject(new Error('google script missing')));
      script.onerror = () => reject(new Error('google script failed to load'));
      document.head.appendChild(script);
    }).catch((error: unknown) => {
      // A script that failed is tried again on the next pick, not remembered as failed.
      loading.delete(url);
      throw error;
    });
    loading.set(url, pending);
  }
  return pending;
}

const googleOf = (): GoogleGlobals => (globalThis as { google?: GoogleGlobals }).google ?? {};
const gapiOf = (): GapiLike | undefined => (globalThis as { gapi?: GapiLike }).gapi;

// `failed`: a Google script did not load or answer in time (blocked by the network, an extension or the policy); the member may try again. `denied`: Google did not give the one `drive.file` permission.
export type GooglePickResult = { status: 'picked'; fileId: string } | { status: 'cancelled' } | { status: 'denied' } | { status: 'failed' };

// How long the picker module may take to load, and how long the whole pick may stay open before it is given up (the member walked away): the row never stays busy for ever.
export const GOOGLE_LOAD_TIMEOUT_MS = 15_000;
export const GOOGLE_PICK_TIMEOUT_MS = 10 * 60_000;

// True when the token the browser got carries `drive.file` and nothing else. The token client adds every scope the member already granted this client (the server's Meet connect holds one) unless told not to,
// so the answer is checked as well as asked for: a token with another scope is dropped unused, and the member is told the permission was not given.
export const tokenIsDriveFileOnly = (scope: unknown): boolean => {
  if (typeof scope !== 'string') return false;
  const scopes = scope.split(/\s+/u).filter((s) => s !== '');
  return scopes.length === 1 && scopes[0] === GOOGLE_PICKER_SCOPE;
};

let inFlight: Promise<GooglePickResult> | null = null;

/**
 * Opens Google Picker for one recording file and answers the Drive file id the member picked, or that they cancelled, did not grant access, or that Google's scripts failed. The `drive.file` token it needs is requested
 * from Google Identity Services here, held in this call's scope only, and dropped (with the Picker) when it returns. One pick at a time: a second call while one is open gets the same answer.
 */
export function pickDriveFile(config: GooglePickerConfig): Promise<GooglePickResult> {
  inFlight ??= pick(config)
    .catch((): GooglePickResult => ({ status: 'failed' }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function pick(config: GooglePickerConfig): Promise<GooglePickResult> {
  await Promise.all([loadScript(GOOGLE_IDENTITY_SCRIPT, () => googleOf().accounts?.oauth2 !== undefined), loadScript(GOOGLE_API_SCRIPT, () => gapiOf() !== undefined)]);
  await new Promise<void>((resolve, reject) => {
    (gapiOf() as GapiLike).load('picker', {
      callback: resolve,
      onerror: () => reject(new Error('google picker failed to load')),
      timeout: GOOGLE_LOAD_TIMEOUT_MS,
      ontimeout: () => reject(new Error('google picker timed out')),
    });
  });
  let token: string | null = await new Promise<string | null>((resolve) => {
    const oauth2 = googleOf().accounts?.oauth2;
    if (!oauth2) {
      resolve(null);
      return;
    }
    const client = oauth2.initTokenClient({
      client_id: config.clientId,
      scope: GOOGLE_PICKER_SCOPE,
      // Only the one scope asked for, not every scope this member granted the client before.
      include_granted_scopes: false,
      callback: (response) => resolve(typeof response.access_token === 'string' && response.error === undefined && tokenIsDriveFileOnly(response.scope) ? response.access_token : null),
      error_callback: () => resolve(null),
    });
    client.requestAccessToken();
  });
  if (token === null) return { status: 'denied' };
  const picker = googleOf().picker;
  if (!picker) return { status: 'failed' };
  const view = new picker.DocsView(picker.ViewId.DOCS);
  view.setMimeTypes(GOOGLE_PICKER_MIME_TYPES);
  view.setIncludeFolders(true);
  return new Promise<GooglePickResult>((resolve) => {
    let built: { setVisible(visible: boolean): void; dispose?(): void } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The one exit: the answer, the Picker taken down and the token dropped, whichever of the callback and the timer comes first.
    const finish = (result: GooglePickResult) => {
      clearTimeout(timer);
      token = null;
      try {
        built?.dispose?.();
      } catch {
        // A Picker that is already gone is gone.
      }
      built = null;
      resolve(result);
    };
    timer = setTimeout(() => finish({ status: 'failed' }), GOOGLE_PICK_TIMEOUT_MS);
    built = new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token as string)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .setCallback((response) => {
        if (response.action === picker.Action.PICKED) {
          const id = response.docs?.[0]?.id;
          finish(typeof id === 'string' && id !== '' ? { status: 'picked', fileId: id } : { status: 'cancelled' });
        } else if (response.action === picker.Action.CANCEL) {
          finish({ status: 'cancelled' });
        }
      })
      .build();
    built.setVisible(true);
  });
}
