// SPDX-License-Identifier: AGPL-3.0-only
// The shell's brain: sign-in, sign-out, periodic token/feature checks, reconnect prompts, and "Mở Ludy", over injected I/O
// so it runs in tests without Electron. Keeps bearer tokens confined to configured Ludy URL requests and never imports capture APIs directly.
import { buildConnectUrl } from './connect-url.ts';
import type { DesktopConfig } from './config.ts';
import { ExchangeError, exchangeCode, type FetchLike } from './exchange.ts';
import { startLoopback, type LoopbackListener, type LoopbackOptions } from './loopback.ts';
import { newPkce, type Pkce } from './pkce.ts';
import { fetchPublicConfig } from './server-api.ts';
import { inspectSession } from './session-check.ts';
import type { AuthState, CaptureTrayState, ShellModel } from './tray-model.ts';
import type { SessionStore } from './token-store.ts';
import type { UpdaterController } from './updater.ts';

export const SESSION_CHECK_INTERVAL_MS = 15 * 60 * 1000;

export interface ActiveDesktopSession {
  ludyUrl: string;
  token: string;
  orgSlug: string;
  scopes: readonly string[];
  uploads: 'presigned' | 'direct';
  meetingsEnabled: boolean;
  agendaEnabled: boolean;
}

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
  start(): Promise<void>;
  signIn(): Promise<void>;
  reconnectForCapture(): Promise<void>;
  cancelSignIn(): void;
  signOut(): Promise<void>;
  openLudy(): Promise<void>;
  restartForUpdate(): boolean;
  checkSessionNow(): Promise<void>;
  currentSession(): ActiveDesktopSession | null;
  setCaptureState(patch: Partial<CaptureTrayState>): void;
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

