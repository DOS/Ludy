// SPDX-License-Identifier: AGPL-3.0-only
// The meeting video player's ticket handling (#2703): the stream URL, the refresh at 80% of the ticket's life, and the swap on
// a media error that keeps the position and whether it was playing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_ERROR_REFRESHES, createVideoTicketPlayer, videoStreamUrl, type VideoElementLike } from '../src/lib/video-ticket.ts';

class FakeVideo implements VideoElementLike {
  src = '';
  currentTime = 0;
  paused = true;
  ended = false;
  plays = 0;
  private loaded: Array<() => void> = [];
  play() {
    this.plays += 1;
    this.paused = false;
  }
  addEventListener(_type: 'loadedmetadata', listener: () => void) {
    this.loaded.push(listener);
  }
  // The browser loading the new source.
  load() {
    const listeners = this.loaded;
    this.loaded = [];
    this.currentTime = 0;
    for (const l of listeners) l();
  }
}

describe('videoStreamUrl', () => {
  it('names the stream route with the ticket in the query, on the API origin', () => {
    expect(videoStreamUrl('m-1', 'v1.a.b', '')).toBe('/api/meetings/m-1/video/stream?ticket=v1.a.b');
    expect(videoStreamUrl('m-1', 'v1.a.b', 'https://api.example.com')).toBe('https://api.example.com/api/meetings/m-1/video/stream?ticket=v1.a.b');
    expect(videoStreamUrl('a/b', 'x y&z', '')).toBe('/api/meetings/a%2Fb/video/stream?ticket=x%20y%26z');
  });
});

describe('createVideoTicketPlayer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(expiresInSeconds = 600) {
    const video = new FakeVideo();
    let n = 0;
    const failures: unknown[] = [];
    const fetchTicket = vi.fn(async () => ({ ticket: `t${++n}`, expiresInSeconds }));
    const player = createVideoTicketPlayer({ fetchTicket, urlFor: (t) => `/s?ticket=${t}`, element: () => video, onFailure: (e) => failures.push(e) });
    return { video, fetchTicket, player, failures };
  }

  it('starts with one ticket and gives the URL to play', async () => {
    const { player, fetchTicket } = setup();
    expect(await player.start()).toBe('/s?ticket=t1');
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    player.stop();
  });

  it('gets a new ticket at 80% of the life of the last, swaps the source and keeps the position and the playing state', async () => {
    const { player, fetchTicket, video } = setup(600);
    video.src = await player.start();
    video.currentTime = 123.5;
    video.paused = false;
    await vi.advanceTimersByTimeAsync(479_000);
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(video.src).toBe('/s?ticket=t2');
    video.paused = true; // the browser pauses while it swaps
    video.load();
    expect(video.currentTime).toBe(123.5);
    expect(video.plays).toBe(1);
    // And again 80% later.
    await vi.advanceTimersByTimeAsync(481_000);
    expect(video.src).toBe('/s?ticket=t3');
    player.stop();
  });

  it('does not start playing a video that was paused', async () => {
    const { player, video } = setup(100);
    video.src = await player.start();
    video.currentTime = 7;
    video.paused = true;
    await vi.advanceTimersByTimeAsync(81_000);
    video.load();
    expect(video.currentTime).toBe(7);
    expect(video.plays).toBe(0);
    player.stop();
  });

  it('swaps at once on a media error, and gives up after repeated errors with no source loaded between', async () => {
    const { player, video, fetchTicket, failures } = setup();
    video.src = await player.start();
    video.currentTime = 42;
    video.paused = false;
    player.mediaError();
    await vi.advanceTimersByTimeAsync(0);
    expect(video.src).toBe('/s?ticket=t2');
    video.load();
    expect(video.currentTime).toBe(42);
    player.mediaLoaded();
    for (let i = 0; i < MAX_ERROR_REFRESHES - 1; i++) {
      player.mediaError();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(failures).toHaveLength(0);
    const asked = fetchTicket.mock.calls.length;
    player.mediaError();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket.mock.calls.length).toBe(asked);
    expect(failures).toHaveLength(1);
    player.stop();
  });

  it('gives up on a source that loads and then fails again, within the error window', async () => {
    const { player, video, fetchTicket, failures } = setup();
    video.src = await player.start();
    for (let i = 0; i < MAX_ERROR_REFRESHES; i++) {
      player.mediaError();
      await vi.advanceTimersByTimeAsync(0);
      video.load();
      player.mediaLoaded();
    }
    expect(failures).toHaveLength(0);
    const asked = fetchTicket.mock.calls.length;
    player.mediaError();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket.mock.calls.length).toBe(asked);
    expect(failures).toHaveLength(1);
    player.stop();
  });

  it('asks once for two errors at the same time, reports a refused ticket and stops its timers on stop()', async () => {
    const video = new FakeVideo();
    const failures: unknown[] = [];
    let release: (() => void) | null = null;
    const fetchTicket = vi.fn(
      () =>
        new Promise<{ ticket: string; expiresInSeconds: number }>((resolve) => {
          release = () => resolve({ ticket: 'late', expiresInSeconds: 600 });
        }),
    );
    const player = createVideoTicketPlayer({ fetchTicket, urlFor: (t) => t, element: () => video, onFailure: (e) => failures.push(e) });
    player.mediaError();
    player.mediaError();
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    release!();
    await vi.advanceTimersByTimeAsync(0);
    expect(video.src).toBe('late');
    player.stop();
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(fetchTicket).toHaveBeenCalledTimes(1);

    const refused = createVideoTicketPlayer({ fetchTicket: async () => Promise.reject(new Error('refused')), urlFor: (t) => t, element: () => video, onFailure: (e) => failures.push(e) });
    refused.mediaError();
    await vi.advanceTimersByTimeAsync(0);
    expect(failures).toHaveLength(1);
    refused.stop();
  });
});
