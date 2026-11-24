// SPDX-License-Identifier: AGPL-3.0-only
// Ludy Desktop's main process (ADR-0055 slices 2 and 3, #4515/#4516): tray shell + Windows per-app meeting capture.
// Loads ONLY local bundled files over privileged ludy-desktop://ui with strict CSP, locks permissions exclusively to the
// internal capture worker window, persists tokens in DPAPI/keychain, and keeps capture logic isolated under src/capture/.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  safeStorage,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import { noticeToCopy, type RecordingNoticeLanguage } from './capture/consent.ts';
import { createCaptureController, type CaptureDraft, type ConsentWindowViewState, type PillViewState } from './capture/controller.ts';
import { createDesktopCaptureModule, CAPTURE_UI_SPECS, type ElectronWorkerBridge } from './capture/desktop-capture.ts';
import { createDiskRecordingStore } from './capture/live-sender.ts';
import { installCaptureSessionHandlers } from './capture/session-handlers.ts';
import { listMeetingWindows, resolveHelperExePath } from './capture/windows.ts';
import { deviceNameFor } from './connect-url.ts';
import { loadConfig, parseLudyUrl } from './config.ts';
import { trayIconPng } from './icons.ts';
import { createLogger } from './redact.ts';
import { createShell } from './shell.ts';
import { handleSquirrelStartup } from './squirrel.ts';
import { createSessionStore, type FileIO, type SecretBox } from './token-store.ts';
import { describeTray, type TrayIcon, type TrayItem } from './tray-model.ts';
import { createUpdater, type AutoUpdaterLike } from './updater.ts';

const log = createLogger((line) => console.log(`[ludy-desktop] ${line}`));

