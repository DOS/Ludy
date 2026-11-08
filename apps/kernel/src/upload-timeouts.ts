// SPDX-License-Identifier: AGPL-3.0-only
// Time limits for large meeting uploads (issue #2780). Node's HTTP server gives a request 300 seconds to arrive whole
// (requestTimeout), which a 2 GB recording on a home or office uplink does not meet: at 300 s it needs about 6.7 MB/s. Node has no
// per-route request timeout, so the server-wide limit is raised to MEDIA_UPLOAD_REQUEST_TIMEOUT_S (45 minutes by default) and
// two guards put the old limits back where they belong, both set when a request that has a body starts:
//   - a whole-body deadline of BODY_DEADLINE_MS (300 s, Node's old default) on every request except the media upload route
//     (POST /api/meetings/:id/media), so the raised limit is the media route's alone;
//   - a stall guard on every request: the connection is closed once the client has sent nothing for BODY_STALL_TIMEOUT_MS.
// A request whose body has completely arrived (req.complete) is never cut: what is left is the handler's own time, which a slow
// consumer (an 8 MiB part on a slow uplink to the bucket) or a long computation may take. Bytes that arrived but wait for a consumer
// are not a stall either: the stall timer only fires when the request has nothing buffered. A request without a body, a response that
// streams for hours and a handler that works long after the body are not affected. The stall guard is not a minimum rate: a client
// that sends a byte every 59 seconds is not cut by it, only by the deadline (non-media) or the request timeout (media).
import type { IncomingMessage, Server } from 'node:http';

export const DEFAULT_MEDIA_REQUEST_TIMEOUT_S = 2700;
// A request body with no byte for this long is cut. A raw meeting upload has the same limit in media-seal.ts, which also frees its slot.
export const BODY_STALL_TIMEOUT_MS = 60 * 1000;
// How long any other request may take to deliver its body: Node's own default request timeout.
export const BODY_DEADLINE_MS = 300 * 1000;

const MEDIA_UPLOAD_PATH = /^\/api\/meetings\/[0-9a-fA-F-]{36}\/media$/;

const hasBody = (req: IncomingMessage): boolean => req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;

// The one route that may take the raised request timeout. The raw request path: a percent-encoded or otherwise odd path is not it.
export const isMediaUpload = (req: Pick<IncomingMessage, 'method' | 'url'>): boolean =>
  req.method === 'POST' && MEDIA_UPLOAD_PATH.test((req.url ?? '').split('?')[0] ?? '');

export interface BodyGuardOptions {
  stallMs: number;
  deadlineMs: number;
}

// Closes the connection of a request whose body stops arriving, or (outside the media route) is not all there in time.
export function guardBody(req: IncomingMessage, options: BodyGuardOptions): void {
  if (!hasBody(req)) return;
  const socket = req.socket;
  const media = isMediaUpload(req);
  // `complete`: the parser has the whole message. The consumer may not have taken it all (the web stream's queue, a slow handler),
  // and 'end' waits for it, but the client has done its part.
  const stall = setTimeout(() => {
    if (req.complete) return done();
    // Bytes are waiting for the handler to take them: the client is not the one that is slow.
    if (req.readableLength > 0) stall.refresh();
    else socket.destroy();
  }, options.stallMs);
  stall.unref();
  const deadline = media
    ? undefined
    : setTimeout(() => {
        if (req.complete) return done();
        socket.destroy();
      }, options.deadlineMs);
  deadline?.unref();
  const touch = () => stall.refresh();
  socket.on('data', touch);
  function done() {
    clearTimeout(stall);
    clearTimeout(deadline);
    socket.off('data', touch);
    req.off('end', done);
    req.off('close', done);
  }
  req.once('end', done);
  req.once('close', done);
}

export interface UploadTimeoutOptions {
  requestTimeoutSeconds: number;
  stallMs?: number;
  deadlineMs?: number;
}

// Raises the request timeout of the API server for the media route and guards every request body. The headers timeout (60 s by
// default) is left as it is: the headers of a request still have to arrive quickly.
export function configureUploadTimeouts(server: Pick<Server, 'requestTimeout' | 'on'>, options: UploadTimeoutOptions): void {
  server.requestTimeout = options.requestTimeoutSeconds * 1000;
  const guard = { stallMs: options.stallMs ?? BODY_STALL_TIMEOUT_MS, deadlineMs: options.deadlineMs ?? BODY_DEADLINE_MS };
  server.on('request', (req: IncomingMessage) => guardBody(req, guard));
}
