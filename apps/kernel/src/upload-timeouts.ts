// SPDX-License-Identifier: AGPL-3.0-only
// Time limits for large meeting uploads (issue #2780). Node's HTTP server gives a request 300 seconds to arrive whole
// (requestTimeout), which a 2 GB recording on a home or office uplink does not meet: at 300 s it needs about 6.7 MB/s. Node has no
// per-route request timeout, so the limit is raised for the whole server (MEDIA_UPLOAD_REQUEST_TIMEOUT_S, 45 minutes by default).
//
// What the 300 s also did was cut a client that trickles a body in, and the headers timeout does not cover that. So every request
// that has a body now has a stall guard instead: the connection is closed once the client has sent nothing for BODY_STALL_TIMEOUT_MS.
// The timer watches the socket's incoming bytes and is gone when the body has been received, so a handler that thinks for a long time
// after the body (an export, a model call), a response that streams for hours and a request without a body are not affected. Bytes
// that arrived but wait for a slow consumer (a store that is slow to take a part) are not a stall either: the timer only fires when the
// request has nothing buffered. It is a stall guard, not a minimum rate: a client that sends a byte every 59 seconds is not cut, as
// before it would have been after 300 s and now after the request timeout.
import type { IncomingMessage, Server } from 'node:http';

export const DEFAULT_MEDIA_REQUEST_TIMEOUT_S = 2700;
// A request body with no byte for this long is cut. A raw meeting upload has the same limit in media-seal.ts, which also frees its slot.
export const BODY_STALL_TIMEOUT_MS = 60 * 1000;

const hasBody = (req: IncomingMessage): boolean => req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;

// Closes the connection of a request whose body stops arriving for stallMs.
export function guardBodyStall(req: IncomingMessage, stallMs: number): void {
  if (!hasBody(req)) return;
  const socket = req.socket;
  const check = () => {
    // Bytes are waiting for the handler to take them: the client is not the one that is slow.
    if (req.readableLength > 0) timer.refresh();
    else socket.destroy();
  };
  const timer = setTimeout(check, stallMs);
  timer.unref();
  const touch = () => timer.refresh();
  socket.on('data', touch);
  const done = () => {
    clearTimeout(timer);
    socket.off('data', touch);
    req.off('end', done);
    req.off('close', done);
  };
  req.once('end', done);
  req.once('close', done);
}

export interface UploadTimeoutOptions {
  requestTimeoutSeconds: number;
  stallMs?: number;
}

// Raises the request timeout of the API server and guards every request body against a stall. The headers timeout (60 s by
// default) is left as it is: the headers of a request still have to arrive quickly.
export function configureUploadTimeouts(server: Pick<Server, 'requestTimeout' | 'on'>, options: UploadTimeoutOptions): void {
  server.requestTimeout = options.requestTimeoutSeconds * 1000;
  const stallMs = options.stallMs ?? BODY_STALL_TIMEOUT_MS;
  server.on('request', (req: IncomingMessage) => guardBodyStall(req, stallMs));
}
