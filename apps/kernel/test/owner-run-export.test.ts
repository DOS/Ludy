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
    expect(await text(body)).toBe('a\nb\nc\n');
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
    expect(await text(body)).toBe('0\n1\n2\n3\n4\n');
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
    expect(String(failure)).toContain('cancelled');
  });
});
