// SPDX-License-Identifier: AGPL-3.0-only
// Time limits for large meeting uploads (issue #2780). Node's HTTP server gives a request 300 seconds to arrive whole
// (requestTimeout), which a 2 GB recording on a home or office uplink does not meet: at 300 s it needs about 6.7 MB/s. The limit is
// raised for the whole server, because Node has no per-route request timeout, and what it protected against is covered again
// where it matters: a raw meeting upload is cancelled when no byte arrives for MEDIA_STALL_TIMEOUT_MS (media-seal.ts), so a
// client that stops sending cannot hold the one video slot.
import type { Server } from 'node:http';

// The longest a request may take to arrive: 2 GB at about 1 MB/s with room to spare (45 minutes).
export const MEDIA_REQUEST_TIMEOUT_MS = 45 * 60 * 1000;
// A raw upload that receives nothing for this long is cancelled.
export const MEDIA_STALL_TIMEOUT_MS = 60 * 1000;

// Raises the request timeout of the API server. The headers timeout (60 s by default) is left as it is: the headers of a
// request still have to arrive quickly.
export function configureUploadTimeouts(server: Pick<Server, 'requestTimeout'>): void {
  server.requestTimeout = MEDIA_REQUEST_TIMEOUT_MS;
}
