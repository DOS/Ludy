// SPDX-License-Identifier: AGPL-3.0-only
// Regression tests for popup concurrency guards (#4454): overlapping render() passes
// must never spawn timers on superseded/unmounted views or clobber a newer pass's timer,
// and pending copyNotice() calls must drop stale results across language toggles or renders.
import { describe, expect, it } from 'vitest';
import { createPopupConcurrency } from '../src/popup-guards.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('popup concurrency guards (#4454)', () => {
  it('defers onMount timers until post-commit and never runs them for superseded or rejected renders', async () => {
    const guards = createPopupConcurrency();
    const events: string[] = [];
    let activeTimers = 0;
    let tickerId = 0;
    let currentTimer: number | null = null;

    const clearTicker = () => {
      if (currentTimer !== null) {
        activeTimers -= 1;
        currentTimer = null;
      }
    };

    const gate1 = deferred<void>();
    const gate2 = deferred<void>();

    const render1 = guards.runRender(clearTicker, async (pass) => {
      await gate1.promise;
      // Even if render1 reaches meetingsView after render2 starts and queues a timer callback,
      // runRender must discard both the DOM commit and the mount callback.
      pass.onMount.push(() => {
        clearTicker();
        tickerId += 1;
        activeTimers += 1;
        currentTimer = tickerId;
        events.push(`mount:1:${tickerId}`);
      });
      return () => events.push('commit:1');
    });

    const render2 = guards.runRender(clearTicker, async (pass) => {
      await gate2.promise;
      pass.onMount.push(() => {
        clearTicker();
        tickerId += 1;
        activeTimers += 1;
        currentTimer = tickerId;
        events.push(`mount:2:${tickerId}`);
      });
      return () => events.push('commit:2');
    });

    gate2.resolve();
    expect(await render2).toBe(true);
    expect(events).toEqual(['commit:2', 'mount:2:1']);
    expect(activeTimers).toBe(1);
    expect(currentTimer).toBe(1);

    gate1.resolve();
    expect(await render1).toBe(false);
    expect(events).toEqual(['commit:2', 'mount:2:1']);
    expect(activeTimers).toBe(1);
    expect(currentTimer).toBe(1);

    // A failing render stops the previous timer on entry and never fires any queued mount hook.
    await expect(
      guards.runRender(clearTicker, async (pass) => {
        pass.onMount.push(() => {
          activeTimers += 1;
          events.push('mount:3');
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(activeTimers).toBe(0);
    expect(currentTimer).toBeNull();
    expect(events).toEqual(['commit:2', 'mount:2:1']);
  });

  it('drops stale copyNotice results across toggleNoticeLanguage and overlapping render passes', async () => {
    const guards = createPopupConcurrency();
    const applied: Array<{ copied: boolean }> = [];

    // 1. Happy path: completes without intervening toggle or render.
    const ok = await guards.runNoticeCopy(
      async () => undefined,
      (copied) => applied.push({ copied }),
    );
    expect(ok).toBe(true);
    expect(applied).toEqual([{ copied: true }]);

    // 2. Clipboard write resolves after toggleNoticeLanguage() invalidated noticeOpSeq.
    const slowCopy = deferred<void>();
    const pendingToggle = guards.runNoticeCopy(
      () => slowCopy.promise,
      (copied) => applied.push({ copied }),
    );
    guards.invalidateNoticeOp();
    slowCopy.resolve();
    expect(await pendingToggle).toBe(false);
    expect(applied).toEqual([{ copied: true }]);

    // 3. Clipboard write rejects after an overlapping render bumped renderSeq.
    const failingCopy = deferred<void>();
    const pendingRender = guards.runNoticeCopy(
      () => failingCopy.promise,
      (copied) => applied.push({ copied }),
    );
    await guards.runRender(
      () => undefined,
      async () => () => undefined,
    );
    failingCopy.reject(new Error('denied'));
    expect(await pendingRender).toBe(false);
    expect(applied).toEqual([{ copied: true }]);

    // 4. Uninterrupted failed copy reports copied=false.
    const cleanFail = await guards.runNoticeCopy(
      async () => {
        throw new Error('denied');
      },
      (copied) => applied.push({ copied }),
    );
    expect(cleanFail).toBe(true);
    expect(applied).toEqual([{ copied: true }, { copied: false }]);
  });
});
