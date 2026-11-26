// SPDX-License-Identifier: AGPL-3.0-only
// Auto-update with Electron's built-in autoUpdater (Squirrel.Windows), as a small state machine over an injected updater so it runs in
// tests without Electron. The feed is the deployment's own (LUDY_DESKTOP_UPDATE_URL); no URL means updates are off.
//   - Validates and stages signed updates via prepareVerifiedUpdate before handing Squirrel a verified local 127.0.0.1 feed.
//   - Checks at start and every 6 hours, one check at a time.
//   - After staging & signature verification, Squirrel installs from the verified local staging feed; the shell then says
//     "update ready" and restarts only when the member chooses it (the new version also starts the next time the app is opened).
//     quitAndInstall is never called before `update-downloaded`.
//   - A failed check, signature failure, or checksum mismatch leaves the running version untouched and tries again next check.
import { createReadStream, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { FetchLike } from './exchange.ts';
import {
  prepareVerifiedUpdate,
  resolveFeedUrl,
  type DesktopMacArch,
  type DesktopTargetPlatform,
  type HostLookup,
  type SignedManifestVerifier,
  type SignedPackageVerifier,
  type ValidatedUpdateFeed,
} from './update-feed.ts';

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

export interface LocalFeedServer {
  url: string;
  close(): Promise<void>;
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
  // false when the app is not an installed Squirrel.Windows or signed Squirrel.Mac app bundle.
  supported: boolean;
  platform?: DesktopTargetPlatform | undefined;
  arch?: DesktopMacArch | 'x64' | undefined;
  fetch?: FetchLike | undefined;
  allowedOrigin?: string | null | undefined;
  expectedPublisherThumbprint?: string | null | undefined;
  expectedTeamId?: string | null | undefined;
  expectedManifestPublicKey?: string | null | undefined;
  requireSigned?: boolean | undefined;
  allowUnsigned?: boolean | undefined;
  lookupHost?: HostLookup | undefined;
  currentVersion?: string | null | undefined;
  stagingDir?: string | undefined;
  resolveTrustedThumbprint?: (() => Promise<string | null>) | undefined;
  resolveTrustedTeamId?: (() => Promise<string | null>) | undefined;
  verifySignedManifest?: SignedManifestVerifier | undefined;
  verifySignedPackage?: SignedPackageVerifier | undefined;
  serveLocalFeed?: ((stagingDir: string, packageFile: string) => Promise<LocalFeedServer>) | undefined;
  validateFeed?: ((feedUrl: string) => Promise<ValidatedUpdateFeed | void>) | undefined;
  setInterval?: ((callback: () => void, ms: number) => unknown) | undefined;
  clearInterval?: ((handle: unknown) => void) | undefined;
  log?: ((message: string) => void) | undefined;
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

async function startLocalFeedServer(
  stagingDir: string,
  packageFile: string,
  meta: { platform?: DesktopTargetPlatform; version?: string; sha256?: string; size?: number } = {},
): Promise<LocalFeedServer> {
  const releasesPath = join(stagingDir, 'RELEASES');
  const packagePath = join(stagingDir, packageFile);
  const encodedPkgPath = `/${encodeURIComponent(packageFile)}`;
  const rawPkgPath = `/${packageFile}`;
  const isDarwin = meta.platform === 'darwin';
  let boundPort = 0;

  const server: Server = createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (isDarwin && pathname === '/feed.json') {
      const feedBody = Buffer.from(
        JSON.stringify({
          url: `http://127.0.0.1:${boundPort}${encodedPkgPath}`,
          name: meta.version ?? '',
          ...(meta.sha256 ? { sha256: meta.sha256 } : {}),
          ...(meta.size !== undefined ? { size: meta.size } : {}),
        }),
        'utf8',
      );
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(feedBody.byteLength) });
      if (req.method === 'HEAD') res.end();
      else res.end(feedBody);
      return;
    }
    if (!isDarwin && pathname === '/RELEASES') {
      try {
        const body = readFileSync(releasesPath);
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(body.byteLength) });
        if (req.method === 'HEAD') res.end();
        else res.end(body);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    if (pathname === rawPkgPath || pathname === encodedPkgPath) {
      try {
        const stats = statSync(packagePath);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(stats.size) });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = createReadStream(packagePath);
        res.on('close', () => {
          if (!res.writableEnded) stream.destroy();
        });
        stream.on('error', () => {
          if (!res.headersSent) res.writeHead(500);
          res.destroy();
        });
        stream.pipe(res);
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('Failed binding local update feed server to 127.0.0.1');
  }
  boundPort = addr.port;
  return {
    url: isDarwin ? `http://127.0.0.1:${addr.port}/feed.json` : `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function createUpdater(options: UpdaterOptions): UpdaterController {
  const log = options.log ?? (() => undefined);
  const setTimer = options.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearTimer = options.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const listeners = new Set<(state: UpdateState) => void>();
  let current: UpdateState = !options.supported ? { kind: 'off', reason: 'unsupported' } : options.feedUrl === null ? { kind: 'off', reason: 'no-feed' } : { kind: 'idle' };
  let timer: unknown;
  let subscribed = false;
  let lastFeedUrl: string | null = null;
  let localFeedServer: LocalFeedServer | null = null;
  let stopped = false;

  const set = (next: UpdateState): void => {
    current = next;
    for (const listener of listeners) listener(next);
  };

  const closeLocalFeed = async (removeStaging = false): Promise<void> => {
    const active = localFeedServer;
    localFeedServer = null;
    if (active) {
      await active.close().catch(() => undefined);
    }
    if (removeStaging && options.stagingDir) {
      try {
        rmSync(options.stagingDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        log(`failed cleaning update staging directory: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      }
    }
  };

  const wire = (feedUrl: string): void => {
    if (!subscribed) {
      subscribed = true;
      options.updater.subscribe({
        checking: () => {
          if (current.kind !== 'ready' && current.kind !== 'checking') set({ kind: 'checking' });
        },
        available: () => {
          if (current.kind !== 'ready') set({ kind: 'downloading' });
        },
        notAvailable: () => {
          void closeLocalFeed(true);
          if (current.kind !== 'ready') set({ kind: 'idle' });
        },
        downloaded: (version) => {
          void closeLocalFeed(true);
          set({ kind: 'ready', version });
        },
        error: (message) => {
          void closeLocalFeed(true);
          log(`update failed: ${message}`);
          // A downloaded update stays ready; anything else reports and waits for the next check. The running version is untouched either way.
          if (current.kind !== 'ready') set({ kind: 'failed', message });
        },
      });
    }
    if (lastFeedUrl !== feedUrl) {
      lastFeedUrl = feedUrl;
      options.updater.setFeedURL(feedUrl);
    }
  };

  const isHalted = (): boolean => stopped || current.kind === 'ready' || current.kind === 'off';

  const runPreflightAndCheck = async (feedUrl: string): Promise<void> => {
    try {
      let targetFeedUrl = feedUrl;
      if (options.validateFeed) {
        await options.validateFeed(feedUrl);
      } else if (options.fetch && options.stagingDir) {
        const prepared = await prepareVerifiedUpdate({
          feedUrl,
          platform: options.platform,
          arch: options.arch,
          fetch: options.fetch,
          allowedOrigin: options.allowedOrigin ?? null,
          requireSigned: options.requireSigned,
          allowUnsigned: options.allowUnsigned,
          expectedPublisherThumbprint: options.expectedPublisherThumbprint ?? null,
          expectedTeamId: options.expectedTeamId ?? null,
          expectedManifestPublicKey: options.expectedManifestPublicKey ?? null,
          lookupHost: options.lookupHost,
          currentVersion: options.currentVersion ?? null,
          stagingDir: options.stagingDir,
          resolveTrustedThumbprint: options.resolveTrustedThumbprint,
          resolveTrustedTeamId: options.resolveTrustedTeamId,
          verifySignedManifest: options.verifySignedManifest,
          verifySignedPackage: options.verifySignedPackage,
        });
        if (isHalted()) {
          await closeLocalFeed(true);
          return;
        }
        if (prepared.status === 'up-to-date') {
          await closeLocalFeed(true);
          set({ kind: 'idle' });
          return;
        }
        await closeLocalFeed(false);
        const server = await (options.serveLocalFeed
          ? options.serveLocalFeed(prepared.stagingDir, prepared.packageFile)
          : startLocalFeedServer(prepared.stagingDir, prepared.packageFile, {
              platform: options.platform ?? 'win32',
              version: prepared.version,
              sha256: prepared.sha256,
              size: prepared.size,
            }));
        if (isHalted()) {
          await server.close().catch(() => undefined);
          try {
            rmSync(options.stagingDir, { recursive: true, force: true });
          } catch (cleanupErr) {
            log(`failed cleaning update staging directory: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
          }
          return;
        }
        localFeedServer = server;
        targetFeedUrl = server.url;
      } else if (options.fetch) {
        throw new Error('Update staging directory is required when feed verification fetch is enabled');
      }
      if (isHalted()) {
        await closeLocalFeed(true);
        return;
      }
      wire(targetFeedUrl);
      options.updater.checkForUpdates();
    } catch (error) {
      await closeLocalFeed(true);
      if (isHalted()) return;
      const message = error instanceof Error ? error.message : String(error);
      log(`update check failed: ${message}`);
      set({ kind: 'failed', message });
    }
  };

  const controller: UpdaterController = {
    state: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (current.kind === 'off' || timer !== undefined) return;
      stopped = false;
      controller.checkNow();
      timer = setTimer(() => controller.checkNow(), CHECK_INTERVAL_MS);
    },
    checkNow() {
      if (options.feedUrl === null || current.kind === 'off' || current.kind === 'ready' || current.kind === 'checking' || current.kind === 'downloading') return;
      const checked = resolveFeedUrl(options.feedUrl, options.allowedOrigin ? { allowedOrigin: options.allowedOrigin } : {});
      if (!checked.ok) {
        log(`update check rejected: ${checked.reason}`);
        set({ kind: 'failed', message: checked.reason });
        return;
      }
      if (options.validateFeed || options.fetch) {
        stopped = false;
        set({ kind: 'checking' });
        void runPreflightAndCheck(checked.url);
        return;
      }
      try {
        wire(checked.url);
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
      stopped = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      void closeLocalFeed(true);
    },
  };
  return controller;
}
