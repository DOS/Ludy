// SPDX-License-Identifier: AGPL-3.0-only
// The recording player of a meeting's page (#4816): its speed (1x, 1.25x, 1.5x, 2x) and the jump to the start of a transcript line. Web only: the times are the ones the lines already have, nothing is
// sent to the server and nothing is stored but the speed the viewer last picked, in their own browser. Pure functions, so the page and the tests share one set of rules.

/** The speeds the player offers. */
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];
export const DEFAULT_RATE: PlaybackRate = 1;
const STORAGE_KEY = 'ludy.meetings.playbackRate';

/** "1x", "1.25x": the speed as written on its button. */
export const rateLabel = (rate: PlaybackRate): string => `${rate}x`;

/** A stored or typed value as a speed the player offers, else null. */
export function asRate(value: unknown): PlaybackRate | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return PLAYBACK_RATES.find((r) => r === n) ?? null;
}

interface RateStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const browserStore = (): RateStore | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Blocked storage (a private window, site data refused) is the same as none.
    return null;
  }
};

/** The speed the viewer last picked in this browser, 1x when none or when the storage cannot be read. */
export function readStoredRate(store: RateStore | null = browserStore()): PlaybackRate {
  try {
    return asRate(store?.getItem(STORAGE_KEY)) ?? DEFAULT_RATE;
  } catch {
    return DEFAULT_RATE;
  }
}
/** Remembers the speed in this browser; a refusal of the storage changes nothing else. */
export function storeRate(rate: PlaybackRate, store: RateStore | null = browserStore()): void {
  try {
    store?.setItem(STORAGE_KEY, String(rate));
  } catch {
    // Not remembered; the speed still applies to this page.
  }
}

/** What the page needs of an audio or video element. */
export interface MediaLike {
  currentTime: number;
  playbackRate: number;
  defaultPlaybackRate: number;
}

/** Sets the speed on each player that is there. A browser resets it when a new source loads, so the page calls this again then. */
export function applyRate(rate: PlaybackRate, players: ReadonlyArray<MediaLike | null | undefined>): void {
  for (const player of players) {
    if (!player) continue;
    player.defaultPlaybackRate = rate;
    player.playbackRate = rate;
  }
}

/**
 * Moves each player that is there to a second of the recording. A time that is not a finite number of seconds at or after zero moves nothing. It never starts a player: playing stays the person's own
 * click. Returns whether any player was moved.
 */
export function seekPlayers(players: ReadonlyArray<MediaLike | null | undefined>, second: number): boolean {
  if (!Number.isFinite(second) || second < 0) return false;
  let moved = false;
  for (const player of players) {
    if (!player) continue;
    player.currentTime = second;
    moved = true;
  }
  return moved;
}
