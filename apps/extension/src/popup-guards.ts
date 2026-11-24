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

export interface ActiveTabPermissionApi {
  contains: (query: { permissions: string[] }) => Promise<boolean>;
}

export interface ActiveTabTracker {
  captureBaseline: (permissions: ActiveTabPermissionApi) => Promise<void>;
  onMeetingsEnabled: (granted: boolean) => void;
  onWebClipperToggled: (enable: boolean, granted: boolean) => boolean;
  onPermissionsRemoved: (removed: readonly string[], permissions: ActiveTabPermissionApi) => Promise<void>;
  onCaptureSucceeded: () => void;
  isJustGranted: () => boolean;
}

/**
 * Tracks whether `activeTab` was already held when this popup opened (and never revoked since) vs.
 * granted or re-granted mid-popup by enabling meetings or Web Clipper before a toolbar click activated it.
 */
export function createActiveTabTracker(): ActiveTabTracker {
  let baselinePromise: Promise<void> | null = null;
  let activatedForPopup: boolean | null = null;
  let justGranted = false;

  const captureBaseline = async (permissions: ActiveTabPermissionApi): Promise<void> => {
    if (activatedForPopup !== null) return;
    if (!baselinePromise) {
      baselinePromise = permissions
        .contains({ permissions: ['activeTab'] })
        .catch(() => false)
        .then((held) => {
          if (activatedForPopup === null) activatedForPopup = held;
        });
    }
    await baselinePromise;
  };

  return {
    captureBaseline,

    onMeetingsEnabled(granted) {
      if (!granted) return;
      if (activatedForPopup === null) activatedForPopup = false;
      if (!activatedForPopup) justGranted = true;
    },

    onWebClipperToggled(enable, granted) {
      if (!enable || !granted) {
        justGranted = false;
        return false;
      }
      if (activatedForPopup === null) activatedForPopup = false;
      justGranted = !activatedForPopup;
      return justGranted;
    },

    async onPermissionsRemoved(removed, permissions) {
      if (!removed.includes('activeTab')) return;
      const stillHeld = await permissions.contains({ permissions: ['activeTab'] }).catch(() => false);
      if (!stillHeld) {
        activatedForPopup = false;
        justGranted = false;
      }
    },

    onCaptureSucceeded() {
      activatedForPopup = true;
      justGranted = false;
    },

    isJustGranted() {
      return justGranted;
    },
  };
}
