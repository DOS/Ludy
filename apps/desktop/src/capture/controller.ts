// SPDX-License-Identifier: AGPL-3.0-only
// Orchestrates desktop meeting capture (ADR-0055 slice 3, #4516): pre-checks devices/WASAPI process loopback, confirms
// consent + creates the server meeting (POST /api/rpc/meetings/create) BEFORE recording or storing any audio piece,
// drives 30 s captureHeartbeat, 15 s live-notes chunks, silent-track warnings within seconds, final media upload, and recovery cleanup.
import { randomUUID } from 'node:crypto';
import type { FetchLike } from '../exchange.ts';
import type { CaptureTrayState } from '../tray-model.ts';
import {
  createDesktopMeeting,
  DesktopApiError,
  fetchAgendaNext,
  parseCaptureHeld,
  sendCaptureHeartbeat,
  sendDesktopLiveChunk,
  sendDesktopRecordingStopped,
  uploadDesktopMedia,
  type AgendaEvent,
  type ConsentMethod,
} from '../server-api.ts';
import {
  consentBlocker,
  formatCaptureAlreadyRunning,
  RECORDING_NOTICE,
  type RecordingNoticeLanguage,
} from './consent.ts';
import {
  CAPTURE_CANCELLED,
  CaptureCancelledError,
  PROCESS_LOOPBACK_UNSUPPORTED,
  ProcessLoopbackUnsupportedError,
  type CaptureModule,
  type CapturePiece,
  type CaptureSource,
} from './interface.ts';
import { createDesktopLiveSender, type LocalRecordingStore } from './live-sender.ts';
import { sanitizePastedJoinUrl, type OfferedWindow } from './windows.ts';

export const DESKTOP_HEARTBEAT_INTERVAL_MS = 30_000;

export interface CaptureDraft {
  title: string;
  consentMethod: string;
  consentAgreed: boolean;
  noticeLanguage: RecordingNoticeLanguage;
  liveNotes: boolean;
  targetPid?: number;
  source: CaptureSource;
  agendaId?: string;
  joinUrl?: string;
  allowSystemFallback?: boolean;
}

export interface CaptureSessionInfo {
  ludyUrl: string;
  token: string;
  uploads: 'presigned' | 'direct';
  meetingsEnabled: boolean;
  agendaEnabled: boolean;
}

export interface CaptureUIHost {
  updateConsentState(state: ConsentWindowViewState): void;
  showPill(state: PillViewState): void;
  updatePill(state: PillViewState): void;
  hidePill(): void;
  closeConsent(): void;
}

export interface ConsentWindowViewState {
  busy: boolean;
  error: string | null;
  systemFallbackRequired: boolean;
  windows: readonly OfferedWindow[];
  agendaEnabled: boolean;
  agendaEvents: readonly AgendaEvent[];
  noticeVersion: string;
  noticeText: { vi: string; en: string };
}

export interface PillViewState {
  meetingId: string;
  title: string;
  elapsedMs: number;
  warning: string | null;
}

export interface CaptureControllerDeps {
  capture: CaptureModule;
  recordingStore: LocalRecordingStore;
  fetch: FetchLike;
  listWindows(): Promise<OfferedWindow[]>;
  getSession(): CaptureSessionInfo | null;
  onTrayState(patch: Partial<CaptureTrayState>): void;
  ui: CaptureUIHost;
  now?: () => number;
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (message: string) => void;
}

const SILENT_WARNING_TEXT: Record<'silent-loopback' | 'silent-mic', string> = {
  'silent-loopback': 'Không nghe thấy âm thanh từ ứng dụng họp (kiểm tra loa/ứng dụng hoặc quyền ghi âm hệ thống).',
  'silent-mic': 'Micro đang im lặng hoặc chưa bật; bản ghi chỉ có âm thanh cuộc họp.',
};

const BLOCKER_MESSAGES: Record<'title' | 'consentMethod' | 'consentAgreed', string> = {
  title: 'Vui lòng nhập tên cuộc họp trước khi ghi.',
  consentMethod: 'Vui lòng chọn cách bạn đã báo cho người tham gia.',
  consentAgreed: 'Bạn cần xác nhận đã thông báo và người tham gia đồng ý ghi âm.',
};

export interface CaptureStartOutcome {
  ok: boolean;
  error?: string;
  systemFallbackRequired?: boolean;
  meetingId?: string;
}

