// SPDX-License-Identifier: AGPL-3.0-only
// The loopback address the sign-in page sends the browser back to (RFC 8252 section 7.3). A listener on 127.0.0.1 and an OS-chosen
// port, alive for one sign-in only: it answers GET /ludy-desktop/callback with the right state once, then closes; every other path,
// method, Host or state is refused and does not end the wait. The code it receives is worth nothing without the PKCE verifier.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const CALLBACK_PATH = '/ludy-desktop/callback';
export const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

const CODE_FORMAT = /^crc_[A-Za-z0-9_-]{43}$/;
const ORG_FORMAT = /^[A-Za-z0-9_-]{1,100}$/;

export type CallbackResult = { code: string; org: string } | { error: 'access_denied' | 'invalid' | 'timeout' | 'closed' };

export interface LoopbackListener {
  redirectUri: string;
  result: Promise<CallbackResult>;
  // Ends the wait early (the member cancelled); the result is {error: 'closed'}.
  close(): void;
}

export interface LoopbackOptions {
  state: string;
  timeoutMs?: number;
  host?: string;
  // Replaceable in tests.
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const equal = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const PAGES = {
  ok: ['Đã đăng nhập Ludy Desktop', 'Bạn có thể đóng thẻ này và quay lại Ludy Desktop.'],
  denied: ['Đã từ chối', 'Ludy Desktop chưa được kết nối. Bạn có thể đóng thẻ này.'],
  invalid: ['Yêu cầu không hợp lệ', 'Hãy đăng nhập lại từ biểu tượng Ludy Desktop.'],
} as const;

function reply(res: ServerResponse, status: number, page: keyof typeof PAGES): void {
  const [title, text] = PAGES[page];
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    connection: 'close',
  });
  res.end(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${title}</title><body><h1>${title}</h1><p>${text}</p></body></html>`);
}

export async function startLoopback(options: LoopbackOptions): Promise<LoopbackListener> {
  const host = options.host ?? '127.0.0.1';
  const setTimer = options.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let settle: (value: CallbackResult) => void = () => {};
  const result = new Promise<CallbackResult>((resolve) => {
    settle = resolve;
  });
  let done = false;
  let timer: unknown;
  let port = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The Host header must be the loopback address and port we gave out, so a page that rebinds a name to 127.0.0.1 cannot reach this.
    if (done || req.headers.host !== `${host}:${port}`) return reply(res, 400, 'invalid');
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) return reply(res, 404, 'invalid');
    const state = url.searchParams.get('state') ?? '';
    if (!equal(state, options.state)) return reply(res, 400, 'invalid');
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code') ?? '';
    const org = url.searchParams.get('org') ?? '';
    if (error !== null) {
      reply(res, 200, 'denied');
      finish({ error: error === 'access_denied' ? 'access_denied' : 'invalid' });
      return;
    }
    if (!CODE_FORMAT.test(code) || !ORG_FORMAT.test(org)) return reply(res, 400, 'invalid');
    reply(res, 200, 'ok');
    finish({ code, org });
  });

  function finish(value: CallbackResult): void {
    if (done) return;
    done = true;
    clearTimer(timer);
    settle(value);
    // The page is sent before the listener goes: close() lets the open response finish, then the sockets are dropped.
    server.close();
    setImmediate(() => server.closeAllConnections());
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  timer = setTimer(() => finish({ error: 'timeout' }), options.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
  return { redirectUri: `http://${host}:${port}${CALLBACK_PATH}`, result, close: () => finish({ error: 'closed' }) };
}