const INITIAL_CAPTURE: CaptureTrayState = {
  enabled: false,
  reconnectNeeded: false,
  agendaEnabled: false,
  phase: 'idle',
  meetingTitle: null,
  elapsedMs: 0,
  detectedApp: null,
  warning: null,
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
  let sessionScopes: string[] = [];
  let uploadsMode: 'presigned' | 'direct' = 'direct';
  let capture: CaptureTrayState = { ...INITIAL_CAPTURE };
  let pending: LoopbackListener | null = null;
  let timer: unknown;
  let unsubscribeUpdater: (() => void) | undefined;

  const model = (): ShellModel => ({
    auth,
    update: updater.state(),
    configProblems: config.problems,
    configured: config.ludyUrl !== null,
    notice,
    capture,
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
    sessionScopes = [];
    capture = { ...INITIAL_CAPTURE };
    await store.clear();
    setAuth({ kind: 'signed-out' }, why);
  }

  async function refreshSession(checkedToken: string): Promise<void> {
    if (config.ludyUrl === null) return;
    const [publicCfg, status] = await Promise.all([
      fetchPublicConfig(deps.fetch, config.ludyUrl),
      inspectSession(deps.fetch, config.ludyUrl, checkedToken),
    ]);
    // The answer belongs to the token that was checked; ignore stale checks after sign-out or switch.
    if (token !== checkedToken) return;
    uploadsMode = publicCfg.uploads;
    if (status.status === 'revoked') {
      log('token refused by the server: signed out');
      await signedOut('Phiên đăng nhập không còn hiệu lực (thiết bị đã bị ngắt kết nối hoặc đã hết hạn), hãy đăng nhập lại');
      return;
    }
    if (status.status === 'valid') {
      sessionScopes = [...status.me.scopes];
      const hasMeetingsScope = status.me.scopes.includes('meetings');
      const hasAgendaScope = status.me.scopes.includes('agenda');
      const meetingsEnabled = publicCfg.meetingsDesktopCapture && status.me.features.meetings && hasMeetingsScope;
      const agendaEnabled = meetingsEnabled && status.me.features.agenda && hasAgendaScope;
      const reconnectNeeded = publicCfg.meetingsDesktopCapture && status.me.features.meetings && !hasMeetingsScope;
      capture = { ...capture, enabled: meetingsEnabled, agendaEnabled, reconnectNeeded };
      if (auth.kind === 'signed-in') {
        auth = { ...auth, online: true };
      }
      emit();
      return;
    }
    if (auth.kind === 'signed-in' && auth.online) {
      setAuth({ ...auth, online: false }, notice);
    }
  }

  async function checkSessionNow(): Promise<void> {
    if (token === null || config.ludyUrl === null || auth.kind !== 'signed-in') return;
    await refreshSession(token);
  }

  async function runAuthFlow(): Promise<void> {
    if (config.ludyUrl === null || auth.kind === 'signing-in') return;
    const ludyUrl = config.ludyUrl;
    const publicCfg = await fetchPublicConfig(deps.fetch, ludyUrl);
    uploadsMode = publicCfg.uploads;
    // Request capture scopes only when the deployment has desktop capture enabled (#4516).
    const requestedScopes = publicCfg.meetingsDesktopCapture ? ['meetings', 'agenda'] : [];
    const pkce = makePkce();
    let listener: LoopbackListener;
    try {
      listener = await loopback({ state: pkce.state });
    } catch {
      setAuth({ kind: 'signed-out' }, SIGN_IN_FAILURES.unexpected ?? null);
      return;
    }
    pending = listener;
    const previousAuth = auth;
    setAuth({ kind: 'signing-in' });
    try {
      await deps.openExternal(
        buildConnectUrl(ludyUrl, {
          challenge: pkce.challenge,
          state: pkce.state,
          redirectUri: listener.redirectUri,
          deviceName: deps.deviceName,
          scopes: requestedScopes,
        }),
      );
    } catch {
      listener.close();
      pending = null;
      setAuth(previousAuth.kind === 'signed-in' ? previousAuth : { kind: 'signed-out' }, SIGN_IN_FAILURES.browser ?? null);
      return;
    }
    const result = await listener.result;
    pending = null;
    if (!('code' in result)) {
      setAuth(
        previousAuth.kind === 'signed-in' && token !== null ? previousAuth : { kind: 'signed-out' },
        result.error === 'closed' ? null : (SIGN_IN_FAILURES[result.error] ?? null),
      );
      return;
    }
    try {
      const done = await exchangeCode(deps.fetch, ludyUrl, result.code, pkce.verifier);
      token = done.token;
      sessionScopes = [...done.scopes];
      const saved = await store.save({
        ludyUrl,
        token: done.token,
        tokenId: done.tokenId,
        orgId: done.orgId,
        orgSlug: result.org,
        scopes: done.scopes,
        expiresAt: done.expiresAt,
      });
      const meetingsEnabled = publicCfg.meetingsDesktopCapture && done.scopes.includes('meetings');
      const agendaEnabled = meetingsEnabled && done.scopes.includes('agenda');
      capture = {
        ...capture,
        enabled: meetingsEnabled,
        agendaEnabled,
        reconnectNeeded: publicCfg.meetingsDesktopCapture && !done.scopes.includes('meetings'),
      };
      setAuth({ kind: 'signed-in', orgSlug: result.org, online: true, persisted: saved === 'persisted' });
    } catch (error) {
      const failure = error instanceof ExchangeError ? error.failure : 'unexpected';
      log(`sign-in failed: ${failure}`);
      setAuth(previousAuth.kind === 'signed-in' && token !== null ? previousAuth : { kind: 'signed-out' }, SIGN_IN_FAILURES[failure] ?? null);
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
          sessionScopes = [...(stored.scopes ?? [])];
          setAuth({ kind: 'signed-in', orgSlug: stored.orgSlug, online: true, persisted: true });
          await refreshSession(stored.token);
        }
      }
      updater.start();
      timer = setTimer(() => void checkSessionNow(), SESSION_CHECK_INTERVAL_MS);
      emit();
    },
    signIn: runAuthFlow,
    reconnectForCapture: runAuthFlow,
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
    currentSession() {
      if (config.ludyUrl === null || token === null || auth.kind !== 'signed-in') return null;
      return {
        ludyUrl: config.ludyUrl,
        token,
        orgSlug: auth.orgSlug,
        scopes: sessionScopes,
        uploads: uploadsMode,
        meetingsEnabled: capture.enabled,
        agendaEnabled: capture.agendaEnabled,
      };
    },
    setCaptureState(patch) {
      capture = { ...capture, ...patch };
      emit();
    },
    stop() {
      pending?.close();
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      unsubscribeUpdater?.();
      updater.stop();
    },
  };
}