export function createCaptureController(deps: CaptureControllerDeps) {
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setInterval ?? ((cb: () => void, ms: number) => setInterval(cb, ms));
  const clearTimer = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const log = deps.log ?? (() => undefined);

  let phase: CaptureTrayState['phase'] = 'idle';
  let pendingStart: { controller: AbortController; cancelled: boolean } | null = null;
  let windows: OfferedWindow[] = [];
  let agendaEvents: AgendaEvent[] = [];
  let active: {
    recordingId: string;
    meetingId: string;
    title: string;
    session: CaptureSessionInfo;
    startedAt: number;
    mimeType: string;
    hasChunks: boolean;
    liveSender: ReturnType<typeof createDesktopLiveSender> | null;
    heartbeatTimer: unknown;
    elapsedTimer: unknown;
    warning: string | null;
    stopPromise: Promise<void> | null;
    pumpPromise: Promise<void> | null;
    stopReason: 'user' | 'mic_lost' | 'storage_full' | 'unknown';
  } | null = null;

  const currentView = (overrides: Partial<ConsentWindowViewState> = {}): ConsentWindowViewState => {
    const sess = deps.getSession();
    return {
      busy: phase === 'preparing',
      error: null,
      systemFallbackRequired: false,
      windows,
      agendaEnabled: Boolean(sess?.agendaEnabled),
      agendaEvents,
      noticeVersion: RECORDING_NOTICE.version,
      noticeText: RECORDING_NOTICE.text,
      ...overrides,
    };
  };

  async function refreshWindows(): Promise<OfferedWindow[]> {
    windows = await deps.listWindows().catch(() => []);
    const primary = windows[0] ?? null;
    deps.onTrayState({ detectedApp: primary?.appName ?? null });
    return windows;
  }

  async function refreshAgenda(): Promise<AgendaEvent[]> {
    const sess = deps.getSession();
    if (!sess || !sess.agendaEnabled) {
      agendaEvents = [];
      return [];
    }
    const res = await fetchAgendaNext(deps.fetch, sess.ludyUrl, sess.token).catch(() => null);
    agendaEvents = res?.enabled ? res.events : [];
    return agendaEvents;
  }

  async function openConsent(): Promise<ConsentWindowViewState> {
    if (phase === 'idle') phase = 'consent';
    await Promise.all([refreshWindows(), refreshAgenda()]);
    const view = currentView();
    deps.ui.updateConsentState(view);
    return view;
  }

  async function startCapture(draft: CaptureDraft): Promise<CaptureStartOutcome> {
    if (phase === 'recording' || phase === 'preparing' || phase === 'uploading') {
      return { ok: false, error: 'Đang có một cuộc họp khác đang ghi hoặc đang tải lên.' };
    }
    const session = deps.getSession();
    if (!session || !session.meetingsEnabled) {
      return { ok: false, error: 'Tài khoản hoặc máy chủ chưa bật ghi âm từ Ludy Desktop.' };
    }
    const blocker = consentBlocker({ title: draft.title, consentMethod: draft.consentMethod, consentAgreed: draft.consentAgreed });
    if (blocker) {
      const error = BLOCKER_MESSAGES[blocker];
      deps.ui.updateConsentState(currentView({ error }));
      return { ok: false, error };
    }

    phase = 'preparing';
    const startAttempt = { controller: new AbortController(), cancelled: false };
    pendingStart = startAttempt;
    deps.onTrayState({ phase: 'preparing', warning: null });
    deps.ui.updateConsentState(currentView({ busy: true }));

    const recordingId = randomUUID();
    const joinUrl = sanitizePastedJoinUrl(draft.joinUrl);
    const liveQueue = createDesktopLiveSender({
      send: async (piece) => {
        // Server enforces meeting existence & consent record before storing any chunk.
        if (!active) return;
        await sendDesktopLiveChunk(deps.fetch, session.ludyUrl, session.token, {
          meetingId: active.meetingId,
          seq: piece.seq,
          lengthSeconds: piece.lengthSeconds,
          bytes: piece.bytes,
          mimeType: piece.mimeType,
        });
      },
    });

    const startedCapture = { open: false };
    let initialWarning: string | null = null;
    const pendingLiveChunks: Array<{ bytes: Uint8Array; mimeType: string; durationMs: number }> = [];
    try {
      await deps.recordingStore.prepareDir(recordingId);
      if (startAttempt.cancelled || startAttempt.controller.signal.aborted) {
        throw new CaptureCancelledError();
      }
      // Step 1: Probe / open capture device FIRST (without writing or sending any audio). If Win10 < build 20348 does not
      // support per-app loopback and allowSystemFallback is not explicitly ticked, fail here cleanly before creating a meeting.
      await deps.capture.start(draft.source, joinUrl ?? draft.agendaId ?? '', {
        ...(draft.targetPid !== undefined ? { targetPid: draft.targetPid } : {}),
        ...(draft.allowSystemFallback ? { allowSystemFallback: true } : {}),
        signal: startAttempt.controller.signal,
        onLiveChunk(piece) {
          if (!draft.liveNotes) return;
          if (active) liveQueue.push(piece.bytes, piece.mimeType, piece.durationMs);
          else if (pendingLiveChunks.length < 4) pendingLiveChunks.push(piece);
        },
        onSilentAlert(kind) {
          if (!active) return;
          const warning = SILENT_WARNING_TEXT[kind];
          active.warning = warning;
          deps.onTrayState({ warning });
          deps.ui.updatePill({ meetingId: active.meetingId, title: active.title, elapsedMs: now() - active.startedAt, warning });
        },
        onMicMissing() {
          const warning = SILENT_WARNING_TEXT['silent-mic'];
          if (!active) {
            initialWarning = warning;
            return;
          }
          active.warning = warning;
          deps.onTrayState({ warning });
          deps.ui.updatePill({ meetingId: active.meetingId, title: active.title, elapsedMs: now() - active.startedAt, warning });
        },
        onUnexpectedEnd(reason) {
          if (active && phase === 'recording') {
            active.stopReason = reason === 'device_lost' ? 'mic_lost' : 'unknown';
            void stopCapture(active.stopReason);
          }
        },
      });
      startedCapture.open = true;
      if (startAttempt.cancelled || startAttempt.controller.signal.aborted) {
        throw new CaptureCancelledError();
      }

      // Step 2: Create the server meeting with the confirmed consent record BEFORE recording/storing/sending any audio.
      const created = await createDesktopMeeting(deps.fetch, session.ludyUrl, session.token, {
        title: draft.title.trim(),
        consentMethod: draft.consentMethod as ConsentMethod,
        consentNoticeVersion: RECORDING_NOTICE.version,
        liveNotes: draft.liveNotes,
        ...(draft.agendaId ? { agendaId: draft.agendaId } : {}),
        ...(joinUrl ? { joinUrl } : {}),
      });
      if (startAttempt.cancelled || startAttempt.controller.signal.aborted) {
        throw new CaptureCancelledError();
      }
      if (pendingStart === startAttempt) pendingStart = null;

      const startedAt = now();
      const title = draft.title.trim();
      const heartbeatTimer = setTimer(() => {
        if (!active) return;
        void sendCaptureHeartbeat(deps.fetch, active.session.ludyUrl, active.session.token, { meetingId: active.meetingId }).catch(() => undefined);
      }, DESKTOP_HEARTBEAT_INTERVAL_MS);
      const elapsedTimer = setTimer(() => {
        if (!active) return;
        const elapsedMs = now() - active.startedAt;
        deps.onTrayState({ elapsedMs });
        deps.ui.updatePill({ meetingId: active.meetingId, title: active.title, elapsedMs, warning: active.warning });
      }, 1000);

      active = {
        recordingId,
        meetingId: created.meetingId,
        title,
        session,
        startedAt,
        mimeType: 'audio/webm',
        hasChunks: false,
        liveSender: draft.liveNotes ? liveQueue : null,
        heartbeatTimer,
        elapsedTimer,
        warning: initialWarning,
        stopPromise: null,
        pumpPromise: null,
        stopReason: 'user',
      };

      active.pumpPromise = pumpPieces(active);
      for (const buffered of pendingLiveChunks.splice(0)) {
        liveQueue.push(buffered.bytes, buffered.mimeType, buffered.durationMs);
      }
      phase = 'recording';
      deps.onTrayState({ phase: 'recording', meetingTitle: title, elapsedMs: 0, warning: initialWarning });
      deps.ui.closeConsent();
      deps.ui.showPill({ meetingId: created.meetingId, title, elapsedMs: 0, warning: initialWarning });
      return { ok: true, meetingId: created.meetingId };
    } catch (error) {
      if (pendingStart === startAttempt) pendingStart = null;
      if (startedCapture.open) {
        await deps.capture.stop().catch(() => undefined);
      }
      await deps.recordingStore.remove(recordingId).catch(() => undefined);
      if (startAttempt.cancelled || (error as { code?: unknown })?.code === CAPTURE_CANCELLED) {
        return { ok: false, error: 'Đã hủy ghi cuộc họp.' };
      }
      phase = 'consent';
      deps.onTrayState({ phase: 'consent', meetingTitle: null, elapsedMs: 0, warning: null });

      if ((error as { code?: unknown })?.code === PROCESS_LOOPBACK_UNSUPPORTED) {
        const custom = error instanceof ProcessLoopbackUnsupportedError ? error.messages : undefined;
        const canFallback = error instanceof ProcessLoopbackUnsupportedError ? error.systemFallbackAvailable : true;
        const msg = custom
          ? custom[draft.noticeLanguage]
          : draft.noticeLanguage === 'en'
            ? 'This Windows version does not support per-app audio loopback (requires Windows 10 build 20348+ or Windows 11). Tick confirmation below only if you agree to capture whole-system audio instead.'
            : 'Phiên bản Windows này chưa hỗ trợ tách âm thanh riêng từng ứng dụng (cần Windows 10 build 20348+ hoặc Windows 11). Chỉ đánh dấu xác nhận bên dưới nếu bạn đồng ý ghi toàn bộ âm thanh máy.';
        deps.ui.updateConsentState(currentView({ busy: false, error: msg, systemFallbackRequired: canFallback }));
        return { ok: false, error: msg, systemFallbackRequired: canFallback };
      }

      if (error instanceof DesktopApiError && error.code === 'CAPTURE_ALREADY_RUNNING') {
        const msg = formatCaptureAlreadyRunning(parseCaptureHeld(error.details), draft.noticeLanguage);
        deps.ui.updateConsentState(currentView({ busy: false, error: msg }));
        return { ok: false, error: msg };
      }

      const msg = error instanceof Error ? error.message : 'Không thể bắt đầu ghi cuộc họp';
      deps.ui.updateConsentState(currentView({ busy: false, error: msg }));
      return { ok: false, error: msg };
    }
  }

  async function pumpPieces(run: NonNullable<typeof active>): Promise<void> {
    try {
      for await (const piece of deps.capture.pieces as AsyncIterable<CapturePiece>) {
        if (piece.data.byteLength === 0) continue;
        run.mimeType = piece.mimeType || run.mimeType;
        try {
          await deps.recordingStore.appendChunk(run.recordingId, piece.sequence, piece.data);
          run.hasChunks = true;
        } catch {
          run.stopReason = 'storage_full';
          log('local recording store write failed (storage full)');
          break;
        }
      }
    } catch (error) {
      log(`piece stream ended: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  async function stopCapture(reason: 'user' | 'mic_lost' | 'storage_full' | 'unknown' = 'user'): Promise<void> {
    if (!active) return;
    if (active.stopPromise) return active.stopPromise;
    const run = active;
    run.stopReason = reason;
    run.stopPromise = (async () => {
      clearTimer(run.heartbeatTimer);
      clearTimer(run.elapsedTimer);
      phase = 'uploading';
      deps.onTrayState({ phase: 'uploading', warning: null });
      deps.ui.hidePill();

      // Free the call capture lock at once; do not wait for upload.
      void sendCaptureHeartbeat(deps.fetch, run.session.ludyUrl, run.session.token, { meetingId: run.meetingId, end: true }).catch(() => undefined);

      await deps.capture.stop().catch(() => undefined);
      await run.pumpPromise?.catch(() => undefined);
      if (run.liveSender) await run.liveSender.finish().catch(() => undefined);

      const elapsedSeconds = Math.min(24 * 3600, Math.max(1, Math.round((now() - run.startedAt) / 1000)));
      const assembled = await deps.recordingStore.assemble(run.recordingId).catch(() => new Uint8Array(0));

      if (assembled.byteLength === 0) {
        await deps.recordingStore.remove(run.recordingId).catch(() => undefined);
        await sendDesktopRecordingStopped(deps.fetch, run.session.ludyUrl, run.session.token, {
          meetingId: run.meetingId,
          ...(run.stopReason !== 'user' ? { reason: run.stopReason } : {}),
          lengthSeconds: 0,
        }).catch(() => undefined);
      } else {
        try {
          await uploadDesktopMedia(deps.fetch, run.session.ludyUrl, run.session.token, {
            meetingId: run.meetingId,
            bytes: assembled,
            mimeType: run.mimeType,
            lengthSeconds: elapsedSeconds,
            uploads: run.session.uploads,
            ...(run.stopReason !== 'user' ? { stopReason: run.stopReason } : {}),
          });
          await deps.recordingStore.remove(run.recordingId).catch(() => undefined);
        } catch (error) {
          log(`upload failed, local recording kept for retry: ${error instanceof Error ? error.message : 'unknown'}`);
          await sendDesktopRecordingStopped(deps.fetch, run.session.ludyUrl, run.session.token, {
            meetingId: run.meetingId,
            ...(run.stopReason !== 'user' ? { reason: run.stopReason } : {}),
            lengthSeconds: elapsedSeconds,
          }).catch(() => undefined);
        }
      }

      active = null;
      phase = 'idle';
      deps.onTrayState({ phase: 'idle', meetingTitle: null, elapsedMs: 0, warning: null });
    })();
    return run.stopPromise;
  }

  return {
    phase: () => phase,
    activeMeetingId: () => active?.meetingId ?? null,
    refreshWindows,
    refreshAgenda,
    openConsent,
    startCapture,
    stopCapture,
    cancelConsent() {
      if (phase === 'preparing' && pendingStart) {
        pendingStart.cancelled = true;
        pendingStart.controller.abort();
        pendingStart = null;
      }
      if (phase === 'consent' || phase === 'preparing') {
        phase = 'idle';
        deps.onTrayState({ phase: 'idle', meetingTitle: null, elapsedMs: 0, warning: null });
      }
      deps.ui.closeConsent();
    },
  };
}
