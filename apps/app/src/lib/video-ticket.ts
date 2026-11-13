// SPDX-License-Identifier: AGPL-3.0-only
// Meeting video by a short-lived ticket (#2703). A <video src> cannot send the bearer header and the app must not download
// a 2 GB file into a blob, so the kernel gives a ticket (POST /api/meetings/:id/video/ticket, with the bearer header) and
// the player streams `/api/meetings/:id/video/stream?ticket=...` with range requests. The ticket lives ten minutes at most:
// this player gets a new one at 80% of its life and when the media element reports an error (an expired ticket, a dropped
// connection), swaps the source and puts the playback back where it was.
import { apiUrl } from './api-base.ts';

export interface VideoTicket {
  ticket: string;
  expiresInSeconds: number;
}

export function videoStreamUrl(meetingId: string, ticket: string, origin?: string): string {
  const path = `/api/meetings/${encodeURIComponent(meetingId)}/video/stream?ticket=${encodeURIComponent(ticket)}`;
  return origin === undefined ? apiUrl(path) : apiUrl(path, origin);
}

// What the player needs of a <video> element.
export interface VideoElementLike {
  src: string;
  currentTime: number;
  paused: boolean;
  ended: boolean;
  play(): Promise<void> | void;
  addEventListener(type: 'loadedmetadata', listener: () => void, options?: { once?: boolean }): void;
}

export interface VideoTicketPlayerDeps {
  fetchTicket: () => Promise<VideoTicket>;
  urlFor: (ticket: string) => string;
  element: () => VideoElementLike | null;
  // A ticket could not be had (or kept failing): the reason, for the screen.
  onFailure: (error: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export const REFRESH_AT_FRACTION = 0.8;
// Errors in a row (no metadata loaded in between), or errors within ERROR_WINDOW_MS whatever loaded in between, after which
// the player stops asking for tickets: a source that loads and then fails again cannot make it ask without end.
export const MAX_ERROR_REFRESHES = 3;
export const ERROR_WINDOW_MS = 60_000;

export interface VideoTicketPlayer {
  // The first ticket: the URL to give the element.
  start: () => Promise<string>;
  // The element's `error` event.
  mediaError: () => void;
  // The element loaded a source: the errors in a row start again.
  mediaLoaded: () => void;
  stop: () => void;
}

export function createVideoTicketPlayer(deps: VideoTicketPlayerDeps): VideoTicketPlayer {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let stopped = false;
  let timer: unknown = null;
  let refreshing: Promise<void> | null = null;
  let errorsInARow = 0;
  let errorTimes: number[] = [];
  const now = deps.now ?? (() => Date.now());

  const schedule = (ticket: VideoTicket) => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => void refresh(), Math.max(1, ticket.expiresInSeconds) * REFRESH_AT_FRACTION * 1000);
  };

  async function refresh(): Promise<void> {
    if (stopped) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const next = await deps.fetchTicket();
        if (stopped) return;
        const el = deps.element();
        if (el) {
          const at = el.currentTime;
          const wasPlaying = !el.paused && !el.ended;
          el.src = deps.urlFor(next.ticket);
          el.addEventListener(
            'loadedmetadata',
            () => {
              el.currentTime = at;
              if (wasPlaying) void Promise.resolve(el.play()).catch(() => undefined);
            },
            { once: true },
          );
        }
        schedule(next);
      } catch (error) {
        if (!stopped) deps.onFailure(error);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  return {
    async start() {
      const first = await deps.fetchTicket();
      schedule(first);
      return deps.urlFor(first.ticket);
    },
    mediaError() {
      if (stopped) return;
      errorsInARow += 1;
      const at = now();
      errorTimes = [...errorTimes.filter((t) => at - t < ERROR_WINDOW_MS), at];
      if (errorsInARow > MAX_ERROR_REFRESHES || errorTimes.length > MAX_ERROR_REFRESHES) {
        deps.onFailure(new Error('VIDEO_TICKET_INVALID'));
        return;
      }
      void refresh();
    },
    mediaLoaded() {
      errorsInARow = 0;
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
