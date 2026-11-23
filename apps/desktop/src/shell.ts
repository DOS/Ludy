// SPDX-License-Identifier: AGPL-3.0-only
// The shell's brain: sign-in, sign-out, the token check, and "Mở Ludy", over injected I/O so it runs in tests without Electron.
// It never sends the token anywhere but `<ludyUrl>/api/extension/me`, and signs out the moment the server says the token is revoked.
import { buildConnectUrl } from './connect-url.ts';
import type { DesktopConfig } from './config.ts';
import { ExchangeError, exchangeCode, type FetchLike } from './exchange.ts';
import { startLoopback, type LoopbackListener, type LoopbackOptions } from './loopback.ts';
import { newPkce, type Pkce } from './pkce.ts';
import { checkSession } from './session-check.ts';
import type { AuthState, ShellModel } from './tray-model.ts';
import type { SessionStore } from './token-store.ts';
import type { UpdaterController } from './updater.ts';

export const SESSION_CHECK_INTERVAL_MS = 15 * 60 * 1000;

export interface ShellDeps {
  config: DesktopConfig;
  store: SessionStore;
  updater: UpdaterController;
  fetch: FetchLike;
  // Opens an address in the system browser. Only ever called with the configured Ludy origin.
  openExternal(url: string): Promise<void>;
  deviceName: string;
  startLoopback?: (options: LoopbackOptions) => Promise<LoopbackListener>;
  newPkce?: () => Pkce;
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (message: string) => void;
}

export interface Shell {
  model(): ShellModel;
  subscribe(listener: (model: ShellModel) => void): () => void;
  // Loads the stored session, checks it, starts the update checks and the periodic token check.
  start(): Promise<void>;
  signIn(): Promise<void>;
  cancelSignIn(): void;
  signOut(): Promise<void>;
  openLudy(): Promise<void>;
  restartForUpdate(): boolean;
  checkSessionNow(): Promise<void>;
  stop(): void;
}

const SIGN_IN_FAILURES: Record<string, string> = {
  access_denied: 'Bạn đã từ chối đăng nhập',
  invalid: 'Đăng nhập không hợp lệ, hãy thử lại',
  timeout: 'Hết thời gian chờ đăng nhập, hãy thử lại',
  invalid_code: 'Mã đăng nhập không hợp lệ hoặc đã hết hạn, hãy thử lại',
  rate_limited: 'Thử quá nhiều lần, hãy chờ một chút',
  unreachable: 'Không kết nối được máy chủ Ludy',
  unexpected: 'Máy chủ Ludy trả lời không như mong đợi',
  browser: 'Không mở được trình duyệt',
};

export function createShell(deps: ShellDeps): Shell {
  const { config, store, updater } = deps;
  const log = deps.log ?? (() => undefined);
  const listeners = new Set<(model: ShellModel) => void>();
  const loopback = deps.startLoopback ?? startLoopback;
  const makePkce = deps.newPkce ?? newPkce;
  const setTimer = deps.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearTimer = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  let auth: AuthState = { kind: 'signed-out' };
  let notice: string | null = null;
  let token: string | null = null;
  let pending: LoopbackListener | null = null;
  let timer: unknown;
  let unsubscribeUpdater: (() => void) | undefined;

  const model = (): ShellModel => ({
    auth,
    update: updater.state(),
    configProblems: config.problems,
    configured: config.ludyUrl !== null,
    notice,
  });
  const emit = (): void => {
    const snapshot = model();
    for (const listener of listeners) listener(snapshot);
  };
  const setAuth = (next: AuthState, nextNotice: string | null = null): void => {
    auth = next;
    notice = nextNotice;
    emit();
  };

  async function signedOut(why: string | null): Promise<void> {
    token = null;
    await store.clear();
    setAuth({ kind: 'signed-out' }, why);
  }

  async function checkSessionNow(): Promise<void> {
    if (token === null || config.ludyUrl === null || auth.kind !== 'signed-in') return;
    const checked = token;
    const status = await checkSession(deps.fetch, config.ludyUrl, checked);
    // The answer is about the token that was asked: if the member signed out and in again meanwhile, it says nothing of the new one.
    if (token !== checked) return;
    if (status === 'revoked') {
      log('token refused by the server: signed out');
      await signedOut('Phiên đăng nhập không còn hiệu lực (thiết bị đã bị ngắt kết nối hoặc đã hết hạn), hãy đăng nhập lại');
    } else if (auth.kind === 'signed-in') {
      const online = status === 'valid';
      if (online !== auth.online) setAuth({ ...auth, online }, notice);
    }
  }

  async function signIn(): Promise<void> {
    if (config.ludyUrl === null || auth.kind === 'signing-in') return;
    const ludyUrl = config.ludyUrl;
    const pkce = makePkce();
    let listener: LoopbackListener;
    try {
      listener = await loopback({ state: pkce.state });
    } catch {
      setAuth({ kind: 'signed-out' }, SIGN_IN_FAILURES.unexpected ?? null);
      return;
    }
    pending = listener;
    setAuth({ kind: 'signing-in' });
    try {
      await deps.openExternal(buildConnectUrl(ludyUrl, { challenge: pkce.challenge, state: pkce.state, redirectUri: listener.redirectUri, deviceName: deps.deviceName }));
    } catch {
      listener.close();
      pending = null;
      setAuth({ kind: 'signed-out' }, SIGN_IN_FAILURES.browser ?? null);
      return;
    }
    const result = await listener.result;
    pending = null;
    if (!('code' in result)) {
      // Cancelled by the member: no message.
      setAuth({ kind: 'signed-out' }, result.error === 'closed' ? null : (SIGN_IN_FAILURES[result.error] ?? null));
      return;
    }
    try {
      const done = await exchangeCode(deps.fetch, ludyUrl, result.code, pkce.verifier);
      token = done.token;
      const saved = await store.save({ ludyUrl, token: done.token, tokenId: done.tokenId, orgId: done.orgId, orgSlug: result.org, expiresAt: done.expiresAt });
      setAuth({ kind: 'signed-in', orgSlug: result.org, online: true, persisted: saved === 'persisted' });
    } catch (error) {
      const failure = error instanceof ExchangeError ? error.failure : 'unexpected';
      log(`sign-in failed: ${failure}`);
      setAuth({ kind: 'signed-out' }, SIGN_IN_FAILURES[failure] ?? null);
    }
  }

  return {
    model,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start() {
      unsubscribeUpdater = updater.subscribe(emit);
      if (config.ludyUrl !== null) {
        const stored = await store.load(config.ludyUrl).catch(() => null);
        if (stored !== null) {
          token = stored.token;
          setAuth({ kind: 'signed-in', orgSlug: stored.orgSlug, online: true, persisted: true });
          await checkSessionNow();
        }
      }
      updater.start();
      timer = setTimer(() => void checkSessionNow(), SESSION_CHECK_INTERVAL_MS);
      emit();
    },
    signIn,
    cancelSignIn() {
      pending?.close();
    },
    async signOut() {
      pending?.close();
      await signedOut(null);
    },
    async openLudy() {
      if (config.ludyUrl === null) return;
      await deps.openExternal(config.ludyUrl).catch(() => setAuth(auth, SIGN_IN_FAILURES.browser ?? null));
    },
    restartForUpdate: () => updater.restart(),
    checkSessionNow,
    stop() {
      pending?.close();
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      unsubscribeUpdater?.();
      updater.stop();
    },
  };
}
