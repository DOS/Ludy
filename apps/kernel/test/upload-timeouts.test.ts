// SPDX-License-Identifier: AGPL-3.0-only
// The request timeout of the API server is raised for large meeting uploads (#2780), and every request body is guarded against a
// stall instead. Real HTTP server and raw sockets: the guard is about what a client does on the wire.
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { BODY_DEADLINE_MS, BODY_STALL_TIMEOUT_MS, DEFAULT_MEDIA_REQUEST_TIMEOUT_S, configureUploadTimeouts, isMediaUpload } from '../src/upload-timeouts.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('upload timeouts', () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function start(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void, stallMs = 200, deadlineMs = BODY_DEADLINE_MS) {
    const server = createServer(handler);
    configureUploadTimeouts(server, { requestTimeoutSeconds: 2700, stallMs, deadlineMs });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return (server.address() as AddressInfo).port;
  }

  // A raw client: connects, writes what it is told, and records the answer and whether the server closed the connection.
  function client(port: number) {
    const socket = connect(port, '127.0.0.1');
    sockets.push(socket);
    let answer = '';
    let closed = false;
    socket.on('data', (d) => (answer += d.toString()));
    socket.on('close', () => (closed = true));
    socket.on('error', () => undefined);
    return { socket, answer: () => answer, closed: () => closed };
  }
  const post = (length: number) => `POST /upload HTTP/1.1\r\nHost: x\r\nContent-Type: audio/ogg\r\nContent-Length: ${length}\r\n\r\n`;
  const readAll = (req: import('node:http').IncomingMessage) =>
    new Promise<number>((resolve) => {
      let n = 0;
      req.on('data', (c: Buffer) => (n += c.length));
      req.on('end', () => resolve(n));
      req.on('error', () => resolve(-1));
    });

  it('raises the request timeout from Node\'s 300 s to what a 2 GB upload at about 1 MB/s needs, and keeps the headers timeout', () => {
    const server = createServer();
    expect(server.requestTimeout).toBe(300_000);
    configureUploadTimeouts(server, { requestTimeoutSeconds: DEFAULT_MEDIA_REQUEST_TIMEOUT_S });
    expect(server.requestTimeout).toBe(2_700_000);
    expect(2 * 1024 ** 3 / DEFAULT_MEDIA_REQUEST_TIMEOUT_S).toBeLessThan(1.5 * 1024 ** 2);
    expect(server.headersTimeout).toBeLessThanOrEqual(60_000);
    expect(BODY_STALL_TIMEOUT_MS).toBeLessThan(DEFAULT_MEDIA_REQUEST_TIMEOUT_S * 1000);
    // Every other route keeps Node's old limit for the whole body.
    expect(BODY_DEADLINE_MS).toBe(300_000);
    server.close();
  });

  it('closes the connection of a client that sends part of a body and goes silent, on any route', async () => {
    const port = await start((req, res) => void readAll(req).then((n) => res.end(String(n))));
    const c = client(port);
    c.socket.write(post(1000) + 'x'.repeat(100));
    await sleep(700);
    expect(c.closed()).toBe(true);
    expect(c.answer()).toBe('');
  });

  it('does not cut a slow body that keeps moving', async () => {
    const port = await start((req, res) => void readAll(req).then((n) => res.end(`got ${n}`)));
    const c = client(port);
    c.socket.write(post(500));
    for (let i = 0; i < 5; i += 1) {
      await sleep(120);
      c.socket.write('y'.repeat(100));
    }
    await sleep(100);
    expect(c.answer()).toContain('got 500');
    expect(c.closed()).toBe(false);
  });

  it('does not cut a handler that works for a long time after the body, nor a request without a body, nor a long streaming response', async () => {
    const port = await start((req, res) => {
      if (req.url === '/slow') {
        void readAll(req).then(async () => {
          await sleep(500);
          res.end('slow done');
        });
      } else if (req.url === '/stream') {
        res.write('a');
        setTimeout(() => res.end('b'), 500);
      } else {
        setTimeout(() => res.end('plain'), 500);
      }
    });
    const slow = client(port);
    slow.socket.write('POST /slow HTTP/1.1\r\nHost: x\r\nContent-Length: 4\r\n\r\nabcd');
    const plain = client(port);
    plain.socket.write('GET /plain HTTP/1.1\r\nHost: x\r\n\r\n');
    const stream = client(port);
    stream.socket.write('GET /stream HTTP/1.1\r\nHost: x\r\n\r\n');
    await sleep(900);
    expect(slow.answer()).toContain('slow done');
    expect(plain.answer()).toContain('plain');
    expect(stream.answer()).toContain('b');
  });

  it('does not cut a client whose bytes wait for a handler that is slow to read them', async () => {
    // The whole (small) body arrived; the handler starts reading long after the stall time. The client is not the slow one.
    const port = await start((req, res) => {
      setTimeout(() => void readAll(req).then((n) => res.end(`late ${n}`)), 600);
    });
    const c = client(port);
    c.socket.write(post(300) + 'z'.repeat(300));
    await sleep(900);
    expect(c.answer()).toContain('late 300');
  });
  it('does not cut a request whose body has fully arrived while a slow consumer still reads it through a web stream (the way Hono reads)', async () => {
    // The whole body is in (req.complete) and queued; 'end' waits for the consumer, which sleeps longer than the stall time.
    const port = await start((req, res) => {
      void (async () => {
        const reader = (Readable.toWeb(req) as ReadableStream<Uint8Array>).getReader();
        // The web stream queues what it can (about 64 KiB) and pauses req: the body is all in, req has nothing buffered and
        // has not ended, because nobody reads. This is the state the old guard mistook for a stalled client.
        await sleep(700);
        let n = 0;
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          n += step.value.length;
        }
        res.end(`read ${n}`);
      })();
    });
    const c = client(port);
    c.socket.write(post(70000) + 'w'.repeat(70000));
    await sleep(1100);
    expect(c.answer()).toContain('read 70000');
    expect(c.closed()).toBe(false);
  });

  it('limits the whole body of every route but the media upload to the deadline, and lets the media upload take the raised limit', async () => {
    const answer = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void readAll(req).then((n) => res.end(`got ${n}`));
    // A body that keeps moving (a byte batch every 100 ms, so the stall guard never fires) for about 800 ms; the deadline is 400 ms.
    const trickle = async (c: ReturnType<typeof client>, path: string) => {
      c.socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: audio/ogg\r\nContent-Length: 800\r\n\r\n`);
      for (let i = 0; i < 8 && !c.closed(); i += 1) {
        await sleep(100);
        if (!c.closed()) c.socket.write('t'.repeat(100));
      }
      await sleep(150);
    };
    const port = await start(answer, 300, 400);
    const other = client(port);
    await trickle(other, '/api/files');
    expect(other.closed()).toBe(true);
    expect(other.answer()).toBe('');
    const media = client(port);
    await trickle(media, '/api/meetings/11111111-1111-4111-8111-111111111111/media?kind=audio');
    expect(media.answer()).toContain('got 800');
    expect(media.closed()).toBe(false);
  });

  it('knows the media upload route only by its exact method and path', () => {
    const media = '/api/meetings/11111111-1111-4111-8111-111111111111/media';
    expect(isMediaUpload({ method: 'POST', url: media })).toBe(true);
    expect(isMediaUpload({ method: 'POST', url: `${media}?kind=audio&lengthSeconds=5` })).toBe(true);
    for (const url of ['/api/meetings/x/media', `${media}/extra`, `/x${media}`, '/api/meetings/11111111-1111-4111-8111-111111111111/audio', '/api/files', undefined]) {
      expect(isMediaUpload({ method: 'POST', url })).toBe(false);
    }
    expect(isMediaUpload({ method: 'GET', url: media })).toBe(false);
    expect(isMediaUpload({ method: 'PUT', url: media })).toBe(false);
  });
});
