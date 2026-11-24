// SPDX-License-Identifier: AGPL-3.0-only
// Recording indicator pill DOM controller (ludy-desktop://ui/pill.html). Always visible and unclosable while recording.

export interface PillViewPayload {
  meetingId: string;
  title: string;
  elapsedMs: number;
  warning: string | null;
}

export function formatPillClock(elapsedMs: number): string {
  const total = Math.floor(Math.max(0, elapsedMs) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

export function bootPillUi(): void {
  const bridge = (window as unknown as {
    ludyDesktopBridge?: {
      pillInit(): Promise<PillViewPayload | null>;
      pillStop(): Promise<void>;
      onPillUpdate(cb: (state: PillViewPayload) => void): () => void;
    };
  }).ludyDesktopBridge;
  if (!bridge) return;

  const titleEl = document.getElementById('pill-title')!;
  const clockEl = document.getElementById('pill-clock')!;
  const warningEl = document.getElementById('pill-warning')!;
  const stopBtn = document.getElementById('pill-stop') as HTMLButtonElement;

  const render = (state: PillViewPayload | null) => {
    if (!state) return;
    titleEl.textContent = state.title || 'Đang ghi cuộc họp';
    clockEl.textContent = formatPillClock(state.elapsedMs);
    if (state.warning) {
      warningEl.textContent = state.warning;
      warningEl.classList.remove('hidden');
    } else {
      warningEl.classList.add('hidden');
    }
  };

  stopBtn.addEventListener('click', () => {
    stopBtn.disabled = true;
    void bridge.pillStop();
  });

  bridge.onPillUpdate(render);
  void bridge.pillInit().then(render);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  bootPillUi();
}
