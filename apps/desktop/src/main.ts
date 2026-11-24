// SPDX-License-Identifier: AGPL-3.0-only
// Ludy Desktop's main process (ADR-0055 slices 2 and 3, #4515/#4516): tray shell + Windows per-app meeting capture.
// Loads ONLY local bundled files over privileged ludy-desktop://ui with strict CSP, locks permissions exclusively to the
// internal capture worker window, persists tokens in DPAPI/keychain, and keeps capture logic isolated under src/capture/.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
  type IpcMainEvent,
  type MenuItemConstructorOptions,
} from 'electron';
import { noticeToCopy, type RecordingNoticeLanguage } from './capture/consent.ts';
import { createCaptureController, type CaptureDraft, type ConsentWindowViewState, type PillViewState } from './capture/controller.ts';
import { createDesktopCaptureModule, CAPTURE_UI_SPECS, type ElectronWorkerBridge } from './capture/desktop-capture.ts';
import { createDiskRecordingStore } from './capture/live-sender.ts';
import { installCaptureSessionHandlers } from './capture/session-handlers.ts';
import { isExpectedUiOrigin, resolveUiBundleFile, UI_CSP } from './capture/ui-bundle.ts';
import { listMeetingWindows, resolveHelperExePath } from './capture/windows.ts';
import { deviceNameFor } from './connect-url.ts';
import { loadConfig, parseLudyUrl } from './config.ts';
import { trayIconPng } from './icons.ts';
import { createLogger } from './redact.ts';
import { createShell } from './shell.ts';
import { createSmoke, smokeDirFor, type SmokeCommand } from './smoke.ts';
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
      if (!isExpectedUiOrigin(url, CAPTURE_UI_SPECS.origin)) event.preventDefault();
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
      const resolved = resolveUiBundleFile(uiRoot, request.url);
      if (!resolved || !statSync(resolved.path).isFile()) {
        return new Response('Not found', { status: 404 });
      }
      const res = await net.fetch(pathToFileURL(resolved.path).toString());
      const headers = new Headers(res.headers);
      headers.set('content-type', resolved.mimeType);
      headers.set('content-security-policy', UI_CSP);
      headers.set('x-content-type-options', 'nosniff');
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
  let openingConsent: Promise<void> | null = null;
  let pillWindow: BrowserWindow | null = null;
  let lastConsentView: ConsentWindowViewState | null = null;
  let lastPillView: PillViewState | null = null;
  let allowPillClose = false;

  const ensureConsentWindow = (): Promise<void> => {
    if (openingConsent) return openingConsent;
    const run = (async () => {
      const view = await controller.openConsent();
      lastConsentView = view;
      if (consentWindow && !consentWindow.isDestroyed()) {
        consentWindow.show();
        consentWindow.focus();
        consentWindow.webContents.send('desktop-capture:consent-state', view);
        return;
      }
      const win = new BrowserWindow({
        width: 520,
        height: 700,
        resizable: true,
        minimizable: false,
        maximizable: false,
        autoHideMenuBar: true,
        title: 'Bắt đầu ghi cuộc họp - Ludy Desktop',
        webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      consentWindow = win;
      win.on('closed', () => {
        if (consentWindow === win) consentWindow = null;
        controller.cancelConsent();
      });
      await win.loadURL(`${CAPTURE_UI_SPECS.origin}/consent.html`);
    })();
    openingConsent = run.finally(() => {
      if (openingConsent === run) openingConsent = null;
    });
    return openingConsent;
  };

  const ensurePillWindow = (state: PillViewState) => {
    lastPillView = state;
    if (pillWindow && !pillWindow.isDestroyed()) {
      pillWindow.setSize(360, state.warning ? 112 : 68);
      pillWindow.webContents.send('desktop-capture:pill-update', state);
      return;
    }
    allowPillClose = false;
    pillWindow = new BrowserWindow({
      width: 360,
      height: state.warning ? 112 : 68,
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
      const workerId = win.webContents.id;
      activeWorkerWebContentsId = workerId;
      win.on('closed', () => {
        if (activeWorkerWebContentsId === workerId) activeWorkerWebContentsId = null;
      });
      await win.loadURL(`${CAPTURE_UI_SPECS.origin}/worker.html`);
      return {
        webContentsId: workerId,
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
          if (activeWorkerWebContentsId === workerId) activeWorkerWebContentsId = null;
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
      const handler = (ev: IpcMainEvent, res: { ok: boolean; error?: string; micMissing?: boolean }) => {
        if (activeWorkerWebContentsId === null || ev.sender.id !== activeWorkerWebContentsId) return;
        cb(res);
      };
      ipcMain.on('desktop-capture:worker-ready', handler);
      return () => ipcMain.removeListener('desktop-capture:worker-ready', handler);
    },
    onWorkerStopped(cb) {
      const handler = (ev: IpcMainEvent) => {
        if (activeWorkerWebContentsId === null || ev.sender.id !== activeWorkerWebContentsId) return;
        cb();
      };
      ipcMain.on('desktop-capture:worker-stopped', handler);
      return () => ipcMain.removeListener('desktop-capture:worker-stopped', handler);
    },
    onWorkerChunk(cb) {
      const handler = (ev: IpcMainEvent, chunk: { kind: 'main' | 'live'; seq: number; bytes: ArrayBuffer; mimeType: string; offsetMs: number; durationMs: number }) => {
        if (activeWorkerWebContentsId === null || ev.sender.id !== activeWorkerWebContentsId) return;
        cb(chunk);
      };
      ipcMain.on('desktop-capture:worker-chunk', handler);
      return () => ipcMain.removeListener('desktop-capture:worker-chunk', handler);
    },
    onWorkerLevels(cb) {
      const handler = (ev: IpcMainEvent, levels: { loopbackRms: number; micRms: number }) => {
        if (activeWorkerWebContentsId === null || ev.sender.id !== activeWorkerWebContentsId) return;
        cb(levels);
      };
      ipcMain.on('desktop-capture:worker-levels', handler);
      return () => ipcMain.removeListener('desktop-capture:worker-levels', handler);
    },
    onWorkerEnded(cb) {
      const handler = (ev: IpcMainEvent, reason: 'device_lost' | 'unknown') => {
        if (activeWorkerWebContentsId === null || ev.sender.id !== activeWorkerWebContentsId) return;
        cb(reason);
      };
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
          pillWindow.setSize(360, state.warning ? 112 : 68);
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

  const isConsentSender = (senderId: number): boolean => Boolean(consentWindow && !consentWindow.isDestroyed() && senderId === consentWindow.webContents.id);
  const isPillSender = (senderId: number): boolean => Boolean(pillWindow && !pillWindow.isDestroyed() && senderId === pillWindow.webContents.id);

  ipcMain.handle('desktop-capture:consent-init', (ev) => (isConsentSender(ev.sender.id) ? (lastConsentView ?? controller.openConsent()) : null));
  ipcMain.handle('desktop-capture:refresh-windows', (ev) => (isConsentSender(ev.sender.id) ? controller.refreshWindows() : []));
  ipcMain.handle('desktop-capture:refresh-agenda', (ev) => (isConsentSender(ev.sender.id) ? controller.refreshAgenda() : []));
  ipcMain.handle('desktop-capture:copy-notice', (ev, lang: RecordingNoticeLanguage) => {
    if (!isConsentSender(ev.sender.id)) return;
    clipboard.writeText(noticeToCopy(lang === 'en' ? 'en' : 'vi').text);
  });
  ipcMain.handle('desktop-capture:start', (ev, draft: CaptureDraft) => {
    if (!isConsentSender(ev.sender.id)) return { ok: false, error: 'INVALID_SENDER' };
    if (draft.targetPid !== undefined && (!Number.isInteger(draft.targetPid) || draft.targetPid < 1 || draft.targetPid > 0x7fffffff)) {
      return { ok: false, error: 'Mã tiến trình ứng dụng không hợp lệ.' };
    }
    return controller.startCapture(draft);
  });
  ipcMain.handle('desktop-capture:cancel', (ev) => {
    if (!isConsentSender(ev.sender.id)) return;
    controller.cancelConsent();
  });
  ipcMain.handle('desktop-capture:pill-init', (ev) => (isPillSender(ev.sender.id) ? lastPillView : null));
  ipcMain.handle('desktop-capture:stop', (ev) => (isPillSender(ev.sender.id) ? controller.stopCapture('user') : undefined));

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
  // The Windows smoke channel (#4566): off unless LUDY_DESKTOP_SMOKE_DIR is set AND the Ludy address is a loopback one (src/smoke.ts).
  let secondInstances = 0;
  let lastSpec = describeTray(desktop.model());
  const smokeDir = smokeDirFor(process.env, config.ludyUrl);
  const smoke =
    smokeDir === null
      ? null
      : createSmoke({
          io: {
            writeState: async (json) => {
              const temp = join(smokeDir, 'state.json.tmp');
              await writeFile(temp, json);
              await rename(temp, join(smokeDir, 'state.json'));
            },
            takeCommand: async () => {
              const file = join(smokeDir, 'command.json');
              const text = await readFile(file, 'utf8').catch(() => null);
              if (text !== null) await rm(file, { force: true });
              return text;
            },
          },
          snapshot: () => ({
            pid: process.pid,
            version: app.getVersion(),
            execPath: process.execPath,
            packaged: app.isPackaged,
            squirrelInstalled,
            tray: {
              created: !tray.isDestroyed(),
              icon: lastSpec.icon,
              tooltip: lastSpec.tooltip,
              items: lastSpec.items.flatMap((item) => (item.kind === 'separator' ? [] : [`${item.kind === 'action' ? item.id : 'status'}: ${item.label}`])),
            },
            auth: desktop.model().auth,
            update: desktop.model().update,
            secondInstances,
            updatedAt: new Date().toISOString(),
          }),
          run: (command: SmokeCommand) => {
            // The same functions as the tray menu items.
            if (command === 'check-update') updater.checkNow();
            else actions[command]();
          },
          log,
        });
  const renderAndReport = (): void => {
    lastSpec = describeTray(desktop.model());
    render();
    smoke?.report();
  };
  desktop.subscribe(renderAndReport);
  render();
  smoke?.start();

  const windowPoll = setInterval(() => {
    const sess = desktop.currentSession();
    if (sess?.meetingsEnabled && controller.phase() === 'idle') {
      void controller.refreshWindows();
    }
  }, 10_000);

  tray.on('click', () => tray.popUpContextMenu());
  app.on('second-instance', () => {
    secondInstances += 1;
    smoke?.report();
    tray.popUpContextMenu();
  });
  app.on('before-quit', () => {
    allowPillClose = true;
    if (pillWindow && !pillWindow.isDestroyed()) pillWindow.setClosable(true);
    clearInterval(windowPoll);
    smoke?.stop();
    desktop.stop();
  });

  await desktop.start();
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  app.exit(1);
});
