// SPDX-License-Identifier: AGPL-3.0-only
// The offscreen document: it holds the capture, because a service worker cannot (ADR-0047 point 10). It answers only the
// background worker's messages and reports the elapsed time once a second for the REC badge.
import { startCapture, type Running } from './capture-run.ts';
import { isOwnSender, parseCaptureStart, type Lost, type OffscreenMessage, type StartReply, type StopReply, type Tick } from './messages.ts';

let current: Running | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  // Only this extension's own worker commands the capture.
  if (!isOwnSender(sender, chrome.runtime.id)) return undefined;
  const message = raw as Partial<OffscreenMessage> & { type?: string };
  if (message.target !== 'offscreen') return undefined;
  if (message.type === 'capture-start') {
    const command = parseCaptureStart(raw);
    if (!command) {
      respond({ ok: false, reason: 'invalid' } satisfies StartReply);
      return undefined;
    }
    void (async (): Promise<StartReply> => {
      if (current) return { ok: false, reason: 'busy' };
      const started = await startCapture(command);
      if (!started.ok) return { ok: false, reason: started.reason };
      current = started.running;
      // A recording that ends without the member's click (A1, #3159): what was saved is uploaded with the reason code, and the
      // worker is told so the badge and the popup say so. The same running object, so a stop the member clicks is not reported.
      const running = started.running;
      running.onLost((reason) => {
        if (current !== running) return;
        current = null;
        clearInterval(ticker);
        void running
          .stop(reason)
          .catch(() => ({ uploaded: false, meetingId: running.meetingId }))
          .then((done) => chrome.runtime.sendMessage({ type: 'lost', reason, meetingId: running.meetingId, uploaded: done.uploaded } satisfies Lost))
          .catch(() => undefined);
      });
      ticker = setInterval(() => void chrome.runtime.sendMessage({ type: 'tick', elapsedMs: started.running.elapsedMs() } satisfies Tick).catch(() => undefined), 1000);
      return { ok: true, meetingId: current.meetingId, startedAt: current.startedAt, micMissing: current.micMissing };
    })().then(respond);
    return true;
  }
  if (message.type === 'capture-stop') {
    void (async (): Promise<StopReply> => {
      const running = current;
      if (!running) return { ok: false, reason: 'idle' };
      current = null;
      clearInterval(ticker);
      const done = await running.stop();
      return { ok: true, ...done };
    })().then(respond);
    return true;
  }
  return undefined;
});