// Register secure standard scheme before app.ready so ES modules and AudioWorklet run inside locked-down local UI windows.
protocol.registerSchemesAsPrivileged([
  { scheme: 'ludy-desktop', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// The user data folder is fixed (%APPDATA%\\ludy-desktop on Windows), not derived from the product name, so the docs can name it.
// LUDY_DESKTOP_USER_DATA is a throwaway profile for the CI smoke run and for tests: it never reads or writes a member's real one.
app.setPath('userData', process.env.LUDY_DESKTOP_USER_DATA ? resolve(process.env.LUDY_DESKTOP_USER_DATA) : join(app.getPath('appData'), 'ludy-desktop'));

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

async function main(): Promise<void> {
  // Squirrel.Windows runs the app with a flag at install, update and uninstall: make or remove the shortcuts, then quit.
  const hookOnly = await handleSquirrelStartup(process.argv, {
    platform: process.platform,
    execPath: process.execPath,
    runUpdate: (updateExe, args) =>
      new Promise<void>((done) => {
        const child = spawn(updateExe, args, { detached: true, stdio: 'ignore' });
        child.once('error', () => done());
        child.once('close', () => done());
      }),
  });
  if (hookOnly) return app.quit();
  if (!app.requestSingleInstanceLock()) return app.quit();

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${CAPTURE_UI_SPECS.origin}/`)) event.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  app.on('window-all-closed', () => undefined);
  await app.whenReady();

  const distDir = fileURLToPath(new URL('.', import.meta.url));
  const uiRoot = resolve(distDir, 'capture', 'ui');
  const preloadPath = resolve(distDir, 'capture', 'preload.cjs');

  session.defaultSession.protocol.handle('ludy-desktop', async (request) => {
    try {
      const parsed = new URL(request.url);
      if (parsed.hostname !== 'ui') return new Response('Not found', { status: 404 });
      const cleanRel = normalize(parsed.pathname.replace(/^\/+/, ''));
      const fullPath = resolve(uiRoot, cleanRel);
      if (!fullPath.startsWith(uiRoot) || !existsSync(fullPath)) {
        return new Response('Not found', { status: 404 });
      }
      const res = await net.fetch(pathToFileURL(fullPath).toString());
      const headers = new Headers(res.headers);
      headers.set('content-type', MIME_BY_EXT[extname(fullPath)] ?? 'application/octet-stream');
      headers.set('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'none'; img-src 'none'; object-src 'none'; frame-ancestors 'none'");
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  let activeWorkerWebContentsId: number | null = null;
  let systemFallbackArmed = false;

  installCaptureSessionHandlers(session.defaultSession, CAPTURE_UI_SPECS.origin, {
    getActiveWorkerId: () => activeWorkerWebContentsId,
    consumeSystemFallbackArmed: () => {
      if (!systemFallbackArmed) return false;
      systemFallbackArmed = false;
      return true;
    },
  });

  const userData = app.getPath('userData');
  const configFile = await readFile(join(userData, 'config.json'), 'utf8').catch(() => null);
  const config = loadConfig({ env: process.env, configFile });
  for (const problem of config.problems) log(problem);

  const box: SecretBox = {
    isAvailable: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (blob) => safeStorage.decryptString(Buffer.from(blob)),
  };
  const sessionFile = join(userData, 'session.bin');
  const io: FileIO = {
    read: (path) => readFile(path).catch(() => null),
    write: async (path, data) => {
      const temp = `${path}.tmp`;
      await writeFile(temp, data, { mode: 0o600 });
      await chmod(temp, 0o600).catch(() => undefined);
      await rename(temp, path);
    },
    remove: (path) => rm(path, { force: true }),
  };

  const squirrelInstalled = process.platform === 'win32' && app.isPackaged && existsSync(resolve(dirname(process.execPath), '..', 'Update.exe'));
  const updaterAdapter: AutoUpdaterLike = {
    setFeedURL: (url) => autoUpdater.setFeedURL({ url }),
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    quitAndInstall: () => autoUpdater.quitAndInstall(),
    subscribe(events) {
      autoUpdater.on('checking-for-update', () => events.checking());
      autoUpdater.on('update-available', () => events.available());
      autoUpdater.on('update-not-available', () => events.notAvailable());
      autoUpdater.on('update-downloaded', (_event, _notes, name) => events.downloaded(name || null));
      autoUpdater.on('error', (error) => events.error(error.message));
    },
  };
  const updater = createUpdater({ updater: updaterAdapter, feedUrl: config.updateUrl, supported: squirrelInstalled, log });

  const desktop = createShell({
    config,
    store: createSessionStore({ file: sessionFile, box, io }),
    updater,
    fetch: globalThis.fetch,
    openExternal: async (url) => {
      const target = new URL(url);
      const allowed = config.ludyUrl !== null && target.origin === config.ludyUrl && parseLudyUrl(config.ludyUrl).ok;
      if (!allowed) throw new Error('address is not the configured Ludy address');
      await shell.openExternal(target.toString());
    },
    deviceName: deviceNameFor(hostname()),
    log,
  });

  let consentWindow: BrowserWindow | null = null;
  let pillWindow: BrowserWindow | null = null;
  let lastConsentView: ConsentWindowViewState | null = null;
  let lastPillView: PillViewState | null = null;
  let allowPillClose = false;

  const ensureConsentWindow = async () => {
    const view = await controller.openConsent();
    lastConsentView = view;
    if (consentWindow && !consentWindow.isDestroyed()) {
      consentWindow.show();
      consentWindow.focus();
      consentWindow.webContents.send('desktop-capture:consent-state', view);
      return;
    }
    consentWindow = new BrowserWindow({
      width: 520,
      height: 700,
      resizable: true,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      title: 'Bắt đầu ghi cuộc họp - Ludy Desktop',
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    consentWindow.on('closed', () => {
      consentWindow = null;
      controller.cancelConsent();
    });
    await consentWindow.loadURL(`${CAPTURE_UI_SPECS.origin}/consent.html`);
  };

  const ensurePillWindow = (state: PillViewState) => {
    lastPillView = state;
    if (pillWindow && !pillWindow.isDestroyed()) {
      pillWindow.webContents.send('desktop-capture:pill-update', state);
      return;
    }
    allowPillClose = false;
    pillWindow = new BrowserWindow({
      width: 360,
      height: state.warning ? 96 : 68,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      closable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      autoHideMenuBar: true,
      title: 'Ludy Desktop đang ghi âm',
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    pillWindow.on('close', (e) => {
      if (!allowPillClose) e.preventDefault();
    });
    pillWindow.on('closed', () => {
      pillWindow = null;
    });
    void pillWindow.loadURL(`${CAPTURE_UI_SPECS.origin}/pill.html`);
  };

  const workerBridge: ElectronWorkerBridge = {
    async openWorkerWindow() {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      activeWorkerWebContentsId = win.webContents.id;
      await win.loadURL(`${CAPTURE_UI_SPECS.origin}/worker.html`);
      return {
        webContentsId: win.webContents.id,
        sendStart: (cfg) => {
          if (!win.isDestroyed()) win.webContents.send('desktop-capture:worker-start', cfg);
        },
        sendStop: () => {
          if (!win.isDestroyed()) win.webContents.send('desktop-capture:worker-stop');
        },
        sendPcm: (buf) => {
          if (!win.isDestroyed()) win.webContents.send('desktop-capture:worker-pcm', buf);
        },
        close: () => {
          if (activeWorkerWebContentsId === win.webContents.id) activeWorkerWebContentsId = null;
          if (!win.isDestroyed()) win.destroy();
        },
      };
    },
    armSystemFallback() {
      systemFallbackArmed = true;
    },
    disarmSystemFallback() {
      systemFallbackArmed = false;
    },
    onWorkerReady(cb) {
      const handler = (_ev: unknown, res: { ok: boolean; error?: string; micMissing?: boolean }) => cb(res);
      ipcMain.on('desktop-capture:worker-ready', handler);
      return () => ipcMain.removeListener('desktop-capture:worker-ready', handler);
    },
    onWorkerStopped(cb) {
      const handler = () => cb();
      ipcMain.on('desktop-capture:worker-stopped', handler);
      return () => ipcMain.removeListener('desktop-capture:worker-stopped', handler);
    },
    onWorkerChunk(cb) {
      const handler = (_ev: unknown, chunk: { kind: 'main' | 'live'; seq: number; bytes: ArrayBuffer; mimeType: string; offsetMs: number; durationMs: number }) => cb(chunk);
      ipcMain.on('desktop-capture:worker-chunk', handler);
      return () => ipcMain.removeListener('desktop-capture:worker-chunk', handler);
    },
    onWorkerLevels(cb) {
      const handler = (_ev: unknown, levels: { loopbackRms: number; micRms: number }) => cb(levels);
      ipcMain.on('desktop-capture:worker-levels', handler);
      return () => ipcMain.removeListener('desktop-capture:worker-levels', handler);
    },
    onWorkerEnded(cb) {
      const handler = (_ev: unknown, reason: 'device_lost' | 'unknown') => cb(reason);
      ipcMain.on('desktop-capture:worker-ended', handler);
      return () => ipcMain.removeListener('desktop-capture:worker-ended', handler);
    },
  };

  const captureModule = createDesktopCaptureModule({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    bridge: workerBridge,
    log,
  });

  const helperExe = resolveHelperExePath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const controller = createCaptureController({
    capture: captureModule,
    recordingStore: createDiskRecordingStore(userData),
    fetch: globalThis.fetch,
    listWindows: () => listMeetingWindows({ exePath: helperExe }),
    getSession: () => desktop.currentSession(),
    onTrayState: (patch) => desktop.setCaptureState(patch),
    ui: {
      updateConsentState(state) {
        lastConsentView = state;
        if (consentWindow && !consentWindow.isDestroyed()) consentWindow.webContents.send('desktop-capture:consent-state', state);
      },
      showPill: ensurePillWindow,
      updatePill(state) {
        lastPillView = state;
        if (pillWindow && !pillWindow.isDestroyed()) {
          if (state.warning) pillWindow.setSize(360, 96);
          pillWindow.webContents.send('desktop-capture:pill-update', state);
        }
      },
      hidePill() {
        lastPillView = null;
        if (pillWindow && !pillWindow.isDestroyed()) {
          allowPillClose = true;
          pillWindow.setClosable(true);
          pillWindow.close();
        }
      },
      closeConsent() {
        if (consentWindow && !consentWindow.isDestroyed()) consentWindow.close();
      },
    },
    log,
  });

  ipcMain.handle('desktop-capture:consent-init', () => lastConsentView ?? controller.openConsent());
  ipcMain.handle('desktop-capture:refresh-windows', () => controller.refreshWindows());
  ipcMain.handle('desktop-capture:refresh-agenda', () => controller.refreshAgenda());
  ipcMain.handle('desktop-capture:copy-notice', (_ev, lang: RecordingNoticeLanguage) => {
    clipboard.writeText(noticeToCopy(lang === 'en' ? 'en' : 'vi').text);
  });
  ipcMain.handle('desktop-capture:start', (_ev, draft: CaptureDraft) => controller.startCapture(draft));
  ipcMain.handle('desktop-capture:cancel', () => controller.cancelConsent());
  ipcMain.handle('desktop-capture:pill-init', () => lastPillView);
  ipcMain.handle('desktop-capture:stop', () => controller.stopCapture('user'));

  const icons = new Map<TrayIcon, Electron.NativeImage>();
  const iconFor = (kind: TrayIcon): Electron.NativeImage => {
    let image = icons.get(kind);
    if (!image) {
      image = nativeImage.createFromBuffer(trayIconPng(kind, 32), { scaleFactor: 2 });
      icons.set(kind, image);
    }
    return image;
  };

  const tray = new Tray(iconFor('signed-out'));
  const actions: Record<Extract<TrayItem, { kind: 'action' }>['id'], () => void> = {
    open: () => void desktop.openLudy(),
    'sign-in': () => void desktop.signIn(),
    'cancel-sign-in': () => desktop.cancelSignIn(),
    'sign-out': () => void desktop.signOut(),
    record: () => void ensureConsentWindow(),
    'stop-record': () => void controller.stopCapture('user'),
    'reconnect-capture': () => void desktop.reconnectForCapture(),
    restart: () => void desktop.restartForUpdate(),
    quit: () => {
      void controller.stopCapture('user').finally(() => app.quit());
    },
  };
  const render = (): void => {
    const spec = describeTray(desktop.model());
    tray.setImage(iconFor(spec.icon));
    tray.setToolTip(spec.tooltip);
    const template: MenuItemConstructorOptions[] = spec.items.map((item) => {
      if (item.kind === 'separator') return { type: 'separator' };
      if (item.kind === 'status') return { label: item.label, enabled: false };
      return { label: item.label, enabled: item.enabled, click: actions[item.id] };
    });
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };
  desktop.subscribe(render);
  render();

  const windowPoll = setInterval(() => {
    const sess = desktop.currentSession();
    if (sess?.meetingsEnabled && controller.phase() === 'idle') {
      void controller.refreshWindows();
    }
  }, 10_000);

  tray.on('click', () => tray.popUpContextMenu());
  app.on('second-instance', () => tray.popUpContextMenu());
  app.on('before-quit', () => {
    clearInterval(windowPoll);
    desktop.stop();
  });

  await desktop.start();
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  app.exit(1);
});
