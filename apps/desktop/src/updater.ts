// SPDX-License-Identifier: AGPL-3.0-only
// Auto-update with Electron's built-in autoUpdater (Squirrel.Windows), as a small state machine over an injected updater so it runs in
// tests without Electron. The feed is the deployment's own (LUDY_DESKTOP_UPDATE_URL); no URL means updates are off.
//   - It checks at start and every 6 hours, one check at a time.
//   - Squirrel downloads a newer build by itself; the shell then says "update ready" and restarts only when the member chooses it
//     (the new version also starts the next time the app is opened). quitAndInstall is never called before `update-downloaded`.
//   - A failed check or download only reports: the version that is running is never touched, and the next check tries again.
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateState =
  | { kind: 'off'; reason: 'no-feed' | 'unsupported' }
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'downloading' }
  | { kind: 'ready'; version: string | null }
  | { kind: 'failed'; message: string };

export interface UpdaterEvents {
  checking(): void;
  available(): void;
  notAvailable(): void;
  downloaded(version: string | null): void;
  error(message: string): void;
}

// What the controller needs of Electron's autoUpdater; main.ts adapts the real one.
export interface AutoUpdaterLike {
  setFeedURL(url: string): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
  subscribe(events: UpdaterEvents): void;
}

export interface UpdaterOptions {
  updater: AutoUpdaterLike;
  // null: no feed configured.
  feedUrl: string | null;
  // false off Windows, or when the app was not installed by Squirrel (a dev run, a portable copy): there is no Update.exe to update with.
  supported: boolean;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (message: string) => void;
}

export interface UpdaterController {
  state(): UpdateState;
  subscribe(listener: (state: UpdateState) => void): () => void;
  // Checks now and then every CHECK_INTERVAL_MS.
  start(): void;
  checkNow(): void;
  // Restarts into the downloaded update. false (and nothing happens) unless one has been downloaded.
  restart(): boolean;
  stop(): void;
}

export function createUpdater(options: UpdaterOptions): UpdaterController {
  const log = options.log ?? (() => undefined);
  const setTimer = options.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearTimer = options.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const listeners = new Set<(state: UpdateState) => void>();
  let current: UpdateState = !options.supported ? { kind: 'off', reason: 'unsupported' } : options.feedUrl === null ? { kind: 'off', reason: 'no-feed' } : { kind: 'idle' };
  let timer: unknown;
  let wired = false;

  const set = (next: UpdateState): void => {
    current = next;
    for (const listener of listeners) listener(next);
  };

  const wire = (feedUrl: string): void => {
    if (wired) return;
    wired = true;
    options.updater.subscribe({
      checking: () => {
        if (current.kind !== 'ready') set({ kind: 'checking' });
      },
      available: () => {
        if (current.kind !== 'ready') set({ kind: 'downloading' });
      },
      notAvailable: () => {
        if (current.kind !== 'ready') set({ kind: 'idle' });
      },
      downloaded: (version) => set({ kind: 'ready', version }),
      error: (message) => {
        log(`update failed: ${message}`);
        // A downloaded update stays ready; anything else reports and waits for the next check. The running version is untouched either way.
        if (current.kind !== 'ready') set({ kind: 'failed', message });
      },
    });
    options.updater.setFeedURL(feedUrl);
  };

  const controller: UpdaterController = {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (current.kind === 'off' || timer !== undefined) return;
      controller.checkNow();
      timer = setTimer(() => controller.checkNow(), CHECK_INTERVAL_MS);
    },
    checkNow() {
      if (options.feedUrl === null || current.kind === 'off' || current.kind === 'ready' || current.kind === 'checking' || current.kind === 'downloading') return;
      try {
        wire(options.feedUrl);
        options.updater.checkForUpdates();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`update check failed: ${message}`);
        set({ kind: 'failed', message });
      }
    },
    restart() {
      if (current.kind !== 'ready') return false;
      options.updater.quitAndInstall();
      return true;
    },
    stop() {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
  return controller;
}
