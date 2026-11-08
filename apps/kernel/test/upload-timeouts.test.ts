// SPDX-License-Identifier: AGPL-3.0-only
// The request timeout of the API server is raised for large meeting uploads (#2780); the stall timeout stays shorter than it.
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { MEDIA_REQUEST_TIMEOUT_MS, MEDIA_STALL_TIMEOUT_MS, configureUploadTimeouts } from '../src/upload-timeouts.ts';

describe('upload timeouts', () => {
  it('lets a 2 GB request arrive at about 1 MB/s, where Node allows 300 s', () => {
    const server = createServer();
    expect(server.requestTimeout).toBe(300_000);
    configureUploadTimeouts(server);
    expect(server.requestTimeout).toBe(MEDIA_REQUEST_TIMEOUT_MS);
    expect(2 * 1024 ** 3 / (MEDIA_REQUEST_TIMEOUT_MS / 1000)).toBeLessThan(1.5 * 1024 ** 2);
    // The headers still have to arrive quickly.
    expect(server.headersTimeout).toBeLessThanOrEqual(60_000);
    server.close();
  });

  it('cancels a silent upload long before the request timeout', () => {
    expect(MEDIA_STALL_TIMEOUT_MS).toBeLessThan(MEDIA_REQUEST_TIMEOUT_MS);
    expect(MEDIA_STALL_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});
