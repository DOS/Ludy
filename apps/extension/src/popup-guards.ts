// SPDX-License-Identifier: AGPL-3.0-only
// Concurrency guards for the extension popup: keeps latest-wins async renders,
// defers mount side effects (like recording timers) until after DOM commit, and drops
// stale clipboard-copy completions across notice language toggles or re-renders.

export interface RenderPass {
  isCurrent: () => boolean;
  onMount: Array<() => void>;
}

interface PopupConcurrency {
  runRender: (
    clearActiveTimers: () => void,
    build: (pass: RenderPass) => Promise<(() => void) | null>,
  ) => Promise<boolean>;
  invalidateNoticeOp: () => void;
  runNoticeCopy: (
    writeClipboard: () => Promise<void>,
    onResult: (copied: boolean) => void,
  ) => Promise<boolean>;
}

/** Coordinates popup render passes and notice-copy operations against stale async completions. */
export function createPopupConcurrency(): PopupConcurrency {
  let renderSeq = 0;
  let noticeOpSeq = 0;

  return {
    async runRender(clearActiveTimers, build) {
      const seq = ++renderSeq;
      clearActiveTimers();
      const onMount: Array<() => void> = [];
      const isCurrent = () => seq === renderSeq;
      const commit = await build({ isCurrent, onMount });
      if (!commit || !isCurrent()) return false;
      commit();
      for (const run of onMount) run();
      return true;
    },

    invalidateNoticeOp() {
      noticeOpSeq += 1;
    },

    async runNoticeCopy(writeClipboard, onResult) {
      const seq = renderSeq;
      const op = ++noticeOpSeq;
      let copied = false;
      try {
        await writeClipboard();
        copied = true;
      } catch {
        copied = false;
      }
      if (seq !== renderSeq || op !== noticeOpSeq) return false;
      onResult(copied);
      return true;
    },
  };
}
