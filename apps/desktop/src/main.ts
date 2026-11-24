// SPDX-License-Identifier: AGPL-3.0-only
// Ludy Desktop's main process (ADR-0055 slice 2, issue #4515): a tray-only shell. It opens no window and loads no remote content:
// "Mở Ludy" and the sign-in page open in the member's own browser. It reaches the network only for the sign-in exchange, the token
// check and the update feed. Nothing here records or opens the microphone (the capture module is a stub, see capture/).
// This file is the thin Electron glue; everything with logic lives in the modules it wires, which are tested without Electron.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { app, autoUpdater, Menu, nativeImage, safeStorage, session, shell, Tray, type MenuItemConstructorOptions } from 'electron';
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

  // No window of any kind, so nothing needs these, but any web contents that ever appears is locked down.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  // A tray app stays alive without windows.
  app.on('window-all-closed', () => undefined);
  await app.whenReady();
  // Every permission is refused (microphone, camera, screen and the rest): this shell asks for none.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const userData = app.getPath('userData');
  const configFile = await readFile(join(userData, 'config.json'), 'utf8').catch(() => null);
  const config = loadConfig({ env: process.env, configFile });
  for (const problem of config.problems) log(problem);

  const box: SecretBox = {
    // On Linux Electron falls back to a plain-text "basic_text" store when no keyring exists; that is not an OS key store.
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

  // The built-in autoUpdater needs the Squirrel.Windows install (Update.exe one folder above the app's).
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
    // Node's fetch, not Chromium's: it sends no Origin header, which is what the server expects of a desktop client.
    fetch: globalThis.fetch,
    openExternal: async (url) => {
      // Only the configured Ludy origin is ever opened (the sign-in address and "Mở Ludy"): never an address from anywhere else.
      const target = new URL(url);
      const allowed = config.ludyUrl !== null && target.origin === config.ludyUrl && parseLudyUrl(config.ludyUrl).ok;
      if (!allowed) throw new Error('address is not the configured Ludy address');
      await shell.openExternal(target.toString());
    },
    deviceName: deviceNameFor(hostname()),
    log,
  });

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
    restart: () => void desktop.restartForUpdate(),
    quit: () => app.quit(),
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
  // A click (or Enter on the focused icon) opens the same menu as the right click, so the whole shell is reachable by keyboard
  // (Win+B to the notification area, arrow to the icon, Enter or the Menu key).
  tray.on('click', () => tray.popUpContextMenu());
  // Starting the app a second time shows the menu of the running one.
  app.on('second-instance', () => tray.popUpContextMenu());
  app.on('before-quit', () => desktop.stop());

  await desktop.start();
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
  app.exit(1);
});
