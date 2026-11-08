// SPDX-License-Identifier: AGPL-3.0-only
// The streamed body of the owner-run export (#2676): batches reach the client in order, the sink waits for the client (no pile-up), the first
// batch is read before the response starts so a refusal keeps its own error, and the slot is let go once at the end, on failure and on cancel.
import { describe, expect, it } from 'vitest';
import { streamedBody } from '../src/owner-run-export.ts';

const text = async (stream: ReadableStream<Uint8Array>) => new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer()));

describe('streamedBody', () => {
  it('streams every batch in order and lets go of the slot once', async () => {
    let released = 0;
    const body = await streamedBody(
      async (sink) => {
        await sink({ lines: ['a', 'b'], last: false });
        await sink({ lines: [], last: false });
        await sink({ lines: ['c'], last: true });
      },
      () => released++,
    );
    expect(await text(body)).toBe('a\nb\nc\n{"_end":true,"rows":3}\n');
    expect(released).toBe(1);
  });

  it('holds the producer back until the client takes the previous batch', async () => {
    let produced = 0;
    const body = await streamedBody(async (sink) => {
      for (let i = 0; i < 5; i++) {
        await sink({ lines: [String(i)], last: false });
        produced++;
      }
    }, () => {});
    await new Promise((r) => setTimeout(r, 20));
    // The first batch was taken to start the response; the second waits in the slot, so the producer is at most two batches ahead.
    expect(produced).toBeLessThanOrEqual(2);
    expect(await text(body)).toBe('0\n1\n2\n3\n4\n{"_end":true,"rows":5}\n');
  });

  it('refuses before the response starts when the query fails first, and lets go of the slot', async () => {
    let released = 0;
    await expect(
      streamedBody(
        async () => {
          throw new Error('refused');
        },
        () => released++,
      ),
    ).rejects.toThrow('refused');
    expect(released).toBe(1);
  });

  it('stops the producer and lets go of the slot when the client cancels', async () => {
    let released = 0;
    let failure: unknown = null;
    const body = await streamedBody(
      async (sink) => {
        try {
          for (;;) await sink({ lines: ['x'], last: false });
        } catch (error) {
          failure = error;
          throw error;
        }
      },
      () => released++,
    );
    await body.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(released).toBe(1);
    expect(failure).toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
  });

  it('writes only the end line for an empty table', async () => {
    const body = await streamedBody(async (sink) => sink({ lines: [], last: true }), () => {});
    expect(await text(body)).toBe('{"_end":true,"rows":0}\n');
  });

  it('settles the producer and lets go of the slot when the client aborts before the response starts', async () => {
    let released = 0;
    let stopped: unknown = null;
    const controller = new AbortController();
    const pending = streamedBody(
      async (sink) => {
        try {
          await sink({ lines: ['x'], last: false });
          await sink({ lines: ['y'], last: false });
        } catch (error) {
          stopped = error;
          throw error;
        }
      },
      () => released++,
      controller.signal,
    );
    controller.abort();
    // Whether the abort lands before or after the first batch, nothing is leaked: the slot is released once and the producer stops.
    await pending.then((body) => body.cancel()).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(released).toBe(1);
    expect(stopped).toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
  });

  it('refuses at once with a known code when the signal is already aborted', async () => {
    let released = 0;
    let ran = false;
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamedBody(
        async () => {
          ran = true;
        },
        () => released++,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
    expect(released).toBe(1);
    expect(ran).toBe(false);
  });

  it('stops waiting for a client that takes no batch, and lets go of the slot once the query has settled', async () => {
    let released = 0;
    let stopped: unknown = null;
    await streamedBody(
      async (sink) => {
        try {
          await sink({ lines: ['x'], last: false });
          await sink({ lines: ['y'], last: false });
        } catch (error) {
          stopped = error;
          throw error;
        }
      },
      () => released++,
      undefined,
      30,
    );
    // The first batch was read to start the response; the client never takes the second, and never disconnects.
    expect(released).toBe(0);
    await new Promise((r) => setTimeout(r, 120));
    expect(stopped).toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
    expect(released).toBe(1);
  });

  it('errors the body, never ends it cleanly, when the wait bound cancels a connected client', async () => {
    const body = await streamedBody(
      async (sink) => {
        await sink({ lines: ['x'], last: false });
        await sink({ lines: ['y'], last: false });
      },
      () => {},
      undefined,
      30,
    );
    await new Promise((r) => setTimeout(r, 120));
    await expect(text(body)).rejects.toMatchObject({ code: 'DOWNLOAD_CANCELLED' });
  });
});
