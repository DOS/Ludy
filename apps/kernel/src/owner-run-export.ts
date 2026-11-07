// SPDX-License-Identifier: AGPL-3.0-only
// The owner-run part of the org export (#2676) as a response body: a streamed query hands its batches to a sink, and the sink here waits
// until the client has taken the previous batch, so nothing piles up in memory whatever the size of the table (no whole-table buffer, no size
// refusal). The first batch is read before the response starts, so a refusal (the org is not closing, a role the query refuses) answers with its
// own status; once the headers are sent a failure cuts the download.
import type { QuerySink } from '@crove/kernel-runtime';

const encoder = new TextEncoder();

// `run` runs the streamed query with the sink it is given; `done` is called once when the body has ended, failed or been cancelled, to let go of
// what the caller holds (a concurrency slot).
export async function streamedBody(run: (sink: QuerySink) => Promise<unknown>, done: () => void): Promise<ReadableStream<Uint8Array>> {
  let slot: Uint8Array | null = null;
  let taken: (() => void) | null = null;
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;
  let cancelled = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    done();
  };

  const sink: QuerySink = async (raw) => {
    const lines = (raw as { lines: string[] }).lines;
    if (cancelled) throw new Error('the download was cancelled');
    if (lines.length === 0) return;
    slot = encoder.encode(`${lines.join('\n')}\n`);
    const consumed = new Promise<void>((resolve) => {
      taken = resolve;
    });
    wake?.();
    await consumed;
    if (cancelled) throw new Error('the download was cancelled');
  };
  void run(sink).then(
    () => {
      finished = true;
      wake?.();
    },
    (error: unknown) => {
      finished = true;
      failure = error;
      wake?.();
    },
  );

  const next = async (): Promise<Uint8Array | null> => {
    for (;;) {
      if (slot) {
        const chunk = slot;
        slot = null;
        taken?.();
        return chunk;
      }
      if (finished) {
        if (failure !== null) throw failure;
        return null;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  let first: Uint8Array | null;
  try {
    first = await next();
  } catch (error) {
    release();
    throw error;
  }
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (first) controller.enqueue(first);
        else {
          controller.close();
          release();
        }
      },
      async pull(controller) {
        try {
          const chunk = await next();
          if (chunk) controller.enqueue(chunk);
          else {
            controller.close();
            release();
          }
        } catch (error) {
          controller.error(error);
          release();
        }
      },
      cancel() {
        cancelled = true;
        taken?.();
        release();
      },
    },
    { highWaterMark: 0 },
  );
}
