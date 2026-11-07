// SPDX-License-Identifier: AGPL-3.0-only
// The owner-run part of the org export (#2676) as a response body: a streamed query hands its batches to a sink, and the sink here waits
// until the client has taken the previous batch, so nothing piles up in memory whatever the size of the table (no whole-table buffer, no size
// refusal). The first batch is read before the response starts, so a refusal (the org is not closing, a role the query refuses) answers with its
// own status; once the headers are sent a failure cuts the download.
// The body ends with one line, {"_end":true,"rows":N}, so a download cut short can never look complete: the app checks it (OWNER_RUN_END).
// A client that goes away (the request's signal aborts, or the body is cancelled) settles the waiting sink, which stops the query and its
// transaction; so does a client that stops taking batches for MAX_WAIT_MS. The slot is let go only once the query itself has settled, so the
// slots bound the database connections the exports hold, not only the responses.
import { DomainError, type QuerySink } from '@crove/kernel-runtime';

const encoder = new TextEncoder();

// The longest the query waits for the client to take a batch; past it the download is cancelled, whatever the transport does.
export const OWNER_RUN_MAX_WAIT_MS = 5 * 60 * 1000;

// The refusal a sink raises when the client is gone: a known code, not an internal error.
export const DOWNLOAD_CANCELLED = 'DOWNLOAD_CANCELLED';

// `run` runs the streamed query with the sink it is given; `done` is called once when the body has ended, failed or been cancelled, to let go of
// what the caller holds (a concurrency slot); `signal` is the request's, which aborts when the client disconnects.
export async function streamedBody(
  run: (sink: QuerySink) => Promise<unknown>,
  done: () => void,
  signal?: AbortSignal,
  maxWaitMs: number = OWNER_RUN_MAX_WAIT_MS,
): Promise<ReadableStream<Uint8Array>> {
  let slot: Uint8Array | null = null;
  let taken: (() => void) | null = null;
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;
  let cancelled = false;
  let released = false;
  let rows = 0;
  let endSent = false;
  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener('abort', gone);
    done();
  };
  // The client is gone: stop the producer at its next batch, wake whoever waits, let go of the slot.
  function gone(): void {
    cancelled = true;
    taken?.();
    wake?.();
  }
  const cancelledError = () => new DomainError(DOWNLOAD_CANCELLED, 409, 'Người dùng đã hủy tải xuống');

  if (signal?.aborted) {
    cancelled = true;
    release();
    throw cancelledError();
  }
  signal?.addEventListener('abort', gone, { once: true });

  const sink: QuerySink = async (raw) => {
    const lines = (raw as { lines: string[] }).lines;
    if (cancelled) throw cancelledError();
    if (lines.length === 0) return;
    rows += lines.length;
    slot = encoder.encode(`${lines.join('\n')}\n`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const consumed = new Promise<void>((resolve) => {
      taken = resolve;
      // A client that never takes the batch (and never disconnects) must not hold the query, its transaction and the slot for ever.
      timer = setTimeout(() => {
        cancelled = true;
        resolve();
        wake?.();
      }, maxWaitMs);
    });
    wake?.();
    await consumed;
    clearTimeout(timer);
    if (cancelled) throw cancelledError();
  };
  void run(sink).then(
    () => {
      finished = true;
      wake?.();
      release();
    },
    (error: unknown) => {
      finished = true;
      failure = error;
      wake?.();
      release();
    },
  );

  const next = async (): Promise<Uint8Array | null> => {
    for (;;) {
      if (cancelled) return null;
      if (slot) {
        const chunk = slot;
        slot = null;
        taken?.();
        return chunk;
      }
      if (finished) {
        if (failure !== null) throw failure;
        if (endSent) return null;
        endSent = true;
        return encoder.encode(`${JSON.stringify({ _end: true, rows })}\n`);
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  let first: Uint8Array | null;
  first = await next();
  if (cancelled) throw cancelledError();
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        if (first) controller.enqueue(first);
        else controller.close();
      },
      async pull(controller) {
        try {
          const chunk = await next();
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
      cancel() {
        cancelled = true;
        taken?.();
      },
    },
    { highWaterMark: 0 },
  );
}
